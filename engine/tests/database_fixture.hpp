#pragma once

/**
 * @file database_fixture.hpp
 * @brief The `DatabaseTest` fixture and the helpers shared by more than one
 *        `db_*_test.cpp`.
 *
 * The suite is split by subject across those files and keeps one name, so
 * `--gtest_filter=DatabaseTest.*`, the scratch-database RESOURCE_LOCK list and the ctest
 * regexes see it whole. The class is defined here, once, in a named namespace, so each
 * translation unit sees the same type; gtest refuses a suite whose `TEST_F`s name different
 * fixture classes, which an anonymous namespace per file would be.
 */

#include <gtest/gtest.h>
#include <sqlite3.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <system_error>
#include <vector>

#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"

namespace vayu::db {

// Defined in src/db/db_maintenance.cpp and declared in the internal
// `database_impl.hpp`, which `db_layout_test.cpp` keeps out of tests; the
// `on_connection` seam is the reason this one is called directly.
enum class PreMigrationSnapshot : std::uint8_t { Take, Skip };
bool migrate_before_sync (const std::string& path,
std::chrono::milliseconds busy_timeout,
PreMigrationSnapshot snapshot,
const std::function<void (sqlite3*)>& on_connection);

inline constexpr const char* TEST_DB_PATH = "test_vayu.db";

class DatabaseTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (TEST_DB_PATH);
    }

    void TearDown () override {
        vayu::tests::remove_database_files (TEST_DB_PATH);
    }
};

// A terminal run with an explicit id/start_time, plus one metric tick and one
// result so prune's cascade delete is observable. A load run unless asked
// otherwise: `max_runs`, the cap most cases here exercise, counts load and
// collection runs and leaves design Sends to their own cap (#2429).
inline void seed_run_with_children (Database& db,
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

inline int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/// A run row of @p type left at @p status, with no summary.
inline void seed_orphan (Database& db,
const std::string& id,
vayu::RunStatus status,
vayu::RunType type = vayu::RunType::Load) {
    vayu::db::Run run;
    run.id              = id;
    run.type            = type;
    run.status          = status;
    run.start_time      = now_ms ();
    run.config_snapshot = "{}";
    db.create_run (run);
}

/// One tick as the 1 Hz writer stores it, @p completed responses after
/// @p elapsed seconds. Every windowed figure is set far from the cumulative
/// one beside it, so a summary that read the window shows.
inline void add_tick (Database& db, const std::string& run_id, size_t completed, double elapsed) {
    vayu::core::MetricTickSample sample;
    sample.elapsed_seconds      = elapsed;
    sample.requests_completed   = completed;
    sample.requests_failed      = 2;
    sample.cancelled            = 1;
    sample.current_rps          = 999.0;
    sample.current_send_rate    = 998.0;
    sample.window_avg_in_flight = 7.0;
    sample.current_concurrency  = 9;
    sample.send_rate        = (static_cast<double> (completed) / elapsed) + 1.0;
    sample.throughput       = static_cast<double> (completed) / elapsed;
    sample.dropped_requests = 4;
    sample.skipped_requests = 3;
    sample.stalled_ms       = 300.0;
    sample.bytes_sent       = completed * 100;
    sample.bytes_received   = completed * 1000;
    sample.status_codes     = { { 200, completed - 2 }, { 503, 2 } };
    sample.latency_samples  = 5;
    sample.latency_p50_ms   = 11.0;
    sample.latency_p95_ms   = 22.0;
    sample.latency_p99_ms   = 33.0;

    vayu::db::MetricTick tick;
    tick.run_id    = run_id;
    tick.timestamp = now_ms ();
    tick.payload   = vayu::core::build_metric_tick_payload (sample).dump ();
    db.add_metric_tick (tick);
}

inline constexpr const char* MISSED_BUDGET_SUMMARY = R"({"rps":5,"status_codes":{"200":10},
"thresholds":{"checks":[{"metric":"latencyP99Ms","passed":false}],"passed":0,"failed":1}})";
inline constexpr const char* MET_BUDGET_SUMMARY = R"({"rps":5,"status_codes":{"200":10},
"thresholds":{"checks":[{"metric":"latencyP99Ms","passed":true}],"passed":1,"failed":0}})";
inline constexpr const char* NO_BUDGET_SUMMARY = R"({"rps":5,"status_codes":{"200":10}})";

/// A run of @p type left at Running, as both route inserts leave one.
inline void seed_running_run (Database& db,
const std::string& id,
int64_t start_time,
vayu::RunType type = vayu::RunType::Load) {
    vayu::db::Run run;
    run.id              = id;
    run.type            = type;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = start_time;
    run.config_snapshot = "{}";
    db.create_run (run);
}

/// A worker's ending: the summary while the row is still Running, then the
/// final status (`run_manager.cpp`, `scenario_runner.cpp`).
inline void
finish_run (Database& db, const std::string& id, const char* summary, vayu::RunStatus to) {
    db.update_run_summary (id, summary);
    db.transition_run_status (id, { vayu::RunStatus::Running }, to);
}

inline std::optional<std::string> stored_outcome (Database& db, const std::string& id) {
    const auto run = db.get_run (id);
    if (!run) {
        ADD_FAILURE () << "run vanished: " << id;
        return std::nullopt;
    }
    return run->outcome;
}

/// Reopens @p path with sqlite3 directly and adds back the two pre-cutover
/// script columns (already dropped from the current schema) - the shape a
/// database written before this issue's engine looks like.
inline void add_legacy_script_columns (const std::string& path) {
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
inline void drop_elements_column (const std::string& path) {
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
inline void add_single_legacy_script_column (const std::string& path, const char* column) {
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

inline void set_legacy_scripts (const std::string& path,
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

inline bool table_has_column (const std::string& path, const char* table, const char* column) {
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

inline int64_t read_user_version (const std::string& path) {
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

inline void set_user_version (const std::string& path, int64_t version) {
    sqlite3* handle = nullptr;
    ASSERT_EQ (sqlite3_open (path.c_str (), &handle), SQLITE_OK);
    const std::string sql = "PRAGMA user_version = " + std::to_string (version);
    ASSERT_EQ (sqlite3_exec (handle, sql.c_str (), nullptr, nullptr, nullptr), SQLITE_OK);
    sqlite3_close (handle);
}

/// The copies a start took before migrating `TEST_DB_PATH`
/// (`backups/vayu-<stamp>-pre-v<N>.db`), oldest first.
inline std::vector<std::string> pre_migration_snapshots () {
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

/// A version-0 workspace the way an engine older than #1514 left it: the
/// legacy script columns back on both tables and a script on `req_1`.
inline void seed_unmigrated_script_row () {
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
inline std::string read_legacy_pre_script () {
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

/// One column of one row, read raw: no reader in `Database` filters it.
inline std::string read_stored (const std::string& path,
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

} // namespace vayu::db
