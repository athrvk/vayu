/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db/recovery.cpp
 * @brief Reading and writing the startup recovery marker (issue #922), the
 *        quarantined file sets it points at (issue #984), and the sorting of a
 *        SQLite failure into what a caller can do about it (#2420, #2423).
 */

#include "vayu/db/recovery.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <system_error>
#include <utility>

#include <nlohmann/json.hpp>
#include <sqlite3.h>
#include <sqlite_orm/sqlite_orm.h>

#include "vayu/db/database.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::db {

namespace {

constexpr const char* MARKER_SUFFIX             = ".recovery";
constexpr const char* RESTORED_FROM_BACKUP      = "restored_from_backup";
constexpr const char* DELETED_CORRUPT           = "deleted_corrupt";
constexpr const char* BACKUP_ALSO_CORRUPT       = "backup_also_corrupt";
constexpr const char* STARTED_FRESH_QUARANTINED = "started_fresh_quarantined";
constexpr const char* QUARANTINED_PATH_FIELD    = "quarantinedPath";

int64_t now_ms () {
    using namespace std::chrono;
    return duration_cast<milliseconds> (system_clock::now ().time_since_epoch ())
    .count ();
}

// The system_error behind @p error when it is a SQLite failure. The category
// check is what makes the code a SQLite code: a filesystem or socket error
// carries an errno in the same field, and errno 13 (EACCES) is not SQLITE_FULL.
const std::system_error* as_sqlite_error (const std::exception& error) {
    const auto* system_error = dynamic_cast<const std::system_error*> (&error);
    if (system_error == nullptr ||
    system_error->code ().category () != sqlite_orm::get_sqlite_error_category ()) {
        return nullptr;
    }
    return system_error;
}

// sqlite_orm's `what ()` is "<sqlite3_errmsg>: <sqlite3_errstr>", which says
// "database is locked" twice whenever the two agree.
std::string sqlite_reason (const std::system_error& error) {
    const std::string generic = error.code ().message ();
    const std::string reason  = error.what ();
    return (reason == generic + ": " + generic) ? generic : reason;
}

StorageFailure storage_failure_of (int sqlite_code) {
    switch (sqlite_code) {
    case SQLITE_FULL: return StorageFailure::Full;
    case SQLITE_BUSY:
    case SQLITE_LOCKED: return StorageFailure::Busy;
    default: return StorageFailure::Other;
    }
}

} // namespace

std::string to_string (RecoveryOutcome outcome) {
    switch (outcome) {
    case RecoveryOutcome::RestoredFromBackup: return RESTORED_FROM_BACKUP;
    case RecoveryOutcome::DeletedCorrupt: return DELETED_CORRUPT;
    case RecoveryOutcome::BackupAlsoCorrupt: return BACKUP_ALSO_CORRUPT;
    case RecoveryOutcome::StartedFreshQuarantined:
        return STARTED_FRESH_QUARANTINED;
    }
    // Unreachable for a value of the enum; a default arm would hide a new one
    // being added without a spelling.
    return DELETED_CORRUPT;
}

std::optional<RecoveryOutcome> recovery_outcome_from_string (const std::string& value) {
    if (value == RESTORED_FROM_BACKUP) {
        return RecoveryOutcome::RestoredFromBackup;
    }
    if (value == DELETED_CORRUPT) {
        return RecoveryOutcome::DeletedCorrupt;
    }
    if (value == BACKUP_ALSO_CORRUPT) {
        return RecoveryOutcome::BackupAlsoCorrupt;
    }
    if (value == STARTED_FRESH_QUARANTINED) {
        return RecoveryOutcome::StartedFreshQuarantined;
    }
    return std::nullopt;
}

ProbeResult classify_probe_failure (const std::exception& error) {
    ProbeResult found{ ProbeResult::Verdict::Unavailable, 0, error.what () };
    const auto* sqlite_error = as_sqlite_error (error);
    if (sqlite_error == nullptr) {
        return found;
    }
    found.sqlite_code = sqlite_error->code ().value ();
    found.reason      = sqlite_reason (*sqlite_error);
    if (found.sqlite_code == SQLITE_CORRUPT || found.sqlite_code == SQLITE_NOTADB) {
        found.verdict = ProbeResult::Verdict::Corrupt;
    }
    return found;
}

std::optional<StorageError> classify_storage_error (const std::exception& error) {
    const auto* sqlite_error = as_sqlite_error (error);
    if (sqlite_error == nullptr) {
        return std::nullopt;
    }
    return StorageError{ storage_failure_of (sqlite_error->code ().value ()),
        sqlite_reason (*sqlite_error) };
}

std::string unavailable_database_message (const std::string& path, const ProbeResult& found) {
    std::string cause = found.reason;
    if (found.sqlite_code != 0) {
        cause += " (SQLite result code " + std::to_string (found.sqlite_code) + ")";
    }
    return "The database at " + path + " could not be examined: " + cause +
    ". Nothing was changed. Usually another program has the database open, "
    "or the disk is full or read-only: close the other program or free the "
    "disk, then start Vayu again. If the reason above names neither, the "
    "file itself needs a look before the next start.";
}

std::string recovery_marker_path (const std::string& db_path) {
    return db_path + MARKER_SUFFIX;
}

std::vector<std::string> quarantined_database_paths (const std::string& db_path) {
    namespace fs = std::filesystem;

    const fs::path db_file (db_path);
    const fs::path directory =
    db_file.has_parent_path () ? db_file.parent_path () : fs::path (".");
    const std::string prefix =
    db_file.filename ().string () + std::string (QUARANTINE_INFIX);

    // Keyed by set rather than by file: one quarantined database is up to three
    // entries in this directory, and a caller that saw them separately would
    // prune two sets while thinking it pruned three.
    std::vector<std::pair<int64_t, std::string>> sets;
    std::error_code ec;
    for (const auto& entry : fs::directory_iterator (directory, ec)) {
        std::string name = entry.path ().filename ().string ();
        if (name.rfind (prefix, 0) != 0) {
            continue;
        }
        for (const std::string_view suffix : { "-wal", "-shm" }) {
            if (name.size () > suffix.size () &&
            name.compare (name.size () - suffix.size (), suffix.size (), suffix) == 0) {
                name.resize (name.size () - suffix.size ());
                break;
            }
        }
        const std::string stamp_text = name.substr (prefix.size ());
        // A name whose stamp is not a number sorts oldest: it is not something
        // this engine wrote, and the ordering must stay total either way.
        int64_t stamp = 0;
        if (!stamp_text.empty () &&
        stamp_text.find_first_not_of ("0123456789") == std::string::npos) {
            try {
                stamp = std::stoll (stamp_text);
            } catch (const std::exception&) {
                // @deliberate A stamp too large for int64 is not a set this
                // engine wrote; it sorts oldest, which is what `stamp` already
                // holds, and pruning removes it before a real one.
                stamp = 0;
            }
        }
        // Spelled the way `db_path` was, not the way the directory walk found
        // it: the quarantined name is the database path with a suffix, so a
        // bare relative `vayu.db` must not come back as `./vayu.db` - the
        // marker records one of those strings and a caller compares it against
        // this list.
        std::string base = db_file.has_parent_path () ? (directory / name).string () : name;
        if (std::find_if (sets.begin (), sets.end (), [&base] (const auto& known) {
                return known.second == base;
            }) == sets.end ()) {
            sets.emplace_back (stamp, std::move (base));
        }
    }

    std::sort (sets.begin (), sets.end (), [] (const auto& lhs, const auto& rhs) {
        if (lhs.first != rhs.first) {
            return lhs.first > rhs.first;
        }
        return lhs.second > rhs.second;
    });

    std::vector<std::string> paths;
    paths.reserve (sets.size ());
    for (auto& set : sets) {
        paths.push_back (std::move (set.second));
    }
    return paths;
}

void prune_quarantined_databases (const std::string& db_path, std::size_t keep) {
    const std::vector<std::string> sets = quarantined_database_paths (db_path);
    for (std::size_t index = keep; index < sets.size (); ++index) {
        for (const char* suffix : { "", "-wal", "-shm" }) {
            std::error_code ec;
            std::filesystem::remove (sets[index] + suffix, ec);
        }
        vayu::utils::log_info (
        "db", "Pruned an older quarantined database at " + sets[index]);
    }
}

void write_recovery_marker (const std::string& db_path,
RecoveryOutcome outcome,
const std::optional<std::string>& quarantined_path) {
    const std::string marker = recovery_marker_path (db_path);
    nlohmann::json document;
    document["outcome"] = to_string (outcome);
    document["at"]      = now_ms ();
    // Absent rather than null when there is nothing quarantined, for the same
    // reason `/health` omits the whole node on a clean start: a reader that
    // finds the key can render it without first testing it for emptiness.
    if (quarantined_path) {
        document[QUARANTINED_PATH_FIELD] = *quarantined_path;
    }

    std::ofstream out (marker, std::ios::binary | std::ios::trunc);
    if (!out) {
        vayu::utils::log_warning ("db",
        "Could not write the recovery marker at " + marker +
        " - this startup's recovery will not be reported to the app.");
        return;
    }
    out << document.dump ();
    out.flush ();
    if (!out) {
        vayu::utils::log_warning (
        "db", "Recovery marker at " + marker + " was not fully written.");
        return;
    }
    vayu::utils::log_info ("db",
    "Recorded startup recovery '" + to_string (outcome) + "' at " + marker);
}

std::optional<RecoveryRecord> read_recovery_marker (const std::string& db_path) {
    const std::string marker = recovery_marker_path (db_path);
    std::error_code ec;
    if (!std::filesystem::exists (marker, ec) || ec) {
        return std::nullopt;
    }

    std::ifstream in (marker, std::ios::binary);
    if (!in) {
        return std::nullopt;
    }

    const nlohmann::json document = nlohmann::json::parse (in, nullptr, false);
    if (!document.is_object ()) {
        return std::nullopt;
    }

    const auto outcome_field = document.find ("outcome");
    const auto at_field      = document.find ("at");
    if (outcome_field == document.end () || !outcome_field->is_string ()) {
        return std::nullopt;
    }
    if (at_field == document.end () || !at_field->is_number_integer ()) {
        return std::nullopt;
    }

    const auto outcome =
    recovery_outcome_from_string (outcome_field->get<std::string> ());
    if (!outcome) {
        return std::nullopt;
    }

    // Optional, but not lenient: a marker that carries the key with something
    // other than a path in it is a half-parsed document, and the rule above is
    // that those read as no record at all rather than as a partial one.
    std::optional<std::string> quarantined_path;
    if (const auto field = document.find (QUARANTINED_PATH_FIELD);
    field != document.end ()) {
        if (!field->is_string ()) {
            return std::nullopt;
        }
        quarantined_path = field->get<std::string> ();
    }

    return RecoveryRecord{ .outcome = *outcome,
        .at                         = at_field->get<int64_t> (),
        .quarantined_path           = std::move (quarantined_path) };
}

} // namespace vayu::db
