#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/path_template.hpp
 * @brief The one engine-side copy of `normalizeVars`, in both of the shapes the
 *        renderer calls it in.
 *
 * It lived inside `http/routes/mock_server.cpp` while the mock server was its
 * only reader, and moved here when a second one arrived: the request drafts an
 * import would build (`core/openapi_drafts` under issue #865) write their URL
 * through exactly this rewrite, which is *why* the mock server can route them.
 * Two copies of it would be two answers to "what does `{petId}` become", and
 * the failure that produces - an imported request the mock silently cannot
 * route - is invisible until a 404 nobody can explain.
 *
 * Pinned to the app's copy by `tests/fixtures/path-template-conformance.json`,
 * read by `mock_server_routes_test.cpp` and by the app's
 * `path-template.conformance.test.ts`.
 *
 * It also holds the one engine-side reading of Postman's `:name` path
 * variables (issue #1764): which segments of a URL are one, and what a
 * request's `in: "path"` Params rows put in their place at send time.
 */

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace vayu::core {

/**
 * @brief Tighten the `{{ }}` spellings in @p text, and nothing else -
 *        `normalizeVars(text)` with `pathTemplates` off.
 *
 * `{{ x }}` and `{{ _.x }}` become `{{x}}`. A **single** brace is left exactly
 * as written, which is the whole difference from
 * @ref normalize_path_templates: Postman and Insomnia template with `{{x}}`
 * alone, so `fields=friends{name}` and a path segment `/tags/{beta}` are
 * literal text there, and rewriting them would invent a variable reference
 * that resolves to nothing at execution.
 *
 * Every value an import carries out of those two formats goes through this -
 * a URL, a header value, a variable, an auth secret (issue #877).
 */
[[nodiscard]] std::string normalize_template_vars (const std::string& text);

/**
 * @brief Rewrite every template spelling in @p path to `{{name}}`.
 *
 * `{{ x }}` and `{{ _.x }}` tighten to `{{x}}`, a single-brace `{x}` becomes
 * `{{x}}`, and anything that fits neither shape (a Nunjucks filter, `{a|b}`) is
 * left verbatim rather than guessed at - a rewrite that changes what gets sent
 * has to be certain of what it is looking at.
 *
 * Path only, and `{ }` only: the `:param` spelling Postman writes is a
 * request's own path variable (@ref path_variable_segments), resolved from its
 * Params rows at send time rather than rewritten into a shared variable.
 */
[[nodiscard]] std::string normalize_path_templates (const std::string& path);

/**
 * One `:name` path variable in a URL: where the `:name` text sits (the colon
 * included, a `.suffix` after the name excluded) and the name it spells.
 */
struct PathVariableSegment {
    std::size_t offset = 0;
    std::size_t length = 0;
    std::string name;
};

/**
 * @brief Every `:name` path variable in @p url, left to right, repeats
 *        included.
 *
 * Postman's own rule, read from `postman-url-encoder/parser` and
 * `postman-collection`'s `Url.parse` / `parsePathVariable`: a `{{variable}}`
 * token is opaque, the fragment (from the first `#`) and the query (from the
 * first `?`) are cut off, a backslash is a `/`, `scheme://` and the slashes
 * after it are skipped, and the path is what follows the first `/` after that
 * - so a port (`host:8080`) is never a path variable, and neither is a `:` in
 * the query or the fragment. A path segment that starts with `:` is a
 * variable whose name runs to the first `.` (`:id.json` is `id`, with the
 * `.json` suffix kept on the wire); an empty name (`:` or `:.x`) is none.
 */
[[nodiscard]] std::vector<PathVariableSegment> path_variable_segments (std::string_view url);

/// Whether a Params row is a path variable (`"in": "path"`) rather than a
/// query row (`in` absent, `"query"`, or anything else).
[[nodiscard]] bool is_path_variable_row (const nlohmann::json& row);

/**
 * @brief @p value percent-encoded as one path segment, with every
 *        `{{variable}}` token in it kept verbatim.
 *
 * RFC 3986's unreserved set passes through and every other byte is `%XX`
 * (`vayu::utils::url_encode`), so a `/`, `?`, `#` or `%` in a value is data in
 * one segment rather than structure. A token is kept whole because something
 * after composition still has to answer it - a data column bound per
 * iteration, a deferred `{{$guid}}`, the residual pass after a pre-request
 * script - and an encoded `%7B%7B` would be a name nothing can find.
 */
[[nodiscard]] std::string encode_path_segment_value (std::string_view value);

/// The last enabled `in: "path"` row of @p rows whose key is @p name, or
/// `nullptr` - Postman's `VariableList` answers a duplicated key with its last
/// enabled entry.
[[nodiscard]] const nlohmann::json*
find_path_variable_row (const nlohmann::json& rows, std::string_view name);

/**
 * @brief @p url with each `:name` segment replaced by its path row's value.
 *
 * @p rows is a request's Params array; only an enabled `in: "path"` row
 * answers, and among several with the same key the last enabled one does.
 * @p resolve turns the row's value into send-time text (`{{var}}`
 * resolution); a value that resolves to nothing leaves the
 * segment literal, as Postman's `Url.getPath` and Insomnia's
 * `applyPathParametersToUrl` both do. Otherwise the resolved value is written
 * through @ref encode_path_segment_value in place of `:name`, and a suffix
 * after the name stays. A URL with no `:name` segment, or rows with no path
 * row, come back unchanged.
 */
template <typename Resolve>
std::string substitute_path_variables (const std::string& url,
const nlohmann::json& rows,
const Resolve& resolve) {
    if (!rows.is_array () || rows.empty ()) {
        return url;
    }
    const std::vector<PathVariableSegment> segments = path_variable_segments (url);
    if (segments.empty ()) {
        return url;
    }
    std::string out;
    out.reserve (url.size ());
    std::size_t copied = 0;
    for (const PathVariableSegment& segment : segments) {
        const nlohmann::json* row = find_path_variable_row (rows, segment.name);
        if (row == nullptr) {
            continue;
        }
        const auto value      = row->find ("value");
        const std::string raw = value != row->end () && value->is_string () ?
        value->get<std::string> () :
        std::string ();
        const std::string resolved = resolve (raw);
        if (resolved.empty ()) {
            continue;
        }
        out.append (url, copied, segment.offset - copied);
        out += encode_path_segment_value (resolved);
        copied = segment.offset + segment.length;
    }
    out.append (url, copied);
    return out;
}

} // namespace vayu::core
