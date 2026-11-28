#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <chrono>
#include <cstdint>
#include <exception>
#include <expected>
#include <functional>
#include <initializer_list>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <sqlite_orm/sqlite_orm.h>

#include "vayu/db/change_feed.hpp"
#include "vayu/db/recovery.hpp"
#include "vayu/types.hpp"

namespace vayu::db {

/**
 * The schema version this engine understands, stamped into
 * `PRAGMA user_version` by `migrate_before_sync` (#1492, #1514). Bumped by a
 * commit that changes `make_vayu_storage`'s mapping (`sync_schema ()` runs
 * without `preserve`, so an older engine would rebuild a table without a column
 * it does not map) and by a one-shot migration an older engine must not read
 * past (4, 6, 7; the version is its done-marker). A newer stamp is refused at
 * startup. Each version's change: `docs/engine/db-schema/schema-versions.md`.
 */
inline constexpr int SCHEMA_VERSION = 11;

/**
 * @brief A TEXT column's bytes as the `const char*` every caller wants.
 *
 * One primitive, since a copy does not receive its fixes; the cast is a NOLINT,
 * not a defect, because [basic.lval] permits reading bytes through a character
 * type. SQL NULL stays `nullptr`: absent versus empty is the caller's
 * distinction, and defaulting here would erase it.
 */
inline const char* column_text (sqlite3_stmt* stmt, int column_index) {
    // [basic.lval] permits reading any object through a character type; see
    // the note above for why that makes this a NOLINT and not a defect.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    return reinterpret_cast<const char*> (sqlite3_column_text (stmt, column_index));
}

/**
 * @brief How a storage write failed, as far as a caller can act on it.
 *
 * `Full` (`SQLITE_FULL`): free disk space. `Busy`
 * (`SQLITE_BUSY`/`SQLITE_LOCKED` past the busy timeout): another connection
 * held the file; retry. `Other` (I/O, read-only, unopenable, corrupt): neither
 * the request's fault nor fixable by the caller.
 */
enum class StorageFailure : std::uint8_t { Full, Busy, Other };

struct StorageError {
    StorageFailure kind = StorageFailure::Other;
    /// SQLite's own words, de-duplicated; for the log, never for the user.
    std::string message;
};

/**
 * @brief Sort an exception a write caught into a storage failure, or nothing.
 *
 * Only a `std::system_error` in sqlite_orm's SQLite category is one, the guard
 * `classify_probe_failure` uses; anything else (a JSON parse error, a
 * validation error, a `std::filesystem_error` whose errno 13 is not
 * `SQLITE_FULL`) answers `std::nullopt`: the request was at fault.
 */
std::optional<StorageError> classify_storage_error (const std::exception& error);

/**
 * Optional filters for the paginated GET /runs list; unset fields are
 * wildcards. `q` is a case-insensitive SQL LIKE over the stored
 * `config_snapshot` text, over-matching JSON keys, acceptable for a search box.
 * `collection_id` deliberately reads `scenario.collectionId` as JSON, matching
 * the field only; only collection runs and load runs over a collection have it
 * (#3544).
 */
struct RunFilter {
    std::optional<RunType> type;
    std::optional<RunStatus> status;
    std::optional<std::string> request_id;
    std::optional<std::string> q;
    std::optional<std::string> collection_id;
    // `true` lists only pinned baselines (what a client resolves before
    // diffing), `false` only unpinned.
    std::optional<bool> baseline;
    // Exact match on `runs.origin` (#1817). The route sets it only for a kind
    // `is_run_origin_kind` accepts, so an unknown value is never a filter here.
    std::optional<std::string> origin;
    // Exact match on `runs.outcome` (#3547); a NULL outcome matches no value.
    std::optional<RunOutcome> outcome;
};

/// A keyset position in GET /runs order (`start_time DESC, id DESC`), the
/// previous page's last row; `id` breaks ties, making the order total, so pages
/// neither repeat nor skip (#2978).
struct RunCursor {
    int64_t start_time = 0;
    std::string id;
};

/// What `transition_run_status` did (#3340): `current` is the row's status
/// afterwards, the target if `applied`, the refusing status otherwise, nothing
/// without such a run.
struct RunStatusTransition {
    bool applied = false;
    std::optional<RunStatus> current;
};

/// A design run's exchange as two numbers, not a `Result`: GET /runs reads a
/// page of these, and `trace_data` (bodies included) would make a list page
/// megabytes.
struct DesignResultOutcome {
    int status_code;
    double latency_ms;
};

/**
 * @brief One thing the user deleted, as the trash lists it (#988).
 *
 * A root only, never what its cascade took; that is counted instead, answering
 * "restoring brings back what?" and "purging destroys what?".
 */
struct TrashEntry {
    std::string id;
    /// One of the five trash tables (`"collection"`, `"request"`,
    /// `"environment"`, `"example"`, `"clientCertificate"`, #2973), so a client
    /// knows the shape without a second read; every dispatch names all five and
    /// throws on anything else.
    std::string kind;
    /// A certificate's is its target, `host` or `host:port`, as a trace labels
    /// it.
    std::string name;
    /// Delete time, Unix ms; also the cohort key (`Collection::deleted_at`).
    int64_t deleted_at = 0;
    /// The owner: a collection's parent (absent at the root), a request's
    /// collection, an example's request (#2971); absent for environments and
    /// certificates.
    std::optional<std::string> parent_id;
    /// `parent_id`'s name, for requests and examples (#3449), telling
    /// same-named entries apart; absent only if the owner is gone, which no
    /// write leaves behind.
    std::optional<std::string> parent_name;
    /// Descendants this delete took (the cohort, what a restore puts back); 0
    /// but for a collection.
    int64_t collections = 0;
    int64_t requests    = 0;
    /// Descendants a purge destroys (#3449): every stamped row under the root,
    /// whichever delete stamped it, walked like `purge_collection_locked`
    /// (stopping at a live collection), so a superset of the cohort; 0 but for
    /// a collection.
    int64_t purge_collections = 0;
    int64_t purge_requests    = 0;
    /// An environment's variable count (via `parse_variables`); absent, not 0,
    /// for other kinds, as on the wire.
    std::optional<int64_t> variables;
};

/// What a restore or a purge acted on - the entry as it was, plus whether the
/// restore had to re-parent it (#988).
struct TrashOutcome {
    TrashEntry entry;
    /// True when the restored collection's parent was gone or itself deleted,
    /// so the row came back at the tree root instead. Always false for a purge.
    bool reparented = false;
};

/// What `Database::clear_runs` removed and what it left (#2429).
struct RunHistoryCleared {
    /// Every run the clear deleted, so a client can close what showed them.
    std::vector<std::string> deleted_ids;
    /// Pinned baselines still stored once the clear finished.
    int64_t kept_pinned = 0;
};

/// Why a restore did not happen: `NotFound` (404, no such trash id),
/// `OwnerGone` (409, the request's collection or the example's request is
/// deleted or missing), `OverLimit` (409, the request has
/// `request_example::MAX_PER_REQUEST` live examples, #2971), `TargetTaken`
/// (409, a live entry claims the certificate's host and port, #2973).
enum class RestoreRefusal : std::uint8_t {
    NotFound,
    OwnerGone,
    OverLimit,
    TargetTaken
};

/// A refused restore, as the route reports it (#988).
struct RestoreFailure {
    RestoreRefusal reason = RestoreRefusal::NotFound;
    std::string message;
};

/**
 * Thrown by `apply_reorder` when a row to write is not stored at commit; the
 * batch rolls back whole and the row stays deleted. A reorder only moves
 * existing rows, so an upsert could only silently resurrect what a concurrent
 * cascade deleted. The message names the row so the `/reorder` 409 is
 * actionable.
 */
class MissingRowError : public std::runtime_error {
    public:
    MissingRowError (const std::string& kind, const std::string& id)
    : std::runtime_error (kind + " '" + id + "' no longer exists") {
    }
};

/**
 * @brief One OpenAPI sync, as the rows it writes (#655).
 *
 * The one write that creates, updates and deletes; all-or-nothing, since half
 * of it leaves a collection bound to a document its requests do not reflect.
 * Ids are the caller's, as for `import_apply`: nothing can look up a row this
 * transaction has not committed. `POST /specs/bind` uses it too (#862), filling
 * only @ref spec, @ref binding and @ref updated, and shares the transaction
 * because a half-applied bind leaves the same state.
 */
struct SpecSyncBatch {
    /// The re-fetched document. A new row, never a rewrite - see `SpecDocument`.
    SpecDocument spec;
    /// The bound collection, `openapi` moved to @ref spec; updated, never
    /// inserted (a vanished collection is a `MissingRowError`).
    Collection binding;
    /// Tag folders an added operation needs and the collection does not have.
    std::vector<Collection> new_collections;
    std::vector<Request> created;
    /// Updated, never inserted, on `apply_reorder`'s rule and for its reason.
    std::vector<Request> updated;
    /// Request ids to delete. Their examples cascade, as `delete_request` does.
    std::vector<std::string> deleted;
    /// Example rows to insert: a created request's, and the imports replacing a
    /// refreshed request's.
    std::vector<RequestExample> examples;
    /// Ids of the imported example rows @ref examples replaces.
    std::vector<std::string> deleted_examples;
    /// `spec_declined_operations` rows this write forgets (#3031): those a
    /// created request takes back, or all the collection's when a bind changes
    /// its document.
    std::vector<int64_t> cleared_declines;
};

/**
 * @brief One applied MCP re-import (#3994), as the rows it writes beneath the
 *        collection an import of the server built.
 *
 * All-or-nothing for `SpecSyncBatch`'s reason, and with its id rule: every row
 * carries the id the caller minted.
 */
struct McpApplyBatch {
    /// The root collection the import built; a vanished one is a
    /// `MissingRowError`.
    std::string root_id;
    /// Folders a created request needs and the collection does not have.
    std::vector<Collection> new_collections;
    std::vector<Request> created;
    /// Updated, never inserted, on `apply_reorder`'s rule and for its reason.
    std::vector<Request> updated;
    /// Request ids to delete. Their examples cascade.
    std::vector<std::string> deleted;
};

/**
 * @brief One workspace snapshot, as `POST /workspace/backup` reports it (#987).
 *
 * `path` is absolute on every real start (the daemon gets a data directory), as
 * the user needs: restoring is a file copy they make themselves.
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
 * @brief Why a workspace backup did not happen (#987).
 *
 * A flag, not a message to parse: a refused concurrent backup is a 409 with
 * nothing wrong; any other failure is a 500 naming what SQLite or the
 * filesystem refused.
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
    /**
     * @param startup_busy_timeout how long each connection the constructor
     *        opens waits for another's lock before the database is refused as
     *        unavailable (#2420); the one-argument form uses `BUSY_TIMEOUT_MS`
     *        (a test lowers it), and `init` replaces it with `dbBusyTimeout`.
     * @throws std::runtime_error when the database cannot be examined (locked,
     *        disk full, read-only, an I/O error; nothing is renamed, restored
     *        or deleted) or a newer schema wrote it.
     */
    Database (const std::string& db_path, std::chrono::milliseconds startup_busy_timeout);
    ~Database ();

    // Neither copyable nor movable: the pImpl owns the SQLite connection and
    // the write mutex, every holder keeps it in place (`daemon.cpp`'s local,
    // the fixtures' `unique_ptr`), and a move would leave a hollow instance
    // whose methods still compile.
    Database (const Database&)            = delete;
    Database& operator= (const Database&) = delete;
    Database (Database&&)                 = delete;
    Database& operator= (Database&&)      = delete;

    // Initialize database (create tables, etc.) - defined in db_maintenance.cpp
    void init ();

    /**
     * @brief The database file this instance was opened on.
     *
     * Effectively the data directory: settings-derived files (the CA bundle
     * `resolve_transport_policy` writes, #706) sit beside it, so no second path
     * parameter is needed.
     */
    const std::string& path () const;

    /**
     * @brief What this startup did about a database it could not open, if
     *        anything (#922).
     *
     * `nullopt` is a clean start (a first run too); a value means the data was
     * restored from a backup or deleted, which `GET /health` reports. Why it
     * lives on disk and is never cleared here: `db/recovery.hpp`. Read once at
     * construction, so polling health costs no file access.
     */
    [[nodiscard]] const std::optional<RecoveryRecord>& recovery () const; // db_maintenance.cpp

    // Project Management - collections and their trash/reorder are defined
    // in db_collections.cpp; requests and their examples in db_requests.cpp.
    void create_collection (const Collection& c);
    /// Live collections only; a deleted one is gone to every reader but the
    /// trash (#988).
    std::vector<Collection> get_collections ();
    /// Live only: a deleted row reads as absent, so every by-id route 404s
    /// (#988).
    std::optional<Collection> get_collection (const std::string& id);
    /// Whether @p id is stored *and* stamped, which `get_collection` cannot
    /// tell from never written (#1883); an unknown id is `false`, so forward
    /// references stay legal.
    bool collection_is_trashed (const std::string& id);
    /// Stamps the collection and its subtree deleted (#988): `GET /trash` lists
    /// it, restore puts it back, purge destroys it.
    ///
    /// @param declined_under the bound collection above @p id, if any: each
    ///        stamped request that records an operation is declined under it in
    ///        the same transaction (#3031). Empty when the deleted collection
    ///        is the bound one: deleting a bound tree decides no operation.
    void delete_collection (const std::string& id,
    const std::optional<std::string>& declined_under = std::nullopt);
    /// Writes @p collection as `create_collection` does and, in one
    /// transaction, forgets every operation declined under it (#3031): a
    /// binding moving off the document they were decided on.
    ///
    /// @param departed the requests this write takes out of a spec contract
    ///        (stamps cleared), with @p declined_under naming where each is
    ///        declined: `apply_reorder`'s two parameters, for a
    ///        `PUT /collections/:id` that unbinds and reparents at once
    ///        (#3470). The forget runs after them, so declines under
    ///        @p collection go too.
    // db_collections.cpp
    void rebind_collection (const Collection& collection,
    const std::vector<Request>& departed                               = {},
    const std::unordered_map<std::string, std::string>& declined_under = {});

    /// @param declined_under the bound collection a move takes @p r out of
    ///        (`declined_by_move`, `routes.hpp`, #3446): the stored row's
    ///        operation is declined under it in the same transaction, as
    ///        `delete_request` does; @p r's stamp is already cleared. Empty
    ///        records nothing.
    void save_request (const Request& r,
    const std::optional<std::string>& declined_under = std::nullopt);
    /// Live only - see `get_collection` (#988).
    std::optional<Request> get_request (const std::string& id);
    /// Live only, and empty for a deleted collection (#988).
    std::vector<Request> get_requests_in_collection (const std::string& collection_id);
    /// Every live request of every live collection, grouped by collection in
    /// `get_requests_in_collection`'s order: the whole tree in one query.
    std::vector<Request> get_requests_in_live_collections ();
    /// `get_requests_in_collection`'s rows, filter and order, as summaries:
    /// the large columns are never read (#2546).
    std::vector<RequestSummary> get_request_summaries_in_collection (
    const std::string& collection_id);
    /// `get_requests_in_live_collections`' rows, filter and order, as summaries.
    std::vector<RequestSummary> get_request_summaries_in_live_collections ();
    /**
     * Every live request at or beneath @p root_id, depth-first in sibling order
     * (`sibling_order.hpp`, #2535): sub-folders and requests share one list, so
     * a sub-folder's subtree runs where it sits. Recursive runs, mock route
     * tables and OpenAPI exports walk it, matching the sidebar. A `parent_id`
     * cycle visits each collection once.
     */
    std::vector<Request> get_requests_in_subtree (const std::string& root_id);
    /**
     * The `order` an append under @p parent_id takes: one past the highest live
     * sibling of either kind (`sibling_order.hpp`, #2535); `std::nullopt` is
     * the roots (collections only). @p excluded_id is skipped so a row
     * resetting its own position lands after its *other* siblings. `0` with no
     * live child; nothing when a sibling holds `MAX_SIBLING_ORDER` (#3451), and
     * the caller refuses.
     */
    [[nodiscard]] std::optional<int> next_sibling_order (
    const std::optional<std::string>& parent_id,
    const std::string& excluded_id = {}); // db_collections.cpp
    /// Stamps the request deleted (#988); its examples stay on the row,
    /// unreadable while it is stamped, and go with a purge.
    ///
    /// @param declined_under the bound collection the request answers to
    ///        (`core::nearest_spec_binding`): a recorded operation is declined
    ///        under it in the same transaction (#3031). Empty records nothing.
    void delete_request (const std::string& id,
    const std::optional<std::string>& declined_under = std::nullopt);
    /// The operations deletes declined under the bound collection
    /// @p collection_id (#3031), in the order they were recorded.
    std::vector<DeclinedOperation> get_declined_operations (const std::string& collection_id);

    // Trash - what soft delete left behind (#988)

    /// Every deleted root, newest first: a stamped row whose owner is not
    /// stamped. Environments and certificates have no owner, so are always
    /// roots (#2970, #2973); an example is one only while its request is live
    /// (#2971), part of a trashed request's entry, listed nowhere without one.
    std::vector<TrashEntry> get_trash ();

    /**
     * @brief Put a deleted row, and everything its delete took with it, back.
     *
     * Restores the *cohort* (stamped rows carrying this row's `deleted_at`); an
     * earlier separate delete keeps its stamp and stays a root. A collection
     * whose parent is gone or deleted returns at the root (`parent_id`
     * cleared), the only rewrite beyond the stamp. An environment returns
     * unconditionally and inactive (#2970; activating is the client's call). An
     * example needs a live request with room under `MAX_PER_REQUEST` (#2971). A
     * certificate needs no live entry on its host and port (#2973), else row
     * order would pick the one presented; that refusal names the entry and is
     * decided under the write's lock. Example and certificate refusals are
     * 409s; the row stays.
     */
    std::expected<TrashOutcome, RestoreFailure> restore_deleted (const std::string& id);

    /**
     * @brief Destroy a deleted row for good: the hard cascade soft delete
     *        replaced.
     *
     * Takes the whole subtree, stamped or not: a row left under a removed
     * collection is unreachable and unrestorable. `nullopt` when no *deleted*
     * row has the id, so a live row is never purged by accident.
     */
    std::optional<TrashOutcome> purge_deleted (const std::string& id);

    /**
     * @brief Purge everything deleted longer ago than @p retention_days.
     *
     * @param retention_days 0 keeps the trash forever, as 0 reads for
     *        `maxRunsRetained` and `runRetentionDays`.
     * @param now the caller's clock, Unix ms, so a test states an age instead
     *        of sleeping.
     * @return how many roots were purged.
     */
    int64_t purge_expired_trash (int retention_days, int64_t now);

    /// `purge_expired_trash` with the configured `trashRetentionDays` and the
    /// system clock - what startup runs (#988).
    int64_t purge_expired_trash_configured ();

    // Saved example responses, owned by a request (#481): read only by request
    // or example id, since an example means nothing apart from its request.

    void save_request_example (const RequestExample& e);
    /// A suppressed or trashed row reads as absent - see the definition
    /// (issues #722, #2971).
    std::optional<RequestExample> get_request_example (const std::string& id);
    /// Oldest first (`created_at`, then id), the order a mock server's "first
    /// example" uses, so a contract. Tombstones and trashed rows are excluded:
    /// a deleted example of either origin is gone (#722, #2971).
    std::vector<RequestExample> get_request_examples (const std::string& request_id);
    /// The tombstones only - deleted imported examples, which exist so a spec
    /// sync does not write back what the user removed (#722).
    std::vector<RequestExample> get_suppressed_request_examples (const std::string& request_id);
    /// Live examples only - what counts against `MAX_PER_REQUEST`.
    int64_t count_request_examples (const std::string& request_id);
    /// Whether any row has @p id, tombstoned or trashed included: a create
    /// checks before its `replace`, which would overwrite a hidden row (#2971).
    bool request_example_id_taken (const std::string& id);
    /// Stamps a live example deleted (#2971), kept for `GET /trash` until
    /// restore or purge. Only a user's own example comes here; an imported one
    /// is tombstoned (`suppress_request_example`).
    void delete_request_example (const std::string& id);
    /// Keeps an imported example's row as a tombstone instead of removing it
    /// (#722). `now` is the caller's clock, as every other write here.
    void suppress_request_example (const std::string& id, int64_t now);

    // OpenAPI documents (db_specs.cpp): bound by collections, not owned, so
    // nothing cascades; the route proves no collection names the id before
    // `delete_spec_document`.

    void save_spec_document (const SpecDocument& s);
    std::optional<SpecDocument> get_spec_document (const std::string& id);
    /**
     * @brief The collections whose `openapi` binding names @p spec_id.
     *
     * A scan, not an index: the binding is inside a JSON blob, the table is
     * sidebar-sized, and only the delete refusal calls it. Trashed collections
     * count (#3446), since a restore brings their binding back; empty is the
     * only state `delete_spec_document` may be called in.
     */
    std::vector<Collection> get_collections_bound_to_spec (const std::string& spec_id);
    void delete_spec_document (const std::string& id);

    /**
     * @brief Reclaim documents nothing can reach any more, returning how many
     *        went (#718).
     *
     * Nothing owns a `spec_documents` row, so no cascade removes one: each sync
     * mints a new document, and unbinding, re-binding or deleting the binder
     * leaves the old. A year of weekly 12 MB syncs strands ~600 MB no route can
     * even list (`DELETE /specs/:id` needs an id; there is no list).
     *
     * **The lifetime rule**: a document lives while a collection binds it or a
     * *retained run* names it in `runs.config_snapshot` (a scenario run's
     * coverage may still need its source), so it outlives its binding exactly
     * as long as its runs; that is what makes the sweep safe beside retention.
     * Callers: `prune_runs_configured` (the pass that releases run references,
     * at startup and after every run), `spec_sync_apply` (the accretion
     * source), `delete_collection` (a binder going). Anything written within
     * `SPEC_DOCUMENT_SWEEP_GRACE_MS` is spared (the bind-in-flight window).
     *
     * **Never throws**: each caller's success does not depend on it, so
     * failures are logged and swallowed. Cheap when idle, as every run
     * completion requires: three questions cheapest-first, stopping when
     * nothing is at stake, so the ordinary case never reads the runs table and
     * no path reads `content`.
     */
    size_t sweep_orphaned_spec_documents ();

    /**
     * @brief Repair bindings stored without the document version they name
     *        (#709), returning how many were stamped.
     *
     * Coverage and schema validation need `specHash` to match the stored
     * document; bindings imports wrote before #709 lack it, so their runs
     * report no contract. Safe: a hashless binding came from an import that
     * stored exactly its document, so that document's hash *is* the bound
     * version; one naming a vanished document is left alone. Idempotent at
     * startup, not a one-shot flag: stamped bindings are skipped, so a start
     * costs one scan of the sidebar-sized table.
     */
    int64_t stamp_hashless_spec_bindings ();

    /**
     * @brief Disable the header rows a pre-#1229 client saved into stored
     *        requests, and answer how many requests were rewritten.
     *
     * Such rows (`X-Vayu-Version`, a fixed `X-Request-ID`) make every consumer
     * (load and collection runs, MCP sends, exports, snippets) replay one day's
     * version and one frozen correlation id; the engine's send-time headers fix
     * only new sends, this pass the stored rows. The match rules, and why each
     * is narrow enough to disable rather than delete, are
     * `strip_legacy_managed_headers` (`http/default_headers.hpp`), testable
     * without a database. Idempotent at startup, as
     * `stamp_hashless_spec_bindings`. Trashed rows are left alone (#1491):
     * `restore_request_locked` / `restore_collection_locked` apply it on the
     * way out, so a trashed request stays byte-identical.
     */
    int64_t strip_stored_managed_headers (); // db_maintenance.cpp

    /**
     * @brief Rewrite every collection stored with `parent_id = ''` to NULL,
     *        trashed rows included, and answer how many were rewritten.
     *
     * `""` was a second spelling of the root before #3451; writes store NULL
     * (`read_parent_id_field`). Unmarked, unlike
     * `strip_stored_managed_headers`: both statements use
     * `idx_collections_parent_id`, so a clean start pays one index probe. Saves
     * a `pre-repair` snapshot first, and throws, rewriting nothing, when it
     * cannot.
     */
    int64_t clear_empty_parent_ids (); // db_maintenance.cpp

    /**
     * @brief Persist a whole import in one transaction (#96).
     *
     * All rows or none, written collections -> requests -> examples ->
     * environments so parents exist first. Ids are the caller's
     * (`POST /import/apply` resolves its temp ids): nothing here can look up a
     * row this transaction has not committed.
     */
    // db_requests.cpp
    void import_apply (const std::vector<Collection>& collections,
    const std::vector<Request>& requests,
    const std::vector<Environment>& environments,
    const std::vector<RequestExample>& examples = {},
    const std::vector<SpecDocument>& specs      = {});

    /**
     * @brief Persist a whole batch reorder in one transaction (#365).
     *
     * The rows' positions (and, for a move, owners) are pre-validated against
     * each other; all land or none. N sibling `PUT`s could stop halfway and
     * leave two rows at one `order` and a gap, which no read repairs since the
     * tie rule then picks the display order. **Updated, never inserted**: a row
     * missing at commit throws `MissingRowError` and rolls back (#386), as an
     * insert could only be a resurrection. Not `import_apply`: this rewrites
     * existing rows, never environments, after other validation.
     *
     * @param declined_under request id to the bound collection the batch moves
     *        that request out of (#3446), resolved by the route: the stored
     *        row's operation is declined under it before the row is written, in
     *        the same transaction. The caller has cleared the row's stamp.
     */
    // db_collections.cpp
    void apply_reorder (const std::vector<Collection>& collections,
    const std::vector<Request>& requests,
    const std::unordered_map<std::string, std::string>& declined_under = {});

    /**
     * @brief Persist a whole OpenAPI sync in one transaction (#655).
     *
     * Not `import_apply`, for `apply_reorder`'s reason: it rewrites and deletes
     * named rows, where an upsert would resurrect what a concurrent delete
     * removed. `SpecSyncBatch::binding` and every `updated` row must exist at
     * commit, or `MissingRowError` rolls it all back (the route's 409: the
     * diff's ground moved). A `deleted` request already gone is fine; its
     * examples go either way.
     */
    void spec_sync_apply (const SpecSyncBatch& batch); // db_specs.cpp

    /**
     * @brief Persist one applied MCP re-import in one transaction (#3994).
     *
     * `spec_sync_apply`'s rules without its document half: the root and every
     * `updated` row must exist at commit, or `MissingRowError` rolls it all
     * back (the route's 409); a `deleted` request already gone is fine; and
     * the deletes are hard for the reason a sync's are, its removals being
     * shown and opted into before they land.
     */
    void mcp_apply (const McpApplyBatch& batch); // db_requests.cpp

    /**
     * @brief Run @p fn with the DB mutex held for the whole of it (#386).
     *
     * Per-call locking does not cover a read-decide-write composite: between
     * `POST /reorder`'s validation and commit another write can move the ground
     * (two legal reparents commit a cycle; a create computes `max_order + 1`
     * inside the range being renumbered). The mutex is recursive, so @p fn may
     * call any method here. Keep @p fn bounded: `/health`, the runs poll and
     * SSE all wait.
     */
    void with_lock (const std::function<void ()>& fn); // database.cpp

    /**
     * @brief What `GET /changes` relays (#3420): one event per committed write
     *        of a collection, request, example, environment, the globals or a
     *        trash entry (when, and what a cascade publishes:
     *        `db/change_feed.hpp`).
     *
     * Only public writes of those kinds publish; startup repairs run before the
     * engine listens, when no stream is open and a resume from an earlier
     * process resets.
     */
    ChangeFeed& change_feed () {
        return changes_;
    }

    // db_environments.cpp. Reads see live rows only (#2970): compositions,
    // script scopes and exports all go through `get_environment`, so a trashed
    // one is missing to all of them.
    void save_environment (const Environment& e);
    std::vector<Environment> get_environments ();
    std::optional<Environment> get_environment (const std::string& id);
    /// Stamps it deleted and clears `is_active` (#2970); kept for `GET /trash`
    /// until restore or purge.
    void delete_environment (const std::string& id);

    /**
     * Client-certificate registry (#707), plain CRUD: the routes own validation
     * and the uniqueness answer, needing a status code.
     * `get_client_certificates` runs once per resolved transport policy (per
     * design send, once per load or collection run), never per transfer
     * (`vayu::http::resolve_transport_policy`). Reads see live rows only
     * (#2973): a trashed entry is presented to no host, and a PUT or second
     * DELETE of one 404s.
     */
    // db_credentials.cpp
    void save_client_certificate (const ClientCertificate& c);
    std::vector<ClientCertificate> get_client_certificates ();
    std::optional<ClientCertificate> get_client_certificate (const std::string& id);
    /// The live entry other than @p except_id claiming @p host and @p port: the
    /// one definition of "one entry per target" (#707), used by create, update
    /// and restore (#2973). Hold the DB mutex across the answer and the write
    /// that relies on it.
    std::optional<ClientCertificate> client_certificate_for_target (const std::string& host,
    const std::optional<int>& port,
    const std::string& except_id = {});
    /// Stamps a live entry deleted (#2973); the row, passphrase included, stays
    /// until restore or purge.
    void delete_client_certificate (const std::string& id);

    /**
     * Allowed folders for request-body files (`file_roots`, schema version 3),
     * plain CRUD: `routes/file_roots.cpp` owns path rules and uniqueness. Read
     * once per design send and per run (`FileAccessPolicy::from_database`),
     * never per transfer; ordered by path.
     */
    // db_credentials.cpp
    void save_file_root (const FileRoot& root);
    std::vector<FileRoot> get_file_roots ();
    std::optional<FileRoot> get_file_root (const std::string& id);
    void delete_file_root (const std::string& id);

    /**
     * Files a person picked (`file_grants`, schema version 6, #2356), plain
     * CRUD: the caller canonicalises `path` and owns uniqueness (the column is
     * UNIQUE; `save_file_grant` replaces). Read with the folders; ordered by
     * path.
     */
    // db_credentials.cpp
    void save_file_grant (const FileGrant& grant);
    std::vector<FileGrant> get_file_grants ();
    std::optional<FileGrant> get_file_grant (const std::string& id);
    void delete_file_grant (const std::string& id);

    // Globals (singleton) - db_environments.cpp
    void save_globals (const Globals& g);
    std::optional<Globals> get_globals ();

    // OAuth token cache - db_credentials.cpp
    void save_oauth_token (const OAuthToken& t);
    std::optional<OAuthToken> get_oauth_token (const std::string& cache_key);
    void delete_oauth_token (const std::string& cache_key);
    /**
     * Removes @p cache_key's row only while it holds @p refresh_token, reading
     * and removing under one mutex acquisition (#3344): a refused refresh
     * clears the token it spent, never a row another acquisition wrote
     * meanwhile.
     *
     * @return whether a row was removed.
     */
    bool delete_oauth_token_if_refresh_matches (const std::string& cache_key,
    const std::string& refresh_token);

    // Execution: runs and every run-scoped artifact below (ticks, monitor
    // samples, results, the webhook inbox) live in db_runs.cpp.
    void create_run (const Run& run);
    std::optional<Run> get_run (const std::string& id);
    /**
     * @brief The run row as last committed, read without waiting on the DB
     *        mutex (#2679).
     *
     * Via a second, read-only connection, so an in-flight write (a results
     * chunk, its WAL checkpoint) is neither waited for nor seen. For reads that
     * must stay prompt during a run; `get_run` is the one a read-then-write
     * composes with.
     */
    std::optional<Run> get_run_snapshot (const std::string& id);
    /**
     * @brief Move run @p id to @p to if its status is one of @p allowed_from
     *        (#3340). The only run status write after the insert.
     *
     * Read, decision and write share one DB mutex acquisition. No wildcard: an
     * empty @p allowed_from refuses every row, so a terminal status is left
     * only by a named edge. `end_time` moves with the edge: a terminal @p to
     * keeps a stored value later than `start_time` (`update_run_end_time`'s)
     * and stamps now over anything else, the `seed_run_times` seed included; @p
     * to Running clears it to 0 so a live report measures to now; other edges
     * leave it. Busy is retried, a terminal write until it lands (a lost final
     * status leaves the run `running`, unpruned, until the next start
     * reconciles it; a graceful shutdown waits for that worker, a kill leaves
     * it to `reconcile_orphaned_runs`). Other errors throw; a refusal is logged
     * and answered, never thrown.
     */
    RunStatusTransition transition_run_status (const std::string& id,
    std::initializer_list<RunStatus> allowed_from,
    RunStatus to);
    // Stamps end_time now, status unchanged; a later terminal
    // `transition_run_status` keeps it.
    void update_run_end_time (const std::string& id);
    std::vector<Run> get_all_runs ();
    // Newest first (start_time DESC, id DESC), the only order the UI uses;
    // count_runs is the total matching @p filter, ignoring limit, offset and
    // cursor, for the pagination envelope.
    std::vector<Run>
    get_runs_paginated (const RunFilter& filter, int64_t limit, int64_t offset);
    // The same order after @p before: the index seeks to the cursor instead of
    // stepping over an OFFSET's rows (#2978).
    std::vector<Run>
    get_runs_before (const RunFilter& filter, const RunCursor& before, int64_t limit);
    int64_t count_runs (const RunFilter& filter);
    void delete_run (const std::string& id);

    /**
     * @brief Store the whole-run results summary (JSON) on the run row.
     *
     * Written once at a terminal status and read by `GET /runs/:id/report`
     * instead of re-reducing the time series. A missing run (deleted
     * mid-flight) is logged and ignored. Busy is retried: losing this write
     * loses the run's aggregates, which nothing else records.
     */
    void update_run_summary (const std::string& id, const std::string& summary);

    /**
     * @brief Pin (or unpin) a run as a baseline, returning the stored row.
     *
     * `std::nullopt` is no such run (the 404). Many runs may be pinned: which
     * baseline applies is the client's choice (per request, per endpoint), so
     * this never unpins another.
     */
    std::optional<Run> set_run_baseline (const std::string& id, bool baseline);

    /**
     * @brief Prune old runs (and their cascaded metrics/results) by three
     *        limits.
     *
     * Count caps are per kind (#2429): @p max_runs for load and scenario runs,
     * @p max_design_runs for design Sends, neither evicting the other. A run
     * beyond its kind's newest N (by start_time) or older than @p max_age_days
     * (every kind) is a victim; 0 disables a limit. Runs `running`, `pending`
     * or pinned (`Run::baseline`) are never pruned and count toward no cap.
     * Deletion is batched, releasing the mutex between batches so a backlog
     * cannot stall other endpoints; each victim is re-read in its batch's lock
     * and spared if since pinned, in flight or deleted (#1906). `delete_run` is
     * the explicit verb and deletes whatever it names.
     *
     * @param after_selection Test seam, invoked once victims are chosen, with
     *        the mutex released and before the first batch: the window a
     *        competing pin lands in.
     * @param max_design_runs The design Send cap; after the seam so
     *        three-argument callers keep their meaning.
     */
    void prune_runs (int max_runs,
    int max_age_days,
    const std::function<void ()>& after_selection = nullptr,
    int max_design_runs                           = 0);

    /**
     * @brief Prune runs by the configured `maxRunsRetained`,
     *        `maxDesignRunsRetained` and `runRetentionDays`, at startup and
     *        after each run ends.
     */
    void prune_runs_configured ();

    /**
     * @brief Delete every run retention would ever delete, now (#2429).
     *
     * "Clear run history": every run but pinned baselines and those
     * `running`/`pending`, decided per row in `remove_unexempt_runs`' batch
     * lock, so one pinned or started meanwhile is spared. There is no runs
     * trash.
     */
    RunHistoryCleared clear_runs ();

    /**
     * @brief Mark runs left `running`/`pending` by a previous process as
     *        failed.
     *
     * A crash or kill leaves in-flight runs without a terminal status, which
     * `GET /runs` would report as running forever (a graceful shutdown joins
     * every worker, which writes it). Called from `init()` before the sweeper
     * and HTTP server start, so no run of this process is caught, and
     * `daemon.cpp` takes the instance lock before opening the database, so no
     * other engine has one here: that lock is the whole ownership check
     * (#2422). A load run with no summary but a metric tick gets one from its
     * last tick, marked `"partial": true` (#2895), cumulative figures only. An
     * `end_time` is kept (death time is unknowable; the restart would span the
     * downtime); a row with none (0, as a move to Running leaves) gets its
     * `start_time`.
     *
     * @return Number of rows reconciled.
     */
    size_t reconcile_orphaned_runs ();

    // Metric ticks: one wide row per tick.
    void add_metric_tick (const MetricTick& tick);
    // The run's most recently written tick, or nothing when it wrote none.
    std::optional<MetricTick> get_last_metric_tick (const std::string& run_id);
    // Ordered (timestamp, id) so a page boundary never splits a tick.
    std::vector<MetricTick>
    get_metric_ticks_paginated (const std::string& run_id, int64_t limit, int64_t offset);
    std::vector<MetricTick> get_metric_ticks_since (const std::string& run_id, int64_t last_id);
    int64_t count_metric_ticks (const std::string& run_id);

    // Monitor samples: one wide row per server-vitals scrape, not in
    // `metric_ticks`, whose key set is the GET /runs/:id/metrics contract.
    void add_monitor_sample (const MonitorSample& sample);
    // Ordered (timestamp, id) so a page boundary never splits a sample.
    std::vector<MonitorSample>
    get_monitor_samples_paginated (const std::string& run_id, int64_t limit, int64_t offset);
    int64_t count_monitor_samples (const std::string& run_id);

    // Results
    /// Inserts one result row and answers the id SQLite assigned it.
    int add_result (const Result& result);
    /// One result row of @p run_id, matched on both ids, so another run's
    /// result id 404s on `GET /runs/:runId/results/:resultId`.
    std::optional<Result> get_result (const std::string& run_id, int result_id);
    /**
     * @brief Batch insert of a run's sampled results, optionally with the
     *        response bodies captured alongside them.
     *
     * `bodies` refer to results by index (`PendingResultBody::result_index`):
     * row ids exist only after the insert. Chunks of
     * `RESULTS_WRITE_CHUNK_ROWS`, each one transaction and mutex acquisition
     * with a pause off the mutex between, so others wait one chunk, not the
     * flush (#2548); a chunk's results, body rows and new blobs commit
     * together, so no body row outlives its result. The call is not atomic: a
     * failure keeps committed chunks. Bodies dedupe by `body_hash` across the
     * call, so identical responses (the load-test norm) share one `body_blobs`
     * row.
     */
    void add_results_batch (const std::vector<Result>& results,
    const std::vector<PendingResultBody>& bodies = {});
    std::vector<Result> get_results (const std::string& run_id);
    /**
     * @brief A run's results with every column but `trace_data`, in id order.
     *
     * For readers needing status, latency and error, not the trace (#2548; a
     * non-terminal load run's report reads no row at all, #2659). `trace_data`
     * comes back empty, which every reader takes as "no trace".
     */
    std::vector<Result> get_results_without_traces (const std::string& run_id);
    /**
     * @brief Status code and latency for a page of **design** runs, in one
     *        query.
     *
     * GET /runs attaches each design row's outcome (`resultSummary`); load and
     * collection rows take theirs from the stored `summary`, never results
     * (#2130, #2954). Not `get_results` in a loop: two columns (no
     * `trace_data`), one statement per page, and a statement matching only
     * design-run results, so a load run's unbounded error rows cannot be pulled
     * by the query itself (GET /runs/:id's guard is caller-side, and has to
     * be). A run with no result row yet is absent, not zeroed: "no outcome" is
     * not "HTTP 0 in 0ms".
     */
    std::unordered_map<std::string, DesignResultOutcome>
    get_design_result_outcomes (const std::vector<std::string>& run_ids);

    // Captured bodies of a run's sampled results, unreachable from get_results
    // on purpose: a finished run's report parses every result row's trace and
    // must not pay for these.
    std::vector<ResultBody>
    get_result_bodies_paginated (const std::string& run_id, int64_t limit, int64_t offset);
    int64_t count_result_bodies (const std::string& run_id);
    /// The stored bytes of a blob, or `""` when the id is 0 or unknown.
    std::string get_body_blob_content (int blob_id);

    // Webhook inbox captures (#480): the inbox is process-lifetime
    // `InboxManager` state; only its captures are stored, so a long listener's
    // list pages off disk instead of the heap.

    /**
     * @brief Append one capture and trim the inbox back to @p max_captures.
     *
     * One transaction: a list briefly at 501 rows is harmless, a trim without
     * its insert (or the reverse) drops a capture reported as landed. Oldest go
     * first by `id`, the arrival order, which unlike `received_at` cannot tie.
     *
     * @return the id assigned to the stored capture.
     */
    int add_inbox_request (const InboxRequest& capture, int64_t max_captures);

    /// Newest first - the order the capture list reads in.
    std::vector<InboxRequest>
    get_inbox_requests_paginated (const std::string& inbox_id, int64_t limit, int64_t offset);
    int64_t count_inbox_requests (const std::string& inbox_id);
    /// One capture, matched on the inbox too: another inbox's id is absent, as
    /// in `get_result`.
    std::optional<InboxRequest> get_inbox_request (const std::string& inbox_id, int capture_id);
    /// Captures with `id` greater than @p last_id, oldest first (the live poll).
    std::vector<InboxRequest>
    get_inbox_requests_since (const std::string& inbox_id, int64_t last_id);
    /// @return how many rows were removed.
    int64_t clear_inbox_requests (const std::string& inbox_id);
    /**
     * @brief Drop every capture, for every inbox. Called from `init()`.
     *
     * Inboxes are process-lifetime, so after a restart no inbox can list these
     * rows; like `reconcile_orphaned_runs`, leftovers are cleared before
     * anything reads them.
     */
    int64_t clear_inbox_requests_all ();

    // Workspace backup (#987)

    /**
     * @brief Where snapshots are written: `backups/` beside the database file.
     *
     * Derived from @ref path, as the CA bundle is, so a `Database` holder needs
     * no second path.
     */
    // db_maintenance.cpp
    [[nodiscard]] std::string backups_directory () const;

    /**
     * @brief Write one consistent, compacted snapshot of this workspace and
     *        prune older ones to `maxBackupsRetained`.
     *
     * `VACUUM INTO`, not a file copy: under WAL the `-wal` holds committed
     * transactions the main file lacks, while `VACUUM INTO` writes one
     * complete, defragmented snapshot, read-only towards the workspace.
     *
     * @param now The caller's clock, in Unix ms. It names the file, so a test
     *        can state which snapshot it is asking for; a stamp already taken
     *        is stepped over, not written through, as the corruption quarantine
     *        does.
     * @return the snapshot, or why there is none. Never throws: every failure
     *        is a @ref BackupFailure the route turns into a status.
     */
    std::expected<BackupRecord, BackupFailure> backup_workspace (int64_t now);

    /**
     * @brief The single-backup slot, held while one snapshot is written (#987).
     *
     * Two concurrent `VACUUM INTO`s would each write a whole copy (unbounded
     * disk for a double-click), and the later would race the earlier's
     * retention pass. So a second caller is refused, not queued: "one is
     * already running" beats an unasked-for copy later. `backup_workspace`
     * holds it for its own duration; the type is public so a test can hold it
     * and assert the refusal without racing.
     */
    class BackupSlot {
        public:
        explicit BackupSlot (Database& db); // db_maintenance.cpp
        ~BackupSlot ();                     // db_maintenance.cpp

        // Neither copyable nor movable: it is a lock, and a copy or move would
        // be a second holder.
        BackupSlot (const BackupSlot&)            = delete;
        BackupSlot& operator= (const BackupSlot&) = delete;
        BackupSlot (BackupSlot&&)                 = delete;
        BackupSlot& operator= (BackupSlot&&)      = delete;

        /// False when another backup had the slot: nothing was taken, and the
        /// destructor releases nothing.
        [[nodiscard]] bool held () const {
            return held_;
        }

        private:
        Database& db_;
        bool held_ = false;
    };

    // Recovery backup - the `<db>.bak` a failed validation restores from

    /**
     * @brief Replace `<db>.bak` with a snapshot of this database, if this start
     *        validated it.
     *
     * Taken after the engine listens, since a copy before costs O(database
     * size) on every clean start: `VACUUM INTO` a `.bak.tmp` on its own
     * connection (consistent under WAL, unlike a file copy of a live database),
     * validated by the constructor's probe, then renamed over the backup. A
     * snapshot failing any step is removed and the old backup kept, so recovery
     * never reaches a partial copy. A no-op on a start that took the recovery
     * branch: the backup it judged, restored or kept as evidence is not this
     * call's to overwrite.
     *
     * @return why nothing was written, or nothing. Never throws.
     */
    std::expected<void, std::string> refresh_recovery_backup (); // db_maintenance.cpp

    /**
     * @brief Run @ref refresh_recovery_backup on a thread of its own, once the
     *        listener is up, so it overlaps the app's first requests rather
     *        than delaying `/health`. One per `Database`; a second call is
     *        ignored.
     */
    void start_recovery_backup_refresh (); // db_maintenance.cpp

    /**
     * @brief Interrupt a running refresh and wait for its thread: a shutdown
     *        must neither wait out a large snapshot nor release the engine's
     *        lock while one still reads the file. The partial snapshot is
     *        discarded. Idempotent; the destructor calls it too.
     */
    void finish_recovery_backup_refresh (); // db_maintenance.cpp

    /**
     * @brief Refresh `<db>.bak` once more as the engine stops, so it holds this
     *        session's work.
     *
     * Called after every writer stopped and @ref finish_recovery_backup_refresh
     * returned, before the `Database` closes, so the engine's lock is still
     * held. Skipped when the session wrote nothing after `init` (by
     * `sqlite3_total_changes64` on the shared connection; other connections'
     * writes are not seen); otherwise the WAL is checkpointed and the backup
     * replaced as @ref refresh_recovery_backup does. Bounded by the smaller of
     * @p budget and `database::SHUTDOWN_BACKUP_DEADLINE_MS`: the copy is
     * interrupted at the deadline and one finishing past it is discarded
     * unvalidated; validation, flush and rename run to completion. Failures
     * keep the previous backup; the caller logs why.
     *
     * @param budget what is left of the caller's shutdown window; zero or less
     *        refreshes nothing.
     * @return why nothing was written, or nothing (also when the session wrote
     *         nothing). Never throws.
     */
    std::expected<void, std::string> refresh_recovery_backup_on_shutdown (
    std::chrono::milliseconds budget); // db_maintenance.cpp

    // Config Entries - Structured configuration with metadata; db_config.cpp
    void save_config_entry (const ConfigEntry& entry);
    /**
     * @brief Write a batch of config entries in one sqlite transaction (#1453):
     *        the write half of `POST /config`'s all-or-nothing batch, where a
     *        loop of `save_config_entry` would commit row by row.
     */
    void save_config_entries (const std::vector<ConfigEntry>& entries);
    std::optional<ConfigEntry> get_config_entry (const std::string& key);
    std::vector<ConfigEntry> get_all_config_entries ();
    void seed_default_config (); // Initialize default config values if empty

    /**
     * @brief Whether @p key is one this build declares (`seed_default_config`
     *        upserts it), not merely one with a row (#1492).
     *
     * A newer engine's rows outlive its catalogue in a workspace this build
     * reopens, and `seed_default_config` deletes only its own retired keys,
     * never an unknown one (that would guess an unexplained row is safe to
     * destroy). Without this check `GET /config` would list settings this build
     * cannot describe and `POST /config` accept writes to them. Populated once
     * by `seed_default_config` from exactly the keys it upserts, never read
     * before the first seed.
     */
    bool is_known_config_key (const std::string& key) const;

    /**
     * @brief SQLite page-cache size in force on the last connection opened, in
     *        bytes (0 before the first): `cache_size` is per connection, so
     *        `dbCacheSize` is re-applied on every open and read back, the only
     *        way to prove the setting arrived (tests, the startup line).
     */
    int applied_cache_size_bytes () const; // db_maintenance.cpp

    /**
     * @brief SQLite's `synchronous` level on this connection, read back rather
     *        than echoed (0 = OFF, 1 = NORMAL, 2 = FULL): it is applied twice
     *        (the compile-time default before the schema sync, `dbSynchronous`
     *        once `init` reads it), and an echoed request would misreport the
     *        level sync and seed run at, SQLite's default (#838).
     */
    int applied_synchronous () const; // db_maintenance.cpp

    /// SQLite's `journal_size_limit` on this connection, bytes (-1 no limit),
    /// read back; nothing if SQLite would not answer. Per connection, like the
    /// above (#2433).
    std::optional<int64_t> applied_journal_size_limit () const; // db_maintenance.cpp

    /// SQLite's `mmap_size` on this connection, bytes (0 unmapped), read back
    /// since SQLite clamps the request; nothing if it would not answer (#2433).
    std::optional<int64_t> applied_mmap_size () const; // db_maintenance.cpp

    /// SQLite's busy timeout on this connection, ms, read back: the
    /// constructor's `startup_busy_timeout` until `init` applies
    /// `dbBusyTimeout`.
    int applied_busy_timeout_ms () const; // db_maintenance.cpp

    // Type-safe config getters
    int get_config_int (const std::string& key, int default_value = 0);
    std::string get_config_string (const std::string& key,
    const std::string& default_value = "");
    bool get_config_bool (const std::string& key, bool default_value = false);
    double get_config_double (const std::string& key, double default_value = 0.0);

    private:
    struct Impl;
    std::unique_ptr<Impl> impl_;

    /// `change_feed`, published to under the DB mutex after the write's
    /// transaction commits (`db/change_feed.hpp`).
    ChangeFeed changes_{ change_feed_id_base_now () };

    /**
     * @brief Whether the database at @p path opens with this build's schema, is
     *        corrupt, or cannot be examined: validates the file and its `.bak`
     *        at construction, and @ref refresh_recovery_backup's snapshot.
     */
    static ProbeResult probe_database (const std::string& path,
    std::chrono::milliseconds busy_timeout); // db_maintenance.cpp

    /**
     * @brief The snapshot, validation and rename both recovery-backup refreshes
     *        share; deciding whether to take one is theirs.
     *
     * @param on_connection given the snapshot's connection before the copy and
     *        `nullptr` before it closes (`vacuum_into`); answering false
     *        refuses the copy.
     * @param validate_by a copy finishing after this is discarded, not
     *        validated.
     */
    std::expected<void, std::string> replace_recovery_backup (
    const std::function<bool (sqlite3*)>& on_connection,
    std::chrono::steady_clock::time_point validate_by); // db_maintenance.cpp

    /// The startup recovery record, read from the marker file at construction
    /// (`recovery()`).
    std::optional<RecoveryRecord> recovery_;

    /// The keys `seed_default_config` upserted last, this build's catalogue
    /// (`is_known_config_key`).
    std::unordered_set<std::string> known_config_keys_;

    /**
     * @brief Delete a run and every child row it owns (ticks, metrics,
     *        results): the one run cascade, used by `delete_run` and
     *        `remove_unexempt_runs`, so a new child table is wired in once.
     *        Caller holds the DB mutex.
     */
    void remove_run_cascade_locked (const std::string& id); // db_runs.cpp

    /**
     * @brief Cascade-delete @p ids in batches, sparing what retention exempts:
     *        `prune_runs`' and `clear_runs`' deleting half. The mutex is taken
     *        per batch of 100 and released between, and each row is re-read
     *        under it, skipping one pinned, back in flight or gone since chosen
     *        (#1906). Answers the ids deleted.
     */
    std::vector<std::string> remove_unexempt_runs (const std::vector<std::string>& ids); // db_runs.cpp

    /**
     * @brief Every collection id in @p root_id's subtree, @p root_id first.
     *
     * The one definition of "the subtree" for the delete cascade, restore and
     * purge; the trash counts run the same walk (`walk_subtree`,
     * db_collections.cpp) over rows the listing already read (#2972), so all
     * four agree. `All` walks stamped and live rows (a restore must find what
     * to put back); `StampedOnly` stops at a live row, what a purge destroys
     * (#1883). The visited set is load-bearing: a `parent_id` cycle from before
     * write-time validation would otherwise loop forever under the global DB
     * mutex (#79), which the caller must hold.
     */
    enum class SubtreeRows : std::uint8_t { All, StampedOnly };
    std::vector<std::string> collection_subtree_locked (const std::string& root_id,
    SubtreeRows rows = SubtreeRows::All); // db_collections.cpp

    /**
     * @brief Destroy a collection subtree or a single request, environment,
     *        example or client certificate outright: examples, requests, then
     *        collections, deepest first.
     *
     * The hard cascade soft delete replaced (#988), the one definition purge
     * and retention use. A collection purge takes stamped collections only
     * (#1883), re-parenting a live one under it to the root, as a restore
     * treats an orphan. Caller holds the DB mutex.
     */
    void purge_collection_locked (const std::string& id);  // db_collections.cpp
    void purge_request_locked (const std::string& id);     // db_requests.cpp
    void purge_environment_locked (const std::string& id); // db_environments.cpp
    void purge_example_locked (const std::string& id);     // db_requests.cpp
    void purge_client_certificate_locked (const std::string& id); // db_credentials.cpp

    /**
     * @brief Destroy the trash entry @p entry names by kind: the one dispatch
     *        explicit purge and the retention sweep share, so no new kind is
     *        purged by one and missed by the other. Throws `std::logic_error`
     *        on an unknown kind. Caller holds the DB mutex.
     */
    void purge_trash_entry_locked (const TrashEntry& entry); // db_collections.cpp

    /**
     * @brief The trash entry for one deleted row, or nothing when @p id names
     *        no *deleted* row.
     *
     * By id, not root: restore and purge take ids, and a cascade-taken row is
     * no root, so roots-only would make re-parenting unreachable and "restore
     * this request" a 404. The listing builds its entries from the same helpers
     * (db_collections.cpp), counting cohorts from rows already read (#2972), so
     * both agree. Caller holds the DB mutex.
     */
    std::optional<TrashEntry> trash_entry_locked (const std::string& id); // db_collections.cpp

    /**
     * @brief Whether the collection @p owner_id names is missing or deleted, as
     *        both halves of a restore ask. An empty optional is the tree root,
     *        not an absent owner. Caller holds the DB mutex.
     */
    bool owner_is_absent_locked (const std::optional<std::string>& owner_id); // database.cpp

    /**
     * @brief `owner_is_absent_locked` for an example, whose owner is a request,
     *        never the root (#2971); listing and restore both ask, so they
     *        agree. Caller holds the DB mutex.
     */
    bool request_is_absent_locked (const std::string& request_id); // db_requests.cpp

    /// A trash root as a refused restore names it (#3449).
    struct TrashRootRef {
        std::string id;
        std::string name;
    };

    /**
     * @brief The listed trash root holding the stamped collection @p
     *        collection_id: up `parent_id` to the stamped collection whose
     *        parent is not stamped; nothing if @p collection_id is not stamped.
     *        Restoring it is the first step that can bring the collection back,
     *        and the one a person sees. Bounded by a visited set, as
     *        `collection_subtree_locked`. Caller holds the DB mutex.
     */
    std::optional<TrashRootRef> collection_trash_root_locked (
    const std::string& collection_id); // db_collections.cpp

    /// `collection_trash_root_locked` for a non-live request: its collection's
    /// root if that is stamped, else the request; nothing without such a row.
    /// Caller holds the DB mutex.
    std::optional<TrashRootRef> request_trash_root_locked (
    const std::string& request_id); // db_collections.cpp

    /**
     * @brief The `OwnerGone` refusal for a request or example whose owner is
     *        not live (#3449): names the entry, its owner and @p root (the
     *        trash root to restore first, by name and id), or "is gone" without
     *        one. @p what starts the message ("Request"), @p owner_noun names
     *        the owner ("collection"). Reads `parent_name`, set whenever the
     *        owner row exists.
     */
    static RestoreFailure owner_not_live_refusal (std::string_view what,
    std::string_view owner_noun,
    const TrashEntry& entry,
    const std::optional<TrashRootRef>& root); // db_collections.cpp

    /**
     * @brief Record that deleting @p request declined its operation under the
     *        bound collection @p collection_id (#3031); nothing if
     *        `spec_operation` names no whole identity. One row per operation
     *        per binding, a later delete taking it over. For `delete_request`
     *        and `delete_collection`, under the DB mutex inside the delete's
     *        transaction.
     */
    void record_declined_operation_locked (const std::string& collection_id,
    const Request& request); // db_requests.cpp

    /// Forgets the record @p request's delete wrote, so a restore hands the
    /// operation back to the sync (#3031). Nothing for a request recording no
    /// operation: a move's record stands (#3446). Scope as
    /// `record_declined_operation_locked`.
    void forget_declined_by_locked (const Request& request); // db_requests.cpp

    /**
     * @brief Update each of @p requests, first recording the decline @p
     *        declined_under names for it off the stored row, before the write
     *        clears its stamp (#3446).
     *
     * Updated, never inserted: a row not stored and live throws
     * `MissingRowError`, as in `apply_reorder`. For `apply_reorder` and
     * `rebind_collection`, under the DB mutex inside their transaction; each
     * write's change goes onto @p changes, published once that commits.
     */
    void update_moved_requests_locked (const std::vector<Request>& requests,
    const std::unordered_map<std::string, std::string>& declined_under,
    std::vector<Change>& changes); // db_collections.cpp

    /**
     * @brief `restore_deleted`'s five shapes, by what a row comes back to: a
     *        request needs a live collection (or refuses), a collection
     *        re-parents to the root instead, an environment needs nothing, an
     *        example a live request with room, a certificate a free target.
     *
     * Named steps, not one function (#1033's rule,
     * `readability-function-cognitive-complexity`). Each takes an entry
     * `trash_entry_locked` proved deleted and needs the DB mutex.
     */
    // The first two are defined in db_collections.cpp, beside restore_deleted.
    std::expected<TrashOutcome, RestoreFailure> restore_request_locked (
    const TrashEntry& entry);
    TrashOutcome restore_collection_locked (const TrashEntry& entry);
    /// Clears the stamp only: no owner, cohort or re-parent; `is_active` stays
    /// false (#2970).
    TrashOutcome restore_environment_locked (const TrashEntry& entry); // db_environments.cpp
    /// Refuses under a non-live request (`OwnerGone`) or at `MAX_PER_REQUEST`
    /// live examples (`OverLimit`); otherwise clears the stamp only (#2971).
    std::expected<TrashOutcome, RestoreFailure> restore_example_locked (
    const TrashEntry& entry); // db_requests.cpp
    /// Refuses while a live entry claims the same host and port
    /// (`TargetTaken`); otherwise clears the stamp and nothing else (#2973).
    std::expected<TrashOutcome, RestoreFailure> restore_client_certificate_locked (
    const TrashEntry& entry); // db_credentials.cpp

    /**
     * @brief Clear `is_active` on every environment except @p keep_id: the one
     *        definition of "at most one active", called by every write that can
     *        store an active environment. Caller holds the DB mutex inside a
     *        transaction, so the switch is atomic, never two or zero active.
     */
    void deactivate_other_environments_locked (const std::string& keep_id); // db_environments.cpp

    /**
     * @brief Refuse a spec write whose target rows moved: `MissingRowError` for
     *        a vanished bound collection or updated request (update, never
     *        resurrect, as `apply_reorder`). Caller holds the DB mutex inside
     *        the write's transaction, so the proof holds when the write lands.
     */
    void verify_spec_sync_rows_locked (const SpecSyncBatch& batch); // db_specs.cpp

    /**
     * @brief Write one spec batch: deletes first, then the document, folders,
     *        binding and rows. Scope as @ref verify_spec_sync_rows_locked:
     *        mutex held, in the transaction, after verifying.
     *
     * @return the changes the batch publishes once its transaction commits.
     */
    std::vector<Change> write_spec_sync_batch_locked (const SpecSyncBatch& batch); // db_specs.cpp

    /**
     * @brief `MissingRowError` for a row of @p rows no longer stored, a
     *        trashed one included: an update carrying the caller's struct would
     *        clear its stamp (#988). Scope as
     *        @ref verify_spec_sync_rows_locked.
     */
    void verify_live_requests_locked (const std::vector<Request>& rows); // db_requests.cpp

    /**
     * @brief Hard-delete each request of @p ids and its examples, appending the
     *        purge each publishes to @p written; one already gone publishes
     *        nothing. Caller holds the DB mutex inside the write's transaction.
     */
    void purge_batch_requests_locked (const std::vector<std::string>& ids,
    std::vector<Change>& written); // db_requests.cpp

    /**
     * @brief Run @p fn under the DB mutex, retrying on a SQLite busy/locked
     *        error.
     *
     * The mutex is released *before* the backoff sleep (@p base times the
     * attempt number, growing for ten steps), so a retry stalls no other
     * endpoint. Non-busy exceptions rethrow at once; busy past @p attempts logs
     * and rethrows; @ref RETRY_UNTIL_LANDED never exhausts, warning on each
     * retry past ten. @p what names the operation in logs.
     */
    static constexpr int RETRY_UNTIL_LANDED = 0;
    void retry_on_busy (const char* what, // database.cpp
    int attempts,
    std::chrono::milliseconds base,
    const std::function<void ()>& fn);
};

} // namespace vayu::db
