/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/elements_registry_test.cpp
 * @brief The element registry, its wire validation, `GET /elements/kinds`,
 *        the round-trip through the two write routes, and the startup
 *        script-to-elements fold (issue #1513).
 *
 * `test.echo` is registered here, in the test binary only, as the
 * extensibility contract's own proof: a kind registered in one file must
 * appear in the catalogue, validate, and round-trip through storage with
 * nothing else in the engine touched for it.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;
using vayu::core::Element;
using vayu::core::ElementKind;
using vayu::core::HotPathClass;
using vayu::core::Phase;
using vayu::core::Registry;

namespace vayu::http::routes {
// Defined in requests.cpp / collections.cpp; each returns {http_status, json_body}.
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json> update_request_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::string list_requests_body (vayu::db::Database& db, const std::string& collection_id);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::create_collection_response;
using vayu::http::routes::create_request_response;
using vayu::http::routes::list_requests_body;
using vayu::http::routes::update_request_response;

/**
 * Test-only kind, registered once for the whole binary: proves the
 * extensibility contract (issue #1512, rule 5) rather than any one kind's
 * behaviour. Never runs (no `compile`) - phase 0 executes nothing.
 */
ElementKind make_test_echo_kind () {
    ElementKind kind;
    kind.kind          = "test.echo";
    kind.version       = 1;
    kind.phases        = { Phase::StepAfter };
    kind.label         = "Test echo";
    kind.description   = "Registered by the test binary only, to prove a kind "
                         "in one file needs nothing else touched.";
    kind.category      = "test";
    kind.hot_path      = HotPathClass::Declarative;
    kind.config_schema = { { "type", "object" },
        { "properties",
        { { "message",
        { { "type", "string" }, { "title", "Message" },
        { "description", "The text this test-only kind echoes back." } } } } },
        { "required", nlohmann::json::array ({ "message" }) },
        { "additionalProperties", false } };
    return kind;
}

class ElementsRegistryTest : public ::testing::Test {
    protected:
    static void SetUpTestSuite () {
        Registry::instance ().register_kind_for_test (make_test_echo_kind ());
    }
};

TEST_F (ElementsRegistryTest, TheCatalogueListsInheritDisableAndTheTestOnlyKind) {
    const json catalogue = vayu::core::elements_catalogue ();
    ASSERT_TRUE (catalogue.is_array ());

    bool saw_inherit_disable = false;
    bool saw_test_echo       = false;
    bool saw_script_pre      = false;
    bool saw_script_post     = false;
    for (const auto& kind : catalogue) {
        if (kind["kind"] == "inherit.disable") {
            saw_inherit_disable = true;
            EXPECT_TRUE (kind.contains ("configSchema"));
            EXPECT_TRUE (kind.contains ("phases"));
        }
        if (kind["kind"] == "test.echo") {
            saw_test_echo = true;
            EXPECT_EQ (kind["category"], "test");
        }
        if (kind["kind"] == "script.pre") {
            saw_script_pre = true;
        }
        if (kind["kind"] == "script.post") {
            saw_script_post = true;
        }
    }
    EXPECT_TRUE (saw_inherit_disable);
    EXPECT_TRUE (saw_test_echo);
    // Validate-only (issue #1513 registers no behaviour yet), so
    // `fold_scripts_into_elements`'s own output round-trips through
    // `Registry::validate` rather than being rejected by its own migration.
    EXPECT_TRUE (saw_script_pre);
    EXPECT_TRUE (saw_script_post);
}

TEST_F (ElementsRegistryTest, AnUnknownKindNamesItselfAndTheKnownList) {
    const json elements = json::array (
    { json{ { "id", "el_1" }, { "kind", "assert.sttus" }, { "enabled", true } } });
    auto reason = Registry::instance ().validate (elements);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("Item 1"), std::string::npos);
    EXPECT_NE (reason->find ("assert.sttus"), std::string::npos);
    EXPECT_NE (reason->find ("unrecognized kind"), std::string::npos);
}

TEST_F (ElementsRegistryTest, ABadConfigFieldNamesTheElementAndTheKind) {
    const json elements = json::array ({ json{ { "id", "el_1" },
    { "kind", "test.echo" }, { "enabled", true }, { "config", json::object () } } });
    auto reason         = Registry::instance ().validate (elements);
    ASSERT_HAS_VALUE (reason)
    << "config is missing the required 'message' field";
    EXPECT_NE (reason->find ("item 1"), std::string::npos);
    EXPECT_NE (reason->find ("Test echo"), std::string::npos);
}

TEST_F (ElementsRegistryTest, ADuplicateIdIsRejected) {
    const json elements =
    json::array ({ json{ { "id", "el_1" }, { "kind", "inherit.disable" },
                   { "config", { { "elementId", "el_x" } } } },
    json{ { "id", "el_1" }, { "kind", "inherit.disable" },
    { "config", { { "elementId", "el_y" } } } } });
    auto reason = Registry::instance ().validate (elements);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("Item 2"), std::string::npos);
    EXPECT_NE (reason->find ("same id ('el_1')"), std::string::npos);
}

TEST_F (ElementsRegistryTest, AWellFormedListValidatesCleanly) {
    const json elements =
    json::array ({ json{ { "id", "el_1" }, { "kind", "test.echo" },
                   { "enabled", true }, { "config", { { "message", "hi" } } } },
    json{ { "id", "el_2" }, { "kind", "inherit.disable" },
    { "config", { { "elementId", "el_9" } } } } });
    EXPECT_FALSE (Registry::instance ().validate (elements).has_value ());
}

// ---------------------------------------------------------------------------
// The JSONPath subset is one rule, checked by each kind's `validate_config`
// rather than by a schema pattern per kind (#1903).
// ---------------------------------------------------------------------------

json extract_json_entry (const json& path) {
    return json{ { "id", "el_1" }, { "kind", "extract.json" },
        { "config", { { "path", path }, { "variable", "v" } } } };
}

json assert_jsonpath_entry (const json& path) {
    return json{ { "id", "el_1" }, { "kind", "assert.jsonpath" },
        { "config", { { "path", path }, { "exists", true } } } };
}

json metric_source_entry (const json& source) {
    return json{ { "id", "el_1" }, { "kind", "metric.record" },
        { "config", { { "name", "m" }, { "type", "trend" }, { "source", source } } } };
}

std::optional<std::string> validate_entry (const json& entry) {
    return Registry::instance ().validate (json::array ({ entry }));
}

TEST_F (ElementsRegistryTest, APathOutsideTheSubsetIsRefusedForEveryJsonPathKind) {
    const std::vector<std::pair<std::string, json>> entries = {
        { "extract.json", extract_json_entry ("$x") },
        { "assert.jsonpath", assert_jsonpath_entry ("$x") },
        { "metric.record", metric_source_entry ({ { "jsonpath", "$x" } }) },
        { "metric.record condition",
        metric_source_entry ({ { "condition",
        { { "field", "jsonpath" }, { "jsonpath", "$x" }, { "operator", "eq" },
        { "value", 1 } } } }) },
    };
    for (const auto& [name, entry] : entries) {
        const auto reason = validate_entry (entry);
        ASSERT_HAS_VALUE (reason) << name;
        EXPECT_NE (reason->find ("item 1"), std::string::npos) << name << ": " << *reason;
        EXPECT_NE (reason->find ("not a supported JSONPath"), std::string::npos)
        << name << ": " << *reason;
    }
}

TEST_F (ElementsRegistryTest, TheSubsetAcceptsWhatTheOldSchemaPatternRefused) {
    for (const char* path : { "$.data.user-id", "$['a.b']", "$[\"a b\"]",
         "$['a]b']", "$['a'].b[0][*]..c", "$..user-id", "$" }) {
        EXPECT_FALSE (validate_entry (extract_json_entry (path)).has_value ()) << path;
        EXPECT_FALSE (validate_entry (assert_jsonpath_entry (path)).has_value ()) << path;
        EXPECT_FALSE (
        validate_entry (metric_source_entry ({ { "jsonpath", path } })).has_value ())
        << path;
    }
}

TEST_F (ElementsRegistryTest, AFilterOrAMalformedBracketMemberIsRefused) {
    for (const char* path :
    { "$[?(@.a)]", "$['']", "$['a", "$['a'", "$['a']x", "$.a.", "", "a.b" }) {
        const auto reason = validate_entry (extract_json_entry (path));
        ASSERT_HAS_VALUE (reason) << path;
        EXPECT_NE (reason->find ("not a supported JSONPath"), std::string::npos)
        << path << ": " << *reason;
    }
}

TEST_F (ElementsRegistryTest, ANonStringPathKeepsTheSchemasOwnError) {
    const auto wrong_type = validate_entry (extract_json_entry (7));
    ASSERT_HAS_VALUE (wrong_type);
    EXPECT_EQ (wrong_type->find ("not a supported JSONPath"), std::string::npos)
    << *wrong_type;

    const auto absent = validate_entry (json{ { "id", "el_1" },
    { "kind", "assert.jsonpath" }, { "config", { { "exists", true } } } });
    ASSERT_HAS_VALUE (absent);
    EXPECT_EQ (absent->find ("not a supported JSONPath"), std::string::npos) << *absent;
}

// ---------------------------------------------------------------------------
// An assertion or extractor that could only ever report `error` is refused
// when it is written (#3043): a pattern RE2 does not compile, or an assertion
// with nothing to compare against. Mutation check: drop the `validate_config`
// of `assert.status`, `assert.jsonpath`, `assert.contains` or `extract.regex`
// and its cases here are accepted.
// ---------------------------------------------------------------------------

json entry_of (const std::string& kind, const json& config) {
    return json{ { "id", "el_1" }, { "kind", kind }, { "config", config } };
}

TEST_F (ElementsRegistryTest, AnAssertionOrExtractorThatCannotRunIsRefusedNamingTheField) {
    struct Refused {
        json entry;
        std::string field;
    };
    const std::string pattern_refusal = " is not a valid regular expression - ";
    const std::vector<Refused> cases  = {
        { entry_of ("assert.status", json::object ()), "'in' or 'range' is required" },
        { entry_of ("assert.status", { { "in", json::array () } }), "'in' or 'range' is required" },
        { entry_of ("assert.jsonpath", { { "path", "$.a" } }),
        "one of 'expected', 'regex' or 'exists' is required" },
        { entry_of ("assert.contains", { { "text", "[" }, { "mode", "matches" } }),
        "'text'" + pattern_refusal + "missing ]" },
        { entry_of ("assert.jsonpath", { { "path", "$.a" }, { "regex", "[" } }),
        "'regex'" + pattern_refusal + "missing ]" },
        // `exists` states presence, `expected` / `regex` the value (#3049).
        { entry_of ("assert.jsonpath",
          { { "path", "$.a" }, { "exists", false }, { "expected", 1 } }),
        "'exists' cannot be combined with 'expected'" },
        { entry_of ("assert.jsonpath",
          { { "path", "$.a" }, { "exists", true }, { "regex", "^a" } }),
        "'exists' cannot be combined with 'regex'" },
        // Checked even where `expected` would win at run time.
        { entry_of ("assert.jsonpath",
          { { "path", "$.a" }, { "expected", 1 }, { "regex", "[" } }),
        "'regex'" + pattern_refusal },
        { entry_of ("extract.regex", { { "pattern", "(" }, { "variable", "v" } }),
        "'pattern'" + pattern_refusal + "missing )" },
        // Java's lookaround, which a JMeter plan can carry, is outside RE2.
        { entry_of ("extract.regex", { { "pattern", "(?<=id=)\\d+" }, { "variable", "v" } }),
        "'pattern'" + pattern_refusal },
    };
    for (const auto& [entry, field] : cases) {
        const auto reason = validate_entry (entry);
        ASSERT_HAS_VALUE (reason) << entry.dump ();
        EXPECT_NE (reason->find ("(item 1): "), std::string::npos) << *reason;
        EXPECT_NE (reason->find (field), std::string::npos) << *reason;
    }
}

TEST_F (ElementsRegistryTest, AnAssertionOrExtractorThatCanRunIsAccepted) {
    const std::vector<json> entries = {
        entry_of ("assert.status", { { "in", json::array ({ 200 }) } }),
        entry_of ("assert.status", { { "range", { { "min", 200 }, { "max", 299 } } } }),
        entry_of ("assert.jsonpath", { { "path", "$.a" }, { "exists", true } }),
        entry_of ("assert.jsonpath",
        { { "path", "$.a" }, { "exists", false }, { "negate", true } }),
        entry_of ("assert.jsonpath", { { "path", "$.a" }, { "expected", nullptr } }),
        entry_of ("assert.jsonpath", { { "path", "$.a" }, { "regex", "^[0-9]+$" } }),
        // An empty pattern compiles and matches anywhere.
        entry_of ("assert.jsonpath", { { "path", "$.a" }, { "regex", "" } }),
        entry_of ("assert.contains", { { "text", "" }, { "mode", "matches" } }),
        // Only `matches` reads `text` as a pattern.
        entry_of ("assert.contains", { { "text", "[" } }),
        entry_of ("assert.contains", { { "text", "[" }, { "mode", "contains" } }),
        entry_of ("assert.contains", { { "text", "[" }, { "mode", "equals" } }),
        entry_of ("extract.regex", { { "pattern", "order-([0-9]+)" }, { "variable", "v" } }),
        // A pattern is never template-resolved, so braces are judged as RE2
        // reads them: a `{` that opens no repetition is a literal.
        entry_of ("extract.regex", { { "pattern", "a{{n}}" }, { "variable", "v" } }),
        entry_of ("extract.regex", { { "pattern", "{{token}}" }, { "variable", "v" } }),
    };
    for (const auto& entry : entries) {
        const auto reason = validate_entry (entry);
        EXPECT_FALSE (reason.has_value ())
        << entry.dump () << ": " << reason.value_or ("");
    }
}

// ---------------------------------------------------------------------------
// A setting the engine accepted and then ignored is refused naming the field
// (#3055). Mutation check: drop the `validate_config` of `control.throughput`,
// `timer.think` or `assert.contains`, or `variable_name_problem` from an
// `extract.*` kind, and its rows here are accepted.
// ---------------------------------------------------------------------------

TEST_F (ElementsRegistryTest, ASettingThatWouldDoNothingIsRefusedNamingTheField) {
    struct Refused {
        json entry;
        std::string wording;
    };
    const auto extract_with = [] (const std::string& kind, const json& variable) {
        json config = { { "variable", variable } };
        if (kind == "extract.json") {
            config["path"] = "$.a";
        } else if (kind == "extract.regex") {
            config["pattern"] = "a";
        } else if (kind == "extract.header") {
            config["header"] = "X-A";
        }
        return entry_of (kind, config);
    };
    std::vector<Refused> cases = {
        { entry_of ("control.throughput", json::object ()), "'percent' or 'everyN' is required" },
        { entry_of ("control.throughput", { { "perUser", false } }),
        "'percent' or 'everyN' is required" },
        { entry_of ("control.throughput", { { "percent", 50 }, { "everyN", 2 } }),
        "'percent' cannot be combined with 'everyN'" },
        { entry_of ("timer.think", json::object ()), "'ms' is required" },
        { entry_of ("timer.think", { { "minMs", 100 } }), "'maxMs' is required beside 'minMs'" },
        { entry_of ("timer.think", { { "maxMs", 100 } }), "'minMs' is required beside 'maxMs'" },
        { entry_of ("assert.contains", { { "text", "" } }), "'text' cannot be empty" },
        { entry_of ("assert.contains", { { "text", "" }, { "mode", "contains" } }),
        "'text' cannot be empty" },
        { entry_of ("assert.contains", { { "text", "" }, { "negate", true } }),
        "'text' cannot be empty" },
    };
    for (const char* kind :
    { "extract.json", "extract.regex", "extract.header", "extract.boundary" }) {
        cases.push_back (
        { extract_with (kind, "a{b"), "'variable' cannot contain '{' or '}'" });
        cases.push_back (
        { extract_with (kind, "a}"), "'variable' cannot contain '{' or '}'" });
        cases.push_back ({ extract_with (kind, " x"),
        "'variable' cannot start or end with whitespace" });
        cases.push_back ({ extract_with (kind, "x\t"),
        "'variable' cannot start or end with whitespace" });
        cases.push_back ({ extract_with (kind, "  "),
        "'variable' cannot start or end with whitespace" });
        cases.push_back (
        { extract_with (kind, "data.id"), "'variable' cannot start with 'data.'" });
        cases.push_back ({ extract_with (kind, "$vu"), "'variable' cannot be '$vu'" });
        cases.push_back (
        { extract_with (kind, "$iteration"), "'variable' cannot be '$iteration'" });
    }
    for (const auto& [entry, wording] : cases) {
        const auto reason = validate_entry (entry);
        ASSERT_HAS_VALUE (reason) << entry.dump ();
        EXPECT_NE (reason->find ("(item 1): " + wording), std::string::npos)
        << entry.dump () << ": " << *reason;
    }
}

TEST_F (ElementsRegistryTest, ASettingThatDoesSomethingIsAccepted) {
    std::vector<json> entries = {
        entry_of ("control.throughput", { { "percent", 50 } }),
        entry_of ("control.throughput", { { "everyN", 3 }, { "perUser", false } }),
        entry_of ("timer.think", { { "ms", 250 } }),
        entry_of ("timer.think", { { "ms", 0 } }),
        entry_of ("timer.think", { { "minMs", 100 }, { "maxMs", 300 } }),
        entry_of ("timer.think",
        { { "gaussian", { { "meanMs", 200 }, { "deviationMs", 20 } } } }),
        // A combination the draw order already resolves is not refused.
        entry_of ("timer.think", { { "ms", 250 }, { "minMs", 100 } }),
        entry_of ("assert.contains", { { "text", "ok" } }),
        entry_of ("assert.contains", { { "text", "" }, { "mode", "equals" } }),
        entry_of ("assert.contains", { { "text", "" }, { "mode", "matches" } }),
        // Whitespace inside a name is part of it; `{{1 bad}}` is a token.
        entry_of ("extract.json", { { "path", "$.a" }, { "variable", "1 bad" } }),
        entry_of ("extract.json", { { "path", "$.a" }, { "variable", "dataset" } }),
        entry_of ("extract.json", { { "path", "$.a" }, { "variable", "data." } }),
        entry_of ("extract.regex", { { "pattern", "a" }, { "variable", "$guid_" } }),
        entry_of ("extract.header", { { "header", "X-A" }, { "variable", "token" } }),
        entry_of ("extract.boundary", { { "variable", "token" } }),
    };
    for (const auto& entry : entries) {
        const auto reason = validate_entry (entry);
        EXPECT_FALSE (reason.has_value ())
        << entry.dump () << ": " << reason.value_or ("");
    }
}

TEST_F (ElementsRegistryTest, AnEmptyVariableKeepsTheSchemasOwnError) {
    const auto reason =
    validate_entry (entry_of ("extract.boundary", { { "variable", "" } }));
    ASSERT_HAS_VALUE (reason);
    EXPECT_EQ (reason->find ("cannot"), std::string::npos) << *reason;
}

TEST_F (ElementsRegistryTest, AMistypedPatternKeepsTheSchemasOwnError) {
    const auto reason = validate_entry (
    entry_of ("extract.regex", { { "pattern", 7 }, { "variable", "v" } }));
    ASSERT_HAS_VALUE (reason);
    EXPECT_EQ (reason->find ("not a valid regular expression"), std::string::npos)
    << *reason;
}

TEST_F (ElementsRegistryTest, AMetricConditionPathIsOnlyReadWhenItsFieldIsJsonpath) {
    const json condition = { { "field", "status" }, { "jsonpath", "$x" },
        { "operator", "eq" }, { "value", 200 } };
    EXPECT_FALSE (
    validate_entry (metric_source_entry ({ { "condition", condition } })).has_value ());
}

/// Whether @p value is a JSON value of the JSON-Schema @p type.
bool json_matches_schema_type (const json& value, const std::string& type) {
    if (type == "string") {
        return value.is_string ();
    }
    if (type == "boolean") {
        return value.is_boolean ();
    }
    if (type == "integer") {
        return value.is_number_integer ();
    }
    if (type == "number") {
        return value.is_number ();
    }
    return false;
}

/// A property's `default`, when it has one, must be a value the property
/// would accept: the declared type, and a member of the `enum` if it has one.
void expect_default_is_valid (const std::string& kind_name,
const std::string& property_name,
const json& schema) {
    const auto found = schema.find ("default");
    if (found == schema.end ()) {
        return;
    }
    const std::string where = kind_name + "." + property_name;
    const auto* type =
    schema.contains ("type") ? schema["type"].get_ptr<const std::string*> () : nullptr;
    ASSERT_NE (type, nullptr) << where << " has a default but no type";
    EXPECT_TRUE (json_matches_schema_type (*found, *type))
    << where << " has a default that is not a " << *type;
    if (schema.contains ("enum")) {
        const auto& members = schema["enum"];
        EXPECT_NE (std::find (members.begin (), members.end (), *found), members.end ())
        << where << " has a default outside its enum";
    }
}

/**
 * Recursively asserts every property in a JSON-Schema `properties` map
 * (issue #1607) carries a non-empty `title` and `description`, and that the
 * two vendor annotation keywords stay inside their closed sets -
 * `x-vayu-group` only ever `"advanced"`, `x-vayu-unit` only ever one of
 * `"ms"`, `"%"`, `"B"`; and that a `default` (issue #3045), when present, is
 * of the property's declared `type` and a member of its `enum`. Descends into
 * a nested object property's own `properties` (`assert.status`'s `range`,
 * `timer.think`'s `gaussian`, `metric.record`'s `source` and its own nested
 * `condition`), holding a nested field to the same rule as a top-level one.
 */
void expect_every_property_annotated (const std::string& kind_name, const json& properties) {
    // get_ptr, not value (): GCC 13 at -O3 reports a null dereference inside
    // value ()'s string conversion once this file grows past an inlining limit.
    const auto has_text = [] (const json& schema, const char* key) {
        const auto found = schema.find (key);
        if (found == schema.end ()) {
            return false;
        }
        const auto* text = found->get_ptr<const std::string*> ();
        return text != nullptr && !text->empty ();
    };
    const auto string_of = [] (const json& schema, const char* key) {
        const auto found = schema.find (key);
        const auto* text =
        found == schema.end () ? nullptr : found->get_ptr<const std::string*> ();
        return text == nullptr ? std::string{} : *text;
    };
    for (const auto& [name, schema] : properties.items ()) {
        EXPECT_TRUE (has_text (schema, "title")) << kind_name << "." << name << " has no title";
        EXPECT_TRUE (has_text (schema, "description"))
        << kind_name << "." << name << " has no description";
        expect_default_is_valid (kind_name, name, schema);
        if (schema.contains ("x-vayu-group")) {
            EXPECT_EQ (schema["x-vayu-group"], "advanced")
            << kind_name << "." << name << " has an unknown x-vayu-group";
        }
        if (schema.contains ("x-vayu-unit")) {
            const std::string unit = string_of (schema, "x-vayu-unit");
            EXPECT_TRUE (unit == "ms" || unit == "%" || unit == "B")
            << kind_name << "." << name << " has an unknown x-vayu-unit '"
            << unit << "'";
        }
        if (string_of (schema, "type") == "object" && schema.contains ("properties")) {
            std::string nested_name = kind_name;
            nested_name += ".";
            nested_name += name;
            expect_every_property_annotated (nested_name, schema["properties"]);
        }
    }
}

TEST_F (ElementsRegistryTest, EveryPropertyOfEveryKindCarriesATitleAndDescription) {
    const json catalogue = vayu::core::elements_catalogue ();
    ASSERT_GT (catalogue.size (), 20u);
    for (const auto& kind : catalogue) {
        const std::string kind_name = kind["kind"].get<std::string> ();
        if (!kind.contains ("configSchema") || !kind["configSchema"].contains ("properties")) {
            continue; // e.g. control.once, whose schema declares no properties at all.
        }
        expect_every_property_annotated (kind_name, kind["configSchema"]["properties"]);
    }
}

/// The property schema of @p kind_name's @p property_name in @p catalogue, or
/// null when the kind or the property is not there.
const json* property_schema (const json& catalogue,
const std::string& kind_name,
const std::string& property_name) {
    for (const auto& kind : catalogue) {
        if (kind["kind"] != kind_name) {
            continue;
        }
        const auto& properties = kind["configSchema"]["properties"];
        const auto found       = properties.find (property_name);
        return found == properties.end () ? nullptr : &*found;
    }
    return nullptr;
}

// Issue #3045: a form shows `default` for a key the config leaves out, so each
// value below is what the engine runs for that absent key. The behaviour is
// held in `element_kinds_test.cpp`; this pins the values the catalogue serves.
TEST_F (ElementsRegistryTest, TheCatalogueDeclaresTheDefaultEachKindRuns) {
    struct DefaultCase {
        const char* kind;
        const char* property;
        json expected;
    };
    const std::vector<DefaultCase> cases = {
        { "assert.size", "op", "lte" },
        { "assert.contains", "field", "body" },
        { "assert.contains", "mode", "contains" },
        { "assert.contains", "negate", false },
        { "assert.jsonpath", "negate", false },
        { "extract.json", "scope", "collection" },
        { "extract.regex", "scope", "collection" },
        { "extract.header", "scope", "collection" },
        { "extract.boundary", "scope", "collection" },
        { "extract.json", "required", false },
        { "extract.regex", "required", false },
        { "extract.header", "required", false },
        { "extract.boundary", "required", false },
        { "extract.regex", "field", "body" },
        { "timer.pacing", "perUser", true },
        { "timer.throughput", "perUser", false },
        { "control.throughput", "perUser", true },
        { "script.pre", "inline", false },
        { "script.post", "inline", false },
    };
    const json catalogue = vayu::core::elements_catalogue ();
    for (const auto& entry : cases) {
        const json* schema = property_schema (catalogue, entry.kind, entry.property);
        ASSERT_NE (schema, nullptr) << entry.kind << "." << entry.property;
        const auto found = schema->find ("default");
        ASSERT_NE (found, schema->end ())
        << entry.kind << "." << entry.property << " declares no default";
        EXPECT_EQ (*found, entry.expected) << entry.kind << "." << entry.property;
    }
}

// A property that is required cannot be absent, and one whose absence is a
// state of its own (`exists` unset means "not asserting existence", an
// unset `percent` / `everyN` means "no budget") has no value to show for it.
TEST_F (ElementsRegistryTest, NoDefaultIsDeclaredWhereAbsenceMeansSomethingElse) {
    const json catalogue = vayu::core::elements_catalogue ();
    for (const auto& kind : catalogue) {
        if (!kind["configSchema"].contains ("required")) {
            continue;
        }
        const auto* kind_name = kind["kind"].get_ptr<const std::string*> ();
        ASSERT_NE (kind_name, nullptr);
        for (const auto& required : kind["configSchema"]["required"]) {
            const auto* name = required.get_ptr<const std::string*> ();
            ASSERT_NE (name, nullptr);
            const json* schema = property_schema (catalogue, *kind_name, *name);
            if (schema == nullptr) {
                continue;
            }
            EXPECT_FALSE (schema->contains ("default"))
            << *kind_name << "." << *name << " is required";
        }
    }
    const std::vector<std::pair<const char*, const char*>> tri_state = {
        { "assert.jsonpath", "exists" },
        { "control.throughput", "percent" },
        { "control.throughput", "everyN" },
        { "assert.status", "range" },
        { "assert.status", "in" },
    };
    for (const auto& [kind, property] : tri_state) {
        const json* schema = property_schema (catalogue, kind, property);
        ASSERT_NE (schema, nullptr) << kind << "." << property;
        EXPECT_FALSE (schema->contains ("default")) << kind << "." << property;
    }
}

class ElementsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_elements_route.db";

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

    std::string make_collection () {
        auto [status, body] = create_collection_response (*db_, json{ { "name", "C" } });
        EXPECT_EQ (status, 200);
        return body["id"].get<std::string> ();
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (ElementsRouteTest, PutWithAValidListStoresAndListsItThroughBothSerializers) {
    const std::string collection = make_collection ();
    const json elements =
    json::array ({ json{ { "id", "el_1" }, { "kind", "inherit.disable" },
    { "enabled", true }, { "config", { { "elementId", "el_ancestor" } } } } });

    auto [created_status, created] = create_request_response (*db_,
    json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
    { "url", "https://example.test" }, { "elements", elements } });
    ASSERT_EQ (created_status, 200);
    EXPECT_EQ (created["elements"], elements);

    const std::string id = created["id"].get<std::string> ();
    const json listed    = json::parse (list_requests_body (*db_, collection));
    ASSERT_EQ (listed.size (), 1u);
    EXPECT_EQ (listed[0]["elements"], elements)
    << "the list serializer disagreed with the single-request one on elements";

    auto [updated_status, updated] =
    update_request_response (*db_, id, json{ { "elements", nullptr } });
    ASSERT_EQ (updated_status, 200);
    EXPECT_EQ (updated["elements"], json::array ());
}

TEST_F (ElementsRouteTest, AnElementWithNoIdGetsOneAssignedRatherThanRefused) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
    json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
    { "url", "https://example.test" },
    { "elements",
    json::array ({ json{ { "kind", "inherit.disable" },
    { "config", { { "elementId", "el_ancestor" } } } } }) } });
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["elements"].size (), 1u);
    const auto id = body["elements"][0].value ("id", "");
    EXPECT_TRUE (id.rfind ("el_", 0) == 0)
    << "expected an 'el_'-prefixed id, got: " << id;
}

TEST_F (ElementsRouteTest, PutWithAnUnknownKindReturns400NamingIt) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
    json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
    { "url", "https://example.test" },
    { "elements", json::array ({ json{ { "id", "el_1" }, { "kind", "not.a.kind" } } }) } });
    ASSERT_EQ (status, 400);
    EXPECT_NE (body["error"]["message"].get<std::string> ().find ("not.a.kind"),
    std::string::npos);
}

TEST_F (ElementsRouteTest, LegacyScriptFieldsAreRefused) {
    // Issue #1514's clean cut (the owner's decision on #1512): no
    // transitional read/write alias, so a caller still sending
    // `preRequestScript` / `postRequestScript` / `tests` is refused rather
    // than silently accepted or ignored.
    const std::string collection = make_collection ();
    for (const char* key : { "preRequestScript", "postRequestScript", "tests" }) {
        auto [status, body] = create_request_response (*db_,
        json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
        { "url", "https://example.test" }, { key, "pm.test('ok', () => {});" } });
        EXPECT_EQ (status, 400) << key;
        EXPECT_NE (
        body["error"]["message"].get<std::string> ().find ("elements"), std::string::npos)
        << key;
    }
}

TEST_F (ElementsRouteTest, NeitherSerializerEmitsTheRetiredScriptKeys) {
    const std::string collection = make_collection ();
    auto [status, body]          = create_request_response (*db_,
    json{ { "collectionId", collection }, { "name", "R" }, { "method", "GET" },
    { "url", "https://example.test" },
    { "elements",
    json::array ({ json{ { "kind", "script.pre" },
    { "config", { { "script", "pm.test('ok', () => {});" } } } } }) } });
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("preRequestScript"));
    EXPECT_FALSE (body.contains ("postRequestScript"));
    EXPECT_EQ (body["elements"][0]["kind"], "script.pre");

    const json listed = json::parse (list_requests_body (*db_, collection));
    ASSERT_EQ (listed.size (), 1u);
    EXPECT_FALSE (listed[0].contains ("preRequestScript"));
    EXPECT_FALSE (listed[0].contains ("postRequestScript"));
}

/**
 * Writes the registry's catalogue to `tests/fixtures/element-kinds.json` on
 * every run (issue #1513's scope item 4), so the app's and MCP's future
 * conformance tests (#1516, #1517) have it without a running engine - the
 * same role `variable-resolution-conformance.json` plays for composition.
 *
 * A global `Environment`'s `SetUp` runs before any test suite's, in
 * particular before `ElementsRegistryTest::SetUpTestSuite` registers
 * `test.echo` - deliberately, since the fixture is a claim about what a real
 * build serves, not what this test binary adds to prove the registration
 * path.
 */
class ElementKindsFixtureWriter : public ::testing::Environment {
    public:
    void SetUp () override {
        const std::filesystem::path path =
        std::filesystem::path (__FILE__).parent_path () / "fixtures" / "element-kinds.json";
        std::ofstream out (path);
        out << vayu::core::elements_catalogue ().dump (2);
    }
};

} // namespace

// Called from main() before `RUN_ALL_TESTS` rather than as a namespace-scope
// static initialiser: `AddGlobalTestEnvironment(new ...)` running before
// `main` has no frame to catch an allocation failure in, which is exactly
// `engine/CLAUDE.md`'s "nothing at namespace scope is built at run time" rule
// (`cert-err58-cpp`).
void register_element_kinds_fixture_writer () {
    // gtest owns and deletes what `AddGlobalTestEnvironment` is handed - its
    // signature takes a raw pointer by contract, the same shape
    // `tests/task_queue.hpp`'s `pooled_task_queue` silences once for httplib's.
    // NOLINTNEXTLINE(cppcoreguidelines-owning-memory)
    ::testing::AddGlobalTestEnvironment (new ElementKindsFixtureWriter ());
}
