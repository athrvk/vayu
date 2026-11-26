---
description: >-
  When each kind of script runs - pre-request, test, load test and script elements - and what each can see.
---

# Where each kind of script runs

## Script Execution Context

### Pre-request Scripts

- Execute before sending the HTTP request
- Can modify `pm.request` - method, url, headers and body - and the edits are applied to the request that is sent ([rules](request-mutation.md#mutating-the-request-pre-request-scripts))
- Can access `pm.environment`, `pm.collectionVariables` and `pm.globals`
- Cannot access `pm.response` (request hasn't been sent yet)
- `pm.info.eventName` is `"prerequest"` here
- Run in Design Mode / Send and in a collection run.
  Under load a pre-request script runs only when it is opted in inline (`config.inline: true`, or the run's `elements.scripts` override; see [Script elements](#script-elements-design-send-and-the-sequential-run) and [Load Test Scripts](#load-test-scripts)).
  A step that is not inlined is not silent about it (issue #1503): a load run reports each as `preRequestScript: "skipped"` in its `scenario.steps` breakdown, and the run's `warnings` array carries one line naming how many steps did (see [api-reference/load-runs.md](../api-reference/load-runs.md#the-scenario-block-collection-runs)).

### Test Scripts (Post-request)

- Execute after receiving the HTTP response
- Can access `pm.request` (read-only here - it has already been sent) and `pm.response`
- Can access `pm.environment`, `pm.collectionVariables` and `pm.globals`
- `pm.info.eventName` is `"test"` here
- Test results are included in the response

### Load Test Scripts

- Test scripts in load tests are executed **deferred** (after test completion)
- Only a sample of responses are validated: 1 in `response_sample_rate` completions, retained up to `max_response_samples`.
  The retained set is a **uniform sample of the whole run**, not its opening - past the bound a later response displaces a uniformly chosen incumbent, so a target that starts failing halfway through is graded on those failures rather than on the healthy window before them
- The app tells the user this before Start: the load-test dialog's "Tests run afterwards, on a sample" notice names the defaults (1 in 100 responses, at most 1,000) and that `assert.*` elements still check every response
- A second bound applies to the same store: `max_response_sample_bytes` (`maxResponseSampleBytes`, 256 MiB by default) is the whole-run budget for the retained bodies, because each is kept **whole** and a target answering 1 MiB responses would otherwise put ~1 GB in that store.
  Past it a sample is dropped entire rather than truncated - a script reading a cut body would fail a response the target got right - and the drop is counted the same way, in `sampling.responseSamplesDropped`
- **A run that spends that budget is graded on the part of it that fit**, not on a uniform sample: the count cap displaces incumbents and stays uniform, while an exhausted byte budget simply stops admitting.
  Only a target whose retained bodies average more than ~256 KiB reaches it at the defaults; raise `maxResponseSampleBytes`, or lower `max_response_samples` so fewer, later responses share the budget, if that matters for the run you are grading.
  The report says which one happened: `sampling.responseSampleBudgetSpent`
- `samplesTested` in the report (`TestsSampled`) is the **size of that sample**, not the run's request count, and `sampling.responseSamplesDropped` beside it says how many responses the bound thinned away.
  It counts the samples the replay reached, so it is smaller than the sample when a Stop ended the replay (below)
- **A Stop or the engine shutting down ends the replay** (#3460).
  The script running when it lands stops at its next interrupt poll, which is no verdict on it, and no sample after it is replayed; the run settles within the Stop's 5 s grace rather than after every remaining sample's `scriptTimeout`.
  A Stop that lands before the replay begins (one during the sending) replays nothing, and the report then has no `testValidation` rather than one of zeros.
  The run keeps the end it would have had: a Stop after the sending ended still leaves it `completed`
- **A script that times out is not replayed against the rest of the sample** (#3460): its deadline is its own, so each sample after it would wait it out again, and at the 5 s default a thousand samples is most of an hour.
  Its one failure says so, `Script error: Script execution timed out after 5000ms (timed out, not replayed against the remaining 999 samples)`, and the replay's other scripts still run against every sample
- Results are aggregated and reported in the final report: `testsPassed` / `testsFailed` tally every `pm.test` call across every sampled response, so a script whose assertions are a mix of passing and failing reports both counts and names each failing assertion (`name: message`) rather than collapsing the sample to one opaque failure.
  Only a script that threw before any `pm.test` ran reports a single script-level failure, carrying the thrown message (issue #1502)
- The failing assertions are also stored by name, **once each**: a script that fails the same way on every sampled response is one failure that happened N times, not N failures (issue #3127).
  The run's validation result row (`results[]`, the one whose `trace` carries `failures`) holds `failures` (distinct messages in first-seen order, at most 10), `failureCounts` (the same length: how many times each failed),
  `failuresDistinct` (every distinct message, kept or not, so `failuresDistinct - failures.length` were turned away), and `totalFailed` / `totalPassed`, which count every occurrence -
  the `failureCounts` always sum to `totalFailed` when nothing was turned away.
  A scenario step's name prefixes its messages (`step name: assertion: ...`) and is part of a message's identity, so the same assertion failing in two steps is two entries.
  The number of responses replayed is `testValidation`'s `samplesTested`, not a field of the row
- `pm.info` reports the same identity a Send does: `eventName` is `"test"`, and `requestId` / `requestName` are the run's linked request when it has one, in an inline `script.pre` / `script.post` as in the deferred replay (#3460).
  It also reports `iteration` - the index the sampled submission claimed before it was sent - and `vu`, which is `1` here because a single request repeated is one user's iterations (issue #994; see [`pm.info`](info-and-setup.md#script-identity-pminfo))
- `pm.request` in the deferred replay is the request each sample was sent as (#3460), re-derived rather than stored: the request the run built, with that submission's row and iteration (a scenario step's virtual user and iteration) bound into it, and every name the bind left resolved against the scopes as `script.setup` left them, as the run's own residual pass resolved it.
  What no sample records is not reproduced: a `script.pre` or other `step.before` element's edit to the request and its own scope writes (an inline one ran on that submission alone, an un-inlined one never ran), a credential refreshed mid-run (the replay reads the one the run started with), and a scenario user's cookies.
  A deferred `script.post` beside an inline `script.pre` that rewrites `pm.request` therefore reads the request before that rewrite
- `pm.response.redirects` is **absent** here, inline or deferred: a load run follows redirects without recording the chain, so there is no list to read and an empty one would claim there was nothing to find (see [`pm.response.redirects`](response.md#pmresponseredirects---the-hops-a-send-followed))
- `POST /runs` no longer takes a `tests` field: it is refused with a `400` naming `requestElements`, like every legacy script field.
  The collection chain's test scripts arrive as `script.post` elements in `requestElements`, ahead of the request's own, so a collection-level assertion is checked under load, not only in design mode.
  Each element not running inline is replayed against every sample as **its own script**, in compile order, the way a Send runs it: a `const` one element declares is not visible to the next, so two that both declare `const json` both run (issue #3125).
  A write to `pm.environment`, `pm.collectionVariables` or `pm.globals` is still read by the elements after it.
  Each element's `pm.test` calls add to the tally, and an element that calls none and does not throw counts as one pass.
  An inline element runs during the run instead (see [Script elements](#script-elements-design-send-and-the-sequential-run) below)
- An inline script's console lines, the error it threw and each failing `pm.test` reach the report as a bounded sample on its element row: the first 10 distinct of each, each with how many times it was seen (`count`, absent when once), and the occurrences that did not fit (see [Console Output](console-and-examples.md#console-output), #3127).
  The deferred replay keeps the same bounded sample of its console lines on the report's `testValidation`, or per step on a scenario step's `tests`; its failures are the validation row above
- For a pre-request script that is **not** inlined, a value it would have set - a token fetched and written with `pm.environment.set` - never reaches a later step or request under load, because the script that would set it never runs (an inline one writes through the virtual user's own overlay, below).
  The `{{token}}` it was meant to fill goes on the wire literally instead of being refused, and since issue #1503 the run counts it: `unresolvedTokens` per step, and one line in the run's `warnings` array naming a few of the affected variables (see [api-reference/load-runs.md](../api-reference/load-runs.md#the-scenario-block-collection-runs))

**All three variable scopes are readable, and none of them is written back.**
A deferred replay reads the run's own environment (the `environmentId` the run was started with), the globals, and the collection chain - the leaf plus its ancestors, exactly as a Send does, so an inherited name answers the same in both modes.
A scenario load run's step reads the chain of its own folder (#3248), as the run itself did, and one set of scopes per collection serves the pass; a single-request run's is the collection of its linked request.
Earlier engines bound an empty environment and no other scope at all, so `pm.environment.get('region')` read `undefined` under load and the same test gave opposite verdicts on Send and under load.

**The replay starts from the scopes as `script.setup` left them** (#3460), not from a fresh read of the stored rows, so a value setup wrote reads the same in a deferred script as in an inline one.
It works on a copy, so `script.teardown` still reads what setup left, whatever the replay wrote.
What a virtual user's or a submission's own inline scripts wrote during the run is not in it: those writes lived in the user's (or the submission's) own overlay, which no sample records.

Writes are the deliberate exception.
A `set()`, `unset()` or `clear()` in a deferred script is visible to the samples replayed after it - one set of scopes serves the whole pass - but **nothing is persisted**: only design mode writes variables back.
A sampled response is not an iteration, so there is no ordering under which "whichever replay ran last wins" would be a defensible thing to store.
If a load run's scripts must leave a value behind, write it in design mode instead.

**A scenario load run validates per step instead.**
It has no run-level `tests` field: each plan step carries its own `script.post` elements, and after the run drains each un-inlined one is replayed, on its own as above, against the responses *that step* produced.
The tallies land on `scenario.steps[].tests` in the report - a whole-run pass/fail count over a sequence says something failed, not which step - while the aggregate still appears as `testValidation`.
Three differences from the single-request shape:

- `pm.request` is the step's own request as that sample sent it, and `pm.info.requestId` / `requestName` are that step's, not a run-level one.
- `pm.info.iteration` is the virtual user's own iteration index and `pm.info.vu` is that user's number, so a script can tell two users' responses apart - beside the `pm.iterationData` a single-request run's rows also provide, so a script asserting on `{{data.*}}`-driven behaviour grades the right row either way.
- The sample budget is split across the steps that carry a script rather than spent run-wide, so the last step of a long plan is validated instead of being crowded out by the first.
  A step with no script is never sampled.

`pm.execution` still throws throughout - a deferred script cannot redirect a sequence that already happened - and a deferred step script never runs inline (a step script marked `inline` ran during the run instead; see [Script elements](#script-elements-design-send-and-the-sequential-run)).

## Script elements (design send and the sequential run)

Issue #1514 cut `POST /execute` and the stored resources (`POST`/`PUT /collections`, `POST`/`PUT /requests`) over to `elements` for good - a clean cut, not a transitional alias.
`preRequestScript`, `preRequestScripts`, `postRequestScript`, `postRequestScripts` and `tests` are all refused with a `400` naming `elements` as the replacement (`null` is accepted as a no-op; a real value is not).
A script is now a `script.pre` or `script.post` **element**
- `{"kind": "script.pre" | "script.post", "config": {"script": "..."}}` - compiled and run by `vayu::core::ElementPipeline` at `step.before` / `step.after` alongside every other element kind.
See [elements.md](../elements.md).

**Each script element runs its own script, independently - there is no more joined-parts scope.**
A design send's or a sequential step's compiled list can carry more than one `script.pre` element (one folded from the collection, one from the request, say), and the pipeline calls each one's `apply` in list order, but every call opens a **fresh** `ScriptContext` - there is no longer a blank-line join that ran the collection's and the request's text as one script in one shared scope.
A `const` or `let` one `script.pre` element declares is **not** visible to the next one.
State that is meant to carry across them has to go through a store the elements share instead:
`pm.environment` / `pm.collectionVariables` / `pm.globals` / `pm.iterationData` read back whatever an earlier element wrote, and a `pm.request` edit is visible to a later `script.pre` element (and to the send itself) because every element at a step shares the one `Request` object being sent - only the JavaScript variable scope is per-element.
The same holds for `script.post` elements and `pm.response`.

**Every level is run and every level is reported (#2522).**
The elements run collection first, then each folder from the outermost in, then the request, and each script's result is added to the step's rather than replacing the level before it.
Every `testResults` and `consoleLogs` entry carries `scope` (`"collection"`, `"folder"` or `"request"`); a failing `pm.test` at any level fails the step; an `assert.*` element's result survives a later level's script; and a script that asked for no flow control does not cancel a skip or jump an earlier level set (a later instruction does replace it).
**A throw names its level**: when the collection's or a folder's script throws, the collection-run step error and the send's `preScriptError` / `postScriptError` read "Collection pre-request script failed - <message>" or "Folder test script failed - <message>"; the request's own throw reads as it always did.
When several levels throw, the first one is the step's error, and every level's own message stays on its element's `elements[]` outcome.

**A single-request `POST /runs` runs the element pipeline too now (issue #1594), and no longer joins.**
It calls `refuse_legacy_script_fields` the same as `POST /execute` - `tests` / `postRequestScripts` / `postRequestScript` / `preRequestScript(s)` are all refused with a `400` naming `elements` - and reads its own step-level elements off a new field, `requestElements`, a distinct key from this endpoint's own `elements` (the run-level `timers`/`scripts` override, below).
Each `script.pre` / `script.post` element there runs its own script independently, opening a fresh `ScriptContext` per element, exactly like a design send's or a sequential step's compiled list above - there is no blank-line join here either.

**A scenario load run's `elements` run inline now (issue #1495), opt-in per element.**
`submit_one` (the producer, one virtual user at a time) runs `step.before` before binding and submitting; the completion runs `step.after` once the response is in hand.
`extract.*`, `assert.*` and `metric.record` always run there.
A `script.pre` / `script.post` element runs there only when its own `config.inline` is `true`, or the run's `elements.scripts` override (`"allInline"` / `"allDeferred"`, beside the default `"asMarked"`) forces it one way or the other -
unmarked, a step's scripts still defer to the post-run `tests` replay exactly as before this issue, and the replay itself now skips a step whose script already ran inline rather than running it twice.

Every virtual user (VU) gets its own small write layer over the run's shared variable scopes (`ScopeOverlay`, on the VU):
what one VU's inline `extract.*` or `script.*` writes on step 1 is visible to *that VU's* step 2, and invisible to every other VU's concurrent step 2 - two VUs sharing one name would otherwise read and overwrite each other's state, which is exactly the correlation-under-load bug this issue exists to fix.
`pm.execution` still throws under load (`in_scenario` is `false`): an inline script can write state and mutate the request, the same way `script.pre` always could, but it cannot redirect the sequence - that stays the deferred replay's own script and, eventually, a `control.*` element's job, neither of which runs inline.
What the overlay holds for the environment, collection and globals scopes lives as long as the VU (#3044), so a `control.once` login's token reaches every later iteration; only its run-local scope is emptied at the iteration boundary, where `pm.cookies`' per-VU jar is.
An inline script's `unset()` or `clear()` of a name the run loaded hides that stored value from the same VU alone, until a later write sets the name again (#3088).
The base a step's overlay sits on is its own folder's (#3248): the environment and globals the run loaded, and the chain from the root down to the step's folder, each as the run's `script.setup` scripts left them (#3456), read once before the first submission.
The overlay keeps a collection write per folder, so it answers that VU's later steps in the same folder and in folders below it, and never a step in a sibling folder.

**A single-request load run's `requestElements` dispatch the same way, per submission rather than per VU (issue #1594) - there is no persistent VU object on this path to hold state across submissions.**
`submit_one_request` runs `step.before` immediately before the transfer and `step.after` once the response is in;
`extract.*` / `assert.*` run there unconditionally, and a `script.pre` / `script.post` element runs inline only when its own `config.inline` is `true` or the run's `elements.scripts` override forces it, `RunContext::script_element_runs_inline` deciding exactly as it does for a scenario step.
An unmarked `script.post` still defers - to this run's own completion replay, not a scenario's - and an unmarked `script.pre` simply never runs, because there is no pre-request replay to defer it to.
Each submission gets its own fresh `ScopeOverlay`, discarded after, so a `pm.environment.set` one submission's inline script makes is visible to that same submission's own residual-token pass and later steps, never to a concurrent submission's.
`timer.think` costs no new thread here either: `RunContext::reserve_think_wait` folds its wait into the same `maintain_concurrency` in-flight accounting every closed-loop strategy already polls, rather than blocking a worker; a `constant_rps` run skips the timer (#3541).

See [`elements.md`](../elements.md#load-paths) for the full mechanics - `ScopeOverlay`, the per-thread `ScriptEngine`, `elements.includeScriptTime`, and what remains deliberately unwired on the single-request path (`control.*` - a lone request has no sequence for a controller to jump or gate).
