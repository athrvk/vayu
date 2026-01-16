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
 *   kv_store     - Generic key-value settings
 * ────────────────────────────────────────────────────────────────────────
 */

#include "vayu/db/database.hpp"

#include <sqlite_orm/sqlite_orm.h>

#include <chrono>
#include <filesystem>
#include <iostream>
#include <thread>
#include <unordered_map>

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

        // KV Store: Generic key-value settings (legacy, kept for backward compatibility)
        make_table("kv_store",
                   make_column("key", &KVStore::key, primary_key()),
                   make_column("value", &KVStore::value)),

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

    Impl(const std::string& path) : storage(make_storage(path)) {
        std::filesystem::path db_path(path);
        if (db_path.has_parent_path()) {
            std::filesystem::create_directories(db_path.parent_path());
        }
    }
};

Database::Database(const std::string& db_path) : impl_(std::make_unique<Impl>(db_path)) {}

Database::~Database() = default;

// Initialize database with optimized SQLite settings
void Database::init() {
    vayu::utils::log_debug("Initializing database, syncing schema...");
    impl_->storage.sync_schema();

    // WAL mode for better concurrent read/write performance
    impl_->storage.pragma.journal_mode(journal_mode::WAL);
    impl_->storage.pragma.synchronous(1);      // NORMAL - balance safety/speed
    impl_->storage.pragma.busy_timeout(5000);  // Wait up to 5s on lock contention

    vayu::utils::log_debug("Database initialized with WAL mode");

    // Seed default configuration values if empty
    seed_default_config();
}

// ============================================================================
// Collections - Folder structure for organizing requests
// ============================================================================

void Database::create_collection(const Collection& c) {
    vayu::utils::log_debug("Creating collection: id=" + c.id + ", name=" + c.name);
    impl_->storage.replace(c);
}

std::vector<Collection> Database::get_collections() {
    return impl_->storage.get_all<Collection>(order_by(&Collection::order));
}

std::optional<Collection> Database::get_collection(const std::string& id) {
    auto cols = impl_->storage.get_all<Collection>(where(c(&Collection::id) == id));
    if (cols.empty()) return std::nullopt;
    return cols.front();
}

// Cascade delete: removes all requests in collection first
void Database::delete_collection(const std::string& id) {
    vayu::utils::log_debug("Deleting collection: id=" + id);
    impl_->storage.remove_all<Request>(where(c(&Request::collection_id) == id));
    impl_->storage.remove_all<Collection>(where(c(&Collection::id) == id));
}

// ============================================================================
// Requests - HTTP request definitions with pre/post scripts
// ============================================================================

void Database::save_request(const Request& r) {
    vayu::utils::log_debug("Saving request: id=" + r.id + ", name=" + r.name);
    impl_->storage.replace(r);
}

std::optional<Request> Database::get_request(const std::string& id) {
    auto requests = impl_->storage.get_all<Request>(where(c(&Request::id) == id));
    if (requests.empty()) return std::nullopt;
    return requests.front();
}

std::vector<Request> Database::get_requests_in_collection(const std::string& collection_id) {
    return impl_->storage.get_all<Request>(where(c(&Request::collection_id) == collection_id));
}

// Helper function to get all requests for iteration (needed because template can't access impl_)
std::vector<Request> Database::_get_all_requests_for_collection(const std::string& collection_id) {
    return impl_->storage.get_all<Request>(where(c(&Request::collection_id) == collection_id));
}

void Database::delete_request(const std::string& id) {
    vayu::utils::log_debug("Deleting request: id=" + id);
    impl_->storage.remove_all<Request>(where(c(&Request::id) == id));
}

// ============================================================================
// Environments - Named variable sets (dev, staging, prod)
// ============================================================================

void Database::save_environment(const Environment& e) {
    vayu::utils::log_debug("Saving environment: id=" + e.id + ", name=" + e.name);
    impl_->storage.replace(e);
}

std::vector<Environment> Database::get_environments() {
    return impl_->storage.get_all<Environment>();
}

std::optional<Environment> Database::get_environment(const std::string& id) {
    auto envs = impl_->storage.get_all<Environment>(where(c(&Environment::id) == id));
    if (envs.empty()) return std::nullopt;
    return envs.front();
}

void Database::delete_environment(const std::string& id) {
    vayu::utils::log_debug("Deleting environment: id=" + id);
    impl_->storage.remove_all<Environment>(where(c(&Environment::id) == id));
}

// ============================================================================
// Globals - App-wide variables (singleton row with id="globals")
// ============================================================================

void Database::save_globals(const Globals& g) {
    vayu::utils::log_debug("Saving globals");
    impl_->storage.replace(g);
}

std::optional<Globals> Database::get_globals() {
    auto globals = impl_->storage.get_all<Globals>(where(c(&Globals::id) == "globals"));
    if (globals.empty()) return std::nullopt;
    return globals.front();
}

// ============================================================================
// Runs - Test execution sessions (load tests or design mode requests)
// ============================================================================

void Database::create_run(const Run& run) {
    vayu::utils::log_debug("Creating run: id=" + run.id +
                           ", type=" + std::string(vayu::to_string(run.type)));
    impl_->storage.replace(run);
}

std::optional<Run> Database::get_run(const std::string& id) {
    auto runs = impl_->storage.get_all<Run>(where(c(&Run::id) == id));
    if (runs.empty()) return std::nullopt;
    return runs.front();
}

void Database::update_run_status(const std::string& id, RunStatus status) {
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
    return impl_->storage.get_all<Run>(order_by(&Run::start_time).desc());
}

// Cascade delete: removes metrics and results first
void Database::delete_run(const std::string& id) {
    impl_->storage.remove_all<Metric>(where(c(&Metric::run_id) == id));
    impl_->storage.remove_all<Result>(where(c(&Result::run_id) == id));
    impl_->storage.remove<Run>(id);
}

// ============================================================================
// Metrics - Time-series performance data (RPS, latency percentiles, etc.)
// ============================================================================

void Database::add_metric(const Metric& metric) {
    impl_->storage.insert(metric);
}

std::vector<Metric> Database::get_metrics(const std::string& run_id) {
    return impl_->storage.get_all<Metric>(where(c(&Metric::run_id) == run_id));
}

// Get metrics added after a specific ID (for incremental updates)
std::vector<Metric> Database::get_metrics_since(const std::string& run_id, int64_t last_id) {
    return impl_->storage.get_all<Metric>(
        where(c(&Metric::run_id) == run_id && c(&Metric::id) > last_id), order_by(&Metric::id));
}

// ============================================================================
// Results - Individual request outcomes with timing breakdown
// ============================================================================

void Database::add_result(const Result& result) {
    impl_->storage.insert(result);
}

// Batch insert with transaction for better performance
void Database::add_results_batch(const std::vector<Result>& results) {
    if (results.empty()) return;

    impl_->storage.transaction([&] {
        for (const auto& result : results) {
            impl_->storage.insert(result);
        }
        return true;  // Commit
    });
}

std::vector<Result> Database::get_results(const std::string& run_id) {
    return impl_->storage.get_all<Result>(where(c(&Result::run_id) == run_id));
}

// ============================================================================
// Transaction Helpers
// ============================================================================

void Database::begin_transaction() {
    impl_->storage.begin_transaction();
}

void Database::commit_transaction() {
    impl_->storage.commit();
}

void Database::rollback_transaction() {
    impl_->storage.rollback();
}

// ============================================================================
// KV Store - Generic key-value settings
// ============================================================================

void Database::set_config(const std::string& key, const std::string& value) {
    impl_->storage.replace(KVStore{key, value});
}

std::optional<std::string> Database::get_config(const std::string& key) {
    auto configs = impl_->storage.get_all<KVStore>(where(c(&KVStore::key) == key));
    if (configs.empty()) return std::nullopt;
    return configs.front().value;
}

// ============================================================================
// Config Entries - Structured configuration with metadata
// ============================================================================

void Database::save_config_entry(const ConfigEntry& entry) {
    impl_->storage.replace(entry);
}

std::optional<ConfigEntry> Database::get_config_entry(const std::string& key) {
    auto entries = impl_->storage.get_all<ConfigEntry>(where(c(&ConfigEntry::key) == key));
    if (entries.empty()) return std::nullopt;
    return entries.front();
}

std::vector<ConfigEntry> Database::get_all_config_entries() {
    return impl_->storage.get_all<ConfigEntry>();
}

void Database::seed_default_config() {
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
            updated.value = it->second.value;  // Keep user's value
            updated.updated_at = it->second.updated_at;  // Keep original timestamp
            impl_->storage.replace(updated);
        } else {
            // New entry - use defaults
            impl_->storage.replace(new_entry);
        }
    };

    // =========================================================================
    // SERVER CONFIGURATION
    // Settings that control core server behavior and timeouts
    // =========================================================================

    upsert_config(ConfigEntry{
        "defaultTimeout",
        std::to_string(vayu::core::constants::server::DEFAULT_TIMEOUT_MS),
        "integer",
        "Default Request Timeout",
        "Default timeout for HTTP requests when not explicitly set in the request. "
        "This applies to individual API calls and design mode executions. "
        "Increase for slow endpoints; decrease for faster failure detection. "
        "Value is in milliseconds (1000ms = 1 second).",
        "server",
        std::to_string(vayu::core::constants::server::DEFAULT_TIMEOUT_MS),
        "1000",    // min: 1 second
        "300000",  // max: 5 minutes
        now});

    upsert_config(ConfigEntry{
        "workers",
        std::to_string(std::thread::hardware_concurrency()),
        "integer",
        "Worker Threads (Requires Restart)",
        "Number of background worker threads for processing requests. "
        "More threads can improve throughput on multi-core systems but increase memory usage. "
        "Default is your CPU core count. Changes require engine restart to take effect. "
        "⚠️ Advanced: Only modify if you understand threading implications.",
        "server",
        std::to_string(std::thread::hardware_concurrency()),
        "1",
        "128",
        now});

    upsert_config(ConfigEntry{
        "maxConnections",
        std::to_string(vayu::core::constants::server::MAX_CONNECTIONS),
        "integer",
        "Maximum Connections (Requires Restart)",
        "Maximum number of simultaneous connections the engine can handle internally. "
        "Affects how many parallel operations (requests, scripts) can run. "
        "Default is suitable for most use cases. Changes require engine restart. "
        "⚠️ Advanced: Increasing beyond system limits may cause instability.",
        "server",
        std::to_string(vayu::core::constants::server::MAX_CONNECTIONS),
        "100",
        "100000",
        now});

    upsert_config(ConfigEntry{
        "statsInterval",
        std::to_string(vayu::core::constants::server::STATS_INTERVAL_MS),
        "integer",
        "Statistics Collection Interval",
        "How often (in milliseconds) the engine collects and aggregates performance metrics. "
        "Lower values provide more real-time data but increase CPU overhead. "
        "Higher values reduce overhead but make dashboards less responsive. "
        "Recommended: 100-500ms for most use cases.",
        "server",
        std::to_string(vayu::core::constants::server::STATS_INTERVAL_MS),
        "10",
        "10000",
        now});

    upsert_config(ConfigEntry{
        "sseConnectTimeout",
        std::to_string(vayu::core::constants::sse::CONNECT_TIMEOUT_MS),
        "integer",
        "SSE Connection Timeout",
        "Timeout for establishing Server-Sent Events (SSE) connections used for live metrics streaming. "
        "SSE keeps the dashboard updated in real-time during load tests. "
        "Increase if the UI shows connection errors during heavy load tests. "
        "Value is in milliseconds (30000 = 30 seconds).",
        "server",
        std::to_string(vayu::core::constants::sse::CONNECT_TIMEOUT_MS),
        "1000",
        "300000",
        now});

    upsert_config(ConfigEntry{
        "sseMaxRetry",
        std::to_string(vayu::core::constants::sse::MAX_RETRY_MS),
        "integer",
        "SSE Max Retry Interval",
        "Maximum wait time between reconnection attempts when the live metrics stream disconnects. "
        "The retry interval starts small and increases up to this maximum (exponential backoff). "
        "Lower values reconnect faster but may cause rapid retries if the engine is busy.",
        "server",
        std::to_string(vayu::core::constants::sse::MAX_RETRY_MS),
        "1000",
        "300000",
        now});

    upsert_config(ConfigEntry{
        "sseSendLastEventId",
        vayu::core::constants::sse::SEND_LAST_EVENT_ID ? "true" : "false",
        "boolean",
        "SSE Send Last Event ID",
        "When enabled, the client sends Last-Event-ID header on SSE reconnect, "
        "allowing the server to resume from where it left off. "
        "Disable only if experiencing compatibility issues with proxies.",
        "server",
        vayu::core::constants::sse::SEND_LAST_EVENT_ID ? "true" : "false",
        std::nullopt,
        std::nullopt,
        now});

    // =========================================================================
    // SCRIPTING CONFIGURATION
    // Settings that control JavaScript pre/post-request script execution
    // =========================================================================

    upsert_config(ConfigEntry{
        "contextPoolSize",
        std::to_string(vayu::core::constants::server::CONTEXT_POOL_SIZE),
        "integer",
        "Script Context Pool Size",
        "Number of pre-initialized JavaScript execution contexts kept in memory. "
        "More contexts allow higher concurrency for script execution in load tests. "
        "Each context uses ~2-5MB of memory. Increase for script-heavy workloads. "
        "Changes take effect on next script execution.",
        "scripting",
        std::to_string(vayu::core::constants::server::CONTEXT_POOL_SIZE),
        "1",
        "256",
        now});

    upsert_config(ConfigEntry{
        "scriptTimeout",
        std::to_string(vayu::core::constants::script_engine::TIMEOUT_MS),
        "integer",
        "Script Execution Timeout",
        "Maximum time a pre-request or post-request script can run before being terminated. "
        "Prevents infinite loops and runaway scripts from hanging the engine. "
        "Increase for complex scripts with async operations; decrease for tighter control. "
        "Value is in milliseconds.",
        "scripting",
        std::to_string(vayu::core::constants::script_engine::TIMEOUT_MS),
        "100",
        "60000",
        now});

    upsert_config(ConfigEntry{
        "scriptMemoryLimit",
        std::to_string(vayu::core::constants::script_engine::MEMORY_LIMIT),
        "integer",
        "Script Memory Limit",
        "Maximum memory (in bytes) a single script execution can allocate. "
        "Prevents memory leaks and excessive allocations from crashing the engine. "
        "64MB (67108864) is usually sufficient. Increase only for scripts processing large data. "
        "⚠️ Advanced: Setting too high may cause system instability.",
        "scripting",
        std::to_string(vayu::core::constants::script_engine::MEMORY_LIMIT),
        "1048576",   // 1MB
        "268435456",  // 256MB
        now});

    upsert_config(ConfigEntry{
        "scriptStackSize",
        std::to_string(vayu::core::constants::script_engine::STACK_SIZE),
        "integer",
        "Script Stack Size",
        "Maximum call stack size (in bytes) for script execution. "
        "Limits recursion depth to prevent stack overflow crashes. "
        "Default is 256KB. Only increase if your scripts have deep recursion. "
        "⚠️ Advanced: Modify only if you see 'stack overflow' errors.",
        "scripting",
        std::to_string(vayu::core::constants::script_engine::STACK_SIZE),
        "65536",   // 64KB
        "1048576",  // 1MB
        now});

    upsert_config(ConfigEntry{
        "scriptEnableConsole",
        vayu::core::constants::script_engine::ENABLE_CONSOLE ? "true" : "false",
        "boolean",
        "Enable Script Console",
        "Allow scripts to use console.log(), console.error(), etc. "
        "When enabled, console output appears in the response's consoleLogs array. "
        "Useful for debugging pre-request and post-request scripts. "
        "Disable for slightly better performance during heavy load tests.",
        "scripting",
        vayu::core::constants::script_engine::ENABLE_CONSOLE ? "true" : "false",
        std::nullopt,
        std::nullopt,
        now});

    // =========================================================================
    // PERFORMANCE CONFIGURATION
    // Settings that control load testing performance and resource usage
    // =========================================================================

    upsert_config(ConfigEntry{
        "eventLoopMaxConcurrent",
        std::to_string(vayu::core::constants::event_loop::MAX_CONCURRENT),
        "integer",
        "Max Concurrent Requests",
        "Maximum number of in-flight HTTP requests per worker during load tests. "
        "Higher values increase throughput but use more memory and file descriptors. "
        "Start with 100-500 and increase based on your system's capacity. "
        "Applied when starting a new load test run.",
        "performance",
        std::to_string(vayu::core::constants::event_loop::MAX_CONCURRENT),
        "1",
        "10000",
        now});

    upsert_config(ConfigEntry{
        "eventLoopMaxPerHost",
        std::to_string(vayu::core::constants::event_loop::MAX_PER_HOST),
        "integer",
        "Max Connections Per Host",
        "Maximum simultaneous connections to a single target API host during load tests. "
        "Prevents overwhelming the API you're testing. "
        "Lower values are gentler on the target; higher values maximize throughput. "
        "Check your target API's rate limits before increasing.",
        "performance",
        std::to_string(vayu::core::constants::event_loop::MAX_PER_HOST),
        "1",
        "1000",
        now});

    upsert_config(ConfigEntry{
        "dnsCacheTimeout",
        std::to_string(vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS),
        "integer",
        "DNS Cache Timeout",
        "How long (in seconds) to cache DNS lookups for target API hostnames. "
        "Caching avoids repeated DNS queries during high-RPS load tests. "
        "Set to 0 to disable (resolve every request). "
        "Use higher values (60-300s) when testing stable endpoints.",
        "performance",
        std::to_string(vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS),
        "0",     // Disable cache
        "3600",  // 1 hour
        now});

    upsert_config(ConfigEntry{
        "tcpKeepAliveIdle",
        std::to_string(vayu::core::constants::event_loop::TCP_KEEPALIVE_IDLE_SECONDS),
        "integer",
        "TCP Keep-Alive Idle Time",
        "Seconds before sending keep-alive probes on idle connections to target APIs. "
        "Prevents connections from being dropped by firewalls or load balancers. "
        "Lower values detect dead connections faster. "
        "Set to 0 to disable (not recommended for long-running tests).",
        "performance",
        std::to_string(vayu::core::constants::event_loop::TCP_KEEPALIVE_IDLE_SECONDS),
        "1",
        "300",
        now});

    upsert_config(ConfigEntry{
        "tcpKeepAliveInterval",
        std::to_string(vayu::core::constants::event_loop::TCP_KEEPALIVE_INTERVAL_SECONDS),
        "integer",
        "TCP Keep-Alive Interval",
        "Seconds between keep-alive probes after the idle timeout is reached. "
        "Applies to connections to target APIs during load tests. "
        "Lower values detect unresponsive servers faster. "
        "Usually set to the same value as Keep-Alive Idle Time.",
        "performance",
        std::to_string(vayu::core::constants::event_loop::TCP_KEEPALIVE_INTERVAL_SECONDS),
        "1",
        "300",
        now});

    upsert_config(ConfigEntry{
        "maxJsonFieldSize",
        std::to_string(vayu::core::constants::json::MAX_FIELD_SIZE),
        "integer",
        "Maximum JSON Field Size",
        "Maximum size (in bytes) for individual JSON fields when parsing request/response data. "
        "Prevents out-of-memory errors from extremely large JSON payloads. "
        "10MB (10485760) handles most APIs. Increase only for APIs with very large responses. "
        "⚠️ Setting too high may cause memory issues with large collections.",
        "performance",
        std::to_string(vayu::core::constants::json::MAX_FIELD_SIZE),
        "1024",      // 1KB
        "104857600",  // 100MB
        now});

    upsert_config(ConfigEntry{
        "requestBatchSize",
        std::to_string(vayu::core::constants::db_streaming::REQUEST_BATCH_SIZE),
        "integer",
        "Request Batch Size",
        "Number of requests fetched at a time when loading large collections. "
        "Smaller batches use less memory but require more database queries. "
        "Larger batches are faster but use more memory. "
        "Adjust based on your typical collection sizes. Default is optimized for most cases.",
        "performance",
        std::to_string(vayu::core::constants::db_streaming::REQUEST_BATCH_SIZE),
        "1",
        "1000",
        now});

    if (existing.empty()) {
        vayu::utils::log_info("Seeded default configuration values");
    } else {
        vayu::utils::log_info("Updated configuration metadata for " + 
                              std::to_string(existing.size()) + " existing entries");
    }
}

}  // namespace vayu::db
