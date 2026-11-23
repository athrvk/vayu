/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file metric_record_test.cpp
 * @brief `metric.record` (issue #1500): the element kind's seven source
 *        shapes, its refusal with no collector to write into, and the
 *        registry's 32-name cap. `MetricsCollector`'s own storage
 *        (`register_custom_metric` / `record_custom_metric` /
 *        `custom_metric_summaries`) is covered directly here too, since
 *        nothing else in the suite reaches it.
 */

#include <gtest/gtest.h>

#include <string>
#include <tuple>
#include <vector>

#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
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

/// A response the transfer counted as a stream (`Response::stream_events`
/// set, as `StreamTally` does once the final hop announced
/// `text/event-stream`), whose buffered body is one `data:` frame per entry.
vayu::Response stream_response (const std::vector<std::string>& data) {
    std::string body;
    for (const auto& item : data) {
        body += "data: " + item + "\n\n";
    }
    vayu::Response response = ok_json_response (200, body);
    response.stream_events  = data.size ();
    return response;
}

nlohmann::json event_trend (const std::string& path) {
    return nlohmann::json{ { "id", "m1" }, { "kind", "metric.record" },
        { "config",
        { { "name", "completion_tokens" }, { "type", "trend" },
        { "source", { { "eventJsonpath", path } } } } } };
}

std::string usage_event (int completion_tokens) {
    return R"({"usage": {"completion_tokens": )" + std::to_string (completion_tokens) + "}}";
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

// A counter only grows (#1937). A trend reading the same negative value is
// still recorded: its clamp lives in the collector, and nothing here changes
// it. Mutation check: drop the counter guard in `MetricRecordElement::apply`
// and the counter case records -5 and reports "ok".
TEST_F (MetricRecordTest, ANegativeCounterIncrementIsAnErrorAndRecordsNothing) {
    response                    = ok_json_response (200, "");
    response.headers["X-Delta"] = "-5";
    auto elements               = one_element (
    metric_element ("delta", "counter", nlohmann::json{ { "header", "X-Delta" } }));

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "error");
    const auto& message = outcomes[0].message;
    ASSERT_HAS_VALUE (message);
    EXPECT_NE (message->find ("finite increment of 0 or more"), std::string::npos)
    << *message;
    EXPECT_TRUE (recorded.empty ());
}

TEST_F (MetricRecordTest, ANonFiniteCounterIncrementIsAnErrorAndRecordsNothing) {
    response                    = ok_json_response (200, "");
    response.headers["X-Delta"] = "inf";
    auto elements               = one_element (
    metric_element ("delta", "counter", nlohmann::json{ { "header", "X-Delta" } }));

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "error");
    EXPECT_TRUE (recorded.empty ());
}

TEST_F (MetricRecordTest, ANegativeTrendValueIsStillRecorded) {
    response                    = ok_json_response (200, "");
    response.headers["X-Delta"] = "-5";
    auto elements               = one_element (
    metric_element ("delta", "trend", nlohmann::json{ { "header", "X-Delta" } }));

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok");
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), -5.0);
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
// The `eventJsonpath` source (#3780): the last matching event of a stream.
// ---------------------------------------------------------------------------

// Mutation check: scan `read_last_matching_event` forwards (first match) and
// this records 1 instead of 30.
TEST_F (MetricRecordTest, EventJsonPathRecordsTheLastMatchingEvent) {
    response = stream_response ({ usage_event (1), R"({"delta": "hi"})",
    usage_event (30), R"({"delta": "!"})", "[DONE]" });

    auto outcomes =
    run_after (one_element (event_trend ("$.usage.completion_tokens")));
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok") << outcomes[0].message.value_or ("");
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_EQ (std::get<0> (recorded[0]), "completion_tokens");
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 30.0);
}

// `[DONE]`, a keep-alive comment and plain text are passed over, not refused.
// Mutation check: return `read_nothing` instead of `continue` on a parse
// failure and this reports `missing`.
TEST_F (MetricRecordTest, EventJsonPathSkipsEventsThatAreNotJson) {
    response = stream_response ({ usage_event (12), "not json", "[DONE]" });
    response.body = ": keep-alive\n\n" + response.body;

    auto outcomes =
    run_after (one_element (event_trend ("$.usage.completion_tokens")));
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "ok") << outcomes[0].message.value_or ("");
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 12.0);
}

// A stream past `sseMaxStoredEvents` still reads its real last event: the list
// a script sees is capped there, and that cap drops the tail. Mutation check:
// stop the scan at `constants::sse::MAX_STORED_EVENTS` events and this reads 1.
TEST_F (MetricRecordTest, EventJsonPathReadsTheLastEventOfAStreamPastTheStoredCap) {
    std::vector<std::string> data (
    vayu::core::constants::sse::MAX_STORED_EVENTS + 10, usage_event (1));
    data.back () = usage_event (99);
    response     = stream_response (data);

    (void)run_after (one_element (event_trend ("$.usage.completion_tokens")));
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 99.0);
}

TEST_F (MetricRecordTest, EventJsonPathWithNoMatchingEventIsMissing) {
    response = stream_response ({ R"({"delta": "hi"})", "[DONE]" });

    auto outcomes =
    run_after (one_element (event_trend ("$.usage.completion_tokens")));
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "missing");
    EXPECT_NE (outcomes[0].message.value_or ("").find ("no event"), std::string::npos)
    << outcomes[0].message.value_or ("");
    EXPECT_TRUE (recorded.empty ());
}

TEST_F (MetricRecordTest, EventJsonPathWithANonNumericMatchIsMissing) {
    response = stream_response ({ R"({"usage": {"completion_tokens": "many"}})" });

    auto outcomes =
    run_after (one_element (event_trend ("$.usage.completion_tokens")));
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "missing");
    EXPECT_TRUE (recorded.empty ());
}

// A body that reads like a stream is not one unless the transfer said so
// (#3771). Mutation check: drop the `stream_events` test in
// `ensure_parsed_events` and this records 5.
TEST_F (MetricRecordTest, EventJsonPathOnAResponseThatIsNotAStreamIsMissing) {
    response = stream_response ({ usage_event (5) });
    response.stream_events.reset ();

    auto outcomes =
    run_after (one_element (event_trend ("$.usage.completion_tokens")));
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "missing");
    EXPECT_NE (outcomes[0].message.value_or ("").find ("not an event stream"),
    std::string::npos)
    << outcomes[0].message.value_or ("");
    EXPECT_TRUE (recorded.empty ());
}

// The last match is only the last when nothing after it was lost. Mutation
// check: drop the `event->truncated` guard in `read_last_matching_event` and
// this records 7.
TEST_F (MetricRecordTest, EventJsonPathRecordsNothingWhenAnEventAfterTheMatchWasCut) {
    response = stream_response ({ usage_event (7),
    R"({"delta": ")" + std::string (vayu::core::constants::sse::MIN_EVENT_BYTES, 'x') + R"("})" });

    std::vector<ElementOutcome> sink;
    ElementContext ctx  = make_context ();
    ctx.max_event_bytes = vayu::core::constants::sse::MIN_EVENT_BYTES;
    ElementPipeline::run (Phase::StepAfter, ctx,
    one_element (event_trend ("$.usage.completion_tokens")), sink);
    ASSERT_EQ (sink.size (), 1u);
    EXPECT_EQ (sink[0].status, "missing");
    EXPECT_NE (sink[0].message.value_or ("").find ("sseMaxEventBytes"), std::string::npos)
    << sink[0].message.value_or ("");
    EXPECT_TRUE (recorded.empty ());
}

// Mutation check: drop the `body_truncated` guard in `read_last_matching_event`
// and this records 7.
TEST_F (MetricRecordTest, EventJsonPathRecordsNothingFromACutBody) {
    response                = stream_response ({ usage_event (7) });
    response.body_truncated = true;

    auto outcomes =
    run_after (one_element (event_trend ("$.usage.completion_tokens")));
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "missing");
    EXPECT_NE (outcomes[0].message.value_or ("").find ("cut short"), std::string::npos)
    << outcomes[0].message.value_or ("");
    EXPECT_TRUE (recorded.empty ());
}

// Two elements on one step share one parse of the events, and each still
// reads its own path's last match.
TEST_F (MetricRecordTest, TwoEventJsonPathElementsOnOneStepEachReadTheirOwnPath) {
    response =
    stream_response ({ R"({"usage": {"prompt_tokens": 4}})", usage_event (9) });
    auto prompt              = event_trend ("$.usage.prompt_tokens");
    prompt["id"]             = "m2";
    prompt["config"]["name"] = "prompt_tokens";
    const auto elements      = vayu::core::compile_elements (
    nlohmann::json::array ({ event_trend ("$.usage.completion_tokens"), prompt }));

    (void)run_after (elements);
    ASSERT_EQ (recorded.size (), 2u);
    EXPECT_EQ (std::get<0> (recorded[0]), "completion_tokens");
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 9.0);
    EXPECT_EQ (std::get<0> (recorded[1]), "prompt_tokens");
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[1]), 4.0);
}

// A rate reads only a condition, whose fields do not include the events.
TEST_F (MetricRecordTest, RateRefusesAnEventJsonPathSource) {
    response      = stream_response ({ usage_event (1) });
    auto elements = one_element (
    metric_element ("bad", "rate", nlohmann::json{ { "eventJsonpath", "$.usage" } }));

    auto outcomes = run_after (elements);
    ASSERT_EQ (outcomes.size (), 1u);
    EXPECT_EQ (outcomes[0].status, "error");
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

// The body is parsed in its own member order (#2459), and an ordered object
// compares equal only to one in the same order; the condition's `value` is
// still matched member by member, whatever order either side names them in.
TEST_F (MetricRecordTest, RateConditionEqualsAnObjectWhateverItsMemberOrder) {
    response      = ok_json_response (200, R"({"m": {"b": 1, "a": 2}})");
    auto elements = one_element (metric_element ("shape", "rate",
    nlohmann::json{ { "condition",
    { { "field", "jsonpath" }, { "jsonpath", "$.m" }, { "operator", "eq" },
    { "value", nlohmann::json::parse (R"({"a": 2, "b": 1})") } } } }));

    (void)run_after (elements);
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), 1.0);
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
    EXPECT_EQ (summaries->at ("bytesOut").count, 2u);
}

// `count` is how many times the counter was recorded, never its total cast to
// an integer (#1937). Mutation check: derive `count` from `counter_total` in
// `custom_metric_summaries` and this reads 3072.
TEST (MetricsCollectorCustom, CounterCountIsTheNumberOfRecordsNotTheTotal) {
    MetricsCollector collector ("run-2b");
    for (int i = 0; i < 3; ++i) {
        collector.record_custom_metric ("bytesOut", CustomMetricType::Counter, 1024.0);
    }
    auto summaries = collector.custom_metric_summaries ();
    ASSERT_HAS_VALUE (summaries);
    const auto& bytes_out = summaries->at ("bytesOut");
    EXPECT_EQ (bytes_out.count, 3u);
    EXPECT_DOUBLE_EQ (bytes_out.value, 3072.0);
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
