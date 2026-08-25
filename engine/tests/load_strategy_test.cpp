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
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"

namespace {

using vayu::tests::SlowMockServer;

constexpr const char* TEST_DB_PATH = "test_load_strategy.db";

class LoadStrategyTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        cleanup ();
        mock_server = std::make_unique<SlowMockServer> ();
    }

    void TearDown () override {
        mock_server.reset ();
        vayu::http::global_cleanup ();
        cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (TEST_DB_PATH);
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
    const size_t N        = 50;
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
    const size_t TARGET   = 50;
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
    const size_t M        = 50;
    const size_t N        = 10;
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
    EXPECT_LE (context->peak_in_flight.load (), N + 10)
    << "exceeded concurrency N";
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

    size_t completed = context->metrics_collector->total_requests ();
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

    EXPECT_LT (elapsed_ms, 2000)
    << "controller did not observe should_stop promptly";
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
        { "mode", "iterations" },
        { "iterations", 20 },
        { "concurrency", 5 },
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
        { "mode", "constant_rps" }, { "slow_threshold_ms", 100 },
        { "save_timing_breakdown", true }, { "success_sample_rate", 1 }, // every completion is sampled
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
    ASSERT_TRUE (slow[0].capture.has_value ())
    << "an outlier must carry its body";

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

// ---------------------------------------------------------------------------
// Capacity discovery
// ---------------------------------------------------------------------------

namespace {

/**
 * Run a capacity search end to end against the mock server.
 *
 * The metrics thread is spawned here rather than left out as the other
 * strategy tests leave it, because it is the search's only sensor: the
 * controller steers by `RunContext::latest_live_tick()`, which nothing else
 * publishes. A capacity test without it measures a search that never sees a
 * window close - which is itself the documented behaviour, but not the one
 * these tests are about.
 */
vayu::core::CapacitySummary run_capacity_search (const nlohmann::json& config,
const std::string& url,
const std::string& run_id,
vayu::db::Database& db) {
    auto context = std::make_shared<vayu::core::RunContext> (run_id, config);

    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = url;
    request.timeout_ms = 30000;

    context->is_running = true;
    context->start_time_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                             .count ();
    std::thread metrics (
    [context, &db] () { vayu::core::collect_metrics (context, &db); });

    auto strategy = vayu::core::LoadStrategy::create (config);
    EXPECT_NE (strategy, nullptr);
    strategy->execute (context, db, request);

    context->is_running = false;
    metrics.join ();
    context->event_loop->stop (false);

    EXPECT_TRUE (context->capacity.has_value ());
    return context->capacity.value_or (vayu::core::CapacitySummary{});
}

} // namespace

TEST_F (LoadStrategyTest, CapacityModeIsSelectedByTheFactory) {
    nlohmann::json config = { { "mode", "capacity" } };
    EXPECT_NE (vayu::core::LoadStrategy::create (config), nullptr);
    EXPECT_EQ (vayu::parse_load_test_type ("capacity"), vayu::LoadTestType::Capacity);
    EXPECT_STREQ (vayu::to_string (vayu::LoadTestType::Capacity), "capacity");
}

// A 500ms endpoint cannot meet a 100ms p99 at any concurrency, so the search
// gives up at its very first level - and says so with the level that breached,
// not with a headline it never measured.
TEST_F (LoadStrategyTest, CapacityStopsOnTheSloAgainstASlowEndpoint) {
    nlohmann::json config = {
        { "mode", "capacity" },
        { "duration", "20s" }, // far above what the SLO stop needs
        { "stepDuration", "1s" },
        { "sloMs", 100 },
        { "startConcurrency", 4 },
        { "concurrency", 64 },
    };

    vayu::db::Database db (TEST_DB_PATH);
    const auto summary =
    run_capacity_search (config, mock_server->slow_url (), "test-capacity-slo", db);

    EXPECT_EQ (summary.stop_reason, "slo_exceeded");
    ASSERT_TRUE (summary.knee.has_value ());
    EXPECT_GT (summary.knee->p99_ms, summary.slo_ms);
    EXPECT_EQ (summary.knee->concurrency, 4u)
    << "the search should not have climbed";
    EXPECT_FALSE (summary.max_healthy.has_value ())
    << "no level held the budget, so there is no sustainable capacity to "
       "report";
    // The breach plus the re-measure that confirmed it.
    EXPECT_EQ (summary.levels.size (), 2u);
}

// A fast endpoint inside its budget climbs until it runs out of room, and the
// report says the search ended on the caller's ceiling rather than inventing a
// knee it never observed.
TEST_F (LoadStrategyTest, CapacityStopsAtTheCapAgainstAFastEndpoint) {
    nlohmann::json config = {
        { "mode", "capacity" }, { "duration", "30s" }, { "stepDuration", "1s" },
        { "sloMs", 2000 }, // far above anything /fast can produce
        { "startConcurrency", 2 }, { "concurrency", 3 }, // one step-up and the search is at its ceiling
    };

    vayu::db::Database db (TEST_DB_PATH);
    const auto summary =
    run_capacity_search (config, mock_server->fast_url (), "test-capacity-cap", db);

    EXPECT_EQ (summary.stop_reason, "cap_reached");
    ASSERT_TRUE (summary.max_healthy.has_value ());
    EXPECT_EQ (summary.max_healthy->concurrency, 3u);
    EXPECT_GT (summary.max_healthy->rps, 0.0);
    EXPECT_FALSE (summary.knee.has_value ());
    EXPECT_EQ (summary.levels.size (), 2u);
}

// The deadline is the strategy's own stop, not the controller's - it is the one
// condition that is about the clock rather than about what the service did.
TEST_F (LoadStrategyTest, CapacityStopsOnItsDeadline) {
    nlohmann::json config = {
        { "mode", "capacity" },
        { "duration", "1200ms" }, // ends inside the second window
        { "stepDuration", "1s" },
        { "sloMs", 2000 },
        { "startConcurrency", 2 },
        { "concurrency", 1000 },
    };

    vayu::db::Database db (TEST_DB_PATH);
    const auto summary = run_capacity_search (
    config, mock_server->fast_url (), "test-capacity-deadline", db);

    EXPECT_EQ (summary.stop_reason, "deadline");
    // One window closed before the clock ran out; the partial second one is not
    // in the audit trail, because it was never judged.
    EXPECT_EQ (summary.levels.size (), 1u);
    ASSERT_TRUE (summary.max_healthy.has_value ());
    EXPECT_EQ (summary.max_healthy->concurrency, 2u);
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
    ASSERT_TRUE (phases.has_value ());
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
