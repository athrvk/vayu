#include "vayu/core/run_manager.hpp"
#include <gtest/gtest.h>

#include <chrono>
#include <thread>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/event_loop.hpp"

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
    ASSERT_TRUE (entry.has_value ())
    << "seed_default_config did not seed the key";
    entry->value = "20000";
    db.save_config_entry (*entry);

    auto tick = db.get_config_entry ("liveTickIntervalMs");
    ASSERT_TRUE (tick.has_value ());
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
