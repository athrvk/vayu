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
 */

#include <gtest/gtest.h>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/db/recovery.hpp"

namespace vayu::http::routes {
// Declared in health.cpp; the body of GET /health.
nlohmann::json build_health_response (const vayu::db::Database& db);
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
    // A good database, closed, so the constructor has taken its `.bak` copy.
    {
        vayu::db::Database seed (DB_PATH);
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
        // Each round is the no-backup path: the fresh database the previous
        // round created is valid, so its own start took a `.bak` copy.
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

} // namespace
