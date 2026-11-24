---
description: >-
  `pm.info` and the setup and teardown scripts: who a script is told it is and when each kind runs.
---

# Script identity, setup and teardown

## Script Identity (`pm.info`)

What the script is attached to, and which hook is running it.
Six fields, each **optional** - `pm.info` is always an object, but a field with no truthful value is absent rather than `""`, so `typeof` is how a script tests for one:

```javascript
pm.info.requestId      // string | undefined - the saved request this send is filed under
pm.info.requestName    // string | undefined - its name, as the client sent it
pm.info.eventName      // 'prerequest' | 'test' | 'setup' | 'teardown'
pm.info.iteration      // number | undefined - 0-based, in a run of any shape
pm.info.vu             // number | undefined - 1-based, the virtual user that sent it
pm.info.iterationCount // number | undefined - the run's iteration total
pm.info.run            // object | undefined - a run summary, `script.teardown` only (see below)
```

`eventName` is stamped by the engine at each hook (`ScriptContext::for_prerequest` / `for_test`), never by the caller, so it cannot disagree with the hook that is actually running.
The other two are supplied per send:

- `requestId` is the payload's `requestId`, which is also what files the run in History.
  Absent for an ad-hoc send (MCP's `run_request` without one, a load run started from a URL).
- `requestName` comes from the payload's `requestName`, falling back to the stored row's name when only an id was sent.
  The client sends it because Send executes *editor state*: an unsaved request has a name and no row to read it from, and a name edited but not yet saved should read as what the user sees.
  `POST /compose` fills it in on its by-id path, so a composed payload arrives carrying it.

**`iteration` is reported wherever a real one exists, and nowhere else.**
In a design-mode scenario run (`POST /runs` with a `scenario` block and no `mode`) every step's scripts read the real index - `iteration` counts from 0, and it reads as `0`, not as absent, on the first pass.
A **scenario load run**'s deferred per-step script reads it too: each sampled response carries the virtual user's iteration it was actually sent in, so the number is a fact about that response rather than its position in a reservoir.

**A single-request load run reports one too, since issue #994.**
It does not read `undefined` there: a *reservoir position* is not an iteration, and this is not one - each submission claims its index before it is sent, and the index travels with the response into the sample, exactly as `dataRowIndex` does.
It is the same counter the run's data rows are claimed from, so a script grading a sampled response can say which iteration produced it and which row it carried, and the two agree.
An ordinary Send still reads `undefined`: one request is not a pass of anything.

**`vu` is the virtual user that sent the request, 1-based.**
It spans the run's concurrency in a scenario load run, where each user walks the sequence with its own cookies and its own iteration counter.
Everywhere else it is `1`, and that is a statement rather than a placeholder: a single request repeated under load is one user's iterations however many are in flight, and so is a collection run in design mode.
`undefined` on an ordinary Send, beside `iteration`.

**`iterationCount` is set by the collection runner, and by a send that bound a row.**
The runner reports the run's total; a send-with-row reports `1`, since that send is row 0 of 1 and says so about `iteration` already (see [Data rows](execution-metrics-data.md#data-rows-pmiterationdata)).
A **load run** is where it stays `undefined`: a duration-bounded run has no iteration total to report, and a field readable from one load run and not another is worse than one that is never readable there at all.

## Setup and teardown scripts

`script.setup` and `script.teardown` are elements a collection carries directly (never a request), run once each at the run's own boundary rather than at any step - `run.start`, before the first step or submission of either run mode, and `run.end`, after the last one.
They exist for the same reason k6's `setup()` / `teardown()` and JMeter's setUp / tearDown thread groups do: fetch a token or seed data once for the whole run, and clean up once after, without a script attached to every request paying for it.
See [`elements.md`](../elements.md#kinds) for the element mechanics (dispatch, phases, placement) - this section is what the two scripts see as scripts.

**Whose scripts run** (#3456): every collection above the one being run, the collection being run, and, when the run includes nested collections, every folder beneath it.
Setups run once at the start in that order: the root first, down to the collection being run, then the folders beneath it in the order the sidebar shows them, a folder before the folders nested in it.
Teardowns run once at the end in exactly the reverse order.
So running a sub-folder alone still runs its root collection's setup first, and running the root with nested collections included runs each folder's setup and teardown too.
A run that does not include nested collections sends only the collection's own requests, so no folder beneath it takes part.
The set is read once when the run starts: a folder added, moved or deleted mid-run changes neither end.
Each row of the report's `lifecycle` names the collection it came from in its `origin` (`{kind: "collection", scope: "collection" | "folder", id, name}`), so the report says whose setup ran.

Both read and write the same three variable scopes every other script does (`pm.environment`, `pm.globals`, `pm.collectionVariables`) - a name `script.setup` sets is visible to the very first step or submission of the run, because it writes through the same scopes object every other script of that run shares, before either run mode's own work begins.
A load run's deferred test replay reads it too: the replay starts from a copy of the scopes setup left (#3460), so a replayed write never reaches what teardown reads.
A collection's setup and teardown read the chain down to that collection and write that collection's variables, as a step in it does, so a folder's setup writes a value that folder's own steps (and the folders below it) read.
`pm.info.eventName` reads `'setup'` / `'teardown'`; neither script has a `pm.request` or a `pm.response` to read, since neither runs against a particular step.
`pm.execution` throws the same "not available here" sentence a non-scenario script already gets: there is no sequence position to redirect from a run's own boundary.

**`script.teardown` alone sees `pm.info.run`** - a summary of the run it is cleaning up after, since it is the one script that runs after there is one to report:

```javascript
pm.info.run.requestsSent      // number - completed submissions, whole run
pm.info.run.errorRate         // number - percent, whole run
pm.info.run.assertionsPassed  // number
pm.info.run.assertionsFailed  // number
```

On a load run `errorRate` is the figure the report prints, by the [one error definition](../api-reference/metrics.md#what-counts-as-an-error); on a sequential collection run it is the share of steps that errored.

**A throwing `script.setup` fails the run before anything is sent.**
Its outcome is checked the same way any element's is (`"error"` fails the check); the run reaches `Failed` before either run mode's strategy starts, so nothing is sent and no duration is measured.
The failed run's report still carries `lifecycle.setup`, every setup that ran up to and including the refusing one, with its outcome, message and `origin`, so it says which collection's script failed and why (#3455).
Setups are checked a collection at a time: once one collection's setup refuses, the collections after it set up nothing, and no teardown runs.
The engine log's record of the refusal leads with the same collection, `folder '<name>': <message>` (or `collection '<name>'` for the root, the id where it has no name; a single-request run's `lifecycleElements` name none).
**A throwing `script.teardown` is recorded and does not change the run's status** - it appears under the report's `lifecycle.teardown`, exactly as a passing one does, just with an `"error"` outcome and the thrown message, and the collections above it still tear down after it.
A script that only fails a `pm.test` is `"failed"` rather than `"error"`, with the first failing test as its message, and a failing test in `script.setup` fails the run the way a throw does.
Either script's `console.*` lines and test results are kept on its `lifecycle` row, as `console` and `messages` lists (the first ten distinct entries, a repeat counted once with a `count`), so they can be read after the run.

**What `script.teardown` writes is saved only by a design run** (#3249).
A collection run writes its variable scopes back once, after teardown, so a `pm.environment.set` or `pm.globals.set` there reaches the stored environment and globals along with every step's; `pm.variables.set` is the run's local scope and is never saved.
A load run saves no variable at all, so a teardown write there ends with the run.

**Neither script's own time counts toward the run's duration figures.**
Setup runs, and is timed out of the way, before either run mode captures its own `test_start`, which is also where a load run's live `elapsedSeconds` starts counting (it reads `0` while setup runs); teardown runs after the load path's `test_end` is already captured, and after the sequential run's own step loop has finished.

**`pm.sendRequest` follows the run's own gate, with no separate toggle.**
Vayu's MCP target allowlist is what makes every script-issued request refuse by default (see [Sending a request from a script](send-request.md#sending-a-request-from-a-script-pmsendrequest));
a setup or teardown script is bound to the same `ScriptEngine` instance, and therefore the same `allowScriptRequests` decision, every other script of the run already answers to - there is no `script.setup`-only opt-in to reach for, and the same **10 requests per script** cap applies.
The fetch also inherits what every other script of the run sends under (issue #2841): the run's `timeout` (else `defaultTimeout`) when it names none of its own, the run's response byte bound, transport policy and default headers - see the [bounds](send-request.md#sending-a-request-from-a-script-pmsendrequest) below.
