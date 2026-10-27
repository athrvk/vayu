/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/schema_validation_test.cpp
 * @brief Response schema validation (issue #628).
 *
 * The cases that matter here are the ones where a wrong answer is *quiet*: a
 * body reported clean because the keyword forbidding it was never evaluated, a
 * `$ref` that resolved to nothing, a verdict that says `valid: false` when
 * nothing was checked at all. Each of those has a test that fails if the
 * guarding line is removed.
 */

#include "nested_json.hpp"
#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/openapi_document.hpp"
#include "vayu/core/schema_validation.hpp"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

using nlohmann::json;
using namespace vayu::core;

namespace {

/// The stored `response_schemas` text for one operation declaring one response.
std::string one_operation_index (const json& schema,
const std::string& status       = "200",
const std::string& content_type = "application/json",
const json& ref_roots           = json::object ()) {
    json index;
    index["refRoots"]   = ref_roots;
    index["operations"] = json::array (
    { json{ { "operationId", "getPet" }, { "method", "GET" }, { "path", "/pets/{petId}" },
    { "responses",
    json::array ({ json{ { "status", status }, { "contentType", content_type },
    { "schema", schema } } }) } } });
    return index.dump ();
}

/// The most a derived index may hold; far above anything these documents reach.
constexpr size_t INDEX_CAP = size_t{ 1024 } * 1024;

const char* const GET_PET = R"({"operationId":"getPet","method":"GET","path":"/pets/{petId}"})";

json pet_schema () {
    return json::parse (R"({
        "type": "object",
        "required": ["id", "name"],
        "properties": {"id": {"type": "integer"}, "name": {"type": "string"}}
    })");
}

} // namespace

// ─── The verdict shape ──────────────────────────────────────────────────────

TEST (SchemaValidationPayloadTest, UncheckedCarriesAReasonAndNoValidity) {
    ValidationVerdict verdict;
    verdict.reason = UncheckedReason::NoSchemaForStatus;

    const auto node = build_validation_payload (verdict);
    EXPECT_FALSE (node["checked"].get<bool> ());
    EXPECT_EQ (node["reason"].get<std::string> (), "no_schema_for_status");
    // The point of the whole node: an unchecked response must not carry a
    // validity a reader would render as a contract failure.
    EXPECT_FALSE (node.contains ("valid"));
}

TEST (SchemaValidationPayloadTest, CheckedAlwaysCarriesTheTotal) {
    ValidationVerdict verdict;
    verdict.checked        = true;
    verdict.valid          = true;
    verdict.failures_total = 0;

    const auto node = build_validation_payload (verdict);
    EXPECT_TRUE (node["checked"].get<bool> ());
    EXPECT_TRUE (node["valid"].get<bool> ());
    // Present even at zero: a reader comparing the shown list against the total
    // needs the number to be there to compare with.
    ASSERT_TRUE (node.contains ("failuresTotal"));
    EXPECT_EQ (node["failuresTotal"].get<size_t> (), 0u);
}

// ─── Matching ───────────────────────────────────────────────────────────────

TEST (ResponseSchemaIndexTest, ValidBodyPasses) {
    const auto index = ResponseSchemaIndex::parse (one_operation_index (pet_schema ()));
    ASSERT_HAS_VALUE (index);

    const auto verdict =
    index->check (GET_PET, 200, "application/json", R"({"id":1,"name":"Rex"})");
    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid);
    EXPECT_EQ (verdict.failures_total, 0u);
    EXPECT_EQ (verdict.matched_status, "200");
    EXPECT_EQ (verdict.matched_content_type, "application/json");
}

TEST (ResponseSchemaIndexTest, InvalidBodyFailsAndNamesWhere) {
    const auto index = ResponseSchemaIndex::parse (one_operation_index (pet_schema ()));
    ASSERT_HAS_VALUE (index);

    const auto verdict = index->check (GET_PET, 200, "application/json", R"({"id":"one"})");
    EXPECT_TRUE (verdict.checked);
    EXPECT_FALSE (verdict.valid);
    ASSERT_FALSE (verdict.failures.empty ());
    EXPECT_GE (verdict.failures_total, 1u);
    // The path locates the problem inside the body, which is the whole value of
    // a failure over a boolean.
    bool named_id = false;
    for (const auto& failure : verdict.failures) {
        if (failure.path.find ("id") != std::string::npos) {
            named_id = true;
        }
    }
    EXPECT_TRUE (named_id);
}

TEST (ResponseSchemaIndexTest, ContentTypeParametersAreIgnored) {
    const auto index = ResponseSchemaIndex::parse (one_operation_index (pet_schema ()));
    ASSERT_HAS_VALUE (index);

    const auto verdict = index->check (
    GET_PET, 200, "application/json; charset=utf-8", R"({"id":1,"name":"Rex"})");
    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid);
}

TEST (ResponseSchemaIndexTest, ExactStatusWinsOverARange) {
    json index;
    index["operations"] = json::array (
    { json{ { "operationId", "getPet" }, { "method", "GET" }, { "path", "/pets/{petId}" },
    { "responses",
    json::array ({ json{ { "status", "2XX" }, { "contentType", "application/json" },
                   { "schema", json{ { "type", "string" } } } },
    json{ { "status", "200" }, { "contentType", "application/json" },
    { "schema", json{ { "type", "object" } } } } }) } } });

    const auto parsed = ResponseSchemaIndex::parse (index.dump ());
    ASSERT_HAS_VALUE (parsed);

    // The object passes only if the `200` schema was chosen; the `2XX` one
    // demands a string. Two distinct promises, and 200 answers the specific one.
    const auto verdict = parsed->check (GET_PET, 200, "application/json", R"({"id":1})");
    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid);
    EXPECT_EQ (verdict.matched_status, "200");
}

TEST (ResponseSchemaIndexTest, RangeAndDefaultAnswerWhenNothingExactDoes) {
    const auto ranged =
    ResponseSchemaIndex::parse (one_operation_index (pet_schema (), "2XX"));
    ASSERT_HAS_VALUE (ranged);
    EXPECT_EQ (
    ranged->check (GET_PET, 201, "application/json", R"({"id":1,"name":"a"})").matched_status,
    "2XX");

    const auto fallback =
    ResponseSchemaIndex::parse (one_operation_index (pet_schema (), "default"));
    ASSERT_HAS_VALUE (fallback);
    EXPECT_EQ (
    fallback->check (GET_PET, 503, "application/json", R"({"id":1,"name":"a"})").matched_status,
    "default");
}

TEST (ResponseSchemaIndexTest, AWildcardMediaTypeAnswersWhenNothingExactDoes) {
    const auto index =
    ResponseSchemaIndex::parse (one_operation_index (pet_schema (), "200", "*/*"));
    ASSERT_HAS_VALUE (index);

    const auto verdict =
    index->check (GET_PET, 200, "application/hal+json", R"({"id":1,"name":"Rex"})");
    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid);
}

TEST (ResponseSchemaIndexTest, EveryUncheckableCaseNamesItself) {
    const auto index = ResponseSchemaIndex::parse (one_operation_index (pet_schema ()));
    ASSERT_HAS_VALUE (index);
    const std::string body = R"({"id":1,"name":"Rex"})";

    // Not an operation at all.
    auto verdict = index->check ("", 200, "application/json", body);
    EXPECT_FALSE (verdict.checked);
    ASSERT_HAS_VALUE (verdict.reason);
    EXPECT_EQ (*verdict.reason, UncheckedReason::NoOperation);

    // An identity the document does not declare.
    verdict = index->check (
    R"({"method":"GET","path":"/ghosts"})", 200, "application/json", body);
    ASSERT_HAS_VALUE (verdict.reason);
    EXPECT_EQ (*verdict.reason, UncheckedReason::OperationNotDeclared);

    // A status nothing covers.
    verdict = index->check (GET_PET, 404, "application/json", body);
    ASSERT_HAS_VALUE (verdict.reason);
    EXPECT_EQ (*verdict.reason, UncheckedReason::NoSchemaForStatus);

    // A media type nothing declares.
    verdict = index->check (GET_PET, 200, "text/html", body);
    ASSERT_HAS_VALUE (verdict.reason);
    EXPECT_EQ (*verdict.reason, UncheckedReason::NoSchemaForContentType);

    // A transport error is not a status the contract failed to declare.
    verdict = index->check (GET_PET, 0, "", "");
    ASSERT_HAS_VALUE (verdict.reason);
    EXPECT_EQ (*verdict.reason, UncheckedReason::NoResponse);

    // A body no JSON Schema can speak about.
    verdict = index->check (GET_PET, 200, "application/json", "<html></html>");
    ASSERT_HAS_VALUE (verdict.reason);
    EXPECT_EQ (*verdict.reason, UncheckedReason::BodyNotJson);
}

TEST (ResponseSchemaIndexTest, IdentityResolvesByOperationIdBeforeThePath) {
    // The path moved and the operationId did not: the document still describes
    // this request, and following the operationId is what says so.
    const auto index = ResponseSchemaIndex::parse (one_operation_index (pet_schema ()));
    ASSERT_HAS_VALUE (index);

    const auto verdict =
    index->check (R"({"operationId":"getPet","method":"GET","path":"/v2/pets/{petId}"})",
    200, "application/json", R"({"id":1,"name":"Rex"})");
    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid);
}

TEST (ResponseSchemaIndexTest, AnAbsentIndexIsNotAnEmptyContract) {
    EXPECT_FALSE (ResponseSchemaIndex::parse ("").has_value ());
    EXPECT_FALSE (ResponseSchemaIndex::parse ("not json").has_value ());
    EXPECT_FALSE (ResponseSchemaIndex::parse ("[]").has_value ());
    EXPECT_FALSE (ResponseSchemaIndex::parse (R"({"operations":"nope"})").has_value ());
}

TEST (ResponseSchemaIndexTest, OneUnusableRowDoesNotCostTheDocumentItsIndex) {
    json index;
    index["operations"] = json::array ({ json{ { "path", "/pets" } }, // no method
    json{ { "operationId", "getPet" }, { "method", "GET" }, { "path", "/pets/{petId}" },
    { "responses",
    json::array ({ json{ { "status", "200" },
    { "contentType", "application/json" }, { "schema", pet_schema () } } }) } } });

    const auto parsed = ResponseSchemaIndex::parse (index.dump ());
    ASSERT_HAS_VALUE (parsed);
    EXPECT_EQ (parsed->size (), 1u);
    EXPECT_TRUE (
    parsed->check (GET_PET, 200, "application/json", R"({"id":1,"name":"a"})").checked);
}

// ─── Shared ref roots ───────────────────────────────────────────────────────

TEST (ResponseSchemaRefTest, RefsResolveThroughTheSharedRoots) {
    const auto ref_roots = json::parse (R"({"components": {"schemas": {
        "Pet": {"type":"object","required":["tag"],
                "properties":{"tag":{"$ref":"#/components/schemas/Tag"}}},
        "Tag": {"type":"object","required":["name"],
                "properties":{"name":{"type":"string"}}}
    }}})");
    const auto index     = ResponseSchemaIndex::parse (
    one_operation_index (json::parse (R"({"$ref":"#/components/schemas/Pet"})"),
    "200", "application/json", ref_roots));
    ASSERT_HAS_VALUE (index);

    // Nested through two refs - the assertion that reddens if the shared roots
    // stop being merged in, because an unresolvable `$ref` validates nothing.
    const auto bad =
    index->check (GET_PET, 200, "application/json", R"({"tag":{"name":42}})");
    EXPECT_TRUE (bad.checked);
    EXPECT_FALSE (bad.valid);

    const auto good =
    index->check (GET_PET, 200, "application/json", R"({"tag":{"name":"good"}})");
    EXPECT_TRUE (good.valid);
}

TEST (ResponseSchemaRefTest, ARecursiveSchemaTerminates) {
    const auto ref_roots = json::parse (R"({"components": {"schemas": {
        "Node": {"type":"object","required":["name"],
                 "properties":{"name":{"type":"string"},
                               "child":{"$ref":"#/components/schemas/Node"}}}
    }}})");
    const auto index     = ResponseSchemaIndex::parse (
    one_operation_index (json::parse (R"({"$ref":"#/components/schemas/Node"})"),
    "200", "application/json", ref_roots));
    ASSERT_HAS_VALUE (index);

    const auto verdict = index->check (GET_PET, 200, "application/json",
    R"({"name":"a","child":{"name":"b","child":{"name":"c"}}})");
    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid);
}

// ─── A body nested past the bound is not JSON ───────────────────────────────

namespace {

constexpr size_t BODY_DEPTH = constants::elements::MAX_BODY_DEPTH;

/// Checks @p body against a schema every nesting of `a` satisfies, so the
/// depth bound is the only thing that can turn a deep body into a non-verdict.
ValidationVerdict check_against_any_depth (const std::string& body) {
    const auto ref_roots = json::parse (R"({"components": {"schemas": {
        "Any": {"additionalProperties":{"$ref":"#/components/schemas/Any"}}
    }}})");
    const auto index     = ResponseSchemaIndex::parse (
    one_operation_index (json::parse (R"({"$ref":"#/components/schemas/Any"})"),
    "200", "application/json", ref_roots));
    if (!index) {
        ADD_FAILURE () << "the any-depth schema did not index";
        return {};
    }
    return index->check (GET_PET, 200, "application/json", body);
}

} // namespace

TEST (ResponseSchemaDepthTest, ABodyAtTheBoundIsValidated) {
    const auto verdict =
    check_against_any_depth (vayu::tests::nested_object_text (BODY_DEPTH, "1"));
    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid);
}

TEST (ResponseSchemaDepthTest, ABodyOneLevelPastTheBoundIsNotJson) {
    const auto verdict =
    check_against_any_depth (vayu::tests::nested_object_text (BODY_DEPTH + 1, "1"));
    EXPECT_FALSE (verdict.checked);
    ASSERT_HAS_VALUE (verdict.reason);
    EXPECT_EQ (*verdict.reason, UncheckedReason::BodyNotJson);
}

// ─── Dialect honesty ────────────────────────────────────────────────────────

TEST (SchemaDialectTest, UnevaluatedKeywordsAreNamedAndCounted) {
    const auto schema = json::parse (R"({
        "type": "object",
        "properties": {"a": {"type": "string"}},
        "unevaluatedProperties": false,
        "allOf": [{"prefixItems": [{"type": "string"}]}]
    })");
    const auto found  = collect_unevaluated_keywords (schema, json::object ());

    std::map<std::string, size_t> by_name (found.begin (), found.end ());
    EXPECT_EQ (by_name["unevaluatedProperties"], 1u);
    EXPECT_EQ (by_name["prefixItems"], 1u);
}

TEST (SchemaDialectTest, AnUnevaluatedKeywordRidesTheVerdictOfACleanBody) {
    // The case this disclosure exists for: the body passes *because* the
    // keyword forbidding it was never evaluated. Silence here would report a
    // contract as met that was never fully read.
    const auto schema  = json::parse (R"({
        "type": "object",
        "properties": {"a": {"type": "string"}},
        "unevaluatedProperties": false
    })");
    const auto verdict = validate_body_against_schema (
    schema, json::object (), json::parse (R"({"a":"x","b":1})"));

    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid);
    ASSERT_EQ (verdict.unevaluated_keywords.size (), 1u);
    EXPECT_EQ (verdict.unevaluated_keywords.front ().first, "unevaluatedProperties");

    const auto node = build_validation_payload (verdict);
    ASSERT_TRUE (node.contains ("unevaluatedKeywords"));
    EXPECT_EQ (node["unevaluatedKeywords"][0]["keyword"].get<std::string> (),
    "unevaluatedProperties");
}

TEST (SchemaDialectTest, APropertyNamedLikeAKeywordIsNotAKeyword) {
    // `properties` holds data names, not keywords. Walking it as if its keys
    // were keywords would report a dialect gap for a body field a document is
    // perfectly entitled to call "nullable".
    const auto schema = json::parse (R"({
        "type": "object",
        "properties": {"nullable": {"type": "boolean"},
                       "unevaluatedProperties": {"type": "string"}}
    })");
    EXPECT_TRUE (collect_unevaluated_keywords (schema, json::object ()).empty ());
}

TEST (SchemaDialectTest, KeywordsAreFoundThroughRefsAndCyclesTerminate) {
    const auto ref_roots = json::parse (R"({"components": {"schemas": {
        "Node": {"type":"object",
                 "unevaluatedProperties": false,
                 "properties": {"child": {"$ref": "#/components/schemas/Node"}}}
    }}})");
    const auto found     = collect_unevaluated_keywords (
    json::parse (R"({"$ref":"#/components/schemas/Node"})"), ref_roots);

    ASSERT_EQ (found.size (), 1u);
    EXPECT_EQ (found.front ().first, "unevaluatedProperties");
}

TEST (SchemaDialectTest, AnOpenApiKeywordThatSurvivedExtractionIsDisclosed) {
    // `nullable` is OpenAPI 3.0's, not JSON Schema's: the app normalises it
    // away when it extracts. One arriving here means that normalisation missed
    // a case, and disclosing it is what keeps the miss from reading as a body
    // that simply failed its type.
    const auto schema = json::parse (R"({"type":"string","nullable":true})");
    const auto found  = collect_unevaluated_keywords (schema, json::object ());

    ASSERT_EQ (found.size (), 1u);
    EXPECT_EQ (found.front ().first, "nullable");
}

TEST (SchemaValidationNullableTest, ANullableObjectBesideAllOfAcceptsNullEndToEnd) {
    // The usual 3.0 spelling of a nullable object (#1895). Revert the union in
    // `apply_nullable` and the `null` below is reported as a type failure.
    const auto indexes = derive_spec_indexes (
    R"({"openapi":"3.0.0","paths":{"/pets/{petId}":{"get":{"operationId":"getPet",)"
    R"("responses":{"200":{"content":{"application/json":{"schema":)"
    R"({"type":"object","properties":{"owner":{"nullable":true,)"
    R"("allOf":[{"$ref":"#/components/schemas/Owner"}]}}}}}}}}}},)"
    R"("components":{"schemas":{"Owner":{"type":"object"}}}})",
    INDEX_CAP);
    ASSERT_TRUE (indexes.ok ()) << indexes.error;

    const auto index = ResponseSchemaIndex::parse (indexes.response_schemas);
    ASSERT_HAS_VALUE (index);

    const auto null_owner =
    index->check (GET_PET, 200, "application/json", R"({"owner":null})");
    EXPECT_TRUE (null_owner.checked);
    EXPECT_TRUE (null_owner.valid)
    << "a null the document permits is not a failure";

    const auto wrong_type =
    index->check (GET_PET, 200, "application/json", R"({"owner":5})");
    EXPECT_TRUE (wrong_type.checked);
    EXPECT_FALSE (wrong_type.valid)
    << "the union must not turn the schema into a free pass";
}

// ─── Bounds ─────────────────────────────────────────────────────────────────

TEST (SchemaValidationBoundsTest, FailuresAreCappedAndTheTotalStaysHonest) {
    json properties = json::object ();
    json required   = json::array ();
    for (int i = 0; i < 30; ++i) {
        const auto name  = "f" + std::to_string (i);
        properties[name] = json{ { "type", "string" } };
        required.push_back (name);
    }
    const json schema{ { "type", "object" }, { "properties", properties },
        { "required", required } };

    const auto verdict =
    validate_body_against_schema (schema, json::object (), json::parse ("{}"));

    EXPECT_TRUE (verdict.checked);
    EXPECT_FALSE (verdict.valid);
    EXPECT_LE (verdict.failures.size (), constants::schema_validation::MAX_FAILURES);
    // The list is bounded; the count is not. A shortened list that also
    // shortened the count would read as a body with ten problems.
    EXPECT_GE (verdict.failures_total, 30u);
}

TEST (SchemaValidationBoundsTest, AFailureMessageIsBounded) {
    const json schema{ { "type", "object" },
        { "properties", json{ { "a", json{ { "type", "integer" } } } } } };
    const json body{ { "a", std::string (5000, 'x') } };

    const auto verdict = validate_body_against_schema (schema, json::object (), body);
    ASSERT_FALSE (verdict.failures.empty ());
    EXPECT_LE (verdict.failures.front ().message.size (),
    constants::schema_validation::MAX_FAILURE_MESSAGE_BYTES + 3);
}

TEST (SchemaValidationBoundsTest, ASchemaTheValidatorRefusesIsUncheckedNotInvalid) {
    // A schema that cannot be loaded means the contract could not be read. The
    // response did not fail it - nothing checked it.
    const json schema{ { "type", "not-a-type" } };
    const auto verdict = validate_body_against_schema (
    schema, json::object (), json::parse (R"({"a":1})"));

    EXPECT_FALSE (verdict.checked);
    ASSERT_HAS_VALUE (verdict.reason);
    EXPECT_EQ (*verdict.reason, UncheckedReason::NoIndex);
}

// The same refusal for a schema a script wrote (#2528) is the validator's
// reason, because that schema's author is the one reading the answer.
TEST (SchemaValidationBoundsTest, AScriptSchemaTheValidatorRefusesNamesWhy) {
    const auto refused = validate_document_against_schema (
    json{ { "type", "not-a-type" } }, json::parse (R"({"a":1})"));
    ASSERT_FALSE (refused.has_value ());
    EXPECT_NE (refused.error ().find ("not-a-type"), std::string::npos)
    << refused.error ();

    const auto judged =
    validate_document_against_schema (json{ { "type", "string" } }, json (1));
    ASSERT_HAS_VALUE (judged);
    EXPECT_TRUE (judged->checked);
    EXPECT_FALSE (judged->valid);
}

// ─── Validity is the validator's verdict (issue #2719) ──────────────────────

namespace {

/// The verdict of @p schema_text against @p value_text, or unchecked after a
/// failure when the validator refused the schema.
ValidationVerdict judge (const char* schema_text, const char* value_text) {
    const auto verdict = validate_document_against_schema (
    json::parse (schema_text), json::parse (value_text));
    if (!verdict.has_value ()) {
        ADD_FAILURE () << schema_text << " was refused: " << verdict.error ();
        return {};
    }
    return *verdict;
}

/// A rejection that also leaves a reason a reader can show: a verdict that says
/// "invalid" with an empty failure list is the shape this guards against.
void expect_rejected (const char* schema_text, const char* value_text) {
    const auto verdict = judge (schema_text, value_text);
    EXPECT_TRUE (verdict.checked) << schema_text << " vs " << value_text;
    EXPECT_FALSE (verdict.valid) << schema_text << " vs " << value_text;
    EXPECT_GE (verdict.failures_total, 1u) << schema_text << " vs " << value_text;
    EXPECT_FALSE (verdict.failures.empty ()) << schema_text << " vs " << value_text;
}

void expect_accepted (const char* schema_text, const char* value_text) {
    const auto verdict = judge (schema_text, value_text);
    EXPECT_TRUE (verdict.checked) << schema_text << " vs " << value_text;
    EXPECT_TRUE (verdict.valid) << schema_text << " vs " << value_text;
    EXPECT_EQ (verdict.failures_total, 0u) << schema_text << " vs " << value_text;
}

} // namespace

// valijson's `propertyNames` returns false and records no error, so a verdict
// read from the recorded errors alone passed `{"aB": 1}`.
TEST (SchemaKeywordVerdictTest, PropertyNamesRejectsANameThatFailsItsSchema) {
    const char* const schema = R"({"propertyNames": {"pattern": "^[a-z]+$"}})";
    expect_accepted (schema, R"({"ab": 1})");
    expect_rejected (schema, R"({"ab": 1, "aB": 2})");

    const auto verdict = judge (schema, R"({"aB": 1})");
    EXPECT_FALSE (verdict.valid);
    EXPECT_EQ (verdict.failures_total, 1u);
    ASSERT_EQ (verdict.failures.size (), 1u);
    // No context survives a constraint that records nothing: the body is the
    // data path, and the schema path is what the message can still name.
    EXPECT_EQ (verdict.failures.front ().path, "");
    EXPECT_NE (verdict.failures.front ().message.find (
               "'propertyNames' at /propertyNames,"),
    std::string::npos)
    << verdict.failures.front ().message;
}

TEST (SchemaKeywordVerdictTest, AFalseSchemaRejectsWithoutClaimingAKeyword) {
    expect_accepted ("true", "1");
    expect_rejected ("false", "1");
    expect_rejected (R"({"properties": {"a": false}})", R"({"a": 1})");

    const auto verdict = judge ("false", "1");
    ASSERT_EQ (verdict.failures.size (), 1u);
    EXPECT_EQ (verdict.failures.front ().message.find ("propertyNames"), std::string::npos)
    << verdict.failures.front ().message;
}

// The message lists every occurrence in the schema's text, not only the one that
// refused: valijson ignores a `propertyNames` beside a `$ref` or nested in a
// subschema, so the refusing one cannot be told apart from the rest.
TEST (SchemaKeywordVerdictTest, ASilentRefusalListsEachPropertyNamesPathOnce) {
    // A property literally called "propertyNames" is a name, not the keyword.
    const char* const schema = R"({
        "propertyNames": {"minLength": 1},
        "properties": {"propertyNames": {"type": "object"}},
        "$ref": "#/definitions/named",
        "definitions": {"named": {"propertyNames": {"maxLength": 1}}}
    })";
    const auto verdict       = judge (schema, R"({"ab": 1})");
    ASSERT_EQ (verdict.failures.size (), 1u);
    const std::string& message = verdict.failures.front ().message;
    EXPECT_NE (
    message.find ("at /definitions/named/propertyNames, /propertyNames,"), std::string::npos)
    << message;
    EXPECT_EQ (message.find ("/properties"), std::string::npos) << message;
}

TEST (SchemaKeywordVerdictTest, ASilentRefusalNamesAtMostThreePaths) {
    const char* const schema = R"({
        "propertyNames": {"maxLength": 1},
        "definitions": {
            "a": {"propertyNames": {}}, "b": {"propertyNames": {}},
            "c": {"propertyNames": {}}, "d": {"propertyNames": {}}
        }
    })";
    const auto verdict       = judge (schema, R"({"ab": 1})");
    ASSERT_EQ (verdict.failures.size (), 1u);
    EXPECT_NE (verdict.failures.front ().message.find (
               "/definitions/a/propertyNames, /definitions/b/propertyNames, "
               "/definitions/c/propertyNames and 2 more,"),
    std::string::npos)
    << verdict.failures.front ().message;
}

// ─── A nested `propertyNames` is disclosed, not validated (issue #2729) ─────

namespace {

/// The count `collect_unevaluated_keywords` gives `propertyNames` for @p schema
/// (zero when it names none).
size_t property_names_gaps (const json& schema, const json& ref_roots = json::object ()) {
    for (const auto& [keyword, count] : collect_unevaluated_keywords (schema, ref_roots)) {
        if (keyword == "propertyNames") {
            return count;
        }
    }
    return 0;
}

} // namespace

// valijson builds a `propertyNames` subschema from its parent's node path, so a
// nested one is never the subschema that runs: the body below is refused by
// ajv and accepted here, and the verdict has to say a keyword went unread.
TEST (SchemaKeywordVerdictTest, ANestedPropertyNamesIsDisclosedBecauseTheValidatorIgnoresIt) {
    const char* const schema =
    R"({"properties": {"o": {"propertyNames": {"pattern": "^[a-z]+$"}}}})";
    const auto verdict = judge (schema, R"({"o": {"aB": 1}})");

    EXPECT_TRUE (verdict.valid)
    << "the validator cannot see the nested keyword";
    ASSERT_EQ (verdict.unevaluated_keywords.size (), 1u);
    EXPECT_EQ (verdict.unevaluated_keywords.front ().first, "propertyNames");
    EXPECT_EQ (verdict.unevaluated_keywords.front ().second, 1u);
}

TEST (SchemaKeywordVerdictTest, APropertyNamesIsDisclosedWhereverItIsNested) {
    const std::vector<std::pair<std::string, std::string>> positions = {
        { "properties", R"({"properties": {"o": {"propertyNames": {"maxLength": 1}}}})" },
        { "patternProperties", R"({"patternProperties": {"^x": {"propertyNames": {"maxLength": 1}}}})" },
        { "additionalProperties", R"({"additionalProperties": {"propertyNames": {"maxLength": 1}}})" },
        { "allOf", R"({"allOf": [{"propertyNames": {"maxLength": 1}}]})" },
        { "anyOf", R"({"anyOf": [{"propertyNames": {"maxLength": 1}}]})" },
        { "oneOf", R"({"oneOf": [{"propertyNames": {"maxLength": 1}}]})" },
        { "not", R"({"not": {"propertyNames": {"maxLength": 1}}})" },
        { "items", R"({"items": {"propertyNames": {"maxLength": 1}}})" },
        { "tuple items", R"({"items": [{"propertyNames": {"maxLength": 1}}]})" },
        { "propertyNames", R"({"propertyNames": {"propertyNames": {"maxLength": 1}}})" },
        { "dependencies", R"({"dependencies": {"a": {"propertyNames": {"maxLength": 1}}}})" },
    };
    for (const auto& [where, schema] : positions) {
        EXPECT_EQ (property_names_gaps (json::parse (schema)), 1u) << where << ": " << schema;
    }
}

TEST (SchemaKeywordVerdictTest, ANestedPropertyNamesBehindARefIsCountedOnce) {
    // The target is reached once through the ref and once in place; one keyword
    // is one gap.
    const auto in_place = json::parse (R"({
        "properties": {"a": {"$ref": "#/definitions/named"}},
        "definitions": {"named": {"propertyNames": {"maxLength": 1}}}
    })");
    EXPECT_EQ (property_names_gaps (in_place), 1u);

    // Two refs to one target are still one keyword in the schema.
    const auto twice = json::parse (R"({
        "properties": {"a": {"$ref": "#/definitions/named"},
                       "b": {"$ref": "#/definitions/named"}},
        "definitions": {"named": {"propertyNames": {"maxLength": 1}}}
    })");
    EXPECT_EQ (property_names_gaps (twice), 1u);

    // A document-level ref root, where the target is only reachable by the ref.
    const auto ref_roots = json::parse (R"({"components": {"schemas": {
        "Named": {"propertyNames": {"maxLength": 1}}}}})");
    EXPECT_EQ (property_names_gaps (
               json::parse (R"({"$ref": "#/components/schemas/Named"})"), ref_roots),
    1u);
}

TEST (SchemaKeywordVerdictTest, EachNestedPropertyNamesIsOneGap) {
    const auto schema = json::parse (R"({
        "properties": {"a": {"propertyNames": {"maxLength": 1}}},
        "allOf": [{"propertyNames": {"minLength": 1}}],
        "items": {"propertyNames": {"pattern": "^a"}}
    })");
    EXPECT_EQ (property_names_gaps (schema), 3u);
}

TEST (SchemaKeywordVerdictTest, TheRootPropertyNamesStaysValidatedAndUndisclosed) {
    const char* const schema = R"({"propertyNames": {"pattern": "^[a-z]+$"}})";
    expect_rejected (schema, R"({"aB": 1})");
    expect_accepted (schema, R"({"ab": 1})");
    EXPECT_TRUE (judge (schema, R"({"aB": 1})").unevaluated_keywords.empty ());

    // A property literally called "propertyNames" is data, not the keyword.
    const auto named =
    json::parse (R"({"properties": {"propertyNames": {"type": "object"}}})");
    EXPECT_EQ (property_names_gaps (named), 0u);
}

// draft-07 `dependencies` maps a property name to a subschema, so a keyword
// under it is as unread as one under `properties` (#2890).
TEST (SchemaKeywordVerdictTest, AnUnevaluatedKeywordUnderDependenciesIsDisclosed) {
    const auto schema = json::parse (R"({
        "dependencies": {"credit_card": {"prefixItems": [{"type": "string"}]}}
    })");
    const auto gaps   = collect_unevaluated_keywords (schema, json::object ());
    ASSERT_EQ (gaps.size (), 1u);
    EXPECT_EQ (gaps.front ().first, "prefixItems");
    EXPECT_EQ (gaps.front ().second, 1u);
}

// The array form lists property names, not a schema: nothing in it is a keyword,
// even a name that spells one.
TEST (SchemaKeywordVerdictTest, TheArrayFormOfDependenciesHoldsNoSubschema) {
    const char* const schema =
    R"({"dependencies": {"a": ["propertyNames", "nullable"], "b": []}})";
    EXPECT_TRUE (
    collect_unevaluated_keywords (json::parse (schema), json::object ()).empty ());

    const auto verdict = judge (schema, R"({"a": 1, "propertyNames": 2, "nullable": 3})");
    EXPECT_TRUE (verdict.valid);
    EXPECT_TRUE (verdict.unevaluated_keywords.empty ());

    // A malformed list is the validator's to refuse; the walk must not follow it.
    const auto malformed = json::parse (R"({"dependencies": {"c": [{"prefixItems": []}]}})");
    EXPECT_TRUE (collect_unevaluated_keywords (malformed, json::object ()).empty ());
}

// Both spellings side by side: only the object-valued one is walked.
TEST (SchemaKeywordVerdictTest, DependenciesMixingBothFormsDisclosesOnlyTheSchema) {
    const auto schema = json::parse (R"({
        "dependencies": {"a": ["b"], "c": {"propertyNames": {"maxLength": 1}}}
    })");
    EXPECT_EQ (property_names_gaps (schema), 1u);
}

// A name under `dependencies` is data, and so is a property called
// "dependencies"; the schema of the latter is still walked.
TEST (SchemaKeywordVerdictTest, ANameCalledDependenciesIsNotTheKeyword) {
    const auto named = json::parse (R"({
        "properties": {"dependencies": {"type": "array", "items": {"type": "string"}}},
        "dependencies": {"nullable": {"type": "object"}}
    })");
    EXPECT_TRUE (collect_unevaluated_keywords (named, json::object ()).empty ());

    const auto nested = json::parse (R"({
        "properties": {"dependencies": {"propertyNames": {"maxLength": 1}}}
    })");
    EXPECT_EQ (property_names_gaps (nested), 1u);
}

// With a `$ref` back to `#` in the schema valijson no longer builds the root
// keyword's own subschema either, so the root `propertyNames` is as unread as a
// nested one: neither the root body nor the one below it is refused by it.
TEST (SchemaKeywordVerdictTest, TheRootPropertyNamesReachedByARefBackToTheRootIsDisclosed) {
    const char* const schema = R"({
        "propertyNames": {"pattern": "^[a-z]+$"},
        "properties": {"a": {"$ref": "#"}, "b": {"items": {"$ref": "#"}}}
    })";
    EXPECT_TRUE (judge (schema, R"({"aB": 1})").valid);
    const auto verdict = judge (schema, R"({"a": {"aB": 1}})");
    EXPECT_TRUE (verdict.valid)
    << "the validator cannot see the keyword below the root";
    // Two refs reach one keyword: one gap.
    ASSERT_EQ (verdict.unevaluated_keywords.size (), 1u);
    EXPECT_EQ (verdict.unevaluated_keywords.front ().first, "propertyNames");
    EXPECT_EQ (verdict.unevaluated_keywords.front ().second, 1u);
}

// ─── `format` (issue #2581) ─────────────────────────────────────────────────

namespace {

/// What `{"format": <format>}` makes of @p value; unchecked when the validator
/// refused the schema, which every caller below treats as a failure.
ValidationVerdict format_verdict (const std::string& format, const json& value) {
    const auto verdict =
    validate_document_against_schema (json{ { "format", format } }, value);
    if (!verdict.has_value ()) {
        ADD_FAILURE () << "format " << format << " was refused: " << verdict.error ();
        return {};
    }
    return *verdict;
}

bool format_accepts (const std::string& format, const json& value) {
    const auto verdict = format_verdict (format, value);
    return verdict.checked && verdict.valid;
}

bool format_rejects (const std::string& format, const json& value) {
    const auto verdict = format_verdict (format, value);
    return verdict.checked && !verdict.valid;
}

void expect_format (const std::string& format,
const std::vector<std::string>& good,
const std::vector<std::string>& bad) {
    for (const auto& value : good) {
        EXPECT_TRUE (format_accepts (format, value))
        << format << " should accept '" << value << "'";
    }
    for (const auto& value : bad) {
        EXPECT_TRUE (format_rejects (format, value))
        << format << " should reject '" << value << "'";
    }
}

} // namespace

TEST (SchemaFormatTest, EmailIsAnAddrSpec) {
    expect_format ("email",
    { "a@b.co", "first.last+tag@example.com", "x@localhost", "o'brien@sub.example-host.org" },
    { "not-an-email", "", "@b.co", "a@", "a@@b.co", ".a@b.co", "a.@b.co", "a..b@b.co", "a b@b.co",
    "a@-b.co", "a@b..co", "a@b.co.", "a@b_c.co", std::string (65, 'a') + "@b.co" });
}

TEST (SchemaFormatTest, HostnameIsDottedLdhLabels) {
    expect_format ("hostname",
    { "example.com", "localhost", "a-b.example.org", "123.example",
    "xn--nxasmq6b", std::string (63, 'a') + ".com" },
    { "", "-a.com", "a-.com", "a..com", "a_b.com", "example.com.", "has space.com",
    ".com", std::string (64, 'a') + ".com", std::string (254, 'a') });
}

TEST (SchemaFormatTest, UuidIsTheHyphenatedHexForm) {
    expect_format ("uuid",
    { "123e4567-e89b-12d3-a456-426614174000", "123E4567-E89B-12D3-A456-426614174000" },
    { "", "123e4567e89b12d3a456426614174000", "123e4567-e89b-12d3-a456-42661417400",
    "123e4567-e89b-12d3-a456-4266141740000", "123e4567-e89b-12d3-a456-42661417400g",
    "urn:uuid:123e4567-e89b-12d3-a456-426614174000" });
}

TEST (SchemaFormatTest, UriIsAnAbsoluteRfc3986Uri) {
    expect_format ("uri",
    { "http://example.com", "https://example.com/a/b?q=1#frag", "mailto:a@b.co",
    "urn:isbn:0451450523", "http://[::1]:8080/x", "http://example.com/a%20b" },
    { "not a uri", "", "/relative/path", "example.com", "://x", "1http://x",
    "http://exa mple.com", "http://x/%zz", "http://x/%2", "http://x/#a#b",
    "http://x/\"q\"", "http://example.com/\xC3\xA9" });
}

TEST (SchemaFormatTest, Ipv6IsTheRfc4291TextForm) {
    expect_format ("ipv6",
    { "::", "::1", "2001:db8::8a2e:370:7334", "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    "1:2:3:4:5:6:7::", "::2:3:4:5:6:7:8", "::ffff:192.0.2.1",
    "64:ff9b::192.0.2.33", "1:2:3:4:5:6:1.2.3.4", "FE80::ABCD" },
    { "", "1.2.3.4", ":", ":::", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1::2::3",
    "1:::2", "12345::", "g::1", ":1::2", "1::2:", "fe80::1%eth0", "::1.2.3", "::256.1.1.1",
    "::01.2.3.4", "1.2.3.4::", ":1.2.3.4", "1:2:3:4:5:6:7:8::", "1:2:3:4:5:6:7::8" });
}

TEST (SchemaFormatTest, AValueThatIsNotAStringIsNotJudgedByAFormat) {
    // `format` applies to strings only, as valijson's own four do.
    for (const char* format : { "email", "uri", "uuid", "hostname", "ipv6" }) {
        EXPECT_TRUE (format_accepts (format, 5)) << format;
        EXPECT_TRUE (format_accepts (format, nullptr)) << format;
        EXPECT_TRUE (format_accepts (format, json::object ())) << format;
    }
}

TEST (SchemaFormatTest, AnUnknownFormatStaysAnAnnotation) {
    // `int64` is what an OpenAPI document writes beside `type: integer`, and
    // `uri-reference` is a real format this table does not claim: neither may
    // start rejecting what it always passed.
    for (const char* format : { "int64", "int32", "binary", "uri-reference", "x-custom" }) {
        EXPECT_TRUE (format_accepts (format, "anything at all")) << format;
        EXPECT_TRUE (format_accepts (format, "")) << format;
    }
    // Names are case-sensitive, as in the specification.
    EXPECT_TRUE (format_accepts ("Email", "not-an-email"));
}

TEST (SchemaFormatTest, TheFormatsValijsonChecksAreReportedOnce) {
    // The extra constraint must not repeat a name valijson owns, or each
    // failure would be counted twice in `failuresTotal`.
    const auto date = format_verdict ("date", "2022-13-01");
    EXPECT_FALSE (date.valid);
    EXPECT_EQ (date.failures_total, 1u);
    const auto ipv4 = format_verdict ("ipv4", "999.1.1.1");
    EXPECT_FALSE (ipv4.valid);
    EXPECT_EQ (ipv4.failures_total, 1u);
    EXPECT_TRUE (format_accepts ("ipv4", "10.0.0.1"));
}

TEST (SchemaFormatTest, AFailureNamesTheFieldAndTheFormat) {
    const auto schema  = json::parse (R"({
        "type": "object",
        "properties": {"contact": {"type": "string", "format": "email"}}
    })");
    const auto verdict = validate_body_against_schema (
    schema, json::object (), json::parse (R"({"contact":"not-an-email"})"));

    ASSERT_FALSE (verdict.valid);
    ASSERT_EQ (verdict.failures.size (), 1u);
    EXPECT_EQ (verdict.failures.front ().path, "/contact");
    EXPECT_EQ (verdict.failures.front ().message, "String should be a valid email address");
}

TEST (SchemaFormatTest, AFormatIsCheckedInsideCombinatorsAndRefs) {
    const auto ref_roots = json::parse (R"({"definitions": {"Id": {"format": "uuid"}}})");
    const auto schema     = json::parse (R"({
        "type": "object",
        "properties": {
            "either": {"anyOf": [{"format": "email"}, {"format": "uuid"}]},
            "ids": {"type": "array", "items": {"$ref": "#/definitions/Id"}}
        }
    })");
    const auto verdict_of = [&] (const char* body) {
        return validate_body_against_schema (schema, ref_roots, json::parse (body));
    };

    EXPECT_TRUE (verdict_of (R"({"either":"a@b.co","ids":["123e4567-e89b-12d3-a456-426614174000"]})")
    .valid);
    EXPECT_TRUE (
    verdict_of (R"({"either":"123e4567-e89b-12d3-a456-426614174000"})").valid);
    EXPECT_FALSE (verdict_of (R"({"either":"neither"})").valid);
    EXPECT_FALSE (
    verdict_of (R"({"ids":["123e4567-e89b-12d3-a456-426614174000","nope"]})").valid);
}

TEST (SchemaFormatTest, AFormatIsNotAnUnevaluatedKeyword) {
    // Every format is either asserted or an annotation the specification
    // allows; neither is a gap the verdict has to disclose.
    const auto schema = json::parse (R"({"properties": {
        "a": {"format": "email"}, "b": {"format": "int64"}, "c": {"format": "uri"}}})");
    EXPECT_TRUE (collect_unevaluated_keywords (schema, json::object ()).empty ());
}

TEST (SchemaFormatTest, AStoredResponseSchemaIsHeldToItsFormats) {
    // The contract path (#628), not only a script's `jsonSchema`.
    const auto index = ResponseSchemaIndex::parse (one_operation_index (json::parse (
    R"({"type":"object","properties":{"email":{"type":"string","format":"email"}}})")));
    ASSERT_HAS_VALUE (index);

    const auto bad =
    index->check (GET_PET, 200, "application/json", R"({"email":"not-an-email"})");
    EXPECT_TRUE (bad.checked);
    EXPECT_FALSE (bad.valid);
    const auto good =
    index->check (GET_PET, 200, "application/json", R"({"email":"a@b.co"})");
    EXPECT_TRUE (good.checked);
    EXPECT_TRUE (good.valid);
}

// ─── Sampled tallies, for a load run (issue #682) ───────────────────────────

namespace {

/// A verdict as one sampled response would produce it.
ValidationVerdict checked_verdict (bool valid) {
    ValidationVerdict verdict;
    verdict.checked = true;
    verdict.valid   = valid;
    if (!valid) {
        verdict.failures       = { SchemaFailure{ "/id", "expected integer" } };
        verdict.failures_total = 1;
    }
    return verdict;
}

ValidationVerdict unchecked_verdict (UncheckedReason reason) {
    ValidationVerdict verdict;
    verdict.reason = reason;
    return verdict;
}

} // namespace

TEST (SampledValidationTest, AllValidSamplesReportNoFailures) {
    SampledValidationTotals totals;
    for (int i = 0; i < 4; ++i) {
        totals.record (checked_verdict (true), "step0", 200);
    }

    EXPECT_EQ (totals.sampled, 4u);
    EXPECT_EQ (totals.checked, 4u);
    EXPECT_EQ (totals.valid, 4u);
    EXPECT_EQ (totals.failed, 0u);
    EXPECT_EQ (totals.failures_total, 0u);
}

TEST (SampledValidationTest, AllInvalidSamplesAreCountedAndExemplified) {
    SampledValidationTotals totals;
    for (int i = 0; i < 3; ++i) {
        totals.record (checked_verdict (false), "step0", 500);
    }

    EXPECT_EQ (totals.checked, 3u);
    EXPECT_EQ (totals.valid, 0u);
    EXPECT_EQ (totals.failed, 3u);
    EXPECT_EQ (totals.failures_total, 3u);
    ASSERT_FALSE (totals.failure_examples.empty ());
    // The example names where and which step, so it reads far from the row it
    // came from.
    EXPECT_EQ (totals.failure_examples.front ().step, "step0");
    EXPECT_EQ (totals.failure_examples.front ().status, 500);
    EXPECT_EQ (totals.failure_examples.front ().path, "/id");
}

TEST (SampledValidationTest, AMixedRunPartitionsCheckedIntoValidAndFailed) {
    SampledValidationTotals totals;
    totals.record (checked_verdict (true), "step0", 200);
    totals.record (checked_verdict (false), "step0", 200);
    totals.record (checked_verdict (true), "step1", 201);

    EXPECT_EQ (totals.sampled, 3u);
    EXPECT_EQ (totals.checked, 3u);
    EXPECT_EQ (totals.valid + totals.failed, totals.checked);
    EXPECT_EQ (totals.valid, 2u);
    EXPECT_EQ (totals.failed, 1u);
}

// The distinction the whole verdict shape exists for, in aggregate: a body no
// JSON Schema can speak about did not break its contract.
//
// Mutation-check: fold the unchecked branch into `failed` and this reddens on
// both counts at once.
TEST (SampledValidationTest, AnUncheckedSampleIsCountedByReasonNotAsAFailure) {
    SampledValidationTotals totals;
    totals.record (checked_verdict (true), "step0", 200);
    totals.record (unchecked_verdict (UncheckedReason::BodyNotJson), "step0", 200);
    totals.record (unchecked_verdict (UncheckedReason::BodyNotJson), "step0", 500);
    totals.record (unchecked_verdict (UncheckedReason::NoSchemaForStatus), "step1", 404);

    EXPECT_EQ (totals.sampled, 4u);
    EXPECT_EQ (totals.checked, 1u);
    EXPECT_EQ (totals.failed, 0u)
    << "a body a schema cannot describe was reported as a contract failure";
    EXPECT_EQ (totals.unchecked_reasons.at ("body_not_json"), 2u);
    EXPECT_EQ (totals.unchecked_reasons.at ("no_schema_for_status"), 1u);
    // The gap between the two is fully explained, never a silent remainder.
    size_t unchecked = 0;
    for (const auto& [reason, count] : totals.unchecked_reasons) {
        (void)reason;
        unchecked += count;
    }
    EXPECT_EQ (totals.checked + unchecked, totals.sampled);
}

// The dialect disclosure, aggregated: a run whose schemas were half-read says
// so by name, and the responses stay counted as the valid ones they were.
TEST (SampledValidationTest, UnevaluatedKeywordsAreDisclosedByNameAcrossSamples) {
    ValidationVerdict verdict = checked_verdict (true);
    verdict.unevaluated_keywords = { { "unevaluatedProperties", 1 }, { "prefixItems", 2 } };

    SampledValidationTotals totals;
    totals.record (verdict, "step0", 200);
    totals.record (verdict, "step0", 200);
    totals.record (checked_verdict (true), "step1", 200);

    EXPECT_EQ (totals.valid, 3u) << "an unevaluated keyword must not unmake a "
                                    "response that passed every check that ran";
    EXPECT_EQ (totals.unevaluated, 2u);
    EXPECT_EQ (totals.unevaluated_keywords.at ("unevaluatedProperties"), 2u);
    EXPECT_EQ (totals.unevaluated_keywords.at ("prefixItems"), 4u);
}

TEST (SampledValidationTest, FailureExamplesAreCappedAndTheTotalStaysHonest) {
    SampledValidationTotals totals;
    for (size_t i = 0; i < constants::schema_validation::MAX_FAILURES * 3; ++i) {
        totals.record (checked_verdict (false), "step0", 500);
    }

    EXPECT_EQ (totals.failure_examples.size (), constants::schema_validation::MAX_FAILURES);
    // Bounded list, unbounded count - so "10 shown of 30" stays readable.
    EXPECT_EQ (totals.failures_total, constants::schema_validation::MAX_FAILURES * 3);
}

TEST (SampledValidationPayloadTest, APassThatWalkedNothingIsAnEmptyObject) {
    // Empty rather than zeros: the caller drops an empty object from the
    // summary, which is what keeps an unbound run's report free of a block
    // saying nothing failed.
    EXPECT_TRUE (build_sampled_validation_payload (SampledValidationTotals{}).empty ());
}

TEST (SampledValidationPayloadTest, TheDenominatorAndTheTalliesAreAllWritten) {
    SampledValidationTotals totals;
    totals.record (checked_verdict (true), "step0", 200);
    totals.record (checked_verdict (false), "step1", 200);
    totals.record (unchecked_verdict (UncheckedReason::BodyNotJson), "step1", 200);

    const auto node = build_sampled_validation_payload (totals);
    // `sampled` is what tells a reader these figures describe the reservoir and
    // not the run - the one number that must never be inferable-only.
    EXPECT_EQ (node["sampled"].get<size_t> (), 3u);
    EXPECT_EQ (node["checked"].get<size_t> (), 2u);
    EXPECT_EQ (node["valid"].get<size_t> (), 1u);
    EXPECT_EQ (node["failed"].get<size_t> (), 1u);
    EXPECT_EQ (node["unevaluated"].get<size_t> (), 0u);
    EXPECT_EQ (node["uncheckedReasons"]["body_not_json"].get<size_t> (), 1u);
    ASSERT_TRUE (node["failures"].is_array ());
    ASSERT_EQ (node["failures"].size (), 1u);
    EXPECT_EQ (node["failures"][0]["step"].get<std::string> (), "step1");
    EXPECT_EQ (node["failures"][0]["status"].get<int> (), 200);
    EXPECT_EQ (node["failuresTotal"].get<size_t> (), 1u);
    // Absent rather than an empty array: nothing went unread here.
    EXPECT_FALSE (node.contains ("unevaluatedKeywords"));
}

// ─── The hot path stays clear (issue #682) ──────────────────────────────────

/**
 * Validation must never be reachable from a load run's completion path.
 *
 * The load loop refills concurrency per completion, so a schema walk there
 * costs throughput for the whole rest of the run - and it would do so
 * *silently*, as a slightly lower RPS nobody would trace back. That is why the
 * pass is deferred to run end, and why the property is asserted structurally
 * rather than by timing: a shared CI runner cannot measure the difference, so
 * a timing test would either be flaky or prove nothing.
 *
 * The scan asserts it read something first - a guard reading an empty string
 * passes forever.
 */
TEST (SchemaValidationHotPathTest, NoValidationIsReachableFromTheCompletionPath) {
    const std::filesystem::path root =
    std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "src";
    ASSERT_TRUE (std::filesystem::exists (root));

    // The files a *load* completion runs through: the strategy's per-completion
    // callback, the scenario executor's virtual-user loop, and the collector
    // each one reports into.
    //
    // `scenario_runner.cpp` is deliberately not among them, and the distinction
    // is the whole point rather than an exemption. It is the **design-mode
    // sequential** runner: one request at a time, nothing refilling concurrency
    // behind it, so there is no completion path to keep clear - which is why
    // #681 can check every step as it runs where #682 must defer. The load-mode
    // scenario executor is `scenario_load.cpp`, and it stays on this list.
    const std::vector<std::string> hot_path = { "load_strategy.cpp",
        "scenario_load.cpp", "metrics_collector.cpp" };

    size_t files_scanned = 0;
    size_t total_bytes   = 0;
    std::vector<std::string> validators;
    std::vector<std::string> offenders;
    for (const auto& entry : std::filesystem::recursive_directory_iterator (root)) {
        if (!entry.is_regular_file () || entry.path ().extension () != ".cpp") {
            continue;
        }
        std::ifstream file (entry.path ());
        std::stringstream buffer;
        buffer << file.rdbuf ();
        const std::string source = buffer.str ();
        ++files_scanned;
        total_bytes += source.size ();

        const std::string name = entry.path ().filename ().string ();
        // The implementation itself is not a call site.
        if (name == "schema_validation.cpp") {
            continue;
        }
        if (source.find ("ResponseSchemaIndex") == std::string::npos) {
            continue;
        }
        validators.push_back (name);
        for (const auto& hot : hot_path) {
            if (name == hot) {
                offenders.push_back (name);
            }
        }
    }

    ASSERT_GT (files_scanned, 10u) << "the scan found no sources to read";
    ASSERT_GT (total_bytes, 1000u) << "the scan read empty files";
    EXPECT_TRUE (offenders.empty ())
    << "response validation reached a file the completion path runs through; "
       "it belongs in the deferred pass at run end";
    // Exactly the three hooks that exist: design mode resolves an index per
    // execution (`specs.cpp`), the load pass parses one at run end
    // (`run_manager.cpp`), and a collection run parses one before its first send
    // (`scenario_runner.cpp`, issue #681). A fourth caller is not wrong on its
    // face - it just has to be looked at, and this is what makes that happen
    // rather than a reviewer noticing. This list is what caught #681's hook and
    // sent someone to decide whether the sequential runner is a hot path; it is
    // not, and the `hot_path` comment above records why.
    std::sort (validators.begin (), validators.end ());
    EXPECT_EQ (validators,
    (std::vector<std::string>{ "run_manager.cpp", "scenario_runner.cpp", "specs.cpp" }));
}

// ─── A `$ref` loop that never reaches a value (#3016) ────────────────────────────
//
// valijson recurses through such a loop until the stack runs out, so the
// refusal has to come before it runs: reaching the next assertion at all is
// the proof the process survived.

namespace {

std::string refusal_of (const std::string& schema_text) {
    const auto refused =
    validate_document_against_schema (json::parse (schema_text), json::object ());
    EXPECT_FALSE (refused.has_value ()) << schema_text;
    return refused.has_value () ? std::string () : refused.error ();
}

} // namespace

TEST (SchemaRefLoopTest, ASchemaThatReferencesItselfIsRefusedNamingTheLoop) {
    const auto reason = refusal_of (
    R"({"$ref":"#/components/schemas/A","components":{"schemas":{"A":{"$ref":"#/components/schemas/A"}}}})");
    EXPECT_NE (reason.find ("refers to itself without describing any value"), std::string::npos)
    << reason;
    EXPECT_NE (reason.find ("#/components/schemas/A -> #/components/schemas/A"),
    std::string::npos)
    << reason;
}

TEST (SchemaRefLoopTest, ALoopThroughTwoSchemasIsRefused) {
    const auto reason = refusal_of (
    R"({"$ref":"#/components/schemas/A","components":{"schemas":{)"
    R"("A":{"$ref":"#/components/schemas/B"},"B":{"$ref":"#/components/schemas/A"}}}})");
    EXPECT_NE (
    reason.find ("#/components/schemas/A -> #/components/schemas/B -> "
                 "#/components/schemas/A"),
    std::string::npos)
    << reason;
}

TEST (SchemaRefLoopTest, ALoopThroughACombinatorIsRefused) {
    for (const char* keyword : { "allOf", "anyOf", "oneOf" }) {
        const std::string schema =
        std::string (R"({"$ref":"#/components/schemas/A","components":{"schemas":{"A":{")") +
        keyword + R"(":[{"$ref":"#/components/schemas/A"}]}}}})";
        EXPECT_NE (refusal_of (schema).find ("without describing any value"), std::string::npos)
        << keyword;
    }
    for (const char* keyword : { "not", "if", "then", "else" }) {
        const std::string schema =
        std::string (R"({"$ref":"#/components/schemas/A","components":{"schemas":{"A":{")") +
        keyword + R"(":{"$ref":"#/components/schemas/A"}}}}})";
        EXPECT_NE (refusal_of (schema).find ("without describing any value"), std::string::npos)
        << keyword;
    }
}

TEST (SchemaRefLoopTest, ARootThatReferencesItselfIsRefused) {
    EXPECT_NE (refusal_of (R"({"$ref":"#"})").find ("# -> #"), std::string::npos);
}

TEST (SchemaRefLoopTest, ALoopThatStepsIntoAPropertyStillValidates) {
    constexpr const char* TREE =
    R"({"$ref":"#/components/schemas/N","components":{"schemas":{"N":{"type":"object",)"
    R"("properties":{"child":{"$ref":"#/components/schemas/N"},"v":{"type":"integer"}}}}}})";
    expect_accepted (TREE, R"({"v":1,"child":{"v":2,"child":{"v":3}}})");
    expect_rejected (TREE, R"({"v":1,"child":{"v":"x"}})");
}

TEST (SchemaRefLoopTest, ALoopThatStepsIntoAnItemStillValidates) {
    constexpr const char* NESTED =
    R"({"$ref":"#/components/schemas/L","components":{"schemas":{"L":{"type":"array",)"
    R"("items":{"anyOf":[{"type":"integer"},{"$ref":"#/components/schemas/L"}]}}}}})";
    expect_accepted (NESTED, "[1,[2,[3]]]");
    expect_rejected (NESTED, R"([1,["x"]])");
}

TEST (SchemaRefLoopTest, ARefLoopInABoundSpecLeavesTheResponseUnchecked) {
    const json schema = json::parse (R"({"$ref":"#/components/schemas/A"})");
    const json roots  = json::parse (
    R"({"components":{"schemas":{"A":{"$ref":"#/components/schemas/A"}}}})");
    const auto verdict = validate_body_against_schema (schema, roots, json::object ());
    EXPECT_FALSE (verdict.checked);
    ASSERT_HAS_VALUE (verdict.reason);
    EXPECT_EQ (*verdict.reason, UncheckedReason::NoIndex);
}
