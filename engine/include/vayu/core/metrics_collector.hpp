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

    /// Maximum error records to store, 0 = unlimited (prevents OOM at high
    /// error rates). Errors past the cap are counted by errors_dropped().
    size_t max_errors = constants::metrics_collector::DEFAULT_MAX_ERRORS;

    /// Maximum sampled success results to store (for detailed trace data),
    /// 0 = unlimited. Retained as a reservoir, so the set is drawn from the
    /// whole run rather than its opening; what it displaces is counted by
    /// success_results_dropped().
    size_t max_success_results = constants::metrics_collector::DEFAULT_MAX_SUCCESS_RESULTS;

    /// Maximum slow-request records to store, 0 = unlimited. Its own budget:
    /// an outlier is stored because the user asked for outliers, so it must not
    /// consume a 1-in-N slot - and under saturation most completions cross the
    /// threshold, so the slow path cannot be unbounded either.
    size_t max_slow_results = constants::metrics_collector::DEFAULT_MAX_SLOW_RESULTS;

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
 * @brief Why a success trace was built, i.e. which budget retains it.
 *
 * A completion that is both sampled and slow is stored as Slow: the trace is
 * identical either way (it carries `isSlow`), and charging it to the slow
 * budget leaves the 1-in-N budget for ordinary traffic.
 */
enum class SuccessTraceReason {
    None,    ///< no trace was built for this completion
    Sampled, ///< the 1-in-N sampler selected it
    Slow     ///< it crossed slow_threshold_ms
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
     * @brief Advance the success sampling period and report whether this
     *        completion's trace should be built and stored.
     *
     * Call exactly once per successful completion, *before* building a trace.
     * The counter advances on every call whether or not the answer is true, so
     * the period keeps meaning "1 in N completions"; the caller then serialises
     * only for the completions that are actually retained, instead of building
     * N traces and discarding N-1 of them inside record_success.
     *
     * Returns false when success traces are switched off entirely
     * (save_timing_breakdown) - the slow-request path is separate and does not
     * go through here.
     */
    [[nodiscard]] bool should_sample_success ();

    /**
     * @brief Record a successful request
     * Thread-safe, optimized for high-throughput
     *
     * @param trace_data serialised timing breakdown, empty when none was built
     * @param trace_reason which budget retains @p trace_data. `None` with a
     *                   non-empty trace stores nothing - the two are decided
     *                   together by the caller (see should_sample_success).
     */
    void record_success (int status_code,
    double latency_ms,
    double queue_wait_ms,
    const std::string& trace_data   = "",
    SuccessTraceReason trace_reason = SuccessTraceReason::None);

    /**
     * @brief Record a response sample for deferred script validation
     * Thread-safe, stores sampled responses for post-test script execution
     */
    void record_response_sample (const Response& response);

    /**
     * @brief Record a failed request
     * Thread-safe. The error counters and the status-code distribution always
     * see every error; the individual record is stored only while the store is
     * below config_.max_errors (see errors_dropped).
     */
    void record_error (ErrorCode code,
    const std::string& message,
    const std::string& trace_data = "");

    /**
     * @brief Number of error records discarded because the store was full.
     * Non-zero means errors() (and the flushed results) are a prefix, not the
     * whole set - total_errors() remains exact.
     */
    [[nodiscard]] size_t errors_dropped () const {
        return errors_dropped_.load (std::memory_order_relaxed);
    }

    /**
     * @brief Sampled success records dropped or displaced by the reservoir.
     * Non-zero means the run produced more sampled traces than
     * max_success_results retains; the retained ones are still drawn from the
     * whole run, so this bounds what was thinned, not where it came from.
     */
    [[nodiscard]] size_t success_results_dropped () const {
        return success_dropped_.load (std::memory_order_relaxed);
    }

    /** @brief Slow-request records dropped or displaced by the reservoir. */
    [[nodiscard]] size_t slow_results_dropped () const {
        return slow_dropped_.load (std::memory_order_relaxed);
    }

    /** @brief Response samples dropped or displaced by the reservoir. */
    [[nodiscard]] size_t response_samples_dropped () const {
        return response_dropped_.load (std::memory_order_relaxed);
    }

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

    // ========================================================================
    // Real-time stats (lock-free reads)
    // ========================================================================

    [[nodiscard]] size_t total_requests () const {
        return total_requests_.load (std::memory_order_relaxed);
    }

    [[nodiscard]] size_t total_errors () const {
        return total_errors_.load (std::memory_order_relaxed);
    }

    /**
     * @brief Requests that completed without an error.
     *
     * total_requests_ and total_errors_ are separate relaxed atomics that
     * record_error bumps one after the other, so a reader can observe the error
     * increment before its paired request increment. The subtraction is
     * therefore guarded: unguarded it wraps to a huge size_t, which passes the
     * `> 0` denominator checks below and drives every average toward zero.
     */
    [[nodiscard]] size_t success_count () const {
        size_t total  = total_requests ();
        size_t errors = total_errors ();
        return total > errors ? total - errors : 0;
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
     * Backed by a phaser-based hdr_interval_recorder: record_success feeds the
     * recorder concurrently from worker threads while this single-reader
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
     * @brief Get the stored errors (a prefix of all errors when
     *        errors_dropped() is non-zero)
     */
    [[nodiscard]] const std::vector<ResultRecord>& errors () const {
        return errors_;
    }

    /**
     * @brief Get the retained sampled-success records (a uniform sample of the
     *        run when success_results_dropped() is non-zero)
     */
    [[nodiscard]] const std::vector<ResultRecord>& success_results () const {
        return success_results_;
    }

    /**
     * @brief Get the retained slow-request records (a uniform sample of the
     *        run's outliers when slow_results_dropped() is non-zero)
     */
    [[nodiscard]] const std::vector<ResultRecord>& slow_results () const {
        return slow_results_;
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

    // HdrHistogram for latency recording. Cumulative from start of run - feeds
    // calculate_percentiles() for the final report. Every worker thread records
    // into it concurrently, so writes MUST go through hdr_record_value_atomic;
    // the plain hdr_record_value is a non-atomic read-modify-write on counts[]
    // and total_count and loses increments under concurrency.
    struct hdr_histogram* latency_histogram_{ nullptr };

    // Phaser-based interval recorder for the windowed (rolling) percentiles that
    // the live/history per-tick series consume. record_success records here in
    // parallel with the cumulative histogram; the producer thread
    // sample-and-recycles it once per tick (sample_window_percentiles). The
    // phaser orders the reader's swap against writers - it is not mutual
    // exclusion between writers, so the write itself must be the atomic variant.
    struct hdr_interval_recorder interval_recorder_{};
    bool interval_recorder_ready_{ false };

    mutable std::mutex errors_mutex_;
    std::vector<ResultRecord> errors_;
    std::atomic<size_t> errors_dropped_{ 0 };

    // Sampled successes and slow-request outliers. One mutex for both: each is
    // written at most once per retained record (the 1-in-N gate and the
    // threshold have already run), so they never contend the way the raw
    // completion rate would.
    //
    // `*_sample_counter_` is the sampling period and advances once per
    // completion; `*_seen_` counts only the candidates offered to the
    // reservoir, which is what Algorithm R needs to keep the retained set
    // uniform over the run. The two cannot be merged - the period must tick for
    // completions the sampler skips, and the reservoir must not.
    mutable std::mutex success_mutex_;
    std::vector<ResultRecord> success_results_;
    std::atomic<size_t> success_sample_counter_{ 0 };
    std::atomic<size_t> success_seen_{ 0 };
    std::atomic<size_t> success_dropped_{ 0 };
    std::vector<ResultRecord> slow_results_;
    std::atomic<size_t> slow_seen_{ 0 };
    std::atomic<size_t> slow_dropped_{ 0 };

    // Response samples for deferred script validation
    mutable std::mutex response_samples_mutex_;
    std::vector<ResponseSample> response_samples_;
    std::atomic<size_t> response_sample_counter_{ 0 };
    std::atomic<size_t> response_seen_{ 0 };
    std::atomic<size_t> response_dropped_{ 0 };

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
