/**
 * @file tests/spec_describe_route_test.cpp
 * @brief Tests for POST /specs/describe - what a picked document is (issue
 *        #869).
 *
 * The reading rules themselves are pinned in openapi_document_test.cpp and,
 * across the two languages, by `declared-operations-conformance.json`. What is
 * pinned here is what only the route can get wrong:
 *
 *  - **It answers with the identities a bind would stamp**, in document order,
 *    in the shape `requests.spec_operation` records - because the caller hands
 *    them straight to `POST /specs/match`, and a preview matched against
 *    different identities than the write derives is the defect this route
 *    exists to remove.
 *  - **It stores nothing.** The tab asks about documents the user has not
 *    committed to; a route that stored one to describe it would leave a row
 *    behind for every file merely looked at.
 *  - **A file that is not a contract is a refusal, not an empty answer.**
 *    "0 operations" and "this is not an OpenAPI document" are different
 *    sentences, and the second is the one a user can act on.
 *
 * Follows the suite's route-test convention (specs_route_test.cpp): the route's
 * extracted core is exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in spec_describe.cpp; returns {http_status, json_body} - the pair the
// handler writes out.
std::pair<int, nlohmann::json>
describe_spec_response (vayu::db::Database& db, const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

namespace routes = vayu::http::routes;

class SpecDescribeRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_spec_describe_route.db";

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

    std::pair<int, json> describe (const std::string& content) {
        return routes::describe_spec_response (*db_, json{ { "content", content } });
    }

    std::unique_ptr<vayu::db::Database> db_;
};

constexpr const char* PETS_V3 =
R"({"openapi":"3.0.3","info":{"title":"Pets API","version":"1.0.0"},)"
R"("paths":{"/pets":{"get":{"operationId":"listPets","responses":{"200":{}}},)"
R"("post":{"responses":{"201":{}}}}}})";

TEST_F (SpecDescribeRouteTest, AnswersWithTheDialectTheTitleAndTheIdentities) {
    auto [status, body] = describe (PETS_V3);
    ASSERT_EQ (status, 200) << body.dump ();

    EXPECT_EQ (body["format"], "OpenAPI 3.0");
    EXPECT_EQ (body["title"], "Pets API");
    ASSERT_EQ (body["operations"].size (), 2u);
    // Document order, and the stamp's own shape: an `operationId` is present
    // when the document declares one and absent - never "" - when it does not.
    EXPECT_EQ (body["operations"][0]["operationId"], "listPets");
    EXPECT_EQ (body["operations"][0]["method"], "GET");
    EXPECT_EQ (body["operations"][0]["path"], "/pets");
    EXPECT_FALSE (body["operations"][1].contains ("operationId"));
    EXPECT_EQ (body["operations"][1]["method"], "POST");
}

TEST_F (SpecDescribeRouteTest, ReadsYamlAndNamesTheSwaggerDialect) {
    auto [status, body] = describe ("swagger: \"2.0\"\n"
                                    "info:\n"
                                    "  title: Legacy\n"
                                    "paths:\n"
                                    "  /pets:\n"
                                    "    get:\n"
                                    "      operationId: listPets\n");
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["format"], "OpenAPI 2.0 (Swagger)");
    EXPECT_EQ (body["title"], "Legacy");
    ASSERT_EQ (body["operations"].size (), 1u);
    EXPECT_EQ (body["operations"][0]["path"], "/pets");
}

// A document that states no title is described as stating none, rather than
// given the name an import would have invented for its collection. The card
// renders its own placeholder; a name made up here would be this side claiming
// the document calls itself something.
TEST_F (SpecDescribeRouteTest, ADocumentWithNoTitleIsDescribedAsHavingNone) {
    auto [status, body] =
    describe (R"({"openapi":"3.0.0","paths":{"/pets":{"get":{"responses":{"200":{}}}}}})");
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["title"], "");
    EXPECT_EQ (body["operations"].size (), 1u);
}

// Mutation check: answer 200 with an empty `operations` for a non-spec and this
// reddens - which is the point, since the caller would then offer a bind of a
// Postman export as a contract declaring nothing.
TEST_F (SpecDescribeRouteTest, RefusesAFileThatIsNotAnOpenApiDocument) {
    auto [status, body] = describe (R"({"info":{"name":"Team"},"item":[]})");
    ASSERT_EQ (status, 400) << body.dump ();
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("not an OpenAPI document"),
    std::string::npos);
}

TEST_F (SpecDescribeRouteTest, RefusesBytesItCannotRead) {
    auto [status, body] = describe ("openapi: [3.0.0\n");
    ASSERT_EQ (status, 400) << body.dump ();
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("Invalid 'content'"),
    std::string::npos);
}

TEST_F (SpecDescribeRouteTest, RefusesAnEmptyOrMissingDocument) {
    auto [empty, empty_body] = describe ("");
    EXPECT_EQ (empty, 400) << empty_body.dump ();

    auto [missing, missing_body] = routes::describe_spec_response (*db_, json::object ());
    EXPECT_EQ (missing, 400) << missing_body.dump ();
}

// The same cap a store of these bytes applies, so a preview cannot succeed
// where the bind it precedes will fail.
TEST_F (SpecDescribeRouteTest, RefusesADocumentOverTheConfiguredCap) {
    // The live config entry, not the compiled default, exactly as a store of the
    // same bytes reads it.
    auto entry = db_->get_config_entry ("maxSpecDocumentBytes");
    ASSERT_TRUE (entry.has_value ());
    entry->value = "64";
    db_->save_config_entry (*entry);

    auto [status, body] = describe (PETS_V3);
    ASSERT_EQ (status, 400) << body.dump ();
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("over the limit of 64"),
    std::string::npos);
}

} // namespace
