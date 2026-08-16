#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "vayu/core/auth_refresh.hpp"
#include "vayu/core/capacity_controller.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/metrics_collector.hpp"
#include "vayu/core/monitor.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/threshold_eval.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/event_loop.hpp"

namespace vayu::http {
// A scenario run's steps send through the daemon's jar; the manager only passes
// the reference along, so the listener machinery stays out of this header.
class CookieJar;
} // namespace vayu::http

namespace vayu::core {

/**
 * @brief One wire-ready SSE frame: `event: <name>`, `id: <offset>`, `data:`.
 *
 * The single framing copy. `RunContext::append_event` builds through it under
 * the ring's lock, and the extracted-for-testing `build_tick_payload` /
 * `build_step_payload` delegate to it - so a run's `metrics`, `step` and
 * `monitor` frames cannot drift into three shapes, and a consumer resuming from
 * `Last-Event-ID` sees one id space across all of them.
 */
[[nodiscard]] inline std::string
build_sse_frame (const std::string& event_name, const std::string& data, size_t offset) {
    return "event: " + event_name + "\nid: " + std::to_string (offset) + "\ndata: " + data + "\n\n";
}

/**
 * @brief Ring capacity for a run's live tick topic: how many ticks fit in
 * `window_ms` at a cadence of `tick_interval_ms`, floored at one tick and
 * clamped to `max_ticks` (the `liveMaxRetainedTicks` setting).
 *
 * Sizing from a duration rather than a fixed count is the point: both inputs
 * are user-configurable, and `liveTickIntervalMs` spans 10-1000ms, so one tick
 * count means a 30-second window at one end of that range and a 50-minute one
 * at the other. Deriving the count preserves the *time* the user asked for -
 * the same unit the dashboard's live-chart window setting uses.
 *
 * `window_ms == 0` is the "Full run" setting - no time limit - and yields the
 * ceiling, which is then the whole bound. A *negative* window is not a setting
 * (POST /config rejects it); like a non-positive interval it can only reach
 * here from a hand-edited config row, so it falls back to the default rather
 * than being trusted.
 */
[[nodiscard]] constexpr size_t live_ring_size (int64_t window_ms,
int64_t tick_interval_ms,
size_t max_ticks = constants::server::DEFAULT_MAX_LIVE_TICKS) {
    if (tick_interval_ms <= 0) {
        tick_interval_ms = constants::server::STATS_INTERVAL_MS;
    }
    if (max_ticks < 1) {
        max_ticks = constants::server::DEFAULT_MAX_LIVE_TICKS;
    }
    if (window_ms == 0) {
        return max_ticks;
    }
    if (window_ms < 0) {
        window_ms = constants::server::DEFAULT_LIVE_REPLAY_WINDOW_MS;
    }
    auto ticks = static_cast<size_t> (window_ms / tick_interval_ms);
    if (ticks < 1) {
        ticks = 1;
    }
    return ticks > max_ticks ? max_ticks : ticks;
}

/**
 * @brief Engine-config-backed defaults a run needs at construction time.
 *
 * RunContext is built from the run's JSON alone - it holds no Database - so
 * anything whose default lives in `config_entries` is resolved by the caller
 * and handed in, the way `maxStoredErrors` always has been. A run's own config
 * still overrides these; they are only what it falls back to.
 *
 * Named for that role rather than for capture, which is what the first two
 * fields happen to be about - `phase_histograms` reaches RunContext by the
 * same route for the same reason and is not a capture knob.
 */
struct EngineDefaults {
    size_t max_sample_body_bytes = constants::metrics_collector::DEFAULT_MAX_SAMPLE_BODY_BYTES;
    size_t max_sample_bytes = constants::metrics_collector::DEFAULT_MAX_SAMPLE_BYTES;
    /// Config key `phaseHistograms`. Whether the run feeds the five per-phase
    /// histograms behind the report's `timingBreakdown.phases`.
    bool phase_histograms = constants::metrics_collector::DEFAULT_PHASE_HISTOGRAMS;

    /// Config keys `sseMaxStreamDurationMs` / `sseMaxStreamEvents` - the same
    /// two the design path's stream defaults from, read here so a load stream
    /// the caller gave no caps is bounded by the user's own settings rather
    /// than by a second set of numbers that happen to live in the load code
    /// (issue #576).
    int64_t stream_max_duration_ms = constants::sse::MAX_STREAM_DURATION_MS;
    int64_t stream_max_events      = constants::sse::MAX_STREAM_EVENTS;
};

struct RunContext {
    std::string run_id;
    std::unique_ptr<vayu::http::EventLoop> event_loop;
    // The run's worker thread is NOT owned here: it holds a shared_ptr to this
    // context, so a context whose last reference is dropped by its own worker
    // (a retained run swept while the worker is still unwinding) would join
    // itself and terminate. RunManager owns the handle instead - see
    // `run_workers_` - and joins it from a thread that is never the worker.
    std::thread metrics_thread;
    /**
     * The server-vitals scrape loop, spawned only for a run whose config
     * carries a usable `monitor` block. Owned and joined exactly like
     * `metrics_thread` - both exit on `is_running` and are joined by the worker
     * before it writes the summary, which is what makes `monitor_totals`
     * readable without a lock.
     *
     * It is a second thread rather than work on the metrics thread because that
     * one is a fixed-cadence sampler with no deadline compensation: a blocking
     * HTTP call inside it delays every subsequent tick by the scrape's latency,
     * and a hanging endpoint would stop live metrics for the whole run.
     */
    std::thread monitor_thread;
    /// Per-series totals for the report's `monitor` section; null when the run
    /// configured no monitor. Written by `monitor_thread`, read after its join.
    std::unique_ptr<MonitorTotals> monitor_totals;
    // Refreshes the run's OAuth 2.0 credential before it expires. Spawned only
    // when the run's auth can actually be refreshed (see
    // `http::plan_auth_refresh`), joined everywhere metrics_thread is - it
    // holds a shared_ptr to this context and calls a blocking HTTP client, so
    // an unjoined one outlives the database it acquires through.
    std::thread auth_refresh_thread;
    // The credential that thread publishes and the strategy thread sends. Null
    // for every run without mid-run refresh, which is the inert case
    // everywhere: no thread, no swap, no report section.
    std::shared_ptr<AuthRefreshState> auth_refresh;
    std::atomic<bool> should_stop{ false };
    std::atomic<bool> is_running{ false };
    nlohmann::json config;
    int64_t start_time_ms;

    // Test script for deferred validation
    std::string test_script;

    // Latency (ms) past which a completion is captured as an outlier, resolved
    // once from the run config. 0 disables outlier capture - a threshold of
    // zero would mark every completion an outlier, which is the same as
    // marking none. Read per completion in handle_result, which runs inline on
    // an event-loop worker inside the curl completion drain: a `config.value
    // (...)` there is a string-keyed map lookup on the critical path of that
    // worker's socket processing, twice per request, to re-read a value fixed
    // when the run started.
    //
    // `save_timing_breakdown` is resolved in the same constructor but lives on
    // MetricsCollectorConfig::store_success_traces, which is where the sampling
    // gate reads it; a second copy here would have no reader.
    int slow_threshold_ms{ constants::metrics_collector::DEFAULT_SLOW_THRESHOLD_MS };

    // Whether retained samples carry their response headers and body, resolved
    // once here for the same reason as `slow_threshold_ms` above: handle_result
    // reads it per completion inside the curl completion drain, where a
    // string-keyed `config.value(...)` is on the critical path of that worker's
    // socket processing. The collector holds its own copy (it decides what to
    // copy); this one exists so a capture-off run never even reaches the
    // exemplar gate.
    bool capture_response_bodies{ constants::metrics_collector::DEFAULT_CAPTURE_RESPONSE_BODIES };

    /**
     * The caps this run's transfers stream under, or absent for the ordinary
     * load run that does not stream (issue #576).
     *
     * Resolved once in the constructor - the caller's `maxStreamDurationMs` /
     * `maxStreamEvents` over the engine's `sse*` settings - and copied onto
     * every `Request` the executors submit. Resolved here rather than per
     * submission because it is the same two numbers for every transfer of the
     * run, and per-submission it would be two string-keyed JSON lookups on the
     * strategy thread's hot path.
     */
    std::optional<vayu::StreamBounds> stream_bounds;

    // High-performance in-memory metrics collector
    // Replaces direct DB writes for individual results during load tests
    std::unique_ptr<MetricsCollector> metrics_collector;

    /**
     * The plan a *load-mode* scenario run executes, or null for a
     * single-request load run. Resolved before the run row existed and shared
     * immutably, exactly as the design-mode runner's is.
     *
     * It lives on the context rather than being threaded through
     * `execute_load_test` as a parameter because the whole lifecycle around the
     * executor - the event loop, the metrics thread, the drain, the flush, the
     * summary, the retain - is identical for both kinds of load run. Only the
     * choice of executor differs, and that is the one place this is read.
     */
    std::shared_ptr<const ScenarioExecution> scenario;

    // Real-time counters (also tracked by MetricsCollector, but kept for backward compat)
    std::atomic<size_t> requests_sent{ 0 }; // Number of requests submitted to event loop
    std::atomic<size_t> requests_expected{ 0 }; // Total expected requests for this run

    // Closed-loop concurrency control. The strategy thread is the SOLE producer
    // (each worker queue is SPSC); it waits on refill_cv and is woken per
    // completion by handle_result. Timeout-backed: correctness never depends on
    // a wakeup (total_requests only increases, so a missed notify can only
    // briefly undershoot the target, never overshoot).
    std::mutex refill_mtx;
    std::condition_variable refill_cv;
    std::atomic<bool> closed_loop{ false };
    std::atomic<size_t> peak_in_flight{ 0 }; // high-water mark of in_flight()

    // ---- Live metrics "topic" (N1) ---------------------------------------
    // Ring capacity in ticks, derived from `liveReplayWindowMs` and this run's
    // tick cadence once the metrics thread reads config (see collect_metrics).
    // The initializer covers the stock window at the stock cadence, so a direct
    // append_tick caller - a test, or a run whose thread has not read config
    // yet - is bounded too rather than falling back to unlimited.
    std::atomic<size_t> max_live_ticks{ live_ring_size (
    constants::server::DEFAULT_LIVE_REPLAY_WINDOW_MS, constants::server::STATS_INTERVAL_MS) };

    // Bounded ring of wire-ready SSE payload strings (each is a full
    // "event: metrics\nid: <n>\ndata: {...}\n\n"). Produced by the metrics
    // thread, replayed+tailed by /runs/:id/live. MUST be mutex-guarded - a
    // realloc would move/free the backing array under a concurrent reader (UAF)
    // even for already-published indices, so the atomic offset alone is not
    // enough. Readers copy out under the lock.
    //
    // The ring holds the newest `max_live_ticks` payloads; `published_count`
    // keeps counting every tick ever published, so SSE event ids stay monotonic
    // across an eviction and the /live termination check still compares like
    // with like. Duration is user-controlled with no upper bound, so an
    // append-only buffer grows without limit for the life of a run (~0.5 GB
    // over an overnight soak at the default 10 ticks/sec).
    mutable std::mutex tick_mtx;
    std::deque<std::string> tick_buffer;
    size_t tick_base_offset{ 0 };  // absolute index of tick_buffer.front(); tick_mtx
    std::atomic<size_t> published_count{ 0 }; // total ticks ever published
    std::atomic<bool> closed{ false };         // set true AFTER final tick appended
    std::atomic<int64_t> completed_at_ms{ 0 }; // 0 while running; stamped at completion

    // A batch of replayed ticks plus the absolute offset the consumer should ask
    // for next. `next_offset` is not always `from + payloads.size()`: a consumer
    // resuming from before the retained window is fast-forwarded to the oldest
    // retained tick, and must adopt this offset or it would re-request evicted
    // ids forever.
    struct TickBatch {
        std::vector<std::string> payloads;
        size_t next_offset = 0;
    };

    // Resize the retained window. Called once per run by the metrics thread
    // before the first tick; the ring trims on the next append rather than
    // here, so a shrink costs nothing on the caller's path.
    void set_max_live_ticks (size_t cap) {
        max_live_ticks.store (cap > 0 ? cap : 1, std::memory_order_relaxed);
    }

    void append_tick (std::string payload) {
        std::lock_guard<std::mutex> lock (tick_mtx);
        append_locked (std::move (payload));
    }

    /**
     * @brief Frame one SSE event and publish it, assigning its id under the
     *        ring's own lock.
     *
     * The id must be the slot the frame lands in, and a run with a monitor has
     * **two** producers on this ring - the metrics thread and the scrape loop.
     * Reading `published_count` and appending as two steps would hand both the
     * same id under interleaving, which breaks `Last-Event-ID` resume (a
     * consumer that saw the duplicate skips whichever frame it did not read).
     * Framing here makes that impossible rather than unlikely.
     */
    void append_event (const std::string& event_name, const std::string& data) {
        std::lock_guard<std::mutex> lock (tick_mtx);
        size_t offset = tick_base_offset + tick_buffer.size ();
        append_locked (build_sse_frame (event_name, data, offset));
    }
    [[nodiscard]] TickBatch ticks_since (size_t from) const {
        std::lock_guard<std::mutex> lock (tick_mtx);
        size_t end = tick_base_offset + tick_buffer.size ();
        if (from >= end) return { {}, from };
        size_t start = from < tick_base_offset ? tick_base_offset : from;
        auto begin_it =
        tick_buffer.begin () + static_cast<std::ptrdiff_t> (start - tick_base_offset);
        return { { begin_it, tick_buffer.end () }, end };
    }
    /// Push one already-framed payload and trim the ring. Caller holds `tick_mtx`.
    void append_locked (std::string payload) {
        tick_buffer.push_back (std::move (payload));
        // A loop, not an `if`: the cap can drop between appends, and one
        // eviction per append would take the whole run to converge on it.
        size_t cap = max_live_ticks.load (std::memory_order_relaxed);
        while (tick_buffer.size () > cap) {
            tick_buffer.pop_front ();
            ++tick_base_offset;
        }
        published_count.store (tick_base_offset + tick_buffer.size (),
        std::memory_order_release);
    }

    [[nodiscard]] size_t tick_count () const {
        std::lock_guard<std::mutex> lock (tick_mtx);
        return tick_buffer.size ();
    }

    // notify_refill deliberately does NOT lock refill_mtx - locking on every
    // completion would put a contended mutex on the 60k-RPS hot path.
    void notify_refill () {
        refill_cv.notify_one ();
    }

    // ---- Published metric tick (the strategies' one feedback path) --------
    /**
     * The numbers of the most recent live tick, as the dashboard sees them.
     *
     * The capacity strategy needs windowed percentiles to steer by, and it must
     * NOT call `MetricsCollector::sample_window_percentiles()` for them: that
     * call is documented single-reader and *resets* the window on read, and the
     * metrics thread already consumes it once per tick in `emit_live_tick`. A
     * second consumer would silently halve both readers' sample counts.
     *
     * So the producer publishes what it already computed, and the strategy
     * copies it out. One writer (the metrics thread), cheap reads, and the
     * controller steers by exactly the figures the live chart is drawing.
     */
    struct LiveTick {
        /// Monotonic per run, starting at 1. A reader compares it against the
        /// last one it saw to tell a fresh tick from a re-read of the same one;
        /// a wall-clock timestamp cannot, since two ticks can share a
        /// millisecond and the clock can step.
        uint64_t sequence     = 0;
        double latency_p50_ms = 0.0;
        double latency_p95_ms = 0.0;
        double latency_p99_ms = 0.0;
        double current_rps    = 0.0;
        size_t in_flight      = 0;
        /// Completions the percentiles above were computed over. Zero means an
        /// idle window, whose percentiles are zeros and must not be read as a
        /// service answering instantly.
        size_t latency_samples = 0;
    };
    mutable std::mutex live_tick_mtx;
    std::optional<LiveTick> live_tick_; // live_tick_mtx

    /// Publish this tick's numbers. Called once per tick by the metrics thread
    /// and by nothing else.
    void publish_live_tick (const LiveTick& tick) {
        std::lock_guard<std::mutex> lock (live_tick_mtx);
        LiveTick published = tick;
        published.sequence = live_tick_ ? live_tick_->sequence + 1 : 1;
        live_tick_         = published;
    }

    /// The most recently published tick, or `nullopt` before the first one.
    [[nodiscard]] std::optional<LiveTick> latest_live_tick () const {
        std::lock_guard<std::mutex> lock (live_tick_mtx);
        return live_tick_;
    }

    /**
     * What a capacity run's search found, written by `CapacityLoadStrategy`
     * once its loop ends and read by `execute_load_test` when it builds the
     * summary - both on the worker thread, after the strategy's frame has
     * returned, so it needs no lock of its own. Absent for every other mode,
     * which is what keeps the report's `capacity` section out.
     */
    std::optional<CapacitySummary> capacity;

    // Legacy accessors for backward compatibility (delegate to metrics_collector)
    [[nodiscard]] size_t total_requests () const {
        return metrics_collector ? metrics_collector->total_requests () : 0;
    }
    // True in-flight requests: submitted but not yet completed (success or
    // error). This is the correct quantity for the maxInFlight cap and ramp
    // backpressure, unlike EventLoop::pending_count() which only measures the
    // submission-queue depth that workers drain to ~0. The subtraction is
    // guarded against size_t underflow because requests_sent (written by the
    // strategy thread) and total_requests (written by worker callbacks) are
    // read with relaxed ordering and may momentarily disagree.
    [[nodiscard]] size_t in_flight () const {
        size_t sent = requests_sent.load ();
        size_t done = total_requests ();
        return sent > done ? sent - done : 0;
    }
    [[nodiscard]] size_t total_errors () const {
        return metrics_collector ? metrics_collector->total_errors () : 0;
    }
    // The one average-latency definition for this run: the latency sum over the
    // requests that contributed to it (successes). Every caller - the stop
    // response, the per-tick rows, the final report - goes through here so they
    // cannot disagree; dividing the same sum by total_requests() instead
    // silently reports a lower figure on any run with errors.
    [[nodiscard]] double average_latency_ms () const {
        return metrics_collector ? metrics_collector->average_latency () : 0.0;
    }

    // `max_errors` is the `maxStoredErrors` setting (0 = unlimited). It is a
    // constructor argument rather than something set afterwards because the
    // collector sizes its error store from it up front; RunManager::start_run
    // reads the key, and the default keeps direct constructions (tests, and any
    // caller without a database to hand) on the stock cap.
    RunContext (const std::string& id,
    nlohmann::json cfg,
    size_t max_errors                = constants::metrics_collector::DEFAULT_MAX_ERRORS,
    EngineDefaults engine_defaults = {});
    ~RunContext ();

    /**
     * @brief Join the run's auxiliary threads (metrics tick, auth refresh).
     *
     * Both watch `is_running`, so the caller clears it first. They are joined
     * through one helper because the run has four exit paths - two inner
     * failure returns, the normal end, and the outer catch - and a thread added
     * to the spawn site but missed at one of them outlives the database it
     * writes through.
     */
    void join_aux_threads ();
};

/**
 * @brief One persisted metrics tick, in the field names the time-series
 * response uses.
 *
 * The producer fills this once per DB-gated tick; `build_metric_tick_payload`
 * turns it into the JSON stored in `metric_ticks.payload` and returned verbatim
 * as one `data[]` entry by `GET /runs/:id/metrics`. Naming the fields after the
 * response keys is deliberate - the struct *is* the wire shape, so a reader
 * comparing the two has one mapping to check, not two.
 */
struct MetricTickSample {
    int64_t timestamp      = 0;   // Unix ms; the tick's single wall-clock sample
    double elapsed_seconds = 0.0; // Seconds since the run's first persisted tick
    size_t requests_completed = 0; // Responses received (success + error)
    size_t requests_failed    = 0; // Of those, errors
    double current_rps        = 0.0;
    size_t current_concurrency = 0;
    double send_rate           = 0.0;
    double throughput          = 0.0;
    size_t backpressure        = 0; // Sent but not yet responded
    double error_rate          = 0.0; // Percent
    size_t dropped_requests    = 0;
    size_t bytes_sent          = 0;
    size_t bytes_received      = 0;
    std::map<int, size_t> status_codes; // Cumulative; code 0 = transport errors
    // Windowed (rolling) percentiles for this tick, not cumulative.
    double latency_p50_ms = 0.0;
    double latency_p95_ms = 0.0;
    double latency_p99_ms = 0.0;
};

/**
 * @brief Serialize a tick sample into the stored `metric_ticks.payload` object.
 *
 * Key set and value types are the contract `GET /runs/:id/metrics` returns:
 * `http/routes/metrics.cpp` serves each stored row as one `data[]` entry, so
 * whatever this writes is what the app reads. Since issue #177 there is no
 * second implementation of the object to cross-check against, so
 * stats_route_test.cpp pins this payload directly against the shape the app's
 * `LoadTestMetrics` expects - see its comment above the pinning test.
 */
[[nodiscard]] nlohmann::json build_metric_tick_payload (const MetricTickSample& sample);

/** @brief Script-validation tallies, when deferred validation actually ran. */
struct ScriptValidationTotals {
    size_t sampled = 0;
    size_t passed  = 0;
    size_t failed  = 0;
};

/**
 * @brief What the deferred validation pass found, for the run and per step.
 *
 * `run` is the whole-run headline the report's `testValidation` section has
 * always shown; `steps` is a scenario load run's per-step breakdown, which is
 * the only reading that says *which* step's assertion failed. Both, rather than
 * one: a sequence's aggregate answers "did anything fail" and the breakdown
 * answers "where", and neither is derivable from the other.
 */
struct ScriptValidation {
    /// Absent when validation did not run at all - no script, or no samples.
    std::optional<ScriptValidationTotals> run;
    /**
     * One entry per plan step, in plan order, for a scenario load run; empty
     * for a single-request run. An entry is absent where that step carried no
     * script, or carried one and produced no sample to replay it against.
     */
    std::vector<std::optional<ScriptValidationTotals>> steps;
};

/**
 * @brief Replay the run's deferred test scripts against its sampled responses.
 *
 * Runs after the load test has drained, which is what keeps it off the hot
 * path: a `tests` script is executed once per *sampled* response, never per
 * completion. Two shapes, chosen by what the run is:
 *
 * - a single-request run replays `RunContext::test_script` against the run's
 *   one sample store;
 * - a **scenario** load run replays each step's own `post_script` against that
 *   step's samples, and reports the tallies per step (issue #450).
 *
 * `pm.execution` throws in both (`in_scenario` stays false) - a script that has
 * already run against a recorded response cannot redirect a sequence that
 * already happened.
 *
 * Declared here rather than kept file-local so the per-step behaviour can be
 * tested directly against a drained run; the production caller is
 * `execute_load_test`.
 *
 * @param verbose Log the tallies, as the run's own logging does.
 */
[[nodiscard]] ScriptValidation validate_scripts (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
bool verbose);

/**
 * @brief Hang each step's deferred-validation tallies off its entry in a
 *        scenario summary's `steps` array.
 *
 * Merged rather than passed into `build_scenario_load_summary` because the two
 * halves are produced at different times by different code: the breakdown comes
 * from the executor's per-step histograms, the tallies from the validation pass
 * that can only run once the samples are final.
 *
 * A step with no tallies keeps no `tests` key at all, so a reader can tell
 * "this step asserted nothing" from "this step's assertions all passed" - the
 * same distinction the whole-run section keeps by being absent.
 */
void attach_step_test_totals (nlohmann::json& scenario,
const std::vector<std::optional<ScriptValidationTotals>>& per_step);

/**
 * @brief What each bounded store thinned away, for the run summary.
 *
 * Every store the collector keeps is capped, so a long enough run retains a
 * sample rather than the whole set. The counts say how much was thinned: a
 * report that shows 1000 sampled traces out of a 3M-request run is telling the
 * truth only if it can also say that 29,000 candidates were displaced. Zero
 * everywhere means the stored set is complete.
 */
struct SamplingRetention {
    size_t errors_dropped           = 0;
    size_t success_traces_dropped   = 0;
    size_t slow_traces_dropped      = 0;
    size_t response_samples_dropped = 0;
    size_t exemplars_dropped        = 0;
    /// Samples whose body was dropped once the run's capture budget was spent.
    size_t sample_bodies_dropped = 0;
    /// Captured exchanges persisted for this run. Doubles as the run's marker
    /// that it holds response data stored verbatim - headers and bodies are
    /// captured without redaction, so a non-zero count is what lets the Samples
    /// tab warn that the stored set may contain credentials. Deleted with the
    /// run, which makes `maxRunsRetained` the expiry for that data too.
    size_t response_bodies_captured = 0;
};

/**
 * @brief Whole-run results, the inputs to the stored `runs.summary` object.
 *
 * Everything `GET /runs/:id/report` used to re-derive by scanning the run's
 * metric rows, known once at completion. `latency` holds the cumulative
 * (whole-run) percentiles, never a window.
 */
struct RunSummaryInputs {
    size_t total_requests     = 0;
    double rps                = 0.0;
    double send_rate          = 0.0;
    double throughput         = 0.0;
    double test_duration_s    = 0.0;
    double setup_overhead_s   = 0.0;
    size_t peak_concurrency   = 0;
    size_t dropped_requests   = 0;
    double queue_wait_avg_ms  = 0.0;
    size_t bytes_sent         = 0;
    size_t bytes_received     = 0;
    std::map<int, size_t> status_codes;
    MetricsCollector::Percentiles latency; // min/max/p50..p999, whole-run
    double latency_avg_ms = 0.0; // Mean latency; the histogram does not carry it
    // Whole-run percentiles for each of the five network phases, indexed by
    // TimingPhase. Absent when the run recorded none (the `phaseHistograms`
    // toggle off, or nothing successful completed), which keeps the report's
    // `timingBreakdown.phases` object out rather than showing five zeroed
    // distributions - the same absent-not-zeros rule `capacity` follows.
    std::optional<std::array<MetricsCollector::Percentiles, TIMING_PHASE_COUNT>> phases;
    // Transfers that asked for HTTP/2 and negotiated something older. The one
    // figure here that is about the report's own validity rather than about
    // performance - see MetricsCollector::record_http_version_downgrade.
    size_t http_version_downgraded = 0;
    // Absent when the run had no test script or no sampled responses - the
    // report then omits its testValidation section, as it always has.
    std::optional<ScriptValidationTotals> tests;
    // The verdict on the budgets this run's config declared. Absent when it
    // declared none, which keeps the report's thresholdValidation section out
    // rather than reporting a run that passed zero checks. Sibling of `tests`,
    // and the aggregate answer a per-response script structurally cannot give.
    std::optional<ThresholdOutcome> thresholds;
    // What a capacity run's adaptive search found. Absent for every other mode,
    // which keeps the report's `capacity` section out rather than showing a
    // fixed-target run a knee it never looked for.
    std::optional<CapacitySummary> capacity;
    SamplingRetention retention;
    // A scenario load run's sequence tallies and per-step breakdown, stored
    // under the summary's `scenario` key. Absent for a single-request load run,
    // which leaves the report's scenario section out entirely rather than
    // showing it zeros - the section exists to say what a sequence did.
    std::optional<nlohmann::json> scenario;
    // Which of the bound contract's operations the run exercised, under the
    // summary's `coverage` key (issue #629). Absent - and an empty object is
    // treated as absent - for a run that was not measured against a contract,
    // which is what keeps the report's coverage section out entirely rather
    // than reporting an unbound collection zero of zero operations covered.
    std::optional<nlohmann::json> coverage;
    // What the server-vitals scrape recorded, under the summary's `monitor`
    // key. Absent for a run that configured no monitor - the report then omits
    // the section entirely rather than showing a run that scraped nothing.
    std::optional<nlohmann::json> monitor;
    // When and whether this run's OAuth 2.0 credential was refreshed while it
    // ran, under the summary's `auth` key. Absent for every run that could not
    // refresh at all (no oauth2 auth, a non-expiring or query-placed token, the
    // user's opt-out) - which is what distinguishes "never needed to" from
    // "was never watching".
    std::optional<nlohmann::json> auth;

    // What a streaming run's completions delivered, under the summary's
    // `stream` key (issue #576). Absent for every run that streamed nothing, on
    // the same absent-not-zeros rule as `phases` above: a load run against an
    // ordinary endpoint has no event rate, and a zeroed one would read as a
    // stream that delivered nothing.
    std::optional<MetricsCollector::StreamTotals> stream;
};

/**
 * @brief Serialize whole-run results into the object stored in `runs.summary`.
 *
 * The report route reads exactly these keys (`http/routes/runs.cpp`), so the two
 * sides are locked together by runs_route_test.cpp's summary round-trip rather
 * than by convention.
 */
[[nodiscard]] nlohmann::json build_run_summary_payload (const RunSummaryInputs& inputs);

/**
 * @brief Wrap a per-tick stats object as a wire-ready SSE "metrics" event,
 * tagged with `id: <offset>` for Last-Event-ID resume. Extracted for testing.
 */
[[nodiscard]] std::string build_tick_payload (const nlohmann::json& stats, size_t offset);

class RunManager {
    private:
    mutable std::mutex mutex_;
    std::map<std::string, std::shared_ptr<RunContext>> active_runs_;
    std::map<std::string, std::shared_ptr<RunContext>> retained_runs_;

    // Background TTL sweeper. Without this, retained runs only get evicted when
    // /metrics/live or start_run fires - headless API users (POST /run +
    // GET /run/:id/report) never trigger either, and retained RunContexts
    // (full tick_buffer, HdrHistogram, counters) accumulate indefinitely.
    std::thread sweeper_thread_;
    std::mutex sweeper_mtx_;
    std::condition_variable sweeper_cv_;
    bool sweeper_stop_{ false };
    // Re-read each tick (not captured once) so a runtime change to
    // liveRetentionMs from the UI takes effect without a daemon restart.
    std::function<int64_t ()> sweeper_ttl_provider_;

    // Joinable handles for the worker threads spawned by start_run, keyed by
    // run id. A worker cannot join itself, so its handle outlives the thread
    // until either a later start_run reaps it or shutdown joins it. Guarded by
    // its own mutex: a worker takes `mutex_` (retain_run) as its last act, so
    // reaping must never hold `mutex_` while it joins.
    mutable std::mutex workers_mtx_;
    std::map<std::string, std::thread> run_workers_;
    bool shutting_down_{ false }; // workers_mtx_

    // Move out the handles of workers whose runs are no longer active, for the
    // caller to join once it has dropped every lock. Requires `workers_mtx_`;
    // takes `mutex_` itself.
    std::vector<std::thread> take_finished_workers ();

    /**
     * @brief Register a run's context and spawn its worker under
     * `workers_mtx_` - the shutdown-race discipline both run kinds need.
     *
     * `workers_mtx_` is held from the `shutting_down_` check through the moment
     * the worker's handle is recorded, because anything narrower loses the run:
     * shutdown() could set the flag, snapshot `run_workers_` and join it
     * between the check and the insert, leaving a worker running over state the
     * drain has already declared safe to destroy. Both `start_run` and
     * `start_scenario_run` come through here rather than each keeping a copy of
     * that reasoning.
     *
     * @param spawn Builds the worker thread from the registered context. Called
     *              with the lock held, and may spawn helper threads onto the
     *              context first (the load path's metrics thread).
     */
    bool spawn_run (const std::string& run_id,
    const nlohmann::json& config,
    vayu::db::Database& db,
    const std::function<std::thread (const std::shared_ptr<RunContext>&)>& spawn);

    public:
    ~RunManager ();

    void register_run (const std::string& run_id, std::shared_ptr<RunContext> context);
    std::shared_ptr<RunContext> get_run (const std::string& run_id);
    void unregister_run (const std::string& run_id);
    size_t active_count () const;
    std::vector<std::shared_ptr<RunContext>> get_all_active_runs () const;

    // ---- Live topic retention (N1) ---------------------------------------
    // On completion a run is MOVED from active_runs_ to retained_runs_ so its
    // in-memory tick topic survives for late/instant consumers. active_count()
    // and get_all_active_runs() keep their exact meaning (active only).
    void retain_run (const std::string& run_id);
    // Active OR retained-within-window. Used only by /metrics/live.
    std::shared_ptr<RunContext> get_run_or_retained (const std::string& run_id);
    // Evict retained runs whose completed_at_ms is older than ttl_ms.
    void sweep_retained (int64_t ttl_ms);
    // Number of retained (completed but not yet swept) runs. Test-only hook.
    size_t retained_count () const;

    // Start a background thread that periodically calls sweep_retained. The
    // provider is invoked each tick to obtain the current TTL (ms), so a config
    // change to liveRetentionMs is honored live; sweep cadence is TTL/2
    // (floored at 500ms). Idempotent - second calls are no-ops. Stopped in the
    // destructor (or via stop_sweeper) so daemon shutdown is clean.
    void start_sweeper (std::function<int64_t ()> ttl_provider);
    // Convenience overload for a fixed TTL (used by tests).
    void start_sweeper (int64_t ttl_ms);
    void stop_sweeper ();

    // Helper to start a run. Returns false - having registered nothing and
    // spawned nothing - if shutdown() has already begun, so a request that
    // races the drain is refused rather than starting a worker nobody will
    // join. Any other failure still surfaces as an exception from the worker.
    /**
     * @brief Start a load run.
     *
     * @param scenario A resolved plan for a *load-mode* scenario run, or null
     *                 for a single-request load run. Both take this path: the
     *                 event loop, metrics thread, drain, flush and summary are
     *                 the same, and only the executor differs. The design-mode
     *                 sequential runner is `start_scenario_run` instead.
     */
    bool start_run (const std::string& run_id,
    const nlohmann::json& config,
    vayu::db::Database& db,
    bool verbose,
    std::shared_ptr<const ScenarioExecution> scenario = nullptr);

    /**
     * @brief Start a scenario run: the same lifecycle, a different executor.
     *
     * Refuses (having registered and spawned nothing) once shutdown has begun,
     * exactly as `start_run` does. No metrics thread and no event loop are
     * spawned - a scenario run's work is sequential and its live stream carries
     * `step` events rather than the load path's per-tick aggregates, so a
     * metrics thread would publish ticks of zeros nobody asked for.
     *
     * @param execution The plan resolved before the run row existed, shared
     *                  immutably with the worker.
     * @param cookie_jar The daemon's jar; steps send through the run's
     *                   environment scope, which is what carries a session from
     *                   one step to the next.
     */
    bool start_scenario_run (const std::string& run_id,
    const nlohmann::json& config,
    std::shared_ptr<const ScenarioExecution> execution,
    vayu::db::Database& db,
    vayu::http::CookieJar& cookie_jar,
    bool verbose);

    /**
     * @brief Stop every active run and join its worker thread.
     *
     * The daemon's `Database`, `RunManager` and curl global state are torn down
     * in `main`'s scope exit while a run worker may still be writing metrics
     * through references to all three. This is the ordered drain that has to
     * happen first: signal `should_stop` on every active run, wait for them to
     * settle, then join.
     *
     * `grace` bounds the *wait*, not the join. A worker that has not settled by
     * then is logged and still joined, because letting go of it is precisely
     * the use-after-free being prevented - the bound exists to make a slow
     * shutdown visible, not to permit an unsafe one.
     *
     * Idempotent, and safe to call with no runs active. After it returns,
     * start_run refuses; the destructor calls it as a backstop.
     */
    void shutdown (std::chrono::milliseconds grace = std::chrono::milliseconds (
                   constants::server::RUN_SHUTDOWN_GRACE_MS));

    // Worker thread handles still held (running, or finished but not yet
    // reaped). Test-only hook - a drain that returns with this non-zero has
    // left threads running over freed state.
    [[nodiscard]] size_t tracked_worker_count () const;
};

// Worker functions
void execute_load_test (std::shared_ptr<RunContext> context,
vayu::db::Database* db_ptr,
bool verbose,
RunManager& manager);
void collect_metrics (std::shared_ptr<RunContext> context, vayu::db::Database* db_ptr);

/**
 * @brief Scrape @p config's metrics endpoint for the life of the run.
 *
 * Runs on `RunContext::monitor_thread`. Each pass GETs the URL on the budget
 * `resolve_scrape_timeout_ms` settles (three quarters of the interval, or
 * `monitorScrapeTimeoutMs` where the user set one), stores what it read as a
 * `monitor_samples` row and publishes it as a live `monitor` SSE frame, then
 * sleeps out the rest of the interval in short slices so a finishing run is
 * never held up by a long one.
 *
 * A failed scrape is a **gap**: it is counted, it never throws outward, and it
 * never fails the run. After `FAILURES_BEFORE_BACKOFF` consecutive failures it
 * logs once and keeps trying on a doubled interval, so an endpoint that went
 * away for the whole run costs one log line rather than one per scrape.
 *
 * Declared here so a test can drive the loop against a mock endpoint without an
 * HTTP server in front of it; the production caller is `RunManager::start_run`.
 */
void collect_monitor (std::shared_ptr<RunContext> context,
vayu::db::Database* db_ptr,
MonitorConfig config);

/**
 * @brief Keep a run's OAuth 2.0 credential valid for as long as the run lasts.
 *
 * Sleeps until `tuning.lead_ms` before the published token expires, re-acquires
 * (forced, so the cache cannot hand back the one that is about to die),
 * publishes the new header on `context->auth_refresh` and re-arms from the new
 * expiry. A failed refresh is recorded and retried with a backoff; it never
 * fails the run, because the honest report of a 401 storm is the target's own
 * status codes plus the `auth` section saying the refresh did not happen.
 *
 * @p tuning is the run's snapshot of the user's `oauth2Refresh*` settings, read
 * once when the watchdog arms (`read_auth_refresh_tuning`).
 *
 * Returns as soon as the run stops, or once the published token no longer
 * expires. Inert (returns immediately) when the run has no `auth_refresh`.
 */
void run_auth_refresh (std::shared_ptr<RunContext> context,
vayu::db::Database* db_ptr,
const AuthRefreshTuning& tuning);

} // namespace vayu::core
