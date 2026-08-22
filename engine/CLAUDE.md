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
- Formatter: clang-format, **19 exactly** (`.clang-format` at repo root; the
  version is pinned because 39 of the 285 engine sources format differently
  under 18). **A difference is a failure now** (#886): the `Engine formatting`
  job in `pr-tests.yml` runs `--dry-run -Werror` over the whole of
  `engine/{src,include,tests}` - whole tree, unlike the clang-tidy gate, because
  the bulk-format commit left no backlog to grandfather. The config was derived
  by measuring the bulk diff each setting produces, so its two odd-looking
  settings (`ColumnLimit: 80` with `PenaltyExcessCharacter: 1`, and
  `ContinuationIndentWidth: 0`) are what the code is written to, not oversights;
  both are commented in the file. `engine/vendor/` sets `DisableFormat: true`.
  **Includes are sorted**, with exactly one pinned exemption: the
  `<windows.h>` / `<timeapi.h>` pair in `src/platform/platform_windows.cpp`,
  wrapped in `// clang-format off` because timeapi.h needs windows.h's types
  and sorts first alphabetically. If you hit a second such case, pin it at the
  site the same way - do not turn the sorter off for the tree.
  Before editing the config, read the note at the top of it - a "tidier" value
  costs a five-figure-line rewrite.
- Linter: clang-tidy (`.clang-tidy` configs in `engine/`, `engine/src/runtime/`,
  `engine/tests/`), **19 or newer** - the root config uses
  `ExcludeHeaderFilterRegex`, which an older binary rejects outright. **A
  finding is a failure now** (#885): `WarningsAsErrors: '*'` in
  `engine/.clang-tidy` is the one place that says so, and both consumers read
  their verdict from clang-tidy's exit status - the pre-commit hook refuses the
  commit, and the `Lint changed engine sources` step in `pr-tests.yml` fails the
  engine job **on Linux and Windows** - a `#ifdef _WIN32` branch is
  preprocessed away before a Linux run sees it, so gating Linux alone left
  `platform.hpp`'s per-OS split and the Windows-only blocks in `client.cpp` /
  `event_loop_worker.cpp` / `temp_database.hpp` unlinted. macOS is excluded
  because clang-tidy 19 *and* 20 both SIGILL there on the AppleClang 21 SDK
  (#906); the only macOS-conditional code is four `#define`s, so what is lost is
  `clang-analyzer-*` over shared code under libc++. **CI gates the changed
  *lines***, through LLVM's
  `clang-tidy-diff.py`: the tree had never been linted and most files carry
  findings older than any diff, so whole-file gating would fail a pull request
  for code it did not write. The hook is the stricter one (whole staged files);
  #902 tracks aligning them. Nothing lints at *build*
  time: the commented-out `CMAKE_CXX_CLANG_TIDY` block went with #885, because a
  lint that runs when someone uncomments it never runs. See
  `docs/engine/building.md`.
- Install the git pre-commit hook: `bash scripts/install-git-hooks.sh`
- vcpkg manages all C++ dependencies - do not add one without updating
  `engine/vcpkg.json`. **In the cloud dev environment, adding one needs a second
  step**: its egress policy answers GitHub *source archives* with `403` while
  allowing git-over-https, so a port fetched by `vcpkg_from_github` fails on a
  cold cache with `curl operation failed with response code 403`. That is not
  the dependency being unavailable - run `vcpkg-fix-port <port>` (no arguments
  re-does the whole manifest), which rewrites the port to `vcpkg_from_git` as an
  overlay, then build again. A session read that 403 as a policy wall and
  abandoned a phase of #625 over it. **A port whose portfile pulls extra
  archives of its own needs a hand** - `c4core` (under `ryml`) fetches three
  `vcpkg_download_distfile` sub-archives that the fixer, which only rewrites
  `vcpkg_from_github`, leaves alone; rewriting those three to `vcpkg_from_git`
  in the overlay is a two-minute edit and only ever needed in this environment,
  since CI reaches the archives.
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
| POST | `/import/parse` | Read a raw import document - OpenAPI 2.0/3.x, Postman v2.0/v2.1, a Postman environment or globals export, Insomnia v4 - into the tree `/import/apply` persists (issue #877); reads only |
| POST | `/import` | The same parse, flattened and applied in one call - what MCP `import_document` wraps; the app parses and applies separately because a person previews in between |
| POST | `/import/document` | A document's bytes as a JSON DOM, through the engine's one reader - the whole of what the app's `$ref` bundler needs, and what took the last YAML dependency out of `app/src` |
| POST | `/import/apply` | Persist a whole parsed import atomically; returns a temp-id -> real-id map |
| POST | `/diagnostics/connection` | One policy-honouring send, reported as which hop answered (issue #708) - outcome only, never a body |
| GET | `/requests/:id/examples` | A request's saved example responses (issue #481), in stored order |
| POST | `/specs` | Store an OpenAPI document (issue #637) and derive its operation index from it (issue #853); `GET`/`DELETE /specs/:id` read and remove it, `GET /specs/:id/meta` describes it without sending it (issue #712) |
| POST | `/specs/sync` | Apply a re-fetched document to the collection bound to it (issue #655) - new document, moved binding and the created/updated/deleted requests in one transaction |
| POST | `/specs/describe` | What a picked document is - dialect, title, declared operations (issue #869) - reads only, nothing stored; the identities `/specs/match` is then handed |
| POST | `/specs/match` | Which request of a collection's subtree is which operation of a document (issue #761) - reads only, nothing stored or stamped |
| POST | `/specs/diff` | What a re-fetched document would change about the collection bound to it (issue #854) - reads only; applying the answer is `POST /specs/sync` |
| POST | `/specs/bind` | Bind a collection to a document (issue #862) - the document, the binding and every stamp, written **and cleared**, in one transaction |
| POST | `/specs/export` | A collection back out as an OpenAPI document (issue #855) - its bound document patched, or a skeleton when it binds none; reads only |
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
  second; nothing else about a row says where it came from. **Deleting an
  imported example keeps the row as a tombstone** (`suppressed`, #722), because
  the refresh rewrites a request's imported rows on any applied change and so
  a plain delete lasted only until the next sync of any field. Every read
  filters tombstones out - `get_request_examples` and `get_request_example`, so
  the list route, a mock server and an export all behave as though the row were
  gone - and `get_suppressed_request_examples` is the single read that sees
  them, for the refresh. It matches on the response **status**, which is what a
  document's example keeps when its description is reworded.
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
  replaces only `origin="import"` examples. **The examples it writes are the ones
  the document it stores documents** (#869): the payload carries a *decision* per
  updated request - `examples: true` refreshes that request's imported rows,
  absent leaves every one of them alone - and the rows come off the same read the
  indexes come off (`core::spec_request_drafts_of` over the DOM
  `read_spec_indexes` hands back). A list where the boolean belongs is a `400`,
  as is `examples` on a `create` item, because a caller that states rows can
  state an example for a response the document does not describe - which is what
  the app did, having read those rows off `POST /specs/diff` two calls earlier.
  `Database::spec_sync_apply` is its transaction, a sibling of `import_apply` and
  `apply_reorder` for the same reason those two are separate.
  **Which request is which operation is the engine's answer** (#761,
  `POST /specs/match` over `core/operation_match.hpp`). Binding a collection
  that already exists has to pair two independent lists, and it does it by
  structure - both sides reduced to a path shape, with the origin, query and
  fragment dropped and every placeholder (`{{petId}}`, `{petId}`) flattened to
  `{}`, so a renamed path parameter is still the same endpoint. Ambiguity is
  refused in both directions rather than guessed at, because the sync applies
  changes *by* identity and a wrong one is worse than none. It moved out of the
  renderer so an agent over MCP can bind the same way rather than through a
  second copy of that rule. Since #854 moved the sync diff, **nothing in the
  renderer reduces these shapes any more** - `services/openapi/operation-match.ts`
  and its conformance suite are gone with it, and
  `tests/fixtures/operation-shape-conformance.json` is this side's own table
  rather than a cross-language pin. The route reads the **subtree** of the collection
  it is given - an import binds the root and files requests under tag
  sub-collections - through the same `collection_subtree_ids` walk
  `POST /specs/sync` bounds itself by. It still parses no OpenAPI: the caller
  hands it the identities the document declares, the same rows it stores as the
  `operations` index - and since #869 the caller gets those from
  **`POST /specs/describe`** rather than reading the document itself, so the
  identities a pairing is previewed with are the ones the bind derives from the
  same bytes. That route is the whole of what the Spec tab used to parse for:
  the dialect (`OpenAPI 3.0` / `OpenAPI 2.0 (Swagger)`), `info.title`, and the
  declared identities. A file that is readable and *not* a contract is a `400`
  naming what it does not declare, never an answer declaring nothing.
  **Binding is `POST /specs/bind`** (#862), the third spec write and the one that
  makes an agent able to bind at all: the caller sends a document and a
  collection - never a pairing - and the route reads the document, derives the
  indexes, matches the subtree with the *same* `core::match_operations` over the
  same `collection_subtree_requests` walk `POST /specs/match` previews with, and
  commits the document, the moved binding and every stamp through
  `Database::spec_sync_apply` - the sync's transaction, with its create and
  delete halves empty. **Both halves of the stamping are that one walk**: a
  request that matched is stamped, and one that carries a stamp and matched
  nothing is *cleared*, because a stamp naming an operation only the previously
  bound document declared is resolved by `operationId` first and claims the wrong
  operation rather than none (#718). Clearing is deliberately not a list the
  caller states - a list is what a caller can forget. Unbinding stays
  `PUT /collections/:id` with `openapi: null`: one row, stamps untouched, so
  unbind-then-rebind of the same document is lossless.
  **Writing a collection back out as a document is the engine's too** (#855,
  `core/openapi_export.hpp` over `POST /specs/export`), which is what makes
  `export_spec` reachable over MCP. Two directions that are not variants of
  each other: a bound collection's own stored bytes are *patched* - operations
  nothing claims removed, request values and stored examples written in, and
  every member Vayu does not model carried through by simply not being visited,
  because a regenerated document would silently drop every `securityScheme`,
  vendor extension and description the app has no model for - while an unbound
  collection gets a skeleton that invents nothing. The same subtree walk bounds
  it, with one addition: it stops at a collection bound to a *different*
  document and not at one bound to the same (#721), so `collection_subtree_ids`
  takes that boundary as a predicate rather than growing a second walk. YAML
  output is `core::emit_yaml`, which lives beside the reader on purpose - a
  string is quoted exactly when writing it plainly would read back as something
  else, and that is `plain_scalar`'s question; split across two files a document
  would export as `swagger: 2.0` and re-import as a number.
  **Responses are validated against what the document declares** (#628):
  `spec_documents.response_schemas` holds an engine-derived index (schemas as
  written, plus one shared `refRoots` their `$ref`s resolve through), and
  `core/schema_validation.cpp` matches a response to one by status pattern and
  media type and validates it with **valijson** - not the `json-schema-validator`
  #625 named, which segfaults on a recursive schema.
  **The engine reads the document itself now** (#853, `core/openapi_document.hpp`
  - rapidyaml, the one YAML dependency and the one translation unit that
  includes it). **Both stored indexes are derived on every write and refused in
  the body** - the `operations` index (#629, moved by #853) and the
  `responseSchemas` index (#628, moved by #860). `POST /specs`,
  `POST /specs/sync` and `POST /import/apply` all go through
  `read_spec_indexes` → `core::derive_spec_indexes`, so an index is a fact
  about the stored bytes the way `hash` is, and a document that cannot be read
  is a `400` rather than a row nothing downstream can use. **One read produces
  both**, which is what makes them agree: a status the schema index carries is
  one the operation index lists for the same operation, on the same identity -
  #715's repeated-`operationId` rule included. Deriving the schemas is the half
  that *translates*: 3.0's `nullable` becomes a union with `null` and its
  draft-04 boolean `exclusiveMinimum` becomes the bound, because a dialect
  passed through untouched produces a **wrong** verdict about a body rather than
  no verdict, and a response that is itself a `$ref` is read through one hop in
  either dialect (#714). Nothing in the renderer extracts either index any more -
  and since #869 nothing there reads a spec document at all:
  `services/openapi/spec-operations.ts` went with the Spec tab's parse, and #877
  took the last of it - the import parsers, and with them the `.testkit.ts` and
  the two cross-language conformance suites that had been asking whether an
  *import* still built what this side derives. There is nothing left to ask.
  The reader keeps
  document order (a JavaScript object could not: it sorts integer-like keys, so
  `responses: {404, 200}` used to reach the store as `200, 404`), types scalars
  like js-yaml's core schema, expands anchors, aliases and merge keys under a
  budget of one node per input byte, and refuses a duplicate mapping key. The
  identity it indexes is the identity an import stamps on a request, and since
  #877 that is one function rather than two agreeing:
  `tests/fixtures/declared-operations-conformance.json` stayed as this side's own
  table (`openapi_document_test.cpp`) when its renderer half retired with the
  parser it pinned, the way `operation-shape-conformance.json` did under #761.
  **The engine builds the request drafts too now** (#865,
  `core::spec_request_drafts_of`): not an identity but *the request an import
  would build* - method, URL with its query joined in, params, headers, sampled
  body, and the folder an import would file it under. That is the half #854's
  sync diff compares, and it was a port of `openapi-v3.ts` / `openapi-v2.ts` /
  their shared helpers / the schema sampler, held to their answers by a
  cross-language fixture while both existed. **Since #877 it is the only
  implementation**: the import runs on it too (`core::import_drafts_of`), so the
  fixture that pinned the two retired with the renderer parser and
  `tests/fixtures/import-conformance.json` records what that parser produced
  instead. The port still carries JavaScript's own semantics (`??` falling
  through `null` alone, `JSON.stringify`'s number spelling, truthiness) rather
  than the nearest C++ idiom - `src/core/js_json.hpp` is that shim, shared with
  the import - because those are the rules the answers were built on. All three answers come off **one** walk
  (`src/core/openapi_walk.hpp`), so no two can disagree about which operations
  exist or which of two kept a repeated `operationId`. A draft carries the
  operation's documented responses too (#854): the diff does not compare them,
  but applying a change *writes* them, and a draft without them is an answer no
  apply can be built from - which is what kept a second parse of the same
  document in the renderer after the comparison had moved.
  **The comparison itself is here now** (#854, `core/spec_diff.hpp` over
  `POST /specs/diff`): what a re-fetched document would change about the
  collection bound to it, which was the last part of the spec feature only the
  Spec tab could reach. It reads the bound document from the binding and walks
  the subtree itself - the three-way `userTouched` rule (the request holds
  neither the new document's value nor the bound one's) is worth nothing if the
  caller can supply the previous side - and it writes nothing, exactly as
  `POST /specs/match` previews what `POST /specs/bind` commits. The renderer's
  `spec-diff.ts` went with it; what stays there is `spec-apply.ts`, which turns
  this answer plus the user's ticks into the `POST /specs/sync` payload. The `{param}` ->
  `{{param}}` rewrite a draft's URL is written with is
  `core::normalize_path_templates`, the mock server's copy moved out of
  `http/routes/mock_server.cpp` rather than written twice - the app writes those
  URLs and the mock reads them back
  (`tests/fixtures/path-template-conformance.json`, this side's own table since
  #877 deleted the `var-normalize.ts` it used to be pinned against; its
  `{{ x }}`-only half is `core::normalize_template_vars`, which every Postman and
  Insomnia value an import carries goes through).
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
  **A collection run checks every step instead** (#681): the runner parses the
  binding's schema index once before its first send - there is no hot path to
  keep off when steps run one at a time - stamps each step's verdict on its
  trace *and* its `step` SSE frame, and folds the same
  `SampledValidationTotals` into the same `schemaValidation` block. It adds
  `exact: true`, and that flag is load-bearing: the two modes write one block
  that one component renders, so without it a run that checked everything would
  be described to the reader as a sample. Absent reads as sampled, because a
  report written before the flag was one. `failOnSchemaError` (default false,
  scenario-only) is the opt-in that lets a schema failure fail a step - and only
  a step that passed everything else, so a step already failing keeps the error
  that named it.
- **The engine parses every import document now** (#877,
  `core/import_document.hpp`), which is what makes #853's "exactly one parser has
  an opinion" true rather than nearly true. All four formats: OpenAPI 2.0/3.x
  ride the #859 reader and the #865 draft builder - `core::import_drafts_of` is
  `spec_request_drafts_of` with the skip tally kept and the operations under a
  malformed `paths` key included, so the import and the sync diff cannot build a
  request differently - while Postman v2.0/v2.1, the Postman environment and
  globals exports and Insomnia v4 are nlohmann, no new dependency. Detection is
  the renderer's old order, so the same bytes are claimed by the same format.
  **The move is a test, not a promise**:
  `tests/fixtures/import-conformance.json` holds what the renderer's own parsers
  produced for a 15-document corpus, recorded at the last commit that had them,
  and `import_parse_test.cpp` asserts this side matches on every build - two
  normalisations aside, both of which are things the *renderer* could not do
  (`meta.skipped` order out of a `Map`, and a JavaScript object sorting
  integer-like `responses` keys ahead of the rest). `POST /import` is the parse
  plus `core::import_apply_payload` plus `POST /import/apply`, for a caller with
  no preview - **globals last and merged**, because `POST /globals` replaces the
  whole set and must not run in front of a write that can still fail. That
  flattening exists twice on purpose (the app flattens a previewed, filtered
  result) and the two are pinned to each other by `import_parse_test.cpp` and the
  app's `orchestrator.payload-conformance.test.ts`. **What stays in the renderer
  is `ref-bundler.ts`, and it is exempt with a reason**: inlining the files a
  multi-file document references is deterministic fetch-time *assembly*, not an
  opinion about what a document declares - it reads the document through
  `POST /import/document` (this same reader) and reaches the network and the disk
  through channels an engine should not have (the URL proxy, the
  main-process-gated `specFile:read` IPC).
- **`followRedirects` / `maxRedirects` are per-request and stored** (request
  builder → **Settings** tab, `requests.follow_redirects` / `max_redirects`).
  Both clients send them on *every* execute and load test rather than eliding
  the defaults, because the engine's `follow_redirects` defaults to **true** -
  an omitted `false` would silently follow the 3xx the user asked to see.
  **`verifySSL` joined them** (#706, `requests.verify_ssl` → **Settings** tab),
  under the same never-elided rule and for a stronger reason: the engine
  verifies unless told otherwise, so a dropped `false` verifies the certificate
  the user opted out for. The old "engine-only, deliberately not exposed" line
  is gone with the deferral it recorded - the answer to a dangerous state is a
  loud control, not an unreachable one.
- **Every outbound transfer leaves through one `TransportPolicy`** (#705,
  `include/vayu/http/transport_policy.hpp`). It is resolved from the
  `proxyMode` / `proxyUrl` / `proxyBypass` settings at the point of use -
  run-scoped on the load and collection paths, because libcurl only reuses a
  pooled connection when its proxy config matches - and applied by the single
  `detail::apply_transport_policy`, which owns TLS verification and the proxy
  options for **all three** drivers. A fourth mode, **`system`** (#708), reads
  `proxySystemUrl` - the one config row the *app* writes, because resolving the
  OS proxy needs Chromium and the engine has none. Empty there falls back to
  `environment`, never to `off`: a headless engine has no app to ask, and the
  environment pickup is the closest thing to "what this machine would do" that
  a daemon on its own has. Add a transport option there, never to a
  driver: the three had grown their own SSL blocks and only two ever grew a
  proxy block, so SSE silently ignored `CURLOPT_PROXY` for its whole life.
  Every mode writes `CURLOPT_PROXY` rather than skipping it, because handles
  are reused - and #706's `ca_bundle_path` writes `CURLOPT_CAINFO` the same
  way, empty included. That bundle is materialized from the
  `customCaCertificates` setting beside the database and **extends** the
  platform's trust rather than replacing it: on an OpenSSL build CAINFO *is*
  the whole store, so the file is the system anchors plus the user's.
  **Every leg verifies with OpenSSL now** (#851): `engine/vcpkg.json` pins
  curl's `openssl` feature with `default-features: false`. **That does not make
  Windows a single-backend build, and believing it does is the trap #851 fell
  into** - the port's `http2` feature *itself* depends on `curl[ssl]`, and the
  engine requires `http2`, so `ssl` is in the resolved feature set however the
  manifest is written; on Windows it resolves to Schannel and the shipped
  libcurl is *MultiSSL*. Reading the port file said otherwise; the first CI run
  said `openssl, schannel`. **So the engine names its backend rather than
  inheriting one**: `pin_tls_backend()` calls `curl_global_sslset` before
  `curl_global_init` (`http/client.cpp`), because on a MultiSSL build
  `multissl_setup` reads **`CURL_SSL_BACKEND` from the environment** before
  falling back to the first compiled-in backend - so a stray export would put
  every transfer on Schannel, silently, and mTLS would stop working (#842) with
  every doc here still saying OpenSSL. Getting the *build* down to one backend
  needs a triplet or an overlay port and is #858. Six statements across the
  engine and the docs said macOS was on Apple SecTrust until #818, and none of
  them had been read off a build - so the backend is asserted per leg, by name
  **and by whether this process actually selected it**
  (`TlsBackend.IsTheBackendEveryTrustStatementHereAssumes`).
  **Windows is the leg with no bundle file**: it ships its anchors in a
  certificate store, so `system_ca_bundle_path()` finds nothing, the
  materialized file holds the paste alone, and `CURLSSLOPT_NATIVE_CA` is set
  **unconditionally** there rather than only when a bundle is in force - an
  OpenSSL build on Windows whose handle lacks that flag and whose user has
  pasted nothing trusts *nothing at all*. One promise, two mechanisms, and
  `TlsBackend.FindsTheSystemAnchorsTheMergeExtends` asserts whichever applies
  to the leg, because that is the shape in which this being wrong costs a user
  their trust store. What no unit test can reach - that the *platform's* own
  anchors still verify a real certificate - is `NativeStoreVerificationTest`
  (`tests/tls_verification_test.cpp`): a public host with nothing pasted, and
  the same host still verifying once an unrelated CA is. It skips on a closed
  network and **fails on an SslError**, which is the asymmetry that makes it
  worth having.
  The additive claim itself is checked on
  each CI platform rather than reasoned about, because a wrong claim here is a
  security claim - by **two** tests answering two different questions, and the
  distinction matters because for a while only the first existed and the docs
  read as though it covered both (#812).
  `TlsBackend.AcceptsACustomCaBundleOnThisPlatform` asks the narrow one:
  whether this build's backend refuses `CURLOPT_CAINFO` outright
  (`CURLE_NOT_BUILT_IN`). It stands up no server and verifies nothing.
  `CustomCaVerificationTest` (`tests/tls_verification_test.cpp`) asks the one a
  user cares about, on a wire: an in-process HTTPS listener holds a certificate
  a per-run CA signed (`tests/tls_server.hpp`), and the send verifies once that
  CA is pasted into `customCaCertificates`, fails before it is, fails against a
  CA that signed nothing here - the case that separates real verification from
  a bundle read and ignored - and still verifies when a second anchor is added
  beside it, which is the additive rule observed rather than asserted. That
  listener is why `cpp-httplib` carries the `openssl` feature in
  `engine/vcpkg.json`. **Two backends did not answer this the same way, and
  the wire is how we found out** - kept here because #851 removed the second
  backend, not the lesson. Where curl revocation-checks the chain itself - the
  Schannel path did, passing `CERT_CHAIN_REVOCATION_CHECK_CHAIN` unless told
  not to - a certificate authority minted for one test run was refused for
  publishing no CRL, with the anchor loaded and the signature good, and the two
  *positive* cases skipped there. **The fixture publishes one now** (#819): the
  CA signs an empty CRL, a plain-HTTP `CrlServer` serves it, and the leaf names
  that listener as its distribution point - on the leaf, because
  `CERT_CHAIN_REVOCATION_CHECK_CHAIN` checks below the root. A backend that
  never asks would report nothing about any of that, so
  `TheFixtureServesACaSignedCrlAtTheLeafsDistributionPoint` asserts on every
  leg that the extension is on the certificate served and that the document
  behind it parses, is this CA's, and is current. **All four cases now run
  everywhere** - the leg that skipped went to 2056 run, 2056 passed, 0 skipped -
  so the skip and its helpers are gone and a refusal naming revocation is an
  ordinary failure again. What #819 keeps is the user-facing half, which is a
  decision rather than a fix: someone pasting an internal CA with no reachable
  distribution point gets the same refusal, and no doc says so. **The client
  certificate's handshake is on a wire too now** (#802): the same `TlsServer`,
  built with a second CA, demands a certificate that authority signed, so it
  reuses this CRL rather than standing up a second listener.
  A proxy-hop failure is **`ErrorCode::ProxyError`**, distinct from
  the target's `ConnectionFailed` - and `curl_to_error` now takes the handle,
  because a 407 answered to a CONNECT is a plain `CURLE_RECV_ERROR` and only
  `CURLINFO_HTTP_CONNECTCODE` remembers a proxy said no. The handle answers a
  second question for the same reason (#802): **an https transfer that failed
  for a code with no mapping and produced no response line is an `SslError`**,
  not the `InternalError` the default arm used to give it. Every
  client-certificate refusal lands there - under TLS 1.3 the server's verdict
  about the client arrives after the client's handshake finishes, so curl
  reports `CURLE_RECV_ERROR` with the alert in its message. The rule is the
  *shape*, never a list of codes, and it is consulted only after every mapping
  with a meaning of its own has been tried.
- **A client certificate belongs to a host, not to a request** (#707,
  `client_certificates`). The registry rides *inside* the `TransportPolicy`, so
  it reaches every outbound path with no per-site wiring and is read once per
  run on the load and collection paths - `match_client_certificate` then picks
  the entry per transfer from that snapshot, ranked in three tiers (#803):
  closest host first - an exact name beats every wildcard, a longer wildcard
  beats a shorter one - then port-specific beating catch-all. The only pattern
  is `*.example.com`, a label suffix that answers for every subdomain and never
  for the domain itself or an address literal; a `*` elsewhere is a write-time
  400, and the ranking is total, so no match depends on row order.
  Only file **paths** are stored (the key never enters
  the database); the passphrase is stored plaintext on the existing credential
  precedent and is **never echoed** - reads answer `hasPassphrase`. Both paths
  are checked at write time, because an unreadable file otherwise surfaces as an
  `SslError` against the endpoint and reads as "the API is broken". A matched
  entry is recorded on `Response::client_certificate` and travels both design
  funnels (live body and stored trace) under `clientCertificate`, deliberately
  *not* on the load path: it is a per-transfer string for a fact that is
  constant for the run. **The row says what format its certificate is in**
  (`cert_format`, #833): the applier writes `CURLOPT_SSLCERTTYPE` from it, so a
  `p12` bundle goes out as one rather than being handed to the PEM parser. A
  PKCS#12 row stores no `key_path` (the bundle carries the key) and one
  `passphrase` column serves both, since libcurl reads it as the import
  password too. The format is **stored, not sniffed per transfer**, defaulted at
  write time from the file's first bytes and refused when those bytes
  contradict it - a check that is deliberately shallow, like `ca_pem_rejection`:
  only a contradiction is an error, a file we cannot classify is the backend's
  to judge. `tests/mutual_tls_test.cpp` runs every driver case once per format
  the leg's backend accepts (`client_identity_formats()`).
  **mTLS works on all three platforms since #851, and both formats run on every
  leg with no skip.** It did not before, for a reason that was never ours
  (#842): curl 8.21's Schannel client-cert path imports the bundle with
  `PKCS12_NO_PERSIST_KEY` and cannot then use the key, which curl's own
  `KNOWN_BUGS` documents (curl 17626, 3145) and which measured here as
  `SEC_E_INTERNAL_ERROR` on every driver, with a legacy-PBE and a PBES2 bundle
  alike. The wire cases skipped on that leg through `client_auth_defect()`;
  #851 deleted the helper and the skip by taking Schannel out of the build.
  **Anything proposing a return to Schannel reads closed #842 first** - the
  defect is still open upstream, and the skip comes back with it.

## Request composition (engine-owned - POST /compose)

The **engine owns** request composition (shipped in issue #226):
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
