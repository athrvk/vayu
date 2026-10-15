/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/live_metrics_route_test.cpp
 * @brief When `GET /runs/:id/live` ends, and what its `complete` frame says
 *        (issue #2140).
 *
 * On the load path the tick thread sets `closed` before the worker writes the
 * run's terminal status, so a stream that ended on `closed` sent `complete`
 * with no status and the app reported a lost stream. These drive the extracted
 * poll (`live_metrics_step`) with an injected clock: no DataSink, no threads.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"

namespace {

using vayu::http::routes::live_metrics_step;
using vayu::http::routes::LiveMetricsCursor;

constexpr auto SETTLE_BOUND =
std::chrono::milliseconds (vayu::core::constants::server::LIVE_SETTLE_TIMEOUT_MS);

class LiveMetricsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_live_metrics_route.db";
    static constexpr const char* RUN_ID  = "run_live";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();

        vayu::db::Run run;
        run.id              = RUN_ID;
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Running;
        run.start_time      = 1000;
        run.config_snapshot = "{}";
        db_->create_run (run);

        // The moment the bug lived in: the tick thread has appended its last
        // tick and closed the topic, and the worker is still in its tail.
        context_ = std::make_shared<vayu::core::RunContext> (RUN_ID, nlohmann::json{});
        context_->append_tick ("event: metrics\nid: 0\ndata: {}\n\n");
        context_->closed.store (true, std::memory_order_release);
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    // The JSON a `complete` frame carries on its `data:` line.
    static nlohmann::json completion_data (const std::string& frame) {
        const std::string prefix = "event: complete\ndata: ";
        EXPECT_EQ (frame.rfind (prefix, 0), 0u) << frame;
        return nlohmann::json::parse (frame.substr (prefix.size ()));
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::shared_ptr<vayu::core::RunContext> context_;
    const std::chrono::steady_clock::time_point t0_ = std::chrono::steady_clock::now ();
};

TEST_F (LiveMetricsRouteTest, WaitsForTheRunToSettleThenCompletesWithItsStatus) {
    LiveMetricsCursor cursor;

    auto first = live_metrics_step (*db_, RUN_ID, *context_, cursor, t0_);
    EXPECT_EQ (first.ticks.size (), 1u);
    EXPECT_EQ (cursor.offset, 1u);
    EXPECT_FALSE (first.completion.has_value ())
    << "completed on `closed` while the run row still says running";

    auto waiting = live_metrics_step (
    *db_, RUN_ID, *context_, cursor, t0_ + std::chrono::seconds (1));
    EXPECT_TRUE (waiting.ticks.empty ());
    EXPECT_FALSE (waiting.completion.has_value ());

    // The worker's tail: terminal status, then retain_run's settle.
    db_->update_run_status (RUN_ID, vayu::RunStatus::Completed);
    context_->settled.store (true, std::memory_order_release);

    auto last = live_metrics_step (
    *db_, RUN_ID, *context_, cursor, t0_ + std::chrono::seconds (2));
    EXPECT_TRUE (last.ticks.empty ());
    ASSERT_HAS_VALUE (last.completion);
    const auto data = completion_data (*last.completion);
    EXPECT_EQ (data["runId"], RUN_ID);
    EXPECT_EQ (data.value ("status", ""), "completed") << data.dump ();
}

TEST_F (LiveMetricsRouteTest, GivesUpAtTheSettleBoundWithoutAStatus) {
    LiveMetricsCursor cursor;

    // The bound runs from the first poll that found the run closed and drained.
    EXPECT_FALSE (
    live_metrics_step (*db_, RUN_ID, *context_, cursor, t0_).completion.has_value ());
    EXPECT_FALSE (live_metrics_step (*db_, RUN_ID, *context_, cursor,
    t0_ + SETTLE_BOUND - std::chrono::milliseconds (1))
    .completion.has_value ());

    auto at_bound = live_metrics_step (*db_, RUN_ID, *context_, cursor, t0_ + SETTLE_BOUND);
    ASSERT_HAS_VALUE (at_bound.completion)
    << "a worker that never settles must not hold the stream open forever";
    const auto data = completion_data (*at_bound.completion);
    EXPECT_EQ (data["runId"], RUN_ID);
    EXPECT_FALSE (data.contains ("status"))
    << "a non-terminal row's status was reported: " << data.dump ();
}

// The bound waits on the run, not on the ticks: while ticks are still unsent
// the stream is not drained and the clock has not started.
TEST_F (LiveMetricsRouteTest, TheSettleBoundStartsOnlyOnceTheTicksAreSent) {
    LiveMetricsCursor cursor;
    context_->closed.store (false, std::memory_order_release);

    auto open = live_metrics_step (*db_, RUN_ID, *context_, cursor, t0_);
    EXPECT_EQ (open.ticks.size (), 1u);
    EXPECT_FALSE (open.completion.has_value ());
    EXPECT_FALSE (cursor.drained_since.has_value ());

    context_->closed.store (true, std::memory_order_release);
    const auto closed_at = t0_ + SETTLE_BOUND;
    EXPECT_FALSE (
    live_metrics_step (*db_, RUN_ID, *context_, cursor, closed_at).completion.has_value ());
    EXPECT_FALSE (live_metrics_step (*db_, RUN_ID, *context_, cursor,
    closed_at + SETTLE_BOUND - std::chrono::milliseconds (1))
    .completion.has_value ());
    EXPECT_TRUE (live_metrics_step (*db_, RUN_ID, *context_, cursor, closed_at + SETTLE_BOUND)
    .completion.has_value ());
}

} // namespace
