/**
 * @file tests/spec_export_route_test.cpp
 * @brief Tests for POST /specs/export - a collection back out as an OpenAPI
 *        document (issue #855, phase B's third move).
 *
 * The assembly itself is pinned in openapi_export_test.cpp. What is pinned here
 * is what only the route can get wrong:
 *
 *  - **The subtree is the request set.** An OpenAPI import binds the root and
 *    files every request under a tag sub-collection, so a route that exported
 *    only the named collection's own requests would remove every operation of
 *    exactly the collections this feature exists for.
 *  - **Where the subtree stops** (issue #721): at a collection bound to a
 *    *different* document, and not at one bound to the same.
 *  - **Which document is patched**, and that a binding the store cannot answer
 *    is a refusal rather than a skeleton nobody asked for.
 *  - **Nothing is written** - an export is a read of what the collection
 *    already is.
 *
 * Follows the suite's route-test convention: the route's extracted core is
 * exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in spec_export.cpp / specs.cpp / collections.cpp / requests.cpp /
// examples.cpp; each returns {http_status, json_body} - the pair the handler
// writes out.
std::pair<int, nlohmann::json>
export_spec_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_spec_document_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> create_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

namespace routes = vayu::http::routes;

constexpr const char* PETS_DOC =
R"({"openapi":"3.1.0","info":{"title":"Pets","version":"1.0.0"},)"
R"("x-vendor-note":"kept verbatim",)"
R"("paths":{"/pets":{"get":{"operationId":"listPets","responses":{"200":{"description":"ok"}}},)"
R"("post":{"operationId":"createPet","responses":{"201":{"description":"made"}}}}}})";

constexpr const char* OWNERS_DOC =
R"({"openapi":"3.1.0","info":{"title":"Owners","version":"1.0.0"},)"
R"("paths":{"/owners":{"get":{"operationId":"listOwners","responses":{"200":{"description":"ok"}}}}}})";

class SpecExportRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_spec_export_route.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        root_ = create_collection (json{ { "name", "Pets API" } });
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    std::string store_spec (const char* content) {
        auto [status, body] =
        routes::create_spec_document_response (*db_, json{ { "content", content } });
        EXPECT_EQ (status, 200) << body.dump ();
        return body.value ("id", std::string{});
    }

    std::string create_collection (const json& body) {
        auto [status, response] = routes::create_collection_response (*db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response.value ("id", std::string{});
    }

    void bind (const std::string& collection_id, const std::string& spec_id) {
        auto [status, body] = routes::update_collection_response (*db_, collection_id,
        json{ { "openapi",
        json{ { "specId", spec_id }, { "specHash", "seed" }, { "syncedAt", 1 } } } });
        EXPECT_EQ (status, 200) << body.dump ();
    }

    std::string create_request (const std::string& collection_id,
    const std::string& method,
    const std::string& url,
    const json& identity = json (nullptr)) {
        json body{ { "collectionId", collection_id }, { "name", url },
            { "method", method }, { "url", url } };
        if (!identity.is_null ()) {
            body["specOperation"] = identity;
        }
        auto [status, response] = routes::create_request_response (*db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response.value ("id", std::string{});
    }

    void add_example (const std::string& request_id, const json& body) {
        auto [status, response] =
        routes::create_request_example_response (*db_, request_id, body);
        EXPECT_EQ (status, 200) << response.dump ();
    }

    json export_ok (const json& body) {
        auto [status, response] = routes::export_spec_response (*db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response;
    }

    json export_collection (const std::string& collection_id = {}) {
        return export_ok (
        json{ { "collectionId", collection_id.empty () ? root_ : collection_id } });
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::string root_;
};

TEST_F (SpecExportRouteTest, ExportsRequestsAnywhereBeneathTheNamedCollection) {
    // The shape an OpenAPI import leaves: the root owns no request at all, and
    // every one of them lives in a tag sub-collection under it. A route that
    // read only the root's own requests would report both operations removed.
    const std::string spec = store_spec (PETS_DOC);
    bind (root_, spec);
    const std::string tag =
    create_collection (json{ { "name", "pets" }, { "parentId", root_ } });
    create_request (tag, "GET", "{{baseUrl}}/pets",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } });
    create_request (tag, "POST", "{{baseUrl}}/pets",
    json{ { "operationId", "createPet" }, { "method", "POST" }, { "path", "/pets" } });

    const json body     = export_collection ();
    const json document = json::parse (body["text"].get<std::string> ());
    EXPECT_EQ (body["notes"]["direction"], "document");
    EXPECT_EQ (body["notes"]["requestsExported"], 2);
    EXPECT_EQ (body["notes"]["operationsRemoved"], 0);
    EXPECT_EQ (document["x-vendor-note"], "kept verbatim");
    EXPECT_EQ (body["fileName"], "pets-api.openapi.json");
}

TEST_F (SpecExportRouteTest, StopsAtACollectionBoundToADifferentDocument) {
    // Collections re-parent freely, so a collection bound to another spec can
    // sit under this one. Its requests carry that spec's stamps, and
    // `operationId`s are names generators hand out in every document - without
    // the boundary they would claim this document's operations and rewrite them.
    const std::string pets   = store_spec (PETS_DOC);
    const std::string owners = store_spec (OWNERS_DOC);
    bind (root_, pets);
    create_request (root_, "GET", "{{baseUrl}}/pets",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } });
    create_request (root_, "POST", "{{baseUrl}}/pets",
    json{ { "operationId", "createPet" }, { "method", "POST" }, { "path", "/pets" } });

    const std::string other =
    create_collection (json{ { "name", "Owners" }, { "parentId", root_ } });
    bind (other, owners);
    const std::string buried =
    create_collection (json{ { "name", "buried" }, { "parentId", other } });
    create_request (buried, "GET", "{{baseUrl}}/owners",
    json{ { "operationId", "listOwners" }, { "method", "GET" }, { "path", "/owners" } });

    const json body = export_collection ();
    // The other document's request is not here at all - not as an unclaimed
    // request, not as an operation, and its descendants came with it.
    EXPECT_EQ (body["notes"]["requestsExported"], 2);
    EXPECT_EQ (body["notes"]["requestsWithoutOperation"], 0);
    EXPECT_EQ (body["notes"]["operationsNotInDocument"], 0);
}

TEST_F (SpecExportRouteTest, DescendsIntoACollectionBoundToTheSameDocument) {
    // *Another* document, not *a* document: a descendant bound to the same spec
    // describes the very operations being patched, and excluding it would have
    // the export remove them as operations nothing here claims.
    const std::string spec = store_spec (PETS_DOC);
    bind (root_, spec);
    const std::string child =
    create_collection (json{ { "name", "same" }, { "parentId", root_ } });
    bind (child, spec);
    create_request (child, "GET", "{{baseUrl}}/pets",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } });
    create_request (child, "POST", "{{baseUrl}}/pets",
    json{ { "operationId", "createPet" }, { "method", "POST" }, { "path", "/pets" } });

    EXPECT_EQ (export_collection ()["notes"]["operationsRemoved"], 0);
}

TEST_F (SpecExportRouteTest, WritesAStoredExampleIntoTheBoundDocument) {
    const std::string spec = store_spec (PETS_DOC);
    bind (root_, spec);
    const std::string listed = create_request (root_, "GET", "{{baseUrl}}/pets",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } });
    create_request (root_, "POST", "{{baseUrl}}/pets",
    json{ { "operationId", "createPet" }, { "method", "POST" }, { "path", "/pets" } });
    add_example (listed,
    json{ { "name", "200 - ok" }, { "status", 200 },
    { "body", R"({"id":"p1"})" }, { "contentType", "application/json" } });

    const json document = json::parse (export_collection ()["text"].get<std::string> ());
    EXPECT_EQ (document["paths"]["/pets"]["get"]["responses"]["200"]["content"]["application/json"]["example"],
    json::parse (R"({"id":"p1"})"));
}

TEST_F (SpecExportRouteTest, ExportsAFreeFormCollectionAsASkeleton) {
    create_request (root_, "GET", "{{baseUrl}}/pets");

    const json body     = export_collection ();
    const json document = json::parse (body["text"].get<std::string> ());
    EXPECT_EQ (body["notes"]["direction"], "skeleton");
    EXPECT_EQ (document["openapi"], "3.1.0");
    EXPECT_EQ (document["info"]["title"], "Pets API");
    EXPECT_TRUE (document["paths"].contains ("/pets"));
}

TEST_F (SpecExportRouteTest, WritesYamlWhenAskedForIt) {
    create_request (root_, "GET", "{{baseUrl}}/pets");

    const json body = export_ok (json{ { "collectionId", root_ }, { "format", "yaml" } });
    EXPECT_EQ (body["fileName"], "pets-api.openapi.yaml");
    EXPECT_NE (body["text"].get<std::string> ().find ("openapi: 3.1.0"), std::string::npos)
    << body["text"];
}

TEST_F (SpecExportRouteTest, RefusesAFormatItDoesNotWrite) {
    auto [status, body] = routes::export_spec_response (
    *db_, json{ { "collectionId", root_ }, { "format", "toml" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("format"),
    std::string::npos);
}

TEST_F (SpecExportRouteTest, IsA404ForACollectionThatIsNotThere) {
    auto [status, body] =
    routes::export_spec_response (*db_, json{ { "collectionId", "col_nope" } });
    EXPECT_EQ (status, 404) << body.dump ();
}

TEST_F (SpecExportRouteTest, RefusesRatherThanSubstitutingASkeletonForAMissingDocument) {
    // A skeleton in place of the document the user believes they are updating
    // would drop every member of their spec Vayu does not model, so a binding
    // the store cannot answer is a refusal that names it.
    const std::string spec = store_spec (PETS_DOC);
    bind (root_, spec);
    db_->delete_spec_document (spec);

    auto [status, body] =
    routes::export_spec_response (*db_, json{ { "collectionId", root_ } });
    EXPECT_EQ (status, 409) << body.dump ();
    EXPECT_NE (body["error"]["message"].get<std::string> ().find (spec), std::string::npos);
}

TEST_F (SpecExportRouteTest, LeavesTheCollectionExactlyAsItFoundIt) {
    const std::string spec = store_spec (PETS_DOC);
    bind (root_, spec);
    const std::string listed = create_request (root_, "GET", "{{baseUrl}}/pets",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } });

    export_collection ();

    const auto stored = db_->get_spec_document (spec);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->content, PETS_DOC);
    const auto request = db_->get_request (listed);
    ASSERT_HAS_VALUE (request);
    ASSERT_HAS_VALUE (request->spec_operation);
    EXPECT_NE (request->spec_operation->find ("listPets"), std::string::npos);
}

} // namespace
