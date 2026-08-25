/**
 * @file metrics_collector_test.cpp
 * @brief Tests for the high-performance MetricsCollector class
 */

#include "vayu/core/metrics_collector.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <thread>
#include <vector>

#include "optional_assert.hpp"

using namespace vayu::core;

class MetricsCollectorTest : public ::testing::Test {
    protected:
    void SetUp () override {
        MetricsCollectorConfig config;
        config.expected_requests = 10000;
        collector = std::make_unique<MetricsCollector> ("test_run", config);
    }

    std::unique_ptr<MetricsCollector> collector;
};

// ============================================================================
// Basic Functionality Tests
// ============================================================================

TEST_F (MetricsCollectorTest, InitialStateIsEmpty) {
    EXPECT_EQ (collector->total_requests (), 0);
    EXPECT_EQ (collector->total_errors (), 0);
    EXPECT_EQ (collector->success_count (), 0);
    EXPECT_DOUBLE_EQ (collector->total_latency_sum (), 0.0);
    EXPECT_DOUBLE_EQ (collector->average_latency (), 0.0);
    EXPECT_DOUBLE_EQ (collector->error_rate (), 0.0);
}

TEST_F (MetricsCollectorTest, RecordsSuccessCorrectly) {
    collector->record_success (200, 50.0, 0.0);
    collector->record_success (201, 75.0, 0.0);
    collector->record_success (200, 100.0, 0.0);

    EXPECT_EQ (collector->total_requests (), 3);
    EXPECT_EQ (collector->total_errors (), 0);
    EXPECT_EQ (collector->success_count (), 3);
    EXPECT_DOUBLE_EQ (collector->total_latency_sum (), 225.0);
    EXPECT_DOUBLE_EQ (collector->average_latency (), 75.0);
    EXPECT_DOUBLE_EQ (collector->error_rate (), 0.0);
}

TEST_F (MetricsCollectorTest, RecordsErrorsCorrectly) {
    collector->record_error (vayu::ErrorCode::Timeout, "Request timed out");
    collector->record_error (vayu::ErrorCode::ConnectionFailed, "Connection refused");

    EXPECT_EQ (collector->total_requests (), 2);
    EXPECT_EQ (collector->total_errors (), 2);
    EXPECT_EQ (collector->success_count (), 0);
    EXPECT_DOUBLE_EQ (collector->error_rate (), 100.0);
}

TEST_F (MetricsCollectorTest, CalculatesMixedStatsCorrectly) {
    // 8 successes, 2 errors
    for (int i = 0; i < 8; ++i) {
        collector->record_success (200, 100.0, 0.0);
    }
    collector->record_error (vayu::ErrorCode::Timeout, "Timeout 1");
    collector->record_error (vayu::ErrorCode::Timeout, "Timeout 2");

    EXPECT_EQ (collector->total_requests (), 10);
    EXPECT_EQ (collector->total_errors (), 2);
    EXPECT_EQ (collector->success_count (), 8);
    EXPECT_DOUBLE_EQ (collector->total_latency_sum (), 800.0);
    EXPECT_DOUBLE_EQ (collector->average_latency (), 100.0); // 800 / 8 successes
    EXPECT_DOUBLE_EQ (collector->error_rate (), 20.0);       // 2/10 * 100
}

// ============================================================================
// Percentile Calculation Tests
// ============================================================================

TEST_F (MetricsCollectorTest, CalculatesPercentilesCorrectly) {
    // Add 100 latencies from 1 to 100
    for (int i = 1; i <= 100; ++i) {
        collector->record_success (200, static_cast<double> (i), 0.0);
    }

    auto percentiles = collector->calculate_percentiles ();

    // HdrHistogram has ~0.1% precision at 3 significant figures
    // Use 1% tolerance for percentile assertions to account for histogram bucketing
    constexpr double tolerance = 1.0; // 1ms tolerance

    EXPECT_NEAR (percentiles.min, 1.0, tolerance);
    EXPECT_NEAR (percentiles.max, 100.0, tolerance);
    // HdrHistogram percentile calculation may differ slightly from exact index-based calculation
    EXPECT_NEAR (percentiles.p50, 50.0, tolerance);
    EXPECT_NEAR (percentiles.p90, 90.0, tolerance);
    EXPECT_NEAR (percentiles.p95, 95.0, tolerance);
    EXPECT_NEAR (percentiles.p99, 99.0, tolerance);
}

TEST_F (MetricsCollectorTest, PercentilesHandleEmptyData) {
    auto percentiles = collector->calculate_percentiles ();

    EXPECT_DOUBLE_EQ (percentiles.min, 0.0);
    EXPECT_DOUBLE_EQ (percentiles.max, 0.0);
    EXPECT_DOUBLE_EQ (percentiles.p50, 0.0);
    EXPECT_DOUBLE_EQ (percentiles.p95, 0.0);
    EXPECT_DOUBLE_EQ (percentiles.p99, 0.0);
}

TEST_F (MetricsCollectorTest, PercentilesHandleSingleValue) {
    collector->record_success (200, 42.0, 0.0);

    auto percentiles = collector->calculate_percentiles ();

    // HdrHistogram stores in microseconds, may have slight rounding
    constexpr double tolerance = 0.1;
    EXPECT_NEAR (percentiles.min, 42.0, tolerance);
    EXPECT_NEAR (percentiles.max, 42.0, tolerance);
    EXPECT_NEAR (percentiles.p50, 42.0, tolerance);
    EXPECT_NEAR (percentiles.p99, 42.0, tolerance);
}

// ============================================================================
// Windowed (rolling) Percentile Tests
// ============================================================================

TEST_F (MetricsCollectorTest, SampleWindowEmptyReturnsZeros) {
    auto window = collector->sample_window_percentiles ();
    EXPECT_DOUBLE_EQ (window.p50, 0.0);
    EXPECT_DOUBLE_EQ (window.p95, 0.0);
    EXPECT_DOUBLE_EQ (window.p99, 0.0);
    EXPECT_DOUBLE_EQ (window.min, 0.0);
    EXPECT_DOUBLE_EQ (window.max, 0.0);
}

TEST_F (MetricsCollectorTest, SampleWindowReflectsRecordedInterval) {
    for (int i = 1; i <= 100; ++i) {
        collector->record_success (200, static_cast<double> (i), 0.0);
    }

    auto window = collector->sample_window_percentiles ();

    constexpr double tolerance = 1.0; // 1ms - HdrHistogram bucketing
    EXPECT_NEAR (window.min, 1.0, tolerance);
    EXPECT_NEAR (window.max, 100.0, tolerance);
    EXPECT_NEAR (window.p50, 50.0, tolerance);
    EXPECT_NEAR (window.p95, 95.0, tolerance);
    EXPECT_NEAR (window.p99, 99.0, tolerance);
}

TEST_F (MetricsCollectorTest, SampleWindowResetsBetweenIntervals) {
    // First interval: all low-latency samples.
    for (int i = 0; i < 500; ++i) {
        collector->record_success (200, 10.0, 0.0);
    }
    auto first = collector->sample_window_percentiles ();
    EXPECT_NEAR (first.p99, 10.0, 1.0);

    // Second interval: all high-latency samples. The window must NOT carry the
    // low-latency samples forward - sampling reset it.
    for (int i = 0; i < 500; ++i) {
        collector->record_success (200, 500.0, 0.0);
    }
    auto second = collector->sample_window_percentiles ();
    EXPECT_NEAR (second.p99, 500.0, 5.0);

    // Third interval with no new samples: empty window → zeros (not the last value).
    auto third = collector->sample_window_percentiles ();
    EXPECT_DOUBLE_EQ (third.p99, 0.0);
}

TEST_F (MetricsCollectorTest, WindowedTracksRecentWhileCumulativeFlattens) {
    // Drain a first interval of fast responses.
    for (int i = 0; i < 1000; ++i) {
        collector->record_success (200, 10.0, 0.0);
    }
    (void)collector->sample_window_percentiles ();

    // Now the server degrades: a second interval of slow responses.
    for (int i = 0; i < 1000; ++i) {
        collector->record_success (200, 500.0, 0.0);
    }
    auto window = collector->sample_window_percentiles ();

    // Cumulative (from start) blends both halves; the rolling window sees only the
    // recent (slow) interval. This divergence is the whole point of W1: the live
    // percentile chart tracks current load instead of the all-time distribution.
    auto cumulative = collector->calculate_percentiles ();
    EXPECT_NEAR (window.p50, 500.0, 5.0);
    EXPECT_LT (cumulative.p50, window.p50); // cumulative median dragged down by fast half
}

TEST_F (MetricsCollectorTest, GetCurrentStatsPrefersWindowedPercentiles) {
    // Record cumulative data that would yield ~100ms percentiles.
    for (int i = 0; i < 100; ++i) {
        collector->record_success (200, 100.0, 0.0);
    }

    // Explicit windowed values (as the producer would pass each tick).
    MetricsCollector::Percentiles window;
    window.p50 = 11.0;
    window.p95 = 12.0;
    window.p99 = 13.0;

    auto stats = collector->get_current_stats (0, 1.0, 0, 0, nullptr, &window);
    EXPECT_DOUBLE_EQ (stats["latencyP50Ms"].get<double> (), 11.0);
    EXPECT_DOUBLE_EQ (stats["latencyP95Ms"].get<double> (), 12.0);
    EXPECT_DOUBLE_EQ (stats["latencyP99Ms"].get<double> (), 13.0);

    // Without windowed values the fields fall back to the cumulative histogram.
    auto cumulative_stats = collector->get_current_stats (0, 1.0, 0);
    EXPECT_NEAR (cumulative_stats["latencyP99Ms"].get<double> (), 100.0, 1.0);
}

TEST_F (MetricsCollectorTest, SampleWindowSafeUnderConcurrentWriters) {
    // Writers record while the producer samples the window - the phaser must keep
    // this race-free (resolves D8 for the windowed source). Assert correctness of
    // the cumulative count and that sampling never crashes.
    constexpr int kThreads   = 4;
    constexpr int kPerThread = 5000;
    std::atomic<bool> stop{ false };

    std::vector<std::thread> writers;
    writers.reserve (kThreads);
    for (int t = 0; t < kThreads; ++t) {
        writers.emplace_back ([this] () {
            for (int i = 0; i < kPerThread; ++i) {
                collector->record_success (200, 25.0, 0.0);
            }
        });
    }

    // Sample repeatedly from this (single reader) thread while writers run.
    while (!stop.load ()) {
        (void)collector->sample_window_percentiles ();
        bool all_done =
        collector->total_requests () >= static_cast<size_t> (kThreads) * kPerThread;
        if (all_done)
            stop.store (true);
    }

    for (auto& w : writers)
        w.join ();
    (void)collector->sample_window_percentiles ();

    EXPECT_EQ (collector->total_requests (), static_cast<size_t> (kThreads * kPerThread));
}

// ============================================================================
// Status Code Distribution Tests
// ============================================================================

TEST_F (MetricsCollectorTest, TracksStatusCodeDistribution) {
    collector->record_success (200, 10.0, 0.0);
    collector->record_success (200, 10.0, 0.0);
    collector->record_success (201, 10.0, 0.0);
    collector->record_success (404, 10.0, 0.0);
    collector->record_success (500, 10.0, 0.0);
    collector->record_success (500, 10.0, 0.0);

    auto distribution = collector->status_code_distribution ();

    EXPECT_EQ (distribution[200], 2);
    EXPECT_EQ (distribution[201], 1);
    EXPECT_EQ (distribution[404], 1);
    EXPECT_EQ (distribution[500], 2);
}

// Transport errors (timeout, connection, DNS) have no HTTP status. They are
// recorded under status code 0 so the distribution sums to total_requests and
// the dashboard breakdown reconciles with the "Total Requests" headline.
TEST_F (MetricsCollectorTest, RecordsTransportErrorsAsStatusZero) {
    collector->record_success (200, 10.0, 0.0);
    collector->record_success (200, 10.0, 0.0);
    collector->record_error (vayu::ErrorCode::Timeout, "timed out");
    collector->record_error (vayu::ErrorCode::ConnectionFailed, "refused");

    auto distribution = collector->status_code_distribution ();

    EXPECT_EQ (distribution[200], 2);
    EXPECT_EQ (distribution[0], 2); // both transport errors bucketed under 0
}

// The core invariant the report relies on: total_requests equals the sum of the
// status-code distribution (successes carry their HTTP code, errors carry 0).
TEST_F (MetricsCollectorTest, StatusDistributionSumsToTotalRequests) {
    for (int i = 0; i < 8; ++i)
        collector->record_success (200, 100.0, 0.0);
    collector->record_success (500, 100.0, 0.0);
    collector->record_error (vayu::ErrorCode::Timeout, "t");
    collector->record_error (vayu::ErrorCode::DnsError, "d");

    auto distribution = collector->status_code_distribution ();
    size_t sum        = 0;
    for (const auto& [code, count] : distribution)
        sum += count;

    EXPECT_EQ (sum, collector->total_requests ());
    EXPECT_EQ (distribution[0], 2);
}

// Out-of-range / non-standard codes (nginx 499 is in-range; 999 from misbehaving
// proxies, or any code >= 600) must still be preserved exactly, not dropped. The
// lock-free array covers [0,600); everything else falls back to an overflow map.
TEST_F (MetricsCollectorTest, PreservesOutOfRangeStatusCodes) {
    collector->record_success (200, 10.0, 0.0);
    collector->record_success (999, 10.0, 0.0); // out of array range
    collector->record_success (999, 10.0, 0.0);
    collector->record_success (1000, 10.0, 0.0); // out of array range

    auto distribution = collector->status_code_distribution ();

    EXPECT_EQ (distribution[200], 1);
    EXPECT_EQ (distribution[999], 2);
    EXPECT_EQ (distribution[1000], 1);

    // Sum invariant must hold even with out-of-range codes.
    size_t sum = 0;
    for (const auto& [code, count] : distribution)
        sum += count;
    EXPECT_EQ (sum, collector->total_requests ());
}

// ============================================================================
// Thread Safety Tests
// ============================================================================

// Per-code counts must be exact under concurrency: the lock-free hot path
// (#20) replaced the mutex-guarded map, so verify N threads hammering a spread
// of distinct codes - including an out-of-range code on the overflow path -
// produce exact per-code totals with no lost increments.
TEST_F (MetricsCollectorTest, ThreadSafePerCodeCounts) {
    const int num_threads         = 8;
    const int requests_per_thread = 5000;
    // Codes spanning every class plus one out-of-range overflow code.
    const std::vector<int> codes = { 200, 201, 301, 404, 500, 503, 999 };
    std::vector<std::thread> threads;

    for (int t = 0; t < num_threads; ++t) {
        threads.emplace_back ([this, &codes] () {
            for (int i = 0; i < requests_per_thread; ++i) {
                collector->record_success (
                codes[static_cast<size_t> (i) % codes.size ()], 5.0, 0.0);
            }
        });
    }
    for (auto& t : threads)
        t.join ();

    auto distribution = collector->status_code_distribution ();

    // Each code is hit floor/ceil of (total / codes.size()) times. With
    // requests_per_thread a multiple of codes.size()? 5000 % 7 != 0, so compute
    // exact expected per code from the deterministic round-robin.
    std::map<int, size_t> expected;
    for (int t = 0; t < num_threads; ++t)
        for (int i = 0; i < requests_per_thread; ++i)
            expected[codes[static_cast<size_t> (i) % codes.size ()]]++;

    for (const auto& [code, count] : expected) {
        EXPECT_EQ (distribution[code], count) << "code " << code;
    }
    size_t sum = 0;
    for (const auto& [code, count] : distribution)
        sum += count;
    EXPECT_EQ (sum, collector->total_requests ());
}

TEST_F (MetricsCollectorTest, ThreadSafeRecording) {
    const int num_threads         = 8;
    const int requests_per_thread = 1000;
    std::vector<std::thread> threads;

    for (int t = 0; t < num_threads; ++t) {
        threads.emplace_back ([this] () {
            for (int i = 0; i < 1000; ++i) {
                if (i % 10 == 0) {
                    collector->record_error (vayu::ErrorCode::Timeout, "Test error");
                } else {
                    collector->record_success (200, 50.0, 0.0);
                }
            }
        });
    }

    for (auto& t : threads) {
        t.join ();
    }

    EXPECT_EQ (collector->total_requests (), num_threads * requests_per_thread);
    EXPECT_EQ (collector->total_errors (), num_threads * (requests_per_thread / 10));
    EXPECT_EQ (collector->success_count (),
    num_threads * requests_per_thread - num_threads * (requests_per_thread / 10));
}

// The std::atomic counters above are not the interesting part - the histogram
// is. Every event-loop worker calls record_success on its own thread, and the
// plain hdr_record_value is a non-atomic `counts[i] += 1; total_count += 1`, so
// increments are simply lost. Nothing failed when that happened: the run just
// reported percentiles computed from fewer samples than it served. Assert the
// histogram's own count, which the counter assertions above cannot see.
TEST_F (MetricsCollectorTest, HistogramLosesNoSamplesUnderConcurrentWriters) {
    constexpr int kThreads   = 8;
    constexpr int kPerThread = 20000;

    std::vector<std::thread> writers;
    writers.reserve (kThreads);
    for (int t = 0; t < kThreads; ++t) {
        // Spread values across buckets so writers contend on different
        // counts[] slots as well as on total_count.
        writers.emplace_back ([this, t] () {
            for (int i = 0; i < kPerThread; ++i) {
                collector->record_success (
                200, 1.0 + static_cast<double> ((i + t) % 50), 0.0);
            }
        });
    }
    for (auto& w : writers)
        w.join ();

    EXPECT_EQ (collector->latency_count (), static_cast<int64_t> (kThreads) * kPerThread);
}

// total_requests_ and total_errors_ are independent relaxed atomics that
// record_error bumps one after the other, so a reader can observe the error
// increment before its paired request increment. Unguarded, the subtraction
// wraps to a huge size_t which passes every `> 0` denominator check and drives
// average_latency()/average_queue_wait() toward zero - the 1 Hz metrics tick
// then stores that near-zero point permanently in an otherwise normal series.
//
// Note on what this test can and cannot prove: the inverted window is only
// *observable* on a weak memory model (ARM64, which Vayu ships on macOS). On
// x86 the two `lock xadd`s are not reordered, so this asserts the invariant
// everywhere but can only witness the defect on the platform where it bites.
TEST_F (MetricsCollectorTest, SuccessCountNeverExceedsTotalRequests) {
    EXPECT_EQ (collector->success_count (), 0u);

    constexpr int kIterations = 100000;
    std::atomic<bool> writer_done{ false };
    std::thread writer ([this, &writer_done] () {
        for (int i = 0; i < kIterations; ++i) {
            collector->record_error (vayu::ErrorCode::Timeout, "e");
        }
        writer_done.store (true);
    });

    // Sample success_count() *before* total_requests(), and into locals: the
    // two reads must be ordered, and this is the only order the invariant is
    // stated over. success_count() loads total_requests_ first internally, so a
    // total read afterwards is never stale relative to it. Passing both calls
    // straight to ASSERT_LE left their evaluation order unspecified - compilers
    // commonly take the right operand first, which reads a total from before
    // the writer's increment and compares it against a success count from
    // after, reporting a violation the collector does not have.
    //
    // The check is non-fatal so a real violation joins the writer before
    // reporting. A fatal assertion returns from the test body with `writer`
    // still joinable, and ~std::thread then calls std::terminate - killing the
    // process before gtest prints why.
    size_t observed_success = 0;
    size_t observed_total   = 0;
    bool inverted           = false;
    while (!writer_done.load ()) {
        observed_success = collector->success_count ();
        observed_total   = collector->total_requests ();
        if (observed_success > observed_total) {
            inverted = true;
            break;
        }
    }
    writer.join ();

    EXPECT_FALSE (inverted) << "success_count() " << observed_success
                            << " exceeded total_requests() " << observed_total;

    EXPECT_EQ (collector->success_count (), 0u);
    EXPECT_EQ (collector->total_errors (), static_cast<size_t> (kIterations));
}

// ============================================================================
// Error Storage Tests
// ============================================================================

TEST_F (MetricsCollectorTest, StoresAllErrors) {
    collector->record_error (vayu::ErrorCode::Timeout, "Timeout error");
    collector->record_error (vayu::ErrorCode::ConnectionFailed, "Connection error");
    collector->record_error (vayu::ErrorCode::DnsError, "DNS error");

    const auto& errors = collector->errors ();

    EXPECT_EQ (errors.size (), 3);
    EXPECT_EQ (errors[0].error_code, vayu::ErrorCode::Timeout);
    EXPECT_EQ (errors[0].error_message, "Timeout error");
    EXPECT_EQ (errors[1].error_code, vayu::ErrorCode::ConnectionFailed);
    EXPECT_EQ (errors[2].error_code, vayu::ErrorCode::DnsError);
}

// ============================================================================
// Memory Usage Tests
// ============================================================================

TEST_F (MetricsCollectorTest, ReportsMemoryUsage) {
    // Memory usage should be reasonable and non-zero
    size_t memory = collector->memory_usage_bytes ();
    EXPECT_GT (memory, 0);

    // Add some errors (which have dynamic string storage)
    for (int i = 0; i < 100; ++i) {
        collector->record_error (vayu::ErrorCode::Timeout,
        "This is a long error message to ensure memory grows " + std::to_string (i));
    }

    size_t after_memory = collector->memory_usage_bytes ();

    // Memory should have increased due to error string storage
    EXPECT_GT (after_memory, memory);
}

// ============================================================================
// Configuration Tests
// ============================================================================

TEST (MetricsCollectorConfigTest, HistogramRecordsAllLatencies) {
    // HdrHistogram stores all latencies (no max_latencies limit)
    MetricsCollectorConfig config;
    config.expected_requests = 100;

    MetricsCollector collector ("test", config);

    // Record many latencies
    for (int i = 0; i < 100; ++i) {
        collector.record_success (200, static_cast<double> (i + 1), 0.0);
    }

    // All requests should be counted
    EXPECT_EQ (collector.total_requests (), 100);
    // Histogram should have all latency records
    EXPECT_EQ (collector.latency_count (), 100);
}

TEST (MetricsCollectorConfigTest, RespectsMaxErrorsLimit) {
    MetricsCollectorConfig config;
    config.expected_requests = 100;
    config.max_errors        = 5; // Only store 5 errors

    MetricsCollector collector ("test", config);

    // Record more than max
    for (int i = 0; i < 20; ++i) {
        collector.record_error (vayu::ErrorCode::Timeout, "Error " + std::to_string (i));
    }

    // Should only have max_errors stored
    EXPECT_EQ (collector.errors ().size (), 5);
    EXPECT_EQ (collector.total_errors (), 20); // But all errors counted
    // The 15 dropped records are counted, not silently discarded.
    EXPECT_EQ (collector.errors_dropped (), 15u);
}

// The default must be a real cap. It used to be 0 ("unlimited") and nothing in
// production ever overrode it, so a fully-failing target grew errors_ for the
// whole run and then flushed it as one enormous transaction.
TEST (MetricsCollectorConfigTest, DefaultErrorStoreIsBounded) {
    MetricsCollectorConfig config;
    ASSERT_GT (config.max_errors, 0u);

    config.max_errors = 3; // Same rule, small enough to exercise here.
    MetricsCollector collector ("test", config);

    for (int i = 0; i < 10; ++i) {
        collector.record_error (vayu::ErrorCode::ConnectionFailed, "boom");
    }

    EXPECT_EQ (collector.errors ().size (), 3u);
    EXPECT_EQ (collector.errors_dropped (), 7u);
    // Neither the counters nor the status-code distribution lose anything.
    EXPECT_EQ (collector.total_errors (), 10u);
    EXPECT_EQ (collector.status_code_distribution ().at (0), 10u);
}

// max_errors == 0 remains an explicit opt-in to unlimited storage.
TEST (MetricsCollectorConfigTest, ZeroMaxErrorsStillMeansUnlimited) {
    MetricsCollectorConfig config;
    config.max_errors = 0;
    MetricsCollector collector ("test", config);

    for (int i = 0; i < 50; ++i) {
        collector.record_error (vayu::ErrorCode::Timeout, "boom");
    }

    EXPECT_EQ (collector.errors ().size (), 50u);
    EXPECT_EQ (collector.errors_dropped (), 0u);
}

// ============================================================================
// Dropped Requests Tests
// ============================================================================

TEST_F (MetricsCollectorTest, RecordDropBatchIncrementsCounter) {
    EXPECT_EQ (collector->dropped_requests (), 0U);

    collector->record_drop_batch (10);
    EXPECT_EQ (collector->dropped_requests (), 10U);

    collector->record_drop_batch (25);
    EXPECT_EQ (collector->dropped_requests (), 35U);

    collector->record_drop_batch (0);
    EXPECT_EQ (collector->dropped_requests (), 35U);
}

TEST_F (MetricsCollectorTest, GetCurrentStatsIncludesDroppedRequests) {
    collector->record_drop_batch (42);
    nlohmann::json stats = collector->get_current_stats (0, 1.0, 0);

    ASSERT_TRUE (stats.contains ("droppedRequests"));
    EXPECT_EQ (stats["droppedRequests"].get<size_t> (), 42U);
}

// ============================================================================
// Queue Wait Time Tests
// ============================================================================

TEST_F (MetricsCollectorTest, RecordSuccessAccumulatesQueueWait) {
    collector->record_success (200, 50.0, 5.0, "");
    collector->record_success (200, 50.0, 15.0, "");
    collector->record_success (200, 50.0, 10.0, "");

    // Mean of 5 + 15 + 10 = 30 / 3 = 10
    EXPECT_DOUBLE_EQ (collector->average_queue_wait (), 10.0);
}

TEST_F (MetricsCollectorTest, GetCurrentStatsIncludesAvgQueueWaitMs) {
    collector->record_success (200, 50.0, 8.0, "");
    collector->record_success (200, 60.0, 12.0, "");

    nlohmann::json stats = collector->get_current_stats (0, 1.0, 0);
    ASSERT_TRUE (stats.contains ("avgQueueWaitMs"));
    EXPECT_DOUBLE_EQ (stats["avgQueueWaitMs"].get<double> (), 10.0);
}

TEST_F (MetricsCollectorTest, AverageQueueWaitIsZeroWhenNoSuccesses) {
    EXPECT_DOUBLE_EQ (collector->average_queue_wait (), 0.0);
}

TEST_F (MetricsCollectorTest, GetCurrentStatsIncludesLatencyPercentiles) {
    collector->record_success (200, 10.0, 0.0, "");
    collector->record_success (200, 20.0, 0.0, "");
    collector->record_success (200, 50.0, 0.0, "");
    collector->record_success (200, 100.0, 0.0, "");

    nlohmann::json stats = collector->get_current_stats (0, 1.0, 0);

    ASSERT_TRUE (stats.contains ("latencyP50Ms"));
    ASSERT_TRUE (stats.contains ("latencyP95Ms"));
    ASSERT_TRUE (stats.contains ("latencyP99Ms"));
    EXPECT_GT (stats["latencyP99Ms"].get<double> (), 0.0);
    EXPECT_GE (stats["latencyP99Ms"].get<double> (), stats["latencyP50Ms"].get<double> ());
    EXPECT_GE (stats["latencyP95Ms"].get<double> (), stats["latencyP50Ms"].get<double> ());
}

TEST_F (MetricsCollectorTest, GetCurrentStatsPercentilesZeroWhenNoSamples) {
    nlohmann::json stats = collector->get_current_stats (0, 1.0, 0);
    EXPECT_DOUBLE_EQ (stats["latencyP50Ms"].get<double> (), 0.0);
    EXPECT_DOUBLE_EQ (stats["latencyP99Ms"].get<double> (), 0.0);
}

// ============================================================================
// Run-progress fields (requestsSent / requestsExpected) - feed the dashboard
// ETA stat: (requestsExpected - requestsSent) / currentRps.
// ============================================================================

TEST_F (MetricsCollectorTest, GetCurrentStatsIncludesRequestProgress) {
    nlohmann::json stats = collector->get_current_stats (0, 1.0, 7, 100);
    ASSERT_TRUE (stats.contains ("requestsSent"));
    ASSERT_TRUE (stats.contains ("requestsExpected"));
    EXPECT_EQ (stats["requestsSent"].get<size_t> (), 7U);
    EXPECT_EQ (stats["requestsExpected"].get<size_t> (), 100U);
}

TEST_F (MetricsCollectorTest, GetCurrentStatsRequestExpectedDefaultsZero) {
    // Older 3-arg call sites still compile; requestsExpected defaults to 0
    // (open-ended runs like constant_rps have no fixed expected count).
    nlohmann::json stats = collector->get_current_stats (0, 1.0, 5);
    EXPECT_EQ (stats["requestsSent"].get<size_t> (), 5U);
    EXPECT_EQ (stats["requestsExpected"].get<size_t> (), 0U);
}

TEST_F (MetricsCollectorTest, RecordBytesAccumulates) {
    collector->record_bytes (100, 2048);
    collector->record_bytes (50, 1024);
    EXPECT_EQ (collector->total_bytes_sent (), 150u);
    EXPECT_EQ (collector->total_bytes_received (), 3072u);
}

TEST_F (MetricsCollectorTest, CurrentStatsIncludesBytesAndStatusMap) {
    collector->record_success (200, 10.0, 0.0, "");
    collector->record_success (404, 12.0, 0.0, "");
    collector->record_bytes (50, 500);
    auto stats = collector->get_current_stats (0, 1.0, 2, 0);
    EXPECT_EQ (stats["bytesSent"].get<size_t> (), 50u);
    EXPECT_EQ (stats["bytesReceived"].get<size_t> (), 500u);
    ASSERT_TRUE (stats.contains ("statusCodes"));
    EXPECT_EQ (stats["statusCodes"]["200"].get<size_t> (), 1u);
    EXPECT_EQ (stats["statusCodes"]["404"].get<size_t> (), 1u);
}

// The status2xx..5xx SSE fields are now derived at read time from the per-code
// array (the dedicated class atomics were removed in #20). Verify the derived
// class breakdown still matches the recorded codes, and that an out-of-range
// code contributes to no class bucket (same as the old class-counter behavior).
TEST_F (MetricsCollectorTest, GetCurrentStatsDerivesStatusClasses) {
    collector->record_success (200, 1.0, 0.0);
    collector->record_success (204, 1.0, 0.0);
    collector->record_success (301, 1.0, 0.0);
    collector->record_success (404, 1.0, 0.0);
    collector->record_success (404, 1.0, 0.0);
    collector->record_success (500, 1.0, 0.0);
    collector->record_success (999, 1.0, 0.0); // out of range: no class bucket
    collector->record_error (vayu::ErrorCode::Timeout, "t"); // code 0: no class bucket

    auto stats = collector->get_current_stats (0, 1.0, 0, 0);
    EXPECT_EQ (stats["status2xx"].get<size_t> (), 2u);
    EXPECT_EQ (stats["status3xx"].get<size_t> (), 1u);
    EXPECT_EQ (stats["status4xx"].get<size_t> (), 2u);
    EXPECT_EQ (stats["status5xx"].get<size_t> (), 1u);
}

// ============================================================================
// Pre-allocation guard
// ============================================================================

// `expected_requests` is duration x RPS x 1.2 and has no ceiling of its own,
// while the errors reserve is `expected / 20` whenever `max_errors` is 0 - the
// default, and nothing overrides it. A day at a high rate therefore asked for
// billions of ResultRecords, which throws from this constructor - inside
// RunContext's, which the run route calls *after* writing the run row, so the
// caller got an opaque 500 and the row was stranded `pending`. Constructing at
// all is most of the assertion here.
TEST (MetricsCollectorReserveGuard, HugeExpectedRequestsDoesNotThrow) {
    MetricsCollectorConfig config;
    // 24h at 1M RPS with the 20% buffer - the top of what the load dialog's
    // ceilings can now be raised to.
    config.expected_requests    = 103'680'000'000ULL;
    config.store_success_traces = true;
    config.max_success_results = 0; // take the derived branch, not the default cap
    config.success_sample_rate = 1; // 100% sampling: the largest derived reserve

    std::unique_ptr<MetricsCollector> collector;
    ASSERT_NO_THROW (
    collector = std::make_unique<MetricsCollector> ("run_huge_expected", config));

    EXPECT_LE (collector->errors ().capacity (),
    vayu::core::constants::metrics_collector::MAX_RESERVE_RECORDS);
}

// The cap must not become a floor: an ordinary run still gets the exact
// pre-allocation it asked for, which is the point of reserving at all.
TEST (MetricsCollectorReserveGuard, OrdinaryRunKeepsItsFullReserve) {
    MetricsCollectorConfig config;
    config.expected_requests = 200000; // 60s at ~2.8k RPS
    MetricsCollector collector ("run_ordinary", config);

    // expected / 20, uncapped because it is far below the ceiling.
    EXPECT_GE (collector.errors ().capacity (), 10000u);
    EXPECT_LT (collector.errors ().capacity (),
    vayu::core::constants::metrics_collector::MAX_RESERVE_RECORDS);
}

// Capping the *reserve* must not cap what a run records - the vector grows.
TEST (MetricsCollectorReserveGuard, RecordingIsUnaffectedByTheCap) {
    MetricsCollectorConfig config;
    config.expected_requests = 103'680'000'000ULL;
    MetricsCollector collector ("run_capped_recording", config);

    for (int i = 0; i < 50; ++i) {
        collector.record_error (vayu::ErrorCode::Timeout, "t");
    }
    EXPECT_EQ (collector.total_errors (), 50u);
    EXPECT_EQ (collector.errors ().size (), 50u);
}

// ============================================================================
// Retention: what a bounded store keeps, and what it says it dropped
// ============================================================================

namespace {
// A trace is opaque to the collector - it only has to be non-empty and
// distinguishable, so the tests can tell which completion a retained record
// came from.
std::string trace_for (int n) {
    return "{\"totalMs\":" + std::to_string (n) + "}";
}

int trace_ordinal (const std::string& trace_data) {
    const auto colon = trace_data.find (':');
    return std::stoi (trace_data.substr (colon + 1));
}

MetricsCollectorConfig sampling_config (size_t period, size_t cap, bool store_traces) {
    MetricsCollectorConfig config;
    config.expected_requests    = 1000;
    config.success_sample_rate  = period;
    config.max_success_results  = cap;
    config.store_success_traces = store_traces;
    return config;
}
} // namespace

// Finding 3: `slow_threshold_ms` had no observable effect. A slow completion's
// trace was built in handle_result *because* it was slow, then discarded here
// because storage was gated on the timing-breakdown toggle alone - which is
// off by default. A user who set a threshold to catch outliers got nothing.
TEST (MetricsCollectorRetention, SlowTraceIsStoredWithTimingBreakdownOff) {
    MetricsCollector collector ("run_slow", sampling_config (100, 1000, false));

    collector.record_success (200, 900.0, 0.0, trace_for (1), SuccessTraceReason::Slow);

    ASSERT_EQ (collector.slow_results ().size (), 1u);
    EXPECT_EQ (collector.slow_results ()[0].trace_data, trace_for (1));
    EXPECT_EQ (collector.slow_results_dropped (), 0u);
    // The sampled-success budget is untouched: an outlier is not a sample.
    EXPECT_TRUE (collector.success_results ().empty ());
}

// The mirror case, so the fix cannot become "store everything": a completion
// that is neither sampled nor slow stores nothing, whatever it carries.
TEST (MetricsCollectorRetention, AnUnsampledCompletionStoresNothing) {
    MetricsCollector collector ("run_none", sampling_config (100, 1000, true));

    collector.record_success (200, 5.0, 0.0, trace_for (1), SuccessTraceReason::None);
    collector.record_success (200, 5.0, 0.0, "", SuccessTraceReason::Sampled);

    EXPECT_TRUE (collector.success_results ().empty ());
    EXPECT_TRUE (collector.slow_results ().empty ());
    EXPECT_EQ (collector.total_requests (), 2u);
}

// Finding 4: the cap was a hard stop, so the retained set was the run's first
// N sampled completions - the least representative part, before connection
// reuse and DNS caching settle - with nothing from the rest of the run and no
// signal that anything was dropped.
TEST (MetricsCollectorRetention, SampledSuccessesAreDrawnFromTheWholeRun) {
    constexpr int total  = 10000;
    constexpr size_t cap = 100;
    MetricsCollector collector ("run_reservoir", sampling_config (1, cap, true));

    for (int i = 0; i < total; ++i) {
        collector.record_success (200, 1.0, 0.0, trace_for (i), SuccessTraceReason::Sampled);
    }

    ASSERT_EQ (collector.success_results ().size (), cap);
    EXPECT_EQ (collector.success_results_dropped (), total - cap);

    // The final decile of a 10k stream: retaining nothing from it has
    // probability 0.9^100 (~2.6e-5) under a correct reservoir, and is certain
    // under the old hard stop.
    int from_final_decile = 0;
    for (const auto& record : collector.success_results ()) {
        if (trace_ordinal (record.trace_data) >= total * 9 / 10) {
            from_final_decile++;
        }
    }
    EXPECT_GT (from_final_decile, 0)
    << "every retained record came from the opening of the run - the cap is "
       "still a hard stop rather than a reservoir";
}

// Slow capture gets its own budget and its own drop count. Under saturation
// most completions cross the threshold, so "always keep the outliers" has to
// stay bounded rather than growing for the life of the run.
TEST (MetricsCollectorRetention, SlowCaptureIsBoundedAndCountsWhatItDropped) {
    constexpr int total     = 5000;
    auto config             = sampling_config (1, 1000, false);
    config.max_slow_results = 200;
    MetricsCollector collector ("run_slow_bounded", config);

    for (int i = 0; i < total; ++i) {
        collector.record_success (200, 900.0, 0.0, trace_for (i), SuccessTraceReason::Slow);
    }

    EXPECT_EQ (collector.slow_results ().size (), 200u);
    EXPECT_EQ (collector.slow_results_dropped (), total - 200);
    EXPECT_EQ (collector.success_results_dropped (), 0u);
}

// The sampling period counts every completion, and selects exactly one in N.
// The build-then-discard fix is invisible from outside - the trace that is
// never built leaves no trace - so what is pinned here is the gate the caller
// consults before building: 1000 completions at a period of 100 authorise 10
// traces, not 1000.
TEST (MetricsCollectorRetention, TheSamplingGateSelectsOneInN) {
    MetricsCollector collector ("run_gate", sampling_config (100, 1000, true));

    int authorised = 0;
    for (int i = 0; i < 1000; ++i) {
        if (collector.should_sample_success ()) {
            authorised++;
            EXPECT_EQ (i % 100, 0) << "sampled a completion off the period";
        }
    }
    EXPECT_EQ (authorised, 10);
}

// With traces switched off the gate authorises nothing, so no completion pays
// for a serialisation that storage would refuse.
TEST (MetricsCollectorRetention, TheSamplingGateAuthorisesNothingWithTracesOff) {
    MetricsCollector collector ("run_gate_off", sampling_config (1, 1000, false));

    for (int i = 0; i < 100; ++i) {
        EXPECT_FALSE (collector.should_sample_success ());
    }
}

// 0 stays "unlimited", which the reserve path and existing callers rely on.
TEST (MetricsCollectorRetention, ZeroCapMeansUnlimited) {
    MetricsCollector collector ("run_unlimited", sampling_config (1, 0, true));

    for (int i = 0; i < 3000; ++i) {
        collector.record_success (200, 1.0, 0.0, trace_for (i), SuccessTraceReason::Sampled);
    }

    EXPECT_EQ (collector.success_results ().size (), 3000u);
    EXPECT_EQ (collector.success_results_dropped (), 0u);
}

// Finding 6, the one that decides a pass/fail verdict: the responses handed to
// the post-run test script were the first `max_response_samples` the run
// produced. A target that starts failing later was never tested, so a run
// reported `testsPassed` against a window in which nothing was wrong while its
// own error rate showed the failures.
TEST (MetricsCollectorRetention, ValidationSamplesCoverTheWholeRun) {
    MetricsCollectorConfig config;
    config.expected_requests    = 1000;
    config.response_sample_rate = 1;
    config.max_response_samples = 50;
    MetricsCollector collector ("run_validation", config);

    // Healthy first, then failing - exactly the shape the old prefix could not
    // see, because the buffer was full long before the first 500.
    for (int i = 0; i < 2000; ++i) {
        vayu::Response response;
        response.status_code     = i < 1000 ? 200 : 500;
        response.timing.total_ms = 1.0;
        collector.record_response_sample (response);
    }

    ASSERT_EQ (collector.response_samples ().size (), 50u);
    EXPECT_EQ (collector.response_samples_dropped (), 1950u);

    int failures = 0;
    for (const auto& sample : collector.response_samples ()) {
        if (sample.status_code == 500) {
            failures++;
        }
    }
    EXPECT_GT (failures, 0)
    << "no failing response was retained, so post-run validation would still "
       "grade the run on its opening alone";
}

// The buffer must stay bounded while it keeps admitting: a reservoir that
// grows is just an unbounded store with extra steps.
TEST (MetricsCollectorRetention, ResponseSamplesStayBoundedUnderConcurrentWriters) {
    MetricsCollectorConfig config;
    config.expected_requests    = 1000;
    config.response_sample_rate = 1;
    config.max_response_samples = 100;
    MetricsCollector collector ("run_concurrent_samples", config);

    std::vector<std::thread> threads;
    threads.reserve (8);
    for (int t = 0; t < 8; ++t) {
        threads.emplace_back ([&collector] () {
            for (int i = 0; i < 2000; ++i) {
                vayu::Response response;
                response.status_code     = 200;
                response.body            = std::string (256, 'x');
                response.timing.total_ms = 1.0;
                collector.record_response_sample (response);
            }
        });
    }
    for (auto& thread : threads) {
        thread.join ();
    }

    EXPECT_EQ (collector.response_samples ().size (), 100u);
    // Every candidate is either retained or counted; nothing vanishes.
    EXPECT_EQ (collector.response_samples ().size () + collector.response_samples_dropped (),
    8u * 2000u);
}

// ============================================================================
// Per-Phase Histograms (issue #476)
// ============================================================================

namespace {

/// A completion's phase breakdown, spelled out so a test reads as the five
/// numbers it is asserting on rather than as five positional doubles.
vayu::Timing
phase_timing (double dns, double connect, double tls, double first_byte, double download) {
    vayu::Timing timing;
    timing.dns_ms        = dns;
    timing.connect_ms    = connect;
    timing.tls_ms        = tls;
    timing.first_byte_ms = first_byte;
    timing.download_ms   = download;
    return timing;
}

constexpr size_t kDns       = static_cast<size_t> (TimingPhase::Dns);
constexpr size_t kConnect   = static_cast<size_t> (TimingPhase::Connect);
constexpr size_t kTls       = static_cast<size_t> (TimingPhase::Tls);
constexpr size_t kFirstByte = static_cast<size_t> (TimingPhase::FirstByte);
constexpr size_t kDownload  = static_cast<size_t> (TimingPhase::Download);

} // namespace

// Each phase's values must land in its own histogram. Driving five distinct
// magnitudes is what makes a transposition (connect written into the tls slot,
// say) fail here rather than in a report nobody re-derives.
TEST_F (MetricsCollectorTest, PhaseValuesLandInTheirOwnHistogram) {
    for (int i = 0; i < 100; ++i) {
        const auto timing = phase_timing (1.0, 10.0, 100.0, 200.0, 4.0);
        collector->record_success (
        200, 315.0, 0.0, "", SuccessTraceReason::None, nullptr, &timing);
    }

    auto phases = collector->phase_percentiles ();
    ASSERT_HAS_VALUE (phases);

    constexpr double tolerance = 1.0;
    EXPECT_NEAR ((*phases)[kDns].p50, 1.0, tolerance);
    EXPECT_NEAR ((*phases)[kConnect].p50, 10.0, tolerance);
    EXPECT_NEAR ((*phases)[kTls].p50, 100.0, tolerance);
    EXPECT_NEAR ((*phases)[kFirstByte].p50, 200.0, tolerance);
    EXPECT_NEAR ((*phases)[kDownload].p50, 4.0, tolerance);

    // Fed together, so every phase holds the whole run.
    for (const auto& phase : *phases) {
        EXPECT_EQ (phase.count, 100u);
    }
}

// The distribution, not just the middle: a tail that only 1% of completions
// paid is exactly what the averages this replaces could not show.
TEST_F (MetricsCollectorTest, PhasePercentilesSeparateTailFromBody) {
    // 95 reused connections (no handshake) and 5 that re-handshaked for 50ms.
    // The split is 95/5 rather than 99/1 so the outliers sit *inside* p99: with
    // a single outlier in 100 the p99 is legitimately 0 and only `max` sees it,
    // which would make this test assert the histogram's rank arithmetic rather
    // than the behaviour it is here for.
    for (int i = 0; i < 95; ++i) {
        const auto timing = phase_timing (0.0, 0.0, 0.0, 5.0, 1.0);
        collector->record_success (
        200, 6.0, 0.0, "", SuccessTraceReason::None, nullptr, &timing);
    }
    for (int i = 0; i < 5; ++i) {
        const auto slow = phase_timing (0.0, 3.0, 50.0, 5.0, 1.0);
        collector->record_success (
        200, 59.0, 0.0, "", SuccessTraceReason::None, nullptr, &slow);
    }

    auto phases = collector->phase_percentiles ();
    ASSERT_HAS_VALUE (phases);

    // A zero p50 is the truthful reading of "most requests did no handshake" -
    // it must not be mistaken for a dropped record, which is why zeros are
    // recorded rather than skipped.
    EXPECT_DOUBLE_EQ ((*phases)[kTls].p50, 0.0);
    EXPECT_DOUBLE_EQ ((*phases)[kTls].p95, 0.0);
    EXPECT_EQ ((*phases)[kTls].count, 100u);
    EXPECT_NEAR ((*phases)[kTls].max, 50.0, 1.0);
    // The mean this replaces would have read 2.5ms - a number that looks like a
    // uniformly slightly-slow handshake rather than 5% of requests paying 50ms.
    EXPECT_NEAR ((*phases)[kTls].p99, 50.0, 1.0);
}

// The escape hatch has to actually cost nothing: off means no bank, and a
// report with no `phases` section rather than one full of zeros.
TEST_F (MetricsCollectorTest, PhaseHistogramsOffRecordsNothing) {
    MetricsCollectorConfig config;
    config.phase_histograms = false;
    MetricsCollector off ("phases_off", config);

    const auto timing = phase_timing (1.0, 10.0, 100.0, 200.0, 4.0);
    off.record_success (200, 315.0, 0.0, "", SuccessTraceReason::None, nullptr, &timing);

    EXPECT_EQ (off.total_requests (), 1u);
    EXPECT_FALSE (off.phase_percentiles ().has_value ());
}

// Absent, not zeros: a run where nothing succeeded reports no distribution, so
// a reader cannot mistake it for a target whose every phase was instant.
TEST_F (MetricsCollectorTest, PhasePercentilesAbsentWithoutCompletions) {
    EXPECT_FALSE (collector->phase_percentiles ().has_value ());

    // A success recorded without a breakdown (the record_success overloads that
    // predate the bank, and every non-load caller) leaves it absent too.
    collector->record_success (200, 10.0, 0.0);
    EXPECT_FALSE (collector->phase_percentiles ().has_value ());
}

// Written from every event-loop worker, so the records must be the atomic
// variant - the plain one is a read-modify-write on counts[] and loses
// increments. A lost increment shows up here as a count below the total.
TEST_F (MetricsCollectorTest, PhaseHistogramsSafeUnderConcurrentWriters) {
    constexpr int kThreads   = 4;
    constexpr int kPerThread = 5000;

    std::vector<std::thread> writers;
    writers.reserve (kThreads);
    for (int t = 0; t < kThreads; ++t) {
        writers.emplace_back ([this] () {
            for (int i = 0; i < kPerThread; ++i) {
                const auto timing = phase_timing (1.0, 2.0, 3.0, 4.0, 5.0);
                collector->record_success (
                200, 15.0, 0.0, "", SuccessTraceReason::None, nullptr, &timing);
            }
        });
    }
    for (auto& writer : writers) {
        writer.join ();
    }

    auto phases = collector->phase_percentiles ();
    ASSERT_HAS_VALUE (phases);
    for (const auto& phase : *phases) {
        EXPECT_EQ (phase.count, static_cast<size_t> (kThreads) * kPerThread);
    }
}

// ============================================================================
// Stream totals (issue #576)
// ============================================================================

// Absent, not zeros - the rule the whole `stream` report section rests on. An
// ordinary load run must not grow a section claiming it streamed nothing.
TEST_F (MetricsCollectorTest, StreamTotalsAbsentWithoutStreamCompletions) {
    collector->record_success (200, 10.0, 0.0);
    EXPECT_FALSE (collector->stream_totals ().has_value ());
}

TEST_F (MetricsCollectorTest, StreamTotalsSumEventsAndCountCappedSeparately) {
    collector->record_stream_completion (10, true);
    collector->record_stream_completion (20, true);
    collector->record_stream_completion (30, false);

    auto totals = collector->stream_totals ();
    ASSERT_HAS_VALUE (totals);
    EXPECT_EQ (totals->completions, 3u);
    EXPECT_EQ (totals->total_events, 60u);
    // The server ended one of them, so it is not among the capped - which is
    // what lets a reader tell "the run measured its own bounds" from "the
    // target closed the connections".
    EXPECT_EQ (totals->capped, 2u);
    EXPECT_EQ (totals->events.count, 3u);
    EXPECT_GE (totals->events.max, 30.0);
}

// A stream that delivered nothing is still a completion. Counting it only in
// the histogram would lose it, since hdr cannot hold a value below 1 - which is
// exactly the population ("every connection closed before the first event") a
// report most needs to show.
TEST_F (MetricsCollectorTest, StreamTotalsCountAnEmptyStreamAsACompletion) {
    collector->record_stream_completion (0, false);

    auto totals = collector->stream_totals ();
    ASSERT_HAS_VALUE (totals);
    EXPECT_EQ (totals->completions, 1u);
    EXPECT_EQ (totals->total_events, 0u);
}

TEST_F (MetricsCollectorTest, StreamMetricsOffRecordsNothing) {
    MetricsCollectorConfig config;
    config.stream_metrics = false;
    MetricsCollector off ("stream_off", config);

    off.record_stream_completion (25, true);

    // Off means the report has no section at all, not a section of zeros - so
    // the counters behind it must not tick either.
    EXPECT_FALSE (off.stream_totals ().has_value ());
}
