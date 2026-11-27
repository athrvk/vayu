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
#include <chrono>
#include <cstddef>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "engine_port_stand_in.hpp"
#include "mcp_fixture_server.hpp"
#include "mcp_port_stand_in.hpp"
#include "optional_assert.hpp"
#include "scenario_runner_fixture.hpp"
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
std::pair<int, nlohmann::json> import_mcp_response (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel,
std::chrono::milliseconds total_timeout,
std::size_t max_total_bytes);
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
using vayu::tests::scenario_runner::ScenarioRunnerTest;
namespace limits = vayu::core::constants::import_mcp;

std::pair<int, json> import_from (const json& body) {
    return vayu::http::routes::import_mcp_response (
    body, vayu::http::TransportPolicy{}, nullptr);
}

/// An import under whole-import bounds the test names.
std::pair<int, json> import_within (const json& body,
std::chrono::milliseconds total_timeout,
std::size_t max_total_bytes) {
    return vayu::http::routes::import_mcp_response (body,
    vayu::http::TransportPolicy{}, nullptr, total_timeout, max_total_bytes);
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

/// What every generated request asserts.
json status_200_elements () {
    return json::parse (R"([{"kind":"assert.status","config":{"in":[200]}}])");
}

/// The endpoint an imported tree's requests send to: its root's `mcpBaseUrl`.
std::string base_url_of (const json& result) {
    return root_of (result).at ("variables").at ("mcpBaseUrl").at ("value").get<std::string> ();
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
    EXPECT_EQ (root.at ("variables"),
    json ({ { "mcpBaseUrl", { { "value", server.url () }, { "enabled", true } } } }));

    const json tools = folder_of (result, "Tools").at ("requests");
    EXPECT_EQ (names_of (tools),
    (std::vector<std::string>{ "execute_sql", "list_tables", "describe" }));
    for (const auto& request : tools) {
        const std::string name = request.at ("name").get<std::string> ();
        EXPECT_EQ (request.at ("method"), "POST") << name;
        EXPECT_EQ (request.at ("url"), "{{mcpBaseUrl}}") << name;
        EXPECT_EQ (request.at ("description"), "Runs " + name);
        EXPECT_EQ (request.at ("body").at ("mode"), "mcp") << name;
        EXPECT_EQ (request.at ("body").at ("mcpTool"),
        json ({ { "name", name }, { "inputSchema", { { "type", "object" } } } }))
        << name;
        EXPECT_EQ (request.at ("elements"), status_200_elements ()) << name;
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

// ---------------------------------------------------------------------------
// A tool's schema: `mcpTool` and the arguments drawn from it.
// ---------------------------------------------------------------------------

/// Three tools whose schemas each exercise a rule of the sampler, and `plain`,
/// which has none. `execute_sql` is the fixture's annotated tool with both of
/// its arguments required, so its `region` is sampled and mirrored as a header.
json schema_tools () {
    return json::parse (R"([
      {"name":"search","description":"Runs search",
       "inputSchema":{"type":"object",
         "properties":{
           "query":{"type":"string"},
           "limit":{"type":"integer","enum":[5,10],"default":10},
           "level":{"type":"integer","enum":[3,4]},
           "verbose":{"type":"boolean"}},
         "required":["query","limit","level"]},
       "outputSchema":{"type":"object","properties":{"hits":{"type":"array"}}}},
      {"name":"create","description":"Runs create",
       "inputSchema":{"type":"object",
         "properties":{
           "owner":{"$ref":"#/$defs/person"},
           "retries":{"type":"integer","default":3},
           "note":{"type":"string"}},
         "required":["owner","retries"],
         "$defs":{"person":{"type":"object",
           "properties":{"name":{"type":"string"},"nickname":{"type":"string"}},
           "required":["name"]}}}},
      {"name":"execute_sql","description":"Runs execute_sql",
       "inputSchema":{"type":"object",
         "properties":{
           "region":{"type":"string","x-mcp-header":"Region"},
           "query":{"type":"string"}},
         "required":["region","query"]}},
      {"name":"plain","description":"Runs plain"}])");
}

json arguments_of (const json& request) {
    return call_of (request).at ("params").at ("arguments");
}

TEST (ImportMcpRoute, AToolsRequiredArgumentsAreSampledFromItsSchema) {
    McpFixtureServer server;
    server.set_tools (schema_tools ());
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    const json tools = folder_of (result, "Tools").at ("requests");
    ASSERT_EQ (tools.size (), 4U);

    // A default and an enum's first member are values the server accepts, which
    // a typed zero is not, and the default outranks the enum; an optional
    // property is not sent at all.
    EXPECT_EQ (arguments_of (tools.at (0)),
    json::parse (R"({"query":"","limit":10,"level":3})"));
    // A `$ref` resolves against the tool's own schema, so `#/$defs/person` is found.
    EXPECT_EQ (arguments_of (tools.at (1)),
    json::parse (R"({"owner":{"name":""},"retries":3})"));
    EXPECT_EQ (arguments_of (tools.at (2)), json::parse (R"({"region":"","query":""})"));
    EXPECT_EQ (arguments_of (tools.at (3)), json::object ());
}

TEST (ImportMcpRoute, ArgumentsSatisfyAToolsComposedRequiredAndItsMinimums) {
    McpFixtureServer server;
    server.set_tools (json::parse (R"([
      {"name":"either","description":"Runs either",
       "inputSchema":{"type":"object",
         "properties":{"a":{"type":"string"},"page":{"type":"integer","minimum":1}},
         "required":["a","page","undeclared"],
         "oneOf":[{"required":["a"]},{"required":["b"]}]}}])"));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    const json tools = folder_of (result, "Tools").at ("requests");
    ASSERT_EQ (tools.size (), 1U);

    // The tool's own required names survive its `oneOf`, the integer clears
    // `minimum: 1`, and a required name no property declares is still sent.
    EXPECT_EQ (arguments_of (tools.at (0)),
    json::parse (R"({"a":"","page":1,"undeclared":""})"));
}

TEST (ImportMcpRoute, AToolsSchemasAreStoredAsMcpToolInputAndOutput) {
    McpFixtureServer server;
    server.set_tools (schema_tools ());
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    const json tools = folder_of (result, "Tools").at ("requests");

    // The builder reads `outputSchema` (the Body tab, the default
    // `assert.jsonschema`); a send ignores it.
    const json& stored = tools.at (0).at ("body").at ("mcpTool");
    EXPECT_EQ (stored.at ("name"), "search");
    EXPECT_EQ (stored.at ("inputSchema"), schema_tools ().at (0).at ("inputSchema"));
    EXPECT_EQ (stored.at ("outputSchema"), schema_tools ().at (0).at ("outputSchema"));
    EXPECT_FALSE (
    tools.at (1).at ("body").at ("mcpTool").contains ("outputSchema"));
    // A tool with no schema is still named, so a person's later edit of the
    // call is held to the tool.
    EXPECT_EQ (tools.at (3).at ("body").at ("mcpTool"), json ({ { "name", "plain" } }));
    EXPECT_EQ (result.at ("meta").at ("skipped"), json::array ());
}

TEST (ImportMcpRoute, AnOutputSchemaThatIsNotAnObjectIsNotStoredAndCostsNothing) {
    McpFixtureServer server;
    server.set_tools (json::parse (R"([
      {"name":"flag","description":"Runs flag",
       "inputSchema":{"type":"object","properties":{}},
       "outputSchema":true},
      {"name":"listing","description":"Runs listing","outputSchema":[{"type":"string"}]}])"));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    const json tools = folder_of (result, "Tools").at ("requests");
    ASSERT_EQ (tools.size (), 2U);

    for (const auto& request : tools) {
        EXPECT_FALSE (
        request.at ("body").at ("mcpTool").contains ("outputSchema"))
        << request.at ("name");
    }
    EXPECT_EQ (tools.at (0).at ("body").at ("mcpTool").at ("inputSchema"),
    json::parse (R"({"type":"object","properties":{}})"));
    EXPECT_EQ (result.at ("meta").at ("skipped"), json::array ());
}

TEST (ImportMcpRoute, EveryRequestOfEveryFolderExpectsA200) {
    McpFixtureServer server;
    server.set_tools (schema_tools ());
    server.set_resources (json::parse (R"([{"uri":"file:///a.txt"}])"));
    server.set_resource_templates (json::parse (R"([{"uriTemplate":"file:///{p}"}])"));
    server.set_prompts (json::parse (R"([{"name":"greet"}])"));
    const auto [status, result] = import_from (json{ { "url", server.url () },
    { "include", { { "resources", true }, { "prompts", true } } } });
    ASSERT_EQ (status, 200) << result.dump ();

    std::size_t seen = 0;
    for (const auto& folder : root_of (result).at ("children")) {
        for (const auto& request : folder.at ("requests")) {
            EXPECT_EQ (request.at ("elements"), status_200_elements ())
            << request.at ("name");
            ++seen;
        }
    }
    EXPECT_EQ (seen, 7U);
}

// `apply` refuses a whole tree over one body `read_mcp_tool` cannot read, so a
// server's bad annotation must cost one tool its schema, not the import.
TEST (ImportMcpRoute, AToolWhoseSchemaASendRefusesKeepsItsRequestAndIsCounted) {
    McpFixtureServer server;
    server.set_tools (json::parse (R"([
      {"name":"ok","inputSchema":{"type":"object"}},
      {"name":"bad_header","inputSchema":{"type":"object",
         "properties":{"region":{"type":"string","x-mcp-header":"Bad Name"}},
         "required":["region"]}},
      {"name":"worse","inputSchema":{"type":"object",
         "properties":{"a":{"x-mcp-header":7}}}}])"));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    const json tools = folder_of (result, "Tools").at ("requests");
    ASSERT_EQ (tools.size (), 3U);

    EXPECT_TRUE (tools.at (0).at ("body").contains ("mcpTool"));
    for (const std::size_t at : { 1U, 2U }) {
        EXPECT_FALSE (tools.at (at).at ("body").contains ("mcpTool")) << at;
        EXPECT_EQ (tools.at (at).at ("elements"), status_200_elements ());
    }
    EXPECT_EQ (arguments_of (tools.at (1)), json::parse (R"({"region":""})"));
    EXPECT_EQ (result.at ("meta").at ("skipped"),
    json::parse (R"([{"kind":"unusable_tool_schema","count":2,"requests":["bad_header","worse"]}])"));
}

// A subject is named per kind until the next call; the bad tool's must not
// leak onto the malformed entry that follows it.
TEST (ImportMcpRoute, AnUnusableToolSchemaNamesNoLaterMalformedItem) {
    McpFixtureServer server;
    server.set_tools (json::parse (R"([
      {"name":"bad","inputSchema":{"properties":{"a":{"x-mcp-header":""}}}},
      {"description":"nameless"}])"));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    EXPECT_EQ (result.at ("meta").at ("skipped"), json::parse (R"([{"kind":"malformed_item","count":1},
                     {"kind":"unusable_tool_schema","count":1,"requests":["bad"]}])"));
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
    send.url          = base_url_of (result);
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

// A `-32601` is a modern server that has no such method, so no handshake.
// Mutation check: drop the `is_method_not_found` test in `discover` and the
// import fails with the reader's message.
TEST (ImportMcpRoute, AServerWithNoDiscoverIsReadOnAndNamedByItsHost) {
    McpFixtureServer server;
    server.discover_as (McpDiscovery::MethodNotFound);
    server.set_tools (tools_named ({ "a" }));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    EXPECT_EQ (root_of (result).at ("name"), "127.0.0.1");
    EXPECT_EQ (names_of (folder_of (result, "Tools").at ("requests")),
    std::vector<std::string>{ "a" });
    EXPECT_TRUE (root_of (result).at ("requests").empty ());
    EXPECT_EQ (server.methods (),
    (std::vector<std::string>{ "server/discover", "tools/list" }));
}

// The `-32601` stays a modern server's whatever status carries it.
// Mutation check: drop the `-32601` test from `is_legacy_refusal` and the import
// opens a session instead.
TEST (ImportMcpRoute, AMethodNotFoundUnderA400AtDiscoveryIsStillAModernServer) {
    McpFixtureServer server;
    server.discover_as (McpDiscovery::MethodNotFoundBadRequest);
    server.set_tools (tools_named ({ "a" }));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    EXPECT_EQ (root_of (result).at ("name"), "127.0.0.1");
    EXPECT_EQ (server.methods (),
    (std::vector<std::string>{ "server/discover", "tools/list" }));
}

// A `400` is a legacy-era refusal only for a status and a JSON-RPC error that is
// neither `-32022` nor `-32601`; the version refusal below is the `400` a modern
// server answers with, and stays a failure.
// Mutation check: widen `is_legacy_refusal` to any `400` and this import goes on
// to `initialize`.
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

// Only a `400` is a legacy-era refusal: the same kind of JSON-RPC error under any
// other status fails the import.
// Mutation check: drop the status test in `is_legacy_refusal` and the import
// goes on to `initialize`.
TEST (ImportMcpRoute, AJsonRpcErrorAtDiscoveryUnderAnotherStatusFailsTheImport) {
    McpFixtureServer server;
    server.reply_with (McpReplyShape::Json, McpReplyOutcome::RpcError);
    const auto [status, body] = import_from (body_for (server));
    EXPECT_EQ (status, 502) << body.dump ();
    EXPECT_EQ (message_of (body),
    "server/discover failed: JSON-RPC error -32602: Unknown tool: execute_sql");
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

// Mutation check: drop the `sent_cursors` test in `list_all` and the import
// asks for the same page until the page cap.
TEST (ImportMcpRoute, ARepeatedCursorFailsTheListAtTheFirstRepeat) {
    McpFixtureServer server;
    server.set_tools (tools_named (numbered_names (5)), 2);
    server.repeat_tools_cursor ();
    const auto [status, body] = import_from (body_for (server));
    EXPECT_EQ (status, 502) << body.dump ();
    EXPECT_EQ (message_of (body),
    "tools/list repeated a cursor it had already been sent, so the list would "
    "never end");
    EXPECT_EQ (server.tools_list_cursors (),
    (std::vector<std::optional<std::string>>{ std::nullopt, "cursor-2" }));
}

// Every reply here is a few hundred bytes, under the cap alone; their sum is
// not. Mutation check: make `budget.bytes +=` an assignment and the import
// reads every page and answers 200.
TEST (ImportMcpRoute, RepliesPastTheWholeImportByteCapFailNamingIt) {
    constexpr std::size_t cap = 1000;
    McpFixtureServer server;
    server.set_tools (tools_named (numbered_names (40)), 2);
    const auto [status, body] =
    import_within (body_for (server), std::chrono::milliseconds (60000), cap);
    EXPECT_EQ (status, 413) << body.dump ();
    EXPECT_EQ (message_of (body), "The server's replies came to more than 1000 bytes, the most one import reads");
    EXPECT_GT (server.tools_list_cursors ().size (), 1U);
    EXPECT_LT (server.tools_list_cursors ().size (), 20U);
}

// Driven with a spent deadline rather than by waiting one out. Mutation check:
// drop the `remaining` test in `transfer` and the import answers 200.
TEST (ImportMcpRoute, AnImportPastItsTotalDeadlineFailsBeforeTheNextCall) {
    McpFixtureServer server;
    server.set_tools (tools_named ({ "a" }));
    const auto [status, body] = import_within (
    body_for (server), std::chrono::milliseconds (0), limits::MAX_TOTAL_BYTES);
    EXPECT_EQ (status, 502) << body.dump ();
    EXPECT_EQ (message_of (body),
    "The import ran past its 0 ms total at server/discover, the longest one "
    "import takes");
    EXPECT_EQ (server.requests (), 0U);
}

// The query rides in the variable's value, so a request's own Params stay empty
// and a send resolves to the URL exactly as given.
TEST (ImportMcpRoute, AUrlsQueryIsKeptAsGiven) {
    McpFixtureServer server;
    server.set_tools (tools_named ({ "a" }));
    const std::string url       = server.url () + "?tenant=acme";
    const auto [status, result] = import_from (json{ { "url", url } });
    ASSERT_EQ (status, 200) << result.dump ();
    EXPECT_EQ (base_url_of (result), url);
    const json request = folder_of (result, "Tools").at ("requests").at (0);
    EXPECT_EQ (request.at ("url"), "{{mcpBaseUrl}}");
    EXPECT_EQ (request.at ("params"), json::array ());
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
        // Mutation check: drop the userinfo test in `read_url` and this one
        // is sent.
        { json{ { "url", "http://user:pw@127.0.0.1/mcp" } },
        "put credentials in auth or headers, not the URL" },
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

/// The tree an import answers, applied; the apply answer's status is checked.
void apply_tree (vayu::db::Database& db, const json& result) {
    const auto tree = vayu::utils::parse_ordered_json (
    result.dump (), vayu::utils::ORDERED_JSON_UNBOUNDED);
    ASSERT_HAS_VALUE (tree);
    const json payload = vayu::core::import_apply_payload (*tree);
    const auto [status, applied] = vayu::http::routes::import_apply_response (db, payload);
    ASSERT_EQ (status, 200) << applied.dump ();
}

/// The stored request named @p name, wherever the tree filed it.
std::optional<vayu::db::Request>
stored_request (vayu::db::Database& db, const std::string& name) {
    for (const auto& collection : db.get_collections ()) {
        for (auto& request : db.get_requests_in_collection (collection.id)) {
            if (request.name == name) {
                return std::optional<vayu::db::Request> (std::in_place, std::move (request));
            }
        }
    }
    return std::nullopt;
}

TEST_F (ImportMcpApplyTest, AToolsSchemaAndExpectationSurviveApplyAndABadOneCostsOnlyItself) {
    McpFixtureServer server;
    json tools = schema_tools ();
    tools.push_back (json::parse (R"({"name":"bad_header","inputSchema":{
      "properties":{"region":{"type":"string","x-mcp-header":"Bad Name"}}}})"));
    server.set_tools (tools);
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    apply_tree (*db_, result);

    const auto search = stored_request (*db_, "search");
    ASSERT_HAS_VALUE (search);
    const json body = json::parse (search->body);
    EXPECT_EQ (body.at ("mcpTool").at ("name"), "search");
    EXPECT_EQ (body.at ("mcpTool").at ("inputSchema"), tools.at (0).at ("inputSchema"));
    EXPECT_EQ (body.at ("mcpTool").at ("outputSchema"), tools.at (0).at ("outputSchema"));
    EXPECT_EQ (search->url, "{{mcpBaseUrl}}");
    const json elements = json::parse (search->elements);
    // One element: nothing generates an `assert.jsonschema` from the
    // stored `outputSchema`.
    ASSERT_EQ (elements.size (), 1U) << search->elements;
    EXPECT_EQ (elements.at (0).at ("kind"), "assert.status");
    EXPECT_EQ (elements.at (0).at ("config"), json::parse (R"({"in":[200]})"));

    const auto bad = stored_request (*db_, "bad_header");
    ASSERT_HAS_VALUE (bad);
    EXPECT_FALSE (json::parse (bad->body).contains ("mcpTool"));

    for (const auto& collection : db_->get_collections ()) {
        if (collection.name == "vayu-fixture") {
            EXPECT_EQ (json::parse (collection.variables).at ("mcpBaseUrl").at ("value"),
            server.url ());
        }
    }
}

// ---------------------------------------------------------------------------
// The generated collection runs as it stands.
// ---------------------------------------------------------------------------

// The tree is applied and its collection run, with no edit between: each tool's
// sampled arguments, its mirrored `Mcp-Param-Region` header, `{{mcpBaseUrl}}`
// and the `200` expectation all have to hold against a server that checks every
// call's headers against its body. The empty `region` is mirrored as a
// `=?base64??=` sentinel, which the fixture decodes back to the empty argument.
// Mutation checks: set no `mcpTool` and `execute_sql` is refused for its missing
// `Mcp-Param-Region`; drop the root variable and the step's URL stays unresolved.
TEST_F (ScenarioRunnerTest, AnImportedMcpCollectionRunsWithNoEdits) {
    McpFixtureServer mcp;
    mcp.set_tools (schema_tools ());
    const auto [status, result] = import_from (body_for (mcp));
    ASSERT_EQ (status, 200) << result.dump ();
    apply_tree (*db_, result);
    const std::size_t tools_listed = mcp.calls ().size ();

    for (const auto& collection : db_->get_collections ()) {
        if (collection.name == "vayu-fixture") {
            collection_id_ = collection.id;
        }
    }
    ASSERT_NE (collection_id_, "col_1");
    recursive_        = true;
    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const json tools  = schema_tools ();
    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), tools.size ());
    for (const auto& trace : traces) {
        EXPECT_EQ (trace.at ("outcome"), "passed") << trace.dump ();
    }

    const auto calls = mcp.calls ();
    ASSERT_EQ (calls.size (), tools_listed + tools.size ());
    for (std::size_t at = 0; at < tools.size (); ++at) {
        EXPECT_EQ (calls.at (tools_listed + at).method, "tools/call");
    }
}

// ---------------------------------------------------------------------------
// A legacy-era server: the handshake as explicit requests (#3840).
// ---------------------------------------------------------------------------

using vayu::tests::McpLegacySessions;
using vayu::tests::McpRecordedCall;

/// Each call as `<verb> <method>`, or the verb alone for a `DELETE`, and the
/// session it carried, `-` for none.
std::vector<std::string> sequence_of (const std::vector<McpRecordedCall>& calls) {
    std::vector<std::string> sequence;
    for (const auto& call : calls) {
        const std::string step =
        call.verb == "DELETE" ? call.verb : call.verb + " " + call.method;
        sequence.push_back (step + " @" + call.session_id.value_or ("-"));
    }
    return sequence;
}

/// The value of @p request's header row @p key, or `-` when it has none.
std::string row_value (const json& request, const std::string& key) {
    const auto row = header_row (request, key);
    return row ? row->at ("value").get<std::string> () : "-";
}

json session_extract_json () {
    return json::parse (R"({"kind":"extract.header","config":{"header":"Mcp-Session-Id",
      "variable":"mcpSessionId","scope":"collection","required":true}})");
}

// Mutation checks: drop the `is_legacy_refusal` test in `discover` and the
// import fails at `server/discover`; drop the session header from
// `session_request` and every call after `initialize` is refused.
TEST (ImportMcpRoute, ALegacyEraServerIsImportedThroughASessionItThenEnds) {
    McpFixtureServer server;
    server.speak_legacy ();
    server.set_tools (tools_named ({ "a", "b" }));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();

    EXPECT_EQ (sequence_of (server.calls ()),
    (std::vector<std::string>{ "POST server/discover @-", "POST initialize @-",
    "POST notifications/initialized @legacy-session-1",
    "POST tools/list @legacy-session-1", "DELETE @legacy-session-1" }));
    EXPECT_TRUE (server.live_sessions ().empty ());
    EXPECT_EQ (root_of (result).at ("name"), "vayu-legacy-fixture");
    // The fixture refuses a `DELETE` without the version; this pins that the
    // import sent it rather than relying on that refusal being noticed.
    EXPECT_EQ (server.calls ().back ().protocol_version,
    std::string (vayu::tests::MCP_LEGACY_FIXTURE_VERSION));
}

/// An import of a legacy-era server whose `server/discover` is refused as
/// @p refusal: the handshake, the list and the close all follow.
void expect_legacy_import_after (McpDiscovery refusal) {
    McpFixtureServer server;
    server.speak_legacy ();
    server.discover_as (refusal);
    server.set_tools (tools_named ({ "a", "b" }));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();

    EXPECT_EQ (sequence_of (server.calls ()),
    (std::vector<std::string>{ "POST server/discover @-", "POST initialize @-",
    "POST notifications/initialized @legacy-session-1",
    "POST tools/list @legacy-session-1", "DELETE @legacy-session-1" }));
    EXPECT_EQ (root_of (result).at ("name"), "vayu-legacy-fixture");
    EXPECT_EQ (names_of (folder_of (result, "Tools").at ("requests")),
    (std::vector<std::string>{ "a", "b" }));
}

// The reference SDK servers refuse a session-less POST with a JSON-RPC error
// under the `400`, not plain text (#3989).
// Mutation check: restore the plain-text-only `is_legacy_refusal` (class
// Transport, no code) and each of these fails with the `502` that names the
// server's JSON-RPC error.
TEST (ImportMcpRoute, ALegacyServerThatRefusesDiscoverInTheTypeScriptSdkShapeIsImported) {
    expect_legacy_import_after (McpDiscovery::LegacyTypeScriptSessionRequired);
}

TEST (ImportMcpRoute, ALegacyServerThatRefusesDiscoverInThePythonSdkShapeIsImported) {
    expect_legacy_import_after (McpDiscovery::LegacyPythonInvalidRequest);
}

TEST (ImportMcpRoute, ALegacyEraTreeIsItsHandshakeThenTheToolsThenTheClose) {
    McpFixtureServer server;
    server.speak_legacy ();
    server.set_tools (tools_named ({ "a", "b" }));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();
    const json& root = root_of (result);
    const std::string negotiated (vayu::tests::MCP_LEGACY_FIXTURE_VERSION);

    // The root's requests and folders share one `order` space, which is the
    // run's order.
    const json& requests = root.at ("requests");
    ASSERT_EQ (names_of (requests),
    (std::vector<std::string>{ "initialize", "notifications/initialized", "Close session" }));
    EXPECT_EQ (requests.at (0).at ("order"), 0);
    EXPECT_EQ (requests.at (1).at ("order"), 1);
    EXPECT_EQ (folder_of (result, "Tools").at ("order"), 2);
    EXPECT_EQ (requests.at (2).at ("order"), 3);

    const json& init = requests.at (0);
    EXPECT_EQ (init.at ("body").at ("mode"), "mcp");
    const json init_call = call_of (init);
    EXPECT_EQ (init_call.at ("jsonrpc"), "2.0");
    EXPECT_EQ (init_call.at ("id"), 1);
    EXPECT_EQ (init_call.at ("method"), "initialize");
    EXPECT_EQ (init_call.at ("params").at ("protocolVersion"),
    std::string (vayu::core::MCP_LEGACY_PROTOCOL_VERSION));
    EXPECT_EQ (init_call.at ("params").at ("clientInfo").at ("name"), "vayu");
    EXPECT_EQ (row_value (init, "MCP-Protocol-Version"),
    std::string (vayu::core::MCP_LEGACY_PROTOCOL_VERSION));
    EXPECT_EQ (row_value (init, "Mcp-Session-Id"), "-");
    EXPECT_EQ (init.at ("elements"),
    json::array ({ status_200_elements ().at (0), session_extract_json () }));

    const json& note = requests.at (1);
    EXPECT_EQ (call_of (note),
    json::parse (R"({"jsonrpc":"2.0","method":"notifications/initialized"})"));
    EXPECT_EQ (note.at ("elements"),
    json::parse (R"([{"kind":"assert.status","config":{"in":[200,202,204]}}])"));

    const json tools = folder_of (result, "Tools").at ("requests");
    ASSERT_EQ (tools.size (), 2U);
    for (std::size_t at = 0; at < tools.size (); ++at) {
        const json call = call_of (tools.at (at));
        EXPECT_EQ (call.at ("jsonrpc"), "2.0");
        // Numbered after `initialize`: a session refuses an id it has seen.
        EXPECT_EQ (call.at ("id"), at + 2);
        EXPECT_EQ (call.at ("method"), "tools/call");
        EXPECT_TRUE (tools.at (at).at ("body").contains ("mcpTool"));
        EXPECT_EQ (tools.at (at).at ("elements"), status_200_elements ());
    }

    const json& close = requests.at (2);
    EXPECT_EQ (close.at ("method"), "DELETE");
    EXPECT_EQ (close.at ("body"), json ({ { "mode", "none" } }));
    EXPECT_EQ (close.at ("elements"),
    json::parse (R"([{"kind":"assert.status","config":{"in":[200,202,204,405]}}])"));
    for (const json* later : { &note, &tools.at (0), &tools.at (1), &close }) {
        EXPECT_EQ (row_value (*later, "MCP-Protocol-Version"), negotiated)
        << later->at ("name");
        EXPECT_EQ (row_value (*later, "Mcp-Session-Id"), "{{mcpSessionId}}")
        << later->at ("name");
    }
    EXPECT_EQ (result.at ("meta").at ("requestCount"), 5);
    EXPECT_EQ (result.at ("meta").at ("folderCount"), 1);
}

// No session to carry or end, so the tree neither extracts one nor closes it,
// and no request names one a run could not resolve.
TEST (ImportMcpRoute, AStatelessLegacyServerGetsTheHandshakeWithNoSession) {
    McpFixtureServer server;
    server.speak_legacy (McpLegacySessions::Stateless);
    server.set_tools (tools_named ({ "a" }));
    const auto [status, result] = import_from (body_for (server));
    ASSERT_EQ (status, 200) << result.dump ();

    EXPECT_EQ (sequence_of (server.calls ()),
    (std::vector<std::string>{ "POST server/discover @-", "POST initialize @-",
    "POST notifications/initialized @-", "POST tools/list @-" }));
    const json& requests = root_of (result).at ("requests");
    EXPECT_EQ (names_of (requests),
    (std::vector<std::string>{ "initialize", "notifications/initialized" }));
    EXPECT_EQ (requests.at (0).at ("elements"), status_200_elements ());
    EXPECT_EQ (result.dump ().find ("mcpSessionId"), std::string::npos)
    << result.dump ();
    EXPECT_EQ (row_value (folder_of (result, "Tools").at ("requests").at (0), "MCP-Protocol-Version"),
    std::string (vayu::tests::MCP_LEGACY_FIXTURE_VERSION));
}

// The session opens before anything can fail, so each failure still ends it.
// Mutation check: return before `close_legacy_session` in `read_listing` on a
// failure and the session is left open.
TEST (ImportMcpRoute, AFailedLegacyImportStillEndsItsSession) {
    McpFixtureServer server;
    server.speak_legacy (McpLegacySessions::Issued, /*names_version=*/false);
    const auto [status, body] = import_from (body_for (server));
    EXPECT_EQ (status, 502) << body.dump ();
    EXPECT_EQ (message_of (body), "initialize answered with no protocolVersion");
    EXPECT_EQ (sequence_of (server.calls ()),
    (std::vector<std::string>{ "POST server/discover @-", "POST initialize @-",
    "DELETE @legacy-session-1" }));
    EXPECT_TRUE (server.live_sessions ().empty ());

    McpFixtureServer listing;
    listing.speak_legacy ();
    listing.set_tools (tools_named (numbered_names (40)));
    const auto [capped, capped_body] =
    import_within (body_for (listing), std::chrono::milliseconds (60000), 1000);
    EXPECT_EQ (capped, 413) << capped_body.dump ();
    EXPECT_EQ (listing.calls ().back ().verb, "DELETE");
    EXPECT_TRUE (listing.live_sessions ().empty ());
}

// A reply the whole-import byte cap refuses still came from a server that
// opened a session, so the `DELETE` is sent with it. `server/discover`'s
// refusal is a few dozen bytes and `initialize`'s answer is over the cap, so the
// refusal is at `initialize`, before its session could be read from the answer.
// That answer is never read either, so no version was negotiated and the
// `DELETE` carries the offered one, which this fixture (it negotiated down)
// refuses: the session is not asserted ended, only the `DELETE` sent.
// Mutation check: read the session in `initialize` after `send_call` instead
// of in `keep_issued_session` and the 413 sends no `DELETE`.
TEST (ImportMcpRoute, ALegacyImportRefusedByTheByteCapAtInitializeStillSendsItsDelete) {
    McpFixtureServer server;
    server.speak_legacy ();
    const auto [status, body] =
    import_within (body_for (server), std::chrono::milliseconds (60000), 100);
    EXPECT_EQ (status, 413) << body.dump ();
    EXPECT_EQ (sequence_of (server.calls ()),
    (std::vector<std::string>{ "POST server/discover @-", "POST initialize @-",
    "DELETE @legacy-session-1" }));
    EXPECT_EQ (server.calls ().back ().protocol_version,
    std::string (vayu::core::MCP_LEGACY_PROTOCOL_VERSION));
}

// The deadline is what ends the import at a list call that never answers, and
// is spent by the time the session is closed. The handshake takes
// milliseconds against the 400 a spent deadline waits for.
// Mutation check: send the `DELETE` in `close_legacy_session` through
// `transfer` and a spent deadline refuses it, leaving the session open.
TEST (ImportMcpRoute, ALegacyImportThatRanOutOfTimeStillEndsItsSession) {
    McpFixtureServer server;
    server.speak_legacy ();
    server.hang_method ("tools/list");
    const auto [status, body] = import_within (
    body_for (server), std::chrono::milliseconds (400), limits::MAX_TOTAL_BYTES);
    EXPECT_EQ (status, 502) << body.dump ();
    EXPECT_EQ (sequence_of (server.calls ()),
    (std::vector<std::string>{ "POST server/discover @-", "POST initialize @-",
    "POST notifications/initialized @legacy-session-1",
    "POST tools/list @legacy-session-1", "DELETE @legacy-session-1" }));
    EXPECT_TRUE (server.live_sessions ().empty ());
}


/// The calls one run of the imported legacy collection makes: the handshake,
/// every tool and the close, all in the run's own session (the import's was
/// the first, so the run's is the second).
std::vector<std::string> legacy_run_sequence () {
    std::vector<std::string> sequence{ "POST initialize @-",
        "POST notifications/initialized @legacy-session-2" };
    sequence.insert (sequence.end (), schema_tools ().size (),
    "POST tools/call @legacy-session-2");
    sequence.emplace_back ("DELETE @legacy-session-2");
    return sequence;
}

// The generated sequence runs against the server it was read from, with no
// edit: `initialize` extracts the run's own session (not the import's, which
// the import ended), every later step sends it, and the close ends it. The
// server's refusal of `server/discover` does not change it, whichever of the
// shapes (plain text, the TypeScript and the Python SDK's JSON-RPC error) it
// arrives in (#3989); each one gets a server and a collection of its own.
// Mutation checks: drop `session_extract_element` from `initialize_draft` and
// every later step sends `{{mcpSessionId}}` unresolved, which the fixture
// answers `404`; drop `order_root_children` and `initialize` runs after the
// tools; restore the plain-text-only `is_legacy_refusal` and the two JSON-RPC
// shapes fail at the import.
TEST_F (ScenarioRunnerTest, AnImportedLegacyMcpCollectionRunsItsSessionWithNoEdits) {
    std::set<std::string> collections_run;
    for (const auto refusal : { McpDiscovery::LegacyBadRequest, McpDiscovery::LegacyTypeScriptSessionRequired,
         McpDiscovery::LegacyPythonInvalidRequest }) {
        SCOPED_TRACE (static_cast<int> (refusal));
        McpFixtureServer mcp;
        mcp.speak_legacy ();
        mcp.discover_as (refusal);
        mcp.set_tools (schema_tools ());
        const auto [status, result] = import_from (body_for (mcp));
        ASSERT_EQ (status, 200) << result.dump ();
        apply_tree (*db_, result);
        const std::size_t imported = mcp.calls ().size ();

        collection_id_.clear ();
        for (const auto& collection : db_->get_collections ()) {
            if (collection.name == vayu::tests::MCP_LEGACY_FIXTURE_NAME &&
            collections_run.insert (collection.id).second) {
                collection_id_ = collection.id;
            }
        }
        ASSERT_FALSE (collection_id_.empty ());
        recursive_        = true;
        const auto run_id = start (/*iterations=*/1);
        ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

        const std::size_t steps = schema_tools ().size () + 3;
        const auto traces       = stored_traces (run_id);
        ASSERT_EQ (traces.size (), steps);
        for (const auto& trace : traces) {
            EXPECT_EQ (trace.at ("outcome"), "passed") << trace.dump ();
        }

        const auto calls = mcp.calls ();
        ASSERT_EQ (calls.size (), imported + steps);
        const std::vector<McpRecordedCall> run (
        calls.begin () + static_cast<std::ptrdiff_t> (imported), calls.end ());
        EXPECT_EQ (sequence_of (run), legacy_run_sequence ());
        EXPECT_TRUE (mcp.live_sessions ().empty ());
    }
}

} // namespace
