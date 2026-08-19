#pragma once

/**
 * @file temp_database.hpp
 * @brief The scratch-database file set, in one place.
 *
 * A `vayu::db::Database` opened at `p` writes `p` plus SQLite's `-wal` / `-shm`
 * sidecars, and its constructor copies all three to a `p.bak` backup at open
 * time (`Database::Database`, `engine/src/db/database.cpp`) - so a test that
 * merely *opens* one has already written a second trio.
 *
 * That set used to be hand-copied into every fixture's `cleanup()`, and eight
 * of the twenty-two copies were missing `.bak` (#379, #413) - each one leaking
 * a file per run, one of which reached `master` as a tracked artifact. The set
 * lives here now so a fixture cannot get it wrong by copying a neighbour that
 * already had.
 */

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <system_error>

namespace vayu::tests {

/**
 * @brief Whether the per-process scratch directory below has been switched off.
 *
 * Set `VAYU_TEST_NO_SCRATCH_ISOLATION` (to anything) to skip it. **No test
 * preset sets it any more**: the Windows presets did while they ran the suite
 * serially - one process has nothing to isolate from - and they run `-j4` since
 * #805 phase 5, with the database tests held apart by a CTest `RESOURCE_LOCK`
 * rather than by running the whole suite one test at a time. The opt-out
 * remains for a deliberately serial run (`ctest -j1`), where the directories
 * are pure cost, and as the one-line way back to the old behaviour if the
 * Windows measurement ever turns around again.
 *
 * Presence, not value, so this cannot be got wrong by writing `=0` and meaning
 * "off". MSVC deprecates `std::getenv` in favour of `_dupenv_s` (C4996) and
 * this suite is built `/W4 /WX`, so the deprecation is followed rather than
 * suppressed - the same shape, and for the same reason, as `env_is_set` in
 * `script_types_test.cpp`.
 */
inline bool scratch_isolation_disabled () {
#ifdef _WIN32
    char* value   = nullptr;
    size_t length = 0;
    if (_dupenv_s (&value, &length, "VAYU_TEST_NO_SCRATCH_ISOLATION") != 0 || value == nullptr) {
        return false;
    }
    std::free (value);
    return true;
#else
    return std::getenv ("VAYU_TEST_NO_SCRATCH_ISOLATION") != nullptr;
#endif
}

/**
 * Creates a fresh, process-private scratch directory beneath the current
 * working directory and moves into it.
 *
 * Every fixture opens its scratch `Database` by a *relative* filename
 * (`test_*.db`), so its files - the SQLite trio and the open-time `.bak` backup
 * `remove_database_files` above lists - land in whatever directory the process
 * runs from. Serially that is safe (each fixture cleans up around itself), but
 * `ctest -j` schedules per *test*: two tests of one fixture, running at once,
 * share that filename and delete each other's database mid-run.
 *
 * `gtest_discover_tests` registers one CTest test per gtest test, each invoking
 * the binary in its own process, and CTest never runs the same test twice at
 * once - so a directory that is unique per *process* is unique per concurrently
 * scheduled *test*. Entering one here, once, isolates every relative path the
 * process then writes without touching a single fixture, and keeps the
 * bare-filename semantics fixtures and a real CLI invocation both rely on (a
 * database opened by name sits in the working directory).
 *
 * Returns the directory so the caller can remove it on exit. Directory creation
 * is atomic, so two processes that derive the same candidate name do not both
 * win it - the loser retries. Throws if no directory can be created, because a
 * silent fall-back to a shared directory is exactly the collision this prevents.
 */
inline std::filesystem::path enter_process_scratch_dir () {
    namespace fs = std::filesystem;
    // Deliberately the *working* directory, not `temp_directory_path()`: these
    // files already lived here (the build directory under `ctest --preset`),
    // and on a Windows CI runner the workspace and the system temp sit on
    // different volumes - the workspace on the fast ephemeral disk, the temp on
    // the OS one. Sending 2000 processes' worth of small SQLite writes across
    // that boundary made the Windows ctest leg several times slower while Linux
    // and macOS, which have no such split, showed nothing.
    const fs::path base = fs::current_path ();
    for (unsigned attempt = 0; attempt < 10000; ++attempt) {
        const auto ticks =
        std::chrono::high_resolution_clock::now ().time_since_epoch ().count ();
        const fs::path candidate = base /
        ("vayu-tests-" + std::to_string (ticks) + "-" + std::to_string (attempt));
        std::error_code ec;
        if (fs::create_directory (candidate, ec) && !ec) {
            fs::current_path (candidate, ec);
            if (ec) {
                throw std::runtime_error ("cannot enter scratch directory " +
                candidate.string () + ": " + ec.message ());
            }
            return candidate;
        }
    }
    throw std::runtime_error (
    "cannot create a unique scratch directory under " + base.string ());
}

/**
 * Removes every file a `vayu::db::Database` opened at @p path can leave behind.
 *
 * Absent files are not an error, so this is equally usable from `SetUp` (before
 * anything exists) and `TearDown`. Filesystem errors are swallowed rather than
 * thrown: this runs on teardown paths, where an exception would abort the
 * binary instead of failing one test.
 *
 * Close the `Database` first - on Windows an open handle blocks the delete.
 */
inline void remove_database_files (const std::string& path) {
    // The backup is a full copy, sidecars included, so the set is the SQLite
    // trio twice over - `path` and `path.bak`. The hand-copied lists this
    // replaced all stopped at a bare `.bak`, which leaves `.bak-wal` /
    // `.bak-shm` behind whenever a WAL exists at open time.
    for (const std::string& base : { path, path + ".bak" }) {
        for (const char* suffix : { "", "-wal", "-shm" }) {
            std::error_code ec;
            std::filesystem::remove (base + suffix, ec);
        }
    }
}

} // namespace vayu::tests
