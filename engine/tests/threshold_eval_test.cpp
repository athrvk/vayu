/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/threshold_eval_test.cpp
 * @brief The pure core behind a run's pass/fail budgets.
 *
 * Two properties carry the feature. The verdict must be computed from the same
 * numbers the summary stores - a report that prints `p99: 47` beside a failed
 * p99 budget of 50 is worse than no verdict at all - and a run that declared no
 * budget must produce no section, because "not judged" and "judged and passed
 * nothing" are different answers and only absence can say the first.
 *
 * The error rate is the case worth reading twice: the collector's own
 * `error_rate()` counts transport failures only, so a run of nothing but HTTP
 * 500s scores 0% by it. The report has always counted every non-2xx/3xx status
 * instead, and the verdict follows the report.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include "vayu/core/run_manager.hpp"
#include "vayu/core/threshold_eval.hpp"

namespace {

using vayu::core::evaluate_thresholds;
using vayu::core::RunSummaryInputs;
using vayu::core::ThresholdOutcome;
using vayu::core::validate_thresholds;

/// A run that completed 1000 requests: 990 OK, 8 server errors, 2 transport
/// failures (status 0). p50/p95/p99 = 10/40/47 ms at 500 rps - so the error
/// rate is 1%, not the 0.2% the collector's transport-only count would give.
RunSummaryInputs measured_run () {
    RunSummaryInputs inputs;
    inputs.total_requests = 1000;
    inputs.throughput     = 500.0;
    inputs.status_codes   = { { 200, 990 }, { 500, 8 }, { 0, 2 } };
    inputs.latency.p50    = 10.0;
    inputs.latency.p95    = 40.0;
    inputs.latency.p99    = 47.0;
    return inputs;
}

nlohmann::json config_with (const nlohmann::json& thresholds) {
    return nlohmann::json{ { "url", "http://localhost/" }, { "thresholds", thresholds } };
}

/// The one check in an outcome that declared exactly one budget.
const vayu::core::ThresholdCheck& only_check (const std::optional<ThresholdOutcome>& outcome) {
    EXPECT_TRUE (outcome.has_value ());
    EXPECT_EQ (outcome->checks.size (), 1u);
    return outcome->checks.at (0);
}

/// Assert rejection and that the message names the offending key - a 400 whose
/// body does not say which budget is wrong is barely better than silence.
void expect_rejected (const nlohmann::json& thresholds, const std::string& key) {
    auto reason = validate_thresholds (config_with (thresholds));
    ASSERT_TRUE (reason.has_value ())
    << "expected rejection for " << key << " in " << thresholds.dump ();
    EXPECT_NE (reason->find (key), std::string::npos)
    << "message should name '" << key << "', got: " << *reason;
}

} // namespace

// --- Absence: the property that keeps the report section out --------------

TEST (ThresholdEval, AConfigWithNoThresholdsIsNotJudged) {
    nlohmann::json config{ { "url", "http://localhost/" } };
    EXPECT_FALSE (evaluate_thresholds (config, measured_run ()).has_value ());
    EXPECT_FALSE (validate_thresholds (config).has_value ());
}

TEST (ThresholdEval, AnEmptyThresholdsObjectIsRejectedRatherThanStored) {
    // Accepting it would complete the run with no verdict, which is precisely
    // what the caller believed it was asking for.
    auto reason = validate_thresholds (config_with (nlohmann::json::object ()));
    ASSERT_TRUE (reason.has_value ());
    EXPECT_NE (reason->find ("no budget"), std::string::npos) << *reason;
}

TEST (ThresholdEval, AnObjectOfOnlyNullsDeclaresNothing) {
    // Null reads as absent per the config-wide rule, so this object is empty in
    // every sense that matters - and must be rejected as one.
    nlohmann::json thresholds{ { "latencyP99Ms", nullptr }, { "maxErrorRatePct", nullptr } };
    EXPECT_TRUE (validate_thresholds (config_with (thresholds)).has_value ());
    EXPECT_FALSE (
    evaluate_thresholds (config_with (thresholds), measured_run ()).has_value ());
}

TEST (ThresholdEval, ANonObjectThresholdsValueIsRejected) {
    EXPECT_TRUE (validate_thresholds (config_with (50)).has_value ());
    EXPECT_TRUE (validate_thresholds (config_with ("fast")).has_value ());
    EXPECT_TRUE (
    validate_thresholds (config_with (nlohmann::json::array ({ 1, 2 }))).has_value ());
}

TEST (ThresholdEval, AnExplicitNullThresholdsKeyIsAbsent) {
    nlohmann::json config{ { "url", "http://localhost/" }, { "thresholds", nullptr } };
    EXPECT_FALSE (validate_thresholds (config).has_value ());
    EXPECT_FALSE (evaluate_thresholds (config, measured_run ()).has_value ());
}

// --- Validation: an unusable budget fails loudly, before the run exists ----

TEST (ThresholdEval, AnUnknownBudgetIsRejectedAndNamed) {
    // The failure this prevents is silent: a typo'd key accepted here would be
    // a budget the evaluator never checks and the report never mentions.
    expect_rejected ({ { "latencyP98Ms", 50 } }, "latencyP98Ms");
}

TEST (ThresholdEval, ANonNumericBudgetIsRejected) {
    expect_rejected ({ { "latencyP99Ms", "50ms" } }, "latencyP99Ms");
    expect_rejected ({ { "minThroughputRps", true } }, "minThroughputRps");
}

TEST (ThresholdEval, ALatencyBudgetOfZeroOrLessIsRejected) {
    expect_rejected ({ { "latencyP50Ms", 0 } }, "latencyP50Ms");
    expect_rejected ({ { "latencyP95Ms", -1 } }, "latencyP95Ms");
    expect_rejected ({ { "latencyP99Ms", 86400001 } }, "latencyP99Ms");
}

TEST (ThresholdEval, AZeroErrorRateBudgetIsAccepted) {
    // "No request may fail" is the one zero that is an intent rather than a
    // typo, so the error rate is the only budget whose floor is inclusive.
    EXPECT_FALSE (
    validate_thresholds (config_with ({ { "maxErrorRatePct", 0 } })).has_value ());
}

TEST (ThresholdEval, AnErrorRateBudgetOutsideZeroToHundredIsRejected) {
    expect_rejected ({ { "maxErrorRatePct", -0.1 } }, "maxErrorRatePct");
    expect_rejected ({ { "maxErrorRatePct", 100.5 } }, "maxErrorRatePct");
}

TEST (ThresholdEval, AThroughputFloorOfZeroIsRejected) {
    // A floor nothing can fall below is not a budget.
    expect_rejected ({ { "minThroughputRps", 0 } }, "minThroughputRps");
}

TEST (ThresholdEval, EveryKnownBudgetIsAcceptedTogether) {
    nlohmann::json thresholds{ { "latencyP50Ms", 20 }, { "latencyP95Ms", 40 },
        { "latencyP99Ms", 50 }, { "maxErrorRatePct", 0.1 }, { "minThroughputRps", 10000 } };
    EXPECT_FALSE (validate_thresholds (config_with (thresholds)).has_value ());
    auto outcome = evaluate_thresholds (config_with (thresholds), measured_run ());
    ASSERT_TRUE (outcome.has_value ());
    EXPECT_EQ (outcome->checks.size (), 5u);
}

// --- The verdict: each budget passes and fails off the run's own numbers ---

TEST (ThresholdEval, ALatencyBudgetPassesAtOrUnderTheLimit) {
    // 47 ms measured. The boundary is a pass: a budget of "p99 under 47" that
    // rejected exactly 47 would be reporting a breach the numbers deny.
    EXPECT_TRUE (only_check (
    evaluate_thresholds (config_with ({ { "latencyP99Ms", 50 } }), measured_run ()))
    .passed);
    EXPECT_TRUE (only_check (
    evaluate_thresholds (config_with ({ { "latencyP99Ms", 47 } }), measured_run ()))
    .passed);
    EXPECT_FALSE (only_check (
    evaluate_thresholds (config_with ({ { "latencyP99Ms", 46.9 } }), measured_run ()))
    .passed);
}

TEST (ThresholdEval, EachPercentileReadsItsOwnMeasurement) {
    // The failure this catches is a copy-paste in the metric table: three
    // budgets all judging p99 would look correct until a run's p50 breached.
    auto config = config_with (
    { { "latencyP50Ms", 20 }, { "latencyP95Ms", 40 }, { "latencyP99Ms", 50 } });
    auto outcome = evaluate_thresholds (config, measured_run ());
    ASSERT_TRUE (outcome.has_value ());
    ASSERT_EQ (outcome->checks.size (), 3u);
    EXPECT_EQ (outcome->checks[0].metric, "latencyP50Ms");
    EXPECT_DOUBLE_EQ (outcome->checks[0].actual, 10.0);
    EXPECT_EQ (outcome->checks[1].metric, "latencyP95Ms");
    EXPECT_DOUBLE_EQ (outcome->checks[1].actual, 40.0);
    EXPECT_EQ (outcome->checks[2].metric, "latencyP99Ms");
    EXPECT_DOUBLE_EQ (outcome->checks[2].actual, 47.0);
}

TEST (ThresholdEval, TheErrorRateCountsEveryNonSuccessStatus) {
    // 8 server errors + 2 transport failures out of 1000 = 1%. The collector's
    // own error_rate() would say 0.2% here, and a run of nothing but 500s would
    // score a clean 0 - which is the bug this test exists to pin.
    auto check = only_check (evaluate_thresholds (
    config_with ({ { "maxErrorRatePct", 5 } }), measured_run ()));
    EXPECT_DOUBLE_EQ (check.actual, 1.0);
    EXPECT_TRUE (check.passed);

    EXPECT_FALSE (only_check (
    evaluate_thresholds (config_with ({ { "maxErrorRatePct", 0.5 } }), measured_run ()))
    .passed);
}

TEST (ThresholdEval, AThroughputFloorFailsBelowTheLimit) {
    // The one budget judged the other way round - a copy of the latency
    // comparison here would call a starved run a pass.
    EXPECT_TRUE (only_check (
    evaluate_thresholds (config_with ({ { "minThroughputRps", 500 } }), measured_run ()))
    .passed);
    EXPECT_FALSE (only_check (
    evaluate_thresholds (config_with ({ { "minThroughputRps", 501 } }), measured_run ()))
    .passed);
}

TEST (ThresholdEval, TalliesSplitPassedFromFailed) {
    auto outcome = evaluate_thresholds (
    config_with ({ { "latencyP50Ms", 20 }, { "latencyP95Ms", 40 },
    { "latencyP99Ms", 46 }, { "maxErrorRatePct", 0.5 }, { "minThroughputRps", 100 } }),
    measured_run ());
    ASSERT_TRUE (outcome.has_value ());
    EXPECT_EQ (outcome->passed, 3u); // p50, p95, throughput
    EXPECT_EQ (outcome->failed, 2u); // p99 (47 > 46), error rate (1% > 0.5%)
    EXPECT_EQ (outcome->checks.size (), 5u);
}

TEST (ThresholdEval, ARunThatSentNothingHasNoErrorRate) {
    // A run stopped before its first completion is judged on what it measured,
    // and 0/0 is 0% - not a division that takes the summary write down with it.
    RunSummaryInputs empty;
    auto check = only_check (
    evaluate_thresholds (config_with ({ { "maxErrorRatePct", 1 } }), empty));
    EXPECT_DOUBLE_EQ (check.actual, 0.0);
    EXPECT_TRUE (check.passed);
}

TEST (ThresholdEval, AStoredBudgetOfTheWrongTypeIsSkippedRatherThanGuessed) {
    // The evaluator reads a persisted config snapshot, which the route gate
    // cannot vouch for - an older or hand-edited row must not take the whole
    // section down, nor invent a limit for an unreadable value.
    auto outcome = evaluate_thresholds (
    config_with ({ { "latencyP99Ms", "fast" }, { "minThroughputRps", 100 } }),
    measured_run ());
    ASSERT_TRUE (outcome.has_value ());
    ASSERT_EQ (outcome->checks.size (), 1u);
    EXPECT_EQ (outcome->checks[0].metric, "minThroughputRps");
}
