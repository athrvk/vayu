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
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
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
    /**
     * Scenario load runs only: the virtual user's iteration this response was
     * sent in, and the data row that iteration was bound to.
     *
     * Both absent for a single-request load run, where neither exists - the
     * deferred script then reads `pm.info.iteration` and `pm.iterationData` as
     * `undefined`, which is issue #300's ruling and stays intact: what that
     * ruling refuses is reporting a *reservoir position* as an iteration
     * number, a binding that cannot fail. A scenario step carries the real
     * iteration index it ran in, so reporting it is the honest answer rather
     * than the invented one.
     */
    std::optional<size_t> iteration;
    std::optional<size_t> data_row_index;

    ResponseSample () = default;
    ResponseSample (const Response& resp, int64_t ts)
    : status_code (resp.status_code), status_text (resp.status_text), body (resp.body),
      headers (resp.headers), latency_ms (resp.timing.total_ms), timestamp (ts) {
    }
};

/**
 * @brief A retained sample's response headers and body, copied on the hot path.
 *
 * Only the copy happens inline in the completion drain; everything expensive -
 * binary detection, hashing, dedup, JSON - waits for the flush (see
 * MetricsCollector::flush_to_database). The bytes here are already truncated
 * to `max_sample_body_bytes`, because copying a 30 MB body to throw 29.97 MB
 * of it away at flush would be paying the hot-path cost for nothing;
 * `body_bytes` remembers the size as received so a reader can tell a slice
 * from the whole.
 */
struct CapturedExchange {
    Headers headers;
    std::string body;
    std::string content_type;
    int64_t body_bytes = 0; ///< size as received, before truncation
    bool truncated     = false;
    /// The run's byte budget was already spent, so only headers were kept.
    bool body_dropped = false;
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
    /// Present only for the three captured buckets (errors, slow outliers,
    /// per-status exemplars). A uniformly sampled success carries none: a
    /// thousand identical 200s are not worth a thousand bodies.
    std::optional<CapturedExchange> capture;

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

    /// Whether retained samples carry the response headers and body. Off makes
    /// the collector byte-for-byte what it was before capture existed: no gate
    /// is consulted, no exemplar is claimed, nothing is copied.
    bool capture_response_bodies = constants::metrics_collector::DEFAULT_CAPTURE_RESPONSE_BODIES;

    /// Largest captured body per sample; the copy is truncated to it.
    size_t max_sample_body_bytes = constants::metrics_collector::DEFAULT_MAX_SAMPLE_BODY_BYTES;

    /// Whole-run budget for captured body bytes. Past it, samples keep their
    /// headers and metadata and lose only their bodies (sample_bodies_dropped).
    size_t max_sample_bytes = constants::metrics_collector::DEFAULT_MAX_SAMPLE_BYTES;

    /// Ceiling on the per-status exemplar store, 0 = unlimited.
    size_t max_exemplar_results = constants::metrics_collector::DEFAULT_MAX_EXEMPLAR_RESULTS;

    /// Whether the five per-phase histograms are allocated and fed. Off makes
    /// the collector byte-for-byte what it was before them: no bank is
    /// allocated, nothing is recorded, and `phase_percentiles()` answers
    /// nullopt - which is what keeps the report's `phases` section absent
    /// rather than showing five zeroed distributions.
    bool phase_histograms = constants::metrics_collector::DEFAULT_PHASE_HISTOGRAMS;

    /// Whether the per-completion event-count histogram is allocated and fed
    /// (issue #576). Same shape as `phase_histograms` above and for the same
    /// reason: off allocates nothing, records nothing, and `stream_percentiles()`
    /// answers nullopt, so the report's `stream` section is absent rather than
    /// a zeroed distribution. Only a run whose request streams ever feeds it -
    /// an ordinary run pays a null check per completion and nothing else.
    bool stream_metrics = constants::metrics_collector::DEFAULT_STREAM_METRICS;
};

/**
 * @brief The five network phases of a transfer, in wire order.
 *
 * Indexes the per-phase histogram bank and the array `phase_percentiles()`
 * returns; `TIMING_PHASE_KEYS` gives the wire name of each, so the enum and
 * the JSON cannot drift apart.
 */
enum class TimingPhase : size_t {
    Dns       = 0,
    Connect   = 1,
    Tls       = 2,
    FirstByte = 3,
    Download  = 4
};

inline constexpr size_t TIMING_PHASE_COUNT = 5;

/// Wire names, indexed by TimingPhase. The report's `timingBreakdown.phases`
/// object is keyed by these.
inline constexpr std::array<const char*, TIMING_PHASE_COUNT> TIMING_PHASE_KEYS = {
    "dns", "connect", "tls", "firstByte", "download"
};

/**
 * @brief Why a success trace was built, i.e. which budget retains it.
 *
 * A completion that is both sampled and slow is stored as Slow: the trace is
 * identical either way (it carries `isSlow`), and charging it to the slow
 * budget leaves the 1-in-N budget for ordinary traffic.
 *
 * `Exemplar` ranks **last** - it names the store for a completion no other
 * budget wanted. Ranking it first was tried and was wrong: the first few
 * completions of a status code are often exactly where a run's outliers are,
 * so it quietly emptied the slow store, which exists to hold what the user
 * asked for.
 *
 * This enum therefore says only *which budget pays*. Whether the record also
 * carries a captured body is a separate decision, made by the caller and
 * passed to record_success - a record can sit in the sampled budget and still
 * deserve a body, which no ordering of these three could express.
 */
enum class SuccessTraceReason {
    None,     ///< no trace was built for this completion
    Sampled,  ///< the 1-in-N sampler selected it
    Slow,     ///< it crossed slow_threshold_ms
    Exemplar  ///< it is one of the first EXEMPLARS_PER_STATUS of its status code
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
     * @brief Claim one of this status code's exemplar slots, if any are left.
     *
     * Phase 1 of capture, and the whole of what capture costs a completion
     * that is not retained: a single relaxed fetch_add on a fixed array,
     * decided before anything is built or copied. Returns true at most
     * `EXEMPLARS_PER_STATUS` times per distinct status code per run.
     *
     * "First K of each status code" rather than a uniform slice, because a
     * uniform slice of 30M requests is a thousand identical 200s, while three
     * of each code answers what the user is actually asking - what does this
     * target's 503 look like. Returns false when capture is off, so the caller
     * needs no second toggle check.
     */
    [[nodiscard]] bool claim_status_exemplar (int status_code);

    /**
     * @brief Record a successful request
     * Thread-safe, optimized for high-throughput
     *
     * @param trace_data serialised timing breakdown, empty when none was built
     * @param trace_reason which budget retains @p trace_data. `None` with a
     *                   non-empty trace stores nothing - the two are decided
     *                   together by the caller (see should_sample_success).
     * @param capture_source the live response, or nullptr to capture nothing.
     *                   Passed as a pointer rather than copied by the caller
     *                   so the headers and body are copied *after* the store
     *                   has accepted the record - a reservoir refusal costs no
     *                   body-sized copy. Honoured whatever @p trace_reason is:
     *                   the caller decides what deserves a body (see
     *                   handle_result), because the store a record lands in is
     *                   not what makes its body worth keeping.
     * @param phases the completion's phase breakdown, fed to the per-phase
     *                   histograms. Recorded **unconditionally** - it is
     *                   deliberately not coupled to @p trace_reason, because
     *                   escaping the ~1% retention sample is the entire point
     *                   of the bank. Pass the live `response.timing` rather
     *                   than five doubles: five adjacent parameters of the
     *                   same type is a transposition waiting to happen, and
     *                   the caller already holds the struct. nullptr, or a
     *                   collector built with `phase_histograms` off, records
     *                   nothing.
     */
    void record_success (int status_code,
    double latency_ms,
    double queue_wait_ms,
    const std::string& trace_data     = "",
    SuccessTraceReason trace_reason   = SuccessTraceReason::None,
    const Response* capture_source    = nullptr,
    const Timing* phases              = nullptr);

    /**
     * @brief Record a response sample for deferred script validation
     * Thread-safe, stores sampled responses for post-test script execution
     */
    void record_response_sample (const Response& response);

    /**
     * @brief Size the per-step sample stores for a scenario load run (#450).
     *
     * @param scripted One entry per plan step, true where that step carries a
     *        deferred script. A step with none is given no store at all: it is
     *        never sampled and never counted as a drop, because nothing was
     *        ever a candidate for a reservoir that does not exist.
     *
     * The run's whole `max_response_samples` budget is split evenly across the
     * **scripted** steps rather than across every step, so a forty-step plan
     * with two assertions gives those two the budget instead of thinning it
     * forty ways down to noise. The split has a floor of one sample per
     * scripted step: a plan with more scripted steps than the budget has slots
     * still validates every one of them, which is the property "the last step
     * of a long plan is sampled" actually needs. That floor is the only case
     * where the retained total can exceed the configured budget, and it is
     * bounded by `maxScenarioSteps`.
     *
     * Called once, before the first submission. Calling it twice, or after a
     * completion has landed, would resize a store a worker may be inside.
     */
    void configure_step_samples (const std::vector<bool>& scripted);

    /**
     * @brief Record a response sample against the plan step that produced it.
     *
     * The scenario counterpart of `record_response_sample`: one reservoir per
     * step, so one hot step cannot swamp the run's budget and leave the last
     * step of a long plan never sampled. A step `configure_step_samples` gave
     * no store returns immediately - the common case for a plan where only
     * some steps assert anything.
     *
     * @param iteration The virtual user's iteration this step ran in, and
     * @param data_row_index the row that iteration was bound to (absent for a
     *        run sent without `data`). Both are carried onto the sample so the
     *        deferred script reads the iteration it actually ran in - see
     *        ResponseSample.
     */
    void record_step_response_sample (const Response& response,
    size_t step_index,
    size_t iteration,
    std::optional<size_t> data_row_index);

    /**
     * @brief Record a failed request
     * Thread-safe. The error counters and the status-code distribution always
     * see every error; the individual record is stored only while the store is
     * below config_.max_errors (see errors_dropped).
     */
    void record_error (ErrorCode code,
    const std::string& message,
    const std::string& trace_data  = "",
    const Response* capture_source = nullptr);

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
     * @brief Exemplar records dropped because the exemplar store was full.
     * Only a target answering with more distinct status codes than
     * max_exemplar_results can reach this.
     */
    [[nodiscard]] size_t exemplar_results_dropped () const {
        return exemplar_dropped_.load (std::memory_order_relaxed);
    }

    /**
     * @brief Samples whose body was dropped because the run's capture budget
     *        was spent. Their headers and metadata were still captured.
     *
     * Surfaced so the Samples tab can say the captured set is incomplete
     * rather than presenting a silently biased subset as the whole story.
     */
    [[nodiscard]] size_t sample_bodies_dropped () const {
        return sample_bodies_dropped_.load (std::memory_order_relaxed);
    }

    /**
     * @brief Captured body bytes held for this run, after truncation.
     * The figure the budget is spent against.
     */
    [[nodiscard]] size_t captured_body_bytes () const {
        return captured_bytes_.load (std::memory_order_relaxed);
    }

    /**
     * @brief Captured exchanges written by the last flush_to_database.
     *
     * Zero until the run flushes. Non-zero is the run's marker that it holds
     * response headers and bodies stored verbatim - capture does not redact,
     * by decision, so this is what lets a reader be warned rather than left to
     * infer it.
     */
    [[nodiscard]] size_t response_bodies_captured () const {
        return response_bodies_captured_.load (std::memory_order_relaxed);
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

    /**
     * @brief Count one transfer that asked for HTTP/2 and got something older.
     *
     * Every other number this collector holds describes how the run performed;
     * this one describes whether the run measured what it claims to. A load
     * test whose requests all quietly fell back to HTTP/1.1 produces a complete,
     * plausible report labelled with the protocol that was requested and never
     * used - which is the failure mode of issue #215, and the reason a single
     * counter is worth carrying through the summary. Lock-free, called once per
     * completed transfer.
     */
    void record_http_version_downgrade () {
        http_version_downgraded_.fetch_add (1, std::memory_order_relaxed);
    }

    [[nodiscard]] size_t http_version_downgraded () const {
        return http_version_downgraded_.load (std::memory_order_relaxed);
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
        /**
         * How many completions the histogram these came from held.
         *
         * Zero is the only way to tell "nothing completed in this window" from
         * "everything completed instantly" - both report percentiles of 0. A
         * capacity search averages a level's windowed p99 across ticks, and
         * without this it would average in every idle window and conclude a
         * 500ms endpoint was meeting a 100ms budget.
         */
        size_t count = 0;
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
     * @brief Whole-run percentiles for each of the five network phases.
     *
     * Indexed by @ref TimingPhase. Read once, after the run has drained - the
     * bank is written concurrently by every event-loop worker and only this
     * post-run read is single-threaded, exactly like `calculate_percentiles`.
     *
     * `nullopt` says the run has no phase distribution to report at all:
     * either `phase_histograms` was off, or nothing successful completed.
     * Distinguishing that from "five phases that all measured 0ms" is why the
     * whole return is optional rather than an array of empty Percentiles - a
     * report showing a zeroed TLS row would claim the handshake was free.
     */
    [[nodiscard]] std::optional<std::array<Percentiles, TIMING_PHASE_COUNT>> phase_percentiles () const;

    /**
     * @brief What a streaming run's completions delivered (issue #576).
     *
     * `nullopt` for every run that streamed nothing - `stream_metrics` off, or
     * no completion that carried an event count - which is what keeps the
     * report's `stream` section absent for the ordinary load run rather than
     * present and zeroed.
     *
     * `events` is the per-completion distribution: a run of 500 streams each
     * delivering ~40 events has a p50 near 40, not near 20000. The per-second
     * rate the report derives from `total_events` and the run's duration is the
     * other question ("how fast did this target push"), and the two are
     * deliberately both reported - one stream delivering 10k events and 250
     * delivering 40 each are the same rate and a very different run.
     */
    struct StreamTotals {
        /// Completions that carried an event count, i.e. streams that finished.
        size_t completions = 0;
        /// Events summed across them - the numerator of events/sec.
        size_t total_events = 0;
        /// How many of those completions a cap ended, rather than the server.
        /// All of them is the honest signal that the caps, not the target, are
        /// what the run measured.
        size_t capped = 0;
        /// Per-completion event-count distribution; counts, not milliseconds.
        Percentiles events;
    };

    [[nodiscard]] std::optional<StreamTotals> stream_totals () const;

    /**
     * @brief Record one bounded stream's completion (issue #576).
     *
     * Called from `handle_result` for every completion whose response carried
     * an event count, success or failure alike: a stream the target killed
     * halfway still delivered what it delivered, and excluding it would report
     * a run's throughput off the streams that happened to survive.
     */
    void record_stream_completion (size_t events, bool capped);

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
     * @brief Get the retained per-status exemplar records - the first
     *        EXEMPLARS_PER_STATUS completions of each distinct status code.
     */
    [[nodiscard]] const std::vector<ResultRecord>& exemplar_results () const {
        return exemplar_results_;
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

    /**
     * @brief How many plan steps `configure_step_samples` was told about.
     * Zero for a single-request load run, which is what tells the deferred
     * validation pass which of the two shapes it is looking at.
     */
    [[nodiscard]] size_t step_sample_step_count () const {
        return step_samples_.size ();
    }

    /**
     * @brief A step's stored response samples, empty for an unsampled step.
     *
     * Read after the run has drained (the deferred validation pass), for the
     * same reason `response_samples()` is: a reference into a store a worker
     * could still be inserting into would be a race, and by then none can.
     */
    [[nodiscard]] const std::vector<ResponseSample>& step_response_samples (
    size_t step_index) const;

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
    std::atomic<size_t> http_version_downgraded_{ 0 };

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

    // One cumulative histogram per network phase, indexed by TimingPhase. Same
    // range and precision as latency_histogram_, so a phase's p99 and the
    // run's are read on the same scale rather than at two resolutions.
    //
    // All-null when `phase_histograms` is off - the null check in
    // record_success is then the whole cost of the feature on the completion
    // path, and phase_percentiles() answers nullopt. Written from every
    // event-loop worker, so records go through hdr_record_value_atomic for the
    // same reason latency_histogram_'s do; read once after the drain.
    std::array<struct hdr_histogram*, TIMING_PHASE_COUNT> phase_histograms_{};

    // Per-completion event counts for a streaming run (issue #576). Null when
    // `stream_metrics` is off, exactly like the bank above, so the null check
    // in record_stream_completion is the whole cost for a run that does not
    // stream. Counts rather than microseconds - it shares nothing with the
    // latency histograms but their precision.
    struct hdr_histogram* stream_events_histogram_ = nullptr;
    std::atomic<size_t> stream_completions_{ 0 };
    std::atomic<size_t> stream_events_total_{ 0 };
    std::atomic<size_t> stream_capped_{ 0 };

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
    // Per-status exemplars. Shares success_mutex_ with the two stores above:
    // the gate that fills it fires at most EXEMPLARS_PER_STATUS times per
    // status code for the whole run, so it contends with nothing.
    //
    // Not a reservoir, unlike its neighbours - a displaced exemplar is not an
    // exemplar. Past max_exemplar_results a later candidate is refused and
    // counted rather than evicting an incumbent.
    std::vector<ResultRecord> exemplar_results_;
    std::atomic<size_t> exemplar_dropped_{ 0 };
    // How many exemplar slots each status code has spent. Indexed the same way
    // as status_code_counts_, with the overflow codes sharing the last slot -
    // a target answering 999 gets exemplars, just not per-code ones.
    std::array<std::atomic<size_t>, STATUS_CODE_SLOTS> exemplar_claims_{};

    // Response samples for deferred script validation
    mutable std::mutex response_samples_mutex_;
    std::vector<ResponseSample> response_samples_;
    std::atomic<size_t> response_sample_counter_{ 0 };
    std::atomic<size_t> response_seen_{ 0 };
    std::atomic<size_t> response_dropped_{ 0 };

    /**
     * @brief One reservoir per plan step, for a scenario load run's deferred
     *        per-step validation. Empty for a single-request load run.
     *
     * Held by pointer because each store owns a mutex and two counters, none of
     * which are movable - the vector is sized once by
     * `configure_step_samples` and never grows again, so a worker holding a
     * store's lock can never have it reallocated out from under it.
     *
     * `capacity == 0` is a step nothing will ever validate. Its store exists
     * only to keep the vector indexable by step, and refuses every candidate
     * without counting a drop - a response no script will read is not a
     * retained sample the run thinned away.
     */
    struct StepSampleStore {
        mutable std::mutex mutex;
        std::vector<ResponseSample> samples;
        std::atomic<size_t> rate_counter{ 0 };
        std::atomic<size_t> seen{ 0 };
        size_t capacity = 0;
    };
    std::vector<std::unique_ptr<StepSampleStore>> step_samples_;
    /// Returned for a step index no store covers, so the accessor can hand back
    /// a reference rather than an optional every caller would have to unwrap.
    static const std::vector<ResponseSample> NO_SAMPLES;

    // Overflow for non-standard / out-of-range codes (e.g. 999 from misbehaving
    // proxies). Dead path for real traffic; guarded by a mutex it almost never
    // takes, so it adds no contention to the hot path.
    mutable std::mutex status_overflow_mutex_;
    std::map<int, size_t> status_overflow_;

    // Whole-run capture budget, spent in `max_sample_body_bytes`-bounded
    // chunks by the copies below.
    std::atomic<size_t> captured_bytes_{ 0 };
    std::atomic<size_t> sample_bodies_dropped_{ 0 };
    std::atomic<size_t> response_bodies_captured_{ 0 };

    /**
     * @brief Phase 2 of capture: copy the exchange into a record the store has
     *        already accepted.
     *
     * Never called before a slot is claimed, so a refused candidate costs no
     * body-sized copy. Charges the run budget atomically; when it is spent the
     * headers and metadata are still captured and only the body is dropped
     * (counted by sample_bodies_dropped) - metadata is what tells the reader
     * the set is incomplete, so dropping that too would hide the truncation
     * being reported.
     */
    [[nodiscard]] CapturedExchange capture_exchange (const Response& response);

    // Helper for atomic double addition
    void atomic_add_double (std::atomic<double>& target, double value);

    // Increment the count for a status code. Lock-free for codes in
    // [0, STATUS_CODE_SLOTS); falls back to the overflow map otherwise.
    void record_status_code (int status_code);
};

} // namespace vayu::core
