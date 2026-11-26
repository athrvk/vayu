/**
 * @file tests/schema_sampler_test.cpp
 * @brief The stub a JSON Schema samples to, and the three opt-ins on top of the
 *        OpenAPI importer's rules (issue #3839).
 *
 * The default-options cases pin what the OpenAPI drafts depend on: they are the
 * rules `fixtures/spec-request-drafts-conformance.json` holds end to end, and a
 * change to one is a draft that differs for a document nobody edited. Each
 * option case names what turning it on changes and what leaving it off keeps.
 */

#include <gtest/gtest.h>

#include <string>

#include <nlohmann/json.hpp>

#include "../src/core/schema_sampler.hpp"

namespace {

using nlohmann::ordered_json;
using vayu::core::MAX_SAMPLE_DEPTH;
using vayu::core::SampleOptions;
using vayu::core::SchemaSampler;
using vayu::core::SeenRefs;

/// @p text sampled as a schema that is also its own `$ref` root, as an MCP
/// tool's `inputSchema` is.
ordered_json sample_of (const std::string& text, SampleOptions options = {}) {
    const ordered_json root = ordered_json::parse (text);
    return SchemaSampler (root, options).sample (&root);
}

SampleOptions with_default () {
    SampleOptions options;
    options.use_default = true;
    return options;
}

SampleOptions with_required_only () {
    SampleOptions options;
    options.required_only = true;
    return options;
}

SampleOptions with_enum_any_type () {
    SampleOptions options;
    options.enum_any_type = true;
    return options;
}

/// A chain of @p levels nested object schemas, each holding the next under
/// `c`, ending in a string. The string sits at depth @p levels.
std::string chain_of (int levels) {
    std::string text = R"({"type":"string"})";
    for (int level = 0; level < levels; ++level) {
        text = R"({"type":"object","properties":{"c":)" + text + "}}";
    }
    return text;
}

/// The value @p levels members down a `chain_of` sample.
ordered_json leaf_of (ordered_json sampled, int levels) {
    for (int level = 0; level < levels; ++level) {
        if (!sampled.is_object () || !sampled.contains ("c")) {
            return ordered_json ("(chain ended early)");
        }
        sampled = sampled["c"];
    }
    return sampled;
}

// ---------------------------------------------------------------------------
// Default options: the OpenAPI importer's rules
// ---------------------------------------------------------------------------

TEST (SchemaSamplerDefaults, ScalarTypesSampleToTheirZeroValue) {
    EXPECT_EQ (sample_of (R"({"type":"string"})"), ordered_json (""));
    EXPECT_EQ (sample_of (R"({"type":"integer"})"), ordered_json (0));
    EXPECT_EQ (sample_of (R"({"type":"number"})"), ordered_json (0));
    EXPECT_EQ (sample_of (R"({"type":"boolean"})"), ordered_json (false));
    EXPECT_EQ (sample_of (R"({"type":"null"})"), ordered_json (nullptr));
}

TEST (SchemaSamplerDefaults, PinnedValuePrecedenceIsConstExampleExamples) {
    EXPECT_EQ (sample_of (R"({"type":"string","const":"c","example":"e","examples":["x"]})"),
    ordered_json ("c"));
    EXPECT_EQ (sample_of (R"({"type":"string","example":"e","examples":["x"]})"),
    ordered_json ("e"));
    EXPECT_EQ (sample_of (R"({"type":"string","examples":["x","y"]})"), ordered_json ("x"));
    EXPECT_EQ (sample_of (R"({"type":"string","examples":[]})"), ordered_json (""));
    EXPECT_EQ (sample_of (R"({"const":null})"), ordered_json (nullptr));
}

TEST (SchemaSamplerDefaults, DefaultIsNotAStatedValue) {
    // The importer shows a document's `example`; a `default` is the server's
    // own business, so turning `use_default` on is a deliberate act.
    EXPECT_EQ (sample_of (R"({"type":"integer","default":7})"), ordered_json (0));
    EXPECT_EQ (sample_of (R"({"type":"integer","default":7,"example":3})"),
    ordered_json (3));
}

TEST (SchemaSamplerDefaults, EnumSamplesToItsFirstValueForAStringOnly) {
    EXPECT_EQ (sample_of (R"({"type":"string","enum":["a","b"]})"), ordered_json ("a"));
    EXPECT_EQ (sample_of (R"({"type":"integer","enum":[3,4]})"), ordered_json (0));
    EXPECT_EQ (sample_of (R"({"enum":["a","b"]})"), ordered_json::object ());
}

TEST (SchemaSamplerDefaults, ObjectSamplesEveryPropertyWhetherRequiredOrNot) {
    const ordered_json sampled = sample_of (R"({
        "type":"object",
        "required":["b"],
        "properties":{"a":{"type":"string"},"b":{"type":"integer"}}})");
    EXPECT_EQ (sampled, ordered_json::parse (R"({"a":"","b":0})"));
}

TEST (SchemaSamplerDefaults, ArrayItemsAndPrefixItems) {
    EXPECT_EQ (sample_of (R"({"type":"array","items":{"type":"integer"}})"),
    ordered_json::parse ("[0]"));
    EXPECT_EQ (sample_of (R"({"type":"array"})"), ordered_json::array ());
    EXPECT_EQ (sample_of (R"({"type":"array","prefixItems":[{"type":"integer"},{"type":"boolean"}]})"),
    ordered_json::parse ("[0,false]"));
}

TEST (SchemaSamplerDefaults, ComposedSchemaSamplesItsFirstBranch) {
    EXPECT_EQ (sample_of (R"({"allOf":[{"type":"integer"},{"type":"string"}]})"),
    ordered_json (0));
    EXPECT_EQ (sample_of (R"({"oneOf":[{"type":"boolean"}],"anyOf":[{"type":"string"}]})"),
    ordered_json (false));
}

TEST (SchemaSamplerDefaults, TypeArraySamplesItsFirstNonNullMember) {
    EXPECT_EQ (sample_of (R"({"type":["null","integer"]})"), ordered_json (0));
    EXPECT_EQ (sample_of (R"({"type":["null"]})"), ordered_json (nullptr));
}

TEST (SchemaSamplerDefaults, ExplicitDefaultOptionsEqualOmittedOptions) {
    const ordered_json root = ordered_json::parse (R"({
        "type":"object","required":["a"],
        "properties":{"a":{"type":"integer","enum":[2],"default":5},"b":{"type":"string"}}})");
    EXPECT_EQ (SchemaSampler (root, SampleOptions{}).sample (&root),
    SchemaSampler (root).sample (&root));
    EXPECT_EQ (SchemaSampler (root).sample (&root), ordered_json::parse (R"({"a":0,"b":""})"));
}

TEST (SchemaSamplerDefaults, NoSchemaAndNonContainersSampleToAnEmptyObject) {
    const ordered_json root = ordered_json::object ();
    const SchemaSampler sampler (root);
    EXPECT_EQ (sampler.sample (nullptr), ordered_json::object ());
    const ordered_json text = "string";
    EXPECT_EQ (sampler.sample (&text), ordered_json::object ());
    EXPECT_EQ (sample_of (R"([{"type":"string"}])"), ordered_json::object ());
}

// ---------------------------------------------------------------------------
// $ref, resolved against the root the sampler is given
// ---------------------------------------------------------------------------

TEST (SchemaSamplerRefs, DefsResolveAgainstTheInputSchemaItself) {
    const ordered_json sampled = sample_of (R"({
        "type":"object",
        "properties":{"n":{"$ref":"#/$defs/Count"},"tags":{"type":"array","items":{"$ref":"#/$defs/Tag"}}},
        "$defs":{"Count":{"type":"integer"},"Tag":{"type":"string","enum":["t"]}}})");
    EXPECT_EQ (sampled, ordered_json::parse (R"({"n":0,"tags":["t"]})"));
}

TEST (SchemaSamplerRefs, ARefResolvesAgainstTheRootNotTheSampledNode) {
    const ordered_json root = ordered_json::parse (R"({
        "components":{"schemas":{"Pet":{"type":"object","properties":{"name":{"type":"string"}}}}}})");
    const ordered_json schema =
    ordered_json::parse (R"({"$ref":"#/components/schemas/Pet"})");
    EXPECT_EQ (SchemaSampler (root).sample (&schema), ordered_json::parse (R"({"name":""})"));
    // The same `$ref` against a root that lacks the target is nothing to sample.
    const ordered_json elsewhere = ordered_json::object ();
    EXPECT_EQ (SchemaSampler (elsewhere).sample (&schema), ordered_json::object ());
}

TEST (SchemaSamplerRefs, ASiblingNamingTheSameRefTwiceIsNotACycle) {
    const ordered_json sampled = sample_of (R"({
        "type":"object",
        "properties":{"a":{"$ref":"#/$defs/V"},"b":{"$ref":"#/$defs/V"}},
        "$defs":{"V":{"type":"boolean"}}})");
    EXPECT_EQ (sampled, ordered_json::parse (R"({"a":false,"b":false})"));
}

TEST (SchemaSamplerRefs, ACycleStopsAtTheSecondVisit) {
    const ordered_json sampled = sample_of (R"({
        "$ref":"#/$defs/Node",
        "$defs":{"Node":{"type":"object","properties":{
            "value":{"type":"integer"},"next":{"$ref":"#/$defs/Node"}}}}})");
    EXPECT_EQ (sampled, ordered_json::parse (R"({"value":0,"next":{}})"));
}

TEST (SchemaSamplerRefs, AnUnresolvedOrNullRefSamplesToAnEmptyObject) {
    EXPECT_EQ (sample_of (R"({"$ref":"#/$defs/Missing"})"), ordered_json::object ());
    EXPECT_EQ (sample_of (R"({"$ref":"#/$defs/Nothing","$defs":{"Nothing":null}})"),
    ordered_json::object ());
}

TEST (SchemaSamplerRefs, ResolveToSchemaFollowsRefsAndBranchesAndStopsAtACycle) {
    const ordered_json root = ordered_json::parse (R"({
        "$defs":{"A":{"allOf":[{"$ref":"#/$defs/B"}]},"B":{"type":"string","format":"binary"},
                 "Loop":{"$ref":"#/$defs/Loop"}}})");
    const SchemaSampler sampler (root);
    const ordered_json through = ordered_json::parse (R"({"$ref":"#/$defs/A"})");
    const ordered_json* resolved = sampler.resolve_to_schema (&through, 0, SeenRefs{});
    ASSERT_NE (resolved, nullptr);
    EXPECT_EQ ((*resolved)["format"], "binary");

    const ordered_json loop = ordered_json::parse (R"({"$ref":"#/$defs/Loop"})");
    EXPECT_EQ (sampler.resolve_to_schema (&loop, 0, SeenRefs{}), nullptr);
}

// ---------------------------------------------------------------------------
// The depth cap
// ---------------------------------------------------------------------------

TEST (SchemaSamplerDepth, ALeafAtTheCapSamplesAndOnePastItIsAnEmptyObject) {
    static_assert (MAX_SAMPLE_DEPTH == 6, "the chains below are sized to the cap");
    // The leaf of `chain_of (n)` sits at depth n.
    EXPECT_EQ (leaf_of (sample_of (chain_of (MAX_SAMPLE_DEPTH)), MAX_SAMPLE_DEPTH),
    ordered_json (""));
    EXPECT_EQ (leaf_of (sample_of (chain_of (MAX_SAMPLE_DEPTH + 1)), MAX_SAMPLE_DEPTH + 1),
    ordered_json::object ());
}

// ---------------------------------------------------------------------------
// use_default
// ---------------------------------------------------------------------------

TEST (SchemaSamplerUseDefault, DefaultOutranksExampleAndLosesToConst) {
    EXPECT_EQ (sample_of (R"({"type":"integer","default":7,"example":3,"examples":[4]})",
               with_default ()),
    ordered_json (7));
    EXPECT_EQ (sample_of (R"({"type":"integer","const":9,"default":7})", with_default ()),
    ordered_json (9));
}

TEST (SchemaSamplerUseDefault, WithoutADefaultTheRestOfThePrecedenceStands) {
    EXPECT_EQ (sample_of (R"({"type":"integer","example":3})", with_default ()),
    ordered_json (3));
    EXPECT_EQ (sample_of (R"({"type":"integer"})", with_default ()), ordered_json (0));
}

TEST (SchemaSamplerUseDefault, ADefaultOfAnyJsonTypeIsStatedIncludingNull) {
    EXPECT_EQ (sample_of (R"({"type":["string","null"],"default":null})", with_default ()),
    ordered_json (nullptr));
    EXPECT_EQ (sample_of (R"({"type":"object","default":{"k":1}})", with_default ()),
    ordered_json::parse (R"({"k":1})"));
}

TEST (SchemaSamplerUseDefault, AppliesToEveryNestedProperty) {
    const ordered_json sampled = sample_of (R"({
        "type":"object",
        "properties":{"limit":{"type":"integer","default":50},"q":{"type":"string"}}})",
    with_default ());
    EXPECT_EQ (sampled, ordered_json::parse (R"({"limit":50,"q":""})"));
}

// ---------------------------------------------------------------------------
// required_only
// ---------------------------------------------------------------------------

TEST (SchemaSamplerRequiredOnly, SamplesTheRequiredPropertiesInRequiredOrder) {
    const ordered_json sampled = sample_of (R"({
        "type":"object",
        "required":["z","a"],
        "properties":{"a":{"type":"integer"},"m":{"type":"string"},"z":{"type":"boolean"}}})",
    with_required_only ());
    EXPECT_EQ (sampled, ordered_json::parse (R"({"z":false,"a":0})"));
    // ordered_json keeps insertion order, and the order is part of the contract.
    ASSERT_EQ (sampled.size (), 2U);
    EXPECT_EQ (sampled.begin ().key (), "z");
}

TEST (SchemaSamplerRequiredOnly, NoRequiredArraySamplesToAnEmptyObject) {
    const std::string schema = R"({"type":"object","properties":{"a":{"type":"integer"}}})";
    EXPECT_EQ (sample_of (schema, with_required_only ()), ordered_json::object ());
    EXPECT_EQ (sample_of (R"({"type":"object","required":[],"properties":{"a":{}}})",
               with_required_only ()),
    ordered_json::object ());
    EXPECT_EQ (sample_of (R"({"type":"object","required":"a","properties":{"a":{}}})",
               with_required_only ()),
    ordered_json::object ());
}

TEST (SchemaSamplerRequiredOnly, ARequiredNameWithNoSchemaOrNoStringIsSkipped) {
    const ordered_json sampled = sample_of (R"({
        "type":"object",
        "required":["ghost",7,"a"],
        "properties":{"a":{"type":"integer"}}})",
    with_required_only ());
    EXPECT_EQ (sampled, ordered_json::parse (R"({"a":0})"));
}

TEST (SchemaSamplerRequiredOnly, FiltersNestedObjectsAndObjectsBehindARef) {
    const ordered_json sampled = sample_of (R"({
        "type":"object",
        "required":["inner"],
        "properties":{
            "inner":{"$ref":"#/$defs/Inner"},
            "skipped":{"type":"string"}},
        "$defs":{"Inner":{"type":"object","required":["id"],
            "properties":{"id":{"type":"integer"},"note":{"type":"string"}}}}})",
    with_required_only ());
    EXPECT_EQ (sampled, ordered_json::parse (R"({"inner":{"id":0}})"));
}

TEST (SchemaSamplerRequiredOnly, LeavesArrayItemsToTheirOwnRequiredList) {
    const ordered_json sampled = sample_of (R"({
        "type":"object",
        "required":["rows"],
        "properties":{"rows":{"type":"array","items":{"type":"object","required":["k"],
            "properties":{"k":{"type":"string"},"v":{"type":"string"}}}}}})",
    with_required_only ());
    EXPECT_EQ (sampled, ordered_json::parse (R"({"rows":[{"k":""}]})"));
}

// ---------------------------------------------------------------------------
// enum_any_type
// ---------------------------------------------------------------------------

TEST (SchemaSamplerEnumAnyType, EveryScalarTypeSamplesToItsFirstEnumValue) {
    EXPECT_EQ (sample_of (R"({"type":"integer","enum":[3,4]})", with_enum_any_type ()),
    ordered_json (3));
    EXPECT_EQ (sample_of (R"({"type":"number","enum":[1.5,2]})", with_enum_any_type ()),
    ordered_json (1.5));
    EXPECT_EQ (sample_of (R"({"type":"boolean","enum":[true]})", with_enum_any_type ()),
    ordered_json (true));
    EXPECT_EQ (sample_of (R"({"type":"string","enum":["a","b"]})", with_enum_any_type ()),
    ordered_json ("a"));
    EXPECT_EQ (sample_of (R"({"type":["integer","null"],"enum":[5,null]})",
               with_enum_any_type ()),
    ordered_json (5));
}

TEST (SchemaSamplerEnumAnyType, AnEnumWithNoTypeSamplesToItsFirstValue) {
    EXPECT_EQ (sample_of (R"({"enum":["on","off"]})", with_enum_any_type ()),
    ordered_json ("on"));
    EXPECT_EQ (sample_of (R"({"enum":[2,3]})", with_enum_any_type ()), ordered_json (2));
}

TEST (SchemaSamplerEnumAnyType, AnEmptyEnumAndAStructuredTypeAreNotEnumsToSample) {
    EXPECT_EQ (sample_of (R"({"type":"integer","enum":[]})", with_enum_any_type ()),
    ordered_json (0));
    EXPECT_EQ (sample_of (R"({"type":"array","enum":[[1]],"items":{"type":"integer"}})",
               with_enum_any_type ()),
    ordered_json::parse ("[0]"));
    EXPECT_EQ (sample_of (R"({"type":"object","enum":[{"x":1}],"properties":{"a":{"type":"string"}}})",
               with_enum_any_type ()),
    ordered_json::parse (R"({"a":""})"));
}

TEST (SchemaSamplerEnumAnyType, ReachesEnumsInsideProperties) {
    const ordered_json sampled = sample_of (R"({
        "type":"object",
        "properties":{"level":{"type":"integer","enum":[2,1]},"mode":{"enum":["fast"]}}})",
    with_enum_any_type ());
    EXPECT_EQ (sampled, ordered_json::parse (R"({"level":2,"mode":"fast"})"));
}

TEST (SchemaSamplerEnumAnyType, StatedValuesStillOutrankTheEnum) {
    EXPECT_EQ (sample_of (R"({"type":"integer","enum":[1,2],"example":2})",
               with_enum_any_type ()),
    ordered_json (2));
}

// ---------------------------------------------------------------------------
// The options compose
// ---------------------------------------------------------------------------

TEST (SchemaSamplerOptions, AllThreeTogetherSampleAToolArgumentSet) {
    SampleOptions all;
    all.use_default            = true;
    all.required_only          = true;
    all.enum_any_type          = true;
    const ordered_json sampled = sample_of (R"({
        "type":"object",
        "required":["unit","count"],
        "properties":{
            "count":{"type":"integer","default":10},
            "unit":{"type":"integer","enum":[1,2]},
            "label":{"type":"string"}}})",
    all);
    EXPECT_EQ (sampled, ordered_json::parse (R"({"unit":1,"count":10})"));
}

} // namespace
