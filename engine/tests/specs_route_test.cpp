/**
 * @file tests/specs_route_test.cpp
 * @brief The OpenAPI storage foundation (issue #637): the `/specs` routes, the
 *        collection binding, per-request operation identity, the fourth
 *        `/import/apply` section, and the run stamp.
 *
 * Focus: this is a *contract* four later phases build on, so what is pinned here
 * is the shape they will read - not merely that a write succeeds.
 *
 *  - A spec is stored once with an engine-computed hash, and a bound one cannot
 *    be deleted out from under its collection.
 *  - A binding that names nothing is refused at the write, on every path, so no
 *    collection can read back as bound to a spec nobody can fetch.
 *  - `specOperation` reads back identically through **both** request serializers.
 *    They are separate code (`serialize` and `serialize_to_stream`) and a field
 *    added to one and forgotten in the other is this repo's standing trap.
 *  - A bound collection's run stamps `specId`/`specHash`; an unbound one stamps
 *    nothing at all, absent rather than empty.
 *
 * Covers the routes' extracted cores in isolation, matching the suite's other
 * route tests (no in-process HTTP server).
 */

#include <array>
#include <gtest/gtest.h>

#include <memory>
#include <sstream>
#include <string>
#include <unordered_set>
#include <utility>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/schema_validation.hpp"
#include "vayu/db/database.hpp"
// For `resolve_design_schema_index` - the design path this file now pins
// against the scenario path (issue #716).
#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in specs.cpp; each returns {http_status, json_body}.
std::pair<int, nlohmann::json>
create_spec_document_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
get_spec_document_response (vayu::db::Database& db, const std::string& id);
std::pair<int, nlohmann::json>
get_spec_document_meta_response (vayu::db::Database& db, const std::string& id);
std::pair<int, nlohmann::json>
delete_spec_document_response (vayu::db::Database& db, const std::string& id);
std::string spec_content_hash (const std::string& content);
// Defined in collections.cpp / requests.cpp / import.cpp.
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
get_request_response (vayu::db::Database& db, const std::string& id);
std::string list_requests_body (vayu::db::Database& db, const std::string& collection_id);
std::pair<int, nlohmann::json>
import_apply_response (vayu::db::Database& db, const nlohmann::json& body);
} // namespace vayu::http::routes

namespace {

namespace routes = vayu::http::routes;

/** A minimal but real OpenAPI 3.1 document - the text is stored verbatim. */
constexpr const char* PETSTORE =
R"({"openapi":"3.1.0","info":{"title":"Pets","version":"1.0.0"},)"
R"("paths":{"/pets":{"get":{"operationId":"listPets","responses":{"200":{}}}}}})";

/// What the engine reads off {@link PETSTORE} (issue #853). Named once because
/// several cases assert it: the index is no longer something a caller sends, so
/// the document *is* the input and this is the whole of the output.
/// A function rather than a namespace-scope `json`, here and for the schema
/// index below: building one allocates, and at namespace scope that runs before
/// `main` where the throw cannot be caught (`cert-err58-cpp`).
const json& petstore_index () {
    static const json index =
    json::array ({ json{ { "operationId", "listPets" }, { "method", "GET" },
    { "path", "/pets" }, { "responses", json::array ({ "200" }) } } });
    return index;
}

/// The same document with a response schema on it, for the cases that need a
/// stored `response_schemas` index. That index is derived from the document too
/// now (issue #860), so a case that wants one says so in the *document* rather
/// than in the body of the write.
constexpr const char* PETSTORE_SCHEMAS =
R"({"openapi":"3.1.0","info":{"title":"Pets","version":"1.0.0"},)"
R"("paths":{"/pets":{"get":{"operationId":"listPets","responses":)"
R"({"200":{"content":{"application/json":{"schema":{"type":"array"}}}}}}}}})";

/// What the engine reads off {@link PETSTORE_SCHEMAS} (issue #860).
const json& petstore_schema_index () {
    static const json index = json{ { "operations",
    json::array ({ json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" },
    { "responses",
    json::array ({ json{ { "status", "200" }, { "contentType", "application/json" },
    { "schema", json{ { "type", "array" } } } } }) } } }) } };
    return index;
}

/// A document Vayu stores happily and reads as declaring nothing - a Postman
/// export is a perfectly good file that is not a contract. Its column stays
/// empty, which is "no index" rather than "an empty contract".
constexpr const char* NOT_A_SPEC =
R"({"info":{"name":"Team","schema":"https://schema.getpostman.com/json/collection/v2.1.0/"},)"
R"("item":[{"name":"Ping"}]})";

class SpecsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_specs_route.db";

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

    /** Stores one document through the route core and returns its id. */
    std::string store_spec (const char* content = PETSTORE) {
        auto [status, body] =
        routes::create_spec_document_response (*db_, json{ { "content", content } });
        EXPECT_EQ (status, 200) << body.dump ();
        return body.value ("id", std::string{});
    }

    /** Creates a collection through the route core and returns its id. */
    std::string create_collection (const json& body) {
        auto [status, response] = routes::create_collection_response (*db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response.value ("id", std::string{});
    }

    /**
     * Resolves @p collection_id into a plan, with the limits every test here
     * uses. One copy: what these assert is the *binding* the resolution carries,
     * and four hand-written limit blocks would be four chances to disagree about
     * the run being resolved.
     */
    vayu::core::ScenarioResolution resolve (const std::string& collection_id) {
        vayu::core::ScenarioResolveOptions options;
        options.timeout_ms            = 1000;
        options.limits.max_steps      = 10;
        options.limits.max_data_rows  = 10;
        options.limits.max_data_bytes = 4096;
        return vayu::core::resolve_scenario (*db_,
        json{ { "source", "collection" }, { "collectionId", collection_id } }, options);
    }

    /** Creates a request under @p collection_id and returns its id. */
    std::string create_request (const std::string& collection_id,
    const json& extra = json::object ()) {
        json body = { { "collectionId", collection_id }, { "name", "list pets" },
            { "method", "GET" }, { "url", "https://example.test/pets" } };
        body.update (extra);
        auto [status, response] = routes::create_request_response (*db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response.value ("id", std::string{});
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// ---------------------------------------------------------------------------
// POST /specs - stored once, hashed here
// ---------------------------------------------------------------------------

TEST_F (SpecsRouteTest, StoresTheDocumentVerbatimWithAnEngineComputedHash) {
    auto [status, body] = routes::create_spec_document_response (*db_,
    json{ { "content", PETSTORE }, { "sourceUrl", "https://example.test/openapi.json" } });
    ASSERT_EQ (status, 200) << body.dump ();

    EXPECT_EQ (body["content"].get<std::string> (), PETSTORE)
    << "the document must round-trip byte for byte - every later phase parses "
       "this text";
    EXPECT_EQ (body["sourceUrl"].get<std::string> (), "https://example.test/openapi.json");
    EXPECT_TRUE (body["id"].get<std::string> ().starts_with ("spec_"));
    EXPECT_GT (body["fetchedAt"].get<int64_t> (), 0);
    // The value, not merely "a string": the run stamp is only worth anything if
    // both sides of a comparison were computed by this function on these bytes.
    EXPECT_EQ (body["hash"].get<std::string> (), routes::spec_content_hash (PETSTORE));
    EXPECT_EQ (body["hash"].get<std::string> ().size (), 64u) << "hex sha256";
}

TEST_F (SpecsRouteTest, SourceUrlIsNullWhenTheDocumentDidNotComeFromOne) {
    auto [status, body] =
    routes::create_spec_document_response (*db_, json{ { "content", PETSTORE } });
    ASSERT_EQ (status, 200) << body.dump ();
    // Null rather than "": a client offers "re-fetch" for exactly the documents
    // that have somewhere to re-fetch from, and "" would look like one.
    EXPECT_TRUE (body["sourceUrl"].is_null ());
}

TEST_F (SpecsRouteTest, RejectsAnEmptyOrMissingDocument) {
    auto [missing, missing_body] =
    routes::create_spec_document_response (*db_, json::object ());
    EXPECT_EQ (missing, 400) << missing_body.dump ();

    auto [empty, empty_body] =
    routes::create_spec_document_response (*db_, json{ { "content", "" } });
    EXPECT_EQ (empty, 400) << empty_body.dump ();
}

TEST_F (SpecsRouteTest, RejectsAnEngineOwnedFieldInTheBody) {
    for (const char* field : { "id", "hash", "fetchedAt" }) {
        json body = { { "content", PETSTORE } };
        body[field] = field == std::string ("fetchedAt") ? json (1) : json ("spoofed");
        auto [status, response] = routes::create_spec_document_response (*db_, body);
        EXPECT_EQ (status, 400) << field << ": " << response.dump ();
    }
}

TEST_F (SpecsRouteTest, RefusesADocumentOverTheConfiguredCapNamingBothNumbers) {
    // Below the compiled default, so this proves the *live* config entry is what
    // the write reads - not the constant.
    auto entry = db_->get_config_entry ("maxSpecDocumentBytes");
    ASSERT_HAS_VALUE (entry) << "the cap must be a seeded, user-visible knob";
    entry->value = "64";
    db_->save_config_entry (*entry);
    const std::string oversized (128, 'x');

    auto [status, body] =
    routes::create_spec_document_response (*db_, json{ { "content", oversized } });
    ASSERT_EQ (status, 400) << body.dump ();
    const std::string message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("128"), std::string::npos) << message;
    EXPECT_NE (message.find ("64"), std::string::npos) << message;
    EXPECT_NE (message.find ("maxSpecDocumentBytes"), std::string::npos) << message;
}

// ---------------------------------------------------------------------------
// GET / DELETE /specs/:id
// ---------------------------------------------------------------------------

TEST_F (SpecsRouteTest, ReadsBackTheStoredDocumentAndAnswers404ForAMissingOne) {
    const std::string id = store_spec ();

    auto [found, found_body] = routes::get_spec_document_response (*db_, id);
    ASSERT_EQ (found, 200) << found_body.dump ();
    EXPECT_EQ (found_body["content"].get<std::string> (), PETSTORE);

    auto [missing, missing_body] = routes::get_spec_document_response (*db_, "spec_nope");
    EXPECT_EQ (missing, 404) << missing_body.dump ();
}

TEST_F (SpecsRouteTest, SpecMetaCarriesTheSameValuesAsTheFullDocumentWithoutTheHeavyFields) {
    // A document carrying *both* indexes, because they are the two fields that
    // make a "metadata" read expensive if they ride along: both describe the
    // document and grow with it. Both are the engine's own, derived from the
    // document (issues #853 and #860), so the document is what says so.
    auto [create_status, created] = routes::create_spec_document_response (*db_,
    json{ { "content", PETSTORE_SCHEMAS },
    { "sourceUrl", "https://example.test/openapi.json" } });
    ASSERT_EQ (create_status, 200) << created.dump ();
    const std::string id = created.value ("id", std::string{});
    ASSERT_FALSE (created["operations"].is_null ()) << created.dump ();
    ASSERT_FALSE (created["responseSchemas"].is_null ())
    << "the premise of this case: a document whose read is expensive both ways";

    auto [status, meta] = routes::get_spec_document_meta_response (*db_, id);
    ASSERT_EQ (status, 200) << meta.dump ();

    // Absent, not empty. `"content": ""` would read as a document with no text
    // and `"operations": []` as one that declares nothing - both of which are
    // states a document can genuinely be in, so an unread field must not spell
    // itself the same way (the repo's absent-not-empty rule).
    EXPECT_FALSE (meta.contains ("content")) << meta.dump ();
    EXPECT_FALSE (meta.contains ("operations")) << meta.dump ();
    EXPECT_FALSE (meta.contains ("responseSchemas")) << meta.dump ();

    // Bytes as the engine counts them - the same measure the write cap refuses
    // by, so the number beside a document is in the unit of its limit.
    EXPECT_EQ (
    meta["contentBytes"].get<size_t> (), std::string (PETSTORE_SCHEMAS).size ());

    // Every other key is the full read's answer, value for value: the two are
    // one row seen two ways, and a client that reads `sourceUrl` from the cheap
    // route must get exactly what the expensive one would have said. This is
    // what stops the meta shape drifting when a field is added above.
    auto [full_status, full] = routes::get_spec_document_response (*db_, id);
    ASSERT_EQ (full_status, 200) << full.dump ();
    for (const auto& [key, value] : meta.items ()) {
        if (key == "contentBytes") {
            continue; // derived here; the full read carries no such field
        }
        ASSERT_TRUE (full.contains (key)) << key << " is not a field of the document";
        EXPECT_EQ (value, full[key]) << key;
    }
    EXPECT_EQ (meta["sourceUrl"].get<std::string> (), "https://example.test/openapi.json");
    EXPECT_EQ (meta["hash"].get<std::string> (), routes::spec_content_hash (PETSTORE_SCHEMAS));
    EXPECT_GT (meta["fetchedAt"].get<int64_t> (), 0);
}

TEST_F (SpecsRouteTest, SpecMetaAnswersTheSame404AsTheFullReadForAMissingDocument) {
    auto [meta_status, meta] = routes::get_spec_document_meta_response (*db_, "spec_nope");
    auto [full_status, full] = routes::get_spec_document_response (*db_, "spec_nope");

    EXPECT_EQ (meta_status, 404) << meta.dump ();
    // One resource, two reads: a client falling back from one to the other must
    // not have to know two shapes of "not found".
    EXPECT_EQ (meta_status, full_status);
    EXPECT_EQ (meta, full) << meta.dump () << " vs " << full.dump ();
}

TEST_F (SpecsRouteTest, DeletesAnUnboundDocument) {
    const std::string id = store_spec ();

    auto [status, body] = routes::delete_spec_document_response (*db_, id);
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_FALSE (db_->get_spec_document (id).has_value ());
}

TEST_F (SpecsRouteTest, RefusesToDeleteADocumentACollectionStillBindsAndNamesIt) {
    const std::string spec_id = store_spec ();
    create_collection (json{ { "name", "Pets API" },
    { "openapi",
    { { "specId", spec_id }, { "specHash", routes::spec_content_hash (PETSTORE) } } } });

    auto [status, body] = routes::delete_spec_document_response (*db_, spec_id);
    ASSERT_EQ (status, 409) << body.dump ();
    const std::string message = body["error"]["message"].get<std::string> ();
    // Actionable without a second round trip - the caller has to know *which*
    // collection to unbind.
    EXPECT_NE (message.find ("Pets API"), std::string::npos) << message;
    EXPECT_TRUE (db_->get_spec_document (spec_id).has_value ())
    << "a refused delete must leave the document alone";
}

TEST_F (SpecsRouteTest, DeleteSucceedsOnceTheCollectionUnbinds) {
    const std::string spec_id = store_spec ();
    const std::string col_id  = create_collection (
    json{ { "name", "Pets API" }, { "openapi", { { "specId", spec_id } } } });

    // Unbinding is the one null-vs-absent rule, not a verb of its own.
    auto [unbound, unbound_body] =
    routes::update_collection_response (*db_, col_id, json{ { "openapi", nullptr } });
    ASSERT_EQ (unbound, 200) << unbound_body.dump ();
    EXPECT_TRUE (unbound_body["openapi"].is_object ());
    EXPECT_TRUE (unbound_body["openapi"].empty ())
    << "`{}` is how unbound is spelled";

    auto [status, body] = routes::delete_spec_document_response (*db_, spec_id);
    EXPECT_EQ (status, 200) << body.dump ();
}

// ---------------------------------------------------------------------------
// The collection binding
// ---------------------------------------------------------------------------

TEST_F (SpecsRouteTest, AnUnboundCollectionSerializesAnEmptyBinding) {
    const std::string col_id = create_collection (json{ { "name", "Plain" } });
    auto stored              = db_->get_collection (col_id);
    ASSERT_HAS_VALUE (stored);
    const auto serialized = vayu::json::serialize (*stored);
    ASSERT_TRUE (serialized.contains ("openapi"));
    EXPECT_TRUE (serialized["openapi"].is_object ());
    EXPECT_TRUE (serialized["openapi"].empty ());
}

TEST_F (SpecsRouteTest, RejectsABindingThatNamesNoSpec) {
    const std::string spec_id = store_spec ();
    // An object that is not empty is a binding, and a binding without a specId
    // names nothing - it would read back as a bound collection nobody can
    // resolve.
    auto [status, body] = routes::create_collection_response (
    *db_, json{ { "name", "Pets" }, { "openapi", { { "syncedAt", 5 } } } });
    EXPECT_EQ (status, 400) << body.dump ();

    for (const auto& bad : { json{ { "specId", spec_id }, { "specHash", 7 } },
         json{ { "specId", spec_id }, { "syncedAt", "yesterday" } } }) {
        auto [bad_status, bad_body] = routes::create_collection_response (
        *db_, json{ { "name", "Pets" }, { "openapi", bad } });
        EXPECT_EQ (bad_status, 400) << bad_body.dump ();
    }
}

TEST_F (SpecsRouteTest, RejectsABindingToASpecThatDoesNotExist) {
    auto [created, created_body] = routes::create_collection_response (*db_,
    json{ { "name", "Pets" }, { "openapi", { { "specId", "spec_ghost" } } } });
    ASSERT_EQ (created, 400) << created_body.dump ();
    EXPECT_NE (
    created_body["error"]["message"].get<std::string> ().find ("spec_ghost"),
    std::string::npos);

    // And on update, which is the path a bind-from-here flow actually uses.
    const std::string col_id = create_collection (json{ { "name", "Pets" } });
    auto [updated, updated_body] = routes::update_collection_response (
    *db_, col_id, json{ { "openapi", { { "specId", "spec_ghost" } } } });
    EXPECT_EQ (updated, 400) << updated_body.dump ();
}

TEST_F (SpecsRouteTest, AnUpdateThatSaysNothingAboutTheBindingKeepsIt) {
    const std::string spec_id = store_spec ();
    const std::string col_id  = create_collection (json{ { "name", "Pets" },
     { "openapi", { { "specId", spec_id }, { "syncedAt", 42 } } } });

    auto [status, body] =
    routes::update_collection_response (*db_, col_id, json{ { "name", "Pets v2" } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["openapi"]["specId"].get<std::string> (), spec_id);
    EXPECT_EQ (body["openapi"]["syncedAt"].get<int> (), 42);
}

// ---------------------------------------------------------------------------
// The version half of a binding, which the engine owns (issue #709)
// ---------------------------------------------------------------------------

TEST_F (SpecsRouteTest, ABindingWrittenWithoutAVersionIsStampedFromTheStoredDocument) {
    const std::string spec_id = store_spec ();
    auto [status, body]       = routes::create_collection_response (
    *db_, json{ { "name", "Pets" }, { "openapi", { { "specId", spec_id } } } });
    ASSERT_EQ (status, 200) << body.dump ();
    // A caller can only name the document; which *version* of it is stored is
    // the engine's to say, exactly as `spec_documents.hash` is.
    EXPECT_EQ (body["openapi"].value ("specHash", std::string{}),
    routes::spec_content_hash (PETSTORE));
    EXPECT_GT (body["openapi"].value ("syncedAt", int64_t{ 0 }), 0);

    const auto row = db_->get_collection (body["id"].get<std::string> ());
    ASSERT_HAS_VALUE (row)
    << "the create must have stored the collection it just returned";
    const json stored = json::parse (row->openapi);
    EXPECT_EQ (stored.value ("specHash", std::string{}), routes::spec_content_hash (PETSTORE))
    << "the response must be the row, not a dressed-up copy of it";
}

TEST_F (SpecsRouteTest, AnUpdateThatBindsIsStampedTheSameWay) {
    const std::string spec_id = store_spec ();
    // The path the Spec tab's bind-from-here flow actually takes.
    const std::string col_id = create_collection (json{ { "name", "Pets" } });
    auto [status, body]      = routes::update_collection_response (
    *db_, col_id, json{ { "openapi", { { "specId", spec_id } } } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["openapi"]["specHash"].get<std::string> (),
    routes::spec_content_hash (PETSTORE));
    EXPECT_GT (body["openapi"]["syncedAt"].get<int64_t> (), 0);
}

TEST_F (SpecsRouteTest, AStampFillsWhatIsMissingAndOverwritesNothing) {
    const std::string spec_id = store_spec ();
    // A binding whose recorded version the document has since moved past is a
    // real state - it is what a run reports as `hash_mismatch` - so a write must
    // not quietly "repair" it into agreement with whatever is stored today.
    const std::string col_id = create_collection (json{ { "name", "Pets" },
    { "openapi", { { "specId", spec_id }, { "specHash", "stale-hash" }, { "syncedAt", 42 } } } });
    const auto row           = db_->get_collection (col_id);
    ASSERT_HAS_VALUE (row);
    const json stored = json::parse (row->openapi);
    EXPECT_EQ (stored.value ("specHash", std::string{}), "stale-hash");
    EXPECT_EQ (stored.value ("syncedAt", int64_t{ 0 }), 42);
}

// ---------------------------------------------------------------------------
// The startup repair for bindings written before the engine stamped them
// ---------------------------------------------------------------------------

TEST_F (SpecsRouteTest, StartupStampsAnUnstampedBindingFromTheDocumentItNames) {
    const std::string spec_id = store_spec ();
    // Written the way every pre-#709 import wrote it: the id alone. Straight to
    // the row, because no route produces this state any more.
    vayu::db::Collection legacy;
    legacy.id         = "col_legacy";
    legacy.name       = "Imported";
    legacy.order      = 0;
    legacy.created_at = 1;
    legacy.updated_at = 1;
    legacy.openapi    = json{ { "specId", spec_id } }.dump ();
    db_->create_collection (legacy);

    db_->init (); // idempotent, and where the repair pass runs

    const auto document = db_->get_spec_document (spec_id);
    ASSERT_HAS_VALUE (document);
    const auto legacy_row = db_->get_collection ("col_legacy");
    ASSERT_HAS_VALUE (legacy_row);
    const json stored = json::parse (legacy_row->openapi);
    EXPECT_EQ (stored.value ("specHash", std::string{}), document->hash);
    EXPECT_EQ (stored.value ("syncedAt", int64_t{ 0 }), document->fetched_at)
    << "the binding was made when the document was stored, not on this restart";

    // And a second start leaves it alone - a repair pass that re-stamped would
    // move `syncedAt` forward on every launch.
    db_->init ();
    const auto restarted_row = db_->get_collection ("col_legacy");
    ASSERT_HAS_VALUE (restarted_row);
    EXPECT_EQ (json::parse (restarted_row->openapi).value ("syncedAt", int64_t{ 0 }),
    document->fetched_at);
}

TEST_F (SpecsRouteTest, StartupLeavesABindingWhoseDocumentIsGoneUntouched) {
    vayu::db::Collection orphan;
    orphan.id         = "col_orphan";
    orphan.name       = "Imported";
    orphan.order      = 0;
    orphan.created_at = 1;
    orphan.updated_at = 1;
    orphan.openapi    = json{ { "specId", "spec_ghost" } }.dump ();
    db_->create_collection (orphan);

    db_->init ();

    const auto orphan_row = db_->get_collection ("col_orphan");
    ASSERT_HAS_VALUE (orphan_row);
    const json stored = json::parse (orphan_row->openapi);
    EXPECT_EQ (stored["specId"].get<std::string> (), "spec_ghost");
    EXPECT_FALSE (stored.contains ("specHash"))
    << "there is nothing to stamp it from, and a run says so already";
}

// ---------------------------------------------------------------------------
// Per-request operation identity - through both serializers
// ---------------------------------------------------------------------------

TEST_F (SpecsRouteTest, OperationIdentityReadsBackIdenticallyThroughBothSerializers) {
    const std::string col_id = create_collection (json{ { "name", "Pets" } });
    const json operation = { { "operationId", "listPets" }, { "method", "GET" },
        { "path", "/pets/{petId}" } };
    const std::string req_id =
    create_request (col_id, json{ { "specOperation", operation } });

    // The single-request route (`serialize`).
    auto [status, single] = routes::get_request_response (*db_, req_id);
    ASSERT_EQ (status, 200) << single.dump ();
    ASSERT_TRUE (single.contains ("specOperation"));
    EXPECT_EQ (single["specOperation"], operation);

    // The list route (`serialize_to_stream`) - separate code, and the half this
    // repo has forgotten before. Parsed back so the comparison is structural
    // rather than a key-order coincidence.
    const json listed = json::parse (routes::list_requests_body (*db_, col_id));
    ASSERT_EQ (listed.size (), 1u);
    ASSERT_TRUE (listed[0].contains ("specOperation"));
    EXPECT_EQ (listed[0]["specOperation"], single["specOperation"])
    << "the list route and the single route disagree about specOperation";
}

TEST_F (SpecsRouteTest, ARequestThatNamesNoOperationSerializesNullOnBothPaths) {
    const std::string col_id = create_collection (json{ { "name", "Pets" } });
    const std::string req_id = create_request (col_id);

    auto [status, single] = routes::get_request_response (*db_, req_id);
    ASSERT_EQ (status, 200) << single.dump ();
    ASSERT_TRUE (single.contains ("specOperation"))
    << "the key must always be present - absent would read as 'not serialized "
       "yet' rather than 'declares no operation'";
    EXPECT_TRUE (single["specOperation"].is_null ());

    const json listed = json::parse (routes::list_requests_body (*db_, col_id));
    ASSERT_EQ (listed.size (), 1u);
    // `contains` before the read: a stream serializer that dropped the key would
    // otherwise abort the whole binary on nlohmann's debug assertion instead of
    // failing this one test.
    ASSERT_TRUE (listed[0].contains ("specOperation"));
    EXPECT_TRUE (listed[0]["specOperation"].is_null ());
}

TEST_F (SpecsRouteTest, OperationIdentityIsUnsetByAnExplicitNullOnUpdate) {
    const std::string col_id = create_collection (json{ { "name", "Pets" } });
    const std::string req_id = create_request (col_id,
    json{ { "specOperation", { { "method", "GET" }, { "path", "/pets" } } } });

    auto [kept, kept_body] =
    routes::update_request_response (*db_, req_id, json{ { "name", "renamed" } });
    ASSERT_EQ (kept, 200) << kept_body.dump ();
    EXPECT_FALSE (kept_body["specOperation"].is_null ()) << "absent means keep";

    auto [reset, reset_body] = routes::update_request_response (
    *db_, req_id, json{ { "specOperation", nullptr } });
    ASSERT_EQ (reset, 200) << reset_body.dump ();
    EXPECT_TRUE (reset_body["specOperation"].is_null ());
    const auto reset_row = db_->get_request (req_id);
    ASSERT_HAS_VALUE (reset_row);
    EXPECT_FALSE (reset_row->spec_operation.has_value ())
    << "the column must be NULL, not the string \"{}\"";
}

TEST_F (SpecsRouteTest, RejectsAnOperationIdentityThatIsNotOne) {
    const std::string col_id = create_collection (json{ { "name", "Pets" } });
    const auto bad           = std::to_array<json> ({
    json ("GET /pets"),                            // not an object
    json{ { "operationId", "listPets" } },         // no method/path
    json{ { "method", "GET" } },                   // no path
    json{ { "path", "/pets" } },                   // no method
    json{ { "method", "" }, { "path", "/pets" } }, // empty method
    json{ { "method", "GET" }, { "path", "pets" } }, // not a template path
    json{ { "method", "GET" }, { "path", "https://x/p" } }, // a concrete URL
    json{ { "method", "GET" }, { "path", "/pets" }, { "operationId", 7 } },
    });
    for (const auto& operation : bad) {
        json body = { { "collectionId", col_id }, { "name", "r" }, { "method", "GET" },
            { "url", "https://example.test/pets" }, { "specOperation", operation } };
        auto [status, response] = routes::create_request_response (*db_, body);
        EXPECT_EQ (status, 400) << operation.dump () << " -> " << response.dump ();
    }
}

// ---------------------------------------------------------------------------
// POST /import/apply - the fourth section
// ---------------------------------------------------------------------------

TEST_F (SpecsRouteTest, ImportWritesSpecsAndResolvesABindingThroughTheTempIdMap) {
    json payload = { { "specs",
                     { { { "tempId", "s1" }, { "content", PETSTORE },
                     { "sourceUrl", "https://example.test/openapi.json" } } } },
        { "collections",
        { { { "tempId", "c1" }, { "name", "Pets" },
        { "openapi", { { "specTempId", "s1" }, { "syncedAt", 9 } } } } } },
        { "requests",
        { { { "tempId", "r1" }, { "collectionTempId", "c1" }, { "name", "list" },
        { "method", "GET" }, { "url", "https://example.test/pets" },
        { "specOperation",
        { { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } } } } } } };

    auto [status, body] = routes::import_apply_response (*db_, payload);
    ASSERT_EQ (status, 200) << body.dump ();

    const auto spec_id = body["idMap"]["s1"].get<std::string> ();
    EXPECT_TRUE (spec_id.starts_with ("spec_"));
    auto stored_spec = db_->get_spec_document (spec_id);
    ASSERT_HAS_VALUE (stored_spec);
    EXPECT_EQ (stored_spec->content, PETSTORE);
    // Computed on the import path too, never carried on the payload.
    EXPECT_EQ (stored_spec->hash, routes::spec_content_hash (PETSTORE));
    EXPECT_EQ (stored_spec->source_url.value_or (""), "https://example.test/openapi.json");

    auto stored_col = db_->get_collection (body["idMap"]["c1"].get<std::string> ());
    ASSERT_HAS_VALUE (stored_col);
    const json binding = json::parse (stored_col->openapi);
    EXPECT_EQ (binding["specId"].get<std::string> (), spec_id)
    << "the temp id must have been rewritten to the engine's real id";
    EXPECT_FALSE (binding.contains ("specTempId"));
    EXPECT_EQ (binding["syncedAt"].get<int> (), 9);
    // The version is the engine's half, taken from the document this same call
    // stored (issue #709) - the payload never carries it.
    EXPECT_EQ (binding.value ("specHash", std::string{}),
    routes::spec_content_hash (PETSTORE));

    // Operation identity rides the shared applier, so it arrives free.
    auto stored_req = db_->get_request (body["idMap"]["r1"].get<std::string> ());
    ASSERT_HAS_VALUE (stored_req);
    ASSERT_HAS_VALUE (stored_req->spec_operation);
    EXPECT_EQ (
    json::parse (*stored_req->spec_operation)["operationId"].get<std::string> (), "listPets");
}

TEST_F (SpecsRouteTest, ImportMayBindASpecThatIsAlreadyStored) {
    const std::string spec_id = store_spec ();
    json payload              = { { "collections",
                 { { { "tempId", "c1" }, { "name", "Pets" }, { "openapi", { { "specId", spec_id } } } } } } };

    auto [status, body] = routes::import_apply_response (*db_, payload);
    ASSERT_EQ (status, 200) << body.dump ();
    auto stored = db_->get_collection (body["idMap"]["c1"].get<std::string> ());
    ASSERT_HAS_VALUE (stored);
    const json binding = json::parse (stored->openapi);
    EXPECT_EQ (binding["specId"].get<std::string> (), spec_id);
    // Stamped from the stored document, the same as the payload-local case -
    // an incremental import binds a version too, or it binds nothing usable.
    EXPECT_EQ (binding.value ("specHash", std::string{}),
    routes::spec_content_hash (PETSTORE));
    EXPECT_GT (binding.value ("syncedAt", int64_t{ 0 }), 0);
}

/**
 * The end-to-end nobody had: import the way the app imports, then plan a run of
 * what was imported and ask whether it is measured against the contract.
 *
 * Every fixture for coverage (#629) and response validation (#628) hand-writes
 * a binding *with* a hash, so all of them passed while the only path that
 * produces bindings in the field wrote none - and the features were inert for
 * every imported collection (issue #709). This asserts the join.
 */
TEST_F (SpecsRouteTest, AnImportedCollectionIsPlannedAgainstItsContract) {
    // Neither index is in the payload: the engine derives both from the document
    // this import stores (issues #853 and #860), on this path exactly as on the
    // single-document one.
    json payload = { { "specs", { { { "tempId", "s1" }, { "content", PETSTORE_SCHEMAS } } } },
        { "collections",
        { { { "tempId", "c1" }, { "name", "Pets" }, { "openapi", { { "specTempId", "s1" } } } } } },
        { "requests",
        { { { "tempId", "r1" }, { "collectionTempId", "c1" }, { "name", "list" },
        { "method", "GET" }, { "url", "https://example.test/pets" },
        { "specOperation",
        { { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } } } } } } };

    auto [status, body] = routes::import_apply_response (*db_, payload);
    ASSERT_EQ (status, 200) << body.dump ();

    const auto resolved = resolve (body["idMap"]["c1"].get<std::string> ());
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_TRUE (resolved.spec.bound ());
    EXPECT_FALSE (resolved.spec.schema_reason.has_value ())
    << "an import-bound collection is measurable, not a binding to explain "
       "away";
    EXPECT_EQ (resolved.spec.declared_operations.size (), 1u)
    << "no declared operations means no coverage block on every run of this "
       "collection";
    EXPECT_FALSE (resolved.spec.response_schemas.empty ())
    << "no schema index means no response was ever validated";
}

TEST_F (SpecsRouteTest, ABindingWithNoVersionIsNamedRatherThanBlamedOnTheDocument) {
    // Reachable only by editing the database from outside now, and still worth
    // its own reason: "the document moved, sync it" sends the reader to
    // re-fetch a spec that never changed, and a sync of an unchanged document
    // short-circuits without touching the binding - so the wrong reason is also
    // one whose remedy cannot work.
    const std::string spec_id = store_spec ();
    vayu::db::Collection legacy;
    legacy.id         = "col_unstamped";
    legacy.name       = "Imported";
    legacy.order      = 0;
    legacy.created_at = 1;
    legacy.updated_at = 1;
    legacy.openapi    = json{ { "specId", spec_id } }.dump ();
    db_->create_collection (legacy);
    create_request ("col_unstamped");

    const auto resolved = resolve ("col_unstamped");
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_HAS_VALUE (resolved.spec.schema_reason);
    EXPECT_EQ (vayu::core::to_string (*resolved.spec.schema_reason), "never_stamped");
}

TEST_F (SpecsRouteTest, ImportRefusesAnUnresolvableBindingAndWritesNothing) {
    for (const auto& binding :
    { json{ { "specTempId", "nobody" } }, json{ { "specId", "spec_ghost" } } }) {
        json payload        = { { "collections",
               { { { "tempId", "c1" }, { "name", "Pets" }, { "openapi", binding } } } } };
        auto [status, body] = routes::import_apply_response (*db_, payload);
        EXPECT_EQ (status, 400) << binding.dump () << " -> " << body.dump ();
        EXPECT_TRUE (db_->get_collections ().empty ())
        << "a rejected payload must persist nothing";
    }
}

TEST_F (SpecsRouteTest, ImportRefusesABindingThatNamesTheSpecTwoWays) {
    json payload = { { "specs", { { { "tempId", "s1" }, { "content", PETSTORE } } } },
        { "collections",
        { { { "tempId", "c1" }, { "name", "Pets" },
        { "openapi", { { "specTempId", "s1" }, { "specId", "spec_other" } } } } } } };
    auto [status, body] = routes::import_apply_response (*db_, payload);
    EXPECT_EQ (status, 400) << body.dump ();
    EXPECT_TRUE (db_->get_spec_document (std::string ()).has_value () == false);
    EXPECT_TRUE (db_->get_collections ().empty ());
}

TEST_F (SpecsRouteTest, ImportRefusesAnEngineComputedFieldOnASpecItem) {
    for (const char* field : { "hash", "fetchedAt" }) {
        json item = { { "tempId", "s1" }, { "content", PETSTORE } };
        item[field] = field == std::string ("fetchedAt") ? json (1) : json ("spoofed");
        auto [status, body] =
        routes::import_apply_response (*db_, json{ { "specs", { item } } });
        EXPECT_EQ (status, 400) << field << ": " << body.dump ();
    }
}

// ---------------------------------------------------------------------------
// The run stamp - the reader that makes the binding worth storing
// ---------------------------------------------------------------------------

TEST_F (SpecsRouteTest, ABoundCollectionsRunStampsTheSpecIdAndHash) {
    const std::string spec_id = store_spec ();
    const std::string hash    = routes::spec_content_hash (PETSTORE);
    const std::string col_id  = create_collection (json{ { "name", "Pets" },
     { "openapi", { { "specId", spec_id }, { "specHash", hash } } } });
    create_request (col_id);

    vayu::core::ScenarioResolveOptions options;
    options.timeout_ms            = 1000;
    options.limits.max_steps      = 10;
    options.limits.max_data_rows  = 10;
    options.limits.max_data_bytes = 4096;
    auto resolved                 = vayu::core::resolve_scenario (*db_,
                    json{ { "source", "collection" }, { "collectionId", col_id } }, options);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_TRUE (resolved.spec.bound ());

    const json manifest = vayu::core::build_scenario_manifest (
    resolved.request, resolved.plan, resolved.spec);
    ASSERT_TRUE (manifest.contains ("openapi")) << manifest.dump ();
    EXPECT_EQ (manifest["openapi"]["specId"].get<std::string> (), spec_id);
    EXPECT_EQ (manifest["openapi"]["specHash"].get<std::string> (), hash);
}

TEST_F (SpecsRouteTest, AnUnboundCollectionsRunStampsNothingAtAll) {
    const std::string col_id = create_collection (json{ { "name", "Plain" } });
    create_request (col_id);

    vayu::core::ScenarioResolveOptions options;
    options.timeout_ms            = 1000;
    options.limits.max_steps      = 10;
    options.limits.max_data_rows  = 10;
    options.limits.max_data_bytes = 4096;
    auto resolved                 = vayu::core::resolve_scenario (*db_,
                    json{ { "source", "collection" }, { "collectionId", col_id } }, options);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_FALSE (resolved.spec.bound ());

    const json manifest = vayu::core::build_scenario_manifest (
    resolved.request, resolved.plan, resolved.spec);
    // Absent, not null and not `{}` - one answer with one spelling, which is
    // what #629's coverage block branches on.
    EXPECT_FALSE (manifest.contains ("openapi")) << manifest.dump ();
}

TEST_F (SpecsRouteTest, TheStampRecordsWhatTheRunWasPlannedAgainstNotTheLatestBinding) {
    const std::string spec_id = store_spec ();
    const std::string hash    = routes::spec_content_hash (PETSTORE);
    const std::string col_id  = create_collection (json{ { "name", "Pets" },
     { "openapi", { { "specId", spec_id }, { "specHash", hash } } } });
    create_request (col_id);

    vayu::core::ScenarioResolveOptions options;
    options.timeout_ms            = 1000;
    options.limits.max_steps      = 10;
    options.limits.max_data_rows  = 10;
    options.limits.max_data_bytes = 4096;
    auto resolved                 = vayu::core::resolve_scenario (*db_,
                    json{ { "source", "collection" }, { "collectionId", col_id } }, options);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const json manifest = vayu::core::build_scenario_manifest (
    resolved.request, resolved.plan, resolved.spec);

    // Unbind afterwards: a run is a record of what ran, so the manifest already
    // built must not change under it.
    auto [status, body] =
    routes::update_collection_response (*db_, col_id, json{ { "openapi", nullptr } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (manifest["openapi"]["specHash"].get<std::string> (), hash);
}

// ---------------------------------------------------------------------------
// The declared-operation index (issue #629) - stored, refused, and pinned
// ---------------------------------------------------------------------------

TEST_F (SpecsRouteTest, AStoredDocumentsIndexIsTheOneTheEngineReadOffIt) {
    // The write takes no index at all: `create_spec_document_response` reads the
    // document it is storing and derives one (issue #853), the way it hashes the
    // bytes rather than taking a caller's word for them.
    auto [status, body] =
    routes::create_spec_document_response (*db_, json{ { "content", PETSTORE } });
    ASSERT_EQ (status, 200) << body.dump ();

    auto [read_status, read] =
    routes::get_spec_document_response (*db_, body.value ("id", std::string{}));
    ASSERT_EQ (read_status, 200) << read.dump ();
    EXPECT_EQ (read["operations"], petstore_index ());
}

TEST_F (SpecsRouteTest, ADocumentThatCannotBeReadIsRefusedRatherThanStoredUnreadable) {
    // Storing it would leave a row every later reader - coverage, the sync, an
    // export - can do nothing with, and none of them is a place to find out.
    auto [status, body] = routes::create_spec_document_response (
    *db_, json{ { "content", "openapi: [3.1.0\npaths: {\n" } });
    EXPECT_EQ (status, 400) << body.dump ();
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("content"), std::string::npos)
    << body.dump ();
}

TEST_F (SpecsRouteTest, ADocumentWithNoIndexReadsBackNullRatherThanAnEmptyContract) {
    auto [read_status, read] =
    routes::get_spec_document_response (*db_, store_spec (NOT_A_SPEC));
    ASSERT_EQ (read_status, 200) << read.dump ();
    // Null, not `[]`: "stored before coverage existed" and "declares nothing"
    // are different answers, and only the first leaves the report's block out.
    EXPECT_TRUE (read["operations"].is_null ()) << read.dump ();
}

TEST_F (SpecsRouteTest, ACallerSuppliedIndexIsRefusedOnEveryPathThatStoresOne) {
    // Both are the engine's to compute (issues #853 and #860). Refused rather
    // than ignored, for the reason a supplied `hash` is: silently dropping one
    // would leave a caller believing the document declares what it said it
    // declares.
    const json index = json::array ({ { { "method", "GET" }, { "path", "/pets" } } });

    for (const char* field : { "operations", "responseSchemas" }) {
        json body   = { { "content", PETSTORE } };
        body[field] = index;
        auto [status, response] = routes::create_spec_document_response (*db_, body);
        EXPECT_EQ (status, 400) << field << ": " << response.dump ();

        json item   = { { "tempId", "s1" }, { "content", PETSTORE } };
        item[field] = index;
        auto [import_status, import_body] =
        routes::import_apply_response (*db_, json{ { "specs", { item } } });
        EXPECT_EQ (import_status, 400) << field << ": " << import_body.dump ();
        // Nothing persisted by the refused bulk write, the transaction's own rule.
        EXPECT_TRUE (db_->get_collections ().empty ());
    }
}

TEST_F (SpecsRouteTest, TheSchemaIndexIsDerivedBesideTheOperationIndexOnBothWritePaths) {
    // The other half of what `bind_spec` waits on (issue #860): a document
    // stored by an agent that sends nothing but bytes still validates responses,
    // because the engine translated its schemas out of OpenAPI's dialect itself.
    auto [status, body] = routes::create_spec_document_response (
    *db_, json{ { "content", PETSTORE_SCHEMAS } });
    ASSERT_EQ (status, 200) << body.dump ();
    auto [read_status, read] =
    routes::get_spec_document_response (*db_, body.value ("id", std::string{}));
    ASSERT_EQ (read_status, 200) << read.dump ();
    EXPECT_EQ (read["responseSchemas"], petstore_schema_index ());

    auto [import_status, imported] = routes::import_apply_response (*db_,
    json{ { "specs", { { { "tempId", "s1" }, { "content", PETSTORE_SCHEMAS } } } } });
    ASSERT_EQ (import_status, 200) << imported.dump ();
    auto [bulk_status, bulk] = routes::get_spec_document_response (
    *db_, imported["idMap"]["s1"].get<std::string> ());
    ASSERT_EQ (bulk_status, 200) << bulk.dump ();
    EXPECT_EQ (bulk["responseSchemas"], petstore_schema_index ())
    << "one helper for all three writers, or a document describes different "
       "contracts depending on how it arrived";
}

TEST_F (SpecsRouteTest, ADocumentWhoseOperationsDeclareNoSchemaStoresNoSchemaIndex) {
    // `PETSTORE`'s one response has no `content`, so there is nothing to check
    // against - and "no index" is the honest storage of that. An empty index
    // would report `checked: false` just the same, but a `{}` in the column
    // reads as a contract that was extracted and found empty.
    auto [read_status, read] = routes::get_spec_document_response (*db_, store_spec ());
    ASSERT_EQ (read_status, 200) << read.dump ();
    EXPECT_FALSE (read["operations"].is_null ()) << read.dump ();
    EXPECT_TRUE (read["responseSchemas"].is_null ()) << read.dump ();
}

TEST_F (SpecsRouteTest, ImportDerivesTheIndexBesideTheDocumentItDescribes) {
    // The bulk path reads the document too - one helper for all three writers,
    // so a document imported and the same document stored on its own cannot end
    // up describing different contracts.
    auto [status, body] = routes::import_apply_response (*db_,
    json{ { "specs", { { { "tempId", "s1" }, { "content", PETSTORE } } } } });
    ASSERT_EQ (status, 200) << body.dump ();

    const auto spec_id = body["idMap"]["s1"].get<std::string> ();
    auto [read_status, read] = routes::get_spec_document_response (*db_, spec_id);
    ASSERT_EQ (read_status, 200) << read.dump ();
    EXPECT_EQ (read["operations"], petstore_index ());
}

TEST_F (SpecsRouteTest, AResolvedPlanCarriesTheBoundDocumentsOperations) {
    auto [status, stored] =
    routes::create_spec_document_response (*db_, json{ { "content", PETSTORE } });
    ASSERT_EQ (status, 200) << stored.dump ();
    const std::string spec_id = stored.value ("id", std::string{});
    const std::string col_id  = create_collection (json{ { "name", "Pets" },
     { "openapi",
     { { "specId", spec_id }, { "specHash", routes::spec_content_hash (PETSTORE) } } } });
    create_request (col_id);

    auto resolved = resolve (col_id);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_EQ (resolved.spec.declared_operations.size (), 1u);
    EXPECT_EQ (resolved.spec.declared_operations[0].operation_id, "listPets");
    EXPECT_EQ (resolved.spec.declared_operations[0].method, "GET");

    // And the tally built from it is live, which is what makes a run write a
    // coverage section at all.
    vayu::core::ScenarioExecution execution;
    execution.plan = resolved.plan;
    execution.spec = resolved.spec;
    EXPECT_TRUE (vayu::core::make_coverage_tally (execution).active ());
}

TEST_F (SpecsRouteTest, ABindingWhoseHashHasMovedIsNotMeasuredRatherThanMismeasured) {
    // The binding names the document and *a version of it*. A stored hash that
    // disagrees means the collection is pointing at bytes it was never synced
    // to, and reporting coverage against those would attribute a contract to a
    // run that was planned against a different one.
    auto [status, stored] =
    routes::create_spec_document_response (*db_, json{ { "content", PETSTORE } });
    ASSERT_EQ (status, 200) << stored.dump ();
    const std::string col_id = create_collection (json{ { "name", "Pets" },
    { "openapi",
    { { "specId", stored.value ("id", std::string{}) },
    { "specHash", "a-hash-this-document-never-had" } } } });
    create_request (col_id);

    auto resolved = resolve (col_id);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    // Still bound - the stamp records what the collection claims - but with no
    // operations, so the run reports no coverage block at all.
    EXPECT_TRUE (resolved.spec.bound ());
    EXPECT_TRUE (resolved.spec.declared_operations.empty ());

    vayu::core::ScenarioExecution execution;
    execution.plan = resolved.plan;
    execution.spec = resolved.spec;
    EXPECT_FALSE (vayu::core::make_coverage_tally (execution).active ());
}

// ---------------------------------------------------------------------------
// The ancestor walk (issue #716) - one answer for both paths
// ---------------------------------------------------------------------------

/**
 * The shape an OpenAPI import actually produces: the ROOT binds the document and
 * every request lives under a tag sub-collection that binds nothing. Returns the
 * tag sub-collection's id, the one a user right-clicks to run.
 */
std::string bind_root_with_tag_child (vayu::db::Database& db,
const std::string& spec_id,
const std::string& hash,
std::string* root_out = nullptr) {
    auto [root_status, root] = routes::create_collection_response (db,
    json{ { "name", "Pets API" },
    { "openapi", { { "specId", spec_id }, { "specHash", hash } } } });
    EXPECT_EQ (root_status, 200) << root.dump ();
    const std::string root_id = root.value ("id", std::string{});
    if (root_out != nullptr) {
        *root_out = root_id;
    }
    auto [tag_status, tag] = routes::create_collection_response (
    db, json{ { "name", "pets" }, { "parentId", root_id } });
    EXPECT_EQ (tag_status, 200) << tag.dump ();
    return tag.value ("id", std::string{});
}

TEST_F (SpecsRouteTest, ATagSubCollectionRunIsMeasuredAgainstTheRootsContract) {
    // The whole of the reported bug: the binding is on the root an import
    // created, the requests are one level down, and running that tag folder used
    // to resolve `{}` - no coverage, no schema validation, and an absent block
    // is indistinguishable from "never bound".
    auto [status, stored] = routes::create_spec_document_response (
    *db_, json{ { "content", PETSTORE_SCHEMAS } });
    ASSERT_EQ (status, 200) << stored.dump ();
    const std::string spec_id = stored.value ("id", std::string{});
    const std::string hash    = routes::spec_content_hash (PETSTORE_SCHEMAS);

    const std::string tag_id = bind_root_with_tag_child (*db_, spec_id, hash);
    create_request (tag_id,
    json{ { "specOperation",
    { { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } } } });

    auto resolved = resolve (tag_id);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_TRUE (resolved.spec.bound ())
    << "the root's binding answers for its subtree";
    EXPECT_EQ (resolved.spec.spec_id, spec_id);
    EXPECT_EQ (resolved.spec.spec_hash, hash);
    EXPECT_FALSE (resolved.spec.schema_reason.has_value ())
    << "measurable, not a binding to explain away";
    EXPECT_EQ (resolved.spec.declared_operations.size (), 1u)
    << "no declared operations means no coverage block on this run";
    EXPECT_FALSE (resolved.spec.response_schemas.empty ())
    << "no schema index means no response of this run was ever validated";

    vayu::core::ScenarioExecution execution;
    execution.plan = resolved.plan;
    execution.spec = resolved.spec;
    EXPECT_TRUE (vayu::core::make_coverage_tally (execution).active ())
    << "an inactive tally is how the coverage section goes missing";

    // And the run says whose contract it was measured against, because most of
    // those 618 operations being uncovered is scoped-run truth, not catastrophe.
    const json manifest = vayu::core::build_scenario_manifest (
    resolved.request, resolved.plan, resolved.spec);
    ASSERT_TRUE (manifest.contains ("openapi")) << manifest.dump ();
    EXPECT_EQ (manifest["openapi"]["specId"].get<std::string> (), spec_id);
    EXPECT_TRUE (manifest["openapi"].value ("inherited", false)) << manifest.dump ();
}

TEST_F (SpecsRouteTest, ACollectionCarryingItsOwnBindingDisclosesNothingToDisclose) {
    const std::string spec_id = store_spec ();
    const std::string col_id  = create_collection (json{ { "name", "Pets" },
     { "openapi",
     { { "specId", spec_id }, { "specHash", routes::spec_content_hash (PETSTORE) } } } });
    create_request (col_id);

    auto resolved = resolve (col_id);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_FALSE (resolved.spec.inherited);
    const json manifest = vayu::core::build_scenario_manifest (
    resolved.request, resolved.plan, resolved.spec);
    // Absent rather than `false`, the rule every other finding in the report
    // follows: carried only where it happened.
    EXPECT_FALSE (manifest["openapi"].contains ("inherited")) << manifest.dump ();
}

TEST_F (SpecsRouteTest, TheDesignPathAndTheScenarioPathResolveOneBinding) {
    // Both walks must answer "the nearest bound ancestor", so a fixture where
    // the nearest and the root disagree tells them apart. The nearer binding is
    // deliberately stale: picking the root instead would resolve *cleanly*, so
    // an agreeing pair of "unmeasurable" verdicts can only come from both paths
    // having chosen the same - nearer - binding.
    auto [status, stored] =
    routes::create_spec_document_response (*db_, json{ { "content", PETSTORE } });
    ASSERT_EQ (status, 200) << stored.dump ();
    const std::string root_spec = stored.value ("id", std::string{});

    constexpr const char* OTHER =
    R"({"openapi":"3.1.0","info":{"title":"Store","version":"1.0.0"},"paths":{}})";
    const std::string nearer_spec = store_spec (OTHER);

    std::string root_id;
    const std::string tag_id = bind_root_with_tag_child (
    *db_, root_spec, routes::spec_content_hash (PETSTORE), &root_id);
    auto [bind_status, bound] = routes::update_collection_response (*db_, tag_id,
    json{ { "openapi",
    { { "specId", nearer_spec }, { "specHash", "a-hash-this-document-never-had" } } } });
    ASSERT_EQ (bind_status, 200) << bound.dump ();
    // One level deeper again, so neither path is answering from the collection
    // the binding sits on.
    auto [leaf_status, leaf] = routes::create_collection_response (
    *db_, json{ { "name", "pets/{petId}" }, { "parentId", tag_id } });
    ASSERT_EQ (leaf_status, 200) << leaf.dump ();
    const std::string leaf_id = leaf.value ("id", std::string{});
    const std::string req_id  = create_request (leaf_id,
     json{ { "specOperation",
     { { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } } } });

    auto resolved = resolve (leaf_id);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (resolved.spec.spec_id, nearer_spec)
    << "nearest bound ancestor wins";
    ASSERT_HAS_VALUE (resolved.spec.schema_reason);
    EXPECT_EQ (*resolved.spec.schema_reason, vayu::core::UncheckedReason::HashMismatch);
    EXPECT_TRUE (resolved.spec.declared_operations.empty ())
    << "the root's operations would mean the scenario walk took the wrong "
       "binding";

    const auto design = routes::resolve_design_schema_index (*db_, req_id);
    EXPECT_TRUE (design.bound);
    ASSERT_HAS_VALUE (design.reason)
    << "a clean index here means the design walk took the root's binding";
    EXPECT_EQ (*design.reason, *resolved.spec.schema_reason)
    << "the two paths must resolve one binding, or a Send and a run of the "
       "same "
       "request disagree about what it is measured against";
}

TEST_F (SpecsRouteTest, ADocumentThatDeclaresNoOperationReportsNoCoverageRatherThanZero) {
    const std::string col_id = create_collection (json{ { "name", "Pets" },
    { "openapi",
    { { "specId", store_spec (NOT_A_SPEC) },
    { "specHash", routes::spec_content_hash (NOT_A_SPEC) } } } });
    create_request (col_id);

    auto resolved = resolve (col_id);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_TRUE (resolved.spec.bound ());
    EXPECT_TRUE (resolved.spec.declared_operations.empty ());
}

} // namespace
