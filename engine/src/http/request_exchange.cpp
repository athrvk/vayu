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

#include <algorithm>
#include <chrono>
#include <utility>

#include "vayu/http/client.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/header_names.hpp"
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

    // The *sent* record, beside the composed map (issue #664). `headers` above
    // is what the request was composed with; `response.request_headers` is what
    // `build_request_header_list` appended - that set minus the suppressed
    // (a `form-data` Content-Type libcurl writes itself) and the value-less
    // (issue #662), plus the two the engine derives at send time, the
    // body-implied `Content-Type` and the default `User-Agent`. The response
    // pane's "request headers sent" disclosure means the second, and rebuilding
    // it from the first named headers the wire never carried and hid the two it
    // did - so the same exchange read differently live and after a reload.
    //
    // Both maps are stored because both are read: `design-run-seed.ts` reseeds
    // a request tab from the composed one, and reseeding from the sent record
    // would write the engine's derived headers back into the user's request as
    // if a person had typed them.
    //
    // Omitted rather than stored empty when nothing was recorded, on the same
    // reasoning as `rawRequest` below: the reader prefers this key when it is
    // there, so an empty object would suppress the composed-map fallback that
    // is the right answer for a step that sent nothing and for every row
    // written before this field. The load path records no sent headers at all -
    // `build_request_header_list` takes nullptr there, to keep an allocation
    // off the hot path - so a sampled capture keeps replaying from the composed
    // map, unchanged by this.
    if (!response.request_headers.empty ()) {
        trace["request"]["sentHeaders"] = response.request_headers;
    }

    // What the wire carried, so a restored raw-request view says the same thing
    // the live one did (issue #348). `headers` above is the *composed* map and
    // has no `Cookie` line - libcurl attaches those itself from the jar - so
    // rebuilding the view from it client-side showed a session-less request
    // after a reload and the real one immediately after a send.
    //
    // Omitted rather than stored empty when there was no transfer at all (a
    // `pm.execution.skipRequest()` step hands this a default `Response`): the
    // reader's fallback synthesis is the right answer there, and "" would
    // suppress it. A transfer that failed before sending still has a value -
    // `Client::send` synthesizes one from the composed request - and storing
    // that is what keeps an unreachable host showing the request it attempted.
    //
    // This is credential-grade material and deliberately not redacted, matching
    // the live field's documented contract: the `Cookie` line lands in the same
    // node that already stores the resolved `Authorization` header beside it.
    // The redaction that does apply to run rows is `sanitize_config_snapshot`,
    // which guards `runs.config_snapshot` - a record of the request as
    // *authored*. A trace is the record of what was *sent*, and one that hid
    // what was sent would have no reason to exist. See
    // docs/engine/architecture.md (Security).
    if (!response.raw_request.empty ()) {
        trace["request"]["rawRequest"] = response.raw_request;
    }

    if (!response.has_error ()) {
        // "" when nothing was negotiated, not omitted - same convention as
        // serialize(Response) in json.cpp, so restore-response.ts can't
        // confuse "empty" with "this key doesn't exist on a stored trace".
        trace["response"] = { { "headers", response.headers },
            { "body", response.body }, { "httpVersion", response.http_version },
            { "httpVersionDowngraded", response.http_version_downgraded } };

        // The read cap, carried so a restored response says what the live one
        // said (issue #1157) - the same rule `clientCertificate` above states,
        // and the one the app's two funnels are held to. Written only when it
        // is true, unlike the live body's always-present key: every row stored
        // before this field would otherwise be indistinguishable from one whose
        // body was cut, and absent is what those rows mean - not capped.
        //
        // `bodyTruncated` on this same node is a different cut, added later by
        // `cap_trace_bodies`: that one is this body being shortened for
        // storage, which re-sending recovers from.
        if (response.body_truncated) {
            trace["response"]["bodyCapped"] = true;
        }
    } else {
        trace["error_type"]    = to_string (response.error_code);
        trace["error_message"] = response.error_message;
    }

    // The client-certificate entry this exchange presented (issue #707). Top
    // level rather than inside `response`, because it is a property of the
    // *transfer*: the exchange that most needs to say which certificate it used
    // is the one that failed the handshake, and that one has no response node
    // at all.
    //
    // Omitted when empty, unlike the live body's always-present key: every row
    // stored before this feature would otherwise have to be told apart from one
    // that matched nothing, and both mean the same thing here - no certificate.
    if (!response.client_certificate.empty ()) {
        trace["clientCertificate"] = response.client_certificate;
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

void bind_variable_scopes (vayu::runtime::ScriptContext& ctx, ScriptVariableScopes& scopes) {
    ctx.environment         = &scopes.environment;
    ctx.globals             = &scopes.globals;
    ctx.collectionVariables = &scopes.collection;
    ctx.collectionAncestors = &scopes.collection_ancestors;
}

void bind_script_scopes (vayu::runtime::ScriptContext& ctx,
ScriptVariableScopes& scopes,
vayu::http::CookieJar& jar,
const std::string& cookie_scope,
std::vector<vayu::http::CookieWrite>* writes) {
    bind_variable_scopes (ctx, scopes);
    ctx.cookie_jar    = &jar;
    ctx.cookie_scope  = cookie_scope;
    ctx.cookie_writes = writes;
}

namespace {

/// A field can only carry a token if it spells the opening brace, and a field
/// that does not is the whole of the common case - composition resolved it.
bool holds_a_token (const std::string& text) {
    return text.find ("{{") != std::string::npos;
}

/**
 * Every string of @p request whose `{{tokens}}` composition resolves, except
 * the header *names*: a resolved name is a different key, so the map is rebuilt
 * for those rather than edited through this list.
 */
std::vector<std::string*> resolvable_strings (vayu::Request& request) {
    std::vector<std::string*> targets;
    targets.push_back (&request.url);
    for (auto& [name, value] : request.headers) {
        (void)name;
        targets.push_back (&value);
    }
    targets.push_back (&request.body.content);
    for (auto& field : request.body.fields) {
        // The same five strings composition resolves, a file part's path
        // included: a fixture directory is exactly the kind of thing an
        // environment variable holds, and a literal `{{...}}` reaching the
        // transfer would be opened as a filename.
        for (std::string* part : { &field.key, &field.value, &field.src,
             &field.file_name, &field.content_type }) {
            targets.push_back (part);
        }
    }
    return targets;
}

/**
 * Whether the name map has to be read at all: a name still holding a token,
 * which the walk below resolves, or a name that is already nothing, which it
 * refuses.
 *
 * The second half is what widens this pass past the tokens (issue #1095). The
 * gate exists so an ordinary request pays one search per field and no more, and
 * asking whether a name is empty beside that search costs a compare on a map
 * the search already walks - which buys the one thing a token search cannot
 * see: a header a *script* has just left nameless, and a payload posted
 * straight to `POST /execute` carrying an empty key. Neither is a name this
 * pass resolved, and both are a `": value"` line going out under no name.
 *
 * The collision rule does not widen with it, and that is not the two rules
 * drifting: a request that arrives already resolved cannot carry a collision to
 * find, because `Headers` holds one value per name and compares without case,
 * so two names that are already equal are already one. There is nothing there
 * to see, where an empty name is in plain sight.
 */
bool a_header_name_needs_reading (const vayu::Headers& headers) {
    return std::any_of (headers.begin (), headers.end (), [] (const auto& entry) {
        return entry.first.empty () || holds_a_token (entry.first);
    });
}

/// Both halves of a refusal from one wording: the pre-send gate's shape for the
/// buffered send, and the rule's own `POST /compose` code for the streaming one.
ResidualRefusal refusal_of (std::string reason, std::string_view code) {
    return ResidualRefusal{ vayu::Error{ vayu::ErrorCode::InternalError, std::move (reason) },
        std::string (code) };
}

/**
 * Rebuilt rather than edited in place, because a resolved name is a different
 * key. Values are copied rather than moved, so a refusal leaves the request as
 * it found it.
 *
 * A name a script has just defined can resolve onto a name the request already
 * carries, and a map holds one value per name - so the rebuild is where a
 * header goes missing. Composition refuses that (`http/header_names.hpp`) and
 * so does this, on the same rule and in the same words; the caller is what
 * differs, having a send to stop rather than a payload to reject.
 *
 * Every collision here is one resolution made: the map this walks compares
 * names without case already, so two names that survive untouched cannot have
 * been equal to begin with.
 *
 * A name that resolves to *nothing* is refused here too (#1084), in that rule's
 * one wording: it is the same shape of quiet wrong request with the erased
 * header replaced by a `": value"` line no name owns, and this pass is the
 * layer composition cannot stand in for - the name a script has just defined is
 * one composition never saw. Since #1095 that rule reaches a name which arrives
 * *already* empty as well, holding no token for the gate to find - see
 * `a_header_name_needs_reading` for why this rule widened there and the
 * collision rule did not.
 *
 * @return the first refusal, the headers left as they were; nothing, and the
 *         map rebuilt, when every name is still its own.
 */
std::optional<ResidualRefusal> resolve_header_names (vayu::Headers& headers,
const vayu::http::VariableValues& vars) {
    if (!a_header_name_needs_reading (headers)) {
        return std::nullopt;
    }
    vayu::Headers resolved;
    // Kept beside `resolved` so a refusal can name both spellings.
    vayu::http::HeaderNameOrigins produced;
    for (const auto& [name, value] : headers) {
        std::string resolved_name = vayu::http::resolve_template (name, vars);
        // Both refusals are reported with the map untouched: the caller refuses
        // the send, so a half-rebuilt request is one nothing goes on to read.
        if (resolved_name.empty ()) {
            return refusal_of (vayu::http::describe_empty_header_name (name),
            vayu::http::EMPTY_HEADER_NAME_CODE);
        }
        if (const auto [taken, was_free] = produced.emplace (resolved_name, name); !was_free) {
            return refusal_of (
            vayu::http::describe_header_name_collision (
            vayu::http::HeaderNameCollision{ name, taken->second, taken->first }),
            vayu::http::COLLIDING_HEADER_NAMES_CODE);
        }
        resolved[std::move (resolved_name)] = value;
    }
    headers = std::move (resolved);
    return std::nullopt;
}

/// The scopes as one map, with composition's precedence - environment over the
/// collection chain over globals - so a name resolves in the request exactly as
/// `pm.variables.get` answers it in the script that just ran.
vayu::http::VariableValues values_from_scopes (const ScriptVariableScopes& scopes) {
    std::vector<vayu::Environment> chain = scopes.collection_ancestors; // root first
    chain.push_back (scopes.collection); // leaf last
    return vayu::http::build_variable_values (scopes.globals, chain, scopes.environment);
}

} // namespace

std::optional<ResidualRefusal> resolve_residual_tokens (vayu::Request& request,
const ScriptVariableScopes& scopes) {
    auto targets             = resolvable_strings (request);
    const bool anything_left = a_header_name_needs_reading (request.headers) ||
    std::any_of (targets.begin (), targets.end (),
    [] (const std::string* text) { return holds_a_token (*text); });
    if (!anything_left) {
        return std::nullopt; // composition answered everything - the ordinary case
    }

    const auto vars = values_from_scopes (scopes);
    for (std::string* text : targets) {
        if (holds_a_token (*text)) {
            *text = vayu::http::resolve_template (*text, vars);
        }
    }
    // Last: it rebuilds the map the values `targets` points at live in. The
    // refusal already carries the pre-send gate's shape, because this is a
    // refusal of the same send and the drivers already render that one: an
    // `InternalError` a buffered caller turns into a status-0 response rather
    // than a transfer (see `validate_transferable` in
    // `event_loop/curl_utils.cpp`), beside the code a streaming caller answers
    // its still-open route with.
    if (auto refusal = resolve_header_names (request.headers, vars)) {
        return refusal;
    }
    return std::nullopt;
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
        bind_script_scopes (ctx, scopes, jar, cookie_scope, writes);
        ctx.request_id      = inputs.request_id;
        ctx.request_name    = inputs.request_name;
        ctx.iteration       = inputs.iteration;
        ctx.vu              = inputs.vu;
        ctx.iteration_count = inputs.iteration_count;
        ctx.in_scenario     = inputs.in_scenario;
        // Both scripts' `pm.sendRequest` leaves by the same route the send
        // below does - see ScriptContext::transport.
        ctx.transport = inputs.transport;
        // Both scripts of a step read the same row: they are the same
        // iteration, and a test script asserting against the row its request
        // was built from is the point of a data-driven run.
        ctx.iteration_data = inputs.iteration_data;
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

    // The tokens composition could not answer, answered now against what the
    // script just wrote (issue #1008). After the skip check, so a step that
    // sends nothing resolves nothing; before the send, because the point is the
    // wire. A step of a scenario run reaches this with the *previous* steps'
    // writes in `scopes` too, which is the same rule one step further on.
    if (auto refusal = resolve_residual_tokens (outcome.request, scopes)) {
        // Answered exactly as the pre-send gate answers its own refusals, which
        // is what the transfer below would have done with this request had the
        // collision been something the gate could see: a status-0 response
        // carrying the reason, with the staged jar writes dropped along with
        // the send that was to carry them. The test script still runs, and
        // reads a response reporting an error rather than a status - the
        // false-pass rule issue #180 exists for.
        outcome.response = vayu::http::detail::error_response (refusal->error);
        outcome.response.request_headers = outcome.request.headers;
    } else {
        vayu::http::ClientConfig config;
        config.verbose       = verbose;
        config.cookie_jar    = &jar;
        config.cookie_scope  = cookie_scope;
        config.cookie_writes = std::move (pre_cookie_writes);
        config.transport     = inputs.transport;
        // Design mode's own bound, and the reading of it that keeps the prefix
        // (issue #1157). A body past it stops being read here rather than
        // being buffered whole and then found to be too large downstream - the
        // renderer holds this string too, so the cost of an unbounded one is
        // paid twice.
        config.max_response_bytes  = inputs.max_response_bytes;
        config.truncate_over_limit = true;
        vayu::http::Client client (config);
        outcome.response = client.send (outcome.request).value ();
    }

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
