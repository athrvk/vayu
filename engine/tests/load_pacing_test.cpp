/**
 * @file load_pacing_test.cpp
 * @brief Tests for the load-generation pacing cores: duration parsing, ramp
 *        interpolation, and the open-loop owed count.
 *
 * These are the pure halves of three defects that were only reachable through a
 * live run: a duration whose unit was ignored, a ramp whose delta underflowed,
 * and a rate that was floored to a multiple of 1000. Testing them directly is
 * what makes the boundaries (unknown units, start > target, sub-request ticks)
 * assertable at all.
 */

#include "vayu/core/load_pacing.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <limits>
#include <vector>

using vayu::core::parse_duration_ms;
using vayu::core::ramp_target_concurrency;
using vayu::core::requests_owed_by;

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
// requests_owed_by
// ============================================================================

namespace {

using namespace std::chrono_literals;

// What a pacer taking the difference at every @p tick submits, each tick's
// share collected; the last tick lands on the deadline, as the strategy's does.
std::vector<size_t> per_tick_shares (double rps,
std::chrono::nanoseconds duration,
std::chrono::nanoseconds tick) {
    std::vector<size_t> shares;
    size_t taken = 0;
    for (auto at = tick;; at += tick) {
        const auto accrue_to = std::min (at, duration);
        const size_t owed    = requests_owed_by (rps, accrue_to);
        shares.push_back (owed - taken);
        taken = owed;
        if (accrue_to == duration) {
            return shares;
        }
    }
}

} // namespace

// batch_size = size_t(target_rps / 1000.0) delivered 1000 for a 1500 RPS ask
// and 2000 for 2500. Every 1ms tick owes the floor or the ceiling of the
// per-tick rate, and the second as a whole owes the rate exactly.
TEST (RequestsOwedBy, DeliversFractionalRatesAbove1000) {
    for (double rps : { 1500.0, 2500.0, 1001.0, 99999.0 }) {
        const auto shares = per_tick_shares (rps, 1s, 1ms);
        const auto low    = static_cast<size_t> (std::floor (rps / 1000.0));
        const auto high   = static_cast<size_t> (std::ceil (rps / 1000.0));
        size_t total      = 0;
        for (size_t share : shares) {
            EXPECT_TRUE (share == low || share == high)
            << "a 1ms tick at " << rps << " RPS owed " << share;
            total += share;
        }
        EXPECT_EQ (total, static_cast<size_t> (rps))
        << "delivered " << total << " for a target of " << rps << " RPS";
    }
}

// Ticks whose spacing is not a whole number of microseconds were each short a
// fraction when the pacer summed truncated deltas (#2910); read off the
// absolute time, the run still owes the whole product.
TEST (RequestsOwedBy, TicksOffTheMicrosecondGridLoseNothing) {
    const auto odd_tick = 333333ns + 7ns;
    for (double rps : { 200.0, 3000.0, 0.5, 2.0 }) {
        const auto shares = per_tick_shares (rps, 4s, odd_tick);
        size_t total      = 0;
        for (size_t share : shares) {
            total += share;
        }
        EXPECT_EQ (total, static_cast<size_t> (rps * 4.0)) << rps << " RPS";
    }
}

TEST (RequestsOwedBy, CarriesTheFractionAcrossTicks) {
    EXPECT_EQ (requests_owed_by (1500.0, 500us), 0u);  // 0.75 owed
    EXPECT_EQ (requests_owed_by (1500.0, 1000us), 1u); // 1.5 owed
    EXPECT_EQ (requests_owed_by (1500.0, 1500us), 2u); // 2.25 owed
}

// Request k is owed at k / rate: nothing at the start, the first a whole
// interval in.
TEST (RequestsOwedBy, LowRatesOweNothingUntilDue) {
    EXPECT_EQ (requests_owed_by (10.0, 0ms), 0u);
    EXPECT_EQ (requests_owed_by (10.0, 99ms), 0u);
    EXPECT_EQ (requests_owed_by (10.0, 100ms), 1u);
}

// Timer jitter is corrected rather than lost: one long tick owes what the ticks
// it swallowed would have.
TEST (RequestsOwedBy, LongTickOwesTheWholeElapsedWindow) {
    EXPECT_EQ (requests_owed_by (1000.0, 60ms) - requests_owed_by (1000.0, 10ms), 50u);
}

// What a run's `requests_expected` reads, and so what an unsaturated run sends.
TEST (RequestsOwedBy, ARunOwesTheFlooredProduct) {
    struct Case {
        double rps;
        std::chrono::milliseconds duration;
        size_t owed;
    };
    for (const Case& c : { Case{ 200.0, 20s, 4000 }, Case{ 100.0, 20s, 2000 },
         Case{ 3000.0, 10s, 30000 }, Case{ 0.5, 30s, 15 }, Case{ 2.0, 60s, 120 },
         Case{ 50.0, 20s, 1000 }, Case{ 33.3, 3s, 99 }, Case{ 0.5, 1s, 0 } }) {
        EXPECT_EQ (requests_owed_by (c.rps, c.duration), c.owed)
        << c.rps << " RPS for " << c.duration.count () << "ms";
    }
}

// Mutation check: drop the slack from requests_owed_by and these read 56, 28.
TEST (RequestsOwedBy, ADecimalProductBinaryLandsJustBelowCountsAsWhole) {
    EXPECT_EQ (requests_owed_by (0.57, 100s), 57u); // 56.99999999999999 in binary
    EXPECT_EQ (requests_owed_by (0.29, 100s), 29u); // 28.999999999999996
}

// The slack is a few ulps, not a rounding rule: a product a thousandth short
// of whole, at the largest rate a run accepts for a day, still floors.
TEST (RequestsOwedBy, TheSlackNeverRoundsUpAProductThatIsNotWhole) {
    EXPECT_EQ (requests_owed_by (1000000.0, 86400s - 1ns), 86399999999u);
    EXPECT_EQ (requests_owed_by (33.3, 3s), 99u); // 99.9
}

TEST (RequestsOwedBy, NonPositiveInputsOweNothing) {
    EXPECT_EQ (requests_owed_by (0.0, 1s), 0u);
    EXPECT_EQ (requests_owed_by (-5.0, 1s), 0u);
    EXPECT_EQ (requests_owed_by (std::numeric_limits<double>::quiet_NaN (), 1s), 0u);
    EXPECT_EQ (requests_owed_by (1000.0, 0ns), 0u);
    EXPECT_EQ (requests_owed_by (1000.0, -1s), 0u);
}
