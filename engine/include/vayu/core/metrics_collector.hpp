#pragma once

/**
 * @file core/metrics_collector.hpp
 * @brief High-performance in-memory metrics collection for load testing
 *
 * This class provides lock-free and low-contention storage for request results
 * during high-throughput load tests (targeting 60k+ RPS). Individual results are
 * stored in memory during the test and batch-written to the database after completion.
 *
 * Key design decisions:
 * - Pre-allocated vectors to avoid reallocation during test
 * - Thread-local accumulators merged post-test for zero-contention writes
 * - Atomic counters for real-time aggregate stats
 * - All errors preserved, success results sampled if memory constrained
 */

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

/**
 * @brief Record for a single request result (lighter than db::Result)
 */
struct ResultRecord {
    int64_t timestamp;
    int status_code;
    double latency_ms;
    ErrorCode error_code;
    std::string error_message;
    std::string trace_data;

    ResultRecord() = default;
    ResultRecord(int64_t ts, int status, double latency)
        : timestamp(ts), status_code(status), latency_ms(latency), error_code(ErrorCode::None) {}

    ResultRecord(int64_t ts, ErrorCode code, std::string msg)
        : timestamp(ts),
          status_code(0),
          latency_ms(0.0),
          error_code(code),
          error_message(std::move(msg)) {}

    [[nodiscard]] bool is_error() const {
        return error_code != ErrorCode::None;
    }
};

/**
 * @brief Configuration for MetricsCollector
 */
struct MetricsCollectorConfig {
    /// Expected number of requests (for pre-allocation)
    size_t expected_requests = constants::metrics_collector::DEFAULT_EXPECTED_REQUESTS;

    /// Maximum latencies to store (0 = unlimited)
    size_t max_latencies = 0;

    /// Maximum errors to store (prevents OOM at high error rates)
    size_t max_errors = constants::metrics_collector::DEFAULT_MAX_ERRORS;

    /// Maximum success results to store (for detailed trace data)
    size_t max_success_results = constants::metrics_collector::DEFAULT_MAX_SUCCESS_RESULTS;

    /// Sample rate for success results (1 = all, 100 = 1%, etc.)
    size_t success_sample_rate = constants::metrics_collector::DEFAULT_SUCCESS_SAMPLE_RATE;

    /// Whether to store detailed trace data for successes
    bool store_success_traces = constants::metrics_collector::DEFAULT_STORE_SUCCESS_TRACES;
};

/**
 * @brief High-performance in-memory metrics collector
 *
 * Thread-safe for concurrent writes from multiple HTTP callback threads.
 * Optimized for high-throughput scenarios with minimal lock contention.
 */
class MetricsCollector {
public:
    explicit MetricsCollector(const std::string& run_id, MetricsCollectorConfig config = {});
    ~MetricsCollector() = default;

    // Non-copyable, non-movable (due to atomics and mutex)
    MetricsCollector(const MetricsCollector&) = delete;
    MetricsCollector& operator=(const MetricsCollector&) = delete;
    MetricsCollector(MetricsCollector&&) = delete;
    MetricsCollector& operator=(MetricsCollector&&) = delete;

    /**
     * @brief Record a successful request
     * Thread-safe, optimized for high-throughput
     */
    void record_success(int status_code, double latency_ms, const std::string& trace_data = "");

    /**
     * @brief Record a failed request
     * Thread-safe, all errors are preserved
     */
    void record_error(ErrorCode code,
                      const std::string& message,
                      const std::string& trace_data = "");

    /**
     * @brief Record a latency value (for percentile calculation)
     * Thread-safe
     */
    void record_latency(double latency_ms);

    // ========================================================================
    // Real-time stats (lock-free reads)
    // ========================================================================

    [[nodiscard]] size_t total_requests() const {
        return total_requests_.load(std::memory_order_relaxed);
    }

    [[nodiscard]] size_t total_errors() const {
        return total_errors_.load(std::memory_order_relaxed);
    }

    [[nodiscard]] size_t success_count() const {
        return total_requests() - total_errors();
    }

    [[nodiscard]] double total_latency_sum() const {
        return total_latency_sum_.load(std::memory_order_relaxed);
    }

    [[nodiscard]] double average_latency() const {
        size_t count = success_count();
        return count > 0 ? total_latency_sum() / count : 0.0;
    }

    [[nodiscard]] double error_rate() const {
        size_t total = total_requests();
        return total > 0 ? (total_errors() * 100.0 / total) : 0.0;
    }

    // ========================================================================
    // Post-test analysis
    // ========================================================================

    /**
     * @brief Calculate latency percentiles
     * @note Call after test completion - sorts the latencies vector
     */
    struct Percentiles {
        double p50 = 0.0;
        double p75 = 0.0;
        double p90 = 0.0;
        double p95 = 0.0;
        double p99 = 0.0;
        double p999 = 0.0;
        double min = 0.0;
        double max = 0.0;
    };

    [[nodiscard]] Percentiles calculate_percentiles();

    /**
     * @brief Get status code distribution
     */
    [[nodiscard]] std::map<int, size_t> status_code_distribution() const;

    /**
     * @brief Get all stored errors
     */
    [[nodiscard]] const std::vector<ResultRecord>& errors() const {
        return errors_;
    }

    /**
     * @brief Get all stored latencies
     */
    [[nodiscard]] const std::vector<double>& latencies() const {
        return latencies_;
    }

    // ========================================================================
    // Database persistence
    // ========================================================================

    /**
     * @brief Batch write all results to database
     * Call after test completion. Uses a single transaction for efficiency.
     * @return Number of results written
     */
    size_t flush_to_database(db::Database& db);

    /**
     * @brief Get memory usage estimate in bytes
     */
    [[nodiscard]] size_t memory_usage_bytes() const;

private:
    std::string run_id_;
    MetricsCollectorConfig config_;

    // Lock-free atomic counters for real-time stats
    std::atomic<size_t> total_requests_{0};
    std::atomic<size_t> total_errors_{0};
    std::atomic<double> total_latency_sum_{0.0};

    // Status code counts (lock-free for common codes)
    std::atomic<size_t> status_2xx_{0};
    std::atomic<size_t> status_3xx_{0};
    std::atomic<size_t> status_4xx_{0};
    std::atomic<size_t> status_5xx_{0};

    // Protected by mutex (low contention due to batching)
    mutable std::mutex latencies_mutex_;
    std::vector<double> latencies_;

    mutable std::mutex errors_mutex_;
    std::vector<ResultRecord> errors_;

    mutable std::mutex success_mutex_;
    std::vector<ResultRecord> success_results_;
    std::atomic<size_t> success_sample_counter_{0};

    // Detailed status code tracking
    mutable std::mutex status_codes_mutex_;
    std::map<int, size_t> status_code_counts_;

    // Helper for atomic double addition
    void atomic_add_double(std::atomic<double>& target, double value);
};

}  // namespace vayu::core
