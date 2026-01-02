#pragma once

#include <string>
#include <vector>
#include <optional>
#include <memory>

namespace vayu::db
{

    // ==========================================
    // Project Management (CMS Layer)
    // ==========================================

    struct Collection
    {
        std::string id;
        std::optional<std::string> parent_id;
        std::string name;
        int order;
        int64_t created_at;
    };

    struct Request
    {
        std::string id;
        std::string collection_id;
        std::string name;
        std::string method;
        std::string url;
        std::string headers;             // JSON
        std::string body;                // JSON/Text
        std::string auth;                // JSON
        std::string pre_request_script;  // JS Code
        std::string post_request_script; // JS Code (Tests)
        int64_t updated_at;
    };

    struct Environment
    {
        std::string id;
        std::string name;
        std::string variables; // JSON
        int64_t updated_at;
    };

    // ==========================================
    // Execution Engine (Runtime Layer)
    // ==========================================

    struct Run
    {
        std::string id;
        std::optional<std::string> request_id;     // Linked request (if design mode)
        std::optional<std::string> environment_id; // Environment used
        std::string type;                          // "design" or "load"
        std::string status;                        // "pending", "running", "completed", "failed"
        std::string config_snapshot;               // JSON string (Full copy of request/env)
        int64_t start_time;
        int64_t end_time;
    };

    struct Metric
    {
        int id;
        std::string run_id;
        int64_t timestamp;
        std::string name; // "rps", "latency", "error_rate"
        double value;
        std::string labels; // JSON string
    };

    struct Result
    {
        int id;
        std::string run_id;
        int64_t timestamp;
        int status_code;
        double latency_ms;
        std::string error;
        std::string trace_data; // JSON (Headers/Body - only for Design Mode or Errors)
    };

    struct KVStore
    {
        std::string key;
        std::string value;
    };

    class Database
    {
    public:
        explicit Database(const std::string &db_path);
        ~Database();

        // Initialize database (create tables, etc.)
        void init();

        // Project Management
        void create_collection(const Collection &c);
        std::vector<Collection> get_collections();

        void save_request(const Request &r);
        std::optional<Request> get_request(const std::string &id);
        std::vector<Request> get_requests_in_collection(const std::string &collection_id);

        void save_environment(const Environment &e);
        std::vector<Environment> get_environments();
        std::optional<Environment> get_environment(const std::string &id);

        // Execution
        void create_run(const Run &run);
        std::optional<Run> get_run(const std::string &id);
        void update_run_status(const std::string &id, const std::string &status);
        std::vector<Run> get_all_runs();

        // Metrics
        void add_metric(const Metric &metric);
        std::vector<Metric> get_metrics(const std::string &run_id);
        std::vector<Metric> get_metrics_since(const std::string &run_id, int64_t last_id);

        // Results
        void add_result(const Result &result);
        std::vector<Result> get_results(const std::string &run_id);

        // KV Store
        void set_config(const std::string &key, const std::string &value);
        std::optional<std::string> get_config(const std::string &key);

    private:
        struct Impl;
        std::unique_ptr<Impl> impl_;
    };

} // namespace vayu::db
