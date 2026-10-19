# Proves the gtest shards ran the whole suite between them, once each.
#
# Registered by engine/tests/CMakeLists.txt as `vayu_tests_shard_coverage`
# whenever VAYU_TEST_SHARDS is set, ordered after every shard. A sharded suite
# is green when each shard is green, and two failures pass that test: a shard
# that ran nothing (an index gtest does not recognise), and a binary that
# ignored the sharding variables, so each shard ran everything. The first
# loses coverage silently, the second triples the run. Counting closes both:
# every shard must have run something, and the shards' totals must sum to the
# number of tests the binary lists.
#
# Inputs: TEST_BINARY (the vayu_tests executable), SHARD_DIR (where each shard
# wrote shard_<i>.json through --gtest_output), SHARDS (how many).
#
# The shard files are removed once read, so a stale file from an earlier run
# in the same build tree can never stand in for a shard that wrote nothing.

foreach(var TEST_BINARY SHARD_DIR SHARDS)
    if(NOT DEFINED ${var})
        message(FATAL_ERROR "check_shard_coverage.cmake: ${var} is not set")
    endif()
endforeach()

# No GTEST_* sharding variables reach this process (the ENVIRONMENT property
# is set on the shards only), so the listing is the whole suite.
execute_process(
    COMMAND "${TEST_BINARY}" --gtest_list_tests
    OUTPUT_VARIABLE listing
    RESULT_VARIABLE list_result
)
if(NOT list_result EQUAL 0)
    message(FATAL_ERROR "${TEST_BINARY} --gtest_list_tests exited with ${list_result}")
endif()
# gtest lists a suite flush left and each of its tests indented by two spaces.
# A `;` is a CMake list separator, and a parameterized test's GetParam()
# comment can hold one, so it is neutralised first or that line counts twice.
string(REPLACE ";" "," listing "${listing}")
string(REGEX MATCHALL "\n  [^ \n][^\n]*" listed_tests "\n${listing}")
list(LENGTH listed_tests expected)
if(expected EQUAL 0)
    message(FATAL_ERROR "${TEST_BINARY} listed no tests - this check would pass any shard result")
endif()

math(EXPR last_shard "${SHARDS} - 1")
set(ran 0)
foreach(shard RANGE ${last_shard})
    set(report "${SHARD_DIR}/shard_${shard}.json")
    if(NOT EXISTS "${report}")
        message(FATAL_ERROR "Shard ${shard} wrote no report at ${report}")
    endif()
    file(READ "${report}" content)
    file(REMOVE "${report}")
    string(JSON shard_tests GET "${content}" tests)
    if(shard_tests EQUAL 0)
        message(FATAL_ERROR "Shard ${shard} of ${SHARDS} ran no tests")
    endif()
    message(STATUS "Shard ${shard}: ${shard_tests} tests")
    math(EXPR ran "${ran} + ${shard_tests}")
endforeach()

if(NOT ran EQUAL expected)
    message(FATAL_ERROR
        "The ${SHARDS} shards ran ${ran} tests between them; the binary lists ${expected}")
endif()
message(STATUS "The ${SHARDS} shards ran all ${expected} tests between them")
