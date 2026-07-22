#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/json.hpp
 * @brief JSON utilities for request/response serialization
 */

#include <nlohmann/json.hpp>
#include <string>

#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

namespace vayu::json {

using Json = nlohmann::json;

/**
 * @brief Parse a JSON string
 *
 * @param str The JSON string to parse
 * @return Result<Json> The parsed JSON or an error
 */
[[nodiscard]] Result<Json> parse (const std::string& str);

/**
 * @brief Serialize a Request to JSON
 */
[[nodiscard]] Json serialize (const Request& request);

/**
 * @brief Serialize a Collection to JSON
 */
[[nodiscard]] Json serialize (const vayu::db::Collection& collection);

/**
 * @brief Serialize a Request (db) to JSON
 */
[[nodiscard]] Json serialize (const vayu::db::Request& request);

/**
 * @brief Serialize an Environment to JSON
 */
[[nodiscard]] Json serialize (const vayu::db::Environment& environment);

/**
 * @brief Serialize a Run to JSON
 */
[[nodiscard]] Json serialize (const vayu::db::Run& run);

/**
 * @brief Serialize a Metric to JSON
 */
[[nodiscard]] Json serialize (const vayu::db::Metric& metric);

/**
 * Attach a design run's single exchange to its serialized run object.
 *
 * A design run is one request and one response, so the exchange belongs with
 * the run rather than inside `GET /run/:id/report` - that report is a load-test
 * aggregate whose summary, for a design run, is computed from one sample.
 *
 * Does nothing for a load run, where `results` means the sampled subset and
 * belongs in the report. Does nothing when there are no results.
 */
void attach_design_result (nlohmann::json& json,
const vayu::db::Run& run,
const std::vector<vayu::db::Result>& results);

/**
 * @brief Deserialize a Request from JSON
 */
[[nodiscard]] Result<Request> deserialize_request (const Json& json);

/**
 * @brief Deserialize a Request from a JSON string
 */
[[nodiscard]] Result<Request> deserialize_request (const std::string& str);

/**
 * @brief Serialize a Response to JSON
 */
[[nodiscard]] Json serialize (const Response& response);

/**
 * @brief Serialize a Response to JSON string
 */
[[nodiscard]] std::string serialize_string (const Response& response,
int indent = vayu::core::constants::json::DEFAULT_INDENT);

/**
 * @brief Serialize an Error to JSON
 */
[[nodiscard]] Json serialize (const Error& error);

/**
 * @brief Serialize test results to JSON
 */
[[nodiscard]] Json serialize (const ScriptResult& result);

/**
 * @brief Pretty-print JSON with colors for terminal output
 */
[[nodiscard]] std::string pretty_print (const Json& json, bool color = true);

/**
 * @brief Check if a string is valid JSON
 */
[[nodiscard]] bool is_valid_json (const std::string& str);

/**
 * @brief Try to parse response body as JSON
 */
[[nodiscard]] std::optional<Json> try_parse_body (const std::string& body);

/**
 * @brief Stream a Request to a string output stream as JSON.
 * This is used for streaming responses to avoid loading all data into memory.
 * @param request The request to serialize
 * @param out Output stream to write JSON to
 */
void serialize_to_stream (const vayu::db::Request& request, std::ostream& out);

/**
 * @brief Sanitize a run's config snapshot before persistence.
 *
 * Parses `body` (the raw /request or /run payload) and reduces the top-level
 * `auth` object to just its `mode`, dropping every credential field. This is an
 * allowlist (keep `mode`) rather than a blocklist of known secret names, so no
 * future auth field can leak into the stored snapshot. Non-auth fields are left
 * intact. If `body` is not valid JSON it is returned unchanged.
 */
[[nodiscard]] std::string sanitize_config_snapshot (const std::string& body);

} // namespace vayu::json
