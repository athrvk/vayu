/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/oauth_client.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/json_depth.hpp"
#include "vayu/core/vayu_extensions.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <set>
#include <utility>
#include <vector>

namespace vayu::http::oauth {

namespace {

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

std::string field (const nlohmann::json& obj, const char* key) {
    if (auto it = obj.find (key); it != obj.end () && it->is_string ()) {
        return it->get<std::string> ();
    }
    return {};
}

bool flag (const nlohmann::json& obj, const char* key, bool fallback) {
    if (auto it = obj.find (key); it != obj.end () && it->is_boolean ()) {
        return it->get<bool> ();
    }
    return fallback;
}

using vayu::utils::url_decode;

// Parse a token response body: JSON preferred, x-www-form-urlencoded fallback
// (legacy GitHub-style). Returns a null json on failure, and for a JSON body
// nested past `MAX_BODY_DEPTH` (#2413). That returns rather than throws so the
// form decode below never runs over text that was JSON.
nlohmann::json parse_token_body (const std::string& body) {
    try {
        auto parsed = nlohmann::json::parse (body);
        if (!vayu::core::json_within_depth (
            parsed, vayu::core::constants::elements::MAX_BODY_DEPTH)) {
            return nlohmann::json ();
        }
        if (parsed.is_object ()) {
            return parsed;
        }
    } catch (const std::exception&) {
        // @deliberate: a body that is not JSON is the legacy form-encoded
        // shape, decoded below - which is the whole reason this function
        // takes two passes rather than one.
    }
    if (body.find ('=') == std::string::npos) {
        return nlohmann::json ();
    }
    nlohmann::json out = nlohmann::json::object ();
    size_t pos         = 0;
    while (pos < body.size ()) {
        auto amp = body.find ('&', pos);
        const auto pair =
        body.substr (pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (auto eq = pair.find ('='); eq != std::string::npos) {
            out[url_decode (pair.substr (0, eq))] = url_decode (pair.substr (eq + 1));
        }
        if (amp == std::string::npos)
            break;
        pos = amp + 1;
    }
    return out;
}

// expires_in arrives as a number or a numeric string depending on provider.
int64_t parse_expires_in (const nlohmann::json& body) {
    if (auto it = body.find ("expires_in"); it != body.end ()) {
        if (it->is_number ()) {
            return it->get<int64_t> ();
        }
        if (it->is_string ()) {
            try {
                return std::stoll (it->get<std::string> ());
            } catch (const std::exception&) {
                // @deliberate: a lifetime we cannot read is reported as the
                // same 0 an absent one is - "this token states no expiry" -
                // and the refresh watchdog already treats that as a token it
                // cannot schedule around.
            }
        }
    }
    return 0;
}

struct TokenRequest {
    std::vector<std::pair<std::string, std::string>> form;
    // `sendAs: "url"` extra parameters, appended to the endpoint's query.
    std::vector<std::pair<std::string, std::string>> query;
    vayu::Headers headers{ { "Content-Type", "application/x-www-form-urlencoded" },
        { "Accept", "application/json" } };
};

// Apply client authentication per credentialsPlacement (RFC 6749 §2.3.1).
// A public client (no secret) always sends client_id in the body.
void apply_client_auth (TokenRequest& req, const nlohmann::json& config) {
    const std::string client_id     = field (config, "clientId");
    const std::string client_secret = field (config, "clientSecret");
    const std::string placement     = field (config, "credentialsPlacement");

    if (client_secret.empty ()) {
        req.form.emplace_back ("client_id", client_id);
        return;
    }
    if (placement == "body") {
        req.form.emplace_back ("client_id", client_id);
        req.form.emplace_back ("client_secret", client_secret);
        return;
    }
    // default: basic_auth_header, with §2.3.1 URL-encoding of the parts
    req.headers["Authorization"] = "Basic " +
    vayu::utils::base64_encode (vayu::utils::url_encode (client_id) + ":" +
    vayu::utils::url_encode (client_secret));
}

/// One bound across every post an acquisition makes (#2833): a refresh the
/// provider rejects falls through to a fresh grant, and the grant gets what
/// the refresh left, never a second full timeout.
class TokenDeadline {
    public:
    explicit TokenDeadline (int timeout_ms)
    : timeout_ms_ (timeout_ms),
      at_ (std::chrono::steady_clock::now () + std::chrono::milliseconds (timeout_ms)) {
    }

    [[nodiscard]] int timeout_ms () const {
        return timeout_ms_;
    }

    /// What is left of the bound, never negative.
    [[nodiscard]] int remaining_ms () const {
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds> (
        at_ - std::chrono::steady_clock::now ())
                          .count ();
        return static_cast<int> (std::max<int64_t> (left, 0));
    }

    private:
    int timeout_ms_;
    std::chrono::steady_clock::time_point at_;
};

TokenError token_timeout (const TokenDeadline& deadline) {
    return TokenError{ 504, "oauth2_timeout",
        "Token request timed out after " +
        std::to_string (deadline.timeout_ms ()) + " ms (request timeout)" };
}

/// A token request that got no answer. Running out of time is reported as the
/// timeout it is; anything else, a cancel from `Server::stop()` included,
/// stays a network error.
TokenError transport_failure (vayu::ErrorCode code,
const std::string& detail,
const TokenDeadline& deadline) {
    if (code == vayu::ErrorCode::Timeout) {
        return token_timeout (deadline);
    }
    return TokenError{ 502, "oauth2_network_error", "Token request failed: " + detail };
}

std::variant<vayu::db::OAuthToken, TokenError> post_token_request (vayu::db::Database& db,
const nlohmann::json& config,
const std::string& url,
TokenRequest& req,
const std::string& key,
const TokenDeadline& deadline,
double* network_ms,
const std::atomic<bool>* cancel) {
    const int remaining_ms = deadline.remaining_ms ();
    if (remaining_ms <= 0) {
        // Never handed to curl, which reads a zero timeout as no bound at all.
        return token_timeout (deadline);
    }
    std::string target = url;
    if (!req.query.empty ()) {
        target.push_back (target.find ('?') == std::string::npos ? '?' : '&');
        target += vayu::utils::form_encode (req.query);
    }

    // The token endpoint is behind the same network as everything else, and it
    // is the one a corporate proxy most often fronts (issue #705) - an
    // execute path that proxied while token acquisition did not would fail
    // every authenticated request with an auth error rather than a proxy one.
    vayu::http::ClientConfig client_config;
    client_config.transport = vayu::http::resolve_transport_policy (db);
    client_config.cancel    = cancel;
    vayu::http::Client client (client_config);
    const auto sent_at = std::chrono::steady_clock::now ();
    auto result        = client.post (
    target, vayu::utils::form_encode (req.form), remaining_ms, req.headers);
    if (network_ms != nullptr) {
        *network_ms += std::chrono::duration<double, std::milli> (
        std::chrono::steady_clock::now () - sent_at)
                       .count ();
    }
    if (!result.is_ok ()) {
        return transport_failure (result.error ().code, client.last_error (), deadline);
    }
    const auto& resp = result.value ();
    if (resp.has_error ()) {
        return transport_failure (resp.error_code,
        resp.error_message.empty () ? "connection error" : resp.error_message, deadline);
    }

    auto body = parse_token_body (resp.body);

    if (resp.status_code >= 400 || !body.is_object () ||
    field (body, "access_token").empty ()) {
        TokenError err;
        err.http_status     = 401;
        err.code            = "oauth2_provider_error";
        err.provider_status = resp.status_code;
        if (body.is_object ()) {
            err.provider_error             = field (body, "error");
            err.provider_error_description = field (body, "error_description");
        }
        err.message = "Token endpoint rejected the request";
        if (!err.provider_error.empty ()) {
            err.message += ": " + err.provider_error;
            if (!err.provider_error_description.empty ()) {
                err.message += " (" + err.provider_error_description + ")";
            }
        } else if (!body.is_object ()) {
            err.message += " (unparseable response, HTTP " +
            std::to_string (resp.status_code) + ")";
        }
        return err;
    }

    vayu::db::OAuthToken token;
    token.cache_key    = key;
    token.access_token = field (body, "access_token");
    token.token_type   = field (body, "token_type");
    if (token.token_type.empty ()) {
        token.token_type = "Bearer";
    }
    token.refresh_token = field (body, "refresh_token");
    token.scope         = field (body, "scope");
    token.expires_in    = parse_expires_in (body);
    token.created_at    = now_ms ();

    db.save_oauth_token (token);
    return token;
}

/// A header row that cannot be one header line is skipped, as is one naming
/// a header already set: `emplace` never replaces, and `vayu::Headers`
/// compares names case-insensitively, so the engine's own header wins.
void add_extra_header (vayu::Headers& headers, ExtraParam& row) {
    if (vayu::http::invalid_header_token (row.key) ||
    row.value.find_first_of (std::string_view ("\r\n\0", 3)) != std::string::npos) {
        return;
    }
    headers.emplace (std::move (row.key), std::move (row.value));
}

/**
 * Appends @p config's @p list (`extra_params`) to @p req where each row's
 * `sendAs` says. A body or url row named like a form parameter the engine
 * already wrote is skipped, so the engine's value wins and the provider never
 * reads two values for one name.
 */
void append_extra_params (TokenRequest& req, const nlohmann::json& config, std::string_view list) {
    std::set<std::string, std::less<>> written;
    for (const auto& [name, value] : req.form) {
        written.insert (name);
    }
    for (ExtraParam& row : extra_params (config, list)) {
        if (row.target == ParamTarget::Header) {
            add_extra_header (req.headers, row);
        } else if (!written.contains (row.key)) {
            auto& params = row.target == ParamTarget::Url ? req.query : req.form;
            params.emplace_back (std::move (row.key), std::move (row.value));
        }
    }
}

std::optional<ParamTarget> param_target (const nlohmann::json& row) {
    const auto declared = row.find ("sendAs");
    if (declared == row.end () || declared->is_null ()) {
        return ParamTarget::Body;
    }
    const std::string named = declared->is_string () ? declared->get<std::string> () : "";
    if (named == "body") {
        return ParamTarget::Body;
    }
    if (named == "url") {
        return ParamTarget::Url;
    }
    if (named == "header") {
        return ParamTarget::Header;
    }
    return std::nullopt;
}

std::optional<ExtraParam> extra_param (const nlohmann::json& row) {
    if (!row.is_object () || !flag (row, "enabled", true)) {
        return std::nullopt;
    }
    std::string key = field (row, "key");
    if (key.empty () || std::ranges::contains (RESERVED_PARAM_NAMES, key)) {
        return std::nullopt;
    }
    const std::optional<ParamTarget> target = param_target (row);
    if (!target) {
        return std::nullopt;
    }
    return ExtraParam{ std::move (key), field (row, "value"), *target };
}

/// The cache key's segment for @p list, or "" when it has no eligible row. A
/// row whose key names a credential is keyed by name alone: the key is a
/// token's address, returned to clients and stored as a primary key, so it
/// must not carry the secret, and a rotated one-shot assertion is still the
/// same token.
std::string extra_params_key_segment (const nlohmann::json& config, std::string_view list) {
    std::vector<std::pair<std::string, std::string>> pairs;
    for (ExtraParam& row : extra_params (config, list)) {
        if (vayu::core::vayu_ext::names_param_credential (row.key)) {
            row.value.clear ();
        }
        pairs.emplace_back (std::move (row.key), std::move (row.value));
    }
    if (pairs.empty ()) {
        return {};
    }
    std::ranges::sort (pairs);
    std::string segment = "\x1f" + std::string (list) + ":";
    for (size_t i = 0; i < pairs.size (); ++i) {
        if (i > 0) {
            segment += "\x1e";
        }
        segment += pairs[i].first + "=" + pairs[i].second;
    }
    return segment;
}

} // namespace

std::vector<ExtraParam> extra_params (const nlohmann::json& config, std::string_view list) {
    std::vector<ExtraParam> rows;
    if (!config.is_object ()) {
        return rows;
    }
    const auto declared = config.find (std::string (list));
    if (declared == config.end () || !declared->is_array ()) {
        return rows;
    }
    for (const nlohmann::json& row : *declared) {
        if (std::optional<ExtraParam> param = extra_param (row)) {
            rows.push_back (std::move (*param));
        }
    }
    return rows;
}

// NOTE: `scope`/`audience`/`resource` are intentionally omitted (matches
// Postman's keying). Configs differing only in scope share a cached token; set a
// distinct credentialsId to separate them. The extra parameter lists are read
// (issue #2536), one segment each, so an audience sent as a row separates two
// tokens the way a credentialsId does. Must stay byte-identical with the app's
// computeOAuth2CacheKey - see cache-key.ts and the shared test vectors; the
// recipe is in oauth_client.hpp.
std::string cache_key (const nlohmann::json& config) {
    const std::string grant = field (config, "grantType");
    std::string creds_id    = field (config, "credentialsId");
    if (creds_id.empty ()) {
        creds_id = "default";
    }
    std::string key = field (config, "accessTokenUrl") + "\x1f" +
    field (config, "clientId") + "\x1f" + creds_id + "\x1f" +
    (grant == "password" ? field (config, "username") : "");
    for (std::string_view list : EXTRA_PARAM_LISTS) {
        key += extra_params_key_segment (config, list);
    }
    return key;
}

bool is_expired (const vayu::db::OAuthToken& t, int64_t now, int64_t skew_ms) {
    if (t.expires_in <= 0) {
        return false; // no expiry information → treat as non-expiring
    }
    return now > t.created_at + (t.expires_in * 1000) - skew_ms;
}

namespace {

/**
 * The cached token, or the refresh this call can make from it.
 *
 * @return the token to answer with, an error that must not be swallowed, or
 *         nothing at all - which means the cache had nothing usable and the
 *         caller should acquire a fresh grant.
 */
std::optional<std::variant<vayu::db::OAuthToken, TokenError>> token_from_cache (
vayu::db::Database& db,
const nlohmann::json& config,
const std::string& key,
const std::string& token_url,
bool force_refresh,
int64_t now,
const TokenDeadline& deadline,
double* network_ms,
const std::atomic<bool>* cancel) {
    // Cache hit
    if (auto cached = db.get_oauth_token (key)) {
        if (!force_refresh && !is_expired (*cached, now)) {
            return *cached;
        }
        // Refresh path (also used for force_refresh when a refresh token exists)
        if (!cached->refresh_token.empty () && flag (config, "autoRefreshToken", true)) {
            std::string refresh_url = field (config, "refreshTokenUrl");
            if (refresh_url.empty ()) {
                refresh_url = token_url;
            }
            TokenRequest req;
            req.form.emplace_back ("grant_type", "refresh_token");
            req.form.emplace_back ("refresh_token", cached->refresh_token);
            apply_client_auth (req, config);
            append_extra_params (req, config, REFRESH_PARAMS);

            vayu::utils::log_info (
            "oauth", "OAuth2: refreshing token", { { "url", refresh_url } });
            auto refreshed = post_token_request (
            db, config, refresh_url, req, key, deadline, network_ms, cancel);
            if (auto* token = std::get_if<vayu::db::OAuthToken> (&refreshed)) {
                // Rotation: keep the previous refresh token when the provider
                // did not issue a new one.
                if (token->refresh_token.empty ()) {
                    token->refresh_token = cached->refresh_token;
                    db.save_oauth_token (*token);
                }
                return *token;
            }
            const auto& err = std::get<TokenError> (refreshed);
            if (err.code == "oauth2_provider_error") {
                // Rejected refresh token → clear and fall through to a fresh grant.
                db.delete_oauth_token (key);
            } else {
                return err; // network errors don't invalidate the cache
            }
        }
    }
    return std::nullopt;
}

/**
 * The form a fresh grant posts.
 *
 * @return the refusal this grant cannot be built without, or nothing.
 */
std::optional<TokenError> build_grant_request (const nlohmann::json& config,
const std::string& grant,
const std::optional<InteractiveExchange>& interactive,
TokenRequest& req) {
    if (grant == "client_credentials") {
        req.form.emplace_back ("grant_type", "client_credentials");
    } else if (grant == "password") {
        req.form.emplace_back ("grant_type", "password");
        req.form.emplace_back ("username", field (config, "username"));
        req.form.emplace_back ("password", field (config, "password"));
    } else { // authorization_code
        if (!interactive.has_value ()) {
            return TokenError{ 409, "oauth2_interactive_required",
                "OAuth 2.0 authorization required" };
        }
        req.form.emplace_back ("grant_type", "authorization_code");
        req.form.emplace_back ("code", interactive->code);
        req.form.emplace_back ("redirect_uri", interactive->redirect_uri);
        if (!interactive->code_verifier.empty ()) {
            req.form.emplace_back ("code_verifier", interactive->code_verifier);
        }
    }
    for (const char* extra : { "scope", "audience", "resource" }) {
        if (const auto value = field (config, extra); !value.empty ()) {
            req.form.emplace_back (extra, value);
        }
    }
    apply_client_auth (req, config);
    append_extra_params (req, config, TOKEN_PARAMS);
    return std::nullopt;
}

} // namespace

std::variant<vayu::db::OAuthToken, TokenError> acquire_token (vayu::db::Database& db,
const nlohmann::json& config,
bool force_refresh,
const std::optional<InteractiveExchange>& interactive,
int timeout_ms,
double* network_ms,
const std::atomic<bool>* cancel) {
    if (!config.is_object ()) {
        return TokenError{ 400, "oauth2_invalid_config", "Missing OAuth 2.0 config" };
    }

    const std::string token_url = field (config, "accessTokenUrl");
    if (token_url.rfind ("http://", 0) != 0 && token_url.rfind ("https://", 0) != 0) {
        return TokenError{ 400, "oauth2_invalid_config", "accessTokenUrl must be an http(s) URL" };
    }
    if (field (config, "clientId").empty ()) {
        return TokenError{ 400, "oauth2_invalid_config", "clientId is required" };
    }
    const std::string grant = field (config, "grantType");
    if (grant != "client_credentials" && grant != "password" && grant != "authorization_code") {
        return TokenError{ 400, "oauth2_invalid_config",
            "Unsupported grantType: " + (grant.empty () ? "(none)" : grant) };
    }

    const std::string key = cache_key (config);
    const int64_t now     = now_ms ();
    const TokenDeadline deadline (timeout_ms);

    // An interactive call carries an authorization code that only the exchange
    // can spend, so no cached token (fresh, expired or refreshable) may answer
    // in its place. The row is replaced by the exchange (#2472); `force_refresh`
    // adds nothing here.
    if (!interactive.has_value ()) {
        if (auto answer = token_from_cache (db, config, key, token_url,
            force_refresh, now, deadline, network_ms, cancel)) {
            return *answer;
        }
    }

    TokenRequest req;
    if (auto refusal = build_grant_request (config, grant, interactive, req)) {
        return *refusal;
    }

    vayu::utils::log_info ("oauth", "OAuth2: requesting token",
    { { "grant", grant }, { "url", token_url } });
    return post_token_request (db, config, token_url, req, key, deadline, network_ms, cancel);
}

nlohmann::json serialize_token (const vayu::db::OAuthToken& t) {
    nlohmann::json out;
    out["cacheKey"]    = t.cache_key;
    out["accessToken"] = t.access_token;
    out["tokenType"]   = t.token_type;
    if (!t.scope.empty ()) {
        out["scope"] = t.scope;
    }
    out["expiresIn"]       = t.expires_in;
    out["createdAt"]       = t.created_at;
    out["expiresAt"]       = t.expires_in > 0 ?
    nlohmann::json (t.created_at + (t.expires_in * 1000)) :
    nlohmann::json (nullptr);
    out["hasRefreshToken"] = !t.refresh_token.empty ();
    return out;
}

} // namespace vayu::http::oauth
