#pragma once

#include <atomic>
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
    std::atomic<bool> should_stop{false};
    std::atomic<bool> is_running{false};
    nlohmann::json config;
    int64_t start_time_ms;

    // Test script for deferred validation
    std::string test_script;

    // High-performance in-memory metrics collector
    // Replaces direct DB writes for individual results during load tests
    std::unique_ptr<MetricsCollector> metrics_collector;

    // Real-time counters (also tracked by MetricsCollector, but kept for backward compat)
    std::atomic<size_t> requests_sent{0};      // Number of requests submitted to event loop
    std::atomic<size_t> requests_expected{0};  // Total expected requests for this run

    // Legacy accessors for backward compatibility (delegate to metrics_collector)
    [[nodiscard]] size_t total_requests() const {
        return metrics_collector ? metrics_collector->total_requests() : 0;
    }
    [[nodiscard]] size_t total_errors() const {
        return metrics_collector ? metrics_collector->total_errors() : 0;
    }
    [[nodiscard]] double total_latency_ms() const {
        return metrics_collector ? metrics_collector->total_latency_sum() : 0.0;
    }

    RunContext(const std::string& id, nlohmann::json cfg);
    ~RunContext();
};

class RunManager {
private:
    mutable std::mutex mutex_;
    std::map<std::string, std::shared_ptr<RunContext>> active_runs_;

public:
    void register_run(const std::string& run_id, std::shared_ptr<RunContext> context);
    std::shared_ptr<RunContext> get_run(const std::string& run_id);
    void unregister_run(const std::string& run_id);
    size_t active_count() const;
    std::vector<std::shared_ptr<RunContext>> get_all_active_runs() const;

    // Helper to start a run
    void start_run(const std::string& run_id,
                   const nlohmann::json& config,
                   vayu::db::Database& db,
                   bool verbose);
};

// Worker functions
void execute_load_test(std::shared_ptr<RunContext> context,
                       vayu::db::Database* db_ptr,
                       bool verbose,
                       RunManager& manager);
void collect_metrics(std::shared_ptr<RunContext> context, vayu::db::Database* db_ptr);

}  // namespace vayu::core
