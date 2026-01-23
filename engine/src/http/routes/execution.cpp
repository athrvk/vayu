/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/execution.cpp
 * @brief Request execution routes (Design mode & Load test)
 */

#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"

namespace vayu::http::routes {

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

void register_execution_routes(RouteContext& ctx) {
    /**
     * POST /request
     * Executes a single HTTP request (Design Mode).
     * Used for testing individual requests with immediate response.
     * Runs pre-request and post-request (test) scripts if provided.
     */
    ctx.server.Post("/request", [&ctx](const httplib::Request& req, httplib::Response& res) {
        std::string run_id;
        try {
            auto json = nlohmann::json::parse(req.body);

            auto request_result = vayu::json::deserialize_request(json);
            if (request_result.is_error()) {
                vayu::utils::log_warning("POST /request - Invalid request format");
                res.status = 400;
                res.set_content(vayu::json::serialize(request_result.error()).dump(),
                                "application/json");
                return;
            }

            // Extract scripts from request
            std::string pre_request_script;
            std::string post_request_script;
            if (json.contains("preRequestScript") && json["preRequestScript"].is_string()) {
                pre_request_script = json["preRequestScript"].get<std::string>();
            }
            if (json.contains("postRequestScript") && json["postRequestScript"].is_string()) {
                post_request_script = json["postRequestScript"].get<std::string>();
            }

            // Create Run (Design Mode)
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

            // Log Design Mode request details
            std::string method_str =
                json.contains("method") ? json["method"].get<std::string>() : "UNKNOWN";
            std::string url_str = json.contains("url") ? json["url"].get<std::string>() : "UNKNOWN";
            bool has_pre_script = !pre_request_script.empty();
            bool has_post_script = !post_request_script.empty();
            std::string env_id = run.environment_id.value_or("none");
            std::string req_id = run.request_id.value_or("none");

            vayu::utils::log_info("POST /request - Design Mode: run_id=" + run_id +
                                  ", method=" + method_str + ", url=" + url_str +
                                  ", request_id=" + req_id + ", environment_id=" + env_id +
                                  ", has_pre_script=" + (has_pre_script ? "true" : "false") +
                                  ", has_post_script=" + (has_post_script ? "true" : "false"));

            try {
                ctx.db.create_run(run);
            } catch (const std::exception& e) {
                res.status = 500;
                nlohmann::json error;
                error["error"]["code"] = "DATABASE_ERROR";
                error["error"]["message"] = "Failed to create run: " + std::string(e.what());
                res.set_content(error.dump(), "application/json");
                return;
            }

            // Initialize script engine with config from database
            vayu::runtime::ScriptConfig script_config;
            script_config.timeout_ms = static_cast<uint64_t>(ctx.db.get_config_int(
                "scriptTimeout",
                vayu::core::constants::script_engine::TIMEOUT_MS));
            script_config.memory_limit = static_cast<size_t>(ctx.db.get_config_int(
                "scriptMemoryLimit",
                vayu::core::constants::script_engine::MEMORY_LIMIT));
            script_config.stack_size = static_cast<size_t>(ctx.db.get_config_int(
                "scriptStackSize",
                vayu::core::constants::script_engine::STACK_SIZE));
            script_config.enable_console = ctx.db.get_config_bool(
                "scriptEnableConsole",
                vayu::core::constants::script_engine::ENABLE_CONSOLE);

            vayu::runtime::ScriptEngine script_engine(script_config);
            
            // Load variables from database
            vayu::Environment env;
            vayu::Environment globals;
            vayu::Environment collectionVariables;

            // Load environment variables if environmentId is provided
            if (run.environment_id.has_value()) {
                auto db_env = ctx.db.get_environment(*run.environment_id);
                if (db_env) {
                    env = parse_variables_json(db_env->variables);
                }
            }

            // Load global variables
            auto db_globals = ctx.db.get_globals();
            if (db_globals) {
                globals = parse_variables_json(db_globals->variables);
            }

            // Load collection variables if requestId is provided
            if (run.request_id.has_value()) {
                auto db_request = ctx.db.get_request(*run.request_id);
                if (db_request && !db_request->collection_id.empty()) {
                    auto db_collection = ctx.db.get_collection(db_request->collection_id);
                    if (db_collection) {
                        collectionVariables = parse_variables_json(db_collection->variables);
                    }
                }
            }

            // Track script results for response
            vayu::ScriptResult pre_script_result;
            vayu::ScriptResult post_script_result;
            bool pre_script_failed = false;

            // Get the request (may be modified by pre-request script)
            auto request = request_result.value();

            // Execute pre-request script if provided
            if (!pre_request_script.empty()) {
                try {
                    vayu::runtime::ScriptContext script_ctx;
                    script_ctx.request = &request;
                    script_ctx.environment = &env;
                    script_ctx.globals = &globals;
                    script_ctx.collectionVariables = &collectionVariables;
                    pre_script_result = script_engine.execute(pre_request_script, script_ctx);

                    if (!pre_script_result.success) {
                        pre_script_failed = true;
                        vayu::utils::log_warning("Pre-request script failed: " +
                                                 pre_script_result.error_message);
                    }
                } catch (const std::exception& e) {
                    pre_script_result.success = false;
                    pre_script_result.error_message = std::string("Script exception: ") + e.what();
                    pre_script_failed = true;
                    vayu::utils::log_error("Pre-request script exception: " +
                                           std::string(e.what()));
                }
            }

            // Send request (even if pre-script failed, unless it's a blocking error)
            vayu::http::ClientConfig config;
            config.verbose = ctx.verbose;
            vayu::http::Client client(config);

            auto response_result = client.send(request);

            // Handle both errors and successful responses
            // client.send() now always returns Response (never Error), but Response may have error_code set
            if (response_result.is_error()) {
                // This should not happen anymore, but handle it for safety
                vayu::utils::log_error("Unexpected error result from client.send()");
                res.status = 500;
                nlohmann::json error_json;
                error_json["error"]["code"] = "INTERNAL_ERROR";
                error_json["error"]["message"] = "Unexpected error from HTTP client";
                res.set_content(error_json.dump(), "application/json");
                return;
            }

            const auto& response = response_result.value();
            const bool has_error = response.has_error();

            // Store result (both error and success cases)
            try {
                vayu::db::Result db_result;
                db_result.run_id = run_id;
                db_result.timestamp = now_ms();
                db_result.status_code = response.status_code;
                db_result.latency_ms = response.timing.total_ms;
                db_result.error = has_error ? response.error_message : "";

                // Store request and response data in trace
                nlohmann::json trace;

                // Request information (what was actually sent)
                nlohmann::json request_trace;
                request_trace["method"] = to_string(request.method);
                request_trace["url"] = request.url;
                request_trace["headers"] = request.headers;
                if (!request.body.content.empty()) {
                    request_trace["body"] = request.body.content;
                }
                trace["request"] = request_trace;

                // Response information (empty for client-side errors, populated for server responses)
                if (!has_error) {
                    nlohmann::json response_trace;
                    response_trace["headers"] = response.headers;
                    response_trace["body"] = response.body;
                    trace["response"] = response_trace;
                } else {
                    // For errors, include error details in trace
                    trace["error_type"] = to_string(response.error_code);
                    trace["error_message"] = response.error_message;
                }

                // Timing information (available even for errors)
                const auto& timing = response.timing;
                if (timing.dns_ms > 0) trace["dnsMs"] = timing.dns_ms;
                if (timing.connect_ms > 0) trace["connectMs"] = timing.connect_ms;
                if (timing.tls_ms > 0) trace["tlsMs"] = timing.tls_ms;
                if (timing.first_byte_ms > 0) trace["firstByteMs"] = timing.first_byte_ms;
                if (timing.download_ms > 0) trace["downloadMs"] = timing.download_ms;

                db_result.trace_data = trace.dump();

                ctx.db.add_result(db_result);
                
                if (has_error) {
                    ctx.db.update_run_status_with_retry(run_id, vayu::RunStatus::Failed);
                    run.end_time = now_ms();
                } else {
                    ctx.db.update_run_status_with_retry(run_id, vayu::RunStatus::Completed);
                }

            } catch (const std::exception& e) {
                vayu::utils::log_error("Failed to save result: " + std::string(e.what()));

                try {
                    ctx.db.update_run_status_with_retry(run_id, vayu::RunStatus::Failed);
                } catch (...) {
                    vayu::utils::log_error("Failed to update run status after save error");
                }

                res.status = 500;
                nlohmann::json error;
                error["error"]["code"] = "DATABASE_ERROR";
                error["error"]["message"] =
                    "Request succeeded but failed to save result: " + std::string(e.what());
                error["response"] = vayu::json::serialize(response_result.value());
                res.set_content(error.dump(), "application/json");
                return;
            }

            // Execute post-request (test) script if provided
            if (!post_request_script.empty()) {
                try {
                    vayu::runtime::ScriptContext script_ctx;
                    script_ctx.request = &request;
                    script_ctx.response = &response_result.value();
                    script_ctx.environment = &env;
                    script_ctx.globals = &globals;
                    script_ctx.collectionVariables = &collectionVariables;
                    post_script_result = script_engine.execute(post_request_script, script_ctx);

                    if (!post_script_result.success) {
                        vayu::utils::log_warning("Post-request script failed: " +
                                                 post_script_result.error_message);
                    }
                } catch (const std::exception& e) {
                    post_script_result.success = false;
                    post_script_result.error_message = std::string("Script exception: ") + e.what();
                    vayu::utils::log_error("Post-request script exception: " +
                                           std::string(e.what()));
                }
            }

            // Always return HTTP 200 for successful request execution
            // The Response object contains the actual status code:
            // - 0 for client-side errors (connection failed, invalid URL, timeout, etc.)
            // - Server status code (200-599) for server responses
            res.status = 200;

            // Build response with script results
            nlohmann::json response_json = vayu::json::serialize(response_result.value());

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

            res.set_content(response_json.dump(2), "application/json");

        } catch (const nlohmann::json::exception& e) {
            res.status = 400;
            nlohmann::json error;
            error["error"]["code"] = "INVALID_JSON";
            error["error"]["message"] = "Failed to parse request body: " + std::string(e.what());
            res.set_content(error.dump(), "application/json");

        } catch (const std::exception& e) {
            if (!run_id.empty()) {
                try {
                    ctx.db.update_run_status_with_retry(run_id, vayu::RunStatus::Failed);
                } catch (...) {
                    vayu::utils::log_error("Failed to update run status in error handler");
                }
            }

            res.status = 500;
            nlohmann::json error;
            error["error"]["code"] = "INTERNAL_ERROR";
            error["error"]["message"] = "Unexpected error: " + std::string(e.what());
            res.set_content(error.dump(), "application/json");
        }
    });

    /**
     * POST /run
     * Starts a load test run (Vayu Mode).
     */
    ctx.server.Post("/run", [&ctx](const httplib::Request& req, httplib::Response& res) {
        std::string run_id = "run_" + std::to_string(now_ms());

        try {
            auto json = nlohmann::json::parse(req.body);

            // Validate required HTTP request fields (now at root level, same as /request)
            if (!json.contains("method") || !json.contains("url")) {
                vayu::utils::log_warning("POST /run - Missing required fields: method, url");
                send_error(res, 400, "Missing required fields: method, url");
                return;
            }

            if (!json.contains("mode") && !json.contains("duration") &&
                !json.contains("iterations")) {
                vayu::utils::log_warning("POST /run - Missing mode/duration/iterations config");
                send_error(res, 400, "Must specify either 'mode' with 'duration' or 'iterations'");
                return;
            }

            // Extract config for logging
            std::string mode = json.value("mode", "unspecified");
            // Duration can be a string like "10s" or a number
            std::string duration_str = "0s";
            if (json.contains("duration")) {
                if (json["duration"].is_string()) {
                    duration_str = json["duration"].get<std::string>();
                } else if (json["duration"].is_number()) {
                    duration_str = std::to_string(json["duration"].get<int>()) + "s";
                }
            }
            int iterations = json.value("iterations", 0);
            int rps = json.value("rps", json.value("targetRps", 0));
            int concurrency = json.value("concurrency", 1);

            // Extract request details for logging (now at root level)
            std::string method_str = json.value("method", "UNKNOWN");
            std::string url_str = json.value("url", "UNKNOWN");

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

            std::string env_id = run.environment_id.value_or("none");
            std::string req_id = run.request_id.value_or("none");

            // Log comprehensive Load Test config
            vayu::utils::log_info(
                "POST /run - Load Test: run_id=" + run_id + ", mode=" + mode +
                ", method=" + method_str + ", url=" + url_str + ", duration=" + duration_str +
                ", iterations=" + std::to_string(iterations) + ", rps=" + std::to_string(rps) +
                ", concurrency=" + std::to_string(concurrency) + ", request_id=" + req_id +
                ", environment_id=" + env_id);

            ctx.db.create_run(run);

            // Start run via RunManager
            ctx.run_manager.start_run(run_id, json, ctx.db, ctx.verbose);

            nlohmann::json response;
            response["runId"] = run_id;
            response["status"] = to_string(vayu::RunStatus::Pending);
            response["message"] = "Load test started";

            res.status = 202;
            res.set_content(response.dump(), "application/json");

        } catch (const std::exception& e) {
            vayu::utils::log_error("POST /run - Failed to create run " + run_id + ": " + e.what());
            send_error(res, 500, "Failed to create run: " + std::string(e.what()));
        }
    });
}

}  // namespace vayu::http::routes
