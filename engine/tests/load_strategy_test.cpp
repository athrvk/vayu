/**
 * @file load_strategy_test.cpp
 * @brief Tests for load strategies, focused on the maxInFlight cap.
 *
 * The maxInFlight cap, the dropped_requests counter, and the ramp
 * backpressure signal must gate on TRUE in-flight requests
 * (requests_sent - completed), not on EventLoop::pending_count() (the
 * submission-queue depth, which workers drain to ~0). When the event loop
 * has ample worker capacity (max_concurrent / max_per_host well above the
 * cap), the submission queue stays drained while real in-flight climbs, so
 * a pending_count()-based cap never fires.
 */

#include "vayu/core/load_strategy.hpp"

#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <string>
#include <thread>

#include "mock_server.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"

namespace {

using vayu::tests::SlowMockServer;

const std::string TEST_DB_PATH = "test_load_strategy.db";

class LoadStrategyTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        std::remove (TEST_DB_PATH.c_str ());
        mock_server = std::make_unique<SlowMockServer> ();
    }

    void TearDown () override {
        mock_server.reset ();
        vayu::http::global_cleanup ();
        std::remove (TEST_DB_PATH.c_str ());
    }

    std::unique_ptr<SlowMockServer> mock_server;
};

} // namespace

// At 300 RPS against a 500ms endpoint with maxInFlight=10, true in-flight
// climbs well past 10 within the first ~33ms (nothing completes until
// t≈500ms). With the event loop given far more worker capacity than the
// cap (max_concurrent / max_per_host = 2000), the submission queue stays
// drained, so a pending_count()-based cap would never fire and zero drops
// would be recorded. A correct in-flight-based cap records many drops.
TEST_F (LoadStrategyTest, MaxInFlightCapDropsWhenTrueInFlightExceedsCap) {
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "duration", "2s" },
        { "targetRps", 300.0 },
        { "maxInFlight", 10 },
    };

    auto context = std::make_shared<vayu::core::RunContext> ("test-inflight", config);

    // Generous worker capacity so the submission queue (pending_count) stays
    // drained while true in-flight climbs past the cap.
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->slow_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);

    auto strategy = vayu::core::LoadStrategy::create (config);
    ASSERT_NE (strategy, nullptr);

    // Runs synchronously on this thread for the full 2s duration.
    strategy->execute (context, db, request);

    context->event_loop->stop (false);

    EXPECT_GT (context->metrics_collector->dropped_requests (), 0u)
    << "maxInFlight cap did not drop any requests; the cap is likely gated on "
       "EventLoop::pending_count() (submission-queue depth) instead of true "
       "in-flight (requests_sent - completed)";
}

// RunContext exposes the closed-loop refill primitives and a peak gauge.
TEST_F (LoadStrategyTest, RunContextHasRefillPrimitives) {
    nlohmann::json config = { { "mode", "constant_concurrency" } };
    auto context = std::make_shared<vayu::core::RunContext> ("test-ctx", config);

    EXPECT_EQ (context->peak_in_flight.load (), 0u);
    EXPECT_FALSE (context->closed_loop.load ());

    // notify_refill must be safe to call with no waiter (near-free no-op).
    context->notify_refill ();
    SUCCEED ();
}

// Closed-loop: constant_concurrency N=50 against a 500ms endpoint must hold
// ~50 in flight, NOT climb to the old ~900. peak_in_flight is the ground truth.
TEST_F (LoadStrategyTest, ConstantConcurrencyHoldsTargetInFlight) {
    const size_t N = 50;
    nlohmann::json config = {
        { "mode", "constant_concurrency" },
        { "duration", "2s" },
        { "concurrency", N },
    };

    auto context = std::make_shared<vayu::core::RunContext> ("test-cc", config);

    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000; // ample, so only the controller bounds N
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->slow_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    ASSERT_NE (strategy, nullptr);

    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    // Peak must stay near N (allow a small epsilon for worker scheduling slop),
    // NOT the ~900 the old open-loop batch submitter produced.
    EXPECT_LE (context->peak_in_flight.load (), N + 10)
    << "in-flight exceeded target+epsilon; closed-loop refill not holding N";
    EXPECT_GE (context->peak_in_flight.load (), N - 5)
    << "never reached target; seeding/refill under-submitting";
}

// Closed-loop ramp: in-flight tracks the ramp line and never overshoots target.
TEST_F (LoadStrategyTest, RampUpTracksTargetWithoutOvershoot) {
    const size_t TARGET = 50;
    nlohmann::json config = {
        { "mode", "ramp_up" },
        { "duration", "3s" },
        { "rampUpDuration", "2s" },
        { "startConcurrency", 1 },
        { "concurrency", TARGET },
    };

    auto context = std::make_shared<vayu::core::RunContext> ("test-ramp", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
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

    // After a full ramp to TARGET, peak settles at ~TARGET, never far above.
    EXPECT_LE (context->peak_in_flight.load (), TARGET + 10);
    EXPECT_GE (context->peak_in_flight.load (), TARGET - 5);
}

// Behavior-change check: duration < ramp runs a partial ramp for the full
// duration and submits requests (old open-loop code finished instantly with 0).
TEST_F (LoadStrategyTest, RampUpDurationShorterThanRampStillRuns) {
    nlohmann::json config = {
        { "mode", "ramp_up" },
        { "duration", "1s" },
        { "rampUpDuration", "10s" },
        { "startConcurrency", 1 },
        { "concurrency", 50 },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-ramp-short", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
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

    EXPECT_GT (context->requests_sent.load (), 0u)
    << "duration<ramp submitted nothing; partial-ramp behavior not implemented";
}

// Closed-loop iterations: submit exactly M, never exceed N in flight.
// N kept within the httplib test-mock thread pool so /fast completes promptly;
// stop(false) skips the drain (peak is already captured during execute).
TEST_F (LoadStrategyTest, IterationsSubmitsExactlyMAndHoldsN) {
    const size_t M = 50;
    const size_t N = 10;
    nlohmann::json config = {
        { "mode", "iterations" },
        { "iterations", M },
        { "concurrency", N },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-iter", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
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

    EXPECT_EQ (context->requests_sent.load (), M) << "did not submit exactly M";
    EXPECT_LE (context->peak_in_flight.load (), N + 10) << "exceeded concurrency N";
}

// Fast endpoint: a fixed-interval poll would let in-flight collapse between
// polls (Option-B undershoot). The cv-wake refill must keep MEAN in-flight near
// N. Measure mean via Little's Law: mean = throughput * avg_latency_s.
TEST_F (LoadStrategyTest, FastEndpointHoldsMeanInFlight) {
    const size_t N        = 20;
    const double DUR_S    = 2.0;
    nlohmann::json config = {
        { "mode", "constant_concurrency" },
        { "duration", "2s" },
        { "concurrency", N },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-fast", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
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

    size_t completed     = context->metrics_collector->total_requests ();
    double avg_latency_s = context->metrics_collector->average_latency () / 1000.0;
    double throughput    = static_cast<double> (completed) / DUR_S;
    double mean_inflight = throughput * avg_latency_s; // Little's Law

    std::cerr << "[fast-hold] completed=" << completed
              << " avg_latency_ms=" << context->metrics_collector->average_latency ()
              << " throughput=" << throughput << " mean_inflight=" << mean_inflight
              << " peak=" << context->peak_in_flight.load () << "\n";

    // A fixed-poll refill collapses mean toward single digits; cv-wake holds it
    // near N. Generous lower bound for CI jitter (do NOT delete this assertion).
    EXPECT_GE (mean_inflight, 0.5 * static_cast<double> (N))
    << "mean in-flight collapsed (" << mean_inflight << "); cv-wake not refilling";
}

// Setting should_stop must end the run promptly. The controller breaks on
// should_stop (caught by its 50ms timeout even without a notify); the
// production stop paths additionally notify_refill so cancellation is immediate.
TEST_F (LoadStrategyTest, StopWakesControllerPromptly) {
    nlohmann::json config = {
        { "mode", "constant_concurrency" },
        { "duration", "60s" }, // long; we stop it early
        { "concurrency", 20 },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-stop", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);

    std::thread stopper ([context] () {
        std::this_thread::sleep_for (std::chrono::milliseconds (200));
        context->should_stop = true;
        context->notify_refill (); // mirrors the production stop path
    });

    auto t0 = std::chrono::steady_clock::now ();
    strategy->execute (context, db, request);
    auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - t0)
                      .count ();
    stopper.join ();
    context->event_loop->stop (false);

    EXPECT_LT (elapsed_ms, 2000) << "controller did not observe should_stop promptly";
}

// The collector's percentiles expose non-zero max/min; run_manager persists
// them in the run summary so /report can surface them instead of 0.
TEST_F (LoadStrategyTest, PercentilesExposeNonZeroMax) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-max", nlohmann::json{ { "mode", "constant_concurrency" } });
    context->metrics_collector->record_success (200, 10.0, 0.0);
    context->metrics_collector->record_success (200, 250.0, 0.0);
    context->metrics_collector->record_success (200, 75.0, 0.0);

    auto p = context->metrics_collector->calculate_percentiles ();
    EXPECT_GT (p.max, 0.0);
    EXPECT_GE (p.max, p.p99);
    EXPECT_GT (p.min, 0.0);
}

// Wire bytes are captured from curl and accumulated. The mock returns a fixed
// "{}" body; assert received bytes scale with request count (exact totals vary
// with headers, so assert a lower bound, not equality).
TEST_F (LoadStrategyTest, CapturesReceivedBytes) {
    nlohmann::json config = {
        { "mode", "iterations" }, { "iterations", 20 }, { "concurrency", 5 },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-bytes", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
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

    // 20 responses, each with headers + a 2-byte body → comfortably > 20 bytes.
    EXPECT_GT (context->metrics_collector->total_bytes_received (), 20u);
}

// The persisted tick carries the collector's current cumulative values
// (dropped / bytes / status-code map). This is what collect_metrics stores each
// second; tested via the extracted payload builder for determinism.
TEST_F (LoadStrategyTest, MetricTickPayloadCarriesBytesDroppedStatus) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-tick", nlohmann::json{ { "mode", "constant_rps" } });
    auto& mc = *context->metrics_collector;
    mc.record_success (200, 5.0, 0.0, "");
    mc.record_success (404, 5.0, 0.0, "");
    mc.record_bytes (10, 1000);
    mc.record_drop_batch (3);

    vayu::core::MetricTickSample sample;
    sample.timestamp        = 12345;
    sample.dropped_requests = mc.dropped_requests ();
    sample.bytes_sent       = mc.total_bytes_sent ();
    sample.bytes_received   = mc.total_bytes_received ();
    sample.status_codes     = mc.status_code_distribution ();

    auto payload = vayu::core::build_metric_tick_payload (sample);
    EXPECT_EQ (payload["timestamp"].get<int64_t> (), 12345);
    EXPECT_EQ (payload["dropped_requests"].get<size_t> (), 3u);
    EXPECT_EQ (payload["bytes_sent"].get<size_t> (), 10u);
    EXPECT_EQ (payload["bytes_received"].get<size_t> (), 1000u);
    ASSERT_TRUE (payload["status_codes"].is_object ());
    EXPECT_EQ (payload["status_codes"]["200"].get<size_t> (), 1u);
    EXPECT_EQ (payload["status_codes"]["404"].get<size_t> (), 1u);
}

// A transport-level Error result (curl-handle creation failure, or the
// stop(false) cancellation drain) is a real completion. Dropping it would
// leave requests_sent counted with no matching completion, so in_flight()
// would stay permanently inflated and the closed-loop controller would keep
// shrinking effective concurrency for the rest of the run.
TEST_F (LoadStrategyTest, TransportErrorResultIsRecordedAndClearsInFlight) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-transport-error", nlohmann::json{ { "mode", "constant_rps" } });
    vayu::db::Database db (TEST_DB_PATH);

    context->requests_sent++;
    ASSERT_EQ (context->in_flight (), 1u);

    vayu::Error error;
    error.code    = vayu::ErrorCode::InternalError;
    error.message = "Failed to create curl handle";
    vayu::core::handle_result (context, db, vayu::Result<vayu::Response> (error));

    EXPECT_EQ (context->total_errors (), 1u);
    EXPECT_EQ (context->total_requests (), 1u);
    EXPECT_EQ (context->in_flight (), 0u);

    const auto& errors = context->metrics_collector->errors ();
    ASSERT_EQ (errors.size (), 1u);
    EXPECT_NE (errors.front ().trace_data.find ("internal_error"), std::string::npos);
    EXPECT_NE (errors.front ().trace_data.find ("Failed to create curl handle"),
    std::string::npos);
}

// ============================================================================
// Open-loop pacing: rate fidelity, the wall-clock deadline, and ramp-down
// ============================================================================

// Above 1000 RPS the old batch loop submitted size_t(target_rps / 1000.0)
// requests per 1ms tick, so 1500 RPS delivered 1000 and no client was told.
// The fractional accumulator delivers the requested rate.
TEST_F (LoadStrategyTest, ConstantRpsDeliversRatesAbove1000) {
    const double RPS      = 1500.0;
    const double DUR_S    = 2.0;
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "duration", "2s" },
        { "targetRps", RPS },
    };

    auto context = std::make_shared<vayu::core::RunContext> ("test-rps-1500", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
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

    const double owed = RPS * DUR_S;
    const size_t sent = context->requests_sent.load ();
    EXPECT_GT (static_cast<double> (sent), owed * 0.9)
    << "delivered " << sent << " of " << owed
    << "; a rate floored to a 1000-multiple would deliver ~2000";
    EXPECT_LT (static_cast<double> (sent), owed * 1.1)
    << "delivered " << sent << " of " << owed << "; the generator overshot its rate";
}

// The run is time-bound: it ends at its wall-clock deadline, and the requests
// it owed but could not issue are recorded as drops instead of being pushed
// past the deadline (or vanishing). sent + dropped is what the rate owed.
TEST_F (LoadStrategyTest, SaturatedRunEndsAtDeadlineAndRecordsTheShortfall) {
    const double RPS      = 500.0;
    const double DUR_S    = 1.0;
    nlohmann::json config = {
        { "mode", "constant_rps" }, { "duration", "1s" }, { "targetRps", RPS },
        { "maxInFlight", 5 }, // far below what a 500ms endpoint can retire
    };

    auto context =
    std::make_shared<vayu::core::RunContext> ("test-rps-saturated", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->slow_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);

    const auto started = std::chrono::steady_clock::now ();
    strategy->execute (context, db, request);
    const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started)
                            .count ();
    context->event_loop->stop (false);

    const size_t sent    = context->requests_sent.load ();
    const size_t dropped = context->metrics_collector->dropped_requests ();

    EXPECT_LT (elapsed_ms, 1500) << "run overshot its 1s wall-clock deadline";
    EXPECT_GT (dropped, 0u) << "a saturated run recorded no drops";
    EXPECT_NEAR (static_cast<double> (sent + dropped), RPS * DUR_S, 5.0)
    << "sent(" << sent << ") + dropped(" << dropped << ") does not account for the "
    << (RPS * DUR_S) << " requests the rate owed";
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
