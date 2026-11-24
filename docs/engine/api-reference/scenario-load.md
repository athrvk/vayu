---
description: >-
  A scenario load run: a collection driven under load, its stages, outcomes and metrics.
---

# Scenario load runs

Adding a load **`mode`** beside the `scenario` block runs the same plan as a load test: `concurrency` virtual users, each walking the sequence on its own, closed-loop on the event loop.
The absence of `mode` is what still means a design-mode collection run, so a payload written before this existed keeps its meaning exactly.

```json
{ "mode": "constant_concurrency", "concurrency": 50, "duration": "60s",
  "scenario": { "source": "collection", "collectionId": "col_1" } }
```

| Field | Meaning here |
|-------|--------------|
| `concurrency` | **The number of virtual users** - what k6 and JMeter mean by it. Each holds its own position in the plan and its own cookies. |
| `duration` | Wall-clock length, for `constant_concurrency` and `ramp_up`. Virtual users keep starting iterations until it is up. |
| `iterations` (top level) | `mode: "iterations"` only: total passes over the plan across all virtual users. Distinct from `scenario.iterations`, which the design-mode runner reads. |
| `startConcurrency` / `rampUpDuration` | `ramp_up` only, as for a single-request run. |

**Rejected with a `400` (`error.code: "invalid_run_config"`)**, before any run row exists:

| Input | Rejected because |
|-------|------------------|
| `mode: "constant_rps"` with a `scenario` | An open-loop arrival rate over a multi-step sequence is an arrival-rate executor, which Vayu does not implement. Refused rather than silently run closed-loop. |
| `mode: "capacity"` with a `scenario` | The search judges one p99 per level and a sequence has one per step, so which of them the knee is measured against is a question the mode does not answer. |
| `rps` / `targetRps` above zero, on any mode | It is an open-loop arrival rate, and a scenario run is closed-loop by design: no scenario mode reads it, so it is refused rather than ignored. |
| An unknown `mode` | |

`maxInFlight` is **moot** and is ignored with a warning: in-flight requests are bounded by the virtual-user count by construction, so `concurrency` is the only knob.

**What differs from a design-mode collection run:**

- The run's `type` is **`load`**, not `scenario`.
  It publishes `metrics` ticks over `GET /runs/:runId/live` (not `step` events) and reports RPS and percentiles like any load run.
- **Cookies are per virtual user**, empty at the start of each iteration, and the environment jar is untouched.
  One session shared between 1,000 virtual users is not the thing being measured.
- **Variables are each step's own folder's** (#3248), as in a design-mode collection run: the environment and globals the run loaded, and the chain from the root collection down to the folder the step's request sits in, each entry as the run's `script.setup` scripts left it.
  All of it is read once, before the first request, so a recursive run sends a sub-folder's `{{name}}` with that folder's value whether or not the plan carries a script.
  A `script.setup` and `script.teardown` read and write the collection that declares them, from the same lifecycle set a design-mode run uses (#3456; see `lifecycle` under [`GET /runs/:runId/report`](runs.md#get-runsrunidreport)), so what a folder's setup writes reaches the steps in that folder and the folders below it.
  Nothing a load run's scripts write is saved.
- **The element pipeline runs here too, per virtual user (issue #1495).**
  `extract.*` and `assert.*` always run - before the send (`step.before`) and after the response (`step.after`).
  A `script.pre` / `script.post` element runs there only when its own `config.inline` is `true`, or the run's [`elements`](load-runs.md#the-elements-block-element-pipeline-override) override forces it; unmarked, a step's scripts still stay deferred, keyed per step, exactly as before this issue - see the next bullet.
  Each virtual user writes through its own overlay, never the run's shared scopes, so a name one user's step 1 writes (an `extract.json`'s target, an inline script's `pm.environment.set`) is visible only to that same user's later steps, never to another user's concurrent one.
  A collection write stays on the step's own folder (#3248): it answers that user's later steps in the folder and in folders below it, not a step in a sibling folder.
  Those saved names outlive the iteration that wrote them (#3044): a `control.once` login's extracted token still answers every later iteration of that user.
  An extractor's miss with no `default` unsets its name the same way (#3053): for that user alone, a value the run's stored scopes hold included, until the user sets it again.
  What resets at each iteration boundary is the user's cookies and its run-local scope (`pm.variables.set`); a bound data row's columns are the new row's.
  `pm.execution` still throws - a *script* cannot redirect the sequence under load.
  A **controller** element can (issue #1515): `control.if`, `control.once` and `control.throughput` skip a step the way `pm.execution.skipRequest()` would, counted in the run's summary `skipped` key rather than the `0` every scenario load run reported before this;
  `control.switch` and `control.loop` jump the plan (issue #1569), resolved the same way a script's own `setNextRequest` would be and guarded by the same `maxStepsPerIteration` cycle limit the sequential run uses.
  `control.throughput`'s `perUser: false` shares one budget across every virtual user instead of one per user, and `control.transaction`'s `includeTimers` folds a between-member `timer.*` wait into its reported sum - both issue #1569 too.
- **A script that did not run inline stays deferred, keyed per step.**
  After the run drains, that step's own post-request script is replayed against the responses that step produced, and the tallies appear on that step's entry in the breakdown as `tests` (see `scenario.steps` below).
  A step with several un-inlined, enabled `script.post` elements replays each one as its own script, in order, against every sample (issue #3125): a `const` one declares is not visible to the next, while a variable-scope write is.
  Their `pm.test` results add up, and an element that calls none and does not throw counts as one pass.
  An inline element runs in its own fresh context during the run; a disabled one never runs and tallies `skipped`.
  A step that carries no script, whose script ran inline this run, or whose script never got a sampled response, carries no `tests` object at all rather than a row of zeros.

  Sampling is keyed per step for the same reason: the run's `max_response_samples` budget is split evenly across the steps that carry a deferred script (floored at one apiece), so the last step of a forty-step plan is sampled instead of being crowded out by the first.
  The whole-run `testValidation` section still reports the aggregate - it says *something* failed, and the per-step `tests` say where.
- **Data rows are claimed from one shared cursor**, one per virtual-user iteration, wrapping when they run out - so two virtual users never *start* with the same row while unclaimed rows remain, which is what a credentials file is for.
  Once every row has been claimed the cursor wraps and rows are reused, concurrently: a 10-row file under 50 virtual users, or any duration-mode run past the row count, has several users on one row at a time.
  Size the file to the concurrency if the rows must stay exclusive.
  Every step of an iteration binds that iteration's row.
  `scenario.iterations` still has no meaning here: the run repeats until its duration is up, and the row count does not bound it.

  A `{{data.column}}` naming a column its bound row does not carry **fails that step**: nothing is sent, the step's `errors` count in the breakdown moves, and the run's error list carries an entry with `error_type: "data_binding_failed"` naming the token, the row and the row's columns.
  It is never substituted with an empty string.
  A `null` cell, two headers binding to one name, and a header name a row binds to nothing fail the same step the same way.

  Every retained result carries **`dataRowIndex`** on its `trace`, which is how a failure is attributed to a row when no per-step `results` rows exist.
  Absent for a run sent without `data`.
- **A step that got no response ends its iteration** (a transport error, or a step never sent) and its virtual user starts the next one.
  It is never stranded.
  So does a `control.switch` or `control.loop` jump the run cannot honour (a target no step answers to, or one past `maxStepsPerIteration`), as on a collection run, with the step that set it `errored` (#2974).
  A step that answered with an HTTP error status (4xx/5xx) counts in its `errors` but does **not** end the iteration: a response arrived, and the next step runs.
- **No per-step `results` rows are stored** - one row per step per iteration per virtual user is what a load run exists not to keep.
  The report's `scenario.steps` breakdown is the per-step record instead:

```json
"scenario": {
  "iterations": 480, "iterationsCompleted": 474, "iterationsAbandoned": 6,
  "stepsExecuted": 954, "passed": 906, "failed": 30, "errored": 6,
  "skipped": 12, "virtualUsers": 50,
  "passDuration": { "count": 474, "mean": 83.4, "min": 61.0, "p50": 80.2,
                    "p95": 104.7, "p99": 121.3, "max": 160.9 },
  "assertions": { "passed": 432, "failed": 30 },
  "steps": [
    { "index": 0, "name": "Log in", "requestId": "req_a", "method": "POST",
      "executed": 480, "errors": 6, "httpErrors": 0, "noResponse": 6,
      "unresolvedTokens": 0, "extractorMisses": 3,
      "latency": { "min": 1.2, "p50": 4.0, "p95": 9.1, "p99": 12.4, "max": 30.2 },
      "elements": [
        { "id": "el_1", "kind": "extract.json", "name": "Session token",
          "origin": { "kind": "request", "scope": "request", "id": "req_a", "name": "Log in" },
          "passed": 471, "failed": 0, "missing": 3, "error": 0, "skipped": 0, "deferred": 0 }
      ] },
    { "index": 1, "name": "Get me", "requestId": "req_b", "method": "GET",
      "executed": 462, "errors": 30, "httpErrors": 30, "noResponse": 0,
      "unresolvedTokens": 3,
      "preRequestScript": "skipped",
      "latency": { "min": 0.9, "p50": 3.1, "p95": 7.8, "p99": 10.0, "max": 22.5 },
      "elements": [
        { "id": "el_2", "kind": "control.if", "passed": 462, "failed": 0, "missing": 0, "error": 0, "skipped": 12, "deferred": 0 },
        { "id": "el_3", "kind": "assert.status", "passed": 432, "failed": 30, "missing": 0, "error": 0, "skipped": 0, "deferred": 0 }
      ],
      "tests": { "sampled": 20, "passed": 20, "failed": 0,
                 "console": [ { "level": "log", "text": "user 42 loaded" } ] } }
  ]
}
```

This run ended by its iteration count: 6 of its 480 iterations lost their login to no response and were abandoned there, and the other 474 completed.
`Get me` was reached 474 times; its `control.if` skipped 12 of them and 462 ran, 30 of those answered a status its `assert.status` rejected.
So `stepsExecuted` is 480 + 474 = 954, which is the 942 steps that ran plus the 12 skipped, and the four outcomes are 906 + 30 + 6 + 12 = 954.
Three of the 474 logins answered without a token: the extractor's miss unset `{{token}}`, so `Get me` sent it unresolved three times.

**`iterations` is the iterations started**, not the iterations asked for, and three counts account for them:
`iterationsCompleted` (the iteration reached its last step, or a script ended it with `setNextRequest(null)` or a forward jump), `iterationsAbandoned` (a step that got no response, or a jump the run could not honour, ended it) and the iterations still running when the deadline or a Stop ended the run.
The last has no key of its own; it is derivable:

- `iterations = iterationsCompleted + iterationsAbandoned + cut at the end`, so the iterations cut at the end are `iterations - iterationsCompleted - iterationsAbandoned`

That term is 0 for a run that ended by its iteration count, as the example above did (480 = 474 + 6 + 0), and positive for one a deadline or Stop ended mid-iteration: 1,150 started, 1,140 completed and none abandoned is 10 cut.
The app's Steps tab shows it as "Iterations cut short" beside the other two.

**`passDuration`** (#3570) is how long the completed passes took, `{count, mean, min, p50, p95, p99, max}` in milliseconds: one pass is a virtual user's wall clock from the claim of its first step to the completion of its last (that step's `step.after` elements included).
A timer wait between two steps of the pass is inside it (`timer.think`, a `timer.pacing` or `timer.throughput` hold on a later step), and so is everything the runner does between steps; the last step's own `step.between` wait and the next pass's start-of-pass pacing fall outside it, before the next pass's claim.
A `control.loop` jump back to the first step continues the pass rather than starting another.
Only completed passes are timed, so `count` is `iterationsCompleted`: an abandoned pass is `iterationsAbandoned` and no pass time, and a pass the deadline or a Stop cut is neither.
`mean` is the exact sum over the count; the percentiles come from one histogram kept to three significant figures, as a step's are.
A pass is held at the histogram's ceiling of one hour (`HISTOGRAM_MAX_LATENCY_US`) before it is recorded, and `mean` sums that held value too, so it never exceeds `max`.
**Absent** for a run in which no pass completed, for a design-mode run and for a run stored before the field existed.
On a single-request run an iteration is one request, so its pass time is the request latency and the report carries none.

One histogram is allocated per plan step at run start, which is the other thing `maxScenarioSteps` bounds.

A step's `errors` follows the run's one error definition (issue #2124): a status outside 2xx/3xx, or no response at all.
It is the sum of two disjoint counts.
**`httpErrors`** is the responses that arrived with a 4xx or 5xx; the step's latency includes them, and the iteration carries on to the next step.
**`noResponse`** is the executions that got nothing back (a transport error, booked under status 0 like the run's own distribution, or a data-binding failure that sent nothing); these end the iteration, as a jump the run could not honour does, and a refused jump is in neither count: it is an outcome (below), not a request error.
A `noResponse` execution whose transfer ran (a timeout, a reset, a DNS or TLS failure) is also in the step's latency, so a step that times out reports its timeout in `p99` and `max`; one that never reached the wire (a data-binding failure, a refused header, a skip) adds a count and no duration.
The step's histogram follows the same population as the run's, and `includeScriptTime` applies to a failed step as it does to an answered one (issue #2384), folding the same pipeline time into the run's latency as into the step's, so the run's `max` is never below a step's (#2792).

At the top of the section, `passed`, `failed`, `skipped` and `errored` are the collection run's outcomes (Outcomes under [Scenario runs](scenario-runs.md#scenario-runs), #2824), counted per step execution and disjoint.
A load run has no `stopped`: a step its Stop cancelled is in no count at all (#2136).
`errored` is an execution that got no response, one whose inline `script.pre` or `script.post` threw (a thrown error, a script timeout, a refused `pm.request` write-back, an inline `pm.execution` call; #2947), or one that set a jump the run could not honour (#2974).
A throw outranks a failed assertion and a skip, and a refused jump outranks every other outcome, as on a collection run.
The no-response kind and the refused jump end their iteration; a throw does not, and only drops the step's own jump, so a script bug changes the load the target receives only where the step that threw also asked to jump.
`errored` is therefore not the sum of every step's `noResponse`: the iteration-abort count is `iterationsAbandoned`.
`failed` is one whose response arrived and in which an inline assertion did not hold (an `assert.*` element, a required `extract.*` miss, an inline script's `pm.test`), counted once however many failed in it.
`skipped` is one a controller (`control.if`, `control.once`, `control.throughput`) stopped before the wire, and `passed` is the rest.
An HTTP error status no assertion rejected is `passed`: the step's `httpErrors` and the report's `summary.failedRequests` count it.
`stepsExecuted` is every step reached, a skipped one included, and a step's `executed` is every execution of it that was not `skipped` (a skipped one whose `script.pre` threw, or whose `control.loop` repeat was refused, is in it as `errored`, and adds nothing to `noResponse` or the latency), so two identities hold:

- `passed + failed + errored + skipped = stepsExecuted`
- the sum of `steps[].executed`, plus `skipped`, `= stepsExecuted`

A deferred script's tests replay after the run against sampled responses, so they fail and error no step here; they are the step's `tests` and the report's `testValidation`.
A run stored by engine 0.45.0 or earlier keeps the definition it was written under: `failed` was the sum of every step's `httpErrors`, and `passed` was `stepsExecuted` less `failed` and `errored`, its skipped steps included.
Nothing rewrites a stored run.

**`assertions`** (#2820) is the run's exact assertion population, `{ passed, failed }`: every `assert.*` outcome, every required `extract.*` miss and every inline script's `pm.test` call, counted on each completion.
It is the figure a `maxAssertionFailureRatePct` check reports as `assertionsExact`.
It counts assertions where `failed` above counts step executions, so an execution that failed three assertions is one `failed` step and three `assertions.failed`.
`summary.errorRate` stays HTTP-only: a run whose every assertion failed against `200`s reads an `errorRate` of 0, a non-zero `assertions.failed` and every asserting step `failed`.
The deferred replay of an un-inlined script is the sampled population (the step's `tests`, the report's `testValidation`) and is never in it.
**Absent**, never `{0, 0}`, for a run that made no such assertion, for a sequential collection run and for a run stored before the field existed.
The report's top-level `assertions` (#3537) carries it as `exact`, beside the sampled replay, the errored element executions and the failed teardowns.

`tests` is the step's *deferred* validation - a script that did not run inline this run - and is **absent** for a step whose script ran inline instead (its outcome is in `elements`), asserted nothing, or drew no sample - "no assertions" and "no failures" are different answers.
Beside its `sampled`/`passed`/`failed` it carries `console?` and `consoleDropped?` (#3127): what that step's replayed scripts logged, as `[{level, text, count?}]`, the first 10 distinct lines across the step's samples, each cut to 500 bytes, kept whatever the script's verdict and with `count` when it was logged more than once (absent means once), and how many occurrences a full list turned away.
The list is the step's own, so a line two steps both log appears under each; both keys are absent when the step's replay logged nothing (`consoleDropped` also when nothing was turned away).

`elements` (issue #1495) is the step's per-element tally, `{ id, kind, name?, origin?, required?, passed, failed, missing, error, skipped, deferred }` one entry per compiled element that ran at least once this run (an id a collection's element and the request's own share is two entries, each with its own counts and `origin`) -
**absent** for a step with no elements or none that ever ran, the same convention `tests` follows.
Each count is one outcome word of the sequential trace (#3051): `passed` is `ok`, and `failed`, `missing` (an extractor that found nothing, or a `metric.record` with nothing to read) and `error` (an element that could not run its check, a script that threw) are counted apart.
`name` is the element's own label and `origin` the level it was composed from, each present only when the element carries one; `required` is present, as `true`, only for an extractor whose config sets it, and it is what makes that element's `missing` a failed step.
`deferred` (issue #2144) counts a `script.post` element left to the replay above: it does run, later, and its assertions are the step's `tests`.
`skipped` counts every other `skipped` outcome: a disabled element, an un-inlined `script.pre` (no replay to go to), a controller's skip, an optional `extract.json` over a body it could not read, and an inline `script.*` the run's Stop cut short, its `pm.sendRequest` cancelled (#3371) or the script itself ended (#3460), whose tests and throw are then counted nowhere.

A `script.pre` or `script.post` that ran inline also says why it failed and what it logged (#3127), since a load run keeps no trace to read it from:

```json
{ "id": "el_4", "kind": "script.post", "passed": 0, "failed": 0, "missing": 0,
  "error": 480, "skipped": 0, "deferred": 0,
  "messages": [
    { "kind": "error", "text": "Error: boom", "count": 480 },
    { "kind": "test", "text": "status is 201: expected 200 to equal 201", "count": 480 }
  ],
  "console": [ { "level": "log", "text": "saw 200", "count": 470 },
    { "level": "warn", "text": "slow body" } ],
  "consoleDropped": 37 }
```

`messages` lists the errors the script threw (`kind: "error"`, a timeout included) and each failing `pm.test` as `name: message` (`kind: "test"`); `console` lists its console lines with their `level` (`log`, `info`, `warn`, `error`).
Each list holds the first 10 distinct entries the run produced, in the order first seen, however many executions repeated one, and each `text` is cut to 500 bytes on a character boundary, ending in `...[truncated]`.
An entry produced more than once carries `count`, how many times (the first included); `count` is **absent** on an entry produced once, so the common case and a row from an earlier engine read the same.
The two lists fill apart, so a script that logs on every iteration cannot crowd out why it failed.
`messagesDropped` / `consoleDropped` count the occurrences a full list turned away (a repeat of a dropped entry counted each time; a repeat of a kept one counts on that entry's `count` instead), so a list without its dropped count is the whole set of distinct entries.
Every one of the four keys is **absent** when it would be empty or 0, so a row from an earlier engine reads the same.
A single-request run's `summary.elements` rows carry the same keys.
The run export (`POST /export/run-report`) leaves all four out.

**`transactions`** (issue #1515), a sibling of `steps` rather than a member of it - a `control.transaction` spans a folder, not one step:

```json
"transactions": [
  { "name": "checkout", "count": 480, "errors": 0,
    "latency": { "min": 8.1, "p50": 14.2, "p90": 22.0, "p95": 26.5,
                 "p99": 33.0, "max": 55.4 } }
]
```

One entry per declared `control.transaction` name that closed at least once this run, allocated up front from a scan of the plan - never discovered mid-run - so recording into it, like every other controller here, takes no lock.
`count` and `errors` follow the collection run's rule (#3054): a pass closes when the virtual user's iteration leaves the folder, including an abandoned iteration, and errs when a member got no response, answered outside 2xx/3xx or failed an inline assertion.

`unresolvedTokens` (issue #1503) counts, per step, how many of its executions sent a `{{token}}` composition the residual-token pass still could not answer
- issue #1495 added a real resolution attempt here (against the executing virtual user's own scope overlay, see [`elements.md`](../elements.md#load-paths)), but the load path's rule is unchanged: never refused, only counted, so a name still unanswered (or a header-name collision the attempt itself produced) goes on the wire regardless.
`preRequestScript` is `"skipped"` for a step whose `script.pre` did not run inline this run and absent otherwise - a step whose `script.pre` did run inline reports its real outcome in `elements` instead, never both.
Neither `unresolvedTokens` nor `preRequestScript` ever fails the run by itself; both also feed the top-level `warnings` array ([Collection run verdicts](collection-runs.md), under `warnings`).
`extractorMisses` (#3053) counts the step's extractions that found nothing and so unset their variable, across every virtual user and iteration; it is absent at 0.
A miss is filed under its element's `missing` too (or `skipped`, for an optional `extract.json` that could not read the body), and a miss a `default` answered is neither: the rule is in [`elements.md`](../elements.md#kinds).

**Response:**
```json
{
  "runId": "run_1234567890",
  "status": "running"
}
```

**`tests`, `postRequestScript(s)` and `preRequestScript(s)` are refused outright** (`refuse_legacy_script_fields`), the same rule `POST /execute`, `PUT /requests/:id` and `PUT /collections/:id` apply (issue #1514) - a payload carrying any of the five names (a real value, not `null`) is a `400`, before the run row exists.
The name it points a caller at depends on the shape:
`requestElements` for a single target (this endpoint's own `elements` means the run-level override, not a script source, and pointing there would send a caller straight into a second refusal), plain `elements` for a scenario (its steps read theirs off the bound collection's stored elements, which no field on this payload can name more precisely).
A single target's own script slot is [`requestElements`](load-runs.md#the-requestelements-array-a-single-request-runs-own-step-level-elements) (issue #1594), the same way a scenario's steps read theirs off the plan's compiled elements.
A caller still sending `tests` gets the same refusal every other route already gives; MCP's `start_load_run` never sends it - it folds the agent-facing `postRequestScript` / `tests` argument into a `script.post` entry of `requestElements` client-side (see [mcp/request-composition.md](../mcp/request-composition.md#request-composition)).

**A `script.pre` element only reaches the wire when it is marked to.**
The ad-hoc `preRequestScript(s)` field itself is refused (see above, same as `tests`) - a pre-request script only ever rides as a stored `script.pre` element, on either run shape.
Unmarked (`config.inline` unset, no `elements.scripts: "allInline"` override), it never runs - there is no pre-request replay to defer it to, unlike `script.post` - so a request that signs itself in one is sent unsigned.
On the scenario shape this is reported, not silent (issue #1503): a step whose request carries an un-inlined pre-request script reports `preRequestScript: "skipped"` on its `scenario.steps` entry, and the run's `warnings` array carries one line naming how many steps did.
The single-target shape reports the same fact differently (see [`requestElements`](load-runs.md#the-requestelements-array-a-single-request-runs-own-step-level-elements)):
an un-inlined `script.pre` element's own entry in `summary["elements"]` counts every submission under `skipped` (never `deferred`, which is only for a `script.post` the replay runs) instead of a separate warning line.

**Accepted ranges.**
The numeric config is range-checked **before the run row is created**, so a rejected request leaves no `pending` row behind.
A violation is a `400` whose `error.code` is `invalid_run_config` rather than the per-status default, and whose message names the offending field and why the bound exists:

| Field | Accepted | Rejected because |
|-------|----------|------------------|
| `success_sample_rate` | `1`-`100000` | It is a sampling *period* (keep 1 in N), used as `counter % rate`. A `0` was a division by zero that killed the daemon mid-run. |
| `response_sample_rate` | `1`-`100000` | Same modulo, same crash. |
| `max_response_samples` | `0`-`1000000` | Each retained sample holds a full response body, and the vector is reserved up front; a negative value casts to ~1.8e19. |
| `max_response_sample_bytes` | `0`-`1073741824` | The whole-run budget for those bodies, held in memory for the run *and* its retention window. The count cap above bounds the store only for a target whose bodies are small - at 1 MiB each, 1000 samples is ~1 GB. `0` retains no sample that has a body. Defaults to the `maxResponseSampleBytes` setting. |
| `max_success_results` | `0`-`1000000` | Each retained record holds a serialised timing breakdown, and the store is reserved up front. `0` means unlimited. |
| `max_slow_results` | `0`-`1000000` | Same store, same reserve, separate budget. `0` means unlimited. It caps the slow traces kept, never the report's `slowRequests.count`, which counts every slow completion. |
| `slow_threshold_ms` | `0`-`86400000` ms | `0` disables outlier capture; a negative threshold would mark **every** completion an outlier and fill the slow store with the whole run. |
| `max_sample_body_bytes` | `0`-`104857600` | A captured body is copied on the completion callback, so the cap bounds hot-path work. `0` keeps headers and metadata and no body. Defaults to the `maxSampleBodyBytes` setting. |
| `max_sample_bytes` | `0`-`1073741824` | The whole-run capture budget; every byte under it is held in memory until the run flushes. Defaults to the `maxSampleBytes` setting. |
| `max_exemplar_results` | `0`-`100000` | Each retained exemplar holds a captured exchange. `0` means unlimited. |
| `phase_histograms` | boolean | Per-run override for the `phaseHistograms` setting. `false` skips the bank entirely: the run's report carries no `timingBreakdown.phases`, its `avg*Ms` fall back to the retained trace sample, and its live gate frames carry no `cumulativePhases`. |
| `save_timing_breakdown` | boolean | Read as a bool inside the run-context constructor, which threw on a string *after* the row was written - the same stranded-`pending` failure `duration` had. |
| `capture_response_bodies` | boolean | Same read, same constructor, same failure. |
| `concurrency` | `1`-`10000` | Connections are eagerly pre-allocated per worker before any traffic flows, so `-1` (a natural "unlimited" guess) allocated until malloc failed. |
| `startConcurrency` | `1`-`10000` | The ramp is seeded with this many in-flight requests before the first duration check, and it is read as a `size_t`, so a negative start is ~1.8e19 of them. |
| `maxInFlight` | `1`-`1000000` | It is a pending-request ceiling read as a `size_t`, so `-1` or `0` removes the backpressure the field exists to provide instead of tightening it, and an open-loop run against a slow target then accumulates in-flight requests for its whole duration. The ceiling is **not** the `concurrency` guard: that one bounds an eager per-worker connection pre-allocation, while this bounds a counter that pre-allocates nothing, and the engine's own default - `max(targetRps × 10, 1000)` - reaches 500,000 at the load dialog's 50k RPS maximum, so a lower bound would refuse ceilings the engine picks for itself. |
| `timeout` | `1`-`86400000` ms | A transfer that never times out never completes, leaving the run stuck `running` and unstoppable. Absent or `null`, the run uses the `defaultTimeout` setting, as [`POST /execute`](execute.md#post-execute) does (#2798). In a scenario run, sequential or load, it is what a step whose stored request states no `timeout` of its own sends with; a step that states one sends with its own (#2937), and fetches and refreshes its OAuth 2.0 token under it too. It also bounds the run's other OAuth 2.0 token fetches (the pre-flight's, and each step's at plan time and every mid-run refresh) and is the default timeout of a `pm.sendRequest` from any script of the run: a sequential run's step, setup and teardown scripts, and a load run's inline step scripts, `script.setup` / `script.teardown` and deferred `tests` script (#2833, #2841). Latency percentiles and `max` saturate at one hour (`3600000` ms): a longer completion is counted there, not dropped (#2790). |
| `duration` | string, positive, optional unit (`ms`\|`s`\|`m`\|`h`) | A JSON *number* threw out of the run-context constructor *after* the row was written, stranding it `pending` forever behind an opaque `500`. |
| `stepDuration` | string, positive, optional unit (`ms`\|`s`\|`m`\|`h`) | `capacity` only, and read by the same parser `duration` is - so it is gated by the same rule rather than by a second copy of it. |
| `rampUpDuration` | non-negative, optional unit (`ms`\|`s`\|`m`\|`h`); a JSON number is seconds; `0` is an instant ramp | Read by `ramp_up` only, but checked in every mode, like `duration`. It was not checked here at all, so `"10sec"` created a row that went `running` and then `failed`. Checked by asking the run-time reader itself, so it accepts exactly what the ramp will read - zero and a JSON number included, both of which `duration` refuses. |
| `iterations` | `1`-`2147483647` | An `iterations` run stops on its request count alone, read as a `size_t`, so `-1` was ~1.8e19 requests and a run that never ended until stopped. The ceiling is the one `scenario.iterations` has. |
| `rps` / `targetRps` | `0`-`1000000`, fractions allowed | The open-loop arrival rate per second; `0` asks for none. The ceiling is the highest RPS cap the app and MCP settings can be raised to. `constant_rps` needs one of the two positive, and every other mode refuses a positive one - see below. |
| `stream` | boolean | Accepted since streaming under load landed; read through the same parser `POST /execute` uses. A non-boolean is a `400` rather than a silent buffered run the caller would wait forever for. Refused on a collection run, either value: there a step streams when its stored request does (#3235). |
| `maxStreamDurationMs` | `1000`-`86400000` ms | Streaming only - refused without `stream` on a single-request run; on a collection run accepted alone and applied to the steps whose stored request streams. Defaults to the `sseMaxStreamDurationMs` setting. |
| `maxStreamEvents` | `1`-`10000000` | Streaming only - refused without `stream` on a single-request run; on a collection run accepted alone and applied to the steps whose stored request streams. Defaults to the `sseMaxStreamEvents` setting. |
| `streamTextPath` | string, in the JSONPath subset the elements read | Streaming only, by `POST /execute`'s rules: refused without `stream`, outside the subset, and on a collection run, whose steps each read their stored request's own (#3773). A by-id `POST /compose` carries the saved request's. |
| `streamFirstContentMarker` | string, `1`-`256` bytes, no NUL | Streaming only, by `POST /execute`'s rules: refused without `stream`, empty (it would match before any byte arrived), and on a collection run, whose steps are each timed to their stored request's own (#3774). A by-id `POST /compose` carries the saved request's. |
| `stream_metrics` | boolean | Whether the run feeds the per-completion event, time-to-first-event, largest-gap and event-rate histograms, and, on a single-request streaming run, its live event tally. `false` leaves the report's `stream` section out entirely rather than zeroing it, and the [live frames](live-metrics.md#get-runsrunidlive)' stream keys with it. Run-config only - there is no engine-wide setting beside it, because the cost is paid only by runs that stream. |
| `retryAfterBackoff` | boolean | Read as a bool inside the run-context constructor, the same stranded-`pending` failure `save_timing_breakdown` had. See [Retry-After back-off](load-runs.md#retry-after-back-off-retryafterbackoff). |
| `retryAfterMaxMs` | `1`-`3600000` ms | The longest one virtual user waits on a `Retry-After`. Past an hour it is waiting out a quota, not pacing against a limiter; `0` would be the option turned off said another way. Read only with `retryAfterBackoff` on. |
| `sloMs` | `1`-`60000` ms | `capacity` only. A non-positive budget has no edge to find, and one past a minute is longer than the transfers any realistic run measures. Matches the app's own clamp on the p99 threshold setting. |
| `carriedBudgets` | array of at most `64` strings, each at most `512` bytes of UTF-8 | Stored in the snapshot and echoed in every report, and nothing downstream reads the entries, so these bounds are the only ones the list gets. See [Carried-over budgets](load-runs.md#carried-over-budgets-carriedbudgets). |

An **absent** field, or an explicit `null`, is always accepted - every one of them has a default.
The route erases every top-level `null` before anything reads the config, so a `null` runs exactly as the absent key would and the stored config snapshot carries none (#1893), rather than passing this check and throwing in the run's own reader after the row existed.
The ceilings are crash guards, not policy: each client caps itself far lower (the load dialog offers `concurrency` &le; 1000; the MCP `start_load_run` tool has a user-settable cap in Settings).

**The defaults** an absent field takes are the `run_config::DEFAULT_*` constants in `engine/include/vayu/core/constants.hpp`: `duration` 60 s for a constant or ramp-up run, `concurrency` 100 for a constant or ramp-up run and 10 for an `iterations` run, `iterations` 1000, `rampUpDuration` 10 s, `startConcurrency` 1.
A `capacity` run's `duration` defaults to its own 300 s search deadline instead.
`timeout` is the exception: it defaults to the `defaultTimeout` setting (30 s unless changed in Settings), read when the run starts, for a single-request and a scenario run alike.
A scenario step's own stored `timeout` (#2937) wins over both for that step's transfers.
A `pm.sendRequest` keeps the run-level value, except from a sequential run's step scripts, which take their step's timeout as a Send's scripts take the Send's.
None of them is written to the stored snapshot; only what the body carried is, so a replayed snapshot that carried no `timeout` takes the setting in force at its own start.

**A rate belongs to `constant_rps`, in both directions.**
Both checks sit in `validate_run_config` (`check_constant_rps_rate` and `check_rate_only_on_constant_rps`, `routes/execution.cpp`) and answer a `400` with `error.code` `invalid_run_config`; `rps` is read first, and `targetRps` when `rps` is absent or `0`.

- A `mode` of `constant_rps` with neither field positive is refused.
  Accepting it would run the closed-loop path at the default concurrency while the stored config and the report still said `constant_rps` (#1893).
- Any other `mode` with either field positive is refused, naming the field and the mode (#2396).
  Accepting a rate there would switch `constant_concurrency` to open loop and give every other mode's event-loop workers a token bucket of `rate ÷ workers`, so a ramp would report its own throttle as latency while the config and the report still named the declared mode.
  An unrecognised `mode` is held to this too.
  `0` asks for no rate and is accepted on every mode.
- A body with **no `mode`** is `constant_rps`, as the executor reads it: it may carry a rate, which paces it open-loop, and without one it holds `concurrency` in flight closed-loop, as it always has.

The executor chooses by mode as well (`open_loop_rate` in `load_strategy.hpp`): a rate that reaches a closed-loop mode without passing this route, in a stored config, does not open the loop.
No mode throttles the event loop's workers with a rate of their own: a `constant_rps` run is paced by its pacing thread alone (#2801).

One field is rejected by **presence**, not by range: **`transient`**.
It is `POST /execute`'s no-run-row flag (issue #382) and has no meaning here, because a load or scenario run *is* the row it creates - the run id is what this endpoint returns, and the live stream, the report and the scenario step store are all keyed by it.
Ignoring the flag would leave a caller believing the run left nothing behind while it wrote the largest trace the store holds, so a present `transient` (`true` **or** `false`) is a `400` with `error.code` `invalid_run_config`.
An explicit `null` is absent, as everywhere else here.

The sample rates are additionally clamped to &ge; 1 inside the metrics collector, so the modulo cannot divide by zero even for a caller that bypasses this route.

**What a run stores, and for how long.**
A completed request is recorded in the aggregate counters always; whether its *detail* survives is decided by three independent budgets:

| Budget | Filled by | Bounded by |
|--------|-----------|------------|
| Sampled timing traces | 1 in `success_sample_rate` completions, only while `save_timing_breakdown` is on | `max_success_results` |
| Slow-request traces | any completion at or past `slow_threshold_ms`, **regardless** of `save_timing_breakdown` | `max_slow_results` (the traces only: the slow *count* is an aggregate counter) |
| Response samples (post-run test scripts) | 1 in `response_sample_rate` completions | `max_response_samples`, **and** `max_response_sample_bytes` |
| Per-status exemplars (captured responses) | the first three completions of each distinct status code **that no other budget already stored** | `max_exemplar_results` |

None of these budgets bound the report's `timingBreakdown.phases`: the per-phase histograms are fed by every completion and hold counts rather than records, so the phase distribution, and the `avg*` fields read from its means, are the whole population no matter how hard the stores above thin.
Only a run without the bank falls back to averaging the sampled subset.

Two properties are worth relying on.
An outlier **never consumes a sampling slot**: a run whose target degrades does not silently stop sampling ordinary traffic because everything became slow.
And each store is a **reservoir** - past its bound a later record displaces a uniformly chosen incumbent instead of being refused - so what a long run retains describes the whole run rather than its first few seconds, and `sampling` in [the report](runs.md#get-runsrunidreport) says how many records that thinning cost.

The exemplar budget is the one exception to the reservoir rule, and deliberately so: an exemplar that gets displaced is not an exemplar, so past its bound a later candidate is refused and counted rather than evicting an incumbent.

It is also the **last** budget consulted, not the first.
A completion that is already an outlier stays charged to the slow budget and a sampled one stays charged to the sampling budget - claiming an exemplar never moves a record out of the store that wanted it, because the first few completions of a status code are often exactly where a run's outliers are.
What the exemplar claim decides is whether the response **body** is captured, which is independent of which budget pays: a completion that is both sampled and a claimed exemplar is stored in the sampling budget *and* keeps its body.

**Response capture.**
`capture_response_bodies` (boolean, default `true`) decides whether the retained samples carry their response headers and body.
On by default is only defensible because capture is failure-and-outlier-shaped rather than uniform - errors, slow outliers and the per-status exemplars, never the 1-in-N slice - so a healthy run captures a handful of exchanges.
Set it to `false` and the collector is byte-for-byte what it was before capture existed: no gate is consulted, no exemplar is claimed, nothing is copied, and no rows are written.
What is captured is read back with [GET /runs/:runId/samples](runs.md#get-runsrunidsamples) and described in [`result_bodies`](../db-schema.md#result_bodies).

**Shutdown refuses new runs.**
Once the daemon has begun draining its run workers, `POST /runs` answers `503` with the message `Engine is shutting down` rather than accepting a run nothing will ever execute.
The window is small - the HTTP server stops before the drain begins - but it is not empty, and a request already in a handler when the drain starts must not be able to spawn a worker past it (see `RunManager::shutdown`).
The row the route had already written is marked `failed` first, and so is the row of a run that throws while starting (answered `500`, naming the error): no answer but a `202` leaves a `pending` row behind (#1893).

**A run row the database cannot write is a `500`.**
A busy or locked database, a full disk or an I/O error while recording the run is the engine's failure, not the payload's, so `POST /runs` answers `500` `Couldn't create the run record`.
The app retries a `5xx` and treats a `4xx` as a verdict, so a momentary lock no longer reads as a refused request (#2319).

**Auth pre-flight.**
When `auth.mode` is `oauth2`, the run route resolves the token **before** creating the run and warms the cache for the workers.
An unauthorizable config is rejected up front with `409` (interactive sign-in required) or `400`, carrying the `/oauth2` error codes and, when the token endpoint answered,
its reply inside the error object as [`POST /oauth2/token`](authentication.md#post-oauth2token) carries it (`providerStatus`, `providerError`, `providerErrorDescription`, #3201), so a bad token never surfaces as a silently-failed run.
A load run acquires once, before any script, from the stored values (a script that sets an OAuth 2.0 variable has no effect under load, and nothing is re-acquired per iteration),
so an `oauth2` config still holding a `{{name}}` when the run starts (one that nothing defines, or one posted without being composed for a run with `deferDynamicVariables`) is a `400` `invalid_run_config` naming it (a collection load run's step is `invalid_scenario`, see [Scenario runs](scenario-runs.md#scenario-runs));
and a [`targetPolicy`](execute.md#post-execute) that refuses the config's token endpoint is a `400` under the policy's code, before anything is posted.

**Concurrency model.**
`constant_concurrency`, `ramp_up`, and `iterations` are **closed-loop**: the engine holds in-flight requests at a target (`concurrency`, or the ramp curve from `startConcurrency` to `concurrency`) - when a request completes, another is issued.
Throughput is a *result* (`concurrency ÷ latency`), not an input.
`constant_rps` is **open-loop**: it dispatches at `targetRps` regardless of how fast responses return.
The mode chooses the loop; a rate is `constant_rps`'s field alone (see above).

**`maxInFlight`.**
A hard cap on concurrent in-flight requests.
It applies **only to `constant_rps`** (the open-loop rate mode), where it bounds how many requests may be outstanding before the engine drops new ones; default ≈ `max(targetRps × 10, 1000)`, accepted range `1`-`1000000`.
That range holds the default formula across the whole advertised RPS span (50k RPS → 500,000), which is why it is not the `concurrency` guard - a ceiling of 10,000 would reject explicitly what the engine already does implicitly.
For the closed-loop modes the `concurrency` target *is* the in-flight bound, so `maxInFlight` is ignored there.
It is not what bounds a catch-up burst: when the pacing thread stalls (a host sleep, a blocked thread), its next tick sends what the schedule owed up to **100 ms past the instant the tick was due** (`MAX_CATCH_UP_BACKLOG`, `core/load_pacing.hpp`) and skips the rest (#2911).
Skipped requests are never sent and are counted as `skippedRequests`, apart from the `maxInFlight` drops, with `stalledMs` the schedule time they cover (`skippedRequests ÷ targetRps`).
What the tick does send still passes the `maxInFlight` headroom, and nothing meters it per worker (#2801).
Ordinary timer jitter is far inside the window and is caught up in full at any rate.

**Durations.**
`duration` and `rampUpDuration` take a string holding a number with an optional unit: **`ms`, `s`, `m`, `h`**, matched as a whole suffix (`"500ms"` is half a second, not 500 minutes); `rampUpDuration` also takes a JSON number of seconds.
A bare number is seconds - `"60"` == `"60s"` - which is also how the MCP duration cap reads the field.
Fractions are allowed (`"1.5s"`), case and spacing are ignored (`"30 S"`).
A value the engine cannot read - an unknown unit, a non-number, a negative - is a `400` with `error.code` `invalid_run_config` naming the field, before the run row exists, rather than being silently replaced by the default (see Accepted ranges above).

**`constant_rps` is time-bound, and its shortfall is recorded.**
Request *k* (counting from 1) is owed at `k / targetRps`, so nothing leaves at t = 0 and, when `targetRps × duration` is whole, the last request is owed at the deadline itself.
Each tick submits `floor(targetRps × elapsed since the start)` minus what it has already taken, so a rate above 1000 is delivered as asked rather than floored to a multiple of 1000, and a late tick owes what the ticks it swallowed would have, sending up to the catch-up window above and skipping the older backlog (`skippedRequests`).
Requests that come due while in-flight is at `maxInFlight` are **dropped at that instant**, not deferred: the run ends at its wall-clock `duration`, and `droppedRequests` (in the run summary and per-tick metrics) carries what the rate owed but could not issue.
`sent + skipped + dropped` is therefore exactly `floor(targetRps × duration)`, the run's `requestsExpected` (200 req/s for 20 s: 4000; 33.3 req/s for 3 s: 99), for a run that reaches its deadline.
A product that is whole in decimal is read as whole even where binary lands just below it (0.57 req/s for 100 s owes 57).

**Capacity semantics.**
`capacity` is the one mode whose target is not a function of elapsed time.
It holds `startConcurrency` for `stepDuration`, judges the level, and then steps up by 25% (at least +1) while the level stayed inside its budget.
A level's `p99_ms` is the percentile of every completion at the level after its first three live ticks, which measure the transition to the new target, read from one histogram; it is not a mean of 100 ms window percentiles, which a level with a periodic pause would pass.
Its `rps` is the mean throughput over the same ticks, and its `error_pct` the share of the requests completed over them that were errors, by the one definition every surface reports (a status outside 2xx/3xx, or no response; a Stop-cancelled request is neither).
Its `samples` is the count of completions that histogram held; a level of only refused connections is judged on its errors with `samples` 0 and a `p99_ms` that measured nothing.
A level **breaches** when its p99 exceeds `sloMs` *or* its error share exceeds 1% (`constants::capacity::ERROR_RATE_PCT`, no run-config knob): a target answering fast 503s is not sustaining the level.
The search stops - and names the reason in the report - after **two consecutive** breaching judged levels (one breaching measurement re-measures the same level rather than ending the search): `slo_exceeded` when the last one's p99 is over `sloMs`, `errors_exceeded` when its p99 is inside `sloMs` and only its error share is over the limit.
It also stops when two step-ups buy under 5% more throughput (`plateau`; the report then names the level where throughput stopped growing as `saturation*`, which is lower than `maxHealthy*`, the last level tried), when `concurrency` is reached (`cap_reached`), when `duration` runs out (`deadline`), or when the operator stops the run before the search has ended (`stopped`);
a Stop that arrives only after the search ended on its own leaves the reason it had (issue #3341).

An **omitted `duration`** on a capacity run defaults to **5 minutes**, not the 60 seconds every other mode falls back to: this mode walks a level every `stepDuration`, so a minute is a dozen levels and a search that almost always ends `deadline` rather than finding anything.
Any client enforcing its own duration ceiling has to account for that per-mode default rather than assuming one number - the MCP tool's cap does.

The search steers by what the metrics thread publishes each live tick rather than sampling the collector itself, so it takes nothing away from what `GET /runs/:id/live` streams.
A level in which no request was timed (`latencySamples` `0`, percentiles `null` on the frame) and no error was counted is not judged and stays open: reading it as "answered instantly" would climb straight past the limit.
A request that timed out is timed (see [Latency population](metrics.md#latency-population)), so a level of nothing but timeouts has samples, is judged, and reports a p99 near the timeout - the level fails its latency limit, which is the right verdict.
A refused connection records no latency but is counted, so a level of nothing but refusals is judged too, at a p99 of 0 and an error share of 100%, and fails its error limit.
A level is also not judged until it has counted at least one completion: the error share is read from status counts that can trail the latency samples by a tick, and judging before they arrive would read a failing level as error-free.
`capacity` is rejected on a **scenario** run with a `400`: the search judges one p99 per level and a sequence has one per step.

**Ramp semantics.**
`ramp_up` interpolates linearly from `startConcurrency` to `concurrency` over `rampUpDuration`, then holds `concurrency` for the rest of `duration`.
A `startConcurrency` **above** `concurrency` is a valid descending ramp.
If `duration` is shorter than `rampUpDuration`, the run stops partway up (or down) the curve.
A run whose `duration` equals `rampUpDuration` reaches `concurrency` at the end of the ramp, with no hold after it: when the run's time is up, the controller refills once more to the target its last instant is owed, so the peak does not depend on when it last woke (#2913).
That refill sends only what the last target it refilled toward was below the end target: it does not replace requests that completed after the run's time was up, so a run already at its end target (a flat ramp, a ramp shorter than `duration`, a descending ramp) sends nothing once `duration` has passed (#3545).

**Response bodies are capped.**
A load-run request reads at most `maxResponseBodyBytes` (Settings → Data & retention, default 32MB) into memory.
Every in-flight request holds its own body, so an uncapped one multiplies by concurrency; a response past the cap **fails that request** rather than being buffered.
It is reported like any other transport failure - `statusCode: 0` with an `errorCode` of `INTERNAL_ERROR` and a message naming `maxResponseBodyBytes` - and the truncated prefix is kept as the body.
Design mode (`POST /execute`, and each step of a collection run) has **its own cap and its own answer**: `maxDesignResponseBodyBytes`, also 32MB, reached by a send that keeps what it read and reports `bodyCapped: true` on an otherwise ordinary response.
It sends one request at a time, so the concurrency argument above does not apply to it - what does is that the body crosses to the app and is held there as well, and that failing a response the user asked to see would be the wrong trade where showing them the first 32MB of it is not.
Neither setting reads the other: raising the load cap does not change what a Send reads.

A **script's own fetch** (`pm.sendRequest`) is a third read, and it takes the bound of the path it runs on: the design bound in a Send's or a collection step's scripts, the load bound in a load run's deferred `tests` script, which runs once per sampled response.
It refuses at that bound rather than keeping a prefix, on either path, because nothing on the object it hands the script could say the body was cut - see [scripting](../scripting/send-request.md#sending-a-request-from-a-script-pmsendrequest).

**Wire method and body.**
A body is sent with whatever method the request names: a `GET` carrying one stays a `GET` on the wire (Elasticsearch-style search bodies work), not a `POST`.
The one combination that cannot be sent is **`HEAD` with a body** - curl's `HEAD` support drops the body - so it is refused rather than silently changed: `statusCode: 0`, `errorCode: INVALID_METHOD`, and a message saying so.
This holds identically for `POST /execute` and `POST /runs`.

**Failed requests still report timing.**
A transfer that fails (timeout, connection refused, capped body) carries whatever curl measured before it failed - `wireMs`, the phase breakdown, and `bytes`/throughput counts - instead of reporting zeros.
No phase (`dnsMs`, `connectMs`, `tlsMs`, `firstByteMs`, `downloadMs`) is ever negative: `tlsMs` is `0` for plain HTTP and for a reused keep-alive connection rather than a negative value.
