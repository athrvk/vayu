/**
 * @file tests/stop_signal_test.cpp
 * @brief `vayu::utils::StopSignal` (#3345): a wait runs its course unless a
 *        stop is requested, and a request ends one already in progress.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <thread>

#include "vayu/utils/stop_signal.hpp"
#include "wait_until.hpp"

using vayu::utils::StopSignal;

namespace {

TEST (StopSignal, AWaitNobodyStopsRunsOutAndSaysSo) {
    const StopSignal signal;
    EXPECT_FALSE (signal.stopped ());
    EXPECT_FALSE (signal.wait_for (std::chrono::milliseconds (1)));
    EXPECT_FALSE (signal.stopped ());
}

TEST (StopSignal, ARequestEndsAWaitAlreadyInProgress) {
    StopSignal signal;
    std::atomic<bool> waiting{ false };
    std::atomic<bool> woken{ false };
    std::chrono::steady_clock::duration waited{};

    std::thread waiter ([&] {
        const auto began = std::chrono::steady_clock::now ();
        waiting.store (true);
        woken.store (signal.wait_for (vayu::tests::WAIT_DEADLINE));
        waited = std::chrono::steady_clock::now () - began;
    });
    ASSERT_TRUE (vayu::tests::wait_until ([&] { return waiting.load (); }))
    << "the waiter thread never started";
    signal.request ();
    waiter.join ();

    EXPECT_TRUE (woken.load ());
    // Healthy: the request wakes the wait within microseconds. Broken (the
    // request stores the flag without notifying): the wait runs its whole
    // WAIT_DEADLINE, 20s. Ten seconds sits between them. Mutation check: drop
    // `wake_.notify_all ()` from `request` and this fails at 20s.
    EXPECT_LT (waited, vayu::tests::WAIT_DEADLINE / 2);
}

TEST (StopSignal, AfterARequestEveryWaitReturnsAtOnceAndItStaysStopped) {
    StopSignal signal;
    signal.request ();
    signal.request ();
    EXPECT_TRUE (signal.stopped ());
    // The answer alone proves nothing: a wait that ignored the flag would
    // still answer true, after the whole 20s WAIT_DEADLINE. Healthy, it returns
    // at once; ten seconds sits between the two.
    const auto began = std::chrono::steady_clock::now ();
    EXPECT_TRUE (signal.wait_for (vayu::tests::WAIT_DEADLINE));
    EXPECT_LT (std::chrono::steady_clock::now () - began, vayu::tests::WAIT_DEADLINE / 2);
}

} // namespace
