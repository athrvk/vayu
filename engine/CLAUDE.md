# Engine (C++23 daemon)

The load-testing and request-execution engine. AGPL-3.0. See the repo root
`CLAUDE.md` for build commands, commit rules and repo-wide conventions.

```
engine/
├── src/core/      # load_strategy, metrics_collector, run_manager, import, openapi
├── src/http/      # HTTP server, SSE, routes, transport
├── src/db/        # SQLite persistence
├── src/runtime/   # QuickJS scripting engine; pm/ holds the pm.* surfaces, one file per family
├── src/platform/  # per-OS code (timer resolution, process, paths)
├── src/utils/     # shared primitives (encoding, ascii_case, parse, reentrant)
├── include/vayu/  # Public headers
├── tests/         # Google Test suite; tests/fixtures/ holds the conformance tables
└── vendor/        # quickjs-ng, hdrhistogram (provenance in vendor/README.md), and the JS libraries `require()` embeds (uuid, lodash, moment, csv-parse, xml2js, chai, ajv, tv4), accounted for by js-manifest.json
```

## Conventions

Each rule below names the primitive that holds it and the test that guards it.
Several guards are source scans over `engine/{src,include,tests}` with a
per-file exemption list; they exist because the lint gates read only the files
a change touches (#946), so nothing else holds an untouched file at zero.

- **Standard: C++23** (#901), `-Wall -Wextra -Wpedantic`. Run
  `scripts/cxx-feature-probe/` (`docs/engine/building.md`) before reaching for a
  C++23 library feature the engine does not already use: what a standard offers
  per platform is measured. libc++ has no `std::move_only_function`, so a queued
  task stays a copyable `std::function`.
- **An error-or-nothing API is `RouteResult`** (`std::expected<void, RouteError>`),
  never an `std::optional` whose empty state means success. `route_error` builds
  the refusal; `as_response` converts one to the pair a testable core answers.
- **A request body becomes JSON through `parse_request_json`** (#2417, #2671;
  `http/routes.hpp`), never `nlohmann::json::parse (req.body)`: `dump ()` and the
  copy constructor recurse, so a body nested 100,000 levels takes the engine
  down at the first copy. It answers the 400 for unparsable text and for depth
  past `constants::request_body::MAX_JSON_DEPTH` (128), through
  `refuse_request_body`; a route with a documented code for a malformed body
  passes it as both `depth_code` and `parse_code`. Parse before the handler's
  `try`, so its `catch` keeps meaning "the core threw". Guards:
  `request_body_depth_test.cpp`, `request_body_parse_scan_test.cpp`.
- **A public header never calls `min` or `max` unparenthesized.** `NOMINMAX` is
  PRIVATE to `vayu_core`, so a test including `<curl/curl.h>` or `<httplib.h>`
  first gets `windows.h`'s macros on MSVC and `std::min (a, b)` in a header fails
  there (C2589) while Linux and macOS stay green. Write `(std::min) (a, b)` and
  `(std::numeric_limits<T>::max) ()`; for a bare constant use `SIZE_MAX` or
  `INT64_MAX`. Guard: `header_min_max_scan_test.cpp`.
- **An optional a guard has already proved is read through one binding**
  (`const auto& shape = shapes[i]; if (!shape) { continue; } use (*shape);`):
  `shapes[i]` written twice is two expressions, so
  `bugprone-unchecked-optional-access` cannot connect guard to use. Where the
  rule that makes the access safe lives in *another* function, read it through
  **`vayu::utils::invariant_value`** (`utils/invariant.hpp`, #943), which takes
  the rule as a string and throws `std::logic_error` naming it. An optional a
  client can empty keeps its `if`, its 404 and its default. In a test the guard
  is **`ASSERT_HAS_VALUE`** (`tests/optional_assert.hpp`, #980), never
  `ASSERT_TRUE (opt.has_value ())`, whose `AssertionResult` the analyzer cannot follow.
- **The reentrant spelling of a C call, always** (#945): `std::localtime` and
  `std::strerror` return process-shared storage, so use `vayu/utils/reentrant.hpp`.
  The force-shutdown branch is `std::_Exit` inside the signal handler, which
  takes no lock and logs nothing (#3346): it stores a `ShutdownSignal` and the
  main loop logs. Guard: `reentrant_test.cpp` scans for the classic names and
  `setenv`/`unsetenv`/`putenv`; the one write exempted is `grant_secret.cpp`
  removing `VAYU_GRANT_SECRET` before any thread exists (#2356).
- **Nothing at namespace scope is built at run time** (#945, `cert-err58-cpp`):
  a constant is `constexpr`; an object that cannot be one (`std::regex`,
  `nlohmann::json`, anything holding a `std::string`) is a function-local
  `static` an accessor returns a reference to. A constant *derived* from another
  is spelled out and pinned with a `static_assert`.
- **Bytes become characters in one place, never at the site** (#945):
  **`vayu::utils::byte_view`** (`utils/encoding.hpp`) and **`vayu::db::column_text`**
  (`db/database.hpp`, keeping SQL NULL a null pointer because absent and empty
  differ); `sodium_bytes` and `openssl_bytes` go the other way. A function
  pointer off `GetProcAddress` or a `sockaddr_in*` off an `addrinfo` is not this
  rule. Guard: `character_cast_test.cpp`.
- **A case-insensitive comparison folds through `vayu::utils::ascii_lower`,
  `ascii_upper` and `ascii_lower_equal`** (`utils/ascii_case.hpp`, #1060). ASCII
  is the contract (header names, schemes, MIME types), and `std::tolower` on a
  byte above 127 is undefined where `char` is signed. Nothing calls either; the
  guard (`ascii_case_test.cpp`) also catches the function *passed* (`::tolower`).
- **A class with a destructor states all five** (#945): every RAII holder (a
  pImpl's `Impl`, `Database`, the mock servers, each manager and listener in
  `include/`) deletes copy *and* move beside its destructor, in the spelling
  `server.hpp` uses (`Client` is the one exception: copy deleted, move declared),
  and a class with no other constructor gains `Foo () = default;`. A mock
  server's thread pool is `vayu::tests::pooled_task_queue`.
- **A length is kept, never re-derived** (#945, `cppcoreguidelines-pro-bounds-*`):
  a subrange is `substr` on a view, a fixed table a `constexpr std::array`,
  `argv` a `std::span<char* const>`, a computed index goes through `.at ()`.
  Numbers parse through **`vayu::utils::parse_number`** (`utils/parse.hpp`) and,
  for a flag, **`core::parse_numeric_flag`** (`core/numeric_flag.hpp`, #1028).
  **`vayu::http::CurlErrorBuffer`** owns `CURLOPT_ERRORBUFFER`'s three rules (at
  least `CURL_ERROR_SIZE`, alive for the transfer, cleared between transfers).
- **Untrusted JSON text becomes an `ordered_json` through
  `vayu::utils::parse_ordered_json`** (`utils/ordered_json.hpp`, #2497), never
  `nlohmann::ordered_json::parse` (nor `json::parse` through a `using json =
  nlohmann::ordered_json` alias): it scans the members before each one, so
  100,000 keys is minutes of one core in Debug. Pass `ORDERED_JSON_UNBOUNDED`
  where the caller bounds depth itself, else a depth; JSON carried in a *string*
  field is outside the request-body bound, so whoever parses it bounds it at
  `MAX_JSON_DEPTH` first (#2672). On the Windows ASan leg growing an object
  deep-copies every member: `reserve_members` first, move a value you own, copy
  members out through `append_unique_member` (#2552). Guard: `tests/wide_json.hpp`;
  each entry point that reads client JSON has a 100,000-key test.
- **libcurl's variadic calls go through `set_opt` / `get_info`**
  (`http/curl_options.hpp`, #1023): the constant is a template argument,
  `static_assert`ed against its category. Only the Windows leg reports a raw
  call; `clang-tidy --extra-arg=-U__STDC__` reproduces that anywhere.
- **A row struct's scalars all carry a default** (#1013): the `vayu::db` structs in
  `types.hpp` are aggregates an insert fills field by field, and sqlite_orm
  stores whatever a forgotten one held; the enums default to `row_extractor`'s fallback.
- **A destructor, a thread entry and `main` are total, and no linter says so**
  (#1023; `bugprone-exception-escape` is declined in `engine/.clang-tidy`): a
  `try` around the whole body, `catch (...)` at the end, reporting through a
  `noexcept` helper (`~SseStreamManager` is the shape).
- **An empty `catch` opens with `@deliberate` and then says why** (#944): what the
  recovery is and what the caller gets instead; with no reason, fix it or log it.
- **A vendored script library is listed in `engine/vendor/js-manifest.json`**
  (#2750; `ctest -R VendorJs`; [recipe](../docs/engine/building.md#upgrading-a-vendored-library)).
- **A new `tests/*_test.cpp` is listed in `add_executable(vayu_tests ...)`** in
  `engine/tests/CMakeLists.txt`, never a glob; a guard fails configure naming an
  unregistered file (#668). The list is there, not in `engine/CMakeLists.txt`,
  because that file is a `sanitizers.yml` trigger path (#970).
- **A suite that outgrows one file keeps its name** and moves its fixture to a
  header (`script_engine_fixture.hpp`, `runs_route_fixture.hpp`,
  `database_fixture.hpp`; cases in `script_engine_*_test.cpp` and kin, #3852).
  The suite name is what `vayu_scratch_database_suites`, ctest regexes and
  `--gtest_filter` key on, so a rename makes them silently stop matching. A
  helper two files read goes in that header; the fixture class stays out of an
  anonymous namespace (gtest refuses a suite whose `TEST_F`s name different classes).
- **A test waits on a condition with `vayu::tests::wait_until`**
  (`tests/wait_until.hpp`), never on a `sleep_for` followed by an assertion; its
  20s deadline only bounds how long a broken build takes to report, under the
  60s CTest timeout. A run that must be "in flight" is stopped once the mock has
  seen its first request; one that must be "finished" is awaited until
  `RunManager::get_run` answers null (`retain_run` is the worker's last act). A
  wall-clock assertion names the healthy and the broken reading and sits between
  them (root `CLAUDE.md`, "Testing").
- **A fixture that opens a scratch `Database` cleans up with
  `vayu::tests::remove_database_files`** (`tests/temp_database.hpp`): an opened
  database writes six files (#413), so never a hand-written suffix list.
- **A startup repair pass is scoped, transactional, marked done and backed up
  first** (#1487, [db-schema](../docs/engine/db-schema/startup-and-recovery.md#the-header-strip-pass)):
  `/health` does not answer until `init ()` returns, so select candidates with a
  SQL predicate, rewrite inside one `transaction_guard`, record a done marker,
  and save a `backups/` snapshot first, skipping the pass when the copy cannot
  be written (#2426). An index-served, idempotent predicate may skip the marker.
- **Removing a column from a `make_table` mapping is `ALTER TABLE DROP COLUMN`
  at the constructor's probe `sync_schema ()`**, before `init ()` and so before a
  repair pass can read it. Read the data out in a `PRAGMA user_version`-gated
  step ahead of the probe (`migrate_before_sync`, the constructor's first,
  unguarded statement, which refuses a newer database rather than quarantine it)
  or keep the column mapped ([migrations](../docs/engine/db-schema/startup-and-recovery.md#the-script-to-elements-migration)).
- **Only a corrupt database reaches recovery** (#2420): `classify_probe_failure`
  sorts `SQLITE_CORRUPT` and `SQLITE_NOTADB` as corrupt and anything else (a
  lock, a full disk, a failed migration step) as unavailable, which the
  constructor throws with every file untouched ([recovery](../docs/engine/db-schema/startup-and-recovery.md#startup-validation-backup-and-recovery)).
- **Any change to `make_vayu_storage`'s mapping bumps `SCHEMA_VERSION`** (#1492),
  an added nullable column included: `sync_schema ()` runs without `preserve`, so
  an older engine would rebuild a table without the column it does not map. The
  bump is one-way, so it gets a row in [schema versions](../docs/engine/db-schema/schema-versions.md#schema-versions)
  and a line in the next release's notes; `migrate_before_sync` stamps through
  `stamp_schema_version`, never a literal.
- **A log call takes a category, never text alone** (#1557,
  [logging](../docs/engine/logging.md)): `LogRecord{level, cat, msg, fields}` is the
  whole API (`log_debug`/`log_info`/`log_warning`/`log_error`), `cat` is one
  token from a closed list, and `log_category_scan_test.cpp` fails the build on
  a call with none. Redaction by field name is `Logger::write`'s, never the
  caller's; `msg` is never redacted, so text a user's script authored is a
  field bounded through `bounded_log_text` (#2359). The request line is
  `install_request_logger`'s alone (#1510): a route logs only what the hook
  cannot know, and `request_log_test.cpp` scans for the old per-route shape.
- **vcpkg manages every C++ dependency**: add one in `engine/vcpkg.json`. In the
  cloud dev environment a `vcpkg_from_github` port fails on a cold cache with
  `curl operation failed with response code 403`: run `vcpkg-fix-port <port>` (no
  arguments re-does the manifest), which rewrites it to `vcpkg_from_git` as an
  overlay, then build again. A port whose portfile pulls extra archives (`c4core`
  under `ryml` fetches three) needs those rewritten by hand. A checkout at an
  older tag wants older ports than `/opt/vcpkg-overlay-ports` pins: copy the
  overlay and run `VAYU_ENGINE_DIR=<checkout>/engine VCPKG_OVERLAY_PORTS=<copy>
  vcpkg-fix-port <ports>`, then `touch engine/vcpkg.json`. CI needs none of it.
- **The git hooks install themselves** with `python build.py --setup` (also run by
  `.claude/hooks/session-start.sh`); on Windows use `bash scripts/install-git-hooks.sh`.

## Formatting and linting

- **clang-format 22 exactly** (`.clang-format` at repo root): another major
  formats a measured share of the sources differently, so after `clang-format -i`
  read `git diff` for reindentation you did not intend. `Engine formatting` in
  `pr-tests.yml` runs `--dry-run -Werror` over `engine/{src,include,tests}`
  (#886) and `scripts/pre-commit` over what a commit stages (#908). The two odd
  settings (`ColumnLimit: 80` with `PenaltyExcessCharacter: 1`,
  `ContinuationIndentWidth: 0`) are what the code is written to; a "tidier"
  value costs a five-figure-line rewrite. `engine/vendor/` sets
  `DisableFormat: true`. Includes are sorted, with one pinned exemption
  (`<windows.h>` / `<timeapi.h>` in `high_resolution_timer.cpp`, under
  `// clang-format off`); a second is pinned at the site, never by turning the sorter off.
- **clang-tidy 22, the LLVM project's build** (`.clang-tidy` in `engine/`,
  `engine/src/runtime/`, `engine/tests/`; `scripts/install-clang-tidy.sh`). It
  runs at push, not commit (20-90s a file): the pre-push hook lints every C++
  file in the commits no remote-tracking ref reaches. **A finding is a failure**
  (#885, `WarningsAsErrors: '*'`): the hook and the `Lint changed engine sources`
  step in `pr-tests.yml` both read the exit status. Linux and Windows are gated
  (a `#ifdef _WIN32` branch is preprocessed away on Linux, #1023); macOS is
  excluded because clang-tidy 19 and 20 SIGILL on the AppleClang 21 SDK (#940).
  Both gated legs lint **whole files** (#946): a finding anywhere in a touched
  file is that change's to fix, or to `NOLINT` with the reason at the site. A
  pull request that is only a bulk reformat carries the `reformat-pr` label.
- **The Windows tidy leg reads its C++ standard from the compile database**
  (`scripts/tidy-msvc-std-args.sh`): a `-std:c++23` clang-cl ignores is a C++14
  parse, shown as `std::string_view` missing beside a green test step. **CI lints
  translation units, never a header as an input** (#940): a header's findings
  surface through the changed units that include it, and a header-only change
  relies on the pre-push hook and the weekly `engine-tidy-scan.yml`. A whole-tree
  measurement passes `-header-filter` itself and dedupes by (file, line, column,
  check). Commands: [building](../docs/engine/building.md).

## HTTP API

The daemon listens on `http://127.0.0.1:9876` and serves no browser: it sends no
CORS header, and the request gate in `server.cpp` refuses any `Origin` and any
`Host` that is not a loopback name for its own port, before routing
([who may call the API](../docs/engine/api-reference/index.md#who-may-call-the-api)).
Routes, payloads and status codes live in the
[API reference](../docs/engine/api-reference/index.md#pages), one page per group
of `src/http/routes/*.cpp`.

**A `GET` route must never have a side effect, because any web page can make the
engine run one.** A scriptless `GET` (`<img>`, a `no-cors` `fetch`, a navigation)
carries a loopback `Host` and no `Origin`, so the gate admits it; what keeps it
harmless is that the page cannot read the opaque answer and the route changes
nothing. Anything that writes, starts, stops, deletes or sends is a `POST`,
`PUT` or `DELETE`, which a page can only send with an `Origin`. An SSE route
holds a pool thread per stream, so it needs an id a page cannot know: `/changes`
opens only on a single-use id from `POST /changes/subscriptions` (#3420), capped
by `change_feed::MAX_READERS`, and `/runs/:id/events` and `/inbox/:id/live` are
claimed for the life of the connection. A stream route taking a slot without
such an id lets any page lock the app out. The gate is not widened to `Sec-Fetch-Mode`.

### Contracts to design around

- **POST creates, PUT updates, and the engine owns every id** (#95, #97;
  [resource writes](../docs/engine/api-reference/resource-writes.md)). One
  null-vs-absent rule covers every resource and lives in `apply_*_field`,
  `reject_client_supplied_id` and `reject_mismatched_body_id` (`http/routes.hpp`)
  and `apiService.updateX` (`app/src/services/api.ts`): add a field there, never
  per handler; `POST /import/apply` reaches it through the same appliers. The
  create/update cores, not the appliers, refuse a blank `name` and an unknown
  auth mode, because an importer can write both. List paging is
  `http/list_page.hpp`'s (#2443).
- **A route's `catch (const std::exception&)` answers through `send_exception`**,
  never `send_error (res, 400, e.what ())` (#2423, `routes.hpp`): a SQLite
  failure is `507` / `503` / `500`, never quoted
  ([a storage failure is not a 400](../docs/engine/api-reference/resource-writes.md#a-storage-failure-is-not-a-400)).
  Only a read-only or compute route (`spec_match`, `spec_export`, `spec_diff`,
  `spec_describe`, `postman_export`) keeps the bare `400`; `storage_error_test.cpp` scans the rest.
- **A core that reads, decides and writes holds one lock** (#386, #1878):
  `Database::with_lock` around the whole composite, a merge-patch as
  `update_<resource>_locked` inside it (the `before_write` seam is
  `tests/competing_writer.hpp`'s). Reading under one acquisition and writing
  under another loses the other writer's fields with no error
  ([the shapes that need it](../docs/engine/architecture.md#a-core-that-reads-decides-and-writes-holds-one-lock)).
- **A behaviour attached to a request or collection at a phase of a step is an
  element kind, not a column** (#1512; [elements](../docs/engine/elements.md#the-registry-and-how-a-kind-is-added)):
  a kind registers once under `engine/src/core/elements/`; a registry flag
  (`tracks_scope_occurrence`, `writes_variables`, `category`, `HotPathClass`) is
  read through the registry, never a `kind ==` comparison. `elements` is the
  only script source. Every `config_schema` property carries `title` and
  `description`, and a default is the named constant in `element_defaults.hpp`.
- **Saved examples are nested under their request** (#481; [examples](../docs/engine/api-reference/examples.md)):
  the owner is checked before the example on every path, and list order
  (`order`, `created_at`, `id`) is a contract. Deleting an imported example
  keeps a tombstone (`suppressed`, #722) every read filters except
  `get_suppressed_request_examples`. `savedFrom` is create-only.
- **A streaming request is declared, not detected** (#573; [execute](../docs/engine/api-reference/execute.md),
  [events](../docs/engine/api-reference/live-metrics.md#get-runsrunidevents)).
  A stream ends by a rule that can name itself (`SseEndReason`, never a
  whole-transfer deadline), a shutdown is `Shutdown` and never a user's `Stopped`
  (#3342), and a transfer is a stream only when its final hop announced
  `text/event-stream` (#3771). **A consumer worker is drained by whoever owns the
  manager before the state it writes through goes away** (#646): `Server::stop ()`
  calls `SseStreamManager::shutdown ()`, which *joins*, because `daemon.cpp` runs
  `curl_global_cleanup` between it and `~Server`; waiting on `context->closed ()`
  is not draining; a fixture resets the manager before its `Database`.
- **A transfer a management-API handler makes carries
  `RouteContext::server_stopping`** (#2683) as its cancel, and an SSE relay loop
  ends on it: `Server::stop ()` sets it and joins every handler, never detaches
  one, because the daemon then destroys curl's global state and the database. A
  listener a manager owns waits on its `StopSignal` (never `sleep_for`;
  `ListenerRegistry::shutdown` requests every signal before joining any, #3345).
  A run's auxiliary transfer carries `RunContext::aux_cancel` (#3343), one its
  own thread makes carries `should_stop`, and cancelling is the run ending,
  never a failure ([listeners](../docs/engine/architecture.md#listeners)).
- **An OpenAPI document is stored once and *bound* by collections, never owned by
  one** (#637; [specs](../docs/engine/api-reference/specs.md)): nothing cascades
  to a document and there is no `PUT /specs/:id`. Both indexes derive from one
  read (`read_spec_indexes`), and `match`, `bind`, `diff`, `sync` and `export`
  share `core::match_operations` and `spec_contract_subtree_ids`. A person's
  delete or move of a stamped request declines its operation, resolved by the
  route (`core::nearest_spec_binding`) so `Database` reads no binding. Response
  validation never reaches `load_strategy.cpp` or `scenario_load.cpp` (a source
  scan, #682). YAML is emitted beside the reader (`core::emit_yaml`): its
  `plain_scalar` decides quoting, and a split would re-import `2.0` as a number.
- **The engine parses every import document** (#877, `core/import_document.hpp`;
  [import](../docs/engine/api-reference/import.md)): OpenAPI rides the spec
  reader, Insomnia v5 is flattened into v4's list (`InsomniaV5Flattener`) so a
  fix lands for both, and `POST /import` is parse plus `import_apply_payload`
  plus `POST /import/apply`, pinned to the app's flattening by
  `orchestrator.payload-conformance.test.ts`.
- **`followRedirects` / `maxRedirects` / `verifySSL` are per-request and stored**
  (#706; [execute](../docs/engine/api-reference/execute.md#post-execute)), and
  both clients send them every time, because the engine defaults to following
  and verifying. No driver sets `CURLOPT_FOLLOWLOCATION`: each follows a
  redirect itself, one transfer per hop, and every between-hop decision lives in
  `http/redirect_policy.hpp`.
- **What Vayu adds to a request nobody wrote it into is one set** (#1229,
  `http/default_headers.hpp`; [default request headers](../docs/engine/api-reference/health-config.md#default-request-headers)),
  applied in `build_request_header_list` so every driver adds the same headers:
  add a default there, never in a driver. None of it is stored (#2464).
- **Every outbound transfer leaves through one `TransportPolicy`** (#705,
  `http/transport_policy.hpp`), applied by the single
  `detail::apply_transport_policy`, which owns TLS verification and the proxy
  options: add a transport option there, never to a driver. It is workspace- or
  run-scoped, never per request (libcurl reuses a pooled connection only when
  its proxy config matches). Every mode writes
  `CURLOPT_PROXY` and `CURLOPT_CAINFO` (empty included) because handles are
  reused, and the `CURLOPT_PROXY_*` twins take the target's values because
  libcurl does not inherit them (#2469). `curl_to_error` classifies by shape,
  never by a list of codes ([proxy](../docs/engine/api-reference/health-config.md#proxy-settings),
  [TLS](../docs/engine/api-reference/health-config.md#tls-trust-settings)).
- **No transfer reaches Vayu's own ports** (#2355, `http/loopback_guard.hpp`;
  [reserved local ports](../docs/engine/api-reference/compose.md#reserved-local-ports)):
  `validate_transferable` judges the URL and `apply_transport_policy`'s
  `CURLOPT_PREREQFUNCTION` the address a connection reached. A new driver goes
  through both; a new address class goes into the one classifier. Tests share
  one registered port stand-in (`tests/engine_port_stand_in.hpp`).
- **Every leg verifies with OpenSSL, and the engine names its backend** (#851):
  Windows' libcurl is MultiSSL and reads `CURL_SSL_BACKEND` from the
  environment, so `pin_tls_backend ()` calls `curl_global_sslset` first. Windows
  and macOS set `CURLSSLOPT_NATIVE_CA` unconditionally, and SecTrust refuses a
  `CURLOPT_CRLFILE`, so never set one ([building](../docs/engine/building.md)).
- **A client certificate belongs to a host, not a request** (#707;
  [client certificates](../docs/engine/api-reference/cookies-and-certificates.md#client-certificates)):
  `match_client_certificate` picks per transfer and per redirect hop (#3300). A
  Postman import is the one non-route writer: `POST /import/apply` registers
  candidates **after** the tree's transaction commits, never inside it, where
  the lock would deadlock.
- **A file a request body names is sent under one trust rule**
  (`http/file_access_policy.hpp`; [file access](../docs/engine/api-reference/file-access.md)):
  trust is derived, never read (`derive_file_trust` on every read,
  `erase_file_trust` on every stored body). `FilePlan` applies it once per send
  or run, and a file is read from the handle the check approved (`ApprovedFile`),
  never from `src` again. A new driver that sends a body goes through a `FilePlan`.

## Request composition (engine-owned - POST /compose)

`POST /compose` (`http/request_composer.cpp`, #226) is the one place a payload is
composed, and it is pure (sends nothing, no run row): that split is load-bearing
([compose](../docs/engine/api-reference/compose.md),
[the boundary](../docs/engine/architecture.md#request-composition-boundary-engine-owned-via-post-compose)).

- **A new engine client calls `POST /compose`**; MCP has no composition copy. The
  renderer's resolver (`lib/variable-resolution.ts`) is preview-only, never a
  payload. Change resolution semantics in the engine, the renderer and the shared
  fixture together (`tests/fixtures/*-conformance.json`): a case added to one
  fails whichever side forgot.
- **A header name is trimmed of SP and HTAB, then must be an RFC 9110 token**
  (#2467, `header_names.hpp`): refuse what trimming cannot settle, never repair
  it, and **a refusal never quotes what a variable produced**, which can be a
  secret. A query pair the engine writes goes through `core::encode_query_component`.
- **A scripted request composes with its `{{names}}` intact** (#2521, Postman's
  order): the names keep their braces and are listed in `deferredVariables`. A
  collection run decides once for the whole plan (`plan_variable_deferral`); a
  new kind that writes a variable sets `writes_variables`.
- **Execute is not silent past compose** (#1008): a name still written is
  resolved after the pre-request script and before the send
  (`resolve_residual_tokens`), with no caller flag; under load the pass only
  counts a refusal (#1503), through `resolve_load_residuals`.
- **`targetPolicy` holds a send to the caller's hosts** (#2521,
  `http/target_policy.hpp`): the final URL is judged after the script and the
  residual pass, so a refused target fetches no token. It is never stored.
- **Add a script destination to `compose_elements`**, never a new legacy field to
  a route (`refuse_legacy_script_fields`).

## Docs to keep in step

| Doc | Update it when you change… |
|-----|----------------------------|
| `docs/engine/api-reference/` | **Any** endpoint, payload, or status code: one page per group of `src/http/routes/*.cpp` files, and the table in `index.md` names the page for each route file |
| `docs/engine/run-export.schema.json` | A member of the run-report export (`core/run_export.cpp`, its comparison `core/run_compare.cpp`); `run_export_schema_test.cpp` validates against it |
| `docs/engine/architecture.md` | Core engine structure, auth resolution |
| `docs/engine/elements.md` | The element registry, a kind's config or phase, an element kind, the pipeline that runs one |
| `docs/engine/db-schema/` | Schema, migrations, stored JSON: one page per group of tables, `index.md` names them |
| `docs/engine/scripting.md` | Script globals, hooks, sandbox limits |
| `docs/engine/mcp/` | MCP tools or their schemas (the server itself lives in `app/electron/mcp/`); `tools.md` is generated from the registry, so a new tool changes it by `pnpm docs:mcp-tools` from `app/` and no hand-written page |
| `docs/engine/cli.md` | Flags or subcommands |
| `docs/engine/logging.md` | The log record, categories, redaction, file names |
| `docs/engine/benchmarks.md` | Load generation or measurement |
| `docs/engine/building.md` | CMake presets, vcpkg deps, the lint and format gates, the vendored JS libraries and their manifest |
