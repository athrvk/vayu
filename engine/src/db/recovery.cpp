/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db/recovery.cpp
 * @brief Reading and writing the startup recovery marker (issue #922), and the
 *        quarantined file sets it points at (issue #984).
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
        vayu::utils::log_info ("Pruned an older quarantined database at " + sets[index]);
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
        vayu::utils::log_warning ("Could not write the recovery marker at " +
        marker + " - this startup's recovery will not be reported to the app.");
        return;
    }
    out << document.dump ();
    out.flush ();
    if (!out) {
        vayu::utils::log_warning ("Recovery marker at " + marker + " was not fully written.");
        return;
    }
    vayu::utils::log_info (
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
