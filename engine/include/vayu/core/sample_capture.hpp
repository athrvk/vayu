#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/sample_capture.hpp
 * @brief Pure decisions about a captured load-run response body.
 *
 * Everything here runs at flush time, never on the completion callback: the
 * hot path only gates and copies bytes it already owns (see
 * MetricsCollector::record_success). Binary detection, hashing and dedup are
 * deferred precisely because they are the expensive half.
 *
 * Extracted rather than left inline in the collector so each rule is testable
 * on its own - see engine/tests/sample_capture_test.cpp.
 */

#include <string>
#include <string_view>

namespace vayu::core {

/**
 * @brief Whether a captured body should be stored as a binary descriptor
 *        instead of text.
 *
 * The engine never sets `CURLOPT_ACCEPT_ENCODING`, so a request that asks for
 * `gzip` gets the compressed bytes in `Response::body`; images and protobuf
 * arrive the same way. Storing those as a string means `dump()` either throws
 * or - with `error_handler_t::replace` - silently rewrites them into a
 * mojibake that reads like a real body. Neither is honest, so a binary body is
 * recorded as its size and content type and nothing else.
 *
 * Two independent signals, either sufficient:
 * - a content type that is not text-shaped (not a `text/` type, and not one of
 *   the structured-text markers `json` / `xml` / `javascript` /
 *   `x-www-form-urlencoded` / `csv`);
 * - bytes that are not valid UTF-8, or that contain a NUL.
 *
 * The byte scan is bounded (`SNIFF_BYTES`) so a 32 KiB body costs a fixed
 * prefix walk. A body whose first `SNIFF_BYTES` are clean text is treated as
 * text even if it turns binary later; the alternative is walking every
 * captured byte for a case that does not occur in practice.
 */
[[nodiscard]] bool looks_binary (std::string_view body, std::string_view content_type);

/// How many leading bytes `looks_binary` inspects.
inline constexpr size_t SNIFF_BYTES = 1024;

/**
 * @brief Lowercased media type of a `Content-Type` header value, parameters
 *        stripped (`"application/JSON; charset=utf-8"` -> `"application/json"`).
 *
 * Returns `""` for an absent or blank header, which `looks_binary` treats as
 * "no opinion from the header" and falls through to the byte scan.
 */
[[nodiscard]] std::string media_type (std::string_view content_type);

/**
 * @brief Lowercase hex SHA-256 of the stored bytes - the dedup key.
 *
 * Load-test responses are overwhelmingly identical, so the run's bodies are
 * deduplicated by this digest before insert: 1000 samples of one 2 KiB body
 * store 2 KiB. Hashing the *stored* (already truncated) bytes rather than the
 * original is deliberate - two bodies that differ only past the truncation
 * point are byte-identical as stored, and storing them twice would be storing
 * the same row twice.
 */
[[nodiscard]] std::string body_digest (std::string_view stored_body);

} // namespace vayu::core
