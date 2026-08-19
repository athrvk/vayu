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
 * The **index** faces a subtler failure: nothing crashes when it disagrees with
 * the identity the renderer's importer stamps on a request - coverage simply
 * credits the wrong operation, or none. The shared fixture
 * (`fixtures/declared-operations-conformance.json`, read by
 * `app/src/services/openapi/declared-operations.conformance.test.ts` too) is
 * what turns that into a failing test on one side or the other.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/core/constants.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/core/spec_coverage.hpp"

namespace {

using nlohmann::json;
using vayu::core::declared_operations_of;
using vayu::core::DeclaredOperation;
using vayu::core::derive_operations_index;
using vayu::core::read_document;

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
    const auto as_json = read_ok (R"({"openapi":"3.0.0","info":{"title":"Pets"},)"
                                  R"("paths":{"/pets":{"get":{"operationId":"listPets"}}}})");
    const auto as_yaml = read_ok ("openapi: \"3.0.0\"\n"
                                  "info:\n  title: Pets\n"
                                  "paths:\n  /pets:\n    get:\n      operationId: listPets\n");
    EXPECT_EQ (as_json, as_yaml);
}

TEST (OpenApiDocumentRead, KeepsMappingKeysInDocumentOrder) {
    // The promise `DeclaredOperation` makes about `responses` - and the one the
    // renderer could not keep, because a JavaScript object sorts integer-like
    // keys numerically ahead of everything else, so `{404, 200}` reached the
    // store as `200, 404`.
    const auto document = read_ok ("responses:\n  404: {}\n  200: {}\n  default: {}\n");
    EXPECT_EQ (keys_of (document["responses"]), (std::vector<std::string>{ "404", "200", "default" }));
}

TEST (OpenApiDocumentRead, TurnsEveryKeyIntoText) {
    // `200:` in YAML is an integer key. A status pattern is text on both sides
    // of the wire, and `match_status_pattern` compares strings.
    const auto document = read_ok ("responses:\n  200: ok\n  true: yes\n");
    EXPECT_EQ (keys_of (document["responses"]), (std::vector<std::string>{ "200", "true" }));
}

TEST (OpenApiDocumentRead, TypesPlainScalarsLikeJsYamlsCoreSchema) {
    const auto document = read_ok ("a: null\nb: ~\nc: true\nd: FALSE\ne: 42\nf: -7\n"
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
    const auto document = read_ok ("swagger: \"2.0\"\nversion: '1.0'\nport: 8080\n");
    EXPECT_EQ (document["swagger"], "2.0");
    EXPECT_TRUE (document["swagger"].is_string ());
    EXPECT_EQ (document["version"], "1.0");
    EXPECT_TRUE (document["version"].is_string ());
    EXPECT_EQ (document["port"], 8080);
}

TEST (OpenApiDocumentRead, ExpandsAnAlias) {
    const auto document = read_ok ("base: &b\n  description: shared\npaths:\n  /a: *b\n");
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

TEST (OpenApiDocumentRead, MergesASequenceOfSourcesEarliestFirst) {
    const auto document = read_ok ("b1: &b1 {a: 1}\nb2: &b2 {a: 2, z: 9}\nx:\n  <<: [*b1, *b2]\n");
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
    const std::string bomb = "a: &a [\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\"]\n"
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
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "tests" /
    "fixtures" / "declared-operations-conformance.json";
    std::ifstream in (path);
    ASSERT_TRUE (in.good ()) << "fixture missing: " << path;
    const json fixture = json::parse (in);
    ASSERT_FALSE (fixture["cases"].empty ()) << "a fixture with no cases asserts nothing";

    for (const auto& fixture_case : fixture["cases"]) {
        const auto name     = fixture_case["name"].get<std::string> ();
        const auto document = read_document (fixture_case["document"].get<std::string> ());
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
    const auto document = read_ok ("swagger: 2.0\npaths:\n  /pets:\n    get:\n      responses:\n        200: {}\n");
    const auto declared = declared_operations_of (document);
    ASSERT_EQ (declared.size (), 1U);
    EXPECT_EQ (declared[0].path, "/pets");
}

TEST (DeclaredOperations, APathItemRefThatResolvesToNothingDropsThePath) {
    // Not an error: an unresolvable ref is one the user has already been told
    // about at import, and one bad path must not cost the document its index.
    const auto document = read_ok (R"({"openapi":"3.1.0","paths":{)"
                                   R"("/gone":{"$ref":"./other.yaml#/Shared"},)"
                                   R"("/here":{"get":{"operationId":"here","responses":{}}}}})");
    const auto declared = declared_operations_of (document);
    ASSERT_EQ (declared.size (), 1U);
    EXPECT_EQ (declared[0].path, "/here");
}

TEST (DeclaredOperations, FollowsAJsonPointersEscapes) {
    // `~1` is `/` and `~0` is `~`, so a hoisted path item keyed by a path can be
    // pointed at. Getting this wrong drops every operation under such a path.
    const auto document = read_ok (R"({"openapi":"3.1.0","paths":{)"
                                   R"("/pets":{"$ref":"#/components/pathItems/~1pets~0x"}},)"
                                   R"("components":{"pathItems":{"/pets~x":{"get":{"operationId":"listPets","responses":{}}}}}})");
    const auto declared = declared_operations_of (document);
    ASSERT_EQ (declared.size (), 1U);
    EXPECT_EQ (declared[0].operation_id, "listPets");
}

TEST (DeclaredOperations, AnEmptyOperationIdIsNoIdentity) {
    const auto document = read_ok (R"({"openapi":"3.0.0","paths":{"/a":{"get":{"operationId":"","responses":{}}}}})");
    const auto declared = declared_operations_of (document);
    ASSERT_EQ (declared.size (), 1U);
    EXPECT_TRUE (declared[0].operation_id.empty ());
}

// ============================================================================
// The stored index
// ============================================================================

TEST (DeriveOperationsIndex, StoresWhatTheDocumentDeclares) {
    const auto index = derive_operations_index (
    R"({"openapi":"3.0.0","paths":{"/pets":{"get":{"operationId":"listPets","responses":{"200":{}}}}}})");
    ASSERT_TRUE (index.ok ()) << index.error;
    EXPECT_EQ (json::parse (index.stored),
    json::parse (R"([{"operationId":"listPets","method":"GET","path":"/pets","responses":["200"]}])"));

    // And what is stored reads back as what a run measures against - the two
    // halves of the column, held to each other.
    const auto parsed = vayu::core::parse_declared_operations (index.stored);
    ASSERT_TRUE (parsed.has_value ());
    ASSERT_EQ (parsed->size (), 1U);
    EXPECT_EQ ((*parsed)[0].operation_id, "listPets");
    EXPECT_EQ ((*parsed)[0].responses, (std::vector<std::string>{ "200" }));
}

TEST (DeriveOperationsIndex, ADocumentDeclaringNothingStoresNoIndex) {
    // "" is "no index", which a report spells as coverage not measured - not as
    // a contract with no operations in it.
    const auto index = derive_operations_index (R"({"info":{"name":"Team"},"item":[]})");
    ASSERT_TRUE (index.ok ()) << index.error;
    EXPECT_TRUE (index.stored.empty ());
}

TEST (DeriveOperationsIndex, RefusesADocumentDeclaringMoreOperationsThanARunMayCarry) {
    std::string document = R"({"openapi":"3.0.0","paths":{)";
    for (size_t i = 0; i <= vayu::core::constants::spec_document::MAX_OPERATIONS; ++i) {
        if (i > 0) {
            document += ",";
        }
        document += "\"/p" + std::to_string (i) + "\":{\"get\":{\"responses\":{}}}";
    }
    document += "}}";

    const auto index = derive_operations_index (document);
    EXPECT_FALSE (index.ok ());
    EXPECT_NE (index.error.find ("over the limit"), std::string::npos) << index.error;
}

TEST (DeriveOperationsIndex, AnUnreadableDocumentIsAnErrorRatherThanAnEmptyIndex) {
    const auto index = derive_operations_index ("openapi: [3.0.0\n");
    EXPECT_FALSE (index.ok ());
    EXPECT_NE (index.error.find ("Invalid 'content'"), std::string::npos) << index.error;
}
