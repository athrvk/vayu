#include "vayu/core/run_manager.hpp"
#include <gtest/gtest.h>

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
    ASSERT_EQ (from0.size (), 3u);
    EXPECT_EQ (from0[0], "a");
    EXPECT_EQ (from0[2], "c");

    auto from2 = ctx.ticks_since (2);
    ASSERT_EQ (from2.size (), 1u);
    EXPECT_EQ (from2[0], "c");

    EXPECT_TRUE (ctx.ticks_since (3).empty ());
    EXPECT_TRUE (ctx.ticks_since (99).empty ());
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
    std::string p = vayu::core::build_tick_payload (stats, 7);
    EXPECT_NE (p.find ("event: metrics\n"), std::string::npos);
    EXPECT_NE (p.find ("id: 7\n"), std::string::npos);
    EXPECT_NE (p.find ("\"totalRequests\":42"), std::string::npos);
    EXPECT_EQ (p.substr (p.size () - 2), "\n\n");
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
    mgr.sweep_retained (60000);    // ttl 60s; "b" was stamped ~now

    EXPECT_EQ (mgr.get_run_or_retained ("a"), nullptr);
    EXPECT_NE (mgr.get_run_or_retained ("b"), nullptr);
}
