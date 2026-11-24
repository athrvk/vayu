/**
 * @file tests/db_migration_test.cpp
 * @brief Database migrations: the pre-request/post-request script fold into `elements`, the pre-migration
 * snapshot and the early schema-version upgrades.
 *
 * The `DatabaseTest` fixture is in `database_fixture.hpp`.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "database_fixture.hpp"
#include "optional_assert.hpp"
#include "vayu/db/database.hpp"

namespace vayu::db {

namespace {

// ============================================================================
// migrate_before_sync (issue #1514's cut-over): pre_request_script /
// post_request_script -> elements, ahead of sync_schema's DROP COLUMN.
// ============================================================================

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

    EXPECT_EQ (vayu::db::SCHEMA_VERSION, 11);
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

// Schema version 10 is the `spec_declined_operations` table (#3031) and nothing
// to move: a version-9 database is stamped current and gains it. Mutation
// check: leave `SCHEMA_VERSION` at 9 and the stamp stays where it was.
TEST_F (DatabaseTest, AVersionNineDatabaseIsStampedCurrentAndGainsTheDeclinedOperationsTable) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        ASSERT_EQ (sqlite3_exec (handle, "DROP TABLE spec_declined_operations",
                   nullptr, nullptr, nullptr),
        SQLITE_OK);
        sqlite3_close (handle);
    }
    set_user_version (TEST_DB_PATH, 9);
    ASSERT_FALSE (table_has_column (TEST_DB_PATH, "spec_declined_operations", "path"));

    {
        Database db (TEST_DB_PATH);
        db.init ();
    }
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "spec_declined_operations", "request_id"));
}

// One record per operation under one binding: a second request's delete for
// the same operation takes the row over rather than adding one, an operation
// with no `operationId` is its own row, and a record under another binding is
// another row.
TEST_F (DatabaseTest, DeclinedOperationsRoundTripOneRowPerOperationPerBinding) {
    Database db (TEST_DB_PATH);
    db.init ();
    for (const char* id : { "col_a", "col_b" }) {
        Collection collection;
        collection.id   = id;
        collection.name = id;
        db.create_collection (collection);
    }
    const auto stamped_request = [&db] (const std::string& id,
                                 const std::string& collection_id, const char* identity) {
        Request request;
        request.id             = id;
        request.collection_id  = collection_id;
        request.name           = id;
        request.spec_operation = identity;
        db.save_request (request);
    };
    stamped_request ("req_1", "col_a",
    R"({"operationId":"listPets","method":"GET","path":"/pets"})");
    stamped_request ("req_2", "col_a",
    R"({"operationId":"listPets","method":"GET","path":"/pets"})");
    stamped_request ("req_3", "col_a", R"({"method":"GET","path":"/pets"})");
    stamped_request ("req_4", "col_b",
    R"({"operationId":"listPets","method":"GET","path":"/pets"})");
    stamped_request ("req_5", "col_a", R"({"operationId":"half"})");

    db.delete_request ("req_1", "col_a");
    db.delete_request ("req_2", "col_a");
    db.delete_request ("req_3", "col_a");
    db.delete_request ("req_4", "col_b");
    db.delete_request ("req_5", "col_a");

    const auto under_a = db.get_declined_operations ("col_a");
    ASSERT_EQ (under_a.size (), 2u) << "half an identity identifies nothing";
    EXPECT_EQ (under_a[0].request_id, "req_2")
    << "the later delete took the row over";
    EXPECT_EQ (under_a[0].operation_id, "listPets");
    EXPECT_EQ (under_a[1].request_id, "req_3");
    EXPECT_EQ (under_a[1].operation_id, "");
    ASSERT_EQ (db.get_declined_operations ("col_b").size (), 1u);
    EXPECT_EQ (db.get_declined_operations ("col_b")[0].request_id, "req_4");
}

} // namespace

} // namespace vayu::db
