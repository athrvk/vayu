/**
 * @file tests/run_manager_summary_test.cpp
 * @brief The run summary a run stores: the response-sample budget marker, the failed-run summary
 * inputs, the assertion populations, and the terminal status a finished run reaches.
 */

#include "optional_assert.hpp"
#include "vayu/core/run_manager.hpp"
#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <thread>

#include "mock_server.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/platform/platform.hpp"
#include "wait_until.hpp"

using namespace vayu::core;

// The wiring nobody else covers: what a collector counted has to reach the
// stored summary. A field the collector grows and `read_retention` forgets
// reports as zero-or-false forever, which is this repo's most repeated defect -
// so the two cases the byte-budget marker (issue #1192) exists to separate are
// checked through the function that carries it, not off the collector alone.
// Drop the assignment in read_retention and the first half reddens.
TEST (ReadRetention, CarriesTheResponseSampleBudgetMarkerWhetherOrNotItWasSpent) {
    MetricsCollectorConfig tight;
    tight.expected_requests         = 100;
    tight.response_sample_rate      = 1;
    tight.max_response_samples      = 1000;
    tight.max_response_sample_bytes = 250;
    MetricsCollector spent ("run_read_retention_spent", tight);

    vayu::Response response;
    response.status_code     = 200;
    response.body            = std::string (100, 'x');
    response.timing.total_ms = 1.0;
    for (int i = 0; i < 10; ++i) {
        spent.record_response_sample (response);
    }

    RunSummaryInputs inputs;
    inputs.retention = read_retention (spent);
    EXPECT_TRUE (inputs.retention.response_sample_budget_spent);
    EXPECT_GT (inputs.retention.response_samples_dropped, 0u);
    EXPECT_TRUE (build_run_summary_payload (
    inputs)["sampling"]["response_sample_budget_spent"]
    .get<bool> ());

    MetricsCollectorConfig roomy;
    roomy.expected_requests         = 100;
    roomy.response_sample_rate      = 1;
    roomy.max_response_samples      = 2;
    roomy.max_response_sample_bytes = 1'000'000;
    MetricsCollector displaced ("run_read_retention_uniform", roomy);
    for (int i = 0; i < 10; ++i) {
        displaced.record_response_sample (response);
    }

    RunSummaryInputs uniform;
    uniform.retention = read_retention (displaced);
    EXPECT_GT (uniform.retention.response_samples_dropped, 0u)
    << "the count cap has to have displaced something for the two to differ";
    EXPECT_FALSE (uniform.retention.response_sample_budget_spent);
    EXPECT_FALSE (build_run_summary_payload (
    uniform)["sampling"]["response_sample_budget_spent"]
    .get<bool> ());
}

// #2399: a load run that throws still stores a summary, built by its own
// producer. The exact slow count has to ride that one too, or a crashed run's
// report falls back to counting the capped traces. Mutation check: drop either
// slow assignment in failed_run_summary_inputs and this reds.
TEST (FailedRunSummaryInputs, CarriesTheExactSlowCountAndItsThreshold) {
    RunContext ctx ("run_failed_slow",
    nlohmann::json{ { "slow_threshold_ms", 100 }, { "max_slow_results", 2 } });
    for (int i = 0; i < 5; ++i) {
        ctx.metrics_collector->record_success (
        200, 900.0, 0.0, "{}", SuccessTraceReason::Slow);
    }

    const auto inputs = failed_run_summary_inputs (ctx);
    EXPECT_EQ (inputs.slow_total, 5u);
    EXPECT_EQ (inputs.slow_threshold_ms, 100);
    const auto summary = build_run_summary_payload (inputs);
    ASSERT_TRUE (summary.contains ("slow_requests")) << summary.dump ();
    EXPECT_EQ (summary["slow_requests"]["count"].get<size_t> (), 5u);
    EXPECT_EQ (summary["slow_requests"]["thresholdMs"].get<int> (), 100);
}

// #2400: the per-type error counts ride the crashed run's summary too, past the
// error store's cap, or its report counts the stored records instead. Mutation
// check: drop the error_types assignment in failed_run_summary_inputs and this
// reds at an empty object.
TEST (FailedRunSummaryInputs, CarriesTheExactErrorTypesPastTheStoreCap) {
    RunContext ctx ("run_failed_types", nlohmann::json::object (), /*max_errors=*/2);
    for (int i = 0; i < 7; ++i) {
        ctx.metrics_collector->record_error (vayu::ErrorCode::Timeout, "slow");
    }
    ctx.metrics_collector->record_error (vayu::ErrorCode::DnsError, "nx");
    ASSERT_EQ (ctx.metrics_collector->errors_dropped (), 6u);

    const auto summary = build_run_summary_payload (failed_run_summary_inputs (ctx));
    EXPECT_EQ (summary["error_types"],
    (nlohmann::json{ { "dns_failed", 1 }, { "timeout", 7 } }))
    << summary.dump ();
}

// A run that recorded no error still writes the key, so a reader can tell it
// from a summary stored before the counts existed; `error_classes` (#3828)
// follows the same rule.
TEST (FailedRunSummaryInputs, ARunWithNoErrorWritesAnEmptyErrorTypesObject) {
    RunContext ctx ("run_failed_clean", nlohmann::json::object ());
    const auto summary = build_run_summary_payload (failed_run_summary_inputs (ctx));
    ASSERT_TRUE (summary.contains ("error_types")) << summary.dump ();
    EXPECT_EQ (summary["error_types"], nlohmann::json::object ());
    ASSERT_TRUE (summary.contains ("error_classes")) << summary.dump ();
    EXPECT_EQ (summary["error_classes"], nlohmann::json::object ());
}

// #3828: a failed run's summary carries the classes its collector counted.
// Mutation check: drop the error_classes assignment in
// failed_run_summary_inputs and this reds at an empty object.
TEST (FailedRunSummaryInputs, CarriesTheFailedRepliesByClass) {
    RunContext ctx ("run_failed_classes", nlohmann::json::object ());
    ctx.metrics_collector->record_mcp_failure (vayu::McpErrorClass::Protocol, -32601);
    ctx.metrics_collector->record_mcp_failure (vayu::McpErrorClass::Tool, std::nullopt);
    const auto summary = build_run_summary_payload (failed_run_summary_inputs (ctx));
    EXPECT_EQ (summary["error_classes"],
    nlohmann::json::parse (R"({"protocol":1,"tool":1,"protocolCodes":{"-32601":1}})"))
    << summary.dump ();
}

// A failed run timed no drain apart, so its window is the whole run and every
// completion is inside it (#2882), never a 0 that reads as "nothing answered
// while sending". Mutation check: drop the assignment in
// `failed_run_summary_inputs` and this reads 0.
TEST (FailedRunSummaryInputs, CountsEveryCompletionAsCompletedWhileSending) {
    RunContext ctx ("run_failed_window", nlohmann::json::object ());
    for (int i = 0; i < 3; ++i) {
        ctx.metrics_collector->record_success (200, 10.0, 0.0, "{}");
    }
    const auto summary = build_run_summary_payload (failed_run_summary_inputs (ctx));
    EXPECT_EQ (summary.at ("total_requests").get<size_t> (), 3u) << summary.dump ();
    EXPECT_EQ (summary.at ("completed_while_sending").get<size_t> (), 3u)
    << summary.dump ();
}

// A threshold of 0 measured nothing, so the summary says nothing rather than
// a 0 a reader would take for "no outliers".
TEST (FailedRunSummaryInputs, AZeroThresholdKeepsTheSlowSectionOut) {
    RunContext ctx (
    "run_failed_no_threshold", nlohmann::json{ { "slow_threshold_ms", 0 } });
    EXPECT_FALSE (
    build_run_summary_payload (failed_run_summary_inputs (ctx)).contains ("slow_requests"));
}

// ============================================================================
// The summary's `assertions` block (issue #3537)
// ============================================================================

/// An element report row with @p error executions that ended in error.
nlohmann::json element_row_with_errors (const char* kind, size_t error) {
    return { { "kind", kind }, { "passed", 1 }, { "failed", 0 }, { "missing", 0 },
        { "error", error }, { "skipped", 0 }, { "deferred", 0 } };
}

// Both populations as the budget judged them, beside the zeros of a run whose
// scripts and teardown all ran. Mutation check: drop the `assertions` write in
// `build_run_summary_payload` and the key is missing.
TEST (RunSummaryAssertions, StoresBothPopulationsAsTheBudgetJudgedThem) {
    RunSummaryInputs inputs;
    inputs.assertions = AssertionPopulations{ .exact = { .passed = 3, .failed = 1 },
        .sampled = { .passed = 5, .failed = 2 } };
    const auto summary = build_run_summary_payload (inputs);
    EXPECT_EQ (summary.value ("assertions", nlohmann::json ()),
    (nlohmann::json{ { "exact", { { "passed", 3 }, { "failed", 1 } } },
    { "sampled", { { "passed", 5 }, { "failed", 2 } } }, { "errored", 0 },
    { "teardownFailed", 0 } }))
    << summary.dump ();
}

// A single-request run's errored element executions are its `elements` rows'
// `error`, and a run that asserted nothing still stores the block for them.
// Mutation check: return 0 from `errored_element_runs` and `errored` reads 0
// and the block is absent.
TEST (RunSummaryAssertions, CountsASingleRequestRunsErroredElements) {
    RunSummaryInputs inputs;
    inputs.elements =
    nlohmann::json::array ({ element_row_with_errors ("script.post", 3),
    element_row_with_errors ("extract.json", 4), nlohmann::json ("not a row") });
    const auto summary = build_run_summary_payload (inputs);
    ASSERT_TRUE (summary.contains ("assertions")) << summary.dump ();
    EXPECT_EQ (summary["assertions"]["errored"], 7);
    EXPECT_EQ (summary["assertions"]["exact"],
    (nlohmann::json{ { "passed", 0 }, { "failed", 0 } }));
}

// A scenario load run's are its steps' element rows, never `scenario.errored`,
// which also counts a step that got no response. Mutation check: read
// `scenario.errored` instead and `errored` reads 10.
TEST (RunSummaryAssertions, CountsAScenarioRunsErroredStepElementsAndNotItsNoResponses) {
    RunSummaryInputs inputs;
    inputs.scenario    = nlohmann::json{ { "errored", 10 },
        { "steps",
        nlohmann::json::array (
        { { { "elements", nlohmann::json::array ({ element_row_with_errors ("script.post", 2) }) } },
        { { "elements",
        nlohmann::json::array ({ element_row_with_errors ("assert.status", 1),
        element_row_with_errors ("script.pre", 0) }) } },
        { { "name", "a step with no elements" } } }) } };
    const auto summary = build_run_summary_payload (inputs);
    ASSERT_TRUE (summary.contains ("assertions")) << summary.dump ();
    EXPECT_EQ (summary["assertions"]["errored"], 3);
}

// A teardown script that failed a `pm.test` or threw is counted; setup's rows
// are not, since a failed setup already fails the run. Mutation check: count
// only `failed` outcomes in `failed_teardowns` and this reads 1.
TEST (RunSummaryAssertions, CountsTheTeardownsThatFailedOrErrored) {
    RunSummaryInputs inputs;
    inputs.lifecycle =
    nlohmann::json{ { "setup", nlohmann::json::array ({ { { "outcome", "failed" } } }) },
        { "teardown",
        nlohmann::json::array ({ { { "outcome", "failed" } }, { { "outcome", "error" } },
        { { "outcome", "ok" } }, { { "outcome", 5 } } }) } };
    const auto summary = build_run_summary_payload (inputs);
    ASSERT_TRUE (summary.contains ("assertions")) << summary.dump ();
    EXPECT_EQ (summary["assertions"]["teardownFailed"], 2);
    EXPECT_EQ (summary["assertions"]["errored"], 0);
}

// A run that asserted nothing and errored nowhere stores no block, never one
// of zeros, and neither does a failed run's summary, which knows neither.
// Mutation check: drop the early return in `build_run_assertions_payload` and
// each expectation fails.
TEST (RunSummaryAssertions, IsAbsentWhenNothingAssertedOrErrored) {
    EXPECT_FALSE (build_run_summary_payload (RunSummaryInputs{}).contains ("assertions"));

    RunSummaryInputs clean;
    clean.elements =
    nlohmann::json::array ({ element_row_with_errors ("timer.think", 0) });
    clean.lifecycle =
    nlohmann::json{ { "teardown", nlohmann::json::array ({ { { "outcome", "ok" } } }) } };
    EXPECT_FALSE (build_run_summary_payload (clean).contains ("assertions"));

    RunContext ctx ("run_failed_unasserted", nlohmann::json::object ());
    EXPECT_FALSE (
    build_run_summary_payload (failed_run_summary_inputs (ctx)).contains ("assertions"));
}

// ============================================================================
// finish_load_test's terminal-status decision (issue #1497). `finish_load_test`
// itself is not declared in run_manager.hpp, so this drives it the only way a
// test can: a real run, end to end through RunManager::start_run exactly as
// the route does, the way run_stop_test.cpp's StoppedRunReachesTerminalStatus-
// Promptly drives the stop path. The issue's own Tests section asked for this
// case by name: "run_manager test: failRun: true with a failed budget stores
// Failed."
// ============================================================================

struct FailRunCase {
    const char* name;
    const char* run_id;
    /// `true` sets `thresholds.failRun`; `false` leaves the key absent, the
    /// shape a run that never opted in sends.
    bool fail_run;
    vayu::RunStatus expected_status;
};

// Mutation check: comment out the `final_status = vayu::RunStatus::Failed`
// assignment in `finish_load_test` and the first case reddens to Completed.
// The second is its companion: without `failRun`, the same missed budget is
// still reported (this run's `thresholdValidation.verdict` is "failed",
// asserted at the unit level in threshold_eval_test.cpp) but the terminal
// status is untouched - the pre-existing history semantics nobody who did not
// opt in should see change.
constexpr auto FAIL_RUN_CASES = std::to_array<FailRunCase> ({
{ "AFailedAssertionBudgetWithFailRunEndsTheRunFailed", "run-fail-run-e2e", true,
vayu::RunStatus::Failed },
{ "TheSameMissedBudgetWithoutFailRunStaysCompleted", "run-fail-run-optout-e2e",
false, vayu::RunStatus::Completed },
});

/// A real load run against a local mock, driven to its terminal row.
class LoadRunToTerminalTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_run_manager_fail_run.db";

    void SetUp () override {
        vayu::http::global_init ();
        server = std::make_unique<vayu::tests::SlowMockServer> ();
        vayu::tests::remove_database_files (DB_PATH);
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }
    void TearDown () override {
        db.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        server.reset ();
        vayu::http::global_cleanup ();
    }

    /// Create the row `start_run` expects to already exist (the route's own
    /// job), then drive the run to completion and hand back its stored row.
    /// Waits well past a healthy run's own duration on purpose: a slow-but-
    /// finishing run fails the caller's assertions, not this wait.
    std::optional<vayu::db::Run> run_to_terminal_row (const std::string& run_id,
    const nlohmann::json& config) {
        vayu::db::Run row;
        row.id              = run_id;
        row.type            = vayu::RunType::Load;
        row.status          = vayu::RunStatus::Pending;
        row.config_snapshot = "{}";
        row.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        row.end_time = 0;
        db->create_run (row);

        vayu::core::RunManager manager;
        manager.start_run (run_id, config, *db);

        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (20);
        while (manager.get_run (run_id) != nullptr &&
        std::chrono::steady_clock::now () < deadline) {
            std::this_thread::sleep_for (std::chrono::milliseconds (20));
        }
        if (manager.get_run (run_id) != nullptr) {
            ADD_FAILURE () << "the run never reached a terminal status";
            return std::nullopt;
        }

        auto stored = db->get_run (run_id);
        if (!stored.has_value ()) {
            ADD_FAILURE () << "the finished run left no row behind";
        }
        return stored;
    }

    std::unique_ptr<vayu::tests::SlowMockServer> server;
    std::unique_ptr<vayu::db::Database> db;
};

class FailRunTest : public LoadRunToTerminalTest,
                    public ::testing::WithParamInterface<FailRunCase> {
    protected:
    std::optional<vayu::RunStatus> run_to_terminal_status (const std::string& run_id,
    const nlohmann::json& config) {
        auto row = run_to_terminal_row (run_id, config);
        if (!row.has_value ()) {
            return std::nullopt;
        }
        return row->status;
    }

    nlohmann::json base_config () const {
        return { { "mode", "iterations" }, { "iterations", 3 }, { "concurrency", 1 },
            { "url", server->fast_url () }, { "method", "GET" }, { "workers", 1 },
            { "tests", "pm.test('always fails', function () { pm.expect(1).to.equal(2); });" } };
    }
};

TEST_P (FailRunTest, EndsWithTheExpectedTerminalStatus) {
    const auto& c        = GetParam ();
    auto config          = base_config ();
    config["thresholds"] = { { "maxAssertionFailureRatePct", 0 } };
    if (c.fail_run) {
        config["thresholds"]["failRun"] = true;
    }

    auto status = run_to_terminal_status (c.run_id, config);
    ASSERT_HAS_VALUE (status);
    EXPECT_EQ (*status, c.expected_status);
}

INSTANTIATE_TEST_SUITE_P (FailRun,
FailRunTest,
::testing::ValuesIn (FAIL_RUN_CASES),
[] (const ::testing::TestParamInfo<FailRunCase>& info) {
    return std::string (info.param.name);
});

// #3340: a finished run's end_time is the stamp the worker writes before its
// cleanup, not the moment of its terminal status write. A `script.teardown`
// holding the worker for TEARDOWN_MS runs between the two, so a healthy row
// ends at least that long before the run is seen finished; a re-stamp at the
// status write lands within a poll of it. Mutation check: have `end_time_after`
// (db_runs.cpp) stamp now on every terminal move and the bound fails by about
// TEARDOWN_MS.
TEST_F (LoadRunToTerminalTest, AFinishedRunEndsAtItsPreCleanupStamp) {
    constexpr int64_t TEARDOWN_MS     = 1000;
    const std::string teardown_script = "const until = Date.now () + " +
    std::to_string (TEARDOWN_MS) + "; while (Date.now () < until) {}";
    const nlohmann::json config = { { "mode", "iterations" },
        { "iterations", 2 }, { "concurrency", 1 },
        { "url", server->fast_url () }, { "method", "GET" }, { "workers", 1 },
        { "lifecycleElements",
        nlohmann::json::array ({ { { "id", "el_teardown" }, { "kind", "script.teardown" },
        { "enabled", true }, { "config", { { "script", teardown_script } } } } }) } };

    const auto row = run_to_terminal_row ("run-end-stamp-e2e", config);
    const int64_t seen_finished = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                                  .count ();
    ASSERT_HAS_VALUE (row);
    EXPECT_EQ (row->status, vayu::RunStatus::Completed) << row->summary;
    EXPECT_GT (row->end_time, row->start_time);
    EXPECT_LE (row->end_time + TEARDOWN_MS, seen_finished)
    << "end_time was stamped after the teardown, at the terminal write";
}

// #2892 end to end: an `assert.status` that holds on all 4 completions is the
// exact population, and a deferred `pm.test` that always fails, replayed over
// 1 in 2 responses, is the sampled one. Judged on the worse rate, 100%; the
// old blend read 2 of 10. Mutation checks: pass `validation.run` into
// `.exact` in `assertion_populations` (run_manager.cpp) and every key below
// reds; double the passed counter in `exact_assertion_totals`, the double
// count adding the element tallies made, and `assertionsExact` reads 8.
TEST_F (LoadRunToTerminalTest, AMixedAssertionRunStoresBothPopulations) {
    const nlohmann::json config = { { "mode", "iterations" },
        { "iterations", 4 }, { "concurrency", 1 }, { "url", server->fast_url () },
        { "method", "GET" }, { "workers", 1 }, { "response_sample_rate", 2 },
        { "requestElements",
        nlohmann::json::array (
        { nlohmann::json{ { "id", "el_status" }, { "kind", "assert.status" },
          { "config", { { "in", nlohmann::json::array ({ 200 }) } } } },
        nlohmann::json{ { "id", "el_post" }, { "kind", "script.post" },
        { "config", { { "script", "pm.test('always fails', function () { pm.expect(1).to.equal(2); });" } } } } }) },
        { "thresholds", { { "maxAssertionFailureRatePct", 50 } } } };

    const auto row = run_to_terminal_row ("run-assert-pops-e2e", config);
    ASSERT_HAS_VALUE (row);
    const auto summary = nlohmann::json::parse (row->summary);
    ASSERT_TRUE (summary.contains ("thresholds")) << summary.dump ();
    const auto& check = summary["thresholds"]["checks"][0];
    EXPECT_EQ (check.value ("assertionsExact", nlohmann::json ()),
    (nlohmann::json{ { "passed", 4 }, { "failed", 0 } }))
    << check.dump ();
    EXPECT_EQ (check.value ("assertionsSampled", nlohmann::json ()),
    (nlohmann::json{ { "passed", 0 }, { "failed", 2 } }))
    << check.dump ();
    EXPECT_EQ (check.value ("sampleRate", 0), 2);
    EXPECT_DOUBLE_EQ (check["actual"].get<double> (), 100.0);
    EXPECT_FALSE (check["passed"].get<bool> ());
}

// #3043 on a single-request run: an `assert.status` with no operand (the
// route refuses it; `start_run` is reached here without that check) is a
// failed assertion on every completion, in the exact population. Mutation
// check: put the bare `outcome_status = "error"` back in
// `AssertStatusElement::apply` and the summary has no thresholds verdict.
TEST_F (LoadRunToTerminalTest, AnAssertionThatCannotRunIsInTheExactPopulation) {
    const nlohmann::json config = { { "mode", "iterations" },
        { "iterations", 4 }, { "concurrency", 1 },
        { "url", server->fast_url () }, { "method", "GET" }, { "workers", 1 },
        { "requestElements",
        nlohmann::json::array ({ nlohmann::json{ { "id", "el_status" },
        { "kind", "assert.status" }, { "config", nlohmann::json::object () } } }) },
        { "thresholds", { { "maxAssertionFailureRatePct", 50 } } } };

    const auto row = run_to_terminal_row ("run-assert-cannot-run", config);
    ASSERT_HAS_VALUE (row);
    const auto summary = nlohmann::json::parse (row->summary);
    ASSERT_TRUE (summary.contains ("thresholds")) << summary.dump ();
    const auto& check = summary["thresholds"]["checks"][0];
    EXPECT_EQ (check.value ("assertionsExact", nlohmann::json ()),
    (nlohmann::json{ { "passed", 0 }, { "failed", 4 } }))
    << check.dump ();
    EXPECT_FALSE (check["passed"].get<bool> ());
}

// #3537 end to end: a required `extract.json` that misses on every completion
// is a failed assertion in the stored block's exact population, the count the
// budget's `assertionsExact` reports and the report's `assertions` serves.
// Mutation check: pass a default `AssertionPopulations` to the block in
// `build_run_assertions_payload` and its `exact` reads 0 failed.
TEST_F (LoadRunToTerminalTest, ARequiredExtractorMissIsTheBlocksAndTheBudgetsExactCount) {
    const nlohmann::json config = { { "mode", "iterations" },
        { "iterations", 4 }, { "concurrency", 1 },
        { "url", server->fast_url () }, { "method", "GET" }, { "workers", 1 },
        { "requestElements",
        nlohmann::json::array ({ nlohmann::json{ { "id", "el_tok" }, { "kind", "extract.json" },
        { "config", { { "path", "$.nope" }, { "variable", "tok" }, { "required", true } } } } }) },
        { "thresholds", { { "maxAssertionFailureRatePct", 0 } } } };

    const auto row = run_to_terminal_row ("run-required-miss-e2e", config);
    ASSERT_HAS_VALUE (row);
    const auto summary = nlohmann::json::parse (row->summary);
    ASSERT_TRUE (summary.contains ("thresholds")) << summary.dump ();
    const auto& budget_exact =
    summary["thresholds"]["checks"][0]["assertionsExact"];
    EXPECT_EQ (budget_exact, (nlohmann::json{ { "passed", 0 }, { "failed", 4 } }))
    << summary.dump ();
    ASSERT_TRUE (summary.contains ("assertions")) << summary.dump ();
    EXPECT_EQ (summary["assertions"]["exact"], budget_exact);

    const auto report =
    vayu::http::routes::run_report_response (*db, "run-required-miss-e2e").second;
    EXPECT_EQ (
    report.value ("assertions", nlohmann::json ()).value ("exact", nlohmann::json ()), budget_exact)
    << report.dump ();
}

// #3537 end to end: an inline script that throws on every completion is an
// errored element execution, and a teardown whose `pm.test` fails is a failed
// teardown, both stored in the block of a run that made no assertion. Mutation
// check: return 0 from `failed_teardowns` and `teardownFailed` reads 0.
TEST_F (LoadRunToTerminalTest, AThrownInlineScriptAndAFailedTeardownAreStored) {
    const nlohmann::json config = {
        { "mode", "iterations" }, { "iterations", 4 }, { "concurrency", 1 },
        { "url", server->fast_url () }, { "method", "GET" }, { "workers", 1 },
        { "requestElements",
        nlohmann::json::array ({ nlohmann::json{ { "id", "el_throw" }, { "kind", "script.post" },
        { "config", { { "script", "JSON.parse('not json');" }, { "inline", true } } } } }) },
        { "lifecycleElements",
        nlohmann::json::array (
        { { { "id", "el_teardown" }, { "kind", "script.teardown" }, { "enabled", true },
        { "config", { { "script", "pm.test('error rate ok', function () { pm.expect(1).to.equal(2); });" } } } } }) }
    };

    const auto row = run_to_terminal_row ("run-errored-e2e", config);
    ASSERT_HAS_VALUE (row);
    const auto summary = nlohmann::json::parse (row->summary);
    EXPECT_EQ (summary.value ("assertions", nlohmann::json ()),
    (nlohmann::json{ { "exact", { { "passed", 0 }, { "failed", 0 } } },
    { "sampled", { { "passed", 0 }, { "failed", 0 } } }, { "errored", 4 },
    { "teardownFailed", 1 } }))
    << summary.dump ();
}

// #2399, the completed-run producer end to end: every request to `/slow`
// (500ms) crosses a 100ms threshold - a lower bound, so a slow runner cannot
// fail it - and the slow store keeps 2 of the 4. The stored summary has to
// count all 4. Mutation check: drop the `slow_total` assignment in
// collect_summary_inputs and the count reds at 0.
TEST_F (LoadRunToTerminalTest, ACompletedRunStoresTheExactSlowCount) {
    const nlohmann::json config = { { "mode", "iterations" }, { "iterations", 4 },
        { "concurrency", 4 }, { "url", server->slow_url () }, { "method", "GET" },
        { "workers", 1 }, { "slow_threshold_ms", 100 }, { "max_slow_results", 2 } };

    const auto row = run_to_terminal_row ("run-slow-count-e2e", config);
    ASSERT_HAS_VALUE (row);
    EXPECT_EQ (row->status, vayu::RunStatus::Completed);
    const auto summary = nlohmann::json::parse (row->summary);
    ASSERT_TRUE (summary.contains ("slow_requests")) << summary.dump ();
    EXPECT_EQ (summary["slow_requests"]["count"].get<size_t> (), 4u);
    EXPECT_EQ (summary["slow_requests"]["thresholdMs"].get<int> (), 100);
    EXPECT_EQ (summary["sampling"]["slow_traces_dropped"].get<size_t> (), 2u);
}

// #2400, the same producer for the per-type error counts: every request to
// `/slow` (500ms) outlives a 100ms timeout - a lower bound again - and the
// error store keeps 2 of the 4. Mutation check: drop the `error_types`
// assignment in collect_summary_inputs and this reds at an empty object.
TEST_F (LoadRunToTerminalTest, ACompletedRunStoresTheExactErrorTypes) {
    auto cap = db->get_config_entry ("maxStoredErrors");
    ASSERT_HAS_VALUE (cap);
    cap->value = "2";
    db->save_config_entry (*cap);
    const nlohmann::json config = { { "mode", "iterations" },
        { "iterations", 4 }, { "concurrency", 4 }, { "url", server->slow_url () },
        { "method", "GET" }, { "workers", 1 }, { "timeout", 100 } };

    const auto row = run_to_terminal_row ("run-error-types-e2e", config);
    ASSERT_HAS_VALUE (row);
    const auto summary = nlohmann::json::parse (row->summary);
    EXPECT_EQ (summary["error_types"], (nlohmann::json{ { "timeout", 4 } }))
    << summary.dump ();
    EXPECT_EQ (summary["sampling"]["errors_dropped"].get<size_t> (), 2u);
}

// #2798: a load run that sets no `timeout` of its own sends with the
// `defaultTimeout` setting, as `POST /execute` does. Each case reads the stored
// `error_types`, so none depends on how fast the runner is. A `null` timeout
// never reaches the worker (the route erases it, #1893);
// run_config_validation_test.cpp drives that case through `POST /runs`.
class LoadRunTimeoutTest : public LoadRunToTerminalTest {
    protected:
    /// Through the row, not the route: the route's bounds are not the subject.
    void set_default_timeout (const char* ms) {
        auto entry = db->get_config_entry ("defaultTimeout");
        ASSERT_HAS_VALUE (entry);
        entry->value = ms;
        db->save_config_entry (*entry);
    }

    nlohmann::json two_requests_to (const std::string& url) const {
        return { { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 2 },
            { "url", url }, { "method", "GET" }, { "workers", 1 } };
    }

    void expect_timeouts (const std::optional<vayu::db::Run>& row, int count) {
        ASSERT_HAS_VALUE (row);
        const auto summary = nlohmann::json::parse (row->summary);
        EXPECT_EQ (summary["error_types"], (nlohmann::json{ { "timeout", count } }))
        << summary.dump ();
    }
};

// `/hang` never answers. At the setting's floor (1000) the run ends in about a
// second; one that ignores the setting waits the compiled-in 30s, past
// run_to_terminal_row's 20s wait, so it fails as a hang rather than on a clock.
// Mutation check: put `config.value ("timeout", 30000)` back in
// execute_load_test and this reds with "the run never reached a terminal status".
TEST_F (LoadRunTimeoutTest, ARunWithNoTimeoutUsesTheDefaultTimeoutSetting) {
    set_default_timeout ("1000");
    expect_timeouts (run_to_terminal_row ("run-default-timeout-e2e",
                     two_requests_to (server->hang_url ())),
    2);
}

// `/slow` answers in 500ms: inside the 3000ms setting, outside the run's own
// 100ms (a lower bound, so a slow runner cannot fail it). Mutation
// check: make the resolver return the setting first and this reds at `{}`.
TEST_F (LoadRunTimeoutTest, AnExplicitTimeoutBeatsTheSetting) {
    set_default_timeout ("3000");
    auto config       = two_requests_to (server->slow_url ());
    config["timeout"] = 100;
    expect_timeouts (run_to_terminal_row ("run-explicit-timeout-e2e", config), 2);
}

namespace {

/// The `think_timer_skipped_open_loop` entry of @p context's warnings, or a
/// null json.
nlohmann::json open_loop_timer_warning (const std::shared_ptr<RunContext>& context) {
    for (const auto& warning : build_run_warnings (context)) {
        if (warning["code"] == "think_timer_skipped_open_loop") {
            return warning;
        }
    }
    return nullptr;
}

/// A context carrying @p elements as its `requestElements`, with @p sent
/// requests counted as submitted and `closed_loop` as @p closed_loop.
std::shared_ptr<RunContext>
think_timer_context (const nlohmann::json& elements, size_t sent, bool closed_loop) {
    auto context = std::make_shared<RunContext> ("run-open-loop-timer",
    nlohmann::json{ { "mode", "constant_rps" }, { "requestElements", elements } });
    context->requests_sent = sent;
    context->closed_loop   = closed_loop;
    return context;
}

nlohmann::json think_element (const std::string& id, bool enabled) {
    return { { "id", id }, { "kind", "timer.think" }, { "enabled", enabled },
        { "config", { { "ms", 100 } } } };
}

} // namespace

// #3541: the warning counts the enabled timers an open-loop run that sent
// requests skipped, and nothing else does: a closed loop keeps its timers, and
// a run that sent nothing never reached the pacer that skips them. Mutation
// check: drop the `requests_sent` guard in `open_loop_skipped_timers` and the
// unsent case warns.
TEST (OpenLoopTimerWarning, CountsTheEnabledTimersAnOpenLoopRunSkipped) {
    const auto elements = nlohmann::json::array ({ think_element ("t1", true),
    think_element ("t2", true), think_element ("t3", false),
    nlohmann::json{ { "id", "a1" }, { "kind", "assert.status" },
    { "config", { { "in", nlohmann::json::array ({ 200 }) } } } } });

    const auto warning =
    open_loop_timer_warning (think_timer_context (elements, 1, false));
    ASSERT_TRUE (warning.is_object ());
    EXPECT_EQ (warning["timers"], 2);
    EXPECT_EQ (warning["message"].get<std::string> (), RunContext::OPEN_LOOP_TIMER_SKIP_REASON);

    EXPECT_TRUE (
    open_loop_timer_warning (think_timer_context (elements, 1, true)).is_null ())
    << "a closed-loop run keeps its timers";
    EXPECT_TRUE (
    open_loop_timer_warning (think_timer_context (elements, 0, false)).is_null ())
    << "a run that sent nothing skipped nothing";
    EXPECT_TRUE (open_loop_timer_warning (
    think_timer_context (nlohmann::json::array ({ think_element ("t1", false) }), 1, false))
    .is_null ())
    << "a disabled timer is the pipeline's skip, not the pacer's";
}
