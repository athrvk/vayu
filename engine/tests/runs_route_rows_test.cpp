/**
 * @file tests/runs_route_rows_test.cpp
 * @brief GET /runs rows beyond the summary: a terminal run's `resultSummary` (load, collection, scenario
 * load, capacity), the `origin` and `outcome` fields and their filters.
 *
 * Covers the route's extracted core in isolation, matching the suite's other route tests (no
 * in-process HTTP server). The `RunsRouteTest` fixture is in `runs_route_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <string>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "runs_route_fixture.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/core/threshold_eval.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace {

using vayu::tests::summary_inputs;

// ---------------------------------------------------------------------------
// GET /runs - a terminal load run's `resultSummary` (issue #2130)
// ---------------------------------------------------------------------------

/// The fixture's summary with budgets it meets (p99 30 <= 50, errors 10% <= 25%)
/// or, with @p meets false, one it misses (errors 10% > 1%).
std::string judged_summary (bool meets) {
    auto inputs              = summary_inputs ();
    const double error_limit = meets ? 25 : 1;
    inputs.thresholds        = vayu::core::evaluate_thresholds (
    nlohmann::json{
    { "thresholds", { { "latencyP99Ms", 50 }, { "maxErrorRatePct", error_limit } } } },
    inputs);
    return vayu::core::build_run_summary_payload (inputs).dump ();
}

/// The one row of @p body whose id is @p id, or an empty object.
nlohmann::json row_of (const nlohmann::json& body, const std::string& id) {
    for (const auto& row : body["data"]) {
        if (row["id"] == id) {
            return row;
        }
    }
    ADD_FAILURE () << "no row " << id;
    return nlohmann::json::object ();
}

// The four numbers a history row needs to say how a load run went, read off
// the summary the run stored rather than a report fetched per row.
TEST_F (RunsRouteTest, TerminalLoadRowCarriesItsResultSummary) {
    seed ({ .id = "run_load_done" });
    db_->update_run_summary ("run_load_done", judged_summary (true));

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    const auto& row = body["data"][0];
    ASSERT_TRUE (row.contains ("resultSummary"));
    const auto& outcome = row["resultSummary"];
    // The fixture's replay recorded one failed test (#3458), read off a
    // summary with no `assertions` block as the row read it before #3537.
    EXPECT_EQ (outcome.size (), 7u);
    for (const char* key : { "rps", "p95Ms", "errorRate", "verdict",
         "assertions", "assertionsPassed", "assertionsFailed" }) {
        ASSERT_TRUE (outcome.contains (key)) << key;
    }
    EXPECT_EQ (outcome["assertionsFailed"], 1);
    EXPECT_EQ (outcome["assertionsPassed"], 9);
    EXPECT_DOUBLE_EQ (outcome["rps"].get<double> (), 50.0);
    EXPECT_DOUBLE_EQ (outcome["p95Ms"].get<double> (), 25.0);
    // 7 server errors and 3 with no response, of 100: a percentage, not 0.1.
    EXPECT_DOUBLE_EQ (outcome["errorRate"].get<double> (), 10.0);
    EXPECT_EQ (outcome["verdict"], "passed");
}

// A run `thresholds.failRun` failed reports the verdict that failed it, and the
// same verdict the report's `thresholdValidation` prints.
TEST_F (RunsRouteTest, FailedLoadRowCarriesTheVerdictThatFailedIt) {
    seed ({ .id = "run_load_failed", .status = vayu::RunStatus::Failed });
    db_->update_run_summary ("run_load_failed", judged_summary (false));

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    ASSERT_TRUE (body["data"][0].contains ("resultSummary"));
    EXPECT_EQ (body["data"][0]["resultSummary"]["verdict"], "failed");

    auto [report_status, report] =
    vayu::http::routes::run_report_response (*db_, "run_load_failed");
    ASSERT_EQ (report_status, 200);
    EXPECT_EQ (body["data"][0]["resultSummary"]["verdict"],
    report["thresholdValidation"]["verdict"]);
}

// Each key is absent when the summary does not record it, never zeroed: a run
// with no budgets was never judged, a run with no status distribution has no
// rate, a run that timed no request has no p95 (#3540), and a run with no
// summary at all has no `resultSummary`. Mutation check: drop the `count` guard
// in `read_timed_p95` and `run_untimed` reads `p95Ms: 0`; make it demand a
// count and `run_pre_count` loses the p95 it stored.
TEST_F (RunsRouteTest, LoadResultSummaryOmitsWhatTheSummaryDoesNotRecord) {
    seed ({ .id = "run_unjudged", .status = vayu::RunStatus::Stopped, .start_time = 1 });
    db_->update_run_summary ("run_unjudged",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());

    auto no_codes         = summary_inputs ();
    no_codes.status_codes = {};
    seed ({ .id = "run_no_codes", .start_time = 2 });
    db_->update_run_summary (
    "run_no_codes", vayu::core::build_run_summary_payload (no_codes).dump ());

    // A `thresholds` object with no rows is the report's "never judged" too.
    seed ({ .id = "run_no_checks", .start_time = 3 });
    db_->update_run_summary ("run_no_checks",
    R"({"rps":5,"thresholds":{"checks":[],"passed":0,"failed":0}})");

    // A run that timed nothing stores `latency.count: 0` beside zeroed
    // percentiles, which are no tail latency; its rps is a recorded rate.
    auto untimed    = summary_inputs ();
    untimed.latency = {};
    seed ({ .id = "run_untimed", .start_time = 7 });
    db_->update_run_summary (
    "run_untimed", vayu::core::build_run_summary_payload (untimed).dump ());

    // A summary stored before `latency.count` existed has no marker to read,
    // so its stored p95 stands.
    auto pre_count = nlohmann::json::parse (
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());
    pre_count["latency"].erase ("count");
    seed ({ .id = "run_pre_count", .start_time = 8 });
    db_->update_run_summary ("run_pre_count", pre_count.dump ());

    seed ({ .id = "run_no_summary", .start_time = 4 });
    seed ({ .id = "run_bad_summary", .start_time = 5 });
    db_->update_run_summary ("run_bad_summary", "not valid json {{{");
    seed ({ .id = "run_other_keys", .start_time = 6 });
    db_->update_run_summary ("run_other_keys", R"({"total_requests":3})");

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);

    const auto unjudged = row_of (body, "run_unjudged");
    ASSERT_TRUE (unjudged.contains ("resultSummary"));
    // rps, p95Ms, errorRate and the replay's assertion keys.
    EXPECT_EQ (unjudged["resultSummary"].size (), 6u);
    EXPECT_FALSE (unjudged["resultSummary"].contains ("verdict"));

    const auto no_codes_row = row_of (body, "run_no_codes");
    ASSERT_TRUE (no_codes_row.contains ("resultSummary"));
    EXPECT_FALSE (no_codes_row["resultSummary"].contains ("errorRate"));
    EXPECT_TRUE (no_codes_row["resultSummary"].contains ("rps"));
    EXPECT_TRUE (no_codes_row["resultSummary"].contains ("p95Ms"));

    const auto untimed_row = row_of (body, "run_untimed");
    ASSERT_TRUE (untimed_row.contains ("resultSummary"));
    EXPECT_FALSE (untimed_row["resultSummary"].contains ("p95Ms"))
    << untimed_row["resultSummary"].dump ();
    EXPECT_TRUE (untimed_row["resultSummary"].contains ("rps"));

    const auto pre_count_row = row_of (body, "run_pre_count");
    ASSERT_TRUE (pre_count_row.contains ("resultSummary"));
    EXPECT_DOUBLE_EQ (pre_count_row["resultSummary"].value ("p95Ms", -1.0), 25.0);

    const auto no_checks = row_of (body, "run_no_checks");
    ASSERT_TRUE (no_checks.contains ("resultSummary"));
    EXPECT_EQ (no_checks["resultSummary"], (nlohmann::json{ { "rps", 5 } }));

    for (const char* id : { "run_no_summary", "run_bad_summary", "run_other_keys" }) {
        EXPECT_FALSE (row_of (body, id).contains ("resultSummary")) << id;
    }
}

// A terminal scenario load run's row carries its exact assertion counts
// (#2820), so a row whose every assertion failed at 0% errors can say so; a
// run that asserted nothing, or stored a malformed object, carries neither key.
// Mutation check: drop the `assertionsFailed` write in
// `load_result_summary` and the first row fails.
TEST_F (RunsRouteTest, ScenarioLoadRowCarriesItsAssertionCountsOnlyWhenStored) {
    auto with_assertions        = nlohmann::json::parse (judged_summary (true));
    with_assertions["scenario"] = { { "iterations", 4 },
        { "assertions", { { "passed", 1 }, { "failed", 4 } } } };
    seed ({ .id = "run_asserted", .start_time = 1 });
    db_->update_run_summary ("run_asserted", with_assertions.dump ());

    auto without_assertions = nlohmann::json::parse (judged_summary (true));
    without_assertions["scenario"] = { { "iterations", 4 } };
    seed ({ .id = "run_unasserted", .start_time = 2 });
    db_->update_run_summary ("run_unasserted", without_assertions.dump ());

    auto malformed = nlohmann::json::parse (judged_summary (true));
    malformed["scenario"] = { { "assertions", { { "passed", 1 }, { "failed", "4" } } } };
    seed ({ .id = "run_malformed", .start_time = 3 });
    db_->update_run_summary ("run_malformed", malformed.dump ());

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);

    const auto asserted = row_of (body, "run_asserted")["resultSummary"];
    EXPECT_EQ (asserted.value ("assertionsFailed", -1), 4) << asserted.dump ();
    EXPECT_EQ (asserted.value ("assertionsPassed", -1), 1) << asserted.dump ();
    // Stored before the `assertions` block: the exact pair alone, as read then.
    EXPECT_EQ (asserted.value ("assertions", nlohmann::json ()),
    (nlohmann::json{ { "exact", { { "passed", 1 }, { "failed", 4 } } } }))
    << asserted.dump ();
    EXPECT_EQ (asserted.size (), 7u) << asserted.dump ();

    for (const char* id : { "run_unasserted", "run_malformed" }) {
        const auto outcome = row_of (body, id)["resultSummary"];
        EXPECT_EQ (outcome.size (), 4u) << id << ": " << outcome.dump ();
        EXPECT_FALSE (outcome.contains ("assertionsFailed")) << id;
        EXPECT_FALSE (outcome.contains ("assertionsPassed")) << id;
    }
}

// #3538: a load row carries the drain a Stop cut beside its budget verdict,
// which stays as stored; a summary with no cut, or a malformed one, carries no
// key. Mutation check: drop the `record_drain_cut` call in
// `load_result_summary` and the first expectation fails.
TEST_F (RunsRouteTest, LoadRowCarriesTheDrainCutOnlyWhenStored) {
    auto cut         = nlohmann::json::parse (judged_summary (true));
    cut["cancelled"] = 15;
    cut["drainCut"]  = { { "cancelled", 15 } };
    seed ({ .id = "run_cut", .start_time = 1 });
    db_->update_run_summary ("run_cut", cut.dump ());

    auto malformed        = nlohmann::json::parse (judged_summary (true));
    malformed["drainCut"] = { { "cancelled", "15" } };
    seed ({ .id = "run_malformed_cut", .start_time = 2 });
    db_->update_run_summary ("run_malformed_cut", malformed.dump ());

    seed ({ .id = "run_uncut", .start_time = 3 });
    db_->update_run_summary ("run_uncut", judged_summary (true));

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);

    const auto outcome = row_of (body, "run_cut")["resultSummary"];
    EXPECT_EQ (outcome.value ("drainCut", nlohmann::json ()),
    (nlohmann::json{ { "cancelled", 15 } }))
    << outcome.dump ();
    EXPECT_EQ (outcome.value ("verdict", ""), "passed") << outcome.dump ();
    for (const char* id : { "run_malformed_cut", "run_uncut" }) {
        EXPECT_FALSE (row_of (body, id)["resultSummary"].contains ("drainCut")) << id;
    }
}

/// A single-request load run's stored summary with no `tests` and no
/// `elements`, the fixture's own replay totals taken out.
nlohmann::json single_request_summary () {
    auto stored = nlohmann::json::parse (judged_summary (true));
    stored.erase ("tests");
    return stored;
}

// A single-request load run stored before the `assertions` block (#3537) keeps
// the row #3458 gave it, derived from the two places it stored failures: the
// `assert.*` and `script.*` rows of `elements` as `exact` and the replay's
// `tests` as `sampled`. A run that stored neither carries no key, and a stored
// zero is a recorded zero.
// Mutation check: drop the single-request half of `derive_legacy_assertions`
// and the first three rows lose the key.
TEST_F (RunsRouteTest, SingleRequestLoadRowDerivesItsFailedAssertions) {
    auto inline_failures        = single_request_summary ();
    inline_failures["elements"] = nlohmann::json::array (
    { { { "kind", "script.post" }, { "passed", 0 }, { "failed", 150 } } });
    seed ({ .id = "run_inline", .start_time = 1 });
    db_->update_run_summary ("run_inline", inline_failures.dump ());

    auto replayed     = single_request_summary ();
    replayed["tests"] = { { "sampled", 8 }, { "passed", 4 }, { "failed", 4 } };
    seed ({ .id = "run_replayed", .start_time = 2 });
    db_->update_run_summary ("run_replayed", replayed.dump ());

    auto both        = single_request_summary ();
    both["elements"] = nlohmann::json::array ({
    { { "kind", "assert.status" }, { "failed", 2 } },
    { { "kind", "extract.json" }, { "failed", 0 }, { "missing", 9 } },
    { { "kind", "script.post" }, { "failed", 3 } },
    });
    both["tests"]    = { { "sampled", 8 }, { "passed", 4 }, { "failed", 4 } };
    seed ({ .id = "run_both", .start_time = 3 });
    db_->update_run_summary ("run_both", both.dump ());

    auto clean     = single_request_summary ();
    clean["tests"] = { { "sampled", 8 }, { "passed", 8 }, { "failed", 0 } };
    seed ({ .id = "run_clean", .start_time = 4 });
    db_->update_run_summary ("run_clean", clean.dump ());

    seed ({ .id = "run_unasserted", .start_time = 5 });
    db_->update_run_summary ("run_unasserted", single_request_summary ().dump ());

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);

    const auto failed_of = [&body] (const char* id) {
        return row_of (body, id)["resultSummary"].value ("assertionsFailed", -1);
    };
    EXPECT_EQ (failed_of ("run_inline"), 150);
    EXPECT_EQ (failed_of ("run_replayed"), 4);
    EXPECT_EQ (failed_of ("run_both"), 9);
    EXPECT_EQ (failed_of ("run_clean"), 0);
    EXPECT_EQ (failed_of ("run_unasserted"), -1);
    const auto passed_of = [&body] (const char* id) {
        return row_of (body, id)["resultSummary"].value ("assertionsPassed", -1);
    };
    EXPECT_EQ (passed_of ("run_inline"), 0);
    EXPECT_EQ (passed_of ("run_replayed"), 4);
    EXPECT_EQ (passed_of ("run_both"), 4);
    EXPECT_EQ (passed_of ("run_clean"), 8);
    EXPECT_EQ (row_of (body, "run_both")["resultSummary"]["assertions"],
    (nlohmann::json{ { "exact", { { "passed", 0 }, { "failed", 5 } } },
    { "sampled", { { "passed", 4 }, { "failed", 4 } } } }));
}

// What a stored summary can hold that is not a count: a non-numeric `failed`,
// a row that is not an object, an `elements` that is not an array.
TEST_F (RunsRouteTest, SingleRequestLoadRowIgnoresMalformedAssertionTallies) {
    auto junk        = single_request_summary ();
    junk["elements"] = nlohmann::json::array (
    { 7, { { "kind", "script.post" }, { "failed", "3" } }, { { "kind", "x" } } });
    junk["tests"] = { { "sampled", 1 }, { "failed", -2 } };
    seed ({ .id = "run_junk", .start_time = 1 });
    db_->update_run_summary ("run_junk", junk.dump ());

    auto not_array        = single_request_summary ();
    not_array["elements"] = 5;
    seed ({ .id = "run_scalar", .start_time = 2 });
    db_->update_run_summary ("run_scalar", not_array.dump ());

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    for (const char* id : { "run_junk", "run_scalar" }) {
        EXPECT_FALSE (
        row_of (body, id)["resultSummary"].contains ("assertionsFailed"))
        << id;
    }
}

/// The stored `assertions` block (#3537) with these counts.
nlohmann::json assertion_block (vayu::core::AssertionPopulations populations,
size_t errored,
size_t teardown_failed) {
    return { { "exact",
             { { "passed", populations.exact.passed },
             { "failed", populations.exact.failed } } },
        { "sampled",
        { { "passed", populations.sampled.passed },
        { "failed", populations.sampled.failed } } },
        { "errored", errored }, { "teardownFailed", teardown_failed } };
}

// The writer's `assertions` block reaches the list row and the report as
// stored (#3537): both populations, the element executions that errored and
// the teardowns that failed, with the row's flat counts over both populations.
// Mutation check: drop the `assertions` write in `build_run_summary_payload`
// and both reads lose `errored` and `teardownFailed`.
TEST_F (RunsRouteTest, TheAssertionBlockRoundTripsToTheRowAndTheReport) {
    auto inputs  = summary_inputs ();
    inputs.tests = vayu::core::ScriptValidationTotals{ 7, 5, 2, {}, 0 };
    const vayu::core::AssertionPopulations populations{
        .exact = { .passed = 3, .failed = 1 }, .sampled = { .passed = 5, .failed = 2 }
    };
    inputs.assertions = populations;
    inputs.elements   = nlohmann::json::array ({ { { "id", "el_post" },
    { "kind", "script.post" }, { "passed", 2 }, { "failed", 1 }, { "error", 4u } } });
    inputs.lifecycle  = nlohmann::json{ { "teardown",
    nlohmann::json::array ({ { { "kind", "script.teardown" }, { "outcome", "failed" } } }) } };
    seed ({ .id = "run_block" });
    db_->update_run_summary (
    "run_block", vayu::core::build_run_summary_payload (inputs).dump ());
    const auto block = assertion_block (populations, 4, 1);

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    const auto outcome = row_of (body, "run_block")["resultSummary"];
    EXPECT_EQ (outcome.value ("assertions", nlohmann::json ()), block)
    << outcome.dump ();
    EXPECT_EQ (outcome.value ("assertionsFailed", -1), 3);
    EXPECT_EQ (outcome.value ("assertionsPassed", -1), 8);

    auto [report_status, report] =
    vayu::http::routes::run_report_response (*db_, "run_block");
    ASSERT_EQ (report_status, 200);
    EXPECT_EQ (report.value ("assertions", nlohmann::json ()), block) << report.dump ();
}

// A scenario load run whose deferred `pm.test` failed on every replayed sample
// carries the failure on its row and its report (#3537), though its exact
// population is empty and `scenario.assertions` stays absent at zero (#2820).
// Mutation check: put back `record_assertions`' early return for a summary
// with a `scenario` block, reading only `scenario.assertions`, and the row
// loses the failure.
TEST_F (RunsRouteTest, AScenarioLoadRowCarriesItsSampledReplayFailures) {
    auto inputs = summary_inputs ();
    inputs.scenario = nlohmann::json{ { "iterations", 4 }, { "steps_executed", 91 },
        { "passed", 91 }, { "steps", nlohmann::json::array () } };
    inputs.tests = vayu::core::ScriptValidationTotals{ 91, 0, 91, {}, 0 };
    const vayu::core::AssertionPopulations populations{ .exact = {},
        .sampled = { .passed = 0, .failed = 91 } };
    inputs.assertions = populations;
    seed ({ .id = "run_scenario_replay" });
    db_->update_run_summary ("run_scenario_replay",
    vayu::core::build_run_summary_payload (inputs).dump ());
    const auto block = assertion_block (populations, 0, 0);

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    const auto outcome = row_of (body, "run_scenario_replay")["resultSummary"];
    EXPECT_EQ (outcome.value ("assertionsFailed", -1), 91) << outcome.dump ();
    EXPECT_EQ (outcome.value ("assertionsPassed", -1), 0) << outcome.dump ();
    EXPECT_EQ (outcome.value ("assertions", nlohmann::json ()), block)
    << outcome.dump ();

    auto [report_status, report] =
    vayu::http::routes::run_report_response (*db_, "run_scenario_replay");
    ASSERT_EQ (report_status, 200);
    EXPECT_EQ (report.value ("assertions", nlohmann::json ()), block) << report.dump ();
    ASSERT_TRUE (report.contains ("scenario")) << report.dump ();
    EXPECT_FALSE (report["scenario"].contains ("assertions"))
    << report["scenario"].dump ();
}

// A required `extract.*` that misses on every response is a failed assertion
// in the exact population the budget judges (#3537), so the row's failed count
// is the report's `assertionsExact.failed`, not the element row's `failed`,
// where a miss is `missing`. Mutation check: have `read_run_assertions` ignore
// the stored block and derive it, and the row reads 0.
TEST_F (RunsRouteTest, ARequiredExtractorMissCountsOnTheRowAsTheBudgetCountsIt) {
    auto inputs = summary_inputs ();
    inputs.tests.reset ();
    inputs.elements = nlohmann::json::array (
    { { { "id", "el_tok" }, { "kind", "extract.json" }, { "required", true },
    { "passed", 0 }, { "failed", 0 }, { "missing", 4227 }, { "error", 0 } } });
    inputs.assertions =
    vayu::core::AssertionPopulations{ .exact = { .passed = 0, .failed = 4227 },
        .sampled                             = {} };
    inputs.thresholds = vayu::core::evaluate_thresholds (
    nlohmann::json{ { "thresholds", { { "maxAssertionFailureRatePct", 0 } } } }, inputs);
    seed ({ .id = "run_required_miss" });
    db_->update_run_summary (
    "run_required_miss", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [report_status, report] =
    vayu::http::routes::run_report_response (*db_, "run_required_miss");
    ASSERT_EQ (report_status, 200);
    ASSERT_TRUE (report.contains ("thresholdValidation")) << report.dump ();
    const auto budget_failed =
    report["thresholdValidation"]["checks"][0]["assertionsExact"]["failed"];
    EXPECT_EQ (budget_failed, 4227);

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    const auto outcome = row_of (body, "run_required_miss")["resultSummary"];
    EXPECT_EQ (outcome.value ("assertionsFailed", nlohmann::json ()), budget_failed)
    << outcome.dump ();
    EXPECT_EQ (report["assertions"]["exact"]["failed"], budget_failed) << report.dump ();
}

// A summary stored before the block reads as it did (#3537): a scenario load
// run's exact pair alone, its replay's failures unread as they were, and
// nothing derived for `errored` or `teardownFailed`, which no verdict read
// then. A run that stored no assertion gains no `assertions` member.
// Mutation check: derive `sampled` off `tests` for a scenario summary in
// `derive_legacy_assertions` and the first expectation fails.
TEST_F (RunsRouteTest, ASummaryStoredBeforeTheBlockReadsAsItDidThen) {
    seed ({ .id = "run_old_scenario", .start_time = 1 });
    db_->update_run_summary ("run_old_scenario",
    nlohmann::json{
    { "scenario",
    { { "iterations", 2 }, { "errored", 6 },
    { "assertions", { { "passed", 3 }, { "failed", 0 } } },
    { "steps",
    nlohmann::json::array ({ { { "elements",
    nlohmann::json::array ({ { { "kind", "script.post" }, { "error", 6 } } }) } } }) } } },
    { "tests", { { "sampled", 4 }, { "passed", 0 }, { "failed", 4 } } },
    { "lifecycle", { { "teardown", nlohmann::json::array ({ { { "outcome", "failed" } } }) } } } }
    .dump ());
    seed ({ .id = "run_old_unasserted", .start_time = 2 });
    db_->update_run_summary ("run_old_unasserted",
    nlohmann::json{ { "scenario", { { "iterations", 2 } } }, { "rps", 5 } }.dump ());

    auto [report_status, report] =
    vayu::http::routes::run_report_response (*db_, "run_old_scenario");
    ASSERT_EQ (report_status, 200);
    const nlohmann::json exact_only = { { "exact", { { "passed", 3 }, { "failed", 0 } } } };
    EXPECT_EQ (report.value ("assertions", nlohmann::json ()), exact_only)
    << report.dump ();
    EXPECT_EQ (report["scenario"].value ("assertions", nlohmann::json ()),
    exact_only["exact"]);

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    const auto outcome = row_of (body, "run_old_scenario")["resultSummary"];
    EXPECT_EQ (outcome.value ("assertionsFailed", -1), 0) << outcome.dump ();
    EXPECT_EQ (outcome.value ("assertions", nlohmann::json ()), exact_only);

    auto [plain_status, plain] =
    vayu::http::routes::run_report_response (*db_, "run_old_unasserted");
    ASSERT_EQ (plain_status, 200);
    EXPECT_FALSE (plain.contains ("assertions")) << plain.dump ();
    EXPECT_FALSE (row_of (body, "run_old_unasserted")["resultSummary"].contains ("assertions"));
}

/// The fixture's summary with the capacity search @p levels ended in, against
/// a 100 ms budget and a 256 ceiling.
std::string capacity_summary (const std::vector<vayu::core::CapacityWindow>& levels,
const char* stop_reason) {
    auto inputs = summary_inputs ();
    vayu::core::CapacityConfig search;
    search.slo_ms          = 100.0;
    search.max_concurrency = 256;
    inputs.capacity = vayu::core::summarize_capacity (search, levels, stop_reason);
    return vayu::core::build_run_summary_payload (inputs).dump ();
}

// A capacity run's row says what the search found (#2930): why it stopped, the
// highest level it held and the level it broke at, the same three the report
// headlines. A level the search never found is absent, never 0, which would
// read as a service that held nothing or broke at nothing.
// Mutation check: drop the `capacity` write in `load_result_summary` and
// every capacity row fails.
TEST_F (RunsRouteTest, CapacityRowCarriesTheHeldAndKneeLevels) {
    seed ({ .id = "run_capacity_knee", .start_time = 1 });
    db_->update_run_summary ("run_capacity_knee",
    capacity_summary ({ { 8, 900.0, 12.0, 0.0, 4500 }, { 16, 1700.0, 20.0, 0.5, 8500 },
                      { 32, 1750.0, 180.0, 2.0, 8750 }, { 32, 1720.0, 210.0, 3.5, 0 } },
    vayu::core::capacity_stop::SLO_EXCEEDED));
    seed ({ .id = "run_capacity_cap", .start_time = 2 });
    db_->update_run_summary ("run_capacity_cap",
    capacity_summary ({ { 8, 900.0, 12.0 } }, vayu::core::capacity_stop::CAP_REACHED));
    seed ({ .id = "run_capacity_breached", .start_time = 3 });
    db_->update_run_summary ("run_capacity_breached",
    capacity_summary ({ { 8, 900.0, 300.0 } }, vayu::core::capacity_stop::SLO_EXCEEDED));

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);

    const auto knee = row_of (body, "run_capacity_knee")["resultSummary"];
    ASSERT_TRUE (knee.contains ("capacity")) << knee.dump ();
    EXPECT_EQ (knee["capacity"],
    (nlohmann::json{ { "stopReason", "slo_exceeded" },
    { "maxHealthyConcurrency", 16 }, { "kneeConcurrency", 32 } }));
    // The rest of the row is untouched beside it: rps, p95Ms, errorRate and
    // the fixture replay's three assertion keys.
    EXPECT_EQ (knee.size (), 7u) << knee.dump ();

    auto [report_status, report] =
    vayu::http::routes::run_report_response (*db_, "run_capacity_knee");
    ASSERT_EQ (report_status, 200);
    for (const char* key : { "stopReason", "maxHealthyConcurrency", "kneeConcurrency" }) {
        EXPECT_EQ (knee["capacity"][key], report["capacity"][key]) << key;
    }

    const auto cap = row_of (body, "run_capacity_cap")["resultSummary"];
    ASSERT_TRUE (cap.contains ("capacity")) << cap.dump ();
    EXPECT_EQ (cap["capacity"],
    (nlohmann::json{ { "stopReason", "cap_reached" }, { "maxHealthyConcurrency", 8 } }));

    const auto breached =
    row_of (body, "run_capacity_breached")["resultSummary"];
    ASSERT_TRUE (breached.contains ("capacity")) << breached.dump ();
    EXPECT_EQ (breached["capacity"],
    (nlohmann::json{ { "stopReason", "slo_exceeded" }, { "kneeConcurrency", 8 } }));
}

// Only a capacity section the report would show reaches the row: a load run
// that searched nothing, a `capacity` that is not an object, and one with no
// levels all leave the key off rather than carrying an empty headline.
TEST_F (RunsRouteTest, LoadRowWithoutACapacitySearchCarriesNoCapacity) {
    seed ({ .id = "run_plain", .start_time = 1 });
    db_->update_run_summary ("run_plain", judged_summary (true));

    auto not_object        = nlohmann::json::parse (judged_summary (true));
    not_object["capacity"] = 5;
    seed ({ .id = "run_capacity_scalar", .start_time = 2 });
    db_->update_run_summary ("run_capacity_scalar", not_object.dump ());

    auto no_levels = nlohmann::json::parse (judged_summary (true));
    no_levels["capacity"] = { { "stop_reason", "slo_exceeded" }, { "knee_concurrency", 8 } };
    seed ({ .id = "run_capacity_no_levels", .start_time = 3 });
    db_->update_run_summary ("run_capacity_no_levels", no_levels.dump ());

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);

    for (const char* id : { "run_plain", "run_capacity_scalar", "run_capacity_no_levels" }) {
        const auto outcome = row_of (body, id)["resultSummary"];
        EXPECT_FALSE (outcome.contains ("capacity")) << id << ": " << outcome.dump ();
        // rps, p95Ms, errorRate, verdict and the replay's three assertion keys.
        EXPECT_EQ (outcome.size (), 7u) << id << ": " << outcome.dump ();
    }
}

// The gate is the status, not whether a summary is there yet: a Pending or
// Running row is never read and never cached, so the poll after the run ends
// builds its outcome fresh. Dropping the gate fails the second poll (the
// summary lands before the status) and the third (an entry cached while
// running would be served forever).
TEST_F (RunsRouteTest, LoadRowGetsNoResultSummaryUntilItsStatusIsTerminal) {
    seed ({ .id = "run_pending", .status = vayu::RunStatus::Pending, .start_time = 1 });
    seed ({ .id = "run_live", .status = vayu::RunStatus::Running, .start_time = 2 });

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (first_status, 200);
    ASSERT_EQ (first["data"].size (), 2u);
    EXPECT_FALSE (first["data"][0].contains ("resultSummary"));
    EXPECT_FALSE (first["data"][1].contains ("resultSummary"));

    // The order every writer keeps: summary first, terminal status second.
    db_->update_run_summary ("run_live", judged_summary (true));
    auto [_, second] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_FALSE (row_of (second, "run_live").contains ("resultSummary"));
    EXPECT_EQ (summaries_.outcome_build_count (), 0u);

    db_->transition_run_status (
    "run_live", { vayu::RunStatus::Running }, vayu::RunStatus::Completed);
    auto [third_status, third] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (third_status, 200);
    const auto finished = row_of (third, "run_live");
    ASSERT_TRUE (finished.contains ("resultSummary"));
    EXPECT_EQ (finished["resultSummary"]["verdict"], "passed");
    EXPECT_FALSE (row_of (third, "run_pending").contains ("resultSummary"));
    EXPECT_EQ (summaries_.outcome_build_count (), 1u);
}

// A stop that finds no registered worker writes Stopped with no summary, and
// the worker stores its own afterwards. The poll between the two must neither
// build nor cache an empty outcome, or the real one would never show. Dropping
// the non-empty gate fails the first poll's build count and the last poll's key.
TEST_F (RunsRouteTest, StoppedLoadRowWithoutSummaryIsNotCachedBeforeTheWorkerWritesOne) {
    seed ({ .id = "run_early_stop", .status = vayu::RunStatus::Stopped });

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (first_status, 200);
    EXPECT_FALSE (row_of (first, "run_early_stop").contains ("resultSummary"));
    EXPECT_EQ (summaries_.outcome_build_count (), 0u);

    db_->update_run_summary ("run_early_stop", judged_summary (true));
    auto [second_status, second] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (second_status, 200);
    const auto finished = row_of (second, "run_early_stop");
    ASSERT_TRUE (finished.contains ("resultSummary"));
    EXPECT_EQ (finished["resultSummary"]["verdict"], "passed");
    EXPECT_EQ (summaries_.outcome_build_count (), 1u);
}

// A terminal load run's summary is final, so the poll parses it once - and
// only a load row's: a design row, or a collection row that stored no summary,
// never asks for an outcome.
TEST_F (RunsRouteTest, RepeatedPollsParseEachLoadSummaryOnce) {
    for (const char* id : { "run_l1", "run_l2", "run_l3" }) {
        seed ({ .id = id });
        db_->update_run_summary (id, judged_summary (true));
    }
    seed ({ .id = "run_d", .type = vayu::RunType::Design, .start_time = 1 });
    seed ({ .id = "run_s", .type = vayu::RunType::Scenario, .start_time = 2 });

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (first_status, 200);
    EXPECT_EQ (summaries_.outcome_build_count (), 3u);
    EXPECT_EQ (summaries_.build_count (), 5u);

    auto [second_status, second] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (second_status, 200);
    EXPECT_EQ (summaries_.outcome_build_count (), 3u);
    EXPECT_EQ (summaries_.build_count (), 5u);
    EXPECT_EQ (second["data"], first["data"]);
}

// The design row keeps its own two numbers even when it stored a summary a load
// row would read, and a collection row reads only the `scenario` block of its
// summary: a load-shaped summary without one yields no `resultSummary`.
// Mutation check: make `terminal_result_summary` build the load shape for
// a Scenario run and the second half fails (rps, p95Ms and errorRate appear).
TEST_F (RunsRouteTest, DesignRowKeepsItsOwnResultSummaryAndCollectionRowReadsOnlyItsScenarioBlock) {
    const auto stored =
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ();
    seed ({ .id = "run_design", .type = vayu::RunType::Design, .start_time = 1 });
    db_->update_run_summary ("run_design", stored);
    seed_result ("run_design", 201, 7.5);
    seed ({ .id = "run_scenario", .type = vayu::RunType::Scenario, .start_time = 2 });
    db_->update_run_summary ("run_scenario", stored);

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    const auto design = row_of (body, "run_design");
    ASSERT_TRUE (design.contains ("resultSummary"));
    EXPECT_EQ (design["resultSummary"],
    (nlohmann::json{ { "statusCode", 201 }, { "latencyMs", 7.5 } }));
    EXPECT_FALSE (row_of (body, "run_scenario").contains ("resultSummary"));
    // Asked about, found empty, and settled: the summary is final.
    EXPECT_EQ (summaries_.outcome_build_count (), 1u);
}

/// A collection run's stored summary with the given step counts, built as the
/// runner builds it. The steps that sent answered 200 (@p passed) or 500
/// (@p failed); @p thresholds, when given, is judged off that tally, the way
/// `sequential_summary` does.
std::string counted_scenario_summary (size_t passed,
size_t failed,
size_t skipped,
size_t errored,
const json& thresholds = json (),
size_t stopped         = 0) {
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.passed         = passed;
    inputs.failed         = failed;
    inputs.skipped        = skipped;
    inputs.errored        = errored;
    inputs.stopped        = stopped;
    inputs.steps_executed = passed + failed + skipped + errored + stopped;
    inputs.duration_s     = 2.0;
    inputs.status_codes   = { { 200, passed } };
    if (failed > 0) {
        inputs.status_codes[500] = failed;
    }
    if (!thresholds.is_null ()) {
        vayu::core::RunSummaryInputs judged;
        judged.total_requests =
        vayu::count_status_failures (inputs.status_codes).total;
        judged.status_codes = inputs.status_codes;
        inputs.thresholds =
        vayu::core::evaluate_thresholds (json{ { "thresholds", thresholds } }, judged);
    }
    return vayu::core::build_scenario_summary_payload (inputs).dump ();
}

// A finished collection run says how its steps went on its own row (#2954): the
// five disjoint outcomes, `errored` included because a run whose steps only
// errored would otherwise read clean, and `stopped` (#3397) because a stopped
// run's counts would otherwise not add up. A zero stored is a zero reported -
// the run recorded it - and no budget declared means no `verdict`.
// Mutation check: restore the Load-only gate (`carries_result_summary`) and
// every row here loses its `resultSummary`; drop the `errored` copy in
// `scenario_result_summary` and the second row fails; drop the
// `stopped` copy and every row fails.
TEST_F (RunsRouteTest, TerminalCollectionRowCarriesItsStepCounts) {
    seed ({ .id = "run_clean", .type = vayu::RunType::Scenario, .start_time = 1 });
    db_->update_run_summary ("run_clean", counted_scenario_summary (4, 0, 0, 0));
    seed ({ .id = "run_mixed", .type = vayu::RunType::Scenario, .start_time = 2 });
    db_->update_run_summary ("run_mixed", counted_scenario_summary (5, 2, 1, 3));
    seed ({ .id = "run_only_errored",
    .type       = vayu::RunType::Scenario,
    .status     = vayu::RunStatus::Failed,
    .start_time = 3 });
    db_->update_run_summary ("run_only_errored", counted_scenario_summary (0, 0, 0, 2));
    seed ({ .id = "run_stopped",
    .type       = vayu::RunType::Scenario,
    .status     = vayu::RunStatus::Stopped,
    .start_time = 4 });
    db_->update_run_summary ("run_stopped",
    counted_scenario_summary (2, 0, 0, 0, json (), /*stopped=*/1));

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);

    EXPECT_EQ (row_of (body, "run_clean")["resultSummary"],
    (json{ { "passed", 4 }, { "failed", 0 }, { "skipped", 0 }, { "errored", 0 },
    { "stopped", 0 } }));
    EXPECT_EQ (row_of (body, "run_mixed")["resultSummary"],
    (json{ { "passed", 5 }, { "failed", 2 }, { "skipped", 1 }, { "errored", 3 },
    { "stopped", 0 } }));
    EXPECT_EQ (row_of (body, "run_only_errored")["resultSummary"],
    (json{ { "passed", 0 }, { "failed", 0 }, { "skipped", 0 }, { "errored", 2 },
    { "stopped", 0 } }));
    EXPECT_EQ (row_of (body, "run_stopped")["resultSummary"],
    (json{ { "passed", 2 }, { "failed", 0 }, { "skipped", 0 }, { "errored", 0 },
    { "stopped", 1 } }));
}

// The verdict is read exactly as a load row reads it: present only when the
// summary recorded a judged budget, and as stored for a stopped run too.
// Mutation check: drop `record_verdict` from `scenario_result_summary`
// and the first two rows lose their verdict.
TEST_F (RunsRouteTest, CollectionRowCarriesTheBudgetVerdictOnlyWhenOneWasJudged) {
    seed ({ .id = "run_met", .type = vayu::RunType::Scenario, .start_time = 1 });
    db_->update_run_summary ("run_met",
    counted_scenario_summary (3, 0, 0, 0, json{ { "maxErrorRatePct", 1 } }));
    seed ({ .id = "run_missed",
    .type       = vayu::RunType::Scenario,
    .status     = vayu::RunStatus::Failed,
    .start_time = 2 });
    db_->update_run_summary ("run_missed",
    counted_scenario_summary (3, 2, 0, 0, json{ { "maxErrorRatePct", 1 } }));
    seed ({ .id = "run_halted",
    .type       = vayu::RunType::Scenario,
    .status     = vayu::RunStatus::Stopped,
    .start_time = 3 });
    db_->update_run_summary ("run_halted",
    counted_scenario_summary (3, 0, 0, 0, json{ { "maxErrorRatePct", 1 } }));
    seed ({ .id = "run_unjudged_collection", .type = vayu::RunType::Scenario, .start_time = 4 });
    db_->update_run_summary (
    "run_unjudged_collection", counted_scenario_summary (3, 0, 0, 0));

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_EQ (row_of (body, "run_met")["resultSummary"]["verdict"], "passed");
    EXPECT_EQ (row_of (body, "run_missed")["resultSummary"]["verdict"], "failed");
    EXPECT_EQ (row_of (body, "run_halted")["resultSummary"]["verdict"], "passed");
    EXPECT_FALSE (row_of (body, "run_unjudged_collection")["resultSummary"].contains ("verdict"));

    // The report prints the same verdict the row does.
    auto [report_status, report] =
    vayu::http::routes::run_report_response (*db_, "run_missed");
    ASSERT_EQ (report_status, 200);
    EXPECT_EQ (row_of (body, "run_missed")["resultSummary"]["verdict"],
    report["thresholdValidation"]["verdict"]);
}

// A key the summary does not record is absent, never zeroed (a summary stored by
// an older engine), and a summary with no readable `scenario` object, an empty
// one included, adds no `resultSummary` at all.
// Mutation check: replace `copy_optional_number` in
// `scenario_result_summary` with an unconditional write and the partial
// row gains zeroed keys.
TEST_F (RunsRouteTest, CollectionResultSummaryOmitsWhatTheSummaryDoesNotRecord) {
    seed ({ .id = "run_partial", .type = vayu::RunType::Scenario, .start_time = 1 });
    db_->update_run_summary ("run_partial",
    R"({"scenario":{"passed":2,"errored":"many","failed":null}})");
    seed ({ .id = "run_empty_block", .type = vayu::RunType::Scenario, .start_time = 2 });
    db_->update_run_summary ("run_empty_block", R"({"scenario":{}})");
    seed ({ .id = "run_block_not_object", .type = vayu::RunType::Scenario, .start_time = 3 });
    db_->update_run_summary ("run_block_not_object", R"({"scenario":[1,2]})");
    seed ({ .id = "run_bad_summary", .type = vayu::RunType::Scenario, .start_time = 4 });
    db_->update_run_summary ("run_bad_summary", "not valid json {{{");

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_EQ (row_of (body, "run_partial")["resultSummary"], (json{ { "passed", 2 } }));
    for (const char* id : { "run_empty_block", "run_block_not_object", "run_bad_summary" }) {
        EXPECT_FALSE (row_of (body, id).contains ("resultSummary")) << id;
    }
}

// A running collection run has no final summary, so its row carries none and the
// poll builds nothing until the status is terminal - the same cache rule a load
// row follows.
// Mutation check: drop the `is_terminal` half of `carries_result_summary` and
// the running row's build count fails.
TEST_F (RunsRouteTest, CollectionRowGetsNoResultSummaryUntilItsStatusIsTerminal) {
    seed ({ .id = "run_collecting",
    .type       = vayu::RunType::Scenario,
    .status     = vayu::RunStatus::Running,
    .start_time = 1 });
    db_->update_run_summary ("run_collecting", counted_scenario_summary (1, 0, 0, 0));

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (first_status, 200);
    EXPECT_FALSE (row_of (first, "run_collecting").contains ("resultSummary"));
    EXPECT_EQ (summaries_.outcome_build_count (), 0u);

    db_->transition_run_status (
    "run_collecting", { vayu::RunStatus::Running }, vayu::RunStatus::Completed);
    auto [second_status, second] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (second_status, 200);
    EXPECT_EQ (row_of (second, "run_collecting")["resultSummary"]["passed"], 1);
    EXPECT_EQ (summaries_.outcome_build_count (), 1u);
}

// The stop-before-worker race, for a collection run: Stopped with no summary
// must neither build nor cache, or the worker's own summary would never show.
// Mutation check: drop the non-empty gate and the first poll's build count and
// the last poll's key fail.
TEST_F (RunsRouteTest, StoppedCollectionRowWithoutSummaryIsNotCachedBeforeTheWorkerWritesOne) {
    seed ({ .id = "run_early_halt",
    .type       = vayu::RunType::Scenario,
    .status     = vayu::RunStatus::Stopped });

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (first_status, 200);
    EXPECT_FALSE (row_of (first, "run_early_halt").contains ("resultSummary"));
    EXPECT_EQ (summaries_.outcome_build_count (), 0u);

    db_->update_run_summary ("run_early_halt", counted_scenario_summary (2, 1, 0, 0));
    auto [second_status, second] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (second_status, 200);
    EXPECT_EQ (row_of (second, "run_early_halt")["resultSummary"]["failed"], 1);
    EXPECT_EQ (summaries_.outcome_build_count (), 1u);
}

// A terminal collection run's summary is final, so the poll parses it once.
// Mutation check: bypass `outcome_for` for a Scenario run and the second poll's
// build count grows.
TEST_F (RunsRouteTest, RepeatedPollsParseEachCollectionSummaryOnce) {
    for (const char* id : { "run_c1", "run_c2" }) {
        seed ({ .id = id, .type = vayu::RunType::Scenario });
        db_->update_run_summary (id, counted_scenario_summary (1, 1, 1, 1));
    }

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (first_status, 200);
    EXPECT_EQ (summaries_.outcome_build_count (), 2u);

    auto [second_status, second] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (second_status, 200);
    EXPECT_EQ (summaries_.outcome_build_count (), 2u);
    EXPECT_EQ (second["data"], first["data"]);
}

// A scenario *load* run is a Load row: its summary carries a `scenario` block
// too, but the row keeps the load shape and never takes the collection counts.
// Mutation check: build the collection shape for every run type and this row
// loses its `rps`.
TEST_F (RunsRouteTest, ScenarioLoadRowKeepsTheLoadShapeNotTheCollectionCounts) {
    auto stored        = nlohmann::json::parse (judged_summary (true));
    stored["scenario"] = { { "iterations", 4 }, { "passed", 9 },
        { "failed", 1 }, { "skipped", 0 }, { "errored", 0 } };
    seed ({ .id = "run_scenario_load", .start_time = 1 });
    db_->update_run_summary ("run_scenario_load", stored.dump ());

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    const auto outcome = row_of (body, "run_scenario_load")["resultSummary"];
    EXPECT_TRUE (outcome.contains ("rps"));
    for (const char* key : { "passed", "failed", "skipped", "errored" }) {
        EXPECT_FALSE (outcome.contains (key)) << key;
    }
}

// ============================================================================
// origin (#1817): who started the run
// ============================================================================

TEST_F (RunsRouteTest, ListRowsAndTheSingleRunPayloadCarryTheOrigin) {
    seed ({ .id = "agent", .start_time = 200, .origin = "mcp", .origin_client = "Claude Code" });
    seed ({ .id = "plain", .start_time = 100 });

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 2u);
    EXPECT_EQ (body["data"][0]["origin"],
    (json{ { "kind", "mcp" }, { "client", "Claude Code" } }));
    EXPECT_EQ (body["data"][1]["origin"],
    (json{ { "kind", "other" }, { "client", nullptr } }));

    const auto agent = db_->get_run ("agent");
    ASSERT_HAS_VALUE (agent);
    EXPECT_EQ (vayu::json::serialize (*agent)["origin"],
    (json{ { "kind", "mcp" }, { "client", "Claude Code" } }));
    const auto plain = db_->get_run ("plain");
    ASSERT_HAS_VALUE (plain);
    EXPECT_EQ (vayu::json::serialize (*plain)["origin"],
    (json{ { "kind", "other" }, { "client", nullptr } }));
}

// The baseline PUT answers a list row, so the origin travels with it too.
TEST_F (RunsRouteTest, BaselinePutAnswersTheRowWithItsOrigin) {
    seed ({ .id = "agent", .start_time = 100, .origin = "mcp", .origin_client = "cursor" });

    auto [status, body] = vayu::http::routes::set_run_baseline_response (
    *db_, "agent", R"({"baseline":true})");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["origin"], (json{ { "kind", "mcp" }, { "client", "cursor" } }));
    // The pin is a whole-row write; it must not lose the columns it did not set.
    const auto stored = db_->get_run ("agent");
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->origin, "mcp");
    ASSERT_HAS_VALUE (stored->origin_client);
    EXPECT_EQ (*stored->origin_client, "cursor");
}

TEST_F (RunsRouteTest, FilterByOriginListsOnlyThatKindAndCountsAgree) {
    seed ({ .id = "mcp_new", .start_time = 400, .origin = "mcp", .origin_client = "cursor" });
    seed ({ .id = "app_run", .start_time = 300, .origin = "app" });
    seed ({ .id = "mcp_old", .start_time = 200, .origin = "mcp" });
    seed ({ .id = "other_run", .start_time = 100 });

    vayu::db::RunFilter agents;
    agents.origin = "mcp";
    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, agents, 1, 0, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "mcp_new");
    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 2);
    EXPECT_TRUE (body["pagination"]["hasMore"].get<bool> ());

    auto [next_status, next] =
    vayu::http::routes::get_runs_response (*db_, agents, 1, 1, summaries_);
    ASSERT_EQ (next_status, 200);
    ASSERT_EQ (next["data"].size (), 1u);
    EXPECT_EQ (next["data"][0]["id"], "mcp_old");
    EXPECT_FALSE (next["pagination"]["hasMore"].get<bool> ());
    EXPECT_EQ (db_->count_runs (agents), 2);

    vayu::db::RunFilter others;
    others.origin         = "other";
    const auto other_rows = db_->get_runs_paginated (others, 50, 0);
    ASSERT_EQ (other_rows.size (), 1u);
    EXPECT_EQ (other_rows[0].id, "other_run");
}

// Same convention as `type`, `status` and `baseline`: a value the route does
// not know leaves the filter unset - a wider list, never a 400.
TEST (RunFilterFromQuery, OriginIsReadOnlyForADeclaredKind) {
    for (const auto kind : vayu::http::routes::RUN_ORIGIN_KINDS) {
        httplib::Request req;
        req.params.emplace ("origin", std::string (kind));
        const auto filter = vayu::http::routes::run_filter_from_query (req);
        ASSERT_HAS_VALUE (filter.origin) << kind;
        EXPECT_EQ (*filter.origin, kind);
    }
    for (const char* unknown : { "browser", "MCP", "" }) {
        httplib::Request req;
        req.params.emplace ("origin", unknown);
        EXPECT_FALSE (vayu::http::routes::run_filter_from_query (req).origin.has_value ())
        << "'" << unknown << "'";
    }
    EXPECT_FALSE (
    vayu::http::routes::run_filter_from_query (httplib::Request{}).origin.has_value ());
}

// ---------------------------------------------------------------------------
// GET /runs?outcome= - the stored verdict a row draws (#3547)
// ---------------------------------------------------------------------------

// Same convention as `type`, `status` and `origin`: a value the route does not
// know leaves the filter unset - a wider list, never a 400. Mutation check:
// drop the `outcome` read in `run_filter_from_query` and the first loop fails.
TEST (RunFilterFromQuery, OutcomeIsReadOnlyForAKnownVerdict) {
    for (const auto outcome : { vayu::RunOutcome::Passed,
         vayu::RunOutcome::Failed, vayu::RunOutcome::NotJudged }) {
        httplib::Request req;
        req.params.emplace ("outcome", vayu::to_string (outcome));
        const auto filter = vayu::http::routes::run_filter_from_query (req);
        ASSERT_HAS_VALUE (filter.outcome) << vayu::to_string (outcome);
        EXPECT_EQ (*filter.outcome, outcome);
    }
    for (const char* unknown : { "not-judged", "FAILED", "passing", "" }) {
        httplib::Request req;
        req.params.emplace ("outcome", unknown);
        EXPECT_FALSE (vayu::http::routes::run_filter_from_query (req).outcome.has_value ())
        << "'" << unknown << "'";
    }
    EXPECT_FALSE (
    vayu::http::routes::run_filter_from_query (httplib::Request{}).outcome.has_value ());
}

// `outcome=failed` answers what the renderer draws failed: a `completed` run
// with a missed budget among them, which its status alone never shows, and a
// run that failed with no summary or of no summarised type (#3643), not the
// clean run beside it nor a row with no verdict. Each row carries its
// `outcome`, and a row with none carries no key. Mutation checks: drop the
// `outcome` member from `serialize_run_row` and the row assertions fail;
// drop the `outcome` term from `run_filter_condition` and every row is listed.
TEST_F (RunsRouteTest, OutcomeFilterListsTheRunsTheRendererDrawsFailed) {
    seed ({ .id = "run_missed", .start_time = 4 });
    db_->update_run_summary ("run_missed", judged_summary (false));
    seed ({ .id = "run_clean", .start_time = 3 });
    db_->update_run_summary ("run_clean",
    R"({"rps":5,"status_codes":{"200":10},"thresholds":{"checks":[{"metric":"latencyP99Ms","passed":true}],"passed":1,"failed":0}})");
    seed ({ .id = "run_halted", .status = vayu::RunStatus::Failed, .start_time = 2 });
    db_->update_run_summary ("run_halted", R"({"rps":5,"status_codes":{"200":10}})");
    // Failed the way the engine fails them: a move from Running, no summary.
    seed ({ .id = "run_unsummarised", .status = vayu::RunStatus::Running, .start_time = 1 });
    seed ({ .id = "run_design_failed",
    .type       = vayu::RunType::Design,
    .status     = vayu::RunStatus::Running,
    .start_time = 0 });
    for (const char* id : { "run_unsummarised", "run_design_failed" }) {
        db_->transition_run_status (id, { vayu::RunStatus::Running }, vayu::RunStatus::Failed);
    }
    seed ({ .id = "run_design", .type = vayu::RunType::Design, .start_time = -1 });

    httplib::Request req;
    req.params.emplace ("outcome", "failed");
    auto [status, body] = vayu::http::routes::get_runs_response (
    *db_, vayu::http::routes::run_filter_from_query (req), 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 4u) << body.dump ();
    EXPECT_EQ (body["data"][0]["id"], "run_missed");
    EXPECT_EQ (body["data"][0]["status"], "completed");
    EXPECT_EQ (body["data"][0]["outcome"], "failed");
    EXPECT_EQ (body["data"][1]["id"], "run_halted");
    EXPECT_EQ (body["data"][2]["id"], "run_unsummarised");
    EXPECT_EQ (body["data"][2]["outcome"], "failed");
    EXPECT_EQ (body["data"][3]["id"], "run_design_failed");
    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 4);

    vayu::db::RunFilter passed;
    passed.outcome = vayu::RunOutcome::Passed;
    auto [_, passed_body] =
    vayu::http::routes::get_runs_response (*db_, passed, 50, 0, summaries_);
    ASSERT_EQ (passed_body["data"].size (), 1u);
    EXPECT_EQ (passed_body["data"][0]["id"], "run_clean");

    auto [all_status, all] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (all_status, 200);
    EXPECT_EQ (row_of (all, "run_clean")["outcome"], "passed");
    EXPECT_FALSE (row_of (all, "run_design").contains ("outcome"))
    << "a design run that completed has no verdict";
}

// The outcome filter composes with the others as one more `AND` term: each
// of the two filters alone lists a row the pair leaves out.
TEST_F (RunsRouteTest, OutcomeFilterCombinesWithStatus) {
    seed ({ .id = "run_clean", .start_time = 2 });
    db_->update_run_summary ("run_clean",
    R"({"rps":5,"status_codes":{"200":10},"thresholds":{"checks":[{"metric":"latencyP99Ms","passed":true}],"passed":1,"failed":0}})");
    seed ({ .id = "run_missed", .start_time = 1 });
    db_->update_run_summary ("run_missed", judged_summary (false));
    seed ({ .id = "run_halted", .status = vayu::RunStatus::Failed, .start_time = 0 });
    db_->update_run_summary ("run_halted", R"({"rps":5,"status_codes":{"200":10}})");

    httplib::Request req;
    req.params.emplace ("outcome", "failed");
    req.params.emplace ("status", "completed");
    auto [status, body] = vayu::http::routes::get_runs_response (
    *db_, vayu::http::routes::run_filter_from_query (req), 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_missed");
}

// PUT /runs/:id/baseline answers the same row, so it carries the outcome too.
TEST_F (RunsRouteTest, BaselinePutAnswersTheRowWithItsOutcome) {
    seed ({ .id = "run_missed" });
    db_->update_run_summary ("run_missed", judged_summary (false));
    auto [status, body] = vayu::http::routes::set_run_baseline_response (
    *db_, "run_missed", R"({"baseline":true})");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["outcome"], "failed");
}

} // namespace
