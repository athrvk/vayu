/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/file_lock_test.cpp
 * @brief The single-instance lock: one holder per data directory, and on
 *        POSIX a guard that deleting `vayu.lock` does not release (#2422)
 *
 * A second holder is played by a second `acquire_file_lock` in this process:
 * `flock` conflicts between two open descriptions of one file whichever
 * process holds them, and Windows' share-0 open refuses a second handle the
 * same way, so no second engine has to be started.
 */

#include <filesystem>
#include <fstream>
#include <string>

#include <gtest/gtest.h>

#include "vayu/platform/platform.hpp"

#ifndef _WIN32
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#endif

namespace vayu::platform {
namespace {

namespace fs = std::filesystem;

class InstanceLockTest : public ::testing::Test {
    protected:
    void SetUp () override {
        // Per test and per process: ctest runs these in parallel.
        data_ = fs::temp_directory_path () /
        ("vayu-file-lock-" + std::to_string (get_process_id ()) + "-" +
        ::testing::UnitTest::GetInstance ()->current_test_info ()->name ());
        fs::remove_all (data_);
        fs::create_directories (data_);
        lock_path_ = (data_ / "vayu.lock").string ();
    }
    void TearDown () override {
        release_file_lock (first_);
        release_file_lock (second_);
        std::error_code ec;
        fs::remove_all (data_, ec);
    }
    fs::path data_;
    std::string lock_path_;
    LockHandle first_  = INVALID_LOCK_HANDLE;
    LockHandle second_ = INVALID_LOCK_HANDLE;
};

TEST_F (InstanceLockTest, ASecondHolderIsRefusedWhileTheFirstHoldsIt) {
    ASSERT_NE (acquire_file_lock (lock_path_, first_), LockAcquisition::Refused);
    ASSERT_TRUE (fs::exists (lock_path_));

    EXPECT_EQ (acquire_file_lock (lock_path_, second_), LockAcquisition::Refused);
    EXPECT_EQ (second_, INVALID_LOCK_HANDLE);
}

TEST_F (InstanceLockTest, ReleasingTheLockLetsTheNextHolderIn) {
    ASSERT_NE (acquire_file_lock (lock_path_, first_), LockAcquisition::Refused);
    release_file_lock (first_);
    EXPECT_EQ (first_, INVALID_LOCK_HANDLE);

    EXPECT_NE (acquire_file_lock (lock_path_, second_), LockAcquisition::Refused);
}

TEST_F (InstanceLockTest, TheHolderCanRecordItsPid) {
    ASSERT_NE (acquire_file_lock (lock_path_, first_), LockAcquisition::Refused);
    ASSERT_TRUE (write_pid_to_lock (first_));
    // Windows' share-0 handle refuses a reader while held.
    release_file_lock (first_);

    int pid = 0;
    ASSERT_TRUE (read_pid_from_lock (lock_path_, pid));
    EXPECT_EQ (pid, get_process_id ());
}

#ifndef _WIN32
// What a sidecar's stale-lock cleanup or a user's `rm` does to a live engine.
// A lock on the file alone lives on an inode the unlink orphans, and a
// newcomer's `O_CREAT` makes a fresh, unlocked one.
TEST_F (InstanceLockTest, UnlinkingTheLockFileDoesNotReleaseTheGuard) {
    ASSERT_EQ (acquire_file_lock (lock_path_, first_), LockAcquisition::Held)
    << "this filesystem cannot lock a directory, so the guard under test is "
       "not the one held";
    ASSERT_TRUE (fs::remove (lock_path_));

    EXPECT_EQ (acquire_file_lock (lock_path_, second_), LockAcquisition::Refused);
    // Refused at the directory, before the file is opened, so the newcomer
    // leaves no fresh lock file behind for anything to read a PID from.
    EXPECT_FALSE (fs::exists (lock_path_));
}

// An engine from before the directory lock takes only the file. A newcomer
// that wins the directory must still be refused there, and must not keep the
// directory it took on the way.
TEST_F (InstanceLockTest, AHolderOfTheFileAloneRefusesANewcomer) {
    std::ofstream (lock_path_) << "1\n";
    // POSIX declares `open` variadic; this is the older engine's own call.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    const int older = open (lock_path_.c_str (), O_RDWR | O_CLOEXEC);
    ASSERT_GE (older, 0);
    ASSERT_EQ (flock (older, LOCK_EX | LOCK_NB), 0);

    EXPECT_EQ (acquire_file_lock (lock_path_, first_), LockAcquisition::Refused);
    close (older);

    EXPECT_EQ (acquire_file_lock (lock_path_, second_), LockAcquisition::Held);
}
#else
TEST (InstanceLock, TheDirectoryGuardIsPosixOnly) {
    GTEST_SKIP () << "Windows holds the lock file with share mode 0, which "
                     "cannot be deleted while held";
}
#endif

} // namespace
} // namespace vayu::platform
