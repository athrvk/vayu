/**
 * @file run_retention_release_test.cpp
 * @brief A finished run lets go of its machinery as it is retained (#1154).
 *
 * Retention exists so a late consumer of `/runs/:id/live` still gets the whole
 * tick series, and for 60-90s a finished run used to hold everything else with
 * it: the event loop's per-worker curl handle pools, the multi handles and the
 * TCP connections cached inside them against the tested target, the submission
 * queues, and the run's bound rows.
 *
 * The mock server counts the connections it is holding open, which is what
 * makes the release observable from outside the engine: with the release
 * removed, the count stays up until the multi handles are freed at sweep time.
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

class RunRetentionReleaseTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_run_retention_release.db";

    void SetUp () override {
        vayu::http::global_init ();
        server = std::make_unique<SlowMockServer> ();
        vayu::tests::remove_database_files (DB_PATH);
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }

    void TearDown () override {
        db.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        server.reset ();
        vayu::http::global_cleanup ();
    }

    /// A run row for @p run_id, stamped now: a terminal run triggers
    /// prune_runs_configured, and an age-based window would sweep a 1970 row
    /// away before the assertions could read it.
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

    std::unique_ptr<SlowMockServer> server;
    std::unique_ptr<vayu::db::Database> db;
};

// The acceptance criterion end to end: once a real run has been retained, the
// engine is holding no connection to the target - and the tick topic retention
// exists for still answers.
TEST_F (RunRetentionReleaseTest, RetainedRunHoldsNoConnectionToTheTarget) {
    const std::string run_id = "run-retention-release";
    create_run_row (run_id);

    // Short, modest and single-worker: enough requests to have the mock holding
    // connections open, few enough that its own keep-alive request cap (100 per
    // connection) never closes one for us.
    nlohmann::json config = { { "mode", "constant_rps" }, { "duration", "1s" },
        { "targetRps", 40.0 }, { "url", server->fast_url () }, { "method", "GET" },
        { "timeout", 5000 }, { "workers", 1 }, { "concurrency", 4 } };

    vayu::core::RunManager manager;
    manager.start_run (run_id, config, *db, false);

    auto context = manager.get_run (run_id);
    ASSERT_NE (context, nullptr);

    auto ramp = Clock::now ();
    while (server->live_connection_count () == 0 && ms_since (ramp) < 5000) {
        std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }
    ASSERT_GT (server->live_connection_count (), 0)
    << "the run never opened a connection; the test cannot prove anything";

    // retain_run() is the worker's last act, so a run that has left active_runs_
    // is fully done. The wait is far longer than the assertions below need: the
    // worker holds references to this test's `db` and `manager`, so returning
    // while it is still running would tear those out from under it.
    auto finish = Clock::now ();
    while (manager.get_run (run_id) != nullptr && ms_since (finish) < 45000) {
        std::this_thread::sleep_for (std::chrono::milliseconds (20));
    }
    ASSERT_EQ (manager.get_run (run_id), nullptr) << "the run never finished";

    // The release happens just after the map move, so poll rather than read on
    // the same instant. The budget is well inside the 60s retention window this
    // is about, and inside httplib's own 5s keep-alive timeout, so a count that
    // only drops later is the sweep or the mock closing up, not this fix.
    auto closing = Clock::now ();
    while (server->live_connection_count () > 0 && ms_since (closing) < 2000) {
        std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }
    EXPECT_EQ (server->live_connection_count (), 0)
    << "a retained run was still holding connections open against the target";

    // What retention is for still answers a late consumer.
    auto retained = manager.get_run_or_retained (run_id);
    ASSERT_NE (retained, nullptr);
    EXPECT_GT (retained->published_count.load (), 0u);
    EXPECT_FALSE (retained->ticks_since (0).payloads.empty ())
    << "the tick topic did not survive the release";

    auto stored = db->get_run (run_id);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
}

} // namespace
