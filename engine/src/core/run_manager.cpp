/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/run_manager.hpp"

#include <algorithm>
#include <chrono>
#include <iostream>

#include "vayu/core/constants.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {
inline int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

/**
 * @brief Validate sampled responses using test scripts (deferred validation)
 * This runs after the load test completes to avoid impacting throughput.
 * Results are streamed to the database for SSE consumption.
 */
void validate_scripts(std::shared_ptr<RunContext> context, vayu::db::Database& db, bool verbose) {
    if (context->test_script.empty()) {
        return;  // No script to validate
    }

    const auto& samples = context->metrics_collector->response_samples();
    if (samples.empty()) {
        if (verbose) {
            vayu::utils::log_info("No response samples collected for script validation");
        }
        return;
    }

    if (verbose) {
        vayu::utils::log_info("Validating " + std::to_string(samples.size()) +
                              " response samples with test script...");
    }

    // Send "validating" metric to indicate script validation has started
    db.add_metric({0,
                   context->run_id,
                   now_ms(),
                   vayu::MetricName::TestsValidating,
                   1.0,
                   R"({"samples":)" + std::to_string(samples.size()) + "}"});

    // Stream the number of samples being validated
    db.add_metric({0,
                   context->run_id,
                   now_ms(),
                   vayu::MetricName::TestsSampled,
                   static_cast<double>(samples.size()),
                   ""});

    // Create script engine for validation
    vayu::runtime::ScriptEngine engine;
    vayu::Environment env;

    // Build a dummy request for script context
    vayu::Request dummy_request;
    if (context->config.contains("request")) {
        auto request_result = vayu::json::deserialize_request(context->config["request"]);
        if (request_result.is_ok()) {
            dummy_request = request_result.value();
        }
    }

    size_t passed = 0;
    size_t failed = 0;
    std::vector<std::string> failure_messages;

    for (const auto& sample : samples) {
        // Build Response from sample
        vayu::Response response;
        response.status_code = sample.status_code;
        response.status_text = sample.status_text;
        response.body = sample.body;
        response.headers = sample.headers;
        response.timing.total_ms = sample.latency_ms;

        try {
            auto result = engine.execute_test(context->test_script, dummy_request, response, env);

            if (result.success) {
                // Check individual test results
                for (const auto& test : result.tests) {
                    if (test.passed) {
                        passed++;
                    } else {
                        failed++;
                        if (failure_messages.size() <
                            vayu::core::constants::script_validation::MAX_FAILURE_MESSAGES) {
                            failure_messages.push_back(test.name + ": " + test.error_message);
                        }
                    }
                }
                if (result.tests.empty()) {
                    // Script ran but had no pm.test() calls - count as passed
                    passed++;
                }
            } else {
                failed++;
                if (failure_messages.size() <
                    vayu::core::constants::script_validation::MAX_FAILURE_MESSAGES) {
                    failure_messages.push_back("Script error: " + result.error_message);
                }
            }
        } catch (const std::exception& e) {
            failed++;
            if (failure_messages.size() <
                vayu::core::constants::script_validation::MAX_FAILURE_MESSAGES) {
                failure_messages.push_back("Exception: " + std::string(e.what()));
            }
        }
    }

    // Store test validation results
    auto timestamp = now_ms();
    db.add_metric({0,
                   context->run_id,
                   timestamp,
                   vayu::MetricName::TestsPassed,
                   static_cast<double>(passed),
                   ""});
    db.add_metric({0,
                   context->run_id,
                   timestamp,
                   vayu::MetricName::TestsFailed,
                   static_cast<double>(failed),
                   ""});

    // Store failure summary as a result record
    if (!failure_messages.empty()) {
        nlohmann::json failure_json;
        failure_json["failures"] = failure_messages;
        failure_json["totalFailed"] = failed;
        failure_json["totalPassed"] = passed;

        vayu::db::Result validation_result;
        validation_result.run_id = context->run_id;
        validation_result.timestamp = timestamp;
        validation_result.status_code = failed > 0 ? 0 : 200;  // 0 indicates test failures
        validation_result.latency_ms = 0;
        validation_result.error = failed > 0 ? "Script validation failures" : "";
        validation_result.trace_data = failure_json.dump();

        db.add_result(validation_result);
    }

    if (verbose) {
        vayu::utils::log_info("  Script validation: " + std::to_string(passed) + " passed, " +
                              std::to_string(failed) + " failed");
    }
}
}  // namespace

RunContext::RunContext(const std::string& id, nlohmann::json cfg)
    : run_id(id), config(std::move(cfg)), start_time_ms(0) {
    // Initialize MetricsCollector with configuration from test config
    MetricsCollectorConfig mc_config;

    // Calculate expected requests from duration and RPS
    std::string duration_str = config.value("duration", "60s");
    int64_t duration_ms = 60000;  // default 60s
    try {
        duration_ms = std::stoll(duration_str.substr(0, duration_str.length() - 1)) * 1000;
    } catch (...) {
    }

    double target_rps = config.value("rps", 0.0);
    if (target_rps == 0.0) target_rps = config.value("targetRps", 0.0);
    if (target_rps == 0.0) target_rps = 1000.0;  // default estimate

    // Pre-allocate with 20% buffer
    mc_config.expected_requests =
        static_cast<size_t>((static_cast<double>(duration_ms) / 1000.0) * target_rps * 1.2);
    mc_config.expected_requests = std::max(mc_config.expected_requests, size_t(10000));

    // Get sampling config
    mc_config.success_sample_rate = static_cast<size_t>(config.value("success_sample_rate", 100));
    mc_config.store_success_traces = config.value("save_timing_breakdown", false);

    // Configure response sampling for script validation
    mc_config.max_response_samples =
        static_cast<size_t>(config.value("max_response_samples", 1000));
    mc_config.response_sample_rate = static_cast<size_t>(config.value("response_sample_rate", 100));

    // Extract test script from request if present
    if (config.contains("request") && config["request"].contains("tests")) {
        test_script = config["request"]["tests"].get<std::string>();
    }
    // Also check top-level tests field
    if (test_script.empty() && config.contains("tests")) {
        test_script = config["tests"].get<std::string>();
    }

    metrics_collector = std::make_unique<MetricsCollector>(id, mc_config);
}

RunContext::~RunContext() {
    should_stop = true;
    if (worker_thread.joinable()) {
        worker_thread.join();
    }
    if (metrics_thread.joinable()) {
        metrics_thread.join();
    }
}

void RunManager::register_run(const std::string& run_id, std::shared_ptr<RunContext> context) {
    std::lock_guard<std::mutex> lock(mutex_);
    active_runs_[run_id] = context;
}

std::shared_ptr<RunContext> RunManager::get_run(const std::string& run_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = active_runs_.find(run_id);
    if (it != active_runs_.end()) {
        return it->second;
    }
    return nullptr;
}

void RunManager::unregister_run(const std::string& run_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    active_runs_.erase(run_id);
}

size_t RunManager::active_count() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return active_runs_.size();
}

std::vector<std::shared_ptr<RunContext>> RunManager::get_all_active_runs() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<std::shared_ptr<RunContext>> runs;
    for (const auto& [id, context] : active_runs_) {
        runs.push_back(context);
    }
    return runs;
}

void RunManager::start_run(const std::string& run_id,
                           const nlohmann::json& config,
                           vayu::db::Database& db,
                           bool verbose) {
    auto context = std::make_shared<RunContext>(run_id, config);
    register_run(run_id, context);

    // IMPORTANT: Set is_running BEFORE spawning threads to avoid race condition
    // where metrics_thread exits immediately because is_running is still false
    context->is_running = true;
    context->start_time_ms = now_ms();

    // Spawn metrics collection thread first (will be joined by worker thread)
    context->metrics_thread = std::thread([context, &db]() { collect_metrics(context, &db); });
    // Note: metrics_thread is NOT detached - it will be joined by the worker thread

    // Spawn background thread for execution
    context->worker_thread = std::thread(
        [context, &db, verbose, this]() { execute_load_test(context, &db, verbose, *this); });
    context->worker_thread.detach();
}

void execute_load_test(std::shared_ptr<RunContext> context,
                       vayu::db::Database* db_ptr,
                       bool verbose,
                       RunManager& manager) {
    // Note: is_running and start_time_ms are set in start_run() before threads spawn
    // to avoid race condition with metrics_thread

    auto& db = *db_ptr;
    const auto& config = context->config;

    try {
        // Update status to running
        db.update_run_status(context->run_id, vayu::RunStatus::Running);

        // Get defaults from config (set via Settings UI)
        int default_max_concurrent = db.get_config_int(
            "eventLoopMaxConcurrent", vayu::core::constants::event_loop::MAX_CONCURRENT);
        int default_max_per_host = db.get_config_int(
            "eventLoopMaxPerHost", vayu::core::constants::event_loop::MAX_PER_HOST);
        int configured_workers = db.get_config_int("workers", 0);  // 0 = auto-detect

        // Per-test config can override defaults
        size_t concurrency =
            static_cast<size_t>(config.value("concurrency", default_max_concurrent));
        double target_rps = config.value("rps", 0.0);  // 0 = unlimited
        if (target_rps == 0.0) {
            target_rps = config.value("targetRps", 0.0);
        }
        int timeout_ms = config.value("timeout", 30000);

        // Configure EventLoop
        vayu::http::EventLoopConfig loop_config;
        loop_config.num_workers =
            static_cast<size_t>(configured_workers);  // Use configured workers (0 = auto-detect)
        loop_config.max_concurrent = std::max(concurrency, size_t(100));
        loop_config.max_per_host = static_cast<size_t>(default_max_per_host);
        loop_config.target_rps = target_rps;
        loop_config.burst_size = target_rps > 0 ? target_rps * 2.0 : 0.0;
        loop_config.dns_cache_timeout = db.get_config_int(
            "dnsCacheTimeout", vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS);
        // Only enable curl verbose if explicitly requested in config, independent of server verbose
        // mode
        loop_config.verbose = config.value("verbose", false);

        std::string workers_str =
            configured_workers == 0 ? "auto" : std::to_string(configured_workers);
        vayu::utils::log_debug("EventLoop config: workers=" + workers_str +
                               ", max_concurrent=" + std::to_string(loop_config.max_concurrent) +
                               ", max_per_host=" + std::to_string(loop_config.max_per_host) +
                               ", target_rps=" + std::to_string(target_rps) +
                               ", timeout=" + std::to_string(timeout_ms) + "ms");

        // Create EventLoop
        context->event_loop = std::make_unique<vayu::http::EventLoop>(loop_config);
        context->event_loop->start();

        // Parse request
        auto request_json = config["request"];
        auto request_result = vayu::json::deserialize_request(request_json);
        if (request_result.is_error()) {
            db.update_run_status(context->run_id, vayu::RunStatus::Failed);
            context->is_running = false;
            return;
        }

        auto request = request_result.value();
        request.timeout_ms = timeout_ms;
        
        // Execute Load Strategy
        auto test_start = std::chrono::steady_clock::now();

        try {
            auto strategy = LoadStrategy::create(config);
            strategy->execute(context, db, request);
        } catch (const std::exception& e) {
            vayu::utils::log_error("Load test failed: " + std::string(e.what()));
            db.update_run_status(context->run_id, vayu::RunStatus::Failed);
            context->is_running = false;
            return;
        }

        // Wait for all requests to complete
        context->event_loop->stop(true);  // Wait for pending

        // Record test end time immediately (before cleanup overhead)
        auto test_end = std::chrono::steady_clock::now();
        double total_duration_s = std::chrono::duration<double>(test_end - test_start).count();

        // Update end_time in DB immediately to reflect actual test end
        // (not after cleanup/metrics thread join)
        db.update_run_end_time(context->run_id);

        // Stop background metrics collection and wait for thread to finish
        context->is_running = false;

        // Properly join the metrics thread to ensure it's done writing to DB
        if (context->metrics_thread.joinable()) {
            context->metrics_thread.join();
        }

        // Calculate cleanup overhead (time from test end to after cleanup)
        auto cleanup_end = std::chrono::steady_clock::now();
        double setup_overhead_s = std::chrono::duration<double>(cleanup_end - test_end).count();

        size_t completed = context->total_requests();
        size_t errors = context->total_errors();
        double avg_latency = context->metrics_collector->average_latency();
        double actual_rps =
            total_duration_s > 0 ? static_cast<double>(completed) / total_duration_s : 0.0;
        double error_rate = context->metrics_collector->error_rate();

        // Calculate percentiles using MetricsCollector
        auto percentiles = context->metrics_collector->calculate_percentiles();
        double p50 = percentiles.p50;
        double p95 = percentiles.p95;
        double p99 = percentiles.p99;

        // Store final summary metrics (batched in single transaction to reduce lock contention)
        try {
            auto timestamp = now_ms();
            std::vector<vayu::db::Metric> final_metrics;
            final_metrics.reserve(12);  // Pre-allocate for expected metrics

            final_metrics.push_back(
                {0, context->run_id, timestamp, vayu::MetricName::Rps, actual_rps, ""});
            final_metrics.push_back(
                {0, context->run_id, timestamp, vayu::MetricName::LatencyAvg, avg_latency, ""});
            final_metrics.push_back({0,
                                     context->run_id,
                                     timestamp,
                                     vayu::MetricName::LatencyP50,
                                     p50,
                                     R"({"percentile":"p50"})"});
            final_metrics.push_back({0,
                                     context->run_id,
                                     timestamp,
                                     vayu::MetricName::LatencyP95,
                                     p95,
                                     R"({"percentile":"p95"})"});
            final_metrics.push_back({0,
                                     context->run_id,
                                     timestamp,
                                     vayu::MetricName::LatencyP99,
                                     p99,
                                     R"({"percentile":"p99"})"});
            final_metrics.push_back(
                {0, context->run_id, timestamp, vayu::MetricName::ErrorRate, error_rate, ""});
            final_metrics.push_back({0,
                                     context->run_id,
                                     timestamp,
                                     vayu::MetricName::TotalRequests,
                                     static_cast<double>(completed),
                                     ""});
            final_metrics.push_back(
                {0, context->run_id, timestamp, vayu::MetricName::Completed, 1.0, ""});

            // Store actual test duration (excludes setup/teardown overhead)
            final_metrics.push_back({0,
                                     context->run_id,
                                     timestamp,
                                     vayu::MetricName::TestDuration,
                                     total_duration_s,
                                     ""});

            // Store setup/teardown overhead for diagnostic purposes
            final_metrics.push_back({0,
                                     context->run_id,
                                     timestamp,
                                     vayu::MetricName::SetupOverhead,
                                     setup_overhead_s,
                                     ""});

            // Store status code distribution as JSON in metadata field
            auto status_codes = context->metrics_collector->status_code_distribution();
            if (!status_codes.empty()) {
                nlohmann::json status_codes_json;
                for (const auto& [code, count] : status_codes) {
                    status_codes_json[std::to_string(code)] = count;
                }
                final_metrics.push_back({0,
                                         context->run_id,
                                         timestamp,
                                         vayu::MetricName::StatusCodes,
                                         0.0,
                                         status_codes_json.dump()});
            }

            // Batch insert all metrics in a single transaction
            db.add_metrics_batch(final_metrics);
        } catch (const std::exception& e) {
            vayu::utils::log_error("Failed to store final metrics: " + std::string(e.what()));
        }

        // Batch flush all results to database (errors and sampled successes)
        try {
            size_t flushed = context->metrics_collector->flush_to_database(db);
            if (verbose && flushed > 0) {
                vayu::utils::log_info("  Flushed " + std::to_string(flushed) +
                                      " results to database");
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error("Failed to flush results to database: " + std::string(e.what()));
        }

        // Run deferred script validation if test script is present
        try {
            validate_scripts(context, db, verbose);
        } catch (const std::exception& e) {
            vayu::utils::log_error("Script validation failed: " + std::string(e.what()));
        }

        // Update run status with retry logic to handle any remaining contention
        vayu::RunStatus final_status =
            context->should_stop ? vayu::RunStatus::Stopped : vayu::RunStatus::Completed;
        db.update_run_status_with_retry(context->run_id, final_status);

        if (verbose) {
            vayu::utils::log_info("Load test " + context->run_id + " " +
                                  vayu::to_string(final_status));
            vayu::utils::log_info("  Total requests: " + std::to_string(completed));
            vayu::utils::log_info("  Errors: " + std::to_string(errors) + " (" +
                                  std::to_string(error_rate) + "%)");
            vayu::utils::log_info("  Duration: " + std::to_string(total_duration_s) + " s");
            vayu::utils::log_info("  Target RPS: " +
                                  (target_rps > 0 ? std::to_string(target_rps) : "unlimited"));
            vayu::utils::log_info("  Actual RPS: " + std::to_string(actual_rps));
            vayu::utils::log_info("  Avg latency: " + std::to_string(avg_latency) + " ms");
            vayu::utils::log_info("  P50/P95/P99: " + std::to_string(p50) + "/" +
                                  std::to_string(p95) + "/" + std::to_string(p99) + " ms");
        }
    } catch (const std::exception& e) {
        // Stop background metrics collection
        context->is_running = false;
        std::this_thread::sleep_for(std::chrono::milliseconds(200));

        vayu::utils::log_error("Load test error: " + std::string(e.what()));
        try {
            db.update_run_status_with_retry(context->run_id, vayu::RunStatus::Failed);
        } catch (const std::exception& ex) {
            vayu::utils::log_error("Failed to update run status: " + std::string(ex.what()));
        }

        try {
            db.add_metric({0, context->run_id, now_ms(), vayu::MetricName::Completed, 1.0, ""});
        } catch (...) {
        }
    }

    context->is_running = false;
    manager.unregister_run(context->run_id);
}

void collect_metrics(std::shared_ptr<RunContext> context, vayu::db::Database* db_ptr) {
    auto& db = *db_ptr;
    auto last_update = std::chrono::steady_clock::now();
    size_t last_total = 0;

    // Get stats collection interval from config
    int stats_interval_ms =
        db_ptr->get_config_int("statsInterval", vayu::core::constants::server::STATS_INTERVAL_MS);

    while (context->is_running && !context->should_stop) {
        std::this_thread::sleep_for(std::chrono::milliseconds(stats_interval_ms));

        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration<double>(now - last_update).count();

        if (elapsed >= 1.0)  // Update every second
        {
            size_t current_total = context->total_requests();
            size_t current_errors = context->total_errors();
            size_t delta = current_total - last_total;

            double current_rps = elapsed > 0 ? static_cast<double>(delta) / elapsed : 0.0;
            double error_rate = current_total > 0 ? (static_cast<double>(current_errors) * 100.0 /
                                                     static_cast<double>(current_total))
                                                  : 0.0;

            vayu::utils::log_debug("Metrics: rps=" + std::to_string(current_rps) + ", error_rate=" +
                                   std::to_string(error_rate) + "%" + ", active=" +
                                   std::to_string(context->event_loop->active_count()) +
                                   ", sent=" + std::to_string(context->requests_sent.load()));

            // Store metrics (batched to reduce lock contention)
            try {
                auto timestamp = now_ms();
                std::vector<vayu::db::Metric> metrics;
                metrics.reserve(5);

                metrics.push_back(
                    {0, context->run_id, timestamp, vayu::MetricName::Rps, current_rps, ""});
                metrics.push_back(
                    {0, context->run_id, timestamp, vayu::MetricName::ErrorRate, error_rate, ""});
                metrics.push_back({0,
                                   context->run_id,
                                   timestamp,
                                   vayu::MetricName::ConnectionsActive,
                                   static_cast<double>(context->event_loop->active_count()),
                                   ""});
                metrics.push_back({0,
                                   context->run_id,
                                   timestamp,
                                   vayu::MetricName::RequestsSent,
                                   static_cast<double>(context->requests_sent.load()),
                                   ""});
                metrics.push_back({0,
                                   context->run_id,
                                   timestamp,
                                   vayu::MetricName::RequestsExpected,
                                   static_cast<double>(context->requests_expected.load()),
                                   ""});

                // Single transaction instead of 5 separate lock acquisitions
                db.add_metrics_batch(metrics);
            } catch (const std::exception& e) {
                // Continue on error
            }

            last_update = now;
            last_total = current_total;
        }
    }
}

}  // namespace vayu::core
