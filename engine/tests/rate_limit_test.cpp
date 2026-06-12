/**
 * @file rate_limit_test.cpp
 * @brief Google Test cases for rate limiting functionality
 */

#include <gtest/gtest.h>

#include <chrono>
#include <thread>
#include <vector>

#include "mock_server.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/types.hpp"

using namespace vayu::http;
using namespace vayu;
using vayu::tests::SlowMockServer;

class RateLimiterTest : public ::testing::Test {
    protected:
    void SetUp () override {
        global_init ();
        mock = std::make_unique<SlowMockServer> ();
    }
    void TearDown () override {
        mock.reset ();
        global_cleanup ();
    }
    std::unique_ptr<SlowMockServer> mock;
};

// Pacing assertion is made against an in-process mock (`/fast`) instead of an
// external endpoint. The previous version pointed at httpbin.org, which made
// the test depend on real network latency: on macOS x64 (Rosetta-emulated on
// Apple-silicon runners) the curl_multi loop overhead shifted the measured
// RPS outside the ±25% window even though the rate limiter itself was fine.
// Hitting localhost removes that variance — we're checking engine behavior,
// not someone else's web service.
TEST_F (RateLimiterTest, EnforcesTargetRPS) {
    // Configure for 100 RPS
    EventLoopConfig config;
    config.target_rps     = 100.0;
    config.burst_size     = 10.0; // Small burst to force rate limiting
    config.num_workers    = 1;    // Single worker for simpler testing
    config.max_concurrent = 200;  // Allow all requests to be in flight

    EventLoop loop (config);
    loop.start ();

    Request req;
    req.method = HttpMethod::GET;
    req.url    = mock->fast_url ();

    // Track submission timing
    auto submission_start = std::chrono::steady_clock::now ();

    // Submit all requests quickly - rate limiter will pace them
    std::vector<RequestHandle> handles;
    for (int i = 0; i < 200; ++i) {
        handles.push_back (loop.submit_async (req));
    }

    // Wait for all to be submitted (not completed)
    while (loop.pending_count () > 0) {
        std::this_thread::sleep_for (std::chrono::milliseconds (50));
    }

    auto submission_end = std::chrono::steady_clock::now ();
    auto submission_duration =
    std::chrono::duration<double> (submission_end - submission_start).count ();

    // Wait for all and count results
    size_t completed = 0;
    for (auto& handle : handles) {
        auto result = handle.future.get ();
        if (result.is_ok ()) {
            completed++;
        }
    }

    loop.stop ();

    // Check if submission rate is close to target
    // Allow wider tolerance (±25%) due to curl_multi loop overhead:
    // - Each iteration includes curl_multi_perform, curl_multi_info_read
    // - Poll timeout adds ~1ms per check when rate-limited
    // - Effective RPS is typically 80-90% of target
    double submission_rps = 200.0 / submission_duration;

    EXPECT_GE (submission_rps, 75.0) << "Submission rate too slow";
    EXPECT_LE (submission_rps, 125.0) << "Submission rate too fast";
    EXPECT_GT (completed, 0) << "No requests completed successfully";
}
