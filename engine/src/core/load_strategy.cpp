#include "vayu/core/load_strategy.hpp"

#include <chrono>
#include <iostream>
#include <nlohmann/json.hpp>
#include <thread>

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
void handle_result(std::shared_ptr<RunContext> context,
                   vayu::db::Database& /* db - unused, kept for API compat */,
                   vayu::Result<vayu::Response> result) {
    // Get configuration
    int slow_threshold_ms = context->config.value("slow_threshold_ms", 1000);
    bool save_timing_breakdown = context->config.value("save_timing_breakdown", false);

    if (result.is_ok()) {
        const auto& response = result.value();
        double latency = response.timing.total_ms;

        // Build trace data if configured
        std::string trace_data;
        bool is_slow = latency >= static_cast<double>(slow_threshold_ms);

        if (save_timing_breakdown || is_slow) {
            nlohmann::json timing_json = {{"total_ms", response.timing.total_ms},
                                          {"dns_ms", response.timing.dns_ms},
                                          {"connect_ms", response.timing.connect_ms},
                                          {"tls_ms", response.timing.tls_ms},
                                          {"first_byte_ms", response.timing.first_byte_ms},
                                          {"download_ms", response.timing.download_ms}};

            if (is_slow) {
                timing_json["is_slow"] = true;
                timing_json["threshold_ms"] = slow_threshold_ms;
            }

            trace_data = timing_json.dump();
        }

        // Record to in-memory collector (high-performance, no DB writes)
        context->metrics_collector->record_success(response.status_code, latency, trace_data);

        // Sample response for deferred script validation if test script is present
        if (!context->test_script.empty()) {
            context->metrics_collector->record_response_sample(response);
        }

    } else {
        // Record error to in-memory collector (all errors are preserved)
        const auto& error = result.error();

        // Build detailed error trace data
        nlohmann::json error_json = {{"error_code", static_cast<int>(error.code)},
                                     {"error_type",
                                      [&error]() {
                                          switch (error.code) {
                                              case vayu::ErrorCode::Timeout:
                                                  return "timeout";
                                              case vayu::ErrorCode::ConnectionFailed:
                                                  return "connection_failed";
                                              case vayu::ErrorCode::DnsError:
                                                  return "dns_failed";
                                              case vayu::ErrorCode::SslError:
                                                  return "ssl_error";
                                              case vayu::ErrorCode::InvalidUrl:
                                                  return "invalid_url";
                                              case vayu::ErrorCode::InvalidMethod:
                                                  return "invalid_method";
                                              case vayu::ErrorCode::ScriptError:
                                                  return "script_error";
                                              case vayu::ErrorCode::InternalError:
                                                  return "internal_error";
                                              default:
                                                  return "unknown";
                                          }
                                      }()},
                                     {"message", error.message},
                                     {"request_number", context->total_requests()}};

        context->metrics_collector->record_error(error.code, error.message, error_json.dump());
    }
}
}  // namespace

// ============================================================================
// Constant Load Strategy
// ============================================================================

class ConstantLoadStrategy : public LoadStrategy {
public:
    void execute(std::shared_ptr<RunContext> context,
                 vayu::db::Database& db,
                 const vayu::Request& request) override {
        const auto& config = context->config;
        std::string duration_str = config.value("duration", "60s");
        int64_t duration_ms = 0;
        try {
            duration_ms = std::stoll(duration_str.substr(0, duration_str.length() - 1)) * 1000;
        } catch (...) {
            duration_ms = 60000;
        }

        // Check for targetRps - if specified, use rate-limited mode
        double target_rps = config.value("rps", 0.0);
        if (target_rps == 0.0) target_rps = config.value("targetRps", 0.0);

        if (target_rps > 0.0) {
            // Rate-limited mode
            vayu::utils::log_info("Starting Constant Load Test (Rate-Limited)");
            vayu::utils::log_info("  Duration: " + std::to_string(duration_ms) + " ms");
            vayu::utils::log_info("  Target RPS: " + std::to_string(target_rps));

            // Calculate expected requests
            size_t expected =
                static_cast<size_t>((static_cast<double>(duration_ms) / 1000.0) * target_rps);
            context->requests_expected = expected;

            // For high RPS, submit in batches to reduce loop overhead
            // Batch interval: 1ms = 1000us, batch_size = target_rps / 1000
            constexpr int64_t BATCH_INTERVAL_US = 1000;  // 1ms batches
            size_t batch_size = std::max(static_cast<size_t>(target_rps / 1000.0), size_t(1));

            vayu::utils::log_debug("Submission config: batch_size=" + std::to_string(batch_size) +
                                   ", batch_interval_us=" + std::to_string(BATCH_INTERVAL_US));

            auto test_start = std::chrono::steady_clock::now();
            auto next_batch_time = test_start;
            size_t submitted = 0;

            while (!context->should_stop) {
                auto now = std::chrono::steady_clock::now();
                auto elapsed =
                    std::chrono::duration_cast<std::chrono::milliseconds>(now - test_start).count();

                if (elapsed >= duration_ms) {
                    break;
                }

                // Check if it's time to submit next batch
                if (now >= next_batch_time) {
                    // Backpressure check
                    size_t max_pending =
                        std::max(static_cast<size_t>(target_rps * 10.0), size_t(1000));

                    if (context->event_loop->pending_count() < max_pending) {
                        // Submit batch of requests
                        for (size_t i = 0; i < batch_size && !context->should_stop; ++i) {
                            context->event_loop->submit(
                                request,
                                [context, &db](size_t, vayu::Result<vayu::Response> result) {
                                    handle_result(context, db, std::move(result));
                                });
                            submitted++;
                            context->requests_sent++;
                        }

                        // Schedule next batch
                        next_batch_time += std::chrono::microseconds(BATCH_INTERVAL_US);
                    } else {
                        // If we're backed up, skip ahead to avoid flooding
                        next_batch_time = now + std::chrono::microseconds(BATCH_INTERVAL_US);
                    }
                }

                // Sleep for remaining time until next batch
                auto sleep_time =
                    std::chrono::duration_cast<std::chrono::microseconds>(next_batch_time - now)
                        .count();
                if (sleep_time > 100) {
                    std::this_thread::sleep_for(std::chrono::microseconds(sleep_time / 2));
                }
            }

            vayu::utils::log_info("Submitted " + std::to_string(submitted) + " requests");

        } else {
            // Concurrency-based mode (legacy behavior)
            size_t concurrency = static_cast<size_t>(config.value("concurrency", 100));

            vayu::utils::log_info("Starting Constant Load Test (Concurrency-Based)");
            vayu::utils::log_info("  Duration: " + std::to_string(duration_ms) + " ms");
            vayu::utils::log_info("  Concurrency: " + std::to_string(concurrency));

            auto test_start = std::chrono::steady_clock::now();

            while (!context->should_stop) {
                auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                                   std::chrono::steady_clock::now() - test_start)
                                   .count();

                if (elapsed >= duration_ms) {
                    break;
                }

                // Backpressure
                size_t max_pending = std::max(concurrency * 5U, size_t(1000));
                if (context->event_loop->pending_count() > max_pending) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
                    continue;
                }

                // Submit batch
                for (size_t i = 0; i < concurrency && !context->should_stop; ++i) {
                    context->event_loop->submit(
                        request, [context, &db](size_t, vayu::Result<vayu::Response> result) {
                            handle_result(context, db, std::move(result));
                        });
                    context->requests_sent++;
                }

                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
        }
    }
};

// ============================================================================
// Iterations Load Strategy
// ============================================================================

class IterationsLoadStrategy : public LoadStrategy {
public:
    void execute(std::shared_ptr<RunContext> context,
                 vayu::db::Database& db,
                 const vayu::Request& request) override {
        const auto& config = context->config;
        size_t iterations = static_cast<size_t>(config.value("iterations", 1000));
        size_t concurrency = static_cast<size_t>(config.value("concurrency", 10));
        double target_rps = config.value("rps", 0.0);
        if (target_rps == 0.0) target_rps = config.value("targetRps", 0.0);

        vayu::utils::log_info("Starting Iterations Load Test");
        vayu::utils::log_info("  Iterations: " + std::to_string(iterations));
        vayu::utils::log_info("  Concurrency: " + std::to_string(concurrency));

        context->requests_expected = iterations;

        size_t submitted = 0;
        while (submitted < iterations && !context->should_stop) {
            // Backpressure - don't submit too many at once
            size_t max_pending = std::max(concurrency * 5U, size_t(100));
            if (context->event_loop->pending_count() > max_pending) {
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
                continue;
            }

            // Submit batch
            size_t batch_size = std::min(concurrency, iterations - submitted);
            for (size_t i = 0; i < batch_size && !context->should_stop; ++i) {
                context->event_loop->submit(
                    request, [context, &db](size_t, vayu::Result<vayu::Response> result) {
                        handle_result(context, db, std::move(result));
                    });
                submitted++;
                context->requests_sent++;
            }

            // Small sleep to pace submissions
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }

        vayu::utils::log_info("Submitted " + std::to_string(submitted) + " requests");
    }
};

// ============================================================================
// Ramp Up Load Strategy
// ============================================================================

class RampUpLoadStrategy : public LoadStrategy {
public:
    void execute(std::shared_ptr<RunContext> context,
                 vayu::db::Database& db,
                 const vayu::Request& request) override {
        const auto& config = context->config;

        // Parse duration
        std::string duration_str = config.value("duration", "60s");
        int64_t duration_ms = 0;
        try {
            duration_ms = std::stoll(duration_str.substr(0, duration_str.length() - 1)) * 1000;
        } catch (...) {
            duration_ms = 60000;
        }

        // Parse ramp up parameters
        std::string ramp_duration_str = config.value("rampUpDuration", "10s");
        int64_t ramp_duration_ms = 0;
        try {
            ramp_duration_ms =
                std::stoll(ramp_duration_str.substr(0, ramp_duration_str.length() - 1)) * 1000;
        } catch (...) {
            ramp_duration_ms = 10000;
        }

        size_t start_concurrency = static_cast<size_t>(config.value("startConcurrency", 1));
        size_t target_concurrency = static_cast<size_t>(config.value("concurrency", 100));

        vayu::utils::log_info("Starting Ramp Up Load Test");
        vayu::utils::log_info("  Total Duration: " + std::to_string(duration_ms) + " ms");
        vayu::utils::log_info("  Ramp Up Duration: " + std::to_string(ramp_duration_ms) + " ms");
        vayu::utils::log_info("  Start Concurrency: " + std::to_string(start_concurrency));
        vayu::utils::log_info("  Target Concurrency: " + std::to_string(target_concurrency));

        auto test_start = std::chrono::steady_clock::now();

        while (!context->should_stop) {
            auto now = std::chrono::steady_clock::now();
            auto elapsed =
                std::chrono::duration_cast<std::chrono::milliseconds>(now - test_start).count();

            if (elapsed >= duration_ms) {
                break;
            }

            // Calculate current concurrency
            size_t current_concurrency = target_concurrency;
            if (elapsed < ramp_duration_ms) {
                double progress =
                    static_cast<double>(elapsed) / static_cast<double>(ramp_duration_ms);
                current_concurrency = static_cast<size_t>(
                    static_cast<double>(start_concurrency) +
                    (static_cast<double>(target_concurrency - start_concurrency) * progress));
            }

            // Backpressure
            size_t max_pending = std::max(target_concurrency * 5U, size_t(1000));
            if (context->event_loop->pending_count() > max_pending) {
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                continue;
            }

            // Submit batch based on current concurrency
            for (size_t i = 0; i < current_concurrency && !context->should_stop; ++i) {
                context->event_loop->submit(
                    request, [context, &db](size_t, vayu::Result<vayu::Response> result) {
                        handle_result(context, db, std::move(result));
                    });
                context->requests_sent++;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }
};

// ============================================================================
// Factory
// ============================================================================

std::unique_ptr<LoadStrategy> LoadStrategy::create(const nlohmann::json& config) {
    std::string mode = config.value("mode", "constant");
    auto type = parse_load_test_type(mode);

    if (!type) {
        // Fallback logic for backward compatibility
        if (config.contains("iterations")) {
            return std::make_unique<IterationsLoadStrategy>();
        }
        return std::make_unique<ConstantLoadStrategy>();
    }

    switch (*type) {
        case LoadTestType::Constant:
            return std::make_unique<ConstantLoadStrategy>();
        case LoadTestType::Iterations:
            return std::make_unique<IterationsLoadStrategy>();
        case LoadTestType::RampUp:
            return std::make_unique<RampUpLoadStrategy>();
    }

    return std::make_unique<ConstantLoadStrategy>();
}

}  // namespace vayu::core
