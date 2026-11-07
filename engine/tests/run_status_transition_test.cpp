/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_status_transition_test.cpp
 * @brief `Database::transition_run_status`, the guarded run status write
 *        (#3340): which edges it takes, what it does to `end_time`, and that a
 *        terminal write outlasts a busy database.
 *
 * Mutation check for the guard: take every edge (drop the `allowed_from`
 * lookup) and `ATerminalStatusIsLeftOnlyByANamedEdge` and
 * `AnEmptyAllowedSetRefusesEveryRow` fail.
 */

#include <gtest/gtest.h>
#include <sqlite3.h>

#include <chrono>
#include <cstdint>
#include <future>
#include <string>

#include "log_capture.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "wait_until.hpp"

namespace vayu::db {
namespace {

using vayu::RunStatus;

constexpr const char* DB_PATH = "test_run_status_transition.db";

/// Far enough in the past that a stamp of "now" is distinguishable from it.
constexpr int64_t STARTED = 1'000'000;

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

class RunStatusTransitionTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
    }
    void TearDown () override {
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// A run at @p status with @p end_time; the default is the seed
    /// `seed_run_times` writes, end_time == start_time.
    static void
    seed (Database& db, const std::string& id, RunStatus status, int64_t end_time = STARTED) {
        vayu::db::Run run;
        run.id              = id;
        run.type            = RunType::Load;
        run.status          = status;
        run.start_time      = STARTED;
        run.end_time        = end_time;
        run.config_snapshot = "{}";
        db.create_run (run);
    }

    static vayu::db::Run row (Database& db, const std::string& id) {
        auto run = db.get_run (id);
        if (!run) {
            ADD_FAILURE () << "no run " << id;
            return {};
        }
        return *run;
    }
};

TEST_F (RunStatusTransitionTest, ATerminalStatusIsLeftOnlyByANamedEdge) {
    Database db (DB_PATH);
    db.init ();
    constexpr int64_t RECORDED_END = STARTED + 500;

    for (const auto terminal :
    { RunStatus::Completed, RunStatus::Failed, RunStatus::Stopped }) {
        const std::string id = std::string ("run_") + to_string (terminal);
        seed (db, id, terminal, RECORDED_END);
        for (const auto to : { RunStatus::Pending, RunStatus::Running,
             RunStatus::Completed, RunStatus::Failed, RunStatus::Stopped }) {
            const auto outcome = db.transition_run_status (
            id, { RunStatus::Pending, RunStatus::Running }, to);
            EXPECT_FALSE (outcome.applied) << id << " -> " << to_string (to);
            EXPECT_EQ (outcome.current, terminal) << id << " -> " << to_string (to);
        }
        const vayu::db::Run after = row (db, id);
        EXPECT_EQ (after.status, terminal);
        EXPECT_EQ (after.end_time, RECORDED_END)
        << "a refused edge writes nothing";
    }

    // The one way out is to name the status being left.
    const auto named = db.transition_run_status (
    "run_completed", { RunStatus::Completed }, RunStatus::Failed);
    EXPECT_TRUE (named.applied);
    EXPECT_EQ (named.current, RunStatus::Failed);
    const vayu::db::Run moved = row (db, "run_completed");
    EXPECT_EQ (moved.status, RunStatus::Failed);
    EXPECT_EQ (moved.end_time, RECORDED_END)
    << "a terminal-to-terminal edge keeps the end it already had";
}

TEST_F (RunStatusTransitionTest, AnEmptyAllowedSetRefusesEveryRow) {
    Database db (DB_PATH);
    db.init ();
    seed (db, "pending", RunStatus::Pending);

    const auto outcome = db.transition_run_status ("pending", {}, RunStatus::Running);
    EXPECT_FALSE (outcome.applied);
    EXPECT_EQ (outcome.current, RunStatus::Pending);
    const vayu::db::Run after = row (db, "pending");
    EXPECT_EQ (after.status, RunStatus::Pending);
    EXPECT_EQ (after.end_time, STARTED);
}

TEST_F (RunStatusTransitionTest, AMissingRunIsNotAppliedAndNotCreated) {
    Database db (DB_PATH);
    db.init ();

    const auto outcome = db.transition_run_status (
    "no_such_run", { RunStatus::Running }, RunStatus::Completed);
    EXPECT_FALSE (outcome.applied);
    EXPECT_FALSE (outcome.current.has_value ());
    EXPECT_FALSE (db.get_run ("no_such_run").has_value ());
}

// The live report measures `end > 0 ? end : now`, so a running row has to
// carry no end, whatever its insert seeded. Mutation check: leave end_time
// alone on the Running edge and the seed survives.
TEST_F (RunStatusTransitionTest, MovingToRunningClearsEndTime) {
    Database db (DB_PATH);
    db.init ();
    seed (db, "starting", RunStatus::Pending);

    const auto outcome =
    db.transition_run_status ("starting", { RunStatus::Pending }, RunStatus::Running);
    EXPECT_TRUE (outcome.applied);
    EXPECT_EQ (outcome.current, RunStatus::Running);
    const vayu::db::Run after = row (db, "starting");
    EXPECT_EQ (after.status, RunStatus::Running);
    EXPECT_EQ (after.end_time, 0);
}

// A worker stamps end_time when generation stops, before its cleanup; the
// terminal write lands after the cleanup and must not move it. Mutation
// check: stamp now unconditionally on a terminal edge.
TEST_F (RunStatusTransitionTest, ATerminalMoveKeepsAnEndTheWorkerRecorded) {
    Database db (DB_PATH);
    db.init ();
    constexpr int64_t GENERATION_END = STARTED + 30'000;
    seed (db, "finishing", RunStatus::Running, GENERATION_END);

    const auto outcome = db.transition_run_status (
    "finishing", { RunStatus::Running }, RunStatus::Completed);
    EXPECT_TRUE (outcome.applied);
    EXPECT_EQ (row (db, "finishing").end_time, GENERATION_END);
}

// The seed (end == start) and a cleared end (0) are not an end the run
// recorded, so a terminal move stamps now over both. Mutation check: keep any
// non-zero end_time and the seed survives as a zero-length run.
TEST_F (RunStatusTransitionTest, ATerminalMoveStampsNowOverASeedOrNoEnd) {
    Database db (DB_PATH);
    db.init ();
    seed (db, "seeded", RunStatus::Pending);
    seed (db, "cleared", RunStatus::Running, 0);

    const int64_t before = now_ms ();
    EXPECT_TRUE (db
    .transition_run_status ("seeded", { RunStatus::Pending }, RunStatus::Failed)
    .applied);
    EXPECT_TRUE (db
    .transition_run_status ("cleared", { RunStatus::Running }, RunStatus::Stopped)
    .applied);
    EXPECT_GE (row (db, "seeded").end_time, before);
    EXPECT_GE (row (db, "cleared").end_time, before);
}

// Neither terminal nor Running: end_time is not this edge's to change.
TEST_F (RunStatusTransitionTest, AnEdgeToPendingLeavesEndTimeAlone) {
    Database db (DB_PATH);
    db.init ();
    constexpr int64_t RECORDED_END = STARTED + 700;
    seed (db, "requeued", RunStatus::Running, RECORDED_END);

    EXPECT_TRUE (db
    .transition_run_status ("requeued", { RunStatus::Running }, RunStatus::Pending)
    .applied);
    const vayu::db::Run after = row (db, "requeued");
    EXPECT_EQ (after.status, RunStatus::Pending);
    EXPECT_EQ (after.end_time, RECORDED_END);
}

// A terminal write that gives up leaves the run `running` until the next
// start. Held busy by a second connection, the write must keep retrying past
// the bounded budget a non-terminal move gets (three attempts), and land once
// the lock goes. "Past the budget" is read off the retry log, never a clock:
// a third retry is one the bounded path never logs. Mutation check: give the
// terminal case the bounded attempt count and the future throws instead.
TEST_F (RunStatusTransitionTest, ATerminalWriteOutlastsABusyDatabase) {
    constexpr auto BUSY_TIMEOUT = std::chrono::milliseconds (20);
    {
        Database db (DB_PATH);
        db.init ();
        auto entry = db.get_config_entry ("dbBusyTimeout");
        ASSERT_HAS_VALUE (entry);
        entry->value = std::to_string (BUSY_TIMEOUT.count ());
        db.save_config_entry (*entry);
    }
    vayu::tests::LogCapture logs;
    Database db (DB_PATH, BUSY_TIMEOUT);
    db.init ();
    ASSERT_EQ (db.applied_busy_timeout_ms (), BUSY_TIMEOUT.count ());
    // Seeded after `init`, whose reconciliation and retention would fail and
    // prune a running row from 1970.
    seed (db, "held", RunStatus::Running, 0);

    sqlite3* holder = nullptr;
    ASSERT_EQ (sqlite3_open (DB_PATH, &holder), SQLITE_OK);
    ASSERT_EQ (sqlite3_exec (holder, "BEGIN IMMEDIATE;", nullptr, nullptr, nullptr), SQLITE_OK);

    auto landed                   = std::async (std::launch::async, [&db] {
        return db.transition_run_status ("held", { RunStatus::Running }, RunStatus::Completed);
    });
    const auto third_retry_logged = [&logs] {
        return !logs
                .with_msg_prefix (
                "Database locked during transition run status, "
                "retrying in 300ms (attempt 3, until it lands)")
                .empty ();
    };
    // Also ends on a write that gave up, so the broken build reports at once.
    const auto write_returned = [&landed] {
        return landed.wait_for (std::chrono::seconds (0)) == std::future_status::ready;
    };
    const bool waited = vayu::tests::wait_until (
    [&] { return third_retry_logged () || write_returned (); },
    vayu::tests::WAIT_DEADLINE, std::chrono::milliseconds (20));
    const bool retried_past_budget = waited && third_retry_logged ();
    sqlite3_exec (holder, "ROLLBACK;", nullptr, nullptr, nullptr);
    sqlite3_close (holder);

    EXPECT_TRUE (retried_past_budget)
    << "the terminal write gave up while the database was busy";
    const auto outcome = landed.get ();
    EXPECT_TRUE (outcome.applied);
    EXPECT_EQ (row (db, "held").status, RunStatus::Completed);
}

} // namespace
} // namespace vayu::db
