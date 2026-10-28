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

- **Standard: C++23** (#901), `-Wall -Wextra -Wpedantic`. What a standard offers
  on each platform is measured: `scripts/cxx-feature-probe/` compiles one tiny
  translation unit per feature and the `C++ feature probe` workflow runs it on
  all three platforms plus `g++-14`; it gates nothing (`docs/engine/building.md`).
  The one measurement that shapes the code: libc++ has no
  `std::move_only_function`, so a queued task stays a copyable `std::function`.
  Run the probe before reaching for a C++23 library feature the engine does not
  already use.
- **An error-or-nothing API is `RouteResult`** (`std::expected<void, RouteError>`),
  never an `std::optional` whose empty state means success. `route_error` builds
  the refusal; `as_response` converts one to the pair a testable core answers.
- **A request body becomes JSON through `parse_request_json`** (#2417, #2671;
  `http/routes.hpp`), never `nlohmann::json::parse (req.body)`: nlohmann parses
  iteratively but `dump ()` and the copy constructor recurse, so a body nested
  100,000 levels takes the engine down at the first copy. The helper answers
  the 400 for text that does not parse and for a value past
  `constants::request_body::MAX_JSON_DEPTH` (128); `refuse_request_body`
  sends it under the route's label, and a core that takes the body as a string
  returns `as_response (refusal)`. A route with a documented code for a
  malformed body passes it as both `depth_code` and `parse_code`. An empty body
  that means `{}` or `null` is the route's own `if (req.body.empty ())` before
  the call. Parse before the handler's `try`, so its `catch` keeps meaning "the
  core threw". Tests: `tests/request_body_depth_test.cpp` drives a 100,000-level
  body through every adopted route; `tests/request_body_parse_scan_test.cpp`
  fails on a `json::parse (req.body)` (or `request_body`, `body`) anywhere
  under `src/http/routes`, so a new handler cannot skip the helper. It has no
  exemption list because no route needs one; `routes.hpp` holds the one parse.
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
  names and for `setenv`/`unsetenv`/`putenv`/`_putenv_s`, which would make the
  exempted `getenv` reads (`transport_policy.cpp`, `grant_secret.cpp`) unsafe.
  The one write exempted, per (file, call), is `grant_secret.cpp` removing
  `VAYU_GRANT_SECRET` once at start, before any thread exists (#2356).
- **Nothing at namespace scope is built at run time** (#945, `cert-err58-cpp`,
  which clang-tidy 22 reports as `bugprone-throwing-static-initialization`).
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
  whole string, and **`ascii_upper`** raises one the same way (#2090);
  **`ascii_lower_equal`** compares without building a lowered
  copy (`vayu::CaseInsensitiveLess` folds through it in one pass). ASCII is in
  the name because it is the contract: every caller folds a header name, a
  scheme, a MIME type, a hostname or a log-level word, all ASCII by their own
  specifications, and `std::tolower` or `std::toupper` on a byte above 127 is
  undefined where `char` is signed and locale-dependent otherwise. Nothing here
  calls either. Guard: `tests/ascii_case_test.cpp`, whose matcher catches the
  function *passed* (`std::transform (b, e, b, ::tolower)`) as well as called, for
  both `tolower` and `toupper`.
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
- **Untrusted JSON text becomes an `ordered_json` through
  `vayu::utils::parse_ordered_json`** (`utils/ordered_json.hpp`, #2497), never
  `nlohmann::ordered_json::parse`: that parse places each member with a scan of
  the members before it, so one object of 100,000 keys is minutes of one core
  in a Debug build. Pass `ORDERED_JSON_UNBOUNDED` where the caller bounds depth
  itself (`read_document` does, on the finished tree) and a depth where it
  does not. JSON carried inside a *string* field is outside the request-body
  depth bound (`parse_request_json`, #2417), so whoever parses it bounds it at
  `constants::request_body::MAX_JSON_DEPTH` before anything copies or `dump`s
  it (#2672): `jsonrpc_wire_body` parses with that depth,
  `graphql_get_parameters` and the `pm` GraphQL view probe `exceeds_depth`, and
  `postmanProtocolBehavior` measures with `json_within_depth`. Each has a
  crash-depth test and an at-bound test in its suite. Only text the engine wrote
  itself, at a size no client chose, may
  keep `ordered_json::parse`; a stored row is not that (its members are a
  client's), so `engine/src` has no such site today. A file that aliases the
  type (`using json = nlohmann::ordered_json`) makes `json::parse` the same
  call, so grep for the alias too. Guard: `tests/wide_json.hpp` builds the
  input (`wide_object_json`, 100,000 keys) and holds `LINEAR_PARSE_BUDGET`;
  each entry point (`jsonrpc_wire_body`, `parse_import`, `read_document`, the
  element pipeline, `postmanProtocolBehavior`, an example's `savedFrom`, the
  Postman export's stored columns) has a test that fails the budget on the
  quadratic parse. The rest of a path can still be quadratic after the parse is
  not (`ordered_map::operator[]` per member); the test measures the whole path.
  Copying members out of an object whose keys are already distinct goes through
  `vayu::utils::append_unique_member` (#2552), and a test reads its export back
  with `parse_ordered_json`, never `ordered_json::parse`. **Linear is not
  enough on the Windows ASan leg**, where every allocation is expensive: an
  `ordered_json` object keeps `std::pair<const std::string, ...>`, which is not
  nothrow-movable, so growing one deep-copies every member it holds, and a
  member added beside a wide one copies the wide one. Reserve first
  (`vayu::utils::reserve_members`), move a value you own rather than copy it,
  and build a many-times object member by member rather than from an
  initializer list. The 100,000-key test of an entry point fails the sanitizer
  legs' CTest timeout when this is ignored, though every copy is linear.
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
  `database_impl.hpp`'s `row_extractor` falls back to for an unparsable stored
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
- **A vendored script library is listed in `engine/vendor/js-manifest.json`**
  (#2750): each shipped file's SHA-256, its npm tarballs with their registry
  `dist.integrity`, and `verbatim` or the pinned esbuild command that built
  it. `tests/vendor_js_manifest_test.cpp` (`ctest -R VendorJs`) fails on a
  changed byte, on a `.js`/`.mjs`/`.cjs` under `engine/vendor/` the manifest
  does not list (the `quickjs-ng` and `hdrhistogram` trees aside) and on an
  empty manifest; `scripts/vendor-js/rebuild.sh <lib>` is the online proof.
  Upgrade recipe: `docs/engine/building.md#upgrading-a-vendored-library`.
- **A new `tests/*_test.cpp` is listed in `add_executable(vayu_tests ...)`**
  in `engine/tests/CMakeLists.txt`; the list is explicit, never a glob, and a
  guard beside it fails configure naming any unregistered file, because an
  unbuilt test file reports nothing (#668). The list lives there and not in
  `engine/CMakeLists.txt` because that file is a `sanitizers.yml` trigger
  path (#970); keep routine edits out of it.
- **A test waits on a condition with `vayu::tests::wait_until`**
  (`engine/tests/wait_until.hpp`), never on a `sleep_for` followed by an
  assertion. Its deadline (`WAIT_DEADLINE`, 20s) only bounds how long a broken
  build takes to report, under the 60s CTest per-test timeout. A run that has
  to be "in flight" is stopped once the mock has seen its first request. A
  run that has to be "finished" is awaited until `RunManager::get_run` answers
  null, because `retain_run` is the worker's last act. A wall-clock assertion
  that stays (a stop that must be prompt, a window that must leave out the
  drain) names the healthy and the broken reading in its comment and sits
  between them, with the mutation check that proves the broken side. The root
  `CLAUDE.md` testing section has the full rule set. `sleep_for` remains right
  in a mock handler that paces its own answer, and as the poll interval
  inside a deadline loop.
- **A fixture that opens a scratch `Database` cleans up with
  `vayu::tests::remove_database_files`** (`engine/tests/temp_database.hpp`),
  never a hand-written suffix list: an opened database writes six files (#413).
- **A startup repair pass is scoped, transactional, marked done, and backed up
  first** (#1487, `Database::strip_stored_managed_headers`, the repair section
  of `docs/engine/db-schema.md`). `/health` does not answer until `init ()`
  returns, so a pass that loads every row is a startup hang on a large
  workspace: select candidates with a SQL predicate, rewrite them inside one
  `transaction_guard` (the `seed_default_config` shape), record a done marker
  so the next start skips the scan, and save a `backups/` snapshot through
  `snapshot_before_rewrite` immediately before the first rewrite, skipping the
  pass with its marker unset when the copy cannot be written (#2426). A schema
  bump takes the same copy (`backups/vayu-<stamp>-pre-v<N>.db`) in
  `migrate_before_sync` and refuses to migrate without it. `<db>.bak` is not
  that copy: the same start refreshes it, once it listens, from a file the
  repair has already rewritten, and a clean shutdown refreshes it again
  (`refresh_recovery_backup_on_shutdown`, #2421).
- **Removing a column from a `make_table` mapping is `ALTER TABLE DROP COLUMN`
  at the constructor's probe `sync_schema ()`** (sqlite_orm on SQLite 3.35 or
  later; the bundled one is 3.53), which runs before `init ()` and therefore
  before any repair pass can read the column. Read the data out in a step
  that runs ahead of the probe - a `PRAGMA user_version`-gated migration - or
  keep the column mapped; a pass that runs after the probe reads a column
  that is already gone. `migrate_before_sync` (`db_maintenance.cpp`, declared
  in `database_impl.hpp` for `database.cpp`'s constructor to call across the
  translation-unit boundary, #1514) is that migration, called as the
  constructor's very first, unguarded statement so the exception it can throw
  (see below) propagates rather than being caught by the recovery path meant
  for corruption: open raw sqlite3, read `PRAGMA user_version`, refuse to
  start on a version newer
  than this engine's `SCHEMA_VERSION` (a newer database is not corrupt and
  must never be quarantined), and on an older or fresh one fold any row whose
  `pre_request_script` / `post_request_script` is non-blank and not already
  represented in `elements` into a `script.pre` / `script.post` entry, all
  inside one transaction, before `sync_schema ()` ever runs and drops the two
  columns. #1513 kept the columns mapped and folded them additively instead
  (`fold_scripts_into_elements`, since retired) because nothing ran a
  `script.*` element before #1514's pipeline existed; now that it does, the
  two columns are dead data and this is the real cut-over the #1513 comment
  above once deferred.
- **Only a corrupt database reaches recovery** (#2420). `probe_database`
  answers a `ProbeResult` (`vayu/db/recovery.hpp`), and
  `classify_probe_failure` is the one place a failure is sorted: `SQLITE_CORRUPT`
  and `SQLITE_NOTADB` in sqlite_orm's SQLite error category are corrupt, and
  anything else (a lock, a full disk, a read-only directory, a filesystem
  error, a failed migration step) is unavailable, which the constructor throws
  as `unavailable_database_message` with every file untouched - a `.bak` that
  cannot be examined stops `recover_database` the same way. Every connection
  the constructor opens carries its busy timeout before its first statement:
  `open_workspace_connection` takes one, and `Impl` sets it first in `on_open`
  and calls `open_forever ()` before its pragmas, because sqlite_orm re-applies a
  remembered `journal_mode` to a new connection ahead of `on_open`. The
  timeout is `BUSY_TIMEOUT_MS`; `Database (path, startup_busy_timeout)` lowers
  it for a test and `applied_busy_timeout_ms ()` reads it back. `daemon.cpp`
  releases the instance lock through an `InstanceLock` declared before the
  `Database`, so the database closes first (`platform_test.cpp` scans for it).
- **Any change to `make_vayu_storage`'s mapping bumps `SCHEMA_VERSION`**
  (`vayu/db/database.hpp`, #1492), an added nullable column included:
  `sync_schema ()` runs without `preserve`, so an older engine would rebuild
  a table without the column it does not map. The bump is one-way - an older
  engine refuses the stamped workspace - so it gets a row in
  `docs/engine/db-schema.md#schema-versions` and a line in the next release's
  notes. A migration step that rewrites stored data once and that an older
  engine must not read past bumps it too, with no mapping change (version 4,
  the file-trust restatement). `migrate_before_sync` stamps through
  `stamp_schema_version`, never a literal; a step with nothing to move (version 2's
  `request_examples.postman_response` and #1765's four `requests` protocol
  columns) only stamps. A column may join a version no released build has
  stamped (#1765 joined 2, #1817's `runs.origin` joined 5) because
  `sync_schema ()` adds it on every start
  whatever the stamp; `docs/engine/db-schema.md#schema-versions` carries the
  merge gate that checks the last tag first.
- **A log call takes a category, never text alone** (#1557, full account in
  `docs/engine/logging.md`). `LogRecord{level, cat, msg, fields}` is the whole
  API - `log_debug`/`log_info`/`log_warning`/`log_error` (`utils/logger.hpp`)
  are its only callers and `Logger::write` is the one place a record is
  rendered; there is no message-only overload to fall back to, so a category
  is never optional. `cat` is one lowercase token from a closed per-source
  list (`startup`, `config`, `http`, `db`, `run`, `script`, `inbox`, `mock`,
  `oauth`, `client`, `shutdown`, plus `cli` for `vayu-cli`);
  `tests/log_category_scan_test.cpp` source-scans `engine/src` and fails the
  build on a call with no category literal or one outside the list. A field
  named from the secret set (`token`, `password`, `client_secret`, an
  `Authorization`/`Cookie`-shaped header name, ...) is redacted to
  `<redacted>` and a field whose name ends `url`/`Url` is stripped to
  scheme/host/path, both in `Logger::write` before either sink sees the
  record (`utils/log_redact.hpp`) - a caller never redacts its own fields.
  `msg` is never redacted, so text a user's script authored (a thrown message)
  is a field, bounded through `vayu::utils::bounded_log_text`
  (`utils/log_text.hpp`, 512 bytes, #2359), and never part of `msg`.
  The file sink writes one JSON line per record (validated in tests against
  `docs/engine/log-record.schema.json`); the console renders the same record
  as text. `vayu::utils::Logger` keeps its console verbosity (`-v 0|1|2`:
  warnings and errors, info, debug) and its separate file level (`logLevel`,
  default info - `Logger::default_file_level` derives the logger's own from
  `constants::logging::DEFAULT_LEVEL`, so the two cannot disagree - with
  rotation under `maxLogFileBytes`); `Logger::init`'s
  `source` parameter (`"engine"` or `"cli"`) sets both the record's `src`
  field and the file name prefix (`engine_<stamp>.log`, `cli_<stamp>.log`),
  so the two binaries' files sort apart under one directory.
- **One request line per HTTP call, from one place** (#1510).
  `vayu::http::install_request_logger` (`http/request_log.hpp`) wires a
  `set_pre_routing_handler` timestamp and a `set_logger` hook onto both
  `httplib::Server` instances the engine owns (the management API in
  `Server::setup_routes`, the inbox listener in `routes/inbox.cpp`) so every
  call gets one `cat: "http"` record whose `msg` is `"GET /inbox 200 1.3ms
  412B"` and whose fields carry `method`/`path`/`status`/`ms`/`bytes` -
  never the query string, headers or body - at the level its status calls
  for: 2xx at DEBUG, 3xx/4xx at INFO, 5xx at WARNING. A hand-written
  per-route line is now only for what that hook cannot know (a run starting
  or stopping, a count a handler computed); `tests/request_log_test.cpp`'s
  source scan fails if a route file brings the old per-route "METHOD /path"
  shape back. The daemon's legacy `bool verbose` (threaded through `Server`,
  `RouteContext`, `execute_exchange` and every load-run worker function down
  to `client.cpp`'s curl transfer-debug frames) is retired in the same issue:
  everything that gated on it now reads `Logger::instance ()` directly - an
  unconditional DEBUG line for what used to be "log the tallies if verbose",
  `get_verbosity () >= 2` for the curl frames, which land as one `cat:
  "client"` record per transfer (`lines[]`, each redacted) rather than one
  line per frame. The per-run JSON `"verbose"` key (`run_manager.cpp`'s
  `configure_event_loop`, a caller opting one load run into curl debug frames
  on the event-loop path) is a different switch and is untouched.
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
  The same environment ships `/opt/vcpkg-overlay-ports`, pinned to the
  manifest's current versions, so a checkout at an older tag (a migration or
  upgrade sweep) wants older ports: copy the overlay and run
  `VAYU_ENGINE_DIR=<checkout>/engine VCPKG_OVERLAY_PORTS=<copy> vcpkg-fix-port
  <ports>`, then `touch engine/vcpkg.json` so ninja re-runs the configure.
- **The git hooks install themselves** with `python build.py --setup`, which
  `.claude/hooks/session-start.sh` also runs - `.git/hooks` is not tracked, so
  every clone and every cloud session would otherwise start without the
  pre-commit hook (clang-format) and the pre-push hook (clang-tidy). `bash
  scripts/install-git-hooks.sh` still installs them directly, which is what a
  Windows checkout needs: `--setup` refuses to run there.

## Formatting and linting

- **clang-format 22 exactly** (`.clang-format` at repo root; the pin exists
  because another major formats a measured share of the sources differently). A
  patch-level difference inside a major can still matter (one 19.1.x pair
  disagreed about three continuation lines in the QuickJS glue under
  `src/runtime/`), so
  after `clang-format -i` read `git diff` for reindentation you did not intend
  and put it back: the
  tree as committed is what CI's binary accepts. `Engine formatting` in
  `pr-tests.yml` runs `--dry-run -Werror` over the whole of
  `engine/{src,include,tests}` (#886) and `scripts/pre-commit` runs the same
  check over what a commit stages (#908), skipping loudly without a
  clang-format 22 rather than answering from another major. The config's two
  odd-looking settings (`ColumnLimit: 80` with `PenaltyExcessCharacter: 1`,
  `ContinuationIndentWidth: 0`) are what the code is written to; both are
  commented in the file, and a "tidier" value costs a five-figure-line rewrite.
  `engine/vendor/` sets `DisableFormat: true`. Includes are sorted, with one
  pinned exemption: the `<windows.h>` / `<timeapi.h>` pair in
  `src/platform/high_resolution_timer.cpp`, wrapped in `// clang-format off`
  because `timeapi.h` needs `windows.h`'s types and sorts first. A second such
  case is pinned at the site the same way, never by turning the sorter off.
- **clang-tidy 22, the LLVM project's build** (`.clang-tidy` in `engine/`,
  `engine/src/runtime/`, `engine/tests/`). CI installs it on both legs with
  `scripts/install-clang-tidy.sh` (apt.llvm.org on Linux, the attested LLVM
  release installer on Windows), and the pre-push hook takes 22 as its floor;
  before 19 the root config's `ExcludeHeaderFilterRegex` is rejected outright.
  The pre-push hook finds it as `clang-tidy-22` or
  plain `clang-tidy` through the same `find_llvm_tool`
  (`scripts/lib/llvm-tools.sh`) the pre-commit formatter uses (`exact` there,
  `minimum` here), because apt splits the names and Homebrew does not (#918).
  It runs at push, not commit, because whole-file clang-tidy costs 20-90s a
  file: it lints every C++ file in the commits no remote-tracking ref reaches. **A finding is a failure** (#885): `WarningsAsErrors: '*'` in
  `engine/.clang-tidy`, and both consumers read the exit status. The pre-push
  hook refuses the push; the `Lint changed engine sources` step in
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
  the pre-push hook, which lints a pushed header against the local build tree,
  and on
  `.github/workflows/engine-tidy-scan.yml`, the weekly whole-tree scan on both
  legs (plus `workflow_dispatch`) and the only thing that reads a header. The
  scan's report fails when it parses no finding out of a log that holds
  diagnostic-shaped lines, so a zero is reported only where a zero was measured.
  Nothing lints at build time; the `CMAKE_CXX_CLANG_TIDY` block went with #885.
  See `docs/engine/building.md`.

## HTTP API

The daemon listens on `http://127.0.0.1:9876` and serves no browser: it sends
no CORS header, and the request gate in `server.cpp` refuses any `Origin` and
any `Host` that is not a loopback name for its own port, before routing
(`docs/engine/api-reference.md`, "Who may call the API"). The Electron shell
strips the renderer's `Origin` and supplies its CORS headers.

**A `GET` route must never have a side effect, because any web page can make
the engine run one.** A scriptless `GET` (`<img>`, a `no-cors` `fetch`, a
top-level navigation) carries a loopback `Host` and no `Origin`, so the gate
admits it; what keeps it harmless is that the page cannot read the opaque
answer and that the route changes nothing. Anything that writes, starts,
stops, deletes or sends is a `POST`, `PUT` or `DELETE`, which a page can only
send with an `Origin`. An SSE route's single-reader claim (`/runs/:id/events`,
`/inbox/:id/live`) lasts as long as the connection reading it and needs an id
a page cannot know. The gate is deliberately not widened to `Sec-Fetch-Mode`.

Key endpoints:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/compose` | Resolve `{{vars}}` + `inherit` auth; returns an execute-ready payload (sends nothing); names a pre-request script may change stay `{{name}}` and are listed in `deferredVariables` (#2521) |
| POST | `/execute` | Send a single request (auth resolved engine-side); optional `targetPolicy` holds the final URL and OAuth 2.0 token endpoints to the caller's hosts (#2521) |
| POST | `/runs` | Start a load test run; optional `targetPolicy` as on `/execute` (#2521) |
| GET | `/runs/:runId/live` | SSE stream of live metrics |
| GET | `/runs/:runId/events` | SSE relay of a streaming request's events (`POST /execute` with `stream: true`) |
| GET | `/runs/:runId/metrics` | Historical time-series (JSON) for a run; `maxPoints` folds it server-side |
| GET | `/runs/:runId/monitor` | The server-vitals samples scraped during the run (#2611), same envelope; `maxPoints` folds it server-side too, each series to its bucket max (`MonitorSampleBucket`) |
| DELETE | `/runs` | Clear run history (#2429): every run except pinned baselines and runs still `running`/`pending`, through retention's batched pass (`Database::clear_runs`); answers `{deleted, keptPinned, deletedIds}`. `DELETE /runs/:runId` still deletes whatever it names, pinned or not |
| POST | `/oauth2/token` | Acquire/return a cached OAuth 2.0 token (auth resolved engine-side) |
| GET | `/health` | Health check |
| GET | `/request-defaults` | What the engine adds to a request that names none of it (#1229): the `User-Agent`, negotiated `Accept-Encoding`, an opt-in correlation id and, when `sendExpectContinue` is on, the `Expect: 100-continue` libcurl may add above 1 MiB (#2468), so a client renders them instead of re-deriving them. `?scope=design\|load` (default `design`, anything else a `400`) names which send is being described, because a load run resolves compression from its own key (#1338) |
| POST | `/workspace/backup` | One `VACUUM INTO` snapshot of the workspace into `backups/` beside the database, with retention (#987); no restore endpoint, see `docs/engine/architecture.md` |
| GET | `/trash` | What deleting a collection, request, environment, user-saved example or client certificate left recoverable (#988, environments #2970, examples #2971, certificates #2973): roots only, each with what its cascade took (an environment entry alone carries `variables`, its count; an example's `parentId` is its request, and it is a root only while that request is live; a `clientCertificate` is named `host` or `host:port`, and a trashed one is in no transport policy); `POST /trash/:id/restore` puts one back (an environment inactive; an example `409`s under a trashed or missing request or a full one; a certificate `409`s while a live entry holds its target), `DELETE /trash/:id` destroys it, `trashRetentionDays` purges the rest at startup |
| POST | `/import/parse` | Read a raw import document (OpenAPI 2.0/3.x, Postman v2.0/v2.1, a Postman environment or globals export, Insomnia v4, an Insomnia v5 collection or environment, a JMeter test plan) into the tree `/import/apply` persists (#877); reads only |
| POST | `/import` | The same parse, flattened and applied in one call; what MCP `import_document` wraps. The app parses and applies separately because a person previews in between |
| POST | `/import/document` | A document's bytes as a JSON DOM through the engine's one reader; what the app's `$ref` bundler needs |
| POST | `/import/apply` | Persist a whole parsed import atomically; returns a temp-id -> real-id map |
| POST | `/diagnostics/connection` | One policy-honouring send, reported as which hop answered (#708); outcome only, never a body |
| GET | `/requests/:id/examples` | A request's saved example responses (#481), in stored order |
| POST | `/specs` | Store an OpenAPI document (#637) and derive its operation index (#853); `GET`/`DELETE /specs/:id` read and remove it, `GET /specs/:id/meta` describes it without sending it (#712) |
| POST | `/specs/sync` | Apply a re-fetched document to the collection bound to it (#655): new document, moved binding and the created/updated/deleted requests in one transaction |
| POST | `/specs/describe` | What a picked document is: dialect, title, declared operations (#869) and every server's base path (`basePaths`, #3030); reads only |
| POST | `/specs/match` | Which request of a collection's subtree is which operation of a document (#761); reads only |
| POST | `/specs/diff` | What a re-fetched document would change about the collection bound to it (#854); reads only, applying is `POST /specs/sync` |
| POST | `/specs/bind` | Bind a collection to a document (#862): the document, the binding and every stamp, written **and cleared**, in one transaction |
| POST | `/specs/export` | A collection back out as an OpenAPI document (#855): its bound document patched, or a skeleton when it binds none; reads only |
| POST | `/export/postman` | A collection's subtree as a Postman Collection v2.1.0 document in the shape Postman's own export writes (`core/postman_export.hpp`, the Postman importer's inverse); credentials blanked unless `includeSecrets` (auth blocks, sensitive header and query-parameter rows, the URL, and a saved example's recorded request, headers and cookie values; bodies are never judged), everything the format cannot carry listed in `notes.notCarried`; reads only |
| POST | `/export/postman-environment` | One environment as a Postman environment export (`export_postman_environment` in `core/postman_export.hpp`, the Postman environment importer's inverse, #2253): `{id, name, values: [{key, value, type, enabled}], _postman_variable_scope}` in stored key order; a secret's value is blanked unless `includeSecrets` (counted in `notes.secretsOmitted`, the row still typed `secret`), `json`-typed variables are written as `default` and listed in `notes.notCarried`; reads only |
| POST | `/export/run-report` | A finished load run as a shareable document (`core/run_export.hpp`, #2127), schema `docs/engine/run-export.schema.json`: built by **allowlist** from the report and the run's snapshot, so a field the report gains is absent until added on purpose; no results, traces or samples, header and parameter names without values, the body as `{mode, bytes}`, the URL through `redact_url_credentials`, script and response text as counts. `baseRunId` adds a `comparison` from `core/run_compare.hpp`, the third copy of the app's `compareReports`, pinned to the other two by `tests/fixtures/run-compare-conformance.json`. Formats are the one `RUN_EXPORT_FORMATS` table (`json`, `markdown` and `html`: the two text renderers are pure functions of the document pinned by goldens under `tests/fixtures/run-export/`, read through one `core/run_export_view.hpp` so their sections cannot drift, #2131; `core/run_export_html.hpp`, #2135, is one script-free, load-nothing page whose three charts are `src/core/svg_chart.cpp` inline SVG, thinned to 480 points with a min/max envelope, and which reads the whole series whatever `series` asks), and `tests/fixtures/run-export-formats.json` lists the rows that can write, which the app's registry (`src/lib/run-export-formats.ts`) and the MCP server's list read too (#2139); 404 missing run or base, 400 `unsupported_run_type`, 409 `run_in_progress`; reads only |
| POST | `/collections`, `/requests`, `/environments`, `/requests/:id/examples` | **Create only**: 409 on an existing id |
| PUT | `/collections/:id`, `/requests/:id`, `/environments/:id`, `/requests/:id/examples/:exampleId` | **Update only** (merge-patch): 404 on a missing id |

The pre-consolidation paths (`POST /request`, `POST /run`, `/run/:id...`,
`GET /metrics/live/:runId`, `GET /stats/:runId`) are removed and answer `404`;
`docs/engine/api-reference.md` (Removed route aliases) maps each to its
replacement. An unresolved
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
  `app/src/services/api.ts`; add fields there, never per handler. The one
  deliberate exception is an example's `savedFrom`, read by the create handler
  after `apply_request_example_fields`: it describes a live send, so it is
  create-only and `POST /import/apply` must not take it. **The engine
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
- **A route's `catch (const std::exception&)` answers through `send_exception`,
  never `send_error (res, 400, e.what ())`** (#2423, `routes.hpp`). A SQLite
  failure is not the request's fault: `vayu::db::classify_storage_error`
  (`db/database.hpp`, beside `classify_probe_failure`) reads sqlite_orm's
  `std::system_error` - the category check is required, because an errno shares
  its numbers - and `send_exception` answers `SQLITE_FULL` with `507
  insufficient_storage`, `SQLITE_BUSY` / `SQLITE_LOCKED` with `503 unavailable`
  plus `Retry-After: 1`, any other SQLite code with `500`, and everything else
  (a JSON parse error, a validation throw) with the `400` it always had. The
  body never quotes SQLite. Only a read-only or compute route (`spec_match`,
  `spec_export`, `spec_diff`, `spec_describe`, `postman_export`) may keep the
  bare `400`; `SendExceptionGuard` in `tests/storage_error_test.cpp` scans
  `src/http/routes` for the rest. No test drives a real `SQLITE_FULL` through a
  handler - `Database` has no pragma seam to fill a scratch database - so the
  handlers are held by that scan plus the unit tests of the two functions.
- **A core that reads, decides and writes holds one lock** (#386, #1440,
  #1453, #1454, #1455, #1878, #1906). `Database::with_lock` scopes the mutex around
  the whole composite; a merge-patch is `update_<resource>_locked` called inside
  it, with a `before_write` seam that `tests/competing_writer.hpp` uses to
  drive a second writer into the window. The manager-backed resources (an
  inbox's reply, a mock issuer) hold their own mutex across merge and write
  the same way. A PUT that reads under one acquisition and writes under
  another loses the other writer's fields with no error on either side.
  `docs/engine/architecture.md` names the shapes that need it.
- **A behaviour attached to a request or collection at a phase of a step is
  an element kind, not a column** (#1512): extractors, assertions, timers,
  controllers, scripts and metrics each register once under
  `engine/src/core/elements/`, are validated against that registry, served by
  `GET /elements/kinds`, and run by `vayu::core::ElementPipeline`. #1513
  landed the registry and the `elements` column; #1514 landed the phase-0
  kinds (`extract.*`, `assert.*`, `timer.think`, `script.*`) and the
  pipeline itself, cutting `pre_request_script` / `post_request_script` over
  for good - the two columns are gone (`Database::migrate_before_sync`
  folds a pre-cutover row's scripts into `elements` first), and
  `preRequestScript` / `postRequestScript` / `tests` are refused wherever
  `elements` is now the only script source. #1515 landed the controller
  family (`control.if`, `.once`, `.switch`, `.throughput`, `.loop`,
  `.transaction`) - JMeter-parity logic controllers that decide whether a
  step sends at all, jump to a named member, or sum a folder's members into
  a named transaction with its own percentiles. #1569 gave `control.switch`
  and `control.loop` their own jump/repeat mechanism on the load path too
  (`ScenarioLoadState::step_index`, `VirtualUser::steps_this_iteration`,
  `finish_step`'s own `resolve_next_step` call), the same
  `maxStepsPerIteration` cycle guard the sequential run uses; `perUser:
  false` on `control.throughput` shares one atomic budget across every
  virtual user (`SharedThroughputCounters`, allocated up front from a plan
  scan, no lock) instead of one per VU, and `control.transaction`'s
  `includeTimers` folds a between-member `timer.*` wait into the sum
  (`fold_between_wait_into_open_transactions`, shared by both run modes,
  found through the registry's `category` rather than a `kind ==`
  comparison). The pipeline runs in the design send, the sequential (single-VU)
  collection run, and - since #1495 - a scenario **load** run's own
  producer/completion hooks
  (`scenario_load.cpp`'s `run_step_before` / `run_step_after`): a declarative
  kind always runs there, and a `script.*` kind runs there only when its own
  `config.inline` is set or the run's `elements.scripts` override forces it,
  read through `HotPathClass` rather than a `kind ==` comparison. An
  un-inlined script stays exactly where it always was, on the deferred
  `tests` replay, which now skips a step whose script already ran inline
  (`RunContext::script_element_runs_inline`, the one place that decision is
  made, shared by both sides). Since #1498, `step.between` also dispatches on
  the load path: `ScenarioLoadDriver::finish_step` (`scenario_load.cpp`) calls
  the new `run_step_between` on the step that just completed, non-blocking
  (`ElementContext::blocking_allowed = false`), and sums the outcomes'
  `waited_ms` into `VirtualUser::ready_at_ms`. `timer.pacing` is a
  `tracks_scope_occurrence` kind (`ElementKind::tracks_scope_occurrence`,
  read through the registry, never a `kind ==` comparison): the same
  folder- or collection-scoped element is inherited into every request under
  its scope, so `scenario_plan.cpp`'s `mark_scope_entries` walks a resolved
  plan's whole iteration and stamps `config._scopeEntry` on only the first
  occurrence of that element's id, leaving every later occurrence a no-op.
  Since #1594, a **single-request** load run (`load_strategy.cpp`) runs
  step-level elements too, through its own array on `POST /runs`,
  `requestElements` - a distinct key from that endpoint's own `elements`
  (the run-level `timers`/`scripts` override, above), because a flat
  single-target payload has no `request` sub-object to nest a request-shaped
  `elements` array under the way a stored request's own column does.
  `run_request_elements_step_before` / `_after_submission` run
  `Phase::StepBefore` / `Phase::StepAfter` per submission, the same
  inline-vs-deferred `script.*` dispatch the scenario path uses
  (`RunContext::script_element_runs_inline`); every un-inlined `script.post`
  folds into the run's own completion replay (`RunContext::test_script`,
  joined with a blank line in compile order, not only the first one - the
  same join `read_script` always did before this run shape had elements).
  Only the phase-0 kinds #1514 gave the design send run here at all -
  `validate_request_elements_run_override` refuses a `control.*` kind,
  `timer.pacing` and `timer.throughput` by name, because none of the state
  they need (`controller_state`, `pacing_state`, a plan-wide throughput
  scan) exists on this path; admitting one would report `"ok"` for behaviour
  that never ran rather than failing loudly. There is no persistent virtual
  user on this path, so the `ScopeOverlay` lives on
  the submission rather than a VU - built fresh from the run's flattened base
  scopes (`RunContext::step_base_vars`) and discarded once that submission
  settles - and `timer.think`'s wait is a run-level concurrency reservation
  (`RunContext::reserve_think_wait`, folded into `in_flight()`) rather than a
  per-VU `ready_at_ms`, since there is no VU to hold one on. It also has its
  own place to declare `script.setup` / `script.teardown` - the run-boundary
  kinds, not a step's - through `POST /runs`'s `lifecycleElements` array
  (#1573), dispatched by the same `run_collection_setup` /
  `run_collection_teardown` a collection-backed run uses; a script written
  there resolves into the run's own submissions only when `requestElements`
  is also declared (the residual pass on this path reads
  `RunContext::step_base_vars`, populated whenever `step_elements` is
  non-empty, not merely because `lifecycleElements` is) - otherwise it can
  only reach the network itself (`pm.sendRequest`) and gate or report on the
  run. Do not add another behaviour column beside `elements`; a new behaviour
  is an element kind. A kind's labels are in its schema (#1607): every
  `config_schema` property carries `title` and `description`, so a generated
  form has words to render instead of falling back to a raw property name -
  #1608 is what wires the app's own form to read them.
- **Saved examples are nested under their request** (`/requests/:id/examples`,
  #481): the owner is checked before the example on every path, so an example
  reached through the wrong request is a `404`, and `delete_request` and the
  collection cascade take the examples with them. Ordering is a contract: the
  list comes back by `order`, then `created_at`, then `id`, and
  `POST /import/apply` writes them nested on the request item through the same
  `apply_request_example_fields` applier. Since #481 phase 3, a request's own
  `mock_response_mode` (`"first"` / `"fixed"` / `"random"`, validated the same
  way `methodSource` is) decides which one a mock server answers with,
  `mock_example_id` names the target for `"fixed"`, and each running mock also
  keeps a bounded `MockActivityLog` of every request it served or missed, read
  back through `GET /mock/:id/activity` (newest first, capped at
  `MAX_ACTIVITY_ENTRIES`) - like the route table, it holds nothing that
  outlives the listener and is discarded on stop. Every row records an
  **`origin`** (#588), `import` or `user`, defaulting to
  `import` and `400` on anything else, so the spec sync can replace the first
  kind without touching the second. **Deleting an imported example keeps the
  row as a tombstone** (`suppressed`, #722), because the sync rewrites a
  request's imported rows on any applied change; every read filters tombstones
  out (`get_request_examples`, `get_request_example`) and
  `get_suppressed_request_examples` is the single read that sees them, matching
  on response **status**, which survives a reworded description. **Deleting a
  user's example moves it to the Trash** (`deleted_at`, #2971) instead: the
  same reads filter the stamp, and the trash lists, restores and purges it.
  An example imported from Postman keeps the saved response it came from in
  **`postman_response`** (schema version 2): the entry as JSON text in source
  member order, `name`/`body` as `null` placeholders. An import writes it, and
  so does an app save that sends `savedFrom` (the request as written at Send,
  built into the same shape by `postman_saved_response_text`); a string on
  create, `null` - clear - the only value `PUT` takes; no read
  route returns it, and `POST /export/postman` is its one reader: members
  describing `status` or `headers` are written back only while those columns
  still say what was imported, so an edit is never contradicted by the stored
  copy; `originalRequest` is always kept (its `auth`, headers and URL blanked
  without `includeSecrets`, and the `header[]` and `cookie[]` it writes back
  likewise, `vayu_ext::blank_*`).
- **`GET /requests/:id` is a single-request lookup.** `useRequestQuery` uses it
  to load a restored request tab or a design-run copy on cold start. A `404`
  means the request was genuinely deleted; anything else is a transport failure,
  and callers (`DesignRunView`) keep those apart: only a real 404 becomes
  `RequestNotFoundError`. `GET /requests?collectionId=` lists a collection's;
  `?fields=summary` answers only the columns a tree is built from (#2546).
  `q` / `limit` / `offset` page it, and `GET /collections`, `/trash` and
  `/cookies`, in the `GET /runs` envelope (#2443, `http/list_page.hpp`, the one
  parser and envelope); a call naming none of the three gets the legacy answer
  byte for byte, so add a list route's paging there, never per route.
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
- **A transfer a management-API handler makes carries
  `RouteContext::server_stopping`** (#2683) as `ClientConfig::cancel`, through
  `ExchangeInputs::cancel`, `acquire_token`'s `cancel` or the route core's own
  parameter, and an SSE relay loop ends on it. `Server::stop()` sets it, then
  joins every handler and never detaches one, because the daemon destroys
  curl's global state and the database right after; a send that does not carry
  it holds shutdown open for its whole timeout.
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
    and every placeholder (`{{petId}}`, a request's `:petId`, `{petId}`)
    flattened to `{}`. A third pass (#3030) retries what the first two left
    open with each of the document's base paths taken off the request's
    front, whole segments only, judged by the same ambiguity rule across all
    of them. Ambiguity
    is refused in both directions, because the sync applies changes *by*
    identity. It parses no OpenAPI: the caller hands it the identities and the
    base paths, which since #869 come from **`POST /specs/describe`** (dialect,
    `info.title`, declared operations, `core::base_paths_of`: every 3.x server
    rather than the importer's `servers[0]`, or the 2.0 `basePath`; a readable
    file that is not a contract is a `400`).
    `tests/fixtures/operation-shape-conformance.json` is this side's own table.
  - **`POST /specs/bind`** (#862) takes a document and a collection, never a
    pairing: it reads the document, derives the indexes, matches the subtree
    with the same `core::match_operations` over the same
    `collection_subtree_requests` walk `/specs/match` previews with (base
    paths from the same read of the document, through `read_spec_indexes`'
    `document_out`), and
    commits document, binding and every stamp through `spec_sync_apply` with
    the create and delete halves empty. Both halves of stamping are that one
    walk: a matched request is stamped and a stamped request that matched
    nothing is *cleared* (#718), never a list the caller states. Unbinding is
    `PUT /collections/:id` with `openapi: null`: one row, stamps untouched.
  - **`POST /specs/export`** (#855, `core/openapi_export.hpp`) writes a
    collection back out. A bound collection's stored bytes are *patched*
    (unclaimed operations removed, request values and stored examples written
    in, every member Vayu does not model carried through unvisited); an unbound
    collection gets a skeleton that invents nothing but, since #1441, carries
    what OpenAPI can name - folders as `tags`, auth as `securitySchemes` and
    `security`, a `{{baseUrl}}` with a known value as a declared server
    variable default, a row's toggle as `x-vayu-enabled`, a request's or the
    collection's own `elements` (scripts included) as `x-vayu-elements`
    (#1518, read back by the importer and validated against the registry
    before it reaches a stored request), a request's `mock_response_mode` as
    `x-vayu-mock` (#1649, its `"fixed"` target named by the `examples` map key
    it resolves to rather than an id nothing has minted yet), and everything
    else the UI holds in `x-vayu-request` (per operation) and
    `x-vayu-collection` (root: variables, auth, data contract, the folder tree,
    requests no operation can hold) - `core/vayu_extensions.hpp`, one module
    for both directions, which blanks every secret on the way out (counted as
    `secretsOmitted`; a pure `{{var}}` reference is kept) and checks every
    piece on the way in (`vayu_extension_invalid`, never a refused import).
    Secrets are blanked outside auth blocks too (#1804, no `includeSecrets`
    here): `export_openapi` first copies each request with its credential header
    and Params rows emptied and flagged `withheld` (`withhold_credentials`, so
    every standard member reads safe rows and a new writer cannot forget),
    `x-vayu-request` blanks and counts its stored rows, URL and saved-response
    headers, a server origin and a `baseUrl` variable lose a URL password, and a
    credential written as both an `x-vayu-request` value and a parameter
    `example` counts once (a `contract` export, with no `x-vayu-request`, counts
    it at the declared parameter it declined to fill). Bodies are never judged.
    An `inherit` request's `security` is resolved through its folders by
    `resolve_inherited_auth`, the rule `POST /compose` uses. A bound export's
    `mode` is the user's choice: `contract` (default) patches as above,
    `full` writes every edit into the document's own dialect, 2.0 included
    (`BoundMode`), and an unedited `full` export changes no standard member.
    The subtree walk stops at a collection bound to a *different* document
    and not at one bound to the same (#721), as a predicate on
    `collection_subtree_ids`. YAML output is
    `core::emit_yaml`, beside the reader on purpose: `plain_scalar` decides
    quoting, and split across two files a document would export as
    `swagger: 2.0` and re-import as a number.
  - **Responses are validated against what the document declares** (#628):
    `spec_documents.response_schemas` holds an engine-derived index and
    `core/schema_validation.cpp` matches a response by status pattern and media
    type and validates with **valijson**. Three rules the shape enforces: an
    unbound collection gets no `validation` node at all; `checked: false`
    carries a reason code and no validity; keywords the draft-07 validator
    cannot evaluate are named and counted on the verdict. `format` is
    asserted for valijson's four (`date`, `time`, `date-time`, `ipv4`) and for
    `email`, `uri`, `uuid`, `hostname` and `ipv6` through the
    `schema_format.hpp` table (#2581): valijson has no format hook, so
    `run_validator` adds a custom constraint under the same `format` key, and a
    name in neither place stays an annotation. A name added to the table must
    not be one valijson checks, or each failure is counted twice. `POST /execute`
    returns the node and `record_design_result` stores the *same object* on the
    trace. `match_status_pattern` is shared with coverage, over the same
    statuses: the index lists every declared status, a schema-less one as a
    status-only row (#3028), which answers `no_schema_for_status` instead of
    letting `default` or `4XX` judge it. Under load the check
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
  environment and globals exports and Insomnia v4 are nlohmann. Insomnia v5
  (#2119, `type: collection.insomnia.rest/5.x` or `environment.`, YAML) has
  no mapping of its own: `InsomniaV5Flattener` rewrites its nested tree into
  v4's flat resource list and `parse_insomnia_resources` reads that, so a
  rule fixed for one version is fixed for both; any other `*.insomnia.rest/`
  type (a design document, a mock server) is refused by name, never as
  unrecognised. Detection order is the renderer's old order, v5 after v4.
  `tests/fixtures/import-conformance.json` records what the renderer's retired
  parsers produced for its original corpus (cases added since are recorded
  from the engine, see its `$comment`) and `import_parse_test.cpp` asserts
  this side matches, two normalisations aside.
  A JMeter `.jmx` test plan (#1518, `core/jmeter_import.hpp`, pugixml - the
  one XML dependency in one translation unit) is the one format that cannot
  ride `core::read_document` at all: it is XML, checked on the raw text
  (`is_jmeter_document`) before that reader ever runs a document through it,
  since JSON and YAML would both fail on it the way genuinely unrecognised
  bytes do. Its class-to-element-kind mapping is counted by JMeter's own class
  name for anything unmapped, which is why `ImportTally::items()` falls back
  to emitting a kind outside its fixed order list rather than dropping it -
  the app's own closed `SkippedItem["kind"]` union (`types.ts`) is widened to
  accept one for the same reason. `POST /import` is the parse plus
  `core::import_apply_payload` plus
  `POST /import/apply`, **globals last and merged** because `POST /globals`
  replaces the whole set and must not run in front of a write that can still
  fail; the app's own flattening of a previewed result is pinned to it by
  `orchestrator.payload-conformance.test.ts`. A Postman parse's own
  `clientCertificates` array rides the same `import_apply_payload` pin (#1656,
  see the client-certificate bullet above) - the one section neither side's
  flattening invents a `tempId` for, since nothing else in the tree references
  one; the app sends only the candidates the user ticked. The renderer keeps
  `ref-bundler.ts` alone, exempt with a reason: inlining referenced files is
  fetch-time assembly through `POST /import/document`, reaching the network and
  disk through channels an engine should not have.
- **`followRedirects` / `maxRedirects` / `verifySSL` are per-request and
  stored** (Settings tab; `requests.follow_redirects` / `max_redirects` /
  `verify_ssl`, #706). Both clients send them on every execute and load test
  rather than eliding defaults, because the engine defaults to following and
  verifying: an omitted `false` would follow the 3xx the user asked to see, or
  verify the certificate they opted out for. A request's own `timeout`
  (`requests.timeout_ms`, nullable, #2937) is the deliberate exception:
  `payload_from_stored` emits it only when stated, because its absent default
  is the live `defaultTimeout` setting, resolved at send by
  `resolve_request_timeout_ms`, and a scenario step's own value wins over the
  run's. Postman's
  `disableCookies` / `disabledSystemHeaders` / `disableUrlEncoding` (#1765)
  follow the same rule on the same columns' pattern and parse onto
  `vayu::Request` in `read_request_options`: the jar is kept off the transfer
  where each driver decides whether one rides it (`execute_exchange`, the
  streaming branch of `execution.cpp`, `scenario_load.cpp`'s `submit_one`),
  the header names union into `suppressed_default_headers`, and the flag
  reaches `substitute_path_variables`' `encode`, `append_query_param` and the
  import's query join (`QueryEncoding::AsTyped`). The
  imported object itself is `requests.postman_protocol_behavior`, read only by
  the Postman export; it is the request's *own* object, while a folder's or the
  collection's (#2538) is resolved into these typed columns at import and kept
  nowhere.
- **What Vayu adds to a request nobody wrote it into is the engine's, and one
  set** (#1229, `include/vayu/http/default_headers.hpp`): a `User-Agent`, a
  negotiated `Accept-Encoding`, and an opt-in correlation id namespaced to
  `X-Vayu-Request-Id` and generated per *transfer*. `DefaultHeaderPolicy` is
  resolved from config at the top of a request or a run (the load scope reads
  its own compression key, because compression changes what a run measures) and
  applied in `build_request_header_list`, so every driver adds the same set. A
  header the request names always wins, `Request::suppressed_default_headers`
  refuses one per send (a stored `disabledSystemHeaders` joins it, and adds
  libcurl's removal line for `Accept` and a body's `Content-Type`, #1765; a
  refused name is checked with `invalid_header_token`, never the
  correlation-id rule; so is a name a request *carries*, after its surrounding
  spaces and tabs are trimmed, #2467 below), and none of what is added is
  stored - the renderer used to write
  `X-Vayu-Version` and a frozen `X-Request-ID` into the saved request, which a
  load run then replayed. `Accept-Encoding` is the one recorded without being
  appended: libcurl writes that line itself from `CURLOPT_ACCEPT_ENCODING`,
  which is what makes it decode. The engine never leaves libcurl a default to
  fill (#2464): `text` derives `text/plain`, and where nothing declares a
  Content-Type on a POSTFIELDS body or a bodyless POST the list carries
  libcurl's removal line. `Expect: 100-continue` (#2468) is the same shape
  inverted: libcurl adds it to an HTTP/1.1 body over 1 MiB and waits a second,
  so `build_request_header_list` appends the `Expect:` removal line unless
  `sendExpectContinue` (`DefaultHeaderPolicy::expect_continue`, one key for both
  scopes) is on or the request types a non-blank `Expect`. Add a default
  there, never in a driver. A
  load or collection run's `config_snapshot` records the resolved decision
  too (#1488, plus `expectContinue`, #2516, so a run that let libcurl wait on
  a 100-continue does not compare as identical to one that did not), for a
  later run's report to compare against - never re-applied
  to a send, the one deliberate exception to "none of it is stored".
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
  same way, empty included. The applier sets **both TLS legs** (#2469): the
  `CURLOPT_PROXY_*` twins of CAINFO, SSL_OPTIONS, SSL_VERIFYPEER and
  SSL_VERIFYHOST take the same values as the target's, because libcurl does not
  inherit them, so an `https://` proxy is verified against the same trust and
  the same `verifySSL`. Never a `CURLOPT_PROXY_SSLCERT`: the client-certificate
  registry holds identities for origins. `curl_to_error` words a refused proxy
  certificate as the proxy's (`CURLINFO_PROXY_SSL_VERIFYRESULT`), still
  `SslError`. The bundle is materialised from
  `customCaCertificates` beside the database and **extends** the platform's
  trust: on an OpenSSL build CAINFO is the whole store, so the file is the
  system anchors plus the user's. A proxy-hop failure is
  `ErrorCode::ProxyError`, distinct from the target's `ConnectionFailed`;
  `curl_to_error` takes the handle because only `CURLINFO_HTTP_CONNECTCODE`
  remembers a proxy's 407. The handle answers a second question (#802): an
  https transfer that failed for an unmapped code, or for one of the
  target-failed-the-exchange codes (`CURLE_RECV_ERROR` and its kin, otherwise
  `ConnectionFailed`; a redirect loop and an undecodable body are not among
  them, they are `TooManyRedirects` and `BadContentEncoding`, #2462), with no
  response line is an `SslError`, which is where every client-certificate
  refusal lands under TLS 1.3. The rule is the shape,
  never a list of codes, consulted only after every mapping more specific than
  "the target failed the exchange". An unresolvable target host is
  `DnsError`, never `ConnectionFailed`.
- **No transfer reaches Vayu's own ports** (#2355): `include/vayu/http/loopback_guard.hpp`
  is the one predicate (loopback in any spelling, on the engine port the
  daemon registers with the set-once `set_engine_port` before it listens, or on
  `MCP_PORT`). It runs twice per transfer: `validate_transferable` refuses a URL
  that names such a target, proxy or not, and `apply_transport_policy`'s
  `CURLOPT_PREREQFUNCTION` (its one set site) refuses the address a connection
  reached, which is what catches a redirect or a name resolving to loopback;
  `curl_to_error` reports that abort as the same `InvalidUrl` sentence. A new
  driver gets both by going through those two functions, never a check of
  its own. Tests share one registered stand-in (`tests/engine_port_stand_in.hpp`)
  because the registry is set once per process. A `$ref` fetch
  (`POST /import/fetch` with `reference`, #2364) adds `LocalPeerRule` from the
  same header on the same callback: `ClientConfig::local_peer_rule` reaches the
  applier as a `ConnectedPeerCheck`, which is `CURLOPT_PREREQDATA` (written on
  every call, null included, because handles are pooled) and records the
  refusal `curl_to_error` words. The applier also records `configured_proxy`
  on it, which the rule passes after the reserved ports have judged it (#2605);
  behind a proxy the reference's URL is what is judged, by
  `is_refused_reference_url` in `Client::send` before anything is dialled. A
  proxy from the environment is unknown to the engine and stays refused. A new
  address class goes into `loopback_guard.cpp`'s one classifier, never a second
  copy.
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
  defect back. **A Postman import is the one non-route writer of this registry**
  (#1656): `pm_certificate` (`core/import_document.cpp`) resolves a request's
  own `certificate` into a candidate at parse time using the same
  `client_cert_rejection` check the route runs, keyed on the request's own
  resolved host rather than `certificate.matches`; `POST /import/apply` then
  applies each candidate through `create_client_certificate_response` itself,
  reusing its lock and its write, best-effort and **after** the tree's own
  transaction commits, never inside it - taking that lock from inside
  `import_apply_response`'s own would deadlock. A candidate that route would
  refuse (an unreadable file, a `(host, port)` collision) is silently skipped,
  not surfaced as a `400`; see `docs/engine/api-reference.md`'s
  `POST /import/apply` section. The app sends only the candidates the user
  ticked, and each registration is logged at info (`host`, `port`, `certPath`;
  never the passphrase or the key).
- **A file a request body names is sent under one trust rule**
  (`http/file_ref.hpp`, `http/file_access_policy.hpp`): a `binary` body's
  `file` and a `form-data` file part are sendable iff `FileAccessPolicy::allows
  (src)`: `canonical(src)` lies under a `file_roots` folder (schema version 3,
  `/file-roots`, which refuses a filesystem root, the home folder and any
  folder containing it - `refused_root_reason`), compared component-wise so a
  symlink escaping a root is outside, or equals a `file_grants` row (schema
  version 6, #2356), the canonical path recorded when a person picked the
  file and never resolved again, so a link re-pointed after the pick is
  refused (`/file-grants`, `routes/file_grants.cpp`). **Both tables change only
  with the grant secret**: `POST`/`DELETE` on `/file-roots` and `/file-grants`
  call `admit_file_trust_write` (`routes.hpp`) first and answer `403`
  `grant_secret_required` unless `X-Vayu-Grant-Secret` matches the per-start
  `GrantSecret` (`http/grant_secret.hpp`: SHA-256 digests compared with
  `sodium_memcmp`, at least 32 characters). `daemon.cpp` takes it from
  `VAYU_GRANT_SECRET`, which the app's main process sets, and removes the
  variable before any thread starts; it reaches the routes through `Server`'s
  constructor and `RouteContext::grant_secret`, so a test hands one in without
  the environment. An engine with no
  secret refuses all four writes. **Trust is derived, never read**: a body's `unresolved` is ignored
  when a payload is parsed (an older client still sends it), dropped from
  every stored body (`erase_file_trust` in `apply_request_fields` and
  `sanitize_config_snapshot`) and written back on every read as the policy's
  answer (`derive_file_trust`, a required parameter of both request
  serializers, plus `GET /runs/:id`'s snapshot and `POST /import/parse`):
  `true` for a concrete path neither allowed nor granted, `false` for an
  allowed one and one still holding `{{`, no key for an empty one. A `src` holding `{{`
  is refused at send whatever the policy says, and `grantable_file_path`
  refuses it, so no grant names a template; the residual pass never resolves
  `src`, so a script cannot choose a file. The schema-version-6 migration
  granted every existing regular file a stored body marked `false` (or, on a
  database older than version 4, left unmarked) and removed the key.
  `FilePlan` applies the rule once per design send (`execute_exchange`, the
  stream branch) and once per run at plan time (`plan_load_files`,
  `plan_step_files`); executors only `fill` from it, and
  `validate_transferable` refuses a binary body or file part no plan checked
  (`unplanned_file_ref`). **A file a body names is read from what the check
  approved, never from `src` again** (#2416 for a form-data file part, #2678
  for a binary body): the plan opens the canonical path
  `FileAccessPolicy::approved_path` answered through
  `platform::open_regular_file` (`O_NOFOLLOW`, then `fstat` for a regular
  file) as an `ApprovedFile`, and everything after reads that open file. A
  binary body of at most `INLINE_FILE_LIMIT` is read through it once and its
  bytes shared (`FileRef::inline_bytes`); a larger one is hashed through it
  and every copy of the request carries it (`FileRef::approved`, like
  `FormField::approved`; neither is serialised). The plan itself keeps an
  open file only for a path the run's own request names
  (`OpenFiles::KeptByPlan`, keyed by canonical path), so a run shares one; a
  path a data row binds is approved at plan time and kept by no one, and
  `fill` opens it for that request alone, through the rule again, because a
  data file of thousands of rows would otherwise hold a descriptor per row.
  A transfer reads it through a `FileReader` at its own offset (`pread`):
  `attach_binary` streams it as `CURLOPT_UPLOAD` with `INFILESIZE_LARGE` the
  open's size, and `attach_multipart` hands it to `curl_mime_data_cb` and sets
  the filename and `file_part_content_type` itself. What remains: `O_NOFOLLOW`
  covers the last component only, so a parent directory swapped for a link
  between the canonicalisation and the open is followed; Windows opens the
  canonical path following a final reparse point, because a cloud placeholder
  is one; the approved file's content can still change under the handle (the
  size is the open's, and a file truncated below it fails the transfer); and
  a data-bound path's recorded `size` and `sha256` are the plan's read, while
  each request streams what its own open finds. A new driver that sends a
  request body goes through a `FilePlan`, never straight to the client.

## Request composition (engine-owned - POST /compose)

The engine owns request composition (#226): `POST /compose`
(`engine/src/http/request_composer.cpp`) resolves `{{variables}}` and `inherit`
auth (collection-chain walk; `noauth` terminates, `none` steps over) and
returns the execute-ready payload `POST /execute` / `POST /runs` accept
unchanged. Its `headers` are `{name, value}` lines in send order (#2466,
`vayu::HeaderList` on `vayu::Request`): every enabled row, a repeated name
repeated, the older object form still read; only a repeat a *resolved* name
makes is refused (`http/header_names.hpp`), and the renderer's row flattening
is pinned by `tests/fixtures/header-rows-conformance.json`. **A header name is
trimmed of SP and HTAB, then must be an RFC 9110 token** (#2467):
`trim_optional_whitespace` and `invalid_header_name_refusal` in `header_names.hpp`
are the one rule, applied where a name enters - `stored_header_rows` and
`settle_header_name` in composition, `stored_header_name` in
`deserialize_request` (`ErrorCode::InvalidHeaderName`, which is how
`POST /execute` and a single-request `POST /runs` answer `400
invalid_header_name`), and `resolve_header_names` in the residual pass. A blank
name is the `empty_header_name` rule's, and a `{{token}}` still in a name is
left to the layer that resolves it while the text around it is judged (each
token stands in as one token character, a stray `{{` is ordinary text). Refuse
what trimming cannot settle, never repair it. It also writes a request's
`:name` path variables from its
`in: "path"` Params rows (#1764, `core::substitute_path_variables` in
`core/path_template.hpp`, Postman's segment rule; empty value stays literal;
a value still holding a token after resolution is not joined into the URL but
waits in the payload's `params` / `vayu::Request::path_variables` until the bind
or the residual pass answers it, `core::settle_path_variables`; the app's copy
of the segment rule and substitution is pinned by
`tests/fixtures/path-variable-conformance.json`),
which is the only place a Params row reaches the wire. A query pair the engine
writes (an api key or OAuth 2.0 token in the query, a Postman import's query
join) goes through `core::encode_query_component` (`core/query_encoding.hpp`,
#1771, Postman's query rule; a stored URL is never re-encoded, except that
composition and `wire_url` both end with `core::encode_url_as_postman` unless
`disableUrlEncoding`, so every send path writes one line, #2465), whose app copy
is pinned by `tests/fixtures/query-encoding-conformance.json`. A header an `auth` block
would write (bearer, basic, an api key in a header) is skipped when the request already
carries that name, matched case-insensitively (`apply_auth`, #2475), and a bearer
token and an api key's name and value are trimmed of SP and HTAB first (a basic
pair is not; an api-key header name that is not a token is `AUTH_FAILED` with
`invalid_header_name`, #2467); the snippet
generators' copy in `prepare.ts` is pinned by
`tests/fixtures/auth-header-precedence.json`. Compose is pure (sends nothing, no run row) and is the one place a
payload is composed; that split is load-bearing. Two entry shapes: `requestId`
(stored request; MCP uses this and checks its allowlist early against the
*composed* URL, then sends the engine the same rule as `targetPolicy`, below)
and an inline `request` plus `collectionId` scope (the renderer, because Send
and replay execute editor state that may be unsaved). Inline over stored is
the overlay MCP's `start_load_run` overrides ride on.

**A scripted request composes with its `{{names}}` intact (#2521, Postman's
order).** Whether a pre-request script runs before the send is read from the
composed `elements` (`runs_a_pre_request_script`): an enabled, non-blank
`script.pre` on the request, a folder or the collection, after
`inherit.disable` and the inline overlay; `script.pre` alone, never
`script.setup`. When one does, every name a scope answers keeps its braces in
the URL, path rows, headers, body and non-OAuth credentials, and the 200 body
lists them in `deferredVariables` (sorted, omitted when empty, never an input,
ignored by `POST /execute` and `POST /runs`). A request no pre-request script
runs before composes exactly as before: resolved once, at compose. **A
collection run decides for the whole plan**: `plan_variable_deferral`
(`scenario_plan.cpp`) reads every step's composed `elements` before composing
any, and when one holds a kind the registry marks `writes_variables` (every
`script.*` and `extract.*` kind) at a phase other than `run.end`, every step
composes with `VariableDeferral::Always`, an internal `compose_request_core`
parameter, never a body field. So an unscripted step sends the token an earlier
step's test script or extractor stored; a plan with no such element resolves at
compose. A new kind that writes a variable sets the flag. Four things
resolve at compose whatever a script does: `$` names (generators once, the
iteration identity), the `data` namespace and bound columns, a name whose value
reaches one of those, and a file path (`src`: the residual pass never resolves
a path, so a script cannot choose which file is sent).

Execute is not silent past compose (#1008): a name still written after compose
(one it could not answer, which kept its braces, #1009, or one it deferred past
a script) is resolved after the pre-request script and before the send
(`resolve_residual_tokens`, `engine/src/http/request_exchange.cpp`); a value
compose already substituted is finished text. There is no caller flag: the
payload's own braces are the whole signal. A credential holding such a name
defers its whole auth past the script (#2473): `apply_late_auth` resolves and
applies it after that pass, so a basic pair is not base64-encoded around a
token. An OAuth 2.0 config defers the same way on a Send and on a sequential
collection run (`OAuth2Resolution::AfterTheScript`, what
`compose_request_core` picks unless the body says `deferDynamicVariables`):
every string of it is resolved after the script and only then is the token
acquired, so `oauth::cache_key` is computed from the resolved config, and the
late acquisition's wait is `auth_fetch_ms`, left out of `engineMs`. A name
nothing defines defers there too. A load run still acquires once, before any
script: its composition (`deferDynamicVariables`) and a scenario load plan
resolve the config at compose (`AtComposition`), and a config name nothing
answers is a `400` naming it (`invalid_run_config` for a single request,
`invalid_scenario` for a collection). Decided once, never per send
or submission: `plan_send_row_auth` for `POST /execute`,
`ScenarioStep::auth_after_scripts` at plan time for a collection run (both its
executors), `LoadAuthPlan::after_scripts` for a single-request load run that
declares `requestElements`. **That
pass can refuse** (#1051, #1084): a header name that
resolves onto one the request already carries, or to nothing, is refused
before the send, in the same words and with the same code compose uses for the
`400` (`http/header_names.hpp` holds the rule; the pass answers a
`ResidualRefusal` carrying the code, which the buffered `POST /execute` answer
carries as `refusalCode`). Since a scripted request defers its variables, the
pass also runs compose's header-text rule (#738) on them: a variable whose
value ends or cuts a header line is refused here as `unsendable_header`, before
anything is rewritten. The two rules read different reaches
(#1095): the empty-name rule reads every header name, the collision rule only
the names that still held a token. A data row whose header-name column is
blank is refused at bind time (`core/scenario_data.cpp`). A scenario load
run's `submit_one` now runs this pass too (#1495), against a per-VU view: the
run's scopes flattened once (`vayu::http::routes::flatten_variable_scopes`)
plus that VU's own small write layer (`ScopeOverlay`, on `VirtualUser`), so a
value one VU's step 1 sets reaches that same VU's step 2 `{{token}}` without
two VUs' writes ever landing in one shared map. Never refused under load,
only counted, on the same #1503 rule the load path has always followed: an
unresolved name or a header-name collision the pass produces goes on the wire
regardless, a late credential included (`resolve_load_residuals`, the one
copy both load paths call). Since #1594, the single-request load path
(`load_strategy.cpp`) runs the same pass too, against a per-submission
`ScopeOverlay` rather than a per-VU one - see the element-pipeline bullet
above - but only when the run declares `requestElements`; a bare URL run
with no step-level elements at all skips it exactly as before.

**The renderer's resolver is preview-only.** `useVariableResolver` /
`app/src/lib/variable-resolution.ts` back tab titles, previews, unresolved-token
painting and the OAuth-guard preview, never a payload. Its rules are pinned to
the engine's by `engine/tests/fixtures/variable-resolution-conformance.json`,
read by `request_composer_test.cpp` and
`variable-resolution.conformance.test.ts`; change resolution semantics in the
engine, the renderer lib and the fixture together, and a case added to the
fixture fails whichever side forgot. The Send-with-row preview restates the
bind's per-field escaping too (`lib/data-bind-escaping.ts`: the JSON and XML
placement scans and leaf escapers of `core/scenario_data.cpp`, the header
refusal, the URL join), pinned the same way by
`engine/tests/fixtures/data-bind-escaping-conformance.json`, read by
`scenario_data_test.cpp` and `variable-resolution.row.test.ts` (#2639). The
dynamic-variable name set (`$guid`, `$timestamp`, …) is part of that contract (C++ table in `request_composer.cpp`,
renderer table in `lib/dynamic-variables.ts`), as are the D17 malformed-data
rules (absent or non-boolean `enabled` = enabled; non-string `value` = "") in
`parse_variables` and `variable-resolution.ts`. D1 is now: a `{{name}}` is
resolved at compose, except where a pre-request script can change the value
(or, in a collection run, any element of the plan that writes a variable),
when it is resolved after that script (#2521, Postman's order; the first
paragraph above), and script text is never interpolated (D16). The renderer's
Code section names the deferred tokens in its Resolved mode. MCP has no
composition copy; a new engine client calls `POST /compose`.

**`targetPolicy` holds a send to the caller's hosts (#2521).** `POST /execute`
(buffered and streaming) and `POST /runs` (a single request, a sequential
collection run, a scenario load) take an optional `{allowAll?, allowedHosts?}`
(`http/target_policy.hpp`), the matching rule of the MCP gate (exact host,
case-insensitive; `allowAll` passes any host that can be determined; an empty
or still-templated host is refused). The engine judges the final URL after the
pre-request script and the residual pass, and the host of an OAuth 2.0
`accessTokenUrl` / `refreshTokenUrl` before the token cache is read or anything
is posted, so a refused target fetches no token. A buffered send answers
status 0 with `refusalCode` `target_not_allowed` / `target_host_unknown`; a
stream and the `POST /runs` pre-flight or plan answer `400` under that code; a
load run refuses each submission as an `invalid_url` error naming the host
(`EventLoopConfig::target_policy`). A malformed policy, an unknown member
included, is `400 invalid_target_policy`. It is never stored
(`sanitize_config_snapshot` drops it), and a redirect hop and a script's
`pm.sendRequest` are outside it. Absent, a send is unrestricted.

Scripts, since issue #1514's cut-over: `compose_elements` builds the
resolved, ordered `elements` array (collection chain root-to-leaf, then the
request's own, each stamped with its `origin`) engine-side for the by-id
path; the renderer's inline path builds the same shape client-side
(`elementsParts` in
`app/src/modules/request-builder/utils/elements-parts.ts`, the one
client-side copy). `elements` is the only script source `POST /execute`
accepts - `preRequestScript(s)` / `postRequestScript(s)` / `tests` are all
refused outright, naming `elements` as the replacement
(`refuse_legacy_script_fields`, `routes.hpp`). `POST /runs` reads the same
kinds under two different keys depending on shape: a scenario's steps carry
their own resolved elements off the plan, and a single-request run's own
request reads `requestElements` (issue #1594) - both refuse the legacy
fields too. Add a script destination to `compose_elements` /
`elements-parts.ts`, never a new legacy field to a route.

## Docs to keep in step

| Doc | Update it when you change… |
|-----|----------------------------|
| `docs/engine/api-reference.md` | **Any** endpoint, payload, or status code |
| `docs/engine/run-export.schema.json` | A member of the run-report export (`core/run_export.cpp`, its comparison `core/run_compare.cpp`); `run_export_schema_test.cpp` validates against it |
| `docs/engine/architecture.md` | Core engine structure, auth resolution |
| `docs/engine/elements.md` | The element registry, a kind's config or phase, the pipeline |
| `docs/engine/db-schema.md` | Schema, migrations, stored JSON |
| `docs/engine/elements.md` | An element kind, its phase, or the pipeline that runs one |
| `docs/engine/scripting.md` | Script globals, hooks, sandbox limits |
| `docs/engine/mcp.md` | MCP tools or their schemas (the server itself lives in `app/electron/mcp/`) |
| `docs/engine/cli.md` | Flags or subcommands |
| `docs/engine/logging.md` | The log record, categories, redaction, file names |
| `docs/engine/benchmarks.md` | Load generation or measurement |
| `docs/engine/building.md` | CMake presets, vcpkg deps, the lint and format gates, the vendored JS libraries and their manifest |
