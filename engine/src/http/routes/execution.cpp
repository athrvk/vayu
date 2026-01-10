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

            // Initialize script engine and environment
            vayu::runtime::ScriptEngine script_engine;
            vayu::Environment env;

            // Track script results for response
            vayu::ScriptResult pre_script_result;
            vayu::ScriptResult post_script_result;
            bool pre_script_failed = false;

            // Get the request (may be modified by pre-request script)
            auto request = request_result.value();

            // Execute pre-request script if provided
            if (!pre_request_script.empty()) {
                try {
                    pre_script_result =
                        script_engine.execute_prerequest(pre_request_script, request, env);

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

            // Handle request errors
            if (response_result.is_error()) {
                const auto& error = response_result.error();

                try {
                    ctx.db.update_run_status_with_retry(run_id, vayu::RunStatus::Failed);
                    run.end_time = now_ms();

                    vayu::db::Result db_result;
                    db_result.run_id = run_id;
                    db_result.timestamp = run.end_time;
                    db_result.status_code = 0;
                    db_result.latency_ms = 0.0;
                    db_result.error = error.message;
                    ctx.db.add_result(db_result);
                } catch (const std::exception& db_error) {
                    vayu::utils::log_error("Failed to update run status: " +
                                           std::string(db_error.what()));
                }

                if (error.code == vayu::ErrorCode::Timeout) {
                    res.status = 504;
                } else if (error.code == vayu::ErrorCode::DnsError) {
                    res.status = 502;
                } else if (error.code == vayu::ErrorCode::ConnectionFailed) {
                    res.status = 503;
                } else {
                    res.status = 502;
                }

                res.set_content(vayu::json::serialize(error).dump(), "application/json");
                return;
            }

            // Store successful result
            try {
                vayu::db::Result db_result;
                db_result.run_id = run_id;
                db_result.timestamp = now_ms();
                db_result.status_code = response_result.value().status_code;
                db_result.latency_ms = response_result.value().timing.total_ms;
                db_result.error = "";

                nlohmann::json trace;
                trace["headers"] = response_result.value().headers;
                trace["body"] = response_result.value().body;

                const auto& timing = response_result.value().timing;
                if (timing.dns_ms > 0) trace["dns_ms"] = timing.dns_ms;
                if (timing.connect_ms > 0) trace["connect_ms"] = timing.connect_ms;
                if (timing.tls_ms > 0) trace["tls_ms"] = timing.tls_ms;
                if (timing.first_byte_ms > 0) trace["first_byte_ms"] = timing.first_byte_ms;
                if (timing.download_ms > 0) trace["download_ms"] = timing.download_ms;

                db_result.trace_data = trace.dump();

                ctx.db.add_result(db_result);
                ctx.db.update_run_status_with_retry(run_id, vayu::RunStatus::Completed);

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
                    post_script_result = script_engine.execute_test(
                        post_request_script, request, response_result.value(), env);

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
        vayu::utils::log_debug("Received POST /run, run_id=" + run_id);

        try {
            auto json = nlohmann::json::parse(req.body);

            vayu::utils::log_debug("Load test config: mode=" + json.value("mode", "unspecified"));

            if (!json.contains("request")) {
                send_error(res, 400, "Missing required field: request");
                return;
            }

            if (!json.contains("mode") && !json.contains("duration") &&
                !json.contains("iterations")) {
                send_error(res, 400, "Must specify either 'mode' with 'duration' or 'iterations'");
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
            send_error(res, 500, "Failed to create run: " + std::string(e.what()));
        }
    });
}

}  // namespace vayu::http::routes
