/**
 * @file reservoir_test.cpp
 * @brief Tests for the pure Algorithm R retention decision
 */

#include "vayu/core/reservoir.hpp"

#include <gtest/gtest.h>

#include <set>

using vayu::core::reservoir_slot;

// Below capacity every candidate is kept, in arrival order - a short run must
// retain exactly what it produced, with no sampling artefacts at all.
TEST (ReservoirSlot, AppendsInOrderUntilCapacityIsReached) {
    for (size_t seen = 0; seen < 4; ++seen) {
        const auto slot = reservoir_slot (seen, 4, 12345);
        EXPECT_TRUE (slot.accepted);
        EXPECT_TRUE (slot.append);
        EXPECT_EQ (slot.index, seen);
    }
}

// Past capacity the draw decides: an index inside the reservoir replaces that
// incumbent, an index outside it drops the candidate. This is what makes the
// retained set uniform over the whole stream instead of its prefix.
TEST (ReservoirSlot, PastCapacityTheDrawDecidesReplaceOrDrop) {
    // seen = 9 -> modulus 10. capacity 4: draws 0-3 replace, 4-9 drop.
    for (uint64_t draw = 0; draw < 4; ++draw) {
        const auto slot = reservoir_slot (9, 4, draw);
        EXPECT_TRUE (slot.accepted) << "draw " << draw;
        EXPECT_FALSE (slot.append);
        EXPECT_EQ (slot.index, draw);
    }
    for (uint64_t draw = 4; draw < 10; ++draw) {
        EXPECT_FALSE (reservoir_slot (9, 4, draw).accepted) << "draw " << draw;
    }
}

// The acceptance probability must be capacity/(seen+1) - the Algorithm R
// invariant. Counted exactly over one full period of the modulus rather than
// sampled, so this cannot pass by luck.
TEST (ReservoirSlot, AcceptanceRateIsCapacityOverStreamLength) {
    constexpr size_t capacity = 7;
    constexpr size_t seen = 99; // stream length 100 including this candidate

    size_t accepted = 0;
    std::set<size_t> indices;
    for (uint64_t draw = 0; draw < seen + 1; ++draw) {
        const auto slot = reservoir_slot (seen, capacity, draw);
        if (slot.accepted) {
            accepted++;
            indices.insert (slot.index);
        }
    }

    EXPECT_EQ (accepted, capacity);
    // Every incumbent is reachable, so no slot is pinned to the run's opening.
    EXPECT_EQ (indices.size (), capacity);
}

// A huge draw must still land in range: the modulus is what bounds it, and an
// out-of-range index would be an out-of-bounds write into the store.
TEST (ReservoirSlot, LargeDrawsStayInsideTheStore) {
    const auto slot = reservoir_slot (999, 10, 0xFFFFFFFFFFFFFFFFULL);
    if (slot.accepted) {
        EXPECT_LT (slot.index, 10u);
    }
    EXPECT_LT (reservoir_slot (999, 10, 18446744073709551615ULL).index, 1000u);
}

// Zero capacity retains nothing. The "0 means unlimited" config convention is
// the caller's, and a caller that forgets it must not get an index into an
// empty store.
TEST (ReservoirSlot, ZeroCapacityRetainsNothing) {
    EXPECT_FALSE (reservoir_slot (0, 0, 0).accepted);
    EXPECT_FALSE (reservoir_slot (5000, 0, 12345).accepted);
}
