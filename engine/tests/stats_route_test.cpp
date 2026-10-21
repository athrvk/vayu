/**
 * @file tests/stats_route_test.cpp
 * @brief Tests for the time-series JSON core (run_time_series_response).
 *
 * This core backs GET /runs/:id/metrics. It must:
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

#include <algorithm>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in metrics.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> run_monitor_series_response (vayu::db::Database& db,
const std::string& run_id,
int64_t limit,
int64_t offset);
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
        vayu::tests::remove_database_files (DB_PATH);
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
        sample.timestamp                = ts;
        sample.elapsed_seconds          = elapsed;
        sample.requests_completed       = 10;
        sample.requests_failed          = 0;
        sample.current_rps              = 100.0;
        sample.current_send_rate        = 101.0;
        sample.window_avg_latency_ms    = 7.5;
        sample.window_avg_queue_wait_ms = 0.25;
        sample.current_concurrency      = 4;
        sample.send_rate                = 101.5;
        sample.throughput               = 99.25;
        sample.backpressure             = 2;
        sample.error_rate               = 0.0;
        sample.dropped_requests         = 1;
        sample.bytes_sent               = 512;
        sample.bytes_received           = 4096;
        sample.status_codes             = { { 200, 10 } };
        sample.latency_p50_ms           = 5.0;
        sample.latency_p95_ms           = 8.0;
        sample.latency_p99_ms           = 12.0;
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
        { "http_errors", nlohmann::json::value_t::number_unsigned },
        { "no_response", nlohmann::json::value_t::number_unsigned },
        { "cancelled", nlohmann::json::value_t::number_unsigned },
        { "current_rps", nlohmann::json::value_t::number_float },
        { "current_send_rate", nlohmann::json::value_t::number_float },
        { "window_avg_latency_ms", nlohmann::json::value_t::number_float },
        { "window_avg_queue_wait_ms", nlohmann::json::value_t::number_float },
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
    EXPECT_DOUBLE_EQ (entry["current_send_rate"].get<double> (), 101.0);
    EXPECT_DOUBLE_EQ (entry["window_avg_latency_ms"].get<double> (), 7.5);
    EXPECT_DOUBLE_EQ (entry["window_avg_queue_wait_ms"].get<double> (), 0.25);
    EXPECT_DOUBLE_EQ (entry["latency_p50_ms"].get<double> (), 5.0);
    EXPECT_EQ (entry["status_codes"]["200"].get<size_t> (), 10u);
}

// #2393: a window that completed nothing has no mean. The keys stay, as null,
// so a reader tells an idle window from a row stored before the keys existed.
TEST_F (StatsRouteTest, AnIdleWindowStoresItsMeansAsNull) {
    const std::string id = seed_run ();
    auto sample          = sample_at (1000, 0.0);
    sample.window_avg_latency_ms.reset ();
    sample.window_avg_queue_wait_ms.reset ();
    add_tick (id, sample.timestamp, vayu::core::build_metric_tick_payload (sample));

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    const auto& entry = body["data"][0];
    for (const auto* key : { "window_avg_latency_ms", "window_avg_queue_wait_ms" }) {
        ASSERT_TRUE (entry.contains (key)) << key << ": " << entry.dump ();
        EXPECT_TRUE (entry[key].is_null ()) << key << ": " << entry.dump ();
    }
}

// Pagination is by tick, so a page boundary can never hand back a bucket with
// half its fields zeroed - the defect that made row-pagination unusable.
TEST_F (StatsRouteTest, TickPaginationNeverSplitsATick) {
    const std::string id = seed_run ();
    for (int i = 0; i < 3; ++i) {
        auto sample = sample_at (1000 + (i * 1000), static_cast<double> (i));
        add_tick (id, sample.timestamp, vayu::core::build_metric_tick_payload (sample));
    }

    auto [status, body] = vayu::http::routes::run_time_series_response (*db_, id, 2, 0);
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
    sample.http_errors     = 2;
    sample.no_response     = 1;
    sample.error_rate      = 30.0;
    add_tick (id, sample.timestamp, vayu::core::build_metric_tick_payload (sample));

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["requests_failed"].get<int> (), 3);
    EXPECT_EQ (body["data"][0]["http_errors"].get<int> (), 2);
    EXPECT_EQ (body["data"][0]["no_response"].get<int> (), 1);
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

// This run's custom metrics (issue #1500), snapshotted into the tick the same
// way every other field here is - absent by default (StoredTickPayloadKeysAndTypesArePinned
// already pins that `sample_at`'s default carries no `custom_metrics` key at all), present
// and correctly shaped when the collector recorded something.
TEST_F (StatsRouteTest, TickCarriesCustomMetricsWhenTheRunRecordedAny) {
    const std::string id = seed_run ();
    auto sample          = sample_at (1000, 0.0);
    vayu::core::CustomMetricSummary trend;
    trend.type            = vayu::core::CustomMetricType::Trend;
    trend.count           = 7;
    trend.p95             = 40.0;
    sample.custom_metrics = { { "ttfb2", trend } };
    add_tick (id, sample.timestamp, vayu::core::build_metric_tick_payload (sample));

    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    const auto& custom = body["data"][0]["custom_metrics"];
    ASSERT_TRUE (custom.contains ("ttfb2"));
    EXPECT_EQ (custom["ttfb2"]["type"], "trend");
    EXPECT_EQ (custom["ttfb2"]["count"].get<size_t> (), 7u);
    EXPECT_DOUBLE_EQ (custom["ttfb2"]["p95"].get<double> (), 40.0);
}

// ============================================================================
// Downsampling: maxPoints (#2547)
// ============================================================================

// A cumulative tick the way the producer writes them: tick @p i of a run that
// completes ten requests a second, all 200s.
nlohmann::json cumulative_tick (int i) {
    const auto completed       = 10 * (static_cast<size_t> (i) + 1);
    auto sample                = vayu::core::MetricTickSample{};
    sample.timestamp           = 1000 + (static_cast<int64_t> (i) * 1000);
    sample.elapsed_seconds     = static_cast<double> (i);
    sample.requests_completed  = completed;
    sample.current_rps         = 10.0;
    sample.current_concurrency = 4;
    sample.backpressure        = 2;
    sample.bytes_received      = completed * 100;
    sample.status_codes        = { { 200, completed } };
    sample.latency_p50_ms      = 5.0;
    sample.latency_p95_ms      = 8.0;
    sample.latency_p99_ms      = 12.0;
    return vayu::core::build_metric_tick_payload (sample);
}

// The folding rules, on the helper alone.
TEST (MetricTickBucket, CumulativeFieldsComeFromTheLastTick) {
    vayu::http::routes::MetricTickBucket bucket;
    for (int i = 0; i < 4; ++i) {
        auto tick = cumulative_tick (i);
        tick["custom_metrics"]["orders"] = { { "type", "counter" }, { "count", i + 1 } };
        tick["a_key_this_engine_never_wrote"] = i;
        bucket.add (std::move (tick));
    }
    const auto folded = bucket.take ();
    EXPECT_EQ (folded["requests_completed"].get<size_t> (), 40u);
    EXPECT_EQ (folded["bytes_received"].get<size_t> (), 4000u);
    EXPECT_EQ (folded["timestamp"].get<int64_t> (), 4000);
    EXPECT_DOUBLE_EQ (folded["elapsed_seconds"].get<double> (), 3.0);
    EXPECT_EQ (folded["status_codes"], json ({ { "200", 40 } }));
    EXPECT_EQ (folded["custom_metrics"]["orders"]["count"].get<int> (), 4);
    EXPECT_EQ (folded["a_key_this_engine_never_wrote"].get<int> (), 3);
    EXPECT_TRUE (bucket.empty ());
}

TEST (MetricTickBucket, PeaksAreTheMaxAndCurrentRpsIsTheMean) {
    vayu::http::routes::MetricTickBucket bucket;
    const std::vector<double> rps         = { 10.0, 20.0, 60.0 };
    const std::vector<size_t> concurrency = { 1, 9, 2 };
    const std::vector<size_t> backlog     = { 7, 0, 3 };
    const std::vector<double> p99         = { 12.0, 900.0, 11.0 };
    for (size_t i = 0; i < rps.size (); ++i) {
        auto tick                   = cumulative_tick (static_cast<int> (i));
        tick["current_rps"]         = rps[i];
        tick["current_concurrency"] = concurrency[i];
        tick["backpressure"]        = backlog[i];
        tick["latency_p99_ms"]      = p99[i];
        tick["latency_p50_ms"]      = i == 2 ? 6.0 : 5.0;
        bucket.add (std::move (tick));
    }
    const auto folded = bucket.take ();
    EXPECT_DOUBLE_EQ (folded["current_rps"].get<double> (), 30.0);
    EXPECT_EQ (folded["current_concurrency"].get<size_t> (), 9u);
    EXPECT_EQ (folded["backpressure"].get<size_t> (), 7u);
    EXPECT_DOUBLE_EQ (folded["latency_p99_ms"].get<double> (), 900.0);
    EXPECT_DOUBLE_EQ (folded["latency_p95_ms"].get<double> (), 8.0);
    EXPECT_DOUBLE_EQ (folded["latency_p50_ms"].get<double> (), 6.0);
}

// The trailing-window keys (#2393) are per-second readings, so a bucket of many
// seconds holds their mean, not the last second's. An idle second's null mean
// is skipped; a bucket of nothing but idle seconds keeps null.
TEST (MetricTickBucket, WindowKeysAreMeansAndIdleSecondsAreSkipped) {
    vayu::http::routes::MetricTickBucket bucket;
    const std::vector<double> send_rate = { 100.0, 0.0, 200.0 };
    for (size_t i = 0; i < send_rate.size (); ++i) {
        auto tick                 = cumulative_tick (static_cast<int> (i));
        tick["current_send_rate"] = send_rate[i];
        tick["window_avg_latency_ms"] =
        i == 1 ? nlohmann::json (nullptr) : nlohmann::json (i == 0 ? 10.0 : 30.0);
        tick["window_avg_queue_wait_ms"] = nullptr;
        bucket.add (std::move (tick));
    }
    const auto folded = bucket.take ();
    EXPECT_DOUBLE_EQ (folded["current_send_rate"].get<double> (), 100.0);
    EXPECT_DOUBLE_EQ (folded["window_avg_latency_ms"].get<double> (), 20.0);
    EXPECT_TRUE (folded["window_avg_queue_wait_ms"].is_null ());
}

// A row an older engine stored lacks keys a newer one writes; folding must not
// invent them, the peak and mean keys included.
TEST (MetricTickBucket, KeysNoTickCarriedAreNeverAdded) {
    vayu::http::routes::MetricTickBucket bucket;
    for (int i = 0; i < 3; ++i) {
        auto tick = cumulative_tick (i);
        for (const auto* key :
        { "http_errors", "no_response", "cancelled", "backpressure", "current_rps" }) {
            tick.erase (key);
        }
        bucket.add (std::move (tick));
    }
    const auto folded = bucket.take ();
    for (const auto* key : { "http_errors", "no_response", "cancelled",
         "backpressure", "current_rps", "custom_metrics" }) {
        EXPECT_FALSE (folded.contains (key)) << "synthesized " << key;
    }
    EXPECT_EQ (folded["requests_completed"].get<size_t> (), 30u);
}

TEST (MetricTickBucket, ABucketOfOneTickIsThatTickUnchanged) {
    vayu::http::routes::MetricTickBucket bucket;
    auto tick           = cumulative_tick (0);
    tick["current_rps"] = 7; // An integer stays an integer.
    bucket.add (tick);
    EXPECT_EQ (bucket.take ().dump (), tick.dump ());
}

TEST (MetricTickBucket, MaxPointsParsesLikeTheOtherParameters) {
    using vayu::http::routes::parse_max_points;
    EXPECT_EQ (parse_max_points ("200"), std::optional<int64_t> (200));
    EXPECT_EQ (parse_max_points ("1"), std::optional<int64_t> (1));
    EXPECT_EQ (parse_max_points ("9999999"),
    std::optional<int64_t> (vayu::http::routes::RUN_TIME_SERIES_PAGE_MAX));
    for (const auto* raw : { "", "0", "-5", "abc", "42abc", " 7", "1.5" }) {
        EXPECT_FALSE (parse_max_points (raw).has_value ()) << "'" << raw << "'";
    }
}

// The wiring, through the route core. The long series is 5005 ticks because it
// has to cross metrics.cpp's 5000-row read chunk with a bucket straddling the
// edge; that is the smallest series that does, and the other route tests stay
// at a handful of rows because each tick is its own insert.
TEST_F (StatsRouteTest, MaxPointsFoldsTheWholeSeriesAcrossReadChunks) {
    const std::string id = seed_run ();
    constexpr int TICKS  = 5005;
    for (int i = 0; i < TICKS; ++i) {
        auto tick = cumulative_tick (i);
        if (i == 4999) { // Last row of the first read chunk.
            tick["latency_p99_ms"] = 900.0;
        }
        if (i == 5002) { // Same bucket, second read chunk.
            tick["current_concurrency"] = 64;
        }
        add_tick (id, tick["timestamp"].get<int64_t> (), tick);
    }

    // limit and offset are ignored once maxPoints is set.
    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 2, 7, 455);
    ASSERT_EQ (status, 200);
    EXPECT_TRUE (body["bucketed"].get<bool> ());
    EXPECT_EQ (body["ticksPerBucket"].get<int64_t> (), 11);
    const auto& pag = body["pagination"];
    EXPECT_EQ (pag["total"].get<int64_t> (), TICKS);
    EXPECT_EQ (pag["limit"].get<int64_t> (), 455);
    EXPECT_EQ (pag["offset"].get<int64_t> (), 0);
    EXPECT_FALSE (pag["hasMore"].get<bool> ());
    EXPECT_EQ (pag["returned"].get<int64_t> (), 455);

    const auto& data = body["data"];
    ASSERT_EQ (data.size (), 455u);
    // Every bucket ends on its last tick's run total, so the final one is the
    // run's total and none is a first-tick or summed figure.
    for (size_t b = 0; b < data.size (); ++b) {
        const auto last_tick = std::min<size_t> ((b * 11) + 10, TICKS - 1);
        ASSERT_EQ (data[b]["requests_completed"].get<size_t> (), 10 * (last_tick + 1))
        << "bucket " << b;
    }
    EXPECT_EQ (data.back ()["requests_completed"].get<size_t> (), 10u * TICKS);
    EXPECT_EQ (data.back ()["status_codes"]["200"].get<size_t> (), 10u * TICKS);

    // Rows 4994..5004 are bucket 454: the spike lands there and nowhere else.
    EXPECT_DOUBLE_EQ (data[454]["latency_p99_ms"].get<double> (), 900.0);
    EXPECT_DOUBLE_EQ (data[453]["latency_p99_ms"].get<double> (), 12.0);
    EXPECT_EQ (data[454]["current_concurrency"].get<size_t> (), 64u);
    EXPECT_EQ (data[453]["current_concurrency"].get<size_t> (), 4u);
    EXPECT_DOUBLE_EQ (data[454]["current_rps"].get<double> (), 10.0);
}

TEST_F (StatsRouteTest, MaxPointsLeavesAShortLastBucketAndKeepsDamagedRowsInPlace) {
    const std::string id = seed_run ();
    for (int i = 0; i < 7; ++i) {
        const auto tick = cumulative_tick (i);
        if (i == 1) {
            vayu::db::MetricTick corrupt;
            corrupt.run_id    = id;
            corrupt.timestamp = tick["timestamp"].get<int64_t> ();
            corrupt.payload   = "{not json";
            db_->add_metric_tick (corrupt);
            continue;
        }
        add_tick (id, tick["timestamp"].get<int64_t> (), tick);
    }

    // ceil (7 / 3) = 3 ticks a bucket: rows 0-2, 3-5 and 6 alone.
    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0, 3);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["ticksPerBucket"].get<int64_t> (), 3);
    ASSERT_EQ (body["data"].size (), 3u);
    EXPECT_EQ (body["data"][0]["requests_completed"].get<size_t> (), 30u);
    EXPECT_EQ (body["data"][1]["requests_completed"].get<size_t> (), 60u);
    EXPECT_EQ (body["data"][2], cumulative_tick (6));
}

TEST_F (StatsRouteTest, MaxPointsAtOrAboveTheTickCountReturnsEveryTickUnchanged) {
    const std::string id = seed_run ();
    for (int i = 0; i < 5; ++i) {
        const auto tick = cumulative_tick (i);
        add_tick (id, tick["timestamp"].get<int64_t> (), tick);
    }
    const auto [paged_status, paged] =
    vayu::http::routes::run_time_series_response (*db_, id, 5000, 0);
    ASSERT_EQ (paged_status, 200);

    for (const int64_t max_points : { 5, 50 }) {
        auto [status, body] =
        vayu::http::routes::run_time_series_response (*db_, id, 2, 3, max_points);
        ASSERT_EQ (status, 200);
        EXPECT_EQ (body["data"], paged["data"]) << "maxPoints " << max_points;
        EXPECT_FALSE (body["bucketed"].get<bool> ());
        EXPECT_EQ (body["ticksPerBucket"].get<int64_t> (), 1);
        EXPECT_EQ (body["pagination"],
        json ({ { "total", 5 }, { "limit", max_points }, { "offset", 0 },
        { "hasMore", false }, { "returned", 5 } }));
    }
}

// Without the parameter the answer is the paged envelope and nothing more.
TEST_F (StatsRouteTest, WithoutMaxPointsTheEnvelopeGainsNoKeys) {
    const std::string id = seed_run ();
    for (int i = 0; i < 3; ++i) {
        const auto tick = cumulative_tick (i);
        add_tick (id, tick["timestamp"].get<int64_t> (), tick);
    }
    auto [status, body] =
    vayu::http::routes::run_time_series_response (*db_, id, 2, 0, std::nullopt);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body.size (), 2u) << body.dump ();
    EXPECT_FALSE (body.contains ("bucketed"));
    EXPECT_FALSE (body.contains ("ticksPerBucket"));
    EXPECT_EQ (body["pagination"],
    json ({ { "total", 3 }, { "limit", 2 }, { "offset", 0 },
    { "hasMore", true }, { "returned", 2 } }));
    ASSERT_EQ (body["data"].size (), 2u);
    EXPECT_EQ (body["data"][1], cumulative_tick (1));
}

// ============================================================================
// The server-vitals series (monitor_samples)
// ============================================================================

// Same envelope as the tick series, from its own table - so a client that can
// page one can page the other.
TEST_F (StatsRouteTest, MonitorSeriesReturnsStoredSamplesInTheSharedEnvelope) {
    const std::string id = seed_run ();
    db_->add_monitor_sample ({ 0, id, 1000,
    vayu::core::build_monitor_sample_payload (1000, { { "cpu", 0.5 } }).dump () });
    db_->add_monitor_sample ({ 0, id, 2000,
    vayu::core::build_monitor_sample_payload (2000, { { "cpu", 0.75 } }).dump () });

    auto [status, body] =
    vayu::http::routes::run_monitor_series_response (*db_, id, 5000, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 2u);
    EXPECT_EQ (body["data"][0]["timestamp"].get<int64_t> (), 1000);
    EXPECT_DOUBLE_EQ (body["data"][1]["series"]["cpu"].get<double> (), 0.75);
    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 2);
    EXPECT_FALSE (body["pagination"]["hasMore"].get<bool> ());
}

// A run that configured no monitor is an empty series, not a 404: the run
// exists and simply scraped nothing.
TEST_F (StatsRouteTest, MonitorSeriesIsEmptyForARunWithoutAMonitor) {
    const std::string id = seed_run ();
    auto [status, body] =
    vayu::http::routes::run_monitor_series_response (*db_, id, 5000, 0);
    EXPECT_EQ (status, 200);
    EXPECT_EQ (body["data"].size (), 0u);
    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 0);
}

TEST_F (StatsRouteTest, MonitorSeriesMissingRunIs404) {
    auto [status, body] =
    vayu::http::routes::run_monitor_series_response (*db_, "run_nope", 5000, 0);
    EXPECT_EQ (status, 404);
    EXPECT_EQ (body["error"]["message"], "Run not found");
}

} // namespace
