/**
 * @file tests/spec_sync_route_test.cpp
 * @brief Tests for POST /specs/sync - applying an OpenAPI diff (issue #655).
 *
 * What is pinned here is what a client must not be able to get wrong:
 *
 *  - **All or nothing.** A payload with one bad item writes no row, moves no
 *    binding and stores no document. So every failure case asserts the state
 *    afterwards, not just the status code - a 400 that had already created two
 *    requests is the bug this endpoint exists to make impossible.
 *  - **The bound subtree is the boundary.** A request updated or deleted from
 *    outside it is a 400. Without this the route is a way to delete any row in
 *    the database by id.
 *  - **A user's saved examples survive a sync.** `origin="import"` rows are
 *    replaced and `origin="user"` rows are not, and the replacements never jump
 *    ahead of a user row that was already in front of them - "the first example"
 *    is what a mock server answers with, so the order is a contract.
 *  - **The binding moves with the rows.** After a sync the collection names the
 *    document that was just applied, or - if anything failed - the one it named
 *    before.
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
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in spec_sync.cpp / specs.cpp / collections.cpp / requests.cpp;
// each returns {http_status, json_body} - the pair the handler writes out.
std::pair<int, nlohmann::json>
spec_sync_response (vayu::db::Database& db, const nlohmann::json& body);
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
R"({"openapi":"3.1.0","info":{"title":"Pets","version":"1.0.0"},)"
R"("paths":{"/pets":{"get":{"operationId":"listPets"}}}})";

constexpr const char* FETCHED_DOC =
R"({"openapi":"3.1.0","info":{"title":"Pets","version":"1.1.0"},)"
R"("paths":{"/pets":{"get":{"operationId":"listPets"}},)"
R"("/owners":{"get":{"operationId":"listOwners"}}}})";

class SpecSyncRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_spec_sync_route.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();

        bound_spec_ = store_spec (BOUND_DOC);
        root_       = create_collection (json{ { "name", "Pets API" } });
        auto [status, body] = routes::update_collection_response (*db_, root_,
        json{ { "openapi",
            json{ { "specId", bound_spec_ }, { "specHash", "seed" }, { "syncedAt", 1 } } } });
        EXPECT_EQ (status, 200) << body.dump ();
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

    std::string create_request (const std::string& collection_id, const json& extra = json::object ()) {
        json body = { { "collectionId", collection_id }, { "name", "list pets" },
            { "method", "GET" }, { "url", "https://example.test/pets" } };
        body.update (extra);
        auto [status, response] = routes::create_request_response (*db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response.value ("id", std::string{});
    }

    /** The `openapi` binding the collection holds right now. */
    json binding () {
        auto collection = db_->get_collection (root_);
        EXPECT_TRUE (collection.has_value ());
        return json::parse (collection->openapi);
    }

    /** A payload with the sections filled in by the caller. */
    json body (const json& sections = json::object ()) {
        json payload = { { "collectionId", root_ },
            { "spec", json{ { "content", FETCHED_DOC } } } };
        payload.update (sections);
        return payload;
    }

    /** One example row on @p request_id, written straight to the store. */
    std::string seed_example (const std::string& request_id, const std::string& origin, int order) {
        vayu::db::RequestExample x;
        x.id           = "exa_" + origin + "_" + std::to_string (order);
        x.request_id   = request_id;
        x.name         = origin + " " + std::to_string (order);
        x.status       = 200;
        x.headers      = "[]";
        x.body         = "{}";
        x.content_type = "application/json";
        x.order        = order;
        x.origin       = origin;
        x.created_at   = 1;
        x.updated_at   = 1;
        db_->save_request_example (x);
        return x.id;
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::string bound_spec_;
    std::string root_;
};

// ---------------------------------------------------------------------------
// The happy path - rows, document and binding move together
// ---------------------------------------------------------------------------

TEST_F (SpecSyncRouteTest, AppliesCreateUpdateAndDeleteInOneCall) {
    const std::string gone   = create_request (root_, json{ { "name", "list owners" } });
    const std::string stayed = create_request (root_, json{ { "name", "list pets" } });

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{
        { "collections", json::array ({ json{ { "tempId", "t_col" }, { "name", "owners" } } }) },
        { "create", json::array ({ json{ { "tempId", "t_req" }, { "collectionTempId", "t_col" },
            { "name", "list owners" }, { "method", "GET" },
            { "url", "https://example.test/owners" } } }) },
        { "update", json::array ({ json{ { "id", stayed }, { "name", "list every pet" } } }) },
        { "delete", json::array ({ gone }) } }));
    ASSERT_EQ (status, 200) << response.dump ();

    // Every id the engine minted, and no temp id anywhere near the store.
    ASSERT_TRUE (response["idMap"].contains ("t_col"));
    ASSERT_TRUE (response["idMap"].contains ("t_req"));
    const auto folder_id  = response["idMap"]["t_col"].get<std::string> ();
    const auto created_id = response["idMap"]["t_req"].get<std::string> ();
    EXPECT_TRUE (folder_id.starts_with ("col_"));
    EXPECT_TRUE (created_id.starts_with ("req_"));

    auto created = db_->get_request (created_id);
    ASSERT_TRUE (created.has_value ());
    EXPECT_EQ (created->collection_id, folder_id);

    auto updated = db_->get_request (stayed);
    ASSERT_TRUE (updated.has_value ());
    EXPECT_EQ (updated->name, "list every pet");
    EXPECT_FALSE (db_->get_request (gone).has_value ());

    // The document and the binding land in the same commit as the rows, which is
    // the whole reason this is one route.
    const auto moved = binding ();
    EXPECT_NE (moved["specId"].get<std::string> (), bound_spec_);
    auto stored = db_->get_spec_document (moved["specId"].get<std::string> ());
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (stored->content, FETCHED_DOC);
    EXPECT_EQ (moved["specHash"].get<std::string> (), stored->hash);
    EXPECT_EQ (response["specId"].get<std::string> (), stored->id);
    EXPECT_EQ (response["created"].get<int> (), 1);
    EXPECT_EQ (response["updated"].get<int> (), 1);
    EXPECT_EQ (response["deleted"].get<int> (), 1);
}

TEST_F (SpecSyncRouteTest, AnEmptySelectionStillMovesTheBindingAndNothingElse) {
    const std::string kept = create_request (root_);

    auto [status, response] = routes::spec_sync_response (*db_, body ());
    ASSERT_EQ (status, 200) << response.dump ();

    EXPECT_TRUE (db_->get_request (kept).has_value ());
    EXPECT_EQ (db_->get_requests_in_collection (root_).size (), 1u);
    EXPECT_NE (binding ()["specId"].get<std::string> (), bound_spec_);
}

TEST_F (SpecSyncRouteTest, CreatedRequestsAppendAfterTheCollectionsExistingOnes) {
    create_request (root_); // order 0

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "create",
        json::array ({ json{ { "tempId", "a" }, { "collectionId", root_ }, { "name", "a" },
                          { "method", "GET" }, { "url", "https://example.test/a" } },
            json{ { "tempId", "b" }, { "collectionId", root_ }, { "name", "b" },
                { "method", "GET" }, { "url", "https://example.test/b" } } }) } }));
    ASSERT_EQ (status, 200) << response.dump ();

    // Consecutive slots after the stored one - two rows sharing an `order` would
    // put the tie rule in charge of the sidebar.
    auto rows = db_->get_requests_in_collection (root_);
    ASSERT_EQ (rows.size (), 3u);
    EXPECT_EQ (rows[1].order, 1);
    EXPECT_EQ (rows[2].order, 2);
}

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

TEST_F (SpecSyncRouteTest, OneBadItemWritesNothingAtAll) {
    const std::string kept = create_request (root_);

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "create",
        json::array ({ json{ { "tempId", "good" }, { "collectionId", root_ }, { "name", "good" },
                          { "method", "GET" }, { "url", "https://example.test/good" } },
            // No `url`, which the shared applier requires on create.
            json{ { "tempId", "bad" }, { "collectionId", root_ }, { "name", "bad" },
                { "method", "GET" } } }) } }));
    ASSERT_EQ (status, 400) << response.dump ();
    EXPECT_EQ (response["error"]["item"].get<std::string> (), "bad");

    EXPECT_EQ (db_->get_requests_in_collection (root_).size (), 1u);
    EXPECT_TRUE (db_->get_request (kept).has_value ());
    // The binding is the state that matters most: a collection pointing at a
    // document whose operations were never applied is the failure this endpoint
    // is shaped to prevent.
    EXPECT_EQ (binding ()["specId"].get<std::string> (), bound_spec_);
}

TEST_F (SpecSyncRouteTest, ADeletionRollsBackWithTheRestOfTheBatch) {
    const std::string doomed = create_request (root_);

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "delete", json::array ({ doomed }) },
        { "update", json::array ({ json{ { "id", "req_never" }, { "name", "x" } } }) } }));
    ASSERT_EQ (status, 409) << response.dump ();

    EXPECT_TRUE (db_->get_request (doomed).has_value ())
    << "a delete that shared a payload with a failing update must not have happened";
    EXPECT_EQ (binding ()["specId"].get<std::string> (), bound_spec_);
}

// ---------------------------------------------------------------------------
// The subtree is the boundary
// ---------------------------------------------------------------------------

TEST_F (SpecSyncRouteTest, RefusesToUpdateARequestOutsideTheSyncedCollection) {
    const std::string other_root = create_collection (json{ { "name", "Somebody else" } });
    const std::string stranger   = create_request (other_root, json{ { "name", "not yours" } });

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "update", json::array ({ json{ { "id", stranger }, { "name", "taken" } } }) } }));
    ASSERT_EQ (status, 400) << response.dump ();
    EXPECT_EQ (response["error"]["item"].get<std::string> (), stranger);

    auto untouched = db_->get_request (stranger);
    ASSERT_TRUE (untouched.has_value ());
    EXPECT_EQ (untouched->name, "not yours");
}

TEST_F (SpecSyncRouteTest, RefusesToDeleteARequestOutsideTheSyncedCollection) {
    const std::string other_root = create_collection (json{ { "name", "Somebody else" } });
    const std::string stranger   = create_request (other_root);

    auto [status, response] =
    routes::spec_sync_response (*db_, body (json{ { "delete", json::array ({ stranger }) } }));
    ASSERT_EQ (status, 400) << response.dump ();
    EXPECT_TRUE (db_->get_request (stranger).has_value ());
}

TEST_F (SpecSyncRouteTest, ReachesARequestInANestedTagFolder) {
    const std::string folder = create_collection (json{ { "name", "pets" }, { "parentId", root_ } });
    const std::string nested = create_request (folder, json{ { "name", "list pets" } });

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "update", json::array ({ json{ { "id", nested }, { "name", "renamed" } } }) } }));
    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (db_->get_request (nested)->name, "renamed");
}

TEST_F (SpecSyncRouteTest, RefusesAFolderParentedOutsideTheSyncedCollection) {
    const std::string other_root = create_collection (json{ { "name", "Somebody else" } });

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "collections", json::array ({ json{ { "tempId", "t" }, { "name", "pets" },
                     { "parentId", other_root } } }) } }));
    ASSERT_EQ (status, 400) << response.dump ();
    EXPECT_EQ (db_->get_collections ().size (), 2u);
}

// ---------------------------------------------------------------------------
// Examples - the user's survive, the imported ones are replaced in place
// ---------------------------------------------------------------------------

TEST_F (SpecSyncRouteTest, ReplacesImportedExamplesAndKeepsTheUsersOwn) {
    const std::string request = create_request (root_);
    seed_example (request, vayu::core::constants::request_example::ORIGIN_USER, 0);
    const std::string replaced =
    seed_example (request, vayu::core::constants::request_example::ORIGIN_IMPORT, 1);

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "update",
        json::array ({ json{ { "id", request },
            { "examples", json::array ({ json{ { "name", "200 ok" }, { "status", 200 } } }) } } }) } }));
    ASSERT_EQ (status, 200) << response.dump ();

    auto rows = db_->get_request_examples (request);
    ASSERT_EQ (rows.size (), 2u);
    // The user's row is first and unchanged; the imported one is gone and its
    // replacement sits where it sat. Mutation check: replace `refresh_examples`
    // with "delete everything" and the first assertion reddens; give the new row
    // order 0 and the second does.
    EXPECT_EQ (rows[0].origin, vayu::core::constants::request_example::ORIGIN_USER);
    EXPECT_EQ (rows[1].name, "200 ok");
    EXPECT_EQ (rows[1].order, 1);
    EXPECT_EQ (rows[1].origin, vayu::core::constants::request_example::ORIGIN_IMPORT);
    EXPECT_FALSE (db_->get_request_example (replaced).has_value ());
}

TEST_F (SpecSyncRouteTest, AnEmptyExampleListRemovesTheImportedOnesOnly) {
    const std::string request = create_request (root_);
    seed_example (request, vayu::core::constants::request_example::ORIGIN_USER, 0);
    seed_example (request, vayu::core::constants::request_example::ORIGIN_IMPORT, 1);

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "update",
        json::array ({ json{ { "id", request }, { "examples", json::array () } } }) } }));
    ASSERT_EQ (status, 200) << response.dump ();

    auto rows = db_->get_request_examples (request);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_EQ (rows[0].origin, vayu::core::constants::request_example::ORIGIN_USER);
}

TEST_F (SpecSyncRouteTest, AnAbsentExampleListLeavesEveryExampleAlone) {
    const std::string request = create_request (root_);
    seed_example (request, vayu::core::constants::request_example::ORIGIN_IMPORT, 0);

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "update", json::array ({ json{ { "id", request }, { "name", "renamed" } } }) } }));
    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (db_->get_request_examples (request).size (), 1u);
}

TEST_F (SpecSyncRouteTest, RefusesAnExampleThatClaimsToBeTheUsers) {
    const std::string request = create_request (root_);

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "update", json::array ({ json{ { "id", request },
                     { "examples", json::array ({ json{ { "name", "x" },
                         { "origin", "user" } } }) } } }) } }));
    ASSERT_EQ (status, 400) << response.dump ();
    EXPECT_EQ (db_->get_request_examples (request).size (), 0u);
}

// ---------------------------------------------------------------------------
// The payload's own shape
// ---------------------------------------------------------------------------

TEST_F (SpecSyncRouteTest, AnUnknownCollectionIsA404AndAnUnboundOneA400) {
    auto [missing, missing_body] = routes::spec_sync_response (*db_,
    json{ { "collectionId", "col_nope" }, { "spec", json{ { "content", FETCHED_DOC } } } });
    EXPECT_EQ (missing, 404) << missing_body.dump ();

    const std::string unbound = create_collection (json{ { "name", "Plain" } });
    auto [status, response]   = routes::spec_sync_response (*db_,
      json{ { "collectionId", unbound }, { "spec", json{ { "content", FETCHED_DOC } } } });
    EXPECT_EQ (status, 400) << response.dump ();
}

TEST_F (SpecSyncRouteTest, RejectsAClientSuppliedIdAndAClientComputedHash) {
    auto [with_id, id_body] = routes::spec_sync_response (*db_,
    body (json{ { "create", json::array ({ json{ { "tempId", "t" }, { "id", "req_mine" },
                     { "collectionId", root_ }, { "name", "n" }, { "method", "GET" },
                     { "url", "https://example.test/n" } } }) } }));
    EXPECT_EQ (with_id, 400) << id_body.dump ();

    auto [with_hash, hash_body] = routes::spec_sync_response (*db_,
    json{ { "collectionId", root_ },
        { "spec", json{ { "content", FETCHED_DOC }, { "hash", "deadbeef" } } } });
    EXPECT_EQ (with_hash, 400) << hash_body.dump ();
    EXPECT_EQ (binding ()["specId"].get<std::string> (), bound_spec_);
}

TEST_F (SpecSyncRouteTest, RefusesToMoveARequestWhileUpdatingIt) {
    const std::string request = create_request (root_);
    const std::string folder = create_collection (json{ { "name", "pets" }, { "parentId", root_ } });

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "update",
        json::array ({ json{ { "id", request }, { "collectionId", folder } } }) } }));
    ASSERT_EQ (status, 400) << response.dump ();
    EXPECT_EQ (db_->get_request (request)->collection_id, root_);
}

TEST_F (SpecSyncRouteTest, RefusesTheSameRequestTwiceInOnePayload) {
    const std::string request = create_request (root_);

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "update", json::array ({ json{ { "id", request }, { "name", "a" } } }) },
        { "delete", json::array ({ request }) } }));
    ASSERT_EQ (status, 400) << response.dump ();
    EXPECT_TRUE (db_->get_request (request).has_value ());
}

TEST_F (SpecSyncRouteTest, DeletingARequestThatIsAlreadyGoneIsNotAFailure) {
    // The asked-for state is "not there", and it is not there. Refusing would
    // make a re-tried sync fail on the half that already succeeded.
    auto [status, response] =
    routes::spec_sync_response (*db_, body (json{ { "delete", json::array ({ "req_ghost" }) } }));
    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_EQ (response["deleted"].get<int> (), 0);
    EXPECT_NE (binding ()["specId"].get<std::string> (), bound_spec_);
}

TEST_F (SpecSyncRouteTest, AnEmptyDocumentIsNotASpec) {
    auto [status, response] = routes::spec_sync_response (*db_,
    json{ { "collectionId", root_ }, { "spec", json{ { "content", "" } } } });
    EXPECT_EQ (status, 400) << response.dump ();
    EXPECT_EQ (binding ()["specId"].get<std::string> (), bound_spec_);
}

} // namespace
