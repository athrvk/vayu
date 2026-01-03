#include "vayu/core/load_strategy.hpp"

#include <chrono>
#include <iostream>
#include <nlohmann/json.hpp>
#include <thread>

#include "vayu/core/run_manager.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {
inline int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

void handle_result(std::shared_ptr<RunContext> context,
                   vayu::db::Database& db,
                   vayu::Result<vayu::Response> result) {
    context->total_requests++;

    // Get sampling configuration from context config
    size_t success_sample_rate =
        static_cast<size_t>(context->config.value("success_sample_rate", 100));
    int slow_threshold_ms = context->config.value("slow_threshold_ms", 1000);
    bool save_timing_breakdown = context->config.value("save_timing_breakdown", false);

    if (result.is_ok()) {
        const auto& response = result.value();
        double latency = response.timing.total_ms;
        context->total_latency_ms += latency;

        // Log successful response details at debug level
        vayu::utils::log_debug("Request completed: status=" + std::to_string(response.status_code) +
                               ", latency=" + std::to_string(latency) + "ms");

        // Store latency for percentiles
        {
            std::lock_guard<std::mutex> lock(context->latencies_mutex);
            context->latencies.push_back(latency);
        }

        // Determine if we should save this result
        bool is_slow = latency >= slow_threshold_ms;
        bool should_sample = (context->total_requests % success_sample_rate == 0);
        bool should_save = is_slow || should_sample;

        if (should_save) {
            try {
                vayu::db::Result db_result;
                db_result.run_id = context->run_id;
                db_result.timestamp = now_ms();
                db_result.status_code = response.status_code;
                db_result.latency_ms = latency;

                // Save detailed timing breakdown if enabled
                if (save_timing_breakdown) {
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

                    db_result.trace_data = timing_json.dump();
                }

                db.add_result(db_result);
            } catch (const std::exception& e) {
                // Continue on DB error
            }
        }
    } else {
        // CRITICAL: Save all errors with full details
        context->total_errors++;

        const auto& error = result.error();
        vayu::utils::log_debug(
            "Request failed: code=" + std::to_string(static_cast<int>(error.code)) +
            ", message=" + error.message);

        try {
            const auto& error = result.error();
            vayu::db::Result error_result;
            error_result.run_id = context->run_id;
            error_result.timestamp = now_ms();
            error_result.status_code = 0;   // 0 indicates error (not HTTP status)
            error_result.latency_ms = 0.0;  // Could track time until error if needed
            error_result.error = error.message;

            // Save detailed error information
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
                                         {"request_number", context->total_requests.load()}};

            error_result.trace_data = error_json.dump();
            db.add_result(error_result);
        } catch (const std::exception& e) {
            // Continue even if we can't save error details
            vayu::utils::log_error("Failed to save error details: " + std::string(e.what()));
        }
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
            size_t expected = static_cast<size_t>((duration_ms / 1000.0) * target_rps);
            context->requests_expected = expected;

            // Calculate interval between requests
            int64_t interval_us = static_cast<int64_t>(1'000'000.0 / target_rps);

            auto test_start = std::chrono::steady_clock::now();
            auto next_request_time = test_start;
            size_t submitted = 0;

            while (!context->should_stop) {
                auto now = std::chrono::steady_clock::now();
                auto elapsed =
                    std::chrono::duration_cast<std::chrono::milliseconds>(now - test_start).count();

                if (elapsed >= duration_ms) {
                    break;
                }

                // Check if it's time to submit next request
                if (now >= next_request_time) {
                    // Backpressure check
                    size_t max_pending =
                        std::max(static_cast<size_t>(target_rps * 10), size_t(1000));
                    if (context->event_loop->pending_count() < max_pending) {
                        context->event_loop->submit(
                            request, [context, &db](size_t, vayu::Result<vayu::Response> result) {
                                handle_result(context, db, std::move(result));
                            });
                        submitted++;
                        context->requests_sent++;

                        // Schedule next request
                        next_request_time += std::chrono::microseconds(interval_us);
                    } else {
                        // If we're backed up, skip ahead to avoid flooding
                        next_request_time = now + std::chrono::microseconds(interval_us);
                    }
                }

                // Sleep for a small amount to avoid busy waiting
                auto sleep_time =
                    std::chrono::duration_cast<std::chrono::microseconds>(next_request_time - now)
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
                size_t max_pending = std::max(concurrency * 5, size_t(1000));
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
            size_t max_pending = std::max(concurrency * 5, size_t(100));
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
                double progress = static_cast<double>(elapsed) / ramp_duration_ms;
                current_concurrency = static_cast<size_t>(
                    start_concurrency + (target_concurrency - start_concurrency) * progress);
            }

            // Backpressure
            size_t max_pending = std::max(target_concurrency * 5, size_t(1000));
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
