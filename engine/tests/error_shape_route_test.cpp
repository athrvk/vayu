/**
 * @file tests/error_shape_route_test.cpp
 * @brief Every engine error body is one shape: {"error": {"code", "message"}}
 *        (issue #173).
 *
 * The engine used to emit two. `send_error` and the extracted route cores wrote
 * a flat `{"error": "<message>"}`; `/config` and `/oauth2` wrote the nested
 * object. The app's shared http-client reads `errorData.error.message`, which
 * on a flat body is `undefined` (a JSON string carries no `.message`) - so
 * every validation and not-found message the CRUD routes so carefully worded
 * was dropped and the user saw a bare "HTTP 400: Bad Request".
 *
 * The per-route suites assert the *message text* of their own failures. This
 * file asserts the **envelope** those messages arrive in, across routes,
 * because the defect was never in one route: it was a convention that half the
 * engine followed. A route that goes back to a flat body fails here even if its
 * own message assertions still pass, since those read `error.message` and a
 * flat body has none.
 *
 * Follows the suite's route-test convention (requests_route_test.cpp): the
 * routes' extracted cores are exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in their route .cpp files; each returns {http_status, json_body} -
// the same pair the HTTP handler writes out.
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
get_request_response (vayu::db::Database& db, const std::string& id);
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_environment_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
run_report_response (vayu::db::Database& db, const std::string& run_id);
std::pair<int, nlohmann::json>
import_apply_response (vayu::db::Database& db, const nlohmann::json& body);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::error_body;
using vayu::http::routes::error_message_of;

class ErrorShapeRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_error_shape_route.db";

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

    /**
     * The contract in one place: an object under `error` carrying a non-empty
     * string `code` and a non-empty string `message`. Asserting `is_object` is
     * what a reverted `send_error` fails on; asserting the message is non-empty
     * is what an over-eager "just add a code" fix fails on.
     */
    static void expect_error_shape (const json& body, const std::string& expected_code) {
        ASSERT_TRUE (body.contains ("error")) << body.dump ();
        const auto& error = body["error"];
        ASSERT_TRUE (error.is_object ()) << "flat error body: " << body.dump ();
        ASSERT_TRUE (error.contains ("code"));
        ASSERT_TRUE (error["code"].is_string ());
        EXPECT_EQ (error["code"], expected_code);
        ASSERT_TRUE (error.contains ("message"));
        ASSERT_TRUE (error["message"].is_string ());
        EXPECT_FALSE (error["message"].get<std::string> ().empty ());
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// One case per status the CRUD verbs produce, spread across all three
// resources, so a resource that reverts to the flat shape is caught wherever it
// lives rather than only where the fix happened to be tested.

TEST_F (ErrorShapeRouteTest, ValidationFailureIsNestedBadRequest) {
    auto [status, body] = vayu::http::routes::create_collection_response (
    *db_, json{ { "description", "no name" } });
    EXPECT_EQ (status, 400);
    expect_error_shape (body, "bad_request");
    // The reason survives the envelope - this is the text the user sees.
    EXPECT_NE (error_message_of (body).find ("name"), std::string::npos);
}

TEST_F (ErrorShapeRouteTest, MissingRequestIsNestedNotFound) {
    auto [status, body] = vayu::http::routes::get_request_response (*db_, "req_nope");
    EXPECT_EQ (status, 404);
    expect_error_shape (body, "not_found");
}

TEST_F (ErrorShapeRouteTest, MissingCollectionOnUpdateIsNestedNotFound) {
    auto [status, body] = vayu::http::routes::update_collection_response (
    *db_, "col_nope", json{ { "name", "x" } });
    EXPECT_EQ (status, 404);
    expect_error_shape (body, "not_found");
}

TEST_F (ErrorShapeRouteTest, MissingEnvironmentOnUpdateIsNestedNotFound) {
    auto [status, body] = vayu::http::routes::update_environment_response (
    *db_, "env_nope", json{ { "name", "x" } });
    EXPECT_EQ (status, 404);
    expect_error_shape (body, "not_found");
}

TEST_F (ErrorShapeRouteTest, ClientSuppliedIdIsNestedBadRequest) {
    auto [status, body] = vayu::http::routes::create_request_response (*db_,
    json{ { "id", "req_mine" }, { "collectionId", "col_1" }, { "name", "n" },
    { "method", "GET" }, { "url", "http://x" } });
    EXPECT_EQ (status, 400);
    expect_error_shape (body, "bad_request");
}

TEST_F (ErrorShapeRouteTest, MissingRunReportIsNestedNotFound) {
    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_nope");
    EXPECT_EQ (status, 404);
    expect_error_shape (body, "not_found");
}

/**
 * The import failure is the one the user is most likely to hit at scale, and
 * the `item` detail is the whole reason a 500-item import is diagnosable. It
 * moved *inside* the error object with the migration, so a client reads one
 * object for the whole failure - assert both halves together.
 */
TEST_F (ErrorShapeRouteTest, ImportItemErrorNamesTheItemInsideTheErrorObject) {
    const json payload{ { "collections",
    json::array ({ json{ { "tempId", "c1" }, { "name", "A" } },
    json{ { "tempId", "c1" }, { "name", "B" } } }) } };

    auto [status, body] = vayu::http::routes::import_apply_response (*db_, payload);
    EXPECT_EQ (status, 400);
    expect_error_shape (body, "bad_request");
    ASSERT_TRUE (body["error"].contains ("item"));
    EXPECT_EQ (body["error"]["item"], "c1");
    // The temp id must not also sit at the top level - one place to look.
    EXPECT_FALSE (body.contains ("item"));
}

// The builder itself: the per-status code table, and the reader route handlers
// log through.

TEST_F (ErrorShapeRouteTest, DefaultCodeFollowsTheStatus) {
    EXPECT_EQ (error_body (400, "m")["error"]["code"], "bad_request");
    EXPECT_EQ (error_body (404, "m")["error"]["code"], "not_found");
    EXPECT_EQ (error_body (409, "m")["error"]["code"], "conflict");
    EXPECT_EQ (error_body (502, "m")["error"]["code"], "bad_gateway");
    EXPECT_EQ (error_body (503, "m")["error"]["code"], "unavailable");
    EXPECT_EQ (error_body (500, "m")["error"]["code"], "internal_error");
}

TEST_F (ErrorShapeRouteTest, ExplicitCodeWinsOverTheStatusDefault) {
    EXPECT_EQ (error_body (400, "m", "invalid_config")["error"]["code"], "invalid_config");
    EXPECT_EQ (error_body (400, "m",
               std::string ("oauth2_invalid_config"))["error"]["code"],
    "oauth2_invalid_config");
}

/**
 * `error_message_of` tolerates the flat shape on purpose: it also reads bodies
 * that did not come from `error_body`. Route handlers log through it, and a raw
 * `body["error"].get<std::string>()` throws on an object - which would turn a
 * logged 404 into a 500.
 */
TEST_F (ErrorShapeRouteTest, ErrorMessageOfReadsBothShapesAndNeitherThrows) {
    EXPECT_EQ (error_message_of (error_body (404, "Run not found")), "Run not found");
    EXPECT_EQ (error_message_of (json{ { "error", "legacy flat" } }), "legacy flat");
    EXPECT_EQ (error_message_of (json{ { "ok", true } }), "");
    EXPECT_NO_THROW (error_message_of (json{ { "error", json::array ({ 1, 2 }) } }));
}

} // namespace
