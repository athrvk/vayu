#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/core/metrics_collector.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/event_loop.hpp"

namespace vayu::core {

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

struct RunContext {
    std::string run_id;
    std::unique_ptr<vayu::http::EventLoop> event_loop;
    std::thread worker_thread;
    std::thread metrics_thread;
    std::atomic<bool> should_stop{ false };
    std::atomic<bool> is_running{ false };
    nlohmann::json config;
    int64_t start_time_ms;

    // Test script for deferred validation
    std::string test_script;

    // High-performance in-memory metrics collector
    // Replaces direct DB writes for individual results during load tests
    std::unique_ptr<MetricsCollector> metrics_collector;

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
    [[nodiscard]] TickBatch ticks_since (size_t from) const {
        std::lock_guard<std::mutex> lock (tick_mtx);
        size_t end = tick_base_offset + tick_buffer.size ();
        if (from >= end) return { {}, from };
        size_t start = from < tick_base_offset ? tick_base_offset : from;
        auto begin_it =
        tick_buffer.begin () + static_cast<std::ptrdiff_t> (start - tick_base_offset);
        return { { begin_it, tick_buffer.end () }, end };
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
    size_t max_errors = constants::metrics_collector::DEFAULT_MAX_ERRORS);
    ~RunContext ();
};

/**
 * @brief Build the per-tick enrichment metric rows (dropped / bytes / status
 * codes) from the collector's current cumulative state. Extracted from
 * collect_metrics so it can be unit-tested deterministically.
 */
[[nodiscard]] std::vector<vayu::db::Metric> build_tick_enrichment_metrics (
const std::shared_ptr<RunContext>& context,
int64_t timestamp,
const std::map<int, size_t>* status_snapshot = nullptr);

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

    // Helper to start a run
    void start_run (const std::string& run_id,
    const nlohmann::json& config,
    vayu::db::Database& db,
    bool verbose);
};

// Worker functions
void execute_load_test (std::shared_ptr<RunContext> context,
vayu::db::Database* db_ptr,
bool verbose,
RunManager& manager);
void collect_metrics (std::shared_ptr<RunContext> context, vayu::db::Database* db_ptr);

} // namespace vayu::core
