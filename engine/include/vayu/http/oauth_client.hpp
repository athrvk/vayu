#pragma once

#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <variant>

namespace vayu::http::oauth {

/**
 * @brief Structured token-acquisition failure.
 *
 * `http_status` / `code` map 1:1 onto the /oauth2/token route's response;
 * provider_* fields carry the RFC 6749 error body when one was returned.
 */
struct TokenError {
    int http_status = 500; // 400 | 401 | 409 | 502
    std::string code;      // "oauth2_invalid_config" | "oauth2_interactive_required"
                           // | "oauth2_provider_error" | "oauth2_network_error"
    std::string message;
    int provider_status = 0;
    std::string provider_error;             // RFC 6749 "error"
    std::string provider_error_description; // RFC 6749 "error_description"
};

/**
 * @brief Authorization-code exchange material (from the interactive flow).
 */
struct InteractiveExchange {
    std::string code;
    std::string code_verifier; // empty when PKCE disabled
    std::string redirect_uri;
};

/**
 * @brief Deterministic cache key for a token config.
 *
 * Hash-free ("\x1f"-joined) so the app can compute the identical key in
 * TypeScript (computeOAuth2CacheKey) for the GET/DELETE status endpoints:
 *   accessTokenUrl \x1f clientId \x1f (credentialsId|"default")
 *   \x1f (grantType == "password" ? username : "")
 */
std::string cache_key (const nlohmann::json& config);

/**
 * @brief Expiry check with skew: expired iff expires_in > 0 and
 *        now_ms > created_at + expires_in*1000 - skew_ms.
 */
bool is_expired (const vayu::db::OAuthToken& t, int64_t now_ms, int64_t skew_ms = 45'000);

/**
 * @brief Acquire a token for a resolved OAuth2Config (camelCase keys).
 *
 * Cache-aware: returns a valid cached token unless `force_refresh`; refreshes
 * an expired token when a refresh_token is available (rotating it if the
 * provider issues a new one, deleting the row on refresh rejection); otherwise
 * performs a fresh grant. `authorization_code` requires `interactive` and
 * fails with 409 oauth2_interactive_required without it.
 */
std::variant<vayu::db::OAuthToken, TokenError>
acquire_token (vayu::db::Database& db, const nlohmann::json& config,
bool force_refresh, const std::optional<InteractiveExchange>& interactive);

/**
 * @brief Public JSON shape of a cached token (never includes the refresh token
 *        value — only hasRefreshToken).
 */
nlohmann::json serialize_token (const vayu::db::OAuthToken& t);

} // namespace vayu::http::oauth
