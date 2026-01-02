#pragma once

#include "vayu/http/event_loop.hpp"
#include "vayu/db/database.hpp"
#include <nlohmann/json.hpp>
#include <atomic>
#include <thread>
#include <mutex>
#include <vector>
#include <string>
#include <map>
#include <memory>

namespace vayu::core
{

    struct RunContext
    {
        std::string run_id;
        std::unique_ptr<vayu::http::EventLoop> event_loop;
        std::thread worker_thread;
        std::thread metrics_thread;
        std::atomic<bool> should_stop{false};
        std::atomic<bool> is_running{false};
        nlohmann::json config;
        int64_t start_time_ms;

        // Metrics accumulation
        std::atomic<size_t> total_requests{0};
        std::atomic<size_t> total_errors{0};
        std::atomic<double> total_latency_ms{0.0};
        std::mutex latencies_mutex;
        std::vector<double> latencies; // For percentile calculation

        RunContext(const std::string &id, nlohmann::json cfg);
        ~RunContext();
    };

    class RunManager
    {
    private:
        mutable std::mutex mutex_;
        std::map<std::string, std::shared_ptr<RunContext>> active_runs_;

    public:
        void register_run(const std::string &run_id, std::shared_ptr<RunContext> context);
        std::shared_ptr<RunContext> get_run(const std::string &run_id);
        void unregister_run(const std::string &run_id);
        size_t active_count() const;
        std::vector<std::shared_ptr<RunContext>> get_all_active_runs() const;

        // Helper to start a run
        void start_run(const std::string &run_id, const nlohmann::json &config, vayu::db::Database &db, bool verbose);
    };

    // Worker functions
    void execute_load_test(std::shared_ptr<RunContext> context, vayu::db::Database *db_ptr, bool verbose, RunManager &manager);
    void collect_metrics(std::shared_ptr<RunContext> context, vayu::db::Database *db_ptr);

} // namespace vayu::core
