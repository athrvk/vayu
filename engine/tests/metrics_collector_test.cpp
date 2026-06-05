/**
 * @file metrics_collector_test.cpp
 * @brief Tests for the high-performance MetricsCollector class
 */

#include "vayu/core/metrics_collector.hpp"

#include <gtest/gtest.h>

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

// ============================================================================
// Thread Safety Tests
// ============================================================================

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
// Run-progress fields (requestsSent / requestsExpected) — feed the dashboard
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
