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
 *        `effective_worker_count`, so neither can report or spawn 0 workers.
 */

#include <gtest/gtest.h>

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

} // namespace
