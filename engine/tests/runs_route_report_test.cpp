/**
 * @file tests/runs_route_report_test.cpp
 * @brief GET /runs/:id/report and /runs/:runId/results/:resultId: the report `configuration` and
 * `metadata`, the result cap, a run the engine died under, one stored result and the custom
 * metrics and threshold verdict.
 *
 * Covers the route's extracted core in isolation, matching the suite's other route tests (no
 * in-process HTTP server). The `RunsRouteTest` fixture is in `runs_route_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include "runs_route_fixture.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/threshold_eval.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"

using nlohmann::json;

namespace {

using vayu::tests::DATA_FILE_HASH;
using vayu::tests::summary_inputs;

// A scenario run's report `results` are the steps ScenarioRunView renders
// one row per - not a sample. Past 100 steps used to be silently dropped,
// which read as a run that executed fewer steps than it actually did.
// `maxScenarioStoredSteps` (5,000 by default) is the real bound, already
// applied at write time; the report must not impose a second, smaller one.
TEST_F (RunsRouteTest, ScenarioReportKeepsEveryStoredStepPastTheSampleCap) {
    seed ({ .id = "run_scenario_big", .type = vayu::RunType::Scenario });
    for (int i = 0; i < 150; i++) {
        seed_result ("run_scenario_big", 200, 1.0);
    }

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_scenario_big");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["results"].size (), 150u);
    EXPECT_EQ (body["resultsStored"], 150u);
    EXPECT_EQ (body["resultsCap"], 150u);
}

// What a collection run's errors cost and whether it stopped on them (issue
// #2526), and the steps a Stop cut short (#3397), reach the report's
// `scenario` section, and a summary that recorded none of them - a scenario
// load run's, or one written before the issues - grows none rather than a `0`
// and a `false` nobody measured.
// Mutation check: drop the `stepsNotRun` or the `stopped` write in
// `build_scenario_report_section` and the first half fails.
TEST_F (RunsRouteTest, ScenarioReportCarriesStepsNotRunAndStopOnErrorOnlyWhenStored) {
    seed ({ .id = "run_design_seq", .type = vayu::RunType::Scenario });
    db_->update_run_summary ("run_design_seq",
    nlohmann::json{ { "scenario",
                    { { "iterations", 2 }, { "steps_executed", 4 }, { "errored", 2 },
                    { "stopped", 1 }, { "steps_not_run", 3 }, { "stop_on_error", true } } } }
    .dump ());
    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_design_seq");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("scenario")) << body.dump ();
    EXPECT_EQ (body["scenario"]["stepsNotRun"], 3);
    EXPECT_EQ (body["scenario"]["stopOnError"], true);
    EXPECT_EQ (body["scenario"]["stopped"], 1);

    seed ({ .id = "run_older_seq", .type = vayu::RunType::Scenario });
    db_->update_run_summary ("run_older_seq",
    nlohmann::json{ { "scenario", { { "iterations", 1 }, { "steps_executed", 2 } } } }
    .dump ());
    auto [older_status, older] =
    vayu::http::routes::run_report_response (*db_, "run_older_seq");
    ASSERT_EQ (older_status, 200);
    ASSERT_TRUE (older.contains ("scenario")) << older.dump ();
    EXPECT_FALSE (older["scenario"].contains ("stepsNotRun"));
    EXPECT_FALSE (older["scenario"].contains ("stopOnError"));
    EXPECT_FALSE (older["scenario"].contains ("stopped"));
}

// A scenario load run's exact assertion population (#2820) reaches the report's
// `scenario` section; a summary without it (an older run, a sequential run, a
// run that asserted nothing) grows none rather than "0 failed".
// Mutation check: drop the `assertions` write in `build_scenario_report_section`
// and the first half fails.
TEST_F (RunsRouteTest, ScenarioReportCarriesTheStoredExactAssertions) {
    seed ({ .id = "run_asserted" });
    db_->update_run_summary ("run_asserted",
    nlohmann::json{ { "scenario",
                    { { "iterations", 4 }, { "steps_executed", 8 }, { "passed", 8 },
                    { "assertions", { { "passed", 0 }, { "failed", 4 } } } } } }
    .dump ());
    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_asserted");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("scenario")) << body.dump ();
    EXPECT_EQ (body["scenario"].value ("assertions", nlohmann::json ()),
    (nlohmann::json{ { "passed", 0 }, { "failed", 4 } }));
    EXPECT_EQ (body["scenario"]["passed"], 8)
    << "the HTTP count is not redefined";

    seed ({ .id = "run_unasserted", .start_time = 1 });
    db_->update_run_summary ("run_unasserted",
    nlohmann::json{ { "scenario", { { "iterations", 4 }, { "steps_executed", 8 } } } }
    .dump ());
    auto [plain_status, plain] =
    vayu::http::routes::run_report_response (*db_, "run_unasserted");
    ASSERT_EQ (plain_status, 200);
    ASSERT_TRUE (plain.contains ("scenario")) << plain.dump ();
    EXPECT_FALSE (plain["scenario"].contains ("assertions"));
}

// The sample cap stays for everything else - a design run has one row and a
// load run's percentiles do not need per-request rows past a representative
// few, so the report payload does not grow with an unbounded run's result
// count.
TEST_F (RunsRouteTest, LoadReportStillSamplesPastTheCap) {
    seed ({ .id = "run_load_big", .type = vayu::RunType::Load });
    for (int i = 0; i < 150; i++) {
        seed_result ("run_load_big", 200, 1.0);
    }

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_load_big");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["results"].size (), 100u);
    EXPECT_EQ (body["resultsStored"], 150u);
    EXPECT_EQ (body["resultsCap"], 100u);
}

/// Statuses of a report's `results`, in the order the report lists them.
std::vector<int> result_statuses (const nlohmann::json& body) {
    std::vector<int> statuses;
    for (const auto& row : body["results"]) {
        statuses.push_back (row["statusCode"].get<int> ());
    }
    return statuses;
}

// Past the cap the report keeps the failures, not the run's opening: three
// 500s stored last (the position the old first-100 cut dropped) are all in the
// 100 returned, and the rows come back in timestamp order whatever order the
// selection took them in (#2210).
TEST_F (RunsRouteTest, ReportCapKeepsFailuresStoredPastIt) {
    seed ({ .id = "run_tail_failures", .type = vayu::RunType::Load });
    for (int i = 0; i < 150; i++) {
        const bool failing = i >= 147;
        seed_result ("run_tail_failures", failing ? 500 : 200, 1.0, 1000 + i);
    }

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_tail_failures");
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["results"].size (), 100u);
    EXPECT_EQ (body["resultsStored"], 150u);
    EXPECT_EQ (body["resultsCap"], 100u);

    const auto statuses = result_statuses (body);
    EXPECT_EQ (std::count (statuses.begin (), statuses.end (), 500), 3);
    EXPECT_EQ (std::count (statuses.begin (), statuses.end (), 200), 97);

    int64_t previous = 0;
    for (const auto& row : body["results"]) {
        EXPECT_LE (previous, row["timestamp"].get<int64_t> ());
        previous = row["timestamp"].get<int64_t> ();
    }
    // The healthy rows that fill the rest are the earliest stored, so the three
    // failures close the list.
    EXPECT_EQ (statuses.back (), 500);
    EXPECT_EQ (body["results"][0]["timestamp"], 1000);
}

// A transport failure is recorded under status 0 and is a failure like any
// 4xx/5xx: it outranks healthy rows, and failures beyond the cap fill all of it.
TEST_F (RunsRouteTest, ReportCapKeepsTransportErrorsAndFillsWithFailures) {
    seed ({ .id = "run_tail_transport", .type = vayu::RunType::Load });
    for (int i = 0; i < 130; i++) {
        seed_result ("run_tail_transport", 200, 1.0, 1000 + i);
    }
    for (int i = 0; i < 5; i++) {
        seed_result ("run_tail_transport", 0, 0.0, 2000 + i);
    }

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_tail_transport");
    ASSERT_EQ (status, 200);
    auto statuses = result_statuses (body);
    ASSERT_EQ (statuses.size (), 100u);
    EXPECT_EQ (std::count (statuses.begin (), statuses.end (), 0), 5);

    seed ({ .id = "run_all_failing", .type = vayu::RunType::Load });
    for (int i = 0; i < 120; i++) {
        seed_result ("run_all_failing", i % 2 == 0 ? 0 : 503, 1.0, 1000 + i);
    }
    auto [failing_status, failing_body] =
    vayu::http::routes::run_report_response (*db_, "run_all_failing");
    ASSERT_EQ (failing_status, 200);
    statuses = result_statuses (failing_body);
    ASSERT_EQ (statuses.size (), 100u);
    EXPECT_EQ (std::count_if (statuses.begin (), statuses.end (),
               [] (int code) { return vayu::is_success_status (code); }),
    0);
    EXPECT_EQ (failing_body["resultsStored"], 120u);
}

// At or under the cap nothing is selected away: every row comes back.
TEST_F (RunsRouteTest, ReportUnderCapReturnsEveryRow) {
    seed ({ .id = "run_small", .type = vayu::RunType::Load });
    for (int i = 0; i < 100; i++) {
        seed_result ("run_small", i == 99 ? 500 : 200, 1.0, 1000 + i);
    }

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_small");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["results"].size (), 100u);
    EXPECT_EQ (body["resultsStored"], 100u);
    EXPECT_EQ (body["resultsCap"], 100u);
}

// GET /runs/:id/report's `configuration` object: same nine-key extension as
// the list-row summary (mode/duration/concurrency/startConcurrency/
// rampUpDuration/timeout/comment + httpVersion/followRedirects/maxRedirects),
// covered directly against build_run_report_config rather than through the
// full report handler, which needs a completed run's DB rows and metrics.
TEST (RunReportConfigTest, IncludesHttpVersionFollowRedirectsMaxRedirects) {
    auto config = json::parse (R"({"mode":"constant_rps","duration":"60s",
    "concurrency":50,"httpVersion":"http1.1","followRedirects":true,"maxRedirects":10})");

    auto config_obj = vayu::http::routes::build_run_report_config (config);

    EXPECT_EQ (config_obj.size (), 6u);
    EXPECT_EQ (config_obj["mode"], "constant_rps");
    EXPECT_EQ (config_obj["httpVersion"], "http1.1");
    EXPECT_EQ (config_obj["followRedirects"], true);
    EXPECT_EQ (config_obj["maxRedirects"], 10);
}

// Same "auto" default as the list-row summary - and for the same reason: the
// raw config_snapshot can hold an explicit httpVersion:null, and a run
// predating this field has no key at all. Both mean "ran at the default".
TEST (RunReportConfigTest, HttpVersionDefaultsToAutoOnNullOrAbsent) {
    auto with_null = json::parse (R"({"mode":"once","httpVersion":null})");
    auto without   = json::parse (R"({"mode":"once"})");

    EXPECT_EQ (
    vayu::http::routes::build_run_report_config (with_null)["httpVersion"], "auto");
    EXPECT_EQ (
    vayu::http::routes::build_run_report_config (without)["httpVersion"], "auto");
}

TEST (RunReportConfigTest, OmitsFollowRedirectsAndMaxRedirectsWhenAbsent) {
    auto config     = json::parse (R"({"mode":"once"})");
    auto config_obj = vayu::http::routes::build_run_report_config (config);

    EXPECT_FALSE (config_obj.contains ("followRedirects"));
    EXPECT_FALSE (config_obj.contains ("maxRedirects"));
    EXPECT_EQ (config_obj.size (), 2u); // mode + httpVersion("auto")
}

// Same field as SummaryCarriesAcceptEncodingWhenSnapshotHasIt, read for
// GET /runs/:runId/report's `configuration` object rather than the list row
// (issue #1488).
TEST (RunReportConfigTest, CarriesAcceptEncodingWhenSnapshotHasItAndOmitsItOtherwise) {
    auto negotiated = json::parse (
    R"({"mode":"once","defaultHeaders":{"userAgent":"Vayu/0.26.0","requestId":false,"acceptEncoding":true}})");
    auto pre_1488 = json::parse (R"({"mode":"once"})");

    EXPECT_EQ (
    vayu::http::routes::build_run_report_config (negotiated)["acceptEncoding"], true);
    EXPECT_FALSE (vayu::http::routes::build_run_report_config (pre_1488).contains (
    "acceptEncoding"));
}

// The report's comparison reads `expectContinue` (issue #2516); a snapshot
// without it stays without it, so the compare readers' absent-is-false rule is
// the only place that defaults it.
TEST (RunReportConfigTest, CarriesExpectContinueWhenSnapshotHasItAndOmitsItOtherwise) {
    const auto snapshot = [] (const char* flag) {
        // Appends, not an operator+ chain: gcc 13 -O3 reports the chain's
        // inlined memcpy as -Warray-bounds.
        std::string text = R"({"mode":"once","defaultHeaders":{"expectContinue":)";
        text += flag;
        text += "}}";
        return json::parse (text);
    };

    EXPECT_EQ (vayu::http::routes::build_run_report_config (snapshot ("true"))["expectContinue"],
    true);
    EXPECT_EQ (vayu::http::routes::build_run_report_config (snapshot ("false"))["expectContinue"],
    false);
    EXPECT_FALSE (vayu::http::routes::build_run_report_config (json::parse (R"({"mode":"once"})"))
    .contains ("expectContinue"));
    EXPECT_FALSE (vayu::http::routes::build_run_report_config (
    json::parse (R"({"defaultHeaders":{"expectContinue":"yes"}})"))
    .contains ("expectContinue"));
}

// A single-request run's data file, beside the row count it describes (issue
// #2051), and how it was read (issue #2540). Mutation check: drop
// `dataFileName` or `dataFileCastNumbers` from `build_run_report_config`'s key
// list and this reds.
TEST (RunReportConfigTest, CarriesTheDataFileBesideTheRowCount) {
    auto config = json::parse (R"({"mode":"once","dataRowCount":2,"dataFileName":"users.csv",
    "dataFileHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","dataFileCastNumbers":true})");

    const auto config_obj = vayu::http::routes::build_run_report_config (config);
    EXPECT_EQ (config_obj.value ("dataRowCount", 0), 2);
    EXPECT_EQ (config_obj.value ("dataFileName", ""), "users.csv");
    EXPECT_EQ (config_obj.value ("dataFileHash", ""), DATA_FILE_HASH);
    EXPECT_EQ (config_obj.value ("dataFileCastNumbers", false), true);

    const auto unnamed = vayu::http::routes::build_run_report_config (
    json::parse (R"({"mode":"once","dataRowCount":2})"));
    EXPECT_FALSE (unnamed.contains ("dataFileName"));
    EXPECT_FALSE (unnamed.contains ("dataFileHash"));
    EXPECT_FALSE (unnamed.contains ("dataFileCastNumbers"));
}

// An iterations run's count, beside the other tuning knobs (issue #2437).
// Mutation check: drop `iterations` from `build_run_report_config`'s key list
// and this reds.
TEST (RunReportConfigTest, CarriesIterationsOnlyWhenTheSnapshotHasThem) {
    const auto config_obj = vayu::http::routes::build_run_report_config (
    json::parse (R"({"mode":"iterations","iterations":250,"concurrency":10})"));
    EXPECT_EQ (config_obj.value ("iterations", 0), 250);
    EXPECT_EQ (config_obj.value ("concurrency", 0), 10);

    const auto without = vayu::http::routes::build_run_report_config (
    json::parse (R"({"mode":"constant_concurrency"})"));
    EXPECT_FALSE (without.contains ("iterations"));
}

// A capacity run's own two knobs (issue #2925), echoed as the run was started
// with them and only for that mode: a load run's snapshot never gets them.
// Mutation check: drop `stepDuration` or `sloMs` from `add_capacity_config`
// and the first half reds; drop its mode gate and the second half does.
TEST (RunReportConfigTest, CarriesACapacityRunsStepDurationAndSloOnly) {
    const auto capacity = vayu::http::routes::build_run_report_config (json::parse (
    R"({"mode":"capacity","duration":"5m","stepDuration":"5s","sloMs":200})"));
    EXPECT_EQ (capacity.value ("stepDuration", ""), "5s");
    EXPECT_EQ (capacity.value ("sloMs", 0), 200);

    // A capacity run that left both at their defaults has nothing to echo.
    const auto defaults = vayu::http::routes::build_run_report_config (
    json::parse (R"({"mode":"capacity","duration":"5m"})"));
    EXPECT_FALSE (defaults.contains ("stepDuration"));
    EXPECT_FALSE (defaults.contains ("sloMs"));

    // The gate is the mode, not the keys: a snapshot of another mode that
    // somehow holds them still reports neither.
    for (const char* mode : { "constant_concurrency", "ramp_up", "iterations" }) {
        const auto load = vayu::http::routes::build_run_report_config (json::parse (
        std::string (R"({"mode":")") + mode + R"(","stepDuration":"5s","sloMs":200})"));
        EXPECT_FALSE (load.contains ("stepDuration")) << mode;
        EXPECT_FALSE (load.contains ("sloMs")) << mode;
    }

    // A snapshot with no mode, or a mode that is not text, is not capacity.
    for (const char* snapshot : { R"({"sloMs":200})", R"({"mode":null,"sloMs":200})" }) {
        EXPECT_FALSE (
        vayu::http::routes::build_run_report_config (json::parse (snapshot)).contains ("sloMs"))
        << snapshot;
    }
}

// The same two keys through the report's metadata, which is what the route
// serves. Mutation check: drop `add_capacity_config` from
// `build_run_report_config` and this reds.
TEST (RunReportMetadataTest, ConfigurationNamesACapacityRunsKnobs) {
    vayu::db::Run run;
    run.type = vayu::RunType::Load;
    run.config_snapshot = R"({"mode":"capacity","stepDuration":"10s","sloMs":150})";
    const auto capacity =
    vayu::http::routes::build_report_metadata ("run_cap", run)["configuration"];
    EXPECT_EQ (capacity.value ("stepDuration", ""), "10s");
    EXPECT_EQ (capacity.value ("sloMs", 0), 150);

    run.config_snapshot = R"({"mode":"ramp_up","duration":"1m"})";
    const auto load     = vayu::http::routes::build_report_metadata (
    "run_load", run)["configuration"];
    EXPECT_FALSE (load.contains ("stepDuration"));
    EXPECT_FALSE (load.contains ("sloMs"));
}

// `rps` is the POST /runs body's other spelling of `targetRps`; the report
// names the rate one way, as the engine paced at it: `rps` first, `targetRps`
// when `rps` is zero. Mutation check: put `targetRps` ahead of `rps` in
// `add_target_rps` and this reds.
TEST (RunReportMetadataTest, ConfigurationNamesTheRateTargetRps) {
    vayu::db::Run run;
    run.config_snapshot = R"({"mode":"constant_rps","rps":40})";
    auto configuration =
    vayu::http::routes::build_report_metadata ("run_1", run)["configuration"];
    EXPECT_EQ (configuration.value ("targetRps", 0), 40);
    EXPECT_FALSE (configuration.contains ("rps"));

    run.config_snapshot = R"({"mode":"constant_rps","rps":40,"targetRps":60})";
    configuration =
    vayu::http::routes::build_report_metadata ("run_2", run)["configuration"];
    EXPECT_EQ (configuration.value ("targetRps", 0), 40);

    run.config_snapshot = R"({"mode":"constant_rps","rps":0,"targetRps":60})";
    configuration =
    vayu::http::routes::build_report_metadata ("run_2b", run)["configuration"];
    EXPECT_EQ (configuration.value ("targetRps", 0), 60);

    run.config_snapshot = R"({"mode":"constant_concurrency"})";
    configuration =
    vayu::http::routes::build_report_metadata ("run_3", run)["configuration"];
    EXPECT_FALSE (configuration.contains ("targetRps"));
}

// The budgets a run carried over rather than set (issue #2195), echoed as the
// client sent them so the verdict can tag those rows. Mutation check: drop
// `carriedBudgets` from `build_run_report_config`'s key list and this reds.
TEST (RunReportConfigTest, CarriesTheCarriedBudgetsAndOmitsThemWhenAbsent) {
    auto config = json::parse (
    R"({"mode":"once","carriedBudgets":["latencyP99Ms","custom.checkout.p95"]})");

    const auto config_obj = vayu::http::routes::build_run_report_config (config);
    EXPECT_EQ (config_obj.value ("carriedBudgets", json ()),
    json::parse (R"(["latencyP99Ms","custom.checkout.p95"])"));

    const auto set_here =
    vayu::http::routes::build_run_report_config (json::parse (R"({"mode":"once"})"));
    EXPECT_FALSE (set_here.contains ("carriedBudgets"));
}

// A collection run's file is in its manifest, not the snapshot's top level, so
// `metadata.configuration` reaches into `scenario` for it and every report that
// had a file names it in one place (issue #2051), with how it was read (issue
// #2540). Mutation check: drop the fallback loop in `build_report_metadata`,
// or `dataFileCastNumbers` from its keys, and this reds.
TEST (RunReportMetadataTest, ConfigurationNamesACollectionRunsDataFile) {
    vayu::db::Run run;
    run.type = vayu::RunType::Scenario;
    run.config_snapshot = R"({"scenario":{"source":"collection","collectionId":"col_1",
    "dataRowCount":2,"dataFileName":"users.csv",
    "dataFileHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","dataFileCastNumbers":true,
    "steps":[]}})";

    const auto metadata = vayu::http::routes::build_report_metadata ("run_1", run);
    ASSERT_TRUE (metadata.contains ("configuration")) << metadata.dump ();
    const auto& configuration = metadata["configuration"];
    EXPECT_EQ (configuration.value ("dataFileName", ""), "users.csv");
    EXPECT_EQ (configuration.value ("dataFileHash", ""), DATA_FILE_HASH);
    EXPECT_EQ (configuration.value ("dataFileCastNumbers", false), true);

    run.config_snapshot = R"({"scenario":{"source":"collection","collectionId":"col_1",
    "dataRowCount":0,"steps":[]}})";
    const auto unnamed = vayu::http::routes::build_report_metadata ("run_2", run);
    ASSERT_TRUE (unnamed.contains ("configuration")) << unnamed.dump ();
    EXPECT_FALSE (unnamed["configuration"].contains ("dataFileName"));
    EXPECT_FALSE (unnamed["configuration"].contains ("dataFileHash"));
    EXPECT_FALSE (unnamed["configuration"].contains ("dataFileCastNumbers"));
}

// A collection run the engine did not finish has no stored summary, so the
// report's top-level `scenario` breakdown is absent; the snapshot's identity
// (which collection, how many steps) must still reach `metadata.scenario`
// (issue #3569), without the manifest's per-step array. A single-request run
// has no manifest and so no `scenario`. Mutation check: drop the
// `add_scenario` call in `build_report_metadata` and this reds.
TEST (RunReportMetadataTest, NamesTheCollectionARunWithoutASummaryRan) {
    vayu::db::Run run;
    run.type            = vayu::RunType::Scenario;
    run.status          = vayu::RunStatus::Failed;
    run.config_snapshot = R"({"mode":"scenario","iterations":3,"scenario":{
    "source":"collection","collectionId":"col_1","iterations":3,"recursive":true,
    "steps":[{"name":"a","method":"GET","url":"https://x.test/a"},
    {"name":"b","method":"POST","url":"https://x.test/b"}]}})";

    const auto metadata = vayu::http::routes::build_report_metadata ("run_1", run);
    ASSERT_TRUE (metadata.contains ("scenario")) << metadata.dump ();
    const auto& scenario = metadata["scenario"];
    EXPECT_EQ (scenario.value ("collectionId", ""), "col_1");
    EXPECT_EQ (scenario.value ("iterations", 0), 3);
    EXPECT_EQ (scenario.value ("recursive", false), true);
    EXPECT_EQ (scenario.value ("stepCount", 0), 2);
    EXPECT_FALSE (scenario.contains ("steps")) << scenario.dump ();

    run.type            = vayu::RunType::Load;
    run.config_snapshot = R"({"mode":"constant_rps","url":"https://x.test/a",
    "method":"GET","rps":10})";
    const auto single = vayu::http::routes::build_report_metadata ("run_2", run);
    EXPECT_FALSE (single.contains ("scenario")) << single.dump ();
}

// ============================================================================
// #2895: a run the engine died under says its totals are partial, or missing
// ============================================================================

namespace {
/// A tick as the 1 Hz writer stores it: @p completed responses after
/// @p elapsed seconds, three of them failed (two 500s, one with no response).
/// `current_rps` is deliberately far from completed/elapsed.
vayu::db::MetricTick crash_tick (const std::string& run_id, size_t completed, double elapsed) {
    vayu::core::MetricTickSample sample;
    sample.elapsed_seconds    = elapsed;
    sample.requests_completed = completed;
    sample.requests_failed    = 3;
    sample.current_rps        = 999.0;
    sample.status_codes = { { 200, completed - 3 }, { 500, 2 }, { 0, 1 } };
    vayu::db::MetricTick tick;
    tick.run_id    = run_id;
    tick.timestamp = static_cast<int64_t> (elapsed * 1000);
    tick.payload   = vayu::core::build_metric_tick_payload (sample).dump ();
    return tick;
}

int64_t wall_clock_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}
} // namespace

// The whole path: a load run left running with three ticks, the engine
// restarted over the same file, and the report of the reconciled run. Mutation
// check: drop the `run.summary` write in `reconcile_orphaned_runs` and the
// report answers totalRequests 0 with no `partial`; delete the
// `latency_measured = false` line for a flagged run and the report writes a
// block of zeros, so the `latency` assertion fails; drop the flag guard on
// `peakConcurrency` / `avgQueueWaitMs` in `add_load_summary_fields` and both
// read 0 (#2963).
TEST_F (RunsRouteTest, ReportOfARunTheEngineDiedUnderCarriesItsLastTickFlaggedPartial) {
    // Recent: the restart's init() prunes by the real retention defaults.
    seed ({ .id = "run_crashed", .status = vayu::RunStatus::Running, .start_time = wall_clock_ms () });
    db_->add_metric_tick (crash_tick ("run_crashed", 10, 1.0));
    db_->add_metric_tick (crash_tick ("run_crashed", 25, 2.0));
    db_->add_metric_tick (crash_tick ("run_crashed", 40, 4.0));

    db_.reset ();
    db_ = std::make_unique<vayu::db::Database> (DB_PATH);
    db_->init ();

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_crashed");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["metadata"]["status"], "failed");
    const auto& summary = body["summary"];
    EXPECT_EQ (summary.value ("partial", false), true) << summary.dump ();
    EXPECT_FALSE (summary.contains ("summaryMissing"));
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), 40u);
    EXPECT_EQ (summary["failedRequests"].get<size_t> (), 3u);
    EXPECT_EQ (summary["noResponseRequests"].get<size_t> (), 1u);
    EXPECT_DOUBLE_EQ (summary["errorRate"].get<double> (), 7.5);
    EXPECT_DOUBLE_EQ (summary["testDuration"].get<double> (), 4.0);
    EXPECT_DOUBLE_EQ (summary["avgRps"].get<double> (), 10.0);
    // What the tick cannot measure stays out rather than reading as zero.
    EXPECT_FALSE (summary.contains ("avgInFlight"));
    EXPECT_FALSE (summary.contains ("connectionReplays"));
    EXPECT_FALSE (summary.contains ("sendingDurationSeconds"));
    EXPECT_FALSE (summary.contains ("peakConcurrency")) << summary.dump ();
    EXPECT_FALSE (summary.contains ("avgQueueWaitMs")) << summary.dump ();
    // No row was flushed, so there is no latency to report: absent, not zero.
    EXPECT_FALSE (body.contains ("latency")) << body["latency"].dump ();

    // The history row reads the same summary: a rate, an error share, and no
    // tail latency or verdict nothing measured.
    auto [list_status, list] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (list_status, 200);
    ASSERT_EQ (list["data"].size (), 1u);
    const auto& outcome = list["data"][0]["resultSummary"];
    EXPECT_DOUBLE_EQ (outcome.value ("rps", -1.0), 10.0) << outcome.dump ();
    EXPECT_DOUBLE_EQ (outcome.value ("errorRate", -1.0), 7.5);
    EXPECT_FALSE (outcome.contains ("p95Ms"));
    EXPECT_FALSE (outcome.contains ("verdict"));
}

// A failed load run with no summary at all says so instead of passing its
// zeros off as a run that sent nothing. Only a load run: a design run never
// has a load summary to miss. Mutation check: drop the `summary_missing`
// assignment in `run_report_response` and the first assertion fails; delete
// the `latency_measured = false` line beside it and the `latency` assertions
// fail; drop the flag guard on `peakConcurrency` / `avgQueueWaitMs` in
// `add_load_summary_fields` and both read 0 (#2963).
TEST_F (RunsRouteTest, ReportOfAFailedLoadRunWithNoSummarySaysItIsMissing) {
    seed ({ .id = "run_no_summary", .status = vayu::RunStatus::Failed, .start_time = 1000 });
    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_no_summary");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["summary"].value ("summaryMissing", false), true)
    << body["summary"].dump ();
    EXPECT_FALSE (body["summary"].contains ("partial"));
    EXPECT_FALSE (body.contains ("latency")) << body["latency"].dump ();
    EXPECT_FALSE (body["summary"].contains ("peakConcurrency"));
    EXPECT_FALSE (body["summary"].contains ("avgQueueWaitMs"));

    seed ({ .id = "run_design_failed",
    .type       = vayu::RunType::Design,
    .status     = vayu::RunStatus::Failed,
    .start_time = 1000 });
    auto [design_status, design] =
    vayu::http::routes::run_report_response (*db_, "run_design_failed");
    ASSERT_EQ (design_status, 200);
    EXPECT_FALSE (design["summary"].contains ("summaryMissing"));
}

// A failed worker can leave sampled rows behind with no summary. Their latency
// is a sample's, not the run's, so the report still carries none.
TEST_F (RunsRouteTest, SummaryMissingReportOmitsLatencyDespiteSampledRows) {
    seed ({ .id = "run_sampled_no_summary", .status = vayu::RunStatus::Failed, .start_time = 1000 });
    seed_result ("run_sampled_no_summary", 200, 7.0);
    seed_result ("run_sampled_no_summary", 200, 9.0);

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_sampled_no_summary");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["summary"].value ("summaryMissing", false), true)
    << body["summary"].dump ();
    EXPECT_EQ (body["resultsStored"].get<size_t> (), 2u);
    EXPECT_FALSE (body.contains ("latency")) << body["latency"].dump ();
}

// A run that stored its own summary carries neither flag, whether it completed
// or failed: the keys are present only when true. The figures a flagged run
// leaves out (#2963) are still written for it.
TEST_F (RunsRouteTest, ReportOfARunWithItsOwnSummaryCarriesNeitherFlag) {
    for (const auto run_status : { vayu::RunStatus::Completed, vayu::RunStatus::Failed }) {
        const std::string id = "run_" + std::string (vayu::to_string (run_status));
        seed ({ .id = id, .status = run_status, .start_time = 1000 });
        db_->update_run_summary (
        id, vayu::core::build_run_summary_payload (summary_inputs ()).dump ());

        auto [status, body] = vayu::http::routes::run_report_response (*db_, id);
        ASSERT_EQ (status, 200);
        const auto& summary = body["summary"];
        EXPECT_FALSE (summary.contains ("partial")) << id;
        EXPECT_FALSE (summary.contains ("summaryMissing")) << id;
        EXPECT_EQ (summary["totalRequests"].get<size_t> (), 100u) << id;
        EXPECT_EQ (summary.value ("peakConcurrency", size_t{ 0 }), 8u) << id;
        EXPECT_DOUBLE_EQ (summary.value ("avgQueueWaitMs", -1.0), 1.5) << id;
    }
}

// #2659: only a load run's live report skips its rows. A design or scenario run stores
// its rows just before the status flips, and a one-shot reader (response
// restore, the step list) fetching in that gap needs `trace`.
TEST_F (RunsRouteTest, ARunningScenarioOrDesignRunsReportKeepsItsTraces) {
    for (const auto type : { vayu::RunType::Scenario, vayu::RunType::Design }) {
        const std::string id = std::string ("run_traced_") + vayu::to_string (type);
        seed ({ .id = id, .type = type, .status = vayu::RunStatus::Running, .start_time = 1000 });
        seed_traced_result (id, 200, 10.0, R"({"dnsMs":1.0})");
        auto [status, report] = vayu::http::routes::run_report_response (*db_, id);
        ASSERT_EQ (status, 200);
        ASSERT_EQ (report["results"].size (), 1u);
        EXPECT_TRUE (report["results"][0].contains ("trace")) << id;
    }
}

TEST_F (RunsRouteTest, ResultsWithoutTracesKeepEveryOtherColumnInIdOrder) {
    seed ({ .id = "run_cols" });
    seed_traced_result ("run_cols", 0, 0.0, R"({"error_type":"timeout"})");
    seed_traced_result ("run_cols", 201, 7.5, R"({"dnsMs":1})");
    seed_traced_result ("other_run", 200, 1.0, R"({"dnsMs":1})");

    const auto full    = db_->get_results ("run_cols");
    const auto without = db_->get_results_without_traces ("run_cols");
    ASSERT_EQ (full.size (), 2u);
    ASSERT_EQ (without.size (), full.size ());
    for (size_t i = 0; i < full.size (); ++i) {
        EXPECT_FALSE (full[i].trace_data.empty ());
        EXPECT_TRUE (without[i].trace_data.empty ());
        EXPECT_EQ (without[i].id, full[i].id);
        EXPECT_EQ (without[i].run_id, full[i].run_id);
        EXPECT_EQ (without[i].timestamp, full[i].timestamp);
        EXPECT_EQ (without[i].status_code, full[i].status_code);
        EXPECT_EQ (without[i].status_text, full[i].status_text);
        EXPECT_DOUBLE_EQ (without[i].latency_ms, full[i].latency_ms);
        EXPECT_EQ (without[i].error, full[i].error);
    }
    EXPECT_LT (without[0].id, without[1].id);
    EXPECT_EQ (without[0].error, "timed out");
}

// ---------------------------------------------------------------------------
// GET /runs/:runId/results/:resultId (#3704): one stored result, as the
// report's `results[]` carries it.
// ---------------------------------------------------------------------------

namespace {
/// A design trace holding one script request, the record a reader pages into.
constexpr std::string_view SCRIPTED_TRACE =
R"({"request":{"url":"https://x.test/"},"response":{"body":"hello"},)"
R"("scripts":{"scriptRequests":[{"source":"pre","request":{"url":"https://side.test/"}}]}})";

/// The `error.message` of a refusal body.
std::string error_message (const json& body) {
    return body.value (json::json_pointer ("/error/message"), std::string ());
}
} // namespace

TEST_F (RunsRouteTest, AStoredResultReadsBackAsItsReportEntry) {
    seed ({ .id = "run_one", .type = vayu::RunType::Design, .start_time = 1000 });
    const int id =
    seed_traced_result ("run_one", 200, 12.5, std::string (SCRIPTED_TRACE));

    const auto [status, node] =
    vayu::http::routes::run_result_response (*db_, "run_one", std::to_string (id));

    ASSERT_EQ (status, 200) << node.dump ();
    EXPECT_EQ (node.value ("id", 0), id);
    EXPECT_EQ (node.value ("statusCode", 0), 200);
    EXPECT_EQ (node.at ("trace"), json::parse (SCRIPTED_TRACE));
    EXPECT_EQ (
    node.value (
    json::json_pointer ("/trace/scripts/scriptRequests/0/request/url"), std::string ()),
    "https://side.test/");
    const auto [report_status, report] =
    vayu::http::routes::run_report_response (*db_, "run_one");
    ASSERT_EQ (report_status, 200);
    ASSERT_EQ (report.at ("results").size (), 1u);
    EXPECT_EQ (node, report.at ("results").at (0));
}

// Each row of a run answers for itself, not the run's first or last.
TEST_F (RunsRouteTest, EachStoredResultOfARunReadsBackAsItself) {
    seed ({ .id = "run_two" });
    const int first  = seed_traced_result ("run_two", 200, 1.0, R"({"n":1})");
    const int second = seed_traced_result ("run_two", 0, 0.0, R"({"n":2})");
    ASSERT_NE (first, second);

    const auto [status, node] = vayu::http::routes::run_result_response (
    *db_, "run_two", std::to_string (second));

    ASSERT_EQ (status, 200) << node.dump ();
    EXPECT_EQ (node.value ("id", 0), second);
    EXPECT_EQ (node.value (json::json_pointer ("/trace/n"), 0), 2);
    EXPECT_EQ (node.value ("error", ""), "timed out");
}

TEST_F (RunsRouteTest, AResultOfAnUnknownRunIsNotFound) {
    seed ({ .id = "run_known" });
    const int id = seed_traced_result ("run_known", 200, 1.0, R"({})");

    const auto [status, body] = vayu::http::routes::run_result_response (
    *db_, "no_such_run", std::to_string (id));

    EXPECT_EQ (status, 404);
    EXPECT_EQ (error_message (body), "Run not found") << body.dump ();
}

TEST_F (RunsRouteTest, AnUnknownResultOfAKnownRunIsNotFound) {
    seed ({ .id = "run_known" });
    const int id = seed_traced_result ("run_known", 200, 1.0, R"({})");

    for (const std::string& text :
    { std::to_string (id + 1), std::string ("0"), std::string ("-1"),
    std::string ("99999999999999999999"), std::string (""), std::string ("1x") }) {
        const auto [status, body] =
        vayu::http::routes::run_result_response (*db_, "run_known", text);
        EXPECT_EQ (status, 404) << "'" << text << "'";
        EXPECT_EQ (error_message (body), "Result not found") << "'" << text << "'";
    }
}

// The run in the path is part of the address: a result id reached through
// another run is not that run's. Mutation check: drop the `run_id` term from
// `Database::get_result` and this answers 200 with the other run's trace.
TEST_F (RunsRouteTest, AResultUnderADifferentRunIsNotFound) {
    seed ({ .id = "run_owner" });
    seed ({ .id = "run_other" });
    const int id = seed_traced_result ("run_owner", 200, 1.0, R"({"owner":true})");

    const auto [status, body] =
    vayu::http::routes::run_result_response (*db_, "run_other", std::to_string (id));

    EXPECT_EQ (status, 404) << body.dump ();
    EXPECT_EQ (error_message (body), "Result not found");
    EXPECT_FALSE (db_->get_result ("run_other", id).has_value ());
    EXPECT_TRUE (db_->get_result ("run_owner", id).has_value ());
}

// The report's own rules for a trace hold here too: one that does not parse
// travels as its stored text, and a row stored with none carries no `trace`
// key.
TEST_F (RunsRouteTest, AStoredResultsTraceIsServedAsTheReportServesIt) {
    seed ({ .id = "run_odd" });
    const int garbled = seed_traced_result ("run_odd", 200, 1.0, "not json {");
    const int empty   = seed_traced_result ("run_odd", 200, 1.0, "");

    const auto [garbled_status, garbled_node] =
    vayu::http::routes::run_result_response (*db_, "run_odd", std::to_string (garbled));
    ASSERT_EQ (garbled_status, 200);
    EXPECT_EQ (garbled_node.at ("trace"), json ("not json {"));

    const auto [empty_status, empty_node] =
    vayu::http::routes::run_result_response (*db_, "run_odd", std::to_string (empty));
    ASSERT_EQ (empty_status, 200);
    EXPECT_FALSE (empty_node.contains ("trace")) << empty_node.dump ();
    EXPECT_FALSE (empty_node.contains ("error")) << empty_node.dump ();
}

// This run's custom trends, counters and rates (issue #1500), round-tripped
// through the stored summary the same way `thresholdValidation` is.
TEST_F (RunsRouteTest, ReportCarriesCustomMetrics) {
    seed ({ .id = "run_custom_metrics", .start_time = 1000 });
    auto inputs = summary_inputs ();
    vayu::core::CustomMetricSummary trend;
    trend.type            = vayu::core::CustomMetricType::Trend;
    trend.count           = 42;
    trend.p50             = 10.0;
    trend.p95             = 40.0;
    trend.p99             = 47.0;
    trend.max             = 50.0;
    inputs.custom_metrics = { { "ttfb2", trend } };
    db_->update_run_summary ("run_custom_metrics",
    vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_custom_metrics");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("customMetrics"));
    const auto& ttfb2 = body["customMetrics"]["ttfb2"];
    EXPECT_EQ (ttfb2["type"].get<std::string> (), "trend");
    EXPECT_EQ (ttfb2["count"].get<size_t> (), 42u);
    EXPECT_DOUBLE_EQ (ttfb2["p95"].get<double> (), 40.0);
}

// Issue #1484: a run whose every request errored before completing has no
// latency samples at all, and its stored `evaluated: false` / omitted
// `actual` must survive the round trip through the summary column exactly
// like every other absent-vs-zero section this report carries.
TEST_F (RunsRouteTest, ReportOmitsActualAndMarksUnevaluatedForALatencyCheckWithNoSamples) {
    seed ({ .id = "run_no_samples", .start_time = 1000 });
    vayu::core::RunSummaryInputs inputs;
    inputs.total_requests = 5999;
    inputs.status_codes   = { { 0, 5999 } };
    inputs.thresholds     = vayu::core::evaluate_thresholds (
    nlohmann::json{ { "thresholds", { { "latencyP99Ms", 200 } } } }, inputs);
    db_->update_run_summary (
    "run_no_samples", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_no_samples");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("thresholdValidation"));
    const auto& verdict = body["thresholdValidation"];
    EXPECT_EQ (verdict["verdict"].get<std::string> (), "failed");
    EXPECT_EQ (verdict["failed"].get<size_t> (), 1u);
    ASSERT_EQ (verdict["checks"].size (), 1u);
    const auto& check = verdict["checks"][0];
    EXPECT_FALSE (check["evaluated"].get<bool> ());
    EXPECT_FALSE (check["passed"].get<bool> ());
    EXPECT_FALSE (check.contains ("actual"));
}

TEST_F (RunsRouteTest, AThresholdVerdictPassesOnlyWhenNothingFailed) {
    seed ({ .id = "run_budgets_ok", .start_time = 1000 });
    auto inputs       = summary_inputs ();
    inputs.thresholds = vayu::core::evaluate_thresholds (
    nlohmann::json{ { "thresholds", { { "latencyP99Ms", 50 }, { "maxErrorRatePct", 25 } } } },
    inputs);
    db_->update_run_summary (
    "run_budgets_ok", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_budgets_ok");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["thresholdValidation"]["verdict"].get<std::string> (), "passed");
    EXPECT_EQ (body["thresholdValidation"]["failed"].get<size_t> (), 0u);
}

} // namespace
