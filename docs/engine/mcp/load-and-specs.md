---
description: >-
  Notes on the MCP tools that start load runs and bind, diff, sync and import API specs.
---

# MCP load runs and spec bindings

- **`start_load_run`** requires confirmation - a question to the person when the client can be asked, otherwise a `confirmed: true` flag (see [What is live on each transport](transports.md#what-is-live-on-each-transport)) - and enforces the RPS / virtual-user (`concurrency`) / duration caps.
  In `capacity` mode the virtual-user cap bounds the search's *ceiling* (`concurrency`) and its starting level (`startConcurrency`), which is what stops an adaptive run from outgrowing it;
  `sloMs` and `stepDuration` are that mode's own two fields, and `get_run_report` returns the search's findings under `capacity`, including each level's `errorPct` and `samples` (the completions its p99 was read from; 0 means it measured nothing), the `kneeErrorPct` and the `maxErrorPct` limit a level breaches above, beside the p99s.
  A `plateau` stop also carries `saturationConcurrency`, `saturationRps` and `saturationP99Ms`, the level where throughput stopped growing.
  Every shape field the agent leaves out is sent as the engine's default for the mode ([Load defaults](safety.md#load-defaults)), so the caps judge the run that will start, the confirmation preview states it in words ("constant_concurrency, 100 virtual users, closed loop, 60 s") with the resolved fields in its planned payload, and the started result's `shape` object carries the same fields.
  `get_live_metrics` is a **bounded snapshot** (SSE read with a time budget), not a stream - `tools/call` stays request/response.
  The engine drops a run's live buffer 60 s after it ends by default (`liveRetentionMs`); the answer after that is the expired-buffer sentence described under [Error results](conventions.md#error-results), not the engine's body.
  The answer carries `completed` beside the ticks, so a run that finished is told apart from a read that merely ran out of budget (#2955).
- **What a load run *keeps* is settable too** (issue #760), which is what the MCP surface was missing rather than any part of the load shape:
  `successSamplePeriod` (the engine's `success_sample_rate` - a **period**, keep 1 in N, not a percentage; the argument is named for what the value means and the payload key stays the engine's), `slowRequestThresholdMs`, `saveTimingBreakdown` and `comment`, plus the two that size the population of the sampled replay (#2447, #3555):
  `responseSamplePeriod` (`response_sample_rate`, a period too, 1-100000, engine default 100) and `maxResponseSamples` (`max_response_samples`, 0-1000000, engine default 1000; 0 keeps none) bound the responses kept for `postRequestScript`, stored scripts and schema checks, whose outcome is the report's `testValidation` and `schemaValidation`.
  They do not feed `get_run_samples`, which reads the errors, the completions at or above `slowRequestThresholdMs` and the first three of each status code.
  A kept response is a full body in memory until the replay has run, so the count is held to the **Max response samples** cap ([Safety config](safety.md#safety-config)), and the confirmation preview shows both keys in its planned payload.
  All of them reach a **scenario** run too: both executors read them off the one `RunContext`, and `comment` is lifted into the run summary and the report's `metadata.configuration` whichever produced the run.
  Bounds mirror `validate_run_config`, so a value the schema accepts is one `POST /runs` accepts, and an absent knob stays absent - each has an engine default a stated value would overwrite.
  `retryAfterBackoff` and `retryAfterMaxMs` (#3782) ride the same forwarding, under the engine's own camelCase keys: with the option on, a `429` or `503` carrying `Retry-After` holds the virtual user that received it for that long, capped at `retryAfterMaxMs` (1-3600000, engine default 30000), before its next request.
  Off by default, because a run that backs off measures the rate the limiter allows; a `constant_rps` run skips it and the report says so.
  A scenario run takes both too.
  The report's `warnings` carry `rate_limited_dominant` when the option is off and most responses were `429`, and `retry_after_backoff` (the waits counted) when it is on.
  The **redirect policy** (`followRedirects` / `maxRedirects`) belongs to the request half instead: it rides through `POST /compose` beside the method and the body, overriding a saved request's stored policy or supplying the only one an ad-hoc target has.
  A scenario run refuses both by name, as it does every other single-target field - each step keeps the policy stored on it.
  `maxRedirects` is bounded 0-100 here because `POST /runs` has no guard of its own and the value becomes the redirect limit, where a negative means *unlimited*.
  **The tool exposes no per-run `timeout`, and that is not an omission**: `POST /runs` accepts one, but a run started here takes the timeout of the request itself.
  A run started by `requestId` sends with the stored request's own `timeout` when it states one (issue #2937), because `POST /compose` writes it into the payload the run is started from;
  otherwise, and for an ad-hoc target, it takes the `defaultTimeout` setting (`resolve_request_timeout_ms`), which `update_engine_config` changes - the run's OAuth 2.0 token fetches and every `pm.sendRequest` its scripts make included (issues #2833, #2841).
  Four transfers keep bounds of their own: a stream ends on its idle timeout and its duration and event caps, never a whole-transfer deadline; the import fetch has its own 30 s and stall timeout; the connection test its 10 s; and the server-vitals monitor its scrape timeout.
  Recorded here so it is not re-derived as a gap each time the schema is read.
- **An agent can bind a collection to a spec now, export one, ask whether a contract has drifted and apply the safe half of that drift** (issues [#862](https://github.com/athrvk/vayu/issues/862), [#855](https://github.com/athrvk/vayu/issues/855) and [#871](https://github.com/athrvk/vayu/issues/871)) **and import a document outright** (issue [#877](https://github.com/athrvk/vayu/issues/877)).
  `get_spec` says what a collection is bound to, `diff_spec` says what a re-fetched document would change about it, `sync_spec` applies the part of that a caller with no opinion should apply, `bind_spec` binds one, `export_spec` writes it back out as a document, and `unbind_spec` detaches it.
  `bind_spec` takes the document text and nothing else - no pairing
  - because everything it needs is engine-side after #761's phase B:
  the engine reads the document (issue #853), derives **both** indexes from it - the operation index and the response-schema index, dialect translation included (issues #629, #628, #860) - and matches the collection's subtree against the index it just derived, through the same `core::operation_match.hpp` rule `POST /specs/match` previews with.
  So a document an agent sends as bytes reports coverage and validates responses, with no OpenAPI reader on the agent's side, and `POST /specs/export` owns the assembly that sends one back.
  **A bind writes identity in both directions**, which is what kept the tool out through phase A: re-binding to a different document clears every stamp that document does not account for, because coverage resolves a stamp by `operationId` and a surviving one claims the wrong operation rather than none.
  The tool result reports `cleared` beside `stamped` for that reason - it is the half a caller would otherwise discover from a later run.
  `unbind_spec` still leaves stamps alone, so unbind-then-rebind of the same document costs nothing.
- **`import_document` is the fourth verb, and the one that took a parser move** (issue [#877](https://github.com/athrvk/vayu/issues/877)).
  Every other spec tool had shipped while this one could not: `POST /import/apply` takes a *parsed tree*, and the four parsers that built one lived in the renderer, so an agent could bind, diff, sync and export a contract and not import a document.
  They are engine-side now - `core/import_document.hpp`, reading through the same `core::read_document` that answers what a stored document declares - so the tool sends bytes and options and nothing else, and detection is by content rather than by a `format` argument a caller could get wrong.
  `POST /import` is the parse, the flattening and `POST /import/apply` in one call: the tree lands atomically, and the globals a Postman globals export carries are **merged** afterwards rather than written over, because `POST /globals` replaces the whole set and must not run in front of a write that can still fail.
  The caveat sentence names `meta.skipped` for the reason `diff_spec` names `userTouched`: an import that dropped a WebSocket request, an unsupported body or an operation's `default` response looks exactly like one that had none.
  A Postman script that calls an API Vayu does not run (`require()` of anything but `crypto-js`, `uuid`, `lodash`, `moment`, `csv-parse/lib/sync`, `xml2js`, `chai`, `ajv` and `tv4`, a bundled library such as `cheerio`) imports and throws at first run,
  so `meta.unsupportedScriptApis` (issue [#2576](https://github.com/athrvk/vayu/issues/2576); `[{request, names}]`, absent when empty) names those requests in both tools' result, `meta` riding whole.
  **External `$ref`s are not followed** - resolving one means fetching a URL or reading a file beside the document, which is the import dialog's business (a URL proxy and a gated IPC), so a multi-file spec imports whole and says nothing about the files it names.
- **`diff_spec` is the read half of a sync** (issue [#871](https://github.com/athrvk/vayu/issues/871)).
  It sends the collection and the candidate document and nothing else: the requests and the **bound** document are the engine's to read, because a caller that could supply the "previous" side of a three-way comparison could turn its own edits into the document's.
  Three things about the answer are this tool's rather than the route's.
  The per-entry `draft` is **dropped** - it is what an apply would write, and `POST /specs/sync` re-reads it off the document it stores rather than being handed it, so nothing on either side of the tool consumes it; the rendered `current` / `next` pair, which is what says what moved, survives.
  Each bucket is capped at 50 entries while `summary` keeps the engine's true totals, so a document that renamed every operation comes back described rather than whole.
  The **`declined`** bucket (issue [#3031](https://github.com/athrvk/vayu/issues/3031)) is the operations whose request the user deleted: shaped like `added`, counted in `summary.declined`, and described in the caveat sentence as the user's call rather than an omission.
  It is the same entries the Spec tab lists unticked, and no MCP tool can tick one - `sync_spec` takes no rows, and the person brings one back in the app.
  And a field flagged `userTouched` is named in the caveat sentence, not just carried in the JSON: it is the one part of a drift an apply may not take silently, and an agent reading "6 changed" would otherwise propose overwriting somebody's edit.
- **`sync_spec` applies a drift, and does not let the agent choose which of it** (issue [#871](https://github.com/athrvk/vayu/issues/871)).
  It sends `policy: "safe"` and nothing else: the engine works out the rows from `core::safe_spec_apply`, the same function whose answer `diff_spec` reports per entry as `safe` / `safeFields`.
  That is the whole design.
  Which of a drift is safe to write - **every operation the document adds (never one whose request the user deleted, issue #3031), every field it moved that nobody had edited by hand, no deletions, and a request whose bound document could not be read left alone whole** -
  is decided engine-side, not in the renderer's `spec-apply.ts` (`defaultSelection`), because
  `electron/` may not import `src/`, so any tool would need a copy there, and a copy of *that* rule is a second opinion about which of a user's fields a sync may overwrite.
  `defaultSelection` reads the marks rather than deriving them, so the Spec tab's pre-ticked boxes and an agent's sync are one answer.
  A person who changes a tick still sends explicit rows - a choice a person made is not a policy.
  The tool result's `skipped` (requests untouched, fields not written, deletions not made, declined operations not re-created) is named in the caveat sentence for `diff_spec`'s reason: a caller that stated no ticks cannot see what it did not tick, and "5 updated" alone reads as "applied the drift".
