/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/request_builder.hpp"

#include "vayu/http/auth_resolver.hpp"
#include "vayu/utils/json.hpp"

namespace vayu::http {

RequestBuild build_request (const nlohmann::json& config, vayu::db::Database* db,
int timeout_ms, AuthResolution auth_resolution) {
    RequestBuild out;

    auto parsed = vayu::json::deserialize_request (config);
    if (parsed.is_error ()) {
        out.ok            = false;
        out.parse_failed  = true;
        out.error_message = parsed.error ().message;
        return out;
    }

    out.request            = parsed.value ();
    out.request.timeout_ms = timeout_ms;

    // Deferred: the caller holds credentials that must bind a data row before
    // they are encoded, and applies the auth itself once they have. Left
    // untouched here rather than applied-then-rewritten, because `apply_auth`
    // is not reversible - a base64 `Authorization` value cannot be un-collapsed
    // back into the username and password a row was meant to fill.
    if (auth_resolution == AuthResolution::Defer) {
        return out;
    }

    auto auth = apply_auth (
    out.request, config.value ("auth", nlohmann::json ()), db);
    if (!auth.ok) {
        out.ok            = false;
        out.error_code    = auth.code;
        out.error_message = auth.message;
        out.detail_code   = auth.detail_code;
    }

    return out;
}

} // namespace vayu::http
