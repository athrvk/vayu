/**
 * @file tests/requests_route_test.cpp
 * @brief Tests for GET /requests/:id (get_request_response).
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

#include <filesystem>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in requests.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> get_request_response (vayu::db::Database& db,
const std::string& id);
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
        for (const char* s : { "", "-wal", "-shm", ".bak" }) {
            std::filesystem::remove (std::string (DB_PATH) + s);
        }
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
    // Flat {"error": message} shape, matching send_error. The app maps on the
    // status code, so the body only has to be well-formed, not richly typed.
    ASSERT_TRUE (body.contains ("error"));
    EXPECT_TRUE (body["error"].is_string ());
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
