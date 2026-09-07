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
> that section for why.

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
| `timer.think` | timer | `step.between` | #1514 |
| `script.pre` | script | `step.before` | #1513 (validate-only), #1514 (runs) |
| `script.post` | script | `step.after` | #1513 (validate-only), #1514 (runs) |

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
an `op`. `timer.think` takes `ms`, or `minMs`/`maxMs` for a uniform random wait; it runs in
`step.between`, after this step's own outcome is decided and before the next step begins, so the
wait never counts against either step's latency, and it polls the run's stop signal every 50ms so a
`Stop` mid-wait lands promptly rather than at the end of a multi-second think.

The JSON-reading kinds (`extract.json`, `assert.jsonpath`) share one parse of the response body per
step, through `ElementContext`'s lazily filled slot - a body over `maxElementBodyBytes` (default 1
MiB) is not parsed, and every such kind on that step reports `skipped` with the reason.

`script.pre` / `script.post`'s `apply` never touches `ScriptEngine` itself: it calls back into
`ElementContext::run_pre_script` / `run_post_script`, which the caller (`execute_exchange`, and the
streaming send's own inline pipeline calls) binds to the exact `execute_script` call design mode has
always made. The element's own outcome is whether the script ran without throwing; the script's own
`pm.test` assertions travel inside the same `vayu::ScriptResult` untouched, so a scripted step's
trace shape is unchanged by this cut-over.

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
**declarative** kind (`extract.*`, `assert.*`) always runs at both points, read off the
kind's registered `hotPath`, never a `kind ==` comparison (the extensibility contract's rule
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

**Not yet wired: timers.** `elements.timers` (`"asConfigured"` | `"off"`) is accepted and
validated on `POST /runs` and stored on `RunContext`, but nothing reads it to suppress
`timer.think` under load yet - #1498 ("the timer family... the run-level Timers override end
to end") owns finishing that wiring, since `timer.think`'s current `step.between` phase and
blocking wait are sequential-run-only and unreachable from the load hooks above by
construction. `ready_at` plumbing (`VirtualUser::ready_at_ms`, a `take_ready_vu` skip) exists
for #1498's `timer.pacing` to write into; nothing writes it yet.

**Not yet wired: the single-request load path.** `load_strategy.cpp` is unchanged: a
single-request `POST /runs` payload has no `elements` attachment point today (its script model
is still the legacy `tests` string, `RunContext::test_script`, not a compiled `elements` list),
so there is no element pipeline call there to gate on inline-vs-deferred - a `ScopeOverlay`
would have no writer. Wiring a stored request's `elements` into that run shape is a separate
gap, outside this page's Status callout.

## Related issues

- #1513 - this page's storage, registry and catalogue.
- #1514 - the pipeline in the design send and the sequential run, the phase-0 behaviour kinds
  (`extract.*`, `assert.*`, `timer.think`, `script.*`), per-element outcomes in the step trace, and
  the script-to-elements cut-over (this page's Status callout).
- #1495 - the pipeline on a scenario load run's producer/completion hooks (this page's Load
  paths section).
- #1497, #1515, #1498, #1500, #1499, #1501 - the assertion threshold, controllers, timers,
  metrics, setup/teardown and load-time cookies that round out the kind table.
- #1516 - the app's `ElementList` primitive and editor.
- #1517 - MCP's `elements` fields and the `vayu://elements/kinds` resource.
- #1518 - Postman/OpenAPI round-trip and a JMeter `.jmx` importer.
