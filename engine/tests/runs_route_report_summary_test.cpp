/**
 * @file tests/runs_route_report_summary_test.cpp
 * @brief GET /runs/:id/report read from the stored whole-run summary: streams, scenario runs, the rate
 * and fidelity figures, older summaries, and a run that is still live.
 *
 * Covers the route's extracted core in isolation, matching the suite's other route tests (no
 * in-process HTTP server). The `RunsRouteTest` fixture is in `runs_route_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <array>
#include <chrono>
#include <future>
#include <map>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "load_start_stamp.hpp"
#include "runs_route_fixture.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/core/threshold_eval.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "wait_until.hpp"

using nlohmann::json;

namespace {

using vayu::tests::summary_inputs;

// ============================================================================
// GET /runs/:id/report - the stored whole-run summary, and the sampled-results
// fallback when it is malformed or absent
// ============================================================================

TEST_F (RunsRouteTest, ReportMissingRunIs404) {
    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_nope");
    EXPECT_EQ (status, 404);
    ASSERT_TRUE (body.contains ("error"));
    EXPECT_EQ (body["error"]["code"], "not_found");
    EXPECT_EQ (body["error"]["message"], "Run not found");
}

// A completed run reports from its stored summary - no metric rows involved.
TEST_F (RunsRouteTest, ReportReadsTheStoredSummary) {
    seed ({ .id = "run_sum", .start_time = 1000 });
    db_->update_run_summary ("run_sum",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_sum");
    ASSERT_EQ (status, 200);

    const auto& summary = body["summary"];
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), 100u);
    EXPECT_DOUBLE_EQ (summary["avgRps"].get<double> (), 50.0);
    EXPECT_DOUBLE_EQ (summary["sendRate"].get<double> (), 51.0);
    EXPECT_DOUBLE_EQ (summary["throughput"].get<double> (), 49.5);
    EXPECT_DOUBLE_EQ (summary["testDuration"].get<double> (), 2.0);
    EXPECT_DOUBLE_EQ (summary.value ("setupOverhead", -1.0), 0.25);
    EXPECT_DOUBLE_EQ (summary.value ("cleanupOverhead", -1.0), 0.125);
    EXPECT_EQ (summary["peakConcurrency"].get<size_t> (), 8u);
    EXPECT_EQ (summary["droppedRequests"].get<size_t> (), 2u);
    // The pacer's skips (#2911). Mutation check: drop the `skipped_requests`
    // or `stalled_ms` read in `apply_summary_totals` and these read 0.
    EXPECT_EQ (summary["skippedRequests"].get<size_t> (), 5u);
    EXPECT_DOUBLE_EQ (summary["stalledMs"].get<double> (), 500.0);
    EXPECT_DOUBLE_EQ (summary["avgQueueWaitMs"].get<double> (), 1.5);
    EXPECT_EQ (summary["bytesSent"].get<size_t> (), 1024u);
    EXPECT_EQ (summary["bytesReceived"].get<size_t> (), 8192u);
    // The one summary figure that is about the report's validity rather than
    // its performance: how many transfers asked for HTTP/2 and did not get it.
    // It has to survive the store -> report round trip, or a run measured over
    // HTTP/1.1 keeps being labelled with the protocol that was requested.
    EXPECT_EQ (summary["httpVersionDowngraded"].get<size_t> (), 4u);
    // Requests libcurl re-sent on a new connection (#2799). Mutation check:
    // drop the `connection_replays` read in runs.cpp and this key is absent.
    EXPECT_EQ (summary.value ("connectionReplays", size_t{ 0 }), 6u);
    // The run's mean in flight (#2821). Mutation check: drop the
    // `avg_in_flight` read in runs.cpp and this key is absent.
    EXPECT_DOUBLE_EQ (summary.value ("avgInFlight", -1.0), 3.25);

    // successful/failed are recounted from the stored distribution, so the 3
    // transport errors (code 0) land on the failed side.
    EXPECT_EQ (summary["successfulRequests"].get<size_t> (), 90u);
    EXPECT_EQ (summary["failedRequests"].get<size_t> (), 10u);
    // ... and broken down the way the live tick and the stop response break
    // them down (#2124): the 7 HTTP 500s got a response, the 3 did not.
    EXPECT_EQ (summary["httpErrorRequests"].get<size_t> (), 7u);
    EXPECT_EQ (summary["noResponseRequests"].get<size_t> (), 3u);
    EXPECT_DOUBLE_EQ (summary["errorRate"].get<double> (), 10.0);

    const auto& latency = body["latency"];
    EXPECT_DOUBLE_EQ (latency["min"].get<double> (), 1.0);
    EXPECT_DOUBLE_EQ (latency["max"].get<double> (), 90.0);
    EXPECT_DOUBLE_EQ (latency["avg"].get<double> (), 12.5);
    EXPECT_DOUBLE_EQ (latency["p50"].get<double> (), 10.0);
    EXPECT_DOUBLE_EQ (latency["p75"].get<double> (), 15.0);
    EXPECT_DOUBLE_EQ (latency["p90"].get<double> (), 20.0);
    EXPECT_DOUBLE_EQ (latency["p95"].get<double> (), 25.0);
    EXPECT_DOUBLE_EQ (latency["p99"].get<double> (), 30.0);
    EXPECT_DOUBLE_EQ (latency["p999"].get<double> (), 35.0);

    // statusCodes / byStatusCode are integer-keyed maps, which nlohmann emits
    // as arrays of [code, count] pairs sorted by code - the shape this endpoint
    // has always returned.
    ASSERT_TRUE (body["statusCodes"].is_array ());
    ASSERT_EQ (body["statusCodes"].size (), 3u);
    EXPECT_EQ (body["statusCodes"][1][0].get<int> (), 200);
    EXPECT_EQ (body["statusCodes"][1][1].get<size_t> (), 90u);
    ASSERT_TRUE (body["errors"]["byStatusCode"].is_array ());
    EXPECT_EQ (body["errors"]["byStatusCode"][1][0].get<int> (), 500);
    EXPECT_EQ (body["errors"]["byStatusCode"][1][1].get<size_t> (), 7u);

    ASSERT_TRUE (body.contains ("testValidation"));
    EXPECT_EQ (body["testValidation"]["samplesTested"].get<int> (), 10);
    EXPECT_EQ (body["testValidation"]["testsPassed"].get<int> (), 9);
    EXPECT_EQ (body["testValidation"]["testsFailed"].get<int> (), 1);
    // A replay that logged nothing reports no console list (#3127).
    EXPECT_FALSE (body["testValidation"].contains ("console"));
    EXPECT_FALSE (body["testValidation"].contains ("consoleDropped"));
}

// #3234: a streaming run's report carries the time to first event beside the
// event rate, and leaves it out when no stream delivered a timed event.
// Mutation check: drop the `timeToFirstEvent` write in
// `build_run_summary_payload` and the first block fails; write it whatever
// the count and the last expectation fails.
TEST_F (RunsRouteTest, ReportCarriesAStreamsTimeToFirstEvent) {
    vayu::core::MetricsCollector::StreamTotals stream;
    stream.completions               = 4;
    stream.total_events              = 40;
    stream.time_to_first_event.count = 3;
    stream.time_to_first_event.p50   = 410.0;
    stream.time_to_first_event.p95   = 650.0;
    stream.time_to_first_event.p99   = 800.0;
    stream.time_to_first_event.max   = 910.0;
    auto inputs                      = summary_inputs ();
    inputs.stream                    = stream;
    seed ({ .id = "run_stream", .start_time = 1000 });
    db_->update_run_summary (
    "run_stream", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_stream");
    ASSERT_EQ (status, 200) << body.dump ();
    const auto& reported = body["stream"];
    // 40 events over the 2s test duration.
    EXPECT_DOUBLE_EQ (reported.value ("eventsPerSecond", -1.0), 20.0);
    ASSERT_TRUE (reported.contains ("timeToFirstEvent")) << reported.dump ();
    const auto& first_event = reported["timeToFirstEvent"];
    EXPECT_DOUBLE_EQ (first_event.value ("p50", -1.0), 410.0);
    EXPECT_DOUBLE_EQ (first_event.value ("p95", -1.0), 650.0);
    EXPECT_DOUBLE_EQ (first_event.value ("p99", -1.0), 800.0);
    EXPECT_DOUBLE_EQ (first_event.value ("max", -1.0), 910.0);
    EXPECT_EQ (first_event.value ("count", 0), 3);

    stream.time_to_first_event = {};
    inputs.stream              = stream;
    EXPECT_FALSE (vayu::core::build_run_summary_payload (inputs)["stream"].contains (
    "timeToFirstEvent"));
}

// #3776: the largest event gap and the per-stream rate reach the report the
// same way, and stay out of it when no stream measured them. Mutation check:
// drop either from the table in `build_stream_summary_payload` and its block
// fails; write them whatever the count and the last expectation fails.
TEST_F (RunsRouteTest, ReportCarriesAStreamsLargestGapAndEventRate) {
    vayu::core::MetricsCollector::StreamTotals stream;
    stream.completions         = 4;
    stream.total_events        = 160;
    stream.max_event_gap.count = 4;
    stream.max_event_gap.p50   = 27.0;
    stream.max_event_gap.max   = 312.0;
    stream.event_rate.count    = 4;
    stream.event_rate.p50      = 40.0;
    stream.event_rate.max      = 41.5;
    auto inputs                = summary_inputs ();
    inputs.stream              = stream;
    seed ({ .id = "run_stream_pace", .start_time = 1000 });
    db_->update_run_summary (
    "run_stream_pace", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_stream_pace");
    ASSERT_EQ (status, 200) << body.dump ();
    const auto& reported = body["stream"];
    ASSERT_TRUE (reported.contains ("maxEventGap")) << reported.dump ();
    EXPECT_DOUBLE_EQ (reported["maxEventGap"].value ("p50", -1.0), 27.0);
    EXPECT_DOUBLE_EQ (reported["maxEventGap"].value ("max", -1.0), 312.0);
    EXPECT_EQ (reported["maxEventGap"].value ("count", 0), 4);
    ASSERT_TRUE (reported.contains ("eventRate")) << reported.dump ();
    EXPECT_DOUBLE_EQ (reported["eventRate"].value ("p50", -1.0), 40.0);
    EXPECT_DOUBLE_EQ (reported["eventRate"].value ("max", -1.0), 41.5);
    EXPECT_EQ (reported["eventRate"].value ("count", 0), 4);

    stream.max_event_gap = {};
    stream.event_rate    = {};
    inputs.stream        = stream;
    const auto unmeasured =
    vayu::core::build_run_summary_payload (inputs)["stream"];
    EXPECT_FALSE (unmeasured.contains ("maxEventGap")) << unmeasured.dump ();
    EXPECT_FALSE (unmeasured.contains ("eventRate")) << unmeasured.dump ();
}

// #3774: the time to the first content marker reaches the report beside the
// time to first event, and stays out of it when no stream's marker arrived.
// Mutation check: drop the `timeToFirstMatch` write in
// `build_stream_summary_payload` and the first block fails; write it whatever
// the count and the last expectation fails.
TEST_F (RunsRouteTest, ReportCarriesAStreamsTimeToFirstMatch) {
    vayu::core::MetricsCollector::StreamTotals stream;
    stream.completions               = 4;
    stream.total_events              = 40;
    stream.time_to_first_event.count = 4;
    stream.time_to_first_event.p95   = 3.9;
    stream.time_to_first_match.count = 3;
    stream.time_to_first_match.p50   = 1180.0;
    stream.time_to_first_match.p95   = 1240.0;
    stream.time_to_first_match.max   = 1310.0;
    auto inputs                      = summary_inputs ();
    inputs.stream                    = stream;
    seed ({ .id = "run_stream_match", .start_time = 1000 });
    db_->update_run_summary (
    "run_stream_match", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_stream_match");
    ASSERT_EQ (status, 200) << body.dump ();
    const auto& reported = body["stream"];
    ASSERT_TRUE (reported.contains ("timeToFirstMatch")) << reported.dump ();
    const auto& first_match = reported["timeToFirstMatch"];
    EXPECT_DOUBLE_EQ (first_match.value ("p50", -1.0), 1180.0);
    EXPECT_DOUBLE_EQ (first_match.value ("p95", -1.0), 1240.0);
    EXPECT_DOUBLE_EQ (first_match.value ("max", -1.0), 1310.0);
    EXPECT_EQ (first_match.value ("count", 0), 3);

    stream.time_to_first_match = {};
    inputs.stream              = stream;
    EXPECT_FALSE (vayu::core::build_run_summary_payload (inputs)["stream"].contains (
    "timeToFirstMatch"));
}

// #3127: the deferred replay's console lines reach the report, on the run's
// `testValidation` and on a scenario step's `tests`, each with its dropped
// count, and a line logged more than once with its `count`. Mutation check:
// drop the `console` copy in `apply_summary_observations` (runs.cpp) and the
// first block fails; drop the `write_message_sample` call in
// `test_totals_payload` (run_manager.cpp) and both do; drop the `count` write
// in `message_entry` (pipeline.cpp) and both do.
TEST_F (RunsRouteTest, ReportCarriesTheReplaysConsoleLines) {
    using vayu::core::ElementMessage;
    vayu::core::ScriptValidationTotals replayed{ 3, 3, 0, {}, 0 };
    replayed.console = {
        { { ElementMessage::Kind::Console, vayu::ConsoleLevel::Warn, "slow body" }, 3 },
        { { ElementMessage::Kind::Console, vayu::ConsoleLevel::Log, "first token" }, 1 },
    };
    replayed.console_dropped = 4;

    auto inputs     = summary_inputs ();
    inputs.tests    = replayed;
    inputs.scenario = json{ { "steps",
    json::array ({ { { "index", 0 }, { "name", "login" } },
    { { "index", 1 }, { "name", "list" } } }) } };
    vayu::core::attach_step_test_totals (*inputs.scenario, { replayed, std::nullopt });
    seed ({ .id = "run_console", .start_time = 1000 });
    db_->update_run_summary (
    "run_console", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_console");
    ASSERT_EQ (status, 200) << body.dump ();
    // A line logged once carries no `count`: absent means once.
    const json expected_console =
    json::array ({ { { "level", "warn" }, { "text", "slow body" }, { "count", 3 } },
    { { "level", "log" }, { "text", "first token" } } });

    ASSERT_TRUE (body.contains ("testValidation")) << body.dump ();
    const auto& validation = body.at ("testValidation");
    EXPECT_EQ (validation.at ("samplesTested").get<int> (), 3);
    ASSERT_TRUE (validation.contains ("console")) << validation.dump ();
    EXPECT_EQ (validation.at ("console"), expected_console);
    EXPECT_EQ (validation.at ("consoleDropped").get<size_t> (), 4u);

    ASSERT_TRUE (body.contains ("scenario")) << body.dump ();
    const auto& steps = body.at ("scenario").at ("steps");
    ASSERT_EQ (steps.size (), 2u) << steps.dump ();
    ASSERT_TRUE (steps.at (0).contains ("tests")) << steps.dump ();
    EXPECT_EQ (steps.at (0).at ("tests").at ("console"), expected_console);
    EXPECT_EQ (steps.at (0).at ("tests").at ("consoleDropped").get<size_t> (), 4u);
    EXPECT_FALSE (steps.at (1).contains ("tests")) << steps.dump ();
}

// Issue #2389: a collection run's report latency is the summary's sample (the
// steps that sent), not the stored result rows - those include a skipped step's
// 0 ms and, past the store's cap, fewer rows than ran. The seeded rows here
// would give a median of 0 and a max of 5; the summary's sample says otherwise.
// Mutation check: drop the `summary["latency"]` write in
// `build_scenario_summary_payload` (or the summary read in `apply_summary_latency`)
// and the report falls back to the rows' figures.
TEST_F (RunsRouteTest, ScenarioReportLatencyIsTheSummarysSentSampleNotTheStoredRows) {
    seed ({ .id = "run_sent_sample", .type = vayu::RunType::Scenario, .start_time = 1000 });
    seed_result ("run_sent_sample", 0, 0.0);
    seed_result ("run_sent_sample", 0, 0.0);
    seed_result ("run_sent_sample", 200, 5.0);

    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 3;
    inputs.duration_s     = 1.0;
    std::vector<double> sample;
    sample.reserve (1000);
    for (int i = 1; i <= 1000; ++i) {
        sample.push_back (static_cast<double> (i));
    }
    inputs.latency = vayu::core::summarize_latencies (sample);
    db_->update_run_summary ("run_sent_sample",
    vayu::core::build_scenario_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_sent_sample");
    ASSERT_EQ (status, 200);
    const auto& latency = body["latency"];
    EXPECT_DOUBLE_EQ (latency["min"].get<double> (), 1.0);
    EXPECT_DOUBLE_EQ (latency["max"].get<double> (), 1000.0);
    EXPECT_DOUBLE_EQ (latency["avg"].get<double> (), 500.5);
    EXPECT_DOUBLE_EQ (latency["p50"].get<double> (), 500.0);
    EXPECT_DOUBLE_EQ (latency["median"].get<double> (), 500.0);
    EXPECT_DOUBLE_EQ (latency["p75"].get<double> (), 750.0);
    EXPECT_DOUBLE_EQ (latency["p90"].get<double> (), 900.0);
    EXPECT_DOUBLE_EQ (latency["p95"].get<double> (), 950.0);
    EXPECT_DOUBLE_EQ (latency["p99"].get<double> (), 990.0);
    EXPECT_DOUBLE_EQ (latency["p999"].get<double> (), 1000.0);
}

// A collection run in which no step sent stores `latency.count` 0, and the
// report leaves the block out rather than writing zeros a reader would take for
// a measurement. A summary with no `latency` key (a run stored before this
// existed) and a load run's block, which carries no `count`, keep theirs.
// Mutation check: remove the `latency_measured` guard in `build_report_body`
// and the first half fails.
TEST_F (RunsRouteTest, ScenarioReportOmitsLatencyWhenNoStepSent) {
    seed ({ .id = "run_nothing_sent", .type = vayu::RunType::Scenario, .start_time = 1000 });
    seed_result ("run_nothing_sent", 0, 0.0);
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 1;
    inputs.duration_s     = 1.0;
    db_->update_run_summary ("run_nothing_sent",
    vayu::core::build_scenario_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_nothing_sent");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("latency")) << body["latency"].dump ();
    // The one step sent nothing, so the run made no request (#2822).
    EXPECT_EQ (body["summary"]["totalRequests"].get<size_t> (), 0u);

    seed ({ .id = "run_old_scenario", .type = vayu::RunType::Scenario, .start_time = 1000 });
    seed_result ("run_old_scenario", 200, 7.0);
    db_->update_run_summary ("run_old_scenario", R"({"total_requests":1,"test_duration":1.0})");
    auto [old_status, old_body] =
    vayu::http::routes::run_report_response (*db_, "run_old_scenario");
    ASSERT_EQ (old_status, 200);
    ASSERT_TRUE (old_body.contains ("latency"));
    EXPECT_DOUBLE_EQ (old_body["latency"]["max"].get<double> (), 7.0);
}

// A sequential collection run's stored summary, built as the runner builds it:
// `status_codes` is the tally of the steps that sent, and a budget is judged
// off that same tally (`execute_scenario_run`'s threshold inputs).
std::string sequential_summary (size_t steps_executed,
const std::map<int, size_t>& status_codes,
const json& thresholds = json ()) {
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = steps_executed;
    inputs.duration_s     = 2.0;
    inputs.status_codes   = status_codes;
    if (!thresholds.is_null ()) {
        vayu::core::RunSummaryInputs judged;
        judged.total_requests = vayu::count_status_failures (status_codes).total;
        judged.status_codes = status_codes;
        inputs.thresholds =
        vayu::core::evaluate_thresholds (json{ { "thresholds", thresholds } }, judged);
    }
    return vayu::core::build_scenario_summary_payload (inputs).dump ();
}

// #2822, the audit's R5 shape: four iterations of a six-step collection whose
// controllers skipped nine steps. 31 requests went out and none failed; the
// stored rows hold the nine skips as status-0 rows. The report counts requests,
// not rows, and agrees with the budget judged off the same tally.
// Mutation check: restore `total_requests = steps_executed` in
// `build_scenario_summary_payload` and the total fails; drop the stored
// `status_codes` and the failure count and error rate fail.
TEST_F (RunsRouteTest, ScenarioReportCountsASkippedStepAsNeitherARequestNorAFailure) {
    seed ({ .id = "run_r5", .type = vayu::RunType::Scenario, .start_time = 1000 });
    for (int i = 0; i < 31; ++i) {
        seed_result ("run_r5", 200, 5.0);
    }
    for (int i = 0; i < 9; ++i) {
        seed_result ("run_r5", 0, 0.0);
    }
    db_->update_run_summary ("run_r5",
    sequential_summary (40, { { 200, 31 } }, json{ { "maxErrorRatePct", 1 } }));

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_r5");
    ASSERT_EQ (status, 200);
    const auto& summary = body["summary"];
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), 31u);
    EXPECT_EQ (summary["successfulRequests"].get<size_t> (), 31u);
    EXPECT_EQ (summary["failedRequests"].get<size_t> (), 0u);
    EXPECT_EQ (summary["noResponseRequests"].get<size_t> (), 0u);
    EXPECT_DOUBLE_EQ (summary["errorRate"].get<double> (), 0.0);
    EXPECT_DOUBLE_EQ (summary["avgRps"].get<double> (), 15.5);
    EXPECT_EQ (body["statusCodes"], json::array ({ json::array ({ 200, 31 }) }));
    EXPECT_EQ (body["scenario"]["stepsExecuted"].get<size_t> (), 40u);

    ASSERT_TRUE (body.contains ("thresholdValidation")) << body.dump ();
    const auto& check = body["thresholdValidation"]["checks"].at (0);
    EXPECT_DOUBLE_EQ (check["actual"].get<double> (), summary["errorRate"].get<double> ());
}

// The audit's R8 shape: 40 steps of which 16 failed (10 x 404, 6 x 500), with a
// store capped at 20 rows that kept 7 of the failures. The distribution and the
// error rate are the whole run's, not the kept rows' over the whole total.
// Mutation check: drop `status_codes_overridden = true` from
// `apply_summary_status_codes` and the distribution and error rate fail.
TEST_F (RunsRouteTest, ScenarioReportReadsTheWholeRunsDistributionPastTheStoredStepCap) {
    seed ({ .id = "run_r8", .type = vayu::RunType::Scenario, .start_time = 1000 });
    const std::array<std::pair<int, int>, 3> kept{ { { 200, 13 }, { 404, 3 }, { 500, 4 } } };
    for (const auto& [code, count] : kept) {
        for (int i = 0; i < count; ++i) {
            seed_result ("run_r8", code, 5.0);
        }
    }
    db_->update_run_summary (
    "run_r8", sequential_summary (40, { { 200, 24 }, { 404, 10 }, { 500, 6 } }));

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_r8");
    ASSERT_EQ (status, 200);
    size_t distributed = 0;
    for (const auto& entry : body["statusCodes"]) {
        distributed += entry[1].get<size_t> ();
    }
    EXPECT_EQ (distributed, 40u) << body["statusCodes"].dump ();
    const auto& summary = body["summary"];
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), 40u);
    EXPECT_EQ (summary["failedRequests"].get<size_t> (), 16u);
    EXPECT_EQ (summary["httpErrorRequests"].get<size_t> (), 16u);
    EXPECT_DOUBLE_EQ (summary["errorRate"].get<double> (), 40.0);
    // `results` stays the kept rows; only the counts stopped reading them.
    EXPECT_EQ (body["results"].size (), 20u);
}

// A run in which every step was skipped stores an empty distribution, which is
// that run's answer and not a missing one: no request, no failure. A summary
// stored before the distribution was (no `status_codes` key) keeps the report
// it always had, from the rows.
// Mutation check: require a non-empty map for a sequential run in
// `apply_summary_status_codes` and the first half fails on `failedRequests`.
TEST_F (RunsRouteTest, ScenarioReportOfAnAllSkippedRunCountsNoRequestAndNoFailure) {
    seed ({ .id = "run_all_skipped", .type = vayu::RunType::Scenario, .start_time = 1000 });
    for (int i = 0; i < 3; ++i) {
        seed_result ("run_all_skipped", 0, 0.0);
    }
    db_->update_run_summary ("run_all_skipped", sequential_summary (3, {}));

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_all_skipped");
    ASSERT_EQ (status, 200);
    const auto& summary = body["summary"];
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), 0u);
    EXPECT_EQ (summary["failedRequests"].get<size_t> (), 0u);
    EXPECT_EQ (summary["noResponseRequests"].get<size_t> (), 0u);
    EXPECT_DOUBLE_EQ (summary["errorRate"].get<double> (), 0.0);
    EXPECT_TRUE (body["statusCodes"].empty ()) << body["statusCodes"].dump ();
    EXPECT_EQ (body["scenario"]["stepsExecuted"].get<size_t> (), 3u);

    seed ({ .id = "run_older_engine", .type = vayu::RunType::Scenario, .start_time = 1000 });
    seed_result ("run_older_engine", 200, 5.0);
    seed_result ("run_older_engine", 0, 0.0);
    db_->update_run_summary ("run_older_engine",
    R"({"total_requests":2,"test_duration":1.0,"rps":2.0,"scenario":{"steps_executed":2}})");
    auto [old_status, old_body] =
    vayu::http::routes::run_report_response (*db_, "run_older_engine");
    ASSERT_EQ (old_status, 200);
    EXPECT_EQ (old_body["summary"]["totalRequests"].get<size_t> (), 2u);
    EXPECT_EQ (old_body["summary"]["failedRequests"].get<size_t> (), 1u);
    EXPECT_DOUBLE_EQ (old_body["summary"]["errorRate"].get<double> (), 50.0);
}

// A sequential collection run feeds no `MetricsCollector`, so the figures only
// a load run measures are left out of its report rather than written as 0. A
// scenario load run is a `Load` run and keeps them.
// Mutation check: call `add_load_summary_fields` whatever the run type and the
// sequential half fails.
TEST_F (RunsRouteTest, ScenarioReportOmitsTheLoadOnlyFiguresAScenarioLoadRunKeeps) {
    constexpr std::array<const char*, 10> load_only{ "sendRate", "throughput",
        "cleanupOverhead", "setupOverhead", "peakConcurrency", "droppedRequests",
        "avgQueueWaitMs", "bytesSent", "bytesReceived", "throughputBytesPerSec" };

    seed ({ .id = "run_sequential", .type = vayu::RunType::Scenario, .start_time = 1000 });
    db_->update_run_summary ("run_sequential", sequential_summary (2, { { 200, 2 } }));
    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_sequential");
    ASSERT_EQ (status, 200);
    for (const char* key : load_only) {
        EXPECT_FALSE (body["summary"].contains (key))
        << key << ": " << body["summary"].dump ();
    }
    EXPECT_DOUBLE_EQ (body["summary"]["avgRps"].get<double> (), 1.0);

    seed ({ .id = "run_scenario_load", .start_time = 1000 });
    auto load_summary = vayu::core::build_run_summary_payload (summary_inputs ());
    load_summary["scenario"] = { { "virtual_users", 4 }, { "steps_executed", 100 } };
    db_->update_run_summary ("run_scenario_load", load_summary.dump ());
    auto [load_status, load_body] =
    vayu::http::routes::run_report_response (*db_, "run_scenario_load");
    ASSERT_EQ (load_status, 200);
    for (const char* key : load_only) {
        EXPECT_TRUE (load_body["summary"].contains (key)) << key;
    }
    EXPECT_EQ (load_body["summary"]["bytesReceived"].get<size_t> (), 8192u);
}

// #2136: a healthy run stopped with requests in flight reports what the Stop
// cancelled on its own line, and errorRate 0 - the cancelled requests are in
// neither the total nor the failed count.
TEST_F (RunsRouteTest, ReportCountsStopCancelledRequestsApartFromErrors) {
    seed ({ .id = "run_stopped", .status = vayu::RunStatus::Stopped, .start_time = 1000 });
    auto inputs           = summary_inputs ();
    inputs.total_requests = 70000;
    inputs.status_codes   = { { 200, 70000 } };
    inputs.cancelled      = 10;
    db_->update_run_summary (
    "run_stopped", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_stopped");
    ASSERT_EQ (status, 200);

    const auto& summary = body["summary"];
    EXPECT_EQ (summary["cancelledRequests"].get<size_t> (), 10u);
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), 70000u);
    EXPECT_EQ (summary["successfulRequests"].get<size_t> (), 70000u);
    EXPECT_EQ (summary["failedRequests"].get<size_t> (), 0u);
    EXPECT_EQ (summary["noResponseRequests"].get<size_t> (), 0u);
    EXPECT_DOUBLE_EQ (summary["errorRate"].get<double> (), 0.0);
    EXPECT_EQ (body["errors"]["total"].get<size_t> (), 0u);
}

// A summary stored before the key existed still answers the field, as 0, so a
// reader never has to tell "absent" from "none".
TEST_F (RunsRouteTest, ReportReadsZeroCancelledFromAnOlderSummary) {
    seed ({ .id = "run_older", .start_time = 1000 });
    auto stored = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_TRUE (stored.contains ("cancelled"));
    stored.erase ("cancelled");
    db_->update_run_summary ("run_older", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_older");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body["summary"].contains ("cancelledRequests"));
    EXPECT_EQ (body["summary"]["cancelledRequests"].get<size_t> (), 0u);
}

// #3538: a run whose drain a Stop cut reports the cut beside its cancelled
// count, which the cut leaves where it was; a run cancelled by any other Stop
// carries no key. Mutation check: drop the `drainCut` write in
// `build_report_body` and the first expectation fails.
TEST_F (RunsRouteTest, ReportCarriesTheDrainCutOnlyWhenStored) {
    auto cut      = summary_inputs ();
    cut.cancelled = 15;
    cut.drain_cut = 15;
    seed ({ .id = "run_cut", .start_time = 1000 });
    db_->update_run_summary (
    "run_cut", vayu::core::build_run_summary_payload (cut).dump ());

    auto uncut      = summary_inputs ();
    uncut.cancelled = 15;
    seed ({ .id = "run_uncut", .status = vayu::RunStatus::Stopped, .start_time = 1001 });
    db_->update_run_summary (
    "run_uncut", vayu::core::build_run_summary_payload (uncut).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_cut");
    ASSERT_EQ (status, 200);
    const auto& summary = body["summary"];
    EXPECT_EQ (summary.value ("drainCut", nlohmann::json ()),
    (nlohmann::json{ { "cancelled", 15 } }))
    << summary.dump ();
    EXPECT_EQ (summary["cancelledRequests"].get<size_t> (), 15u);
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), cut.total_requests);

    auto [uncut_status, uncut_body] =
    vayu::http::routes::run_report_response (*db_, "run_uncut");
    ASSERT_EQ (uncut_status, 200);
    EXPECT_FALSE (uncut_body["summary"].contains ("drainCut"))
    << uncut_body["summary"].dump ();
}

// A 50 RPS run that sent all 100 of its requests in 2 s, then drained for half
// a second: completed over wall time is 40/s, the pacer's own count is 100%,
// and the 25 sent in the last half second answered after sending ended.
vayu::core::RunSummaryInputs drained_run_inputs () {
    auto inputs                    = summary_inputs ();
    inputs.total_requests          = 100;
    inputs.status_codes            = { { 200, 100 } };
    inputs.test_duration_s         = 2.5;
    inputs.rps                     = 40.0;
    inputs.throughput              = 40.0;
    inputs.requests_sent           = 100;
    inputs.requests_expected       = 100;
    inputs.sending_duration_s      = 2.0;
    inputs.completed_while_sending = 75;
    inputs.send_rate               = 50.0;
    return inputs;
}

constexpr const char* TARGET_50_RPS =
R"({"url":"https://x.test/","method":"GET","mode":"constant_rps","duration":"2s","targetRps":50})";

// #2392: rate fidelity is sent over expected, in a window the drain is not
// part of. Mutation check: drop the `apply_sending_window_rates` call in
// `reconcile_report_rates` and `achievement` reads 80, `actualRps` 40.
TEST_F (RunsRouteTest, ReportRateControlDividesByTheSendingWindow) {
    seed ({ .id = "run_window", .start_time = 1000, .config_snapshot = TARGET_50_RPS });
    db_->update_run_summary ("run_window",
    vayu::core::build_run_summary_payload (drained_run_inputs ()).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_window");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("rateControl")) << body.dump ();
    const auto& rate = body["rateControl"];
    EXPECT_DOUBLE_EQ (rate["achievement"].get<double> (), 100.0);
    EXPECT_DOUBLE_EQ (rate["actualRps"].get<double> (), 50.0);
    EXPECT_EQ (rate["requestsSent"].get<size_t> (), 100u);
    EXPECT_EQ (rate["requestsExpected"].get<size_t> (), 100u);
    EXPECT_DOUBLE_EQ (body["summary"]["sendingDurationSeconds"].get<double> (), 2.0);
    // The completed-over-wall-time figures keep the drain.
    EXPECT_DOUBLE_EQ (body["summary"]["avgRps"].get<double> (), 40.0);
    EXPECT_DOUBLE_EQ (body["summary"]["throughput"].get<double> (), 40.0);
    EXPECT_DOUBLE_EQ (body["summary"]["testDuration"].get<double> (), 2.5);
    // #2882: the completions inside the window sit beside it.
    ASSERT_TRUE (body["summary"].contains ("completedWhileSending")) << body.dump ();
    EXPECT_EQ (body["summary"]["completedWhileSending"].get<size_t> (), 75u);
}

// A run stored between #2392 and #2882 has its sending window and no count of
// what completed inside it: the report leaves the key out rather than claiming
// nothing did. Mutation check: read the key with `read_number` into a plain
// `size_t` in `apply_summary_totals` and the report writes 0.
TEST_F (RunsRouteTest, ReportFromASummaryWithoutCompletedWhileSendingOmitsIt) {
    seed ({ .id = "run_pre_completed", .start_time = 1000, .config_snapshot = TARGET_50_RPS });
    auto stored = vayu::core::build_run_summary_payload (drained_run_inputs ());
    ASSERT_TRUE (stored.contains ("completed_while_sending"));
    stored.erase ("completed_while_sending");
    db_->update_run_summary ("run_pre_completed", stored.dump ());

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_pre_completed");
    ASSERT_EQ (status, 200);
    EXPECT_DOUBLE_EQ (body["summary"]["sendingDurationSeconds"].get<double> (), 2.0);
    EXPECT_FALSE (body["summary"].contains ("completedWhileSending")) << body.dump ();
}

// `rps: 0` falls through to `targetRps`, as the run paced and as the list row
// records it (#2396). Mutation check: read `rps` whenever it is present in
// `reconcile_report_rates` and the report loses its `rateControl`.
TEST_F (RunsRouteTest, ReportReadsTheRateThroughAZeroRps) {
    seed ({ .id = "run_zero_rps",
    .start_time = 1000,
    .config_snapshot = R"({"url":"https://x.test/","method":"GET","mode":"constant_rps","duration":"2s","rps":0,"targetRps":50})" });
    db_->update_run_summary ("run_zero_rps",
    vayu::core::build_run_summary_payload (drained_run_inputs ()).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_zero_rps");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("rateControl")) << body.dump ();
    EXPECT_DOUBLE_EQ (body["rateControl"]["targetRps"].get<double> (), 50.0);
}

// A Stop 1.2 s in sent at the target rate but only 60 of the 100 planned: the
// achievement is the share of the plan, not the rate. Mutation check: compute
// it from `actual_rps / target_rps` in `apply_sending_window_rates` and it
// reads 100.
TEST_F (RunsRouteTest, ReportRateFidelityOfAStoppedRunIsTheShareOfItsPlan) {
    seed ({ .id      = "run_stopped_window",
    .status          = vayu::RunStatus::Stopped,
    .start_time      = 1000,
    .config_snapshot = TARGET_50_RPS });
    auto inputs               = drained_run_inputs ();
    inputs.requests_sent      = 60;
    inputs.sending_duration_s = 1.2;
    db_->update_run_summary ("run_stopped_window",
    vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_stopped_window");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("rateControl")) << body.dump ();
    EXPECT_DOUBLE_EQ (body["rateControl"]["achievement"].get<double> (), 60.0);
    EXPECT_DOUBLE_EQ (body["rateControl"]["actualRps"].get<double> (), 50.0);
}

// A run stored before #2392 has no sending window: it keeps the achievement it
// always reported and gains no key it cannot fill.
TEST_F (RunsRouteTest, ReportFromAnOlderSummaryKeepsTheOldRateFidelity) {
    seed ({ .id = "run_pre_window", .start_time = 1000, .config_snapshot = TARGET_50_RPS });
    auto stored = vayu::core::build_run_summary_payload (drained_run_inputs ());
    for (const char* key : { "requests_sent", "requests_expected",
         "sending_duration", "completed_while_sending" }) {
        ASSERT_TRUE (stored.contains (key)) << key;
        stored.erase (key);
    }
    db_->update_run_summary ("run_pre_window", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_pre_window");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("rateControl")) << body.dump ();
    const auto& rate = body["rateControl"];
    EXPECT_DOUBLE_EQ (rate["achievement"].get<double> (), 80.0);
    EXPECT_DOUBLE_EQ (rate["actualRps"].get<double> (), 40.0);
    EXPECT_FALSE (rate.contains ("requestsSent"));
    EXPECT_FALSE (rate.contains ("requestsExpected"));
    EXPECT_FALSE (body["summary"].contains ("sendingDurationSeconds"));
    EXPECT_FALSE (body["summary"].contains ("completedWhileSending"));
}

// A run stored before #2799 never looked for replays, so its report claims
// no count rather than a 0 nobody measured.
TEST_F (RunsRouteTest, ReportFromAnOlderSummaryOmitsConnectionReplays) {
    seed ({ .id = "run_pre_replays", .start_time = 1000 });
    auto stored = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_TRUE (stored.contains ("connection_replays"));
    stored.erase ("connection_replays");
    db_->update_run_summary ("run_pre_replays", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_pre_replays");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body["summary"].contains ("connectionReplays"))
    << body["summary"].dump ();
}

// A run stored before #2821 has no mean in flight; its report leaves the key
// out rather than reporting 0 in flight for a run that sent requests.
TEST_F (RunsRouteTest, ReportFromAnOlderSummaryOmitsAvgInFlight) {
    seed ({ .id = "run_pre_in_flight", .start_time = 1000 });
    auto stored = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_TRUE (stored.contains ("avg_in_flight"));
    stored.erase ("avg_in_flight");
    db_->update_run_summary ("run_pre_in_flight", stored.dump ());

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_pre_in_flight");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body["summary"].contains ("avgInFlight")) << body["summary"].dump ();
}

// #2911: a summary stored before the pacer skipped anything has neither key,
// and its report reads them as 0 rather than failing or inventing a stall.
// Mutation check: make `apply_summary_totals` require the keys and the report
// is not the 200 below.
TEST_F (RunsRouteTest, ReportFromASummaryWithoutSkipsReadsThemAsZero) {
    seed ({ .id = "run_pre_skips", .start_time = 1000 });
    auto stored = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_TRUE (stored.contains ("skipped_requests"));
    stored.erase ("skipped_requests");
    stored.erase ("stalled_ms");
    db_->update_run_summary ("run_pre_skips", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_pre_skips");
    ASSERT_EQ (status, 200);
    const auto& summary = body["summary"];
    EXPECT_EQ (summary.value ("skippedRequests", size_t{ 99 }), 0u) << summary.dump ();
    EXPECT_DOUBLE_EQ (summary.value ("stalledMs", -1.0), 0.0) << summary.dump ();
    EXPECT_EQ (summary["droppedRequests"].get<size_t> (), 2u);
}

// #2894: a run stored before the split timed cleanup under `setup_overhead`.
// Its report carries that figure as `cleanupOverhead` and no `setupOverhead`
// at all. Mutation check: read `setup_overhead` into the setup figure on the
// no-`cleanup_overhead` path in `apply_summary_overheads` and both fail.
TEST_F (RunsRouteTest, ReportFromAnOlderSummaryReportsItsOverheadAsCleanup) {
    seed ({ .id = "run_pre_cleanup", .start_time = 1000 });
    auto stored = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_TRUE (stored.contains ("cleanup_overhead"));
    stored.erase ("cleanup_overhead");
    stored["setup_overhead"] = 0.5;
    db_->update_run_summary ("run_pre_cleanup", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_pre_cleanup");
    ASSERT_EQ (status, 200);
    const auto& summary = body["summary"];
    EXPECT_DOUBLE_EQ (summary.value ("cleanupOverhead", -1.0), 0.5) << summary.dump ();
    EXPECT_FALSE (summary.contains ("setupOverhead")) << summary.dump ();
}

// #2894: the sequential collection runner stores neither overhead key. Its
// report keeps both as measured zeros, not as the older row's omitted setup.
// Mutation check: reset the setup optional when the summary has neither key in
// `apply_summary_overheads` and the `setupOverhead` assertion fails.
TEST_F (RunsRouteTest, ReportFromASummaryWithNeitherOverheadReportsBothAsZero) {
    seed ({ .id = "run_no_overheads", .start_time = 1000 });
    auto stored = vayu::core::build_run_summary_payload (summary_inputs ());
    stored.erase ("setup_overhead");
    stored.erase ("cleanup_overhead");
    db_->update_run_summary ("run_no_overheads", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_no_overheads");
    ASSERT_EQ (status, 200);
    const auto& summary = body["summary"];
    ASSERT_TRUE (summary.contains ("setupOverhead")) << summary.dump ();
    ASSERT_TRUE (summary.contains ("cleanupOverhead")) << summary.dump ();
    EXPECT_DOUBLE_EQ (summary["setupOverhead"].get<double> (), 0.0);
    EXPECT_DOUBLE_EQ (summary["cleanupOverhead"].get<double> (), 0.0);
}

// Every store a run keeps is bounded, so the report has to say how much each
// one thinned away - a Samples tab showing 1000 traces from a 3M-request run
// is honest only if the reader can also see that 29,000 candidates were
// displaced.
TEST_F (RunsRouteTest, ReportCarriesWhatTheBoundedStoresDropped) {
    seed ({ .id = "run_retention", .start_time = 1000 });
    db_->update_run_summary ("run_retention",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_retention");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("sampling"));
    EXPECT_EQ (body["sampling"]["errorsDropped"].get<size_t> (), 4u);
    EXPECT_EQ (body["sampling"]["successTracesDropped"].get<size_t> (), 300u);
    EXPECT_EQ (body["sampling"]["slowTracesDropped"].get<size_t> (), 12u);
    EXPECT_EQ (body["sampling"]["responseSamplesDropped"].get<size_t> (), 900u);
}

// Issue #1503: what a run did not do survives the summary -> report round
// trip, and a run with nothing to report carries no key at all rather than
// an empty array every run would otherwise show.
TEST_F (RunsRouteTest, ReportCarriesWarningsWhenTheRunHadAnyAndOmitsThemOtherwise) {
    auto warned = summary_inputs ();
    warned.warnings = nlohmann::json::array ({ { { "code", "unresolved_tokens" },
    { "message", "2 requests sent with unresolved variables: token" },
    { "count", 2 }, { "names", nlohmann::json::array ({ "token" }) } } });
    seed ({ .id = "run_warned", .start_time = 1000 });
    db_->update_run_summary (
    "run_warned", vayu::core::build_run_summary_payload (warned).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_warned");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("warnings"));
    ASSERT_EQ (body["warnings"].size (), 1u);
    EXPECT_EQ (body["warnings"][0]["code"], "unresolved_tokens");
    EXPECT_EQ (body["warnings"][0]["count"], 2);

    seed ({ .id = "run_clean", .start_time = 1000 });
    db_->update_run_summary ("run_clean",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());
    auto [clean_status, clean_body] =
    vayu::http::routes::run_report_response (*db_, "run_clean");
    ASSERT_EQ (clean_status, 200);
    EXPECT_FALSE (clean_body.contains ("warnings"));
}

// Issue #1192: `responseSamplesDropped` counts both bounds on the response
// sample store, and only one of them costs the tested set its uniformity. The
// marker is what lets the app say which run it is looking at, so it has to
// survive the summary -> report round trip in both states.
TEST_F (RunsRouteTest, ReportSaysWhetherTheResponseSampleBudgetWasSpent) {
    auto spent                                   = summary_inputs ();
    spent.retention.response_sample_budget_spent = true;
    seed ({ .id = "run_budget_spent", .start_time = 1000 });
    db_->update_run_summary (
    "run_budget_spent", vayu::core::build_run_summary_payload (spent).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_budget_spent");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body["sampling"].contains ("responseSampleBudgetSpent"));
    EXPECT_TRUE (body["sampling"]["responseSampleBudgetSpent"].get<bool> ());

    seed ({ .id = "run_count_capped", .start_time = 1000 });
    db_->update_run_summary ("run_count_capped",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());

    auto [ok, uniform] = vayu::http::routes::run_report_response (*db_, "run_count_capped");
    ASSERT_EQ (ok, 200);
    ASSERT_TRUE (uniform["sampling"].contains ("responseSampleBudgetSpent"))
    << "a run that did not spend the budget says so, rather than reading like "
       "a run nothing looked at";
    EXPECT_FALSE (uniform["sampling"]["responseSampleBudgetSpent"].get<bool> ());
}

// Server vitals survive the summary -> report round trip in the shape the
// scrape wrote them, so the section a reader sees is the one the run recorded.
TEST_F (RunsRouteTest, ReportCarriesTheMonitorSummary) {
    seed ({ .id = "run_monitor", .start_time = 1000 });
    auto inputs = summary_inputs ();
    vayu::core::MonitorTotals totals;
    totals.add ({ { "node_cpu", 1.0 } });
    totals.add ({ { "node_cpu", 3.0 } });
    totals.record_failure ("HTTP 503");
    totals.record_no_match ();
    inputs.monitor = totals.to_summary ();
    db_->update_run_summary (
    "run_monitor", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_monitor");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("monitor"));
    EXPECT_EQ (body["monitor"]["samples"].get<size_t> (), 2u);
    EXPECT_EQ (body["monitor"]["failures"].get<size_t> (), 1u);
    EXPECT_EQ (body["monitor"]["noMatchScrapes"].get<size_t> (), 1u);
    EXPECT_EQ (body["monitor"]["lastError"], "HTTP 503");
    EXPECT_DOUBLE_EQ (body["monitor"]["series"]["node_cpu"]["avg"].get<double> (), 2.0);
}

// The aggregate verdict a per-response script cannot give, round-tripped
// through the stored summary. The property under test is not just that the
// section survives: the error rate the verdict judged has to be the same number
// the report prints beside it, or the two halves of the report contradict.
TEST_F (RunsRouteTest, ReportCarriesTheThresholdVerdict) {
    seed ({ .id = "run_budgets", .start_time = 1000 });
    auto inputs = summary_inputs ();
    // p99 is 30 ms against a 50 ms budget (passes); the fixture's 10 failures
    // in 100 requests are 10% against a 1% budget (fails).
    const nlohmann::json config{ { "thresholds",
    { { "latencyP99Ms", 50 }, { "maxErrorRatePct", 1 } } } };
    inputs.thresholds = vayu::core::evaluate_thresholds (config, inputs);
    db_->update_run_summary (
    "run_budgets", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_budgets");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("thresholdValidation"));
    const auto& verdict = body["thresholdValidation"];
    EXPECT_EQ (verdict["verdict"].get<std::string> (), "failed");
    EXPECT_EQ (verdict["passed"].get<size_t> (), 1u);
    EXPECT_EQ (verdict["failed"].get<size_t> (), 1u);

    ASSERT_TRUE (verdict["checks"].is_array ());
    ASSERT_EQ (verdict["checks"].size (), 2u);
    EXPECT_EQ (verdict["checks"][0]["metric"].get<std::string> (), "latencyP99Ms");
    EXPECT_DOUBLE_EQ (verdict["checks"][0]["limit"].get<double> (), 50.0);
    EXPECT_DOUBLE_EQ (verdict["checks"][0]["actual"].get<double> (), 30.0);
    EXPECT_TRUE (verdict["checks"][0]["passed"].get<bool> ());
    EXPECT_TRUE (verdict["checks"][0]["evaluated"].get<bool> ());
    EXPECT_EQ (verdict["checks"][1]["metric"].get<std::string> (), "maxErrorRatePct");
    EXPECT_FALSE (verdict["checks"][1]["passed"].get<bool> ());

    // The one assertion that pins the two sides together.
    EXPECT_DOUBLE_EQ (verdict["checks"][1]["actual"].get<double> (),
    body["summary"]["errorRate"].get<double> ());
}

// #2892: the assertion check's two populations survive the stored summary,
// so a report read after a restart still names both. Mutation check: drop the
// `append_assertion_populations` call in `build_threshold_outcome_payload`
// and the population keys red.
TEST_F (RunsRouteTest, ReportCarriesTheAssertionPopulations) {
    seed ({ .id = "run_assert_pops", .start_time = 1000 });
    auto inputs       = summary_inputs ();
    inputs.assertions = vayu::core::AssertionPopulations{
        .exact       = { .passed = 200, .failed = 0 },
        .sampled     = { .passed = 1, .failed = 1 },
        .sample_rate = 100,
    };
    inputs.thresholds = vayu::core::evaluate_thresholds (
    nlohmann::json{ { "thresholds", { { "maxAssertionFailureRatePct", 10 } } } }, inputs);
    db_->update_run_summary (
    "run_assert_pops", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_assert_pops");
    ASSERT_EQ (status, 200);
    const auto& check = body["thresholdValidation"]["checks"][0];
    EXPECT_DOUBLE_EQ (check["actual"].get<double> (), 50.0);
    EXPECT_FALSE (check["passed"].get<bool> ());
    EXPECT_EQ (check.value ("assertionsExact", nlohmann::json ()),
    (nlohmann::json{ { "passed", 200 }, { "failed", 0 } }));
    EXPECT_EQ (check.value ("assertionsSampled", nlohmann::json ()),
    (nlohmann::json{ { "passed", 1 }, { "failed", 1 } }));
    EXPECT_EQ (check.value ("sampleRate", 0), 100);
}

// #2436: `summary` is written only at terminal status, so a report read while
// the run is still going has no verdict, and `metadata.status` is what tells a
// reader it is partial. A load run's rows are read only once it is terminal
// (#2659).
TEST_F (RunsRouteTest, ReportOfARunStillRunningIsPartialUntilItCompletes) {
    seed ({ .id = "run_live", .status = vayu::RunStatus::Running, .start_time = 1000 });
    seed_result ("run_live", 200, 12.0);

    auto [live_status, live] = vayu::http::routes::run_report_response (*db_, "run_live");
    ASSERT_EQ (live_status, 200);
    EXPECT_EQ (live["metadata"]["status"].get<std::string> (), "running");
    EXPECT_EQ (live["resultsStored"].get<size_t> (), 0u);
    EXPECT_FALSE (live.contains ("thresholdValidation"));

    auto inputs       = summary_inputs ();
    inputs.thresholds = vayu::core::evaluate_thresholds (
    nlohmann::json{ { "thresholds", { { "latencyP99Ms", 50 } } } }, inputs);
    db_->update_run_summary (
    "run_live", vayu::core::build_run_summary_payload (inputs).dump ());
    db_->transition_run_status (
    "run_live", { vayu::RunStatus::Running }, vayu::RunStatus::Completed);

    auto [done_status, done] = vayu::http::routes::run_report_response (*db_, "run_live");
    ASSERT_EQ (done_status, 200);
    EXPECT_EQ (done["metadata"]["status"].get<std::string> (), "completed");
    EXPECT_EQ (done["resultsStored"].get<size_t> (), 1u);
    ASSERT_TRUE (done.contains ("thresholdValidation"));
    EXPECT_EQ (done["thresholdValidation"]["verdict"].get<std::string> (), "passed");
}

// #2659: a load run that is not terminal is reported from its collector, the
// counts the live stream reads, and never from `results`, which is renamed away
// here so a report that read a row would throw. Mutation check: read the rows
// for a live load run again and this test fails on the throw.
TEST_F (RunsRouteTest, ALiveLoadRunsReportCountsFromItsCollectorAndReadsNoRow) {
    seed ({ .id = "run_live", .status = vayu::RunStatus::Running, .start_time = 1000 });
    seed_result ("run_live", 200, 12.0);

    vayu::core::RunManager runs;
    auto context =
    std::make_shared<vayu::core::RunContext> ("run_live", nlohmann::json::object ());
    auto& collector = *context->metrics_collector;
    collector.record_success (200, 10.0, 1.0);
    collector.record_success (200, 12.0, 3.0);
    collector.record_success (503, 30.0, 2.0);
    collector.record_error (vayu::ErrorCode::ConnectionFailed, "refused");
    collector.record_cancelled ();
    collector.record_bytes (100, 400);
    collector.record_mcp_failure (vayu::McpErrorClass::Transport, std::nullopt);
    // Two requests open since a second before the read (#3567).
    (void)collector.open_request (vayu::tests::steady_now_ms () - 1000);
    (void)collector.open_request (vayu::tests::steady_now_ms () - 1000);
    context->peak_in_flight = 3;
    runs.register_run ("run_live", context);

    make_results_unreadable ();
    EXPECT_ANY_THROW (db_->get_results ("run_live"));

    auto [status, live] =
    vayu::http::routes::run_report_response (*db_, "run_live", &runs);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (live["metadata"]["status"].get<std::string> (), "running");
    const auto& summary = live["summary"];
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), 4u);
    EXPECT_EQ (summary["successfulRequests"].get<size_t> (), 2u);
    EXPECT_EQ (summary["failedRequests"].get<size_t> (), 2u);
    EXPECT_EQ (summary["httpErrorRequests"].get<size_t> (), 1u);
    EXPECT_EQ (summary["noResponseRequests"].get<size_t> (), 1u);
    EXPECT_EQ (summary["cancelledRequests"].get<size_t> (), 1u);
    EXPECT_DOUBLE_EQ (summary["errorRate"].get<double> (), 50.0);
    EXPECT_EQ (summary["bytesSent"].get<size_t> (), 100u);
    EXPECT_EQ (summary["bytesReceived"].get<size_t> (), 400u);
    EXPECT_EQ (summary["peakConcurrency"].get<size_t> (), 3u);
    EXPECT_GT (summary["avgRps"].get<double> (), 0.0);
    // The collector's in-flight integral over the same duration (#2821,
    // #3567): the two open requests, which nothing has completed.
    ASSERT_TRUE (summary.contains ("avgInFlight")) << summary.dump ();
    EXPECT_GT (summary["avgInFlight"].get<double> (), 0.0);
    // The run so far's failed `mcp` replies (#3828). Mutation check: drop the
    // `error_classes` read in `apply_live_counters` and the key is absent.
    EXPECT_EQ (summary.value ("errorClasses", nlohmann::json ()),
    (nlohmann::json{ { "transport", 1 } }))
    << summary.dump ();
    EXPECT_EQ (live["statusCodes"], nlohmann::json::parse ("[[0,1],[200,2],[503,1]]"));
    EXPECT_EQ (live["errors"]["byStatusCode"], nlohmann::json::parse ("[[0,1],[503,1]]"));
    // The percentiles are read from histograms the run is still writing.
    EXPECT_FALSE (live.contains ("latency"));
    EXPECT_TRUE (live["results"].empty ());
    EXPECT_EQ (live["resultsStored"].get<size_t> (), 0u);
    EXPECT_EQ (live["resultsCap"].get<size_t> (), 100u);
    // ~RunManager waits out its stop grace for a run still active.
    runs.unregister_run ("run_live");
}

// #3340: a live load run's rates are over the time it has been running. The
// row is built the way production builds it: `seed_run_times` sets end_time
// to start_time at the insert and the worker's move to Running clears it, so
// the report measures up to now. When that move stamped end_time instead, the
// report measured up to the moment the run started, a gap of a millisecond or
// none, and 8 requests read as thousands a second or as 0. Mutation check:
// have `end_time_after` (db_runs.cpp) stamp now for Running and the duration
// and rate assertions fail.
TEST_F (RunsRouteTest, ALiveLoadRunsRatesAreOverTheTimeItHasBeenRunning) {
    const auto epoch_ms = [] () {
        return std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
        .count ();
    };
    vayu::db::Run row;
    row.id                   = "run_rates";
    row.type                 = vayu::RunType::Load;
    row.status               = vayu::RunStatus::Pending;
    row.config_snapshot      = R"({"url":"https://x.test/","method":"GET"})";
    const int64_t created_at = epoch_ms ();
    vayu::http::routes::seed_run_times (row, created_at);
    db_->create_run (row);
    ASSERT_TRUE (db_
    ->transition_run_status ("run_rates", { vayu::RunStatus::Pending }, vayu::RunStatus::Running)
    .applied);

    constexpr size_t REQUESTS = 8;
    vayu::core::RunManager runs;
    auto context = std::make_shared<vayu::core::RunContext> (
    "run_rates", nlohmann::json::object ());
    for (size_t i = 0; i < REQUESTS; ++i) {
        context->metrics_collector->record_success (200, 10.0, 0.0);
    }
    context->requests_sent = REQUESTS;
    runs.register_run ("run_rates", context);

    // A floor under the run's age, never a ceiling: a slow runner only ages
    // it more, and the broken reading stays near 0 however long this takes.
    constexpr int64_t AGE_MS = 500;
    ASSERT_TRUE (vayu::tests::wait_until (
    [&] () { return epoch_ms () - created_at >= AGE_MS; }));

    auto [status, live] =
    vayu::http::routes::run_report_response (*db_, "run_rates", &runs);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (live["metadata"]["status"].get<std::string> (), "running");
    const auto& summary   = live["summary"];
    const double duration = summary["totalDurationSeconds"].get<double> ();
    EXPECT_GE (duration, static_cast<double> (AGE_MS) / 1000.0)
    << "the live report measured up to a stored end, not to now";
    EXPECT_DOUBLE_EQ (summary["testDuration"].get<double> (), duration);
    EXPECT_DOUBLE_EQ (
    summary["avgRps"].get<double> (), static_cast<double> (REQUESTS) / duration);
    EXPECT_DOUBLE_EQ (summary["sendRate"].get<double> (),
    static_cast<double> (REQUESTS) / duration);
    runs.unregister_run ("run_rates");
}

// Between the summary write and the status flip the report is the summary's,
// latency included, as a finished run's is - and still reads no row.
TEST_F (RunsRouteTest, ALiveLoadRunsStoredSummaryIsReportedWithoutARowRead) {
    seed ({ .id = "run_settling", .status = vayu::RunStatus::Running, .start_time = 1000 });
    seed_result ("run_settling", 200, 12.0);

    vayu::core::RunManager runs;
    auto context = std::make_shared<vayu::core::RunContext> (
    "run_settling", nlohmann::json::object ());
    context->metrics_collector->record_success (200, 10.0, 0.0);
    runs.register_run ("run_settling", context);
    db_->update_run_summary ("run_settling",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());
    make_results_unreadable ();

    auto [status, report] =
    vayu::http::routes::run_report_response (*db_, "run_settling", &runs);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (report["metadata"]["status"].get<std::string> (), "running");
    EXPECT_EQ (report["summary"]["totalRequests"].get<size_t> (), 100u);
    ASSERT_TRUE (report.contains ("latency"));
    EXPECT_DOUBLE_EQ (report["latency"]["p99"].get<double> (), 30.0);
    EXPECT_EQ (report["resultsStored"].get<size_t> (), 0u);
    runs.unregister_run ("run_settling");
}

// A load run the engine holds no context for - none registered yet, or no
// manager to ask - is answered with zeros, never with its rows.
TEST_F (RunsRouteTest, ALiveLoadRunWithNoContextIsReportedAsZerosWithoutARowRead) {
    seed ({ .id = "run_pending", .status = vayu::RunStatus::Pending, .start_time = 1000 });
    seed_result ("run_pending", 503, 12.0);
    make_results_unreadable ();

    vayu::core::RunManager runs;
    for (auto* manager : { &runs, static_cast<vayu::core::RunManager*> (nullptr) }) {
        auto [status, report] =
        vayu::http::routes::run_report_response (*db_, "run_pending", manager);
        ASSERT_EQ (status, 200);
        EXPECT_EQ (report["metadata"]["status"].get<std::string> (), "pending");
        EXPECT_EQ (report["summary"]["totalRequests"].get<size_t> (), 0u);
        EXPECT_TRUE (report["statusCodes"].empty ());
        EXPECT_FALSE (report.contains ("latency"));
        EXPECT_EQ (report["resultsStored"].get<size_t> (), 0u);
    }
}

// #3568: an active run's row carries its worker's phase, read from the context
// at the request. The phase is never stored, so the same row once the run is
// retained, or asked with no manager, has no `phase` key at all. Mutation
// check: drop the `phase` write in `get_run_response` and the live assertion
// fails.
TEST_F (RunsRouteTest, GetRunCarriesTheLivePhaseOnlyWhileTheRunIsActive) {
    seed ({ .id = "run_phased", .status = vayu::RunStatus::Running, .start_time = 1000 });

    vayu::core::RunManager runs;
    auto context = std::make_shared<vayu::core::RunContext> (
    "run_phased", nlohmann::json::object ());
    context->advance_phase (vayu::core::RunPhase::draining);
    runs.register_run ("run_phased", context);

    const auto [live_status, live] =
    vayu::http::routes::get_run_response (*db_, "run_phased", &runs);
    ASSERT_EQ (live_status, 200);
    EXPECT_EQ (live.value ("phase", ""), "draining") << live.dump ();

    const auto [bare_status, bare] =
    vayu::http::routes::get_run_response (*db_, "run_phased", nullptr);
    ASSERT_EQ (bare_status, 200);
    EXPECT_FALSE (bare.contains ("phase")) << bare.dump ();

    runs.retain_run ("run_phased");
    const auto [stored_status, stored] =
    vayu::http::routes::get_run_response (*db_, "run_phased", &runs);
    ASSERT_EQ (stored_status, 200);
    EXPECT_FALSE (stored.contains ("phase"))
    << "a run no longer active answered a phase: " << stored.dump ();
}

// #2679: the live poll is answered while another thread holds the DB mutex, as
// a results chunk does during the run's final flush, because the run row is
// read off the mutex and nothing else is read. Mutation check: read the row
// with `get_run` again and the report never finishes while the mutex is held.
TEST_F (RunsRouteTest, ALiveLoadRunsReportDoesNotWaitOnTheDbMutex) {
    seed ({ .id = "run_flushing", .status = vayu::RunStatus::Running, .start_time = 1000 });

    std::promise<void> holding;
    std::promise<void> release;
    std::thread holder ([this, &holding, released = release.get_future ()] {
        db_->with_lock ([&] {
            holding.set_value ();
            released.wait ();
        });
    });
    holding.get_future ().wait ();

    auto report = std::async (std::launch::async, [this] {
        return vayu::http::routes::run_report_response (*db_, "run_flushing");
    });

    const bool answered = vayu::tests::wait_until ([&] {
        return report.wait_for (std::chrono::seconds (0)) == std::future_status::ready;
    });
    release.set_value ();
    holder.join ();

    ASSERT_TRUE (answered) << "the live report waited on the held DB mutex";
    const auto [status, body] = report.get ();
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["metadata"]["status"].get<std::string> (), "running");
}

// A terminal load run is reported from its rows and summary whatever its
// context still holds: retention keeps a finished run's collector for a while,
// and the report must not change while it does.
TEST_F (RunsRouteTest, AFinishedLoadRunsReportIgnoresItsRetainedCollector) {
    seed ({ .id = "run_done", .start_time = 1000 });
    seed_traced_result ("run_done", 200, 10.0,
    R"({"dnsMs":1,"connectMs":2,"tlsMs":3,"firstByteMs":4,"downloadMs":5,"isSlow":true,"thresholdMs":8})");
    seed_traced_result ("run_done", 0, 0.0, R"({"error_type":"timeout"})");

    vayu::core::RunManager runs;
    auto context =
    std::make_shared<vayu::core::RunContext> ("run_done", nlohmann::json::object ());
    for (int i = 0; i < 5; ++i) {
        context->metrics_collector->record_success (201, 99.0, 0.0);
    }
    runs.register_run ("run_done", context);
    runs.retain_run ("run_done");

    auto [plain_status, plain] = vayu::http::routes::run_report_response (*db_, "run_done");
    auto [held_status, held] =
    vayu::http::routes::run_report_response (*db_, "run_done", &runs);
    ASSERT_EQ (plain_status, 200);
    ASSERT_EQ (held_status, 200);
    EXPECT_EQ (held, plain);
    EXPECT_EQ (held["resultsStored"].get<size_t> (), 2u);
    EXPECT_EQ (held["errors"]["types"]["timeout"].get<size_t> (), 1u);
    EXPECT_DOUBLE_EQ (held["timingBreakdown"]["avgDnsMs"].get<double> (), 1.0);
    for (const auto& row : held["results"]) {
        EXPECT_TRUE (row.contains ("trace")) << row.dump ();
    }
}

} // namespace
