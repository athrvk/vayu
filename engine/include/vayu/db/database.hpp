#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <chrono>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <sqlite_orm/sqlite_orm.h>

#include "vayu/types.hpp"

namespace vayu::db {

/**
 * Optional filters for the paginated GET /runs list. An unset field is a
 * wildcard - it does not constrain the query. `q` is a case-insensitive
 * substring matched against the stored `config_snapshot` text (via SQL LIKE);
 * it may over-match JSON keys/structure, which is acceptable for a search box.
 */
struct RunFilter {
    std::optional<RunType> type;
    std::optional<RunStatus> status;
    std::optional<std::string> request_id;
    std::optional<std::string> q;
};

class Database {
    public:
    explicit Database (const std::string& db_path);
    ~Database ();

    // Initialize database (create tables, etc.)
    void init ();

    // Project Management
    void create_collection (const Collection& c);
    std::vector<Collection> get_collections ();
    std::optional<Collection> get_collection (const std::string& id);
    void delete_collection (const std::string& id);

    void save_request (const Request& r);
    std::optional<Request> get_request (const std::string& id);
    std::vector<Request> get_requests_in_collection (const std::string& collection_id);
    void delete_request (const std::string& id);

    void save_environment (const Environment& e);
    std::vector<Environment> get_environments ();
    std::optional<Environment> get_environment (const std::string& id);
    void delete_environment (const std::string& id);

    // Globals (singleton)
    void save_globals (const Globals& g);
    std::optional<Globals> get_globals ();

    // OAuth token cache
    void save_oauth_token (const OAuthToken& t);
    std::optional<OAuthToken> get_oauth_token (const std::string& cache_key);
    void delete_oauth_token (const std::string& cache_key);

    // Execution
    void create_run (const Run& run);
    std::optional<Run> get_run (const std::string& id);
    void update_run_status (const std::string& id, RunStatus status);
    void update_run_status_with_retry (const std::string& id, RunStatus status, int max_retries = 3);
    void update_run_end_time (const std::string& id); // Update end_time without changing status
    std::vector<Run> get_all_runs ();
    // Paginated, filtered run list ordered start_time DESC (newest first) - the
    // only order the UI uses. count_runs returns the total matching @p filter
    // (ignoring limit/offset) for the pagination envelope.
    std::vector<Run> get_runs_paginated (const RunFilter& filter, int64_t limit, int64_t offset);
    int64_t count_runs (const RunFilter& filter);
    void delete_run (const std::string& id);

    // Metrics
    void add_metric (const Metric& metric);
    void add_metrics_batch (const std::vector<Metric>& metrics); // Transactional batch insert
    std::vector<Metric> get_metrics (const std::string& run_id);
    std::vector<Metric> get_metrics_since (const std::string& run_id, int64_t last_id);
    std::vector<Metric> get_metrics_paginated (const std::string& run_id, int64_t limit, int64_t offset);
    int64_t count_metrics (const std::string& run_id);

    // Results
    void add_result (const Result& result);
    void add_results_batch (const std::vector<Result>& results); // Transactional batch insert
    std::vector<Result> get_results (const std::string& run_id);

    // Config Entries - Structured configuration with metadata
    void save_config_entry (const ConfigEntry& entry);
    std::optional<ConfigEntry> get_config_entry (const std::string& key);
    std::vector<ConfigEntry> get_all_config_entries ();
    void seed_default_config (); // Initialize default config values if empty

    // Type-safe config getters (replaces ConfigManager)
    int get_config_int (const std::string& key, int default_value = 0);
    std::string get_config_string (const std::string& key,
    const std::string& default_value = "");
    bool get_config_bool (const std::string& key, bool default_value = false);
    double get_config_double (const std::string& key, double default_value = 0.0);

    private:
    struct Impl;
    std::unique_ptr<Impl> impl_;

    /**
     * @brief Run @p fn under the DB mutex, retrying on a SQLite busy/locked error.
     *
     * On a busy error the mutex is released *before* sleeping (exponential
     * backoff, @p base * (attempt+1)), then the call is retried - so a retry
     * never stalls other endpoints that need the same mutex. Non-busy
     * exceptions rethrow immediately; busy exhaustion after @p attempts logs
     * and rethrows. @p what names the operation for log messages.
     */
    void retry_on_busy (const char* what,
    int attempts,
    std::chrono::milliseconds base,
    const std::function<void ()>& fn);
};

} // namespace vayu::db
