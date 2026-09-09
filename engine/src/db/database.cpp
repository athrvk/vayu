/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file database.cpp
 * @brief Database construction, recovery-branch dispatch, locking and
 * transaction retry - the members `db_maintenance.cpp`'s repair passes and
 * the eight table-family units do not each need their own copy of (issue
 * #1614). Every other `Database::` member is defined in the family file
 * `database.hpp`'s section comments name.
 */

#include "database_impl.hpp"

#include <chrono>
#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <system_error>
#include <thread>

#include "vayu/db/recovery.hpp"
#include "vayu/utils/logger.hpp"

namespace fs = std::filesystem;

using namespace sqlite_orm;

namespace vayu::db {

Database::Database (const std::string& db_path) {
    // Refused outright, before anything else - a database written by a newer
    // engine is not corrupt, and letting it fall into the recovery branch
    // below would quarantine a perfectly good (newer) file and silently start
    // a fresh, empty one in its place: exactly the data loss issue #1514's
    // version gate exists to prevent. This call is deliberately not inside
    // `probe_database`'s try/catch: the exception must reach the daemon's own
    // startup failure path, naming both versions, rather than being read here
    // as "will not open" and handed to recovery.
    migrate_before_sync (db_path);

    fs::path db_file (db_path);
    fs::path backup_file = db_file;
    backup_file += ".bak";

    // Whether the database at `path` opens and carries this build's schema.
    //
    // The same probe answers for the main file and for the `.bak` beside it
    // (issue #984): the backup used to be restored on the strength of its
    // existence alone - "we assume the backup itself is valid" - so a torn copy
    // was written over the only other copy of the user's data. An
    // `integrity_check` pragma would answer a narrower question (pages, not
    // schema) and would not answer the one that matters here, which is whether
    // *this engine* can open the file it is about to commit to.
    auto probe_database = [] (const std::string& path) {
        try {
            // Ahead of `Impl`'s own construction, never after: `Impl`'s
            // constructor already opens a connection and sets
            // `journal_mode`, and `sync_schema ()` below is what would
            // `DROP COLUMN` the pre-cutover script columns before this
            // migration ever got to read them (issue #1514).
            migrate_before_sync (path);
            Impl probe (path);
            probe.storage.sync_schema ();
            return true;
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "db", "Database validation failed for " + path + ": " + e.what ());
            return false;
        }
    };

    // 1. Validate current database
    if (has_sqlite_header (db_file) && probe_database (db_path)) {
        // 2. The database is valid. Update the backup for *next* time - only
        // ever from a database that validated, so a bad one cannot overwrite a
        // good backup.
        vayu::utils::log_debug ("db", "Database validation successful. Updating backup...");
        copy_db_files (db_file, backup_file);
    } else {
        recover_database (db_file, backup_file, db_path, probe_database);
    }

    // 3. Final Initialization
    // At this point, we either have a valid original, a restored backup, or a fresh/corrupted file we must attempt to use.
    // Idempotent by this point in every reachable case (the branch above
    // already migrated whichever file `db_path` now holds), kept here too as
    // the same defence in depth every `sync_schema ()` call gets.
    migrate_before_sync (db_path);
    impl_ = std::make_unique<Impl> (db_path);
    // sync_schema might throw if restore failed or backup was also bad
    impl_->storage.sync_schema ();

    // 4. The recovery record this process reports. Read from the file rather
    // than kept from the branch above, so a marker written by an *earlier*
    // engine run that nothing polled still reaches a client - that survival is
    // the whole reason the fact is on disk instead of in a member.
    recovery_ = read_recovery_marker (db_path);
}

Database::~Database () = default;

const std::string& Database::path () const {
    return impl_->opened_file;
}

bool Database::owner_is_absent_locked (const std::optional<std::string>& owner_id) {
    if (!owner_id.has_value ()) {
        return false; // The tree root is not a missing owner.
    }
    auto owners =
    impl_->storage.get_all<Collection> (where (c (&Collection::id) == *owner_id));
    return owners.empty () || owners.front ().deleted_at.has_value ();
}

// The one place a caller can scope the DB mutex around more than a single call.
// Deliberately `std::function` rather than a template: the mutex lives behind
// the pImpl, and a header-inlined template would have to expose it.
void Database::with_lock (const std::function<void ()>& fn) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    fn ();
}

// ============================================================================
// Busy-retry helper - shared by the four write paths above
// ============================================================================

void Database::retry_on_busy (const char* what,
int attempts,
std::chrono::milliseconds base,
const std::function<void ()>& fn) {
    for (int attempt = 0; attempt < attempts; attempt++) {
        try {
            std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
            fn ();
            return; // Success
        } catch (const std::system_error& e) {
            std::string error_msg = e.what ();
            // Only SQLite busy/locked errors are retried; sqlite_orm surfaces
            // them as std::system_error with these substrings in what().
            const bool busy = error_msg.find ("database is locked") != std::string::npos ||
            error_msg.find ("SQLITE_BUSY") != std::string::npos;
            if (!busy) {
                throw; // Different error, rethrow immediately
            }
            if (attempt == attempts - 1) {
                // Busy persisted through every attempt - log and rethrow.
                vayu::utils::log_error ("db",
                std::string ("Failed to ") + what + " after " +
                std::to_string (attempts) + " attempts: " + error_msg);
                throw;
            }
            vayu::utils::log_debug ("db",
            std::string ("Database locked during ") + what + ", retrying in " +
            std::to_string (base.count () * (attempt + 1)) + "ms (attempt " +
            std::to_string (attempt + 1) + "/" + std::to_string (attempts) + ")");
        }
        // The lock_guard scope above has ended: we sleep *without* holding the
        // mutex so a busy retry never stalls other endpoints (/health, SSE,
        // the runs poll) that serialize on the same lock.
        std::this_thread::sleep_for (base * (attempt + 1));
    }
}

} // namespace vayu::db
