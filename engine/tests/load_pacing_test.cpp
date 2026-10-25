/**
 * @file load_pacing_test.cpp
 * @brief Tests for the load-generation pacing cores: duration parsing, ramp
 *        interpolation, the open-loop owed count, and a stalled tick's
 *        catch-up limit.
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
#include <array>
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

// ============================================================================
// split_tick_backlog
// ============================================================================

namespace {

struct PacedTotals {
    size_t submitted = 0;
    size_t skipped   = 0;
    size_t ticks     = 0;
};

// The strategy's loop with the clock replaced: tick i wakes `late (i)` after
// the instant it was due, the next is due one tick after it woke, and the last
// is clamped to the deadline. Every tick's payout must account for exactly
// what it owed.
template <typename Lateness>
PacedTotals simulate_pacer (double rps, std::chrono::nanoseconds duration, Lateness late) {
    const auto interval = std::chrono::microseconds (static_cast<int64_t> (1e6 / rps));
    const std::chrono::nanoseconds tick =
    std::max<std::chrono::nanoseconds> (interval, 1ms);
    PacedTotals totals;
    std::chrono::nanoseconds scheduled{ 0 };
    size_t taken = 0;
    for (size_t i = 0;; ++i) {
        const auto now       = scheduled + late (i);
        const auto accrue_to = std::min (now, duration);
        const size_t owed    = requests_owed_by (rps, accrue_to);
        const auto payout = vayu::core::split_tick_backlog (rps, owed, taken, scheduled);
        EXPECT_EQ (payout.to_submit + payout.skipped, owed > taken ? owed - taken : 0)
        << "tick " << i << " at " << rps << " RPS";
        totals.submitted += payout.to_submit;
        totals.skipped += payout.skipped;
        totals.ticks++;
        taken = std::max (taken, owed);
        if (now >= duration) {
            return totals;
        }
        scheduled = std::min (accrue_to + tick, duration);
    }
}

} // namespace

// A 2 s stall at 100 RPS owes 200 more than the tick itself: the tick sends
// its own request plus the 100 ms window's 10 and skips the other 190.
// Mutation check: return `{ owed - taken, 0 }` and all 201 are sent.
TEST (SplitTickBacklog, ATwoSecondStallCatchesUpOneWindowAndSkipsTheRest) {
    const size_t taken   = requests_owed_by (100.0, 10s); // 1000
    const auto scheduled = 10s + 10ms;                    // one tick on
    const auto woke      = scheduled + 2s;
    const size_t owed    = requests_owed_by (100.0, woke); // 1201
    const auto payout = vayu::core::split_tick_backlog (100.0, owed, taken, scheduled);
    const size_t tick_own     = requests_owed_by (100.0, scheduled) - taken;
    const double stalled_secs = static_cast<double> (payout.skipped) / 100.0;

    EXPECT_EQ (tick_own, 1u);
    EXPECT_EQ (payout.to_submit - tick_own, 10u)
    << "more than 100 ms of backlog sent";
    EXPECT_EQ (payout.skipped, 190u);
    EXPECT_EQ (payout.to_submit + payout.skipped, owed - taken);
    EXPECT_GE (stalled_secs, 1.9);
    EXPECT_LE (stalled_secs, 2.0);
}

// Every tick 5 ms late is ordinary jitter at any rate: nothing is skipped and
// the run still sends the whole product.
TEST (SplitTickBacklog, FiveMillisecondJitterIsCaughtUpInFull) {
    for (double rps : { 0.3, 0.5, 2.0, 15.0, 33.3, 100.0, 1000.0, 1500.0, 50000.0 }) {
        const auto totals = simulate_pacer (rps, 10s,
        [] (size_t i) { return i == 0 ? 0ns : std::chrono::nanoseconds (5ms); });
        EXPECT_EQ (totals.skipped, 0u) << rps << " RPS";
        EXPECT_EQ (totals.submitted, requests_owed_by (rps, 10s)) << rps << " RPS";
    }
}

// The tick before woke a microsecond short of a due point, so this one, 5 ms
// late, owes two at 15 RPS. Both are jitter, not backlog; a rule counting
// `max (1, floor (rps x 0.1))` requests of debt would skip one of them.
TEST (SplitTickBacklog, ALateTickOwingTwoAtALowRateSkipsNeither) {
    const auto previous  = 1s - 1us;
    const size_t taken   = requests_owed_by (15.0, previous); // 14
    const auto scheduled = previous + 66666us;
    const size_t owed    = requests_owed_by (15.0, scheduled + 5ms); // 16
    ASSERT_EQ (owed - taken, 2u);

    const auto payout = vayu::core::split_tick_backlog (15.0, owed, taken, scheduled);
    EXPECT_EQ (payout.to_submit, 2u);
    EXPECT_EQ (payout.skipped, 0u);
}

// At 0.5 RPS one request is two seconds of schedule; the one a tick owes is
// sent however late the tick wakes, as long as it came due inside the window.
TEST (SplitTickBacklog, ALowRateNeverSkipsTheOneRequestATickOwes) {
    for (auto late : { 0ms, 5ms, 100ms, 1000ms, 1900ms }) {
        const auto payout = vayu::core::split_tick_backlog (
        0.5, requests_owed_by (0.5, 2s + late), 0, 2s);
        EXPECT_EQ (payout.to_submit, 1u) << late.count () << "ms late";
        EXPECT_EQ (payout.skipped, 0u) << late.count () << "ms late";
    }
}

// Stalls of every size, the last running past the deadline: the ticks still
// account for floor(rps x duration) exactly, sent or skipped.
TEST (SplitTickBacklog, SubmittedPlusSkippedIsTheRunsProductExactly) {
    const auto lateness = std::to_array<std::chrono::nanoseconds> (
    { 0ns, 1ms, 5ms, 99ms, 101ms, 150ms, 2s, 333333ns, 0ns, 40ms });
    for (double rps : { 0.5, 2.0, 15.0, 33.3, 100.0, 1500.0, 50000.0 }) {
        const auto totals = simulate_pacer (rps, 30s, [&lateness] (size_t i) {
            return i == 0 ? 0ns : lateness.at (i % lateness.size ());
        });
        EXPECT_EQ (totals.submitted + totals.skipped, requests_owed_by (rps, 30s))
        << rps << " RPS over " << totals.ticks << " ticks";
        EXPECT_GT (totals.skipped, 0u) << rps << " RPS: the 2 s stalls skipped nothing";
    }
}

TEST (SplitTickBacklog, ATickOwingNothingPaysNothing) {
    const auto payout = vayu::core::split_tick_backlog (100.0, 50, 50, 1s);
    EXPECT_EQ (payout.to_submit, 0u);
    EXPECT_EQ (payout.skipped, 0u);
    const auto behind = vayu::core::split_tick_backlog (100.0, 40, 50, 1s);
    EXPECT_EQ (behind.to_submit, 0u);
    EXPECT_EQ (behind.skipped, 0u);
}
