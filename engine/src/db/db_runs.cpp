/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db_runs.cpp
 * @brief Runs and every run-scoped artifact: metric ticks, monitor samples,
 * results and their captured bodies, and the webhook inbox's captures
 * (issue #480) (issue #1614).
 */

#include "database_impl.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <expected>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/utils/logger.hpp"

using namespace sqlite_orm;

namespace vayu::db {

// ============================================================================
// Runs - Test execution sessions (load tests or design mode requests)
// ============================================================================

void Database::create_run (const Run& run) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Creating run",
    { { "id", run.id }, { "type", std::string (vayu::to_string (run.type)) } });
    impl_->storage.replace (run);
}

std::optional<Run> Database::get_run (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto runs = impl_->storage.get_all<Run> (where (c (&Run::id) == id));
    if (runs.empty ())
        return std::nullopt;
    return runs.front ();
}

std::optional<Run> Database::get_run_snapshot (const std::string& id) {
    std::lock_guard<std::mutex> lock (impl_->snapshot_reader_mutex);
    auto runs = impl_->snapshot_storage ().get_all<Run> (where (c (&Run::id) == id));
    if (runs.empty ())
        return std::nullopt;
    return runs.front ();
}

void Database::update_run_status (const std::string& id, RunStatus status) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Updating run status",
    { { "id", id }, { "status", std::string (vayu::to_string (status)) } });
    auto run = get_run (id);
    if (run) {
        run->status   = status;
        run->end_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
        impl_->storage.update (*run);
    }
}

void Database::update_run_end_time (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Updating run end_time", { { "id", id } });
    auto run = get_run (id);
    if (run) {
        run->end_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
        impl_->storage.update (*run);
    }
}

void Database::update_run_status_with_retry (const std::string& id, RunStatus status, int max_retries) {
    // Public signature is unchanged (real callers in runs.cpp, execution.cpp,
    // load_strategy.cpp); delegate to the shared busy-retry helper.
    retry_on_busy ("update run status", max_retries,
    std::chrono::milliseconds (100), [&] { update_run_status (id, status); });
}

std::vector<Run> Database::get_all_runs () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<Run> (order_by (&Run::start_time).desc ());
}

namespace {
// `CASE WHEN <unset> THEN 1 ELSE <test> END`: true for every row when the
// filter is unset, and <test> is never evaluated then, because SQLite
// evaluates only the CASE branch it selects (#2548). That matters for more
// than the snapshot's LIKE and JSON parse: `origin` sits past config_snapshot
// in the stored row, so reading it walks the snapshot's overflow pages. An
// `OR` with the bound flag would leave which operand runs first to the
// planner, which is not ours to depend on.
template <class Test> auto unless_unset (bool unset, Test test) {
    return c (case_<bool> ().when (unset, then (true)).else_ (std::move (test)).end ());
}

// Compose the sqlite_orm WHERE for a RunFilter, one `unless_unset` term per
// optional filter, so the same compiled expression serves every filter
// combination (no per-combination branching). `q` is a substring LIKE over
// config_snapshot (see RunFilter's contract).
//
// `collection_id` reads the snapshot as JSON instead. `json_extract` raises a
// SQL error - not NULL - on text that is not JSON, and `sanitize_config_snapshot`
// stores an unparseable body verbatim, so handing it the column directly would
// turn one malformed row into a 500 for the whole page. The inner CASE is the
// guard, on the same only-the-selected-branch rule: `json_extract` is never
// applied to anything but valid JSON. A boolean `json_valid(...) AND ...` guard
// would rely on the planner's evaluation order for the same protection.
//
// A missing `$.scenario.collectionId` extracts as SQL NULL, and NULL equals no
// id, so design and load runs (and a scenario run stored before the snapshot
// carried the key) fall out of the result rather than erroring.
auto run_filter_where (const RunFilter& filter) {
    const bool no_type       = !filter.type.has_value ();
    const bool no_status     = !filter.status.has_value ();
    const bool no_req        = !filter.request_id.has_value ();
    const bool no_q          = !filter.q.has_value () || filter.q->empty ();
    const bool no_collection = !filter.collection_id.has_value ();
    const bool no_baseline   = !filter.baseline.has_value ();
    const bool no_origin     = !filter.origin.has_value ();

    const RunType type_val     = filter.type.value_or (RunType::Design);
    const RunStatus status_val = filter.status.value_or (RunStatus::Pending);
    const std::string req_val  = filter.request_id.value_or ("");
    const std::string q_pat = "%" + (filter.q ? *filter.q : std::string{}) + "%";
    const std::string collection_val = filter.collection_id.value_or ("");
    const bool baseline_val          = filter.baseline.value_or (false);
    const std::string origin_val     = filter.origin.value_or ("");

    // The snapshot when it is JSON, an empty object when it is not - the guard
    // described above, so json_extract below is always handed valid JSON.
    const auto snapshot_json =
    case_<std::string> ()
    .when (json_valid (&Run::config_snapshot), then (&Run::config_snapshot))
    .else_ (std::string{ "{}" })
    .end ();

    return where (unless_unset (no_type, c (&Run::type) == type_val) &&
    unless_unset (no_status, c (&Run::status) == status_val) &&
    unless_unset (no_req, c (&Run::request_id) == req_val) &&
    unless_unset (no_q, like (&Run::config_snapshot, q_pat)) &&
    unless_unset (no_baseline, c (&Run::baseline) == baseline_val) &&
    unless_unset (no_origin, c (&Run::origin) == origin_val) &&
    unless_unset (no_collection,
    json_extract<std::string> (
    snapshot_json, std::string{ "$.scenario.collectionId" }) == collection_val));
}
} // namespace

std::vector<Run>
Database::get_runs_paginated (const RunFilter& filter, int64_t limit, int64_t offset) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<Run> (run_filter_where (filter),
    order_by (&Run::start_time).desc (), sqlite_orm::limit (offset, limit));
}

int64_t Database::count_runs (const RunFilter& filter) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<Run> (run_filter_where (filter));
}

// The run cascade in one place: every child table a run owns, deleted before
// the run row itself. delete_run and remove_unexempt_runs both go through this,
// so a new child table cannot be added to one and forgotten in another
// (metric_ticks was added to both by editing only this function). Caller holds
// the mutex.
void Database::remove_run_cascade_locked (const std::string& id) {
    impl_->storage.remove_all<MetricTick> (where (c (&MetricTick::run_id) == id));
    impl_->storage.remove_all<MonitorSample> (where (c (&MonitorSample::run_id) == id));
    // Captured bodies before the results they hang off, so a delete interrupted
    // between the two leaves results without bodies rather than body rows
    // pointing at nothing. `maxRunsRetained` doubles as the expiry for anything
    // credential-shaped a capture picked up, which is what makes this cascade
    // load-bearing rather than housekeeping.
    impl_->storage.remove_all<ResultBody> (where (c (&ResultBody::run_id) == id));
    impl_->storage.remove_all<BodyBlob> (where (c (&BodyBlob::run_id) == id));
    impl_->storage.remove_all<Result> (where (c (&Result::run_id) == id));
    impl_->storage.remove<Run> (id);
}

// Cascade delete: removes ticks and results first
void Database::delete_run (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    remove_run_cascade_locked (id);
}

// Retried like every other write here, and for a sharper reason: this row is
// the *only* record of a run's whole-run aggregates, and a lock lost here is
// not a lost tick - it is a report that falls back to the sampled results and
// renders the run's whole-run figures wrong, permanently. The read-modify-write
// runs inside the retried callback so a retry re-reads the row rather than
// replaying a stale copy over a status the worker updated in between.
void Database::update_run_summary (const std::string& id, const std::string& summary) {
    retry_on_busy ("store run summary", 5, std::chrono::milliseconds (100), [&] {
        auto run = get_run (id);
        if (!run) {
            vayu::utils::log_warning (
            "db", "Run summary write skipped, run not found: " + id);
            return;
        }
        run->summary = summary;
        // Derived here, from the same bytes about to be stored, rather than
        // taken as a second parameter every caller would have to keep in sync
        // by hand (issue #1527). A summary that fails to parse or carries no
        // `warnings` array leaves the flag false.
        const auto parsed =
        nlohmann::json::parse (summary, nullptr, /*allow_exceptions=*/false);
        run->has_warnings = parsed.is_object () && parsed.contains ("warnings") &&
        parsed["warnings"].is_array () && !parsed["warnings"].empty ();
        impl_->storage.update (*run);
    });
}

// Pin or unpin a run as a baseline. Retried like every other write here, and
// the read-modify-write sits inside the retried callback so a retry re-reads
// the row rather than replaying a stale copy over a summary or a status a
// worker wrote in between. Returns the stored row, or nullopt when there is no
// such run - which is what lets the route answer 404 instead of inventing one.
std::optional<Run> Database::set_run_baseline (const std::string& id, bool baseline) {
    std::optional<Run> updated;
    retry_on_busy ("set run baseline", 5, std::chrono::milliseconds (100), [&] {
        auto run = get_run (id);
        if (!run) {
            updated.reset ();
            return;
        }
        run->baseline = baseline;
        impl_->storage.update (*run);
        updated = *run;
    });
    return updated;
}

namespace {
// What retention never deletes and never counts toward a cap: a run still
// in flight, and a run pinned as a baseline. Read at selection and again,
// per row, under each delete batch's lock.
bool exempt_from_retention (const Run& run) {
    return run.baseline || run.status == RunStatus::Running ||
    run.status == RunStatus::Pending;
}

// One count cap and how many runs it has kept so far. Retention keeps one per
// kind (#2429): a design Send is cheap and frequent, and counted with the load
// and collection runs it evicted them within an afternoon.
struct CountCap {
    int limit = 0; // 0 = unlimited
    int kept  = 0;

    bool full () const {
        return limit > 0 && kept >= limit;
    }
};

// Newest first in, victims out: a run is a victim once its kind's cap is full
// or it is older than @p age_cutoff (0 = no age cap).
std::vector<std::string> select_retention_victims (const std::vector<Run>& newest_first,
CountCap compared,
CountCap design,
int64_t age_cutoff) {
    std::vector<std::string> victims;
    for (const auto& run : newest_first) {
        // Skipped rather than merely spared: counting an exempt run toward
        // the cap would let a handful of pins evict the recent history the
        // cap exists to keep.
        if (exempt_from_retention (run)) {
            continue;
        }
        CountCap& cap      = run.type == RunType::Design ? design : compared;
        const bool too_old = age_cutoff > 0 && run.start_time < age_cutoff;
        if (cap.full () || too_old) {
            victims.push_back (run.id);
        } else {
            ++cap.kept;
        }
    }
    return victims;
}
} // namespace

// Retention: drop runs beyond their kind's count cap and/or older than the age cap.
void Database::prune_runs (int max_runs,
int max_age_days,
const std::function<void ()>& after_selection,
int max_design_runs) {
    // Every limit off - nothing to do (0 = unlimited for each).
    if (max_runs <= 0 && max_design_runs <= 0 && max_age_days <= 0) {
        return;
    }

    // 1. Select victim ids under the lock, then release it before deleting so
    //    the (potentially large) delete loop batches its own locking below.
    std::vector<std::string> victims;
    {
        std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

        // Newest first, matching get_all_runs / the count cap's "most-recent N".
        auto runs = impl_->storage.get_all<Run> (order_by (&Run::start_time).desc ());

        const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                            .count ();
        // 0 disables the age cap; guard the multiply against overflow.
        const int64_t age_cutoff = max_age_days > 0 ?
        now - (static_cast<int64_t> (max_age_days) * 86'400'000LL) :
        0;

        victims = select_retention_victims (runs, CountCap{ .limit = max_runs },
        CountCap{ .limit = max_design_runs }, age_cutoff);
    }

    if (victims.empty ()) {
        return;
    }
    if (after_selection) {
        after_selection ();
    }

    const size_t pruned = remove_unexempt_runs (victims).size ();
    if (pruned == 0) {
        return;
    }
    vayu::utils::log_info ("db", "Pruned old runs",
    { { "count", pruned }, { "maxRuns", max_runs },
    { "maxDesignRuns", max_design_runs }, { "maxAgeDays", max_age_days } });
}

// Batched so a huge backlog does not hold the DB mutex for seconds: the lock is
// re-taken per batch and released between them, letting /health, SSE and the
// runs poll interleave. Each id is re-read under its batch's lock (#1906): a
// run pinned since the caller chose it (`set_run_baseline`) answered its
// caller 200, and the caller's copy of the row no longer says so.
std::vector<std::string> Database::remove_unexempt_runs (
const std::vector<std::string>& ids) {
    constexpr size_t BATCH_SIZE = 100;
    std::vector<std::string> removed;
    for (size_t start = 0; start < ids.size (); start += BATCH_SIZE) {
        const size_t end = std::min (start + BATCH_SIZE, ids.size ());
        std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
        impl_->storage.transaction ([&] {
            for (size_t i = start; i < end; ++i) {
                const auto current = get_run (ids[i]);
                if (!current || exempt_from_retention (*current)) {
                    continue;
                }
                remove_run_cascade_locked (ids[i]);
                removed.push_back (ids[i]);
            }
            return true; // Commit
        });
    }
    return removed;
}

RunHistoryCleared Database::clear_runs () {
    std::vector<std::string> ids;
    {
        std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
        ids = impl_->storage.select (&Run::id);
    }

    RunHistoryCleared cleared;
    cleared.deleted_ids = remove_unexempt_runs (ids);
    RunFilter pinned;
    pinned.baseline     = true;
    cleared.kept_pinned = count_runs (pinned);
    vayu::utils::log_info ("db", "Cleared run history",
    { { "count", cleared.deleted_ids.size () }, { "keptPinned", cleared.kept_pinned } });
    return cleared;
}

size_t Database::reconcile_orphaned_runs () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    auto orphans = impl_->storage.get_all<Run> (where (
    c (&Run::status) == RunStatus::Running || c (&Run::status) == RunStatus::Pending));
    if (orphans.empty ()) {
        return 0;
    }

    // end_time is deliberately left as recorded. When the process died is
    // unknowable now, and stamping the restart time would invent a duration
    // spanning however long the daemon was down. What is recorded is never
    // indeterminate: `Run::end_time` defaults to 0 and both route inserts seed
    // it to start_time (seed_run_times in execution.cpp), while
    // update_run_end_time may since have refined it.
    impl_->storage.transaction ([&] {
        for (auto& run : orphans) {
            run.status = RunStatus::Failed;
            impl_->storage.update (run);
        }
        return true; // Commit
    });

    vayu::utils::log_info ("db",
    "Reconciled " + std::to_string (orphans.size ()) +
    " run(s) left in-flight by a previous process (marked failed)");
    return orphans.size ();
}

void Database::prune_runs_configured () {
    const int max_runs = get_config_int (
    "maxRunsRetained", vayu::core::constants::database::MAX_RUNS_RETAINED);
    const int max_design_runs = get_config_int ("maxDesignRunsRetained",
    vayu::core::constants::database::MAX_DESIGN_RUNS_RETAINED);
    const int max_age_days    = get_config_int (
    "runRetentionDays", vayu::core::constants::database::RUN_RETENTION_DAYS);
    prune_runs (max_runs, max_age_days, nullptr, max_design_runs);
    // A run that has just been pruned may have been the last thing naming an
    // OpenAPI document (issue #718). Retention is where that reference is
    // released, so it is where the release is noticed - and this is what puts
    // the sweep on both a startup and the end of every run without a schedule
    // of its own. Never throws; see the declaration.
    sweep_orphaned_spec_documents ();
}

// ============================================================================
// Metric ticks - one wide row per tick (the current time-series storage)
// ============================================================================

void Database::add_metric_tick (const MetricTick& tick) {
    retry_on_busy ("add metric tick", 5, std::chrono::milliseconds (100),
    [&] { impl_->storage.insert (tick); });
}

std::vector<MetricTick>
Database::get_metric_ticks_paginated (const std::string& run_id, int64_t limit, int64_t offset) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<MetricTick> (where (c (&MetricTick::run_id) == run_id),
    multi_order_by (order_by (&MetricTick::timestamp), order_by (&MetricTick::id)),
    sqlite_orm::limit (offset, limit));
}

std::vector<MetricTick>
Database::get_metric_ticks_since (const std::string& run_id, int64_t last_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<MetricTick> (
    where (c (&MetricTick::run_id) == run_id && c (&MetricTick::id) > last_id),
    order_by (&MetricTick::id));
}

int64_t Database::count_metric_ticks (const std::string& run_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<MetricTick> (where (c (&MetricTick::run_id) == run_id));
}

// ============================================================================
// Monitor samples - external server vitals scraped alongside a run
// ============================================================================

void Database::add_monitor_sample (const MonitorSample& sample) {
    retry_on_busy ("add monitor sample", 5, std::chrono::milliseconds (100),
    [&] { impl_->storage.insert (sample); });
}

std::vector<MonitorSample>
Database::get_monitor_samples_paginated (const std::string& run_id, int64_t limit, int64_t offset) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<MonitorSample> (where (c (&MonitorSample::run_id) == run_id),
    multi_order_by (order_by (&MonitorSample::timestamp), order_by (&MonitorSample::id)),
    sqlite_orm::limit (offset, limit));
}

int64_t Database::count_monitor_samples (const std::string& run_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<MonitorSample> (where (c (&MonitorSample::run_id) == run_id));
}

// ============================================================================
// Inbox captures - what a webhook inbox listener recorded (issue #480)
// ============================================================================

int Database::add_inbox_request (const InboxRequest& capture, int64_t max_captures) {
    int assigned_id = 0;
    retry_on_busy ("append inbox capture", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            assigned_id = impl_->storage.insert (capture);

            if (max_captures > 0) {
                const int64_t stored = impl_->storage.count<InboxRequest> (
                where (c (&InboxRequest::inbox_id) == capture.inbox_id));
                if (stored > max_captures) {
                    // Delete by id rather than "everything older than the Nth
                    // received_at": two captures can share a millisecond, and a
                    // timestamp cutoff would then evict both or neither.
                    auto victims = impl_->storage.select (&InboxRequest::id,
                    where (c (&InboxRequest::inbox_id) == capture.inbox_id),
                    order_by (&InboxRequest::id),
                    sqlite_orm::limit (stored - max_captures));
                    for (const int victim : victims) {
                        impl_->storage.remove<InboxRequest> (victim);
                    }
                }
            }
            return true; // Commit
        });
    });
    return assigned_id;
}

std::vector<InboxRequest>
Database::get_inbox_requests_paginated (const std::string& inbox_id, int64_t limit, int64_t offset) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<InboxRequest> (
    where (c (&InboxRequest::inbox_id) == inbox_id),
    order_by (&InboxRequest::id).desc (), sqlite_orm::limit (offset, limit));
}

int64_t Database::count_inbox_requests (const std::string& inbox_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<InboxRequest> (
    where (c (&InboxRequest::inbox_id) == inbox_id));
}

std::vector<InboxRequest>
Database::get_inbox_requests_since (const std::string& inbox_id, int64_t last_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<InboxRequest> (
    where (c (&InboxRequest::inbox_id) == inbox_id && c (&InboxRequest::id) > last_id),
    order_by (&InboxRequest::id));
}

int64_t Database::clear_inbox_requests (const std::string& inbox_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    const int64_t removed = impl_->storage.count<InboxRequest> (
    where (c (&InboxRequest::inbox_id) == inbox_id));
    impl_->storage.remove_all<InboxRequest> (where (c (&InboxRequest::inbox_id) == inbox_id));
    return removed;
}

int64_t Database::clear_inbox_requests_all () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    const int64_t removed = impl_->storage.count<InboxRequest> ();
    if (removed > 0) {
        impl_->storage.remove_all<InboxRequest> ();
    }
    return removed;
}

// ============================================================================
// Results - Individual request outcomes with timing breakdown
// ============================================================================

void Database::add_result (const Result& result) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    impl_->storage.insert (result);
}

namespace {

using BlobIds = std::map<std::string, int>;

/// How long add_results_batch stays off the DB mutex between chunks. The mutex
/// is not fair: a writer that re-locks at once, or after `yield ()`, takes it
/// back before the reader it woke is scheduled: with `yield ()` a reader
/// waited out a whole 10,000-row flush (520 ms in a Debug build). Sleeping lets
/// the woken reader in, and it then waited at most one chunk. 1 ms rather than
/// less leaves room for a busy machine; it adds 4 ms per 1,000 rows to the
/// ~27 ms writing them takes in a Release build.
constexpr auto CHUNK_HANDOFF_PAUSE = std::chrono::milliseconds (1);

/// `bodies` grouped by the chunk their result is written in. An index with no
/// result is dropped: there is nothing to attach it to.
std::vector<std::vector<const PendingResultBody*>> group_bodies_by_chunk (
const std::vector<PendingResultBody>& bodies,
size_t result_count,
size_t chunk_rows) {
    std::vector<std::vector<const PendingResultBody*>> groups (
    (result_count + chunk_rows - 1) / chunk_rows);
    for (const auto& pending : bodies) {
        if (pending.result_index < result_count) {
            groups.at (pending.result_index / chunk_rows).push_back (&pending);
        }
    }
    return groups;
}

/// The blob row holding `pending`'s body: one an earlier chunk committed, one
/// this attempt already wrote, or a new one recorded in `fresh`.
int blob_id_for (Storage& storage,
const PendingResultBody& pending,
const std::string& run_id,
const BlobIds& committed,
BlobIds& fresh) {
    if (const auto it = committed.find (pending.body_hash); it != committed.end ()) {
        return it->second;
    }
    if (const auto it = fresh.find (pending.body_hash); it != fresh.end ()) {
        return it->second;
    }
    BodyBlob blob;
    blob.run_id  = run_id;
    blob.hash    = pending.body_hash;
    blob.content = pending.body;
    const int id = storage.insert (blob);
    fresh.emplace (pending.body_hash, id);
    return id;
}

/// Inserts `results[begin, end)` and the bodies attached to them, inside the
/// caller's transaction.
void insert_results_chunk (Storage& storage,
const std::vector<Result>& results,
size_t begin,
size_t end,
const std::vector<const PendingResultBody*>& bodies,
const BlobIds& committed_blob_ids,
BlobIds& fresh_blob_ids) {
    // Row ids only exist after the insert, so keep them alongside the batch
    // positions the pending bodies refer to.
    std::vector<int> result_ids;
    result_ids.reserve (end - begin);
    for (size_t i = begin; i < end; ++i) {
        result_ids.push_back (storage.insert (results.at (i)));
    }

    for (const PendingResultBody* pending : bodies) {
        const Result& result = results.at (pending->result_index);
        ResultBody row;
        row.result_id     = result_ids.at (pending->result_index - begin);
        row.run_id        = result.run_id;
        row.headers       = pending->headers;
        row.blob_id       = pending->body_hash.empty () ?
              0 :
              blob_id_for (storage, *pending, result.run_id, committed_blob_ids, fresh_blob_ids);
        row.body_bytes    = pending->body_bytes;
        row.truncated     = pending->truncated;
        row.is_binary     = pending->binary;
        row.content_type  = pending->content_type;
        row.stream_events = pending->stream_events;
        storage.replace (row);
    }
}

} // namespace

// One transaction and one mutex acquisition per RESULTS_WRITE_CHUNK_ROWS rows
// (#2548): a whole flush in one held the mutex for 240-400 ms, and every other
// DB caller, the live report poll included, waited behind it.
void Database::add_results_batch (const std::vector<Result>& results,
const std::vector<PendingResultBody>& bodies) {
    if (results.empty ()) {
        return;
    }

    constexpr size_t chunk_rows = vayu::core::constants::database::RESULTS_WRITE_CHUNK_ROWS;
    const auto chunk_bodies = group_bodies_by_chunk (bodies, results.size (), chunk_rows);

    // Dedup spans the whole call, so identical bodies (the norm for a load
    // test) share one blob row across chunks. A chunk's new blobs join it only
    // once that chunk commits.
    BlobIds committed_blob_ids;
    for (size_t chunk = 0; chunk < chunk_bodies.size (); ++chunk) {
        if (chunk > 0) {
            std::this_thread::sleep_for (CHUNK_HANDOFF_PAUSE);
        }
        const size_t begin = chunk * chunk_rows;
        const size_t end   = std::min (begin + chunk_rows, results.size ());

        BlobIds fresh_blob_ids;
        retry_on_busy ("flush results batch", 5, std::chrono::milliseconds (100), [&] {
            // Per attempt on purpose: a retried transaction re-inserts the
            // blobs it rolled back.
            fresh_blob_ids.clear ();
            impl_->storage.transaction ([&] {
                insert_results_chunk (impl_->storage, results, begin, end,
                chunk_bodies[chunk], committed_blob_ids, fresh_blob_ids);
                return true; // Commit
            });
        });
        committed_blob_ids.merge (fresh_blob_ids);
    }
}

std::vector<Result> Database::get_results (const std::string& run_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<Result> (where (c (&Result::run_id) == run_id));
}

std::vector<Result> Database::get_results_without_traces (const std::string& run_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows = impl_->storage.select (
    columns (&Result::id, &Result::timestamp, &Result::status_code,
    &Result::status_text, &Result::latency_ms, &Result::error),
    where (c (&Result::run_id) == run_id), order_by (&Result::id));

    std::vector<Result> results;
    results.reserve (rows.size ());
    for (auto& [id, timestamp, status_code, status_text, latency_ms, error] : rows) {
        Result& result     = results.emplace_back ();
        result.id          = id;
        result.run_id      = run_id;
        result.timestamp   = timestamp;
        result.status_code = status_code;
        result.status_text = std::move (status_text);
        result.latency_ms  = latency_ms;
        result.error       = std::move (error);
    }
    return results;
}

std::unordered_map<std::string, DesignResultOutcome>
Database::get_design_result_outcomes (const std::vector<std::string>& run_ids) {
    std::unordered_map<std::string, DesignResultOutcome> outcomes;
    if (run_ids.empty ()) {
        return outcomes; // No statement at all rather than `IN ()`.
    }

    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // The design-run subquery is inside the statement on purpose: it is what
    // makes "a load run's results are never read" a property of the query
    // rather than of every caller passing the right ids. Three columns, so a
    // page of rows costs no trace_data.
    auto rows = impl_->storage.select (
    columns (&Result::run_id, &Result::status_code, &Result::latency_ms),
    where (in (&Result::run_id, run_ids) &&
    in (&Result::run_id, select (&Run::id, where (c (&Run::type) == RunType::Design)))));

    for (const auto& row : rows) {
        // A design run has exactly one result; keep the first if a row ever
        // duplicates rather than letting the last write win silently.
        outcomes.emplace (std::get<0> (row),
        DesignResultOutcome{ std::get<1> (row), std::get<2> (row) });
    }
    return outcomes;
}

std::vector<ResultBody>
Database::get_result_bodies_paginated (const std::string& run_id, int64_t limit, int64_t offset) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<ResultBody> (where (c (&ResultBody::run_id) == run_id),
    order_by (&ResultBody::result_id), sqlite_orm::limit (offset, limit));
}

int64_t Database::count_result_bodies (const std::string& run_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.count<ResultBody> (where (c (&ResultBody::run_id) == run_id));
}

std::string Database::get_body_blob_content (int blob_id) {
    if (blob_id == 0) {
        return {}; // No stored body: binary, absent, or dropped for budget.
    }
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // get_all + where rather than a by-primary-key lookup, matching every other
    // single-row read in this file (get_run, get_request, ...) - one idiom, and
    // a missing row is an empty vector rather than a throw or a null to handle.
    auto blobs = impl_->storage.get_all<BodyBlob> (where (c (&BodyBlob::id) == blob_id));
    return blobs.empty () ? std::string{} : blobs.front ().content;
}

} // namespace vayu::db
