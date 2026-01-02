#include "vayu/http/server.hpp"
#include "vayu/http/client.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/version.hpp"
#include <nlohmann/json.hpp>
#include <iostream>
#include <chrono>

namespace vayu::http
{

    namespace
    {
        inline int64_t now_ms()
        {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::system_clock::now().time_since_epoch())
                .count();
        }

        nlohmann::json to_json(const vayu::db::Collection &c)
        {
            return {
                {"id", c.id},
                {"parentId", c.parent_id ? *c.parent_id : nullptr},
                {"name", c.name},
                {"order", c.order},
                {"createdAt", c.created_at}};
        }

        nlohmann::json to_json(const vayu::db::Request &r)
        {
            return {
                {"id", r.id},
                {"collectionId", r.collection_id},
                {"name", r.name},
                {"method", r.method},
                {"url", r.url},
                {"headers", r.headers.empty() ? nlohmann::json::object() : nlohmann::json::parse(r.headers)},
                {"body", r.body.empty() ? nlohmann::json() : nlohmann::json::parse(r.body)},
                {"auth", r.auth.empty() ? nlohmann::json::object() : nlohmann::json::parse(r.auth)},
                {"preRequestScript", r.pre_request_script},
                {"postRequestScript", r.post_request_script},
                {"updatedAt", r.updated_at}};
        }

        nlohmann::json to_json(const vayu::db::Environment &e)
        {
            return {
                {"id", e.id},
                {"name", e.name},
                {"variables", e.variables.empty() ? nlohmann::json::object() : nlohmann::json::parse(e.variables)},
                {"updatedAt", e.updated_at}};
        }
    }

    Server::Server(vayu::db::Database &db, vayu::core::RunManager &run_manager, int port, bool verbose)
        : db_(db), run_manager_(run_manager), port_(port), verbose_(verbose)
    {
        setup_routes();
    }

    Server::~Server()
    {
        stop();
    }

    void Server::start()
    {
        if (is_running_)
            return;

        is_running_ = true;
        server_thread_ = std::thread([this]()
                                     {
        std::cout << "Vayu Engine " << vayu::Version::string << "\n";
        std::cout << "Listening on http://127.0.0.1:" << port_ << "\n";
        server_.listen("127.0.0.1", port_);
        is_running_ = false; });
    }

    void Server::stop()
    {
        if (is_running_)
        {
            server_.stop();
            if (server_thread_.joinable())
            {
                server_thread_.join();
            }
            is_running_ = false;
        }
    }

    bool Server::is_running() const
    {
        return is_running_;
    }

    void Server::setup_routes()
    {
        // Health check endpoint
        server_.Get("/health", [](const httplib::Request &, httplib::Response &res)
                    {
        nlohmann::json response;
        response["status"] = "ok";
        response["version"] = vayu::Version::string;
        response["workers"] = std::thread::hardware_concurrency();
        
        res.set_content(response.dump(), "application/json"); });

        // ==========================================
        // Project Management Endpoints
        // ==========================================

        // Collections
        server_.Get("/collections", [this](const httplib::Request &, httplib::Response &res)
                    {
        auto collections = db_.get_collections();
        nlohmann::json response = nlohmann::json::array();
        for (const auto& c : collections) {
            response.push_back(to_json(c));
        }
        res.set_content(response.dump(), "application/json"); });

        server_.Post("/collections", [this](const httplib::Request &req, httplib::Response &res)
                     {
        try {
            auto json = nlohmann::json::parse(req.body);
            vayu::db::Collection c;
            c.id = json["id"];
            if (json.contains("parentId") && !json["parentId"].is_null()) {
                c.parent_id = json["parentId"];
            }
            c.name = json["name"];
            c.order = json.value("order", 0);
            c.created_at = now_ms();
            
            db_.create_collection(c);
            res.set_content(to_json(c).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        } });

        // Requests
        server_.Get("/requests", [this](const httplib::Request &req, httplib::Response &res)
                    {
        if (req.has_param("collectionId")) {
            auto requests = db_.get_requests_in_collection(req.get_param_value("collectionId"));
            nlohmann::json response = nlohmann::json::array();
            for (const auto& r : requests) {
                response.push_back(to_json(r));
            }
            res.set_content(response.dump(), "application/json");
        } else {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", "collectionId required"}}.dump(), "application/json");
        } });

        server_.Post("/requests", [this](const httplib::Request &req, httplib::Response &res)
                     {
        try {
            auto json = nlohmann::json::parse(req.body);
            vayu::db::Request r;
            r.id = json["id"];
            r.collection_id = json["collectionId"];
            r.name = json["name"];
            r.method = json["method"];
            r.url = json["url"];
            r.headers = json.value("headers", nlohmann::json::object()).dump();
            r.body = json.value("body", nlohmann::json()).dump();
            r.auth = json.value("auth", nlohmann::json::object()).dump();
            r.pre_request_script = json.value("preRequestScript", "");
            r.post_request_script = json.value("postRequestScript", "");
            r.updated_at = now_ms();
            
            db_.save_request(r);
            res.set_content(to_json(r).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        } });

        // Environments
        server_.Get("/environments", [this](const httplib::Request &, httplib::Response &res)
                    {
        auto envs = db_.get_environments();
        nlohmann::json response = nlohmann::json::array();
        for (const auto& e : envs) {
            response.push_back(to_json(e));
        }
        res.set_content(response.dump(), "application/json"); });

        server_.Post("/environments", [this](const httplib::Request &req, httplib::Response &res)
                     {
        try {
            auto json = nlohmann::json::parse(req.body);
            vayu::db::Environment e;
            e.id = json["id"];
            e.name = json["name"];
            e.variables = json.value("variables", nlohmann::json::object()).dump();
            e.updated_at = now_ms();
            
            db_.save_environment(e);
            res.set_content(to_json(e).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        } });

        // ==========================================
        // Execution Endpoints
        // ==========================================

        // Single request endpoint (Design Mode)
        server_.Post("/request", [this](const httplib::Request &req, httplib::Response &res)
                     {
        try {
            // Parse request body
            auto json = nlohmann::json::parse(req.body);
            
            // Deserialize to vayu::Request
            auto request_result = vayu::json::deserialize_request(json);
            if (request_result.is_error()) {
                res.status = 400;
                res.set_content(vayu::json::serialize(request_result.error()).dump(), 
                               "application/json");
                return;
            }

            // Create Run (Design Mode)
            std::string run_id = "run_" + std::to_string(now_ms());
            vayu::db::Run run;
            run.id = run_id;
            run.type = "design";
            run.status = "running";
            run.start_time = now_ms();
            run.config_snapshot = req.body;
            
            if (json.contains("requestId")) {
                run.request_id = json["requestId"];
            }
            if (json.contains("environmentId")) {
                run.environment_id = json["environmentId"];
            }
            
            db_.create_run(run);
            
            // Send request
            vayu::http::ClientConfig config;
            config.verbose = verbose_;
            vayu::http::Client client(config);
            
            auto response_result = client.send(request_result.value());
            
            if (response_result.is_error()) {
                db_.update_run_status(run_id, "failed");
                res.status = 502;
                res.set_content(vayu::json::serialize(response_result.error()).dump(),
                               "application/json");
                return;
            }

            // Store result
            try {
                vayu::db::Result db_result;
                db_result.run_id = run_id;
                db_result.timestamp = now_ms();
                db_result.status_code = response_result.value().status_code;
                db_result.latency_ms = response_result.value().timing.total_ms;
                db_result.error = "";
                // Store full trace for Design Mode
                nlohmann::json trace;
                trace["headers"] = response_result.value().headers;
                trace["body"] = response_result.value().body;
                db_result.trace_data = trace.dump();
                
                db_.add_result(db_result);
                db_.update_run_status(run_id, "completed");
            } catch (const std::exception& e) {
                std::cerr << "Failed to save result: " << e.what() << "\n";
            }
            
            // Return response
            res.set_content(vayu::json::serialize(response_result.value()).dump(2),
                           "application/json");
                           
        } catch (const std::exception& e) {
            res.status = 400;
            nlohmann::json error;
            error["error"]["code"] = "INVALID_REQUEST";
            error["error"]["message"] = e.what();
            res.set_content(error.dump(), "application/json");
        } });

        // Load test endpoint (Vayu Mode)
        server_.Post("/run", [this](const httplib::Request &req, httplib::Response &res)
                     {
        // Create run entry
        std::string run_id = "run_" + std::to_string(now_ms());
        
        try {
            auto json = nlohmann::json::parse(req.body);
            
            // Validate required fields
            if (!json.contains("request"))
            {
                res.status = 400;
                nlohmann::json error;
                error["error"] = "Missing required field: request";
                res.set_content(error.dump(), "application/json");
                return;
            }
            
            if (!json.contains("mode") && !json.contains("duration") && !json.contains("iterations"))
            {
                res.status = 400;
                nlohmann::json error;
                error["error"] = "Must specify either 'mode' with 'duration' or 'iterations'";
                res.set_content(error.dump(), "application/json");
                return;
            }
            
            // Create DB run record
            vayu::db::Run run;
            run.id = run_id;
            run.type = "load";
            run.status = "pending";
            run.config_snapshot = req.body;
            run.start_time = now_ms();
            run.end_time = run.start_time;
            
            if (json.contains("requestId")) {
                run.request_id = json["requestId"];
            }
            if (json.contains("environmentId")) {
                run.environment_id = json["environmentId"];
            }
            
            db_.create_run(run);
            
            // Start run via RunManager
            run_manager_.start_run(run_id, json, db_, verbose_);
            
            // Return 202 Accepted
            nlohmann::json response;
            response["runId"] = run_id;
            response["status"] = "pending";
            response["message"] = "Load test started";
            
            res.status = 202;
            res.set_content(response.dump(), "application/json");
            
        } catch (const std::exception& e) {
            res.status = 500;
            nlohmann::json error;
            error["error"] = "Failed to create run: " + std::string(e.what());
            res.set_content(error.dump(), "application/json");
            return;
        } });

        // Configuration endpoint
        server_.Get("/config", [this](const httplib::Request &, httplib::Response &res)
                    {
        nlohmann::json config;
        
        // Try to load from DB
        auto stored_config = db_.get_config("global_settings");
        if (stored_config) {
            try {
                config = nlohmann::json::parse(*stored_config);
            } catch (...) {
                // Fallback to defaults if parse fails
            }
        }

        if (config.empty()) {
            config["workers"] = std::thread::hardware_concurrency();
            config["maxConnections"] = 10000;
            config["defaultTimeout"] = 30000;
            config["statsInterval"] = 100;
            config["contextPoolSize"] = 64;
        }
        
        res.set_content(config.dump(2), "application/json"); });

        // Get all runs
        server_.Get("/runs", [this](const httplib::Request &, httplib::Response &res)
                    {
        try {
            auto runs = db_.get_all_runs();
            nlohmann::json json_runs = nlohmann::json::array();
            for (const auto &run : runs) {
                json_runs.push_back(vayu::json::serialize(run));
            }
            res.set_content(json_runs.dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            nlohmann::json error;
            error["error"] = e.what();
            res.set_content(error.dump(), "application/json");
        } });

        // Get specific run
        server_.Get(R"(/run/([^/]+))", [this](const httplib::Request &req, httplib::Response &res)
                    {
        std::string run_id = req.matches[1];
        try {
            auto run = db_.get_run(run_id);
            if (run) {
                res.set_content(vayu::json::serialize(*run).dump(), "application/json");
            } else {
                res.status = 404;
                nlohmann::json error;
                error["error"] = "Run not found";
                res.set_content(error.dump(), "application/json");
            }
        } catch (const std::exception& e) {
            res.status = 500;
            nlohmann::json error;
            error["error"] = e.what();
            res.set_content(error.dump(), "application/json");
        } });

        // Stop a run
        server_.Post(R"(/run/([^/]+)/stop)", [this](const httplib::Request &req, httplib::Response &res)
                     {
        std::string run_id = req.matches[1];
        try {
            // Check if run exists in DB
            auto run = db_.get_run(run_id);
            if (!run) {
                res.status = 404;
                nlohmann::json error;
                error["error"] = "Run not found";
                res.set_content(error.dump(), "application/json");
                return;
            }
            
            // Check if run is already completed or stopped
            if (run->status == "completed" || run->status == "stopped" || run->status == "failed")
            {
                nlohmann::json response;
                response["status"] = run->status;
                response["runId"] = run_id;
                response["message"] = "Run already " + run->status;
                res.set_content(response.dump(), "application/json");
                return;
            }
            
            // Try to find active run context
            auto context = run_manager_.get_run(run_id);
            if (context)
            {
                // Signal the running thread to stop
                context->should_stop = true;
                
                // Wait briefly for graceful shutdown (max 5 seconds)
                auto wait_start = std::chrono::steady_clock::now();
                while (context->is_running)
                {
                    auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                        std::chrono::steady_clock::now() - wait_start).count();
                    
                    if (elapsed >= 5)
                    {
                        break;  // Timeout
                    }
                    
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                }
                
                // Calculate summary metrics
                size_t completed = context->total_requests.load();
                size_t errors = context->total_errors.load();
                double avg_latency = completed > 0 ? context->total_latency_ms.load() / completed : 0.0;
                double error_rate = completed > 0 ? (errors * 100.0 / completed) : 0.0;
                
                nlohmann::json response;
                response["status"] = "stopped";
                response["runId"] = run_id;
                response["summary"] = {
                    {"totalRequests", completed},
                    {"errors", errors},
                    {"errorRate", error_rate},
                    {"avgLatencyMs", avg_latency}
                };
                
                res.set_content(response.dump(), "application/json");
            }
            else
            {
                // Run not active, just update DB
                db_.update_run_status(run_id, "stopped");
                
                nlohmann::json response;
                response["status"] = "stopped";
                response["runId"] = run_id;
                response["message"] = "Run was not active";
                res.set_content(response.dump(), "application/json");
            }
            
        } catch (const std::exception& e) {
            res.status = 500;
            nlohmann::json error;
            error["error"] = e.what();
            res.set_content(error.dump(), "application/json");
        } });

        // Get stats for a run (SSE)
        server_.Get(R"(/stats/([^/]+))", [this](const httplib::Request &req, httplib::Response &res)
                    {
        std::string run_id = req.matches[1];
        
        // Check if run exists
        try {
            auto run = db_.get_run(run_id);
            if (!run) {
                res.status = 404;
                nlohmann::json error;
                error["error"] = "Run not found";
                res.set_content(error.dump(), "application/json");
                return;
            }
        } catch (const std::exception& e) {
            res.status = 500;
            nlohmann::json error;
            error["error"] = e.what();
            res.set_content(error.dump(), "application/json");
            return;
        }

        res.set_content_provider(
            "text/event-stream", // Content type
            [this, run_id](size_t offset, httplib::DataSink &sink) {
                int64_t last_id = 0;
                bool test_completed = false;
                
                while (!test_completed) {
                    // Check if sink is still writable (client connected)
                    if (!sink.is_writable()) {
                        break;
                    }

                    try {
                        auto metrics = db_.get_metrics_since(run_id, last_id);
                        
                        if (!metrics.empty()) {
                            for (const auto &metric : metrics) {
                                // Check for test completion
                                if (metric.name == "test_complete")
                                {
                                    test_completed = true;
                                    
                                    // Send completion event
                                    nlohmann::json completion_event;
                                    completion_event["event"] = "complete";
                                    completion_event["runId"] = run_id;
                                    std::string payload = "event: complete\ndata: " + completion_event.dump() + "\n\n";
                                    sink.write(payload.data(), payload.size());
                                    break;
                                }
                                
                                // Send metric as SSE event
                                nlohmann::json json_metric = vayu::json::serialize(metric);
                                std::string event_name = "metric";
                                std::string payload = "event: " + event_name + "\ndata: " + json_metric.dump() + "\n\n";
                                
                                if (!sink.write(payload.data(), payload.size())) {
                                    return false;
                                }
                                last_id = metric.id;
                            }
                        } else {
                            // Check if run is completed/stopped/failed in DB
                            auto run = db_.get_run(run_id);
                            if (run && (run->status == "completed" || run->status == "stopped" || run->status == "failed"))
                            {
                                test_completed = true;
                                
                                nlohmann::json completion_event;
                                completion_event["event"] = "complete";
                                completion_event["runId"] = run_id;
                                completion_event["status"] = run->status;
                                std::string payload = "event: complete\ndata: " + completion_event.dump() + "\n\n";
                                sink.write(payload.data(), payload.size());
                                break;
                            }
                            
                            // Send a keep-alive comment to prevent timeouts
                            std::string keep_alive = ": keep-alive\n\n";
                            if (!sink.write(keep_alive.data(), keep_alive.size())) {
                                return false;
                            }
                        }
                    } catch (const std::exception& e) {
                        // Log error?
                        break;
                    }

                    // Exit immediately if test completed
                    if (test_completed) {
                        break;
                    }

                    // Sleep to avoid busy loop
                    std::this_thread::sleep_for(std::chrono::milliseconds(500));
                }
                
                // Connection closed successfully
                return true;
            }
        ); });
    }

} // namespace vayu::http
