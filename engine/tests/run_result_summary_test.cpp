/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_result_summary_test.cpp
 * @brief The verdict a `GET /runs` row draws and `runs.outcome` stores
 *        (#3547): `judge_run_row` against the row-shaped conformance table,
 *        and `stored_run_outcome` from a stored summary through the row's
 *        own `resultSummary`.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/run_result_summary.hpp"
#include "vayu/types.hpp"

namespace {

using json = nlohmann::json;
using vayu::RunOutcome;
using vayu::RunStatus;
using vayu::RunType;
using vayu::core::judge_run_row;
using vayu::core::stored_run_outcome;

/// `engine/tests/fixtures/run-row-outcome-conformance.json` (#3547), written
/// from the app's `rowOutcome`.
json load_row_outcome_fixture () {
    const auto path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "tests" /
    "fixtures" / "run-row-outcome-conformance.json";
    std::ifstream in (path);
    if (!in.good ()) {
        ADD_FAILURE () << "fixture missing: " << path;
        return json::object ();
    }
    return json::parse (in);
}

json outcome_json (const std::optional<RunOutcome>& outcome) {
    return outcome ? json (vayu::to_string (*outcome)) : json (nullptr);
}

/// Mutation check: swap the drain-cut and missed-budget checks in
/// `judge_load_row`, or return `Passed` from `judge_collection_row` for a clean
/// row, and the cases that reach them fail.
TEST (RunRowOutcomeConformance, EveryRowJudgesAsTheAppDrawsIt) {
    const json fixture = load_row_outcome_fixture ();
    ASSERT_TRUE (fixture.contains ("cases"));
    ASSERT_FALSE (fixture.at ("cases").empty ());
    for (const json& c : fixture.at ("cases")) {
        const std::string name = c.at ("name").get<std::string> ();
        const auto type = vayu::parse_run_type (c.at ("type").get<std::string> ());
        const auto status = vayu::parse_run_status (c.at ("status").get<std::string> ());
        ASSERT_HAS_VALUE (type) << name;
        ASSERT_HAS_VALUE (status) << name;
        const json result_summary = c.value ("resultSummary", json::object ());
        EXPECT_EQ (outcome_json (judge_run_row (*type, *status, result_summary)),
        c.at ("expected"))
        << name;
    }
}

vayu::db::Run stored_run (RunType type, RunStatus status, std::string summary) {
    vayu::db::Run run;
    run.id      = "run_outcome";
    run.type    = type;
    run.status  = status;
    run.summary = std::move (summary);
    return run;
}

constexpr const char* MISSED_BUDGET = R"({"rps":5,"status_codes":{"200":10},
"thresholds":{"checks":[{"metric":"latencyP99Ms","passed":false}],"passed":0,"failed":1}})";

// The stored summary reaches the verdict through the row's `resultSummary`,
// so a stored budget miss judges a completed load run failed. Mutation check:
// have `stored_run_outcome` judge an empty object and this reads not judged.
TEST (StoredRunOutcome, AStoredBudgetMissFailsACompletedLoadRun) {
    EXPECT_EQ (stored_run_outcome (
               stored_run (RunType::Load, RunStatus::Completed, MISSED_BUDGET)),
    RunOutcome::Failed);
}

// No row summary, no verdict, unless the status is failed: the row the
// renderer draws with its status glyph alone. Mutation check: drop the
// `carries_result_summary` gate in `stored_run_outcome` together with
// `judge_load_row`'s in-flight branch and the running row answers failed.
TEST (StoredRunOutcome, ARowCarryingNoResultSummaryHasNoOutcome) {
    EXPECT_FALSE (stored_run_outcome (
    stored_run (RunType::Load, RunStatus::Running, MISSED_BUDGET)))
    << "a summary written before the final status is not final";
    EXPECT_FALSE (stored_run_outcome (stored_run (RunType::Load, RunStatus::Stopped, "")))
    << "a Stop that landed before the worker's summary";
    EXPECT_FALSE (stored_run_outcome (
    stored_run (RunType::Design, RunStatus::Completed, MISSED_BUDGET)));
}

// A failed status is the verdict, whatever the run type and whatever the
// summary holds (#3643): the list draws the failed mark from the status alone.
// Mutation check: drop the status-failed branch in `judge_run_row` and every
// row below reads no outcome.
TEST (StoredRunOutcome, AFailedStatusIsFailedWithOrWithoutASummary) {
    for (const auto type : { RunType::Load, RunType::Scenario, RunType::Design }) {
        for (const char* summary : { "", "not json", "{}", MISSED_BUDGET }) {
            EXPECT_EQ (stored_run_outcome (stored_run (type, RunStatus::Failed, summary)),
            RunOutcome::Failed)
            << vayu::to_string (type) << " with summary `" << summary << "`";
        }
    }
}

// A collection run reads its own summary shape: the step counts under
// `scenario`, never the load row's fields.
TEST (StoredRunOutcome, ACollectionRunIsFailedOnlyByItsStepsOrBudgets) {
    EXPECT_EQ (stored_run_outcome (stored_run (RunType::Scenario, RunStatus::Completed,
               R"({"scenario":{"passed":2,"failed":0,"errored":1}})")),
    RunOutcome::Failed);
    EXPECT_FALSE (stored_run_outcome (stored_run (RunType::Scenario,
    RunStatus::Completed, R"({"scenario":{"passed":3,"failed":0,"errored":0}})")));
    EXPECT_FALSE (stored_run_outcome (
    stored_run (RunType::Scenario, RunStatus::Completed, MISSED_BUDGET)))
    << "a load-shaped summary on a collection run has no `scenario` block";
}

// A single-request summary stored before the assertion block (#3537) is read
// through the same legacy derivation the row and the report use, so its
// failed `assert.*` row keeps met budgets from reading passed. Mutation check:
// drop the single-request half of `derive_legacy_assertions` and this passes.
TEST (StoredRunOutcome, ASummaryFromBeforeTheAssertionBlockKeepsItsFailedChecks) {
    const std::string summary = R"({"rps":5,"status_codes":{"200":10},
"thresholds":{"checks":[{"metric":"latencyP99Ms","passed":true}],"passed":1,"failed":0},
"elements":[{"id":"a1","kind":"assert.status","passed":8,"failed":2}]})";
    EXPECT_EQ (stored_run_outcome (stored_run (RunType::Load, RunStatus::Completed, summary)),
    RunOutcome::NotJudged);
}

} // namespace
