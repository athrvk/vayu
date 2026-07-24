/**
 * @file tests/db_test.cpp
 * @brief Tests for Database class
 */

#include <gtest/gtest.h>
#include <sqlite3.h>

#include <chrono>
#include <filesystem>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "vayu/db/database.hpp"

namespace vayu::db {
namespace {
const std::string TEST_DB_PATH = "test_vayu.db";
const std::string TEST_DB_BACKUP_PATH = "test_vayu.db.bak";

class DatabaseTest : public ::testing::Test {
    protected:
    void SetUp () override {
        // Ensure clean state
        if (std::filesystem::exists (TEST_DB_PATH)) {
            std::filesystem::remove (TEST_DB_PATH);
        }
        if (std::filesystem::exists (TEST_DB_PATH + "-wal")) {
            std::filesystem::remove (TEST_DB_PATH + "-wal");
        }
        if (std::filesystem::exists (TEST_DB_PATH + "-shm")) {
            std::filesystem::remove (TEST_DB_PATH + "-shm");
        }
    }

    void TearDown () override {
        // Cleanup
        if (std::filesystem::exists (TEST_DB_PATH)) {
            std::filesystem::remove (TEST_DB_PATH);
        }
        if (std::filesystem::exists (TEST_DB_PATH + "-wal")) {
            std::filesystem::remove (TEST_DB_PATH + "-wal");
        }
        if (std::filesystem::exists (TEST_DB_PATH + "-shm")) {
            std::filesystem::remove (TEST_DB_PATH + "-shm");
        }
        if (std::filesystem::exists (TEST_DB_BACKUP_PATH)) {
            std::filesystem::remove (TEST_DB_BACKUP_PATH);
        }
    }
};

TEST_F (DatabaseTest, CreatesDatabaseFile) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    EXPECT_TRUE (std::filesystem::exists (TEST_DB_PATH));
}

TEST_F (DatabaseTest, CreatesAndRetrievesRun) {
    Database db (TEST_DB_PATH);
    db.init ();

    vayu::db::Run run;
    run.id              = "run_1";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Pending;
    run.start_time      = 1000;
    run.config_snapshot = "{}";

    db.create_run (run);

    auto retrieved = db.get_run ("run_1");
    ASSERT_TRUE (retrieved.has_value ());
    EXPECT_EQ (retrieved->id, "run_1");
    EXPECT_EQ (retrieved->type, vayu::RunType::Load);
    EXPECT_EQ (retrieved->status, vayu::RunStatus::Pending);
}

TEST_F (DatabaseTest, UpdatesRunStatus) {
    Database db (TEST_DB_PATH);
    db.init ();

    vayu::db::Run run;
    run.id              = "run_1";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Pending;
    run.start_time      = 1000;
    run.config_snapshot = "{}";

    db.create_run (run);
    db.update_run_status ("run_1", vayu::RunStatus::Completed);

    auto retrieved = db.get_run ("run_1");
    ASSERT_TRUE (retrieved.has_value ());
    EXPECT_EQ (retrieved->status, vayu::RunStatus::Completed);
}

TEST_F (DatabaseTest, AddsAndRetrievesMetrics) {
    Database db (TEST_DB_PATH);
    db.init ();

    vayu::db::Run run;
    run.id              = "run_1";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = 1000;
    run.config_snapshot = "{}";
    db.create_run (run);

    vayu::db::Metric m1;
    m1.run_id    = "run_1";
    m1.timestamp = 1001;
    m1.name      = vayu::MetricName::TotalRequests;
    m1.value     = 10.0;

    vayu::db::Metric m2;
    m2.run_id    = "run_1";
    m2.timestamp = 1002;
    m2.name      = vayu::MetricName::TotalRequests;
    m2.value     = 20.0;

    db.add_metric (m1);
    db.add_metric (m2);

    auto metrics = db.get_metrics ("run_1");
    ASSERT_EQ (metrics.size (), 2);
    EXPECT_EQ (metrics[0].value, 10.0);
    EXPECT_EQ (metrics[1].value, 20.0);
}

TEST_F (DatabaseTest, RetrievesAllRuns) {
    Database db (TEST_DB_PATH);
    db.init ();

    vayu::db::Run r1;
    r1.id              = "run_1";
    r1.type            = vayu::RunType::Load;
    r1.status          = vayu::RunStatus::Completed;
    r1.start_time      = 1000;
    r1.config_snapshot = "{}";

    vayu::db::Run r2;
    r2.id              = "run_2";
    r2.type            = vayu::RunType::Design;
    r2.status          = vayu::RunStatus::Failed;
    r2.start_time      = 2000;
    r2.config_snapshot = "{}";

    db.create_run (r1);
    db.create_run (r2);

    auto runs = db.get_all_runs ();
    ASSERT_EQ (runs.size (), 2);
    // Order might depend on insertion or ID, but we just check existence
    bool found1 = false;
    bool found2 = false;
    for (const auto& r : runs) {
        if (r.id == "run_1")
            found1 = true;
        if (r.id == "run_2")
            found2 = true;
    }
    EXPECT_TRUE (found1);
    EXPECT_TRUE (found2);
}

// ==================== Globals Tests ====================

TEST_F (DatabaseTest, SavesAndRetrievesGlobals) {
    Database db (TEST_DB_PATH);
    db.init ();

    Globals globals;
    globals.id = "globals";
    globals.variables =
    R"({"api_key":{"value":"secret123","enabled":true},"base_url":{"value":"https://api.example.com","enabled":true}})";
    globals.updated_at = 1000;

    db.save_globals (globals);

    auto retrieved = db.get_globals ();
    ASSERT_TRUE (retrieved.has_value ());
    EXPECT_EQ (retrieved->id, "globals");
    EXPECT_EQ (retrieved->variables, globals.variables);
}

TEST_F (DatabaseTest, UpdatesExistingGlobals) {
    Database db (TEST_DB_PATH);
    db.init ();

    Globals globals1;
    globals1.id         = "globals";
    globals1.variables  = R"({"key1":{"value":"value1","enabled":true}})";
    globals1.updated_at = 1000;
    db.save_globals (globals1);

    Globals globals2;
    globals2.id = "globals";
    globals2.variables =
    R"({"key1":{"value":"updated","enabled":true},"key2":{"value":"value2","enabled":false}})";
    globals2.updated_at = 2000;
    db.save_globals (globals2);

    auto retrieved = db.get_globals ();
    ASSERT_TRUE (retrieved.has_value ());
    EXPECT_EQ (retrieved->variables, globals2.variables);
    EXPECT_EQ (retrieved->updated_at, 2000);
}

TEST_F (DatabaseTest, ReturnsEmptyGlobalsWhenNotSet) {
    Database db (TEST_DB_PATH);
    db.init ();

    auto retrieved = db.get_globals ();
    EXPECT_FALSE (retrieved.has_value ());
}

// ==================== Request Ordering Tests ====================

// GET /requests serves this vector verbatim, so the ordering contract lives
// here: rows come back sorted by `order`, matching what get_collections has
// always done for collections. Inserted deliberately out of order - without
// the ORDER BY this returns rowid (insertion) order and fails.
TEST_F (DatabaseTest, RequestsInCollectionSortedByOrder) {
    Database db (TEST_DB_PATH);
    db.init ();

    Collection col;
    col.id    = "col_1";
    col.name  = "API";
    col.order = 0;
    db.create_collection (col);

    const std::vector<std::pair<std::string, int>> inserted = { { "req_c", 2 },
        { "req_a", 0 }, { "req_b", 1 } };
    for (const auto& [id, order] : inserted) {
        Request r;
        r.id            = id;
        r.collection_id = "col_1";
        r.name          = id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test/" + id;
        r.order         = order;
        r.created_at    = 1;
        r.updated_at    = 1;
        db.save_request (r);
    }

    auto requests = db.get_requests_in_collection ("col_1");
    ASSERT_EQ (requests.size (), 3);
    EXPECT_EQ (requests[0].id, "req_a");
    EXPECT_EQ (requests[1].id, "req_b");
    EXPECT_EQ (requests[2].id, "req_c");
}

// ==================== Config Cleanup Tests ====================

// "requestBatchSize" drove the removed batched request iteration. Seeding no
// longer creates it, and - because the Settings UI renders engine entries
// dynamically from GET /config - an upgraded database must lose the row too,
// or the dead knob keeps showing up. Simulates the upgrade by planting the
// row before re-running the seed.
TEST_F (DatabaseTest, SeedRemovesRetiredRequestBatchSizeEntry) {
    Database db (TEST_DB_PATH);
    db.init ();

    ConfigEntry stale;
    stale.key           = "requestBatchSize";
    stale.value         = "5";
    stale.type          = "integer";
    stale.label         = "Request Batch Size";
    stale.description   = "left behind by an older version";
    stale.category      = "general_engine";
    stale.default_value = "5";
    stale.updated_at    = 1;
    db.save_config_entry (stale);
    ASSERT_TRUE (db.get_config_entry ("requestBatchSize").has_value ());

    db.seed_default_config ();

    EXPECT_FALSE (db.get_config_entry ("requestBatchSize").has_value ());
}

// ==================== Environment Delete Tests ====================

TEST_F (DatabaseTest, DeletesEnvironment) {
    Database db (TEST_DB_PATH);
    db.init ();

    Environment env;
    env.id         = "env_1";
    env.name       = "Development";
    env.variables  = R"({"host":{"value":"localhost","enabled":true}})";
    env.updated_at = 1000;

    db.save_environment (env);

    auto retrieved = db.get_environment ("env_1");
    ASSERT_TRUE (retrieved.has_value ());

    db.delete_environment ("env_1");

    auto deleted = db.get_environment ("env_1");
    EXPECT_FALSE (deleted.has_value ());
}

// ==================== Index Tests ====================

// Every index declared in make_storage(), each backing a hot query path:
// metrics/results by run_id, requests by collection_id, collections by
// parent_id, runs by start_time. See the comments there for which queries
// rely on which. Named explicitly rather than counted, because sqlite also
// creates sqlite_autoindex_* entries of its own.
const std::vector<std::string> EXPECTED_INDEXES = { "idx_metrics_run_id",
    "idx_results_run_id", "idx_requests_collection_id",
    "idx_collections_parent_id", "idx_runs_start_time" };

// Reads index names straight out of sqlite_master on a separate connection,
// so the assertion does not rest on anything sqlite_orm reports about itself.
// Callers open this only after the Database has been destroyed, which keeps
// WAL visibility out of the picture.
std::set<std::string> read_index_names (const std::string& path) {
    std::set<std::string> names;

    sqlite3* handle = nullptr;
    if (sqlite3_open (path.c_str (), &handle) != SQLITE_OK) {
        ADD_FAILURE () << "could not open " << path << ": " << sqlite3_errmsg (handle);
        sqlite3_close (handle);
        return names;
    }

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2 (handle, "SELECT name FROM sqlite_master WHERE type='index'",
        -1, &stmt, nullptr) != SQLITE_OK) {
        ADD_FAILURE () << "could not query sqlite_master: " << sqlite3_errmsg (handle);
        sqlite3_close (handle);
        return names;
    }

    while (sqlite3_step (stmt) == SQLITE_ROW) {
        const auto* name = sqlite3_column_text (stmt, 0);
        if (name != nullptr) {
            names.emplace (reinterpret_cast<const char*> (name));
        }
    }

    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return names;
}

void drop_index (const std::string& path, const std::string& index_name) {
    sqlite3* handle = nullptr;
    ASSERT_EQ (sqlite3_open (path.c_str (), &handle), SQLITE_OK);

    const std::string sql = "DROP INDEX IF EXISTS " + index_name;
    char* err             = nullptr;
    if (sqlite3_exec (handle, sql.c_str (), nullptr, nullptr, &err) != SQLITE_OK) {
        ADD_FAILURE () << "could not drop " << index_name << ": "
                       << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
    }

    sqlite3_close (handle);
}

TEST_F (DatabaseTest, CreatesIndexesOnFreshDatabase) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    const auto names = read_index_names (TEST_DB_PATH);
    for (const auto& expected : EXPECTED_INDEXES) {
        EXPECT_TRUE (names.contains (expected)) << "missing index: " << expected;
    }
}

// Adding indexes is meant to be additive - an existing database picks them up
// on the next startup, with no migration. Dropping them and re-opening
// reproduces exactly that, without needing a pre-index schema on disk to test
// against.
TEST_F (DatabaseTest, RecreatesIndexesOnExistingDatabase) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    for (const auto& name : EXPECTED_INDEXES) {
        drop_index (TEST_DB_PATH, name);
    }

    // Guard the guard: if the drop silently did nothing, the re-open assertion
    // below would pass without proving anything.
    const auto after_drop = read_index_names (TEST_DB_PATH);
    for (const auto& name : EXPECTED_INDEXES) {
        ASSERT_FALSE (after_drop.contains (name)) << "drop did not remove: " << name;
    }

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    const auto recreated = read_index_names (TEST_DB_PATH);
    for (const auto& expected : EXPECTED_INDEXES) {
        EXPECT_TRUE (recreated.contains (expected))
        << "sync_schema did not recreate: " << expected;
    }
}

// ============================================================================
// Run retention (prune_runs)
// ============================================================================

namespace {

// A terminal run with an explicit id/start_time, plus one metric and one result
// so prune's cascade delete is observable.
void seed_run_with_children (Database& db,
const std::string& id,
int64_t start_time,
vayu::RunStatus status = vayu::RunStatus::Completed) {
    vayu::db::Run run;
    run.id              = id;
    run.type            = vayu::RunType::Design;
    run.status          = status;
    run.start_time      = start_time;
    run.config_snapshot = "{}";
    db.create_run (run);

    vayu::db::Metric m;
    m.run_id    = id;
    m.timestamp = start_time;
    m.name      = vayu::MetricName::TotalRequests;
    m.value     = 1.0;
    db.add_metric (m);

    vayu::db::Result r;
    r.run_id      = id;
    r.timestamp   = start_time;
    r.status_code = 200;
    r.status_text = "OK";
    r.latency_ms  = 1.0;
    r.trace_data  = "{}";
    db.add_result (r);
}

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
        seed_run_with_children (db, "run_" + std::to_string (i), i * 1000);
    }

    // Keep the 2 most-recent; age cap disabled.
    db.prune_runs (2, 0);

    auto ids = run_ids (db);
    EXPECT_EQ (ids.size (), 2u);
    EXPECT_TRUE (ids.count ("run_5"));
    EXPECT_TRUE (ids.count ("run_4"));

    // The pruned runs took their metrics and results with them.
    EXPECT_TRUE (db.get_metrics ("run_1").empty ());
    EXPECT_TRUE (db.get_results ("run_1").empty ());
    // The survivors kept theirs.
    EXPECT_EQ (db.get_metrics ("run_5").size (), 1u);
    EXPECT_EQ (db.get_results ("run_5").size (), 1u);
}

TEST_F (DatabaseTest, PruneRunsByAgeDeletesOldOnly) {
    Database db (TEST_DB_PATH);
    db.init ();

    const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
    const int64_t day = 86'400'000LL;

    seed_run_with_children (db, "fresh", now - 1 * day);
    seed_run_with_children (db, "stale", now - 40 * day);

    // Count cap disabled; drop anything older than 30 days.
    db.prune_runs (0, 30);

    auto ids = run_ids (db);
    EXPECT_TRUE (ids.count ("fresh"));
    EXPECT_FALSE (ids.count ("stale"));
    EXPECT_TRUE (db.get_metrics ("stale").empty ());
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
