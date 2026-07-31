/**
 * @file tests/import_apply_route_test.cpp
 * @brief Tests for POST /import/apply - the atomic bulk import (issue #96).
 *
 * What is pinned here:
 *
 *  - **The id-map is complete and prefixed.** Every `tempId` in the payload maps
 *    to exactly one engine-generated id, `col_` / `req_` / `env_` by kind, and no
 *    temp id ever reaches the database.
 *
 *  - **References resolve through temp ids, in any order.** A child collection
 *    may appear before its parent, and a request before its collection; the
 *    stored `parentId` / `collectionId` carry the *real* ids.
 *
 *  - **Atomicity.** One bad item is a 400 and leaves the database untouched.
 *    This is the assertion that would have caught the old per-item path's
 *    half-created tree, so each failure case checks the row counts, not just the
 *    status code.
 *
 *  - **Cycles in the payload's own parent graph are rejected.** The DB-side
 *    ancestor walk cannot see them (nothing is stored yet), and a cycle is what
 *    made cascade delete loop forever under the global mutex (issue #79).
 *
 *  - **Per-item POST still creates.** The bulk endpoint replaces the app's usage,
 *    not the public create API (that removal is #97), so a plain
 *    `create_collection_response` is exercised alongside.
 *
 * Follows the suite's route-test convention (requests_route_test.cpp): the
 * route's extracted core is exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <memory>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in import.cpp / collections.cpp; each returns {http_status, json_body}
// - the same pair the HTTP handler writes out.
std::pair<int, nlohmann::json>
import_apply_response (vayu::db::Database& db, const nlohmann::json& body);
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::create_collection_response;
using vayu::http::routes::import_apply_response;

class ImportApplyRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_import_apply_route.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        for (const char* suffix : { "", "-wal", "-shm" }) {
            std::filesystem::remove (std::string (DB_PATH) + suffix);
        }
    }

    /** Total rows across the three imported resources. */
    size_t stored_rows () {
        size_t requests = 0;
        for (const auto& c : db_->get_collections ()) {
            requests += db_->get_requests_in_collection (c.id).size ();
        }
        return db_->get_collections ().size () + requests + db_->get_environments ().size ();
    }

    static json collection_item (const std::string& temp_id, const std::string& name) {
        return json{ { "tempId", temp_id }, { "name", name } };
    }

    static json request_item (const std::string& temp_id,
    const std::string& owner_temp_id,
    const std::string& name) {
        return json{ { "tempId", temp_id }, { "collectionTempId", owner_temp_id },
            { "name", name }, { "method", "GET" }, { "url", "https://example.com" } };
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (ImportApplyRouteTest, MapsEveryTempIdToAPrefixedEngineId) {
    json body{ { "collections", json::array ({ collection_item ("c1", "root") }) },
        { "requests", json::array ({ request_item ("r1", "c1", "get users") }) },
        { "environments", json::array ({ json{ { "tempId", "e1" }, { "name", "Prod" } } }) } };

    auto [status, response] = import_apply_response (*db_, body);
    ASSERT_EQ (status, 200) << response.dump ();

    const auto& id_map = response["idMap"];
    ASSERT_EQ (id_map.size (), 3u);
    EXPECT_EQ (id_map["c1"].get<std::string> ().rfind ("col_", 0), 0u);
    EXPECT_EQ (id_map["r1"].get<std::string> ().rfind ("req_", 0), 0u);
    EXPECT_EQ (id_map["e1"].get<std::string> ().rfind ("env_", 0), 0u);

    // The temp ids are opaque client strings and must not be stored anywhere.
    ASSERT_TRUE (db_->get_collection (id_map["c1"].get<std::string> ()).has_value ());
    EXPECT_FALSE (db_->get_collection ("c1").has_value ());
    EXPECT_FALSE (db_->get_request ("r1").has_value ());
    EXPECT_FALSE (db_->get_environment ("e1").has_value ());
}

TEST_F (ImportApplyRouteTest, WiresANestedTreeThroughRealIds) {
    // Deliberately out of order: the child precedes its parent, and the request
    // precedes the collection that owns it. Forward references must resolve.
    json child  = collection_item ("c2", "child");
    child["parentTempId"] = "c1";
    json body{ { "requests", json::array ({ request_item ("r1", "c2", "in child") }) },
        { "collections", json::array ({ child, collection_item ("c1", "root") }) } };

    auto [status, response] = import_apply_response (*db_, body);
    ASSERT_EQ (status, 200) << response.dump ();

    const std::string root_id  = response["idMap"]["c1"];
    const std::string child_id = response["idMap"]["c2"];
    const std::string req_id   = response["idMap"]["r1"];

    auto stored_child = db_->get_collection (child_id);
    ASSERT_TRUE (stored_child.has_value ());
    ASSERT_TRUE (stored_child->parent_id.has_value ());
    EXPECT_EQ (*stored_child->parent_id, root_id);
    EXPECT_FALSE (db_->get_collection (root_id)->parent_id.has_value ());

    auto stored_request = db_->get_request (req_id);
    ASSERT_TRUE (stored_request.has_value ());
    EXPECT_EQ (stored_request->collection_id, child_id);
    EXPECT_EQ (db_->get_requests_in_collection (child_id).size (), 1u);
}

TEST_F (ImportApplyRouteTest, AppliesTheSameFieldDefaultsAsPerItemCreate) {
    json collection = collection_item ("c1", "root");
    collection["variables"] = json{ { "base", { { "value", "1" }, { "enabled", true } } } };
    json request            = request_item ("r1", "c1", "get");
    request["body"]         = json{ { "mode", "json" }, { "content", "{}" } };
    request["bodyType"]     = "json";

    auto [status, response] = import_apply_response (*db_,
    json{ { "collections", json::array ({ collection }) },
        { "requests", json::array ({ request }) } });
    ASSERT_EQ (status, 200) << response.dump ();

    auto stored_collection = db_->get_collection (response["idMap"]["c1"]);
    ASSERT_TRUE (stored_collection.has_value ());
    EXPECT_EQ (stored_collection->auth, R"({"mode":"none"})"); // collection default
    EXPECT_EQ (json::parse (stored_collection->variables)["base"]["value"], "1");
    EXPECT_EQ (stored_collection->description, "");

    auto stored_request = db_->get_request (response["idMap"]["r1"]);
    ASSERT_TRUE (stored_request.has_value ());
    EXPECT_EQ (stored_request->auth, R"({"mode":"inherit"})"); // request default
    EXPECT_EQ (stored_request->params, "[]");
    EXPECT_EQ (stored_request->headers, "[]");
    EXPECT_EQ (stored_request->body_type, "json");
    EXPECT_TRUE (stored_request->follow_redirects);
    EXPECT_EQ (stored_request->max_redirects, 10);
}

TEST_F (ImportApplyRouteTest, AppendsSiblingsInPayloadOrderWhenOrderIsOmitted) {
    // Nothing is persisted mid-transaction, so the stored-row scan that computes
    // the default order cannot see the payload's own siblings - without the
    // per-parent counter every root would land on the same number.
    auto [status, response] = import_apply_response (*db_,
    json{ { "collections",
    json::array ({ collection_item ("c1", "a"), collection_item ("c2", "b"),
    collection_item ("c3", "c") }) } });
    ASSERT_EQ (status, 200) << response.dump ();

    EXPECT_EQ (db_->get_collection (response["idMap"]["c1"])->order, 0);
    EXPECT_EQ (db_->get_collection (response["idMap"]["c2"])->order, 1);
    EXPECT_EQ (db_->get_collection (response["idMap"]["c3"])->order, 2);
}

TEST_F (ImportApplyRouteTest, AnExplicitOrderIsHonoured) {
    json first        = collection_item ("c1", "a");
    first["order"]    = 7;
    auto [status, response] =
    import_apply_response (*db_, json{ { "collections", json::array ({ first }) } });
    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (db_->get_collection (response["idMap"]["c1"])->order, 7);
}

TEST_F (ImportApplyRouteTest, AppendsAfterCollectionsThatAlreadyExist) {
    auto [existing_status, existing] =
    create_collection_response (*db_, json{ { "name", "already here" } });
    ASSERT_EQ (existing_status, 200) << existing.dump ();
    ASSERT_EQ (db_->get_collection (existing["id"])->order, 0);

    auto [status, response] = import_apply_response (*db_,
    json{ { "collections", json::array ({ collection_item ("c1", "new") }) } });
    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (db_->get_collection (response["idMap"]["c1"])->order, 1);
}

TEST_F (ImportApplyRouteTest, WritesNothingWhenOneItemIsInvalid) {
    json bad_request = request_item ("r2", "c1", "no method");
    bad_request.erase ("method");

    auto [status, response] = import_apply_response (*db_,
    json{ { "collections", json::array ({ collection_item ("c1", "root") }) },
        { "requests", json::array ({ request_item ("r1", "c1", "fine"), bad_request }) },
        { "environments", json::array ({ json{ { "tempId", "e1" }, { "name", "Prod" } } }) } });

    EXPECT_EQ (status, 400);
    EXPECT_EQ (response["error"]["item"], "r2");
    EXPECT_NE (response["error"]["message"].get<std::string> ().find ("method"), std::string::npos);
    EXPECT_EQ (stored_rows (), 0u); // the valid items must not have landed either
}

TEST_F (ImportApplyRouteTest, RejectsANullNameThatHasNoDefault) {
    json collection    = collection_item ("c1", "root");
    collection["name"] = nullptr;

    auto [status, response] =
    import_apply_response (*db_, json{ { "collections", json::array ({ collection }) } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (response["error"]["item"], "c1");
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, RejectsAWrongTypedFieldWithA400NotA500) {
    // A non-string `name` makes the shared applier throw a json type_error; the
    // core must turn that into a per-item 400 rather than letting it escape as a
    // 500 (the whole payload is one transaction, so an escape is a lost import
    // with no explanation).
    json collection    = collection_item ("c1", "root");
    collection["name"] = 42;

    auto [status, response] =
    import_apply_response (*db_, json{ { "collections", json::array ({ collection }) } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (response["error"]["item"], "c1");
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, RejectsAnUnknownParentTempId) {
    json child            = collection_item ("c2", "child");
    child["parentTempId"] = "nope";

    auto [status, response] = import_apply_response (*db_,
    json{ { "collections", json::array ({ collection_item ("c1", "root"), child }) } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (response["error"]["item"], "c2");
    EXPECT_NE (response["error"]["message"].get<std::string> ().find ("parentTempId"), std::string::npos);
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, RejectsAnUnknownCollectionTempId) {
    auto [status, response] = import_apply_response (*db_,
    json{ { "requests", json::array ({ request_item ("r1", "c9", "orphan") }) } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (response["error"]["item"], "r1");
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, RejectsARequestWhoseOwnerIsNotACollection) {
    // An environment's temp id is in the same namespace but is not a collection.
    auto [status, response] = import_apply_response (*db_,
    json{ { "environments", json::array ({ json{ { "tempId", "e1" }, { "name", "Prod" } } }) },
        { "requests", json::array ({ request_item ("r1", "e1", "wrong owner") }) } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (response["error"]["item"], "r1");
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, RejectsACycleInParentTempIds) {
    json a            = collection_item ("c1", "a");
    json b            = collection_item ("c2", "b");
    a["parentTempId"] = "c2";
    b["parentTempId"] = "c1";

    auto [status, response] =
    import_apply_response (*db_, json{ { "collections", json::array ({ a, b }) } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (response["error"]["message"].get<std::string> ().find ("Cycle"), std::string::npos);
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, RejectsASelfParent) {
    json self            = collection_item ("c1", "a");
    self["parentTempId"] = "c1";

    auto [status, response] =
    import_apply_response (*db_, json{ { "collections", json::array ({ self }) } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (response["error"]["item"], "c1");
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, RejectsADuplicateTempId) {
    auto [status, response] = import_apply_response (*db_,
    json{ { "collections", json::array ({ collection_item ("c1", "a") }) },
        { "environments", json::array ({ json{ { "tempId", "c1" }, { "name", "clash" } } }) } });
    EXPECT_EQ (status, 400);
    EXPECT_EQ (response["error"]["item"], "c1");
    EXPECT_NE (response["error"]["message"].get<std::string> ().find ("Duplicate"), std::string::npos);
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, RejectsAMissingTempId) {
    auto [status, response] = import_apply_response (*db_,
    json{ { "collections", json::array ({ json{ { "name", "no temp id" } } }) } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (response["error"]["message"].get<std::string> ().find ("tempId"), std::string::npos);
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, RejectsAClientSuppliedId) {
    json collection  = collection_item ("c1", "root");
    collection["id"] = "col_mine";

    auto [status, response] =
    import_apply_response (*db_, json{ { "collections", json::array ({ collection }) } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (response["error"]["message"].get<std::string> ().find ("'id' is not accepted"), std::string::npos);
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, RejectsANonArraySection) {
    auto [status, response] =
    import_apply_response (*db_, json{ { "collections", "not an array" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (response["error"]["message"].get<std::string> ().find ("collections"), std::string::npos);
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, EnforcesTheItemCap) {
    json collections = json::array ();
    for (int i = 0; i < 10001; ++i) {
        collections.push_back (collection_item ("c" + std::to_string (i), "c"));
    }
    auto [status, response] =
    import_apply_response (*db_, json{ { "collections", collections } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (response["error"]["message"].get<std::string> ().find ("too large"), std::string::npos);
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, AnAbsentSectionMeansNone) {
    // Absent and null both mean "no items of that kind", matching the
    // null-vs-absent rule the resource writes follow.
    auto [status, response] = import_apply_response (*db_,
    json{ { "collections", json::array ({ collection_item ("c1", "root") }) },
        { "requests", nullptr } });
    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (response["idMap"].size (), 1u);
    EXPECT_EQ (stored_rows (), 1u);
}

TEST_F (ImportApplyRouteTest, RejectsANonObjectBody) {
    auto [status, response] = import_apply_response (*db_, json::array ());
    EXPECT_EQ (status, 400);
    EXPECT_EQ (stored_rows (), 0u);
}

TEST_F (ImportApplyRouteTest, RejectsAnObjectFieldGivenANonObject) {
    // #148 made `apply_json_field` reject a wrong *shape* (`{"auth": "bearer"}`
    // stored a string every reader then silently dropped, so a request the user
    // believed carried credentials went out bare). Bulk import inherits that
    // guard for free because it routes through the same appliers rather than
    // copying them - this pins that it does, for all six object-shaped fields.
    // A copy made in import.cpp would pass every other test in this file.
    struct Case {
        const char* section;
        json item;
        const char* field;
    };
    json collection = collection_item ("c1", "root");
    json request    = request_item ("r1", "c1", "get users");
    json environment{ { "tempId", "e1" }, { "name", "Prod" } };

    const Case cases[] = {
        { "collections", collection, "variables" },
        { "collections", collection, "auth" },
        { "requests", request, "body" },
        { "requests", request, "auth" },
        { "environments", environment, "variables" },
    };

    for (const auto& c : cases) {
        for (const json bad_shape :
        { json (42), json ("bearer"), json::array ({ 1, 2 }) }) {
            json item     = c.item;
            item[c.field] = bad_shape;
            json body     = { { c.section, json::array ({ item }) } };
            // A request needs its owner collection in the payload to get as far
            // as its own field application.
            if (std::string (c.section) == "requests") {
                body["collections"] = json::array ({ collection });
            }

            auto [status, response] = import_apply_response (*db_, body);
            EXPECT_EQ (status, 400) << c.field << " = " << bad_shape.dump ();
            EXPECT_NE (response["error"]["message"].get<std::string> ().find (c.field), std::string::npos)
            << "the 400 must name the offending field, got " << response.dump ();
            EXPECT_EQ (stored_rows (), 0u) << c.field << " = " << bad_shape.dump ();
        }
    }
}

TEST_F (ImportApplyRouteTest, PerItemCreateStillWorksForThirdPartyClients) {
    // The bulk endpoint replaces the app's usage of POST /collections, not the
    // public create API - removing that is #97.
    auto [status, body] = create_collection_response (*db_, json{ { "name", "by hand" } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["id"].get<std::string> ().rfind ("col_", 0), 0u);
    EXPECT_TRUE (db_->get_collection (body["id"]).has_value ());
}

} // namespace
