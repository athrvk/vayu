/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/// Environments (with the single-active-environment invariant) and the app-wide
/// globals singleton (#1614).

#include "database_impl.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <expected>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/utils/logger.hpp"

using namespace sqlite_orm;

namespace vayu::db {

// ============================================================================
// Environments - Named variable sets (dev, staging, prod)
// ============================================================================

// At most one environment is active, and the switch is atomic. Enforced here,
// not in the routes, because three write paths reach this table (POST, PUT,
// bulk import), and a rule in the handlers would need repeating in each, the
// bug this table had when `is_active` was honoured on create but not update.
// Storing an active environment deactivates the previous one in the same
// transaction, so no reader sees two actives, or zero. A trashed row is outside
// the rule (#2970): its delete cleared the flag.
void Database::deactivate_other_environments_locked (const std::string& keep_id) {
    impl_->storage.update_all (set (c (&Environment::is_active) = false),
    where (c (&Environment::is_active) == true &&
    c (&Environment::id) != keep_id && is_null (&Environment::deleted_at)));
}

void Database::save_environment (const Environment& e) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Saving environment",
    { { "id", e.id }, { "name", e.name }, { "isActive", e.is_active } });
    // The environments a save deactivates publish nothing of their own: the
    // flag is read off the list, which this change already sends a client to.
    const ChangeOp op = upsert_op<Environment> (impl_->storage, e.id);
    impl_->storage.transaction ([&] {
        if (e.is_active) {
            deactivate_other_environments_locked (e.id);
        }
        impl_->storage.replace (e);
        return true; // Commit
    });
    changes_.publish (environment_change (e.id, op));
}

// Deleted rows are excluded here, not per caller (#2970), on `get_collections`'
// reasoning: composition, script scopes and the export all read through these
// two.
std::vector<Environment> Database::get_environments () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<Environment> (where (is_null (&Environment::deleted_at)));
}

std::optional<Environment> Database::get_environment (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto envs = impl_->storage.get_all<Environment> (
    where (c (&Environment::id) == id && is_null (&Environment::deleted_at)));
    if (envs.empty ())
        return std::nullopt;
    return envs.front ();
}

// Soft delete (#2970): the row is stamped, not removed, and gives up the active
// slot in the same write, so a trashed environment is never the one a client
// restores on launch. A restore does not take the slot back.
void Database::delete_environment (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting environment (soft)", { { "id", id } });
    const int64_t stamp = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                          .count ();
    bool deleted = false;
    impl_->storage.transaction ([&] {
        for (auto& environment : impl_->storage.get_all<Environment> (where (
             c (&Environment::id) == id && is_null (&Environment::deleted_at)))) {
            environment.deleted_at = stamp;
            environment.is_active  = false;
            impl_->storage.update (environment);
            deleted = true;
        }
        return true; // Commit
    });
    if (deleted) {
        changes_.publish (environment_change (id, ChangeOp::Delete));
    }
}

TrashOutcome Database::restore_environment_locked (const TrashEntry& entry) {
    impl_->storage.transaction ([&] {
        for (auto& environment : impl_->storage.get_all<Environment> (where (
             c (&Environment::id) == entry.id && is_not_null (&Environment::deleted_at)))) {
            environment.deleted_at.reset ();
            impl_->storage.update (environment);
        }
        return true; // Commit
    });
    changes_.publish (trash_change (entry, ChangeOp::Restore));
    vayu::utils::log_info (
    "db", "Restored environment from trash", { { "id", entry.id } });
    return TrashOutcome{ entry, false };
}

void Database::purge_environment_locked (const std::string& id) {
    impl_->storage.remove_all<Environment> (where (c (&Environment::id) == id));
}

// ============================================================================
// Globals - App-wide variables (singleton row with id="globals")
// ============================================================================

void Database::save_globals (const Globals& g) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Saving globals");
    const ChangeOp op = upsert_op<Globals> (impl_->storage, g.id);
    impl_->storage.replace (g);
    changes_.publish (Change{ ChangeKind::Globals, op, g.id, std::nullopt, std::nullopt });
}

std::optional<Globals> Database::get_globals () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto globals =
    impl_->storage.get_all<Globals> (where (c (&Globals::id) == "globals"));
    if (globals.empty ())
        return std::nullopt;
    return globals.front ();
}

} // namespace vayu::db
