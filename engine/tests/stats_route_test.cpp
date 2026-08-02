/**
 * @file tests/stats_route_test.cpp
 * @brief Tests for the time-series JSON core (run_time_series_response).
 *
 * This core backs both the canonical GET /runs/:id/metrics and the legacy
 * GET /stats/:id?format=json, so the two paths cannot drift. It must:
 *   - return a definitive 404 {"error": {"code", "message"}} for a missing run,
 *   - return 200 with an empty `data` array and a well-formed pagination
 *     envelope for a run that has no metrics yet,
 *   - serve each stored `metric_ticks` row as one `data[]` entry carrying the
 *     app's snake_case LoadTestMetrics fields (latency_p50_ms etc.), and
 *   - echo the caller-supplied limit/offset and compute `hasMore` correctly
 *     (the raw query-param clamping lives in the route; the core is handed
 *     clean ints).
 *
 * Covers the extracted core in isolation, matching the suite's other route
 * tests (no in-process HTTP server). Fixture style mirrors
 * requests_route_test.cpp (temp db file, cleanup of -wal/-shm/.bak).
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in metrics.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> run_time_series_response (vayu::db::Database& db,
const std::string& run_id, int64_t limit, int64_t offset);
} // namespace vayu::http::routes

namespace {

class StatsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_stats_route.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        for (const char* s : { "", "-wal", "-shm", ".bak" }) {
            std::filesystem::remove (std::string (DB_PATH) + s);
        }
    }

    // Persist a load run with the given id and return it.
    std::string seed_run (const std::string& id = "run_1") {
        vayu::db::Run run;
        run.id              = id;
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Completed;
        run.start_time      = 1000;
        run.end_time        = 3000;
        run.config_snapshot = "{}";
        db_->create_run (run);
        return id;
    }

    // Insert one wide tick row.
    void add_tick (const std::string& run_id, int64_t ts, const nlohmann::json& payload) {
        vayu::db::MetricTick tick;
        tick.id        = 0; // Auto-assigned by the DB.
        tick.run_id    = run_id;
        tick.timestamp = ts;
        tick.payload   = payload.dump ();
        db_->add_metric_tick (tick);
    }

    // The tick the producer would persist for one second of a run.
    static vayu::core::MetricTickSample sample_at (int64_t ts, double elapsed) {
        vayu::core::MetricTickSample sample;
        sample.timestamp           = ts;
        sample.elapsed_seconds     = elapsed;
        sample.requests_completed  = 10;
        sample.requests_failed     = 0;
        sample.current_rps         = 100.0;
        sample.current_concurrency = 4;
        sample.send_rate           = 101.5;
        sample.throughput          = 99.25;
        sample.backpressure        = 2;
        sample.error_rate          = 0.0;
        sample.dropped_requests    = 1;
        sample.bytes_sent          = 512;
        sample.bytes_received      = 4096;
        sample.status_codes        = { { 200, 10 } };
        sample.latency_p50_ms      = 5.0;
        sample.latency_p95_ms      = 8.0;
        sample.latency_p99_ms      = 12.0;
        return sample;
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (StatsRouteTest, MissingRunIs404) {
    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, "run_nope", 5000, 0);
    EXPECT_EQ (status, 404);
    ASSERT_TRUE (body.contains ("error"));
    EXPECT_EQ (body["error"]["code"], "not_found");
    EXPECT_EQ (body["error"]["message"], "Run not found");
}

TEST_F (StatsRouteTest, ExistingRunWithNoMetricsIs200WithEmptyEnvelope) {
    const std::string id = seed_run ();

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    EXPECT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("data"));
    EXPECT_TRUE (body["data"].is_array ());
    EXPECT_EQ (body["data"].size (), 0u);

    ASSERT_TRUE (body.contains ("pagination"));
    const auto& p = body["pagination"];
    EXPECT_EQ (p["total"].get<int64_t> (), 0);
    EXPECT_EQ (p["limit"].get<int64_t> (), 5000);
    EXPECT_EQ (p["offset"].get<int64_t> (), 0);
    EXPECT_EQ (p["returned"].get<int64_t> (), 0);
    EXPECT_FALSE (p["hasMore"].get<bool> ());
}

// ============================================================================
// The wide-row path (metric_ticks)
// ============================================================================

// The contract lock. Until issue #177 this was a byte-for-byte comparison
// against the legacy EAV reader's reassembly of the same tick - two independent
// implementations of one object, each checking the other. With the EAV reader
// deleted there is no second implementation left, so the contract is pinned
// directly instead: every key the app's `LoadTestMetrics` shape expects, with
// the JSON type it expects. A dropped, renamed or retyped field fails here.
TEST_F (StatsRouteTest, StoredTickPayloadKeysAndTypesArePinned) {
    const std::string id = seed_run ();
    const auto sample    = sample_at (1000, 0.0);
    add_tick (id, sample.timestamp, vayu::core::build_metric_tick_payload (sample));

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    const auto& entry = body["data"][0];

    // Exactly these keys - no more, no fewer. An added field is as much a
    // contract change as a dropped one, so the count is asserted too.
    const std::vector<std::pair<std::string, nlohmann::json::value_t>> expected = {
        // Every integer here comes back unsigned: the payload is stored as
        // text and re-parsed, and nlohmann types a non-negative integer
        // literal as number_unsigned.
        { "timestamp", nlohmann::json::value_t::number_unsigned },
        { "elapsed_seconds", nlohmann::json::value_t::number_float },
        { "requests_completed", nlohmann::json::value_t::number_unsigned },
        { "requests_failed", nlohmann::json::value_t::number_unsigned },
        { "current_rps", nlohmann::json::value_t::number_float },
        { "current_concurrency", nlohmann::json::value_t::number_unsigned },
        { "send_rate", nlohmann::json::value_t::number_float },
        { "throughput", nlohmann::json::value_t::number_float },
        { "backpressure", nlohmann::json::value_t::number_unsigned },
        { "error_rate", nlohmann::json::value_t::number_float },
        { "dropped_requests", nlohmann::json::value_t::number_unsigned },
        { "bytes_sent", nlohmann::json::value_t::number_unsigned },
        { "bytes_received", nlohmann::json::value_t::number_unsigned },
        { "status_codes", nlohmann::json::value_t::object },
        { "latency_p50_ms", nlohmann::json::value_t::number_float },
        { "latency_p95_ms", nlohmann::json::value_t::number_float },
        { "latency_p99_ms", nlohmann::json::value_t::number_float },
    };

    EXPECT_EQ (entry.size (), expected.size ())
    << "the tick payload gained or lost a key: " << entry.dump ();
    for (const auto& [key, type] : expected) {
        ASSERT_TRUE (entry.contains (key)) << "missing key: " << key;
        EXPECT_EQ (entry[key].type (), type)
        << "key " << key << " changed JSON type: " << entry[key].dump ();
    }

    // The values survive the round trip, not just the shape.
    EXPECT_EQ (entry["timestamp"].get<int64_t> (), 1000);
    EXPECT_EQ (entry["requests_completed"].get<int> (), 10);
    EXPECT_DOUBLE_EQ (entry["current_rps"].get<double> (), 100.0);
    EXPECT_DOUBLE_EQ (entry["latency_p50_ms"].get<double> (), 5.0);
    EXPECT_EQ (entry["status_codes"]["200"].get<size_t> (), 10u);
}

// Pagination is by tick, so a page boundary can never hand back a bucket with
// half its fields zeroed - the defect that made row-pagination unusable.
TEST_F (StatsRouteTest, TickPaginationNeverSplitsATick) {
    const std::string id = seed_run ();
    for (int i = 0; i < 3; ++i) {
        auto sample = sample_at (1000 + i * 1000, static_cast<double> (i));
        add_tick (id, sample.timestamp, vayu::core::build_metric_tick_payload (sample));
    }

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 2, 0);
    EXPECT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 2u);

    // Both entries on the page are whole ticks, not partially-populated ones.
    for (const auto& entry : body["data"]) {
        EXPECT_DOUBLE_EQ (entry["current_rps"].get<double> (), 100.0);
        EXPECT_EQ (entry["requests_completed"].get<int> (), 10);
        EXPECT_DOUBLE_EQ (entry["latency_p50_ms"].get<double> (), 5.0);
        EXPECT_EQ (entry["status_codes"]["200"].get<size_t> (), 10u);
    }

    // The envelope counts ticks, not rows.
    const auto& pag = body["pagination"];
    EXPECT_EQ (pag["total"].get<int64_t> (), 3);
    EXPECT_EQ (pag["returned"].get<int64_t> (), 2);
    EXPECT_TRUE (pag["hasMore"].get<bool> ());

    auto [status2, body2] =
    vayu::http::routes::run_time_series_response (*db_, id, 2, 2);
    EXPECT_EQ (status2, 200);
    ASSERT_EQ (body2["data"].size (), 1u);
    EXPECT_EQ (body2["data"][0]["timestamp"].get<int64_t> (), 3000);
    EXPECT_FALSE (body2["pagination"]["hasMore"].get<bool> ());
    // elapsed_seconds keeps counting from the run's first tick across pages.
    EXPECT_DOUBLE_EQ (body2["data"][0]["elapsed_seconds"].get<double> (), 2.0);
}

// requests_failed is written by the producer, which knows the error count -
// it is no longer derived at read time from error_rate and requests_completed,
// which is what used to report 0 failures for every bucket.
TEST_F (StatsRouteTest, StoredTickCarriesTheProducersFailedCount) {
    const std::string id   = seed_run ();
    auto sample            = sample_at (1000, 0.0);
    sample.requests_failed = 3;
    sample.error_rate      = 30.0;
    add_tick (id, sample.timestamp, vayu::core::build_metric_tick_payload (sample));

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["requests_failed"].get<int> (), 3);
    EXPECT_DOUBLE_EQ (body["data"][0]["error_rate"].get<double> (), 30.0);
}

// A damaged payload costs its own tick, not the whole page.
TEST_F (StatsRouteTest, UnreadableTickPayloadIsSkippedNotFatal) {
    const std::string id = seed_run ();
    auto sample          = sample_at (1000, 0.0);
    add_tick (id, sample.timestamp, vayu::core::build_metric_tick_payload (sample));

    vayu::db::MetricTick corrupt;
    corrupt.run_id    = id;
    corrupt.timestamp = 2000;
    corrupt.payload   = "{not json";
    db_->add_metric_tick (corrupt);

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    EXPECT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["timestamp"].get<int64_t> (), 1000);
    // The row still counts for pagination - the page really did consume it.
    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 2);
    EXPECT_EQ (body["pagination"]["returned"].get<int64_t> (), 2);
}

} // namespace
