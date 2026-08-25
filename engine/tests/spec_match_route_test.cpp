/**
 * @file tests/spec_match_route_test.cpp
 * @brief Tests for POST /specs/match - which request is which operation
 *        (issue #761, phase B's first move).
 *
 * The rule itself is pinned in operation_match_test.cpp. What is pinned here is
 * what only the route can get wrong:
 *
 *  - **The subtree is the request set.** An OpenAPI import binds the root and
 *    files every request under a tag sub-collection, so a route that matched
 *    only the named collection's own requests would report "0 matched" for
 *    exactly the collections this feature exists for.
 *  - **Nothing is written.** The Spec tab asks this before the user has decided
 *    to bind, so a call must leave no document, no binding and no stamp behind.
 *  - **A bad index is refused here, not stored and discovered later** - through
 *    the same validator `POST /specs` applies, so the two cannot drift on what
 *    an operation row may be.
 *
 * Follows the suite's route-test convention (specs_route_test.cpp): the route's
 * extracted core is exercised directly, no in-process HTTP server.
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
// Defined in spec_match.cpp / collections.cpp / requests.cpp; each returns
// {http_status, json_body} - the pair the handler writes out.
std::pair<int, nlohmann::json>
match_spec_operations_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

namespace routes = vayu::http::routes;

class SpecMatchRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_spec_match_route.db";

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

    std::string create_collection (const json& body) {
        auto [status, response] = routes::create_collection_response (*db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response.value ("id", std::string{});
    }

    std::string create_request (const std::string& collection_id,
    const std::string& method,
    const std::string& url) {
        auto [status, response] = routes::create_request_response (*db_,
        json{ { "collectionId", collection_id }, { "name", url },
        { "method", method }, { "url", url } });
        EXPECT_EQ (status, 200) << response.dump ();
        return response.value ("id", std::string{});
    }

    json match (const json& operations, const std::string& collection_id = {}) {
        auto [status, body] = routes::match_spec_operations_response (*db_,
        json{ { "collectionId", collection_id.empty () ? root_ : collection_id },
        { "operations", operations } });
        EXPECT_EQ (status, 200) << body.dump ();
        return body;
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::string root_;
};

TEST_F (SpecMatchRouteTest, MatchesRequestsAnywhereBeneathTheNamedCollection) {
    // The shape an OpenAPI import leaves: the root owns no request at all, and
    // every one of them lives in a tag sub-collection under it.
    const std::string tag =
    create_collection (json{ { "name", "pets" }, { "parentId", root_ } });
    const std::string list = create_request (tag, "GET", "{{baseUrl}}/pets");
    const std::string get = create_request (tag, "GET", "{{baseUrl}}/pets/{{petId}}");

    const auto body = match (json::array (
    { json{ { "method", "GET" }, { "path", "/pets" }, { "operationId", "listPets" } },
    json{ { "method", "GET" }, { "path", "/pets/{petId}" }, { "operationId", "getPet" } } }));

    ASSERT_EQ (body["matched"].size (), 2u);
    EXPECT_EQ (body["matched"][0]["requestId"], list);
    EXPECT_EQ (body["matched"][0]["operation"]["operationId"], "listPets");
    EXPECT_EQ (body["matched"][1]["requestId"], get);
    EXPECT_EQ (body["matched"][1]["operation"]["path"], "/pets/{petId}");
    EXPECT_TRUE (body["unmatchedRequests"].empty ());
    EXPECT_TRUE (body["unmatchedOperations"].empty ());
}

TEST_F (SpecMatchRouteTest, LeavesTheCollectionExactlyAsItFoundIt) {
    // The tab asks about documents the user has not committed to, so a call is a
    // read: no stamp on the request it matched, and no binding on the collection.
    const std::string list = create_request (root_, "GET", "{{baseUrl}}/pets");

    match (json::array ({ json{ { "method", "GET" }, { "path", "/pets" },
    { "operationId", "listPets" } } }));

    const auto stored = db_->get_request (list);
    ASSERT_HAS_VALUE (stored);
    EXPECT_FALSE (stored->spec_operation.has_value ());
    const auto collection = db_->get_collection (root_);
    ASSERT_HAS_VALUE (collection);
    EXPECT_TRUE (collection->openapi.empty () || collection->openapi == "{}");
}

TEST_F (SpecMatchRouteTest, ReportsBothLeftoversByName) {
    const std::string health = create_request (root_, "GET", "{{baseUrl}}/health");

    const auto body =
    match (json::array ({ json{ { "method", "POST" }, { "path", "/pets" } } }));

    EXPECT_TRUE (body["matched"].empty ());
    ASSERT_EQ (body["unmatchedRequests"].size (), 1u);
    EXPECT_EQ (body["unmatchedRequests"][0], health);
    ASSERT_EQ (body["unmatchedOperations"].size (), 1u);
    EXPECT_EQ (body["unmatchedOperations"][0]["method"], "POST");
    // Absent rather than "", the same way a stored stamp omits it: an operation
    // that declares no `operationId` is not one whose id is empty.
    EXPECT_FALSE (body["unmatchedOperations"][0].contains ("operationId"));
}

TEST_F (SpecMatchRouteTest, DoesNotReachRequestsOutsideTheSubtree) {
    // A sibling collection's requests are another contract's business - the
    // same boundary `POST /specs/sync` refuses to cross.
    const std::string sibling = create_collection (json{ { "name", "Other API" } });
    create_request (sibling, "GET", "{{baseUrl}}/pets");

    const auto body = match (json::array ({ json{ { "method", "GET" },
    { "path", "/pets" }, { "operationId", "listPets" } } }));

    EXPECT_TRUE (body["matched"].empty ());
    EXPECT_TRUE (body["unmatchedRequests"].empty ());
    EXPECT_EQ (body["unmatchedOperations"].size (), 1u);
}

TEST_F (SpecMatchRouteTest, RefusesACollectionThatDoesNotExist) {
    // Not an empty match: "this document matches none of your requests" and
    // "you named a collection that is not there" are different answers.
    auto [status, body] = routes::match_spec_operations_response (*db_,
    json{ { "collectionId", "col_missing" }, { "operations", json::array () } });

    EXPECT_EQ (status, 404) << body.dump ();
}

TEST_F (SpecMatchRouteTest, RefusesAPayloadTheStoreWouldRefuse) {
    struct Case {
        json body;
        const char* what;
    };
    const Case cases[] = {
        { json::object (), "no collectionId" },
        { json{ { "collectionId", "" }, { "operations", json::array () } }, "empty collectionId" },
        { json{ { "collectionId", "col_x" } }, "no operations" },
        { json{ { "collectionId", "col_x" }, { "operations", "nope" } }, "operations not an array" },
        { json{ { "collectionId", "col_x" },
          { "operations", json::array ({ json::object () }) } },
        "an operation with no method or path" },
        { json{ { "collectionId", "col_x" },
          { "operations", json::array ({ json{ { "method", "GET" }, { "path", "" } } }) } },
        "an operation with an empty path" },
    };
    for (const auto& one : cases) {
        auto [status, body] = routes::match_spec_operations_response (*db_, one.body);
        EXPECT_EQ (status, 400) << one.what << ": " << body.dump ();
    }
}

} // namespace
