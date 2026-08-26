/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file logger_test.cpp
 * @brief The three bounds on the log directory (issue #985).
 *
 * Before this, the directory grew on three axes at once: a file per process
 * start that nothing deleted, a file sink that took DEBUG whatever the engine
 * was told, and no cap on how large one of those files could get. Each bound
 * is tested where it is enforced - retention in `prune_old_logs`, the level and
 * the rotation through the singleton, which is what actually writes.
 */

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <set>
#include <sstream>
#include <string>

#include <gtest/gtest.h>

#include "optional_assert.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/utils/logger.hpp"

namespace {

using vayu::utils::Logger;

namespace constants = vayu::core::constants;

/// A directory of its own per test, since the singleton under test keeps
/// writing into whichever one it was last initialised with.
class ScratchLogDir {
    public:
    ScratchLogDir () {
        static std::atomic<int> counter{ 0 };
        path_ = std::filesystem::temp_directory_path () /
        ("vayu-logger-test-" + std::to_string (counter.fetch_add (1)) + "-" +
        std::to_string (static_cast<unsigned long long> (std::hash<std::string>{}(
        ::testing::UnitTest::GetInstance ()->current_test_info ()->name ()))));
        std::filesystem::create_directories (path_);
    }

    ~ScratchLogDir () {
        // Best effort: the logger holds the newest file open for the life of
        // the process, and Windows refuses to remove an open file.
        std::error_code ignored;
        std::filesystem::remove_all (path_, ignored);
    }
    ScratchLogDir (const ScratchLogDir&)            = delete;
    ScratchLogDir& operator= (const ScratchLogDir&) = delete;
    ScratchLogDir (ScratchLogDir&&)                 = delete;
    ScratchLogDir& operator= (ScratchLogDir&&)      = delete;

    std::string string () const {
        return path_.string ();
    }
    const std::filesystem::path& path () const {
        return path_;
    }

    private:
    std::filesystem::path path_;
};

/// A log file as a start would have left it, named for @p stamp.
void write_log_file (const std::filesystem::path& dir,
const std::string& stamp,
const std::string& contents = "x") {
    std::ofstream out (dir / ("vayu_" + stamp + ".log"));
    out << contents;
}

std::set<std::string> names_in (const std::filesystem::path& dir) {
    std::set<std::string> names;
    for (const auto& entry : std::filesystem::directory_iterator (dir)) {
        names.insert (entry.path ().filename ().string ());
    }
    return names;
}

/// The file the logger is currently writing - the newest `vayu_*.log`.
std::filesystem::path newest_log (const std::filesystem::path& dir) {
    std::filesystem::path newest;
    for (const auto& entry : std::filesystem::directory_iterator (dir)) {
        const std::string name = entry.path ().filename ().string ();
        if (name.starts_with ("vayu_") && name.ends_with (".log") && entry.path () > newest) {
            newest = entry.path ();
        }
    }
    return newest;
}

std::string read_file (const std::filesystem::path& file) {
    std::ifstream in (file);
    std::stringstream buffer;
    buffer << in.rdbuf ();
    return buffer.str ();
}

// ---------------------------------------------------------------------------
// Retention: the axis that made the directory grow forever.
// ---------------------------------------------------------------------------

// Mutation-check: return before the loop in `prune_old_logs` and all fifteen
// files remain, which is the behaviour this issue was filed about.
TEST (LoggerRetentionTest, KeepsTheNewestNAndDeletesTheRestOldestFirst) {
    ScratchLogDir dir;
    for (int day = 1; day <= 15; ++day) {
        std::ostringstream stamp;
        stamp << "202608" << (day < 10 ? "0" : "") << day << "_120000";
        write_log_file (dir.path (), stamp.str ());
    }

    EXPECT_EQ (vayu::utils::prune_old_logs (dir.string (), 10), 5u);

    auto remaining = names_in (dir.path ());
    ASSERT_EQ (remaining.size (), 10u);
    EXPECT_EQ (remaining.count ("vayu_20260806_120000.log"), 1u)
    << "the tenth-newest file was deleted";
    EXPECT_EQ (remaining.count ("vayu_20260805_120000.log"), 0u)
    << "an older file survived, so the deletion is not oldest-first";
}

// The other half of the same rule: everything that is not a per-start log file
// is somebody else's, and a prune that took it would be a data loss bug rather
// than a retention policy. Mutation-check: drop the `starts_with`/`ends_with`
// guard and every file here disappears.
TEST (LoggerRetentionTest, NeverTouchesAFileItDoesNotName) {
    ScratchLogDir dir;
    std::ofstream (dir.path () / "notes.txt") << "keep";
    std::ofstream (dir.path () / "engine.log") << "keep";
    std::ofstream (dir.path () / "vayu_20260801_120000.log.bak") << "keep";
    std::filesystem::create_directories (dir.path () / "vayu_subdir.log");

    EXPECT_EQ (vayu::utils::prune_old_logs (dir.string (), 0), 0u);

    EXPECT_EQ (names_in (dir.path ()).size (), 4u);
}

// A pruned generation leaves nothing behind. Mutation-check: drop the `.1`
// removal and the rotated half outlives the file it rotated out of - a second,
// unbounded history under a naming scheme that has no room for one.
TEST (LoggerRetentionTest, TakesARotatedSiblingWithThePrunedFile) {
    ScratchLogDir dir;
    write_log_file (dir.path (), "20260801_120000");
    std::ofstream (dir.path () / "vayu_20260801_120000.log.1") << "rotated";
    write_log_file (dir.path (), "20260802_120000");

    EXPECT_EQ (vayu::utils::prune_old_logs (dir.string (), 1), 1u);

    EXPECT_EQ (names_in (dir.path ()), std::set<std::string>{ "vayu_20260802_120000.log" });
}

// Retention is applied by a start, which is the only moment anything runs it.
// The file this start opens is one of the N kept, not an N+1th beside them.
// Mutation-check: remove the `prune_old_logs` call from `Logger::init` and the
// directory keeps every file it was given plus the new one.
TEST (LoggerRetentionTest, AStartPrunesTheDirectoryItOpensInto) {
    ScratchLogDir dir;
    for (int index = 0; index < constants::logging::RETAINED_FILES + 5; ++index) {
        std::ostringstream stamp;
        stamp << "20250101_" << (index < 10 ? "00000" : "0000") << index;
        write_log_file (dir.path (), stamp.str ());
    }

    Logger::instance ().init (dir.string ());

    EXPECT_EQ (names_in (dir.path ()).size (),
    static_cast<size_t> (constants::logging::RETAINED_FILES));
    // The stamps above are all in 2025, so the file this start opened - stamped
    // now - sorts last and is one of the survivors.
    EXPECT_GT (newest_log (dir.path ()).filename ().string (), std::string ("vayu_2025"));
}

// ---------------------------------------------------------------------------
// Level: the file sink used to take DEBUG unconditionally.
// ---------------------------------------------------------------------------

TEST (LoggerLevelTest, ParsesEveryNameTheEnumHasAndRefusesAnythingElse) {
    EXPECT_EQ (vayu::utils::parse_log_level ("debug"), Logger::Level::DEBUG);
    EXPECT_EQ (vayu::utils::parse_log_level ("INFO"), Logger::Level::INFO);
    EXPECT_EQ (vayu::utils::parse_log_level ("Warn"), Logger::Level::WARNING);
    EXPECT_EQ (vayu::utils::parse_log_level ("warning"), Logger::Level::WARNING);
    EXPECT_EQ (vayu::utils::parse_log_level ("error"), Logger::Level::ERROR);

    // A refusal rather than a silent fall back to DEBUG: the daemon reports the
    // unusable value and keeps the default, which it can only do if told.
    EXPECT_FALSE (vayu::utils::parse_log_level ("trace").has_value ());
    EXPECT_FALSE (vayu::utils::parse_log_level ("").has_value ());
}

// Mutation-check: drop the `level >= file_level_` guard in `Logger::log` and
// the two lines below it land in the file, which is what `logLevel` exists to
// stop.
TEST (LoggerLevelTest, TheFileTakesOnlyWhatTheConfiguredLevelAllows) {
    ScratchLogDir dir;
    Logger::instance ().init (dir.string ());
    Logger::instance ().set_max_file_bytes (0);
    Logger::instance ().set_file_level (Logger::Level::WARNING);

    Logger::instance ().debug ("a debug line");
    Logger::instance ().info ("an info line");
    Logger::instance ().warning ("a warning line");
    Logger::instance ().error ("an error line");
    Logger::instance ().flush ();

    const std::string written = read_file (newest_log (dir.path ()));
    EXPECT_EQ (written.find ("a debug line"), std::string::npos) << written;
    EXPECT_EQ (written.find ("an info line"), std::string::npos) << written;
    EXPECT_NE (written.find ("a warning line"), std::string::npos) << written;
    EXPECT_NE (written.find ("an error line"), std::string::npos) << written;
}

// The default is what it always was, so an install that configures nothing logs
// exactly what it logged before.
TEST (LoggerLevelTest, TheDefaultLevelStillTakesDebug) {
    ScratchLogDir dir;
    Logger::instance ().init (dir.string ());
    Logger::instance ().set_max_file_bytes (0);
    auto default_level = vayu::utils::parse_log_level (constants::logging::DEFAULT_LEVEL);
    ASSERT_HAS_VALUE (default_level) << "the seeded default names no level";
    Logger::instance ().set_file_level (*default_level);

    Logger::instance ().debug ("a debug line");
    Logger::instance ().flush ();

    EXPECT_NE (read_file (newest_log (dir.path ())).find ("a debug line"), std::string::npos);
}

// ---------------------------------------------------------------------------
// Size: one file could grow until the disk objected.
// ---------------------------------------------------------------------------

// Mutation-check: drop the `rotate_locked` call and no `.1` is ever written,
// while the open file grows past the cap it was given.
TEST (LoggerRotationTest, RotatesOnceAtTheCapAndKeepsWriting) {
    ScratchLogDir dir;
    Logger::instance ().init (dir.string ());
    Logger::instance ().set_file_level (Logger::Level::DEBUG);
    constexpr int64_t CAP = 2048;
    Logger::instance ().set_max_file_bytes (CAP);

    const std::filesystem::path active = newest_log (dir.path ());
    for (int line = 0; line < 200; ++line) {
        Logger::instance ().info (
        "a line long enough to reach the cap quickly " + std::to_string (line));
    }
    Logger::instance ().flush ();

    const std::filesystem::path rotated = active.string () + ".1";
    ASSERT_TRUE (std::filesystem::exists (rotated))
    << "the cap was never enforced - nothing rotated";
    EXPECT_LE (static_cast<int64_t> (std::filesystem::file_size (active)), CAP)
    << "the live file is past the cap it was given";
    EXPECT_NE (
    read_file (active).find ("a line long enough to reach the cap quickly 199"),
    std::string::npos)
    << "writing did not continue in the new file after the rotation";
}

// 0 is the documented escape hatch, and the entry's own minimum. Mutation-check:
// make the cap check `max_file_bytes_ >= 0` and this rotates on the first line.
TEST (LoggerRotationTest, ZeroMeansUnlimited) {
    ScratchLogDir dir;
    Logger::instance ().init (dir.string ());
    Logger::instance ().set_file_level (Logger::Level::DEBUG);
    Logger::instance ().set_max_file_bytes (0);

    const std::filesystem::path active = newest_log (dir.path ());
    for (int line = 0; line < 200; ++line) {
        Logger::instance ().info (
        "a line long enough to reach a small cap " + std::to_string (line));
    }
    Logger::instance ().flush ();

    EXPECT_FALSE (std::filesystem::exists (active.string () + ".1"));
    EXPECT_GT (std::filesystem::file_size (active), 2048u);
}

} // namespace
