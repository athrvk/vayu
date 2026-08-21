/**
 * @file tests/openapi_export_test.cpp
 * @brief Exporting a collection as an OpenAPI document (issue #630's assembly,
 *        moved engine-side by #855).
 *
 * Two directions with opposite failure modes, so both are exercised here. A
 * bound export's danger is *loss* - a member of the user's own contract that
 * export quietly drops - which is why preservation is asserted by perturbing the
 * stored document and reading the perturbation back out. A skeleton's danger is
 * *invention* - a schema, a required flag or a response nobody declared - which
 * is why the assertions are as much about what is absent as about what is there.
 *
 * These are the cases `app/src/services/exporters/openapi.test.ts` held before
 * the assembly moved, ported rather than re-derived, plus the two the renderer
 * could not state: that the YAML the engine now writes reads back as the
 * document it was written from, and that a scalar which would change type on the
 * way back is quoted.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/core/openapi_document.hpp"
#include "vayu/core/openapi_export.hpp"
#include "vayu/utils/diagnostics.hpp"

using vayu::core::export_openapi;
using vayu::core::ExportCollection;
using vayu::core::ExportExample;
using vayu::core::ExportFormat;
using vayu::core::ExportKeyValue;
using vayu::core::ExportOperationIdentity;
using vayu::core::ExportOutcome;
using vayu::core::ExportRequest;
using json = nlohmann::ordered_json;

namespace {

const ExportCollection PETSTORE{ "Petstore", "" };

std::string bound_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "petstore-bound.json";
    std::ifstream in (path);
    EXPECT_TRUE (in.good ()) << "fixture missing: " << path;
    std::ostringstream buffer;
    buffer << in.rdbuf ();
    return buffer.str ();
}

ExportRequest request (std::string method, std::string url) {
    ExportRequest entry;
    entry.method = std::move (method);
    entry.url    = std::move (url);
    return entry;
}

ExportRequest
bound_request (std::string method, std::string url, std::string operation_id, std::string path) {
    ExportRequest entry  = request (std::move (method), std::move (url));
    entry.spec_operation = ExportOperationIdentity{ std::move (operation_id),
        entry.method, std::move (path) };
    return entry;
}

/** The three bound requests the fixture describes, all identities intact. */
std::vector<ExportRequest> bound_requests () {
    return { bound_request ("GET", "{{baseUrl}}/pets", "listPets", "/pets"),
        bound_request ("POST", "{{baseUrl}}/pets", "createPet", "/pets"),
        bound_request ("DELETE", "{{baseUrl}}/pets/{{petId}}", "deletePet", "/pets/{petId}") };
}

ExportExample example (std::string name = "200 - ok",
int status                              = 200,
std::string body                        = R"({"id":"p1","name":"Rex"})",
std::string content_type                = "application/json") {
    return { std::move (name), status, std::move (body), std::move (content_type), false };
}

ExportKeyValue row (std::string key, std::string value) {
    return { std::move (key), std::move (value), {} };
}

/** An export that must have succeeded, with its text parsed back. */
struct Exported {
    json document;
    vayu::core::ExportNotes notes;
    std::string text;
    std::string file_name;
};

Exported export_json (const std::vector<ExportRequest>& requests,
const std::optional<std::string>& content = std::nullopt,
const ExportCollection& collection        = PETSTORE) {
    const ExportOutcome outcome =
    export_openapi (collection, requests, content, ExportFormat::Json);
    EXPECT_TRUE (outcome.ok ()) << outcome.error;
    return { json::parse (outcome.text), outcome.notes, outcome.text, outcome.file_name };
}

// `operation_of` takes a reference and returns one into it, which is GCC 13's
// ref-in/ref-out heuristic exactly; every call below chains into a live
// `exported.document`, so nothing dangles. See utils/diagnostics.hpp - the
// suppression covers the rest of the file because every use is a call site.
VAYU_IGNORE_FALSE_DANGLING_REFERENCE
const json&
operation_of (const json& document, const std::string& path, const std::string& method) {
    return document.at ("paths").at (path).at (method);
}

std::vector<std::string> keys_of (const json& node) {
    std::vector<std::string> keys;
    for (auto entry = node.begin (); entry != node.end (); ++entry) {
        keys.push_back (entry.key ());
    }
    return keys;
}

} // namespace

// ============================================================================
// The bound direction - the document, updated
// ============================================================================

TEST (BoundExport, KeepsEveryMemberVayuDoesNotModel) {
    const std::string content = bound_fixture ();
    const Exported exported   = export_json (bound_requests (), content);
    const json stored         = json::parse (content);

    EXPECT_EQ (exported.document["x-vendor-note"], stored["x-vendor-note"]);
    EXPECT_EQ (exported.document["info"], stored["info"]);
    EXPECT_EQ (exported.document["tags"], stored["tags"]);
    EXPECT_EQ (exported.document["servers"], stored["servers"]);
    EXPECT_EQ (exported.document["components"], stored["components"]);
    // The dialect is the stored one - a 3.0 document does not export as 3.1.
    EXPECT_EQ (exported.document["openapi"], "3.0.3");
    EXPECT_EQ (exported.notes.dialect, "OpenAPI 3.0.3");
    EXPECT_EQ (exported.notes.direction, "document");
}

TEST (BoundExport, CarriesAPerturbedMemberThroughRatherThanRegenerating) {
    // The mutation check for preservation: change something in the stored
    // document that Vayu has no concept of, and it must appear in the output. A
    // rebuilt-from-scratch exporter passes the assertions above by luck and
    // fails this one.
    json perturbed             = json::parse (bound_fixture ());
    perturbed["x-vendor-note"] = "perturbed";
    perturbed["components"]["schemas"]["Unused"]["description"] = "still here";

    const Exported exported = export_json (bound_requests (), perturbed.dump ());
    EXPECT_EQ (exported.document["x-vendor-note"], "perturbed");
    EXPECT_EQ (
    exported.document["components"]["schemas"]["Unused"]["description"], "still here");
}

TEST (BoundExport, RemovesAnOperationNoRequestClaimsAndThePathItEmptied) {
    std::vector<ExportRequest> requests = bound_requests ();
    requests.pop_back (); // the DELETE, the only operation under /pets/{petId}

    const Exported exported = export_json (requests, bound_fixture ());
    EXPECT_EQ (keys_of (exported.document["paths"]), std::vector<std::string>{ "/pets" });
    EXPECT_EQ (exported.notes.operations_removed, 1);
    EXPECT_EQ (exported.notes.requests_exported, 2);
}

TEST (BoundExport, ReImportsToTheSameOperationsItExported) {
    // The round-trip invariant: what comes back out of a bound export is the
    // same set of identities that went in - read by the engine's own reader,
    // which is the one that stamps the `operations` index a re-import would
    // store.
    const Exported exported = export_json (bound_requests (), bound_fixture ());
    const auto read         = vayu::core::read_document (exported.text);
    ASSERT_TRUE (read.ok ()) << read.error;

    std::vector<std::string> identities;
    for (const auto& declared : vayu::core::declared_operations_of (read.root)) {
        identities.push_back (
        declared.operation_id + " " + declared.method + " " + declared.path);
    }
    EXPECT_EQ (identities,
    (std::vector<std::string>{ "listPets GET /pets", "createPet POST /pets",
    "deletePet DELETE /pets/{petId}" }));
}

TEST (BoundExport, WritesOneStoredExampleAsExampleAndSeveralAsANamedMap) {
    std::vector<ExportRequest> requests = bound_requests ();
    requests[0].examples                = { example () };
    requests[1].examples = { example ("created", 201, R"({"id":"p1"})"),
        example ("created twin", 201, R"({"id":"p2"})") };

    const Exported exported = export_json (requests, bound_fixture ());
    const json& listed      = operation_of (exported.document, "/pets",
         "get")["responses"]["200"]["content"]["application/json"];
    EXPECT_EQ (listed["example"], json::parse (R"({"id":"p1","name":"Rex"})"));
    // The declared schema is the contract's; an example never replaces it.
    EXPECT_EQ (listed["schema"], json::parse (R"({"$ref":"#/components/schemas/Pet"})"));
    EXPECT_FALSE (listed.contains ("examples"));

    const json& created = operation_of (exported.document, "/pets",
    "post")["responses"]["201"]["content"]["application/json"];
    EXPECT_FALSE (created.contains ("example"));
    EXPECT_EQ (created["examples"],
    json::parse (R"({"created":{"value":{"id":"p1"}},"created twin":{"value":{"id":"p2"}}})"));
    EXPECT_EQ (exported.notes.examples_written, 3);
}

TEST (BoundExport, DocumentsAStatusTheSpecNeverDeclaredAndSaysWhenABodyHadNoMediaType) {
    std::vector<ExportRequest> requests = bound_requests ();
    requests[0].examples = { example ("404 - missing", 404, "not found", "") };

    const Exported exported = export_json (requests, bound_fixture ());
    const json& response =
    operation_of (exported.document, "/pets", "get")["responses"]["404"];
    EXPECT_EQ (response["description"], "404 - missing");
    // No `content`: there is no honest key for a body whose media type nobody
    // stated, and the count is what says the body was left out.
    EXPECT_FALSE (response.contains ("content"));
    EXPECT_EQ (exported.notes.examples_without_media_type, 1);
    EXPECT_EQ (exported.notes.examples_written, 0);
}

TEST (BoundExport, NeverWritesATruncatedBodyAndCountsTheOnesItLeftOut) {
    ExportExample partial  = example ("200 - ok", 200, R"({"id":"p1","na")");
    partial.body_truncated = true;
    std::vector<ExportRequest> requests = bound_requests ();
    requests[0].examples                = { partial, example ("200 - whole") };

    const Exported exported = export_json (requests, bound_fixture ());
    const json& media       = operation_of (exported.document, "/pets",
          "get")["responses"]["200"]["content"]["application/json"];
    // The complete example is the one that lands, as `example` rather than a
    // two-entry map: the truncated one never reaches the grouping that would
    // have made it the second.
    EXPECT_EQ (media["example"], json::parse (R"({"id":"p1","name":"Rex"})"));
    EXPECT_FALSE (media.contains ("examples"));
    EXPECT_EQ (exported.notes.examples_written, 1);
    EXPECT_EQ (exported.notes.examples_truncated, 1);
}

TEST (BoundExport, WritesATruncatedExamplesResponseWithoutItsBodyAndCountsItOnce) {
    ExportExample partial  = example ("404 - missing", 404, "not fou", "");
    partial.body_truncated = true;
    std::vector<ExportRequest> requests = bound_requests ();
    requests[0].examples                = { partial };

    const Exported exported = export_json (requests, bound_fixture ());
    const json& response =
    operation_of (exported.document, "/pets", "get")["responses"]["404"];
    // The status is still documented - that much is known - and only the body is
    // withheld. Counted as truncated and not also as media-type-less: one
    // example, one line in the summary, naming the loss that stopped it.
    EXPECT_EQ (response["description"], "404 - missing");
    EXPECT_FALSE (response.contains ("content"));
    EXPECT_EQ (exported.notes.examples_truncated, 1);
    EXPECT_EQ (exported.notes.examples_without_media_type, 0);
    EXPECT_EQ (exported.notes.examples_written, 0);
}

TEST (BoundExport, WritesAParameterValueAsTheDeclaredParametersExampleAndLeavesARefAlone) {
    std::vector<ExportRequest> requests = bound_requests ();
    requests[0].params = { row ("limit", "25"), row ("unknownToTheSpec", "9") };

    const Exported exported = export_json (requests, bound_fixture ());
    const json& parameters = operation_of (exported.document, "/pets", "get")["parameters"];
    EXPECT_EQ (parameters[0]["name"], "limit");
    EXPECT_EQ (parameters[0]["example"], "25");
    // A parameter the request carries and the document does not declare is not
    // invented into the contract.
    ASSERT_EQ (parameters.size (), 2U);
    EXPECT_EQ (parameters[1], json::parse (R"({"$ref":"#/components/parameters/TraceId"})"));
    EXPECT_EQ (exported.notes.shared_parameters_left, 1);
}

TEST (BoundExport, LeavesABlankRowsParameterExactlyAsTheDocumentWroteIt) {
    // A blank row deleting the document's example would lose the contract's own
    // documentation to a row nobody typed in - an import creates blank header
    // rows for every declared parameter.
    std::vector<ExportRequest> requests = bound_requests ();
    requests[0].params                  = { row ("limit", "") };

    const Exported exported = export_json (requests, bound_fixture ());
    EXPECT_FALSE (
    operation_of (exported.document, "/pets", "get")["parameters"][0].contains ("example"));
}

TEST (BoundExport, NeverAddsAnOperationForARequestTheContractDoesNotDescribe) {
    std::vector<ExportRequest> requests = bound_requests ();
    requests.push_back (request ("GET", "{{baseUrl}}/health"));
    ExportRequest stale  = request ("GET", "{{baseUrl}}/owners");
    stale.spec_operation = ExportOperationIdentity{ "", "GET", "/owners" };
    requests.push_back (stale);

    const Exported exported = export_json (requests, bound_fixture ());
    EXPECT_EQ (keys_of (exported.document["paths"]),
    (std::vector<std::string>{ "/pets", "/pets/{petId}" }));
    EXPECT_EQ (exported.notes.requests_without_operation, 1);
    EXPECT_EQ (exported.notes.operations_not_in_document, 1);
    EXPECT_EQ (exported.notes.requests_exported, 3);
}

TEST (BoundExport, LeavesARefdPathItemAloneAndReportsItsRequestAsCarried) {
    // A bundler hoists a shared path item into `components.pathItems` and leaves
    // a `$ref` behind. Its methods are not readable from here without following
    // the ref and mutating a node other paths may share, so the item is left
    // exactly as it is - and the request that names it is carried, not missing.
    const std::string content =
    R"({"openapi":"3.1.0","paths":{)"
    R"("/pets":{"$ref":"#/components/pathItems/pets"}},)"
    R"("components":{"pathItems":{"pets":{"get":{"responses":{}}}}}})";
    const Exported exported = export_json (
    { bound_request ("GET", "{{baseUrl}}/pets", "listPets", "/pets") }, content);

    EXPECT_EQ (exported.document["paths"]["/pets"],
    json::parse (R"({"$ref":"#/components/pathItems/pets"})"));
    EXPECT_EQ (exported.notes.requests_exported, 1);
    EXPECT_EQ (exported.notes.operations_removed, 0);
    EXPECT_EQ (exported.notes.operations_not_in_document, 0);
}

TEST (BoundExport, RemovesFromASwagger20DocumentButWritesNothingIntoIt) {
    const std::string swagger =
    R"({"swagger":"2.0","info":{"title":"Legacy","version":"1.0"},"paths":{"/pets":{)"
    R"("get":{"operationId":"listPets","responses":{"200":{"description":"ok"}}},)"
    R"("post":{"operationId":"createPet","responses":{"200":{"description":"ok"}}}}}})";
    ExportRequest listed = bound_request ("GET", "{{baseUrl}}/pets", "listPets", "/pets");
    listed.examples = { example () };

    const Exported exported = export_json ({ listed }, swagger);
    EXPECT_FALSE (exported.document["paths"]["/pets"].contains ("post"));
    const json& response =
    operation_of (exported.document, "/pets", "get")["responses"]["200"];
    EXPECT_FALSE (response.contains ("content"));
    EXPECT_FALSE (response.contains ("examples"));
    EXPECT_TRUE (exported.notes.vocabulary_not_written);
    EXPECT_EQ (exported.notes.dialect, "Swagger 2.0");
    EXPECT_EQ (exported.notes.examples_written, 0);
}

TEST (BoundExport, FailsLoudlyOnAStoredDocumentItCannotRead) {
    // Loudly, and not by falling back to a skeleton: a skeleton silently
    // substituted for the document the user believes they are updating would
    // drop every member of their spec Vayu does not model.
    for (const std::string content : { "{ not json: [", "[]", R"({"paths":{}})" }) {
        const ExportOutcome outcome =
        export_openapi (PETSTORE, bound_requests (), content, ExportFormat::Json);
        EXPECT_FALSE (outcome.ok ()) << content;
        EXPECT_TRUE (outcome.text.empty ()) << content;
    }
}

// ============================================================================
// The skeleton direction - a starting point, not a contract
// ============================================================================

TEST (SkeletonExport, RecoversThePathTemplateAndTheServerFromTheRequestUrls) {
    const Exported exported =
    export_json ({ request ("GET", "{{baseUrl}}/pets/{{petId}}?verbose=1"),
    request ("POST", "{{baseUrl}}/pets") });

    EXPECT_EQ (exported.document["openapi"], "3.1.0");
    EXPECT_EQ (exported.document["servers"], json::parse (R"([{"url":"{{baseUrl}}"}])"));
    EXPECT_EQ (keys_of (exported.document["paths"]),
    (std::vector<std::string>{ "/pets/{petId}", "/pets" }));
    EXPECT_EQ (
    operation_of (exported.document, "/pets/{petId}", "get")["parameters"][0],
    json::parse (R"({"name":"petId","in":"path","required":true,"schema":{"type":"string"}})"));
    EXPECT_EQ (exported.notes.direction, "skeleton");
    EXPECT_EQ (exported.notes.requests_exported, 2);
}

TEST (SkeletonExport, DeclaresTheRowsTheRequestHoldsWithoutClaimingAnyAreRequired) {
    ExportRequest entry = request ("GET", "{{baseUrl}}/pets");
    entry.params        = { row ("status", "available"), row ("verbose", "") };
    entry.headers = { row ("Authorization", "Bearer x"), row ("X-Tenant", "acme") };

    const Exported exported = export_json ({ entry });
    EXPECT_EQ (operation_of (exported.document, "/pets", "get")["parameters"], json::parse (R"([
        {"name":"status","in":"query","schema":{"type":"string"},"example":"available"},
        {"name":"verbose","in":"query","schema":{"type":"string"}},
        {"name":"X-Tenant","in":"header","schema":{"type":"string"},"example":"acme"}
    ])"));
}

TEST (SkeletonExport, DescribesABodyOnlyFromTheBodyThatIsThereAndMarksTheShapeAsDerived) {
    ExportRequest posted = request ("POST", "{{baseUrl}}/pets");
    posted.body = { "json", R"({"name":"Rex","tags":["good"],"age":3})", {} };

    const Exported exported =
    export_json ({ posted, request ("PUT", "{{baseUrl}}/pets") });
    const json& body = operation_of (exported.document, "/pets",
    "post")["requestBody"]["content"]["application/json"];
    EXPECT_EQ (body["example"], json::parse (R"({"name":"Rex","tags":["good"],"age":3})"));
    EXPECT_EQ (body["schema"], json::parse (R"({"type":"object","properties":{
        "name":{"type":"string"},
        "tags":{"type":"array","items":{"type":"string"}},
        "age":{"type":"integer"}},
        "description":"Shape derived from an example body, not a declared schema."})"));
    // No body, no `requestBody` - and no `responses`, because nothing was ever
    // saved to say what this endpoint answers.
    EXPECT_FALSE (operation_of (exported.document, "/pets", "put").contains ("requestBody"));
    EXPECT_FALSE (operation_of (exported.document, "/pets", "put").contains ("responses"));
}

TEST (SkeletonExport, WritesTheQueryTextOfAGraphqlRequestNowhere) {
    // GraphQL over HTTP posts a JSON envelope Vayu composes at send time, so
    // the stored query text is not the body the endpoint receives. The
    // operation keeps its path; it gains no `requestBody` describing a request
    // nobody sends.
    ExportRequest posted = request ("POST", "{{baseUrl}}/graphql");
    posted.body          = { "graphql", "query { pets { id } }", {} };

    const Exported exported = export_json ({ posted });
    EXPECT_FALSE (
    operation_of (exported.document, "/graphql", "post").contains ("requestBody"));
}

TEST (SkeletonExport, DeclaresAFormsFieldNamesAndNoneOfItsValues) {
    ExportRequest posted = request ("POST", "{{baseUrl}}/pets");
    posted.body          = { "x-www-form-urlencoded", "", { "name", "tag" } };

    const Exported exported = export_json ({ posted });
    EXPECT_EQ (
    operation_of (exported.document, "/pets",
    "post")["requestBody"]["content"]["application/x-www-form-urlencoded"],
    json::parse (R"({"schema":{"type":"object","properties":{"name":{"type":"string"},"tag":{"type":"string"}}}})"));
}

TEST (SkeletonExport, WritesResponsesFromStoredExamplesAndNothingElse) {
    ExportRequest entry = request ("GET", "{{baseUrl}}/pets");
    entry.examples = { example (), example ("500 - boom", 500, "boom", "text/plain") };

    const Exported exported = export_json ({ entry });
    const json& responses =
    operation_of (exported.document, "/pets", "get")["responses"];
    EXPECT_EQ (keys_of (responses), (std::vector<std::string>{ "200", "500" }));
    EXPECT_EQ (responses["200"]["description"], "200 - ok");
    EXPECT_EQ (responses["200"]["content"]["application/json"]["example"],
    json::parse (R"({"id":"p1","name":"Rex"})"));
    // A body that is not JSON is the text it is, never dropped.
    EXPECT_EQ (responses["500"]["content"]["text/plain"]["example"], "boom");
    EXPECT_EQ (exported.notes.examples_written, 2);
}

TEST (SkeletonExport, DerivesNoSchemaFromABodyItOnlyHasPartOf) {
    ExportExample partial  = example ();
    partial.body           = R"({"id":"p1","na")";
    partial.body_truncated = true;
    ExportRequest entry    = request ("GET", "{{baseUrl}}/pets");
    entry.examples         = { partial };

    const Exported exported = export_json ({ entry });
    // A skeleton is the one direction that reads a shape off an example body,
    // which makes a partial body worse here than in the bound direction: the
    // contract would state the fields the capture happened to reach as the
    // whole of the response.
    EXPECT_FALSE (
    operation_of (exported.document, "/pets", "get")["responses"]["200"].contains ("content"));
    EXPECT_EQ (exported.notes.examples_truncated, 1);
    EXPECT_EQ (exported.notes.examples_written, 0);
}

TEST (SkeletonExport, CountsARequestItCannotPlaceInsteadOfGuessingAtOne) {
    const Exported exported = export_json ({ request ("GET", "{{baseUrl}}"),
    request ("GET", "{{baseUrl}}/pets"), request ("GET", "https://api.example.com/pets") });

    EXPECT_EQ (keys_of (exported.document["paths"]), std::vector<std::string>{ "/pets" });
    EXPECT_EQ (exported.notes.requests_without_path, 1);
    EXPECT_EQ (exported.notes.duplicate_operations, 1);
    EXPECT_EQ (exported.notes.requests_exported, 1);
}

TEST (SkeletonExport, NamesTheCollectionAndNeverInventsAVersionItWasTold) {
    const Exported exported =
    export_json ({}, std::nullopt, { "Internal tools", "Scratch space" });
    EXPECT_EQ (exported.document["info"],
    json::parse (R"({"title":"Internal tools","version":"0.0.0","description":"Scratch space"})"));
    EXPECT_FALSE (exported.document.contains ("servers"));
}

// ============================================================================
// Serialization
// ============================================================================

TEST (ExportSerialization, WritesTheSameDocumentAsJsonAndAsYaml) {
    std::vector<ExportRequest> requests = bound_requests ();
    requests[0].examples                = { example () };
    const std::string content           = bound_fixture ();

    const ExportOutcome as_json =
    export_openapi (PETSTORE, requests, content, ExportFormat::Json);
    const ExportOutcome as_yaml =
    export_openapi (PETSTORE, requests, content, ExportFormat::Yaml);
    ASSERT_TRUE (as_yaml.ok ()) << as_yaml.error;

    const auto reread = vayu::core::read_document (as_yaml.text);
    ASSERT_TRUE (reread.ok ()) << reread.error << "\n" << as_yaml.text;
    EXPECT_EQ (reread.root, json::parse (as_json.text));
    EXPECT_EQ (as_json.file_name, "petstore.openapi.json");
    EXPECT_EQ (as_yaml.file_name, "petstore.openapi.yaml");
}

TEST (ExportSerialization, QuotesEveryScalarThatWouldComeBackAsSomethingElse) {
    // The emitter's mutation check, and the reason it lives beside the reader:
    // a plain `swagger: 2.0` re-reads as a number, and `swagger: "2.0"` is the
    // key Swagger 2.0 detection turns on. Every value here is a string on the
    // way in and must be a string on the way back.
    ExportRequest entry = request ("GET", "{{baseUrl}}/pets");
    for (const std::string awkward : { "2.0", "007", "true", "null", "~", "no", "- dash",
         "colon: space", "trailing ", " leading", "#hash", "line\nbreak", "" }) {
        entry.params = { row ("k", awkward) };
        const ExportOutcome outcome =
        export_openapi (PETSTORE, { entry }, std::nullopt, ExportFormat::Yaml);
        ASSERT_TRUE (outcome.ok ()) << outcome.error;
        const auto reread = vayu::core::read_document (outcome.text);
        ASSERT_TRUE (reread.ok ()) << awkward << ": " << reread.error;

        const json& parameter =
        reread.root["paths"]["/pets"]["get"]["parameters"][0];
        if (awkward.empty ()) {
            // An empty value writes no `example` at all - a row nobody filled
            // in is not an example of anything.
            EXPECT_FALSE (parameter.contains ("example")) << "empty value";
            continue;
        }
        ASSERT_TRUE (parameter["example"].is_string ())
        << awkward << " came back as " << parameter["example"].dump ();
        EXPECT_EQ (parameter["example"].get<std::string> (), awkward);
    }
}

TEST (ExportSerialization, QuotesAMappingKeyThatWouldComeBackAsANumber) {
    ExportRequest entry = request ("GET", "{{baseUrl}}/pets");
    entry.examples      = { example ("ok", 200, "{}", "application/json") };

    const ExportOutcome outcome =
    export_openapi (PETSTORE, { entry }, std::nullopt, ExportFormat::Yaml);
    ASSERT_TRUE (outcome.ok ()) << outcome.error;
    EXPECT_NE (outcome.text.find ("\"200\":"), std::string::npos) << outcome.text;

    const auto reread = vayu::core::read_document (outcome.text);
    ASSERT_TRUE (reread.ok ()) << reread.error;
    EXPECT_TRUE (
    reread.root["paths"]["/pets"]["get"]["responses"].contains ("200"));
}

TEST (ExportSerialization, NamesTheFileAfterTheCollectionHoweverItIsNamed) {
    const auto named = [] (const std::string& name) {
        return export_openapi ({ name, "" }, {}, std::nullopt, ExportFormat::Json)
        .file_name;
    };
    EXPECT_EQ (named ("Pet Store / v2"), "pet-store-v2.openapi.json");
    EXPECT_EQ (named ("   "), "collection.openapi.json");
}
VAYU_DIAGNOSTIC_POP
