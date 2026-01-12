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

        // KV Store: Generic key-value settings
        make_table("kv_store",
                   make_column("key", &KVStore::key, primary_key()),
                   make_column("value", &KVStore::value)),

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

}  // namespace vayu::db
