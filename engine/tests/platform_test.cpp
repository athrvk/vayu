/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/platform_test.cpp
 * @brief Thread scheduling primitives (issue #1667): affinity, priority,
 *        precise sleep, and the pure pinning policy they are driven by.
 *
 * `pin_current_thread` and `raise_current_thread_priority` are best-effort by
 * contract (see the doc comments in platform.hpp) - a CI container commonly
 * denies both, and a future image might grant them, so per this repo's rule
 * that a test must never assert the host platform, these assert only that the
 * call returns a `bool` without crashing and that the thread is still alive
 * and usable afterward, never which value it returns.
 */

#include <chrono>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "source_scan.hpp"
#include "vayu/core/worker_count.hpp"
#include "vayu/db/database.hpp"
#include "vayu/platform/platform.hpp"

#ifndef _WIN32
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace vayu::platform {
namespace {

// ============================================================================
// worker_cpu_index - pure policy, no OS call
// ============================================================================

TEST (WorkerCpuIndex, NoHeadroomLeavesEveryWorkerUnpinned) {
    // num_workers == num_cpus: the boundary itself, not just "over".
    EXPECT_EQ (vayu::core::worker_cpu_index (0, 4, 4), std::nullopt);
    // num_workers > num_cpus.
    EXPECT_EQ (vayu::core::worker_cpu_index (0, 8, 4), std::nullopt);
}

TEST (WorkerCpuIndex, ZeroCpusIsAlwaysUnpinned) {
    EXPECT_EQ (vayu::core::worker_cpu_index (0, 0, 0), std::nullopt);
}

TEST (WorkerCpuIndex, HeadroomPinsToIndexPlusOneLeavingCpuZeroFree) {
    EXPECT_EQ (vayu::core::worker_cpu_index (0, 2, 8), 1u);
    EXPECT_EQ (vayu::core::worker_cpu_index (1, 2, 8), 2u);
    EXPECT_EQ (vayu::core::worker_cpu_index (5, 2, 8), 6u);
}

// The boundary case a mutation of `>=` to `>` in worker_cpu_index would flip:
// num_workers == num_cpus must stay unpinned (no headroom), while one fewer
// worker than CPUs must pin. Verified by actually flipping the operator,
// confirming this fails, and reverting (this repo's mutation-check rule).
TEST (WorkerCpuIndex, BoundaryIsInclusiveNotExclusive) {
    // num_workers == num_cpus must stay unpinned; num_workers == num_cpus - 1
    // must not.
    EXPECT_EQ (vayu::core::worker_cpu_index (0, 4, 4), std::nullopt);
    EXPECT_NE (vayu::core::worker_cpu_index (0, 3, 4), std::nullopt);
}

// ============================================================================
// pin_current_thread - real OS call, outcome-agnostic
// ============================================================================

TEST (ThreadScheduling, PinCurrentThreadReturnsWithoutCrashing) {
    const bool accepted = pin_current_thread (0);
    // Whichever the OS answers is valid; the thread must still be usable.
    static_cast<void> (accepted);
    int sum = 0;
    for (int i = 0; i < 1000; ++i) {
        sum += i;
    }
    EXPECT_EQ (sum, 499500);
}

TEST (ThreadScheduling, PinCurrentThreadRefusesAnOutOfRangeCpu) {
    const unsigned absurd = std::thread::hardware_concurrency () + 100;
    EXPECT_FALSE (pin_current_thread (absurd));
}

// ============================================================================
// raise_current_thread_priority - real OS call, outcome-agnostic
// ============================================================================

TEST (ThreadScheduling, RaiseCurrentThreadPriorityReturnsWithoutCrashing) {
    const bool accepted = raise_current_thread_priority ();
    static_cast<void> (accepted);
    int sum = 0;
    for (int i = 0; i < 1000; ++i) {
        sum += i;
    }
    EXPECT_EQ (sum, 499500);
}

// ============================================================================
// sleep_until_precise - a loose bound only (CI runners are shared, 2-4 vCPUs)
// ============================================================================

TEST (ThreadScheduling, SleepUntilPreciseNeverReturnsBeforeTheDeadline) {
    const auto deadline =
    std::chrono::steady_clock::now () + std::chrono::milliseconds (20);
    sleep_until_precise (deadline);
    EXPECT_GE (std::chrono::steady_clock::now (), deadline);
}

// Generous margin, deliberately: this asserts the wait actually happened and
// did not fall through to a no-op, never a tight bound a loaded CI runner
// could flake on.
TEST (ThreadScheduling, SleepUntilPreciseStaysWithinAGenerousMargin) {
    const auto start    = std::chrono::steady_clock::now ();
    const auto deadline = start + std::chrono::milliseconds (20);
    sleep_until_precise (deadline);
    const auto elapsed = std::chrono::steady_clock::now () - start;
    EXPECT_LT (elapsed, std::chrono::milliseconds (500));
}

// A deadline already in the past returns immediately rather than sleeping a
// full cycle - the platform legs all guard `deadline <= now` themselves.
TEST (ThreadScheduling, SleepUntilPreciseReturnsImmediatelyForAPastDeadline) {
    const auto start    = std::chrono::steady_clock::now ();
    const auto deadline = start - std::chrono::milliseconds (50);
    sleep_until_precise (deadline);
    const auto elapsed = std::chrono::steady_clock::now () - start;
    EXPECT_LT (elapsed, std::chrono::milliseconds (200));
}

// ============================================================================
// Owner-only data directory (#1781)
//
// The mode bits are a POSIX concept: the Windows leg applies a DACL instead,
// which these tests do not read back, so they skip there with a reason.
// ============================================================================

#ifndef _WIN32
namespace {
namespace fs = std::filesystem;

constexpr auto OWNER_ONLY_DIRECTORY = fs::perms::owner_all;
constexpr auto OWNER_ONLY_FILE = fs::perms::owner_read | fs::perms::owner_write;

/// A scratch directory removed on exit, and the process umask restored on
/// exit, because `restrict_new_files_to_owner` changes it for the whole test
/// binary.
class PrivateDirectoryTest : public ::testing::Test {
    protected:
    void SetUp () override {
        saved_umask_ = umask (022);
        // Per test and per process: ctest runs these in parallel, and a shared
        // directory lets one test's TearDown delete another's files.
        root_ = fs::temp_directory_path () /
        ("vayu-private-dir-" + std::to_string (getpid ()) + "-" +
        ::testing::UnitTest::GetInstance ()->current_test_info ()->name ());
        fs::remove_all (root_);
        fs::create_directories (root_);
    }
    void TearDown () override {
        umask (saved_umask_);
        fs::remove_all (root_);
    }
    [[nodiscard]] static fs::perms permissions_of (const fs::path& path) {
        return fs::status (path).permissions () & fs::perms::mask;
    }
    fs::path root_;
    mode_t saved_umask_ = 0;
};

TEST_F (PrivateDirectoryTest, ACreatedDirectoryIsOwnerOnly) {
    const auto dir = (root_ / "data").string ();
    ensure_private_directory (dir);
    EXPECT_EQ (permissions_of (dir), OWNER_ONLY_DIRECTORY);
}

// An engine before this change made 0755 directories; an upgrade must close
// them rather than only protect new installs.
TEST_F (PrivateDirectoryTest, AnExistingOpenDirectoryIsTightened) {
    const auto dir = root_ / "data";
    fs::create_directory (dir);
    fs::permissions (dir, fs::perms::all & ~fs::perms::others_write);
    ASSERT_NE (permissions_of (dir), OWNER_ONLY_DIRECTORY);

    ensure_private_directory (dir.string ());
    EXPECT_EQ (permissions_of (dir), OWNER_ONLY_DIRECTORY);
}

TEST_F (PrivateDirectoryTest, APathThatIsAFileIsRefused) {
    const auto file = root_ / "not-a-directory";
    std::ofstream (file) << "x";
    EXPECT_THROW (ensure_private_directory (file.string ()), std::runtime_error);
}

TEST_F (PrivateDirectoryTest, FilesCreatedAfterRestrictingAreOwnerOnly) {
    restrict_new_files_to_owner ();
    const auto file = root_ / "created.log";
    std::ofstream (file) << "x";
    EXPECT_EQ (permissions_of (file), OWNER_ONLY_FILE);
}

// The acceptance criterion is about the database, not about a bare ofstream:
// SQLite opens the file itself, so this proves the mask reaches it.
TEST_F (PrivateDirectoryTest, TheDatabaseFileIsOwnerOnly) {
    restrict_new_files_to_owner ();
    const auto db_path = (root_ / "vayu.db").string ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        EXPECT_EQ (permissions_of (db_path), OWNER_ONLY_FILE);
    }
}

// Mutation check: without the call the same file is world-readable.
TEST_F (PrivateDirectoryTest, WithoutRestrictingAFileFollowsTheInheritedUmask) {
    const auto file = root_ / "created.log";
    std::ofstream (file) << "x";
    EXPECT_NE (permissions_of (file), OWNER_ONLY_FILE);
}

// ----------------------------------------------------------------------------
// prepare_data_directory (#1802): a data directory an older engine left open,
// files included, is closed on the next start. `SetUp` runs under umask 022,
// which is what made those files 0644 in the first place.
// ----------------------------------------------------------------------------

class PrepareDataDirectoryTest : public PrivateDirectoryTest {
    protected:
    /// An open (0755 / 0644) layout, the way an engine before #1781 left it.
    void SetUp () override {
        PrivateDirectoryTest::SetUp ();
        data_ = root_ / "data";
        for (const auto& dir : directories ()) {
            fs::create_directories (dir);
            fs::permissions (dir,
            fs::perms::owner_all | fs::perms::group_read | fs::perms::group_exec |
            fs::perms::others_read | fs::perms::others_exec);
        }
        for (const auto& file : files ()) {
            write_open (file);
        }
    }
    [[nodiscard]] std::vector<fs::path> directories () const {
        return { data_, data_ / "logs", data_ / "db", data_ / "db" / "backups" };
    }
    [[nodiscard]] std::vector<fs::path> files () const {
        return { data_ / "vayu.lock", data_ / "db" / "vayu.db",
            data_ / "db" / "vayu.db-wal", data_ / "db" / "vayu.db-shm",
            data_ / "db" / "vayu.db.bak", data_ / "db" / "ca-bundle.pem",
            data_ / "logs" / "engine_20260101_000000.log",
            data_ / "db" / "backups" / "vayu-20260101-000000-000.db" };
    }
    static void write_open (const fs::path& file) {
        std::ofstream (file) << "x";
        fs::permissions (file,
        fs::perms::owner_read | fs::perms::owner_write | fs::perms::group_read |
        fs::perms::others_read);
    }
    fs::path data_;
};

TEST_F (PrepareDataDirectoryTest, EveryDirectoryAndEngineFileIsTightened) {
    for (const auto& dir : directories ()) {
        ASSERT_NE (permissions_of (dir), OWNER_ONLY_DIRECTORY) << dir;
    }
    for (const auto& file : files ()) {
        ASSERT_NE (permissions_of (file), OWNER_ONLY_FILE) << file;
    }

    prepare_data_directory (data_.string ());

    for (const auto& dir : directories ()) {
        EXPECT_EQ (permissions_of (dir), OWNER_ONLY_DIRECTORY) << dir;
    }
    for (const auto& file : files ()) {
        EXPECT_EQ (permissions_of (file), OWNER_ONLY_FILE) << file;
    }
}

TEST_F (PrepareDataDirectoryTest, ASymlinkIsNotFollowed) {
    // A link the engine's own directories could hold, pointing at a file the
    // user owns elsewhere: chmod follows links, so a pass that used it would
    // close the target.
    const auto target = root_ / "elsewhere.txt";
    write_open (target);
    fs::create_symlink (target, data_ / "db" / "vayu.db.pre-upgrade.bak");
    fs::create_symlink (target, data_ / "logs" / "linked.log");

    prepare_data_directory (data_.string ());

    EXPECT_NE (permissions_of (target), OWNER_ONLY_FILE);
    EXPECT_TRUE (fs::is_symlink (data_ / "logs" / "linked.log"));
}

TEST_F (PrepareDataDirectoryTest, ASymlinkedBackupsDirectoryIsNotFollowed) {
    const auto elsewhere = root_ / "elsewhere";
    fs::create_directory (elsewhere);
    write_open (elsewhere / "kept.txt");
    fs::permissions (elsewhere,
    fs::perms::owner_all | fs::perms::others_read | fs::perms::others_exec);
    fs::remove_all (data_ / "db" / "backups");
    fs::create_directory_symlink (elsewhere, data_ / "db" / "backups");

    prepare_data_directory (data_.string ());

    EXPECT_NE (permissions_of (elsewhere), OWNER_ONLY_DIRECTORY);
    EXPECT_NE (permissions_of (elsewhere / "kept.txt"), OWNER_ONLY_FILE);
}

// `--data-dir` can name a directory that holds the user's own files; only the
// engine's allowlist is touched, whatever else sits beside or inside it.
TEST_F (PrepareDataDirectoryTest, AFileTheEngineDoesNotOwnIsLeftAlone) {
    const auto beside = data_ / "notes.txt";
    const auto nested = data_ / "db" / "backups" / "sub";
    const auto deeper = nested / "inner.db";
    write_open (beside);
    fs::create_directory (nested);
    write_open (deeper);

    prepare_data_directory (data_.string ());

    EXPECT_NE (permissions_of (beside), OWNER_ONLY_FILE);
    EXPECT_NE (permissions_of (deeper), OWNER_ONLY_FILE);
    EXPECT_NE (permissions_of (nested), OWNER_ONLY_DIRECTORY);
}

TEST_F (PrepareDataDirectoryTest, AFileAlreadyOwnerOnlyIsUnchanged) {
    const auto database = data_ / "db" / "vayu.db";
    const auto readonly = data_ / "db" / "vayu.db.bak";
    fs::permissions (database, OWNER_ONLY_FILE, fs::perm_options::replace);
    fs::permissions (readonly, fs::perms::owner_read, fs::perm_options::replace);

    prepare_data_directory (data_.string ());

    EXPECT_EQ (permissions_of (database), OWNER_ONLY_FILE);
    // Tightens, never widens: a 0400 file stays 0400.
    EXPECT_EQ (permissions_of (readonly), fs::perms::owner_read);
}

TEST_F (PrepareDataDirectoryTest, ALayoutThatDoesNotExistYetIsCreatedOwnerOnly) {
    const auto fresh = root_ / "fresh";

    prepare_data_directory (fresh.string ());

    EXPECT_EQ (permissions_of (fresh), OWNER_ONLY_DIRECTORY);
    EXPECT_EQ (permissions_of (fresh / "logs"), OWNER_ONLY_DIRECTORY);
    EXPECT_EQ (permissions_of (fresh / "db"), OWNER_ONLY_DIRECTORY);
    EXPECT_FALSE (fs::exists (fresh / "db" / "backups"));
}

} // namespace
#else
TEST (PrivateDirectory, ModeBitsAreNotReadableOnWindows) {
    GTEST_SKIP () << "owner-only is a protected DACL on Windows, not mode bits";
}
#endif

// A source scan, because a daemon that never calls the function passes every
// behavioural test above.
TEST (DaemonStartup, PreparesTheDataDirectoryThroughOnePlatformCall) {
    const std::filesystem::path daemon =
    std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "src" / "daemon.cpp";
    const std::string code = tests::strip_comments (tests::read_source (daemon));

    ASSERT_GT (code.size (), 1000u) << "read " << daemon.string () << " as empty";
    EXPECT_TRUE (tests::names_call (code, "prepare_data_directory"))
    << "daemon.cpp must call prepare_data_directory before the logger and "
       "database open";
    EXPECT_TRUE (tests::names_call (
    tests::strip_comments (
    "// prepare_data_directory (x);\nprepare_data_directory (data_dir);\n"),
    "prepare_data_directory"));
    EXPECT_FALSE (tests::names_call (
    tests::strip_comments ("// prepare_data_directory (x);\n"), "prepare_data_directory"));
}

} // namespace
} // namespace vayu::platform
