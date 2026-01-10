#include "vayu/db/database.hpp"

#include <sqlite_orm/sqlite_orm.h>

#include <chrono>
#include <filesystem>
#include <iostream>
#include <thread>

#include "vayu/utils/logger.hpp"

namespace sqlite_orm {
// HttpMethod
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

// RunType
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

// RunStatus
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

// MetricName
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

// Helper to create storage
inline auto make_storage(const std::string& path) {
    return sqlite_orm::make_storage(
        path,
        // Project Management
        make_table("collections",
                   make_column("id", &Collection::id, primary_key()),
                   make_column("parent_id", &Collection::parent_id),
                   make_column("name", &Collection::name),
                   make_column("order", &Collection::order),
                   make_column("created_at", &Collection::created_at)),
        make_table("requests",
                   make_column("id", &Request::id, primary_key()),
                   make_column("collection_id", &Request::collection_id),
                   make_column("name", &Request::name),
                   make_column("method", &Request::method),
                   make_column("url", &Request::url),
                   make_column("headers", &Request::headers),
                   make_column("body", &Request::body),
                   make_column("auth", &Request::auth),
                   make_column("pre_request_script", &Request::pre_request_script),
                   make_column("post_request_script", &Request::post_request_script),
                   make_column("updated_at", &Request::updated_at)),
        make_table("environments",
                   make_column("id", &Environment::id, primary_key()),
                   make_column("name", &Environment::name),
                   make_column("variables", &Environment::variables),
                   make_column("updated_at", &Environment::updated_at)),
        // Execution Engine
        make_table("runs",
                   make_column("id", &Run::id, primary_key()),
                   make_column("request_id", &Run::request_id),
                   make_column("environment_id", &Run::environment_id),
                   make_column("type", &Run::type),
                   make_column("status", &Run::status),
                   make_column("config_snapshot", &Run::config_snapshot),
                   make_column("start_time", &Run::start_time),
                   make_column("end_time", &Run::end_time)),
        make_table("metrics",
                   make_column("id", &Metric::id, primary_key().autoincrement()),
                   make_column("run_id", &Metric::run_id),
                   make_column("timestamp", &Metric::timestamp),
                   make_column("name", &Metric::name),
                   make_column("value", &Metric::value),
                   make_column("labels", &Metric::labels)),
        make_table("results",
                   make_column("id", &Result::id, primary_key().autoincrement()),
                   make_column("run_id", &Result::run_id),
                   make_column("timestamp", &Result::timestamp),
                   make_column("status_code", &Result::status_code),
                   make_column("latency_ms", &Result::latency_ms),
                   make_column("error", &Result::error),
                   make_column("trace_data", &Result::trace_data)),
        make_table("kv_store",
                   make_column("key", &KVStore::key, primary_key()),
                   make_column("value", &KVStore::value)));
}

using Storage = decltype(make_storage(""));

struct Database::Impl {
    Storage storage;

    Impl(const std::string& path) : storage(make_storage(path)) {
        // Ensure parent directory exists
        std::filesystem::path db_path(path);
        if (db_path.has_parent_path()) {
            std::filesystem::create_directories(db_path.parent_path());
        }
    }
};

Database::Database(const std::string& db_path) : impl_(std::make_unique<Impl>(db_path)) {}

Database::~Database() = default;

void Database::init() {
    vayu::utils::log_debug("Initializing database, syncing schema...");
    impl_->storage.sync_schema();
    // Enable WAL mode for better concurrency
    impl_->storage.pragma.journal_mode(journal_mode::WAL);
    impl_->storage.pragma.synchronous(1);  // NORMAL
    impl_->storage.pragma.busy_timeout(5000);  // Wait up to 5 seconds on lock contention
    vayu::utils::log_debug("Database initialized with WAL mode");
}

// ==========================================
// Project Management
// ==========================================

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

void Database::delete_collection(const std::string& id) {
    vayu::utils::log_debug("Deleting collection: id=" + id);
    // First delete all requests in this collection
    impl_->storage.remove_all<Request>(where(c(&Request::collection_id) == id));
    // Then delete the collection itself
    impl_->storage.remove_all<Collection>(where(c(&Collection::id) == id));
}

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

// ==========================================
// Execution
// ==========================================

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

void Database::delete_run(const std::string& id) {
    // Delete associated metrics and results first
    impl_->storage.remove_all<Metric>(where(c(&Metric::run_id) == id));
    impl_->storage.remove_all<Result>(where(c(&Result::run_id) == id));
    // Delete the run itself
    impl_->storage.remove<Run>(id);
}

// Metrics
void Database::add_metric(const Metric& metric) {
    impl_->storage.insert(metric);
}

std::vector<Metric> Database::get_metrics(const std::string& run_id) {
    return impl_->storage.get_all<Metric>(where(c(&Metric::run_id) == run_id));
}

std::vector<Metric> Database::get_metrics_since(const std::string& run_id, int64_t last_id) {
    return impl_->storage.get_all<Metric>(
        where(c(&Metric::run_id) == run_id && c(&Metric::id) > last_id), order_by(&Metric::id));
}

// Results
void Database::add_result(const Result& result) {
    impl_->storage.insert(result);
}

void Database::add_results_batch(const std::vector<Result>& results) {
    if (results.empty()) return;

    // Use transaction for batch insert - much faster and prevents WAL growth
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

// Transaction helpers
void Database::begin_transaction() {
    impl_->storage.begin_transaction();
}

void Database::commit_transaction() {
    impl_->storage.commit();
}

void Database::rollback_transaction() {
    impl_->storage.rollback();
}

// KV Store
void Database::set_config(const std::string& key, const std::string& value) {
    impl_->storage.replace(KVStore{key, value});
}

std::optional<std::string> Database::get_config(const std::string& key) {
    auto configs = impl_->storage.get_all<KVStore>(where(c(&KVStore::key) == key));
    if (configs.empty()) return std::nullopt;
    return configs.front().value;
}

}  // namespace vayu::db
