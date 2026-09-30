#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/query_encoding.hpp
 * @brief How a query row's key and value are written into a URL, by Postman's
 *        own rule (issue #1771).
 *
 * Pinned to the app's copy (`request-builder/utils/query-encoding.ts`) by
 * `tests/fixtures/query-encoding-conformance.json`, read by
 * `query_encoding_test.cpp` and `query-encoding.conformance.test.ts`.
 */

#include <cstdint>
#include <string>
#include <string_view>

namespace vayu::core {

enum class QueryPart : std::uint8_t { Key, Value };

/// Which rule joins a request's query rows into its URL. `Postman` is the
/// Params table's and a Postman import's; `UriComponent` is
/// `encodeURIComponent`, kept by the OpenAPI, Insomnia and JMeter imports
/// because a stored OpenAPI URL is what the sync diff compares against and
/// those sources do not use Postman's set (a raw `+` would read as a space);
/// `AsTyped` is `disableUrlEncoding` (issue #1765).
enum class QueryEncoding : std::uint8_t { UriComponent, Postman, AsTyped };

/**
 * @brief @p text as Postman writes it into a query, as a key or a value.
 *
 * `postman-url-encoder` 3.0.8's `toNodeUrl` encodes the query with
 * `QUERY_ENCODE_SET` (`encoder/encode-set.js`): the C0 controls, DEL and every
 * byte above `~` (each UTF-8 byte, `%XX` uppercase), space, `"`, `#`, `'`,
 * `<` and `>`. Before that, `postman-collection`'s `QueryParam.unparse`
 * (`normalizeParam`) encodes `&` in both parts and `=` in a key only - a value
 * cannot split a pair, because a parser splits on the first `=`. Every whole
 * `{{...}}` token (`/{{[^{}]*}}/`) is kept verbatim. `%` is never encoded, so
 * an escape already in the text passes and nothing is encoded twice.
 */
[[nodiscard]] std::string encode_query_component (std::string_view text, QueryPart part);

/// Which part of a URL a point in its text sits in, for the rule a value
/// substituted there is written by (issue #1773). `Head` is everything before
/// the query: scheme, host and path, which keep their own rules.
enum class UrlComponent : std::uint8_t { Head, QueryKey, QueryValue, Fragment };

/**
 * @brief The component in force after @p text, read from @p from.
 *
 * The first `?` opens the query at a key, `=` moves a key to its value, `&`
 * starts the next key, and `#` opens the fragment, which nothing closes.
 * Every whole `{{...}}` token is skipped, so a separator inside a variable
 * name moves nothing - the same token rule `encode_query_component` keeps.
 */
[[nodiscard]] UrlComponent advance_url_component (std::string_view text, UrlComponent from);

/**
 * @brief @p value as it is written into a URL at @p where: by
 *        `encode_query_component` in a query key or value, as it stands in
 *        the head and the fragment.
 *
 * Postman resolves a request's variables and then encodes its query with
 * `toNodeUrl`, so a value a `{{var}}` brings into the query is encoded by the
 * query rule; the path has its own rule (`encode_path_variable_value`), and
 * a host or fragment value is not encoded.
 */
[[nodiscard]] std::string encode_at_url_component (std::string_view value, UrlComponent where);

} // namespace vayu::core
