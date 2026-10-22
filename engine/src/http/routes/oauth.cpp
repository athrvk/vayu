/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/oauth.cpp
 * @brief OAuth 2.0 token endpoints - acquisition, cache status, cache clear.
 *
 * POST   /oauth2/token          {config, force?, interactive?} → token | error
 * GET    /oauth2/token?key=K    → {found, expired?, token?}
 * DELETE /oauth2/token?key=K    → {deleted}
 *
 * Errors use the nested shape {"error":{"code","message",...}} which the app's
 * http-client parses into ApiError.errorCode.
 */

#include "vayu/http/routes.hpp"

#include "vayu/http/oauth_authorize.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/utils/logger.hpp"

#include <chrono>
#include <utility>

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
    auto& e   = body["error"];
    if (err.provider_status != 0) {
        e["providerStatus"] = err.provider_status;
    }
    if (!err.provider_error.empty ()) {
        e["providerError"] = err.provider_error;
    }
    if (!err.provider_error_description.empty ()) {
        e["providerErrorDescription"] = err.provider_error_description;
    }
    return body;
}

/// The code a malformed body answers with, on every OAuth route that reads one.
constexpr std::string_view OAUTH2_INVALID_CONFIG = "oauth2_invalid_config";

int64_t now_ms_epoch () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

} // namespace

/**
 * Acquire (or return cached) token for the config in `request_body`.
 * Separated from the route for unit testing, like import_fetch.
 */
std::pair<int, nlohmann::json>
oauth2_token_post (vayu::db::Database& db, const std::string& request_body) {
    const auto parsed = parse_request_json (
    request_body, OAUTH2_INVALID_CONFIG, {}, OAUTH2_INVALID_CONFIG);
    if (!parsed) {
        return as_response (parsed.error ());
    }
    const nlohmann::json& req = *parsed;

    const auto config = req.value ("config", nlohmann::json ());
    const bool force  = req.value ("force", false);

    std::optional<oauth::InteractiveExchange> interactive;
    if (auto it = req.find ("interactive"); it != req.end () && it->is_object ()) {
        oauth::InteractiveExchange ex;
        ex.code          = it->value ("code", std::string{});
        ex.code_verifier = it->value ("codeVerifier", std::string{});
        ex.redirect_uri  = it->value ("redirectUri", std::string{});
        interactive      = std::move (ex);
    }

    auto result = oauth::acquire_token (db, config, force, interactive);
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
    // The authorization manager is owned by the Server (ctx.authorize_manager,
    // see server.hpp) so its dtor stops any live loopback listeners while the
    // Database is still alive - no process-lifetime static. Handlers reach it
    // through the captured ctx (a stable heap object), never a local reference.

    ctx.server.Post ("/oauth2/token",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        auto [status, body] = oauth2_token_post (ctx.db, req.body);
        res.status          = status;
        // A parse refusal quotes the bytes it stopped at, and so does a
        // provider's reply, so a strict dump could throw on either.
        res.set_content (body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    });

    ctx.server.Post ("/oauth2/authorize/start",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const auto body = parse_request_json (
        req.body, OAUTH2_INVALID_CONFIG, {}, OAUTH2_INVALID_CONFIG);
        if (!body) {
            refuse_request_body (res, "POST /oauth2/authorize/start", body.error ());
            return;
        }
        const auto config = body->value ("config", nlohmann::json ());
        const auto mode   = body->value ("mode", std::string{ "loopback" });
        auto result       = ctx.authorize_manager.start (ctx.db, config, mode);
        if (!result.ok) {
            res.status = result.http_status;
            res.set_content (
            error_body (res.status, result.error_message, result.error_code).dump (),
            "application/json");
            return;
        }
        res.status = 200;
        res.set_content (nlohmann::json{ { "attemptId", result.attempt_id },
                         { "authorizeUrl", result.authorize_url },
                         { "redirectUri", result.redirect_uri } }
                         .dump (),
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
        const auto st = ctx.authorize_manager.complete (ctx.db,
        body->value ("attemptId", std::string{}),
        body->value ("callbackUrl", std::string{}));
        res.status    = st.state == "not_found" ? 404 : 200;
        res.set_content (authorize_status_json (st).dump (), "application/json");
    });

    ctx.server.Get (R"(/oauth2/authorize/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const auto st = ctx.authorize_manager.status (req.matches[1]);
        res.status    = st.state == "not_found" ? 404 : 200;
        res.set_content (authorize_status_json (st).dump (), "application/json");
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
