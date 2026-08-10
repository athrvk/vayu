#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <variant>

namespace vayu::http {

// ---------------------------------------------------------------------------
// Typed auth model
//
// The raw `auth` JSON is parsed into a typed variant at the boundary
// (parse_auth), so the send path never string-matches JSON and adding a new
// mode is a compile error until it is handled (see apply_auth's static_assert).
// ---------------------------------------------------------------------------

struct NoAuth {};
struct BearerAuth {
    std::string token;
};
struct BasicAuth {
    std::string username;
    std::string password;
};
struct ApiKeyAuth {
    std::string key;
    std::string value;
    bool in_query = false; // header (default) vs query param
};
struct OAuth2Auth {
    nlohmann::json config; // opaque until the oauth2 token path lands
};
struct UnsupportedAuth {
    std::string mode; // digest / aws / ntlm - stored but not executed
};

using Auth = std::variant<NoAuth, BearerAuth, BasicAuth, ApiKeyAuth, OAuth2Auth,
UnsupportedAuth>;

/**
 * @brief Parse a raw `auth` object into the typed Auth model.
 *
 * `none`/`inherit`/absent/malformed all collapse to NoAuth. `inherit` is
 * expected to be resolved app-side; if it reaches here it is treated as no-op.
 */
Auth parse_auth (const nlohmann::json& auth);

/**
 * @brief Outcome of resolving auth onto a request.
 *
 * `ok == false` carries an ErrorCode (AuthRequired / AuthFailed) plus a
 * machine-readable detail_code for the client.
 */
struct AuthApplyResult {
    bool ok = true;
    vayu::ErrorCode code = vayu::ErrorCode::None;
    std::string message;
    std::string detail_code;
};

/**
 * @brief Apply typed auth to a request (mutates headers and/or url).
 *
 * A user-supplied header always wins (injection is skipped when the target
 * header already exists - matched case-insensitively). `db` is reserved for
 * oauth2 token lookup and may be null.
 */
AuthApplyResult apply_auth (vayu::Request& req, const Auth& auth, vayu::db::Database* db);

/**
 * @brief Convenience overload: parse then apply. Used by direct callers/tests.
 */
AuthApplyResult apply_auth (vayu::Request& req, const nlohmann::json& auth,
vayu::db::Database* db);

/**
 * @brief Route-level pre-flight for POST /run: for oauth2 configs, acquire the
 *        token now (cache-aware, warming the cache for the run worker) so an
 *        unauthorizable run is rejected before it is created. No-op for every
 *        other mode.
 */
AuthApplyResult preflight_auth (const nlohmann::json& auth, vayu::db::Database& db);

/**
 * @brief The `Authorization` value an oauth2 config places for an access token.
 *
 * One copy of the `headerPrefix` rule, shared by the initial resolution and by
 * every mid-run refresh - a second copy would let a run's later headers drift
 * in shape from its first.
 */
std::string oauth2_header_value (const nlohmann::json& config,
const std::string& access_token);

/**
 * @brief What a long run needs in order to keep its OAuth 2.0 header valid
 *        past the token's expiry.
 *
 * Filled from the token `apply_auth` just placed on @p request, so it describes
 * the credential the run is actually sending - not what the config asks for.
 * The run's refresh watchdog re-acquires with this config and republishes
 * `header_value`; see `vayu::core::run_auth_refresh`.
 */
struct AuthRefreshPlan {
    nlohmann::json config;      ///< The oauth2 config block, as acquire_token takes it.
    std::string header_name;    ///< Header the token was placed on.
    std::string header_value;   ///< Value currently on the built request.
    int64_t expires_at_ms = 0;  ///< Absolute expiry (ms since epoch) of that token.
};

/**
 * @brief Decide whether a built request's auth can be refreshed mid-run.
 *
 * Returns nothing - the run then behaves exactly as it did before mid-run
 * refresh existed - when any of these hold:
 *   - the mode is not `oauth2`, or the token cache has no token for it;
 *   - the token never expires (`expires_in <= 0`);
 *   - `autoRefreshToken` is false (the user's explicit opt-out);
 *   - `tokenPlacement` is `query` - the value is baked into the URL every
 *     transfer copies, which no header swap can reach;
 *   - the grant is `authorization_code` with no refresh token, which cannot be
 *     re-obtained without a browser;
 *   - the request does not actually carry the token (a user-supplied
 *     `Authorization` header won, so refreshing it would change nothing).
 *
 * @param request The request `apply_auth` has already resolved.
 * @param auth    The same raw `auth` object that was applied.
 * @param db      Token-cache handle; null yields nothing.
 */
std::optional<AuthRefreshPlan> plan_auth_refresh (const vayu::Request& request,
const nlohmann::json& auth,
vayu::db::Database* db);

} // namespace vayu::http
