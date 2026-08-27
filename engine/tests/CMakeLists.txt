# ============================================================================
# The engine test suite
# ============================================================================
#
# **Why the source list lives here and not in `engine/CMakeLists.txt`** (#970).
# Nothing about the build needs the split - a single file compiled the suite
# for the whole of its life. The sanitizer workflow needs it.
# `.github/workflows/sanitizers.yml` triggers a five-leg ASan/TSan matrix on
# `engine/CMakeLists.txt`, correctly, because the `vayu_sanitizers` interface
# target is defined there; while this list sat in that same file, adding one
# `*_test.cpp` was a change to the trigger path and ran all five legs (~70 min
# on the slowest) over machinery the diff could not touch. Dropping the file
# from the trigger instead would cost the machinery its pre-merge proof, which
# is the trade the wrong way round: the file is in the path list *for* the
# machinery, and the test list was its tenant. So the tenant moved.
#
# Paths are relative to this directory, which is why the non-test sources this
# target compiles are spelled `../src/...`. Anything that must name the engine
# root - the fixture directory the tests read at runtime, and the paths the
# guards print - uses `${PROJECT_SOURCE_DIR}`.
#
# `VAYU_BUILD_TESTS` is checked by the parent before it adds this directory, so
# there is no second guard here.

add_executable(vayu_tests
    main.cpp
    http_client_test.cpp
    json_test.cpp
    invariant_test.cpp
    optional_assert_test.cpp
    script_engine_test.cpp
    script_expect_message_test.cpp
    script_assertion_error_test.cpp
    script_completions_test.cpp
    script_types_test.cpp
    event_loop_test.cpp
    db_test.cpp
    character_cast_test.cpp
    bounds_primitives_test.cpp
    db_concurrency_test.cpp
    db_recovery_test.cpp
    rate_limit_test.cpp
    metrics_helper_test.cpp
    metrics_collector_test.cpp
    execution_trace_test.cpp
    import_route_test.cpp
    diagnostics_route_test.cpp
    import_apply_route_test.cpp
    config_route_test.cpp
    sse_parser_test.cpp
    sse_frame_counter_test.cpp
    sse_load_stream_test.cpp
    load_stream_events_test.cpp
    sse_stream_test.cpp
    server_bind_test.cpp
    numeric_flag_test.cpp
    argument_rules_test.cpp
    transport_policy_test.cpp
    tls_verification_test.cpp
    client_certificates_test.cpp
    mutual_tls_test.cpp
    requests_route_test.cpp
    examples_route_test.cpp
    specs_route_test.cpp
    runs_route_test.cpp
    collections_route_test.cpp
    resource_write_route_test.cpp
    error_shape_route_test.cpp
    globals_route_test.cpp
    script_variables_test.cpp
    load_script_scopes_test.cpp
    script_info_test.cpp
    script_send_request_test.cpp
    script_sent_headers_test.cpp
    sent_headers_wire_test.cpp
    set_cookie_test.cpp
    cookie_jar_test.cpp
    form_body_test.cpp
    graphql_body_test.cpp
    jsonrpc_body_test.cpp
    url_parts_test.cpp
    script_request_url_test.cpp
    xml_body_test.cpp
    stats_route_test.cpp
    execution_timeout_test.cpp
    execution_http_version_test.cpp
    load_strategy_test.cpp
    load_data_test.cpp
    refill_deficit_test.cpp
    reservoir_test.cpp
    sample_capture_test.cpp
    response_capture_test.cpp
    load_pacing_test.cpp
    threshold_eval_test.cpp
    capacity_controller_test.cpp
    monitor_test.cpp
    run_manager_test.cpp
    run_route_test.cpp
    run_stop_test.cpp
    run_shutdown_test.cpp
    run_config_validation_test.cpp
    run_row_seed_test.cpp
    transient_execute_test.cpp
    send_with_row_test.cpp
    script_compose_test.cpp
    encoding_test.cpp
    auth_resolver_test.cpp
    auth_refresh_test.cpp
    request_builder_test.cpp
    oauth_client_test.cpp
    oauth_route_test.cpp
    pkce_test.cpp
    debug_redact_test.cpp
    managed_listener_test.cpp
    oauth_authorize_test.cpp
    mock_issuer_test.cpp
    inbox_test.cpp
    mock_server_routes_test.cpp
    id_test.cpp
    curl_utils_test.cpp
    curl_transfer_test.cpp
    dns_cache_test.cpp
    http_version_support_test.cpp
    http_version_test.cpp
    request_composer_test.cpp
    residual_token_test.cpp
    scenario_data_test.cpp
    scenario_load_test.cpp
    scenario_plan_test.cpp
    scenario_runner_test.cpp
    tree_order_test.cpp
    reorder_route_test.cpp
    spec_sync_route_test.cpp
    spec_match_route_test.cpp
    spec_diff_route_test.cpp
    spec_describe_route_test.cpp
    spec_bind_route_test.cpp
    operation_match_test.cpp
    openapi_document_test.cpp
    import_parse_test.cpp
    openapi_drafts_test.cpp
    spec_diff_test.cpp
    openapi_export_test.cpp
    spec_export_route_test.cpp
    workspace_backup_test.cpp
    spec_coverage_test.cpp
    schema_validation_test.cpp
    version_isolation_test.cpp
    reentrant_test.cpp
    logger_test.cpp
    ../src/http/routes/import.cpp
    ../src/http/routes/diagnostics.cpp
    ../src/http/routes/compose.cpp
    ../src/http/routes/config.cpp
    ../src/http/routes/workspace.cpp
    ../src/http/routes/requests.cpp
    ../src/http/routes/examples.cpp
    ../src/http/routes/specs.cpp
    ../src/http/routes/spec_sync.cpp
    ../src/http/routes/spec_match.cpp
    ../src/http/routes/spec_diff.cpp
    ../src/http/routes/spec_describe.cpp
    ../src/http/routes/spec_bind.cpp
    ../src/http/routes/spec_export.cpp
    ../src/http/routes/reorder.cpp
    ../src/http/routes/runs.cpp
    ../src/http/routes/collections.cpp
    ../src/http/routes/environments.cpp
    ../src/http/routes/client_certificates.cpp
    ../src/http/routes/globals.cpp
    ../src/http/routes/metrics.cpp
    ../src/http/routes/oauth.cpp
    ../src/http/routes/oauth_authorize.cpp
    ../src/http/routes/execution.cpp
    ../src/http/routes/scripting.cpp
    ../src/http/routes/script_types.cpp
    ../src/http/routes/cookies.cpp
    ../src/http/routes/mock_issuer.cpp
    ../src/http/routes/inbox.cpp
    ../src/http/routes/events.cpp
    ../src/http/routes/mock_server.cpp
    ../src/http/managed_listener.cpp
    # The daemon's own Server, so its shutdown ordering is testable rather
    # than only reachable by running the daemon (#646). It registers every
    # route group, which is why health.cpp joins the list here too.
    ../src/http/routes/health.cpp
    ../src/http/server.cpp
)

# The binary stays at the top of the build tree, beside `vayu-engine` and
# `vayu-cli`, which is where it was for the whole of its life before this list
# became a subdirectory. `add_subdirectory` would otherwise land it in
# `build-*/tests/`, and this move was about which pull requests trigger the
# sanitizer matrix - relocating a build output is not part of it. The relocation
# would not have been quiet, either: `sanitizers.yml` probes
# `build-asan/vayu_tests` and `build-tsan/vayu_tests` to smoke-load the binary
# before running ctest, and answers a miss with "no vayu_tests binary under
# build-asan/ or build-tsan/" - a five-leg red matrix describing a path, not a
# defect. Every preset is single-config Ninja, so this is one directory.
set_target_properties(vayu_tests PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)

# A *_test.cpp that is on disk but absent from the list above is compiled
# into nothing and reports nothing - no output, no failure, just a suite
# count that quietly never included it. response_capture_test.cpp sat that
# way for ~140 commits and its 16 tests never ran once (#668). This is the
# "assert you scanned something non-empty" rule applied to the build: the
# glob is a *check* against the explicit list, never a substitute for it,
# so nothing about how the target is built becomes order-dependent or
# invisible in the diff. CONFIGURE_DEPENDS re-runs the glob when the
# directory changes, so the failure lands on whoever adds the file rather
# than on whoever notices years later.
file(GLOB vayu_test_files_on_disk CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/*_test.cpp")
if(NOT vayu_test_files_on_disk)
    message(FATAL_ERROR
        "Test registration guard found no *_test.cpp under "
        "${CMAKE_CURRENT_SOURCE_DIR} - the guard is scanning the "
        "wrong place and would pass no matter what is missing.")
endif()
get_target_property(vayu_registered_test_sources vayu_tests SOURCES)
set(vayu_registered_test_paths "")
foreach(source IN LISTS vayu_registered_test_sources)
    if(NOT IS_ABSOLUTE "${source}")
        set(source "${CMAKE_CURRENT_SOURCE_DIR}/${source}")
    endif()
    list(APPEND vayu_registered_test_paths "${source}")
endforeach()
set(vayu_unregistered_tests "")
foreach(test_file IN LISTS vayu_test_files_on_disk)
    if(NOT test_file IN_LIST vayu_registered_test_paths)
        file(RELATIVE_PATH relative_test_file "${PROJECT_SOURCE_DIR}" "${test_file}")
        list(APPEND vayu_unregistered_tests "${relative_test_file}")
    endif()
endforeach()
if(vayu_unregistered_tests)
    string(REPLACE ";" "\n  " vayu_unregistered_tests "${vayu_unregistered_tests}")
    message(FATAL_ERROR
        "These test files exist but are not in add_executable(vayu_tests ...), "
        "so none of their tests would run:\n  ${vayu_unregistered_tests}\n"
        "Add them to the source list in engine/tests/CMakeLists.txt.")
endif()

# The cross-language conformance fixture lives in the source tree and is
# read at test runtime by path (the app's vitest suite reads the same file),
# so the tests need to know where the sources are regardless of the build
# or ctest working directory.
target_compile_definitions(vayu_tests PRIVATE
    VAYU_ENGINE_SOURCE_DIR="${PROJECT_SOURCE_DIR}"
)

target_link_libraries(vayu_tests PRIVATE
    vayu_core
    # gtest_main already carries gtest; naming both made Apple's linker
    # report "ignoring duplicate libraries: libgtest.a" on every macOS build.
    GTest::gtest_main
    httplib::httplib
    vayu_warnings
    vayu_sanitizers
)
if(NOT MSVC)
    target_precompile_headers(vayu_tests PRIVATE <nlohmann/json.hpp>)
endif()

# The test binary needs the manifest for two reasons: any test that opens a
# TLS connection would otherwise run without ALPN, and `WindowsOsVersionShim`
# in http_version_support_test.cpp asserts on *this* process's view of the OS
# version - which is only meaningful if this process is manifested the same
# way vayu-engine is.
vayu_embed_windows_manifest(vayu_tests)

# The suite is discovered in two halves so the tests that open a scratch
# `Database` can carry a CTest RESOURCE_LOCK the rest does not (#805
# phase 5). CTest never runs two tests holding the same lock at once, so no
# two database tests overlap while everything else runs `-j` beside them.
#
# Only Windows takes the lock. `ctest -j` is *correct* on every platform
# already - each test process owns a private scratch directory, see
# `tests/temp_database.hpp` - and what differs is the price of concurrent
# SQLite commits. On Windows a plain `-j4` measured ~37 min against a ~6 min
# serial run (#808), which is the cost this lock removes; the same `-j4`
# cuts ubuntu from 3-5 min to 1m15s, so locking the group there would only
# slow down a platform that has no such problem.
#
# The list is a performance statement, not a correctness one. A database
# suite missing from it still passes - it just contends - and a suite listed
# here that opens no database only gives up its own concurrency. So the
# guards below check the two things that can be checked exactly and cheaply
# (a name matching no test at all, and a database-using file no name here
# represents) rather than parsing C++ for what constructs a `Database`.
#
# The list was derived by tracing: every suite run alone under `strace` that
# opened a `*.db` file, which agreed with a source read everywhere but one
# false positive. Re-derive it the same way rather than by eye.
set(vayu_scratch_database_suites
    AuthRefreshTuningTest
    ClientCertificateDbTest
    CollectMetrics
    ColumnTextFixture
    CollectionsRouteTest
    ConfigRouteTest
    CustomCaVerificationTest
    DatabaseConcurrencyTest
    DatabaseTest
    DbRecoveryTest
    DeleteRunTest
    ErrorShapeRouteTest
    ExamplesRouteTest
    GlobalsRouteTest
    ImportApplyRouteTest
    ImportParseRoute
    InboxListenerTest
    InboxStorageTest
    LoadDataTest
    LoadReplayEventsTest
    LoadScriptScopesTest
    LoadStrategyTest
    MidRunRefreshTest
    MockIssuerTest
    MockServerTest
    MonitorLimitsTest
    MonitorRunTest
    MutualTlsTest
    OAuthAuthorizeTest
    OAuthClientTest
    OAuthRouteTest
    PersistScriptVariablesTest
    PlanAuthRefreshTest
    RecordDesignResultTest
    RelayTest
    ReorderRouteTest
    RequestComposerTest
    RequestsRouteTest
    ResourceWriteRouteTest
    ResponseCaptureTest
    RunShutdownTest
    RunStopAccountingTest
    RunsRouteTest
    ScenarioLoadTest
    ScenarioPlanTest
    ScenarioRunnerTest
    ScratchDatabaseCleanup
    ScriptRequestNameTest
    ScriptVariableScopesTest
    ServerBindTest
    SpecBindRouteTest
    SpecExportRouteTest
    SpecMatchRouteTest
    SpecDiffRouteTest
    SpecDescribeRouteTest
    SpecSyncRouteTest
    SpecsRouteTest
    SseLimitsTest
    SseServerShutdownTest
    StatsRouteTest
    StreamExecuteTest
    StreamedSampleRouteTest
    TransportPolicyDbTest
    TreeOrderTest
    WorkspaceBackupTest
)

# Both guards read the same scan: every test macro in this suite sits at the
# start of a line, so which suites exist, and which file declares them, can
# be read off without compiling anything.
set(vayu_declared_test_suites "")
set(vayu_unrepresented_database_files "")
foreach(test_file IN LISTS vayu_test_files_on_disk)
    file(STRINGS "${test_file}" vayu_test_macro_lines REGEX "^TEST(_F|_P)?[ \t]*\\(")
    set(vayu_file_test_suites "")
    foreach(macro_line IN LISTS vayu_test_macro_lines)
        string(REGEX REPLACE "^TEST(_F|_P)?[ \t]*\\([ \t]*([A-Za-z0-9_]+).*$" "\\2"
            vayu_file_test_suite "${macro_line}")
        list(APPEND vayu_file_test_suites "${vayu_file_test_suite}")
    endforeach()
    list(APPEND vayu_declared_test_suites ${vayu_file_test_suites})

    # Guard two: a test file that opens scratch databases and contributes no
    # locked suite is a whole file's worth of contention nobody decided on -
    # the shape a new `*_route_test.cpp` arrives in.
    file(STRINGS "${test_file}" vayu_temp_database_include REGEX "temp_database\\.hpp")
    if(vayu_temp_database_include)
        set(vayu_file_is_represented FALSE)
        foreach(suite IN LISTS vayu_file_test_suites)
            if(suite IN_LIST vayu_scratch_database_suites)
                set(vayu_file_is_represented TRUE)
                break()
            endif()
        endforeach()
        if(NOT vayu_file_is_represented)
            file(RELATIVE_PATH vayu_relative_test_file
                "${PROJECT_SOURCE_DIR}" "${test_file}")
            list(APPEND vayu_unrepresented_database_files "${vayu_relative_test_file}")
        endif()
    endif()
endforeach()
if(NOT vayu_declared_test_suites)
    message(FATAL_ERROR
        "Found no TEST/TEST_F declarations under ${CMAKE_CURRENT_SOURCE_DIR} - "
        "the scratch-database guards are scanning the wrong place and would "
        "pass no matter which suite was missing.")
endif()
# Guard one: a name above that matches no test locks nothing and says so
# nowhere - a rename would quietly return that suite to contending.
foreach(suite IN LISTS vayu_scratch_database_suites)
    if(NOT suite IN_LIST vayu_declared_test_suites)
        message(FATAL_ERROR
            "vayu_scratch_database_suites names '${suite}', which no test declares. "
            "It locks nothing: on Windows that suite would run concurrently with "
            "the other database tests again. Fix the name or drop it.")
    endif()
endforeach()
if(vayu_unrepresented_database_files)
    string(REPLACE ";" "\n  " vayu_unrepresented_database_files
        "${vayu_unrepresented_database_files}")
    message(FATAL_ERROR
        "These test files include temp_database.hpp but contribute no suite to "
        "vayu_scratch_database_suites, so their database tests would run "
        "concurrently with every other one on Windows:\n  "
        "${vayu_unrepresented_database_files}\n"
        "Add the suites that open a Database to the list in engine/tests/CMakeLists.txt.")
endif()

# Discover tests for CTest. A per-test TIMEOUT acts as a safety net so a
# deadlock (e.g. a thread-pool teardown hang) is reported as a failure
# instead of blocking the suite indefinitely; healthy tests finish in <10s
# in an ordinary build, and the slowest measured is ~10s.
#
# **The net scales with the instrumentation** (issue #904). 60s is six times
# the slowest healthy test *uninstrumented*, which is thin once
# AddressSanitizer's documented ~2x or ThreadSanitizer's 5-15x is applied to
# it. The multipliers below keep roughly that same ratio rather than being
# tuned to any one runner.
#
# **This is headroom, not a fix for anything observed.** It is worth being
# exact about that, because the first `windows-asan` run looked like it
# needed a bigger net and did not. Every one of its 2368 tests reported
# `***Timeout`, including ones that only create a file - which no slowdown
# factor explains. The binary was not slow, it could not start: a /MTd
# binary still needs `clang_rt.asan_dynamic-x86_64.dll` at runtime, and the
# ctest step ran in neither a debugging session nor a developer command
# prompt, which is where Microsoft documents that DLL's directory as being
# on PATH. Raising the net made that failure slower, not better. The
# workflow now enters a developer environment (ilammy/msvc-dev-cmd) and
# smoke-loads the binary before running anything, so the same failure would
# now report in seconds. With that in place `windows-asan` runs all 2368
# tests in ~1018s with zero timeouts - the net was never the constraint.
#
# Measured, so the numbers here are not guesses: a full `linux-tsan` run in
# CI reported 70 failures out of 2367 and **zero** timeouts, finishing its
# test phase in 275s, with the slowest passing test around 10s. Nothing came
# close to even the ordinary 60s net.
#
# The direction of the trade-off is the one this block already argues for
# DISCOVERY_TIMEOUT - being too generous costs a slower failure, being too
# tight costs a red run over healthy code - with one correction the Windows
# run taught: when a hang is *systemic*, a generous net multiplies the cost
# by the number of tests, and only the job timeout saves you. So these are
# sized to cover a slow healthy test and no further.
#
# DISCOVERY_TIMEOUT bounds something else entirely, and the two are easy to
# confuse: `PROPERTIES TIMEOUT` is handed to CTest for each discovered test,
# while DISCOVERY_TIMEOUT caps each `--gtest_list_tests` run that *finds*
# them at build time (one per call below). It is not covered by the property
# above and defaults to **5 seconds**.
#
# Five seconds is not enough for the macOS x64 half of the release build.
# That binary is cross-compiled for x86_64 and runs under Rosetta on the
# arm64 runners, and enumerating ~1,600 tests through binary translation -
# cold, on the very first execution of a freshly linked binary - overruns
# it. v0.17.1 died exactly there: "Process terminated due to timeout" with
# empty output, `ninja: build stopped`, after the arm64 half had built and
# passed its whole suite. The release never published.
#
# It had been passing by luck. Until v0.17.1 the same job built every vcpkg
# dependency from source first, which runs x86_64 configure probes under
# Rosetta and leaves its translation cache warm by the time gtest discovery
# runs. Once the dependency cache started being reused (v0.17.1 was the
# first release to hit it - that build dropped from 10m35s to 5m45s), no
# x86_64 process ran ahead of the test binary any more and discovery paid
# the cold-start cost itself. The cache made the build faster and this
# slower; the 5s default was always too tight for a translated binary.
#
# 150s is deliberately generous. This bounds a hang, and a hang is already
# bounded by the job timeout - so the cost of being too high is a slower
# failure, while the cost of being too low is a red release tag, which is
# what we just paid. Set globally rather than per-preset: one number is
# easier to trust than a platform conditional, and no healthy configuration
# comes close to it.

# One filter, used positive and negated, so the two halves partition the
# suite exactly however the list changes - no test is discovered twice and
# none is lost. Both halves are discovered on every platform (only the
# property differs) so a broken partition shows up as a changed test count
# everywhere rather than on Windows alone.
set(vayu_scratch_database_patterns ${vayu_scratch_database_suites})
list(TRANSFORM vayu_scratch_database_patterns APPEND ".*")
list(JOIN vayu_scratch_database_patterns ":" vayu_scratch_database_filter)

set(vayu_test_timeout 60)
if(VAYU_USE_ASAN)
    set(vayu_test_timeout 180)
elseif(VAYU_USE_TSAN)
    set(vayu_test_timeout 300)
endif()
message(STATUS "Per-test CTest timeout: ${vayu_test_timeout}s")

set(vayu_scratch_database_properties TIMEOUT ${vayu_test_timeout})
if(WIN32)
    list(APPEND vayu_scratch_database_properties RESOURCE_LOCK vayu_scratch_database)
endif()

include(GoogleTest)
gtest_discover_tests(vayu_tests
    TEST_FILTER "${vayu_scratch_database_filter}"
    DISCOVERY_TIMEOUT 150
    PROPERTIES ${vayu_scratch_database_properties}
)
gtest_discover_tests(vayu_tests
    TEST_FILTER "-${vayu_scratch_database_filter}"
    DISCOVERY_TIMEOUT 150
    PROPERTIES TIMEOUT ${vayu_test_timeout}
)
