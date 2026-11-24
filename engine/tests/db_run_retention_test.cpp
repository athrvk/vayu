/**
 * @file tests/db_run_retention_test.cpp
 * @brief Database run history: retention (prune_runs), clearing, OpenAPI document reclamation, the run
 * baseline pin and startup reconciliation of abandoned runs.
 *
 * The `DatabaseTest` fixture is in `database_fixture.hpp`.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include <chrono>
#include <cstdint>
#include <set>
#include <string>

#include "database_fixture.hpp"
#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"

namespace vayu::db {

namespace {

// ============================================================================
// Run retention (prune_runs)
// ============================================================================

namespace {

std::set<std::string> run_ids (Database& db) {
    std::set<std::string> ids;
    for (const auto& r : db.get_all_runs ()) {
        ids.insert (r.id);
    }
    return ids;
}

} // namespace

TEST_F (DatabaseTest, PruneRunsByCountKeepsMostRecentAndCascades) {
    Database db (TEST_DB_PATH);
    db.init ();

    // Five terminal runs, oldest first by start_time.
    for (int i = 1; i <= 5; ++i) {
        seed_run_with_children (db, "run_" + std::to_string (i), int64_t{ i } * 1000);
    }

    // Keep the 2 most-recent; age cap disabled.
    db.prune_runs (2, 0);

    auto ids = run_ids (db);
    EXPECT_EQ (ids.size (), 2u);
    EXPECT_TRUE (ids.count ("run_5"));
    EXPECT_TRUE (ids.count ("run_4"));

    // The pruned runs took their ticks and results with them.
    EXPECT_EQ (db.count_metric_ticks ("run_1"), 0);
    EXPECT_TRUE (db.get_results ("run_1").empty ());
    // The survivors kept theirs.
    EXPECT_EQ (db.count_metric_ticks ("run_5"), 1);
    EXPECT_EQ (db.get_results ("run_5").size (), 1u);
}

TEST_F (DatabaseTest, PruneRunsByAgeDeletesOldOnly) {
    Database db (TEST_DB_PATH);
    db.init ();

    const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
    const int64_t day = 86'400'000LL;

    seed_run_with_children (db, "fresh", now - (1 * day));
    seed_run_with_children (db, "stale", now - (40 * day));

    // Count cap disabled; drop anything older than 30 days.
    db.prune_runs (0, 30);

    auto ids = run_ids (db);
    EXPECT_TRUE (ids.count ("fresh"));
    EXPECT_FALSE (ids.count ("stale"));
    EXPECT_EQ (db.count_metric_ticks ("stale"), 0);
    EXPECT_TRUE (db.get_results ("stale").empty ());
}

TEST_F (DatabaseTest, PruneRunsNeverDeletesInFlightRuns) {
    Database db (TEST_DB_PATH);
    db.init ();

    // A running and a pending run sit "beyond" the cap by start_time, but must
    // survive; they also must not count toward the cap, so the one terminal run
    // is kept even with max_runs = 1.
    seed_run_with_children (db, "running", 1000, vayu::RunStatus::Running);
    seed_run_with_children (db, "pending", 2000, vayu::RunStatus::Pending);
    seed_run_with_children (db, "done", 3000, vayu::RunStatus::Completed);

    db.prune_runs (1, 0);

    auto ids = run_ids (db);
    EXPECT_TRUE (ids.count ("running"));
    EXPECT_TRUE (ids.count ("pending"));
    EXPECT_TRUE (ids.count ("done"));
    EXPECT_EQ (ids.size (), 3u);
}

// A pin is a promise the retention cap must not break: the run later runs are
// measured against has to outlive the window of recent runs. Skipped rather
// than merely spared, so pins cannot crowd the cap either.
TEST_F (DatabaseTest, PruneRunsNeverDeletesABaselineRun) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_run_with_children (db, "pinned", 1000);
    seed_run_with_children (db, "old", 2000);
    seed_run_with_children (db, "recent", 3000);
    ASSERT_HAS_VALUE (db.set_run_baseline ("pinned", true));


    // Cap of one: without the exemption "pinned" is the oldest and the first
    // to go. With it, the cap still keeps exactly one non-baseline run.
    db.prune_runs (1, 0);

    auto ids = run_ids (db);
    EXPECT_TRUE (ids.count ("pinned")) << "retention expired a pinned baseline";
    EXPECT_TRUE (ids.count ("recent"));
    EXPECT_FALSE (ids.count ("old"));
    // Its children survive with it - a baseline whose results were cascaded
    // away is a row that can no longer be compared against.
    EXPECT_EQ (db.count_metric_ticks ("pinned"), 1);
    EXPECT_EQ (db.get_results ("pinned").size (), 1u);
}

// The age cap is the other way retention deletes, and reaches a pinned run
// sooner than the count cap does - a baseline is *meant* to get old.
TEST_F (DatabaseTest, PruneRunsByAgeSparesABaselineRun) {
    Database db (TEST_DB_PATH);
    db.init ();

    const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
    const int64_t day             = 86'400'000LL;
    const int64_t ninety_days_ago = now - (90 * day);
    seed_run_with_children (db, "pinned_stale", ninety_days_ago);
    seed_run_with_children (db, "stale", ninety_days_ago);
    ASSERT_HAS_VALUE (db.set_run_baseline ("pinned_stale", true));

    db.prune_runs (0, 30);

    auto ids = run_ids (db);
    EXPECT_TRUE (ids.count ("pinned_stale"));
    EXPECT_FALSE (ids.count ("stale"));
}

// Victims are chosen under one acquisition and deleted under another (#1906).
// A pin that lands between them answered its caller 200, so the delete batch
// has to read the row again rather than trust the selection's copy.
TEST_F (DatabaseTest, PruneRunsSparesARunPinnedAfterSelection) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_run_with_children (db, "oldest", 1000);
    seed_run_with_children (db, "old", 2000);
    seed_run_with_children (db, "recent", 3000);

    // Cap of one selects "oldest" and "old"; "oldest" is pinned in the window.
    db.prune_runs (
    1, 0, [&db] { ASSERT_HAS_VALUE (db.set_run_baseline ("oldest", true)); });

    const auto pinned = db.get_run ("oldest");
    ASSERT_HAS_VALUE (pinned)
    << "retention deleted a run pinned after selection";
    EXPECT_TRUE (pinned->baseline);
    EXPECT_EQ (db.count_metric_ticks ("oldest"), 1);
    EXPECT_EQ (db.get_results ("oldest").size (), 1u);
    // The rest of the selection is still pruned.
    EXPECT_EQ (run_ids (db), (std::set<std::string>{ "oldest", "recent" }));
}

// Each kind has its own count (#2429): a design Send never evicts a load run
// and a load run never evicts a Send, however they interleave in time.
TEST_F (DatabaseTest, PruneRunsCountsLoadRunsAndSendsUnderSeparateCaps) {
    Database db (TEST_DB_PATH);
    db.init ();

    // load_1, send_1, load_2, send_2, ... - oldest first, alternating.
    for (int i = 1; i <= 5; ++i) {
        seed_run_with_children (db, "load_" + std::to_string (i),
        int64_t{ i } * 2000, vayu::RunStatus::Completed, vayu::RunType::Load);
        seed_run_with_children (db, "send_" + std::to_string (i),
        (int64_t{ i } * 2000) + 1000, vayu::RunStatus::Completed, vayu::RunType::Design);
    }

    db.prune_runs (3, 0, nullptr, 2);

    EXPECT_EQ (run_ids (db),
    (std::set<std::string>{ "load_3", "load_4", "load_5", "send_4", "send_5" }));
}

// The defect itself: one afternoon of Sends used to push last week's load runs
// out of History, because 300 newer Sends filled a cap of 200 on their own.
TEST_F (DatabaseTest, PruneRunsKeepsOlderLoadRunsBehindManyNewerSends) {
    Database db (TEST_DB_PATH);
    db.init ();

    for (int i = 1; i <= 3; ++i) {
        seed_run_with_children (db, "load_" + std::to_string (i), i,
        vayu::RunStatus::Completed, vayu::RunType::Load);
    }
    for (int i = 1; i <= 300; ++i) {
        seed_run_with_children (db, "send_" + std::to_string (i), 1000 + i,
        vayu::RunStatus::Completed, vayu::RunType::Design);
    }

    db.prune_runs (200, 0, nullptr, 100);

    const auto ids = run_ids (db);
    EXPECT_TRUE (ids.count ("load_1")) << "Sends evicted a load run";
    EXPECT_TRUE (ids.count ("load_2"));
    EXPECT_TRUE (ids.count ("load_3"));
    EXPECT_EQ (ids.size (), 103u) << "three load runs and the 100 newest Sends";
    EXPECT_TRUE (ids.count ("send_300"));
    EXPECT_TRUE (ids.count ("send_201"));
    EXPECT_FALSE (ids.count ("send_200"));
}

// A collection run is compared over time the same way a load run is, so it
// shares the load cap rather than getting a third one.
TEST_F (DatabaseTest, PruneRunsCountsScenarioRunsWithLoadRuns) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_run_with_children (
    db, "load_old", 1000, vayu::RunStatus::Completed, vayu::RunType::Load);
    seed_run_with_children (db, "scenario_new", 2000,
    vayu::RunStatus::Completed, vayu::RunType::Scenario);
    seed_run_with_children (
    db, "send", 3000, vayu::RunStatus::Completed, vayu::RunType::Design);

    db.prune_runs (1, 0, nullptr, 1);

    EXPECT_EQ (run_ids (db), (std::set<std::string>{ "scenario_new", "send" }));
}

// A 0 design cap is unlimited, the same reading every other cap gives 0, and
// it leaves the load cap working on its own.
TEST_F (DatabaseTest, PruneRunsZeroDesignCapKeepsEverySend) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_run_with_children (db, "load_old", 1000);
    seed_run_with_children (db, "load_new", 2000);
    for (int i = 1; i <= 4; ++i) {
        seed_run_with_children (db, "send_" + std::to_string (i), 3000 + i,
        vayu::RunStatus::Completed, vayu::RunType::Design);
    }

    db.prune_runs (1, 0, nullptr, 0);

    EXPECT_EQ (run_ids (db),
    (std::set<std::string>{ "load_new", "send_1", "send_2", "send_3", "send_4" }));
}

// The pin exemption holds under the design cap too, and a pinned Send does not
// take one of the cap's places.
TEST_F (DatabaseTest, PruneRunsSkipsAPinnedSendUnderTheDesignCap) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_run_with_children (
    db, "pinned", 1000, vayu::RunStatus::Completed, vayu::RunType::Design);
    seed_run_with_children (
    db, "old", 2000, vayu::RunStatus::Completed, vayu::RunType::Design);
    seed_run_with_children (
    db, "recent", 3000, vayu::RunStatus::Completed, vayu::RunType::Design);
    ASSERT_HAS_VALUE (db.set_run_baseline ("pinned", true));

    db.prune_runs (0, 0, nullptr, 1);

    EXPECT_EQ (run_ids (db), (std::set<std::string>{ "pinned", "recent" }));
}

// The configured pass reads the design cap from its own key, not from
// `maxRunsRetained`.
TEST_F (DatabaseTest, PruneRunsConfiguredReadsTheDesignCapFromItsOwnKey) {
    // Recent start times: the configured pass also applies the 30-day age cap.
    const int64_t recent = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                           .count ();
    Database db (TEST_DB_PATH);
    db.init ();

    auto entry = db.get_config_entry ("maxDesignRunsRetained");
    ASSERT_HAS_VALUE (entry) << "the design cap is not seeded";
    EXPECT_EQ (entry->value, "100");
    entry->value = "2";
    db.save_config_entry (*entry);

    seed_run_with_children (db, "load", recent);
    for (int i = 1; i <= 4; ++i) {
        seed_run_with_children (db, "send_" + std::to_string (i), recent + i,
        vayu::RunStatus::Completed, vayu::RunType::Design);
    }

    db.prune_runs_configured ();

    EXPECT_EQ (run_ids (db), (std::set<std::string>{ "load", "send_3", "send_4" }));

    // 0 is unlimited through the configured pass as well.
    entry->value = "0";
    db.save_config_entry (*entry);
    seed_run_with_children (
    db, "send_5", recent + 5, vayu::RunStatus::Completed, vayu::RunType::Design);
    seed_run_with_children (
    db, "send_6", recent + 6, vayu::RunStatus::Completed, vayu::RunType::Design);
    db.prune_runs_configured ();
    EXPECT_EQ (run_ids (db).size (), 5u);
}

// ============================================================================
// Clear run history (clear_runs, #2429)
// ============================================================================

// The clear keeps what retention keeps: a pin is a promise, and a run still in
// flight has a writer the delete would race. Everything else goes, every kind.
TEST_F (DatabaseTest, ClearRunsKeepsPinnedAndInFlightRunsAndCascadesTheRest) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_run_with_children (db, "load", 1000);
    seed_run_with_children (
    db, "scenario", 2000, vayu::RunStatus::Failed, vayu::RunType::Scenario);
    seed_run_with_children (db, "send", 3000, vayu::RunStatus::Stopped, vayu::RunType::Design);
    seed_run_with_children (
    db, "pinned_send", 4000, vayu::RunStatus::Completed, vayu::RunType::Design);
    seed_run_with_children (db, "running", 5000, vayu::RunStatus::Running);
    seed_run_with_children (db, "pending", 6000, vayu::RunStatus::Pending);
    ASSERT_HAS_VALUE (db.set_run_baseline ("pinned_send", true));

    const auto cleared = db.clear_runs ();

    EXPECT_EQ (
    std::set<std::string> (cleared.deleted_ids.begin (), cleared.deleted_ids.end ()),
    (std::set<std::string>{ "load", "scenario", "send" }));
    EXPECT_EQ (cleared.kept_pinned, 1);
    EXPECT_EQ (run_ids (db), (std::set<std::string>{ "pinned_send", "running", "pending" }))
    << "the clear deleted a pinned or in-flight run";
    EXPECT_EQ (db.count_metric_ticks ("load"), 0);
    EXPECT_TRUE (db.get_results ("send").empty ());
    EXPECT_EQ (db.get_results ("pinned_send").size (), 1u);
    EXPECT_EQ (db.count_metric_ticks ("running"), 1);
}

// Past one delete batch: every batch commits and every id is reported once.
TEST_F (DatabaseTest, ClearRunsDeletesAcrossBatches) {
    Database db (TEST_DB_PATH);
    db.init ();

    constexpr int RUNS = 250; // two full batches of 100 and a partial one
    for (int i = 1; i <= RUNS; ++i) {
        seed_run_with_children (db, "run_" + std::to_string (i), i);
    }

    const auto cleared = db.clear_runs ();

    EXPECT_EQ (cleared.deleted_ids.size (), static_cast<size_t> (RUNS));
    EXPECT_EQ (
    std::set<std::string> (cleared.deleted_ids.begin (), cleared.deleted_ids.end ())
    .size (),
    static_cast<size_t> (RUNS));
    EXPECT_TRUE (db.get_all_runs ().empty ());
}

TEST_F (DatabaseTest, ClearRunsOnAnEmptyHistoryDeletesNothing) {
    Database db (TEST_DB_PATH);
    db.init ();

    const auto cleared = db.clear_runs ();

    EXPECT_TRUE (cleared.deleted_ids.empty ());
    EXPECT_EQ (cleared.kept_pinned, 0);
}

// ============================================================================
// OpenAPI document reclamation (sweep_orphaned_spec_documents, issue #718)
// ============================================================================

namespace {

/** Long enough ago to be outside the grace window, whatever the clock says. */
int64_t long_ago () {
    const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
    return now - vayu::core::constants::database::SPEC_DOCUMENT_SWEEP_GRACE_MS - 1000;
}

/** A stored document old enough for the sweep to consider it. */
void seed_spec (Database& db, const std::string& id, int64_t fetched_at) {
    SpecDocument spec;
    spec.id         = id;
    spec.content    = R"({"openapi":"3.0.0"})";
    spec.hash       = "hash_" + id;
    spec.fetched_at = fetched_at;
    db.save_spec_document (spec);
}

/** A collection bound to @p spec_id, or to nothing when it is empty. */
void seed_bound_collection (Database& db, const std::string& id, const std::string& spec_id) {
    Collection col;
    col.id      = id;
    col.name    = id;
    col.openapi = spec_id.empty () ?
    "{}" :
    nlohmann::json{ { "specId", spec_id }, { "specHash", "hash_" + spec_id },
        { "syncedAt", 1 } }
    .dump ();
    db.create_collection (col);
}

/** A terminal scenario run whose snapshot pins @p spec_id, as a real one does. */
void seed_run_pinning_spec (Database& db, const std::string& id, const std::string& spec_id) {
    vayu::db::Run run;
    run.id         = id;
    run.type       = vayu::RunType::Scenario;
    run.status     = vayu::RunStatus::Completed;
    run.start_time = 1000;
    // The shape `build_scenario_manifest` writes into `config_snapshot`: the
    // identity sits under `scenario.openapi`, not at the root.
    run.config_snapshot = nlohmann::json{
        { "scenario",
        nlohmann::json{ { "collectionId", "col_x" },
        { "openapi", nlohmann::json{ { "specId", spec_id }, { "specHash", "hash_" + spec_id } } } } }
    }.dump ();
    db.create_run (run);
}

} // namespace

// The accretion the sweep exists for: every sync mints a document and moves the
// binding off the last one, and nothing owned the one left behind.
TEST_F (DatabaseTest, SweepsADocumentNoCollectionBindsAndNoRunNames) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_spec (db, "spec_old", long_ago ());
    seed_spec (db, "spec_live", long_ago ());
    seed_bound_collection (db, "col_1", "spec_live");

    EXPECT_EQ (db.sweep_orphaned_spec_documents (), 1u);
    EXPECT_FALSE (db.get_spec_document ("spec_old").has_value ());
    EXPECT_TRUE (db.get_spec_document ("spec_live").has_value ())
    << "the sweep took the document a collection is bound to";
}

// The other half of the lifetime rule: a run's report describes a contract, and
// the document that contract came from outlives the binding by exactly as long
// as the run that used it.
TEST_F (DatabaseTest, SweepKeepsADocumentARetainedRunNames) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_spec (db, "spec_old", long_ago ());
    seed_run_pinning_spec (db, "run_1", "spec_old");

    EXPECT_EQ (db.sweep_orphaned_spec_documents (), 0u);
    EXPECT_TRUE (db.get_spec_document ("spec_old").has_value ());

    // ...and goes with the last run that named it. Retention is what releases
    // the reference, which is why the sweep rides along with it.
    db.delete_run ("run_1");
    EXPECT_EQ (db.sweep_orphaned_spec_documents (), 1u);
    EXPECT_FALSE (db.get_spec_document ("spec_old").has_value ());
}

// A run that names a *different* document must not shield this one - the pin is
// read by id, not by "some run mentions a spec".
TEST_F (DatabaseTest, SweepReadsTheRunsOwnSpecIdRatherThanAnyRunAtAll) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_spec (db, "spec_orphan", long_ago ());
    seed_spec (db, "spec_pinned", long_ago ());
    seed_run_pinning_spec (db, "run_1", "spec_pinned");

    EXPECT_EQ (db.sweep_orphaned_spec_documents (), 1u);
    EXPECT_FALSE (db.get_spec_document ("spec_orphan").has_value ());
    EXPECT_TRUE (db.get_spec_document ("spec_pinned").has_value ());
}

// Binding is three writes over three requests and the document is the first of
// them, so a document seconds old that nothing names is a bind in flight.
TEST_F (DatabaseTest, SweepSparesADocumentInsideTheGraceWindow) {
    Database db (TEST_DB_PATH);
    db.init ();

    const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
    seed_spec (db, "spec_just_stored", now);

    EXPECT_EQ (db.sweep_orphaned_spec_documents (), 0u);
    EXPECT_TRUE (db.get_spec_document ("spec_just_stored").has_value ())
    << "a document stored between POST /specs and the binding that names it "
       "was swept";
}

// Retention is the pass that releases run references, so it is the pass that
// notices what they were holding - and that is what puts the sweep on a startup
// and on the end of every run without a schedule of its own.
TEST_F (DatabaseTest, PruningRunsReclaimsTheDocumentTheLastPrunedRunHeld) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_spec (db, "spec_old", long_ago ());
    seed_run_pinning_spec (db, "run_1", "spec_old");

    // Age cap disabled, count cap of zero would disable both - so drop the run
    // by age, the way a month-old run goes.
    db.prune_runs (0, 30);
    ASSERT_TRUE (db.get_all_runs ().empty ());
    // Still there: prune_runs is the primitive, prune_runs_configured is the
    // pass. Only the pass sweeps.
    EXPECT_TRUE (db.get_spec_document ("spec_old").has_value ());

    db.prune_runs_configured ();
    EXPECT_FALSE (db.get_spec_document ("spec_old").has_value ());
}

// Deleting a bound collection still does not cascade to the document - several
// collections may bind one - but it is the moment to ask whether anything else
// still does.
TEST_F (DatabaseTest, DeletingTheLastBinderReclaimsTheDocument) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_spec (db, "spec_1", long_ago ());
    seed_bound_collection (db, "col_1", "spec_1");
    seed_bound_collection (db, "col_2", "spec_1");

    // A *delete* is soft since issue #988, and a collection in the trash still
    // binds its document - reclaiming it there would leave a restore pointing
    // at nothing. So it is the purge, not the delete, that releases the
    // reference; both are asserted so neither half can regress silently.
    db.delete_collection ("col_1");
    db.delete_collection ("col_2");
    EXPECT_TRUE (db.get_spec_document ("spec_1").has_value ())
    << "a document two collections in the trash still bind was swept";

    db.purge_deleted ("col_1");
    EXPECT_TRUE (db.get_spec_document ("spec_1").has_value ())
    << "a document a second collection still binds was swept";

    db.purge_deleted ("col_2");
    EXPECT_FALSE (db.get_spec_document ("spec_1").has_value ());
}

// A binding that is not JSON references nothing - the reading every other
// reader of this column gives it, and the one that cannot make a corrupt row
// pin a document forever.
TEST_F (DatabaseTest, SweepTreatsAnUnparseableBindingAsBindingNothing) {
    Database db (TEST_DB_PATH);
    db.init ();

    seed_spec (db, "spec_1", long_ago ());
    Collection col;
    col.id      = "col_1";
    col.name    = "Broken";
    col.openapi = "not json at all";
    db.create_collection (col);

    EXPECT_EQ (db.sweep_orphaned_spec_documents (), 1u);
    EXPECT_FALSE (db.get_spec_document ("spec_1").has_value ());
}

TEST_F (DatabaseTest, SetRunBaselineTogglesAndPersists) {
    const int64_t recent = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                           .count ();
    {
        Database db (TEST_DB_PATH);
        db.init ();
        seed_run_with_children (db, "run_1", recent);

        auto stored = db.get_run ("run_1");
        ASSERT_HAS_VALUE (stored);
        EXPECT_FALSE (stored->baseline)
        << "a run is not a baseline until pinned";

        auto pinned = db.set_run_baseline ("run_1", true);
        ASSERT_HAS_VALUE (pinned);
        EXPECT_TRUE (pinned->baseline);
        // The whole row comes back, not just the flag - the route answers with it.
        EXPECT_EQ (pinned->id, "run_1");
    }

    // Survives a reopen: the pin is a stored column, not process state.
    Database db (TEST_DB_PATH);
    db.init ();
    auto reopened = db.get_run ("run_1");
    ASSERT_HAS_VALUE (reopened);
    EXPECT_TRUE (reopened->baseline);

    auto unpinned = db.set_run_baseline ("run_1", false);
    ASSERT_HAS_VALUE (unpinned);
    EXPECT_FALSE (unpinned->baseline);
    const auto unpinned_row = db.get_run ("run_1");
    ASSERT_HAS_VALUE (unpinned_row);
    EXPECT_FALSE (unpinned_row->baseline);
}

TEST_F (DatabaseTest, SetRunBaselineOnAMissingRunReportsNothingStored) {
    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_FALSE (db.set_run_baseline ("no_such_run", true).has_value ());
}

// A database written before the column existed must open, and its rows must
// read as unpinned rather than as an error - the `default_value` is what makes
// sync_schema add the column instead of refusing the table.
TEST_F (DatabaseTest, RunsStoredBeforeTheBaselineColumnReadAsUnpinned) {
    const int64_t recent = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                           .count ();
    {
        Database db (TEST_DB_PATH);
        db.init ();
        seed_run_with_children (db, "legacy", recent);
    }

    // Drop the column back off, the way a database written by an older build
    // has it - the same simulation MigratesHttpVersionColumnOntoAPreExisting-
    // RequestsTable uses.
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        char* err = nullptr;
        ASSERT_EQ (sqlite3_exec (handle, "ALTER TABLE runs DROP COLUMN baseline",
                   nullptr, nullptr, &err),
        SQLITE_OK)
        << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
        sqlite3_close (handle);
    }

    // Guard the guard: a drop that silently did nothing would leave the
    // assertions below passing without a pre-column database to prove them on.
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        sqlite3_stmt* stmt = nullptr;
        ASSERT_EQ (sqlite3_prepare_v2 (handle, "PRAGMA table_info(runs)", -1, &stmt, nullptr),
        SQLITE_OK);
        bool has_column = false;
        while (sqlite3_step (stmt) == SQLITE_ROW) {
            const auto* col_name = vayu::db::column_text (stmt, 1);
            if (col_name != nullptr && std::string (col_name) == "baseline") {
                has_column = true;
            }
        }
        sqlite3_finalize (stmt);
        sqlite3_close (handle);
        ASSERT_FALSE (has_column) << "drop did not remove baseline";
    }

    Database db (TEST_DB_PATH);
    db.init ();
    auto legacy = db.get_run ("legacy");
    ASSERT_HAS_VALUE (legacy) << "an older database no longer opens";
    EXPECT_FALSE (legacy->baseline);
}

TEST_F (DatabaseTest, RunFilterSelectsBaselinesInBothDirections) {
    Database db (TEST_DB_PATH);
    db.init ();
    seed_run_with_children (db, "pinned", 3000);
    seed_run_with_children (db, "plain", 2000);
    db.set_run_baseline ("pinned", true);

    vayu::db::RunFilter only_baselines;
    only_baselines.baseline = true;
    auto pinned             = db.get_runs_paginated (only_baselines, 50, 0);
    ASSERT_EQ (pinned.size (), 1u);
    EXPECT_EQ (pinned[0].id, "pinned");
    EXPECT_EQ (db.count_runs (only_baselines), 1);

    vayu::db::RunFilter no_baselines;
    no_baselines.baseline = false;
    auto plain            = db.get_runs_paginated (no_baselines, 50, 0);
    ASSERT_EQ (plain.size (), 1u);
    EXPECT_EQ (plain[0].id, "plain");

    // Unset stays a wildcard - the filter must not narrow a list nobody
    // asked to narrow.
    EXPECT_EQ (db.count_runs ({}), 2);
}

// ============================================================================
// Startup reconciliation (reconcile_orphaned_runs)
// ============================================================================

TEST_F (DatabaseTest, ReconcileMarksRunsAbandonedByAPreviousProcessFailed) {
    // Recent start times: init() prunes by the real retention defaults, and an
    // epoch-1970 row would be swept away before the assertions run.
    const int64_t recent = now_ms ();

    // A previous process died mid-run: its rows are still running/pending.
    {
        Database db (TEST_DB_PATH);
        db.init ();
        seed_run_with_children (db, "crashed", recent, vayu::RunStatus::Running);
        seed_run_with_children (db, "never_started", recent + 1, vayu::RunStatus::Pending);
        seed_run_with_children (db, "done", recent + 2, vayu::RunStatus::Completed);
        seed_run_with_children (db, "stopped", recent + 3, vayu::RunStatus::Stopped);
    }

    // Next startup reconciles them, without touching terminal rows.
    Database db (TEST_DB_PATH);
    db.init ();

    auto status_of = [&db] (const std::string& id) {
        auto run = db.get_run (id);
        EXPECT_TRUE (run.has_value ()) << "run vanished: " << id;
        return run->status;
    };

    EXPECT_EQ (status_of ("crashed"), vayu::RunStatus::Failed);
    EXPECT_EQ (status_of ("never_started"), vayu::RunStatus::Failed);
    EXPECT_EQ (status_of ("done"), vayu::RunStatus::Completed);
    EXPECT_EQ (status_of ("stopped"), vayu::RunStatus::Stopped);

    // Already reconciled - a second pass has nothing to do.
    EXPECT_EQ (db.reconcile_orphaned_runs (), 0u);
}

TEST_F (DatabaseTest, ReconcileKeepsTheEndTimeTheRunAlreadyRecorded) {
    // update_run_end_time runs before the terminal status write, so a run can
    // die with a real end_time stored; reconciliation must not overwrite it
    // with the (arbitrarily much later) restart time.
    constexpr int64_t RECORDED_END = 1'234'567'890;
    {
        Database db (TEST_DB_PATH);
        db.init ();
        vayu::db::Run run;
        run.id              = "half_written";
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Running;
        run.start_time      = now_ms ();
        run.end_time        = RECORDED_END;
        run.config_snapshot = "{}";
        db.create_run (run);
    }

    Database db (TEST_DB_PATH);
    db.init ();

    auto run = db.get_run ("half_written");
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Failed);
    EXPECT_EQ (run->end_time, RECORDED_END);
}

// A run that died while running has no end recorded, because the move to
// Running cleared the seed (#3340). Reconcile ends it where it started rather
// than at 0, which a report reads as "still going" and measures up to now.
// Mutation check: drop the `end_time == 0` branch in `reconcile_orphaned_runs`
// and end_time stays 0.
TEST_F (DatabaseTest, ReconcileEndsARunThatRecordedNoEndWhereItStarted) {
    const int64_t started = now_ms () - 60'000;
    {
        Database db (TEST_DB_PATH);
        db.init ();
        vayu::db::Run run;
        run.id              = "died_running";
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Pending;
        run.start_time      = started;
        run.end_time        = started; // seed_run_times' seed
        run.config_snapshot = "{}";
        db.create_run (run);
        ASSERT_TRUE (db
        .transition_run_status (
        "died_running", { vayu::RunStatus::Pending }, vayu::RunStatus::Running)
        .applied);
        auto running = db.get_run ("died_running");
        ASSERT_HAS_VALUE (running);
        ASSERT_EQ (running->end_time, 0)
        << "the move to Running clears the seed";
    }

    Database db (TEST_DB_PATH);
    db.init ();

    auto run = db.get_run ("died_running");
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Failed);
    EXPECT_EQ (run->end_time, started);
}

namespace {

/// The stored summary of @p id after a restart reconciled it, parsed; null
/// when none was written.
nlohmann::json reconciled_summary (Database& db, const std::string& id) {
    const auto run = db.get_run (id);
    if (!run) {
        ADD_FAILURE () << "run vanished: " << id;
        return nullptr;
    }
    EXPECT_EQ (run->status, vayu::RunStatus::Failed) << id;
    EXPECT_FALSE (run->has_warnings) << id;
    if (run->summary.empty ()) {
        return nullptr;
    }
    return nlohmann::json::parse (run->summary);
}
} // namespace

// #2895: a load run the engine died under is given its last tick's totals,
// flagged partial, under the keys a finished run's summary uses. Mutation
// checks: drop the `run.summary` write in `reconcile_orphaned_runs` and the
// summary is null; order `get_last_metric_tick` ascending and the totals are
// the first tick's; drop `skipped_requests` from `CUMULATIVE_TICK_KEYS` and
// the skip assertions fail (#2911).
TEST_F (DatabaseTest, ReconcileStoresALoadRunsLastTickAsAPartialSummary) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        seed_orphan (db, "crashed", vayu::RunStatus::Running);
        add_tick (db, "crashed", 10, 1.0);
        add_tick (db, "crashed", 25, 2.0);
        add_tick (db, "crashed", 40, 4.0);
    }

    Database db (TEST_DB_PATH);
    db.init ();
    const auto summary = reconciled_summary (db, "crashed");
    ASSERT_TRUE (summary.is_object ()) << summary.dump ();

    EXPECT_EQ (summary.value ("partial", false), true);
    EXPECT_EQ (summary["total_requests"].get<size_t> (), 40u);
    EXPECT_DOUBLE_EQ (summary["test_duration"].get<double> (), 4.0);
    // Completions over elapsed time, not the tick's trailing `current_rps`.
    EXPECT_DOUBLE_EQ (summary["rps"].get<double> (), 10.0);
    EXPECT_DOUBLE_EQ (summary["send_rate"].get<double> (), 11.0);
    EXPECT_DOUBLE_EQ (summary["throughput"].get<double> (), 10.0);
    EXPECT_EQ (summary["cancelled"].get<size_t> (), 1u);
    EXPECT_EQ (summary["dropped_requests"].get<size_t> (), 4u);
    // Cumulative like the drops, so a crashed stalled run keeps them (#2911).
    EXPECT_EQ (summary["skipped_requests"].get<size_t> (), 3u);
    EXPECT_DOUBLE_EQ (summary["stalled_ms"].get<double> (), 300.0);
    EXPECT_EQ (summary["bytes_sent"].get<size_t> (), 4000u);
    EXPECT_EQ (summary["bytes_received"].get<size_t> (), 40000u);
    EXPECT_EQ (summary["status_codes"], (nlohmann::json{ { "200", 38 }, { "503", 2 } }));

    // Nothing the tick holds only for its last second, and nothing it never
    // measured: an absent key keeps the report's older-summary reading.
    for (const char* key : { "latency", "peak_concurrency", "avg_in_flight",
         "queue_wait_avg", "error_types", "error_classes", "sending_duration", "sampling",
         "connection_replays", "http_version_downgraded", "setup_overhead" }) {
        EXPECT_FALSE (summary.contains (key)) << key << " in " << summary.dump ();
    }
}

// No tick means nothing to rebuild from: the run stays without a summary, and
// the report says so (`summaryMissing`) rather than inventing zeros.
TEST_F (DatabaseTest, ReconcileWritesNoSummaryForALoadRunThatWroteNoTick) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        seed_orphan (db, "no_ticks", vayu::RunStatus::Running);
    }
    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_TRUE (reconciled_summary (db, "no_ticks").is_null ());
}

// A summary the run already stored is the run's own account and is never
// replaced by a tick. Mutation check: drop the `!run.summary.empty ()` guard in
// `orphan_summary` and the stored summary is overwritten.
TEST_F (DatabaseTest, ReconcileKeepsASummaryTheRunAlreadyStored) {
    const std::string stored = R"({"total_requests":7,"rps":3.5})";
    {
        Database db (TEST_DB_PATH);
        db.init ();
        seed_orphan (db, "summarised", vayu::RunStatus::Running);
        add_tick (db, "summarised", 40, 4.0);
        db.update_run_summary ("summarised", stored);
    }
    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_EQ (reconciled_summary (db, "summarised"), nlohmann::json::parse (stored));
}

// Only a load run has ticks to rebuild from. A pending run that never sent is
// failed with nothing, and a scenario run's tick (none is written today) is
// not read. Mutation check: drop the `RunType::Load` test in `orphan_summary`
// and the scenario run gains a summary.
TEST_F (DatabaseTest, ReconcileGivesOnlyALoadRunAPartialSummary) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        seed_orphan (db, "pending", vayu::RunStatus::Pending);
        seed_orphan (db, "sequence", vayu::RunStatus::Running, vayu::RunType::Scenario);
        add_tick (db, "sequence", 40, 4.0);
    }
    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_TRUE (reconciled_summary (db, "pending").is_null ());
    EXPECT_TRUE (reconciled_summary (db, "sequence").is_null ());
}

TEST_F (DatabaseTest, PruneRunsZeroLimitsDisableEachCap) {
    Database db (TEST_DB_PATH);
    db.init ();

    const int64_t old_time = 1000; // ancient by wall-clock, so an age cap would bite
    for (int i = 1; i <= 4; ++i) {
        seed_run_with_children (db, "run_" + std::to_string (i), old_time + i);
    }

    // Both caps disabled: nothing is pruned even though every run is ancient.
    db.prune_runs (0, 0);
    EXPECT_EQ (run_ids (db).size (), 4u);
}

} // namespace

} // namespace vayu::db
