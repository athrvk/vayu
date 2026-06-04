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
