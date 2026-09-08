---
description: >-
  The element model - typed behaviours attached to a request or collection at a phase of a step, and the registry that serves them.
---

# Elements

Vayu's collection run is at parity with a JMeter test plan the way JMeter delivers it: as
**elements** a user attaches to a request or a folder - extract this field, assert that, wait
here, loop these, record this - added and removed independently, inherited down the tree, and run
by the engine at fixed phases of a step (issue #1512). This page is the kind catalogue and the
shape both sides of the wire agree on; it is generated from, or checked against, the registry
`GET /elements/kinds` serves.

> **Status:** issue #1513 landed the storage, the registry and the catalogue. Issue #1514 lands the
> pipeline that runs a kind in the design send and the sequential collection run, and the phase-0
> kinds below. `elements` is the only script source now - `pre_request_script` /
> `post_request_script` are gone, cut over by a one-shot migration (see
> [`db-schema.md`](db-schema.md#the-script-to-elements-migration-issue-1514)); no transitional
> alias, per the owner's decision. Issue #1495 lands the pipeline on a **scenario** load run's
> producer/completion hooks (below) - a **single-request** load run still executes no element; see
> that section for why. Issue #1499 lands the first kinds to run at a run's own boundary rather
> than at a step's - `script.setup` / `script.teardown`, dispatched at `Phase::RunStart` /
> `Phase::RunEnd` outside the step pipeline entirely, in both run modes a collection can run in.

## Shape

An element is `{"id", "kind", "enabled", "name"?, "config"}` in an ordered array, stored as the
`elements` column on `requests` and `collections`:

```json
{
  "id": "el_3f2b1c9a",
  "kind": "assert.status",
  "enabled": true,
  "name": "optional label",
  "config": { "in": [200, 201] }
}
```

`id` and `kind` are required; `kind` must be one `GET /elements/kinds` lists, and `config` must
validate against that kind's JSON Schema - both checked by
`vayu::core::Registry::validate` (`engine/include/vayu/core/elements.hpp`), which every write route
runs before storing (`400` naming the index, the kind and the field on a violation). A request
disables an element it would otherwise inherit from an ancestor collection with an
`inherit.disable` entry naming the ancestor's `id` in its own list, rather than by deleting it.

## Phases

A kind's registration names which of a step's seven points it runs at - `run.start`,
`iteration.start`, `step.before` (after compose, before the residual-token pass), `step.after`
(response in hand), `step.between`, `iteration.end`, `run.end`. Phase is derived from the kind,
never stored on the element instance itself.

## The registry, and how a kind is added

`Registry::instance()` (`engine/src/core/elements/registry.cpp`) holds the one, explicit list a
kind name maps to code - the extensibility contract's rule: adding a capability is one new file
under `engine/src/core/elements/` plus one line in the registry's own call list, with nothing else
in the engine, the app or MCP touched to make the kind exist and validate. `GET /elements/kinds`
serves the same list; the app and MCP render a kind's editor from its schema, with a bespoke form
only where one is worth writing by hand.

## Kinds

`inherit.disable` has no `compile`: it is consumed at compose time (`compose_elements`), never
constructed into a running `Element`. Every other kind below has one, registered in
`engine/src/core/elements/registry.cpp`. The test binary also registers a `test.echo` kind, proving
the registration path itself - never in a production build. The table below is the single
reference for every kind that exists once the rest of the epic lands, generated from or checked
against the registry so a kind added on one side and forgotten on another fails a test rather than
shipping silently mismatched.

| Kind | Category | Phases | Runs since |
|------|----------|--------|------------|
| `inherit.disable` | inherit | (consumed at compose time, not a phase) | #1513 |
| `extract.json` | extract | `step.after` | #1514 |
| `extract.regex` | extract | `step.after` | #1514 |
| `extract.header` | extract | `step.after` | #1514 |
| `assert.status` | assert | `step.after` | #1514 |
| `assert.jsonpath` | assert | `step.after` | #1514 |
| `assert.contains` | assert | `step.after` | #1514 |
| `assert.duration` | assert | `step.after` | #1514 |
| `assert.size` | assert | `step.after` | #1514 |
| `timer.think` | timer | `step.between` | #1514 (fixed/uniform), #1498 (gaussian) |
| `timer.pacing` | timer | `step.before` | #1498 |
| `script.pre` | script | `step.before` | #1513 (validate-only), #1514 (runs) |
| `script.post` | script | `step.after` | #1513 (validate-only), #1514 (runs) |
| `script.setup` | script | `run.start` | #1499 |
| `script.teardown` | script | `run.end` | #1499 |
| `control.if` | controller | `step.before` | #1515 |
| `control.once` | controller | `step.before` | #1515 |
| `control.switch` | controller | `step.before` | #1515 |
| `control.throughput` | controller | `step.before` | #1515 |
| `control.loop` | controller | `step.between` | #1515 |
| `control.transaction` | transaction | `step.after` | #1515 |
| `metric.record` | metric | `step.after` | #1500 |

`extract.json` reads a JSONPath subset - `$.a.b`, `[n]`, `[*]`, `..name`; a filter (`[?...]`) is
refused at validate. `extract.regex` compiles its `pattern` once, at plan-resolution time, and
writes a `$1$`-style template of the match's groups. Both, and `extract.header`, share `variable`,
`scope` (`env` | `collection` | `globals`), `default` and the JMeter `matchNo` convention: `1`-based
picks a match, `0` picks one at random, `-1` writes every match as `<variable>_1` ..
`<variable>_N` plus a `<variable>_matchNr` count. A miss without a `default` reports `"missing"`,
and only when `required: true` also fails the step - through the same `tests` list a `pm.test`
assertion writes to, which is why the SSE frame's `tests` tally and `describe_failed_tests` count a
declarative assertion exactly as they count a scripted one.

`assert.status` takes an `in` list or a `range`; `assert.jsonpath` takes the same path subset with
one of `expected`, `regex` or `exists`, plus `negate`; `assert.contains` compares a `field` (`body`
| `headers` | `url` | `status`) against `text` in `contains` | `equals` | `matches` mode;
`assert.duration` takes `maxMs`; `assert.size` compares the body's byte length against `bytes` with
an `op`. `timer.think` takes `ms`, `minMs`/`maxMs` for a uniform random wait, or `gaussian:
{meanMs, deviationMs}` (both required, issue #1498) for a normally-distributed one, drawn from
`std::normal_distribution` and clamped to zero (a draw below it would be a negative wait, which
means nothing) then rounded to the nearest millisecond - `gaussian` is checked first, so it and
`ms`/`minMs`/`maxMs` are mutually exclusive in practice even though the schema does not enforce it.
It runs in `step.between`, after this step's own outcome is decided and before the next step
begins, so the wait never counts against either step's latency, and it polls the run's stop signal
every 50ms so a `Stop` mid-wait lands promptly rather than at the end of a multi-second think. A
run's `elements.seed` (below) makes the random draw reproducible.

`timer.pacing` (issue #1498) holds a request, a folder or the whole collection to a steady
start-to-start cadence across iterations - `everyMs` (required) between one pass's entry into that
scope and the next, whatever the node's own duration was - and runs in `step.before`, not
`step.between`, because the wait belongs to the *next* pass and must land before that entry step is
sent. The same element is inherited into every request under its scope, so `scenario_plan.cpp`'s
`mark_scope_entries` stamps `config._scopeEntry` on only the first occurrence of that element's id
in the iteration's step order; every later occurrence is a no-op, reported `skipped`. `perUser`
(default `true`) gives each virtual user its own cadence; `perUser: false` (one cadence shared by
every VU, JMeter's "All threads" pacing) works on the sequential run, where a single VU makes the
two indistinguishable, but is refused with a `400` for a scenario load run - coordinating one
shared deadline across many VUs without blocking a producer thread is a separate, harder problem,
tracked as a follow-up issue. `timer.throughput` (a constant-throughput, shared-rate timer) is not
yet implemented, for the same cross-VU coordination reason.

The JSON-reading kinds (`extract.json`, `assert.jsonpath`) share one parse of the response body per
step, through `ElementContext`'s lazily filled slot - a body over `maxElementBodyBytes` (default 1
MiB) is not parsed, and every such kind on that step reports `skipped` with the reason.

`metric.record` (issue #1500) reads a value off the response and records it as a custom `trend`
(a distribution, reported as `count`/`p50`/`p95`/`p99`/`max`), `counter` (a running total) or `rate`
(share of occurrences a `condition` matched, as a percentage). A trend or counter's `source` is one
of `{jsonpath}` (the same subset `extract.json` reads), `{header}`, `{latency}`, `{status}` or
`{size}`; a rate's is `{condition: {field, operator, value}}` - a small, self-contained comparison
rather than the full `control.if` grammar #1515 defines, which is not yet part of this registry and
would be a needless dependency for what a rate condition actually needs. `metric.record` writes
through `ElementContext::record_metric`, a callback bound only when a run's `MetricsCollector` is
reachable (the sequential run, a scenario load run, design mode's `script.pre`/`script.post`); a
bare design send has none, and the element reports `skipped` there rather than recording nowhere
silently. `pm.metrics.trend`/`.counter`/`.rate` (`docs/engine/scripting.md`) write through the same
callback from a script, so both surfaces share one collector-side implementation
(`MetricsCollector::record_custom_metric`). Every run is capped at
`constants::metrics_collector::MAX_CUSTOM_METRIC_NAMES` (32) distinct names, refused at
`Registry::validate` time for a declared `metric.record` - see `api-reference.md`'s `customMetrics`
and thresholds sections for how a recorded value reaches the report and a `custom.<name>.<stat>`
budget.

`script.pre` / `script.post`'s `apply` never touches `ScriptEngine` itself: it calls back into
`ElementContext::run_pre_script` / `run_post_script`, which the caller (`execute_exchange`, and the
streaming send's own inline pipeline calls) binds to the exact `execute_script` call design mode has
always made. The element's own outcome is whether the script ran without throwing; the script's own
`pm.test` assertions travel inside the same `vayu::ScriptResult` untouched, so a scripted step's
trace shape is unchanged by this cut-over.

`script.setup` / `script.teardown` are `collection_only` - refused (a `400` naming the index and
kind) on a request's own `elements`, both at write time and in `GET /elements/kinds`'
`collectionOnly` flag, because a once-per-run element attached to one request in the tree has no
answer to "once per run, or once per request that happens to carry it". Their `apply` follows the
same callback shape as `script.pre` / `script.post`, through the new `ElementContext::run_setup_script`
/ `run_teardown_script` pair: the sequential runner and the load path's `execute_load_test` compile the
collection's own `elements` once (never a step's inherited copy) and dispatch `Phase::RunStart` /
`Phase::RunEnd` against it directly, outside the step pipeline entirely. A **single-request** load
run has no collection row to compile that array from - it compiles `POST /runs`'s own top-level
`lifecycleElements` array instead (issue #1573), the same two kinds only, checked the same
`ElementOwner::Collection` way; `validate_lifecycle_elements_run_override` refuses it outright
beside a `scenario` block, whose collection already has a real `elements` column for this. `run.start` runs before the
sequential run's iteration loop, and before `execute_load_test` captures the load run's own
`test_start` - so a setup script's own time is never folded into either mode's duration figures - and
writes through the same `ScriptVariableScopes` (`scopes` / `base_scopes`) every other script of the
run shares, so its writes are visible from the very first step or submission. A throwing setup fails
the run - `Failed`, nothing sent - before either mode's strategy starts; a throwing teardown is
recorded under the report's `lifecycle.teardown` and never changes the run's terminal status, since
`ElementPipeline::run` already turns a throw into that element's own `"error"` outcome rather than
propagating one. Teardown's script sees `pm.info.run` (`requestsSent`, `errorRate`,
`assertionsPassed`, `assertionsFailed`) - the one context that can report a run summary, because it is
the one that runs after there is one. Neither kind gets a per-element `allowRequests` toggle: `pm.sendRequest`
inside either script is gated by the run's own `allowScriptRequests` (`ScriptConfig::allow_send_request`,
baked into the `ScriptEngine` instance every script of the run already shares) and capped at the same
10 calls per script every other script gets - a second, per-element gate would be dead configuration
next to a run-wide one that already decides the question.

### Controllers

JMeter's logic controllers, as element kinds rather than a nested sub-flow (issue #1515):
`control.if` skips this step (or, inherited onto a folder, every member) when a condition against a
resolved `{{variable}}` is false - `{{v}} == x`, `!=`, `matches /re/`, or `{{v}} exists`, refused at
validate outside that grammar. `control.once` runs on this user's first iteration only. `control.throughput`
runs a share of occurrences by `percent` (an exact integer-carry accumulator, not a random draw) or
`everyN`, on the producer's own per-user counter - no lock, no body parse. All three write the same
`ScriptControl::Skip` decision `pm.execution.skipRequest()` always has, so a skip is one mechanism
end to end: `execute_exchange`'s pre-send check, `decide_next_step`, and `classify_step`'s
`StepOutcome::Skipped` all read it exactly as they read a script's.

`control.switch` (`variable`, `cases`, `default?`) routes to a named member by a resolved variable's
value, through the same `ScriptControl::Next` / `resolve_next_step` a script's own
`setNextRequest` uses - so a switch's dispatch is an ordinary jump to every reader of the step list,
not a second flow-control channel.

`control.loop` (`count`) and `control.transaction` (`name`) both sit on a folder and are inherited
into every member beneath it, compiling once per member - so each member's own instance has to
recognise its folder's first or last position independently rather than being told it.
`compute_element_spans` (`scenario_plan.cpp`) answers that once per run, from a single pass over the
resolved plan: a scope-spanning kind's `id` maps to the `{first, last}` position it occupies,
read through the registry's `needs_span` flag. `control.loop` fires only at its folder's last
member, on `step.between`; while its own per-iteration pass count (kept in
`ElementContext::controller_state`, keyed by the element id and the iteration) is under `count`, it
sets `ScriptControl::Next` back to the folder's first member - an ordinary loop-back, resolved the
same way `control.switch`'s jump is. `control.transaction` sums every member's own response
latency into a per-iteration accumulator (same keying) and, at the folder's last member, reports the
closed sum as its `ElementOutcome::waitedMs` with the transaction's `name` in `message` - the two
fields the runner (`scenario_runner.cpp` / `scenario_load.cpp`) reads to fold the value into
`TransactionHistograms`, one HdrHistogram per declared name allocated up front from a plan scan, so
recording it takes no lock either. The report gains `scenario.transactions[] = { name, count,
errors, latency: { min, p50, p90, p95, p99, max } }`, omitted for a transaction the run never closed.

**Sequential-only: `control.switch` and `control.loop`.** A scenario load run's virtual users
advance through the plan strictly forward (`VirtualUser::step`), with no jump the way a repeat or a
dispatch needs; `POST /runs` refuses a load run whose plan carries either kind with a `400` naming
it (`vayu::core::find_load_incompatible_controller`), read through the registry's own
`jumps_or_repeats` flag. `control.if`, `control.once`, `control.throughput` and
`control.transaction` all run under load too - see Load paths below for `control.if`'s own skip
there, which the load path had no equivalent of before this issue. A load-path jump mechanism, plus
`control.throughput`'s shared `perUser: false` budget and `control.transaction`'s `includeTimers`,
are real, disclosed follow-up work: issue #1569.

## The step trace

A design send's and a sequential run step's stored trace gains an `elements` array beside the
existing `scripts` node - one entry per compiled element that ran at `step.before` or `step.after`
(`step.between` too, for the sequential run), each `{ id, kind, origin, outcome, message?, waitedMs?,
wrote? }`. `outcome` is one of `ok` | `failed` | `missing` | `skipped` | `error`; a disabled element
is reported `skipped` without its `apply` ever running. `POST /execute`'s live response body carries
the same array under the same key - one object, two homes, on the `scripts` node's own precedent.

## Load paths

A scenario load run's `submit_one` (the producer, one virtual user at a time) runs
`step.before` before binding and submitting a request; its completion runs `step.after`
once the response is in hand, before the virtual user (VU) is released back to the pool. A
**declarative** kind (`extract.*`, `assert.*`, `metric.record`) always runs at both points, read
off the kind's registered `hotPath`, never a `kind ==` comparison (the extensibility contract's rule
1). A **script** kind (`script.pre`, `script.post`) runs there only when its own
`config.inline` is `true` or the run's `elements.scripts` override forces it one way or the
other; otherwise the step keeps its pre-#1495 behaviour, deferred to the post-run `tests`
replay, which now skips a step whose script already ran inline
(`RunContext::script_element_runs_inline` is the one place that decision is made, read by
both sides).

**Per-VU isolation.** A load run's VUs share one event loop, so what an element writes
(`extract.*`'s target variable, an inline `script.*`'s `pm.environment.set`) cannot land in
the run's shared scopes the way a design send's or the sequential run's does - two VUs
writing the same name would be reading and overwriting each other's state. Each `VirtualUser`
instead carries a small `ScopeOverlay`: a handful of names this VU has written, cleared at
every iteration boundary exactly `cookies` is. The run's shared scopes are flattened once at
setup (`flatten_variable_scopes`); the residual-token pass (`resolve_residual_tokens`, see
[`architecture.md`](architecture.md)) reads a copy of that flattened map with the VU's overlay
merged on top - proportional to what the VU actually wrote, not to the run's whole variable
set. An inline script needs the full, mutable scopes `pm.environment.set` writes through, so
it runs against a `materialize`d copy (base scopes plus the VU's prior overlay) and whatever
comes out replaces the VU's overlay wholesale - equivalent to a diff, since the copy already
started as "base plus every override this VU has made so far."

**One `ScriptEngine` per thread, not a shared pool.** Every load run's worker threads - the
strategy thread and each event-loop worker - are spawned fresh for that run and joined before
it retains, so `vayu::http::routes::script_engine_for_this_thread` constructs one lazily on
first use and is never stale, never shared across runs, and never a caller-visible lock.

**`elements.includeScriptTime`.** A step's recorded latency is its transfer alone by default -
an inline element runs after `Client::send`'s own timing already stopped and before
`StepHistograms::record` - so opting a script in does not, by itself, change what the latency
figures measure. Setting the run's `elements.includeScriptTime` folds the pipeline's own
elapsed time back in for anyone who wants the scripted cost in the figures.

**Per-step tallies.** `scenario.steps[i].elements[] = { id, kind, passed, failed, skipped }`
beside the existing `tests` node, one row per element that ran at least once this run -
`StepElementTallies`, sized once from the plan's compiled elements so recording on the
completion path is a lookup, never a lock or an allocation.

**A controller's skip, under load too (issue #1515).** `control.if` / `control.once` /
`control.throughput` write the same `ScriptControl::Skip` a script's own `skipRequest()` would -
before #1515 the load path had nothing to read that decision at all (`pm.execution.*` is refused
there outright). `submit_one` now checks it right after `step.before` runs: a skip never reaches
`EventLoop::submit`, the VU still advances exactly as a sent step would, and the run's
`steps_skipped` counter (`ScenarioLoadState`) feeds the summary's `skipped` key, which every
scenario load run reported as a hardcoded `0` before this.

**Timers, wired end to end (issue #1498).** `elements.timers` (`"asConfigured"` (default) |
`"off"` | `{fixedMs: N}` | `{minMs, maxMs}`) is validated on `POST /runs`, parsed into
`RunContext::timers_override` (a `vayu::core::TimersOverride`), and applied through the one
function every `timer.*` kind calls, `vayu::core::apply_timers_override` (`elements/pipeline.cpp`)
- `"off"` silences the wait entirely (`waitedMs: 0`, no sleep), `fixedMs`/`{minMs,maxMs}` replace a
kind's own computed wait with the run-wide one, whatever that kind's own config says. This also
fixed a pre-existing dead-code bug: `RunContext::timers_disabled` was parsed from `"off"` since
#1495 but nothing read it, because `timer.think`'s `step.between` phase was never dispatched on the
load path at all. It is now: `ScenarioLoadDriver::run_step_between` (`scenario_load.cpp`) dispatches
`Phase::StepBetween` on the step that just completed, non-blocking, and sums the outcomes'
`waited_ms` into `VirtualUser::ready_at_ms`. `elements.seed` (a non-negative integer) seeds the
run's own `std::mt19937_64` (`RunContext::rng`); a scenario load run derives one independent
generator per virtual user off it (`vayu::core::derive_vu_rng`) rather than sharing one across
worker threads, so a seeded run's random waits are reproducible.

**Non-blocking waits: `scheduled_ready_delay_ms`.** `Element::scheduled_ready_delay_ms` (issue
#1498) is how a kind that needs to wait tells a scenario load run to hold its VU back without
blocking a worker thread: `timer.think` (whose wait already lands through `step.between`'s own
dispatch above) needs no override, but `timer.pacing` does, since its phase (`step.before`) fires
only once a VU has already been selected as ready - too late to defer non-blockingly.
`ScenarioLoadDriver::finish_step` calls the override on the VU's *upcoming* step, right after
deciding which step comes next and before the VU can be selected again, and applies the returned
delay to `VirtualUser::ready_at_ms`, which already gated VU selection but, before #1498, had
nothing writing to it. Per-node "last started" timestamps live in `VirtualUser::pacing_state`
(one map per VU, so VUs pacing the same folder run independent cadences) for load, and in
`RunContext::pacing_state` for the sequential run.

**Still not wired: step-level elements on the single-request load path.** `load_strategy.cpp`'s
per-submission and per-completion hooks are unchanged: a single-request `POST /runs` payload's
own request has no `elements` attachment point today (its script model is still the legacy
`tests` string, `RunContext::test_script`, not a compiled `elements` list), so there is no
element pipeline call there to gate on inline-vs-deferred - a `ScopeOverlay` would have no
writer. Wiring a stored request's `elements` into that run shape is a separate gap, outside this
page's Status callout. What issue #1573 *does* wire for this run shape is the two kinds that
dispatch at a run's own boundary rather than a step's: `lifecycleElements` (previous paragraph)
lets a single-request run declare `script.setup` / `script.teardown`, run once before the load
starts and once after it ends, the same `Phase::RunStart` / `Phase::RunEnd` dispatch a
collection-backed run uses.

## Related issues

- #1513 - this page's storage, registry and catalogue.
- #1514 - the pipeline in the design send and the sequential run, the phase-0 behaviour kinds
  (`extract.*`, `assert.*`, `timer.think`, `script.*`), per-element outcomes in the step trace, and
  the script-to-elements cut-over (this page's Status callout).
- #1495 - the pipeline on a scenario load run's producer/completion hooks (this page's Load
  paths section).
- #1497 - the `maxAssertionFailureRatePct` run threshold and `thresholds.failRun`, over the
  combined `assert.*` element and `pm.test` tally (see `api-reference.md`'s thresholds section).
- #1564 - the same `thresholds` block, evaluated for a collection (sequential) run too, not
  only a load run.
- #1498 - `timer.think`'s gaussian option, the `timer.pacing` kind, a per-run seeded RNG
  (`elements.seed`) and the `elements.timers` override wired end to end (this page's Timers
  paragraphs and Load paths section). `timer.pacing`'s `perUser: false` under load and
  `timer.throughput` (a constant-throughput, shared-rate timer) are deliberately deferred to a
  follow-up issue.
- #1499 - `script.setup` / `script.teardown`, the `run.start` / `run.end` dispatch this page's
  Kinds section describes, in both collection-backed run modes. Deliberately did not wire a
  single-request load run's `POST /runs` to declare either kind - that shape has no collection to
  declare them on; the wire-shape gap it left is #1573.
- #1573 - `lifecycleElements`, a single-request `POST /runs` payload's own ephemeral place to
  declare `script.setup` / `script.teardown` (this page's Kinds section and Load paths section).
  Does not wire step-level elements (`extract.*`, `assert.*`, `timer.*`, `script.pre`/`.post`)
  into the single-request load path - that remains the Load paths section's "still not wired" gap.
- #1515 - the controller family (`control.if`, `.once`, `.switch`, `.throughput`, `.loop`,
  `.transaction`), the load path's own `steps_skipped` counter, and `scenario.transactions[]`
  (this page's Controllers section).
- #1569 - the follow-up disclosed by #1515: a scenario load run's own jump/repeat mechanism for
  `control.switch` / `control.loop`, `control.throughput`'s shared `perUser: false` budget, and
  `control.transaction`'s `includeTimers`.
- #1500 - `metric.record` and the `pm.metrics` script binding: custom trends, counters and
  rates, reported beside the built-in phases and usable as a `custom.<name>.<stat>` threshold.
- #1501 - load-time cookies that round out the kind table.
- #1516 - the app's `ElementList` primitive and editor.
- #1517 - MCP's `elements` fields and the `vayu://elements/kinds` resource.
- #1518 - Postman/OpenAPI round-trip and a JMeter `.jmx` importer.
