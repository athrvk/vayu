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
 *
 * The add_results_batch tests at the end guard its chunked write (#2548): one
 * transaction per chunk, the mutex released between them.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <map>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "wait_until.hpp"

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
                    1000 + (((w * kBatchesPerWriter) + b) * kRowsPerBatch) + i;
                    tick.payload = R"({"requests_completed":)" + std::to_string (i) + "}";
                    db_->add_metric_tick (tick);
                }

                // Transaction inside the retry - the other shape #88 covers.
                std::vector<Result> batch;
                batch.reserve (kRowsPerBatch);
                for (int i = 0; i < kRowsPerBatch; ++i) {
                    vayu::db::Result r;
                    r.run_id = "run_1";
                    r.timestamp =
                    1000 + (((w * kBatchesPerWriter) + b) * kRowsPerBatch) + i;
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
                ticks.size () <= static_cast<size_t> (kWriters) * kBatchesPerWriter * kRowsPerBatch) {
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
    const auto expected = static_cast<size_t> (kWriters) * kBatchesPerWriter * kRowsPerBatch;
    EXPECT_EQ (db_->get_metric_ticks_since ("run_1", 0).size (), expected);
    EXPECT_EQ (db_->count_metric_ticks ("run_1"), static_cast<int64_t> (expected));
    EXPECT_EQ (db_->get_results ("run_1").size (), expected);
    // Readers ran throughout and observed only consistent snapshots.
    EXPECT_GT (reads_ok.load (), 0);
}

Result result_at (size_t index) {
    Result result;
    result.run_id      = "run_1";
    result.timestamp   = 1000 + static_cast<int64_t> (index);
    result.status_code = 200;
    // The index travels in the row so a reader can tell which input it was.
    result.latency_ms = static_cast<double> (index);
    return result;
}

std::string body_at (size_t index) {
    return index % 2 == 0 ? std::string ("shared") : "body-" + std::to_string (index);
}

// add_results_batch writes in chunks (#2548). A body must still land on its own
// result when its index is in a later chunk than the first, and identical
// bodies must share one blob row across chunks, not one per chunk.
TEST_F (DatabaseConcurrencyTest, ChunkedBatchAttachesEveryBodyAndSharesBlobsAcrossChunks) {
    constexpr size_t chunk = vayu::core::constants::database::RESULTS_WRITE_CHUNK_ROWS;
    constexpr size_t count = (3 * chunk) + 7; // three whole chunks and a remainder

    std::vector<Result> results;
    results.reserve (count);
    std::vector<PendingResultBody> bodies;
    bodies.reserve (count + 1);
    for (size_t i = 0; i < count; ++i) {
        results.push_back (result_at (i));
    }
    // Reverse order, so attachment cannot depend on the bodies arriving
    // sorted by result.
    for (size_t i = count; i-- > 0;) {
        PendingResultBody pending;
        pending.result_index = i;
        pending.headers      = R"({"x-index":")" + std::to_string (i) + R"("})";
        pending.body         = body_at (i);
        pending.body_hash    = "hash-" + pending.body;
        pending.body_bytes   = static_cast<int64_t> (pending.body.size ());
        bodies.push_back (std::move (pending));
    }
    PendingResultBody orphan; // an index past the batch has nothing to attach to
    orphan.result_index = count;
    orphan.body         = "orphan";
    orphan.body_hash    = "hash-orphan";
    bodies.push_back (orphan);

    db_->add_results_batch (results, bodies);

    const auto stored = db_->get_results ("run_1");
    ASSERT_EQ (stored.size (), count);
    std::map<int, size_t> index_of_result;
    for (const auto& result : stored) {
        index_of_result.emplace (result.id, static_cast<size_t> (result.latency_ms));
    }

    const auto rows = db_->get_result_bodies_paginated ("run_1", count + 10, 0);
    ASSERT_EQ (rows.size (), count)
    << "one body row per result, and none for the orphan";
    std::set<int> shared_blob_ids;
    for (const auto& row : rows) {
        const auto found = index_of_result.find (row.result_id);
        ASSERT_NE (found, index_of_result.end ())
        << "a body row points at no result";
        const size_t index = found->second;
        EXPECT_EQ (row.headers, R"({"x-index":")" + std::to_string (index) + R"("})");
        EXPECT_EQ (db_->get_body_blob_content (row.blob_id), body_at (index));
        if (index % 2 == 0) {
            shared_blob_ids.insert (row.blob_id);
        }
    }
    EXPECT_EQ (shared_blob_ids.size (), 1u)
    << "the shared body spans every chunk and must be stored once";
}

// The point of chunking (#2548): a reader polling while a flush is written gets
// the mutex between two chunks and sees part of the batch, instead of waiting
// out the whole flush and seeing all of it. A single transaction can only ever
// show it none or all, and so, nearly always, can chunks whose writer re-locks
// without stepping away (CHUNK_HANDOFF_PAUSE in db_runs.cpp).
TEST_F (DatabaseConcurrencyTest, ChunkedBatchLetsAReaderInBetweenChunks) {
    constexpr size_t count = 20 * vayu::core::constants::database::RESULTS_WRITE_CHUNK_ROWS;
    std::vector<Result> results;
    results.reserve (count);
    for (size_t i = 0; i < count; ++i) {
        results.push_back (result_at (i));
    }

    std::thread writer ([this, &results] { db_->add_results_batch (results); });

    size_t observed = 0;
    // Ends on the first partial read, or on the whole batch, which means the
    // reader never got in while it was being written.
    const bool settled = vayu::tests::wait_until ([&] {
        observed = db_->get_results_without_traces ("run_1").size ();
        return observed > 0;
    });
    writer.join ();

    ASSERT_TRUE (settled) << "the writer stored nothing";
    EXPECT_LT (observed, count)
    << "the reader saw only the finished batch, never one between chunks";
    EXPECT_EQ (db_->get_results_without_traces ("run_1").size (), count);
}

} // namespace
} // namespace vayu::db
