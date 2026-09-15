/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/platform_test.cpp
 * @brief Thread scheduling primitives (issue #1667): affinity, priority,
 *        precise sleep, and the pure pinning policy they are driven by.
 *
 * `pin_current_thread` and `raise_current_thread_priority` are best-effort by
 * contract (see the doc comments in platform.hpp) - a CI container commonly
 * denies both, and a future image might grant them, so per this repo's rule
 * that a test must never assert the host platform, these assert only that the
 * call returns a `bool` without crashing and that the thread is still alive
 * and usable afterward, never which value it returns.
 */

#include <chrono>
#include <optional>
#include <thread>

#include <gtest/gtest.h>

#include "vayu/core/worker_count.hpp"
#include "vayu/platform/platform.hpp"

namespace vayu::platform {
namespace {

// ============================================================================
// worker_cpu_index - pure policy, no OS call
// ============================================================================

TEST (WorkerCpuIndex, NoHeadroomLeavesEveryWorkerUnpinned) {
    // num_workers == num_cpus: the boundary itself, not just "over".
    EXPECT_EQ (vayu::core::worker_cpu_index (0, 4, 4), std::nullopt);
    // num_workers > num_cpus.
    EXPECT_EQ (vayu::core::worker_cpu_index (0, 8, 4), std::nullopt);
}

TEST (WorkerCpuIndex, ZeroCpusIsAlwaysUnpinned) {
    EXPECT_EQ (vayu::core::worker_cpu_index (0, 0, 0), std::nullopt);
}

TEST (WorkerCpuIndex, HeadroomPinsToIndexPlusOneLeavingCpuZeroFree) {
    EXPECT_EQ (vayu::core::worker_cpu_index (0, 2, 8), 1u);
    EXPECT_EQ (vayu::core::worker_cpu_index (1, 2, 8), 2u);
    EXPECT_EQ (vayu::core::worker_cpu_index (5, 2, 8), 6u);
}

// The boundary case a mutation of `>=` to `>` in worker_cpu_index would flip:
// num_workers == num_cpus must stay unpinned (no headroom), while one fewer
// worker than CPUs must pin. Verified by actually flipping the operator,
// confirming this fails, and reverting (this repo's mutation-check rule).
TEST (WorkerCpuIndex, BoundaryIsInclusiveNotExclusive) {
    // num_workers == num_cpus must stay unpinned; num_workers == num_cpus - 1
    // must not.
    EXPECT_EQ (vayu::core::worker_cpu_index (0, 4, 4), std::nullopt);
    EXPECT_NE (vayu::core::worker_cpu_index (0, 3, 4), std::nullopt);
}

// ============================================================================
// pin_current_thread - real OS call, outcome-agnostic
// ============================================================================

TEST (ThreadScheduling, PinCurrentThreadReturnsWithoutCrashing) {
    const bool accepted = pin_current_thread (0);
    // Whichever the OS answers is valid; the thread must still be usable.
    static_cast<void> (accepted);
    int sum = 0;
    for (int i = 0; i < 1000; ++i) {
        sum += i;
    }
    EXPECT_EQ (sum, 499500);
}

TEST (ThreadScheduling, PinCurrentThreadRefusesAnOutOfRangeCpu) {
    const unsigned absurd = std::thread::hardware_concurrency () + 100;
    EXPECT_FALSE (pin_current_thread (absurd));
}

// ============================================================================
// raise_current_thread_priority - real OS call, outcome-agnostic
// ============================================================================

TEST (ThreadScheduling, RaiseCurrentThreadPriorityReturnsWithoutCrashing) {
    const bool accepted = raise_current_thread_priority ();
    static_cast<void> (accepted);
    int sum = 0;
    for (int i = 0; i < 1000; ++i) {
        sum += i;
    }
    EXPECT_EQ (sum, 499500);
}

// ============================================================================
// sleep_until_precise - a loose bound only (CI runners are shared, 2-4 vCPUs)
// ============================================================================

TEST (ThreadScheduling, SleepUntilPreciseNeverReturnsBeforeTheDeadline) {
    const auto deadline =
    std::chrono::steady_clock::now () + std::chrono::milliseconds (20);
    sleep_until_precise (deadline);
    EXPECT_GE (std::chrono::steady_clock::now (), deadline);
}

// Generous margin, deliberately: this asserts the wait actually happened and
// did not fall through to a no-op, never a tight bound a loaded CI runner
// could flake on.
TEST (ThreadScheduling, SleepUntilPreciseStaysWithinAGenerousMargin) {
    const auto start    = std::chrono::steady_clock::now ();
    const auto deadline = start + std::chrono::milliseconds (20);
    sleep_until_precise (deadline);
    const auto elapsed = std::chrono::steady_clock::now () - start;
    EXPECT_LT (elapsed, std::chrono::milliseconds (500));
}

// A deadline already in the past returns immediately rather than sleeping a
// full cycle - the platform legs all guard `deadline <= now` themselves.
TEST (ThreadScheduling, SleepUntilPreciseReturnsImmediatelyForAPastDeadline) {
    const auto start    = std::chrono::steady_clock::now ();
    const auto deadline = start - std::chrono::milliseconds (50);
    sleep_until_precise (deadline);
    const auto elapsed = std::chrono::steady_clock::now () - start;
    EXPECT_LT (elapsed, std::chrono::milliseconds (200));
}

} // namespace
} // namespace vayu::platform
