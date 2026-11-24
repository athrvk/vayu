---
description: >-
  How a single request and a load test travel from the user's click to the engine and back.
---

# Request Execution Flow

## Single Request Execution

1. **User Action**: Clicks "Send" in RequestBuilder
2. **Request Transformation**: Frontend format → backend format (raw - no client-side `{{variable}}` resolution), built by `buildComposeBody` (`modules/request-builder/utils/compose-body.ts`, issue #2638).
   It is the one writer of the inline compose body: Send, the streaming Send, the load run and the History replay all build through it, and so does the context bar's Code section for the editor's draft, so a field added there reaches every one of them
3. **Composition**: `apiService.composeRequest()` → `POST /compose` - the engine resolves `{{variables}}` and `inherit` auth against the request's `collectionId` chain and the active `environmentId`, and returns the execute-ready payload (issue #226), naming the `collectionId` whose chain it read (issue #3461)
4. **API Call**: `apiService.executeRequest()` with the composed payload, unchanged → `POST /execute`, carrying `stream: false` explicitly; the composed `collectionId` is how the engine's scripts read the same chain when no saved row is linked
5. **Response Transformation**: Backend format → frontend format
6. **Display**: Response shown in ResponseViewer

**`stream` is sent on every execute, never elided.**
It follows the same never-elide rule as `httpVersion` and the redirect policy, for a sharper reason: the endpoint's two answers are different *shapes*, so a caller that let an engine-side default decide would not know which one it was about to parse.

## Load Test Execution

1. **User Action**: Configures and starts load test
2. **Composition**: the request half goes raw through `apiService.composeRequest()` → `POST /compose`, built by the same `buildComposeBody` Send uses (plus `dataColumns` and `deferDynamicVariables`) - so a load test measures the same composed request Send sends
3. **Request Transformation**: composed request half + frontend `LoadTestConfig` → backend format
4. **API Call**: `apiService.startLoadTest()` → `POST /runs`
4. **Response**: `{ runId: "run_123", status: "running" }`
5. **Dashboard Initialization**: `useDashboardStore().startRun(runId)`
6. **SSE Connection**: `loadTestService.startMonitoring(runId)` connects to `/runs/:runId/live` (a module singleton, so the stream outlives the view)
7. **Metrics Streaming**: Real-time metrics update dashboard
8. **Completion**: When test completes, fetch final report via `GET /runs/:id/report`

**Example Load Test Request:**
```typescript
await apiService.startLoadTest({
  request: {
    method: "POST",
    url: "https://api.example.com/data",
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: { mode: "json", content: '{"key": "value"}' }
  },
  followRedirects: true,
  maxRedirects: 10,
  // timeout: 1500,  // only when the request states one; never sent as a copy of the setting
  httpVersion: "auto",
  verifySSL: true,
  mode: "constant_rps",
  duration: "30s",
  targetRps: 100,
  concurrency: 50,
  requestId: "req_123",
  environmentId: "env_456",
  comment: "Stress test",
  // Optional pass/fail budgets. Omitted entirely when none were declared - the
  // engine rejects an empty object rather than starting an unjudged run.
  thresholds: { latencyP99Ms: 50, maxErrorRatePct: 0.1 },
  // Optional data rows, bound one per request sent. Omitted when the dialog's
  // picker holds no file.
  data: [{ id: "1" }, { id: "2" }],
  // The file those rows came from: its name and the SHA-256 of its bytes,
  // never its path (issue #2051), and whether its numbers were read as
  // numbers (issue #2540). Undefined exactly when `data` is.
  dataFileName: "users.csv",
  dataFileHash: "<64 lowercase hex>",
  dataFileCastNumbers: false
});
```

**Streaming load runs.**
A load run of a request whose `stream` setting is on sends `stream: true` plus `maxStreamDurationMs` / `maxStreamEvents` (issue #576).
The split is deliberate: **whether** a request streams is read off the request, because that is a property of the request and lives on its Settings tab, while **how much of each stream this run measures** comes from the load dialog's two cap fields, which appear only for a streaming request.
The caps are always sent for such a run rather than elided as "the engine has defaults" - the engine's default is the user's `sseMaxStreamDurationMs` setting, which the dialog does not show, so eliding would leave the run bounded by a number the user was never told about while two others were on screen.

A collection run takes the caps without `stream` (issue #3235): the engine reads the flag off each stored request, so `RunCollectionDialog` sends top-level `maxStreamDurationMs` / `maxStreamEvents` (seconds converted to ms) only when a request it runs streams, for a design run and a load run alike, and never `stream`, which is a `400` there.

Under load a stream is bounded by construction, and **reaching a cap is a successful completion, not a timeout** - so a streaming run's clean error rate is not evidence the caps went unused.
The report answers that with a `stream` section (`RunReport.stream`): the per-completion event distribution, the totals, a derived `eventsPerSecond`, `capped` - how many streams a cap ended rather than the server - and `timeToFirstEvent` (issue #3234), the wait from submitting the request to each stream's first event.
That is not `phases.firstByte`, which ends at the response headers: a gateway that answers `200` at once and then thinks reads fast there and slow here.
It is absent when no stream delivered a timed event, and it stops at the first event of any kind, so an API that opens with a preamble event (Anthropic's `message_start`, an OpenAI role-only chunk) reads near zero on it.
`timeToFirstMatch` (issue #3774) is the same clock stopped at the request's first content marker, so that API's first token reads as its real wait; it is absent, never `0`, when no stream matched, and a request that declares no marker has none.
Two more optional blocks (issue #3776) say how each stream paced its events, each a `StreamDistribution` (`{p50, p95, p99, max, count}`) over the streams that had two timed events to measure between: `maxEventGap`, the largest pause between two consecutive events in a stream, in milliseconds, and `eventRate`, the stream's own events per second.
Each is absent, never `0`, when no stream measured it, and neither rides a live gate frame.
`StreamMetrics` (`modules/dashboard/components/charts`) renders them as a row each beside the first-event row, every row drawn only when its field is present, and says plainly when *every* stream was capped, because those counts then measure the caps rather than the target.
The section is `undefined` for a run that did not stream, which is not the same claim as a stream that delivered nothing, so a report without it renders exactly as it did before.

**Budgets and the verdict.**
`LoadTestConfig.thresholds` (`RunThresholds`) rides through to `POST /runs` under the engine's own camelCase metric names, and the report comes back with `thresholdValidation` - one check per budget plus a `verdict` of `"passed"` / `"failed"` - which `ThresholdVerdict` (`components/shared`) renders on the dashboard report and the history Overview.
It is the aggregate counterpart to `testValidation`: a `pm.test` script sees one response at a time and cannot assert a p99 or an error rate, so a run whose every assertion passed can still have missed its budget.
`undefined` is a run that declared none - not a run that passed nothing - so a report without the section renders exactly as it did before budgets existed.
The dialog seeds its p99 field from the client `sloThresholdMs` setting.
The live dashboard draws a run's `thresholds.latencyP99Ms` as its SLO line (`LoadTestRunConfig.latencyP99Ms`, set by the request builder, the collection runner and `loadConfigFromSnapshot`), and a run with no p99 budget draws none: the setting is never the line.
A Capacity discovery run does not send that seed (issue #2816): the engine judges `latencyP99Ms` on the run's pooled histogram, which holds every over-budget level the search climbed through on purpose, so `thresholds` omits it and a run with no other budget reads "No budgets set".
A streaming request does not send it either (issue #3772): a stream's latency is its whole duration, which the Dashboard threshold was never set against.
A p99 typed in the dialog, or carried from the last Start, is sent in every mode.

`LoadTestConfigDialog` also tells the engine which of those budgets the user did not set for this run (issue #2195):
top-level `carriedBudgets: string[]` on `POST /runs` (`StartLoadTestRequest`), the `thresholds` keys still holding a value the memo or the Settings p99 threshold seed filled in and the user left alone, spelled as they are in `thresholds` (`latencyP99Ms`, `custom.<name>.<stat>`; the threshold seed only outside Capacity discovery and a streaming request, which do not send it).
The engine only stores it and echoes it as `metadata.configuration.carriedBudgets`, which `ThresholdVerdict` reads to tag those rows "carried over"; the verdict itself is computed the same either way.
The list is cut at the engine's 64-entry cap (each key may be up to 512 bytes of UTF-8).
It is omitted when nothing was carried, and `RunCollectionDialog` and MCP never send it.

`maxAssertionFailureRatePct` (issue #1497) is the assertion budget.
It is judged against two populations kept apart (issue #2892), not `testValidation`'s per-response view: the **exact** tally of every `assert.*` element outcome, unmatched required `extract.*` and inline `pm.test` call, and the **sampled** `pm.test` replay over responses sampled at 1 in `response_sample_rate`.
`actual` is the worse of the two failure rates, so a sampled test failing half the time is not diluted by thousands of passing inline assertions.
An evaluated check carries both as `assertionsExact` / `assertionsSampled` (`{passed, failed}`) and, when the sampled one is non-empty, `sampleRate`; a report stored earlier has none of them.
`ThresholdVerdict` reads them to add one muted line under the row, "Judged on the worse of N assertions on every response (X failed) and M assertions on responses sampled at 1 in R (Y failed).", and shows nothing extra when the sampled population is empty (a collection run, a load run with no test script), when the check is unmeasurable, or on an older report.
`thresholds.failRun: true` (`LoadTestConfigDialog`'s own Switch, beside the budget fields rather than in `BUDGET_FIELDS` - it is a flag over the budgets, not one itself) changes what a missed budget *does*: the run's terminal status becomes `"failed"` instead of `"completed"`, so the history list and the taskbar failure cue pick it up, not only the verdict section.
A collection run's list row is marked failed by a missed budget with or without that flag (#3539): its `resultSummary.verdict` is what the row reads, and `ScenarioRunView` draws the `ThresholdVerdict` card that names the budget.

**A collection (design-mode) run is judged too** (issue #1564): `RunCollectionDialog`'s own Pass/fail budgets disclosure sends the identical `thresholds` block, top-level on the payload beside `failOnSchemaError` and `elements`, reusing `budgets.ts`'s field table and payload builder rather than a second copy.
It is **not** gated by the dialog's Load test switch - the engine evaluates `thresholds` for a design-mode run and a load run of the same folder alike - so the same `thresholdValidation` section and `ThresholdVerdict` rendering apply whichever executor ran the sequence: the history Overview for a load run, `ScenarioRunView` above its step list for a collection run.
See [POST /runs](../../engine/api-reference/load-runs.md#post-runs)'s thresholds section for how a collection run's error rate, latency percentiles and throughput are derived from the steps it actually sent.

**Stream budgets** (issue #3234): `streamTimeToFirstEventP95Ms` (a ceiling on `stream.timeToFirstEvent.p95`, ms) and `streamEventsPerSecondMin` (a floor on `stream.eventsPerSecond`), and the third below, judge the report's `stream` section, which only a streaming request's load run and a collection run with a streaming step (#3235, design or load) have.
On any other run the engine reports them not evaluated, and that counts as failed, so the dialog treats them as a property of the request: `BUDGET_FIELDS` marks them `streamOnly`, and `budgetFieldsFor(streaming)` is the one list the load dialog's fields, validation, closed-card summary and payload read.
A request that does not stream is offered neither, validates and sends neither (a value the global memo holds for them stays in the memo for the next streaming request, and is not named as carried over).
`RunCollectionDialog` reads the same list with `anyStreams`, whether a request the run sends streams, so it offers, checks and sends them only then.
A streaming request's latency budgets read on each stream's full duration, from sending the request to the stream closing, and the section says so under the p99 field.

`streamTimeToFirstMatchP95Ms` (issue #3774, "Time to first match p95 at most") is the third `streamOnly` budget, a ceiling on `stream.timeToFirstMatch.p95`: the first-token budget, since a budget on `timeToFirstEvent` passes whatever a preamble API's first token costs.
It is offered for any streaming request (the dialog does not read the request's marker), so its hint says the request must declare a first content marker; a run where no stream matched has no figure, and the engine reports the budget not evaluated, which counts as failed, never as a pass.
`StreamMetrics` draws the figure as a **first match** row, only when the report carries it; the live panel stays on the first event, because a live frame carries no match.

**`custom.<name>.<stat>` budgets** (issue #1579) are the only dynamic thing the block can carry: a ceiling on a value the run records itself through a `metric.record` element or a `pm.metrics` call, keyed by the name it was recorded under and one of `p50`, `p95`, `p99`, `max`, `value`, `rate`.
`RunThresholds` holds them as a *pattern* index signature (`` [key: `custom.${string}`]: number | undefined ``), so the fixed fields keep their own types and `failRun` keeps its `boolean`.
Both dialogs declare them as free-text rows (`CustomBudgetRows.tsx`) rather than as a picker of recorded names:
the engine checks the key's shape and the value's sign and does **not** cross-check the name against the run's own `metric.record` elements - an unmatched name is reported `evaluated: false` rather than refused - which is the call MCP's `thresholdsInput` already made for this family (`catchall`).
Like the fixed keys, these are **not** gated by `RunCollectionDialog`'s Load test switch either - `execute_scenario_run` evaluates a design-mode run's custom metrics against the same declared budgets a load run's are judged against.

The engine range-checks this payload before it creates the run row and answers a violation with `400 invalid_run_config` (accepted ranges are tabulated under [POST /runs](../../engine/api-reference/load-runs.md#post-runs)).
The renderer's own limits live in `LOAD_TEST_LIMITS` (`src/constants/load-test.ts`) and must stay at or inside the engine's.

### `success_sample_rate` is a period, not a percentage

The engine keeps a success trace when `counter % success_sample_rate == 0` - one in every N.
The dialog's control is a percentage, and the renderer converts between them with `successSamplePeriod` (`constants/load-test.ts`): 100% becomes a period of `1`, 1% becomes `100`, and the default 10% is the fixed point where the two units coincide.
Sending the percentage straight through, as the renderer did before, inverts the slider - "100% - everything" kept 1%.

A `0` is a division by zero engine-side, so the control's floor is 1%.
"Keep no success traces" is the **Save timing breakdown** toggle, which gates storage outright.

### Retry-After back-off is an opt-in run option

**Recording & limits** carries a **Wait out Retry-After** switch and, with it on, a **Longest Retry-After wait** field in ms (`#lt-retry-after`, `#lt-retry-after-max`; [#3782](https://github.com/athrvk/vayu/issues/3782)).
The dialog's `retryAfterBackoff` / `retryAfterMaxMs` keys are the engine's own camelCase spelling, so `buildLoadTestConfig` and the request builder pass them to `POST /runs` unchanged, and they are **absent** while the option is off: the engine's default is off, and the stored snapshot then says only what the run did.
A `constant_rps` run sends on a schedule and has no next request to hold back, so the controls are hidden in that mode (`appliesRetryAfter` in `profile.ts`) and the keys are not sent; the memo keeps the choice for the next closed-loop run.
The cap range, 1-3600000, is the engine's exactly (`load-test.engine-parity.test.ts`) and a value outside it blocks Start.
The run's `RunConfigSection` reads the snapshot back as a **Retry-After** row ("Waited, up to N ms"), shown only when the option was on.

`RunCollectionDialog` offers the same two controls once **Load test** is on (`#run-collection-retry-after`, `#run-collection-retry-after-max`; [#3799](https://github.com/athrvk/vayu/issues/3799)).
Both dialogs draw them from one component, `RetryAfterFields.tsx`, which owns the `appliesRetryAfter` guard and takes an `idPrefix` so the ids never collide.
The scenario's pair lives in its profile state (`ScenarioLoadProfile`), starting at `LOAD_TEST_DEFAULTS` on every open like the rest of that dialog, and `scenarioLoadFields` puts `retryAfterBackoff: true` and `retryAfterMaxMs` in the top-level payload only while the switch is on, so the dashboard's seed carries them and `RunConfigSection` shows the row for a collection run too.
The cap's range check is `retryAfterCapError` (`profile.ts`), shared by both dialogs' validation.
A design-mode collection run sends neither key.
MCP's `start_load_run` is the other writer.

### Dialog ceilings are a user setting

`LOAD_TEST_LIMITS` (`constants/load-test.ts`) holds the ranges the load dialog offers, and four of its ceilings are user-adjustable in **Settings → Load testing** (`loadTestCeilings` on `client-settings-store`).
The dialog reads them through `resolveLoadTestLimits`, never off the constant.

These are the app's policy and sit inside the engine's own bounds, which are crash guards rather than throttles: a run's `concurrency` becomes an *eager* per-worker curl-handle pre-allocation, so the engine caps it at 10x `event_loop::MAX_CONCURRENT`.
`LOAD_TEST_CEILING_BOUNDS` pins each settable ceiling at that guard, so no value on the settings screen can compose a run the engine rejects.
The floors are not settable at all - below them the values are not "small", they are unusable (a `concurrency` of 0, a sample period of 0).
