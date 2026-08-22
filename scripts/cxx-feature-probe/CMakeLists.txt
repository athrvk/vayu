# The C++ standard floor probe (issue #901, phase 0).
#
# Compiles one tiny translation unit per language/library feature at the
# standard set below, on whatever toolchain it is pointed at, and reports a
# pass/fail table. It answers "does this feature exist on this platform's CI
# compiler", which is the question a standard bump turns from folklore into a
# decision - and it answers it again later, for the next standard, by changing
# VAYU_PROBE_STANDARD rather than by rewriting anything.
#
# It is deliberately not part of the engine build: nothing here is compiled
# into a Vayu artifact, and the engine's own standard (engine/CMakeLists.txt)
# is not read or written by this project. Run it from CI
# (.github/workflows/cxx-feature-probe.yml) or by hand:
#
#   cmake -S scripts/cxx-feature-probe -B /tmp/probe            # default compiler
#   cmake -S scripts/cxx-feature-probe -B /tmp/probe \
#         -DCMAKE_CXX_COMPILER=g++-14                           # a specific one
#
# Everything happens at configure time - there is no build step, and the table
# lands in the log and in <build dir>/probe-results.md.

cmake_minimum_required(VERSION 3.25)

project(vayu-cxx-feature-probe LANGUAGES CXX)

set(VAYU_PROBE_STANDARD "23" CACHE STRING "C++ standard to probe (a CMAKE_CXX_STANDARD value)")

# The dialect self-check below asserts "newer than C++20", which is what makes
# it robust across compilers that report an in-progress __cplusplus value. That
# only works for standards after the engine's own baseline, so refuse anything
# older loudly rather than reporting a table the self-check would have to lie
# about.
if(VAYU_PROBE_STANDARD LESS 23)
    message(FATAL_ERROR
        "VAYU_PROBE_STANDARD is '${VAYU_PROBE_STANDARD}': this probe only measures standards "
        "newer than the engine's C++20 baseline (23, 26, ...).")
endif()

include(CheckCXXSourceCompiles)

# CMP0067 (NEW under the 3.25 minimum above) is what makes try_compile - and so
# every check below - honour CMAKE_CXX_STANDARD. Without it each probe would be
# compiled at the compiler's *default* dialect and the whole table would be a
# measurement of the wrong thing; the dialect self-check below exists so that a
# silent failure of this cannot be mistaken for a feature verdict.
set(CMAKE_CXX_STANDARD ${VAYU_PROBE_STANDARD})
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(_probe_sources "${CMAKE_CURRENT_LIST_DIR}/probes")
set(_probe_rows "")

# One row of the report. `key` is what the reader sees, `source` is a file
# under probes/, `note` is why the answer matters to #901.
function(vayu_probe key source note)
    file(READ "${_probe_sources}/${source}" _code)
    string(MAKE_C_IDENTIFIER "VAYU_PROBE_${source}" _cache_var)
    # Each configure re-measures: a cached verdict from a previous compiler
    # would be worse than no verdict at all.
    unset(${_cache_var} CACHE)
    check_cxx_source_compiles("${_code}" ${_cache_var})
    if(${_cache_var})
        set(_verdict "yes")
    else()
        set(_verdict "**no**")
    endif()
    set(_probe_rows "${_probe_rows}| `${key}` | ${_verdict} | ${note} |\n" PARENT_SCOPE)
endfunction()

set(_report "## C++${VAYU_PROBE_STANDARD} feature probe\n\n")
set(_report "${_report}- platform: `${CMAKE_SYSTEM_NAME}`\n")
set(_report "${_report}- compiler: `${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}` (`${CMAKE_CXX_COMPILER}`)\n")
set(_report "${_report}- cmake: `${CMAKE_VERSION}`\n\n")

if(NOT "cxx_std_${VAYU_PROBE_STANDARD}" IN_LIST CMAKE_CXX_COMPILE_FEATURES)
    # A real, reportable fact about this toolchain rather than a broken run:
    # the compiler offers no flag for this standard at all.
    set(_report "${_report}This toolchain offers no C++${VAYU_PROBE_STANDARD} dialect (no `cxx_std_${VAYU_PROBE_STANDARD}` in `CMAKE_CXX_COMPILE_FEATURES`), so no feature was probed.\n")
else()
    # The self-check first: a probe result is only meaningful if the dialect
    # actually reached the compiler. See probes/dialect_selected.cpp.
    file(READ "${_probe_sources}/dialect_selected.cpp" _dialect_check)
    unset(VAYU_PROBE_DIALECT CACHE)
    check_cxx_source_compiles("${_dialect_check}" VAYU_PROBE_DIALECT)
    if(NOT VAYU_PROBE_DIALECT)
        # Not a verdict about the toolchain - the probe itself is broken, and
        # saying so loudly is the only honest outcome.
        message(FATAL_ERROR
            "The probe did not compile at C++${VAYU_PROBE_STANDARD}: the dialect self-check "
            "failed although the compiler advertises cxx_std_${VAYU_PROBE_STANDARD}. Results would "
            "measure the default dialect, so none were produced.")
    endif()

    vayu_probe("std::expected"            std_expected.cpp        "phase 2.1 - the two optional-as-error APIs")
    vayu_probe("std::optional (monadic)"  optional_monadic.cpp    "phase 2.3 - adopt in touched code")
    vayu_probe("std::move_only_function"  move_only_function.cpp  "phase 2.2 - the thread pool queue")
    vayu_probe("std::format"              std_format.cpp          "C++20 already - the five ostringstream sites")
    vayu_probe("std::print"               std_print.cpp           "non-goal unless all three legs offer it")
    vayu_probe("std::ranges::to"          ranges_to.cpp           "non-goal - no ranges rewrite planned")
    vayu_probe("std::stacktrace"          std_stacktrace.cpp      "non-goal - probed compiling *and linking*")
    vayu_probe("deducing this"            deducing_this.cpp       "non-goal unless all three legs offer it")
    vayu_probe("std::flat_map"            flat_map.cpp            "dropped from the plan - libstdc++ 15")

    set(_report "${_report}| Feature | Available | Note |\n|---|---|---|\n${_probe_rows}")
endif()

file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/probe-results.md" "${_report}")

# The log copy, so a job that never reaches the summary step still says what it
# found.
string(REPLACE "\n" ";" _report_lines "${_report}")
message(STATUS "----- C++${VAYU_PROBE_STANDARD} feature probe -----")
foreach(_line IN LISTS _report_lines)
    message(STATUS "${_line}")
endforeach()
