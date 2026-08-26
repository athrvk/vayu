/**
 * @file tests/db_test.cpp
 * @brief Tests for Database class
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include <array>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"

namespace vayu::db {
namespace {
constexpr const char* TEST_DB_PATH = "test_vayu.db";

class DatabaseTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (TEST_DB_PATH);
    }

    void TearDown () override {
        vayu::tests::remove_database_files (TEST_DB_PATH);
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
    ASSERT_HAS_VALUE (retrieved);
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
    ASSERT_HAS_VALUE (retrieved);
    EXPECT_EQ (retrieved->status, vayu::RunStatus::Completed);
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
    ASSERT_HAS_VALUE (retrieved);
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
    ASSERT_HAS_VALUE (retrieved);
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

// The 2026-08 sweep (#519) retired eleven more keys at once: nothing read them,
// so a user could turn any of them and change nothing. Pinned as a list rather
// than one test per key - the guarantee is identical for all of them, and a key
// added to the retirement list without its row being deleted is the only way
// this can regress.
// A category can be retired too, and that is the more dangerous half: the app
// renders one sidebar row per declared category and drops an entry whose
// category it does not know, so a row left behind in "database_performance"
// after #586 folded those three into Core would be a setting with no screen -
// present in the database, absent from Settings and from its search. Reseeding
// rewrites metadata over the stored value, which is what carries an upgraded
// database across; simulated here by planting the old category before it runs.
TEST_F (DatabaseTest, SeedMovesAnEntryOutOfARetiredCategory) {
    Database db (TEST_DB_PATH);
    db.init ();

    auto seeded = db.get_config_entry ("dbCacheSize");
    ASSERT_HAS_VALUE (seeded);
    ASSERT_EQ (seeded->category, "general_engine");

    ConfigEntry stale = *seeded;

    // A value the user chose, which the move must not reset.
    stale.category = "database_performance";
    stale.value    = "33554432";
    db.save_config_entry (stale);
    const auto chosen = db.get_config_entry ("dbCacheSize");
    ASSERT_HAS_VALUE (chosen);
    ASSERT_EQ (chosen->category, "database_performance");

    db.seed_default_config ();

    auto migrated = db.get_config_entry ("dbCacheSize");
    ASSERT_HAS_VALUE (migrated);
    EXPECT_EQ (migrated->category, "general_engine");
    EXPECT_EQ (migrated->value, "33554432")
    << "a category move must not reset the value the user stored";
}

// The same guarantee for a category move that is *live* rather than historical.
// #703 re-shelved sixteen entries, and every install that has ever started the
// engine carries the old category on the row; the value beside it may be one
// the user chose deliberately (a provider slow to issue tokens is exactly why
// this knob is settable). `upsert_config` preserves the value and rewrites the
// metadata around it, so the migration is the next startup and nothing else -
// but only a test says so before an upgrade does.
TEST_F (DatabaseTest, SeedRehomesAnAuditedEntryWithoutResettingItsValue) {
    Database db (TEST_DB_PATH);
    db.init ();

    auto seeded = db.get_config_entry ("oauth2RefreshLeadMs");
    ASSERT_HAS_VALUE (seeded);
    ASSERT_EQ (seeded->category, "services");

    ConfigEntry stale = *seeded;
    stale.category    = "network_performance"; // where it sat before #703
    stale.value       = "120000";
    db.save_config_entry (stale);

    db.seed_default_config ();

    auto migrated = db.get_config_entry ("oauth2RefreshLeadMs");
    ASSERT_HAS_VALUE (migrated);
    EXPECT_EQ (migrated->category, "services");
    EXPECT_EQ (migrated->value, "120000")
    << "a category move must not reset the value the user stored";
}

TEST_F (DatabaseTest, SeedRemovesTheSweepRetiredEntries) {
    const std::vector<std::string> retired = { "maxConnections",
        "tcpKeepAliveIdle", "tcpKeepAliveInterval", "statsInterval",
        "maxJsonFieldSize", "sseConnectTimeout", "sseMaxRetry",
        "sseSendLastEventId", "dbTempStore", "dbMmapSize", "dbWalAutocheckpoint" };

    Database db (TEST_DB_PATH);
    db.init ();

    for (const auto& key : retired) {
        EXPECT_FALSE (db.get_config_entry (key).has_value ())
        << "a fresh seed must not create the retired key '" << key << "'";

        ConfigEntry stale;
        stale.key           = key;
        stale.value         = "1";
        stale.type          = "integer";
        stale.label         = "Left behind";
        stale.description   = "left behind by an older version";
        stale.category      = "general_engine";
        stale.default_value = "1";
        stale.updated_at    = 1;
        db.save_config_entry (stale);
        ASSERT_TRUE (db.get_config_entry (key).has_value ());
    }

    db.seed_default_config ();

    for (const auto& key : retired) {
        EXPECT_FALSE (db.get_config_entry (key).has_value ())
        << "an upgraded database must shed the retired key '" << key << "'";
    }
}

// "dbCacheSize" survived the sweep by being wired: it is the one database
// PRAGMA with a tuning story, and until #519 the seed logged the configured
// value while the connection got the compile-time constant. `cache_size` is
// per-connection state, so the check is on a *reopened* database - which is
// also the restart the entry's flag demands.
TEST_F (DatabaseTest, CacheSizeConfigReachesTheConnection) {
    constexpr int kConfigured = 128 * 1024 * 1024;
    constexpr int kDefault = vayu::core::constants::database::CACHE_SIZE_BYTES;
    static_assert (kConfigured != kDefault, "the test value must differ from the default");

    {
        Database db (TEST_DB_PATH);
        db.init ();
        EXPECT_EQ (db.applied_cache_size_bytes (), kDefault)
        << "an unconfigured database opens at the compile-time default";

        auto entry = db.get_config_entry ("dbCacheSize");
        ASSERT_HAS_VALUE (entry) << "the entry survived the sweep";
        entry->value = std::to_string (kConfigured);
        db.save_config_entry (*entry);

        EXPECT_EQ (db.applied_cache_size_bytes (), kDefault)
        << "the running engine keeps the old size - that is what "
           "requiresRestart means";
    }

    Database reopened (TEST_DB_PATH);
    reopened.init ();
    EXPECT_EQ (reopened.applied_cache_size_bytes (), kConfigured);
}

// Issue #838. Everything the constructor does - two `sync_schema` passes and,
// through `init`, a sixty-row config seed - used to run on SQLite's own
// defaults, because the engine applied WAL and `synchronous` only after all of
// it. The assertions are deliberately made *before* `init` is called: that is
// the window that was unguarded, and after `init` both settings would be in
// force either way, so a test written there would pass against the bug.
TEST_F (DatabaseTest, TheFirstConnectionCarriesTheEnginesDurabilitySettings) {
    Database db (TEST_DB_PATH);

    EXPECT_EQ (db.applied_synchronous (), vayu::core::constants::database::SYNCHRONOUS)
    << "the schema sync ran at SQLite's default instead of the engine's";

    // Journal mode is read off the database header rather than from a `-wal`
    // sidecar: SQLite removes the sidecars when the last connection closes, and
    // sqlite_orm holds none open between statements, so by the time the
    // constructor returns there is nothing beside the file to look at. Byte 18
    // of every SQLite file is the write format version - 1 for a rollback
    // journal, 2 for WAL - and it persists, which is the point of the check.
    std::ifstream header (TEST_DB_PATH, std::ios::binary);
    ASSERT_TRUE (header.is_open ());
    std::array<char, 20> format{};
    ASSERT_TRUE (
    header.read (format.data (), static_cast<std::streamsize> (format.size ())))
    << "a database this engine created is longer than its own header";
    EXPECT_EQ (static_cast<int> (format[18]), 2)
    << "the schema was written under a rollback journal, before init() set WAL";
}

// The other half of the same change: `init` must still hand the *configured*
// level to the connection, so raising `dbSynchronous` is not quietly undone by
// the default the constructor now applies. Reopened, because the entry is
// restart-required - the same shape as CacheSizeConfigReachesTheConnection.
TEST_F (DatabaseTest, SynchronousConfigStillWinsOverTheConstructorDefault) {
    constexpr int kConfigured = 2; // FULL
    static_assert (kConfigured != vayu::core::constants::database::SYNCHRONOUS,
    "the test value must differ from the default the constructor applies");

    {
        Database db (TEST_DB_PATH);
        db.init ();
        auto entry = db.get_config_entry ("dbSynchronous");
        ASSERT_HAS_VALUE (entry);
        entry->value = std::to_string (kConfigured);
        db.save_config_entry (*entry);
    }

    Database reopened (TEST_DB_PATH);
    reopened.init ();
    EXPECT_EQ (reopened.applied_synchronous (), kConfigured);
}

// The seed is one transaction now (issue #838) rather than sixty-odd implicit
// ones. What that must not change is what a re-seed *means*, which is the
// regression a transaction wrapper can plausibly introduce: same rows, user
// values kept, metadata refreshed. Proving the rollback half would need a
// mid-seed failure, and this suite deliberately builds no fault injection for
// SQLite (see the note in `db_concurrency_test.cpp`), so that half is left to
// the shape of the code rather than claimed here.
TEST_F (DatabaseTest, ASeedInsideOneTransactionStillPreservesUserValues) {
    Database db (TEST_DB_PATH);
    db.init ();

    const size_t seeded = db.get_all_config_entries ().size ();
    ASSERT_GT (seeded, 40u)
    << "the seed is the many-row write this test is about";

    auto entry = db.get_config_entry ("dbBusyTimeout");
    ASSERT_HAS_VALUE (entry);
    entry->value = "12345";
    db.save_config_entry (*entry);

    db.seed_default_config ();

    EXPECT_EQ (db.get_all_config_entries ().size (), seeded)
    << "a re-seed neither adds nor drops rows";
    auto preserved = db.get_config_entry ("dbBusyTimeout");
    ASSERT_HAS_VALUE (preserved);
    EXPECT_EQ (preserved->value, "12345")
    << "the seed keeps a user's value and only refreshes metadata";
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
    ASSERT_HAS_VALUE (seeded);
    ASSERT_HAS_VALUE (seeded->options);

    ConfigEntry upgraded_row = *seeded;
    upgraded_row.value       = "http2";  // user's choice, must survive re-seed
    upgraded_row.options = std::nullopt; // pre-Task-4 row never had this column
    db.save_config_entry (upgraded_row);
    const auto downgraded = db.get_config_entry ("defaultHttpVersion");
    ASSERT_HAS_VALUE (downgraded);
    ASSERT_FALSE (downgraded->options.has_value ());

    db.seed_default_config ();

    auto after = db.get_config_entry ("defaultHttpVersion");
    ASSERT_HAS_VALUE (after);
    EXPECT_EQ (after->value, "http2"); // user's value preserved
    ASSERT_HAS_VALUE (after->options); // metadata backfilled
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
// metric_ticks/results by run_id, requests by collection_id, collections by
// parent_id, runs by start_time. See the comments there for which queries
// rely on which. Named explicitly rather than counted, because sqlite also
// creates sqlite_autoindex_* entries of its own.
constexpr std::array<const char*, 8> EXPECTED_INDEXES = {
    "idx_metric_ticks_run_id", "idx_results_run_id",
    "idx_requests_collection_id", "idx_collections_parent_id",
    "idx_runs_start_time", "idx_result_bodies_run_id", "idx_body_blobs_run_id",
    // Examples are read only by request id - the list route and both cascades -
    // so this one backs every access the table has.
    "idx_request_examples_request_id"
};

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
        const auto* name = vayu::db::column_text (stmt, 0);
        if (name != nullptr) {
            names.emplace (name);
        }
    }

    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return names;
}

// Same approach as read_index_names, for a table rather than an index.
bool table_exists (const std::string& path, const std::string& table_name) {
    sqlite3* handle = nullptr;
    if (sqlite3_open (path.c_str (), &handle) != SQLITE_OK) {
        ADD_FAILURE () << "could not open " << path << ": " << sqlite3_errmsg (handle);
        sqlite3_close (handle);
        return false;
    }

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2 (handle, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
        -1, &stmt, nullptr) != SQLITE_OK) {
        ADD_FAILURE () << "could not query sqlite_master: " << sqlite3_errmsg (handle);
        sqlite3_close (handle);
        return false;
    }
    sqlite3_bind_text (stmt, 1, table_name.c_str (), -1, SQLITE_TRANSIENT);

    bool found = false;
    if (sqlite3_step (stmt) == SQLITE_ROW) {
        found = sqlite3_column_int (stmt, 0) > 0;
    }

    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return found;
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
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
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
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        sqlite3_stmt* stmt = nullptr;
        ASSERT_EQ (sqlite3_prepare_v2 (handle, "PRAGMA table_info(requests)", -1, &stmt, nullptr),
        SQLITE_OK);
        bool has_column = false;
        while (sqlite3_step (stmt) == SQLITE_ROW) {
            const auto* col_name = vayu::db::column_text (stmt, 1);
            if (col_name != nullptr && std::string (col_name) == "http_version") {
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
    ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);

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
    EXPECT_EQ (std::string (vayu::db::column_text (row_stmt, 0)), "Pre-migration request");
    EXPECT_EQ (std::string (vayu::db::column_text (row_stmt, 1)), "auto");
    sqlite3_finalize (row_stmt);
    sqlite3_close (handle);
}

// A database written by an engine before issue #177 still carries the legacy
// EAV `metrics` table and its index. sync_schema() only syncs the tables the
// storage still declares - it never drops the ones removed from it - so
// Database::init() drops this one explicitly, or every upgraded database keeps
// paying for ~20 rows/sec of dead history forever. Recreates that table
// externally, the same way the tests above simulate a pre-migration schema.
TEST_F (DatabaseTest, DropsTheLegacyMetricsTableFromAPreUpgradeDatabase) {
    // Recent, so init()'s retention pass (runRetentionDays) does not prune the
    // run out from under the assertions below.
    const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                        .count ();
    {
        Database db (TEST_DB_PATH);
        db.init ();

        vayu::db::Run run;
        run.id              = "run_pre_upgrade";
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Completed;
        run.start_time      = now;
        run.config_snapshot = "{}";
        db.create_run (run);

        vayu::db::MetricTick tick;
        tick.run_id    = "run_pre_upgrade";
        tick.timestamp = now;
        tick.payload   = R"({"timestamp":1000,"requests_completed":7})";
        db.add_metric_tick (tick);
    }

    // Put the pre-upgrade table back, populated, exactly as the old engine left it.
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        char* err = nullptr;
        ASSERT_EQ (
        sqlite3_exec (handle,
        "CREATE TABLE metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, "
        "name TEXT NOT NULL, value REAL NOT NULL, labels TEXT NOT NULL);"
        "CREATE INDEX idx_metrics_run_id ON metrics (run_id);"
        "INSERT INTO metrics (run_id, timestamp, name, value, labels) "
        "VALUES ('run_pre_upgrade', 1, 'total_requests', 7.0, '');",
        nullptr, nullptr, &err),
        SQLITE_OK)
        << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
        sqlite3_close (handle);
    }

    // Guard the guard: without this the assertions below pass on a database
    // that never had the table to begin with.
    ASSERT_TRUE (table_exists (TEST_DB_PATH, "metrics"))
    << "the pre-upgrade table was not recreated";

    {
        Database db (TEST_DB_PATH);
        db.init ();

        // Everything the run still owns is served normally after the drop.
        auto run = db.get_run ("run_pre_upgrade");
        ASSERT_HAS_VALUE (run);
        EXPECT_EQ (run->status, vayu::RunStatus::Completed);
        EXPECT_EQ (db.count_metric_ticks ("run_pre_upgrade"), 1);
    }

    EXPECT_FALSE (table_exists (TEST_DB_PATH, "metrics"))
    << "init() left the legacy metrics table behind";
    // The index goes with its table - sqlite drops it as part of DROP TABLE.
    EXPECT_EQ (read_index_names (TEST_DB_PATH).count ("idx_metrics_run_id"), 0u);
}

// ============================================================================
// Run retention (prune_runs)
// ============================================================================

namespace {

// A terminal run with an explicit id/start_time, plus one metric tick and one
// result so prune's cascade delete is observable.
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

    seed_run_with_children (db, "fresh", now - 1 * day);
    seed_run_with_children (db, "stale", now - 40 * day);

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
    ASSERT_TRUE (db.set_run_baseline ("pinned", true).has_value ());


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
    const int64_t ninety_days_ago = now - 90 * day;
    seed_run_with_children (db, "pinned_stale", ninety_days_ago);
    seed_run_with_children (db, "stale", ninety_days_ago);
    ASSERT_TRUE (db.set_run_baseline ("pinned_stale", true).has_value ());

    db.prune_runs (0, 30);

    auto ids = run_ids (db);
    EXPECT_TRUE (ids.count ("pinned_stale"));
    EXPECT_FALSE (ids.count ("stale"));
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

    db.delete_collection ("col_1");
    EXPECT_TRUE (db.get_spec_document ("spec_1").has_value ())
    << "a document a second collection still binds was swept";

    db.delete_collection ("col_2");
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
    ASSERT_HAS_VALUE (run);
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
    ASSERT_HAS_VALUE (run);
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
        for (const auto& entry : fs::directory_iterator (dir))
            names.insert (entry.path ().filename ().string ());
        return names;
    };

    // Opened twice: the backup is written from an *existing* database, so a
    // single open would not produce the `.bak` this is here to catch.
    for (int i = 0; i < 2; ++i) {
        Database db (stem.string ());
        db.init ();
    }

    // The scan must have seen something, or "nothing left over" below is
    // vacuously true - the failure mode CLAUDE.md calls out for source guards.
    const auto written = leftovers ();
    ASSERT_FALSE (written.empty ())
    << "the database wrote nothing; the test proves nothing";
    EXPECT_TRUE (written.count ("test_scratch.db.bak"))
    << "no backup was written, so this run would not catch a missing `.bak`";

    vayu::tests::remove_database_files (stem.string ());

    const auto remaining = leftovers ();
    EXPECT_TRUE (remaining.empty ())
    << "remove_database_files left " << remaining.size ()
    << " file(s) behind, starting with " << *remaining.begin ();

    fs::remove_all (dir);
}

} // namespace
} // namespace vayu::db
