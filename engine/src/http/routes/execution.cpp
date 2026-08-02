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

#include <cmath>
#include <optional>
#include <regex>
#include <string>

#include "vayu/core/constants.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/request_composer.hpp"
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

// Stamp a freshly built run row's timestamps. `end_time` is seeded to
// `start_time` rather than left at its default, because a run killed by a
// daemon crash never reaches a terminal status: `reconcile_orphaned_runs`
// marks it Failed and leaves `end_time` as recorded, and the report route
// reads `end_time > 0 ? end_time : now_ms()` - so an unseeded row would
// report a duration spanning however long the daemon was down. Seeded, a
// crashed run reports a zero duration, which is honest about knowing nothing.
// Both insert sites (design and load) go through here so the invariant has one
// home; `Run::end_time` still defaults to 0 as the backstop for any future one.
void seed_run_times (vayu::db::Run& run, int64_t started_at) {
    run.start_time = started_at;
    run.end_time   = started_at;
}

// Validate and normalize the optional "httpVersion" on a POST /runs body.
// Absent leaves `json` untouched: the request's own httpVersion field, read
// like any other field by build_request/deserialize_request further down the
// pipeline, decides. This is NOT a per-run override - the request builder's
// Settings tab holds the single protocol control and it governs Send and load
// test alike. The field exists on this payload because that is how a run
// states its protocol at all, the same way it states its redirect policy, and
// because MCP's ad-hoc runs have no saved request to read one from. It never
// touches the stored request - `json` here is the handler's local copy of the
// request body, not anything persisted.
//
// Present is validated through apply_http_version_field/http_version_valid_list
// (the same helpers Task 5's CRUD routes use - see routes.hpp), so a typo'd
// protocol name is a 400 naming the field and the valid values, rather than
// deserialize_request's lenient string-to-Auto coercion, which exists to keep
// a corrupted *stored* row executable and is the wrong behavior for a
// hand-crafted /runs body.
//
// An explicit `null` is erased, making it behave exactly like an absent key,
// so this function has two outcomes rather than three.
//
// Be precise about why, because the obvious justification is wrong: there is
// no stored-request lookup in this pipeline. `build_request` deserializes the
// same POST body this function mutates, so the only `httpVersion` in play is
// the one the client sent (clients send the whole request here, the same way
// they do followRedirects/maxRedirects). The `db.get_request` calls further
// down this file read `collection_id` to persist collection variables; they
// never read `http_version`.
//
// So today, erasing and writing the seed are indistinguishable: both end at
// `Auto`, because `Request::http_version`'s default member initializer is
// `DEFAULT_HTTP_VERSION` - the very value the seed would have written. That
// equivalence is incidental, and erasing is what keeps it from becoming a bug.
// The moment a config-backed default is resolved at this layer, writing a seed
// would start pinning a concrete value onto a run that asked for none, while
// erasing keeps deferring to whatever decides later.
//
// This is also why CLAUDE.md's null-means-reset-to-default rule does not apply:
// that rule resets a *stored* field on POST/PUT of a resource, and a run has no
// stored field to reset.
//
// The validated value is written back onto `json["httpVersion"]` so it reaches
// deserialize_request as a concrete string; `null` would otherwise hit
// `.get<std::string>()` there and throw.
std::optional<std::pair<int, nlohmann::json>> normalize_run_http_version (
nlohmann::json& json) {
    if (!json.contains ("httpVersion")) {
        return std::nullopt;
    }
    if (json["httpVersion"].is_null ()) {
        json.erase ("httpVersion");
        return std::nullopt;
    }
    // Both early returns above mean the key is present and non-null by now, so
    // the two branches of apply_http_version_field that consume `seed` are
    // unreachable from here. The argument is required by the signature; it does
    // not select behaviour at this call site.
    std::string version;
    if (auto err = apply_http_version_field (json, "httpVersion", version,
        vayu::to_string (vayu::DEFAULT_HTTP_VERSION), /*is_create=*/false)) {
        return err;
    }
    json["httpVersion"] = version;
    return std::nullopt;
}

// Build the trace_data JSON a design run persists for its single exchange.
// Non-static (tested by execution_trace_test.cpp): the stored trace is a
// contract - restore-response.ts rebuilds the response pane from it after a
// restart, so what lands here decides what a restored tab can show.
//
// Timing carries all eight keys, unconditionally, the same `*Ms` set the live
// /execute response serializes (json.cpp) and the load-mode success writer
// stores (load_strategy.cpp). A skipped phase (reused connection, plain HTTP)
// is stored as 0, exactly as the live response reports it. Rows written before
// this change omitted zero phases and the three totals, so readers must keep
// defaulting missing keys.
nlohmann::json build_result_trace (const vayu::Request& request,
const vayu::Response& response) {
    nlohmann::json trace;
    trace["request"] = { { "method", to_string (request.method) },
        { "url", request.url }, { "headers", request.headers } };
    if (!request.body.content.empty ()) {
        trace["request"]["body"] = request.body.content;
    }

    if (!response.has_error ()) {
        // "" when nothing was negotiated, not omitted - same convention as
        // serialize(Response) in json.cpp, so restore-response.ts can't
        // confuse "empty" with "this key doesn't exist on a stored trace".
        trace["response"] = { { "headers", response.headers },
            { "body", response.body }, { "httpVersion", response.http_version },
            { "httpVersionDowngraded", response.http_version_downgraded } };
    } else {
        trace["error_type"]    = to_string (response.error_code);
        trace["error_message"] = response.error_message;
    }

    const auto& timing   = response.timing;
    trace["totalMs"]     = timing.total_ms;
    trace["wireMs"]      = timing.wire_ms;
    trace["queueWaitMs"] = timing.queue_wait_ms;
    trace["dnsMs"]       = timing.dns_ms;
    trace["connectMs"]   = timing.connect_ms;
    trace["tlsMs"]       = timing.tls_ms;
    trace["firstByteMs"] = timing.first_byte_ms;
    trace["downloadMs"]  = timing.download_ms;

    return trace;
}

// The variable scopes a design run's scripts read. The collection scope is the
// request's own collection *chain* - the same walk `{{variable}}` composition
// does (`collection_chain`) - so a name an ancestor collection defines answers
// the same in a script as it does in the URL (issue #234). Only the leaf is
// handed over writable; ancestors ride along read-only, which is what keeps a
// script's `set()` from copying inherited variables down into the leaf on the
// next persist.
ScriptVariableScopes
load_script_variable_scopes (vayu::db::Database& db, const vayu::db::Run& run) {
    ScriptVariableScopes scopes;

    if (run.environment_id.has_value ()) {
        if (auto db_env = db.get_environment (*run.environment_id)) {
            scopes.environment = vayu::json::parse_variables (db_env->variables);
        }
    }

    if (auto db_globals = db.get_globals ()) {
        scopes.globals = vayu::json::parse_variables (db_globals->variables);
    }

    if (run.request_id.has_value ()) {
        if (auto db_request = db.get_request (*run.request_id)) {
            if (!db_request->collection_id.empty ()) {
                auto chain = vayu::http::collection_chain (db, db_request->collection_id);
                if (!chain.empty ()) {
                    scopes.collection =
                    vayu::json::parse_variables (chain.back ().variables);
                    scopes.collection_ancestors.reserve (chain.size () - 1);
                    for (size_t i = 0; i + 1 < chain.size (); ++i) {
                        scopes.collection_ancestors.push_back (
                        vayu::json::parse_variables (chain[i].variables));
                    }
                }
            }
        }
    }

    return scopes;
}

// Persist script-set variables to DB (design mode only). Best-effort: logs errors, does not change response.
//
// A scope is rewritten only when a script actually changed one of its
// variables. Before this, every Send rewrote all three scopes unconditionally,
// which bumped each scope's `updated_at` for a run that touched nothing and,
// worse, pushed every variable through the serializer - so any field the
// serializer did not know about was erased from disk by merely sending a
// request (issue #135). Comparing the parsed on-disk blob with the in-memory
// one is what makes "no script wrote a variable" mean "no write at all".
void persist_script_variables (vayu::db::Database& db,
const vayu::db::Run& run,
const vayu::Environment& env,
const vayu::Environment& globals,
const vayu::Environment& collectionVariables) {
    if (run.environment_id.has_value ()) {
        try {
            if (auto db_env = db.get_environment (*run.environment_id)) {
                if (vayu::json::parse_variables (db_env->variables) != env) {
                    vayu::db::Environment updated = *db_env;
                    updated.variables  = vayu::json::serialize_variables (env);
                    updated.updated_at = now_ms ();
                    db.save_environment (updated);
                }
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "Persist environment variables failed: " + std::string (e.what ()));
        }
    }

    try {
        if (auto db_globals = db.get_globals ()) {
            if (vayu::json::parse_variables (db_globals->variables) != globals) {
                vayu::db::Globals updated = *db_globals;
                updated.variables  = vayu::json::serialize_variables (globals);
                updated.updated_at = now_ms ();
                db.save_globals (updated);
            }
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
                        if (vayu::json::parse_variables (db_collection->variables) !=
                        collectionVariables) {
                            vayu::db::Collection updated = *db_collection;
                            updated.variables =
                            vayu::json::serialize_variables (collectionVariables);
                            updated.updated_at = now_ms ();
                            db.create_collection (updated);
                        }
                    }
                }
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "Persist collection variables failed: " + std::string (e.what ()));
        }
    }
}

namespace {

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

    /*
     * Combine console output from both scripts.
     *
     * `source` is a field rather than the `"[pre] "` text prefix this used to
     * carry: the prefix was indistinguishable from a script that logged a line
     * beginning with those six characters, and adding a second prefix for the
     * level would have doubled that ambiguity instead of removing it.
     */
    nlohmann::json all_console_output = nlohmann::json::array ();
    const auto append = [&all_console_output] (const char* source,
                        const std::vector<vayu::ConsoleEntry>& entries) {
        for (const auto& entry : entries) {
            all_console_output.push_back ({ { "source", source },
            { "level", vayu::to_string (entry.level) },
            { "message", entry.message } });
        }
    };
    append ("pre", pre_script_result.console_output);
    append ("test", post_script_result.console_output);
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

        // Build the full-fidelity trace, then cap the request/response bodies at
        // the configured limit so one large exchange cannot bloat the DB forever.
        // When a body is cut, cap_trace_bodies records bodyTruncated/bodyBytes.
        nlohmann::json trace = build_result_trace (request, response);
        const auto max_trace_body_bytes = static_cast<size_t> (db.get_config_int (
        "maxTraceBodyBytes",
        static_cast<int> (vayu::core::constants::json::MAX_TRACE_BODY_BYTES)));
        vayu::json::cap_trace_bodies (trace, max_trace_body_bytes);

        // A capped body may split a UTF-8 sequence, and the raw response body can
        // be arbitrary bytes - dump with error_handler_t::replace so a lone
        // continuation byte becomes U+FFFD instead of throwing (import.cpp uses
        // the same guard).
        db_result.trace_data =
        trace.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace);
        db.add_result (db_result);

        auto status = has_error ? vayu::RunStatus::Failed : vayu::RunStatus::Completed;
        db.update_run_status_with_retry (run_id, status);

        // A design run reached a terminal status - trim the run history so
        // per-request clicks do not accumulate forever (retention knobs, or 0
        // to disable). Best-effort: a prune failure must not fail the request.
        try {
            db.prune_runs_configured ();
        } catch (const std::exception& e) {
            vayu::utils::log_warning ("Run pruning failed: " + std::string (e.what ()));
        }

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

// One numeric field of a run config: what it is called on the wire, and the
// closed interval it must fall in. Kept as data so the four checks below read
// as a table rather than four hand-written branches that can drift apart.
struct NumericRunField {
    const char* key;
    int64_t min;
    int64_t max;
    const char* why; // appended to the message, explains the bound
};

// Reject a numeric field that is present but of the wrong JSON type or outside
// its range. Absent is always fine - every field has a default.
std::optional<std::string> check_numeric_field (const nlohmann::json& config,
const NumericRunField& field) {
    if (!config.contains (field.key) || config[field.key].is_null ()) {
        return std::nullopt;
    }
    const auto& value = config[field.key];
    if (!value.is_number ()) {
        return std::string ("'") + field.key + "' must be a number (got " +
        std::string (value.type_name ()) + ")";
    }
    // Read as a double first: an integer read of a fractional or huge value is
    // itself undefined, and this is the guard that has to be total.
    const double raw = value.get<double> ();
    if (!std::isfinite (raw) || raw < static_cast<double> (field.min) ||
    raw > static_cast<double> (field.max)) {
        return std::string ("'") + field.key + "' must be between " +
        std::to_string (field.min) + " and " + std::to_string (field.max) +
        " (got " + value.dump () + "). " + field.why;
    }
    return std::nullopt;
}

} // namespace

/**
 * @brief Validate a POST /runs config before the run row is created.
 *
 * Every field below is read downstream with `config.value (...)` and cast to
 * `size_t` or fed to a modulo, in code that runs on a detached worker thread
 * with no `catch` above it. Out of range there is not a bad run, it is a dead
 * daemon: `success_sample_rate: 0` is `% 0` (SIGFPE), `concurrency: -1` becomes
 * ~1.8e19 eagerly pre-allocated curl handles, `timeout: 0` leaves transfers
 * that never expire, and a JSON-number `duration` throws out of `RunContext`'s
 * constructor *after* the run row exists, stranding it `pending` forever.
 *
 * So this runs in the route, before `create_run`: a rejected request must leave
 * no trace. Non-static - `run_config_validation_test.cpp` drives it directly.
 *
 * @return The reason the config is invalid, or `std::nullopt` if it is usable.
 */
std::optional<std::string> validate_run_config (const nlohmann::json& config) {
    if (!config.is_object ()) {
        return "Run config must be a JSON object";
    }

    // `duration` is the one non-numeric field here, and the only one whose bad
    // value throws rather than miscomputes: `RunContext` reads it as a string.
    if (config.contains ("duration") && !config["duration"].is_null ()) {
        const auto& duration = config["duration"];
        if (!duration.is_string ()) {
            return "'duration' must be a string with a unit, e.g. \"60s\" "
                   "(got " +
            std::string (duration.type_name ()) + ")";
        }
        // Accept an optional unit: the unit-aware parser is #126's, and a bare
        // "60" is what a client that never read the docs sends. This only has
        // to separate "parses to something positive" from "wedges the run".
        static const std::regex duration_pattern (
        R"(^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$)", std::regex::icase);
        std::smatch match;
        const std::string text = duration.get<std::string> ();
        if (!std::regex_match (text, match, duration_pattern)) {
            return "'duration' must be a number with an optional unit "
                   "(ms|s|m|h), e.g. \"60s\" (got \"" +
            text + "\")";
        }
        // The regex already proved group 1 is a plain decimal, so `stod` cannot
        // fail on it - but this guard exists precisely because a conversion
        // threw somewhere nobody was catching, so it stays total here too.
        double magnitude = 0.0;
        try {
            magnitude = std::stod (match[1].str ());
        } catch (const std::exception&) {
            magnitude = 0.0; // out of double's range; falls into the check below
        }
        if (!(magnitude > 0.0)) {
            return "'duration' must be greater than zero (got \"" + text + "\")";
        }
    }

    namespace limits               = vayu::core::constants::run_config;
    const NumericRunField fields[] = {
        { "success_sample_rate", 1, 100000,
        "It is a sampling period (keep 1 in N), and 0 is a division by zero." },
        { "response_sample_rate", 1, 100000,
        "It is a sampling period (keep 1 in N), and 0 is a division by zero." },
        { "max_response_samples", 0, limits::MAX_RESPONSE_SAMPLES,
        "Each retained sample holds a full response body." },
        { "concurrency", 1, limits::MAX_CONCURRENCY,
        "Connections are pre-allocated per worker before any traffic flows." },
        { "timeout", 1, 86400000,
        "A transfer with no timeout never completes, so the run can never "
        "reach "
        "a terminal status." },
    };
    for (const auto& field : fields) {
        if (auto reason = check_numeric_field (config, field)) {
            return reason;
        }
    }

    return std::nullopt;
}

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
        std::string pre_request_script = vayu::http::read_pre_request_script (json);
        std::string post_request_script = vayu::http::read_post_request_script (json);

        // Create Run record
        run_id = vayu::utils::generate_id ("run_");
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Design;
        run.status          = vayu::RunStatus::Running;
        run.config_snapshot = vayu::json::sanitize_config_snapshot (req.body);
        seed_run_times (run, now_ms ());

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
        auto scopes                = load_script_variable_scopes (ctx.db, run);
        vayu::Environment& env     = scopes.environment;
        vayu::Environment& globals = scopes.globals;
        vayu::Environment& collectionVariables = scopes.collection;

        // Take the request built above. Auth is already resolved into its
        // headers/url, so pm.request reflects the real outgoing set - and
        // because the pre-request script runs after that and writes back into
        // this same object, a script-set Authorization header wins over the
        // engine-applied one.
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

        // Execute pre-request script. `make_request_mutable` is what makes its
        // pm.request edits reach the wire; everything below this line - the
        // send, the stored trace, the raw request the app shows - reads the
        // post-script request.
        vayu::runtime::ScriptContext pre_ctx;
        pre_ctx.make_request_mutable (request);
        pre_ctx.environment         = &env;
        pre_ctx.globals             = &globals;
        pre_ctx.collectionVariables = &collectionVariables;
        pre_ctx.collectionAncestors = &scopes.collection_ancestors;
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
        post_ctx.collectionAncestors = &scopes.collection_ancestors;
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

        // Range-check the numeric config *before* the run row exists, so a
        // rejected request leaves nothing behind. `invalid_run_config` is the
        // specific code this failure carries in place of the per-status default.
        if (auto invalid = validate_run_config (json)) {
            vayu::utils::log_warning ("POST /runs - Invalid run config: " + *invalid);
            send_error (res, 400, *invalid, "invalid_run_config");
            return;
        }

        // Validate/normalize the body's httpVersion, beside the config check
        // above and for the same reason: both run before run.config_snapshot is
        // built, so a rejected request leaves no row behind, and the snapshot
        // still reflects the raw client body (sanitize_config_snapshot reads
        // req.body directly, not this normalized `json`).
        if (auto err = normalize_run_http_version (json)) {
            vayu::utils::log_warning (
            "POST /runs - Invalid httpVersion: " + err->second.dump ());
            res.status = err->first;
            res.set_content (err->second.dump (), "application/json");
            return;
        }

        // Create run record
        std::string run_id = vayu::utils::generate_id ("run_");
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = vayu::json::sanitize_config_snapshot (req.body);
        seed_run_times (run, now_ms ());

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
            res.set_content (
            error_body (res.status, preflight.message, preflight.detail_code).dump (),
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

        // Start run via RunManager. A refusal means the daemon is draining its
        // workers for shutdown; the row exists but nothing will ever run it, so
        // say so rather than returning a 202 for a run that never starts.
        if (!ctx.run_manager.start_run (run_id, json, ctx.db, ctx.verbose)) {
            send_error (res, 503, "Engine is shutting down");
            return;
        }

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
