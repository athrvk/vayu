#include "vayu/db/database.hpp"
#include <sqlite_orm/sqlite_orm.h>
#include <iostream>
#include <chrono>

using namespace sqlite_orm;

namespace vayu::db
{

    // Helper to create storage
    inline auto make_storage(const std::string &path)
    {
        return sqlite_orm::make_storage(path,
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

    struct Database::Impl
    {
        Storage storage;

        Impl(const std::string &path) : storage(make_storage(path)) {}
    };

    Database::Database(const std::string &db_path) : impl_(std::make_unique<Impl>(db_path)) {}

    Database::~Database() = default;

    void Database::init()
    {
        impl_->storage.sync_schema();
        // Enable WAL mode for better concurrency
        impl_->storage.pragma.journal_mode(journal_mode::WAL);
        impl_->storage.pragma.synchronous(1); // NORMAL
    }

    // ==========================================
    // Project Management
    // ==========================================

    void Database::create_collection(const Collection &c)
    {
        impl_->storage.replace(c);
    }

    std::vector<Collection> Database::get_collections()
    {
        return impl_->storage.get_all<Collection>(order_by(&Collection::order));
    }

    void Database::save_request(const Request &r)
    {
        impl_->storage.replace(r);
    }

    std::optional<Request> Database::get_request(const std::string &id)
    {
        auto requests = impl_->storage.get_all<Request>(where(c(&Request::id) == id));
        if (requests.empty())
            return std::nullopt;
        return requests.front();
    }

    std::vector<Request> Database::get_requests_in_collection(const std::string &collection_id)
    {
        return impl_->storage.get_all<Request>(where(c(&Request::collection_id) == collection_id));
    }

    void Database::save_environment(const Environment &e)
    {
        impl_->storage.replace(e);
    }

    std::vector<Environment> Database::get_environments()
    {
        return impl_->storage.get_all<Environment>();
    }

    std::optional<Environment> Database::get_environment(const std::string &id)
    {
        auto envs = impl_->storage.get_all<Environment>(where(c(&Environment::id) == id));
        if (envs.empty())
            return std::nullopt;
        return envs.front();
    }

    // ==========================================
    // Execution
    // ==========================================

    void Database::create_run(const Run &run)
    {
        impl_->storage.replace(run);
    }

    std::optional<Run> Database::get_run(const std::string &id)
    {
        auto runs = impl_->storage.get_all<Run>(where(c(&Run::id) == id));
        if (runs.empty())
            return std::nullopt;
        return runs.front();
    }

    void Database::update_run_status(const std::string &id, const std::string &status)
    {
        auto run = get_run(id);
        if (run)
        {
            run->status = status;
            run->end_time = std::chrono::duration_cast<std::chrono::milliseconds>(
                                std::chrono::system_clock::now().time_since_epoch())
                                .count();
            impl_->storage.update(*run);
        }
    }

    std::vector<Run> Database::get_all_runs()
    {
        return impl_->storage.get_all<Run>(order_by(&Run::start_time).desc());
    }

    // Metrics
    void Database::add_metric(const Metric &metric)
    {
        impl_->storage.insert(metric);
    }

    std::vector<Metric> Database::get_metrics(const std::string &run_id)
    {
        return impl_->storage.get_all<Metric>(where(c(&Metric::run_id) == run_id));
    }

    std::vector<Metric> Database::get_metrics_since(const std::string &run_id, int64_t last_id)
    {
        return impl_->storage.get_all<Metric>(
            where(c(&Metric::run_id) == run_id && c(&Metric::id) > last_id),
            order_by(&Metric::id));
    }

    // Results
    void Database::add_result(const Result &result)
    {
        impl_->storage.insert(result);
    }

    std::vector<Result> Database::get_results(const std::string &run_id)
    {
        return impl_->storage.get_all<Result>(where(c(&Result::run_id) == run_id));
    }

    // KV Store
    void Database::set_config(const std::string &key, const std::string &value)
    {
        impl_->storage.replace(KVStore{key, value});
    }

    std::optional<std::string> Database::get_config(const std::string &key)
    {
        auto configs = impl_->storage.get_all<KVStore>(where(c(&KVStore::key) == key));
        if (configs.empty())
            return std::nullopt;
        return configs.front().value;
    }

} // namespace vayu::db
