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
        svr.Get ("/slow", [] (const httplib::Request&, httplib::Response& res) {
            std::this_thread::sleep_for (std::chrono::milliseconds (500));
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
