/**
 * @file tests/requests_route_test.cpp
 * @brief Tests for GET /requests/:id (get_request_response) and the
 * GET /requests list body (list_requests_body).
 *
 * Focus: the single-request lookup must return a *definitive* 404 when the
 * request does not exist, and 200 with the full serialized shape when it does.
 * That 404-vs-present distinction is what lets the app tell a real deletion
 * from an unreachable engine - the collection-list scan it replaces could not,
 * because a swallowed list failure looked the same as "not in any list".
 *
 * Covers the route's extracted core in isolation, matching the suite's other
 * route tests (no in-process HTTP server). Deleting the 404 branch, or pointing
 * the route at a different serializer, fails this file.
 */

#include <gtest/gtest.h>

#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in requests.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json>
get_request_response (vayu::db::Database& db, const std::string& id);
// Defined in requests.cpp; returns the GET /requests JSON array body.
std::string list_requests_body (vayu::db::Database& db, const std::string& collection_id);
// Defined in requests.cpp; the GET /requests body with no `collectionId`.
std::string list_all_requests_body (vayu::db::Database& db);
} // namespace vayu::http::routes

namespace {

class RequestsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_requests_route.db";

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
        vayu::tests::remove_database_files (DB_PATH);
    }

    // Persist a minimal request under a known collection and return its id.
    std::string seed_request () {
        vayu::db::Collection col;
        col.id    = "col_1";
        col.name  = "API";
        col.order = 0;
        db_->create_collection (col);

        vayu::db::Request r;
        r.id            = "req_1";
        r.collection_id = "col_1";
        r.name          = "Get user";
        r.method        = vayu::HttpMethod::GET;
        r.url           = "https://example.test/user";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 2;
        db_->save_request (r);
        return r.id;
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (RequestsRouteTest, MissingRequestIs404) {
    auto [status, body] = vayu::http::routes::get_request_response (*db_, "req_nope");
    EXPECT_EQ (status, 404);
    // The one error shape (issue #173): a nested object carrying a per-status
    // code and the message. The app's http-client reads `error.message`, so a
    // flat string here would surface as a bare "HTTP 404".
    ASSERT_TRUE (body.contains ("error"));
    EXPECT_EQ (body["error"]["code"], "not_found");
    EXPECT_EQ (body["error"]["message"], "Request not found");
}

// GET /requests must contain every row of the collection and preserve the
// DB layer's order-by-`order` sorting end to end - other API clients see this
// body directly, without the bundled app's client-side re-sort. Rows are
// seeded out of order so pass-through of insertion order fails.
TEST_F (RequestsRouteTest, ListBodyContainsAllRowsSortedByOrder) {
    vayu::db::Collection col;
    col.id    = "col_list";
    col.name  = "API";
    col.order = 0;
    db_->create_collection (col);

    for (const auto& [id, order] :
    { std::pair<const char*, int>{ "req_z", 2 }, { "req_x", 0 }, { "req_y", 1 } }) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = "col_list";
        r.name          = id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = std::string ("https://example.test/") + id;
        r.order         = order;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    const auto body =
    json::parse (vayu::http::routes::list_requests_body (*db_, "col_list"));

    ASSERT_TRUE (body.is_array ());
    ASSERT_EQ (body.size (), 3);
    EXPECT_EQ (body[0]["id"], "req_x");
    EXPECT_EQ (body[1]["id"], "req_y");
    EXPECT_EQ (body[2]["id"], "req_z");
    // Same serialized shape as a single-request lookup.
    EXPECT_TRUE (body[0]["params"].is_array ());
    EXPECT_TRUE (body[0]["headers"].is_array ());
}

// An unknown (or empty) collection is an empty list, not an error.
TEST_F (RequestsRouteTest, ListBodyForUnknownCollectionIsEmptyArray) {
    const auto body =
    json::parse (vayu::http::routes::list_requests_body (*db_, "col_nope"));
    ASSERT_TRUE (body.is_array ());
    EXPECT_TRUE (body.empty ());
}

// The launch fetch (one call, where the app used to make one per collection)
// must answer with exactly the union of the per-collection lists: every row of
// every live collection, each collection's rows in that collection's own
// order, and nothing the trash holds. Compared against `list_requests_body`
// rather than a hand-written expectation, so the two cannot drift apart.
TEST_F (RequestsRouteTest, AllRequestsBodyIsEveryLiveCollectionsListAndNothingTrashed) {
    for (const char* id : { "col_b", "col_a", "col_gone" }) {
        vayu::db::Collection col;
        col.id    = id;
        col.name  = id;
        col.order = 0;
        db_->create_collection (col);
    }
    const std::vector<std::tuple<const char*, const char*, int>> rows = {
        { "req_a2", "col_a", 1 }, { "req_b1", "col_b", 0 }, { "req_a1", "col_a", 0 },
        { "req_gone", "col_gone", 0 }, { "req_deleted", "col_b", 1 }
    };
    for (const auto& [id, collection, order] : rows) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection;
        r.name          = id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = std::string ("https://example.test/") + id;
        r.order         = order;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }
    db_->delete_request ("req_deleted");
    db_->delete_collection ("col_gone");

    const auto all = json::parse (vayu::http::routes::list_all_requests_body (*db_));
    ASSERT_TRUE (all.is_array ());

    json expected = json::array ();
    for (const char* collection : { "col_a", "col_b" }) {
        for (const auto& row :
        json::parse (vayu::http::routes::list_requests_body (*db_, collection))) {
            expected.push_back (row);
        }
    }
    ASSERT_EQ (expected.size (), 3u) << "the fixture seeded the wrong rows";
    EXPECT_EQ (all, expected);
}

TEST_F (RequestsRouteTest, PresentRequestIs200WithSerializedShape) {
    const std::string id = seed_request ();

    auto [status, body] = vayu::http::routes::get_request_response (*db_, id);
    EXPECT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("error"));

    // The same shape a list entry carries: id/collectionId/name/method/url
    // plus the array-valued params/headers the transformer expects.
    EXPECT_EQ (body["id"], "req_1");
    EXPECT_EQ (body["collectionId"], "col_1");
    EXPECT_EQ (body["name"], "Get user");
    EXPECT_EQ (body["method"], "GET");
    EXPECT_EQ (body["url"], "https://example.test/user");
    EXPECT_TRUE (body["params"].is_array ());
    EXPECT_TRUE (body["headers"].is_array ());
}

} // namespace
