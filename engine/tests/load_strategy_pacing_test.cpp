/**
 * @file tests/load_strategy_pacing_test.cpp
 * @brief Load strategies: constant-rate pacing and its totals, ramps and durations, outlier and
 * sampled capture, script time in the recorded latency, phase histograms and the spin tail.
 *
 * The `LoadStrategyTest` fixture is in `load_strategy_fixture.hpp`.
 */

#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/load_strategy.hpp"

#include <gtest/gtest.h>

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"

#include "load_strategy_fixture.hpp"

using vayu::tests::load_strategy::LoadStrategyTest;
using vayu::tests::load_strategy::TEST_DB_PATH;
using vayu::tests::load_strategy::timed_out_response;

namespace {

// What an open-loop run accounted for.
struct PacedRun {
    size_t sent       = 0;
    size_t skipped    = 0;
    size_t dropped    = 0;
    size_t expected   = 0;
    double stalled_ms = 0.0;
};

PacedRun run_constant_rps (double rps,
const char* duration,
const std::string& url,
const nlohmann::json& extra = nlohmann::json::object ()) {
    nlohmann::json config = { { "mode", "constant_rps" },
        { "duration", duration }, { "targetRps", rps } };
    config.update (extra);
    auto context = std::make_shared<vayu::core::RunContext> ("test-rps-exact", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = url;
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    vayu::core::LoadStrategy::create (config)->execute (context, db, request);
    context->event_loop->stop (false);

    return { context->requests_sent.load (),
        context->metrics_collector->skipped_requests (),
        context->metrics_collector->dropped_requests (),
        context->requests_expected.load (), context->metrics_collector->stalled_ms () };
}

// A slow runner can stall the pacer past its catch-up window (#2911), so what
// is exact is the sum, not `sent` alone.
void expect_exactly (const PacedRun& run, size_t owed) {
    EXPECT_EQ (run.expected, owed) << "requests_expected";
    EXPECT_EQ (run.sent + run.skipped + run.dropped, owed)
    << "sent " << run.sent << ", skipped " << run.skipped << ", dropped " << run.dropped;
    EXPECT_EQ (run.dropped, 0u) << "an unsaturated run dropped requests";
}

} // namespace

// An unsaturated constant_rps run accounts for floor(targetRps x duration),
// not one fewer (#2910), as sent or skipped (#2911). Mutation check: accrue
// from per-tick deltas truncated with `duration_cast<microseconds>` again, and
// each of these is one short.
TEST_F (LoadStrategyTest, ConstantRpsSendsExactlyRateTimesDuration) {
    expect_exactly (run_constant_rps (200.0, "2s", mock_server->fast_url ()), 400);
}

TEST_F (LoadStrategyTest, ConstantRpsSendsExactlyRateTimesDurationAbove1000) {
    expect_exactly (run_constant_rps (3000.0, "2s", mock_server->fast_url ()), 6000);
}

TEST_F (LoadStrategyTest, ConstantRpsSendsExactlyRateTimesDurationBelowOne) {
    expect_exactly (run_constant_rps (0.5, "4s", mock_server->fast_url ()), 2);
}

// 33.3 x 3 is 99.9: the schedule owes request k at k / 33.3, the 99th at
// 2.973s, and the 100th would be due after the deadline.
TEST_F (LoadStrategyTest, ConstantRpsSendsTheFlooredProductOfAFractionalRate) {
    expect_exactly (run_constant_rps (33.3, "3s", mock_server->fast_url ()), 99);
}

// A pacer stalled past its catch-up window skips that backlog rather than
// bursting it (#2911), and the skips close the books. The stall is injected:
// an inline `script.pre` runs on the pacing thread and holds it 250 ms per
// submission, so at 10 RPS the third tick wakes at least 400 ms after it was
// due however fast the runner is; a slower runner only skips more.
// Mutation check: drop the `record_skipped_batch` call from `pay_out_tick` and
// the skips read 0 and the sum comes up short.
TEST_F (LoadStrategyTest, AStalledPacerSkipsItsBacklogAndAccountsForEveryRequest) {
    const nlohmann::json stall = { { "requestElements",
    nlohmann::json::array ({ nlohmann::json{ { "kind", "script.pre" },
    { "config",
    { { "script", "const until = Date.now () + 250; while (Date.now () < until) {}" },
    { "inline", true } } } } }) } };

    const auto run = run_constant_rps (10.0, "1s", mock_server->fast_url (), stall);

    expect_exactly (run, 10);
    EXPECT_GT (run.skipped, 0u)
    << "a 250 ms stall per submission skipped nothing";
    EXPECT_DOUBLE_EQ (run.stalled_ms, static_cast<double> (run.skipped) * 100.0)
    << "stalledMs is the skipped requests' share of the schedule at 10 RPS";
}

// Ramp down (start > target) is a legitimate profile. The size_t delta
// underflowed to ~1.8e19, so the controller held an astronomical target and
// flooded at max capacity for the whole ramp instead of descending.
TEST_F (LoadStrategyTest, RampDownDescendsInsteadOfFlooding) {
    const size_t START    = 40;
    const size_t TARGET   = 5;
    nlohmann::json config = {
        { "mode", "ramp_up" },
        { "duration", "1500ms" },
        { "rampUpDuration", "1s" },
        { "startConcurrency", START },
        { "concurrency", TARGET },
    };

    auto context = std::make_shared<vayu::core::RunContext> ("test-ramp-down", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000; // ample, so only the ramp bounds in-flight
    loop_config.max_per_host = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->slow_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    EXPECT_LE (context->peak_in_flight.load (), START + 10)
    << "in-flight ran past the ramp start; the descending ramp is unbounded";
    EXPECT_GT (context->requests_sent.load (), 0u)
    << "ramp-down submitted nothing";
}

// Durations below a second are honored, so this run lasts 500ms rather than
// the 500 seconds the old parser read out of "500ms".
TEST_F (LoadStrategyTest, SubSecondDurationEndsOnTime) {
    nlohmann::json config = {
        { "mode", "constant_concurrency" },
        { "duration", "500ms" },
        { "concurrency", 5 },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-ms-duration", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 200;
    loop_config.max_per_host   = 200;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);

    const auto started = std::chrono::steady_clock::now ();
    strategy->execute (context, db, request);
    const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started)
                            .count ();
    context->event_loop->stop (false);

    EXPECT_GE (elapsed_ms, 400) << "ran shorter than the requested 500ms";
    EXPECT_LT (elapsed_ms, 5000)
    << "ran for " << elapsed_ms << "ms; \"500ms\" was not read as milliseconds";
}

// A duration the engine cannot read fails the run loudly. execute_load_test
// catches this and marks the run Failed; the old parser silently ran for 60s,
// so a mistyped duration looked like a run that merely took longer.
TEST_F (LoadStrategyTest, UnreadableDurationThrows) {
    nlohmann::json config = {
        { "mode", "constant_concurrency" },
        { "duration", "5 fortnights" },
        { "concurrency", 5 },
    };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-bad-duration", config);
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = mock_server->fast_url ();

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    EXPECT_THROW (strategy->execute (context, db, request), std::invalid_argument);
}

// A zero-length closed-loop run submits nothing. The controller seeded
// target(0) before evaluating its own stop predicate, so a 0s duration still
// fired a full concurrency's worth of requests.
TEST_F (LoadStrategyTest, ZeroDurationSubmitsNothing) {
    nlohmann::json config = {
        { "mode", "constant_concurrency" },
        { "duration", "0s" },
        { "concurrency", 50 },
    };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-zero-duration", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 200;
    loop_config.max_per_host   = 200;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    EXPECT_EQ (context->requests_sent.load (), 0u)
    << "a 0s run submitted a seed before checking its own duration";
}

// The quota modes reach the same place by their budget rather than by the new
// predicate check - 0 iterations is 0 requests. Locked so a later change to
// either guard cannot make a no-op run submit a seed.
TEST_F (LoadStrategyTest, ZeroIterationsSubmitsNothing) {
    nlohmann::json config = {
        { "mode", "iterations" },
        { "iterations", 0 },
        { "concurrency", 10 },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-zero-iter", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 200;
    loop_config.max_per_host   = 200;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    EXPECT_EQ (context->requests_sent.load (), 0u)
    << "a 0-iteration run submitted a seed before checking its own budget";
}

// ============================================================================
// Completion handling: what a run keeps, and what it never builds
// ============================================================================

namespace {
// A completion as the event loop hands it to handle_result: a Response with a
// timing breakdown, carried by an ok Result.
vayu::Result<vayu::Response> completion (double latency_ms) {
    vayu::Response response;
    response.status_code          = 200;
    response.timing.total_ms      = latency_ms;
    response.timing.wire_ms       = latency_ms;
    response.timing.first_byte_ms = latency_ms / 2.0;
    return vayu::Result<vayu::Response> (response);
}
} // namespace

// Finding 3, end to end through the path a run actually takes: with the
// timing-breakdown toggle at its default (off) and a threshold set, an outlier
// is stored and carries `isSlow` - the empirical repro in the issue returned
// an empty `results` array.
TEST_F (LoadStrategyTest, SlowCompletionIsCapturedWithTimingBreakdownOff) {
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "slow_threshold_ms", 100 },
        { "save_timing_breakdown", false },
    };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-slow-capture", config);
    vayu::db::Database db (TEST_DB_PATH);

    vayu::core::handle_result (context, db, completion (5.0));   // fast
    vayu::core::handle_result (context, db, completion (500.0)); // outlier

    const auto& slow = context->metrics_collector->slow_results ();
    ASSERT_EQ (slow.size (), 1u)
    << "the outlier's trace was built because it crossed the threshold, then "
       "discarded because storage was gated on save_timing_breakdown";
    auto trace = nlohmann::json::parse (slow[0].trace_data);
    EXPECT_TRUE (trace["isSlow"].get<bool> ());
    EXPECT_EQ (trace["thresholdMs"].get<int> (), 100);
    // The fast completion built nothing and stored nothing.
    EXPECT_TRUE (context->metrics_collector->success_results ().empty ());
    EXPECT_EQ (context->metrics_collector->total_requests (), 2u);
}

// A threshold of 0 would make every completion an outlier, which is the same
// as making none - so it disables capture rather than storing the whole run.
TEST_F (LoadStrategyTest, AZeroThresholdDisablesOutlierCapture) {
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "slow_threshold_ms", 0 },
        { "save_timing_breakdown", false },
    };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-zero-threshold", config);
    vayu::db::Database db (TEST_DB_PATH);

    for (int i = 0; i < 50; ++i) {
        vayu::core::handle_result (context, db, completion (5.0));
    }

    EXPECT_TRUE (context->metrics_collector->slow_results ().empty ());
    EXPECT_EQ (context->metrics_collector->slow_results_dropped (), 0u);
}

namespace {
/// A scenario completion's annotations carrying @p script_ms of pipeline time,
/// the way the scenario executor hands them over under `includeScriptTime`.
vayu::core::ResultAnnotations with_script_time (double script_ms) {
    return vayu::core::ResultAnnotations{ std::nullopt, 0, 0, 1, script_ms };
}

constexpr double TRANSFER_MS = 10.0;
constexpr double SCRIPT_MS   = 40.0;
} // namespace

// #2792: the pipeline time a step's histogram folds under `includeScriptTime`
// reaches the run's latency population too, while the slow decision and the
// stored trace stay on the transfer the trace's phases describe. The
// threshold sits between the transfer (10) and the folded latency (50), so a
// slow decision read off the folded figure stores a trace. Mutation-check:
// drop `annotations.script_ms` from `latency` in record_successful_response
// and the average and max read 10.
TEST_F (LoadStrategyTest, ScriptTimeJoinsASuccessfulCompletionsRunLatency) {
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-script-time-success",
    nlohmann::json{ { "mode", "constant_rps" }, { "slow_threshold_ms", 30 } });
    vayu::db::Database db (TEST_DB_PATH);

    context->requests_sent++;
    vayu::core::handle_result (
    context, db, completion (TRANSFER_MS), with_script_time (SCRIPT_MS));

    auto& mc = *context->metrics_collector;
    EXPECT_DOUBLE_EQ (mc.average_latency (), TRANSFER_MS + SCRIPT_MS);
    EXPECT_NEAR (mc.calculate_percentiles ().max, TRANSFER_MS + SCRIPT_MS, 0.1);
    EXPECT_TRUE (mc.slow_results ().empty ())
    << "pipeline time made a 10ms transfer a slow outlier";
}

// The trace a retained completion stores keeps `totalMs` at the transfer, the
// figure its phase breakdown describes; the record's own latency is the run
// population's figure.
TEST_F (LoadStrategyTest, ScriptTimeLeavesAStoredTracesTotalOnTheTransfer) {
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-script-time-trace",
    nlohmann::json{ { "mode", "constant_rps" }, { "slow_threshold_ms", 5 } });
    vayu::db::Database db (TEST_DB_PATH);

    context->requests_sent++;
    vayu::core::handle_result (
    context, db, completion (TRANSFER_MS), with_script_time (SCRIPT_MS));

    const auto& slow = context->metrics_collector->slow_results ();
    ASSERT_EQ (slow.size (), 1u);
    EXPECT_DOUBLE_EQ (slow[0].latency_ms, TRANSFER_MS + SCRIPT_MS);
    const auto trace = nlohmann::json::parse (slow[0].trace_data);
    EXPECT_DOUBLE_EQ (trace["totalMs"].get<double> (), TRANSFER_MS);
}

// The same for a failed transfer (#2384's population): its attempt duration
// carries the pipeline time, its error trace's timing does not.
// Mutation-check: drop `annotations.script_ms` from the AttemptDuration in
// record_failed_response and the average reads 2000.
TEST_F (LoadStrategyTest, ScriptTimeJoinsAFailedTransfersRunLatency) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-script-time-failure", nlohmann::json{ { "mode", "constant_rps" } });
    vayu::db::Database db (TEST_DB_PATH);

    constexpr double TIMEOUT_MS = 2000.0;
    context->requests_sent++;
    vayu::core::handle_result (context, db,
    vayu::Result<vayu::Response> (timed_out_response (TIMEOUT_MS)),
    with_script_time (SCRIPT_MS));

    const auto& mc = *context->metrics_collector;
    EXPECT_EQ (mc.total_errors (), 1u);
    EXPECT_DOUBLE_EQ (mc.average_latency (), TIMEOUT_MS + SCRIPT_MS);
    ASSERT_EQ (mc.errors ().size (), 1u);
    EXPECT_DOUBLE_EQ (mc.errors ()[0].latency_ms, TIMEOUT_MS + SCRIPT_MS);
    const auto trace = nlohmann::json::parse (mc.errors ()[0].trace_data);
    EXPECT_DOUBLE_EQ (trace["timing"]["totalMs"].get<double> (), TIMEOUT_MS);
}

// Without the flag the executor passes 0, and the run records the transfer
// exactly as it did before #2792, on both the success and the failure path.
TEST_F (LoadStrategyTest, ZeroScriptTimeLeavesTheRunLatencyAtTheTransfer) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-script-time-zero", nlohmann::json{ { "mode", "constant_rps" } });
    vayu::db::Database db (TEST_DB_PATH);

    context->requests_sent += 2;
    vayu::core::handle_result (
    context, db, completion (TRANSFER_MS), with_script_time (0.0));
    vayu::core::handle_result (context, db,
    vayu::Result<vayu::Response> (timed_out_response (3.0 * TRANSFER_MS)),
    with_script_time (0.0));

    auto& mc = *context->metrics_collector;
    EXPECT_EQ (mc.latency_count (), 2);
    EXPECT_DOUBLE_EQ (mc.average_latency (), 2.0 * TRANSFER_MS);
    EXPECT_NEAR (mc.calculate_percentiles ().max, 3.0 * TRANSFER_MS, 0.1);
}

// Finding 2: only the sampled completions reach storage, and the period still
// means one in N of *every* completion. The trace that is not built leaves
// nothing to assert on directly - what is asserted is that no unsampled
// completion produced a record, i.e. nothing was built and then dropped.
TEST_F (LoadStrategyTest, OnlySampledCompletionsAreStored) {
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "slow_threshold_ms", 100000 }, // nothing here is an outlier
        { "save_timing_breakdown", true },
        { "success_sample_rate", 10 },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-sampled", config);
    vayu::db::Database db (TEST_DB_PATH);

    for (int i = 0; i < 500; ++i) {
        vayu::core::handle_result (context, db, completion (5.0));
    }

    EXPECT_EQ (context->metrics_collector->success_results ().size (), 50u);
    EXPECT_EQ (context->metrics_collector->success_results_dropped (), 0u);
    EXPECT_TRUE (context->metrics_collector->slow_results ().empty ());
}

// Findings 1 and 4: the per-completion config reads are resolved once, and
// `max_success_results` - which no route or config key could reach - now
// arrives from the run config like its four siblings.
TEST_F (LoadStrategyTest, RunContextResolvesTheSamplingConfigOnce) {
    nlohmann::json config = {
        { "slow_threshold_ms", 250 },
        { "save_timing_breakdown", true },
        { "success_sample_rate", 1 },
        { "max_success_results", 4 },
        { "max_slow_results", 2 },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-resolved", config);
    vayu::db::Database db (TEST_DB_PATH);

    EXPECT_EQ (context->slow_threshold_ms, 250);

    for (int i = 0; i < 20; ++i) {
        vayu::core::handle_result (context, db, completion (5.0));
        vayu::core::handle_result (context, db, completion (900.0));
    }

    EXPECT_EQ (context->metrics_collector->success_results ().size (), 4u);
    EXPECT_EQ (context->metrics_collector->slow_results ().size (), 2u);
    EXPECT_GT (context->metrics_collector->success_results_dropped (), 0u);
    EXPECT_GT (context->metrics_collector->slow_results_dropped (), 0u);

    // The default holds when the run config says nothing.
    nlohmann::json bare;
    auto stock = std::make_shared<vayu::core::RunContext> ("test-stock", bare);
    EXPECT_EQ (stock->slow_threshold_ms,
    vayu::core::constants::metrics_collector::DEFAULT_SLOW_THRESHOLD_MS);
}

// Issue #174: which completions get their response body captured is decided
// here, in the completion path, not by whichever retention budget the record
// lands in. The three buckets are errors, outliers and per-status exemplars; a
// plain 1-in-N sample is deliberately body-less, because a uniform slice of a
// long run is a thousand identical 200s.
//
// Mutation check: rank `Exemplar` above `Slow` again (the shape this replaced)
// and the outlier below stops reaching the slow store at all.
TEST_F (LoadStrategyTest, OutliersAndExemplarsCaptureBodiesButPlainSamplesDoNot) {
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "slow_threshold_ms", 100 },
        { "save_timing_breakdown", true },
        { "success_sample_rate", 1 }, // every completion is sampled
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-capture", config);
    vayu::db::Database db (TEST_DB_PATH);

    const size_t quota = vayu::core::constants::metrics_collector::EXEMPLARS_PER_STATUS;

    // Spend this status code's exemplar quota on fast completions, then send
    // one more fast completion and one outlier.
    for (size_t i = 0; i < quota; ++i) {
        vayu::core::handle_result (context, db, completion (5.0));
    }
    vayu::core::handle_result (context, db, completion (5.0)); // past the quota
    vayu::core::handle_result (context, db, completion (500.0)); // outlier

    // The outlier is charged to the slow budget, exactly as it was before
    // capture existed - being an early completion of its status code must not
    // move it out of the store that exists to hold outliers.
    const auto& slow = context->metrics_collector->slow_results ();
    ASSERT_EQ (slow.size (), 1u)
    << "the outlier was rerouted out of the slow store by the exemplar bucket";
    ASSERT_HAS_VALUE (slow[0].capture) << "an outlier must carry its body";

    // Every sampled fast completion is stored; the first `quota` of them
    // claimed an exemplar and kept a body, the one past the quota did not.
    const auto& sampled = context->metrics_collector->success_results ();
    ASSERT_EQ (sampled.size (), quota + 1);
    size_t with_body = 0;
    for (const auto& record : sampled) {
        if (record.capture.has_value ())
            with_body++;
    }
    EXPECT_EQ (with_body, quota)
    << "a plain 1-in-N sample must not carry a body, and an exemplar must";
}

// Capture off restores the completion path exactly: no exemplar is claimed, so
// nothing is rerouted, and no record carries a body.
TEST_F (LoadStrategyTest, CaptureOffLeavesTheCompletionPathUnchanged) {
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "slow_threshold_ms", 100 },
        { "save_timing_breakdown", true },
        { "success_sample_rate", 1 },
        { "capture_response_bodies", false },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-capture-off", config);
    vayu::db::Database db (TEST_DB_PATH);

    for (int i = 0; i < 5; ++i) {
        vayu::core::handle_result (context, db, completion (5.0));
    }
    vayu::core::handle_result (context, db, completion (500.0));

    EXPECT_TRUE (context->metrics_collector->exemplar_results ().empty ());
    EXPECT_EQ (context->metrics_collector->success_results ().size (), 5u);
    EXPECT_EQ (context->metrics_collector->slow_results ().size (), 1u);
    for (const auto& record : context->metrics_collector->success_results ()) {
        EXPECT_FALSE (record.capture.has_value ());
    }
    EXPECT_FALSE (context->metrics_collector->slow_results ()[0].capture.has_value ());
    EXPECT_EQ (context->metrics_collector->captured_body_bytes (), 0u);
}

// ============================================================================
// Per-phase histograms on the completion path (issue #476)
// ============================================================================

namespace {
/// A completion whose TTFB is set independently of its total, so a test can
/// make the sampled subset differ from the population on purpose.
vayu::Result<vayu::Response> completion_with_ttfb (double latency_ms, double first_byte_ms) {
    vayu::Response response;
    vayu::Result<vayu::Response> result = completion (latency_ms);
    response                            = result.value ();
    response.timing.first_byte_ms       = first_byte_ms;
    return vayu::Result<vayu::Response> (response);
}
} // namespace

// The point of the bank: the phase distribution covers every completion, not
// the ~1% a trace is retained for. The population here is deliberately
// bimodal, and the 1-in-10 sampler selects exactly the minority - so a feed
// gated on retention would report the *fast* value as the median.
//
// Mutation check: move the record_success phase argument inside the
// `sampled || is_slow || exemplar` branch in handle_result and both assertions
// below fail - the count drops to 50 and the p50 to 5ms.
TEST_F (LoadStrategyTest, PhaseHistogramsEscapeTheRetentionSample) {
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "slow_threshold_ms", 100000 }, // nothing here is an outlier
        { "save_timing_breakdown", true },
        { "success_sample_rate", 10 },
    };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-phase-escape", config);
    vayu::db::Database db (TEST_DB_PATH);

    // The sampler keeps completions 0, 10, 20, ... - the fast ones.
    for (int i = 0; i < 500; ++i) {
        vayu::core::handle_result (
        context, db, completion_with_ttfb (10.0, i % 10 == 0 ? 5.0 : 200.0));
    }

    EXPECT_EQ (context->metrics_collector->success_results ().size (), 50u);

    auto phases = context->metrics_collector->phase_percentiles ();
    ASSERT_HAS_VALUE (phases);
    const auto& ttfb =
    (*phases)[static_cast<size_t> (vayu::core::TimingPhase::FirstByte)];
    EXPECT_EQ (ttfb.count, 500u);
    EXPECT_NEAR (ttfb.p50, 200.0, 1.0);
    // The retained sample is 90% of the way off; that gap is the feature.
    EXPECT_NEAR (ttfb.min, 5.0, 1.0);
}

// The per-run override reaches the collector, and off means no section at all.
TEST_F (LoadStrategyTest, PhaseHistogramsCanBeDisabledPerRun) {
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "phase_histograms", false },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-phase-off", config);
    vayu::db::Database db (TEST_DB_PATH);

    for (int i = 0; i < 20; ++i) {
        vayu::core::handle_result (context, db, completion (10.0));
    }

    EXPECT_EQ (context->metrics_collector->total_requests (), 20u);
    EXPECT_FALSE (context->metrics_collector->phase_percentiles ().has_value ());

    // On by default, so a run that says nothing still gets the distribution.
    nlohmann::json bare = { { "mode", "constant_rps" } };
    auto stock = std::make_shared<vayu::core::RunContext> ("test-phase-default", bare);
    vayu::core::handle_result (stock, db, completion (10.0));
    EXPECT_TRUE (stock->metrics_collector->phase_percentiles ().has_value ());
}

// The tick's wait is split so the sleep's overshoot lands in the spin and not
// in the arrival gap (issue #1370, extended to Linux/macOS by issue #1667).
// Platform-free on purpose: the arithmetic is the whole of the decision, and a
// Linux host has to be able to review it - so every case is phrased relative
// to `tail`, the *current platform's* `spin_tail_us` at a remainder large
// enough to sit well under any platform's cap (so the proportional macOS
// shape has already flattened out and behaves like a plain constant here),
// and this test runs on all three.
TEST (TickPacing, SleepLegLeavesTheSpinTail) {
    using vayu::core::tick_sleep_leg_us;
    const int64_t tail = vayu::core::constants::pacing::spin_tail_us (1'000'000);

    // A remainder twice the tail sleeps exactly the tail's worth and spins
    // the rest; three times the tail sleeps twice the tail.
    EXPECT_EQ (tick_sleep_leg_us (tail * 2, tail), tail);
    EXPECT_EQ (tick_sleep_leg_us (tail * 3, tail), tail * 2);

    // At and below the tail the whole remainder is spun - the boundary itself,
    // half of it, and one microsecond past it.
    EXPECT_EQ (tick_sleep_leg_us (tail, tail), 0);
    EXPECT_EQ (tick_sleep_leg_us (tail / 2, tail), 0);
    EXPECT_EQ (tick_sleep_leg_us (tail + 1, tail), 1);

    // Never negative, whatever a caller hands it.
    EXPECT_EQ (tick_sleep_leg_us (0, tail), 0);
    EXPECT_EQ (tick_sleep_leg_us (-100, tail), 0);
}

// The per-platform tail *function* itself (issue #1667's macOS/Linux
// follow-up to #1370's flat Windows constant): `min (remaining / divisor +
// base_us, cap_us)`, degenerate (`divisor == 0`, always `cap_us`) on Windows
// and Linux, proportional-with-cap on macOS. `detail::compute_spin_tail_us`
// is exercised directly with each platform's own named parameters so every
// shape is checked on whichever host runs the suite, not only the one whose
// `#if` branch compiled here.
TEST (SpinTailUs, MacOsShapeAtTheRealBenchmarkedLegs) {
    using vayu::core::constants::pacing::detail::compute_spin_tail_us;
    namespace pacing = vayu::core::constants::pacing;

    // 1500 RPS: tick_us 1000, leg (tick - tail) is well under the cap, so
    // this is pure slope math: 667 / 9 + 60 = 74 + 60 = 134us.
    EXPECT_EQ (compute_spin_tail_us (667, pacing::MACOS_DIVISOR,
               pacing::MACOS_BASE_US, pacing::MACOS_CAP_US),
    134);

    // 400 RPS: tick_us 2500. 2500 / 9 + 60 = 277 + 60 = 337us.
    EXPECT_EQ (compute_spin_tail_us (2500, pacing::MACOS_DIVISOR,
               pacing::MACOS_BASE_US, pacing::MACOS_CAP_US),
    337);

    // 200 RPS: tick_us 5000. 5000 / 9 + 60 = 555 + 60 = 615us.
    EXPECT_EQ (compute_spin_tail_us (5000, pacing::MACOS_DIVISOR,
               pacing::MACOS_BASE_US, pacing::MACOS_CAP_US),
    615);
}

TEST (SpinTailUs, MacOsShapeCapsAbovePlateau) {
    using vayu::core::constants::pacing::detail::compute_spin_tail_us;
    namespace pacing = vayu::core::constants::pacing;

    // Well above the ~5-10ms plateau point: 50000 / 9 + 60 = 5555 + 60 =
    // 5615us uncapped, so the cap is what actually applies.
    EXPECT_EQ (compute_spin_tail_us (50'000, pacing::MACOS_DIVISOR,
               pacing::MACOS_BASE_US, pacing::MACOS_CAP_US),
    pacing::MACOS_CAP_US);
}

TEST (SpinTailUs, WindowsAndLinuxAreFlatRegardlessOfInput) {
    using vayu::core::constants::pacing::detail::compute_spin_tail_us;
    namespace pacing = vayu::core::constants::pacing;

    for (const int64_t remaining :
    { int64_t{ 0 }, int64_t{ 667 }, int64_t{ 5000 }, int64_t{ 50'000 } }) {
        EXPECT_EQ (compute_spin_tail_us (remaining, 0, pacing::WINDOWS_BASE_US,
                   pacing::WINDOWS_CAP_US),
        pacing::WINDOWS_CAP_US)
        << "remaining=" << remaining;
        EXPECT_EQ (compute_spin_tail_us (remaining, 0, pacing::LINUX_BASE_US, pacing::LINUX_CAP_US),
        pacing::LINUX_CAP_US)
        << "remaining=" << remaining;
    }
}

// The platform-selected `spin_tail_us` (the actual call site's entry point,
// not the parameterized helper above) behaves the same way on whichever
// platform this build's `#if` branch resolved to.
TEST (SpinTailUs, PlatformSelectedFunctionIsFlatOrCappedConsistently) {
    using vayu::core::constants::pacing::spin_tail_us;

    // Not named `small`: that identifier is a legacy typedef macro
    // (`#define small char`, from the RPC headers `windows.h` pulls in) that
    // NOMINMAX does not guard, so MSVC substitutes it mid-declaration.
    const int64_t tail_at_zero    = spin_tail_us (0);
    const int64_t tail_at_plateau = spin_tail_us (1'000'000);
    EXPECT_GE (tail_at_zero, 0);
    EXPECT_GE (tail_at_plateau, tail_at_zero); // the tail never shrinks as the remainder grows
    EXPECT_LE (tail_at_plateau, 2000); // no platform's cap exceeds the Windows constant
}
