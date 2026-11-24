/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file mcp_fixture_server_test.cpp
 * @brief `McpFixtureServer`'s discovery and list methods (#3838): the pages,
 *        the cursors it records, the legacy answers to `server/discover`.
 *
 * A route that imports from a live MCP server is tested against this fixture,
 * so what it answers is pinned here rather than inferred from that route's
 * failures.
 */

#include <gtest/gtest.h>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

#include "mcp_fixture_server.hpp"

namespace {

using nlohmann::json;
using vayu::tests::McpDiscovery;
using vayu::tests::McpFixtureServer;
using vayu::tests::McpReplyOutcome;

json tool (const std::string& name) {
    return { { "name", name }, { "description", "the " + name + " tool" },
        { "inputSchema", { { "type", "object" } } } };
}

json tools_named (std::size_t count) {
    json tools = json::array ();
    for (std::size_t at = 0; at < count; ++at) {
        tools.push_back (tool ("tool_" + std::to_string (at)));
    }
    return tools;
}

class McpFixtureServerTest : public ::testing::Test {
    protected:
    httplib::Result send (const std::string& method, const json& params = json::object ()) {
        const json body{ { "jsonrpc", "2.0" }, { "id", 1 },
            { "method", method }, { "params", params } };
        return send_raw (method, body.dump ());
    }

    httplib::Result send_raw (const std::string& method_header, const std::string& body) {
        httplib::Client client ("127.0.0.1", server_.port ());
        return client.Post ("/mcp",
        { { "Accept", "application/json, text/event-stream" },
        { "Mcp-Method", method_header }, { "Authorization", "Bearer secret-token" } },
        body, "application/json");
    }

    /// The JSON-RPC response in @p reply, from a JSON body or the last frame
    /// of an event stream.
    static json response_of (const httplib::Result& reply) {
        const std::string content_type =
        reply->get_header_value ("Content-Type");
        if (content_type.find ("text/event-stream") == std::string::npos) {
            return json::parse (reply->body);
        }
        const std::size_t data = reply->body.rfind ("data: ");
        const std::size_t end  = reply->body.find ("\n\n", data);
        return json::parse (reply->body.substr (data + 6, end - data - 6));
    }

    McpFixtureServer server_;
};

TEST_F (McpFixtureServerTest, ToolsListPagesAndNamesTheNextCursor) {
    server_.set_tools (tools_named (5), 2);

    const auto first = send ("tools/list");
    ASSERT_TRUE (first);
    const json first_result = response_of (first).at ("result");
    EXPECT_EQ (first_result.at ("tools").size (), 2U);
    EXPECT_EQ (first_result.at ("tools").at (0).at ("name"), "tool_0");
    const std::string second_cursor = first_result.at ("nextCursor");

    const auto second = send ("tools/list", { { "cursor", second_cursor } });
    ASSERT_TRUE (second);
    const json second_result = response_of (second).at ("result");
    EXPECT_EQ (second_result.at ("tools").at (0).at ("name"), "tool_2");
    const std::string last_cursor = second_result.at ("nextCursor");

    const auto last = send ("tools/list", { { "cursor", last_cursor } });
    ASSERT_TRUE (last);
    const json last_result = response_of (last).at ("result");
    EXPECT_EQ (last_result.at ("tools").size (), 1U);
    EXPECT_FALSE (last_result.contains ("nextCursor"));

    const std::vector<std::optional<std::string>> expected{ std::nullopt,
        second_cursor, last_cursor };
    EXPECT_EQ (server_.tools_list_cursors (), expected);
    EXPECT_NE (second_cursor, last_cursor);
}

TEST_F (McpFixtureServerTest, ToolsListWithoutAPageSizeAnswersEveryToolInOnePage) {
    server_.set_tools (tools_named (3));

    const auto reply = send ("tools/list");
    ASSERT_TRUE (reply);
    const json result = response_of (reply).at ("result");
    EXPECT_EQ (result.at ("tools").size (), 3U);
    EXPECT_FALSE (result.contains ("nextCursor"));
}

TEST_F (McpFixtureServerTest, ACursorTheFixtureNeverIssuedIsRefused) {
    server_.set_tools (tools_named (5), 2);

    for (const std::string cursor : { "garbage", "cursor-1", "cursor-99", "cursor-0" }) {
        const auto reply = send ("tools/list", { { "cursor", cursor } });
        ASSERT_TRUE (reply) << cursor;
        const json response = response_of (reply);
        EXPECT_FALSE (response.contains ("result")) << cursor;
        EXPECT_EQ (response.at ("error").at ("code"), -32602) << cursor;
    }
}

TEST_F (McpFixtureServerTest, TheFirstToolsPageArrivesAsAnEventStreamWhenAsked) {
    server_.set_tools (tools_named (3), 2);
    server_.first_tools_page_as_event_stream ();

    const auto first = send ("tools/list");
    ASSERT_TRUE (first);
    EXPECT_NE (first->get_header_value ("Content-Type").find ("text/event-stream"),
    std::string::npos);
    const json first_result = response_of (first).at ("result");
    EXPECT_EQ (first_result.at ("tools").size (), 2U);

    const auto second =
    send ("tools/list", { { "cursor", first_result.at ("nextCursor") } });
    ASSERT_TRUE (second);
    EXPECT_NE (second->get_header_value ("Content-Type").find ("application/json"),
    std::string::npos);
    EXPECT_EQ (response_of (second).at ("result").at ("tools").size (), 1U);
}

TEST_F (McpFixtureServerTest, DiscoverAnswersAModernResultByDefault) {
    const auto reply = send ("server/discover");
    ASSERT_TRUE (reply);
    EXPECT_EQ (reply->status, 200);
    const json result = response_of (reply).at ("result");
    EXPECT_TRUE (result.at ("supportedVersions").is_array ());
    EXPECT_TRUE (result.at ("serverInfo").contains ("name"));
}

TEST_F (McpFixtureServerTest, DiscoverAsALegacyServerRefusesInEitherShape) {
    server_.discover_as (McpDiscovery::MethodNotFound);
    const auto not_found = send ("server/discover");
    ASSERT_TRUE (not_found);
    EXPECT_EQ (response_of (not_found).at ("error").at ("code"), -32601);

    server_.discover_as (McpDiscovery::LegacyBadRequest);
    const auto bad_request = send ("server/discover");
    ASSERT_TRUE (bad_request);
    EXPECT_EQ (bad_request->status, 400);
    EXPECT_TRUE (json::parse (bad_request->body, nullptr, false).is_discarded ());

    // Only `server/discover` is refused; the rest of the server still answers.
    server_.set_tools (tools_named (1));
    const auto listed = send ("tools/list");
    ASSERT_TRUE (listed);
    EXPECT_EQ (response_of (listed).at ("result").at ("tools").size (), 1U);
}

TEST_F (McpFixtureServerTest, ResourcesTemplatesAndPromptsAnswerWhatWasSet) {
    server_.set_resources (json::array ({ { { "uri", "file:///a" }, { "name", "a" } } }));
    server_.set_resource_templates (
    json::array ({ { { "uriTemplate", "file:///{x}" }, { "name", "x" } } }));
    server_.set_prompts (json::array ({ { { "name", "greet" } } }));

    const auto resources = send ("resources/list");
    const auto templates = send ("resources/templates/list");
    const auto prompts   = send ("prompts/list");
    ASSERT_TRUE (resources);
    ASSERT_TRUE (templates);
    ASSERT_TRUE (prompts);
    EXPECT_EQ (response_of (resources).at ("result").at ("resources").at (0).at ("uri"),
    "file:///a");
    EXPECT_EQ (
    response_of (templates).at ("result").at ("resourceTemplates").at (0).at ("uriTemplate"),
    "file:///{x}");
    EXPECT_EQ (
    response_of (prompts).at ("result").at ("prompts").at (0).at ("name"), "greet");
}

TEST_F (McpFixtureServerTest, EveryRequestIsRecordedWithItsMethodBodyAndBearer) {
    ASSERT_TRUE (send ("server/discover"));
    ASSERT_TRUE (send ("prompts/list"));
    ASSERT_TRUE (send ("tools/list"));

    const std::vector<std::string> expected{ "server/discover", "prompts/list", "tools/list" };
    EXPECT_EQ (server_.methods (), expected);
    const auto calls = server_.calls ();
    ASSERT_EQ (calls.size (), 3U);
    EXPECT_EQ (calls.at (1).authorization, "Bearer secret-token");
    EXPECT_EQ (json::parse (calls.at (1).body).at ("method"), "prompts/list");
    EXPECT_EQ (server_.requests (), 3U);
}

TEST_F (McpFixtureServerTest, AListMethodWhoseMethodHeaderDisagreesIsAHeaderMismatch) {
    const json body{ { "jsonrpc", "2.0" }, { "id", 1 }, { "method", "tools/list" } };
    const auto reply = send_raw ("prompts/list", body.dump ());
    ASSERT_TRUE (reply);
    EXPECT_EQ (reply->status, 400);
    EXPECT_EQ (response_of (reply).at ("error").at ("code"), -32020);
}

TEST_F (McpFixtureServerTest, ACallOutsideTheKnownMethodsKeepsTheToolCallAnswer) {
    const auto reply = send ("ping");
    ASSERT_TRUE (reply);
    EXPECT_EQ (
    response_of (reply).at ("result").at ("content").at (0).at ("text"),
    std::string (vayu::tests::MCP_RESULT_TEXT));
}

TEST_F (McpFixtureServerTest, AReplyOutcomeStillAppliesToAListMethod) {
    server_.set_tools (tools_named (2));
    server_.reply_with (vayu::tests::McpReplyShape::Json, McpReplyOutcome::RpcError);

    const auto reply = send ("tools/list");
    ASSERT_TRUE (reply);
    EXPECT_EQ (response_of (reply).at ("error").at ("code"), -32602);
}

} // namespace
