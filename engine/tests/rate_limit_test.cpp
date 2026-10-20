/**
 * @file rate_limit_test.cpp
 * @brief Google Test cases for rate limiting functionality
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string>
#include <thread>
#include <vector>

#include "mock_server.hpp"
#include "process_cpu.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/event_loop/event_loop_impl.hpp"
#include "vayu/http/rate_limiter.hpp"
#include "vayu/types.hpp"

using namespace vayu::http;
using namespace vayu;
using vayu::tests::process_cpu_ms;
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
    handles.reserve (200);
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

    // The cap is the subject. The floor only catches a limiter that stalls,
    // and a starved runner can halve the measured rate on its own (a Windows
    // leg read 50.2 here), so it sits well under that.
    EXPECT_GE (submission_rps, 40.0) << "Submission rate too slow";
    EXPECT_LE (submission_rps, 125.0) << "Submission rate too fast";
    EXPECT_GT (completed, 0) << "No requests completed successfully";
}

// target_rps is an aggregate budget, but each worker owns a private token
// bucket and submissions are sharded round-robin - so the budget has to be
// split N ways or the real cap is N x target_rps.
struct PerWorkerConfigCase {
    const char* name;
    double target_rps;
    double burst_size;
    size_t workers;
    double expected_target_rps;
    double expected_burst_size;
};

constexpr auto PER_WORKER_CONFIG_CASES = std::to_array<PerWorkerConfigCase> ({
{ "SplitsTheAggregateBudgetAcrossWorkers", 1000.0, 4000.0, 4, 250.0, 1000.0 },
// burst_size 0 means "2x target_rps" (RateLimiter's own default), which
// must be derived from the aggregate rate before it is split, not after.
{ "DerivesTheDefaultBurstFromTheAggregateRate", 800.0, 0.0, 4, 200.0, 400.0 },
// refill_tokens() clamps the bucket to burst_size, so a sub-token burst
// could never reach the 1.0 needed to start a transfer - the worker would
// wait forever rather than slowly. 2 rps over 8 workers is fewer than one
// request per second per worker, and its derived burst (0.5) sits below
// the floor.
{ "FloorsTheBurstAtOneTokenSoAWorkerCanNeverStall", 2.0, 0.0, 8, 0.25, 1.0 },
// target_rps 0 = rate limiting disabled
{ "LeavesAnUnlimitedConfigAlone", 0.0, 0.0, 8, 0.0, 0.0 },
{ "LeavesASingleWorkerConfigAlone", 500.0, 900.0, 1, 500.0, 900.0 },
});

class PerWorkerConfigTest : public ::testing::TestWithParam<PerWorkerConfigCase> {};

TEST_P (PerWorkerConfigTest, ScalesTheConfigToOneWorker) {
    const auto& c = GetParam ();
    EventLoopConfig config;
    config.target_rps = c.target_rps;
    config.burst_size = c.burst_size;

    auto shard = detail::per_worker_config (config, c.workers);
    EXPECT_DOUBLE_EQ (shard.target_rps, c.expected_target_rps);
    EXPECT_DOUBLE_EQ (shard.burst_size, c.expected_burst_size);
}

INSTANTIATE_TEST_SUITE_P (PerWorkerConfig,
PerWorkerConfigTest,
::testing::ValuesIn (PER_WORKER_CONFIG_CASES),
[] (const ::testing::TestParamInfo<PerWorkerConfigCase>& info) {
    return std::string (info.param.name);
});

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
    handles.reserve (200);
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

    // Same window as the single-worker case. Without the split this lands
    // near 400 RPS (4 workers x the full target), far outside it.
    double submission_rps = 200.0 / submission_duration;
    EXPECT_GE (submission_rps, 40.0) << "Submission rate too slow";
    EXPECT_LE (submission_rps, 125.0) << "Submission rate too fast";
}

TEST (RateLimiterTokenWaitTest, IsZeroWhenRateLimitingIsDisabled) {
    RateLimiter limiter;
    EXPECT_EQ (limiter.time_until_token_unlocked ().count (), 0.0);
}

TEST (RateLimiterTokenWaitTest, IsZeroWhileATokenIsAvailableAndConsumesNothing) {
    RateLimiter limiter (RateLimiterConfig{ 10.0, 1.0 });
    EXPECT_EQ (limiter.time_until_token_unlocked ().count (), 0.0);
    EXPECT_TRUE (limiter.try_acquire_unlocked ())
    << "asking how long until a token spent the one that was there";
}

TEST (RateLimiterTokenWaitTest, IsTheTimeTheMissingTokenTakesToRefill) {
    RateLimiter limiter (RateLimiterConfig{ 20.0, 1.0 }); // a token every 50ms
    ASSERT_TRUE (limiter.try_acquire_unlocked ());
    ASSERT_FALSE (limiter.try_acquire_unlocked ());

    const auto wait = limiter.time_until_token_unlocked ();
    EXPECT_GT (wait.count (), 0.0);
    EXPECT_LE (wait.count (), 0.05);

    std::this_thread::sleep_for (wait);
    EXPECT_TRUE (limiter.try_acquire_unlocked ())
    << "waiting the reported time did not yield a token";
}

namespace {

/// One worker whose one-token bucket refills at @p rps: every request after
/// the first waits for a token of its own, and against the fast mock the one
/// before it has long been answered, so the worker waits with nothing in
/// flight.
EventLoopConfig one_token_worker (double rps) {
    EventLoopConfig config;
    config.target_rps  = rps;
    config.burst_size  = 1.0;
    config.num_workers = 1;
    return config;
}

/// Parks a worker for its next token with three requests still queued, times
/// stop (@p wait_for_pending, @p drain_timeout), and checks the queued three
/// were cancelled rather than left unanswered.
double seconds_to_stop_a_parked_worker (const std::string& url,
bool wait_for_pending,
std::chrono::milliseconds drain_timeout) {
    EventLoop loop (one_token_worker (0.5)); // the next token is 2s away
    loop.start ();

    Request req;
    req.method = HttpMethod::GET;
    req.url    = url;

    constexpr int REQUESTS = 4;
    std::vector<RequestHandle> handles;
    handles.reserve (REQUESTS);
    for (int i = 0; i < REQUESTS; ++i) {
        handles.push_back (loop.submit_async (req));
    }
    EXPECT_TRUE (handles.front ().future.get ().is_ok ());
    std::this_thread::sleep_for (std::chrono::milliseconds (50));

    const auto started = std::chrono::steady_clock::now ();
    loop.stop (wait_for_pending, drain_timeout);
    const double seconds =
    std::chrono::duration<double> (std::chrono::steady_clock::now () - started).count ();

    for (size_t i = 1; i < handles.size (); ++i) {
        EXPECT_FALSE (handles[i].future.get ().is_ok ())
        << "queued request " << i << " was sent instead of cancelled";
    }
    return seconds;
}

} // namespace

// Issue #1915: with nothing in flight and items queued, a worker the bucket
// refused fell through wait_for_work without parking and asked the bucket
// again in a hot loop, a full core for the whole rate-limited stretch. The
// sent count is the same either side of the fix, so CPU is the assertion.
// Mutation check: making wait_for_work skip wait_for_next_token reds the CPU
// bound alone.
TEST_F (RateLimiterTest, AWorkerWaitingForATokenWithNothingInFlightDoesNotSpin) {
    EventLoop loop (one_token_worker (4.0));
    loop.start ();

    Request req;
    req.method = HttpMethod::GET;
    req.url    = mock->fast_url ();

    // The first on the burst token, then eight more 250ms apart: 2s.
    constexpr int REQUESTS = 9;

    const int64_t cpu_before = process_cpu_ms ();
    const auto started       = std::chrono::steady_clock::now ();
    std::vector<RequestHandle> handles;
    handles.reserve (REQUESTS);
    for (int i = 0; i < REQUESTS; ++i) {
        handles.push_back (loop.submit_async (req));
    }
    for (auto& handle : handles) {
        EXPECT_TRUE (handle.future.get ().is_ok ());
    }
    const double elapsed =
    std::chrono::duration<double> (std::chrono::steady_clock::now () - started).count ();
    const int64_t cpu_ms = process_cpu_ms () - cpu_before;
    loop.stop ();

    // Loose on purpose: the mock server shares this process. A spinning
    // worker costs about one core, so roughly 2,000ms over this window.
    EXPECT_LT (cpu_ms, 300) << "the worker spun on the bucket instead of "
                               "parking for its next token - consumed "
                            << cpu_ms << "ms of CPU over " << elapsed << "s";

    // The pacing must not move: the wait is the token's own interval.
    EXPECT_GE (elapsed, 1.8) << "requests went out faster than 4 rps";
    EXPECT_LE (elapsed, 3.0) << "the token wait overshoots the token";
}

// Issue #2032: a pass over an empty queue took a token before finding nothing
// to pop, so a one-token worker sat idle with an empty bucket and the first
// request to arrive waited a whole token interval. Mutation check: taking the
// token before peeking the queue reds this (about 700ms here).
TEST_F (RateLimiterTest, AnIdleWorkerKeepsItsTokenForTheNextRequest) {
    EventLoop loop (one_token_worker (1.0)); // a token per second
    loop.start ();
    std::this_thread::sleep_for (std::chrono::milliseconds (300));

    Request req;
    req.method = HttpMethod::GET;
    req.url    = mock->fast_url ();

    const auto submitted = std::chrono::steady_clock::now ();
    auto handle          = loop.submit_async (req);
    EXPECT_TRUE (handle.future.get ().is_ok ());
    const double seconds =
    std::chrono::duration<double> (std::chrono::steady_clock::now () - submitted)
    .count ();
    loop.stop ();

    EXPECT_LT (seconds, 0.5) << "the request waited " << seconds
                             << "s for a token an empty pass had spent";
}

// A worker parked for its next token still answers stop () at once:
// stop(false) through curl_multi_wakeup, and a bounded drain at its deadline
// rather than up to a token interval late. Mutation check: dropping the
// drain-deadline clamp in wait_for_next_token reds the drain case (the park
// then runs to TOKEN_WAIT_CAP_MS or the token, whichever is first).
TEST_F (RateLimiterTest, AWorkerParkedForItsNextTokenStopsPromptly) {
    EXPECT_LT (seconds_to_stop_a_parked_worker (
               mock->fast_url (), false, std::chrono::milliseconds::zero ()),
    0.5)
    << "stop(false) waited for the parked worker's token";
}

// Best of three: the healthy stop takes about the 30ms deadline and the
// mutation about 130ms, too close for one sample on a runner that can stall a
// thread for 50ms. A stall lands in one attempt; the mutation lands in all.
TEST_F (RateLimiterTest, ABoundedDrainEndsOnTimeWhileWaitingForAToken) {
    double fastest = std::numeric_limits<double>::max ();
    for (int attempt = 0; attempt < 3 && fastest >= 0.08; ++attempt) {
        fastest = std::min (fastest,
        seconds_to_stop_a_parked_worker (
        mock->fast_url (), true, std::chrono::milliseconds (30)));
    }
    EXPECT_LT (fastest, 0.08)
    << "a 30ms drain outlived its deadline: the park ran its whole "
       "TOKEN_WAIT_CAP_MS slice past it";
}
