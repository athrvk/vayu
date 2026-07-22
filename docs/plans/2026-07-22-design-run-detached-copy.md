# Design runs open as a detached copy

**Status:** approved, not implemented
**Replaces:** the approach in issue #65

## What this changes

Today, clicking a design run in History opens a read-only viewer.

After this change, it opens a **copy of the request that was sent**. You can read it, edit
it, and send it again. Editing the copy does not touch your saved request.

"Detached" means the copy is not linked to the saved request. Nothing you type in it is
saved anywhere. There is a separate button to write changes back, and it asks first.

## Why the first attempt was wrong

Issue #65 said: open the run's **saved request** in the builder, and put the run's response
in the response pane. That was built. It works. It is still wrong.

- The left side shows the request **as it is today**. The right side shows a response from
  the past. They describe two different things.
- The builder saves automatically after 5 seconds. So opening an old run and changing a
  header to compare **rewrites your saved request**. Before #65 that was impossible,
  because the run opened a read-only viewer.
- Opening a request tab made `Shell` switch the sidebar to Collections. That threw you out
  of the History list on the first click.
- `HistoryList` decides which row to highlight from `activeTab.type === "run"`. A design run
  no longer opened a run tab, so no row ever highlighted.
- `RecentRuns.tsx:74` opens design runs a different way. The same click did two different
  things depending on where you clicked it.

All four come from one cause. A request tab could now be opened from two places, and the
tab did not record which. The fix is not to record it. The fix is to stop opening a request
tab at all.

## Facts this design depends on

Each of these was checked against a running engine. Check them again before changing
anything here.

### `GET /run/:id` already returns the run's configuration

The shape is the same for both run types. Only `configSnapshot` differs. For a design run
it holds the exact payload that was sent:

```json
{
  "id": "...",
  "type": "design",
  "status": "completed",
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

`apiService.getRun()` (`services/api.ts:205`) already calls this endpoint. Nothing in the
app uses it.

### The report is built for load tests, and gives a design run no configuration

`GET /run/:id/report` returns a load-test summary. Run it against a design run and the
numbers are meaningless, because they come from one sample:

```
summary : { totalRequests: 1, avgRps: 24.39, peakConcurrency: 0 }
latency : { p50 = p90 = p95 = p99 = p999 = 2.1268 }
```

More importantly: `metadata.configuration` is present for a load run and **absent for a
design run**. The report cannot tell you a design run's auth mode, scripts, or redirect
settings. Only `GET /run/:id` can. So the design view has to call it.

One more difference. `results` means different things per run type. For a design run it is
the single exchange. For a load run it is the sampled subset, and it came back empty on a
small run.

### Stored runs never contain credentials

`sanitize_config_snapshot` (`utils/json.cpp:625`) strips the `auth` object down to
`{"mode": ...}` before saving. It keeps one named field and drops everything else, so no
future credential field can leak in either.

This has a consequence the design leans on: **credentials can only come from the live
request.** That is not a rule we chose. It falls out of the sanitiser.

### The trace holds the request as it went on the wire, credentials included

`store_result` is called after auth is applied (`execution.cpp:380`). Verified:

```
auth {mode: bearer, token: "SECRET-TOKEN-12345"}
  -> trace.request.headers   = { "Authorization": "Bearer SECRET-TOKEN-12345", ... }
  -> configSnapshot.headers  = { }                       (declared headers only)

auth {mode: apikey, addTo: query, value: "SECRET-QUERY-KEY"}
  -> trace.request.headers   = { "api_key": "SECRET-QUERY-KEY" }
  -> the URL is left clean
```

So the trace minus the snapshot is exactly the set of headers the engine added. That is
safe to use when **replaying**, where you want to resend whatever the engine added. Do not
use it to decide which headers are auth headers when saving. The engine may add others
later.

### Scripts are glued into one string, and this design changes that

`RequestBuilder.handleExecute` builds one string from the collection chain's scripts plus
the request's own script, joined by blank lines. It sends that string. So
`configSnapshot.preRequestScript` contains the collection's scripts inside it, with nothing
marking where each part starts.

Writing that string back into a request would put the collection's script inside the
request permanently. The next send would glue it on again and run it twice.

This design fixes the cause. See **Engine change 2**.

Two related facts, both verified:

- **The two clients disagree already.** The renderer drops empty parts with
  `.filter(Boolean)`. MCP's `joinScripts` (`resolve.ts:238`) drops them with `s.trim()`. A
  script that is only whitespace is kept by one and dropped by the other.
- **Load runs never run the collection's scripts.** `POST /run` reads only
  `config["tests"]` (`run_manager.cpp:193`), and the app sends only the request's own test
  script. So a collection-level assertion passes in design mode and is silently never
  checked under load. The load dialog warns that pre-request scripts do not run. Nothing
  warns about this.

## Design

### Where each piece of the copy comes from

| Source           | Gives us                                                                   | Why this source                   |
| ---------------- | -------------------------------------------------------------------------- | --------------------------------- |
| `configSnapshot` | method, url, declared headers, body, auth mode, scripts, redirect settings | it is the payload that was sent   |
| `result.trace`   | the response, the timings, the Raw tab                                     | it is the wire record, after auth |
| the live request | credentials                                                                | they are never stored, see above  |

### Engine change 1: `GET /run/:id` returns the exchange

For design runs only, add a `result` field:

```json
"result": {
  "timestamp": 0, "statusCode": 200, "statusText": "OK", "latencyMs": 2.1,
  "error": "...",
  "trace": { "request": {...}, "response": {...}, "dnsMs": 0, "connectMs": 0 }
}
```

Load runs are unchanged and get no `result`.

The payload already differs by run type on this endpoint, because `configSnapshot` is
completely different for each. So this is not a new kind of contract.

The design view then never calls `/run/:id/report`. The report stays a load-test thing.

Update `docs/engine/api-reference.md` and `docs/engine/db-schema.md`.

### Engine change 2: the engine glues scripts together, not the clients

Both send paths take a list of script parts instead of one pre-glued string:

```jsonc
// POST /request
"preRequestScripts":  [ { "origin": "collection", "id": "col_1", "name": "API", "script": "..." },
                        { "origin": "request",    "id": "req_9",                "script": "..." } ],
"postRequestScripts": [ ... ]

// POST /run
"tests":              [ { "origin": "collection", ... }, { "origin": "request", ... } ]
```

The engine joins them with `"\n\n"` and runs the result **once**, exactly as the clients do
now. Execution is byte for byte the same.

The old string form still works. That is about the engine being a standalone binary with a
documented API, not about version mismatches. If both forms arrive, the list wins.

`config_snapshot` needs no work. It stores the whole payload, so the list is saved
automatically. That is what makes a stored run readable later.

This is a deliberate piece of backlog item A1, and only that piece. Scripts move to the
engine. Variable substitution and inherited auth stay in the clients. A1 stays open for
them.

**`/run` gets the scripts it never had.** Load runs will now check the collection chain's
test scripts as well as the request's own. The cost is small and not on the hot path.
`validate_scripts` (`run_manager.cpp:35`) runs after the test finishes, over the sampled
responses only.

**Pre-request scripts still do not run in load tests.** There is no place in the load path
to run them. `validate_scripts` runs after the fact, against a rebuilt dummy request, so a
script that modifies the outgoing request has nothing to modify. Adding that would mean
running JavaScript per request at full throughput. The dialog's existing warning stays true.

### Which tab opens

The tab stays `{ type: "run", entityId: run.id }`. That is the existing type, so the tabs
store does not change and stored tabs do not need migrating. Every run opens its own run
tab, design or load.

Four things follow, and all of them delete code:

- `useOpenRun` goes away. No pre-fetching a report, no looking up a request, nothing async,
  no spinner.
- `HistoryList` goes back to one line: `openTab({ type: "run", entityId: runId })`.
  `RecentRuns` already does exactly that, so the two paths stop disagreeing on their own.
- `Shell` needs no change. A run tab never moved the sidebar.
- `HistoryList`'s existing highlight rule works again, because the tab is a run tab.

`HistoryDetail` sends design runs to a new `DesignRunView`. Its header shrinks to the run's
identity, status, and buttons. The URL comes from the builder below it, so there are not two
URL bars.

### The detached builder

`DesignRunView` renders `RequestBuilderProvider` with:

- `initialRequest` = the values below, with **`id: null`**
- `initialResponse` = `responseFromRunResult(run.result)` (a new prop; today the provider
  reads the response from the store using the id)
- `onExecute` = send again
- **no `onSave`**

`id: null` does the detaching, and needs no new code. `useSaveManager` stops early when
`entityId` is null. The response store is keyed by id, so nothing is written to it.
`useLastDesignRunQuery(null)` never runs. The provider is already correct for a request with
no id.

Starting values:

| `RequestState`                               | From                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `method`, `url`                              | `configSnapshot`                                                     |
| `params`                                     | `parseQueryParams(url)` (`utils/url.ts`, already used by `UrlInput`) |
| `headers`                                    | depends on whether the request still exists, see **Auth**            |
| `body`, `bodyMode`, `formData`, `urlEncoded` | `configSnapshot.body`, already structured                            |
| `authType`, `authConfig`                     | depends, see **Auth**                                                |
| `preRequestScript`, `testScript`             | see **Scripts**                                                      |
| `followRedirects`, `maxRedirects`            | `configSnapshot`                                                     |
| `id`, `collectionId`                         | `null`                                                               |

**Auth, in one sentence:** use the live request's auth if the request still exists,
otherwise resend exactly what went out.

|                      | `headers` from                                     | `authType` / `authConfig`                            |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| request still exists | `configSnapshot.headers`, no credentials in them   | the request's current auth                           |
| request is gone      | `trace.request.headers`, including `Authorization` | `none`, because auth is already inside those headers |

Both cases keep the same promise: **what you see in the editor is what gets sent.**

When the request exists, that means its current auth, because that is what a fresh
resolution will produce. The run's own recorded mode is shown next to it as read-only
information, which also makes it obvious when the request's auth has changed since.

When the request is gone, the old token is a normal header row. You can see it and edit it,
so a dead token can be replaced by hand.

**Scripts.** The run records each part and where it came from, so the script tab shows
**only the request's own part**. That looks exactly like the same request's normal script
tab. The collection's parts appear next to it, read-only, labelled with the collection they
came from.

`AuthInheritBanner` already does this for inherited auth. Nothing does it for scripts, so
today you cannot see what runs before your own pre-request script. This closes that gap, and
that gap has nothing to do with History.

Editing changes the request's part only. Sending again resends the recorded collection parts
unchanged. That is correct for a snapshot: it runs the collection scripts **as they were**,
not as they read now.

**Runs saved before Engine change 2** only have the old glued string. There is no way to
split it back apart, because nothing marks the boundaries. Those runs show the whole string
with a note saying its parts cannot be separated, and Save leaves scripts alone for them.

### Sending it again

Send the current contents of the editor to `POST /request`, with `requestId: run.requestId`
so the new run is filed under the same request. Auth is resolved fresh from the saved
request using the existing helpers. Do not copy that logic; `CLAUDE.md` forbids a third copy
of it.

Sending creates a new run in History, which is what should happen.

If the request is gone, there is no auth to resolve. The trace's headers were used as the
starting values, so the old `Authorization` goes out as-is and the run is replayed exactly
as it ran. If the token has expired you get a 401. That is a true answer about replaying
that request, and the header is editable so you can paste a fresh one.

### Save to request

A button that copies values from the run back onto the saved request. It asks first, showing
what will change, because it cannot be undone.

**It writes:** method, url, params, headers, body, redirect settings, and **the request's
own script part**. That part maps straight onto `request.preRequestScript` and has no
collection text in it. Engine change 2 is what makes that safe. Without it, scripts had to
be left out.

**It does not write auth.** Only the mode is stored, and writing a bare mode would wipe out
the request's credentials.

**For a run saved before Engine change 2**, scripts are left out too, because the request's
own part cannot be recovered from the glued string.

Everything left out is listed in the confirmation as unchanged. That includes the fact that
an older run writes fewer fields than a new one, so it is visible rather than surprising.

The button is hidden when the request no longer exists.

## Build order

Built fresh from master on `design-run-detached-copy`. The abandoned branch produced about
770 lines this design never needs: `useOpenRun`, the provider store subscription, the
`Shell` patch, and their tests. Three pieces are worth keeping.

**Phase 0. Useful on their own.** Worth doing even without this feature.

- `buildRawRequest` and its tests. Today the restore path turns a whole trace into
  `` `${method} ${url}` ``, which is a bug by itself.
- Error runs in `responseFromRunResult`. A failed design run currently restores as nothing.
- `restoredFrom` and the age chip. The builder restores an old response on startup and does
  not say so.

**Phase 1. Engine.** `GET /run/:id` returns `result`. Scripts become a list on both send
paths. gtests. `api-reference.md`, `db-schema.md`, `scripting.md`.

**Phase 2. Clients stop gluing scripts.** Renderer `index.tsx` and MCP `resolve.ts` change
together, guarded by `resolve.test.ts`. Update `CLAUDE.md`, `mcp.md`, `architecture.md`, and
record the A1 piece in `pending-backlog.md`.

**Phase 3. The feature.** `DesignRunView` and its starting values. `HistoryDetail` routes
design runs to it and its header shrinks. Delete `DesignRunDetail`.

**Phase 4. What the feature makes possible.** `UnifiedResponseViewer` shrinks to the
embedded sample view. The inherited-scripts panel in the builder. A test for `Shell`'s
sidebar effect, which has none, and whose absence is why the earlier bug shipped.

## Things that will break this if ignored

**Join the parts, then run once.** `execution.cpp:146` runs the joined string through a
single `engine.execute()`. All parts share one JavaScript scope, so a `const` declared in a
collection script is visible to the request's script. Running each part separately would
break that quietly.

**Do not change the separator.** A syntax error reports a line number counted from the start
of the joined string. Change the separator, the filtering, or the order, and every reported
line number moves. Keep `"\n\n"` exactly.

**Pick one rule for empty parts.** The renderer keeps whitespace-only parts, MCP drops them.
Use MCP's `trim()` rule. This changes renderer behaviour for that case.

**Do not try to say which script failed.** `preScriptError` still cannot name the part that
failed. Doing that needs character offsets. It is out of scope, and it will grow this change
a lot if allowed in.

**Load-test results will change.** Collection-level assertions that were never checked under
load will start being checked. `testValidation` counts will move, and some runs will report
failures they did not before. That is the fix working, but it belongs in the release notes
or it reads as a regression.

**When both script forms are sent**, the list wins and the string is ignored. They are never
merged.

**Empty input.** A missing field, an empty list, and a list of empty scripts all mean "no
script".

## What this touches

| Area        | Files                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Engine      | `execution.cpp:305` parse and join; `run_manager.cpp:193` the same for `tests`; `runs.cpp:47` the new `result`; gtests |
| Renderer    | `index.tsx`, both `handleExecute` and `handleConfirmLoadTest`                                                          |
| MCP         | `resolve.ts` (`joinScripts`, `composeScripts`, `OutgoingRequest`); `resolve.test.ts`                                   |
| Types       | `ExecuteRequestPayload`, `StartLoadTestRequest`, MCP `OutgoingRequest`                                                 |
| Docs        | `api-reference.md`, `scripting.md`, `mcp.md`, `architecture.md`, `db-schema.md`, `pending-backlog.md`                  |
| `CLAUDE.md` | its _Request composition_ section says both clients glue scripts. That stops being true.                               |

`config_snapshot` needs no work. It saves the whole payload, so the list is stored for free.

Two problems found along the way are fixed here rather than filed separately. Collection test
scripts being dropped under load is what Engine change 2 fixes. And `resolve.ts:93` describes
`OutgoingRequest` as the body that `POST /request` and `POST /run` both accept, though
`/run` reads neither script field; that comment is corrected in Phase 2.

## Testing

- **Starting values** (unit): auth mode, script parts by origin, redirect settings, body,
  declared headers, `id: null`.
- **Detachment**: typing in the copy triggers no save. Check the test really works by
  putting `onSave` back and confirming it fails.
- **Send again**: sends the editor contents, freshly resolved auth, `requestId`, and the
  recorded collection script parts unchanged. A new run appears.
- **Request deleted**: no Save, no Open request. Headers come from the trace and the old
  `Authorization` is sent as-is.
- **Save**: writes the allowed fields including the request's own script. Never writes auth.
  Leaves scripts alone for an older run. Asks first.
- **Older run**: the glued string renders with its note, and Save drops scripts.
- **Sidebar**: a run tab does not change the sidebar view.
- **Highlight**: the run's row is highlighted while its tab is open.
- **Engine, result**: `GET /run/:id` has `result` for a design run and not for a load run.
- **Engine, scripts**: the list and the old string produce the same joined output; the list
  wins when both are sent; parts share one scope (a `const` in the first is visible to the
  second); whitespace-only parts are dropped; `/run` checks the collection's test scripts as
  well as the request's.
- **MCP**: `resolve.test.ts` covers the same cases as the renderer.

## Known limits

- **Sending again is not identical to the original.** It resends the script parts as they
  were recorded, so it runs the collection scripts as they were then, not as they read now.
  Test results come from the new send, not from the old run.
- **`GET /run/:id` returns a different shape per run type.** Accepted, because
  `configSnapshot` on that same endpoint already does.
- **Credentials stay visible** in the Raw and Headers tabs, read from the trace. That is
  already true today and is not addressed here.
- **A1 is now partly done.** Scripts are handled by the engine; variable substitution and
  inherited auth are not. `pending-backlog.md` has to say so, or the next reader will assume
  all three are still in the clients.
- **There is still no `GET /requests/:id`**, so finding a request by id still scans the
  collection lists in `fetchRequestById`.
