/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/list_page_test.cpp
 * @brief The `q` / `limit` / `offset` parsing and envelope the whole-list
 *        routes share (`http/list_page.hpp`, issue #2443).
 *
 * The routes' own tests (requests_route_test, collections_route_test,
 * trash_test, cookie_jar_test) drive these through each core; this file pins
 * the edges once, without a database.
 */

#include <gtest/gtest.h>

#include <cstddef>
#include <limits>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/http/list_page.hpp"

namespace {

using vayu::http::routes::DEFAULT_LIST_LIMIT;
using vayu::http::routes::list_page_of;
using vayu::http::routes::ListPage;
using vayu::http::routes::ListPageQuery;
using vayu::http::routes::MAX_LIST_LIMIT;
using vayu::http::routes::parse_list_page;

std::string error_code_of (const ListPageQuery& query) {
    const auto page = parse_list_page (query);
    if (page) {
        return "accepted";
    }
    EXPECT_EQ (page.error ().status, 400);
    return page.error ().body["error"]["code"].get<std::string> ();
}

TEST (ListPageQuery, AnyOfTheThreeKeysAsksForThePage) {
    EXPECT_FALSE (ListPageQuery{}.present ());
    EXPECT_TRUE ((ListPageQuery{ .q = "" }.present ()));
    EXPECT_TRUE ((ListPageQuery{ .limit = "5" }.present ()));
    EXPECT_TRUE ((ListPageQuery{ .offset = "0" }.present ()));
}

TEST (ListPageQuery, ReadsTheKeysByPresence) {
    httplib::Request req;
    req.params.emplace ("q", "");
    req.params.emplace ("limit", "7");
    const auto query = vayu::http::routes::list_page_query (req);
    EXPECT_EQ (query.q, std::optional<std::string> (""));
    EXPECT_EQ (query.limit, std::optional<std::string> ("7"));
    EXPECT_FALSE (query.offset.has_value ());
}

TEST (ParseListPage, AbsentLimitAndOffsetAreTheDefaults) {
    const auto page = parse_list_page (ListPageQuery{ .q = "Users" });
    ASSERT_HAS_VALUE (page);
    EXPECT_EQ (page->limit, DEFAULT_LIST_LIMIT);
    EXPECT_EQ (page->offset, 0U);
    EXPECT_EQ (page->needle, "users");
}

TEST (ParseListPage, TakesTheWholeRangeOfLimit) {
    for (const char* limit : { "1", "50", "500" }) {
        const auto page = parse_list_page (ListPageQuery{ .limit = limit });
        ASSERT_HAS_VALUE (page) << limit;
        EXPECT_EQ (page->limit, std::stoul (limit));
    }
}

TEST (ParseListPage, RefusesALimitThatIsNotAnIntegerFromOneToTheCap) {
    for (const char* limit : { "0", "501", "-1", "5abc", "", "+5", " 5", "1.5",
         "abc", "99999999999999999999999" }) {
        EXPECT_EQ (error_code_of (ListPageQuery{ .limit = limit }), "invalid_limit") << limit;
    }
    const auto refused = parse_list_page (ListPageQuery{ .limit = "0" });
    ASSERT_FALSE (refused.has_value ());
    EXPECT_EQ (refused.error ().body["error"]["message"],
    "'limit' must be an integer from 1 to " + std::to_string (MAX_LIST_LIMIT));
}

TEST (ParseListPage, RefusesAnOffsetThatIsNotANonNegativeInteger) {
    for (const char* offset : { "-1", "5abc", "", "+5", "1e3" }) {
        EXPECT_EQ (error_code_of (ListPageQuery{ .offset = offset }), "invalid_offset")
        << offset;
    }
    const auto page = parse_list_page (ListPageQuery{ .offset = "0" });
    ASSERT_HAS_VALUE (page);
    EXPECT_EQ (page->offset, 0U);
}

TEST (ListPage, MatchesASubstringUnderTheAsciiFoldOnly) {
    const auto page = parse_list_page (ListPageQuery{ .q = "uSeR" });
    ASSERT_HAS_VALUE (page);
    EXPECT_TRUE (page->matches ("Get USER by id"));
    EXPECT_TRUE (page->matches ("user"));
    EXPECT_FALSE (page->matches ("use r"));
    EXPECT_FALSE (page->matches (""));

    // Only A-Z fold: the two spellings of a non-ASCII letter stay distinct.
    const auto accented =
    parse_list_page (ListPageQuery{ .q = "\xC3\x89t\xC3\xA9" });
    ASSERT_HAS_VALUE (accented);
    EXPECT_TRUE (accented->matches ("\xC3\x89t\xC3\xA9 report"));
    EXPECT_FALSE (accented->matches ("\xC3\xA9t\xC3\xA9 report"));

    EXPECT_TRUE (ListPage{}.matches ("anything"));
    EXPECT_TRUE (ListPage{}.matches (""));
}

TEST (ListPage, WindowIsClampedToTheRows) {
    using Window = std::pair<std::size_t, std::size_t>;
    EXPECT_EQ ((ListPage{ .limit = 2, .offset = 1 }.window (5)), (Window{ 1, 3 }));
    EXPECT_EQ ((ListPage{ .limit = 50, .offset = 3 }.window (5)), (Window{ 3, 5 }));
    EXPECT_EQ ((ListPage{ .limit = 50, .offset = 9 }.window (5)), (Window{ 5, 5 }));
    // An offset near the top of size_t must not wrap `offset + limit`.
    EXPECT_EQ (
    (
    ListPage{ .limit = 500, .offset = std::numeric_limits<std::size_t>::max () }.window (5)),
    (Window{ 5, 5 }));
}

TEST (ListPageEnvelope, CountsWhatMatchedAndSaysWhetherMoreFollows) {
    const auto envelope = list_page_of (
    ListPage{ .limit = 2, .offset = 1 }, std::vector<int>{ 1, 2, 3, 4, 5, 6 },
    [] (int n) { return n != 4; }, [] (int n) { return nlohmann::json (n); });
    EXPECT_EQ (envelope["data"], nlohmann::json ({ 2, 3 }));
    EXPECT_EQ (envelope["pagination"],
    (nlohmann::json{ { "total", 5 }, { "limit", 2 }, { "offset", 1 },
    { "returned", 2 }, { "hasMore", true } }));

    const auto last = list_page_of (
    ListPage{ .limit = 2, .offset = 3 }, std::vector<int>{ 1, 2, 3, 4, 5 },
    [] (int) { return true; }, [] (int n) { return nlohmann::json (n); });
    EXPECT_EQ (last["data"], nlohmann::json ({ 4, 5 }));
    EXPECT_FALSE (last["pagination"]["hasMore"].get<bool> ());

    const auto past = list_page_of (
    ListPage{ .limit = 2, .offset = 40 }, std::vector<int>{ 1, 2 },
    [] (int) { return true; }, [] (int n) { return nlohmann::json (n); });
    EXPECT_EQ (past["data"], nlohmann::json::array ());
    EXPECT_EQ (past["pagination"]["offset"], 40);
    EXPECT_EQ (past["pagination"]["returned"], 0);
    EXPECT_FALSE (past["pagination"]["hasMore"].get<bool> ());
}

} // namespace
