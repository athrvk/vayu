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
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/header_text.hpp"
#include "vayu/http/jsonrpc_body.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/encoding.hpp"

using nlohmann::json;
using vayu::core::bind_data_row;
using vayu::http::render_data_value;

namespace {

vayu::Request request_with_url (const std::string& url) {
    vayu::Request request;
    request.url = url;
    return request;
}

/// Split @p request against @p columns and join @p row into it - the whole of
/// what a bare-column case (issue #1007) does, spelled once because the column
/// set is the only thing those cases vary, and `bind_data_row` derives it from
/// the row rather than taking it.
vayu::core::DataBindResult bind_with_columns (vayu::Request& request,
const vayu::http::BoundColumnNames& columns,
const nlohmann::json& row,
size_t row_index = 0) {
    return vayu::core::apply_iteration_template (request,
    vayu::core::tokenize_bindable_fields (request, columns),
    vayu::core::IterationBinding{ &row, row_index, {} });
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

TEST (ScenarioDataNamespaceTest, ADataTokenWrittenIntoAVariableValueStillBinds) {
    // The data pass scans the *composed* text, not the authored text, so a
    // token that arrived as a variable's value is bound like any other. It
    // follows from two rules that are each pinned elsewhere - composition is
    // one pass, so `{{host}}`'s value is never rescanned for variables, and the
    // data pass runs afterwards over what composition produced - but the
    // combination is what a user relies on and nothing asserted it (issue #595,
    // item 3).
    vayu::http::VariableValues vars{ { "endpoint", "/u/{{data.id}}" } };
    const auto composed =
    vayu::http::resolve_template ("https://api.test{{endpoint}}", vars);
    ASSERT_EQ (composed, "https://api.test/u/{{data.id}}");

    auto request = request_with_url (composed);
    const auto result = bind_data_row (request, json::parse (R"({"id":"42"})"), 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.url, "https://api.test/u/42");
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
    // through to the ordinary unknown-name rule - which since #1009 also leaves
    // the token written as it stands. The two rules agree on the text and not
    // on the reason: the namespace keeps a token *for* a later binder, and an
    // unknown name keeps one because nothing will ever answer it. What this
    // case still pins is that neither `data.` nor `data` is treated as a
    // column, so no scan and no bind reads one.
    vayu::http::VariableValues vars;
    EXPECT_FALSE (vayu::http::is_data_variable_name ("data."));
    EXPECT_FALSE (vayu::http::is_data_variable_name ("data"));
    EXPECT_EQ (vayu::http::resolve_template ("a{{data.}}b", vars), "a{{data.}}b");
    EXPECT_EQ (vayu::http::resolve_template ("a{{data}}b", vars), "a{{data}}b");
    // A defined variable of either name answers, which is what says they took
    // the ordinary path rather than the reserved one.
    vars["data."] = "dot";
    vars["data"]  = "bare";
    EXPECT_EQ (vayu::http::resolve_template ("a{{data.}}b{{data}}c", vars), "adotbbarec");
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

// ---------------------------------------------------------------------------
// Two header names that bind to one name (issue #595, item 2)
// ---------------------------------------------------------------------------

TEST (ScenarioDataHeaderCollisionTest, ABoundNameCollidingWithALiteralHeaderRefusesTheRow) {
    // The failure the refusal exists for: the collision belongs to the *row*,
    // so a first-wins insert sends good requests until the file reaches a row
    // that binds `authorization`, and then one request without its auth. Revert
    // the rebuild to a plain `emplace` and this reads `ok`, with the request
    // carrying one header instead of two.
    // The collision is case-insensitive because `vayu::Headers` is: the bound
    // `authorization` and the literal `Authorization` are one header name.
    auto request                     = request_with_url ("https://api.test/");
    request.headers["Authorization"] = "Bearer real";
    request.headers["{{data.h}}"]    = "bound";

    const auto result =
    bind_data_row (request, json::parse (R"({"h":"authorization"})"), 3);

    EXPECT_FALSE (result.ok);
    // Enough to fix the request without opening the file: the header as it is
    // written, the name it produced, and the row that produced it.
    EXPECT_NE (result.error.find ("{{data.h}}"), std::string::npos) << result.error;
    EXPECT_NE (result.error.find ("Authorization"), std::string::npos) << result.error;
    EXPECT_NE (result.error.find ("row 3"), std::string::npos) << result.error;
}

TEST (ScenarioDataHeaderCollisionTest, TwoTemplatedNamesBindingToOneNameRefuseTheRow) {
    // Neither header is literal here, so the collision exists only in the bound
    // result - there is no spelling of the request that shows it.
    auto request                    = request_with_url ("https://api.test/");
    request.headers["X-{{data.a}}"] = "first";
    request.headers["X-{{data.b}}"] = "second";

    const auto result =
    bind_data_row (request, json::parse (R"({"a":"Tenant","b":"Tenant"})"), 0);

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("X-Tenant"), std::string::npos) << result.error;
}

TEST (ScenarioDataHeaderCollisionTest, AMissingColumnIsReportedRatherThanTheCollisionItCauses) {
    // The joiner stops rewriting at its first fault, so the half-bound walk can
    // leave two names equal by accident. The missing column is the real fault
    // and the one the message must name.
    auto request                    = request_with_url ("https://api.test/");
    request.headers["X-{{data.a}}"] = "first";
    request.headers["X-{{data.b}}"] = "second";

    const auto result = bind_data_row (request, json::parse (R"({"a":"Tenant"})"), 0);

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("{{data.b}}"), std::string::npos) << result.error;
    EXPECT_EQ (result.error.find ("already resolves to"), std::string::npos)
    << result.error;
}

TEST (ScenarioDataHeaderCollisionTest, HeadersThatStayDistinctStillBind) {
    // The refusal must not fire on the ordinary bind - including one where a
    // bound name merely differs in case from a *different* header.
    auto request                    = request_with_url ("https://api.test/");
    request.headers["X-Tenant"]     = "acme";
    request.headers["X-{{data.h}}"] = "bound";

    const auto result = bind_data_row (request, json::parse (R"({"h":"Region"})"), 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.headers.size (), 2u);
    EXPECT_EQ (request.headers.at ("X-Tenant"), "acme");
    EXPECT_EQ (request.headers.at ("X-Region"), "bound");
}

// ---------------------------------------------------------------------------
// A cell that would end the header line it is bound into (issue #732)
// ---------------------------------------------------------------------------

TEST (ScenarioDataHeaderLineBreakTest, ACrlfCellBoundIntoAHeaderValueRefusesTheRow) {
    // The failure the refusal exists for: a header line ends at CRLF, so this
    // cell does not put its text in `X-Note` - it ends `X-Note` and makes
    // `X-Admin: true` a header of its own, forged by a data file. Revert the
    // Header-context check in the joiner and this reads `ok`, with
    // `X-Note` holding the line break for libcurl to do as it likes with.
    // JSONL rows keep native strings, so the cell is an ordinary one.
    auto request              = request_with_url ("https://api.test/");
    request.headers["X-Note"] = "{{data.note}}";

    const auto result =
    bind_data_row (request, json::parse (R"({"note":"ok\r\nX-Admin: true"})"), 4);

    EXPECT_FALSE (result.ok);
    // Enough to fix the file without guessing which column: the token, and the
    // row it came from.
    EXPECT_NE (result.error.find ("{{data.note}}"), std::string::npos) << result.error;
    EXPECT_NE (result.error.find ("row 4"), std::string::npos) << result.error;
}

TEST (ScenarioDataHeaderLineBreakTest, ABareLineFeedIsRefusedToo) {
    // Neither byte is the terminator on its own, and neither is safe: a lone LF
    // ends the line for a lenient parser and a lone CR for another. The check
    // is on both rather than on the CRLF pair.
    auto request              = request_with_url ("https://api.test/");
    request.headers["X-Note"] = "prefix {{data.note}}";
    const auto lf = bind_data_row (request, json::parse (R"({"note":"a\nb"})"), 0);
    EXPECT_FALSE (lf.ok) << lf.error;

    auto with_cr              = request_with_url ("https://api.test/");
    with_cr.headers["X-Note"] = "{{data.note}}";
    const auto cr = bind_data_row (with_cr, json::parse (R"({"note":"a\rb"})"), 0);
    EXPECT_FALSE (cr.ok) << cr.error;
}

TEST (ScenarioDataHeaderLineBreakTest, AHeaderNameIsCheckedAsWellAsItsValue) {
    // Composition resolves header names too, so a name is as forgeable as a
    // value - `X-a: x\r\nX-Admin: true` is one bound name away from the same
    // request.
    auto request                     = request_with_url ("https://api.test/");
    request.headers["X-{{data.hn}}"] = "plain";

    const auto result =
    bind_data_row (request, json::parse (R"({"hn":"a: x\r\nX-Admin"})"), 0);

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("{{data.hn}}"), std::string::npos) << result.error;
}

TEST (ScenarioDataHeaderLineBreakTest, TheBindRuleIsTheOneSharedHeaderTextRule) {
    // #738 gave the same rule two more layers - the composer, which names the
    // variable that carried the byte, and the pre-send gate, which catches
    // every other origin. Three private copies of "what a header cannot hold"
    // would drift the way the design-path and scenario-path binding resolution
    // did in #716, so there is one predicate and this pins the bind path to it.
    // The composer's suite pins its own layer to the same function.
    for (const std::string cell :
    { "plain", "a b", "a\tb", "a: b", "a\nb", "a\rb", "a\r\nb" }) {
        auto request              = request_with_url ("https://api.test/");
        request.headers["X-Note"] = "{{data.note}}";
        json row                  = json::object ();
        row["note"]               = cell;

        const auto result = bind_data_row (request, row, 0);
        EXPECT_EQ (result.ok, !vayu::http::ends_a_header_line (cell))
        << "cell: " << json (cell).dump () << " - " << result.error;
    }
}

TEST (ScenarioDataHeaderLineBreakTest, TheSameCellIsFineEverywhereElse) {
    // The refusal is a header rule, not a rule about the cell: the same bytes
    // are ordinary content in a body and in a form field's value, where a JSON
    // document escapes them and a text one carries them as written. Widen the
    // check past the header context and this fails.
    auto request         = request_with_url ("https://api.test/");
    request.body.mode    = vayu::BodyMode::Json;
    request.body.content = R"({"note":"{{data.note}}"})";
    request.body.fields  = { { "note", "{{data.note}}", true } };

    const auto result = bind_data_row (request, json::parse (R"({"note":"a\r\nb"})"), 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, R"({"note":"a\r\nb"})");
    ASSERT_EQ (request.body.fields.size (), 1u);
    EXPECT_EQ (request.body.fields[0].value, "a\r\nb");
}

TEST (ScenarioDataHeaderLineBreakTest, AnOrdinaryHeaderCellStillBinds) {
    // The refusal must not fire on a value that merely carries whitespace - a
    // tab and a space are legal in a header value and always were.
    auto request              = request_with_url ("https://api.test/");
    request.headers["X-Note"] = "{{data.note}}";

    const auto result = bind_data_row (request, json::parse (R"({"note":"a b\tc"})"), 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.headers.at ("X-Note"), "a b\tc");
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
// A value is written for the document it lands in (issue #593)
// ---------------------------------------------------------------------------

TEST (ScenarioDataJsonBodyTest, AQuoteBearingCellCannotBreakTheJsonBody) {
    // Wire-proven before the fix: `{"note":"has,comma "quoted""}` went out as
    // it stands. Revert the escaping and this body stops parsing.
    auto request         = request_with_url ("https://api.test/");
    request.body.mode    = vayu::BodyMode::Json;
    request.body.content = R"({"note":"{{data.note}}"})";

    const auto result =
    bind_data_row (request, json{ { "note", R"(has,comma "quoted")" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    const auto parsed = json::parse (request.body.content, nullptr, false);
    ASSERT_FALSE (parsed.is_discarded ()) << request.body.content;
    // The cell's text is intact, not merely parseable: escaping must not eat
    // the value it was protecting.
    EXPECT_EQ (parsed.at ("note").get<std::string> (), R"(has,comma "quoted")");
}

TEST (ScenarioDataJsonBodyTest, BackslashesAndControlCharactersAreEscapedToo) {
    auto request         = request_with_url ("https://api.test/");
    request.body.mode    = vayu::BodyMode::Json;
    request.body.content = R"({"p":"{{data.p}}"})";

    const auto result =
    bind_data_row (request, json{ { "p", "C:\\tmp\nline\twith\x01" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    const auto parsed = json::parse (request.body.content, nullptr, false);
    ASSERT_FALSE (parsed.is_discarded ()) << request.body.content;
    EXPECT_EQ (parsed.at ("p").get<std::string> (), "C:\\tmp\nline\twith\x01");
}

TEST (ScenarioDataJsonBodyTest, ATypedPlacementOutsideAStringStaysUnquoted) {
    // The escaping is decided per token, from the literals around it: the same
    // body carries one token inside a string and one outside, and only the
    // first is escaped. Escape both and the number arrives as `"2"`.
    auto request         = request_with_url ("https://api.test/");
    request.body.mode    = vayu::BodyMode::Json;
    request.body.content = R"({"n":{{data.n}},"note":"{{data.note}}"})";

    const auto result =
    bind_data_row (request, json{ { "n", 2 }, { "note", R"(a "b")" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    const auto parsed = json::parse (request.body.content, nullptr, false);
    ASSERT_FALSE (parsed.is_discarded ()) << request.body.content;
    EXPECT_TRUE (parsed.at ("n").is_number ()) << request.body.content;
    EXPECT_EQ (parsed.at ("n").get<int> (), 2);
    EXPECT_EQ (parsed.at ("note").get<std::string> (), R"(a "b")");
}

TEST (ScenarioDataJsonBodyTest, AnEscapedQuoteInTheTemplateDoesNotFlipTheState) {
    // The state scan has to read the template's own escapes the way JSON does,
    // or the token after `\"` is judged to be outside the string it is in.
    auto request         = request_with_url ("https://api.test/");
    request.body.mode    = vayu::BodyMode::Json;
    request.body.content = R"({"note":"said \" then {{data.note}}"})";

    const auto result = bind_data_row (request, json{ { "note", R"(x"y)" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    const auto parsed = json::parse (request.body.content, nullptr, false);
    ASSERT_FALSE (parsed.is_discarded ()) << request.body.content;
    EXPECT_EQ (parsed.at ("note").get<std::string> (), R"(said " then x"y)");
}

TEST (ScenarioDataJsonBodyTest, ANonJsonBodyTakesTheValueByteForByte) {
    // A text body has no quoting rule of its own, so escaping it would corrupt
    // the value instead of protecting the document.
    auto request         = request_with_url ("https://api.test/");
    request.body.mode    = vayu::BodyMode::Text;
    request.body.content = "note: {{data.note}}";

    const auto result = bind_data_row (request, json{ { "note", R"(a "b" \ c)" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, R"(note: a "b" \ c)");
}

TEST (ScenarioDataJsonBodyTest, TheUrlAndHeadersAreNeverEscapedForAJsonBody) {
    // The context is per field, not per request: a JSON body must not make the
    // URL of the same request start escaping quotes.
    auto request = request_with_url ("https://api.test/?q={{data.q}}");
    request.headers["X-Note"] = "{{data.q}}";
    request.body.mode         = vayu::BodyMode::Json;
    request.body.content      = R"({"q":"{{data.q}}"})";

    const auto result = bind_data_row (request, json{ { "q", R"(a"b)" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.url, R"(https://api.test/?q=a"b)");
    EXPECT_EQ (request.headers.at ("X-Note"), R"(a"b)");
    EXPECT_EQ (request.body.content, R"({"q":"a\"b"})");
}

TEST (ScenarioDataJsonBodyTest, AGraphqlEnvelopeIsAJsonDocumentAndABareOneIsNot) {
    // `graphql` content is either shape. The envelope has string literals a
    // token can sit inside; a bare document is escaped wholesale when
    // `graphql_wire_body` wraps it, so escaping it here would double it.
    {
        auto request         = request_with_url ("https://api.test/");
        request.body.mode    = vayu::BodyMode::GraphQL;
        request.body.content = R"({"query":"{ u(n:\"{{data.n}}\") }"})";

        ASSERT_TRUE (bind_data_row (request, json{ { "n", R"(a"b)" } }, 0).ok);
        const auto parsed = json::parse (request.body.content, nullptr, false);
        ASSERT_FALSE (parsed.is_discarded ()) << request.body.content;
        EXPECT_EQ (parsed.at ("query").get<std::string> (), R"({ u(n:"a"b") })");
    }
    {
        auto request         = request_with_url ("https://api.test/");
        request.body.mode    = vayu::BodyMode::GraphQL;
        request.body.content = R"({ u(n: "{{data.n}}") })";

        ASSERT_TRUE (bind_data_row (request, json{ { "n", "ada" } }, 0).ok);
        EXPECT_EQ (request.body.content, R"({ u(n: "ada") })");
    }
}

TEST (ScenarioDataJsonBodyTest, ABoundJsonRpcCallStillGetsItsEnvelope) {
    // The downstream compounding the corruption caused: the wire-time envelope
    // parses the body, so a body broken by the bind was passed through
    // unstamped. Binding cleanly is what un-breaks it.
    auto request         = request_with_url ("https://api.test/");
    request.body.mode    = vayu::BodyMode::JsonRpc;
    request.body.content = R"({"method":"note","params":{"t":"{{data.t}}"}})";

    ASSERT_TRUE (bind_data_row (request, json{ { "t", R"(a"b)" } }, 0).ok);

    const auto wire =
    json::parse (vayu::http::jsonrpc_wire_body (request.body.content), nullptr, false);
    ASSERT_FALSE (wire.is_discarded ()) << request.body.content;
    EXPECT_EQ (wire.at ("jsonrpc").get<std::string> (), "2.0");
    EXPECT_EQ (wire.at ("params").at ("t").get<std::string> (), R"(a"b)");
}

TEST (ScenarioDataJsonBodyTest, ANullCellIsAnErrorNotAnErasedValue) {
    // The missing-column principle, one type down. Render it as "" instead and
    // this body goes out as `{"n": }` - invalid, silently.
    auto request         = request_with_url ("https://api.test/");
    request.body.mode    = vayu::BodyMode::Json;
    request.body.content = R"({"n":{{data.n}}})";

    const auto result = bind_data_row (request, json{ { "n", nullptr } }, 4);

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("{{data.n}}"), std::string::npos) << result.error;
    EXPECT_NE (result.error.find ("null"), std::string::npos) << result.error;
    EXPECT_NE (result.error.find ("row 4"), std::string::npos) << result.error;
}

TEST (ScenarioDataJsonBodyTest, ANullCellIsRefusedWhereverItIsPlaced) {
    // Not a JSON-body rule: a null in a URL is the same quietly-blank field.
    auto request      = request_with_url ("https://api.test/u/{{data.id}}");
    const auto result = bind_data_row (request, json{ { "id", nullptr } }, 0);

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("{{data.id}}"), std::string::npos) << result.error;
    EXPECT_EQ (request.url, "https://api.test/u/{{data.id}}")
    << "a refused bind must not have half-written the field";
}

// ---------------------------------------------------------------------------
// An XML body is a document too, with its own rules (issue #618)
//
// Asserted as exact text rather than through a parser: the engine links no XML
// parser, and the text is the stronger claim anyway - "parses" would pass for a
// document whose shape the bind changed.
// ---------------------------------------------------------------------------

namespace {

/// A request whose body is the `xml` mode #580 added, carrying @p content.
vayu::Request xml_request (const std::string& content) {
    auto request         = request_with_url ("https://api.test/");
    request.body.mode    = vayu::BodyMode::Xml;
    request.body.content = content;
    return request;
}

} // namespace

TEST (ScenarioDataXmlBodyTest, AMetacharacterBearingCellCannotBreakTheDocument) {
    // The bug: `Ben & Jerry's` went out byte for byte and the server rejected
    // the body as malformed. Revert the escaping and `&` / `<` come back raw.
    auto request =
    xml_request ("<order><customer>{{data.name}}</customer></order>");

    const auto result =
    bind_data_row (request, json{ { "name", "Ben & Jerry's <boss>" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    // The apostrophe is left alone: it is legal in character data, and
    // rewriting it would make a name unreadable to protect nothing.
    EXPECT_EQ (request.body.content,
    "<order><customer>Ben &amp; Jerry's &lt;boss&gt;</customer></order>");
}

TEST (ScenarioDataXmlBodyTest, ACellCannotChangeTheShapeOfTheDocument) {
    // The worse half of the same bug: a cell closing the element it sits in
    // sends a document with a different shape, not merely a broken one.
    auto request =
    xml_request ("<order><customer>{{data.name}}</customer></order>");

    const auto result = bind_data_row (
    request, json{ { "name", "</customer><injected/><customer>" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, "<order><customer>&lt;/customer&gt;&lt;injected/&gt;&lt;customer&gt;</customer></order>");
}

TEST (ScenarioDataXmlBodyTest, AnAttributeValueEscapesTheDelimiterInForce) {
    // Which quote has to be escaped is the author's choice, not a constant, so
    // the scan carries the delimiter rather than escaping both - `it's` stays
    // readable in a double-quoted attribute.
    auto request = xml_request (R"(<o a="{{data.v}}" b='{{data.v}}'/>)");

    const auto result = bind_data_row (request, json{ { "v", R"(x"y'z&)" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, R"(<o a="x&quot;y'z&amp;" b='x"y&apos;z&amp;'/>)");
}

TEST (ScenarioDataXmlBodyTest, TheScanFollowsTheDocumentBackOutOfATag) {
    // One field, two tokens, three positions between them: attribute value,
    // then markup, then character data. Get the walk out of the tag wrong and
    // the second token is escaped as an attribute of a tag that already closed.
    auto request = xml_request (R"(<o a="{{data.a}}">{{data.b}}</o>)");

    const auto result =
    bind_data_row (request, json{ { "a", R"("q")" }, { "b", R"("q")" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, R"(<o a="&quot;q&quot;">"q"</o>)");
}

TEST (ScenarioDataXmlBodyTest, ACdataSectionTakesTheValueByteForByte) {
    // CDATA means "this is not markup", so escaping inside one would corrupt
    // the value the author chose the section to protect.
    auto request = xml_request ("<o><![CDATA[{{data.v}}]]></o>");

    const auto result = bind_data_row (request, json{ { "v", "a & b < c" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, "<o><![CDATA[a & b < c]]></o>");
}

TEST (ScenarioDataXmlBodyTest, ACdataSectionSurvivesAValueThatWouldEndIt) {
    // The one sequence a CDATA section cannot carry. Splitting the section and
    // reopening it keeps the character data uninterrupted - what a parser reads
    // back is the cell, and the element still closes where the author put it.
    auto request = xml_request ("<o><![CDATA[{{data.v}}]]></o>");

    const auto result = bind_data_row (request, json{ { "v", "a]]>b" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, "<o><![CDATA[a]]]]><![CDATA[>b]]></o>");
}

TEST (ScenarioDataXmlBodyTest, ATokenAfterACdataSectionIsCharacterDataAgain) {
    // The section's end has to be seen, or everything after it binds unescaped.
    auto request = xml_request ("<o><![CDATA[x]]>{{data.v}}</o>");

    const auto result = bind_data_row (request, json{ { "v", "a&b" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, "<o><![CDATA[x]]>a&amp;b</o>");
}

TEST (ScenarioDataXmlBodyTest, ADeclarationIsSteppedOverRatherThanBoundInto) {
    // `<?xml …?>` opens nearly every XML body there is. Read it as a tag and
    // the document's first element is judged to be markup for the rest of the
    // body, and nothing after it is ever escaped.
    auto request = xml_request (R"(<?xml version="1.0"?><o>{{data.v}}</o>)");

    const auto result = bind_data_row (request, json{ { "v", "a<b" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, R"(<?xml version="1.0"?><o>a&lt;b</o>)");
}

TEST (ScenarioDataXmlBodyTest, ATokenInsideACommentIsRefusedRatherThanEncoded) {
    // No encoding is right: the value is not sent at all, and one carrying
    // `-->` would end the comment and change the document. The row is refused
    // for every row alike - it is where the token is written that is wrong.
    auto request = xml_request ("<o><!-- {{data.v}} --><n>1</n></o>");

    const auto result = bind_data_row (request, json{ { "v", "x" } }, 0);

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("{{data.v}}"), std::string::npos) << result.error;
    EXPECT_NE (result.error.find ("comment"), std::string::npos) << result.error;
}

// Issue #995: a deferred generator is written for the document it lands in on
// exactly the same rules a cell is - the encoding is decided by the token's
// position at split time and never by which namespace answers it. Both
// directions here, because the interesting half of that claim is the refusal:
// a generator placed where no encoding is right must be refused rather than
// quietly written, the way a data token already is.
TEST (ScenarioDataXmlBodyTest, AGeneratorInCharacterDataIsEscapedLikeACell) {
    auto request = xml_request ("<o><id>{{$guid}}</id></o>");

    const auto result = vayu::core::apply_iteration_template (request,
    vayu::core::tokenize_bindable_fields (request), vayu::core::IterationBinding{});

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content.find ("{{$guid}}"), std::string::npos)
    << request.body.content;
    // A uuid carries nothing XML escapes, so the assertion that means something
    // is the shape: the value landed between the tags it was written between.
    EXPECT_NE (request.body.content.find ("<o><id>"), std::string::npos)
    << request.body.content;
    EXPECT_NE (request.body.content.find ("</id></o>"), std::string::npos)
    << request.body.content;
}

TEST (ScenarioDataXmlBodyTest, AGeneratorInsideACommentIsRefusedLikeACell) {
    auto request = xml_request ("<o><!-- {{$guid}} --><n>1</n></o>");

    const auto result = vayu::core::apply_iteration_template (request,
    vayu::core::tokenize_bindable_fields (request), vayu::core::IterationBinding{});

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("{{$guid}}"), std::string::npos) << result.error;
    EXPECT_NE (result.error.find ("comment"), std::string::npos) << result.error;
}

TEST (ScenarioDataXmlBodyTest, ATokenInsideAProcessingInstructionIsRefusedToo) {
    auto request = xml_request (R"(<?render style="{{data.v}}"?><o>1</o>)");

    const auto result = bind_data_row (request, json{ { "v", "x" } }, 0);

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("{{data.v}}"), std::string::npos) << result.error;
    EXPECT_NE (result.error.find ("processing instruction"), std::string::npos)
    << result.error;
}

TEST (ScenarioDataXmlBodyTest, TheRefusedPlacementIsNamedBeforeTheRowIsBlamed) {
    // A placement no encoding fits fails identically for every row, so naming
    // the missing column instead would send the reader to the file when the
    // request is what has to move.
    auto request = xml_request ("<o><!-- {{data.v}} --></o>");

    const auto result = bind_data_row (request, json{ { "other", "x" } }, 3);

    EXPECT_FALSE (result.ok);
    EXPECT_EQ (result.error.find ("does not have"), std::string::npos) << result.error;
    EXPECT_NE (result.error.find ("comment"), std::string::npos) << result.error;
}

TEST (ScenarioDataXmlBodyTest, ATagNameStillBindsVerbatim) {
    // The one position no escape could serve: a name cannot legally contain the
    // characters escaping would produce, so a bound name is written as it is -
    // which is what it did before this rule, and what an author templating an
    // element name relies on.
    auto request = xml_request ("<{{data.tag}}>x</{{data.tag}}>");

    const auto result = bind_data_row (request, json{ { "tag", "item" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, "<item>x</item>");
}

TEST (ScenarioDataXmlBodyTest, AnOrdinaryValueIsByteIdenticalToBeforeTheRule) {
    // The rule must not churn the rows that were always fine.
    auto request = xml_request ("<o><n>{{data.v}}</n></o>");

    const auto result = bind_data_row (request, json{ { "v", "plain-42" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, "<o><n>plain-42</n></o>");
}

TEST (ScenarioDataXmlBodyTest, TheUrlAndHeadersAreNeverEscapedForAnXmlBody) {
    // Per field, not per request - the same rule the JSON context follows.
    auto request = request_with_url ("https://api.test/?q={{data.q}}");
    request.headers["X-Note"] = "{{data.q}}";
    request.body.mode         = vayu::BodyMode::Xml;
    request.body.content      = "<o>{{data.q}}</o>";

    const auto result = bind_data_row (request, json{ { "q", "a&b" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.url, "https://api.test/?q=a&b");
    EXPECT_EQ (request.headers.at ("X-Note"), "a&b");
    EXPECT_EQ (request.body.content, "<o>a&amp;b</o>");
}

TEST (ScenarioDataXmlBodyTest, TheModeDecidesTheRuleAndNotTheContent) {
    // A `text` body that happens to hold XML is still text: the mode is what
    // the author declared, and escaping on a guess would corrupt the value.
    auto request         = request_with_url ("https://api.test/");
    request.body.mode    = vayu::BodyMode::Text;
    request.body.content = "<o>{{data.v}}</o>";

    const auto result = bind_data_row (request, json{ { "v", "a&b" } }, 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.body.content, "<o>a&b</o>");
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

    EXPECT_FALSE (
    vayu::core::tokenize_bindable_fields (request).first_data_token ().has_value ());
}

TEST (ScenarioDataScanTest, EveryFieldTheBinderSubstitutesIsAFieldTheScanSees) {
    // The pairing that matters: a field the binder would bind and the scan
    // would miss is a token that survives the refusal and reaches the wire.
    // Each case seeds exactly one field, so a hole names itself.
    const auto seen = [] (const vayu::Request& request) {
        return vayu::core::tokenize_bindable_fields (request)
        .first_data_token ()
        .value_or ("<none>");
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

    EXPECT_TRUE (
    vayu::core::tokenize_bindable_fields (request).first_data_token ().has_value ());
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

    EXPECT_TRUE (vayu::core::tokenize_bindable_fields (request).empty ());
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
    const auto tmpl = vayu::core::tokenize_bindable_fields (templated);
    ASSERT_TRUE (vayu::core::apply_iteration_template (
    templated, tmpl, vayu::core::IterationBinding{ &row, 0, {} })
    .ok);

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
    const auto tmpl = vayu::core::tokenize_bindable_fields (request);

    for (const char* id : { "1", "2", "3" }) {
        auto bound     = request;
        const json row = { { "id", id } };
        ASSERT_TRUE (vayu::core::apply_iteration_template (
        bound, tmpl, vayu::core::IterationBinding{ &row, 0, {} })
        .ok);
        EXPECT_EQ (bound.url, std::string ("https://api.test/u/") + id + "/" + id);
    }
}

TEST (ScenarioDataTemplateTest, AnAbsentColumnFailsTheJoinAndNamesTheRow) {
    auto request    = request_with_url ("https://api.test/{{data.missing}}");
    const auto tmpl = vayu::core::tokenize_bindable_fields (request);

    const json row   = { { "id", "1" } };
    const auto bound = vayu::core::apply_iteration_template (
    request, tmpl, vayu::core::IterationBinding{ &row, 7, {} });
    EXPECT_FALSE (bound.ok);
    EXPECT_NE (bound.error.find ("{{data.missing}}"), std::string::npos)
    << bound.error;
    EXPECT_NE (bound.error.find ("row 7"), std::string::npos) << bound.error;
    EXPECT_NE (bound.error.find ("id"), std::string::npos) << bound.error;
}

// ---------------------------------------------------------------------------
// The same header rule reaches the credentials `apply_auth` writes into a
// header line (issue #732)
// ---------------------------------------------------------------------------

namespace {

/// Bind @p row into @p auth's credentials and apply the result, as a step or a
/// send-with-row does - the sequence `bind_auth_row` exists to own.
vayu::core::DataBindResult
bind_auth (vayu::Request& request, const json& auth, const json& row, size_t row_index) {
    const auto parsed = vayu::http::parse_auth (auth);
    return vayu::core::bind_auth_row (
    request, parsed, vayu::core::tokenize_auth_fields (parsed), row, row_index);
}

} // namespace

TEST (ScenarioDataAuthLineBreakTest, ABearerTokenCarryingALineBreakIsRefused) {
    // `Authorization: Bearer <token>` is a header line like any other, so a
    // credential is as forgeable as `request.headers` - and it is the field a
    // credentials file most often binds. Revert the credential destinations to
    // a flat `FieldContext::Plain` and this reads `ok`, with the forged header
    // sitting inside Authorization.
    auto request = request_with_url ("https://api.test/");

    const auto result = bind_auth (request,
    json::parse (R"({"mode":"bearer","token":"{{data.token}}"})"),
    json::parse (R"({"token":"t\r\nX-Admin: true"})"), 2);

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("{{data.token}}"), std::string::npos)
    << result.error;
    EXPECT_NE (result.error.find ("row 2"), std::string::npos) << result.error;
    EXPECT_EQ (request.headers.count ("Authorization"), 0u)
    << "a refused bind must not have applied the auth";
}

TEST (ScenarioDataAuthLineBreakTest, AnApiKeySentInAHeaderIsRefusedOnEitherHalf) {
    for (const char* field : { "key", "value" }) {
        auto request = request_with_url ("https://api.test/");
        json auth = json::parse (R"({"mode":"apikey","key":"X-Key","value":"v"})");
        auth[field] = "{{data.cell}}";

        const auto result = bind_auth (
        request, auth, json::parse (R"({"cell":"a\r\nX-Admin: true"})"), 0);

        EXPECT_FALSE (result.ok) << "api key " << field << ": " << result.error;
    }
}

TEST (ScenarioDataAuthLineBreakTest, BasicCredentialsAndAQueryApiKeyStillBind) {
    // The refusal follows the destination, not the mode's name: basic's pair is
    // base64-encoded and a query api key percent-encoded before either reaches
    // the wire, so no byte of the cell can end a line and refusing one would be
    // a row rejected for a request it could not have forged.
    auto basic              = request_with_url ("https://api.test/");
    const auto basic_result = bind_auth (basic,
    json::parse (R"({"mode":"basic","username":"u","password":"{{data.pw}}"})"),
    json::parse (R"({"pw":"p\r\nq"})"), 0);

    ASSERT_TRUE (basic_result.ok) << basic_result.error;
    EXPECT_EQ (basic.headers.at ("Authorization"),
    "Basic " + vayu::utils::base64_encode (std::string ("u:p\r\nq")));

    auto query              = request_with_url ("https://api.test/");
    const auto query_result = bind_auth (query,
    json::parse (R"({"mode":"apikey","in":"query","key":"k","value":"{{data.v}}"})"),
    json::parse (R"({"v":"a\r\nb"})"), 0);

    ASSERT_TRUE (query_result.ok) << query_result.error;
    EXPECT_EQ (query.url, "https://api.test/?k=a%0D%0Ab");
    EXPECT_TRUE (query.headers.empty ());
}

TEST (ScenarioDataScanTest, ThePrefixAloneIsNotSomethingToRefuse) {
    // `{{data.}}` names no column, so the scan finds nothing to bind - it is
    // not a data token, whatever composition left in the field (since #1009,
    // the token itself). Refusing it would block a run over a token no row
    // could ever answer.
    EXPECT_FALSE (vayu::core::tokenize_bindable_fields (
    request_with_url ("https://api.test/{{data.}}"))
    .first_data_token ()
    .has_value ());
}

// ---------------------------------------------------------------------------
// Bare column names, bound at Postman's precedence (issue #1007)
// ---------------------------------------------------------------------------

/**
 * The bare spelling binds through the *same* walk as the reserved one.
 *
 * That is the whole safety argument for the feature: an imported collection
 * writes `{{username}}`, and a second substitution path for it would be a path
 * without the escaping, the null-cell refusal and the header rules this file
 * spends 800 lines pinning. The split is told which bare names a row can
 * answer, and everything after it is unchanged.
 *
 * Mutation-check: drop `bound_columns` from the splitter's predicate and the
 * first case leaves the token written as it stands; strip the spelling off
 * `DataColumnRef` and the error case names a token the request does not carry.
 */
TEST (ScenarioDataBareColumnTest, ABoundColumnBindsWhereTheReservedSpellingWould) {
    auto request =
    request_with_url ("https://api.test/u/{{username}}/{{data.id}}");
    request.headers["X-User"] = "{{username}}";

    const json row    = json::parse (R"({"username":"ada","id":7})");
    const auto result = bind_with_columns (request, { "username", "id" }, row);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.url, "https://api.test/u/ada/7");
    EXPECT_EQ (request.headers.at ("X-User"), "ada");
}

TEST (ScenarioDataBareColumnTest, WithoutTheColumnSetTheBareTokenIsNotADataToken) {
    // The other half of the rule, and the one that keeps every run with no
    // dataset behaving exactly as it did: a bare name is an ordinary variable
    // until something says a row will bind it. A split that found one anyway
    // would turn every unresolved `{{token}}` into a missing-column failure.
    auto request    = request_with_url ("https://api.test/u/{{username}}");
    const auto tmpl = vayu::core::tokenize_bindable_fields (request);
    EXPECT_TRUE (tmpl.empty ());

    const json row    = json::parse (R"({"username":"ada"})");
    const auto result = vayu::core::apply_iteration_template (
    request, tmpl, vayu::core::IterationBinding{ &row, 0, {} });
    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.url, "https://api.test/u/{{username}}");
}

TEST (ScenarioDataBareColumnTest, AMissingColumnIsNamedInTheSpellingTheRequestUses) {
    // The reader will search their request for the text the error quotes, so a
    // bare token reported as `{{data.username}}` sends them after something
    // that is not there.
    auto request      = request_with_url ("https://api.test/u/{{username}}");
    const json row    = json::parse (R"({"other":"ada"})");
    const auto result = bind_with_columns (request, { "username" }, row, 3);

    ASSERT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("{{username}}"), std::string::npos) << result.error;
    EXPECT_EQ (result.error.find ("{{data.username}}"), std::string::npos)
    << result.error;
    EXPECT_NE (result.error.find ("row 3"), std::string::npos) << result.error;
}

TEST (ScenarioDataBareColumnTest, TheHeaderAndDocumentRulesHoldForABareColumnToo) {
    // The rules a second substitution path would have skipped, asserted on the
    // bare spelling: a cell that would end a header line is refused, and one
    // that lands inside a JSON string literal is escaped rather than written
    // through.
    auto forging               = request_with_url ("https://api.test/");
    forging.headers["X-Token"] = "{{token}}";
    const json forging_row = json::parse (R"({"token":"ok\r\nX-Admin: true"})");
    const auto refused = bind_with_columns (forging, { "token" }, forging_row);
    EXPECT_FALSE (refused.ok);
    EXPECT_NE (refused.error.find ("{{token}}"), std::string::npos) << refused.error;

    auto document           = request_with_url ("https://api.test/");
    document.body.mode      = vayu::BodyMode::Json;
    document.body.content   = R"({"name":"{{name}}"})";
    const json document_row = json::parse (R"({"name":"say \"hi\""})");
    const auto escaped = bind_with_columns (document, { "name" }, document_row);
    ASSERT_TRUE (escaped.ok) << escaped.error;
    EXPECT_EQ (document.body.content, R"({"name":"say \"hi\""})");

    auto null_cell          = request_with_url ("https://api.test/u/{{id}}");
    const json null_row     = json::parse (R"({"id":null})");
    const auto refused_null = bind_with_columns (null_cell, { "id" }, null_row);
    EXPECT_FALSE (refused_null.ok);
}

TEST (ScenarioDataBareColumnTest, TheHeaderCollisionRefusalCoversTheBareSpellingToo) {
    // The rule a second substitution path would most quietly have skipped: a
    // header name a row binds onto a name another header already has leaves a
    // map with one of the two in it, and a run where only the rows that collide
    // send a request missing a header. Asserted for the bare spelling rather
    // than assumed from the shared walk, because "it goes through the same
    // function" is what a later refactor stops being true.
    auto request                     = request_with_url ("https://api.test/");
    request.headers["Authorization"] = "Bearer real";
    request.headers["{{h}}"]         = "bound";

    const auto result =
    bind_data_row (request, json::parse (R"({"h":"authorization"})"), 3);

    EXPECT_FALSE (result.ok);
    EXPECT_NE (result.error.find ("Authorization"), std::string::npos) << result.error;
    EXPECT_NE (result.error.find ("row 3"), std::string::npos) << result.error;
}

TEST (ScenarioDataBareColumnTest, OneRowSaysWhichBareNamesItCanBind) {
    // `bind_data_row` is the single send's whole binder (issue #642), and it
    // holds the row rather than a run's column set - so the row's own keys are
    // the set, and a name it does not carry stays an ordinary variable for the
    // residual pass rather than failing the send as a missing column.
    auto request =
    request_with_url ("https://api.test/u/{{username}}?t={{token}}");
    const auto result =
    bind_data_row (request, json::parse (R"({"username":"ada"})"), 0);

    ASSERT_TRUE (result.ok) << result.error;
    EXPECT_EQ (request.url, "https://api.test/u/ada?t={{token}}");
}

TEST (ScenarioDataBareColumnTest, TheColumnSetIsReadOffTheRowsOnce) {
    // A column only some rows carry is still split - and refused per row by the
    // missing-column rule, which is the answer the reserved spelling has always
    // given for the same file.
    const std::vector<json> rows{ json::parse (R"({"a":"1"})"), json::parse (R"({"b":"2"})") };
    const auto columns = vayu::core::bound_columns_of (rows);
    EXPECT_EQ (columns, vayu::http::BoundColumnNames ({ "a", "b" }));
    EXPECT_TRUE (vayu::core::bound_columns_of (json::parse ("[1,2]")).empty ());
}
