/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/import_mcp_diff_test.cpp
 * @brief `POST /import/mcp/diff` (#3842): importing an MCP server again is
 *        compared with the collection the first import built, keyed by each
 *        entry's identity, so a renamed tool is a change and not a duplicate.
 *
 * `ImportMcpDiffTest` drives the route's core against `McpFixtureServer` and
 * a scratch database holding what `POST /import/apply` stored; `McpDiff`
 * holds the pure comparison's rules that no fixture listing reaches.
 */

// First, before anything that includes <httplib.h>: see the header.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "mcp_fixture_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/core/mcp_diff.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/utils/ordered_json.hpp"

namespace vayu::http::routes {
// Defined in import_mcp.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> import_mcp_response (const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);
std::pair<int, nlohmann::json> import_mcp_diff_response (vayu::db::Database& db,
const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);
// Defined in import.cpp.
std::pair<int, nlohmann::json>
import_apply_response (vayu::db::Database& db, const nlohmann::json& body);
} // namespace vayu::http::routes

namespace {

using nlohmann::json;
using vayu::core::McpEntry;
using vayu::core::McpEntryKind;
using vayu::core::McpKinds;
using vayu::tests::McpFixtureServer;

/// A tool whose `inputSchema` requires @p argument, so each argument name is
/// a schema of its own.
json tool (const std::string& name,
const std::string& argument,
const std::string& description = "") {
    json entry{ { "name", name },
        { "inputSchema",
        { { "type", "object" }, { "properties", { { argument, { { "type", "string" } } } } },
        { "required", json::array ({ argument }) } } } };
    if (!description.empty ()) {
        entry["description"] = description;
    }
    return entry;
}

std::vector<std::string> keys_of (const json& entries) {
    std::vector<std::string> keys;
    for (const auto& entry : entries) {
        keys.push_back (entry.at ("key").get<std::string> ());
    }
    return keys;
}

} // namespace

class ImportMcpDiffTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_import_mcp_diff.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// Imports @p body and applies the tree, as the Import dialog does.
    void import_and_apply (const json& body) {
        const auto [status, result] = vayu::http::routes::import_mcp_response (
        body, vayu::http::TransportPolicy{}, nullptr);
        ASSERT_EQ (status, 200) << result.dump ();
        const auto tree = vayu::utils::parse_ordered_json (
        result.dump (), vayu::utils::ORDERED_JSON_UNBOUNDED);
        ASSERT_HAS_VALUE (tree);
        const auto [applied_status, applied] = vayu::http::routes::import_apply_response (
        *db_, vayu::core::import_apply_payload (*tree));
        ASSERT_EQ (applied_status, 200) << applied.dump ();
    }

    std::pair<int, json> diff (const json& body) {
        return vayu::http::routes::import_mcp_diff_response (
        *db_, body, vayu::http::TransportPolicy{}, nullptr);
    }

    /// The one match a diff of @p body answers, after a failure an empty one.
    json only_match (const json& body) {
        const auto [status, answer] = diff (body);
        EXPECT_EQ (status, 200) << answer.dump ();
        const auto matches = answer.value ("matches", json::array ());
        EXPECT_EQ (matches.size (), 1U) << answer.dump ();
        if (matches.size () != 1) {
            return json{ { "added", json::array () },
                { "removed", json::array () }, { "changed", json::array () } };
        }
        return matches.at (0);
    }

    /// The stored request named @p name's id, or empty.
    std::string request_id (const std::string& name) {
        for (const auto& collection : db_->get_collections ()) {
            for (const auto& request :
            db_->get_requests_in_collection (collection.id)) {
                if (request.name == name) {
                    return request.id;
                }
            }
        }
        ADD_FAILURE () << "no stored request named " << name;
        return {};
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// Mutation check: key `diff_mcp` on the entry's index instead of its key and
// the renamed tool, listed first now, pairs with `alpha`'s request.
TEST_F (ImportMcpDiffTest, ARenamedToolIsOneChangeNotAnAddAndARemove) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", "x"), tool ("search", "query") }));
    import_and_apply (json{ { "url", server.url () } });
    const std::string search_id = request_id ("search");

    server.set_tools (json::array ({ tool ("find", "query"), tool ("alpha", "x") }));
    const json match = only_match (json{ { "url", server.url () } });

    EXPECT_EQ (match.at ("identical"), false);
    EXPECT_TRUE (match.at ("added").empty ()) << match.dump ();
    EXPECT_TRUE (match.at ("removed").empty ()) << match.dump ();
    ASSERT_EQ (match.at ("changed").size (), 1U) << match.dump ();
    const json& change = match.at ("changed").at (0);
    EXPECT_EQ (change.at ("kind"), "tool");
    EXPECT_EQ (change.at ("key"), "find");
    EXPECT_EQ (change.at ("renamedFrom"), "search");
    EXPECT_EQ (change.at ("requestId"), search_id);
    EXPECT_EQ (change.at ("name"), "search");
    EXPECT_TRUE (change.at ("fields").empty ()) << change.dump ();
}

TEST_F (ImportMcpDiffTest, AToolWithANewSchemaIsAnAddAndTheOneGoneIsARemove) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", "x"), tool ("beta", "y") }));
    import_and_apply (json{ { "url", server.url () } });
    const std::string beta_id = request_id ("beta");

    server.set_tools (json::array ({ tool ("alpha", "x"), tool ("gamma", "z") }));
    const json match = only_match (json{ { "url", server.url () } });

    EXPECT_EQ (keys_of (match.at ("added")), std::vector<std::string>{ "gamma" });
    ASSERT_EQ (match.at ("removed").size (), 1U) << match.dump ();
    EXPECT_EQ (match.at ("removed").at (0).at ("key"), "beta");
    EXPECT_EQ (match.at ("removed").at (0).at ("requestId"), beta_id);
    EXPECT_TRUE (match.at ("changed").empty ()) << match.dump ();
}

// Mutation check: drop the `InputSchema` comparison from `differing_fields`
// and the field list loses it.
TEST_F (ImportMcpDiffTest, AChangedToolNamesEachFieldThatMoved) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", "x", "Old words") }));
    import_and_apply (json{ { "url", server.url () } });

    json changed            = tool ("alpha", "renamed_argument", "New words");
    changed["outputSchema"] = json{ { "type", "object" } };
    server.set_tools (json::array ({ changed }));
    const json match = only_match (json{ { "url", server.url () } });

    ASSERT_EQ (match.at ("changed").size (), 1U) << match.dump ();
    const json& change = match.at ("changed").at (0);
    EXPECT_EQ (change.at ("key"), "alpha");
    EXPECT_EQ (change.at ("fields"),
    json::array ({ "description", "inputSchema", "outputSchema" }));
    EXPECT_FALSE (change.contains ("renamedFrom")) << change.dump ();
    EXPECT_TRUE (match.at ("added").empty ());
    EXPECT_TRUE (match.at ("removed").empty ());
}

TEST_F (ImportMcpDiffTest, TheSameListingInAnotherOrderIsIdentical) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", "x"), tool ("beta", "y") }));
    import_and_apply (json{ { "url", server.url () } });

    server.set_tools (json::array ({ tool ("beta", "y"), tool ("alpha", "x") }));
    const json match = only_match (json{ { "url", server.url () } });

    EXPECT_EQ (match.at ("identical"), true) << match.dump ();
    EXPECT_TRUE (match.at ("added").empty ());
    EXPECT_TRUE (match.at ("removed").empty ());
    EXPECT_TRUE (match.at ("changed").empty ());
    EXPECT_EQ (match.at ("name"), "vayu-fixture");
}

TEST_F (ImportMcpDiffTest, NoCollectionImportedFromTheServerIsNoMatch) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", "x") }));
    const auto [status, answer] = diff (json{ { "url", server.url () } });
    EXPECT_EQ (status, 200) << answer.dump ();
    EXPECT_EQ (answer, json::parse (R"({"matches":[]})"));
}

// Mutation check: compare `mcpBaseUrl` up to its query string in
// `imported_from` and the URL with a key matches the one without.
TEST_F (ImportMcpDiffTest, AnotherUrlMatchesNothingAQueryKeyIncluded) {
    McpFixtureServer server;
    McpFixtureServer other;
    server.set_tools (json::array ({ tool ("alpha", "x") }));
    other.set_tools (json::array ({ tool ("alpha", "x") }));
    import_and_apply (json{ { "url", server.url () } });

    for (const std::string& url : { server.url () + "?key=1", other.url () }) {
        const auto [status, answer] = diff (json{ { "url", url } });
        EXPECT_EQ (status, 200) << url << ": " << answer.dump ();
        EXPECT_EQ (answer.at ("matches"), json::array ()) << url;
    }
}

TEST_F (ImportMcpDiffTest, EachCollectionImportedFromTheServerIsAMatch) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", "x") }));
    import_and_apply (json{ { "url", server.url () } });
    import_and_apply (json{ { "url", server.url () } });

    const auto [status, answer] = diff (json{ { "url", server.url () } });
    ASSERT_EQ (status, 200) << answer.dump ();
    ASSERT_EQ (answer.at ("matches").size (), 2U) << answer.dump ();
    EXPECT_NE (answer.at ("matches").at (0).at ("collectionId"),
    answer.at ("matches").at (1).at ("collectionId"));
}

TEST_F (ImportMcpDiffTest, ALegacyServersHandshakeRequestsAreNotEntries) {
    McpFixtureServer server;
    server.speak_legacy ();
    server.set_tools (json::array ({ tool ("alpha", "x") }));
    import_and_apply (json{ { "url", server.url () } });

    const json match = only_match (json{ { "url", server.url () } });
    EXPECT_EQ (match.at ("identical"), true) << match.dump ();
}

TEST_F (ImportMcpDiffTest, ResourcesAndPromptsAreKeyedByTheirOwnIdentity) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", "x") }));
    server.set_resources (json::parse (
    R"([{"uri":"file:///a.txt","name":"a"},{"uri":"file:///b.txt","name":"b"}])"));
    server.set_prompts (json::parse (R"([{"name":"greet","description":"Hi"}])"));
    const json everything{ { "url", server.url () },
        { "include", { { "resources", true }, { "prompts", true } } } };
    import_and_apply (everything);

    server.set_resources (json::parse (
    R"([{"uri":"file:///b.txt","name":"renamed b"},{"uri":"file:///c.txt","name":"c"}])"));
    server.set_prompts (json::parse (R"([{"name":"greet","description":"Hello"}])"));
    const json match = only_match (everything);

    EXPECT_EQ (keys_of (match.at ("added")), std::vector<std::string>{ "file:///c.txt" });
    EXPECT_EQ (keys_of (match.at ("removed")), std::vector<std::string>{ "file:///a.txt" });
    ASSERT_EQ (match.at ("changed").size (), 1U) << match.dump ();
    EXPECT_EQ (match.at ("changed").at (0).at ("kind"), "prompt");
    EXPECT_EQ (match.at ("changed").at (0).at ("fields"), json::array ({ "description" }));

    // A tools-only read asked nothing about the other folders, so it reports
    // none of their requests removed.
    const json tools_only = only_match (json{ { "url", server.url () } });
    EXPECT_EQ (tools_only.at ("identical"), true) << tools_only.dump ();
}

TEST_F (ImportMcpDiffTest, ABodyThatNamesNoUsableServerIsRefusedBeforeAnyCall) {
    McpFixtureServer server;
    const auto [status, answer] = diff (json{ { "url", "ftp://example.com/mcp" } });
    EXPECT_EQ (status, 400) << answer.dump ();
    EXPECT_EQ (server.requests (), 0U);
}

// ---------------------------------------------------------------------------
// The comparison's own rules.
// ---------------------------------------------------------------------------

namespace {

/// A tool entry with an `inputSchema` of `{"title": schema}`.
McpEntry tool_entry (const std::string& key, const std::string& schema) {
    return McpEntry{ .kind = McpEntryKind::Tool,
        .key               = key,
        .name              = key,
        .description       = "",
        .input_schema      = json{ { "title", schema } },
        .output_schema     = nullptr };
}

constexpr McpKinds ALL_KINDS{ .tools = true, .resources = true, .prompts = true };

} // namespace

TEST (McpDiff, ARenameWhoseSchemaTwoRemovedToolsShareIsAnAddAndTwoRemoves) {
    const std::vector<McpEntry> stored{ tool_entry ("a", "same"), tool_entry ("b", "same") };
    const std::vector<McpEntry> fetched{ tool_entry ("c", "same") };
    const auto diff = vayu::core::diff_mcp (fetched, ALL_KINDS, stored);
    EXPECT_EQ (diff.added, (std::vector<std::size_t>{ 0 }));
    EXPECT_EQ (diff.removed, (std::vector<std::size_t>{ 0, 1 }));
    EXPECT_TRUE (diff.changed.empty ());
}

TEST (McpDiff, ARenameBesideAnUnrelatedAddIsStillFound) {
    const std::vector<McpEntry> stored{ tool_entry ("a", "one") };
    const std::vector<McpEntry> fetched{ tool_entry ("new", "two"), tool_entry ("b", "one") };
    const auto diff = vayu::core::diff_mcp (fetched, ALL_KINDS, stored);
    EXPECT_EQ (diff.added, (std::vector<std::size_t>{ 0 }));
    EXPECT_TRUE (diff.removed.empty ());
    ASSERT_EQ (diff.changed.size (), 1U);
    EXPECT_TRUE (diff.changed[0].renamed);
    EXPECT_EQ (diff.changed[0].fetched, 1U);
}

TEST (McpDiff, AToolNamedOnlyByItsCallIsKeyedByIt) {
    const json body{ { "mode", "mcp" },
        { "content", R"({"method":"tools/call","params":{"name":"lookup","arguments":{}}})" } };
    const auto entry = vayu::core::mcp_entry_of ("Lookup", "", body);
    ASSERT_HAS_VALUE (entry);
    EXPECT_EQ (entry->kind, McpEntryKind::Tool);
    EXPECT_EQ (entry->key, "lookup");
    EXPECT_TRUE (entry->input_schema.is_null ());
}

TEST (McpDiff, ARequestThatIsNoEntryCallIsNotOne) {
    const auto read = [] (const json& body) {
        return vayu::core::mcp_entry_of ("r", "", body).has_value ();
    };
    EXPECT_FALSE (read (json{ { "mode", "mcp" },
    { "content", R"({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})" } }));
    EXPECT_FALSE (read (json{ { "mode", "json" },
    { "content", R"({"method":"tools/call","params":{"name":"a"}})" } }));
    EXPECT_FALSE (read (json{ { "mode", "mcp" }, { "content", "not json" } }));
    EXPECT_FALSE (read (json{ { "mode", "none" } }));
}
