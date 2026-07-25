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
#include "vayu/http/event_loop/event_loop_impl.hpp"
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
// Hitting localhost removes that variance - we're checking engine behavior,
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

// target_rps is an aggregate budget, but each worker owns a private token
// bucket and submissions are sharded round-robin - so the budget has to be
// split N ways or the real cap is N x target_rps.
TEST (PerWorkerConfigTest, SplitsTheAggregateBudgetAcrossWorkers) {
    EventLoopConfig config;
    config.target_rps = 1000.0;
    config.burst_size = 4000.0;

    auto shard = detail::per_worker_config (config, 4);
    EXPECT_DOUBLE_EQ (shard.target_rps, 250.0);
    EXPECT_DOUBLE_EQ (shard.burst_size, 1000.0);
}

TEST (PerWorkerConfigTest, DerivesTheDefaultBurstFromTheAggregateRate) {
    // burst_size 0 means "2x target_rps" (RateLimiter's own default), which
    // must be derived from the aggregate rate before it is split, not after.
    EventLoopConfig config;
    config.target_rps = 800.0;

    auto shard = detail::per_worker_config (config, 4);
    EXPECT_DOUBLE_EQ (shard.target_rps, 200.0);
    EXPECT_DOUBLE_EQ (shard.burst_size, 400.0);
}

TEST (PerWorkerConfigTest, FloorsTheBurstAtOneTokenSoAWorkerCanNeverStall) {
    // refill_tokens() clamps the bucket to burst_size, so a sub-token burst
    // could never reach the 1.0 needed to start a transfer - the worker would
    // wait forever rather than slowly.
    EventLoopConfig config;
    config.target_rps = 2.0; // fewer than one request per second per worker

    auto shard = detail::per_worker_config (config, 8);
    EXPECT_DOUBLE_EQ (shard.target_rps, 0.25);
    EXPECT_GE (shard.burst_size, 1.0);
}

TEST (PerWorkerConfigTest, LeavesAnUnlimitedOrSingleWorkerConfigAlone) {
    EventLoopConfig unlimited; // target_rps 0 = rate limiting disabled
    unlimited.burst_size = 0.0;
    auto unlimited_shard = detail::per_worker_config (unlimited, 8);
    EXPECT_DOUBLE_EQ (unlimited_shard.target_rps, 0.0);
    EXPECT_DOUBLE_EQ (unlimited_shard.burst_size, 0.0);

    EventLoopConfig single;
    single.target_rps = 500.0;
    single.burst_size = 900.0;
    auto single_shard = detail::per_worker_config (single, 1);
    EXPECT_DOUBLE_EQ (single_shard.target_rps, 500.0);
    EXPECT_DOUBLE_EQ (single_shard.burst_size, 900.0);
}

// End-to-end counterpart to the unit tests above: the aggregate cap must hold
// with several workers, which is exactly what EnforcesTargetRPS (num_workers=1)
// cannot see.
TEST_F (RateLimiterTest, EnforcesTargetRPSAcrossMultipleWorkers) {
    EventLoopConfig config;
    config.target_rps     = 100.0; // aggregate, not per worker
    config.burst_size     = 10.0;  // small burst so pacing dominates
    config.num_workers    = 4;
    config.max_concurrent = 200;

    EventLoop loop (config);
    loop.start ();

    Request req;
    req.method = HttpMethod::GET;
    req.url    = mock->fast_url ();

    auto submission_start = std::chrono::steady_clock::now ();

    std::vector<RequestHandle> handles;
    for (int i = 0; i < 200; ++i) {
        handles.push_back (loop.submit_async (req));
    }

    while (loop.pending_count () > 0) {
        std::this_thread::sleep_for (std::chrono::milliseconds (50));
    }

    auto submission_duration =
    std::chrono::duration<double> (std::chrono::steady_clock::now () - submission_start)
    .count ();

    for (auto& handle : handles) {
        handle.future.get ();
    }
    loop.stop ();

    // Same ±25% window as the single-worker case. Without the split this lands
    // near 400 RPS (4 workers x the full target), far outside it.
    double submission_rps = 200.0 / submission_duration;
    EXPECT_GE (submission_rps, 75.0) << "Submission rate too slow";
    EXPECT_LE (submission_rps, 125.0) << "Submission rate too fast";
}
