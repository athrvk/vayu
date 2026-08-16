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

#include <gtest/gtest.h>

#include <memory>
#include <sstream>
#include <string>
#include <unordered_set>
#include <utility>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in specs.cpp; each returns {http_status, json_body}.
std::pair<int, nlohmann::json>
create_spec_document_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
get_spec_document_response (vayu::db::Database& db, const std::string& id);
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
R"("paths":{"/pets":{"get":{"operationId":"listPets"}}}})";

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
    ASSERT_TRUE (entry.has_value ()) << "the cap must be a seeded, user-visible knob";
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
    EXPECT_TRUE (unbound_body["openapi"].empty ()) << "`{}` is how unbound is spelled";

    auto [status, body] = routes::delete_spec_document_response (*db_, spec_id);
    EXPECT_EQ (status, 200) << body.dump ();
}

// ---------------------------------------------------------------------------
// The collection binding
// ---------------------------------------------------------------------------

TEST_F (SpecsRouteTest, AnUnboundCollectionSerializesAnEmptyBinding) {
    const std::string col_id = create_collection (json{ { "name", "Plain" } });
    auto stored              = db_->get_collection (col_id);
    ASSERT_TRUE (stored.has_value ());
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
    auto [status, body] = routes::create_collection_response (*db_,
    json{ { "name", "Pets" }, { "openapi", { { "syncedAt", 5 } } } });
    EXPECT_EQ (status, 400) << body.dump ();

    for (const auto& bad :
    { json{ { "specId", spec_id }, { "specHash", 7 } },
    json{ { "specId", spec_id }, { "syncedAt", "yesterday" } } }) {
        auto [bad_status, bad_body] = routes::create_collection_response (*db_,
        json{ { "name", "Pets" }, { "openapi", bad } });
        EXPECT_EQ (bad_status, 400) << bad_body.dump ();
    }
}

TEST_F (SpecsRouteTest, RejectsABindingToASpecThatDoesNotExist) {
    auto [created, created_body] = routes::create_collection_response (*db_,
    json{ { "name", "Pets" }, { "openapi", { { "specId", "spec_ghost" } } } });
    ASSERT_EQ (created, 400) << created_body.dump ();
    EXPECT_NE (created_body["error"]["message"].get<std::string> ().find ("spec_ghost"),
    std::string::npos);

    // And on update, which is the path a bind-from-here flow actually uses.
    const std::string col_id = create_collection (json{ { "name", "Pets" } });
    auto [updated, updated_body] = routes::update_collection_response (*db_, col_id,
    json{ { "openapi", { { "specId", "spec_ghost" } } } });
    EXPECT_EQ (updated, 400) << updated_body.dump ();
}

TEST_F (SpecsRouteTest, AnUpdateThatSaysNothingAboutTheBindingKeepsIt) {
    const std::string spec_id = store_spec ();
    const std::string col_id  = create_collection (
    json{ { "name", "Pets" }, { "openapi", { { "specId", spec_id }, { "syncedAt", 42 } } } });

    auto [status, body] =
    routes::update_collection_response (*db_, col_id, json{ { "name", "Pets v2" } });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (body["openapi"]["specId"].get<std::string> (), spec_id);
    EXPECT_EQ (body["openapi"]["syncedAt"].get<int> (), 42);
}

// ---------------------------------------------------------------------------
// Per-request operation identity - through both serializers
// ---------------------------------------------------------------------------

TEST_F (SpecsRouteTest, OperationIdentityReadsBackIdenticallyThroughBothSerializers) {
    const std::string col_id = create_collection (json{ { "name", "Pets" } });
    const json operation     = { { "operationId", "listPets" }, { "method", "GET" },
        { "path", "/pets/{petId}" } };
    const std::string req_id = create_request (col_id, json{ { "specOperation", operation } });

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

    auto [reset, reset_body] =
    routes::update_request_response (*db_, req_id, json{ { "specOperation", nullptr } });
    ASSERT_EQ (reset, 200) << reset_body.dump ();
    EXPECT_TRUE (reset_body["specOperation"].is_null ());
    EXPECT_FALSE (db_->get_request (req_id)->spec_operation.has_value ())
    << "the column must be NULL, not the string \"{}\"";
}

TEST_F (SpecsRouteTest, RejectsAnOperationIdentityThatIsNotOne) {
    const std::string col_id = create_collection (json{ { "name", "Pets" } });
    const json bad[] = {
        json ("GET /pets"),                                     // not an object
        json{ { "operationId", "listPets" } },                  // no method/path
        json{ { "method", "GET" } },                            // no path
        json{ { "path", "/pets" } },                            // no method
        json{ { "method", "" }, { "path", "/pets" } },          // empty method
        json{ { "method", "GET" }, { "path", "pets" } },        // not a template path
        json{ { "method", "GET" }, { "path", "https://x/p" } }, // a concrete URL
        json{ { "method", "GET" }, { "path", "/pets" }, { "operationId", 7 } },
    };
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
    json payload = { { "specs", { { { "tempId", "s1" }, { "content", PETSTORE },
                                   { "sourceUrl", "https://example.test/openapi.json" } } } },
        { "collections", { { { "tempId", "c1" }, { "name", "Pets" },
                             { "openapi", { { "specTempId", "s1" }, { "syncedAt", 9 } } } } } },
        { "requests",
            { { { "tempId", "r1" }, { "collectionTempId", "c1" }, { "name", "list" },
                { "method", "GET" }, { "url", "https://example.test/pets" },
                { "specOperation", { { "operationId", "listPets" },
                                       { "method", "GET" }, { "path", "/pets" } } } } } } };

    auto [status, body] = routes::import_apply_response (*db_, payload);
    ASSERT_EQ (status, 200) << body.dump ();

    const auto spec_id = body["idMap"]["s1"].get<std::string> ();
    EXPECT_TRUE (spec_id.starts_with ("spec_"));
    auto stored_spec = db_->get_spec_document (spec_id);
    ASSERT_TRUE (stored_spec.has_value ());
    EXPECT_EQ (stored_spec->content, PETSTORE);
    // Computed on the import path too, never carried on the payload.
    EXPECT_EQ (stored_spec->hash, routes::spec_content_hash (PETSTORE));
    EXPECT_EQ (stored_spec->source_url.value_or (""), "https://example.test/openapi.json");

    auto stored_col = db_->get_collection (body["idMap"]["c1"].get<std::string> ());
    ASSERT_TRUE (stored_col.has_value ());
    const json binding = json::parse (stored_col->openapi);
    EXPECT_EQ (binding["specId"].get<std::string> (), spec_id)
    << "the temp id must have been rewritten to the engine's real id";
    EXPECT_FALSE (binding.contains ("specTempId"));
    EXPECT_EQ (binding["syncedAt"].get<int> (), 9);

    // Operation identity rides the shared applier, so it arrives free.
    auto stored_req = db_->get_request (body["idMap"]["r1"].get<std::string> ());
    ASSERT_TRUE (stored_req.has_value ());
    ASSERT_TRUE (stored_req->spec_operation.has_value ());
    EXPECT_EQ (json::parse (*stored_req->spec_operation)["operationId"].get<std::string> (),
    "listPets");
}

TEST_F (SpecsRouteTest, ImportMayBindASpecThatIsAlreadyStored) {
    const std::string spec_id = store_spec ();
    json payload = { { "collections", { { { "tempId", "c1" }, { "name", "Pets" },
                                          { "openapi", { { "specId", spec_id } } } } } } };

    auto [status, body] = routes::import_apply_response (*db_, payload);
    ASSERT_EQ (status, 200) << body.dump ();
    auto stored = db_->get_collection (body["idMap"]["c1"].get<std::string> ());
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (json::parse (stored->openapi)["specId"].get<std::string> (), spec_id);
}

TEST_F (SpecsRouteTest, ImportRefusesAnUnresolvableBindingAndWritesNothing) {
    for (const auto& binding : { json{ { "specTempId", "nobody" } },
         json{ { "specId", "spec_ghost" } } }) {
        json payload = { { "collections",
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
        auto [status, body] = routes::import_apply_response (*db_, json{ { "specs", { item } } });
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
    auto resolved = vayu::core::resolve_scenario (*db_,
    json{ { "source", "collection" }, { "collectionId", col_id } }, options);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    ASSERT_TRUE (resolved.spec.bound ());

    const json manifest = vayu::core::build_scenario_manifest (resolved.request,
    resolved.plan, resolved.spec);
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
    auto resolved = vayu::core::resolve_scenario (*db_,
    json{ { "source", "collection" }, { "collectionId", col_id } }, options);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_FALSE (resolved.spec.bound ());

    const json manifest = vayu::core::build_scenario_manifest (resolved.request,
    resolved.plan, resolved.spec);
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
    auto resolved = vayu::core::resolve_scenario (*db_,
    json{ { "source", "collection" }, { "collectionId", col_id } }, options);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    const json manifest = vayu::core::build_scenario_manifest (resolved.request,
    resolved.plan, resolved.spec);

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

TEST_F (SpecsRouteTest, AStoredIndexComesBackAsTheArrayItWasWritten) {
    const json index = json::array ({ { { "operationId", "listPets" }, { "method", "GET" },
    { "path", "/pets" }, { "responses", json::array ({ "200", "default" }) } } });
    auto [status, body] = routes::create_spec_document_response (*db_,
    json{ { "content", PETSTORE }, { "operations", index } });
    ASSERT_EQ (status, 200) << body.dump ();

    auto [read_status, read] =
    routes::get_spec_document_response (*db_, body.value ("id", std::string{}));
    ASSERT_EQ (read_status, 200) << read.dump ();
    EXPECT_EQ (read["operations"], index);
}

TEST_F (SpecsRouteTest, ADocumentWithNoIndexReadsBackNullRatherThanAnEmptyContract) {
    auto [read_status, read] = routes::get_spec_document_response (*db_, store_spec ());
    ASSERT_EQ (read_status, 200) << read.dump ();
    // Null, not `[]`: "stored before coverage existed" and "declares nothing"
    // are different answers, and only the first leaves the report's block out.
    EXPECT_TRUE (read["operations"].is_null ()) << read.dump ();
}

TEST_F (SpecsRouteTest, AMalformedIndexIsRefusedAtTheWriteOnEveryPathThatStoresOne) {
    const json bad = json::array ({ { { "method", "GET" } } }); // no `path`

    auto [status, body] = routes::create_spec_document_response (*db_,
    json{ { "content", PETSTORE }, { "operations", bad } });
    EXPECT_EQ (status, 400) << body.dump ();

    auto [import_status, import_body] = routes::import_apply_response (*db_,
    json{ { "specs", { { { "tempId", "s1" }, { "content", PETSTORE },
                          { "operations", bad } } } } });
    EXPECT_EQ (import_status, 400) << import_body.dump ();
    // Nothing persisted by the refused bulk write, the transaction's own rule.
    EXPECT_TRUE (db_->get_collections ().empty ());
}

TEST_F (SpecsRouteTest, ImportStoresTheIndexBesideTheDocumentItDescribes) {
    const json index = json::array ({ { { "method", "GET" }, { "path", "/pets" },
    { "responses", json::array ({ "200" }) } } });
    auto [status, body] = routes::import_apply_response (*db_,
    json{ { "specs", { { { "tempId", "s1" }, { "content", PETSTORE },
                          { "operations", index } } } } });
    ASSERT_EQ (status, 200) << body.dump ();

    const auto spec_id = body["idMap"]["s1"].get<std::string> ();
    auto [read_status, read] = routes::get_spec_document_response (*db_, spec_id);
    ASSERT_EQ (read_status, 200) << read.dump ();
    EXPECT_EQ (read["operations"], index);
}

TEST_F (SpecsRouteTest, AResolvedPlanCarriesTheBoundDocumentsOperations) {
    const json index = json::array ({ { { "operationId", "listPets" }, { "method", "GET" },
    { "path", "/pets" }, { "responses", json::array ({ "200" }) } } });
    auto [status, stored] = routes::create_spec_document_response (*db_,
    json{ { "content", PETSTORE }, { "operations", index } });
    ASSERT_EQ (status, 200) << stored.dump ();
    const std::string spec_id = stored.value ("id", std::string{});
    const std::string col_id  = create_collection (json{ { "name", "Pets" },
    { "openapi", { { "specId", spec_id },
    { "specHash", routes::spec_content_hash (PETSTORE) } } } });
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
    const json index = json::array ({ { { "operationId", "listPets" }, { "method", "GET" },
    { "path", "/pets" }, { "responses", json::array ({ "200" }) } } });
    auto [status, stored] = routes::create_spec_document_response (*db_,
    json{ { "content", PETSTORE }, { "operations", index } });
    ASSERT_EQ (status, 200) << stored.dump ();
    const std::string col_id = create_collection (json{ { "name", "Pets" },
    { "openapi", { { "specId", stored.value ("id", std::string{}) },
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

TEST_F (SpecsRouteTest, ADocumentStoredWithoutAnIndexReportsNoCoverageRatherThanZero) {
    const std::string col_id = create_collection (json{ { "name", "Pets" },
    { "openapi", { { "specId", store_spec () },
    { "specHash", routes::spec_content_hash (PETSTORE) } } } });
    create_request (col_id);

    auto resolved = resolve (col_id);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_TRUE (resolved.spec.bound ());
    EXPECT_TRUE (resolved.spec.declared_operations.empty ());
}

} // namespace
