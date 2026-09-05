/**
 * @file tests/openapi_drafts_test.cpp
 * @brief The requests an import of a document would build (issue #865).
 *
 * These fail quietly, which is why the fixture leads. Nothing crashes when the
 * engine's draft for an operation differs from the one the renderer's import
 * parsers build: the spec sync diff compares a stored request against a draft
 * field by field, so a disagreement reads as *the document changed this
 * request* - a rename offered on a document nobody edited, or an edit the user
 * made reported as the document's. `fixtures/spec-request-drafts-conformance.json`
 * (read by `app/src/services/openapi/spec-request-drafts.conformance.test.ts`
 * too) is what turns that into a failing test on one side or the other.
 *
 * The cases below the fixture are the rules a fixture cannot state: what a
 * malformed document does, where a cycle stops, and which of two declarations
 * of one parameter wins. Each names what reverting it costs.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/openapi_document.hpp"

namespace {

using nlohmann::json;
using vayu::core::DraftField;
using vayu::core::read_document;
using vayu::core::spec_request_drafts_of;
using vayu::core::SpecRequestDraft;

nlohmann::ordered_json read_ok (const std::string& text) {
    const auto document = read_document (text);
    EXPECT_TRUE (document.ok ()) << document.error;
    return document.root;
}

std::vector<SpecRequestDraft> drafts_of (const std::string& text) {
    return spec_request_drafts_of (read_ok (text));
}

/// One draft in the fixture's shape, so a mismatch prints the whole row rather
/// than the first field that differed.
json rows_of (const std::vector<DraftField>& fields) {
    json out = json::array ();
    for (const DraftField& field : fields) {
        out.push_back ({ { "key", field.key }, { "value", field.value },
        { "enabled", field.enabled }, { "description", field.description },
        { "file", field.file } });
    }
    return out;
}

/**
 * The documented responses, **sorted by status** (issue #854).
 *
 * The order is not a shared answer and cannot be: this side keeps document
 * order, while a JavaScript object sorts integer-like keys ahead of the rest, so
 * `responses: {404, 200}` reaches the renderer as `200, 404` - the same
 * divergence the declared-operations fixture records for the response patterns.
 * What has to agree is which responses there are and what each one carries.
 */
json examples_of (const std::vector<vayu::core::DraftExample>& examples) {
    std::vector<const vayu::core::DraftExample*> sorted;
    sorted.reserve (examples.size ());
    for (const auto& example : examples) {
        sorted.push_back (&example);
    }
    std::stable_sort (sorted.begin (), sorted.end (),
    [] (const auto* a, const auto* b) { return a->status < b->status; });

    json out = json::array ();
    for (const auto* example : sorted) {
        json headers = json::array ();
        if (example->documented) {
            headers.push_back ({ { "key", "Content-Type" },
            { "value", example->content_type }, { "enabled", true } });
        }
        out.push_back ({ { "name", example->name },
        { "status", example->status }, { "headers", std::move (headers) },
        { "body", example->body }, { "contentType", example->content_type } });
    }
    return out;
}

/// Built as an unordered `json` on purpose: `ordered_json`'s `operator==`
/// compares its object entries in *stored* order, so an equal pair of drafts
/// written with their keys in two orders would read as a difference.
json as_json (const SpecRequestDraft& draft) {
    json out;
    if (!draft.operation.operation_id.empty ()) {
        out["operationId"] = draft.operation.operation_id;
    }
    out["method"]      = draft.operation.method;
    out["path"]        = draft.operation.path;
    out["folder"]      = draft.folder;
    out["name"]        = draft.draft.name;
    out["description"] = draft.draft.description;
    out["url"]         = draft.draft.url;
    out["params"]      = rows_of (draft.draft.params);
    out["headers"]     = rows_of (draft.draft.headers);
    out["body"]        = { { "mode", draft.draft.body.mode },
               { "content", draft.draft.body.content },
               { "fields", rows_of (draft.draft.body.fields) } };
    out["examples"]    = examples_of (draft.draft.examples);
    return out;
}

/// The draft for one operation, by the key the fixture is compared on.
std::string key_of (const SpecRequestDraft& draft) {
    return draft.operation.method + " " + draft.operation.path;
}

const SpecRequestDraft& find_draft (const std::vector<SpecRequestDraft>& drafts,
const std::string& key) {
    for (const SpecRequestDraft& draft : drafts) {
        if (key_of (draft) == key) {
            return draft;
        }
    }
    ADD_FAILURE () << "no draft for " << key;
    static const SpecRequestDraft missing;
    return missing;
}

// ---------------------------------------------------------------------------
// The shared fixture
// ---------------------------------------------------------------------------

TEST (SpecRequestDrafts, MatchesTheRenderersImportParsersOnTheSharedFixture) {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "spec-request-drafts-conformance.json";
    std::ifstream in (path);
    ASSERT_TRUE (in.good ()) << "fixture missing: " << path;
    const json fixture = json::parse (in);
    // A fixture that failed to load reads as a suite of passing tests.
    ASSERT_FALSE (fixture["cases"].empty ())
    << "a fixture with no cases asserts nothing";

    size_t compared = 0;
    for (const auto& fixture_case : fixture["cases"]) {
        const auto name = fixture_case["name"].get<std::string> ();
        const auto document =
        read_document (fixture_case["document"].get<std::string> ());
        ASSERT_TRUE (document.ok ()) << name << ": " << document.error;
        const std::vector<SpecRequestDraft> drafts =
        spec_request_drafts_of (document.root);
        ASSERT_EQ (drafts.size (), fixture_case["drafts"].size ()) << name;

        // Keyed rather than ordered: the engine walks the document while
        // `readSpecOperations` walks the collection tree it built (root
        // requests, then tag folders). Two orders both sides agree about.
        for (const auto& expected : fixture_case["drafts"]) {
            const std::string key = expected["method"].get<std::string> () +
            " " + expected["path"].get<std::string> ();
            EXPECT_EQ (as_json (find_draft (drafts, key)), expected) << name << ": " << key;
            compared += 1;
        }
    }
    // Every case answering with an empty list would compare nothing at all.
    EXPECT_GE (compared, 10u);
}

// ---------------------------------------------------------------------------
// What a fixture cannot state
// ---------------------------------------------------------------------------

TEST (SpecRequestDrafts, ADocumentThatIsNotAContractBuildsNoDrafts) {
    // A Postman export is a perfectly good file that simply cannot be a
    // contract. Building drafts from it would offer a sync of a document that
    // declares no operations - and every one of them would read as removed.
    EXPECT_TRUE (drafts_of (R"({"info": {"name": "P"}, "item": []})").empty ());
    EXPECT_TRUE (
    drafts_of (R"({"openapi": "2.0", "paths": {"/a": {"get": {}}}})").empty ());
    EXPECT_TRUE (drafts_of ("[]").empty ());
}

TEST (SpecRequestDrafts, APathThatIsNotAPathDeclaresNoRequest) {
    // The identity such an operation would carry is the one the engine refuses
    // (`400`, `specOperation.path`), so the renderer imports the request without
    // one - and a request with no identity is not a draft the diff can follow.
    const auto drafts = drafts_of (R"({
      "openapi": "3.0.0",
      "paths": { "pets": { "get": { "operationId": "bad" } },
                 "/pets": { "get": { "operationId": "good" } } }
    })");
    ASSERT_EQ (drafts.size (), 1u);
    EXPECT_EQ (drafts[0].operation.operation_id, "good");
}

TEST (SpecRequestDrafts, ReadsThroughAPathItemThatIsARef) {
    // What a bundler emits when it hoists a shared path item into
    // `components.pathItems`. Read unresolved, the `$ref` node carries no method
    // keys and every operation under that path silently disappears.
    const auto drafts = drafts_of (R"({
      "openapi": "3.0.0",
      "paths": { "/pets": { "$ref": "#/components/pathItems/Pets" } },
      "components": { "pathItems": { "Pets": {
        "parameters": [{"name": "q", "in": "query", "schema": {"type": "string"}}],
        "get": { "operationId": "listPets", "summary": "List" }
      } } }
    })");
    ASSERT_EQ (drafts.size (), 1u);
    EXPECT_EQ (drafts[0].draft.name, "List");
    ASSERT_EQ (drafts[0].draft.params.size (), 1u);
    EXPECT_EQ (drafts[0].draft.params[0].key, "q");
}

TEST (SpecRequestDrafts, TheOperationsParameterWinsInThePathItemsPosition) {
    // A JavaScript `Map.set` on a key it already holds replaces the value and
    // keeps the insertion order, and these rows reach the URL's query in that
    // order - so "later wins" and "keeps its place" are one rule, not two.
    // Appending the operation's copy at the end instead would reorder the query
    // string of every request whose path item declares a parameter.
    const auto drafts = drafts_of (R"({
      "openapi": "3.0.0",
      "paths": { "/pets": {
        "parameters": [{"name": "a", "in": "query", "example": "path"},
                       {"name": "b", "in": "query", "example": "second"}],
        "get": { "operationId": "list",
                 "parameters": [{"name": "a", "in": "query", "example": "operation"}] }
      } }
    })");
    ASSERT_EQ (drafts.size (), 1u);
    const auto& params = drafts[0].draft.params;
    ASSERT_EQ (params.size (), 2u);
    EXPECT_EQ (params[0].key, "a");
    EXPECT_EQ (params[0].value, "operation");
    EXPECT_EQ (params[1].key, "b");
    EXPECT_EQ (drafts[0].draft.url, "{{baseUrl}}/pets?a=operation&b=second");
}

TEST (SpecRequestDrafts, StepsOverAParametersMappingRatherThanReadingItAsAList) {
    // A missing `-` in hand-written YAML makes `parameters` a mapping. Spreading
    // that threw `not iterable` on the renderer side and lost the whole file;
    // here it must simply declare no rows, so the rest of the operation survives.
    const auto drafts = drafts_of (R"({
      "openapi": "3.0.0",
      "paths": { "/pets": { "get": { "operationId": "list",
                                     "parameters": {"name": "q", "in": "query"} } } }
    })");
    ASSERT_EQ (drafts.size (), 1u);
    EXPECT_TRUE (drafts[0].draft.params.empty ());
    EXPECT_EQ (drafts[0].draft.url, "{{baseUrl}}/pets");
}

TEST (SpecRequestDrafts, SamplesARecursiveSchemaWithoutRunningForever) {
    // A schema naming itself has no finite expansion. The guard is per branch,
    // not per document, so two siblings may each reach the same shared schema -
    // which is why the cycle set is copied down each branch rather than shared.
    const auto drafts = drafts_of (R"({
      "openapi": "3.0.0",
      "paths": { "/nodes": { "post": { "operationId": "add", "requestBody": { "content": {
        "application/json": { "schema": { "$ref": "#/components/schemas/Node" } } } } } } },
      "components": { "schemas": {
        "Node": { "type": "object", "properties": {
          "left": { "$ref": "#/components/schemas/Leaf" },
          "right": { "$ref": "#/components/schemas/Leaf" },
          "self": { "$ref": "#/components/schemas/Node" } } },
        "Leaf": { "type": "object", "properties": { "id": { "type": "string" } } } } }
    })");
    ASSERT_EQ (drafts.size (), 1u);
    EXPECT_EQ (drafts[0].draft.body.mode, "json");
    EXPECT_EQ (drafts[0].draft.body.content,
    "{\n  \"left\": {\n    \"id\": \"\"\n  },\n  \"right\": {\n    \"id\": "
    "\"\"\n  },\n  \"self\": {}\n}");
}

TEST (SpecRequestDrafts, WritesTheQueryTheWayARequestBuiltInTheAppCarriesIt) {
    // Every execution path sends `url` verbatim while `params[]` stays editor
    // state (issue #590), so a draft whose URL carried no query would differ
    // from every stored request it is compared against - on every request that
    // declares one. Disabled rows stay out; a `{{var}}` is left unencoded, or
    // the token would reach the wire percent-escaped.
    const auto drafts = drafts_of (R"({
      "openapi": "3.0.0",
      "paths": { "/search": { "get": { "operationId": "search", "parameters": [
        {"name": "q p", "in": "query", "example": "a b&c"},
        {"name": "off", "in": "query", "schema": {"type": "string"}},
        {"name": "on", "in": "query", "required": true},
        {"name": "tpl", "in": "query", "example": "{{token}}"}
      ] } } }
    })");
    ASSERT_EQ (drafts.size (), 1u);
    EXPECT_EQ (drafts[0].draft.url, "{{baseUrl}}/search?q%20p=a%20b%26c&on&tpl={{token}}");
    EXPECT_FALSE (drafts[0].draft.params[1].enabled);
}

TEST (SpecRequestDrafts, DropsTheHeadersARequestProducesForItself) {
    // Both are written by the request's own auth and body rather than typed into
    // a row, so importing them as rows means sending an empty `Authorization`
    // beside the real one.
    const auto drafts = drafts_of (R"({
      "openapi": "3.0.0",
      "paths": { "/pets": { "get": { "operationId": "list", "parameters": [
        {"name": "authorization", "in": "header", "required": true},
        {"name": "Content-Type", "in": "header", "required": true},
        {"name": "X-Kept", "in": "header", "required": true},
        {"name": "session", "in": "cookie", "required": true},
        {"name": "petId", "in": "path", "required": true}
      ] } } }
    })");
    ASSERT_EQ (drafts.size (), 1u);
    ASSERT_EQ (drafts[0].draft.headers.size (), 1u);
    EXPECT_EQ (drafts[0].draft.headers[0].key, "X-Kept");
    EXPECT_TRUE (drafts[0].draft.params.empty ());
}

TEST (SpecRequestDrafts, ReadsTheSameDocumentTheSameWayInYamlAndInJson) {
    // The stored bytes are whatever arrived, and a document Vayu imported as
    // YAML must diff against the same drafts its JSON form would produce.
    const std::string yaml      = R"(openapi: "3.0.1"
paths:
  /pets/{petId}:
    get:
      operationId: getPet
      summary: Get
      tags: [pets]
      parameters:
        - name: verbose
          in: query
          required: true
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                count: {type: integer}
)";
    const std::string json_text = R"({
      "openapi": "3.0.1",
      "paths": { "/pets/{petId}": { "get": {
        "operationId": "getPet", "summary": "Get", "tags": ["pets"],
        "parameters": [{"name": "verbose", "in": "query", "required": true}],
        "requestBody": { "content": { "application/json": { "schema": {
          "type": "object", "properties": { "count": {"type": "integer"} } } } } }
      } } }
    })";
    const auto from_yaml        = drafts_of (yaml);
    const auto from_json        = drafts_of (json_text);
    ASSERT_EQ (from_yaml.size (), 1u);
    ASSERT_EQ (from_json.size (), 1u);
    EXPECT_EQ (as_json (from_yaml[0]), as_json (from_json[0]));
    EXPECT_EQ (from_yaml[0].draft.url, "{{baseUrl}}/pets/{{petId}}?verbose");
    EXPECT_EQ (from_yaml[0].draft.body.content, "{\n  \"count\": 0\n}");
}

TEST (SpecRequestDrafts, WritesAWholeNumberTheWayJavaScriptDoes) {
    // `JSON.stringify` never writes a trailing `.0`, where a C++ dump does - and
    // the body text *is* the compared value, so `4.0` spelled two ways is a
    // change the diff would report on every sync of an unchanged document.
    const auto drafts = drafts_of (R"({
      "openapi": "3.0.0",
      "paths": { "/x": { "post": { "operationId": "x", "requestBody": { "content": {
        "application/json": { "schema": { "type": "object", "properties": {
          "whole": {"type": "number", "example": 4.0},
          "fraction": {"type": "number", "example": 1.5},
          "negative": {"type": "integer", "example": -7},
          "huge": {"type": "number", "example": 1e20},
          "huger": {"type": "number", "example": 1e21},
          "tiny": {"type": "number", "example": 1e-7} } } } } } } } }
    })");
    ASSERT_EQ (drafts.size (), 1u);
    // The last three are where a shortest-round-trip printer and JavaScript part
    // company: it would write `1e+20` for a value JavaScript spells out in full,
    // and `1e-07` for one JavaScript writes with a bare exponent.
    EXPECT_EQ (drafts[0].draft.body.content,
    "{\n  \"whole\": 4,\n  \"fraction\": 1.5,\n  \"negative\": -7,"
    "\n  \"huge\": 100000000000000000000,\n  \"huger\": 1e+21,\n  \"tiny\": "
    "1e-7\n}");
}

TEST (SpecRequestDrafts, FilesAnOperationWhereAnImportWouldHavePutIt) {
    // Applying an *added* operation has to put the request somewhere, and "where
    // an import would have put it" is the only answer that leaves a synced
    // collection shaped like an imported one.
    const auto drafts = drafts_of (R"({
      "openapi": "3.0.0",
      "paths": {
        "/api/v2/{tenant}/orders": { "get": { "operationId": "byPath" } },
        "/pets": { "get": { "operationId": "byTag", "tags": ["Pets", "Store"] } },
        "/v1": { "get": { "operationId": "onRoot" } }
      }
    })");
    EXPECT_EQ (find_draft (drafts, "GET /api/v2/{tenant}/orders").folder, "orders");
    // Only the first tag groups an operation: a request duplicated into two
    // folders is two requests to edit.
    EXPECT_EQ (find_draft (drafts, "GET /pets").folder, "Pets");
    EXPECT_EQ (find_draft (drafts, "GET /v1").folder, "");
}

TEST (SpecRequestDrafts, RemembersWhichNamedExampleKeyAResponseWasTakenFrom) {
    // The bound export must write an edited example back into the entry it
    // came from rather than beside it (issue #1457), which needs the map key
    // `first_named_example` used to discard.
    const auto drafts = drafts_of (R"({
      "openapi": "3.0.0",
      "paths": { "/pets": { "get": { "operationId": "list", "responses": {
        "200": { "description": "ok", "content": { "application/json": {
          "examples": {
            "two": { "summary": "Two pets", "value": [1, 2] },
            "none": { "summary": "No pets", "value": [] }
          }
        } } } }
      } } }
    })");
    ASSERT_EQ (drafts.size (), 1u);
    ASSERT_EQ (drafts[0].draft.examples.size (), 1u);
    // The *first* entry of the map, same as `first_named_example` always took.
    const std::optional<std::string>& key = drafts[0].draft.examples[0].spec_example_key;
    ASSERT_HAS_VALUE (key);
    EXPECT_EQ (*key, "two");
}

TEST (SpecRequestDrafts, RecordsNoKeyForAnExampleFromASingleExampleOrASampledSchema) {
    // A single `example` and a schema-sampled value name no map entry - the
    // key stays absent, which is what makes a row that predates issue #1457
    // read exactly like one of these.
    const auto drafts = drafts_of (R"({
      "openapi": "3.0.0",
      "paths": {
        "/pets": { "get": { "operationId": "list", "responses": {
          "200": { "description": "ok", "content": { "application/json": {
            "example": [1, 2]
          } } }
        } } },
        "/owners": { "get": { "operationId": "owners", "responses": {
          "200": { "description": "ok", "content": { "application/json": {
            "schema": { "type": "object", "example": { "id": "o1" } }
          } } }
        } } }
      }
    })");
    ASSERT_EQ (drafts.size (), 2u);
    ASSERT_EQ (find_draft (drafts, "GET /pets").draft.examples.size (), 1u);
    EXPECT_FALSE (
    find_draft (drafts, "GET /pets").draft.examples[0].spec_example_key.has_value ());
    ASSERT_EQ (find_draft (drafts, "GET /owners").draft.examples.size (), 1u);
    EXPECT_FALSE (
    find_draft (drafts, "GET /owners").draft.examples[0].spec_example_key.has_value ());
}

} // namespace
