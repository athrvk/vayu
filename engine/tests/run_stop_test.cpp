/**
 * @file run_stop_test.cpp
 * @brief Stopping and deleting a run actually stops it (#124).
 *
 * These behaviours are covered, each of which used to be missing:
 *   1. EventLoop::stop(false) cancels in-flight transfers instead of waiting
 *      for an upstream that may never answer.
 *   2. EventLoop::stop(true, t) bounds that wait, so the natural end of a run
 *      cannot be pinned open either.
 *   3. DELETE /runs/:id stops an active run and waits for its worker to finish
 *      writing before removing the rows, or refuses with a 409.
 *   4. POST /runs/:id/stop answers a collection run's counts from its stored
 *      summary, never from the collector it does not feed (#2822).
 *   5. A Stop that finds no context (a run still `pending`) stands: the
 *      worker it raced sends nothing and writes no status over it (#3340).
 *   6. EventLoop::cancel(), from another thread, turns a drain in progress
 *      (or one asked for later) into a cancelling stop on every worker
 *      (#3341).
 *   7. A Stop that lands after the run's strategy returned on its own cuts
 *      the natural-end drain short and leaves the run Completed (#3341).
 *
 * Every timing assertion is an upper bound measured against an upstream that
 * holds the connection open for 30s, so the margins are wide: a regression here
 * does not shave milliseconds off, it reintroduces a wait of tens of seconds.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "mock_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"
#include "wait_until.hpp"

namespace vayu::http::routes {
// Defined in routes/runs.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> delete_run_response (vayu::db::Database& db,
vayu::core::RunManager& run_manager,
const std::string& run_id,
int64_t stop_wait_ms);
} // namespace vayu::http::routes

namespace {

using vayu::tests::SlowMockServer;
using Clock = std::chrono::steady_clock;

int64_t ms_since (Clock::time_point start) {
    return std::chrono::duration_cast<std::chrono::milliseconds> (Clock::now () - start)
    .count ();
}

// A stop must not inherit the upstream's latency. /hang holds for 30s, so any
// bound comfortably under that proves the transfers were cancelled rather than
// awaited, while leaving room for a loaded CI runner.
constexpr int64_t STOP_BUDGET_MS = 5000;

class EventLoopStopTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server = std::make_unique<SlowMockServer> ();
    }
    void TearDown () override {
        server.reset ();
        vayu::http::global_cleanup ();
    }

    // One worker so "submitted" and "in flight" are not spread across cores.
    static vayu::http::EventLoopConfig single_worker () {
        vayu::http::EventLoopConfig cfg;
        cfg.num_workers    = 1;
        cfg.max_concurrent = 16;
        cfg.max_per_host   = 16;
        return cfg;
    }

    vayu::Request hang_request () const {
        vayu::Request request;
        request.method = vayu::HttpMethod::GET;
        request.url    = server->hang_url ();
        // Deliberately longer than any assertion here: the point is that the
        // stop does not wait for curl's own timeout to rescue it.
        request.timeout_ms = 120000;
        return request;
    }

    std::unique_ptr<SlowMockServer> server;
};

// stop(false) against an upstream that never answers: every submitted request
// gets a result and the stop returns promptly. Before the fix the run loop kept
// spinning until active_transfers emptied on its own, i.e. for the upstream's
// full 30s hold.
TEST_F (EventLoopStopTest, StopCancelsInFlightAgainstAHungUpstream) {
    constexpr size_t TOTAL = 8;

    vayu::http::EventLoop loop (single_worker ());
    loop.start ();

    std::atomic<size_t> completed{ 0 };
    std::atomic<size_t> errored{ 0 };
    for (size_t i = 0; i < TOTAL; ++i) {
        loop.submit (hang_request (),
        [&] (size_t, const vayu::Result<vayu::Response>& result) {
            if (result.is_error ())
                errored++;
            completed++;
        });
    }

    // Wait until the worker has handed transfers to curl, so this exercises the
    // in-flight path rather than the queued-backlog one.
    auto wait_start = Clock::now ();
    while (loop.active_count () == 0 && ms_since (wait_start) < 2000) {
        std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }
    ASSERT_GT (loop.active_count (), 0u)
    << "no transfer reached curl; test cannot prove anything";

    auto stop_start = Clock::now ();
    loop.stop (false);
    auto stop_ms = ms_since (stop_start);

    EXPECT_LT (stop_ms, STOP_BUDGET_MS)
    << "stop(false) took " << stop_ms
    << "ms against a hung upstream - in-flight "
       "transfers are being awaited instead of cancelled";
    EXPECT_EQ (completed.load (), TOTAL)
    << "a cancelled transfer never reported a result";
    EXPECT_EQ (errored.load (), TOTAL)
    << "cancellation must surface as an error result";
}

// The queued backlog is discarded rather than sent, and each discarded request
// still reports a result so no caller is left waiting on a promise.
TEST_F (EventLoopStopTest, StopDiscardsTheQueuedBacklog) {
    constexpr size_t TOTAL = 64; // Far more than max_concurrent (16)

    vayu::http::EventLoop loop (single_worker ());
    loop.start ();

    std::atomic<size_t> completed{ 0 };
    for (size_t i = 0; i < TOTAL; ++i) {
        loop.submit (hang_request (),
        [&] (size_t, const vayu::Result<vayu::Response>&) { completed++; });
    }

    auto stop_start = Clock::now ();
    loop.stop (false);
    auto stop_ms = ms_since (stop_start);

    EXPECT_LT (stop_ms, STOP_BUDGET_MS) << "stop(false) took " << stop_ms << "ms";
    EXPECT_EQ (completed.load (), TOTAL)
    << "requests left in the queue at stop must be completed as cancelled, not "
       "dropped";
}

// The draining stop - the one the natural end of a run uses - honours its
// deadline. Without the bound this waits for the upstream, which is exactly the
// case where a run gets stuck reporting `running`.
TEST_F (EventLoopStopTest, DrainingStopHonoursItsDeadline) {
    constexpr size_t TOTAL = 8;

    vayu::http::EventLoop loop (single_worker ());
    loop.start ();

    std::atomic<size_t> completed{ 0 };
    for (size_t i = 0; i < TOTAL; ++i) {
        loop.submit (hang_request (),
        [&] (size_t, const vayu::Result<vayu::Response>&) { completed++; });
    }

    auto wait_start = Clock::now ();
    while (loop.active_count () == 0 && ms_since (wait_start) < 2000) {
        std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }
    ASSERT_GT (loop.active_count (), 0u);

    auto stop_start = Clock::now ();
    loop.stop (true, std::chrono::milliseconds (300));
    auto stop_ms = ms_since (stop_start);

    EXPECT_LT (stop_ms, STOP_BUDGET_MS)
    << "a bounded drain took " << stop_ms << "ms - the deadline is not being observed";
    EXPECT_EQ (completed.load (), TOTAL);
}

// ---------------------------------------------------------------------------
// EventLoop::cancel (#3341)
//
// Every case drains with CANCEL_DRAIN_DEADLINE, short of the mock's 30s hold
// on /hang, so a drain cancel() failed to cut short runs to that deadline: the
// broken reading is ~20s per draining worker and the healthy one is the
// cancel, a wake and a join (well under a second). STOP_BUDGET_MS sits between
// them, and the broken side stays under the 60s CTest timeout, so it fails by
// name rather than as a timeout.
// ---------------------------------------------------------------------------

constexpr auto CANCEL_DRAIN_DEADLINE = std::chrono::milliseconds (20000);

// Counts every result a request reports, so a dropped one and a doubled one
// both show as a total other than what was submitted.
struct ResultTally {
    std::atomic<size_t> completed{ 0 };
    std::atomic<size_t> errored{ 0 };

    vayu::http::RequestCallback callback () {
        return [this] (size_t, const vayu::Result<vayu::Response>& result) {
            if (result.is_error ()) {
                errored++;
            }
            completed++;
        };
    }
};

// A drain against a hung upstream, blocked on its own thread, is cut short by
// cancel() from this one.
TEST_F (EventLoopStopTest, CancelCutsADrainInProgressShort) {
    constexpr size_t TOTAL = 8;

    vayu::http::EventLoop loop (single_worker ());
    loop.start ();

    ResultTally tally;
    for (size_t i = 0; i < TOTAL; ++i) {
        loop.submit (hang_request (), tally.callback ());
    }
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] { return loop.active_count () == TOTAL; }))
    << "the transfers never reached curl; the test cannot prove anything";

    std::atomic<bool> stopping{ false };
    std::thread drainer ([&] {
        stopping.store (true);
        loop.stop (true, CANCEL_DRAIN_DEADLINE);
    });
    // The verdict does not hang on landing after the drain began - a cancel
    // that lands first must win too (CancelBeforeADrainingStopStands) - but
    // this is the interleaving the case is for.
    // EXPECT, not ASSERT: returning here would destroy a joinable thread.
    EXPECT_TRUE (vayu::tests::wait_until ([&] { return stopping.load (); }));

    const auto cancel_start = Clock::now ();
    loop.cancel ();
    drainer.join ();
    const auto stop_ms = ms_since (cancel_start);

    EXPECT_LT (stop_ms, STOP_BUDGET_MS)
    << "the drain outlived cancel() by " << stop_ms
    << "ms - it waited on the hung upstream instead of cancelling";
    EXPECT_EQ (tally.completed.load (), TOTAL);
    EXPECT_EQ (tally.errored.load (), TOTAL)
    << "a cancelled transfer must surface as an error";
}

// A cancel() that lands before the drain is asked for stands: the stop(true)
// cancels rather than drains, and the queued backlog behind the in-flight
// transfers is completed once each, neither dropped nor delivered twice.
TEST_F (EventLoopStopTest, CancelBeforeADrainingStopStands) {
    constexpr size_t TOTAL = 64; // Far more than max_concurrent (16)

    vayu::http::EventLoop loop (single_worker ());
    loop.start ();

    ResultTally tally;
    for (size_t i = 0; i < TOTAL; ++i) {
        loop.submit (hang_request (), tally.callback ());
    }
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] { return loop.active_count () > 0; }))
    << "no transfer reached curl; the test cannot prove anything";

    loop.cancel ();
    const auto stop_start = Clock::now ();
    loop.stop (true, CANCEL_DRAIN_DEADLINE);
    const auto stop_ms = ms_since (stop_start);

    EXPECT_LT (stop_ms, STOP_BUDGET_MS)
    << "stop(true) after cancel() took " << stop_ms
    << "ms - the drain overwrote the cancel";
    EXPECT_EQ (tally.completed.load (), TOTAL)
    << "every request, in flight or queued, reports exactly one result";
    EXPECT_EQ (tally.errored.load (), TOTAL);
}

// With no stop in progress cancel() changes nothing a caller relies on: the
// loop still answers is_running, a second call is a no-op, a request submitted
// afterwards still gets its one result, the stop that follows returns, and a
// cancel() after that stop touches nothing.
TEST_F (EventLoopStopTest, CancelWithNoStopIsHarmlessAndIdempotent) {
    vayu::http::EventLoop loop (single_worker ());
    loop.start ();

    loop.cancel ();
    loop.cancel ();
    EXPECT_TRUE (loop.is_running ())
    << "cancel() is not a stop; stop() is still owed";

    ResultTally tally;
    loop.submit (hang_request (), tally.callback ());

    const auto stop_start = Clock::now ();
    loop.stop (true, CANCEL_DRAIN_DEADLINE);
    const auto stop_ms = ms_since (stop_start);

    EXPECT_LT (stop_ms, STOP_BUDGET_MS)
    << "stop(true) after cancel() took " << stop_ms << "ms";
    EXPECT_FALSE (loop.is_running ());
    EXPECT_EQ (tally.completed.load (), 1U)
    << "a request submitted after cancel() is completed by the stop, once";
    EXPECT_EQ (tally.errored.load (), 1U);

    loop.cancel ();
    EXPECT_EQ (tally.completed.load (), 1U);
}

// EventLoopImpl::stop drains its workers one after another, so a cancel()
// finds one draining and the other not yet stopped; both must cancel.
TEST_F (EventLoopStopTest, CancelReachesEveryWorkerOfADrain) {
    constexpr size_t TOTAL = 8; // Round-robin: four on each worker

    vayu::http::EventLoopConfig cfg = single_worker ();
    cfg.num_workers                 = 2;
    vayu::http::EventLoop loop (cfg);
    loop.start ();

    ResultTally tally;
    for (size_t i = 0; i < TOTAL; ++i) {
        loop.submit (hang_request (), tally.callback ());
    }
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] { return loop.active_count () == TOTAL; }))
    << "the transfers never reached curl on both workers";

    std::atomic<bool> stopping{ false };
    std::thread drainer ([&] {
        stopping.store (true);
        loop.stop (true, CANCEL_DRAIN_DEADLINE);
    });
    // EXPECT, not ASSERT: returning here would destroy a joinable thread.
    EXPECT_TRUE (vayu::tests::wait_until ([&] { return stopping.load (); }));

    const auto cancel_start = Clock::now ();
    loop.cancel ();
    drainer.join ();
    const auto stop_ms = ms_since (cancel_start);

    EXPECT_LT (stop_ms, STOP_BUDGET_MS) << "the drain outlived cancel() by "
                                        << stop_ms << "ms - a worker kept draining";
    EXPECT_EQ (tally.completed.load (), TOTAL);
    EXPECT_EQ (tally.errored.load (), TOTAL);
}

// ---------------------------------------------------------------------------
// Run-level accounting
// ---------------------------------------------------------------------------

class RunStopAccountingTest : public EventLoopStopTest {
    protected:
    static constexpr const char* DB_PATH = "test_run_stop.db";

    void SetUp () override {
        EventLoopStopTest::SetUp ();
        vayu::tests::remove_database_files (DB_PATH);
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }
    void TearDown () override {
        db.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        EventLoopStopTest::TearDown ();
    }

    std::unique_ptr<vayu::db::Database> db;
};

// A stopped run's books balance: every request it submitted is accounted for,
// so in_flight() lands at zero instead of reporting requests that were
// cancelled and then silently discarded by handle_result. Against an upstream
// that never answers, every one of them was cancelled by the Stop, which is
// not an error (#2136).
TEST_F (RunStopAccountingTest, StoppedRunAccountsForItsCancelledRequests) {
    nlohmann::json config = { { "mode", "constant_rps" }, { "duration", "30s" },
        { "targetRps", 50.0 }, { "maxInFlight", 1000 } };

    auto context =
    std::make_shared<vayu::core::RunContext> ("run-stop-accounting", config);
    context->event_loop = std::make_unique<vayu::http::EventLoop> (single_worker ());
    context->event_loop->start ();

    // Stop once something was submitted: a fixed delay stopped a run that had
    // not yet sent anything on a slow runner, and the books below balance
    // trivially at zero.
    std::thread stopper ([&context] () {
        (void)vayu::tests::wait_until (
        [&context] () { return context->requests_sent.load () > 0; });
        context->request_stop ();
    });

    auto strategy = vayu::core::LoadStrategy::create (config);
    ASSERT_NE (strategy, nullptr);

    auto start = Clock::now ();
    strategy->execute (context, *db, hang_request ());
    stopper.join ();
    context->event_loop->stop (false);
    auto elapsed = ms_since (start);

    EXPECT_LT (elapsed, STOP_BUDGET_MS + 2000)
    << "a stopped run took " << elapsed << "ms to wind down against a hung upstream";
    ASSERT_GT (context->requests_sent.load (), 0u)
    << "nothing was submitted; nothing is proven";
    EXPECT_EQ (context->metrics_collector->cancelled (), context->requests_sent.load ())
    << "cancelled requests were submitted but never recorded";
    EXPECT_EQ (context->in_flight (), 0u);
    EXPECT_EQ (context->total_requests (), 0u);
    EXPECT_EQ (context->metrics_collector->total_errors (), 0u)
    << "a request the Stop cancelled is not an error";
    EXPECT_TRUE (context->metrics_collector->status_code_distribution ().empty ());
}

// The acceptance criterion end to end: a real run, started through RunManager
// against an upstream that never answers, is stopped and reaches a terminal
// status quickly. This is the one test that covers execute_load_test's choice
// between discarding and draining - with the drain restored it waits out the
// upstream instead, and a user's stop takes tens of seconds to land.
TEST_F (RunStopAccountingTest, StoppedRunReachesTerminalStatusPromptly) {
    const std::string run_id = "run-stop-e2e";

    vayu::db::Run row;
    row.id              = run_id;
    row.type            = vayu::RunType::Load;
    row.status          = vayu::RunStatus::Pending;
    row.config_snapshot = "{}";
    // Stamped now, not epoch: a terminal run triggers prune_runs_configured,
    // and an age-based retention window would sweep a 1970 row away before the
    // assertions below could read its status.
    row.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                     .count ();
    row.end_time = 0;
    db->create_run (row);

    nlohmann::json config = { { "mode", "constant_rps" }, { "duration", "30s" },
        { "targetRps", 50.0 }, { "url", server->hang_url () },
        { "method", "GET" }, { "timeout", 120000 }, { "workers", 1 } };

    vayu::core::RunManager manager;
    manager.start_run (run_id, config, *db);

    auto context = manager.get_run (run_id);
    ASSERT_NE (context, nullptr);

    auto ramp = Clock::now ();
    while (context->requests_sent.load () == 0 && ms_since (ramp) < 5000) {
        std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }
    ASSERT_GT (context->requests_sent.load (), 0u)
    << "the run never submitted anything";

    const size_t sent_at_stop = context->requests_sent.load ();
    auto stop_start           = Clock::now ();
    context->request_stop ();

    // retain_run() is the worker's last act, so this is "the run is fully done".
    // Waits well past the assertion below on purpose: the detached worker holds
    // references to this test's `db` and `manager`, so returning while it is
    // still running would tear those out from under it. A slow-but-finishing run
    // fails the timing assertion; it must not fail by use-after-free.
    while (manager.get_run (run_id) != nullptr && ms_since (stop_start) < 45000) {
        std::this_thread::sleep_for (std::chrono::milliseconds (20));
    }
    auto stop_ms = ms_since (stop_start);

    ASSERT_EQ (manager.get_run (run_id), nullptr)
    << "the run never settled after being stopped";
    EXPECT_LT (stop_ms, 10000)
    << "a stopped run took " << stop_ms
    << "ms to reach a terminal status against a hung upstream";

    auto stored = db->get_run (run_id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Stopped);

    // A run that ignores the stop keeps sending at 50/s for 30s; the slack is
    // for the strategy thread noticing the flag on a runner that stalls it.
    EXPECT_LE (context->requests_sent.load () - sent_at_stop, 25u)
    << "the run kept submitting requests after the stop was signalled";

    // #2136: the stored summary is the only record of what the Stop cancelled
    // - nothing answered, so the status distribution holds none of it.
    const auto summary = nlohmann::json::parse (stored->summary);
    ASSERT_TRUE (summary.contains ("cancelled")) << stored->summary;
    EXPECT_EQ (summary["cancelled"].get<size_t> (), context->requests_sent.load ());
    EXPECT_EQ (summary["total_requests"].get<size_t> (), 0u);
    EXPECT_FALSE (summary["status_codes"].contains ("0"))
    << "a cancelled request was recorded as a request with no response";
}

// #3340: a Stop that lands while a load run is still `pending`, before its
// worker registers, finds no context and writes the row itself. The worker's
// move to Running is refused, so the run sends nothing and writes no status
// over the Stop. Mutation check: ignore the refusal in `execute_load_test` and
// the run sends and stores a summary.
TEST_F (RunStopAccountingTest, AStopWhilePendingStandsAndTheRunSendsNothing) {
    const std::string run_id = "run-stop-pending";
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                     .count ();
    vayu::db::Run row;
    row.id              = run_id;
    row.type            = vayu::RunType::Load;
    row.status          = vayu::RunStatus::Pending;
    row.config_snapshot = "{}";
    row.start_time      = now;
    row.end_time        = now;
    db->create_run (row);

    vayu::core::RunManager manager;
    const auto [status, body] =
    vayu::http::routes::stop_unregistered_run_response (*db, manager, run_id);
    EXPECT_EQ (status, 200);
    EXPECT_EQ (body.value ("status", ""), "stopped") << body.dump ();

    const nlohmann::json config = { { "mode", "iterations" },
        { "iterations", 3 }, { "concurrency", 1 },
        { "url", server->fast_url () }, { "method", "GET" }, { "workers", 1 } };
    ASSERT_TRUE (manager.start_run (run_id, config, *db));
    ASSERT_TRUE (vayu::tests::wait_until (
    [&] () { return manager.get_run (run_id) == nullptr; }))
    << "the refused worker never handed the run back";

    const auto context = manager.get_run_or_retained (run_id);
    ASSERT_NE (context, nullptr);
    EXPECT_EQ (context->requests_sent.load (), 0u) << "a stopped run sent";
    const auto stored = db->get_run (run_id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Stopped);
    EXPECT_TRUE (stored->summary.empty ()) << stored->summary;
}

// ---------------------------------------------------------------------------
// A Stop after the run's own end (#3341)
//
// Each run ends on its own with transfers in flight against /hang, so its
// natural-end drain waits DRAIN_TIMEOUT_MS (the request timeout) plus the
// grace before giving up. A Stop then lands in the drain. Healthy: the drain
// is cancelled at once and the run settles within a second. Broken: it waits
// out the timeout, ~15s. STOP_BUDGET_MS sits between, and the broken side
// stays under wait_until's 20s deadline so it fails by name.
// ---------------------------------------------------------------------------

constexpr int DRAIN_TIMEOUT_MS = 15000;

class StopAfterNaturalEndTest : public RunStopAccountingTest {
    protected:
    void create_pending_run (const std::string& run_id) {
        vayu::db::Run row;
        row.id              = run_id;
        row.type            = vayu::RunType::Load;
        row.status          = vayu::RunStatus::Pending;
        row.config_snapshot = "{}";
        // Now, not epoch: a terminal run is pruned by age.
        row.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        db->create_run (row);
    }

    /// True once the worker is in its drain with @p in_flight transfers
    /// still held by the upstream: the strategy has returned on its own.
    static bool draining_with (const vayu::core::RunContext& context, size_t in_flight) {
        return context.phase () == vayu::core::RunPhase::draining &&
        context.active_transfer_count () == in_flight;
    }

    nlohmann::json parsed_summary (const std::string& run_id) {
        const auto stored = db->get_run (run_id);
        if (!stored) {
            ADD_FAILURE () << "the run row is gone";
            return nlohmann::json::object ();
        }
        return nlohmann::json::parse (stored->summary, nullptr, false);
    }
};

// An `iterations` run returns on its last submission, so its four requests
// are the drain. The Stop cuts it short; the run still completed on its own,
// what the Stop cancelled is counted as cancelled (not as errors), and its
// sending window is the whole run, as an `iterations` run's always is.
// Mutation checks: read `should_stop` again for the final status in
// `finish_load_test` and the run ends Stopped; drop the cancel from
// `RunContext::request_stop` and the drain runs to its timeout; read
// `should_stop` again in `sending_window` and the window is the submission
// burst alone.
TEST_F (StopAfterNaturalEndTest, AStopInTheDrainCompletesTheRunAndCutsTheDrain) {
    constexpr size_t IN_FLIGHT = 4;
    const std::string run_id   = "run-stop-after-end";
    create_pending_run (run_id);
    const nlohmann::json config = { { "mode", "iterations" }, { "iterations", IN_FLIGHT },
        { "concurrency", IN_FLIGHT }, { "url", server->hang_url () },
        { "method", "GET" }, { "timeout", DRAIN_TIMEOUT_MS }, { "workers", 1 } };

    vayu::core::RunManager manager;
    ASSERT_TRUE (manager.start_run (run_id, config, *db));
    const auto context = manager.get_run (run_id);
    ASSERT_NE (context, nullptr);
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] { return draining_with (*context, IN_FLIGHT); }))
    << "the run never reached its drain with its requests in flight";

    const auto stop_start = Clock::now ();
    context->request_stop ();
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] { return manager.get_run (run_id) == nullptr; }))
    << "the run never settled after the Stop";
    const auto stop_ms = ms_since (stop_start);

    EXPECT_LT (stop_ms, STOP_BUDGET_MS)
    << "the drain outlived the Stop by " << stop_ms << "ms";
    EXPECT_FALSE (context->stop_decides_outcome ());
    const auto stored = db->get_run (run_id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed)
    << "a run that ended on its own was recorded as stopped";

    const auto summary = parsed_summary (run_id);
    ASSERT_TRUE (summary.is_object ()) << stored->summary;
    EXPECT_EQ (summary.value ("cancelled", size_t{ 0 }), IN_FLIGHT) << stored->summary;
    EXPECT_EQ (summary.value ("total_requests", size_t{ 99 }), 0U)
    << "a request the Stop cancelled was recorded as an error";
    EXPECT_DOUBLE_EQ (summary.value ("sending_duration", 0.0),
    summary.value ("test_duration", -1.0))
    << "a Stop after the end shortened the sending window";
}

// The same for a collection load run, stopped through the route: two virtual
// users are held by the upstream when the 1s run ends. The route answers
// within its grace with a status that is never `stopped` (the run's own end,
// or `running` while the worker has not written it yet), and the run stores
// Completed. Mutation checks: hardcode `stopped` in the route again and the
// status assertion fails; read `should_stop` for the final status and the
// stored status does.
TEST_F (StopAfterNaturalEndTest, ACollectionRunStoppedInItsDrainAnswersItsOwnEnd) {
    constexpr size_t IN_FLIGHT = 2;
    const std::string run_id   = "run-stop-after-end-collection";
    create_pending_run (run_id);

    auto execution = std::make_shared<vayu::core::ScenarioExecution> ();
    execution->request.source        = "collection";
    execution->request.collection_id = "col_stop_after_end";
    vayu::core::ScenarioStep step;
    step.request_id         = "req_hang";
    step.name               = "hang";
    step.request.method     = vayu::HttpMethod::GET;
    step.request.url        = server->hang_url ();
    step.request.timeout_ms = DRAIN_TIMEOUT_MS;
    step.stored_url         = step.request.url;
    execution->plan.steps.push_back (std::move (step));
    const nlohmann::json config{ { "mode", "constant_concurrency" },
        { "concurrency", IN_FLIGHT }, { "duration", "1s" },
        { "timeout", DRAIN_TIMEOUT_MS }, { "workers", 1 },
        { "scenario",
        { { "source", "collection" }, { "collectionId", "col_stop_after_end" } } } };

    vayu::core::RunManager manager;
    ASSERT_TRUE (manager.start_run (run_id, config, *db, execution));
    const auto context = manager.get_run (run_id);
    ASSERT_NE (context, nullptr);
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] { return draining_with (*context, IN_FLIGHT); }))
    << "the run never reached its drain with its virtual users in flight";

    // The route's grace is 5s and its wait answers when it runs out, so the
    // broken reading is ~5s; the healthy one is the cancel plus one 100ms poll.
    constexpr int GRACE_SECONDS = 5;
    const auto stop_start       = Clock::now ();
    auto body                   = vayu::http::routes::stop_active_run_response (
    *db, *context, vayu::RunType::Load, GRACE_SECONDS);
    const auto stop_ms = ms_since (stop_start);

    EXPECT_LT (stop_ms, 4000)
    << "the route waited out its grace: the drain was not cut";
    const auto status = body.value ("status", "");
    EXPECT_TRUE (status == "completed" || status == "running") << body.dump ();

    ASSERT_TRUE (
    vayu::tests::wait_until ([&] { return manager.get_run (run_id) == nullptr; }))
    << "the run never settled after the Stop";
    const auto stored = db->get_run (run_id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;
    const auto summary = parsed_summary (run_id);
    ASSERT_TRUE (summary.is_object ()) << stored->summary;
    EXPECT_EQ (summary.value ("cancelled", size_t{ 0 }), IN_FLIGHT) << stored->summary;
}

// ---------------------------------------------------------------------------
// DELETE /runs/:id
// ---------------------------------------------------------------------------

class DeleteRunTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_delete_run.db";

    void SetUp () override {
        cleanup ();
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }
    void TearDown () override {
        db.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    void seed (const std::string& id, vayu::RunStatus status) {
        vayu::db::Run run;
        run.id              = id;
        run.type            = vayu::RunType::Load;
        run.status          = status;
        run.config_snapshot = R"({"url":"http://127.0.0.1/","method":"GET"})";
        run.start_time      = 1;
        run.end_time        = 2;
        db->create_run (run);
    }

    // A context with no threads of its own - the tests drive its lifecycle
    // explicitly, which is what lets them assert on the wait rather than race it.
    static std::shared_ptr<vayu::core::RunContext> make_context (const std::string& id) {
        nlohmann::json config = { { "mode", "constant_rps" }, { "duration", "1s" } };
        return std::make_shared<vayu::core::RunContext> (id, config);
    }

    std::unique_ptr<vayu::db::Database> db;
};

TEST_F (DeleteRunTest, UnknownRunIs404) {
    vayu::core::RunManager manager;
    auto [status, body] =
    vayu::http::routes::delete_run_response (*db, manager, "nope", 100);

    EXPECT_EQ (status, 404);
    EXPECT_EQ (body["error"]["message"], "Run not found");
}

TEST_F (DeleteRunTest, FinishedRunIsDeletedOutright) {
    seed ("run_done", vayu::RunStatus::Completed);
    vayu::core::RunManager manager;

    auto [status, body] =
    vayu::http::routes::delete_run_response (*db, manager, "run_done", 100);

    EXPECT_EQ (status, 200);
    EXPECT_EQ (body["runId"], "run_done");
    EXPECT_FALSE (db->get_run ("run_done").has_value ());
}

// A run whose status says `running` but whose worker is gone (the daemon
// restarted under it) has nobody left to race, so it deletes without waiting.
TEST_F (DeleteRunTest, RunningRowWithNoWorkerIsDeletedWithoutWaiting) {
    seed ("run_orphan", vayu::RunStatus::Running);
    vayu::core::RunManager manager;

    auto start = Clock::now ();
    auto [status, body] =
    vayu::http::routes::delete_run_response (*db, manager, "run_orphan", 5000);
    auto elapsed = ms_since (start);

    EXPECT_EQ (status, 200);
    EXPECT_LT (elapsed, 1000) << "waited on a run that has no active context";
    EXPECT_FALSE (db->get_run ("run_orphan").has_value ());
}

// The active case: delete signals the stop, waits for the worker to hand the
// run over (which it only does after its final writes), and only then deletes.
TEST_F (DeleteRunTest, ActiveRunIsStoppedThenDeleted) {
    seed ("run_live", vayu::RunStatus::Running);
    vayu::core::RunManager manager;
    auto context = make_context ("run_live");
    manager.register_run ("run_live", context);

    // Stands in for the run's worker: it settles only once the stop is
    // signalled, exactly as execute_load_test's retain_run does.
    std::thread worker ([&manager, context] () {
        while (!context->should_stop.load ()) {
            std::this_thread::sleep_for (std::chrono::milliseconds (5));
        }
        std::this_thread::sleep_for (std::chrono::milliseconds (50));
        manager.retain_run ("run_live");
    });

    auto [status, body] =
    vayu::http::routes::delete_run_response (*db, manager, "run_live", 5000);
    worker.join ();

    EXPECT_TRUE (context->should_stop.load ()) << "delete did not stop the run";
    EXPECT_EQ (status, 200);
    EXPECT_FALSE (db->get_run ("run_live").has_value ());
}

// The refusal: while a writer is still alive the rows stay put. Deleting them
// under it is what orphaned metrics and results against a deleted run id.
TEST_F (DeleteRunTest, StuckRunIsRefusedAndKeptIntact) {
    seed ("run_stuck", vayu::RunStatus::Running);
    vayu::core::RunManager manager;
    auto context = make_context ("run_stuck");
    manager.register_run ("run_stuck", context);

    auto start = Clock::now ();
    auto [status, body] =
    vayu::http::routes::delete_run_response (*db, manager, "run_stuck", 200);
    auto elapsed = ms_since (start);

    EXPECT_EQ (status, 409);
    EXPECT_TRUE (context->should_stop.load ())
    << "the stop must still stand after a refusal";
    EXPECT_GE (elapsed, 200) << "returned before the wait budget was spent";
    EXPECT_TRUE (db->get_run ("run_stuck").has_value ())
    << "a refused delete must leave the run intact, not half-deleted";

    manager.unregister_run ("run_stuck");
}

// ---------------------------------------------------------------------------
// POST /runs/:id/stop on an active run
// ---------------------------------------------------------------------------

class StopActiveRunTest : public DeleteRunTest {
    protected:
    void seed_running (const std::string& id, vayu::RunType type) {
        vayu::db::Run run;
        run.id              = id;
        run.type            = type;
        run.status          = vayu::RunStatus::Running;
        run.config_snapshot = "{}";
        run.start_time      = 1;
        db->create_run (run);
    }

    // Far past the stand-in worker's reaction, which is what ends the wait.
    static constexpr int SETTLE_GRACE_SECONDS = 20;
};

// Each answer is read through a non-const `json`: a key it lacks then reads as
// null and fails one comparison, where a const lookup asserts and aborts the
// whole binary.

// A collection run's worker feeds no collector, so the collector says 0 after
// steps ran (#2822). The answer is the summary the worker stored before it
// cleared `is_running`: 31 sent of 40 steps, 2 of them a 500.
// Mutation check: answer a Scenario run from `calculate_summary` again; this
// and the no-summary test fail.
TEST_F (StopActiveRunTest, CollectionRunAnswersItsStoredCounts) {
    seed_running ("run_seq", vayu::RunType::Scenario);
    auto context        = make_context ("run_seq");
    context->is_running = true;

    // Stands in for the scenario worker's ending: summary, then the terminal
    // status, then `is_running` cleared.
    std::thread worker ([this, context] () {
        (void)vayu::tests::wait_until (
        [&context] () { return context->should_stop.load (); });
        db->update_run_summary ("run_seq",
        R"({"total_requests":31,"status_codes":{"200":29,"500":2},)"
        R"("latency":{"count":31,"avg":12.5},"scenario":{"steps_executed":40}})");
        db->transition_run_status (
        "run_seq", { vayu::RunStatus::Running }, vayu::RunStatus::Stopped);
        context->is_running = false;
    });

    auto body = vayu::http::routes::stop_active_run_response (
    *db, *context, vayu::RunType::Scenario, SETTLE_GRACE_SECONDS);
    worker.join ();

    EXPECT_TRUE (context->should_stop.load ());
    EXPECT_EQ (body["status"], "stopped");
    EXPECT_EQ (body["runId"], "run_seq");
    ASSERT_TRUE (body.contains ("summary")) << body.dump ();
    auto& summary = body["summary"];
    EXPECT_EQ (summary["totalRequests"], 31);
    EXPECT_EQ (summary["errors"], 2);
    EXPECT_EQ (summary["httpErrors"], 2);
    EXPECT_EQ (summary["noResponse"], 0);
    EXPECT_DOUBLE_EQ (summary["errorRate"].get<double> (), 2.0 * 100.0 / 31.0);
    EXPECT_DOUBLE_EQ (summary["avgLatencyMs"].get<double> (), 12.5);
    EXPECT_EQ (summary["stepsExecuted"], 40);
}

// The grace period ran out before the worker stored anything: no counts are
// known, so the answer carries no summary rather than a summary of zeros, and
// its status is the row's, not a `stopped` the run has not reached.
TEST_F (StopActiveRunTest, CollectionRunWithNoStoredSummaryAnswersNone) {
    seed_running ("run_slow", vayu::RunType::Scenario);
    auto context        = make_context ("run_slow");
    context->is_running = true;

    // A grace of 0 is the timed-out wait without spending one.
    auto body = vayu::http::routes::stop_active_run_response (
    *db, *context, vayu::RunType::Scenario, 0);

    EXPECT_TRUE (context->should_stop.load ());
    EXPECT_FALSE (body.contains ("summary")) << body.dump ();
    EXPECT_EQ (body["status"], "running");
    EXPECT_EQ (body["runId"], "run_slow");
    EXPECT_EQ (body["message"], "Stop signalled; read the report");
}

// The other side of the Pending-window race (#3340): the worker registered
// and moved its row to Running after the route found no context. The row
// still stops, and the run that is sending is told to, so its final move is
// refused rather than its load left running under a `stopped` row. Mutation
// check: drop the signal in `stop_unregistered_run_response`.
TEST_F (StopActiveRunTest, AStopThatMissedTheContextStillSignalsTheRun) {
    seed_running ("run_raced", vayu::RunType::Load);
    vayu::core::RunManager manager;
    auto context = make_context ("run_raced");
    manager.register_run ("run_raced", context);

    const auto [status, body] =
    vayu::http::routes::stop_unregistered_run_response (*db, manager, "run_raced");

    EXPECT_EQ (status, 200);
    EXPECT_EQ (body.value ("status", ""), "stopped") << body.dump ();
    EXPECT_TRUE (context->should_stop.load ())
    << "the raced run was not signalled";
    const auto stored = db->get_run ("run_raced");
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Stopped);
    manager.unregister_run ("run_raced");
}

// A row that finished between the route's read and the move keeps its status
// and is answered with it; one deleted in between is a 404.
TEST_F (StopActiveRunTest, AStopWithNoContextLeavesAFinishedRunAlone) {
    seed ("run_done", vayu::RunStatus::Completed);
    vayu::core::RunManager manager;

    const auto [status, body] =
    vayu::http::routes::stop_unregistered_run_response (*db, manager, "run_done");
    EXPECT_EQ (status, 200);
    EXPECT_EQ (body.value ("status", ""), "completed") << body.dump ();
    const auto stored = db->get_run ("run_done");
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (stored->end_time, 2);

    EXPECT_EQ (
    vayu::http::routes::stop_unregistered_run_response (*db, manager, "nope").first, 404);
}

// A load run, a scenario load run included, still answers from its collector.
// Mutation check: route a Load run down the collection branch; this fails.
TEST_F (StopActiveRunTest, LoadRunAnswersFromItsCollector) {
    seed_running ("run_load", vayu::RunType::Load);
    auto context = make_context ("run_load");
    for (int i = 0; i < 8; ++i) {
        context->metrics_collector->record_success (200, 10.0, 0.0);
    }
    context->metrics_collector->record_success (503, 10.0, 0.0);
    context->metrics_collector->record_error (vayu::ErrorCode::Timeout, "timed out");
    // A summary the load path never reads here; a collector-blind answer
    // would report it instead.
    db->update_run_summary ("run_load", R"({"status_codes":{"200":1}})");

    auto body = vayu::http::routes::stop_active_run_response (
    *db, *context, vayu::RunType::Load, 0);

    EXPECT_EQ (body["status"], "stopped");
    ASSERT_TRUE (body.contains ("summary")) << body.dump ();
    EXPECT_EQ (body["summary"]["totalRequests"], 10);
    EXPECT_EQ (body["summary"]["errors"], 2);
    EXPECT_EQ (body["summary"]["noResponse"], 1);
    EXPECT_EQ (body["summary"]["cancelled"], 0);
    EXPECT_FALSE (body["summary"].contains ("stepsExecuted"));
}

// A load run stopped in its drain ends by its own verdict (#3341), so the
// answer is the status the worker stored, here Completed. Mutation check:
// answer `stopped` unconditionally in `stop_active_run_response`; this and
// the next test fail.
TEST_F (StopActiveRunTest, LoadRunStoppedInItsDrainAnswersItsStoredStatus) {
    seed_running ("run_drained", vayu::RunType::Load);
    auto context = make_context ("run_drained");
    context->advance_phase (vayu::core::RunPhase::draining);
    context->is_running = true;

    // Stands in for the load worker's ending: is_running cleared, then the
    // terminal status, as execute_load_test orders them.
    std::thread worker ([this, context] () {
        (void)vayu::tests::wait_until (
        [&context] () { return context->stop_was_requested (); });
        db->transition_run_status (
        "run_drained", { vayu::RunStatus::Running }, vayu::RunStatus::Completed);
        context->is_running = false;
    });

    auto body = vayu::http::routes::stop_active_run_response (
    *db, *context, vayu::RunType::Load, SETTLE_GRACE_SECONDS);
    worker.join ();

    EXPECT_EQ (body["status"], "completed") << body.dump ();
}

// The same Stop before the worker has written anything: the run is still
// running, not `stopped`, which it will never be.
TEST_F (StopActiveRunTest, LoadRunStoppedInItsDrainIsNotAnsweredStopped) {
    seed_running ("run_draining", vayu::RunType::Load);
    auto context = make_context ("run_draining");
    context->advance_phase (vayu::core::RunPhase::draining);
    context->is_running = true;

    auto body = vayu::http::routes::stop_active_run_response (
    *db, *context, vayu::RunType::Load, 0);

    EXPECT_EQ (body["status"], "running") << body.dump ();
}

} // namespace
