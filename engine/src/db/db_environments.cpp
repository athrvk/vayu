/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db_environments.cpp
 * @brief Environments (including the single-active-environment invariant)
 * and the app-wide globals singleton (issue #1614).
 */

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

// At most one environment is active, and the switch is atomic. Enforced here
// rather than in the routes because three write paths reach this table (POST,
// PUT, and bulk import), and a rule living in the handlers would have to be
// repeated in each - the shape of bug this table already had, when `is_active`
// was honoured on create but not update. A caller that stores an active
// environment gets the previous one deactivated in the same transaction, so no
// reader can observe two actives, and none can observe zero either.
void Database::deactivate_other_environments_locked (const std::string& keep_id) {
    impl_->storage.update_all (set (c (&Environment::is_active) = false),
    where (c (&Environment::is_active) == true and c (&Environment::id) != keep_id));
}

void Database::save_environment (const Environment& e) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Saving environment",
    { { "id", e.id }, { "name", e.name }, { "isActive", e.is_active } });
    impl_->storage.transaction ([&] {
        if (e.is_active) {
            deactivate_other_environments_locked (e.id);
        }
        impl_->storage.replace (e);
        return true; // Commit
    });
}

std::vector<Environment> Database::get_environments () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<Environment> ();
}

std::optional<Environment> Database::get_environment (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto envs = impl_->storage.get_all<Environment> (where (c (&Environment::id) == id));
    if (envs.empty ())
        return std::nullopt;
    return envs.front ();
}

void Database::delete_environment (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting environment", { { "id", id } });
    impl_->storage.remove_all<Environment> (where (c (&Environment::id) == id));
}

// ============================================================================
// Globals - App-wide variables (singleton row with id="globals")
// ============================================================================

void Database::save_globals (const Globals& g) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Saving globals");
    impl_->storage.replace (g);
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
