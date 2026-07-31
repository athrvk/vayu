/**
 * @file run_stop_test.cpp
 * @brief Stopping and deleting a run actually stops it (#124).
 *
 * Three behaviours are covered, each of which used to be missing:
 *   1. EventLoop::stop(false) cancels in-flight transfers instead of waiting
 *      for an upstream that may never answer.
 *   2. EventLoop::stop(true, t) bounds that wait, so the natural end of a run
 *      cannot be pinned open either.
 *   3. DELETE /runs/:id stops an active run and waits for its worker to finish
 *      writing before removing the rows, or refuses with a 409.
 *
 * Every timing assertion is an upper bound measured against an upstream that
 * holds the connection open for 30s, so the margins are wide: a regression here
 * does not shave milliseconds off, it reintroduces a wait of tens of seconds.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "mock_server.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"

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
        loop.submit (hang_request (), [&] (size_t, vayu::Result<vayu::Response> result) {
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
        [&] (size_t, vayu::Result<vayu::Response>) { completed++; });
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
        [&] (size_t, vayu::Result<vayu::Response>) { completed++; });
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
// Run-level accounting
// ---------------------------------------------------------------------------

class RunStopAccountingTest : public EventLoopStopTest {
    protected:
    static constexpr const char* DB_PATH = "test_run_stop.db";

    void SetUp () override {
        EventLoopStopTest::SetUp ();
        std::filesystem::remove (DB_PATH);
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }
    void TearDown () override {
        db.reset ();
        for (const char* suffix : { "", "-wal", "-shm" }) {
            std::filesystem::remove (std::string (DB_PATH) + suffix);
        }
        EventLoopStopTest::TearDown ();
    }

    std::unique_ptr<vayu::db::Database> db;
};

// A stopped run's books balance: every request it submitted is accounted for,
// so in_flight() lands at zero instead of reporting requests that were
// cancelled and then silently discarded by handle_result.
TEST_F (RunStopAccountingTest, StoppedRunAccountsForItsCancelledRequests) {
    nlohmann::json config = { { "mode", "constant_rps" }, { "duration", "30s" },
        { "targetRps", 50.0 }, { "maxInFlight", 1000 } };

    auto context =
    std::make_shared<vayu::core::RunContext> ("run-stop-accounting", config);
    context->event_loop = std::make_unique<vayu::http::EventLoop> (single_worker ());
    context->event_loop->start ();

    std::thread stopper ([&context] () {
        std::this_thread::sleep_for (std::chrono::milliseconds (300));
        context->should_stop = true;
        context->notify_refill ();
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
    EXPECT_EQ (context->total_requests (), context->requests_sent.load ())
    << "cancelled requests were submitted but never recorded";
    EXPECT_EQ (context->in_flight (), 0u);
    EXPECT_EQ (context->total_errors (), context->requests_sent.load ())
    << "a request cancelled before it got a response is an error, not a "
       "success";
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
    manager.start_run (run_id, config, *db, false);

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
    context->should_stop      = true;
    context->notify_refill ();

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
    ASSERT_TRUE (stored.has_value ());
    EXPECT_EQ (stored->status, vayu::RunStatus::Stopped);

    EXPECT_LE (context->requests_sent.load () - sent_at_stop, 10u)
    << "the run kept submitting requests after the stop was signalled";
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
        for (const char* suffix : { "", "-wal", "-shm" }) {
            std::filesystem::remove (std::string (DB_PATH) + suffix);
        }
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

} // namespace
