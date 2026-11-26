---
description: >-
  The API service's methods for sending a request, starting a run and managing runs.
---

# API methods: execution and runs

## Execution

```typescript
apiService.composeRequest(data): Promise<ComposedRequest>
apiService.executeRequest(data, signal?): Promise<SanityResult>
apiService.startLoadTest(data): Promise<StartLoadTestResponse>
apiService.startScenarioRun(data): Promise<StartLoadTestResponse>
```

`startLoadTest` and `startScenarioRun` are the **same `POST /runs` endpoint and the same `202 {runId}` answer** - the payload is what selects the executor.
A scenario states its work as an ordered collection (`{scenario: {source: "collection", collectionId, recursive?, iterations?, data?, dataFileName?, dataFileHash?, dataFileCastNumbers?}}`), so it carries no `method`/`url`, and its iteration count lives inside the block rather than beside a load-test mode.
`data` is the parsed rows of a data file (`services/data-files/`), sent inline because the engine never opens a file, and `dataFileName` / `dataFileHash` name that file beside them (issue #2051): the picked file's name and the SHA-256 of its bytes, never its path, so the run records which file drove it.
`dataFileCastNumbers` (issue #2540) is the picker's **Read numbers as numbers** (`parsed.castNumbers`), sent beside them on every run with a file, so the run records how its rows were typed; the engine stores it only when `true`.
`iterations` is **omitted** when the user left it blank, so the engine's "absent means one pass per row" rule stays in one place.
Both send `allowScriptRequests`, for the same reason: every step runs the scripts a Send of that request would run.
The engine resolves the whole plan before answering, so an empty collection, a step that will not compose, or a plan over `maxScenarioSteps` is a `400` with **no run row created** - a failed start leaves nothing to clean up.

**All four run-starting calls (`executeRequest`, `executeStreamRequest`, `startLoadTest`, `startScenarioRun`) stamp `origin: {kind: "app"}`** on the payload (#1817), set after the caller's spread so a payload cannot claim another.
The engine records it on the run, and History reads it back: an unstamped run is `other`, indistinguishable from one a script started.
The type is `RunOrigin` (`types/domain.ts`); `listRuns` takes the kind as `origin` and sends `GET /runs?origin=`.
See [engine/api-reference/index.md](../../engine/api-reference/index.md) for what the engine validates.

**`executeRequest` also stamps `includeParsedBody: false`** (#2544), at the same choke point and after the same spread.
The pane is built from `bodyRaw`, so the engine's parsed copy of a JSON body is a second tree that the daemon builds, serializes and holds on its heap and the renderer then parses and never reads; declining it answers `body: null`.
The MCP server does not send it - its `run_request` result exposes the parsed `body` to the agent, so it keeps the engine's default (`electron/mcp/tools/run-request.tools.test.ts` asserts the payload).
The streaming send answers `202` with no body, so the flag is not part of it.

**`executeRequest` budgets its abort timer as a worst case for the payload** (#2836, `executeBudgetMs` in `lib/execute-budget.ts`).
One `POST /execute` runs the pre-request script, the late OAuth 2.0 token fetch, the transfer and the test script in sequence, so the client arms the request timeout (the `defaultTimeout` setting, or the payload's own `timeout` if larger; 300 s when the config cache is cold) once for the transfer,
again when `auth.mode` is `oauth2` (the token fetch is bounded by the same request timeout), plus the `scriptTimeout` setting (60 s when cold) for every enabled `script.pre` / `script.post` element in `elements`, plus the 10 s grace.
The engine gives each script element its own deadline, so a collection's script and the request's are two terms.
A payload with neither OAuth nor a script is exactly the setting plus the grace, so a hung engine is declared dead as fast as before for the common send.
The MCP client keeps a copy in `electron/mcp/execute-budget.ts` (the main process cannot import renderer modules); `execute-budget.parity.test.ts` holds the two to the same number.
`fetchOAuth2Token` has no script to wait for and stays at the setting plus the grace.

**`executeRequest` takes the builder's Cancel as `signal`** (#3352), handed to `httpClient.post`, whose `request()` composes it with that abort timer the way `stream()` composes a caller's signal with its idle timer.
A cancel rejects with `stream()`'s `AbortError`, never with the timeout's "Couldn't reach Vayu's engine in time.", and a signal that is already aborted puts nothing on the wire.

Aborting the fetch closes the connection, and the engine's buffered `POST /execute` watches for that (#3383): it cancels the transfer if it has not finished, about a second later at most, and records the run `stopped` rather than `completed`.
A request already on the wire may still have reached its target, and the variable writes of its scripts still land.
The builder's and the History copy's send paths therefore invalidate the Recent sends, History and variable queries for a cancelled send as they do for an answered one; only the response is dropped.

`startLoadTest` takes rows too, as a **top-level `data`** array (issue #993): the load dialog's file picker parses the file and sends the same array it previewed, and the engine binds one row per request the run sends.
Omitted when no file was picked - a present-but-empty array is refused engine-side, so "no data set" has to be the absent key rather than `[]` - and never sent beside a `scenario` block, whose rows are `scenario.data` and bind per iteration.

`failOnSchemaError` rides the design-mode payload beside `environmentId`, from the dialog's **Fail steps on schema errors** switch (issue #720), and is **omitted when off**: the engine defaults it to false, so absent already says what the user asked for, and only a run that wanted the gate carries the key into its stored snapshot - where `SampledSchemaValidation` reads it back to say so.
It is never sent on a load payload, whose executor validates after the run has drained and cannot demote a step on it.

`stopOnError` follows the same shape (issue #2526): top-level on the design-mode payload, from the dialog's **Stop the iteration on a script error** switch, **omitted when off** and never sent on a load payload, whose executor does not read it.
Off, the engine's default, an errored step (a script that threw, a request that got no response) stays `errored` and the iteration walks on, as in Postman; on, every errored step ends its iteration.
What an error that did end one cost comes back as `stepsNotRun`, which the renderer reads on three layers: the report's `scenario.stepsNotRun` (the run tab's header prints "N steps did not run" beside the iteration tally), and `stepsNotRun` on the `step` frame and on the stored row's trace (the step that ended its iteration prints "Ended this iteration: N steps did not run" in its expansion).
Each is absent, never `0`, when nothing was lost, and a report from before the field has none.

Adding a load `mode` beside the block makes it a **scenario load run** (issue #357): the same plan, driven by `concurrency` virtual users on the event loop.
The *presence* of `mode` is the whole discriminator, so a design-mode payload must carry none at all - not a falsy one - and `RunCollectionDialog` therefore spreads the load fields in rather than always sending them.
The dialog offers the three closed-loop modes: `constant_concurrency` and `ramp_up` send `duration` (and, for the ramp, `startConcurrency` and `rampUpDuration`, camelCase with `"Ns"` strings), while `iterations` sends the top-level total of passes and no `duration`; the top-level `iterations` is distinct from `scenario.iterations`, which is sent only when Load test is off.
Top-level `retryAfterBackoff` and `retryAfterMaxMs` (#3799, the engine's wait-out-`Retry-After` option) ride the load fields too, as a pair and only when the dialog's **Wait out Retry-After** switch is on.
`constant_rps`, and any non-zero `rps`/`targetRps` on any mode, is a `400`: an open-loop arrival rate over a multi-step sequence is an arrival-rate executor the engine does not implement, and it is refused rather than quietly run closed-loop.
Such a run's `type` is `load`, so it streams `metrics` ticks and **not** `step` events - the caller must attach `loadTestService`, not `scenarioRunService`.

A scenario run also takes a top-level `elements` override (issue #1495, wired into `RunCollectionDialog` by issue #1552): `{timers?: "asConfigured" | "off", scripts?: "asMarked" | "allInline" | "allDeferred", includeScriptTime?: boolean}`, documented in full at [api-reference/load-runs.md](../../engine/api-reference/load-runs.md#the-elements-block-element-pipeline-override).
It rides beside `mode`/`scenario`, never inside the `scenario` block, and `RunCollectionDialog` sends only the fields the user changed from the engine's own default - the same omitted-when-default rule `failOnSchemaError` follows.
`timers` is wired to `timer.pacing`/`timer.think` end to end and applies to a design-mode run exactly as it does a load run, so the dialog offers that control regardless of Load test;
`scripts` picks whether a `script.*` element runs inline on the event-loop worker or stays deferred to the post-run replay, and has no effect on a design-mode run (which already runs every script inline), which is why the dialog offers that one control only once Load test is on.
Since issue #1594 the single-request `startLoadTest` payload has an `elements` attachment point too - its own step-level elements ride under `requestElements` instead (a distinct key, because this endpoint's own `elements` is the override block, not a script source) -
and `LoadTestConfigDialog` sends the same `elements: {scripts}` override there once the user changes the dialog's Scripts control from its `"asMarked"` default, the one control the single-target payload's own `preRequestScript` warning needs:
`"allInline"` is what makes a pre-request script actually reach the wire under load, since an unmarked one otherwise never runs on this path either.
A disabled element is left out of `requestElements` (`withoutDisabled`, issue #3050): the pipeline skips it, and the engine no longer refuses a disabled scenario-only kind there.
An *enabled* `timer.pacing`, `timer.throughput`, `control.*` or `metric.record`, the request's own or inherited, never reaches the payload - the dialog blocks Start and offers the collection run instead.
A collection's own `script.setup` / `script.teardown` (the `collectionOnly` kinds) is left out too (`withoutInheritedCollectionOnly`, issue #3070): a single-request run never takes a collection's lifecycle scripts, and the engine validates `requestElements` as a request's own.
Send and code generation, which compose through `POST /compose`, keep them, and leave out the request's own disabled and incomplete draft elements instead (`sendElementsParts`, issue #3066; see Elements below).
The load run does not: the engine validates its `requestElements`, and the dialog's notices read the request's full list.
`LoadTestConfigDialog` offers no Timers twin, but not because the engine ignores the override there - `elements.timers` applies to a single target's own `timer.think` exactly the way it does to a scenario step's - the dialog simply has no timer control of its own on this path to pair it with yet.

What comes back for one differs in two places worth knowing.
`GET /runs/:id` returns the **resolved manifest** in place of the block that was sent (`{source, collectionId, recursive, iterations, dataRowCount, dataFileName?, dataFileHash?, dataFileCastNumbers?, steps[]}`,
the two file keys present only when the run named its data file and the flag only when its numbers were cast, each step `{index, requestId, name, method, url}` with the *stored* url, never a composed one) -
that is what the run tab's context bar reads, through `run-scenario.ts`.
The paginated `GET /runs` list row cannot carry the manifest and instead carries `summary.scenario` (`{collectionId, iterations, recursive, stepCount, dataFileName?, dataFileHash?, dataFileCastNumbers?}`), present on any row whose snapshot carries a scenario block - so a scenario *load* run gets it too.
The history row reads it because a run whose work is a sequence has no `url` or `method` for the ordinary row to show, and that is true of both executors.

A scenario load run's **report** carries the per-step breakdown the design-mode runner has no need for:
`scenario.steps[]` (`{index, name, label?, requestId, method, executed, errors, httpErrors, noResponse, latency:{min,p50,p95,p99,max}}`) plus `virtualUsers`, `iterationsAbandoned` and, once a pass completed,
`passDuration` (`{count, mean, min, p50, p95, p99, max}` in ms, #3570: each completed pass from the claim of its first step to the completion of its last, timer waits between steps included, abandoned passes left out).
It stores no per-step `results` rows, so that array is the only per-step record such a run keeps.

It also carries `scenario.assertions` (`{passed, failed}`, #2820) when the run made at least one exact assertion: every `assert.*` outcome, required `extract.*` miss and inline `pm.test` call, counted on every completion.
It counts assertions, where `scenario.failed` counts step executions in which one failed (#2824, once however many), and the report's error rate stays HTTP-only, so a run of `200`s that failed every assertion reads a 0% error rate and a non-zero `assertions.failed`.
**Absent**, never `{0, 0}`, for a run with no such assertion, a collection run and a report stored before the field.
It is the report's top-level `assertions.exact` too (#3537), and the renderer reads that block, falling back to `scenario.assertions` from an older engine, through `reportAssertionsOf` (`components/shared/run-assertions.ts`): the verdict (`reportOutcome`) directly, `RunKeyMetrics`' fourth tile and the Overview's Assertions card through `exactAssertionsOf`.

A step's `label` (#3829) is the engine's name for what the step ran, `tools/call search` for an MCP step, and is present only on those; `name` stays the request's name and the step's identity.
The Steps table draws it beside the name in a muted monospace (`StepLabelCell`), so a sequence of tool calls reads as which call each step made.
The engine renders the report's exports, so the app has no second place that formats the steps.

A step's `errors` is the run's one error definition (a response outside 2xx/3xx, or no response) and equals `httpErrors + noResponse`.
Only a `noResponse` execution, or a jump the run could not honour (#2974), ends its iteration; an HTTP error status does not.
`httpErrors` and `noResponse` are optional in the renderer's type because a report stored before the engine split the tally lacks them; the Steps table shows the split in the Errors cell's tooltip when both are present and the bare count otherwise.

A step also carries `tests` (`{sampled, passed, failed}`) when its own post-request script was replayed against that step's sampled responses - the deferred per-step validation.
The key is **absent** for a step that asserted nothing or whose script drew no sample, which is not the same claim as zero failures, so the table shows a dash there rather than a `0`.
The Tests cell reads `tests.sampled` against the step's `deferred` count ("23 of 2,270"), with the passed / failed split in its title; a step with no `deferred` (a report stored before the engine wrote it) keeps the plain passed / failed cell.
The line above the table adds "Iterations cut short" when `iterations - iterationsCompleted - iterationsAbandoned` is above zero, the iterations a deadline or Stop ended.

A **design run's** list row carries one thing the detail route says at greater length: `resultSummary` (`{statusCode, latencyMs}`), the outcome of its single exchange.
`GET /runs/:id` attaches the whole `result` instead, trace and bodies included, which is why the list carries the two numbers rather than that - and why the context bar's Recent sends section is one list call and no report fetch.
A terminal collection run's row carries `{passed, failed, skipped, errored, stopped, verdict}` from its stored summary (#2954, `stopped` #3397: a step a Stop cut short, in no failure count), each key only when recorded;
the renderer's derivation reads `failed`, `errored` and a `verdict` of `"failed"` (a completed run with any of them gets the failed glyph and a line naming the missed budgets and the step counts, #3458, #3539) and the MCP `list_runs` rows read the whole summary.
A `"passed"` verdict changes nothing on the row.
A load run's results are unbounded and are never read for one;
once the run is terminal its row carries `{rps, p95Ms, errorRate, verdict}` from the run's stored summary instead (#2130, [GET /runs](../../engine/api-reference/runs.md#get-runs)), plus, on a run that asserted or errored, the stored `assertions` block (`{exact, sampled, errored, teardownFailed}`, #3537) with `assertionsPassed` and `assertionsFailed` summed over its two populations (#2820, #3458).
The renderer reads the block (the row's verdict and its result line, through `rowAssertionsOf`), and an older engine's flat `assertionsFailed` as exact in its place; `assertionsPassed` has no renderer reader and is there for the MCP `list_runs` rows.
A load run whose drain a Stop cut with requests outstanding also carries `drainCut` (`{cancelled}`, #3538; absent otherwise), the report's `summary.drainCut` too: the run stays `completed` and its verdict stays the stored budget one, and `rowOutcome` / `reportOutcome` read the cut as **Not judged** ahead of any met-budget reason (`run-outcome.ts`).
A terminal capacity run's row also carries `capacity` (`{stopReason, maxHealthyConcurrency, kneeConcurrency}`, the last two omitted when the search found no such level, #2930), which the row's result line reads in place of the run-average `rps`; an engine that predates it sends none.

A list row also carries the engine's stored verdict, `outcome` (`"passed"`, `"failed"` or `"not_judged"`, #3547), only when the engine judged one: no clean collection run, no design run that did not fail, no run still in flight and no row stored before the column has it, and `GET /runs/:id` carries none.
A run whose status is `failed` always has `outcome: "failed"`, of any type and with or without a `resultSummary` (#3643), the status being the verdict.
`rowOutcome` reads it first as the authority for the row's category, which is what `GET /runs?outcome=` filters on, so a row cannot wear a verdict it is not listed under; the `resultSummary` derivation above is the fallback for a row without one and supplies the reason when it reaches the same category.
The derivation is the rule the engine stores by, held equal to it by `engine/tests/fixtures/run-row-outcome-conformance.json` (a collection row is `failed` or has no outcome, never `passed`).
A row stored before the column keeps a NULL `outcome` even when it failed (no backfill), yet `rowOutcome` derives `failed` for it from its status, so such a row is drawn failed but is not listed by a `GET /runs?outcome=failed` page (#3643).

`composeRequest` (`POST /compose`, issue #226) resolves `{{variables}}` and `inherit` auth engine-side and returns the payload the other two accept unchanged - every send site composes first, so nothing is interpolated twice.
For a request a pre-request script runs before, the answer keeps the names a scope answers written as `{{name}}` and lists them in `deferredVariables` (issue #2521; a `ComposedRequest` member, sorted, absent when none): the send resolves them after the script.
The list describes the composition, not the request, so the composing hook drops it from the payload a send posts onward to `/execute` or `/runs`, and only the Code section, which calls `apiService.composeRequest` itself, reads it.
A send also states nothing about hosts: only the MCP server attaches a `targetPolicy` to its sends.

**GraphQL schema introspection is a send site too** (`lib/graphql/introspect.ts`, issue #228): it composes the endpoint, overlays the introspection query onto the composed `url` / `headers` / `auth`, and executes that - which is how an endpoint whose credentials live in the Auth panel gets introspected at all.
It sends the composed request's auth but neither its body nor its script parts.

**A Send-with-row carries one extra field** (issue #601): `data`, the row the UrlBar's caret picked, added *beside* the composed payload rather than passed through `POST /compose`.
`{{data.*}}` survives composition by design, so the tokens are still written when `/execute` binds them against the row; composing the row in would be composing twice.
Both send handlers take it - buffered and streaming - because the engine binds a row on either path, and a row silently dropped on one of them is the written-but-never-read defect.
An ordinary Send passes no argument at all, so its payload is byte-identical to what it was.

The row's **names** do reach composition, though (issue #1007): `buildSendBody` sends `dataColumns: Object.keys(row)` on `POST /compose`, because a bare `{{username}}` is a name the scopes *can* answer and composition has to be told to leave it for the bind instead.
Names only - a value there would be this row's value written into a payload composed once - and absent for an ordinary Send, so that path is still byte-identical.
`LoadTestConfigDialog` carries the same field for a run given a data file (`config.dataColumns`, the picker's parsed column list rather than a re-union of the rows' keys), and a **collection** run sends none: the engine composes those steps itself and fills the set from the run's own rows.

It is the **only** send site that sets `transient: true` (issue #382), because it is the only one the user did not initiate.
The engine then runs it in full and records nothing: no History entry, no result trace holding the credentials composition resolved, and no retention prune evicting a real run.
It also carries the target's `environmentId` onto the execute payload, which is what scopes the engine's cookie jar - without it a cookie-session endpoint answered real requests and failed introspection alone.
Every other send site omits the flag and is recorded as usual; see [api-reference/execute.md](../../engine/api-reference/execute.md#post-execute).

## Run Management

```typescript
// Paginated, filtered history (newest first). Rows carry a compact `summary`
// (url/method/mode/duration/concurrency/comment), not the full configSnapshot.
// `limit: 1` makes `pagination.total` a count of the runs the filters match,
// which is how Settings counts runs without downloading them (#2979).
// Older pages are read by cursor, not offset (#2978): pass the previous page's
// `pagination.nextBefore` as `before` (the engine owns its `<startTime>:<id>`
// spelling; null on the last page). `listRuns` sends its default `offset=0`
// only when there is no cursor, because the engine refuses `before` beside a
// non-zero offset (`before_with_offset`). `offset` stays for a caller that
// jumps to a page number; the MCP server keeps using it.
apiService.listRuns(params?: RunListParams): Promise<RunListResponse>
apiService.getRun(id): Promise<Run>            // full configSnapshot; a design run's holds the
                                               // composed `elements` it ran (see Execute below)
apiService.getRunReport(id): Promise<RunReport>
// Response headers/bodies captured for a run's samples. Its own request, not
// fields on the report - see below.
apiService.getRunSamples(id, { limit?, offset? }): Promise<RunSamplesResponse>
apiService.stopRun(id): Promise<StopRunResponse>
apiService.deleteRun(id): Promise<void>
```

`deleteRun` on a run that is still in progress stops it engine-side first, so it takes as long as the stop does, and it **rejects with a 409** if the run's worker has not finished writing in time - nothing is deleted in that case.
Callers must handle that rejection: `HistoryList` turns it into a toast telling the user to retry.
Settings' *Clear run history* does not loop over it: `apiService.clearRuns()` is one `DELETE /runs`, answering `{ deleted, keptPinned, deletedIds }`, and the engine's pass keeps what retention keeps - a pinned baseline and a run still running or pending (#2429).
A rejection is one failure toast and no tab is closed; the list is re-read either way, since batches the engine committed before failing are real.
Naming a run through `deleteRun` still deletes it pinned.
The wording of that toast is the caller's, keyed off `statusCode`, rather than the engine's message - which is a caller's choice now that `httpClient` reads the message on every error shape (issue #173), not a constraint.

**Captured response bodies are fetched separately, and lazily.**
A load run stores the response headers and body for its failures, its slow outliers and a few exemplars of each status code; `GET /runs/:id/report` deliberately does not carry them, because that endpoint loads and JSON-parses every result row for the run on each fetch and the dashboard polls it.
`useRunSamplesQuery(runId, enabled)` (`queries/runs.ts`) wraps `getRunSamples` and is enabled **only once a reader expands a sample** - passing `true` unconditionally would reintroduce exactly the cost the split exists to avoid.
It returns a `Map` keyed by `resultId`, joined against `report.results[].id`.

The history Samples tab consumes it (the dashboard shows the same tab for a finished run, #2220) and renders `CapturedResponseNotice` (truncated / dropped for budget / binary) and `CapturedDataWarning` (the run stored responses verbatim, including anything credential-shaped).
Both notices live in `components/shared`, beside the shell they annotate.

**A sample's `response.body` is text only when `response.bodyEncoding` is absent or `"utf8"`** (#3159).
A body that is not valid UTF-8, or holds a zero byte, comes as `"base64"` of the stored bytes, the spelling `/execute` and the inbox use, and `SampleRequestCard` reads it through `capturedBody` (`history/main/sample-body.ts`) into `decodeResponseBody` with the sample's headers:
a text type reads as text through its declared charset, any other type reaches the viewer as `rawBytes` and shows as binary rather than as base64.
A body marked base64 that does not decode draws a "Couldn't read the body" notice, and the headers stay.
This is separate from `binary: true`, which stores no bytes at all.

**A sample carries the response side only, so its request headers are the composed ones.**
`GET /runs/:id/samples` returns response headers and body; what a sample viewer shows for the request comes from the run's composed request, not from a sent record, because the load transport keeps none.
So a sampled capture can differ from the wire in the way the design-mode `sentHeaders` record exists to state (issue #664): the two headers the engine derives at send time - the body-implied `Content-Type` and the default `User-Agent` - do not appear, and a blank `Content-Type` or `Cookie` row is listed although neither is sent (any other blank row is sent empty, issue #3220, so it matches).
For load samples this is **recorded as permanent** (issue #677 item 7): which completions are sampled is decided when they finish, so a record for the few that are kept would have to be built for every transfer.
Design-mode traces store `sentHeaders` and do not diverge.

A sample whose transfer was a **stream** also carries `response.events` (issue #657) - `{items, totalEvents, eventsTruncated}`, parsed engine-side out of the stored `text/event-stream` body.
Both surfaces render it through the shared `ResponseEvents`, the component the request builder's Events tab uses, so a sampled stream reads the same way a sent one does.
Absent - not an empty node - for every sample that did not stream, which is what gates the tab.
