#pragma once

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "vayu/types.hpp"

namespace vayu::db {
class Database {
public:
    explicit Database(const std::string& db_path);
    ~Database();

    // Initialize database (create tables, etc.)
    void init();

    // Project Management
    void create_collection(const Collection& c);
    std::vector<Collection> get_collections();

    void save_request(const Request& r);
    std::optional<Request> get_request(const std::string& id);
    std::vector<Request> get_requests_in_collection(const std::string& collection_id);

    void save_environment(const Environment& e);
    std::vector<Environment> get_environments();
    std::optional<Environment> get_environment(const std::string& id);

    // Execution
    void create_run(const Run& run);
    std::optional<Run> get_run(const std::string& id);
    void update_run_status(const std::string& id, RunStatus status);
    std::vector<Run> get_all_runs();

    // Metrics
    void add_metric(const Metric& metric);
    std::vector<Metric> get_metrics(const std::string& run_id);
    std::vector<Metric> get_metrics_since(const std::string& run_id, int64_t last_id);

    // Results
    void add_result(const Result& result);
    void add_results_batch(const std::vector<Result>& results);  // Transactional batch insert
    std::vector<Result> get_results(const std::string& run_id);

    // Transaction helpers
    void begin_transaction();
    void commit_transaction();
    void rollback_transaction();

    // KV Store
    void set_config(const std::string& key, const std::string& value);
    std::optional<std::string> get_config(const std::string& key);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace vayu::db
