/**
 * @file tests/db_test.cpp
 * @brief Tests for Database class
 */

#include <gtest/gtest.h>
#include <sqlite3.h>

#include <filesystem>
#include <set>
#include <string>
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

} // namespace
} // namespace vayu::db
