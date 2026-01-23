/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/execution.cpp
 * @brief Request execution routes (Design mode & Load test)
 *
 * HTTP Status Code Philosophy:
 * - Engine returns 200 if it successfully processed the request (regardless of server response)
 * - Engine returns 400 for malformed requests (invalid JSON, missing fields)
 * - Engine returns 500 only for internal engine failures (should be rare)
 * - Server's HTTP status code is always in the response body, never translated to engine status
 */

#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

namespace {

// Helper function to parse variables JSON string to Environment
vayu::Environment parse_variables_json(const std::string& json_str) {
    vayu::Environment env;
    if (json_str.empty()) {
        return env;
    }

    try {
        auto json = nlohmann::json::parse(json_str);
        if (json.is_object()) {
            for (auto& [key, value] : json.items()) {
                if (value.is_object()) {
                    std::string var_value = value.value("value", "");
                    bool enabled = value.value("enabled", true);
                    bool secret = value.value("secret", false);
                    if (enabled) {
                        env[key] = vayu::Variable{var_value, secret, enabled};
                    }
                }
            }
        }
    } catch (const std::exception&) {
        // Return empty environment on parse error
    }
    return env;
}

// Execute a script and handle exceptions uniformly
vayu::ScriptResult execute_script(vayu::runtime::ScriptEngine& engine,
                                  const std::string& script,
                                  vayu::runtime::ScriptContext& ctx,
                                  const std::string& script_type) {
    vayu::ScriptResult result;
    if (script.empty()) {
        return result;
    }

    try {
        result = engine.execute(script, ctx);
        if (!result.success) {
            vayu::utils::log_warning(script_type + " script failed: " + result.error_message);
        }
    } catch (const std::exception& e) {
        result.success = false;
        result.error_message = std::string("Script exception: ") + e.what();
        vayu::utils::log_error(script_type + " script exception: " + std::string(e.what()));
    }
    return result;
}

// Build the final response JSON with script results
nlohmann::json build_response_json(const vayu::Response& response,
                                   const vayu::ScriptResult& pre_script_result,
                                   const vayu::ScriptResult& post_script_result) {
    nlohmann::json response_json = vayu::json::serialize(response);

    // Add test results from post-request script
    if (!post_script_result.tests.empty()) {
        nlohmann::json test_results = nlohmann::json::array();
        for (const auto& test : post_script_result.tests) {
            nlohmann::json test_json;
            test_json["name"] = test.name;
            test_json["passed"] = test.passed;
            if (!test.error_message.empty()) {
                test_json["error"] = test.error_message;
            }
            test_results.push_back(test_json);
        }
        response_json["testResults"] = test_results;
    }

    // Combine console output from both scripts
    std::vector<std::string> all_console_output;
    for (const auto& line : pre_script_result.console_output) {
        all_console_output.push_back("[pre] " + line);
    }
    for (const auto& line : post_script_result.console_output) {
        all_console_output.push_back(line);
    }
    if (!all_console_output.empty()) {
        response_json["consoleLogs"] = all_console_output;
    }

    // Add script errors if any
    if (!pre_script_result.success && !pre_script_result.error_message.empty()) {
        response_json["preScriptError"] = pre_script_result.error_message;
    }
    if (!post_script_result.success && !post_script_result.error_message.empty()) {
        response_json["postScriptError"] = post_script_result.error_message;
    }

    return response_json;
}

// Store result to database (logs errors but doesn't throw)
void store_result(vayu::db::Database& db,
                  const std::string& run_id,
                  const vayu::Request& request,
                  const vayu::Response& response) {
    try {
        const bool has_error = response.has_error();

        vayu::db::Result db_result;
        db_result.run_id = run_id;
        db_result.timestamp = now_ms();
        db_result.status_code = response.status_code;
        db_result.latency_ms = response.timing.total_ms;
        db_result.error = has_error ? response.error_message : "";

        // Build trace data
        nlohmann::json trace;
        trace["request"] = {{"method", to_string(request.method)},
                            {"url", request.url},
                            {"headers", request.headers}};
        if (!request.body.content.empty()) {
            trace["request"]["body"] = request.body.content;
        }

        if (!has_error) {
            trace["response"] = {{"headers", response.headers}, {"body", response.body}};
        } else {
            trace["error_type"] = to_string(response.error_code);
            trace["error_message"] = response.error_message;
        }

        // Timing information
        const auto& timing = response.timing;
        if (timing.dns_ms > 0) trace["dnsMs"] = timing.dns_ms;
        if (timing.connect_ms > 0) trace["connectMs"] = timing.connect_ms;
        if (timing.tls_ms > 0) trace["tlsMs"] = timing.tls_ms;
        if (timing.first_byte_ms > 0) trace["firstByteMs"] = timing.first_byte_ms;
        if (timing.download_ms > 0) trace["downloadMs"] = timing.download_ms;

        db_result.trace_data = trace.dump();
        db.add_result(db_result);

        auto status = has_error ? vayu::RunStatus::Failed : vayu::RunStatus::Completed;
        db.update_run_status_with_retry(run_id, status);

    } catch (const std::exception& e) {
        vayu::utils::log_error("Failed to save result: " + std::string(e.what()));
        try {
            db.update_run_status_with_retry(run_id, vayu::RunStatus::Failed);
        } catch (...) {
            vayu::utils::log_error("Failed to update run status after save error");
        }
    }
}

}  // namespace

void register_execution_routes(RouteContext& ctx) {
    /**
     * POST /request
     * Executes a single HTTP request (Design Mode).
     *
     * Returns:
     * - 200: Request was processed (check response body for server status/errors)
     * - 400: Invalid request format (malformed JSON, missing required fields)
     */
    ctx.server.Post("/request", [&ctx](const httplib::Request& req, httplib::Response& res) {
        std::string run_id;

        // Parse and validate request
        nlohmann::json json;
        try {
            json = nlohmann::json::parse(req.body);
        } catch (const nlohmann::json::exception& e) {
            vayu::utils::log_warning("POST /request - Invalid JSON: " + std::string(e.what()));
            send_error(res, 400, "Invalid JSON: " + std::string(e.what()));
            return;
        }

        auto request_result = vayu::json::deserialize_request(json);
        if (request_result.is_error()) {
            vayu::utils::log_warning("POST /request - Invalid request format");
            send_error(res, 400, request_result.error().message);
            return;
        }

        // Extract scripts
        std::string pre_request_script = json.value("preRequestScript", std::string{});
        std::string post_request_script = json.value("postRequestScript", std::string{});

        // Create Run record
        run_id = "run_" + std::to_string(now_ms());
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

        // Log request details
        vayu::utils::log_info(
            "POST /request - Design Mode: run_id=" + run_id + ", method=" +
            json.value("method", "UNKNOWN") + ", url=" + json.value("url", "UNKNOWN") +
            ", request_id=" + run.request_id.value_or("none") +
            ", environment_id=" + run.environment_id.value_or("none") +
            ", has_pre_script=" + std::string(!pre_request_script.empty() ? "true" : "false") +
            ", has_post_script=" + std::string(!post_request_script.empty() ? "true" : "false"));

        try {
            ctx.db.create_run(run);
        } catch (const std::exception& e) {
            vayu::utils::log_error("Failed to create run: " + std::string(e.what()));
            send_error(res, 400, "Failed to create run record");
            return;
        }

        // Initialize script engine
        vayu::runtime::ScriptConfig script_config;
        script_config.timeout_ms = static_cast<uint64_t>(ctx.db.get_config_int(
            "scriptTimeout", vayu::core::constants::script_engine::TIMEOUT_MS));
        script_config.memory_limit = static_cast<size_t>(ctx.db.get_config_int(
            "scriptMemoryLimit", vayu::core::constants::script_engine::MEMORY_LIMIT));
        script_config.stack_size = static_cast<size_t>(ctx.db.get_config_int(
            "scriptStackSize", vayu::core::constants::script_engine::STACK_SIZE));
        script_config.enable_console = ctx.db.get_config_bool(
            "scriptEnableConsole", vayu::core::constants::script_engine::ENABLE_CONSOLE);

        vayu::runtime::ScriptEngine script_engine(script_config);

        // Load variables
        vayu::Environment env, globals, collectionVariables;

        if (run.environment_id.has_value()) {
            if (auto db_env = ctx.db.get_environment(*run.environment_id)) {
                env = parse_variables_json(db_env->variables);
            }
        }

        if (auto db_globals = ctx.db.get_globals()) {
            globals = parse_variables_json(db_globals->variables);
        }

        if (run.request_id.has_value()) {
            if (auto db_request = ctx.db.get_request(*run.request_id)) {
                if (!db_request->collection_id.empty()) {
                    if (auto db_collection = ctx.db.get_collection(db_request->collection_id)) {
                        collectionVariables = parse_variables_json(db_collection->variables);
                    }
                }
            }
        }

        // Get the request (may be modified by pre-request script)
        auto request = request_result.value();

        // Execute pre-request script
        vayu::runtime::ScriptContext pre_ctx;
        pre_ctx.request = &request;
        pre_ctx.environment = &env;
        pre_ctx.globals = &globals;
        pre_ctx.collectionVariables = &collectionVariables;
        auto pre_script_result =
            execute_script(script_engine, pre_request_script, pre_ctx, "Pre-request");

        // Send HTTP request
        vayu::http::ClientConfig config;
        config.verbose = ctx.verbose;
        vayu::http::Client client(config);
        const auto& response = client.send(request).value();

        // Store result to database (non-blocking, errors logged)
        store_result(ctx.db, run_id, request, response);

        // Execute post-request script
        vayu::runtime::ScriptContext post_ctx;
        post_ctx.request = &request;
        post_ctx.response = &response;
        post_ctx.environment = &env;
        post_ctx.globals = &globals;
        post_ctx.collectionVariables = &collectionVariables;
        auto post_script_result =
            execute_script(script_engine, post_request_script, post_ctx, "Post-request");

        // Build and send response
        // Engine returns 200 - the server's status is in the response body
        res.status = 200;
        res.set_content(
            build_response_json(response, pre_script_result, post_script_result).dump(2),
            "application/json");
    });

    /**
     * POST /run
     * Starts a load test run (Vayu Mode).
     *
     * Returns:
     * - 202: Load test accepted and started
     * - 400: Invalid request format
     */
    ctx.server.Post("/run", [&ctx](const httplib::Request& req, httplib::Response& res) {
        // Parse JSON
        nlohmann::json json;
        try {
            json = nlohmann::json::parse(req.body);
        } catch (const nlohmann::json::exception& e) {
            vayu::utils::log_warning("POST /run - Invalid JSON: " + std::string(e.what()));
            send_error(res, 400, "Invalid JSON: " + std::string(e.what()));
            return;
        }

        // Validate required fields
        if (!json.contains("method") || !json.contains("url")) {
            vayu::utils::log_warning("POST /run - Missing required fields: method, url");
            send_error(res, 400, "Missing required fields: method, url");
            return;
        }

        if (!json.contains("mode") && !json.contains("duration") && !json.contains("iterations")) {
            vayu::utils::log_warning("POST /run - Missing mode/duration/iterations config");
            send_error(res, 400, "Must specify either 'mode' with 'duration' or 'iterations'");
            return;
        }

        // Create run record
        std::string run_id = "run_" + std::to_string(now_ms());
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

        // Extract duration for logging
        std::string duration_str = "0s";
        if (json.contains("duration")) {
            if (json["duration"].is_string()) {
                duration_str = json["duration"].get<std::string>();
            } else if (json["duration"].is_number()) {
                duration_str = std::to_string(json["duration"].get<int>()) + "s";
            }
        }

        vayu::utils::log_info(
            "POST /run - Load Test: run_id=" + run_id + ", mode=" +
            json.value("mode", "unspecified") + ", method=" + json.value("method", "UNKNOWN") +
            ", url=" + json.value("url", "UNKNOWN") + ", duration=" + duration_str +
            ", iterations=" + std::to_string(json.value("iterations", 0)) +
            ", rps=" + std::to_string(json.value("rps", json.value("targetRps", 0))) +
            ", concurrency=" + std::to_string(json.value("concurrency", 1)) +
            ", request_id=" + run.request_id.value_or("none") +
            ", environment_id=" + run.environment_id.value_or("none"));

        try {
            ctx.db.create_run(run);
        } catch (const std::exception& e) {
            vayu::utils::log_error("POST /run - Failed to create run: " + std::string(e.what()));
            send_error(res, 400, "Failed to create run record");
            return;
        }

        // Start run via RunManager
        ctx.run_manager.start_run(run_id, json, ctx.db, ctx.verbose);

        nlohmann::json response;
        response["runId"] = run_id;
        response["status"] = to_string(vayu::RunStatus::Pending);
        response["message"] = "Load test started";

        res.status = 202;
        res.set_content(response.dump(), "application/json");
    });
}

}  // namespace vayu::http::routes
