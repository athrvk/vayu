cmake_minimum_required(VERSION 3.25)

project(vayu-engine
    VERSION 0.1.1
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

if(WIN32)
    # Windows: Use QuickJS-NG (MSVC compatible)
    set(QUICKJS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/quickjs-ng)
    
    if(EXISTS ${QUICKJS_DIR}/CMakeLists.txt)
        # Configure QuickJS-NG
        set(QJS_BUILD_EXAMPLES OFF CACHE BOOL "Disable QuickJS examples" FORCE)
        set(QJS_BUILD_LIBC OFF CACHE BOOL "Disable QuickJS libc build in library" FORCE)

        # Add QuickJS-NG as a subdirectory
        add_subdirectory(${QUICKJS_DIR} ${CMAKE_BINARY_DIR}/quickjs-ng EXCLUDE_FROM_ALL)
        
        if(TARGET qjs)
            add_library(quickjs ALIAS qjs)
            set(QUICKJS_FOUND TRUE)
            message(STATUS "Found and configured QuickJS-NG (Windows) at ${QUICKJS_DIR}")
        else()
            message(WARNING "QuickJS-NG target 'qjs' not found after add_subdirectory")
            set(QUICKJS_FOUND FALSE)
        endif()
    else()
        message(WARNING "QuickJS-NG not found in vendor/quickjs-ng. Scripting will be disabled on Windows.")
        set(QUICKJS_FOUND FALSE)
    endif()
else()
    # Linux/macOS: Use original QuickJS
    set(QUICKJS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/quickjs)
    
    if(EXISTS ${QUICKJS_DIR}/quickjs.c)
        add_library(quickjs STATIC
            ${QUICKJS_DIR}/quickjs.c
            ${QUICKJS_DIR}/libregexp.c
            ${QUICKJS_DIR}/libunicode.c
            ${QUICKJS_DIR}/cutils.c
            ${QUICKJS_DIR}/libbf.c
        )
        target_include_directories(quickjs PUBLIC ${QUICKJS_DIR})
        target_compile_definitions(quickjs PRIVATE
            CONFIG_VERSION="2024-01-13"
            CONFIG_BIGNUM
        )
        
        # GCC/Clang: Disable warnings for vendored code
        target_compile_options(quickjs PRIVATE -w)
        
        # Disable clang-tidy for vendored code
        set_target_properties(quickjs PROPERTIES C_CLANG_TIDY "" CXX_CLANG_TIDY "")
        
        set(QUICKJS_FOUND TRUE)
        message(STATUS "Found and configured QuickJS (Unix) at ${QUICKJS_DIR}")
    else()
        message(WARNING "QuickJS not found in vendor/quickjs. Scripting will be disabled.")
        set(QUICKJS_FOUND FALSE)
    endif()
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
    src/http/event_loop.cpp
    src/http/event_loop/curl_callbacks.cpp
    src/http/event_loop/transfer_context.cpp
    src/http/event_loop/curl_utils.cpp
    src/http/event_loop/event_loop_worker.cpp
    src/http/event_loop/event_loop_impl.cpp
    src/http/thread_pool.cpp
    src/http/rate_limiter.cpp
    src/http/sse.cpp
    src/utils/json.cpp
    src/utils/logger.cpp
    src/utils/metrics_helper.cpp
    src/db/database.cpp
    src/core/load_strategy.cpp
    src/core/run_manager.cpp
    src/core/metrics_collector.cpp
    ${PLATFORM_SOURCES}
)

target_include_directories(vayu_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(vayu_core PUBLIC
    CURL::libcurl
    nlohmann_json::nlohmann_json
    unofficial::sqlite3::sqlite3
    sqlite_orm::sqlite_orm
    hdrhistogram
    vayu_warnings
    vayu_sanitizers
)

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
        src/http/routes/environments.cpp
        src/http/routes/globals.cpp
        src/http/routes/runs.cpp
        src/http/routes/execution.cpp
        src/http/routes/metrics.cpp
        src/http/routes/scripting.cpp
    )
    
    target_link_libraries(vayu-engine PRIVATE
        vayu_core
        httplib::httplib
        vayu_warnings
        vayu_sanitizers
    )
    
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
        tests/event_loop_test.cpp
        tests/sse_test.cpp
        tests/db_test.cpp
        tests/rate_limit_test.cpp
        tests/metrics_helper_test.cpp
        tests/metrics_collector_test.cpp
    )
    
    target_link_libraries(vayu_tests PRIVATE
        vayu_core
        GTest::gtest
        GTest::gtest_main
        httplib::httplib
        vayu_warnings
        vayu_sanitizers
    )

    # Discover tests for CTest
    include(GoogleTest)
    gtest_discover_tests(vayu_tests)
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
