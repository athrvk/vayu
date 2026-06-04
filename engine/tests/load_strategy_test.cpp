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
#include <httplib.h>

#include <chrono>
#include <memory>
#include <string>
#include <thread>

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"

namespace {

// Mock server whose only endpoint sleeps ~500ms before responding, so
// requests stay in-flight long enough for the cap to bite.
class SlowMockServer {
    public:
    SlowMockServer () {
        // Generous server-side thread pool: the closed-loop tests hold tens of
        // concurrent /slow requests, and the worker drains active transfers on
        // stop(). A thread-starved mock would serialize them and make teardown
        // take tens of seconds (a harness artifact, not engine behavior).
        svr.new_task_queue = [] { return new httplib::ThreadPool (128); };

        svr.Get ("/slow", [] (const httplib::Request&, httplib::Response& res) {
            std::this_thread::sleep_for (std::chrono::milliseconds (500));
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/fast", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("{}", "application/json");
        });

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
    }

    ~SlowMockServer () {
        svr.stop ();
        if (thread.joinable ())
            thread.join ();
    }

    std::string slow_url () const {
        return "http://127.0.0.1:" + std::to_string (port) + "/slow";
    }

    std::string fast_url () const {
        return "http://127.0.0.1:" + std::to_string (port) + "/fast";
    }

    httplib::Server svr;
    std::thread thread;
    int port = 0;
};

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
