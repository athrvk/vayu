/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/high_resolution_timer_test.cpp
 * @brief The 1 ms timer request's refcount: what a scope takes, it gives back
 *
 * The OS call behind it is Windows-only, but the refcount and the balance rule
 * are not, so these run on every leg (issue #1161). What they hold is the
 * invariant a run-scoped request needs: an idle engine holds nothing, nesting
 * takes the request once, and concurrent runs starting and finishing cannot
 * leave the count - or the resolution the count stands for - stuck either way.
 */

#include <atomic>
#include <memory>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "vayu/platform/platform.hpp"

namespace vayu::platform {
namespace {

TEST (HighResolutionTimer, NothingIsHeldByAnIdleEngine) {
    EXPECT_EQ (high_resolution_timer_holders (), 0);
}

TEST (HighResolutionTimer, AScopeTakesTheRequestAndGivesItBack) {
    {
        const HighResolutionTimerScope scope;
        EXPECT_EQ (high_resolution_timer_holders (), 1);
    }
    EXPECT_EQ (high_resolution_timer_holders (), 0);
}

// Two runs overlap all the time - one starting while another drains - so the
// second holder must not re-take the request and the first release must not
// hand it back under the run still sending.
TEST (HighResolutionTimer, NestedScopesCountAndTheLastOneReleases) {
    auto outer = std::make_unique<HighResolutionTimerScope> ();
    EXPECT_EQ (high_resolution_timer_holders (), 1);

    auto inner = std::make_unique<HighResolutionTimerScope> ();
    EXPECT_EQ (high_resolution_timer_holders (), 2);

    outer.reset ();
    EXPECT_EQ (high_resolution_timer_holders (), 1);

    inner.reset ();
    EXPECT_EQ (high_resolution_timer_holders (), 0);
}

// The reason the refcount is a mutex and not a bare atomic: the count and the
// OS call have to move together. This is the shape that used to be a plain
// `int` written from one thread only, and would now be written from every run
// worker at once.
TEST (HighResolutionTimer, ConcurrentHoldersBalanceToZero) {
    constexpr int thread_count      = 8;
    constexpr int scopes_per_thread = 200;

    std::atomic<bool> start{ false };
    std::atomic<int> negative_readings{ 0 };
    std::vector<std::thread> threads;
    threads.reserve (thread_count);

    for (int i = 0; i < thread_count; ++i) {
        threads.emplace_back ([&] () {
            while (!start.load ()) {
                std::this_thread::yield ();
            }
            for (int n = 0; n < scopes_per_thread; ++n) {
                const HighResolutionTimerScope scope;
                // Never negative and never zero while this thread holds one:
                // a lost increment or a double release shows up here.
                if (high_resolution_timer_holders () < 1) {
                    negative_readings.fetch_add (1);
                }
            }
        });
    }

    start.store (true);
    for (auto& thread : threads) {
        thread.join ();
    }

    EXPECT_EQ (negative_readings.load (), 0);
    EXPECT_EQ (high_resolution_timer_holders (), 0);
}

} // namespace
} // namespace vayu::platform
