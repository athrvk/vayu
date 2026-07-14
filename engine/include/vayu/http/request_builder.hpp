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

namespace vayu::http {

/**
 * @brief Result of constructing a Request from a run config.
 *
 * `ok == true` yields a ready-to-send `request`. `parse_failed` distinguishes a
 * malformed payload (→ 400) from an auth failure (→ carries error_code /
 * detail_code for the client).
 */
struct RequestBuild {
    bool ok = true;
    vayu::Request request;
    bool parse_failed = false;
    vayu::ErrorCode error_code = vayu::ErrorCode::None;
    std::string error_message;
    std::string detail_code;
};

/**
 * @brief Single request-construction pipeline for both execution paths.
 *
 * Deserializes the request from `config`, applies the resolved `timeout_ms`,
 * and resolves auth (headers/url) via apply_auth. Both the design (`/request`)
 * and load (`/run`) paths call this so request construction lives in one place.
 *
 * @param config     The run config JSON (HTTP fields at the root, plus `auth`).
 * @param db         Database handle for token lookup (reserved for oauth2; may be null).
 * @param timeout_ms The already-resolved request timeout to apply.
 */
RequestBuild build_request (const nlohmann::json& config, vayu::db::Database* db,
int timeout_ms);

} // namespace vayu::http
