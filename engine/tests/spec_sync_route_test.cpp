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
 *  - **So does deleting an imported one.** A refresh writes the document's
 *    examples back for every status except one the user removed (issue #722) -
 *    without that, any later sync of any field undid the delete.
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
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/spec_coverage.hpp"
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
// Defined in examples.cpp - the delete an imported example goes through, which
// is what records the intent a refresh must respect (issue #722).
std::pair<int, nlohmann::json> delete_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const std::string& example_id);
// Defined in runs.cpp - the reader that must not resolve coverage from the
// collection's binding as it stands now.
std::pair<int, nlohmann::json>
run_report_response (vayu::db::Database& db, const std::string& run_id);
} // namespace vayu::http::routes

namespace {

namespace routes = vayu::http::routes;

// Both documents declare their responses, because the engine reads the index
// off the document now (issue #853) - what a run measures against is these
// bytes, not something a caller sent beside them.
constexpr const char* BOUND_DOC =
R"({"openapi":"3.1.0","info":{"title":"Pets","version":"1.0.0"},)"
R"("paths":{"/pets":{"get":{"operationId":"listPets",)"
R"("responses":{"200":{},"404":{}}}}}})";

constexpr const char* FETCHED_DOC =
R"({"openapi":"3.1.0","info":{"title":"Pets","version":"1.1.0"},)"
R"("paths":{"/pets":{"get":{"operationId":"listPets",)"
R"("responses":{"200":{},"404":{}}}},)"
R"("/owners":{"get":{"operationId":"listOwners","responses":{"200":{}}}}}})";

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
    std::string seed_example (const std::string& request_id,
    const std::string& origin,
    int order,
    int status = 200) {
        vayu::db::RequestExample x;
        x.id           = "exa_" + origin + "_" + std::to_string (order);
        x.request_id   = request_id;
        x.name         = origin + " " + std::to_string (order);
        x.status       = status;
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

// A sync moves the binding off the document it named, and nothing owns what is
// left - which is how a weekly sync of a 12 MB document stranded a 12 MB row a
// week, unreachable by any route (issue #718).
TEST_F (SpecSyncRouteTest, SyncingReclaimsTheDocumentTheBindingLeftBehind) {
    // Age the seeded document past the sweep's grace window: it was stored a
    // moment ago, and a document that new is treated as a bind in flight.
    auto seeded = db_->get_spec_document (bound_spec_);
    ASSERT_TRUE (seeded.has_value ());
    seeded->fetched_at -= vayu::core::constants::database::SPEC_DOCUMENT_SWEEP_GRACE_MS + 1000;
    db_->save_spec_document (*seeded);

    auto [status, response] = routes::spec_sync_response (*db_, body ());
    ASSERT_EQ (status, 200) << response.dump ();

    EXPECT_FALSE (db_->get_spec_document (bound_spec_).has_value ())
    << "the superseded document outlived the sync that moved the binding off it";
    // What the binding names now is untouched, which is the half that would make
    // a too-eager sweep catastrophic rather than merely wasteful.
    auto live = db_->get_spec_document (response["specId"].get<std::string> ());
    EXPECT_TRUE (live.has_value ());
}

// The same sync, with a run still naming the document it supersedes: coverage
// on that run's report describes a contract, so its source outlives the binding
// by exactly the run's own retention.
TEST_F (SpecSyncRouteTest, SyncingKeepsASupersededDocumentARunStillNames) {
    auto seeded = db_->get_spec_document (bound_spec_);
    ASSERT_TRUE (seeded.has_value ());
    seeded->fetched_at -= vayu::core::constants::database::SPEC_DOCUMENT_SWEEP_GRACE_MS + 1000;
    db_->save_spec_document (*seeded);

    // The shape a scenario run's manifest stamps into its snapshot.
    vayu::db::Run run;
    run.id              = "run_pins_it";
    run.type            = vayu::RunType::Scenario;
    run.status          = vayu::RunStatus::Completed;
    run.start_time      = 1000;
    run.config_snapshot = json{ { "scenario",
    json{ { "collectionId", root_ }, { "openapi", json{ { "specId", bound_spec_ } } } } } }
                          .dump ();
    db_->create_run (run);

    auto [status, response] = routes::spec_sync_response (*db_, body ());
    ASSERT_EQ (status, 200) << response.dump ();

    EXPECT_TRUE (db_->get_spec_document (bound_spec_).has_value ())
    << "a sync reclaimed the document a retained run was measured against";
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

// Issue #722. The refresh replaces every imported row of a request an apply
// touches, so before this a rename-only sync re-created an example the user had
// deleted - and the delete meant nothing. Deleting one leaves a tombstone and
// the refresh skips that status. Mutation check: drop the
// `suppressed_statuses` skip in `build_example_rows` and the deleted 404 comes
// back, reddening both size assertions.
TEST_F (SpecSyncRouteTest, ADeletedImportedExampleIsNotWrittenBackByALaterSync) {
    const std::string request = create_request (root_);
    seed_example (request, vayu::core::constants::request_example::ORIGIN_IMPORT, 0, 200);
    const std::string unwanted =
    seed_example (request, vayu::core::constants::request_example::ORIGIN_IMPORT, 1, 404);

    auto [deleted, delete_body] =
    routes::delete_request_example_response (*db_, request, unwanted);
    ASSERT_EQ (deleted, 200) << delete_body.dump ();

    // The payload a rename-only tick sends: every documented example, because
    // the diff does not compare them (#654) and the app attaches the lot.
    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "update",
        json::array ({ json{ { "id", request }, { "name", "renamed" },
            { "examples",
                json::array ({ json{ { "name", "200 - A user" }, { "status", 200 } },
                    json{ { "name", "404 - Not found" }, { "status", 404 } } }) } } }) } }));
    ASSERT_EQ (status, 200) << response.dump ();

    auto rows = db_->get_request_examples (request);
    ASSERT_EQ (rows.size (), 1u) << "the deleted 404 example came back";
    EXPECT_EQ (rows[0].status, 200);
    // The status the user kept still refreshes from the document - a tombstone
    // suppresses its own status and nothing else.
    EXPECT_EQ (rows[0].name, "200 - A user");
    EXPECT_EQ (rows[0].order, 0);
}

// The identity a tombstone records is the *status*, not the name: an example's
// name carries the document's response description, which a later revision may
// reword - and a name-keyed tombstone would then miss, resurrecting exactly
// what this fix makes durable (issue #722).
TEST_F (SpecSyncRouteTest, ARewordedDescriptionDoesNotBringADeletedExampleBack) {
    const std::string request = create_request (root_);
    const std::string unwanted =
    seed_example (request, vayu::core::constants::request_example::ORIGIN_IMPORT, 0, 404);
    ASSERT_EQ (routes::delete_request_example_response (*db_, request, unwanted).first, 200);

    auto [status, response] = routes::spec_sync_response (*db_,
    body (json{ { "update",
        json::array ({ json{ { "id", request },
            { "examples", json::array ({ json{ { "name", "404 - No such user any more" },
                { "status", 404 } } }) } } }) } }));
    ASSERT_EQ (status, 200) << response.dump ();
    EXPECT_TRUE (db_->get_request_examples (request).empty ());
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

// ---------------------------------------------------------------------------
// What a sync does *not* touch: an older run's coverage (issue #629, #677 item 3)
// ---------------------------------------------------------------------------

// Coverage is pinned to the document the run was **planned** against, which
// docs/app/openapi.md states as a promise to the reader: "sync the binding to a
// newer spec and an older run's report still says what that run actually
// covered". The pieces of that were each pinned on their own - the plan-time
// hash check, and the summary round trip - but nothing ran the sentence end to
// end, which is the only way to catch a later re-read that resolves coverage
// from the collection's *current* binding instead of from the stored block.
TEST_F (SpecSyncRouteTest, ASyncLeavesAnOlderRunsStoredCoverageAlone) {
    // A document that declares one operation, bound with the hash the engine
    // computed for it - the agreement the plan requires before it will read an
    // index at all.
    auto [stored_status, stored] =
    routes::create_spec_document_response (*db_, json{ { "content", BOUND_DOC } });
    ASSERT_EQ (stored_status, 200) << stored.dump ();
    const std::string v1_id   = stored.value ("id", std::string{});
    const std::string v1_hash = stored.value ("hash", std::string{});
    {
        auto [status, body] = routes::update_collection_response (*db_, root_,
        json{ { "openapi",
        json{ { "specId", v1_id }, { "specHash", v1_hash }, { "syncedAt", 1 } } } });
        ASSERT_EQ (status, 200) << body.dump ();
    }
    create_request (root_,
    json{ { "specOperation",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } } } });

    // Plan the run the way a real one is planned, so the tally counts against
    // the index this collection was bound to when it ran.
    auto plan_now = [&] {
        vayu::core::ScenarioResolveOptions options;
        options.timeout_ms            = 1000;
        options.limits.max_steps      = 10;
        options.limits.max_data_rows  = 10;
        options.limits.max_data_bytes = 4096;
        return vayu::core::resolve_scenario (*db_,
        json{ { "source", "collection" }, { "collectionId", root_ } }, options);
    };
    auto resolved = plan_now ();
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.spec.declared_operations.size (), 1u);

    vayu::core::ScenarioExecution execution;
    execution.plan = resolved.plan;
    execution.spec = resolved.spec;
    auto tally     = vayu::core::make_coverage_tally (execution);
    ASSERT_TRUE (tally.active ());
    tally.record (0, 200);

    vayu::db::Run run;
    run.id              = "run_before_sync";
    run.type            = vayu::RunType::Scenario;
    run.status          = vayu::RunStatus::Completed;
    run.config_snapshot = json{
        { "url", "https://example.test/pets" },
        { "scenario",
        json{ { "collectionId", root_ },
        { "openapi", json{ { "specId", v1_id }, { "specHash", v1_hash } } } } }
    }.dump ();
    run.start_time = 1000;
    run.end_time   = 1001;
    db_->create_run (run);

    vayu::core::RunSummaryInputs inputs;
    inputs.coverage = tally.build ();
    db_->update_run_summary (
    run.id, vayu::core::build_run_summary_payload (inputs).dump ());

    auto [before_status, before] = routes::run_report_response (*db_, run.id);
    ASSERT_EQ (before_status, 200) << before.dump ();
    ASSERT_TRUE (before.contains ("coverage")) << before.dump ();
    const json coverage_before = before["coverage"];

    // The contract moves: a second operation, a second document, a new binding.
    // The index moves with it because the sync stores a new document and the
    // engine reads that one (issue #853) - nothing is carried from the check.
    auto [sync_status, synced] = routes::spec_sync_response (*db_,
    json{ { "collectionId", root_ }, { "spec", json{ { "content", FETCHED_DOC } } } });
    ASSERT_EQ (sync_status, 200) << synced.dump ();
    ASSERT_NE (binding ()["specId"].get<std::string> (), v1_id)
    << "the sync has to have actually moved the binding, or this proves "
       "nothing";
    // And the collection now measures against a contract of two operations, so
    // "1" below is a discrimination rather than a number that could not move.
    auto replanned = plan_now ();
    ASSERT_TRUE (replanned.ok) << replanned.error;
    ASSERT_EQ (replanned.spec.declared_operations.size (), 2u);

    // Re-read the *same* run. Every number, and the stamp naming which document
    // they were computed against, is what it was before the sync.
    auto [after_status, after] = routes::run_report_response (*db_, run.id);
    ASSERT_EQ (after_status, 200) << after.dump ();
    EXPECT_EQ (after["coverage"], coverage_before);
    EXPECT_EQ (after["coverage"]["operationsTotal"].get<size_t> (), 1u)
    << "the newer document declares two - reading it here would say so";
    EXPECT_EQ (after["metadata"]["openapi"]["specId"].get<std::string> (), v1_id);
    EXPECT_EQ (after["metadata"]["openapi"]["specHash"].get<std::string> (), v1_hash);
}

} // namespace
