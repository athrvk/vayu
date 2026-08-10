/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/auth_resolver.hpp"

#include "vayu/http/oauth_client.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/logger.hpp"

#include <chrono>
#include <string>
#include <type_traits>

namespace vayu::http {

namespace {

// Fetch a string field, tolerating a missing key or non-string value.
std::string field (const nlohmann::json& obj, const char* key) {
    if (auto it = obj.find (key); it != obj.end () && it->is_string ()) {
        return it->get<std::string> ();
    }
    return {};
}

// Append `key=value` to a URL's query component, preserving any fragment.
void append_query_param (std::string& url, const std::string& key,
const std::string& value) {
    std::string fragment;
    if (const auto hash = url.find ('#'); hash != std::string::npos) {
        fragment = url.substr (hash);
        url.erase (hash);
    }
    url.push_back (url.find ('?') == std::string::npos ? '?' : '&');
    url += vayu::utils::url_encode (key);
    url.push_back ('=');
    url += vayu::utils::url_encode (value);
    url += fragment;
}

// Fetch a boolean field, tolerating a missing key or non-boolean value.
bool flag (const nlohmann::json& obj, const char* key, bool fallback) {
    if (auto it = obj.find (key); it != obj.end () && it->is_boolean ()) {
        return it->get<bool> ();
    }
    return fallback;
}

// Map a token-acquisition failure onto the auth-resolution result shape.
AuthApplyResult from_token_error (const oauth::TokenError& err) {
    AuthApplyResult out;
    out.ok          = false;
    out.code        = err.code == "oauth2_interactive_required" ?
    vayu::ErrorCode::AuthRequired :
    vayu::ErrorCode::AuthFailed;
    out.message     = err.message;
    out.detail_code = err.code;
    return out;
}

// Resolve an oauth2 config to a token (cache-aware) and place it on the
// request per tokenPlacement. Shared by apply_auth and preflight_auth
// (the latter passes a null request and only acquires).
AuthApplyResult resolve_oauth2 (vayu::Request* req, const nlohmann::json& config,
vayu::db::Database* db) {
    if (db == nullptr) {
        return { false, vayu::ErrorCode::AuthFailed,
            "OAuth 2.0 requires database access for the token cache",
            "oauth2_no_database" };
    }

    // autoFetchToken=false → only ever use a valid cached token.
    const bool auto_fetch = [&] {
        auto it = config.find ("autoFetchToken");
        return it == config.end () || !it->is_boolean () || it->get<bool> ();
    }();

    std::variant<vayu::db::OAuthToken, oauth::TokenError> result =
    oauth::TokenError{ 409, "oauth2_interactive_required",
        "OAuth 2.0 token required (auto-fetch is disabled)" };
    if (auto_fetch) {
        result = oauth::acquire_token (*db, config, false, std::nullopt);
    } else if (auto cached = db->get_oauth_token (oauth::cache_key (config))) {
        const auto now = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
        .count ();
        if (!oauth::is_expired (*cached, now)) {
            result = *cached;
        }
    }

    if (auto* err = std::get_if<oauth::TokenError> (&result)) {
        return from_token_error (*err);
    }

    if (req != nullptr) {
        const auto& token = std::get<vayu::db::OAuthToken> (result);
        if (field (config, "tokenPlacement") == "query") {
            std::string param = field (config, "queryParamName");
            if (param.empty ()) {
                param = "access_token";
            }
            append_query_param (req->url, param, token.access_token);
        } else if (req->headers.count ("Authorization") == 0) {
            req->headers["Authorization"] =
            oauth2_header_value (config, token.access_token);
        }
    }
    return {};
}

} // namespace

std::string oauth2_header_value (const nlohmann::json& config,
const std::string& access_token) {
    std::string prefix = "Bearer";
    if (auto it = config.find ("headerPrefix"); it != config.end () && it->is_string ()) {
        prefix = it->get<std::string> ();
    }
    return prefix.empty () ? access_token : prefix + " " + access_token;
}

std::optional<AuthRefreshPlan> plan_auth_refresh (const vayu::Request& request,
const nlohmann::json& auth,
vayu::db::Database* db) {
    if (db == nullptr) {
        return std::nullopt;
    }
    const Auth parsed  = parse_auth (auth);
    const auto* oauth2 = std::get_if<OAuth2Auth> (&parsed);
    if (oauth2 == nullptr || !oauth2->config.is_object ()) {
        return std::nullopt;
    }
    const auto& config = oauth2->config;

    // A query-placed token was written into the URL that every transfer copies;
    // republishing a header would leave the stale one in the query string.
    if (field (config, "tokenPlacement") == "query") {
        return std::nullopt;
    }
    if (!flag (config, "autoRefreshToken", true)) {
        return std::nullopt;
    }

    auto cached = db->get_oauth_token (oauth::cache_key (config));
    if (!cached || cached->expires_in <= 0) {
        return std::nullopt;
    }
    // A refresh token is the only non-interactive way back for this grant; the
    // others can simply re-run their grant.
    if (field (config, "grantType") == "authorization_code" &&
        cached->refresh_token.empty ()) {
        return std::nullopt;
    }

    AuthRefreshPlan plan;
    plan.config        = config;
    plan.header_name   = "Authorization";
    plan.header_value  = oauth2_header_value (config, cached->access_token);
    plan.expires_at_ms = cached->created_at + cached->expires_in * 1000;

    // A user-supplied Authorization header wins over the token (see
    // resolve_oauth2), and this run is sending that one - swapping the token
    // under it would change nothing on the wire.
    const auto it = request.headers.find (plan.header_name);
    if (it == request.headers.end () || it->second != plan.header_value) {
        return std::nullopt;
    }
    return plan;
}

Auth parse_auth (const nlohmann::json& auth) {
    if (!auth.is_object ()) {
        return NoAuth{};
    }

    const std::string mode = field (auth, "mode");
    if (mode.empty () || mode == "none") {
        return NoAuth{};
    }
    if (mode == "inherit") {
        // Expected to be resolved before reaching an execution endpoint -
        // POST /compose owns the inherit walk (request_composer.cpp). A
        // warning, not a debug line: an unresolved 'inherit' leaking through
        // means a client-side regression, and the request is about to execute
        // unauthenticated - that must show up in default-level logs (#226).
        vayu::utils::log_warning (
        "parse_auth: received unresolved 'inherit' auth; treating as none "
        "(compose the request via POST /compose first)");
        return NoAuth{};
    }
    if (mode == "bearer") {
        return BearerAuth{ field (auth, "token") };
    }
    if (mode == "basic") {
        return BasicAuth{ field (auth, "username"), field (auth, "password") };
    }
    if (mode == "apikey") {
        return ApiKeyAuth{ field (auth, "key"), field (auth, "value"),
            field (auth, "in") == "query" };
    }
    if (mode == "oauth2") {
        return OAuth2Auth{ auth.value ("config", nlohmann::json::object ()) };
    }
    return UnsupportedAuth{ mode };
}

AuthApplyResult
apply_auth (vayu::Request& req, const Auth& auth, vayu::db::Database* db) {
    return std::visit (
    [&] (const auto& a) -> AuthApplyResult {
        using T = std::decay_t<decltype (a)>;

        if constexpr (std::is_same_v<T, NoAuth>) {
            return {};
        } else if constexpr (std::is_same_v<T, BearerAuth>) {
            // Headers is case-insensitive, so this covers "authorization" too.
            if (req.headers.count ("Authorization") == 0) {
                req.headers["Authorization"] = "Bearer " + a.token;
            }
            return {};
        } else if constexpr (std::is_same_v<T, BasicAuth>) {
            if (req.headers.count ("Authorization") == 0) {
                req.headers["Authorization"] =
                "Basic " + vayu::utils::base64_encode (a.username + ":" + a.password);
            }
            return {};
        } else if constexpr (std::is_same_v<T, ApiKeyAuth>) {
            if (a.key.empty ()) {
                return {};
            }
            if (a.in_query) {
                append_query_param (req.url, a.key, a.value);
            } else if (req.headers.count (a.key) == 0) {
                req.headers[a.key] = a.value;
            }
            return {};
        } else if constexpr (std::is_same_v<T, OAuth2Auth>) {
            return resolve_oauth2 (&req, a.config, db);
        } else {
            static_assert (std::is_same_v<T, UnsupportedAuth>,
            "unhandled Auth variant");
            vayu::utils::log_debug ("apply_auth: mode '" + a.mode +
            "' is not executable; sending request without auth");
            return {};
        }
    },
    auth);
}

AuthApplyResult apply_auth (vayu::Request& req, const nlohmann::json& auth,
vayu::db::Database* db) {
    return apply_auth (req, parse_auth (auth), db);
}

AuthApplyResult preflight_auth (const nlohmann::json& auth, vayu::db::Database& db) {
    const Auth parsed = parse_auth (auth);
    if (const auto* oauth2 = std::get_if<OAuth2Auth> (&parsed)) {
        // Acquire (cache-aware) without touching any request - warms the token
        // cache so the run worker's apply_auth is a cache hit.
        return resolve_oauth2 (nullptr, oauth2->config, &db);
    }
    return {};
}

} // namespace vayu::http
