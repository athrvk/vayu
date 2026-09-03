# Engine (C++23 daemon)

The load-testing and request-execution engine. AGPL-3.0. See the repo root
`CLAUDE.md` for build commands, commit rules and repo-wide conventions.

```
engine/
├── src/core/      # load_strategy, metrics_collector, run_manager, import, openapi
├── src/http/      # HTTP server, SSE, routes, thread_pool, rate_limiter, transport
├── src/db/        # SQLite persistence
├── src/runtime/   # QuickJS scripting engine
├── src/platform/  # per-OS code (timer resolution, process, paths)
├── src/utils/     # shared primitives (encoding, ascii_case, parse, reentrant)
├── include/vayu/  # Public headers
├── tests/         # Google Test suite; tests/fixtures/ holds the conformance tables
└── vendor/        # quickjs-ng, hdrhistogram
```

## Conventions

Each rule below names the primitive that holds it and the test that guards it.
Several guards are source scans over `engine/{src,include,tests}` with a
per-file exemption list; they exist because the lint gates read only the files
a change touches (#946), so nothing else holds an untouched file at zero.

- **Standard: C++23** (#901), `-Wall -Wextra -Wpedantic`. What a standard offers
  on each platform is measured: `scripts/cxx-feature-probe/` compiles one tiny
  translation unit per feature and the `C++ feature probe` workflow runs it on
  all three platforms plus `g++-14`; it gates nothing (`docs/engine/building.md`).
  The one measurement that shapes the code: libc++ has no
  `std::move_only_function`, so `thread_pool.hpp`'s queue stays `std::function`
  and every queued task stays copyable. Run the probe before reaching for a
  C++23 library feature the engine does not already use.
- **An error-or-nothing API is `RouteResult`** (`std::expected<void, RouteError>`),
  never an `std::optional` whose empty state means success. `route_error` builds
  the refusal; `as_response` converts one to the pair a testable core answers.
- **An optional a guard has already proved is read through one binding**, not
  re-derived: `const auto& shape = shapes[i]; if (!shape) { continue; }
  use (*shape);`. `shapes[i]` written twice is two expressions, so
  `bugprone-unchecked-optional-access` cannot connect the guard to the use, and
  neither can a reader. Where the rule that makes the access safe lives in
  *another* function (a producer that sets two fields together, a validation
  pass under the same held DB mutex), read it through
  **`vayu::utils::invariant_value`** (`utils/invariant.hpp`, #943), which takes
  the rule as a string and throws `std::logic_error` naming it when broken.
  `.value()` is not the way to say this: it names no rule and the check reports
  it. The helper is for invariants only; an optional a client can empty keeps
  its `if`, its 404 and its default.
- **In a test the guard is `ASSERT_HAS_VALUE`** (`tests/optional_assert.hpp`,
  #980), never `ASSERT_TRUE (opt.has_value ())`: the gtest spelling goes through
  an `AssertionResult` the analyzer's dataflow cannot follow, so every read
  under it is reported. The macro is one `if` with `FAIL ()` in the failing
  branch, so the failure stays gtest's and streamable
  (`ASSERT_HAS_VALUE (row) << "after the second write"`). An optional read
  *through* a guarded row (`row->parent_id`) needs its own guard; a non-void
  helper cannot use the macro and states the absent case as an `if` that
  `ADD_FAILURE ()`s and returns something harmless. Guard:
  `optional_assert_test.cpp` scans `tests/` for the replaced spelling.
- **The reentrant spelling of a C call, always** (#945). `std::localtime` and
  `std::strerror` return pointers into process-shared storage, so with a worker
  thread per connection the result can describe another call's subject.
  `vayu/utils/reentrant.hpp` is the one place that spells them safely
  (`format_local_time`, `format_utc_time`, `errno_message`). The daemon's
  force-shutdown branch is `std::_Exit`: it runs inside the signal handler,
  where `exit` would run every static destructor under live worker threads.
  Guard: `tests/reentrant_test.cpp` scans `src` and `include` for the classic
  names and for `setenv`/`putenv`, which would make the single exempted
  `getenv` (`transport_policy.cpp`) unsafe.
- **Nothing at namespace scope is built at run time** (#945, `cert-err58-cpp`).
  A constant is `constexpr` (`std::string_view`, `std::array`, `const char*`);
  an object that cannot be one (`std::regex`, `nlohmann::json`, `std::mt19937`,
  anything holding a `std::string`) is a function-local `static` an accessor
  returns a reference to. Dynamic initialisation before `main` has no frame to
  throw into and an unspecified order against other translation units; a
  function-local static is built once, thread-safely, after what it depends on.
  `token_pattern` in `request_composer.cpp` is the shape; its `PASSWORD_CHARS`
  is what to do when a constant was *derived* from another: spell it out and
  pin the two with a `static_assert`. Test-only constants are held to this too.
- **Bytes become characters in one place, never at the site** (#945,
  `cppcoreguidelines-pro-type-reinterpret-cast`). Reinterpreting between
  character types is defined behaviour, which is why hand-rolled copies
  accumulate. The primitives: **`vayu::utils::byte_view`** (`utils/encoding.hpp`)
  for a `std::span` of bytes as the `std::string_view` every encoder takes;
  **`vayu::db::column_text`** (`db/database.hpp`) for a sqlite TEXT column,
  keeping SQL NULL as a null pointer because absent and empty are different
  answers; **`vayu::utils::detail::sodium_bytes`** (`utils/sodium_init.hpp`)
  and **`tls_detail::openssl_bytes`** (`tests/tls_server.hpp`, #1013) going the
  other way. A `sockaddr_in*` off an `addrinfo` or a Windows function pointer
  off `GetProcAddress` is not this rule and the scan does not look at them.
  Guard: `tests/character_cast_test.cpp`.
- **A case-insensitive comparison folds through one primitive** (#1060).
  **`vayu::utils::ascii_lower`** (`utils/ascii_case.hpp`) folds a character or a
  whole string; **`ascii_lower_equal`** compares without building a lowered
  copy (`vayu::CaseInsensitiveLess` folds through it in one pass). ASCII is in
  the name because it is the contract: every caller folds a header name, a
  scheme, a MIME type, a hostname or a log-level word, all ASCII by their own
  specifications, and `std::tolower` on a byte above 127 is undefined where
  `char` is signed and locale-dependent otherwise. Nothing here calls
  `std::tolower`. Guard: `tests/ascii_case_test.cpp`, whose matcher catches the
  function *passed* (`std::transform (b, e, b, ::tolower)`) as well as called.
- **A class with a destructor states all five** (#945,
  `cppcoreguidelines-special-member-functions`). Every RAII holder (the `Impl`
  behind a pImpl, `Database`, the in-process mock servers in `tests/`, and every
  manager and listener in `include/`: `Server`, `ManagedListener`,
  `SseStreamManager`, `InboxManager`, `RunManager`, `EventLoopWorker`, `Logger`)
  deletes copy *and* move beside its destructor, in the spelling `server.hpp`
  uses. Deleting is the default answer: none of these is meaningfully movable,
  and a move would leave a hollow object whose methods still compile. (`Client`
  in `client.hpp` is the deliberate exception: it deletes copy and declares
  move.) Declaring the four suppresses the implicit default constructor, so a
  class with no other constructor gains `Foo () = default;` beside them. A mock
  server's thread pool is `vayu::tests::pooled_task_queue`
  (`tests/task_queue.hpp`); httplib's `new_task_queue` hook takes a raw owning
  pointer by contract.
- **A length is kept, never re-derived** (#945, `cppcoreguidelines-pro-bounds-*`).
  A subrange of a string is `substr` on a view, not `data () + offset`; a fixed
  table is a `constexpr std::array` (`std::to_array`, so the count is not
  restated) or a `std::string_view`; `argv` is a `std::span<char* const>`; an
  index a caller computed goes through `.at ()`. Primitives:
  **`vayu::utils::parse_number`** (`utils/parse.hpp`), a whole
  `std::string_view` as an integer or nothing (the `ptr != end` half of
  `from_chars` that separates "42abc is 42" from "42abc is not a number");
  **`vayu::core::parse_numeric_flag`** (`core/numeric_flag.hpp`, #1028) above
  it for a *flag*, holding the value to its documented range and refusing with
  the flag, the range and what was typed; **`core/flag_value.hpp`** (#1031)
  before either, refusing a flag with nothing after it or a value beginning
  with `-`. Both argument loops live in headers (`core/daemon_args.hpp`,
  `core/cli_args.hpp`) so `tests/argument_rules_test.cpp` can call them.
  **`vayu::http::CurlErrorBuffer`** (`http/curl_error_buffer.hpp`) owns
  `CURLOPT_ERRORBUFFER` and its three rules (at least `CURL_ERROR_SIZE` bytes,
  alive for the whole transfer, cleared between transfers on a reused handle).
  Guard: `tests/bounds_primitives_test.cpp`. A subscript is not a token, so for
  the rest of the family the lint gate is the whole guard.
- **libcurl's variadic calls go through `set_opt` / `get_info`** (#1023,
  `cppcoreguidelines-pro-type-vararg`). **`vayu::http::set_opt<CURLOPT_...>`**
  and **`get_info<CURLINFO_...>`** (`http/curl_options.hpp`) take the constant as
  a template argument and `static_assert` the value against the category
  libcurl encodes in it; the vararg calls inside those wrappers are the only
  ones in the engine, each under its own `NOLINT`. Only the Windows leg reports
  the raw call: libcurl's type-checking macros are C-only and MSVC does not
  define `__STDC__`. `clang-tidy --extra-arg=-U__STDC__` reproduces that reading
  anywhere.
- **A row struct's scalars all carry a default** (#1013,
  `cppcoreguidelines-pro-type-member-init`). The `vayu::db` structs in
  `types.hpp` are aggregates an insert site fills field by field, so a
  forgotten one is indeterminate and sqlite_orm stores whatever that was. The
  three enums (`Request::method`, `Run::type`, `Run::status`) default to what
  `database.cpp`'s `row_extractor` falls back to for an unparsable stored
  value, so struct and reader agree. A default bounds a wrong insert; it is not
  a substitute for setting the field.
- **A destructor, a thread entry and `main` are total, and no linter says so**
  (#1023). `bugprone-exception-escape` is declined in `engine/.clang-tidy`
  because it fires only on a `throw` it can see and so answers about the
  standard library rather than this code. The rule stays: `~SseStreamManager`
  and `~Logger` are the shape, a `try` around the whole body, `catch (...)` at
  the end, reporting through a `noexcept` helper (`log_unrecoverable`);
  `~Logger` reports nothing because the logger is what is being destroyed.
- **An empty `catch` opens with `@deliberate` and then says why** (#944).
  `bugprone-empty-catch` reads only the keywords in `IgnoreCatchWithKeywords`
  (`@TODO;@FIXME;@deliberate` in `engine/.clang-tidy`). The keyword is the
  marker, the sentence after it is the argument: what the recovery is and what
  the caller gets instead of the exception. A `catch` with no reason to give
  gets a fix or a log line, not a keyword.
- **A whole-tree tidy measurement passes `-header-filter` itself** (#1013).
  `run-clang-tidy` does not read `HeaderFilterRegex` from the config, so a scan
  without the flag reports nothing in headers. Deduplicate by
  (file, line, column, check): a header finding repeats per including
  translation unit. `docs/engine/building.md` carries the command.
- **A new `tests/*_test.cpp` is listed in `add_executable(vayu_tests ...)`**
  in `engine/tests/CMakeLists.txt`; the list is explicit, never a glob, and a
  guard beside it fails configure naming any unregistered file, because an
  unbuilt test file reports nothing (#668). The list lives there and not in
  `engine/CMakeLists.txt` because that file is a `sanitizers.yml` trigger
  path (#970); keep routine edits out of it.
- **A fixture that opens a scratch `Database` cleans up with
  `vayu::tests::remove_database_files`** (`engine/tests/temp_database.hpp`),
  never a hand-written suffix list: an opened database writes six files (#413).
- **vcpkg manages every C++ dependency**: add one in `engine/vcpkg.json`. In
  the cloud dev environment a port fetched by `vcpkg_from_github` fails on a
  cold cache with `curl operation failed with response code 403` (the egress
  policy refuses GitHub source archives and allows git-over-https). Run
  `vcpkg-fix-port <port>` (no arguments re-does the whole manifest), which
  rewrites the port to `vcpkg_from_git` as an overlay, then build again. A port
  whose portfile pulls extra archives of its own needs a hand: `c4core` (under
  `ryml`) fetches three `vcpkg_download_distfile` sub-archives the fixer leaves
  alone; rewrite those to `vcpkg_from_git` in the overlay. Only this
  environment needs it; CI reaches the archives.
- Install the git pre-commit hook: `bash scripts/install-git-hooks.sh`.

## Formatting and linting

- **clang-format 19 exactly** (`.clang-format` at repo root; the pin exists
  because 18 formats a measured share of the sources differently). A
  patch-level difference inside 19 can still matter (one 19.1.x pair disagrees
  about three continuation lines in `script_engine.cpp`), so after `clang-format
  -i` read `git diff` for reindentation you did not intend and put it back: the
  tree as committed is what CI's binary accepts. `Engine formatting` in
  `pr-tests.yml` runs `--dry-run -Werror` over the whole of
  `engine/{src,include,tests}` (#886) and `scripts/pre-commit` runs the same
  check over what a commit stages (#908), skipping loudly without a
  clang-format 19 rather than answering from another major. The config's two
  odd-looking settings (`ColumnLimit: 80` with `PenaltyExcessCharacter: 1`,
  `ContinuationIndentWidth: 0`) are what the code is written to; both are
  commented in the file, and a "tidier" value costs a five-figure-line rewrite.
  `engine/vendor/` sets `DisableFormat: true`. Includes are sorted, with one
  pinned exemption: the `<windows.h>` / `<timeapi.h>` pair in
  `src/platform/high_resolution_timer.cpp`, wrapped in `// clang-format off`
  because `timeapi.h` needs `windows.h`'s types and sorts first. A second such
  case is pinned at the site the same way, never by turning the sorter off.
- **clang-tidy 19 or newer** (`.clang-tidy` in `engine/`, `engine/src/runtime/`,
  `engine/tests/`; the root config uses `ExcludeHeaderFilterRegex`, which an
  older binary rejects). The hook finds it as `clang-tidy-19` or plain
  `clang-tidy` through the same `find_llvm_tool` the formatter uses (`exact`
  there, `minimum` here), because apt splits the names and Homebrew does not
  (#918). **A finding is a failure** (#885): `WarningsAsErrors: '*'` in
  `engine/.clang-tidy`, and both consumers read the exit status. The pre-commit
  hook refuses the commit; the `Lint changed engine sources` step in
  `pr-tests.yml` fails the engine job on Linux and Windows. Windows is gated
  because a `#ifdef _WIN32` branch is preprocessed away before a Linux run sees
  it (#1023); macOS is excluded because clang-tidy 19 and 20 both SIGILL on the
  AppleClang 21 SDK, a settled decision (#940), and the only macOS-conditional
  code is four `#define`s. Both gated legs lint **whole files** (#946, #1023):
  a finding anywhere in a file a change touches is that change's to fix, or to
  `NOLINT` with the reason at the site. A pull request that is nothing but a
  bulk reformat carries the **`reformat-pr`** label, the gate's one escape
  hatch. **CI lints translation units, never a header as an input** (#940): a
  header has no `compile_commands.json` entry, so clang-tidy would guess a
  command and parse the wrong STL. A header's findings surface through every
  changed translation unit that includes it; a header-only change relies on
  the hook, which lints a staged header against the local build tree, and on
  `.github/workflows/engine-tidy-scan.yml`, the weekly whole-tree scan on both
  legs (plus `workflow_dispatch`) and the only thing that reads a header. The
  scan's report fails when it parses no finding out of a log that holds
  diagnostic-shaped lines, so a zero is reported only where a zero was measured.
  Nothing lints at build time; the `CMAKE_CXX_CLANG_TIDY` block went with #885.
  See `docs/engine/building.md`.

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
| GET | `/request-defaults` | What the engine adds to a request that names none of it (#1229): the `User-Agent`, negotiated `Accept-Encoding` and an opt-in correlation id, so a client renders them instead of re-deriving them |
| POST | `/workspace/backup` | One `VACUUM INTO` snapshot of the workspace into `backups/` beside the database, with retention (#987); no restore endpoint, see `docs/engine/architecture.md` |
| GET | `/trash` | What deleting a collection or request left recoverable (#988): roots only, each with what its cascade took; `POST /trash/:id/restore` puts one back, `DELETE /trash/:id` destroys it, `trashRetentionDays` purges the rest at startup |
| POST | `/import/parse` | Read a raw import document (OpenAPI 2.0/3.x, Postman v2.0/v2.1, a Postman environment or globals export, Insomnia v4) into the tree `/import/apply` persists (#877); reads only |
| POST | `/import` | The same parse, flattened and applied in one call; what MCP `import_document` wraps. The app parses and applies separately because a person previews in between |
| POST | `/import/document` | A document's bytes as a JSON DOM through the engine's one reader; what the app's `$ref` bundler needs |
| POST | `/import/apply` | Persist a whole parsed import atomically; returns a temp-id -> real-id map |
| POST | `/diagnostics/connection` | One policy-honouring send, reported as which hop answered (#708); outcome only, never a body |
| GET | `/requests/:id/examples` | A request's saved example responses (#481), in stored order |
| POST | `/specs` | Store an OpenAPI document (#637) and derive its operation index (#853); `GET`/`DELETE /specs/:id` read and remove it, `GET /specs/:id/meta` describes it without sending it (#712) |
| POST | `/specs/sync` | Apply a re-fetched document to the collection bound to it (#655): new document, moved binding and the created/updated/deleted requests in one transaction |
| POST | `/specs/describe` | What a picked document is: dialect, title, declared operations (#869); reads only |
| POST | `/specs/match` | Which request of a collection's subtree is which operation of a document (#761); reads only |
| POST | `/specs/diff` | What a re-fetched document would change about the collection bound to it (#854); reads only, applying is `POST /specs/sync` |
| POST | `/specs/bind` | Bind a collection to a document (#862): the document, the binding and every stamp, written **and cleared**, in one transaction |
| POST | `/specs/export` | A collection back out as an OpenAPI document (#855): its bound document patched, or a skeleton when it binds none; reads only |
| POST | `/collections`, `/requests`, `/environments`, `/requests/:id/examples` | **Create only**: 409 on an existing id |
| PUT | `/collections/:id`, `/requests/:id`, `/environments/:id`, `/requests/:id/examples/:exampleId` | **Update only** (merge-patch): 404 on a missing id |

The pre-consolidation paths (`POST /request`, `POST /run`, `GET /run/:id`,
`GET /run/:id/report`, `POST /run/:id/stop`, `DELETE /run/:id`,
`GET /metrics/live/:runId`, `GET /stats/:runId?format=json`) still work as
**deprecated aliases** and will be removed in a future minor release;
`GET /stats/:runId` in its SSE mode is retained wholesale. See
`docs/engine/api-reference.md` (Deprecated aliases). An unresolved
`{"mode":"inherit"}` reaching an execution endpoint is treated as no auth and
logged as a warning: it means a client skipped composition.

### Contracts to design around

- **POST creates, PUT updates.** `POST /<resource>` never updates and
  `PUT /<resource>/:id` on a missing id is a `404` (#95). One null-vs-absent
  rule covers every resource: on create, absent and `null` both mean "use the
  default"; on update, absent means "keep" and `null` means "reset to the
  default"; a field with no default (a collection's or environment's `name`, a
  request's `collectionId` / `name` / `method` / `url`) rejects `null` with a
  `400`. The rule lives in one place per side, `apply_*_field` in
  `engine/include/vayu/http/routes.hpp` and `apiService.updateX` in
  `app/src/services/api.ts`; add fields there, never per handler. **The engine
  owns every id** (#97): a create carrying an `id` is a `400` (presence alone,
  `null` included), and a `PUT` whose body `id` disagrees with the path is a
  `400`; `reject_client_supplied_id` / `reject_mismatched_body_id` in
  `routes.hpp` are the one copy, and `apiService.createX` strips `id` because
  TypeScript excess-property-checks object literals only. Bulk import is
  **`POST /import/apply`** (#96): opaque `tempId`s in, every real id generated
  engine-side, the `idMap` back, the whole tree in one transaction. The same
  per-resource appliers (`apply_collection_fields` / `apply_request_fields` /
  `apply_environment_fields`, declared in `routes.hpp`) back both paths, so a
  field added there reaches bulk import too.
- **Saved examples are nested under their request** (`/requests/:id/examples`,
  #481): the owner is checked before the example on every path, so an example
  reached through the wrong request is a `404`, and `delete_request` and the
  collection cascade take the examples with them. Ordering is a contract: the
  list comes back by `order`, then `created_at`, then `id`, and a mock server
  answers with the first. `POST /import/apply` writes them nested on the
  request item through the same `apply_request_example_fields` applier. Every
  row records an **`origin`** (#588), `import` or `user`, defaulting to
  `import` and `400` on anything else, so the spec sync can replace the first
  kind without touching the second. **Deleting an imported example keeps the
  row as a tombstone** (`suppressed`, #722), because the sync rewrites a
  request's imported rows on any applied change; every read filters tombstones
  out (`get_request_examples`, `get_request_example`) and
  `get_suppressed_request_examples` is the single read that sees them, matching
  on response **status**, which survives a reworded description.
- **`GET /requests/:id` is a single-request lookup.** `useRequestQuery` uses it
  to load a restored request tab or a design-run copy on cold start. A `404`
  means the request was genuinely deleted; anything else is a transport failure,
  and callers (`DesignRunView`) keep those apart: only a real 404 becomes
  `RequestNotFoundError`. `GET /requests?collectionId=` lists a collection's.
- **A streaming request is a different execution model, declared not detected**
  (#573). `POST /execute` with `"stream": true` creates the run row, hands the
  transfer to `SseStreamManager` (declared before `server_`, like the listener
  managers) and answers `202 {runId, eventsUrl}`; `GET /runs/:runId/events`
  relays a bounded ring of parsed events and the completed trace carries a
  bounded `events` node. Every stream ends by a rule that can name itself
  (server close, `POST /runs/:id/stop`, `maxStreamEvents`,
  `maxStreamDurationMs`, the idle timeout), never a whole-transfer deadline,
  which this path deliberately does not set. `stream` with `transient` is a
  `400`. `POST /runs` takes `stream` too (#576) through the same
  `read_stream_flag` parser; under load a stream becomes
  `Request::stream_bounds`, the event loop ends it counting with
  `SseFrameCounter` (which agrees with `SseParser` on what an event is), and
  both caps are always set because the load loop refills concurrency per
  completion and an unending transfer would leak its slot. Reaching a cap is a
  successful completion; the byte cap (`maxResponseBodyBytes`) stays an error.
  The report gains a `stream` section, absent for runs that did not stream. A
  load stream's events are parsed back, never stored twice (#657): the sample
  body already *is* the `text/event-stream` bytes, and the deferred script
  replay and `GET /runs/:id/samples` rebuild the list with
  `buffered_stream_events_node`, bounded by `sseMaxStoredEvents`; the one thing
  stored beside the body is the wire count (`result_bodies.stream_events`, NULL
  = not a stream). Scripts run (#575): pre-request before the transfer,
  post-request after the stream ends with `pm.response.events`, output stored
  on the trace's `scripts` node because the route already answered `202`.
  **A consumer worker is drained by whoever owns the manager, before the state
  it writes through goes away** (#646): `Server::stop()` calls
  `SseStreamManager::shutdown()`, which signals every stream and *joins* its
  worker, because `daemon.cpp` runs `curl_global_cleanup` between that call and
  `~Server`. A fixture holding a manager beside a `Database` it resets owes the
  same order (keep the manager in a `unique_ptr` reset first). Waiting on
  `context->closed()` is not draining: it flips before the completion callback
  writes the run row.
- **An OpenAPI document is stored once and *bound* by collections, never owned
  by one** (#637). `spec_documents` holds the text verbatim plus an
  engine-computed `hash`; `collections.openapi` (`{specId, specHash, syncedAt}`,
  `{}` = unbound) is the edge; `requests.spec_operation` (`{operationId?,
  method, path}`, NULL = none) says which operation a request *is*. Nothing
  cascades to a document: `DELETE /specs/:id` is a **409 naming the binder**
  while any collection holds it, and there is no `PUT /specs/:id` because a
  rewrite would invalidate every stamped hash. A scenario run of a bound
  collection stamps `specId` + `specHash` into `config_snapshot` and the report
  echoes them under `metadata.openapi`. The writes and reads, each one route:
  - **`POST /specs/sync`** (#655) applies a re-fetched document. It is the one
    route that creates, updates *and* deletes, deliberately outside
    `/import/apply`; it refuses to touch a request outside the synced
    collection's subtree and replaces only `origin="import"` examples. The
    payload carries a *decision* per updated request (`examples: true`
    refreshes that request's imported rows, absent leaves them alone, #869),
    and the rows come off the same read the indexes come off. A list where the
    boolean belongs, or `examples` on a `create` item, is a `400`.
    `Database::spec_sync_apply` is its transaction, a sibling of `import_apply`
    and `apply_reorder`.
  - **`POST /specs/match`** (#761, `core/operation_match.hpp`) pairs a
    collection's subtree with a document's declared identities by structure:
    both sides reduced to a path shape with origin, query and fragment dropped
    and every placeholder (`{{petId}}`, `{petId}`) flattened to `{}`. Ambiguity
    is refused in both directions, because the sync applies changes *by*
    identity. It parses no OpenAPI: the caller hands it the identities, which
    since #869 come from **`POST /specs/describe`** (dialect, `info.title`,
    declared operations; a readable file that is not a contract is a `400`).
    `tests/fixtures/operation-shape-conformance.json` is this side's own table.
  - **`POST /specs/bind`** (#862) takes a document and a collection, never a
    pairing: it reads the document, derives the indexes, matches the subtree
    with the same `core::match_operations` over the same
    `collection_subtree_requests` walk `/specs/match` previews with, and
    commits document, binding and every stamp through `spec_sync_apply` with
    the create and delete halves empty. Both halves of stamping are that one
    walk: a matched request is stamped and a stamped request that matched
    nothing is *cleared* (#718), never a list the caller states. Unbinding is
    `PUT /collections/:id` with `openapi: null`: one row, stamps untouched.
  - **`POST /specs/export`** (#855, `core/openapi_export.hpp`) writes a
    collection back out. A bound collection's stored bytes are *patched*
    (unclaimed operations removed, request values and stored examples written
    in, every member Vayu does not model carried through unvisited); an unbound
    collection gets a skeleton that invents nothing. The subtree walk stops at
    a collection bound to a *different* document and not at one bound to the
    same (#721), as a predicate on `collection_subtree_ids`. YAML output is
    `core::emit_yaml`, beside the reader on purpose: `plain_scalar` decides
    quoting, and split across two files a document would export as
    `swagger: 2.0` and re-import as a number.
  - **Responses are validated against what the document declares** (#628):
    `spec_documents.response_schemas` holds an engine-derived index and
    `core/schema_validation.cpp` matches a response by status pattern and media
    type and validates with **valijson**. Three rules the shape enforces: an
    unbound collection gets no `validation` node at all; `checked: false`
    carries a reason code and no validity; keywords the draft-07 validator
    cannot evaluate are named and counted on the verdict. `POST /execute`
    returns the node and `record_design_result` stores the *same object* on the
    trace. `match_status_pattern` is shared with coverage. Under load the check
    is deferred to run end (#682, `validate_sampled_responses` over the sample
    reservoirs, stored as `schemaValidation` on `runs.summary` with its own
    `sampled` denominator); a source-scan test fails if validation reaches
    `load_strategy.cpp` / `scenario_load.cpp`. A collection run checks every
    step instead (#681), stamps each verdict on its trace and `step` SSE frame,
    and writes `exact: true` into the same block; `failOnSchemaError` (default
    false, scenario-only) lets a schema failure fail an otherwise-passing step.
  - **The engine reads the document itself** (#853, `core/openapi_document.hpp`,
    rapidyaml, the one YAML dependency in one translation unit). Both stored
    indexes (`operations`, `responseSchemas`) are derived on every write
    (`read_spec_indexes` -> `core::derive_spec_indexes`) and refused in the
    body; one read produces both, so they agree, including #715's
    repeated-`operationId` rule. Deriving the schemas translates dialects
    (3.0's `nullable` becomes a union with `null`, draft-04's boolean
    `exclusiveMinimum` becomes the bound, a response that is itself a `$ref` is
    read through one hop, #714). The reader keeps document order, types
    scalars like js-yaml's core schema, expands anchors, aliases and merge keys
    under a budget of one node per input byte, and refuses a duplicate mapping
    key. **It builds the request drafts too** (#865,
    `core::spec_request_drafts_of`): method, URL with query joined, params,
    headers, sampled body, documented responses (#854) and the folder an import
    files it under, all off **one** walk (`src/core/openapi_walk.hpp`), with
    `src/core/js_json.hpp` carrying the JavaScript semantics (`??`,
    `JSON.stringify` number spelling, truthiness) the answers were built on.
    **`POST /specs/diff`** (#854, `core/spec_diff.hpp`) compares those drafts
    with the bound collection's subtree using the three-way `userTouched` rule
    and writes nothing; the renderer's `spec-apply.ts` turns the answer plus
    the user's ticks into the sync payload. The `{param}` -> `{{param}}`
    rewrite is `core::normalize_path_templates` (shared with the mock server;
    `tests/fixtures/path-template-conformance.json`), and its `{{ x }}` half is
    `core::normalize_template_vars`, which every imported Postman and Insomnia
    value goes through.
- **The engine parses every import document** (#877,
  `core/import_document.hpp`): OpenAPI 2.0/3.x ride the same reader and draft
  builder (`core::import_drafts_of`, with the skip tally kept and operations
  under a malformed `paths` key included); Postman v2.0/v2.1, the Postman
  environment and globals exports and Insomnia v4 are nlohmann. Detection order
  is the renderer's old order. `tests/fixtures/import-conformance.json` records
  what the renderer's retired parsers produced for a 15-document corpus and
  `import_parse_test.cpp` asserts this side matches, two normalisations aside.
  `POST /import` is the parse plus `core::import_apply_payload` plus
  `POST /import/apply`, **globals last and merged** because `POST /globals`
  replaces the whole set and must not run in front of a write that can still
  fail; the app's own flattening of a previewed result is pinned to it by
  `orchestrator.payload-conformance.test.ts`. The renderer keeps
  `ref-bundler.ts` alone, exempt with a reason: inlining referenced files is
  fetch-time assembly through `POST /import/document`, reaching the network and
  disk through channels an engine should not have.
- **`followRedirects` / `maxRedirects` / `verifySSL` are per-request and
  stored** (Settings tab; `requests.follow_redirects` / `max_redirects` /
  `verify_ssl`, #706). Both clients send them on every execute and load test
  rather than eliding defaults, because the engine defaults to following and
  verifying: an omitted `false` would follow the 3xx the user asked to see, or
  verify the certificate they opted out for.
- **What Vayu adds to a request nobody wrote it into is the engine's, and one
  set** (#1229, `include/vayu/http/default_headers.hpp`): a `User-Agent`, a
  negotiated `Accept-Encoding`, and an opt-in correlation id namespaced to
  `X-Vayu-Request-Id` and generated per *transfer*. `DefaultHeaderPolicy` is
  resolved from config at the top of a request or a run (the load scope reads
  its own compression key, because compression changes what a run measures) and
  applied in `build_request_header_list`, so every driver adds the same set. A
  header the request names always wins, `Request::suppressed_default_headers`
  refuses one per send, and none of it is stored - the renderer used to write
  `X-Vayu-Version` and a frozen `X-Request-ID` into the saved request, which a
  load run then replayed. `Accept-Encoding` is the one recorded without being
  appended: libcurl writes that line itself from `CURLOPT_ACCEPT_ENCODING`,
  which is what makes it decode. Add a default there, never in a driver.
- **Every outbound transfer leaves through one `TransportPolicy`** (#705,
  `include/vayu/http/transport_policy.hpp`), resolved from `proxyMode` /
  `proxyUrl` / `proxyBypass` at the point of use (run-scoped on the load and
  collection paths, because libcurl reuses a pooled connection only when its
  proxy config matches) and applied by the single
  `detail::apply_transport_policy`, which owns TLS verification and the proxy
  options for all three drivers. A fourth mode, **`system`** (#708), reads
  `proxySystemUrl`, the one config row the *app* writes (resolving the OS proxy
  needs Chromium); empty there falls back to `environment`, never `off`. Add a
  transport option there, never to a driver. Every mode writes `CURLOPT_PROXY`
  because handles are reused, and `ca_bundle_path` writes `CURLOPT_CAINFO` the
  same way, empty included. That bundle is materialised from
  `customCaCertificates` beside the database and **extends** the platform's
  trust: on an OpenSSL build CAINFO is the whole store, so the file is the
  system anchors plus the user's. A proxy-hop failure is
  `ErrorCode::ProxyError`, distinct from the target's `ConnectionFailed`;
  `curl_to_error` takes the handle because only `CURLINFO_HTTP_CONNECTCODE`
  remembers a proxy's 407. The handle answers a second question (#802): an
  https transfer that failed for an unmapped code with no response line is an
  `SslError`, which is where every client-certificate refusal lands under
  TLS 1.3. The rule is the shape, never a list of codes, consulted only after
  every mapping with a meaning of its own.
- **Every leg verifies with OpenSSL** (#851): `engine/vcpkg.json` pins curl's
  `openssl` feature with `default-features: false`. That does not make Windows
  a single-backend build: the port's `http2` feature depends on `curl[ssl]`,
  which resolves to Schannel there, so the shipped libcurl is MultiSSL, and
  MultiSSL reads `CURL_SSL_BACKEND` from the environment before falling back
  to the first compiled-in backend. So **the engine names its backend**:
  `pin_tls_backend()` calls `curl_global_sslset` before `curl_global_init`
  (`http/client.cpp`), and `TlsBackend.IsTheBackendEveryTrustStatementHereAssumes`
  asserts per leg, by name and by whether this process selected it. A
  single-backend build would need a triplet or an overlay port; #858 declined
  it, and the runtime pin is the whole answer. **Windows ships its anchors in a
  certificate store**, so `system_ca_bundle_path()` finds nothing there and
  `CURLSSLOPT_NATIVE_CA` is set unconditionally; an OpenSSL build without that
  flag and with nothing pasted trusts nothing at all.
  `TlsBackend.FindsTheSystemAnchorsTheMergeExtends` asserts whichever mechanism
  applies. The additive claim is checked on every CI platform by two tests
  answering different questions (#812): `TlsBackend.AcceptsACustomCaBundleOnThisPlatform`
  asks whether the backend refuses `CURLOPT_CAINFO` outright, and
  `CustomCaVerificationTest` (`tests/tls_verification_test.cpp`) asks on a
  wire, against an in-process HTTPS listener holding a certificate a per-run CA
  signed (`tests/tls_server.hpp`; why `cpp-httplib` carries the `openssl`
  feature): verifies once the CA is pasted, fails before, fails against a CA
  that signed nothing here, still verifies with a second anchor beside it.
  `NativeStoreVerificationTest` reaches what no unit test can, the platform's
  own anchors verifying a real certificate; it skips on a closed network and
  fails on an `SslError`. The fixture's CA publishes an empty CRL through a
  plain-HTTP `CrlServer` named on the leaf (#819), because a
  revocation-checking backend refuses a CA with no CRL; all four cases run on
  every leg with no skip, and a user pasting an internal CA with no reachable
  distribution point gets that refusal.
- **A client certificate belongs to a host, not to a request** (#707,
  `client_certificates`). The registry rides inside the `TransportPolicy`,
  read once per run on the load and collection paths;
  `match_client_certificate` picks the entry per transfer in three tiers
  (#803): closest host first (exact beats wildcard, longer wildcard beats
  shorter), then port-specific beating catch-all. The only pattern is
  `*.example.com`, a label suffix that never matches the domain itself or an
  address literal; a `*` elsewhere is a write-time `400`, and the ranking is
  total. Only file **paths** are stored; the passphrase is stored plaintext on
  the existing credential precedent and never echoed (reads answer
  `hasPassphrase`); both paths are checked at write time. A matched entry is
  recorded on `Response::client_certificate` and travels both design funnels
  under `clientCertificate`, not the load path. **The row says what format its
  certificate is in** (`cert_format`, #833): the applier writes
  `CURLOPT_SSLCERTTYPE` from it, a PKCS#12 row stores no `key_path`, one
  `passphrase` column serves both, and the format is stored (defaulted at write
  time from the file's first bytes, refused when they contradict it), never
  sniffed per transfer. `tests/mutual_tls_test.cpp` runs every driver case per
  format the leg's backend accepts. mTLS works on all three platforms since
  #851; curl 8.21's Schannel client-cert path cannot use a PKCS#12 key (curl
  KNOWN_BUGS 17626 and 3145, closed #842), so a return to Schannel brings that
  defect back.

## Request composition (engine-owned - POST /compose)

The engine owns request composition (#226): `POST /compose`
(`engine/src/http/request_composer.cpp`) resolves `{{variables}}` and `inherit`
auth (collection-chain walk; `noauth` terminates, `none` steps over) and
returns the execute-ready payload `POST /execute` / `POST /runs` accept
unchanged. Compose is pure (sends nothing, no run row) and is the one place a
payload is composed; that split is load-bearing. Two entry shapes: `requestId`
(stored request; MCP uses this and gates its allowlist on the *composed* URL)
and an inline `request` plus `collectionId` scope (the renderer, because Send
and replay execute editor state that may be unsaved). Inline over stored is
the overlay MCP's `start_load_run` overrides ride on.

Execute is not silent past compose (#1008): a name compose could not answer
(it kept its braces, #1009) is resolved once more after the pre-request script
and before the send (`resolve_residual_tokens`,
`engine/src/http/request_exchange.cpp`); a value compose already substituted is
finished text. **That pass can refuse** (#1051, #1084): a header name that
resolves onto one the request already carries, or to nothing, is refused
before the send, in the same words and with the same code compose uses for the
`400` (`http/header_names.hpp` holds the rule; the pass answers a
`ResidualRefusal` carrying the code). The two rules read different reaches
(#1095): the empty-name rule reads every header name, the collision rule only
the names that still held a token. A data row whose header-name column is
blank is refused at bind time (`core/scenario_data.cpp`), because the load
path runs no residual pass over what it binds.

**The renderer's resolver is preview-only.** `useVariableResolver` /
`app/src/lib/variable-resolution.ts` back tab titles, previews, unresolved-token
painting and the OAuth-guard preview, never a payload. Its rules are pinned to
the engine's by `engine/tests/fixtures/variable-resolution-conformance.json`,
read by `request_composer_test.cpp` and
`variable-resolution.conformance.test.ts`; change resolution semantics in the
engine, the renderer lib and the fixture together, and a case added to the
fixture fails whichever side forgot. The dynamic-variable name set (`$guid`,
`$timestamp`, …) is part of that contract (C++ table in `request_composer.cpp`,
renderer table in `lib/dynamic-variables.ts`), as are the D17 malformed-data
rules (absent or non-boolean `enabled` = enabled; non-string `value` = "") in
`parse_variables` and `variable-resolution.ts`. Compose resolves strictly
**before** the pre-request script runs (D1, a deliberate Postman divergence
the residual pass does not reverse), and script text is never interpolated
(D16). MCP has no composition copy; a new engine client calls `POST /compose`.

Script parts: clients on the inline path build the ordered `ScriptPart` list
(`scriptParts` in `app/src/modules/request-builder/utils/script-parts.ts`, the
only client-side copy); the by-id path builds it engine-side
(`compose_script_parts`). The engine joins parts with `"\n\n"` and runs the
result. `read_post_request_script` (`engine/src/http/script_parts.cpp`) owns
every spelling the post-request script answers to (`postRequestScript`,
`postRequestScript(s)` on `/execute`, `tests` on `/runs`), and both routes read
through it; add a spelling to that table, never to a route.

## Docs to keep in step

| Doc | Update it when you change… |
|-----|----------------------------|
| `docs/engine/api-reference.md` | **Any** endpoint, payload, or status code |
| `docs/engine/architecture.md` | Core engine structure, auth resolution |
| `docs/engine/db-schema.md` | Schema, migrations, stored JSON |
| `docs/engine/scripting.md` | Script globals, hooks, sandbox limits |
| `docs/engine/mcp.md` | MCP tools or their schemas (the server itself lives in `app/electron/mcp/`) |
| `docs/engine/cli.md` | Flags or subcommands |
| `docs/engine/benchmarks.md` | Load generation or measurement |
| `docs/engine/building.md` | CMake presets, vcpkg deps, the lint and format gates |
