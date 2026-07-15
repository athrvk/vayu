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
    std::string mode; // digest / aws / ntlm — stored but not executed
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
 * header already exists — matched case-insensitively). `db` is reserved for
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

} // namespace vayu::http
