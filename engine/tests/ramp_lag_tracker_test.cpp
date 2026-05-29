/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <gtest/gtest.h>

#include "vayu/core/ramp_lag_tracker.hpp"

using vayu::core::RampLagTracker;

// Clean ramp, no backpressure: achieved tracks expected, lag stays ~0.
TEST (RampLagTracker, CleanRampHasNegligibleLag) {
    // Ramp 0 -> 100 over 10000ms. Step every 10ms, never backpressured.
    RampLagTracker tracker (10000, 0, 100);
    double lag = 0.0;
    for (int64_t t = 10; t <= 10000; t += 10) {
        double progress = static_cast<double> (t) / 10000.0;
        size_t conc = static_cast<size_t> (100.0 * progress);
        lag = tracker.update (t, 10.0, conc, /*backpressured=*/false);
    }
    // Integer truncation of size_t concurrency on a 0-start ramp costs ~0.8%
    // on a 10ms-step discrete run (the first few steps contribute 0 to achieved
    // while the exact integral has grown). A real-valued right-Riemann sum would
    // be >= expected, but with floor-truncated size_t the lag is ~0.8% rather
    // than 0. Keep 1.0 as the ceiling — well below the backpressure test's 5%
    // floor, so the tests still discriminate cleanly.
    EXPECT_LE (lag, 1.0);
}

// A sustained backpressure stall mid-ramp must drive lag strictly positive.
TEST (RampLagTracker, BackpressureStallProducesPositiveLag) {
    RampLagTracker clean (10000, 0, 100);
    RampLagTracker stalled (10000, 0, 100);

    double clean_lag = 0.0, stalled_lag = 0.0;
    for (int64_t t = 10; t <= 10000; t += 10) {
        double progress = static_cast<double> (t) / 10000.0;
        size_t conc = static_cast<size_t> (100.0 * progress);
        // Stall the generator between 4000ms and 6000ms.
        bool bp = (t > 4000 && t <= 6000);
        clean_lag   = clean.update   (t, 10.0, conc, false);
        stalled_lag = stalled.update (t, 10.0, conc, bp);
    }
    EXPECT_GT (stalled_lag, 5.0);          // ~2s stall at ~50 conc out of a 500000 area => clearly >5%
    EXPECT_GT (stalled_lag, clean_lag);    // strictly worse than the clean run
}

// expected==0 at the very first instant must not divide by zero.
TEST (RampLagTracker, ZeroExpectedReturnsZero) {
    RampLagTracker tracker (10000, 1, 100);
    EXPECT_DOUBLE_EQ (tracker.update (0, 0.0, 1, false), 0.0);
}
