#include "vayu/http/server.hpp"

#include <chrono>
#include <iostream>
#include <nlohmann/json.hpp>

#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/metrics_helper.hpp"
#include "vayu/version.hpp"

namespace vayu::http {

namespace {
inline int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}
}  // namespace

Server::Server(vayu::db::Database& db, vayu::core::RunManager& run_manager, int port, bool verbose)
    : db_(db), run_manager_(run_manager), port_(port), verbose_(verbose) {
    setup_routes();
}

Server::~Server() {
    stop();
}

void Server::start() {
    if (is_running_) return;

    is_running_ = true;
    server_thread_ = std::thread([this]() {
        vayu::utils::log_info("Vayu Engine " + std::string(vayu::Version::string));

        // Load and display config
        nlohmann::json config;
        auto stored_config = db_.get_config("global_settings");
        if (stored_config) {
            try {
                config = nlohmann::json::parse(*stored_config);
            } catch (...) {
            }
        }
        if (config.empty()) {
            config["workers"] = std::thread::hardware_concurrency();
            config["maxConnections"] = vayu::core::constants::server::MAX_CONNECTIONS;
            config["defaultTimeout"] = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;
            config["statsInterval"] = vayu::core::constants::server::STATS_INTERVAL_MS;
            config["contextPoolSize"] = vayu::core::constants::server::CONTEXT_POOL_SIZE;
        }
        config["verbose"] = verbose_;
        vayu::utils::log_info("Configuration: " + config.dump());

        vayu::utils::log_info("Listening on http://127.0.0.1:" + std::to_string(port_));
        server_.listen("127.0.0.1", port_);
        is_running_ = false;
    });
}

void Server::stop() {
    if (is_running_) {
        server_.stop();
        if (server_thread_.joinable()) {
            server_thread_.join();
        }
        is_running_ = false;
    }
}

bool Server::is_running() const {
    return is_running_;
}

void Server::setup_routes() {
    // ==========================================
    // CORS Configuration
    // ==========================================
    server_.set_default_headers(
        {{"Access-Control-Allow-Origin", "*"},
         {"Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS"},
         {"Access-Control-Allow-Headers",
          "Content-Type, Authorization, ngrok-skip-browser-warning"}});

    // Handle OPTIONS preflight requests
    server_.Options(".*",
                    [](const httplib::Request&, httplib::Response& res) { res.status = 204; });

    // ==========================================
    // Health Check Endpoint
    // ==========================================

    /**
     * GET /health
     * Returns server health status, version, and available worker threads.
     * Used to verify the server is running and responsive.
     */
    server_.Get("/health", [](const httplib::Request&, httplib::Response& res) {
        nlohmann::json response;
        response["status"] = "ok";
        response["version"] = vayu::Version::string;
        response["workers"] = std::thread::hardware_concurrency();

        res.set_content(response.dump(), "application/json");
    });

    // ==========================================
    // Project Management Endpoints
    // ==========================================

    /**
     * GET /collections
     * Retrieves all collections from the database.
     * Collections are folders that organize requests in a hierarchy.
     * Returns: Array of collection objects with id, name, parentId, order, and timestamps.
     */
    server_.Get("/collections", [this](const httplib::Request&, httplib::Response& res) {
        auto collections = db_.get_collections();
        nlohmann::json response = nlohmann::json::array();
        for (const auto& c : collections) {
            response.push_back(vayu::json::serialize(c));
        }
        res.set_content(response.dump(), "application/json");
    });

    /**
     * POST /collections
     * Creates or updates a collection in the database.
     * If 'id' is provided and exists, performs a partial update.
     * Otherwise, creates a new collection (requires 'name').
     * Body params: id (optional string), name (string), parentId (optional string), order (optional
     * int) Returns: The saved collection object.
     */
    server_.Post("/collections", [this](const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = nlohmann::json::parse(req.body);

            std::string id;
            if (json.contains("id") && !json["id"].is_null()) {
                id = json["id"].get<std::string>();
            } else {
                id = "col_" + std::to_string(now_ms());
            }

            vayu::db::Collection c;
            auto existing = db_.get_collection(id);

            if (existing) {
                c = *existing;
            } else {
                if (!json.contains("name") || json["name"].is_null()) {
                    res.status = 400;
                    res.set_content(
                        nlohmann::json{{"error", "Missing required field: name"}}.dump(),
                        "application/json");
                    return;
                }
                c.id = id;
                c.created_at = now_ms();
                c.order = 0;
            }

            if (json.contains("name") && !json["name"].is_null()) {
                c.name = json["name"].get<std::string>();
            }

            if (json.contains("parentId")) {
                if (json["parentId"].is_null()) {
                    c.parent_id = std::nullopt;
                } else {
                    c.parent_id = json["parentId"].get<std::string>();
                }
            }

            if (json.contains("order") && !json["order"].is_null()) {
                c.order = json["order"].get<int>();
            }

            db_.create_collection(c);
            res.set_content(vayu::json::serialize(c).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        }
    });

    /**
     * GET /requests
     * Retrieves all requests belonging to a specific collection.
     * Query params: collectionId (required) - The collection ID to fetch requests from.
     * Returns: Array of request objects with method, url, headers, body, scripts, etc.
     */
    server_.Get("/requests", [this](const httplib::Request& req, httplib::Response& res) {
        try {
            if (req.has_param("collectionId")) {
                auto requests = db_.get_requests_in_collection(req.get_param_value("collectionId"));
                nlohmann::json response = nlohmann::json::array();
                for (const auto& r : requests) {
                    response.push_back(vayu::json::serialize(r));
                }
                res.set_content(response.dump(), "application/json");
            } else {
                res.status = 400;
                res.set_content(nlohmann::json{{"error", "collectionId required"}}.dump(),
                                "application/json");
            }
        } catch (const std::exception& e) {
            res.status = 500;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        }
    });

    /**
     * POST /requests
     * Creates or updates a request in the database.
     * If 'id' is provided and exists, performs a partial update.
     * Otherwise, creates a new request (requires 'collectionId', 'name', 'method', 'url').
     * Body params: id, collectionId, name, method, url, headers (object), body (any),
     *              auth (object), preRequestScript (string), postRequestScript (string)
     * Returns: The saved request object.
     */
    server_.Post("/requests", [this](const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = nlohmann::json::parse(req.body);

            std::string id;
            if (json.contains("id") && !json["id"].is_null()) {
                id = json["id"].get<std::string>();
            } else {
                id = "req_" + std::to_string(now_ms());
            }

            vayu::db::Request r;
            auto existing = db_.get_request(id);

            if (existing) {
                r = *existing;
            } else {
                if (!json.contains("collectionId") || json["collectionId"].is_null()) {
                    res.status = 400;
                    res.set_content(
                        nlohmann::json{{"error", "Missing required field: collectionId"}}.dump(),
                        "application/json");
                    return;
                }
                if (!json.contains("name") || json["name"].is_null()) {
                    res.status = 400;
                    res.set_content(
                        nlohmann::json{{"error", "Missing required field: name"}}.dump(),
                        "application/json");
                    return;
                }
                if (!json.contains("method") || json["method"].is_null()) {
                    res.status = 400;
                    res.set_content(
                        nlohmann::json{{"error", "Missing required field: method"}}.dump(),
                        "application/json");
                    return;
                }
                if (!json.contains("url") || json["url"].is_null()) {
                    res.status = 400;
                    res.set_content(nlohmann::json{{"error", "Missing required field: url"}}.dump(),
                                    "application/json");
                    return;
                }
                r.id = id;
            }

            if (json.contains("collectionId") && !json["collectionId"].is_null()) {
                r.collection_id = json["collectionId"].get<std::string>();
            }
            if (json.contains("name") && !json["name"].is_null()) {
                r.name = json["name"].get<std::string>();
            }
            if (json.contains("method") && !json["method"].is_null()) {
                auto method = vayu::parse_method(json["method"].get<std::string>());
                if (!method) throw std::runtime_error("Invalid HTTP method");
                r.method = *method;
            }
            if (json.contains("url") && !json["url"].is_null()) {
                r.url = json["url"].get<std::string>();
            }
            if (json.contains("headers")) r.headers = json["headers"].dump();
            if (json.contains("body")) r.body = json["body"].dump();
            if (json.contains("auth")) r.auth = json["auth"].dump();
            if (json.contains("preRequestScript"))
                r.pre_request_script = json["preRequestScript"].get<std::string>();
            if (json.contains("postRequestScript"))
                r.post_request_script = json["postRequestScript"].get<std::string>();

            r.updated_at = now_ms();

            db_.save_request(r);
            res.set_content(vayu::json::serialize(r).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        }
    });

    /**
     * GET /environments
     * Retrieves all saved environments from the database.
     * Environments contain variables that can be used in requests (e.g., API keys, base URLs).
     * Returns: Array of environment objects with id, name, variables, and timestamps.
     */
    server_.Get("/environments", [this](const httplib::Request&, httplib::Response& res) {
        auto envs = db_.get_environments();
        nlohmann::json response = nlohmann::json::array();
        for (const auto& e : envs) {
            response.push_back(vayu::json::serialize(e));
        }
        res.set_content(response.dump(), "application/json");
    });

    /**
     * POST /environments
     * Creates or updates an environment in the database.
     * If 'id' is provided and exists, performs a partial update.
     * Otherwise, creates a new environment (requires 'name').
     * Body params: id (optional string), name (string), variables (optional object)
     * Returns: The saved environment object.
     */
    server_.Post("/environments", [this](const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = nlohmann::json::parse(req.body);

            std::string id;
            if (json.contains("id") && !json["id"].is_null()) {
                id = json["id"].get<std::string>();
            } else {
                id = "env_" + std::to_string(now_ms());
            }

            vayu::db::Environment e;
            auto existing = db_.get_environment(id);

            if (existing) {
                e = *existing;
            } else {
                if (!json.contains("name") || json["name"].is_null()) {
                    res.status = 400;
                    res.set_content(
                        nlohmann::json{{"error", "Missing required field: name"}}.dump(),
                        "application/json");
                    return;
                }
                e.id = id;
            }

            if (json.contains("name") && !json["name"].is_null()) {
                e.name = json["name"].get<std::string>();
            }
            if (json.contains("variables")) {
                e.variables = json["variables"].dump();
            }

            e.updated_at = now_ms();

            db_.save_environment(e);
            res.set_content(vayu::json::serialize(e).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        }
    });

    // ==========================================
    // Execution Endpoints
    // ==========================================

    /**
     * POST /request
     * Executes a single HTTP request (Design Mode).
     * Used for testing individual requests with immediate response.
     * Body params: method, url, headers (object), body (any), auth (object),
     *              preRequestScript (string), postRequestScript (string),
     *              requestId (optional), environmentId (optional)
     * Creates a "design" type run in the database and stores full response trace.
     * Returns: The HTTP response with status, headers, body, and timing information.
     */
    server_.Post("/request", [this](const httplib::Request& req, httplib::Response& res) {
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
            run.type = vayu::RunType::Design;
            run.status = vayu::RunStatus::Running;
            run.start_time = now_ms();
            run.config_snapshot = req.body;

            if (json.contains("requestId") && !json["requestId"].is_null()) {
                run.request_id = json["requestId"].get<std::string>();
            }
            if (json.contains("environmentId") && !json["environmentId"].is_null()) {
                run.environment_id = json["environmentId"].get<std::string>();
            }

            db_.create_run(run);

            // Send request
            vayu::http::ClientConfig config;
            config.verbose = verbose_;
            vayu::http::Client client(config);

            auto response_result = client.send(request_result.value());

            if (response_result.is_error()) {
                db_.update_run_status(run_id, vayu::RunStatus::Failed);
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
                db_.update_run_status(run_id, vayu::RunStatus::Completed);
            } catch (const std::exception& e) {
                vayu::utils::log_error("Failed to save result: " + std::string(e.what()));
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
        }
    });

    /**
     * POST /run
     * Starts a load test run (Vayu Mode).
     * Executes multiple requests concurrently based on the specified load profile.
     *
     * Request Body Parameters:
     *   - request (object, required): HTTP request configuration
     *     - method (string): GET, POST, PUT, DELETE, etc.
     *     - url (string): Target URL
     *     - headers (object, optional): HTTP headers
     *     - body (string, optional): Request body
     *
     *   - mode (string, required): Load test strategy
     *     - "constant": Fixed RPS for duration
     *     - "iterations": Fixed number of iterations with concurrency
     *     - "ramp_up": Gradually increase concurrency
     *
     *   Mode-specific parameters:
     *   For "constant" mode:
     *     - duration (string): Duration (e.g., "10s", "2m")
     *     - targetRps (number): Target requests per second
     *
     *   For "iterations" mode:
     *     - iterations (number): Total number of requests
     *     - concurrency (number): Number of concurrent requests
     *
     *   For "ramp_up" mode:
     *     - duration (string): Total duration
     *     - rampUpDuration (string): Time to reach target concurrency
     *     - startConcurrency (number): Initial concurrency level
     *     - concurrency (number): Target concurrency level
     *
     *   Data Capture (optional):
     *     - success_sample_rate (number, 0-100): % of successful requests to save
     *     - slow_threshold_ms (number): Threshold for auto-capturing slow requests
     *     - save_timing_breakdown (boolean): Capture detailed timing (DNS, TLS, etc.)
     *
     *   Optional:
     *     - requestId (string): Link to request definition
     *     - environmentId (string): Link to environment
     *     - comment (string): Test description
     *
     * Creates a "load" type run and returns immediately with 202 Accepted.
     * The actual load test runs asynchronously via RunManager.
     * Returns: 202 Accepted with runId and status "pending".
     */
    server_.Post("/run", [this](const httplib::Request& req, httplib::Response& res) {
        // Create run entry
        std::string run_id = "run_" + std::to_string(now_ms());
        vayu::utils::log_debug("Received POST /run, run_id=" + run_id);

        try {
            auto json = nlohmann::json::parse(req.body);

            vayu::utils::log_debug("Load test config: mode=" + json.value("mode", "unspecified"));

            // Validate required fields
            if (!json.contains("request")) {
                res.status = 400;
                nlohmann::json error;
                error["error"] = "Missing required field: request";
                res.set_content(error.dump(), "application/json");
                return;
            }

            if (!json.contains("mode") && !json.contains("duration") &&
                !json.contains("iterations")) {
                res.status = 400;
                nlohmann::json error;
                error["error"] = "Must specify either 'mode' with 'duration' or 'iterations'";
                res.set_content(error.dump(), "application/json");
                return;
            }

            // Create DB run record
            vayu::db::Run run;
            run.id = run_id;
            run.type = vayu::RunType::Load;
            run.status = vayu::RunStatus::Pending;
            run.config_snapshot = req.body;
            run.start_time = now_ms();
            run.end_time = run.start_time;

            if (json.contains("requestId") && !json["requestId"].is_null()) {
                run.request_id = json["requestId"].get<std::string>();
            }
            if (json.contains("environmentId") && !json["environmentId"].is_null()) {
                run.environment_id = json["environmentId"].get<std::string>();
            }

            db_.create_run(run);

            // Start run via RunManager
            run_manager_.start_run(run_id, json, db_, verbose_);

            // Return 202 Accepted
            nlohmann::json response;
            response["runId"] = run_id;
            response["status"] = to_string(vayu::RunStatus::Pending);
            response["message"] = "Load test started";

            res.status = 202;
            res.set_content(response.dump(), "application/json");

        } catch (const std::exception& e) {
            res.status = 500;
            nlohmann::json error;
            error["error"] = "Failed to create run: " + std::string(e.what());
            res.set_content(error.dump(), "application/json");
            return;
        }
    });

    /**
     * GET /config
     * Retrieves the global configuration settings.
     * Returns stored configuration from database or defaults if none exists.
     * Default config includes: workers, maxConnections, defaultTimeout,
     *                          statsInterval, contextPoolSize
     * Returns: Configuration object with all settings.
     */
    server_.Get("/config", [this](const httplib::Request&, httplib::Response& res) {
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
            config["maxConnections"] = vayu::core::constants::server::MAX_CONNECTIONS;
            config["defaultTimeout"] = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;
            config["statsInterval"] = vayu::core::constants::server::STATS_INTERVAL_MS;
            config["contextPoolSize"] = vayu::core::constants::server::CONTEXT_POOL_SIZE;
        }

        res.set_content(config.dump(2), "application/json");
    });

    /**
     * GET /runs
     * Retrieves all test runs from the database.
     * Returns both "design" mode single requests and "load" mode test runs.
     * Each run includes: id, type, status, timestamps, config snapshot, and associated IDs.
     * Returns: Array of run objects.
     */
    server_.Get("/runs", [this](const httplib::Request&, httplib::Response& res) {
        try {
            auto runs = db_.get_all_runs();
            nlohmann::json json_runs = nlohmann::json::array();
            for (const auto& run : runs) {
                json_runs.push_back(vayu::json::serialize(run));
            }
            res.set_content(json_runs.dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            nlohmann::json error;
            error["error"] = e.what();
            res.set_content(error.dump(), "application/json");
        }
    });

    /**
     * GET /run/:runId
     * Retrieves details for a specific test run by its ID.
     * Path params: runId - The unique identifier of the run.
     * Returns: Run object with all details, or 404 if not found.
     */
    server_.Get(R"(/run/([^/]+))", [this](const httplib::Request& req, httplib::Response& res) {
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
        }
    });

    /**
     * GET /run/:runId/report
     * Retrieves a detailed statistical report for a specific test run.
     * Path params: runId - The unique identifier of the run.
     * Calculates aggregate metrics including percentiles, error rates, and status code
     * distribution. Returns: DetailedReport object, or 404 if not found.
     */
    server_.Get(
        R"(/run/([^/]+)/report)", [this](const httplib::Request& req, httplib::Response& res) {
            std::string run_id = req.matches[1];
            try {
                auto run = db_.get_run(run_id);
                if (!run) {
                    res.status = 404;
                    nlohmann::json error;
                    error["error"] = "Run not found";
                    res.set_content(error.dump(), "application/json");
                    return;
                }

                auto results = db_.get_results(run_id);

                double duration_s = 0;
                if (run->start_time > 0) {
                    int64_t end = run->end_time > 0 ? run->end_time : now_ms();
                    duration_s = (end - run->start_time) / 1000.0;
                }

                auto report =
                    vayu::utils::MetricsHelper::calculate_detailed_report(results, duration_s);

                nlohmann::json json_report;
                json_report["summary"] = {{"totalRequests", report.total_requests},
                                          {"successfulRequests", report.successful_requests},
                                          {"failedRequests", report.failed_requests},
                                          {"errorRate", report.error_rate},
                                          {"totalDurationSeconds", report.total_duration_s},
                                          {"avgRps", report.avg_rps}};
                json_report["latency"] = {{"min", report.latency_min},
                                          {"max", report.latency_max},
                                          {"avg", report.latency_avg},
                                          {"p50", report.latency_p50},
                                          {"p90", report.latency_p90},
                                          {"p95", report.latency_p95},
                                          {"p99", report.latency_p99}};
                json_report["statusCodes"] = report.status_codes;

                // Error details
                json_report["errors"] = {{"total", report.failed_requests},
                                         {"withDetails", report.errors_with_details},
                                         {"types", report.error_types}};

                // Timing breakdown (only if available)
                if (report.has_timing_data) {
                    json_report["timingBreakdown"] = {{"avgDnsMs", report.avg_dns_ms},
                                                      {"avgConnectMs", report.avg_connect_ms},
                                                      {"avgTlsMs", report.avg_tls_ms},
                                                      {"avgFirstByteMs", report.avg_first_byte_ms},
                                                      {"avgDownloadMs", report.avg_download_ms}};
                }

                // Slow requests (only if threshold was set)
                if (report.slow_threshold_ms > 0) {
                    json_report["slowRequests"] = {
                        {"count", report.slow_requests_count},
                        {"thresholdMs", report.slow_threshold_ms},
                        {"percentage",
                         report.total_requests > 0
                             ? (static_cast<double>(report.slow_requests_count) * 100.0 /
                                static_cast<double>(report.total_requests))
                             : 0.0}};
                }

                res.set_content(json_report.dump(), "application/json");

            } catch (const std::exception& e) {
                res.status = 500;
                nlohmann::json error;
                error["error"] = e.what();
                res.set_content(error.dump(), "application/json");
            }
        });

    /**
     * POST /run/:runId/stop
     * Stops an active load test run gracefully.
     * Path params: runId - The unique identifier of the run to stop.
     * Signals the running thread to stop and waits up to 5 seconds for graceful shutdown.
     * If run is already completed/stopped/failed, returns current status.
     * Returns: Status object with summary metrics (totalRequests, errors, errorRate, avgLatency).
     */
    server_.Post(
        R"(/run/([^/]+)/stop)", [this](const httplib::Request& req, httplib::Response& res) {
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
                if (run->status == vayu::RunStatus::Completed ||
                    run->status == vayu::RunStatus::Stopped ||
                    run->status == vayu::RunStatus::Failed) {
                    auto response = vayu::utils::MetricsHelper::create_already_stopped_response(
                        run_id, to_string(run->status));
                    res.set_content(response.dump(), "application/json");
                    return;
                }

                // Try to find active run context
                auto context = run_manager_.get_run(run_id);
                if (context) {
                    // Signal the running thread to stop
                    context->should_stop = true;

                    // Wait for graceful shutdown
                    vayu::utils::MetricsHelper::wait_for_graceful_stop(*context, 5);

                    // Calculate summary metrics
                    auto summary = vayu::utils::MetricsHelper::calculate_summary(*context);
                    auto response =
                        vayu::utils::MetricsHelper::create_stop_response(run_id, summary);

                    res.set_content(response.dump(), "application/json");
                } else {
                    // Run not active, just update DB
                    db_.update_run_status(run_id, vayu::RunStatus::Stopped);

                    auto response = vayu::utils::MetricsHelper::create_inactive_response(run_id);
                    res.set_content(response.dump(), "application/json");
                }

            } catch (const std::exception& e) {
                res.status = 500;
                nlohmann::json error;
                error["error"] = e.what();
                res.set_content(error.dump(), "application/json");
            }
        });

    /**
     * GET /stats/:runId
     * Streams real-time statistics for a load test run using Server-Sent Events (SSE).
     * Path params: runId - The unique identifier of the run to monitor.
     * Continuously streams metric events as they are recorded in the database.
     * Sends periodic keep-alive messages to prevent connection timeout.
     * Automatically closes connection when run completes/stops/fails.
     * Event types: "metric" (performance data), "complete" (test finished)
     * Content-Type: text/event-stream
     */
    server_.Get(R"(/stats/([^/]+))", [this](const httplib::Request& req, httplib::Response& res) {
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
            "text/event-stream",  // Content type
            [this, run_id](size_t offset, httplib::DataSink& sink) {
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
                            for (const auto& metric : metrics) {
                                // Send metric as SSE event
                                nlohmann::json json_metric = vayu::json::serialize(metric);
                                std::string event_name = "metric";
                                std::string payload = "event: " + event_name +
                                                      "\ndata: " + json_metric.dump() + "\n\n";

                                if (!sink.write(payload.data(), payload.size())) {
                                    return false;
                                }
                                last_id = metric.id;

                                // Check for test completion
                                if (metric.name == vayu::MetricName::Completed) {
                                    test_completed = true;

                                    // Send completion event
                                    nlohmann::json completion_event;
                                    completion_event["event"] = "complete";
                                    completion_event["runId"] = run_id;
                                    std::string completion_payload =
                                        "event: complete\ndata: " + completion_event.dump() +
                                        "\n\n";
                                    sink.write(completion_payload.data(),
                                               completion_payload.size());
                                    break;
                                }
                            }
                        } else {
                            // Check if run is completed/stopped/failed in DB
                            auto run = db_.get_run(run_id);
                            if (run && (run->status == vayu::RunStatus::Completed ||
                                        run->status == vayu::RunStatus::Stopped ||
                                        run->status == vayu::RunStatus::Failed)) {
                                test_completed = true;

                                nlohmann::json completion_event;
                                completion_event["event"] = "complete";
                                completion_event["runId"] = run_id;
                                completion_event["status"] = to_string(run->status);
                                std::string payload =
                                    "event: complete\ndata: " + completion_event.dump() + "\n\n";
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
                return false;
            });
    });
}

}  // namespace vayu::http
