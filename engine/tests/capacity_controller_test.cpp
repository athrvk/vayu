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

CapacityWindow window (size_t concurrency, double rps, double p99_ms) {
    return CapacityWindow{ concurrency, rps, p99_ms };
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
    CapacityConfig config = search ();
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
    const auto decision =
    decide_next_level (search (), { window (40, 4000, 20.0), window (50, 4200, 180.0) });
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
    const auto decision =
    decide_next_level (search (), { window (100, 20000, 300.0), window (100, 19000, 320.0) });
    EXPECT_EQ (decision.action, CapacityAction::Stop);
    EXPECT_STREQ (decision.stop_reason, stop::SLO_EXCEEDED);
}

// ---------------------------------------------------------------------------
// Summarizing what the search found
// ---------------------------------------------------------------------------

TEST (CapacityControllerTest, KneeIsTheLevelThatGaveOutAndHeadlineIsTheLastThatHeld) {
    const std::vector<CapacityWindow> history{ window (10, 1000, 5.0), window (48, 23400, 41.2),
        window (64, 23000, 300.0), window (64, 22800, 312.0) };
    const auto summary = summarize_capacity (search (), history, stop::SLO_EXCEEDED);

    ASSERT_TRUE (summary.max_healthy.has_value ());
    EXPECT_EQ (summary.max_healthy->concurrency, 48u);
    EXPECT_DOUBLE_EQ (summary.max_healthy->rps, 23400.0);
    EXPECT_DOUBLE_EQ (summary.max_healthy->p99_ms, 41.2);

    ASSERT_TRUE (summary.knee.has_value ());
    EXPECT_EQ (summary.knee->concurrency, 64u);
    EXPECT_DOUBLE_EQ (summary.knee->p99_ms, 312.0);
    EXPECT_GT (summary.knee->p99_ms, summary.slo_ms);

    EXPECT_EQ (summary.stop_reason, stop::SLO_EXCEEDED);
    EXPECT_EQ (summary.levels.size (), 4u); // the audit trail keeps the hold
}

TEST (CapacityControllerTest, NoKneeWhenTheSearchNeverSawTheServiceGiveOut) {
    const std::vector<CapacityWindow> history{ window (10, 1000, 5.0), window (100, 9000, 40.0) };
    const auto summary = summarize_capacity (search (), history, stop::CAP_REACHED);

    ASSERT_TRUE (summary.max_healthy.has_value ());
    EXPECT_EQ (summary.max_healthy->concurrency, 100u);
    EXPECT_FALSE (summary.knee.has_value ());
}

TEST (CapacityControllerTest, NoHeadlineWhenTheFirstLevelAlreadyBreached) {
    const std::vector<CapacityWindow> history{ window (10, 90, 400.0), window (10, 88, 420.0) };
    const auto summary = summarize_capacity (search (), history, stop::SLO_EXCEEDED);

    EXPECT_FALSE (summary.max_healthy.has_value ());
    ASSERT_TRUE (summary.knee.has_value ());
    EXPECT_EQ (summary.knee->concurrency, 10u);
}

TEST (CapacityControllerTest, PayloadOmitsWhatWasNotObserved) {
    const auto summary =
    summarize_capacity (search (), { window (10, 90, 400.0), window (10, 88, 420.0) },
    stop::SLO_EXCEEDED);
    const auto payload = build_capacity_summary_payload (summary);

    EXPECT_FALSE (payload.contains ("max_healthy_concurrency"));
    EXPECT_TRUE (payload.contains ("knee_concurrency"));
    EXPECT_EQ (payload["stop_reason"], "slo_exceeded");
    EXPECT_EQ (payload["levels"].size (), 2u);
    EXPECT_EQ (payload["levels"][0]["concurrency"], 10u);
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
 *
 * That is why the strategy steers by `RunContext::latest_live_tick()` rather
 * than sampling the collector itself, and it is a property no behavioural test
 * can see: the wrong version still runs, it just measures less. So it is
 * scanned for, and the scan asserts it read something first - a guard reading
 * an empty string passes forever.
 */
TEST (CapacityControllerTest, TheWindowedPercentilesHaveExactlyOneProductionCaller) {
    const std::filesystem::path root = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "src";
    ASSERT_TRUE (std::filesystem::exists (root));

    size_t files_scanned = 0;
    size_t total_bytes   = 0;
    std::vector<std::string> callers;
    for (const auto& entry : std::filesystem::recursive_directory_iterator (root)) {
        if (!entry.is_regular_file () || entry.path ().extension () != ".cpp") {
            continue;
        }
        std::ifstream file (entry.path ());
        std::stringstream buffer;
        buffer << file.rdbuf ();
        const std::string source = buffer.str ();
        ++files_scanned;
        total_bytes += source.size ();

        // The definition itself is not a call site.
        if (entry.path ().filename () == "metrics_collector.cpp") {
            continue;
        }
        if (source.find ("sample_window_percentiles (") != std::string::npos) {
            callers.push_back (entry.path ().filename ().string ());
        }
    }

    ASSERT_GT (files_scanned, 10u) << "the scan found no sources to read";
    ASSERT_GT (total_bytes, 1000u) << "the scan read empty files";
    ASSERT_EQ (callers.size (), 1u)
    << "expected only run_manager.cpp's metrics thread to sample the rolling "
       "window; the capacity strategy must read RunContext::latest_live_tick()";
    EXPECT_EQ (callers.front (), "run_manager.cpp");
}

} // namespace
