/**
 * @file tests/db_test.cpp
 * @brief Database: open and create, globals, request and environment storage, the seeded config and
 * connection settings, the indexes and the column-adding migrations.
 *
 * The `DatabaseTest` fixture is in `database_fixture.hpp`.
 */

#include <gtest/gtest.h>
#include <sqlite3.h>

#include <array>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <set>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "database_fixture.hpp"
#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"

namespace vayu::db {

namespace {

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

// #2433. Without a `journal_size_limit` the `-wal` keeps the size one large
// transaction grew it to, because the autocheckpoint never truncates. The limit
// is per-connection state, so it is read back from the connection: a literal
// for the reason above, and before and after `init` like the settings above.
TEST_F (DatabaseTest, TheConnectionReportsTheJournalSizeLimit) {
    constexpr int64_t kSixtyFourMiB = 64LL * 1024 * 1024;

    Database db (TEST_DB_PATH);
    EXPECT_EQ (db.applied_journal_size_limit (), kSixtyFourMiB);

    db.init ();
    EXPECT_EQ (db.applied_journal_size_limit (), kSixtyFourMiB);
}

// #2433. A mapped region turns a read I/O error into a signal that kills the
// engine, so the connection opens unmapped. A literal for the reason above.
TEST_F (DatabaseTest, TheConnectionDoesNotMapTheDatabaseFile) {
    Database db (TEST_DB_PATH);
    EXPECT_EQ (db.applied_mmap_size (), 0);

    db.init ();
    EXPECT_EQ (db.applied_mmap_size (), 0);
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

// A trashed environment gives up the active slot in the delete itself (#2970),
// so neither path that activates another can leave two set, and none is
// active in between.
TEST_F (DatabaseTest, ATrashedEnvironmentGivesUpTheActiveSlot) {
    Database db (TEST_DB_PATH);
    db.init ();
    db.save_environment (make_environment ("env_dev", true));

    db.delete_environment ("env_dev");
    EXPECT_TRUE (active_environment_ids (db).empty ());

    db.save_environment (make_environment ("env_prod", true));
    EXPECT_EQ (active_environment_ids (db), std::vector<std::string>{ "env_prod" });
    db.import_apply ({}, {}, { make_environment ("env_imported", true) });
    EXPECT_EQ (active_environment_ids (db), std::vector<std::string>{ "env_imported" });

    ASSERT_HAS_VALUE (db.restore_deleted ("env_dev"));
    EXPECT_EQ (active_environment_ids (db), std::vector<std::string>{ "env_imported" })
    << "a restore does not take the slot back";
}

// ==================== Index Tests ====================

// Every index declared in make_vayu_storage(), each backing a hot query path:
// metric_ticks/results by run_id, requests by collection_id, collections by
// parent_id, runs by start_time, stamped requests by deleted_at. See the
// comments there for which queries rely on which. Named explicitly rather
// than counted, because sqlite also creates sqlite_autoindex_* entries of its
// own.
constexpr std::array<const char*, 9> EXPECTED_INDEXES = {
    "idx_metric_ticks_run_id", "idx_results_run_id",
    "idx_requests_collection_id", "idx_collections_parent_id",
    "idx_runs_start_time", "idx_result_bodies_run_id", "idx_body_blobs_run_id",
    // Examples are read only by request id - the list route and both cascades -
    // so this one backs every access the table has.
    "idx_request_examples_request_id",
    // Partial: only the trashed rows, which is all get_trash reads (#3006).
    "idx_requests_deleted_at"
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

} // namespace

} // namespace vayu::db
