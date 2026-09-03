#include "optional_assert.hpp"
#include "vayu/core/run_manager.hpp"
#include <gtest/gtest.h>

#include <chrono>
#include <thread>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/platform/platform.hpp"

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
    ctx->event_loop    = std::make_unique<vayu::http::EventLoop> (loop_config);
    ctx->start_time_ms = 1;
    ctx->is_running    = true;

    std::thread metrics ([&] () { collect_metrics (ctx, &db); });

    // Let a few ticks land, then request a stop - as POST /runs/:id/stop does.
    std::this_thread::sleep_for (std::chrono::milliseconds (300));
    size_t ticks_at_stop = ctx->published_count.load ();
    ctx->should_stop     = true;

    // The worker is still draining: the stream must stay open and keep ticking.
    std::this_thread::sleep_for (std::chrono::milliseconds (400));
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
    ctx->event_loop    = std::make_unique<vayu::http::EventLoop> (loop_config);
    ctx->start_time_ms = 1;
    ctx->is_running    = true;

    std::thread metrics ([&] () { collect_metrics (ctx, &db); });
    std::this_thread::sleep_for (std::chrono::milliseconds (150));

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

    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> ("unpublished_run", cfg);
    // Deliberately never set event_loop - this is the window where the runner
    // thread is still in its config reads (or failed before building a loop).
    ctx->start_time_ms = 1;
    ctx->is_running    = true;

    std::thread metrics ([&] () { collect_metrics (ctx, &db); });
    std::this_thread::sleep_for (std::chrono::milliseconds (1300));
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

TEST (RunManagerRetention, BackgroundSweeperEvictsWithoutExternalTriggers) {
    RunManager mgr;
    nlohmann::json cfg;
    auto a = std::make_shared<RunContext> ("a", cfg);
    mgr.register_run ("a", a);
    mgr.retain_run ("a");
    a->completed_at_ms.store (1); // backdate "a" so it's immediately expired

    EXPECT_EQ (mgr.retained_count (), 1u);

    // Sweep cadence is ttl/2, floored at 500ms. With ttl=1000 → 500ms cadence,
    // so after ~750ms the sweeper has had at least one tick.
    mgr.start_sweeper (1000);
    std::this_thread::sleep_for (std::chrono::milliseconds (750));
    EXPECT_EQ (mgr.retained_count (), 0u);

    mgr.stop_sweeper (); // also exercised by destructor
}

// The TTL provider must be invoked every tick (not captured once at start), so
// a runtime change to liveRetentionMs is honored without a daemon restart.
TEST (RunManagerRetention, BackgroundSweeperRereadsTtlProviderEachTick) {
    RunManager mgr;
    std::atomic<int> calls{ 0 };
    // ttl=1000 → 500ms cadence; over ~1300ms expect at least two invocations.
    mgr.start_sweeper ([&calls] () -> int64_t {
        calls.fetch_add (1);
        return 1000;
    });
    std::this_thread::sleep_for (std::chrono::milliseconds (1300));
    mgr.stop_sweeper ();
    EXPECT_GE (calls.load (), 2);
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

// A load run's `tests` may arrive as a list of parts, exactly like the design
// path's scripts. Before this, only the request's own test script was sent, so
// a collection-level assertion passed in design mode and was silently never
// checked under load.
//
// This exercises the wiring through RunContext's constructor - not
// `read_script` in isolation (that coverage lives in script_compose_test.cpp).
// Reverting run_manager.cpp's call back to `config["tests"].get<std::string>
// ()` makes the constructor throw for a list payload; verified by temporarily
// reverting and confirming this test fails, then restoring.
TEST (RunManager, ConstructorJoinsTestScriptParts) {
    auto config = nlohmann::json::parse (R"({
      "tests": [
        {"origin":"collection","id":"c1","name":"API","script":"pm.test(\"a\",()=>{});"},
        {"origin":"request","id":"r1","script":"pm.test(\"b\",()=>{});"}
      ]
    })");

    RunContext ctx ("r", config);
    EXPECT_EQ (ctx.test_script, "pm.test(\"a\",()=>{});\n\npm.test(\"b\",()=>{});");
}

TEST (RunManager, ConstructorStillAcceptsAPlainTestString) {
    auto config = nlohmann::json::parse (R"({"tests":"pm.test(\"a\",()=>{});"})");

    RunContext ctx ("r", config);
    EXPECT_EQ (ctx.test_script, "pm.test(\"a\",()=>{});");
}

// The wiring nobody else covers: what a collector counted has to reach the
// stored summary. A field the collector grows and `read_retention` forgets
// reports as zero-or-false forever, which is this repo's most repeated defect -
// so the two cases the byte-budget marker (issue #1192) exists to separate are
// checked through the function that carries it, not off the collector alone.
// Drop the assignment in read_retention and the first half reddens.
TEST (ReadRetention, CarriesTheResponseSampleBudgetMarkerIntoTheSummary) {
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
