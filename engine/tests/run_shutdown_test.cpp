/**
 * @file run_shutdown_test.cpp
 * @brief Shutting down mid-run stops and JOINS the run workers (#125).
 *
 * The worker thread used to be detached, and the daemon's drain stopped waiting
 * as soon as `active_count()` hit zero - which a worker reaches at `retain_run`,
 * its final statement, with the thread still unwinding - and gave up entirely
 * after 5s. Either way `main` went on to run curl's global teardown and destroy
 * the `Database` and `RunManager` the still-running worker holds references to.
 *
 * The assertions here are about *ownership*, not timing: a handle is tracked
 * while the worker runs, and shutdown returns only once every one of them has
 * been joined. Timing bounds are upper bounds against an upstream that holds
 * the connection open for 30s, so a regression does not shave milliseconds off
 * - it reintroduces a wait of tens of seconds, or an abandoned thread.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "mock_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"

namespace {

using vayu::tests::SlowMockServer;
using Clock = std::chrono::steady_clock;

int64_t ms_since (Clock::time_point start) {
    return std::chrono::duration_cast<std::chrono::milliseconds> (Clock::now () - start)
    .count ();
}

class RunShutdownTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_run_shutdown.db";

    void SetUp () override {
        vayu::http::global_init ();
        server = std::make_unique<SlowMockServer> ();
        cleanup ();
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }
    void TearDown () override {
        db.reset ();
        cleanup ();
        server.reset ();
        vayu::http::global_cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    // A row for the run, so the worker's status writes have something to land
    // on. Stamped now rather than at the epoch: a terminal run triggers
    // prune_runs_configured, and an age-based retention window would sweep a
    // 1970 row away before the assertions could read its status.
    void create_run_row (const std::string& run_id) {
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
    }

    // A run long enough that it cannot end on its own inside any of these
    // tests, against an upstream that never answers.
    nlohmann::json hang_config () const {
        return { { "mode", "constant_rps" }, { "duration", "30s" },
            { "targetRps", 50.0 }, { "url", server->hang_url () },
            { "method", "GET" }, { "timeout", 120000 }, { "workers", 1 } };
    }

    // Wait until the run has actually put requests on the wire, so what follows
    // interrupts a *working* worker rather than one still setting up.
    static void wait_until_submitting (const std::shared_ptr<vayu::core::RunContext>& context) {
        auto start = Clock::now ();
        while (context->requests_sent.load () == 0 && ms_since (start) < 5000) {
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
        }
        ASSERT_GT (context->requests_sent.load (), 0u)
        << "the run never submitted anything";
    }

    std::unique_ptr<SlowMockServer> server;
    std::unique_ptr<vayu::db::Database> db;
};

// The acceptance criterion: shutdown stops the run AND joins its worker, so
// nothing is still executing over `db` when it returns.
TEST_F (RunShutdownTest, ShutdownStopsAndJoinsAWorkerMidRun) {
    const std::string run_id = "run-shutdown-joins";
    create_run_row (run_id);

    vayu::core::RunManager manager;
    ASSERT_TRUE (manager.start_run (run_id, hang_config (), *db, false));

    auto context = manager.get_run (run_id);
    ASSERT_NE (context, nullptr);
    ASSERT_NO_FATAL_FAILURE (wait_until_submitting (context));

    // The handle exists at all only because the worker is no longer detached.
    EXPECT_EQ (manager.tracked_worker_count (), 1u)
    << "the run's worker thread is not owned by anyone that could join it";

    auto start = Clock::now ();
    manager.shutdown (std::chrono::milliseconds (5000));
    auto elapsed = ms_since (start);

    EXPECT_LT (elapsed, 15000) << "the drain took " << elapsed << "ms against a hung upstream";
    EXPECT_EQ (manager.active_count (), 0u);
    EXPECT_EQ (manager.tracked_worker_count (), 0u)
    << "shutdown returned with worker threads still unjoined";

    // A joined worker has finished its writes; the status cannot still be
    // in-flight once shutdown has returned.
    auto stored = db->get_run (run_id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_NE (stored->status, vayu::RunStatus::Running);
    EXPECT_NE (stored->status, vayu::RunStatus::Pending);
    EXPECT_FALSE (context->is_running.load ());
}

// The destructor is the backstop for a caller that forgets to drain - and the
// direct mutation check for the original defect. With the worker detached and
// nothing joining it, `~RunManager` returns while the run is still going and
// the status below is still `running`.
TEST_F (RunShutdownTest, DestructorDrainsAnActiveRun) {
    const std::string run_id = "run-shutdown-dtor";
    create_run_row (run_id);

    auto start = Clock::now ();
    {
        vayu::core::RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, hang_config (), *db, false));
        auto context = manager.get_run (run_id);
        ASSERT_NE (context, nullptr);
        ASSERT_NO_FATAL_FAILURE (wait_until_submitting (context));
        EXPECT_EQ (manager.tracked_worker_count (), 1u)
        << "nothing owns the worker, so the destructor has nothing to join";
    }
    auto elapsed = ms_since (start);
    EXPECT_LT (elapsed, 20000) << "the destructor took " << elapsed << "ms to drain";

    auto stored = db->get_run (run_id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_NE (stored->status, vayu::RunStatus::Running)
    << "~RunManager returned while the run was still executing - its worker "
       "outlives the manager and the database";
}

// Once the drain has begun, a request that races it is refused rather than
// starting a worker that nothing will join.
TEST_F (RunShutdownTest, StartRunAfterShutdownIsRefused) {
    vayu::core::RunManager manager;
    manager.shutdown ();

    const std::string run_id = "run-shutdown-refused";
    create_run_row (run_id);

    EXPECT_FALSE (manager.start_run (run_id, hang_config (), *db, false));
    EXPECT_EQ (manager.active_count (), 0u);
    EXPECT_EQ (manager.tracked_worker_count (), 0u);
    EXPECT_EQ (manager.get_run (run_id), nullptr);
}

// Draining an idle manager must not wait out the grace period, and calling it
// twice must not double-join.
TEST_F (RunShutdownTest, ShutdownWithNoActiveRunsIsPromptAndIdempotent) {
    vayu::core::RunManager manager;

    auto start = Clock::now ();
    manager.shutdown (std::chrono::milliseconds (5000));
    manager.shutdown (std::chrono::milliseconds (5000));
    auto elapsed = ms_since (start);

    EXPECT_LT (elapsed, 1000) << "an idle drain waited " << elapsed << "ms for nothing";
    EXPECT_EQ (manager.tracked_worker_count (), 0u);
}

// A worker cannot join itself, so its handle outlives it. Without a reap, a
// long-lived daemon accumulates one per run for the life of the process.
TEST_F (RunShutdownTest, FinishedWorkersAreReapedByTheNextStartRun) {
    vayu::core::RunManager manager;

    const std::string first = "run-shutdown-reap-1";
    create_run_row (first);
    // Bounded by iterations rather than duration, against the mock's instant
    // endpoint, so it finishes on its own within the wait below.
    nlohmann::json quick = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "url", server->fast_url () },
        { "method", "GET" }, { "timeout", 5000 }, { "workers", 1 } };
    ASSERT_TRUE (manager.start_run (first, quick, *db, false));

    auto start = Clock::now ();
    while (manager.active_count () > 0 && ms_since (start) < 15000) {
        std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }
    ASSERT_EQ (manager.active_count (), 0u) << "the bounded run never finished";

    const std::string second = "run-shutdown-reap-2";
    create_run_row (second);
    ASSERT_TRUE (manager.start_run (second, hang_config (), *db, false));

    EXPECT_EQ (manager.tracked_worker_count (), 1u)
    << "the finished run's thread handle was never reaped";

    manager.shutdown ();
}

} // namespace
