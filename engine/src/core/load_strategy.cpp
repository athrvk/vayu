/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/load_strategy.hpp"

#include <chrono>
#include <condition_variable>
#include <functional>
#include <iostream>
#include <limits>
#include <mutex>
#include <nlohmann/json.hpp>
#include <thread>

#include "vayu/core/refill_deficit.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {
/**
 * @brief Handle a completed HTTP request result
 *
 * This function records metrics to the in-memory MetricsCollector instead of
 * writing directly to the database. This enables high-throughput load testing
 * (60k+ RPS) by avoiding database contention during the test.
 *
 * Results are batch-written to the database after test completion.
 */
void handle_result (std::shared_ptr<RunContext> context,
vayu::db::Database& /* db - unused, kept for API compat */,
vayu::Result<vayu::Response> result) {
    // Get configuration
    int slow_threshold_ms = context->config.value ("slow_threshold_ms", 1000);
    bool save_timing_breakdown = context->config.value ("save_timing_breakdown", false);

    // client.send() now always returns Response (never Error), but Response may have error_code set
    if (result.is_error ()) {
        // This should not happen anymore, but handle it for safety
        vayu::utils::log_error (
        "Unexpected error result in load_strategy::handle_result");
        return;
    }

    const auto& response = result.value ();

    // Check if response has a client-side error
    if (response.has_error ()) {

        // Build detailed error trace data
        nlohmann::json error_json = { { "error_code", static_cast<int> (response.error_code) },
            { "error_type",
            [&response] () {
                switch (response.error_code) {
                case vayu::ErrorCode::Timeout: return "timeout";
                case vayu::ErrorCode::ConnectionFailed:
                    return "connection_failed";
                case vayu::ErrorCode::DnsError: return "dns_failed";
                case vayu::ErrorCode::SslError: return "ssl_error";
                case vayu::ErrorCode::InvalidUrl: return "invalid_url";
                case vayu::ErrorCode::InvalidMethod: return "invalid_method";
                case vayu::ErrorCode::ScriptError: return "script_error";
                case vayu::ErrorCode::InternalError: return "internal_error";
                default: return "unknown";
                }
            }() },
            { "message", response.error_message },
            { "request_number", context->total_requests () } };

        // Include timing info if available
        if (response.timing.total_ms > 0) {
            error_json["timing"] = { { "totalMs", response.timing.total_ms },
                { "wireMs", response.timing.wire_ms },
                { "queueWaitMs", response.timing.queue_wait_ms },
                { "dnsMs", response.timing.dns_ms },
                { "connectMs", response.timing.connect_ms },
                { "tlsMs", response.timing.tls_ms },
                { "firstByteMs", response.timing.first_byte_ms },
                { "downloadMs", response.timing.download_ms } };
        }

        context->metrics_collector->record_error (
        response.error_code, response.error_message, error_json.dump ());
        context->metrics_collector->record_bytes (
        response.timing.bytes_up, response.timing.bytes_down);
    } else {
        // Successful response
        double latency = response.timing.total_ms;

        // Build trace data if configured
        std::string trace_data;
        bool is_slow = latency >= static_cast<double> (slow_threshold_ms);

        if (save_timing_breakdown || is_slow) {
            nlohmann::json timing_json = { { "totalMs", response.timing.total_ms },
                { "wireMs", response.timing.wire_ms },
                { "queueWaitMs", response.timing.queue_wait_ms },
                { "dnsMs", response.timing.dns_ms },
                { "connectMs", response.timing.connect_ms },
                { "tlsMs", response.timing.tls_ms },
                { "firstByteMs", response.timing.first_byte_ms },
                { "downloadMs", response.timing.download_ms } };

            if (is_slow) {
                timing_json["isSlow"]      = true;
                timing_json["thresholdMs"] = slow_threshold_ms;
            }

            trace_data = timing_json.dump ();
        }

        // Record to in-memory collector (high-performance, no DB writes)
        context->metrics_collector->record_success (response.status_code,
        latency, response.timing.queue_wait_ms, trace_data);
        context->metrics_collector->record_bytes (
        response.timing.bytes_up, response.timing.bytes_down);

        // Sample response for deferred script validation if test script is present
        if (!context->test_script.empty ()) {
            context->metrics_collector->record_response_sample (response);
        }
    }

    // Wake the closed-loop controller (no-op/near-free for open-loop modes).
    if (context->closed_loop.load (std::memory_order_relaxed)) {
        context->notify_refill ();
    }
}

// Update the in-flight high-water mark (single writer: the strategy thread).
inline void update_peak (const std::shared_ptr<RunContext>& context) {
    size_t f    = context->in_flight ();
    size_t prev = context->peak_in_flight.load (std::memory_order_relaxed);
    while (f > prev &&
    !context->peak_in_flight.compare_exchange_weak (prev, f, std::memory_order_relaxed)) {
        // prev reloaded on failure
    }
}

/**
 * @brief Closed-loop concurrency controller. Seeds target(0), then refills the
 * in-flight deficit toward target(t) — woken per completion via refill_cv with
 * a 50ms safety-net timeout (drives ramp growth + bounds stop latency).
 *
 * @param submit_one   submits exactly one request and increments requests_sent
 * @param target_fn    desired in-flight at elapsed_ms
 * @param budget_fn    remaining submission budget (SIZE_MAX for time-bounded)
 * @param should_continue  whether to keep refilling at elapsed_ms
 */
void maintain_concurrency (std::shared_ptr<RunContext> context,
const std::function<void ()>& submit_one,
const std::function<size_t (int64_t)>& target_fn,
const std::function<size_t ()>& budget_fn,
const std::function<bool (int64_t)>& should_continue) {
    using clock = std::chrono::steady_clock;
    auto start  = clock::now ();
    auto elapsed_ms = [&start] () {
        return std::chrono::duration_cast<std::chrono::milliseconds> (clock::now () - start)
        .count ();
    };

    // closed_loop must be true BEFORE seeding so no early completion's notify
    // is dropped.
    context->closed_loop.store (true, std::memory_order_relaxed);

    size_t seed = compute_refill_deficit (target_fn (0), 0, budget_fn ());
    for (size_t i = 0; i < seed && !context->should_stop; ++i) {
        submit_one ();
    }
    update_peak (context);

    while (!context->should_stop) {
        {
            std::unique_lock<std::mutex> lk (context->refill_mtx);
            context->refill_cv.wait_for (lk, std::chrono::milliseconds (50), [&] () {
                return context->should_stop.load () ||
                context->in_flight () < target_fn (elapsed_ms ());
            });
        }

        int64_t el = elapsed_ms ();
        if (context->should_stop || !should_continue (el)) {
            break;
        }

        size_t deficit =
        compute_refill_deficit (target_fn (el), context->in_flight (), budget_fn ());
        for (size_t i = 0; i < deficit && !context->should_stop; ++i) {
            submit_one ();
        }
        update_peak (context);
    }
}
} // namespace

// ============================================================================
// Constant Load Strategy
// ============================================================================

class ConstantLoadStrategy : public LoadStrategy {
    public:
    void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) override {
        const auto& config       = context->config;
        std::string duration_str = config.value ("duration", "60s");
        int64_t duration_ms      = 0;
        try {
            duration_ms =
            std::stoll (duration_str.substr (0, duration_str.length () - 1)) * 1000;
        } catch (...) {
            duration_ms = 60000;
        }

        // Check for targetRps - if specified, use rate-limited mode
        double target_rps = config.value ("rps", 0.0);
        if (target_rps == 0.0)
            target_rps = config.value ("targetRps", 0.0);

        if (target_rps > 0.0) {
            // Rate-limited mode
            vayu::utils::log_info (
            "Starting Constant Load Test (Rate-Limited)");
            vayu::utils::log_info ("  Duration: " + std::to_string (duration_ms) + " ms");
            vayu::utils::log_info ("  Target RPS: " + std::to_string (target_rps));

            // Calculate expected requests
            size_t expected = static_cast<size_t> (
            (static_cast<double> (duration_ms) / 1000.0) * target_rps);
            context->requests_expected = expected;

            // Calculate correct interval between requests based on target RPS
            // For 10 RPS: interval = 1,000,000 / 10 = 100,000 us = 100ms
            // For 1000 RPS: interval = 1,000,000 / 1000 = 1,000 us = 1ms
            // For high RPS (>1000), we batch multiple requests per interval
            int64_t base_interval_us = static_cast<int64_t> (1000000.0 / target_rps);

            // Minimum interval of 1ms (1000us) to avoid busy-spinning
            // If target_rps > 1000, we need to submit multiple requests per interval
            size_t batch_size         = 1;
            int64_t batch_interval_us = base_interval_us;

            if (base_interval_us < 1000) {
                // High RPS mode: batch requests every 1ms
                batch_interval_us = 1000;
                batch_size =
                std::max (static_cast<size_t> (target_rps / 1000.0), size_t (1));
            }

            vayu::utils::log_debug (
            "Submission config: batch_size=" + std::to_string (batch_size) +
            ", batch_interval_us=" + std::to_string (batch_interval_us) +
            ", expected_requests=" + std::to_string (expected));

            auto test_start      = std::chrono::steady_clock::now ();
            auto next_batch_time = test_start;
            size_t submitted     = 0;

            auto duration_end = test_start + std::chrono::milliseconds (duration_ms);

            while (!context->should_stop) {
                auto now = std::chrono::steady_clock::now ();
                auto elapsed =
                std::chrono::duration_cast<std::chrono::milliseconds> (now - test_start)
                .count ();

                if (elapsed >= duration_ms) {
                    // Before breaking: submit all batches that were due within duration.
                    // Use strict < so we don't submit the first batch after the window
                    // (e.g. 5s @ 1000 RPS = batches at 0..4999ms only, not 5000ms).
                    size_t max_pending = config.value ("maxInFlight",
                    std::max (static_cast<size_t> (target_rps * 10.0), size_t (1000)));
                    while (next_batch_time < duration_end && now >= next_batch_time &&
                    context->in_flight () < max_pending && !context->should_stop) {
                        for (size_t i = 0; i < batch_size && !context->should_stop; ++i) {
                            context->event_loop->submit (request,
                            [context, &db] (size_t, vayu::Result<vayu::Response> result) {
                                handle_result (context, db, std::move (result));
                            });
                            submitted++;
                            context->requests_sent++;
                        }
                        next_batch_time += std::chrono::microseconds (batch_interval_us);
                    }
                    break;
                }

                // Check if it's time to submit (possibly multiple batches if we fell behind)
                size_t max_pending = config.value ("maxInFlight",
                std::max (static_cast<size_t> (target_rps * 10.0), size_t (1000)));

                if (now >= next_batch_time) {
                    // How many batches are we due? (catch up after preemption/slow iterations)
                    int64_t overdue_us =
                    std::chrono::duration_cast<std::chrono::microseconds> (now - next_batch_time)
                    .count ();
                    size_t batches_due = 1U;
                    if (overdue_us > 0 && batch_interval_us > 0) {
                        batches_due += static_cast<size_t> (overdue_us / batch_interval_us);
                    }
                    // Cap by batches left in the test window
                    if (next_batch_time < duration_end) {
                        int64_t remaining_us =
                        std::chrono::duration_cast<std::chrono::microseconds> (
                        duration_end - next_batch_time)
                        .count ();
                        size_t max_batches_in_window =
                        (remaining_us > 0 && batch_interval_us > 0) ?
                        static_cast<size_t> (remaining_us / batch_interval_us) :
                        0U;
                        if (max_batches_in_window < batches_due)
                            batches_due = max_batches_in_window;
                    } else {
                        batches_due = 0U;
                    }

                    size_t batches_submitted = 0U;
                    while (batches_submitted < batches_due && !context->should_stop) {
                        if (context->in_flight () >= max_pending) {
                            size_t abandoned_batches = batches_due - batches_submitted;
                            context->metrics_collector->record_drop_batch (
                            abandoned_batches * batch_size);
                            next_batch_time =
                            now + std::chrono::microseconds (batch_interval_us);
                            break;
                        }
                        for (size_t i = 0; i < batch_size && !context->should_stop; ++i) {
                            context->event_loop->submit (request,
                            [context, &db] (size_t, vayu::Result<vayu::Response> result) {
                                handle_result (context, db, std::move (result));
                            });
                            submitted++;
                            context->requests_sent++;
                        }
                        batches_submitted++;
                        next_batch_time += std::chrono::microseconds (batch_interval_us);
                    }
                }

                // Wait until next batch: on Windows use busy-wait for short
                // intervals so we don't depend on timer resolution (10k+ RPS).
                auto sleep_time =
                std::chrono::duration_cast<std::chrono::microseconds> (next_batch_time - now)
                .count ();
                if (sleep_time > 100) {
#ifdef _WIN32
                    // Busy-wait for <= 2ms to avoid 15.6ms timer rounding
                    if (sleep_time <= 2000) {
                        while (std::chrono::steady_clock::now () < next_batch_time &&
                        !context->should_stop) {
                            /* spin */
                        }
                    } else
#endif
                    {
                        std::this_thread::sleep_for (
                        std::chrono::microseconds (sleep_time / 2));
                    }
                }
            }

            vayu::utils::log_info ("Submitted " + std::to_string (submitted) + " requests");

        } else {
            // Concurrency-based mode: closed-loop, hold ~N in flight.
            size_t concurrency =
            static_cast<size_t> (config.value ("concurrency", 100));

            vayu::utils::log_info (
            "Starting Constant Load Test (Concurrency-Based)");
            vayu::utils::log_info ("  Duration: " + std::to_string (duration_ms) + " ms");
            vayu::utils::log_info ("  Concurrency: " + std::to_string (concurrency));

            auto submit_one = [&context, &db, &request] () {
                context->event_loop->submit (request,
                [context, &db] (size_t, vayu::Result<vayu::Response> result) {
                    handle_result (context, db, std::move (result));
                });
                context->requests_sent++;
            };

            maintain_concurrency (
            context, submit_one,
            [concurrency] (int64_t) { return concurrency; },      // target(t) = N
            [] () { return std::numeric_limits<size_t>::max (); }, // unbounded budget
            [duration_ms] (int64_t el) { return el < duration_ms; }); // stop at duration
        }
    }
};

// ============================================================================
// Iterations Load Strategy
// ============================================================================

class IterationsLoadStrategy : public LoadStrategy {
    public:
    void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) override {
        const auto& config = context->config;
        size_t iterations = static_cast<size_t> (config.value ("iterations", 1000));
        size_t concurrency = static_cast<size_t> (config.value ("concurrency", 10));
        double target_rps = config.value ("rps", 0.0);
        if (target_rps == 0.0)
            target_rps = config.value ("targetRps", 0.0);

        vayu::utils::log_info ("Starting Iterations Load Test");
        vayu::utils::log_info ("  Iterations: " + std::to_string (iterations));
        vayu::utils::log_info ("  Concurrency: " + std::to_string (concurrency));

        context->requests_expected = iterations;

        auto submit_one = [&context, &db, &request] () {
            context->event_loop->submit (request,
            [context, &db] (size_t, vayu::Result<vayu::Response> result) {
                handle_result (context, db, std::move (result));
            });
            context->requests_sent++;
        };

        maintain_concurrency (
        context, submit_one,
        [concurrency] (int64_t) { return concurrency; },     // target = N
        [context, iterations] () -> size_t {                 // budget = M - sent
            size_t sent = context->requests_sent.load ();
            return sent < iterations ? iterations - sent : 0;
        },
        [context, iterations] (int64_t) {                    // stop at M
            return context->requests_sent.load () < iterations;
        });

        vayu::utils::log_info (
        "Submitted " + std::to_string (context->requests_sent.load ()) + " requests");
    }
};

// ============================================================================
// Ramp Up Load Strategy
// ============================================================================

class RampUpLoadStrategy : public LoadStrategy {
    public:
    void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) override {
        const auto& config = context->config;

        // Parse duration
        std::string duration_str = config.value ("duration", "60s");
        int64_t duration_ms      = 0;
        try {
            duration_ms =
            std::stoll (duration_str.substr (0, duration_str.length () - 1)) * 1000;
        } catch (...) {
            duration_ms = 60000;
        }

        // Parse ramp up parameters
        std::string ramp_duration_str = config.value ("rampUpDuration", "10s");
        int64_t ramp_duration_ms      = 0;
        try {
            ramp_duration_ms =
            std::stoll (ramp_duration_str.substr (0, ramp_duration_str.length () - 1)) * 1000;
        } catch (...) {
            ramp_duration_ms = 10000;
        }

        size_t start_concurrency =
        static_cast<size_t> (config.value ("startConcurrency", 1));
        size_t target_concurrency =
        static_cast<size_t> (config.value ("concurrency", 100));

        vayu::utils::log_info ("Starting Ramp Up Load Test");
        vayu::utils::log_info ("  Total Duration: " + std::to_string (duration_ms) + " ms");
        vayu::utils::log_info (
        "  Ramp Up Duration: " + std::to_string (ramp_duration_ms) + " ms");
        vayu::utils::log_info ("  Start Concurrency: " + std::to_string (start_concurrency));
        vayu::utils::log_info ("  Target Concurrency: " + std::to_string (target_concurrency));

        auto submit_one = [&context, &db, &request] () {
            context->event_loop->submit (request,
            [context, &db] (size_t, vayu::Result<vayu::Response> result) {
                handle_result (context, db, std::move (result));
            });
            context->requests_sent++;
        };

        // target(t): linear from start_concurrency to target_concurrency over
        // ramp_duration_ms, then flat at target_concurrency.
        auto target_fn = [start_concurrency, target_concurrency, ramp_duration_ms] (
                         int64_t el) -> size_t {
            if (ramp_duration_ms <= 0 || el >= ramp_duration_ms) {
                return target_concurrency;
            }
            double progress = static_cast<double> (el) / static_cast<double> (ramp_duration_ms);
            return static_cast<size_t> (static_cast<double> (start_concurrency) +
            static_cast<double> (target_concurrency - start_concurrency) * progress);
        };

        maintain_concurrency (
        context, submit_one, target_fn,
        [] () { return std::numeric_limits<size_t>::max (); },
        [duration_ms] (int64_t el) { return el < duration_ms; });
    }
};

// ============================================================================
// Factory
// ============================================================================

std::unique_ptr<LoadStrategy> LoadStrategy::create (const nlohmann::json& config) {
    std::string mode = config.value ("mode", "constant_rps");
    auto type        = parse_load_test_type (mode);

    if (!type) {
        if (config.contains ("iterations")) {
            return std::make_unique<IterationsLoadStrategy> ();
        }
        return std::make_unique<ConstantLoadStrategy> ();
    }

    switch (*type) {
    case LoadTestType::ConstantRps:
    case LoadTestType::ConstantConcurrency:
        return std::make_unique<ConstantLoadStrategy> ();
    case LoadTestType::Iterations:
        return std::make_unique<IterationsLoadStrategy> ();
    case LoadTestType::RampUp: return std::make_unique<RampUpLoadStrategy> ();
    }

    return std::make_unique<ConstantLoadStrategy> ();
}

} // namespace vayu::core
