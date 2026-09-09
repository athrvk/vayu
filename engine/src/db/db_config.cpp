/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db_config.cpp
 * @brief Structured config entries: CRUD, the typed getters, and the call
 * into the per-category seeders #1611 split out (issue #1614).
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

#include "config_seeds/seed.hpp"

using namespace sqlite_orm;

namespace vayu::db {

// ============================================================================
// Config Entries - Structured configuration with metadata
// ============================================================================

void Database::save_config_entry (const ConfigEntry& entry) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    impl_->storage.replace (entry);
}

// Same shape as apply_reorder and spec_sync_apply: retry_on_busy holds the
// recursive mutex while the transaction runs, so a row an earlier call in the
// batch just wrote is visible to the check or write after it. Unlike those two
// there is no existence check - config entries are seeded once at startup and
// never deleted through any route - so a mid-batch failure here is a genuine
// SQLITE_BUSY-past-retry or disk error, which `impl_->storage.transaction`
// rolls back in full rather than leaving the rows written before it landed.
void Database::save_config_entries (const std::vector<ConfigEntry>& entries) {
    if (entries.empty ()) {
        return;
    }
    retry_on_busy ("apply config batch", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            for (const auto& entry : entries) {
                impl_->storage.replace (entry);
            }
            return true; // Commit
        });
    });
}

std::optional<ConfigEntry> Database::get_config_entry (const std::string& key) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto entries =
    impl_->storage.get_all<ConfigEntry> (where (c (&ConfigEntry::key) == key));
    if (entries.empty ())
        return std::nullopt;
    return entries.front ();
}

std::vector<ConfigEntry> Database::get_all_config_entries () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<ConfigEntry> ();
}

bool Database::is_known_config_key (const std::string& key) const {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return known_config_keys_.contains (key);
}

// Type-safe config getters (replaces ConfigManager)
int Database::get_config_int (const std::string& key, int default_value) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto entry = get_config_entry (key);
    if (!entry) {
        return default_value;
    }
    try {
        return std::stoi (entry->value);
    } catch (...) {
        vayu::utils::log_warning ("db",
        "Database: Failed to parse int for key " + key + ", using default");
        return default_value;
    }
}

std::string Database::get_config_string (const std::string& key,
const std::string& default_value) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto entry = get_config_entry (key);
    if (!entry) {
        return default_value;
    }
    return entry->value;
}

bool Database::get_config_bool (const std::string& key, bool default_value) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto entry = get_config_entry (key);
    if (!entry) {
        return default_value;
    }
    return entry->value == "true";
}

double Database::get_config_double (const std::string& key, double default_value) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto entry = get_config_entry (key);
    if (!entry) {
        return default_value;
    }
    try {
        return std::stod (entry->value);
    } catch (...) {
        vayu::utils::log_warning ("db",
        "Database: Failed to parse double for key " + key + ", using default");
        return default_value;
    }
}

void Database::seed_default_config () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);

    // One transaction for the whole seed (issue #838): a throw partway used to
    // leave the table half-seeded, and batching what were ~66 separate commits
    // into one is what keeps a scratch database's test-suite wall time down.
    auto seed_transaction = impl_->storage.transaction_guard ();

    auto existing               = impl_->storage.get_all<ConfigEntry> ();
    const size_t existing_count = existing.size ();
    const auto now              = config_seeds::now_ms ();

    config_seeds::ConfigSeeder seed (
    std::move (existing), known_config_keys_,
    [this] (const ConfigEntry& entry) { impl_->storage.replace (entry); },
    [this] (const std::string& key) {
        impl_->storage.remove_all<ConfigEntry> (where (c (&ConfigEntry::key) == key));
    });

    config_seeds::seed_general (seed, now);
    config_seeds::seed_network (seed, now);
    config_seeds::seed_services (seed, now);
    config_seeds::seed_observability (seed, now);
    config_seeds::seed_data_retention (seed, now);
    config_seeds::seed_limits (seed, now);
    config_seeds::seed_scripting (seed, now);

    seed.validate_dependencies ();

    seed_transaction.commit ();

    if (existing_count == 0) {
        vayu::utils::log_info ("db", "Seeded default configuration values");
    } else {
        vayu::utils::log_info ("db",
        "Updated configuration metadata for " + std::to_string (existing_count) + " existing entries");
    }
}

} // namespace vayu::db
