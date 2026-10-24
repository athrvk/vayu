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

#include "load_start_stamp.hpp"
#include "mock_server.hpp"
#include "temp_database.hpp"
#include "vayu/core/status_seconds.hpp"
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

// #2834: a stream's drain is sized by its duration cap and backstop, never by
// the request timeout. Mutation check: return timeout + grace for a stream and
// the stream case fails here, and `LoadDrain` below sees the stream cancelled.
TEST (NaturalEndDrainMs, AnOrdinaryRequestWaitsItsTimeoutPlusTheGrace) {
    EXPECT_EQ (natural_end_drain_ms (std::nullopt, 200), 200 + 2000);
    EXPECT_EQ (natural_end_drain_ms (std::nullopt, 45000), 45000 + 2000);
}

TEST (NaturalEndDrainMs, AStreamWaitsItsCapPlusTheBackstopAndTheGrace) {
    vayu::StreamBounds bounds;
    bounds.max_duration_ms = 4000;
    bounds.max_events      = 10;
    EXPECT_EQ (natural_end_drain_ms (bounds, 200), 4000 + 5000 + 2000);
    // The request timeout plays no part, whichever side of the cap it is on.
    EXPECT_EQ (natural_end_drain_ms (bounds, 600000), 4000 + 5000 + 2000);
    EXPECT_EQ (natural_end_drain_ms (bounds, 0), 4000 + 5000 + 2000);
}

TEST (NaturalEndDrainMs, ATimeoutThatIsNotPositiveFallsBackToTheDefault) {
    const int64_t expected =
    vayu::core::constants::server::DEFAULT_TIMEOUT_MS + int64_t{ 2000 };
    EXPECT_EQ (natural_end_drain_ms (std::nullopt, 0), expected);
    EXPECT_EQ (natural_end_drain_ms (std::nullopt, -1), expected);
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
    // Stamping load start publishes no loop; it only lets the 1 Hz row land.
    ctx->is_running = true;
    vayu::tests::stamp_load_start (*ctx);

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
    vayu::tests::stamp_load_start (*ctx);

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

/// @p run_id's stored 1 Hz rows, by timestamp.
std::map<int64_t, nlohmann::json>
stored_rows (vayu::db::Database& db, const std::string& run_id) {
    std::map<int64_t, nlohmann::json> rows;
    for (const auto& tick : db.get_metric_ticks_paginated (run_id, 1000, 0)) {
        rows.emplace (tick.timestamp, nlohmann::json::parse (tick.payload));
    }
    return rows;
}

/// Every live frame @p context still holds, parsed.
std::vector<nlohmann::json> live_frames (const RunContext& context) {
    std::vector<nlohmann::json> frames;
    for (const auto& payload : context.ticks_since (0).payloads) {
        frames.push_back (live_frame_json (payload));
    }
    return frames;
}

/// The frame stamped @p timestamp, which for a stored row is the gate frame of
/// its tick; null when no frame carries it.
const nlohmann::json* frame_at (const std::vector<nlohmann::json>& frames, int64_t timestamp) {
    const auto found = std::ranges::find_if (frames, [&] (const nlohmann::json& f) {
        return f.at ("timestamp").get<int64_t> () == timestamp;
    });
    return found == frames.end () ? nullptr : &*found;
}

/// Each stored row against the gate frame of its tick: the frame exists and
/// carries the row's `elapsed_seconds`, one reading of the load clock.
void expect_rows_on_the_live_clock (const std::map<int64_t, nlohmann::json>& rows,
const std::vector<nlohmann::json>& frames) {
    for (const auto& [timestamp, row] : rows) {
        const auto* frame = frame_at (frames, timestamp);
        if (frame == nullptr) {
            ADD_FAILURE () << "a stored row with no live frame: " << row.dump ();
            continue;
        }
        EXPECT_DOUBLE_EQ (row.at ("elapsed_seconds").get<double> (),
        frame->at ("elapsedSeconds").get<double> ())
        << "row " << row.dump () << " against frame " << frame->dump ();
    }
}

struct SecondPercentileKey {
    const char* live;
    const char* stored;
};

constexpr auto SECOND_PERCENTILE_KEYS =
std::to_array<SecondPercentileKey> ({ { "secondP50Ms", "latency_p50_ms" },
{ "secondP95Ms", "latency_p95_ms" }, { "secondP99Ms", "latency_p99_ms" } });

/// What a run's gate frames said about the seconds they stored.
struct GateSeconds {
    size_t gate_frames = 0;
    /// `secondSamples` over every frame, the final partial second included.
    size_t samples = 0;
    /// Row timestamps of the stored seconds with no completion, and with one.
    std::vector<int64_t> empty;
    std::vector<int64_t> settled;
};

/// Hold each gate frame against the row it stored: the same three percentiles
/// when its second had a completion, and none of the three keys (and null on
/// the frame) when it had none (#2386).
GateSeconds match_gate_frames_to_rows (const std::vector<nlohmann::json>& frames,
const std::map<int64_t, nlohmann::json>& rows) {
    GateSeconds seen;
    for (size_t i = 0; i < frames.size (); ++i) {
        const auto& frame = frames[i];
        if (!frame.contains ("secondSamples")) {
            EXPECT_FALSE (frame.contains ("secondP99Ms")) << frame.dump ();
            continue;
        }
        const auto samples = frame.at ("secondSamples").get<size_t> ();
        seen.samples += samples;
        // The final frame closes the partial second and stores no row.
        if (i + 1 == frames.size ()) {
            continue;
        }
        ++seen.gate_frames;
        const auto row = rows.find (frame.at ("timestamp").get<int64_t> ());
        if (row == rows.end ()) {
            ADD_FAILURE () << "a gate frame with no stored row: " << frame.dump ();
            continue;
        }
        (samples == 0 ? seen.empty : seen.settled).push_back (row->first);
        for (const auto& key : SECOND_PERCENTILE_KEYS) {
            if (samples == 0) {
                EXPECT_TRUE (frame.at (key.live).is_null ()) << frame.dump ();
                EXPECT_FALSE (row->second.contains (key.stored))
                << "an empty second stored a latency: " << row->second.dump ();
                continue;
            }
            if (!row->second.contains (key.stored)) {
                ADD_FAILURE () << key.stored << " missing at " << row->first
                               << " for " << samples << " samples";
                continue;
            }
            EXPECT_DOUBLE_EQ (row->second.at (key.stored).get<double> (),
            frame.at (key.live).get<double> ())
            << key.stored << " at " << row->first;
        }
    }
    return seen;
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

// #2881: a stored row's `elapsed_seconds` is the load clock its gate frame
// reads, so History draws a second where the live view drew it. Mutation
// check: measure from the first persisted tick again in `persist_metric_tick`
// and the first row reads 0 and no row equals its frame.
TEST (LoadClock, StoredElapsedIsTheLiveClock) {
    const std::string db_path = "test_load_clock_stored_elapsed.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" }, { "url", server.fast_url () },
            { "mode", "constant_rps" }, { "duration", "3s" },
            { "targetRps", 20.0 }, { "timeout", 5000 }, { "workers", 1 } };
        const std::string run_id = "run_load_clock_stored_elapsed";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto run = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (run);
        ASSERT_EQ (run->status, vayu::RunStatus::Completed) << run->summary;

        const auto rows    = stored_rows (db, run_id);
        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        const auto frames = live_frames (*context);
        ASSERT_GE (rows.size (), 2u)
        << "too few rows to see the series advance";

        expect_rows_on_the_live_clock (rows, frames);
        EXPECT_GT (rows.begin ()->second.at ("elapsed_seconds").get<double> (), 0.0)
        << "the first row restarted the clock at 0";
        double previous = 0.0;
        for (const auto& [timestamp, row] : rows) {
            const double elapsed = row.at ("elapsed_seconds").get<double> ();
            EXPECT_GT (elapsed, previous) << "at " << timestamp;
            previous = elapsed;
        }

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2881: a gate that closes while `script.setup` runs stores no row. Load has
// not started, so its elapsed is 0, and a row there would draw a second of
// setup as a second of load. The setup outlasts the first gate, which the test
// asserts before trusting the rows. Mutation check: drop the load-start guard
// in `persist_metric_tick` and the setup gate stores a row at elapsed 0.
TEST (LoadClock, NoRowIsStoredBeforeLoadStarts) {
    const std::string db_path = "test_load_clock_no_setup_row.db";
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
            { "mode", "constant_rps" }, { "duration", "2s" },
            { "targetRps", 20.0 }, { "timeout", 5000 }, { "workers", 1 },
            { "lifecycleElements",
            nlohmann::json::array ({ { { "id", "el_setup" }, { "kind", "script.setup" },
            { "enabled", true }, { "config", { { "script", setup_script } } } } }) } };
        const std::string run_id = "run_load_clock_no_setup_row";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto run = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (run);
        ASSERT_EQ (run->status, vayu::RunStatus::Completed) << run->summary;

        const auto rows    = stored_rows (db, run_id);
        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        const auto frames = live_frames (*context);

        const auto setup_gate =
        std::ranges::find_if (frames, [] (const nlohmann::json& f) {
            return f.contains ("secondSamples") &&
            f.at ("elapsedSeconds").get<double> () == 0.0;
        });
        ASSERT_NE (setup_gate, frames.end ())
        << "no gate closed during setup; nothing is proven";
        EXPECT_FALSE (rows.contains (setup_gate->at ("timestamp").get<int64_t> ()))
        << "the gate that closed during setup stored a row";

        ASSERT_FALSE (rows.empty ()) << "no row was stored once load started";
        for (const auto& [timestamp, row] : rows) {
            EXPECT_GT (row.at ("elapsed_seconds").get<double> (), 0.0)
            << "a row stored before load start: " << row.dump ();
        }
        expect_rows_on_the_live_clock (rows, frames);

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

// #2882: `completed_while_sending` is counted when sending ends, so the drain's
// completions are not in it. One `/hang-every` request in ten never answers
// and times out 1.5 s after it was sent, so about five are still in flight
// when a 2 s run stops sending. Healthy: about 92 of 100 completed while
// sending, 46 a second over the window against a whole-run `throughput` of
// about 28 (100 over 3.5 s). Broken (the count read after the drain): all 100,
// equal to `total_requests`. Mutation check: read `context->total_requests ()`
// after `event_loop->stop` in `execute_load_test` and the first assertion
// fails.
TEST (LoadClock, CompletedWhileSendingLeavesOutTheDrain) {
    const std::string db_path = "test_load_clock_completed_while_sending.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.hang_every_url () }, { "mode", "constant_rps" },
            { "duration", "2s" }, { "targetRps", 50.0 }, { "timeout", 1500 },
            { "workers", 1 } };
        const std::string run_id = "run_load_completed_while_sending";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto summary = nlohmann::json::parse (stored->summary);
        const auto total   = summary.at ("total_requests").get<size_t> ();
        const auto completed_while_sending =
        summary.at ("completed_while_sending").get<size_t> ();
        EXPECT_LT (completed_while_sending, total)
        << "the drain's completions were counted as completed while sending";
        EXPECT_LE (completed_while_sending, summary.at ("requests_sent").get<size_t> ());

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const auto& reported = report.at ("summary");
        ASSERT_TRUE (reported.contains ("completedWhileSending")) << reported.dump ();
        EXPECT_EQ (reported.at ("completedWhileSending").get<size_t> (), completed_while_sending);
        const double while_sending_rate = static_cast<double> (completed_while_sending) /
        reported.at ("sendingDurationSeconds").get<double> ();
        EXPECT_LT (reported.at ("throughput").get<double> (), while_sending_rate)
        << reported.dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2882: an `iterations` run's sending window is its whole duration, so every
// completion is inside it. Four `/slow` requests at concurrency 4 are all in
// flight when the loop returns on its last submission: a count read there
// would be 0 against a total of 4. Mutation check: keep the count read at the
// executor's return for every mode in `sending_window` and this fails.
TEST (LoadClock, AnIterationsRunCompletesEverythingWhileSending) {
    const std::string db_path = "test_load_clock_iterations_completed.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" }, { "url", server.slow_url () },
            { "mode", "iterations" }, { "iterations", 4 }, { "concurrency", 4 },
            { "timeout", 5000 }, { "workers", 1 } };
        const std::string run_id = "run_load_iterations_completed";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto summary = nlohmann::json::parse (stored->summary);
        EXPECT_EQ (summary.at ("total_requests").get<size_t> (), 4u) << summary.dump ();
        EXPECT_EQ (summary.at ("completed_while_sending").get<size_t> (),
        summary.at ("total_requests").get<size_t> ())
        << summary.dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2834: a streaming run's natural end waits for its streams to reach their
// cap. `/sse-ticks` streams for 6 s and the cap ends it as a success at 4 s;
// a drain sized by the 200 ms request timeout gives up at 2.2 s and records
// the stream as a cancelled error. Asserted on the recorded outcome, never
// the clock. Mutation check: size a stream's drain by its timeout again in
// `natural_end_drain_ms` and every assertion below fails.
TEST (LoadDrain, AStreamingRunsNaturalEndWaitsForTheStreamsCap) {
    const std::string db_path = "test_load_drain_stream.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.sse_ticks_url () }, { "mode", "iterations" },
            { "iterations", 1 }, { "concurrency", 1 }, { "timeout", 200 },
            { "workers", 1 }, { "stream", true }, { "maxStreamDurationMs", 4000 } };
        const std::string run_id = "run_load_drain_stream";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const auto& summary = report.at ("summary");
        EXPECT_EQ (summary.at ("successfulRequests").get<size_t> (), 1u)
        << report.dump ();
        EXPECT_EQ (summary.at ("failedRequests").get<size_t> (), 0u) << report.dump ();
        EXPECT_FALSE (report.at ("errors").at ("types").contains ("cancelled"))
        << report.dump ();

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

        const auto rows        = stored_rows (db, run_id);
        double slowest_row_p99 = 0.0;
        for (const auto& [timestamp, payload] : rows) {
            if (payload.contains ("latency_p99_ms")) {
                slowest_row_p99 = std::max (
                slowest_row_p99, payload.at ("latency_p99_ms").get<double> ());
            }
        }
        ASSERT_GE (rows.size (), 2u);
        EXPECT_GE (slowest_row_p99, static_cast<double> (vayu::tests::SlowMockServer::STALL_MS))
        << "no stored second holds the stall";

        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        const auto frames = live_frames (*context);
        ASSERT_FALSE (frames.empty ());
        for (const auto& frame : frames) {
            for (const auto* key :
            { "cumulativeP50Ms", "cumulativeP95Ms", "cumulativeP99Ms" }) {
                ASSERT_TRUE (frame.contains (key))
                << key << " missing: " << frame.dump ();
                EXPECT_TRUE (frame.at (key).is_null () || frame.at (key).is_number ())
                << frame.dump ();
            }
        }

        const auto seen = match_gate_frames_to_rows (frames, rows);
        EXPECT_EQ (seen.gate_frames, rows.size ());
        EXPECT_FALSE (seen.settled.empty ());
        EXPECT_TRUE (frames.back ().contains ("secondSamples"))
        << "the final frame did not close the partial second";
        const auto completed = frames.back ().at ("totalRequests").get<size_t> ();
        EXPECT_GT (completed, static_cast<size_t> (vayu::tests::SlowMockServer::STALL_AT));
        EXPECT_EQ (seen.samples, completed)
        << "a completion landed in no second, or in two";

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2386: a second in which nothing completed has no latency. While the target
// answers nothing, the gate frames say null and the stored rows carry no
// percentile key; the seconds around the stall store real figures. The stall
// opens about 0.5 s in and lasts STALL_WINDOW_MS (3 s); a gate closes a second
// every 1.0-1.1 s, so at least one whole stored second lies inside it even at
// 1.5 s a gate. The run is 9 s so a stored row still follows the stall when
// the first request is up to 4 s late: the stall closes at (10th request) +
// 3 s, and the last stored row sits near 8 s. Mutation checks: write the percentile keys unconditionally in
// `build_metric_tick_payload` and the empty-second assertions fail; restore
// the zeros in `put_interval_percentiles` and the frames' nulls fail.
TEST (LoadClock, AStalledSecondStoresNoPercentiles) {
    const std::string db_path = "test_load_clock_stall.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.stall_window_url () }, { "mode", "constant_rps" },
            { "duration", "9s" }, { "targetRps", 20.0 }, { "timeout", 10000 },
            { "workers", 1 } };
        const std::string run_id = "run_load_stall";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto run = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (run);
        ASSERT_EQ (run->status, vayu::RunStatus::Completed) << run->summary;

        const auto rows    = stored_rows (db, run_id);
        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        const auto frames = live_frames (*context);
        ASSERT_FALSE (frames.empty ());

        // Every frame's window follows the same rule as its second.
        size_t idle_windows = 0;
        for (const auto& frame : frames) {
            const auto samples = frame.at ("latencySamples").get<size_t> ();
            EXPECT_EQ (frame.at ("latencyP99Ms").is_null (), samples == 0)
            << frame.dump ();
            idle_windows += samples == 0 ? 1 : 0;
        }
        EXPECT_GT (idle_windows, 0u);

        const auto seen = match_gate_frames_to_rows (frames, rows);
        EXPECT_EQ (seen.gate_frames, rows.size ());
        ASSERT_FALSE (seen.empty.empty ())
        << "no stored second fell inside the stall";
        ASSERT_FALSE (seen.settled.empty ());
        EXPECT_GT (seen.settled.back (), seen.empty.front ())
        << "no second after the stall stored its latency";

        // The requests the stall held settle in a later second, and that
        // second's row carries their wait.
        double slowest_row_p99 = 0.0;
        for (const auto timestamp : seen.settled) {
            slowest_row_p99 = std::max (slowest_row_p99,
            rows.at (timestamp).at ("latency_p99_ms").get<double> ());
        }
        EXPECT_GE (slowest_row_p99, vayu::tests::SlowMockServer::STALL_WINDOW_MS / 2.0);

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2782: only a gate frame carries the run-so-far distributions, and the final
// one, read after the drain, is what the report says. A 100 ms frame carries
// neither key; every gate frame carries `cumulativeLatency` and, with the
// phase bank on by default, `cumulativePhases`; the last frame's latency
// distribution is the report's `latency` and its phase means are the
// report's `avg*Ms`.
// Mutation checks: drop `cumulativePhases` from `put_gate_distributions` and
// the gate assertions fail; drop `maxMs` from a phase entry and the percentile
// comparison throws on the missing key; have the report ignore the stored
// phase means and the average comparison fails (the trace sample is a
// different population);
// feed the interval recorder a value 1 ms off the one record_latency_sample
// gives the report's histogram and every latency comparison fails.
TEST (LoadClock, GateFramesCarryTheRunSoFarDistributionsTheReportEndsOn) {
    const std::string db_path = "test_load_clock_gate_distributions.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" }, { "url", server.fast_url () },
            { "mode", "constant_rps" }, { "duration", "2s" },
            { "targetRps", 20.0 }, { "timeout", 5000 }, { "workers", 1 } };
        const std::string run_id = "run_load_gate_distributions";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto run = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (run);
        ASSERT_EQ (run->status, vayu::RunStatus::Completed) << run->summary;

        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        const auto frames = live_frames (*context);
        ASSERT_FALSE (frames.empty ());

        size_t gate_frames = 0;
        for (const auto& frame : frames) {
            if (!frame.contains ("secondSamples")) {
                EXPECT_FALSE (frame.contains ("cumulativeLatency")) << frame.dump ();
                EXPECT_FALSE (frame.contains ("cumulativePhases")) << frame.dump ();
                continue;
            }
            ++gate_frames;
            ASSERT_TRUE (frame.contains ("cumulativeLatency")) << frame.dump ();
            ASSERT_TRUE (frame.contains ("cumulativePhases")) << frame.dump ();
            EXPECT_TRUE (frame.at ("cumulativeLatency").is_null () ||
            frame.at ("cumulativeLatency").is_object ())
            << frame.dump ();
        }
        EXPECT_GE (gate_frames, 2u) << "no gate frame before the final one";

        const auto& last     = frames.back ();
        const auto completed = last.at ("totalRequests").get<size_t> ();
        ASSERT_GT (completed, 0u);
        ASSERT_TRUE (last.at ("cumulativeLatency").is_object ()) << last.dump ();
        EXPECT_EQ (last.at ("cumulativeLatency").at ("count").get<size_t> (), completed);
        const auto& phases = last.at ("cumulativePhases");
        ASSERT_TRUE (phases.is_object ()) << last.dump ();

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const auto& breakdown       = report.at ("timingBreakdown");
        constexpr auto AVERAGE_KEYS = std::to_array<std::string_view> (
        { "avgDnsMs", "avgConnectMs", "avgTlsMs", "avgFirstByteMs", "avgDownloadMs" });
        for (size_t i = 0; i < vayu::core::TIMING_PHASE_COUNT; ++i) {
            const auto* phase = vayu::core::TIMING_PHASE_KEYS.at (i);
            const std::string average (AVERAGE_KEYS.at (i));
            EXPECT_EQ (phases.at (phase).at ("count").get<size_t> (), completed) << phase;
            // Both are hdr_mean over the bank after the drain, so they agree
            // to the double; the tolerance only absorbs the JSON round trip.
            EXPECT_NEAR (phases.at (phase).at ("meanMs").get<double> (),
            breakdown.at (average).get<double> (), 1e-9)
            << phase << " against " << average;

            // The live table's percentiles and max are the report's, read
            // from the same bank after the same drain.
            const auto& stored = breakdown.at ("phases").at (phase);
            for (const auto& [live_key, report_key] :
            std::to_array<std::pair<std::string_view, std::string_view>> ({ { "p50Ms", "p50" },
            { "p95Ms", "p95" }, { "p99Ms", "p99" }, { "maxMs", "max" } })) {
                EXPECT_NEAR (phases.at (phase).at (live_key).get<double> (),
                stored.at (report_key).get<double> (), 1e-9)
                << phase << " " << live_key << " against " << report_key;
            }
        }

        // The live view's last HDR points are History's. One
        // record_latency_sample feeds the report's histogram and the window
        // the run-so-far one is merged from, with one value, and the final
        // frame merges the last window after the drain, so the two hold the
        // same buckets and read the same to the double.
        const auto& live_latency   = last.at ("cumulativeLatency");
        const auto& report_latency = report.at ("latency");
        EXPECT_EQ (live_latency.at ("count").get<size_t> (),
        report.at ("summary").at ("totalRequests").get<size_t> ());
        constexpr auto LATENCY_KEYS =
        std::to_array<std::pair<std::string_view, std::string_view>> (
        { { "minMs", "min" }, { "p50Ms", "p50" }, { "p75Ms", "p75" },
        { "p90Ms", "p90" }, { "p95Ms", "p95" }, { "p99Ms", "p99" },
        { "p999Ms", "p999" }, { "maxMs", "max" } });
        for (const auto& [live_key, report_key] : LATENCY_KEYS) {
            EXPECT_NEAR (live_latency.at (live_key).get<double> (),
            report_latency.at (report_key).get<double> (), 1e-9)
            << live_key << " against latency." << report_key;
        }

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2393: every frame carries the trailing window, and a gate frame and its
// stored row carry one reading of it. A hundred 50 ms completions land before
// tick 0, so they are in the run's mean and in no window; the 5 ms ones fed
// until a row lands are the only ones a window holds. Mutation checks: put
// the >= 100 ms delta back on the frame's `currentRps`, or store
// `current_total / run_elapsed_s` as the row's `current_rps`, and the
// frame/row equality fails; read the run's mean into the window's and the
// 5 ms assertions fail. #2821's mean in flight rides the same reading:
// store the run-long `average_in_flight` as the row's `window_avg_in_flight`
// and its frame/row equality fails.
TEST (CollectMetrics, TheGateFrameAndItsStoredRowShareOneTrailingWindow) {
    const std::string db_path = "test_collect_metrics_trailing_window.db";
    vayu::tests::remove_database_files (db_path);

    vayu::db::Database db (db_path);
    db.init ();

    vayu::db::Run run;
    run.id              = "trailing_window_run";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = 1;
    run.config_snapshot = "{}";
    db.create_run (run);

    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> (run.id, cfg);
    auto& mc = *ctx->metrics_collector;
    for (int i = 0; i < 100; ++i) {
        mc.record_success (200, 50.0, 4.0);
    }
    ctx->requests_sent = 100;
    ctx->is_running    = true;
    vayu::tests::stamp_load_start (*ctx);

    std::thread metrics ([&] () { collect_metrics (ctx, &db); });
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] () { return ctx->published_count.load () > 0; }))
    << "the metrics thread never published tick 0";
    // Paced feeding, so every window up to the first row holds completions.
    EXPECT_TRUE (vayu::tests::wait_until ([&] () {
        mc.record_success (200, 5.0, 0.5);
        ++ctx->requests_sent;
        return !db.get_metric_ticks_since (run.id, 0).empty ();
    }))
    << "no tick was persisted";
    ctx->is_running = false;
    metrics.join ();

    const auto ticks = db.get_metric_ticks_since (run.id, 0);
    ASSERT_FALSE (ticks.empty ()) << "no tick was persisted; nothing is proven";
    const auto stored = nlohmann::json::parse (ticks.front ().payload);
    EXPECT_GT (stored.at ("current_rps").get<double> (), 0.0) << stored.dump ();
    EXPECT_GT (stored.at ("current_send_rate").get<double> (), 0.0) << stored.dump ();
    EXPECT_DOUBLE_EQ (stored.at ("window_avg_latency_ms").get<double> (), 5.0);
    EXPECT_DOUBLE_EQ (stored.at ("window_avg_queue_wait_ms").get<double> (), 0.5);
    EXPECT_GT (stored.at ("window_avg_in_flight").get<double> (), 0.0) << stored.dump ();

    const auto batch = ctx->ticks_since (0);
    ASSERT_FALSE (batch.payloads.empty ());
    size_t gate_frames = 0;
    for (const auto& payload : batch.payloads) {
        const auto frame = live_frame_json (payload);
        for (const auto* key : { "currentRps", "currentSendRate", "windowAvgInFlight" }) {
            ASSERT_TRUE (frame.contains (key) && frame.at (key).is_number ())
            << key << ": " << frame.dump ();
        }
        for (const auto* key : { "windowAvgLatencyMs", "windowAvgQueueWaitMs" }) {
            ASSERT_TRUE (frame.contains (key)) << key << ": " << frame.dump ();
            EXPECT_TRUE (frame.at (key).is_null () || frame.at (key).is_number ())
            << frame.dump ();
        }
        if (frame.at ("timestamp") != stored.at ("timestamp")) {
            continue;
        }
        ++gate_frames;
        EXPECT_DOUBLE_EQ (frame.at ("currentRps").get<double> (),
        stored.at ("current_rps").get<double> ());
        EXPECT_DOUBLE_EQ (frame.at ("currentSendRate").get<double> (),
        stored.at ("current_send_rate").get<double> ());
        EXPECT_EQ (frame.at ("windowAvgLatencyMs"), stored.at ("window_avg_latency_ms"));
        EXPECT_EQ (frame.at ("windowAvgQueueWaitMs"), stored.at ("window_avg_queue_wait_ms"));
        EXPECT_DOUBLE_EQ (frame.at ("windowAvgInFlight").get<double> (),
        stored.at ("window_avg_in_flight").get<double> ());
        EXPECT_GT (frame.at ("avgLatencyMs").get<double> (), 5.0)
        << "the run's mean lost the completions before tick 0";
    }
    EXPECT_EQ (gate_frames, 1u)
    << "no live frame carried the stored row's timestamp";

    vayu::tests::remove_database_files (db_path);
}

namespace {

/// @p entries' counts summed per class.
StatusClassCounts class_totals (const nlohmann::json& entries) {
    StatusClassCounts totals{};
    for (const auto& value : entries) {
        const auto entry = status_second_entry_from_json (value);
        if (!entry) {
            ADD_FAILURE () << "not a status-seconds entry: " << value.dump ();
            continue;
        }
        for (size_t i = 0; i < totals.size (); ++i) {
            totals.at (i) += entry->counts.at (i);
        }
    }
    return totals;
}

} // namespace

// #2866: a gate drains the closed seconds once and hands the same entries to
// its frame (`statusSeconds`) and its stored row (`status_seconds`), so live
// and History draw the same seconds; the seconds run on from 0 with none
// emitted twice. Load "started" 2.5 s before the completions, so they belong
// to a second the first gates close. Mutation check: drain again in
// `persist_metric_tick` instead of taking the gate's entries and the rows
// store no second, so the wait below runs out and the frame/row equality
// fails.
TEST (CollectMetrics, TheGateFrameAndItsStoredRowCarryTheSameClosedSeconds) {
    const std::string db_path = "test_collect_metrics_status_seconds.db";
    vayu::tests::remove_database_files (db_path);

    vayu::db::Database db (db_path);
    db.init ();

    vayu::db::Run run;
    run.id              = "status_seconds_run";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = 1;
    run.config_snapshot = "{}";
    db.create_run (run);

    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> (run.id, cfg);
    auto& mc = *ctx->metrics_collector;
    const int64_t load_start = std::chrono::duration_cast<std::chrono::milliseconds> (
                               std::chrono::steady_clock::now ().time_since_epoch ())
                               .count () -
    2500;
    ctx->load_start_steady_ms.store (load_start);
    mc.set_load_start (load_start);
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

    const StatusClassCounts recorded{ 80, 0, 0, 15, 5 };
    const auto stored_totals = [&] () {
        nlohmann::json entries = nlohmann::json::array ();
        for (const auto& [timestamp, row] : stored_rows (db, run.id)) {
            for (const auto& entry : row.at ("status_seconds")) {
                entries.push_back (entry);
            }
        }
        return class_totals (entries);
    };
    std::thread metrics ([&] () { collect_metrics (ctx, &db); });
    EXPECT_TRUE (
    vayu::tests::wait_until ([&] () { return stored_totals () == recorded; }))
    << "the stored rows never held every completion";
    ctx->is_running = false;
    metrics.join ();

    const auto rows   = stored_rows (db, run.id);
    const auto frames = live_frames (*ctx);
    ASSERT_FALSE (frames.empty ());
    size_t gate_frames  = 0;
    int64_t next_second = 0;
    for (size_t i = 0; i < frames.size (); ++i) {
        const auto& frame = frames[i];
        ASSERT_EQ (frame.contains ("statusSeconds"), frame.contains ("secondSamples"))
        << "statusSeconds is a gate frame's key: " << frame.dump ();
        if (!frame.contains ("statusSeconds")) {
            continue;
        }
        for (const auto& entry : frame.at ("statusSeconds")) {
            EXPECT_EQ (entry.at ("second").get<int64_t> (), next_second++)
            << frame.dump ();
            EXPECT_EQ (entry.at ("span").get<int64_t> (), 1) << frame.dump ();
        }
        // The final frame closes what closed since the last gate, and stores
        // no row.
        if (i + 1 == frames.size ()) {
            continue;
        }
        ++gate_frames;
        const auto row = rows.find (frame.at ("timestamp").get<int64_t> ());
        ASSERT_NE (row, rows.end ())
        << "a gate frame with no stored row: " << frame.dump ();
        EXPECT_EQ (row->second.at ("status_seconds"), frame.at ("statusSeconds"))
        << "at " << row->first;
    }
    EXPECT_EQ (gate_frames, rows.size ());
    EXPECT_GE (next_second, 3) << "the completions' second was never closed";

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

// #2399: a load run that throws still stores a summary, built by its own
// producer. The exact slow count has to ride that one too, or a crashed run's
// report falls back to counting the capped traces. Mutation check: drop either
// slow assignment in failed_run_summary_inputs and this reds.
TEST (FailedRunSummaryInputs, CarriesTheExactSlowCountAndItsThreshold) {
    RunContext ctx ("run_failed_slow",
    nlohmann::json{ { "slow_threshold_ms", 100 }, { "max_slow_results", 2 } });
    for (int i = 0; i < 5; ++i) {
        ctx.metrics_collector->record_success (
        200, 900.0, 0.0, "{}", SuccessTraceReason::Slow);
    }

    const auto inputs = failed_run_summary_inputs (ctx);
    EXPECT_EQ (inputs.slow_total, 5u);
    EXPECT_EQ (inputs.slow_threshold_ms, 100);
    const auto summary = build_run_summary_payload (inputs);
    ASSERT_TRUE (summary.contains ("slow_requests")) << summary.dump ();
    EXPECT_EQ (summary["slow_requests"]["count"].get<size_t> (), 5u);
    EXPECT_EQ (summary["slow_requests"]["thresholdMs"].get<int> (), 100);
}

// #2400: the per-type error counts ride the crashed run's summary too, past the
// error store's cap, or its report counts the stored records instead. Mutation
// check: drop the error_types assignment in failed_run_summary_inputs and this
// reds at an empty object.
TEST (FailedRunSummaryInputs, CarriesTheExactErrorTypesPastTheStoreCap) {
    RunContext ctx ("run_failed_types", nlohmann::json::object (), /*max_errors=*/2);
    for (int i = 0; i < 7; ++i) {
        ctx.metrics_collector->record_error (vayu::ErrorCode::Timeout, "slow");
    }
    ctx.metrics_collector->record_error (vayu::ErrorCode::DnsError, "nx");
    ASSERT_EQ (ctx.metrics_collector->errors_dropped (), 6u);

    const auto summary = build_run_summary_payload (failed_run_summary_inputs (ctx));
    EXPECT_EQ (summary["error_types"],
    (nlohmann::json{ { "dns_failed", 1 }, { "timeout", 7 } }))
    << summary.dump ();
}

// A run that recorded no error still writes the key, so a reader can tell it
// from a summary stored before the counts existed.
TEST (FailedRunSummaryInputs, ARunWithNoErrorWritesAnEmptyErrorTypesObject) {
    RunContext ctx ("run_failed_clean", nlohmann::json::object ());
    const auto summary = build_run_summary_payload (failed_run_summary_inputs (ctx));
    ASSERT_TRUE (summary.contains ("error_types")) << summary.dump ();
    EXPECT_EQ (summary["error_types"], nlohmann::json::object ());
}

// A failed run timed no drain apart, so its window is the whole run and every
// completion is inside it (#2882), never a 0 that reads as "nothing answered
// while sending". Mutation check: drop the assignment in
// `failed_run_summary_inputs` and this reads 0.
TEST (FailedRunSummaryInputs, CountsEveryCompletionAsCompletedWhileSending) {
    RunContext ctx ("run_failed_window", nlohmann::json::object ());
    for (int i = 0; i < 3; ++i) {
        ctx.metrics_collector->record_success (200, 10.0, 0.0, "{}");
    }
    const auto summary = build_run_summary_payload (failed_run_summary_inputs (ctx));
    EXPECT_EQ (summary.at ("total_requests").get<size_t> (), 3u) << summary.dump ();
    EXPECT_EQ (summary.at ("completed_while_sending").get<size_t> (), 3u)
    << summary.dump ();
}

// A threshold of 0 measured nothing, so the summary says nothing rather than
// a 0 a reader would take for "no outliers".
TEST (FailedRunSummaryInputs, AZeroThresholdKeepsTheSlowSectionOut) {
    RunContext ctx (
    "run_failed_no_threshold", nlohmann::json{ { "slow_threshold_ms", 0 } });
    EXPECT_FALSE (
    build_run_summary_payload (failed_run_summary_inputs (ctx)).contains ("slow_requests"));
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

/// A real load run against a local mock, driven to its terminal row.
class LoadRunToTerminalTest : public ::testing::Test {
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
    /// job), then drive the run to completion and hand back its stored row.
    /// Waits well past a healthy run's own duration on purpose: a slow-but-
    /// finishing run fails the caller's assertions, not this wait.
    std::optional<vayu::db::Run> run_to_terminal_row (const std::string& run_id,
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
        }
        return stored;
    }

    std::unique_ptr<vayu::tests::SlowMockServer> server;
    std::unique_ptr<vayu::db::Database> db;
};

class FailRunTest : public LoadRunToTerminalTest,
                    public ::testing::WithParamInterface<FailRunCase> {
    protected:
    std::optional<vayu::RunStatus> run_to_terminal_status (const std::string& run_id,
    const nlohmann::json& config) {
        auto row = run_to_terminal_row (run_id, config);
        if (!row.has_value ()) {
            return std::nullopt;
        }
        return row->status;
    }

    nlohmann::json base_config () const {
        return { { "mode", "iterations" }, { "iterations", 3 }, { "concurrency", 1 },
            { "url", server->fast_url () }, { "method", "GET" }, { "workers", 1 },
            { "tests", "pm.test('always fails', function () { pm.expect(1).to.equal(2); });" } };
    }
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

// #2399, the completed-run producer end to end: every request to `/slow`
// (500ms) crosses a 100ms threshold - a lower bound, so a slow runner cannot
// fail it - and the slow store keeps 2 of the 4. The stored summary has to
// count all 4. Mutation check: drop the `slow_total` assignment in
// collect_summary_inputs and the count reds at 0.
TEST_F (LoadRunToTerminalTest, ACompletedRunStoresTheExactSlowCount) {
    const nlohmann::json config = { { "mode", "iterations" }, { "iterations", 4 },
        { "concurrency", 4 }, { "url", server->slow_url () }, { "method", "GET" },
        { "workers", 1 }, { "slow_threshold_ms", 100 }, { "max_slow_results", 2 } };

    const auto row = run_to_terminal_row ("run-slow-count-e2e", config);
    ASSERT_HAS_VALUE (row);
    EXPECT_EQ (row->status, vayu::RunStatus::Completed);
    const auto summary = nlohmann::json::parse (row->summary);
    ASSERT_TRUE (summary.contains ("slow_requests")) << summary.dump ();
    EXPECT_EQ (summary["slow_requests"]["count"].get<size_t> (), 4u);
    EXPECT_EQ (summary["slow_requests"]["thresholdMs"].get<int> (), 100);
    EXPECT_EQ (summary["sampling"]["slow_traces_dropped"].get<size_t> (), 2u);
}

// #2400, the same producer for the per-type error counts: every request to
// `/slow` (500ms) outlives a 100ms timeout - a lower bound again - and the
// error store keeps 2 of the 4. Mutation check: drop the `error_types`
// assignment in collect_summary_inputs and this reds at an empty object.
TEST_F (LoadRunToTerminalTest, ACompletedRunStoresTheExactErrorTypes) {
    auto cap = db->get_config_entry ("maxStoredErrors");
    ASSERT_HAS_VALUE (cap);
    cap->value = "2";
    db->save_config_entry (*cap);
    const nlohmann::json config = { { "mode", "iterations" },
        { "iterations", 4 }, { "concurrency", 4 }, { "url", server->slow_url () },
        { "method", "GET" }, { "workers", 1 }, { "timeout", 100 } };

    const auto row = run_to_terminal_row ("run-error-types-e2e", config);
    ASSERT_HAS_VALUE (row);
    const auto summary = nlohmann::json::parse (row->summary);
    EXPECT_EQ (summary["error_types"], (nlohmann::json{ { "timeout", 4 } }))
    << summary.dump ();
    EXPECT_EQ (summary["sampling"]["errors_dropped"].get<size_t> (), 2u);
}

// #2798: a load run that sets no `timeout` of its own sends with the
// `defaultTimeout` setting, as `POST /execute` does. Each case reads the stored
// `error_types`, so none depends on how fast the runner is. A `null` timeout
// never reaches the worker (the route erases it, #1893);
// run_config_validation_test.cpp drives that case through `POST /runs`.
class LoadRunTimeoutTest : public LoadRunToTerminalTest {
    protected:
    /// Through the row, not the route: the route's bounds are not the subject.
    void set_default_timeout (const char* ms) {
        auto entry = db->get_config_entry ("defaultTimeout");
        ASSERT_HAS_VALUE (entry);
        entry->value = ms;
        db->save_config_entry (*entry);
    }

    nlohmann::json two_requests_to (const std::string& url) const {
        return { { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 2 },
            { "url", url }, { "method", "GET" }, { "workers", 1 } };
    }

    void expect_timeouts (const std::optional<vayu::db::Run>& row, int count) {
        ASSERT_HAS_VALUE (row);
        const auto summary = nlohmann::json::parse (row->summary);
        EXPECT_EQ (summary["error_types"], (nlohmann::json{ { "timeout", count } }))
        << summary.dump ();
    }
};

// `/hang` never answers. At the setting's floor (1000) the run ends in about a
// second; one that ignores the setting waits the compiled-in 30s, past
// run_to_terminal_row's 20s wait, so it fails as a hang rather than on a clock.
// Mutation check: put `config.value ("timeout", 30000)` back in
// execute_load_test and this reds with "the run never reached a terminal status".
TEST_F (LoadRunTimeoutTest, ARunWithNoTimeoutUsesTheDefaultTimeoutSetting) {
    set_default_timeout ("1000");
    expect_timeouts (run_to_terminal_row ("run-default-timeout-e2e",
                     two_requests_to (server->hang_url ())),
    2);
}

// `/slow` answers in 500ms: inside the 3000ms setting, outside the run's own
// 100ms (a lower bound, so a slow runner cannot fail it). Mutation
// check: make the resolver return the setting first and this reds at `{}`.
TEST_F (LoadRunTimeoutTest, AnExplicitTimeoutBeatsTheSetting) {
    set_default_timeout ("3000");
    auto config       = two_requests_to (server->slow_url ());
    config["timeout"] = 100;
    expect_timeouts (run_to_terminal_row ("run-explicit-timeout-e2e", config), 2);
}
