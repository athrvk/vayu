/**
 * @file tests/spec_export_route_test.cpp
 * @brief Tests for POST /specs/export - a collection back out as an OpenAPI
 *        document (issue #855, phase B's third move).
 *
 * The assembly itself is pinned in openapi_export_test.cpp. What is pinned here
 * is what only the route can get wrong:
 *
 *  - **The subtree is the request set.** An OpenAPI import binds the root and
 *    files every request under a tag sub-collection, so a route that exported
 *    only the named collection's own requests would remove every operation of
 *    exactly the collections this feature exists for.
 *  - **Where the subtree stops** (issue #721): at a collection bound to a
 *    *different* document, and not at one bound to the same.
 *  - **Which document is patched**, and that a binding the store cannot answer
 *    is a refusal rather than a skeleton nobody asked for.
 *  - **Nothing is written** - an export is a read of what the collection
 *    already is.
 *
 * Follows the suite's route-test convention: the route's extracted core is
 * exercised directly, no in-process HTTP server.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in spec_export.cpp / specs.cpp / collections.cpp / requests.cpp /
// examples.cpp; each returns {http_status, json_body} - the pair the handler
// writes out.
std::pair<int, nlohmann::json>
export_spec_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_spec_document_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_collection_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> create_request_example_response (vayu::db::Database& db,
const std::string& request_id,
const nlohmann::json& json);
std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
// Defined in import.cpp - the combined parse-and-apply `POST /import`, used
// here for the round trip a mock mode's `x-vayu-mock` export exists for.
std::pair<int, nlohmann::json>
import_response (vayu::db::Database& db, const nlohmann::json& body);
} // namespace vayu::http::routes

namespace {

namespace routes = vayu::http::routes;

constexpr const char* PETS_DOC =
R"({"openapi":"3.1.0","info":{"title":"Pets","version":"1.0.0"},)"
R"("x-vendor-note":"kept verbatim",)"
R"("paths":{"/pets":{"get":{"operationId":"listPets","responses":{"200":{"description":"ok"}}},)"
R"("post":{"operationId":"createPet","responses":{"201":{"description":"made"}}}}}})";

constexpr const char* OWNERS_DOC =
R"({"openapi":"3.1.0","info":{"title":"Owners","version":"1.0.0"},)"
R"("paths":{"/owners":{"get":{"operationId":"listOwners","responses":{"200":{"description":"ok"}}}}}})";


/// A stored JSON column as a value to compare, `null` when it does not parse.
json column (const std::string& blob) {
    return json::parse (blob, nullptr, /*allow_exceptions=*/false);
}

/**
 * Everything the UI shows for @p root_id's subtree, as one value two
 * collections can be compared by: every collection's editor fields, every
 * request's tabs, every saved example - folders and requests in the order the
 * sidebar lists them. Ids and timestamps are left out; they are the store's.
 */
json snapshot (vayu::db::Database& db, const std::string& root_id, bool is_root = true) {
    const auto collection = db.get_collection (root_id);
    if (!collection) {
        ADD_FAILURE () << "no collection " << root_id;
        return json ();
    }
    json out{ { "description", collection->description },
        { "variables", column (collection->variables) },
        { "auth", column (collection->auth) },
        { "elements", column (collection->elements) },
        { "dataSchema", column (collection->data_schema) } };
    if (!is_root) {
        out["name"] = collection->name;
    }
    auto rows = db.get_requests_in_collection (root_id);
    std::stable_sort (rows.begin (), rows.end (),
    [] (const auto& a, const auto& b) { return a.order < b.order; });
    json requests = json::array ();
    for (const auto& row : rows) {
        json examples     = json::array ();
        int fixed         = -1;
        const auto stored = db.get_request_examples (row.id);
        for (size_t at = 0; at < stored.size (); ++at) {
            const auto& example = stored[at];
            examples.push_back (
            json{ { "name", example.name }, { "status", example.status },
            { "body", example.body }, { "contentType", example.content_type },
            { "headers", column (example.headers) },
            { "truncated", example.body_truncated } });
            if (row.mock_example_id && *row.mock_example_id == example.id) {
                fixed = static_cast<int> (at);
            }
        }
        requests.push_back (json{ { "name", row.name },
        { "description", row.description }, { "method", vayu::to_string (row.method) },
        { "url", row.url }, { "params", column (row.params) },
        { "headers", column (row.headers) }, { "body", column (row.body) },
        { "auth", column (row.auth) }, { "elements", column (row.elements) },
        { "followRedirects", row.follow_redirects }, { "maxRedirects", row.max_redirects },
        { "httpVersion", row.http_version }, { "verifySSL", row.verify_ssl },
        { "stream", row.stream }, { "mockResponseMode", row.mock_response_mode },
        { "mockExample", fixed }, { "examples", std::move (examples) } });
    }
    out["requests"] = std::move (requests);
    std::vector<vayu::db::Collection> children;
    for (const auto& candidate : db.get_collections ()) {
        if (candidate.parent_id && *candidate.parent_id == root_id) {
            children.push_back (candidate);
        }
    }
    std::stable_sort (children.begin (), children.end (),
    [] (const auto& a, const auto& b) { return a.order < b.order; });
    json folders = json::array ();
    for (const auto& child : children) {
        folders.push_back (snapshot (db, child.id, /*is_root=*/false));
    }
    out["folders"] = std::move (folders);
    return out;
}

class SpecExportRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_spec_export_route.db";

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

    std::string create_request (const std::string& collection_id,
    const std::string& method,
    const std::string& url,
    const json& identity = json (nullptr)) {
        json body{ { "collectionId", collection_id }, { "name", url },
            { "method", method }, { "url", url } };
        if (!identity.is_null ()) {
            body["specOperation"] = identity;
        }
        auto [status, response] = routes::create_request_response (*db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response.value ("id", std::string{});
    }

    void add_example (const std::string& request_id, const json& body) {
        auto [status, response] =
        routes::create_request_example_response (*db_, request_id, body);
        EXPECT_EQ (status, 200) << response.dump ();
    }

    json export_ok (const json& body) {
        auto [status, response] = routes::export_spec_response (*db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return response;
    }

    /// @p text imported through `POST /import`, answering the new root's id.
    std::string import_text (const std::string& text) {
        auto [status, imported] =
        routes::import_response (*db_, json{ { "content", text } });
        EXPECT_EQ (status, 200) << imported.dump ();
        return imported["idMap"].value ("c1", std::string{});
    }

    json export_collection (const std::string& collection_id = {}) {
        return export_ok (
        json{ { "collectionId", collection_id.empty () ? root_ : collection_id } });
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::string root_;
};

TEST_F (SpecExportRouteTest, ExportsRequestsAnywhereBeneathTheNamedCollection) {
    // The shape an OpenAPI import leaves: the root owns no request at all, and
    // every one of them lives in a tag sub-collection under it. A route that
    // read only the root's own requests would report both operations removed.
    const std::string spec = store_spec (PETS_DOC);
    bind (root_, spec);
    const std::string tag =
    create_collection (json{ { "name", "pets" }, { "parentId", root_ } });
    create_request (tag, "GET", "{{baseUrl}}/pets",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } });
    create_request (tag, "POST", "{{baseUrl}}/pets",
    json{ { "operationId", "createPet" }, { "method", "POST" }, { "path", "/pets" } });

    const json body     = export_collection ();
    const json document = json::parse (body["text"].get<std::string> ());
    EXPECT_EQ (body["notes"]["direction"], "document");
    EXPECT_EQ (body["notes"]["requestsExported"], 2);
    EXPECT_EQ (body["notes"]["operationsRemoved"], 0);
    EXPECT_EQ (document["x-vendor-note"], "kept verbatim");
    EXPECT_EQ (body["fileName"], "pets-api.openapi.json");
}

TEST_F (SpecExportRouteTest, StopsAtACollectionBoundToADifferentDocument) {
    // Collections re-parent freely, so a collection bound to another spec can
    // sit under this one. Its requests carry that spec's stamps, and
    // `operationId`s are names generators hand out in every document - without
    // the boundary they would claim this document's operations and rewrite them.
    const std::string pets   = store_spec (PETS_DOC);
    const std::string owners = store_spec (OWNERS_DOC);
    bind (root_, pets);
    create_request (root_, "GET", "{{baseUrl}}/pets",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } });
    create_request (root_, "POST", "{{baseUrl}}/pets",
    json{ { "operationId", "createPet" }, { "method", "POST" }, { "path", "/pets" } });

    const std::string other =
    create_collection (json{ { "name", "Owners" }, { "parentId", root_ } });
    bind (other, owners);
    const std::string buried =
    create_collection (json{ { "name", "buried" }, { "parentId", other } });
    create_request (buried, "GET", "{{baseUrl}}/owners",
    json{ { "operationId", "listOwners" }, { "method", "GET" }, { "path", "/owners" } });

    const json body = export_collection ();
    // The other document's request is not here at all - not as an unclaimed
    // request, not as an operation, and its descendants came with it.
    EXPECT_EQ (body["notes"]["requestsExported"], 2);
    EXPECT_EQ (body["notes"]["requestsWithoutOperation"], 0);
    EXPECT_EQ (body["notes"]["operationsNotInDocument"], 0);
}

TEST_F (SpecExportRouteTest, DescendsIntoACollectionBoundToTheSameDocument) {
    // *Another* document, not *a* document: a descendant bound to the same spec
    // describes the very operations being patched, and excluding it would have
    // the export remove them as operations nothing here claims.
    const std::string spec = store_spec (PETS_DOC);
    bind (root_, spec);
    const std::string child =
    create_collection (json{ { "name", "same" }, { "parentId", root_ } });
    bind (child, spec);
    create_request (child, "GET", "{{baseUrl}}/pets",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } });
    create_request (child, "POST", "{{baseUrl}}/pets",
    json{ { "operationId", "createPet" }, { "method", "POST" }, { "path", "/pets" } });

    EXPECT_EQ (export_collection ()["notes"]["operationsRemoved"], 0);
}

TEST_F (SpecExportRouteTest, WritesAStoredExampleIntoTheBoundDocument) {
    const std::string spec = store_spec (PETS_DOC);
    bind (root_, spec);
    const std::string listed = create_request (root_, "GET", "{{baseUrl}}/pets",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } });
    create_request (root_, "POST", "{{baseUrl}}/pets",
    json{ { "operationId", "createPet" }, { "method", "POST" }, { "path", "/pets" } });
    add_example (listed,
    json{ { "name", "200 - ok" }, { "status", 200 }, { "origin", "user" },
    { "body", R"({"id":"p1"})" }, { "contentType", "application/json" } });

    const json document = json::parse (export_collection ()["text"].get<std::string> ());
    EXPECT_EQ (document["paths"]["/pets"]["get"]["responses"]["200"]["content"]["application/json"]["example"],
    json::parse (R"({"id":"p1"})"));
}

TEST_F (SpecExportRouteTest, LeavesAnImportedExampleTheDocumentDeclaresNoneForAlone) {
    const std::string spec = store_spec (PETS_DOC);
    bind (root_, spec);
    const std::string listed = create_request (root_, "GET", "{{baseUrl}}/pets",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } });
    // `origin` defaults to `import`, which is the row a spec sync may replace -
    // and the document's 200 declares no example, so this body was sampled off
    // a schema rather than read out of the contract.
    add_example (listed,
    json{ { "name", "200 - ok" }, { "status", 200 },
    { "body", R"({"id":"p1"})" }, { "contentType", "application/json" } });

    const json body     = export_collection ();
    const json document = json::parse (body["text"].get<std::string> ());
    EXPECT_FALSE (document["paths"]["/pets"]["get"]["responses"]["200"].contains ("content"));
    EXPECT_EQ (body["notes"]["examplesSampledAtImport"], 1);
    EXPECT_EQ (body["notes"]["examplesWritten"], 0);
}

TEST_F (SpecExportRouteTest, ExportsAFreeFormCollectionAsASkeleton) {
    create_request (root_, "GET", "{{baseUrl}}/pets");

    const json body     = export_collection ();
    const json document = json::parse (body["text"].get<std::string> ());
    EXPECT_EQ (body["notes"]["direction"], "skeleton");
    EXPECT_EQ (document["openapi"], "3.1.0");
    EXPECT_EQ (document["info"]["title"], "Pets API");
    EXPECT_TRUE (document["paths"].contains ("/pets"));
}

/**
 * The route-level round trip issue #1649 exists for: a request's `"fixed"`
 * mock target, exported as OpenAPI and imported into a fresh collection,
 * comes back naming *that collection's own copy* of the same example rather
 * than reverting to `"first"`.
 *
 * Three stored examples, not two: the importer's `examples_v3` keeps only the
 * *first* named example of each status (`declared_example_value`), so the
 * fixed target - the second example this request ever gained - is put under
 * its own status (201) rather than sharing the first one's (200), and a third
 * example beside it there forces that status into a named `examples` map
 * (`add_named_examples`) instead of the bare, unaddressable `example` a lone
 * one would get. That makes the target both the first of its own status
 * (so it survives import) and a named map entry (so `x-vayu-mock` has a key
 * to give it) - the two properties this round trip needs at once.
 */
TEST_F (SpecExportRouteTest, RoundTripsAFixedMockModeThroughXVayuMock) {
    const std::string listed = create_request (root_, "GET", "{{baseUrl}}/pets");
    add_example (listed,
    json{ { "name", "ok" }, { "status", 200 }, { "origin", "user" },
    { "body", R"({"id":"p0"})" }, { "contentType", "application/json" } });
    add_example (listed,
    json{ { "name", "created" }, { "status", 201 }, { "origin", "user" },
    { "body", R"({"id":"p1"})" }, { "contentType", "application/json" } });
    add_example (listed,
    json{ { "name", "created also" }, { "status", 201 }, { "origin", "user" },
    { "body", R"({"id":"p2"})" }, { "contentType", "application/json" } });
    const auto stored_examples = db_->get_request_examples (listed);
    ASSERT_EQ (stored_examples.size (), 3);
    const std::string target_example_id = stored_examples[1].id; // "created"

    auto [update_status, update_body] = routes::update_request_response (*db_, listed,
    json{ { "mockResponseMode", "fixed" }, { "mockExampleId", target_example_id } });
    ASSERT_EQ (update_status, 200) << update_body.dump ();

    const std::string text = export_collection ()["text"].get<std::string> ();

    auto [import_status, imported] =
    routes::import_response (*db_, json{ { "content", text } });
    ASSERT_EQ (import_status, 200) << imported.dump ();

    // The import created new collections alongside `root_` - a root plus, since
    // this operation carries no tags, a `pets` sub-collection its path names
    // (`folder_of`) - so the new request is gathered across all of them rather
    // than assumed to sit directly under the new root.
    std::vector<vayu::db::Request> new_requests;
    for (const auto& c : db_->get_collections ()) {
        if (c.id == root_) {
            continue;
        }
        for (auto& request : db_->get_requests_in_collection (c.id)) {
            new_requests.push_back (std::move (request));
        }
    }
    ASSERT_EQ (new_requests.size (), 1);
    const vayu::db::Request& new_request = new_requests.front ();
    EXPECT_EQ (new_request.mock_response_mode, "fixed");
    ASSERT_HAS_VALUE (new_request.mock_example_id);

    const auto new_examples = db_->get_request_examples (new_request.id);
    const auto target       = std::find_if (new_examples.begin (),
          new_examples.end (), [&] (const vayu::db::RequestExample& example) {
        return example.id == *new_request.mock_example_id;
    });
    ASSERT_NE (target, new_examples.end ());
    // The body a "fixed" mock would actually serve - the proof that this
    // resolved to "created" (`p1`) and not "created also" (`p2`) or the
    // unrelated 200 example (`p0`).
    EXPECT_EQ (json::parse (target->body), json::parse (R"({"id":"p1"})"));
    EXPECT_EQ (target->status, 201);
}

TEST_F (SpecExportRouteTest, ResolvesAnInheritingRequestsAuthThroughItsFolder) {
    // `inherit` means the nearest level with a credential, the rule
    // `POST /compose` applies. A folder with its own API key sits between this
    // request and the root's bearer token, so the operation must say API key -
    // it used to say nothing and so read as the root's bearer.
    auto [status, response] = routes::update_collection_response (*db_, root_,
    json{ { "auth", json{ { "mode", "bearer" }, { "token", "t" } } } });
    ASSERT_EQ (status, 200) << response.dump ();
    const std::string folder =
    create_collection (json{ { "name", "Users" }, { "parentId", root_ },
    { "auth",
    json{ { "mode", "apikey" }, { "key", "X-Api-Key" }, { "value", "k" }, { "in", "header" } } } });
    create_request (folder, "GET", "{{baseUrl}}/users");
    const std::string plain =
    create_collection (json{ { "name", "Plain" }, { "parentId", root_ } });
    create_request (plain, "GET", "{{baseUrl}}/plain");

    // Not const: a missing member reads as `null` and fails the expectation,
    // where const `operator[]` would abort the whole suite.
    json document = json::parse (export_collection ()["text"].get<std::string> ());
    EXPECT_EQ (document["security"],
    json::array ({ json{ { "bearerAuth", json::array () } } }));
    EXPECT_EQ (document["paths"]["/users"]["get"]["security"],
    json::array ({ json{ { "apiKeyAuth", json::array () } } }));
    EXPECT_EQ (document["components"]["securitySchemes"]["apiKeyAuth"]["name"], "X-Api-Key");
    // A folder with no auth of its own steps over to the root's, which the
    // document already states - no override.
    EXPECT_FALSE (document["paths"]["/plain"]["get"].contains ("security"));
}


// ============================================================================
// Round trips - export, import the file, and compare what the UI would show
// ============================================================================

/// Swagger 2.0, the dialect the contract mode writes nothing into.
constexpr const char* SWAGGER_DOC =
R"({"swagger":"2.0","info":{"title":"Shop","version":"1"},"host":"shop.example.com",)"
R"("basePath":"/v1","schemes":["https"],"tags":[{"name":"items"}],)"
R"("securityDefinitions":{"key":{"type":"apiKey","name":"X-Key","in":"header"}},)"
R"("paths":{"/items":{"get":{"operationId":"listItems","tags":["items"],)"
R"("parameters":[{"name":"limit","in":"query","type":"integer"}],)"
R"("responses":{"200":{"description":"ok"}}}}}})";

TEST_F (SpecExportRouteTest, RoundTripsEveryFieldOfAFreeFormCollection) {
    // Every editor field the UI has, at every level: what an exported file
    // carries is the collection, not only the part OpenAPI has words for.
    auto [root_status, root_body] = routes::update_collection_response (
    *db_, root_, json::parse (R"json({"description":"Root **notes**",
        "variables":{"baseUrl":{"value":"https://api.example.com","enabled":true},
                     "tenant":{"value":"acme","enabled":false,"type":"string"}},
        "auth":{"mode":"bearer","token":"{{token}}"},
        "dataSchema":{"columns":["user","pass"],"fileName":"users.csv"},
        "elements":[{"id":"el_1","kind":"script.pre","enabled":true,"config":{"script":"console.log(1)"}}]})json"));
    ASSERT_EQ (root_status, 200) << root_body.dump ();
    const std::string users = create_collection (json::parse (R"json({"name":"Users",
        "description":"People","variables":{"page":{"value":"2","enabled":true}},
        "auth":{"mode":"apikey","key":"X-Api-Key","value":"{{key}}","in":"header"},
        "elements":[{"id":"el_2","kind":"script.post","enabled":true,"config":{"script":"pm.test('t', () => {})"}}]})json"));
    ASSERT_EQ (routes::update_collection_response (*db_, users, json{ { "parentId", root_ } })
               .first,
    200);
    const std::string admin = create_collection (json{ { "name", "Admin" },
    { "parentId", users }, { "auth", json{ { "mode", "noauth" } } } });
    create_collection (json{ { "name", "Empty" }, { "parentId", root_ } });

    auto [get_status, get_body] = routes::create_request_response (*db_, json::parse (R"json({
        "collectionId":")json" + users + R"json(","name":"Get user","description":"One user",
        "method":"GET","url":"{{baseUrl}}/users/{{id}}?expand=all",
        "params":[{"key":"expand","value":"all","enabled":true,"description":"What"},
                  {"key":"Expand","value":"none","enabled":false}],
        "headers":[{"key":"Accept","value":"application/json","enabled":true},
                   {"key":"Authorization","value":"Token {{t}}","enabled":false}],
        "auth":{"mode":"inherit"},
        "elements":[{"id":"el_3","kind":"assert.status","enabled":true,"config":{"in":[200]}}],
        "followRedirects":false,"maxRedirects":3,"httpVersion":"http2","verifySSL":false,"stream":true})json"));
    ASSERT_EQ (get_status, 200) << get_body.dump ();
    const std::string get_id = get_body.value ("id", std::string{});
    add_example (get_id, json::parse (R"({"name":"Found","status":200,"body":"{\"id\":1}",
        "contentType":"application/json","origin":"user",
        "headers":[{"key":"Content-Type","value":"application/json","enabled":true},
                   {"key":"X-Rate","value":"9","enabled":true}]})"));
    add_example (get_id, json::parse (R"({"name":"Gone","status":404,"body":"<no/>",
        "contentType":"application/xml","origin":"user","headers":[]})"));
    ASSERT_EQ (routes::update_request_response (*db_, get_id,
               json{ { "mockResponseMode", "fixed" },
               { "mockExampleId", db_->get_request_examples (get_id)[1].id } })
               .first,
    200);

    for (const json& request :
    { json::parse (R"json({"name":"Upload","method":"POST","url":"{{baseUrl}}/files",
            "body":{"mode":"form-data","fields":[{"key":"title","value":"hi","enabled":true,"description":"T"},
              {"key":"draft","value":"y","enabled":false},{"key":"file","value":"","enabled":true,"type":"file","fileName":"a.png"}]},
            "auth":{"mode":"digest","config":{"username":"u"}},"mockResponseMode":"random"})json"),
    json::parse (R"json({"name":"Query","method":"POST","url":"{{baseUrl}}/graphql",
            "body":{"mode":"graphql","content":"{\"query\":\"{ me { id } }\"}"},
            "auth":{"mode":"oauth2","config":{"grantType":"client_credentials","accessTokenUrl":"https://auth.example.com/t","clientId":"cid","scope":"a b"}}})json"),
    json::parse (R"json({"name":"Soap","method":"POST","url":"{{baseUrl}}/soap",
            "headers":[{"key":"Content-Type","value":"text/xml","enabled":true}],
            "body":{"mode":"xml","content":"<x/>"},"auth":{"mode":"none"}})json"),
    json::parse (R"json({"name":"Home","method":"GET","url":"{{baseUrl}}"})json"),
    json::parse (R"json({"name":"Upload again","method":"POST","url":"{{baseUrl}}/files"})json") }) {
        json body              = request;
        body["collectionId"]   = request["name"] == "Soap" ? admin : root_;
        auto [status, created] = routes::create_request_response (*db_, body);
        ASSERT_EQ (status, 200) << created.dump ();
    }

    const json before      = snapshot (*db_, root_);
    const std::string text = export_collection ()["text"].get<std::string> ();
    const std::string copy = import_text (text);
    ASSERT_FALSE (copy.empty ());
    EXPECT_EQ (snapshot (*db_, copy), before) << text;
}

TEST_F (SpecExportRouteTest, LeavesOutEverySecretAndCountsIt) {
    auto [status, body] = routes::update_collection_response (*db_, root_,
    json::parse (R"json({"auth":{"mode":"basic","username":"u","password":"hunter2"},
        "variables":{"token":{"value":"abc","enabled":true,"secret":true},
                     "ref":{"value":"{{vault}}","enabled":true,"secret":true}}})json"));
    ASSERT_EQ (status, 200) << body.dump ();
    const std::string id = create_request (root_, "GET", "{{baseUrl}}/x");
    ASSERT_EQ (routes::update_request_response (*db_, id,
               json::parse (R"({"auth":{"mode":"apikey","key":"K","value":"s3cret","in":"query"}})"))
               .first,
    200);

    const json exported    = export_collection ();
    const std::string text = exported["text"].get<std::string> ();
    EXPECT_EQ (text.find ("hunter2"), std::string::npos);
    EXPECT_EQ (text.find ("s3cret"), std::string::npos);
    EXPECT_EQ (text.find ("\"abc\""), std::string::npos);
    // A value that is one `{{variable}}` names a secret without being one.
    EXPECT_NE (text.find ("{{vault}}"), std::string::npos);
    EXPECT_EQ (exported["notes"]["secretsOmitted"], 3);
}

TEST_F (SpecExportRouteTest, KeepsTheContractByDefaultAndWritesEverythingWhenAsked) {
    const std::string copy = import_text (SWAGGER_DOC);
    std::string folder;
    for (const auto& c : db_->get_collections ()) {
        if (c.parent_id && *c.parent_id == copy) {
            folder = c.id;
        }
    }
    ASSERT_FALSE (folder.empty ());
    const auto rows = db_->get_requests_in_collection (folder);
    ASSERT_EQ (rows.size (), 1);

    // Unedited, both modes leave every standard member exactly as it was.
    const json original = json::parse (SWAGGER_DOC);
    for (const char* mode : { "contract", "full" }) {
        json document = json::parse (
        export_ok (json{ { "collectionId", copy }, { "mode", mode } })["text"].get<std::string> ());
        document.erase ("x-vayu-collection");
        for (auto& [path, item] : document["paths"].items ()) {
            for (auto& [method, operation] : item.items ()) {
                operation.erase ("x-vayu-request");
            }
        }
        EXPECT_EQ (document, original) << mode;
    }

    auto [status, body] = routes::update_request_response (*db_, rows[0].id,
    json::parse (R"json({"name":"All items","description":"Every item",
        "params":[{"key":"limit","value":"5","enabled":true},{"key":"sort","value":"asc","enabled":true}],
        "headers":[{"key":"X-Trace","value":"1","enabled":true}],
        "body":{"mode":"json","content":"{\"a\":1}"},"verifySSL":false,
        "elements":[{"id":"el_1","kind":"script.pre","enabled":true,"config":{"script":"console.log(1)"}}]})json"));
    ASSERT_EQ (status, 200) << body.dump ();
    create_request (folder, "DELETE", "{{baseUrl}}/items/{{id}}");

    const json contract = json::parse (
    export_ok (json{ { "collectionId", copy } })["text"].get<std::string> ());
    // The contract mode writes the value into the declared parameter and
    // nothing else: no new parameter, no body, no new operation, no rename.
    const json& kept = contract["paths"]["/items"]["get"];
    EXPECT_EQ (kept["parameters"].size (), 1);
    EXPECT_FALSE (kept.contains ("summary"));
    EXPECT_FALSE (contract["paths"].contains ("/items/{id}"));

    const json full_body =
    export_ok (json{ { "collectionId", copy }, { "mode", "full" } });
    EXPECT_EQ (full_body["notes"]["boundMode"], "full");
    EXPECT_EQ (full_body["notes"]["operationsAdded"], 1);
    const std::string text = full_body["text"].get<std::string> ();
    const json full        = json::parse (text);
    const json& written    = full["paths"]["/items"]["get"];
    EXPECT_EQ (written["summary"], "All items");
    EXPECT_EQ (written["description"], "Every item");
    EXPECT_EQ (written["parameters"][0]["x-example"], "5");
    EXPECT_EQ (written["parameters"][1]["name"], "sort");
    EXPECT_EQ (written["parameters"][2]["name"], "X-Trace");
    EXPECT_EQ (written["parameters"][3]["in"], "body");
    EXPECT_TRUE (full["paths"]["/items/{id}"].contains ("delete"));
    EXPECT_EQ (full["swagger"], "2.0");

    // And the file is the collection: importing it shows what the UI showed.
    const json before = snapshot (*db_, copy);
    EXPECT_EQ (snapshot (*db_, import_text (text)), before) << text;
}

TEST_F (SpecExportRouteTest, RefusesABoundModeItDoesNotHave) {
    auto [status, body] = routes::export_spec_response (
    *db_, json{ { "collectionId", root_ }, { "mode", "everything" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("mode"), std::string::npos);
}

TEST_F (SpecExportRouteTest, WritesYamlWhenAskedForIt) {
    create_request (root_, "GET", "{{baseUrl}}/pets");

    const json body = export_ok (json{ { "collectionId", root_ }, { "format", "yaml" } });
    EXPECT_EQ (body["fileName"], "pets-api.openapi.yaml");
    EXPECT_NE (body["text"].get<std::string> ().find ("openapi: 3.1.0"), std::string::npos)
    << body["text"];
}

TEST_F (SpecExportRouteTest, RefusesAFormatItDoesNotWrite) {
    auto [status, body] = routes::export_spec_response (
    *db_, json{ { "collectionId", root_ }, { "format", "toml" } });
    EXPECT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("format"),
    std::string::npos);
}

TEST_F (SpecExportRouteTest, IsA404ForACollectionThatIsNotThere) {
    auto [status, body] =
    routes::export_spec_response (*db_, json{ { "collectionId", "col_nope" } });
    EXPECT_EQ (status, 404) << body.dump ();
}

TEST_F (SpecExportRouteTest, RefusesRatherThanSubstitutingASkeletonForAMissingDocument) {
    // A skeleton in place of the document the user believes they are updating
    // would drop every member of their spec Vayu does not model, so a binding
    // the store cannot answer is a refusal that names it.
    const std::string spec = store_spec (PETS_DOC);
    bind (root_, spec);
    db_->delete_spec_document (spec);

    auto [status, body] =
    routes::export_spec_response (*db_, json{ { "collectionId", root_ } });
    EXPECT_EQ (status, 409) << body.dump ();
    EXPECT_NE (body["error"]["message"].get<std::string> ().find (spec), std::string::npos);
}

TEST_F (SpecExportRouteTest, LeavesTheCollectionExactlyAsItFoundIt) {
    const std::string spec = store_spec (PETS_DOC);
    bind (root_, spec);
    const std::string listed = create_request (root_, "GET", "{{baseUrl}}/pets",
    json{ { "operationId", "listPets" }, { "method", "GET" }, { "path", "/pets" } });

    export_collection ();

    const auto stored = db_->get_spec_document (spec);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->content, PETS_DOC);
    const auto request = db_->get_request (listed);
    ASSERT_HAS_VALUE (request);
    ASSERT_HAS_VALUE (request->spec_operation);
    EXPECT_NE (request->spec_operation->find ("listPets"), std::string::npos);
}

} // namespace
