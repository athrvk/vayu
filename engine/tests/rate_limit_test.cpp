/**
 * @file rate_limit_test.cpp
 * @brief Google Test cases for rate limiting functionality
 */

#include "vayu/http/event_loop.hpp"
#include "vayu/types.hpp"
#include <gtest/gtest.h>
#include <chrono>
#include <atomic>

using namespace vayu::http;
using namespace vayu;

TEST(RateLimiterTest, EnforcesTargetRPS)
{
    // Configure for 100 RPS
    EventLoopConfig config;
    config.target_rps = 100.0;
    config.burst_size = 10.0;    // Small burst to force rate limiting
    config.num_workers = 1;      // Single worker for simpler testing
    config.max_concurrent = 200; // Allow all requests to be in flight

    EventLoop loop(config);
    loop.start();

    // Prepare request - use a faster endpoint
    Request req;
    req.method = HttpMethod::GET;
    req.url = "https://httpbin.org/get";

    // Track submission timing
    auto submission_start = std::chrono::steady_clock::now();

    // Submit all requests quickly - rate limiter will pace them
    std::vector<RequestHandle> handles;
    for (int i = 0; i < 200; ++i)
    {
        handles.push_back(loop.submit_async(req));
    }

    // Wait for all to be submitted (not completed)
    while (loop.pending_count() > 0)
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    auto submission_end = std::chrono::steady_clock::now();
    auto submission_duration = std::chrono::duration<double>(submission_end - submission_start).count();

    // Wait for all and count results
    size_t completed = 0;
    for (auto &handle : handles)
    {
        auto result = handle.future.get();
        if (result.is_ok())
        {
            completed++;
        }
    }

    loop.stop();

    // Check if submission rate is close to target (within 10%)
    double submission_rps = 200.0 / submission_duration;

    EXPECT_GE(submission_rps, 90.0) << "Submission rate too slow";
    EXPECT_LE(submission_rps, 110.0) << "Submission rate too fast";
    EXPECT_GT(completed, 0) << "No requests completed successfully";
}
