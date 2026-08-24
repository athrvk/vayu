cmake_minimum_required(VERSION 3.25)

project(vayu-engine
    VERSION 0.23.0
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

# Treat compiler warnings as errors. Off for local dev so a work-in-progress
# build is not blocked by a warning, on in CI so a warning cannot merge - the
# warning set below is only a gate if something fails on it. #900 took the
# inventory to zero; this is what keeps it there. CI passes -DVAYU_WERROR=ON;
# the legacy VAYU_STRICT_BUILD environment variable still turns it on (default
# only - an explicit -DVAYU_WERROR wins) so an existing local workflow keeps
# working. See docs/engine/building.md.
set(_vayu_werror_default OFF)
if(DEFINED ENV{VAYU_STRICT_BUILD}
   AND NOT "$ENV{VAYU_STRICT_BUILD}" STREQUAL ""
   AND NOT "$ENV{VAYU_STRICT_BUILD}" STREQUAL "0")
    set(_vayu_werror_default ON)
endif()
option(VAYU_WERROR "Treat compiler warnings as errors (CI gate)" ${_vayu_werror_default})

# ============================================================================
# C++ Standard and Compiler Settings
# ============================================================================

set(CMAKE_CXX_STANDARD 23)
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

# clang-tidy is deliberately not wired into the build (#885). There used to be a
# commented-out `CMAKE_CXX_CLANG_TIDY` block here, and it was the third of three
# layers that could not stop anything: a lint that runs only when someone
# uncomments it is a lint that never runs, and uncommenting it re-lints the whole
# tree on every build, including the vendored sources the configs exclude. The
# `CMAKE_PROGRAM_PATH` append that pointed `find_program` at Homebrew's LLVM on
# macOS went with it - nothing here looks for a program any more, and the hook
# does its own PATH prepend.
#
# The two layers that do bind are the `scripts/pre-commit` hook, which lints
# staged files and refuses the commit on a finding, and the `Lint changed engine
# sources` step in .github/workflows/pr-tests.yml, which lints the sources a pull
# request changes before it can merge. `CMAKE_EXPORT_COMPILE_COMMANDS` above is
# what both of them read the compile flags from. See docs/engine/building.md.

# ============================================================================
# Compiler Warnings
# ============================================================================

add_library(vayu_warnings INTERFACE)

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(vayu_warnings INTERFACE
        -Wall
        -Wextra
        -Wpedantic
        $<$<BOOL:${VAYU_WERROR}>:-Werror>
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
        # /WX is unconditional on MSVC and predates VAYU_WERROR: Windows CI has
        # always built warnings-as-errors, so what keeps it green is the list
        # below rather than a strict/lax toggle.
        /WX
        /permissive-
        /FS
        # Not a warning flag, and here for the same reason /FS is: it is MSVC
        # build hygiene the whole tree needs. `database.cpp` instantiates
        # enough of sqlite_orm's templates to exceed the COFF section limit -
        # `fatal error C1128` - as soon as inlining is off, which is every
        # Debug configuration. Release never hit it (/O2 folds the sections
        # away) and windows-dev has no CI leg, so the first build to fail on it
        # was windows-asan, where /Od plus ASan instrumentation makes it
        # unmissable. /bigobj only raises that limit; it costs nothing where it
        # is not needed.
        /bigobj
        # 4324: 'structure was padded due to alignas' - deliberate, on the
        # cache-line-aligned SPSC queue members (spsc_queue.hpp); the padding
        # is the point. Permanent.
        /wd4324
        # 4100: 'unreferenced formal parameter' - the -Wno-unused-parameter
        # counterpart above; interface signatures keep named parameters for
        # documentation even where one leg does not use them. Permanent.
        /wd4100
        # 4101 ('unreferenced local variable'), 4456 ('declaration hides
        # previous local') and 4244 ('conversion, possible loss of data') used
        # to be suppressed here and are not any more (issue #884). Each hid a
        # real defect class - 4244 is precisely what -Wconversion catches on the
        # GCC/Clang legs - and removing them found one: the `data` shadow in
        # event_loop_worker.cpp, which no warning we enable elsewhere reports.
    )
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang" AND CMAKE_SYSTEM_NAME MATCHES "Linux")
    target_compile_options(vayu_warnings INTERFACE
        -Wno-deprecated-declarations
        -Wno-implicit-int-float-conversion
    )
    # -Wno-missing-designated-field-initializers landed in Clang 19. Passing it
    # to an older Clang is a -Wunknown-warning-option warning, which VAYU_WERROR
    # turns into a build failure - so the suppression itself would break every
    # strict build on Clang 18 (Ubuntu 24.04's default) rather than quieten it.
    if(CMAKE_CXX_COMPILER_VERSION VERSION_GREATER_EQUAL 19)
        target_compile_options(vayu_warnings INTERFACE
            -Wno-missing-designated-field-initializers
        )
    endif()
endif()

# ============================================================================
# Sanitizers
# ============================================================================

add_library(vayu_sanitizers INTERFACE)

if(VAYU_USE_ASAN)
    message(STATUS "AddressSanitizer enabled")
    if(MSVC)
        # MSVC spells it with a slash and links the ASan runtime itself, so
        # there is no link option to match - passing `-fsanitize=address` here
        # would be swallowed as an unknown flag and the build would come out
        # unsanitized while looking green.
        #
        # Two MSVC features are incompatible with it, and both are on by
        # default in the configurations this repo builds: `/RTC1`, which CMake
        # puts in CMAKE_<LANG>_FLAGS_DEBUG, and incremental linking. Neither is
        # load-bearing - /RTC1's stack checks are a strict subset of what ASan
        # reports - so they are removed rather than made the caller's problem.
        # ASan against the static CRT this repo links (CMAKE_MSVC_RUNTIME_LIBRARY
        # MultiThreaded... in the windows-* presets) is supported from VS 2019
        # 16.9 on.
        target_compile_options(vayu_sanitizers INTERFACE /fsanitize=address)
        target_link_options(vayu_sanitizers INTERFACE /INCREMENTAL:NO)
        # The vcpkg dependencies are prebuilt without ASan, and MSVC's STL
        # makes that a *link* error rather than a silent mismatch: under
        # /fsanitize=address it turns on container overflow annotations for
        # string, vector and optional, and stamps each translation unit with a
        # `detect_mismatch` record. Ours say 1, ryml's and c4core's say 0, and
        # the linker refuses - `LNK2038 ... annotate_string`, 18 of them,
        # ending in LNK1319.
        #
        # Turning the annotations off on our side is Microsoft's documented
        # answer for linking against libraries that were not built with ASan,
        # and it is the only one available here: instrumenting the dependencies
        # would need a custom triplet, and their archives are shared byte for
        # byte with every other workflow's vcpkg cache.
        #
        # `_DISABLE_STL_ANNOTATION` is the STL's own umbrella switch: it
        # defines _DISABLE_STRING_ANNOTATION, _DISABLE_VECTOR_ANNOTATION and
        # _DISABLE_OPTIONAL_ANNOTATION itself
        # (stl/inc/__msvc_sanitizer_annotate_container.hpp). Naming the three
        # individually would work today and rot the day Microsoft annotates a
        # fourth container - the link would fail again on a record nobody
        # listed. It must also be all or nothing: microsoft/STL#6186 documents
        # that disabling *some* annotations leaves the runtime's
        # `_Asan_..._should_annotate` flags true against uninstrumented code,
        # which is a genuine memory-safety hazard, while disabling all of them
        # is benign.
        #
        # What it costs is bounded and worth naming: ASan on Windows no longer
        # catches an overflow that stays inside a container's *spare capacity*
        # - writing past `size()` but within `capacity()` of a vector, string
        # or optional. Every other check is untouched: heap, stack and global
        # overflow, use-after-free, double-free, use-after-return. The Linux
        # and macOS legs keep container annotations, so nothing is lost from
        # the matrix as a whole - only from the Windows leg alone.
        target_compile_definitions(vayu_sanitizers INTERFACE _DISABLE_STL_ANNOTATION)
        foreach(_vayu_rtc_flags
                CMAKE_C_FLAGS_DEBUG CMAKE_CXX_FLAGS_DEBUG
                CMAKE_C_FLAGS_RELWITHDEBINFO CMAKE_CXX_FLAGS_RELWITHDEBINFO)
            string(REGEX REPLACE "/RTC[1csu]+" "" ${_vayu_rtc_flags} "${${_vayu_rtc_flags}}")
        endforeach()
    else()
        target_compile_options(vayu_sanitizers INTERFACE -fsanitize=address -fno-omit-frame-pointer)
        target_link_options(vayu_sanitizers INTERFACE -fsanitize=address)
    endif()
endif()

if(VAYU_USE_TSAN)
    # ThreadSanitizer does not exist on MSVC, and clang-cl does not implement it
    # on Windows either. Without this the flags below would be dropped as
    # unknown and the build would report "ThreadSanitizer enabled" while
    # producing an ordinary binary - a green run that proves nothing. Fail at
    # configure instead.
    if(MSVC)
        message(FATAL_ERROR
            "VAYU_USE_TSAN is not supported on MSVC - ThreadSanitizer has no "
            "Windows implementation. Use VAYU_USE_ASAN on Windows, and run TSan "
            "on Linux or macOS (presets linux-tsan / macos-tsan).")
    endif()
    message(STATUS "ThreadSanitizer enabled")
    target_compile_options(vayu_sanitizers INTERFACE -fsanitize=thread -fno-omit-frame-pointer)
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
        # ...and its *headers* are system headers to whoever includes them.
        # Building the vendored sources quietly is only half the exemption: on
        # a plain -I, a diagnostic inside quickjs.h is attributed to our
        # translation unit and, under VAYU_WERROR, fails our build for third
        # party code we do not maintain. macOS is where this bites - the SDK
        # spells NAN as __builtin_nanf, so `v.u.float64 = NAN` in quickjs.h is
        # a -Wdouble-promotion error there and nowhere else.
        get_target_property(_qjs_include_dirs qjs INTERFACE_INCLUDE_DIRECTORIES)
        if(_qjs_include_dirs)
            set_target_properties(qjs PROPERTIES
                INTERFACE_SYSTEM_INCLUDE_DIRECTORIES "${_qjs_include_dirs}")
        endif()
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
    # SYSTEM for the same reason as quickjs above: vendored headers must not
    # fail a consumer's build under VAYU_WERROR.
    target_include_directories(hdrhistogram SYSTEM PUBLIC ${HDRHISTOGRAM_DIR}/include)
    
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
# (issue #215). The engine selects OpenSSL at startup, so that path is dormant
# rather than gone: Schannel is still compiled into this build (MultiSSL) and
# leaves it with #858, which is when this function and both its guards retire.
# The full chain and the enumeration behind that decision (#856) are written
# out in the manifest file itself; read that before removing any of this.
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
    src/db/recovery.cpp
    src/core/auth_refresh.cpp
    src/core/load_strategy.cpp
    src/core/scenario_data.cpp
    src/core/scenario_load.cpp
    src/core/scenario_plan.cpp
    src/core/scenario_runner.cpp
    src/core/operation_match.cpp
    src/core/import_document.cpp
    src/core/openapi_document.cpp
    src/core/openapi_drafts.cpp
    src/core/openapi_export.cpp
    src/core/path_template.cpp
    src/core/spec_binding.cpp
    src/core/spec_diff.cpp
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
        src/http/routes/spec_diff.cpp
        src/http/routes/spec_describe.cpp
        src/http/routes/spec_bind.cpp
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
        tests/db_recovery_test.cpp
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
        tests/spec_diff_route_test.cpp
        tests/spec_describe_route_test.cpp
        tests/spec_bind_route_test.cpp
        tests/operation_match_test.cpp
        tests/openapi_document_test.cpp
        tests/import_parse_test.cpp
        tests/openapi_drafts_test.cpp
        tests/spec_diff_test.cpp
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
        src/http/routes/spec_diff.cpp
        src/http/routes/spec_describe.cpp
        src/http/routes/spec_bind.cpp
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
