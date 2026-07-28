/**
 * @file load_pacing_test.cpp
 * @brief Tests for the load-generation pacing cores: duration parsing, ramp
 *        interpolation, and the fractional rate accumulator.
 *
 * These are the pure halves of three defects that were only reachable through a
 * live run: a duration whose unit was ignored, a ramp whose delta underflowed,
 * and a rate that was floored to a multiple of 1000. Testing them directly is
 * what makes the boundaries (unknown units, start > target, sub-request ticks)
 * assertable at all.
 */

#include "vayu/core/load_pacing.hpp"

#include <gtest/gtest.h>

using vayu::core::parse_duration_ms;
using vayu::core::ramp_target_concurrency;
using vayu::core::take_due_requests;

// ============================================================================
// parse_duration_ms
// ============================================================================

TEST (ParseDurationMs, ReadsEverySupportedUnit) {
    EXPECT_EQ (parse_duration_ms ("500ms"), 500);
    EXPECT_EQ (parse_duration_ms ("30s"), 30000);
    EXPECT_EQ (parse_duration_ms ("5m"), 300000);
    EXPECT_EQ (parse_duration_ms ("2h"), 7200000);
}

// The whole suffix decides the unit. Stripping one character read "500ms" as
// 500 of something and multiplied by 1000 regardless: 500 seconds.
TEST (ParseDurationMs, MillisecondsAreNotMinutes) {
    EXPECT_EQ (parse_duration_ms ("500ms"), 500);
    EXPECT_NE (parse_duration_ms ("500ms"), parse_duration_ms ("500m"));
    EXPECT_EQ (parse_duration_ms ("500m"), 30000000);
}

TEST (ParseDurationMs, BareNumberIsSeconds) {
    EXPECT_EQ (parse_duration_ms ("60"), 60000);
    EXPECT_EQ (parse_duration_ms ("60"), parse_duration_ms ("60s"));
}

TEST (ParseDurationMs, AcceptsFractionsCaseAndSpacing) {
    EXPECT_EQ (parse_duration_ms ("1.5s"), 1500);
    EXPECT_EQ (parse_duration_ms ("1.5m"), 90000);
    EXPECT_EQ (parse_duration_ms ("0.5ms"), 0);
    EXPECT_EQ (parse_duration_ms ("  30S  "), 30000);
    EXPECT_EQ (parse_duration_ms ("30 s"), 30000);
    EXPECT_EQ (parse_duration_ms ("500 MS"), 500);
}

TEST (ParseDurationMs, ZeroParsesAsZero) {
    EXPECT_EQ (parse_duration_ms ("0s"), 0);
    EXPECT_EQ (parse_duration_ms ("0"), 0);
}

TEST (ParseDurationMs, RejectsUnknownUnits) {
    EXPECT_FALSE (parse_duration_ms ("5min").has_value ());
    EXPECT_FALSE (parse_duration_ms ("30x").has_value ());
    EXPECT_FALSE (parse_duration_ms ("30sec").has_value ());
    EXPECT_FALSE (parse_duration_ms ("30d").has_value ());
}

TEST (ParseDurationMs, RejectsNonNumbers) {
    EXPECT_FALSE (parse_duration_ms ("").has_value ());
    EXPECT_FALSE (parse_duration_ms ("   ").has_value ());
    EXPECT_FALSE (parse_duration_ms ("s").has_value ());
    EXPECT_FALSE (parse_duration_ms ("abc").has_value ());
    EXPECT_FALSE (parse_duration_ms ("1.2.3s").has_value ());
    EXPECT_FALSE (parse_duration_ms (".s").has_value ());
}

// strtod would give each of these a meaning no caller intended, so the digit
// scan rejects them before it runs.
TEST (ParseDurationMs, RejectsSignsExponentsAndHex) {
    EXPECT_FALSE (parse_duration_ms ("-5s").has_value ());
    EXPECT_FALSE (parse_duration_ms ("+5s").has_value ());
    EXPECT_FALSE (parse_duration_ms ("1e3s").has_value ());
    EXPECT_FALSE (parse_duration_ms ("0x10s").has_value ());
    EXPECT_FALSE (parse_duration_ms ("inf").has_value ());
    EXPECT_FALSE (parse_duration_ms ("nan").has_value ());
}

TEST (ParseDurationMs, RejectsValuesThatOverflowInt64) {
    EXPECT_FALSE (parse_duration_ms ("99999999999999999999h").has_value ());
    EXPECT_TRUE (parse_duration_ms ("1000000h").has_value ());
}

// ============================================================================
// ramp_target_concurrency
// ============================================================================

TEST (RampTargetConcurrency, ClimbsFromStartToTarget) {
    EXPECT_EQ (ramp_target_concurrency (1, 101, 10000, 0), 1u);
    EXPECT_EQ (ramp_target_concurrency (1, 101, 10000, 5000), 51u);
    EXPECT_EQ (ramp_target_concurrency (1, 101, 10000, 10000), 101u);
    EXPECT_EQ (ramp_target_concurrency (1, 101, 10000, 60000), 101u);
}

// Ramp down is a legitimate profile. As a size_t subtraction the delta
// underflowed to ~1.8e19, so the controller held an astronomical in-flight
// target for the whole ramp instead of descending.
TEST (RampTargetConcurrency, DescendsWhenStartIsAboveTarget) {
    EXPECT_EQ (ramp_target_concurrency (100, 10, 10000, 0), 100u);
    EXPECT_EQ (ramp_target_concurrency (100, 10, 10000, 5000), 55u);
    EXPECT_EQ (ramp_target_concurrency (100, 10, 10000, 10000), 10u);
    EXPECT_EQ (ramp_target_concurrency (100, 10, 10000, 20000), 10u);
}

TEST (RampTargetConcurrency, RampDownIsMonotonicAndBounded) {
    const size_t start = 500, target = 5;
    size_t previous = start;
    for (int64_t el = 0; el <= 10000; el += 250) {
        const size_t value = ramp_target_concurrency (start, target, 10000, el);
        EXPECT_LE (value, previous) << "concurrency climbed at " << el << "ms";
        EXPECT_LE (value, start) << "concurrency exceeded the ramp start at " << el << "ms";
        EXPECT_GE (value, target) << "concurrency undershot the target at " << el << "ms";
        previous = value;
    }
}

TEST (RampTargetConcurrency, DegenerateRampsHoldTheTarget) {
    EXPECT_EQ (ramp_target_concurrency (1, 50, 0, 0), 50u);
    EXPECT_EQ (ramp_target_concurrency (1, 50, -1000, 500), 50u);
    EXPECT_EQ (ramp_target_concurrency (50, 50, 10000, 5000), 50u);
    EXPECT_EQ (ramp_target_concurrency (10, 0, 10000, 10000), 0u);
}

// ============================================================================
// take_due_requests
// ============================================================================

// batch_size = size_t(target_rps / 1000.0) delivered 1000 for a 1500 RPS ask
// and 2000 for 2500. The carried fraction is what fixes both.
TEST (TakeDueRequests, DeliversFractionalRatesAbove1000) {
    for (double rps : { 1500.0, 2500.0, 1001.0, 99999.0 }) {
        double debt  = 0.0;
        size_t total = 0;
        for (int tick = 0; tick < 1000; ++tick) { // 1000 x 1ms = 1 second
            total += take_due_requests (debt, rps, 1000);
        }
        EXPECT_NEAR (static_cast<double> (total), rps, 1.0)
        << "delivered " << total << " for a target of " << rps << " RPS";
    }
}

TEST (TakeDueRequests, CarriesTheFractionAcrossTicks) {
    double debt = 0.0;
    EXPECT_EQ (take_due_requests (debt, 1500.0, 500), 0u); // 0.75 owed
    EXPECT_EQ (take_due_requests (debt, 1500.0, 500), 1u); // 1.5 owed, 1 taken
    EXPECT_EQ (take_due_requests (debt, 1500.0, 500), 1u); // 1.25 owed
}

// Below 1000 RPS most ticks owe nothing; the request lands on the tick where
// the accumulated debt first reaches 1.
TEST (TakeDueRequests, LowRatesOweNothingUntilDue) {
    double debt  = 0.0;
    size_t total = 0;
    for (int tick = 0; tick < 100; ++tick) {
        total += take_due_requests (debt, 10.0, 1000); // 10 RPS, 1ms ticks
    }
    EXPECT_EQ (total, 1u); // 100ms at 10 RPS
}

// Timer jitter is corrected rather than lost: one long tick owes what the ticks
// it swallowed would have.
TEST (TakeDueRequests, LongTickOwesTheWholeElapsedWindow) {
    double debt = 0.0;
    EXPECT_EQ (take_due_requests (debt, 1000.0, 50000), 50u); // a 50ms hiccup
}

TEST (TakeDueRequests, NonPositiveInputsOweNothing) {
    double debt = 0.0;
    EXPECT_EQ (take_due_requests (debt, 0.0, 1000), 0u);
    EXPECT_EQ (take_due_requests (debt, -5.0, 1000), 0u);
    EXPECT_EQ (take_due_requests (debt, 1000.0, 0), 0u);
    EXPECT_EQ (take_due_requests (debt, 1000.0, -1000), 0u);
    EXPECT_DOUBLE_EQ (debt, 0.0);
}
