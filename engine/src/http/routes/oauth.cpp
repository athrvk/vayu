/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * OAuth 2.0 token and authorization endpoints:
 *
 * POST   /oauth2/token          {config, force?, interactive?, environmentId?,
 *                                collectionId?} → token | error
 * POST   /oauth2/authorize/start {config, mode?} → attempt | error
 * POST   /oauth2/authorize/complete {attemptId, callbackUrl?} → status
 * GET    /oauth2/authorize/:id  → status
 * DELETE /oauth2/authorize/:id  → {cancelled}
 * POST   /oauth2/step-up        {wwwAuthenticate, scope?} → classification | error
 * GET    /oauth2/token?key=K    → {found, expired?, token?}
 * DELETE /oauth2/token?key=K    → {deleted}
 *
 * Errors use the nested shape {"error":{"code","message",...}} which the app's
 * http-client parses into ApiError.errorCode.
 */

#include "vayu/http/routes.hpp"

#include "vayu/core/vayu_extensions.hpp"
#include "vayu/http/oauth_authorize.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/oauth_discovery.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <expected>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace vayu::http::routes {

namespace {

/**
 * A token failure in the shared error shape, with the provider's own reply
 * carried as extra keys *inside* the error object - the same place
 * `/import/apply` puts its `item`, so a client reads one object for the whole
 * failure regardless of which route produced it.
 */
nlohmann::json token_error_body (const oauth::TokenError& err) {
    auto body = routes::error_body (err.http_status, err.message, err.code);
    add_provider_reply (body, err.provider_status, err.provider_error,
    err.provider_error_description);
    return body;
}

/// The code a malformed body answers with, on every OAuth route that reads one.
constexpr std::string_view OAUTH2_INVALID_CONFIG = "oauth2_invalid_config";

int64_t now_ms_epoch () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/**
 * @p config's `privateKey` reference resolved against the scopes @p req names,
 * `environmentId` and `collectionId`, the ones a Send of the request reads
 * (#3632). The resolved config lives only for this acquisition.
 *
 * A body naming neither is refused for a reference: this route has no saved
 * request to read scopes from, and asking the provider with the reference as
 * the key is never what was meant.
 *
 * @return the 400, or nothing.
 */
std::optional<std::pair<int, nlohmann::json>> resolve_token_signing_key (
vayu::db::Database& db,
const nlohmann::json& req,
nlohmann::json& config) {
    const auto refuse = [] (const std::string& message) {
        return std::pair{ 400, error_body (400, message, OAUTH2_INVALID_CONFIG) };
    };
    const auto environment_id = read_optional_string_field (req, "environmentId");
    if (!environment_id) {
        return refuse (environment_id.error ());
    }
    const auto collection_id = read_optional_string_field (req, "collectionId");
    if (!collection_id) {
        return refuse (collection_id.error ());
    }
    const auto key = config.find (OAUTH2_PRIVATE_KEY);
    if (key == config.end () || !key->is_string () ||
    !vayu::core::vayu_ext::is_variable_reference (key->get_ref<const std::string&> ())) {
        return std::nullopt;
    }
    if (!environment_id->has_value () && !collection_id->has_value ()) {
        return refuse ("privateKey names " + key->get<std::string> () +
        ", and this call names no environmentId or collectionId to resolve it "
        "from - send the saved request, or name a key file in privateKeyFile");
    }
    if (auto refusal = resolve_private_key_reference (config,
        flatten_variable_scopes (load_script_variable_scopes (
        db, *environment_id, collection_id->value_or (std::string ()))))) {
        return refuse (*refusal);
    }
    return std::nullopt;
}

} // namespace

/**
 * Acquire (or return cached) token for the config in `request_body`.
 * Separated from the route for unit testing, like import_fetch. @p cancel is
 * the route's `RouteContext::server_stopping` (issue #2683).
 */
std::pair<int, nlohmann::json> oauth2_token_post (vayu::db::Database& db,
const std::string& request_body,
const std::atomic<bool>* cancel) {
    const auto parsed = parse_request_json (
    request_body, OAUTH2_INVALID_CONFIG, {}, OAUTH2_INVALID_CONFIG);
    if (!parsed) {
        return as_response (parsed.error ());
    }
    const nlohmann::json& req = *parsed;

    auto config      = req.value ("config", nlohmann::json ());
    const bool force = req.value ("force", false);
    if (auto refusal = resolve_token_signing_key (db, req, config)) {
        return *refusal;
    }

    std::optional<oauth::InteractiveExchange> interactive;
    if (auto it = req.find ("interactive"); it != req.end () && it->is_object ()) {
        oauth::InteractiveExchange ex;
        ex.code          = it->value ("code", std::string{});
        ex.code_verifier = it->value ("codeVerifier", std::string{});
        ex.redirect_uri  = it->value ("redirectUri", std::string{});
        interactive      = std::move (ex);
    }

    // The `defaultTimeout` setting bounds the token request (#2833); this
    // route takes no `timeout` of its own.
    auto result = oauth::acquire_token (db, config, force, interactive,
    resolve_request_timeout_ms (nlohmann::json::object (), db), nullptr, cancel);
    if (auto* err = std::get_if<oauth::TokenError> (&result)) {
        return { err->http_status, token_error_body (*err) };
    }
    return { 200, oauth::serialize_token (std::get<vayu::db::OAuthToken> (result)) };
}

/**
 * Cache status for a key. Always 200; presence/expiry are in the body.
 */
std::pair<int, nlohmann::json>
oauth2_token_get (vayu::db::Database& db, const std::string& key) {
    auto cached = db.get_oauth_token (key);
    if (!cached.has_value ()) {
        return { 200, nlohmann::json{ { "found", false } } };
    }
    nlohmann::json out;
    out["found"]   = true;
    out["expired"] = oauth::is_expired (*cached, now_ms_epoch ());
    out["token"]   = oauth::serialize_token (*cached);
    return { 200, out };
}

/**
 * Remove a cached token. Idempotent; reports whether a row existed.
 */
std::pair<int, nlohmann::json>
oauth2_token_delete (vayu::db::Database& db, const std::string& key) {
    const bool existed = db.get_oauth_token (key).has_value ();
    db.delete_oauth_token (key);
    return { 200, nlohmann::json{ { "deleted", existed } } };
}

/**
 * Start an interactive authorization attempt for the `{config, mode?}` in
 * @p request_body. Separated from the route for unit testing; @p cancel is the
 * route's `RouteContext::server_stopping`, which ends a discovery or a client
 * registration the start makes.
 */
std::pair<int, nlohmann::json> oauth2_authorize_start (OAuth2AuthorizeManager& manager,
vayu::db::Database& db,
const std::string& request_body,
const std::atomic<bool>* cancel) {
    const auto parsed = parse_request_json (
    request_body, OAUTH2_INVALID_CONFIG, {}, OAUTH2_INVALID_CONFIG);
    if (!parsed) {
        return as_response (parsed.error ());
    }
    const auto config = parsed->value ("config", nlohmann::json ());
    const auto mode   = parsed->value ("mode", std::string{ "loopback" });
    const auto result = manager.start (db, config, mode, cancel);
    if (!result.ok) {
        return { result.http_status,
            error_body (result.http_status, result.error_message, result.error_code) };
    }
    nlohmann::json out{ { "attemptId", result.attempt_id },
        { "authorizeUrl", result.authorize_url },
        { "redirectUri", result.redirect_uri }, { "expiresAt", result.expires_at } };
    if (const auto& resolved = result.resolved) {
        out["resolved"] = { { "authorizationUrl", resolved->authorization_url },
            { "accessTokenUrl", resolved->access_token_url },
            { "clientId", resolved->client_id }, { "resource", resolved->resource },
            { "scope", resolved->scope }, { "issuer", resolved->issuer } };
    }
    return { 200, out };
}

namespace {

/**
 * The `wwwAuthenticate` field of a step-up body: one header value or a list of
 * them, each a string.
 *
 * @return why it is neither, or the values.
 */
std::expected<std::vector<std::string>, std::string>
read_www_authenticate_values (const nlohmann::json& body) {
    const auto field = body.find ("wwwAuthenticate");
    if (field == body.end ()) {
        return std::unexpected (std::string ("'wwwAuthenticate' is required"));
    }
    if (field->is_string ()) {
        return std::vector<std::string>{ field->get<std::string> () };
    }
    if (!field->is_array () || !std::ranges::all_of (*field, &nlohmann::json::is_string)) {
        return std::unexpected (std::string (
        "'wwwAuthenticate' must be a string or an array of strings"));
    }
    return field->get<std::vector<std::string>> ();
}

} // namespace

/**
 * Classify the `WWW-Authenticate` values of a 401 or 403 in @p request_body
 * (`{wwwAuthenticate, scope?}`). Separated from the route for unit testing.
 * Reads only: it sends nothing, retries nothing and re-authorizes nothing.
 */
std::pair<int, nlohmann::json> oauth2_step_up_post (const std::string& request_body) {
    const auto parsed = parse_request_json (
    request_body, OAUTH2_INVALID_CONFIG, {}, OAUTH2_INVALID_CONFIG);
    if (!parsed) {
        return as_response (parsed.error ());
    }
    const auto refuse = [] (const std::string& message) {
        return std::pair{ 400, error_body (400, message, OAUTH2_INVALID_CONFIG) };
    };
    if (!parsed->is_object ()) {
        return refuse ("the body must be a JSON object");
    }
    const auto values = read_www_authenticate_values (*parsed);
    if (!values) {
        return refuse (values.error ());
    }
    const auto scope = read_optional_string_field (*parsed, "scope");
    if (!scope) {
        return refuse (scope.error ());
    }
    const auto step_up =
    classify_bearer_challenge (*values, scope->value_or (std::string ()));
    return { 200,
        nlohmann::json{ { "stepUp", step_up.step_up },
        { "error", step_up.error }, { "requiredScopes", step_up.required_scopes },
        { "scope", step_up.scope }, { "description", step_up.description } } };
}

namespace {

nlohmann::json authorize_status_json (const AuthorizeStatus& st) {
    nlohmann::json out;
    out["state"] = st.state;
    if (!st.error.empty ()) {
        out["error"] = st.error;
    }
    if (!st.cache_key.empty ()) {
        out["cacheKey"] = st.cache_key;
    }
    return out;
}

} // namespace

void register_oauth_routes (RouteContext& ctx) {
    // The authorization manager is the Server's (`ctx.authorize_manager`,
    // server.hpp), not a process-lifetime static, so its destructor stops live
    // loopback listeners while the Database lives. Handlers reach it through
    // the captured, heap-stable ctx, never a local reference.

    ctx.server.Post ("/oauth2/token",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        auto [status, body] = oauth2_token_post (ctx.db, req.body, &ctx.server_stopping);
        res.status = status;
        // A parse refusal quotes the bytes it stopped at, and so does a
        // provider's reply, so a strict dump could throw on either.
        res.set_content (body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    });

    ctx.server.Post ("/oauth2/authorize/start",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        auto [status, body] = oauth2_authorize_start (
        ctx.authorize_manager, ctx.db, req.body, &ctx.server_stopping);
        res.status = status;
        // A refusal can quote what a discovered server sent, and a parse
        // refusal the bytes it stopped at, so a strict dump could throw.
        res.set_content (body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    });

    ctx.server.Post (
    "/oauth2/step-up", [] (const httplib::Request& req, httplib::Response& res) {
        auto [status, body] = oauth2_step_up_post (req.body);
        res.status          = status;
        // The description is text a server wrote, and a parse refusal quotes
        // the bytes it stopped at, so a strict dump could throw.
        res.set_content (body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    });

    ctx.server.Post ("/oauth2/authorize/complete",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const auto body = parse_request_json (
        req.body, OAUTH2_INVALID_CONFIG, {}, OAUTH2_INVALID_CONFIG);
        if (!body) {
            refuse_request_body (res, "POST /oauth2/authorize/complete", body.error ());
            return;
        }
        // The attempt's own cancel ends the exchange: a DELETE of the attempt,
        // or `Server::stop`, which shuts the manager down before joining this
        // handler.
        const auto st = ctx.authorize_manager.complete (ctx.db,
        body->value ("attemptId", std::string{}),
        body->value ("callbackUrl", std::string{}));
        res.status    = st.state == "not_found" ? 404 : 200;
        res.set_content (authorize_status_json (st).dump (-1, ' ', false,
                         nlohmann::json::error_handler_t::replace),
        "application/json");
    });

    // Reads only, like every GET: the manager's reaper is what expires an
    // attempt and frees its port (#3347).
    ctx.server.Get (R"(/oauth2/authorize/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const auto st = ctx.authorize_manager.status (req.matches[1]);
        res.status    = st.state == "not_found" ? 404 : 200;
        res.set_content (authorize_status_json (st).dump (-1, ' ', false,
                         nlohmann::json::error_handler_t::replace),
        "application/json");
    });

    ctx.server.Delete (R"(/oauth2/authorize/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        ctx.authorize_manager.cancel (req.matches[1]);
        res.status = 200;
        res.set_content (R"({"cancelled":true})", "application/json");
    });

    ctx.server.Get ("/oauth2/token",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        auto [status, body] = oauth2_token_get (ctx.db, req.get_param_value ("key"));
        res.status = status;
        res.set_content (body.dump (), "application/json");
    });

    ctx.server.Delete ("/oauth2/token",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        auto [status, body] = oauth2_token_delete (ctx.db, req.get_param_value ("key"));
        res.status = status;
        res.set_content (body.dump (), "application/json");
    });
}

} // namespace vayu::http::routes
