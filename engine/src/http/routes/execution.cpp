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
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/http/status.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

// Resolve the effective HTTP request timeout for design-mode POST /request.
// An explicit per-request "timeout" wins; otherwise fall back to the engine's
// user-configurable `defaultTimeout` setting (passed in by the caller) rather
// than the compile-time DEFAULT_TIMEOUT_MS, so raising the setting actually
// extends how long a slow request is allowed to run.
int resolve_request_timeout_ms (const nlohmann::json& json, int configured_default) {
    if (json.contains ("timeout") && json["timeout"].is_number ()) {
        return json["timeout"].get<int> ();
    }
    return configured_default;
}

namespace {

// Helper function to parse variables JSON string to Environment
vayu::Environment parse_variables_json (const std::string& json_str) {
    vayu::Environment env;
    if (json_str.empty ()) {
        return env;
    }

    try {
        auto json = nlohmann::json::parse (json_str);
        if (json.is_object ()) {
            for (auto& [key, value] : json.items ()) {
                if (value.is_object ()) {
                    std::string var_value = value.value ("value", "");
                    bool enabled          = value.value ("enabled", true);
                    bool secret           = value.value ("secret", false);
                    std::string type      = value.value ("type", std::string{ "string" });
                    env[key] = vayu::Variable{ var_value, secret, enabled, type };
                }
            }
        }
    } catch (const std::exception&) {
        // Return empty environment on parse error
    }
    return env;
}

// Serialize in-memory variables map to JSON string for DB storage (round-trip with parse_variables_json)
std::string serialize_variables_json (const vayu::Environment& env) {
    nlohmann::json obj = nlohmann::json::object ();
    for (const auto& [key, var] : env) {
        obj[key] = nlohmann::json::object ();
        obj[key]["value"]   = var.value;
        obj[key]["enabled"] = var.enabled;
        obj[key]["secret"]  = var.secret;
        obj[key]["type"]    = var.type.empty () ? std::string{ "string" } : var.type;
    }
    return obj.dump ();
}

// Persist script-set variables to DB (design mode only). Best-effort: logs errors, does not change response.
void persist_script_variables (vayu::db::Database& db,
const vayu::db::Run& run,
const vayu::Environment& env,
const vayu::Environment& globals,
const vayu::Environment& collectionVariables) {
    if (run.environment_id.has_value ()) {
        try {
            if (auto db_env = db.get_environment (*run.environment_id)) {
                vayu::db::Environment updated = *db_env;
                updated.variables  = serialize_variables_json (env);
                updated.updated_at = now_ms ();
                db.save_environment (updated);
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "Persist environment variables failed: " + std::string (e.what ()));
        }
    }

    try {
        if (auto db_globals = db.get_globals ()) {
            vayu::db::Globals updated = *db_globals;
            updated.variables  = serialize_variables_json (globals);
            updated.updated_at = now_ms ();
            db.save_globals (updated);
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "Persist globals failed: " + std::string (e.what ()));
    }

    if (run.request_id.has_value ()) {
        try {
            if (auto db_request = db.get_request (*run.request_id)) {
                if (!db_request->collection_id.empty ()) {
                    if (auto db_collection =
                        db.get_collection (db_request->collection_id)) {
                        vayu::db::Collection updated = *db_collection;
                        updated.variables  = serialize_variables_json (collectionVariables);
                        updated.updated_at = now_ms ();
                        db.create_collection (updated);
                    }
                }
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "Persist collection variables failed: " + std::string (e.what ()));
        }
    }
}

// Execute a script and handle exceptions uniformly
vayu::ScriptResult execute_script (vayu::runtime::ScriptEngine& engine,
const std::string& script,
vayu::runtime::ScriptContext& ctx,
const std::string& script_type) {
    vayu::ScriptResult result;
    if (script.empty ()) {
        return result;
    }

    try {
        result = engine.execute (script, ctx);
        if (!result.success) {
            vayu::utils::log_warning (script_type + " script failed: " + result.error_message);
        }
    } catch (const std::exception& e) {
        result.success       = false;
        result.error_message = std::string ("Script exception: ") + e.what ();
        vayu::utils::log_error (
        script_type + " script exception: " + std::string (e.what ()));
    }
    return result;
}

// Build the final response JSON with script results
nlohmann::json build_response_json (const vayu::Response& response,
const vayu::ScriptResult& pre_script_result,
const vayu::ScriptResult& post_script_result) {
    nlohmann::json response_json = vayu::json::serialize (response);

    // Add test results from post-request script
    if (!post_script_result.tests.empty ()) {
        nlohmann::json test_results = nlohmann::json::array ();
        for (const auto& test : post_script_result.tests) {
            nlohmann::json test_json;
            test_json["name"]   = test.name;
            test_json["passed"] = test.passed;
            if (!test.error_message.empty ()) {
                test_json["error"] = test.error_message;
            }
            test_results.push_back (test_json);
        }
        response_json["testResults"] = test_results;
    }

    // Combine console output from both scripts
    std::vector<std::string> all_console_output;
    for (const auto& line : pre_script_result.console_output) {
        all_console_output.push_back ("[pre] " + line);
    }
    for (const auto& line : post_script_result.console_output) {
        all_console_output.push_back (line);
    }
    if (!all_console_output.empty ()) {
        response_json["consoleLogs"] = all_console_output;
    }

    // Add script errors if any
    if (!pre_script_result.success && !pre_script_result.error_message.empty ()) {
        response_json["preScriptError"] = pre_script_result.error_message;
    }
    if (!post_script_result.success && !post_script_result.error_message.empty ()) {
        response_json["postScriptError"] = post_script_result.error_message;
    }

    return response_json;
}

// Store result to database (logs errors but doesn't throw)
void store_result (vayu::db::Database& db,
const std::string& run_id,
const vayu::Request& request,
const vayu::Response& response) {
    try {
        const bool has_error = response.has_error ();

        vayu::db::Result db_result;
        db_result.run_id      = run_id;
        db_result.timestamp   = now_ms ();
        db_result.status_code = response.status_code;
        db_result.status_text = response.status_text;
        db_result.latency_ms  = response.timing.total_ms;
        db_result.error       = has_error ? response.error_message : "";

        // Build trace data
        nlohmann::json trace;
        trace["request"] = { { "method", to_string (request.method) },
            { "url", request.url }, { "headers", request.headers } };
        if (!request.body.content.empty ()) {
            trace["request"]["body"] = request.body.content;
        }

        if (!has_error) {
            trace["response"] = { { "headers", response.headers },
                { "body", response.body } };
        } else {
            trace["error_type"]    = to_string (response.error_code);
            trace["error_message"] = response.error_message;
        }

        // Timing information
        const auto& timing = response.timing;
        if (timing.dns_ms > 0)
            trace["dnsMs"] = timing.dns_ms;
        if (timing.connect_ms > 0)
            trace["connectMs"] = timing.connect_ms;
        if (timing.tls_ms > 0)
            trace["tlsMs"] = timing.tls_ms;
        if (timing.first_byte_ms > 0)
            trace["firstByteMs"] = timing.first_byte_ms;
        if (timing.download_ms > 0)
            trace["downloadMs"] = timing.download_ms;

        db_result.trace_data = trace.dump ();
        db.add_result (db_result);

        auto status = has_error ? vayu::RunStatus::Failed : vayu::RunStatus::Completed;
        db.update_run_status_with_retry (run_id, status);

    } catch (const std::exception& e) {
        vayu::utils::log_error ("Failed to save result: " + std::string (e.what ()));
        try {
            db.update_run_status_with_retry (run_id, vayu::RunStatus::Failed);
        } catch (...) {
            vayu::utils::log_error (
            "Failed to update run status after save error");
        }
    }
}

} // namespace

void register_execution_routes (RouteContext& ctx) {
    /**
     * POST /execute  (alias: POST /request, deprecated)
     * Executes a single HTTP request (Design Mode).
     *
     * Returns:
     * - 200: Request was processed (check response body for server status/errors)
     * - 400: Invalid request format (malformed JSON, missing required fields)
     */
    httplib::Server::Handler execute_request =
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        std::string run_id;

        // Parse and validate request
        nlohmann::json json;
        try {
            json = nlohmann::json::parse (req.body);
        } catch (const nlohmann::json::exception& e) {
            vayu::utils::log_warning (
            "POST /execute - Invalid JSON: " + std::string (e.what ()));
            send_error (res, 400, "Invalid JSON: " + std::string (e.what ()));
            return;
        }

        // Build the request once: deserialize + timeout + auth. A malformed
        // payload fails here (before any run record is created); an auth
        // failure is surfaced after the run exists (below).
        const int request_timeout_ms = resolve_request_timeout_ms (
        json, ctx.db.get_config_int (
        "defaultTimeout", vayu::core::constants::server::DEFAULT_TIMEOUT_MS));
        auto built = vayu::http::build_request (json, &ctx.db, request_timeout_ms);
        if (built.parse_failed) {
            vayu::utils::log_warning ("POST /execute - Invalid request format");
            send_error (res, 400, built.error_message);
            return;
        }

        // Extract scripts
        std::string pre_request_script =
        vayu::http::read_script (json, "preRequestScripts", "preRequestScript");
        std::string post_request_script =
        vayu::http::read_script (json, "postRequestScripts", "postRequestScript");

        // Create Run record
        run_id = vayu::utils::generate_id ("run_");
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Design;
        run.status          = vayu::RunStatus::Running;
        run.start_time      = now_ms ();
        run.config_snapshot = vayu::json::sanitize_config_snapshot (req.body);

        if (json.contains ("requestId") && !json["requestId"].is_null ()) {
            run.request_id = json["requestId"].get<std::string> ();
        }
        if (json.contains ("environmentId") && !json["environmentId"].is_null ()) {
            run.environment_id = json["environmentId"].get<std::string> ();
        }

        // Log request details
        vayu::utils::log_info ("POST /execute - Design Mode: run_id=" + run_id +
        ", method=" + json.value ("method", "UNKNOWN") +
        ", url=" + json.value ("url", "UNKNOWN") +
        ", request_id=" + run.request_id.value_or ("none") +
        ", environment_id=" + run.environment_id.value_or ("none") +
        ", has_pre_script=" + std::string (!pre_request_script.empty () ? "true" : "false") +
        ", has_post_script=" + std::string (!post_request_script.empty () ? "true" : "false"));

        try {
            ctx.db.create_run (run);
        } catch (const std::exception& e) {
            vayu::utils::log_error ("Failed to create run: " + std::string (e.what ()));
            send_error (res, 400, "Failed to create run record");
            return;
        }

        // Initialize script engine
        vayu::runtime::ScriptConfig script_config;
        script_config.timeout_ms = static_cast<uint64_t> (ctx.db.get_config_int (
        "scriptTimeout", vayu::core::constants::script_engine::TIMEOUT_MS));
        script_config.memory_limit = static_cast<size_t> (ctx.db.get_config_int (
        "scriptMemoryLimit", vayu::core::constants::script_engine::MEMORY_LIMIT));
        script_config.stack_size = static_cast<size_t> (ctx.db.get_config_int (
        "scriptStackSize", vayu::core::constants::script_engine::STACK_SIZE));
        script_config.enable_console = ctx.db.get_config_bool (
        "scriptEnableConsole", vayu::core::constants::script_engine::ENABLE_CONSOLE);

        vayu::runtime::ScriptEngine script_engine (script_config);

        // Load variables
        vayu::Environment env, globals, collectionVariables;

        if (run.environment_id.has_value ()) {
            if (auto db_env = ctx.db.get_environment (*run.environment_id)) {
                env = parse_variables_json (db_env->variables);
            }
        }

        if (auto db_globals = ctx.db.get_globals ()) {
            globals = parse_variables_json (db_globals->variables);
        }

        if (run.request_id.has_value ()) {
            if (auto db_request = ctx.db.get_request (*run.request_id)) {
                if (!db_request->collection_id.empty ()) {
                    if (auto db_collection =
                        ctx.db.get_collection (db_request->collection_id)) {
                        collectionVariables =
                        parse_variables_json (db_collection->variables);
                    }
                }
            }
        }

        // Take the request built above (auth already resolved into headers/url,
        // so pm.request reflects the real outgoing set). It may be further
        // modified by the pre-request script.
        auto request = std::move (built.request);

        // Auth failure: record a failed result against the run and return the
        // error in the body (engine returns 200; the status lives in the body).
        if (!built.ok) {
            vayu::Response auth_resp;
            auth_resp.status_code   = 0;
            auth_resp.status_text   = vayu::http::status_text (0);
            auth_resp.error_code    = built.error_code;
            auth_resp.error_message = built.error_message;
            store_result (ctx.db, run_id, request, auth_resp);
            nlohmann::json body   = vayu::json::serialize (auth_resp);
            body["authErrorCode"] = built.detail_code;
            res.status            = 200;
            res.set_content (body.dump (2), "application/json");
            return;
        }

        // Execute pre-request script
        vayu::runtime::ScriptContext pre_ctx;
        pre_ctx.request             = &request;
        pre_ctx.environment         = &env;
        pre_ctx.globals             = &globals;
        pre_ctx.collectionVariables = &collectionVariables;
        auto pre_script_result =
        execute_script (script_engine, pre_request_script, pre_ctx, "Pre-request");

        // Send HTTP request
        vayu::http::ClientConfig config;
        config.verbose = ctx.verbose;
        vayu::http::Client client (config);
        const auto response = client.send (request).value ();

        // Store result to database (non-blocking, errors logged)
        store_result (ctx.db, run_id, request, response);

        // Execute post-request script
        vayu::runtime::ScriptContext post_ctx;
        post_ctx.request             = &request;
        post_ctx.response            = &response;
        post_ctx.environment         = &env;
        post_ctx.globals             = &globals;
        post_ctx.collectionVariables = &collectionVariables;
        auto post_script_result =
        execute_script (script_engine, post_request_script, post_ctx, "Post-request");

        // Persist script-set variables (design mode only; best-effort)
        persist_script_variables (ctx.db, run, env, globals, collectionVariables);

        // Build and send response
        // Engine returns 200 - the server's status is in the response body
        res.status = 200;
        res.set_content (
        build_response_json (response, pre_script_result, post_script_result).dump (2),
        "application/json");
    };
    ctx.server.Post ("/execute", execute_request);
    ctx.server.Post ("/request", deprecated_alias (execute_request));

    /**
     * POST /runs  (alias: POST /run, deprecated)
     * Starts a load test run (Vayu Mode).
     *
     * Returns:
     * - 202: Load test accepted and started
     * - 400: Invalid request format
     */
    httplib::Server::Handler start_load_test =
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        // Parse JSON
        nlohmann::json json;
        try {
            json = nlohmann::json::parse (req.body);
        } catch (const nlohmann::json::exception& e) {
            vayu::utils::log_warning (
            "POST /runs - Invalid JSON: " + std::string (e.what ()));
            send_error (res, 400, "Invalid JSON: " + std::string (e.what ()));
            return;
        }

        // Validate required fields
        if (!json.contains ("method") || !json.contains ("url")) {
            vayu::utils::log_warning (
            "POST /runs - Missing required fields: method, url");
            send_error (res, 400, "Missing required fields: method, url");
            return;
        }

        if (!json.contains ("mode") && !json.contains ("duration") &&
        !json.contains ("iterations")) {
            vayu::utils::log_warning (
            "POST /runs - Missing mode/duration/iterations config");
            send_error (res, 400, "Must specify either 'mode' with 'duration' or 'iterations'");
            return;
        }

        // Create run record
        std::string run_id = vayu::utils::generate_id ("run_");
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = vayu::json::sanitize_config_snapshot (req.body);
        run.start_time      = now_ms ();
        run.end_time        = run.start_time;

        if (json.contains ("requestId") && !json["requestId"].is_null ()) {
            run.request_id = json["requestId"].get<std::string> ();
        }
        if (json.contains ("environmentId") && !json["environmentId"].is_null ()) {
            run.environment_id = json["environmentId"].get<std::string> ();
        }

        // Extract duration for logging
        std::string duration_str = "0s";
        if (json.contains ("duration")) {
            if (json["duration"].is_string ()) {
                duration_str = json["duration"].get<std::string> ();
            } else if (json["duration"].is_number ()) {
                duration_str = std::to_string (json["duration"].get<int> ()) + "s";
            }
        }

        vayu::utils::log_info ("POST /runs - Load Test: run_id=" + run_id +
        ", mode=" + json.value ("mode", "unspecified") +
        ", method=" + json.value ("method", "UNKNOWN") +
        ", url=" + json.value ("url", "UNKNOWN") + ", duration=" + duration_str +
        ", iterations=" + std::to_string (json.value ("iterations", 0)) +
        ", rps=" + std::to_string (json.value ("rps", json.value ("targetRps", 0))) +
        ", concurrency=" + std::to_string (json.value ("concurrency", 1)) +
        ", request_id=" + run.request_id.value_or ("none") +
        ", environment_id=" + run.environment_id.value_or ("none"));

        // Pre-flight auth: reject an unauthorizable run before creating it, and
        // warm the token cache so the worker's apply_auth is a cache hit.
        auto preflight =
        vayu::http::preflight_auth (json.value ("auth", nlohmann::json ()), ctx.db);
        if (!preflight.ok) {
            vayu::utils::log_warning ("POST /runs - Auth pre-flight failed: " +
            preflight.message);
            res.status =
            (preflight.code == vayu::ErrorCode::AuthRequired) ? 409 : 400;
            res.set_content (nlohmann::json{ { "error",
                                 { { "code", preflight.detail_code },
                                 { "message", preflight.message } } } }
            .dump (),
            "application/json");
            return;
        }

        try {
            ctx.db.create_run (run);
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /runs - Failed to create run: " + std::string (e.what ()));
            send_error (res, 400, "Failed to create run record");
            return;
        }

        // Start run via RunManager
        ctx.run_manager.start_run (run_id, json, ctx.db, ctx.verbose);

        nlohmann::json response;
        response["runId"]   = run_id;
        response["status"]  = to_string (vayu::RunStatus::Pending);
        response["message"] = "Load test started";

        res.status = 202;
        res.set_content (response.dump (), "application/json");
    };
    ctx.server.Post ("/runs", start_load_test);
    ctx.server.Post ("/run", deprecated_alias (start_load_test));
}

} // namespace vayu::http::routes
