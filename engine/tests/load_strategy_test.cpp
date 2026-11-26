/**
 * @file load_strategy_test.cpp
 * @brief Tests for load strategies, focused on the maxInFlight cap.
 *
 * The maxInFlight cap, the dropped_requests counter, and the ramp
 * backpressure signal must gate on TRUE in-flight requests
 * (requests_sent - completed), not on EventLoop::pending_count() (the
 * submission-queue depth, which workers drain to ~0). When the event loop
 * has ample worker capacity (max_concurrent / max_per_host well above the
 * cap), the submission queue stays drained while real in-flight climbs, so
 * a pending_count()-based cap never fires.
 *
 * This file holds the closed-loop strategies, error and cancellation accounting,
 * latency recording and deadlines; rate pacing and capture are in
 * `load_strategy_pacing_test.cpp`, the capacity search in `load_strategy_capacity_test.cpp`
 * and request elements in `load_strategy_elements_test.cpp`.
 *
 * The `LoadStrategyTest` fixture is in `load_strategy_fixture.hpp`.
 */

#include "optional_assert.hpp"
#include "vayu/core/load_pacing.hpp"
#include "vayu/core/load_strategy.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <string>
#include <thread>
#include <utility>

#include "echo_server.hpp"
#include "load_start_stamp.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/routes.hpp"
#include "wait_until.hpp"

#include "load_strategy_fixture.hpp"

using vayu::tests::load_strategy::LoadStrategyTest;
using vayu::tests::load_strategy::TEST_DB_PATH;
using vayu::tests::load_strategy::timed_out_response;

// At 300 RPS against a 500ms endpoint with maxInFlight=10, true in-flight
// climbs well past 10 within the first ~33ms (nothing completes until
// t≈500ms). With the event loop given far more worker capacity than the
// cap (max_concurrent / max_per_host = 2000), the submission queue stays
// drained, so a pending_count()-based cap would never fire and zero drops
// would be recorded. A correct in-flight-based cap records many drops.
TEST_F (LoadStrategyTest, MaxInFlightCapDropsWhenTrueInFlightExceedsCap) {
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "duration", "2s" },
        { "targetRps", 300.0 },
        { "maxInFlight", 10 },
    };

    auto context = std::make_shared<vayu::core::RunContext> ("test-inflight", config);

    // Generous worker capacity so the submission queue (pending_count) stays
    // drained while true in-flight climbs past the cap.
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->slow_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);

    auto strategy = vayu::core::LoadStrategy::create (config);
    ASSERT_NE (strategy, nullptr);

    // Runs synchronously on this thread for the full 2s duration.
    strategy->execute (context, db, request);

    context->event_loop->stop (false);

    EXPECT_GT (context->metrics_collector->dropped_requests (), 0u)
    << "maxInFlight cap did not drop any requests; the cap is likely gated on "
       "EventLoop::pending_count() (submission-queue depth) instead of true "
       "in-flight (requests_sent - completed)";
    // The peak counts what was submitted, never what the cap dropped: ten are
    // in flight within ~33ms and none settles before 500ms (#2912).
    EXPECT_EQ (context->peak_in_flight.load (), 10u);
}

// RunContext exposes the closed-loop refill primitives and a peak gauge.
TEST_F (LoadStrategyTest, RunContextHasRefillPrimitives) {
    nlohmann::json config = { { "mode", "constant_concurrency" } };
    auto context = std::make_shared<vayu::core::RunContext> ("test-ctx", config);

    EXPECT_EQ (context->peak_in_flight.load (), 0u);
    EXPECT_FALSE (context->closed_loop.load ());

    // notify_refill must be safe to call with no waiter (near-free no-op).
    context->notify_refill ();
    SUCCEED ();
}

// Closed-loop: constant_concurrency N=50 against a 500ms endpoint must hold
// ~50 in flight, NOT climb to the old ~900. peak_in_flight is the ground truth.
TEST_F (LoadStrategyTest, ConstantConcurrencyHoldsTargetInFlight) {
    const size_t N        = 50;
    nlohmann::json config = {
        { "mode", "constant_concurrency" },
        { "duration", "2s" },
        { "concurrency", N },
    };

    auto context = std::make_shared<vayu::core::RunContext> ("test-cc", config);

    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000; // ample, so only the controller bounds N
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->slow_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    ASSERT_NE (strategy, nullptr);

    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    // Peak must stay near N (allow a small epsilon for worker scheduling slop),
    // NOT the ~900 the old open-loop batch submitter produced.
    EXPECT_LE (context->peak_in_flight.load (), N + 10)
    << "in-flight exceeded target+epsilon; closed-loop refill not holding N";
    EXPECT_GE (context->peak_in_flight.load (), N - 5)
    << "never reached target; seeding/refill under-submitting";
}

// Closed-loop ramp: in-flight tracks the ramp line and never overshoots target.
TEST_F (LoadStrategyTest, RampUpTracksTargetWithoutOvershoot) {
    const size_t TARGET   = 50;
    nlohmann::json config = {
        { "mode", "ramp_up" },
        { "duration", "3s" },
        { "rampUpDuration", "2s" },
        { "startConcurrency", 1 },
        { "concurrency", TARGET },
    };

    auto context = std::make_shared<vayu::core::RunContext> ("test-ramp", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->slow_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    // After a full ramp to TARGET, peak settles at ~TARGET, never far above.
    EXPECT_LE (context->peak_in_flight.load (), TARGET + 10);
    EXPECT_GE (context->peak_in_flight.load (), TARGET - 5);
}

// #2913: a run as long as its ramp peaks at the configured count. `/hang`
// answers nothing while the run lasts, so in-flight only climbs and the peak
// is what the controller submitted, with no completion to race it. The
// controller's final refill (`MaintainConcurrency` below) is what holds this
// when no wake lands in the ramp's last tick.
TEST_F (LoadStrategyTest, ARampAsLongAsTheRunPeaksAtTheConfiguredCount) {
    const size_t TARGET   = 50;
    nlohmann::json config = {
        { "mode", "ramp_up" },
        { "duration", "2s" },
        { "rampUpDuration", "2s" },
        { "startConcurrency", 1 },
        { "concurrency", TARGET },
    };

    auto context = std::make_shared<vayu::core::RunContext> ("test-ramp-equal", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->hang_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    ASSERT_NE (strategy, nullptr);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    EXPECT_EQ (context->peak_in_flight.load (), TARGET);
}

// #3567: a submission is in flight from `open_request` until its completion
// closes it, and a Stop's cancellation is a completion. `/hang` answers
// nothing, so while the run holds its users every one is open and the
// integral grows by the open count per millisecond; once `stop (false)` has
// cancelled them it stops growing. Mutation check: close only a result that
// is not an error in `submit_to_loop`'s callback and the integral still grows
// after the stop.
TEST_F (LoadStrategyTest, AStopsCancellationClosesEveryOpenRequest) {
    const size_t USERS    = 4;
    nlohmann::json config = { { "mode", "constant_concurrency" },
        { "duration", "300ms" }, { "concurrency", USERS } };
    auto context = std::make_shared<vayu::core::RunContext> ("test-open-cancel", config);
    context->event_loop = std::make_unique<vayu::http::EventLoop> ();
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->hang_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    ASSERT_NE (strategy, nullptr);
    strategy->execute (context, db, request);

    const auto& mc    = *context->metrics_collector;
    const int64_t now = vayu::tests::steady_now_ms ();
    const auto open   = static_cast<int64_t> (context->requests_sent.load ());
    ASSERT_EQ (open, static_cast<int64_t> (USERS))
    << "the users never all sent";
    EXPECT_EQ (mc.inflight_integral_ms (now + 1000) - mc.inflight_integral_ms (now),
    1000 * open);

    context->event_loop->stop (false);
    const int64_t after = vayu::tests::steady_now_ms ();
    EXPECT_GT (mc.inflight_integral_ms (after), 0);
    EXPECT_EQ (mc.inflight_integral_ms (after + 60'000), mc.inflight_integral_ms (after))
    << "a cancelled request is still open";
}

namespace {

constexpr size_t FINAL_REFILL_START   = 1;
constexpr size_t FINAL_REFILL_TARGET  = 50;
constexpr int64_t FINAL_REFILL_RUN_MS = 200;

/// A `submit_one` that sends nothing: it counts, and bumps `requests_sent` the
/// way a real submission does. Unless @p settles, nothing it submits ever
/// completes, so `in_flight ()` is exactly what the controller has submitted;
/// with it, each submission settles as it is made (as a cancellation, the
/// cheapest settle `in_flight ()` reads), so every wake finds the whole target
/// completed. The first call (the seed's) sleeps out the whole run and then
/// runs @p after_seed, so the controller's first wake already reads the run as
/// over: no wake lands in the ramp at all. A sleep only bounds elapsed time
/// from below, so a slower runner reaches the same state.
struct CountingSubmitter {
    std::shared_ptr<vayu::core::RunContext> context;
    std::function<void ()> after_seed;
    bool settles     = false;
    size_t submitted = 0;

    bool operator() () {
        if (submitted == 0) {
            std::this_thread::sleep_for (std::chrono::milliseconds (FINAL_REFILL_RUN_MS));
            if (after_seed) {
                after_seed ();
            }
        }
        ++submitted;
        ++context->requests_sent;
        if (settles) {
            context->metrics_collector->record_cancelled ();
        }
        return true;
    }
};

size_t final_refill_ramp (int64_t elapsed_ms) {
    return vayu::core::ramp_target_concurrency (
    FINAL_REFILL_START, FINAL_REFILL_TARGET, FINAL_REFILL_RUN_MS, elapsed_ms);
}

size_t final_refill_flat (int64_t) {
    return FINAL_REFILL_TARGET;
}

size_t unbounded_budget () {
    return std::numeric_limits<size_t>::max ();
}

} // namespace

// #2913: the controller reads its target only when it wakes, so a run whose
// last wake fell before the ramp's final tick ended short of the target. Here
// no wake lands inside the run, and the final refill at the run's last instant
// alone takes it to the target, and no further. Mutation check: drop the final
// refill in `maintain_concurrency` and only the seed's one is submitted.
TEST (MaintainConcurrency, ARunTheClockEndsIsRefilledToTheTargetAtItsLastInstant) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-final-refill", nlohmann::json{ { "mode", "ramp_up" } });
    CountingSubmitter submitter{ context, {} };

    vayu::core::maintain_concurrency (
    context, std::ref (submitter), final_refill_ramp, unbounded_budget,
    [] (int64_t el) { return el < FINAL_REFILL_RUN_MS; }, {}, FINAL_REFILL_RUN_MS);

    EXPECT_EQ (submitter.submitted, FINAL_REFILL_TARGET);
    EXPECT_EQ (context->peak_in_flight.load (), FINAL_REFILL_TARGET);
}

// #3545: the final refill tops a ramp up to its end target; it does not
// replace what completed during the wake that found the run over. A flat ramp
// is at its end target from the seed on, so with the whole seed completed by
// that wake it still sends nothing after the run's time is up. Mutation check:
// pass the final `refill_toward` a `SIZE_MAX` cap (the in-flight deficit, as
// before) and the seed is sent a second time.
TEST (MaintainConcurrency, AFlatRampSendsNothingAfterTheClockEndsIt) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-flat-final-refill", nlohmann::json{ { "mode", "ramp_up" } });
    CountingSubmitter submitter{ context, {}, true };

    vayu::core::maintain_concurrency (
    context, std::ref (submitter), final_refill_flat, unbounded_budget,
    [] (int64_t el) { return el < FINAL_REFILL_RUN_MS; }, {}, FINAL_REFILL_RUN_MS);

    EXPECT_EQ (submitter.submitted, FINAL_REFILL_TARGET)
    << "requests were sent after the run's duration ended";
}

// The other side of #3545: a ramp whose last refill fell short of its end
// target is topped up by that shortfall, not by its in-flight deficit, even
// when everything it sent has completed. The same mutation as above sends one
// request more.
TEST (MaintainConcurrency, AShortRampIsToppedUpByItsShortfallNotItsDeficit) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-short-final-refill", nlohmann::json{ { "mode", "ramp_up" } });
    CountingSubmitter submitter{ context, {}, true };

    vayu::core::maintain_concurrency (
    context, std::ref (submitter), final_refill_ramp, unbounded_budget,
    [] (int64_t el) { return el < FINAL_REFILL_RUN_MS; }, {}, FINAL_REFILL_RUN_MS);

    EXPECT_EQ (submitter.submitted, FINAL_REFILL_TARGET);
}

// The final refill is owed only to a run the clock ended. A loop that leaves
// on its own predicate before `run_end_ms` (an exhausted budget, say) sends
// nothing after it. Mutation check: drop the `el >= *run_end_ms` guard and
// the whole target is submitted.
TEST (MaintainConcurrency, ARunItsOwnPredicateEndsEarlyGetsNoFinalRefill) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-no-final-refill", nlohmann::json{ { "mode", "ramp_up" } });
    CountingSubmitter submitter{ context, {} };
    size_t checks = 0;

    // Run end an hour out: the predicate, never the clock, ends this loop.
    constexpr int64_t HOUR_MS = 3600000;
    vayu::core::maintain_concurrency (
    context, std::ref (submitter), final_refill_ramp, unbounded_budget,
    [&checks] (int64_t) { return checks++ == 0; }, {}, HOUR_MS);

    EXPECT_EQ (submitter.submitted, 1u);
}

// A stop owes nothing more, even once the run's end has passed.
TEST (MaintainConcurrency, AStoppedRunGetsNoFinalRefill) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-stopped-final-refill", nlohmann::json{ { "mode", "ramp_up" } });
    CountingSubmitter submitter{ context,
        [&context] () { context->request_stop (); } };

    vayu::core::maintain_concurrency (
    context, std::ref (submitter), final_refill_ramp, unbounded_budget,
    [] (int64_t el) { return el < FINAL_REFILL_RUN_MS; }, {}, FINAL_REFILL_RUN_MS);

    EXPECT_EQ (submitter.submitted, 1u);
}

// Behavior-change check: duration < ramp runs a partial ramp for the full
// duration and submits requests (old open-loop code finished instantly with 0).
TEST_F (LoadStrategyTest, RampUpDurationShorterThanRampStillRuns) {
    nlohmann::json config = {
        { "mode", "ramp_up" },
        { "duration", "1s" },
        { "rampUpDuration", "10s" },
        { "startConcurrency", 1 },
        { "concurrency", 50 },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-ramp-short", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    EXPECT_GT (context->requests_sent.load (), 0u)
    << "duration<ramp submitted nothing; partial-ramp behavior not implemented";
}

// --- A rate selects nothing outside `constant_rps` (#2396) -----------------
//
// The route refuses a rate on any other mode; these hold the executors for a
// config that reaches them anyway (a stored or hand-built one).

// The rate-limited path never sets `closed_loop` and sets `requests_expected`
// to rate x duration. Mutation check: switch `ConstantLoadStrategy` on
// `requested_rps` again and both expectations fail.
TEST_F (LoadStrategyTest, ConstantConcurrencyCarryingARateStaysClosedLoop) {
    const nlohmann::json config = { { "mode", "constant_concurrency" },
        { "duration", "300ms" }, { "concurrency", 2 }, { "targetRps", 100.0 } };
    auto context = std::make_shared<vayu::core::RunContext> ("test-cc-rate", config);
    vayu::http::EventLoopConfig loop_config;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    EXPECT_TRUE (context->closed_loop.load ()) << "ran the open-loop path";
    EXPECT_EQ (context->requests_expected.load (), 0u)
    << "ran the open-loop path";
    EXPECT_GT (context->requests_sent.load (), 0u);
}

// The open-loop pacer records the in-flight high-water mark itself (#2912),
// not only through the 1 Hz sample, which a direct `execute` never starts.
// At 100 RPS against a target that holds every answer 500ms, nothing settles
// for the first 500ms, so ~50 are in flight at every submission after that,
// however slow the runner (a late tick submits its backlog at once). Healthy
// reads ~50, broken reads 0; 25 sits between. Mutation check: drop the
// `update_peak` call in `submit_due` and this reads 0.
TEST_F (LoadStrategyTest, ConstantRpsRecordsPeakInFlightAtSubmission) {
    const nlohmann::json config = { { "mode", "constant_rps" },
        { "duration", "1s" }, { "targetRps", 100.0 } };
    auto context = std::make_shared<vayu::core::RunContext> ("test-rps-peak", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->slow_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    ASSERT_NE (strategy, nullptr);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    EXPECT_FALSE (context->closed_loop.load ()) << "ran the closed-loop path";
    EXPECT_GE (context->peak_in_flight.load (), 25u)
    << "constant_rps left peakConcurrency to the 1 Hz sample";
}

// A single-request load run's token-free fast path (issue #1540) never
// copies the request per submission (issue #992), so it cannot re-scan for
// an unresolved `{{token}}` the way the copying branch does at line ~445 of
// load_strategy.cpp. `start_run` scans once instead and hands the names down
// through `RunContext::load_unresolved_tokens`, which this test sets
// directly since it drives the strategy without going through `start_run`.
// Mutation check: remove the `record_unresolved_token` call from the fast
// path in `submit_one_request` and this reds, because nothing else on that
// branch ever looks at the field.
TEST_F (LoadStrategyTest, FastPathWithAnUnresolvedTokenCountsAndWarnsWithoutRefusingTheRun) {
    const size_t M        = 5;
    nlohmann::json config = {
        { "mode", "iterations" },
        { "iterations", M },
        { "concurrency", 1 },
    };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-fastpath-unresolved", config);
    context->load_unresolved_tokens = { "missing" };
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url () + "?token={{missing}}";
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    ASSERT_EQ (context->requests_sent.load (), M);
    EXPECT_EQ (context->metrics_collector->unresolved_token_requests (), M)
    << "the fast path sends the same unresolved bytes on every submission";
    const auto names = context->metrics_collector->unresolved_token_names ();
    ASSERT_EQ (names.size (), 1u);
    EXPECT_EQ (names[0], "missing");
}

// Issue #1765: the shared-request fast path settles a waiting path value
// once, and with `disableUrlEncoding` it goes on the wire as typed. Read off
// the server's own record of the target. Mutation check: make
// `settle_path_variables` ignore the flag and the target reads
// `/echo/u/a%22b/c`.
TEST_F (LoadStrategyTest, TheFastPathSendsAPathValueAsTypedWhenUrlEncodingIsOff) {
    vayu::tests::EchoServer echo;
    nlohmann::json config = {
        { "mode", "iterations" },
        { "iterations", 1 },
        { "concurrency", 1 },
    };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-fastpath-raw-path", config);
    vayu::http::EventLoopConfig loop_config;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method               = vayu::HttpMethod::GET;
    request.url                  = echo.url () + "/u/:id";
    request.timeout_ms           = 30000;
    request.disable_url_encoding = true;
    request.path_variables       = { { "id", "a\"b/c" } };

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    // Drained, not cancelled: `execute` returns once the iteration is
    // submitted, and a cancelled transfer under a loaded `ctest -j` can
    // leave before the echo server records a target at all.
    context->event_loop->stop (true);

    ASSERT_EQ (context->requests_sent.load (), 1u);
    EXPECT_EQ (echo.target (), "/echo/u/a\"b/c");
}

// The companion shapes: `load_unresolved_tokens` left empty (a request
// resolved cleanly, or carries only a reserved name like `{{$vu}}`, which
// `start_run` never puts in the set) records nothing on the fast path.
TEST_F (LoadStrategyTest, FastPathWithNoUnresolvedTokenRecordsNoWarning) {
    nlohmann::json config = {
        { "mode", "iterations" },
        { "iterations", 3 },
        { "concurrency", 1 },
    };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-fastpath-clean", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url () + "?vu={{$vu}}";
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    EXPECT_EQ (context->metrics_collector->unresolved_token_requests (), 0u);
    EXPECT_TRUE (context->metrics_collector->unresolved_token_names ().empty ());
}

// The two cases above set `load_unresolved_tokens` directly, so neither
// exercises `RunManager::start_run` actually populating it (`run_manager.cpp`,
// beside the `load_template` build) before a real run reaches the fast path.
// This one drives a real run end to end so a regression that dropped that
// wiring - not just the fast-path record call above - fails a test.
TEST_F (LoadStrategyTest, StartRunWiresTheFastPathScanIntoARealRunsReport) {
    const size_t ITERATIONS = 3;
    vayu::db::Database db (TEST_DB_PATH);

    vayu::db::Run row;
    row.id              = "run-fastpath-wiring";
    row.type            = vayu::RunType::Load;
    row.status          = vayu::RunStatus::Pending;
    row.config_snapshot = "{}";
    row.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                     .count ();
    row.end_time = 0;
    db.create_run (row);

    const nlohmann::json config = { { "mode", "iterations" },
        { "iterations", ITERATIONS }, { "concurrency", 1 },
        { "url", mock_server->fast_url () + "?auth={{token}}" },
        { "method", "GET" }, { "timeout", 5000 } };

    vayu::core::RunManager run_manager;
    ASSERT_TRUE (run_manager.start_run (row.id, config, db));

    const auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (30);
    while (std::chrono::steady_clock::now () < deadline) {
        const auto stored = db.get_run (row.id);
        if (stored && stored->status != vayu::RunStatus::Running &&
        stored->status != vayu::RunStatus::Pending) {
            break;
        }
        std::this_thread::sleep_for (std::chrono::milliseconds (20));
    }
    run_manager.shutdown (std::chrono::milliseconds (15000));

    const auto stored = db.get_run (row.id);
    ASSERT_HAS_VALUE (stored);
    ASSERT_FALSE (stored->summary.empty ()) << "the run produced no summary";
    const auto summary = nlohmann::json::parse (stored->summary);
    ASSERT_TRUE (summary.contains ("warnings")) << summary.dump ();
    ASSERT_FALSE (summary["warnings"].empty ()) << summary.dump ();
    EXPECT_EQ (summary["warnings"][0]["code"], "unresolved_tokens");
    EXPECT_EQ (summary["warnings"][0]["count"], ITERATIONS);
    const auto& names = summary["warnings"][0]["names"];
    EXPECT_NE (std::find (names.begin (), names.end (), "token"), names.end ())
    << summary.dump ();
}

// Closed-loop iterations: submit exactly M, never exceed N in flight.
// N kept within the httplib test-mock thread pool so /fast completes promptly;
// stop(false) skips the drain (peak is already captured during execute).
TEST_F (LoadStrategyTest, IterationsSubmitsExactlyMAndHoldsN) {
    const size_t M        = 50;
    const size_t N        = 10;
    nlohmann::json config = {
        { "mode", "iterations" },
        { "iterations", M },
        { "concurrency", N },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-iter", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    EXPECT_EQ (context->requests_sent.load (), M) << "did not submit exactly M";
    EXPECT_LE (context->peak_in_flight.load (), N + 10)
    << "exceeded concurrency N";
}

// Fast endpoint: a fixed-interval poll would let in-flight collapse between
// polls (Option-B undershoot). The cv-wake refill must keep MEAN in-flight near
// N. Measure mean via Little's Law: mean = throughput * avg_latency_s.
TEST_F (LoadStrategyTest, FastEndpointHoldsMeanInFlight) {
    const size_t N        = 20;
    const double DUR_S    = 2.0;
    nlohmann::json config = {
        { "mode", "constant_concurrency" },
        { "duration", "2s" },
        { "concurrency", N },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-fast", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    size_t completed = context->metrics_collector->total_requests ();
    double avg_latency_s = context->metrics_collector->average_latency () / 1000.0;
    double throughput    = static_cast<double> (completed) / DUR_S;
    double mean_inflight = throughput * avg_latency_s; // Little's Law

    std::cerr << "[fast-hold] completed=" << completed
              << " avg_latency_ms=" << context->metrics_collector->average_latency ()
              << " throughput=" << throughput << " mean_inflight=" << mean_inflight
              << " peak=" << context->peak_in_flight.load () << "\n";

    // A fixed-poll refill collapses the mean to about N * latency / 50ms, under
    // 2 against a loopback server; cv-wake holds it near N. The bound sits
    // between the two: a loaded Windows runner's wake latency has measured
    // 8.0-9.4 here, so 0.5 * N failed healthy runs (do NOT delete this
    // assertion).
    EXPECT_GE (mean_inflight, 0.25 * static_cast<double> (N))
    << "mean in-flight collapsed (" << mean_inflight << "); cv-wake not refilling";
}

// Setting should_stop must end the run promptly. The controller breaks on
// should_stop (caught by its 50ms timeout even without a notify); the
// production stop paths additionally notify_refill so cancellation is immediate.
TEST_F (LoadStrategyTest, StopWakesControllerPromptly) {
    nlohmann::json config = {
        { "mode", "constant_concurrency" },
        { "duration", "60s" }, // long; we stop it early
        { "concurrency", 20 },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-stop", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);

    std::thread stopper ([context] () {
        std::this_thread::sleep_for (std::chrono::milliseconds (200));
        context->request_stop ();
    });

    auto t0 = std::chrono::steady_clock::now ();
    strategy->execute (context, db, request);
    auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - t0)
                      .count ();
    stopper.join ();
    context->event_loop->stop (false);

    EXPECT_LT (elapsed_ms, 2000)
    << "controller did not observe should_stop promptly";
}

// The collector's percentiles expose non-zero max/min; run_manager persists
// them in the run summary so /report can surface them instead of 0.
TEST_F (LoadStrategyTest, PercentilesExposeNonZeroMax) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-max", nlohmann::json{ { "mode", "constant_concurrency" } });
    context->metrics_collector->record_success (200, 10.0, 0.0);
    context->metrics_collector->record_success (200, 250.0, 0.0);
    context->metrics_collector->record_success (200, 75.0, 0.0);

    auto p = context->metrics_collector->calculate_percentiles ();
    EXPECT_GT (p.max, 0.0);
    EXPECT_GE (p.max, p.p99);
    EXPECT_GT (p.min, 0.0);
}

// Wire bytes are captured from curl and accumulated. The mock returns a fixed
// "{}" body; assert received bytes scale with request count (exact totals vary
// with headers, so assert a lower bound, not equality).
TEST_F (LoadStrategyTest, CapturesReceivedBytes) {
    nlohmann::json config = {
        { "mode", "iterations" },
        { "iterations", 20 },
        { "concurrency", 5 },
    };
    auto context = std::make_shared<vayu::core::RunContext> ("test-bytes", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();
    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url ();
    request.timeout_ms = 30000;
    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    // 20 responses, each with headers + a 2-byte body → comfortably > 20 bytes.
    EXPECT_GT (context->metrics_collector->total_bytes_received (), 20u);
}

// The persisted tick carries the collector's current cumulative values
// (dropped / bytes / status-code map). This is what collect_metrics stores each
// second; tested via the extracted payload builder for determinism.
TEST_F (LoadStrategyTest, MetricTickPayloadCarriesBytesDroppedStatus) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-tick", nlohmann::json{ { "mode", "constant_rps" } });
    auto& mc = *context->metrics_collector;
    mc.record_success (200, 5.0, 0.0, "");
    mc.record_success (404, 5.0, 0.0, "");
    mc.record_bytes (10, 1000);
    mc.record_drop_batch (3);
    mc.record_skipped_batch (2, 200.0);

    vayu::core::MetricTickSample sample;
    sample.timestamp        = 12345;
    sample.dropped_requests = mc.dropped_requests ();
    sample.skipped_requests = mc.skipped_requests ();
    sample.stalled_ms       = mc.stalled_ms ();
    sample.bytes_sent       = mc.total_bytes_sent ();
    sample.bytes_received   = mc.total_bytes_received ();
    sample.status_codes     = mc.status_code_distribution ();

    auto payload = vayu::core::build_metric_tick_payload (sample);
    EXPECT_EQ (payload["timestamp"].get<int64_t> (), 12345);
    EXPECT_EQ (payload["dropped_requests"].get<size_t> (), 3u);
    EXPECT_EQ (payload["skipped_requests"].get<size_t> (), 2u);
    EXPECT_DOUBLE_EQ (payload["stalled_ms"].get<double> (), 200.0);
    EXPECT_EQ (payload["bytes_sent"].get<size_t> (), 10u);
    EXPECT_EQ (payload["bytes_received"].get<size_t> (), 1000u);
    ASSERT_TRUE (payload["status_codes"].is_object ());
    EXPECT_EQ (payload["status_codes"]["200"].get<size_t> (), 1u);
    EXPECT_EQ (payload["status_codes"]["404"].get<size_t> (), 1u);
}

// #2136: the persisted tick carries the Stop-cancelled count beside the error
// split, which does not include it.
TEST_F (LoadStrategyTest, MetricTickPayloadCarriesTheCancelledCount) {
    vayu::core::MetricTickSample sample;
    sample.cancelled = 4;
    auto payload     = vayu::core::build_metric_tick_payload (sample);
    ASSERT_TRUE (payload.contains ("cancelled"));
    EXPECT_EQ (payload["cancelled"].get<size_t> (), 4u);
}

namespace {
/** The Error the event loop completes a cancelled transfer with. */
vayu::Result<vayu::Response> cancellation_result () {
    return vayu::Result<vayu::Response> (
    vayu::Error{ vayu::ErrorCode::Cancelled, "Request cancelled" });
}
} // namespace

// #2136: a transfer a user Stop cancelled is not an error. It is counted on
// its own, outside total_requests and the status distribution - and it still
// releases its in-flight slot, or the closed-loop controller would see a
// phantom request for every one the Stop cancelled.
TEST_F (LoadStrategyTest, StopCancelledResultIsCountedApartFromErrors) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-stop-cancelled", nlohmann::json{ { "mode", "constant_rps" } });
    vayu::db::Database db (TEST_DB_PATH);

    context->requests_sent++;
    context->request_stop ();
    vayu::core::handle_result (context, db, cancellation_result ());

    const auto& mc = *context->metrics_collector;
    EXPECT_EQ (mc.cancelled (), 1u);
    EXPECT_EQ (mc.total_errors (), 0u);
    EXPECT_EQ (mc.latency_count (), 0)
    << "a cancelled request is in no latency figure";
    EXPECT_EQ (mc.latency_samples (), 0u);
    EXPECT_EQ (context->total_requests (), 0u);
    EXPECT_EQ (context->in_flight (), 0u);
    EXPECT_TRUE (mc.status_code_distribution ().empty ())
    << "a cancelled request has no status, not status 0";
    EXPECT_TRUE (mc.errors ().empty ());

    const auto stats = mc.get_current_stats (0, 1.0, 1);
    EXPECT_EQ (stats["totalErrors"].get<size_t> (), 0u);
    EXPECT_EQ (stats["cancelled"].get<size_t> (), 1u);
    EXPECT_DOUBLE_EQ (stats["errorRate"].get<double> (), 0.0);
}

// The same result at a run's natural end is the drain deadline cancelling a
// request that never answered, and stays an error under its own type.
TEST_F (LoadStrategyTest, DrainDeadlineCancellationIsStillAnError) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-drain-cancelled", nlohmann::json{ { "mode", "constant_rps" } });
    vayu::db::Database db (TEST_DB_PATH);

    context->requests_sent++;
    vayu::core::handle_result (context, db, cancellation_result ());

    const auto& mc = *context->metrics_collector;
    EXPECT_EQ (mc.cancelled (), 0u);
    EXPECT_EQ (mc.total_errors (), 1u);
    EXPECT_EQ (mc.latency_count (), 0)
    << "an Error carries no transfer to time";
    EXPECT_EQ (context->total_requests (), 1u);
    EXPECT_EQ (context->in_flight (), 0u);
    const auto dist = mc.status_code_distribution ();
    ASSERT_EQ (dist.count (0), 1u);
    EXPECT_EQ (dist.at (0), 1u);
    ASSERT_EQ (mc.errors ().size (), 1u);
    EXPECT_NE (mc.errors ().front ().trace_data.find ("\"cancelled\""), std::string::npos);
}

// A Stop does not turn every failure into a cancellation: only the event
// loop's own cancellation is one.
TEST_F (LoadStrategyTest, OtherErrorsDuringAStopStayErrors) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-stop-other-error", nlohmann::json{ { "mode", "constant_rps" } });
    vayu::db::Database db (TEST_DB_PATH);

    context->requests_sent++;
    context->request_stop ();
    vayu::core::handle_result (context, db,
    vayu::Result<vayu::Response> (
    vayu::Error{ vayu::ErrorCode::InternalError, "Couldn't create a curl handle" }));

    EXPECT_EQ (context->metrics_collector->cancelled (), 0u);
    EXPECT_EQ (context->metrics_collector->total_errors (), 1u);
    EXPECT_EQ (context->in_flight (), 0u);
}

// A transport-level Error result (curl-handle creation failure, or the
// natural-end drain cancelling what outlived its deadline) is a real
// completion. Dropping it would leave requests_sent counted with no matching
// completion, so in_flight() would stay permanently inflated and the
// closed-loop controller would keep shrinking effective concurrency for the
// rest of the run.
TEST_F (LoadStrategyTest, TransportErrorResultIsRecordedAndClearsInFlight) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-transport-error", nlohmann::json{ { "mode", "constant_rps" } });
    vayu::db::Database db (TEST_DB_PATH);

    context->requests_sent++;
    ASSERT_EQ (context->in_flight (), 1u);

    vayu::Error error;
    error.code    = vayu::ErrorCode::InternalError;
    error.message = "Couldn't create a curl handle";
    vayu::core::handle_result (context, db, vayu::Result<vayu::Response> (error));

    EXPECT_EQ (context->metrics_collector->total_errors (), 1u);
    EXPECT_EQ (context->total_requests (), 1u);
    EXPECT_EQ (context->in_flight (), 0u);

    const auto& errors = context->metrics_collector->errors ();
    ASSERT_EQ (errors.size (), 1u);
    EXPECT_NE (errors.front ().trace_data.find ("internal_error"), std::string::npos);
    EXPECT_NE (
    errors.front ().trace_data.find ("Couldn't create a curl handle"), std::string::npos);
}

// #2462: a redirect loop and an undecodable body are stored under their own
// error_type, on both ways a failure arrives (a transport Error, and a
// Response the event loop completed with an error code); so is a peer that
// answered in another protocol (#3306) and a file the request cannot send
// (#3693). Mutation-check: drop any case from
// error_type_name and its row reads "unknown".
TEST_F (LoadStrategyTest, RedirectAndContentEncodingFailuresKeepTheirOwnErrorType) {
    const auto cases = std::to_array<std::pair<vayu::ErrorCode, const char*>> ({
    { vayu::ErrorCode::TooManyRedirects, "too_many_redirects" },
    { vayu::ErrorCode::BadContentEncoding, "bad_content_encoding" },
    { vayu::ErrorCode::ProtocolMismatch, "protocol_mismatch" },
    { vayu::ErrorCode::UnsendableFile, "unsendable_file" },
    });
    for (const auto& [code, type_name] : cases) {
        const auto error_types_after = [&] (const vayu::Result<vayu::Response>& result) {
            auto context = std::make_shared<vayu::core::RunContext> (
            "test-error-type", nlohmann::json{ { "mode", "constant_rps" } });
            vayu::db::Database db (TEST_DB_PATH);
            context->requests_sent++;
            vayu::core::handle_result (context, db, result);
            const auto& errors = context->metrics_collector->errors ();
            return errors.empty () ? std::string () : errors.front ().trace_data;
        };

        const std::string from_error =
        error_types_after (vayu::Result<vayu::Response> (vayu::Error{ code, "m" }));
        EXPECT_NE (from_error.find (std::string ("\"error_type\":\"") + type_name + "\""),
        std::string::npos)
        << from_error;

        vayu::Response response;
        response.error_code    = code;
        response.error_message = "m";
        const std::string from_response =
        error_types_after (vayu::Result<vayu::Response> (response));
        EXPECT_NE (from_response.find (std::string ("\"error_type\":\"") + type_name + "\""),
        std::string::npos)
        << from_response;
    }
}

// #2124: an HTTP 500 is a completed response, so handle_result records it as
// one (its latency counts) - and it is still an error on the live tick. The
// live count used to read only the transport counter and showed 0 here.
TEST_F (LoadStrategyTest, HttpErrorResponseMovesTheLiveFailedCount) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-http-error", nlohmann::json{ { "mode", "constant_rps" } });
    vayu::db::Database db (TEST_DB_PATH);

    context->requests_sent++;
    vayu::Response response;
    response.status_code     = 500;
    response.timing.total_ms = 12.0;
    vayu::core::handle_result (context, db, vayu::Result<vayu::Response> (response));

    EXPECT_EQ (context->in_flight (), 0u);
    EXPECT_EQ (context->metrics_collector->total_errors (), 0u)
    << "a response is not a transport failure";
    const auto stats = context->metrics_collector->get_current_stats (0, 1.0, 1);
    EXPECT_EQ (stats["totalErrors"].get<size_t> (), 1u);
    EXPECT_EQ (stats["httpErrors"].get<size_t> (), 1u);
    EXPECT_EQ (stats["noResponse"].get<size_t> (), 0u);
    EXPECT_DOUBLE_EQ (stats["errorRate"].get<double> (), 100.0);
    EXPECT_DOUBLE_EQ (stats["avgLatencyMs"].get<double> (), 12.0);
}

// #2384: a timeout is the slowest outcome a request can have, and it lands in
// the run's latency histogram at its own duration beside the answers - while
// still counting as the no-response error it is. Mutation-check: drop the
// `attempt` pass-through in record_failed_response and this fails.
TEST_F (LoadStrategyTest, ATimedOutTransferJoinsTheLatencyHistogram) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-timeout-latency", nlohmann::json{ { "mode", "constant_rps" } });
    vayu::db::Database db (TEST_DB_PATH);

    context->requests_sent++;
    vayu::core::handle_result (
    context, db, vayu::Result<vayu::Response> (timed_out_response (2000.0)));

    auto& mc = *context->metrics_collector;
    EXPECT_EQ (mc.total_errors (), 1u);
    EXPECT_EQ (context->in_flight (), 0u);
    EXPECT_EQ (mc.latency_count (), 1);
    EXPECT_DOUBLE_EQ (mc.average_latency (), 2000.0);
    EXPECT_NEAR (mc.calculate_percentiles ().max, 2000.0, 2.0);
    const auto stats = mc.get_current_stats (0, 1.0, 1);
    EXPECT_EQ (stats["noResponse"].get<size_t> (), 1u);
}

// The histogram gate is whether a transfer ran, not whether it took measurable
// time: a failure that ran and reads 0 ms (a connection refused inside the
// clock's resolution) still joins at the histogram's 1 microsecond floor, and
// the same reading from a request that never left stays out. Mutation-check:
// gate on `total_ms > 0` in record_failed_response and the first half fails.
TEST_F (LoadStrategyTest, AZeroMsFailureCountsOnlyWhenItsTransferRan) {
    const auto record = [] (bool transfer_attempted) {
        auto context = std::make_shared<vayu::core::RunContext> (
        "test-zero-ms-latency", nlohmann::json{ { "mode", "constant_rps" } });
        vayu::db::Database db (TEST_DB_PATH);

        context->requests_sent++;
        vayu::Response response     = timed_out_response (0.0);
        response.transfer_attempted = transfer_attempted;
        vayu::core::handle_result (context, db, vayu::Result<vayu::Response> (response));
        return context;
    };

    const auto ran = record (true);
    EXPECT_EQ (ran->metrics_collector->total_errors (), 1u);
    EXPECT_EQ (ran->metrics_collector->latency_count (), 1);
    EXPECT_NEAR (ran->metrics_collector->calculate_percentiles ().max, 0.001, 0.001);

    const auto refused = record (false);
    EXPECT_EQ (refused->metrics_collector->total_errors (), 1u);
    EXPECT_EQ (refused->metrics_collector->latency_count (), 0);
}

// A failure built for a request that never left - here the pre-send gate's
// `error_response` - has no duration, and stays out of every latency figure
// while still counting as an error.
TEST_F (LoadStrategyTest, ARequestRefusedBeforeTheWireIsAnErrorWithNoLatency) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "test-refused-latency", nlohmann::json{ { "mode", "constant_rps" } });
    vayu::db::Database db (TEST_DB_PATH);

    context->requests_sent++;
    vayu::core::handle_result (context, db,
    vayu::Result<vayu::Response> (vayu::http::detail::error_response (
    vayu::Error{ vayu::ErrorCode::InvalidUrl, "Cannot send this request" })));

    const auto& mc = *context->metrics_collector;
    EXPECT_EQ (mc.total_errors (), 1u);
    EXPECT_EQ (context->in_flight (), 0u);
    EXPECT_EQ (mc.latency_count (), 0);
    EXPECT_EQ (mc.latency_samples (), 0u);
}

// The same rule when it is libcurl, not the pre-send gate, that refuses the
// URL: a raw space sent as typed is refused before anything is resolved, so a
// run made only of such requests reports no latency at all (#2412). Port 1
// refuses a connection, so a transfer that did reach the wire would be timed.
// Mutation-check: set `transfer_attempted` true unconditionally in
// `extract_response` and every request joins the histogram.
TEST_F (LoadStrategyTest, ARunWhoseEveryUrlLibcurlRefusesHasNoLatencySamples) {
    constexpr size_t ITERATIONS = 3;
    nlohmann::json config       = {
        { "mode", "iterations" },
        { "iterations", ITERATIONS },
        { "concurrency", 1 },
    };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-unparsable-url-latency", config);
    context->event_loop =
    std::make_unique<vayu::http::EventLoop> (vayu::http::EventLoopConfig{});
    context->event_loop->start ();

    vayu::Request request;
    request.method               = vayu::HttpMethod::GET;
    request.url                  = "http://127.0.0.1:1/a b";
    request.timeout_ms           = 5000;
    request.disable_url_encoding = true;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    const auto& mc = *context->metrics_collector;
    const bool settled =
    vayu::tests::wait_until ([&] () { return mc.total_errors () == ITERATIONS; });
    context->event_loop->stop (true);

    ASSERT_TRUE (settled) << "errors recorded: " << mc.total_errors ();
    EXPECT_EQ (context->requests_sent.load (), ITERATIONS);
    EXPECT_EQ (mc.latency_count (), 0);
    EXPECT_EQ (mc.latency_samples (), 0u);
}

// ============================================================================
// Open-loop pacing: rate fidelity, the wall-clock deadline, and ramp-down
// ============================================================================

// Above 1000 RPS the old batch loop submitted size_t(target_rps / 1000.0)
// requests per 1ms tick, so 1500 RPS delivered 1000 and no client was told.
// The fractional accumulator delivers the requested rate.
TEST_F (LoadStrategyTest, ConstantRpsDeliversRatesAbove1000) {
    const double RPS      = 1500.0;
    const double DUR_S    = 2.0;
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "duration", "2s" },
        { "targetRps", RPS },
    };

    auto context = std::make_shared<vayu::core::RunContext> ("test-rps-1500", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->fast_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);
    strategy->execute (context, db, request);
    context->event_loop->stop (false);

    const double owed = RPS * DUR_S;
    const size_t sent = context->requests_sent.load ();
    // The floor sits between the broken reading (~2000, a rate floored to a
    // 1000-multiple) and the healthy one (~3000); 0.9 sat at 2700, which a
    // three-vCPU macOS runner missed at 2430.
    EXPECT_GT (static_cast<double> (sent), owed * 0.75)
    << "delivered " << sent << " of " << owed
    << "; a rate floored to a 1000-multiple would deliver ~2000";
    EXPECT_LT (static_cast<double> (sent), owed * 1.1)
    << "delivered " << sent << " of " << owed << "; the generator overshot its rate";
}

// The run is time-bound: it ends at its wall-clock deadline, and the requests
// it owed but could not issue are recorded as drops instead of being pushed
// past the deadline (or vanishing). sent + dropped is what the rate owed.
TEST_F (LoadStrategyTest, SaturatedRunEndsAtDeadlineAndRecordsTheShortfall) {
    const double RPS      = 500.0;
    const double DUR_S    = 1.0;
    nlohmann::json config = {
        { "mode", "constant_rps" },
        { "duration", "1s" },
        { "targetRps", RPS },
        { "maxInFlight", 5 }, // far below what a 500ms endpoint can retire
    };

    auto context =
    std::make_shared<vayu::core::RunContext> ("test-rps-saturated", config);
    vayu::http::EventLoopConfig loop_config;
    loop_config.max_concurrent = 2000;
    loop_config.max_per_host   = 2000;
    context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
    context->event_loop->start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = mock_server->slow_url ();
    request.timeout_ms = 30000;

    vayu::db::Database db (TEST_DB_PATH);
    auto strategy = vayu::core::LoadStrategy::create (config);

    const auto started = std::chrono::steady_clock::now ();
    strategy->execute (context, db, request);
    const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started)
                            .count ();
    context->event_loop->stop (false);

    const size_t sent    = context->requests_sent.load ();
    const size_t dropped = context->metrics_collector->dropped_requests ();
    const size_t skipped = context->metrics_collector->skipped_requests ();

    EXPECT_LT (elapsed_ms, 1500) << "run overshot its 1s wall-clock deadline";
    EXPECT_GT (dropped, 0u) << "a saturated run recorded no drops";
    EXPECT_EQ (sent + skipped + dropped, static_cast<size_t> (RPS * DUR_S))
    << "sent(" << sent << ") + skipped(" << skipped << ") + dropped(" << dropped
    << ") does not account for the " << (RPS * DUR_S) << " requests the rate owed";
}
