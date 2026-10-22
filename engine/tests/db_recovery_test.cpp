/**
 * @file tests/db_recovery_test.cpp
 * @brief The startup recovery marker and the `/health` node that reports it
 *        (issue #922), and what recovery now does to the files (issue #984).
 *
 * The behaviour under test is a claim about the user's data: a database that
 * could not be opened and could not be restored is emptied out from under them,
 * and before this the whole record of that was two lines in the engine log. So
 * the cases here are the two a reader has to be able to tell apart - a startup
 * that wiped the database, and a genuine first run, which produces an empty
 * database too.
 *
 * Since #984 the file itself survives that: the corrupt database is moved to a
 * `.corrupt-<ms>` set rather than deleted, because `sqlite3 .recover` can pull
 * most rows out of a damaged file and only while the file exists - and a `.bak`
 * is validated by the same probe the main file gets before it is restored over
 * anything, because "we assume the backup itself is valid" was how a torn copy
 * came to be written over the last good one.
 *
 * Since #2420 only a corrupt file takes that branch: one the probe could not
 * examine (locked, disk full, read-only) refuses to start and is left alone.
 */

#include <gtest/gtest.h>

#include <sqlite3.h>

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/db/recovery.hpp"

namespace vayu::http::routes {
// Declared in health.cpp; the body of GET /health.
nlohmann::json build_health_response (vayu::db::Database& db);
} // namespace vayu::http::routes

namespace {

using vayu::db::RecoveryOutcome;

class DbRecoveryTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_db_recovery.db";

    void SetUp () override {
        cleanup ();
    }
    void TearDown () override {
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// Leave bytes at @p path that SQLite cannot open as a database.
    ///
    /// @p marker distinguishes one corrupt file from another, so a test can
    /// prove *which* corrupt bytes were moved aside or left alone rather than
    /// only that something of the right size is there.
    static void write_corrupt_file (const std::string& path, const std::string& marker = "") {
        std::ofstream out (path, std::ios::binary | std::ios::trunc);
        // A valid SQLite file starts with "SQLite format 3\0"; this is long
        // enough to be read as a header and wrong in every byte of it.
        out << "this is not a database, it is a text file pretending to be one" << marker;
    }

    static void write_corrupt_database (const std::string& marker = "") {
        write_corrupt_file (DB_PATH, marker);
    }

    /// The whole of @p path as bytes, empty when it could not be read - which
    /// is what an assertion for "these are the corrupt bytes" fails against.
    ///
    /// Through `rdbuf ()` rather than a pair of `istreambuf_iterator`s, which
    /// is the same choice `source_scan.hpp` and `http/transport_policy.cpp`
    /// made: at `-O2` GCC 13 inlines the iterator's `sbumpc` far enough to lose
    /// sight of the buffer being non-null and reports `gptr ()` as a potential
    /// null dereference, which the prod presets' `-Werror` makes a build
    /// failure. `VAYU_IGNORE_FALSE_NULL_DEREFERENCE` exists for the places that
    /// need the iterator form; this one does not.
    static std::string read_file (const std::string& path) {
        std::ifstream in (path, std::ios::binary);
        std::ostringstream buffer;
        buffer << in.rdbuf ();
        return buffer.str ();
    }

    /// The one quarantined set this database has, or "" when it has none.
    static std::string only_quarantined_path () {
        const auto paths = vayu::db::quarantined_database_paths (DB_PATH);
        return paths.size () == 1 ? paths.front () : "";
    }

    static nlohmann::json read_marker () {
        std::ifstream in (vayu::db::recovery_marker_path (DB_PATH), std::ios::binary);
        return nlohmann::json::parse (in, nullptr, false);
    }

    /// The recorded outcome, or `nullopt` when there is no record.
    ///
    /// A helper rather than `->` at each assertion site: gtest's `ASSERT_TRUE`
    /// is not a guard bugprone-unchecked-optional-access can follow, so every
    /// dereference behind one reads as unchecked. A plain conditional is.
    static std::optional<RecoveryOutcome> recorded_outcome (const vayu::db::Database& db) {
        const auto& record = db.recovery ();
        return record ? std::optional<RecoveryOutcome> (record->outcome) : std::nullopt;
    }

    /// The recorded timestamp, or 0 when there is no record - which is also
    /// what an assertion for "a real timestamp" fails against.
    static int64_t recorded_at (const vayu::db::Database& db) {
        const auto& record = db.recovery ();
        return record ? record->at : 0;
    }
};

TEST_F (DbRecoveryTest, CleanStartWritesNoMarkerAndReportsNoRecovery) {
    auto db = std::make_unique<vayu::db::Database> (DB_PATH);

    EXPECT_FALSE (db->recovery ().has_value ());
    EXPECT_FALSE (std::filesystem::exists (vayu::db::recovery_marker_path (DB_PATH)));

    const auto health = vayu::http::routes::build_health_response (*db);
    EXPECT_EQ (health["status"], "ok");
    // Absent, not null - a first run must be distinguishable from a wipe by the
    // presence of the key alone, which is what the app's notice tests.
    EXPECT_FALSE (health.contains ("recovery"));
}

TEST_F (DbRecoveryTest, ACorruptDatabaseWithNoBackupIsQuarantinedRatherThanDeleted) {
    // The salvage case: the user's only copy of their data failed to open, and
    // `sqlite3 .recover` can usually still read most of it - so the bytes have
    // to still be somewhere. They were deleted here until #984.
    write_corrupt_database ("-original");
    const std::string corrupt_bytes = read_file (DB_PATH);
    ASSERT_FALSE (std::filesystem::exists (std::string (DB_PATH) + ".bak"));

    auto db = std::make_unique<vayu::db::Database> (DB_PATH);

    ASSERT_HAS_VALUE (db->recovery ());
    EXPECT_TRUE (recorded_outcome (*db) == RecoveryOutcome::StartedFreshQuarantined);
    EXPECT_GT (recorded_at (*db), 0);

    const std::string quarantined = only_quarantined_path ();
    ASSERT_FALSE (quarantined.empty ())
    << "the corrupt database was not moved aside";
    EXPECT_EQ (read_file (quarantined), corrupt_bytes)
    << "the quarantined copy is not the bytes that failed to open";

    const auto& record = db->recovery ();
    ASSERT_HAS_VALUE (record);
    ASSERT_HAS_VALUE (record->quarantined_path);
    EXPECT_EQ (*record->quarantined_path, quarantined);

    const auto marker = read_marker ();
    ASSERT_TRUE (marker.is_object ());
    EXPECT_EQ (marker["outcome"], "started_fresh_quarantined");
    EXPECT_EQ (marker["quarantinedPath"], quarantined);
}

TEST_F (DbRecoveryTest, TheQuarantinedSetTakesTheWalAndShmWithIt) {
    // A `-wal` holds committed transactions the main file does not, so a
    // salvage attempt that got the main file alone would be missing exactly the
    // most recent work the user is trying to get back.
    write_corrupt_database ();
    write_corrupt_file (std::string (DB_PATH) + "-wal", "-wal-bytes");
    write_corrupt_file (std::string (DB_PATH) + "-shm", "-shm-bytes");

    {
        vayu::db::Database db (DB_PATH);
    }

    const std::string quarantined = only_quarantined_path ();
    ASSERT_FALSE (quarantined.empty ());
    EXPECT_TRUE (read_file (quarantined + "-wal").ends_with ("-wal-bytes"));
    EXPECT_TRUE (read_file (quarantined + "-shm").ends_with ("-shm-bytes"));
}

TEST_F (DbRecoveryTest, HealthReportsTheOutcomeWithBothPaths) {
    write_corrupt_database ();
    auto db = std::make_unique<vayu::db::Database> (DB_PATH);

    const auto health = vayu::http::routes::build_health_response (*db);
    ASSERT_TRUE (health.contains ("recovery"));
    EXPECT_EQ (health["recovery"]["outcome"], "started_fresh_quarantined");
    EXPECT_EQ (health["recovery"]["databasePath"], db->path ());
    EXPECT_GT (health["recovery"]["at"].get<int64_t> (), 0);
    // The path is the whole of what the user can act on: the notice names it
    // and they go and salvage it. Derived from the outcome string it would be a
    // guess, so the engine sends it.
    EXPECT_EQ (health["recovery"]["quarantinedPath"], only_quarantined_path ());
}

TEST_F (DbRecoveryTest, RestoringFromABackupIsADifferentOutcome) {
    // A good database with its `.bak` refreshed, as a daemon start leaves it.
    {
        vayu::db::Database seed (DB_PATH);
        ASSERT_HAS_VALUE (seed.refresh_recovery_backup ());
    }
    ASSERT_TRUE (std::filesystem::exists (std::string (DB_PATH) + ".bak"));

    write_corrupt_database ("-original");
    const std::string corrupt_bytes = read_file (DB_PATH);
    auto db = std::make_unique<vayu::db::Database> (DB_PATH);

    ASSERT_HAS_VALUE (db->recovery ());
    EXPECT_TRUE (recorded_outcome (*db) == RecoveryOutcome::RestoredFromBackup);
    EXPECT_EQ (
    vayu::http::routes::build_health_response (*db)["recovery"]["outcome"],
    "restored_from_backup");
    // Restoring overwrote the corrupt file, so this branch quarantines too -
    // the backup is by definition older than what it replaces, and the rows
    // written since it was taken exist only in the file being replaced.
    const std::string quarantined = only_quarantined_path ();
    ASSERT_FALSE (quarantined.empty ());
    EXPECT_EQ (read_file (quarantined), corrupt_bytes);
}

TEST_F (DbRecoveryTest, ACorruptBackupIsNeitherRestoredNorDestroyed) {
    // The failure this issue exists for: the backup was restored on the
    // strength of its existence alone. A torn one then replaced the only other
    // copy of the user's data, and the engine had thrown that copy away first.
    write_corrupt_file (std::string (DB_PATH) + ".bak", "-backup");
    const std::string backup_bytes = read_file (std::string (DB_PATH) + ".bak");
    write_corrupt_database ("-original");
    const std::string corrupt_bytes = read_file (DB_PATH);

    auto db = std::make_unique<vayu::db::Database> (DB_PATH);

    ASSERT_HAS_VALUE (db->recovery ());
    EXPECT_TRUE (recorded_outcome (*db) == RecoveryOutcome::BackupAlsoCorrupt);
    EXPECT_EQ (read_file (std::string (DB_PATH) + ".bak"), backup_bytes)
    << "the unusable backup was modified rather than left as evidence";

    const std::string quarantined = only_quarantined_path ();
    ASSERT_FALSE (quarantined.empty ());
    EXPECT_EQ (read_file (quarantined), corrupt_bytes);

    // And the engine came up on a working database rather than on the corrupt
    // backup's bytes - which is what "restore an unvalidated backup" produced.
    EXPECT_TRUE (db->get_collections ().empty ());
}

TEST_F (DbRecoveryTest, QuarantinedSetsAreKeptToTwo) {
    // These are full-size copies of a database, written unattended into the
    // user's data directory, so the evidence is bounded: the corruption they
    // are looking at, and the one before it that says this has happened
    // before.
    std::vector<std::string> quarantined_bytes;
    for (int round = 1; round <= 4; ++round) {
        const std::string marker = "-round-" + std::to_string (round);
        write_corrupt_database (marker);
        quarantined_bytes.push_back (read_file (DB_PATH));
        {
            vayu::db::Database db (DB_PATH);
        }
        // Each round is the no-backup path. Nothing here refreshes one, but a
        // `.bak` left by anything else would turn a round into a restore.
        std::filesystem::remove (std::string (DB_PATH) + ".bak");

        const auto sets = vayu::db::quarantined_database_paths (DB_PATH);
        EXPECT_LE (sets.size (), vayu::db::QUARANTINE_SETS_KEPT)
        << "after round " << round;
    }

    const auto sets = vayu::db::quarantined_database_paths (DB_PATH);
    ASSERT_EQ (sets.size (), 2U);
    // Newest first, and it is the *newest* two that survive - keeping the two
    // oldest would drop the corruption the user is currently looking at.
    EXPECT_EQ (read_file (sets[0]), quarantined_bytes[3]);
    EXPECT_EQ (read_file (sets[1]), quarantined_bytes[2]);
}

TEST_F (DbRecoveryTest, TheRecordOutlivesTheEngineRunThatWroteIt) {
    // The reason the fact is a file rather than a member: the engine can be
    // restarted - or can crash - before any client has polled `/health`, and a
    // record that only lived in the recovering process would be lost exactly
    // then. The second start below is a clean one and must still report it.
    write_corrupt_database ();
    {
        vayu::db::Database first (DB_PATH);
    }

    vayu::db::Database second (DB_PATH);
    ASSERT_HAS_VALUE (second.recovery ());
    EXPECT_TRUE (recorded_outcome (second) == RecoveryOutcome::StartedFreshQuarantined);
}

TEST_F (DbRecoveryTest, TheScratchCleanupTakesTheMarkerWithIt) {
    // The marker is a seventh file beside a scratch database, and a leaked one
    // is read by the *next* `Database` opened at this path - so an unrelated
    // fixture would inherit a recovery record nothing in it provoked.
    // `ScratchDatabaseCleanup` in db_test.cpp cannot catch this: it opens a
    // clean database, which by design writes no marker at all.
    write_corrupt_database ();
    {
        vayu::db::Database db (DB_PATH);
    }
    ASSERT_TRUE (std::filesystem::exists (vayu::db::recovery_marker_path (DB_PATH)))
    << "no marker was written, so this run would not catch a missed cleanup";

    vayu::tests::remove_database_files (DB_PATH);
    EXPECT_FALSE (std::filesystem::exists (vayu::db::recovery_marker_path (DB_PATH)));
}

TEST_F (DbRecoveryTest, AnUnreadableMarkerIsNoRecordRatherThanAPartialOne) {
    // Half a claim about the user's data is worse than none: every field the
    // app renders comes off this file, so a document missing one, carrying a
    // spelling this build does not know, or not being JSON at all reads as "no
    // record".
    for (const char* bytes : { "not json at all", R"({"outcome":"deleted_corrupt"})",
         R"({"at":123})", R"({"outcome":"reformatted_the_disk","at":123})", R"(["deleted_corrupt",123])",
         // The quarantine path is optional, but a key carrying something that
         // is not a path is the same half-parsed document as the rest: the app
         // renders it as somewhere to go and look.
         R"({"outcome":"deleted_corrupt","at":123,"quarantinedPath":7})" }) {
        std::ofstream out (vayu::db::recovery_marker_path (DB_PATH),
        std::ios::binary | std::ios::trunc);
        out << bytes;
        out.close ();

        EXPECT_FALSE (vayu::db::read_recovery_marker (DB_PATH).has_value ())
        << "accepted: " << bytes;
    }
}

TEST_F (DbRecoveryTest, OutcomeSpellingsRoundTrip) {
    // The stored spelling is the wire value `/health` reports, so the two
    // directions have to agree for every outcome rather than only for the one
    // the recovery branch happens to write.
    for (const auto outcome : { RecoveryOutcome::RestoredFromBackup,
         RecoveryOutcome::DeletedCorrupt, RecoveryOutcome::BackupAlsoCorrupt,
         RecoveryOutcome::StartedFreshQuarantined }) {
        const auto spelling = vayu::db::to_string (outcome);
        const auto parsed   = vayu::db::recovery_outcome_from_string (spelling);
        EXPECT_TRUE (parsed == outcome) << spelling;
    }
}

TEST_F (DbRecoveryTest, AMarkerFromAnEngineThatDeletedStillReadsAsADeletion) {
    // `deleted_corrupt` is no longer written by a start that can quarantine
    // instead, but a marker is not cleared and outlives the engine run that
    // wrote it - so an upgrade must not turn one into "no record", which is how
    // a genuine first run reads.
    {
        std::ofstream out (vayu::db::recovery_marker_path (DB_PATH),
        std::ios::binary | std::ios::trunc);
        out << R"({"outcome":"deleted_corrupt","at":1755870000000})";
    }

    const auto record = vayu::db::read_recovery_marker (DB_PATH);
    ASSERT_HAS_VALUE (record);
    EXPECT_TRUE (record->outcome == RecoveryOutcome::DeletedCorrupt);
    EXPECT_FALSE (record->quarantined_path.has_value ());
}

// ==================== The recovery backup's refresh ====================
//
// The `.bak` used to be a file copy the constructor took before the engine
// listened - O(database size) on every clean start. It is now a snapshot the
// daemon starts once it listens (`start_recovery_backup_refresh`).

TEST_F (DbRecoveryTest, TheConstructorTakesNoBackup) {
    // The startup cost this moved: a clean open of an existing, valid database
    // writes nothing beside it. Mutation check: restore the `copy_db_files`
    // call in the constructor's validated branch and this reddens.
    {
        vayu::db::Database first (DB_PATH);
        first.init ();
    }
    std::filesystem::remove (std::string (DB_PATH) + ".bak");

    vayu::db::Database db (DB_PATH);
    db.init ();

    EXPECT_FALSE (std::filesystem::exists (std::string (DB_PATH) + ".bak"));
}

TEST_F (DbRecoveryTest, ARefreshedBackupIsWhatRecoveryRestores) {
    {
        vayu::db::Database db (DB_PATH);
        db.init ();
        vayu::db::Collection col;
        col.id    = "col_kept";
        col.name  = "Kept";
        col.order = 0;
        db.create_collection (col);
        const auto refreshed = db.refresh_recovery_backup ();
        ASSERT_HAS_VALUE (refreshed) << refreshed.error ();
    }
    EXPECT_FALSE (std::filesystem::exists (std::string (DB_PATH) + ".bak.tmp"))
    << "the snapshot was left beside the backup instead of renamed over it";

    write_corrupt_database ();
    vayu::db::Database db (DB_PATH);

    EXPECT_TRUE (recorded_outcome (db) == RecoveryOutcome::RestoredFromBackup);
    const auto collections = db.get_collections ();
    ASSERT_EQ (collections.size (), 1u);
    EXPECT_EQ (collections.front ().id, "col_kept");
}

TEST_F (DbRecoveryTest, ARefreshRemovesTheSidecarsOfTheBackupItReplaces) {
    // `recover_database` copies a `.bak-wal` back along with the `.bak`, so
    // one written for the previous backup would be replayed over a snapshot
    // it was never part of.
    vayu::db::Database db (DB_PATH);
    db.init ();
    write_corrupt_file (std::string (DB_PATH) + ".bak-wal", "-stale-wal");
    write_corrupt_file (std::string (DB_PATH) + ".bak-shm", "-stale-shm");

    ASSERT_HAS_VALUE (db.refresh_recovery_backup ());

    EXPECT_TRUE (std::filesystem::exists (std::string (DB_PATH) + ".bak"));
    EXPECT_FALSE (std::filesystem::exists (std::string (DB_PATH) + ".bak-wal"));
    EXPECT_FALSE (std::filesystem::exists (std::string (DB_PATH) + ".bak-shm"));
}

TEST_F (DbRecoveryTest, AStartThatRecoveredLeavesTheBackupItJudgedAlone) {
    // The corrupt `.bak` is evidence the recovery branch kept; a snapshot of
    // the fresh database that replaced it is not this start's to write over it.
    write_corrupt_file (std::string (DB_PATH) + ".bak", "-backup");
    const std::string backup_bytes = read_file (std::string (DB_PATH) + ".bak");
    write_corrupt_database ();

    vayu::db::Database db (DB_PATH);
    ASSERT_TRUE (recorded_outcome (db) == RecoveryOutcome::BackupAlsoCorrupt);

    EXPECT_FALSE (db.refresh_recovery_backup ().has_value ());
    EXPECT_EQ (read_file (std::string (DB_PATH) + ".bak"), backup_bytes);
}

TEST_F (DbRecoveryTest, AFinishedRefreshWritesNothingAndKeepsThePreviousBackup) {
    // A shutdown's `finish_recovery_backup_refresh` must leave the backup that
    // was there, whole: a refresh it cancelled writes no snapshot and renames
    // nothing, and a start after it is ignored.
    vayu::db::Database db (DB_PATH);
    db.init ();
    ASSERT_HAS_VALUE (db.refresh_recovery_backup ());
    const std::string previous = read_file (std::string (DB_PATH) + ".bak");
    ASSERT_FALSE (previous.empty ());

    vayu::db::Collection col;
    col.id    = "col_after";
    col.name  = "After";
    col.order = 0;
    db.create_collection (col);

    db.finish_recovery_backup_refresh ();
    db.start_recovery_backup_refresh ();
    db.finish_recovery_backup_refresh ();
    EXPECT_FALSE (db.refresh_recovery_backup ().has_value ());

    EXPECT_EQ (read_file (std::string (DB_PATH) + ".bak"), previous);
    EXPECT_FALSE (std::filesystem::exists (std::string (DB_PATH) + ".bak.tmp"));
}

TEST_F (DbRecoveryTest, ABackgroundRefreshLandsAWholeBackup) {
    // Built once, outside the wait loop: GCC 13 at -O3 reports a spurious
    // -Warray-bounds on `std::string + ".bak"` inlined into a loop condition,
    // which the prod presets' -Werror turns into a build failure.
    const std::filesystem::path backup = std::filesystem::path (DB_PATH).concat (".bak");
    {
        vayu::db::Database db (DB_PATH);
        db.init ();
        db.start_recovery_backup_refresh ();
        // The destructor joins it: `finish_recovery_backup_refresh` would
        // cancel a refresh this test wants to see complete.
        for (int i = 0; i < 500 && !std::filesystem::exists (backup); ++i) {
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
        }
    }
    ASSERT_TRUE (std::filesystem::exists (backup));
    EXPECT_FALSE (std::filesystem::exists (std::string (DB_PATH) + ".bak.tmp"));

    // Whole means recovery can use it.
    write_corrupt_database ();
    vayu::db::Database db (DB_PATH);
    EXPECT_TRUE (recorded_outcome (db) == RecoveryOutcome::RestoredFromBackup);
}

// ==================== Unavailable is not corrupt (#2420) ====================
//
// The probe used to read any exception as "this database is invalid", so a
// healthy file met by a lock, a full disk or a read-only directory at startup
// was quarantined and replaced by its `.bak`.

/// A raw connection a test opens beside the engine's, closed on scope exit.
using RawConnection = std::unique_ptr<sqlite3, decltype (&sqlite3_close)>;

RawConnection open_raw (const std::string& path) {
    sqlite3* handle = nullptr;
    sqlite3_open (path.c_str (), &handle);
    return { handle, &sqlite3_close };
}

/// Runs @p sql on @p connection, answering SQLite's error text or "".
std::string exec_sql (sqlite3* connection, const std::string& sql) {
    char* raw_error = nullptr;
    if (sqlite3_exec (connection, sql.c_str (), nullptr, nullptr, &raw_error) == SQLITE_OK) {
        return "";
    }
    std::string error = raw_error != nullptr ? raw_error : "unknown error";
    sqlite3_free (raw_error);
    return error;
}

int64_t read_user_version (sqlite3* connection) {
    sqlite3_stmt* statement = nullptr;
    int64_t version         = -1;
    if (sqlite3_prepare_v2 (connection, "PRAGMA user_version", -1, &statement, nullptr) == SQLITE_OK &&
    sqlite3_step (statement) == SQLITE_ROW) {
        version = sqlite3_column_int64 (statement, 0);
    }
    sqlite3_finalize (statement);
    return version;
}

bool runs_has_origin_column (sqlite3* connection) {
    sqlite3_stmt* statement = nullptr;
    bool found              = false;
    if (sqlite3_prepare_v2 (connection, "PRAGMA table_info(runs)", -1,
        &statement, nullptr) == SQLITE_OK) {
        while (!found && sqlite3_step (statement) == SQLITE_ROW) {
            const char* name = vayu::db::column_text (statement, 1);
            found = name != nullptr && std::string (name) == "origin";
        }
    }
    sqlite3_finalize (statement);
    return found;
}

/// A database at @p path holding one collection, then taken back to schema
/// version 4 without `runs.origin`: the next open has to `ADD COLUMN`, which
/// is a write and so meets any lock another connection holds.
void write_database_needing_a_column (const std::string& path) {
    {
        vayu::db::Database db (path);
        db.init ();
        vayu::db::Collection col;
        col.id    = "col_kept";
        col.name  = "Kept";
        col.order = 0;
        db.create_collection (col);
    }
    const RawConnection connection = open_raw (path);
    ASSERT_EQ (exec_sql (connection.get (), "ALTER TABLE runs DROP COLUMN origin"), "");
    ASSERT_EQ (exec_sql (connection.get (), "PRAGMA user_version = 4"), "");
}

/// Startup's wait for a lock, lowered so the refusal is reached in a test.
constexpr std::chrono::milliseconds SHORT_WAIT{ 100 };

TEST_F (DbRecoveryTest, ALockedDatabaseIsRefusedAndLeftExactlyAsItWas) {
    write_database_needing_a_column (DB_PATH);
    {
        // At the current version the migration has nothing to stamp, so the
        // lock is met by the probe's schema sync, the path this test pins. A
        // lock met by the migration's own writes is refused by
        // `migrate_before_sync` itself (db_test.cpp).
        const RawConnection connection = open_raw (DB_PATH);
        ASSERT_EQ (exec_sql (connection.get (),
                   "PRAGMA user_version = " + std::to_string (vayu::db::SCHEMA_VERSION)),
        "");
    }
    const std::string backup = std::string (DB_PATH) + ".bak";
    write_corrupt_file (backup, "-backup-evidence");
    const std::string database_bytes = read_file (DB_PATH);
    const std::string backup_bytes   = read_file (backup);
    ASSERT_FALSE (database_bytes.empty ());

    RawConnection holder = open_raw (DB_PATH);
    ASSERT_EQ (exec_sql (holder.get (), "BEGIN IMMEDIATE"), "");

    std::string refusal;
    try {
        vayu::db::Database db (DB_PATH, SHORT_WAIT);
        ADD_FAILURE () << "a database another connection holds was opened";
    } catch (const std::runtime_error& e) {
        refusal = e.what ();
    }

    EXPECT_NE (refusal.find (DB_PATH), std::string::npos) << refusal;
    EXPECT_NE (refusal.find ("database is locked (SQLite result code 5)"), std::string::npos)
    << refusal;
    EXPECT_NE (refusal.find ("Nothing was changed"), std::string::npos) << refusal;
    EXPECT_EQ (read_file (DB_PATH), database_bytes)
    << "the database was written to";
    EXPECT_EQ (read_file (backup), backup_bytes) << "the backup was touched";
    EXPECT_TRUE (vayu::db::quarantined_database_paths (DB_PATH).empty ())
    << "a database that was only locked was quarantined";
    EXPECT_FALSE (std::filesystem::exists (vayu::db::recovery_marker_path (DB_PATH)));

    ASSERT_EQ (exec_sql (holder.get (), "ROLLBACK"), "");
    holder.reset ();

    // Once the lock is gone the same file opens, data intact.
    {
        vayu::db::Database db (DB_PATH, SHORT_WAIT);
        EXPECT_FALSE (db.recovery ().has_value ());
        const auto collections = db.get_collections ();
        ASSERT_EQ (collections.size (), 1u);
        EXPECT_EQ (collections.front ().id, "col_kept");
    }
    const RawConnection reopened = open_raw (DB_PATH);
    EXPECT_EQ (read_user_version (reopened.get ()), vayu::db::SCHEMA_VERSION);
    EXPECT_TRUE (runs_has_origin_column (reopened.get ()));
}

TEST_F (DbRecoveryTest, ABackupThatCannotBeExaminedStopsRecoveryBeforeAnythingMoves) {
    // The main file is corrupt, but whether the backup would restore is
    // unknown while another connection holds it: moving the corrupt file
    // aside on that basis could leave a fresh database in its place.
    const std::string backup = std::string (DB_PATH) + ".bak";
    write_database_needing_a_column (backup);
    write_corrupt_database ("-original");
    const std::string corrupt_bytes = read_file (DB_PATH);

    RawConnection holder = open_raw (backup);
    ASSERT_EQ (exec_sql (holder.get (), "BEGIN IMMEDIATE"), "");

    std::string refusal;
    try {
        vayu::db::Database db (DB_PATH, SHORT_WAIT);
        ADD_FAILURE () << "recovery ran against a backup it could not examine";
    } catch (const std::runtime_error& e) {
        refusal = e.what ();
    }

    EXPECT_NE (refusal.find (backup), std::string::npos) << refusal;
    EXPECT_EQ (read_file (DB_PATH), corrupt_bytes);
    EXPECT_TRUE (vayu::db::quarantined_database_paths (DB_PATH).empty ());
    EXPECT_FALSE (std::filesystem::exists (vayu::db::recovery_marker_path (DB_PATH)));
}

TEST_F (DbRecoveryTest, AStartWaitsOutABriefLockRatherThanRefusing) {
    // The busy timeout has to be on the connection before its first
    // statement. On a rollback journal, switching to WAL needs the whole
    // file, so a reader's shared lock blocks `Impl`'s very first pragma -
    // which, run ahead of the timeout, failed at once.
    {
        vayu::db::Database db (DB_PATH);
    }
    {
        const RawConnection connection = open_raw (DB_PATH);
        ASSERT_EQ (exec_sql (connection.get (), "PRAGMA journal_mode = DELETE"), "");
    }
    RawConnection reader = open_raw (DB_PATH);
    ASSERT_EQ (exec_sql (reader.get (), "BEGIN; SELECT count(*) FROM collections;"), "");
    std::thread release ([&reader] {
        std::this_thread::sleep_for (std::chrono::milliseconds (300));
        exec_sql (reader.get (), "COMMIT");
    });

    std::string refusal;
    try {
        vayu::db::Database db (DB_PATH, std::chrono::seconds (10));
    } catch (const std::exception& e) {
        refusal = e.what ();
    }
    release.join ();

    EXPECT_EQ (refusal, "") << "the start gave up instead of waiting";
}

TEST_F (DbRecoveryTest, TheStartupWaitIsOnTheConnectionUntilInitAppliesTheSetting) {
    vayu::db::Database db (DB_PATH, std::chrono::milliseconds (1234));
    EXPECT_EQ (db.applied_busy_timeout_ms (), 1234);

    db.init ();
    EXPECT_EQ (db.applied_busy_timeout_ms (), vayu::core::constants::database::BUSY_TIMEOUT_MS);
}

TEST_F (DbRecoveryTest, ATruncatedDatabaseStillTakesTheRecoveryBranch) {
    {
        vayu::db::Database db (DB_PATH);
        db.init ();
    }
    const auto size = std::filesystem::file_size (DB_PATH);
    ASSERT_GT (size, 8192u);
    // Two pages: the header survives, so this is SQLite's to judge rather
    // than `has_sqlite_header`'s, and the tables past them are gone.
    std::filesystem::resize_file (DB_PATH, 8192);
    const std::string truncated_bytes = read_file (DB_PATH);

    vayu::db::Database db (DB_PATH);

    EXPECT_TRUE (recorded_outcome (db) == RecoveryOutcome::StartedFreshQuarantined);
    const std::string quarantined = only_quarantined_path ();
    ASSERT_FALSE (quarantined.empty ());
    EXPECT_EQ (read_file (quarantined), truncated_bytes);
}

TEST_F (DbRecoveryTest, ADamagedPageBehindAValidHeaderIsCorruptAndRestored) {
    {
        vayu::db::Database db (DB_PATH);
        db.init ();
        ASSERT_HAS_VALUE (db.refresh_recovery_backup ());
    }
    // Page 1's b-tree header starts at byte 100, after the file header; a
    // page type no b-tree page has makes the schema unreadable
    // (`SQLITE_CORRUPT`) while the first sixteen bytes still say SQLite.
    {
        std::fstream file (DB_PATH, std::ios::binary | std::ios::in | std::ios::out);
        file.seekp (100);
        const std::string garbage (8, '\x7f');
        file.write (garbage.data (), static_cast<std::streamsize> (garbage.size ()));
    }
    const std::string damaged_bytes = read_file (DB_PATH);

    vayu::db::Database db (DB_PATH);

    EXPECT_TRUE (recorded_outcome (db) == RecoveryOutcome::RestoredFromBackup);
    const std::string quarantined = only_quarantined_path ();
    ASSERT_FALSE (quarantined.empty ());
    EXPECT_EQ (read_file (quarantined), damaged_bytes);
}

// ==================== The refresh at shutdown (#2421) ====================
//
// The start-of-session snapshot holds none of the session's work, so a torn
// main file after a long session used to restore the session's start.

/// Ample for a test-sized copy; the shutdown deadline constant still applies.
constexpr std::chrono::milliseconds AMPLE_BUDGET{ 60'000 };

void write_collection_with_request (vayu::db::Database& db, const std::string& collection_id) {
    vayu::db::Collection col;
    col.id    = collection_id;
    col.name  = collection_id;
    col.order = 0;
    db.create_collection (col);
    vayu::db::Request request;
    request.id            = collection_id + "_req";
    request.collection_id = collection_id;
    request.name          = "Kept request";
    request.method        = vayu::HttpMethod::GET;
    request.url           = "https://example.test/kept";
    request.created_at    = 1;
    request.updated_at    = 1;
    db.save_request (request);
}

TEST_F (DbRecoveryTest, AShutdownRefreshKeepsTheSessionsWorkThroughATornFile) {
    // Experiment 10E with the session's work kept. Mutation check: return
    // before `replace_recovery_backup` in `refresh_recovery_backup_on_shutdown`
    // and the restore comes back with the start-of-session backup, no rows.
    {
        vayu::db::Database db (DB_PATH);
        db.init ();
        ASSERT_HAS_VALUE (db.refresh_recovery_backup ())
        << "the start-of-session backup";
        write_collection_with_request (db, "col_session");
        const auto refreshed = db.refresh_recovery_backup_on_shutdown (AMPLE_BUDGET);
        ASSERT_HAS_VALUE (refreshed) << refreshed.error ();
    }
    EXPECT_FALSE (std::filesystem::exists (std::string (DB_PATH) + ".bak.tmp"));

    std::filesystem::resize_file (DB_PATH, std::filesystem::file_size (DB_PATH) / 2);
    vayu::db::Database db (DB_PATH);

    EXPECT_TRUE (recorded_outcome (db) == RecoveryOutcome::RestoredFromBackup);
    const auto collections = db.get_collections ();
    ASSERT_EQ (collections.size (), 1u);
    EXPECT_EQ (collections.front ().id, "col_session");
    EXPECT_TRUE (db.get_request ("col_session_req").has_value ());
}

TEST_F (DbRecoveryTest, AShutdownAfterASessionThatWroteNothingLeavesTheBackupAlone) {
    // Mutation check: drop the `sqlite3_total_changes64` skip in
    // `refresh_recovery_backup_on_shutdown` and the sentinel is replaced.
    const std::filesystem::path backup = std::filesystem::path (DB_PATH).concat (".bak");
    vayu::db::Database db (DB_PATH);
    db.init ();
    // Bytes no snapshot could produce, so a rewrite cannot pass for a no-op.
    write_corrupt_file (backup.string (), "-sentinel");
    const std::string sentinel = read_file (backup.string ());
    const auto written_at      = std::filesystem::last_write_time (backup);

    EXPECT_TRUE (db.get_collections ().empty ()) << "a read is not a write";
    const auto refreshed = db.refresh_recovery_backup_on_shutdown (AMPLE_BUDGET);

    ASSERT_HAS_VALUE (refreshed) << refreshed.error ();
    EXPECT_EQ (read_file (backup.string ()), sentinel);
    EXPECT_EQ (std::filesystem::last_write_time (backup), written_at);
}

TEST_F (DbRecoveryTest, AShutdownRefreshPastItsDeadlineKeepsThePreviousBackup) {
    // Mutation check: remove the `sqlite3_progress_handler` call and the copy
    // runs to the end, to be discarded for finishing late instead.
    const std::filesystem::path backup = std::filesystem::path (DB_PATH).concat (".bak");
    vayu::db::Database db (DB_PATH);
    db.init ();
    ASSERT_HAS_VALUE (db.refresh_recovery_backup ());
    const std::string previous = read_file (backup.string ());
    ASSERT_FALSE (previous.empty ());
    write_collection_with_request (db, "col_late");
    // Rows, not a few large values: the deadline is checked between VM
    // instructions, and a large value's pages are copied inside one. A
    // workspace's bulk is rows too (runs, results), so this is its shape.
    {
        const RawConnection filler = open_raw (DB_PATH);
        ASSERT_EQ (
        exec_sql (filler.get (),
        "CREATE TABLE deadline_filler (v BLOB);"
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n "
        "WHERE i < 20000) INSERT INTO deadline_filler SELECT "
        "randomblob(64) FROM n;"),
        "");
    }

    const auto refreshed =
    db.refresh_recovery_backup_on_shutdown (std::chrono::milliseconds (1));

    ASSERT_FALSE (refreshed.has_value ());
    EXPECT_NE (refreshed.error ().find ("interrupted"), std::string::npos)
    << refreshed.error ();
    EXPECT_EQ (read_file (backup.string ()), previous);
    const std::string snapshot = std::string (DB_PATH) + ".bak.tmp";
    EXPECT_FALSE (std::filesystem::exists (snapshot));
    EXPECT_FALSE (std::filesystem::exists (snapshot + "-wal"));
    EXPECT_FALSE (std::filesystem::exists (snapshot + "-shm"));
}

TEST_F (DbRecoveryTest, AShutdownWithNoTimeLeftCopiesNothing) {
    const std::filesystem::path backup = std::filesystem::path (DB_PATH).concat (".bak");
    vayu::db::Database db (DB_PATH);
    db.init ();
    ASSERT_HAS_VALUE (db.refresh_recovery_backup ());
    const std::string previous = read_file (backup.string ());
    write_collection_with_request (db, "col_late");

    const auto refreshed =
    db.refresh_recovery_backup_on_shutdown (std::chrono::milliseconds (0));

    ASSERT_FALSE (refreshed.has_value ());
    EXPECT_EQ (read_file (backup.string ()), previous);
}

TEST_F (DbRecoveryTest, AShutdownAfterARecoveredStartLeavesTheBackupItJudgedAlone) {
    const std::filesystem::path backup = std::filesystem::path (DB_PATH).concat (".bak");
    write_corrupt_file (backup.string (), "-backup");
    const std::string backup_bytes = read_file (backup.string ());
    write_corrupt_database ();
    vayu::db::Database db (DB_PATH);
    db.init ();
    ASSERT_TRUE (recorded_outcome (db) == RecoveryOutcome::BackupAlsoCorrupt);
    write_collection_with_request (db, "col_after_recovery");

    EXPECT_FALSE (db.refresh_recovery_backup_on_shutdown (AMPLE_BUDGET).has_value ());
    EXPECT_EQ (read_file (backup.string ()), backup_bytes);
}

// ============ The safety copies earlier engines left (#2426) ============
//
// `<db>.pre-migration.bak` and `<db>.pre-upgrade.bak` were written beside the
// database and never removed. They go on a later start than the one that
// migrated, once that start has refreshed `<db>.bak`.

/// The legacy copies beside @p db_path and their sidecars, each written with
/// @p mtime.
std::vector<std::filesystem::path> write_legacy_safety_copies (const std::string& db_path,
std::filesystem::file_time_type mtime) {
    std::vector<std::filesystem::path> written;
    for (const char* copy : { ".pre-migration.bak", ".pre-upgrade.bak" }) {
        for (const char* suffix : { "", "-wal", "-shm" }) {
            const std::filesystem::path path = db_path + copy + suffix;
            std::ofstream (path, std::ios::binary)
            << "a copy an older engine wrote";
            std::filesystem::last_write_time (path, mtime);
            written.push_back (path);
        }
    }
    return written;
}

/// One start the way the daemon makes it: open, init, then the refresh it
/// starts once listening.
void start_and_refresh (const std::string& db_path) {
    vayu::db::Database db (db_path);
    db.init ();
    const auto refreshed = db.refresh_recovery_backup ();
    ASSERT_HAS_VALUE (refreshed) << refreshed.error ();
}

// Mutation check: drop the `remove_legacy_safety_copies` call in
// `refresh_recovery_backup` and they are still there after the second start;
// drop its `opened_at_current_schema` condition and they are gone after the
// first.
TEST_F (DbRecoveryTest, LegacyPreMigrationFilesAreRemovedOnALaterStart) {
    {
        vayu::db::Database db (DB_PATH);
        db.init ();
    }
    {
        const RawConnection connection = open_raw (DB_PATH);
        ASSERT_EQ (
        exec_sql (connection.get (),
        "PRAGMA user_version = " + std::to_string (vayu::db::SCHEMA_VERSION - 1)),
        "");
    }
    const auto copies = write_legacy_safety_copies (DB_PATH,
    std::filesystem::file_time_type::clock::now () - std::chrono::hours (1));

    start_and_refresh (DB_PATH); // migrates
    for (const auto& copy : copies) {
        EXPECT_TRUE (std::filesystem::exists (copy))
        << "the migrating start removed " << copy;
    }

    start_and_refresh (DB_PATH);
    for (const auto& copy : copies) {
        EXPECT_FALSE (std::filesystem::exists (copy)) << copy << " was left behind";
    }
}

// Mutation check: drop the mtime condition in `remove_legacy_safety_copies`
// and the copy is removed.
TEST_F (DbRecoveryTest, ASafetyCopyWrittenSinceTheStartBeganIsKept) {
    {
        vayu::db::Database db (DB_PATH);
        db.init ();
    }
    const auto copies = write_legacy_safety_copies (DB_PATH,
    std::filesystem::file_time_type::clock::now () + std::chrono::hours (1));

    start_and_refresh (DB_PATH);
    for (const auto& copy : copies) {
        EXPECT_TRUE (std::filesystem::exists (copy)) << copy;
    }
}

// ==================== The probe's classification (#2420) ====================

std::system_error sqlite_failure (int code) {
    return { std::error_code (code, sqlite_orm::get_sqlite_error_category ()), "probe" };
}

TEST (ProbeClassification, OnlyCorruptAndNotADatabaseAreCorrupt) {
    for (const int code : { SQLITE_CORRUPT, SQLITE_NOTADB }) {
        const auto found = vayu::db::classify_probe_failure (sqlite_failure (code));
        EXPECT_TRUE (found.verdict == vayu::db::ProbeResult::Verdict::Corrupt) << code;
        EXPECT_EQ (found.sqlite_code, code);
    }
    for (const int code : { SQLITE_BUSY, SQLITE_LOCKED, SQLITE_FULL,
         SQLITE_READONLY, SQLITE_IOERR, SQLITE_CANTOPEN, SQLITE_PERM }) {
        const auto found = vayu::db::classify_probe_failure (sqlite_failure (code));
        EXPECT_TRUE (found.verdict == vayu::db::ProbeResult::Verdict::Unavailable) << code;
        EXPECT_EQ (found.sqlite_code, code);
    }
}

TEST (ProbeClassification, TheReasonSaysWhatSqliteSaidOnce) {
    const std::system_error locked (
    std::error_code (SQLITE_BUSY, sqlite_orm::get_sqlite_error_category ()), "database is locked");
    EXPECT_EQ (vayu::db::classify_probe_failure (locked).reason, "database is locked");

    // A specific message is kept whole beside the generic one.
    const std::system_error specific (
    std::error_code (SQLITE_ERROR, sqlite_orm::get_sqlite_error_category ()),
    "no such table: runs");
    EXPECT_EQ (vayu::db::classify_probe_failure (specific).reason,
    std::string (specific.what ()));
}

TEST (ProbeClassification, AnythingNotSqlitesIsUnavailable) {
    // errno 11 is EAGAIN, not SQLITE_CORRUPT: the category decides, not the
    // number.
    const std::system_error errno_failure (
    std::error_code (SQLITE_CORRUPT, std::generic_category ()), "create_directories");
    const auto from_errno = vayu::db::classify_probe_failure (errno_failure);
    EXPECT_TRUE (from_errno.verdict == vayu::db::ProbeResult::Verdict::Unavailable);
    EXPECT_EQ (from_errno.sqlite_code, 0);

    const auto from_migration = vayu::db::classify_probe_failure (
    std::runtime_error ("Vayu could not migrate the database"));
    EXPECT_TRUE (from_migration.verdict == vayu::db::ProbeResult::Verdict::Unavailable);
    EXPECT_EQ (from_migration.reason, "Vayu could not migrate the database");
}

TEST (ProbeClassification, TheRefusalNamesTheCodeOnlyWhenThereIsOne) {
    const vayu::db::ProbeResult locked{ vayu::db::ProbeResult::Verdict::Unavailable,
        SQLITE_BUSY, "database is locked" };
    const std::string with_code =
    vayu::db::unavailable_database_message ("/d/vayu.db", locked);
    EXPECT_NE (with_code.find ("/d/vayu.db"), std::string::npos);
    EXPECT_NE (with_code.find ("database is locked (SQLite result code 5)"),
    std::string::npos);

    const vayu::db::ProbeResult migration{ vayu::db::ProbeResult::Verdict::Unavailable,
        0, "migration failed" };
    EXPECT_EQ (vayu::db::unavailable_database_message ("/d/vayu.db", migration).find ("SQLite result code"),
    std::string::npos);
}

} // namespace
