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

### Scripts are composed client-side into one opaque string - and this design changes that

`RequestBuilder.handleExecute` builds `composedPreScript` from the collection chain plus
the request's own script and sends one string, so `configSnapshot.preRequestScript`
contains the collection's scripts inlined with no markers. Writing that back to a request
would inline them permanently, and the next execute would compose again and run the
collection script twice.

Rather than work around that, this design **makes composition structured** - see
_Engine change 2_. The consequences below (script tab, Save) assume structured scripts,
with a legacy path for runs stored before it.

Two related facts, both verified:

- **The two clients already disagree.** The renderer filters parts with `.filter(Boolean)`;
  MCP's `joinScripts` (`resolve.ts:238`) filters with `s.trim()`. A whitespace-only
  collection script is kept by one and dropped by the other.
- **Load runs never see the chain.** `POST /run` reads only `config["tests"]`
  (`run_manager.cpp:193`), and the renderer sends `tests: request.testScript` - the
  request's own test script alone. A collection-level assertion is validated in design
  mode and silently never evaluated under load. The dialog warns that pre-request scripts
  do not run; nothing warns about this.

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

### Engine change 2: structured script composition

Script composition moves into the engine. This is a **deliberate slice of A1**
(`pending-backlog.md`) - scripts only. `{{var}}` interpolation and inherit-auth
resolution stay client-side and A1 stays open for them.

Both execution paths take an ordered array instead of a pre-joined string:

```jsonc
// POST /request
"preRequestScripts":  [ { "origin": "collection", "id": "col_1", "name": "API", "script": "..." },
                        { "origin": "request",    "id": "req_9",                "script": "..." } ],
"postRequestScripts": [ ... ]

// POST /run
"tests":              [ { "origin": "collection", ... }, { "origin": "request", ... } ]
```

The engine joins with `"

"` and executes **once**, exactly as the clients do today, so
execution is byte-identical. The legacy string form stays accepted - not as skew
protection, but because the engine is a standalone binary with a documented HTTP API.
When both forms arrive, the array wins.

`config_snapshot` needs no work: it is the raw payload, so the array persists
automatically and a stored run becomes reconstructable.

**`/run` also gains the composition it never had.** Today load runs validate only the
request's own test script. With the array they receive the collection chain's too, so a
collection-level assertion is finally evaluated under load. Cost is small and off the hot
path: `validate_scripts` (`run_manager.cpp:35`) runs **after** the run, over the bounded
set of sampled responses, against a reconstructed `dummy_request`.

**Pre-request scripts remain absent from the load path.** There is no per-request script
hook there, by design - adding one puts QuickJS on the throughput hot path. The dialog's
existing warning stays true.

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

**Scripts.** With structured composition the run records each part and its origin, so the
script tab shows **only the `origin: "request"` entry** - structurally identical to the
same request's normal script tab. The collection entries render beside it as read-only,
labelled by the collection they came from, mirroring what `AuthInheritBanner` already does
for inherited auth. That banner is the precedent: the builder surfaces inherited auth today
and surfaces inherited scripts nowhere, so this closes a gap that has nothing to do with
history.

Editing affects the request entry only; a replay resends the recorded collection entries
untouched, which is correct for a snapshot - it replays the collection scripts **as they
were**, not as the collection reads now.

**Legacy runs** stored before structured composition have only the opaque string. They fall
back to showing the whole composed blob with a read-only note explaining that its parts
cannot be separated, and Save excludes scripts for those runs only.

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
method, url, params, headers, body, redirect policy, **and the request's own script** -
the `origin: "request"` entry, which maps exactly onto `request.preRequestScript` with no
collection text in it. Structured composition is what makes that safe; before it, scripts
had to be excluded.

It does **not** write **auth**: only the mode survives sanitisation, and writing a bare
mode would discard the request's credentials.

For a **legacy run** (opaque composed string) scripts are excluded too, since the request's
own part cannot be recovered.

Exclusions appear in the confirm as explicitly unchanged, so the rule is visible rather
than silent - including the fact that a legacy run writes fewer fields than a new one. The
action is hidden entirely when `run.requestId` no longer resolves.

## Build order

Built fresh from master on `design-run-detached-copy`. The abandoned branch
`history-opens-request-builder` produced roughly 770 lines - `useOpenRun`, the
`RequestBuilderProvider` store subscription, the `Shell` drawer patch and their tests -
that this design never needs. Three pieces of it are worth carrying over, and they are
Phase 0 because each stands on its own.

**Phase 0 - independently useful.** Would be worth doing even if this feature did not
exist: `buildRawRequest` + tests (the restore path collapsing a trace to
`` `${method} ${url}` `` is a bug in itself); the error-run mapping in
`responseFromRunResult` (failed design runs currently restore as nothing); `restoredFrom`

- the age chip (the builder's cold-start restore is dishonest without it).

**Phase 1 - engine.** `GET /run/:id` carries `result` for design runs. Structured script
composition on `POST /request` and `POST /run`. gtests, `api-reference.md`,
`db-schema.md`, `scripting.md`.

**Phase 2 - clients stop composing.** Renderer `index.tsx` and MCP `resolve.ts` together,
guarded by `resolve.test.ts`. `CLAUDE.md` and `mcp.md` / `architecture.md` updated, and
`pending-backlog.md` records the A1 slice as taken.

**Phase 3 - the feature.** `DesignRunView` + seed mapping; `HistoryDetail` routes design
runs to it and its header shrinks; delete `DesignRunDetail`.

**Phase 4 - what the feature unlocks.** `UnifiedResponseViewer` down to the embedded
sample view; the inherited-scripts banner in the builder; a test for `Shell`'s drawer
effect, which has none today and whose absence is why the earlier regression shipped.

## Edge cases and hard constraints

**The engine must join and execute once.** `execution.cpp:146` runs the composed string
through a single `engine.execute()`, so all parts share one JS scope - a `const` in a
collection script is visible to the request's. Iterating the array and executing per entry
would silently break that. Join, then execute once.

**Do not change the separator.** A syntax error reports a line number relative to the
joined blob. Any change to separator, filtering or order shifts every reported line.
`"

"`, byte-exact.

**Pick one filter rule.** The renderer keeps whitespace-only parts, MCP drops them. Adopt
MCP's `trim()` rule; it is obviously right, and it means the renderer's behaviour changes
for that edge.

**Error attribution is enabled, not delivered.** `preScriptError` still will not say
_whose_ script failed - that needs offsets. Explicitly out of scope.

**Composing test scripts into load runs is a visible behaviour change.** A collection-level
assertion never evaluated under load starts being evaluated, so `testValidation` numbers
move and some runs may newly report failures. That is the point of the fix, but it should
be called out in the release notes.

**Precedence.** Array wins when both forms are sent; the string is ignored, not merged.

**Empty input.** An omitted field, `[]`, and an array of empty scripts all mean "no
script".

## Blast radius

| Area      | Files                                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine    | `execution.cpp:305` parse + join; `run_manager.cpp:193` same for `tests`; `runs.cpp:47` result field; gtests                                  |
| Renderer  | `index.tsx` `handleExecute` and `handleConfirmLoadTest` stop composing                                                                        |
| MCP       | `resolve.ts` `joinScripts` / `composeScripts` / `OutgoingRequest`; `resolve.test.ts` composition block                                        |
| Types     | `ExecuteRequestPayload`, `StartLoadTestRequest`, MCP `OutgoingRequest`                                                                        |
| Docs      | `api-reference.md`, `scripting.md`, `mcp.md`, `architecture.md`, `db-schema.md`, `pending-backlog.md`                                         |
| CLAUDE.md | its _Request composition (known duplication)_ section states scripts are composed client-side in both copies - that becomes false for scripts |

`config_snapshot` needs no work: it is the raw payload, so the array persists automatically.

Absorbed rather than filed separately: the silent drop of collection test scripts under
load is what _Engine change 2_ fixes, and `resolve.ts:93`'s comment - which claims
`OutgoingRequest` is "the fully-composed body the engine's `POST /request` and `/run`
accept", though `/run` reads neither script field - is corrected in Phase 2.

## Testing

- **Seed mapping** (unit): auth mode, script parts by origin, redirect policy, structured
  body, declared headers, `id: null`.
- **Detachment** (behavioural): editing fires no save mutation. Mutation-check by restoring
  `onSave` and confirming the test goes red.
- **Replay**: sends editor state, live-resolved auth, `requestId`, and the recorded
  collection script entries unmodified; creates a run.
- **Orphan**: no Save, no Open request; headers seed from the trace and the replay sends
  the recorded `Authorization` verbatim.
- **Save**: writes the allowed fields including the request's own script; never writes
  auth; excludes scripts for a legacy run; requires confirm.
- **Legacy run**: opaque composed string renders with its note, and Save drops scripts.
- **Drawer**: a run tab does not move the drawer (regression cover).
- **Highlight**: the run row is selected while its tab is active.
- **Engine - result**: `GET /run/:id` carries `result` for a design run, not for a load run.
- **Engine - composition**: array and legacy string produce byte-identical joined output;
  array wins when both are sent; parts share one JS scope (a `const` in the first is
  visible to the second); whitespace-only parts are dropped; `/run` validates the
  collection chain's test scripts as well as the request's.
- **MCP parity**: `resolve.test.ts` covers the same composition cases as the renderer.

## Risks and accepted limitations

- **Replay fidelity.** A replay resends the recorded script parts, so it runs the
  collection scripts as they were at run time rather than as they read now. Test results
  are produced by the replay, not restored from the original run.
- **A1 is now partially taken.** Script composition is engine-side; variable interpolation
  and inherit-auth are not. `pending-backlog.md` must say so, or the next reader will
  assume all three still live in the clients.
- **Type-varying payload** on `GET /run/:id`. Accepted: `configSnapshot` already varies
  completely by type on the same endpoint.
- **Secrets remain visible** in the Raw and Headers tabs, sourced from the trace. This
  predates the change - the restore path already passed `trace.request.headers` into
  `requestHeaders`. Not addressed here.
- **`GET /requests/:id` still does not exist**, so resolving `run.requestId` to a request
  goes through the collection-list scan in `fetchRequestById`.
