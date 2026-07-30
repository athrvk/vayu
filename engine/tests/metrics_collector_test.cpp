/**
 * @file metrics_collector_test.cpp
 * @brief Tests for the high-performance MetricsCollector class
 */

#include "vayu/core/metrics_collector.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <thread>
#include <vector>

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
    constexpr double tolerance = 1.0;  // 1ms tolerance

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

    constexpr double tolerance = 1.0;  // 1ms - HdrHistogram bucketing
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
    (void) collector->sample_window_percentiles ();

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
    EXPECT_LT (cumulative.p50, window.p50);  // cumulative median dragged down by fast half
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
    constexpr int kThreads = 4;
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
        (void) collector->sample_window_percentiles ();
        bool all_done = collector->total_requests () >=
        static_cast<size_t> (kThreads * kPerThread);
        if (all_done) stop.store (true);
    }

    for (auto& w : writers) w.join ();
    (void) collector->sample_window_percentiles ();

    EXPECT_EQ (collector->total_requests (),
    static_cast<size_t> (kThreads * kPerThread));
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
    size_t sum = 0;
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
                collector->record_success (codes[i % codes.size ()], 5.0, 0.0);
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
            expected[codes[i % codes.size ()]]++;

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
                collector->record_success (200, 1.0 + static_cast<double> ((i + t) % 50), 0.0);
            }
        });
    }
    for (auto& w : writers) w.join ();

    EXPECT_EQ (collector->latency_count (),
    static_cast<int64_t> (kThreads) * kPerThread);
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
    config.max_success_results  = 0; // take the derived branch, not the default cap
    config.success_sample_rate  = 1; // 100% sampling: the largest derived reserve

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
