/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file run_phase_test.cpp
 * @brief A run's phase and the phase its first Stop landed in (#3341).
 *
 * The latch is what gives a Stop one meaning per phase: one that lands before
 * the strategy returns decides the outcome, one that lands later only cuts the
 * drain short. These cases hold the latch itself (once, at the phase it
 * observed, totally ordered against the worker's advance) and the one side
 * effect `RunContext::request_stop` adds per phase: cancelling the event loop
 * from the drain on, and not before.
 */

#include <gtest/gtest.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <iostream>
#include <memory>
#include <optional>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "mock_server.hpp"
#include "optional_assert.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/run_phase.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "wait_until.hpp"

namespace {

using vayu::core::RunContext;
using vayu::core::RunPhase;
using vayu::core::RunPhaseLatch;

constexpr auto PHASES = std::to_array ({ RunPhase::setup, RunPhase::sending,
RunPhase::draining, RunPhase::summarising, RunPhase::settled });

std::unique_ptr<RunContext> make_context () {
    return std::make_unique<RunContext> ("run-phase",
    nlohmann::json{ { "mode", "constant_rps" }, { "duration", "1s" } });
}

TEST (RunPhaseLatch, StartsInSetupWithNoStop) {
    const RunPhaseLatch latch;
    EXPECT_EQ (latch.phase (), RunPhase::setup);
    EXPECT_FALSE (latch.stop_phase ().has_value ());
}

// Forward only: a phase may be skipped (a sequential run has no drain, a
// failure goes straight to settled) but never revisited.
TEST (RunPhaseLatch, AdvancesForwardOnlyAndMaySkip) {
    RunPhaseLatch latch;
    latch.advance (RunPhase::draining);
    EXPECT_EQ (latch.phase (), RunPhase::draining);
    latch.advance (RunPhase::sending);
    EXPECT_EQ (latch.phase (), RunPhase::draining)
    << "an advance moved backwards";
    latch.advance (RunPhase::settled);
    EXPECT_EQ (latch.phase (), RunPhase::settled);
}

// The first Stop is the one that counts: a later call answers the phase it
// observed but leaves the latch where the first one put it, and an advance
// after the latch neither erases it nor is erased by it.
TEST (RunPhaseLatch, LatchesOnceAtTheFirstStop) {
    RunPhaseLatch latch;
    latch.advance (RunPhase::sending);
    EXPECT_EQ (latch.latch_stop (), RunPhase::sending);

    latch.advance (RunPhase::draining);
    EXPECT_EQ (latch.phase (), RunPhase::draining);
    EXPECT_EQ (latch.latch_stop (), RunPhase::draining);
    EXPECT_EQ (latch.stop_phase (), RunPhase::sending)
    << "a second Stop moved the latch";
    EXPECT_EQ (latch.phase (), RunPhase::draining) << "a Stop moved the phase";
}

TEST (RunPhaseLatch, LatchesThePhaseItLandsIn) {
    for (const auto phase : PHASES) {
        RunPhaseLatch latch;
        latch.advance (phase);
        EXPECT_EQ (latch.latch_stop (), phase);
        EXPECT_EQ (latch.stop_phase (), phase);
    }
}

// What each latched phase means for the run: only a Stop before the strategy
// returned on its own decides the outcome; every Stop is a requested one.
TEST (RunContextStop, OnlyAStopBeforeTheDrainDecidesTheOutcome) {
    for (const auto phase : PHASES) {
        auto context = make_context ();
        context->advance_phase (phase);
        EXPECT_FALSE (context->stop_was_requested ());
        EXPECT_FALSE (context->stop_decides_outcome ());

        context->request_stop ();
        context->request_stop ();
        const bool before_drain = phase < RunPhase::draining;
        EXPECT_EQ (context->stop_decides_outcome (), before_drain)
        << "latched in phase " << static_cast<int> (phase);
        EXPECT_TRUE (context->stop_was_requested ());
        EXPECT_TRUE (context->should_stop.load ())
        << "the strategies' cancel flag was not raised";
    }
}

// The worker advances while a stopper latches. Whichever the atomic orders
// first is what the other sees, so the worker's own read of the latch right
// after an advance agrees with where the latch ends up: no latch seen means
// the Stop landed at or after that phase, a latch seen is the final one and
// is not ahead of the phase. The drain choice is that read at `draining`.
TEST (RunPhaseLatch, AdvanceAndLatchAreTotallyOrdered) {
    constexpr size_t TRIALS     = 2000;
    size_t latched_before_drain = 0;
    size_t latched_from_drain   = 0;

    for (size_t trial = 0; trial < TRIALS; ++trial) {
        RunPhaseLatch latch;
        std::atomic<bool> go{ false };
        std::array<std::optional<RunPhase>, PHASES.size ()> seen_after{};
        RunPhase observed = RunPhase::setup;

        std::thread worker ([&] {
            while (!go.load (std::memory_order_acquire)) {
                std::this_thread::yield ();
            }
            for (size_t i = 1; i < PHASES.size (); ++i) {
                latch.advance (PHASES.at (i));
                seen_after.at (i) = latch.stop_phase ();
            }
        });
        std::thread stopper ([&] {
            while (!go.load (std::memory_order_acquire)) {
                std::this_thread::yield ();
            }
            observed = latch.latch_stop ();
        });
        go.store (true, std::memory_order_release);
        worker.join ();
        stopper.join ();

        const auto latched = latch.stop_phase ();
        ASSERT_HAS_VALUE (latched);
        ASSERT_EQ (*latched, observed) << "trial " << trial;
        EXPECT_EQ (latch.phase (), RunPhase::settled) << "trial " << trial;
        for (size_t i = 1; i < PHASES.size (); ++i) {
            const auto& seen = seen_after.at (i);
            if (seen) {
                ASSERT_EQ (*seen, *latched) << "trial " << trial;
                ASSERT_LE (*seen, PHASES.at (i)) << "trial " << trial;
            } else {
                ASSERT_GE (*latched, PHASES.at (i)) << "trial " << trial;
            }
        }
        (*latched <= RunPhase::sending ? latched_before_drain : latched_from_drain)++;
    }
    // Not asserted: which side wins is the scheduler's. Printed so a run that
    // only ever exercised one interleaving is visible in the log.
    std::cout << "[ latched before the drain " << latched_before_drain
              << ", from the drain on " << latched_from_drain << " ]\n";
}

// ---------------------------------------------------------------------------
// request_stop and the event loop
// ---------------------------------------------------------------------------

class RunContextStopLoopTest : public ::testing::Test {
    protected:
    // Under the mock's 30s hold on /hang, so a drain request_stop failed to
    // cancel waits this out: the broken reading is ~20s, the healthy one a
    // cancel, a wake and a join (well under a second). STOP_BUDGET_MS sits
    // between, and the broken side stays under the 60s CTest timeout.
    static constexpr auto DRAIN_DEADLINE    = std::chrono::milliseconds (20000);
    static constexpr int64_t STOP_BUDGET_MS = 5000;
    static constexpr size_t IN_FLIGHT       = 4;

    void SetUp () override {
        vayu::http::global_init ();
        server  = std::make_unique<vayu::tests::SlowMockServer> ();
        context = make_context ();
        vayu::http::EventLoopConfig cfg;
        cfg.num_workers    = 1;
        cfg.max_concurrent = 16;
        cfg.max_per_host   = 16;
        auto loop          = std::make_unique<vayu::http::EventLoop> (cfg);
        loop->start ();
        context->publish_event_loop (std::move (loop));
    }
    void TearDown () override {
        context.reset ();
        server.reset ();
        vayu::http::global_cleanup ();
    }

    void submit_hung (size_t count) {
        vayu::Request request;
        request.method     = vayu::HttpMethod::GET;
        request.url        = server->hang_url ();
        request.timeout_ms = 120000;
        for (size_t i = 0; i < count; ++i) {
            context->event_loop->submit (request,
            [this] (size_t, const vayu::Result<vayu::Response>&) { completed++; });
        }
    }

    std::unique_ptr<vayu::tests::SlowMockServer> server;
    std::unique_ptr<RunContext> context;
    std::atomic<size_t> completed{ 0 };
};

// The worker is blocked in a natural-end drain against an upstream that never
// answers; a Stop from another thread cuts it short. Mutation check: drop the
// cancel from `RunContext::request_stop` and the drain runs to its deadline.
TEST_F (RunContextStopLoopTest, AStopInTheDrainCancelsIt) {
    submit_hung (IN_FLIGHT);
    ASSERT_TRUE (vayu::tests::wait_until (
    [&] { return context->active_transfer_count () == IN_FLIGHT; }))
    << "the transfers never reached curl; the test cannot prove anything";

    context->advance_phase (RunPhase::sending);
    context->advance_phase (RunPhase::draining);
    std::atomic<bool> draining{ false };
    std::thread worker ([&] {
        draining.store (true);
        context->event_loop->stop (true, DRAIN_DEADLINE);
    });
    // EXPECT, not ASSERT: returning here would destroy a joinable thread.
    EXPECT_TRUE (vayu::tests::wait_until ([&] { return draining.load (); }));

    const auto stop_start = std::chrono::steady_clock::now ();
    context->request_stop ();
    worker.join ();
    const auto stop_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - stop_start)
                         .count ();

    EXPECT_LT (stop_ms, STOP_BUDGET_MS)
    << "the drain outlived the Stop by " << stop_ms << "ms";
    EXPECT_EQ (completed.load (), IN_FLIGHT);
    EXPECT_FALSE (context->stop_decides_outcome ());
}

// While sending, the strategy is still the producer: a Stop leaves the loop
// running for it (a cancelled loop consumes nothing, so the producer would
// block on a full queue) and the worker chooses the cancelling stop itself.
// Proved by the loop still taking new work after the Stop. Mutation check:
// cancel on every phase in `request_stop` and the late submission is never
// picked up.
TEST_F (RunContextStopLoopTest, AStopWhileSendingLeavesTheLoopToTheWorker) {
    submit_hung (IN_FLIGHT);
    ASSERT_TRUE (vayu::tests::wait_until (
    [&] { return context->active_transfer_count () == IN_FLIGHT; }));

    context->advance_phase (RunPhase::sending);
    context->request_stop ();
    EXPECT_TRUE (context->stop_decides_outcome ());

    submit_hung (1);
    EXPECT_TRUE (vayu::tests::wait_until (
    [&] { return context->active_transfer_count () == IN_FLIGHT + 1; }))
    << "a Stop while sending cancelled the loop under the strategy";

    context->event_loop->stop (false);
    EXPECT_EQ (completed.load (), IN_FLIGHT + 1);
}

} // namespace
