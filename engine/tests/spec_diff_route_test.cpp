/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/spec_diff_route_test.cpp
 * @brief Tests for POST /specs/diff - what a re-fetched document would change
 *        (issue #854).
 *
 * The comparison itself is pinned in spec_diff_test.cpp. What is pinned here is
 * what only the route can get wrong:
 *
 *  - **The subtree is the request set.** An OpenAPI import binds the root and
 *    files every request under a tag sub-collection, so a route that compared
 *    only the named collection's own requests would report a collection as
 *    untouched by a document that rewrote every one of them.
 *  - **The bound document comes from the binding**, never from the caller - the
 *    three-way flag is worth nothing if the "previous" side can be supplied.
 *  - **Nothing is written.** The Sync section asks this before the user has
 *    decided to apply, so a call must leave no document, no binding and no stamp
 *    behind.
 *  - **The answer is applyable.** Each entry carries the draft an apply writes,
 *    including the documented responses, because the payload
 *    `POST /specs/sync` takes is built from exactly this.
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
// Defined in spec_diff.cpp / specs.cpp / collections.cpp / requests.cpp; each
// returns {http_status, json_body} - the pair the handler writes out.
std::pair<int, nlohmann::json>
diff_spec_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_spec_document_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

namespace routes = vayu::http::routes;

constexpr const char* BOUND_DOC =
R"({"openapi":"3.0.0","info":{"title":"Pets","version":"1.0.0"},)"
R"("paths":{"/pets":{"get":{"operationId":"listPets","summary":"List pets",)"
R"("responses":{"200":{"description":"Every pet","content":{"application/json":)"
R"({"schema":{"type":"object","properties":{"id":{"type":"string"}}}}}}}}}}})";

/** The same document with the summary reworded and one operation added. */
constexpr const char* FETCHED_DOC =
R"({"openapi":"3.0.0","info":{"title":"Pets","version":"1.1.0"},)"
R"("paths":{"/pets":{"get":{"operationId":"listPets","summary":"List all pets",)"
R"("responses":{"200":{"description":"Every pet","content":{"application/json":)"
R"({"schema":{"type":"object","properties":{"id":{"type":"string"}}}}}}}}},)"
R"("/owners":{"get":{"operationId":"listOwners","summary":"List owners","tags":["owners"]}}}})";

class SpecDiffRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_spec_diff_route.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();

        bound_spec_ = store_spec (BOUND_DOC);
        root_       = create_collection (json{ { "name", "Pets API" } });
        bind (root_, bound_spec_);
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

    /** The request an import of `BOUND_DOC` would have created for `listPets`. */
    std::string create_listed_request (const std::string& collection_id) {
        auto [status, response] = routes::create_request_response (*db_,
        json{ { "collectionId", collection_id }, { "name", "List pets" },
        { "method", "GET" }, { "url", "{{baseUrl}}/pets" },
        { "specOperation",
        json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } } } });
        EXPECT_EQ (status, 200) << response.dump ();
        return response.value ("id", std::string{});
    }

    json diff (const json& overrides = json::object ()) {
        json body = { { "collectionId", root_ },
            { "spec", json{ { "content", FETCHED_DOC } } } };
        body.update (overrides);
        auto [status, response] = routes::diff_spec_response (*db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response;
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::string bound_spec_;
    std::string root_;
};

TEST_F (SpecDiffRouteTest, ComparesRequestsAnywhereBeneathTheBoundCollection) {
    // The shape an OpenAPI import leaves: the root owns no request at all, and
    // every one of them lives in a tag sub-collection under it.
    const std::string tag =
    create_collection (json{ { "name", "pets" }, { "parentId", root_ } });
    const std::string listed = create_listed_request (tag);

    const json body = diff ();

    ASSERT_EQ (body["changed"].size (), 1u);
    EXPECT_EQ (body["changed"][0]["requestId"], listed);
    EXPECT_EQ (body["unchanged"], 0u);
    EXPECT_EQ (body["unmapped"], 0u);
    ASSERT_EQ (body["added"].size (), 1u);
    EXPECT_EQ (body["added"][0]["operation"]["operationId"], "listOwners");
    // Where an import would file it, so an apply can put it there.
    EXPECT_EQ (body["added"][0]["folder"], "owners");
    EXPECT_TRUE (body["removed"].empty ());
}

TEST_F (SpecDiffRouteTest, ReportsTheFieldsTheDocumentMovedAndTheDraftAnApplyWouldWrite) {
    create_listed_request (root_);

    const json body = diff ();

    ASSERT_EQ (body["changed"].size (), 1u);
    const json& changed = body["changed"][0];
    EXPECT_EQ (changed["matchedBy"], "operationId");
    EXPECT_FALSE (changed["renamed"].get<bool> ());
    EXPECT_FALSE (changed["previousUnknown"].get<bool> ());
    ASSERT_EQ (changed["fields"].size (), 1u);
    EXPECT_EQ (changed["fields"][0]["field"], "name");
    EXPECT_EQ (changed["fields"][0]["current"], "List pets");
    EXPECT_EQ (changed["fields"][0]["next"], "List all pets");
    EXPECT_FALSE (changed["fields"][0]["userTouched"].get<bool> ());
    // The values behind `next`, which is what an apply writes - the rendered one
    // is truncated for display.
    EXPECT_EQ (changed["draft"]["name"], "List all pets");
    EXPECT_EQ (changed["draft"]["url"], "{{baseUrl}}/pets");
    EXPECT_EQ (changed["draft"]["body"]["mode"], "none");
    // The documented responses ride along, because applying a change refreshes
    // the request's imported examples from them.
    ASSERT_EQ (changed["draft"]["examples"].size (), 1u);
    EXPECT_EQ (changed["draft"]["examples"][0]["name"], "200 - Every pet");
    EXPECT_EQ (changed["draft"]["examples"][0]["status"], 200);
    EXPECT_EQ (changed["draft"]["examples"][0]["contentType"], "application/json");
    EXPECT_EQ (changed["draft"]["examples"][0]["headers"][0]["key"], "Content-Type");
}

TEST_F (SpecDiffRouteTest, SaysWhenTheDocumentIsByteForByteTheStoredOne) {
    create_listed_request (root_);

    auto [status, body] = routes::diff_spec_response (*db_,
    json{ { "collectionId", root_ }, { "spec", json{ { "content", BOUND_DOC } } } });

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_TRUE (body["identical"].get<bool> ());
    EXPECT_TRUE (body["changed"].empty ());
    EXPECT_EQ (body["unchanged"], 1u);
    // And a document that differs is not identical, whatever it declares - the
    // flag is about the bytes a run was stamped against.
    EXPECT_FALSE (diff ()["identical"].get<bool> ());
}

TEST_F (SpecDiffRouteTest, CountsARequestThatCarriesNoOperationRatherThanReportingItRemoved) {
    create_listed_request (root_);
    auto [status, response] = routes::create_request_response (*db_,
    json{ { "collectionId", root_ }, { "name", "hand written" },
    { "method", "GET" }, { "url", "{{baseUrl}}/health" } });
    ASSERT_EQ (status, 200) << response.dump ();

    const json body = diff ();

    EXPECT_EQ (body["unmapped"], 1u);
    EXPECT_TRUE (body["removed"].empty ());
}

TEST_F (SpecDiffRouteTest, ReportsARequestWhoseOperationTheDocumentNoLongerDeclares) {
    auto [status, response] = routes::create_request_response (*db_,
    json{ { "collectionId", root_ }, { "name", "Delete a pet" },
    { "method", "DELETE" }, { "url", "{{baseUrl}}/pets/{{petId}}" },
    { "specOperation",
    json{ { "operationId", "deletePet" }, { "method", "DELETE" }, { "path", "/pets/{petId}" } } } });
    ASSERT_EQ (status, 200) << response.dump ();
    const std::string gone = response.value ("id", std::string{});

    const json body = diff ();

    ASSERT_EQ (body["removed"].size (), 1u);
    EXPECT_EQ (body["removed"][0]["requestId"], gone);
    EXPECT_EQ (body["removed"][0]["name"], "Delete a pet");
    EXPECT_EQ (body["removed"][0]["operation"]["operationId"], "deletePet");
}

TEST_F (SpecDiffRouteTest, LeavesTheCollectionExactlyAsItFoundIt) {
    // The section asks this before the user has decided to apply, so a call is a
    // read: no new document, no moved binding, and no stamp on any request.
    const std::string listed = create_listed_request (root_);
    const auto before        = db_->get_collection (root_);
    ASSERT_HAS_VALUE (before);

    diff ();

    const auto after = db_->get_collection (root_);
    ASSERT_HAS_VALUE (after);
    EXPECT_EQ (after->openapi, before->openapi);
    const auto request = db_->get_request (listed);
    ASSERT_HAS_VALUE (request);
    ASSERT_HAS_VALUE (request->spec_operation);
    EXPECT_EQ (json::parse (*request->spec_operation)["operationId"], "listPets");
    EXPECT_EQ (request->name, "List pets");
    // The bound document is still the bound document, byte for byte.
    const auto stored = db_->get_spec_document (bound_spec_);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->content, BOUND_DOC);
}

TEST_F (SpecDiffRouteTest, RefusesACollectionThatBindsNoDocument) {
    const std::string unbound = create_collection (json{ { "name", "Loose" } });

    auto [status, body] = routes::diff_spec_response (*db_,
    json{ { "collectionId", unbound }, { "spec", json{ { "content", FETCHED_DOC } } } });

    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("not bound"),
    std::string::npos);
}

TEST_F (SpecDiffRouteTest, RefusesABindingNamingADocumentTheStoreNoLongerHolds) {
    /*
     * A 409 rather than a 400: the caller's request is fine and the collection's
     * binding is not, which is a different thing to fix.
     *
     * Written straight to the row, because no route will produce this state -
     * `PUT /collections/:id` refuses a binding naming an unstored document and
     * `DELETE /specs/:id` refuses while a collection names it. That is what
     * makes the branch worth having and worth testing here: it is what a row
     * that got there another way (an older writer, a hand-edited database) meets,
     * and the alternative to naming it is comparing against an empty document
     * and reporting every request as changed.
     */
    auto row = db_->get_collection (root_);
    ASSERT_HAS_VALUE (row);
    row->openapi = R"({"specId":"spec_missing","specHash":"seed","syncedAt":1})";
    db_->create_collection (*row);

    auto [status, body] = routes::diff_spec_response (*db_,
    json{ { "collectionId", root_ }, { "spec", json{ { "content", FETCHED_DOC } } } });

    EXPECT_EQ (status, 409);
    EXPECT_NE (
    body["error"]["message"].get<std::string> ().find ("spec_missing"), std::string::npos);
}

TEST_F (SpecDiffRouteTest, RefusesAMissingCollectionADocumentThatWillNotReadAndAnEmptyOne) {
    {
        auto [status, body] = routes::diff_spec_response (*db_,
        json{ { "collectionId", "col_nope" },
        { "spec", json{ { "content", FETCHED_DOC } } } });
        EXPECT_EQ (status, 404) << body.dump ();
    }
    {
        // A document that is neither JSON nor YAML is a 400 that says where it
        // broke, not a comparison against nothing.
        auto [status, body] = routes::diff_spec_response (*db_,
        json{ { "collectionId", root_ },
        { "spec", json{ { "content", "{\"openapi\": [" } } } });
        EXPECT_EQ (status, 400) << body.dump ();
        EXPECT_NE (
        body["error"]["message"].get<std::string> ().find ("spec.content"),
        std::string::npos);
    }
    {
        auto [status, body] = routes::diff_spec_response (*db_,
        json{ { "collectionId", root_ }, { "spec", json{ { "content", "" } } } });
        EXPECT_EQ (status, 400) << body.dump ();
    }
    {
        auto [status, body] =
        routes::diff_spec_response (*db_, json{ { "collectionId", root_ } });
        EXPECT_EQ (status, 400) << body.dump ();
    }
}

TEST_F (SpecDiffRouteTest, ComparesAgainstTheStoredDocumentRatherThanAnythingTheCallerSupplies) {
    /*
     * The three-way flag rests on the bound side being the bytes actually
     * stored, so the route reads them from the binding and there is no key for
     * a caller to state them with. A request whose name matches neither document
     * is the user's edit - and it stays the user's however the body is dressed
     * up.
     */
    auto [status, response] = routes::create_request_response (*db_,
    json{ { "collectionId", root_ }, { "name", "My own name for it" },
    { "method", "GET" }, { "url", "{{baseUrl}}/pets" },
    { "specOperation",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } } } });
    ASSERT_EQ (status, 200) << response.dump ();

    const json body = diff (json{ { "bound", json::array () } });

    ASSERT_EQ (body["changed"].size (), 1u);
    EXPECT_FALSE (body["changed"][0]["previousUnknown"].get<bool> ());
    ASSERT_EQ (body["changed"][0]["fields"].size (), 1u);
    EXPECT_EQ (body["changed"][0]["fields"][0]["field"], "name");
    EXPECT_TRUE (body["changed"][0]["fields"][0]["userTouched"].get<bool> ());
}

// ---------------------------------------------------------------------------
// The marks a safe apply would make (issue #871)
// ---------------------------------------------------------------------------

/*
 * The route reports `core::safe_spec_apply`'s answer per entry so that the Spec
 * tab's pre-ticked boxes and `POST /specs/sync`'s `"policy": "safe"` are one
 * answer rather than two that agree today. The rule is pinned in
 * `spec_diff_test.cpp`; what is pinned here is that it reaches the wire, on the
 * entry it belongs to.
 */

TEST_F (SpecDiffRouteTest, MarksWhatASyncWouldWriteWithNothingTicked) {
    create_listed_request (root_);
    auto [status, response] = routes::create_request_response (*db_,
    json{ { "collectionId", root_ }, { "name", "Delete a pet" },
    { "method", "DELETE" }, { "url", "{{baseUrl}}/pets/{{petId}}" },
    { "specOperation",
    json{ { "operationId", "deletePet" }, { "method", "DELETE" }, { "path", "/pets/{petId}" } } } });
    ASSERT_EQ (status, 200) << response.dump ();

    const json body = diff ();

    ASSERT_FALSE (body["added"].empty ());
    EXPECT_TRUE (body["added"][0]["safe"].get<bool> ());
    ASSERT_EQ (body["removed"].size (), 1u);
    // Deleting is opt-in, and this is where a caller reads that rather than
    // assuming it.
    EXPECT_FALSE (body["removed"][0]["safe"].get<bool> ());
    ASSERT_EQ (body["changed"].size (), 1u);
    EXPECT_TRUE (body["changed"][0]["safe"].get<bool> ());
    EXPECT_EQ (body["changed"][0]["safeFields"], json::array ({ "name" }));
}

TEST_F (SpecDiffRouteTest, MarksAFieldSomebodyEditedAsNotSafeToWrite) {
    /*
     * The request's name is neither document's, which is the signature of a hand
     * edit - so the entry is reported (a person may still tick it) and marked
     * unsafe, with no field ticked inside it. Dropping the `user_touched` guard
     * reddens this, and an apply would take somebody's work with it.
     */
    auto [status, response] = routes::create_request_response (*db_,
    json{ { "collectionId", root_ }, { "name", "My pets call" },
    { "method", "GET" }, { "url", "{{baseUrl}}/pets" },
    { "specOperation",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } } } });
    ASSERT_EQ (status, 200) << response.dump ();

    const json body = diff ();

    ASSERT_EQ (body["changed"].size (), 1u);
    EXPECT_TRUE (body["changed"][0]["fields"][0]["userTouched"].get<bool> ());
    EXPECT_FALSE (body["changed"][0]["safe"].get<bool> ());
    EXPECT_TRUE (body["changed"][0]["safeFields"].empty ());
}

} // namespace
