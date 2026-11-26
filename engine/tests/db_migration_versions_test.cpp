/**
 * @file tests/db_migration_versions_test.cpp
 * @brief Database migrations by schema version: the file-trust step and the later version upgrades.
 *
 * The `DatabaseTest` fixture is in `database_fixture.hpp`.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <initializer_list>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "database_fixture.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/file_ref.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::db {

namespace {

// ---------------------------------------------------------------------------
// The file-trust step: stored bodies lose `unresolved` and the files a person
// chose become grants (version 6), and the allowed folders the root rule
// refuses are gone (version 4).
// ---------------------------------------------------------------------------

namespace {

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
    EXPECT_EQ (vayu::db::SCHEMA_VERSION, 11);
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "runs", "origin"));
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "runs", "origin_client"));
    const auto legacy = db.get_run ("legacy");
    ASSERT_HAS_VALUE (legacy)
    << "a run stored before the columns did not survive";
    EXPECT_EQ (legacy->origin, "other");
    EXPECT_FALSE (legacy->origin_client.has_value ());
}

// Version 11 adds the nullable `runs.outcome` and backfills nothing: a run
// stored before the column reads as having no verdict, a finished one
// included. Mutation checks: leave `SCHEMA_VERSION` at 10 and the stamp
// assertion fails; give the column a `default_value` and the stored run reads
// one.
TEST_F (DatabaseTest, AVersionTenDatabaseGainsTheRunOutcomeColumnAndReadsNoVerdict) {
    const int64_t recent = now_ms ();
    {
        Database db (TEST_DB_PATH);
        db.init ();
        seed_running_run (db, "legacy", recent);
        finish_run (db, "legacy", MISSED_BUDGET_SUMMARY, vayu::RunStatus::Completed);
    }
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        char* err = nullptr;
        ASSERT_EQ (sqlite3_exec (handle, "ALTER TABLE runs DROP COLUMN outcome",
                   nullptr, nullptr, &err),
        SQLITE_OK)
        << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
        sqlite3_close (handle);
    }
    ASSERT_FALSE (table_has_column (TEST_DB_PATH, "runs", "outcome"))
    << "test setup did not remove the column";
    set_user_version (TEST_DB_PATH, 10);

    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_EQ (vayu::db::SCHEMA_VERSION, 11);
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "runs", "outcome"));
    const auto legacy = db.get_run ("legacy");
    ASSERT_HAS_VALUE (legacy)
    << "a run stored before the column did not survive";
    EXPECT_EQ (legacy->status, vayu::RunStatus::Completed);
    EXPECT_FALSE (legacy->outcome.has_value ()) << "no backfill";
}

// The two `stream_text_path` columns (#3773) joined version 11. A database
// stamped 10 and one an earlier build of 11 stamped have neither;
// `sync_schema ()` adds both, a stored request and a stored sample keep their
// rows and read no path, and a path written afterwards round-trips. Mutation
// check: unmap `requests.stream_text_path` in `make_vayu_storage` and the
// column assertion and the round trip fail.
TEST_F (DatabaseTest, ADatabaseWithoutTheStreamTextPathColumnsGainsThemAndReadsNone) {
    for (const int stamped : { 10, 11 }) {
        SCOPED_TRACE ("stamped " + std::to_string (stamped));
        vayu::tests::remove_database_files (TEST_DB_PATH);
        {
            Database db (TEST_DB_PATH);
            db.init ();
            Collection col;
            col.id   = "col_1";
            col.name = "C";
            db.create_collection (col);
            Request r;
            r.id            = "req_legacy";
            r.collection_id = "col_1";
            r.name          = "Legacy";
            r.url           = "https://example.test/";
            r.stream        = true;
            db.save_request (r);
            seed_running_run (db, "run_legacy", now_ms ());
            Result result;
            result.run_id     = "run_legacy";
            result.trace_data = "{}";
            PendingResultBody body;
            body.headers       = "{}";
            body.stream_events = 2;
            db.add_results_batch ({ result }, { body });
        }
        {
            sqlite3* handle = nullptr;
            ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
            for (const char* sql :
            { "ALTER TABLE requests DROP COLUMN stream_text_path",
            "ALTER TABLE result_bodies DROP COLUMN stream_text_path" }) {
                char* err = nullptr;
                ASSERT_EQ (sqlite3_exec (handle, sql, nullptr, nullptr, &err), SQLITE_OK)
                << (err != nullptr ? err : "(no message)");
                sqlite3_free (err);
            }
            sqlite3_close (handle);
        }
        ASSERT_FALSE (table_has_column (TEST_DB_PATH, "requests", "stream_text_path"))
        << "test setup did not remove the column";
        set_user_version (TEST_DB_PATH, stamped);

        Database db (TEST_DB_PATH);
        db.init ();
        EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
        EXPECT_TRUE (table_has_column (TEST_DB_PATH, "requests", "stream_text_path"));
        EXPECT_TRUE (table_has_column (TEST_DB_PATH, "result_bodies", "stream_text_path"));

        auto legacy = db.get_request ("req_legacy");
        ASSERT_HAS_VALUE (legacy)
        << "a request stored before the column did not survive";
        EXPECT_TRUE (legacy->stream);
        EXPECT_FALSE (legacy->stream_text_path.has_value ()) << "no backfill";
        const auto samples = db.get_result_bodies_paginated ("run_legacy", 10, 0);
        ASSERT_EQ (samples.size (), 1u)
        << "a sample stored before the column did not survive";
        EXPECT_FALSE (samples[0].stream_text_path.has_value ());

        legacy->stream_text_path = "$.delta.text";
        db.save_request (*legacy);
        const auto reread = db.get_request ("req_legacy");
        ASSERT_HAS_VALUE (reread);
        EXPECT_EQ (reread->stream_text_path.value_or (""), "$.delta.text");
    }
}

// `requests.stream_first_content_marker` (#3774) joined version 11 too, under
// the same rule. Mutation check: unmap it in `make_vayu_storage` and the
// setup finds no column to drop.
TEST_F (DatabaseTest, ADatabaseWithoutTheFirstContentMarkerColumnGainsItAndReadsNone) {
    for (const int stamped : { 10, 11 }) {
        SCOPED_TRACE ("stamped " + std::to_string (stamped));
        vayu::tests::remove_database_files (TEST_DB_PATH);
        {
            Database db (TEST_DB_PATH);
            db.init ();
            Collection col;
            col.id   = "col_1";
            col.name = "C";
            db.create_collection (col);
            Request r;
            r.id            = "req_legacy";
            r.collection_id = "col_1";
            r.name          = "Legacy";
            r.url           = "https://example.test/";
            r.stream        = true;
            db.save_request (r);
        }
        {
            sqlite3* handle = nullptr;
            ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
            char* err = nullptr;
            ASSERT_EQ (sqlite3_exec (handle, "ALTER TABLE requests DROP COLUMN stream_first_content_marker",
                       nullptr, nullptr, &err),
            SQLITE_OK)
            << (err != nullptr ? err : "(no message)");
            sqlite3_free (err);
            sqlite3_close (handle);
        }
        ASSERT_FALSE (table_has_column (TEST_DB_PATH, "requests", "stream_first_content_marker"))
        << "test setup did not remove the column";
        set_user_version (TEST_DB_PATH, stamped);

        Database db (TEST_DB_PATH);
        db.init ();
        EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
        EXPECT_TRUE (table_has_column (TEST_DB_PATH, "requests", "stream_first_content_marker"));

        auto legacy = db.get_request ("req_legacy");
        ASSERT_HAS_VALUE (legacy)
        << "a request stored before the column did not survive";
        EXPECT_TRUE (legacy->stream);
        EXPECT_FALSE (legacy->stream_first_content_marker.has_value ())
        << "no backfill";

        legacy->stream_first_content_marker = "content_block_delta";
        db.save_request (*legacy);
        const auto reread = db.get_request ("req_legacy");
        ASSERT_HAS_VALUE (reread);
        EXPECT_EQ (reread->stream_first_content_marker.value_or (""), "content_block_delta");
    }
}

// A captured sample's `stream_text_path` is written with its row, beside its
// event count.
TEST_F (DatabaseTest, AResultBodyKeepsItsStreamTextPath) {
    Database db (TEST_DB_PATH);
    db.init ();
    seed_running_run (db, "run_1", now_ms ());
    Result result;
    result.run_id     = "run_1";
    result.trace_data = "{}";
    PendingResultBody body;
    body.headers          = "{}";
    body.stream_events    = 3;
    body.stream_text_path = "$.choices[0].delta.content";
    db.add_results_batch ({ result }, { body });

    const auto rows = db.get_result_bodies_paginated ("run_1", 10, 0);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_EQ (rows[0].stream_text_path.value_or (""), "$.choices[0].delta.content");
    EXPECT_EQ (rows[0].stream_events.value_or (0), 3);
}

// Version 8 added `collections.spec_file` / `data_file` (#2765). A version-7
// database has neither; `sync_schema ()` adds both, a stored collection keeps
// its row and reads back bound to no file, and the migration only stamps.
// Mutation check: drop the `default_value` from `spec_file` in
// `make_vayu_storage` and the collection does not survive the columns' return.
TEST_F (DatabaseTest, AVersionSevenDatabaseGainsTheCollectionFileBindingColumns) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        Collection col;
        col.id    = "col_legacy";
        col.name  = "Legacy";
        col.order = 0;
        db.create_collection (col);
    }
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        for (const char* column : { "spec_file", "data_file" }) {
            const std::string sql =
            std::string ("ALTER TABLE collections DROP COLUMN ") + column;
            char* err = nullptr;
            ASSERT_EQ (sqlite3_exec (handle, sql.c_str (), nullptr, nullptr, &err), SQLITE_OK)
            << (err != nullptr ? err : "(no message)");
            sqlite3_free (err);
        }
        sqlite3_close (handle);
    }
    ASSERT_FALSE (table_has_column (TEST_DB_PATH, "collections", "spec_file"))
    << "test setup did not remove the column";
    ASSERT_FALSE (table_has_column (TEST_DB_PATH, "collections", "data_file"))
    << "test setup did not remove the column";
    set_user_version (TEST_DB_PATH, 7);

    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "collections", "spec_file"));
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "collections", "data_file"));
    const auto legacy = db.get_collection ("col_legacy");
    ASSERT_HAS_VALUE (legacy)
    << "a collection stored before the columns did not survive";
    EXPECT_EQ (legacy->name, "Legacy");
    EXPECT_EQ (legacy->spec_file, "{}");
    EXPECT_EQ (legacy->data_file, "{}");
}

// Version 9 added `requests.timeout_ms` (#2937). A version-8 database has no
// such column; `sync_schema ()` adds it, a stored request keeps its row and
// reads back with no timeout of its own, and the migration only stamps.
TEST_F (DatabaseTest, AVersionEightDatabaseGainsTheRequestTimeoutColumn) {
    {
        Database db (TEST_DB_PATH);
        db.init ();
        Collection col;
        col.id    = "col_legacy";
        col.name  = "Legacy";
        col.order = 0;
        db.create_collection (col);
        Request r;
        r.id            = "req_legacy";
        r.collection_id = "col_legacy";
        r.name          = "Legacy";
        r.url           = "https://example.test";
        r.timeout_ms    = 2500;
        db.save_request (r);
    }
    {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (TEST_DB_PATH, &handle), SQLITE_OK);
        char* err = nullptr;
        ASSERT_EQ (sqlite3_exec (handle, "ALTER TABLE requests DROP COLUMN timeout_ms",
                   nullptr, nullptr, &err),
        SQLITE_OK)
        << (err != nullptr ? err : "(no message)");
        sqlite3_free (err);
        sqlite3_close (handle);
    }
    ASSERT_FALSE (table_has_column (TEST_DB_PATH, "requests", "timeout_ms"))
    << "test setup did not remove the column";
    set_user_version (TEST_DB_PATH, 8);

    Database db (TEST_DB_PATH);
    db.init ();
    EXPECT_EQ (read_user_version (TEST_DB_PATH), vayu::db::SCHEMA_VERSION);
    EXPECT_TRUE (table_has_column (TEST_DB_PATH, "requests", "timeout_ms"));
    const auto legacy = db.get_request ("req_legacy");
    ASSERT_HAS_VALUE (legacy)
    << "a request stored before the column did not survive";
    EXPECT_EQ (legacy->name, "Legacy");
    EXPECT_FALSE (legacy->timeout_ms.has_value ());
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

} // namespace

} // namespace vayu::db
