/**
 * @file tests/scenario_runner_events_test.cpp
 * @brief Design-mode sequential runner: extractor misses, timers, streaming steps, stops
 * (issue #353), the bounded step store, and the live step events a run publishes.
 *
 * The `ScenarioRunnerTest` fixture and its mock server are in `scenario_runner_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "mock_server.hpp"
#include "oauth_token_server.hpp"
#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"
#include "wait_until.hpp"

#include "scenario_runner_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::core::ScenarioStepStore;
using vayu::core::StepOutcome;
using vayu::tests::scenario_runner::ScenarioMockServer;
using vayu::tests::scenario_runner::ScenarioRunnerTest;
using vayu::tests::scenario_runner::SeenRequest;

// ----------------------------------------------------------------------------
// An extractor that finds nothing unsets its variable (#3053), so the next step
// sends the literal `{{name}}` rather than an earlier iteration's value.
// ----------------------------------------------------------------------------

/// The stored value each scope starts with, which a miss must hide too.
constexpr const char* STORED_TOKEN_VARIABLES =
R"({"token":{"value":"stored-old","enabled":true}})";

/// One iteration per entry of @p endpoints: step 0 GETs `/<endpoint>` and
/// runs @p extractor on the answer, step 1 GETs `/echo-auth` sending
/// `Authorization: Bearer {{token}}` and @p marker as `X-Marker`. Answers what
/// each iteration's step 1 sent, in order.
class ScenarioRunnerExtractorMissTest : public ScenarioRunnerTest {
    protected:
    std::vector<SeenRequest> step_one_after (const json& extractor,
    const std::vector<std::string>& endpoints,
    const std::string& marker         = "",
    const std::string& environment_id = "") {
        seed_request_with_elements (
        "req_a", 0, "/{{data.from}}", json::array ({ extractor }));
        json headers = json::array ({ { { "key", "Authorization" },
        { "value", "Bearer {{token}}" }, { "enabled", true } } });
        if (!marker.empty ()) {
            headers.push_back (
            { { "key", "X-Marker" }, { "value", marker }, { "enabled", true } });
        }
        seed_request ("req_b", 1, "/echo-auth", "", "", "", "", headers.dump ());

        json rows = json::array ();
        for (const auto& endpoint : endpoints) {
            rows.push_back ({ { "from", endpoint } });
        }
        const auto run_id = start_with_data (rows, std::nullopt, environment_id);
        EXPECT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
        last_run_ = run_id;

        std::vector<SeenRequest> sent;
        for (const auto& seen : server_->requests ()) {
            if (seen.path == "/echo-auth") {
                sent.push_back (seen);
            }
        }
        return sent;
    }

    static std::vector<std::string> authorizations (const std::vector<SeenRequest>& sent) {
        std::vector<std::string> out;
        out.reserve (sent.size ());
        for (const auto& seen : sent) {
            out.push_back (seen.authorization);
        }
        return out;
    }

    /// Each stored step's `extractorMisses` in run order, then each `step`
    /// frame's: -1 where the key is absent, so a written 0 shows.
    std::pair<std::vector<int64_t>, std::vector<int64_t>> misses_stored_and_live () {
        const auto misses_in = [] (const json& node) {
            return node.contains ("extractorMisses") ?
            node["extractorMisses"].get<int64_t> () :
            -1;
        };
        std::pair<std::vector<int64_t>, std::vector<int64_t>> out;
        for (const auto& row : db_->get_results (last_run_)) {
            out.first.push_back (misses_in (json::parse (row.trace_data)));
        }
        for (const auto& frame : step_frames (context_for (last_run_))) {
            out.second.push_back (
            misses_in (json::parse (frame.substr (frame.find ("data: ") + 6))));
        }
        return out;
    }

    static json extract_token (const std::string& scope = "collection") {
        return { { "id", "el_token" }, { "kind", "extract.json" }, { "enabled", true },
            { "config",
            { { "path", "$.token" }, { "variable", "token" }, { "scope", scope } } } };
    }

    std::string last_run_;
};

/// The scope an extractor writes, and how to read its stored row back.
struct ExtractorScopeCase {
    const char* scope;
    const char* environment_id; // "" when the run names no environment
};

class ScenarioRunnerExtractorScopeTest
: public ScenarioRunnerExtractorMissTest,
  public ::testing::WithParamInterface<ExtractorScopeCase> {
    protected:
    /// The variables stored for the case's scope once the run has persisted.
    vayu::Environment stored_variables () {
        const std::string scope = GetParam ().scope;
        std::string text;
        if (scope == "env") {
            text =
            db_->get_environment ("env_1").value_or (vayu::db::Environment{}).variables;
        } else if (scope == "globals") {
            text = db_->get_globals ().value_or (vayu::db::Globals{}).variables;
        } else {
            text =
            db_->get_collection ("col_1").value_or (vayu::db::Collection{}).variables;
        }
        return vayu::json::parse_variables (text);
    }
};

// Mutation check: drop the `unset` in `write_miss` (extract_kinds.cpp) and the
// second iteration sends `Bearer secret-abc` again.
TEST_P (ScenarioRunnerExtractorScopeTest, AMissUnsetsTheVariableInsteadOfKeepingTheLastValue) {
    const std::string scope = GetParam ().scope;
    seed_collection ("col_1", scope == "collection" ? STORED_TOKEN_VARIABLES : "");
    seed_environment ("env_1", scope == "env" ? STORED_TOKEN_VARIABLES : "");
    if (scope == "globals") {
        db_->save_globals ({ "globals", STORED_TOKEN_VARIABLES, 1 });
    }

    const auto sent = step_one_after (
    extract_token (scope), { "token", "ok" }, "", GetParam ().environment_id);

    EXPECT_EQ (authorizations (sent),
    (std::vector<std::string>{ "Bearer secret-abc", "Bearer {{token}}" }))
    << "iteration 2's miss left iteration 1's token in use";
    EXPECT_FALSE (stored_variables ().contains ("token"))
    << "the unset did not reach the stored " << scope << " row";
}

INSTANTIATE_TEST_SUITE_P (EachScope,
ScenarioRunnerExtractorScopeTest,
::testing::Values (ExtractorScopeCase{ "collection", "" },
ExtractorScopeCase{ "env", "env_1" },
ExtractorScopeCase{ "globals", "" }),
[] (const ::testing::TestParamInfo<ExtractorScopeCase>& info) {
    return std::string (info.param.scope);
});

TEST_F (ScenarioRunnerExtractorMissTest, ADefaultStillStandsInForAMiss) {
    seed_collection ("col_1");
    auto extractor                 = extract_token ();
    extractor["config"]["default"] = "anon";

    EXPECT_EQ (authorizations (step_one_after (extractor, { "token", "ok" })),
    (std::vector<std::string>{ "Bearer secret-abc", "Bearer anon" }));
    const std::vector<int64_t> none{ -1, -1, -1, -1 };
    EXPECT_EQ (misses_stored_and_live (), std::make_pair (none, none))
    << "a miss the default answered is not counted";
}

// The miss is counted on the step that missed, in the iteration it missed in,
// on the stored row and the live frame alike; a hit and a step with no
// extractor carry no key. Mutation check: drop the `extractorMisses` write in
// `store_step_record` (scenario_runner.cpp) and the stored half fails; in
// `build_step_payload` and the live half does.
TEST_F (ScenarioRunnerExtractorMissTest, AMissIsCountedOnItsOwnStepLiveAndStored) {
    seed_collection ("col_1");

    step_one_after (extract_token (), { "token", "ok" });

    const std::vector<int64_t> second_iteration_step_zero{ -1, -1, 1, -1 };
    EXPECT_EQ (misses_stored_and_live (),
    std::make_pair (second_iteration_step_zero, second_iteration_step_zero));
}

TEST_F (ScenarioRunnerExtractorMissTest, AnAbsentResponseHeaderUnsetsTheVariable) {
    seed_collection ("col_1");
    const json extractor = { { "id", "el_header" },
        { "kind", "extract.header" }, { "enabled", true },
        { "config", { { "header", "Set-Cookie" }, { "variable", "token" } } } };

    EXPECT_EQ (authorizations (step_one_after (extractor, { "login", "ok" })),
    (std::vector<std::string>{ "Bearer sid=session-1; Path=/", "Bearer {{token}}" }));
}

// An optional `extract.json` over a body it cannot read is `skipped`, and an
// earlier response's value goes all the same.
TEST_F (ScenarioRunnerExtractorMissTest, AnUnreadableBodyUnsetsTheVariable) {
    seed_collection ("col_1");

    EXPECT_EQ (authorizations (step_one_after (extract_token (), { "token", "html" })),
    (std::vector<std::string>{ "Bearer secret-abc", "Bearer {{token}}" }));
    const auto rows = db_->get_results (last_run_);
    ASSERT_EQ (rows.size (), 4u);
    EXPECT_EQ (json::parse (rows[2].trace_data)["elements"][0]["outcome"], "skipped");
    // Counted as a miss all the same: the value went.
    const std::vector<int64_t> counted{ -1, -1, 1, -1 };
    EXPECT_EQ (misses_stored_and_live (), std::make_pair (counted, counted));
}

// `matchNo: -1` writes `ids_1` .. `ids_N` and `ids_matchNr`: a shorter list
// unsets the numbered names past its own end, and a miss unsets them all.
// `[a-z]+` finds `token secret abc`, then `token tok`, then nothing.
// Mutation check: drop the `unset_numbered_from` call after a hit and the
// second marker ends `abc`.
TEST_F (ScenarioRunnerExtractorMissTest, EveryMatchUnsetsTheNumberedNamesNoLongerMatched) {
    seed_collection ("col_1");
    const json extractor = { { "id", "el_ids" }, { "kind", "extract.regex" },
        { "enabled", true },
        { "config", { { "pattern", "[a-z]+" }, { "variable", "ids" }, { "matchNo", -1 } } } };

    const auto sent = step_one_after (extractor, { "token", "login-n", "ok" },
    "{{ids_matchNr}} {{ids_1}} {{ids_3}}");

    ASSERT_EQ (sent.size (), 3u);
    EXPECT_EQ (sent[0].marker, "3 token abc");
    EXPECT_EQ (sent[1].marker, "2 token {{ids_3}}");
    EXPECT_EQ (sent[2].marker, "{{ids_matchNr}} {{ids_1}} {{ids_3}}");
}

// `timer.think` waits between steps, outside either one's own latency, and
// the wait itself becomes a `step.between` outcome on the step it followed.
TEST_F (ScenarioRunnerTest, TimerThinkWaitsBetweenStepsAndReportsHowLong) {
    seed_collection ("col_1");
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array ({ json{ { "id", "el_timer" }, { "kind", "timer.think" },
    { "config", { { "ms", 200 } } } } }));
    seed_request ("req_b", 1, "/login");

    const auto started = std::chrono::steady_clock::now ();
    const auto run_id  = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started);
    EXPECT_GE (elapsed.count (), 200)
    << "the think time did not hold up the run at all";

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    const auto trace0 = json::parse (rows[0].trace_data);
    ASSERT_EQ (trace0["elements"].size (), 1u);
    EXPECT_EQ (trace0["elements"][0]["kind"], "timer.think");
    EXPECT_EQ (trace0["elements"][0]["outcome"], "ok");
    EXPECT_GE (trace0["elements"][0]["waitedMs"].get<int64_t> (), 200);
    // The wait must not inflate the step's own reported latency - `/ok`
    // answers immediately, so anything near 200ms there would mean the wait
    // ran inside the step instead of between it and the next one.
    EXPECT_LT (rows[0].latency_ms, 100.0);
}

// Issue #1609's acceptance criterion: a blank script.pre is inert - the
// pipeline reports no outcome for it at all, not even "skipped" - while a
// real script.post beside it on the same step still runs and reports.
// Mutation check: revert the `is_blank_script_element` guard in
// `compile_elements` and `trace0["elements"].size ()` reddens to 2.
TEST_F (ScenarioRunnerTest, ABlankScriptPreReportsNoOutcomeButARealScriptPostDoes) {
    seed_collection ("col_1");
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array ({ json{ { "id", "el_blank_pre" }, { "kind", "script.pre" },
                   { "config", { { "script", "  \n" } } } },
    json{ { "id", "el_real_post" }, { "kind", "script.post" },
    { "config", { { "script", "console.log('runs');" } } } } }));

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    const auto trace0 = json::parse (rows[0].trace_data);
    ASSERT_EQ (trace0["elements"].size (), 1u);
    EXPECT_EQ (trace0["elements"][0]["id"], "el_real_post");
    EXPECT_EQ (trace0["elements"][0]["kind"], "script.post");
    EXPECT_EQ (trace0["elements"][0]["outcome"], "ok");
}

// Issue #1500's acceptance criterion: a metric.record trend on one step
// produces `customMetrics.<name>` in the sequential run's own summary
// section, with a count equal to that step's completions.
TEST_F (ScenarioRunnerTest, MetricRecordProducesCustomMetricsWithTheStepsCompletionCount) {
    seed_collection ("col_1");
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array ({ json{ { "id", "el_metric" }, { "kind", "metric.record" },
    { "config",
    { { "name", "ttfb2" }, { "type", "trend" }, { "source", { { "latency", true } } } } } } }));
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/3);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto custom_metrics = summary_of (run_id)["customMetrics"];
    ASSERT_TRUE (custom_metrics.contains ("ttfb2"));
    EXPECT_EQ (custom_metrics["ttfb2"]["type"], "trend");
    EXPECT_EQ (custom_metrics["ttfb2"]["count"].get<size_t> (), 3u)
    << "one recording per iteration of the step it is attached to";
}

// A collection run's own local `RunSummaryInputs` (built fresh in
// `execute_scenario_run` rather than reusing `summary`) must carry
// `custom_metrics` through to `evaluate_thresholds`, or a declared
// `custom.<name>.<stat>` budget reads as unmeasured even though the value
// sits right there in the summary. Mutation check: comment out
// `threshold_inputs.custom_metrics = summary.custom_metrics;` in
// `execute_scenario_run`, and `evaluated` reds to false.
TEST_F (ScenarioRunnerTest, ACollectionRunJudgesADeclaredCustomMetricBudget) {
    seed_collection ("col_1");
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array ({ json{ { "id", "el_metric" }, { "kind", "metric.record" },
    { "config",
    { { "name", "ttfb2" }, { "type", "trend" }, { "source", { { "latency", true } } } } } } }));

    const auto run_id = start_with_thresholds (
    /*iterations=*/1, json{ { "custom.ttfb2.p95", 60000 } });
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto thresholds = summary_of (run_id)["thresholds"];
    ASSERT_FALSE (thresholds.is_null ());
    ASSERT_EQ (thresholds["checks"].size (), 1u);
    const auto& check = thresholds["checks"][0];
    EXPECT_TRUE (check["evaluated"].get<bool> ())
    << "the metric was recorded this run - a generous budget must not read as "
       "no data";
    EXPECT_TRUE (check["passed"].get<bool> ());
}

TEST_F (ScenarioRunnerTest, AStopIsHonouredBetweenStepsNotAfterTheIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/slow");
    seed_request ("req_b", 1, "/slow");
    seed_request ("req_c", 2, "/slow");
    seed_request ("req_d", 3, "/slow");

    const auto run_id = start (/*iterations=*/20);
    // `get_run` rather than `context_for` here, and not by oversight: this
    // test steers a run that must still be in flight, so "active" is the
    // state it means. 80 steps of 120ms is far too long to have finished.
    auto context = manager_.get_run (run_id);
    ASSERT_TRUE (context != nullptr);

    // Stop once the first step has reached the server, so the run is inside
    // its first iteration whatever the runner's speed: a fixed delay stopped
    // it after a whole iteration on a stalled runner.
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] () { return !server_->requests ().empty (); }));
    context->request_stop ();

    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Stopped);

    auto scenario       = summary_of (run_id)["scenario"];
    const auto executed = scenario["steps_executed"].get<size_t> ();
    EXPECT_LT (executed, 20u * 4u);
    // The whole iteration would be 4 steps; the stop landed inside one.
    EXPECT_LT (executed, 8u);
    EXPECT_EQ (scenario["iterations_completed"].get<size_t> (), 0u);
}

// ============================================================================
// A stored streaming request (#3235)
// ============================================================================

// A step whose stored request streams runs as a stream: `/sse-short` holds
// its response open for about 450 ms, past the step's 200 ms timeout, and its
// close ends the step as a pass. Its events reach the stored trace, the run's
// `stream` section and the report; the ordinary step beside it is unchanged.
// Mutation check: send `timeout_ms` as the whole-transfer timeout in
// `Client::send` again and the streaming step errors with a timeout.
TEST_F (ScenarioRunnerTest, AStoredStreamingRequestRunsAsAStreamToTheServersClose) {
    seed_collection ("col_1");
    seed_request ("req_plain", 0, "/ok");
    seed_streaming_request ("req_stream", 1, "/sse-short", /*timeout_ms=*/200);

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 2u);
    EXPECT_FALSE (traces[0].contains ("events"))
    << "an ordinary step has no events";
    const auto& streamed = traces[1];
    EXPECT_EQ (streamed["outcome"].get<std::string> (), "passed") << streamed.dump ();
    EXPECT_FALSE (streamed.contains ("error_type")) << streamed.dump ();
    ASSERT_TRUE (streamed.contains ("events")) << streamed.dump ();
    const auto& events = streamed["events"];
    EXPECT_EQ (events["totalEvents"].get<int64_t> (), ScenarioMockServer::SHORT_STREAM_EVENTS);
    EXPECT_EQ (events["items"].size (),
    static_cast<size_t> (ScenarioMockServer::SHORT_STREAM_EVENTS));
    EXPECT_FALSE (events["eventsTruncated"].get<bool> ());

    const auto summary = summary_of (run_id);
    ASSERT_TRUE (summary.contains ("stream")) << summary.dump ();
    const auto& stream = summary["stream"];
    EXPECT_EQ (stream["completions"].get<size_t> (), 1u)
    << "only the streaming step";
    EXPECT_EQ (stream["totalEvents"].get<int64_t> (), ScenarioMockServer::SHORT_STREAM_EVENTS);
    EXPECT_EQ (stream["capped"].get<size_t> (), 0u) << "the server ended it";
    ASSERT_TRUE (stream.contains ("timeToFirstEvent")) << stream.dump ();
    EXPECT_EQ (stream["timeToFirstEvent"]["count"].get<size_t> (), 1u);
    // A lower bound only: the server holds the first event 150 ms.
    EXPECT_GE (stream["timeToFirstEvent"]["max"].get<double> (), 150.0);
    // The sequential path's completion carries the pace too (#3776): three
    // events in three writes, so one gap and one rate. Asserted as wired, not
    // timed; `APauseBetweenEventsIsTheStreamsLargestGap` holds the timing.
    // Mutation check: drop `event_rate` from `stream_completion_of`
    // (metrics_collector.cpp) and the `eventRate` block is absent.
    ASSERT_TRUE (stream.contains ("maxEventGap")) << stream.dump ();
    EXPECT_EQ (stream["maxEventGap"]["count"].get<size_t> (), 1u);
    ASSERT_TRUE (stream.contains ("eventRate")) << stream.dump ();
    EXPECT_EQ (stream["eventRate"]["count"].get<size_t> (), 1u);

    const auto [status, report] = vayu::http::routes::run_report_response (*db_, run_id);
    ASSERT_EQ (status, 200) << report.dump ();
    ASSERT_TRUE (report.contains ("stream")) << report.dump ();
    EXPECT_EQ (report["stream"]["completions"].get<size_t> (), 1u);
}

// A streaming step's post-request script reads the stream's events (#3769),
// the same node its stored trace carries. Mutation check: drop the
// `bind_buffered_stream_events` call in `execute_exchange`'s post-request
// callback and the script's test fails on an undefined `pm.response.events`.
TEST_F (ScenarioRunnerTest, AStreamingStepsPostRequestScriptReadsItsEvents) {
    seed_collection ("col_1");
    seed_streaming_request ("req_stream", 0, "/sse-short", /*timeout_ms=*/200, R"(
        pm.test('events are readable', function () {
            if (typeof pm.response.events === 'undefined') {
                throw new Error('pm.response.events was undefined');
            }
            pm.expect(pm.response.events.length).to.equal(3);
            pm.expect(pm.response.events[0].data).to.equal('tick');
            pm.expect(pm.response.totalEvents).to.equal(3);
            pm.expect(pm.response.eventsTruncated).to.equal(false);
        });
    )");
    static_assert (ScenarioMockServer::SHORT_STREAM_EVENTS == 3,
    "the script above asserts the fixture's event count");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 1u);
    const auto& trace = traces[0];
    EXPECT_EQ (trace["outcome"].get<std::string> (), "passed") << trace.dump ();
    const auto& tests = trace["scripts"]["testResults"];
    ASSERT_EQ (tests.size (), 1u) << trace.dump ();
    EXPECT_TRUE (tests[0]["passed"].get<bool> ()) << tests[0].dump ();
}

// A streaming step whose stored request declares a `streamTextPath` (#3773)
// reads its reply as text: each event's `text`, the joined
// `pm.response.streamText`, and the same on the step's stored trace, while a
// step that declares none binds neither. Mutation check: drop the
// `response.stream_text_path` assignment in `StreamTally::report` and the
// first step's test fails on an undefined `streamText`.
TEST_F (ScenarioRunnerTest, AStreamingStepReadsItsReplyThroughItsStoredTextPath) {
    seed_collection ("col_1");
    seed_streaming_request ("req_text", 0, "/sse-deltas", /*timeout_ms=*/5000, R"(
        pm.test('the reply is assembled', function () {
            pm.expect(pm.response.streamText).to.equal('Hello');
            pm.expect(pm.response.events[0].text).to.equal('Hel');
            pm.expect(pm.response.events[1]).to.not.have.property('text');
            pm.expect(pm.response.events[3]).to.not.have.property('text');
        });
    )",
    "$.delta.text");
    seed_streaming_request ("req_plain", 1, "/sse-deltas", /*timeout_ms=*/5000, R"(
        pm.test('no path, no text', function () {
            pm.expect(pm.response.events.length).to.equal(4);
            pm.expect(typeof pm.response.streamText).to.equal('undefined');
            pm.expect(pm.response.events[0]).to.not.have.property('text');
        });
    )");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 2u);
    for (const auto& trace : traces) {
        EXPECT_EQ (trace["outcome"].get<std::string> (), "passed") << trace.dump ();
    }
    EXPECT_EQ (traces[0].at ("events").at ("streamText").get<std::string> (), "Hello")
    << traces[0].dump ();
    EXPECT_FALSE (traces[1].at ("events").contains ("streamText")) << traces[1].dump ();
}

// A streaming step whose stored request declares a `streamFirstContentMarker`
// (#3774) is timed to it, and a step that declares none adds no match: the
// run's `timeToFirstMatch` counts one stream, at least the 300 ms
// `/sse-preamble` holds its content behind its first event (a lower bound
// only, which a slow runner cannot fail). Mutation check: drop the marker
// compile in `step_stream_bounds` and `timeToFirstMatch` is absent.
TEST_F (ScenarioRunnerTest, AStreamingStepIsTimedToItsStoredFirstContentMarker) {
    seed_collection ("col_1");
    seed_streaming_request ("req_marker", 0, "/sse-preamble", /*timeout_ms=*/5000);
    auto marked = db_->get_request ("req_marker");
    ASSERT_HAS_VALUE (marked);
    marked->stream_first_content_marker = "content_block_delta";
    db_->save_request (*marked);
    seed_streaming_request ("req_plain", 1, "/sse-preamble", /*timeout_ms=*/5000);

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto summary = summary_of (run_id);
    ASSERT_TRUE (summary.contains ("stream")) << summary.dump ();
    const auto& stream = summary["stream"];
    EXPECT_EQ (stream["completions"].get<size_t> (), 2u) << stream.dump ();
    ASSERT_TRUE (stream.contains ("timeToFirstMatch")) << stream.dump ();
    const auto& first_match = stream["timeToFirstMatch"];
    EXPECT_EQ (first_match["count"].get<size_t> (), 1u)
    << "only the marked step";
    EXPECT_GE (first_match["max"].get<double> (),
    static_cast<double> (ScenarioMockServer::PREAMBLE_CONTENT_DELAY_MS))
    << stream.dump ();
}

// Either cap ends a streaming step as a pass, and the run's `stream` section
// says a cap did. Mutation check: ignore `stream_bounds` in `Client::send`
// (no tally started, `timeout_ms` as the whole-transfer timeout) and both
// steps error at their 200 ms timeout instead.
TEST_F (ScenarioRunnerTest, EitherCapEndsAStreamingStepAsAPass) {
    seed_collection ("col_1");
    seed_streaming_request ("req_events", 0, "/sse-endless", /*timeout_ms=*/200);
    seed_streaming_request ("req_quiet", 1, "/sse-silent", /*timeout_ms=*/200);
    constexpr int64_t EVENT_CAP = 4;
    stream_bounds_              = vayu::StreamBounds{ 1000, EVENT_CAP };

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 2u);
    for (const auto& trace : traces) {
        EXPECT_EQ (trace["outcome"].get<std::string> (), "passed") << trace.dump ();
    }
    EXPECT_GE (traces[0].at ("events").at ("totalEvents").get<int64_t> (), EVENT_CAP)
    << "the event cap ended the endless stream";
    EXPECT_EQ (traces[1].at ("events").at ("totalEvents").get<int64_t> (), 0)
    << "the duration cap ended the silent one";

    const auto stream = summary_of (run_id)["stream"];
    EXPECT_EQ (stream["completions"].get<size_t> (), 2u) << stream.dump ();
    EXPECT_EQ (stream["capped"].get<size_t> (), 2u) << stream.dump ();
}

// The stream budgets read the section the run just stored. Mutation check:
// drop `threshold_inputs.stream` in `execute_scenario_run` and both checks
// report no data.
TEST_F (ScenarioRunnerTest, ACollectionRunJudgesItsStreamBudgets) {
    seed_collection ("col_1");
    seed_streaming_request ("req_stream", 0, "/sse-short", /*timeout_ms=*/200);

    const auto run_id = start_with_thresholds (/*iterations=*/1,
    json{ { "streamTimeToFirstEventP95Ms", 60000 }, { "streamEventsPerSecondMin", 0.001 } });
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto thresholds = summary_of (run_id)["thresholds"];
    ASSERT_EQ (thresholds.at ("checks").size (), 2u) << thresholds.dump ();
    for (const auto& check : thresholds["checks"]) {
        EXPECT_TRUE (check.at ("evaluated").get<bool> ()) << check.dump ();
        EXPECT_TRUE (check.at ("passed").get<bool> ()) << check.dump ();
    }
}

TEST_F (ScenarioRunnerTest, ARunWithNoStreamingStepHasNoStreamSection) {
    seed_collection ("col_1");
    seed_request ("req_plain", 0, "/ok");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_FALSE (summary_of (run_id).contains ("stream"));
    EXPECT_FALSE (stored_traces (run_id).at (0).contains ("events"));
}

// A stop reaches into an in-flight stream, which nothing else would end
// before its 30 s cap. Healthy, the run is stopped within about a second
// (libcurl's progress cadence); broken, it waits out the cap, so the 10 s
// bound sits between the two. Mutation check: drop the `inputs.cancel` a
// streaming step sets in `run_step_exchange` and the bound fails.
TEST_F (ScenarioRunnerTest, AStopEndsAnInFlightStreamingStepPromptly) {
    seed_collection ("col_1");
    seed_streaming_request ("req_stream", 0, "/sse-silent", /*timeout_ms=*/200);
    stream_bounds_ = vayu::StreamBounds{ 30000, 1000000 };

    const auto run_id = start (/*iterations=*/1);
    auto context      = manager_.get_run (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] () { return !server_->requests ().empty (); }));

    const auto stopped_at = std::chrono::steady_clock::now ();
    context->request_stop ();
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Stopped);
    const auto took = std::chrono::steady_clock::now () - stopped_at;

    EXPECT_LT (took, std::chrono::seconds (10));
    EXPECT_EQ (summary_of (run_id)["scenario"]["steps_executed"].get<size_t> (), 1u);
}

// ============================================================================
// A Stop cuts an ordinary step short (#3397)
// ============================================================================

/// The hanging step's own timeout in the Stop cases: what a Stop that does not
/// reach its transfer waits out, inside `/hang`'s 30 s hold.
constexpr int HANGING_STEP_TIMEOUT_MS = 20000;

/// Healthy, a Stop settles about a second after it lands (libcurl's progress
/// cadence); broken, it waits out `HANGING_STEP_TIMEOUT_MS`. Between the two.
constexpr auto STOP_SETTLES_WITHIN = std::chrono::seconds (10);

// A Stop ends an ordinary step's transfer as it ends a stream's, and the step
// it cut short is `stopped`: in no failure tally, no request the report
// counts, and the step after it is neither sent nor stored. Mutation checks:
// put back the `stream_bounds` condition on `inputs.cancel` in
// `run_step_exchange` and the bound fails with the step `errored` at its
// timeout; answer `Errored` for every error in `classify_step` and the step
// is `errored`.
TEST_F (ScenarioRunnerTest, AStopEndsAnInFlightStepAsStoppedNotFailed) {
    const vayu::tests::SlowMockServer upstream;
    seed_collection ("col_1");
    seed_request ("req_hang", 0, "", "", "", upstream.hang_url ());
    set_request_timeout ("req_hang", HANGING_STEP_TIMEOUT_MS);
    seed_request ("req_after", 1, "/ok");

    const auto run_id = start (/*iterations=*/1);
    const auto took =
    stop_once (run_id, [&upstream] () { return upstream.hang_count () > 0; });
    EXPECT_LT (took, STOP_SETTLES_WITHIN);

    EXPECT_TRUE (server_->requests ().empty ())
    << "the step after the stopped one ran";
    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 1u) << "only the stopped step is stored";
    EXPECT_EQ (traces[0].value ("outcome", ""), "stopped") << traces[0].dump ();
    EXPECT_FALSE (traces[0].contains ("stepsNotRun")) << traces[0].dump ();

    const auto summary   = summary_of (run_id);
    const auto& scenario = summary.at ("scenario");
    EXPECT_EQ (scenario.value ("steps_executed", -1), 1) << scenario.dump ();
    EXPECT_EQ (scenario.value ("stopped", -1), 1) << scenario.dump ();
    for (const char* key : { "passed", "failed", "skipped", "errored", "steps_not_run" }) {
        EXPECT_EQ (scenario.value (key, -1), 0) << key << ": " << scenario.dump ();
    }
    EXPECT_EQ (summary.value ("total_requests", -1), 0) << summary.dump ();
    EXPECT_EQ (summary.at ("status_codes"), json::object ()) << summary.dump ();

    const auto frames = step_frames (context_for (run_id));
    ASSERT_EQ (frames.size (), 1u);
    EXPECT_NE (frames[0].find (R"("outcome":"stopped")"), std::string::npos)
    << frames[0];
}

// `stopOnError` reads errors, and a stopped step is none: it ends the run, not
// an iteration, so it costs no `stepsNotRun`. Mutation check: answer `Errored`
// for every error in `classify_step` and the step reports one position lost.
TEST_F (ScenarioRunnerTest, AStoppedStepCostsNoStepsUnderStopOnError) {
    const vayu::tests::SlowMockServer upstream;
    seed_collection ("col_1");
    seed_request ("req_hang", 0, "", "", "", upstream.hang_url ());
    set_request_timeout ("req_hang", HANGING_STEP_TIMEOUT_MS);
    seed_request ("req_after", 1, "/ok");

    const auto run_id = start_stopping_on_error (/*iterations=*/1);
    EXPECT_LT (
    stop_once (run_id, [&upstream] () { return upstream.hang_count () > 0; }),
    STOP_SETTLES_WITHIN);

    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 1u);
    EXPECT_EQ (traces[0].value ("outcome", ""), "stopped") << traces[0].dump ();
    EXPECT_FALSE (traces[0].contains ("stepsNotRun")) << traces[0].dump ();
    const auto scenario = summary_of (run_id).at ("scenario");
    EXPECT_EQ (scenario.value ("steps_not_run", -1), 0) << scenario.dump ();
    EXPECT_EQ (scenario.value ("errored", -1), 0) << scenario.dump ();
}

// A stopped step ends the run before anything that reads a finished step, so
// the transaction it is the last member of does not close on it, as an
// errored pass or otherwise. Mutation check: drop the `Stopped` early return
// in `run_iteration` and `checkout` closes once with one error.
TEST_F (ScenarioRunnerTest, AStoppedStepClosesNoTransaction) {
    const vayu::tests::SlowMockServer upstream;
    seed_collection ("col_1");
    seed_collection_with_elements ("folder_1", "col_1",
    json::array ({ { { "id", "el_txn" }, { "kind", "control.transaction" },
    { "enabled", true }, { "config", { { "name", "checkout" } } } } }));
    seed_request ("req_hang", 0, "", "", "", upstream.hang_url ());
    set_request_timeout ("req_hang", HANGING_STEP_TIMEOUT_MS);
    move_request ("req_hang", "folder_1");
    recursive_ = true;

    const auto run_id = start (/*iterations=*/1);
    EXPECT_LT (
    stop_once (run_id, [&upstream] () { return upstream.hang_count () > 0; }),
    STOP_SETTLES_WITHIN);

    const auto scenario = summary_of (run_id).at ("scenario");
    EXPECT_EQ (scenario.value ("stopped", -1), 1) << scenario.dump ();
    EXPECT_FALSE (scenario.contains ("transactions")) << scenario.dump ();
}

// A full store keeps failures first, and a stopped step is none: it does not
// displace the success stored before it. Mutation check: keep `Stopped` first
// in `kept_before_successes` and the stored row is the stopped one.
TEST_F (ScenarioRunnerTest, AStoppedStepTakesNoSuccessesPlaceInAFullStore) {
    const vayu::tests::SlowMockServer upstream;
    set_config ("maxScenarioStoredSteps", "1");
    seed_collection ("col_1");
    seed_request ("req_ok", 0, "/ok");
    seed_request ("req_hang", 1, "", "", "", upstream.hang_url ());
    set_request_timeout ("req_hang", HANGING_STEP_TIMEOUT_MS);

    const auto run_id = start (/*iterations=*/1);
    EXPECT_LT (
    stop_once (run_id, [&upstream] () { return upstream.hang_count () > 0; }),
    STOP_SETTLES_WITHIN);

    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 1u);
    EXPECT_EQ (traces[0].value ("outcome", ""), "passed") << traces[0].dump ();
    EXPECT_EQ (summary_of (run_id).at ("scenario").value ("steps_dropped", -1), 1);
}

// The late OAuth 2.0 token request a step's script defers (#2473) takes the
// Stop too, and the step it cut short is `stopped`, though the token request
// reports the cancel as a network error. Mutation check: drop the
// `oauth2_network_error` half of `ended_by_cancel` (scenario_runner.cpp) and
// the step is `errored`.
TEST_F (ScenarioRunnerTest, AStopDuringALateTokenRequestStopsTheStep) {
    const vayu::tests::MockTokenServer tokens;
    seed_collection ("col_1");
    seed_environment ("env_1", R"({"secret":{"value":"stored","enabled":true}})");
    const json auth = { { "mode", "oauth2" },
        { "config",
        { { "grantType", "client_credentials" },
        { "accessTokenUrl", tokens.url ("/token-hang") }, { "clientId", "cid" },
        { "clientSecret", "{{secret}}" }, { "credentialsPlacement", "body" } } } };
    seed_request ("req_a", 0, "/ok", "pm.environment.set('secret', 'from-script');",
    "", "", "", "", "", auth.dump ());
    set_request_timeout ("req_a", HANGING_STEP_TIMEOUT_MS);

    const auto run_id = start (/*iterations=*/1, "env_1");
    EXPECT_LT (stop_once (run_id, [&tokens] () { return tokens.hits () > 0; }),
    STOP_SETTLES_WITHIN);

    EXPECT_TRUE (server_->requests ().empty ())
    << "the step was sent without its token";
    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 1u);
    EXPECT_EQ (traces[0].value ("outcome", ""), "stopped") << traces[0].dump ();
    const auto scenario = summary_of (run_id).at ("scenario");
    EXPECT_EQ (scenario.value ("stopped", -1), 1) << scenario.dump ();
    EXPECT_EQ (scenario.value ("errored", -1), 0) << scenario.dump ();
}

// ============================================================================
// Bounded step storage
// ============================================================================

TEST_F (ScenarioRunnerTest, TheStoreKeepsEveryFailureFirstAndThinsSuccesses) {
    // Capacity 3, offered five successes then two failures: every failure is
    // kept, the successes that survive are the run's opening, and the
    // displaced ones are counted.
    ScenarioStepStore store (3);
    for (int i = 0; i < 5; ++i) {
        vayu::db::Result row;
        row.status_code = 200 + i;
        store.add (std::move (row), /*kept_first=*/false);
    }
    EXPECT_EQ (store.stored (), 3u);
    EXPECT_EQ (store.dropped (), 2u);

    for (int i = 0; i < 2; ++i) {
        vayu::db::Result row;
        row.status_code = 500 + i;
        store.add (std::move (row), /*kept_first=*/true);
    }

    auto rows = store.take ();
    ASSERT_EQ (rows.size (), 3u);
    EXPECT_EQ (store.dropped (), 4u);
    // Execution order is preserved across the two stores.
    EXPECT_EQ (rows[0].status_code, 200);
    EXPECT_EQ (rows[1].status_code, 500);
    EXPECT_EQ (rows[2].status_code, 501);
}

TEST_F (ScenarioRunnerTest, TheStoreRefusesAFailureOnlyWhenNoSuccessIsLeftToDisplace) {
    ScenarioStepStore store (2);
    for (int i = 0; i < 3; ++i) {
        vayu::db::Result row;
        row.status_code = 500 + i;
        store.add (std::move (row), /*kept_first=*/true);
    }

    auto rows = store.take ();
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_EQ (rows[0].status_code, 500);
    EXPECT_EQ (rows[1].status_code, 501);
    EXPECT_EQ (store.dropped (), 1u);
}

TEST_F (ScenarioRunnerTest, ACapacityOfZeroStoresEverything) {
    ScenarioStepStore store (0);
    for (int i = 0; i < 50; ++i) {
        store.add (vayu::db::Result{}, /*kept_first=*/i % 2 == 0);
    }
    EXPECT_EQ (store.take ().size (), 50u);
    EXPECT_EQ (store.dropped (), 0u);
}

TEST_F (ScenarioRunnerTest, ThinningIsDisclosedRatherThanPresentedAsComplete) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/ok");
    set_config ("maxScenarioStoredSteps", "3");

    const auto run_id = start (/*iterations=*/3);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_EQ (db_->get_results (run_id).size (), 3u);

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["steps_executed"].get<size_t> (), 6u);
    EXPECT_EQ (scenario["steps_stored"].get<size_t> (), 3u);
    EXPECT_EQ (scenario["steps_dropped"].get<size_t> (), 3u);
    // The report counts the run's real size, not the rows that survived, and
    // reads its distribution from the summary for the same reason (#2822).
    const auto summary = summary_of (run_id);
    EXPECT_EQ (summary["total_requests"].get<size_t> (), 6u);
    EXPECT_EQ (summary["status_codes"], (json{ { "200", 6 } })) << summary.dump ();
}

// ============================================================================
// The live stream
// ============================================================================

TEST_F (ScenarioRunnerTest, StepEventsCarryTheStepAndKeepMonotonicIdsAcrossEviction) {
    vayu::core::StepRecord record;
    record.iteration   = 2;
    record.step_index  = 1;
    record.step_name   = "Login";
    record.outcome     = StepOutcome::Failed;
    record.status_code = 500;
    record.latency_ms  = 12.5;

    const auto payload = vayu::core::build_step_payload (record, 7);
    EXPECT_NE (payload.find ("event: step\n"), std::string::npos);
    EXPECT_NE (payload.find ("id: 7\n"), std::string::npos);
    const auto data_at = payload.find ("data: ");
    ASSERT_NE (data_at, std::string::npos);
    auto data = json::parse (payload.substr (data_at + 6));
    EXPECT_EQ (data["iteration"].get<size_t> (), 2u);
    EXPECT_EQ (data["stepIndex"].get<size_t> (), 1u);
    EXPECT_EQ (data["name"].get<std::string> (), "Login");
    EXPECT_EQ (data["outcome"].get<std::string> (), "failed");
    EXPECT_EQ (data["statusCode"].get<int> (), 500);
    EXPECT_DOUBLE_EQ (data["latencyMs"].get<double> (), 12.5);

    // The ring evicts; the ids do not restart, which is what makes
    // `Last-Event-ID` resume land on the right event.
    vayu::core::RunContext context ("run_ring", json::object ());
    context.set_max_live_ticks (2);
    for (size_t i = 0; i < 5; ++i) {
        context.append_tick (
        vayu::core::build_step_payload (record, context.published_count.load ()));
    }
    EXPECT_EQ (context.published_count.load (), 5u);
    auto batch = context.ticks_since (0);
    ASSERT_EQ (batch.payloads.size (), 2u);
    EXPECT_NE (batch.payloads[0].find ("id: 3\n"), std::string::npos);
    EXPECT_NE (batch.payloads[1].find ("id: 4\n"), std::string::npos);
    EXPECT_EQ (batch.next_offset, 5u);
}

namespace {

json step_frame_data (const std::string& payload) {
    const auto data_at = payload.find ("data: ");
    EXPECT_NE (data_at, std::string::npos) << payload;
    return json::parse (payload.substr (data_at + 6));
}

} // namespace

// What a step sent rides its frame (#3634), on the stored row's terms: a bare
// record - a skipped step, a row that could not bind - carries none of it.
TEST_F (ScenarioRunnerTest, StepEventsCarryWhatTheStepSentOnlyWhenItSent) {
    vayu::core::StepRecord record;
    record.step_name = "Login";
    EXPECT_FALSE (
    step_frame_data (vayu::core::build_step_payload (record, 0)).contains ("method"));

    record.method     = "POST";
    record.url        = "http://localhost/login";
    record.body_bytes = 42;
    const auto sent = step_frame_data (vayu::core::build_step_payload (record, 0));
    EXPECT_EQ (sent["method"].get<std::string> (), "POST");
    EXPECT_EQ (sent["url"].get<std::string> (), "http://localhost/login");
    EXPECT_EQ (sent["bodyBytes"].get<size_t> (), 42u);

    // An empty body is a size of zero, not an absent one.
    record.body_bytes = 0;
    EXPECT_EQ (
    step_frame_data (vayu::core::build_step_payload (record, 0))["bodyBytes"].get<size_t> (), 0u);
}

// The URL is a client string: a byte that is not UTF-8 must not throw out of
// the frame (and out of the run), as the stored row's dump does not.
TEST_F (ScenarioRunnerTest, AStepFrameWithAnInvalidUtf8UrlIsStillAFrame) {
    vayu::core::StepRecord record;
    record.method = "GET";
    record.url    = "http://localhost/\xFF"
                    "x";
    std::string payload;
    ASSERT_NO_THROW (payload = vayu::core::build_step_payload (record, 0));
    EXPECT_EQ (step_frame_data (payload)["url"].get<std::string> (),
    "http://localhost/\xEF\xBF\xBD"
    "x");
}

TEST_F (ScenarioRunnerTest, ALiveStepFrameCarriesItsMethodUrlAndBodySize) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_post", 1, "/body", "", "", "", "", "", R"({"a":1})");

    const auto run_id  = start (/*iterations=*/1);
    const auto context = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto frames = step_frames (context);
    ASSERT_EQ (frames.size (), 2u);
    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 2u);
    for (size_t i = 0; i < frames.size (); ++i) {
        const auto frame = step_frame_data (frames[i]);
        EXPECT_EQ (frame["method"], traces[i]["request"]["method"]) << frames[i];
        EXPECT_EQ (frame["url"], traces[i]["request"]["url"]) << frames[i];
        EXPECT_EQ (frame["bodyBytes"], traces[i]["response"]["bodyBytes"]) << frames[i];
    }
    EXPECT_EQ (step_frame_data (frames[0])["method"].get<std::string> (), "GET");
    EXPECT_EQ (step_frame_data (frames[1])["method"].get<std::string> (), "POST");
    EXPECT_EQ (step_frame_data (frames[0])["bodyBytes"].get<size_t> (), 2u) << "{}";
}

// A stream's size is what it delivered, which the stored trace states and the
// frame must agree with: an event stream holds no body to measure.
TEST_F (ScenarioRunnerTest, AStreamingStepFrameCarriesTheSizeTheTraceStates) {
    seed_collection ("col_1");
    seed_streaming_request ("req_stream", 0, "/sse-short", /*timeout_ms=*/200);

    const auto run_id  = start (/*iterations=*/1);
    const auto context = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto frames = step_frames (context);
    ASSERT_EQ (frames.size (), 1u);
    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 1u);
    const auto frame = step_frame_data (frames[0]);
    EXPECT_GT (traces[0]["response"]["bodyBytes"].get<size_t> (), 0u);
    EXPECT_EQ (frame["bodyBytes"], traces[0]["response"]["bodyBytes"]) << frames[0];
}

// The frame is the one place a step's URL leaves the engine unmasked-by-default
// (a stored row is the user's own record): the credential never rides it, and
// its place reads `<redacted>` rather than a blank that would look resolved
// empty (#3672). Mutation check: drop `redact_url_credentials` from
// `step_frame_url` and the frame carries the token; drop its
// `CredentialMark::Marker` and the value reads blank.
TEST_F (ScenarioRunnerTest, ALiveStepFrameMasksTheUrlsCredentials) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok?access_token=SECRET-TOKEN&page=2");

    const auto run_id  = start (/*iterations=*/1);
    const auto context = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto frames = step_frames (context);
    ASSERT_EQ (frames.size (), 1u);
    const auto url = step_frame_data (frames[0])["url"].get<std::string> ();
    EXPECT_EQ (url, server_->url ("/ok?access_token=<redacted>&page=2"));
    EXPECT_EQ (frames[0].find ("SECRET-TOKEN"), std::string::npos) << frames[0];
}

// The frame is constant-size: a URL past STEP_FRAME_URL_MAX_BYTES is cut there.
TEST_F (ScenarioRunnerTest, ALiveStepFrameCutsALongUrlAtTheBound) {
    seed_collection ("col_1");
    const std::string head = server_->url ("/ok?q=");
    const std::string url  = head + std::string (700, 'a');
    seed_request ("req_a", 0, "", "", "", url);

    const auto run_id  = start (/*iterations=*/1);
    const auto context = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto frames = step_frames (context);
    ASSERT_EQ (frames.size (), 1u);
    EXPECT_EQ (step_frame_data (frames[0])["url"].get<std::string> (),
    url.substr (0, vayu::core::STEP_FRAME_URL_MAX_BYTES));
}

// The cut lands on a character boundary: a 3-byte character starting at byte
// 510 straddles the bound, and its two kept bytes are dropped, not framed.
// Mutation check: cut with a bare `substr` and the frame ends in `\xE2\x82`,
// which the frame's dump then replaces with U+FFFD.
TEST_F (ScenarioRunnerTest, ALiveStepFrameNeverSplitsACharacterAtTheBound) {
    seed_collection ("col_1");
    const std::string head = server_->url ("/ok?q=");
    const std::string url  = head +
    std::string (vayu::core::STEP_FRAME_URL_MAX_BYTES - 2 - head.size (), 'a') +
    "\xE2\x82\xAC" + std::string (100, 'b');
    ASSERT_EQ (url.find ("\xE2\x82\xAC"), vayu::core::STEP_FRAME_URL_MAX_BYTES - 2);
    seed_request ("req_a", 0, "", "", "", url);
    // Composition percent-encodes a non-ASCII byte, so only a request that
    // opts out (Postman's `disableUrlEncoding`) puts the raw character on the
    // step's request.
    auto stored = db_->get_request ("req_a");
    ASSERT_HAS_VALUE (stored);
    stored->disable_url_encoding = true;
    db_->save_request (*stored);

    const auto run_id  = start (/*iterations=*/1);
    const auto context = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto frames = step_frames (context);
    ASSERT_EQ (frames.size (), 1u);
    const auto framed = step_frame_data (frames[0])["url"].get<std::string> ();
    EXPECT_EQ (framed.size (), vayu::core::STEP_FRAME_URL_MAX_BYTES - 2) << framed;
    EXPECT_EQ (framed.find ("\xEF\xBF\xBD"), std::string::npos) << framed;
}

// A step that sent nothing has no request to name.
TEST_F (ScenarioRunnerTest, ASkippedStepsFrameCarriesNoRequest) {
    seed_collection ("col_1");
    seed_request ("req_skip", 0, "/ok", R"(pm.execution.skipRequest();)");

    const auto run_id  = start (/*iterations=*/1);
    const auto context = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto frames = step_frames (context);
    ASSERT_EQ (frames.size (), 1u);
    const auto frame = step_frame_data (frames[0]);
    EXPECT_EQ (frame["outcome"].get<std::string> (), "skipped") << frames[0];
    EXPECT_FALSE (frame.contains ("method")) << frames[0];
    EXPECT_FALSE (frame.contains ("url")) << frames[0];
    EXPECT_FALSE (frame.contains ("bodyBytes")) << frames[0];
}

TEST_F (ScenarioRunnerTest, TheRunPublishesOneStepEventPerStepAndClosesTheStream) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/2);
    auto context      = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    // Five frames for four steps: the stream opens with the plan's size
    // (issue #1398) and carries one `step` per step after it.
    EXPECT_EQ (context->published_count.load (), 5u);
    EXPECT_TRUE (context->closed.load ());
    auto batch = context->ticks_since (0);
    ASSERT_EQ (batch.payloads.size (), 5u);
    EXPECT_NE (batch.payloads[0].find ("event: plan\n"), std::string::npos)
    << batch.payloads[0];
    EXPECT_EQ (step_frames (context).size (), 4u);
}

// The plan frame itself (issue #1398): a collection run publishes no `metrics`
// ticks, so the size it resolved reaches a watcher here or nowhere, and a
// taskbar with no denominator can only paint an indeterminate bar.
TEST_F (ScenarioRunnerTest, TheStreamOpensWithTheSizeTheRunResolved) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/3);
    auto context      = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto batch = context->ticks_since (0);
    ASSERT_FALSE (batch.payloads.empty ());
    // First, not merely present: a client reads the total once and then counts
    // steps against it, so a frame published after the steps it describes
    // would leave the run indeterminate for as long as it took to arrive.
    const auto& opening = batch.payloads[0];
    EXPECT_NE (opening.find ("event: plan\n"), std::string::npos) << opening;
    const auto data_at = opening.find ("data: ");
    ASSERT_NE (data_at, std::string::npos) << opening;
    const auto plan = json::parse (opening.substr (data_at + 6));
    EXPECT_EQ (plan["stepsPerIteration"].get<size_t> (), 2u);
    EXPECT_EQ (plan["iterations"].get<size_t> (), 3u);
    EXPECT_EQ (plan["stepsExpected"].get<size_t> (), 6u);
}

// The count a data set implies is the resolved one, not the one asked for: a
// run with rows and no explicit `iterations` runs once per row, and a client
// that had to derive the total itself would be reading a field that is absent.
TEST_F (ScenarioRunnerTest, ThePlanFrameCountsTheIterationsADataSetImplies) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");

    const auto run_id = start_with_data (json::array ({ { { "marker", "row-0" } },
    { { "marker", "row-1" } }, { { "marker", "row-2" } } }));
    auto context = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto batch = context->ticks_since (0);
    ASSERT_FALSE (batch.payloads.empty ());
    const auto data_at = batch.payloads[0].find ("data: ");
    ASSERT_NE (data_at, std::string::npos) << batch.payloads[0];
    const auto plan = json::parse (batch.payloads[0].substr (data_at + 6));
    EXPECT_EQ (plan["stepsPerIteration"].get<size_t> (), 1u);
    EXPECT_EQ (plan["iterations"].get<size_t> (), 3u);
    EXPECT_EQ (plan["stepsExpected"].get<size_t> (), 3u);
    EXPECT_EQ (step_frames (context).size (), 3u);
}

} // namespace
