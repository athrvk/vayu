/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/import_mcp_apply_route_test.cpp
 * @brief `POST /import/mcp/apply` (#3994): the rows of a re-imported MCP
 *        server's diff a caller selects are written to the collection the
 *        first import built, keyed by request id, all or nothing.
 *
 * `ImportMcpApplyRouteTest` drives the route's core against `McpFixtureServer` and
 * a scratch database holding what `POST /import/apply` stored.
 */

// First, before anything that includes <httplib.h>: see the header.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "mcp_fixture_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/utils/invariant.hpp"
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
std::pair<int, nlohmann::json> import_mcp_apply_response (vayu::db::Database& db,
const nlohmann::json& body,
const vayu::http::TransportPolicy& transport,
const std::atomic<bool>* cancel);
// Defined in import.cpp.
std::pair<int, nlohmann::json>
import_apply_response (vayu::db::Database& db, const nlohmann::json& body);
} // namespace vayu::http::routes

namespace {

using nlohmann::json;
using vayu::tests::McpFixtureServer;

/// A tool whose `inputSchema` requires each of @p arguments, so each argument
/// list is a schema of its own.
json tool (const std::string& name,
const std::vector<std::string>& arguments,
const std::string& description = "") {
    json properties = json::object ();
    for (const auto& argument : arguments) {
        properties[argument] = { { "type", "string" } };
    }
    json entry{ { "name", name },
        { "inputSchema",
        { { "type", "object" }, { "properties", properties }, { "required", arguments } } } };
    if (!description.empty ()) {
        entry["description"] = description;
    }
    return entry;
}

/// Every stored field a person can edit, and the stamp a write moves.
std::vector<std::string> row_fields (const vayu::db::Request& row) {
    return { row.collection_id, row.name, row.description, row.url, row.params,
        row.headers, row.body, row.auth, row.elements,
        std::to_string (row.order), std::to_string (row.updated_at) };
}

json body_of (const vayu::db::Request& row) {
    return json::parse (row.body);
}

json call_of (const vayu::db::Request& row) {
    return json::parse (body_of (row).at ("content").get<std::string> ());
}

/// A `select.renamed` entry.
json renaming (const std::string& request_id, const std::string& key) {
    return json{ { "requestId", request_id }, { "key", key } };
}

} // namespace

class ImportMcpApplyRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_import_mcp_apply_route.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// Imports @p body and applies the tree, as the Import dialog does, and
    /// answers the root collection's id.
    std::string import_and_apply (const json& body) {
        const auto [status, result] = vayu::http::routes::import_mcp_response (
        body, vayu::http::TransportPolicy{}, nullptr);
        EXPECT_EQ (status, 200) << result.dump ();
        const auto tree = vayu::utils::parse_ordered_json (
        result.dump (), vayu::utils::ORDERED_JSON_UNBOUNDED);
        if (!tree) {
            ADD_FAILURE () << "the import's tree did not parse";
            return {};
        }
        const auto [applied_status, applied] = vayu::http::routes::import_apply_response (
        *db_, vayu::core::import_apply_payload (*tree));
        EXPECT_EQ (applied_status, 200) << applied.dump ();
        return applied.at ("idMap").value ("c1", "");
    }

    std::pair<int, json> apply (json body, const std::string& collection_id, json select) {
        body["collectionId"] = collection_id;
        body["select"]       = std::move (select);
        return vayu::http::routes::import_mcp_apply_response (
        *db_, body, vayu::http::TransportPolicy{}, nullptr);
    }

    /// The one match a diff of @p body answers, after a failure an empty object.
    json only_match (const json& body) {
        const auto [status, answer] = vayu::http::routes::import_mcp_diff_response (
        *db_, body, vayu::http::TransportPolicy{}, nullptr);
        EXPECT_EQ (status, 200) << answer.dump ();
        const auto matches = answer.value ("matches", json::array ());
        EXPECT_EQ (matches.size (), 1U) << answer.dump ();
        return matches.size () == 1 ? matches.at (0) : json::object ();
    }

    /// The stored request named @p name.
    std::optional<vayu::db::Request> request_named (const std::string& name) {
        for (const auto& row : db_->get_requests_in_live_collections ()) {
            if (row.name == name) {
                return row;
            }
        }
        return std::nullopt;
    }

    std::string request_id (const std::string& name) {
        const auto row = request_named (name);
        if (!row) {
            ADD_FAILURE () << "no stored request named " << name;
            return {};
        }
        return row->id;
    }

    /// @p row with what a person saves on a request: an argument and an
    /// assertion, stored and read back.
    std::optional<vayu::db::Request> save_edits (std::optional<vayu::db::Request> row) {
        if (!row) {
            return std::nullopt;
        }
        json body                            = body_of (*row);
        json call                            = call_of (*row);
        call["params"]["arguments"]["saved"] = "by hand";
        body["content"]                      = call.dump ();
        row->body                            = body.dump ();
        row->elements = R"([{"id":"e1","kind":"assert.status","config":{"expected":200}}])";
        db_->save_request (*row);
        return db_->get_request (row->id);
    }

    /// Every stored request's `row_fields`, by id.
    std::map<std::string, std::vector<std::string>> every_row () {
        std::map<std::string, std::vector<std::string>> rows;
        for (const auto& row : db_->get_requests_in_live_collections ()) {
            rows.emplace (row.id, row_fields (row));
        }
        return rows;
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// Mutation check: read the stored row by the listing's index
// (`ground.stored.rows.at (change.fetched)` in `plan_updated`) and `alpha`,
// stored first and now listed second, takes the rename while `search` keeps
// its name.
TEST_F (ImportMcpApplyRouteTest, ARenameUpdatesTheRequestInPlaceAndLeavesASiblingUntouched) {
    McpFixtureServer server;
    server.set_tools (
    json::array ({ tool ("alpha", { "x" }), tool ("search", { "query" }) }));
    const json read{ { "url", server.url () } };
    const std::string root = import_and_apply (read);
    const auto alpha       = request_named ("alpha");
    ASSERT_HAS_VALUE (alpha);
    const auto search = save_edits (request_named ("search"));
    ASSERT_HAS_VALUE (search);

    server.set_tools (
    json::array ({ tool ("find", { "query" }), tool ("alpha", { "x" }) }));
    const auto [status, answer] = apply (read, root,
    json{ { "renamed", json::array ({ renaming (search->id, "find") }) } });

    ASSERT_EQ (status, 200) << answer.dump ();
    EXPECT_EQ (answer,
    (json{ { "collectionId", root }, { "created", json::array () },
    { "updated", json::array ({ search->id }) }, { "deleted", json::array () } }));
    const auto renamed = db_->get_request (search->id);
    ASSERT_HAS_VALUE (renamed);
    EXPECT_EQ (renamed->name, "find");
    EXPECT_EQ (body_of (*renamed).at ("mcpTool").at ("name"), "find");
    EXPECT_EQ (call_of (*renamed).at ("params").at ("name"), "find");
    EXPECT_EQ (call_of (*renamed).at ("params").at ("arguments"),
    call_of (*search).at ("params").at ("arguments"));
    EXPECT_EQ (renamed->elements, search->elements);
    const auto sibling = db_->get_request (alpha->id);
    ASSERT_HAS_VALUE (sibling);
    EXPECT_EQ (row_fields (*sibling), row_fields (*alpha));
    EXPECT_EQ (only_match (read).value ("identical", false), true);
}

// Mutation check: erase a rename candidate's halves from `added` and
// `removed` in `propose_renames` and this apply is a `409`.
TEST_F (ImportMcpApplyRouteTest, AnUnconfirmedRenameAppliesAsTheAddAndTheRemoveItIs) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", { "x" }), tool ("ping", {}) }));
    const json read{ { "url", server.url () } };
    const std::string root    = import_and_apply (read);
    const std::string ping_id = request_id ("ping");

    server.set_tools (json::array ({ tool ("alpha", { "x" }), tool ("health", {}) }));
    ASSERT_EQ (only_match (read).at ("renameCandidates").size (), 1U);
    const auto [status, answer] = apply (read, root,
    json{ { "added", json::array ({ { { "kind", "tool" }, { "key", "health" } } }) },
    { "removed", json::array ({ ping_id }) } });

    ASSERT_EQ (status, 200) << answer.dump ();
    ASSERT_EQ (answer.at ("created").size (), 1U) << answer.dump ();
    EXPECT_EQ (answer.at ("created").at (0).at ("key"), "health");
    EXPECT_EQ (answer.at ("updated"), json::array ());
    EXPECT_EQ (answer.at ("deleted"), json::array ({ ping_id }));
    EXPECT_FALSE (db_->get_request (ping_id).has_value ());
    EXPECT_EQ (only_match (read).value ("identical", false), true);
}

// What the dialog sends for a candidate nobody ticked: the added half alone.
TEST_F (ImportMcpApplyRouteTest, TheDefaultSelectionForARenameCandidateLeavesTheOldRequestAsItIs) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", { "x" }), tool ("ping", {}) }));
    const json read{ { "url", server.url () } };
    const std::string root = import_and_apply (read);
    const auto ping        = save_edits (request_named ("ping"));
    ASSERT_HAS_VALUE (ping);

    server.set_tools (json::array ({ tool ("alpha", { "x" }), tool ("health", {}) }));
    const auto [status, answer] = apply (read, root,
    json{ { "added", json::array ({ { { "kind", "tool" }, { "key", "health" } } }) } });

    ASSERT_EQ (status, 200) << answer.dump ();
    ASSERT_EQ (answer.at ("created").size (), 1U) << answer.dump ();
    EXPECT_EQ (answer.at ("updated"), json::array ());
    EXPECT_TRUE (request_named ("health").has_value ());
    const auto stored = db_->get_request (ping->id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (row_fields (*stored), row_fields (*ping));
}

TEST_F (ImportMcpApplyRouteTest, ARenameTheDiffDidNotProposeIsWrittenWhenConfirmed) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("a", { "id" }), tool ("b", { "id" }) }));
    const json read{ { "url", server.url () } };
    const std::string root = import_and_apply (read);
    const std::string a_id = request_id ("a");
    const auto b           = request_named ("b");
    ASSERT_HAS_VALUE (b);

    // Two removed tools share the added one's schema, so nothing is proposed.
    server.set_tools (json::array ({ tool ("c", { "id" }) }));
    ASSERT_EQ (only_match (read).at ("renameCandidates"), json::array ());
    const auto [status, answer] =
    apply (read, root, json{ { "renamed", json::array ({ renaming (a_id, "c") }) } });

    ASSERT_EQ (status, 200) << answer.dump ();
    EXPECT_EQ (answer.at ("updated"), json::array ({ a_id }));
    EXPECT_EQ (answer.at ("created"), json::array ());
    const auto renamed = db_->get_request (a_id);
    ASSERT_HAS_VALUE (renamed);
    EXPECT_EQ (renamed->name, "c");
    const auto other = db_->get_request (b->id);
    ASSERT_HAS_VALUE (other);
    EXPECT_EQ (row_fields (*other), row_fields (*b));
}

// Mutation check: drop the tool check from `confirmed_rename` and the prompt's
// request is renamed after a tool.
TEST_F (ImportMcpApplyRouteTest, ARenameThatPairsNoRemovedToolWithAnAddedOneIsRefused) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", { "x" }), tool ("ping", {}) }));
    server.set_prompts (json::parse (R"([{"name":"greet"}])"));
    const json read{ { "url", server.url () }, { "include", { { "prompts", true } } } };
    const std::string root     = import_and_apply (read);
    const auto before          = every_row ();
    const std::string alpha_id = request_id ("alpha");
    const std::string ping_id  = request_id ("ping");
    const std::string greet_id = request_id ("greet");

    server.set_tools (json::array ({ tool ("alpha", { "x" }), tool ("health", {}) }));
    server.set_prompts (json::array ());
    const auto refused = [&] (const std::string& request, const std::string& key) {
        return apply (read, root,
        json{ { "renamed", json::array ({ renaming (request, key) }) } });
    };
    EXPECT_EQ (refused (alpha_id, "health").first, 409)
    << "a request still listed";
    EXPECT_EQ (refused (ping_id, "alpha").first, 409) << "a key not added";
    EXPECT_EQ (refused (ping_id, "missing").first, 409) << "a key not listed";
    const auto [status, answer] = refused (greet_id, "health");
    EXPECT_EQ (status, 409) << answer.dump ();
    EXPECT_NE (
    answer.dump ().find ("pairs a removed tool with an added tool only"), std::string::npos)
    << answer.dump ();

    EXPECT_EQ (every_row (), before);
}

TEST_F (ImportMcpApplyRouteTest, AnAddedEntryBecomesTheRequestAnImportBuildsInItsFolder) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", { "x" }) }));
    const json read{ { "url", server.url () } };
    const std::string root = import_and_apply (read);
    const auto alpha       = request_named ("alpha");
    ASSERT_HAS_VALUE (alpha);

    server.set_tools (
    json::array ({ tool ("alpha", { "x" }), tool ("beta", { "y" }, "Says beta") }));
    const auto [status, answer] = apply (read, root,
    json{ { "added", json::array ({ { { "kind", "tool" }, { "key", "beta" } } }) } });

    ASSERT_EQ (status, 200) << answer.dump ();
    ASSERT_EQ (answer.at ("created").size (), 1U) << answer.dump ();
    EXPECT_EQ (answer.at ("created").at (0).at ("kind"), "tool");
    EXPECT_EQ (answer.at ("created").at (0).at ("key"), "beta");
    const auto beta = db_->get_request (
    answer.at ("created").at (0).at ("requestId").get<std::string> ());
    ASSERT_HAS_VALUE (beta);
    EXPECT_EQ (beta->name, "beta");
    EXPECT_EQ (beta->description, "Says beta");
    EXPECT_EQ (beta->collection_id, alpha->collection_id)
    << "not in the Tools folder";
    EXPECT_GT (beta->order, alpha->order);
    EXPECT_EQ (body_of (*beta).at ("mcpTool").at ("name"), "beta");
    EXPECT_TRUE (call_of (*beta).at ("params").at ("arguments").contains ("y"));
    EXPECT_EQ (only_match (read).value ("identical", false), true);
}

TEST_F (ImportMcpApplyRouteTest, AnAddedEntryWhoseFolderTheCollectionLacksGetsOneFolder) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", { "x" }) }));
    const std::string root = import_and_apply (json{ { "url", server.url () } });

    server.set_prompts (json::parse (R"([{"name":"greet"},{"name":"part"}])"));
    const json with_prompts{ { "url", server.url () },
        { "include", { { "prompts", true } } } };
    const auto [status, answer] = apply (with_prompts, root,
    json{ { "added",
    json::array ({ { { "kind", "prompt" }, { "key", "greet" } },
    { { "kind", "prompt" }, { "key", "part" } } }) } });

    ASSERT_EQ (status, 200) << answer.dump ();
    std::vector<vayu::db::Collection> prompts;
    for (const auto& collection : db_->get_collections ()) {
        if (collection.name == "Prompts") {
            prompts.push_back (collection);
        }
    }
    ASSERT_EQ (prompts.size (), 1U);
    EXPECT_EQ (prompts.front ().parent_id, std::optional<std::string> (root));
    EXPECT_EQ (db_->get_requests_in_collection (prompts.front ().id).size (), 2U);
}

TEST_F (ImportMcpApplyRouteTest, ARemovedRequestIsDeletedOnlyWhenSelected) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", { "x" }), tool ("beta", { "y" }) }));
    const json read{ { "url", server.url () } };
    const std::string root    = import_and_apply (read);
    const std::string beta_id = request_id ("beta");
    server.set_tools (json::array ({ tool ("alpha", { "x" }) }));

    const auto [kept_status, kept] = apply (read, root, json::object ());
    ASSERT_EQ (kept_status, 200) << kept.dump ();
    EXPECT_EQ (kept.at ("deleted"), json::array ());
    EXPECT_TRUE (db_->get_request (beta_id).has_value ());

    const auto [status, answer] =
    apply (read, root, json{ { "removed", json::array ({ beta_id }) } });
    ASSERT_EQ (status, 200) << answer.dump ();
    EXPECT_EQ (answer.at ("deleted"), json::array ({ beta_id }));
    EXPECT_FALSE (db_->get_request (beta_id).has_value ());
    EXPECT_TRUE (request_named ("alpha").has_value ());
}

TEST_F (ImportMcpApplyRouteTest, AnUnselectedChangedRequestIsLeftAsItIs) {
    McpFixtureServer server;
    server.set_tools (json::array (
    { tool ("alpha", { "x" }, "Old alpha"), tool ("beta", { "y" }, "Old beta") }));
    const json read{ { "url", server.url () } };
    const std::string root = import_and_apply (read);
    const auto beta        = request_named ("beta");
    ASSERT_HAS_VALUE (beta);
    const std::string alpha_id = request_id ("alpha");

    server.set_tools (json::array (
    { tool ("alpha", { "x" }, "New alpha"), tool ("beta", { "y" }, "New beta") }));
    const auto [status, answer] =
    apply (read, root, json{ { "changed", json::array ({ alpha_id }) } });

    ASSERT_EQ (status, 200) << answer.dump ();
    const auto alpha = db_->get_request (alpha_id);
    ASSERT_HAS_VALUE (alpha);
    EXPECT_EQ (alpha->description, "New alpha");
    const auto stored_beta = db_->get_request (beta->id);
    ASSERT_HAS_VALUE (stored_beta);
    EXPECT_EQ (row_fields (*stored_beta), row_fields (*beta));
}

// Mutation check: patch the whole listed body over the stored one in
// `change_patch` and the edited argument is lost.
TEST_F (ImportMcpApplyRouteTest, ArgumentsAPersonEditedSurviveASchemaChange) {
    McpFixtureServer server;
    server.set_tools (json::array ({ tool ("alpha", { "x" }) }));
    const json read{ { "url", server.url () } };
    const std::string root = import_and_apply (read);
    auto edited            = request_named ("alpha");
    ASSERT_HAS_VALUE (edited);
    json body = body_of (*edited);
    json call = json::parse (body.at ("content").get<std::string> ());
    call["params"]["arguments"] = { { "x", "edited by hand" } };
    body["content"]             = call.dump ();
    edited->body                = body.dump ();
    edited->headers = R"([{"key":"X-Team","value":"core","enabled":true}])";
    db_->save_request (*edited);

    const json changed = tool ("alpha", { "x", "y" });
    server.set_tools (json::array ({ changed }));
    const auto [status, answer] =
    apply (read, root, json{ { "changed", json::array ({ edited->id }) } });

    ASSERT_EQ (status, 200) << answer.dump ();
    const auto stored = db_->get_request (edited->id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (body_of (*stored).at ("mcpTool").at ("inputSchema"),
    changed.at ("inputSchema"));
    EXPECT_EQ (call_of (*stored).at ("params").at ("arguments"),
    (json{ { "x", "edited by hand" } }));
    EXPECT_EQ (stored->headers, edited->headers);
    EXPECT_EQ (stored->name, "alpha");
}

// Mutation check: let `selected_rows` skip a changed row the diff lost and
// the still-valid removal of `beta` is written.
TEST_F (ImportMcpApplyRouteTest, ASelectionTheDiffNoLongerHoldsIsRefusedAndNothingIsWritten) {
    McpFixtureServer server;
    server.set_tools (
    json::array ({ tool ("alpha", { "x" }, "Old alpha"), tool ("beta", { "y" }) }));
    const json read{ { "url", server.url () } };
    const std::string root = import_and_apply (read);
    const auto alpha       = request_named ("alpha");
    ASSERT_HAS_VALUE (alpha);
    const std::string beta_id = request_id ("beta");

    // Read when `alpha` had changed and `beta` was gone; the server has since
    // gone back on `alpha`, so the selection names a row the diff lost.
    server.set_tools (json::array ({ tool ("alpha", { "x" }, "Old alpha") }));
    const auto [status, answer] = apply (read, root,
    json{ { "changed", json::array ({ alpha->id }) },
    { "removed", json::array ({ beta_id }) } });

    EXPECT_EQ (status, 409) << answer.dump ();
    EXPECT_TRUE (db_->get_request (beta_id).has_value ())
    << "a valid row was written";
    const auto stored = db_->get_request (alpha->id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (row_fields (*stored), row_fields (*alpha));
}

TEST_F (ImportMcpApplyRouteTest, ACollectionNoImportOfTheUrlBuiltIsRefused) {
    McpFixtureServer server;
    McpFixtureServer other;
    server.set_tools (json::array ({ tool ("alpha", { "x" }) }));
    other.set_tools (json::array ({ tool ("alpha", { "x" }) }));
    const std::string root = import_and_apply (json{ { "url", server.url () } });
    const std::string tools_folder =
    vayu::utils::invariant_value (request_named ("alpha"), "imported above").collection_id;

    const json other_read{ { "url", other.url () } };
    EXPECT_EQ (apply (other_read, "col_missing", json::object ()).first, 404);
    EXPECT_EQ (apply (other_read, root, json::object ()).first, 409);
    EXPECT_EQ (
    apply (json{ { "url", server.url () } }, tools_folder, json::object ()).first, 409)
    << "a folder is no root";
}

TEST_F (ImportMcpApplyRouteTest, AMalformedSelectionIsRefusedBeforeAnyCall) {
    McpFixtureServer server;
    const json read{ { "url", server.url () } };
    const auto refused = [&] (const json& body) {
        return vayu::http::routes::import_mcp_apply_response (
        *db_, body, vayu::http::TransportPolicy{}, nullptr)
        .first;
    };
    EXPECT_EQ (refused (read), 400) << "no collectionId";
    for (const json& select : {
         json{ { "added", json::array ({ { { "kind", "widget" }, { "key", "a" } } }) } },
         json{ { "added",
         json::array ({ { { "kind", "tool" }, { "key", "a" } },
         { { "kind", "tool" }, { "key", "a" } } }) } },
         json{ { "changed", json::array ({ "req_a" }) },
         { "removed", json::array ({ "req_a" }) } },
         json{ { "changed", "req_a" } },
         json{ { "renames", json::array () } },
         }) {
        EXPECT_EQ (apply (read, "col_a", select).first, 400) << select.dump ();
    }
    EXPECT_EQ (server.requests (), 0U);
}

// Mutation check: give `read_selected_renamed` a `seen` set of its own and a
// request id also named in `select.removed` is no longer refused.
TEST_F (ImportMcpApplyRouteTest, AMalformedRenameIsRefusedBeforeAnyCall) {
    McpFixtureServer server;
    const json read{ { "url", server.url () } };
    const json add_b = json::array ({ { { "kind", "tool" }, { "key", "b" } } });
    for (const json& select :
    {
    json{ { "renamed", "req_a" } },
    json{ { "renamed", json::array ({ "req_a" }) } },
    json{ { "renamed", json::array ({ json{ { "requestId", "req_a" } } }) } },
    json{ { "renamed", json::array ({ renaming ("", "b") }) } },
    json{ { "renamed", json::array ({ renaming ("req_a", "") }) } },
    json{ { "renamed", json::array ({ json{ { "requestId", 1 }, { "key", "b" } } }) } },
    json{ { "renamed", json::array ({ renaming ("req_a", "b"), renaming ("req_a", "c") }) } },
    json{ { "renamed", json::array ({ renaming ("req_a", "b"), renaming ("req_c", "b") }) } },
    json{ { "renamed", json::array ({ renaming ("req_a", "b") }) },
    { "changed", json::array ({ "req_a" }) } },
    json{ { "renamed", json::array ({ renaming ("req_a", "b") }) },
    { "removed", json::array ({ "req_a" }) } },
    json{ { "renamed", json::array ({ renaming ("req_a", "b") }) }, { "added", add_b } },
    }) {
        EXPECT_EQ (apply (read, "col_a", select).first, 400) << select.dump ();
    }
    EXPECT_EQ (server.requests (), 0U);
}

// Mutation check: drop `renumber_envelope` from `plan_created` and the new
// call reuses the number a stored one carries.
TEST_F (ImportMcpApplyRouteTest, ACreatedLegacyCallTakesAnEnvelopeIdNoStoredCallCarries) {
    McpFixtureServer server;
    server.speak_legacy ();
    server.set_tools (json::array ({ tool ("alpha", { "x" }), tool ("beta", { "y" }) }));
    const json read{ { "url", server.url () } };
    const std::string root = import_and_apply (read);

    server.set_tools (json::array (
    { tool ("added", { "z" }), tool ("alpha", { "x" }), tool ("beta", { "y" }) }));
    const auto [status, answer] = apply (read, root,
    json{ { "added", json::array ({ { { "kind", "tool" }, { "key", "added" } } }) } });
    ASSERT_EQ (status, 200) << answer.dump ();

    std::multiset<std::int64_t> ids;
    for (const auto& row : db_->get_requests_in_live_collections ()) {
        if (!body_of (row).contains ("content")) {
            continue; // `Close session`, a DELETE with no body
        }
        const json call = call_of (row);
        if (call.contains ("id")) {
            ids.insert (call.at ("id").get<std::int64_t> ());
        }
    }
    EXPECT_EQ (ids.size (), 4U) << "initialize and three tools";
    EXPECT_EQ (std::set<std::int64_t> (ids.begin (), ids.end ()).size (), ids.size ());
}
