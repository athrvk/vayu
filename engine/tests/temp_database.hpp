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
#include <filesystem>
#include <stdexcept>
#include <string>
#include <system_error>

namespace vayu::tests {

/**
 * Creates a fresh, process-private scratch directory under the system temp
 * location and makes it the current working directory.
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
 * database opened by name sits in the working directory). It also moves the
 * scratch files out of the source/build tree entirely, which is the leak
 * `remove_database_files` and `.gitignore` were guarding against.
 *
 * Returns the directory so the caller can remove it on exit. Directory creation
 * is atomic, so two processes that derive the same candidate name do not both
 * win it - the loser retries. Throws if no directory can be created, because a
 * silent fall-back to a shared directory is exactly the collision this prevents.
 */
inline std::filesystem::path enter_process_scratch_dir () {
    namespace fs        = std::filesystem;
    const fs::path base = fs::temp_directory_path ();
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
