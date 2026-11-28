/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/mcp_list_pages_test.cpp
 * @brief The cursor loop `POST /import/mcp` and `assert.snapshot` share
 *        (#3824): which bound ends a list and what it reports, against a sender
 *        that answers scripted pages. The import's own refusal texts are
 *        `import_mcp_test.cpp`'s.
 */

#include <gtest/gtest.h>

#include <cstddef>
#include <expected>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/mcp_list_pages.hpp"

namespace {

using nlohmann::ordered_json;
using vayu::core::collect_mcp_list_pages;
using vayu::core::McpListFailureKind;
using vayu::core::McpPageFailure;
using vayu::core::McpPageSender;

constexpr std::size_t MAX_PAGES = 5;
constexpr std::size_t MAX_ITEMS = 100;

/// A page of `tools` entries named by @p names, pointing at @p next when set.
ordered_json tools_page (const std::vector<std::string>& names,
std::optional<ordered_json> next = std::nullopt) {
    ordered_json tools = ordered_json::array ();
    for (const auto& name : names) {
        tools.push_back (ordered_json{ { "name", name } });
    }
    ordered_json page = { { "tools", std::move (tools) } };
    if (next) {
        page["nextCursor"] = std::move (*next);
    }
    return page;
}

/// @p page as a one-page script: braces around a single JSON value would read
/// as a JSON array.
std::vector<ordered_json> one_page_script (ordered_json page) {
    std::vector<ordered_json> script;
    script.push_back (std::move (page));
    return script;
}

/// A sender that answers @p script in order, one page a call, and notes the
/// cursor each call carried. Past the script it fails the test and answers
/// as a server with no list would.
class ScriptedServer {
    public:
    explicit ScriptedServer (std::vector<ordered_json> script)
    : script_ (std::move (script)) {
    }

    McpPageSender sender () {
        return [this] (const std::optional<std::string>& cursor) -> std::expected<ordered_json, McpPageFailure> {
            cursors_.push_back (cursor);
            if (next_ >= script_.size ()) {
                ADD_FAILURE () << "the loop asked for page " << next_ + 1
                               << " of a script of " << script_.size ();
                return ordered_json ();
            }
            return script_.at (next_++);
        };
    }

    const std::vector<std::optional<std::string>>& cursors () const {
        return cursors_;
    }

    private:
    std::vector<ordered_json> script_;
    std::size_t next_ = 0;
    std::vector<std::optional<std::string>> cursors_;
};

} // namespace

// Mutation check: return after the first page and only the first page's
// entries come back, with one cursor sent.
TEST (McpListPages, EveryPageIsMergedInOrderFollowingEachCursor) {
    ScriptedServer server ({ tools_page ({ "a", "b" }, "c1"),
    tools_page ({ "c" }, "c2"), tools_page ({ "d" }) });
    std::size_t items = 0;
    const auto list =
    collect_mcp_list_pages (server.sender (), "tools", MAX_PAGES, items, MAX_ITEMS);
    ASSERT_HAS_VALUE (list);
    EXPECT_EQ (list->rows,
    ordered_json::parse (R"([{"name":"a"},{"name":"b"},{"name":"c"},{"name":"d"}])"));
    const std::vector<std::optional<std::string>> expected{ std::nullopt, "c1", "c2" };
    EXPECT_EQ (server.cursors (), expected);
}

// Mutation check: never increment `pages_sent` and every count is 0.
TEST (McpListPages, PagesSentCountsEveryCallTheSenderMade) {
    ScriptedServer one_page (one_page_script (tools_page ({ "a" })));
    std::size_t items = 0;
    const auto single =
    collect_mcp_list_pages (one_page.sender (), "tools", MAX_PAGES, items, MAX_ITEMS);
    ASSERT_HAS_VALUE (single);
    EXPECT_EQ (single->pages_sent, 1U);

    ScriptedServer three_pages (
    { tools_page ({ "a" }, "c1"), tools_page ({ "b" }, "c2"), tools_page ({ "c" }) });
    const auto triple = collect_mcp_list_pages (
    three_pages.sender (), "tools", MAX_PAGES, items, MAX_ITEMS);
    ASSERT_HAS_VALUE (triple);
    EXPECT_EQ (triple->pages_sent, 3U);
}

// Mutation check: treat an empty or non-string `nextCursor` as a cursor and
// the loop asks for a second page the script does not have.
TEST (McpListPages, AnEmptyOrNonStringNextCursorEndsTheList) {
    const std::vector<ordered_json> ends{ ordered_json (""), ordered_json (7),
        ordered_json (nullptr), ordered_json::object () };
    for (const auto& end : ends) {
        ScriptedServer server (one_page_script (
        tools_page ({ "a" }, std::optional<ordered_json> (std::in_place, end))));
        std::size_t items = 0;
        const auto list   = collect_mcp_list_pages (
        server.sender (), "tools", MAX_PAGES, items, MAX_ITEMS);
        ASSERT_HAS_VALUE (list) << end.dump ();
        EXPECT_EQ (list->rows.size (), 1U) << end.dump ();
        EXPECT_EQ (list->pages_sent, 1U) << end.dump ();
    }
}

// Mutation check: raise the loop's bound by one and the failure's
// `pages_sent` is `MAX_PAGES + 1` and the sender is called once more.
TEST (McpListPages, ACursorAfterTheLastAllowedPageIsThePageCap) {
    std::vector<ordered_json> script;
    script.reserve (MAX_PAGES + 1);
    for (std::size_t page = 0; page < MAX_PAGES + 1; ++page) {
        script.push_back (
        tools_page ({ "t" + std::to_string (page) }, "c" + std::to_string (page)));
    }
    ScriptedServer server (std::move (script));
    std::size_t items = 0;
    const auto list =
    collect_mcp_list_pages (server.sender (), "tools", MAX_PAGES, items, MAX_ITEMS);
    ASSERT_FALSE (list.has_value ());
    EXPECT_EQ (list.error ().kind, McpListFailureKind::PageCapReached);
    EXPECT_EQ (list.error ().pages_sent, MAX_PAGES);
    EXPECT_EQ (server.cursors ().size (), MAX_PAGES);
}

// Mutation check: end the loop one page early (`<` for `<=` on the cap) and
// a list of exactly `MAX_PAGES` pages fails.
TEST (McpListPages, AListOfExactlyTheMaximumPagesSucceeds) {
    std::vector<ordered_json> script;
    script.reserve (MAX_PAGES);
    for (std::size_t page = 0; page + 1 < MAX_PAGES; ++page) {
        script.push_back (tools_page ({ "t" }, "c" + std::to_string (page)));
    }
    script.push_back (tools_page ({ "last" }));
    ScriptedServer server (std::move (script));
    std::size_t items = 0;
    const auto list =
    collect_mcp_list_pages (server.sender (), "tools", MAX_PAGES, items, MAX_ITEMS);
    ASSERT_HAS_VALUE (list);
    EXPECT_EQ (list->pages_sent, MAX_PAGES);
}

// Mutation check: drop the `sent_cursors` test and the loop asks for the
// repeated cursor's page again, so the sender is called a third time.
TEST (McpListPages, ACursorHandedBackASecondTimeFailsAtTheFirstRepeat) {
    ScriptedServer server ({ tools_page ({ "a" }, "c1"),
    tools_page ({ "b" }, "c2"), tools_page ({ "c" }, "c1") });
    std::size_t items = 0;
    const auto list =
    collect_mcp_list_pages (server.sender (), "tools", MAX_PAGES, items, MAX_ITEMS);
    ASSERT_FALSE (list.has_value ());
    EXPECT_EQ (list.error ().kind, McpListFailureKind::RepeatedCursor);
    EXPECT_EQ (list.error ().pages_sent, 3U);
    EXPECT_EQ (server.cursors ().size (), 3U);
}

// Mutation check: record a sent cursor only from the third page on and an
// echoed cursor is not caught.
TEST (McpListPages, AServerThatEchoesTheCursorItWasSentIsRefusedOnTheSecondPage) {
    ScriptedServer server ({ tools_page ({ "a" }, "same"), tools_page ({ "b" }, "same") });
    std::size_t items = 0;
    const auto list =
    collect_mcp_list_pages (server.sender (), "tools", MAX_PAGES, items, MAX_ITEMS);
    ASSERT_FALSE (list.has_value ());
    EXPECT_EQ (list.error ().kind, McpListFailureKind::RepeatedCursor);
    EXPECT_EQ (list.error ().pages_sent, 2U);
}

// Mutation check: compare with `>=` and a list of exactly the cap fails;
// drop the comparison and the list past it succeeds.
TEST (McpListPages, EntriesPastTheBudgetFailAndEntriesAtItDoNot) {
    ScriptedServer at_cap (one_page_script (tools_page ({ "a", "b", "c" })));
    std::size_t items = 0;
    const auto fits =
    collect_mcp_list_pages (at_cap.sender (), "tools", MAX_PAGES, items, 3);
    ASSERT_HAS_VALUE (fits);
    EXPECT_EQ (items, 3U);

    ScriptedServer over_cap (
    { tools_page ({ "a", "b" }, "c1"), tools_page ({ "c", "d" }) });
    items = 0;
    const auto over =
    collect_mcp_list_pages (over_cap.sender (), "tools", MAX_PAGES, items, 3);
    ASSERT_FALSE (over.has_value ());
    EXPECT_EQ (over.error ().kind, McpListFailureKind::ItemsOverBudget);
    EXPECT_EQ (over.error ().pages_sent, 2U);
}

// Mutation check: count against a counter local to the call and a second list
// of an import starts again from zero, so the shared cap never trips.
TEST (McpListPages, TheBudgetCounterCarriesAcrossListsThatShareIt) {
    std::size_t items = 0;
    ScriptedServer first (one_page_script (tools_page ({ "a", "b" })));
    ASSERT_HAS_VALUE (
    collect_mcp_list_pages (first.sender (), "tools", MAX_PAGES, items, 3));
    EXPECT_EQ (items, 2U);

    ScriptedServer second (one_page_script (tools_page ({ "c", "d" })));
    const auto list =
    collect_mcp_list_pages (second.sender (), "tools", MAX_PAGES, items, 3);
    ASSERT_FALSE (list.has_value ());
    EXPECT_EQ (list.error ().kind, McpListFailureKind::ItemsOverBudget);
    EXPECT_EQ (items, 4U);
}

// Mutation check: accept a list member that is not an array and the
// `"not an array"` case is read as entries.
TEST (McpListPages, APageWithNoListArrayIsAMissingList) {
    const std::vector<ordered_json> pages{ ordered_json (nullptr),
        ordered_json::array (), ordered_json ("text"), ordered_json::object (),
        ordered_json{ { "tools", "not an array" } },
        ordered_json{ { "prompts", ordered_json::array () } } };
    for (const auto& page : pages) {
        ScriptedServer server (one_page_script (page));
        std::size_t items = 0;
        const auto list   = collect_mcp_list_pages (
        server.sender (), "tools", MAX_PAGES, items, MAX_ITEMS);
        ASSERT_FALSE (list.has_value ()) << page.dump ();
        EXPECT_EQ (list.error ().kind, McpListFailureKind::MissingList) << page.dump ();
        EXPECT_EQ (list.error ().pages_sent, 1U) << page.dump ();
    }
}

// Mutation check: judge the list member on the first page only and a later
// page without it is not reported.
TEST (McpListPages, ALaterPageWithNoListFailsTheWholeList) {
    ScriptedServer server ({ tools_page ({ "a" }, "c1"), ordered_json::object () });
    std::size_t items = 0;
    const auto list =
    collect_mcp_list_pages (server.sender (), "tools", MAX_PAGES, items, MAX_ITEMS);
    ASSERT_FALSE (list.has_value ());
    EXPECT_EQ (list.error ().kind, McpListFailureKind::MissingList);
    EXPECT_EQ (list.error ().pages_sent, 2U);
}

// Mutation check: replace the sender's failure with a default one and the
// status and message the caller built are lost.
TEST (McpListPages, ASenderFailureIsPassedThroughWithItsStatusAndMessage) {
    std::size_t calls = 0;
    const McpPageSender send =
    [&] (const std::optional<std::string>& cursor) -> std::expected<ordered_json, McpPageFailure> {
        if (++calls == 1) {
            EXPECT_FALSE (cursor.has_value ());
            return tools_page ({ "a" }, "c1");
        }
        return std::unexpected (McpPageFailure{ .status = 413, .message = "too large" });
    };
    std::size_t items = 0;
    const auto list = collect_mcp_list_pages (send, "tools", MAX_PAGES, items, MAX_ITEMS);
    ASSERT_FALSE (list.has_value ());
    EXPECT_EQ (list.error ().kind, McpListFailureKind::SendFailed);
    EXPECT_EQ (list.error ().send.status, 413);
    EXPECT_EQ (list.error ().send.message, "too large");
    EXPECT_EQ (list.error ().pages_sent, 2U);
    EXPECT_EQ (calls, 2U);
}

// Mutation check: read `tools` regardless of `key` and a `prompts` list is
// reported missing.
TEST (McpListPages, TheListKeyNamesTheMemberThatHoldsTheEntries) {
    const ordered_json page = { { "prompts",
    ordered_json::array ({ ordered_json{ { "name", "p" } } }) } };
    ScriptedServer server (one_page_script (page));
    std::size_t items = 0;
    const auto list =
    collect_mcp_list_pages (server.sender (), "prompts", MAX_PAGES, items, MAX_ITEMS);
    ASSERT_HAS_VALUE (list);
    EXPECT_EQ (list->rows.size (), 1U);
}
