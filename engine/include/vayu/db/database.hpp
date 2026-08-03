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

    /**
     * @brief Persist a whole import in one transaction (issue #96).
     *
     * Either every row lands or none does: a bulk import that failed halfway
     * used to leave the tree half-created and depend on a best-effort
     * client-side rollback to undo it. Rows are written collections -> requests
     * -> environments so a parent exists before the rows that reference it.
     * Ids must already be assigned by the caller (`POST /import/apply` resolves
     * its temp ids first), because nothing here can look up a row that the same
     * transaction has not committed yet.
     */
    void import_apply (const std::vector<Collection>& collections,
    const std::vector<Request>& requests,
    const std::vector<Environment>& environments);

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

    /**
     * @brief Store the whole-run results summary (JSON) on the run row.
     *
     * Written once when a run reaches a terminal status; `GET /runs/:id/report`
     * reads it instead of re-reducing the time-series. A missing run is logged
     * and ignored (the run may have been deleted mid-flight), never an error.
     *
     * Retries on a busy database like the other write paths - losing this write
     * loses the run's aggregates outright, since nothing else records them.
     */
    void update_run_summary (const std::string& id, const std::string& summary);

    /**
     * @brief Prune old runs (and their cascaded metrics/results) by two limits.
     *
     * A run is a victim when it falls beyond @p max_runs most-recent runs
     * (ordered by start_time) OR its start_time is older than @p max_age_days.
     * Either limit is disabled by passing 0. Runs still `running`/`pending` are
     * never pruned and never count toward @p max_runs. Deletion goes through the
     * `delete_run` cascade in start_time-batched transactions, releasing the DB
     * mutex between batches so a large backlog cannot stall other endpoints.
     */
    void prune_runs (int max_runs, int max_age_days);

    /**
     * @brief Prune runs using the configured `maxRunsRetained` /
     * `runRetentionDays` knobs. Called at startup and after a run reaches a
     * terminal status.
     */
    void prune_runs_configured ();

    /**
     * @brief Mark runs left `running`/`pending` by a previous process as failed.
     *
     * A crash or a kill abandons in-flight runs with no terminal status write,
     * so `GET /runs` keeps reporting them as running forever. A graceful
     * shutdown is not one of those paths - `RunManager::shutdown` stops and
     * joins every worker, which writes the terminal status. Called from
     * `init()` - before the sweeper and the HTTP server start - so no live run
     * can be caught by it.
     *
     * @return Number of rows reconciled.
     */
    size_t reconcile_orphaned_runs ();

    // Metric ticks - one wide row per tick; the current time-series storage.
    void add_metric_tick (const MetricTick& tick);
    // Ordered (timestamp, id) so a page boundary never splits a tick.
    std::vector<MetricTick> get_metric_ticks_paginated (const std::string& run_id, int64_t limit, int64_t offset);
    std::vector<MetricTick> get_metric_ticks_since (const std::string& run_id, int64_t last_id);
    int64_t count_metric_ticks (const std::string& run_id);

    // Results
    void add_result (const Result& result);
    /**
     * @brief Transactional batch insert of a run's sampled results, optionally
     *        with the response bodies captured alongside them.
     *
     * `bodies` refer to results by index (`PendingResultBody::result_index`),
     * because the row ids only exist once the insert has run. Results, the
     * deduplicated blobs and the per-result body rows all land in one
     * transaction, so a crash mid-flush cannot leave a body row pointing at a
     * result that was rolled back.
     *
     * Bodies are deduplicated by `body_hash` within this call: identical
     * responses - the norm for a load test - share one `body_blobs` row.
     */
    void add_results_batch (const std::vector<Result>& results,
    const std::vector<PendingResultBody>& bodies = {});
    std::vector<Result> get_results (const std::string& run_id);

    // Captured response bodies for a run's sampled results. Deliberately not
    // reachable from get_results: the report path loads and parses every
    // result row for a run, and this is exactly the data it must not pay for.
    std::vector<ResultBody> get_result_bodies_paginated (const std::string& run_id,
    int64_t limit,
    int64_t offset);
    int64_t count_result_bodies (const std::string& run_id);
    /// The stored bytes of a blob, or `""` when the id is 0 or unknown.
    std::string get_body_blob_content (int blob_id);

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
     * @brief Delete a run and every child row it owns (ticks, metrics, results).
     *
     * The single definition of the run cascade - `delete_run` and `prune_runs`
     * both call it, so a new child table is wired into both by editing one
     * function. The caller must already hold the DB mutex.
     */
    void remove_run_cascade_locked (const std::string& id);

    /**
     * @brief Clear `is_active` on every environment except @p keep_id.
     *
     * The single definition of "at most one environment is active" - every
     * write path that can store an active environment calls it, so the
     * invariant cannot be enforced on one path and forgotten on another. The
     * caller must already hold the DB mutex and be inside a transaction:
     * deactivating the previous environment and activating the new one is one
     * atomic switch, never a window in which two or zero are active.
     */
    void deactivate_other_environments_locked (const std::string& keep_id);

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
