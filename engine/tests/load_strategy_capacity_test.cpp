/**
 * @file tests/load_strategy_capacity_test.cpp
 * @brief Load strategies: the capacity mode, its search levels and the live frames that carry
 * the search state.
 *
 * The `LoadStrategyTest` fixture is in `load_strategy_fixture.hpp`.
 */

#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/load_strategy.hpp"

#include <gtest/gtest.h>

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "load_start_stamp.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"
#include "wait_until.hpp"

#include "load_strategy_fixture.hpp"

using vayu::tests::load_strategy::LoadStrategyTest;
using vayu::tests::load_strategy::TEST_DB_PATH;

// ---------------------------------------------------------------------------
// Capacity discovery
// ---------------------------------------------------------------------------

namespace {

/**
 * Run a capacity search end to end against the mock server.
 *
 * The metrics thread is spawned here rather than left out as the other
 * strategy tests leave it, because it is the search's only sensor: the
 * controller steers by `RunContext::latest_live_tick()`, which nothing else
 * publishes. A capacity test without it measures a search that never sees a
 * window close - which is itself the documented behaviour, but not the one
 * these tests are about.
 */
vayu::core::CapacitySummary run_capacity_search (const nlohmann::json& config,
const std::string& url,
const std::string& run_id,
vayu::db::Database& db) {
    auto context = std::make_shared<vayu::core::RunContext> (run_id, config);

    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = url;
    request.timeout_ms = 30000;

    context->is_running = true;
    vayu::tests::stamp_load_start (*context);
    std::thread metrics (
    [context, &db] () { vayu::core::collect_metrics (context, &db); });

    auto strategy = vayu::core::LoadStrategy::create (config);
    EXPECT_NE (strategy, nullptr);
    strategy->execute (context, db, request);

    context->is_running = false;
    metrics.join ();
    context->event_loop->stop (false);

    EXPECT_TRUE (context->capacity.has_value ());
    return context->capacity.value_or (vayu::core::CapacitySummary{});
}

} // namespace

TEST_F (LoadStrategyTest, CapacityModeIsSelectedByTheFactory) {
    nlohmann::json config = { { "mode", "capacity" } };
    EXPECT_NE (vayu::core::LoadStrategy::create (config), nullptr);
    EXPECT_EQ (vayu::parse_load_test_type ("capacity"), vayu::LoadTestType::Capacity);
    EXPECT_STREQ (vayu::to_string (vayu::LoadTestType::Capacity), "capacity");
}

// #2392: only an `iterations` run is denied its measured sending window, and an
// unrecognised mode falls back exactly as `create` does.
TEST (ReturnsAtSendDeadline, IsFalseOnlyForAnIterationsRun) {
    using vayu::core::returns_at_send_deadline;
    for (const char* mode : { "constant_rps", "constant_concurrency", "ramp_up", "capacity" }) {
        EXPECT_TRUE (returns_at_send_deadline ({ { "mode", mode } })) << mode;
    }
    EXPECT_FALSE (returns_at_send_deadline ({ { "mode", "iterations" } }));
    EXPECT_FALSE (returns_at_send_deadline (
    { { "mode", "iterations" }, { "scenario", { { "source", "collection" } } } }));
    EXPECT_TRUE (returns_at_send_deadline (nlohmann::json::object ()));
    EXPECT_FALSE (
    returns_at_send_deadline ({ { "mode", "legacy" }, { "iterations", 10 } }));
    EXPECT_TRUE (returns_at_send_deadline ({ { "mode", "legacy" } }));
}

// A 500ms endpoint cannot meet a 100ms p99 at any concurrency, so the search
// gives up at its very first level - and says so with the level that breached,
// not with a headline it never measured.
TEST_F (LoadStrategyTest, CapacityStopsOnTheSloAgainstASlowEndpoint) {
    nlohmann::json config = {
        { "mode", "capacity" },
        { "duration", "20s" }, // far above what the SLO stop needs
        { "stepDuration", "1s" },
        { "sloMs", 100 },
        { "startConcurrency", 4 },
        { "concurrency", 64 },
    };

    vayu::db::Database db (TEST_DB_PATH);
    const auto summary =
    run_capacity_search (config, mock_server->slow_url (), "test-capacity-slo", db);

    EXPECT_EQ (summary.stop_reason, "slo_exceeded");
    ASSERT_HAS_VALUE (summary.knee);
    EXPECT_GT (summary.knee->p99_ms, summary.slo_ms);
    EXPECT_EQ (summary.knee->concurrency, 4u)
    << "the search should not have climbed";
    EXPECT_FALSE (summary.max_healthy.has_value ())
    << "no level held the budget, so there is no sustainable capacity to "
       "report";
    // The breach plus the re-measure that confirmed it.
    EXPECT_EQ (summary.levels.size (), 2u);
}

// #2815: an endpoint answering 503 at once is well inside any latency budget
// and sustains nothing. The search stops at its first level on the errors.
// Mutation-check: judge `breaches` on the p99 alone and this climbs to the cap.
TEST_F (LoadStrategyTest, CapacityStopsOnErrorsAgainstAFailingEndpoint) {
    nlohmann::json config = {
        { "mode", "capacity" },
        { "duration", "20s" },
        { "stepDuration", "1s" },
        { "sloMs", 2000 }, // far above anything /error can produce
        { "startConcurrency", 2 },
        { "concurrency", 8 },
    };

    vayu::db::Database db (TEST_DB_PATH);
    const auto summary = run_capacity_search (
    config, mock_server->error_url (), "test-capacity-errors", db);

    EXPECT_EQ (summary.stop_reason, "errors_exceeded");
    ASSERT_HAS_VALUE (summary.knee);
    EXPECT_EQ (summary.knee->concurrency, 2u)
    << "the search should not have climbed";
    EXPECT_GT (summary.knee->error_pct, summary.max_error_pct);
    EXPECT_LT (summary.knee->p99_ms, summary.slo_ms);
    EXPECT_FALSE (summary.max_healthy.has_value ())
    << "every level failed, so there is no sustainable capacity to report";
    // The breach plus the re-measure that confirmed it.
    EXPECT_EQ (summary.levels.size (), 2u);
}

// A fast endpoint inside its budget climbs until it runs out of room, and the
// report says the search ended on the caller's ceiling rather than inventing a
// knee it never observed.
TEST_F (LoadStrategyTest, CapacityStopsAtTheCapAgainstAFastEndpoint) {
    nlohmann::json config = {
        { "mode", "capacity" },
        { "duration", "30s" },
        { "stepDuration", "1s" },
        { "sloMs", 2000 }, // far above anything /fast can produce
        { "startConcurrency", 2 },
        { "concurrency", 3 }, // one step-up and the search is at its ceiling
    };

    vayu::db::Database db (TEST_DB_PATH);
    const auto summary =
    run_capacity_search (config, mock_server->fast_url (), "test-capacity-cap", db);

    EXPECT_EQ (summary.stop_reason, "cap_reached");
    ASSERT_HAS_VALUE (summary.max_healthy);
    EXPECT_EQ (summary.max_healthy->concurrency, 3u);
    EXPECT_GT (summary.max_healthy->rps, 0.0);
    EXPECT_FALSE (summary.knee.has_value ());
    EXPECT_EQ (summary.levels.size (), 2u);
}

// The deadline is the strategy's own stop, not the controller's - it is the one
// condition that is about the clock rather than about what the service did.
//
// 1800ms rather than the 1200ms this started at: `maintain_concurrency` reads
// `std::chrono::steady_clock::now ()` directly (`load_strategy.cpp`) with no
// injected clock, and no such seam exists anywhere in the engine to give this
// test deterministic control over "now" - `capacity_controller.cpp`'s pure
// decision logic takes elapsed time as a parameter but does not own the clock
// either, so there is nothing here to inject into without a disproportionate
// new abstraction the codebase has never needed before. At 1200ms the window
// this test depends on (level 1 closing at ~1000ms, the deadline landing
// ~200ms into level 2) left only 200ms of real wall-clock slack on each side,
// a race by construction under any CI scheduling jitter - exactly what
// flaked macOS CI at 8-way ctest parallelism on 3 real cores (see
// docs/engine/building.md's macOS ctest section). 1800ms leaves ~800ms of
// slack for level 1 to close and ~800ms of headroom before level 2 could
// possibly reach the 1s `stepDuration` threshold itself, on both sides wide
// enough that ordinary CI contention cannot plausibly close it - while still
// being comfortably short of `concurrency`'s 1000-request ceiling, so the
// search is still mid-climb (not capped) when the deadline lands.
TEST_F (LoadStrategyTest, CapacityStopsOnItsDeadline) {
    nlohmann::json config = {
        { "mode", "capacity" },
        { "duration", "1800ms" }, // ends inside the second window, see comment above
        { "stepDuration", "1s" },
        { "sloMs", 2000 },
        { "startConcurrency", 2 },
        { "concurrency", 1000 },
    };

    vayu::db::Database db (TEST_DB_PATH);
    const auto summary = run_capacity_search (
    config, mock_server->fast_url (), "test-capacity-deadline", db);

    EXPECT_EQ (summary.stop_reason, "deadline");
    // One window closed before the clock ran out; the partial second one is not
    // in the audit trail, because it was never judged.
    EXPECT_EQ (summary.levels.size (), 1u);
    ASSERT_HAS_VALUE (summary.max_healthy);
    EXPECT_EQ (summary.max_healthy->concurrency, 2u);
}

// ---------------------------------------------------------------------------
// CapacitySearch against ticks the test produces (#2388)
// ---------------------------------------------------------------------------

namespace {

constexpr int64_t SEARCH_STEP_MS          = 1000;
constexpr int SEARCH_SAMPLES_A_TICK       = 10;
constexpr size_t SEARCH_START_CONCURRENCY = 4;

vayu::core::CapacityConfig search_config () {
    vayu::core::CapacityConfig config;
    config.slo_ms            = 200.0;
    config.step_duration_ms  = SEARCH_STEP_MS;
    config.start_concurrency = SEARCH_START_CONCURRENCY;
    config.max_concurrency   = 64;
    config.deadline_ms       = 60000;
    return config;
}

/// Record @p latency_ms completions into the window @p context's next tick
/// samples, or none for an idle window.
void record_window (vayu::core::RunContext& context, std::optional<double> latency_ms) {
    if (!latency_ms) {
        return;
    }
    for (int i = 0; i < SEARCH_SAMPLES_A_TICK; ++i) {
        context.metrics_collector->record_success (200, *latency_ms, 0.0);
    }
}

/// One live tick in `emit_live_tick`'s order: adopt the requested level
/// epoch, sample the window, publish the level. `LiveTicksPublishTheLevelEpoch...`
/// below holds the real producer to the same order.
void produce_tick (vayu::core::RunContext& context, std::optional<double> latency_ms) {
    record_window (context, latency_ms);
    auto& collector     = *context.metrics_collector;
    const auto statuses = collector.status_code_distribution ();
    collector.adopt_level_epoch (context.requested_level_epoch (), statuses);
    (void)collector.sample_window_percentiles ();
    context.publish_live_tick ({ 0, 100.0, 0, collector.level_latency (statuses) });
}

/// A tick the producer sampled before it saw the latest reset request.
void produce_stale_tick (vayu::core::RunContext& context, std::optional<double> latency_ms) {
    record_window (context, latency_ms);
    auto& collector = *context.metrics_collector;
    (void)collector.sample_window_percentiles ();
    context.publish_live_tick (
    { 0, 100.0, 0, collector.level_latency (collector.status_code_distribution ()) });
}

/// Record @p count failures into the window the next tick samples: 503s
/// answered in @p latency_ms, or refused connections, which record no
/// latency, when it is nullopt.
void record_failures (vayu::core::RunContext& context, int count, std::optional<double> latency_ms) {
    for (int i = 0; i < count; ++i) {
        if (latency_ms) {
            context.metrics_collector->record_success (503, *latency_ms, 0.0);
        } else {
            context.metrics_collector->record_error (
            vayu::ErrorCode::ConnectionFailed, "Connection refused");
        }
    }
}

/// Feed the open level its settle ticks, at @p settle_ms each.
void settle_level (vayu::core::CapacitySearch& search,
vayu::core::RunContext& context,
std::optional<double> settle_ms,
int64_t elapsed_ms) {
    for (size_t i = 0; i < vayu::core::constants::capacity::SETTLE_TICKS; ++i) {
        produce_tick (context, settle_ms);
        ASSERT_TRUE (search.advance (elapsed_ms));
    }
}

/// Open the first level and feed it its settle ticks, at @p settle_ms each.
void settle_first_level (vayu::core::CapacitySearch& search,
vayu::core::RunContext& context,
std::optional<double> settle_ms) {
    ASSERT_TRUE (search.advance (0));
    ASSERT_EQ (search.level (), SEARCH_START_CONCURRENCY);
    settle_level (search, context, settle_ms, 1);
}

/// Ten counted ticks of the open level, each `SEARCH_SAMPLES_A_TICK` answers at
/// @p latency_ms plus @p failures 503s answered as fast.
void feed_level (vayu::core::CapacitySearch& search,
vayu::core::RunContext& context,
double latency_ms,
int failures,
int64_t elapsed_ms) {
    for (int window = 0; window < 10; ++window) {
        record_failures (context, failures, latency_ms);
        produce_tick (context, latency_ms);
        ASSERT_TRUE (search.advance (elapsed_ms));
    }
}

} // namespace

// The issue's level: 10 of 100 windows at 300 ms, 90 at 50 ms, against a
// 200 ms SLO. Its p99 is 300 ms and it breaches; the mean of its window p99s,
// which the search used to judge on, is 75 ms and would have passed it.
// Mutation-check: reset the level histogram before every window, so the level
// is judged on its last window, and this reads 50 ms and steps up.
TEST (CapacitySearchTest, ABimodalLevelIsJudgedOnItsOwnP99) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "capacity-search-bimodal", nlohmann::json::object ());
    vayu::core::CapacitySearch search (search_config (), context);
    settle_first_level (search, *context, 50.0);

    constexpr int WINDOWS    = 100;
    constexpr int SLOW_EVERY = 10;
    for (int window = 0; window < WINDOWS; ++window) {
        produce_tick (*context, window % SLOW_EVERY == 0 ? 300.0 : 50.0);
        ASSERT_TRUE (search.advance (2));
    }
    ASSERT_TRUE (search.advance (SEARCH_STEP_MS));

    const auto summary = search.finish ();
    ASSERT_EQ (summary.levels.size (), 1u);
    EXPECT_EQ (summary.levels.front ().concurrency, SEARCH_START_CONCURRENCY);
    EXPECT_NEAR (summary.levels.front ().p99_ms, 300.0, 0.3);
    EXPECT_EQ (search.level (), SEARCH_START_CONCURRENCY)
    << "a level that breached its SLO once is held and re-measured";
}

// #2815: a level answering in 20 ms against a 200 ms SLO, with one completion
// in three a 503, is judged on its errors: held and re-measured.
// Mutation-check: stop copying the tick's error share in collect_tick and the
// level reads 0% and steps up.
TEST (CapacitySearchTest, AFastLevelWithAFailingShareIsJudgedOnItsErrors) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "capacity-search-errors", nlohmann::json::object ());
    vayu::core::CapacitySearch search (search_config (), context);
    settle_first_level (search, *context, 20.0);

    feed_level (search, *context, 20.0, SEARCH_SAMPLES_A_TICK / 2, 2);
    ASSERT_TRUE (search.advance (SEARCH_STEP_MS));

    const auto summary = search.finish ();
    ASSERT_EQ (summary.levels.size (), 1u);
    EXPECT_NEAR (summary.levels.front ().p99_ms, 20.0, 0.02);
    EXPECT_NEAR (summary.levels.front ().error_pct, 100.0 / 3.0, 0.01);
    // #2926: the row carries the completions its p99 was read from - ten
    // counted ticks of five 503s and ten answers, each timed.
    // Mutation-check: drop `level_samples_` from the history push and this
    // reads 0.
    EXPECT_EQ (summary.levels.front ().samples,
    10u * (SEARCH_SAMPLES_A_TICK + (SEARCH_SAMPLES_A_TICK / 2)));
    EXPECT_EQ (search.level (), SEARCH_START_CONCURRENCY)
    << "a level over its error limit once is held and re-measured";
}

// The re-measure of a held level counts its own failures only: a clean
// re-measure after a failing window steps up rather than stopping.
// Mutation-check: drop the baseline in adopt_level_epoch and the re-measure
// reads the first window's 503s, breaches again and stops errors_exceeded.
TEST (CapacitySearchTest, APreviousLevelsFailuresDoNotReachTheNext) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "capacity-search-error-baseline", nlohmann::json::object ());
    vayu::core::CapacitySearch search (search_config (), context);
    settle_first_level (search, *context, 20.0);
    feed_level (search, *context, 20.0, SEARCH_SAMPLES_A_TICK / 2, 2);
    ASSERT_TRUE (search.advance (SEARCH_STEP_MS));
    ASSERT_EQ (search.level (), SEARCH_START_CONCURRENCY);

    settle_level (search, *context, 20.0, SEARCH_STEP_MS + 1);
    feed_level (search, *context, 20.0, 0, SEARCH_STEP_MS + 2);
    ASSERT_TRUE (search.advance (2 * SEARCH_STEP_MS));

    const auto summary = search.finish ();
    ASSERT_EQ (summary.levels.size (), 2u);
    EXPECT_DOUBLE_EQ (summary.levels.back ().error_pct, 0.0);
    EXPECT_GT (search.level (), SEARCH_START_CONCURRENCY);
}

// A level of nothing but refused connections records no latency at all, and
// is still judged: on its errors, at 100%.
// Mutation-check: gate judging on `level_samples_ == 0` alone and the level
// never closes.
TEST (CapacitySearchTest, ALevelOfOnlyRefusedConnectionsStillCloses) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "capacity-search-refused", nlohmann::json::object ());
    vayu::core::CapacitySearch search (search_config (), context);
    settle_first_level (search, *context, std::nullopt);

    for (int window = 0; window < 10; ++window) {
        record_failures (*context, SEARCH_SAMPLES_A_TICK, std::nullopt);
        produce_tick (*context, std::nullopt);
        ASSERT_TRUE (search.advance (2));
    }
    ASSERT_TRUE (search.advance (SEARCH_STEP_MS));

    const auto summary = search.finish ();
    ASSERT_EQ (summary.levels.size (), 1u);
    EXPECT_DOUBLE_EQ (summary.levels.front ().error_pct, 100.0);
    EXPECT_DOUBLE_EQ (summary.levels.front ().p99_ms, 0.0);
    EXPECT_EQ (summary.levels.front ().samples, 0u)
    << "the 0 p99 measured nothing, and the row says so (#2926)";
    EXPECT_EQ (search.level (), SEARCH_START_CONCURRENCY);
}

// #2815: the producer's status snapshot can predate the window it samples, so
// a tick can carry latency samples while the level has counted no completion.
// That reads as a 0% error share, and a level failing every request is not
// judged on it: it stays open until the count arrives, then breaches at 100%.
// Mutation-check: drop the `level_completed_ == 0` condition in advance and
// the level is judged at 0% errors and steps up.
TEST (CapacitySearchTest, ALevelWithSamplesButNoCountedCompletionStaysOpen) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "capacity-search-lagging-count", nlohmann::json::object ());
    vayu::core::CapacitySearch search (search_config (), context);
    settle_first_level (search, *context, 20.0);

    auto& collector           = *context->metrics_collector;
    const auto stale_statuses = collector.status_code_distribution ();
    record_failures (*context, SEARCH_SAMPLES_A_TICK, 20.0);
    collector.adopt_level_epoch (context->requested_level_epoch (), stale_statuses);
    (void)collector.sample_window_percentiles ();
    const auto lagging = collector.level_latency (stale_statuses);
    ASSERT_GT (lagging.samples, 0u);
    ASSERT_EQ (lagging.completed, 0u);
    context->publish_live_tick ({ 0, 100.0, 0, lagging });

    ASSERT_TRUE (search.advance (SEARCH_STEP_MS));
    EXPECT_TRUE (search.finish ().levels.empty ())
    << "the level was judged before any completion was counted";

    record_failures (*context, SEARCH_SAMPLES_A_TICK, 20.0);
    produce_tick (*context, std::nullopt);
    ASSERT_TRUE (search.advance (SEARCH_STEP_MS + 1));
    const auto summary = search.finish ();
    ASSERT_EQ (summary.levels.size (), 1u);
    EXPECT_DOUBLE_EQ (summary.levels.front ().error_pct, 100.0);
    EXPECT_EQ (search.level (), SEARCH_START_CONCURRENCY);
}

// The settle ticks measure the transition into the level, so 1000 ms there
// must not reach a level that answers in 50 ms.
// Mutation-check: request the level reset in open_level instead of on the
// last settle tick and the level reads 1000 ms and breaches.
TEST (CapacitySearchTest, SlowSettleTicksDoNotReachTheLevel) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "capacity-search-settle", nlohmann::json::object ());
    vayu::core::CapacitySearch search (search_config (), context);
    settle_first_level (search, *context, 1000.0);

    for (int window = 0; window < 10; ++window) {
        produce_tick (*context, 50.0);
        ASSERT_TRUE (search.advance (2));
    }
    ASSERT_TRUE (search.advance (SEARCH_STEP_MS));

    const auto summary = search.finish ();
    ASSERT_EQ (summary.levels.size (), 1u);
    EXPECT_NEAR (summary.levels.front ().p99_ms, 50.0, 0.05);
    EXPECT_GT (search.level (), SEARCH_START_CONCURRENCY)
    << "a level inside its SLO steps up";
}

// The reset is requested on the strategy thread and applied on the metrics
// thread at its next tick, so a tick can land in between still carrying the
// settle ticks' histogram. That tick is not the level.
// Mutation-check: drop the epoch comparison in collect_tick and the stale
// tick's 1000 ms is judged as the level.
TEST (CapacitySearchTest, ATickProducedBeforeTheResetIsNotReadAsTheLevel) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "capacity-search-stale", nlohmann::json::object ());
    vayu::core::CapacitySearch search (search_config (), context);
    settle_first_level (search, *context, 1000.0);

    produce_stale_tick (*context, 1000.0);
    ASSERT_TRUE (search.advance (SEARCH_STEP_MS));
    EXPECT_TRUE (search.finish ().levels.empty ())
    << "the level was judged on a tick produced before its reset";

    // Two ticks: the first under the new epoch has counted no completion yet.
    produce_tick (*context, 50.0);
    produce_tick (*context, 50.0);
    ASSERT_TRUE (search.advance (SEARCH_STEP_MS + 1));
    const auto summary = search.finish ();
    ASSERT_EQ (summary.levels.size (), 1u);
    EXPECT_NEAR (summary.levels.front ().p99_ms, 50.0, 0.05);
}

// A level whose histogram holds no completion stays open rather than reading
// as a service that answered instantly.
// Mutation-check: drop the nothing-measured guard in advance and the
// level is judged at 0 ms.
TEST (CapacitySearchTest, ALevelWithNoCompletionsStaysOpen) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "capacity-search-idle", nlohmann::json::object ());
    vayu::core::CapacitySearch search (search_config (), context);
    settle_first_level (search, *context, 50.0);

    for (int window = 0; window < 10; ++window) {
        produce_tick (*context, std::nullopt);
        ASSERT_TRUE (search.advance (2));
    }
    ASSERT_TRUE (search.advance (SEARCH_STEP_MS));
    EXPECT_TRUE (search.finish ().levels.empty ());
    EXPECT_EQ (search.level (), SEARCH_START_CONCURRENCY);
}

// The real producer: `collect_metrics` adopts the requested epoch before it
// samples, and publishes the level under it. Completions recorded before the
// request belong to the previous level.
// Mutation-check: drop the `adopt_level_epoch` call in emit_live_tick and the
// wait for the requested epoch times out; pass it an empty distribution instead
// of the tick's and the new level counts the previous one's 10 requests.
TEST_F (LoadStrategyTest, LiveTicksPublishTheLevelEpochTheStrategyRequested) {
    vayu::db::Database db (TEST_DB_PATH);
    auto context = std::make_shared<vayu::core::RunContext> (
    "run-level-epoch", nlohmann::json::object ());
    auto& collector = *context->metrics_collector;
    for (int i = 0; i < 10; ++i) {
        collector.record_success (200, 500.0, 0.0);
    }

    context->is_running = true;
    std::thread metrics (
    [context, &db] () { vayu::core::collect_metrics (context, &db); });

    const auto level = [&context] () {
        return context->latest_live_tick ()
        .value_or (vayu::core::RunContext::LiveTick{})
        .level;
    };
    EXPECT_TRUE (
    vayu::tests::wait_until ([&] () { return level ().samples == 10; }))
    << "the producer never published the first level";

    const uint64_t epoch = context->request_level_reset ();
    EXPECT_TRUE (
    vayu::tests::wait_until ([&] () { return level ().epoch == epoch; }))
    << "the producer never adopted the requested epoch";
    EXPECT_EQ (level ().samples, 0u) << "the new level kept the previous one";
    EXPECT_EQ (level ().completed, 0u)
    << "the new level counted the previous one";

    for (int i = 0; i < 4; ++i) {
        collector.record_success (200, 20.0, 0.0);
    }
    collector.record_success (503, 20.0, 0.0);
    EXPECT_TRUE (vayu::tests::wait_until ([&] () {
        const auto now = level ();
        return now.samples == 5 && now.completed == 5;
    }))
    << "the new level never saw its completions";
    EXPECT_EQ (level ().epoch, epoch);
    EXPECT_NEAR (level ().p99_ms, 20.0, 0.02);
    EXPECT_EQ (level ().failed, 1u);

    context->is_running = false;
    metrics.join ();
}

namespace {

/// `collect_metrics` on its own thread for the life of the object: the live
/// producer a load run starts, with the test thread as the strategy thread.
/// Stopped in the destructor too, so a failed `ASSERT` cannot leave the
/// thread joinable.
class LiveProducer {
    public:
    LiveProducer (std::shared_ptr<vayu::core::RunContext> context, vayu::db::Database& db)
    : context_ (std::move (context)) {
        context_->is_running = true;
        thread_              = std::thread ([context = context_, &db] () {
            vayu::core::collect_metrics (context, &db);
        });
    }
    ~LiveProducer () {
        try {
            stop ();
        } catch (const std::exception& e) {
            ADD_FAILURE () << "the live producer did not stop: " << e.what ();
        }
    }
    LiveProducer (const LiveProducer&)            = delete;
    LiveProducer& operator= (const LiveProducer&) = delete;
    LiveProducer (LiveProducer&&)                 = delete;
    LiveProducer& operator= (LiveProducer&&)      = delete;

    /// End the loop and wait for its final frame.
    void stop () {
        context_->is_running = false;
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }

    private:
    std::shared_ptr<vayu::core::RunContext> context_;
    std::thread thread_;
};

/// Every live frame @p context holds, each one's `data:` line parsed.
std::vector<nlohmann::json> live_frames (const vayu::core::RunContext& context) {
    constexpr std::string_view data_field = "data: ";
    std::vector<nlohmann::json> frames;
    for (const std::string_view payload : context.ticks_since (0).payloads) {
        const auto data_at = payload.find (data_field);
        if (data_at == std::string_view::npos) {
            ADD_FAILURE () << "not an SSE data frame: " << payload;
            continue;
        }
        const auto json_at = data_at + data_field.size ();
        frames.push_back (nlohmann::json::parse (
        payload.substr (json_at, payload.find ('\n', json_at) - json_at)));
    }
    return frames;
}

/// The newest live frame's `capacity` block, or an empty object when it has
/// none, so a caller reads its default instead of throwing.
nlohmann::json newest_capacity_block (const vayu::core::RunContext& context) {
    const auto frames = live_frames (context);
    if (frames.empty ()) {
        return nlohmann::json::object ();
    }
    return frames.back ().contains ("capacity") ?
    frames.back ().at ("capacity") :
    nlohmann::json::object ();
}

/// A `capacity` block's numeric member, 0 when it has not got one. Read with
/// `at` and `get`: GCC 13 at -O3 rejects `json::value` on a number here under
/// -Werror=null-dereference.
size_t block_count (const nlohmann::json& block, const char* key) {
    return block.contains (key) ? block.at (key).get<size_t> () : 0;
}

} // namespace

// #2928: a capacity run's frames say where the search stands, from tick 0
// (before any level opens) to a user's stop, against the real producer.
// Mutation-check: drop the `publish_progress` call in open_level and the wait
// for a judged level times out; drop the one in finish and the final frame
// names no stop reason.
TEST_F (LoadStrategyTest, LiveFramesCarryTheCapacitySearchState) {
    vayu::db::Database db (TEST_DB_PATH);
    auto context = std::make_shared<vayu::core::RunContext> (
    "run-capacity-frame", nlohmann::json{ { "mode", "capacity" } });
    vayu::core::CapacitySearch search (search_config (), context);
    LiveProducer producer (context, db);

    ASSERT_TRUE (vayu::tests::wait_until (
    [&] () { return !newest_capacity_block (*context).empty (); }))
    << "tick 0 carried no capacity block";
    EXPECT_EQ (live_frames (*context).front ().at ("capacity"),
    (nlohmann::json{ { "level", 0 }, { "levelElapsedMs", 0 }, { "levelsJudged", 0 } }))
    << "tick 0 is emitted before the first level opens";

    ASSERT_TRUE (search.advance (0));
    const size_t first_level = search.level ();
    auto& collector          = *context->metrics_collector;
    // Each poll answers one more request and advances the search past its
    // step, so the level is judged on the first counted tick that saw one.
    ASSERT_TRUE (vayu::tests::wait_until ([&] () {
        collector.record_success (200, 20.0, 0.0);
        (void)search.advance (SEARCH_STEP_MS);
        return block_count (newest_capacity_block (*context), "levelsJudged") == 1;
    }))
    << "no frame counted the judged level: "
    << newest_capacity_block (*context).dump ();

    const auto live = newest_capacity_block (*context);
    EXPECT_NE (search.level (), first_level)
    << "the judged level was not replaced";
    EXPECT_EQ (live.at ("level").get<size_t> (), search.level ())
    << "the frame paired the judged count with another level";
    EXPECT_TRUE (live.at ("levelElapsedMs").is_number_integer ()) << live.dump ();
    EXPECT_FALSE (live.contains ("stopReason"))
    << "a live search has no stop reason: " << live.dump ();

    context->request_stop ();
    const auto summary = search.finish ();
    producer.stop ();

    EXPECT_EQ (summary.stop_reason, vayu::core::capacity_stop::STOPPED);
    const auto last = newest_capacity_block (*context);
    EXPECT_EQ (last.at ("stopReason").get<std::string> (), summary.stop_reason)
    << "the final frame and the report disagree on why the search stopped: "
    << last.dump ();
    EXPECT_EQ (block_count (last, "levelsJudged"), 1U);
}

// A search that ends itself publishes its own reason, here the deadline.
// Mutation-check: drop the `publish_progress` call in finish and the final
// frame names no reason.
TEST_F (LoadStrategyTest, TheFinalFrameCarriesTheSearchsOwnStopReason) {
    vayu::db::Database db (TEST_DB_PATH);
    auto context = std::make_shared<vayu::core::RunContext> (
    "run-capacity-deadline-frame", nlohmann::json{ { "mode", "capacity" } });
    const auto config = search_config ();
    vayu::core::CapacitySearch search (config, context);
    LiveProducer producer (context, db);

    ASSERT_TRUE (search.advance (0));
    EXPECT_FALSE (search.advance (config.deadline_ms));
    const auto summary = search.finish ();
    producer.stop ();

    EXPECT_EQ (summary.stop_reason, vayu::core::capacity_stop::DEADLINE);
    const auto last = newest_capacity_block (*context);
    EXPECT_EQ (last.at ("stopReason").get<std::string> (), vayu::core::capacity_stop::DEADLINE)
    << last.dump ();
    EXPECT_EQ (block_count (last, "level"), SEARCH_START_CONCURRENCY);
}

// Every other run's frames carry no `capacity` key at all, rather than a
// zeroed one a reader would take for a search at level 0.
// Mutation-check: emit the block whatever the mode and this fails.
TEST_F (LoadStrategyTest, OnlyACapacityRunsFramesCarryTheCapacityBlock) {
    vayu::db::Database db (TEST_DB_PATH);
    auto context = std::make_shared<vayu::core::RunContext> (
    "run-not-capacity-frame", nlohmann::json{ { "mode", "constant_concurrency" } });
    LiveProducer producer (context, db);
    EXPECT_TRUE (vayu::tests::wait_until (
    [&] () { return context->ticks_since (0).payloads.size () >= 3; }))
    << "the producer never emitted three frames";
    producer.stop ();

    const auto frames = live_frames (*context);
    ASSERT_GE (frames.size (), 3u);
    for (const auto& frame : frames) {
        EXPECT_FALSE (frame.contains ("capacity")) << frame.dump ();
    }
}

TEST (RunsCapacitySearch, IsTrueOnlyForTheCapacityMode) {
    using vayu::core::runs_capacity_search;
    EXPECT_TRUE (runs_capacity_search ({ { "mode", "capacity" } }));
    for (const char* mode :
    { "constant_rps", "constant_concurrency", "ramp_up", "iterations", "legacy" }) {
        EXPECT_FALSE (runs_capacity_search ({ { "mode", mode } })) << mode;
    }
    EXPECT_FALSE (runs_capacity_search (nlohmann::json::object ()));
    EXPECT_FALSE (runs_capacity_search ({ { "mode", 5 } }))
    << "a mode that is not a string is not a capacity run, and does not throw";
}
