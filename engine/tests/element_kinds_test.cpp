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
#include <map>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/core/elements.hpp"

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
    return "<html><head><title>Vayu</title></head><body>" +
    std::string (std::size_t{ 2 } << 20, 'a') + "</body></html>";
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

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "error");
    EXPECT_TRUE (message_of (outcomes[0]).starts_with ("invalid regular expression: "))
    << message_of (outcomes[0]);
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

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "error");
    EXPECT_TRUE (message_of (outcomes[0]).starts_with ("invalid regular expression: "))
    << message_of (outcomes[0]);
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

} // namespace
