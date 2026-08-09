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

#include <filesystem>
#include <string>
#include <system_error>

namespace vayu::tests {

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
