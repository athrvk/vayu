---
description: >-
  Notes on the MCP tools that read runs, reports, traces and stored bodies, and the references an agent is given for what the user has open.
---

# MCP runs, reports and stored bodies

- **A report read mid-run says so, and `get_run` is the status read** (#2436).
  The engine answers `GET /runs/:id/report` for a run that has not finished with the numbers accumulated so far: a load run's live counts (no `latency` block and no `results[]` rows until it ends, #2659), zeros elsewhere, no budget verdict, nothing in the report itself that tells it apart from a finished run that measured the same.
  `get_run_report` therefore adds top-level `partial: true` and a `note` when `metadata.status` is `pending` or `running` (after the withhold and the trace bounds, so a report that took the bounds' early return is marked too) and leaves both keys out for a terminal run, so the key's presence is the whole signal.
  `get_run` is the cheap read for "is it done": `terminal` comes from the status, never from `endTime`.
  Both reads classify the status through one function (`classifyRunStatus`, derived from the five statuses `list_runs` filters on), and a status outside them is treated as unfinished by both, never as finished (#3339):
  `get_run` answers `terminal: false`, `unknownStatus: true` and a `nextStep` saying the status is not one Vayu recognises (read again, or `stop_run`, which bounds the polling), and `get_run_report` marks the report `partial: true` with `unknownStatus: true` and a `note` naming the status.
  `unknownStatus` is absent for a recognised status, never false.
  The engine emits no such status today; metadata present with no string status counts as one, and a report with no `metadata` object is handed back as it came.
  The engine stores `end_time` as `startTime` on a row that has not started (a seed kept for a run a crash kills) and as `0` on a running load or collection run (#3340), but emits `endTime: null` for a `pending` or `running` run (#2953), so `get_run`, `list_runs` and the report all agree; the status is still the signal that survives an engine that predates that.
  A failed load run the engine could not fully record is a different statement, made inside `summary` and not to be read as the top-level `partial` (#2895):
  `summary.partial: true` is a run reconciled after an engine crash, whose counts, `errorRate`, `statusCodes`, `avgRps`, duration and bytes are the last saved tick's (a floor under the real totals) while `latency` is absent, not zero (#2938), and `peakConcurrency` and `avgQueueWaitMs` are absent, not recorded (#2963);
  `summary.summaryMissing: true` is a failed run with no summary at all (a crash before the first tick, or a worker failure), whose counts are not whole-run totals (a sample's, often 0) and no `latency` block, `peakConcurrency` or `avgQueueWaitMs` is written.
  Both are absent otherwise, never false; the tool description names them, `outputSchema` says what each means, and a failed run's `get_run` `nextStep` points at them.
  The app draws the same two reports as a notice and "not recorded".
  `summary.errorClasses` (#3828) is the run's failed `mcp` replies by class (`transport`, `protocol`, `tool`, and `protocolCodes` splitting `protocol` by JSON-RPC code), each key only when counted: `{}` is a run that saw none, and an absent key a run stored before the engine counted them - not recorded, never `0`.
  `outputSchema` carries that statement; the History report's Error classes card draws it.
  `progress` is `elapsedMs / plannedDurationMs` clamped to 0..1 for a run whose stored `duration` parses and whose mode is not `iterations`, and null otherwise rather than a guess.
  The poll interval in its `nextStep`, and in the `nextStep` the three start results carry (`start_load_run` for a single target and for a scenario, `run_collection`), is one function: a tenth of the planned duration between 2 and 10 s, 5 s when there is no duration to take a tenth of.
- **`get_run_report` carries contract coverage** for a run of a collection bound to an OpenAPI document (issue #629): which of the contract's operations the run exercised, which of their declared responses it saw, and any statuses the document never declared, under `coverage`.
  Passed through verbatim - the tool adds nothing.
  Absent, never zeros, for a run that was not measured against a contract, so an agent must branch on the key's presence rather than reading a zero as full non-coverage.
- **Bodies are bounded before they reach an agent** (issue #767).
  `run_request` and `get_run_report` were raw passthroughs, and no engine cap covers this case:
  `maxResponseBodyBytes` bounds load runs only ("Design-mode sends are not affected"), `maxTraceBodyBytes` is 5 MB, sized for the database and a human reading one full trace, and `maxDesignResponseBodyBytes` (issue #1157) does bound a design send but at 32 MB, three orders of magnitude past what a tool result can carry.
  So a single ordinary page fetch answered with 1.3 M characters and blew the tool-result token limit outright.
  Both tools now cap a body at **32 KB** - `maxSampleBodyBytes`, the engine's own answer to how much of a body an automated reader gets, rather than a new number.
  What a cut looks like, in the engine's existing vocabulary (`cap_node_body`, `run_samples_response`): `bodyTruncated: true` beside the full size, in `bodySize` on a `run_request` response and `bodyBytes` on a stored trace node, and `rawRequestTruncated` / `rawRequestBytes` for a cut wire message - whose headers are always kept whole, since the `Cookie` line libcurl attached appears nowhere else.
  A cut `bodyRaw` comes back with its parsed `body` as `null`, because the two carry the same payload and an intact `body` would return in full exactly what was just dropped.
  Quote `bodyRaw`, not `body`: `bodyRaw` is the received text, while `body` is its parse, with keys sorted and a repeated key reduced to its last value.
  A trace the engine had already truncated keeps the original size the engine recorded.
  Under the bound, nothing is added and nothing is changed.
  **A body that is not UTF-8 text is base64** (issue #2458): the live answer's `bodyEncoding` is always present, `"utf8"` or `"base64"`, and a stored trace's response node carries `bodyEncoding: "base64"` only when it applies (absent is text).
  A base64 body is bounded by the bytes it decodes to, not by its text, and is cut on a whole 4-character group (the engine's `cap_base64_node_body` rule), so the prefix still decodes; `bodySize` and `bodyBytes` count decoded bytes and `bodyEncoding` is kept.
  `run_request`'s description and the `bodyEncoding` member of `get_run_report`'s output schema tell the agent to decode such a body rather than read it as text.
  **`bodyCapped` on a `run_request` response is not this** (issue #1157):
  it is the engine's own flag, always present, saying it stopped *reading* the response at `maxDesignResponseBodyBytes`, so `bodySize` is the prefix it read and re-sending returns the same amount - only raising that config entry changes it, where `bodyTruncated` says the stored body is longer, which `read_body` pages out and `diff_bodies` compares with another stored body (both below).
  It is passed through untouched and both can be true of one response.
  Load-run reports are unaffected: a load run's results never go through `build_result_trace`, so they carry no trace node at all, and its captured bodies live behind `GET /runs/:id/samples`, which has always truncated and disclosed this way.
- **The traces are bounded as a set, not only one at a time** (issue #769).
  Capping each node does not cap the report: `/runs/:id/report` returns up to 100 rows for a single-request run (every stored step for a scenario run, bounded by `maxScenarioStoredSteps`) and each may keep 32 KB on each of three nodes, so a 100-step scenario measured **3.3 M characters** with every node honestly flagged as truncated - 2.5x the size that failed in #767.
  At that row count truncation is no longer the binding constraint: 100 steps of an 8 KB body, under the per-node cap and so never touched, still totalled 845 K.
  So `get_run_report` also holds the traces to **96 KB in total** - `MAX_INLINE_BODY_BYTES * 3`, the largest single row the per-node bound can produce, rather than a new number beside it.
  Rows past the budget keep every scalar (id, status, latency, step identity) and carry `traceOmitted: true` in place of their trace, with `tracesOmitted` and `traceBudgetBytes` on the report; `read_body` reads an omitted row's bodies by `runId` and the row's `id`.
  **Non-passing steps spend the budget first**, matching `ScenarioStepStore::add`'s own rule for `stepsStored`, so the two do not disagree about which steps matter - and the rows come back in run order regardless, since the budget decides what a row carries, never where it sits.
  The first trace is always embedded whatever it costs, so a design run's single-row report never comes back empty.
  The rows themselves are not capped further: at ~200 bytes of scalars each they are noise beside one body, and the run's shape is the answer even when the payloads cannot come along.
  Bounded sizes for the fixtures above: 33 K characters for the single 1 MB row, 76 K for 100 steps x 1 MB, 120 K for 200 rows with all three nodes populated (24.7 M unbounded).
- **A trace can also carry `scripts.scriptRequests`** (issue #3633): one record per `pm.sendRequest` a design send's or a collection-run step's scripts made, each with its own `request` and `response` nodes.
  The engine writes them masked (credential headers and URL credentials `<redacted>`, the challenge headers shown) and holds all of one trace's record bodies to one `maxTraceBodyBytes` together, so a row's records add at most what its own response may (see [`POST /execute`](../api-reference/execute.md#post-execute)).
  That engine bound is 5 MiB, so `get_run_report` bounds the records as it bounds the main exchange: **each record's `request` and `response` body is cut to the same 32 KB**, with the same `bodyTruncated` / `bodyBytes` pair, and the records count toward the row's share of the 96 KB budget.
  **A trace over what is left of the budget gives up its records before anything of its own**, one step at a time, stopping at the first that fits.
  First the bodies: each one is stored `""` with `bodyTruncated: true` and its true `bodyBytes`, the engine's own spelling for a record body past its shared budget, and the `scripts` node gains `scriptRequestBodiesOmitted: true`.
  Then the detail: each record is cut to `source`, `scope`, `status`, `error_type`, `totalMs` and `request.method` / `request.url` (header maps, redirect hops, timing phases and the `response` node go), in the same order so a console line's `scriptRequest` index still names its call, and the node gains `scriptRequestDetailOmitted: true`.
  Last the records themselves: `scriptRequests` and both flags are removed and `scriptRequestsOmitted` holds how many there were.
  The main exchange is never cut for them; only a trace still over with no records left is omitted, as above.
  The first trace sheds the same way before it is embedded, so a design run's single row is bounded too.
  A sequential collection run's `lifecycle` rows (`script.setup` / `script.teardown`) carry records as `scriptRequests` too: their nodes are cut per node the same way, and their records together are held to a 96 KB budget of their own in run order, setup before teardown, a row past what is left giving them up by the same three steps under the same flags.
  A secret variable's value in any string of a record, a body included, is masked like the rest of the run's output, since a record uses the trace's own member names.
  The MCP server never sets `allowScriptRequests`, so only a run the app made carries records.
- **`start_load_run`'s `stream` flag** consumes each response as a `text/event-stream` (issue #576), with `maxStreamDurationMs` and `maxStreamEvents` bounding one stream.
  Both caps are forwarded verbatim on the `thresholds` precedent - their ranges are the engine's, and re-deriving them here would be a second copy to keep in step (shared with `run_collection`, where they need no flag, #3235) - and the tool states no `stream` of its own when the agent named none:
  a run by `requestId` keeps the saved request's Event stream setting, which the by-id compose carries (#3561), as the app's load run does, and an ad-hoc run sends no `stream` key, because the engine refuses a cap without the flag.
  Worth telling an agent explicitly: **reaching either cap completes the stream successfully**, so a streaming run's 0% error rate is not evidence the caps were never hit - `get_run_report`'s `stream.capped` is what answers that.
  The exception is a load run of an `mcp` request: a stream a cap or a close ends before its final response is an `mcp_transport` error ([stream endings](../api-reference/load-runs.md#streaming-under-load-stream)).
  The report's `stream` section also carries the per-completion event distribution, a derived `eventsPerSecond` and `timeToFirstEvent` (issue #3234), the wait from submit to each stream's first event, which `timingBreakdown.phases.firstByte` does not measure: it ends at the response headers.
  It stops at the first event of any kind, so an API that opens with a preamble event (Anthropic's `message_start`, an OpenAI role-only chunk) reads near zero on it and a budget on it passes whatever the first token costs:
  give the saved request a `streamFirstContentMarker` and read `timeToFirstMatch` (and budget `streamTimeToFirstMatchP95Ms`), the same clock stopped at the marker's bytes (issue #3774; absent when no stream matched).
  `maxEventGap` (each stream's longest pause between events, ms) and `eventRate` (each stream's own events/s) (issue #3776) are what tell a stall mid-reply or one slow stream from a healthy run, where the whole-run rate blends them.
- **`start_load_run`'s `monitor` block** scrapes the target's own metrics endpoint for the life of the run (`url`, optional `intervalMs` and `format`, and the `series` names to read), so an agent asked why a target slowed down can read its CPU on the same timeline as p99 -
  the report comes back with a `monitor` section carrying per-series min/max/avg, the sample count, and the missed scrapes split by cause:
  `failures` (no 2xx answer, the latest cause in `lastError`) and `noMatchScrapes` (answered, but none of the names matched; a Prometheus name is matched bare, so a `{label="..."}` filter is a `400`).
  The block is forwarded verbatim: its value ranges are the engine's (`validate_run_config`), and `monitor.series`' ceiling is the `monitorMaxSeries` **setting**, so a second copy of those bounds in the tool schema would refuse blocks the engine accepts the moment a user raises it.
  **The monitor endpoint is a second host**, and it takes the allowlist decision described under [Safety](safety.md#safety-model) rather than the target's check by extension.
  The engine holds `monitor.url` to the run's `targetPolicy` too (#3121), so a loopback or private host that decision exempts travels in the `allowedHosts` the run carries.
  The scrape needs no cap of its own: the monitor thread is joined when the run ends, so whatever bounds the run bounds it.
- **`compare_runs`** takes `baseRunId` optionally.
  Omitted, it resolves the run pinned as the **baseline** for whatever saved request the target ran - `GET /runs/:id` for the `requestId`, then `GET /runs?baseline=true&type=load&requestId=<id>&limit=1` - which is the same lookup the app's history view makes, so an agent and the UI never compare a run against different references.
  A load run over a collection has no `requestId`, so it resolves through the `configSnapshot.scenario.collectionId` the same `GET /runs/:id` carries instead (`collectionId=<id>` in place of `requestId=<id>`, #3544); a run naming both resolves through its request.
  The newest pinned load run wins, so a pinned sequential run of the same collection never shadows it.
  Nothing to resolve through (an ad-hoc run with neither a saved request nor a collection), no pin for that request or collection, or a target that *is* the pin: each is a refusal naming the fix, never a silent comparison against some other run.
  `export_run_report`'s `baseline: true` resolves the same way.
  **Two runs of different types are refused too** (#2438): a `run_type` entry in `comparability` makes the tool an error naming both runs, their types and `list_runs`' `type` filter, with no deltas, because a load test's throughput against a collection run's is not a regression either way.
  The `compare_runs` prompt embeds the same refusal in place of the comparison (`runTypeRefusal`, `tools/run-housekeeping.ts`).
  The History strip and the run-report export keep showing the entry.
  Every metric in the result carries a `direction` - `lower-is-better`, `higher-is-better` or `neutral` (total requests, which moves with how long a run was told to run) - so a reader can tell a regression from an improvement without knowing each metric's sense.
  A figure a run's report says the engine did not record is `null` on that side, with `delta` and `pctChange` `null` too (#2904): `summary.summaryMissing` (a failed run with no summary) nulls that run's `summary.*` metrics and its latency, `summary.partial` (reconciled after a crash) its latency alone.
  A zero there would read as a measurement.
  The result also carries **`comparability`** (#2162), which an agent reads *before* the deltas: a list of `{ code, message, base, target }`, empty for a like-for-like pair, one entry per way the runs were not the same experiment.
  `base` and `target` are the two values already formatted (`"20 s"` against `"3 s, stopped"`).
  The codes, always in this order: `run_type` (#2438; `design`, `load` and `scenario` shown as the app names them, `Send`, `Load test` and `Collection run`; a collection's load run is `load` too, so it compares with a single request's load run without this entry),
  `mode`, `concurrency` (virtual users; for a `ramp_up` run its start level and ramp time too), `target_rps`, `duration` (the runs' measured `summary.testDuration`, in seconds, more than 2x apart),
  `status` (any two differing run statuses, such as `Stopped` against `Completed`), `http_version` (`auto` is unknown and never differs), `data_file` (by content hash; none against one counts), `request` (method or URL, the URL without userinfo, query or fragment because the comparison is not masked the way `get_run_report` is),
  `compression` (the same fact as `compressionNegotiationDiffers`, which stays) and `expect_continue` (#2516; `Expect: 100-continue` `allowed` or `not allowed`, an absent key reading as `not allowed`).
  When both reports carry `metadata.runType`, a `mode`, `concurrency` or `target_rps` only one of them recorded is a difference, its missing side `not recorded`; a report with no `runType` is from an engine that may not record them, and there a field a report does not carry is unknown, not a difference.
  The history view's vs-baseline strip renders the same list from the same computation (`src/lib/run-compare.ts`), so the two cannot disagree.
  The result also carries `errorClasses` (#3828), `{transport?, protocol?, tool?}` of `{base, target}` counts of the two runs' failed `mcp` replies.
  It is `{}` unless **both** runs recorded `summary.errorClasses`: a run stored before the engine counted them has no figure, which is not `0` and would otherwise read as a regression.
  `protocolCodes` is not compared; read it on `get_run_report`.
- **Run housekeeping** (issue #755) is the History surface an agent could otherwise only page through: `list_runs` takes the engine's own filters (`type`, `status`, `outcome`, `requestId`, `collectionId`, `q` over the stored config, `baseline`) plus `limit`/`offset`, so finding one run is a query rather than a scan of 100-row blobs.
  Order is fixed newest-first - `GET /runs` takes no sort parameter, and the app's oldest-first view sorts client-side.
  `collectionId` matches a **collection run** and a **load run over a collection** (both store `scenario.collectionId`), never a single-request design or load run.
  The filters are Zod enums rather than passthrough strings because the engine *ignores* a `type`, `status` or `outcome` it cannot parse: forwarded raw, a typo would answer the unfiltered page and read as "nothing matched anywhere" - the app's own `not-judged` spelling is one, the engine's being `not_judged` (#3547).
  `set_run_baseline` writes the pin `compare_runs` already resolved but nothing could set (the write half #472 never shipped), and `delete_run` deletes a run and everything recorded against it behind the same write toggle + confirmation `delete_request` uses.
  A run still executing is stopped engine-side and deleted only once its worker settles; a worker that does not settle in time is a **409 with the run intact**, surfaced as "not deleted, retry once it reports a terminal status" rather than as a generic engine error.
  The call names the run, so a run pinned as a baseline is deleted too - unlike the app's *Clear run history* (`DELETE /runs`), which keeps pins (#2429); the tool description says so.
- **The stored-series reads are bounded on this side of the boundary.**
  `get_run_samples`, `get_run_timeseries` and `get_run_monitor` default to 25 / 100 / 100 rows against engine defaults of 50 / 5000 / 5000: those defaults are sized for the dashboard's charts, which draw every point for a human, and an agent reads the same rows as JSON through a context window.
  The ceilings are 500 (the engine's own page cap, shared with `GET /runs`) and 1000 for the two series, well under the engine's 50000.
  `maxPoints` on the two series reads (#3560) folds the whole run in one call, under the same 1000 ceiling.
  A `limit` past a ceiling is **refused, not clamped** - the #319 precedent - because a short page silently substituted for the one asked for reads as the whole answer.
  A page with more behind it says so inside the JSON document, never in a second text block that would stop the answer parsing (#2445): `pagination.nextOffset` is the `offset` to read next (null on the last page) and `pagination.note` says the same in words, present only while `hasMore` is true.
  The same holds for `list_runs` and `get_inbox_captures`, and all five declare the envelope as their `outputSchema`.
- **The whole-list reads page in the engine and summarise here** (#2443).
  `list_collections`, `list_requests`, `get_cookies` and `list_trash` forward `q` / `limit` / `offset` to the engine's paged list routes (50 rows by default, 500 max, refused above) and answer the same envelope, with the same `nextOffset` / `note`.
  The first three answer a summary row by default and the whole row with `fields: "full"`.
  The summary is cut on this side rather than by the engine's `GET /requests?fields=summary`, because withholding must see the whole row first: a request's `url` is masked by reading its `auth` (an API key placed in the query), which a summary does not carry.
  Paging and filtering stay in the engine, so the rows a call reads are still bounded by `limit`.
  The engine client's unpaged reads (`listCollections`, `listRequests`, `getCookies`, `listTrash`) are unchanged, and the internal readers that need every row - a delete's cascade, `move_item`, the collection runs, the spec tools and `vayu://collections` - keep calling them.

### Reading a stored body

`read_body` (#3704) is the way past the 32 KB inline cap: the tools above answer a body cut to `MAX_INLINE_BODY_BYTES`, and `read_body` reads the stored one a page at a time.
A call names exactly one body; arguments of two, or of none, are an `input` error.

| Source | Arguments | Read through |
| ------ | --------- | ------------ |
| A run result | `runId`, `resultId`; `part` `"response"` (default) or `"request"`; `scriptRequest` N for the trace's Nth `pm.sendRequest` record | `GET /runs/:runId/results/:resultId`, the trace's bodies at their stored length. `resultId` is the `resultId` a recorded `run_request` answers, or a report row's `id`. A load run's result stores no trace (its exchanges are samples), and that is an `input` error naming `get_run_samples` |
| An inbox capture | `inboxId`, `captureId` (a row's `id` in `get_inbox_captures`) | `GET /inbox/:id/requests/:captureId` (#3723), one call: the bare capture, whole, as a list row carries it |
| A saved example | `requestId`, `exampleId` | `GET /requests/:id/examples`, the example picked by id |

A streamed send's response body is the stream's bytes, its `event:`/`data:` lines as they arrived (#3770), so `read_body` pages them and `diff_bodies` compares two streams line by line like any other text.
A result stored before #3770 holds an empty body for an event stream: its events are in the trace's `events` node only.
The assembled reply is not in those bytes: a request that declares a `streamTextPath` (#3773) stores it as that node's `streamText`, which `get_run_report` returns, and `run_request` returns it as `text` beside the events it read.

An unknown run, result, inbox, capture or request is the engine's 404, worded as an unknown id (a capture the inbox does not hold, including another inbox's, is `Capture not found`); an example the request's list does not hold is a `not_found` error of the tool's own.

**The whole record is masked first, then paged.**
The fetched record goes through `runOutputShape` (`callEngineForRunOutput`) whole, the rule every run read uses ([Secret values](secrets.md#secret-values)), and only then is a page cut from it, so a secret that straddles a page boundary reads `<redacted>` in both pages rather than leaving each a prefix no secret form matches.
A saved example's body is masked by that rule too, and `list_request_examples` masks its bodies the same way before it bounds them, so the two read an example identically (#3724).
`totalBytes`, `offset` and `nextOffset` count the masked body, and a lookup the masking needs that fails refuses the read whole.

**A page** answers `{text, offset, nextOffset, totalBytes, encoding, done}`.
`length` is at most 32768 bytes, the default; the next page starts at `nextOffset`, which is the real end of `text`, never `offset + length`, and `done` is true once it reaches `totalBytes`.
A text body is cut on character boundaries at both ends: an `offset` inside a character steps back to its start (the answer's `offset` says so), the end steps back off a split one, and a character longer than `length` comes back whole so a read always moves.
A body with `encoding: "base64"` is not text: offsets count its decoded bytes, every page but the last is a whole number of 3-byte groups, and `text` is that page as base64, so the pages read on from 0 concatenate into the body's encoding.
`storedTruncated: true` says the store holds only a prefix (the engine cut the trace at `maxTraceBodyBytes`, a capture at its capture cap, or read no more than `maxDesignResponseBodyBytes`), so the last page ends there.

**`find`** answers the first 20 matches at or after `offset`, each its byte `offset` and a `context` of 80 bytes either side starting at `contextOffset` (on character boundaries, or base64 of the bytes for a base64 body, whose decoded bytes are searched), with `matchCount` over the whole body and `nextOffset` past the last match listed; it takes no `length`.
It searches the masked body, so a secret is not found by its value.

**`pointer`** (RFC 6901) reads one subtree of a JSON body instead of the whole, paged and sized the same way.
The subtree is re-serialized from the parse: compact, each object's keys sorted, a repeated key's last value kept, and every number as the body wrote it (the parse keeps the source text, so a 20-digit id is not rounded to a double).
A pointer into a body that does not parse, or a base64 one, and a pointer that names nothing, are `input` errors.

### Comparing two stored bodies

`diff_bodies` (#3705) answers what differs between two stored bodies, such as one request's prod and staging responses, without paging both through `read_body`.
`a` and `b` each take exactly the source arguments of [Reading a stored body](#reading-a-stored-body), and each is fetched as `read_body` fetches it.
A refusal says which side it is about (`Body "b": No example with id ...`), with the class `read_body` would give it.

**Both records are masked in one pass, then diffed.**
Unless the user reveals secrets, the two fetched records go through `runOutputShape` together, so a secret whose value differs between the bodies (a prod token and a staging token, each a secret variable) reads `<redacted>` on both sides and is no difference; a lookup the masking needs that fails refuses the call whole, as `read_body` does.
Sizes count the masked bytes.

| Bodies | `kind` | What is compared |
| ------ | ------ | ---------------- |
| Both parse as JSON | `"json"` | The parse, not the wire bytes: the same reading as `read_body`'s `pointer` (keys sorted, a repeated key's last value, every number by the text the body wrote, so `1.0` and `1` differ and a 20-digit id is not rounded). Objects are walked key by key in sorted order and arrays index by index, so an element inserted early shows every later index changed. Each difference is `op` `"changed"`, `"added"` or `"removed"` at an RFC 6901 `pointer` (`~` written `~0`, `/` written `~1`); a subtree only one side holds, or a value whose type changed, is one difference at its root |
| Otherwise, both text | `"text"` | Lines (split on `\n`). The lines both bodies start and end with are trimmed, and the region between is aligned on its longest common subsequence: a's `"removed"` lines and b's `"added"` lines, each with its 1-based `line` on its own side. A region past 1,000,000 cells (lines of a times lines of b) is not aligned: `coarse: true`, and it is listed whole, removed then added |
| Either is base64 | `"binary"` | Not diffed: `equal` says whether the decoded bytes match, and each side's `totalBytes` gives its decoded size. No `differences` list |

A difference carries `old` (a's value) and `new` (b's) as text: compact JSON for a JSON body, the line itself for text, each cut to 512 bytes on a character boundary with `truncated: true` when either was; `read_body`'s `pointer` reads a whole one.
`a` and `b` in the answer are each side's `{totalBytes, encoding, storedTruncated?}`, and `storedTruncated` there means the store holds only a prefix of that body, so the diff compared prefixes (a cut JSON body usually no longer parses, and is then line-diffed).

**The answer is bounded** to 32 KB (`MAX_INLINE_BODY_BYTES`) as serialized.
Differences are listed in their order until the next would not fit; the rest are not listed but still counted, so `differenceCount` is every difference, `omitted` is how many the list leaves out, and `omitted: 0` is a complete diff.
`equal` is true when nothing differs.

### Naming what the user means

A user points an agent at an entity with a **reference line**, the text the app's *Copy for agent* puts on the clipboard:

```
Vayu <kind> "<name>" (<id>)
```

`<name>` is what the app calls the entity, for a person to recognise; the `<id>` in parentheses is the key every tool takes (`requestId`, `collectionId`, `runId`, `inboxId`, `mockId`).
Look up the id, never the name: names repeat.
An entity the app labels by something other than a name is named by that: an inbox, a mock server and a mock issuer by their port (a mock server also by its collection), a capture by its method and path.

Six kinds belong to another entity, so the line names that owner.
A **variable** is its name in a scope - `in environment "<name>" (<id>)`, `in collection "<name>" (<id>)` or `in globals` - and the line never says what it holds, nor whether it is secret.
A **spec operation** is `"<METHOD> <path>"`, the path as the OpenAPI document templates it (`/pets/{petId}`), then `in collection "<name>" (<id>)` and, when the document declares one, `("<operationId>")`.
A **graphql operation** is its name in the document, then `in request "<name>" (<id>)`: the request's body holds the document, and the line never carries the query text, the variables or a header.
A **run sample** is `(<resultId>) of run (<runId>)`.
An **element** is named by its own name, else its kind (`script.pre`), then `of request "<name>" (<id>)` or `of collection "<name>" (<id>)`.
A **threshold** is its budget key (`latencyP95Ms`, `custom.<name>.<stat>`), then `of run (<runId>)` or `of request "<name>" (<id>)`.
Look each up through its owner's id; the next section lists the call each feeds.

Most kinds add a tail after the id.
` in <A / B>` places an entity in the collection tree, root first, and is left off at the root.
` - <detail>` describes what the id alone does not: a run's kind, target, start time and status, a trash entry's kind.
A `"` or `\` in a name is escaped with a backslash and a line break becomes a space, so a name never ends its own quotes or starts a second line.
**A reference carries no value**: a run's URL is cut to its path, with no query string or credentials, and no header, body, variable, token or secret is ever printed.
A run comparison is the one multi-line reference, and the one with no quoted name: a header naming the two run ids, then each run's own line.

Every line below is the app's formatter (`app/src/lib/agent-reference.ts`) run over one fixture, the entities in `app/src/lib/agent-reference.docs.test.ts`, which fails when a line here stops matching its output.
The run times are shown as `en-US` in UTC; the app prints the user's own locale and zone.
A run exported as a file ([`POST /export/run-report`](../api-reference/export.md#post-exportrun-report)) carries its line as `run.reference` with the start in ISO-8601 UTC (`2026-10-05T08:10:00Z`), since a file is read away from any one locale.

```
Vayu request "Create order" (req_3f9c1a52-7b0e-4d1a-9c55-0a1b2c3d4e5f) in Checkout / Orders
Vayu example "Created" (exa_2d4f6a81-3c5e-4b79-8a1c-6e8f0a2b4c6d) of request "Create order" (req_3f9c1a52-7b0e-4d1a-9c55-0a1b2c3d4e5f) in Checkout / Orders
Vayu element "Sign payload" (el_b4d6f8a0-2c1e-4a73-9b5d-7f9a1c3e5b70) of request "Create order" (req_3f9c1a52-7b0e-4d1a-9c55-0a1b2c3d4e5f)
Vayu collection "Orders" (col_4a6c8e02-9b1d-4f35-a7c8-1d3e5f708192) in Checkout
Vayu collection "Checkout" (col_8e2d4b17-1c3a-4f60-a9d2-5b6c7d8e9f01)
Vayu environment "Staging" (env_7c9e1b34-5d6f-4a80-b2c3-e4f5a6b7c8d9)
Vayu variable "baseUrl" in environment "Staging" (env_7c9e1b34-5d6f-4a80-b2c3-e4f5a6b7c8d9)
Vayu spec operation "GET /orders/{orderId}" in collection "Orders" (col_4a6c8e02-9b1d-4f35-a7c8-1d3e5f708192) ("getOrder")
Vayu graphql operation "CreateOrder" in request "Create order" (req_3f9c1a52-7b0e-4d1a-9c55-0a1b2c3d4e5f)
Vayu run "Create order" (run_5a7c9e21-4d3b-4a8f-b1c2-d3e4f5a6b7c8) - load test, POST /v1/orders, 10/5/26, 8:10:00 AM, completed
Vayu run "GET /v1/orders" (run_9d1f3b57-2e4c-4b68-a0d1-f2a3b4c5d6e7) - design run, GET /v1/orders, 10/5/26, 9:30:00 AM, failed
Vayu run "Checkout" (run_c3e5a7b9-1d2f-4c40-8e6a-0b1c2d3e4f50) - collection run, collection "Checkout", 10/6/26, 7:00:00 AM, completed
Vayu run comparison base (run_5a7c9e21-4d3b-4a8f-b1c2-d3e4f5a6b7c8) target (run_e8f0a2b4-6c7d-4e91-b3a5-c7d9e1f30415)
Vayu run "Create order" (run_5a7c9e21-4d3b-4a8f-b1c2-d3e4f5a6b7c8) - load test, POST /v1/orders, 10/5/26, 8:10:00 AM, completed
Vayu run "Create order" (run_e8f0a2b4-6c7d-4e91-b3a5-c7d9e1f30415) - load test, POST /v1/orders, 10/7/26, 8:10:00 AM, stopped
Vayu run sample (1042) of run (run_5a7c9e21-4d3b-4a8f-b1c2-d3e4f5a6b7c8)
Vayu threshold "latencyP95Ms" of run (run_5a7c9e21-4d3b-4a8f-b1c2-d3e4f5a6b7c8)
Vayu inbox "port 8099" (inbox_c0d1e2f3-a4b5-4c6d-8e7f-9a0b1c2d3e4f)
Vayu capture "POST /stripe/events" (7) in inbox (inbox_c0d1e2f3-a4b5-4c6d-8e7f-9a0b1c2d3e4f)
Vayu mock server "Orders on port 4010" (mock_1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d)
Vayu mock issuer "port 9100" (issuer_6f8a0c2e-4b5d-4e71-9a3c-5e7f9b1d3a45)
Vayu trash entry "Legacy \"v1\" orders" (col_a1b3c5d7-e9f0-4a2b-8c4d-6e8f0a1b3c5e) - collection
```

Where the user copies each kind from in the app:

- **request**: the request's row menu in the Collections drawer, and its tab's menu.
- **example**: the copy button on the example's row in the request's Examples tab.
- **collection**: the collection's row menu, and its tab's menu.
- **environment**: the environment's row menu in the Variables drawer.
- **run**: the run's row menu in History, the run tab's header, and its tab's menu.
- **run comparison**: *Copy comparison for agent* on a load test report's vs-baseline strip.
- **inbox**: the inbox's row menu in the Services drawer, the inbox tab's header, and its tab's menu.
- **capture**: the copy button in the capture's detail header.
- **mock server**: the mock's row menu in the Services drawer, the mock-server tab's header, and its tab's menu.
- **mock issuer**: the issuer's row menu in the Services drawer.
- **trash entry**: the copy button on the entry in Trash.
- **variable**: the copy button on the variable's row in the Variables drawer, for an environment's, a collection's and the globals alike.
  Feeds `resolve_variables` and `update_environment`, `update_collection` or `update_globals` for its scope.
- **spec operation**: the copy button on an operation's row in a collection's spec sync (the added, changed and removed lists).
  Feeds `get_spec`, `diff_spec` and `sync_spec`, which match on its method and path.
- **graphql operation**: the copy button beside the operation picker in the Query pane of a saved GraphQL request (the picker shows once the document defines more than one operation and one is chosen).
  Feeds `get_graphql_schema`'s `requestId` and the envelope's `operationName` in `run_request` and `update_request`.
- **run sample**: the copy button in a sample card's header on a load test's Samples tab.
  Feeds `get_run_samples` and `get_run_report`, which join on its `resultId`.
- **element**: the copy item in an element's row menu, in a request's or a collection's Elements list.
  Feeds the `elements` argument of `update_request` and `update_collection`.
- **threshold**: the copy button on a budget's row in the load test config dialog (a custom budget included), and on its verdict in a load test report.
  Feeds `start_load_run`'s `thresholds` and `get_run_report`'s verdict.

The command palette's `Copy "<tab>" for agent` copies the line of whichever of those tabs is active.

Two rules for the cases where the user did not paste one:

- **The request the user means:** ask the user for a Vayu reference line, or call `get_app_focus`.
  It reports the tab and environment open in the app window right now - `activeTab` (`type`, `entityId`, `label`), `run` (`{ runId }`, set only when the open tab is a run) and `activeEnvironment` (`id`, `name`) - and nothing else: no variable value, header or credential.
  Read the entity itself with its own tool (`get_request` for a request).
- **A run the agent started:** read it by the `runId` its start call returned, not by its position in `list_runs`: the list is newest-first, so a newer run, the user's or another client's, moves that position.

`get_app_focus` is served from the renderer's last report and answers an error saying the Vayu window is not connected where there is none: the stdio CLI, and the app before its window has published.
A tab's `label` is a saved name or a kind word (`Request`, `Run`), never text derived from a URL, because an unnamed request and a design or load run are titled by their resolved URL path in the app and that path can hold a secret variable's value.

The server instructions carry the grammar and both rules in every session, without tool names (the instructions never name a tool; each tool's description is its one contract).
They also say that a GraphQL request's schema can be read through Vayu, introspected with the request's own auth and answered as SDL, before a query is written.
