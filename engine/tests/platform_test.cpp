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
#include <thread>

#include <gtest/gtest.h>

#include "vayu/core/worker_count.hpp"
#include "vayu/db/database.hpp"
#include "vayu/platform/platform.hpp"

#ifndef _WIN32
#include <sys/stat.h>
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
        root_        = fs::temp_directory_path () / "vayu-private-dir-test";
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
} // namespace
#else
TEST (PrivateDirectory, ModeBitsAreNotReadableOnWindows) {
    GTEST_SKIP () << "owner-only is a protected DACL on Windows, not mode bits";
}
#endif

} // namespace
} // namespace vayu::platform
