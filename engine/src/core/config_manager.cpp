/**
 * @file core/config_manager.cpp
 * @brief Configuration manager implementation
 */

#include "vayu/core/config_manager.hpp"

#include <algorithm>
#include <chrono>
#include <sstream>
#include <stdexcept>
#include <unordered_map>

#include "vayu/db/database.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

ConfigManager& ConfigManager::instance() {
    static ConfigManager instance;
    return instance;
}

void ConfigManager::init(vayu::db::Database& db) {
    std::lock_guard<std::mutex> lock(mutex_);
    db_ = &db;
    load_cache();
}

void ConfigManager::reload() {
    std::lock_guard<std::mutex> lock(mutex_);
    load_cache();
}

void ConfigManager::load_cache() {
    if (!db_) {
        vayu::utils::log_warning("ConfigManager: Database not initialized");
        return;
    }

    cache_.clear();
    auto entries = db_->get_all_config_entries();
    for (const auto& entry : entries) {
        cache_[entry.key] = entry;
    }
    vayu::utils::log_debug("ConfigManager: Loaded " + std::to_string(cache_.size()) +
                           " config entries");
}

std::optional<vayu::db::ConfigEntry> ConfigManager::get_entry(const std::string& key) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = cache_.find(key);
    if (it != cache_.end()) {
        return it->second;
    }
    return std::nullopt;
}

std::vector<vayu::db::ConfigEntry> ConfigManager::get_all_entries() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<vayu::db::ConfigEntry> result;
    result.reserve(cache_.size());
    for (const auto& [key, entry] : cache_) {
        result.push_back(entry);
    }
    // Sort by category, then by key for consistent ordering
    std::sort(result.begin(), result.end(),
              [](const vayu::db::ConfigEntry& a, const vayu::db::ConfigEntry& b) {
                  if (a.category != b.category) {
                      return a.category < b.category;
                  }
                  return a.key < b.key;
              });
    return result;
}

bool ConfigManager::update_entry(const std::string& key, const std::string& value) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!db_) {
        vayu::utils::log_error("ConfigManager: Cannot update - database not initialized");
        return false;
    }

    auto it = cache_.find(key);
    if (it == cache_.end()) {
        vayu::utils::log_warning("ConfigManager: Attempted to update unknown config key: " + key);
        return false;
    }

    const auto& entry = it->second;

    // Validate value
    if (!validate_value(entry, value)) {
        vayu::utils::log_error("ConfigManager: Invalid value for key " + key + ": " + value);
        return false;
    }

    // Update entry
    vayu::db::ConfigEntry updated = entry;
    updated.value = value;
    updated.updated_at = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count();

    // Save to database
    db_->save_config_entry(updated);

    // Update cache
    cache_[key] = updated;

    vayu::utils::log_info("ConfigManager: Updated config key " + key + " = " + value);
    return true;
}

bool ConfigManager::update_entries(
    const std::unordered_map<std::string, std::string>& updates) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!db_) {
        vayu::utils::log_error("ConfigManager: Cannot update - database not initialized");
        return false;
    }

    bool all_valid = true;
    std::vector<vayu::db::ConfigEntry> to_update;

    // Validate all updates first
    for (const auto& [key, value] : updates) {
        auto it = cache_.find(key);
        if (it == cache_.end()) {
            vayu::utils::log_warning("ConfigManager: Unknown config key: " + key);
            all_valid = false;
            continue;
        }

        if (!validate_value(it->second, value)) {
            vayu::utils::log_error("ConfigManager: Invalid value for key " + key + ": " + value);
            all_valid = false;
            continue;
        }

        vayu::db::ConfigEntry updated = it->second;
        updated.value = value;
        updated.updated_at = std::chrono::duration_cast<std::chrono::milliseconds>(
                                 std::chrono::system_clock::now().time_since_epoch())
                                 .count();
        to_update.push_back(updated);
    }

    if (!all_valid) {
        return false;
    }

    // Apply all updates
    for (const auto& entry : to_update) {
        db_->save_config_entry(entry);
        cache_[entry.key] = entry;
    }

    vayu::utils::log_info("ConfigManager: Updated " + std::to_string(to_update.size()) +
                           " config entries");
    return true;
}

bool ConfigManager::validate_value(const vayu::db::ConfigEntry& entry,
                                   const std::string& value) {
    if (entry.type == "integer") {
        try {
            int int_val = std::stoi(value);
            if (entry.min_value) {
                int min_val = std::stoi(*entry.min_value);
                if (int_val < min_val) {
                    return false;
                }
            }
            if (entry.max_value) {
                int max_val = std::stoi(*entry.max_value);
                if (int_val > max_val) {
                    return false;
                }
            }
        } catch (...) {
            return false;
        }
    } else if (entry.type == "number") {
        try {
            double double_val = std::stod(value);
            if (entry.min_value) {
                double min_val = std::stod(*entry.min_value);
                if (double_val < min_val) {
                    return false;
                }
            }
            if (entry.max_value) {
                double max_val = std::stod(*entry.max_value);
                if (double_val > max_val) {
                    return false;
                }
            }
        } catch (...) {
            return false;
        }
    } else if (entry.type == "boolean") {
        if (value != "true" && value != "false") {
            return false;
        }
    }
    // string type accepts any value
    return true;
}

int ConfigManager::get_int(const std::string& key, int default_value) {
    auto entry = get_entry(key);
    if (!entry) {
        return default_value;
    }
    try {
        return std::stoi(entry->value);
    } catch (...) {
        vayu::utils::log_warning("ConfigManager: Failed to parse int for key " + key +
                                 ", using default");
        return default_value;
    }
}

std::string ConfigManager::get_string(const std::string& key,
                                       const std::string& default_value) {
    auto entry = get_entry(key);
    if (!entry) {
        return default_value;
    }
    return entry->value;
}

bool ConfigManager::get_bool(const std::string& key, bool default_value) {
    auto entry = get_entry(key);
    if (!entry) {
        return default_value;
    }
    return entry->value == "true";
}

double ConfigManager::get_double(const std::string& key, double default_value) {
    auto entry = get_entry(key);
    if (!entry) {
        return default_value;
    }
    try {
        return std::stod(entry->value);
    } catch (...) {
        vayu::utils::log_warning("ConfigManager: Failed to parse double for key " + key +
                                 ", using default");
        return default_value;
    }
}

}  // namespace vayu::core
