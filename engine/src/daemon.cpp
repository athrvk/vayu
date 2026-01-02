/**
 * @file daemon.cpp
 * @brief Vayu Engine daemon entry point
 *
 * This is the background process that handles high-concurrency requests.
 * It exposes a Control API for the Electron app to communicate with.
 */

#include "vayu/http/client.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/version.hpp"
#include "vayu/db/database.hpp"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <csignal>
#include <iostream>
#include <thread>
#include <chrono>

namespace
{
    std::atomic<bool> g_running{true};

    void signal_handler(int signal)
    {
        if (signal == SIGINT || signal == SIGTERM)
        {
            std::cout << "\nShutting down...\n";
            g_running = false;
        }
    }

    inline int64_t now_ms()
    {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
                   std::chrono::system_clock::now().time_since_epoch())
            .count();
    }

    // JSON Serialization Helpers
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

} // namespace

int main(int argc, char *argv[])
{
    // Parse arguments
    int port = 9876;
    bool verbose = false;

    for (int i = 1; i < argc; ++i)
    {
        std::string arg = argv[i];

        if (arg == "-p" || arg == "--port")
        {
            if (i + 1 < argc)
            {
                port = std::stoi(argv[++i]);
            }
        }
        else if (arg == "-v" || arg == "--verbose")
        {
            verbose = true;
        }
        else if (arg == "-h" || arg == "--help")
        {
            std::cout << "Vayu Engine " << vayu::Version::string << "\n\n";
            std::cout << "Usage: vayu-engine [OPTIONS]\n\n";
            std::cout << "Options:\n";
            std::cout << "  -p, --port <PORT>  Port to listen on (default: 9876)\n";
            std::cout << "  -v, --verbose      Enable verbose output\n";
            std::cout << "  -h, --help         Show this help message\n";
            return 0;
        }
    }

    // Setup signal handlers
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    // Initialize database
    vayu::db::Database db("vayu.db");
    try
    {
        db.init();
        std::cout << "Database initialized at vayu.db\n";
    }
    catch (const std::exception &e)
    {
        std::cerr << "Failed to initialize database: " << e.what() << "\n";
        return 1;
    }

    // Initialize curl
    vayu::http::global_init();

    // Create HTTP server
    httplib::Server server;

    // Health check endpoint
    server.Get("/health", [](const httplib::Request &, httplib::Response &res)
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
    server.Get("/collections", [&db](const httplib::Request &, httplib::Response &res)
               {
        auto collections = db.get_collections();
        nlohmann::json response = nlohmann::json::array();
        for (const auto& c : collections) {
            response.push_back(to_json(c));
        }
        res.set_content(response.dump(), "application/json"); });

    server.Post("/collections", [&db](const httplib::Request &req, httplib::Response &res)
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
            
            db.create_collection(c);
            res.set_content(to_json(c).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        } });

    // Requests
    server.Get("/requests", [&db](const httplib::Request &req, httplib::Response &res)
               {
        if (req.has_param("collectionId")) {
            auto requests = db.get_requests_in_collection(req.get_param_value("collectionId"));
            nlohmann::json response = nlohmann::json::array();
            for (const auto& r : requests) {
                response.push_back(to_json(r));
            }
            res.set_content(response.dump(), "application/json");
        } else {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", "collectionId required"}}.dump(), "application/json");
        } });

    server.Post("/requests", [&db](const httplib::Request &req, httplib::Response &res)
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
            
            db.save_request(r);
            res.set_content(to_json(r).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        } });

    // Environments
    server.Get("/environments", [&db](const httplib::Request &, httplib::Response &res)
               {
        auto envs = db.get_environments();
        nlohmann::json response = nlohmann::json::array();
        for (const auto& e : envs) {
            response.push_back(to_json(e));
        }
        res.set_content(response.dump(), "application/json"); });

    server.Post("/environments", [&db](const httplib::Request &req, httplib::Response &res)
                {
        try {
            auto json = nlohmann::json::parse(req.body);
            vayu::db::Environment e;
            e.id = json["id"];
            e.name = json["name"];
            e.variables = json.value("variables", nlohmann::json::object()).dump();
            e.updated_at = now_ms();
            
            db.save_environment(e);
            res.set_content(to_json(e).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        } });

    // ==========================================
    // Execution Endpoints
    // ==========================================

    // Single request endpoint (Design Mode)
    server.Post("/request", [verbose, &db](const httplib::Request &req, httplib::Response &res)
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
            
            db.create_run(run);
            
            // Send request
            vayu::http::ClientConfig config;
            config.verbose = verbose;
            vayu::http::Client client(config);
            
            auto response_result = client.send(request_result.value());
            
            if (response_result.is_error()) {
                db.update_run_status(run_id, "failed");
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
                
                db.add_result(db_result);
                db.update_run_status(run_id, "completed");
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

    // Load test endpoint (Vayu Mode) - placeholder
    server.Post("/run", [&db](const httplib::Request &req, httplib::Response &res)
                {
        // Create run entry
        std::string run_id = "run_" + std::to_string(now_ms());
        
        try {
            auto json = nlohmann::json::parse(req.body);
            
            vayu::db::Run run;
            run.id = run_id;
            run.type = "load";
            run.status = "pending";
            run.config_snapshot = req.body;
            run.start_time = now_ms();
            run.end_time = run.start_time; // Initially same
            
            if (json.contains("requestId")) {
                run.request_id = json["requestId"];
            }
            if (json.contains("environmentId")) {
                run.environment_id = json["environmentId"];
            }
            
            db.create_run(run);
        } catch (const std::exception& e) {
            res.status = 500;
            nlohmann::json error;
            error["error"] = "Failed to create run: " + std::string(e.what());
            res.set_content(error.dump(), "application/json");
            return;
        }

        nlohmann::json response;
        response["runId"] = run_id;
        response["status"] = "pending";
        response["message"] = "Run created";
        
        res.status = 202;  // Accepted
        res.set_content(response.dump(), "application/json"); });

    // Configuration endpoint
    server.Get("/config", [&db](const httplib::Request &, httplib::Response &res)
               {
        nlohmann::json config;
        
        // Try to load from DB
        auto stored_config = db.get_config("global_settings");
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
    server.Get("/runs", [&db](const httplib::Request &, httplib::Response &res)
               {
        try {
            auto runs = db.get_all_runs();
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
    server.Get(R"(/run/([^/]+))", [&db](const httplib::Request &req, httplib::Response &res)
               {
        std::string run_id = req.matches[1];
        try {
            auto run = db.get_run(run_id);
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
    server.Post(R"(/run/([^/]+)/stop)", [&db](const httplib::Request &req, httplib::Response &res)
                {
        std::string run_id = req.matches[1];
        try {
            auto run = db.get_run(run_id);
            if (!run) {
                res.status = 404;
                nlohmann::json error;
                error["error"] = "Run not found";
                res.set_content(error.dump(), "application/json");
                return;
            }

            // TODO: Signal the actual running thread to stop
            // For now, just update the status in DB
            db.update_run_status(run_id, "stopped");
            
            nlohmann::json response;
            response["status"] = "stopped";
            response["runId"] = run_id;
            res.set_content(response.dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            nlohmann::json error;
            error["error"] = e.what();
            res.set_content(error.dump(), "application/json");
        } });

    // Get stats for a run (SSE)
    server.Get(R"(/stats/([^/]+))", [&db](const httplib::Request &req, httplib::Response &res)
               {
        std::string run_id = req.matches[1];
        
        // Check if run exists
        try {
            auto run = db.get_run(run_id);
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
            [&db, run_id](size_t offset, httplib::DataSink &sink) {
                int64_t last_id = 0;
                
                while (true) {
                    // Check if sink is still writable (client connected)
                    if (!sink.is_writable()) {
                        break;
                    }

                    try {
                        auto metrics = db.get_metrics_since(run_id, last_id);
                        
                        if (!metrics.empty()) {
                            for (const auto &metric : metrics) {
                                nlohmann::json json_metric = vayu::json::serialize(metric);
                                std::string payload = "data: " + json_metric.dump() + "\n\n";
                                if (!sink.write(payload.data(), payload.size())) {
                                    return false;
                                }
                                last_id = metric.id;
                            }
                        } else {
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

                    // Sleep to avoid busy loop
                    std::this_thread::sleep_for(std::chrono::milliseconds(500));
                }
                return true;
            }
        ); });

    // Start server
    std::cout << "Vayu Engine " << vayu::Version::string << "\n";
    std::cout << "Listening on http://127.0.0.1:" << port << "\n";
    std::cout << "Press Ctrl+C to stop\n\n";

    // Run in a thread so we can check g_running
    std::thread server_thread([&server, port]()
                              { server.listen("127.0.0.1", port); });

    // Wait for shutdown signal
    while (g_running && server.is_running())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // Shutdown
    server.stop();
    if (server_thread.joinable())
    {
        server_thread.join();
    }

    vayu::http::global_cleanup();

    std::cout << "Goodbye!\n";
    return 0;
}
