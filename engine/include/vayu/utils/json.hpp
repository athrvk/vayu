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
 * @brief Serialize a saved example response to JSON (issue #481)
 */
[[nodiscard]] Json serialize (const vayu::db::RequestExample& example);

/**
 * @brief Serialize a stored OpenAPI document to JSON (issue #637)
 */
[[nodiscard]] Json serialize (const vayu::db::SpecDocument& spec);

/**
 * @brief The same document without the parts that make it big (issue #712).
 *
 * What `GET /specs/:id/meta` answers: the fields describing the document -
 * where it came from, when, its hash and how many bytes it is - with `content`
 * and both app-extracted indexes left out entirely rather than emptied, because
 * an empty index is a document that declares nothing and this is a document
 * whose index was not read.
 */
[[nodiscard]] Json serialize_meta (const vayu::db::SpecDocument& spec);

/**
 * @brief Serialize an Environment to JSON
 */
[[nodiscard]] Json serialize (const vayu::db::Environment& environment);

/**
 * @brief Serialize a client-certificate registry entry (issue #707).
 *
 * `passphrase` is **not** part of the shape: it is write-only over the wire.
 * The card that manages these entries never needs to display one - it needs to
 * know whether the key has one, which `hasPassphrase` says - and a secret that
 * is never sent back cannot end up in a log, a screenshot or a bug report.
 * Storing it plaintext is the repo's precedent; echoing it would be a new one.
 */
[[nodiscard]] Json serialize (const vayu::db::ClientCertificate& certificate);

/**
 * @brief Serialize a Run to JSON
 */
[[nodiscard]] Json serialize (const vayu::db::Run& run);

/**
 * @brief Parse a stored variables blob (collections/environments/globals
 * `variables` column) into an in-memory Environment.
 *
 * Entries that are not JSON objects are skipped; a malformed blob yields an
 * empty Environment rather than throwing. `createdAt` is read only when it is
 * a number - anything else is treated as absent (see Variable::created_at).
 */
[[nodiscard]] vayu::Environment parse_variables (const std::string& json_str);

/**
 * @brief Serialize an Environment back to a stored variables blob.
 *
 * The exact inverse of `parse_variables`: it must write every field the parser
 * reads. `POST /execute` rewrites the three variable scopes through this pair
 * after running scripts, so a field missing here is erased from disk on the
 * next design run - which is how `createdAt` was lost (issue #135).
 *
 * `created_at` is omitted when unset rather than defaulted, so a variable whose
 * creation time is genuinely unknown stays unknown instead of being stamped
 * with "now" and jumping to the bottom of the user's list.
 */
[[nodiscard]] std::string serialize_variables (const vayu::Environment& env);

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
 * Cap the request/response body strings in a design-run trace, in place.
 *
 * Applied to the trace built by `build_result_trace`
 * (engine/src/http/routes/execution.cpp) before it is persisted to
 * `results.trace_data`, so one large exchange cannot bloat the DB forever. When
 * a `body` exceeds @p max_body_bytes it is cut to that many bytes and its node
 * gains `bodyTruncated: true` and `bodyBytes` (the original byte length) so a
 * reader can tell a stored slice from the whole body. The cut is on a raw byte
 * boundary - the body is an opaque string - so the caller must dump with
 * `error_handler_t::replace` in case the slice splits a UTF-8 sequence.
 *
 * The request node's `rawRequest` ends with that same body, so it is capped to
 * the same limit - body half only, header block kept whole, since the headers
 * are what the field is stored for. See docs/engine/db-schema.md
 * (results.trace_data).
 */
void cap_trace_bodies (nlohmann::json& trace, size_t max_body_bytes);

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
