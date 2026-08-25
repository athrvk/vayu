/**
 * @file tests/spec_bind_route_test.cpp
 * @brief Tests for POST /specs/bind - the third spec write (issue #862).
 *
 * The pairing rule is pinned in operation_match_test.cpp and the document read
 * in openapi_document_test.cpp. What is pinned here is what only this route can
 * get wrong, and each of the three was a bug before it was a rule:
 *
 *  - **Stamping goes both ways** (issue #718). Re-binding to a different
 *    document must leave no request carrying an identity only the previous one
 *    declared. Drop the clearing half and `ARebindLeavesNoIdentityOnlyTheOldDocumentDeclared`
 *    reddens - it is the whole of #718 in one case.
 *  - **The three writes commit together.** A document that cannot be read
 *    leaves the collection bound to what it was bound to, with its stamps
 *    intact and no spec row behind it.
 *  - **The subtree is the scope.** An import binds the root and files every
 *    request under a tag sub-collection, so a bind that only walked the named
 *    collection's own requests would stamp nothing for exactly the collections
 *    this feature exists for - and one that walked further would clear stamps
 *    belonging to a collection the caller never named.
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
#include "vayu/core/spec_coverage.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in spec_bind.cpp / collections.cpp / requests.cpp; each returns
// {http_status, json_body} - the pair the handler writes out.
std::pair<int, nlohmann::json>
bind_spec_response (vayu::db::Database& db, const nlohmann::json& body);
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
} // namespace vayu::http::routes

namespace {

namespace routes = vayu::http::routes;

/** A 3.0 document declaring the two operations most of these cases pair. */
std::string pets_document () {
    return json{ { "openapi", "3.0.0" },
        { "info", { { "title", "Pets" }, { "version", "1.0.0" } } },
        { "paths",
        { { "/pets",
          { { "get",
          { { "operationId", "listPets" },
          { "responses", { { "200", { { "description", "ok" } } } } } } } } },
        { "/pets/{petId}",
        { { "get",
        { { "operationId", "getPet" },
        { "responses", { { "200", { { "description", "ok" } } } } } } } } } } } }
    .dump ();
}

/** A different document, declaring only the operation `/orders` names. */
std::string orders_document () {
    return json{ { "openapi", "3.0.0" },
        { "info", { { "title", "Orders" }, { "version", "1.0.0" } } },
        { "paths",
        { { "/orders",
        { { "get",
        { { "operationId", "listOrders" },
        { "responses", { { "200", { { "description", "ok" } } } } } } } } } } } }
    .dump ();
}

class SpecBindRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_spec_bind_route.db";

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

    std::pair<int, json>
    bind (const std::string& content, const std::string& collection_id = {}) {
        return routes::bind_spec_response (*db_,
        json{ { "collectionId", collection_id.empty () ? root_ : collection_id },
        { "spec", { { "content", content } } } });
    }

    json bind_ok (const std::string& content, const std::string& collection_id = {}) {
        auto [status, body] = bind (content, collection_id);
        EXPECT_EQ (status, 200) << body.dump ();
        return body;
    }

    /** The stored `requests.spec_operation`, or "" for a request carrying none. */
    std::string stamp_of (const std::string& request_id) {
        auto request = db_->get_request (request_id);
        EXPECT_TRUE (request.has_value ());
        return request && request->spec_operation ? *request->spec_operation :
                                                    std::string{};
    }

    json binding_of (const std::string& collection_id) {
        auto collection = db_->get_collection (collection_id);
        EXPECT_TRUE (collection.has_value ());
        if (!collection || collection->openapi.empty ()) {
            return json::object ();
        }
        return json::parse (collection->openapi, nullptr, false);
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::string root_;
};

TEST_F (SpecBindRouteTest, StoresTheDocumentMovesTheBindingAndStampsWhatMatched) {
    const std::string list = create_request (root_, "GET", "{{baseUrl}}/pets");
    const std::string get = create_request (root_, "GET", "{{baseUrl}}/pets/{{petId}}");

    const auto body = bind_ok (pets_document ());

    EXPECT_EQ (body["stamped"], 2u);
    EXPECT_EQ (body["cleared"], 0u);
    EXPECT_TRUE (body["unmatchedRequests"].empty ());
    EXPECT_TRUE (body["unmatchedOperations"].empty ());

    const auto binding = binding_of (root_);
    EXPECT_EQ (binding["specId"], body["specId"]);
    EXPECT_EQ (binding["specHash"], body["specHash"]);
    EXPECT_EQ (binding["syncedAt"], body["syncedAt"]);

    // The document is stored verbatim, and the hash the binding names is the
    // one the row carries - a run stamps that, so the two must be one value.
    auto document = db_->get_spec_document (body["specId"].get<std::string> ());
    ASSERT_HAS_VALUE (document);
    EXPECT_EQ (document->content, pets_document ());
    EXPECT_EQ (document->hash, body["specHash"].get<std::string> ());

    EXPECT_EQ (json::parse (stamp_of (list))["operationId"], "listPets");
    EXPECT_EQ (json::parse (stamp_of (get))["operationId"], "getPet");
    EXPECT_EQ (json::parse (stamp_of (get))["path"], "/pets/{petId}");
}

TEST_F (SpecBindRouteTest, DerivesBothIndexesFromTheDocumentItStores) {
    // The whole reason a bind can be one call: the caller sends bytes, and the
    // indexes coverage and validation read come off those bytes here. A stamp
    // that named an operation the stored index does not declare would resolve
    // to nothing at run time, which is the failure this pins against.
    const std::string list = create_request (root_, "GET", "{{baseUrl}}/pets");
    const auto body        = bind_ok (pets_document ());

    auto document = db_->get_spec_document (body["specId"].get<std::string> ());
    ASSERT_HAS_VALUE (document);
    auto declared = vayu::core::parse_declared_operations (document->operations);
    ASSERT_HAS_VALUE (declared);
    EXPECT_EQ (declared->size (), 2u);

    const vayu::core::OperationIndex index (*declared);
    const auto resolved = index.resolve (stamp_of (list));
    ASSERT_HAS_VALUE (resolved);
    EXPECT_EQ ((*declared)[*resolved].operation_id, "listPets");
}

TEST_F (SpecBindRouteTest, ARebindLeavesNoIdentityOnlyTheOldDocumentDeclared) {
    // Issue #718, whole. `/pets` matches the first document and nothing in the
    // second, so after the re-bind it must carry no identity at all - a stamp
    // surviving here is read by coverage as the request *being* an operation of
    // a document this collection is not bound to.
    const std::string pets = create_request (root_, "GET", "{{baseUrl}}/pets");
    const std::string orders = create_request (root_, "GET", "{{baseUrl}}/orders");

    bind_ok (pets_document ());
    ASSERT_FALSE (stamp_of (pets).empty ());
    ASSERT_TRUE (stamp_of (orders).empty ());

    const auto body = bind_ok (orders_document ());

    EXPECT_EQ (body["stamped"], 1u);
    EXPECT_EQ (body["cleared"], 1u);
    EXPECT_EQ (stamp_of (pets), "")
    << "a stamp only the previous document declared survived";
    EXPECT_EQ (json::parse (stamp_of (orders))["operationId"], "listOrders");
}

TEST_F (SpecBindRouteTest, ClearsAStampWhoseOperationIdTheNewDocumentAlsoDeclares) {
    // The sharpest form of #718: the surviving stamp would not merely go
    // unread, it would resolve. Coverage resolves by `operationId` first, so a
    // request left carrying `listPets` after binding a document that declares
    // `listPets` at a different path claims *that* operation.
    const std::string pets = create_request (root_, "GET", "{{baseUrl}}/pets");
    bind_ok (pets_document ());
    ASSERT_EQ (json::parse (stamp_of (pets))["operationId"], "listPets");

    // Same id, different path - so the request no longer matches by shape.
    const std::string moved = json{
        { "openapi", "3.0.0" },
        { "info", { { "title", "Pets" }, { "version", "2.0.0" } } },
        { "paths",
        { { "/v2/pets",
        { { "get",
        { { "operationId", "listPets" },
        { "responses", { { "200", { { "description", "ok" } } } } } } } } } } }
    }.dump ();

    const auto body = bind_ok (moved);
    EXPECT_EQ (body["cleared"], 1u);
    EXPECT_EQ (stamp_of (pets), "");
}

TEST_F (SpecBindRouteTest, StampsRequestsAnywhereBeneathTheNamedCollection) {
    // The shape an OpenAPI import leaves: the root owns no request at all.
    const std::string tag =
    create_collection (json{ { "name", "pets" }, { "parentId", root_ } });
    const std::string list = create_request (tag, "GET", "{{baseUrl}}/pets");

    const auto body = bind_ok (pets_document ());

    EXPECT_EQ (body["stamped"], 1u);
    EXPECT_EQ (json::parse (stamp_of (list))["operationId"], "listPets");
    // The operation nothing claimed is reported rather than silently dropped: a
    // caller deciding whether to sync needs to know the document declares more
    // than the collection holds.
    ASSERT_EQ (body["unmatchedOperations"].size (), 1u);
    EXPECT_EQ (body["unmatchedOperations"][0]["operationId"], "getPet");
}

TEST_F (SpecBindRouteTest, LeavesARequestOutsideTheSubtreeAlone) {
    // A bind is an operation on one collection's contract. A request under a
    // *sibling* collection matches the same shape and carries a stamp of its
    // own, and neither the stamping nor the clearing half may reach it.
    const std::string other = create_collection (json{ { "name", "Other API" } });
    const std::string alien = create_request (other, "GET", "{{baseUrl}}/pets");
    {
        auto [status, response] = routes::update_request_response (*db_, alien,
        json{ { "specOperation",
        { { "operationId", "somethingElse" }, { "method", "GET" }, { "path", "/pets" } } } });
        ASSERT_EQ (status, 200) << response.dump ();
    }
    const std::string mine = create_request (root_, "GET", "{{baseUrl}}/pets");

    const auto body = bind_ok (pets_document ());

    EXPECT_EQ (body["stamped"], 1u);
    EXPECT_EQ (body["cleared"], 0u);
    EXPECT_EQ (json::parse (stamp_of (alien))["operationId"], "somethingElse");
    EXPECT_TRUE (binding_of (other).empty ());
    EXPECT_EQ (json::parse (stamp_of (mine))["operationId"], "listPets");
}

TEST_F (SpecBindRouteTest, ADocumentThatCannotBeReadChangesNothing) {
    // The transaction's own rule: a bind either happened or did not. The
    // document is read before anything is written, so a collection bound to a
    // working document stays bound to it, stamps and all, and no orphan row is
    // left behind.
    const std::string pets = create_request (root_, "GET", "{{baseUrl}}/pets");
    const auto first       = bind_ok (pets_document ());
    const std::string stamp_before = stamp_of (pets);

    auto [status, body] = bind ("openapi: \"3.0.0\"\npaths: [unterminated");
    EXPECT_EQ (status, 400) << body.dump ();

    EXPECT_EQ (binding_of (root_)["specId"], first["specId"]);
    EXPECT_EQ (stamp_of (pets), stamp_before);
    // Nothing unreferenced was left behind either: the sweep reclaims exactly
    // the documents no collection binds, so a zero here is "the refused bind
    // stored no row" rather than "we did not look".
    EXPECT_EQ (db_->sweep_orphaned_spec_documents (), 0u);
}

TEST_F (SpecBindRouteTest, ReadsAYamlDocumentTheSameWay) {
    // The reader is the engine's since #853, and a stored document is YAML as
    // often as JSON - so the one call an agent makes must accept both.
    const std::string list = create_request (root_, "GET", "{{baseUrl}}/pets");
    const auto body =
    bind_ok ("openapi: \"3.0.0\"\n"
             "info:\n  title: Pets\n  version: \"1.0.0\"\n"
             "paths:\n  /pets:\n    get:\n      operationId: listPets\n"
             "      responses:\n        \"200\":\n          description: ok\n");

    EXPECT_EQ (body["stamped"], 1u);
    EXPECT_EQ (json::parse (stamp_of (list))["operationId"], "listPets");
}

TEST_F (SpecBindRouteTest, BindsADocumentDeclaringNothingRatherThanRefusingIt) {
    // A Postman export stored here declares zero operations - the honest answer
    // rather than an error, per `declared_operations_of`. What matters is that
    // the clearing half still runs: the collection is bound to a contract with
    // nothing in it, so no request may claim to be an operation of it.
    const std::string pets = create_request (root_, "GET", "{{baseUrl}}/pets");
    bind_ok (pets_document ());
    ASSERT_FALSE (stamp_of (pets).empty ());

    const auto body =
    bind_ok (json{ { "info", { { "name", "A Postman collection" } } } }.dump ());
    EXPECT_EQ (body["stamped"], 0u);
    EXPECT_EQ (body["cleared"], 1u);
    EXPECT_EQ (stamp_of (pets), "");
}

TEST_F (SpecBindRouteTest, RefusesAnUnknownCollection) {
    auto [status, body] = bind (pets_document (), "col_nope");
    EXPECT_EQ (status, 404) << body.dump ();
    EXPECT_EQ (db_->sweep_orphaned_spec_documents (), 0u);
}

TEST_F (SpecBindRouteTest, RefusesTheFieldsTheEngineOwns) {
    // Same rule as `POST /specs`: a hash, a fetch time or an index a caller
    // worked out is a claim about bytes nobody verified.
    for (const char* field : { "id", "hash", "fetchedAt", "operations", "responseSchemas" }) {
        auto [status, body] = routes::bind_spec_response (*db_,
        json{ { "collectionId", root_ },
        { "spec", { { "content", pets_document () }, { field, "anything" } } } });
        EXPECT_EQ (status, 400) << field << ": " << body.dump ();
    }
    EXPECT_EQ (db_->sweep_orphaned_spec_documents (), 0u);
}

TEST_F (SpecBindRouteTest, RefusesABodyWithNoDocumentInIt) {
    for (const auto& body_json : { json{ { "collectionId", root_ } },
         json{ { "collectionId", root_ }, { "spec", "text" } },
         json{ { "collectionId", root_ }, { "spec", { { "content", "" } } } },
         json{ { "spec", { { "content", pets_document () } } } } }) {
        auto [status, body] = routes::bind_spec_response (*db_, body_json);
        EXPECT_EQ (status, 400) << body_json.dump () << " -> " << body.dump ();
    }
}

TEST_F (SpecBindRouteTest, DoesNotRewriteARequestItNeitherStampedNorCleared) {
    // `updated_at` is read by the app's caches, so a bind must touch only the
    // rows whose identity it changed - a request that matched nothing and
    // carried nothing is not part of the write.
    const std::string spare = create_request (root_, "POST", "{{baseUrl}}/unrelated");
    auto before = db_->get_request (spare);
    ASSERT_HAS_VALUE (before);

    const auto body = bind_ok (pets_document ());
    EXPECT_EQ (body["stamped"], 0u);
    EXPECT_EQ (body["cleared"], 0u);

    auto after = db_->get_request (spare);
    ASSERT_HAS_VALUE (after);
    EXPECT_EQ (after->updated_at, before->updated_at);
}

} // namespace
