/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file database.cpp
 * @brief SQLite database layer using sqlite_orm
 *
 * Schema Overview:
 * ────────────────────────────────────────────────────────────────────────
 * PROJECT MANAGEMENT:
 *   collections  - Folder structure for organizing requests
 *   requests     - HTTP request definitions with scripts
 *   environments - Named variable sets (e.g., dev, staging, prod)
 *   globals      - App-wide variables (singleton)
 *
 * EXECUTION ENGINE:
 *   runs         - Test execution records (load tests, design mode)
 *   metrics      - Time-series performance data per run
 *   results      - Individual request results with timing
 *
 * CONFIGURATION:
 *   config_entries - Structured configuration with metadata for UI
 * ────────────────────────────────────────────────────────────────────────
 */

#include "vayu/db/database.hpp"

#include <sqlite3.h>
#include <sqlite_orm/sqlite_orm.h>

#include <chrono>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <sstream>
#include <thread>
#include <unordered_map>

#include "vayu/core/constants.hpp"
#include "vayu/utils/logger.hpp"

// ============================================================================
// SQLite ORM Type Adapters
// These templates tell sqlite_orm how to serialize/deserialize our enums
// ============================================================================

namespace sqlite_orm {

// HttpMethod enum adapter (GET, POST, PUT, DELETE, etc.)
template <>
struct type_printer<vayu::HttpMethod> {
    const std::string& print() {
        static const std::string res = "TEXT";
        return res;
    }
};
template <>
struct statement_binder<vayu::HttpMethod> {
    int bind(sqlite3_stmt* stmt, int index, const vayu::HttpMethod& value) {
        return sqlite3_bind_text(stmt, index, vayu::to_string(value), -1, SQLITE_TRANSIENT);
    }
};
template <>
struct field_printer<vayu::HttpMethod> {
    std::string operator()(const vayu::HttpMethod& t) const {
        return vayu::to_string(t);
    }
};
template <>
struct row_extractor<vayu::HttpMethod> {
    vayu::HttpMethod extract(const char* row_value) const {
        if (auto val = vayu::parse_method(row_value)) return *val;
        return vayu::HttpMethod::GET;
    }
    vayu::HttpMethod extract(sqlite3_stmt* stmt, int columnIndex) const {
        const char* str = (const char*) sqlite3_column_text(stmt, columnIndex);
        return this->extract(str ? str : "");
    }
};

// RunType enum adapter (Design, Load)
template <>
struct type_printer<vayu::RunType> {
    const std::string& print() {
        static const std::string res = "TEXT";
        return res;
    }
};
template <>
struct statement_binder<vayu::RunType> {
    int bind(sqlite3_stmt* stmt, int index, const vayu::RunType& value) {
        return sqlite3_bind_text(stmt, index, vayu::to_string(value), -1, SQLITE_TRANSIENT);
    }
};
template <>
struct field_printer<vayu::RunType> {
    std::string operator()(const vayu::RunType& t) const {
        return vayu::to_string(t);
    }
};
template <>
struct row_extractor<vayu::RunType> {
    vayu::RunType extract(const char* row_value) const {
        if (auto val = vayu::parse_run_type(row_value)) return *val;
        return vayu::RunType::Design;
    }
    vayu::RunType extract(sqlite3_stmt* stmt, int columnIndex) const {
        const char* str = (const char*) sqlite3_column_text(stmt, columnIndex);
        return this->extract(str ? str : "");
    }
};

// RunStatus enum adapter (Pending, Running, Completed, Failed, Stopped)
template <>
struct type_printer<vayu::RunStatus> {
    const std::string& print() {
        static const std::string res = "TEXT";
        return res;
    }
};
template <>
struct statement_binder<vayu::RunStatus> {
    int bind(sqlite3_stmt* stmt, int index, const vayu::RunStatus& value) {
        return sqlite3_bind_text(stmt, index, vayu::to_string(value), -1, SQLITE_TRANSIENT);
    }
};
template <>
struct field_printer<vayu::RunStatus> {
    std::string operator()(const vayu::RunStatus& t) const {
        return vayu::to_string(t);
    }
};
template <>
struct row_extractor<vayu::RunStatus> {
    vayu::RunStatus extract(const char* row_value) const {
        if (auto val = vayu::parse_run_status(row_value)) return *val;
        return vayu::RunStatus::Pending;
    }
    vayu::RunStatus extract(sqlite3_stmt* stmt, int columnIndex) const {
        const char* str = (const char*) sqlite3_column_text(stmt, columnIndex);
        return this->extract(str ? str : "");
    }
};

// MetricName enum adapter (Rps, Latency, ErrorRate, etc.)
template <>
struct type_printer<vayu::MetricName> {
    const std::string& print() {
        static const std::string res = "TEXT";
        return res;
    }
};
template <>
struct statement_binder<vayu::MetricName> {
    int bind(sqlite3_stmt* stmt, int index, const vayu::MetricName& value) {
        return sqlite3_bind_text(stmt, index, vayu::to_string(value), -1, SQLITE_TRANSIENT);
    }
};
template <>
struct field_printer<vayu::MetricName> {
    std::string operator()(const vayu::MetricName& t) const {
        return vayu::to_string(t);
    }
};
template <>
struct row_extractor<vayu::MetricName> {
    vayu::MetricName extract(const char* row_value) const {
        if (auto val = vayu::parse_metric_name(row_value)) return *val;
        return vayu::MetricName::Rps;
    }
    vayu::MetricName extract(sqlite3_stmt* stmt, int columnIndex) const {
        const char* str = (const char*) sqlite3_column_text(stmt, columnIndex);
        return this->extract(str ? str : "");
    }
};
}  // namespace sqlite_orm

using namespace sqlite_orm;

namespace vayu::db {

// ============================================================================
// Database Schema Definition
// All tables defined here - sqlite_orm auto-creates/migrates on sync_schema()
// ============================================================================

inline auto make_storage(const std::string& path) {
    return sqlite_orm::make_storage(
        path,

        // ─────────────── PROJECT MANAGEMENT TABLES ───────────────

        // Collections: Folder hierarchy for organizing requests
        make_table(
            "collections",
            make_column("id", &Collection::id, primary_key()),
            make_column("parent_id", &Collection::parent_id),
            make_column("name", &Collection::name),
            make_column("variables", &Collection::variables),  // JSON: collection-scoped vars
            make_column("order", &Collection::order),
            make_column("created_at", &Collection::created_at)),

        // Requests: HTTP request definitions with pre/post scripts
        make_table("requests",
                   make_column("id", &Request::id, primary_key()),
                   make_column("collection_id", &Request::collection_id),
                   make_column("name", &Request::name),
                   make_column("method", &Request::method),
                   make_column("url", &Request::url),
                   make_column("params", &Request::params),    // JSON
                   make_column("headers", &Request::headers),  // JSON
                   make_column("body", &Request::body),
                   make_column("body_type", &Request::body_type),                    // Content type
                   make_column("auth", &Request::auth),                              // JSON
                   make_column("pre_request_script", &Request::pre_request_script),  // JS
                   make_column("post_request_script", &Request::post_request_script),  // JS
                   make_column("updated_at", &Request::updated_at)),

        // Environments: Named variable sets (dev, staging, prod)
        make_table(
            "environments",
            make_column("id", &Environment::id, primary_key()),
            make_column("name", &Environment::name),
            make_column("variables", &Environment::variables),  // JSON: {key: {value, enabled}}
            make_column("updated_at", &Environment::updated_at)),

        // ─────────────── EXECUTION ENGINE TABLES ───────────────

        // Runs: Test execution sessions (load tests or design mode requests)
        make_table(
            "runs",
            make_column("id", &Run::id, primary_key()),
            make_column("request_id", &Run::request_id),
            make_column("environment_id", &Run::environment_id),
            make_column("type", &Run::type),      // "design" or "load"
            make_column("status", &Run::status),  // pending/running/completed/failed
            make_column("config_snapshot", &Run::config_snapshot),  // JSON: full request copy
            make_column("start_time", &Run::start_time),
            make_column("end_time", &Run::end_time)),

        // Metrics: Time-series performance data (RPS, latency percentiles, etc.)
        make_table("metrics",
                   make_column("id", &Metric::id, primary_key().autoincrement()),
                   make_column("run_id", &Metric::run_id),
                   make_column("timestamp", &Metric::timestamp),
                   make_column("name", &Metric::name),
                   make_column("value", &Metric::value),
                   make_column("labels", &Metric::labels)),  // JSON: additional dimensions

        // Results: Individual request outcomes with timing breakdown
        make_table(
            "results",
            make_column("id", &Result::id, primary_key().autoincrement()),
            make_column("run_id", &Result::run_id),
            make_column("timestamp", &Result::timestamp),
            make_column("status_code", &Result::status_code),
            make_column("latency_ms", &Result::latency_ms),
            make_column("error", &Result::error),
            make_column("trace_data", &Result::trace_data)),  // JSON: headers/body for errors

        // ─────────────── CONFIGURATION TABLES ───────────────

        // Config Entries: Structured configuration with metadata for UI
        make_table("config_entries",
                   make_column("key", &ConfigEntry::key, primary_key()),
                   make_column("value", &ConfigEntry::value),
                   make_column("type", &ConfigEntry::type),
                   make_column("label", &ConfigEntry::label),
                   make_column("description", &ConfigEntry::description),
                   make_column("category", &ConfigEntry::category),
                   make_column("default_value", &ConfigEntry::default_value),
                   make_column("min_value", &ConfigEntry::min_value),
                   make_column("max_value", &ConfigEntry::max_value),
                   make_column("updated_at", &ConfigEntry::updated_at)),

        // Globals: App-wide variables (singleton row with id="globals")
        make_table("globals",
                   make_column("id", &Globals::id, primary_key()),
                   make_column("variables", &Globals::variables),  // JSON: {key: {value, enabled}}
                   make_column("updated_at", &Globals::updated_at)));
}

using Storage = decltype(make_storage(""));

// ============================================================================
// Database Implementation (PImpl pattern)
// ============================================================================

struct Database::Impl {
    Storage storage;
    std::recursive_mutex mutex;

    Impl(const std::string& path) : storage(make_storage(path)) {
        std::filesystem::path db_path(path);
        if (db_path.has_parent_path()) {
            std::filesystem::create_directories(db_path.parent_path());
        }

        // Set on_open callback to apply database optimizations when connection is established
        // Note: These use default constants. To use custom values from UI settings,
        // users must restart the engine after changing settings.
        storage.on_open = [](sqlite3* db) {
            char* err_msg = nullptr;
            std::stringstream sql;

            // Use default constants for database optimizations
            // These settings require engine restart to take effect and are applied
            // from constants at startup. Users can change them via Settings UI,
            // but changes only apply after restarting the engine.
            int cache_size = vayu::core::constants::database::CACHE_SIZE_KB;
            int temp_store = vayu::core::constants::database::TEMP_STORE;
            size_t mmap_size = vayu::core::constants::database::MMAP_SIZE_BYTES;
            int wal_checkpoint = vayu::core::constants::database::WAL_AUTOCHECKPOINT;

            // Apply optimizations
            sql << "PRAGMA cache_size = " << cache_size << ";";
            int rc = sqlite3_exec(db, sql.str().c_str(), nullptr, nullptr, &err_msg);
            if (rc != SQLITE_OK && err_msg) {
                vayu::utils::log_warning("Failed to set cache_size: " + std::string(err_msg));
                sqlite3_free(err_msg);
                err_msg = nullptr;
            }
            sql.str("");

            sql << "PRAGMA temp_store = " << temp_store << ";";
            rc = sqlite3_exec(db, sql.str().c_str(), nullptr, nullptr, &err_msg);
            if (rc != SQLITE_OK && err_msg) {
                vayu::utils::log_warning("Failed to set temp_store: " + std::string(err_msg));
                sqlite3_free(err_msg);
                err_msg = nullptr;
            }
            sql.str("");

            sql << "PRAGMA mmap_size = " << mmap_size << ";";
            rc = sqlite3_exec(db, sql.str().c_str(), nullptr, nullptr, &err_msg);
            if (rc != SQLITE_OK && err_msg) {
                vayu::utils::log_warning("Failed to set mmap_size: " + std::string(err_msg));
                sqlite3_free(err_msg);
                err_msg = nullptr;
            }
            sql.str("");

            sql << "PRAGMA wal_autocheckpoint = " << wal_checkpoint << ";";
            rc = sqlite3_exec(db, sql.str().c_str(), nullptr, nullptr, &err_msg);
            if (rc != SQLITE_OK && err_msg) {
                vayu::utils::log_warning("Failed to set wal_autocheckpoint: " +
                                         std::string(err_msg));
                sqlite3_free(err_msg);
            }
        };
    }
};

Database::Database(const std::string& db_path) : impl_(std::make_unique<Impl>(db_path)) {}

Database::~Database() = default;

// Initialize database with optimized SQLite settings
void Database::init() {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    vayu::utils::log_debug("Initializing database...");
    impl_->storage.sync_schema();

    // WAL mode for better concurrent read/write performance
    impl_->storage.pragma.journal_mode(journal_mode::WAL);

    // Seed default configuration values if empty (must be before reading config)
    seed_default_config();

    // Apply database optimizations from config (or use defaults)
    // Note: These settings require engine restart to take effect
    // The on_open callback applies defaults; config values are read here for runtime adjustments

    // Get synchronous mode (0=OFF, 1=NORMAL, 2=FULL)
    int synchronous = get_config_int("dbSynchronous", vayu::core::constants::database::SYNCHRONOUS);
    impl_->storage.pragma.synchronous(synchronous);

    // Get busy timeout in milliseconds
    int busy_timeout =
        get_config_int("dbBusyTimeout", vayu::core::constants::database::BUSY_TIMEOUT_MS);
    impl_->storage.pragma.busy_timeout(busy_timeout);

    // Log current configuration (other PRAGMAs are set in on_open callback and require restart)
    int cache_size = get_config_int("dbCacheSize", vayu::core::constants::database::CACHE_SIZE_KB);
    int temp_store = get_config_int("dbTempStore", vayu::core::constants::database::TEMP_STORE);
    int mmap_size = get_config_int(
        "dbMmapSize", static_cast<int>(vayu::core::constants::database::MMAP_SIZE_BYTES));
    int wal_checkpoint =
        get_config_int("dbWalAutocheckpoint", vayu::core::constants::database::WAL_AUTOCHECKPOINT);

    vayu::utils::log_debug(
        "Database initialized with WAL mode (cache=" + std::to_string(-cache_size) +
        "KB, mmap=" + std::to_string(mmap_size / 1024 / 1024) + "MB, " + "temp_store=" +
        std::to_string(temp_store) + ", " + "wal_checkpoint=" + std::to_string(wal_checkpoint) +
        " pages, " + "busy_timeout=" + std::to_string(busy_timeout) + "ms, " +
        "synchronous=" + std::to_string(synchronous) + ")");
}

// ============================================================================
// Collections - Folder structure for organizing requests
// ============================================================================

void Database::create_collection(const Collection& c) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    vayu::utils::log_debug("Creating collection: id=" + c.id + ", name=" + c.name);
    impl_->storage.replace(c);
}

std::vector<Collection> Database::get_collections() {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    return impl_->storage.get_all<Collection>(order_by(&Collection::order));
}

std::optional<Collection> Database::get_collection(const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    auto cols = impl_->storage.get_all<Collection>(where(c(&Collection::id) == id));
    if (cols.empty()) return std::nullopt;
    return cols.front();
}

// Cascade delete: removes all requests in collection first
void Database::delete_collection(const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    vayu::utils::log_debug("Deleting collection: id=" + id);
    impl_->storage.remove_all<Request>(where(c(&Request::collection_id) == id));
    impl_->storage.remove_all<Collection>(where(c(&Collection::id) == id));
}

// ============================================================================
// Requests - HTTP request definitions with pre/post scripts
// ============================================================================

void Database::save_request(const Request& r) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    vayu::utils::log_debug("Saving request: id=" + r.id + ", name=" + r.name);
    impl_->storage.replace(r);
}

std::optional<Request> Database::get_request(const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    auto requests = impl_->storage.get_all<Request>(where(c(&Request::id) == id));
    if (requests.empty()) return std::nullopt;
    return requests.front();
}

std::vector<Request> Database::get_requests_in_collection(const std::string& collection_id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    return impl_->storage.get_all<Request>(where(c(&Request::collection_id) == collection_id));
}

// Helper function to get all requests for iteration (needed because template can't access impl_)
std::vector<Request> Database::_get_all_requests_for_collection(const std::string& collection_id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    return impl_->storage.get_all<Request>(where(c(&Request::collection_id) == collection_id));
}

void Database::delete_request(const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    vayu::utils::log_debug("Deleting request: id=" + id);
    impl_->storage.remove_all<Request>(where(c(&Request::id) == id));
}

// ============================================================================
// Environments - Named variable sets (dev, staging, prod)
// ============================================================================

void Database::save_environment(const Environment& e) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    vayu::utils::log_debug("Saving environment: id=" + e.id + ", name=" + e.name);
    impl_->storage.replace(e);
}

std::vector<Environment> Database::get_environments() {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    return impl_->storage.get_all<Environment>();
}

std::optional<Environment> Database::get_environment(const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    auto envs = impl_->storage.get_all<Environment>(where(c(&Environment::id) == id));
    if (envs.empty()) return std::nullopt;
    return envs.front();
}

void Database::delete_environment(const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    vayu::utils::log_debug("Deleting environment: id=" + id);
    impl_->storage.remove_all<Environment>(where(c(&Environment::id) == id));
}

// ============================================================================
// Globals - App-wide variables (singleton row with id="globals")
// ============================================================================

void Database::save_globals(const Globals& g) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    vayu::utils::log_debug("Saving globals");
    impl_->storage.replace(g);
}

std::optional<Globals> Database::get_globals() {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    auto globals = impl_->storage.get_all<Globals>(where(c(&Globals::id) == "globals"));
    if (globals.empty()) return std::nullopt;
    return globals.front();
}

// ============================================================================
// Runs - Test execution sessions (load tests or design mode requests)
// ============================================================================

void Database::create_run(const Run& run) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    vayu::utils::log_debug("Creating run: id=" + run.id +
                           ", type=" + std::string(vayu::to_string(run.type)));
    impl_->storage.replace(run);
}

std::optional<Run> Database::get_run(const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    auto runs = impl_->storage.get_all<Run>(where(c(&Run::id) == id));
    if (runs.empty()) return std::nullopt;
    return runs.front();
}

void Database::update_run_status(const std::string& id, RunStatus status) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    vayu::utils::log_debug("Updating run status: id=" + id +
                           ", status=" + std::string(vayu::to_string(status)));
    auto run = get_run(id);
    if (run) {
        run->status = status;
        run->end_time = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
        impl_->storage.update(*run);
    }
}

void Database::update_run_end_time(const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    vayu::utils::log_debug("Updating run end_time: id=" + id);
    auto run = get_run(id);
    if (run) {
        run->end_time = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
        impl_->storage.update(*run);
    }
}

void Database::update_run_status_with_retry(const std::string& id,
                                            RunStatus status,
                                            int max_retries) {
    for (int attempt = 0; attempt < max_retries; attempt++) {
        try {
            update_run_status(id, status);
            return;  // Success
        } catch (const std::system_error& e) {
            std::string error_msg = e.what();
            // Check if it's a database lock error
            if (error_msg.find("database is locked") != std::string::npos ||
                error_msg.find("SQLITE_BUSY") != std::string::npos) {
                if (attempt == max_retries - 1) {
                    // Last attempt failed, rethrow
                    vayu::utils::log_error("Failed to update run status after " +
                                           std::to_string(max_retries) + " attempts: " + error_msg);
                    throw;
                }
                // Wait before retry with exponential backoff
                vayu::utils::log_debug("Database locked, retrying in " +
                                       std::to_string(100 * (attempt + 1)) + "ms (attempt " +
                                       std::to_string(attempt + 1) + "/" +
                                       std::to_string(max_retries) + ")");
                std::this_thread::sleep_for(std::chrono::milliseconds(100 * (attempt + 1)));
            } else {
                // Different error, rethrow immediately
                throw;
            }
        } catch (...) {
            // Non-system_error exceptions, rethrow immediately
            throw;
        }
    }
}

std::vector<Run> Database::get_all_runs() {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    return impl_->storage.get_all<Run>(order_by(&Run::start_time).desc());
}

// Cascade delete: removes metrics and results first
void Database::delete_run(const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    impl_->storage.remove_all<Metric>(where(c(&Metric::run_id) == id));
    impl_->storage.remove_all<Result>(where(c(&Result::run_id) == id));
    impl_->storage.remove<Run>(id);
}

// ============================================================================
// Metrics - Time-series performance data (RPS, latency percentiles, etc.)
// ============================================================================

void Database::add_metric(const Metric& metric) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    const int max_retries = 3;
    for (int attempt = 0; attempt < max_retries; attempt++) {
        try {
            impl_->storage.insert(metric);
            return;  // Success
        } catch (const std::system_error& e) {
            std::string error_msg = e.what();
            // Check if it's a database lock error
            if (error_msg.find("database is locked") != std::string::npos ||
                error_msg.find("SQLITE_BUSY") != std::string::npos) {
                if (attempt == max_retries - 1) {
                    // Last attempt failed, rethrow
                    vayu::utils::log_error("Failed to add metric after " +
                                           std::to_string(max_retries) + " attempts: " + error_msg);
                    throw;
                }
                // Wait before retry with exponential backoff
                std::this_thread::sleep_for(std::chrono::milliseconds(50 * (attempt + 1)));
            } else {
                // Different error, rethrow immediately
                throw;
            }
        } catch (...) {
            // Non-system_error exceptions, rethrow immediately
            throw;
        }
    }
}

// Batch insert with transaction for better performance and reduced lock contention
// Includes retry logic to handle database lock contention
void Database::add_metrics_batch(const std::vector<Metric>& metrics) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    if (metrics.empty()) return;

    const int max_retries = 5;
    for (int attempt = 0; attempt < max_retries; attempt++) {
        try {
            impl_->storage.transaction([&] {
                for (const auto& metric : metrics) {
                    impl_->storage.insert(metric);
                }
                return true;  // Commit
            });
            return;  // Success
        } catch (const std::system_error& e) {
            std::string error_msg = e.what();
            // Check if it's a database lock error
            if (error_msg.find("database is locked") != std::string::npos ||
                error_msg.find("SQLITE_BUSY") != std::string::npos) {
                if (attempt == max_retries - 1) {
                    // Last attempt failed, rethrow
                    vayu::utils::log_error("Failed to store metrics batch after " +
                                           std::to_string(max_retries) + " attempts: " + error_msg);
                    throw;
                }
                // Wait before retry with exponential backoff
                vayu::utils::log_debug("Database locked during metrics batch, retrying in " +
                                       std::to_string(100 * (attempt + 1)) + "ms (attempt " +
                                       std::to_string(attempt + 1) + "/" +
                                       std::to_string(max_retries) + ")");
                std::this_thread::sleep_for(std::chrono::milliseconds(100 * (attempt + 1)));
            } else {
                // Different error, rethrow immediately
                throw;
            }
        } catch (...) {
            // Non-system_error exceptions, rethrow immediately
            throw;
        }
    }
}

std::vector<Metric> Database::get_metrics(const std::string& run_id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    return impl_->storage.get_all<Metric>(where(c(&Metric::run_id) == run_id));
}

// Get metrics added after a specific ID (for incremental updates)
std::vector<Metric> Database::get_metrics_since(const std::string& run_id, int64_t last_id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    return impl_->storage.get_all<Metric>(
        where(c(&Metric::run_id) == run_id && c(&Metric::id) > last_id), order_by(&Metric::id));
}

// ============================================================================
// Results - Individual request outcomes with timing breakdown
// ============================================================================

void Database::add_result(const Result& result) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    impl_->storage.insert(result);
}

// Batch insert with transaction for better performance
// Includes retry logic to handle database lock contention
void Database::add_results_batch(const std::vector<Result>& results) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    if (results.empty()) return;

    const int max_retries = 5;
    for (int attempt = 0; attempt < max_retries; attempt++) {
        try {
            impl_->storage.transaction([&] {
                for (const auto& result : results) {
                    impl_->storage.insert(result);
                }
                return true;  // Commit
            });
            return;  // Success
        } catch (const std::system_error& e) {
            std::string error_msg = e.what();
            // Check if it's a database lock error
            if (error_msg.find("database is locked") != std::string::npos ||
                error_msg.find("SQLITE_BUSY") != std::string::npos) {
                if (attempt == max_retries - 1) {
                    // Last attempt failed, rethrow
                    vayu::utils::log_error("Failed to flush results batch after " +
                                           std::to_string(max_retries) + " attempts: " + error_msg);
                    throw;
                }
                // Wait before retry with exponential backoff
                vayu::utils::log_debug("Database locked during results batch, retrying in " +
                                       std::to_string(100 * (attempt + 1)) + "ms (attempt " +
                                       std::to_string(attempt + 1) + "/" +
                                       std::to_string(max_retries) + ")");
                std::this_thread::sleep_for(std::chrono::milliseconds(100 * (attempt + 1)));
            } else {
                // Different error, rethrow immediately
                throw;
            }
        } catch (...) {
            // Non-system_error exceptions, rethrow immediately
            throw;
        }
    }
}

std::vector<Result> Database::get_results(const std::string& run_id) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    return impl_->storage.get_all<Result>(where(c(&Result::run_id) == run_id));
}

// ============================================================================
// Transaction Helpers
// ============================================================================

void Database::begin_transaction() {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    impl_->storage.begin_transaction();
}

void Database::commit_transaction() {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    impl_->storage.commit();
}

void Database::rollback_transaction() {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    impl_->storage.rollback();
}

// ============================================================================
// Config Entries - Structured configuration with metadata
// ============================================================================

void Database::save_config_entry(const ConfigEntry& entry) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    impl_->storage.replace(entry);
}

std::optional<ConfigEntry> Database::get_config_entry(const std::string& key) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    auto entries = impl_->storage.get_all<ConfigEntry>(where(c(&ConfigEntry::key) == key));
    if (entries.empty()) return std::nullopt;
    return entries.front();
}

std::vector<ConfigEntry> Database::get_all_config_entries() {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    return impl_->storage.get_all<ConfigEntry>();
}

// Type-safe config getters (replaces ConfigManager)
int Database::get_config_int(const std::string& key, int default_value) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    auto entry = get_config_entry(key);
    if (!entry) {
        return default_value;
    }
    try {
        return std::stoi(entry->value);
    } catch (...) {
        vayu::utils::log_warning("Database: Failed to parse int for key " + key +
                                 ", using default");
        return default_value;
    }
}

std::string Database::get_config_string(const std::string& key, const std::string& default_value) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    auto entry = get_config_entry(key);
    if (!entry) {
        return default_value;
    }
    return entry->value;
}

bool Database::get_config_bool(const std::string& key, bool default_value) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    auto entry = get_config_entry(key);
    if (!entry) {
        return default_value;
    }
    return entry->value == "true";
}

double Database::get_config_double(const std::string& key, double default_value) {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    auto entry = get_config_entry(key);
    if (!entry) {
        return default_value;
    }
    try {
        return std::stod(entry->value);
    } catch (...) {
        vayu::utils::log_warning("Database: Failed to parse double for key " + key +
                                 ", using default");
        return default_value;
    }
}

void Database::seed_default_config() {
    std::lock_guard<std::recursive_mutex> lock(impl_->mutex);
    // Get existing config entries (if any) to preserve user-modified values
    auto existing = impl_->storage.get_all<ConfigEntry>();
    std::unordered_map<std::string, ConfigEntry> existing_map;
    for (const auto& entry : existing) {
        existing_map[entry.key] = entry;
    }

    auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                   std::chrono::system_clock::now().time_since_epoch())
                   .count();

    // Helper lambda: Creates or updates a config entry
    // - New entries get default values
    // - Existing entries preserve user-modified values but get updated metadata
    auto upsert_config = [&](const ConfigEntry& new_entry) {
        auto it = existing_map.find(new_entry.key);
        if (it != existing_map.end()) {
            // Preserve user's value but update metadata (description, label, etc.)
            ConfigEntry updated = new_entry;
            updated.value = it->second.value;            // Keep user's value
            updated.updated_at = it->second.updated_at;  // Keep original timestamp
            impl_->storage.replace(updated);
        } else {
            // New entry - use defaults
            impl_->storage.replace(new_entry);
        }
    };

    // =========================================================================
    // GENERAL & ENGINE CONFIGURATION
    // Core settings defining the application's base capacity and threading model
    // =========================================================================

    upsert_config(
        ConfigEntry{"workers",
                    std::to_string(std::thread::hardware_concurrency()),
                    "integer",
                    "Worker Threads (Requires Restart)",
                    "Number of background worker threads. Higher values improve throughput on "
                    "multi-core systems but increase RAM usage. "
                    "Default equals CPU core count. Changes require engine restart to take effect.",
                    "general_engine",
                    std::to_string(std::thread::hardware_concurrency()),
                    "1",
                    "128",
                    now});

    upsert_config(ConfigEntry{"maxConnections",
                              std::to_string(vayu::core::constants::server::MAX_CONNECTIONS),
                              "integer",
                              "Maximum Connections (Requires Restart)",
                              "Global limit for simultaneous internal connections. Increasing "
                              "beyond system limits (ulimit) may cause instability. "
                              "Changes require engine restart to take effect.",
                              "general_engine",
                              std::to_string(vayu::core::constants::server::MAX_CONNECTIONS),
                              "100",
                              "100000",
                              now});

    upsert_config(ConfigEntry{"defaultTimeout",
                              std::to_string(vayu::core::constants::server::DEFAULT_TIMEOUT_MS),
                              "integer",
                              "Default Request Timeout",
                              "Timeout for HTTP requests when not explicitly set. Increase for "
                              "slow endpoints; decrease for faster failure detection. "
                              "Value is in milliseconds (30000 = 30 seconds).",
                              "general_engine",
                              std::to_string(vayu::core::constants::server::DEFAULT_TIMEOUT_MS),
                              "1000",    // min: 1 second
                              "300000",  // max: 5 minutes
                              now});

    upsert_config(
        ConfigEntry{"requestBatchSize",
                    std::to_string(vayu::core::constants::db_streaming::REQUEST_BATCH_SIZE),
                    "integer",
                    "Request Batch Size",
                    "Batch size when fetching large collections from DB. Smaller batches save RAM; "
                    "larger batches load faster. "
                    "Default is optimized for most cases.",
                    "general_engine",
                    std::to_string(vayu::core::constants::db_streaming::REQUEST_BATCH_SIZE),
                    "1",
                    "1000",
                    now});

    // =========================================================================
    // DATABASE PERFORMANCE CONFIGURATION
    // SQLite optimization settings for high-throughput load testing
    // =========================================================================

    upsert_config(ConfigEntry{
        "dbCacheSize",
        std::to_string(vayu::core::constants::database::CACHE_SIZE_KB),
        "integer",
        "Database Cache Size",
        "Memory used to cache test results and metrics during high-RPS load tests. "
        "Enter a negative number in KB (e.g., -64000 = 64MB). Larger values reduce disk writes "
        "when storing thousands of results per second, improving test throughput. "
        "Recommended: 64-128MB for tests generating 10K+ results/second. Default: 64MB. Requires "
        "engine restart.",
        "database_performance",
        std::to_string(vayu::core::constants::database::CACHE_SIZE_KB),
        "-1048576",  // min: -1GB
        "-1000",     // max: -1MB
        now});

    upsert_config(ConfigEntry{
        "dbTempStore",
        std::to_string(vayu::core::constants::database::TEMP_STORE),
        "integer",
        "Temporary Tables Storage",
        "Where temporary data is stored when generating test reports and aggregating metrics. "
        "Options: 0 = Default (file), 1 = Always use file, 2 = Always use memory. "
        "Memory (2) significantly speeds up report generation and metric calculations during "
        "active tests. "
        "Recommended for high-frequency reporting. Default: Memory. Requires engine restart.",
        "database_performance",
        std::to_string(vayu::core::constants::database::TEMP_STORE),
        "0",
        "2",
        now});

    upsert_config(ConfigEntry{"dbMmapSize",
                              std::to_string(vayu::core::constants::database::MMAP_SIZE_BYTES),
                              "integer",
                              "Memory-Mapped I/O Size",
                              "Amount of database file accessed directly from memory when reading "
                              "test results and metrics. "
                              "Example: 268435456 = 256MB. Speeds up dashboard updates and report "
                              "generation by avoiding disk reads. "
                              "Larger values improve real-time metric streaming performance. "
                              "Recommended: 256-512MB for large test runs. "
                              "Default: 256MB. Requires engine restart.",
                              "database_performance",
                              std::to_string(vayu::core::constants::database::MMAP_SIZE_BYTES),
                              "0",           // min: disabled
                              "1073741824",  // max: 1GB
                              now});

    upsert_config(ConfigEntry{
        "dbWalAutocheckpoint",
        std::to_string(vayu::core::constants::database::WAL_AUTOCHECKPOINT),
        "integer",
        "WAL Checkpoint Frequency",
        "How often SQLite saves accumulated test results to the main database file (in pages). "
        "During high-RPS tests, results accumulate in the WAL file. Lower values save more "
        "frequently (reduces WAL size, but may slow writes). "
        "Higher values batch saves less often (faster result storage, but WAL file grows larger). "
        "Recommended: 1000-2000 for tests with 50K+ requests. Default: 1000 pages. Requires engine "
        "restart.",
        "database_performance",
        std::to_string(vayu::core::constants::database::WAL_AUTOCHECKPOINT),
        "100",
        "10000",
        now});

    upsert_config(ConfigEntry{
        "dbBusyTimeout",
        std::to_string(vayu::core::constants::database::BUSY_TIMEOUT_MS),
        "integer",
        "Database Lock Wait Time",
        "How long SQLite waits (in milliseconds) when multiple threads try to write test results "
        "simultaneously. "
        "During high-concurrency load tests, result storage threads compete for database access. "
        "Higher values prevent 'database is locked' errors but may delay error reporting. "
        "Recommended: 10-30 seconds for tests with 100+ concurrent requests. Default: 10 seconds. "
        "Requires engine restart.",
        "database_performance",
        std::to_string(vayu::core::constants::database::BUSY_TIMEOUT_MS),
        "1000",   // min: 1 second
        "60000",  // max: 60 seconds
        now});

    upsert_config(ConfigEntry{"dbSynchronous",
                              std::to_string(vayu::core::constants::database::SYNCHRONOUS),
                              "integer",
                              "Data Safety Mode",
                              "How aggressively SQLite ensures test results are written to disk. "
                              "Options: 0 = Off (fastest, safe with WAL mode), 1 = Normal "
                              "(balanced), 2 = Full (safest, slowest). "
                              "For load testing, Off (0) is recommended - WAL mode provides "
                              "durability while maximizing write throughput for storing results. "
                              "This setting directly impacts how fast results can be saved during "
                              "high-RPS tests. Default: Off. Requires engine restart.",
                              "database_performance",
                              std::to_string(vayu::core::constants::database::SYNCHRONOUS),
                              "0",
                              "2",
                              now});

    // =========================================================================
    // NETWORK & CONNECTIVITY CONFIGURATION
    // Low-level networking tuning for throughput, DNS, and connection persistence
    // =========================================================================

    upsert_config(ConfigEntry{"eventLoopMaxConcurrent",
                              std::to_string(vayu::core::constants::event_loop::MAX_CONCURRENT),
                              "integer",
                              "Max Concurrent Requests (Per Worker)",
                              "Throughput cap per worker. Higher values use more file descriptors. "
                              "Applied when starting a new load test run.",
                              "network_performance",
                              std::to_string(vayu::core::constants::event_loop::MAX_CONCURRENT),
                              "1",
                              "10000",
                              now});

    upsert_config(
        ConfigEntry{"eventLoopMaxPerHost",
                    std::to_string(vayu::core::constants::event_loop::MAX_PER_HOST),
                    "integer",
                    "Max Connections Per Host",
                    "Concurrency limit for a specific target API host. Critical for respecting "
                    "target rate limits. "
                    "Lower values are gentler on the target; higher values maximize throughput.",
                    "network_performance",
                    std::to_string(vayu::core::constants::event_loop::MAX_PER_HOST),
                    "1",
                    "1000",
                    now});

    upsert_config(
        ConfigEntry{"dnsCacheTimeout",
                    std::to_string(vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS),
                    "integer",
                    "DNS Cache Timeout",
                    "Duration to cache DNS lookups. Set to 0 to force resolution on every request. "
                    "Use higher values (60-300s) when testing stable endpoints.",
                    "network_performance",
                    std::to_string(vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS),
                    "0",     // Disable cache
                    "3600",  // 1 hour
                    now});

    upsert_config(ConfigEntry{
        "tcpKeepAliveIdle",
        std::to_string(vayu::core::constants::event_loop::TCP_KEEPALIVE_IDLE_SECONDS),
        "integer",
        "TCP Keep-Alive Idle Time",
        "Time before sending keep-alive probes on idle connections. Prevents firewall drops. "
        "Lower values detect dead connections faster.",
        "network_performance",
        std::to_string(vayu::core::constants::event_loop::TCP_KEEPALIVE_IDLE_SECONDS),
        "1",
        "300",
        now});

    upsert_config(ConfigEntry{
        "tcpKeepAliveInterval",
        std::to_string(vayu::core::constants::event_loop::TCP_KEEPALIVE_INTERVAL_SECONDS),
        "integer",
        "TCP Keep-Alive Interval",
        "Frequency of probes after idle timeout is reached. "
        "Usually set to the same value as Keep-Alive Idle Time.",
        "network_performance",
        std::to_string(vayu::core::constants::event_loop::TCP_KEEPALIVE_INTERVAL_SECONDS),
        "1",
        "300",
        now});

    // =========================================================================
    // SCRIPTING ENVIRONMENT CONFIGURATION
    // Configuration for the QuickJS sandbox execution, limits, and debugging
    // =========================================================================

    upsert_config(ConfigEntry{"scriptTimeout",
                              std::to_string(vayu::core::constants::script_engine::TIMEOUT_MS),
                              "integer",
                              "Script Execution Timeout",
                              "Max runtime for pre/post-request scripts. Prevents infinite loops. "
                              "Value is in milliseconds (5000 = 5 seconds).",
                              "scripting_sandbox",
                              std::to_string(vayu::core::constants::script_engine::TIMEOUT_MS),
                              "100",
                              "60000",
                              now});

    upsert_config(ConfigEntry{
        "scriptEnableConsole",
        vayu::core::constants::script_engine::ENABLE_CONSOLE ? "true" : "false",
        "boolean",
        "Enable Script Console",
        "Enables console.log() in scripts. Disable for max performance during load tests. "
        "When enabled, script console output is visible in the response viewer for debugging.",
        "scripting_sandbox",
        vayu::core::constants::script_engine::ENABLE_CONSOLE ? "true" : "false",
        std::nullopt,
        std::nullopt,
        now});

    upsert_config(ConfigEntry{
        "contextPoolSize",
        std::to_string(vayu::core::constants::server::CONTEXT_POOL_SIZE),
        "integer",
        "Script Context Pool Size",
        "Number of pre-initialized JS contexts. Increase for high-concurrency script workloads. "
        "Each context uses ~2-5MB of memory.",
        "scripting_sandbox",
        std::to_string(vayu::core::constants::server::CONTEXT_POOL_SIZE),
        "1",
        "256",
        now});

    upsert_config(ConfigEntry{"scriptMemoryLimit",
                              std::to_string(vayu::core::constants::script_engine::MEMORY_LIMIT),
                              "integer",
                              "Script Memory Limit",
                              "Max heap size per script execution. Default is 64MB. "
                              "Increase only for scripts processing very large data structures.",
                              "scripting_sandbox",
                              std::to_string(vayu::core::constants::script_engine::MEMORY_LIMIT),
                              "1048576",    // 1MB
                              "268435456",  // 256MB
                              now});

    upsert_config(ConfigEntry{
        "scriptStackSize",
        std::to_string(vayu::core::constants::script_engine::STACK_SIZE),
        "integer",
        "Script Stack Size",
        "Max call stack size. Increase only if scripts encounter stack overflows (recursion). "
        "Default is 256KB.",
        "scripting_sandbox",
        std::to_string(vayu::core::constants::script_engine::STACK_SIZE),
        "65536",    // 64KB
        "1048576",  // 1MB
        now});

    // =========================================================================
    // OBSERVABILITY & DATA CONFIGURATION
    // Settings for real-time dashboards (SSE), metrics aggregation, and data parsing limits
    // =========================================================================

    upsert_config(ConfigEntry{
        "statsInterval",
        std::to_string(vayu::core::constants::server::STATS_INTERVAL_MS),
        "integer",
        "Statistics Collection Interval",
        "Frequency of metric aggregation. Lower values = smoother UI but higher CPU overhead. "
        "Recommended: 100-500ms for most use cases.",
        "observability",
        std::to_string(vayu::core::constants::server::STATS_INTERVAL_MS),
        "10",
        "10000",
        now});

    upsert_config(ConfigEntry{"maxJsonFieldSize",
                              std::to_string(vayu::core::constants::json::MAX_FIELD_SIZE),
                              "integer",
                              "Maximum JSON Field Size",
                              "Maximum size for JSON strings stored in saved requests (params, "
                              "headers, body, auth) when loading from database. "
                              "Fields exceeding this limit are returned as empty objects or "
                              "strings to prevent out-of-memory errors. "
                              "Default 10MB. Increase only if saved requests with very large JSON "
                              "fields fail to load properly.",
                              "observability",
                              std::to_string(vayu::core::constants::json::MAX_FIELD_SIZE),
                              "1024",       // 1KB
                              "104857600",  // 100MB
                              now});

    upsert_config(ConfigEntry{"sseConnectTimeout",
                              std::to_string(vayu::core::constants::sse::CONNECT_TIMEOUT_MS),
                              "integer",
                              "SSE Connection Timeout",
                              "Timeout for establishing dashboard live streams. "
                              "Increase if the UI shows connection errors during heavy load tests. "
                              "Value is in milliseconds (30000 = 30 seconds).",
                              "observability",
                              std::to_string(vayu::core::constants::sse::CONNECT_TIMEOUT_MS),
                              "1000",
                              "300000",
                              now});

    upsert_config(ConfigEntry{
        "sseMaxRetry",
        std::to_string(vayu::core::constants::sse::MAX_RETRY_MS),
        "integer",
        "SSE Max Retry Interval",
        "Max exponential backoff wait time for dashboard reconnection. "
        "Lower values reconnect faster but may cause rapid retries if the engine is busy.",
        "observability",
        std::to_string(vayu::core::constants::sse::MAX_RETRY_MS),
        "1000",
        "300000",
        now});

    upsert_config(ConfigEntry{
        "sseSendLastEventId",
        vayu::core::constants::sse::SEND_LAST_EVENT_ID ? "true" : "false",
        "boolean",
        "SSE Send Last Event ID",
        "Resumes data streams from the last received event. Disable if using incompatible proxies.",
        "observability",
        vayu::core::constants::sse::SEND_LAST_EVENT_ID ? "true" : "false",
        std::nullopt,
        std::nullopt,
        now});

    if (existing.empty()) {
        vayu::utils::log_info("Seeded default configuration values");
    } else {
        vayu::utils::log_info("Updated configuration metadata for " +
                              std::to_string(existing.size()) + " existing entries");
    }
}

}  // namespace vayu::db
