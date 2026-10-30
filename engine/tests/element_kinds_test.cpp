/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file element_kinds_test.cpp
 * @brief Per-kind coverage for issue #1514's phase-0 elements that
 *        `scenario_runner_test.cpp` does not already exercise through a full
 *        collection run: `extract.regex`, `extract.header`,
 *        `assert.jsonpath`, `assert.contains`, `assert.duration`,
 *        `assert.size`, and `control.if`'s `matches` (the kinds that run a
 *        user's pattern go through `compile_user_regex`, #1874).
 *        `extract.json`, `assert.status` and `timer.think` have their own
 *        coverage there (the acceptance-criterion scenario and the
 *        declarative-failure / spacing cases); this file is the "one case
 *        per kind" the issue's Tests section asks for, at the
 *        `ElementContext` level rather than through HTTP - every kind here
 *        is declarative and reads only the response the pipeline hands it.
 *
 * Each kind is compiled through the real `compile_elements` (never a
 * hand-built `CompiledElement`) and run through the real
 * `ElementPipeline::run`, so a mutation to `ElementPipeline::run` itself is
 * still caught here, not just a mutation inside one kind's `apply`.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <cstddef>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/custom_metric_type.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/schema_error_text.hpp"
#include "wide_json.hpp"

namespace {

using vayu::core::CompiledElement;
using vayu::core::ElementContext;
using vayu::core::ElementOutcome;
using vayu::core::ElementPipeline;
using vayu::core::Phase;

vayu::Response ok_json_response (int status, const std::string& body) {
    vayu::Response response;
    response.status_code = status;
    response.body        = body;
    response.body_size   = body.size ();
    return response;
}

std::vector<CompiledElement> one_element (const nlohmann::json& kind_and_config) {
    return vayu::core::compile_elements (nlohmann::json::array ({ kind_and_config }));
}

std::string message_of (const ElementOutcome& outcome) {
    return outcome.message.value_or ("");
}

// A fixture rather than a free function per test: `request` and `response`
// have to outlive the `ElementContext` reference members, and every test
// needs its own `variables` sink and `run_after` helper.
class ElementKindsTest : public ::testing::Test {
    protected:
    vayu::Request request;
    vayu::Response response;
    std::map<std::string, std::string> variables;

    [[nodiscard]] ElementContext make_context () {
        ElementContext ctx{
            .request            = request,
            .response           = &response,
            .run_pre_script     = {},
            .run_post_script    = {},
            .pre_script_result  = pre_result_,
            .post_script_result = post_result_,
            .set_variable       = {},
            .should_stop        = {},
            .record_metric      = {},
        };
        ctx.set_variable = [this] (std::string_view scope,
                           const std::string& name, const std::string& value) {
            variables[std::string (scope) + ":" + name] = value;
        };
        return ctx;
    }

    [[nodiscard]] std::vector<ElementOutcome> run_after (
    const std::vector<CompiledElement>& elements) {
        std::vector<ElementOutcome> sink;
        ElementContext ctx = make_context ();
        ElementPipeline::run (Phase::StepAfter, ctx, elements, sink);
        return sink;
    }

    /// What a `step.after` run leaves on the step's test tally, beside the
    /// outcomes: the channel a failing assertion reports through.
    struct RecordedRun {
        std::vector<ElementOutcome> outcomes;
        std::vector<vayu::TestResult> tests;
    };

    [[nodiscard]] RecordedRun run_after_recording (
    const std::vector<CompiledElement>& elements) {
        RecordedRun run;
        post_result_       = {}; // The fixture's slot outlives a loop's passes.
        ElementContext ctx = make_context ();
        ElementPipeline::run (Phase::StepAfter, ctx, elements, run.outcomes);
        run.tests = ctx.post_script_result.tests;
        return run;
    }

    /// `step.before` with `{{tier}}` resolving to @p tier, which is all
    /// `control.if` reads.
    [[nodiscard]] std::vector<ElementOutcome> run_before_with_tier (
    const std::vector<CompiledElement>& elements,
    const std::string& tier) {
        std::vector<ElementOutcome> sink;
        ElementContext ctx   = make_context ();
        ctx.response         = nullptr;
        ctx.resolve_template = [tier] (const std::string& text) {
            return text == "{{tier}}" ? tier : text;
        };
        ElementPipeline::run (Phase::StepBefore, ctx, elements, sink);
        return sink;
    }

    private:
    vayu::ScriptResult pre_result_;
    vayu::ScriptResult post_result_;
};

// ---------------------------------------------------------------------------
// extract.regex
// ---------------------------------------------------------------------------

TEST_F (ElementKindsTest, ExtractRegexWritesTheFirstCaptureGroup) {
    response = ok_json_response (200, R"({"id": "order-42"})");
    auto elements = one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.regex" },
    { "config",
    { { "pattern", "order-([0-9]+)" }, { "template", "$1$" },
    { "variable", "orderId" }, { "scope", "collection" } } } });

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok");
    EXPECT_EQ (variables["collection:orderId"], "42");
}

TEST_F (ElementKindsTest, ExtractRegexRequiredMissAppendsAFailedTest) {
    response = ok_json_response (200, R"({"id": "no-match-here"})");
    auto elements = one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.regex" },
    { "config",
    { { "pattern", "order-([0-9]+)" }, { "variable", "orderId" }, { "required", true } } } });

    std::vector<ElementOutcome> sink;
    ElementContext ctx = make_context ();
    ElementPipeline::run (Phase::StepAfter, ctx, elements, sink);

    ASSERT_EQ (sink.size (), 1u);
    EXPECT_EQ (sink[0].status, "missing");
    ASSERT_EQ (ctx.post_script_result.tests.size (), 1u);
    EXPECT_FALSE (ctx.post_script_result.tests[0].passed);
    EXPECT_TRUE (variables.empty ());
}

TEST_F (ElementKindsTest, ExtractRegexNonRequiredMissAppendsNoTest) {
    response = ok_json_response (200, "no digits here");
    auto elements = one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.regex" },
    { "config", { { "pattern", "[0-9]+" }, { "variable", "n" } } } });

    std::vector<ElementOutcome> sink;
    ElementContext ctx = make_context ();
    ElementPipeline::run (Phase::StepAfter, ctx, elements, sink);

    ASSERT_EQ (sink.size (), 1u);
    EXPECT_EQ (sink[0].status, "missing");
    EXPECT_TRUE (ctx.post_script_result.tests.empty ())
    << "a miss with no 'required' does not fail the step";
}

// A page whose one line runs on for 2 MiB after the title: the shape that
// took the daemon down when a greedy group spanned it, because libstdc++'s
// std::regex recursed once per character it consumed (#1874).
std::string two_mebibyte_page () {
    // Built by append: GCC 13 at -O3 reports a false -Warray-bounds on
    // `literal + std::string (n, c)` at this size.
    std::string page = "<html><head><title>Vayu</title></head><body>";
    page.append (std::size_t{ 2 } << 20, 'a');
    page.append ("</body></html>");
    return page;
}

TEST_F (ElementKindsTest, ExtractRegexMatchesAGreedyGroupAcrossATwoMebibyteBody) {
    response = ok_json_response (200, two_mebibyte_page ());
    auto elements = one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.regex" },
    { "config",
    { { "pattern", "<title>(.*)</title>" }, { "template", "$1$" }, { "variable", "title" } } } });

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok");
    EXPECT_EQ (variables["collection:title"], "Vayu");
}

TEST_F (ElementKindsTest, ExtractRegexWritesEveryNonOverlappingMatch) {
    response = ok_json_response (200, "ids 1, 22 and 333");
    auto elements = one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.regex" },
    { "config", { { "pattern", "[0-9]+" }, { "variable", "n" }, { "matchNo", -1 } } } });

    ASSERT_EQ (run_after (elements)[0].status, "ok");
    EXPECT_EQ (variables["collection:n_matchNr"], "3");
    EXPECT_EQ (variables["collection:n_1"], "1");
    EXPECT_EQ (variables["collection:n_2"], "22");
    EXPECT_EQ (variables["collection:n_3"], "333");
}

TEST_F (ElementKindsTest, ExtractRegexAnchorDoesNotRestartAtEachLaterSearch) {
    response = ok_json_response (200, "aaa");
    auto elements = one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.regex" },
    { "config", { { "pattern", "^a" }, { "variable", "n" }, { "matchNo", -1 } } } });

    ASSERT_EQ (run_after (elements)[0].status, "ok");
    EXPECT_EQ (variables["collection:n_matchNr"], "1")
    << "a search resumed mid-text must not see its start as the text's start";
}

TEST_F (ElementKindsTest, ExtractRegexEmptyMatchesAdvanceAndTerminate) {
    response = ok_json_response (200, "baaac");
    auto elements = one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.regex" },
    { "config", { { "pattern", "a*" }, { "variable", "n" }, { "matchNo", -1 } } } });

    ASSERT_EQ (run_after (elements)[0].status, "ok");
    EXPECT_EQ (variables["collection:n_matchNr"], "4");
    EXPECT_EQ (variables["collection:n_1"], "");
    EXPECT_EQ (variables["collection:n_2"], "aaa");
    EXPECT_EQ (variables["collection:n_3"], "");
    EXPECT_EQ (variables["collection:n_4"], "");
}

TEST_F (ElementKindsTest, ExtractRegexMatchesABodyThatIsNotUtf8) {
    // Latin-1 "cafe" with an acute e: one byte, 0xE9, which is not UTF-8.
    response = ok_json_response (200, "<title>caf\xE9</title>");
    auto elements = one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.regex" },
    { "config",
    { { "pattern", "<title>(.*)</title>" }, { "template", "$1$" }, { "variable", "title" } } } });

    ASSERT_EQ (run_after (elements)[0].status, "ok");
    EXPECT_EQ (variables["collection:title"], "caf\xE9");
}

TEST_F (ElementKindsTest, ExtractRegexTemplateDropsAGroupThePatternLacks) {
    response = ok_json_response (200, R"({"id": "order-42"})");
    auto elements = one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.regex" },
    { "config",
    { { "pattern", "order-([0-9]+)" }, { "template", "$0$/$1$/$5$" }, { "variable", "v" } } } });

    ASSERT_EQ (run_after (elements)[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "order-42/42/");
}

TEST_F (ElementKindsTest, ExtractRegexReportsAPatternOutsideTheDialect) {
    response = ok_json_response (200, "abc");
    for (const char* pattern : { "(a", R"((a)\1)", "(?<=a)b", "a(?=b)" }) {
        variables.clear ();
        auto elements =
        one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.regex" },
        { "config", { { "pattern", pattern }, { "variable", "v" } } } });

        auto outcomes = run_after (elements);
        ASSERT_EQ (outcomes.size (), 1u) << pattern;
        EXPECT_EQ (outcomes[0].status, "error") << pattern;
        EXPECT_TRUE (message_of (outcomes[0]).starts_with ("invalid regular expression: "))
        << pattern << ": " << message_of (outcomes[0]);
        EXPECT_TRUE (variables.empty ()) << pattern;
    }
}

// ---------------------------------------------------------------------------
// extract.header
// ---------------------------------------------------------------------------

TEST_F (ElementKindsTest, ExtractHeaderIsCaseInsensitive) {
    response                       = ok_json_response (200, "");
    response.headers["X-Trace-Id"] = "trace-abc";
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.header" },
    { "config", { { "header", "x-trace-id" }, { "variable", "traceId" }, { "scope", "env" } } } });

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok");
    EXPECT_EQ (variables["env:traceId"], "trace-abc");
}

TEST_F (ElementKindsTest, ExtractHeaderMissingUsesTheDefault) {
    response = ok_json_response (200, "");
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.header" },
    { "config", { { "header", "X-Missing" }, { "variable", "v" }, { "default", "fallback" } } } });

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "fallback");
}

// ---------------------------------------------------------------------------
// assert.jsonpath
// ---------------------------------------------------------------------------

TEST_F (ElementKindsTest, AssertJsonPathPassesOnAMatchingValue) {
    response = ok_json_response (200, R"({"status": "ready"})");
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$.status" }, { "expected", "ready" } } } });

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok");
}

TEST_F (ElementKindsTest, AssertJsonPathFailsOnAMismatchedValue) {
    response = ok_json_response (200, R"({"status": "pending"})");
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$.status" }, { "expected", "ready" } } } });

    std::vector<ElementOutcome> sink;
    ElementContext ctx = make_context ();
    ElementPipeline::run (Phase::StepAfter, ctx, elements, sink);

    ASSERT_EQ (sink.size (), 1u);
    EXPECT_EQ (sink[0].status, "failed");
    ASSERT_EQ (ctx.post_script_result.tests.size (), 1u);
    EXPECT_FALSE (ctx.post_script_result.tests[0].passed);
}

TEST_F (ElementKindsTest, AssertJsonPathRegexSearchesTheFirstMatchsText) {
    response = ok_json_response (200, R"({"id": "order-42"})");
    auto passing =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$.id" }, { "regex", "[0-9]+$" } } } });
    auto failing =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$.id" }, { "regex", "^invoice-" } } } });

    EXPECT_EQ (run_after (passing)[0].status, "ok");
    EXPECT_EQ (run_after (failing)[0].status, "failed");
}

TEST_F (ElementKindsTest, AssertJsonPathRegexReportsAnInvalidPattern) {
    response = ok_json_response (200, R"({"id": "order-42"})");
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$.id" }, { "regex", "order-(" } } } });

    const auto run = run_after_recording (elements);
    ASSERT_EQ (run.outcomes.size (), 1u);
    EXPECT_EQ (run.outcomes[0].status, "error");
    EXPECT_TRUE (message_of (run.outcomes[0]).starts_with ("invalid regular expression: "))
    << message_of (run.outcomes[0]);
    ASSERT_EQ (run.tests.size (), 1u)
    << "an error is a failed assertion (#3043)";
    EXPECT_FALSE (run.tests[0].passed);
    EXPECT_EQ (run.tests[0].error_message, message_of (run.outcomes[0]));
}

// `exists` is the boolean it says it is (#3049): false asserts the path is
// absent, and `negate` then asks for the opposite of whichever it states.
// Mutation check: read `exists` by presence again (drop `want_present`) and the
// `exists: false` rows report the wrong verdict.
TEST_F (ElementKindsTest, AssertJsonPathExistsIsABooleanAndNegateFlipsIt) {
    response = ok_json_response (200, R"({"here": 1})");
    struct Case {
        bool exists;
        bool negate;
        const char* path;
        bool passes;
        const char* failure;
    };
    const std::vector<Case> cases = {
        { true, false, "$.here", true, "" },
        { true, false, "$.nope", false, "expected '$.nope' to exist" },
        { false, false, "$.nope", true, "" },
        { false, false, "$.here", false, "expected '$.here' to not exist" },
        { true, true, "$.here", false, "expected '$.here' to not exist" },
        { true, true, "$.nope", true, "" },
        { false, true, "$.here", true, "" },
        { false, true, "$.nope", false, "expected '$.nope' to exist" },
    };
    for (const auto& c : cases) {
        SCOPED_TRACE (std::string ("exists ") + (c.exists ? "true" : "false") +
        (c.negate ? ", negated, " : ", ") + c.path);
        const auto run = run_after_recording (
        one_element (nlohmann::json{ { "id", "a1" }, { "kind", "assert.jsonpath" },
        { "config", { { "path", c.path }, { "exists", c.exists }, { "negate", c.negate } } } }));
        ASSERT_EQ (run.outcomes.size (), 1u);
        EXPECT_EQ (run.outcomes[0].status, c.passes ? "ok" : "failed");
        ASSERT_EQ (run.tests.size (), 1u);
        EXPECT_EQ (run.tests[0].passed, c.passes);
        EXPECT_EQ (run.tests[0].error_message, c.failure);
    }
}

// Mutation check: put the `!negate` guard around the suffix back to the old
// unconditional "to equal ... got" wording, or drop `not_prefix` from either
// message, and the failures stop saying "not".
TEST_F (ElementKindsTest, ANegatedAssertJsonPathValueFailureSaysNot) {
    response = ok_json_response (200, R"({"id": "order-42"})");
    const std::vector<std::pair<nlohmann::json, std::string>> cases = {
        { { { "expected", "order-42" } }, "expected '$.id' to not equal \"order-42\"" },
        { { { "regex", "^order-" } }, "expected '$.id' to not match /^order-/" },
    };
    for (const auto& [operand, failure] : cases) {
        SCOPED_TRACE (operand.dump ());
        nlohmann::json config = operand;
        config["path"]        = "$.id";
        config["negate"]      = true;
        const auto run = run_after_recording (one_element (nlohmann::json{
        { "id", "a1" }, { "kind", "assert.jsonpath" }, { "config", config } }));
        ASSERT_EQ (run.outcomes.size (), 1u);
        EXPECT_EQ (run.outcomes[0].status, "failed");
        ASSERT_EQ (run.tests.size (), 1u);
        EXPECT_EQ (run.tests[0].error_message, failure);
    }
}

TEST_F (ElementKindsTest, AUnnegatedAssertJsonPathValueFailureKeepsTheGotText) {
    response       = ok_json_response (200, R"({"id": "order-42"})");
    const auto run = run_after_recording (
    one_element (nlohmann::json{ { "id", "a1" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$.id" }, { "expected", "x" } } } }));
    ASSERT_EQ (run.tests.size (), 1u);
    EXPECT_EQ (run.tests[0].error_message, "expected '$.id' to equal \"x\", got order-42");
}

// ---------------------------------------------------------------------------
// The shared JSONPath subset: member names beyond [A-Za-z0-9_], and the
// bracket spelling of a member (#1903)
// ---------------------------------------------------------------------------

nlohmann::json extract_json_at (const std::string& path) {
    return nlohmann::json{ { "id", "e1" }, { "kind", "extract.json" },
        { "config", { { "path", path }, { "variable", "v" } } } };
}

TEST_F (ElementKindsTest, ExtractJsonReadsAHyphenatedMemberName) {
    response = ok_json_response (200, R"({"user-id": 7})");

    auto outcomes = run_after (one_element (extract_json_at ("$.user-id")));
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "7");
}

TEST_F (ElementKindsTest, ExtractJsonReadsAQuotedBracketMemberWithADot) {
    response = ok_json_response (200, R"({"a.b": 1, "a": {"b": 2}})");

    for (const char* path : { "$['a.b']", "$[\"a.b\"]" }) {
        variables.clear ();
        auto outcomes = run_after (one_element (extract_json_at (path)));
        ASSERT_EQ (outcomes.size (), 1u) << path;
        EXPECT_EQ (outcomes[0].status, "ok") << path;
        EXPECT_EQ (variables["collection:v"], "1")
        << path << " is the member named 'a.b', not a.b";
    }
}

TEST_F (ElementKindsTest, ExtractJsonMixesBracketAndDotSteps) {
    response = ok_json_response (200, R"({"a": {"b c": [10, 20], "d": 5}})");

    ASSERT_EQ (run_after (one_element (extract_json_at ("$['a'].d")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "5");
    ASSERT_EQ (run_after (one_element (extract_json_at ("$.a['b c'][1]")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "20");
    EXPECT_EQ (run_after (one_element (extract_json_at ("$['a'].['d']")))[0].status, "error")
    << "a '.' before '[' is not part of the subset";
}

TEST_F (ElementKindsTest, ExtractJsonQuotedNameMayHoldABracket) {
    response = ok_json_response (200, R"({"a]b": 3, "x[0": 4})");

    ASSERT_EQ (run_after (one_element (extract_json_at ("$['a]b']")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "3");
    ASSERT_EQ (run_after (one_element (extract_json_at ("$[\"x[0\"]")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "4");
}

TEST_F (ElementKindsTest, ExtractJsonQuotedNameHasNoEscapeForItsQuote) {
    response = ok_json_response (200, R"({"it's": 1})");

    // The name ends at the first matching quote, so what follows is not a `]`.
    EXPECT_EQ (run_after (one_element (extract_json_at ("$['it\\'s']")))[0].status, "error");
    ASSERT_EQ (run_after (one_element (extract_json_at ("$[\"it's\"]")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "1");
}

TEST_F (ElementKindsTest, ExtractJsonRefusesAMalformedBracketMemberAtRun) {
    response = ok_json_response (200, R"({"": 1, "a": 2})");

    for (const char* path : { "$['']", "$[\"\"]", "$['a", "$['a'", "$['a']x",
         "$['a\"]", "$['a' 'b']", "$[ 'a']" }) {
        auto outcomes = run_after (one_element (extract_json_at (path)));
        ASSERT_EQ (outcomes.size (), 1u) << path;
        EXPECT_EQ (outcomes[0].status, "error") << path;
        EXPECT_EQ (message_of (outcomes[0]), "invalid JSONPath") << path;
    }
    EXPECT_TRUE (variables.empty ());
}

TEST_F (ElementKindsTest, AssertJsonPathReadsAQuotedBracketMember) {
    response = ok_json_response (200, R"({"a.b": 1})");
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$['a.b']" }, { "expected", 1 } } } });

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok");
}

// ---------------------------------------------------------------------------
// assert.contains
// ---------------------------------------------------------------------------

TEST_F (ElementKindsTest, AssertContainsPassesWhenTheBodyContainsTheText) {
    response = ok_json_response (200, "order confirmed: 42");
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.contains" },
    { "config", { { "field", "body" }, { "text", "confirmed" } } } });

    EXPECT_EQ (run_after (elements)[0].status, "ok");
}

TEST_F (ElementKindsTest, AssertContainsFailsWhenTheBodyLacksTheText) {
    response = ok_json_response (200, "order pending");
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.contains" },
    { "config", { { "field", "body" }, { "text", "confirmed" } } } });

    EXPECT_EQ (run_after (elements)[0].status, "failed");
}

TEST_F (ElementKindsTest, AssertContainsMatchesAGreedyGroupAcrossATwoMebibyteBody) {
    response = ok_json_response (200, two_mebibyte_page ());
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.contains" },
    { "config", { { "text", "<title>(.*)</title>" }, { "mode", "matches" } } } });

    EXPECT_EQ (run_after (elements)[0].status, "ok");
}

TEST_F (ElementKindsTest, AssertContainsMatchesInTimeLinearInTheBody) {
    // `(a|aa)*b` against a run of `a`s with no `b` is exponential for a
    // backtracking matcher; RE2 answers it in one pass.
    response = ok_json_response (200, std::string (50'000, 'a'));
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.contains" },
    { "config", { { "text", "(a|aa)*b" }, { "mode", "matches" } } } });

    const auto started  = std::chrono::steady_clock::now ();
    const auto outcomes = run_after (elements);
    const auto elapsed  = std::chrono::steady_clock::now () - started;

    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "failed");
    EXPECT_LT (elapsed, std::chrono::seconds (5));
}

TEST_F (ElementKindsTest, AssertContainsMatchesTakesInlineFlags) {
    response = ok_json_response (200, "<TITLE>first\nsecond</TITLE>");
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.contains" },
    { "config", { { "text", "(?is)<title>first.second</title>" }, { "mode", "matches" } } } });
    auto without_flags =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.contains" },
    { "config", { { "text", "<title>first.second</title>" }, { "mode", "matches" } } } });

    EXPECT_EQ (run_after (elements)[0].status, "ok");
    EXPECT_EQ (run_after (without_flags)[0].status, "failed");
}

TEST_F (ElementKindsTest, AssertContainsMatchesReportsAnInvalidPattern) {
    response = ok_json_response (200, "abc");
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.contains" },
    { "config", { { "text", "(?<!x)abc" }, { "mode", "matches" } } } });

    const auto run = run_after_recording (elements);
    ASSERT_EQ (run.outcomes.size (), 1u);
    EXPECT_EQ (run.outcomes[0].status, "error");
    EXPECT_TRUE (message_of (run.outcomes[0]).starts_with ("invalid regular expression: "))
    << message_of (run.outcomes[0]);
    ASSERT_EQ (run.tests.size (), 1u)
    << "an error is a failed assertion (#3043)";
    EXPECT_FALSE (run.tests[0].passed);
    EXPECT_EQ (run.tests[0].name, "body matches '(?<!x)abc'");
}

// Validation refuses each of these (#3043); a row stored before it did still
// reaches the pipeline. Every one keeps its `error` outcome and also records
// a failed test, the channel the step verdict and every assertion count read.
// Mutation check: put the bare `outcome_status = "error"` back in any branch
// of `assert_kinds.cpp` and its case here has no test.
TEST_F (ElementKindsTest, AnAssertionThatCannotRunErrorsAndFailsItsTest) {
    response = ok_json_response (200, R"({"id": "order-42"})");
    const std::vector<std::pair<std::string, nlohmann::json>> cases = {
        { "assert.status", nlohmann::json::object () },
        { "assert.jsonpath", { { "path", "$.id" } } },
        { "assert.jsonpath", { { "path", "$[?(@.id)]" }, { "exists", true } } },
        { "assert.jsonpath", { { "path", "$.id" }, { "regex", "[" } } },
        { "assert.contains", { { "text", "[" }, { "mode", "matches" } } },
    };
    for (const auto& [kind, config] : cases) {
        SCOPED_TRACE (kind + " " + config.dump ());
        const auto run = run_after_recording (one_element (
        nlohmann::json{ { "id", "e1" }, { "kind", kind }, { "config", config } }));

        ASSERT_EQ (run.outcomes.size (), 1u);
        EXPECT_EQ (run.outcomes[0].status, "error");
        ASSERT_FALSE (message_of (run.outcomes[0]).empty ());
        ASSERT_EQ (run.tests.size (), 1u);
        EXPECT_FALSE (run.tests[0].passed);
        EXPECT_FALSE (run.tests[0].name.empty ());
        EXPECT_EQ (run.tests[0].error_message, message_of (run.outcomes[0]));
    }
}

// A missing response is not this rule's: `classify_step` already errors the
// step, so the assertion adds no test of its own.
TEST_F (ElementKindsTest, AnAssertionWithNoResponseRecordsNoTest) {
    std::vector<ElementOutcome> sink;
    ElementContext ctx = make_context ();
    ctx.response       = nullptr;
    ElementPipeline::run (Phase::StepAfter, ctx,
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.status" },
    { "config", nlohmann::json::object () } }),
    sink);

    ASSERT_EQ (sink.size (), 1u);
    EXPECT_EQ (sink[0].status, "error");
    EXPECT_EQ (message_of (sink[0]), "no response");
    EXPECT_TRUE (ctx.post_script_result.tests.empty ());
}

// An empty `in` beside a `range` is judged by the range (#3043): validate calls
// an empty list no operand, so run time must not let it win and fail every reply.
TEST_F (ElementKindsTest, AssertStatusWithAnEmptyInListIsJudgedByItsRange) {
    response = ok_json_response (200, "");
    auto elements = one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.status" },
    { "config",
    { { "in", nlohmann::json::array () }, { "range", { { "min", 200 }, { "max", 299 } } } } } });

    EXPECT_EQ (run_after (elements)[0].status, "ok");
}

// ---------------------------------------------------------------------------
// assert.duration
// ---------------------------------------------------------------------------

TEST_F (ElementKindsTest, AssertDurationPassesUnderTheBound) {
    response                 = ok_json_response (200, "");
    response.timing.total_ms = 120.0;
    auto elements            = one_element (nlohmann::json{ { "id", "e1" },
    { "kind", "assert.duration" }, { "config", { { "maxMs", 500 } } } });

    EXPECT_EQ (run_after (elements)[0].status, "ok");
}

TEST_F (ElementKindsTest, AssertDurationFailsOverTheBound) {
    response                 = ok_json_response (200, "");
    response.timing.total_ms = 900.0;
    auto elements            = one_element (nlohmann::json{ { "id", "e1" },
    { "kind", "assert.duration" }, { "config", { { "maxMs", 500 } } } });

    EXPECT_EQ (run_after (elements)[0].status, "failed");
}

// ---------------------------------------------------------------------------
// assert.size
// ---------------------------------------------------------------------------

TEST_F (ElementKindsTest, AssertSizePassesWhenUnderTheBound) {
    response      = ok_json_response (200, std::string (10, 'x'));
    auto elements = one_element (nlohmann::json{ { "id", "e1" },
    { "kind", "assert.size" }, { "config", { { "bytes", 100 }, { "op", "lte" } } } });

    EXPECT_EQ (run_after (elements)[0].status, "ok");
}

TEST_F (ElementKindsTest, AssertSizeFailsWhenOverTheBound) {
    response      = ok_json_response (200, std::string (200, 'x'));
    auto elements = one_element (nlohmann::json{ { "id", "e1" },
    { "kind", "assert.size" }, { "config", { { "bytes", 100 }, { "op", "lte" } } } });

    EXPECT_EQ (run_after (elements)[0].status, "failed");
}

// ---------------------------------------------------------------------------
// control.if - `matches`
// ---------------------------------------------------------------------------

std::vector<CompiledElement> control_if (const std::string& condition) {
    return one_element (nlohmann::json{ { "id", "e1" },
    { "kind", "control.if" }, { "config", { { "condition", condition } } } });
}

std::vector<CompiledElement> control_if_raw (const nlohmann::json& condition) {
    return one_element (nlohmann::json{ { "id", "e1" },
    { "kind", "control.if" }, { "config", { { "condition", condition } } } });
}

TEST_F (ElementKindsTest, ControlIfMatchesRunsTheStepOnlyWhenThePatternMatches) {
    const auto elements = control_if ("{{tier}} matches /^go/");

    EXPECT_EQ (run_before_with_tier (elements, "gold")[0].status, "ok");
    EXPECT_EQ (run_before_with_tier (elements, "silver")[0].status, "skipped");
}

TEST_F (ElementKindsTest, ControlIfMatchesSkipsOnAnInvalidPatternAndSaysWhy) {
    const auto outcomes =
    run_before_with_tier (control_if ("{{tier}} matches /(?=g)old/"), "gold");

    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "skipped");
    EXPECT_NE (message_of (outcomes[0]).find ("invalid regular expression: "),
    std::string::npos)
    << message_of (outcomes[0]);
}

TEST_F (ElementKindsTest, ControlIfMatchesWithoutSlashesSkipsAndSaysWhy) {
    const auto outcomes =
    run_before_with_tier (control_if ("{{tier}} matches ^go"), "gold");

    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "skipped");
    EXPECT_NE (message_of (outcomes[0]).find ("needs a /pattern/"), std::string::npos)
    << message_of (outcomes[0]);
}

TEST_F (ElementKindsTest, AWrongTypedPatternMemberCompilesWithoutThrowing) {
    EXPECT_NO_THROW (one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.contains" },
    { "config", { { "mode", "matches" }, { "text", 5 } } } }));
    EXPECT_NO_THROW (one_element (nlohmann::json{ { "id", "e2" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$.a" }, { "regex", 5 } } } }));
    EXPECT_NO_THROW (control_if_raw (7));
}

// ---------------------------------------------------------------------------
// A response body nesting past MAX_BODY_DEPTH is not handed to the JSON kinds
// (#2361)
// ---------------------------------------------------------------------------

constexpr size_t BODY_DEPTH = vayu::core::constants::elements::MAX_BODY_DEPTH;

/// {"n": 7, "v": [[...]]} with @p levels arrays under `v`, the innermost empty:
/// that array sits at depth @p levels. Never built deeper than the bound plus a
/// level, so a regression is a wrong outcome here rather than a stack overflow.
std::string body_nested_to (size_t levels) {
    return R"({"n": 7, "v": )" + std::string (levels, '[') + std::string (levels, ']') + "}";
}

nlohmann::json assert_jsonpath_exists (const std::string& path) {
    return nlohmann::json{ { "id", "a1" }, { "kind", "assert.jsonpath" },
        { "config", { { "path", path }, { "exists", true } } } };
}

nlohmann::json metric_trend_at (const std::string& path) {
    return nlohmann::json{ { "id", "m1" }, { "kind", "metric.record" },
        { "config",
        { { "name", "n" }, { "type", "trend" }, { "source", { { "jsonpath", path } } } } } };
}

// Mutation check: pass a larger bound to `parse_ordered_json` in
// `ensure_parsed_body` and the over-the-bound halves below report "ok" /
// record 7 instead.
TEST_F (ElementKindsTest, ExtractJsonSkipsABodyNestedPastTheDepthBound) {
    response = ok_json_response (200, body_nested_to (BODY_DEPTH + 1));

    const auto outcomes = run_after (one_element (extract_json_at ("$.n")));
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "skipped");
    EXPECT_NE (message_of (outcomes[0]).find ("nests too deeply"), std::string::npos)
    << message_of (outcomes[0]);
    EXPECT_NE (message_of (outcomes[0]).find ("maxElementBodyBytes"), std::string::npos)
    << message_of (outcomes[0]);
    EXPECT_TRUE (variables.empty ());
}

TEST_F (ElementKindsTest, ExtractJsonStillReadsABodyAtExactlyTheDepthBound) {
    response = ok_json_response (200, body_nested_to (BODY_DEPTH));

    EXPECT_EQ (run_after (one_element (extract_json_at ("$.n")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "7");

    // The deep subtree itself is matched and copied out at the bound.
    variables.clear ();
    response = ok_json_response (200, body_nested_to (BODY_DEPTH));
    EXPECT_EQ (run_after (one_element (extract_json_at ("$.v")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v"],
    std::string (BODY_DEPTH, '[') + std::string (BODY_DEPTH, ']'));
}

TEST_F (ElementKindsTest, AssertJsonPathFailsABodyNestedPastTheDepthBound) {
    response = ok_json_response (200, body_nested_to (BODY_DEPTH + 1));

    const auto run = run_after_recording (one_element (assert_jsonpath_exists ("$.n")));
    ASSERT_EQ (run.outcomes.size (), 1u);
    EXPECT_EQ (run.outcomes[0].status, "failed");
    EXPECT_NE (message_of (run.outcomes[0]).find ("nests too deeply"), std::string::npos)
    << message_of (run.outcomes[0]);
}

TEST_F (ElementKindsTest, AssertJsonPathStillReadsABodyAtExactlyTheDepthBound) {
    response = ok_json_response (200, body_nested_to (BODY_DEPTH));

    EXPECT_EQ (run_after (one_element (assert_jsonpath_exists ("$.n")))[0].status, "ok");
}

TEST_F (ElementKindsTest, MetricJsonPathRecordsNothingFromABodyNestedPastTheDepthBound) {
    std::vector<double> recorded;
    const auto run_metric = [&] (size_t levels) {
        recorded.clear ();
        response           = ok_json_response (200, body_nested_to (levels));
        ElementContext ctx = make_context ();
        ctx.record_metric = [&recorded] (const std::string&, vayu::core::CustomMetricType,
                            double value) { recorded.push_back (value); };
        std::vector<ElementOutcome> sink;
        ElementPipeline::run (
        Phase::StepAfter, ctx, one_element (metric_trend_at ("$.n")), sink);
        return sink;
    };

    const auto at_bound = run_metric (BODY_DEPTH);
    ASSERT_EQ (at_bound.size (), 1u);
    EXPECT_EQ (at_bound[0].status, "ok");
    EXPECT_EQ (recorded, std::vector<double>{ 7.0 });

    const auto past_bound = run_metric (BODY_DEPTH + 1);
    ASSERT_EQ (past_bound.size (), 1u);
    EXPECT_EQ (past_bound[0].status, "missing");
    EXPECT_TRUE (recorded.empty ());
}

// ---------------------------------------------------------------------------
// A body the JSON kinds cannot read fails the step instead of passing it (#3041)
// ---------------------------------------------------------------------------
// "Cannot read" is every way `ensure_parsed_body` answers null: text that is
// not JSON, no text, a tree past the depth bound, a body past the byte bound.
// Mutation check: put the old `skipped` branch back in `AssertJsonPathElement`
// and the first two tests fail; in `ExtractJsonElement::report_unreadable_body`
// and the third does.

struct UnreadableBody {
    const char* label;
    std::string body;
};

/// Built by appending to a named string: the one-expression
/// `literal + std::string (N, 'x') + literal` trips GCC 13's -Warray-bounds
/// false positive in the -O3 -Werror leg.
std::string body_padded_to (size_t padding) {
    std::string body = R"({"n": 7, "padding": ")";
    body.append (padding, 'x');
    body += R"("})";
    return body;
}

std::vector<UnreadableBody> unreadable_bodies () {
    constexpr size_t PAST_DEFAULT_BOUND = size_t{ 3 } * 512 * 1024;
    return {
        { "html", "<html><body><h1>503 Service Unavailable</h1></body></html>" },
        { "empty", "" },
        { "too deep", body_nested_to (BODY_DEPTH + 1) },
        { "over the byte bound", body_padded_to (PAST_DEFAULT_BOUND) },
    };
}

constexpr std::string_view UNREADABLE = vayu::core::constants::elements::BODY_UNREADABLE_MESSAGE;

TEST_F (ElementKindsTest, AssertJsonPathFailsWithTheBodyReasonWhenTheBodyCannotBeRead) {
    for (const auto& [label, body] : unreadable_bodies ()) {
        SCOPED_TRACE (label);
        response = ok_json_response (200, body);

        const auto run =
        run_after_recording (one_element (assert_jsonpath_exists ("$.n")));
        ASSERT_EQ (run.outcomes.size (), 1u);
        EXPECT_EQ (run.outcomes[0].status, "failed");
        EXPECT_EQ (message_of (run.outcomes[0]), UNREADABLE);
        ASSERT_EQ (run.tests.size (), 1u);
        EXPECT_EQ (run.tests[0].name, "JSONPath '$.n'");
        EXPECT_FALSE (run.tests[0].passed);
        EXPECT_EQ (run.tests[0].error_message, UNREADABLE);
    }
}

// An unreadable body satisfies no claim about its content, "does not exist"
// included (#3049), so neither `exists: false` nor `negate` may turn the
// failure into a pass.
TEST_F (ElementKindsTest, AssertJsonPathNeverPassesAnUnreadableBody) {
    const std::vector<nlohmann::json> claims = {
        { { "path", "$.n" }, { "exists", true }, { "negate", true } },
        { { "path", "$.n" }, { "exists", false } },
        { { "path", "$.n" }, { "exists", false }, { "negate", true } },
        { { "path", "$.n" }, { "expected", 7 }, { "negate", true } },
        { { "path", "$.n" }, { "regex", "^7$" }, { "negate", true } },
    };
    response = ok_json_response (200, "<html></html>");
    for (const auto& config : claims) {
        SCOPED_TRACE (config.dump ());
        const auto run = run_after_recording (one_element (nlohmann::json{
        { "id", "a1" }, { "kind", "assert.jsonpath" }, { "config", config } }));
        ASSERT_EQ (run.outcomes.size (), 1u);
        EXPECT_EQ (run.outcomes[0].status, "failed");
        ASSERT_EQ (run.tests.size (), 1u);
        EXPECT_FALSE (run.tests[0].passed);
    }
}

TEST_F (ElementKindsTest, RequiredExtractJsonFailsTheStepWhenTheBodyCannotBeRead) {
    for (const bool with_default : { false, true }) {
        for (const auto& [label, body] : unreadable_bodies ()) {
            SCOPED_TRACE (std::string (label) + (with_default ? ", with a default" : ""));
            nlohmann::json config = { { "path", "$.n" }, { "variable", "v" },
                { "required", true } };
            if (with_default) {
                config["default"] = "fallback";
            }
            response = ok_json_response (200, body);
            variables.clear ();

            const auto run = run_after_recording (one_element (nlohmann::json{
            { "id", "e1" }, { "kind", "extract.json" }, { "config", config } }));
            ASSERT_EQ (run.outcomes.size (), 1u);
            EXPECT_EQ (run.outcomes[0].status, "missing");
            EXPECT_EQ (message_of (run.outcomes[0]), UNREADABLE);
            ASSERT_EQ (run.tests.size (), 1u);
            EXPECT_EQ (run.tests[0].name, "extract v");
            EXPECT_FALSE (run.tests[0].passed);
            EXPECT_EQ (run.tests[0].error_message, UNREADABLE);
            EXPECT_TRUE (variables.empty ());
        }
    }
}

TEST_F (ElementKindsTest, OptionalExtractJsonIsSkippedWithTheReasonWhenTheBodyCannotBeRead) {
    for (const auto& [label, body] : unreadable_bodies ()) {
        SCOPED_TRACE (label);
        response = ok_json_response (200, body);
        variables.clear ();

        const auto run =
        run_after_recording (one_element (extract_json_at ("$.n")));
        ASSERT_EQ (run.outcomes.size (), 1u);
        EXPECT_EQ (run.outcomes[0].status, "skipped");
        EXPECT_EQ (message_of (run.outcomes[0]), UNREADABLE);
        EXPECT_TRUE (run.tests.empty ())
        << "an optional extractor never fails the step";
        EXPECT_TRUE (variables.empty ());
    }
}

// ---------------------------------------------------------------------------
// A wildcard visits an object's members in the body's own order (#2459)
// ---------------------------------------------------------------------------
// Every body below names its members out of alphabetical order, so a parse
// into a key-sorted object answers differently. Mutation check: parse into
// `nlohmann::json` in `ensure_parsed_body` and the wildcard tests read the
// alphabetically first member instead.

nlohmann::json extract_every_json_match_at (const std::string& path) {
    return nlohmann::json{ { "id", "e1" }, { "kind", "extract.json" },
        { "config", { { "path", path }, { "variable", "v" }, { "matchNo", -1 } } } };
}

TEST_F (ElementKindsTest, ExtractJsonWildcardFirstMatchIsTheBodysFirstMember) {
    response = ok_json_response (200, R"({"m": {"b": 1, "a": 2}})");

    ASSERT_EQ (run_after (one_element (extract_json_at ("$.m[*]")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "1");
}

TEST_F (ElementKindsTest, ExtractJsonEveryWildcardMatchIsNumberedInBodyOrder) {
    response = ok_json_response (200, R"({"m": {"b": 1, "a": 2}})");

    ASSERT_EQ (
    run_after (one_element (extract_every_json_match_at ("$.m[*]")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v_1"], "1");
    EXPECT_EQ (variables["collection:v_2"], "2");
    EXPECT_EQ (variables["collection:v_matchNr"], "2");
}

TEST_F (ElementKindsTest, ExtractJsonRecursiveDescentFindsTheBodysFirstMemberFirst) {
    response = ok_json_response (200, R"({"z": {"id": 1}, "a": {"id": 2}})");

    ASSERT_EQ (run_after (one_element (extract_json_at ("$..id")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "1");
}

TEST_F (ElementKindsTest, ExtractJsonWritesAnObjectMatchInItsOwnMemberOrder) {
    response = ok_json_response (200, R"({"m": {"b": 1, "a": 2}})");

    ASSERT_EQ (run_after (one_element (extract_json_at ("$.m")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], R"({"b":1,"a":2})");
}

// A repeated key keeps its first position and its last value, as
// `ordered_json::parse` does (`ordered_json_parse_test.cpp` holds the parity).
TEST_F (ElementKindsTest, ExtractJsonRepeatedKeyKeepsTheFirstPositionAndTheLastValue) {
    response = ok_json_response (200, R"({"b": 1, "a": 3, "b": 2})");

    ASSERT_EQ (run_after (one_element (extract_json_at ("$.b")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v"], "2");

    variables.clear ();
    ASSERT_EQ (run_after (one_element (extract_every_json_match_at ("$[*]")))[0].status, "ok");
    EXPECT_EQ (variables["collection:v_1"], "2");
    EXPECT_EQ (variables["collection:v_2"], "3");
    EXPECT_EQ (variables["collection:v_matchNr"], "2");
}

// Mutation check: compare `*matches.front ()` with `expected` directly in
// `AssertJsonPathElement::apply` and this fails, the ordered comparison
// seeing two different member orders.
TEST_F (ElementKindsTest, AssertJsonPathExpectedObjectIgnoresMemberOrder) {
    response = ok_json_response (200, R"({"m": {"b": 1, "a": 2}})");
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$.m" }, { "expected", nlohmann::json::parse (R"({"a": 2, "b": 1})") } } } });

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok") << message_of (outcomes[0]);
}

TEST_F (ElementKindsTest, AssertJsonPathReportsAnObjectMatchInItsOwnMemberOrder) {
    response = ok_json_response (200, R"({"m": {"b": 1, "a": 2}})");
    auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$.m" }, { "expected", 3 } } } });

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "failed");
    EXPECT_EQ (message_of (outcomes[0]), R"(expected '$.m' to equal 3, got {"b":1,"a":2})");
}

// A server chooses the width of an object; the shared parse must not pay for
// it quadratically. Mutation check: parse with `ordered_json::parse` in
// `ensure_parsed_body` and this runs for tens of seconds.
TEST_F (ElementKindsTest, ExtractJsonReadsTheLastOfAHundredThousandMembersInLinearTime) {
    const std::string body = vayu::tests::wide_object_json ();
    response               = ok_json_response (200, body);
    ElementContext ctx     = make_context ();
    // About 1.04 MiB, a little over the default bound a user may raise.
    ctx.max_body_bytes = body.size ();

    std::vector<ElementOutcome> sink;
    const auto started = std::chrono::steady_clock::now ();
    ElementPipeline::run (
    Phase::StepAfter, ctx, one_element (extract_json_at ("$.k99999")), sink);
    const auto elapsed = std::chrono::steady_clock::now () - started;

    ASSERT_EQ (sink.size (), 1u);
    EXPECT_EQ (sink[0].status, "ok") << message_of (sink[0]);
    EXPECT_EQ (variables["collection:v"], "99999");
    EXPECT_LT (elapsed, vayu::tests::LINEAR_PARSE_BUDGET);
}

TEST_F (ElementKindsTest, MetricJsonPathWildcardRecordsTheBodysFirstMember) {
    response           = ok_json_response (200, R"({"m": {"b": 1, "a": 2}})");
    ElementContext ctx = make_context ();
    std::vector<double> recorded;
    ctx.record_metric = [&recorded] (const std::string&, vayu::core::CustomMetricType,
                        double value) { recorded.push_back (value); };
    std::vector<ElementOutcome> sink;
    ElementPipeline::run (
    Phase::StepAfter, ctx, one_element (metric_trend_at ("$.m[*]")), sink);

    ASSERT_EQ (sink.size (), 1u);
    EXPECT_EQ (sink[0].status, "ok");
    EXPECT_EQ (recorded, std::vector<double>{ 1.0 });
}

// #2774: a key the kind never declared is refused with the keys it does, so a
// caller (an agent writing `expected` for `in`) sees the fix in the 400.
TEST_F (ElementKindsTest, AnUndeclaredSettingNamesTheKindsOwnSettings) {
    const auto reason = vayu::core::Registry::instance ().validate (
    nlohmann::json::array ({ { { "id", "el_1" }, { "kind", "assert.status" },
    { "config", { { "expected", 200 } } } } }));
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("'expected' is not a setting this element has. "
                             "Settings: in, range"),
    std::string::npos)
    << *reason;
}

// The pointer names the container, so a nested object lists its own keys.
TEST_F (ElementKindsTest, ANestedUndeclaredSettingNamesTheNestedSettings) {
    const auto reason = vayu::core::Registry::instance ().validate (
    nlohmann::json::array ({ { { "id", "el_1" }, { "kind", "assert.status" },
    { "config", { { "range", { { "min", 200 }, { "bogus", 1 } } } } } } }));
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find (
               "'bogus' is not a setting this element has. Settings: max, min"),
    std::string::npos)
    << *reason;
}

// A container the schema walk cannot resolve (a `$ref`, say) or one that
// declares no `properties` keeps the bare sentence rather than an empty list.
TEST_F (ElementKindsTest, AnUnresolvableContainerKeepsTheBareSentence) {
    const std::string description =
    "Object contains a property that could not be validated using 'properties' "
    "or "
    "'additionalProperties' constraints: 'expected'.";
    const nlohmann::json schema = { { "type", "object" },
        { "properties", { { "in", { { "type", "array" } } } } } };

    EXPECT_EQ (vayu::core::humanize_schema_error (schema, description, "/via/ref"),
    "'expected' is not a setting this element has");
    EXPECT_EQ (vayu::core::humanize_schema_error (schema, description, "/in"),
    "'expected' is not a setting this element has");
    EXPECT_EQ (vayu::core::humanize_schema_error (schema, description, ""),
    "'expected' is not a setting this element has. Settings: in");
}

// ---------------------------------------------------------------------------
// What a step's `extractorMisses` counts (#3053)
// ---------------------------------------------------------------------------
// Every extraction that left its variable unset, `required` or not, and
// nothing else: a body that is not JSON is a miss for `extract.json` (its
// `skipped`) and for `extract.regex`, not for a `default`-answered regex, a
// disabled extractor or a `metric.record` reporting the same `missing`.
// Mutation check: drop the `skipped` branch of `is_extractor_miss` and the
// count is 1; drop its `extract.` prefix check and it is 3.
TEST_F (ElementKindsTest, OnlyAnExtractionThatLeftItsVariableUnsetIsAMiss) {
    response            = ok_json_response (200, "plain text, no digits");
    const auto elements = vayu::core::compile_elements (nlohmann::json::array (
    { nlohmann::json{ { "id", "json" }, { "kind", "extract.json" },
      { "config", { { "path", "$.n" }, { "variable", "a" } } } },
    nlohmann::json{ { "id", "regex" }, { "kind", "extract.regex" },
    { "config", { { "pattern", "[0-9]+" }, { "variable", "b" }, { "required", true } } } },
    nlohmann::json{ { "id", "rescued" }, { "kind", "extract.regex" },
    { "config", { { "pattern", "[0-9]+" }, { "variable", "c" }, { "default", "0" } } } },
    nlohmann::json{ { "id", "off" }, { "kind", "extract.regex" }, { "enabled", false },
    { "config", { { "pattern", "[0-9]+" }, { "variable", "d" } } } },
    metric_trend_at ("$.n") }));

    ElementContext ctx = make_context ();
    ctx.record_metric = [] (const std::string&, vayu::core::CustomMetricType, double) {};
    std::vector<ElementOutcome> outcomes;
    ElementPipeline::run (Phase::StepAfter, ctx, elements, outcomes);
    ASSERT_EQ (outcomes.size (), 5u);
    EXPECT_EQ (outcomes[0].status, "skipped");
    EXPECT_EQ (outcomes[1].status, "missing");
    EXPECT_EQ (outcomes[2].status, "ok");
    EXPECT_EQ (outcomes[3].status, "skipped");
    EXPECT_EQ (outcomes[4].status, "missing");
    EXPECT_EQ (vayu::core::count_extractor_misses (outcomes), 2u);
}

// ---------------------------------------------------------------------------
// How a miss and an outcome row read (#3051)
// ---------------------------------------------------------------------------

// A miss says what found nothing, required or not; a `default`-answered one is
// a hit and says nothing. Mutation check: drop the `outcome_message` write in
// `write_miss` (extract_kinds.cpp) and the optional miss carries no message.
TEST_F (ElementKindsTest, AnExtractorMissNamesWhatFoundNothing) {
    response = ok_json_response (200, R"({"present": 1})");
    auto required = nlohmann::json{ { "id", "needed" }, { "kind", "extract.json" },
        { "config", { { "path", "$.nope" }, { "variable", "a" }, { "required", true } } } };
    const auto outcomes = run_after (vayu::core::compile_elements (nlohmann::json::array (
    { nlohmann::json{ { "id", "optional" }, { "kind", "extract.json" },
      { "config", { { "path", "$.nope" }, { "variable", "a" } } } },
    required,
    nlohmann::json{ { "id", "rescued" }, { "kind", "extract.json" },
    { "config", { { "path", "$.nope" }, { "variable", "a" }, { "default", "x" } } } } })));

    ASSERT_EQ (outcomes.size (), 3u);
    EXPECT_EQ (outcomes[0].status, "missing");
    EXPECT_EQ (message_of (outcomes[0]), "no match for '$.nope'");
    EXPECT_EQ (outcomes[0].to_json ().value ("message", ""), "no match for '$.nope'");
    EXPECT_EQ (outcomes[1].status, "missing");
    EXPECT_EQ (message_of (outcomes[1]), "no match for '$.nope'");
    EXPECT_EQ (outcomes[2].status, "ok");
    EXPECT_FALSE (outcomes[2].message.has_value ());
}

// A trace row says when its element is required, so a reader can tell the miss
// that failed the step from one that did not. Mutation check: drop the `required` write in
// `ElementOutcome::to_json` (pipeline.cpp), or the `config_requires` call in
// `compile_elements`, and the required miss's node has no `required`.
TEST_F (ElementKindsTest, ARequiredExtractorSaysSoOnItsOutcome) {
    response             = ok_json_response (200, R"({"present": 1})");
    const auto extractor = [] (const char* id, nlohmann::json required) {
        nlohmann::json entry = { { "id", id }, { "kind", "extract.json" },
            { "config", { { "path", "$.nope" }, { "variable", id } } } };
        if (!required.is_null ()) {
            entry["config"]["required"] = std::move (required);
        }
        return entry;
    };
    const auto outcomes = run_after (
    vayu::core::compile_elements (nlohmann::json::array ({ extractor ("needed", true),
    extractor ("optional", nullptr), extractor ("declined", false) })));

    ASSERT_EQ (outcomes.size (), 3u);
    EXPECT_TRUE (outcomes[0].required);
    EXPECT_EQ (outcomes[0].to_json ().value ("required", false), true);
    for (size_t i = 1; i < outcomes.size (); ++i) {
        EXPECT_FALSE (outcomes[i].required) << outcomes[i].id;
        EXPECT_FALSE (outcomes[i].to_json ().contains ("required"))
        << outcomes[i].id;
    }
}

// The label a user gave an element rides on its outcome and its trace node;
// one with no label (absent or `null`) writes no `name` key.
TEST_F (ElementKindsTest, AnElementsNameRidesOnItsOutcome) {
    response = ok_json_response (200, R"({"n": 1})");
    const auto outcomes = run_after (vayu::core::compile_elements (nlohmann::json::array (
    { nlohmann::json{ { "id", "named" }, { "kind", "extract.json" }, { "name", "Session id" },
      { "config", { { "path", "$.n" }, { "variable", "a" } } } },
    nlohmann::json{ { "id", "unnamed" }, { "kind", "extract.json" }, { "name", nullptr },
    { "config", { { "path", "$.n" }, { "variable", "b" } } } } })));

    ASSERT_EQ (outcomes.size (), 2u);
    EXPECT_EQ (outcomes[0].name, "Session id");
    EXPECT_EQ (outcomes[0].to_json ().value ("name", ""), "Session id");
    EXPECT_TRUE (outcomes[1].name.empty ());
    EXPECT_FALSE (outcomes[1].to_json ().contains ("name"));
}

// Every outcome word lands in its own bucket: a miss is not a skip and an
// error is not a failure. Mutation check: fold `"missing"` back into `skipped`
// in `ElementOutcomeCounts::record` (pipeline.cpp) and `missing` reads 0.
TEST_F (ElementKindsTest, EachOutcomeWordIsTalliedUnderItsOwnName) {
    vayu::core::ElementOutcomeCounts counts;
    const auto outcome = [] (const std::string& status, bool deferred = false) {
        ElementOutcome out;
        out.id       = "el_1";
        out.kind     = "extract.json";
        out.status   = status;
        out.deferred = deferred;
        return out;
    };
    for (const char* status :
    { "ok", "ok", "failed", "missing", "missing", "missing", "error" }) {
        counts.record (outcome (status));
    }
    counts.record (outcome ("skipped"));
    counts.record (outcome ("skipped", /*deferred=*/true));

    const auto elements = vayu::core::compile_elements (nlohmann::json::array (
    { nlohmann::json{ { "id", "el_1" }, { "kind", "extract.json" }, { "name", "Token" },
    { "origin", { { "kind", "request" }, { "scope", "request" }, { "id", "req_1" } } },
    { "config", { { "path", "$.t" }, { "variable", "t" }, { "required", true } } } } }));
    nlohmann::json rows = nlohmann::json::array ();
    counts.append_report_row (rows, elements.at (0));

    ASSERT_EQ (rows.size (), 1u);
    const auto& row = rows[0];
    EXPECT_EQ (row["id"], "el_1");
    EXPECT_EQ (row["kind"], "extract.json");
    EXPECT_EQ (row["name"], "Token");
    EXPECT_EQ (row["origin"]["id"], "req_1");
    EXPECT_EQ (row["required"], true);
    EXPECT_EQ (row["passed"], 2);
    EXPECT_EQ (row["failed"], 1);
    EXPECT_EQ (row["missing"], 3);
    EXPECT_EQ (row["error"], 1);
    EXPECT_EQ (row["skipped"], 1);
    EXPECT_EQ (row["deferred"], 1);
}

// A row omits what the element does not have: no label, no origin, and an
// optional element says nothing about `required`. One that never recorded an
// outcome writes no row; one that only missed still does.
TEST_F (ElementKindsTest, AnOutcomeRowOmitsWhatItsElementDoesNotHave) {
    const auto elements = vayu::core::compile_elements (nlohmann::json::array (
    { nlohmann::json{ { "id", "el_1" }, { "kind", "extract.json" },
    { "config", { { "path", "$.t" }, { "variable", "t" } } } } }));
    nlohmann::json rows = nlohmann::json::array ();

    vayu::core::ElementOutcomeCounts silent;
    silent.append_report_row (rows, elements.at (0));
    EXPECT_TRUE (rows.empty ()) << rows.dump ();

    vayu::core::ElementOutcomeCounts missed;
    ElementOutcome miss;
    miss.id     = "el_1";
    miss.kind   = "extract.json";
    miss.status = "missing";
    missed.record (miss);
    missed.append_report_row (rows, elements.at (0));

    ASSERT_EQ (rows.size (), 1u) << "a row of only misses is a row";
    EXPECT_FALSE (rows[0].contains ("name"));
    EXPECT_FALSE (rows[0].contains ("origin"));
    EXPECT_FALSE (rows[0].contains ("required"));
    EXPECT_EQ (rows[0]["missing"], 1);
}

// ---------------------------------------------------------------------------
// A key the config leaves out behaves as the catalogue's `default` says
// (issue #3045). The expected value is read from `GET /elements/kinds`' own
// catalogue, not restated here: the form shows that `default`, so what the
// kind runs for the absent key has to be it. `elements_registry_test.cpp`
// pins the catalogue's values themselves.
// ---------------------------------------------------------------------------

const nlohmann::json* catalogue_default (const nlohmann::json& catalogue,
const std::string& kind,
const std::string& property) {
    for (const auto& entry : catalogue) {
        if (entry["kind"] != kind) {
            continue;
        }
        // contains () + at (), not find () against end (): GCC 13 at -O3
        // reports a null dereference inside nlohmann's const iterator.
        const auto& properties = entry["configSchema"]["properties"];
        if (!properties.contains (property)) {
            break;
        }
        const auto& schema = properties.at (property);
        return schema.contains ("default") ? &schema.at ("default") : nullptr;
    }
    return nullptr;
}

std::string default_text (const std::string& kind, const std::string& property) {
    const nlohmann::json catalogue = vayu::core::elements_catalogue ();
    const auto* found = catalogue_default (catalogue, kind, property);
    const auto* text =
    found == nullptr ? nullptr : found->get_ptr<const std::string*> ();
    if (text == nullptr) {
        ADD_FAILURE () << kind << "." << property << " has no string default";
        return {};
    }
    return *text;
}

bool default_flag (const std::string& kind, const std::string& property) {
    const nlohmann::json catalogue = vayu::core::elements_catalogue ();
    const auto* found = catalogue_default (catalogue, kind, property);
    if (found == nullptr || !found->is_boolean ()) {
        ADD_FAILURE () << kind << "." << property << " has no boolean default";
        return false;
    }
    return found->get<bool> ();
}

// Run against a 10-byte body, a bound of 5, 10 and 20 tells the five
// comparisons apart: only `lte` (and the explicit default's own answer)
// fails the first and passes the other two.
TEST_F (ElementKindsTest, AssertSizeWithNoOpComparesAsTheCatalogueDefaultSays) {
    response             = ok_json_response (200, std::string (10, 'x'));
    const std::string op = default_text ("assert.size", "op");
    for (const int64_t bound : { 5, 10, 20 }) {
        const auto absent = one_element (nlohmann::json{ { "id", "e1" },
        { "kind", "assert.size" }, { "config", { { "bytes", bound } } } });
        const auto stated = one_element (nlohmann::json{ { "id", "e1" },
        { "kind", "assert.size" }, { "config", { { "bytes", bound }, { "op", op } } } });
        const auto absent_outcomes = run_after (absent);
        const auto stated_outcomes = run_after (stated);
        ASSERT_EQ (absent_outcomes.size (), 1u);
        ASSERT_EQ (stated_outcomes.size (), 1u);
        EXPECT_EQ (absent_outcomes[0].status, stated_outcomes[0].status)
        << "bound " << bound << " against op '" << op << "'";
        EXPECT_EQ (absent_outcomes[0].status, bound >= 10 ? "ok" : "failed")
        << "bound " << bound << " (lte)";
    }
}

TEST_F (ElementKindsTest, AnExtractorWithNoScopeWritesTheCatalogueDefaultScope) {
    response                = ok_json_response (200, R"({"n": "7"})");
    response.headers["X-N"] = "7";
    const std::vector<nlohmann::json> configs = {
        { { "kind", "extract.json" }, { "config", { { "path", "$.n" } } } },
        { { "kind", "extract.regex" }, { "config", { { "pattern", "[0-9]+" } } } },
        { { "kind", "extract.header" }, { "config", { { "header", "X-N" } } } },
        { { "kind", "extract.boundary" },
        { "config", { { "leftBoundary", "\"n\": \"" }, { "rightBoundary", "\"" } } } },
    };
    for (nlohmann::json entry : configs) {
        const std::string kind      = entry["kind"].get<std::string> ();
        entry["id"]                 = "e1";
        entry["config"]["variable"] = "n";
        variables.clear ();
        const auto outcomes = run_after (one_element (entry));
        ASSERT_EQ (outcomes.size (), 1u) << kind;
        EXPECT_EQ (outcomes[0].status, "ok") << kind;
        EXPECT_EQ (variables,
        (std::map<std::string, std::string>{ { default_text (kind, "scope") + ":n", "7" } }))
        << kind;
    }
}

TEST_F (ElementKindsTest, AnExtractorWithNoRequiredFlagFollowsTheCatalogueDefault) {
    response = ok_json_response (200, "no digits here");
    const std::vector<nlohmann::json> configs = {
        { { "kind", "extract.json" }, { "config", { { "path", "$.n" } } } },
        { { "kind", "extract.regex" }, { "config", { { "pattern", "[0-9]+" } } } },
        { { "kind", "extract.header" }, { "config", { { "header", "X-N" } } } },
        { { "kind", "extract.boundary" },
        { "config", { { "leftBoundary", "<" }, { "rightBoundary", ">" } } } },
    };
    for (nlohmann::json entry : configs) {
        const std::string kind      = entry["kind"].get<std::string> ();
        entry["id"]                 = "e1";
        entry["config"]["variable"] = "n";
        const auto run              = run_after_recording (one_element (entry));
        // A required miss appends a failed test; an optional one appends none.
        EXPECT_EQ (run.tests.size (), default_flag (kind, "required") ? 1u : 0u) << kind;
    }
}

TEST_F (ElementKindsTest, AnExtractRegexWithNoFieldSearchesTheCatalogueDefaultField) {
    response                = ok_json_response (200, "body-7");
    response.headers["X-N"] = "header-9";
    const auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "extract.regex" },
    { "config", { { "pattern", "(body|header)-[0-9]" }, { "variable", "n" } } } });

    const std::string field = default_text ("extract.regex", "field");
    ASSERT_EQ (field, "body")
    << "the body is the only field this response matches in";
    EXPECT_EQ (run_after (elements)[0].status, "ok");
    EXPECT_EQ (variables.at ("collection:n"), "body-7");
}

TEST_F (ElementKindsTest, AnAssertContainsWithNoFieldModeOrNegateFollowsTheCatalogueDefaults) {
    response                       = ok_json_response (200, "hello world");
    response.headers["X-Greeting"] = "other";
    // `body` (the header does not hold it), `contains` (a substring is not the
    // whole text) and not negated: all three have to hold for this to pass.
    const auto elements = one_element (nlohmann::json{ { "id", "e1" },
    { "kind", "assert.contains" }, { "config", { { "text", "hello" } } } });

    EXPECT_EQ (default_text ("assert.contains", "field"), "body");
    EXPECT_EQ (default_text ("assert.contains", "mode"), "contains");
    EXPECT_FALSE (default_flag ("assert.contains", "negate"));
    EXPECT_EQ (run_after (elements)[0].status, "ok");
}

TEST_F (ElementKindsTest, AnAssertJsonPathWithNoNegateFollowsTheCatalogueDefault) {
    response = ok_json_response (200, R"({"n": 7})");
    const auto elements =
    one_element (nlohmann::json{ { "id", "e1" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$.n" }, { "expected", 7 } } } });

    EXPECT_FALSE (default_flag ("assert.jsonpath", "negate"));
    EXPECT_EQ (run_after (elements)[0].status, "ok");
}

// A step-level script is deferred unless it is marked `inline`.
TEST (ElementDefaultsTest, AScriptWithNoInlineKeyIsRunAsTheCatalogueDefaultSays) {
    for (const char* kind : { "script.pre", "script.post" }) {
        EXPECT_EQ (vayu::core::RunContext::script_element_runs_inline (
                   nlohmann::json::object (), vayu::core::ScriptsOverrideMode::AsMarked),
        default_flag (kind, "inline"))
        << kind;
    }
}

/// Calls the kind's scheduling hook once, as a load run's producer does for a
/// scope entry, and says whether it kept its clock per virtual user (in
/// `pacing_state`) or shared (in the run-wide clock or budget).
bool kept_per_user (const nlohmann::json& element) {
    auto elements = vayu::core::compile_elements (nlohmann::json::array ({ element }));
    if (elements.size () != 1 || elements[0].element == nullptr) {
        ADD_FAILURE () << "the element did not compile";
        return false;
    }
    const std::vector<std::string> names{ "e1" };
    vayu::core::SharedPacingClocks clocks (names);
    vayu::core::SharedThroughputBudgets budgets (names);
    vayu::core::SharedScheduleState shared;
    shared.pacing     = &clocks;
    shared.throughput = &budgets;
    std::unordered_map<std::string, int64_t> pacing_state;
    (void)elements[0].element->scheduled_ready_delay_ms (pacing_state, shared, 1000);
    return !pacing_state.empty ();
}

nlohmann::json timer_at_scope_entry (const char* kind, nlohmann::json config) {
    config["_scopeEntry"] = true;
    return { { "id", "e1" }, { "kind", kind }, { "config", std::move (config) } };
}

vayu::core::ScenarioPlan plan_of_one (const nlohmann::json& element) {
    vayu::core::ScenarioPlan plan;
    plan.steps.emplace_back ();
    plan.steps.back ().elements = std::make_shared<const std::vector<CompiledElement>> (
    vayu::core::compile_elements (nlohmann::json::array ({ element })));
    return plan;
}

TEST (ElementDefaultsTest, TimerPacingWithNoPerUserKeyFollowsTheCatalogueDefault) {
    const auto element = timer_at_scope_entry ("timer.pacing", { { "everyMs", 100 } });
    EXPECT_EQ (kept_per_user (element), default_flag ("timer.pacing", "perUser"));
    EXPECT_EQ (vayu::core::shared_pacing_element_ids (plan_of_one (element)).empty (),
    default_flag ("timer.pacing", "perUser"))
    << "the plan scan that sizes the shared clocks reads the same default";
}

TEST (ElementDefaultsTest, TimerThroughputWithNoPerUserKeyFollowsTheCatalogueDefault) {
    const auto element =
    timer_at_scope_entry ("timer.throughput", { { "targetPerMinute", 60 } });
    EXPECT_EQ (kept_per_user (element), default_flag ("timer.throughput", "perUser"));
    EXPECT_EQ (vayu::core::shared_throughput_element_ids (plan_of_one (element)).empty (),
    default_flag ("timer.throughput", "perUser"))
    << "the plan scan that sizes the shared budgets reads the same default";
}

TEST (ElementDefaultsTest, ControlThroughputWithNoPerUserKeyFollowsTheCatalogueDefault) {
    const bool per_user = default_flag ("control.throughput", "perUser");
    const nlohmann::json bare{ { "id", "e1" }, { "kind", "control.throughput" },
        { "config", { { "everyN", 2 } } } };

    // The run's scan slots a shared counter only for an element that is not
    // per user.
    auto bare_plan = plan_of_one (bare);
    vayu::core::SharedThroughputCounters bare_counters (bare_plan);
    EXPECT_EQ (bare_counters.find ("e1") == nullptr, per_user);

    // The kind's own reader: handed a shared slot (as an explicit
    // `perUser: false` would have earned it), an element with no key still
    // counts on the virtual user's own state exactly when the default says so.
    nlohmann::json shared_config       = bare;
    shared_config["config"]["perUser"] = false;
    auto shared_plan                   = plan_of_one (shared_config);
    vayu::core::SharedThroughputCounters counters (shared_plan);
    ASSERT_NE (counters.find ("e1"), nullptr);

    vayu::Request request;
    vayu::ScriptResult pre_result;
    vayu::ScriptResult post_result;
    std::unordered_map<std::string, int64_t> controller_state;
    ElementContext ctx{
        .request            = request,
        .response           = nullptr,
        .run_pre_script     = {},
        .run_post_script    = {},
        .pre_script_result  = pre_result,
        .post_script_result = post_result,
        .set_variable       = {},
        .should_stop        = {},
        .record_metric      = {},
    };
    ctx.controller_state        = &controller_state;
    ctx.shared_controller_state = &counters;
    const auto elements =
    vayu::core::compile_elements (nlohmann::json::array ({ bare }));
    std::vector<ElementOutcome> outcomes;
    ElementPipeline::run (Phase::StepBefore, ctx, elements, outcomes);

    EXPECT_EQ (controller_state.contains ("e1"), per_user);
    EXPECT_EQ (counters.find ("e1")->count.load (), per_user ? 0 : 1);
}

// A wait after the folder's first of two members: the fold lands in the open
// pass's sum exactly when the catalogue default says the timers are included.
TEST (ElementDefaultsTest, ControlTransactionWithNoIncludeTimersKeyFoldsAsTheCatalogueDefaultSays) {
    const nlohmann::json bare{ { "id", "e1" }, { "kind", "control.transaction" },
        { "config", { { "name", "checkout" } } } };
    const auto elements =
    vayu::core::compile_elements (nlohmann::json::array ({ bare }));
    const std::unordered_map<std::string, vayu::core::ElementSpan> spans{
        { "e1", vayu::core::ElementSpan{ .first = 0, .last = 1, .first_step_name = {} } }
    };
    const std::string sum_key = vayu::core::transaction_sum_key ("e1", 0);
    std::unordered_map<std::string, int64_t> controller_state{ { sum_key, 0 } };

    vayu::core::fold_between_wait_into_open_transactions (
    elements, spans, 0, 0, 60, controller_state);

    constexpr int64_t WAIT_US = 60'000;
    EXPECT_EQ (controller_state.at (sum_key),
    default_flag ("control.transaction", "includeTimers") ? WAIT_US : 0);
}

} // namespace
