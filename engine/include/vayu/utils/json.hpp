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

#include <cstddef>
#include <cstdint>
#include <functional>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

namespace vayu::http {
class FileAccessPolicy;
}

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
 * @brief Serialize a Request (db) to JSON, its body's file references carrying
 * the `unresolved` @p files derives for them (`derive_file_trust`).
 *
 * The policy is a parameter rather than something a caller adds afterwards, so
 * no route can answer a stored body without the derived value the editor reads.
 */
[[nodiscard]] Json serialize (const vayu::db::Request& request,
const vayu::http::FileAccessPolicy& files);

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
 * and both stored indexes left out entirely rather than emptied, because
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
 * @brief A run's `origin` as both run shapes emit it (#1817):
 * `{kind, client}`, `client` null when none was kept. The one copy, so the
 * `GET /runs` list row and the single-run payload cannot drift.
 */
[[nodiscard]] Json serialize_run_origin (const vayu::db::Run& run);

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
 * `error_handler_t::replace` in case the slice splits a UTF-8 sequence. A node
 * whose `bodyEncoding` is `base64` is capped by its decoded bytes instead, cut
 * at a multiple of three so the slice is still whole base64, and `bodyBytes`
 * counts decoded bytes too (issue #2458).
 *
 * The request node's `rawRequest` ends with that same body, so it is capped to
 * the same limit - body half only, header block kept whole, since the headers
 * are what the field is stored for. See docs/engine/db-schema.md
 * (results.trace_data).
 */
void cap_trace_bodies (nlohmann::json& trace, size_t max_body_bytes);

/**
 * @brief Call @p visit on every file reference in the request body @p body: a
 * `binary` body's `file` object and each `type: "file"` entry of `fields`.
 */
void for_each_file_ref (Json& body, const std::function<void (Json& ref)>& visit);

/**
 * @brief Remove `unresolved` from every file reference in @p body.
 *
 * Trust is never stored (#2356): a client older than that rule still sends the
 * key, and every write of a request body or a run's snapshot drops it here, so
 * no stored value can be mistaken for a decision the engine made.
 */
void erase_file_trust (Json& body);

/**
 * @brief Write the derived `unresolved` onto every file reference in @p body,
 * for a reader to display.
 *
 * `true` when `src` names a concrete path @p files does not allow - not under
 * an allowed folder and not a picked file - so the editor can say "not chosen
 * on this machine". `false` for an allowed path and for one holding `{{`
 * (decided after composition; the editor says that with its own line). A
 * reference with no path carries no key: there is nothing to doubt, which is
 * how an import has always written one. Output only: a request body's
 * `unresolved` is ignored when it is parsed.
 */
void derive_file_trust (Json& body, const vayu::http::FileAccessPolicy& files);

/**
 * @brief Deserialize a Request from JSON
 */
[[nodiscard]] Result<Request> deserialize_request (const Json& json);

/**
 * @brief Deserialize a Request from a JSON string
 */
[[nodiscard]] Result<Request> deserialize_request (const std::string& str);

/**
 * How a response body's JSON string is to be read (issue #2458): `bodyRaw` on
 * the `POST /execute` answer, `body` on a stored trace's `response` node. A
 * JSON string holds only UTF-8, so a body that is not text
 * (`vayu::utils::is_valid_utf8_text`) travels as its base64 instead of failing
 * the serializer.
 */
inline constexpr std::string_view BODY_ENCODING_UTF8   = "utf8";
inline constexpr std::string_view BODY_ENCODING_BASE64 = "base64";

/**
 * @brief The text a response body travels as, or `std::nullopt` when it is not
 *        text and travels as base64.
 *
 * The one decision behind the live answer (`serialize`) and the stored trace
 * (`build_result_trace`), so the two spell a body alike. A body the read cap
 * cut (`Response::body_truncated`) can end inside a character, and that
 * incomplete tail is left off the text rather than sending the whole prefix
 * as base64 (`vayu::utils::without_incomplete_utf8_tail`). A view into
 * `response.body`.
 */
[[nodiscard]] std::optional<std::string_view> response_body_text (const Response& response);

/**
 * @brief `Response::header_lines` as a JSON array of `{name, value}` objects,
 *        in wire order (issue #2460).
 *
 * The one spelling behind `serialize`'s `headerLines` and the stored trace's
 * `response.headerLines`. An empty array for no lines.
 */
[[nodiscard]] Json serialize_header_lines (const std::vector<HeaderLine>& lines);

/// The followed redirect hops as `[{status, statusText, headerLines}]`, in the
/// order they arrived (issue #2461).
[[nodiscard]] Json serialize_redirects (const std::vector<RedirectHop>& hops);

/**
 * @brief Serialize a Response to JSON
 *
 * `bodyEncoding` is always present. `headerLines` is always present too, an
 * empty array when none were recorded, so a reader can tell "none" from "an
 * engine too old to say". A text body is `bodyRaw` as it arrived
 * (less a capped body's incomplete last character, `response_body_text`) and
 * `body` its parse (or `null`); any other body is `bodyRaw` in base64 with
 * `body` `null`. `bodySize` counts the bytes either way.
 */
[[nodiscard]] Json serialize (const Response& response);

/**
 * @brief The body bytes of a serialized Response: `bodyRaw`, decoded when
 *        `bodyEncoding` says base64.
 *
 * An absent `bodyEncoding` reads as `utf8`, which is what every answer meant
 * before the field existed. `std::nullopt` for an encoding this engine does not
 * write, or a `base64` body that does not decode.
 */
[[nodiscard]] std::optional<std::string> response_body_bytes (const Json& answer);

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
 * @param files What the body's derived `unresolved` is read from, as for
 *        `serialize`
 */
void serialize_to_stream (const vayu::db::Request& request,
std::ostream& out,
const vayu::http::FileAccessPolicy& files);

/**
 * @brief True when @p value nests deeper than @p max_depth levels (#2362).
 *
 * A scalar has depth 0 and an array or object has 1 plus its deepest child's,
 * so `[[1]]` is 2 and `[]` is 1. Walks with an explicit stack and stops at the
 * first container past the bound, which is the point: nlohmann parses
 * iteratively, but `dump ()` and the copy constructor recurse, so a payload
 * nested far past any real document must be refused before either runs on it.
 * This is the only probe that is safe on such a value.
 */
[[nodiscard]] bool exceeds_depth (const Json& value, size_t max_depth);

/**
 * @brief Sanitize a run's config snapshot before persistence: the composed
 *        request, with its credentials withheld (#1803).
 *
 * `body` is the `POST /execute` or `POST /runs` payload, which is already
 * composed: every `{{variable}}` it named holds its value. Three things are
 * withheld, each written as `vayu::utils::kRedactedMarker` where it is not
 * dropped:
 *
 * - **`auth`** is reduced to its `mode`. An allowlist (keep `mode`) rather
 *   than a blocklist of known secret names, so no future auth field can leak.
 * - **A credential header's value**: every `headers` entry whose name is in
 *   the shared secret set (`vayu::utils::is_secret_field_name`), or is the
 *   header an `apikey` auth names. The name is kept, so the snapshot still
 *   says the request carried one.
 * - **Every occurrence of a value in @p secret_values** (the request's
 *   secret-flagged variables), raw and in the two percent-encoded forms a URL
 *   carries, inside `url`, `params`, `headers`, `body.content` and
 *   `body.fields`. A value shorter than four characters is left alone.
 *
 * Everything else is kept, except the top-level `origin` (#1817), which the
 * run row stores in its own columns, and a file reference's `unresolved`,
 * which is derived on read and never stored (`erase_file_trust`). If `body`
 * is not valid JSON it is returned unchanged.
 *
 * `body.content` (the request body being tested, not `body` itself) is capped
 * at `max_body_bytes`, the same limit `cap_trace_bodies` applies to a stored
 * trace, so one oversized send cannot leave a permanently bloated snapshot
 * behind. A cut records `bodyTruncated`/`bodyBytes` on the `body` object,
 * mirroring `cap_node_body`'s sibling-key shape.
 */
[[nodiscard]] std::string sanitize_config_snapshot (const std::string& body,
size_t max_body_bytes,
const std::vector<std::string>& secret_values = {});

} // namespace vayu::json
