/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/// Database construction, recovery-branch dispatch, locking and transaction
/// retry: what `db_maintenance.cpp`'s repair passes and the eight table-family
/// units would otherwise each copy (#1614). Every other `Database::` member is
/// defined in the family file `database.hpp`'s section comments name.

#include "database_impl.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>

#include "vayu/db/recovery.hpp"
#include "vayu/utils/logger.hpp"

namespace fs = std::filesystem;

using namespace sqlite_orm;

namespace vayu::db {

Database::Database (const std::string& db_path)
: Database (db_path,
  std::chrono::milliseconds (vayu::core::constants::database::BUSY_TIMEOUT_MS)) {
}

Database::Database (const std::string& db_path, std::chrono::milliseconds startup_busy_timeout) {
    const auto opened_at = fs::file_time_type::clock::now ();
    // Refused outright, before anything else: a database written by a newer
    // engine is not corrupt, and the recovery branch below would quarantine the
    // good newer file and silently start an empty one, the data loss #1514's
    // version gate prevents. Deliberately outside `probe_database`'s try/catch,
    // so the exception reaches the daemon's startup failure path naming both
    // versions instead of being read as corruption. The one call that copies
    // the workspace into `backups/` before migrating it (#2426).
    const bool opened_at_current_schema =
    migrate_before_sync (db_path, startup_busy_timeout, PreMigrationSnapshot::Take);

    fs::path db_file (db_path);
    fs::path backup_file = db_file;
    backup_file += ".bak";

    const auto probe = [startup_busy_timeout] (const std::string& path) {
        return probe_database (path, startup_busy_timeout);
    };

    // 1. Validate current database. A file SQLite would not even recognise
    // is corrupt without asking it (`has_sqlite_header` says why).
    const ProbeResult found = has_sqlite_header (db_file) ?
    probe (db_path) :
    ProbeResult{ ProbeResult::Verdict::Corrupt, 0, "no SQLite header" };
    // Not corrupt, only not examinable: refused the way the version gate
    // refuses, with every file left as it was (issue #2420).
    if (found.verdict == ProbeResult::Verdict::Unavailable) {
        throw std::runtime_error (unavailable_database_message (db_path, found));
    }
    const bool validated = found.verdict == ProbeResult::Verdict::Valid;
    if (validated) {
        // 2. The database is valid, so the backup for *next* time may be
        //    refreshed from it, only ever from a validated database, so a bad
        //    one cannot overwrite a good backup. Not here, though: the copy is
        //    O(database size) and this runs before the engine listens
        //    (measured: 177 ms warm, 1.1 s cold on a 280 MB workspace, every
        //    start). `start_recovery_backup_refresh` takes it once the listener
        //    is up, as a consistent snapshot rather than a file copy, and
        //    `refresh_recovery_backup_on_shutdown` again at a clean stop.
        vayu::utils::log_debug ("db", "Database validation successful");
    } else {
        recover_database (db_file, backup_file, db_path, probe);
    }

    // 3. Final initialization: a valid original, a restored backup, or a fresh
    //    or corrupted file we must attempt to use. Idempotent by now in every
    //    reachable case (the branch above migrated whichever file `db_path`
    //    holds), kept as the defence in depth every `sync_schema ()` call gets.
    //    No copy: the one file it can still stamp is the empty schema a first
    //    start's probe created.
    migrate_before_sync (db_path, startup_busy_timeout, PreMigrationSnapshot::Skip);
    impl_ = std::make_unique<Impl> (db_path, startup_busy_timeout);
    // sync_schema might throw if restore failed or backup was also bad
    impl_->storage.sync_schema ();
    impl_->recovery_backup_due      = validated;
    impl_->opened_at_current_schema = opened_at_current_schema;
    impl_->opened_at                = opened_at;

    // 4. The recovery record this process reports, read from the file, not kept
    //    from the branch above, so a marker an *earlier* run wrote that nothing
    //    polled still reaches a client: the reason the fact is on disk, not in
    //    a member.
    recovery_ = read_recovery_marker (db_path);
}

Database::~Database () {
    // Before `impl_` goes: the refresh thread copies through a connection of
    // its own but reads `impl_` for its paths and its cancellation state.
    finish_recovery_backup_refresh ();
}

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

// The one place a caller can scope the DB mutex around more than one call.
// `std::function`, not a template: the mutex is behind the pImpl, and a
// header-inlined template would expose it.
void Database::with_lock (const std::function<void ()>& fn) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    fn ();
}

// ============================================================================
// Busy-retry helper - every retried write in the db_*.cpp files goes through it
// ============================================================================

namespace {
// Where an unbounded retry's backoff stops growing: base * 10, one second for
// the 100ms base every caller passes.
constexpr int64_t MAX_BACKOFF_STEPS = 10;

// Only SQLite busy/locked errors are retried; sqlite_orm surfaces them as
// std::system_error with these substrings in what().
bool is_busy_error (const std::string& message) {
    return message.find ("database is locked") != std::string::npos ||
    message.find ("SQLITE_BUSY") != std::string::npos;
}

// Debug while a bounded retry, or an unbounded one's backoff, is still growing;
// a warning per retry once an unbounded one has waited out the growth, since a
// write still busy then is one an operator should hear about.
void log_busy_retry (const char* what,
int64_t attempt,
int attempts,
std::chrono::milliseconds delay,
bool unbounded) {
    const std::string message = std::string ("Database locked during ") + what +
    ", retrying in " + std::to_string (delay.count ()) + "ms (attempt " +
    std::to_string (attempt) +
    (unbounded ? ", until it lands)" : "/" + std::to_string (attempts) + ")");
    if (unbounded && attempt >= MAX_BACKOFF_STEPS) {
        vayu::utils::log_warning ("db", message);
    } else {
        vayu::utils::log_debug ("db", message);
    }
}
} // namespace

void Database::retry_on_busy (const char* what,
int attempts,
std::chrono::milliseconds base,
const std::function<void ()>& fn) {
    const bool unbounded = attempts == RETRY_UNTIL_LANDED;
    for (int64_t attempt = 1;; ++attempt) {
        try {
            std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
            fn ();
            return; // Success
        } catch (const std::system_error& e) {
            const std::string error_msg = e.what ();
            if (!is_busy_error (error_msg)) {
                throw; // Different error, rethrow immediately
            }
            if (!unbounded && attempt >= attempts) {
                // Busy persisted through every attempt - log and rethrow.
                vayu::utils::log_error ("db",
                std::string ("Failed to ") + what + " after " +
                std::to_string (attempts) + " attempts: " + error_msg);
                throw;
            }
        }
        // The lock_guard scope has ended: the sleep holds no mutex, so a busy
        // retry never stalls the endpoints (/health, SSE, the runs poll)
        // serialized on the same lock.
        const auto delay = base * std::min (attempt, MAX_BACKOFF_STEPS);
        log_busy_retry (what, attempt, attempts, delay, unbounded);
        std::this_thread::sleep_for (delay);
    }
}

} // namespace vayu::db
