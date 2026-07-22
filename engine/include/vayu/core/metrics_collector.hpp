#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

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

#include <array>
#include <atomic>
#include <map>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

#include <hdr/hdr_histogram.h>
#include <hdr/hdr_interval_recorder.h>

#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

/**
 * @brief Sampled response for deferred script validation
 * Stores minimal data needed to run test scripts after load test completes
 */
struct ResponseSample {
    int status_code;
    std::string status_text;
    std::string body;
    Headers headers;
    double latency_ms;
    int64_t timestamp;

    ResponseSample () = default;
    ResponseSample (const Response& resp, int64_t ts)
    : status_code (resp.status_code), status_text (resp.status_text), body (resp.body),
      headers (resp.headers), latency_ms (resp.timing.total_ms), timestamp (ts) {
    }
};

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

    ResultRecord () = default;
    ResultRecord (int64_t ts, int status, double latency)
    : timestamp (ts), status_code (status), latency_ms (latency),
      error_code (ErrorCode::None) {
    }

    ResultRecord (int64_t ts, ErrorCode code, std::string msg)
    : timestamp (ts), status_code (0), latency_ms (0.0), error_code (code),
      error_message (std::move (msg)) {
    }

    [[nodiscard]] bool is_error () const {
        return error_code != ErrorCode::None;
    }
};

/**
 * @brief Configuration for MetricsCollector
 */
struct MetricsCollectorConfig {
    /// Expected number of requests (for pre-allocation)
    size_t expected_requests = constants::metrics_collector::DEFAULT_EXPECTED_REQUESTS;

    /// Maximum errors to store (prevents OOM at high error rates)
    size_t max_errors = constants::metrics_collector::DEFAULT_MAX_ERRORS;

    /// Maximum success results to store (for detailed trace data)
    size_t max_success_results = constants::metrics_collector::DEFAULT_MAX_SUCCESS_RESULTS;

    /// Sample rate for success results (1 = all, 100 = 1%, etc.)
    size_t success_sample_rate = constants::metrics_collector::DEFAULT_SUCCESS_SAMPLE_RATE;

    /// Whether to store detailed trace data for successes
    bool store_success_traces = constants::metrics_collector::DEFAULT_STORE_SUCCESS_TRACES;

    /// Maximum response samples to store for script validation
    size_t max_response_samples = constants::metrics_collector::DEFAULT_MAX_RESPONSE_SAMPLES;

    /// Sample rate for response storage (1 = all, 100 = 1%, etc.)
    size_t response_sample_rate = constants::metrics_collector::DEFAULT_RESPONSE_SAMPLE_RATE;
};

/**
 * @brief High-performance in-memory metrics collector
 *
 * Thread-safe for concurrent writes from multiple HTTP callback threads.
 * Optimized for high-throughput scenarios with minimal lock contention.
 */
class MetricsCollector {
    public:
    explicit MetricsCollector (const std::string& run_id,
    MetricsCollectorConfig config = {});
    ~MetricsCollector ();

    // Non-copyable, non-movable (due to atomics and mutex)
    MetricsCollector (const MetricsCollector&)            = delete;
    MetricsCollector& operator= (const MetricsCollector&) = delete;
    MetricsCollector (MetricsCollector&&)                 = delete;
    MetricsCollector& operator= (MetricsCollector&&)      = delete;

    /**
     * @brief Record a successful request
     * Thread-safe, optimized for high-throughput
     */
    void record_success (int status_code,
                         double latency_ms,
                         double queue_wait_ms,
                         const std::string& trace_data = "");

    /**
     * @brief Record a response sample for deferred script validation
     * Thread-safe, stores sampled responses for post-test script execution
     */
    void record_response_sample (const Response& response);

    /**
     * @brief Record a failed request
     * Thread-safe, all errors are preserved
     */
    void record_error (ErrorCode code,
    const std::string& message,
    const std::string& trace_data = "");

    /**
     * @brief Record N requests dropped due to generator backpressure
     * Thread-safe. Dropped requests never reached the server.
     * @param count Number of requests in the dropped batch
     */
    void record_drop_batch (size_t count);

    [[nodiscard]] size_t dropped_requests () const {
        return dropped_requests_.load (std::memory_order_relaxed);
    }

    /** Accumulate wire bytes for a completed transfer (lock-free). */
    void record_bytes (size_t sent, size_t received) {
        total_bytes_sent_.fetch_add (sent, std::memory_order_relaxed);
        total_bytes_recv_.fetch_add (received, std::memory_order_relaxed);
    }

    [[nodiscard]] size_t total_bytes_sent () const {
        return total_bytes_sent_.load (std::memory_order_relaxed);
    }

    [[nodiscard]] size_t total_bytes_received () const {
        return total_bytes_recv_.load (std::memory_order_relaxed);
    }

    /**
     * @brief Record a latency value (for percentile calculation)
     * Thread-safe
     */
    void record_latency (double latency_ms);

    // ========================================================================
    // Real-time stats (lock-free reads)
    // ========================================================================

    [[nodiscard]] size_t total_requests () const {
        return total_requests_.load (std::memory_order_relaxed);
    }

    [[nodiscard]] size_t total_errors () const {
        return total_errors_.load (std::memory_order_relaxed);
    }

    [[nodiscard]] size_t success_count () const {
        return total_requests () - total_errors ();
    }

    [[nodiscard]] double total_latency_sum () const {
        return total_latency_sum_.load (std::memory_order_relaxed);
    }

    [[nodiscard]] double average_latency () const {
        size_t count = success_count ();
        return count > 0 ? total_latency_sum () / static_cast<double> (count) : 0.0;
    }

    [[nodiscard]] double average_queue_wait () const {
        size_t count = success_count ();
        return count > 0 ? total_queue_wait_sum_.load (std::memory_order_relaxed) /
                            static_cast<double> (count)
                         : 0.0;
    }

    [[nodiscard]] double error_rate () const {
        size_t total = total_requests ();
        return total > 0 ?
        (static_cast<double> (total_errors ()) * 100.0 / static_cast<double> (total)) :
        0.0;
    }

    // ========================================================================
    // Post-test analysis
    // ========================================================================

    /**
     * @brief Calculate latency percentiles
     * @note Call after test completion - sorts the latencies vector
     */
    struct Percentiles {
        double p50  = 0.0;
        double p75  = 0.0;
        double p90  = 0.0;
        double p95  = 0.0;
        double p99  = 0.0;
        double p999 = 0.0;
        double min  = 0.0;
        double max  = 0.0;
    };

    [[nodiscard]] Percentiles calculate_percentiles ();

    /**
     * @brief Sample the rolling (windowed) latency percentiles for the interval
     *        that has elapsed since the previous call, then reset the window.
     *
     * Backed by a phaser-based hdr_interval_recorder: record_success/record_latency
     * feed the recorder concurrently from worker threads while this single-reader
     * sample-and-recycle runs safely alongside them (this is what properly resolves
     * the cumulative-histogram concurrent read/write concern, D8). Unlike
     * calculate_percentiles() - which reads the cumulative-from-start histogram and
     * therefore flattens as a run progresses - each call here reflects only the most
     * recent window, so the live percentile chart tracks the current load instead of
     * the all-time distribution.
     *
     * @note Mutating (samples and resets the window). Call once per metrics tick
     *       from the producer thread only. Returns zeros when the window is empty.
     */
    [[nodiscard]] Percentiles sample_window_percentiles ();

    /**
     * @brief Get status code distribution
     */
    [[nodiscard]] std::map<int, size_t> status_code_distribution () const;

    /**
     * @brief Get all stored errors
     */
    [[nodiscard]] const std::vector<ResultRecord>& errors () const {
        return errors_;
    }

    /**
     * @brief Get latency count from histogram
     * @note Raw latencies are no longer stored; use calculate_percentiles() for analysis
     */
    [[nodiscard]] int64_t latency_count () const;

    /**
     * @brief Get stored response samples for script validation
     */
    [[nodiscard]] const std::vector<ResponseSample>& response_samples () const {
        return response_samples_;
    }

    /**
     * @brief Get count of stored response samples
     */
    [[nodiscard]] size_t response_sample_count () const {
        return response_samples_.size ();
    }

    // ========================================================================
    // Database persistence
    // ========================================================================

    /**
     * @brief Batch write all results to database
     * Call after test completion. Uses a single transaction for efficiency.
     * @return Number of results written
     */
    size_t flush_to_database (db::Database& db);

    /**
     * @brief Get memory usage estimate in bytes
     */
    [[nodiscard]] size_t memory_usage_bytes () const;

    /**
     * @brief Get current statistics as JSON (for live streaming)
     * Lock-free read from atomic counters, no database access
     * @param current_active Active connection count from event loop
     * @param elapsed_seconds Elapsed time since test start
     * @param requests_sent Total requests submitted to event loop (for send rate)
     * @param requests_expected Total expected requests for the run (0 for open-ended
     *        modes like constant_rps; feeds the dashboard ETA stat)
     * @param status_snapshot Optional precomputed status-code distribution. When
     *        non-null it is used verbatim for the `statusCodes` field and the
     *        derived class breakdown, avoiding a redundant scan when the caller
     *        already snapshotted the distribution this tick. When null the
     *        distribution is computed internally.
     * @param window_percentiles Optional windowed (rolling) percentiles for the
     *        `latencyP50Ms`/`latencyP95Ms`/`latencyP99Ms` fields. When non-null the
     *        live tick carries these recent-window values (see
     *        sample_window_percentiles). When null the fields fall back to the
     *        cumulative-from-start histogram - kept for callers/tests that don't
     *        drive the interval recorder.
     * @return JSON object with current metrics
     */
    [[nodiscard]] nlohmann::json get_current_stats (size_t current_active,
    double elapsed_seconds,
    size_t requests_sent,
    size_t requests_expected                     = 0,
    const std::map<int, size_t>* status_snapshot = nullptr,
    const Percentiles* window_percentiles        = nullptr) const;

    private:
    std::string run_id_;
    MetricsCollectorConfig config_;

    // Lock-free atomic counters for real-time stats
    std::atomic<size_t> total_requests_{ 0 };
    std::atomic<size_t> total_errors_{ 0 };
    std::atomic<double> total_latency_sum_{ 0.0 };
    std::atomic<size_t> dropped_requests_{ 0 };
    std::atomic<double> total_queue_wait_sum_{ 0.0 };
    std::atomic<size_t> total_bytes_sent_{ 0 };
    std::atomic<size_t> total_bytes_recv_{ 0 };

    // Per-code counts, lock-free on the hot path. HTTP status codes (and the
    // synthetic code 0 used for transport errors) live in [0, STATUS_CODE_SLOTS).
    // record_success/record_error do a single relaxed atomic increment here -
    // no mutex - so the recorder path scales to the 60k+ RPS target. Class
    // breakdowns (2xx..5xx) are derived at read time, not maintained on the hot
    // path. Out-of-range codes (>= STATUS_CODE_SLOTS or < 0) fall back to the
    // rarely-hit overflow map below; real HTTP traffic never takes that lock.
    static constexpr int STATUS_CODE_SLOTS = 600;
    std::array<std::atomic<size_t>, STATUS_CODE_SLOTS> status_code_counts_{};

    // Lock-free HdrHistogram for latency recording (thread-safe). Cumulative from
    // start of run - feeds calculate_percentiles() for the final report.
    struct hdr_histogram* latency_histogram_{ nullptr };

    // Phaser-based interval recorder for the windowed (rolling) percentiles that
    // the live/history per-tick series consume. Writers (record_success/
    // record_latency) record here in parallel with the cumulative histogram; the
    // producer thread sample-and-recycles it once per tick (sample_window_percentiles).
    struct hdr_interval_recorder interval_recorder_{};
    bool interval_recorder_ready_{ false };

    mutable std::mutex errors_mutex_;
    std::vector<ResultRecord> errors_;

    mutable std::mutex success_mutex_;
    std::vector<ResultRecord> success_results_;
    std::atomic<size_t> success_sample_counter_{ 0 };

    // Response samples for deferred script validation
    mutable std::mutex response_samples_mutex_;
    std::vector<ResponseSample> response_samples_;
    std::atomic<size_t> response_sample_counter_{ 0 };

    // Overflow for non-standard / out-of-range codes (e.g. 999 from misbehaving
    // proxies). Dead path for real traffic; guarded by a mutex it almost never
    // takes, so it adds no contention to the hot path.
    mutable std::mutex status_overflow_mutex_;
    std::map<int, size_t> status_overflow_;

    // Helper for atomic double addition
    void atomic_add_double (std::atomic<double>& target, double value);

    // Increment the count for a status code. Lock-free for codes in
    // [0, STATUS_CODE_SLOTS); falls back to the overflow map otherwise.
    void record_status_code (int status_code);
};

} // namespace vayu::core
