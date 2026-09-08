/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file metric_record_test.cpp
 * @brief `metric.record` (issue #1500): the element kind's five source
 *        shapes, its refusal with no collector to write into, and the
 *        registry's 32-name cap. `MetricsCollector`'s own storage
 *        (`register_custom_metric` / `record_custom_metric` /
 *        `custom_metric_summaries`) is covered directly here too, since
 *        nothing else in the suite reaches it.
 */

#include <gtest/gtest.h>

#include <tuple>

#include "optional_assert.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/metrics_collector.hpp"

namespace {

using vayu::core::CompiledElement;
using vayu::core::CustomMetricType;
using vayu::core::ElementContext;
using vayu::core::ElementOutcome;
using vayu::core::ElementPipeline;
using vayu::core::MetricsCollector;
using vayu::core::Phase;
using vayu::core::Registry;

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

nlohmann::json metric_element (const std::string& name,
const std::string& type,
const nlohmann::json& source) {
    return nlohmann::json{ { "id", "m1" }, { "kind", "metric.record" },
        { "config", { { "name", name }, { "type", type }, { "source", source } } } };
}

class MetricRecordTest : public ::testing::Test {
    protected:
    vayu::Request request;
    vayu::Response response;
    std::vector<std::tuple<std::string, CustomMetricType, double>> recorded;

    [[nodiscard]] ElementContext make_context (bool bind_collector = true) {
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
        if (bind_collector) {
            ctx.record_metric = [this] (const std::string& name,
                                CustomMetricType type, double value) {
                recorded.emplace_back (name, type, value);
            };
        }
        return ctx;
    }

    [[nodiscard]] std::vector<ElementOutcome>
    run_after (const std::vector<CompiledElement>& elements, bool bind_collector = true) {
        std::vector<ElementOutcome> sink;
        ElementContext ctx = make_context (bind_collector);
        ElementPipeline::run (Phase::StepAfter, ctx, elements, sink);
        return sink;
    }

    private:
    vayu::ScriptResult pre_result_;
    vayu::ScriptResult post_result_;
};

// ---------------------------------------------------------------------------
// The registry - kind exists, phase, category.
// ---------------------------------------------------------------------------

TEST (MetricRecordKind, IsRegisteredAtStepAfterInTheMetricCategory) {
    const auto* kind = Registry::instance ().find ("metric.record");
    ASSERT_NE (kind, nullptr);
    EXPECT_EQ (kind->category, "metric");
    ASSERT_EQ (kind->phases.size (), 1u);
    EXPECT_EQ (kind->phases[0], Phase::StepAfter);
}

// ---------------------------------------------------------------------------
// Trend / counter sources: latency, status, size, header, jsonpath.
// ---------------------------------------------------------------------------

TEST_F (MetricRecordTest, TrendFromLatencyRecordsTheResponseTiming) {
    response                 = ok_json_response (200, "{}");
    response.timing.total_ms = 42.5;
    auto elements            = one_element (
    metric_element ("ttfb", "trend", nlohmann::json{ { "latency", true } }));

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok");
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_EQ (std::get<0> (recorded[0]), "ttfb");
    EXPECT_EQ (std::get<1> (recorded[0]), CustomMetricType::Trend);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 42.5);
}

TEST_F (MetricRecordTest, CounterFromSizeRecordsTheBodyByteCount) {
    response      = ok_json_response (200, "0123456789");
    auto elements = one_element (
    metric_element ("bytesOut", "counter", nlohmann::json{ { "size", true } }));

    (void)run_after (elements);
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_EQ (std::get<1> (recorded[0]), CustomMetricType::Counter);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 10.0);
}

TEST_F (MetricRecordTest, TrendFromStatusRecordsTheStatusCode) {
    response      = ok_json_response (429, "");
    auto elements = one_element (
    metric_element ("status", "trend", nlohmann::json{ { "status", true } }));

    (void)run_after (elements);
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 429.0);
}

TEST_F (MetricRecordTest, TrendFromHeaderParsesANumericHeaderValue) {
    response                             = ok_json_response (200, "");
    response.headers["X-RateLimit-Left"] = "37";
    auto elements = one_element (metric_element ("rateLimitLeft", "trend",
    nlohmann::json{ { "header", "X-RateLimit-Left" } }));

    (void)run_after (elements);
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 37.0);
}

TEST_F (MetricRecordTest, TrendFromJsonPathReadsANestedNumber) {
    response      = ok_json_response (200, R"({"page": {"items": 25}})");
    auto elements = one_element (metric_element (
    "itemsPerPage", "trend", nlohmann::json{ { "jsonpath", "$.page.items" } }));

    (void)run_after (elements);
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 25.0);
}

TEST_F (MetricRecordTest, ANonNumericSourceIsReportedMissingRatherThanRecorded) {
    response = ok_json_response (200, "");
    // No such header - nothing to coerce, nothing recorded.
    auto elements = one_element (
    metric_element ("n", "trend", nlohmann::json{ { "header", "X-Not-There" } }));

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "missing");
    EXPECT_TRUE (recorded.empty ());
}

// ---------------------------------------------------------------------------
// Rate: the `condition` source.
// ---------------------------------------------------------------------------

TEST_F (MetricRecordTest, RateRecordsOneWhenTheConditionMatches) {
    response      = ok_json_response (429, "");
    auto elements = one_element (metric_element ("throttled", "rate",
    nlohmann::json{ { "condition",
    { { "field", "status" }, { "operator", "eq" }, { "value", 429 } } } }));

    (void)run_after (elements);
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_EQ (std::get<1> (recorded[0]), CustomMetricType::Rate);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 1.0);
}

TEST_F (MetricRecordTest, RateRecordsZeroWhenTheConditionDoesNotMatch) {
    response      = ok_json_response (200, "");
    auto elements = one_element (metric_element ("throttled", "rate",
    nlohmann::json{ { "condition",
    { { "field", "status" }, { "operator", "eq" }, { "value", 429 } } } }));

    (void)run_after (elements);
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 0.0);
}

TEST_F (MetricRecordTest, RateRefusesATrendStyleSource) {
    response      = ok_json_response (200, "");
    auto elements = one_element (
    metric_element ("bad", "rate", nlohmann::json{ { "latency", true } }));

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "error");
    EXPECT_TRUE (recorded.empty ());
}

// ---------------------------------------------------------------------------
// No collector bound - a bare design send.
// ---------------------------------------------------------------------------

TEST_F (MetricRecordTest, SkipsWithNoRunToRecordInto) {
    response      = ok_json_response (200, "");
    auto elements = one_element (
    metric_element ("n", "trend", nlohmann::json{ { "latency", true } }));

    auto outcomes = run_after (elements, /*bind_collector=*/false);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "skipped");
    EXPECT_TRUE (recorded.empty ());
}

// ---------------------------------------------------------------------------
// Registry::validate's 32-name cap (issue #1500's Scope, "cap 32 names per run").
// ---------------------------------------------------------------------------

TEST (MetricRecordCap, ThirtyTwoDistinctNamesValidate) {
    nlohmann::json elements = nlohmann::json::array ();
    for (int i = 0; i < 32; ++i) {
        elements.push_back (metric_element ("metric" + std::to_string (i),
        "trend", nlohmann::json{ { "latency", true } }));
        elements.back ()["id"] = "m" + std::to_string (i);
    }
    EXPECT_FALSE (Registry::instance ().validate (elements).has_value ());
}

TEST (MetricRecordCap, AThirtyThirdDistinctNameIsRefused) {
    nlohmann::json elements = nlohmann::json::array ();
    for (int i = 0; i < 33; ++i) {
        elements.push_back (metric_element ("metric" + std::to_string (i),
        "trend", nlohmann::json{ { "latency", true } }));
        elements.back ()["id"] = "m" + std::to_string (i);
    }
    auto reason = Registry::instance ().validate (elements);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("32"), std::string::npos) << *reason;
}

TEST (MetricRecordCap, The32ndRepeatOfTheSameNameIsNotACapViolation) {
    // The same declared name, inherited onto many elements, is one name -
    // registering it 40 times must not spend the cap.
    nlohmann::json elements = nlohmann::json::array ();
    for (int i = 0; i < 40; ++i) {
        elements.push_back (
        metric_element ("shared", "trend", nlohmann::json{ { "latency", true } }));
        elements.back ()["id"] = "m" + std::to_string (i);
    }
    EXPECT_FALSE (Registry::instance ().validate (elements).has_value ());
}

// ---------------------------------------------------------------------------
// MetricsCollector's own storage.
// ---------------------------------------------------------------------------

TEST (MetricsCollectorCustom, TrendReportsCountAndPercentiles) {
    MetricsCollector collector ("run-1");
    for (int i = 1; i <= 10; ++i) {
        collector.record_custom_metric (
        "ttfb", CustomMetricType::Trend, static_cast<double> (i));
    }
    auto summaries = collector.custom_metric_summaries ();
    ASSERT_HAS_VALUE (summaries);
    ASSERT_EQ (summaries->count ("ttfb"), 1u);
    const auto& ttfb = summaries->at ("ttfb");
    EXPECT_EQ (ttfb.type, CustomMetricType::Trend);
    EXPECT_EQ (ttfb.count, 10u);
    EXPECT_NEAR (ttfb.max, 10.0, 0.01);
}

TEST (MetricsCollectorCustom, CounterAccumulatesARunningTotal) {
    MetricsCollector collector ("run-2");
    collector.record_custom_metric ("bytesOut", CustomMetricType::Counter, 100.0);
    collector.record_custom_metric ("bytesOut", CustomMetricType::Counter, 250.0);
    auto summaries = collector.custom_metric_summaries ();
    ASSERT_HAS_VALUE (summaries);
    EXPECT_DOUBLE_EQ (summaries->at ("bytesOut").value, 350.0);
}

TEST (MetricsCollectorCustom, RateReportsThePercentageThatWereTrue) {
    MetricsCollector collector ("run-3");
    collector.record_custom_metric ("cacheHit", CustomMetricType::Rate, 1.0);
    collector.record_custom_metric ("cacheHit", CustomMetricType::Rate, 1.0);
    collector.record_custom_metric ("cacheHit", CustomMetricType::Rate, 0.0);
    collector.record_custom_metric ("cacheHit", CustomMetricType::Rate, 0.0);
    auto summaries = collector.custom_metric_summaries ();
    ASSERT_HAS_VALUE (summaries);
    EXPECT_DOUBLE_EQ (summaries->at ("cacheHit").value, 50.0);
    EXPECT_EQ (summaries->at ("cacheHit").count, 4u);
}

TEST (MetricsCollectorCustom, NoRecordingLeavesTheSummaryAbsent) {
    MetricsCollector collector ("run-4");
    EXPECT_FALSE (collector.custom_metric_summaries ().has_value ());
}

TEST (MetricsCollectorCustom, TheThirtyThirdDistinctNameIsRefused) {
    MetricsCollector collector ("run-5");
    for (int i = 0; i < 32; ++i) {
        EXPECT_TRUE (collector.register_custom_metric (
        "metric" + std::to_string (i), CustomMetricType::Counter));
    }
    EXPECT_FALSE (collector.register_custom_metric ("metric32", CustomMetricType::Counter));
    // And recording through the refused name is a silent no-op, not a crash.
    collector.record_custom_metric ("metric32", CustomMetricType::Counter, 1.0);
    auto summaries = collector.custom_metric_summaries ();
    ASSERT_HAS_VALUE (summaries);
    EXPECT_EQ (summaries->count ("metric32"), 0u);
}

TEST (MetricsCollectorCustom, RegisteringTheSameNameTwiceIsIdempotent) {
    MetricsCollector collector ("run-6");
    EXPECT_TRUE (collector.register_custom_metric ("n", CustomMetricType::Trend));
    EXPECT_TRUE (collector.register_custom_metric ("n", CustomMetricType::Trend));
}

TEST (MetricsCollectorCustom, ATypeMismatchOnAnExistingNameIsRefused) {
    MetricsCollector collector ("run-7");
    ASSERT_TRUE (collector.register_custom_metric ("n", CustomMetricType::Trend));
    EXPECT_FALSE (collector.register_custom_metric ("n", CustomMetricType::Counter));
}

} // namespace
