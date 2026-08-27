#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <optional>
#include <string>
#include <string_view>
#include <vector>

/**
 * @file url_parts.hpp
 * @brief A URL split into the pieces Postman's `Url` object presents.
 *
 * The engine had no URL splitter that anything but the cookie jar could reach:
 * `cookie_jar.cpp` reads a host, a path and a scheme through libcurl's `CURLU`
 * for its own scoping, and stops there. `pm.request.url` (issue #991) needs the
 * whole shape - scheme, host segments, port, decoded path segments, the query
 * in wire order, the fragment - so it lives here rather than inside
 * `script_engine.cpp`, where nothing could unit-test it without a JS context.
 *
 * **libcurl owns the parsing.** Splitting a URL by hand is the class of thing
 * that is right for the URLs you thought of and wrong for the rest (IPv6
 * literals in brackets, userinfo before the host, a `?` inside a fragment), and
 * a private copy would not receive libcurl's fixes. `CURLU` is the same parser
 * the transfer layer resolves the URL with, so what a script reads and what
 * goes on the wire cannot disagree about where the host ends.
 *
 * ## What is decoded and what is not
 *
 * Path segments are percent-**decoded**, each segment on its own so an encoded
 * `%2F` stays inside the segment it belongs to rather than splitting it.
 *
 * The query is **not** decoded, in either `UrlParts::query` or the parsed
 * params: it is the wire bytes, in wire order, duplicates kept. That is what
 * the request-signing workflows this exists for need - a canonical string is
 * built from what was sent, not from a re-encoding of a decode - and it is what
 * postman-collection's `QueryParam` holds, so a lifted Postman script reads the
 * same values here as there.
 */

namespace vayu::http {

/**
 * @brief One `key=value` of a query string, exactly as it appears on the wire.
 *
 * `value` is `nullopt` for a bare key (`?flag`), which is a different fact from
 * an empty value (`?flag=`) - Postman tells the two apart and so does anything
 * rebuilding the string.
 */
struct UrlQueryParam {
    std::string key;
    std::optional<std::string> value;
};

/**
 * @brief The pieces of a URL. Every field is empty when @ref parsed is false.
 */
struct UrlParts {
    /// libcurl could read the string as a URL. False leaves every field empty:
    /// a caller that shows parts of an unparseable URL must show none of them
    /// rather than a plausible half.
    bool parsed = false;
    /// Scheme with no trailing colon (`https`).
    std::string protocol;
    /// Host split on `.` (`api.example.com` -> `{"api", "example", "com"}`).
    std::vector<std::string> host;
    /// The port the URL states, empty when it states none. A scheme's default
    /// port is never filled in - the URL either carried one or it did not.
    std::string port;
    /// Percent-decoded path segments, without the empty segment the leading
    /// `/` produces. A root path is one empty segment, which is how `/` and a
    /// URL with no path at all both read.
    std::vector<std::string> path;
    /// The query as it appears on the wire, without the leading `?`.
    std::string query;
    /// The same query split on `&`, in wire order, duplicates kept.
    std::vector<UrlQueryParam> query_params;
    /// The fragment without the leading `#`.
    std::string hash;
};

/**
 * @brief Split @p url into its parts, or return an unparsed @ref UrlParts.
 *
 * Never throws and never reports a diagnostic: a URL the parser cannot read is
 * an answer (`parsed == false`), because the callers all have a string to fall
 * back on that is more useful than an error.
 */
[[nodiscard]] UrlParts parse_url_parts (const std::string& url);

/**
 * @brief Split a raw query string (no leading `?`) on `&`, in wire order.
 *
 * Empty runs between separators are dropped (`a=1&&b=2` is two params), which
 * is what every consumer of a query string does with them.
 */
[[nodiscard]] std::vector<UrlQueryParam> parse_query_params (std::string_view query);

/**
 * @brief The params back as a wire query string, without the leading `?`.
 *
 * The inverse of @ref parse_query_params, and byte-for-byte its inverse for a
 * list that came out of it: values are already the wire bytes, so nothing is
 * encoded here. A `nullopt` value is a bare key.
 */
[[nodiscard]] std::string compose_query (const std::vector<UrlQueryParam>& params);

/**
 * @brief The parts back as a URL.
 *
 * The inverse of @ref parse_url_parts, for a caller that has *edited* the parts
 * - `pm.request.url.path.push(...)` and the query writers (issue #1040). It is
 * not a round-trip helper: a URL nobody edited must reach the wire as the bytes
 * it arrived as, so the script surface composes only when a member was actually
 * written to, and this is never called otherwise.
 *
 * Path segments are percent-encoded here because @ref parse_url_parts decoded
 * them, each segment on its own so an edited segment containing `/` stays one
 * segment. The query is passed through unencoded, for the same reason it was
 * never decoded.
 *
 * Empty when `parts.parsed` is false: there is nothing to compose from, and a
 * plausible-looking URL built out of empty pieces is worse than none.
 */
[[nodiscard]] std::string compose_url (const UrlParts& parts);

/**
 * @brief `{"api", "example", "com"}` -> `"api.example.com"`.
 */
[[nodiscard]] std::string join_host (const std::vector<std::string>& host);

/**
 * @brief `{"a", "b"}` -> `"/a/b"`, from the decoded segments back to a path.
 *
 * The inverse of the split, not of the decode: a segment that arrived
 * percent-encoded comes back decoded, matching Postman's `getPath()`.
 */
[[nodiscard]] std::string join_path (const std::vector<std::string>& path);

} // namespace vayu::http
