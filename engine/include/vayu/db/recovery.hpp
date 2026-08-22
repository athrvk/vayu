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
 * opened and no backup restores it, **deletes it** so the daemon starts rather
 * than crash-looping. That is the right call and the whole record of it used to
 * be two lines in the engine log: every collection, request, environment,
 * example, spec and run the user had was gone and the app came up looking like
 * a fresh install.
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

#include <cstdint>
#include <optional>
#include <string>

namespace vayu::db {

/**
 * @brief What the startup validation did about a database it could not open.
 *
 * Only the two outcomes that touched the user's data are spelled - see the
 * "clean start writes nothing" rule above.
 */
enum class RecoveryOutcome : std::uint8_t {
    /// The database failed validation and a `.bak` backup was restored over it.
    RestoredFromBackup,
    /// The database failed validation, no backup restored it, and it was deleted.
    DeletedCorrupt,
};

/// The stored spelling of an outcome - the wire value too, since `/health`
/// reports the record as written.
std::string to_string (RecoveryOutcome outcome);

/// The outcome a stored spelling names, or `nullopt` for anything else.
std::optional<RecoveryOutcome> recovery_outcome_from_string (const std::string& value);

/**
 * @brief One recovery event: what happened, and when.
 *
 * `at` is epoch milliseconds, as every other timestamp the engine stores is
 * (`created_at` on every row), so a reader formats it the way it formats those.
 */
struct RecoveryRecord {
    RecoveryOutcome outcome;
    int64_t at;
};

/// The marker file for a database at @p db_path: the path plus `.recovery`.
std::string recovery_marker_path (const std::string& db_path);

/**
 * @brief Record @p outcome for the database at @p db_path, overwriting any
 *        earlier marker.
 *
 * Best-effort by design: it is called from the recovery branch of a constructor
 * that has just lost the user's data, and a marker that cannot be written must
 * not turn that into a daemon which will not start. A failure is logged.
 */
void write_recovery_marker (const std::string& db_path, RecoveryOutcome outcome);

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
