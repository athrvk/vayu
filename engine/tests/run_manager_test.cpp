#include "optional_assert.hpp"
#include "vayu/core/run_manager.hpp"
#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "mock_server.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/platform/platform.hpp"
#include "wait_until.hpp"

using namespace vayu::core;

TEST (RunContextTopic, AppendsAndSnapshotsInOrder) {
    nlohmann::json cfg;
    RunContext ctx ("r", cfg);

    EXPECT_EQ (ctx.tick_count (), 0u);
    ctx.append_tick ("a");
    ctx.append_tick ("b");
    ctx.append_tick ("c");

    EXPECT_EQ (ctx.tick_count (), 3u);
    EXPECT_EQ (ctx.published_count.load (), 3u);

    auto from0 = ctx.ticks_since (0);
    ASSERT_EQ (from0.payloads.size (), 3u);
    EXPECT_EQ (from0.payloads[0], "a");
    EXPECT_EQ (from0.payloads[2], "c");
    EXPECT_EQ (from0.next_offset, 3u);

    auto from2 = ctx.ticks_since (2);
    ASSERT_EQ (from2.payloads.size (), 1u);
    EXPECT_EQ (from2.payloads[0], "c");
    EXPECT_EQ (from2.next_offset, 3u);

    EXPECT_TRUE (ctx.ticks_since (3).payloads.empty ());
    EXPECT_TRUE (ctx.ticks_since (99).payloads.empty ());
    // A consumer that is ahead of the producer must not be dragged backwards.
    EXPECT_EQ (ctx.ticks_since (99).next_offset, 99u);
}

// The tick topic is a ring, not an append-only log: a run's duration is
// user-controlled, so an unbounded buffer is a slow OOM on a soak test.
TEST (RunContextTopic, RingEvictsOldestAndKeepsIdsMonotonic) {
    nlohmann::json cfg;
    RunContext ctx ("r", cfg);

    const size_t cap   = ctx.max_live_ticks.load ();
    const size_t extra = 5;
    for (size_t i = 0; i < cap + extra; ++i) {
        ctx.append_tick ("tick-" + std::to_string (i));
    }

    // Retained window is bounded ...
    EXPECT_EQ (ctx.tick_count (), cap);
    // ... but the published id sequence keeps counting, so SSE event ids (and
    // the /live termination check that compares against them) stay monotonic.
    EXPECT_EQ (ctx.published_count.load (), cap + extra);

    auto newest = ctx.ticks_since (cap + extra - 1);
    ASSERT_EQ (newest.payloads.size (), 1u);
    EXPECT_EQ (newest.payloads[0], "tick-" + std::to_string (cap + extra - 1));

    // A resume from before the retained window is served the oldest retained
    // tick and fast-forwarded - advancing by batch size instead would leave the
    // consumer permanently re-requesting evicted ids.
    auto stale = ctx.ticks_since (0);
    ASSERT_EQ (stale.payloads.size (), cap);
    EXPECT_EQ (stale.payloads[0], "tick-" + std::to_string (extra));
    EXPECT_EQ (stale.next_offset, cap + extra);
}

// The retained window is a duration (`liveReplayWindowMs`), so the tick count
// must follow the cadence. A fixed count would silently mean a different span
// per `liveTickIntervalMs` setting - the whole reason this is derived.
TEST (LiveRingSize, DerivesTheSameWindowAtEveryTickCadence) {
    const int64_t five_min = 300000;

    // 5 minutes' worth of ticks, whatever the cadence buys per tick.
    EXPECT_EQ (live_ring_size (five_min, 1000), 300u);
    EXPECT_EQ (live_ring_size (five_min, 500), 600u);
    EXPECT_EQ (live_ring_size (five_min, 100), 3000u);

    // Same cadence, longer window -> proportionally more ticks.
    EXPECT_EQ (live_ring_size (60000, 100), 600u);
    EXPECT_EQ (live_ring_size (1800000, 100), 18000u);
}

// The ceiling is what makes the duration safe to expose: at the minimum 10ms
// cadence a 5-minute window is 30000 ticks, and an hour is 360000.
TEST (LiveRingSize, ClampsToTheMemoryCeiling) {
    const size_t ceiling = vayu::core::constants::server::DEFAULT_MAX_LIVE_TICKS;

    EXPECT_EQ (live_ring_size (3600000, 10), ceiling);
    EXPECT_EQ (live_ring_size (3600000, 50), ceiling);
    // Just under it still passes through unclamped.
    EXPECT_EQ (live_ring_size (static_cast<int64_t> (ceiling - 1) * 100, 100), ceiling - 1);
    // The default ceiling is chosen so the longest configurable window is
    // honoured in full at the default cadence - it must NOT clamp there.
    EXPECT_EQ (live_ring_size (3600000, 100), 36000u);
    EXPECT_LT (36000u, ceiling);
}

// The ceiling is the `liveMaxRetainedTicks` setting, so it has to be honoured
// as an argument rather than read from the constant.
TEST (LiveRingSize, HonoursAConfiguredCeiling) {
    EXPECT_EQ (live_ring_size (3600000, 100, 5000), 5000u);
    EXPECT_EQ (live_ring_size (3600000, 100, 200000), 36000u);
    // Raising the ceiling does not enlarge a ring the window already bounds -
    // the window is what sizes it, which is why a bigger ceiling is ~free.
    EXPECT_EQ (live_ring_size (300000, 100, 500000), 3000u);
    // A nonsense ceiling from a hand-edited row falls back rather than
    // collapsing the ring to nothing.
    EXPECT_EQ (live_ring_size (0, 100, 0), vayu::core::constants::server::DEFAULT_MAX_LIVE_TICKS);
}

// 0 is the "Full run" option in the dashboard's window picker - no time limit,
// so the tick ceiling becomes the whole bound. It must NOT be treated as a
// degenerate value and rounded back up to the default window.
TEST (LiveRingSize, ZeroWindowMeansFullRunAndYieldsTheCeiling) {
    const size_t ceiling = vayu::core::constants::server::DEFAULT_MAX_LIVE_TICKS;

    EXPECT_EQ (live_ring_size (0, 100), ceiling);
    EXPECT_EQ (live_ring_size (0, 10), ceiling);
    EXPECT_EQ (live_ring_size (0, 1000), ceiling);
    EXPECT_EQ (live_ring_size (0, 100, 12345), 12345u);
}

// POST /config validates its bounds, but a hand-edited row reaches this
// unvalidated. Dividing by a zero interval is UB, and a negative window is not
// a setting at all - unlike 0, which means "full run".
TEST (LiveRingSize, FallsBackOnInvalidInputsInsteadOfDividingByZero) {
    const size_t stock =
    live_ring_size (vayu::core::constants::server::DEFAULT_LIVE_REPLAY_WINDOW_MS,
    vayu::core::constants::server::STATS_INTERVAL_MS);

    EXPECT_EQ (live_ring_size (300000, 0), 3000u);
    EXPECT_EQ (live_ring_size (300000, -100), 3000u);
    EXPECT_EQ (live_ring_size (-1, 100), stock);
    // A window shorter than one tick still retains a tick - a zero-size ring
    // would make /live replay nothing at all.
    EXPECT_EQ (live_ring_size (50, 100), 1u);
}

// The reservation is duration x RPS x 1.2, and the duration has to be read by
// `parse_duration_ms` rather than by a local strip-one-character-and-multiply.
// Each case below is one the copy it replaced got wrong (#944): put that copy
// back and every one of them fails.
TEST (ExpectedRequestsFor, ReadsTheDurationTheWayTheStrategyDoes) {
    // 300s x 1000 x 1.2. The old copy read "5m" as 5 seconds.
    EXPECT_EQ (expected_requests_for ({ { "duration", "5m" }, { "rps", 1000 } }), 360000u);
    // 60s x 1000 x 1.2 - a bare number is seconds, the same reading
    // parse_duration_ms gives it. The old copy dropped the last digit and read
    // "60" as 6 seconds.
    EXPECT_EQ (expected_requests_for ({ { "duration", "60" }, { "rps", 1000 } }), 72000u);
    // Half a second at 1000 RPS is 600 results, so the floor decides. The old
    // copy read "500ms" as 500 seconds and reserved 600000.
    EXPECT_EQ (expected_requests_for ({ { "duration", "500ms" }, { "rps", 1000 } }), 10000u);
    // 7200s x 100 x 1.2, and the arithmetic stays in int64 on the way.
    EXPECT_EQ (expected_requests_for ({ { "duration", "2h" }, { "rps", 100 } }), 864000u);
}

TEST (ExpectedRequestsFor, TakesTheRpsUnderEitherSpelling) {
    EXPECT_EQ (expected_requests_for ({ { "duration", "10s" }, { "rps", 500 } }), 10000u);
    EXPECT_EQ (
    expected_requests_for ({ { "duration", "100s" }, { "targetRps", 500 } }), 60000u);
    // `rps` wins when both are present, which is the order the report's
    // targetRps is read in too.
    EXPECT_EQ (expected_requests_for (
               { { "duration", "100s" }, { "rps", 500 }, { "targetRps", 1 } }),
    60000u);
    // No RPS at all falls back to the 1000 estimate: 100s x 1000 x 1.2.
    EXPECT_EQ (expected_requests_for ({ { "duration", "100s" } }), 120000u);
}

TEST (ExpectedRequestsFor, ADurationItCannotReadReservesForTheDefaultMinute) {
    // 60s x 1000 x 1.2 in every case - an allocation hint never fails a run the
    // config validator already passed, and never throws out of the constructor.
    const size_t minute = 72000u;
    EXPECT_EQ (expected_requests_for (nlohmann::json::object ()), minute);
    EXPECT_EQ (expected_requests_for ({ { "duration", "5min" } }), minute);
    EXPECT_EQ (expected_requests_for ({ { "duration", "" } }), minute);
    EXPECT_EQ (expected_requests_for ({ { "duration", "-30s" } }), minute);
    // Stored as a number rather than a string - `value<std::string>` would
    // throw on this one, and a reservation is not the place to refuse a run.
    EXPECT_EQ (expected_requests_for ({ { "duration", 30 } }), minute);
    EXPECT_EQ (expected_requests_for ({ { "duration", nullptr } }), minute);
}

// A RunContext that never reaches collect_metrics (a test, or a run whose
// metrics thread has not read config yet) must still be bounded.
TEST (RunContextTopic, RingIsBoundedBeforeConfigIsRead) {
    nlohmann::json cfg;
    RunContext ctx ("r", cfg);
    EXPECT_EQ (ctx.max_live_ticks.load (), 3000u);
    EXPECT_LE (ctx.max_live_ticks.load (), vayu::core::constants::server::DEFAULT_MAX_LIVE_TICKS);
}

// maxStoredErrors has to reach the collector at construction - the store is
// sized from it - so RunManager::start_run passes it and the default covers
// every other caller.
TEST (RunContextTopic, MaxStoredErrorsReachesTheCollector) {
    nlohmann::json cfg;
    RunContext stock ("stock", cfg);
    RunContext raised ("raised", cfg, 42);

    for (size_t i = 0; i < 50; ++i) {
        stock.metrics_collector->record_error (
        vayu::ErrorCode::ConnectionFailed, "boom", "");
        raised.metrics_collector->record_error (
        vayu::ErrorCode::ConnectionFailed, "boom", "");
    }

    EXPECT_EQ (raised.metrics_collector->errors ().size (), 42u);
    EXPECT_EQ (raised.metrics_collector->errors_dropped (), 8u);
    // The stock cap is far above 50, so nothing is dropped there.
    EXPECT_EQ (stock.metrics_collector->errors ().size (), 50u);
    EXPECT_EQ (stock.metrics_collector->errors_dropped (), 0u);
    // The counts stay exact on both regardless of what was stored.
    EXPECT_EQ (raised.metrics_collector->total_errors (), 50u);
    EXPECT_EQ (stock.metrics_collector->total_errors (), 50u);
}

TEST (RunContextTopic, SetMaxLiveTicksResizesTheRetainedWindow) {
    nlohmann::json cfg;
    RunContext ctx ("r", cfg);
    ctx.set_max_live_ticks (4);

    for (size_t i = 0; i < 10; ++i) {
        ctx.append_tick ("tick-" + std::to_string (i));
    }
    EXPECT_EQ (ctx.tick_count (), 4u);
    EXPECT_EQ (ctx.published_count.load (), 10u);

    auto stale = ctx.ticks_since (0);
    ASSERT_EQ (stale.payloads.size (), 4u);
    EXPECT_EQ (stale.payloads[0], "tick-6");
    EXPECT_EQ (stale.next_offset, 10u);

    // Shrinking mid-run converges on the next append, not one eviction per
    // append - an `if` here would take six more ticks to reach the new cap.
    ctx.set_max_live_ticks (2);
    ctx.append_tick ("tick-10");
    EXPECT_EQ (ctx.tick_count (), 2u);
    EXPECT_EQ (ctx.published_count.load (), 11u);
    EXPECT_EQ (ctx.ticks_since (0).payloads[0], "tick-9");

    // A zero cap would divide the ring out of existence; it floors at one.
    ctx.set_max_live_ticks (0);
    ctx.append_tick ("tick-11");
    EXPECT_EQ (ctx.tick_count (), 1u);
    EXPECT_EQ (ctx.ticks_since (0).payloads[0], "tick-11");
}

TEST (RunContextTopic, ClosedAndCompletedDefaults) {
    nlohmann::json cfg;
    RunContext ctx ("r", cfg);
    EXPECT_FALSE (ctx.closed.load ());
    EXPECT_EQ (ctx.completed_at_ms.load (), 0);
}

TEST (RunContextTopic, NullConfigDoesNotThrow) {
    nlohmann::json null_cfg; // default-constructed == JSON null
    EXPECT_NO_THROW ({ RunContext ctx ("r", null_cfg); });
}

TEST (RunManagerRetention, RetainMovesOutOfActiveButKeepsLookup) {
    RunManager mgr;
    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> ("run_x", cfg);
    mgr.register_run ("run_x", ctx);

    EXPECT_EQ (mgr.active_count (), 1u);
    EXPECT_NE (mgr.get_run ("run_x"), nullptr);

    mgr.retain_run ("run_x");

    EXPECT_EQ (mgr.active_count (), 0u);
    EXPECT_EQ (mgr.get_run ("run_x"), nullptr);
    auto found = mgr.get_run_or_retained ("run_x");
    ASSERT_NE (found, nullptr);
    EXPECT_GT (found->completed_at_ms.load (), 0);
}

// `/runs/:id/live` ends on `settled`, not `closed` (#2140), and retain_run is
// the one call every worker exit path makes after its terminal status write.
TEST (RunManagerRetention, RetainMarksTheRunSettled) {
    RunManager mgr;
    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> ("run_settled", cfg);
    mgr.register_run ("run_settled", ctx);
    EXPECT_FALSE (ctx->settled.load ());

    mgr.retain_run ("run_settled");

    EXPECT_TRUE (ctx->settled.load ());
}

// Retention is for the tick topic, and since #1154 that is all it holds: the
// event loop (curl handle pools, the connections cached against the target,
// the submission queues), the bound rows and the plan are released as the run
// is retained, not 60-90s later when the sweeper drops the last reference.
TEST (RunManagerRetention, RetainReleasesTheMachineryAndKeepsTheTopic) {
    RunManager mgr;
    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> ("run_y", cfg);

    vayu::http::EventLoopConfig loop_cfg;
    loop_cfg.num_workers    = 1;
    loop_cfg.max_concurrent = 1;
    ctx->publish_event_loop (std::make_unique<vayu::http::EventLoop> (loop_cfg));
    ctx->load_data = std::make_unique<LoadDataSet> ();
    ctx->scenario  = std::make_shared<const ScenarioExecution> ();
    ctx->append_tick ("tick-0");
    ctx->closed.store (true);
    mgr.register_run ("run_y", ctx);

    mgr.retain_run ("run_y");

    auto found = mgr.get_run_or_retained ("run_y");
    ASSERT_NE (found, nullptr);
    EXPECT_EQ (found->event_loop, nullptr);
    EXPECT_EQ (found->load_data, nullptr);
    EXPECT_EQ (found->scenario, nullptr);
    // The one accessor a reader could still be inside answers for a released
    // loop rather than reading through it.
    EXPECT_EQ (found->active_transfer_count (), 0u);

    // What a late consumer of /runs/:id/live reads is untouched.
    ASSERT_EQ (found->ticks_since (0).payloads.size (), 1u);
    EXPECT_EQ (found->ticks_since (0).payloads[0], "tick-0");
    EXPECT_EQ (found->published_count.load (), 1u);
    EXPECT_TRUE (found->closed.load ());
}

// Windows' 1 ms timer resolution is one of those execution resources since
// issue #1161: the loop asks curl for a 1ms poll, which the OS default would
// round to ~15.6ms, so the loop holds the request for its lifetime. Retention
// is what gives it back - a retained run has stopped sending, and the 60-90s
// window would otherwise be a run's worth of held resolution per run, on a
// sidecar that is idle for almost all of an app session.
TEST (RunManagerRetention, RetainGivesBackTheHighResolutionTimer) {
    EXPECT_EQ (vayu::platform::high_resolution_timer_holders (), 0);

    RunManager mgr;
    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> ("run_z", cfg);
    vayu::http::EventLoopConfig loop_cfg;
    loop_cfg.num_workers    = 1;
    loop_cfg.max_concurrent = 1;
    ctx->publish_event_loop (std::make_unique<vayu::http::EventLoop> (loop_cfg));
    mgr.register_run ("run_z", ctx);

    EXPECT_EQ (vayu::platform::high_resolution_timer_holders (), 1);

    mgr.retain_run ("run_z");

    // Still reachable as a retained run, holding nothing of the machinery.
    auto found = mgr.get_run_or_retained ("run_z");
    ASSERT_NE (found, nullptr);
    EXPECT_EQ (vayu::platform::high_resolution_timer_holders (), 0);
}

// The narrowing that binding the request to the loop buys: a design-mode
// scenario run sends its steps sequentially and builds no event loop, so it
// asks for no timer resolution at all - where a request taken per run would
// have held 1ms resolution for the length of every collection run.
TEST (RunManagerRetention, ARunWithNoEventLoopAsksForNoTimerResolution) {
    nlohmann::json cfg;
    RunContext ctx ("run_sequential", cfg);
    ctx.scenario = std::make_shared<const ScenarioExecution> ();

    EXPECT_EQ (vayu::platform::high_resolution_timer_holders (), 0);
}

// A loop that never reaches retention - a run that threw before its context
// was retained, or a manager destroyed under it - gives the request back all
// the same, because the scope is a member of the loop and not a pair of calls
// to remember.
TEST (RunManagerRetention, ADroppedEventLoopGivesBackTheHighResolutionTimer) {
    EXPECT_EQ (vayu::platform::high_resolution_timer_holders (), 0);
    {
        vayu::http::EventLoopConfig loop_cfg;
        loop_cfg.num_workers    = 1;
        loop_cfg.max_concurrent = 1;
        const vayu::http::EventLoop loop (loop_cfg);
        EXPECT_EQ (vayu::platform::high_resolution_timer_holders (), 1);
    }
    EXPECT_EQ (vayu::platform::high_resolution_timer_holders (), 0);
}

TEST (BuildTickPayload, WrapsStatsAsSseEventWithOffsetId) {
    nlohmann::json stats;
    stats["totalRequests"] = 42;
    std::string p          = vayu::core::build_tick_payload (stats, 7);
    EXPECT_NE (p.find ("event: metrics\n"), std::string::npos);
    EXPECT_NE (p.find ("id: 7\n"), std::string::npos);
    EXPECT_NE (p.find ("\"totalRequests\":42"), std::string::npos);
    EXPECT_EQ (p.substr (p.size () - 2), "\n\n");
}

// A stop request is not the end of the run: the worker acts on should_stop,
// then blocks in event_loop->stop(true) draining in-flight requests, and only
// then clears is_running. The metrics thread used to exit on should_stop, so it
// emitted its "final settled tick" and set closed while requests were still
// completing - the live view froze at the stop click while the stored report,
// written after the drain, counted everything that landed during it.
//
// This drives collect_metrics directly: raise should_stop and assert the stream
// keeps ticking and stays open until is_running goes false.
TEST (CollectMetrics, StaysOpenUntilTheStopDrainCompletes) {
    const std::string db_path = "test_collect_metrics_drain.db";
    vayu::tests::remove_database_files (db_path);

    vayu::db::Database db (db_path);
    db.init ();

    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> ("drain_run", cfg);
    // collect_metrics reads active_count() from the loop on the 1 Hz DB path.
    vayu::http::EventLoopConfig loop_config;
    ctx->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    ctx->is_running = true;

    std::thread metrics ([&] () { collect_metrics (ctx, &db); });

    // Let a few ticks land, then request a stop - as POST /runs/:id/stop does.
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] () { return ctx->published_count.load () >= 3; }))
    << "the metrics thread never ticked";
    size_t ticks_at_stop = ctx->published_count.load ();
    ctx->should_stop     = true;

    // The worker is still draining: the stream must stay open and keep ticking.
    // Three ticks: a thread that exits on should_stop still publishes the tick
    // it was in and its final settled one on the way out, so it never gets
    // here. Mutation check: loop on `is_running && !should_stop` in
    // collect_metrics and this fails.
    EXPECT_TRUE (vayu::tests::wait_until (
    [&] () { return ctx->published_count.load () >= ticks_at_stop + 3; }))
    << "ticks stopped at the stop request instead of covering the drain";
    EXPECT_FALSE (ctx->closed.load ())
    << "closed was signalled on should_stop, before the drain finished";
    EXPECT_GT (ctx->published_count.load (), ticks_at_stop)
    << "ticks stopped at the stop request instead of covering the drain";

    // Drain complete - this is what execute_load_test does after
    // event_loop->stop(true) returns.
    ctx->is_running = false;
    metrics.join ();

    EXPECT_TRUE (ctx->closed.load ());
    ctx->event_loop.reset ();
    vayu::tests::remove_database_files (db_path);
}

// The window is only useful if the run actually reads it. collect_metrics must
// apply liveReplayWindowMs against this run's tick cadence before tick 0, or
// every run keeps the built-in default however the user configured it.
TEST (CollectMetrics, SizesTheReplayRingFromTheConfiguredWindow) {
    const std::string db_path = "test_collect_metrics_window.db";
    vayu::tests::remove_database_files (db_path);

    vayu::db::Database db (db_path);
    db.init ();

    // 20s of history at a 20ms cadence = 1000 ticks - deliberately neither the
    // default window nor the default cadence, so a hardcoded 3000 fails here.
    auto entry = db.get_config_entry ("liveReplayWindowMs");
    ASSERT_HAS_VALUE (entry) << "seed_default_config did not seed the key";
    entry->value = "20000";
    db.save_config_entry (*entry);

    auto tick = db.get_config_entry ("liveTickIntervalMs");
    ASSERT_HAS_VALUE (tick);
    tick->value = "20";
    db.save_config_entry (*tick);

    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> ("window_run", cfg);
    vayu::http::EventLoopConfig loop_config;
    ctx->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    ctx->is_running = true;

    std::thread metrics ([&] () { collect_metrics (ctx, &db); });
    // The ring is sized before tick 0 is published.
    EXPECT_TRUE (
    vayu::tests::wait_until ([&] () { return ctx->published_count.load () > 0; }))
    << "the metrics thread never published tick 0";

    EXPECT_EQ (ctx->max_live_ticks.load (), 1000u)
    << "the ring kept its default instead of the configured window / cadence";

    ctx->is_running = false;
    metrics.join ();
    ctx->event_loop.reset ();
    vayu::tests::remove_database_files (db_path);
}

// start_run spawns the metrics thread before the runner thread has built the
// event loop, so early ticks run against a null `event_loop` (#956). Every
// metrics-thread read goes through active_transfer_count(), whose
// null-before-publish answer is a safe zero - the 1 Hz DB-gated branch used to
// dereference the pointer with no null check at all, so this test crashes on
// the reverted code. The run is held open past one second on purpose, so that
// branch executes at least once.
TEST (CollectMetrics, ReportsZeroActiveBeforeTheLoopIsPublished) {
    const std::string db_path = "test_collect_metrics_unpublished.db";
    vayu::tests::remove_database_files (db_path);

    vayu::db::Database db (db_path);
    db.init ();

    // A run row, so the 1 Hz branch's write lands and says it ran.
    vayu::db::Run run;
    run.id              = "unpublished_run";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = 1;
    run.config_snapshot = "{}";
    db.create_run (run);

    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> (run.id, cfg);
    // Deliberately never set event_loop - this is the window where the runner
    // thread is still in its config reads (or failed before building a loop).
    ctx->is_running = true;

    std::thread metrics ([&] () { collect_metrics (ctx, &db); });
    EXPECT_TRUE (vayu::tests::wait_until (
    [&] () { return !db.get_metric_ticks_since (run.id, 0).empty (); }))
    << "the 1 Hz branch never persisted a tick; nothing is proven";
    ctx->is_running = false;
    metrics.join ();

    // The guard must have scanned something: a run that published no ticks
    // proves nothing about how a tick handles the null.
    EXPECT_GT (ctx->published_count.load (), 0U);
    EXPECT_TRUE (ctx->closed.load ());

    // The published payloads report the null-before-publish default as zero
    // active transfers, not a crash and not a stale number.
    auto batch = ctx->ticks_since (0);
    ASSERT_FALSE (batch.payloads.empty ());
    EXPECT_NE (batch.payloads[0].find ("\"activeConnections\":0"), std::string::npos)
    << "tick payload did not carry the zero default: " << batch.payloads[0];

    vayu::tests::remove_database_files (db_path);
}

// #2124: the persisted tick and the live frame count errors by the one
// definition, from the one snapshot a tick takes, so an HTTP 500 is an error
// on both - the stored row used to read the transport-only counter and record
// 0 failures for a run whose report said 15%.
TEST (CollectMetrics, TheStoredTickAndTheLiveFrameCountHttpErrors) {
    const std::string db_path = "test_collect_metrics_errors.db";
    vayu::tests::remove_database_files (db_path);

    vayu::db::Database db (db_path);
    db.init ();

    vayu::db::Run run;
    run.id              = "errors_run";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = 1;
    run.config_snapshot = "{}";
    db.create_run (run);

    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> (run.id, cfg);
    auto& mc = *ctx->metrics_collector;
    for (int i = 0; i < 80; ++i) {
        mc.record_success (200, 5.0, 0.0);
    }
    for (int i = 0; i < 15; ++i) {
        mc.record_success (500, 5.0, 0.0);
    }
    for (int i = 0; i < 5; ++i) {
        mc.record_error (vayu::ErrorCode::Timeout, "timed out");
    }
    ctx->is_running = true;

    // Held until the DB-gated branch persists a tick.
    std::thread metrics ([&] () { collect_metrics (ctx, &db); });
    EXPECT_TRUE (vayu::tests::wait_until (
    [&] () { return !db.get_metric_ticks_since (run.id, 0).empty (); }));
    ctx->is_running = false;
    metrics.join ();

    const auto ticks = db.get_metric_ticks_since (run.id, 0);
    ASSERT_FALSE (ticks.empty ()) << "no tick was persisted; nothing is proven";
    const auto stored = nlohmann::json::parse (ticks.front ().payload);
    EXPECT_EQ (stored["requests_failed"].get<size_t> (), 20u);
    EXPECT_EQ (stored["http_errors"].get<size_t> (), 15u);
    EXPECT_EQ (stored["no_response"].get<size_t> (), 5u);
    EXPECT_DOUBLE_EQ (stored["error_rate"].get<double> (), 20.0);

    const auto frames = ctx->ticks_since (0);
    ASSERT_FALSE (frames.payloads.empty ());
    // The frame is SSE-framed; its JSON is the one `data:` line.
    constexpr std::string_view data_field = "data: ";
    const std::string_view frame          = frames.payloads.back ();
    const auto data_at                    = frame.find (data_field);
    ASSERT_NE (data_at, std::string_view::npos) << frame;
    const auto json_at = data_at + data_field.size ();
    const auto live    = nlohmann::json::parse (
    frame.substr (json_at, frame.find ('\n', json_at) - json_at));
    EXPECT_EQ (live["totalErrors"].get<size_t> (),
    stored["requests_failed"].get<size_t> ());
    EXPECT_EQ (live["httpErrors"].get<size_t> (), 15u);
    EXPECT_EQ (live["noResponse"].get<size_t> (), 5u);
    EXPECT_DOUBLE_EQ (
    live["errorRate"].get<double> (), stored["error_rate"].get<double> ());

    vayu::tests::remove_database_files (db_path);
}

namespace {

/// The JSON of one SSE-framed live tick: its single `data:` line.
nlohmann::json live_frame_json (std::string_view frame) {
    constexpr std::string_view data_field = "data: ";
    const auto data_at                    = frame.find (data_field);
    if (data_at == std::string_view::npos) {
        ADD_FAILURE () << "not an SSE data frame: " << frame;
        return nlohmann::json::object ();
    }
    const auto json_at = data_at + data_field.size ();
    return nlohmann::json::parse (
    frame.substr (json_at, frame.find ('\n', json_at) - json_at));
}

/// A load run row for @p config, dated now: an epoch-dated run is pruned, row
/// and all, the moment it finishes.
void create_load_run (vayu::db::Database& db,
const std::string& run_id,
const nlohmann::json& config) {
    vayu::db::Run run;
    run.id              = run_id;
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Pending;
    run.config_snapshot = config.dump ();
    run.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                     .count ();
    db.create_run (run);
}

/// @p run_id's row once it reaches a terminal status, or its last read after
/// 20 s.
std::optional<vayu::db::Run>
wait_for_terminal_run (vayu::db::Database& db, const std::string& run_id) {
    const auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (20);
    std::optional<vayu::db::Run> stored;
    while (std::chrono::steady_clock::now () < deadline) {
        stored = db.get_run (run_id);
        if (stored && stored->status != vayu::RunStatus::Pending &&
        stored->status != vayu::RunStatus::Running) {
            break;
        }
        std::this_thread::sleep_for (std::chrono::milliseconds (20));
    }
    return stored;
}

} // namespace

// #2395: the live clock starts where the report's does, after `script.setup`.
// It used to start when the run was registered, so a 1.5 s setup put every
// live frame 1.5 s ahead of `testDuration` and divided its rates by time no
// request could have been sent in. Mutation check: read the registration
// instant in `emit_live_tick` again and the first-request and last-frame
// assertions fail by about the setup's length.
TEST (LoadClock, LiveElapsedStartsWithLoadNotWithSetup) {
    const std::string db_path = "test_load_clock_setup.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        constexpr int SETUP_MS         = 1500;
        const std::string setup_script = "const until = Date.now () + " +
        std::to_string (SETUP_MS) + "; while (Date.now () < until) {}";
        const nlohmann::json config{ { "method", "GET" }, { "url", server.fast_url () },
            { "mode", "constant_rps" }, { "duration", "1s" },
            { "targetRps", 20.0 }, { "timeout", 5000 }, { "workers", 1 },
            { "lifecycleElements",
            nlohmann::json::array ({ { { "id", "el_setup" }, { "kind", "script.setup" },
            { "enabled", true }, { "config", { { "script", setup_script } } } } }) } };

        const std::string run_id = "run_load_clock";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;
        const auto summary = nlohmann::json::parse (stored->summary);
        const double test_duration = summary.at ("test_duration").get<double> ();

        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        const auto batch = context->ticks_since (0);
        std::vector<nlohmann::json> frames;
        frames.reserve (batch.payloads.size ());
        for (const auto& payload : batch.payloads) {
            frames.push_back (live_frame_json (payload));
        }
        ASSERT_FALSE (frames.empty ());

        // While setup runs, nothing has elapsed and nothing has a rate.
        size_t setup_frames = 0;
        while (setup_frames < frames.size () &&
        frames[setup_frames]["elapsedSeconds"].get<double> () == 0.0 &&
        frames[setup_frames]["requestsSent"].get<size_t> () == 0) {
            const auto& frame = frames[setup_frames];
            EXPECT_EQ (frame["requestsSent"].get<size_t> (), 0u) << frame.dump ();
            EXPECT_DOUBLE_EQ (frame["sendRate"].get<double> (), 0.0) << frame.dump ();
            EXPECT_DOUBLE_EQ (frame["throughput"].get<double> (), 0.0) << frame.dump ();
            ++setup_frames;
        }
        // At the default 100 ms cadence a 1.5 s setup spans about 15 ticks.
        EXPECT_GE (setup_frames, 5u) << "the live clock ran during setup";

        const auto first_sent =
        std::ranges::find_if (frames, [] (const nlohmann::json& f) {
            return f["requestsSent"].get<size_t> () > 0;
        });
        ASSERT_NE (first_sent, frames.end ()) << "no frame saw a request sent";
        EXPECT_LT ((*first_sent)["elapsedSeconds"].get<double> (), 0.8)
        << first_sent->dump ();

        EXPECT_NEAR (frames.back ()["elapsedSeconds"].get<double> (), test_duration, 0.5)
        << "the last live frame and the report disagree about how long load "
           "ran";

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2392: the report's send rate and rate fidelity divide by the sending
// window, not by a duration that includes the end-of-run drain. Every /slow
// request answers 500 ms after it is sent, so the drain after a 2 s run is
// about that long. Mutation checks: divide `send_rate` by `total_duration_s`
// again in `collect_summary_inputs` and the send-rate assertion fails; drop
// the `apply_sending_window_rates` call in `reconcile_report_rates` and the
// achievement reads about 80.
TEST (LoadClock, SendRateAndRateFidelityLeaveOutTheDrain) {
    const std::string db_path = "test_load_clock_drain.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        constexpr double DURATION_S = 2.0;
        const nlohmann::json config{ { "method", "GET" }, { "url", server.slow_url () },
            { "mode", "constant_rps" }, { "duration", "2s" },
            { "targetRps", 50.0 }, { "timeout", 5000 }, { "workers", 1 } };
        const std::string run_id = "run_load_drain";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto summary   = nlohmann::json::parse (stored->summary);
        const double sending = summary.at ("sending_duration").get<double> ();
        const double test_duration = summary.at ("test_duration").get<double> ();
        const auto sent     = summary.at ("requests_sent").get<size_t> ();
        const auto expected = summary.at ("requests_expected").get<size_t> ();
        EXPECT_EQ (expected, 100u);
        ASSERT_GT (sent, 0u);
        EXPECT_GE (sending, DURATION_S);
        // A window that swallowed the drain reads DURATION_S + 0.5 or more;
        // a healthy one overruns the deadline by scheduling alone, which has
        // measured 0.16s on a loaded macOS runner. Both bounds sit between the
        // healthy reading and the broken one, and an overrun shortens the
        // drain by as much as it lengthens the window.
        EXPECT_LT (sending, DURATION_S + 0.35)
        << "the window ran past the deadline";
        EXPECT_GT (test_duration - sending, 0.2) << "no drain was measured";
        EXPECT_DOUBLE_EQ (summary.at ("send_rate").get<double> (),
        static_cast<double> (sent) / sending);

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const double achievement =
        report.at ("rateControl").at ("achievement").get<double> ();
        EXPECT_NEAR (achievement,
        static_cast<double> (sent) * 100.0 / static_cast<double> (expected), 0.1);
        EXPECT_GT (achievement, 95.0) << "the drain is back in the denominator";

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2385: a stored row is its whole second, not the last 100 ms window of it,
// and the gate frame of the same tick carries the same figures as `second*`.
// At 20 rps a second holds about 20 completions, so its p99 is its slowest and
// the one stalled request shows up in exactly the row of its second.
// Mutation checks: persist the last window again in `persist_metric_tick` and
// the row/frame equality fails (and, nine times in ten, the stall row); drop
// the `add_window` into the second's histogram and the sample sum fails.
TEST (LoadClock, StoredRowsCarryTheWholeSecondsPercentiles) {
    const std::string db_path = "test_load_clock_seconds.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.stall_once_url () }, { "mode", "constant_rps" },
            { "duration", "3s" }, { "targetRps", 20.0 }, { "timeout", 5000 },
            { "workers", 1 } };
        const std::string run_id = "run_load_seconds";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto run = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (run);
        ASSERT_EQ (run->status, vayu::RunStatus::Completed) << run->summary;

        std::map<int64_t, nlohmann::json> rows;
        double slowest_row_p99 = 0.0;
        for (const auto& tick : db.get_metric_ticks_paginated (run_id, 1000, 0)) {
            auto payload = nlohmann::json::parse (tick.payload);
            slowest_row_p99 =
            std::max (slowest_row_p99, payload.at ("latency_p99_ms").get<double> ());
            rows.emplace (tick.timestamp, std::move (payload));
        }
        ASSERT_GE (rows.size (), 2u);
        EXPECT_GE (slowest_row_p99, static_cast<double> (vayu::tests::SlowMockServer::STALL_MS))
        << "no stored second holds the stall";

        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        std::vector<nlohmann::json> frames;
        for (const auto& payload : context->ticks_since (0).payloads) {
            frames.push_back (live_frame_json (payload));
        }
        ASSERT_FALSE (frames.empty ());

        size_t gate_frames    = 0;
        size_t second_samples = 0;
        for (size_t i = 0; i < frames.size (); ++i) {
            const auto& frame = frames[i];
            for (const auto* key :
            { "cumulativeP50Ms", "cumulativeP95Ms", "cumulativeP99Ms" }) {
                ASSERT_TRUE (frame.contains (key))
                << key << " missing: " << frame.dump ();
                EXPECT_TRUE (frame.at (key).is_null () || frame.at (key).is_number ())
                << frame.dump ();
            }
            if (!frame.contains ("secondSamples")) {
                EXPECT_FALSE (frame.contains ("secondP99Ms")) << frame.dump ();
                continue;
            }
            second_samples += frame.at ("secondSamples").get<size_t> ();
            // The final frame closes the partial second and stores no row.
            if (i + 1 == frames.size ()) {
                continue;
            }
            ++gate_frames;
            const auto row = rows.find (frame.at ("timestamp").get<int64_t> ());
            ASSERT_NE (row, rows.end ())
            << "a gate frame with no stored row: " << frame.dump ();
            for (const auto& [live, stored] : { std::pair{ "secondP50Ms", "latency_p50_ms" },
                 std::pair{ "secondP95Ms", "latency_p95_ms" },
                 std::pair{ "secondP99Ms", "latency_p99_ms" } }) {
                const double expected =
                frame.at (live).is_null () ? 0.0 : frame.at (live).get<double> ();
                EXPECT_DOUBLE_EQ (row->second.at (stored).get<double> (), expected)
                << stored << " at " << row->first;
            }
        }
        EXPECT_EQ (gate_frames, rows.size ());
        EXPECT_TRUE (frames.back ().contains ("secondSamples"))
        << "the final frame did not close the partial second";
        const auto completed = frames.back ().at ("totalRequests").get<size_t> ();
        EXPECT_GT (completed, static_cast<size_t> (vayu::tests::SlowMockServer::STALL_AT));
        EXPECT_EQ (second_samples, completed)
        << "a completion landed in no second, or in two";

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

TEST (RunManagerRetention, BackgroundSweeperEvictsWithoutExternalTriggers) {
    RunManager mgr;
    nlohmann::json cfg;
    auto a = std::make_shared<RunContext> ("a", cfg);
    mgr.register_run ("a", a);
    mgr.retain_run ("a");
    a->completed_at_ms.store (1); // backdate "a" so it's immediately expired

    EXPECT_EQ (mgr.retained_count (), 1u);

    // Sweep cadence is ttl/2, floored at 500ms. Nothing but the sweeper
    // evicts here, so waiting for the count to fall proves it ticked.
    mgr.start_sweeper (1000);
    EXPECT_TRUE (
    vayu::tests::wait_until ([&mgr] () { return mgr.retained_count () == 0u; }))
    << "the sweeper never evicted the expired run";

    mgr.stop_sweeper (); // also exercised by destructor
}

// The TTL provider must be invoked every tick (not captured once at start), so
// a runtime change to liveRetentionMs is honored without a daemon restart.
TEST (RunManagerRetention, BackgroundSweeperRereadsTtlProviderEachTick) {
    RunManager mgr;
    std::atomic<int> calls{ 0 };
    // ttl=1000 → 500ms cadence; a provider read once at start stops at one.
    mgr.start_sweeper ([&calls] () -> int64_t {
        calls.fetch_add (1);
        return 1000;
    });
    EXPECT_TRUE (
    vayu::tests::wait_until ([&calls] () { return calls.load () >= 2; }))
    << "the TTL provider was read " << calls.load () << " time(s)";
    mgr.stop_sweeper ();
}

TEST (RunManagerRetention, SweepEvictsExpiredOnly) {
    RunManager mgr;
    nlohmann::json cfg;
    auto a = std::make_shared<RunContext> ("a", cfg);
    auto b = std::make_shared<RunContext> ("b", cfg);
    mgr.register_run ("a", a);
    mgr.register_run ("b", b);
    mgr.retain_run ("a");
    mgr.retain_run ("b");

    a->completed_at_ms.store (1); // backdate "a" far into the past
    mgr.sweep_retained (60000);   // ttl 60s; "b" was stamped ~now

    EXPECT_EQ (mgr.get_run_or_retained ("a"), nullptr);
    EXPECT_NE (mgr.get_run_or_retained ("b"), nullptr);
}

// A single-request run's own `requestElements` may declare a `script.post`
// element (issue #1594); when it is not marked to run inline, its script text
// is what the deferred replay (`validate_scripts`) reads back through
// `test_script` - the same field the retired `tests` payload field used to
// populate directly.
//
// This exercises the wiring through RunContext's constructor, not
// `compile_elements` in isolation.
TEST (RunManager, ConstructorReadsDeferredPostScriptFromRequestElements) {
    auto config = nlohmann::json::parse (R"({
      "requestElements": [
        { "kind": "script.post", "config": { "script": "pm.test(\"a\",()=>{});" } }
      ]
    })");

    RunContext ctx ("r", config);
    EXPECT_EQ (ctx.test_script, "pm.test(\"a\",()=>{});");
}

// A saved request composes the collection chain's `script.post` elements
// before its own (issue #1514's `compose_elements` order), and both are
// deferred by default - so a request whose collection also asserts
// something must run both under load, not only the first, the way
// `read_script` always joined every enabled part before this run shape had
// elements at all.
TEST (RunManager, ConstructorJoinsEveryDeferredPostScriptWithABlankLine) {
    auto config = nlohmann::json::parse (R"({
      "requestElements": [
        { "kind": "script.post", "config": { "script": "pm.test(\"chain\",()=>{});" } },
        { "kind": "script.post", "config": { "script": "pm.test(\"own\",()=>{});" } }
      ]
    })");

    RunContext ctx ("r", config);
    EXPECT_EQ (ctx.test_script, "pm.test(\"chain\",()=>{});\n\npm.test(\"own\",()=>{});");
}

// The inline one is left out of the join entirely - both because it must not
// run twice and because it may sit between two deferred ones in compile
// order, which must not leave a stray blank line where it was skipped.
TEST (RunManager, ConstructorSkipsAnInlineScriptPostWhenJoiningTheRest) {
    auto config = nlohmann::json::parse (R"({
      "requestElements": [
        { "kind": "script.post", "config": { "script": "pm.test(\"chain\",()=>{});" } },
        { "kind": "script.post",
          "config": { "script": "pm.test(\"inline\",()=>{});", "inline": true } },
        { "kind": "script.post", "config": { "script": "pm.test(\"own\",()=>{});" } }
      ]
    })");

    RunContext ctx ("r", config);
    EXPECT_EQ (ctx.test_script, "pm.test(\"chain\",()=>{});\n\npm.test(\"own\",()=>{});");
}

// A `script.post` marked `inline` runs on the pipeline hooks instead
// (`submit_one_request` / `run_request_elements_after_submission`), so the
// deferred replay must not run it a second time - `test_script` stays empty.
TEST (RunManager, ConstructorLeavesTestScriptEmptyForAnInlineScriptPost) {
    auto config = nlohmann::json::parse (R"({
      "requestElements": [
        { "kind": "script.post",
          "config": { "script": "pm.test(\"a\",()=>{});", "inline": true } }
      ]
    })");

    RunContext ctx ("r", config);
    EXPECT_TRUE (ctx.test_script.empty ());
}

// The route refuses `tests`/`postRequestScript(s)` outright now (issue
// #1594's cut-over) - the constructor itself no longer reads any of them, so
// a payload that still carries one (a stale caller the route did not run in
// front of, as this unit test bypasses it) is simply ignored rather than
// populating `test_script`.
TEST (RunManager, ConstructorIgnoresTheRetiredTestsField) {
    auto config = nlohmann::json::parse (R"({"tests":"pm.test(\"a\",()=>{});"})");

    RunContext ctx ("r", config);
    EXPECT_TRUE (ctx.test_script.empty ());
}

// The wiring nobody else covers: what a collector counted has to reach the
// stored summary. A field the collector grows and `read_retention` forgets
// reports as zero-or-false forever, which is this repo's most repeated defect -
// so the two cases the byte-budget marker (issue #1192) exists to separate are
// checked through the function that carries it, not off the collector alone.
// Drop the assignment in read_retention and the first half reddens.
TEST (ReadRetention, CarriesTheResponseSampleBudgetMarkerWhetherOrNotItWasSpent) {
    MetricsCollectorConfig tight;
    tight.expected_requests         = 100;
    tight.response_sample_rate      = 1;
    tight.max_response_samples      = 1000;
    tight.max_response_sample_bytes = 250;
    MetricsCollector spent ("run_read_retention_spent", tight);

    vayu::Response response;
    response.status_code     = 200;
    response.body            = std::string (100, 'x');
    response.timing.total_ms = 1.0;
    for (int i = 0; i < 10; ++i) {
        spent.record_response_sample (response);
    }

    RunSummaryInputs inputs;
    inputs.retention = read_retention (spent);
    EXPECT_TRUE (inputs.retention.response_sample_budget_spent);
    EXPECT_GT (inputs.retention.response_samples_dropped, 0u);
    EXPECT_TRUE (build_run_summary_payload (
    inputs)["sampling"]["response_sample_budget_spent"]
    .get<bool> ());

    MetricsCollectorConfig roomy;
    roomy.expected_requests         = 100;
    roomy.response_sample_rate      = 1;
    roomy.max_response_samples      = 2;
    roomy.max_response_sample_bytes = 1'000'000;
    MetricsCollector displaced ("run_read_retention_uniform", roomy);
    for (int i = 0; i < 10; ++i) {
        displaced.record_response_sample (response);
    }

    RunSummaryInputs uniform;
    uniform.retention = read_retention (displaced);
    EXPECT_GT (uniform.retention.response_samples_dropped, 0u)
    << "the count cap has to have displaced something for the two to differ";
    EXPECT_FALSE (uniform.retention.response_sample_budget_spent);
    EXPECT_FALSE (build_run_summary_payload (
    uniform)["sampling"]["response_sample_budget_spent"]
    .get<bool> ());
}

// ============================================================================
// finish_load_test's terminal-status decision (issue #1497). `finish_load_test`
// itself is not declared in run_manager.hpp, so this drives it the only way a
// test can: a real run, end to end through RunManager::start_run exactly as
// the route does, the way run_stop_test.cpp's StoppedRunReachesTerminalStatus-
// Promptly drives the stop path. The issue's own Tests section asked for this
// case by name: "run_manager test: failRun: true with a failed budget stores
// Failed."
// ============================================================================

struct FailRunCase {
    const char* name;
    const char* run_id;
    /// `true` sets `thresholds.failRun`; `false` leaves the key absent, the
    /// shape a run that never opted in sends.
    bool fail_run;
    vayu::RunStatus expected_status;
};

// Mutation check: comment out the `final_status = vayu::RunStatus::Failed`
// assignment in `finish_load_test` and the first case reddens to Completed.
// The second is its companion: without `failRun`, the same missed budget is
// still reported (this run's `thresholdValidation.verdict` is "failed",
// asserted at the unit level in threshold_eval_test.cpp) but the terminal
// status is untouched - the pre-existing history semantics nobody who did not
// opt in should see change.
constexpr auto FAIL_RUN_CASES = std::to_array<FailRunCase> ({
{ "AFailedAssertionBudgetWithFailRunEndsTheRunFailed", "run-fail-run-e2e", true,
vayu::RunStatus::Failed },
{ "TheSameMissedBudgetWithoutFailRunStaysCompleted", "run-fail-run-optout-e2e",
false, vayu::RunStatus::Completed },
});

class FailRunTest : public ::testing::TestWithParam<FailRunCase> {
    protected:
    static constexpr const char* DB_PATH = "test_run_manager_fail_run.db";

    void SetUp () override {
        vayu::http::global_init ();
        server = std::make_unique<vayu::tests::SlowMockServer> ();
        vayu::tests::remove_database_files (DB_PATH);
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }
    void TearDown () override {
        db.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        server.reset ();
        vayu::http::global_cleanup ();
    }

    /// Create the row `start_run` expects to already exist (the route's own
    /// job), then drive the run to completion and hand back its stored status.
    /// Waits well past a healthy run's own duration on purpose: a slow-but-
    /// finishing run fails the caller's status assertion, not this wait.
    std::optional<vayu::RunStatus> run_to_terminal_status (const std::string& run_id,
    const nlohmann::json& config) {
        vayu::db::Run row;
        row.id              = run_id;
        row.type            = vayu::RunType::Load;
        row.status          = vayu::RunStatus::Pending;
        row.config_snapshot = "{}";
        row.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        row.end_time = 0;
        db->create_run (row);

        vayu::core::RunManager manager;
        manager.start_run (run_id, config, *db);

        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (20);
        while (manager.get_run (run_id) != nullptr &&
        std::chrono::steady_clock::now () < deadline) {
            std::this_thread::sleep_for (std::chrono::milliseconds (20));
        }
        if (manager.get_run (run_id) != nullptr) {
            ADD_FAILURE () << "the run never reached a terminal status";
            return std::nullopt;
        }

        auto stored = db->get_run (run_id);
        if (!stored.has_value ()) {
            ADD_FAILURE () << "the finished run left no row behind";
            return std::nullopt;
        }
        return stored->status;
    }

    nlohmann::json base_config () const {
        return { { "mode", "iterations" }, { "iterations", 3 }, { "concurrency", 1 },
            { "url", server->fast_url () }, { "method", "GET" }, { "workers", 1 },
            { "tests", "pm.test('always fails', function () { pm.expect(1).to.equal(2); });" } };
    }

    std::unique_ptr<vayu::tests::SlowMockServer> server;
    std::unique_ptr<vayu::db::Database> db;
};

TEST_P (FailRunTest, EndsWithTheExpectedTerminalStatus) {
    const auto& c        = GetParam ();
    auto config          = base_config ();
    config["thresholds"] = { { "maxAssertionFailureRatePct", 0 } };
    if (c.fail_run) {
        config["thresholds"]["failRun"] = true;
    }

    auto status = run_to_terminal_status (c.run_id, config);
    ASSERT_HAS_VALUE (status);
    EXPECT_EQ (*status, c.expected_status);
}

INSTANTIATE_TEST_SUITE_P (FailRun,
FailRunTest,
::testing::ValuesIn (FAIL_RUN_CASES),
[] (const ::testing::TestParamInfo<FailRunCase>& info) {
    return std::string (info.param.name);
});
