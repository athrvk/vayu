# Design runs open as a detached copy

**Status:** approved, not yet implemented
**Supersedes:** the "open the request builder with the response injected" approach on
branch `history-opens-request-builder` (issue #65)

## The idea in one line

A design run is a **snapshot**, not a document and not the request. Opening one gives
you a detached copy of what was sent: fireable, editable as scratch, written back only
by an explicit confirmed action.

## Why the first attempt was wrong

Issue #65 proposed opening the run's **request** in the builder and injecting the run's
response into the pane. That was implemented and it works, but it is wrong on its own
terms, for a reason the issue did not anticipate:

- The left pane shows the request **as it is now**. The response beside it is from the
  run. The two halves of the screen describe different things, and an age chip on the
  response is a label for the problem rather than a fix.
- The builder autosaves (`DEFAULT_AUTO_SAVE_ENABLED = true`, 5s). So inspecting an old
  run and tweaking a header to compare **silently rewrites the saved request**. Before
  #65, clicking a design run opened a read-only viewer where that was impossible. The
  change converted a read-only inspection action into a live editing surface, which was
  never the intent.
- Because the run then opened a `request` tab, `Shell`'s drawer effect - which infers a
  drawer view from tab _type_ - fired on the main history path and ejected the user from
  the run list on the first click. That was patched with a `drawerView !== "history"`
  literal, which is an exception encoded in a file that has no idea History exists.
- `HistoryList` derives "which run am I looking at" from `activeTab.type === "run"`, so
  no design run could ever highlight.
- `RecentRuns.tsx:74` opens design runs with `openTab({type:"run"})` and never went
  through `useOpenRun`, so the same click produced two different results depending on
  where you made it.

Four symptoms, one cause: **a request tab gained a second origin, and the tab carries no
record of which.** The fix is not to record the origin. It is to stop opening a request
tab at all.

## Verified facts this design rests on

Everything below was checked against a live engine (a design run and a load run), not
inferred. Re-verify before changing any of it.

### `GET /run/:id` already carries the configuration

Identical shape for both run types; only `configSnapshot` differs. For a design run it is
the **raw run payload**:

```json
{
  "id": "...",
  "type": "design",
  "status": "completed",
  "startTime": 0,
  "endTime": 0,
  "requestId": "req_abc",
  "environmentId": null,
  "configSnapshot": {
    "method": "POST",
    "url": "...",
    "headers": { "X-Plain": "visible" },
    "body": { "mode": "json", "content": "{\"a\":1}" },
    "auth": { "mode": "bearer" },
    "preRequestScript": "...",
    "postRequestScript": "...",
    "followRedirects": false,
    "maxRedirects": 3,
    "requestId": "req_abc"
  }
}
```

`apiService.getRun()` (`services/api.ts:205`) already wraps this endpoint and **has no
caller** - one more instance of the codebase's most repeated defect.

### The report is load-shaped, and gives a design run no configuration

`GET /run/:id/report` is documented as the final report for a completed run, reconstructed
from `runs` + `metrics` + `results`. Its body is a load-test aggregate. Measured on a
design run, computed from its single sample:

```
summary : { totalRequests: 1, avgRps: 24.39, throughput: 0.0,
            peakConcurrency: 0, sendRate: 0.0 }
latency : { p50 = p90 = p95 = p99 = p999 = 2.1268 }
```

Decisively: **`metadata.configuration` is present for a load run and absent for a design
run.** The report cannot supply a design run's auth mode, scripts or redirect policy.
Only `GET /run/:id` can. This is not a preference - the design view must call it.

Note also that `results` means different things per type: for a design run it is the one
exchange, for a load run it is the _sampled_ subset (it came back empty on a small run).

### `config_snapshot` holds no credentials, by construction

`sanitize_config_snapshot` (`utils/json.cpp:625`) reduces the top-level `auth` object to
`{"mode": ...}` - an **allowlist**, so no present or future credential field can leak
into a stored run. Consequence: credentials can only ever come from the live request.
That is not an arbitrary rule; it falls out of the sanitiser.

### The trace holds the post-auth wire request, credentials included

`store_result` is called with the request _after_ auth resolution
(`execution.cpp:380`, "auth already resolved into headers/url"). Verified:

```
auth {mode: bearer, token: "SECRET-TOKEN-12345"}
  -> trace.request.headers = { "Authorization": "Bearer SECRET-TOKEN-12345", ... }
  -> configSnapshot.headers = { }                          (declared only)

auth {mode: apikey, addTo: query, value: "SECRET-QUERY-KEY"}
  -> trace.request.headers = { "api_key": "SECRET-QUERY-KEY" }
  -> the URL stays clean
```

So `trace.request.headers` minus `configSnapshot.headers` is exactly the set of headers
added between payload and wire. Safe to rely on for _replay_ fidelity, where "whatever
the engine added" is precisely what you want to resend. Do **not** use it to identify
auth headers for Save - the engine may inject others later, and Save's exclusions must
not depend on a subtraction.

### Scripts in the snapshot are **composed**

`RequestBuilder.handleExecute` builds `composedPreScript` from the collection chain plus
the request's own script and sends one string. So `configSnapshot.preRequestScript`
contains the collection's scripts inlined. **Writing it back to a request would inline
them permanently**, and the next execute would compose again and run the collection
script twice.

## Design

### Three sources, each for what only it can supply

| Source           | Supplies                                                                                | Why it and not the others       |
| ---------------- | --------------------------------------------------------------------------------------- | ------------------------------- |
| `configSnapshot` | method, url, declared headers, structured body, auth **mode**, scripts, redirect policy | it is the run payload           |
| `result.trace`   | response, timings, and the Raw tab                                                      | it is the post-auth wire record |
| the live request | **credentials**                                                                         | the sanitiser is an allowlist   |

### Engine change

`GET /run/:id` gains a `result` field **for design runs only**:

```json
"result": {
  "timestamp": 0, "statusCode": 200, "statusText": "OK", "latencyMs": 2.1,
  "error": "...",
  "trace": { "request": {...}, "response": {...}, "dnsMs": 0, "connectMs": 0, ... }
}
```

Load runs are unchanged and carry no `result`. A payload that varies by run type is the
endpoint's **existing** contract, not a new one - `configSnapshot` is already completely
different per type.

The design view then never touches `/run/:id/report`, which stays a load-test artifact.
Update `docs/engine/api-reference.md` and `docs/engine/db-schema.md` in the same commit.

### Tab and routing

The tab stays `{ type: "run", entityId: run.id }` - the existing type, so no tabs-store
change and no persist version bump. Every run, design or load, opens its own run tab.

Consequences, all of which delete code rather than add it:

- `useOpenRun` is **deleted**. No report prefetch, no request lookup, no async, no
  spinner, no ordering constraint between store write and tab open.
- `HistoryList` returns to `openTab({ type: "run", entityId: runId })`, and `RecentRuns`
  already does exactly that - the split behaviour disappears with no shared helper.
- `Shell`'s drawer patch is **reverted**. A run tab never triggered the effect.
- `HistoryList`'s existing `activeTab.type === "run"` selection derivation works again,
  so the run row highlights with no change.
- The `RequestBuilderProvider` store subscription is **reverted**; nothing injects into
  the response store any more.

`HistoryDetail` routes a design run to a new `DesignRunView`. Its header shrinks to run
identity, status and actions - the URL comes from the builder, so there are not two URL
bars.

### The detached builder

`DesignRunView` mounts `RequestBuilderProvider` with:

- `initialRequest` = the seed below, with **`id: null`**
- `initialResponse` = `responseFromRunResult(run.result)` (**new prop**; the provider
  currently seeds its response from the store by id)
- `onExecute` = replay
- **`onSave` omitted**

`id: null` is load-bearing and needs no new machinery: `useSaveManager` returns early on
a null `entityId`, the response store is keyed by id so nothing is written, and
`useLastDesignRunQuery(null)` never fires. The existing provider is already correct for a
detached request.

Seed mapping:

| `RequestState`                               | From                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `method`, `url`                              | `configSnapshot`                                                     |
| `params`                                     | `parseQueryParams(url)` (`utils/url.ts`, already used by `UrlInput`) |
| `headers`                                    | depends on whether the request survives - see **Auth** below         |
| `body`, `bodyMode`, `formData`, `urlEncoded` | `configSnapshot.body` (already structured)                           |
| `authType`, `authConfig`                     | depends - see **Auth** below                                         |
| `preRequestScript`, `testScript`             | `configSnapshot` - see **Scripts** below                             |
| `followRedirects`, `maxRedirects`            | `configSnapshot`                                                     |
| `id`, `collectionId`                         | `null`                                                               |

**Auth, in one sentence:** use the live request's auth when there is one; otherwise replay
exactly what went out.

|                  | `headers` seeded from                                            | `authType` / `authConfig`                         |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| request survives | `configSnapshot.headers` - declared, no credentials              | the live request's **current** auth               |
| orphan           | `trace.request.headers` - the wire set, `Authorization` included | `none` (auth is already baked into those headers) |

Both branches keep the same property: **what the editor shows is what the replay sends.**
In the surviving case that means the request's current auth, since that is what a live
resolution will produce - and the run's own `configSnapshot.auth.mode` is surfaced beside
it as read-only metadata ("this run used: bearer"), which makes it visible when the
request's auth has changed since. In the orphan case it means the frozen credential is a
visible, editable header row, so a stale token can be replaced by hand and re-fired.

**Scripts.** Seeded verbatim - meaning the whole composed blob, unmodified - and editable,
since editing is scratch and a replay should send what you see. Note that this makes the
detached copy's script tab structurally unlike the same request's normal script tab, which
shows only the request's own script; the panels carry a read-only note saying so, which is
also why Save excludes them.

### Replay

Send the current editor state to `POST /request` with `requestId: run.requestId`, so the
new run attributes to the same request. Auth is resolved **live** from the saved request
through the existing helpers - not a copied composition, since `CLAUDE.md` forbids a
third copy. Firing creates a new run in history, which is correct.

Orphan (no `requestId`, or the request is gone): there is no auth to resolve, so the
replay sends the trace's headers as seeded - including the `Authorization` that was on the
wire. The run is replayed exactly as it executed. A token that has since expired returns a
401, which is a true statement about replaying that request; the header is visible and
editable, so a fresh one can be pasted in.

### Save to request

An explicit action behind a confirm showing what will change, because overwriting a live
request from a days-old snapshot is irreversible.

**Save writes only fields the snapshot holds in the same shape the request stores them:**
method, url, params, headers, body, redirect policy.

It does **not** write:

- **auth** - only the mode survives sanitisation, and writing a bare mode would discard
  the request's credentials;
- **scripts** - they are composed, and writing them would inline the collection's.

Both exclusions appear in the confirm as explicitly unchanged, so the rule is visible
rather than silent. The action is hidden entirely when `run.requestId` no longer resolves.

## What survives from branch `history-opens-request-builder`

| Survives                                                                  | Reverted                                            |
| ------------------------------------------------------------------------- | --------------------------------------------------- |
| `buildRawRequest` + tests                                                 | `useOpenRun` + tests                                |
| error-run mapping in `responseFromRunResult`                              | `RequestBuilderProvider` store subscription + tests |
| `restoredFrom` + age chip (still serves the builder's cold-start restore) | `Shell` drawer patch                                |
| deletion of `DesignRunDetail`                                             | `DesignRunResponse` (becomes `DesignRunView`)       |
| `UnifiedResponseViewer` shrunk to the embedded sample view                |                                                     |

The drawer test file is kept, trimmed to pin the effect's real contract - that coverage
did not exist before and its absence is why the regression shipped.

## Testing

- **Seed mapping** (unit): auth mode, composed scripts, redirect policy, structured body,
  declared headers, `id: null`.
- **Detachment** (behavioural): editing fires no save mutation. Mutation-check by
  restoring `onSave` and confirming the test goes red.
- **Replay**: sends editor state, live-resolved auth, and `requestId`; creates a run.
- **Orphan**: no Save, no Open request; headers seed from the trace and the replay sends
  the recorded `Authorization` verbatim.
- **Save**: writes the six allowed fields; never writes auth or scripts; requires confirm.
- **Drawer**: a run tab does not move the drawer (regression cover).
- **Highlight**: the run row is selected while its tab is active.
- **Engine**: `GET /run/:id` carries `result` for a design run and not for a load run.

## Risks and accepted limitations

- **Replay fidelity.** Scripts replay as composed text, which is what ran. Test results
  are produced by the replay, not restored from the original run.
- **Type-varying payload** on `GET /run/:id`. Accepted: `configSnapshot` already varies
  completely by type on the same endpoint.
- **Secrets remain visible** in the Raw and Headers tabs, sourced from the trace. This
  predates the change - the restore path already passed `trace.request.headers` into
  `requestHeaders`. Not addressed here.
- **`GET /requests/:id` still does not exist**, so resolving `run.requestId` to a request
  goes through the collection-list scan in `fetchRequestById`.
