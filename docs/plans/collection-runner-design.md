# Collection Runner / Scenario Primitive - Design

**Status:** approved design, not yet implemented.
**Tracks:** issue #340. Flow control (`pm.execution`, `pm.iterationData`) is #303.
**Anchors verified at master `d5899bb` (2026-08-07).**

Vayu's product target is the Postman + JMeter + k6 combination. The single
largest capability gap against that target, on both halves at once, is an
engine-side **ordered-sequence primitive**: Postman's collection run, and the
multi-step sequence a k6 virtual user repeats. This document is the design
decision for that primitive, made once, before any code.

Every section below states a **decision** and the alternative it declines. Where
a decision constrains something that is not being built yet - load-mode
scenarios, stored scenario entities - it says so explicitly, because the point of
designing first is that mode 1 must not be built in a way mode 2 has to undo.

---

## 1. Why Vayu has nothing today

Two things look like runners and are not:

- **`run_collection_smoke`** is a **client-side TypeScript loop** over
  independent `POST /execute` calls (the smoke handler in
  `app/electron/mcp/tools.ts`; composition described at `docs/engine/mcp.md`).
  The engine sees N unrelated design-mode executes and holds no object that
  contains them, so a script running inside execute #3 has nothing to say about
  execute #4 and nowhere to put the instruction.
- **Load runs repeat a single composed request**
  (`engine/src/core/run_manager.cpp`, `execute_load_test`). Test scripts there
  run **deferred, once per sampled response, after the run finishes**
  (`validate_scripts`, `run_manager.cpp:55`, called at `:747`), so even the
  ordering that exists is not something a script participates in.

So "log in, then browse, then check out" - the workflow that makes a collection
more than a folder tree, and the unit a serious load evaluation reaches for
first - cannot be expressed at all.

---

## 2. The sequence model

### Decision 2.1 - a scenario is a folder-derived ordered sequence, resolved once into an immutable plan

A **scenario** is not a new stored entity. It is a *resolution* of an existing
one: a collection (folder), its direct requests ordered by `requests.order`,
optionally including descendant collections ordered by `collections.order`,
depth-first.

At run start the engine resolves that into a **`ScenarioPlan`**: an ordered,
immutable vector of **fully composed steps**. Each step is the exact payload
`POST /execute` accepts - `{{variables}}` substituted, `inherit` auth walked and
applied, the ordered script-part lists from the collection chain plus the
request's own - produced by the composition the engine already owns
(`compose_request_core`, `engine/src/http/request_composer.cpp:454`).

```
ScenarioStep {
  index          size_t          // position in the plan, stable for the run
  request_id     string          // the stored request this came from
  name           string          // requests.name, the setNextRequest target
  request        vayu::Request   // composed, execute-ready
  pre_script     string          // joined parts (script_parts.cpp::read_script)
  post_script    string          // joined parts
}
ScenarioPlan { vector<ScenarioStep> steps; ... }
```

**Why folder-derived rather than a `scenarios` table.** The collection tree with
its `order` columns *already is* an ordered sequence. A parallel `scenarios`
table would be a second source of truth for that ordering, needing its own
answer to "a request in this scenario was deleted" and its own reconciliation on
every collection edit. This repo's most repeated defect is state one layer
records and another re-derives; a scenario entity in v1 would be exactly that,
bought before anyone has asked for the thing it enables.

**Declined: a first-class `scenarios` table (v1).** It becomes necessary the
moment a user wants a sequence that is *not* a folder - steps drawn from several
folders, one request appearing twice, a step disabled for one scenario but not
another. The design must not preclude it, and does not: the run payload carries
a `source` discriminator, and plan resolution is the seam.

```jsonc
"scenario": {
  "source": "collection",          // the only value in v1
  "collectionId": "col_...",
  "recursive": false,              // descend into sub-collections
  "iterations": 1,
  "data": [ { "user": "a" }, ... ] // optional; see 2.3
}
```

A future stored scenario is `{"source": "stored", "scenarioId": "scn_..."}` and
resolves to the same `ScenarioPlan`. Nothing downstream of resolution changes.

### Decision 2.2 - the plan is resolved exactly once, before the first send

No step is composed lazily, and no execution path touches SQLite for request
data after resolution. Two reasons, and the second is the load-bearing one:

- A collection edited mid-run would otherwise change the sequence underneath
  itself. A run is a record of what ran; it must be resolvable to one answer.
- **Load mode cannot query SQLite per step per virtual user.** The plan being
  fully composed up front is what makes decision 5 possible at all. Resolving
  lazily in mode 1 would be a stopgap mode 2 has to undo.

Resolution failures are loud and pre-run: an empty collection, a step whose
composition fails, a plan exceeding `maxScenarioSteps` - all `400` with the
offending request named, before any `runs` row exists. This matches the existing
`POST /runs` discipline, where `validate_run_config` and
`normalize_run_http_version` both run before `create_run`
(`engine/src/http/routes/execution.cpp`).

### Decision 2.3 - an iteration is one full pass over the plan; data rows come in on the payload

`iterations` (default `1`) is how many times the plan is executed end to end.

`data` is an **inline JSON array of objects** on the run payload. Row `i % rows`
binds to iteration `i` as `pm.iterationData`. When `data` is present and
`iterations` is absent, `iterations` defaults to the row count - the Postman
default. When both are given, the explicit count wins and the row index wraps;
the wrap is **not silent**, because every per-iteration record carries its
`dataRowIndex` and `pm.info.iteration`. An empty `data` array is a `400`: a data
set that binds nothing is a mistake, not an empty run.

**Declined: the engine reading a data file from disk.** The script sandbox has
no filesystem access by design, and giving the daemon a user-supplied path is a
new trust boundary (traversal, arbitrary reads) bought for a parsing job the app
already does well - it owns the Postman/Insomnia/OpenAPI import parsers. The app
picks the file, parses CSV/JSON, and sends rows. The cost is payload size, which
is why `maxScenarioDataRows` and a payload byte cap exist (5.4).

---

## 3. The execution model - design mode

### Decision 3.1 - a scenario run is a third `runs.type`, not a design run

`runs.type` gains `"scenario"` beside `"design"` and `"load"`.

It cannot reuse `"design"`: **a design run has exactly one `results` row**, and
`GET /runs/:runId` serves it as `result` on that assumption
(`docs/engine/db-schema.md`, `results`). A scenario run has one row per step
execution. Overloading `design` would break a documented reader - the exact
"written but never read" inverse this repo keeps finding.

### Decision 3.2 - asynchronous, run-record-backed, SSE-streamed - same lifecycle as a load run

`POST /runs` accepts a `scenario` block and answers `202 { runId }`, exactly as a
load run does. The run gets a worker thread from `RunManager::start_run`, is
registered/retained/swept by the existing machinery, streams over
`GET /runs/:runId/live`, stops through the existing stop path, and reports
through `GET /runs/:runId/report`.

**Declined: a synchronous `POST /scenarios/run`.** A 50-request folder takes as
long as its requests added together - `run_collection_smoke`'s own description
says so - and holding a cpp-httplib worker thread for minutes is not viable. A
second async endpoint would need its own copy of stop, retention, SSE resume and
the `DELETE /runs/:id` cascade; there is no second lifecycle here, only a second
executor.

The live stream gains a `step` event beside `metrics`, carrying
`{iteration, stepIndex, name, outcome, statusCode, latencyMs}`. It rides the
existing bounded tick ring (`RunContext::append_tick`) and its monotonic
`id:` numbering, so `Last-Event-ID` resume works unchanged.

### Decision 3.3 - steps execute sequentially through `http::Client`, not the event loop

The design-mode runner is, per iteration, per step:

```
compose (already done at plan time)
  -> pre-request script   (ScriptContext::for_prerequest, pm.request writes back)
  -> Client::send         (through the environment cookie jar)
  -> post-request script  (ScriptContext::for_test)
  -> record step result
  -> apply flow control   (section 4)
```

That is the `POST /execute` handler's body, lifted. It must be `http::Client`
and not `EventLoop`, because design-mode fidelity needs the cookie jar and
inline per-step scripts, and the event loop deliberately has neither ("Not on
the load path", `engine/include/vayu/http/cookie_jar.hpp`).

**This is the point where the two modes diverge, and the divergence is the
design.** The *plan* is shared; the *executor* is not. Section 5 specifies mode
2's executor against the same plan.

### Decision 3.4 - state flows between steps through the scopes that already exist

- **Variables.** The environment / globals / collection scopes are loaded once
  at run start (`load_script_variable_scopes`), mutated in memory by every
  step's scripts across every iteration, and persisted **once at run end**
  through the existing diff-based `persist_script_variables`. This is what makes
  "step 1 logs in and `pm.environment.set`s the token, step 2 sends it" work.
  Persisting per step would be N x M diff-and-write cycles against the DB mutex
  for a value only the run's own later steps read.
- **Cookies.** The existing per-environment jar, scope = `environmentId`,
  unchanged. It was already scoped this way partly for this feature, and it
  already gives "log in once, reuse the session" for free.
- **Nothing else.** There is no scenario-scoped variable bag. A fourth scope
  would need precedence rules, a persistence story and a UI, to hold what the
  environment scope already holds for the run's lifetime.

### Decision 3.5 - `pm.info` gains `iteration` / `iterationCount`, set only by the runner

`ScriptContext` gains two optional fields. The scenario runner sets them; every
other caller leaves them unset and they reach the script as `undefined`.

This does **not** reopen #300. That issue's ruling stands verbatim: a load run's
`tests` script runs once per *sampled* response, and a reservoir sample index
reported as an iteration number would be a binding that cannot fail. A scenario
run has a real iteration index, so it reports one; `validate_scripts` still
sets neither. The `ScriptContext` comment recording #300's rationale is kept and
extended rather than replaced.

### Decision 3.6 - one `results` row per step execution, bounded

Each step execution writes a `results` row with the design-mode `trace_data`
subset (the one `restore-response.ts` already restores from), plus
`iteration`, `stepIndex`, `stepName`, `requestId`, `outcome`.

Bodies are capped by the existing `maxTraceBodyBytes`. The **row count** is
bounded by a new `maxScenarioStoredSteps` (default 5,000), and the bound is
biased the way `maxStoredErrors` is: **every failed and every skipped step is
kept first**, successes are sampled into what remains, and what was thinned is
disclosed in the summary the way `SamplingRetention` already discloses it.
`Database::get_results` loads every row of a run with no limit and the report
parses each `trace_data`, so an unbounded 200-step x 500-iteration run would
make the report path quadratic in a way the dashboard polls.

### Decision 3.7 - the stored snapshot carries a step manifest, never the composed plan

`runs.config_snapshot` holds the scenario *request* (`source`, `collectionId`,
`recursive`, `iterations`, row count) plus a manifest of
`{index, requestId, name, method, url}` per step - where `url` is the **stored,
uncomposed** URL from the request row.

The composed plan is credential-grade: it carries resolved `Authorization`
headers, and an `apikey` auth with `in: "query"` puts a live key in the composed
URL. `sanitize_config_snapshot` already reduces a run's `auth` object to
`{mode}` for exactly this reason; persisting a composed plan would route around
that allowlist. The full plan lives in memory for the run's life and nowhere
else.

`data` rows are **not** snapshotted either - they are user data of unknown
sensitivity, and the manifest records only the row count.

---

## 4. Flow control as a value, not a side effect

### Decision 4.1 - `ScriptResult` carries the intent; the runner decides

```cpp
struct ScriptControl {
    enum class Kind { None, Next, Skip, EndIteration };
    Kind kind = Kind::None;
    std::string target;   // request name, for Kind::Next
};
// ScriptResult gains: ScriptControl control;
```

`pm.execution.setNextRequest(name)` and `pm.execution.skipRequest()` **record**
an intent on the result. They reach into nothing. `ScriptResult`
(`engine/include/vayu/types.hpp:515`) is already the channel a script speaks to
its caller through, and the caller is the only thing that knows what a sequence
is. This is the channel #303 prescribed and it is honoured here unchanged.

Last call wins within one script, which is Postman's behaviour.

### Decision 4.2 - `pm.execution` throws where there is no sequence

`ScriptContext` gains `bool in_scenario`, set only by the scenario runner. With
it false - a `POST /execute` send, a load run's deferred `tests` script - both
methods **throw** a sentence naming why, rather than accepting a call and doing
nothing.

A binding that cannot fail is worse than a missing one (#188's standing rule).
`setNextRequest("checkout")` silently ignored in a single send is precisely the
false-success that rule exists to prevent.

### Decision 4.3 - every ambiguous or unbounded case fails loudly

| Case | Behaviour |
|------|-----------|
| `setNextRequest(name)` naming no step in the plan | Step fails with a named error; iteration ends |
| `setNextRequest(name)` naming a **duplicated** step name | Step fails - ambiguous target, both indices named. Resolution records the duplicate set at plan time, so the error can be precise |
| `setNextRequest(null)` | `Kind::EndIteration` - ends this iteration, continues to the next. Postman's convention |
| `skipRequest()` in a **pre-request** script | This step is skipped; `outcome: "skipped"` |
| `skipRequest()` in a **test** script | Error - the request has already gone out, there is nothing left to skip |
| A `setNextRequest` cycle | Bounded by `maxStepsPerIteration` (default `10 x steps`, floor 100). Exceeding it fails the iteration with the cycle's step names |

The cycle bound is not optional. `setNextRequest` makes an infinite loop a
two-line script, and Postman's runner simply runs forever.

### Decision 4.4 - skipped is never passed

A step's `outcome` is one of `passed | failed | skipped | errored`, counted
separately everywhere: the step result row, the SSE `step` event, the run
summary, and the app's step list. `run_collection_smoke`'s matrix already
carries a distinct `skipped` count and must keep it.

A skipped request counted as a pass is the false-pass class #180 exists to
eliminate, and #303 names this explicitly as a condition of its acceptance.

---

## 5. The load-mode convergence path

Not built first. Designed now, so mode 1's structures need no rework.

### Decision 5.1 - the plan is shared; the executor is a per-virtual-user state machine

A scenario load run does not spawn a thread per virtual user. A **VU** is a
small value:

```
VirtualUser { const ScenarioPlan* plan; size_t step; size_t iteration;
              VariableOverlay vars; CookieState cookies; }
```

`concurrency` becomes **the number of virtual users** - which is what k6 and
JMeter mean by it anyway. On each completion, the existing per-completion
callback (`handle_result`, `engine/src/core/load_strategy.cpp`) advances that
VU's state machine and submits its next step to the same worker.

This is the existing closed-loop controller with one substitution: the
`maintain_concurrency` refill (`load_strategy.cpp:249`) issues "the next step of
VU *k*" instead of "another copy of the one request". The pure
`compute_refill_deficit` primitive, the SPSC submission path and the
single-producer discipline are all unchanged.

### Decision 5.2 - per-VU cookie state, never the shared jar

Each VU owns a private cookie list, empty at the start of each iteration. The
environment jar is not touched.

This *strengthens* the existing constraint rather than fighting it: a shared jar
across workers is either a lock on the 60k-RPS hot path or per-worker jars that
do not actually share (`cookie_jar.hpp`). It is also the semantically correct
answer - 1,000 VUs are 1,000 users, and one session shared between them is not
the thing being measured.

### Decision 5.3 - scripts stay deferred and sampled in load mode, and flow control is unavailable there

Load-mode scripts keep the existing `validate_scripts` discipline - deferred,
run against sampled responses after the run - extended only by being keyed
**per step index** rather than per run. Running QuickJS inline per step at
60k RPS is not viable, and that architecture is documented, load-bearing, and
out of scope for this design.

The consequence is stated rather than hidden: **`pm.execution` throws in a load
run** (decision 4.2 already covers it, since `in_scenario` is false for a
deferred script). A script that has already run against a recorded response
cannot redirect a sequence that already happened. Flow control is a design-mode
capability.

**Declined: inline scripts in load mode.** The escape hatch, if it is ever
wanted, is a bounded pool of QuickJS contexts per worker evaluated only for
iterations the sampler already selected - real work, its own benchmark, and its
own issue. Naming it here is what keeps it from being smuggled in as a side
effect of this feature.

### Decision 5.4 - scenario load runs are closed-loop only, with bounded per-step metrics

- **Modes:** `constant_concurrency`, `ramp_up`, `iterations`. `constant_rps` is
  **out** for scenarios - an open-loop arrival rate over a multi-step sequence
  is k6's arrival-rate executor, a named non-goal (section 6).
- **`maxInFlight` is moot for scenario runs.** In-flight is bounded by the VU
  count by construction, so `concurrency` is the only knob. This is a
  coordination point with **#197**, which re-tunes `workers`, the per-host
  budget and the `maxInFlight` default: #197's `maxInFlight` formula work does
  not apply to scenario runs and should not be generalised over them.
- **Per-step metrics:** one latency histogram per step, allocated once from the
  plan's step count, plus the existing whole-run aggregate as the scenario
  total. An HdrHistogram is not free, which is why `maxScenarioSteps` (default
  200) bounds the plan in both modes.

### New config keys this design introduces

| Key | Default | Bounds |
|-----|---------|--------|
| `maxScenarioSteps` | 200 | Plan size, both modes. Also bounds per-step histograms |
| `maxScenarioDataRows` | 1,000 | Inline `data` rows per run |
| `maxScenarioStoredSteps` | 5,000 | `results` rows per scenario run (failures kept first) |
| `maxStepsPerIteration` | `10 x steps`, floor 100 | `setNextRequest` cycle bound |

---

## 6. Explicit non-goals

Named so the design has a boundary, and so none of them arrives sideways:

- **JMeter's logic-controller zoo** - if/while/switch/loop/interleave
  controllers. `setNextRequest` covers the workflows people actually build.
- **k6's open-model / arrival-rate executors for scenarios** (5.4).
- **Distributed load.**
- **The engine reading data files from disk** (2.3).
- **Parallel steps within an iteration.** An iteration is ordered; that is the
  whole primitive.
- **A scenario-level test script** asserting across steps.
- **`pm.visualizer`** - unrelated to sequencing, still `undefined`.
- **Replacing `run_collection_smoke`.** A smoke matrix over independent executes
  is a different tool - unordered, share-nothing, agent-facing - and stays.
- **Inline scripts on the load path** (5.3).

---

## 7. Phasing

Each phase is an implementer-ready sub-issue of #340. Phase 1 is the only one
with no user-visible surface; it exists separately because plan resolution is
what every later phase consumes, and it is testable on its own.

| Phase | Deliverable | Depends on |
|-------|-------------|------------|
| 1 | `ScenarioPlan` resolution + `scenario` block on `POST /runs` + snapshot manifest. No execution | this design |
| 2 | Design-mode sequential runner: steps, iterations, per-step `results`, `runs.type = scenario`, SSE `step` events | 1 |
| 3 | App: runner UI - run a folder, live per-step progress, per-step results | 2 |
| 4 | Flow control: `ScriptControl` on `ScriptResult`, `pm.execution.setNextRequest` / `skipRequest` (**this is #303's first half**) | 2 |
| 5 | `pm.iterationData` + data rows: engine binding, app file picker and parser (**#303's second half**) | 2, 4 |
| 6 | Load-mode scenarios: VU state machine, per-VU cookies, per-step histograms | 2, and coordinate with #197 |

Test strategy per phase: engine gtest for plan resolution (ordering, recursion,
duplicate names, every loud-failure case in 4.3), for sequence semantics
(state carried between steps, iteration boundaries, the cycle bound), and for
flow-control values (a returned instruction actually changes the sequence);
app vitest for the runner UI and the skip-vs-pass matrix rule (4.4). Phase 6
additionally needs a benchmark on a quiet host, which is #197's constraint too.

---

## 8. What this design does not decide

Recorded so a later reader knows these were left open on purpose, not missed:

- **The runner UI's shape** beyond "per-step results with live progress" -
  phase 3's issue owns it against `docs/app/COMPONENTS.md`.
- **Whether a stored `scenarios` entity ever lands** (2.1). The seam exists; the
  demand does not yet.
- **Retry / continue-on-failure policy.** Today an errored step ends its
  iteration. A per-step `continueOnFailure` is an obvious ask and is deliberately
  not invented ahead of someone asking for it.
