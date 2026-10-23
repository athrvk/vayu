/**
 * @file histogram_ceiling_test.cpp
 * @brief A completion past the latency histograms' ceiling is saturated into
 *        the top bucket, never dropped (#2790).
 *
 * `hdr_record_value_atomic` refuses a value above `HISTOGRAM_MAX_LATENCY_US`
 * and counts nothing, and a request `timeout` may be set to 24 h, so every
 * record site clamps. One test per site; each records a 90-minute completion
 * beside two ordinary ones and asserts the long one is counted and is the max.
 */

#include <gtest/gtest.h>

#include <cstdint>
#include <limits>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/metrics_collector.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/transaction_histograms.hpp"

using namespace vayu::core;
using nlohmann::json;

namespace {

constexpr double NINETY_MINUTES_MS = 90.0 * 60.0 * 1000.0;

constexpr double CEILING_MS =
static_cast<double> (constants::metrics_collector::HISTOGRAM_MAX_LATENCY_US) / 1000.0;

static_assert (NINETY_MINUTES_MS > CEILING_MS, "the test value must be past the ceiling");

/// A histogram holds a value to 3 significant figures, so the top bucket reads
/// back within 0.1% of the ceiling it was clamped to. A dropped completion
/// would leave the ordinary 20 ms in its place.
void expect_saturated_at_ceiling (double actual_ms, const std::string& what) {
    EXPECT_NEAR (actual_ms, CEILING_MS, CEILING_MS * 0.001) << what;
}

} // namespace

TEST (HistogramCeilingHelpers, ClampAtTheCeilingAndHoldTheFloor) {
    constexpr int64_t ceiling = constants::metrics_collector::HISTOGRAM_MAX_LATENCY_US;

    EXPECT_EQ (histogram_latency_us (NINETY_MINUTES_MS, 1), ceiling);
    EXPECT_EQ (histogram_latency_us (1.0e18, 0), ceiling)
    << "a duration past int64 range must clamp in double, before the cast";
    EXPECT_EQ (histogram_latency_us (CEILING_MS, 0), ceiling);
    EXPECT_EQ (histogram_latency_us (12.5, 1), 12500);

    EXPECT_EQ (histogram_latency_us (0.0, 1), 1) << "the latency floor is 1us";
    EXPECT_EQ (histogram_latency_us (0.0, 0), 0)
    << "a phase that did not run stays 0";
    EXPECT_EQ (histogram_latency_us (-5.0, 0), 0);
    EXPECT_EQ (histogram_latency_us (std::numeric_limits<double>::quiet_NaN (), 1), 1);

    EXPECT_EQ (clamp_to_histogram_ceiling (ceiling + 1), ceiling);
    EXPECT_EQ (clamp_to_histogram_ceiling (ceiling), ceiling);
    EXPECT_EQ (clamp_to_histogram_ceiling (42), 42);
}

TEST (HistogramCeiling, TheRunHistogramAndTheLiveWindowKeepACompletionPastTheCeiling) {
    MetricsCollectorConfig config;
    config.expected_requests = 10;
    MetricsCollector collector ("ceiling_run", config);

    collector.record_success (200, 10.0, 0.0);
    collector.record_success (200, NINETY_MINUTES_MS, 0.0);
    collector.record_success (200, 20.0, 0.0);

    EXPECT_EQ (collector.latency_count (), 3)
    << "the 90-minute completion was refused by the histogram";
    const auto cumulative = collector.calculate_percentiles ();
    expect_saturated_at_ceiling (cumulative.max, "cumulative max");
    expect_saturated_at_ceiling (cumulative.p99, "cumulative p99");

    // The rolling window is a second histogram fed from the same value.
    const auto window = collector.sample_window_percentiles ();
    EXPECT_EQ (window.count, 3u)
    << "the interval recorder dropped the completion";
    expect_saturated_at_ceiling (window.max, "window max");
    expect_saturated_at_ceiling (window.p99, "window p99");
}

TEST (HistogramCeiling, AFailedTransferPastTheCeilingJoinsTheLatencyPopulation) {
    MetricsCollectorConfig config;
    config.expected_requests = 10;
    MetricsCollector collector ("ceiling_error", config);

    collector.record_error (vayu::ErrorCode::Timeout, "timed out", "", nullptr,
    AttemptDuration{ .latency_ms = NINETY_MINUTES_MS, .queue_wait_ms = 0.0 });

    EXPECT_EQ (collector.latency_count (), 1);
    expect_saturated_at_ceiling (collector.calculate_percentiles ().max, "max");
}

TEST (HistogramCeiling, EveryPhaseHistogramKeepsAPhasePastTheCeiling) {
    MetricsCollectorConfig config;
    config.expected_requests = 10;
    config.phase_histograms  = true;
    MetricsCollector collector ("ceiling_phases", config);

    vayu::Timing ordinary;
    ordinary.dns_ms = ordinary.connect_ms = ordinary.tls_ms = 1.0;
    ordinary.first_byte_ms = ordinary.download_ms = 1.0;
    vayu::Timing stalled;
    stalled.dns_ms = stalled.connect_ms = stalled.tls_ms = NINETY_MINUTES_MS;
    stalled.first_byte_ms = stalled.download_ms = NINETY_MINUTES_MS;

    collector.record_success (200, 1.0, 0.0, "", SuccessTraceReason::None, nullptr, &ordinary);
    collector.record_success (200, 1.0, 0.0, "", SuccessTraceReason::None, nullptr, &stalled);
    collector.record_success (200, 1.0, 0.0, "", SuccessTraceReason::None, nullptr, &ordinary);

    const auto phases = collector.phase_percentiles ();
    ASSERT_HAS_VALUE (phases);
    for (size_t i = 0; i < TIMING_PHASE_COUNT; ++i) {
        const std::string phase = TIMING_PHASE_KEYS.at (i);
        EXPECT_EQ (phases->at (i).count, 3u) << phase;
        expect_saturated_at_ceiling (phases->at (i).max, phase + " max");
        expect_saturated_at_ceiling (phases->at (i).p99, phase + " p99");
    }
}

TEST (HistogramCeiling, AStepHistogramKeepsACompletionPastTheCeiling) {
    StepHistograms steps (2);

    steps.record (0, 10.0);
    steps.record (0, NINETY_MINUTES_MS);
    steps.record (0, 20.0);
    steps.record_error (1);
    steps.record_failed_transfer (1, NINETY_MINUTES_MS);

    EXPECT_EQ (steps.completed (0), 3u);
    EXPECT_EQ (steps.latency_samples (0), 3u)
    << "the histogram dropped a completion";
    expect_saturated_at_ceiling (steps.percentiles (0).max, "step 0 max");
    expect_saturated_at_ceiling (steps.percentiles (0).p99, "step 0 p99");

    EXPECT_EQ (steps.latency_samples (1), 1u)
    << "a timed-out transfer's duration is a sample of its own step";
    expect_saturated_at_ceiling (steps.percentiles (1).max, "step 1 max");
}

TEST (HistogramCeiling, ATransactionCompletionPastTheCeilingIsCounted) {
    const json transaction = { { "id", "el_txn" }, { "kind", "control.transaction" },
        { "enabled", true }, { "config", { { "name", "checkout" } } } };
    ScenarioPlan plan;
    ScenarioStep step;
    step.index      = 0;
    step.name       = "m0";
    step.request_id = "req_m0";
    step.elements   = vayu::tests::compiled_elements ({ transaction });
    plan.steps.push_back (std::move (step));

    TransactionHistograms histograms (plan);
    histograms.record ("checkout", 10'000, false);
    histograms.record ("checkout", static_cast<int64_t> (NINETY_MINUTES_MS * 1000.0), false);
    histograms.record ("checkout", 20'000, false);

    const json rows = histograms.build ();
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_EQ (rows[0]["count"].get<size_t> (), 3u);
    const json& latency = rows[0]["latency"];
    expect_saturated_at_ceiling (latency["max"].get<double> (), "transaction max");
    expect_saturated_at_ceiling (latency["p99"].get<double> (), "transaction p99");
    EXPECT_NEAR (latency["min"].get<double> (), 10.0, 0.1)
    << "the ordinary sums are unaffected by the clamp";
}
