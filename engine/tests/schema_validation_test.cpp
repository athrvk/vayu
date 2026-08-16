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

#include "vayu/core/constants.hpp"
#include "vayu/core/schema_validation.hpp"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

using nlohmann::json;
using namespace vayu::core;

namespace {

/// The stored `response_schemas` text for one operation declaring one response.
std::string one_operation_index (const json& schema,
const std::string& status       = "200",
const std::string& content_type = "application/json",
const json& ref_roots           = json::object ()) {
    json index;
    index["refRoots"]  = ref_roots;
    index["operations"] = json::array ({ json{ { "operationId", "getPet" },
    { "method", "GET" }, { "path", "/pets/{petId}" },
    { "responses",
    json::array ({ json{ { "status", status }, { "contentType", content_type },
    { "schema", schema } } }) } } });
    return index.dump ();
}

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

// ─── The write-path guard ───────────────────────────────────────────────────

TEST (ResponseSchemaIndexWriteTest, AcceptsAWellFormedIndex) {
    const auto index = json::parse (one_operation_index (pet_schema ()));
    EXPECT_FALSE (validate_response_schemas_index (index, 1024 * 1024).has_value ());
}

TEST (ResponseSchemaIndexWriteTest, RefusesShapesNoReaderCouldUse) {
    const size_t cap = 1024 * 1024;
    EXPECT_TRUE (validate_response_schemas_index (json::array (), cap).has_value ());
    EXPECT_TRUE (validate_response_schemas_index (json::object (), cap).has_value ());
    EXPECT_TRUE (
    validate_response_schemas_index (json{ { "operations", "nope" } }, cap).has_value ());
    EXPECT_TRUE (validate_response_schemas_index (
    json{ { "refRoots", "nope" }, { "operations", json::array () } }, cap)
    .has_value ());

    // A row missing the identity nothing could resolve it by.
    const auto no_method = json{ { "operations",
    json::array ({ json{ { "path", "/pets" }, { "responses", json::array () } } }) } };
    EXPECT_TRUE (validate_response_schemas_index (no_method, cap).has_value ());

    // A response whose schema is neither an object nor a boolean.
    const auto bad_schema = json{ { "operations",
    json::array ({ json{ { "method", "GET" }, { "path", "/pets" },
    { "responses", json::array ({ json{ { "status", "200" },
    { "contentType", "application/json" }, { "schema", "a string" } } }) } } }) } };
    EXPECT_TRUE (validate_response_schemas_index (bad_schema, cap).has_value ());
}

TEST (ResponseSchemaIndexWriteTest, RefusalNamesTheCountAndTheCap) {
    const auto index  = json::parse (one_operation_index (pet_schema ()));
    const auto reason = validate_response_schemas_index (index, 10);
    ASSERT_TRUE (reason.has_value ());
    EXPECT_NE (reason->find ("over the limit of 10"), std::string::npos);
    EXPECT_NE (reason->find ("maxSpecDocumentBytes"), std::string::npos);
}

TEST (ResponseSchemaIndexWriteTest, AcceptsABooleanSchema) {
    // `false` is a legal JSON Schema and a real thing to declare: nothing
    // validates here. Refusing it would refuse a valid contract.
    const auto index = json::parse (one_operation_index (json (false)));
    EXPECT_FALSE (validate_response_schemas_index (index, 1024 * 1024).has_value ());
}

// ─── Matching ───────────────────────────────────────────────────────────────

TEST (ResponseSchemaIndexTest, ValidBodyPasses) {
    const auto index = ResponseSchemaIndex::parse (one_operation_index (pet_schema ()));
    ASSERT_TRUE (index.has_value ());

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
    ASSERT_TRUE (index.has_value ());

    const auto verdict =
    index->check (GET_PET, 200, "application/json", R"({"id":"one"})");
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
    ASSERT_TRUE (index.has_value ());

    const auto verdict = index->check (GET_PET, 200,
    "application/json; charset=utf-8", R"({"id":1,"name":"Rex"})");
    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid);
}

TEST (ResponseSchemaIndexTest, ExactStatusWinsOverARange) {
    json index;
    index["operations"] = json::array ({ json{ { "operationId", "getPet" },
    { "method", "GET" }, { "path", "/pets/{petId}" },
    { "responses",
    json::array ({ json{ { "status", "2XX" }, { "contentType", "application/json" },
    { "schema", json{ { "type", "string" } } } },
    json{ { "status", "200" }, { "contentType", "application/json" },
    { "schema", json{ { "type", "object" } } } } }) } } });

    const auto parsed = ResponseSchemaIndex::parse (index.dump ());
    ASSERT_TRUE (parsed.has_value ());

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
    ASSERT_TRUE (ranged.has_value ());
    EXPECT_EQ (ranged->check (GET_PET, 201, "application/json", R"({"id":1,"name":"a"})")
               .matched_status,
    "2XX");

    const auto fallback =
    ResponseSchemaIndex::parse (one_operation_index (pet_schema (), "default"));
    ASSERT_TRUE (fallback.has_value ());
    EXPECT_EQ (fallback->check (GET_PET, 503, "application/json", R"({"id":1,"name":"a"})")
               .matched_status,
    "default");
}

TEST (ResponseSchemaIndexTest, AWildcardMediaTypeAnswersWhenNothingExactDoes) {
    const auto index =
    ResponseSchemaIndex::parse (one_operation_index (pet_schema (), "200", "*/*"));
    ASSERT_TRUE (index.has_value ());

    const auto verdict =
    index->check (GET_PET, 200, "application/hal+json", R"({"id":1,"name":"Rex"})");
    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid);
}

TEST (ResponseSchemaIndexTest, EveryUncheckableCaseNamesItself) {
    const auto index = ResponseSchemaIndex::parse (one_operation_index (pet_schema ()));
    ASSERT_TRUE (index.has_value ());
    const std::string body = R"({"id":1,"name":"Rex"})";

    // Not an operation at all.
    auto verdict = index->check ("", 200, "application/json", body);
    EXPECT_FALSE (verdict.checked);
    ASSERT_TRUE (verdict.reason.has_value ());
    EXPECT_EQ (*verdict.reason, UncheckedReason::NoOperation);

    // An identity the document does not declare.
    verdict = index->check (R"({"method":"GET","path":"/ghosts"})", 200,
    "application/json", body);
    EXPECT_EQ (*verdict.reason, UncheckedReason::OperationNotDeclared);

    // A status nothing covers.
    verdict = index->check (GET_PET, 404, "application/json", body);
    EXPECT_EQ (*verdict.reason, UncheckedReason::NoSchemaForStatus);

    // A media type nothing declares.
    verdict = index->check (GET_PET, 200, "text/html", body);
    EXPECT_EQ (*verdict.reason, UncheckedReason::NoSchemaForContentType);

    // A transport error is not a status the contract failed to declare.
    verdict = index->check (GET_PET, 0, "", "");
    EXPECT_EQ (*verdict.reason, UncheckedReason::NoResponse);

    // A body no JSON Schema can speak about.
    verdict = index->check (GET_PET, 200, "application/json", "<html></html>");
    EXPECT_EQ (*verdict.reason, UncheckedReason::BodyNotJson);
}

TEST (ResponseSchemaIndexTest, IdentityResolvesByOperationIdBeforeMethodAndPath) {
    // The path moved and the operationId did not: the document still describes
    // this request, and following the operationId is what says so.
    const auto index = ResponseSchemaIndex::parse (one_operation_index (pet_schema ()));
    ASSERT_TRUE (index.has_value ());

    const auto verdict = index->check (
    R"({"operationId":"getPet","method":"GET","path":"/v2/pets/{petId}"})", 200,
    "application/json", R"({"id":1,"name":"Rex"})");
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
    { "responses", json::array ({ json{ { "status", "200" },
    { "contentType", "application/json" }, { "schema", pet_schema () } } }) } } });

    const auto parsed = ResponseSchemaIndex::parse (index.dump ());
    ASSERT_TRUE (parsed.has_value ());
    EXPECT_EQ (parsed->size (), 1u);
    EXPECT_TRUE (parsed->check (GET_PET, 200, "application/json", R"({"id":1,"name":"a"})").checked);
}

// ─── Shared ref roots ───────────────────────────────────────────────────────

TEST (ResponseSchemaRefTest, RefsResolveThroughTheSharedRoots) {
    const auto ref_roots = json::parse (R"({"components": {"schemas": {
        "Pet": {"type":"object","required":["tag"],
                "properties":{"tag":{"$ref":"#/components/schemas/Tag"}}},
        "Tag": {"type":"object","required":["name"],
                "properties":{"name":{"type":"string"}}}
    }}})");
    const auto index = ResponseSchemaIndex::parse (one_operation_index (
    json::parse (R"({"$ref":"#/components/schemas/Pet"})"), "200", "application/json", ref_roots));
    ASSERT_TRUE (index.has_value ());

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
    const auto index = ResponseSchemaIndex::parse (one_operation_index (
    json::parse (R"({"$ref":"#/components/schemas/Node"})"), "200", "application/json", ref_roots));
    ASSERT_TRUE (index.has_value ());

    const auto verdict = index->check (GET_PET, 200, "application/json",
    R"({"name":"a","child":{"name":"b","child":{"name":"c"}}})");
    EXPECT_TRUE (verdict.checked);
    EXPECT_TRUE (verdict.valid);
}

// ─── Dialect honesty ────────────────────────────────────────────────────────

TEST (SchemaDialectTest, UnevaluatedKeywordsAreNamedAndCounted) {
    const auto schema = json::parse (R"({
        "type": "object",
        "properties": {"a": {"type": "string"}},
        "unevaluatedProperties": false,
        "allOf": [{"prefixItems": [{"type": "string"}]}]
    })");
    const auto found = collect_unevaluated_keywords (schema, json::object ());

    std::map<std::string, size_t> by_name (found.begin (), found.end ());
    EXPECT_EQ (by_name["unevaluatedProperties"], 1u);
    EXPECT_EQ (by_name["prefixItems"], 1u);
}

TEST (SchemaDialectTest, AnUnevaluatedKeywordRidesTheVerdictOfACleanBody) {
    // The case this disclosure exists for: the body passes *because* the
    // keyword forbidding it was never evaluated. Silence here would report a
    // contract as met that was never fully read.
    const auto schema = json::parse (R"({
        "type": "object",
        "properties": {"a": {"type": "string"}},
        "unevaluatedProperties": false
    })");
    const auto verdict =
    validate_body_against_schema (schema, json::object (), json::parse (R"({"a":"x","b":1})"));

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
    const auto found = collect_unevaluated_keywords (
    json::parse (R"({"$ref":"#/components/schemas/Node"})"), ref_roots);

    ASSERT_EQ (found.size (), 1u);
    EXPECT_EQ (found.front ().first, "unevaluatedProperties");
}

TEST (SchemaDialectTest, AnOpenApiKeywordThatSurvivedExtractionIsDisclosed) {
    // `nullable` is OpenAPI 3.0's, not JSON Schema's: the app normalises it
    // away when it extracts. One arriving here means that normalisation missed
    // a case, and disclosing it is what keeps the miss from reading as a body
    // that simply failed its type.
    const auto schema =
    json::parse (R"({"type":"string","nullable":true})");
    const auto found = collect_unevaluated_keywords (schema, json::object ());

    ASSERT_EQ (found.size (), 1u);
    EXPECT_EQ (found.front ().first, "nullable");
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
    const json schema{ { "type", "object" }, { "properties",
    json{ { "a", json{ { "type", "integer" } } } } } };
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
    const auto verdict =
    validate_body_against_schema (schema, json::object (), json::parse (R"({"a":1})"));

    EXPECT_FALSE (verdict.checked);
    ASSERT_TRUE (verdict.reason.has_value ());
    EXPECT_EQ (*verdict.reason, UncheckedReason::NoIndex);
}
