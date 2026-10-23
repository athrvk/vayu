/**
 * @file trailing_window_test.cpp
 * @brief The trailing window behind the per-tick rates and means (#2393).
 */

#include "vayu/core/trailing_window.hpp"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <gtest/gtest.h>

#include "optional_assert.hpp"

using vayu::core::CumulativeCounters;
using vayu::core::TrailingWindow;
using vayu::core::WindowReading;

namespace {

constexpr int64_t WINDOW_MS = 1000;
constexpr int64_t TICK_MS   = 100;

/// Counters at @p ms with @p completed completions and as many sent.
CumulativeCounters counters_at (int64_t ms, size_t completed) {
    CumulativeCounters counters;
    counters.steady_ms = ms;
    counters.completed = completed;
    counters.sent      = completed;
    return counters;
}

/// Push a 1000 req/s run that stops completing anything at @p step_ms, ticking
/// every TICK_MS, and return the reading at @p read_ms.
WindowReading step_to_zero_reading (int64_t step_ms, int64_t read_ms) {
    TrailingWindow window (WINDOW_MS);
    WindowReading reading;
    for (int64_t ms = 0; ms <= read_ms; ms += TICK_MS) {
        const int64_t active_ms = ms < step_ms ? ms : step_ms;
        reading = window.push (counters_at (ms, static_cast<size_t> (active_ms)));
    }
    return reading;
}

} // namespace

TEST (TrailingWindow, AFirstSampleReadsZero) {
    TrailingWindow window (WINDOW_MS);
    const auto reading = window.push (counters_at (5000, 500));
    EXPECT_DOUBLE_EQ (reading.completed_per_s, 0.0);
    EXPECT_DOUBLE_EQ (reading.sent_per_s, 0.0);
    EXPECT_FALSE (reading.avg_latency_ms.has_value ());
    EXPECT_FALSE (reading.avg_queue_wait_ms.has_value ());
}

// Two samples on one millisecond have no time to divide by.
TEST (TrailingWindow, AWindowWithNoTimeInItReadsZeroNotInfinity) {
    TrailingWindow window (WINDOW_MS);
    (void)window.push (counters_at (0, 0));
    const auto reading = window.push (counters_at (0, 10));
    EXPECT_DOUBLE_EQ (reading.completed_per_s, 0.0);
    EXPECT_TRUE (std::isfinite (reading.completed_per_s));
}

TEST (TrailingWindow, ASteadyRateReadsTheRateFromTheSecondTick) {
    // 1000 req/s, with ten in flight throughout.
    auto in_flight = [] (int64_t ms) {
        auto counters = counters_at (ms, static_cast<size_t> (ms));
        counters.sent += 10;
        return counters;
    };
    TrailingWindow window (WINDOW_MS);
    (void)window.push (in_flight (0));
    for (int64_t ms = TICK_MS; ms <= 3000; ms += TICK_MS) {
        const auto reading = window.push (in_flight (ms));
        EXPECT_DOUBLE_EQ (reading.completed_per_s, 1000.0) << "at " << ms << " ms";
        EXPECT_DOUBLE_EQ (reading.sent_per_s, 1000.0) << "at " << ms << " ms";
    }
}

// The issue's step: 1000 req/s for 2 s, then nothing. A cumulative mean still
// reads 500 two seconds later; the window reads 0 once a whole window has
// passed since the last completion. Mutation check: drop the eviction loop in
// `TrailingWindow::push` and the window grows from the first sample, so the
// last two assertions read 666.7 and 500.
TEST (TrailingWindow, AStepToZeroReadsZeroOneWindowLater) {
    constexpr int64_t STEP_MS = 2000;
    EXPECT_DOUBLE_EQ (step_to_zero_reading (STEP_MS, STEP_MS).completed_per_s, 1000.0);
    EXPECT_DOUBLE_EQ (
    step_to_zero_reading (STEP_MS, STEP_MS + (WINDOW_MS / 2)).completed_per_s, 500.0);
    EXPECT_DOUBLE_EQ (
    step_to_zero_reading (STEP_MS, STEP_MS + WINDOW_MS).completed_per_s, 0.0);
    EXPECT_DOUBLE_EQ (step_to_zero_reading (STEP_MS, 2 * STEP_MS).completed_per_s, 0.0);
}

// Ticks 700 ms apart: the window at 1400 ms reaches back to 0 ms, 1.4 s.
// Dividing by a nominal second instead reads 140.
TEST (TrailingWindow, DividesByTheWindowsActualSpan) {
    TrailingWindow window (WINDOW_MS);
    (void)window.push (counters_at (0, 0));
    (void)window.push (counters_at (700, 70));
    EXPECT_DOUBLE_EQ (window.push (counters_at (1400, 140)).completed_per_s, 100.0);
    // And at 2100 ms, from 700 ms: the base moved forward.
    EXPECT_DOUBLE_EQ (window.push (counters_at (2100, 210)).completed_per_s, 100.0);
}

// Ten users answering every 21 ms land four or five batches in a 100 ms delta
// (400 or 500 req/s); a second holds 47 or 48 of them, within 2% of the
// steady 476.
TEST (TrailingWindow, AQuantizedClosedLoopReadsNearItsSteadyRate) {
    constexpr size_t USERS     = 10;
    constexpr int64_t BATCH_MS = 21;
    const double steady =
    static_cast<double> (USERS) * 1000.0 / static_cast<double> (BATCH_MS);
    TrailingWindow window (WINDOW_MS);
    for (int64_t ms = 0; ms <= 5000; ms += TICK_MS) {
        const auto batches = static_cast<size_t> (ms / BATCH_MS);
        const auto reading = window.push (counters_at (ms, batches * USERS));
        if (ms >= WINDOW_MS) {
            EXPECT_NEAR (reading.completed_per_s, steady, steady * 0.02)
            << "at " << ms << " ms";
        }
    }
}

TEST (TrailingWindow, AnIdleWindowReadsZeroAndNoMean) {
    TrailingWindow window (WINDOW_MS);
    auto busy            = counters_at (0, 100);
    busy.latency_samples = 100;
    busy.latency_sum_ms  = 500.0;
    (void)window.push (busy);
    WindowReading reading;
    for (int64_t ms = TICK_MS; ms <= 2 * WINDOW_MS; ms += TICK_MS) {
        auto idle      = busy;
        idle.steady_ms = ms;
        reading        = window.push (idle);
    }
    EXPECT_DOUBLE_EQ (reading.completed_per_s, 0.0);
    EXPECT_DOUBLE_EQ (reading.sent_per_s, 0.0);
    EXPECT_FALSE (reading.avg_latency_ms.has_value ());
    EXPECT_FALSE (reading.avg_queue_wait_ms.has_value ());
}

// 100 requests at 5 ms, then 100 at 20 ms: the run's mean is 12.5 ms and the
// window's, which holds only the second hundred, is 20 ms.
TEST (TrailingWindow, TheMeansCoverOnlyTheSamplesTheWindowGained) {
    TrailingWindow window (WINDOW_MS);
    CumulativeCounters first = counters_at (0, 100);
    first.latency_samples    = 100;
    first.latency_sum_ms     = 100 * 5.0;
    first.queue_wait_sum_ms  = 100 * 0.5;
    (void)window.push (first);

    CumulativeCounters second = counters_at (WINDOW_MS, 200);
    second.latency_samples    = 200;
    second.latency_sum_ms     = first.latency_sum_ms + (100 * 20.0);
    second.queue_wait_sum_ms  = first.queue_wait_sum_ms + (100 * 2.0);
    const auto reading        = window.push (second);

    ASSERT_HAS_VALUE (reading.avg_latency_ms);
    EXPECT_DOUBLE_EQ (*reading.avg_latency_ms, 20.0);
    ASSERT_HAS_VALUE (reading.avg_queue_wait_ms);
    EXPECT_DOUBLE_EQ (*reading.avg_queue_wait_ms, 2.0);
}

// Little's law (#2821): 2,000 ms of latency completed over a 1,000 ms window is
// two requests in flight on average. Mutation check: divide by the window's
// completion count instead of its span and this reads 200.
TEST (TrailingWindow, MeanInFlightIsTheWindowsLatencyOverItsSpan) {
    TrailingWindow window (WINDOW_MS);
    (void)window.push (counters_at (0, 0));
    CumulativeCounters later = counters_at (WINDOW_MS, 10);
    later.latency_samples    = 10;
    later.latency_sum_ms     = 2000.0;
    EXPECT_DOUBLE_EQ (window.push (later).avg_in_flight, 2.0);
}

// The run's latency so far must not leak into a window that completed nothing.
TEST (TrailingWindow, AWindowWithNoCompletionReadsZeroInFlight) {
    TrailingWindow window (WINDOW_MS);
    auto busy            = counters_at (0, 100);
    busy.latency_samples = 100;
    busy.latency_sum_ms  = 5000.0;
    (void)window.push (busy);
    auto busier            = counters_at (WINDOW_MS, 200);
    busier.latency_samples = 200;
    busier.latency_sum_ms  = 10000.0;
    ASSERT_DOUBLE_EQ (window.push (busier).avg_in_flight, 5.0);

    WindowReading reading;
    for (int64_t ms = WINDOW_MS + TICK_MS; ms <= 3 * WINDOW_MS; ms += TICK_MS) {
        auto idle      = busier;
        idle.steady_ms = ms;
        reading        = window.push (idle);
    }
    EXPECT_DOUBLE_EQ (reading.avg_in_flight, 0.0);
}

// Ten users with no think time each hold one request at every instant: every
// 21 ms batch completes ten requests of 21 ms. The window reads 10 within the
// batch quantisation (a window holds 47 or 48 batches of a 47.6 average).
TEST (TrailingWindow, AClosedLoopWithNoThinkTimeReadsItsUserCount) {
    constexpr size_t USERS     = 10;
    constexpr int64_t BATCH_MS = 21;
    TrailingWindow window (WINDOW_MS);
    for (int64_t ms = 0; ms <= 5000; ms += TICK_MS) {
        const auto batches    = static_cast<size_t> (ms / BATCH_MS);
        CumulativeCounters at = counters_at (ms, batches * USERS);
        at.latency_samples    = batches * USERS;
        at.latency_sum_ms = static_cast<double> (at.latency_samples * BATCH_MS);
        const auto reading = window.push (at);
        if (ms >= WINDOW_MS) {
            EXPECT_NEAR (reading.avg_in_flight, static_cast<double> (USERS), 0.25)
            << "at " << ms << " ms";
        }
    }
}

// The ring holds the last window plus its base, not the run.
TEST (TrailingWindow, HoldsOneWindowOfSamplesNotTheRun) {
    TrailingWindow window (WINDOW_MS);
    for (int64_t ms = 0; ms <= 60000; ms += TICK_MS) {
        (void)window.push (counters_at (ms, static_cast<size_t> (ms)));
    }
    EXPECT_EQ (window.size (), static_cast<size_t> ((WINDOW_MS / TICK_MS) + 1));
}
