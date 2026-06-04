#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <atomic>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>
#include <vector>

#include "vayu/core/metrics_collector.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/event_loop.hpp"

namespace vayu::core {

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
    // Append-only buffer of wire-ready SSE payload strings (each is a full
    // "event: metrics\nid: <n>\ndata: {...}\n\n"). Produced by the metrics
    // thread, replayed+tailed by /metrics/live. MUST be mutex-guarded — a
    // vector realloc would move/free the backing array under a concurrent
    // reader (UAF) even for already-published indices, so the atomic offset
    // alone is not enough. Readers copy out under the lock.
    mutable std::mutex tick_mtx;
    std::vector<std::string> tick_buffer;
    std::atomic<size_t> published_count{ 0 }; // == tick_buffer.size() (hint)
    std::atomic<bool> closed{ false };         // set true AFTER final tick appended
    std::atomic<int64_t> completed_at_ms{ 0 }; // 0 while running; stamped at completion

    void append_tick (std::string payload) {
        std::lock_guard<std::mutex> lock (tick_mtx);
        tick_buffer.push_back (std::move (payload));
        published_count.store (tick_buffer.size (), std::memory_order_release);
    }
    [[nodiscard]] std::vector<std::string> ticks_since (size_t from) const {
        std::lock_guard<std::mutex> lock (tick_mtx);
        if (from >= tick_buffer.size ()) return {};
        return { tick_buffer.begin () + static_cast<std::ptrdiff_t> (from),
        tick_buffer.end () };
    }
    [[nodiscard]] size_t tick_count () const {
        std::lock_guard<std::mutex> lock (tick_mtx);
        return tick_buffer.size ();
    }

    // notify_refill deliberately does NOT lock refill_mtx — locking on every
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
    [[nodiscard]] double total_latency_ms () const {
        return metrics_collector ? metrics_collector->total_latency_sum () : 0.0;
    }

    RunContext (const std::string& id, nlohmann::json cfg);
    ~RunContext ();
};

/**
 * @brief Build the per-tick enrichment metric rows (dropped / bytes / status
 * codes) from the collector's current cumulative state. Extracted from
 * collect_metrics so it can be unit-tested deterministically.
 */
[[nodiscard]] std::vector<vayu::db::Metric> build_tick_enrichment_metrics (
const std::shared_ptr<RunContext>& context, int64_t timestamp);

class RunManager {
    private:
    mutable std::mutex mutex_;
    std::map<std::string, std::shared_ptr<RunContext>> active_runs_;
    std::map<std::string, std::shared_ptr<RunContext>> retained_runs_;

    public:
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
