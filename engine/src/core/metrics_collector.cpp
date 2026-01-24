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

    // Record latency in histogram (lock-free, thread-safe)
    // Convert milliseconds to microseconds for histogram precision
    int64_t latency_us = static_cast<int64_t> (latency_ms * 1000.0);
    if (latency_us < 1) latency_us = 1;  // Minimum 1 microsecond
    hdr_record_value (latency_histogram_, latency_us);

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
size_t requests_sent) const {
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

    // Status code distribution (lock-free)
    stats["status2xx"] = status_2xx_.load (std::memory_order_relaxed);
    stats["status3xx"] = status_3xx_.load (std::memory_order_relaxed);
    stats["status4xx"] = status_4xx_.load (std::memory_order_relaxed);
    stats["status5xx"] = status_5xx_.load (std::memory_order_relaxed);

    return stats;
}

} // namespace vayu::core
