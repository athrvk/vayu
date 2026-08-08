/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/request_exchange.cpp
 * @brief The `POST /execute` handler's body, extracted (issue #353).
 *
 * Every function here was inlined in `http/routes/execution.cpp` until the
 * scenario runner needed the same sequence per step. It moved rather than being
 * copied, and it moved into `vayu_core` because the runner lives there - a
 * second copy in `core/scenario_runner.cpp` would be a copy that never receives
 * this one's fixes.
 */

#include "vayu/http/request_exchange.hpp"

#include <chrono>
#include <utility>

#include "vayu/http/client.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

namespace {

int64_t exchange_now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

} // namespace

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

ScriptVariableScopes load_script_variable_scopes (vayu::db::Database& db,
const std::optional<std::string>& environment_id,
const std::string& collection_id) {
    ScriptVariableScopes scopes;

    if (environment_id.has_value ()) {
        if (auto db_env = db.get_environment (*environment_id)) {
            scopes.environment = vayu::json::parse_variables (db_env->variables);
        }
    }

    if (auto db_globals = db.get_globals ()) {
        scopes.globals = vayu::json::parse_variables (db_globals->variables);
    }

    if (!collection_id.empty ()) {
        auto chain = vayu::http::collection_chain (db, collection_id);
        if (!chain.empty ()) {
            scopes.collection = vayu::json::parse_variables (chain.back ().variables);
            scopes.collection_ancestors.reserve (chain.size () - 1);
            for (size_t i = 0; i + 1 < chain.size (); ++i) {
                scopes.collection_ancestors.push_back (
                vayu::json::parse_variables (chain[i].variables));
            }
        }
    }

    return scopes;
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
    std::string collection_id;
    if (run.request_id.has_value ()) {
        if (auto db_request = db.get_request (*run.request_id)) {
            collection_id = db_request->collection_id;
        }
    }
    return load_script_variable_scopes (db, run.environment_id, collection_id);
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
const std::optional<std::string>& environment_id,
const std::string& collection_id,
const vayu::Environment& env,
const vayu::Environment& globals,
const vayu::Environment& collectionVariables) {
    if (environment_id.has_value ()) {
        try {
            if (auto db_env = db.get_environment (*environment_id)) {
                if (vayu::json::parse_variables (db_env->variables) != env) {
                    vayu::db::Environment updated = *db_env;
                    updated.variables  = vayu::json::serialize_variables (env);
                    updated.updated_at = exchange_now_ms ();
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
                updated.updated_at = exchange_now_ms ();
                db.save_globals (updated);
            }
        }
    } catch (const std::exception& e) {
        vayu::utils::log_error ("Persist globals failed: " + std::string (e.what ()));
    }

    if (!collection_id.empty ()) {
        try {
            if (auto db_collection = db.get_collection (collection_id)) {
                if (vayu::json::parse_variables (db_collection->variables) != collectionVariables) {
                    vayu::db::Collection updated = *db_collection;
                    updated.variables =
                    vayu::json::serialize_variables (collectionVariables);
                    updated.updated_at = exchange_now_ms ();
                    db.create_collection (updated);
                }
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "Persist collection variables failed: " + std::string (e.what ()));
        }
    }
}

void persist_script_variables (vayu::db::Database& db,
const vayu::db::Run& run,
const vayu::Environment& env,
const vayu::Environment& globals,
const vayu::Environment& collectionVariables) {
    std::string collection_id;
    if (run.request_id.has_value ()) {
        try {
            if (auto db_request = db.get_request (*run.request_id)) {
                collection_id = db_request->collection_id;
            }
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "Persist collection variables failed: " + std::string (e.what ()));
        }
    }
    persist_script_variables (
    db, run.environment_id, collection_id, env, globals, collectionVariables);
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

ExchangeOutcome execute_exchange (vayu::runtime::ScriptEngine& engine,
vayu::http::CookieJar& jar,
const std::string& cookie_scope,
ScriptVariableScopes& scopes,
ExchangeInputs inputs,
bool verbose) {
    ExchangeOutcome outcome;
    outcome.request = std::move (inputs.request);

    // Where each script's `pm.cookies.jar()` writes are staged. The
    // pre-request script's ride the send below and are persisted by its
    // capture; the post-request script's have no transfer left to carry
    // them, so they are applied here. Either way exactly once - see
    // cookie_jar.hpp.
    std::vector<vayu::http::CookieWrite> pre_cookie_writes;
    std::vector<vayu::http::CookieWrite> post_cookie_writes;

    const auto bind = [&] (vayu::runtime::ScriptContext& ctx,
                      std::vector<vayu::http::CookieWrite>* writes) {
        ctx.cookie_jar          = &jar;
        ctx.cookie_scope        = cookie_scope;
        ctx.cookie_writes       = writes;
        ctx.environment         = &scopes.environment;
        ctx.globals             = &scopes.globals;
        ctx.collectionVariables = &scopes.collection;
        ctx.collectionAncestors = &scopes.collection_ancestors;
        ctx.request_id          = inputs.request_id;
        ctx.request_name        = inputs.request_name;
        ctx.iteration           = inputs.iteration;
        ctx.iteration_count     = inputs.iteration_count;
        ctx.in_scenario         = inputs.in_scenario;
    };

    // Execute pre-request script. `for_prerequest` is what makes its
    // pm.request edits reach the wire; everything below this line - the
    // send, the stored trace, the raw request the app shows - reads the
    // post-script request.
    auto pre_ctx = vayu::runtime::ScriptContext::for_prerequest (outcome.request);
    bind (pre_ctx, &pre_cookie_writes);
    outcome.pre_script_result =
    execute_script (engine, inputs.pre_script, pre_ctx, "Pre-request");

    // `pm.execution.skipRequest()` - nothing goes out, and with no response
    // there is nothing for a test script to assert on either. The script's jar
    // writes are still applied here rather than dropped with the send they were
    // staged for: a `jar().set` that reported success and then vanished is the
    // same silent-loss defect the write half was built to avoid.
    if (outcome.pre_script_result.control.kind == vayu::ScriptControl::Kind::Skip) {
        outcome.sent = false;
        jar.apply (cookie_scope, pre_cookie_writes);
        return outcome;
    }

    vayu::http::ClientConfig config;
    config.verbose       = verbose;
    config.cookie_jar    = &jar;
    config.cookie_scope  = cookie_scope;
    config.cookie_writes = std::move (pre_cookie_writes);
    vayu::http::Client client (config);
    outcome.response = client.send (outcome.request).value ();

    auto post_ctx =
    vayu::runtime::ScriptContext::for_test (outcome.request, outcome.response);
    bind (post_ctx, &post_cookie_writes);
    outcome.post_script_result =
    execute_script (engine, inputs.post_script, post_ctx, "Post-request");

    // The post-request script's jar writes: the transfer has already
    // captured, so there is nothing left to carry them. A write its own
    // `pm.sendRequest` already carried is not in here - that call drains the
    // queue.
    jar.apply (cookie_scope, post_cookie_writes);

    return outcome;
}

} // namespace vayu::http::routes
