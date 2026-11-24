/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/import_mcp_test.cpp
 * @brief `POST /import/mcp` (#3838): a live MCP server's tools, resources and
 *        prompts as the tree `POST /import/parse` answers.
 *
 * Driven through the route's testable core against `McpFixtureServer`, which
 * checks every call's derived headers against its body the way a real server
 * does, so a call the engine framed wrongly fails here as it would there.
 */

// First, before anything that includes <httplib.h>: see the header.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "engine_port_stand_in.hpp"
#include "mcp_fixture_server.hpp"
#include "mcp_port_stand_in.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/core/mcp_import.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/mcp_reply.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/utils/ordered_json.hpp"

namespace vayu::http::routes {
// Defined in import_mcp.cpp; returns {http_status, json_body}. No server owns
// these calls, so nothing cancels them.
std::pair<int, nlohmann::json> import_mcp_response (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);
std::optional<std::pair<vayu::http::ClientConfig, vayu::Request>>
import_mcp_call_shape (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);
// Defined in import.cpp.
std::pair<int, nlohmann::json>
import_apply_response (vayu::db::Database& db, const nlohmann::json& body);
} // namespace vayu::http::routes

namespace {

using nlohmann::json;
using vayu::tests::McpDiscovery;
using vayu::tests::McpFixtureServer;
using vayu::tests::McpReplyOutcome;
using vayu::tests::McpReplyShape;
namespace limits = vayu::core::constants::import_mcp;

std::pair<int, json> import_from (const json& body) {
    return vayu::http::routes::import_mcp_response (
    body, vayu::http::TransportPolicy{}, nullptr);
}

json body_for (const McpFixtureServer& server) {
    return json{ { "url", server.url () } };
}

json tools_named (const std::vector<std::string>& names) {
    json tools = json::array ();
    for (const auto& name : names) {
        tools.push_back (json{ { "name", name }, { "description", "Runs " + name },
        { "inputSchema", { { "type", "object" } } } });
    }
    return tools;
}

std::vector<std::string> numbered_names (std::size_t count) {
    std::vector<std::string> names;
    names.reserve (count);
    for (std::size_t at = 0; at < count; ++at) {
        names.push_back ("tool_" + std::to_string (at));
    }
    return names;
}

std::string message_of (const json& body) {
    return vayu::http::routes::error_message_of (body);
}

const json& root_of (const json& result) {
    return result.at ("collections").at (0);
}

std::vector<std::string> names_of (const json& drafts) {
    std::vector<std::string> names;
    for (const auto& draft : drafts) {
        names.push_back (draft.at ("name").get<std::string> ());
    }
    return names;
}

/// The child folder named @p name, or an empty object after a failure.
json folder_of (const json& result, const std::string& name) {
    for (const auto& folder : root_of (result).at ("children")) {
        if (folder.at ("name") == name) {
            return folder;
        }
    }
    ADD_FAILURE () << "no folder named " << name << " in " << result.dump ();
    return json{ { "requests", json::array () } };
}

/// The call an `mcp` request's stored body holds.
json call_of (const json& request) {
    return json::parse (request.at ("body").at ("content").get<std::string> ());
}

std::optional<json> header_row (const json& request, const std::string& key) {
    for (const auto& row : request.at ("headers")) {
        if (row.at ("key") == key) {
            return std::optional<json> (std::in_place, row);
        }
    }
    return std::nullopt;
}

// ---------------------------------------------------------------------------
// The tree.
// ---------------------------------------------------------------------------

TEST (ImportMcpRoute, EachToolIsAnMcpRequestInTheToolsFolder) {
    McpFixtureServer server;
    server.set_tools (tools_named ({ "execute_sql", "list_tables", "describe" }));

    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    ASSERT_EQ (result.at ("collections").size (), 1U);
    const json& root = root_of (result);
    EXPECT_EQ (root.at ("name"), "vayu-fixture");
    EXPECT_EQ (names_of (root.at ("children")), std::vector<std::string>{ "Tools" });
    EXPECT_TRUE (root.at ("requests").empty ());
    EXPECT_EQ (root.at ("auth"), json ({ { "mode", "none" } }));

    const json tools = folder_of (result, "Tools").at ("requests");
    EXPECT_EQ (names_of (tools),
    (std::vector<std::string>{ "execute_sql", "list_tables", "describe" }));
    for (const auto& request : tools) {
        const std::string name = request.at ("name").get<std::string> ();
        EXPECT_EQ (request.at ("method"), "POST") << name;
        EXPECT_EQ (request.at ("url"), server.url ()) << name;
        EXPECT_EQ (request.at ("description"), "Runs " + name);
        EXPECT_EQ (request.at ("body").at ("mode"), "mcp") << name;
        // Item 2 (#3839) fills the tool's schema in; this slice does not.
        EXPECT_FALSE (request.at ("body").contains ("mcpTool")) << name;
        EXPECT_EQ (request.at ("auth"), json ({ { "mode", "inherit" } })) << name;
        const json call = call_of (request);
        // Bare, so the engine stamps the envelope and `_meta` at send.
        EXPECT_FALSE (call.contains ("jsonrpc")) << call.dump ();
        EXPECT_EQ (call.at ("method"), "tools/call");
        EXPECT_EQ (call.at ("params"),
        json ({ { "name", name }, { "arguments", json::object () } }));
        const auto content_type = header_row (request, "Content-Type");
        ASSERT_HAS_VALUE (content_type) << name;
        EXPECT_EQ (content_type->at ("value"), "application/json");
        EXPECT_EQ (content_type->at ("source"), "body-mode");
    }

    const json& meta = result.at ("meta");
    EXPECT_EQ (meta.at ("format"), "MCP server");
    EXPECT_EQ (meta.at ("requestCount"), 3);
    EXPECT_EQ (meta.at ("folderCount"), 1);
    EXPECT_EQ (meta.at ("skipped"), json::array ());
    EXPECT_EQ (result.at ("environments"), json::array ());
    EXPECT_EQ (result.at ("globals"), json::object ());
    EXPECT_EQ (server.methods (),
    (std::vector<std::string>{ "server/discover", "tools/list" }));
}

// The stored body is what a person's Send carries, so it is held to the
// server's header-against-body check too.
TEST (ImportMcpRoute, AnImportedToolCallIsOneTheServerAccepts) {
    McpFixtureServer server;
    server.set_tools (tools_named ({ "list_tables" }));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    const json request = folder_of (result, "Tools").at ("requests").at (0);

    vayu::Request send;
    send.method       = vayu::HttpMethod::POST;
    send.url          = request.at ("url").get<std::string> ();
    send.body.mode    = vayu::BodyMode::Mcp;
    send.body.content = request.at ("body").at ("content").get<std::string> ();
    vayu::http::Client client;
    auto response = client.send (send).value ();
    vayu::http::attach_mcp_reply (send, response);
    ASSERT_HAS_VALUE (response.mcp_reply);
    EXPECT_FALSE (response.mcp_reply->error_class.has_value ())
    << response.mcp_reply->message << ": " << response.body;
}

TEST (ImportMcpRoute, AToolWithNoNameIsSkippedAndCounted) {
    McpFixtureServer server;
    server.set_tools (json::array ({ json{ { "name", "kept" } },
    json{ { "name", "" } }, json{ { "description", "nameless" } } }));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    EXPECT_EQ (names_of (folder_of (result, "Tools").at ("requests")),
    std::vector<std::string>{ "kept" });
    EXPECT_EQ (result.at ("meta").at ("skipped"),
    json::parse (R"([{"kind":"malformed_item","count":2}])"));
}

// Mutation check: return after the first page in `list_all` and only the
// first two tools import.
TEST (ImportMcpRoute, EveryPageOfToolsListIsRead) {
    McpFixtureServer server;
    server.set_tools (tools_named ({ "a", "b", "c", "d", "e" }), 2);
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    EXPECT_EQ (names_of (folder_of (result, "Tools").at ("requests")),
    (std::vector<std::string>{ "a", "b", "c", "d", "e" }));
    EXPECT_EQ (server.tools_list_cursors (),
    (std::vector<std::optional<std::string>>{ std::nullopt, "cursor-2", "cursor-4" }));
}

TEST (ImportMcpRoute, AnEventStreamPageIsReadByTheReplyReader) {
    McpFixtureServer server;
    server.set_tools (tools_named ({ "a", "b", "c" }), 2);
    server.first_tools_page_as_event_stream ();
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    EXPECT_EQ (names_of (folder_of (result, "Tools").at ("requests")),
    (std::vector<std::string>{ "a", "b", "c" }));
}

TEST (ImportMcpRoute, IncludedResourcesAndPromptsGetTheirFolders) {
    McpFixtureServer server;
    server.set_tools (tools_named ({ "unread" }));
    server.set_resources (json::parse (
    R"([{"uri":"file:///a.txt","name":"a","description":"The a file"},{"uri":"file:///b"}])"));
    server.set_resource_templates (
    json::parse (R"([{"uriTemplate":"file:///{path}","name":"files"}])"));
    server.set_prompts (json::parse (R"([{"name":"greet","description":"Say hi"}])"));

    const auto [status, result] = import_from (json{ { "url", server.url () },
    { "include", { { "tools", false }, { "resources", true }, { "prompts", true } } } });
    ASSERT_EQ (status, 200) << result.dump ();
    EXPECT_EQ (names_of (root_of (result).at ("children")),
    (std::vector<std::string>{ "Resources", "Prompts" }));

    const json resources = folder_of (result, "Resources").at ("requests");
    EXPECT_EQ (names_of (resources),
    (std::vector<std::string>{ "a", "file:///b", "files" }));
    EXPECT_EQ (call_of (resources.at (0)),
    json::parse (R"({"method":"resources/read","params":{"uri":"file:///a.txt"}})"));
    EXPECT_EQ (resources.at (0).at ("description"), "The a file");
    EXPECT_EQ (call_of (resources.at (2)).at ("params").at ("uri"), "file:///{path}");
    EXPECT_EQ (resources.at (2).at ("description"), "URI template: file:///{path}");

    const json prompts = folder_of (result, "Prompts").at ("requests");
    EXPECT_EQ (names_of (prompts), std::vector<std::string>{ "greet" });
    EXPECT_EQ (call_of (prompts.at (0)),
    json::parse (R"({"method":"prompts/get","params":{"name":"greet","arguments":{}}})"));
    EXPECT_EQ (result.at ("meta").at ("requestCount"), 4);
    EXPECT_EQ (result.at ("meta").at ("folderCount"), 2);
    EXPECT_EQ (server.methods (),
    (std::vector<std::string>{ "server/discover", "resources/list",
    "resources/templates/list", "prompts/list" }));
}

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

// Mutation check: drop either half of `discovery_unanswered` and that case
// fails the import with the reader's message.
TEST (ImportMcpRoute, AServerOlderThanDiscoveryIsReadOnAndNamedByItsHost) {
    for (const auto discovery :
    { McpDiscovery::MethodNotFound, McpDiscovery::LegacyBadRequest }) {
        McpFixtureServer server;
        server.discover_as (discovery);
        server.set_tools (tools_named ({ "a" }));
        const auto [status, result] = import_from (body_for (server));
        ASSERT_EQ (status, 200) << result.dump ();
        EXPECT_EQ (root_of (result).at ("name"), "127.0.0.1");
        EXPECT_EQ (names_of (folder_of (result, "Tools").at ("requests")),
        std::vector<std::string>{ "a" });
    }
}

TEST (ImportMcpRoute, AVersionRefusalAtDiscoveryFailsTheImportWithTheReadersMessage) {
    McpFixtureServer server;
    server.reply_with (McpReplyShape::Json, McpReplyOutcome::UnsupportedVersion);
    const auto [status, body] = import_from (body_for (server));
    EXPECT_EQ (status, 502) << body.dump ();
    EXPECT_EQ (message_of (body),
    "server/discover failed: server supports 2025-11-25, 2025-06-18; this "
    "request is 2026-07-28");
    EXPECT_EQ (server.methods (), std::vector<std::string>{ "server/discover" });
}

TEST (ImportMcpRoute, ARefusedTokenAtDiscoveryFailsTheImport) {
    McpFixtureServer server;
    server.reply_with (McpReplyShape::Json, McpReplyOutcome::InsufficientScope);
    const auto [status, body] = import_from (body_for (server));
    EXPECT_EQ (status, 502) << body.dump ();
    EXPECT_EQ (message_of (body),
    "server/discover failed: insufficient_scope: needs \"db:read db:write\"");
}

// ---------------------------------------------------------------------------
// Where a call may go, and how much it may read.
// ---------------------------------------------------------------------------

TEST (ImportMcpRoute, VayusOwnPortsAreRefusedBeforeAnythingIsSent) {
    const auto& engine     = vayu::tests::engine_port_stand_in ();
    const int seen_before  = engine.requests_seen ();
    const std::string port = std::to_string (engine.port ());
    const auto [status, body] =
    import_from (json{ { "url", "http://127.0.0.1:" + port + "/mcp" } });
    EXPECT_EQ (status, 502) << body.dump ();
    EXPECT_NE (message_of (body).find ("own engine port " + port), std::string::npos)
    << message_of (body);
    EXPECT_EQ (engine.requests_seen (), seen_before);

    const std::string mcp_port = std::to_string (vayu::tests::mcp_port_stand_in ());
    const auto [mcp_status, mcp_body] =
    import_from (json{ { "url", "http://localhost:" + mcp_port + "/mcp" } });
    EXPECT_EQ (mcp_status, 502) << mcp_body.dump ();
    EXPECT_NE (message_of (mcp_body).find ("own MCP port " + mcp_port), std::string::npos)
    << message_of (mcp_body);
}

// Mutation check: raise the loop's bound in `list_all` and the import follows
// the 101st cursor and answers 200.
TEST (ImportMcpRoute, AListPastThePageCapFailsNamingIt) {
    McpFixtureServer server;
    server.set_tools (tools_named (numbered_names (limits::MAX_PAGES + 1)), 1);
    const auto [status, body] = import_from (body_for (server));
    EXPECT_EQ (status, 502) << body.dump ();
    EXPECT_EQ (message_of (body),
    "tools/list still had a nextCursor after " +
    std::to_string (limits::MAX_PAGES) + " pages, the most one import follows");
    EXPECT_EQ (server.tools_list_cursors ().size (), limits::MAX_PAGES);
}

TEST (ImportMcpRoute, AListingPastTheItemCapFailsNamingIt) {
    McpFixtureServer server;
    server.set_tools (tools_named (numbered_names (limits::MAX_ITEMS + 1)));
    const auto [status, body] = import_from (body_for (server));
    EXPECT_EQ (status, 413) << message_of (body);
    EXPECT_NE (message_of (body).find (std::to_string (limits::MAX_ITEMS)), std::string::npos)
    << message_of (body);
}

// Mutation check: drop any of the four lines in `read_base_request` /
// `mcp_client_config` and its expectation fails.
TEST (ImportMcpRoute, EveryCallIsBoundedAndFollowsNoRedirect) {
    std::atomic<bool> stopping{ false };
    const auto shape = vayu::http::routes::import_mcp_call_shape (
    json{ { "url", "http://127.0.0.1:1/mcp" } }, vayu::http::TransportPolicy{}, &stopping);
    ASSERT_HAS_VALUE (shape);
    const auto& [config, request] = *shape;
    EXPECT_EQ (config.max_response_bytes, limits::MAX_REPLY_BYTES);
    EXPECT_EQ (config.cancel, &stopping);
    EXPECT_EQ (request.timeout_ms, limits::CALL_TIMEOUT_MS);
    EXPECT_FALSE (request.follow_redirects);
    EXPECT_EQ (request.body.mode, vayu::BodyMode::Mcp);
}

// ---------------------------------------------------------------------------
// Credentials.
// ---------------------------------------------------------------------------

TEST (ImportMcpRoute, TheBearerTokenReachesTheServerAndNoCredentialReachesTheTree) {
    McpFixtureServer server;
    server.set_tools (tools_named ({ "a", "b" }));
    const auto [status, result] = import_from (json{ { "url", server.url () },
    { "auth", { { "mode", "bearer" }, { "token", "tok-3838-secret" } } },
    { "headers",
    json::array ({ json{ { "name", "X-API-Key" }, { "value", "key-3838-secret" } },
    json{ { "name", "X-Tenant" }, { "value", "acme" } } }) } });
    ASSERT_EQ (status, 200) << result.dump ();

    for (const auto& call : server.calls ()) {
        ASSERT_HAS_VALUE (call.authorization) << call.method;
        EXPECT_EQ (*call.authorization, "Bearer tok-3838-secret") << call.method;
    }
    const std::string tree = result.dump ();
    EXPECT_EQ (tree.find ("tok-3838-secret"), std::string::npos) << tree;
    EXPECT_EQ (tree.find ("key-3838-secret"), std::string::npos) << tree;

    const json& root = root_of (result);
    EXPECT_EQ (root.at ("auth"),
    json ({ { "mode", "bearer" }, { "token", "{{mcpToken}}" } }));
    EXPECT_EQ (root.at ("variables").at ("mcpToken"),
    json ({ { "value", "" }, { "enabled", true }, { "secret", true } }));
    for (const auto& request : folder_of (result, "Tools").at ("requests")) {
        EXPECT_EQ (request.at ("auth"), json ({ { "mode", "inherit" } }));
        const auto tenant = header_row (request, "X-Tenant");
        ASSERT_HAS_VALUE (tenant);
        EXPECT_EQ (tenant->at ("value"), "acme");
        EXPECT_EQ (tenant->at ("enabled"), true);
        const auto key = header_row (request, "X-API-Key");
        ASSERT_HAS_VALUE (key);
        EXPECT_EQ (key->at ("value"), "");
        EXPECT_EQ (key->at ("enabled"), false);
    }
}

TEST (ImportMcpRoute, ABodyThatNamesNoUsableServerIsRefusedBeforeAnyCall) {
    McpFixtureServer server;
    const std::string url = server.url ();
    const auto cases      = std::vector<std::pair<json, std::string>>{
        { json::array (), "Body must be a JSON object" },
        { json::object (), "Invalid 'url'" },
        { json{ { "url", "ftp://127.0.0.1/mcp" } }, "Invalid 'url'" },
        { json{ { "url", "127.0.0.1/mcp" } }, "Invalid 'url'" },
        { json{ { "url", url }, { "include", { { "tool", true } } } }, "unknown member 'tool'" },
        { json{ { "url", url }, { "include", { { "tools", "yes" } } } }, "Invalid 'include.tools'" },
        { json{ { "url", url }, { "include", { { "tools", false } } } }, "nothing is included" },
        { json{ { "url", url }, { "auth", { { "mode", "basic" } } } }, "Invalid 'auth'" },
        { json{ { "url", url }, { "auth", { { "mode", "bearer" }, { "token", " " } } } },
        "Invalid 'auth'" },
        { json{ { "url", url },
          { "headers", json::array ({ json{ { "name", "Bad Name" }, { "value", "x" } } }) } },
        "Invalid 'headers'" },
        { json{ { "url", url },
          { "headers", json::array ({ json{ { "name", "X-A" }, { "value", "a\r\nB: c" } } }) } },
        "Invalid 'headers'" },
    };
    for (const auto& [body, expected] : cases) {
        const auto [status, answer] = import_from (body);
        EXPECT_EQ (status, 400) << body.dump () << ": " << answer.dump ();
        EXPECT_NE (message_of (answer).find (expected), std::string::npos)
        << body.dump () << ": " << message_of (answer);
    }
    EXPECT_EQ (server.requests (), 0U);
}

// ---------------------------------------------------------------------------
// The tree persists through the apply-side validator unchanged.
// ---------------------------------------------------------------------------

class ImportMcpApplyTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_import_mcp_apply.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (ImportMcpApplyTest, TheImportedTreePersistsThroughImportApply) {
    McpFixtureServer server;
    server.set_tools (tools_named ({ "a", "b" }));
    server.set_resources (json::parse (R"([{"uri":"file:///a.txt","name":"a"}])"));
    server.set_prompts (json::parse (R"([{"name":"greet"}])"));
    const auto [status, result] = import_from (json{ { "url", server.url () },
    { "auth", { { "mode", "bearer" }, { "token", "tok" } } },
    { "include", { { "resources", true }, { "prompts", true } } } });
    ASSERT_EQ (status, 200) << result.dump ();

    const auto tree = vayu::utils::parse_ordered_json (
    result.dump (), vayu::utils::ORDERED_JSON_UNBOUNDED);
    ASSERT_HAS_VALUE (tree);
    const json payload = vayu::core::import_apply_payload (*tree);
    const auto [applied_status, applied] =
    vayu::http::routes::import_apply_response (*db_, payload);
    ASSERT_EQ (applied_status, 200) << applied.dump ();

    const auto collections = db_->get_collections ();
    EXPECT_EQ (collections.size (), 4U);
    std::size_t requests = 0;
    for (const auto& collection : collections) {
        for (const auto& request : db_->get_requests_in_collection (collection.id)) {
            ++requests;
            EXPECT_EQ (json::parse (request.body).at ("mode"), "mcp") << request.name;
        }
        if (collection.name == "vayu-fixture") {
            EXPECT_EQ (json::parse (collection.auth).at ("token"), "{{mcpToken}}");
            EXPECT_EQ (json::parse (collection.variables).at ("mcpToken").at ("secret"), true);
        }
    }
    EXPECT_EQ (requests, 4U);
}

} // namespace
