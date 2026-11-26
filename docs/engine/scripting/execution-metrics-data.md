---
description: >-
  `pm.execution` flow control, `pm.metrics` custom metrics and `pm.iterationData` data rows.
---

# Flow control, metrics and data rows

## Flow control (`pm.execution`)

Inside a collection run (`POST /runs` with a `scenario` block), a script can say where the sequence goes next:

```javascript
pm.execution.setNextRequest('Checkout');  // run that request next, after this one finishes
pm.execution.setNextRequest(pm.info.requestId); // the same jump, by id
pm.execution.setNextRequest(null);        // end this iteration; the next one still runs
pm.execution.setNextRequest('null');      // the quoted form Postman reads the same way
pm.execution.skipRequest();               // pre-request only: do not send this request
```

**The script records an intent; the runner acts on it.**
Neither method reaches into the run - they set a value on the script's result, and the runner, the only thing that knows what a sequence is, reads it once the step has finished.
So `setNextRequest` does not abort the current request: it completes, its tests run, and the jump happens afterwards.
The last call in a script wins, across the pre-request and test scripts alike.

**A script that errored loses its instruction.**
When either of a step's scripts throws (or times out, or has its `pm.request` write-back refused), the step is `errored` and the iteration carries on at the **next plan position**: a `setNextRequest`, `setNextRequest(null)` or `skipRequest()` the script made before failing is ignored, because it came from code that did not finish.
A skip the pre-request script asked for has still happened - nothing was sent - but where the iteration goes next is the plan's order, not the script's.
`stopOnError: true` on the run ends the iteration at that step instead (see [api-reference/scenario-runs.md](../api-reference/scenario-runs.md#scenario-runs), Outcomes).
A step that errors this way runs no `step.between` element either, so a `timer.think` or a `control.loop` decision after it does not happen for that step.

`setNextRequest` takes a request's **name** or its **id** - the one a script reads off `pm.info.requestId` - never its URL, and jumping backwards is allowed: that is how a retry loop is written.
A target is resolved against the names first and the ids second, so a request whose *name* happens to be another request's id sends the jump to the request you can see in the sidebar.

The string `'null'` is the stop form, exactly as the real `null` above is - Postman's runner reads it that way, and the quoted spelling is common in collections written against it.
The one exception is a run that carries a request actually **named** `null`: a name the run carries is the more specific answer and wins, so that request stays reachable.

### Where it throws

Every one of these is a thrown error naming the reason, not a call that is accepted and quietly dropped.
A binding that cannot fail is worse than a missing one: `setNextRequest('checkout')` ignored in a single send is a script that reports success for something that never happened.

| Call | Where | What happens |
|------|-------|--------------|
| Either method | A single Send (`POST /execute`) | Throws - there is no next request |
| Either method | A load run's deferred `tests` script, and a scenario load run's deferred per-step script | Throws - the script runs after the run finished, against a recorded response, and cannot redirect a sequence that already happened |
| Either method | A scenario load run's inline `script.pre` / `script.post` | Throws - a load run's sequence is redirected by `control.*` elements only, and the step counts as `errored` (#2947) |
| `skipRequest()` | A test script inside a collection run | Throws - the request has already gone out; there is nothing left to skip |
| `setNextRequest()` | Anywhere | `TypeError` - the argument is required. Omitting it is not a synonym for `null` |
| `setNextRequest(3)`, `setNextRequest('')` | Anywhere | `TypeError` - a target is a non-empty string, or `null` |

### Where the step fails instead

Two cases are the runner's to refuse, because only it can see the plan.
Both end the iteration with the step marked `errored` and the reason in its row, whatever the run's `stopOnError` says - unlike a script that threw, which the iteration continues past:

- **A target no request in the run answers to**, by name or by id.
  The message names the target and says both were searched.
- **A name two or more requests share.**
  The message names every step that answers to it, so the fix - rename one - is obvious.
  Resolving to the first match would run a sequence nobody asked for.

### The cycle bound

`setNextRequest` makes an infinite loop a two-line script, so an iteration has a ceiling: **`maxStepsPerIteration`** (config, `limits`).
Its default of `0` derives the bound from the collection - ten times its request count, and never fewer than 100 - so a straight-through iteration can never trip it, and a legitimate retry loop in a short collection has room.
Exceeding it fails that step with a message naming the steps that were looping; the run continues with the next iteration and still reaches a terminal status.

### Skipped is never passed

A skipped step is stored and reported as `skipped` - its own count in the run summary, its own outcome on the step's `results` row and on the SSE `step` event.
Its row carries the request it would have sent and **no response**, because there was none; the app's step list shows that rather than an empty `200`.

## Custom metrics (`pm.metrics`)

A script can record a named value beside the run's built-in phases (issue #1500) - the scripted counterpart of the `metric.record` element (`elements.md`):

```javascript
pm.metrics.trend('ttfb', pm.response.responseTime);      // one distribution sample
pm.metrics.counter('bytesOut', pm.response.size().total); // added to a running total
pm.metrics.counter('hits');                                // increment defaults to 1
pm.metrics.rate('cacheHit', pm.response.headers.get('X-Cache') === 'HIT'); // one true/false sample
```

`trend` reports as a distribution (`count`/`p50`/`p95`/`p99`/`max` in the report's `customMetrics.<name>`); `counter` is a running total, added to on every call, reported as `value` beside a `count` of calls (#1937), so a counter only ever given `0` is still recorded and is judged by a `custom.<name>.value` threshold; `rate` is the percentage of calls whose value was true.
All three share the same 32-distinct-name cap the `metric.record` element does (`api-reference/collection-runs.md`'s `customMetrics` section), across every name either surface records under -
a script that introduces a 33rd name past what the collection's own `metric.record` elements already declared has that call silently do nothing, since the cap is enforced loudly only where it can be, at `POST /collections` / `POST /requests` validate time for a *declared* `metric.record` name.

### Where it throws

The same false-success reasoning `pm.execution` documents: a call accepted and quietly dropped is worse than one that says why it cannot run.

| Where | What happens |
|-------|--------------|
| A single Send (`POST /execute`) | Throws - there is no run to record into |
| A load run's deferred `tests` script, and a scenario load run's deferred per-step script | Throws - a replayed sample is not the run itself |
| `trend(name, value)` / `rate(name, value)` with fewer than two arguments, or an empty `name` | `TypeError` |
| `counter(name)` with an empty `name` | `TypeError` |
| `counter(name, increment)` with a negative, `NaN`, infinite or non-numeric `increment` (an explicit `undefined` is the default `1`) | `TypeError`, and nothing is recorded |

Everywhere else - the sequential run, a scenario load run's inline `step.before`/`step.after` hooks, and design mode's `script.pre`/`script.post` - all three methods record into that run's own collector, the same `MetricsCollector::record_custom_metric` the `metric.record` element writes through.

## Data rows (`pm.iterationData`)

A run can be given a set of rows - a CSV, TSV, JSON or JSONL file the app parses and sends inline on the run payload ([the file format](../../app/data-driven-runs.md)).
A collection run states them as `scenario.data` and a single-request load run as the top-level `data` (issue #993).
**Row `i % rows` binds to iteration `i`** - for a single request an iteration is one submission - and that row is what `pm.iterationData` reads:

```javascript
pm.iterationData.get('username');  // this iteration's value for that column
pm.iterationData.has('coupon');    // whether the row carries that column
pm.iterationData.toObject();       // the whole row as a plain object
```

`get` on a column the row does not carry returns `undefined`, as every other `pm` scope reader does.
Values keep their JSON type: a JSON file's `3` arrives as a number, and a CSV column arrives as a string, because that is what the file said - unless the file was picked with number reading on, which hands a script an unquoted integer or decimal cell as a number (#2540).

**The row reaches a request through a different channel, with a different type story.**
`pm.iterationData` hands a script the cell as the value it is - a number stays a number, a `null` stays `null`, and a branch can read either.
`{{data.column}}` (see [api-reference/scenario-runs.md](../api-reference/scenario-runs.md#scenario-runs)) hands the *request* the cell as **text**, because a URL, a header and a body are text; its type only survives where the surrounding document has types of its own, which is why placement inside or outside a JSON string literal is what decides whether `{{data.n}}` arrives as `2` or `"2"`.
The two also disagree about `null` on purpose: a script may branch on it, while a token that substituted it would write nothing where a value belonged, so the bind errors instead.
An optional column belongs on this side of the line.

`has` answers presence, the same way `pm.environment.has` and its siblings do.
A column whose value is `null` is `true` - the row carries it - which is the fact `get` alone cannot state without the reader knowing that an absent column comes back as `undefined` while a null one comes back as `null`.

**A single send can bind one row too** - `POST /execute` takes an optional `data` object (one row, not the array a run sends), which is what the request builder's **Send with row** does and what MCP's `run_request` exposes as `data`.
Both scripts then read it as `pm.iterationData`, and `pm.info.iteration` is `0` with `pm.info.iterationCount` `1` - the send *is* row 0 of 1.
This is how a script that reads a row gets an edit loop that is not "start a run, find the step, read the result"; the row binds `{{data.column}}` in the request as well.
See [api-reference/execute.md](../api-reference/execute.md#post-execute).

**`pm.iterationData` is `undefined` where there is no row** - an ordinary Send, and any run started without a data set.
Where a run *was* given rows, its deferred script reads one whichever shape the run took: a sampled response carries the row the submission or iteration that produced it was bound to, so the row is a fact about that response rather than a guess.
(`pm.info.iteration` and `pm.info.vu` travel the same way and are populated on both shapes since issue #994 - what a sample carries is the identity its submission claimed before it was sent, never its position in a reservoir.)
An **inline** `script.pre` or `script.post` under load reads the same three as the request it runs beside, on both shapes (#3124): the row through `pm.iterationData`, its bare columns through `pm.variables.get` and `{{data.column}}` through `pm.variables.replaceIn`, beside `pm.info.iteration` and `pm.info.vu` - so a script that correlates under load sees the row its own URL was bound with.
Without rows `pm.iterationData` stays `undefined` there too, while `iteration` and `vu` are still set.

That is deliberate, and it is the opposite treatment to `pm.execution` above: flow control is a *capability*, and one that silently does nothing is a false success, so it is always bound and explains itself.
A data row is *data*, and "this run is not data-driven" is a fact a script may legitimately branch on:

```javascript
const user = pm.iterationData ? pm.iterationData.get('username') : 'default-user';
```

A stashed reference (`globalThis.saved = pm.iterationData`) does not reach a later script at all: every script runs in a context built for it (see [Isolation between scripts](sandbox.md#isolation-between-scripts)), so `globalThis.saved` is `undefined` there.

**To put the row into the request itself, use `{{data.column}}` - or, while a row is bound, the bare column name - instead.**
A script reads `pm.iterationData` *after* its step's request was composed, so it cannot change where the request goes without editing `pm.request` by hand.
The reserved `data.*` namespace does that directly: a URL, header, body, form field or **credential** carrying `{{data.email}}` has it substituted with the iteration's row immediately before the send.
It is a namespace, not a variable scope - it cannot be read or written through `pm.variables` - and it is documented under [Scenario runs](../api-reference/scenario-runs.md#scenario-runs).
**A bare `{{email}}` binds the same way while a row is bound** (issue #1007), and unlike the prefixed spelling it *is* readable through `pm.variables.get("email")` too - see [`pm.variables`](variables.md#variables-pmvariables) above.

The substitution is written for the place it lands in: a token inside a JSON or XML body is escaped for that document, and a cell carrying a line break bound into a **header** - a header name, a header value, or a credential written into a header line - is refused rather than allowed to end the header line and forge one of its own.

### It is read-only

`set`, `unset` and `clear` are bound and **throw**.
The rows are an input to the run, not a variable scope: there is no destination a write could land in, the next iteration binds a different row regardless, and accepting the value would report success for something that vanished.
Carry a value forward with `pm.environment`, `pm.collectionVariables` or `pm.globals`.

### How many iterations, and which row

With `data` present and `iterations` absent, the run performs **one iteration per row** (Postman's default).
With both given the explicit count wins and the row index wraps - five iterations over three rows read rows 0, 1, 2, 0, 1.

The wrap is not silent: every step's `results` row and every `step` SSE event carries **`dataRowIndex`**, and the app's step list shows it beside the iteration ("Iteration 4 · Row 1").
`pm.info.iteration` reports the pass; `dataRowIndex` reports the row, and with a wrap the two deliberately disagree.

Rows are validated before the run row exists: a `data` that is present and empty, a row that is not an object (the message names its index), or a set over `maxScenarioDataRows` is a `400`.
Rows are never persisted - the run's snapshot records the row count (`dataRowCount`) plus the file's name and content hash (`dataFileName`, `dataFileHash`) and how it was read (`dataFileCastNumbers`), never its path or rows.
