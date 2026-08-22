/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db/recovery.cpp
 * @brief Reading and writing the startup recovery marker (issue #922).
 */

#include "vayu/db/recovery.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <system_error>

#include <nlohmann/json.hpp>

#include "vayu/utils/logger.hpp"

namespace vayu::db {

namespace {

constexpr const char* MARKER_SUFFIX        = ".recovery";
constexpr const char* RESTORED_FROM_BACKUP = "restored_from_backup";
constexpr const char* DELETED_CORRUPT      = "deleted_corrupt";

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
    return std::nullopt;
}

std::string recovery_marker_path (const std::string& db_path) {
    return db_path + MARKER_SUFFIX;
}

void write_recovery_marker (const std::string& db_path, RecoveryOutcome outcome) {
    const std::string marker = recovery_marker_path (db_path);
    nlohmann::json document;
    document["outcome"] = to_string (outcome);
    document["at"]      = now_ms ();

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

    return RecoveryRecord{ .outcome = *outcome, .at = at_field->get<int64_t> () };
}

} // namespace vayu::db
