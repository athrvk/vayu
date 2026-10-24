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
 * The error rate is the case worth reading twice: the collector's transport
 * counter (`total_errors()`) sees no HTTP 500 at all, so a run of nothing but
 * 500s scores 0% by it. The verdict counts every non-2xx/3xx status, the one
 * definition every surface reports (`vayu::count_status_failures`, #2124).
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <string>
#include <unordered_map>

#include "optional_assert.hpp"
#include "vayu/core/metrics_collector.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/threshold_eval.hpp"

namespace {

using vayu::core::AssertionPopulations;
using vayu::core::build_threshold_outcome_payload;
using vayu::core::evaluate_thresholds;
using vayu::core::RunSummaryInputs;
using vayu::core::ThresholdOutcome;
using vayu::core::thresholds_fail_run;
using vayu::core::validate_thresholds;

/// A run that completed 1000 requests: 990 OK, 8 server errors, 2 transport
/// failures (status 0). p50/p95/p99 = 10/40/47 ms at 500 rps - so the error
/// rate is 1%, not the 0.2% the collector's transport counter alone would give.
RunSummaryInputs measured_run () {
    RunSummaryInputs inputs;
    inputs.total_requests = 1000;
    inputs.throughput     = 500.0;
    inputs.status_codes   = { { 200, 990 }, { 500, 8 }, { 0, 2 } };
    inputs.latency.count  = 1000;
    inputs.latency.p50    = 10.0;
    inputs.latency.p95    = 40.0;
    inputs.latency.p99    = 47.0;
    return inputs;
}

nlohmann::json config_with (const nlohmann::json& thresholds) {
    return nlohmann::json{ { "url", "http://localhost/" }, { "thresholds", thresholds } };
}

/// The one check in an outcome that declared exactly one budget. By value
/// rather than by reference, so an outcome that never arrived is a named
/// failure and a default check rather than a read of an empty optional.
vayu::core::ThresholdCheck only_check (const std::optional<ThresholdOutcome>& outcome) {
    if (!outcome.has_value ()) {
        ADD_FAILURE () << "the evaluation reported no outcome at all";
        return {};
    }
    EXPECT_EQ (outcome->checks.size (), 1u);
    return outcome->checks.at (0);
}

/// The label `threshold_eval.cpp`'s own metrics table shows for each of its
/// fixed keys, mirrored here so a rejection's wording can be asserted without
/// a second copy of the engine's own table - drift between the two shows up
/// as a test failure rather than silently.
const std::unordered_map<std::string, std::string>& metric_labels () {
    static const std::unordered_map<std::string, std::string> labels{
        { "latencyP50Ms", "p50 latency" },
        { "latencyP95Ms", "p95 latency" },
        { "latencyP99Ms", "p99 latency" },
        { "maxErrorRatePct", "Error rate" },
        { "minThroughputRps", "Throughput" },
        { "maxAssertionFailureRatePct", "Assertion failure rate" },
    };
    return labels;
}

/// Assert rejection and that the message names the offending budget - a 400
/// whose body does not say which one is wrong is barely better than silence.
/// @p key is the wire key; the message itself names the field's *label* for a
/// key this engine defines (`metric_labels`), or the wire key verbatim for one
/// it does not (an unknown key, `failRun`, or a `custom.<name>.<stat>` key the
/// caller typed itself, none of which have a label to show instead).
void expect_rejected (const nlohmann::json& thresholds, const std::string& key) {
    auto reason = validate_thresholds (config_with (thresholds));
    ASSERT_HAS_VALUE (reason)
    << "expected rejection for " << key << " in " << thresholds.dump ();
    const auto label = metric_labels ().find (key);
    const std::string& expected = label != metric_labels ().end () ? label->second : key;
    EXPECT_NE (reason->find (expected), std::string::npos)
    << "message should name '" << expected << "', got: " << *reason;
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
    ASSERT_HAS_VALUE (reason);
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
        { "latencyP99Ms", 50 }, { "maxErrorRatePct", 0.1 },
        { "minThroughputRps", 10000 }, { "maxAssertionFailureRatePct", 5 } };
    EXPECT_FALSE (validate_thresholds (config_with (thresholds)).has_value ());
    auto outcome = evaluate_thresholds (config_with (thresholds), measured_run ());
    ASSERT_HAS_VALUE (outcome);
    EXPECT_EQ (outcome->checks.size (), 6u);
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
    ASSERT_HAS_VALUE (outcome);
    ASSERT_EQ (outcome->checks.size (), 3u);
    EXPECT_EQ (outcome->checks[0].metric, "latencyP50Ms");
    EXPECT_DOUBLE_EQ (outcome->checks[0].actual, 10.0);
    EXPECT_EQ (outcome->checks[1].metric, "latencyP95Ms");
    EXPECT_DOUBLE_EQ (outcome->checks[1].actual, 40.0);
    EXPECT_EQ (outcome->checks[2].metric, "latencyP99Ms");
    EXPECT_DOUBLE_EQ (outcome->checks[2].actual, 47.0);
}

TEST (ThresholdEval, TheErrorRateCountsEveryNonSuccessStatus) {
    // 8 server errors + 2 transport failures out of 1000 = 1%. The transport
    // counter alone would say 0.2% here, and a run of nothing but 500s would
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
    ASSERT_HAS_VALUE (outcome);
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

// --- Zero samples: a latency ceiling must not read a default as a measurement
// (issue #1484: a run where every request failed reported its budgets met) ---

TEST (ThresholdEval, ALatencyBudgetWithNoCompletionsIsNotEvaluatedAndCountsAsFailed) {
    // Every request failed before its transfer ran - a request the pre-send
    // gate refused, a row that would not bind - so the run has a 100% error
    // rate and no latency sample at all (a timeout would be one, #2384).
    // `latency` keeps its all-default Percentiles (count 0, p99 0.0), which
    // must not read as "p99 was 0ms".
    RunSummaryInputs inputs;
    inputs.total_requests = 5999;
    inputs.status_codes   = { { 0, 5999 } };

    auto check = only_check (
    evaluate_thresholds (config_with ({ { "latencyP99Ms", 200 } }), inputs));
    EXPECT_FALSE (check.evaluated);
    EXPECT_FALSE (check.passed);
}

TEST (ThresholdEval, ARunWithSomeCompletionsStillEvaluatesEveryDeclaredLatencyBudget) {
    // The guard reads each metric's own sample count, not a single run-wide
    // flag - a run that completed at least one request must not blanket every
    // percentile as unevaluated.
    RunSummaryInputs inputs;
    inputs.total_requests = 10;
    inputs.status_codes   = { { 200, 10 } };
    inputs.latency.count  = 10;
    inputs.latency.p99    = 5.0;

    auto check = only_check (
    evaluate_thresholds (config_with ({ { "latencyP99Ms", 200 } }), inputs));
    EXPECT_TRUE (check.evaluated);
    EXPECT_TRUE (check.passed);
    EXPECT_DOUBLE_EQ (check.actual, 5.0);
}

// #2384: the budget judges the collector's own histogram, which holds the
// timeouts beside the answers. One request in twenty at the 2 s timeout puts
// p99 at the timeout, so a 200 ms ceiling fails a run it used to pass at
// 10 ms.
TEST (ThresholdEval, ALatencyBudgetJudgesTheTimeoutsBesideTheAnswers) {
    vayu::core::MetricsCollector collector ("run_timeouts");
    for (int i = 0; i < 95; ++i) {
        collector.record_success (200, 10.0, 0.0);
    }
    for (int i = 0; i < 5; ++i) {
        collector.record_error (vayu::ErrorCode::Timeout, "timed out", "",
        nullptr, vayu::core::AttemptDuration{ 2000.0, 0.0 });
    }

    RunSummaryInputs inputs;
    inputs.total_requests = collector.total_requests ();
    inputs.status_codes   = collector.status_code_distribution ();
    inputs.latency        = collector.calculate_percentiles ();

    auto check = only_check (
    evaluate_thresholds (config_with ({ { "latencyP99Ms", 200 } }), inputs));
    EXPECT_TRUE (check.evaluated);
    EXPECT_FALSE (check.passed);
    EXPECT_NEAR (check.actual, 2000.0, 2.0);
}

TEST (ThresholdEval, AnUnevaluatedLatencyCheckDoesNotHideAFailingErrorRateBudget) {
    // The bug's own reproduction: a 100% error rate run with both a latency
    // ceiling and an error-rate ceiling declared. The error rate still reads
    // correctly (measured_error_rate has always been 0/0-safe by total
    // requests, not by latency samples); the fix must not disturb it.
    RunSummaryInputs inputs;
    inputs.total_requests = 5999;
    inputs.status_codes   = { { 0, 5999 } };

    auto outcome = evaluate_thresholds (
    config_with ({ { "latencyP99Ms", 200 }, { "maxErrorRatePct", 1 } }), inputs);
    ASSERT_HAS_VALUE (outcome);
    ASSERT_EQ (outcome->checks.size (), 2u);
    EXPECT_FALSE (outcome->checks[0].evaluated); // latencyP99Ms: no completions
    EXPECT_FALSE (outcome->checks[0].passed);
    EXPECT_TRUE (outcome->checks[1].evaluated); // maxErrorRatePct: always evaluated
    EXPECT_FALSE (outcome->checks[1].passed); // 100% > 1%
    EXPECT_EQ (outcome->passed, 0u);
    EXPECT_EQ (outcome->failed, 2u);
}

TEST (ThresholdEval, AThroughputOrErrorRateBudgetIsAlwaysEvaluated) {
    // Neither metric has a "no data" state of its own: 0/0 error rate is
    // already correct (ARunThatSentNothingHasNoErrorRate) and a starved
    // throughput floor already fails on its own numbers.
    RunSummaryInputs empty;
    auto rate = only_check (
    evaluate_thresholds (config_with ({ { "maxErrorRatePct", 50 } }), empty));
    EXPECT_TRUE (rate.evaluated);
    auto throughput = only_check (
    evaluate_thresholds (config_with ({ { "minThroughputRps", 10 } }), empty));
    EXPECT_TRUE (throughput.evaluated);
    EXPECT_FALSE (throughput.passed); // 0 rps never meets a floor above zero
}

// --- maxAssertionFailureRatePct (issue #1497): assert.* elements and
// pm.test calls, judged per population (#2892) ---

TEST (ThresholdEval, AZeroAssertionFailureRateBudgetIsAccepted) {
    // Same reasoning as the error rate: "no assertion may fail" is a real ask.
    EXPECT_FALSE (
    validate_thresholds (config_with ({ { "maxAssertionFailureRatePct", 0 } })).has_value ());
}

TEST (ThresholdEval, AnAssertionFailureRateBudgetOutsideZeroToHundredIsRejected) {
    expect_rejected ({ { "maxAssertionFailureRatePct", -0.1 } }, "maxAssertionFailureRatePct");
    expect_rejected ({ { "maxAssertionFailureRatePct", 100.5 } }, "maxAssertionFailureRatePct");
}

TEST (ThresholdEval, AnAssertionFailureRateBudgetIsUnevaluatedWithNoAssertions) {
    // The run made no assertion at all - `inputs.assertions` stays unset, the
    // same "no data" state a latency percentile with zero completions has.
    auto check = only_check (evaluate_thresholds (
    config_with ({ { "maxAssertionFailureRatePct", 0 } }), measured_run ()));
    EXPECT_FALSE (check.evaluated);
    EXPECT_FALSE (check.passed);
}

// Mutation check: reduce `assertion_data_present` to `has_value ()` and this
// reads evaluated.
TEST (ThresholdEval, AnAssertionPopulationsObjectWithNothingInItIsUnevaluated) {
    RunSummaryInputs inputs = measured_run ();
    inputs.assertions       = AssertionPopulations{};
    auto check              = only_check (evaluate_thresholds (
    config_with ({ { "maxAssertionFailureRatePct", 0 } }), inputs));
    EXPECT_FALSE (check.evaluated);
    EXPECT_FALSE (check.assertions.has_value ());
}

// #2892: an exact assertion that never fails beside a sampled pm.test that
// fails half the time is judged at 50%, the sampled rate. A blend over equal
// counts reads 25%; over the counts a 1-in-100 replay gives, 0.495%.
// Mutation check: return the blended failed/total in
// `measured_assertion_failure_rate` and both readings red.
TEST (ThresholdEval, AnAssertionBudgetJudgesTheWorseOfTheExactAndSampledRates) {
    for (const size_t exact_passed : { size_t{ 2 }, size_t{ 200 } }) {
        RunSummaryInputs inputs = measured_run ();
        inputs.assertions       = AssertionPopulations{
                  .exact       = { .passed = exact_passed, .failed = 0 },
                  .sampled     = { .passed = 1, .failed = 1 },
                  .sample_rate = 100,
        };

        auto pass = only_check (evaluate_thresholds (
        config_with ({ { "maxAssertionFailureRatePct", 50 } }), inputs));
        EXPECT_TRUE (pass.evaluated);
        EXPECT_DOUBLE_EQ (pass.actual, 50.0) << exact_passed << " exact passes";
        EXPECT_TRUE (pass.passed);

        auto fail = only_check (evaluate_thresholds (
        config_with ({ { "maxAssertionFailureRatePct", 49 } }), inputs));
        EXPECT_FALSE (fail.passed) << exact_passed << " exact passes";
    }
}

// The same rule from the other side: a failing exact population is not
// diluted by a clean sampled one.
TEST (ThresholdEval, AFailingExactPopulationIsNotDilutedByACleanSampledOne) {
    RunSummaryInputs inputs = measured_run ();
    inputs.assertions       = AssertionPopulations{
              .exact       = { .passed = 18, .failed = 2 }, // 10%
              .sampled     = { .passed = 500, .failed = 0 },
              .sample_rate = 10,
    };
    auto check = only_check (evaluate_thresholds (
    config_with ({ { "maxAssertionFailureRatePct", 9 } }), inputs));
    EXPECT_DOUBLE_EQ (check.actual, 10.0);
    EXPECT_FALSE (check.passed);
}

// A run whose only assertions came from the deferred replay is still judged.
// Mutation check: read only `exact` in `assertion_data_present` and this
// reads unevaluated.
TEST (ThresholdEval, ASampledOnlyAssertionPopulationIsEvaluated) {
    RunSummaryInputs inputs = measured_run ();
    inputs.assertions       = AssertionPopulations{
              .exact = {}, .sampled = { .passed = 3, .failed = 1 }, .sample_rate = 10
    };
    auto check = only_check (evaluate_thresholds (
    config_with ({ { "maxAssertionFailureRatePct", 30 } }), inputs));
    EXPECT_TRUE (check.evaluated);
    EXPECT_DOUBLE_EQ (check.actual, 25.0);
    EXPECT_TRUE (check.passed);
}

// The stored check names both populations and the period the sampled one ran
// at, beside the worse rate as `actual`. Mutation check: drop the
// `append_assertion_populations` call in `build_threshold_outcome_payload`
// and every key below reds.
TEST (ThresholdEval, AnAssertionCheckPayloadNamesBothPopulations) {
    RunSummaryInputs inputs = measured_run ();
    inputs.assertions       = AssertionPopulations{
              .exact       = { .passed = 200, .failed = 0 },
              .sampled     = { .passed = 1, .failed = 1 },
              .sample_rate = 100,
    };
    auto outcome = evaluate_thresholds (
    config_with ({ { "maxAssertionFailureRatePct", 10 } }), inputs);
    ASSERT_HAS_VALUE (outcome);
    const auto payload = build_threshold_outcome_payload (*outcome);
    const auto& check  = payload["checks"][0];
    EXPECT_DOUBLE_EQ (check["actual"].get<double> (), 50.0);
    EXPECT_EQ (check.value ("assertionsExact", nlohmann::json ()),
    (nlohmann::json{ { "passed", 200 }, { "failed", 0 } }));
    EXPECT_EQ (check.value ("assertionsSampled", nlohmann::json ()),
    (nlohmann::json{ { "passed", 1 }, { "failed", 1 } }));
    EXPECT_EQ (check.value ("sampleRate", 0), 100);
}

// Nothing sampled: the sampled object is still written, at zero, and no
// sample rate is named. Mutation check: write `sampleRate` unconditionally in
// `append_assertion_populations` and the last assertion reds.
TEST (ThresholdEval, AnExactOnlyAssertionCheckNamesNoSampleRate) {
    RunSummaryInputs inputs = measured_run ();
    inputs.assertions       = AssertionPopulations{
              .exact = { .passed = 18, .failed = 2 }, .sampled = {}, .sample_rate = 1
    };
    auto outcome = evaluate_thresholds (
    config_with ({ { "maxAssertionFailureRatePct", 10 } }), inputs);
    ASSERT_HAS_VALUE (outcome);
    EXPECT_DOUBLE_EQ (outcome->checks.at (0).actual, 10.0);
    const auto payload = build_threshold_outcome_payload (*outcome);
    const auto& check  = payload["checks"][0];
    EXPECT_EQ (check.value ("assertionsExact", nlohmann::json ()),
    (nlohmann::json{ { "passed", 18 }, { "failed", 2 } }));
    EXPECT_EQ (check.value ("assertionsSampled", nlohmann::json ()),
    (nlohmann::json{ { "passed", 0 }, { "failed", 0 } }));
    EXPECT_FALSE (check.contains ("sampleRate")) << check.dump ();
}

// The populations belong to the assertion check alone, and an unevaluated
// one carries none, as it carries no `actual`. Mutation check: fill
// `check.assertions` for every evaluated metric in
// `evaluate_known_metric_check` and the error-rate row reds.
TEST (ThresholdEval, OnlyAnEvaluatedAssertionCheckCarriesPopulations) {
    RunSummaryInputs inputs = measured_run ();
    inputs.assertions       = AssertionPopulations{
              .exact = { .passed = 1, .failed = 0 }, .sampled = {}, .sample_rate = 1
    };
    auto outcome = evaluate_thresholds (
    config_with ({ { "maxErrorRatePct", 5 }, { "maxAssertionFailureRatePct", 5 } }), inputs);
    ASSERT_HAS_VALUE (outcome);
    const auto payload = build_threshold_outcome_payload (*outcome);
    ASSERT_EQ (payload["checks"].size (), 2u);
    EXPECT_FALSE (payload["checks"][0].contains ("assertionsExact")) << payload.dump ();
    EXPECT_TRUE (payload["checks"][1].contains ("assertionsExact")) << payload.dump ();

    auto unjudged = evaluate_thresholds (
    config_with ({ { "maxAssertionFailureRatePct", 5 } }), measured_run ());
    ASSERT_HAS_VALUE (unjudged);
    const auto row = build_threshold_outcome_payload (*unjudged)["checks"][0];
    EXPECT_FALSE (row.contains ("assertionsExact")) << row.dump ();
    EXPECT_FALSE (row.contains ("assertionsSampled")) << row.dump ();
}

// --- thresholds.failRun (issue #1497): a flag, not a budget -----------------

TEST (ThresholdEval, FailRunAcceptsOnlyABoolean) {
    EXPECT_FALSE (validate_thresholds (
    config_with ({ { "maxErrorRatePct", 5 }, { "failRun", true } }))
    .has_value ());
    EXPECT_FALSE (validate_thresholds (
    config_with ({ { "maxErrorRatePct", 5 }, { "failRun", nullptr } }))
    .has_value ()); // null reads as absent, the rule every other key follows
    expect_rejected ({ { "maxErrorRatePct", 5 }, { "failRun", "yes" } }, "failRun");
}

TEST (ThresholdEval, FailRunAloneDeclaresNoBudget) {
    // Not a budget itself - it needs at least one to mean anything, the same
    // rejection an empty `{}` gets.
    auto reason = validate_thresholds (config_with ({ { "failRun", true } }));
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("no budget"), std::string::npos) << *reason;
}

TEST (ThresholdEval, FailRunDoesNotBecomeASixthCheck) {
    // The evaluator's declared-budget count must ignore it too, or `failRun`
    // would show up in the report as a phantom, unjudgeable check.
    auto outcome = evaluate_thresholds (
    config_with ({ { "maxErrorRatePct", 5 }, { "failRun", true } }), measured_run ());
    ASSERT_HAS_VALUE (outcome);
    EXPECT_EQ (outcome->checks.size (), 1u);
}

TEST (ThresholdEval, ThresholdsFailRunReadsTheFlag) {
    EXPECT_TRUE (thresholds_fail_run (
    config_with ({ { "maxErrorRatePct", 5 }, { "failRun", true } })));
    EXPECT_FALSE (thresholds_fail_run (config_with ({ { "maxErrorRatePct", 5 } })));
    EXPECT_FALSE (thresholds_fail_run (
    config_with ({ { "maxErrorRatePct", 5 }, { "failRun", false } })));
    EXPECT_FALSE (thresholds_fail_run (nlohmann::json{ { "url", "http://localhost/" } }));
}

TEST (ThresholdEval, AStoredBudgetOfTheWrongTypeIsSkippedRatherThanGuessed) {
    // The evaluator reads a persisted config snapshot, which the route gate
    // cannot vouch for - an older or hand-edited row must not take the whole
    // section down, nor invent a limit for an unreadable value.
    auto outcome = evaluate_thresholds (
    config_with ({ { "latencyP99Ms", "fast" }, { "minThroughputRps", 100 } }),
    measured_run ());
    ASSERT_HAS_VALUE (outcome);
    ASSERT_EQ (outcome->checks.size (), 1u);
    EXPECT_EQ (outcome->checks[0].metric, "minThroughputRps");
}

// --- custom.<name>.<stat> (issue #1500) -------------------------------------

RunSummaryInputs run_with_custom_trend (const std::string& name, double p95, size_t count) {
    RunSummaryInputs inputs = measured_run ();
    vayu::core::CustomMetricSummary trend;
    trend.type            = vayu::core::CustomMetricType::Trend;
    trend.count           = count;
    trend.p95             = p95;
    inputs.custom_metrics = { { name, trend } };
    return inputs;
}

TEST (ThresholdEval, ValidateAcceptsACustomMetricKey) {
    EXPECT_FALSE (
    validate_thresholds (config_with ({ { "custom.ttfb2.p95", 50 } })).has_value ());
}

TEST (ThresholdEval, ValidateRejectsAnUnknownStat) {
    expect_rejected ({ { "custom.ttfb2.p999", 50 } }, "custom.ttfb2.p999");
}

TEST (ThresholdEval, ValidateRejectsANegativeCustomLimit) {
    expect_rejected ({ { "custom.ttfb2.p95", -1 } }, "custom.ttfb2.p95");
}

TEST (ThresholdEval, ValidateRejectsAnUnknownKeyMentioningTheCustomPattern) {
    auto reason = validate_thresholds (config_with ({ { "notARealBudget", 5 } }));
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("custom.<name>.<stat>"), std::string::npos) << *reason;
}

TEST (ThresholdEval, ACustomMetricTrendEvaluatesAgainstItsRecordedP95) {
    auto outcome = evaluate_thresholds (config_with ({ { "custom.ttfb2.p95", 50.0 } }),
    run_with_custom_trend ("ttfb2", 47.0, 10));
    const auto check = only_check (outcome);
    EXPECT_EQ (check.metric, "custom.ttfb2.p95");
    EXPECT_TRUE (check.evaluated);
    EXPECT_DOUBLE_EQ (check.actual, 47.0);
    EXPECT_TRUE (check.passed);
}

TEST (ThresholdEval, ACustomMetricTrendCanFailTheRun) {
    auto outcome = evaluate_thresholds (config_with ({ { "custom.ttfb2.p95", 20.0 } }),
    run_with_custom_trend ("ttfb2", 47.0, 10));
    const auto check = only_check (outcome);
    EXPECT_FALSE (check.passed);
    ASSERT_HAS_VALUE (outcome);
    EXPECT_EQ (outcome->failed, 1u);
}

TEST (ThresholdEval, ACustomMetricNeverRecordedIsUnevaluatedRatherThanATrivialPass) {
    // "custom.ttfb2.p95" declared, but this run's collector never recorded
    // that name (a typo, or a metric.record on a step the run never
    // reached) - not the same as a metric that measured 0.
    auto outcome = evaluate_thresholds (
    config_with ({ { "custom.ttfb2.p95", 50.0 } }), measured_run ());
    const auto check = only_check (outcome);
    EXPECT_FALSE (check.evaluated);
    EXPECT_FALSE (check.passed);
}

TEST (ThresholdEval, ACustomCounterReadsItsRunningTotalUnderValueOrRate) {
    RunSummaryInputs inputs = measured_run ();
    vayu::core::CustomMetricSummary counter;
    counter.type          = vayu::core::CustomMetricType::Counter;
    counter.count         = 4;
    counter.value         = 4096.0;
    inputs.custom_metrics = { { "bytesOut", counter } };

    auto outcome = evaluate_thresholds (
    config_with ({ { "custom.bytesOut.value", 8192.0 } }), inputs);
    const auto check = only_check (outcome);
    EXPECT_DOUBLE_EQ (check.actual, 4096.0);
    EXPECT_TRUE (check.passed);
}

// The ceiling `{"custom.failures.value": 0}` exists for: a counter that was
// recorded, and only ever by zero, is evaluated and passes (#1937). Fed
// through a real collector, because the defect was the collector's `count`.
// Mutation check: derive `count` from the total in
// `MetricsCollector::custom_metric_summaries` and this reads unevaluated.
TEST (ThresholdEval, ACustomCounterRecordedOnlyAsZeroIsEvaluatedAndPasses) {
    vayu::core::MetricsCollector collector ("zero-counter");
    collector.record_custom_metric ("x", vayu::core::CustomMetricType::Counter, 0.0);
    RunSummaryInputs inputs = measured_run ();
    inputs.custom_metrics   = collector.custom_metric_summaries ();

    auto outcome =
    evaluate_thresholds (config_with ({ { "custom.x.value", 0.0 } }), inputs);
    const auto check = only_check (outcome);
    EXPECT_TRUE (check.evaluated);
    EXPECT_DOUBLE_EQ (check.actual, 0.0);
    EXPECT_TRUE (check.passed);
}

// The other half: a counter the plan registered but nothing ever recorded
// through is unevaluated, the same answer a typo'd name gets.
TEST (ThresholdEval, ACustomCounterRegisteredButNeverRecordedIsUnevaluated) {
    vayu::core::MetricsCollector collector ("idle-counter");
    ASSERT_TRUE (
    collector.register_custom_metric ("x", vayu::core::CustomMetricType::Counter));
    RunSummaryInputs inputs = measured_run ();
    inputs.custom_metrics   = collector.custom_metric_summaries ();

    auto outcome =
    evaluate_thresholds (config_with ({ { "custom.x.value", 0.0 } }), inputs);
    const auto check = only_check (outcome);
    EXPECT_FALSE (check.evaluated);
    EXPECT_FALSE (check.passed);
}

TEST (ThresholdEval, ACustomRateReadsItsPercentageUnderRate) {
    RunSummaryInputs inputs = measured_run ();
    vayu::core::CustomMetricSummary rate;
    rate.type             = vayu::core::CustomMetricType::Rate;
    rate.count            = 10;
    rate.value            = 30.0;
    inputs.custom_metrics = { { "cacheHit", rate } };

    auto outcome =
    evaluate_thresholds (config_with ({ { "custom.cacheHit.rate", 50.0 } }), inputs);
    const auto check = only_check (outcome);
    EXPECT_DOUBLE_EQ (check.actual, 30.0);
    EXPECT_TRUE (check.passed);
}
