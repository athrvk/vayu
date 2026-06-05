/**
 * @file refill_deficit_test.cpp
 * @brief Unit tests for the pure closed-loop refill decision.
 */

#include "vayu/core/refill_deficit.hpp"

#include <gtest/gtest.h>
#include <cstddef>
#include <limits>

using vayu::core::compute_refill_deficit;

TEST (RefillDeficit, RefillsUpToTargetWhenBelow) {
    // target 50, 30 in flight, unbounded budget -> need 20
    EXPECT_EQ (compute_refill_deficit (50, 30, std::numeric_limits<size_t>::max ()), 20u);
}

TEST (RefillDeficit, ZeroWhenAtOrAboveTarget) {
    EXPECT_EQ (compute_refill_deficit (50, 50, std::numeric_limits<size_t>::max ()), 0u);
    EXPECT_EQ (compute_refill_deficit (50, 70, std::numeric_limits<size_t>::max ()), 0u);
}

TEST (RefillDeficit, ClampsToBudget) {
    // want 20 but only 5 of the iteration budget remain
    EXPECT_EQ (compute_refill_deficit (50, 30, 5), 5u);
}

TEST (RefillDeficit, ZeroBudgetSubmitsNothing) {
    EXPECT_EQ (compute_refill_deficit (50, 0, 0), 0u);
}

TEST (RefillDeficit, FullSeedFromEmpty) {
    EXPECT_EQ (compute_refill_deficit (50, 0, std::numeric_limits<size_t>::max ()), 50u);
}
