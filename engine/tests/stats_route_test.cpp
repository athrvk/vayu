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

} // namespace
