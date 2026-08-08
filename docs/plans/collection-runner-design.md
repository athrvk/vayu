# Collection Runner Design

## Overview

This document records the design decisions behind Vayu's collection runner - the
engine-side primitive that executes an **ordered sequence** of requests, rather
than the single sends and single-request load runs Vayu has today.

One primitive serves both halves of Vayu's target. In design mode it is
Postman's collection run: a folder executed in order, with per-request scripts
and state flowing between steps. In load mode it is the multi-step sequence a k6
virtual user or a JMeter thread group repeats: log in, then browse, then check
out.

**This design is decided but not yet built.** Each section below states a
decision and the alternative it declines, so that the implementation does not
relitigate them. Sections describing load-mode behaviour are decided ahead of
being scheduled, so that design-mode structures need no rework when load mode
arrives.

**Lifecycle of this page.** It is a plan, and plans get consumed: as each phase
ships, its decisions fold into `docs/engine/architecture.md` beside the Cookie
Jar and request-composition sections, which is where rationale for *shipped*
behaviour lives. When the last phase lands this page is deleted, the same way
backlog entries are removed from `pending-backlog.md` once they ship. A section
that has shipped says so and points at the docs that describe it; the rest still
describes behaviour the engine does not have. Scheduling and phase status are
tracked in the issues, not on this page, so that a closed issue cannot leave a
stale line here.

## What Vayu has today

Two things look like runners and are not.

**`run_collection_smoke` is a client-side loop.** The MCP smoke handler
(`app/electron/mcp/tools.ts`) walks a collection in TypeScript, calling
`POST /compose` and `POST /execute` per request. The engine sees N unrelated
design-mode executes and holds no object that contains them, so a script running
inside execute #3 has nothing to say about execute #4 and nowhere to put the
instruction.

**Load runs repeat a single composed request.** `execute_load_test`
(`engine/src/core/run_manager.cpp`) builds one request and the strategy submits
copies of it. Test scripts there run deferred, once per *sampled* response, after
the run finishes (`validate_scripts`, `run_manager.cpp:55`, called at `:747`), so
even the ordering that does exist is not something a script participates in.

## The sequence model

> **Shipped.** Plan resolution and the `scenario` block on `POST /runs` exist -
> see [POST /runs](../engine/api-reference.md#the-scenario-block-collection-runs).

### A scenario is a folder, resolved once into an immutable plan

A scenario is not a new stored entity. It is a *resolution* of one that exists: a
collection, its direct requests ordered by `requests.order`, optionally including
descendant collections ordered by `collections.order`, depth-first.

At run start the engine resolves that into a **scenario plan**: an ordered,
immutable vector of fully composed steps. Each step is the payload
`POST /execute` accepts - `{{variables}}` substituted, `inherit` auth walked and
applied, the ordered script-part lists from the collection chain plus the
request's own - produced by the composition the engine already owns
(`compose_request_core`, `engine/src/http/request_composer.cpp`).

```
ScenarioStep {
  index          size_t          // position in the plan, stable for the run
  request_id     string          // the stored request this came from
  name           string          // requests.name, the setNextRequest target
  request        vayu::Request   // composed, execute-ready
  pre_script     string          // joined parts (script_parts.cpp::read_script)
  post_script    string          // joined parts
}
```

**Declined: a first-class `scenarios` table.** The collection tree with its
`order` columns already *is* an ordered sequence. A second table would be a
second source of truth for that ordering, needing its own answer to "a request in
this scenario was deleted" and its own reconciliation on every collection edit -
state one layer records and another re-derives, which is this codebase's most
repeated defect.

A stored scenario becomes necessary the moment someone wants a sequence that is
*not* a folder: steps drawn from several folders, one request appearing twice, a
step disabled for one scenario but not another. The design does not preclude it.
The run payload carries a `source` discriminator, and plan resolution is the
seam:

```jsonc
"scenario": {
  "source": "collection",          // the only value at first
  "collectionId": "col_...",
  "recursive": false,              // descend into sub-collections
  "iterations": 1,
  "data": [ { "user": "a" }, ... ] // optional; see below
}
```

A future stored scenario is `{"source": "stored", "scenarioId": "scn_..."}` and
resolves to the same plan. Nothing downstream of resolution changes.

### Resolution happens exactly once, before the first send

No step is composed lazily, and no execution path touches SQLite for request data
after resolution. Two reasons, and the second is load-bearing:

- A collection edited mid-run would otherwise change the sequence underneath
  itself. A run is a record of what ran; it must resolve to one answer.
- **Load mode cannot query SQLite per step per virtual user.** A fully composed
  plan is what makes the per-VU executor possible at all. Resolving lazily in
  design mode would be a stopgap that load mode has to undo.

Resolution failures are loud and pre-run: an empty collection, a step whose
composition fails, a plan exceeding `maxScenarioSteps`. All are a `400` naming
the offending request, before any `runs` row exists. This matches the existing
`POST /runs` discipline, where `validate_run_config` and
`normalize_run_http_version` both run before `create_run`
(`engine/src/http/routes/execution.cpp`).

### An iteration is one pass over the plan; data rows arrive on the payload

`iterations` (default `1`) is how many times the plan executes end to end.

`data` is an inline JSON array of objects on the run payload. Row `i % rows`
binds to iteration `i` as `pm.iterationData`. When `data` is present and
`iterations` is absent, `iterations` defaults to the row count, which is
Postman's default. When both are given the explicit count wins and the row index
wraps; the wrap is not silent, because every per-iteration record carries its
`dataRowIndex` and `pm.info.iteration`. An empty `data` array is a `400`: a data
set that binds nothing is a mistake, not an empty run.

**Declined: the engine reading a data file from disk.** The script sandbox has no
filesystem access by design, and giving the daemon a user-supplied path is a new
trust boundary - traversal, arbitrary reads - bought for a parsing job the app
already does well, since it owns the Postman/Insomnia/OpenAPI import parsers. The
app picks the file, parses CSV or JSON, and sends rows. The cost is payload size,
which is what `maxScenarioDataRows` bounds.

## Design-mode execution

> **Shipped.** The sequential runner exists. What it does is described in
> [Scenario Mode](../engine/architecture.md#scenario-mode-collection-run) and
> [Scenario runs](../engine/api-reference.md#scenario-runs); what follows is the
> reasoning those pages summarise, kept here until the last phase lands.

### A scenario run is a third `runs.type`

`runs.type` gains `"scenario"` beside `"design"` and `"load"`.

It cannot reuse `"design"`: a design run has **exactly one `results` row**, and
`GET /runs/:runId` serves it as `result` on that assumption (see
[Database Schema](../engine/db-schema.md)). A scenario run has one row per step
execution, so overloading `design` would break a documented reader.

### The lifecycle is a load run's; only the executor differs

`POST /runs` accepts a `scenario` block and answers `202 {runId}`, exactly as a
load run does. The run gets a worker thread from `RunManager::start_run`, is
registered, retained and swept by the existing machinery, streams over
`GET /runs/:runId/live`, stops through the existing stop path, and reports
through `GET /runs/:runId/report`.

**Declined: a synchronous `POST /scenarios/run`.** A 50-request folder takes as
long as its requests added together, and holding a cpp-httplib worker thread for
minutes is not viable. A second asynchronous endpoint would need its own copy of
stop, retention, SSE resume and the `DELETE /runs/:id` cascade; there is no
second lifecycle here, only a second executor.

The live stream gains a `step` event beside `metrics`, carrying
`{iteration, stepIndex, name, outcome, statusCode, latencyMs}`. It rides the
existing bounded tick ring (`RunContext::append_tick`) and its monotonic `id:`
numbering, so `Last-Event-ID` resume works unchanged.

### Steps run sequentially through `http::Client`

Per iteration, per step, this is the `POST /execute` handler's body:

```
compose (already done at plan time)
  -> pre-request script   (ScriptContext::for_prerequest, pm.request writes back)
  -> Client::send         (through the environment cookie jar)
  -> post-request script  (ScriptContext::for_test)
  -> record step result
  -> apply flow control
```

It must be `http::Client` and not `EventLoop`, because design-mode fidelity needs
the cookie jar and inline per-step scripts, and the event loop deliberately has
neither (see [Cookie Jar](../engine/architecture.md#cookie-jar), "Not on the load
path").

**This is where the two modes diverge, and the divergence is the design.** The
plan is shared; the executor is not.

### State flows between steps through the scopes that already exist

**Variables.** The environment, globals and collection scopes are loaded once at
run start (`load_script_variable_scopes`), mutated in memory by every step's
scripts across every iteration, and persisted **once at run end** through the
existing diff-based `persist_script_variables`. This is what makes "step 1 logs
in and `pm.environment.set`s the token, step 2 sends it" work. Persisting per
step would be N x M diff-and-write cycles against the DB mutex for a value only
the run's own later steps read.

**Cookies.** The existing per-environment jar, scope = `environmentId`,
unchanged. It was scoped this way partly for this feature, and it already gives
"log in once, reuse the session" for free.

**Nothing else.** There is no scenario-scoped variable bag. A fourth scope would
need precedence rules, a persistence story and a UI, to hold what the environment
scope already holds for the run's lifetime.

### `pm.info` gains `iteration` and `iterationCount`, set only by the runner

`ScriptContext` gains two optional fields. The scenario runner sets them; every
other caller leaves them unset and they reach the script as `undefined`.

This does not reopen the ruling that kept them out (issue #300), which stands
verbatim: a load run's `tests` script runs once per *sampled* response, and a
reservoir sample index reported as an iteration number would be a binding that
cannot fail. A scenario run has a real iteration index, so it reports one;
`validate_scripts` still sets neither.

### One bounded `results` row per step execution

Each step execution writes a `results` row with the design-mode `trace_data`
subset - the one `restore-response.ts` already restores from - plus `iteration`,
`stepIndex`, `stepName`, `requestId` and `outcome`.

Bodies are capped by the existing `maxTraceBodyBytes`. The row count is bounded
by `maxScenarioStoredSteps`, and the bound is biased the way `maxStoredErrors`
is: **every failed and every skipped step is kept first**, successes are sampled
into what remains, and what was thinned is disclosed the way `SamplingRetention`
already discloses it. `Database::get_results` loads every row of a run with no
limit and the report parses each `trace_data`, so an unbounded 200-step by
500-iteration run would make the report path quadratic in a way the dashboard
polls.

### The stored snapshot carries a step manifest, never the composed plan

`runs.config_snapshot` holds the scenario request - `source`, `collectionId`,
`recursive`, `iterations`, row count - plus a manifest of
`{index, requestId, name, method, url}` per step, where `url` is the **stored,
uncomposed** URL from the request row.

The composed plan is credential-grade: it carries resolved `Authorization`
headers, and an `apikey` auth with `in: "query"` puts a live key in the composed
URL. `sanitize_config_snapshot` already reduces a run's `auth` object to `{mode}`
for exactly this reason, and persisting a composed plan would route around that
allowlist. The full plan lives in memory for the run's life and nowhere else.

`data` rows are not snapshotted either. They are user data of unknown
sensitivity, and the manifest records only the row count.

## Flow control

> **Shipped.** `pm.execution.setNextRequest` / `skipRequest` exist. What they do,
> and everywhere they throw, is described in
> [Flow control](../engine/scripting.md#flow-control-pmexecution) and
> [Scenario runs](../engine/api-reference.md#scenario-runs); what follows is the
> reasoning those pages summarise, kept here until the last phase lands.

### The script returns an intent; the runner decides

```cpp
struct ScriptControl {
    enum class Kind { None, Next, Skip, EndIteration };
    Kind kind = Kind::None;
    std::string target;   // request name, for Kind::Next
};
// ScriptResult gains: ScriptControl control;
```

`pm.execution.setNextRequest(name)` and `pm.execution.skipRequest()` **record** an
intent on the result and reach into nothing. `ScriptResult`
(`engine/include/vayu/types.hpp`) is already the channel a script speaks to its
caller through, and the caller is the only thing that knows what a sequence is.
Last call wins within one script, which is Postman's behaviour.

### `pm.execution` throws where there is no sequence

`ScriptContext` gains `bool in_scenario`, set only by the scenario runner. With
it false - a `POST /execute` send, a load run's deferred `tests` script - both
methods throw a sentence naming why, rather than accepting a call and doing
nothing.

A binding that cannot fail is worse than a missing one (issue #188's standing
rule). `setNextRequest("checkout")` silently ignored in a single send is
precisely the false success that rule exists to prevent.

### Every ambiguous or unbounded case fails loudly

| Case | Behaviour |
|------|-----------|
| `setNextRequest(name)` naming no step in the plan | Step fails with a named error; iteration ends |
| `setNextRequest(name)` naming a **duplicated** step name | Step fails - ambiguous target, both indices named. Resolution records the duplicate set at plan time, so the error can be precise |
| `setNextRequest(null)` | Ends this iteration, continues to the next. Postman's convention |
| `skipRequest()` in a **pre-request** script | This step is skipped; `outcome: "skipped"` |
| `skipRequest()` in a **test** script | Error - the request has already gone out, there is nothing left to skip |
| A `setNextRequest` cycle | Bounded by `maxStepsPerIteration`. Exceeding it fails the iteration with the cycle's step names |

The cycle bound is not optional. `setNextRequest` makes an infinite loop a
two-line script, and Postman's runner simply runs forever.

### Skipped is never passed

A step's `outcome` is one of `passed`, `failed`, `skipped` or `errored`, counted
separately everywhere: the step result row, the SSE `step` event, the run summary
and the app's step list. `run_collection_smoke`'s matrix already carries a
distinct `skipped` count and keeps it.

A skipped request counted as a pass is the false-pass class issue #180 exists to
eliminate.

## Load-mode convergence

Decided ahead of being scheduled, so that design-mode structures need no rework.

### The plan is shared; the executor is a per-virtual-user state machine

A scenario load run does not spawn a thread per virtual user. A VU is a small
value:

```
VirtualUser { const ScenarioPlan* plan; size_t step; size_t iteration;
              VariableOverlay vars; CookieState cookies; }
```

`concurrency` becomes **the number of virtual users**, which is what k6 and
JMeter mean by it anyway. On each completion the existing per-completion callback
(`handle_result`, `engine/src/core/load_strategy.cpp`) advances that VU's state
machine and submits its next step to the same worker.

This is the existing closed-loop controller with one substitution: the
`maintain_concurrency` refill issues "the next step of VU *k*" instead of "another
copy of the one request". The pure `compute_refill_deficit` primitive, the SPSC
submission path and the single-producer discipline are unchanged.

### Cookie state is per-VU, never the shared jar

Each VU owns a private cookie list, empty at the start of each iteration. The
environment jar is not touched.

This strengthens the existing constraint rather than fighting it: a shared jar
across workers is either a lock on the 60k-RPS hot path or per-worker jars that
do not actually share. It is also the semantically correct answer, since 1,000
VUs are 1,000 users and one session shared between them is not the thing being
measured.

### Scripts stay deferred, so flow control is design-mode only

Load-mode scripts keep the existing `validate_scripts` discipline - deferred, run
against sampled responses after the run - extended only by being keyed per step
index rather than per run. Running QuickJS inline per step at 60k RPS is not
viable, and that architecture is documented and load-bearing.

The consequence is stated rather than hidden: **`pm.execution` throws in a load
run**, which the `in_scenario` rule above already covers. A script that has
already run against a recorded response cannot redirect a sequence that already
happened.

**Declined: inline scripts in load mode.** The escape hatch, if it is ever
wanted, is a bounded pool of QuickJS contexts per worker evaluated only for
iterations the sampler already selected. That is real work with its own benchmark
and its own issue; naming it here is what keeps it from being smuggled in as a
side effect of this feature.

### Closed-loop only, with bounded per-step metrics

- **Modes:** `constant_concurrency`, `ramp_up` and `iterations`. `constant_rps`
  is out for scenarios, because an open-loop arrival rate over a multi-step
  sequence is k6's arrival-rate executor, a non-goal below. Requesting it with a
  scenario is a `400`, not a silent fallback.
- **`maxInFlight` is moot for scenario runs.** In-flight is bounded by the VU
  count by construction, so `concurrency` is the only knob. The high-RPS default
  re-tune tracked in `pending-backlog.md` (P1) covers single-request load runs;
  its `maxInFlight` formula should not be generalised over scenarios.
- **Per-step metrics:** one latency histogram per step, allocated once from the
  plan's step count, plus the existing whole-run aggregate as the scenario total.
  An HdrHistogram is not free, which is why `maxScenarioSteps` bounds the plan in
  both modes.

## New configuration keys

| Key | Default | Bounds |
|-----|---------|--------|
| `maxScenarioSteps` | 200 | Plan size, both modes. Also bounds per-step histograms |
| `maxScenarioDataRows` | 1,000 | Inline `data` rows per run |
| `maxScenarioStoredSteps` | 5,000 | `results` rows per scenario run (failures kept first) |
| `maxStepsPerIteration` | `0` = `10 x steps`, floor 100 | `setNextRequest` cycle bound |

## Non-goals

Named so the design has a boundary, and so none of them arrives sideways:

- **JMeter's logic-controller zoo** - if, while, switch, loop and interleave
  controllers. `setNextRequest` covers the workflows people actually build.
- **k6's open-model and arrival-rate executors for scenarios.**
- **Distributed load.**
- **The engine reading data files from disk.**
- **Parallel steps within an iteration.** An iteration is ordered; that is the
  whole primitive.
- **A scenario-level test script** asserting across steps.
- **`pm.visualizer`** - unrelated to sequencing, and still `undefined`.
- **Replacing `run_collection_smoke`.** A smoke matrix over independent executes
  is a different tool - unordered, share-nothing, agent-facing - and stays.
- **Inline scripts on the load path.**

## Implementation phases

The work splits into six phases, ordered by what each one unblocks rather than by
size. Plan resolution comes first and alone, because every later phase consumes
the plan and it is testable with nothing executing:

1. Plan resolution, the `scenario` block on `POST /runs`, and the snapshot
   manifest. No execution.
2. The design-mode sequential runner: steps, iterations, per-step results, the
   third `runs.type`, and `step` SSE events.
3. The app runner UI: run a folder, live per-step progress, per-step results.
4. Flow control - `ScriptControl` on `ScriptResult`, and the `pm.execution`
   bindings.
5. `pm.iterationData` and data rows, engine binding plus the app's file picker.
6. Load-mode scenarios: the VU state machine, per-VU cookies, per-step
   histograms. This phase shares the hot path with the high-RPS default re-tune
   and lands after or with it.

Phases 3 through 6 depend only on phase 2, not on each other. Flow control and
iteration data are design-mode capabilities by decision, not by ordering.

Per-phase test strategy: engine gtest for plan resolution (ordering, recursion,
duplicate names, every loud-failure case above), for sequence semantics (state
carried between steps, iteration boundaries, the cycle bound) and for
flow-control values (a returned instruction actually changes the sequence); app
vitest for the runner UI and the skip-versus-pass rule. Phase 6 additionally
needs a benchmark on a quiet host.

Scheduling, dependencies and status live in the issues. Issue #340 carries the
phase breakdown and its sub-issues; this page deliberately holds no issue numbers
for them, so that closing one cannot leave a stale line here.

## Deliberately left open

Recorded so a later reader knows these were left open on purpose, not missed:

- **The runner UI's shape** beyond "per-step results with live progress". The
  phase-3 issue owns it against `docs/app/COMPONENTS.md`.
- **Whether a stored scenario entity ever lands.** The seam exists; the demand
  does not yet.
- **Retry and continue-on-failure policy.** An errored step ends its iteration. A
  per-step `continueOnFailure` is an obvious ask and is deliberately not invented
  ahead of someone asking for it.
