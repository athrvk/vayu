#pragma once

#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace vayu::http {

/**
 * @brief Outcome of resolving an auth object onto a request.
 *
 * `ok == true` means the request may proceed (auth was applied, or there was
 * nothing to apply). `ok == false` carries an ErrorCode (AuthRequired /
 * AuthFailed) that the caller surfaces to the client.
 */
struct AuthApplyResult {
    bool ok = true;
    vayu::ErrorCode code = vayu::ErrorCode::None;
    std::string message;
    std::string detail_code; // machine-readable hint, e.g. "oauth2_interactive_required"
};

/**
 * @brief Resolve an `auth` object into request headers (and/or URL) before the
 *        request is sent.
 *
 * Handles the static modes today: `bearer`, `basic`, `apikey` (header or
 * query). `none`/`inherit` and the not-yet-executable modes
 * (`oauth2`/`digest`/`aws`/`ntlm`) are no-ops. A user-supplied `Authorization`
 * header always wins — injection is skipped when one is already present.
 *
 * @param req  Request to mutate (headers and possibly url).
 * @param auth The resolved auth object (variables already substituted app-side).
 *             May be null/absent.
 * @param db   Database handle for token lookup (reserved for oauth2; may be null).
 */
AuthApplyResult
apply_auth (vayu::Request& req, const nlohmann::json& auth, vayu::db::Database* db);

} // namespace vayu::http
