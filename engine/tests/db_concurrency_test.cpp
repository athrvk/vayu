/**
 * @file tests/db_concurrency_test.cpp
 * @brief Concurrency smoke test for the Database busy-retry restructuring.
 *
 * Guards the lock-scope change in issue #88: the shared retry_on_busy helper
 * serializes writes on the DB mutex but must release it before sleeping, and
 * the write paths must interleave safely with concurrent readers on the *same*
 * Database instance. Both retry shapes are exercised - add_metric_tick (a bare
 * retried insert) and add_results_batch (a transaction inside the retry), which
 * is the shape the retired EAV metric batch writer used to stand for here.
 *
 * This is a smoke test, not a busy-path test: injecting SQLITE_BUSY reliably
 * needs fault injection we deliberately do not build (see the issue). The value
 * here is proving the restructured locking neither deadlocks nor loses rows
 * under contention - the concurrency the recursive_mutex is there to tame.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <string>
#include <thread>
#include <vector>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"

namespace vayu::db {
namespace {

class DatabaseConcurrencyTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_db_concurrency.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<Database> (DB_PATH);
        db_->init ();

        vayu::db::Run run;
        run.id              = "run_1";
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Running;
        run.start_time      = 1000;
        run.config_snapshot = "{}";
        db_->create_run (run);
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    std::unique_ptr<Database> db_;
};

// N writers write ticks and batched results while M readers poll
// get_metric_ticks_since / get_run on the same Database. Passing means: no
// deadlock (the per-test ctest TIMEOUT is the deadlock backstop), no lost
// writes, and readers never crash mid-write.
TEST_F (DatabaseConcurrencyTest, ConcurrentBatchWritesAndReadsReconcile) {
    constexpr int kWriters          = 4;
    constexpr int kBatchesPerWriter = 25;
    constexpr int kRowsPerBatch     = 10;
    constexpr int kReaders          = 3;

    std::atomic<bool> writers_done{ false };
    std::atomic<int> reads_ok{ 0 };

    std::vector<std::thread> threads;
    threads.reserve (kWriters + kReaders);

    for (int w = 0; w < kWriters; ++w) {
        threads.emplace_back ([this, w] {
            for (int b = 0; b < kBatchesPerWriter; ++b) {
                // Retried single insert.
                for (int i = 0; i < kRowsPerBatch; ++i) {
                    vayu::db::MetricTick tick;
                    tick.run_id = "run_1";
                    tick.timestamp =
                    1000 + (w * kBatchesPerWriter + b) * kRowsPerBatch + i;
                    tick.payload = R"({"requests_completed":)" + std::to_string (i) + "}";
                    db_->add_metric_tick (tick);
                }

                // Transaction inside the retry - the other shape #88 covers.
                std::vector<Result> batch;
                batch.reserve (kRowsPerBatch);
                for (int i = 0; i < kRowsPerBatch; ++i) {
                    vayu::db::Result r;
                    r.run_id = "run_1";
                    r.timestamp = 1000 + (w * kBatchesPerWriter + b) * kRowsPerBatch + i;
                    r.status_code = 200;
                    r.latency_ms  = static_cast<double> (i);
                    batch.push_back (r);
                }
                db_->add_results_batch (batch);
            }
        });
    }

    for (int r = 0; r < kReaders; ++r) {
        threads.emplace_back ([this, &writers_done, &reads_ok] {
            while (!writers_done.load (std::memory_order_relaxed)) {
                // Both reader paths share the same mutex the writers hold; a
                // retry that slept under the lock would stall these.
                auto ticks = db_->get_metric_ticks_since ("run_1", 0);
                auto run   = db_->get_run ("run_1");
                if (run.has_value () &&
                ticks.size () <=
                static_cast<size_t> (kWriters * kBatchesPerWriter * kRowsPerBatch)) {
                    reads_ok.fetch_add (1, std::memory_order_relaxed);
                }
            }
        });
    }

    for (int w = 0; w < kWriters; ++w) {
        threads[static_cast<size_t> (w)].join ();
    }
    writers_done.store (true, std::memory_order_relaxed);
    for (int r = kWriters; r < kWriters + kReaders; ++r) {
        threads[static_cast<size_t> (r)].join ();
    }

    // Every row landed exactly once - no write lost to the interleaving.
    const auto expected = static_cast<size_t> (kWriters * kBatchesPerWriter * kRowsPerBatch);
    EXPECT_EQ (db_->get_metric_ticks_since ("run_1", 0).size (), expected);
    EXPECT_EQ (db_->count_metric_ticks ("run_1"), static_cast<int64_t> (expected));
    EXPECT_EQ (db_->get_results ("run_1").size (), expected);
    // Readers ran throughout and observed only consistent snapshots.
    EXPECT_GT (reads_ok.load (), 0);
}

} // namespace
} // namespace vayu::db
