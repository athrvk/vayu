# Engine (C++20 daemon)

The load-testing and request-execution engine. AGPL-3.0. See the repo root
`CLAUDE.md` for build commands, commit rules and repo-wide conventions.

```
engine/
├── src/core/      # load_strategy, metrics_collector, run_manager
├── src/http/      # HTTP server, SSE, routes, thread_pool, rate_limiter
├── src/db/        # SQLite persistence
├── src/runtime/   # QuickJS scripting engine
├── include/vayu/  # Public headers
├── tests/         # Google Test suite
└── vendor/        # quickjs-ng, hdrhistogram
```

## Conventions

- Standard: C++20, `-Wall -Wextra -Wpedantic`
- Formatter: clang-format (`.clang-format` at repo root)
- Linter: clang-tidy (`.clang-tidy` configs in `engine/`, `engine/src/runtime/`,
  `engine/tests/`)
- Install the git pre-commit hook: `bash scripts/install-git-hooks.sh`
- vcpkg manages all C++ dependencies - do not add one without updating
  `engine/vcpkg.json`. **In the cloud dev environment, adding one needs a second
  step**: its egress policy answers GitHub *source archives* with `403` while
  allowing git-over-https, so a port fetched by `vcpkg_from_github` fails on a
  cold cache with `curl operation failed with response code 403`. That is not
  the dependency being unavailable - run `vcpkg-fix-port <port>` (no arguments
  re-does the whole manifest), which rewrites the port to `vcpkg_from_git` as an
  overlay, then build again. A session read that 403 as a policy wall and
  abandoned a phase of #625 over it.
- A new `tests/*_test.cpp` must be listed in `add_executable(vayu_tests ...)`
  in `engine/CMakeLists.txt` - the source list is explicit, never a glob. A
  guard beside it fails configure naming any unregistered file, because an
  unbuilt test file reports nothing at all (#668: a 16-test suite sat unbuilt
  for ~140 commits).
- A fixture that opens a scratch `Database` cleans up with
  `vayu::tests::remove_database_files` (`engine/tests/temp_database.hpp`) - never
  a hand-written suffix list. An opened database writes six files, not the four
  the old copies listed, and eight of those twenty-two copies were wrong (#413).

## HTTP API

The daemon listens on `http://127.0.0.1:9876`. Key endpoints:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/compose` | Resolve `{{vars}}` + `inherit` auth; returns an execute-ready payload (sends nothing) |
| POST | `/execute` | Send a single request (auth resolved engine-side) |
| POST | `/runs` | Start a load test run |
| GET | `/runs/:runId/live` | SSE stream of live metrics |
| GET | `/runs/:runId/events` | SSE relay of a streaming request's events (`POST /execute` with `stream: true`) |
| GET | `/runs/:runId/metrics` | Historical time-series (JSON) for a run |
| POST | `/oauth2/token` | Acquire/return a cached OAuth 2.0 token (auth resolved engine-side) |
| GET | `/health` | Health check |
| POST | `/import/apply` | Persist a whole parsed import atomically; returns a temp-id -> real-id map |
| GET | `/requests/:id/examples` | A request's saved example responses (issue #481), in stored order |
| POST | `/specs` | Store an OpenAPI document (issue #637); `GET`/`DELETE /specs/:id` read and remove it |
| POST | `/specs/sync` | Apply a re-fetched document to the collection bound to it (issue #655) - new document, moved binding and the created/updated/deleted requests in one transaction |
| POST | `/collections`, `/requests`, `/environments`, `/requests/:id/examples` | **Create only** - 409 on an existing id |
| PUT | `/collections/:id`, `/requests/:id`, `/environments/:id`, `/requests/:id/examples/:exampleId` | **Update only** (merge-patch) - 404 on a missing id |

The pre-consolidation paths (`POST /request`, `POST /run`, `GET /run/:id[/report|/stop]`,
`DELETE /run/:id`, `GET /metrics/live/:runId`, `GET /stats/:runId?format=json`) still
work as **deprecated aliases** and will be removed in a future minor release; `GET
/stats/:runId` in its SSE mode is retained wholesale. See `docs/engine/api-reference.md`
(Deprecated aliases) for full reference.

Three things worth knowing before you design around them:

- **POST creates, PUT updates - they are not interchangeable.** `POST
  /<resource>` never updates and `PUT /<resource>/:id` on an id that does not
  exist is a `404`; POST-as-upsert is gone (issue #95). One null-vs-absent rule
  covers all three resources: on create
  absent and `null` both mean "use the default", on update absent means "keep"
  and `null` means "reset to the default", and a field with no default (a
  collection's / environment's `name`, a request's `collectionId` / `name` /
  `method` / `url`) rejects `null` with a `400` instead of ignoring the write.
  The rule lives in one place per side - `apply_*_field` in
  `engine/include/vayu/http/routes.hpp`, and `apiService.updateX` in
  `app/src/services/api.ts` - so add fields there rather than re-deriving the
  rule per handler. **The engine owns every id** (#97): a create carrying an `id`
  is a `400` (presence alone, `null` included - `id` is outside the null rule),
  and a `PUT` whose body `id` disagrees with the path is a `400` too, so the 409
  on an existing id now only guards a `generate_id` collision.
  `reject_client_supplied_id` / `reject_mismatched_body_id` in `routes.hpp` are
  the one copy of that; `apiService.createX` strips `id` on the renderer side
  because TypeScript only excess-property-checks object literals. Bulk import
  goes through **`POST /import/apply`** (#96), which takes opaque `tempId`s,
  generates every real id engine-side, returns the `idMap`, and writes the whole
  tree in one transaction (a rejected payload persists nothing, so the old
  client-side rollback is gone). The same per-resource field appliers back both
  paths - `apply_collection_fields` / `apply_request_fields` /
  `apply_environment_fields`, declared in `routes.hpp` - so add a field there and
  bulk import gets it too.
- **Saved examples are nested under their request** (`/requests/:id/examples`,
  issue #481) because one owns them: the owner is checked before the example on
  every path, so an example reached through the wrong request is a `404` rather
  than a cross-request write, and both `delete_request` and the collection
  cascade take the examples with them. Ordering is a contract, not a display
  choice - the list comes back by `order` (then `created_at`, then `id`) and a
  mock server will answer with the first one. `POST /import/apply` writes them
  nested on the request item, through the same `apply_request_example_fields`
  applier the single-item route uses, so the two paths cannot drift. Every row
  records an **`origin`** (#588): `import` for what an importer or a spec sync
  wrote, `user` for what the app saved from a live response - defaulting to
  `import`, and a `400` on anything else. It is stored so the OpenAPI spec sync
  (`POST /specs/sync`, #655) can replace the first kind without touching the
  second; nothing else about a row says where it came from.
- **`GET /requests/:id` is a single-request lookup.** `useRequestQuery` uses it
  to load a restored request tab or a design-run copy on cold start - one round
  trip, not the old scan of every collection's list. A `404` means the request
  was genuinely deleted; anything else (a `5xx`, an unreachable engine) is a
  transport failure, and callers (`DesignRunView`) must keep those apart - only
  a real 404 becomes `RequestNotFoundError`. `GET /requests?collectionId=` still
  lists a collection's requests.
- **A streaming request is a different execution model, declared not detected**
  (#573). `POST /execute` with `"stream": true` creates the run row, hands the
  transfer to a managed consumer worker (`SseStreamManager`, declared before
  `server_` like the listener managers) and answers `202 {runId, eventsUrl}`;
  `GET /runs/:runId/events` relays a bounded ring of parsed events, and the
  completed run's trace carries a bounded `events` node. **Every stream ends by
  a rule that can name itself** - server close, `POST /runs/:id/stop`,
  `maxStreamEvents`, `maxStreamDurationMs`, or the idle timeout - never a
  whole-transfer deadline, which is deliberately not set on this path. `stream`
  with `transient` is a **400** rather than a silent reinterpretation.
  **`POST /runs` takes `stream` too** (#576), through the *same*
  `read_stream_flag` parser, so both endpoints agree on the spelling, the types
  and the ranges. What differs is what enforces the caps: a load stream becomes
  `Request::stream_bounds` and the event loop ends it, counting events with
  `SseFrameCounter` (the hot-path counter, which agrees with `SseParser` on what
  an event is). **Under load a stream is bounded by construction** - both caps
  are always set, never zero-for-unbounded - because the load loop refills
  concurrency per completion, so a transfer that never ends leaks its slot for
  the rest of the run. **Reaching a cap is a successful completion**, not a
  timeout; the byte cap (`maxResponseBodyBytes`) stays an error, and the
  whole-transfer timeout becomes a backstop past the duration cap. The report
  gains a `stream` section (per-completion event distribution, totals,
  `capped`, derived `eventsPerSecond`), absent for every run that did not
  stream. **A load stream's events are parsed back, never stored twice**
  (#657): the sample's body already *is* the `text/event-stream` bytes, so the
  deferred script replay and `GET /runs/:id/samples` both rebuild the list with
  `buffered_stream_events_node` - one `SseParser`, one definition of an event -
  bounded by `sseMaxStoredEvents`. The one thing stored beside the body is the
  wire count (`result_bodies.stream_events`, NULL = not a stream), because a cut
  body cannot report the length of the stream it is a prefix of.
  **Scripts run** (#575): the pre-request one before the
  transfer, the post-request one after the stream ends, reading the bounded list
  as `pm.response.events`; because the route already answered `202`, their
  output is stored on the trace's `scripts` node rather than returned. **A
  consumer worker is drained by whoever owns the manager, before the state it
  writes through goes away** (#646): `Server::stop()` calls
  `SseStreamManager::shutdown()` - which signals every stream and *joins* its
  worker - because `daemon.cpp` runs `curl_global_cleanup` between that call and
  `~Server`. A test fixture holding a manager beside a `Database` it resets owes
  the same order, and the two SSE fixtures hold it by keeping the manager in a
  `unique_ptr` reset first. Waiting on `context->closed()` is *not* draining: it
  flips at the end of the transfer, with the completion callback - which writes
  the run row - still to run.
- **An OpenAPI document is stored once and *bound* by collections, never owned
  by one** (#637). `spec_documents` holds the text verbatim plus an
  engine-computed `hash`; `collections.openapi`
  (`{specId, specHash, syncedAt}`, `{}` = unbound) is the edge, and
  `requests.spec_operation` (`{operationId?, method, path}`, NULL = none) says
  which operation a request *is*. Several collections may bind one document, so
  nothing cascades to it: `DELETE /specs/:id` is a **409 naming the binder**
  while any collection holds it, and there is no `PUT /specs/:id` - a changed
  document is a new one, because rewriting in place would invalidate the hash
  every run of every bound collection was stamped with. A scenario run of a
  bound collection stamps `specId` + `specHash` into `config_snapshot` and
  `GET /runs/:id/report` echoes it under `metadata.openapi`; an unbound run
  carries no key at all. **Applying a re-fetched document is `POST /specs/sync`**
  (#655), not a sequence of writes: it is the one route that creates, updates
  *and* deletes, which is why it is deliberately outside `/import/apply` (that
  one only creates, which is what lets it own every id with nothing stored behind
  it). It refuses to touch a request outside the synced collection's subtree and
  replaces only `origin="import"` examples. `Database::spec_sync_apply` is its
  transaction, a sibling of `import_apply` and `apply_reorder` for the same
  reason those two are separate.
  **Responses are validated against what the document declares** (#628):
  `spec_documents.response_schemas` holds an app-extracted index (schemas as
  written, plus one shared `refRoots` their `$ref`s resolve through), and
  `core/schema_validation.cpp` matches a response to one by status pattern and
  media type and validates it with **valijson** - not the `json-schema-validator`
  #625 named, which segfaults on a recursive schema. The engine still parses no
  OpenAPI: the app translates 3.0's dialect into JSON Schema before storing.
  Three rules the shape enforces: an unbound collection gets **no `validation`
  node at all** (never judged is not judged-and-passed); `checked: false` carries
  a reason code and no validity; and keywords the draft-07 validator cannot
  evaluate are **named and counted** on the verdict, because a body reported
  clean by a schema half of which went unread is the failure mode this feature
  would otherwise introduce. `POST /execute` returns the node and
  `record_design_result` stores the *same object* on the trace, so the live and
  restored panes cannot disagree. The status-pattern matcher is shared with
  coverage (`match_status_pattern`), so one status cannot be "covered" by one
  rule and "no schema for this status" by another.
  **Under load the same check is deferred to run end** (#682):
  `validate_sampled_responses` walks the per-step sample reservoirs once the run
  has drained and stores `schemaValidation` on `runs.summary`, because the load
  loop refills concurrency per completion and a schema walk there would cost
  throughput invisibly - a source-scan test fails if validation reaches
  `load_strategy.cpp` / `scenario_load.cpp`. That makes the tallies **sampled
  where `coverage` beside them is exact**, so the block stores its own `sampled`
  denominator and every reader prints it. A step's responses are now kept for
  either of two reasons - a script to replay, or a contract to check - which is
  what `configure_step_samples` is told; one budget covers both, so a bound
  collection that also asserts thins each step's share.
- **`followRedirects` / `maxRedirects` are per-request and stored** (request
  builder → **Settings** tab, `requests.follow_redirects` / `max_redirects`).
  Both clients send them on *every* execute and load test rather than eliding
  the defaults, because the engine's `follow_redirects` defaults to **true** -
  an omitted `false` would silently follow the 3xx the user asked to see.
  **`verifySSL` is still engine-only**; it was deliberately not exposed.

## Request composition (engine-owned - POST /compose)

The **engine owns** request composition (issue #226, backlog A1 shipped):
`POST /compose` (`engine/src/http/request_composer.cpp`) resolves
`{{variables}}` and `inherit` auth (collection-chain walk, `noauth`
terminates, `none` steps over) and returns the execute-ready payload that
`POST /execute` / `POST /runs` accept unchanged. Compose is **pure** (sends
nothing, no run row) and the execution endpoints **never interpolate**, so a
payload is resolved exactly once - that split is load-bearing, do not "merge"
compose into execute. Two entry shapes: `requestId` (stored request; MCP uses
this, and gates its allowlist on the *composed* URL) and an inline `request`
(+ `collectionId` scope; the renderer uses this because Send/replay execute
*editor state*, which may be unsaved or detached). Inline over stored = the
overlay MCP's `start_load_run` overrides ride on.

**The renderer's resolver is preview-only.** `useVariableResolver` /
`app/src/lib/variable-resolution.ts` back tab titles, previews, the
unresolved-token painting and the OAuth-guard preview - never a payload. The
preview must show what the engine will substitute, so its rules are pinned to
the engine's by the **cross-language conformance fixture**
(`engine/tests/fixtures/variable-resolution-conformance.json`), read by both
`request_composer_test.cpp` (gtest) and
`variable-resolution.conformance.test.ts` (vitest). Change resolution
semantics → change engine + renderer lib + fixture together; a case added to
the fixture fails whichever side forgot. The dynamic-variable name set
(`$guid`, `$timestamp`, …) is part of that fixture-pinned contract (C++ table
in `request_composer.cpp`, renderer table in `lib/dynamic-variables.ts`).
The D17 malformed-data rules (absent/non-boolean `enabled` = enabled;
non-string `value` = "") live engine-side in `parse_variables` and
renderer-side in `lib/variable-resolution.ts`. Interpolation happens strictly
**before** the pre-request script (D1 - deliberate Postman divergence), and
script text is never interpolated (D16). **MCP has no composition copy
anymore** (`resolve.ts` deleted) - a new engine client should call
`POST /compose`, never re-implement resolution client-side.

Script parts: clients on the inline path still build the ordered `ScriptPart`
list themselves (`scriptParts` in
`app/src/modules/request-builder/utils/script-parts.ts` - now the only
client-side copy); the by-id path builds it engine-side
(`compose_script_parts`). The **engine** joins parts with `"\n\n"` and runs
the result. **Both names reach the same script**: `read_post_request_script`
(`engine/src/http/script_parts.cpp`) owns every spelling the post-request
script answers to - stored as `postRequestScript`, `postRequestScript(s)` on
`/execute`, `tests` on `/runs` - and both routes read through it, so a payload
composed for one endpoint can start the other kind of run unchanged. Add a
spelling to that table, never to a route.

The endpoint names above are the canonical ones (`POST /compose`,
`POST /execute`, `POST /runs`); the old `POST /request` / `POST /run` still
work as deprecated aliases. An unresolved `{"mode":"inherit"}` reaching an
execution endpoint is treated as no auth and logged as a **warning** - it
means a client skipped composition.

## Docs to keep in step

| Doc | Update it when you change… |
|-----|----------------------------|
| `docs/engine/api-reference.md` | **Any** endpoint, payload, or status code |
| `docs/engine/architecture.md` | Core engine structure, auth resolution |
| `docs/engine/db-schema.md` | Schema, migrations, stored JSON |
| `docs/engine/scripting.md` | Script globals, hooks, sandbox limits |
| `docs/engine/mcp.md` | MCP tools or their schemas |
| `docs/engine/cli.md` | Flags or subcommands |
| `docs/engine/benchmarks.md` | Load generation or measurement |
| `docs/engine/building.md` | CMake presets, vcpkg deps |
