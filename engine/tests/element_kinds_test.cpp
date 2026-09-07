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
 *        `assert.size`. `extract.json`, `assert.status` and `timer.think`
 *        have their own coverage there (the acceptance-criterion scenario
 *        and the declarative-failure / spacing cases); this file is the
 *        "one case per kind" the issue's Tests section asks for, at the
 *        `ElementContext` level rather than through HTTP - every kind here
 *        is declarative and reads only the response the pipeline hands it.
 *
 * Each kind is compiled through the real `compile_elements` (never a
 * hand-built `CompiledElement`) and run through the real
 * `ElementPipeline::run`, so a mutation to `ElementPipeline::run` itself is
 * still caught here, not just a mutation inside one kind's `apply`.
 */

#include <gtest/gtest.h>

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

} // namespace
