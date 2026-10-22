/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/worker_count_test.cpp
 * @brief The one fallback for an undetectable core count (issue #1921):
 *        `/health` and the event loop both resolve through
 *        `effective_worker_count`, so neither can report or spawn 0 workers;
 *        and the per-host connection limit sized from that count (#2394).
 */

#include <gtest/gtest.h>

#include <array>
#include <cstddef>

#include "vayu/core/worker_count.hpp"

namespace {

using vayu::core::effective_worker_count;
using vayu::core::FALLBACK_WORKER_COUNT;

TEST (WorkerCountTest, AnUndetectableCoreCountFallsBackToFour) {
    // `std::thread::hardware_concurrency ()` is 0 when the OS cannot say.
    EXPECT_EQ (effective_worker_count (0), FALLBACK_WORKER_COUNT);
    EXPECT_EQ (FALLBACK_WORKER_COUNT, 4u);
}

TEST (WorkerCountTest, ADetectedCoreCountIsUsedAsIs) {
    EXPECT_EQ (effective_worker_count (1), 1u);
    EXPECT_EQ (effective_worker_count (8), 8u);
    EXPECT_EQ (effective_worker_count (128), 128u);
}

// The per-host limit covers each worker's share of the virtual users (#2394).
// Mutation-check: return `configured` unchanged and every raised row fails.
TEST (EffectiveMaxPerHostTest, RaisesTheLimitToEachWorkersShareAndNeverLowersIt) {
    struct Row {
        std::size_t configured;
        std::size_t concurrency;
        std::size_t workers;
        std::size_t expected;
        const char* why;
    };
    const std::array<Row, 6> rows = { {
    { 200, 100, 1, 200, "one worker, 100 users: the setting already covers it" },
    { 200, 2000, 4, 500, "four workers, 2000 users: 500 each" },
    { 200, 500, 4, 200, "four workers, 500 users: 125 each, under the setting" },
    { 800, 2000, 4, 800, "a setting above the share is kept" },
    { 200, 2001, 4, 501, "an uneven split rounds up, not down" },
    { 1, 300, 0, 300, "an unknown worker count sizes for one worker" },
    } };
    for (const auto& row : rows) {
        EXPECT_EQ (vayu::core::effective_max_per_host (
                   row.configured, row.concurrency, row.workers),
        row.expected)
        << row.why;
    }
}

} // namespace
