---
description: >-
  The cross-cutting Zustand stores for the engine connection and restart state, the response cache and the session console's rows.
---

# Engine, response and console stores

## `engine-store.ts` - Engine Connection & Restart State

Merged store managing engine connection status and restart-required notifications (for config changes that need an engine restart).

**State:**
```typescript
{
  engineStatus: EngineStatus  // "starting" | "connected" | "unreachable"
  engineError: string | null
  engineStartFailure: string | null  // The main process's sentence when no engine can start (every port held), or null
  engineCrash: EngineCrash | null  // How the engine's process left on its own ({ code, signal, stderrTail, error }), or null
  engineRestarting: boolean  // A restart is in flight, shared by every surface that offers one
  recovery: EngineRecovery | null  // What the engine's startup did to the database
  workers: number | null  // The `workers` setting's effective value, or null before the first poll
  engineStartWindow: number | null  // When the engine now coming up began, or null
  pendingRestart: boolean
  restartRequiredKeys: string[]  // Config keys requiring restart
}
```

**Key Methods:**
```typescript
const {
  engineStatus, setEngineStatus,
  engineError, setEngineError,
  engineStartFailure, setEngineStartFailure,
  engineCrash, setEngineCrash,
  engineRestarting, setEngineRestarting,
  recovery, setEngineRecovery,
  workers, setWorkers,
  engineStartWindow, openEngineStartWindow, closeEngineStartWindow,
  pendingRestart, addRestartRequiredKey, clearRestartRequired,
} = useEngineStore();
```

`recovery` is the optional `recovery` node from `GET /health` (issue #922), written by the same poll that writes `engineError` and read by `RecoveryBanner`.
`null` is a clean start; a value means the engine restored the database from its backup or deleted it as unrecoverable.

`engineStartFailure` is the main process's own account of why no engine is coming, when no crashed child explains it: another program holding every port the engine may use (issue #2118), or a start or Retry that failed before it had a child, such as a missing binary, in one sentence (issue #3610).
`useHealthQuery` asks for it (`getEngineStartFailure`) on a failed poll and writes it here; the poll an engine answers clears it, and so does `useEngineRestart` when Retry is pressed.
A reply that lands after a restart opened its start window is dropped, because it describes the start Retry just cleared.
While it is set the status is `unreachable` whatever the startup grace says, and the Dock shows it in place of `engineError` and offers Retry.

`engineCrash` is the main process's account of how the engine's process left when nobody asked it to (issue #3336): the exit `code`, `signal`, `stderrTail` and `error` of the sidecar's `crashed` lifecycle state, as `engine:lifecycle` carries them.
`useEngineLifecycle` (mounted once in `App`, after `useHealthQuery`) writes it: a `crashed` push sets it, and only `ready`, `slow`, `stopping` and `stopped` clear it (an engine that is up, alive but slow, or stopped on purpose).
The transient kinds `idle`, `choosingPort`, `replacing` and `spawning` leave it standing, so a restart that fails before it spawns a child (the sidecar ends on `idle`) still leaves the Dock its sentence and its Restart button, and while the restart runs the button reads Restarting... through `engineRestarting`.
The one-time read of the current state yields to a push that landed while it was in flight and to a restart that opened a new start window, so a late reply cannot put a crash back over the engine replacing it.
**It is a fact, not a status: `useHealthQuery` stays the only classifier of `engineStatus`**, and `engineCrash` never writes it.
A `crashed` push invalidates `queryKeys.health.status()`, and no other query, so the poll's verdict follows within a retry rather than a whole healthy interval (issue #3493).
It also ends the runs that engine was executing (issue #3605):
`useEngineLifecycle` calls `loadTestService.handleEngineStopped()` and `scenarioRunService.handleEngineStopped()`, which close the stream (the `EventSource` would otherwise retry the dead port for the rest of the session), release the wake lock, flash the OS progress bar failed, and move the dashboard's live run to `engineStopped` and the collection run to `scenario-run-store.engineStopped`.
Neither posts a notification: the engine-lost one is the only one the user gets, and each service marks the run notified so a close already awaiting its report stays quiet too.
The push is the signal, not the poll, which cannot tell a dead engine from a slow one.
Both services answer whether a live run ended, and `useEngineLifecycle` writes the answers with the crash itself, `setEngineCrash(crash, endedRuns)`, as `crashEndedRuns` (`"load"` and/or `"collection"`): the one fact `useHealthQuery`'s engine-lost notification reads, to append "The load test that was running stopped with it."
(or the collection-run sentence, `lib/engine-crash.ts`) to its body.
It is the crash's own record rather than the dashboard's `engineStopped` phase or the scenario store's `endedByEngineStop`, because those outlive the crash (the phase lasts until the report lands, which needs the dashboard mounted and an engine serving), so a later unrelated loss would find them raised.
A new crash replaces it, `setEngineCrash(null)` empties it, and the notification consumes it (`consumeCrashEndedRuns`) so a restart that fails and loses the engine again does not claim the run twice.
A poll that fails before the push posts the bare reason, and nothing is posted after: one notification per loss.
The dashboard reads `engineCrash` too, by way of `useEngineServing` (`selectKnownEngineStatus`): its engine-stopped notice offers Restart while no engine serves, and its report fetch waits for one.
For the gap until it does, `selectKnownEngineStatus` (exported beside the store) derives the status the app shows: `unreachable` when a crash was pushed after the poll's last verdict and that verdict is `connected`;
`unreachable` too when a crash is recorded, the verdict is `starting` and no restart is in flight (`engineRestarting`, issue #3610), because a failed poll inside the startup grace reads `starting` for up to 45 s and an engine that exited at spawn is not coming; `engineStatus` itself otherwise, so a restart's own `starting` passes through.
That second rule keys on `engineCrash`, not on the flag below, which the very poll that wrote `starting` cleared.
`engineCrashAheadOfPoll` carries the "after": `setEngineCrash` sets it with a crash, and every `setEngineStatus` clears it, including the one `useHealthQuery` makes for each answered poll, an unchanged answer too (structural sharing would otherwise keep the sync effect from running).
The crash alone cannot decide, because it stays until `ready`, which can trail the poll that already sees a restarted engine answer.
The Dock's light and `useEngineServing` (the gate behind the running-services count, the Services drawer's rows, and the inbox and mock-server tabs' Running/Stopped state and Stop action, issue #3506) read it, as do the dirty-tab close guards in `tabs-store` and the change feed's open/close (`useChangeFeed`), so none of them says "connected" beside the Restart a crash put there.
The health poll's own gating (`queries/health.ts`) and the store's internals read `engineStatus` directly: they are the poll's own verdict.
The Dock reads `engineCrash` for the connection tooltip (`describeEngineCrash`, `engineCrashOutput` in `lib/engine-crash.ts`: the sentence, then the last three non-empty stderr lines) and ignores it while the derived status is `starting`; `engineStartFailure` takes precedence over it in both the tooltip and the button (Retry, not Restart).

`engineRestarting` is whether a restart is in flight, held here rather than in each `useEngineRestart` instance so that the Dock's button and the Settings banner share it: a second click, or the other surface's button, finds it set and asks the main process for nothing.
The hook reads it from the store, not from its render's value, because two clicks in one frame both see a stale `false` there.
It is set only once the restart question is answered yes (issue #3604: with a run live, Restart asks first), so a Cancel never shows "Restarting…"; two clicks while that question is up join the one question and the store is read again after it.

`workers` is the `workers` field from the same poll (issue #1508) - the `workers` setting's effective value, not the machine's raw core count - read by the Dock's version-string tooltip.
`null` before the first poll answers; it is not cleared on a later disconnect, so a hover during a brief drop still shows the last known count.

`engineStatus` is `starting` while no poll has succeeded since the engine now coming up began coming up and it is still inside its grace window, `connected` once a poll has answered `ok`, and `unreachable` once a poll fails past that window or an engine that had answered stops answering with nothing starting.
`engineError` is what the failed health poll recorded (`queries/health.ts`), and it is `null` in every state but `unreachable`: an engine still inside its grace window has no failure to report.
The Dock's connection indicator renders it in a tooltip, for `unreachable` alone - "Disconnected" on its own read the same for a refused connection, a timeout and a TLS failure.

`engineStartWindow` is the evidence that decision is made against: the moment the engine now coming up began coming up, or `null` when none is.
It is a window rather than a "has ever connected" flag because a cold start is not only the app's first (#1227) - `useEngineRestart` kills the running engine and spawns a fresh one that repeats the whole startup housekeeping, with the port down for all of it, and a flag called that silence a failure on the evidence of an engine that no longer existed.
**Two paths open it - `useHealthQuery` on mount and the restart path before it invokes the IPC - and it is deliberately evidence rather than a status, so `useHealthQuery` stays the only writer of `engineStatus`.**
It is closed by the poll an engine answers, and by a restart the main process reports as failed, after which the next failed poll owes the user its reason again.
A window nobody closes is spent rather than cleared - an engine that never arrives leaves its opening time in place, expired - so this is not an "is something starting" flag and must not be read as one: only `engineStatusAfterFailedPoll` (`lib/engine-start-window.ts`) interprets it, and to that an expired timestamp and a `null` mean the same thing.
Two things ask it: `useHealthQuery`, for `engineStatus`, and the shared query retry policy, which keeps queries loading rather than failed while it answers `starting`.

**Non-persisted** (cleared on app restart).

## `response-store.ts` - Response Cache

In-memory storage of responses per request ID, persisted across view/tab switches but not to disk.

**State:**
```typescript
{
  responses: Map<string, StoredResponse>,
  lru: string[]  // request ids, least-recently-written first
}
```

**StoredResponse:** Includes status, headers, body, `bodyRaw`, a binary body's `rawBytes`, execution time, script results, and console logs.

**Key Methods:**
```typescript
const { setResponse, getResponse, clearResponse, clearAll } = useResponseStore();
```

**Eviction by identity:** `clearResponse` runs from `useDeleteRequestMutation` (the delete is what makes the response unreachable), from `tabs-store`'s `closeTabsForEntities` (the collection cascade, which knows every descendant id), and from `RequestBuilderProvider`'s stream-flagged Send (#1876).
The stream Send clears the entry because the provider's mount initialiser and request-switch reset read the store back, so a finished stream's stored result would return on the next switch and suppress the Events tab's live placeholder, which is only built when there is no stored response.

**Eviction by count and by bytes:** `RESPONSE_CACHE_MAX_ENTRIES` (24) bounds the map (#1156).
Those two delete seams were once the only ones, so the map grew with every distinct request a session sent - each entry a body plus its raw copy - until the app quit.
What the map holds is the 24 most recently *sent* requests, not the open tabs: this store cannot ask `tabs-store` what is open, since that store imports this one.
The cap is twice `MAX_OPEN_TABS` so that recency covers tab reach in practice - a full set of tabs can each be re-sent and every one of them still re-opens on its full-fidelity body.
The gap is a tab held open without being re-sent while 24 other requests are, which tab eviction allows only for a dirty tab; it falls back like any older request.
Order comes from `lru`, not from `executedAt`, which a restored response carries from the run that produced it and which therefore says nothing about when this session last touched the entry; `setResponse` is the only writer, and it moves a re-sent request back to the recent end, so the entry just stored is never the one evicted.
Past the cap nothing is lost, only unabridged: the request re-opens against the backend's stored run, whose body the engine truncated at `maxTraceBodyBytes`.

`RESPONSE_CACHE_MAX_BYTES` (256 MiB) is the second limit (#2544), because a count says nothing about size: 24 responses of 20 MB each is a gigabyte held for tabs nobody is looking at.
`setResponse` sums `estimateResponseBytes` over the map and evicts least-recently-written first until both limits hold, so whichever is hit first decides.
The estimate is a documented upper bound, not a measurement: a string counts two bytes per UTF-16 code unit (V8 stores Latin-1 text in one, so this errs toward evicting early), a binary body counts its `byteLength`, and `body` and `bodyRaw` count once when they are equal - past the pane's formatting threshold `paneBody` hands the raw string back as `body`.
The request and response bodies of the scripts' `pm.sendRequest` records (#3633) count the same way, by the text held and never by a record's `bodyBytes`, which is the size before the engine cut or shed it.
Headers and the small fields are not counted.
The response just written is never evicted, even when it alone exceeds the budget: it is the one on screen, and the next write evicts it.
So "the 24 most recently sent" is the ceiling, and a session that sends large bodies holds fewer.

**Non-persisted** (responses are reloadable from backend).

## `console-store.ts` - The Session Console's Rows

Everything this window sent, newest last (#3634): each Send from a request tab, the console lines and `pm.sendRequest` calls its scripts made around it, and each collection-run step.
A row is a discriminated union on `kind`: `send`, `scriptRequest`, `line` and `step`.

**State:**
```typescript
{
  rows: ConsoleRow[],        // oldest first; each row has a session-unique `id` and a time `at`, see below
  retainedBytes: number,     // estimateConsoleRowBytes summed over rows
  evictedCount: number,      // rows the bounds dropped since the last clear
  runKeys: Set<string>,      // run identity of each step row and Send row with a run held
  nextId: number
}
```

**Key Methods:**
```typescript
useConsoleStore.getState().append(rows); // in order, then evicts past the bounds
useConsoleStore.getState().clear();      // empties the ring; History is untouched
const rows = useConsoleStore(selectConsoleRows);
const dropped = useConsoleStore(selectConsoleEvictedCount);
```

**A row's time.**
`at` is when the row's event began, display only: rows stay in append order, which is not time order.
A `scriptRequest` row carries the engine's `startedAt` (#3680), so a three-second token fetch is listed three seconds before the Send that waited on it.
Any other row takes the time of the append, except a `line`, which is untimed and takes the time of the row before it in the same append (the append time when it is the first).

**Who appends.**
`modules/console/console-rows.ts` builds every row the ring is handed.
`sendConsoleRows` is the one builder both Send completions call: the buffered Send in `request-builder/index.tsx` (`handleExecute`, after `responseFromExecuteResult`) and the streamed Send in `context/stream-finalization.ts` (`finalizeStreamRun`, before its overtaken skip, so a stream a newer Send overtook is still listed).
A Send's rows run in execution order: the pre-request script's lines and requests, the Send, then the post-response script's, placed by the response pane's own `consoleRows`.
A script that threw adds its `preScriptError` / `postScriptError` as an `error` line after its phase's rows (#3673), so the Level filter and the text search find it; the engine's message already names an inherited level, so the row carries the source and no scope.
A History replay maps its answer through the same funnel but appends nothing: it is not a session send.
`scenario-run-service.ts` appends one `step` row per `step` frame on the batcher's commit; the frame is constant-size by rule, so a step's exchange, lines and script requests are read from its stored row by `runId`, `iteration` and `stepIndex` when it is expanded.

**Masked before it is stored.**
A Send row is built from the live response, so `console-rows.ts` masks it on the way in:
header values by the engine's logger name set (`isSecretHeaderName`, `lib/secret-header-name.ts`: `authorization`, `cookie`, `token`, `apikey`, `session_token` and the rest of `log_redact.hpp`'s list, ASCII case folded, pinned by `secret-header-name.conformance.test.ts`) or by the response's `authHeaders`, so a Send row masks the names the engine masks on a script-request row;
the challenge headers (`WWW-Authenticate`, `Proxy-Authenticate`, `Authentication-Info`) are the server's scheme and realm and are shown.
The snippet list in `lib/sensitive-headers.ts` is narrower and unchanged.
The URL is masked by `maskUrlCredentials` (`lib/url-credentials.ts`: the userinfo password and a credential query or fragment value read `<redacted>`, as `user:<redacted>@host`, with `authQueryParam` as an extra name; the engine's names, pinned by `url-credentials.conformance.test.ts`), the form the engine writes on a script-request row, so the two rows of one Send copy the same cURL.
Script requests arrive masked by the engine (#3633, #3672: header values by the same name set, a URL's userinfo and credential query values as `<redacted>`) and a step's URL is the engine's masked one, so both are kept as written.
Bodies are not judged.
A step's exchange, read back from its stored row when the Console expands it, goes through the same `maskedExchange` before it is drawn, and is never put in the ring.

**Who reads.**
The bottom panel's Console tab (`modules/console/ConsoleTab.tsx`) and nothing else: it filters every row before it takes its window, and its Clear is this store's `clear`.

**Bounded twice, newest kept.**
`CONSOLE_MAX_ROWS` (5,000) and `CONSOLE_MAX_BYTES` (32 MiB) of retained text, whichever is reached first, oldest out first; the row just appended is never the victim, even when it alone is over the budget.
Text is measured as `estimateResponseBytes` measures a response, two bytes per UTF-16 code unit, over every string a row holds (URL, message, header names and values, bodies).
A body kept on a row is cut at `CONSOLE_BODY_MAX_CHARS` (256 Ki code units, 256 KiB of ASCII text), never inside a surrogate pair, and flagged `cut`; the store applies the cut, so no writer can store more.
`evictedCount` is what lets the list say once that older rows were dropped.

**Once per run.**
A row with a run identity (a step's run, iteration and position; a Send's run) is appended once: a replayed frame or a second finalisation of the same run adds nothing while the first is still held.
The finalisation claim in `execution-events-store` already keeps a stream to one append; the key is the ring's own guarantee.

**Non-persisted.**
A reload or a quit empties it; History is what persists.
