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
 *        own rule (issue #1771), and how URL text is encoded by the component
 *        it lands in (issues #1773, #2465).
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
 * `QUERY_ENCODE_SET` (`postman_encode_sets.hpp`): the C0 controls, DEL and
 * every byte above `~` (each UTF-8 byte, `%XX` uppercase), space, `"`, `#`,
 * `'`, `<` and `>`. Before that, `postman-collection`'s `QueryParam.unparse`
 * (`normalizeParam`) encodes `&` in both parts and `=` in a key only - a value
 * cannot split a pair, because a parser splits on the first `=`. Every whole
 * `{{...}}` token (`/{{[^{}]*}}/`) is kept verbatim. `%` is never encoded, so
 * an escape already in the text passes and nothing is encoded twice.
 */
[[nodiscard]] std::string encode_query_component (std::string_view text, QueryPart part);

/**
 * Which part of a URL a point in its text sits in, for the rule text written
 * there is encoded by. `Head` is the scheme and the authority;
 * `HeadSeparator` is the head just after a `:` or `/`, where a `/` continues
 * a `://` rather than opening the path. `Path` starts at the first other `/`
 * in the head. A query key and a query value are one component: substituted
 * text is written by the whole-query rule, which encodes both alike.
 */
enum class UrlComponent : std::uint8_t {
    Head,
    HeadSeparator,
    Path,
    Query,
    Fragment
};

/**
 * @brief The component in force after @p text, read from @p from.
 *
 * In the head a `/` opens the path unless it follows a `:` or a `/`, so
 * `http://h/p`, `h:8080/p` and `{{base}}/p` all reach the path at the `/`
 * before `p`. The first `?` before the fragment opens the query and `#` opens
 * the fragment, which nothing closes. Every whole `{{...}}` token is skipped
 * and reads as one character of head text, so a separator inside a variable
 * name moves nothing - the same token rule `encode_query_component` keeps.
 */
[[nodiscard]] UrlComponent advance_url_component (std::string_view text, UrlComponent from);

/**
 * @brief @p value as it is written into a URL at @p where, which is advanced
 *        past it.
 *
 * Postman (postman-runtime 7.56.1 `resolveUrl`) substitutes a request's
 * variables into the URL *string*, parses that string again and encodes the
 * result with `toNodeUrl`. So a substituted value is URL text, not a row: its
 * `?` opens the query when it sits in the head or the path, its `#` opens the
 * fragment, its `/` makes more path segments and its `&` and `=` split pairs
 * as they would typed. The component moves before a byte is encoded, so a
 * `?` or `#` is always structure. Each component is then encoded by its
 * Postman set (`postman_encode_sets.hpp`): the path by `PATH_ENCODE_SET`
 * (`John Doe` in `/users/{{name}}` sends `John%20Doe`), the query by
 * `QUERY_ENCODE_SET` and the fragment by `FRAGMENT_ENCODE_SET`. The head is
 * written as it stands: Postman does not percent-encode a host, and a
 * non-ASCII one is dialled by its punycode name (`http::to_ascii_host`),
 * which a `%XX` would defeat. The per-row `normalizeParam` step (`&` in a
 * value, `=` in a key) belongs to `encode_query_component` and never applies
 * here. `%` passes, so nothing is encoded twice, and every whole `{{...}}`
 * token is kept verbatim.
 */
[[nodiscard]] std::string
encode_at_url_component (std::string_view value, UrlComponent& where);

/**
 * @brief Literal URL text at @p where, which is advanced past it, with only
 *        the bytes no request target may carry raw percent-encoded.
 *
 * `is_unsendable_url_byte` outside the head: space, the C0 controls, DEL and
 * every byte above `~`, so `/a b?q=é` sends `/a%20b?q=%C3%A9` (issue #2465).
 * Every other byte is kept, so a URL libcurl sent before is sent byte for
 * byte (`"`, `{`, `}`, `\`, `+` and an escape such as `%41` go out as typed),
 * and since every Postman set contains these bytes, text a substitution
 * already encoded passes unchanged. The head is kept for the reason
 * @ref encode_at_url_component keeps it, and every whole `{{...}}` token is
 * kept verbatim. `disableUrlEncoding` is the caller's to honour.
 */
[[nodiscard]] std::string
encode_literal_at_url_component (std::string_view text, UrlComponent& where);

} // namespace vayu::core
