#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief How a query row's key and value are written into a URL, by Postman's
 *        own rule (#1771); how a query is read back into pairs; how URL text is
 *        encoded by the component it lands in (#1773, #2465); and how a URL's
 *        query is read into a request's Params rows (#3551).
 *
 * Pinned to the app's copy (`request-builder/utils/query-encoding.ts`) by
 * `tests/fixtures/query-encoding-conformance.json`, read by
 * `query_encoding_test.cpp` and `query-encoding.conformance.test.ts`.
 */

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

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

/// One `key[=value]` pair of a raw query, as written and not decoded.
struct QueryPair {
    std::string key;
    std::string value;
    /// No `=` at all (`a`), which is not the empty value of `a=`.
    bool valueless = false;
};

/**
 * @brief @p query (the text after `?`, before any `#`) as its pairs, in order.
 *
 * Split on `&` and then at the first `=`, as Postman's `QueryParam.parse`
 * reads it (issue #1771); an empty pair (`a=1&&b=2`) is dropped. Nothing is
 * decoded: a pair holds raw query text, so writing it back is byte for byte,
 * where decoding first would turn `%2B` into a `+` a server reads as a space.
 * The one reader of a query string, for the Postman import and the Postman
 * export alike, so a row and the URL it came from cannot disagree about where
 * a pair ends.
 */
[[nodiscard]] std::vector<QueryPair> split_query_pairs (std::string_view query);

/**
 * @brief The pairs of @p url's query as the engine sends them.
 *
 * The URL is cut at its first `#` and then at the first `?` before it, and
 * what lies between is read by `split_query_pairs`. Every whole `{{...}}`
 * token is opaque (`mask_template_tokens`), so `{{a#b}}` opens no fragment and
 * `{{p&q}}` splits no pair - the cut the app's `splitQuery` makes.
 */
[[nodiscard]] std::vector<QueryPair> url_query_pairs (std::string_view url);

/**
 * @brief @p params, a request's Params rows, with its query rows brought into
 *        line with @p url's query (issue #3551).
 *
 * `url` is what the engine sends, so a write that states it and no rows makes
 * the enabled query rows follow its pairs in URL order: an enabled row claims
 * the first unclaimed pair whose key its own key writes, and keeps every other
 * member; a pair no row claims becomes a fresh `{key, value, enabled}` row (and
 * `valueless` for a bare `key`); an enabled row the URL no longer carries is
 * dropped. A disabled row is invisible in a URL, so it is kept, after the
 * nearest enabled row before it that survives, or leading. A path row
 * (`"in": "path"`) is left alone. The app's `mergeParamsFromUrl` is the same
 * rule for the query rows.
 *
 * A row's key and value are compared as the query join writes them, under any
 * of the three `QueryEncoding`s, because a row does not record which built its
 * URL: an OpenAPI import's `a b` agrees with `a%20b`. A claimed row that
 * already writes its pair is kept as it is; one that does not takes the pair's
 * text, as a fresh row would. When every query row agrees and keeps its place,
 * @p params comes back unchanged, so a URL-only write that leaves the query
 * alone rewrites nothing. A @p params that is not an array has no rows.
 */
[[nodiscard]] nlohmann::json
reconcile_query_rows (const nlohmann::json& params, std::string_view url);

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

} // namespace vayu::core
