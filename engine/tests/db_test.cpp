/**
 * @file tests/db_test.cpp
 * @brief Tests for Database class
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <initializer_list>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/file_ref.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/utils/diagnostics.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::db {

// Defined in src/db/db_maintenance.cpp and declared in the internal
// `database_impl.hpp`, which `db_layout_test.cpp` keeps out of tests; the
// `on_connection` seam is the reason this one is called directly.
enum class PreMigrationSnapshot : std::uint8_t { Take, Skip };
bool migrate_before_sync (const std::string& path,
std::chrono::milliseconds busy_timeout,
PreMigrationSnapshot snapshot,
const std::function<void (sqlite3*)>& on_connection);

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

// The summary reads (#2546) keep the full reads' tie rule and trash filters.
// Every row ties on `order`; `created_at` separates two of them and `id` the
// two that tie on both, inserted against each order so rowid order fails.
// Mutation check: drop `created_at` or `id` from `sibling_order`, or the
// `deleted_at` filter from `live_requests_in`, and this reds.
TEST_F (DatabaseTest, RequestSummariesInCollectionFollowTheTieRuleAndSkipTheTrash) {
    Database db (TEST_DB_PATH);
    db.init ();

    Collection col;
    col.id   = "col_1";
    col.name = "API";
    db.create_collection (col);

    const std::vector<std::pair<std::string, int64_t>> inserted = {
        { "req_late", 9 }, { "req_tie_b", 5 }, { "req_trashed", 1 },
        { "req_tie_a", 5 }, { "req_early", 2 }
    };
    for (const auto& [id, created_at] : inserted) {
        Request r;
        r.id            = id;
        r.collection_id = "col_1";
        r.name          = id;
        r.method        = vayu::HttpMethod::PATCH;
        r.url           = "https://example.test/" + id;
        r.created_at    = created_at;
        db.save_request (r);
    }
    db.delete_request ("req_trashed");

    const auto summaries = db.get_request_summaries_in_collection ("col_1");
    std::vector<std::string> ids;
    ids.reserve (summaries.size ());
    for (const auto& s : summaries) {
        ids.push_back (s.id);
    }
    EXPECT_EQ (ids,
    (std::vector<std::string>{ "req_early", "req_tie_a", "req_tie_b", "req_late" }));
    ASSERT_FALSE (summaries.empty ());
    EXPECT_EQ (summaries[0].collection_id, "col_1");
    EXPECT_EQ (summaries[0].method, vayu::HttpMethod::PATCH);
    EXPECT_EQ (summaries[0].url, "https://example.test/req_early");
    EXPECT_EQ (summaries[0].created_at, 2);
    EXPECT_FALSE (summaries[0].spec_operation.has_value ());
}

// Mutation check: drop the collection subquery from
// `live_requests_in_live_collections`, or `collection_id` from `tree_order`,
// and this reds.
TEST_F (DatabaseTest, RequestSummariesInLiveCollectionsGroupByCollectionAndSkipATrashedOne) {
    Database db (TEST_DB_PATH);
    db.init ();

    for (const std::string id : { "col_b", "col_a", "col_gone" }) {
        Collection col;
        col.id   = id;
        col.name = id;
        // Stamped alone, leaving its request live: only the collection
        // filter can keep `req_gone` out.
        if (id == "col_gone") {
            col.deleted_at = 1;
        }
        db.create_collection (col);
    }
    const std::vector<std::tuple<std::string, std::string, int>> inserted = {
        { "req_b0", "col_b", 0 }, { "req_gone", "col_gone", 0 },
        { "req_a1", "col_a", 1 }, { "req_a0", "col_a", 0 }
    };
    for (const auto& [id, collection_id, order] : inserted) {
        Request r;
        r.id             = id;
        r.collection_id  = collection_id;
        r.name           = id;
        r.order          = order;
        r.spec_operation = R"({"method":"GET","path":"/x"})";
        db.save_request (r);
    }

    const auto summaries = db.get_request_summaries_in_live_collections ();
    std::vector<std::string> ids;
    ids.reserve (summaries.size ());
    for (const auto& s : summaries) {
        ids.push_back (s.id);
        EXPECT_EQ (s.spec_operation, R"({"method":"GET","path":"/x"})");
    }
    EXPECT_EQ (ids, (std::vector<std::string>{ "req_a0", "req_a1", "req_b0" }));
}

// ==================== Config Cleanup Tests ====================

// `is_known_config_key` is the catalogue check `POST`/`GET /config` refuse an
// unrecognised row by (issue #1492) - a row this build did not seed is not the
// same as a row that does not exist, and only the seed pass can say which keys
// this engine declares.
TEST_F (DatabaseTest, KnownConfigKeyIsWhateverSeedDefaultConfigUpserted) {
    Database db (TEST_DB_PATH);
    db.init ();

    EXPECT_TRUE (db.is_known_config_key ("workers"));
    EXPECT_FALSE (db.is_known_config_key ("totally_made_up_key"));
}

// A row saved directly (as if a newer engine's own seed wrote it) has a real
// row - `get_config_entry` finds it - but is not in this build's catalogue.
// Mutation check: read `is_known_config_key` as "any row present" instead of
// the seeded set, and this reds.
TEST_F (DatabaseTest, ARowWithNoSeedingEntryIsNotAKnownConfigKey) {
    Database db (TEST_DB_PATH);
    db.init ();

    ConfigEntry future_row;
    future_row.key           = "futureEngineOnlyKey";
    future_row.value         = "1";
    future_row.type          = "integer";
    future_row.label         = "Not Ours";
    future_row.description   = "Declared by a build newer than this one.";
    future_row.category      = "general_engine";
    future_row.default_value = "1";
    db.save_config_entry (future_row);

    ASSERT_HAS_VALUE (db.get_config_entry ("futureEngineOnlyKey"));
    EXPECT_FALSE (db.is_known_config_key ("futureEngineOnlyKey"));
}

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

// Every retired key (`kRetiredConfigKeys`): requestBatchSize, contextPoolSize
// (#112) and the eleven the 2026-08 sweep (#519) retired at once. Nothing read
// them, so a user could turn any of them and change nothing - and because the
// Settings UI renders engine entries dynamically from GET /config, an upgraded
// database must lose the row too, or the dead knob keeps showing up. Pinned as
// a list rather than one test per key - the guarantee is identical for all of
// them, and a key added to the retirement list without its row being deleted
// is the only way this can regress.
TEST_F (DatabaseTest, SeedRemovesEveryRetiredEntry) {
    const std::vector<std::string> retired = { "requestBatchSize", "contextPoolSize",
        "maxConnections", "tcpKeepAliveIdle", "tcpKeepAliveInterval",
        "statsInterval", "maxJsonFieldSize", "sseConnectTimeout", "sseMaxRetry",
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
        ASSERT_HAS_VALUE (db.get_config_entry (key));
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

    // A literal, not the constant: comparing the constant to itself passes
    // whatever it is set to (#2419 - it was 0, which can corrupt on power loss).
    EXPECT_EQ (db.applied_synchronous (), 1)
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

// A fresh workspace opens at NORMAL (#2419): WAL syncs only at a checkpoint,
// so a commit costs no fsync, and unlike OFF a power cut cannot corrupt the
// file. Literals on purpose - the constant compared to itself proves nothing.
TEST_F (DatabaseTest, AFreshWorkspaceDefaultsToNormalSynchronous) {
    Database db (TEST_DB_PATH);
    db.init ();

    auto entry = db.get_config_entry ("dbSynchronous");
    ASSERT_HAS_VALUE (entry);
    EXPECT_EQ (entry->value, "1");
    EXPECT_EQ (entry->default_value, "1");
    EXPECT_EQ (db.applied_synchronous (), 1);
}

// The converse of the migration below: a level the user picked past the old
// default is theirs, and the adopt-new-default rule must not touch it.
TEST_F (DatabaseTest, AStoredFullSynchronousSurvivesAReopen) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        auto entry = db.get_config_entry ("dbSynchronous");
        ASSERT_HAS_VALUE (entry);
        entry->value = "2";
        db.save_config_entry (*entry);
    }

    Database reopened (TEST_DB_PATH);
    reopened.init ();
    auto entry = reopened.get_config_entry ("dbSynchronous");
    ASSERT_HAS_VALUE (entry);
    EXPECT_EQ (entry->value, "2");
    EXPECT_EQ (entry->default_value, "1");
    EXPECT_EQ (reopened.applied_synchronous (), 2);
}

// An install from before #2419 holds value "0" beside default "0". The first
// start of this build moves it to Normal and applies it on that same start;
// the next one changes nothing.
TEST_F (DatabaseTest, AWorkspaceOnTheOldOffDefaultMovesToNormalOnce) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        auto entry = db.get_config_entry ("dbSynchronous");
        ASSERT_HAS_VALUE (entry);
        entry->value         = "0";
        entry->default_value = "0";
        db.save_config_entry (*entry);
    }

    int64_t migrated_at = 0;
    {
        Database reopened (TEST_DB_PATH);
        reopened.init ();
        auto entry = reopened.get_config_entry ("dbSynchronous");
        ASSERT_HAS_VALUE (entry);
        EXPECT_EQ (entry->value, "1");
        EXPECT_EQ (entry->default_value, "1");
        EXPECT_EQ (reopened.applied_synchronous (), 1);
        migrated_at = entry->updated_at;
    }

    // The move is once: a later start finds value == default and writes
    // nothing, so the row's timestamp is the migration's and not the latest
    // start's.
    Database second (TEST_DB_PATH);
    second.init ();
    auto again = second.get_config_entry ("dbSynchronous");
    ASSERT_HAS_VALUE (again);
    EXPECT_EQ (again->value, "1");
    EXPECT_EQ (again->default_value, "1");
    EXPECT_EQ (again->updated_at, migrated_at);
    EXPECT_EQ (second.applied_synchronous (), 1);
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
// Simulates the upgrade the same way SeedRemovesEveryRetiredEntry does:
// plant a pre-Task-4-shaped row (no options), then re-run the seed.
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
    ASSERT_HAS_VALUE (retrieved);

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

// Every index declared in make_vayu_storage(), each backing a hot query path:
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

// request_examples.spec_example_key (issue #1457) is nullable rather than NOT
// NULL + default, so there is nothing to backfill: a row from before the
// column existed simply has no key on it. Simulates the pre-existing table
// the same way MigratesHttpVersionColumnOntoAPreExistingRequestsTable does.
TEST_F (DatabaseTest, MigratesSpecExampleKeyColumnOntoAPreExistingExamplesTable) {
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

        RequestExample x;
        x.id         = "exa_pre_migration";
        x.request_id = "req_pre_migration";
        x.name       = "200";
        x.created_at = 1;
        x.updated_at = 1;
        db.save_request_example (x);
    }

    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        char* err = nullptr;
        ASSERT_EQ (sqlite3_exec (handle, "ALTER TABLE request_examples DROP COLUMN spec_example_key",
                   nullptr, nullptr, &err),
        SQLITE_OK)
        << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
        sqlite3_close (handle);
    }

    // Guard the guard: if the drop silently did nothing, the assertion below
    // would pass without proving anything.
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        sqlite3_stmt* stmt = nullptr;
        ASSERT_EQ (sqlite3_prepare_v2 (handle,
                   "PRAGMA table_info(request_examples)", -1, &stmt, nullptr),
        SQLITE_OK);
        bool has_column = false;
        while (sqlite3_step (stmt) == SQLITE_ROW) {
            const auto* col_name = vayu::db::column_text (stmt, 1);
            if (col_name != nullptr && std::string (col_name) == "spec_example_key") {
                has_column = true;
            }
        }
        sqlite3_finalize (stmt);
        sqlite3_close (handle);
        ASSERT_FALSE (has_column) << "drop did not remove spec_example_key";
    }

    // The column is back, and the pre-existing row survived with its data
    // intact and no key to have recorded - not silently dropped and
    // recreated empty.
    Database reopened (TEST_DB_PATH);
    reopened.init ();
    auto after = reopened.get_request_example ("exa_pre_migration");
    ASSERT_HAS_VALUE (after);
    EXPECT_EQ (after->name, "200");
    EXPECT_FALSE (after->spec_example_key.has_value ());
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
// result so prune's cascade delete is observable. A load run unless asked
// otherwise: `max_runs`, the cap most cases here exercise, counts load and
// collection runs and leaves design Sends to their own cap (#2429).
void seed_run_with_children (Database& db,
const std::string& id,
int64_t start_time,
vayu::RunStatus status = vayu::RunStatus::Completed,
vayu::RunType type     = vayu::RunType::Load) {
    vayu::db::Run run;
    run.id              = id;
    run.type            = type;
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

// ============================================================================
// migrate_before_sync (issue #1514's cut-over): pre_request_script /
// post_request_script -> elements, ahead of sync_schema's DROP COLUMN.
// ============================================================================

namespace {

/// Reopens @p path with sqlite3 directly and adds back the two pre-cutover
/// script columns (already dropped from the current schema) - the shape a
/// database written before this issue's engine looks like.
void add_legacy_script_columns (const std::string& path) {
    sqlite3* handle = nullptr;
    ASSERT_EQ (sqlite3_open (path.c_str (), &handle), SQLITE_OK);
    for (const char* table : { "requests", "collections" }) {
        for (const char* column : { "pre_request_script", "post_request_script" }) {
            char* err             = nullptr;
            const std::string sql = std::string ("ALTER TABLE ") + table +
            " ADD COLUMN " + column + " TEXT DEFAULT ''";
            ASSERT_EQ (sqlite3_exec (handle, sql.c_str (), nullptr, nullptr, &err), SQLITE_OK)
            << (err != nullptr ? err : "(no message)");
            sqlite3_free (err);
        }
    }
    sqlite3_close (handle);
}

/// Drops `elements` from both tables - the shape a database genuinely older
/// than issue #1513 has: it never ran the additive pass that added the
/// column, so `elements` does not exist at all, not merely unpopulated.
void drop_elements_column (const std::string& path) {
    sqlite3* handle = nullptr;
    ASSERT_EQ (sqlite3_open (path.c_str (), &handle), SQLITE_OK);
    for (const char* table : { "requests", "collections" }) {
        char* err = nullptr;
        const std::string sql = std::string ("ALTER TABLE ") + table + " DROP COLUMN elements";
        ASSERT_EQ (sqlite3_exec (handle, sql.c_str (), nullptr, nullptr, &err), SQLITE_OK)
        << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
    }
    sqlite3_close (handle);
}

/// Adds back only @p column (one of the two script columns) - the shape a
/// row that predates the *other* script column carrying anything can have.
void add_single_legacy_script_column (const std::string& path, const char* column) {
    sqlite3* handle = nullptr;
    ASSERT_EQ (sqlite3_open (path.c_str (), &handle), SQLITE_OK);
    for (const char* table : { "requests", "collections" }) {
        char* err             = nullptr;
        const std::string sql = std::string ("ALTER TABLE ") + table +
        " ADD COLUMN " + column + " TEXT DEFAULT ''";
        ASSERT_EQ (sqlite3_exec (handle, sql.c_str (), nullptr, nullptr, &err), SQLITE_OK)
        << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
    }
    sqlite3_close (handle);
}

void set_legacy_scripts (const std::string& path,
const std::string& table,
const std::string& id,
const std::string& pre,
const std::string& post) {
    sqlite3* handle = nullptr;
    ASSERT_EQ (sqlite3_open (path.c_str (), &handle), SQLITE_OK);
    sqlite3_stmt* stmt    = nullptr;
    const std::string sql = "UPDATE " + table +
    " SET pre_request_script = ?1, post_request_script = ?2 WHERE id = ?3";
    ASSERT_EQ (sqlite3_prepare_v2 (handle, sql.c_str (), -1, &stmt, nullptr), SQLITE_OK);
    sqlite3_bind_text (stmt, 1, pre.c_str (), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text (stmt, 2, post.c_str (), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text (stmt, 3, id.c_str (), -1, SQLITE_TRANSIENT);
    ASSERT_EQ (sqlite3_step (stmt), SQLITE_DONE);
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
}

bool table_has_column (const std::string& path, const char* table, const char* column) {
    sqlite3* handle = nullptr;
    if (sqlite3_open (path.c_str (), &handle) != SQLITE_OK) {
        return false;
    }
    const std::string sql = std::string ("PRAGMA table_info(") + table + ")";
    sqlite3_stmt* stmt    = nullptr;
    bool found            = false;
    if (sqlite3_prepare_v2 (handle, sql.c_str (), -1, &stmt, nullptr) == SQLITE_OK) {
        while (sqlite3_step (stmt) == SQLITE_ROW) {
            const auto* name = vayu::db::column_text (stmt, 1);
            if (name != nullptr && std::string (name) == column) {
                found = true;
            }
        }
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return found;
}

int64_t read_user_version (const std::string& path) {
    sqlite3* handle = nullptr;
    if (sqlite3_open (path.c_str (), &handle) != SQLITE_OK) {
        return -1;
    }
    sqlite3_stmt* stmt = nullptr;
    int64_t version    = -1;
    if (sqlite3_prepare_v2 (handle, "PRAGMA user_version", -1, &stmt, nullptr) == SQLITE_OK &&
    sqlite3_step (stmt) == SQLITE_ROW) {
        version = sqlite3_column_int64 (stmt, 0);
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return version;
}

void set_user_version (const std::string& path, int64_t version) {
    sqlite3* handle = nullptr;
    ASSERT_EQ (sqlite3_open (path.c_str (), &handle), SQLITE_OK);
    const std::string sql = "PRAGMA user_version = " + std::to_string (version);
    ASSERT_EQ (sqlite3_exec (handle, sql.c_str (), nullptr, nullptr, nullptr), SQLITE_OK);
    sqlite3_close (handle);
}

/// The copies a start took before migrating `TEST_DB_PATH`
/// (`backups/vayu-<stamp>-pre-v<N>.db`), oldest first.
std::vector<std::string> pre_migration_snapshots () {
    namespace fs = std::filesystem;
    std::vector<std::string> found;
    std::error_code ec;
    const fs::path backups = fs::path (TEST_DB_PATH).parent_path () / "backups";
    for (fs::directory_iterator it (backups, ec), end; !ec && it != end; it.increment (ec)) {
        const std::string name = it->path ().filename ().string ();
        if (name.starts_with ("vayu-") && name.find ("-pre-v") != std::string::npos) {
            found.push_back (it->path ().string ());
        }
    }
    std::sort (found.begin (), found.end ());
    return found;
}

} // namespace

TEST_F (DatabaseTest, MigratesPreCutoverScriptColumnsIntoElements) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        Collection col;
        col.id    = "col_1";
        col.name  = "C";
        col.order = 0;
        db.create_collection (col);
        Request r;
        r.id            = "req_1";
        r.collection_id = "col_1";
        r.name          = "R";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        db.save_request (r);
    }

    add_legacy_script_columns (TEST_DB_PATH);
    set_legacy_scripts (TEST_DB_PATH, "requests", "req_1",
    "pm.environment.set('x', 1);", "pm.test('ok', () => {});");
    ASSERT_TRUE (table_has_column (TEST_DB_PATH, "requests", "pre_request_script"))
    << "test setup did not add the legacy column";
    // The first `Database (TEST_DB_PATH)` block above already ran
    // `migrate_before_sync` on a fresh file and left `user_version` at 1 (it
    // found nothing to fold, but a database this engine has opened once is
    // migrated). A real pre-cutover database was never opened by this engine
    // at all, so it reads as `user_version` 0 - reset it here to simulate
    // that genuinely unmigrated shape rather than one this test's own setup
    // already marked done.
    set_user_version (TEST_DB_PATH, 0);

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    EXPECT_FALSE (table_has_column (TEST_DB_PATH, "requests", "pre_request_script"));
    EXPECT_FALSE (table_has_column (TEST_DB_PATH, "requests", "post_request_script"));
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);

    Database reopened (TEST_DB_PATH);
    reopened.init ();
    auto folded = reopened.get_request ("req_1");
    ASSERT_HAS_VALUE (folded);
    const auto elements = nlohmann::json::parse (folded->elements);
    ASSERT_EQ (elements.size (), 2u);
    EXPECT_EQ (elements[0]["kind"], "script.pre");
    EXPECT_EQ (elements[0]["config"]["script"], "pm.environment.set('x', 1);");
    EXPECT_EQ (elements[1]["kind"], "script.post");
    EXPECT_EQ (elements[1]["config"]["script"], "pm.test('ok', () => {});");
}

namespace {

/// A commit hook that refuses every commit: SQLite turns the `COMMIT` (and an
/// autocommit write) into a rollback and reports `SQLITE_CONSTRAINT`.
int refuse_every_commit (void*) {
    return 1;
}

/// Records each statement the connection starts, so a test can say which
/// ones never ran.
int record_statement (unsigned, void* context, void*, void* statement_sql) {
    static_cast<std::vector<std::string>*> (context)->emplace_back (
    static_cast<const char*> (statement_sql));
    return 0;
}

/// A version-0 workspace the way an engine older than #1514 left it: the
/// legacy script columns back on both tables and a script on `req_1`.
void seed_unmigrated_script_row () {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        Collection col;
        col.id    = "col_1";
        col.name  = "C";
        col.order = 0;
        db.create_collection (col);
        Request r;
        r.id            = "req_1";
        r.collection_id = "col_1";
        r.name          = "R";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        db.save_request (r);
    }
    add_legacy_script_columns (TEST_DB_PATH);
    set_legacy_scripts (TEST_DB_PATH, "requests", "req_1",
    "pm.environment.set('x', 1);", "pm.test('ok', () => {});");
    set_user_version (TEST_DB_PATH, 0);
}

/// `req_1`'s legacy `pre_request_script`, read straight from the file.
std::string read_legacy_pre_script () {
    sqlite3* handle = nullptr;
    EXPECT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
    sqlite3_stmt* stmt = nullptr;
    EXPECT_EQ (sqlite3_prepare_v2 (handle, "SELECT pre_request_script FROM requests WHERE id = 'req_1'",
               -1, &stmt, nullptr),
    SQLITE_OK);
    std::string script;
    if (sqlite3_step (stmt) == SQLITE_ROW) {
        script = vayu::db::column_text (stmt, 0);
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return script;
}

} // namespace

// A failed COMMIT must refuse the start with the scripts still in the file:
// the next `sync_schema ()` drops the columns, so a migration that returned
// normally would leave them nowhere but the unvalidated pre-migration copy.
// Mutation check: drop the result of the `COMMIT` in `apply_migration_rows`
// and the throw never comes.
TEST_F (DatabaseTest, AFailedCommitDuringTheScriptFoldRefusesAndKeepsTheScripts) {
    seed_unmigrated_script_row ();

    EXPECT_THROW (vayu::db::migrate_before_sync (TEST_DB_PATH,
                  std::chrono::milliseconds (50), PreMigrationSnapshot::Take,
                  [] (sqlite3* connection) {
                      sqlite3_commit_hook (connection, refuse_every_commit, nullptr);
                  }),
    std::runtime_error);

    EXPECT_EQ (read_user_version (TEST_DB_PATH), 0);
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "requests", "pre_request_script"));
    EXPECT_EQ (read_legacy_pre_script (), "pm.environment.set('x', 1);");

    // The file is as the failed start found it, so the next start folds.
    Database retry (TEST_DB_PATH);
    retry.init ();
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    auto folded = retry.get_request ("req_1");
    ASSERT_HAS_VALUE (folded);
    const auto elements = nlohmann::json::parse (folded->elements);
    ASSERT_EQ (elements.size (), 2u) << folded->elements;
    EXPECT_EQ (elements[0]["config"]["script"], "pm.environment.set('x', 1);");
}

// A `BEGIN IMMEDIATE` another writer blocks must refuse before a row is
// touched. The statement log is what tells that apart from a fold whose
// first `UPDATE` hits the same lock: both throw, only the second ran one.
// Mutation check: drop the result of the `BEGIN IMMEDIATE` and the log holds
// an `UPDATE`.
TEST_F (DatabaseTest, AFailedBeginRefusesBeforeTouchingRows) {
    seed_unmigrated_script_row ();

    sqlite3* holder = nullptr;
    ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &holder), SQLITE_OK);
    ASSERT_EQ (sqlite3_exec (holder, "BEGIN IMMEDIATE;", nullptr, nullptr, nullptr), SQLITE_OK);

    std::vector<std::string> statements;
    EXPECT_THROW (vayu::db::migrate_before_sync (TEST_DB_PATH,
                  std::chrono::milliseconds (50), PreMigrationSnapshot::Take,
                  [&statements] (sqlite3* connection) {
                      sqlite3_trace_v2 (connection, SQLITE_TRACE_STMT,
                      record_statement, &statements);
                  }),
    std::runtime_error);
    sqlite3_exec (holder, "ROLLBACK;", nullptr, nullptr, nullptr);
    sqlite3_close (holder);

    const auto began = std::ranges::count_if (statements,
    [] (const std::string& sql) { return sql.starts_with ("BEGIN IMMEDIATE"); });
    EXPECT_EQ (began, 1) << "the refusal did not come from the BEGIN";
    for (const auto& sql : statements) {
        EXPECT_FALSE (sql.starts_with ("UPDATE")) << "a row was written: " << sql;
    }
    EXPECT_EQ (read_user_version (TEST_DB_PATH), 0);
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "requests", "pre_request_script"));
    EXPECT_EQ (read_legacy_pre_script (), "pm.environment.set('x', 1);");
}

// The stamp-only branch has no transaction of its own to fail at COMMIT: a
// stamp SQLite refuses must still throw, or the version never moves and
// every start re-runs the plan. Mutation check: drop the result in
// `stamp_schema_version`.
TEST_F (DatabaseTest, AFailedStampOnTheStampOnlyBranchThrows) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    set_user_version (TEST_DB_PATH, 2);

    EXPECT_THROW (vayu::db::migrate_before_sync (TEST_DB_PATH,
                  std::chrono::milliseconds (50), PreMigrationSnapshot::Take,
                  [] (sqlite3* connection) {
                      sqlite3_commit_hook (connection, refuse_every_commit, nullptr);
                  }),
    std::runtime_error);
    EXPECT_EQ (read_user_version (TEST_DB_PATH), 2);

    Database retry (TEST_DB_PATH);
    retry.init ();
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
}

// A database the additive #1513 repair pass already folded (elements already
// populated) must not gain a duplicate entry when this migration runs.
TEST_F (DatabaseTest, MigrationLeavesAnAlreadyFoldedRowWithNoDuplicate) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        Collection col;
        col.id    = "col_1";
        col.name  = "C";
        col.order = 0;
        db.create_collection (col);
        Request r;
        r.id            = "req_1";
        r.collection_id = "col_1";
        r.name          = "R";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        r.elements      = nlohmann::json::array (
        { nlohmann::json{ { "id", "el_pre" }, { "kind", "script.pre" }, { "enabled", true },
             { "config", { { "script", "pm.environment.set('x', 1);" } } } } })
                     .dump ();
        db.save_request (r);
    }

    add_legacy_script_columns (TEST_DB_PATH);
    set_legacy_scripts (
    TEST_DB_PATH, "requests", "req_1", "pm.environment.set('x', 1);", "");
    // See `MigratesPreCutoverScriptColumnsIntoElements`: the first open above
    // already bumped `user_version` to 1, so without this reset the migrating
    // open below would skip its scan entirely (version already current) and
    // this test would pass vacuously rather than exercising the "already
    // folded" skip it names.
    set_user_version (TEST_DB_PATH, 0);

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    Database reopened (TEST_DB_PATH);
    reopened.init ();
    auto row = reopened.get_request ("req_1");
    ASSERT_HAS_VALUE (row);
    const auto elements = nlohmann::json::parse (row->elements);
    ASSERT_EQ (elements.size (), 1u)
    << "the already-folded script.pre must not be duplicated: " << row->elements;
}

TEST_F (DatabaseTest, MigrationDoesNothingOnASecondOpen) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    add_legacy_script_columns (TEST_DB_PATH);
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    ASSERT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);

    // A second open at the current `user_version` must be a fast no-op: no
    // copy taken (there is nothing left to migrate).
    Database again (TEST_DB_PATH);
    again.init ();
    EXPECT_TRUE (pre_migration_snapshots ().empty ())
    << "an already-migrated database must not be re-migrated";
}

namespace {

/// Drop the four `requests` columns issue #1765 added, the shape a database
/// written before them has.
void drop_protocol_setting_columns (const char* path) {
    sqlite3* handle = nullptr;
    ASSERT_EQ (sqlite3_open (path, &handle), SQLITE_OK);
    for (const char* column : { "disable_cookies", "disabled_system_headers",
         "disable_url_encoding", "postman_protocol_behavior" }) {
        char* err = nullptr;
        const auto sql = std::string ("ALTER TABLE requests DROP COLUMN ") + column;
        const int code = sqlite3_exec (handle, sql.c_str (), nullptr, nullptr, &err);
        EXPECT_EQ (code, SQLITE_OK) << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
        EXPECT_FALSE (table_has_column (path, "requests", column))
        << "test setup did not remove " << column;
    }
    sqlite3_close (handle);
}

/// `req_1` came back with every #1765 column at its default.
void expect_protocol_settings_backfilled (Database& db) {
    auto request = db.get_request ("req_1");
    ASSERT_HAS_VALUE (request)
    << "the request row did not survive the columns' return";
    EXPECT_FALSE (request->disable_cookies);
    EXPECT_EQ (request->disabled_system_headers, "[]");
    EXPECT_FALSE (request->disable_url_encoding);
    EXPECT_FALSE (request->postman_protocol_behavior.has_value ());
}

} // namespace

// Schema version 2 added `request_examples.postman_response`. A version-1
// database has nothing to fold: `sync_schema ()` adds the nullable column
// and the migration only stamps it. Mutation check: write a literal `1` back
// into either `user_version` write in `migrate_before_sync` and the version
// assertion reds.
TEST_F (DatabaseTest, AVersionOneDatabaseIsStampedTwoWithItsExamplesIntact) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        Collection col;
        col.id    = "col_1";
        col.name  = "C";
        col.order = 0;
        db.create_collection (col);
        Request r;
        r.id            = "req_1";
        r.collection_id = "col_1";
        r.name          = "R";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        db.save_request (r);
        RequestExample x;
        x.id         = "exa_1";
        x.request_id = "req_1";
        x.name       = "Created";
        x.status     = 201;
        x.created_at = 1;
        x.updated_at = 1;
        db.save_request_example (x);
    }
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        char* err = nullptr;
        ASSERT_EQ (sqlite3_exec (handle, "ALTER TABLE request_examples DROP COLUMN postman_response",
                   nullptr, nullptr, &err),
        SQLITE_OK)
        << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
        sqlite3_close (handle);
    }
    drop_protocol_setting_columns (TEST_DB_PATH);
    ASSERT_FALSE (table_has_column (TEST_DB_PATH, "request_examples", "postman_response"))
    << "test setup did not remove the column";
    set_user_version (TEST_DB_PATH, 1);

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    EXPECT_EQ (vayu::db::SCHEMA_VERSION, 7);
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "request_examples", "postman_response"));

    Database reopened (TEST_DB_PATH);
    reopened.init ();
    auto after = reopened.get_request_example ("exa_1");
    ASSERT_HAS_VALUE (after);
    EXPECT_EQ (after->name, "Created");
    EXPECT_EQ (after->status, 201);
    EXPECT_FALSE (after->postman_response.has_value ());
    expect_protocol_settings_backfilled (reopened);
}

// Schema version 5 dropped `oauth_tokens.raw_response` (#1781): it held the
// provider's whole token response, refresh and id tokens included, and nothing
// read it. The drop is `sync_schema ()`'s, so a row written by an older engine
// must survive it with the columns the engine still maps. Mutation check:
// map `make_column ("raw_response", ...)` back onto `oauth_tokens` and the
// column is still there after the upgrade, which reds the first assertion.
TEST_F (DatabaseTest, AVersionFourDatabaseLosesTheStoredOAuthRawResponseButKeepsTheToken) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        char* err = nullptr;
        ASSERT_EQ (sqlite3_exec (handle, "ALTER TABLE oauth_tokens ADD COLUMN raw_response TEXT",
                   nullptr, nullptr, &err),
        SQLITE_OK)
        << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
        ASSERT_EQ (
        sqlite3_exec (handle,
        "INSERT INTO oauth_tokens (cache_key, access_token, token_type, "
        "refresh_token, scope, expires_in, created_at, raw_response) VALUES "
        "('key_1', 'at-secret', 'Bearer', 'rt-secret', 'read', 3600, 1, "
        "'{\"access_token\":\"at-secret\",\"id_token\":\"idt-secret\"}')",
        nullptr, nullptr, &err),
        SQLITE_OK)
        << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
        sqlite3_close (handle);
    }
    ASSERT_TRUE (table_has_column (TEST_DB_PATH, "oauth_tokens", "raw_response"))
    << "test setup did not add the column";
    set_user_version (TEST_DB_PATH, 4);

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    EXPECT_FALSE (table_has_column (TEST_DB_PATH, "oauth_tokens", "raw_response"));
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);

    Database reopened (TEST_DB_PATH);
    reopened.init ();
    const auto token = reopened.get_oauth_token ("key_1");
    ASSERT_HAS_VALUE (token);
    EXPECT_EQ (token->access_token, "at-secret");
    EXPECT_EQ (token->refresh_token, "rt-secret");
    EXPECT_EQ (token->scope, "read");
    EXPECT_EQ (token->expires_in, 3600);
}

// Issue #1765 folded the four `requests` protocol-setting columns into the
// same version 2 (no released build ever stamped 2), so a database an earlier
// build of that version already stamped still gets them: `sync_schema ()`
// adds a NOT NULL-with-default or nullable column by itself on every start,
// whatever the stamp. Mutation check: drop the `default_value` from
// `disable_cookies` in `make_vayu_storage` and the request row does not
// survive the column's return.
TEST_F (DatabaseTest, AVersionTwoDatabaseWithoutTheProtocolSettingColumnsGetsThem) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        Collection col;
        col.id    = "col_1";
        col.name  = "C";
        col.order = 0;
        db.create_collection (col);
        Request r;
        r.id            = "req_1";
        r.collection_id = "col_1";
        r.name          = "R";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        db.save_request (r);
    }
    drop_protocol_setting_columns (TEST_DB_PATH);
    set_user_version (TEST_DB_PATH, 2);

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    for (const char* column : { "disable_cookies", "disabled_system_headers",
         "disable_url_encoding", "postman_protocol_behavior" }) {
        EXPECT_TRUE (table_has_column (TEST_DB_PATH, "requests", column)) << column;
    }
    Database reopened (TEST_DB_PATH);
    reopened.init ();
    expect_protocol_settings_backfilled (reopened);
}

// Schema version 3 is the `file_roots` table (the folders request-body files
// may be read from) and nothing to move: a version-2 database is stamped
// current and gains the table, and its rows round-trip. Mutation check: skip
// the stamp on `migrate_before_sync`'s no-fold path and the version stays 2.
TEST_F (DatabaseTest, AVersionTwoDatabaseIsStampedCurrentAndGainsTheFileRootsTable) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        ASSERT_EQ (
        sqlite3_exec (handle, "DROP TABLE file_roots", nullptr, nullptr, nullptr), SQLITE_OK);
        sqlite3_close (handle);
    }
    set_user_version (TEST_DB_PATH, 2);
    ASSERT_FALSE (table_has_column (TEST_DB_PATH, "file_roots", "path"));

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "file_roots", "path"));

    Database reopened (TEST_DB_PATH);
    reopened.init ();
    vayu::FileRoot root;
    root.id         = "froot_1";
    root.path       = "/data/fixtures";
    root.created_at = 7;
    reopened.save_file_root (root);
    const auto rows = reopened.get_file_roots ();
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_EQ (rows[0].path, "/data/fixtures");
    EXPECT_EQ (rows[0].created_at, 7);
    ASSERT_HAS_VALUE (reopened.get_file_root ("froot_1"));
    reopened.delete_file_root ("froot_1");
    EXPECT_TRUE (reopened.get_file_roots ().empty ());
}

// The picked files (`file_grants`, schema version 6, #2356) are plain CRUD:
// they round-trip ordered by path, one reads back by id, and a delete removes
// exactly one.
TEST_F (DatabaseTest, FileGrantsRoundTrip) {
    Database db (TEST_DB_PATH);
    db.init ();
    for (const auto& [id, path] : std::vector<std::pair<std::string, std::string>>{
         { "fgrant_b", "/data/b.bin" }, { "fgrant_a", "/data/a.bin" } }) {
        vayu::FileGrant grant;
        grant.id         = id;
        grant.path       = path;
        grant.created_at = 7;
        db.save_file_grant (grant);
    }
    const auto rows = db.get_file_grants ();
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_EQ (rows[0].path, "/data/a.bin") << "ordered by path";
    EXPECT_EQ (rows[1].path, "/data/b.bin");
    const auto one = db.get_file_grant ("fgrant_b");
    ASSERT_HAS_VALUE (one);
    EXPECT_EQ (one->path, "/data/b.bin");
    EXPECT_EQ (one->created_at, 7);
    EXPECT_FALSE (db.get_file_grant ("fgrant_missing"));

    db.delete_file_grant ("fgrant_a");
    ASSERT_EQ (db.get_file_grants ().size (), 1u);
    EXPECT_EQ (db.get_file_grants ()[0].id, "fgrant_b");
}

// ---------------------------------------------------------------------------
// The file-trust step: stored bodies lose `unresolved` and the files a person
// chose become grants (version 6), and the allowed folders the root rule
// refuses are gone (version 4).
// ---------------------------------------------------------------------------

namespace {

/// One column of one row, read raw: no reader in `Database` filters it.
std::string read_stored (const std::string& path,
const char* table,
const char* column,
const std::string& id) {
    sqlite3* handle = nullptr;
    std::string out;
    if (sqlite3_open (path.c_str (), &handle) != SQLITE_OK) {
        return out;
    }
    const std::string sql =
    std::string ("SELECT ") + column + " FROM " + table + " WHERE id = ?1";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2 (handle, sql.c_str (), -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text (stmt, 1, id.c_str (), -1, SQLITE_TRANSIENT);
        if (sqlite3_step (stmt) == SQLITE_ROW) {
            const auto* text = vayu::db::column_text (stmt, 0);
            out              = text != nullptr ? text : "";
        }
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return out;
}

constexpr const char* kBrokenBody = R"({"mode":"binary","file":{"src":"/abs/x.bin")";

/// The user's home folder as the migration compares it.
std::string canonical_home () {
    const std::string home      = vayu::platform::home_directory ();
    const std::string canonical = vayu::http::canonical_root_path (home);
    return canonical.empty () ? home : canonical;
}

/// A file the migration can grant, under the working directory (private to
/// this test process), by its canonical path.
std::string trust_file (const std::string& name) {
    const std::filesystem::path file =
    std::filesystem::current_path () / "trust-migration" / name;
    std::filesystem::create_directories (file.parent_path ());
    std::ofstream (file) << name;
    return std::filesystem::canonical (file).string ();
}

/// Stores a request in `col_1` whose body text is exactly @p body.
void save_body (Database& db, const char* id, const std::string& body, bool trashed = false) {
    Request r;
    r.id            = id;
    r.collection_id = "col_1";
    r.name          = id;
    r.method        = vayu::HttpMethod::POST;
    r.url           = "https://example.test";
    r.body          = body;
    r.order         = 0;
    r.created_at    = 1;
    r.updated_at    = 1;
    // Now, not a fixed instant: the startup trash retention would purge an
    // old trashed request before a migration test reads it.
    if (trashed) {
        r.deleted_at = now_ms ();
    }
    db.save_request (r);
}

/// A design run whose snapshot sends @p body.
void save_snapshot (Database& db, const char* id, const std::string& body) {
    vayu::db::Run run;
    run.id         = id;
    run.type       = vayu::RunType::Design;
    run.status     = vayu::RunStatus::Completed;
    run.start_time = now_ms ();
    run.config_snapshot =
    R"({"body":)" + body + R"(,"method":"POST","url":"https://example.test"})";
    db.create_run (run);
}

/// A binary body naming @p src, with @p trust as its stored `unresolved`
/// member (empty: no member at all).
std::string binary_body (const std::string& src, const std::string& trust = "") {
    nlohmann::json file{ { "src", src } };
    if (!trust.empty ()) {
        file["unresolved"] = nlohmann::json::parse (trust);
    }
    return nlohmann::json{ { "mode", "binary" }, { "file", file } }.dump ();
}

/// A fresh workspace at @p version whose `col_1` holds what @p seed stores,
/// `file_grants` dropped when the version predates it.
template <typename Seed>
void seed_workspace (const std::string& path, int64_t version, Seed seed) {
    {
        Database db (path);
        db.init ();
        Collection col;
        col.id    = "col_1";
        col.name  = "C";
        col.order = 0;
        db.create_collection (col);
        seed (db);
    }
    sqlite3* handle = nullptr;
    ASSERT_EQ (sqlite3_open (path.c_str (), &handle), SQLITE_OK);
    ASSERT_EQ (sqlite3_exec (handle, "DROP TABLE file_grants", nullptr, nullptr, nullptr),
    SQLITE_OK);
    sqlite3_close (handle);
    set_user_version (path, version);
}

/// A version-3 database as an engine before the trust flag failed closed left
/// it: file references without the key (one in the trash, one in a run's
/// snapshot, one naming a file that is gone), one stated `true`, one body that
/// is not JSON, and allowed folders at `/`, at the home folder, at its parent
/// and inside it.
void seed_version_three_workspace (const std::string& path) {
    seed_workspace (path, 3, [] (Database& db) {
        save_body (db, "req_bin", binary_body (trust_file ("a.bin")));
        save_body (db, "req_form",
        nlohmann::json{ { "mode", "form-data" },
        { "fields",
        nlohmann::json::array (
        { { { "key", "f" }, { "type", "file" }, { "src", trust_file ("p.png") } },
        { { "key", "t" }, { "value", "v" } } }) } }
        .dump ());
        save_body (db, "req_stated", binary_body (trust_file ("b.bin"), "true"));
        save_body (db, "req_trash", binary_body (trust_file ("t.bin")), /*trashed=*/true);
        save_body (db, "req_gone", binary_body ("/abs/gone.bin"));
        save_body (db, "req_broken", kBrokenBody);
        save_snapshot (db, "run_1", binary_body (trust_file ("c.bin")));

        const auto allow = [&] (const char* id, const std::string& folder) {
            vayu::FileRoot root;
            root.id         = id;
            root.path       = folder;
            root.created_at = 1;
            db.save_file_root (root);
        };
        allow ("froot_root", "/");
        allow ("froot_home", canonical_home ());
        // A home directly under `/` (root's `/root`) has `/` as its parent,
        // already seeded above and one folder per row.
        const std::string parent =
        std::filesystem::path (canonical_home ()).parent_path ().string ();
        if (parent != "/") {
            allow ("froot_parent", parent);
        }
        allow ("froot_inside",
        (std::filesystem::path (canonical_home ()) / "fixtures").string ());
    });
}

/// The `path` of every stored grant, ordered.
std::vector<std::string> granted_paths (const std::string& path) {
    Database db (path);
    db.init ();
    std::vector<std::string> paths;
    for (const auto& row : db.get_file_grants ()) {
        paths.push_back (row.path);
    }
    return paths;
}

/// Every stored body and snapshot of the trust seeds, raw.
std::vector<std::string> stored_trust_values (const std::string& path,
std::initializer_list<const char*> request_ids) {
    std::vector<std::string> out;
    for (const char* id : request_ids) {
        out.push_back (read_stored (path, "requests", "body", id));
    }
    out.push_back (read_stored (path, "runs", "config_snapshot", "run_1"));
    return out;
}

/// Every row @p sql answers on @p handle, its columns joined by `|`, SQL NULL
/// spelled `NULL` so it cannot read as an empty default.
std::vector<std::string> pragma_rows (sqlite3* handle, const std::string& sql) {
    std::vector<std::string> rows;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2 (handle, sql.c_str (), -1, &stmt, nullptr) != SQLITE_OK) {
        ADD_FAILURE () << sql << ": " << sqlite3_errmsg (handle);
        return rows;
    }
    while (sqlite3_step (stmt) == SQLITE_ROW) {
        std::string row;
        for (int i = 0; i < sqlite3_column_count (stmt); ++i) {
            const auto* text = vayu::db::column_text (stmt, i);
            row += (i == 0 ? "" : "|") + std::string (text != nullptr ? text : "NULL");
        }
        rows.push_back (std::move (row));
    }
    sqlite3_finalize (stmt);
    return rows;
}

/// @p table as SQLite describes it: each column from `PRAGMA table_xinfo`
/// (name, type, NOT NULL, default, key, hidden), then each index as its
/// uniqueness, origin, partiality and columns, sorted, without the names
/// SQLite numbers for itself.
std::vector<std::string> table_shape (const std::string& path, const std::string& table) {
    sqlite3* handle = nullptr;
    if (sqlite3_open (path.c_str (), &handle) != SQLITE_OK) {
        ADD_FAILURE () << "cannot open " << path;
        sqlite3_close (handle);
        return {};
    }
    std::vector<std::string> shape =
    pragma_rows (handle, "PRAGMA table_xinfo(\"" + table + "\")");
    std::vector<std::string> indexes;
    for (const std::string& entry :
    pragma_rows (handle, "PRAGMA index_list(\"" + table + "\")")) {
        // seq|name|unique|origin|partial
        const auto after_seq  = entry.find ('|') + 1;
        const auto after_name = entry.find ('|', after_seq);
        const std::string name = entry.substr (after_seq, after_name - after_seq);
        std::string summary = "index " + entry.substr (after_name + 1);
        for (const std::string& column :
        pragma_rows (handle, "PRAGMA index_info(\"" + name + "\")")) {
            summary += " " + column;
        }
        indexes.push_back (std::move (summary));
    }
    sqlite3_close (handle);
    std::sort (indexes.begin (), indexes.end ());
    shape.insert (shape.end (), indexes.begin (), indexes.end ());
    return shape;
}

constexpr const char* kUngrantedMessage =
"A request-body file chosen before the upgrade was not found, so it was not "
"recorded as a picked file; pick it again";
constexpr const char* kUngrantedSummary =
"Some request-body files chosen before the upgrade were not found and must "
"be picked again";

/// What opening @p path reports about chosen files it could not grant: one
/// `table|id|path` per warning, sorted, and the count the summary states
/// (-1 for no summary). The log goes under the working directory, which is
/// private to this test process.
struct UngrantedReport {
    std::vector<std::string> entries;
    int64_t count = -1;
};

UngrantedReport open_and_report_ungranted (const std::string& path) {
    const auto dir = std::filesystem::current_path () / "trust-migration-log";
    std::error_code ignored;
    std::filesystem::remove_all (dir, ignored);
    std::filesystem::create_directories (dir);
    vayu::utils::Logger::instance ().init (dir.string ());
    {
        Database db (path);
        db.init ();
    }
    vayu::utils::Logger::instance ().flush ();

    UngrantedReport report;
    for (const auto& file : std::filesystem::directory_iterator (dir)) {
        std::ifstream in (file.path ());
        for (std::string line; std::getline (in, line);) {
            const auto record = nlohmann::json::parse (line, nullptr, false);
            if (!record.is_object () || record.value ("level", "") != "warn") {
                continue;
            }
            if (record.value ("msg", "") == kUngrantedMessage) {
                report.entries.push_back (record.value ("table", "") + "|" +
                record.value ("id", "") + "|" + record.value ("path", ""));
            } else if (record.value ("msg", "") == kUngrantedSummary) {
                report.count = record.value ("count", int64_t{ -1 });
            }
        }
    }
    std::sort (report.entries.begin (), report.entries.end ());
    return report;
}

} // namespace

// Before version 4 the editor was the one writer that left the key out, so an
// absent key there was a person's choice: every such path that still names a
// regular file is granted, in the trash and in a run's snapshot too, and the
// key is gone from every body. Mutation checks: drop the `apply_file_trust_plan`
// rewrites and the bodies keep their key; drop the `insert_grants` call and
// nothing is granted; drop the `plan_refused_roots` call and `/`, the home
// folder and its parent are still allowed.
TEST_F (DatabaseTest, AVersionThreeDatabaseGrantsItsEditorPathsAndDropsRefusedRoots) {
    ASSERT_FALSE (vayu::platform::home_directory ().empty ())
    << "this platform reported no home folder to seed";
    std::filesystem::remove_all ("trust-migration");
    seed_version_three_workspace (TEST_DB_PATH);
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);

    std::vector<std::string> expected = { trust_file ("a.bin"),
        trust_file ("c.bin"), trust_file ("p.png"), trust_file ("t.bin") };
    std::sort (expected.begin (), expected.end ());
    EXPECT_EQ (granted_paths (TEST_DB_PATH), expected)
    << "a stated `true` and a file that is gone are not granted";

    for (const std::string& value : stored_trust_values (TEST_DB_PATH,
         { "req_bin", "req_form", "req_stated", "req_trash", "req_gone" })) {
        EXPECT_EQ (value.find ("unresolved"), std::string::npos) << value;
    }
    EXPECT_EQ (read_stored (TEST_DB_PATH, "requests", "body", "req_broken"), kBrokenBody)
    << "a body that is not JSON is left byte-identical";

    Database db (TEST_DB_PATH);
    db.init ();
    std::vector<std::string> ids;
    for (const auto& row : db.get_file_roots ()) {
        ids.push_back (row.id);
    }
    EXPECT_EQ (ids, std::vector<std::string>{ "froot_inside" })
    << "a filesystem root, home and its parent are no longer allowed";
    EXPECT_EQ (pre_migration_snapshots ().size (), 1u);
    std::filesystem::remove_all ("trust-migration");
}

TEST_F (DatabaseTest, TheFileTrustStepIsIdempotent) {
    std::filesystem::remove_all ("trust-migration");
    seed_version_three_workspace (TEST_DB_PATH);
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    const std::initializer_list<const char*> ids = { "req_bin", "req_form",
        "req_stated", "req_trash", "req_gone", "req_broken" };
    const auto first        = stored_trust_values (TEST_DB_PATH, ids);
    const auto first_grants = granted_paths (TEST_DB_PATH);

    // Run again as the step a stamped workspace passes through: from version 4
    // on, a key the first run removed reads as nobody's choice, so nothing is
    // granted twice and nothing is rewritten.
    set_user_version (TEST_DB_PATH, 5);
    {
        Database db (TEST_DB_PATH);
        db.init ();
        EXPECT_EQ (db.get_file_roots ().size (), 1u);
    }
    EXPECT_EQ (stored_trust_values (TEST_DB_PATH, ids), first);
    EXPECT_EQ (granted_paths (TEST_DB_PATH), first_grants) << "no grant twice";
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    std::filesystem::remove_all ("trust-migration");
}

// A version-6 database has had the file-trust step, so the later steps it
// passes through must not run it again: an allowed folder the root rule
// refuses today was accepted by the rule it was written under, and stays.
// Mutation check: drop the version gate in `plan_file_trust_migration` and
// the folder is removed.
TEST_F (DatabaseTest, AVersionSixDatabaseKeepsItsAllowedFoldersThroughLaterSteps) {
    seed_workspace (TEST_DB_PATH, 6, [] (Database& db) {
        vayu::FileRoot root;
        root.id         = "froot_home";
        root.path       = canonical_home ();
        root.created_at = 1;
        db.save_file_root (root);
    });
    ASSERT_TRUE (vayu::http::refused_root_reason (canonical_home (), canonical_home ()))
    << "the root rule accepts the seeded folder, so there is nothing to keep";

    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    std::vector<std::string> ids;
    for (const auto& row : db.get_file_roots ()) {
        ids.push_back (row.id);
    }
    EXPECT_EQ (ids, std::vector<std::string>{ "froot_home" });
}

// From version 4 every write stated the key, so only an explicit `false` was a
// person's choice: it is granted (once, however many bodies name it) and still
// sends; `true`, an absent key, a path that is gone and a templated path are
// not granted, and every key is removed. `file_grants` is dropped first, so
// the grants must survive the `sync_schema ()` that follows the step - which
// they do only while `FILE_GRANTS_DDL` matches the mapping. Mutation checks:
// make `FileAccessPolicy::allows` ignore grants and the chosen file is
// refused; read an absent key as chosen at version 5 and `n.bin` is granted.
TEST_F (DatabaseTest, AVersionFiveDatabaseGrantsThePathsStoredAsChosen) {
    std::filesystem::remove_all ("trust-migration");
    const std::string chosen   = trust_file ("chosen.bin");
    const std::string snapshot = trust_file ("snapshot.bin");
    const std::string stated   = trust_file ("stated.bin");
    seed_workspace (TEST_DB_PATH, 5, [&] (Database& db) {
        save_body (db, "req_false", binary_body (chosen, "false"));
        save_body (db, "req_again",
        nlohmann::json{ { "mode", "form-data" },
        { "fields",
        nlohmann::json::array ({ { { "key", "f" }, { "type", "file" },
        { "src", chosen }, { "unresolved", false } } }) } }
        .dump ());
        save_body (db, "req_true", binary_body (stated, "true"));
        save_body (db, "req_absent", binary_body (trust_file ("n.bin")));
        save_body (db, "req_gone", binary_body ("/abs/gone.bin", "false"));
        save_body (db, "req_templated", binary_body ("{{dir}}/chosen.bin", "false"));
        save_snapshot (db, "run_1", binary_body (snapshot, "false"));
    });

    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    std::vector<std::string> granted;
    for (const auto& row : db.get_file_grants ()) {
        granted.push_back (row.path);
        EXPECT_EQ (row.id.rfind ("fgrant_", 0), 0u) << row.id;
    }
    std::vector<std::string> expected = { chosen, snapshot };
    std::sort (expected.begin (), expected.end ());
    EXPECT_EQ (granted, expected);
    for (const std::string& value : stored_trust_values (TEST_DB_PATH,
         { "req_false", "req_again", "req_true", "req_absent", "req_gone", "req_templated" })) {
        EXPECT_EQ (value.find ("unresolved"), std::string::npos) << value;
    }

    // What the send reads is what the step granted.
    const auto sendable = [&] (const char* id) {
        const auto row = db.get_request (id);
        if (!row) {
            ADD_FAILURE () << id << " is gone";
            return false;
        }
        auto parsed = vayu::json::deserialize_request (
        nlohmann::json{ { "method", "POST" }, { "url", "https://example.test" },
        { "body", nlohmann::json::parse (row->body) } });
        if (!parsed.is_ok ()) {
            ADD_FAILURE () << id << ": " << parsed.error ().message;
            return false;
        }
        vayu::Request request = std::move (parsed).value ();
        vayu::http::FilePlan files (vayu::http::FileAccessPolicy::from_database (db));
        return !files.prepare (request).has_value ();
    };
    EXPECT_TRUE (sendable ("req_false"))
    << "a file chosen before the upgrade still sends";
    EXPECT_TRUE (sendable ("req_again"));
    EXPECT_FALSE (sendable ("req_true"));
    EXPECT_FALSE (sendable ("req_absent"));
    std::filesystem::remove_all ("trust-migration");
}

// `FILE_GRANTS_DDL` creates `file_grants` before `sync_schema ()` first sees
// it, so a migrated workspace keeps that table for good. A difference
// `sync_schema ()` acts on (NOT NULL, a default, the key) rebuilds it empty,
// which the surviving grant catches; one it ignores (a type, UNIQUE) leaves
// the migrated table unlike a fresh one, which the shape comparison catches.
// Mutation checks: drop NOT NULL from `created_at` in `FILE_GRANTS_DDL` and
// the grant is gone; drop UNIQUE from `path` and the indexes differ.
TEST_F (DatabaseTest, TheMigrationCreatesFileGrantsAsTheMappingDoes) {
    constexpr const char* FRESH_DB_PATH = "test_vayu_fresh.db";
    vayu::tests::remove_database_files (FRESH_DB_PATH);
    std::filesystem::remove_all ("trust-migration");
    const std::string chosen = trust_file ("chosen.bin");
    seed_workspace (TEST_DB_PATH, 5, [&] (Database& db) {
        save_body (db, "req_false", binary_body (chosen, "false"));
    });
    {
        Database migrated (TEST_DB_PATH);
        migrated.init ();
        Database fresh (FRESH_DB_PATH);
        fresh.init ();
    }

    EXPECT_EQ (granted_paths (TEST_DB_PATH), std::vector<std::string>{ chosen })
    << "sync_schema () rebuilt the table the migration created";
    const auto migrated_shape = table_shape (TEST_DB_PATH, "file_grants");
    EXPECT_FALSE (migrated_shape.empty ()) << "no file_grants table to compare";
    EXPECT_EQ (migrated_shape, table_shape (FRESH_DB_PATH, "file_grants"));
    vayu::tests::remove_database_files (FRESH_DB_PATH);
    std::filesystem::remove_all ("trust-migration");
}

// A file chosen before the upgrade whose path no longer names a regular file
// (deleted, or on a drive or share not mounted at upgrade time) gets no grant
// and is reported: one warning per stored body naming it, by table, id and
// path, and a count. A templated path, a stated `true` and (from version 4) an
// absent key were never a choice to carry over. Mutation check: drop the
// `ungranted.push_back` in `settle_choice` and nothing is reported.
TEST_F (DatabaseTest, AChosenFileThatIsGoneAtUpgradeIsReported) {
    std::filesystem::remove_all ("trust-migration");
    const std::string chosen = trust_file ("chosen.bin");
    seed_workspace (TEST_DB_PATH, 5, [&] (Database& db) {
        save_body (db, "req_gone", binary_body ("/abs/gone.bin", "false"));
        const auto chosen_part = [] (const std::string& src) {
            return nlohmann::json{ { "key", "f" }, { "type", "file" },
                { "src", src }, { "unresolved", false } };
        };
        const auto parts = nlohmann::json::array (
        { chosen_part (chosen), chosen_part ("/unplugged/b.bin") });
        save_body (db, "req_form",
        nlohmann::json{ { "mode", "form-data" }, { "fields", parts } }.dump ());
        save_body (db, "req_templated", binary_body ("{{dir}}/t.bin", "false"));
        save_body (db, "req_true", binary_body ("/abs/stated.bin", "true"));
        save_body (db, "req_absent", binary_body ("/abs/absent.bin"));
        save_snapshot (db, "run_1", binary_body ("/abs/snapshot.bin", "false"));
    });

    const auto report = open_and_report_ungranted (TEST_DB_PATH);
    EXPECT_EQ (report.entries,
    (std::vector<std::string>{ "requests|req_form|/unplugged/b.bin",
    "requests|req_gone|/abs/gone.bin", "runs|run_1|/abs/snapshot.bin" }));
    EXPECT_EQ (report.count, 3);
    EXPECT_EQ (granted_paths (TEST_DB_PATH), std::vector<std::string>{ chosen })
    << "reporting changes nothing about what is granted";
    std::filesystem::remove_all ("trust-migration");
}

// Before version 4 a chosen reference had no key, so a body naming a file that
// is gone has nothing to rewrite and the step only stamps; it must still say
// so. Mutation check: drop the `log_file_trust_plan` call on the stamp-only
// path of `migrate_before_sync` and nothing is reported.
TEST_F (DatabaseTest, AChosenFileThatIsGoneIsReportedWhenTheStepOnlyStamps) {
    seed_workspace (TEST_DB_PATH, 3, [] (Database& db) {
        save_body (db, "req_gone", binary_body ("/abs/gone.bin"));
    });

    const std::string body = read_stored (TEST_DB_PATH, "requests", "body", "req_gone");
    const auto report = open_and_report_ungranted (TEST_DB_PATH);
    EXPECT_EQ (read_stored (TEST_DB_PATH, "requests", "body", "req_gone"), body)
    << "the step rewrote something, so this did not take the stamp-only path";
    EXPECT_TRUE (granted_paths (TEST_DB_PATH).empty ());
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_EQ (report.entries, std::vector<std::string>{ "requests|req_gone|/abs/gone.bin" });
    EXPECT_EQ (report.count, 1);
}

// #1817's `runs.origin` / `origin_client` joined version 5 rather than bumping
// to 6 (no released build stamped 5), so a database an earlier build of that
// version stamped without them still gets both, and a run stored before reads
// as `other` with no client. Mutation check: drop the `default_value` from
// `origin` in `make_vayu_storage` and the run row does not survive the
// column's return.
TEST_F (DatabaseTest, AVersionFiveDatabaseWithoutTheRunOriginColumnsGetsThem) {
    // Recent, so the age-based prune `init ()` runs leaves the row alone.
    const int64_t recent = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                           .count ();
    {
        Database db (TEST_DB_PATH);
        db.init ();
        seed_run_with_children (db, "legacy", recent);
    }
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        for (const char* column : { "origin", "origin_client" }) {
            const std::string sql =
            std::string ("ALTER TABLE runs DROP COLUMN ") + column;
            char* err = nullptr;
            ASSERT_EQ (sqlite3_exec (handle, sql.c_str (), nullptr, nullptr, &err), SQLITE_OK)
            << (err != nullptr ? err : "(no message)");
            sqlite3_free (err);
        }
        sqlite3_close (handle);
    }
    ASSERT_FALSE (table_has_column (TEST_DB_PATH, "runs", "origin"))
    << "test setup did not remove the column";
    ASSERT_FALSE (table_has_column (TEST_DB_PATH, "runs", "origin_client"))
    << "test setup did not remove the column";
    set_user_version (TEST_DB_PATH, 5);

    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_EQ (vayu::db::SCHEMA_VERSION, 7);
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "runs", "origin"));
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "runs", "origin_client"));
    const auto legacy = db.get_run ("legacy");
    ASSERT_HAS_VALUE (legacy)
    << "a run stored before the columns did not survive";
    EXPECT_EQ (legacy->origin, "other");
    EXPECT_FALSE (legacy->origin_client.has_value ());
}

// A database stamped by the next schema is refused before anything writes to
// it: the file is byte-identical afterwards.
TEST_F (DatabaseTest, ADatabaseStampedWithTheNextSchemaIsRefusedUntouched) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    set_user_version (TEST_DB_PATH, vayu::db::SCHEMA_VERSION + 1);
    // Through `rdbuf ()`, not a pair of `istreambuf_iterator`s: GCC 13 at -O2
    // reports those as a potential null dereference (see db_recovery_test.cpp).
    const auto read_bytes = [] {
        std::ifstream in (TEST_DB_PATH, std::ios::binary);
        std::ostringstream buffer;
        buffer << in.rdbuf ();
        return buffer.str ();
    };
    const std::string before = read_bytes ();
    ASSERT_FALSE (before.empty ());

    EXPECT_THROW ({ Database db (TEST_DB_PATH); }, std::runtime_error);
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION + 1);
    EXPECT_TRUE (read_bytes () == before)
    << "a refused database must not be written";
}

namespace {

/// One sibling of a parent collection as the database stores it.
struct Sibling {
    std::string id;
    int64_t order      = 0;
    int64_t created_at = 0;
    int kind_rank      = 0; // 0 a sub-folder, 1 a request
};

/// Every child of @p parent_id, both kinds, trashed rows included.
std::vector<Sibling> read_siblings (const std::string& path, const std::string& parent_id) {
    std::vector<Sibling> siblings;
    sqlite3* handle = nullptr;
    if (sqlite3_open (path.c_str (), &handle) != SQLITE_OK) {
        ADD_FAILURE () << "cannot open " << path;
        return siblings;
    }
    constexpr const char* SQL =
    "SELECT id, \"order\", created_at, 0 FROM collections WHERE parent_id = ?1 "
    "UNION ALL SELECT id, \"order\", created_at, 1 FROM requests WHERE "
    "collection_id = ?1";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2 (handle, SQL, -1, &stmt, nullptr) != SQLITE_OK) {
        ADD_FAILURE () << sqlite3_errmsg (handle);
        sqlite3_close (handle);
        return siblings;
    }
    sqlite3_bind_text (stmt, 1, parent_id.c_str (), -1, SQLITE_TRANSIENT);
    while (sqlite3_step (stmt) == SQLITE_ROW) {
        const auto* id = vayu::db::column_text (stmt, 0);
        siblings.push_back ({ id != nullptr ? id : "", sqlite3_column_int64 (stmt, 1),
        sqlite3_column_int64 (stmt, 2), sqlite3_column_int (stmt, 3) });
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return siblings;
}

/// The ids of @p siblings in the order @p before ranks them.
template <typename Before>
std::vector<std::string> listed (std::vector<Sibling> siblings, Before before) {
    std::sort (siblings.begin (), siblings.end (), before);
    std::vector<std::string> ids;
    ids.reserve (siblings.size ());
    for (const auto& sibling : siblings) {
        ids.push_back (sibling.id);
    }
    return ids;
}

/// The display before version 7: each kind on its own `(order, createdAt,
/// id)`, sub-folders as one block above the requests.
std::vector<std::string> listed_as_two_blocks (const std::vector<Sibling>& siblings) {
    return listed (siblings, [] (const Sibling& a, const Sibling& b) {
        return std::tie (a.kind_rank, a.order, a.created_at, a.id) <
        std::tie (b.kind_rank, b.order, b.created_at, b.id);
    });
}

/// #2535's comparator: one `order` space, a sub-folder first on a tie.
std::vector<std::string> listed_in_one_space (const std::vector<Sibling>& siblings) {
    return listed (siblings, [] (const Sibling& a, const Sibling& b) {
        return std::tie (a.order, a.kind_rank, a.created_at, a.id) <
        std::tie (b.order, b.kind_rank, b.created_at, b.id);
    });
}

/// Every request's stored `order`, by id.
std::map<std::string, int64_t> request_orders (const std::string& path) {
    std::map<std::string, int64_t> orders;
    sqlite3* handle = nullptr;
    if (sqlite3_open (path.c_str (), &handle) != SQLITE_OK) {
        ADD_FAILURE () << "cannot open " << path;
        return orders;
    }
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2 (handle, "SELECT id, \"order\" FROM requests", -1,
        &stmt, nullptr) == SQLITE_OK) {
        while (sqlite3_step (stmt) == SQLITE_ROW) {
            const auto* id                  = vayu::db::column_text (stmt, 0);
            orders[id != nullptr ? id : ""] = sqlite3_column_int64 (stmt, 1);
        }
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return orders;
}

/// The parents `seed_sibling_workspace` gives children.
constexpr std::array<const char*, 5> SIBLING_PARENTS = { "col_root", "fld_a",
    "col_plain", "col_trash_only", "col_negative" };

/// A workspace as a version-6 engine numbered it, sub-folders and requests
/// each from 0, stamped @p version:
/// - `col_root`: folders `fld_a` 0, `fld_b` 1, `fld_trashed` 2 (trashed),
///   requests `req_1` 0, `req_2` 1, `req_3` 2 (trashed);
/// - `fld_a`: folder `fld_a_child` 0, requests `req_a1` 0, `req_a2` 1;
/// - `col_plain`: no folder, requests `req_p1` 0, `req_p2` 1;
/// - `col_trash_only`: folder `fld_gone` 0 (trashed), requests `req_t1` 0,
///   `req_t2` 1;
/// - `col_negative`: folder `fld_n` 0, requests `req_n1` -2, `req_n2` 0.
void seed_sibling_workspace (const std::string& path, int64_t version) {
    {
        Database db (path);
        db.init ();
        int64_t created = 1;
        const auto folder = [&] (const char* id, const char* parent, int order) {
            Collection col;
            col.id         = id;
            col.name       = id;
            col.order      = order;
            col.created_at = created++;
            col.updated_at = col.created_at;
            if (parent != nullptr) {
                col.parent_id = parent;
            }
            db.create_collection (col);
        };
        const auto request = [&] (const char* id, const char* parent, int order) {
            Request r;
            r.id            = id;
            r.collection_id = parent;
            r.name          = id;
            r.method        = vayu::HttpMethod::GET;
            r.url           = "https://example.test";
            r.order         = order;
            r.created_at    = created++;
            r.updated_at    = r.created_at;
            db.save_request (r);
        };
        for (const char* root : { "col_root", "col_plain", "col_trash_only", "col_negative" }) {
            folder (root, nullptr, 0);
        }
        folder ("fld_a", "col_root", 0);
        folder ("fld_b", "col_root", 1);
        folder ("fld_trashed", "col_root", 2);
        folder ("fld_a_child", "fld_a", 0);
        folder ("fld_gone", "col_trash_only", 0);
        folder ("fld_n", "col_negative", 0);
        request ("req_1", "col_root", 0);
        request ("req_2", "col_root", 1);
        request ("req_3", "col_root", 2);
        request ("req_a1", "fld_a", 0);
        request ("req_a2", "fld_a", 1);
        request ("req_p1", "col_plain", 0);
        request ("req_p2", "col_plain", 1);
        request ("req_t1", "col_trash_only", 0);
        request ("req_t2", "col_trash_only", 1);
        request ("req_n1", "col_negative", -2);
        request ("req_n2", "col_negative", 0);
    }
    sqlite3* handle = nullptr;
    ASSERT_EQ (sqlite3_open (path.c_str (), &handle), SQLITE_OK);
    // Now, not a fixed instant: the startup trash retention would purge an
    // old trashed row before the test reads it.
    const std::string now   = std::to_string (now_ms ());
    const std::string trash = "UPDATE collections SET deleted_at = " + now +
    " WHERE id IN ('fld_trashed', 'fld_gone');" +
    "UPDATE requests SET deleted_at = " + now + " WHERE id = 'req_3';";
    ASSERT_EQ (sqlite3_exec (handle, trash.c_str (), nullptr, nullptr, nullptr), SQLITE_OK)
    << sqlite3_errmsg (handle);
    sqlite3_close (handle);
    set_user_version (path, version);
}

} // namespace

// Version 7 puts a collection's sub-folders and requests in one `order` space
// (#2535). A version-6 workspace numbered each kind from 0, so the step moves
// every request past its collection's highest sub-folder - trashed ones
// included - and the merged comparator lists each parent exactly as the two
// blocks did. Mutation checks: drop the `apply_sibling_order_shift` call from
// `apply_migration_rows` and the interleaving parents' listings red; skip the
// trashed folders in `plan_sibling_order_shift` and the stored orders red;
// drop its negative-order term and `col_negative` reds.
TEST_F (DatabaseTest, AVersionSixDatabaseListsTheSameInOneSiblingOrder) {
    seed_sibling_workspace (TEST_DB_PATH, 6);
    std::map<std::string, std::vector<std::string>> displayed;
    for (const char* parent : SIBLING_PARENTS) {
        displayed[parent] = listed_as_two_blocks (read_siblings (TEST_DB_PATH, parent));
    }
    ASSERT_NE (listed_in_one_space (read_siblings (TEST_DB_PATH, "col_root")),
    displayed["col_root"])
    << "the fixture does not interleave, so the step has nothing to prove";

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_EQ (pre_migration_snapshots ().size (), 1u)
    << "no copy was saved before the shift";
    for (const char* parent : SIBLING_PARENTS) {
        EXPECT_EQ (listed_in_one_space (read_siblings (TEST_DB_PATH, parent)),
        displayed[parent])
        << parent;
    }
    const auto orders = request_orders (TEST_DB_PATH);
    const std::map<std::string, int64_t> expected = { { "req_1", 3 },
        { "req_2", 4 }, { "req_3", 5 }, { "req_a1", 1 }, { "req_a2", 2 },
        { "req_p1", 0 }, { "req_p2", 1 }, { "req_t1", 1 }, { "req_t2", 2 },
        { "req_n1", 1 }, { "req_n2", 3 } };
    EXPECT_EQ (orders, expected)
    << "past the trashed folders too; a collection with no folder is unmoved";
}

// The version stamp is the step's only done-marker: a second start, and a
// workspace a version-7 engine numbered, are not shifted again. Mutation
// check: drop both the fast path at `SCHEMA_VERSION` in `migrate_before_sync`
// and the version gate in `plan_sibling_order_shift` and both halves red.
TEST_F (DatabaseTest, TheSiblingOrderShiftRunsOnce) {
    seed_sibling_workspace (TEST_DB_PATH, 6);
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    const auto migrated  = request_orders (TEST_DB_PATH);
    const auto snapshots = pre_migration_snapshots ();
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    EXPECT_EQ (request_orders (TEST_DB_PATH), migrated) << "shifted twice";
    EXPECT_EQ (pre_migration_snapshots (), snapshots);

    vayu::tests::remove_database_files (TEST_DB_PATH);
    seed_sibling_workspace (TEST_DB_PATH, vayu::db::SCHEMA_VERSION);
    const auto numbered = request_orders (TEST_DB_PATH);
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    EXPECT_EQ (request_orders (TEST_DB_PATH), numbered)
    << "a version-7 workspace is already in one space";
    EXPECT_TRUE (pre_migration_snapshots ().empty ());
}

// A shift SQLite refuses rolls the whole step back: the file stays at version
// 6 with every request where it was, and the next start runs the step again.
TEST_F (DatabaseTest, ARefusedSiblingOrderShiftLeavesTheDatabaseAtSix) {
    seed_sibling_workspace (TEST_DB_PATH, 6);
    const auto before  = request_orders (TEST_DB_PATH);
    const auto run_sql = [] (const char* sql) {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        ASSERT_EQ (sqlite3_exec (handle, sql, nullptr, nullptr, nullptr), SQLITE_OK)
        << sqlite3_errmsg (handle);
        sqlite3_close (handle);
    };
    run_sql (
    "CREATE TRIGGER refuse_order BEFORE UPDATE OF \"order\" ON requests "
    "BEGIN SELECT RAISE (ABORT, 'refused by the test'); END;");

    EXPECT_THROW ({ Database db (TEST_DB_PATH); }, std::runtime_error);
    EXPECT_EQ (read_user_version (TEST_DB_PATH), 6);
    EXPECT_EQ (request_orders (TEST_DB_PATH), before) << "a half-shifted file";

    run_sql ("DROP TRIGGER refuse_order;");
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_EQ (request_orders (TEST_DB_PATH).at ("req_1"), 3);
}

// The column round-trips, and a tombstone clears it with the body it
// describes (issue #722's rule: nothing serves a suppressed row).
TEST_F (DatabaseTest, StoresAndTombstonesAnExamplesPostmanResponse) {
    Database db (TEST_DB_PATH);
    db.init ();
    Collection col;
    col.id    = "col_1";
    col.name  = "C";
    col.order = 0;
    db.create_collection (col);
    Request r;
    r.id            = "req_1";
    r.collection_id = "col_1";
    r.name          = "R";
    r.method        = vayu::HttpMethod::GET;
    r.url           = "https://example.test";
    r.order         = 0;
    r.created_at    = 1;
    r.updated_at    = 1;
    db.save_request (r);
    RequestExample x;
    x.id               = "exa_1";
    x.request_id       = "req_1";
    x.name             = "OK";
    x.postman_response = R"({"name":null,"status":"OK","cookie":[]})";
    x.created_at       = 1;
    x.updated_at       = 1;
    db.save_request_example (x);

    auto stored = db.get_request_example ("exa_1");
    ASSERT_HAS_VALUE (stored);
    ASSERT_HAS_VALUE (stored->postman_response);
    EXPECT_EQ (*stored->postman_response, R"({"name":null,"status":"OK","cookie":[]})");

    db.suppress_request_example ("exa_1", 2);
    const auto tombstones = db.get_suppressed_request_examples ("req_1");
    ASSERT_EQ (tombstones.size (), 1u);
    EXPECT_FALSE (tombstones[0].postman_response.has_value ());
}

TEST_F (DatabaseTest, ADatabaseFromANewerEngineIsRefused) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    set_user_version (TEST_DB_PATH, 99);

    EXPECT_THROW ({ Database db (TEST_DB_PATH); }, std::runtime_error);
}

// Issue #1593: a database older than #1513 has no `elements` column at all,
// not merely an unpopulated one - `fold_table_scripts_into_elements` used to
// `SELECT ... elements` unconditionally and fail to prepare on exactly this
// shape, which is what every 0.26 -> 0.27 upgrade hit. Mutation check: revert
// the `ADD COLUMN elements` branch in `fold_table_scripts_into_elements` and
// this reds with "no such column: elements" surfacing through the
// `std::runtime_error` this test expects *not* to be thrown.
TEST_F (DatabaseTest, MigratesADatabaseThatPredatesTheElementsColumn) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        Collection col;
        col.id    = "col_1";
        col.name  = "C";
        col.order = 0;
        db.create_collection (col);
        Request r;
        r.id            = "req_1";
        r.collection_id = "col_1";
        r.name          = "R";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        db.save_request (r);
    }

    add_legacy_script_columns (TEST_DB_PATH);
    set_legacy_scripts (TEST_DB_PATH, "requests", "req_1",
    "pm.environment.set('x', 1);", "pm.test('ok', () => {});");
    drop_elements_column (TEST_DB_PATH);
    ASSERT_FALSE (table_has_column (TEST_DB_PATH, "requests", "elements"))
    << "test setup did not remove the elements column";
    // See `MigratesPreCutoverScriptColumnsIntoElements`: the first open above
    // already bumped `user_version` to 1.
    set_user_version (TEST_DB_PATH, 0);

    EXPECT_NO_THROW ({
        Database db (TEST_DB_PATH);
        db.init ();
    });

    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "requests", "elements"));
    EXPECT_FALSE (table_has_column (TEST_DB_PATH, "requests", "pre_request_script"));
    EXPECT_FALSE (table_has_column (TEST_DB_PATH, "requests", "post_request_script"));
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_EQ (pre_migration_snapshots ().size (), 1u)
    << "no copy was saved first";

    Database reopened (TEST_DB_PATH);
    reopened.init ();
    auto folded = reopened.get_request ("req_1");
    ASSERT_HAS_VALUE (folded);
    const auto elements = nlohmann::json::parse (folded->elements);
    ASSERT_EQ (elements.size (), 2u);
    EXPECT_EQ (elements[0]["kind"], "script.pre");
    EXPECT_EQ (elements[0]["config"]["script"], "pm.environment.set('x', 1);");
    EXPECT_EQ (elements[1]["kind"], "script.post");
    EXPECT_EQ (elements[1]["config"]["script"], "pm.test('ok', () => {});");
}

// A row can predate whichever script column never carried anything for it -
// `fold_table_scripts_into_elements` used to `SELECT` both unconditionally,
// so a table missing either one failed to prepare the same way a missing
// `elements` column did. Mutation check: revert the literal-`''` fallback for
// a missing script column and this reds the same way.
TEST_F (DatabaseTest, MigratesWhenOnlyOneScriptColumnSurvives) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        Collection col;
        col.id    = "col_1";
        col.name  = "C";
        col.order = 0;
        db.create_collection (col);
        Request r;
        r.id            = "req_1";
        r.collection_id = "col_1";
        r.name          = "R";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        db.save_request (r);
    }

    add_single_legacy_script_column (TEST_DB_PATH, "post_request_script");
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        sqlite3_stmt* stmt = nullptr;
        ASSERT_EQ (sqlite3_prepare_v2 (handle, "UPDATE requests SET post_request_script = ?1 WHERE id = ?2",
                   -1, &stmt, nullptr),
        SQLITE_OK);
        sqlite3_bind_text (stmt, 1, "pm.test('ok', () => {});", -1, SQLITE_TRANSIENT);
        sqlite3_bind_text (stmt, 2, "req_1", -1, SQLITE_TRANSIENT);
        ASSERT_EQ (sqlite3_step (stmt), SQLITE_DONE);
        sqlite3_finalize (stmt);
        sqlite3_close (handle);
    }
    ASSERT_TRUE (table_has_column (TEST_DB_PATH, "requests", "post_request_script"));
    ASSERT_FALSE (table_has_column (TEST_DB_PATH, "requests", "pre_request_script"));
    set_user_version (TEST_DB_PATH, 0);

    EXPECT_NO_THROW ({
        Database db (TEST_DB_PATH);
        db.init ();
    });

    Database reopened (TEST_DB_PATH);
    reopened.init ();
    auto folded = reopened.get_request ("req_1");
    ASSERT_HAS_VALUE (folded);
    const auto elements = nlohmann::json::parse (folded->elements);
    ASSERT_EQ (elements.size (), 1u);
    EXPECT_EQ (elements[0]["kind"], "script.post");
    EXPECT_EQ (elements[0]["config"]["script"], "pm.test('ok', () => {});");
}

// ==================== The copy before a migration (#2426) ====================
//
// `<db>.bak` is refreshed from the migrated file once the engine listens, so a
// bump with nothing to rewrite used to leave no copy an older engine could
// open. Every bump now writes `backups/vayu-<stamp>-pre-v<N>.db` first.

namespace {

/// A workspace with `col_1` and two requests in it, closed.
void seed_two_requests () {
    Database db (TEST_DB_PATH);
    db.init ();
    Collection col;
    col.id    = "col_1";
    col.name  = "C";
    col.order = 0;
    db.create_collection (col);
    for (const char* id : { "req_1", "req_2" }) {
        Request r;
        r.id            = id;
        r.collection_id = "col_1";
        r.name          = id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test";
        r.created_at    = 1;
        r.updated_at    = 1;
        db.save_request (r);
    }
}

int64_t count_rows (const std::string& path, const std::string& table) {
    sqlite3* handle = nullptr;
    int64_t count   = -1;
    if (sqlite3_open (path.c_str (), &handle) != SQLITE_OK) {
        sqlite3_close (handle);
        return count;
    }
    const std::string sql = "SELECT count(*) FROM " + table;
    sqlite3_stmt* stmt    = nullptr;
    if (sqlite3_prepare_v2 (handle, sql.c_str (), -1, &stmt, nullptr) == SQLITE_OK &&
    sqlite3_step (stmt) == SQLITE_ROW) {
        count = sqlite3_column_int64 (stmt, 0);
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return count;
}

/// The whole of @p path, through `rdbuf ()` for the reason
/// `db_recovery_test.cpp`'s `read_file` gives.
std::string file_bytes (const std::string& path) {
    std::ifstream in (path, std::ios::binary);
    std::ostringstream buffer;
    buffer << in.rdbuf ();
    return buffer.str ();
}

} // namespace

// Mutation check: drop the `snapshot_before_migration` call in
// `migrate_before_sync` and no snapshot exists.
TEST_F (DatabaseTest, AStampOnlyBumpLeavesASnapshotAtThePreviousVersion) {
    // No sub-folder and no file reference, so the step from the previous
    // version has nothing to rewrite and only stamps.
    constexpr int64_t previous = vayu::db::SCHEMA_VERSION - 1;
    seed_two_requests ();
    set_user_version (TEST_DB_PATH, previous);

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    const auto snapshots = pre_migration_snapshots ();
    ASSERT_EQ (snapshots.size (), 1u);
    const std::string& snapshot = snapshots.front ();
    EXPECT_TRUE (snapshot.ends_with ("-pre-v" + std::to_string (previous) + ".db"))
    << snapshot;
    EXPECT_EQ (read_user_version (snapshot), previous);
    EXPECT_EQ (count_rows (snapshot, "requests"), 2);
    EXPECT_EQ (count_rows (snapshot, "collections"), 1);
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
}

TEST_F (DatabaseTest, TheFoldBranchSnapshotKeepsTheLegacyScriptColumns) {
    seed_unmigrated_script_row ();

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    const auto snapshots = pre_migration_snapshots ();
    ASSERT_EQ (snapshots.size (), 1u);
    const std::string& snapshot = snapshots.front ();
    EXPECT_TRUE (snapshot.ends_with ("-pre-v0.db")) << snapshot;
    EXPECT_EQ (read_user_version (snapshot), 0);
    EXPECT_TRUE (table_has_column (snapshot, "requests", "pre_request_script"));
    EXPECT_EQ (read_stored (snapshot, "requests", "pre_request_script", "req_1"),
    "pm.environment.set('x', 1);");
    EXPECT_FALSE (table_has_column (TEST_DB_PATH, "requests", "pre_request_script"))
    << "the live file was not migrated";
}

// Mutation check: ignore what `snapshot_before_rewrite` answers in
// `snapshot_before_migration` and the fold runs with no copy.
TEST_F (DatabaseTest, AFailedSnapshotRefusesToMigrate) {
    seed_unmigrated_script_row ();
    const std::string backups =
    (std::filesystem::path (TEST_DB_PATH).parent_path () / "backups").string ();
    // A file where the folder goes, so the folder cannot be created.
    std::ofstream (backups) << "not a directory";
    const std::string before = file_bytes (TEST_DB_PATH);

    std::string refusal;
    try {
        Database db (TEST_DB_PATH);
        ADD_FAILURE () << "the database was migrated with no copy";
    } catch (const std::runtime_error& e) {
        refusal = e.what ();
    }

    EXPECT_NE (refusal.find (TEST_DB_PATH), std::string::npos) << refusal;
    EXPECT_NE (refusal.find ("backup directory"), std::string::npos) << refusal;
    EXPECT_EQ (read_user_version (TEST_DB_PATH), 0);
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "requests", "pre_request_script"));
    EXPECT_EQ (read_legacy_pre_script (), "pm.environment.set('x', 1);");
    EXPECT_EQ (file_bytes (TEST_DB_PATH), before)
    << "the database was written to";

    // Once the folder can be created the same file migrates, copy first.
    std::filesystem::remove (backups);
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_EQ (pre_migration_snapshots ().size (), 1u);
}

// The copy shares `maxBackupsRetained` with the snapshots a user takes, read
// from the workspace before any `Database` exists. Mutation check: drop the
// `prune_backup_files` call in `snapshot_before_rewrite` and four remain;
// answer the default from `configured_backup_retention` and four remain.
TEST_F (DatabaseTest, ASnapshotIsPrunedToMaxBackupsRetained) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        auto entry = db.get_config_entry ("maxBackupsRetained");
        ASSERT_HAS_VALUE (entry);
        entry->value = "3";
        db.save_config_entry (*entry);
    }
    set_user_version (TEST_DB_PATH, vayu::db::SCHEMA_VERSION - 1);
    const std::filesystem::path backups =
    std::filesystem::path (TEST_DB_PATH).parent_path () / "backups";
    std::filesystem::create_directories (backups);
    const std::vector<std::string> older = { "vayu-20200101-000000-001.db",
        "vayu-20200101-000000-002.db", "vayu-20200101-000000-003.db" };
    for (const auto& name : older) {
        std::ofstream (backups / name) << "an older snapshot";
    }
    std::ofstream (backups / "kept-by-hand.db") << "not a name Vayu writes";

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }

    std::vector<std::string> names;
    for (const auto& entry : std::filesystem::directory_iterator (backups)) {
        names.push_back (entry.path ().filename ().string ());
    }
    std::sort (names.begin (), names.end ());
    ASSERT_EQ (names.size (), 4u);
    EXPECT_EQ (names[0], "kept-by-hand.db");
    EXPECT_EQ (names[1], older[1]);
    EXPECT_EQ (names[2], older[2]);
    EXPECT_TRUE (names[3].ends_with (
    "-pre-v" + std::to_string (vayu::db::SCHEMA_VERSION - 1) + ".db"))
    << names[3];
    std::filesystem::remove_all (backups);
}

} // namespace
} // namespace vayu::db
