#include "vayu/core/run_manager.hpp"

#include <algorithm>
#include <chrono>
#include <iostream>

#include "vayu/core/constants.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {
inline int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}
}  // namespace

RunContext::RunContext(const std::string& id, nlohmann::json cfg)
    : run_id(id), config(std::move(cfg)), start_time_ms(0) {}

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

    // Spawn background thread for execution
    context->worker_thread = std::thread(
        [context, &db, verbose, this]() { execute_load_test(context, &db, verbose, *this); });
    context->worker_thread.detach();

    // Spawn metrics collection thread
    context->metrics_thread = std::thread([context, &db]() { collect_metrics(context, &db); });
    context->metrics_thread.detach();
}

void execute_load_test(std::shared_ptr<RunContext> context,
                       vayu::db::Database* db_ptr,
                       bool verbose,
                       RunManager& manager) {
    context->is_running = true;
    context->start_time_ms = now_ms();

    auto& db = *db_ptr;
    const auto& config = context->config;

    try {
        // Update status to running
        db.update_run_status(context->run_id, vayu::RunStatus::Running);

        size_t concurrency = static_cast<size_t>(config.value("concurrency", 100));
        double target_rps = config.value("rps", 0.0);  // 0 = unlimited
        if (target_rps == 0.0) {
            target_rps = config.value("targetRps", 0.0);
        }
        int timeout_ms = config.value("timeout", 30000);

        // Configure EventLoop
        vayu::http::EventLoopConfig loop_config;
        loop_config.num_workers = 0;  // Auto-detect
        loop_config.max_concurrent = std::max(concurrency, size_t(100));
        loop_config.target_rps = target_rps;
        loop_config.burst_size = target_rps > 0 ? target_rps * 2.0 : 0.0;
        // Only enable curl verbose if explicitly requested in config, independent of server verbose
        // mode
        loop_config.verbose = config.value("verbose", false);

        vayu::utils::log_debug("EventLoop config: workers=auto, max_concurrent=" +
                               std::to_string(loop_config.max_concurrent) +
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

        // Stop background metrics collection to ensure COMPLETED is the last metric
        context->is_running = false;

        // Calculate final metrics
        auto test_end = std::chrono::steady_clock::now();
        double total_duration_s = std::chrono::duration<double>(test_end - test_start).count();

        size_t completed = context->total_requests.load();
        size_t errors = context->total_errors.load();
        double avg_latency = completed > 0 ? context->total_latency_ms.load() / completed : 0.0;
        double actual_rps = total_duration_s > 0 ? completed / total_duration_s : 0.0;
        double error_rate = completed > 0 ? (errors * 100.0 / completed) : 0.0;

        // Calculate percentiles
        std::vector<double> sorted_latencies;
        {
            std::lock_guard<std::mutex> lock(context->latencies_mutex);
            sorted_latencies = context->latencies;
        }
        std::sort(sorted_latencies.begin(), sorted_latencies.end());

        double p50 = 0, p95 = 0, p99 = 0;
        if (!sorted_latencies.empty()) {
            p50 = sorted_latencies[sorted_latencies.size() * 50 / 100];
            p95 = sorted_latencies[sorted_latencies.size() * 95 / 100];
            p99 = sorted_latencies[sorted_latencies.size() * 99 / 100];
        }

        // Store final summary metrics
        try {
            auto timestamp = now_ms();
            db.add_metric({0, context->run_id, timestamp, vayu::MetricName::Rps, actual_rps, ""});
            db.add_metric(
                {0, context->run_id, timestamp, vayu::MetricName::LatencyAvg, avg_latency, ""});
            db.add_metric({0,
                           context->run_id,
                           timestamp,
                           vayu::MetricName::LatencyP50,
                           p50,
                           R"({"percentile":"p50"})"});
            db.add_metric({0,
                           context->run_id,
                           timestamp,
                           vayu::MetricName::LatencyP95,
                           p95,
                           R"({"percentile":"p95"})"});
            db.add_metric({0,
                           context->run_id,
                           timestamp,
                           vayu::MetricName::LatencyP99,
                           p99,
                           R"({"percentile":"p99"})"});
            db.add_metric(
                {0, context->run_id, timestamp, vayu::MetricName::ErrorRate, error_rate, ""});
            db.add_metric({0,
                           context->run_id,
                           timestamp,
                           vayu::MetricName::TotalRequests,
                           static_cast<double>(completed),
                           ""});
            db.add_metric({0, context->run_id, timestamp, vayu::MetricName::Completed, 1.0, ""});
        } catch (const std::exception& e) {
            vayu::utils::log_error("Failed to store final metrics: " + std::string(e.what()));
        }

        // Update run status
        vayu::RunStatus final_status =
            context->should_stop ? vayu::RunStatus::Stopped : vayu::RunStatus::Completed;
        db.update_run_status(context->run_id, final_status);

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

        vayu::utils::log_error("Load test error: " + std::string(e.what()));
        try {
            db.update_run_status(context->run_id, vayu::RunStatus::Failed);
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

    while (context->is_running && !context->should_stop) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));

        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration<double>(now - last_update).count();

        if (elapsed >= 1.0)  // Update every second
        {
            size_t current_total = context->total_requests.load();
            size_t current_errors = context->total_errors.load();
            size_t delta = current_total - last_total;

            double current_rps = elapsed > 0 ? delta / elapsed : 0.0;
            double error_rate = current_total > 0 ? (current_errors * 100.0 / current_total) : 0.0;

            vayu::utils::log_debug("Metrics: rps=" + std::to_string(current_rps) + ", error_rate=" +
                                   std::to_string(error_rate) + "%" + ", active=" +
                                   std::to_string(context->event_loop->active_count()) +
                                   ", sent=" + std::to_string(context->requests_sent.load()));

            // Store metrics
            try {
                auto timestamp = now_ms();
                db.add_metric(
                    {0, context->run_id, timestamp, vayu::MetricName::Rps, current_rps, ""});
                db.add_metric(
                    {0, context->run_id, timestamp, vayu::MetricName::ErrorRate, error_rate, ""});
                db.add_metric({0,
                               context->run_id,
                               timestamp,
                               vayu::MetricName::ConnectionsActive,
                               static_cast<double>(context->event_loop->active_count()),
                               ""});
                db.add_metric({0,
                               context->run_id,
                               timestamp,
                               vayu::MetricName::RequestsSent,
                               static_cast<double>(context->requests_sent.load()),
                               ""});
                db.add_metric({0,
                               context->run_id,
                               timestamp,
                               vayu::MetricName::RequestsExpected,
                               static_cast<double>(context->requests_expected.load()),
                               ""});
            } catch (const std::exception& e) {
                // Continue on error
            }

            last_update = now;
            last_total = current_total;
        }
    }
}

}  // namespace vayu::core
