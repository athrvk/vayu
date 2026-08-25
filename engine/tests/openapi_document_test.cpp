/**
 * @file tests/openapi_document_test.cpp
 * @brief The engine reading a stored OpenAPI document (issue #853).
 *
 * Two things are on trial here, and they fail differently.
 *
 * The **reader** faces bytes a user chose: a document that cannot be parsed, one
 * that nests forever, one whose aliases resolve to more than a machine can hold.
 * Those must come back as sentences, and both guards were mutation-checked
 * rather than assumed. Drop the throwing callbacks and
 * `AnswersAMalformedDocumentInsteadOfDying` does not fail - it takes the test
 * binary down with `SIGABRT`, which is what rapidyaml's default error handler
 * would do to the daemon. Drop the node budget and
 * `RefusesAnAliasBombWithinItsBudget` reads a 300-byte upload for **7.9
 * seconds** and gigabytes of memory before answering `200`.
 *
 * The **indexes** face a subtler failure: nothing crashes when one disagrees with
 * the identity the renderer's importer stamps on a request - coverage simply
 * credits the wrong operation, or none. The shared fixture
 * (`fixtures/declared-operations-conformance.json`, read by
 * `app/src/services/openapi/declared-operations.conformance.test.ts` too) is
 * what turns that into a failing test on one side or the other.
 *
 * The **schema index** (issue #860) fails a third way again: a wrong
 * *translation* produces a confident, wrong verdict about a body - the null a
 * document explicitly permits reported as a type failure - where a missing one
 * would only have reported nothing. So each translation case below names what
 * reverting it costs, and `TheDerivedIndexIsWhatValidationThenReads` walks the
 * whole path, from a document's bytes to a validator's answer about one body.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/core/schema_validation.hpp"
#include "vayu/core/spec_coverage.hpp"

namespace {

using nlohmann::json;
using vayu::core::declared_operations_of;
using vayu::core::DeclaredOperation;
using vayu::core::derive_spec_indexes;
using vayu::core::read_document;

/// A cap no case here is trying to reach - the schema index's own limit is
/// exercised by the one case that names it.
constexpr size_t INDEX_CAP = size_t{ 1024 } * 1024;

nlohmann::ordered_json read_ok (const std::string& text) {
    const auto result = read_document (text);
    EXPECT_TRUE (result.ok ()) << "unexpected read failure: " << result.error;
    return result.root;
}

/// The keys of a mapping, in the order the reader hands them back.
std::vector<std::string> keys_of (const nlohmann::ordered_json& node) {
    std::vector<std::string> keys;
    for (auto entry = node.begin (); entry != node.end (); ++entry) {
        keys.push_back (entry.key ());
    }
    return keys;
}

/// One index row as the fixture writes it, so a mismatch prints as JSON rather
/// than as a struct nobody can read in a gtest diff.
json row_of (const DeclaredOperation& operation) {
    json row = json::object ();
    if (!operation.operation_id.empty ()) {
        row["operationId"] = operation.operation_id;
    }
    row["method"]    = operation.method;
    row["path"]      = operation.path;
    row["responses"] = operation.responses;
    return row;
}

json rows_of (const std::vector<DeclaredOperation>& declared) {
    json rows = json::array ();
    for (const auto& operation : declared) {
        rows.push_back (row_of (operation));
    }
    return rows;
}

} // namespace

// ============================================================================
// The reader
// ============================================================================

TEST (OpenApiDocumentRead, ReadsJson) {
    const auto document = read_ok (R"({"openapi":"3.0.0","paths":{"/pets":{}}})");
    EXPECT_EQ (document["openapi"], "3.0.0");
    EXPECT_TRUE (document["paths"].contains ("/pets"));
}

TEST (OpenApiDocumentRead, ReadsTheSameDocumentWrittenAsYaml) {
    const auto as_json =
    read_ok (R"({"openapi":"3.0.0","info":{"title":"Pets"},)"
             R"("paths":{"/pets":{"get":{"operationId":"listPets"}}}})");
    const auto as_yaml =
    read_ok ("openapi: \"3.0.0\"\n"
             "info:\n  title: Pets\n"
             "paths:\n  /pets:\n    get:\n      operationId: listPets\n");
    EXPECT_EQ (as_json, as_yaml);
}

TEST (OpenApiDocumentRead, KeepsMappingKeysInDocumentOrder) {
    // The promise `DeclaredOperation` makes about `responses` - and the one the
    // renderer could not keep, because a JavaScript object sorts integer-like
    // keys numerically ahead of everything else, so `{404, 200}` reached the
    // store as `200, 404`.
    const auto document =
    read_ok ("responses:\n  404: {}\n  200: {}\n  default: {}\n");
    EXPECT_EQ (keys_of (document["responses"]),
    (std::vector<std::string>{ "404", "200", "default" }));
}

TEST (OpenApiDocumentRead, TurnsEveryKeyIntoText) {
    // `200:` in YAML is an integer key. A status pattern is text on both sides
    // of the wire, and `match_status_pattern` compares strings.
    const auto document = read_ok ("responses:\n  200: ok\n  true: yes\n");
    EXPECT_EQ (keys_of (document["responses"]), (std::vector<std::string>{ "200", "true" }));
}

TEST (OpenApiDocumentRead, TypesPlainScalarsLikeJsYamlsCoreSchema) {
    const auto document =
    read_ok ("a: null\nb: ~\nc: true\nd: FALSE\ne: 42\nf: -7\n"
             "g: 0x1f\nh: 3.5\ni: 1e3\nj: plain text\nk:\n"
             "l: 2020-01-01\nm: .inf\n");
    EXPECT_TRUE (document["a"].is_null ());
    EXPECT_TRUE (document["b"].is_null ());
    EXPECT_EQ (document["c"], true);
    EXPECT_EQ (document["d"], false);
    EXPECT_EQ (document["e"], 42);
    EXPECT_EQ (document["f"], -7);
    EXPECT_EQ (document["g"], 31);
    EXPECT_DOUBLE_EQ (document["h"].get<double> (), 3.5);
    EXPECT_DOUBLE_EQ (document["i"].get<double> (), 1000.0);
    EXPECT_EQ (document["j"], "plain text");
    EXPECT_TRUE (document["k"].is_null ());
    // A date is deliberately *not* resolved to anything but its text: JSON has
    // no date type, and the document wrote text. js-yaml's default schema does
    // resolve it, which is the one divergence the header records.
    EXPECT_EQ (document["l"], "2020-01-01");
    // JSON has no infinity, and `JSON.stringify` writes it as null.
    EXPECT_TRUE (document["m"].is_null ());
}

TEST (OpenApiDocumentRead, AQuotedScalarIsAlwaysAString) {
    // The measured reason this reader types scalars itself rather than taking a
    // library's opinion: yaml-cpp reports this same document's `"2.0"` as the
    // number 2.0, and `swagger: "2.0"` is what Swagger detection turns on.
    const auto document =
    read_ok ("swagger: \"2.0\"\nversion: '1.0'\nport: 8080\n");
    EXPECT_EQ (document["swagger"], "2.0");
    EXPECT_TRUE (document["swagger"].is_string ());
    EXPECT_EQ (document["version"], "1.0");
    EXPECT_TRUE (document["version"].is_string ());
    EXPECT_EQ (document["port"], 8080);
}

TEST (OpenApiDocumentRead, ExpandsAnAlias) {
    const auto document =
    read_ok ("base: &b\n  description: shared\npaths:\n  /a: *b\n");
    EXPECT_EQ (document["paths"]["/a"]["description"], "shared");
}

TEST (OpenApiDocumentRead, ExpandsAMergeKeyWithTheExplicitKeyWinning) {
    // js-yaml's precedence, and the only one that makes `<<` mean "these are the
    // defaults": a key the mapping states itself always wins, wherever it sits.
    const auto document =
    read_ok ("base: &b {a: 1, b: 2}\nx:\n  b: 99\n  <<: *b\n  c: 3\n");
    EXPECT_EQ (document["x"]["a"], 1);
    EXPECT_EQ (document["x"]["b"], 99);
    EXPECT_EQ (document["x"]["c"], 3);
}

TEST (OpenApiDocumentRead, AnExplicitKeyWrittenAfterAMergeStillWins) {
    // The same rule as the case above, from the other side - and the one that is
    // easy to get wrong twice over: written after the `<<`, the key is neither a
    // duplicate to refuse nor a value to leave at the merged default. js-yaml
    // reads this document as `{a: 5}`.
    const auto document = read_ok ("base: &b {a: 1}\nx:\n  <<: *b\n  a: 5\n");
    EXPECT_EQ (document["x"]["a"], 5);
}

TEST (OpenApiDocumentRead, MergesASequenceOfSourcesEarliestFirst) {
    const auto document =
    read_ok ("b1: &b1 {a: 1}\nb2: &b2 {a: 2, z: 9}\nx:\n  <<: [*b1, *b2]\n");
    EXPECT_EQ (document["x"]["a"], 1);
    EXPECT_EQ (document["x"]["z"], 9);
}

TEST (OpenApiDocumentRead, RefusesAnAliasNamingNoAnchor) {
    const auto result = read_document ("x: *nope\n");
    EXPECT_FALSE (result.ok ());
    EXPECT_NE (result.error.find ("nope"), std::string::npos) << result.error;
}

TEST (OpenApiDocumentRead, RefusesADuplicateMappingKey) {
    // js-yaml refuses it too, so accepting it here would mean the importer and
    // the engine read one document two ways.
    const auto result = read_document ("paths:\n  /a: {}\n  /a: {}\n");
    EXPECT_FALSE (result.ok ());
    EXPECT_NE (result.error.find ("/a"), std::string::npos) << result.error;
}

TEST (OpenApiDocumentRead, AnswersAMalformedDocumentInsteadOfDying) {
    // rapidyaml's default error handler calls `abort()`. Without the throwing
    // callbacks this file installs, this case does not fail - it takes the whole
    // test binary down, which is what it would do to the daemon.
    const auto result = read_document ("a: [1, 2\nb: \"unterminated\n");
    EXPECT_FALSE (result.ok ());
    EXPECT_FALSE (result.error.empty ());
}

TEST (OpenApiDocumentRead, RefusesAnAliasBombWithinItsBudget) {
    // The "billion laughs" shape: 300-odd bytes that resolve to half a million
    // nodes. rapidyaml's own `Tree::resolve()` dies of `std::bad_alloc` on this
    // input, which is why the reader expands aliases itself - and its budget,
    // one node per byte of the document plus a floor, refuses this in 4ms where
    // an unbudgeted walk of the same bytes took 7.9 seconds and gigabytes.
    const std::string bomb =
    "a: &a [\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\"]\n"
    "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\n"
    "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n"
    "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n"
    "e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]\n"
    "f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]\n"
    "g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]\n";
    const auto result = read_document (bomb);
    EXPECT_FALSE (result.ok ());
    EXPECT_NE (result.error.find ("expands"), std::string::npos) << result.error;
}

TEST (OpenApiDocumentRead, RefusesADocumentNestedPastTheDepthBound) {
    std::string deep = "a:";
    for (int i = 0; i < 200; ++i) {
        deep += "\n" + std::string (static_cast<size_t> (i + 1) * 2, ' ') + "a:";
    }
    const auto result = read_document (deep + " 1\n");
    EXPECT_FALSE (result.ok ());
    EXPECT_NE (result.error.find ("nests"), std::string::npos) << result.error;
}

TEST (OpenApiDocumentRead, EmptyTextIsNotADocument) {
    const auto result = read_document ("");
    EXPECT_FALSE (result.ok ());
}

// ============================================================================
// What the document declares
// ============================================================================

TEST (DeclaredOperations, MatchesTheCrossLanguageFixture) {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "declared-operations-conformance.json";
    std::ifstream in (path);
    ASSERT_TRUE (in.good ()) << "fixture missing: " << path;
    const json fixture = json::parse (in);
    ASSERT_FALSE (fixture["cases"].empty ())
    << "a fixture with no cases asserts nothing";

    for (const auto& fixture_case : fixture["cases"]) {
        const auto name = fixture_case["name"].get<std::string> ();
        const auto document =
        read_document (fixture_case["document"].get<std::string> ());
        ASSERT_TRUE (document.ok ()) << name << ": " << document.error;
        EXPECT_EQ (rows_of (declared_operations_of (document.root)), fixture_case["operations"])
        << name;
    }
}

TEST (DeclaredOperations, WalksMethodsInAFixedOrderWhateverThePathItemWrites) {
    // The order the import parsers walk them in, and therefore the order a run's
    // coverage block prints its rows in. Reading them in document order instead
    // would make two documents that declare the same operations produce two
    // different indexes.
    const auto document = read_ok (R"({"openapi":"3.0.0","paths":{"/a":{)"
                                   R"("delete":{"responses":{}},"get":{"responses":{}},)"
                                   R"("post":{"responses":{}}}}})");
    const auto declared = declared_operations_of (document);
    ASSERT_EQ (declared.size (), 3U);
    EXPECT_EQ (declared[0].method, "GET");
    EXPECT_EQ (declared[1].method, "POST");
    EXPECT_EQ (declared[2].method, "DELETE");
}

TEST (DeclaredOperations, ADocumentThatIsNotAContractDeclaresNothing) {
    // A Postman export is a perfectly good file that cannot be a contract. It
    // stores, and reports no coverage rather than an empty one.
    const auto document = read_ok (R"({"info":{"name":"Team","schema":"https://schema.getpostman.com/json/collection/v2.1.0/"},)"
                                   R"("item":[{"name":"Ping"}]})");
    EXPECT_TRUE (declared_operations_of (document).empty ());
}

TEST (DeclaredOperations, AcceptsSwaggerWrittenAsANumber) {
    // `swagger: 2.0` unquoted is a number in YAML and in JSON alike, and
    // generated documents write it both ways - the renderer's detector takes
    // either, so this one must too or a document imports with no coverage.
    const auto document = read_ok ("swagger: 2.0\npaths:\n  /pets:\n    get:\n "
                                   "     responses:\n        200: {}\n");
    const auto declared = declared_operations_of (document);
    ASSERT_EQ (declared.size (), 1U);
    EXPECT_EQ (declared[0].path, "/pets");
}

TEST (DeclaredOperations, APathItemRefThatResolvesToNothingDropsThePath) {
    // Not an error: an unresolvable ref is one the user has already been told
    // about at import, and one bad path must not cost the document its index.
    const auto document =
    read_ok (R"({"openapi":"3.1.0","paths":{)"
             R"("/gone":{"$ref":"./other.yaml#/Shared"},)"
             R"("/here":{"get":{"operationId":"here","responses":{}}}}})");
    const auto declared = declared_operations_of (document);
    ASSERT_EQ (declared.size (), 1U);
    EXPECT_EQ (declared[0].path, "/here");
}

TEST (DeclaredOperations, FollowsAJsonPointersEscapes) {
    // `~1` is `/` and `~0` is `~`, so a hoisted path item keyed by a path can be
    // pointed at. Getting this wrong drops every operation under such a path.
    const auto document = read_ok (
    R"({"openapi":"3.1.0","paths":{)"
    R"("/pets":{"$ref":"#/components/pathItems/~1pets~0x"}},)"
    R"("components":{"pathItems":{"/pets~x":{"get":{"operationId":"listPets","responses":{}}}}}})");
    const auto declared = declared_operations_of (document);
    ASSERT_EQ (declared.size (), 1U);
    EXPECT_EQ (declared[0].operation_id, "listPets");
}

TEST (DeclaredOperations, AnEmptyOperationIdIsNoIdentity) {
    const auto document = read_ok (
    R"({"openapi":"3.0.0","paths":{"/a":{"get":{"operationId":"","responses":{}}}}})");
    const auto declared = declared_operations_of (document);
    ASSERT_EQ (declared.size (), 1U);
    EXPECT_TRUE (declared[0].operation_id.empty ());
}

// ============================================================================
// The stored index
// ============================================================================

TEST (DeriveSpecIndexes, StoresWhatTheDocumentDeclares) {
    const auto index = derive_spec_indexes (
    R"({"openapi":"3.0.0","paths":{"/pets":{"get":{"operationId":"listPets","responses":{"200":{}}}}}})",
    INDEX_CAP);
    ASSERT_TRUE (index.ok ()) << index.error;
    EXPECT_EQ (json::parse (index.operations),
    json::parse (R"([{"operationId":"listPets","method":"GET","path":"/pets","responses":["200"]}])"));

    // And what is stored reads back as what a run measures against - the two
    // halves of the column, held to each other.
    const auto parsed = vayu::core::parse_declared_operations (index.operations);
    ASSERT_HAS_VALUE (parsed);
    ASSERT_EQ (parsed->size (), 1U);
    EXPECT_EQ ((*parsed)[0].operation_id, "listPets");
    EXPECT_EQ ((*parsed)[0].responses, (std::vector<std::string>{ "200" }));
}

TEST (DeriveSpecIndexes, ADocumentDeclaringNothingStoresNoIndex) {
    // "" is "no index", which a report spells as coverage not measured - not as
    // a contract with no operations in it.
    const auto index =
    derive_spec_indexes (R"({"info":{"name":"Team"},"item":[]})", INDEX_CAP);
    ASSERT_TRUE (index.ok ()) << index.error;
    EXPECT_TRUE (index.operations.empty ());
    EXPECT_TRUE (index.response_schemas.empty ());
}

TEST (DeriveSpecIndexes, RefusesADocumentDeclaringMoreOperationsThanARunMayCarry) {
    std::string document = R"({"openapi":"3.0.0","paths":{)";
    for (size_t i = 0; i <= vayu::core::constants::spec_document::MAX_OPERATIONS; ++i) {
        if (i > 0) {
            document += ",";
        }
        document += "\"/p" + std::to_string (i) + "\":{\"get\":{\"responses\":{}}}";
    }
    document += "}}";

    const auto index = derive_spec_indexes (document, INDEX_CAP);
    EXPECT_FALSE (index.ok ());
    EXPECT_NE (index.error.find ("over the limit"), std::string::npos) << index.error;
}

TEST (DeriveSpecIndexes, AnUnreadableDocumentIsAnErrorRatherThanAnEmptyIndex) {
    const auto index = derive_spec_indexes ("openapi: [3.0.0\n", INDEX_CAP);
    EXPECT_FALSE (index.ok ());
    EXPECT_NE (index.error.find ("Invalid 'content'"), std::string::npos)
    << index.error;
}

// ============================================================================
// The response schema index (issue #860)
// ============================================================================

namespace {

/// The schema index derived from @p document, or `null` for a document that
/// declares none. Every case below states a *document*, because that is the
/// only input the write path has - a translator reachable no other way would be
/// tested somewhere the engine never goes.
json schema_index_of (const std::string& document) {
    const auto index = derive_spec_indexes (document, INDEX_CAP);
    EXPECT_TRUE (index.ok ()) << index.error;
    return index.response_schemas.empty () ? json (nullptr) :
                                             json::parse (index.response_schemas);
}

/// One 3.0 schema, put through the whole derivation and read back out - the
/// dialect translation with a document around it.
json translated (const json& schema) {
    json document = json::parse (
    R"({"openapi":"3.0.0","paths":{"/x":{"get":{"responses":{"200":{"content":{"application/json":{}}}}}}}})");
    document["paths"]["/x"]["get"]["responses"]["200"]["content"]
            ["application/json"]["schema"] = schema;
    const json index                       = schema_index_of (document.dump ());
    EXPECT_FALSE (index.is_null ()) << document.dump ();
    return index["operations"][0]["responses"][0]["schema"];
}

} // namespace

// ─── The dialect translation ────────────────────────────────────────────────

TEST (ResponseSchemas, TurnsNullableIntoAUnionWithNull) {
    // Revert this and a document that says "a string, or null" starts reporting
    // every null it explicitly permits as a type failure - a wrong verdict,
    // which is worse than no verdict.
    const json union_string = { { "type", json::array ({ "string", "null" }) } };
    EXPECT_EQ (translated (json{ { "type", "string" }, { "nullable", true } }), union_string);
    EXPECT_EQ (translated (json{ { "type", json::array ({ "string", "null" }) },
               { "nullable", true } }),
    union_string);
}

TEST (ResponseSchemas, LeavesANullableWithNoTypeAlone) {
    // No `type` means every JSON value was already allowed, null included.
    EXPECT_EQ (translated (json{ { "nullable", true }, { "description", "anything" } }),
    (json{ { "description", "anything" } }));
}

TEST (ResponseSchemas, TranslatesDraft04BooleanExclusiveBoundsIntoDraft07Values) {
    EXPECT_EQ (translated (json{ { "type", "integer" }, { "minimum", 5 },
               { "exclusiveMinimum", true } }),
    (json{ { "type", "integer" }, { "minimum", 5 }, { "exclusiveMinimum", 5 } }));
    // `false` says the bound is inclusive, which draft-07 spells by simply not
    // having the keyword.
    EXPECT_EQ (translated (json{ { "type", "integer" }, { "minimum", 5 },
               { "exclusiveMinimum", false } }),
    (json{ { "type", "integer" }, { "minimum", 5 } }));
    // draft-07's own numeric form is already right and must survive.
    EXPECT_EQ (translated (json{ { "type", "integer" }, { "exclusiveMinimum", 5 } }),
    (json{ { "type", "integer" }, { "exclusiveMinimum", 5 } }));
    EXPECT_EQ (translated (json{ { "maximum", 9 }, { "exclusiveMaximum", true } }),
    (json{ { "maximum", 9 }, { "exclusiveMaximum", 9 } }));
}

TEST (ResponseSchemas, DropsOpenApisOwnVocabulary) {
    EXPECT_EQ (translated (json{ { "type", "object" },
               { "discriminator", { { "propertyName", "kind" } } },
               { "xml", { { "name", "pet" } } }, { "example", { { "id", 1 } } },
               { "externalDocs", { { "url", "https://example.com" } } } }),
    (json{ { "type", "object" } }));
}

TEST (ResponseSchemas, TranslatesThroughEverySubschemaPosition) {
    const json nullable_string = { { "type", "string" }, { "nullable", true } };
    const json union_string = { { "type", json::array ({ "string", "null" }) } };
    EXPECT_EQ (
    translated (json{ { "type", "object" },
    { "properties", { { "a", nullable_string } } }, { "items", nullable_string },
    { "allOf", json::array ({ nullable_string }) }, { "not", nullable_string } }),
    (json{ { "type", "object" }, { "properties", { { "a", union_string } } },
    { "items", union_string }, { "allOf", json::array ({ union_string }) },
    { "not", union_string } }));
}

TEST (ResponseSchemas, KeepsARefAsWrittenRatherThanFollowingIt) {
    // Following it here is what makes a recursive schema infinite; validation
    // resolves pointers against the shared roots instead.
    EXPECT_EQ (translated (json{ { "$ref", "#/components/schemas/Pet" } }),
    (json{ { "$ref", "#/components/schemas/Pet" } }));
}

TEST (ResponseSchemas, CarriesBooleanSchemasThrough) {
    // `false` - "nothing validates here" - is a legal schema and a real thing
    // for a document to declare.
    EXPECT_EQ (translated (json (true)), json (true));
    EXPECT_EQ (translated (json (false)), json (false));
}

TEST (ResponseSchemas, DoesNotTreatAPropertyNamedLikeAKeywordAsAKeyword) {
    // `properties` holds data names. A body field called "nullable" is a field,
    // not a dialect instruction.
    const json schema = { { "type", "object" },
        { "properties", { { "nullable", { { "type", "boolean" } } } } } };
    EXPECT_EQ (translated (schema), schema);
}

TEST (ResponseSchemas, ASchemaThatIsNotOneDeclaresNothingCheckable) {
    // Neither an object nor a boolean: there is nothing a validator could read,
    // and storing the row would put a value in the index no reader can use.
    // Skipped like an absent schema rather than refusing the whole document over
    // one malformed response.
    EXPECT_TRUE (schema_index_of (R"({"openapi":"3.0.0","paths":{"/x":{"get":{"responses":{"200":{"content":)"
                                  R"({"application/json":{"schema":"not a schema"}}}}}}}})")
    .is_null ());
}

// ─── What a 3.x document declares ───────────────────────────────────────────

TEST (ResponseSchemas, KeepsEveryMediaTypeWithTheStatusPatternVerbatim) {
    // Every media type, not just the JSON one: what can be validated is decided
    // at response time by what the server actually sent. A response with no
    // `content` declares nothing to check against.
    const json index = schema_index_of (
    R"({"openapi":"3.0.0","paths":{"/pets":{"get":{"responses":{)"
    R"("200":{"content":{"application/JSON":{"schema":{"type":"object","nullable":true}},)"
    R"("application/xml":{"schema":{"type":"string"}}}},)"
    R"("4XX":{"content":{"application/json":{"schema":{"type":"object"}}}},)"
    R"("304":{"description":"not modified"}}}}}})");
    ASSERT_FALSE (index.is_null ());
    EXPECT_EQ (index["operations"][0]["responses"],
    json::parse (R"([{"status":"200","contentType":"application/json",)"
                 R"("schema":{"type":["object","null"]}},)"
                 R"({"status":"200","contentType":"application/xml","schema":{"type":"string"}},)"
                 R"({"status":"4XX","contentType":"application/json","schema":{"type":"object"}}])"))
    << index.dump ();
}

TEST (ResponseSchemas, SkipsAMediaTypeThatDeclaresNoSchema) {
    // An absent schema is not an empty one: `{}` would validate everything and
    // report a body as matching a contract that never described it.
    EXPECT_TRUE (schema_index_of (R"({"openapi":"3.0.0","paths":{"/pets":{"get":{"responses":{"200":{"content":{"text/plain":{}}}}}}}})")
    .is_null ());
}

/// GitHub's shape: the response body lives in `components.responses` and the
/// operation only points at it (issue #714).
constexpr const char* RESPONSES_IN_COMPONENTS =
R"({"openapi":"3.0.0","paths":{"/repos/{owner}/{repo}":{"get":{"operationId":"repos/get",)"
R"("responses":{"200":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/repo"}}}},)"
R"("404":{"$ref":"#/components/responses/not_found"}}}}},)"
R"("components":{"responses":{"not_found":{"description":"Resource not found",)"
R"("content":{"application/json":{"schema":{"$ref":"#/components/schemas/basic_error"}}}}},)"
R"("schemas":{"repo":{"type":"object"},"basic_error":{"type":"object","nullable":true}}}})";

TEST (ResponseSchemas, ReadsThroughAResponseThatIsItselfARef) {
    // Read unresolved, the `$ref` node has no `content`, so nothing is extracted
    // and a response of that status reports "the spec declares no response for
    // this status" about a status the document declares plainly - while coverage,
    // which reads the status *keys*, counts the very same status as declared.
    const json index = schema_index_of (RESPONSES_IN_COMPONENTS);
    ASSERT_FALSE (index.is_null ());
    EXPECT_EQ (index["operations"][0]["responses"],
    json::parse (R"([{"status":"200","contentType":"application/json","schema":{"$ref":"#/components/schemas/repo"}},)"
                 R"({"status":"404","contentType":"application/json","schema":{"$ref":"#/components/schemas/basic_error"}}])"))
    << index.dump ();
}

TEST (ResponseSchemas, StepsOverARefToAComponentThatDoesNotExist) {
    // Nothing to extract and nothing to throw: the 422 is simply not in the
    // index, which reads as "not checked" rather than as a pass - and the 200
    // beside it still is. A document with one broken ref still imports.
    const json index = schema_index_of (
    R"({"openapi":"3.0.0","paths":{"/pets":{"get":{"responses":{)"
    R"("422":{"$ref":"#/components/responses/gone_missing"},)"
    R"("200":{"content":{"application/json":{"schema":{"type":"array"}}}}}}}}})");
    ASSERT_FALSE (index.is_null ());
    EXPECT_EQ (index["operations"][0]["responses"],
    json::parse (R"([{"status":"200","contentType":"application/json",)"
                 R"("schema":{"type":"array"}}])"))
    << index.dump ();
}

TEST (ResponseSchemas, TheTwoIndexesAgreeAboutWhatOneOperationDeclares) {
    // The point of deriving both from one read (issue #860): every status the
    // schema index carries is one the operation index lists for the same
    // operation. On the shape that found #714 the two used to contradict each
    // other - the operation index read the status key, the extractor read the
    // unresolved `$ref` and saw nothing.
    const auto indexes = derive_spec_indexes (RESPONSES_IN_COMPONENTS, INDEX_CAP);
    ASSERT_TRUE (indexes.ok ()) << indexes.error;
    const json operations = json::parse (indexes.operations);
    const json schemas    = json::parse (indexes.response_schemas);
    ASSERT_EQ (operations.size (), 1u);
    ASSERT_EQ (schemas["operations"].size (), 1u);

    EXPECT_EQ (operations[0]["operationId"], schemas["operations"][0]["operationId"]);
    EXPECT_EQ (operations[0]["method"], schemas["operations"][0]["method"]);
    EXPECT_EQ (operations[0]["path"], schemas["operations"][0]["path"]);
    // Equality, not containment, and the document is chosen so that it can be:
    // every status it declares carries a schema. Drop the read-through and the
    // 404 leaves one index while staying in the other; drop a status from the
    // operation index and the same comparison reddens from the other side.
    std::vector<std::string> with_schemas;
    for (const auto& response : schemas["operations"][0]["responses"]) {
        with_schemas.push_back (response["status"].get<std::string> ());
    }
    EXPECT_EQ (with_schemas, operations[0]["responses"].get<std::vector<std::string>> ())
    << indexes.operations << " vs " << indexes.response_schemas;
}

// ─── What a 2.0 document declares ───────────────────────────────────────────

TEST (ResponseSchemas, PairsEachSwaggerResponseWithTheOperationsProducedMediaTypes) {
    // 2.0 states the media types once for the whole operation and the schema
    // once per response, so one response declares the same schema for each type
    // it produces.
    const json index = schema_index_of (
    R"({"swagger":"2.0","paths":{"/pets":{"get":{"produces":["application/JSON","application/xml"],)"
    R"("responses":{"200":{"schema":{"type":"object"}}}}}}})");
    ASSERT_FALSE (index.is_null ());
    EXPECT_EQ (index["operations"][0]["responses"],
    json::parse (R"([{"status":"200","contentType":"application/json","schema":{"type":"object"}},)"
                 R"({"status":"200","contentType":"application/xml","schema":{"type":"object"}}])"))
    << index.dump ();
}

TEST (ResponseSchemas, FallsBackToTheSwaggerDocumentsProducesThenToJson) {
    const json inherited = schema_index_of (
    R"({"swagger":"2.0","produces":["application/hal+json"],)"
    R"("paths":{"/pets":{"get":{"responses":{"200":{"schema":{"type":"object"}}}}}}})");
    ASSERT_FALSE (inherited.is_null ());
    EXPECT_EQ (inherited["operations"][0]["responses"][0]["contentType"], "application/hal+json");

    const json neither = schema_index_of (
    R"({"swagger":"2.0","paths":{"/pets":{"get":{"responses":{"200":{"schema":{"type":"object"}}}}}}})");
    ASSERT_FALSE (neither.is_null ());
    EXPECT_EQ (neither["operations"][0]["responses"][0]["contentType"], "application/json");
}

TEST (ResponseSchemas, FollowsASwaggerResponseRefIntoTheDocumentsResponsesContainer) {
    // 2.0 spells the same shape one level shallower: `#/responses/X`, not
    // `#/components/responses/X`.
    const json index = schema_index_of (
    R"({"swagger":"2.0","paths":{"/pets":{"get":{"responses":{)"
    R"("404":{"$ref":"#/responses/NotFound"},"410":{"$ref":"#/responses/Missing"}}}}},)"
    R"("responses":{"NotFound":{"description":"gone","schema":{"$ref":"#/definitions/Error"}}},)"
    R"("definitions":{"Error":{"type":"object"}}})");
    ASSERT_FALSE (index.is_null ());
    EXPECT_EQ (index["operations"][0]["responses"],
    json::parse (R"([{"status":"404","contentType":"application/json",)"
                 R"("schema":{"$ref":"#/definitions/Error"}}])"))
    << index.dump ();
}

// ─── The roots a `$ref` resolves through ────────────────────────────────────

TEST (ResponseSchemas, CarriesTheSubtreesARefCanPointIntoTranslated) {
    // Translated *per schema*: running the translation over the container would
    // walk no further than the container, which is how a `$ref`-ed 3.0 schema
    // kept its `nullable` and produced a wrong verdict for every null the
    // document permits.
    const json index = schema_index_of (RESPONSES_IN_COMPONENTS);
    ASSERT_FALSE (index.is_null ());
    EXPECT_EQ (index["refRoots"],
    json::parse (R"({"components":{"schemas":{"repo":{"type":"object"},)"
                 R"("basic_error":{"type":["object","null"]}}}})"))
    << index.dump ();
    // `components.responses` is not carried: a schema `$ref` resolves to a
    // schema, so nothing in the index can point at it, and it is pure weight
    // against the byte cap the index shares with the document.
    EXPECT_FALSE (index["refRoots"]["components"].contains ("responses"))
    << index.dump ();
}

TEST (ResponseSchemas, CarriesSwaggerDefinitionsAndTheBundlersInlinedFiles) {
    const json index = schema_index_of (
    R"({"swagger":"2.0","paths":{"/pets":{"get":{"responses":{"200":{"schema":{"type":"object"}}}}}},)"
    R"("definitions":{"Pet":{"type":"object","nullable":true}},)"
    R"("x-vayu-bundled":{"schemas-pet-yaml":{"type":"object","nullable":true},)"
    R"("common-yaml":{"components":{"schemas":{"Tag":{"type":"string","nullable":true}}}}}})");
    ASSERT_FALSE (index.is_null ());
    // A bundled file carrying neither container *is* a schema document and is
    // translated as one; one that carries its own components is reduced by this
    // same rule, because a ref into it keeps that document's shape.
    EXPECT_EQ (index["refRoots"],
    json::parse (R"({"definitions":{"Pet":{"type":["object","null"]}},)"
                 R"("x-vayu-bundled":{"schemas-pet-yaml":{"type":["object","null"]},)"
                 R"("common-yaml":{"components":{"schemas":{"Tag":{"type":["string","null"]}}}}}})"))
    << index.dump ();
}

TEST (ResponseSchemas, ADocumentWithNoRootsStoresNoRefRootsAtAll) {
    const json index = schema_index_of (
    R"({"openapi":"3.0.0","paths":{"/pets":{"get":{"responses":{"200":)"
    R"({"content":{"application/json":{"schema":{"type":"object"}}}}}}}}})");
    ASSERT_FALSE (index.is_null ());
    EXPECT_FALSE (index.contains ("refRoots")) << index.dump ();
}

// ─── The stored index ───────────────────────────────────────────────────────

TEST (DeriveSpecIndexes, IndexesOnlyTheOperationsThatDeclareSomething) {
    const json index = schema_index_of (
    R"({"openapi":"3.0.0","paths":{"/pets":{)"
    R"("get":{"operationId":"listPets","responses":{"200":{"content":{"application/json":)"
    R"({"schema":{"type":"array"}}}}}},)"
    R"("post":{"operationId":"addPet","responses":{"201":{"description":"created"}}}}}})");
    ASSERT_FALSE (index.is_null ());
    ASSERT_EQ (index["operations"].size (), 1u) << index.dump ();
    EXPECT_EQ (index["operations"][0]["operationId"], "listPets");
    EXPECT_EQ (index["operations"][0]["method"], "GET");
}

TEST (DeriveSpecIndexes, ADocumentWhereNothingDeclaresASchemaStoresNoSchemaIndex) {
    // "No index" and "declares nothing" are stored the same way, and the honest
    // reading of a document nothing was extracted from is the first: a response
    // of it reports `checked: false`, never a body that passed.
    const auto index = derive_spec_indexes (
    R"({"openapi":"3.0.0","paths":{"/pets":{"get":{"responses":{"200":{}}}}}})", INDEX_CAP);
    ASSERT_TRUE (index.ok ()) << index.error;
    EXPECT_FALSE (index.operations.empty ())
    << "the document does declare an operation";
    EXPECT_TRUE (index.response_schemas.empty ());
}

TEST (DeriveSpecIndexes, TheSchemaIndexIdentityIsTheOperationIndexIdentity) {
    // Including #715's rule: a repeated `operationId` names nothing, so the
    // second operation carries only what it can still state unambiguously. Both
    // indexes come off one walk, so neither can stamp an id the other refused.
    const json index = schema_index_of (
    R"({"openapi":"3.0.0","paths":{)"
    R"("/a":{"get":{"operationId":"dup","responses":{"200":{"content":{"application/json":)"
    R"({"schema":{"type":"object"}}}}}}},)"
    R"("/b":{"get":{"operationId":"dup","responses":{"200":{"content":{"application/json":)"
    R"({"schema":{"type":"object"}}}}}}}}})");
    ASSERT_FALSE (index.is_null ());
    ASSERT_EQ (index["operations"].size (), 2u) << index.dump ();
    EXPECT_EQ (index["operations"][0]["operationId"], "dup");
    EXPECT_FALSE (index["operations"][1].contains ("operationId")) << index.dump ();
    EXPECT_EQ (index["operations"][1]["path"], "/b");
}

TEST (DeriveSpecIndexes, RefusesASchemaIndexOverTheCapNamingBothNumbers) {
    // The document passed its own cap and its schemas did not - a document whose
    // `components` are most of its bytes indexes to nearly its own size again.
    // Named rather than truncated: an index silently cut short reports a body as
    // unchecked with no reason a user can act on.
    const auto index = derive_spec_indexes (
    R"({"openapi":"3.0.0","paths":{"/pets":{"get":{"responses":{"200":)"
    R"({"content":{"application/json":{"schema":{"type":"object"}}}}}}}}})",
    /*index_cap=*/10);
    EXPECT_FALSE (index.ok ());
    EXPECT_NE (index.error.find ("over the limit of 10"), std::string::npos)
    << index.error;
    EXPECT_NE (index.error.find ("maxSpecDocumentBytes"), std::string::npos)
    << index.error;
}

TEST (DeriveSpecIndexes, ADocumentNestingPastTheDepthBoundIsRefusedAsJsonToo) {
    // The YAML walk enforced this as it converted and the JSON branch did not,
    // which was survivable while nothing recursed over a document's own
    // subtrees. The schema translation does.
    const size_t depth = vayu::core::constants::spec_document::MAX_READ_DEPTH + 2;
    std::string document = R"({"openapi":"3.0.0","paths":{"/x":{"get":{"responses":{"200":)"
                           R"({"content":{"application/json":{"schema":)";
    for (size_t i = 0; i < depth; ++i) {
        document += R"({"properties":{"a":)";
    }
    document += "{}";
    for (size_t i = 0; i < depth; ++i) {
        document += "}}";
    }
    // The eight the wrapper above opened: `application/json`, `content`, the
    // status, `responses`, the method, the path, `paths`, the document.
    document += "}}}}}}}}";

    const auto index = derive_spec_indexes (document, INDEX_CAP);
    EXPECT_FALSE (index.ok ())
    << "a document nesting " << depth << " levels deep must not be read at all";
    EXPECT_NE (index.error.find ("nests deeper"), std::string::npos) << index.error;
}

TEST (DeriveSpecIndexes, TheDerivedIndexIsWhatValidationThenReads) {
    // The mutation check the whole translation exists for: revert `nullable`
    // handling and this body - a null the document explicitly permits - is
    // reported as a type failure, which is a *wrong* verdict rather than a
    // missing one.
    const auto index = derive_spec_indexes (
    R"({"openapi":"3.0.0","paths":{"/pets/{petId}":{"get":{"operationId":"getPet",)"
    R"("responses":{"200":{"content":{"application/json":{"schema":)"
    R"({"type":"object","properties":{"name":{"type":"string","nullable":true}}}}}}}}}}})",
    INDEX_CAP);
    ASSERT_TRUE (index.ok ()) << index.error;

    const auto parsed = vayu::core::ResponseSchemaIndex::parse (index.response_schemas);
    ASSERT_HAS_VALUE (parsed) << "the engine's own index must parse back";
    const auto verdict =
    parsed->check (R"({"operationId":"getPet","method":"GET","path":"/pets/{petId}"})",
    200, "application/json", R"({"name":null})");
    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid)
    << "a null the document permits is not a failure";
}
