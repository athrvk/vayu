/**
 * @file tests/db_migration_repair_test.cpp
 * @brief Database migrations: sibling order, the empty collection parent repair, the elements column
 * and the copy taken before a migration.
 *
 * The `DatabaseTest` fixture is in `database_fixture.hpp`.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

#include "database_fixture.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"

namespace vayu::db {

namespace {

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

namespace {

/// How many collections of the file at @p path match @p where, read through
/// a connection of its own so no `Database` mapping reinterprets the column.
int64_t count_collections (const std::string& path, const std::string& where) {
    sqlite3* handle = nullptr;
    if (sqlite3_open (path.c_str (), &handle) != SQLITE_OK) {
        ADD_FAILURE () << "cannot open " << path;
        sqlite3_close (handle);
        return -1;
    }
    const std::string sql = "SELECT COUNT (*) FROM collections WHERE " + where;
    sqlite3_stmt* stmt    = nullptr;
    int64_t count         = -1;
    if (sqlite3_prepare_v2 (handle, sql.c_str (), -1, &stmt, nullptr) == SQLITE_OK &&
    sqlite3_step (stmt) == SQLITE_ROW) {
        count = sqlite3_column_int64 (stmt, 0);
    } else {
        ADD_FAILURE () << sql << ": " << sqlite3_errmsg (handle);
    }
    sqlite3_finalize (stmt);
    sqlite3_close (handle);
    return count;
}

/// The copies a repair pass took before rewriting `TEST_DB_PATH`
/// (`backups/vayu-<stamp>-pre-repair.db`).
size_t pre_repair_snapshot_count () {
    namespace fs = std::filesystem;
    size_t found = 0;
    std::error_code ec;
    const fs::path backups = fs::path (TEST_DB_PATH).parent_path () / "backups";
    for (fs::directory_iterator it (backups, ec), end; !ec && it != end; it.increment (ec)) {
        if (it->path ().filename ().string ().ends_with ("-pre-repair.db")) {
            ++found;
        }
    }
    return found;
}

/// A root, and two collections stored with `parent_id = ''` as engines before
/// #3451 wrote them, one of them trashed.
void seed_empty_parent_workspace () {
    Database db (TEST_DB_PATH);
    db.init ();
    for (const char* id : { "col_root", "col_empty", "col_empty_trashed" }) {
        Collection col;
        col.id   = id;
        col.name = id;
        if (std::string_view (id) != "col_root") {
            col.parent_id = "";
        }
        db.create_collection (col);
    }
    db.delete_collection ("col_empty_trashed");
}

} // namespace

// `''` was a second spelling of the root (#3451): a start rewrites every such
// row to NULL, trashed ones too, so a delete and restore of one comes back in
// place instead of re-parented as if its parent were gone. Mutation check:
// drop the `clear_empty_parent_ids` call from `init` and the rows keep `''`
// and the restore answers `reparented`.
TEST_F (DatabaseTest, AStartStoresAnEmptyCollectionParentAsTheRoot) {
    seed_empty_parent_workspace ();
    ASSERT_EQ (count_collections (TEST_DB_PATH, "parent_id = ''"), 2);

    Database db (TEST_DB_PATH);
    db.init ();

    EXPECT_EQ (count_collections (TEST_DB_PATH, "parent_id = ''"), 0);
    EXPECT_EQ (count_collections (TEST_DB_PATH, "parent_id IS NULL"), 3);
    EXPECT_EQ (pre_repair_snapshot_count (), 1u)
    << "no copy was saved before the rewrite";

    const auto restored = db.restore_deleted ("col_empty_trashed");
    ASSERT_HAS_VALUE (restored);
    EXPECT_FALSE (restored->reparented) << "a root restores in place";
    const auto row = db.get_collection ("col_empty_trashed");
    ASSERT_HAS_VALUE (row);
    EXPECT_FALSE (row->parent_id.has_value ());
    EXPECT_FALSE (row->deleted_at.has_value ());

    EXPECT_EQ (db.clear_empty_parent_ids (), 0)
    << "a second pass finds nothing";
    EXPECT_EQ (pre_repair_snapshot_count (), 1u) << "and copies nothing";
}

// With no copy the pass rewrites nothing, and the next call does the work.
// Mutation check: ignore what `snapshot_before_rewrite` answers in
// `clear_empty_parent_ids` and the row is rewritten without a copy.
TEST_F (DatabaseTest, WithNoCopyTheEmptyParentRepairRewritesNothing) {
    Database db (TEST_DB_PATH);
    db.init ();
    Collection col;
    col.id        = "col_empty";
    col.name      = "Empty";
    col.parent_id = "";
    db.create_collection (col);

    // A file where the folder goes, so the folder cannot be created.
    const std::string backups = db.backups_directory ();
    std::ofstream (backups) << "not a directory";

    EXPECT_THROW (db.clear_empty_parent_ids (), std::runtime_error);
    EXPECT_EQ (count_collections (TEST_DB_PATH, "parent_id = ''"), 1);

    std::filesystem::remove (backups);
    EXPECT_EQ (db.clear_empty_parent_ids (), 1);
    EXPECT_EQ (count_collections (TEST_DB_PATH, "parent_id = ''"), 0);
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
