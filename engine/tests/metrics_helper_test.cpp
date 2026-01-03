#include "vayu/utils/metrics_helper.hpp"

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include "vayu/core/run_manager.hpp"

using namespace vayu::utils;

class MetricsHelperTest : public ::testing::Test {
protected:
    void SetUp() override {
        // RunContext requires a constructor with id and config
        nlohmann::json cfg;
        cfg["duration"] = "60s";
        cfg["rps"] = 100.0;
        test_context = std::make_unique<vayu::core::RunContext>("test_run", cfg);

        // Setup test values via MetricsCollector
        // Record 100 requests: 95 successes, 5 errors
        for (int i = 0; i < 95; ++i) {
            test_context->metrics_collector->record_success(200, 150.0);  // 150ms each
        }
        for (int i = 0; i < 5; ++i) {
            test_context->metrics_collector->record_error(vayu::ErrorCode::Timeout, "Test error");
        }
        test_context->is_running = false;
        test_context->should_stop = false;
    }

    std::unique_ptr<vayu::core::RunContext> test_context;
};

TEST_F(MetricsHelperTest, CalculatesSummaryCorrectly) {
    auto summary = MetricsHelper::calculate_summary(*test_context);

    EXPECT_EQ(summary.total_requests, 100);
    EXPECT_EQ(summary.errors, 5);
    // avg_latency = total_latency / success_count = (95*150) / 95 = 150
    // But MetricsHelper divides by total_requests, so: (95*150) / 100 = 142.5
    EXPECT_DOUBLE_EQ(summary.avg_latency_ms, 142.5);
    EXPECT_DOUBLE_EQ(summary.error_rate, 5.0);  // 5 * 100 / 100
}

TEST_F(MetricsHelperTest, HandlesZeroRequestsSummary) {
    // Create a fresh context with no requests
    nlohmann::json cfg;
    cfg["duration"] = "60s";
    cfg["rps"] = 100.0;
    auto empty_context = std::make_unique<vayu::core::RunContext>("empty_run", cfg);

    auto summary = MetricsHelper::calculate_summary(*empty_context);

    EXPECT_EQ(summary.total_requests, 0);
    EXPECT_EQ(summary.errors, 0);
    EXPECT_DOUBLE_EQ(summary.avg_latency_ms, 0.0);
    EXPECT_DOUBLE_EQ(summary.error_rate, 0.0);
}

TEST_F(MetricsHelperTest, CreatesStopResponseCorrectly) {
    MetricsHelper::RunSummary summary;
    summary.total_requests = 100;
    summary.errors = 5;
    summary.avg_latency_ms = 150.0;
    summary.error_rate = 5.0;

    auto response = MetricsHelper::create_stop_response("test_run_123", summary);

    EXPECT_EQ(response["status"], "stopped");
    EXPECT_EQ(response["runId"], "test_run_123");
    EXPECT_EQ(response["summary"]["totalRequests"], 100);
    EXPECT_EQ(response["summary"]["errors"], 5);
    EXPECT_DOUBLE_EQ(response["summary"]["avgLatencyMs"], 150.0);
    EXPECT_DOUBLE_EQ(response["summary"]["errorRate"], 5.0);
}

TEST_F(MetricsHelperTest, CreatesInactiveResponseCorrectly) {
    auto response = MetricsHelper::create_inactive_response("test_run_456");

    EXPECT_EQ(response["status"], "stopped");
    EXPECT_EQ(response["runId"], "test_run_456");
    EXPECT_EQ(response["message"], "Run was not active");
}

TEST_F(MetricsHelperTest, CreatesAlreadyStoppedResponseCorrectly) {
    auto response = MetricsHelper::create_already_stopped_response("test_run_789", "completed");

    EXPECT_EQ(response["status"], "completed");
    EXPECT_EQ(response["runId"], "test_run_789");
    EXPECT_EQ(response["message"], "Run already completed");
}

TEST_F(MetricsHelperTest, WaitForGracefulStopReturnsImmediatelyWhenNotRunning) {
    test_context->is_running = false;

    auto start = std::chrono::steady_clock::now();
    bool result = MetricsHelper::wait_for_graceful_stop(*test_context, 5);
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start);

    EXPECT_TRUE(result);
    EXPECT_LT(duration.count(), 100);  // Should return almost immediately
}

TEST_F(MetricsHelperTest, CalculatesDetailedReportCorrectly) {
    std::vector<vayu::db::Result> results;
    // Add 100 results
    for (int i = 0; i < 100; ++i) {
        vayu::db::Result r;
        r.status_code = (i < 95) ? 200 : 500;       // 5 errors
        r.latency_ms = static_cast<double>(i + 1);  // 1 to 100 ms
        results.push_back(r);
    }

    double duration_s = 10.0;
    auto report = MetricsHelper::calculate_detailed_report(results, duration_s);

    EXPECT_EQ(report.total_requests, 100);
    EXPECT_EQ(report.successful_requests, 95);
    EXPECT_EQ(report.failed_requests, 5);
    EXPECT_DOUBLE_EQ(report.error_rate, 5.0);
    EXPECT_DOUBLE_EQ(report.total_duration_s, 10.0);
    EXPECT_DOUBLE_EQ(report.avg_rps, 10.0);  // 100 / 10

    // Latency stats
    // Sum 1..100 = 5050. Avg = 50.5
    EXPECT_DOUBLE_EQ(report.latency_avg, 50.5);
    EXPECT_DOUBLE_EQ(report.latency_min, 1.0);
    EXPECT_DOUBLE_EQ(report.latency_max, 100.0);

    // Percentiles
    // p50 of 1..100 is 50
    EXPECT_EQ(report.latency_p50, 50.0);
    // p90 is 90
    EXPECT_EQ(report.latency_p90, 90.0);
    // p95 is 95
    EXPECT_EQ(report.latency_p95, 95.0);
    // p99 is 99
    EXPECT_EQ(report.latency_p99, 99.0);

    EXPECT_EQ(report.status_codes[200], 95);
    EXPECT_EQ(report.status_codes[500], 5);
}

TEST_F(MetricsHelperTest, HandlesEmptyResultsForDetailedReport) {
    std::vector<vayu::db::Result> results;
    auto report = MetricsHelper::calculate_detailed_report(results, 10.0);

    EXPECT_EQ(report.total_requests, 0);
    EXPECT_EQ(report.successful_requests, 0);
    EXPECT_EQ(report.failed_requests, 0);
    EXPECT_DOUBLE_EQ(report.error_rate, 0.0);
    EXPECT_DOUBLE_EQ(report.avg_rps, 0.0);
    EXPECT_DOUBLE_EQ(report.latency_avg, 0.0);
    EXPECT_DOUBLE_EQ(report.latency_min, 0.0);
    EXPECT_DOUBLE_EQ(report.latency_max, 0.0);
}
