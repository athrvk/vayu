#pragma once

/**
 * @file core/config_manager.hpp
 * @brief Thread-safe configuration manager with caching
 *
 * Provides runtime access to configuration values with:
 * - Thread-safe caching
 * - Automatic reload from database
 * - Type-safe getters
 * - Validation
 */

#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "vayu/types.hpp"

// Forward declaration to break circular dependency with database.hpp
namespace vayu::db {
class Database;
}

namespace vayu::core {

/**
 * @brief Thread-safe configuration manager
 *
 * Caches configuration entries in memory and provides type-safe access.
 * Automatically reloads from database when values are updated.
 */
class ConfigManager {
public:
    /**
     * @brief Get singleton instance
     */
    static ConfigManager& instance();

    /**
     * @brief Initialize with database reference
     * Must be called before using config manager
     */
    void init(vayu::db::Database& db);

    /**
     * @brief Reload all config from database (clears cache)
     */
    void reload();

    /**
     * @brief Get config entry by key
     */
    std::optional<vayu::db::ConfigEntry> get_entry(const std::string& key);

    /**
     * @brief Get all config entries
     */
    std::vector<vayu::db::ConfigEntry> get_all_entries();

    /**
     * @brief Update config entry
     * Validates value based on type and constraints
     */
    bool update_entry(const std::string& key, const std::string& value);

    /**
     * @brief Update multiple config entries at once
     */
    bool update_entries(const std::unordered_map<std::string, std::string>& updates);

    // Type-safe getters with defaults
    int get_int(const std::string& key, int default_value = 0);
    std::string get_string(const std::string& key, const std::string& default_value = "");
    bool get_bool(const std::string& key, bool default_value = false);
    double get_double(const std::string& key, double default_value = 0.0);

private:
    ConfigManager() = default;
    ~ConfigManager() = default;
    ConfigManager(const ConfigManager&) = delete;
    ConfigManager& operator=(const ConfigManager&) = delete;

    void load_cache();
    bool validate_value(const vayu::db::ConfigEntry& entry, const std::string& value);
    std::string convert_to_string(int value);
    std::string convert_to_string(bool value);
    std::string convert_to_string(double value);

    vayu::db::Database* db_ = nullptr;
    std::mutex mutex_;
    std::unordered_map<std::string, vayu::db::ConfigEntry> cache_;
};

}  // namespace vayu::core
