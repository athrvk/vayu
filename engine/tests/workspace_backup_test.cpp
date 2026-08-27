/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/workspace_backup_test.cpp
 * @brief Tests for `POST /workspace/backup` and the `Database` half behind it
 *        (issue #987).
 *
 * What is pinned here is what a backup feature can silently get wrong:
 *
 *  - **The file is a database, not bytes.** A snapshot that cannot be opened,
 *    or that opens and is missing the rows the workspace had, is the failure
 *    this feature exists to prevent - and it looks identical from the outside
 *    to one that worked. So the snapshot is opened as a `Database` and read.
 *  - **Retention removes only what Vayu wrote.** The directory belongs to the
 *    user; a pass that deleted by count without looking at the name would eat a
 *    copy they put there themselves.
 *  - **Retention keeps the *newest*.** Pruning the wrong end of the list would
 *    leave the oldest snapshots and pass every count-based assertion.
 *  - **A second concurrent backup is refused, and the slot is released.** A
 *    guard that never releases turns the second *sequential* backup into a 409,
 *    which is why both directions are asserted.
 *
 * Follows the suite's route-test convention: the route's extracted core is
 * exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in workspace.cpp / collections.cpp; each returns {http_status,
// json_body} - the pair the handler writes out.
std::pair<int, nlohmann::json> workspace_backup_response (vayu::db::Database& db, int64_t now);
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

namespace fs     = std::filesystem;
namespace routes = vayu::http::routes;

/// An arbitrary but plausible instant, so the snapshot names in a failure
/// message read as dates rather than as noise. 2026-08-27T12:00:00.000Z.
constexpr int64_t A_MOMENT = 1'787'745'600'000;

/// A field of the engine's `{"error": {"code", "message"}}` envelope, or "" -
/// so a body that is not an error fails the assertion rather than throwing.
std::string error_field (const json& body, const char* field) {
    const auto error = body.find ("error");
    if (error == body.end () || !error->is_object ()) {
        return {};
    }
    return error->value (field, std::string{});
}

class WorkspaceBackupTest : public ::testing::Test {
    protected:
    /// A directory of its own rather than a bare filename, because this feature
    /// writes a *sibling* directory of the database - so the fixture has to own
    /// the parent to clean up after itself.
    static constexpr const char* WORKSPACE = "workspace_backup_scratch";
    static constexpr const char* DB_PATH   = "workspace_backup_scratch/vayu.db";

    void SetUp () override {
        cleanup ();
        fs::create_directories (WORKSPACE);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }

    void TearDown () override {
        db_.reset ();
        cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
        std::error_code ec;
        fs::remove_all (WORKSPACE, ec);
    }

    /// Write @p value to the config row @p key, the way the Settings screen
    /// does - `save_config_entry` replaces the whole row, so the entry is read
    /// back and edited rather than rebuilt.
    void set_config (const std::string& key, int value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key;
        entry->value = std::to_string (value);
        db_->save_config_entry (*entry);
    }

    std::string create_collection (const std::string& name) {
        auto [status, response] =
        routes::create_collection_response (*db_, json{ { "name", name } });
        EXPECT_EQ (status, 200) << response.dump ();
        return response.value ("id", std::string{});
    }

    /// The snapshot files in the backups directory, oldest first.
    std::vector<std::string> snapshot_names () const {
        std::vector<std::string> names;
        std::error_code ec;
        for (const auto& entry : fs::directory_iterator (db_->backups_directory (), ec)) {
            names.push_back (entry.path ().filename ().string ());
        }
        std::sort (names.begin (), names.end ());
        return names;
    }

    vayu::db::BackupRecord backup_ok (int64_t now) {
        auto outcome = db_->backup_workspace (now);
        EXPECT_TRUE (outcome.has_value ())
        << (outcome ? std::string{} : outcome.error ().message);
        return outcome ? *outcome : vayu::db::BackupRecord{};
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// ============================================================================
// The snapshot itself
// ============================================================================

TEST_F (WorkspaceBackupTest, WritesADatabaseThatOpensAndStillHasTheRows) {
    create_collection ("Kept");

    const auto record = backup_ok (A_MOMENT);
    ASSERT_FALSE (record.path.empty ());
    ASSERT_TRUE (fs::exists (record.path)) << record.path;
    EXPECT_EQ (record.created_at, A_MOMENT);
    EXPECT_GT (record.size_bytes, 0);
    EXPECT_EQ (record.size_bytes, static_cast<int64_t> (fs::file_size (record.path)));

    // The whole point of the feature: the file is a workspace, not bytes. A
    // plain file copy taken while the engine is running would open and be
    // missing whatever the `-wal` still held.
    {
        vayu::db::Database restored (record.path);
        restored.init ();
        const auto collections = restored.get_collections ();
        ASSERT_EQ (collections.size (), 1U);
        EXPECT_EQ (collections.front ().name, "Kept");
    }
    vayu::tests::remove_database_files (record.path);
}

TEST_F (WorkspaceBackupTest, SnapshotsLandBesideTheDatabaseInBackups) {
    const auto record = backup_ok (A_MOMENT);
    EXPECT_EQ (fs::path (record.path).parent_path (), fs::path (db_->backups_directory ()));
    EXPECT_EQ (db_->backups_directory (), (fs::path (WORKSPACE) / "backups").string ());
}

TEST_F (WorkspaceBackupTest, TwoBackupsInTheSameMillisecondAreTwoFiles) {
    // The stamp names the file, so an unstepped collision would either
    // overwrite the first snapshot or - since VACUUM INTO refuses an existing
    // destination - fail the second.
    const auto first  = backup_ok (A_MOMENT);
    const auto second = backup_ok (A_MOMENT);
    EXPECT_NE (first.path, second.path);
    EXPECT_EQ (snapshot_names ().size (), 2U);
}

TEST_F (WorkspaceBackupTest, NamesSortIntoTheOrderTheyWereTakenIn) {
    // Retention picks the oldest by sorting the names as text, so the names
    // have to be chronological as text - across a second boundary, which a
    // stamp without zero padding would not be.
    const auto early = backup_ok (A_MOMENT + 999);
    const auto late  = backup_ok (A_MOMENT + 1'000);
    EXPECT_LT (fs::path (early.path).filename ().string (),
    fs::path (late.path).filename ().string ());
}

// ============================================================================
// Retention
// ============================================================================

TEST_F (WorkspaceBackupTest, RetentionKeepsTheNewestSnapshots) {
    set_config ("maxBackupsRetained", 2);

    const auto oldest = backup_ok (A_MOMENT);
    backup_ok (A_MOMENT + 1'000);
    const auto third  = backup_ok (A_MOMENT + 2'000);
    const auto newest = backup_ok (A_MOMENT + 3'000);

    const auto names = snapshot_names ();
    ASSERT_EQ (names.size (), 2U);
    EXPECT_EQ (names[0], fs::path (third.path).filename ().string ());
    EXPECT_EQ (names[1], fs::path (newest.path).filename ().string ());
    EXPECT_FALSE (fs::exists (oldest.path));
}

TEST_F (WorkspaceBackupTest, RetentionReportsWhatItRemoved) {
    set_config ("maxBackupsRetained", 1);

    EXPECT_EQ (backup_ok (A_MOMENT).pruned, 0);
    EXPECT_EQ (backup_ok (A_MOMENT + 1'000).pruned, 1);
    EXPECT_EQ (backup_ok (A_MOMENT + 2'000).pruned, 1);
}

TEST_F (WorkspaceBackupTest, ZeroRetainsEverything) {
    set_config ("maxBackupsRetained", 0);

    for (int64_t offset = 0; offset < 4; ++offset) {
        backup_ok (A_MOMENT + (offset * 1'000));
    }
    EXPECT_EQ (snapshot_names ().size (), 4U);
}

TEST_F (WorkspaceBackupTest, LeavesFilesItDidNotWriteAlone) {
    set_config ("maxBackupsRetained", 1);

    backup_ok (A_MOMENT);
    // Dropped in after the directory exists, exactly as a user copying a
    // snapshot somewhere safe would leave things.
    const fs::path directory = db_->backups_directory ();
    const fs::path note      = directory / "why-I-kept-these.txt";
    const fs::path adopted   = directory / "monday-before-the-import.db";
    std::ofstream (note) << "keep me";
    std::ofstream (adopted) << "not a vayu- name";

    backup_ok (A_MOMENT + 1'000);
    backup_ok (A_MOMENT + 2'000);

    EXPECT_TRUE (fs::exists (note));
    EXPECT_TRUE (fs::exists (adopted));
    // One snapshot, plus the two files retention must not have counted.
    EXPECT_EQ (snapshot_names ().size (), 3U);
}

// ============================================================================
// The single-backup slot
// ============================================================================

TEST_F (WorkspaceBackupTest, RefusesASecondBackupWhileOneIsRunning) {
    vayu::db::Database::BackupSlot held (*db_);
    ASSERT_TRUE (held.held ());

    const auto refused = db_->backup_workspace (A_MOMENT);
    ASSERT_FALSE (refused.has_value ());
    EXPECT_TRUE (refused.error ().already_running);
    EXPECT_FALSE (refused.error ().message.empty ());
    // Refused means refused: nothing half-written was left behind.
    EXPECT_FALSE (fs::exists (db_->backups_directory ()));
}

TEST_F (WorkspaceBackupTest, ReleasesTheSlotSoTheNextBackupSucceeds) {
    {
        vayu::db::Database::BackupSlot held (*db_);
        EXPECT_TRUE (held.held ());
    }
    EXPECT_TRUE (db_->backup_workspace (A_MOMENT).has_value ());
    // And the slot a completed backup took is released too - without which a
    // user gets exactly one backup per engine process.
    EXPECT_TRUE (db_->backup_workspace (A_MOMENT + 1'000).has_value ());
}

// ============================================================================
// The route
// ============================================================================

TEST_F (WorkspaceBackupTest, RouteAnswersWithThePathSizeAndStamp) {
    create_collection ("Kept");

    auto [status, body] = routes::workspace_backup_response (*db_, A_MOMENT);
    ASSERT_EQ (status, 200) << body.dump ();
    const auto path = body.value ("path", std::string{});
    ASSERT_FALSE (path.empty ());
    EXPECT_TRUE (fs::exists (path)) << path;
    EXPECT_EQ (body.value ("sizeBytes", int64_t{ 0 }),
    static_cast<int64_t> (fs::file_size (path)));
    EXPECT_EQ (body.value ("createdAt", int64_t{ 0 }), A_MOMENT);
    EXPECT_EQ (body.value ("pruned", int64_t{ -1 }), 0);
}

TEST_F (WorkspaceBackupTest, RouteAnswers409WhileAnotherBackupIsRunning) {
    vayu::db::Database::BackupSlot held (*db_);
    ASSERT_TRUE (held.held ());

    auto [status, body] = routes::workspace_backup_response (*db_, A_MOMENT);
    EXPECT_EQ (status, 409) << body.dump ();
    EXPECT_EQ (error_field (body, "code"), "conflict") << body.dump ();
    EXPECT_FALSE (error_field (body, "message").empty ()) << body.dump ();
}

TEST_F (WorkspaceBackupTest, RouteRefusesAnInstantThatIsNotOne) {
    // A snapshot is named for the instant it was taken. Loudly refused rather
    // than defaulted to the wall clock, which would name the file something
    // untrue about when its contents are from.
    for (const int64_t bad : { int64_t{ 0 }, int64_t{ -1 } }) {
        auto [status, body] = routes::workspace_backup_response (*db_, bad);
        EXPECT_EQ (status, 500) << body.dump ();
        EXPECT_NE (error_field (body, "message").find (std::to_string (bad)), std::string::npos)
        << body.dump ();
    }
    EXPECT_FALSE (fs::exists (db_->backups_directory ()));
}

} // namespace
