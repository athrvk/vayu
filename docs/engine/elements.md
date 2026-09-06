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

> **Status:** issue #1513 lands the storage, the registry and the catalogue below. No kind runs
> yet - the pipeline that executes an element in the design send, the sequential run and the load
> paths is issues #1514 and #1495. Until then, `pre_request_script` / `post_request_script` keep
> driving execution exactly as before; `elements` sits beside them (see
> [`db-schema.md`](db-schema.md#the-script-to-elements-fold-issue-1513)).

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

Phase 0 registers no *behaviour* kind - only `inherit.disable` (validated, never run; consumed
directly by `POST /compose`'s chain resolution) and, in the test binary only, a `test.echo` kind
proving the registration path itself. The table below is the single reference for every kind that
exists once the rest of the epic lands, generated from or checked against the registry so a kind
added on one side and forgotten on another fails a test rather than shipping silently mismatched.

| Kind | Category | Phases | Runs since |
|------|----------|--------|------------|
| `inherit.disable` | inherit | (consumed at compose time, not a phase) | #1513 |

## Related issues

- #1513 - this page's storage, registry and catalogue.
- #1514 - the pipeline in the design send and the sequential run, the phase-0 behaviour kinds
  (`extract.*`, `assert.*`, `timer.think`, `script.*`), per-element outcomes in the step trace.
- #1495 - the pipeline on the load paths.
- #1497, #1515, #1498, #1500, #1499, #1501 - the assertion threshold, controllers, timers,
  metrics, setup/teardown and load-time cookies that round out the kind table.
- #1516 - the app's `ElementList` primitive and editor.
- #1517 - MCP's `elements` fields and the `vayu://elements/kinds` resource.
- #1518 - Postman/OpenAPI round-trip and a JMeter `.jmx` importer.
