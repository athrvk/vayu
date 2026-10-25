/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/capacity_controller_test.cpp
 * @brief The pure core behind capacity discovery: what level to run next, and
 *        when the search has its answer.
 *
 * The whole policy of the mode lives in `decide_next_level`, deliberately free
 * of a clock, a metrics collector and a run context, so every branch of it can
 * be driven here from a hand-written history rather than from a real server
 * that has to be persuaded to saturate.
 *
 * Two properties are the feature. A *single* breaching window must not end the
 * search - it re-measures the same level, because one GC pause is not a
 * capacity limit - and the knee must be attributed to the level that gave out
 * while the headline stays on the last level that held, or the report answers
 * "what can my service take" with a number it could not take.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "optional_assert.hpp"
#include "vayu/core/capacity_controller.hpp"
#include "vayu/core/constants.hpp"

namespace {

using vayu::core::CapacityAction;
using vayu::core::CapacityConfig;
using vayu::core::CapacityWindow;
using vayu::core::decide_next_level;
using vayu::core::summarize_capacity;
namespace stop = vayu::core::capacity_stop;

/// A search for the edge of a 100ms p99 budget, starting at 10 and capped at
/// 100. Growth, plateau and breach-count are left at their production values -
/// the tests that care about one of them override that one field only, so a
/// changed default shows up here rather than passing silently.
CapacityConfig search () {
    CapacityConfig config;
    config.slo_ms            = 100.0;
    config.start_concurrency = 10;
    config.max_concurrency   = 100;
    return config;
}

CapacityWindow
window (size_t concurrency, double rps, double p99_ms, double error_pct = 0.0, size_t samples = 0) {
    return CapacityWindow{ concurrency, rps, p99_ms, error_pct, samples };
}

TEST (CapacityControllerTest, EmptyHistoryStartsAtStartConcurrency) {
    const auto decision = decide_next_level (search (), {});
    EXPECT_EQ (decision.action, CapacityAction::StepUp);
    EXPECT_EQ (decision.next_concurrency, 10u);
    EXPECT_EQ (decision.stop_reason, nullptr);
}

TEST (CapacityControllerTest, HealthyWindowStepsUpByGrowthFactor) {
    const auto decision = decide_next_level (search (), { window (40, 4000, 20.0) });
    EXPECT_EQ (decision.action, CapacityAction::StepUp);
    // +25% of 40.
    EXPECT_EQ (decision.next_concurrency, 50u);
}

TEST (CapacityControllerTest, GrowthIsAtLeastOneConcurrency) {
    CapacityConfig config    = search ();
    config.start_concurrency = 1;
    // +25% of 1 rounds back to 1, which would search forever at one connection.
    const auto decision = decide_next_level (config, { window (1, 900, 2.0) });
    EXPECT_EQ (decision.action, CapacityAction::StepUp);
    EXPECT_EQ (decision.next_concurrency, 2u);
}

TEST (CapacityControllerTest, StepUpNeverExceedsTheCap) {
    const auto decision = decide_next_level (search (), { window (90, 9000, 20.0) });
    EXPECT_EQ (decision.action, CapacityAction::StepUp);
    EXPECT_EQ (decision.next_concurrency, 100u); // not 112
}

// The mutation check for the consecutive requirement: drop it from
// decide_next_level and this test starts reporting Stop.
TEST (CapacityControllerTest, OneBreachingWindowHoldsRatherThanStopping) {
    const auto decision = decide_next_level (
    search (), { window (40, 4000, 20.0), window (50, 4200, 180.0) });
    EXPECT_EQ (decision.action, CapacityAction::Hold);
    EXPECT_EQ (decision.next_concurrency, 50u); // re-measures the same level
    EXPECT_EQ (decision.stop_reason, nullptr);
}

TEST (CapacityControllerTest, TwoConsecutiveBreachesStopSloExceeded) {
    const auto decision = decide_next_level (search (),
    { window (40, 4000, 20.0), window (50, 4200, 180.0), window (50, 4100, 210.0) });
    EXPECT_EQ (decision.action, CapacityAction::Stop);
    EXPECT_STREQ (decision.stop_reason, stop::SLO_EXCEEDED);
}

TEST (CapacityControllerTest, ARecoveredHoldResumesTheSearch) {
    // The hold cleared: the breach was noise, so the search climbs again rather
    // than holding at a level it has now measured as healthy twice.
    const auto decision = decide_next_level (search (),
    { window (40, 4000, 20.0), window (50, 4200, 180.0), window (50, 5000, 30.0) });
    EXPECT_EQ (decision.action, CapacityAction::StepUp);
    EXPECT_EQ (decision.next_concurrency, 62u);
}

TEST (CapacityControllerTest, ExactlyAtTheSloIsHealthy) {
    // The budget is "p99 under 100ms"; a p99 *of* 100ms has not breached it.
    const auto decision = decide_next_level (search (), { window (40, 4000, 100.0) });
    EXPECT_EQ (decision.action, CapacityAction::StepUp);
}

TEST (CapacityControllerTest, PlateauStopsWhileStillInsideTheSlo) {
    // Throughput gained 2% across two step-ups while concurrency grew 56%:
    // the service is inside its latency budget and no longer converting
    // concurrency into work.
    const auto decision = decide_next_level (search (),
    { window (32, 10000, 30.0), window (40, 10100, 40.0), window (50, 10200, 60.0) });
    EXPECT_EQ (decision.action, CapacityAction::Stop);
    EXPECT_STREQ (decision.stop_reason, stop::PLATEAU);
}

TEST (CapacityControllerTest, HealthyThroughputGrowthIsNotAPlateau) {
    const auto decision = decide_next_level (search (),
    { window (32, 10000, 30.0), window (40, 12000, 40.0), window (50, 14000, 60.0) });
    EXPECT_EQ (decision.action, CapacityAction::StepUp);
}

TEST (CapacityControllerTest, AHoldIsNotCountedAsAStepUpForPlateau) {
    // Without collapsing the repeated level, the last three windows read as
    // 40 / 50 / 50 with flat throughput and the search would stop `plateau`
    // on a level it merely re-measured.
    const auto decision = decide_next_level (search (),
    { window (40, 10000, 30.0), window (50, 10100, 180.0), window (50, 10150, 40.0) });
    EXPECT_EQ (decision.action, CapacityAction::StepUp);
}

TEST (CapacityControllerTest, ReachingTheCapStops) {
    const auto decision = decide_next_level (search (), { window (100, 20000, 30.0) });
    EXPECT_EQ (decision.action, CapacityAction::Stop);
    EXPECT_STREQ (decision.stop_reason, stop::CAP_REACHED);
}

TEST (CapacityControllerTest, ACapBreachStillReportsTheLatencyLimitFirst) {
    // At the cap *and* breaching: the SLO is what the service did, the cap is
    // only where the search ran out of room.
    const auto decision = decide_next_level (
    search (), { window (100, 20000, 300.0), window (100, 19000, 320.0) });
    EXPECT_EQ (decision.action, CapacityAction::Stop);
    EXPECT_STREQ (decision.stop_reason, stop::SLO_EXCEEDED);
}

// #2815: a target answering fast 503s is not sustaining the level. One such
// window re-measures, like a latency breach.
// Mutation-check: drop the error half of `breaches` and this steps up.
TEST (CapacityControllerTest, AFastLevelThatMostlyFailsHolds) {
    const auto decision = decide_next_level (
    search (), { window (40, 4000, 20.0), window (50, 9000, 3.0, 94.0) });
    EXPECT_EQ (decision.action, CapacityAction::Hold);
    EXPECT_EQ (decision.next_concurrency, 50u);
}

// Mutation-check: report SLO_EXCEEDED for every breach stop and this fails.
TEST (CapacityControllerTest, TwoErrorBreachesInsideTheSloStopErrorsExceeded) {
    const std::vector<CapacityWindow> history{ window (40, 4000, 20.0),
        window (50, 9000, 3.0, 94.0), window (50, 9100, 3.0, 95.0) };
    const auto decision = decide_next_level (search (), history);
    EXPECT_EQ (decision.action, CapacityAction::Stop);
    EXPECT_STREQ (decision.stop_reason, stop::ERRORS_EXCEEDED);

    // Mutation-check: report a knee for SLO_EXCEEDED only and this has none.
    const auto summary = summarize_capacity (search (), history, decision.stop_reason);
    ASSERT_HAS_VALUE (summary.knee);
    EXPECT_EQ (summary.knee->concurrency, 50u);
    EXPECT_DOUBLE_EQ (summary.knee->error_pct, 95.0);
    ASSERT_HAS_VALUE (summary.max_healthy);
    EXPECT_EQ (summary.max_healthy->concurrency, 40u);
}

TEST (CapacityControllerTest, ExactlyAtTheErrorLimitIsHealthy) {
    // The limit is "errors at most 1%"; a share *of* 1% has not breached it.
    const double limit = search ().max_error_pct;
    const auto decision =
    decide_next_level (search (), { window (40, 4000, 20.0, limit) });
    EXPECT_EQ (decision.action, CapacityAction::StepUp);
}

// Mutation-check: test the error share before the p99 when naming the reason
// and this reads errors_exceeded.
TEST (CapacityControllerTest, LatencyIsTheReasonWhenBothBreach) {
    const auto decision = decide_next_level (search (),
    { window (50, 4200, 180.0, 40.0), window (50, 4100, 210.0, 45.0) });
    EXPECT_EQ (decision.action, CapacityAction::Stop);
    EXPECT_STREQ (decision.stop_reason, stop::SLO_EXCEEDED);
}

// #2815, audit S3: a target that answered 94% of requests with a fast error at
// 33 virtual users under a 200ms budget was reported "Sustained 50". Replays
// that run's level sequence end to end.
// Mutation-check: drop the error half of `breaches` and the 33 steps up to 41.
TEST (CapacityControllerTest, ReplayOfTheAuditRunStopsOnErrorsAndHeadlinesTheLastHealthyLevel) {
    CapacityConfig config    = search ();
    config.slo_ms            = 200.0;
    config.start_concurrency = 1;
    config.max_concurrency   = 50;

    // +25% per step, at least +1, truncated: 1, 2, 3, ... 22, 27, 33.
    const std::vector<size_t> healthy_levels{ 1, 2, 3, 4, 5, 6, 7, 8, 10, 12,
        15, 18, 22, 27 };
    std::vector<CapacityWindow> history;
    for (size_t i = 0; i < healthy_levels.size (); ++i) {
        const size_t level = healthy_levels[i];
        history.push_back (window (level, 40.0 * static_cast<double> (level), 77.0));

        const auto step = decide_next_level (config, history);
        EXPECT_EQ (step.action, CapacityAction::StepUp) << "after level " << level;
        const size_t expected_next =
        i + 1 < healthy_levels.size () ? healthy_levels[i + 1] : 33u;
        EXPECT_EQ (step.next_concurrency, expected_next);
    }

    history.push_back (window (33, 1132.0, 81.0, 94.0));
    const auto first_breach = decide_next_level (config, history);
    EXPECT_EQ (first_breach.action, CapacityAction::Hold);
    EXPECT_EQ (first_breach.next_concurrency, 33u);

    history.push_back (window (33, 1132.0, 81.0, 94.0));
    const auto decision = decide_next_level (config, history);
    EXPECT_EQ (decision.action, CapacityAction::Stop);
    EXPECT_EQ (decision.next_concurrency, 33u);
    EXPECT_STREQ (decision.stop_reason, stop::ERRORS_EXCEEDED);
    EXPECT_STRNE (decision.stop_reason, stop::CAP_REACHED);

    const auto summary = summarize_capacity (config, history, decision.stop_reason);
    ASSERT_HAS_VALUE (summary.max_healthy);
    EXPECT_EQ (summary.max_healthy->concurrency, 27u);
    ASSERT_HAS_VALUE (summary.knee);
    EXPECT_EQ (summary.knee->concurrency, 33u);
    EXPECT_NEAR (summary.knee->error_pct, 94.0, 1e-9);
    EXPECT_EQ (summary.stop_reason, stop::ERRORS_EXCEEDED);
}

// ---------------------------------------------------------------------------
// Summarizing what the search found
// ---------------------------------------------------------------------------

TEST (CapacityControllerTest, KneeIsTheLevelThatGaveOutAndHeadlineIsTheLastThatHeld) {
    const std::vector<CapacityWindow> history{ window (10, 1000, 5.0),
        window (48, 23400, 41.2), window (64, 23000, 300.0), window (64, 22800, 312.0) };
    const auto summary = summarize_capacity (search (), history, stop::SLO_EXCEEDED);

    ASSERT_HAS_VALUE (summary.max_healthy);
    EXPECT_EQ (summary.max_healthy->concurrency, 48u);
    EXPECT_DOUBLE_EQ (summary.max_healthy->rps, 23400.0);
    EXPECT_DOUBLE_EQ (summary.max_healthy->p99_ms, 41.2);

    ASSERT_HAS_VALUE (summary.knee);
    EXPECT_EQ (summary.knee->concurrency, 64u);
    EXPECT_DOUBLE_EQ (summary.knee->p99_ms, 312.0);
    EXPECT_GT (summary.knee->p99_ms, summary.slo_ms);

    EXPECT_EQ (summary.stop_reason, stop::SLO_EXCEEDED);
    EXPECT_EQ (summary.levels.size (), 4u); // the audit trail keeps the hold
}

TEST (CapacityControllerTest, NoKneeWhenTheSearchNeverSawTheServiceGiveOut) {
    const std::vector<CapacityWindow> history{ window (10, 1000, 5.0),
        window (100, 9000, 40.0) };
    const auto summary = summarize_capacity (search (), history, stop::CAP_REACHED);

    ASSERT_HAS_VALUE (summary.max_healthy);
    EXPECT_EQ (summary.max_healthy->concurrency, 100u);
    EXPECT_FALSE (summary.knee.has_value ());
}

TEST (CapacityControllerTest, NoHeadlineWhenTheFirstLevelAlreadyBreached) {
    const std::vector<CapacityWindow> history{ window (10, 90, 400.0),
        window (10, 88, 420.0) };
    const auto summary = summarize_capacity (search (), history, stop::SLO_EXCEEDED);

    EXPECT_FALSE (summary.max_healthy.has_value ());
    ASSERT_HAS_VALUE (summary.knee);
    EXPECT_EQ (summary.knee->concurrency, 10u);
}

// A level that held the latency budget while failing is not the capacity.
// Mutation-check: judge max_healthy on the p99 alone and this reports 64.
TEST (CapacityControllerTest, TheHeadlineSkipsALevelThatBreachedOnErrors) {
    const std::vector<CapacityWindow> history{ window (48, 23400, 41.2, 0.5),
        window (64, 30000, 12.0, 30.0), window (64, 31000, 11.0, 35.0) };
    const auto summary = summarize_capacity (search (), history, stop::ERRORS_EXCEEDED);

    ASSERT_HAS_VALUE (summary.max_healthy);
    EXPECT_EQ (summary.max_healthy->concurrency, 48u);
    EXPECT_DOUBLE_EQ (summary.max_healthy->error_pct, 0.5);
}

TEST (CapacityControllerTest, NoHeadlineWhenEveryLevelFailed) {
    const std::vector<CapacityWindow> history{ window (10, 5000, 1.0, 100.0),
        window (10, 5100, 1.0, 100.0) };
    const auto decision = decide_next_level (search (), history);
    EXPECT_STREQ (decision.stop_reason, stop::ERRORS_EXCEEDED);

    const auto summary = summarize_capacity (search (), history, decision.stop_reason);
    EXPECT_FALSE (summary.max_healthy.has_value ());
    ASSERT_HAS_VALUE (summary.knee);
    EXPECT_EQ (summary.knee->concurrency, 10u);
}

TEST (CapacityControllerTest, PayloadCarriesTheErrorShareAndItsLimit) {
    const auto summary = summarize_capacity (search (),
    { window (10, 5000, 1.0, 0.0), window (20, 9000, 2.0, 60.0), window (20, 9100, 2.0, 70.0) },
    stop::ERRORS_EXCEEDED);
    const auto payload = build_capacity_summary_payload (summary);

    EXPECT_DOUBLE_EQ (payload["max_error_pct"].get<double> (), search ().max_error_pct);
    EXPECT_DOUBLE_EQ (payload["knee_error_pct"].get<double> (), 70.0);
    EXPECT_DOUBLE_EQ (payload["levels"][1]["error_pct"].get<double> (), 60.0);
    EXPECT_EQ (payload["stop_reason"], "errors_exceeded");
}

// A level of only refused connections holds no completion, so its 0 is what
// tells a reader its p99 measured nothing (#2926): the key is always written.
TEST (CapacityControllerTest, PayloadCarriesTheCompletionsEachLevelWasJudgedOn) {
    const auto summary = summarize_capacity (search (),
    { window (10, 5000, 1.0, 0.0, 4800), window (20, 0, 0.0, 100.0, 0) },
    stop::ERRORS_EXCEEDED);
    const auto payload = build_capacity_summary_payload (summary);

    ASSERT_EQ (payload["levels"].size (), 2u);
    EXPECT_EQ (payload["levels"][0]["samples"], 4800u);
    ASSERT_TRUE (payload["levels"][1].contains ("samples"));
    EXPECT_EQ (payload["levels"][1]["samples"], 0u);
}

TEST (CapacityControllerTest, PayloadOmitsWhatWasNotObserved) {
    const auto summary = summarize_capacity (search (),
    { window (10, 90, 400.0), window (10, 88, 420.0) }, stop::SLO_EXCEEDED);
    const auto payload = build_capacity_summary_payload (summary);

    EXPECT_FALSE (payload.contains ("max_healthy_concurrency"));
    EXPECT_TRUE (payload.contains ("knee_concurrency"));
    EXPECT_FALSE (payload.contains ("saturation_concurrency"));
    EXPECT_FALSE (payload.contains ("saturation_rps"));
    EXPECT_FALSE (payload.contains ("saturation_p99_ms"));
    EXPECT_EQ (payload["stop_reason"], "slo_exceeded");
    EXPECT_EQ (payload["levels"].size (), 2u);
    EXPECT_EQ (payload["levels"][0]["concurrency"], 10u);
}

// ---------------------------------------------------------------------------
// Saturation: where a plateau's throughput stopped growing (#2817)
// ---------------------------------------------------------------------------

/// A search whose budget the plateau history below stays inside (its levels
/// run to a 103ms p99).
CapacityConfig roomy_search () {
    CapacityConfig config = search ();
    config.slo_ms         = 200.0;
    return config;
}

/// Throughput flat at 156 from level 8 up while p99 doubles: the search keeps
/// stepping until two step-ups bought nothing, so the last level tried (12) is
/// two levels past where throughput stopped growing.
std::vector<CapacityWindow> flat_from_eight () {
    return { window (4, 90, 20.0), window (6, 130, 31.0), window (8, 156, 52.0),
        window (10, 156, 103.0), window (12, 156, 103.0) };
}

// Mutation-check: set `saturation` to `max_healthy` and this reports 12.
TEST (CapacityControllerTest, APlateauReportsWhereThroughputStoppedGrowing) {
    const auto history  = flat_from_eight ();
    const auto decision = decide_next_level (roomy_search (), history);
    ASSERT_EQ (decision.action, CapacityAction::Stop);
    ASSERT_STREQ (decision.stop_reason, stop::PLATEAU);

    const auto summary = summarize_capacity (roomy_search (), history, decision.stop_reason);
    ASSERT_HAS_VALUE (summary.saturation);
    EXPECT_EQ (summary.saturation->concurrency, 8u);
    EXPECT_DOUBLE_EQ (summary.saturation->rps, 156.0);
    EXPECT_DOUBLE_EQ (summary.saturation->p99_ms, 52.0);

    ASSERT_HAS_VALUE (summary.max_healthy);
    EXPECT_EQ (summary.max_healthy->concurrency, 12u);
}

TEST (CapacityControllerTest, SaturationIsTheLowestLevelWithinTheGainOfTheBest) {
    // 10 -> 14 gained 4%, under the 5% plateau gain, so 10 is where the curve
    // went flat; 12 is within the gain too but is not the lowest.
    const std::vector<CapacityWindow> history{ window (8, 120, 30.0),
        window (10, 150, 40.0), window (12, 155, 50.0), window (14, 156, 60.0) };
    const auto summary = summarize_capacity (roomy_search (), history, stop::PLATEAU);

    ASSERT_HAS_VALUE (summary.saturation);
    EXPECT_EQ (summary.saturation->concurrency, 10u);
}

TEST (CapacityControllerTest, SaturationMeasuresTheGainAgainstTheLowerLevel) {
    // 148 -> 156 is 5.4% of the lower level: just over the gain, though it is
    // 5.1% of the higher one. `plateaued` measures against the lower level, so
    // 10 is the answer, not 8.
    const std::vector<CapacityWindow> history{ window (8, 148, 30.0),
        window (10, 156, 40.0), window (12, 156, 50.0) };
    const auto summary = summarize_capacity (roomy_search (), history, stop::PLATEAU);

    ASSERT_HAS_VALUE (summary.saturation);
    EXPECT_EQ (summary.saturation->concurrency, 10u);
}

TEST (CapacityControllerTest, SaturationReadsAReMeasuredLevelByItsLastWindow) {
    const std::vector<CapacityWindow> history{ window (8, 90, 300.0),
        window (8, 156, 52.0), window (10, 156, 60.0), window (12, 156, 70.0) };
    const auto summary = summarize_capacity (roomy_search (), history, stop::PLATEAU);

    ASSERT_HAS_VALUE (summary.saturation);
    EXPECT_EQ (summary.saturation->concurrency, 8u);
    EXPECT_DOUBLE_EQ (summary.saturation->p99_ms, 52.0);
}

// Mutation-check: drop the `breaches` filter and the 400 rps level, which gave
// out on latency, becomes both the best throughput and the saturation level.
TEST (CapacityControllerTest, ABreachedLevelIsNeverTheSaturationLevel) {
    const std::vector<CapacityWindow> history{ window (8, 100, 50.0),
        window (10, 400, 900.0), window (12, 500, 20.0, 40.0), window (14, 101, 60.0) };
    const auto summary = summarize_capacity (roomy_search (), history, stop::PLATEAU);

    ASSERT_HAS_VALUE (summary.saturation);
    EXPECT_EQ (summary.saturation->concurrency, 8u);
    EXPECT_DOUBLE_EQ (summary.saturation->rps, 100.0);
}

TEST (CapacityControllerTest, NoSaturationWhenNoLevelDeliveredAnyThroughput) {
    const std::vector<CapacityWindow> history{ window (8, 0, 5.0), window (10, 0, 5.0) };
    EXPECT_FALSE (
    summarize_capacity (roomy_search (), history, stop::PLATEAU).saturation.has_value ());
    EXPECT_FALSE (
    summarize_capacity (roomy_search (), {}, stop::PLATEAU).saturation.has_value ());
}

TEST (CapacityControllerTest, OnlyAPlateauReportsSaturation) {
    for (const char* reason : { stop::SLO_EXCEEDED, stop::ERRORS_EXCEEDED,
         stop::CAP_REACHED, stop::DEADLINE, stop::STOPPED }) {
        const auto summary =
        summarize_capacity (roomy_search (), flat_from_eight (), reason);
        EXPECT_FALSE (summary.saturation.has_value ()) << reason;
    }
}

TEST (CapacityControllerTest, PayloadCarriesSaturationOnAPlateauOnly) {
    const auto plateau = build_capacity_summary_payload (
    summarize_capacity (roomy_search (), flat_from_eight (), stop::PLATEAU));
    EXPECT_EQ (plateau["saturation_concurrency"], 8u);
    EXPECT_DOUBLE_EQ (plateau["saturation_rps"].get<double> (), 156.0);
    EXPECT_DOUBLE_EQ (plateau["saturation_p99_ms"].get<double> (), 52.0);
    EXPECT_EQ (plateau["max_healthy_concurrency"], 12u);

    const auto capped = build_capacity_summary_payload (
    summarize_capacity (roomy_search (), flat_from_eight (), stop::CAP_REACHED));
    EXPECT_FALSE (capped.contains ("saturation_concurrency"));
    EXPECT_FALSE (capped.contains ("saturation_rps"));
    EXPECT_FALSE (capped.contains ("saturation_p99_ms"));
}

// ---------------------------------------------------------------------------
// Reading the config off a run body
// ---------------------------------------------------------------------------

TEST (CapacityControllerTest, ConfigReadsTheDeclaredBounds) {
    const nlohmann::json config = { { "mode", "capacity" }, { "sloMs", 50 },
        { "startConcurrency", 4 }, { "concurrency", 512 } };
    const auto parsed = vayu::core::capacity_config_from (config, 3000, 120000);

    EXPECT_DOUBLE_EQ (parsed.slo_ms, 50.0);
    EXPECT_EQ (parsed.start_concurrency, 4u);
    EXPECT_EQ (parsed.max_concurrency, 512u);
    EXPECT_EQ (parsed.step_duration_ms, 3000);
    EXPECT_EQ (parsed.deadline_ms, 120000);
    EXPECT_DOUBLE_EQ (parsed.max_error_pct, vayu::core::constants::capacity::ERROR_RATE_PCT);
}

TEST (CapacityControllerTest, ACapBelowTheStartBecomesASingleLevelSearch) {
    // Reachable from a hand-edited config snapshot, where there is no route to
    // reject it. The search runs the start level once and stops `cap_reached`
    // rather than climbing past a ceiling it was given.
    const nlohmann::json config = { { "startConcurrency", 64 }, { "concurrency", 8 } };
    const auto parsed = vayu::core::capacity_config_from (config, 5000, 60000);

    EXPECT_EQ (parsed.start_concurrency, 64u);
    EXPECT_EQ (parsed.max_concurrency, 64u);

    const auto decision = decide_next_level (parsed, { window (64, 5000, 10.0) });
    EXPECT_EQ (decision.action, CapacityAction::Stop);
    EXPECT_STREQ (decision.stop_reason, stop::CAP_REACHED);
}

TEST (CapacityControllerTest, AnAbsurdConcurrencyIsClampedRatherThanCastPastSizeMax) {
    // Reachable only from a hand-edited config snapshot - the route rejects it -
    // but this function is documented total over stored snapshots. `1e30` is
    // finite and positive, so the type guard passes it through; narrowing it to
    // `size_t` is undefined behaviour, and in practice yields 0 or an arbitrary
    // huge value depending on the platform. Either way the search would run at a
    // level nobody asked for.
    const nlohmann::json config = { { "startConcurrency", 1e30 }, { "concurrency", 1e30 } };
    const auto parsed = vayu::core::capacity_config_from (config, 5000, 60000);

    const auto guard =
    static_cast<size_t> (vayu::core::constants::run_config::MAX_CONCURRENCY);
    EXPECT_EQ (parsed.start_concurrency, guard);
    EXPECT_EQ (parsed.max_concurrency, guard);
    // The point of the clamp: a usable level, not a zero the search would spin
    // at forever nor a number no allocator can honour.
    EXPECT_GT (parsed.start_concurrency, 0u);
}

TEST (CapacityControllerTest, AnUnusableSloFallsBackToTheDefault) {
    const nlohmann::json config = { { "sloMs", "fast" } };
    EXPECT_DOUBLE_EQ (vayu::core::capacity_config_from (config, 5000, 60000).slo_ms,
    static_cast<double> (vayu::core::constants::capacity::SLO_MS));
}

// ---------------------------------------------------------------------------
// The feedback path's one rule
// ---------------------------------------------------------------------------

/**
 * `sample_window_percentiles()` is documented single-reader and *resets* the
 * rolling window on read, so a second production caller silently halves both
 * readers' sample counts - the live chart and the capacity search would each
 * see about half the run's completions and neither would look wrong.
 * `take_second_percentiles()` (#2385) is the same kind of call: it resets the
 * second the stored row is built from, so a second taker would leave the row
 * holding a fragment of its second. The level histogram's two calls (#2388)
 * are producer-thread-only for the same reason: it has no atomics.
 *
 * That is why the strategy steers by `RunContext::latest_live_tick()` rather
 * than sampling the collector itself, and it is a property no behavioural test
 * can see: the wrong version still runs, it just measures less. So it is
 * scanned for, and the scan asserts it read something first - a guard reading
 * an empty string passes forever.
 */
TEST (CapacityControllerTest, TheWindowedPercentilesHaveExactlyOneProductionCaller) {
    const std::filesystem::path root =
    std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "src";
    ASSERT_TRUE (std::filesystem::exists (root));

    size_t total_bytes = 0;
    std::vector<std::pair<std::string, std::string>> sources;
    for (const auto& entry : std::filesystem::recursive_directory_iterator (root)) {
        if (!entry.is_regular_file () || entry.path ().extension () != ".cpp") {
            continue;
        }
        // The definitions are not call sites.
        if (entry.path ().filename () == "metrics_collector.cpp") {
            continue;
        }
        std::ifstream file (entry.path ());
        std::stringstream buffer;
        buffer << file.rdbuf ();
        total_bytes += buffer.str ().size ();
        sources.emplace_back (entry.path ().filename ().string (), buffer.str ());
    }

    ASSERT_GT (sources.size (), 10u) << "the scan found no sources to read";
    ASSERT_GT (total_bytes, 1000u) << "the scan read empty files";
    for (const std::string_view call : { "sample_window_percentiles (",
         "take_second_percentiles (", "adopt_level_epoch (", "level_latency (" }) {
        std::vector<std::string> callers;
        for (const auto& [name, source] : sources) {
            if (source.find (call) != std::string::npos) {
                callers.push_back (name);
            }
        }
        ASSERT_EQ (callers.size (), 1u)
        << "expected only run_manager.cpp's metrics thread to call " << call
        << "; the capacity strategy must read RunContext::latest_live_tick()";
        EXPECT_EQ (callers.front (), "run_manager.cpp") << call;
    }
}

} // namespace
