#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

#include <array>
#include <atomic>
#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace vayu::http::oauth {

/**
 * The parameter names the token and authorization requests write themselves,
 * from the config's own fields or the flow's state. An extra parameter row
 * (`tokenParams`, `authorizationParams`, `refreshParams`, issue #2536) of one
 * of these names would contradict or repeat one of them, so an import does
 * not carry it and the engine does not send it.
 */
constexpr auto RESERVED_PARAM_NAMES =
std::to_array<std::string_view> ({ "grant_type", "client_id", "client_secret",
"code", "redirect_uri", "code_verifier", "refresh_token", "username", "password",
"scope", "state", "code_challenge", "code_challenge_method", "response_type" });

/// The config lists of extra request parameters, in the order the cache key
/// reads them (`cache_key`).
constexpr std::string_view AUTHORIZATION_PARAMS = "authorizationParams";
constexpr std::string_view TOKEN_PARAMS         = "tokenParams";
constexpr std::string_view REFRESH_PARAMS       = "refreshParams";
constexpr auto EXTRA_PARAM_LISTS = std::to_array<std::string_view> (
{ AUTHORIZATION_PARAMS, TOKEN_PARAMS, REFRESH_PARAMS });

/// Where an extra parameter row is sent (its `sendAs`). The authorize URL
/// reads none of this: every row of `authorizationParams` rides its query.
enum class ParamTarget : std::uint8_t { Body, Url, Header };

/// One extra parameter row the engine may send.
struct ExtraParam {
    std::string key;
    std::string value;
    ParamTarget target = ParamTarget::Body;
};

/**
 * The rows of @p config's @p list the engine may send, in list order: each an
 * object not `enabled: false` (absent or non-boolean is enabled), with a
 * non-empty string `key` outside `RESERVED_PARAM_NAMES`, and a `sendAs` that
 * is absent, `body`, `url` or `header`. A non-string `value` reads as "", as
 * `field` reads one; a malformed list or row is skipped, never refused. A
 * sender may still skip an eligible row whose name the engine itself wrote,
 * so the engine's value wins; the cache key reads every eligible row.
 */
std::vector<ExtraParam> extra_params (const nlohmann::json& config, std::string_view list);

/**
 * @brief Structured token-acquisition failure.
 *
 * `http_status` / `code` map 1:1 onto the /oauth2/token route's response;
 * provider_* fields carry the RFC 6749 error body when one was returned.
 */
struct TokenError {
    int http_status = 500; // 400 | 401 | 409 | 502
    std::string code; // "oauth2_invalid_config" | "oauth2_interactive_required"
                      // | "oauth2_provider_error" | "oauth2_network_error"
    std::string message;
    int provider_status = 0;
    // `{}` rather than bare declarations: every construction here is a
    // three-field aggregate init for a failure that carries no provider body,
    // and without the default member initializer each of those eight sites is
    // a -Wmissing-field-initializers warning. Empty is the intended value -
    // which is why the redundant-member-init finding on each is suppressed:
    // the initializer is redundant to the default constructor but not to the
    // aggregate-init warning.
    // NOLINTBEGIN(readability-redundant-member-init)
    std::string provider_error{};             // RFC 6749 "error"
    std::string provider_error_description{}; // RFC 6749 "error_description"
    // NOLINTEND(readability-redundant-member-init)
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
 * then, for each of `EXTRA_PARAM_LISTS` in order with at least one
 * `extra_params` row (issue #2536):
 *   \x1f listName ":" key "=" value ( \x1e key "=" value )*
 * the rows' (key, value) pairs sorted by key, then value, comparing bytes, so
 * row order and `sendAs` do not change the key. A row whose key names a
 * credential (`core::vayu_ext::names_param_credential`: `client_assertion`,
 * `X-Api-Key`, ...) writes its key with an empty value, so the key, which
 * clients are handed, never carries the secret. A config with no eligible row
 * keys exactly as it did before the lists existed.
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
 *
 * A call with `interactive` never reads the cache: it always exchanges the
 * code and overwrites the cached row with the result, whatever `force_refresh`
 * says and whether the row was fresh, expired or refreshable. The old refresh
 * token is not carried over; the provider's answer replaces the row whole.
 *
 * @param network_ms When non-null, the milliseconds this call spent waiting on
 *        the provider's token endpoint are added to it (a refresh and the fresh
 *        grant after a rejected refresh both count); a cache hit adds nothing.
 * @param cancel `ClientConfig::cancel` for the token request (issue #2683):
 *        a management-API handler's `RouteContext::server_stopping`, null
 *        everywhere else. A cancelled request is an `oauth2_network_error`.
 */
std::variant<vayu::db::OAuthToken, TokenError> acquire_token (vayu::db::Database& db,
const nlohmann::json& config,
bool force_refresh,
const std::optional<InteractiveExchange>& interactive,
double* network_ms              = nullptr,
const std::atomic<bool>* cancel = nullptr);

/**
 * @brief Public JSON shape of a cached token (never includes the refresh token
 *        value - only hasRefreshToken).
 */
nlohmann::json serialize_token (const vayu::db::OAuthToken& t);

} // namespace vayu::http::oauth
