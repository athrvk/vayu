cmake_minimum_required(VERSION 3.25)

project(vayu-engine
    VERSION 0.19.0
    DESCRIPTION "High-performance API execution engine"
    LANGUAGES C CXX
)

# ============================================================================
# Build Options
# ============================================================================

option(VAYU_BUILD_TESTS "Build test suite" ON)
option(VAYU_BUILD_CLI "Build CLI tool" ON)
option(VAYU_BUILD_ENGINE "Build daemon" ON)
option(VAYU_USE_ASAN "Enable AddressSanitizer" OFF)
option(VAYU_USE_TSAN "Enable ThreadSanitizer" OFF)

# ============================================================================
# C++ Standard and Compiler Settings
# ============================================================================

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# CMAKE_MSVC_RUNTIME_LIBRARY (set by the windows-* presets to link the MSVC
# runtime statically) is only honoured where policy CMP0091 is NEW. This
# project's cmake_minimum_required(3.25) makes it NEW here - but vendored
# quickjs-ng declares its own cmake_minimum_required(3.10), which resets
# policies to 3.10 defaults inside that subdirectory and would leave the `qjs`
# target on the dynamic runtime (/MD) while everything else is static (/MT).
# Two CRTs in one process is not a build error; it corrupts the heap at
# runtime. Forcing the default for subprojects keeps the whole tree on one
# runtime. Must be set before any add_subdirectory().
set(CMAKE_POLICY_DEFAULT_CMP0091 NEW)

# Position independent code (required for shared libraries)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# ============================================================================
# Static Analysis
# ============================================================================

# Add common Homebrew paths for LLVM on macOS
if(APPLE)
    list(APPEND CMAKE_PROGRAM_PATH "/opt/homebrew/opt/llvm/bin" "/usr/local/opt/llvm/bin")
endif()

# Uncomment the following lines to enable clang-tidy static analysis

# find_program(CLANG_TIDY_EXE NAMES "clang-tidy")

# if(CLANG_TIDY_EXE)
#     message(STATUS "clang-tidy found: ${CLANG_TIDY_EXE}")
#     # Set clang-tidy for all C++ targets created after this point
#     set(CMAKE_CXX_CLANG_TIDY "${CLANG_TIDY_EXE}")
# else()
#     message(WARNING "clang-tidy not found. Static analysis will be disabled.")
# endif()

# ============================================================================
# Compiler Warnings
# ============================================================================

add_library(vayu_warnings INTERFACE)

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(vayu_warnings INTERFACE
        -Wall
        -Wextra
        -Wpedantic
        $<$<BOOL:$ENV{VAYU_STRICT_BUILD}>:-Werror>
        -Wno-unused-parameter
        -Wconversion
        -Wsign-conversion
        -Wdouble-promotion
        -Wformat=2
        -Wnull-dereference
    )
elseif(CMAKE_CXX_COMPILER_ID STREQUAL "MSVC")
    target_compile_options(vayu_warnings INTERFACE
        /W4
        /WX
        /permissive-
        /FS
        /wd4324
        /wd4101
        /wd4100
        /wd4456
        /wd4244
    )
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang" AND CMAKE_SYSTEM_NAME MATCHES "Linux")
    target_compile_options(vayu_warnings INTERFACE
        -Wno-deprecated-declarations
        -Wno-missing-designated-field-initializers
        -Wno-implicit-int-float-conversion
    )
endif()

# ============================================================================
# Sanitizers
# ============================================================================

add_library(vayu_sanitizers INTERFACE)

if(VAYU_USE_ASAN)
    message(STATUS "AddressSanitizer enabled")
    target_compile_options(vayu_sanitizers INTERFACE -fsanitize=address -fno-omit-frame-pointer)
    target_link_options(vayu_sanitizers INTERFACE -fsanitize=address)
endif()

if(VAYU_USE_TSAN)
    message(STATUS "ThreadSanitizer enabled")
    target_compile_options(vayu_sanitizers INTERFACE -fsanitize=thread)
    target_link_options(vayu_sanitizers INTERFACE -fsanitize=thread)
endif()

# ============================================================================
# Dependencies (via vcpkg)
# ============================================================================

find_package(CURL REQUIRED)
find_package(unofficial-sodium CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(httplib CONFIG REQUIRED)
find_package(unofficial-sqlite3 CONFIG REQUIRED)
find_package(SqliteOrm CONFIG REQUIRED)
find_package(valijson CONFIG REQUIRED)
# The one YAML reader in the engine (issue #853). A stored OpenAPI document is
# YAML as often as JSON, and core/openapi_document.cpp is the only translation
# unit that includes it - everything else reads the nlohmann DOM it produces.
find_package(ryml CONFIG REQUIRED)

if(VAYU_BUILD_TESTS)
    find_package(GTest CONFIG REQUIRED)
    enable_testing()
endif()

# ============================================================================
# QuickJS (Vendored) - Platform Dependent
# ============================================================================

# One engine on every platform: QuickJS-NG (the actively maintained fork).
# Until issue #226's review, Windows used NG (the original does not compile
# under MSVC) while Linux/macOS used Bellard's original - two interpreters
# behind one pm.* surface, so an engine-level behaviour difference was a
# Windows-vs-Unix script divergence. The original copy is deleted; the API
# shim (QJS_IsArray/QJS_NewClassID) went with it.
set(QUICKJS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/quickjs-ng)

if(EXISTS ${QUICKJS_DIR}/CMakeLists.txt)
    # Configure QuickJS-NG
    set(QJS_BUILD_EXAMPLES OFF CACHE BOOL "Disable QuickJS examples" FORCE)
    set(QJS_BUILD_LIBC OFF CACHE BOOL "Disable QuickJS libc build in library" FORCE)

    # Add QuickJS-NG as a subdirectory
    add_subdirectory(${QUICKJS_DIR} ${CMAKE_BINARY_DIR}/quickjs-ng EXCLUDE_FROM_ALL)

    if(TARGET qjs)
        add_library(quickjs ALIAS qjs)
        # Vendored code builds with its own flags: no vayu warnings, no
        # clang-tidy (same treatment the old in-tree QuickJS build had).
        set_target_properties(qjs PROPERTIES C_CLANG_TIDY "" CXX_CLANG_TIDY "")
        set(QUICKJS_FOUND TRUE)
        message(STATUS "Found and configured QuickJS-NG at ${QUICKJS_DIR}")
    else()
        message(WARNING "QuickJS-NG target 'qjs' not found after add_subdirectory")
        set(QUICKJS_FOUND FALSE)
    endif()
else()
    message(WARNING "QuickJS-NG not found in vendor/quickjs-ng. Scripting will be disabled.")
    set(QUICKJS_FOUND FALSE)
endif()

# ============================================================================
# HdrHistogram (Vendored) - Lock-free latency histogram
# ============================================================================

set(HDRHISTOGRAM_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/hdrhistogram)

if(EXISTS ${HDRHISTOGRAM_DIR}/src/hdr_histogram.c)
    add_library(hdrhistogram STATIC
        ${HDRHISTOGRAM_DIR}/src/hdr_histogram.c
        ${HDRHISTOGRAM_DIR}/src/hdr_encoding.c
        ${HDRHISTOGRAM_DIR}/src/hdr_interval_recorder.c
        ${HDRHISTOGRAM_DIR}/src/hdr_thread.c
        ${HDRHISTOGRAM_DIR}/src/hdr_time.c
        ${HDRHISTOGRAM_DIR}/src/hdr_writer_reader_phaser.c
        ${HDRHISTOGRAM_DIR}/src/hdr_histogram_log_no_op.c
    )
    target_include_directories(hdrhistogram PUBLIC ${HDRHISTOGRAM_DIR}/include)
    
    # Platform-specific threading
    if(NOT WIN32)
        find_package(Threads REQUIRED)
        target_link_libraries(hdrhistogram PRIVATE Threads::Threads)
    endif()
    
    # Disable warnings for vendored code
    if(MSVC)
        target_compile_options(hdrhistogram PRIVATE /W0)
    else()
        target_compile_options(hdrhistogram PRIVATE -w)
    endif()
    
    # Disable clang-tidy for vendored code
    set_target_properties(hdrhistogram PROPERTIES C_CLANG_TIDY "" CXX_CLANG_TIDY "")
    
    set(HDRHISTOGRAM_FOUND TRUE)
    message(STATUS "Found and configured HdrHistogram at ${HDRHISTOGRAM_DIR}")
else()
    message(FATAL_ERROR "HdrHistogram not found in vendor/hdrhistogram. Required for metrics collection.")
endif()

# ============================================================================
# Windows application manifest
# ============================================================================

# Embed engine/res/vayu-windows.manifest into an executable.
#
# Every executable that links libcurl needs this, and the reason is not
# discoverable from the flag: without the manifest's `supportedOS` ids,
# `VerifyVersionInfoW` reports Windows 8 to the process, curl's Schannel
# backend concludes the OS is too old for ALPN, and HTTP/2 can never be
# negotiated - silently, with a 200 and an `httpVersion` of "HTTP/1.1"
# (issue #215). The full chain is written out in the manifest file itself;
# read that before removing any of this.
#
# The mechanism is a plain `.manifest` source, not a linker flag. CMake feeds
# any `.manifest` source through `mt` and merges it into the one manifest it
# already generates for the target. Passing `/MANIFEST:EMBED /MANIFESTINPUT:`
# through target_link_options instead *looks* equivalent and does not link:
# CMake's vs_link_exe wrapper still appends its own `/MANIFEST` and
# `manifest.res`, and the two collide with
# `CVT1100: duplicate resource. type:MANIFEST, name:1`. So do not "simplify"
# this into linker flags.
function(vayu_embed_windows_manifest target)
    if(NOT MSVC)
        return()
    endif()
    target_sources(${target} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/res/vayu-windows.manifest")
endfunction()

# ============================================================================
# Core Library
# ============================================================================

# Platform-specific source files
if(WIN32)
    set(PLATFORM_SOURCES src/platform/platform_windows.cpp)
else()
    set(PLATFORM_SOURCES src/platform/platform_unix.cpp)
endif()

add_library(vayu_core STATIC
    src/http/client.cpp
    src/http/auth_resolver.cpp
    src/http/request_builder.cpp
    src/http/request_composer.cpp
    src/http/oauth_client.cpp
    src/http/event_loop.cpp
    src/http/event_loop/curl_callbacks.cpp
    src/http/event_loop/transfer_context.cpp
    src/http/event_loop/curl_utils.cpp
    src/http/event_loop/event_loop_worker.cpp
    src/http/event_loop/event_loop_impl.cpp
    src/http/thread_pool.cpp
    src/http/rate_limiter.cpp
    src/http/script_parts.cpp
    src/http/request_exchange.cpp
    src/http/set_cookie.cpp
    src/http/sse_parser.cpp
    src/http/sse_stream.cpp
    src/http/transport_policy.cpp
    src/http/cookie_jar.cpp
    src/http/form_body.cpp
    src/http/header_text.cpp
    src/http/graphql_body.cpp
    src/http/jsonrpc_body.cpp
    src/utils/json.cpp
    src/utils/logger.cpp
    src/utils/metrics_helper.cpp
    src/utils/id.cpp
    src/db/database.cpp
    src/core/auth_refresh.cpp
    src/core/load_strategy.cpp
    src/core/scenario_data.cpp
    src/core/scenario_load.cpp
    src/core/scenario_plan.cpp
    src/core/scenario_runner.cpp
    src/core/operation_match.cpp
    src/core/openapi_document.cpp
    src/core/openapi_export.cpp
    src/core/spec_binding.cpp
    src/core/spec_coverage.cpp
    src/core/schema_validation.cpp
    src/core/run_manager.cpp
    src/core/metrics_collector.cpp
    src/core/sample_capture.cpp
    src/core/threshold_eval.cpp
    src/core/capacity_controller.cpp
    src/core/monitor.cpp
    # The only TU that sees VAYU_VERSION_STRING for the User-Agent - keep it
    # that way, or a version bump invalidates the whole compile cache (#659).
    src/core/user_agent.cpp
    ${PLATFORM_SOURCES}
)

target_include_directories(vayu_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(vayu_core PUBLIC
    CURL::libcurl
    # PUBLIC because utils/sha256.hpp and utils/encoding.hpp include <sodium.h>
    # in their interface, so every consumer of vayu_core needs it too.
    unofficial-sodium::sodium
    nlohmann_json::nlohmann_json
    valijson
    # PRIVATE would do for the linker - only openapi_document.cpp includes it -
    # but vayu_core is linked into three binaries and the static lib carries the
    # symbols, so it rides with the rest.
    ryml::ryml
    unofficial::sqlite3::sqlite3
    sqlite_orm::sqlite_orm
    hdrhistogram
    vayu_warnings
    vayu_sanitizers
)

# sqlite_orm hides its json_extract/json_valid wrappers behind this macro, which
# describes the *library* build rather than being defined by it. Our sqlite3
# comes from vcpkg with the json1 feature on (declared in vcpkg.json, and built
# in unconditionally by SQLite itself since 3.38), so the functions are there -
# the header just will not declare them until it is told. PUBLIC so every
# translation unit that pulls in sqlite_orm sees the same header.
# Reader: GET /runs?collectionId= (db/database.cpp, run_filter_where).
target_compile_definitions(vayu_core PUBLIC SQLITE_ENABLE_JSON1)

# Windows-specific libraries
if(WIN32)
    target_link_libraries(vayu_core PUBLIC ws2_32 winmm)
    # MSVC-specific options for vayu_core
    if(MSVC)
        target_compile_definitions(vayu_core PRIVATE
            _CRT_SECURE_NO_WARNINGS
            _CRT_NONSTDC_NO_DEPRECATE
            NOMINMAX
            WIN32_LEAN_AND_MEAN
        )
    endif()
endif()

# Add QuickJS if available
if(QUICKJS_FOUND)
    target_sources(vayu_core PRIVATE
        src/runtime/script_engine.cpp
    )
    target_link_libraries(vayu_core PUBLIC quickjs)
    target_compile_definitions(vayu_core PUBLIC VAYU_HAS_QUICKJS)
    
    # Disable C99 extension warnings for script_engine.cpp (QuickJS macros use compound literals)
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        set_source_files_properties(src/runtime/script_engine.cpp PROPERTIES
            COMPILE_FLAGS "-Wno-c99-extensions"
        )
    endif()
endif()

# ============================================================================
# Precompiled Header
# ============================================================================

# nlohmann/json.hpp is included in over half the engine's translation units
# (93 of 174 .cpp files) and is expensive to parse on every one of them -
# heavy template metaprogramming that gains nothing from being reparsed
# identically each time. Each target below precompiles it independently
# (paying that parse cost once per target rather than once per TU) rather
# than sharing one PCH via REUSE_FROM: REUSE_FROM requires every reusing
# target's compiler invocation to match the PCH-owning target's exactly -
# same macros, same linked libraries - and vayu_core is not: it does not
# link httplib::httplib (only vayu-cli/vayu-engine/vayu_tests do, so a
# shared PCH would compile httplib.h without vcpkg's CPPHTTPLIB_OPENSSL_SUPPORT
# and silently drop httplib::SSLServer for every consumer), and its Windows
# CRT/NOMINMAX defines are PRIVATE, so MSVC's own /Yu macro-parity check
# (C4651, fatal under /WX) rejects reuse from vayu-cli/vayu-engine outright.
# httplib.h itself (24 files) is left out of the PCH for the same reason -
# it is not something vayu_core's own compile settings actually cover.
#
# NOT MSVC, not NOT WIN32 - the exclusion is about the compiler's /Yu
# interacting with sccache, not the platform (a clang-cl build would not
# have this problem). sccache logged the large majority of Windows compile
# requests (200 of 257 in the measured run) as non-cacheable because of the
# /Fp flag, identical in a cold run and the run right after it - so the
# "warm" run (19m21s) was slower than the cold one (18m06s), both far worse
# than the no-PCH warm baseline (~2m). This is not a CI win on ubuntu/macOS
# either, in the steady state #700's cache warming already produces: their
# PCH-warm numbers are a wash against their own no-PCH warm baseline, and
# macOS is a little slower (recurring PCH-creation cache misses each run).
# Full measurements and the warm-vs-warm comparison that corrected the
# original cold-vs-warm framing are on
# https://github.com/athrvk/vayu/issues/805. Whatever value this PCH has is
# in regimes CI's steady state does not exercise - a cold cache, or a local
# build without sccache - not the PR pipeline itself.
if(NOT MSVC)
    target_precompile_headers(vayu_core PRIVATE <nlohmann/json.hpp>)
endif()

# ============================================================================
# CLI Executable
# ============================================================================

if(VAYU_BUILD_CLI)
    add_executable(vayu-cli
        src/cli.cpp
    )

    target_include_directories(vayu-cli PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
    )

    target_link_libraries(vayu-cli PRIVATE
        vayu_core
        httplib::httplib
        nlohmann_json::nlohmann_json
    valijson
        vayu_warnings
        vayu_sanitizers
    )
    if(NOT MSVC)
        target_precompile_headers(vayu-cli PRIVATE <nlohmann/json.hpp>)
    endif()

    # Not optional on Windows - see vayu_embed_windows_manifest above.
    vayu_embed_windows_manifest(vayu-cli)

    install(TARGETS vayu-cli RUNTIME DESTINATION bin)
endif()

# ============================================================================
# Engine Daemon Executable
# ============================================================================

if(VAYU_BUILD_ENGINE)
    add_executable(vayu-engine
        src/daemon.cpp
        src/http/server.cpp
        src/http/managed_listener.cpp
        src/http/routes/health.cpp
        src/http/routes/config.cpp
        src/http/routes/collections.cpp
        src/http/routes/requests.cpp
        src/http/routes/examples.cpp
        src/http/routes/specs.cpp
        src/http/routes/spec_sync.cpp
        src/http/routes/spec_match.cpp
        src/http/routes/spec_export.cpp
        src/http/routes/reorder.cpp
        src/http/routes/environments.cpp
        src/http/routes/client_certificates.cpp
        src/http/routes/globals.cpp
        src/http/routes/runs.cpp
        src/http/routes/execution.cpp
        src/http/routes/compose.cpp
        src/http/routes/metrics.cpp
        src/http/routes/scripting.cpp
        src/http/routes/script_types.cpp
        src/http/routes/import.cpp
        src/http/routes/diagnostics.cpp
        src/http/routes/oauth.cpp
        src/http/routes/oauth_authorize.cpp
        src/http/routes/cookies.cpp
        src/http/routes/mock_issuer.cpp
        src/http/routes/inbox.cpp
        src/http/routes/events.cpp
        src/http/routes/mock_server.cpp
    )

    target_link_libraries(vayu-engine PRIVATE
        vayu_core
        httplib::httplib
        vayu_warnings
        vayu_sanitizers
    )
    if(NOT MSVC)
        target_precompile_headers(vayu-engine PRIVATE <nlohmann/json.hpp>)
    endif()

    # Not optional on Windows - see vayu_embed_windows_manifest above. This is
    # the binary the installer ships, so .github/check-windows-deps.py verifies
    # the manifest actually survived into the artifact.
    vayu_embed_windows_manifest(vayu-engine)

    install(TARGETS vayu-engine RUNTIME DESTINATION bin)
endif()

# ============================================================================
# Tests
# ============================================================================

if(VAYU_BUILD_TESTS)
    add_executable(vayu_tests
        tests/main.cpp
        tests/http_client_test.cpp
        tests/json_test.cpp
        tests/script_engine_test.cpp
        tests/script_expect_message_test.cpp
        tests/script_assertion_error_test.cpp
        tests/script_completions_test.cpp
        tests/script_types_test.cpp
        tests/event_loop_test.cpp
        tests/db_test.cpp
        tests/db_concurrency_test.cpp
        tests/rate_limit_test.cpp
        tests/metrics_helper_test.cpp
        tests/metrics_collector_test.cpp
        tests/execution_trace_test.cpp
        tests/import_route_test.cpp
        tests/diagnostics_route_test.cpp
        tests/import_apply_route_test.cpp
        tests/config_route_test.cpp
        tests/sse_parser_test.cpp
        tests/sse_frame_counter_test.cpp
        tests/sse_load_stream_test.cpp
        tests/load_stream_events_test.cpp
        tests/sse_stream_test.cpp
        tests/transport_policy_test.cpp
        tests/tls_verification_test.cpp
        tests/client_certificates_test.cpp
        tests/mutual_tls_test.cpp
        tests/requests_route_test.cpp
        tests/examples_route_test.cpp
        tests/specs_route_test.cpp
        tests/runs_route_test.cpp
        tests/collections_route_test.cpp
        tests/resource_write_route_test.cpp
        tests/error_shape_route_test.cpp
        tests/globals_route_test.cpp
        tests/script_variables_test.cpp
        tests/load_script_scopes_test.cpp
        tests/script_info_test.cpp
        tests/script_send_request_test.cpp
        tests/script_sent_headers_test.cpp
        tests/sent_headers_wire_test.cpp
        tests/set_cookie_test.cpp
        tests/cookie_jar_test.cpp
        tests/form_body_test.cpp
        tests/graphql_body_test.cpp
        tests/jsonrpc_body_test.cpp
        tests/xml_body_test.cpp
        tests/stats_route_test.cpp
        tests/execution_timeout_test.cpp
        tests/execution_http_version_test.cpp
        tests/load_strategy_test.cpp
        tests/refill_deficit_test.cpp
        tests/reservoir_test.cpp
        tests/sample_capture_test.cpp
        tests/response_capture_test.cpp
        tests/load_pacing_test.cpp
        tests/threshold_eval_test.cpp
        tests/capacity_controller_test.cpp
        tests/monitor_test.cpp
        tests/run_manager_test.cpp
        tests/run_route_test.cpp
        tests/run_stop_test.cpp
        tests/run_shutdown_test.cpp
        tests/run_config_validation_test.cpp
        tests/run_row_seed_test.cpp
        tests/transient_execute_test.cpp
        tests/send_with_row_test.cpp
        tests/script_compose_test.cpp
        tests/encoding_test.cpp
        tests/auth_resolver_test.cpp
        tests/auth_refresh_test.cpp
        tests/request_builder_test.cpp
        tests/oauth_client_test.cpp
        tests/oauth_route_test.cpp
        tests/pkce_test.cpp
        tests/debug_redact_test.cpp
        tests/managed_listener_test.cpp
        tests/oauth_authorize_test.cpp
        tests/mock_issuer_test.cpp
        tests/inbox_test.cpp
        tests/mock_server_routes_test.cpp
        tests/id_test.cpp
        tests/curl_utils_test.cpp
        tests/curl_transfer_test.cpp
        tests/dns_cache_test.cpp
        tests/http_version_support_test.cpp
        tests/http_version_test.cpp
        tests/request_composer_test.cpp
        tests/scenario_data_test.cpp
        tests/scenario_load_test.cpp
        tests/scenario_plan_test.cpp
        tests/scenario_runner_test.cpp
        tests/tree_order_test.cpp
        tests/reorder_route_test.cpp
        tests/spec_sync_route_test.cpp
        tests/spec_match_route_test.cpp
        tests/operation_match_test.cpp
        tests/openapi_document_test.cpp
        tests/openapi_export_test.cpp
        tests/spec_export_route_test.cpp
        tests/spec_coverage_test.cpp
        tests/schema_validation_test.cpp
        tests/version_isolation_test.cpp
        src/http/routes/import.cpp
        src/http/routes/diagnostics.cpp
        src/http/routes/compose.cpp
        src/http/routes/config.cpp
        src/http/routes/requests.cpp
        src/http/routes/examples.cpp
        src/http/routes/specs.cpp
        src/http/routes/spec_sync.cpp
        src/http/routes/spec_match.cpp
        src/http/routes/spec_export.cpp
        src/http/routes/reorder.cpp
        src/http/routes/runs.cpp
        src/http/routes/collections.cpp
        src/http/routes/environments.cpp
        src/http/routes/client_certificates.cpp
        src/http/routes/globals.cpp
        src/http/routes/metrics.cpp
        src/http/routes/oauth.cpp
        src/http/routes/oauth_authorize.cpp
        src/http/routes/execution.cpp
        src/http/routes/scripting.cpp
        src/http/routes/script_types.cpp
        src/http/routes/cookies.cpp
        src/http/routes/mock_issuer.cpp
        src/http/routes/inbox.cpp
        src/http/routes/events.cpp
        src/http/routes/mock_server.cpp
        src/http/managed_listener.cpp
        # The daemon's own Server, so its shutdown ordering is testable rather
        # than only reachable by running the daemon (#646). It registers every
        # route group, which is why health.cpp joins the list here too.
        src/http/routes/health.cpp
        src/http/server.cpp
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
        "${CMAKE_CURRENT_SOURCE_DIR}/tests/*_test.cpp")
    if(NOT vayu_test_files_on_disk)
        message(FATAL_ERROR
            "Test registration guard found no tests/*_test.cpp under "
            "${CMAKE_CURRENT_SOURCE_DIR}/tests - the guard is scanning the "
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
            file(RELATIVE_PATH relative_test_file "${CMAKE_CURRENT_SOURCE_DIR}" "${test_file}")
            list(APPEND vayu_unregistered_tests "${relative_test_file}")
        endif()
    endforeach()
    if(vayu_unregistered_tests)
        string(REPLACE ";" "\n  " vayu_unregistered_tests "${vayu_unregistered_tests}")
        message(FATAL_ERROR
            "These test files exist but are not in add_executable(vayu_tests ...), "
            "so none of their tests would run:\n  ${vayu_unregistered_tests}\n"
            "Add them to the source list in engine/CMakeLists.txt.")
    endif()

    # The cross-language conformance fixture lives in the source tree and is
    # read at test runtime by path (the app's vitest suite reads the same file),
    # so the tests need to know where the sources are regardless of the build
    # or ctest working directory.
    target_compile_definitions(vayu_tests PRIVATE
        VAYU_ENGINE_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}"
    )

    target_link_libraries(vayu_tests PRIVATE
        vayu_core
        GTest::gtest
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
        CollectionsRouteTest
        ConfigRouteTest
        CustomCaVerificationTest
        DatabaseConcurrencyTest
        DatabaseTest
        DeleteRunTest
        ErrorShapeRouteTest
        ExamplesRouteTest
        GlobalsRouteTest
        ImportApplyRouteTest
        InboxListenerTest
        InboxStorageTest
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
        SpecExportRouteTest
        SpecMatchRouteTest
        SpecSyncRouteTest
        SpecsRouteTest
        SseLimitsTest
        SseServerShutdownTest
        StatsRouteTest
        StreamExecuteTest
        StreamedSampleRouteTest
        TransportPolicyDbTest
        TreeOrderTest
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
                    "${CMAKE_CURRENT_SOURCE_DIR}" "${test_file}")
                list(APPEND vayu_unrepresented_database_files "${vayu_relative_test_file}")
            endif()
        endif()
    endforeach()
    if(NOT vayu_declared_test_suites)
        message(FATAL_ERROR
            "Found no TEST/TEST_F declarations under ${CMAKE_CURRENT_SOURCE_DIR}/tests - "
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
            "Add the suites that open a Database to the list in engine/CMakeLists.txt.")
    endif()

    # Discover tests for CTest. A per-test TIMEOUT acts as a safety net so a
    # deadlock (e.g. a thread-pool teardown hang) is reported as a failure
    # instead of blocking the suite indefinitely; healthy tests finish in <10s.
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

    set(vayu_scratch_database_properties TIMEOUT 60)
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
        PROPERTIES TIMEOUT 60
    )
endif()

# ============================================================================
# Summary
# ============================================================================

message(STATUS "")
message(STATUS "Vayu Engine Configuration Summary")
message(STATUS "==================================")
message(STATUS "Version:        ${PROJECT_VERSION}")
message(STATUS "Build type:     ${CMAKE_BUILD_TYPE}")
message(STATUS "C++ Standard:   ${CMAKE_CXX_STANDARD}")
message(STATUS "Compiler:       ${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")
message(STATUS "")
message(STATUS "Options:")
message(STATUS "  Build CLI:    ${VAYU_BUILD_CLI}")
message(STATUS "  Build Engine: ${VAYU_BUILD_ENGINE}")
message(STATUS "  Build Tests:  ${VAYU_BUILD_TESTS}")
message(STATUS "  ASan:         ${VAYU_USE_ASAN}")
message(STATUS "  TSan:         ${VAYU_USE_TSAN}")
message(STATUS "")
message(STATUS "Dependencies:")
message(STATUS "  CURL:         ${CURL_VERSION_STRING}")
message(STATUS "  QuickJS:      ${QUICKJS_FOUND}")
message(STATUS "")
