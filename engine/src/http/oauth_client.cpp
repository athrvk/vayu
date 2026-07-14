#include "vayu/http/oauth_client.hpp"

#include "vayu/http/client.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/logger.hpp"

#include <chrono>
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
// (legacy GitHub-style). Returns a null json on failure.
nlohmann::json parse_token_body (const std::string& body) {
    try {
        auto parsed = nlohmann::json::parse (body);
        if (parsed.is_object ()) {
            return parsed;
        }
    } catch (const std::exception&) {
        // fall through to form decoding
    }
    if (body.find ('=') == std::string::npos) {
        return nlohmann::json ();
    }
    nlohmann::json out = nlohmann::json::object ();
    size_t pos         = 0;
    while (pos < body.size ()) {
        auto amp        = body.find ('&', pos);
        const auto pair = body.substr (pos, amp == std::string::npos ? std::string::npos : amp - pos);
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
            }
        }
    }
    return 0;
}

struct TokenRequest {
    std::vector<std::pair<std::string, std::string>> form;
    vayu::Headers headers;
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
    req.headers["Authorization"] =
    "Basic " + vayu::utils::base64_encode (vayu::utils::url_encode (client_id) +
    ":" + vayu::utils::url_encode (client_secret));
}

std::variant<vayu::db::OAuthToken, TokenError>
post_token_request (vayu::db::Database& db, const nlohmann::json& config,
const std::string& url, TokenRequest& req, const std::string& key) {
    req.headers["Content-Type"] = "application/x-www-form-urlencoded";
    req.headers["Accept"]       = "application/json";

    vayu::http::Client client;
    auto result = client.post (url, vayu::utils::form_encode (req.form), req.headers);
    if (!result.is_ok ()) {
        return TokenError{ 502, "oauth2_network_error",
            "Token request failed: " + client.last_error () };
    }
    const auto& resp = result.value ();
    if (resp.has_error ()) {
        return TokenError{ 502, "oauth2_network_error",
            "Token request failed: " +
            (resp.error_message.empty () ? "connection error" : resp.error_message) };
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
    token.cache_key     = key;
    token.access_token  = field (body, "access_token");
    token.token_type    = field (body, "token_type");
    if (token.token_type.empty ()) {
        token.token_type = "Bearer";
    }
    token.refresh_token = field (body, "refresh_token");
    token.scope         = field (body, "scope");
    token.expires_in    = parse_expires_in (body);
    token.created_at    = now_ms ();
    token.raw_response  = resp.body.substr (0, 4096);

    db.save_oauth_token (token);
    return token;
}

} // namespace

// NOTE: `scope`/`audience`/`resource` are intentionally omitted (matches
// Postman's keying). Configs differing only in scope share a cached token; set a
// distinct credentialsId to separate them. Must stay byte-identical with the
// app's computeOAuth2CacheKey — see cache-key.ts and the shared test vectors.
std::string cache_key (const nlohmann::json& config) {
    const std::string grant = field (config, "grantType");
    std::string creds_id    = field (config, "credentialsId");
    if (creds_id.empty ()) {
        creds_id = "default";
    }
    return field (config, "accessTokenUrl") + "\x1f" + field (config, "clientId") +
    "\x1f" + creds_id + "\x1f" +
    (grant == "password" ? field (config, "username") : "");
}

bool is_expired (const vayu::db::OAuthToken& t, int64_t now, int64_t skew_ms) {
    if (t.expires_in <= 0) {
        return false; // no expiry information → treat as non-expiring
    }
    return now > t.created_at + t.expires_in * 1000 - skew_ms;
}

std::variant<vayu::db::OAuthToken, TokenError>
acquire_token (vayu::db::Database& db, const nlohmann::json& config,
bool force_refresh, const std::optional<InteractiveExchange>& interactive) {
    if (!config.is_object ()) {
        return TokenError{ 400, "oauth2_invalid_config", "Missing OAuth 2.0 config" };
    }

    const std::string token_url = field (config, "accessTokenUrl");
    if (token_url.rfind ("http://", 0) != 0 && token_url.rfind ("https://", 0) != 0) {
        return TokenError{ 400, "oauth2_invalid_config",
            "accessTokenUrl must be an http(s) URL" };
    }
    if (field (config, "clientId").empty ()) {
        return TokenError{ 400, "oauth2_invalid_config", "clientId is required" };
    }
    const std::string grant = field (config, "grantType");
    if (grant != "client_credentials" && grant != "password" &&
        grant != "authorization_code") {
        return TokenError{ 400, "oauth2_invalid_config",
            "Unsupported grantType: " + (grant.empty () ? "(none)" : grant) };
    }

    const std::string key = cache_key (config);
    const int64_t now     = now_ms ();

    // Cache hit
    if (auto cached = db.get_oauth_token (key)) {
        if (!force_refresh && !is_expired (*cached, now)) {
            return *cached;
        }
        // Refresh path (also used for force_refresh when a refresh token exists)
        if (!cached->refresh_token.empty () &&
            flag (config, "autoRefreshToken", true)) {
            std::string refresh_url = field (config, "refreshTokenUrl");
            if (refresh_url.empty ()) {
                refresh_url = token_url;
            }
            TokenRequest req;
            req.form.emplace_back ("grant_type", "refresh_token");
            req.form.emplace_back ("refresh_token", cached->refresh_token);
            apply_client_auth (req, config);

            vayu::utils::log_info ("OAuth2: refreshing token via " + refresh_url);
            auto refreshed = post_token_request (db, config, refresh_url, req, key);
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

    // Fresh acquisition
    TokenRequest req;
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

    vayu::utils::log_info ("OAuth2: requesting " + grant + " token from " + token_url);
    return post_token_request (db, config, token_url, req, key);
}

nlohmann::json serialize_token (const vayu::db::OAuthToken& t) {
    nlohmann::json out;
    out["cacheKey"]    = t.cache_key;
    out["accessToken"] = t.access_token;
    out["tokenType"]   = t.token_type;
    if (!t.scope.empty ()) {
        out["scope"] = t.scope;
    }
    out["expiresIn"] = t.expires_in;
    out["createdAt"] = t.created_at;
    out["expiresAt"] = t.expires_in > 0 ?
    nlohmann::json (t.created_at + t.expires_in * 1000) :
    nlohmann::json (nullptr);
    out["hasRefreshToken"] = !t.refresh_token.empty ();
    return out;
}

} // namespace vayu::http::oauth
