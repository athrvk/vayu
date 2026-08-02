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

// One tick writes ~18 rows sharing a single timestamp, and there is no index on
// timestamp - so ordering by timestamp alone leaves the ties in scan order and a
// page boundary can repeat or drop a row. id (insertion order) is the tiebreaker.
TEST_F (DatabaseTest, PaginatedMetricsAreStablyOrderedAcrossTimestampTies) {
    Database db (TEST_DB_PATH);
    db.init ();

    vayu::db::Run run;
    run.id              = "run_1";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = 1000;
    run.config_snapshot = "{}";
    db.create_run (run);

    // Two ticks of six rows each - every row within a tick shares a timestamp.
    constexpr int kPerTick = 6;
    for (int tick = 0; tick < 2; ++tick) {
        for (int i = 0; i < kPerTick; ++i) {
            vayu::db::Metric m;
            m.run_id    = "run_1";
            m.timestamp = 2000 + tick;
            m.name      = vayu::MetricName::Rps;
            m.value     = static_cast<double> (tick * kPerTick + i);
            db.add_metric (m);
        }
    }

    // Page through in 5s; the concatenation must be every row exactly once.
    std::vector<double> paged;
    for (int64_t offset = 0; offset < 2 * kPerTick; offset += 5) {
        for (const auto& m : db.get_metrics_paginated ("run_1", 5, offset)) {
            paged.push_back (m.value);
        }
    }

    ASSERT_EQ (paged.size (), static_cast<size_t> (2 * kPerTick));
    for (int i = 0; i < 2 * kPerTick; ++i) {
        EXPECT_DOUBLE_EQ (paged[static_cast<size_t> (i)], static_cast<double> (i));
    }
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

// "contextPoolSize" described "pre-initialized JS contexts" and accepted 1..256,
// but the script context pool is grown lazily and never read the value (issue
// #112) - a knob a user could turn with no effect anywhere. Same two guarantees
// as the entry above: a fresh seed does not create it, and an upgraded database
// sheds the row it was already carrying.
TEST_F (DatabaseTest, SeedRemovesRetiredContextPoolSizeEntry) {
    Database db (TEST_DB_PATH);
    db.init ();

    EXPECT_FALSE (db.get_config_entry ("contextPoolSize").has_value ())
    << "a fresh seed must not create the retired key";

    ConfigEntry stale;
    stale.key           = "contextPoolSize";
    stale.value         = "128";
    stale.type          = "integer";
    stale.label         = "Script Context Pool Size";
    stale.description   = "left behind by an older version";
    stale.category      = "scripting_sandbox";
    stale.default_value = "64";
    stale.updated_at    = 1;
    db.save_config_entry (stale);
    ASSERT_TRUE (db.get_config_entry ("contextPoolSize").has_value ());

    db.seed_default_config ();

    EXPECT_FALSE (db.get_config_entry ("contextPoolSize").has_value ());
}

// The "options" column is new (Task 4); an existing on-disk database predates
// it, so sync_schema must add the nullable column without a migration, and
// re-seeding on an already-upgraded row must both preserve the user's chosen
// value and backfill the options metadata that older row would be missing.
// Simulates the upgrade the same way SeedRemovesRetiredRequestBatchSizeEntry
// does: plant a pre-Task-4-shaped row (no options), then re-run the seed.
TEST_F (DatabaseTest, SeedBackfillsOptionsOnUpgradeWithoutLosingUserValue) {
    Database db (TEST_DB_PATH);
    db.init ();

    auto seeded = db.get_config_entry ("defaultHttpVersion");
    ASSERT_TRUE (seeded.has_value ());
    ASSERT_TRUE (seeded->options.has_value ());

    ConfigEntry upgraded_row = *seeded;
    upgraded_row.value       = "http2";  // user's choice, must survive re-seed
    upgraded_row.options = std::nullopt; // pre-Task-4 row never had this column
    db.save_config_entry (upgraded_row);
    ASSERT_FALSE (db.get_config_entry ("defaultHttpVersion")->options.has_value ());

    db.seed_default_config ();

    auto after = db.get_config_entry ("defaultHttpVersion");
    ASSERT_TRUE (after.has_value ());
    EXPECT_EQ (after->value, "http2");         // user's value preserved
    ASSERT_TRUE (after->options.has_value ()); // metadata backfilled
    EXPECT_EQ (*after->options, *seeded->options);
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

// ==================== Environment Active-Flag Tests ====================

namespace {
Environment make_environment (const std::string& id, bool is_active) {
    Environment env;
    env.id         = id;
    env.name       = id;
    env.variables  = "{}";
    env.is_active  = is_active;
    env.updated_at = 1000;
    return env;
}

// The ids of every environment currently flagged active. The invariant is about
// the whole table, so the assertions read it as a set rather than row by row.
std::vector<std::string> active_environment_ids (Database& db) {
    std::vector<std::string> ids;
    for (const auto& env : db.get_environments ()) {
        if (env.is_active) {
            ids.push_back (env.id);
        }
    }
    return ids;
}
} // namespace

TEST_F (DatabaseTest, ActivatingAnEnvironmentDeactivatesThePreviousOne) {
    Database db (TEST_DB_PATH);
    db.init ();

    db.save_environment (make_environment ("env_dev", true));
    db.save_environment (make_environment ("env_prod", true));

    // Not "prod is active" - "prod is the *only* one active". A per-row check
    // would pass on the pre-fix behaviour, where both stayed set.
    EXPECT_EQ (active_environment_ids (db), std::vector<std::string>{ "env_prod" });
}

TEST_F (DatabaseTest, SavingAnInactiveEnvironmentLeavesTheActiveOneAlone) {
    Database db (TEST_DB_PATH);
    db.init ();

    db.save_environment (make_environment ("env_dev", true));
    // An unrelated edit (renaming staging, editing its variables) must not
    // clear the active flag: only storing an *active* row switches it.
    db.save_environment (make_environment ("env_staging", false));

    EXPECT_EQ (active_environment_ids (db), std::vector<std::string>{ "env_dev" });
}

TEST_F (DatabaseTest, DeactivatingTheActiveEnvironmentLeavesNoneActive) {
    Database db (TEST_DB_PATH);
    db.init ();

    db.save_environment (make_environment ("env_dev", true));
    db.save_environment (make_environment ("env_dev", false));

    EXPECT_TRUE (active_environment_ids (db).empty ());
}

TEST_F (DatabaseTest, TheActiveEnvironmentSurvivesReopeningTheDatabase) {
    // The point of storing this engine-side rather than in client-local state:
    // it is still there after the app is closed and reopened.
    {
        Database db (TEST_DB_PATH);
        db.init ();
        db.save_environment (make_environment ("env_dev", false));
        db.save_environment (make_environment ("env_prod", true));
    }

    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_EQ (active_environment_ids (db), std::vector<std::string>{ "env_prod" });
}

TEST_F (DatabaseTest, ImportedActiveEnvironmentAlsoDeactivatesTheStoredOne) {
    // import_apply writes rows directly inside its own transaction rather than
    // through save_environment, so the invariant has to be applied there too.
    Database db (TEST_DB_PATH);
    db.init ();
    db.save_environment (make_environment ("env_dev", true));

    db.import_apply ({}, {}, { make_environment ("env_imported", true) });

    EXPECT_EQ (active_environment_ids (db), std::vector<std::string>{ "env_imported" });
}

// ==================== Index Tests ====================

// Every index declared in make_storage(), each backing a hot query path:
// metrics/results by run_id, requests by collection_id, collections by
// parent_id, runs by start_time. See the comments there for which queries
// rely on which. Named explicitly rather than counted, because sqlite also
// creates sqlite_autoindex_* entries of its own.
const std::vector<std::string> EXPECTED_INDEXES = { "idx_metrics_run_id",
    "idx_metric_ticks_run_id", "idx_results_run_id", "idx_requests_collection_id",
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

// requests.http_version (Task 3) is NOT NULL with a default_value specifically
// so sync_schema can ALTER TABLE ADD COLUMN it onto a requests table that
// predates the column, rather than dropping and recreating the table (which
// would lose every saved request). Simulates that pre-existing database by
// dropping the column back off a freshly-created one, the same way
// RecreatesIndexesOnExistingDatabase simulates a pre-index database.
TEST_F (DatabaseTest, MigratesHttpVersionColumnOntoAPreExistingRequestsTable) {
    {
        Database db (TEST_DB_PATH);
        db.init ();

        Collection col;
        col.id    = "col_pre_migration";
        col.name  = "Pre-migration collection";
        col.order = 0;
        db.create_collection (col);

        Request r;
        r.id            = "req_pre_migration";
        r.collection_id = "col_pre_migration";
        r.name          = "Pre-migration request";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test/pre-migration";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        db.save_request (r);
    }

    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH.c_str (), &handle), SQLITE_OK);
        char* err = nullptr;
        ASSERT_EQ (sqlite3_exec (handle, "ALTER TABLE requests DROP COLUMN http_version",
                   nullptr, nullptr, &err),
        SQLITE_OK)
        << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
        sqlite3_close (handle);
    }

    // Guard the guard: if the drop silently did nothing, the re-open
    // assertions below would pass without proving anything.
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH.c_str (), &handle), SQLITE_OK);
        sqlite3_stmt* stmt = nullptr;
        ASSERT_EQ (sqlite3_prepare_v2 (handle, "PRAGMA table_info(requests)", -1, &stmt, nullptr),
        SQLITE_OK);
        bool has_column = false;
        while (sqlite3_step (stmt) == SQLITE_ROW) {
            const auto* col_name = sqlite3_column_text (stmt, 1);
            if (col_name != nullptr &&
            std::string (reinterpret_cast<const char*> (col_name)) == "http_version") {
                has_column = true;
            }
        }
        sqlite3_finalize (stmt);
        sqlite3_close (handle);
        ASSERT_FALSE (has_column) << "drop did not remove http_version";
    }

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    // The column is back, NOT NULL-safe, and the pre-existing row survived
    // with its data intact and its missing http_version backfilled to auto -
    // not silently dropped and recreated empty.
    sqlite3* handle = nullptr;
    ASSERT_EQ (sqlite3_open (TEST_DB_PATH.c_str (), &handle), SQLITE_OK);

    sqlite3_stmt* count_stmt = nullptr;
    ASSERT_EQ (sqlite3_prepare_v2 (handle, "SELECT COUNT(*) FROM requests", -1,
               &count_stmt, nullptr),
    SQLITE_OK);
    ASSERT_EQ (sqlite3_step (count_stmt), SQLITE_ROW);
    EXPECT_EQ (sqlite3_column_int (count_stmt, 0), 1)
    << "pre-existing row did not survive the migration";
    sqlite3_finalize (count_stmt);

    sqlite3_stmt* row_stmt = nullptr;
    ASSERT_EQ (sqlite3_prepare_v2 (handle, "SELECT name, http_version FROM requests WHERE id = 'req_pre_migration'",
               -1, &row_stmt, nullptr),
    SQLITE_OK);
    ASSERT_EQ (sqlite3_step (row_stmt), SQLITE_ROW);
    EXPECT_EQ (
    std::string (reinterpret_cast<const char*> (sqlite3_column_text (row_stmt, 0))),
    "Pre-migration request");
    EXPECT_EQ (
    std::string (reinterpret_cast<const char*> (sqlite3_column_text (row_stmt, 1))), "auto");
    sqlite3_finalize (row_stmt);
    sqlite3_close (handle);
}

// ============================================================================
// Run retention (prune_runs)
// ============================================================================

namespace {

// A terminal run with an explicit id/start_time, plus one legacy metric row,
// one metric tick and one result so prune's cascade delete is observable.
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

    vayu::db::MetricTick tick;
    tick.run_id    = id;
    tick.timestamp = start_time;
    tick.payload   = R"({"timestamp":1,"requests_completed":1})";
    db.add_metric_tick (tick);

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

    // The pruned runs took their ticks, metrics and results with them.
    EXPECT_TRUE (db.get_metrics ("run_1").empty ());
    EXPECT_EQ (db.count_metric_ticks ("run_1"), 0);
    EXPECT_TRUE (db.get_results ("run_1").empty ());
    // The survivors kept theirs.
    EXPECT_EQ (db.get_metrics ("run_5").size (), 1u);
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

// ============================================================================
// Startup reconciliation (reconcile_orphaned_runs)
// ============================================================================

namespace {
int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}
} // namespace

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
    ASSERT_TRUE (run.has_value ());
    EXPECT_EQ (run->status, vayu::RunStatus::Failed);
    EXPECT_EQ (run->end_time, RECORDED_END);
}

TEST_F (DatabaseTest, ReconcileLeavesNoIndeterminateEndTimeOnAnUnseededRun) {
    // The design-mode insert used to set start_time and nothing else. Reconcile
    // keeps end_time as recorded, so whatever the insert left had to be a value
    // readers can interpret - hence the field default. Constructed here the way
    // an insert site that forgets seed_run_times would leave it.
    const int64_t started = now_ms ();
    {
        Database db (TEST_DB_PATH);
        db.init ();
        vayu::db::Run run;
        run.id              = "unseeded";
        run.type            = vayu::RunType::Design;
        run.status          = vayu::RunStatus::Running;
        run.start_time      = started;
        run.config_snapshot = "{}";
        db.create_run (run);
    }

    Database db (TEST_DB_PATH);
    db.init ();

    auto run = db.get_run ("unseeded");
    ASSERT_TRUE (run.has_value ());
    EXPECT_EQ (run->status, vayu::RunStatus::Failed);
    // 0 is the "no end recorded" sentinel every reader guards on; anything
    // between 1 and start_time would be garbage posing as a real timestamp.
    EXPECT_EQ (run->end_time, 0);
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
    ASSERT_TRUE (before.has_value ());
    EXPECT_TRUE (before->summary.empty ());

    db.update_run_summary ("run_1", R"({"total_requests":42})");

    auto after = db.get_run ("run_1");
    ASSERT_TRUE (after.has_value ());
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

} // namespace
} // namespace vayu::db
