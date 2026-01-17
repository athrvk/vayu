#pragma once

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <sqlite_orm/sqlite_orm.h>

#include "vayu/core/constants.hpp"
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
    std::optional<Collection> get_collection(const std::string& id);
    void delete_collection(const std::string& id);

    void save_request(const Request& r);
    std::optional<Request> get_request(const std::string& id);
    std::vector<Request> get_requests_in_collection(const std::string& collection_id);
    
    /**
     * @brief Iterate over requests in a collection using a callback.
     * This allows streaming without loading all requests into memory.
     * Fetches requests in batches to minimize memory usage.
     * @param collection_id The collection ID to fetch requests from
     * @param callback Function called for each request. Return false to stop iteration.
     */
    template <typename Callback>
    void iterate_requests_in_collection(const std::string& collection_id, Callback&& callback) {
        // Get batch size from config (or use default constant)
        const size_t batch_size = static_cast<size_t>(
            get_config_int(
                "requestBatchSize",
                vayu::core::constants::db_streaming::REQUEST_BATCH_SIZE));

        // Fetch in batches to avoid loading everything into memory at once
        size_t offset = 0;
        
        while (true) {
            // Get all requests using helper that can access impl_
            auto all_requests = _get_all_requests_for_collection(collection_id);
            
            // Process only the current batch
            size_t start_idx = offset;
            size_t end_idx = std::min(start_idx + batch_size, all_requests.size());
            
            if (start_idx >= all_requests.size()) {
                break;
            }
            
            // Process batch
            for (size_t i = start_idx; i < end_idx; ++i) {
                if (!callback(all_requests[i])) {
                    return;  // Callback requested to stop
                }
            }
            
            offset = end_idx;
            if (end_idx >= all_requests.size()) {
                break;
            }
        }
    }
    
    void delete_request(const std::string& id);

    void save_environment(const Environment& e);
    std::vector<Environment> get_environments();
    std::optional<Environment> get_environment(const std::string& id);
    void delete_environment(const std::string& id);

    // Globals (singleton)
    void save_globals(const Globals& g);
    std::optional<Globals> get_globals();

    // Execution
    void create_run(const Run& run);
    std::optional<Run> get_run(const std::string& id);
    void update_run_status(const std::string& id, RunStatus status);
    void update_run_status_with_retry(const std::string& id, RunStatus status, int max_retries = 3);
    void update_run_end_time(const std::string& id);  // Update end_time without changing status
    std::vector<Run> get_all_runs();
    void delete_run(const std::string& id);

    // Metrics
    void add_metric(const Metric& metric);
    void add_metrics_batch(const std::vector<Metric>& metrics);  // Transactional batch insert
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

    // Config Entries - Structured configuration with metadata
    void save_config_entry(const ConfigEntry& entry);
    std::optional<ConfigEntry> get_config_entry(const std::string& key);
    std::vector<ConfigEntry> get_all_config_entries();
    void seed_default_config();  // Initialize default config values if empty

    // Type-safe config getters (replaces ConfigManager)
    int get_config_int(const std::string& key, int default_value = 0);
    std::string get_config_string(const std::string& key, const std::string& default_value = "");
    bool get_config_bool(const std::string& key, bool default_value = false);
    double get_config_double(const std::string& key, double default_value = 0.0);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    
    // Helper function to get all requests (non-template, can access impl_)
    std::vector<Request> _get_all_requests_for_collection(const std::string& collection_id);
};

}  // namespace vayu::db
