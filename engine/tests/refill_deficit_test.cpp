/**
 * @file refill_deficit_test.cpp
 * @brief Unit tests for the pure closed-loop refill decision.
 */

#include "vayu/core/refill_deficit.hpp"

#include <array>
#include <cstddef>
#include <gtest/gtest.h>
#include <limits>
#include <string>

using vayu::core::compute_refill_deficit;

namespace {

constexpr size_t UNBOUNDED = std::numeric_limits<size_t>::max ();

struct RefillDeficitCase {
    const char* name;
    size_t target;
    size_t in_flight;
    size_t budget;
    size_t expected;
};

constexpr auto REFILL_DEFICIT_CASES = std::to_array<RefillDeficitCase> ({
// target 50, 30 in flight, unbounded budget -> need 20
{ "RefillsUpToTargetWhenBelow", 50, 30, UNBOUNDED, 20 },
{ "ZeroWhenAtTarget", 50, 50, UNBOUNDED, 0 },
{ "ZeroWhenAboveTarget", 50, 70, UNBOUNDED, 0 },
// want 20 but only 5 of the iteration budget remain
{ "ClampsToBudget", 50, 30, 5, 5 },
{ "ZeroBudgetSubmitsNothing", 50, 0, 0, 0 },
{ "FullSeedFromEmpty", 50, 0, UNBOUNDED, 50 },
});

} // namespace

class RefillDeficit : public ::testing::TestWithParam<RefillDeficitCase> {};

TEST_P (RefillDeficit, ComputesTheDeficit) {
    const auto& c = GetParam ();
    EXPECT_EQ (compute_refill_deficit (c.target, c.in_flight, c.budget), c.expected);
}

INSTANTIATE_TEST_SUITE_P (RefillDeficit,
RefillDeficit,
::testing::ValuesIn (REFILL_DEFICIT_CASES),
[] (const ::testing::TestParamInfo<RefillDeficitCase>& info) {
    return std::string (info.param.name);
});
