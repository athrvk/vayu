/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/metrics_collector.cpp
 * @brief Implementation of high-performance in-memory metrics collector
 */

#include "vayu/core/metrics_collector.hpp"
#include "vayu/http/status.hpp"

#include <algorithm>
#include <chrono>

namespace vayu::core {

namespace {
inline int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}
} // namespace

MetricsCollector::MetricsCollector (const std::string& run_id, MetricsCollectorConfig config)
: run_id_ (run_id), config_ (config) {
    // Initialize HdrHistogram for lock-free latency recording
    // 3 significant figures = ~0.1% precision, max 1 hour in microseconds
    int result = hdr_init (
        1,  // Minimum value (1 microsecond)
        constants::metrics_collector::HISTOGRAM_MAX_LATENCY_US,  // Maximum value (1 hour in microseconds)
        constants::metrics_collector::HISTOGRAM_SIGNIFICANT_FIGURES,  // Significant figures
        &latency_histogram_
    );
    if (result != 0 || latency_histogram_ == nullptr) {
        throw std::runtime_error ("Failed to initialize HdrHistogram");
    }

    // Pre-allocate vectors to avoid reallocation during test
    size_t expected = config_.expected_requests;

    // Reserve errors vector (assume ~5% error rate max)
    size_t error_reserve = config_.max_errors > 0 ?
    config_.max_errors :
    std::max (expected / 20U, size_t (10000));
    errors_.reserve (error_reserve);

    // Reserve success results if storing traces
    if (config_.store_success_traces) {
        size_t success_reserve = config_.max_success_results > 0 ?
        config_.max_success_results :
        expected / config_.success_sample_rate;
        success_results_.reserve (success_reserve);
    }

    // Reserve response samples for script validation
    response_samples_.reserve (config_.max_response_samples);
}

MetricsCollector::~MetricsCollector () {
    if (latency_histogram_ != nullptr) {
        hdr_close (latency_histogram_);
        latency_histogram_ = nullptr;
    }
}

void MetricsCollector::atomic_add_double (std::atomic<double>& target, double value) {
    double current = target.load (std::memory_order_relaxed);
    while (!target.compare_exchange_weak (current, current + value,
    std::memory_order_relaxed, std::memory_order_relaxed)) {
        // Loop until successful
    }
}

void MetricsCollector::record_success (int status_code,
double latency_ms,
double queue_wait_ms,
const std::string& trace_data) {
    // Update atomic counters (lock-free)
    total_requests_.fetch_add (1, std::memory_order_relaxed);
    atomic_add_double (total_latency_sum_, latency_ms);
    atomic_add_double (total_queue_wait_sum_, queue_wait_ms);

    // Track the per-code count (lock-free for in-range codes).
    record_status_code (status_code);

    // Record latency in histogram (lock-free, thread-safe)
    // Convert milliseconds to microseconds for histogram precision
    int64_t latency_us = static_cast<int64_t> (latency_ms * 1000.0);
    if (latency_us < 1) latency_us = 1;  // Minimum 1 microsecond
    hdr_record_value (latency_histogram_, latency_us);

    // Store success result if configured (sampled)
    if (config_.store_success_traces && !trace_data.empty ()) {
        size_t counter = success_sample_counter_.fetch_add (1, std::memory_order_relaxed);
        if (counter % config_.success_sample_rate == 0) {
            std::lock_guard<std::mutex> lock (success_mutex_);
            if (config_.max_success_results == 0 ||
            success_results_.size () < config_.max_success_results) {
                ResultRecord record (now_ms (), status_code, latency_ms);
                record.trace_data = trace_data;
                success_results_.push_back (std::move (record));
            }
        }
    }
}

void MetricsCollector::record_response_sample (const Response& response) {
    // Only sample based on configured rate
    size_t counter = response_sample_counter_.fetch_add (1, std::memory_order_relaxed);
    if (counter % config_.response_sample_rate != 0) {
        return;
    }

    std::lock_guard<std::mutex> lock (response_samples_mutex_);
    if (response_samples_.size () < config_.max_response_samples) {
        response_samples_.emplace_back (response, now_ms ());
    }
}

void MetricsCollector::record_error (ErrorCode code,
const std::string& message,
const std::string& trace_data) {
    // Update atomic counters (lock-free)
    total_requests_.fetch_add (1, std::memory_order_relaxed);
    total_errors_.fetch_add (1, std::memory_order_relaxed);

    // Transport errors (timeout, connection, DNS, …) carry no HTTP status, so
    // bucket them under code 0. This keeps the status-code distribution summing
    // to total_requests — the dashboard breakdown reconciles with the headline
    // count, and the report's failed/errorRate tallies (recomputed from the
    // distribution) account for them instead of silently dropping to zero.
    record_status_code (0);

    // Store error record (always store all errors)
    {
        std::lock_guard<std::mutex> lock (errors_mutex_);
        if (config_.max_errors == 0 || errors_.size () < config_.max_errors) {
            ResultRecord record (now_ms (), code, message);
            record.trace_data = trace_data;
            errors_.push_back (std::move (record));
        }
    }
}

void MetricsCollector::record_drop_batch (size_t count) {
    dropped_requests_.fetch_add (count, std::memory_order_relaxed);
}

void MetricsCollector::record_latency (double latency_ms) {
    atomic_add_double (total_latency_sum_, latency_ms);

    // Record latency in histogram (lock-free, thread-safe)
    // Convert milliseconds to microseconds for histogram precision
    int64_t latency_us = static_cast<int64_t> (latency_ms * 1000.0);
    if (latency_us < 1) latency_us = 1;  // Minimum 1 microsecond
    hdr_record_value (latency_histogram_, latency_us);
}

MetricsCollector::Percentiles MetricsCollector::calculate_percentiles () {
    Percentiles result;

    if (latency_histogram_ == nullptr || latency_histogram_->total_count == 0) {
        return result;
    }

    // Convert from microseconds back to milliseconds
    auto us_to_ms = [] (int64_t us) -> double {
        return static_cast<double> (us) / 1000.0;
    };

    result.min  = us_to_ms (hdr_min (latency_histogram_));
    result.max  = us_to_ms (hdr_max (latency_histogram_));
    result.p50  = us_to_ms (hdr_value_at_percentile (latency_histogram_, 50.0));
    result.p75  = us_to_ms (hdr_value_at_percentile (latency_histogram_, 75.0));
    result.p90  = us_to_ms (hdr_value_at_percentile (latency_histogram_, 90.0));
    result.p95  = us_to_ms (hdr_value_at_percentile (latency_histogram_, 95.0));
    result.p99  = us_to_ms (hdr_value_at_percentile (latency_histogram_, 99.0));
    result.p999 = us_to_ms (hdr_value_at_percentile (latency_histogram_, 99.9));

    return result;
}

void MetricsCollector::record_status_code (int status_code) {
    if (status_code >= 0 && status_code < STATUS_CODE_SLOTS) {
        // Hot path: single relaxed atomic increment, no lock.
        status_code_counts_[status_code].fetch_add (1, std::memory_order_relaxed);
        return;
    }
    // Out-of-range (non-standard) code: dead path for real HTTP traffic.
    std::lock_guard<std::mutex> lock (status_overflow_mutex_);
    status_overflow_[status_code]++;
}

std::map<int, size_t> MetricsCollector::status_code_distribution () const {
    std::map<int, size_t> result;
    for (int code = 0; code < STATUS_CODE_SLOTS; ++code) {
        size_t count = status_code_counts_[code].load (std::memory_order_relaxed);
        if (count > 0) {
            result[code] = count;
        }
    }
    {
        std::lock_guard<std::mutex> lock (status_overflow_mutex_);
        for (const auto& [code, count] : status_overflow_) {
            result[code] += count;
        }
    }
    return result;
}

size_t MetricsCollector::flush_to_database (db::Database& db) {
    std::vector<db::Result> batch;

    // Collect all error records
    {
        std::lock_guard<std::mutex> lock (errors_mutex_);
        batch.reserve (errors_.size () + success_results_.size ());

        for (const auto& error : errors_) {
            db::Result db_result;
            db_result.run_id      = run_id_;
            db_result.timestamp   = error.timestamp;
            db_result.status_code = 0;
            db_result.status_text = vayu::http::status_text (0);
            db_result.latency_ms  = 0.0;
            db_result.error       = error.error_message;
            db_result.trace_data  = error.trace_data;
            batch.push_back (std::move (db_result));
        }
    }

    // Collect sampled success records
    {
        std::lock_guard<std::mutex> lock (success_mutex_);
        for (const auto& success : success_results_) {
            db::Result db_result;
            db_result.run_id      = run_id_;
            db_result.timestamp   = success.timestamp;
            db_result.status_code = success.status_code;
            // ResultRecord doesn't carry the wire reason phrase; derive
            // from code via the shared helper. The single-request design
            // path (execution.cpp) preserves the wire phrase directly.
            db_result.status_text = vayu::http::status_text (success.status_code);
            db_result.latency_ms  = success.latency_ms;
            db_result.trace_data  = success.trace_data;
            batch.push_back (std::move (db_result));
        }
    }

    // Batch insert with transaction (prevents WAL growth and OOM)
    if (!batch.empty ()) {
        db.add_results_batch (batch);
    }

    return batch.size ();
}

int64_t MetricsCollector::latency_count () const {
    if (latency_histogram_ == nullptr) {
        return 0;
    }
    return latency_histogram_->total_count;
}

size_t MetricsCollector::memory_usage_bytes () const {
    size_t bytes = sizeof (MetricsCollector);

    // HdrHistogram memory (fixed size ~20-40KB)
    if (latency_histogram_ != nullptr) {
        bytes += hdr_get_memory_size (latency_histogram_);
    }

    // Errors vector
    {
        std::lock_guard<std::mutex> lock (errors_mutex_);
        bytes += errors_.capacity () * sizeof (ResultRecord);
        for (const auto& e : errors_) {
            bytes += e.error_message.capacity () + e.trace_data.capacity ();
        }
    }

    // Success results vector
    {
        std::lock_guard<std::mutex> lock (success_mutex_);
        bytes += success_results_.capacity () * sizeof (ResultRecord);
        for (const auto& s : success_results_) {
            bytes += s.trace_data.capacity ();
        }
    }

    return bytes;
}

nlohmann::json MetricsCollector::get_current_stats (size_t current_active,
double elapsed_seconds,
size_t requests_sent,
size_t requests_expected,
const std::map<int, size_t>* status_snapshot) const {
    // Lock-free reads from atomic counters
    size_t total    = total_requests ();
    size_t errors   = total_errors ();
    size_t success  = total > errors ? total - errors : 0;
    double avg_lat  = average_latency ();
    double err_rate = error_rate ();

    // Calculate rate metrics (Open Model)
    // Send Rate: How fast Vayu is dispatching requests to the server
    double send_rate =
    elapsed_seconds > 0 ? static_cast<double> (requests_sent) / elapsed_seconds : 0.0;

    // Throughput: How fast the server is responding (completed requests)
    double throughput =
    elapsed_seconds > 0 ? static_cast<double> (total) / elapsed_seconds : 0.0;

    nlohmann::json stats;
    stats["totalRequests"]     = total;
    stats["totalErrors"]       = errors;
    stats["totalSuccess"]      = success;
    stats["errorRate"]         = err_rate;
    stats["avgLatencyMs"]      = avg_lat;
    stats["sendRate"]          = send_rate;
    stats["throughput"]        = throughput;
    stats["activeConnections"] = current_active;
    stats["elapsedSeconds"]    = elapsed_seconds;

    // Run progress — feeds the dashboard ETA stat for closed-ended modes
    // (iterations). requests_expected is 0 for open-ended modes (constant_rps).
    stats["requestsSent"]     = requests_sent;
    stats["requestsExpected"] = requests_expected;

    // Snapshot the status-code distribution once: reuse the caller's snapshot
    // when provided (the metrics tick takes one snapshot and feeds it to both
    // the SSE builder and the persisted-rows builder), otherwise compute it.
    // Both the class breakdown and the full map below derive from this single
    // copy — no second scan.
    std::map<int, size_t> local_dist;
    const std::map<int, size_t>& dist = status_snapshot != nullptr ?
    *status_snapshot :
    (local_dist = status_code_distribution ());

    // Status code class breakdown. The dedicated class atomics were removed to
    // keep the hot path a single increment; classes are derived here. Code 0
    // (transport errors) and out-of-range codes belong to no class bucket.
    size_t s2xx = 0, s3xx = 0, s4xx = 0, s5xx = 0;
    for (const auto& [code, count] : dist) {
        if (code >= 200 && code < 300)
            s2xx += count;
        else if (code >= 300 && code < 400)
            s3xx += count;
        else if (code >= 400 && code < 500)
            s4xx += count;
        else if (code >= 500 && code < 600)
            s5xx += count;
    }
    stats["status2xx"]       = s2xx;
    stats["status3xx"]       = s3xx;
    stats["status4xx"]       = s4xx;
    stats["status5xx"]       = s5xx;
    stats["droppedRequests"] = dropped_requests_.load (std::memory_order_relaxed);
    stats["avgQueueWaitMs"] = average_queue_wait ();

    // Per-tick latency percentiles — live snapshot from the lock-free
    // histogram (same source as the post-run final report). Microsecond
    // storage converted back to ms. Zero when no samples recorded yet.
    if (latency_histogram_ != nullptr && latency_histogram_->total_count > 0) {
        stats["latencyP50Ms"] =
        static_cast<double> (hdr_value_at_percentile (latency_histogram_, 50.0)) / 1000.0;
        stats["latencyP95Ms"] =
        static_cast<double> (hdr_value_at_percentile (latency_histogram_, 95.0)) / 1000.0;
        stats["latencyP99Ms"] =
        static_cast<double> (hdr_value_at_percentile (latency_histogram_, 99.0)) / 1000.0;
    } else {
        stats["latencyP50Ms"] = 0.0;
        stats["latencyP95Ms"] = 0.0;
        stats["latencyP99Ms"] = 0.0;
    }

    // Wire byte counts (cumulative) — client diffs consecutive ticks for MB/s.
    stats["bytesSent"]     = total_bytes_sent ();
    stats["bytesReceived"] = total_bytes_received ();

    // Full status-code map (same shape the stored time-series carries), so the
    // app maps one shape for both live and history. Derived from the same
    // single snapshot as the class breakdown above.
    nlohmann::json codes = nlohmann::json::object ();
    for (const auto& [code, count] : dist) {
        codes[std::to_string (code)] = count;
    }
    stats["statusCodes"] = codes;

    return stats;
}

} // namespace vayu::core
