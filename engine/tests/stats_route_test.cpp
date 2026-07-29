/**
 * @file tests/stats_route_test.cpp
 * @brief Tests for the time-series JSON core (run_time_series_response).
 *
 * This core backs both the canonical GET /runs/:id/metrics and the legacy
 * GET /stats/:id?format=json, so the two paths cannot drift. It must:
 *   - return a definitive 404 {"error": ...} for a missing run,
 *   - return 200 with an empty `data` array and a well-formed pagination
 *     envelope for a run that has no metrics yet,
 *   - group Metric rows into per-timestamp tick buckets carrying the app's
 *     snake_case LoadTestMetrics fields (latency_p50_ms etc.), and
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

    // Insert one metric row.
    void add (const std::string& run_id,
    int64_t ts,
    vayu::MetricName name,
    double value,
    const std::string& labels = "") {
        vayu::db::Metric m;
        m.id        = 0; // Auto-assigned by the DB.
        m.run_id    = run_id;
        m.timestamp = ts;
        m.name      = name;
        m.value     = value;
        m.labels    = labels;
        db_->add_metric (m);
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

    // The same tick, written as the EAV rows the old producer emitted.
    void add_legacy_rows_for (const std::string& run_id, const vayu::core::MetricTickSample& s) {
        add (run_id, s.timestamp, vayu::MetricName::Rps, s.current_rps);
        add (run_id, s.timestamp, vayu::MetricName::ErrorRate, s.error_rate);
        add (run_id, s.timestamp, vayu::MetricName::ConnectionsActive,
        static_cast<double> (s.current_concurrency));
        add (run_id, s.timestamp, vayu::MetricName::RequestsSent,
        static_cast<double> (s.requests_completed));
        add (run_id, s.timestamp, vayu::MetricName::SendRate, s.send_rate);
        add (run_id, s.timestamp, vayu::MetricName::Throughput, s.throughput);
        add (run_id, s.timestamp, vayu::MetricName::Backpressure,
        static_cast<double> (s.backpressure));
        add (run_id, s.timestamp, vayu::MetricName::DroppedRequests,
        static_cast<double> (s.dropped_requests));
        add (run_id, s.timestamp, vayu::MetricName::BytesSent,
        static_cast<double> (s.bytes_sent));
        add (run_id, s.timestamp, vayu::MetricName::BytesReceived,
        static_cast<double> (s.bytes_received));
        add (run_id, s.timestamp, vayu::MetricName::LatencyP50, s.latency_p50_ms);
        add (run_id, s.timestamp, vayu::MetricName::LatencyP95, s.latency_p95_ms);
        add (run_id, s.timestamp, vayu::MetricName::LatencyP99, s.latency_p99_ms);
        nlohmann::json codes = nlohmann::json::object ();
        for (const auto& [code, count] : s.status_codes) {
            codes[std::to_string (code)] = count;
        }
        add (run_id, s.timestamp, vayu::MetricName::StatusCodes, 0.0, codes.dump ());
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (StatsRouteTest, MissingRunIs404) {
    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, "run_nope", 5000, 0);
    EXPECT_EQ (status, 404);
    ASSERT_TRUE (body.contains ("error"));
    EXPECT_TRUE (body["error"].is_string ());
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

TEST_F (StatsRouteTest, SeededRunGroupsIntoTickBuckets) {
    const std::string id = seed_run ();

    // Two ticks. Latency percentiles are the unlabeled (windowed) rows the
    // series reads; a labeled cumulative row must be skipped.
    add (id, 1000, vayu::MetricName::Rps, 100.0);
    add (id, 1000, vayu::MetricName::TotalRequests, 10.0);
    add (id, 1000, vayu::MetricName::LatencyP50, 5.0);       // unlabeled -> read
    add (id, 1000, vayu::MetricName::LatencyP95, 8.0);       // unlabeled -> read
    add (id, 1000, vayu::MetricName::LatencyP50, 999.0, "{\"cumulative\":true}"); // labeled -> skipped
    add (id, 2000, vayu::MetricName::Rps, 200.0);
    add (id, 2000, vayu::MetricName::TotalRequests, 20.0);
    add (id, 2000, vayu::MetricName::LatencyP99, 12.0);      // unlabeled -> read

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    EXPECT_EQ (status, 200);

    ASSERT_TRUE (body["data"].is_array ());
    ASSERT_EQ (body["data"].size (), 2u); // two distinct timestamps -> two buckets

    const auto& first = body["data"][0];
    EXPECT_EQ (first["timestamp"].get<int64_t> (), 1000);
    EXPECT_DOUBLE_EQ (first["elapsed_seconds"].get<double> (), 0.0);
    EXPECT_DOUBLE_EQ (first["current_rps"].get<double> (), 100.0);
    EXPECT_EQ (first["requests_completed"].get<int> (), 10);
    // The windowed p50 wins; the labeled cumulative 999.0 row is skipped.
    EXPECT_DOUBLE_EQ (first["latency_p50_ms"].get<double> (), 5.0);
    EXPECT_DOUBLE_EQ (first["latency_p95_ms"].get<double> (), 8.0);

    const auto& second = body["data"][1];
    EXPECT_EQ (second["timestamp"].get<int64_t> (), 2000);
    EXPECT_DOUBLE_EQ (second["elapsed_seconds"].get<double> (), 1.0);
    EXPECT_DOUBLE_EQ (second["current_rps"].get<double> (), 200.0);
    EXPECT_EQ (second["requests_completed"].get<int> (), 20);
    EXPECT_DOUBLE_EQ (second["latency_p99_ms"].get<double> (), 12.0);

    // Pagination envelope for the full page.
    const auto& p = body["pagination"];
    EXPECT_EQ (p["total"].get<int64_t> (), 8);
    EXPECT_EQ (p["returned"].get<int64_t> (), 8);
    EXPECT_FALSE (p["hasMore"].get<bool> ());
}

TEST_F (StatsRouteTest, HonorsLimitAndOffsetForPagination) {
    const std::string id = seed_run ();
    for (int i = 0; i < 5; ++i) {
        add (id, 1000 + i, vayu::MetricName::Rps, static_cast<double> (i));
    }

    // First page of 2 of 5: echoes limit/offset, reports hasMore.
    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 2, 0);
    EXPECT_EQ (status, 200);
    const auto& p = body["pagination"];
    EXPECT_EQ (p["total"].get<int64_t> (), 5);
    EXPECT_EQ (p["limit"].get<int64_t> (), 2);
    EXPECT_EQ (p["offset"].get<int64_t> (), 0);
    EXPECT_EQ (p["returned"].get<int64_t> (), 2);
    EXPECT_TRUE (p["hasMore"].get<bool> ());

    // Last page (offset 4): one row left, no more.
    auto [status2, body2] =
    vayu::http::routes::run_time_series_response (*db_, id, 2, 4);
    EXPECT_EQ (status2, 200);
    const auto& p2 = body2["pagination"];
    EXPECT_EQ (p2["offset"].get<int64_t> (), 4);
    EXPECT_EQ (p2["returned"].get<int64_t> (), 1);
    EXPECT_FALSE (p2["hasMore"].get<bool> ());
}

// ============================================================================
// The wide-row path (metric_ticks)
// ============================================================================

// The contract lock: for one and the same tick, the object a stored payload
// yields is byte-identical to the one the legacy EAV reader reassembles. If the
// payload builder ever drops, renames or retypes a field, this fails.
TEST_F (StatsRouteTest, StoredTickMatchesTheLegacyBucketByteForByte) {
    seed_run ("run_new");
    seed_run ("run_legacy");

    const auto sample = sample_at (1000, 0.0);
    add_tick ("run_new", sample.timestamp, vayu::core::build_metric_tick_payload (sample));
    add_legacy_rows_for ("run_legacy", sample);

    auto [new_status, new_body] =
    vayu::http::routes::run_time_series_response (*db_, "run_new", 5000, 0);
    auto [legacy_status, legacy_body] =
    vayu::http::routes::run_time_series_response (*db_, "run_legacy", 5000, 0);
    ASSERT_EQ (new_status, 200);
    ASSERT_EQ (legacy_status, 200);
    ASSERT_EQ (new_body["data"].size (), 1u);
    ASSERT_EQ (legacy_body["data"].size (), 1u);

    EXPECT_EQ (new_body["data"][0].dump (), legacy_body["data"][0].dump ());
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

// requests_failed is written by the producer, which knows the error count. The
// legacy reader instead derives it from error_rate and requests_completed, and
// used to read requests_completed as 0 because the producer emits ErrorRate
// first - so it reported 0 failures for every bucket until #169 made the
// derivation order-independent. Both sides are asserted rather than just the
// new one: they are two independent producers of the same field, and this is
// what catches either drifting from the other.
TEST_F (StatsRouteTest, StoredTickAndLegacyRowsAgreeOnTheFailedCount) {
    seed_run ("run_new");
    seed_run ("run_legacy");

    auto sample                = sample_at (1000, 0.0);
    sample.requests_failed     = 3;
    sample.error_rate          = 30.0;
    add_tick ("run_new", sample.timestamp, vayu::core::build_metric_tick_payload (sample));
    add_legacy_rows_for ("run_legacy", sample);

    auto [_, new_body] =
    vayu::http::routes::run_time_series_response (*db_, "run_new", 5000, 0);
    auto [__, legacy_body] =
    vayu::http::routes::run_time_series_response (*db_, "run_legacy", 5000, 0);

    EXPECT_EQ (new_body["data"][0]["requests_failed"].get<int> (), 3);
    EXPECT_EQ (legacy_body["data"][0]["requests_failed"].get<int> (), 3);
}

// A run that has ticks is served from them even if legacy rows exist too -
// otherwise a re-run against an upgraded engine could mix the two shapes.
TEST_F (StatsRouteTest, TicksWinOverLegacyRowsForTheSameRun) {
    const std::string id = seed_run ();
    auto sample          = sample_at (1000, 0.0);
    add_tick (id, sample.timestamp, vayu::core::build_metric_tick_payload (sample));
    add (id, 9000, vayu::MetricName::Rps, 777.0);

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    EXPECT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["timestamp"].get<int64_t> (), 1000);
    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 1);
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

// requests_failed is derived from error_rate and requests_completed, both of
// which arrive as separate rows of the same tick. The producer
// (run_manager.cpp) always inserts ErrorRate *before* RequestsSent, so a
// derivation done while folding in the ErrorRate row read requests_completed as
// its initial 0 and stored 0 failed requests for every bucket of every run -
// which is what the history error-rate chart and the failed-requests stat show.
// Insert in exactly that production order.
TEST_F (StatsRouteTest, RequestsFailedIsDerivedRegardlessOfRowOrderWithinATick) {
    const std::string id = seed_run ();
    const int64_t ts     = 2000;

    add (id, ts, vayu::MetricName::Rps, 50.0);
    add (id, ts, vayu::MetricName::ErrorRate, 25.0);
    add (id, ts, vayu::MetricName::ConnectionsActive, 4.0);
    add (id, ts, vayu::MetricName::RequestsSent, 200.0);

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);

    const auto& bucket = body["data"][0];
    EXPECT_DOUBLE_EQ (bucket["error_rate"].get<double> (), 25.0);
    EXPECT_EQ (bucket["requests_completed"].get<int> (), 200);
    EXPECT_EQ (bucket["requests_failed"].get<int> (), 50);
}

// A tick with errors but a sub-1% rate must not round down to "no failures".
TEST_F (StatsRouteTest, RequestsFailedIsNonZeroForASmallButRealErrorRate) {
    const std::string id = seed_run ();
    const int64_t ts     = 2000;

    add (id, ts, vayu::MetricName::ErrorRate, 0.1);
    add (id, ts, vayu::MetricName::RequestsSent, 1000.0);

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["requests_failed"].get<int> (), 1);
}

// A clean tick stays clean - the second pass must not invent failures.
TEST_F (StatsRouteTest, RequestsFailedIsZeroWhenTheErrorRateIsZero) {
    const std::string id = seed_run ();
    const int64_t ts     = 2000;

    add (id, ts, vayu::MetricName::ErrorRate, 0.0);
    add (id, ts, vayu::MetricName::RequestsSent, 500.0);

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["requests_failed"].get<int> (), 0);
}

} // namespace
