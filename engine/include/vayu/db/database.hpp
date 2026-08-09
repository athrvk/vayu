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
#include <stdexcept>
#include <string>
#include <unordered_map>
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

/**
 * The narrow outcome of a design run's single exchange: what came back and how
 * long it took, and nothing else.
 *
 * Deliberately not `Result`. The paginated GET /runs list reads this for a
 * whole page of rows at once, and a `Result` carries `trace_data` - the entire
 * exchange, request and response bodies included - which would turn a list page
 * into megabytes for a readout of two numbers.
 */
struct DesignResultOutcome {
    int status_code;
    double latency_ms;
};

/**
 * Thrown by `apply_reorder` when a row it was told to write is not stored at
 * commit time. The batch is rolled back whole, and the row stays deleted.
 *
 * A reorder only ever repositions rows that already exist, so a missing one is
 * never something to create: the previous `replace` would have resurrected a
 * row a concurrent cascade had just deleted, silently, inside an endpoint whose
 * contract is "all or nothing". The message names the row so the 409 the
 * `/reorder` route turns this into is actionable.
 */
class MissingRowError : public std::runtime_error {
    public:
    MissingRowError (const std::string& kind, const std::string& id)
    : std::runtime_error (kind + " '" + id + "' no longer exists") {
    }
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

    /**
     * @brief Persist a whole batch reorder in one transaction (issue #365).
     *
     * The rows carry positions (and, for a move, owners) that the caller has
     * already validated against each other; either every one lands or none
     * does. A reorder expressed as N sibling `PUT`s could be interrupted
     * halfway, leaving a parent with two rows at the same `order` and a gap
     * where the moved one used to be - a shape no read repairs, because the tie
     * rule then decides the display order.
     *
     * Every row is **updated, never inserted**: one that is not stored at
     * commit time throws `MissingRowError` and rolls the batch back (issue
     * #386). Repositioning is by definition an operation on existing rows, so
     * an insert here could only ever be a resurrection.
     *
     * Separate from `import_apply` despite the shared shape: this writes rows
     * that already exist and must not touch environments, and the two callers
     * validate entirely different things beforehand.
     */
    void apply_reorder (const std::vector<Collection>& collections,
    const std::vector<Request>& requests);

    /**
     * @brief Run @p fn with the DB mutex held for the whole of it (issue #386).
     *
     * Every other method here takes the lock per call, which is enough while a
     * write depends only on its own arguments. It is not enough for a composite
     * that *reads, decides, then writes*: `POST /reorder` validates a batch
     * against the stored graph and only then commits it, and between those two
     * steps another client's write can move the ground - two reparents that are
     * each legal alone both commit and leave a cycle, or a create computes
     * `max_order + 1` inside the range the batch is renumbering. Wrapping the
     * whole composite makes the validation the write is based on still true
     * when the write lands.
     *
     * The mutex is recursive, so @p fn may call any method on this Database.
     * Hold it only for a bounded composite: everything else serializing on this
     * lock - `/health`, the runs poll, SSE - waits for the whole of @p fn.
     */
    void with_lock (const std::function<void ()>& fn);

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
    /**
     * @brief Status code and latency for a page of **design** runs, in one query.
     *
     * The paginated GET /runs list attaches each design run's outcome to its
     * row (`resultSummary`), the way GET /runs/:id attaches the whole exchange.
     * Three properties make that affordable, and all three are why this is not
     * `get_results` in a loop:
     *
     * - Two columns, so `trace_data` is never read.
     * - One statement for the whole page, so a page of 50 is one query.
     * - The statement itself only ever matches results whose run is a design
     *   run, so a load run's unbounded error rows cannot be pulled - by the
     *   query, not by the caller remembering to filter (the guard at
     *   GET /runs/:id is a caller-side one, and it has to be).
     *
     * A run with no result row yet (still running, or one whose write failed)
     * is absent from the map rather than present with zeroes - "no outcome
     * recorded" and "HTTP 0 in 0ms" are different answers.
     */
    std::unordered_map<std::string, DesignResultOutcome>
    get_design_result_outcomes (const std::vector<std::string>& run_ids);

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
