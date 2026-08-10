cmake_minimum_required(VERSION 3.25)

project(vayu-engine
    VERSION 0.15.0
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
    src/http/cookie_jar.cpp
    src/http/form_body.cpp
    src/http/graphql_body.cpp
    src/utils/json.cpp
    src/utils/logger.cpp
    src/utils/metrics_helper.cpp
    src/utils/id.cpp
    src/db/database.cpp
    src/core/load_strategy.cpp
    src/core/scenario_data.cpp
    src/core/scenario_load.cpp
    src/core/scenario_plan.cpp
    src/core/scenario_runner.cpp
    src/core/run_manager.cpp
    src/core/metrics_collector.cpp
    src/core/sample_capture.cpp
    src/core/threshold_eval.cpp
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
        vayu_warnings
        vayu_sanitizers
    )

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
        src/http/routes/health.cpp
        src/http/routes/config.cpp
        src/http/routes/collections.cpp
        src/http/routes/requests.cpp
        src/http/routes/reorder.cpp
        src/http/routes/environments.cpp
        src/http/routes/globals.cpp
        src/http/routes/runs.cpp
        src/http/routes/execution.cpp
        src/http/routes/compose.cpp
        src/http/routes/metrics.cpp
        src/http/routes/scripting.cpp
        src/http/routes/script_types.cpp
        src/http/routes/import.cpp
        src/http/routes/oauth.cpp
        src/http/routes/oauth_authorize.cpp
        src/http/routes/cookies.cpp
    )

    target_link_libraries(vayu-engine PRIVATE
        vayu_core
        httplib::httplib
        vayu_warnings
        vayu_sanitizers
    )

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
        tests/import_apply_route_test.cpp
        tests/config_route_test.cpp
        tests/requests_route_test.cpp
        tests/runs_route_test.cpp
        tests/collections_route_test.cpp
        tests/resource_write_route_test.cpp
        tests/error_shape_route_test.cpp
        tests/globals_route_test.cpp
        tests/script_variables_test.cpp
        tests/script_info_test.cpp
        tests/script_send_request_test.cpp
        tests/script_sent_headers_test.cpp
        tests/set_cookie_test.cpp
        tests/cookie_jar_test.cpp
        tests/form_body_test.cpp
        tests/graphql_body_test.cpp
        tests/stats_route_test.cpp
        tests/execution_timeout_test.cpp
        tests/execution_http_version_test.cpp
        tests/load_strategy_test.cpp
        tests/refill_deficit_test.cpp
        tests/reservoir_test.cpp
        tests/sample_capture_test.cpp
        tests/load_pacing_test.cpp
        tests/threshold_eval_test.cpp
        tests/run_manager_test.cpp
        tests/run_route_test.cpp
        tests/run_stop_test.cpp
        tests/run_shutdown_test.cpp
        tests/run_config_validation_test.cpp
        tests/run_row_seed_test.cpp
        tests/transient_execute_test.cpp
        tests/script_compose_test.cpp
        tests/encoding_test.cpp
        tests/auth_resolver_test.cpp
        tests/request_builder_test.cpp
        tests/oauth_client_test.cpp
        tests/oauth_route_test.cpp
        tests/pkce_test.cpp
        tests/debug_redact_test.cpp
        tests/oauth_authorize_test.cpp
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
        src/http/routes/import.cpp
        src/http/routes/compose.cpp
        src/http/routes/config.cpp
        src/http/routes/requests.cpp
        src/http/routes/reorder.cpp
        src/http/routes/runs.cpp
        src/http/routes/collections.cpp
        src/http/routes/environments.cpp
        src/http/routes/globals.cpp
        src/http/routes/metrics.cpp
        src/http/routes/oauth.cpp
        src/http/routes/oauth_authorize.cpp
        src/http/routes/execution.cpp
        src/http/routes/scripting.cpp
        src/http/routes/script_types.cpp
        src/http/routes/cookies.cpp
    )
    
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

    # The test binary needs the manifest for two reasons: any test that opens a
    # TLS connection would otherwise run without ALPN, and `WindowsOsVersionShim`
    # in http_version_support_test.cpp asserts on *this* process's view of the OS
    # version - which is only meaningful if this process is manifested the same
    # way vayu-engine is.
    vayu_embed_windows_manifest(vayu_tests)

    # Discover tests for CTest. A per-test TIMEOUT acts as a safety net so a
    # deadlock (e.g. a thread-pool teardown hang) is reported as a failure
    # instead of blocking the suite indefinitely; healthy tests finish in <10s.
    include(GoogleTest)
    gtest_discover_tests(vayu_tests PROPERTIES TIMEOUT 60)
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
