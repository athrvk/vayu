#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <type_traits>
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

using Auth =
std::variant<NoAuth, BearerAuth, BasicAuth, ApiKeyAuth, OAuth2Auth, UnsupportedAuth>;

/**
 * @brief Parse a raw `auth` object into the typed Auth model.
 *
 * `none`/`inherit`/absent/malformed all collapse to NoAuth. `inherit` is
 * expected to be resolved app-side; if it reaches here it is treated as no-op.
 */
Auth parse_auth (const nlohmann::json& auth);

/**
 * @brief Where a credential ends up once `apply_auth` has written it.
 *
 * A bind rule can depend on this - a value written into a header line must not
 * carry the CR or LF that would end the line (issue #732) - and this walk is
 * the only place that knows which credential is which, because the destination
 * is a property of the *mode* rather than of the string. Saying it here is what
 * stops each caller from re-deriving it from the variant and drifting.
 */
enum class CredentialDestination : std::uint8_t {
    /// Written into a header line as it stands: a bearer token, and both halves
    /// of an api key sent in a header.
    HeaderLine,
    /// Encoded before it reaches the wire, so no byte of it can end a line or a
    /// field: basic auth's pair (base64) and an api key sent as a query
    /// parameter (percent-encoded).
    Encoded,
};

/**
 * @brief Visit every credential string a parsed auth carries, in a fixed order.
 *
 * The fields a user types a secret into, and so the fields a `{{data.column}}`
 * token may legitimately sit in: the bearer token, both halves of basic auth,
 * and an api key's name and value. Driving the same variant `apply_auth`
 * consumes is what keeps the two from drifting - a new mode is a compile error
 * here as well, through the same static_assert.
 *
 * `@p auth` may be `const`; the visitor then receives `const std::string&`.
 * Each credential is visited with the @ref CredentialDestination it is headed
 * for, so a caller whose rule depends on that reads it rather than deducing it.
 *
 * **OAuth 2.0 is deliberately absent.** Its config is not a credential the
 * request carries but the input to a token acquisition that happens once, when
 * a plan is resolved; there is no per-iteration acquisition for a row to reach,
 * so a data token in it is refused rather than walked
 * (`core::resolve_scenario`, issue #591).
 */
template <typename AuthRef, typename Visit>
void walk_auth_credentials (AuthRef& auth, Visit&& visit) {
    std::visit (
    [&visit] (auto& a) {
        using T = std::decay_t<decltype (a)>;

        if constexpr (std::is_same_v<T, BearerAuth>) {
            visit (a.token, CredentialDestination::HeaderLine);
        } else if constexpr (std::is_same_v<T, BasicAuth>) {
            // Collapsed into one base64 `Authorization` value by `apply_auth`.
            visit (a.username, CredentialDestination::Encoded);
            visit (a.password, CredentialDestination::Encoded);
        } else if constexpr (std::is_same_v<T, ApiKeyAuth>) {
            // Both halves go the same way: a header line, or a percent-encoded
            // query parameter.
            const CredentialDestination destination =
            a.in_query ? CredentialDestination::Encoded : CredentialDestination::HeaderLine;
            visit (a.key, destination);
            visit (a.value, destination);
        } else if constexpr (std::is_same_v<T, NoAuth> || std::is_same_v<T, OAuth2Auth>) {
            // Nothing to bind: no credential at all, and an oauth2 config is
            // handled where it is refused rather than here.
        } else {
            static_assert (std::is_same_v<T, UnsupportedAuth>, "unhandled Auth variant");
            // digest / aws / ntlm are stored but never executed, so a token in
            // one binds nothing and reaches no wire.
        }
    },
    auth);
}

/**
 * @brief Outcome of resolving auth onto a request.
 *
 * `ok == false` carries an ErrorCode (AuthRequired / AuthFailed) plus a
 * machine-readable detail_code for the client.
 */
struct AuthApplyResult {
    bool ok              = true;
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
AuthApplyResult
apply_auth (vayu::Request& req, const nlohmann::json& auth, vayu::db::Database* db);

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
std::string oauth2_header_value (const nlohmann::json& config, const std::string& access_token);

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
    nlohmann::json config; ///< The oauth2 config block, as acquire_token takes it.
    std::string header_name;  ///< Header the token was placed on.
    std::string header_value; ///< Value currently on the built request.
    int64_t expires_at_ms = 0; ///< Absolute expiry (ms since epoch) of that token.
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
