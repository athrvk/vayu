#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <chrono>
#include <cstdint>
#include <expected>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <sqlite_orm/sqlite_orm.h>

#include "vayu/db/recovery.hpp"
#include "vayu/types.hpp"

namespace vayu::db {

/**
 * @brief A TEXT column's bytes as the `const char*` every caller wants.
 *
 * `sqlite3_column_text` answers with `const unsigned char*` and nothing in this
 * engine consumes one: the value goes straight into a `std::string`, a
 * `std::string_view` or a parser that reads characters. Eight call sites - the
 * enum adapters in `database.cpp` and the schema assertions in `db_test.cpp` -
 * each spelled that conversion themselves, three of them as a C-style cast, and
 * a copy of a primitive does not receive the primitive's fixes.
 *
 * Reading bytes through a character type is what [basic.lval] permits outright,
 * which is why the cast is a NOLINT rather than a defect - written once here so
 * nothing has to argue it again.
 *
 * A SQL NULL comes back as `nullptr`, exactly as the C API reports it: the
 * distinction between an absent value and an empty string belongs to the
 * caller, and defaulting it here would erase it silently.
 */
inline const char* column_text (sqlite3_stmt* stmt, int column_index) {
    // [basic.lval] permits reading any object through a character type; see
    // the note above for why that makes this a NOLINT and not a defect.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    return reinterpret_cast<const char*> (sqlite3_column_text (stmt, column_index));
}

/**
 * Optional filters for the paginated GET /runs list. An unset field is a
 * wildcard - it does not constrain the query. `q` is a case-insensitive
 * substring matched against the stored `config_snapshot` text (via SQL LIKE);
 * it may over-match JSON keys/structure, which is acceptable for a search box.
 *
 * `collection_id` is the exact opposite of `q` and deliberately so: it reads
 * `scenario.collectionId` out of the snapshot as JSON, so it matches the field
 * and never the text around it. Only a scenario run's snapshot carries that
 * path, which is what makes design and load runs unmatchable rather than merely
 * unlikely to match.
 */
struct RunFilter {
    std::optional<RunType> type;
    std::optional<RunStatus> status;
    std::optional<std::string> request_id;
    std::optional<std::string> q;
    std::optional<std::string> collection_id;
    // `true` lists only pinned baselines, `false` only unpinned ones. Both are
    // real questions - "which run is the baseline for this request" is the
    // first, and it is what a client resolves before diffing against it.
    std::optional<bool> baseline;
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
 * @brief One thing the user deleted, as the trash lists it (issue #988).
 *
 * A *root* only: the row the user asked to delete, never the descendants that
 * went with it. What a cascade took is the two counts, because that is the
 * question a trash view asks ("restoring this brings back what?") and listing
 * every stamped row would answer a different one.
 */
struct TrashEntry {
    std::string id;
    /// "collection" or "request" - the two tables the trash spans, so a client
    /// knows which shape it is looking at without a second read.
    std::string kind;
    std::string name;
    /// When the delete ran, in Unix ms. Also the cohort key - see
    /// `Collection::deleted_at`.
    int64_t deleted_at = 0;
    /// The collection this row hung under: a collection's parent (absent at the
    /// tree root), a request's owning collection (always present).
    std::optional<std::string> parent_id;
    /// Descendants *this delete* took with it - the cohort, and therefore
    /// exactly what a restore puts back. A purge may take more (a row an
    /// earlier delete left inside the same subtree), which is the one place
    /// these counts are a floor rather than the whole. Both 0 for a request.
    int64_t collections = 0;
    int64_t requests    = 0;
};

/// What a restore or a purge acted on - the entry as it was, plus whether the
/// restore had to re-parent it (issue #988).
struct TrashOutcome {
    TrashEntry entry;
    /// True when the restored collection's parent was gone or itself deleted,
    /// so the row came back at the tree root instead. Always false for a purge.
    bool reparented = false;
};

/// Why a restore did not happen. `NotFound` is a 404 - nothing in the trash
/// carries that id; `OwnerGone` is a 409 - a request whose collection is itself
/// deleted or missing, which has no root to come back to.
enum class RestoreRefusal : std::uint8_t { NotFound, OwnerGone };

/// A refused restore, as the route reports it (issue #988).
struct RestoreFailure {
    RestoreRefusal reason = RestoreRefusal::NotFound;
    std::string message;
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

/**
 * @brief One OpenAPI sync, as the rows it writes (issue #655).
 *
 * A sync is the one write in Vayu that creates, updates *and* deletes at once,
 * and it must be all-or-nothing for a reason the other batch writers do not
 * share: half of it leaves a collection bound to a document its requests do not
 * reflect, which is precisely the state binding exists to make impossible. So
 * the whole of it - the new document, the moved binding, the rows - is one
 * transaction rather than a sequence the client stitches together.
 *
 * Ids are assigned by the caller, like `import_apply`: nothing here can look up
 * a row the same transaction has not committed yet.
 *
 * **`POST /specs/bind` writes through this too** (issue #862), filling only
 * @ref spec, @ref binding and @ref updated: a bind stores a document, moves the
 * binding and rewrites the identity column of the requests beneath it, which is
 * this batch with its create and delete halves empty. It shares the transaction
 * rather than owning a second one because the state a half-applied bind leaves
 * is the same state described above, and one transaction cannot come to
 * disagree with another about what "all of it" means.
 */
struct SpecSyncBatch {
    /// The re-fetched document. A new row, never a rewrite - see `SpecDocument`.
    SpecDocument spec;
    /// The bound collection with `openapi` already moved to @ref spec. Updated,
    /// never inserted: a sync of a collection that no longer exists is a
    /// `MissingRowError`, not a resurrection.
    Collection binding;
    /// Tag folders an added operation needs and the collection does not have.
    std::vector<Collection> new_collections;
    std::vector<Request> created;
    /// Updated, never inserted, on `apply_reorder`'s rule and for its reason.
    std::vector<Request> updated;
    /// Request ids to delete. Their examples cascade, as `delete_request` does.
    std::vector<std::string> deleted;
    /// Example rows to insert - a created request's, and the imported ones a
    /// refreshed request's replace.
    std::vector<RequestExample> examples;
    /// The imported example rows @ref examples replaces. Ids, because the row
    /// they name is stored and only its identity matters here.
    std::vector<std::string> deleted_examples;
};

/**
 * @brief One workspace snapshot, as `POST /workspace/backup` reports it
 *        (issue #987).
 *
 * The path is absolute wherever the engine's own database path is, which is
 * every real start - the daemon is given a data directory - and it is what the
 * user needs, because restoring is a file copy they perform themselves.
 */
struct BackupRecord {
    /// The snapshot written, as a path the user can act on.
    std::string path;
    /// Its size on disk. A compacted copy, so smaller than the live file.
    int64_t size_bytes = 0;
    /// The stamp its file name carries - the caller's clock, in Unix ms.
    int64_t created_at = 0;
    /// How many older snapshots retention removed in the same call.
    int64_t pruned = 0;
};

/**
 * @brief Why a workspace backup did not happen (issue #987).
 *
 * The two cases answer with different statuses and read differently to a user,
 * so they are one type with a flag rather than a message a route has to parse:
 * a refused *concurrent* backup is a 409 and nothing is wrong, while anything
 * else is a 500 naming what SQLite or the filesystem refused.
 */
struct BackupFailure {
    /// Another backup holds the slot; nothing was written.
    bool already_running = false;
    /// What went wrong, in the words the caller prints.
    std::string message;
};

class Database {
    public:
    explicit Database (const std::string& db_path);
    ~Database ();

    // Neither copyable nor movable: the handle behind the pImpl owns the open
    // SQLite connection and the mutex every write is serialized on, and every
    // holder in the engine keeps it in place (a stack local in `daemon.cpp`, a
    // `unique_ptr` in the fixtures). A move would leave a hollow instance whose
    // methods still compile.
    Database (const Database&)            = delete;
    Database& operator= (const Database&) = delete;
    Database (Database&&)                 = delete;
    Database& operator= (Database&&)      = delete;

    // Initialize database (create tables, etc.)
    void init ();

    /**
     * @brief The database file this instance was opened on.
     *
     * The engine's data directory, effectively: files derived from settings
     * are written beside it (the CA bundle `resolve_transport_policy`
     * materializes, issue #706) so that a caller holding a `Database` needs no
     * second path parameter threaded through it to find them.
     */
    const std::string& path () const;

    /**
     * @brief What this startup did about a database it could not open, if it
     *        had to do anything (issue #922).
     *
     * `nullopt` is a clean start - the ordinary case, and the one a genuine
     * first run gives. A value means the user's data was restored from a backup
     * or deleted outright, and it is what `GET /health` reports so the app can
     * say so; see `db/recovery.hpp` for why the fact is on disk and why it is
     * never cleared here.
     *
     * Read once at construction, so the polled health endpoint costs no file
     * access.
     */
    [[nodiscard]] const std::optional<RecoveryRecord>& recovery () const;

    // Project Management
    void create_collection (const Collection& c);
    /// Live collections only - a deleted one is gone to every reader but the
    /// trash (issue #988).
    std::vector<Collection> get_collections ();
    /// Live only, like `get_collections` - a deleted row reads as absent, which
    /// is what turns every by-id route into its own 404 (issue #988).
    std::optional<Collection> get_collection (const std::string& id);
    /// Stamps the collection and its whole subtree as deleted rather than
    /// removing them (issue #988). `GET /trash` lists it, restore puts it back
    /// and purge is what finally destroys it.
    void delete_collection (const std::string& id);

    void save_request (const Request& r);
    /// Live only - see `get_collection` (issue #988).
    std::optional<Request> get_request (const std::string& id);
    /// Live only, and empty for a deleted collection (issue #988).
    std::vector<Request> get_requests_in_collection (const std::string& collection_id);
    /// Stamps the request as deleted (issue #988). Its examples stay on the
    /// row - nothing can read them while the request is stamped, and a purge
    /// takes them with it.
    void delete_request (const std::string& id);

    // Trash - what soft delete left behind (issue #988)

    /// Every deleted root, newest first. A root is a stamped row whose owner is
    /// *not* stamped: the thing the user deleted, never what its cascade took.
    std::vector<TrashEntry> get_trash ();

    /**
     * @brief Put a deleted row, and everything its delete took with it, back.
     *
     * Restores the *cohort*: the stamped subtree rows carrying this row's own
     * `deleted_at`. A row deleted separately and earlier keeps its stamp, so
     * restoring a collection cannot resurrect a request the user deleted before
     * it - it becomes a trash root of its own again instead.
     *
     * A collection whose parent is gone or itself deleted comes back at the tree
     * root (`parent_id` cleared) - the rule the issue names, and the only place
     * a restore rewrites anything but the stamp.
     */
    std::expected<TrashOutcome, RestoreFailure> restore_deleted (const std::string& id);

    /**
     * @brief Destroy a deleted row for good - the hard cascade soft delete
     *        replaced.
     *
     * Takes the whole subtree, stamp or no stamp, because a row left under a
     * removed collection is reachable by no read and restorable by nothing.
     * `nullopt` when no *deleted* row carries that id: purging a live row is
     * not something this endpoint can be asked for by accident.
     */
    std::optional<TrashOutcome> purge_deleted (const std::string& id);

    /**
     * @brief Purge everything deleted longer ago than @p retention_days.
     *
     * @param retention_days 0 keeps the trash forever - the same reading
     *        `maxRunsRetained` and `runRetentionDays` give 0.
     * @param now the caller's clock in Unix ms, so a test can state the age it
     *        is asking about rather than sleep for it.
     * @return how many roots were purged.
     */
    int64_t purge_expired_trash (int retention_days, int64_t now);

    /// `purge_expired_trash` with the configured `trashRetentionDays` and the
    /// system clock - what startup runs (issue #988).
    int64_t purge_expired_trash_configured ();

    // Saved example responses, owned by a request (issue #481). Every read is
    // by request id or by example id; there is no all-examples query, because
    // an example only means anything next to the request it answers.

    void save_request_example (const RequestExample& e);
    /// A suppressed row reads as absent - see the definition (issue #722).
    std::optional<RequestExample> get_request_example (const std::string& id);
    /// Oldest first (created_at, then id) - the order a mock server resolves
    /// "the first example" in, so it is a contract rather than a detail.
    /// Excludes tombstones, so a deleted imported example is gone to every
    /// reader (issue #722).
    std::vector<RequestExample> get_request_examples (const std::string& request_id);
    /// The tombstones only - deleted imported examples, which exist so a spec
    /// sync does not write back what the user removed (issue #722).
    std::vector<RequestExample> get_suppressed_request_examples (const std::string& request_id);
    int64_t count_request_examples (const std::string& request_id);
    void delete_request_example (const std::string& id);
    /// Keeps an imported example's row as a tombstone instead of removing it
    /// (issue #722). `now` is the caller's clock, as every other write here.
    void suppress_request_example (const std::string& id, int64_t now);

    // OpenAPI documents (issue #637). Bound by collections rather than owned by
    // one, so nothing here cascades: `delete_spec_document` is only ever reached
    // once the route has proven no collection still names the id.

    void save_spec_document (const SpecDocument& s);
    std::optional<SpecDocument> get_spec_document (const std::string& id);
    /**
     * @brief The collections whose `openapi` binding names @p spec_id.
     *
     * A scan rather than an index: the binding lives inside a JSON blob, so
     * there is no column to index, and the collections table is the small,
     * sidebar-sized one. Its callers are the delete refusal and nothing on a
     * request's hot path.
     *
     * Empty means the spec is bound by nobody, which is the only state
     * `delete_spec_document` may be called in.
     */
    std::vector<Collection> get_collections_bound_to_spec (const std::string& spec_id);
    void delete_spec_document (const std::string& id);

    /**
     * @brief Reclaim documents nothing can reach any more, returning how many
     *        went (issue #718).
     *
     * Nothing owns a `spec_documents` row, which is what leaves it with no
     * cascade to die by: every sync mints a new document and moves the binding
     * off the old one, unbinding leaves it, re-binding mints another, and
     * deleting the bound collection takes its requests and not the document. A
     * year of weekly syncs of a 12 MB document therefore strands ~600 MB of
     * rows no route can even enumerate, since `DELETE /specs/:id` needs an id
     * and there is no list route to get one from.
     *
     * **The lifetime rule this implements**, and the only one: a document lives
     * while a collection binds it, or while a *retained run* names it in
     * `runs.config_snapshot`. The second half is what makes the sweep safe to
     * run beside retention rather than instead of it - a scenario run stamps
     * the `specId` it planned against, and its report's coverage describes a
     * contract the reader may still want to see the source of. So a document
     * outlives the binding that made it by exactly as long as the runs that
     * used it, and goes with the last of them. That is also why the first of
     * the three callers is `prune_runs_configured`: the pass that *releases*
     * run references is the one that should look for what they were holding,
     * and hanging the sweep there puts it on a startup and on the end of every
     * run without a schedule of its own. The other two are `spec_sync_apply`
     * (the accretion source) and `delete_collection` (a binder going away).
     *
     * A document written within `SPEC_DOCUMENT_SWEEP_GRACE_MS` is spared
     * whatever else it looks like - see that constant for the bind-in-flight
     * window it exists for.
     *
     * **Never throws.** All three callers reach it as the tail of an operation
     * whose success does not depend on it (a startup, a sync, a collection
     * delete), so a failure here is logged and swallowed rather than turned
     * into a failed sync. Cheap when there is nothing to do, which is what
     * riding on every run completion requires: it asks the three questions
     * cheapest-first and stops at the first that leaves nothing at stake, so
     * the ordinary case never reads the runs table - and no path reads
     * `content`.
     */
    size_t sweep_orphaned_spec_documents ();

    /**
     * @brief Repair bindings stored without the document version they name
     *        (issue #709), returning how many were stamped.
     *
     * Until #709 the import path - which produces nearly every binding - wrote
     * `{specId}` alone, and contract coverage and response-schema validation
     * both require the binding's `specHash` to agree with the stored document,
     * so every run of an imported collection reported no contract at all. The
     * write paths stamp now; these are the rows written before they did.
     *
     * Safe by construction: a hashless binding can only have come from an
     * import, and that import stored exactly the document the binding names, so
     * the document's current hash *is* the version it was bound to. A binding
     * naming a document this database no longer holds is left untouched - there
     * is nothing to stamp it from, and a run says so already.
     *
     * Idempotent, and run at startup beside the other repair passes rather than
     * behind a one-shot migration flag: a stamped binding is skipped on the
     * next start, so the pass costs one scan of the sidebar-sized table.
     */
    int64_t stamp_hashless_spec_bindings ();

    /**
     * @brief Drop the header rows a pre-#1229 client saved into stored
     *        requests, and answer how many requests were rewritten.
     *
     * The renderer used to write `X-Vayu-Version` and a fresh `X-Request-ID`
     * into the request document at save time, so every consumer of a stored
     * request - a load run, a collection run, an MCP send, an export, a
     * generated snippet - reproduced one saved day's version string and
     * replayed one frozen correlation id. The engine owns those headers now
     * and adds them at send time, which fixes what is sent from here on and
     * nothing that was already written down; this pass is the "already
     * written down" half.
     *
     * Which rows go and why each rule is narrow:
     * `http/default_headers.hpp`'s `strip_legacy_managed_headers`, which is the
     * decision, so it can be read - and tested - without a database.
     *
     * Idempotent, and run at startup beside the other repair passes for the
     * reason `stamp_hashless_spec_bindings` is: a stripped request is skipped
     * on the next start, so the pass costs one scan of a sidebar-sized table.
     * Deleted rows are rewritten too, so a request restored from the trash
     * afterwards does not bring the stale headers back with it.
     */
    int64_t strip_stored_managed_headers ();

    /**
     * @brief Persist a whole import in one transaction (issue #96).
     *
     * Either every row lands or none does: a bulk import that failed halfway
     * used to leave the tree half-created and depend on a best-effort
     * client-side rollback to undo it. Rows are written collections -> requests
     * -> examples -> environments so a parent exists before the rows that
     * reference it.
     * Ids must already be assigned by the caller (`POST /import/apply` resolves
     * its temp ids first), because nothing here can look up a row that the same
     * transaction has not committed yet.
     */
    void import_apply (const std::vector<Collection>& collections,
    const std::vector<Request>& requests,
    const std::vector<Environment>& environments,
    const std::vector<RequestExample>& examples = {},
    const std::vector<SpecDocument>& specs      = {});

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
     * @brief Persist a whole OpenAPI sync in one transaction (issue #655).
     *
     * Separate from `import_apply` for the reason `apply_reorder` is: this one
     * writes rows that already exist and deletes rows the caller named, and an
     * upsert on either would be a resurrection of something a concurrent delete
     * removed. `SpecSyncBatch::binding` and every row in `updated` must be
     * stored at commit time, or the batch throws `MissingRowError` and rolls
     * back whole - the route turns that into a 409, because the ground the diff
     * was computed against has moved.
     *
     * A named `deleted` request that is already gone is *not* an error: the
     * sync asked for it to not be there, and it is not. Its examples are
     * removed with it either way, the same cascade `delete_request` performs.
     */
    void spec_sync_apply (const SpecSyncBatch& batch);

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

    /**
     * Client-certificate registry (issue #707). Plain CRUD: the routes own
     * validation and the uniqueness rule, because both belong to the one place
     * that can answer with a status code.
     *
     * `get_client_certificates` is read once per resolved transport policy -
     * per design send, and *once per run* on the load and collection paths -
     * never per transfer; see `vayu::http::resolve_transport_policy`.
     */
    void save_client_certificate (const ClientCertificate& c);
    std::vector<ClientCertificate> get_client_certificates ();
    std::optional<ClientCertificate> get_client_certificate (const std::string& id);
    void delete_client_certificate (const std::string& id);

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
    std::vector<Run>
    get_runs_paginated (const RunFilter& filter, int64_t limit, int64_t offset);
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
     * @brief Pin (or unpin) a run as a baseline, returning the stored row.
     *
     * `std::nullopt` means no run has that id - the route's 404. Several runs
     * may be pinned at once: the engine records the pin and nothing more, and
     * which baseline applies to a given run is the client's choice (per
     * request, per endpoint), so no write here unpins anything else.
     */
    std::optional<Run> set_run_baseline (const std::string& id, bool baseline);

    /**
     * @brief Prune old runs (and their cascaded metrics/results) by two limits.
     *
     * A run is a victim when it falls beyond @p max_runs most-recent runs
     * (ordered by start_time) OR its start_time is older than @p max_age_days.
     * Either limit is disabled by passing 0. Runs still `running`/`pending` are
     * never pruned and never count toward @p max_runs, and neither is a run
     * pinned as a baseline (`Run::baseline`). Deletion goes through the
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
    std::vector<MetricTick>
    get_metric_ticks_paginated (const std::string& run_id, int64_t limit, int64_t offset);
    std::vector<MetricTick> get_metric_ticks_since (const std::string& run_id, int64_t last_id);
    int64_t count_metric_ticks (const std::string& run_id);

    // Monitor samples - one wide row per scrape of a run's configured
    // server-vitals endpoint. Deliberately not part of `metric_ticks`: that
    // payload's key set is the GET /runs/:id/metrics contract.
    void add_monitor_sample (const MonitorSample& sample);
    // Ordered (timestamp, id) so a page boundary never splits a sample.
    std::vector<MonitorSample>
    get_monitor_samples_paginated (const std::string& run_id, int64_t limit, int64_t offset);
    int64_t count_monitor_samples (const std::string& run_id);

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
    std::vector<ResultBody>
    get_result_bodies_paginated (const std::string& run_id, int64_t limit, int64_t offset);
    int64_t count_result_bodies (const std::string& run_id);
    /// The stored bytes of a blob, or `""` when the id is 0 or unknown.
    std::string get_body_blob_content (int blob_id);

    // Webhook inbox captures (issue #480). The inbox itself is process-lifetime
    // state on InboxManager; only what it captured is stored, and only so a
    // long-running listener's capture list is paged off disk rather than held
    // on the heap.

    /**
     * @brief Append one capture and trim the inbox back to @p max_captures.
     *
     * Insert and trim are one transaction: a capture list that briefly held
     * 501 rows would be harmless, but a trim that ran without its insert (or
     * the reverse) would drop a capture the caller was told had landed. The
     * oldest rows go first, by `id` - the insertion order, which for an
     * append-only table is also the arrival order, and unlike `received_at`
     * cannot tie.
     *
     * @return the id assigned to the stored capture.
     */
    int add_inbox_request (const InboxRequest& capture, int64_t max_captures);

    /// Newest first - the order the capture list reads in.
    std::vector<InboxRequest>
    get_inbox_requests_paginated (const std::string& inbox_id, int64_t limit, int64_t offset);
    int64_t count_inbox_requests (const std::string& inbox_id);
    /// Captures with `id` greater than @p last_id, oldest first (the live poll).
    std::vector<InboxRequest>
    get_inbox_requests_since (const std::string& inbox_id, int64_t last_id);
    /// @return how many rows were removed.
    int64_t clear_inbox_requests (const std::string& inbox_id);
    /**
     * @brief Drop every capture, for every inbox. Called from `init()`.
     *
     * An inbox is process-lifetime, so after a restart no row here has an inbox
     * that could list it - they would be unreachable bytes growing with every
     * session. Same reasoning as `reconcile_orphaned_runs`: the previous
     * process's leftovers are reconciled before anything can read them.
     */
    int64_t clear_inbox_requests_all ();

    // Workspace backup (issue #987)

    /**
     * @brief Where snapshots are written - `backups/` beside the database file.
     *
     * Derived from @ref path rather than threaded through as a second
     * parameter, on the rule that directory already carries (the CA bundle
     * `resolve_transport_policy` materializes is a sibling for the same
     * reason): a caller holding a `Database` knows where the workspace lives.
     */
    [[nodiscard]] std::string backups_directory () const;

    /**
     * @brief Write one consistent, compacted snapshot of this workspace and
     *        prune older ones to `maxBackupsRetained`.
     *
     * SQLite's `VACUUM INTO` rather than a file copy: copying the database file
     * out from under a running engine is not safe under WAL - the `-wal` holds
     * committed transactions the main file does not - while `VACUUM INTO` reads
     * one snapshot and writes a defragmented database that is complete on its
     * own. It is read-only with respect to the workspace, so nothing here can
     * cost the user the data it is copying.
     *
     * @param now The caller's clock, in Unix ms. It names the file, so a test
     *        can state which snapshot it is asking for; a stamp already taken
     *        is stepped over rather than written through, exactly as the
     *        corruption quarantine does.
     *
     * @return the snapshot, or why there is none. Never throws: every failure
     *         is a @ref BackupFailure the route turns into a status.
     */
    std::expected<BackupRecord, BackupFailure> backup_workspace (int64_t now);

    /**
     * @brief The single-backup slot, held for as long as one snapshot is being
     *        written (issue #987).
     *
     * Two concurrent `VACUUM INTO`s would each write a whole second copy of the
     * database - unbounded disk for a button someone double-clicked - and the
     * later one would race the retention pass of the earlier for the files it
     * is pruning. So a second caller is refused rather than queued: a backup is
     * a thing the user asked for *now*, and "one is already running" is a
     * better answer than a copy they did not ask for arriving later.
     *
     * `backup_workspace` takes the slot for its own duration. The type is
     * public because "a backup is already running" is a state a caller can be
     * in deliberately, and a test that cannot enter it can only assert the
     * refusal by racing.
     */
    class BackupSlot {
        public:
        explicit BackupSlot (Database& db);
        ~BackupSlot ();

        // Neither copyable nor movable: this is a lock, and every one of the
        // four would produce a second object claiming to hold the one slot.
        BackupSlot (const BackupSlot&)            = delete;
        BackupSlot& operator= (const BackupSlot&) = delete;
        BackupSlot (BackupSlot&&)                 = delete;
        BackupSlot& operator= (BackupSlot&&)      = delete;

        /// False when another backup already had the slot - nothing was taken,
        /// and the destructor releases nothing.
        [[nodiscard]] bool held () const {
            return held_;
        }

        private:
        Database& db_;
        bool held_ = false;
    };

    // Config Entries - Structured configuration with metadata
    void save_config_entry (const ConfigEntry& entry);
    std::optional<ConfigEntry> get_config_entry (const std::string& key);
    std::vector<ConfigEntry> get_all_config_entries ();
    void seed_default_config (); // Initialize default config values if empty

    /**
     * @brief SQLite page-cache size in force on the last connection opened, in
     * bytes (0 before the first one).
     *
     * `cache_size` is per-connection state, so the value from `dbCacheSize` is
     * re-applied every time sqlite_orm opens a connection and then read back
     * from SQLite - this reports the answer, not the request. It is the only
     * way to observe that the setting reached the database, which is what makes
     * the wiring testable and the startup line honest about what it applied.
     */
    int applied_cache_size_bytes () const;

    /**
     * @brief SQLite's `synchronous` level on this database's connection, read
     * back from SQLite rather than echoed (0 = OFF, 1 = NORMAL, 2 = FULL).
     *
     * The sibling of `applied_cache_size_bytes` above, and for the same reason:
     * the level is applied twice over the life of a `Database` - the engine's
     * compile-time default before the constructor's schema sync, then whatever
     * `dbSynchronous` holds once `init` can read it - and asking SQLite is the
     * only way to say which one is in force. Issue #838, where the startup log
     * line reported the level the engine had *asked* for while the schema sync
     * and the config seed had already run at SQLite's own default.
     */
    int applied_synchronous () const;

    // Type-safe config getters (replaces ConfigManager)
    int get_config_int (const std::string& key, int default_value = 0);
    std::string get_config_string (const std::string& key,
    const std::string& default_value = "");
    bool get_config_bool (const std::string& key, bool default_value = false);
    double get_config_double (const std::string& key, double default_value = 0.0);

    private:
    struct Impl;
    std::unique_ptr<Impl> impl_;

    /// The startup recovery record, read from the marker file in the
    /// constructor. See `recovery()`.
    std::optional<RecoveryRecord> recovery_;

    /**
     * @brief Delete a run and every child row it owns (ticks, metrics, results).
     *
     * The single definition of the run cascade - `delete_run` and `prune_runs`
     * both call it, so a new child table is wired into both by editing one
     * function. The caller must already hold the DB mutex.
     */
    void remove_run_cascade_locked (const std::string& id);

    /**
     * @brief Every collection id in @p root_id's subtree, @p root_id first.
     *
     * The single definition of "the subtree", shared by the delete cascade, the
     * restore, the purge and the trash's counts, so all four agree about what
     * one collection owns. Stamped and live rows alike: a walk that skipped
     * deleted rows could not find what a restore has to put back.
     *
     * The visited set is load-bearing rather than defensive - a cycle in
     * `parent_id` written before write-time validation existed would otherwise
     * loop forever while the global DB mutex is held (issue #79). The caller
     * must already hold that mutex.
     */
    std::vector<std::string> collection_subtree_locked (const std::string& root_id);

    /**
     * @brief Destroy a collection subtree or a single request outright -
     *        examples, requests, then collections, deepest first.
     *
     * The hard cascade soft delete replaced (issue #988), kept as the one
     * definition purge and retention both reach for. The caller must already
     * hold the DB mutex.
     */
    void purge_collection_locked (const std::string& id);
    void purge_request_locked (const std::string& id);

    /**
     * @brief The trash entry for one deleted row, or nothing when @p id names
     *        no *deleted* row.
     *
     * By id rather than by root, because restore and purge both take an id and
     * a row a cascade took is not a root - so answering only about roots would
     * make the re-parent rule unreachable and "restore this one request" a 404.
     * The listing filters roots out of *its* answer; these three still agree
     * about what an entry says. The caller must already hold the DB mutex.
     */
    std::optional<TrashEntry> trash_entry_locked (const std::string& id);

    /**
     * @brief Whether the collection @p owner_id names is missing or itself
     *        deleted - the question both halves of a restore ask about the row
     *        they are putting back.
     *
     * An empty optional is the *tree root*, which is not an absent owner: a
     * collection that sits at the top has nothing above it by design. The
     * caller must already hold the DB mutex.
     */
    bool owner_is_absent_locked (const std::optional<std::string>& owner_id);

    /**
     * @brief The two halves of `restore_deleted`, split by what a row can come
     *        back to: a request needs a live collection and refuses without
     *        one, a collection re-parents to the tree root instead.
     *
     * Named steps rather than one function with both shapes inside it (#1033's
     * rule, and what `readability-function-cognitive-complexity` reports).
     * Both take an entry `trash_entry_locked` already proved deleted, and both
     * require the DB mutex.
     */
    std::expected<TrashOutcome, RestoreFailure> restore_request_locked (
    const TrashEntry& entry);
    TrashOutcome restore_collection_locked (const TrashEntry& entry);

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
     * @brief Refuse a spec write whose target rows have moved under it.
     *
     * Throws `MissingRowError` for the bound collection or any updated request
     * that no longer exists - a spec write updates rows, never resurrects them,
     * which is `apply_reorder`'s rule and its reason. The caller must already
     * hold the DB mutex and be inside the write's own transaction, so what this
     * proves is still true when the write lands.
     */
    void verify_spec_sync_rows_locked (const SpecSyncBatch& batch);

    /**
     * @brief Write one spec batch: deletes first, then the document, the
     *        folders, the binding and the rows.
     *
     * Same scope rule as @ref verify_spec_sync_rows_locked - mutex held, inside
     * the transaction, after the verification.
     */
    void write_spec_sync_batch_locked (const SpecSyncBatch& batch);

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
