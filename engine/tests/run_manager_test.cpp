/**
 * @file tests/run_manager_test.cpp
 * @brief `RunContext`'s live tick ring, the run manager's retention and its constructor, and the
 * live-ring and drain-window arithmetic (`live_ring_size`, `expected_requests_for`,
 * `natural_end_drain_ms`).
 */

#include "optional_assert.hpp"
#include "vayu/core/run_manager.hpp"
#include <gtest/gtest.h>

#include <atomic>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "load_start_stamp.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/event_loop.hpp"
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

// #3235: a collection plan can hold a streaming step beside ordinary ones, so
// its wait is whichever bound is longer. Mutation check: return the stream's
// wait alone whenever a stream exists and the timeout-longer case fails here,
// and `LoadDrain` below sees the ordinary step cancelled.
TEST (NaturalEndDrainMs, ACollectionRunWaitsTheLongerOfItsStreamsAndItsTimeout) {
    const vayu::StreamBounds short_cap{ 4000, 10 };
    EXPECT_EQ (collection_natural_end_drain_ms (short_cap, 30000), 30000 + 2000);
    EXPECT_EQ (collection_natural_end_drain_ms (short_cap, 200), 4000 + 5000 + 2000);
    EXPECT_EQ (collection_natural_end_drain_ms (std::nullopt, 30000), 30000 + 2000);
}

// The route reads a `null` cap as absent, so the run must too: it is read
// after the run row exists, where a throw strands the row `pending`.
// Mutation check: read the caps with `config.value (key, default)` again and
// this throws `type_error`.
TEST (RunContextStreamBounds, ANullCapFallsBackToTheSetting) {
    EngineDefaults defaults;
    defaults.sse_limits.max_stream_duration_ms = 45000;
    defaults.sse_limits.max_stream_events      = 12;
    const nlohmann::json config{ { "stream", true },
        { "maxStreamDurationMs", nullptr }, { "maxStreamEvents", 3 } };
    const RunContext context ("r", config,
    vayu::core::constants::metrics_collector::DEFAULT_MAX_ERRORS, defaults);
    ASSERT_HAS_VALUE (context.stream_bounds);
    EXPECT_EQ (context.stream_bounds->max_duration_ms, 45000);
    EXPECT_EQ (context.stream_bounds->max_events, 3);
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
    ctx->request_stop ();

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
// `test_scripts`.
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
    EXPECT_EQ (ctx.test_scripts, std::vector<std::string>{ "pm.test(\"a\",()=>{});" });
}

// A saved request composes the collection chain's `script.post` elements
// before its own (issue #1514's `compose_elements` order), and both are
// deferred by default - so a request whose collection also asserts
// something must run both under load, not only the first. Each stays its own
// entry, never joined, so the replay runs each in its own scope (#3125).
TEST (RunManager, ConstructorKeepsEveryDeferredPostScriptApart) {
    auto config = nlohmann::json::parse (R"({
      "requestElements": [
        { "kind": "script.post", "config": { "script": "pm.test(\"chain\",()=>{});" } },
        { "kind": "script.post", "config": { "script": "pm.test(\"own\",()=>{});" } }
      ]
    })");

    RunContext ctx ("r", config);
    EXPECT_EQ (ctx.test_scripts,
    (std::vector<std::string>{ "pm.test(\"chain\",()=>{});", "pm.test(\"own\",()=>{});" }));
}

// The inline one is left out entirely, because it must not run twice, even
// where it sits between two deferred ones in compile order. A blank one is
// left out too: replayed alone it would tally a pass for asserting nothing.
TEST (RunManager, ConstructorSkipsInlineAndBlankScriptPostsKeepingTheRest) {
    auto config = nlohmann::json::parse (R"({
      "requestElements": [
        { "kind": "script.post", "config": { "script": "pm.test(\"chain\",()=>{});" } },
        { "kind": "script.post",
          "config": { "script": "pm.test(\"inline\",()=>{});", "inline": true } },
        { "kind": "script.post", "config": { "script": "  \n  " } },
        { "kind": "script.post", "config": { "script": "pm.test(\"own\",()=>{});" } }
      ]
    })");

    RunContext ctx ("r", config);
    EXPECT_EQ (ctx.test_scripts,
    (std::vector<std::string>{ "pm.test(\"chain\",()=>{});", "pm.test(\"own\",()=>{});" }));
}

// A `script.post` marked `inline` runs on the pipeline hooks instead
// (`submit_one_request` / `run_request_elements_after_submission`), so the
// deferred replay must not run it a second time - `test_scripts` stays empty.
TEST (RunManager, ConstructorLeavesTestScriptEmptyForAnInlineScriptPost) {
    auto config = nlohmann::json::parse (R"({
      "requestElements": [
        { "kind": "script.post",
          "config": { "script": "pm.test(\"a\",()=>{});", "inline": true } }
      ]
    })");

    RunContext ctx ("r", config);
    EXPECT_TRUE (ctx.test_scripts.empty ());
}

// The route refuses `tests`/`postRequestScript(s)` outright now (issue
// #1594's cut-over) - the constructor itself no longer reads any of them, so
// a payload that still carries one (a stale caller the route did not run in
// front of, as this unit test bypasses it) is simply ignored rather than
// populating `test_scripts`.
TEST (RunManager, ConstructorIgnoresTheRetiredTestsField) {
    auto config = nlohmann::json::parse (R"({"tests":"pm.test(\"a\",()=>{});"})");

    RunContext ctx ("r", config);
    EXPECT_TRUE (ctx.test_scripts.empty ());
}
