/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_row_seed_test.cpp
 * @brief The run row's timestamp invariant, held at the two insert sites.
 *
 * The design-mode insert used to stamp `start_time` and nothing else, leaving
 * `end_time` indeterminate (the field had no default). Normal completion hid
 * it - `update_run_status` stamps `end_time` on every terminal write - but a
 * run orphaned by a daemon crash is marked Failed with `end_time` *as
 * recorded*, so the garbage reached the report, where the reader's
 * `end_time > 0 ? end_time : now_ms()` guard rescued it only by luck.
 *
 * `seed_run_times` is the one place that stamps both, so testing it covers
 * both inserts (the suite has no in-process HTTP route harness); the field
 * default is the backstop for a future insert site that forgets to call it,
 * and is asserted in db_test.cpp against the real reconcile path.
 */

#include <gtest/gtest.h>

#include <cstdint>

#include "vayu/types.hpp"

namespace vayu::http::routes {
// Declared in execution.cpp.
void seed_run_times (vayu::db::Run& run, int64_t started_at);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::seed_run_times;

TEST (SeedRunTimes, SeedsEndTimeAlongsideStartTime) {
    vayu::db::Run run;
    seed_run_times (run, 1'700'000'000'000);

    EXPECT_EQ (run.start_time, 1'700'000'000'000);
    // Not left at 0: a crash-orphaned run keeps whatever is recorded here, and
    // 0 would make the report substitute the (arbitrarily much later) read time.
    EXPECT_EQ (run.end_time, 1'700'000'000'000);
}

TEST (SeedRunTimes, RunEndTimeDefaultsToZeroBeforeAnySeed) {
    // The backstop: an insert site that never calls seed_run_times still
    // stores a value every reader's `> 0` guard understands, rather than
    // whatever happened to be on the stack.
    vayu::db::Run run;
    EXPECT_EQ (run.end_time, 0);
}

} // namespace
