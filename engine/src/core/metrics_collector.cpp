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
    // Pre-allocate vectors to avoid reallocation during test
    size_t expected = config_.expected_requests;

    // Reserve latencies vector
    size_t latency_reserve =
    config_.max_latencies > 0 ? std::min (expected, config_.max_latencies) : expected;
    latencies_.reserve (latency_reserve);

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

void MetricsCollector::atomic_add_double (std::atomic<double>& target, double value) {
    double current = target.load (std::memory_order_relaxed);
    while (!target.compare_exchange_weak (current, current + value,
    std::memory_order_relaxed, std::memory_order_relaxed)) {
        // Loop until successful
    }
}

void MetricsCollector::record_success (int status_code,
double latency_ms,
const std::string& trace_data) {
    // Update atomic counters (lock-free)
    total_requests_.fetch_add (1, std::memory_order_relaxed);
    atomic_add_double (total_latency_sum_, latency_ms);

    // Update status code category counters (lock-free)
    if (status_code >= 200 && status_code < 300) {
        status_2xx_.fetch_add (1, std::memory_order_relaxed);
    } else if (status_code >= 300 && status_code < 400) {
        status_3xx_.fetch_add (1, std::memory_order_relaxed);
    } else if (status_code >= 400 && status_code < 500) {
        status_4xx_.fetch_add (1, std::memory_order_relaxed);
    } else if (status_code >= 500 && status_code < 600) {
        status_5xx_.fetch_add (1, std::memory_order_relaxed);
    }

    // Record latency (with mutex, but vector append is fast)
    {
        std::lock_guard<std::mutex> lock (latencies_mutex_);
        if (config_.max_latencies == 0 || latencies_.size () < config_.max_latencies) {
            latencies_.push_back (latency_ms);
        }
    }

    // Track detailed status codes
    {
        std::lock_guard<std::mutex> lock (status_codes_mutex_);
        status_code_counts_[status_code]++;
    }

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

void MetricsCollector::record_latency (double latency_ms) {
    atomic_add_double (total_latency_sum_, latency_ms);

    std::lock_guard<std::mutex> lock (latencies_mutex_);
    if (config_.max_latencies == 0 || latencies_.size () < config_.max_latencies) {
        latencies_.push_back (latency_ms);
    }
}

MetricsCollector::Percentiles MetricsCollector::calculate_percentiles () {
    Percentiles result;

    std::vector<double> sorted;
    {
        std::lock_guard<std::mutex> lock (latencies_mutex_);
        sorted = latencies_; // Copy for sorting
    }

    if (sorted.empty ()) {
        return result;
    }

    std::sort (sorted.begin (), sorted.end ());

    auto percentile = [&sorted] (double p) -> double {
        if (sorted.empty ())
            return 0.0;
        size_t idx =
        static_cast<size_t> (static_cast<double> (sorted.size ()) * p / 100.0);
        if (idx >= sorted.size ())
            idx = sorted.size () - 1;
        return sorted[idx];
    };

    result.min  = sorted.front ();
    result.max  = sorted.back ();
    result.p50  = percentile (50);
    result.p75  = percentile (75);
    result.p90  = percentile (90);
    result.p95  = percentile (95);
    result.p99  = percentile (99);
    result.p999 = percentile (99.9);

    return result;
}

std::map<int, size_t> MetricsCollector::status_code_distribution () const {
    std::lock_guard<std::mutex> lock (status_codes_mutex_);
    return status_code_counts_;
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

size_t MetricsCollector::memory_usage_bytes () const {
    size_t bytes = sizeof (MetricsCollector);

    // Latencies vector
    {
        std::lock_guard<std::mutex> lock (latencies_mutex_);
        bytes += latencies_.capacity () * sizeof (double);
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
double elapsed_seconds) const {
    // Lock-free reads from atomic counters
    size_t total    = total_requests ();
    size_t errors   = total_errors ();
    size_t success  = total > errors ? total - errors : 0;
    double avg_lat  = average_latency ();
    double err_rate = error_rate ();

    // Calculate current RPS
    double current_rps =
    elapsed_seconds > 0 ? static_cast<double> (total) / elapsed_seconds : 0.0;

    nlohmann::json stats;
    stats["totalRequests"]     = total;
    stats["totalErrors"]       = errors;
    stats["totalSuccess"]      = success;
    stats["errorRate"]         = err_rate;
    stats["avgLatencyMs"]      = avg_lat;
    stats["currentRps"]        = current_rps;
    stats["activeConnections"] = current_active;
    stats["elapsedSeconds"]    = elapsed_seconds;

    // Status code distribution (lock-free)
    stats["status2xx"] = status_2xx_.load (std::memory_order_relaxed);
    stats["status3xx"] = status_3xx_.load (std::memory_order_relaxed);
    stats["status4xx"] = status_4xx_.load (std::memory_order_relaxed);
    stats["status5xx"] = status_5xx_.load (std::memory_order_relaxed);

    return stats;
}

} // namespace vayu::core
