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
#include <string>

namespace vayu::http {

/**
 * @brief Whether `build_request` resolves the config's `auth`, or leaves it.
 *
 * `Apply` is what every ordinary caller wants and is the default: the
 * credentials become an `Authorization` header (or a query parameter) as part
 * of building the request.
 *
 * `Defer` exists for the one caller shape that must touch the credentials
 * *before* they are encoded: a `{{data.column}}` token inside a credential has
 * to carry its row's value before `apply_auth` base64-encodes a username and
 * password into one header, because after that it is unreadable and would go
 * out as base64 of the literal token text (issue #591). The `{{$vu}}` /
 * `{{$iteration}}` identity is deferred for the same reason and on the same
 * rule (issue #1055): what decides a deferral is the token the credentials
 * carry, never the shape of the run, so a caller with no data set at all still
 * defers for an identity token and binds it per iteration. Such a caller parses
 * the auth itself, joins it against the iteration and applies it afterwards -
 * `vayu::core::bind_auth_row` is that step. A credential holding a name only
 * the variable scopes answer defers too (issue #2473), and is finished by
 * `routes::apply_late_auth` after the pre-request script instead. Those are
 * the only correct ways to finish a deferred build. A `Defer` whose auth is
 * never applied sends an unauthenticated request.
 */
enum class AuthResolution : std::uint8_t { Apply, Defer };

/**
 * @brief Result of constructing a Request from a run config.
 *
 * `ok == true` yields a ready-to-send `request`. `parse_failed` distinguishes a
 * malformed payload (→ 400) from an auth failure (→ carries error_code /
 * detail_code for the client). A malformed payload carries a `detail_code` too
 * when the refusal has a name (`invalid_header_name`), empty otherwise.
 */
struct RequestBuild {
    bool ok = true;
    vayu::Request request;
    bool parse_failed          = false;
    vayu::ErrorCode error_code = vayu::ErrorCode::None;
    std::string error_message;
    std::string detail_code;
    /// Time auth resolution spent waiting on an OAuth 2.0 token endpoint; see
    /// `AuthApplyResult::token_fetch_ms`.
    double auth_fetch_ms = 0.0;
};

/**
 * @brief Single request-construction pipeline for both execution paths.
 *
 * Deserializes the request from `config`, applies the resolved `timeout_ms`,
 * and resolves auth (headers/url) via apply_auth. Both the design (`/execute`)
 * and load (`/runs`) paths call this so request construction lives in one place.
 *
 * @param config     The run config JSON (HTTP fields at the root, plus `auth`).
 * @param db         Database handle for token lookup (reserved for oauth2; may be null).
 * @param timeout_ms The already-resolved request timeout to apply.
 * @param auth       Whether to resolve `auth` here (default) or leave it to the
 *                   caller - see @ref AuthResolution.
 */
RequestBuild build_request (const nlohmann::json& config,
vayu::db::Database* db,
int timeout_ms,
AuthResolution auth = AuthResolution::Apply);

} // namespace vayu::http
