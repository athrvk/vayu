/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/list_page.cpp
 * @brief The paging the whole-list routes share (issue #2443).
 */

#include "vayu/http/list_page.hpp"

#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/parse.hpp"

#include <algorithm>
#include <format>
#include <utility>

namespace vayu::http::routes {

namespace {

std::optional<std::string> param_if_present (const httplib::Request& req, const char* key) {
    if (!req.has_param (key)) {
        return std::nullopt;
    }
    return req.get_param_value (key);
}

} // namespace

bool ListPage::matches (std::string_view text) const {
    return needle.empty () ||
    vayu::utils::ascii_lower (text).find (needle) != std::string::npos;
}

std::pair<std::size_t, std::size_t> ListPage::window (std::size_t total) const {
    const std::size_t begin = std::min (offset, total);
    // `total - begin` first: `begin + limit` can wrap for an offset near the
    // top of `size_t`, which parse_list_page lets through.
    return { begin, begin + std::min (limit, total - begin) };
}

ListPageQuery list_page_query (const httplib::Request& req) {
    return { .q = param_if_present (req, "q"),
        .limit  = param_if_present (req, "limit"),
        .offset = param_if_present (req, "offset") };
}

std::expected<ListPage, RouteError> parse_list_page (const ListPageQuery& query) {
    ListPage page;
    if (query.limit) {
        const auto limit = vayu::utils::parse_number<std::size_t> (*query.limit);
        if (!limit || *limit == 0 || *limit > MAX_LIST_LIMIT) {
            // The typed value is not quoted back: it is decoded query text, and
            // invalid UTF-8 in it would make the error body's dump throw.
            return route_error (400,
            std::format ("'limit' must be an integer from 1 to {}", MAX_LIST_LIMIT),
            "invalid_limit");
        }
        page.limit = *limit;
    }
    if (query.offset) {
        const auto offset = vayu::utils::parse_number<std::size_t> (*query.offset);
        if (!offset) {
            return route_error (400, "'offset' must be a non-negative integer", "invalid_offset");
        }
        page.offset = *offset;
    }
    if (query.q) {
        page.needle = vayu::utils::ascii_lower (*query.q);
    }
    return page;
}

nlohmann::json list_pagination (const ListPage& page, std::size_t total, std::size_t returned) {
    const std::size_t begin = std::min (page.offset, total);
    return nlohmann::json{ { "total", total }, { "limit", page.limit },
        { "offset", page.offset }, { "returned", returned },
        { "hasMore", begin + returned < total } };
}

nlohmann::json
list_page_envelope (const ListPage& page, std::size_t total, nlohmann::json data) {
    const std::size_t returned = data.size ();
    nlohmann::json envelope;
    envelope["data"]       = std::move (data);
    envelope["pagination"] = list_pagination (page, total, returned);
    return envelope;
}

} // namespace vayu::http::routes
