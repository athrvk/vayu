/**
 * @file tests/db_recovery_test.cpp
 * @brief The startup recovery marker and the `/health` node that reports it
 *        (issue #922).
 *
 * The behaviour under test is a claim about the user's data: a database that
 * could not be opened and could not be restored is *deleted*, and before this
 * the whole record of that was two lines in the engine log. So the cases here
 * are the two a reader has to be able to tell apart - a startup that wiped the
 * database, and a genuine first run, which produces an empty database too.
 */

#include <gtest/gtest.h>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <string>

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

    /// Leave bytes at the database path that SQLite cannot open as a database.
    static void write_corrupt_database () {
        std::ofstream out (DB_PATH, std::ios::binary | std::ios::trunc);
        // A valid SQLite file starts with "SQLite format 3\0"; this is long
        // enough to be read as a header and wrong in every byte of it.
        out << "this is not a database, it is a text file pretending to be one";
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

TEST_F (DbRecoveryTest, DeletingACorruptDatabaseWithNoBackupIsRecorded) {
    write_corrupt_database ();
    ASSERT_FALSE (std::filesystem::exists (std::string (DB_PATH) + ".bak"));

    auto db = std::make_unique<vayu::db::Database> (DB_PATH);

    ASSERT_HAS_VALUE (db->recovery ());
    EXPECT_TRUE (recorded_outcome (*db) == RecoveryOutcome::DeletedCorrupt);
    EXPECT_GT (recorded_at (*db), 0);

    const auto marker = read_marker ();
    ASSERT_TRUE (marker.is_object ());
    EXPECT_EQ (marker["outcome"], "deleted_corrupt");
}

TEST_F (DbRecoveryTest, HealthReportsTheDeletionWithThePathThatWasWiped) {
    write_corrupt_database ();
    auto db = std::make_unique<vayu::db::Database> (DB_PATH);

    const auto health = vayu::http::routes::build_health_response (*db);
    ASSERT_TRUE (health.contains ("recovery"));
    EXPECT_EQ (health["recovery"]["outcome"], "deleted_corrupt");
    EXPECT_EQ (health["recovery"]["databasePath"], db->path ());
    EXPECT_GT (health["recovery"]["at"].get<int64_t> (), 0);
}

TEST_F (DbRecoveryTest, RestoringFromABackupIsADifferentOutcome) {
    // A good database, closed, so the constructor has taken its `.bak` copy.
    {
        vayu::db::Database seed (DB_PATH);
    }
    ASSERT_TRUE (std::filesystem::exists (std::string (DB_PATH) + ".bak"));

    write_corrupt_database ();
    auto db = std::make_unique<vayu::db::Database> (DB_PATH);

    ASSERT_HAS_VALUE (db->recovery ());
    EXPECT_TRUE (recorded_outcome (*db) == RecoveryOutcome::RestoredFromBackup);
    EXPECT_EQ (
    vayu::http::routes::build_health_response (*db)["recovery"]["outcome"],
    "restored_from_backup");
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
    EXPECT_TRUE (recorded_outcome (second) == RecoveryOutcome::DeletedCorrupt);
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
         R"({"at":123})", R"({"outcome":"reformatted_the_disk","at":123})",
         R"(["deleted_corrupt",123])" }) {
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
    for (const auto outcome :
    { RecoveryOutcome::RestoredFromBackup, RecoveryOutcome::DeletedCorrupt }) {
        const auto spelling = vayu::db::to_string (outcome);
        const auto parsed   = vayu::db::recovery_outcome_from_string (spelling);
        EXPECT_TRUE (parsed == outcome) << spelling;
    }
}

} // namespace
