/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <gtest/gtest.h>

#include "vayu/core/ramp_curve.hpp"

using vayu::core::ramp_curve_integral;

TEST (RampCurveIntegral, ZeroElapsedReturnsZero) {
    EXPECT_DOUBLE_EQ (ramp_curve_integral (0, 10000, 1, 100), 0.0);
}

TEST (RampCurveIntegral, AtRampMidpointMatchesTriangle) {
    // Ramp from 0 to 100 over 10000ms. At t=5000ms:
    // ∫₀⁵⁰⁰⁰ (t/10000 × 100) dt = 100/(10000) × 5000²/2 = 0.01 × 12500000 = 125000.
    EXPECT_DOUBLE_EQ (ramp_curve_integral (5000, 10000, 0, 100), 125000.0);
}

TEST (RampCurveIntegral, AtRampEndMatchesTrapezoid) {
    // Ramp 1 → 101 over 10000ms. At t=10000ms:
    // (1 + 101)/2 × 10000 = 510000.
    EXPECT_DOUBLE_EQ (ramp_curve_integral (10000, 10000, 1, 101), 510000.0);
}

TEST (RampCurveIntegral, AfterRampHoldsAtTarget) {
    // Same ramp + 5000ms holding at 101 = 510000 + 101 × 5000 = 1015000.
    EXPECT_DOUBLE_EQ (ramp_curve_integral (15000, 10000, 1, 101), 1015000.0);
}

TEST (RampCurveIntegral, ZeroRampDurationTreatsAsInstantTarget) {
    // ramp_ms = 0 means "instant ramp" — integral is target × elapsed.
    EXPECT_DOUBLE_EQ (ramp_curve_integral (5000, 0, 1, 100), 100.0 * 5000.0);
}
