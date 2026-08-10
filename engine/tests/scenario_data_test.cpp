/**
 * @file tests/scenario_data_test.cpp
 * @brief The `{{data.column}}` binder (issue #402, phase A).
 *
 * Two halves are pinned here, and they are the ones the feature stands on:
 *
 *  - **The token survives composition.** `{{data.x}}` is not a variable, so an
 *    ordinary composition must leave it written as it stands - otherwise the
 *    runner has nothing left to bind and every data-driven request goes out
 *    with a hole where the value should be. That half is asserted through
 *    `resolve_template`, because that is the function composition actually
 *    calls.
 *  - **The binder substitutes exactly what composition substitutes** - URL,
 *    header names and values, raw body, form fields - and refuses a column the
 *    row does not carry rather than quietly writing "".
 */

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>
#include <string>

#include "vayu/core/scenario_data.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/types.hpp"

using nlohmann::json;
using vayu::core::bind_data_row;
using vayu::core::render_data_value;

namespace {

vayu::Request request_with_url (const std::string& url) {
    vayu::Request request;
    request.url = url;
    return request;
}

} // namespace

// ---------------------------------------------------------------------------
// The namespace is reserved, and composition leaves it alone
// ---------------------------------------------------------------------------

TEST (ScenarioDataNamespaceTest, ComposingLeavesADataTokenWrittenAsItStands) {
    vayu::http::VariableValues vars{ { "host", "api.test" } };
    EXPECT_EQ (vayu::http::resolve_template ("https://{{host}}/u/{{data.id}}", vars),
    "https://api.test/u/{{data.id}}");
}

TEST (ScenarioDataNamespaceTest, AVariableNamedLikeAColumnDoesNotAnswerForIt) {
    // The namespace is disjoint from the tiers rather than above them: a
    // variable someone happens to name `data.id` is a different name from the
    // column `{{data.id}}`, so it must not be substituted here. Revert the
    // ordering in `resolve_template` and this reads "shadowed".
    vayu::http::VariableValues vars{ { "data.id", "shadowed" } };
    EXPECT_EQ (vayu::http::resolve_template ("{{data.id}}", vars), "{{data.id}}");
}

TEST (ScenarioDataNamespaceTest, ThePrefixAloneIsNotAColumnReference) {
    // `{{data.}}` names nothing, so no iteration could ever bind it. It falls
    // through to the ordinary unknown-name rule instead of surviving as a token
    // that would reach the wire verbatim.
    vayu::http::VariableValues vars;
    EXPECT_EQ (vayu::http::resolve_template ("a{{data.}}b", vars), "ab");
    EXPECT_EQ (vayu::http::resolve_template ("a{{data}}b", vars), "ab");
}

TEST (ScenarioDataNamespaceTest, TheNameIsTrimmedTheSameWayEveryOtherNameIs) {
    vayu::http::VariableValues vars;
    EXPECT_TRUE (vayu::http::is_data_variable_name ("data.id"));
    EXPECT_FALSE (vayu::http::is_data_variable_name ("dataset"));
    EXPECT_EQ (vayu::http::resolve_template ("{{ data.id }}", vars), "{{ data.id }}");
}

// ---------------------------------------------------------------------------
// Value rendering
// ---------------------------------------------------------------------------

TEST (ScenarioDataValueTest, StringsAreByteExactAndOtherTypesRenderAsJson) {
    // The CSV/TSV path produces only strings, so the first case is the ordinary
    // one and it must not go through a JSON quoting round trip.
    EXPECT_EQ (render_data_value (json ("007")), "007");
    EXPECT_EQ (render_data_value (json (7)), "7");
    EXPECT_EQ (render_data_value (json (true)), "true");
    EXPECT_EQ (render_data_value (json (nullptr)), "");
    EXPECT_EQ (render_data_value (json::parse (R"({"a":1})")), R"({"a":1})");
    EXPECT_EQ (render_data_value (json::parse (R"([1,2])")), "[1,2]");
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

TEST (ScenarioDataBindTest, TheUrlTakesTheRowsValue) {
    auto request =
    request_with_url ("https://api.test/users/{{data.id}}?q={{data.q}}");
    const auto result =
    bind_data_row (request, json::parse (R"({"id":"42","q":"ada"})"), 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.url, "https://api.test/users/42?q=ada");
}

TEST (ScenarioDataBindTest, HeaderNamesAndValuesBothBind) {
    // Composition resolves header *names* too - the payload carries headers as
    // `[{key, value}]` and every string in that array is resolved - so the
    // binder has to cover the same ground or the two disagree.
    auto request                     = request_with_url ("https://api.test/");
    request.headers["X-{{data.hn}}"] = "Bearer {{data.token}}";

    const auto result =
    bind_data_row (request, json::parse (R"({"hn":"Tenant","token":"t-1"})"), 0);

    ASSERT_TRUE (result.ok) << result.error;
    ASSERT_EQ (request.headers.size (), 1u);
    EXPECT_EQ (request.headers.begin ()->first, "X-Tenant");
    EXPECT_EQ (request.headers.begin ()->second, "Bearer t-1");
}

TEST (ScenarioDataBindTest, TheRawBodyAndEveryFormFieldBind) {
    auto request         = request_with_url ("https://api.test/");
    request.body.mode    = vayu::BodyMode::Json;
    request.body.content = R"({"email":"{{data.email}}"})";
    request.body.fields  = { { "{{data.field}}", "{{data.value}}", true } };

    const auto result = bind_data_row (
    request, json::parse (R"({"email":"a@b.c","field":"k","value":"v"})"), 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, R"({"email":"a@b.c"})");
    ASSERT_EQ (request.body.fields.size (), 1u);
    EXPECT_EQ (request.body.fields[0].key, "k");
    EXPECT_EQ (request.body.fields[0].value, "v");
}

TEST (ScenarioDataBindTest, AColumnTheRowDoesNotCarryIsAnErrorNotAnEmptyString) {
    // The whole point of the token is that the value came from the file, so a
    // silently blank field is the failure this namespace exists to remove.
    // Revert to substituting "" and this passes with a request pointing at
    // `https://api.test/users/`.
    auto request = request_with_url ("https://api.test/users/{{data.missing}}");
    const auto result = bind_data_row (request, json::parse (R"({"id":"42"})"), 3);

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("{{data.missing}}"), std::string::npos)
    << result.error;
    EXPECT_NE (result.error.find ("row 3"), std::string::npos) << result.error;
    // The columns the row *does* have, so the fix does not need the file open.
    EXPECT_NE (result.error.find ("id"), std::string::npos) << result.error;
}

TEST (ScenarioDataBindTest, TheFirstMissingColumnIsTheOneNamed) {
    auto request = request_with_url (
    "https://api.test/{{data.first_missing}}/{{data.also_missing}}");
    const auto result = bind_data_row (request, json::parse (R"({"id":"1"})"), 0);

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("first_missing"), std::string::npos) << result.error;
    EXPECT_EQ (result.error.find ("also_missing"), std::string::npos) << result.error;
}

TEST (ScenarioDataBindTest, ANonDataTokenIsLeftAlone) {
    // Composition already had its turn. An unresolved `{{host}}` reaching here
    // means something upstream left it, and eating it would hide that.
    auto request = request_with_url ("https://{{host}}/u/{{data.id}}");
    const auto result = bind_data_row (request, json::parse (R"({"id":"42"})"), 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.url, "https://{{host}}/u/42");
}

TEST (ScenarioDataBindTest, ARequestWithNoTokensIsUnchanged) {
    auto request              = request_with_url ("https://api.test/users");
    request.headers["Accept"] = "application/json";
    request.body.content      = "{}";

    const auto result = bind_data_row (request, json::parse (R"({"id":"42"})"), 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.url, "https://api.test/users");
    EXPECT_EQ (request.headers.at ("Accept"), "application/json");
    EXPECT_EQ (request.body.content, "{}");
}

TEST (ScenarioDataBindTest, ASubstitutedValueIsNeverRescanned) {
    // One pass, exactly as `resolve_template` promises: a cell whose text looks
    // like a token is data, not an instruction.
    auto request = request_with_url ("https://api.test/{{data.a}}");
    const auto result =
    bind_data_row (request, json::parse (R"({"a":"{{data.b}}","b":"no"})"), 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.url, "https://api.test/{{data.b}}");
}

// ---------------------------------------------------------------------------
// The pre-run scan: a token nothing can bind (issue #415)
//
// Driven through the step template, which is what plan resolution builds and
// reads `first_token()` off - the scan is the split with no row behind it.
// ---------------------------------------------------------------------------

TEST (ScenarioDataScanTest, ARequestWithNoDataTokenScansClean) {
    auto request = request_with_url ("https://api.test/{{host}}/users");
    request.headers["Accept"] = "application/json";
    request.body.mode         = vayu::BodyMode::Json;
    request.body.content      = R"({"n":1})";
    request.body.fields       = { { "k", "v", true } };

    EXPECT_FALSE (vayu::core::tokenize_data_fields (request).first_token ().has_value ());
}

TEST (ScenarioDataScanTest, EveryFieldTheBinderSubstitutesIsAFieldTheScanSees) {
    // The pairing that matters: a field the binder would bind and the scan
    // would miss is a token that survives the refusal and reaches the wire.
    // Each case seeds exactly one field, so a hole names itself.
    const auto seen = [] (const vayu::Request& request) {
        return vayu::core::tokenize_data_fields (request).first_token ().value_or ("<none>");
    };

    EXPECT_EQ (seen (request_with_url ("https://api.test/{{data.id}}")), "{{data.id}}");

    {
        auto request = request_with_url ("https://api.test/");
        request.headers["X-{{data.hn}}"] = "plain";
        EXPECT_EQ (seen (request), "{{data.hn}}");
    }
    {
        auto request                = request_with_url ("https://api.test/");
        request.headers["X-Tenant"] = "{{data.token}}";
        EXPECT_EQ (seen (request), "{{data.token}}");
    }
    {
        auto request         = request_with_url ("https://api.test/");
        request.body.content = R"({"email":"{{data.email}}"})";
        EXPECT_EQ (seen (request), "{{data.email}}");
    }
    {
        auto request        = request_with_url ("https://api.test/");
        request.body.fields = { { "{{data.field}}", "v", true } };
        EXPECT_EQ (seen (request), "{{data.field}}");
    }
    {
        auto request        = request_with_url ("https://api.test/");
        request.body.fields = { { "k", "{{data.value}}", true } };
        EXPECT_EQ (seen (request), "{{data.value}}");
    }
}

TEST (ScenarioDataScanTest, TheScanLeavesTheRequestAlone) {
    // It answers a question; it must not be a substitution pass with no row.
    auto request = request_with_url ("https://api.test/{{data.id}}");
    request.headers["X-{{data.hn}}"] = "{{data.token}}";
    request.body.content             = "{{data.body}}";
    const auto before                = request.url;

    EXPECT_TRUE (vayu::core::tokenize_data_fields (request).first_token ().has_value ());
    EXPECT_EQ (request.url, before);
    EXPECT_EQ (request.headers.at ("X-{{data.hn}}"), "{{data.token}}");
    EXPECT_EQ (request.body.content, "{{data.body}}");
}

// ---------------------------------------------------------------------------
// Split once, joined per row (issue #449)
// ---------------------------------------------------------------------------

TEST (ScenarioDataTemplateTest, AStepWithNoDataTokenHasAnEmptyTemplate) {
    // The zero-cost claim, as a test rather than a comment: the load executor
    // tests exactly this before doing any join work, so a template that came
    // back non-empty here would put a per-iteration walk on a plan that has
    // nothing to bind.
    auto request = request_with_url ("https://api.test/{{host}}/users");
    request.headers["X-Tenant"] = "acme";
    request.body.content        = R"({"n":1})";
    request.body.fields         = { { "k", "v", true } };

    EXPECT_TRUE (vayu::core::tokenize_data_fields (request).empty ());
}

TEST (ScenarioDataTemplateTest, ATemplateJoinsTheSameTextTheScannerWouldSubstitute) {
    // One binder for both executors: the template path and the convenience
    // `bind_data_row` must agree field for field, or a step binds differently
    // depending on which executor ran it.
    const json row = { { "id", "42" }, { "hn", "Acme" }, { "token", "t-1" },
        { "email", "a@b.c" }, { "field", "fk" }, { "value", "fv" } };

    auto make = [] () {
        auto request = request_with_url ("https://api.test/{{data.id}}");
        request.headers["X-{{data.hn}}"] = "{{data.token}}";
        request.body.content             = R"({"email":"{{data.email}}"})";
        request.body.fields = { { "{{data.field}}", "{{data.value}}", true } };
        return request;
    };

    auto templated  = make ();
    const auto tmpl = vayu::core::tokenize_data_fields (templated);
    ASSERT_TRUE (vayu::core::apply_data_template (templated, tmpl, row, 0).ok);

    auto scanned = make ();
    ASSERT_TRUE (bind_data_row (scanned, row, 0).ok);

    EXPECT_EQ (templated.url, "https://api.test/42");
    EXPECT_EQ (templated.url, scanned.url);
    EXPECT_EQ (templated.headers.at ("X-Acme"), "t-1");
    EXPECT_EQ (templated.headers.at ("X-Acme"), scanned.headers.at ("X-Acme"));
    EXPECT_EQ (templated.body.content, R"({"email":"a@b.c"})");
    EXPECT_EQ (templated.body.content, scanned.body.content);
    EXPECT_EQ (templated.body.fields[0].key, "fk");
    EXPECT_EQ (templated.body.fields[0].value, "fv");
}

TEST (ScenarioDataTemplateTest, ATemplateIsReusableAcrossRows) {
    // What the load path relies on: one split, many joins. A template that read
    // anything off the first row would bind every later iteration to it.
    auto request =
    request_with_url ("https://api.test/u/{{data.id}}/{{data.id}}");
    const auto tmpl = vayu::core::tokenize_data_fields (request);

    for (const char* id : { "1", "2", "3" }) {
        auto bound = request;
        ASSERT_TRUE (
        vayu::core::apply_data_template (bound, tmpl, json{ { "id", id } }, 0).ok);
        EXPECT_EQ (bound.url, std::string ("https://api.test/u/") + id + "/" + id);
    }
}

TEST (ScenarioDataTemplateTest, AnAbsentColumnFailsTheJoinAndNamesTheRow) {
    auto request    = request_with_url ("https://api.test/{{data.missing}}");
    const auto tmpl = vayu::core::tokenize_data_fields (request);

    const auto bound =
    vayu::core::apply_data_template (request, tmpl, json{ { "id", "1" } }, 7);
    EXPECT_FALSE (bound.ok);
    EXPECT_NE (bound.error.find ("{{data.missing}}"), std::string::npos)
    << bound.error;
    EXPECT_NE (bound.error.find ("row 7"), std::string::npos) << bound.error;
    EXPECT_NE (bound.error.find ("id"), std::string::npos) << bound.error;
}

TEST (ScenarioDataScanTest, ThePrefixAloneIsNotSomethingToRefuse) {
    // `{{data.}}` names no column, so composition already resolved it to "" and
    // there is nothing left to send literally. Refusing it would block a run
    // over a token that never reaches the wire.
    EXPECT_FALSE (vayu::core::tokenize_data_fields (
    request_with_url ("https://api.test/{{data.}}"))
                  .first_token ()
                  .has_value ());
}
