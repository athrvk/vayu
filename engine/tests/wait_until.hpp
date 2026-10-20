#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/wait_until.hpp
 * @brief `wait_until` - wait on a condition, never on a duration.
 *
 * A test that sleeps a fixed time and then asserts something happened is
 * asserting how fast the runner is. The same code passes on an idle machine and
 * fails on a macOS runner oversubscribed by `ctest -j3`, a Windows timer that
 * ticks every 15.6ms, or a sanitizer build ten times slower. Waiting on the
 * condition itself with a deadline far past any healthy run makes the healthy
 * case as fast as the machine allows and leaves only a real failure to reach
 * the deadline.
 *
 * The deadline is not a performance budget: it only bounds how long a broken
 * build takes to report. Keep it well under the CTest per-test timeout so the
 * failure names the condition rather than `***Timeout`.
 */

#include <chrono>
#include <thread>

namespace vayu::tests {

/// Far past any healthy wait on the slowest leg (TSan on macOS), well under
/// the 60s CTest per-test timeout.
inline constexpr auto WAIT_DEADLINE = std::chrono::seconds (20);

/// Polls @p condition until it holds or @p deadline passes; answers whether it
/// held. Call it under an `ASSERT_TRUE` / `EXPECT_TRUE` with a message naming
/// what was awaited.
template <typename Condition>
[[nodiscard]] bool wait_until (Condition&& condition,
std::chrono::milliseconds deadline = WAIT_DEADLINE,
std::chrono::milliseconds poll     = std::chrono::milliseconds (5)) {
    const auto until = std::chrono::steady_clock::now () + deadline;
    while (!condition ()) {
        if (std::chrono::steady_clock::now () >= until) {
            return condition ();
        }
        std::this_thread::sleep_for (poll);
    }
    return true;
}

} // namespace vayu::tests
