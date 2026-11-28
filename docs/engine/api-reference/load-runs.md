---
description: >-
  POST /runs: starting a run - the fields, streaming under load, data rows, thresholds, elements, the monitor block and the scenario block.
---

# POST /runs

Start a load test run (Vayu Mode).


**Request:**
```json
{
  "method": "GET",
  "url": "https://api.example.com/users",
  "headers": [],             // Optional, {name, value} lines in send order (or the older object) - see POST /execute
  "body": {
    "mode": "none",
    "content": ""
  },
  "mode": "constant_rps",    // "constant_rps", "constant_concurrency", "ramp_up", "iterations", or "capacity"
  "concurrency": 100,        // Target in-flight requests (constant_concurrency / ramp_up target / iterations); the ceiling for capacity
  "startConcurrency": 1,     // Ramp start concurrency (ramp_up); first level searched (capacity)
  "duration": "60s",         // Duration, ms/s/m/h (constant_rps / constant_concurrency / ramp_up); the deadline for capacity
  "rampUpDuration": "10s",   // Ramp time, ms/s/m/h (ramp_up mode; start may be above target)
  "sloMs": 200,              // p99 budget the search looks for the edge of (capacity mode)
  "stepDuration": "5s",      // How long each level is held before it is judged (capacity mode)
  "iterations": 1000,        // Number of iterations (iterations mode)
  "targetRps": 1000,         // Target requests per second (constant_rps only; a 400 on any other mode)
  "maxInFlight": 10000,      // Optional; see "maxInFlight" note below - constant_rps only
  "retryAfterBackoff": false,  // Optional, default false - wait out a 429's or 503's Retry-After; see "Retry-After back-off" below
  "retryAfterMaxMs": 30000,    // Optional, default 30000 - the longest one such wait
  "requestId": "req_1234567890",      // Optional, links to saved request
  "requestName": "Create user",       // Optional, read by the deferred validation script as pm.info.requestName
  "environmentId": "env_1234567890",  // Optional, what {{variables}} resolve against - see below
  "collectionId": "col_1234567890",   // Optional, the composed collection scope when no requestId row names one - see below
  "origin": { "kind": "mcp", "client": "claude-code" },  // Optional, who started the run - see below
  "targetPolicy": { "allowAll": false, "allowedHosts": ["api.example.com"] },  // Optional, the hosts this run may reach - see below
  "requestElements": [],     // Optional step-level elements for THIS request - see below
  "data": [],                // Optional data rows, one object per row - see below
  "dataFileName": "users.csv",  // Optional, only beside data: the file's display name - see below
  "dataFileHash": "<sha256>",   // Optional, only beside data: 64 lowercase hex chars - see below
  "dataFileCastNumbers": true,  // Optional, only beside data: the file's numbers were read as numbers - see below
  "thresholds": {},          // Optional pass/fail budgets - see below
  "carriedBudgets": [],      // Optional, which of those budgets were carried over rather than set - see below
  "elements": {},            // Optional element-pipeline override, either run shape - see below
  "lifecycleElements": [],   // Optional script.setup/script.teardown for THIS run only - see below
  "monitor": {},             // Optional server-vitals scrape - see below
  "followRedirects": true,   // Optional, default true - see POST /execute
  "maxRedirects": 10,        // Optional, default 10
  "httpVersion": "auto",     // Optional: "auto" | "http1.1" | "http2", default "auto" - see POST /execute
  "stream": false,           // Optional, single-request only - consume each response as text/event-stream; see below
  "maxStreamDurationMs": 600000,  // Optional, streaming only (a collection run's streaming steps) - see below
  "maxStreamEvents": 100000,      // Optional, streaming only (a collection run's streaming steps) - see below
  "stream_metrics": true     // Optional - feed the histograms behind the report's `stream` section
}
```

A body nested deeper than 128 levels in any field answers `400` `request body is nested deeper than 128 levels` (code `invalid_run_config`) before any run row exists (issue #2417).
The exception is a `data` or `scenario.data` cell, held to its own bound of 100 and refused in its own words (see below).

**`httpVersion` on `POST /runs`** is not a per-run override of a stored request - it is simply how this endpoint states which protocol the run uses at all, the same way `method` and `url` state the rest of the request.
The renderer always sends the saved request's own `httpVersion` here (there is no second, load-test-only protocol control in the app); MCP's ad-hoc `start_load_run` - which has no saved request behind it - is the caller that actually depends on this field to specify a protocol in the first place.
An explicit `null` is treated exactly like an absent key.
An unrecognized string is a `400` naming the field and the valid values, the same validation `POST /requests` uses.

**`requestId` / `environmentId` / `collectionId` on `POST /runs`** are read exactly as on [`POST /execute`](execute.md#post-execute): a non-string is a `400` naming the field (`'environmentId' must be a string (got boolean)`) and no run row is created.
A single-request run's collection scope is decided by the same rule (the linked request's collection, else the composed [`collectionId`](compose.md#collectionid-on-the-answer), issue #3461), for its scripts, its residual pass and its snapshot's masking alike.
A single-request run that names any of the three resolves a `{{name}}` still in its URL, path values, headers or body against the same scopes a Send reads (the environment, that collection's chain, globals) (#3253).
It is one pass at run start, over the request every submission shares, never one per submission, so a request holding no `{{` costs nothing more.
An id naming nothing is an empty scope, as on `POST /execute`, never a refusal.
The pass leaves every token the per-submission bind owns: `{{data.*}}` and a bare column of the run's `data`, `{{$vu}}` / `{{$iteration}}`, and a generator such as `{{$guid}}`, generated per submission.
It runs before `script.setup`, so a setup write does not reach a request it resolved.
A run whose submissions are copied skips it,
leaving its request to the per-submission residual pass described under [the `requestElements` array](#the-requestelements-array-a-single-request-runs-own-step-level-elements), which reads what `script.setup` wrote:
one whose `requestElements` hold a `step.before` kind (a `script.pre`, the only one this path admits), or that declares `requestElements` beside `data` rows, a token the bind owns, or a credential waiting on the scripts.
A run whose `requestElements` only read the response (`assert.status`, `step.after` kinds) and has none of those sends one shared request, and takes this pass (#3288).
Which of the two a run is gets decided on its request before this pass, so a stored value that is itself a generator moves the run onto the copy path having already answered the name it filled, and a setup write to that name is lost.
Credentials holding a name these scopes may answer are held back from the build on a run whose submissions do not wait on their scripts for them, and resolved and applied by this pass after the request's own names (#3288), so a bearer token, an api key in a header or the query and a basic pair all go out with their values;
one whose credential also holds a token the bind owns (`{{$iteration}}`) has its stored names answered here and is bound per submission.
A credential holding no token is applied when the request is built, as before.
A name nothing answers is sent as written and counted in the report's `unresolved_tokens` warning, never refused; a credential the pass cannot apply (an api-key header name that resolves to something that is not a header name, a value a header line cannot carry) is counted the same way and the run goes on.

**`origin` on `POST /runs`** is the same object, read by the same reader and under the same rules as on [`POST /execute`](execute.md#post-execute) (#1817): who started the run, client-asserted metadata rather than identity, `other` when absent, `client` kept for `mcp` only, and a malformed one a `400` naming the field before the run row exists.
It applies to every run shape this endpoint starts, a scenario's included.

**`targetPolicy` on `POST /runs`** is the object [`POST /execute`](execute.md#post-execute) documents (#2521), read by the same reader: a malformed one, an unknown member included, is a `400` with code `invalid_target_policy` before the run row exists, and it is never stored in the run's `config_snapshot`.
What differs is where the verdict is made:

- **A single-request run** has its OAuth 2.0 `accessTokenUrl` and `refreshTokenUrl` hosts judged in the pre-flight, before any token is fetched and before the run row exists: a refusal is a `400` whose code is `target_not_allowed` or `target_host_unknown`.
  The request's own URL is judged at each submission, in the event loop after the transferability checks: a host the policy refuses fails that submission as an `INVALID_URL` error whose message names the host, counted like any other error, and nothing is sent.
- **A collection run** (`scenario`) has the token endpoints of each step's OAuth 2.0 config judged when the plan is resolved wherever the token is acquired then, a `400` under the same codes with no run row.
  A sequential run then judges each step's final URL after that step's pre-request script, as a buffered send does (and a config that waited for the script, at its step), and a collection load run judges each submission as a single-request load run does.
- **A load run's `monitor.url`** (either shape) is a second host the run contacts, once per scrape for as long as it runs, and the scrape loop sends with no policy of its own, so its host is judged when the run is validated, by the same match (#3121), on the URL as the scrape will send it (after the encoding pass that turns a `\` into a `/`, as for a send's final URL):
  a host the policy does not list, or one it cannot determine (a `{{template}}`, which the scrape would send as written), is a `400` under `target_not_allowed` or `target_host_unknown` whose message names `monitor.url`, before the run row exists and before anything is sent.
  A caller that wants a monitor on another host lists that host too.

An omitted `targetPolicy` restricts nothing.
Redirect hops and `pm.sendRequest` are outside it.

## Streaming under load (`stream`)

`POST /runs` reads `stream`, `maxStreamDurationMs` and `maxStreamEvents` through the **same parser** `POST /execute` uses, so the two endpoints agree on the spelling, the types and the ranges - a load run declares a stream exactly as a send does.
It was a `400` here until this landed, because a load run's completion accounting has no place for a response that never ends.
What changed is that a load stream always ends.

**Under load a stream is bounded by construction.**
Both caps are always in force - the payload's, or the `sseMaxStreamDurationMs` / `sseMaxStreamEvents` settings when the payload names none - and neither can be set to zero-for-unbounded.
That is not tidiness: the load loop is completion-driven (`in_flight() = sent - completed`, concurrency refilled per completion), so a transfer that never completes leaks its slot for the rest of the run.

**Reaching a cap is a *successful* completion**, not a timeout and not an error: it is the stream's intended end under load, so it lands in the run's success counts, its latency histogram and its status-code distribution like any other
200. The endings, side by side:

| Ending | Reported as |
|--------|-------------|
| A cap in `maxStreamEvents` / `maxStreamDurationMs` on a reply that announced `text/event-stream` | Success, `stream.capped` incremented |
| The duration cap on a reply that is not an event stream (#3771) | **Error** (`Timeout`), not a stream |
| The server closing the stream | Success, not counted in `stream.capped` |
| `maxResponseBodyBytes` exceeded | **Error** - a refusal to buffer, unchanged. The event cap bounds how many events arrive, not how large one is |
| The whole-transfer timeout | **Error** - it sits a grace period *past* the duration cap, so reaching it means the cap never fired |
| A cap or the server's close before the final JSON-RPC response, on an `mcp` request (#3831) | **Error** (`mcp_transport`); a cap still counts in `stream.capped` |

An `mcp` request is the one exception to the first and third rows, because its stream is request-scoped.
A tool call's reply ends with its response, so a stream that ends before the response arrives is a call that did not complete.
The transfer ends exactly as a plain stream's does, so its slot and its `stream` section are unchanged.
The [reply reader](request-body.md#the-mcp-reply) then judges the reply `transport`, and the run counts it under `mcp_transport`.
A plain `stream` request with the same cap or close stays a success.
A design send (`POST /execute` with `stream: true`) and a sequential collection run's streaming step read the reply by the same rule.

Events are counted on the write path by a frame counter that agrees with the design path's parser about what an event is: a frame carrying no `data` field is not one, so comment-only keep-alives do not inflate the tally.

The same count reaches the [live frames](live-metrics.md#get-runsrunidlive) as the events arrive (issue #3236): `streamEvents`, `eventsPerSecond` and `streamsOpen` on every frame, and `streamTimeToFirstEvent` on gate frames, so a run of long streams shows its progress before the first one ends rather than zero completions until then.
A single-request streaming run carries them, and so does a collection load run with a streaming step (issue #3304), whose `streamsOpen` counts only its streaming steps' transfers; a run with no stream, and a design (sequential) collection run, which has no live frames, carry none of the four.

On a single-request run, `stream` is refused beside `transient` (as on a send) and each cap is refused without `stream` - a cap on a non-streaming run reads as a bound the caller expects to apply, and ignoring it is how an unbounded run gets mistaken for a capped one.
`streamTextPath` (issue #3773) is read by the same rules as on [`POST /execute`](execute.md#post-execute) - a string in the JSONPath subset, beside `stream: true` - and a by-id `POST /compose` carries the saved request's.
Each streamed response's post-request script then reads every event's `text` and the joined `pm.response.streamText`, inline or in the deferred replay, and a captured sample keeps the path so [`GET /runs/:runId/samples`](runs.md#get-runsrunidsamples) serves both from its bytes.
`streamFirstContentMarker` (issue #3774) is read by the same rules (a non-empty string of at most 256 bytes with no NUL, beside `stream: true`), and a by-id `POST /compose` carries the saved request's: compiled once for the run, it is watched for on every transfer, and the report's [`stream.timeToFirstMatch`](runs.md#get-runsrunidreport) times each stream to it.

**A collection run (`scenario`) streams the steps whose stored request has `stream` set** (#3235), and only those.
The plan reads the flag off each stored request, so the run declares nothing: `maxStreamDurationMs` and `maxStreamEvents` are accepted *without* `stream` here, range-checked as above, and bound every streaming step, each falling back to its `sse*` setting on its own.
A step that does not stream ignores them.
A top-level `stream` is a `400` (`invalid_run_config`) on a collection run, `true` or `false`: it cannot make a stored request stream or stop one streaming, so accepting it would let a caller believe it did either.
A top-level `streamTextPath` is a `400` there by the same argument: each streaming step reads its events through its stored request's own `streamTextPath`, which its scripts, its stored trace and its captured samples carry as on a single-request run.
A top-level `streamFirstContentMarker` is a `400` there too: each streaming step is timed to its stored request's own (issue #3774).
A collection **load** run sends a streaming step through the same event loop as a streaming single-request run, so the table above holds per step:
a cap or the server's close ends an event stream as a success (any other reply is no stream, and a cap on it is a `Timeout`), its events land in the report's `stream` section, its stored exchange keeps its event count (so `GET /runs/:runId/samples` reads its `events` back), and the step's own `timeout` (or the run's) bounds only its connect phase -
the whole-transfer timeout is the duration cap plus the 5s backstop.
A load run's natural end waits for the longest streaming step's cap plus that backstop, or for the run's `timeout` where that is longer (its ordinary steps are still bounded by it), before cancelling what is still in flight.
A sequential (design-mode) collection run sends a streaming step through the single-request client by the same rules: a cap or the server's close ends it as a pass, its own `timeout` bounds only its connect phase, and a `POST /runs/:runId/stop` ends the stream in flight rather than waiting out its cap (a stream the server had not yet answered is a cancelled step).
The body is the `text/event-stream` bytes, held to `maxDesignResponseBodyBytes` like any step's (reaching it ends the stream, with `bodyCapped`);
the step's stored trace carries the parsed `events` node (`items`, `totalEvents`, `eventsTruncated`, and `streamText` when the step's request declares a `streamTextPath`) a load sample's does, and the run's summary and report gain the same `stream` section, which its `stream*` budgets judge.
A duration cap that passes before any status line is a `timeout` error naming the cap.

## The `data` rows (a data-driven load run)

A single-request run may carry a top-level `data` array - one flat object per row - and bind it into the request it repeats (issue #993):

```jsonc
{
  "method": "POST",
  "url": "https://api.example.com/orders/{{data.id}}",
  "mode": "constant_concurrency",
  "duration": "30s",
  "concurrency": 50,
  "data": [
    { "id": "1", "email": "ada@example.com" },
    { "id": "2", "email": "grace@example.com" }
  ]
}
```

**One row per request sent**, claimed off a run-wide cursor that wraps: a run longer than the set repeats it from the top, so the file bounds which values go out and never how many requests do - that is the load profile's job.
The row a completion was bound to is recorded as `dataRowIndex` on every retained result, and the deferred `tests` script reads that submission's own row as `pm.iterationData`.

Everything else is the scenario path's, because it is the same code:
the same validation (an array of objects, present-but-empty refused, bounded by `maxScenarioDataRows` / `maxScenarioDataBytes`, and a cell nested deeper than 100 levels refused with `'data' row N column 'name' is nested deeper than 100 levels`,
a row that is not an object and is itself that deep with `'data' row N is nested deeper than 100 levels`, and a `data` that is not an array with `'data' is nested deeper than 100 levels` -
all checked right after the body is parsed, whatever shape `data` has, before the engine snapshots the payload),
the same `{{data.column}}` placement rules and escaping, the same credentials-bind-before-they-are-encoded order, and the same refusal of a `{{data.*}}` in an `oauth2` config.
Every rejection is a `400` `invalid_run_config` before the run row exists, so a refused set leaves nothing behind.

Two differences from `scenario.data` worth stating:

- **`iterations` is not defaulted from the row count.**
  A load profile already says how long the run is; a collection run without an explicit count takes one pass per row.
- **The two fields cannot be combined.**
  A top-level `data` beside a `scenario` block is a `400` naming `scenario.data` - the two bind differently (per submission here, per iteration and shared by every step there), so a payload carrying both would have one of them silently dropped.

**Which file the rows came from** (issue #2051) rides beside them as two optional, independent strings: `dataFileName`, a display name (the app sends the picked file's name), and `dataFileHash`, the SHA-256 of the file's bytes as 64 lowercase hex characters.
The engine stores both verbatim and opens nothing; no path is ever stored.
Each is a `400` `invalid_run_config` when it is not a non-empty string, `dataFileName` also when it holds a `/` or `\` (a path, not a name), `dataFileHash` also when it is not that digest shape, and either one is a `400` when sent without `data` (refused, not ignored).
A top-level one beside a `scenario` block is a `400` naming its `scenario.dataFileName` / `scenario.dataFileHash` counterpart, as `data` is.

**How the client read that file** (issue #2540) rides beside them as `dataFileCastNumbers`, a boolean: `true` when the client typed the file's unquoted numeric cells as numbers (the app's **Read numbers as numbers**).
The rows arrive already typed and the engine never converts them; it records the flag because the hash is of the file's bytes and cannot tell two readings of one file apart.
`null` is absent; any other non-boolean is a `400` `invalid_run_config`, any value (`false` included) without `data` is a `400`, and a top-level one beside a `scenario` block is a `400` naming `scenario.dataFileCastNumbers`, on the same rules as the two strings.

The rows are **never persisted**: the stored run snapshot records the row count (`dataRowCount`) plus the file's `dataFileName` and `dataFileHash` when they were sent, and `dataFileCastNumbers: true` when the numbers were cast (absent, never `false`, otherwise, so a run recorded before the flag reads as text), never its path or rows, exactly as a scenario manifest does.
A cell that *binds* travels in the request that carried it, so it is stored with whatever traces the run retains.

## The `thresholds` block (pass/fail budgets)

A run may declare budgets it must meet.
The engine evaluates them once, when the run reaches a terminal status, and the report comes back with a [`thresholdValidation`](runs.md#get-runsrunidreport) section carrying one check per budget and a verdict.
Without the block a run is measured and not judged, and its report has no such section at all.

```jsonc
{
  "thresholds": {
    "latencyP50Ms": 20,        // ceiling, ms; > 0 and <= 86400000
    "latencyP95Ms": 40,        // ceiling, ms
    "latencyP99Ms": 50,        // ceiling, ms
    "maxErrorRatePct": 0.1,    // ceiling, percent of the run's requests; 0-100
    "minThroughputRps": 10000, // floor, completed requests per second; > 0
    "maxAssertionFailureRatePct": 0, // ceiling, percent of failed assertions, the worse population; 0-100
    "streamTimeToFirstEventP95Ms": 800, // ceiling, ms, streaming runs; > 0 and <= 86400000
    "streamTimeToFirstMatchP95Ms": 900, // ceiling, ms, streams with a first content marker; > 0 and <= 86400000
    "streamEventsPerSecondMin": 200,    // floor, events per second, streaming runs; > 0
    "maxToolErrors": 5,        // ceiling, count of failed mcp replies of the class; 0-1000000000000
    "maxProtocolErrors": 0,    // ceiling, count
    "maxTransportErrors": 0,   // ceiling, count
    "maxToolErrorRatePct": 1,  // ceiling, percent of the run's requests; 0-100
    "maxProtocolErrorRatePct": 0, // ceiling, percent
    "maxTransportErrorRatePct": 0, // ceiling, percent
    "failRun": true            // a missed budget sets status "failed"; default false
  }
}
```

Every key but `failRun` is a budget; at least one budget must be present (a `thresholds` object holding only `failRun` is rejected the same way an empty one is - it names nothing to judge).
An unknown key, a non-numeric or out-of-range budget value, a non-boolean `failRun`, or an object that declares no budget is a `400` `invalid_run_config` naming the field - and, like every other run-config rejection, it happens before the run row is created, so a rejected request leaves no trace.
A `null` value reads as absent, the same rule the flat numeric fields follow.

`maxErrorRatePct` is measured against every response outside 2xx/3xx **plus** the transport failures that never got one - the [one error definition](metrics.md#what-counts-as-an-error), the same figure `summary.errorRate` reports and the live tick streams.
A request a Stop cancelled is in neither its numerator nor its denominator.

`maxAssertionFailureRatePct` (issue #1497) is measured against two populations a load run keeps apart (issue #2892).
The **exact** one is every `assert.*` element outcome, every required `extract.*` that found no match and every `pm.test` call an inline script made, counted on every completion.
The **sampled** one is the deferred `pm.test` replay, run over responses sampled at 1 in `response_sample_rate` (default 100) - the same tallies the report's `testValidation` shows.
That is a sampling period, not a promise about the count: on a long run the `max_response_samples` reservoir cap can make the replayed set sparser than 1 in `response_sample_rate`.
`actual` is the **worse** of the two failure rates, each `0` when its population is empty, so a sampled `pm.test` failing half the time beside an inline assertion that never fails reads 50%, not the fraction of a percent a single blended count would give; the budget fails when either population crosses it.
The check names both populations, so a reader can see which one the verdict came from:

```jsonc
{ "metric": "maxAssertionFailureRatePct", "limit": 10, "actual": 50.0,
  "passed": false, "evaluated": true,
  "assertionsExact":   { "passed": 2270, "failed": 0 },
  "assertionsSampled": { "passed": 12, "failed": 12 },
  "sampleRate": 100 }
```

`assertionsExact` and `assertionsSampled` are both written on an evaluated assertion check, an empty population as `{passed: 0, failed: 0}`; `sampleRate` (the period the replay ran at, keep 1 in N) is written only when `assertionsSampled` is non-empty.
No other check carries these keys, and a check stored before issue #2892 has none of them: its `actual` is the old blended rate and nothing is backfilled.
Unevaluated, like a latency percentile, when the run made no assertion at all - a run with no `assert.*` element and no test script is unaffected by declaring this budget - and then the population keys are absent too, as `actual` is.

`streamTimeToFirstEventP95Ms` and `streamEventsPerSecondMin` (issue #3234) judge a streaming run's [`stream`](runs.md#get-runsrunidreport) section: `timeToFirstEvent.p95` and `eventsPerSecond`, the same figures the report prints.
Both are unevaluated, and so count toward `failed`, on a run with no `stream` section (one that did not stream, or ran with `stream_metrics: false`), because a run that streamed nothing measured neither; a floor read as `0` there would fail for the wrong reason.
The time-to-first-event budget is also unevaluated when no completion delivered a timed event.
It judges the first event of any kind, so an API that opens with a preamble event (Anthropic's `message_start`, an OpenAI role-only chunk) reads near zero on it and passes whatever its first token costs.

`streamTimeToFirstMatchP95Ms` (issue #3774) is the budget for that first token: it judges `stream.timeToFirstMatch.p95`, the wait for a request's first content marker (`streamFirstContentMarker`), the same figure the report prints.
It is unevaluated, and so counts toward `failed`, whenever no completion's marker arrived: on a run with no `stream` section, on one whose requests declare no marker, and on one whose content never came.
A stream that never matched is no measurement, never a fast one, so this budget cannot pass on a run that did not measure it.

`maxToolErrors`, `maxProtocolErrors` and `maxTransportErrors` (issue #3830) are ceilings on the run's failed `mcp` replies of one [failure class](request-body.md#the-mcp-reply), the counts [`summary.errorClasses`](runs.md#get-runsrunidreport) reports: `tool`, `protocol` and `transport`.
`maxToolErrorRatePct`, `maxProtocolErrorRatePct` and `maxTransportErrorRatePct` are the same counts as a percentage of the run's requests, the denominator `maxErrorRatePct` divides by.
`0` is a legal ceiling for all six ("no tool call may fail"), and a run with requests and no failed reply of the class, an `mcp` run or not, is evaluated at `0` and meets it.
A run that sent no request is unevaluated on all six, as on `maxErrorRatePct`, so a class budget cannot pass a run that measured nothing.

**Every run mode is judged** (issue #1564): a single-request load run, a scenario load run and a **collection** (sequential, design-mode) run all evaluate the same `thresholds` block against their own numbers and store the same `thresholdValidation` shape.
A collection run's error rate and latency percentiles are drawn from the steps it actually sent (a step a script or an unbound data row skipped counts toward neither), and its assertion tally, every `assert.*` outcome and `pm.test` call of every step it ran, is all exact:
a collection run runs each step's scripts on every send, so its assertion check carries `assertionsSampled` at zero and no `sampleRate`.
Since a script error no longer ends the iteration (issue #2526), the steps after one are sent and counted too, so the same collection can report a larger denominator than it did before; `stopOnError: true` restores the old population.

**`custom.<name>.<stat>`** (issue #1500) budgets a named `metric.record` / `pm.metrics` value - `<name>` the metric was recorded under, `<stat>` one of `p50`, `p95`, `p99`, `max` (a trend), `value` (a counter's running total or a rate's percentage, whichever the name was declared as) or `rate` (the same field as `value`, spelled for a rate metric):

```jsonc
{ "thresholds": { "custom.ttfb2.p95": 50 } } // ceiling, always - >= 0
```

Unlike the fixed keys, this is a dynamic key family: the route checks the shape (`custom.` prefix, a non-empty name, a stat from the list above) and that the value is a non-negative number, not that `ttfb2` is a name this run's plan actually declares - a `metric.record` on a step the run never reaches, or a plain typo, is not distinguishable from a not-yet-recorded metric at validate time.
Evaluated the same way an unmeasured latency percentile is: `evaluated: false` when this run's collector never recorded that name, counted toward `failed` rather than a silent pass.
The test is the entry's `count` (records, not the total - see [`customMetrics`](runs.md#get-runsrunidreport)), so a counter nothing recorded through is unevaluated while a counter recorded only by zero is evaluated with `actual: 0`, which is what lets `{"custom.failures.value": 0}` pass a run that saw none (#1937).
A counter never goes negative: `pm.metrics.counter` throws on a negative or non-finite increment, and `metric.record` reports `error` for one and records nothing.
**Every run mode is judged**, the same rule the fixed keys follow (#1564): `execute_scenario_run` folds `summary.custom_metrics` into the same `RunSummaryInputs` it evaluates thresholds against for a collection (sequential, design-mode) run, not only a load run.

The verdict is the run's, not the process's: a run **stopped early** is judged on what it measured up to that point, and its status stays `stopped` whatever the verdict says.
The app says so on a stopped run, under the verdict's counts, with how long the run went against how long it was planned for.
A run that reached its **own end** whose config set `thresholds.failRun: true` and whose budgets it missed ends `failed` instead of `completed`; without the flag, or on a run that met every budget, a failing budget is reported but never changes the terminal status.
Only a Stop that decided the outcome (one before the strategy returned) makes a run `stopped`: a Stop that cuts the natural-end drain short leaves the run to its own end, so `failRun` still judges it (issue #3341, see [POST /runs/:runId/stop](runs.md#post-runsrunidstop)).
The requests that Stop cut are the run's slowest and are in none of its figures, so its summary records them as `drainCut` (#3538) and a reader judges the run not judged unless a budget already failed it; the stored verdict here is still the budgets' own.

Each check carries `evaluated`.
A latency percentile needs a timed request to mean anything, so a run that recorded none (every request was refused before the wire, cancelled by a Stop or failed before any transfer ran) reports `evaluated: false` and omits `actual` entirely rather than the default `0`, which would otherwise read as a measured 0ms and trivially satisfy an "at most" ceiling.
A request that timed out or lost its connection after the transfer began *is* timed (see [Latency population](metrics.md#latency-population)), so a run where every request timed out is evaluated and its percentiles sit at the timeout.
An unevaluated check counts toward `failed`: a budget the run could not measure was not met.
The error rate is the same: a run that sent no request has no share to take, so `maxErrorRatePct` is `evaluated: false` there (issue #3540) rather than a clean 0% that passes any ceiling, including 0.
The throughput floor has no such gap - a starved `minThroughputRps` already fails on its own - so it is always `evaluated: true`.

## Carried-over budgets (`carriedBudgets`)

`thresholds` says what a run was judged against, not who chose it.
The app seeds its load dialog's budgets from an earlier run's (or from the SLO setting), so a budget can reach a run the user never set it for (issue #2195).
`carriedBudgets` is the app's record of which: an array of the `thresholds` keys it sent as carried over rather than set for this run, spelled as they are in that block - a fixed budget key such as `latencyP99Ms`, a custom row as `custom.<name>.<stat>`.

```jsonc
{
  "thresholds": { "latencyP99Ms": 200, "maxErrorRatePct": 1 },
  "carriedBudgets": ["latencyP99Ms"]
}
```

The engine stores the list in the run's config snapshot as sent and echoes it as the report's [`metadata.configuration.carriedBudgets`](runs.md#get-runsrunidreport); it never reads the entries, so it does not check them against `thresholds`, and the verdict is computed the same with or without it.
Absent or `null` means none were carried, and the report then has no such key.
A non-array, a non-string entry, more than **64 entries**, or an entry longer than **512 bytes** of UTF-8 is a `400` `invalid_run_config` naming `carriedBudgets`, before the run row exists.
MCP's `start_load_run` does not accept the key: an agent declares its budgets explicitly, so none of them are carried over.

## The `elements` block (element-pipeline override)

A **scenario** load run's `elements` block overrides how the element pipeline runs across every step of the run (issue #1495), without editing the collection itself.

```jsonc
{
  "elements": {
    "timers": "asConfigured",     // "asConfigured" (default) | "off" | {"fixedMs": N} | {"minMs": N, "maxMs": N}
    "scripts": "asMarked",        // "asMarked" (default) | "allInline" | "allDeferred"
    "includeScriptTime": false,   // default false
    "seed": 42                    // Optional, non-negative integer - seeds this run's RNG
  }
}
```

Every key is optional; an unknown key or an out-of-set value is a `400` naming the field, the same `invalid_run_config` shape the `scenario` block's own unknown-key rule uses, checked before the run row is created.

- **`scripts`** decides whether a `script.pre` / `script.post` element runs inline (on the producer/completion hooks, before or after the step's own send) or stays deferred to the post-run `tests` replay.
  `"asMarked"` (the default) reads each element's own `config.inline`; `"allInline"` / `"allDeferred"` force every `script.*` element of the run one way, regardless of its own marking.
  `extract.*` and `assert.*` are unaffected - they always run inline on a scenario load run.
- **`includeScriptTime`** folds the element pipeline's own elapsed time into a step's recorded latency when `true`, and into the run's latency figures with it (`latency`, the per-tick percentiles and a stored result's `latencyMs`), so the run's `max` is never below a step's (#2792); by default (`false`) both are the transfer alone.
  The transfer counts any list pages an `assert.snapshot` followed ([a paged list](../elements.md#kinds)), which the pipeline time leaves out.
  A stored trace's `totalMs` and the `slow_threshold_ms` decision stay on the transfer either way, and the per-phase timings on the step's own request.
- **`timers`** (issue #1498) is wired end to end: `"asConfigured"` (default) runs every `timer.*` element's own stored config unchanged; `"off"` silences every `timer.*` element for the run (`waitedMs: 0`, no sleep);
  `{"fixedMs": N}` or `{"minMs": N, "maxMs": N}` replace every `timer.*` element's own computed wait with the same fixed value or uniform range, whatever that element's own config says - "replaced, not merged", the same rule `scripts` above uses.
  `timer.think`'s `step.between` phase now dispatches on a scenario load run too (non-blocking, summed into `VirtualUser::ready_at_ms`), so this override reaches load runs as well as the sequential run.
  `timer.pacing` and `timer.throughput` schedule their wait before that step's `ElementContext` exists at all (`Element::scheduled_ready_delay_ms`, see [Load paths](../elements.md#load-paths));
  every mode reaches them there too, through the run's own copy of the override (`SharedScheduleState::timers_override`, issue #1620), so a run with `timers: "off"` defers neither kind under load and a run with `"fixedMs"` or `{"minMs", "maxMs"}` schedules their wait from that value rather than the element's own `everyMs` / `targetPerMinute`.
- **`seed`** (issue #1498) is an optional non-negative integer that seeds this run's RNG, making a `timer.think` element's gaussian or uniform-random wait reproducible.
  A scenario load run derives one independent generator per virtual user from this seed rather than sharing one across worker threads.
  Omitted, the run seeds from `std::random_device` as before, and every draw is non-reproducible.

Not reported at the run-summary level: there is no `summary.timers` aggregate.
What a `timer.*` element waited is per-step, per-element - `waitedMs` on that element's entry in the step trace's `elements` array (see [The step trace](../elements.md#the-step-trace)) - not rolled up into `GET /runs/:runId` / the completion report's `summary` object.

Not part of this block: a **single-request** `POST /runs` payload's step-level attachment point is the separate `requestElements` array below, not this one - this block is accepted on either run shape (the validator does not distinguish them), and on a single-request run it overrides what `requestElements` declares, the same way it overrides a scenario's stored elements.
The run's own boundary, `script.setup` / `script.teardown`, is a third array again, `lifecycleElements`, further below.

## The `requestElements` array (a single-request run's own step-level elements)

A **single-request** `POST /runs` payload's own place to attach step-level elements to the one request it sends (issue #1594):
before this, a single-target load run ran no element pipeline at all, so the same request's `extract.*` / `assert.*` / `timer.think` / `script.*` elements that run in a design send, a sequential collection run, and a scenario load run's steps never ran under a single-target load run.
An array of element descriptors, the same shape a request's own stored `elements` column holds:

```jsonc
{
  "requestElements": [
    { "kind": "script.pre", "config": { "script": "pm.request.headers['X-Sig'] = sign()", "inline": true } },
    { "kind": "assert.status", "config": { "in": [200] } },
    { "kind": "script.post", "config": { "script": "pm.test('ok', function () { pm.expect(pm.response.code).to.eql(200); })" } }
  ]
}
```

Validated the same way a stored `elements` column is (`Registry::validate` per entry, a bad `kind` or `config` a `400` naming the index); `id` and `enabled` are optional, defaulting to a generated id and `true`.
The list may be a composed one, so an id is unique only within the level that declares it (the `origin` kind, scope and id `POST /compose` stamps; an entry with no `origin` is the request's own level), and may repeat across levels, the same per-level id rule as [`POST /execute`](execute.md#post-execute) (#3101): a duplicated collection, or a folder repeated down a chain, repeats its ids.
The owner rules differ: every level here is judged as a request's own list, so a collection-only kind stays refused (below) where `/execute` accepts it at a collection level.
A repeat within one level is a `400`, and the `Item N` in a refusal counts within that level's entries.
Refused outright beside a `scenario` block, whose steps already carry their own resolved elements from the plan.
This is the field MCP's `start_load_run` renames a composed request's chain-then-own `elements` onto, since `POST /compose` answers under the plain `elements` key and this endpoint's own `elements` key means something else (the override block above) - see [mcp/request-composition.md](../mcp/request-composition.md#request-composition).

**Only the kinds this run shape's own hooks actually dispatch are accepted**: `extract.*`, `assert.*`, `timer.think`, `script.pre`/`script.post` - the same phase-0 set issue #1514 gave the design send (`extract.*` includes `extract.header`).
A `control.*` or `metric.*` kind or `timer.pacing`/`timer.throughput` is a `400` naming the element by its kind label and where it was declared (`from the collection 'Orders'` for a collection or a folder under it, `set on this request`, read from the entry's `origin`; `element '<id>'` for an entry that carries none) -
not by position, because a composed list interleaves inherited elements with the request's own (#3050).
It is never silently accepted and left inert: those need per-VU controller and pacing state (`controller_state`, `SharedThroughputCounters`, `pacing_state`) this run shape's single-submission model has no equivalent of, and admitting one without running it would report `"ok"` in `summary["elements"]` for behaviour that never happened.
Run a sequence that needs a controller as a `"scenario"` instead, where its steps carry that state.
**A disabled entry (`"enabled": false`) is not refused**: the pipeline skips it before its `apply` runs, so a switched-off pacing timer inherited from a collection does not block the run.
It is still validated like any other entry, so a malformed `config` fails now rather than when it is switched on.

**A collection-origin `script.setup` / `script.teardown` is refused as a request's own** (#3070).
`POST /compose` emits an enabled collection's or folder's run-boundary scripts stamped `origin.kind: "collection"`, but this array is validated as a request's own list and `Registry::validate` refuses the two kinds there: they belong to the collection's own run (or to `lifecycleElements`, below), not to one request's submission.
The app's load dialog and MCP's `start_load_run` leave them out of the payload they build, so only a hand-written client sees the `400`.

`vayu::core::ElementPipeline` runs the compiled list per submission, the same phases a design send uses: `script.pre` at `step.before`, `extract.*` / `assert.*` / `script.post` at `step.after`.
**A `script.*` element runs inline only when marked or forced.**
Unlike a design send or a sequential collection run, a load submission has no persistent per-VU object to defer a script onto, so a `script.pre` or `script.post` element runs inline, per submission, only when its own `config.inline` is `true` or this run's `elements.scripts` override (above) is `"allInline"`;
left unmarked with no override, `script.post` still runs, but *deferred* - on the run's completion replay - while `script.pre` simply never runs at all, because there is no pre-request replay to defer it to.
`RunContext::script_element_runs_inline` is the one place that decision is made, shared with the scenario load path's own step dispatch.
`timer.think`'s wait is folded into `maintain_concurrency`'s own backpressure (`RunContext::reserve_think_wait`) rather than a blocking sleep on a worker thread, so a request-level timer costs no new thread the way the scenario load path's per-VU wait does.
That is the closed loop only: every mode but `constant_rps`.
**A `constant_rps` run skips `timer.think`** ([#3541](https://github.com/athrvk/vayu/issues/3541)): its pacer sends on a schedule, so there is no next request for a wait to hold back, and a reservation would only fill `maxInFlight` with slots no request holds, dropping arrivals and inflating `peakConcurrency`.
The element is tallied `skipped` in `summary["elements"]`, nothing is reserved, and the report carries one `think_timer_skipped_open_loop` warning.
The element is not refused, because an inherited timer would then block load-testing every request under its collection in the default mode.

**A `script.pre` element's edits reach the wire, and its scope's writes reach later `{{tokens}}` in the same submission.**
When a run's submissions are copied (its `requestElements` hold a `script.pre`, or sit beside `data` rows, a token the bind owns or a credential waiting on the scripts;
see [`POST /runs`](#post-runs) for the shared-request run that is not), each submission resolves against a small, request-scoped variable overlay (`vayu::http::routes::ScopeOverlay`) layered over the run's flattened base scopes,
and the residual-token pass (`resolve_residual_tokens`, [Request composition](compose.md#post-compose)) runs against that view before the transfer -
so a `pm.environment.set` (or a `pm.request` edit) an inline `script.pre` makes is visible to any `{{token}}` compose left written on that same request (one it could not answer, or one it deferred past the script, #2521), the same guarantee a scenario load run's per-VU overlay gives its own steps.
Nothing shares this overlay across submissions - each one gets its own, discarded after - which is what keeps many concurrent submissions from writing through one shared map.

**An inline element's `pm.info` carries the run's request identity** (#3460).
`bind_submission_identity` (`load_strategy.cpp`) binds the submission's iteration, its virtual user (`1`) and its data row (#3124), and the run's `requestId` / `requestName`, resolved once when the run starts by the same `read_run_script_identity` (`run_manager.cpp`) the deferred replay reads - the payload's own fields, the linked row's name when only an id was sent.
A run started from no saved request reads both as `undefined`, inline and deferred alike.

## The `lifecycleElements` array (a single-request run's own setup/teardown)

A **single-request** `POST /runs` payload's own place to declare `script.setup` / `script.teardown` (issue #1573): it has no collection row to declare them on, and the `elements` block above is a per-step override, not a place to author new behaviour.
An array of element descriptors, the same shape a collection's own `elements` column holds:

```jsonc
{
  "lifecycleElements": [
    { "kind": "script.setup", "config": { "script": "pm.environment.set('token', 'x')" } },
    { "kind": "script.teardown", "config": { "script": "pm.sendRequest(...)" } }
  ]
}
```

Restricted by kind to the two elements that dispatch at a run's own boundary rather than a step's - any other `kind` is a `400` naming the index and the kind, not silently ignored or run as if it were one of the two.
Each entry's `config` is validated against that kind's own schema (the same `Registry::validate` a collection's `elements` column is checked against); `id` and `enabled` are optional, defaulting to a generated id and `true`.
Refused outright beside a `scenario` block - a scenario collection already has a real `elements` column for this, so declaring both would be two sources of truth for the same run boundary.

`script.setup` runs once, before the run's first submission (before `test_start` is captured, so its own time is never folded into the run's duration figures, live or stored: the live stream's `elapsedSeconds` reads `0` until it ends);
a throwing setup, or one that fails a `pm.test`, fails the run - `Failed`, nothing sent, its outcome under the report's `lifecycle.setup` - the same as a collection-backed run.
`script.teardown` runs once, after the last submission settles, and sees `pm.info.run` (`requestsSent`, `errorRate`, `assertionsPassed`, `assertionsFailed`); a throwing teardown is recorded under the report's `lifecycle.teardown` and never changes the run's terminal status.
Both read and write the same variable scopes every other script of the run shares - the environment named by `environmentId`, and the collection scope of the request `requestId` links, when the run links one, else of the composed `collectionId` (issue #3461); a bare URL run naming neither gets no collection scope.
Unlike a collection-backed run, `script.setup` / `script.teardown` alone do not make what a script writes reach the request: the stored values do, through the start-of-run pass ([`POST /runs`](#post-runs), #3253), but that pass runs before `script.setup`, and the residual-token pass (see above) runs only on a run whose submissions are copied.
So a `pm.environment.set` in `script.setup` reaches a later `{{token}}` only when the run declares `requestElements` and its submissions are copied (a `script.pre` among them, or `data` rows, a token the bind owns or a credential waiting on the scripts beside them); a run whose `requestElements` only read the response sends the stored value.
With `lifecycleElements` alone, `pm.sendRequest` (external side effects) and the `lifecycle` outcomes in the report are the only things observable from this run shape's own script.setup/teardown.
See [elements.md](../elements.md#kinds) for the shared dispatch mechanism a collection-backed run uses for the same two kinds.

## The `monitor` block (server vitals)

A run may name a metrics endpoint on the target, which the engine scrapes for the life of the run on **its own thread**.
The samples are stored per run and served by [`GET /runs/:runId/monitor`](metrics.md#get-runsrunidmonitor), streamed live as `monitor` frames on [`GET /runs/:runId/live`](live-metrics.md#get-runsrunidlive), and summarised in the report's `monitor` section.
Without the block nothing is scraped and none of those three carry anything.

Only a load run reads the block.
A `scenario` payload with no load `mode` is a collection run, which has no scrape lifecycle, so it is refused (below) rather than accepted and never scraped; add a `mode` beside `scenario` to scrape.

```jsonc
{
  "monitor": {
    "url": "http://localhost:9100/metrics",  // required; http(s), loopback and private allowed (not Vayu's own ports)
    "intervalMs": 1000,                      // optional, defaults to `monitorIntervalMs`; 250-60000
    "format": "prometheus",                  // optional, default "prometheus"; or "json"
    "series": [                              // required; 1 to `monitorMaxSeries` names
      "node_cpu_seconds_total",
      "process_resident_memory_bytes"
    ]
  }
}
```

`format` decides how the body is read:

- **`prometheus`** - the text exposition format.
  Comment and blank lines are skipped, a trailing exposition timestamp is ignored, and a value that is not a finite number (`NaN`, `+Inf`) is dropped.
  **Series are matched by name, and samples sharing a name across label sets are summed**, so `node_cpu_seconds_total{cpu="0"}` and `{cpu="1"}` chart as one series.
  A `series` entry is therefore a bare name: one holding a `{` (a label filter such as `http_requests_total{code="500"}`) or whitespace could never match, and is refused (below).
- **`json`** - a flat object of numbers, where `series` lists the keys to read.
  A key that is absent or non-numeric is skipped.
  A key may hold any character, `{` and spaces included.

A name the body does not carry is **absent** from that sample rather than zero.
A scrape that reads nothing at all stores no row and sends no live frame, and the report counts it under one of two causes, because they need different fixes:

- **a failure** (`monitor.failures`) - no 2xx answer: a transport error, a timeout, or a status outside 2xx.
  `monitor.lastError` names the most recent one's cause.
- **a no-match** (`monitor.noMatchScrapes`) - a 2xx answer whose body carried none of the requested names (a mistyped name, or a body in the other `format`).
  The endpoint answered; what it was asked for is wrong.

Neither fails the run.
After five consecutive failures the engine logs once and backs off to twice the configured interval until a scrape is answered; a no-match is an answer, so it ends the backoff rather than extending it.
A scrape still in flight when the run ends is cancelled rather than waited out, and counts as neither.

Three of the limits are settings rather than constants: `intervalMs` defaults to **`monitorIntervalMs`** when the block omits it, the `series` ceiling is **`monitorMaxSeries`**, and how long a single scrape may take is **`monitorScrapeTimeoutMs`** (see [GET /config](health-config.md#get-config)).
All three are read per run, so a change applies to the next run started - no restart.
The interval *bounds* are fixed, because a cadence below 250ms measures the scraper rather than the target and one above a minute records nothing on a short run.

The scrape budget has no field on the block: it is about the endpoint being scraped, which is the same one run after run, so it lives with the other engine settings.
Left at its default of `0` it tracks the cadence at three quarters of it - raise it when a heavyweight `/metrics` renders too slowly for that, and the cadence stays where you set it.

Loopback and private addresses are deliberately allowed: this is a local tool scraping the user's own infrastructure.
The one exception is every outbound path's: the engine's own port and the MCP port are refused ([Reserved local ports](compose.md#reserved-local-ports)).
An unusable block (no `url`, a non-http(s) scheme, no `series`, more than `monitorMaxSeries`, an out-of-range `intervalMs`, an unknown `format`, or under `prometheus` a `series` name holding a `{` or whitespace) is a `400` `invalid_run_config` naming the field, before the run row is created.

A `monitor` block beside a `scenario` that carries no load `mode` (absent, empty or not a string) is likewise a `400` `invalid_run_config` naming `'monitor'`.

A run carrying a [`targetPolicy`](#post-runs) is held to it here too: the `url`'s host must be one the policy allows, or the run is a `400` under `target_not_allowed` / `target_host_unknown` naming `monitor.url`, before the run row exists (#3121).
The URL is judged as the scrape will send it, so a `\` in it counts as the `/` it is sent as.
Loopback and private hosts get no exemption from a policy; without one, "Loopback and private addresses are deliberately allowed" above is the whole rule.

## Retry-After back-off (`retryAfterBackoff`)

Off by default ([#3782](https://github.com/athrvk/vayu/issues/3782)).
On, a `429` or `503` response carrying `Retry-After` holds the virtual user that received it for that long before its next request: delta-seconds, or an HTTP-date counted from the moment the response arrived, clamped to `retryAfterMaxMs` (default 30000).
A value that is neither, a negative number included, or a date already past asks for no wait.
The request is not retried: the `429` stays a counted response in the error rate and `statusCodes`, and the wait only delays what the user sends next.
It composes with a think timer as the longer of the two, and the waits are counted in the `retry_after_backoff` warning (see [`warnings`](runs.md#get-runsrunidreport)).
Both closed-loop shapes apply it, a single-request run by holding the completed slot as `timer.think` does and a scenario run on the virtual user itself.
A `constant_rps` run does not, for the reason it skips a think timer: it sends on a schedule, so there is no next request to hold back, and a held slot would only fill `maxInFlight`.
It carries one `retry_after_skipped_open_loop` warning instead.
The option is opt-in because a run that backs off measures the rate the limiter allows rather than what the target does under the load asked for; with it off, a run whose responses are mostly `429` carries `rate_limited_dominant`, which names it (a `constant_rps` run's says the option does not apply to it).

## The `scenario` block (collection runs)

A run may instead state its work as an **ordered collection** - the collection runner's sequence primitive.
The block replaces the single request, so a payload carrying it needs no top-level `method` / `url`, and states its iteration count inside the block rather than through `mode` / `duration` / `iterations`:

```jsonc
{
  "scenario": {
    "source": "collection",         // required; the only accepted value today
    "collectionId": "col_123",      // required
    "recursive": false,             // optional, default false - descend into sub-collections
    "iterations": 1,                // optional; defaults to the data row count, else 1
    "data": [ { "user": "a" } ],    // optional inline rows; see maxScenarioDataRows
    "dataFileName": "users.csv",    // optional, only beside data: the file's display name, never a path
    "dataFileHash": "<sha256>",     // optional, only beside data: SHA-256 of the file's bytes, 64 lowercase hex
    "dataFileCastNumbers": true     // optional, only beside data: the file's numbers were read as numbers
  },
  "environmentId": "env_123",       // optional, and what {{variables}} resolve against
  "stopOnError": false              // optional, default false - see Outcomes under Scenario runs
}
```

The collection is resolved into an ordered, fully composed plan **once, before anything is sent**, in the order the sidebar displays top to bottom:
direct requests by `requests.order` and - with `recursive` - each collection's sub-collections and requests as one sibling list, depth-first, a request running where it sits and a sub-collection's whole subtree where the sub-collection sits, under the sibling order in [Ordering](resource-writes.md#ordering) (a sub-collection first on an `order` tie).
The run follows the render (issues #431, #2535).
Each step is composed through the same path `POST /compose` uses, so a step's request and its resolved `elements` (every collection, folder and request level's scripts, each run in turn and each reported with its level, #2522) are what a Send of that request would run.
A collection edited mid-run therefore cannot change the sequence underneath itself, and no execution path re-reads the database for request data.

**A valid block answers `202 {runId}`** and creates a run with `type: "scenario"` - unless a load `mode` sits beside it, which makes it a [scenario load run](scenario-load.md#scenario-load-runs) with `type: "load"` instead.
The lifecycle is a load run's either way - the run is registered, streams over [`GET /runs/:runId/live`](live-metrics.md#get-runsrunidlive), stops through [`POST /runs/:runId/stop`](runs.md#post-runsrunidstop) and reports through [`GET /runs/:runId/report`](runs.md#get-runsrunidreport) - and only the executor differs.
See [Scenario runs](scenario-runs.md#scenario-runs) for what it does while it runs and what it leaves behind.

**Every rejection is a `400`** with `error.code: "invalid_scenario"`, raised before any run row exists - an empty or oversized sequence is never silently run as a smaller one:

| Input | Rejected because |
|-------|------------------|
| `source` absent, or anything but `"collection"` | The discriminator exists for a future stored scenario; an unknown value must not fall through to the collection path. |
| `collectionId` absent, not a string, or empty | There is nothing to resolve. The id is echoed back when it names no collection. |
| The collection (with `recursive` applied) has no requests | An empty sequence is a mistake, not a zero-step run. |
| A step's composition fails | The message names the step index, request name and id. |
| More steps than `maxScenarioSteps` | The whole plan is held in memory for the run's life; the message carries the count and the cap. |
| `recursive` present and not a boolean | |
| `iterations` present and not a whole number in `1`-`2147483647` | It is read as a count, so `0`, a fraction and a string are each a run nobody asked for. |
| `data` present and empty | A data set that binds nothing is a mistake - omit the field to run without one. |
| `data` not an array, or a row that is not an object | |
| More `data` rows than `maxScenarioDataRows` | The message carries the count and the cap. |
| A `data` cell nested deeper than 100 levels (`constants::spec_document::MAX_READ_DEPTH`) | Refused before the row is measured or kept, because both recurse and a cell nested far enough overflows the stack (issue #2362). The message names the row and the column: `'scenario.data' row 1 column 'tag' is nested deeper than 100 levels`. The check runs right after the body is parsed and whatever shape `data` has: a row that is not an object but is itself nested that deep answers `'scenario.data' row 1 is nested deeper than 100 levels`, and a `data` that is not an array, nested that deep, answers `'scenario.data' is nested deeper than 100 levels`. A wrong shape within the bound keeps the refusals above. A cell nested exactly 100 levels is accepted. |
| A `data` array larger than `maxScenarioDataBytes` | The row count cannot catch a few very large rows, and the engine's general body cap ([Request bodies](index.md#request-bodies)) sits far above this and refuses a whole payload without naming what in it was too large. |
| A step carrying a `{{data.*}}` token in a run sent without `data` | Nothing would bind it, so the literal token would be sent. The message names the step and the token. The step's credential fields are scanned as well as its request. |
| A step with a `{{data.*}}` token (or the iteration identity) in its `oauth2` config | The token is acquired against the token endpoint (once, when a load plan is resolved; at the step's send in a sequential run), never bound per iteration, so no iteration exists for a row to reach it. Refused with or without a data set. |
| A step of a collection **load** run with a `{{name}}` in its `oauth2` config that no variable answers (`invalid_scenario`; a single-request run is refused the same way under `invalid_run_config`, see [Auth pre-flight](#post-runs)) | A load run acquires each step's token once, when the plan is resolved and before any script runs, from the stored values, so the name would reach the token endpoint as written. A script's write to an OAuth 2.0 variable is ignored under load and nothing is re-acquired per iteration (the only change after the start is each step's [mid-run refresh](authentication.md#oauth-20-token-cache)). The message names the step and the token (#2521, #2742). A sequential run defers such a name to its step's send instead. |
| A step whose OAuth 2.0 token endpoint host the run's [`targetPolicy`](execute.md#post-execute) refuses | Judged before the endpoint is posted to. The code is the policy's, `target_not_allowed` or `target_host_unknown`, not `invalid_scenario` (#2521). |
| `dataFileName` or `dataFileHash` present and not a non-empty string, or `dataFileHash` not 64 lowercase hex characters | Stored verbatim as what the run was driven by (issue #2051), so a value that cannot name a file, or a second spelling of one digest, is refused rather than recorded. |
| `dataFileName` or `dataFileHash` sent without `data` | It would describe rows the run never bound - refused, not ignored (issue #1503). |
| `dataFileName` holding a `/` or `\` | A display name, never a path (issue #2051): a path would be stored and listed back to every reader of the run. Send the file's name alone. |
| `dataFileCastNumbers` present and not a boolean, or sent without `data` (`false` included) | How the client read the file (issue #2540), stored beside its name and hash; on the same rules, so a value that is not an answer, or one describing rows the run never bound, is refused rather than recorded. `null` is absent. |
| A `scenario` key other than `source`, `collectionId`, `recursive`, `data`, `dataFileName`, `dataFileHash`, `dataFileCastNumbers`, `iterations` | Refused by name, so a typo or a knob a future engine reads is never silently ignored (issue #1503). |

A cycle in the `collections.parent_id` tree terminates the recursive walk rather than hanging it, exactly as the cascade delete in `DELETE /collections/:id` does.

**Five settings bound a scenario** (see [GET /config](health-config.md#get-config)).
Four are in the `limits` category, which is where a ceiling that rejects an oversized input lives; `maxScenarioStoredSteps` is `data_retention`, because it bounds what a finished run keeps rather than what one may ask for:

| Key                   | Default | Range      | Effect |
|-----------------------|---------|------------|--------|
| `maxScenarioSteps`    | `200`   | 1-10000    | Largest plan one run may resolve to. The sequence is composed up front and held in memory, and a load-mode scenario allocates a latency histogram per step, so this bounds memory rather than expressing a preference. |
| `maxScenarioDataRows` | `1000`  | 1-1000000  | Largest inline `data` array. The app parses the CSV/TSV/JSON/JSONL file and sends the rows - the engine never reads a file from disk - so this bounds the payload that decision costs. |
| `maxScenarioDataBytes` | `16777216` | 1024-104857600 | Largest inline `data` array measured in bytes of JSON. The row bound alone does not bound the payload, since one row may hold a megabyte in a single cell. |

| `maxScenarioStoredSteps` | `5000` | 0-1000000 | Per-step `results` rows one run stores; `0` stores every step. Steps that did not pass are kept first, successes fill the rest, and what was thinned is reported in the run summary. |
| `maxStepsPerIteration` | `0` | 0-1000000 | How many steps one iteration may execute before it is cut off. `pm.execution.setNextRequest` can send an iteration backwards, so a cycle would otherwise run forever. `0` derives the bound from the plan - ten times its step count, never below 100 - so a straight-through iteration can never trip it. |

The two data bounds are also enforced by the app *before* the run, against the file it is about to parse, so a set this endpoint would refuse is named while the file can still be changed.
The **file format** those rows come from - which extensions are read, the header row's rules, quoting, encoding, and what a CSV cell's type becomes - is the app's contract and is documented once, in [Data-Driven Runs](../../app/data-driven-runs.md).
This endpoint only ever receives rows.
