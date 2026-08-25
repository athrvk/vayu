#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db/recovery.hpp
 * @brief The startup recovery marker - what `Database`'s constructor did to the
 *        user's data, written where it outlives the data (issue #922).
 *
 * `Database::Database` validates the database at startup and, when it cannot be
 * opened and no backup restores it, moves it aside so the daemon starts rather
 * than crash-looping. That is the right call and the whole record of it used to
 * be two lines in the engine log: every collection, request, environment,
 * example, spec and run the user had was gone and the app came up looking like
 * a fresh install. (It *deleted* the file until issue #984 quarantined it
 * instead; a marker written before that says `deleted_corrupt` and still means
 * exactly what it says.)
 *
 * The fact cannot live in the database - the database is the thing that just
 * went away - so it lives in a small JSON file beside it, and `GET /health`
 * reports it to the app that is already probing that endpoint before it shows a
 * window.
 *
 * Two rules the shape depends on:
 *
 * - **A clean start writes nothing.** The marker records a startup that *did*
 *   something to the data, never one that did not, so its presence alone
 *   distinguishes a wiped database from a genuine first run. Recording an `ok`
 *   outcome would make that distinction a string comparison in every reader,
 *   and there is no reader that wants it.
 * - **A marker is not cleared once written.** It is the record of the last
 *   recovery event, and the engine can be restarted (or crash) before any
 *   client has polled `/health` - clearing it on the next clean start would
 *   lose exactly the case the file exists for. Showing the notice only once is
 *   the *reader's* job, and the app does it by remembering the timestamp it
 *   acknowledged.
 */

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace vayu::db {

/**
 * @brief What the startup validation did about a database it could not open.
 *
 * Only the outcomes that touched the user's data are spelled - see the "clean
 * start writes nothing" rule above.
 */
enum class RecoveryOutcome : std::uint8_t {
    /// The database failed validation, a `.bak` backup passed the same
    /// validation, and it was restored over it.
    RestoredFromBackup,
    /// The database failed validation, no backup restored it, and it was
    /// **deleted**.
    ///
    /// No longer written by a startup that could quarantine the file instead
    /// (issue #984) - it survives because a rename can fail, and because a
    /// marker written by an engine that predates quarantining still spells this
    /// and must keep reading back as the outcome it names.
    DeletedCorrupt,
    /// The database failed validation, a `.bak` backup existed and failed the
    /// same validation, so it was left on disk untouched; the corrupt database
    /// was quarantined and a fresh one created.
    BackupAlsoCorrupt,
    /// The database failed validation and no backup restored it (there was
    /// none, or the copy failed); the corrupt database was quarantined and a
    /// fresh one created.
    StartedFreshQuarantined,
};

/// The stored spelling of an outcome - the wire value too, since `/health`
/// reports the record as written.
std::string to_string (RecoveryOutcome outcome);

/// The outcome a stored spelling names, or `nullopt` for anything else.
std::optional<RecoveryOutcome> recovery_outcome_from_string (const std::string& value);

/**
 * @brief One recovery event: what happened, when, and what it left behind.
 *
 * `at` is epoch milliseconds, as every other timestamp the engine stores is
 * (`created_at` on every row), so a reader formats it the way it formats those.
 */
struct RecoveryRecord {
    RecoveryOutcome outcome;
    int64_t at;
    /**
     * Where the corrupt database was moved to, when it was moved rather than
     * deleted (issue #984).
     *
     * The salvage route - `sqlite3 <path> .recover` - is only a route if the
     * user can be told the path, and the app is the only thing that tells them
     * anything. Absent for a marker written by an engine that deleted instead,
     * so a reader must handle its absence rather than assume the outcome
     * implies it.
     */
    std::optional<std::string> quarantined_path;
};

/// The marker file for a database at @p db_path: the path plus `.recovery`.
std::string recovery_marker_path (const std::string& db_path);

/**
 * @brief Record @p outcome for the database at @p db_path, overwriting any
 *        earlier marker.
 *
 * @param quarantined_path Where the corrupt file set was moved to, when it was
 *        moved rather than deleted. Written only when it has a value, so a
 *        marker never carries an empty claim about where the evidence is.
 *
 * Best-effort by design: it is called from the recovery branch of a constructor
 * that has just lost the user's data, and a marker that cannot be written must
 * not turn that into a daemon which will not start. A failure is logged.
 */
void write_recovery_marker (const std::string& db_path,
RecoveryOutcome outcome,
const std::optional<std::string>& quarantined_path = std::nullopt);

/**
 * @brief What a quarantined copy of a database is called: `<db>.corrupt-<ms>`,
 *        with SQLite's `-wal` / `-shm` sidecars beside it under the same name.
 *
 * The stamp is epoch milliseconds, as `RecoveryRecord::at` is, so the sets sort
 * by age without a stat call - and so a second corruption cannot overwrite the
 * evidence of the first.
 */
inline constexpr std::string_view QUARANTINE_INFIX = ".corrupt-";

/**
 * @brief How many quarantined sets a database keeps beside it (issue #984).
 *
 * Two, not one: the set from the corruption a user is currently looking at, and
 * the one before it, which is what tells them this has happened before. Not
 * unbounded, because these are full-size copies of a database in the directory
 * the engine writes to unattended.
 */
inline constexpr std::size_t QUARANTINE_SETS_KEPT = 2;

/**
 * @brief The quarantined sets beside the database at @p db_path, newest first.
 *
 * Each entry is one set's base path - the `-wal` / `-shm` sidecars sit beside it
 * under the same name and are not listed separately, because a caller pruning
 * or reporting works in sets rather than in files.
 */
std::vector<std::string> quarantined_database_paths (const std::string& db_path);

/**
 * @brief Delete all but the @p keep newest quarantined sets beside @p db_path.
 *
 * Best-effort, like the marker: it runs on a startup that has just lost the
 * user's database, and a file it cannot remove must not stop the daemon.
 */
void prune_quarantined_databases (const std::string& db_path, std::size_t keep);

/**
 * @brief The marker beside the database at @p db_path, if there is a readable
 *        one.
 *
 * A missing file, unreadable bytes, a malformed document and an unknown outcome
 * spelling all read as "no record" rather than as a partial one: the only
 * consumer turns this into a claim about the user's data, and a claim built out
 * of a half-parsed file is worse than no claim.
 */
std::optional<RecoveryRecord> read_recovery_marker (const std::string& db_path);

} // namespace vayu::db
