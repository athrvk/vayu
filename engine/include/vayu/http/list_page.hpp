#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/list_page.hpp
 * @brief The `q` / `limit` / `offset` paging the whole-list routes share
 *        (`GET /requests`, `/collections`, `/cookies`, `/trash`; issue #2443).
 *
 * Opt-in by key presence: a call naming none of the three keys gets the route's
 * original answer, unchanged, so a client written before paging existed reads
 * what it always read. A call naming any of them gets the `{data, pagination}`
 * envelope `GET /runs` answers with.
 *
 * Filtering and slicing run in memory, over the vector the route already
 * fetched in its documented order: `total` is that filtered vector's size, so it
 * comes from the same read as the page and needs no second query or lock.
 */

#include <cstddef>
#include <expected>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/http/routes.hpp"

namespace vayu::http::routes {

/// The page size when the call names no `limit`.
inline constexpr std::size_t DEFAULT_LIST_LIMIT = 50;
/// The largest `limit` a call may name; past it is a 400, never a clamp.
inline constexpr std::size_t MAX_LIST_LIMIT = 500;

/// The three keys as the query string carried them: absent is `nullopt`,
/// present-and-empty is `""`. Unparsed, so the core decides what each means.
struct ListPageQuery {
    // NOLINTBEGIN(readability-redundant-member-init): a designated
    // initializer naming fewer members than the struct holds is a warning
    // (missing-designated-field-initializers) unless each member has one.
    std::optional<std::string> q{};
    std::optional<std::string> limit{};
    std::optional<std::string> offset{};
    // NOLINTEND(readability-redundant-member-init)

    /// Whether the call asked for the paged answer at all.
    [[nodiscard]] bool present () const {
        return q.has_value () || limit.has_value () || offset.has_value ();
    }
};

/// A validated page request.
struct ListPage {
    /// `q` already folded through `ascii_lower`; empty matches every row.
    std::string needle{}; // NOLINT(readability-redundant-member-init): see ListPageQuery
    std::size_t limit  = DEFAULT_LIST_LIMIT;
    std::size_t offset = 0;

    /// Whether @p text contains `q`, ASCII case folded. Only `A`-`Z` fold, so a
    /// non-ASCII letter matches only in the case it was typed.
    [[nodiscard]] bool matches (std::string_view text) const;

    /// The `[begin, end)` of a @p total -row filtered list this page covers,
    /// both clamped to @p total, so an offset past the end is an empty page.
    [[nodiscard]] std::pair<std::size_t, std::size_t> window (std::size_t total) const;
};

/// The three keys of @p req, by presence.
ListPageQuery list_page_query (const httplib::Request& req);

/**
 * @p query validated: `limit` an integer from 1 to `MAX_LIST_LIMIT` (absent is
 * `DEFAULT_LIST_LIMIT`), `offset` a non-negative integer (absent is 0), each
 * parsed whole, so `5abc`, `-1`, `+5` and an empty value are refused. A refusal
 * is a 400 coded `invalid_limit` or `invalid_offset`.
 */
std::expected<ListPage, RouteError> parse_list_page (const ListPageQuery& query);

/// `{total, limit, offset, returned, hasMore}` for a page of @p returned rows
/// out of @p total matches; `offset` and `limit` echo what @p page asked for.
nlohmann::json list_pagination (const ListPage& page, std::size_t total, std::size_t returned);

/// `{data: @p data, pagination}`: @p data is the page's rows, `total` the rows
/// that matched before the page was cut.
nlohmann::json
list_page_envelope (const ListPage& page, std::size_t total, nlohmann::json data);

/**
 * The envelope for @p rows, already in the route's order: the rows
 * @p is_match keeps, cut to @p page, each written by @p to_json. Only the
 * page's rows are serialized.
 */
template <typename Row, typename IsMatch, typename ToJson>
nlohmann::json
list_page_of (const ListPage& page, std::vector<Row> rows, IsMatch is_match, ToJson to_json) {
    std::erase_if (rows, [&is_match] (const Row& row) { return !is_match (row); });
    const auto [begin, end] = page.window (rows.size ());
    nlohmann::json data     = nlohmann::json::array ();
    for (std::size_t i = begin; i < end; ++i) {
        data.push_back (to_json (rows.at (i)));
    }
    return list_page_envelope (page, rows.size (), std::move (data));
}

} // namespace vayu::http::routes
