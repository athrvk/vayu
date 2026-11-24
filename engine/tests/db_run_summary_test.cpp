/**
 * @file tests/db_run_summary_test.cpp
 * @brief Database run results: startup space reclamation, metric ticks, the stored run summary, the
 * `runs.outcome` stamp and the scratch-file cleanup.
 *
 * The `DatabaseTest` fixture is in `database_fixture.hpp`.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <set>
#include <string>

#include "database_fixture.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/utils/diagnostics.hpp"

namespace vayu::db {

namespace {

// ============================================================================
// Startup reclamation - freed pages return to the filesystem (issue #990)
// ============================================================================

namespace {

// A run whose one result carries `body_bytes` of trace, so deleting it frees a
// known and substantial number of pages rather than a handful.
//
// The filler concatenation below is what GCC 13 reports as reading past the
// small-string buffer at `-O3` (see utils/diagnostics.hpp) - but only once
// this is inlined into `grow_then_prune`'s loop, which is the frame the
// diagnostic actually attributes the read to; a suppression scoped to this
// function alone left it firing. The pop sits after `grow_then_prune`
// instead of here, so the region covers the whole inlining chain the
// diagnostic can be blamed on.
VAYU_IGNORE_FALSE_STRING_CONCAT_BOUNDS
void seed_bulky_run (Database& db, const std::string& id, int64_t start_time, size_t body_bytes) {
    vayu::db::Run run;
    run.id     = id;
    run.type   = vayu::RunType::Load; // the kind `prune_runs (keep, 0)` counts
    run.status = vayu::RunStatus::Completed;
    run.start_time      = start_time;
    run.config_snapshot = "{}";
    db.create_run (run);

    vayu::db::Result r;
    r.run_id      = id;
    r.timestamp   = start_time;
    r.status_code = 200;
    r.status_text = "OK";
    r.latency_ms  = 1.0;
    r.trace_data  = R"({"body":")" + std::string (body_bytes, 'x') + R"("})";
    db.add_result (r);
}

constexpr size_t MIB = size_t{ 1024 } * 1024;

int64_t database_file_size () {
    std::error_code ec;
    const auto size = std::filesystem::file_size (TEST_DB_PATH, ec);
    return ec ? -1 : static_cast<int64_t> (size);
}

// Grow the database to `total_mib` one-MiB runs, then prune it down to `keep`
// of them, and answer with the size the file reached. What the caller gets is a
// database whose freelist holds `total_mib - keep` MiB.
//
// The runs are stamped from the wall clock rather than from a counter: the
// startup prune this file's reclamation follows reads `runRetentionDays`, so
// runs stamped in 1970 are all deleted by the *next* start and every case below
// would be measuring an empty database.
int64_t grow_then_prune (int total_mib, int keep) {
    const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
    Database db (TEST_DB_PATH);
    db.init ();
    for (int i = 1; i <= total_mib; ++i) {
        seed_bulky_run (db, "bulk_" + std::to_string (i), now - (int64_t{ i } * 1000), MIB);
    }
    db.prune_runs (keep, 0);
    return database_file_size ();
}
VAYU_DIAGNOSTIC_POP

// What a second start leaves the file at. The reclamation runs in `init`, so
// every case below opens the database again rather than calling anything: what
// is under test is what a start does.
int64_t size_after_a_restart () {
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    return database_file_size ();
}

} // namespace

struct ReclamationCase {
    const char* name;
    int total_mib;
    int keep;
    /// The grown file must exceed this, or the seeded bodies never reached it
    /// and the case proves nothing.
    int64_t min_grown_mib;
    bool expect_reclaim;
};

constexpr auto RECLAMATION_CASES = std::to_array<ReclamationCase> ({
// 24 MiB down to one: past both thresholds, and by a wide enough margin that
// neither the page size nor the schema's own pages matter. Mutation check:
// take the reclamation back out of `init` and the file is still `grown`.
{ "ReclaimsAHeavilyPrunedDatabase", 24, 1, 12, true },
// 4 MiB down to one: nearly all freelist, so the *fraction* is crossed
// several times over and only the 10 MiB floor declines it. Mutation check:
// drop VACUUM_MIN_RECLAIMABLE_BYTES to zero and this reddens.
{ "LeavesADatabaseBelowTheByteFloorAlone", 4, 1, 2, false },
// 60 MiB down to 48: twelve of them freed, which is past the 10 MiB floor
// and a fifth of the file - so only the fraction declines it. Mutation check:
// drop VACUUM_MIN_FREELIST_PERCENT to zero and this reddens.
{ "LeavesADatabaseBelowTheFreelistFractionAlone", 60, 48, 55, false },
});

class StartupReclamationTest
: public DatabaseTest,
  public ::testing::WithParamInterface<ReclamationCase> {};

TEST_P (StartupReclamationTest, ReclaimsOnlyPastBothThresholds) {
    const auto& c       = GetParam ();
    const int64_t grown = grow_then_prune (c.total_mib, c.keep);
    ASSERT_GT (grown, c.min_grown_mib * static_cast<int64_t> (MIB))
    << "the seeded bodies never reached the file, so this proves nothing";

    const int64_t after = size_after_a_restart ();
    if (c.expect_reclaim) {
        EXPECT_LT (after, grown / 2)
        << "the freed pages were not returned to the filesystem (" << grown
        << " -> " << after << ")";
    } else {
        // Never smaller - a rewrite would give most of the freelist back. Not
        // byte-equal, because a start writes a page of its own.
        EXPECT_GE (after, grown)
        << "a database under a threshold was rewritten anyway (" << grown
        << " -> " << after << ")";
    }
}

INSTANTIATE_TEST_SUITE_P (Startup,
StartupReclamationTest,
::testing::ValuesIn (RECLAMATION_CASES),
[] (const ::testing::TestParamInfo<ReclamationCase>& info) {
    return std::string (info.param.name);
});

// ============================================================================
// Metric ticks + the stored run summary (the wide-row time series)
// ============================================================================

TEST_F (DatabaseTest, MetricTicksRoundTripInTimestampOrder) {
    Database db (TEST_DB_PATH);
    db.init ();

    vayu::db::Run run;
    run.id              = "run_1";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = 1000;
    run.config_snapshot = "{}";
    db.create_run (run);

    // Inserted out of order: the reader, not the writer, owns the ordering.
    for (int64_t ts : { 3000, 1000, 2000 }) {
        vayu::db::MetricTick tick;
        tick.run_id    = "run_1";
        tick.timestamp = ts;
        tick.payload   = R"({"timestamp":)" + std::to_string (ts) + "}";
        db.add_metric_tick (tick);
    }

    EXPECT_EQ (db.count_metric_ticks ("run_1"), 3);

    auto page = db.get_metric_ticks_paginated ("run_1", 10, 0);
    ASSERT_EQ (page.size (), 3u);
    EXPECT_EQ (page[0].timestamp, 1000);
    EXPECT_EQ (page[1].timestamp, 2000);
    EXPECT_EQ (page[2].timestamp, 3000);

    // A page is a window over that same order.
    auto second = db.get_metric_ticks_paginated ("run_1", 1, 1);
    ASSERT_EQ (second.size (), 1u);
    EXPECT_EQ (second[0].timestamp, 2000);

    // get_metric_ticks_since is the incremental cursor the legacy SSE poll
    // uses: it walks insertion order (id), not timestamp order, so a late
    // arrival is still delivered exactly once.
    auto all_since = db.get_metric_ticks_since ("run_1", 0);
    ASSERT_EQ (all_since.size (), 3u);
    EXPECT_EQ (all_since[0].timestamp, 3000); // inserted first
    const int64_t last_id = all_since.back ().id;
    EXPECT_TRUE (db.get_metric_ticks_since ("run_1", last_id).empty ());
    EXPECT_EQ (db.get_metric_ticks_since ("run_1", all_since[0].id).size (), 2u);
}

TEST_F (DatabaseTest, DeleteRunCascadesMetricTicks) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_run_with_children (db, "run_1", 1000);
    seed_run_with_children (db, "run_2", 2000);
    ASSERT_EQ (db.count_metric_ticks ("run_1"), 1);

    db.delete_run ("run_1");

    EXPECT_EQ (db.count_metric_ticks ("run_1"), 0);
    // The other run's ticks are untouched.
    EXPECT_EQ (db.count_metric_ticks ("run_2"), 1);
}

TEST_F (DatabaseTest, RunSummaryRoundTrips) {
    Database db (TEST_DB_PATH);
    db.init ();

    vayu::db::Run run;
    run.id              = "run_1";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Completed;
    run.start_time      = 1000;
    run.config_snapshot = "{}";
    db.create_run (run);

    // A fresh run has no summary - that emptiness is what the report route
    // reads as "fall back to the legacy metrics rows".
    auto before = db.get_run ("run_1");
    ASSERT_HAS_VALUE (before);
    EXPECT_TRUE (before->summary.empty ());

    db.update_run_summary ("run_1", R"({"total_requests":42})");

    auto after = db.get_run ("run_1");
    ASSERT_HAS_VALUE (after);
    EXPECT_EQ (after->summary, R"({"total_requests":42})");
    // Writing the summary must not disturb the rest of the row.
    EXPECT_EQ (after->status, vayu::RunStatus::Completed);
    EXPECT_EQ (after->start_time, 1000);
}

TEST_F (DatabaseTest, UpdateRunSummaryForMissingRunIsIgnored) {
    Database db (TEST_DB_PATH);
    db.init ();

    // A run deleted while its worker was finishing must not create a row or throw.
    EXPECT_NO_THROW (db.update_run_summary ("run_gone", R"({"total_requests":1})"));
    EXPECT_FALSE (db.get_run ("run_gone").has_value ());
}

// Issue #1527: `has_warnings` is derived from the same bytes `update_run_summary`
// stores, never set anywhere else - these mutation-check the derivation both
// ways, so a change that drops it (or that always sets it) reddens one of them.
TEST_F (DatabaseTest, UpdateRunSummaryStampsHasWarningsWhenWarningsIsNonEmpty) {
    Database db (TEST_DB_PATH);
    db.init ();

    vayu::db::Run run;
    run.id              = "run_1";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Completed;
    run.start_time      = 1000;
    run.config_snapshot = "{}";
    db.create_run (run);

    db.update_run_summary (
    "run_1", R"({"warnings":[{"code":"unresolved_tokens","message":"x"}]})");

    auto after = db.get_run ("run_1");
    ASSERT_HAS_VALUE (after);
    EXPECT_TRUE (after->has_warnings);
}

TEST_F (DatabaseTest, UpdateRunSummaryLeavesHasWarningsFalseWhenWarningsIsAbsentOrEmpty) {
    Database db (TEST_DB_PATH);
    db.init ();

    vayu::db::Run run;
    run.id              = "run_1";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Completed;
    run.start_time      = 1000;
    run.config_snapshot = "{}";
    db.create_run (run);

    db.update_run_summary ("run_1", R"({"total_requests":42})");
    auto after_absent = db.get_run ("run_1");
    ASSERT_HAS_VALUE (after_absent);
    EXPECT_FALSE (after_absent->has_warnings);

    db.update_run_summary ("run_1", R"({"total_requests":42,"warnings":[]})");
    auto after_empty = db.get_run ("run_1");
    ASSERT_HAS_VALUE (after_empty);
    EXPECT_FALSE (after_empty->has_warnings);

    // A summary a later write cannot parse must not crash and must not stamp
    // a stale true forward.
    db.update_run_summary ("run_1", "not json at all");
    auto after_malformed = db.get_run ("run_1");
    ASSERT_HAS_VALUE (after_malformed);
    EXPECT_FALSE (after_malformed->has_warnings);
}

// ==================== runs.outcome (#3547) ====================

// The load path stores the summary before the final status, so the summary
// write finds a Running row and stamps nothing, and the terminal move stamps
// the verdict. Mutation check: drop `stamp_run_outcome` from
// `transition_run_status` and every outcome below stays null.
TEST_F (DatabaseTest, ATerminalTransitionStampsTheRowsOutcome) {
    Database db (TEST_DB_PATH);
    db.init ();
    const int64_t recent = now_ms ();
    seed_running_run (db, "missed", recent);
    seed_running_run (db, "met", recent + 1);
    seed_running_run (db, "unbudgeted", recent + 2);
    seed_running_run (db, "clean_collection", recent + 3, vayu::RunType::Scenario);
    seed_running_run (db, "failed_collection", recent + 4, vayu::RunType::Scenario);

    db.update_run_summary ("missed", MISSED_BUDGET_SUMMARY);
    EXPECT_EQ (stored_outcome (db, "missed"), std::nullopt)
    << "a Running row's summary is not final";
    db.transition_run_status (
    "missed", { vayu::RunStatus::Running }, vayu::RunStatus::Completed);
    finish_run (db, "met", MET_BUDGET_SUMMARY, vayu::RunStatus::Completed);
    finish_run (db, "unbudgeted", NO_BUDGET_SUMMARY, vayu::RunStatus::Completed);
    finish_run (db, "clean_collection",
    R"({"scenario":{"passed":3,"failed":0,"errored":0}})", vayu::RunStatus::Completed);
    finish_run (db, "failed_collection",
    R"({"scenario":{"passed":2,"failed":1,"errored":0}})", vayu::RunStatus::Completed);

    EXPECT_EQ (stored_outcome (db, "missed"), "failed");
    EXPECT_EQ (stored_outcome (db, "met"), "passed");
    EXPECT_EQ (stored_outcome (db, "unbudgeted"), "not_judged");
    EXPECT_EQ (stored_outcome (db, "clean_collection"), std::nullopt)
    << "a clean collection run is never judged passed";
    EXPECT_EQ (stored_outcome (db, "failed_collection"), "failed");
}

// A Stop's status can land before the worker's summary (the inactive branch
// of POST /runs/:id/stop), so the summary write stamps a row already terminal.
// Mutation check: drop `stamp_run_outcome` from `update_run_summary` and the
// stopped row keeps no outcome.
TEST_F (DatabaseTest, ASummaryLandingOnATerminalRowStampsItsOutcome) {
    Database db (TEST_DB_PATH);
    db.init ();
    seed_running_run (db, "stopped_first", now_ms ());
    db.transition_run_status (
    "stopped_first", { vayu::RunStatus::Running }, vayu::RunStatus::Stopped);
    EXPECT_EQ (stored_outcome (db, "stopped_first"), std::nullopt)
    << "a Stop with no summary yet has no row summary to judge";

    db.update_run_summary ("stopped_first", MET_BUDGET_SUMMARY);
    EXPECT_EQ (stored_outcome (db, "stopped_first"), "not_judged");
}

// A run the engine died under is moved to Failed by the startup reconcile,
// which writes the row directly. Mutation check: drop `stamp_run_outcome`
// from `reconcile_orphaned_runs` and every outcome stays null.
TEST_F (DatabaseTest, ReconcileStampsTheOutcomeOfTheRunsItFails) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        // Summarised before the engine died between the two writes.
        seed_running_run (db, "summarised", now_ms ());
        db.update_run_summary ("summarised", MET_BUDGET_SUMMARY);
        seed_orphan (db, "ticked", vayu::RunStatus::Running);
        add_tick (db, "ticked", 10, 1.0);
        seed_orphan (db, "silent", vayu::RunStatus::Pending);
        seed_orphan (db, "design", vayu::RunStatus::Running, vayu::RunType::Design);
    }

    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_EQ (stored_outcome (db, "summarised"), "failed");
    EXPECT_EQ (stored_outcome (db, "ticked"), "failed")
    << "the partial summary the reconcile builds is judged like any other";
    EXPECT_EQ (stored_outcome (db, "silent"), "failed")
    << "a run with no summary is failed all the same (#3643)";
    EXPECT_EQ (stored_outcome (db, "design"), "failed");
}

// The list draws the failed mark from the status, so a move to Failed stamps
// `failed` with or without a summary, for every run type (#3643). Mutation
// check: drop the status-failed branch in `judge_run_row` and all three stay
// null.
TEST_F (DatabaseTest, AMoveToFailedStampsFailedWithNoSummary) {
    Database db (TEST_DB_PATH);
    db.init ();
    const int64_t recent = now_ms ();
    seed_running_run (db, "design", recent, vayu::RunType::Design);
    seed_running_run (db, "load_no_summary", recent + 1);
    seed_running_run (db, "scenario_no_summary", recent + 2, vayu::RunType::Scenario);
    seed_running_run (db, "stopped_no_summary", recent + 3);

    for (const char* id : { "design", "load_no_summary", "scenario_no_summary" }) {
        EXPECT_EQ (stored_outcome (db, id), std::nullopt) << id << " while running";
        db.transition_run_status (id, { vayu::RunStatus::Running }, vayu::RunStatus::Failed);
        EXPECT_EQ (stored_outcome (db, id), "failed") << id;
    }

    db.transition_run_status ("stopped_no_summary",
    { vayu::RunStatus::Running }, vayu::RunStatus::Stopped);
    EXPECT_EQ (stored_outcome (db, "stopped_no_summary"), std::nullopt)
    << "only a failed status needs no summary";
}

// Mutation checks: drop the `outcome` term from `run_filter_condition` and the
// failed filter returns every row; bind the value as `not_judged` regardless
// and the failed filter returns the unbudgeted row.
TEST_F (DatabaseTest, RunFilterMatchesTheStoredOutcomeAndNeverANullOne) {
    Database db (TEST_DB_PATH);
    db.init ();
    const int64_t recent = now_ms ();
    seed_running_run (db, "missed", recent);
    seed_running_run (db, "met", recent + 1);
    seed_running_run (db, "unbudgeted", recent + 2);
    seed_running_run (db, "in_flight", recent + 3);
    finish_run (db, "missed", MISSED_BUDGET_SUMMARY, vayu::RunStatus::Completed);
    finish_run (db, "met", MET_BUDGET_SUMMARY, vayu::RunStatus::Completed);
    finish_run (db, "unbudgeted", NO_BUDGET_SUMMARY, vayu::RunStatus::Stopped);

    const auto ids_for = [&db] (const vayu::db::RunFilter& filter) {
        std::set<std::string> ids;
        for (const auto& run : db.get_runs_paginated (filter, 50, 0)) {
            ids.insert (run.id);
        }
        EXPECT_EQ (db.count_runs (filter), static_cast<int64_t> (ids.size ()));
        return ids;
    };

    vayu::db::RunFilter failed;
    failed.outcome = vayu::RunOutcome::Failed;
    EXPECT_EQ (ids_for (failed), (std::set<std::string>{ "missed" }));
    vayu::db::RunFilter passed;
    passed.outcome = vayu::RunOutcome::Passed;
    EXPECT_EQ (ids_for (passed), (std::set<std::string>{ "met" }));
    vayu::db::RunFilter not_judged;
    not_judged.outcome = vayu::RunOutcome::NotJudged;
    EXPECT_EQ (ids_for (not_judged), (std::set<std::string>{ "unbudgeted" }));

    vayu::db::RunFilter failed_and_stopped = failed;
    failed_and_stopped.status              = vayu::RunStatus::Stopped;
    EXPECT_TRUE (ids_for (failed_and_stopped).empty ());

    EXPECT_EQ (ids_for ({}).size (), 4u) << "unset stays a wildcard";
}

// ==================== Scratch-file cleanup ====================

// `remove_database_files` is the single definition of what a scratch Database
// leaves on disk, replacing ~22 hand-copied suffix lists of which eight were
// wrong (#379, #413). Nothing else would notice if it drifted: a fixture with
// an incomplete list still passes, it just leaks - and `engine/.gitignore` now
// keeps those leaks out of `git status`, so the previous tell is gone too.
//
// The assertion deliberately does *not* name the suffixes - a second copy of
// the list is the defect this fixes. It scans the directory instead, so a
// Database that grows a new sidecar fails here rather than leaking quietly.
TEST (ScratchDatabaseCleanup, RemovesEveryFileAnOpenedDatabaseLeavesBehind) {
    namespace fs = std::filesystem;

    // A directory of its own, so "everything named like the database" is an
    // unambiguous question and a stray file cannot be mistaken for a leak.
    const fs::path dir  = "test_scratch_cleanup_dir";
    const fs::path stem = dir / "test_scratch.db";
    fs::remove_all (dir);
    fs::create_directories (dir);

    auto leftovers = [&] {
        std::set<std::string> names;
        for (const auto& entry : fs::recursive_directory_iterator (dir))
            names.insert (fs::relative (entry.path (), dir).generic_string ());
        return names;
    };

    // Refreshed the way the daemon does once it listens, so the `.bak` (and
    // any sidecar a refresh leaves) is among what this scan must see cleaned.
    {
        Database db (stem.string ());
        db.init ();
        ASSERT_HAS_VALUE (db.refresh_recovery_backup ());
    }
    // Stamped one version back and reopened, so the copy a migrating start
    // takes into `backups/` (#2426) is among it too.
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (stem.string ().c_str (), &handle), SQLITE_OK);
        const std::string sql =
        "PRAGMA user_version = " + std::to_string (vayu::db::SCHEMA_VERSION - 1);
        EXPECT_EQ (sqlite3_exec (handle, sql.c_str (), nullptr, nullptr, nullptr), SQLITE_OK);
        sqlite3_close (handle);
        Database db (stem.string ());
    }

    // The scan must have seen something, or "nothing left over" below is
    // vacuously true - the failure mode CLAUDE.md calls out for source guards.
    const auto written = leftovers ();
    ASSERT_FALSE (written.empty ())
    << "the database wrote nothing; the test proves nothing";
    EXPECT_TRUE (written.count ("test_scratch.db.bak"))
    << "no backup was written, so this run would not catch a missing `.bak`";
    EXPECT_TRUE (std::ranges::any_of (written,
    [] (const std::string& name) { return name.starts_with ("backups/vayu-"); }))
    << "no pre-migration copy was written, so this run would not catch one "
       "left behind";

    vayu::tests::remove_database_files (stem.string ());

    const auto remaining = leftovers ();
    EXPECT_TRUE (remaining.empty ())
    << "remove_database_files left " << remaining.size ()
    << " file(s) behind, starting with " << *remaining.begin ();

    fs::remove_all (dir);
}

} // namespace

} // namespace vayu::db
