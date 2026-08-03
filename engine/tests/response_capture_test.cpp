/**
 * @file tests/response_capture_test.cpp
 * @brief Tests for load-run response capture - policy, budgets, storage and
 *        the GET /runs/:id/samples endpoint that reads it back.
 *
 * The feature exists because two UI surfaces were written to display a load
 * run's response headers and body, and no writer ever produced them. So the
 * bar here is not "a body reaches the database" but the four things that make
 * capture affordable and honest:
 *
 * - the captured set is failures + outliers + per-status exemplars, never a
 *   uniform slice (a uniform slice of 30M requests is a thousand identical
 *   200s);
 * - the bodies live outside `results.trace_data`, so the report path - which
 *   loads and parses every result row on every poll - reads none of them;
 * - identical bodies are stored once, because load-test responses are
 *   overwhelmingly identical;
 * - a body that cannot be text is stored as a descriptor, never as a string
 *   that reads like a real response but is not.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <memory>
#include <set>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "vayu/core/metrics_collector.hpp"
#include "vayu/db/database.hpp"

namespace vayu::http::routes {
// Defined in runs.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json>
run_samples_response (vayu::db::Database& db, const std::string& run_id, int64_t limit, int64_t offset);
std::pair<int, nlohmann::json> run_report_response (vayu::db::Database& db,
const std::string& run_id);
} // namespace vayu::http::routes

using namespace vayu::core;

namespace {

vayu::Response make_response (int status, std::string body, std::string content_type = "application/json") {
    vayu::Response response;
    response.status_code     = status;
    response.body            = std::move (body);
    response.timing.total_ms = 1.0;
    if (!content_type.empty ()) {
        response.headers["Content-Type"] = std::move (content_type);
    }
    response.headers["X-Trace"] = "abc";
    return response;
}

/// A collector configured the way a run with capture on is, with the sampling
/// knobs pinned so a test decides what is retained rather than a 1-in-100 die.
MetricsCollectorConfig capture_config () {
    MetricsCollectorConfig config;
    config.expected_requests      = 1000;
    config.capture_response_bodies = true;
    config.store_success_traces   = false;
    config.success_sample_rate    = 1;
    return config;
}

class ResponseCaptureTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_response_capture.db";

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
        for (const char* suffix : { "", "-wal", "-shm", ".bak" }) {
            std::filesystem::remove (std::string (DB_PATH) + suffix);
        }
    }

    void seed_run (const std::string& id) {
        vayu::db::Run run;
        run.id              = id;
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Completed;
        run.request_id      = std::nullopt;
        run.environment_id  = std::nullopt;
        run.config_snapshot = R"({"url":"https://x.test/","method":"GET"})";
        run.start_time      = 100;
        run.end_time        = 200;
        db_->create_run (run);
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// ---------------------------------------------------------------------------
// Capture policy: which completions get a body at all
// ---------------------------------------------------------------------------

// Every error is a candidate, within the bound `maxStoredErrors` already sets.
// A failure is precisely the sample someone opens the Samples tab for.
TEST_F (ResponseCaptureTest, EveryStoredErrorCarriesItsExchange) {
    MetricsCollectorConfig config = capture_config ();
    config.max_errors             = 5;
    MetricsCollector collector ("run_errors", config);

    for (int i = 0; i < 20; ++i) {
        auto response = make_response (0, R"({"err":true})");
        collector.record_error (vayu::ErrorCode::Timeout, "timed out", "{}", &response);
    }

    ASSERT_EQ (collector.errors ().size (), 5u);
    for (const auto& record : collector.errors ()) {
        ASSERT_TRUE (record.capture.has_value ());
        EXPECT_EQ (record.capture->body, R"({"err":true})");
    }
    // Past the cap the record is dropped, so no body was copied for it either.
    EXPECT_EQ (collector.errors_dropped (), 15u);
}

// The exemplar bucket: the first K of each distinct status code and no more.
// Mutation check - drop the `claimed < EXEMPLARS_PER_STATUS` bound in
// claim_status_exemplar and every completion becomes an exemplar, failing the
// per-status count below.
TEST_F (ResponseCaptureTest, ExemplarsAreBoundedPerStatusCode) {
    MetricsCollector collector ("run_exemplars", capture_config ());

    for (int status : { 200, 404, 503 }) {
        for (int i = 0; i < 50; ++i) {
            EXPECT_EQ (collector.claim_status_exemplar (status),
            i < static_cast<int> (constants::metrics_collector::EXEMPLARS_PER_STATUS));
        }
    }
}

TEST_F (ResponseCaptureTest, ExemplarStoreKeepsOnePerStatusUpToTheLimit) {
    MetricsCollector collector ("run_exemplar_store", capture_config ());

    for (int status : { 200, 500 }) {
        for (int i = 0; i < 10; ++i) {
            auto response      = make_response (status, "body-" + std::to_string (status));
            const bool exemplar = collector.claim_status_exemplar (status);
            collector.record_success (status, 1.0, 0.0, exemplar ? "{}" : "",
            exemplar ? SuccessTraceReason::Exemplar : SuccessTraceReason::None,
            &response);
        }
    }

    ASSERT_EQ (collector.exemplar_results ().size (),
    2 * constants::metrics_collector::EXEMPLARS_PER_STATUS);
    std::set<int> statuses;
    for (const auto& record : collector.exemplar_results ()) {
        ASSERT_TRUE (record.capture.has_value ());
        statuses.insert (record.status_code);
    }
    EXPECT_EQ (statuses, (std::set<int>{ 200, 500 }));
}

// The collector captures exactly when the caller hands it a source, whatever
// budget the record is charged to. Deciding it from `trace_reason` instead
// would tie "which store pays" to "does this deserve a body", and a record can
// sit in the sampled budget and still deserve one (a completion that is both
// sampled and a claimed exemplar). The *policy* - which completions get a
// source at all - is `handle_result`'s, and load_strategy_test.cpp pins it.
TEST_F (ResponseCaptureTest, CaptureFollowsTheCallerNotTheStore) {
    MetricsCollectorConfig config = capture_config ();
    config.store_success_traces   = true;
    MetricsCollector collector ("run_sampled", config);

    auto response = make_response (200, "hello");
    // Sampled with a source: stored in the sampled budget, body kept.
    collector.record_success (200, 1.0, 0.0, "{}", SuccessTraceReason::Sampled, &response);
    // Slow without one: stored in the slow budget, no body.
    collector.record_success (200, 9000.0, 0.0, "{}", SuccessTraceReason::Slow, nullptr);

    ASSERT_EQ (collector.success_results ().size (), 1u);
    ASSERT_TRUE (collector.success_results ()[0].capture.has_value ());
    EXPECT_EQ (collector.success_results ()[0].capture->body, "hello");
    ASSERT_EQ (collector.slow_results ().size (), 1u);
    EXPECT_FALSE (collector.slow_results ()[0].capture.has_value ());
}

// A refused reservoir slot must not have cost a body-sized copy. Observable
// through the run budget: only the retained records may have spent it.
TEST_F (ResponseCaptureTest, RefusedSlotsSpendNoBudget) {
    MetricsCollectorConfig config = capture_config ();
    config.max_slow_results       = 2;
    MetricsCollector collector ("run_refused", config);

    const std::string body (1000, 'x');
    for (int i = 0; i < 500; ++i) {
        auto response = make_response (200, body);
        collector.record_success (200, 9000.0, 0.0, "{}", SuccessTraceReason::Slow, &response);
    }

    ASSERT_EQ (collector.slow_results ().size (), 2u);
    // Every accepted candidate charges 1000 bytes. A reservoir accepts more
    // than it finally holds (it displaces), so the bound is generous - but it
    // must be far below the 500,000 bytes "copy everything" would spend.
    EXPECT_LT (collector.captured_body_bytes (), 100u * 1000u)
    << "bodies were copied for candidates the reservoir refused";
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

TEST_F (ResponseCaptureTest, BodyOverThePerBodyCapIsTruncatedAndSaysSo) {
    MetricsCollectorConfig config  = capture_config ();
    config.max_sample_body_bytes   = 16;
    MetricsCollector collector ("run_truncate", config);

    auto response = make_response (500, std::string (100, 'y'));
    collector.record_error (vayu::ErrorCode::ConnectionFailed, "server error", "{}", &response);

    ASSERT_EQ (collector.errors ().size (), 1u);
    const auto& captured = collector.errors ()[0].capture;
    ASSERT_TRUE (captured.has_value ());
    EXPECT_EQ (captured->body.size (), 16u);
    EXPECT_TRUE (captured->truncated);
    EXPECT_EQ (captured->body_bytes, 100);
}

// Once the run budget is spent, metadata keeps being captured and only the
// bodies stop - and the count says so, so the UI can report an incomplete set
// rather than presenting a biased one as the whole story.
TEST_F (ResponseCaptureTest, SpentBudgetKeepsMetadataAndCountsDroppedBodies) {
    MetricsCollectorConfig config = capture_config ();
    config.max_sample_bytes       = 250;
    config.max_errors             = 0; // unlimited, so the store is not the limit
    MetricsCollector collector ("run_budget", config);

    for (int i = 0; i < 10; ++i) {
        auto response = make_response (500, std::string (100, 'z'));
        collector.record_error (vayu::ErrorCode::ConnectionFailed, "boom", "{}", &response);
    }

    ASSERT_EQ (collector.errors ().size (), 10u);
    size_t with_body = 0;
    for (const auto& record : collector.errors ()) {
        ASSERT_TRUE (record.capture.has_value ()) << "metadata must survive a spent budget";
        EXPECT_EQ (record.capture->headers.size (), 2u);
        EXPECT_EQ (record.capture->body_bytes, 100);
        if (!record.capture->body.empty ()) {
            with_body++;
        } else {
            EXPECT_TRUE (record.capture->body_dropped);
        }
    }
    EXPECT_EQ (with_body, 2u); // 250 / 100, floored
    EXPECT_EQ (collector.sample_bodies_dropped (), 8u);
}

// ---------------------------------------------------------------------------
// Storage: dedup, binary bodies, and isolation from the report path
// ---------------------------------------------------------------------------

TEST_F (ResponseCaptureTest, IdenticalBodiesAreStoredOnce) {
    seed_run ("run_dedup");
    MetricsCollectorConfig config = capture_config ();
    config.max_errors             = 0;
    MetricsCollector collector ("run_dedup", config);

    for (int i = 0; i < 20; ++i) {
        auto response = make_response (500, R"({"error":"upstream"})");
        collector.record_error (vayu::ErrorCode::ConnectionFailed, "boom", "{}", &response);
    }
    collector.flush_to_database (*db_);

    auto rows = db_->get_result_bodies_paginated ("run_dedup", 100, 0);
    ASSERT_EQ (rows.size (), 20u);
    std::set<int> blob_ids;
    for (const auto& row : rows) {
        blob_ids.insert (row.blob_id);
    }
    EXPECT_EQ (blob_ids.size (), 1u)
    << "20 identical responses should share one stored body, not store 20 copies";

    // And the shared blob still reads back as the body every row claims.
    for (const auto& row : rows) {
        EXPECT_EQ (db_->get_body_blob_content (row.blob_id), R"({"error":"upstream"})");
    }
}

TEST_F (ResponseCaptureTest, BinaryBodyIsStoredAsADescriptor) {
    seed_run ("run_binary");
    MetricsCollector collector ("run_binary", capture_config ());

    // Raw deflate bytes under an origin's own text/html - the realistic case,
    // since the engine never sets CURLOPT_ACCEPT_ENCODING.
    auto response = make_response (200, std::string ("\x1f\x8b\x08\x00\xff\xfe\x00\x01", 8), "text/html");
    collector.record_error (vayu::ErrorCode::ConnectionFailed, "boom", "{}", &response);
    collector.flush_to_database (*db_);

    auto rows = db_->get_result_bodies_paginated ("run_binary", 100, 0);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_TRUE (rows[0].is_binary);
    EXPECT_EQ (rows[0].blob_id, 0) << "a binary body must not be stored as text";
    EXPECT_EQ (rows[0].body_bytes, 8);

    auto [status, body] = vayu::http::routes::run_samples_response (*db_, "run_binary", 50, 0);
    ASSERT_EQ (status, 200);
    const auto& sample = body["data"][0]["response"];
    EXPECT_TRUE (sample["binary"].get<bool> ());
    EXPECT_FALSE (sample.contains ("body"));
    EXPECT_EQ (sample["bodyBytes"].get<int64_t> (), 8);
}

// The point of the separate table: the report loads every result row for a run
// and JSON-parses each trace_data on every fetch. Capture must not make that
// read one byte larger. Asserted on the stored rows, not on the rendered
// output - a report that merely omits a body it still read would pass an
// output-only check.
TEST_F (ResponseCaptureTest, CaptureAddsNothingToTheReportPathsRows) {
    auto flush_trace_bytes = [this] (const std::string& run_id, bool capture) {
        seed_run (run_id);
        MetricsCollectorConfig config   = capture_config ();
        config.capture_response_bodies = capture;
        MetricsCollector collector (run_id, config);
        for (int i = 0; i < 5; ++i) {
            auto response = make_response (500, std::string (4096, 'q'));
            collector.record_error (vayu::ErrorCode::ConnectionFailed, "boom", R"({"totalMs":1})",
            capture ? &response : nullptr);
        }
        collector.flush_to_database (*db_);

        size_t bytes = 0;
        for (const auto& row : db_->get_results (run_id)) {
            bytes += row.trace_data.size () + row.error.size ();
        }
        return bytes;
    };

    const size_t without = flush_trace_bytes ("run_off", false);
    const size_t with    = flush_trace_bytes ("run_on", true);
    EXPECT_EQ (with, without)
    << "captured bodies leaked into the rows the report path reads";

    // ...while the bodies really were captured on the second run.
    EXPECT_EQ (db_->count_result_bodies ("run_on"), 5);
    EXPECT_EQ (db_->count_result_bodies ("run_off"), 0);
}

// Capture off must leave the collector exactly as it was before the feature:
// no exemplar is claimed, no body is copied, no row is written.
TEST_F (ResponseCaptureTest, CaptureDisabledStoresNothingExtra) {
    seed_run ("run_disabled");
    MetricsCollectorConfig config  = capture_config ();
    config.capture_response_bodies = false;
    MetricsCollector collector ("run_disabled", config);

    EXPECT_FALSE (collector.claim_status_exemplar (200));
    auto response = make_response (200, "hello");
    collector.record_error (vayu::ErrorCode::ConnectionFailed, "boom", "{}", nullptr);
    collector.flush_to_database (*db_);

    EXPECT_EQ (collector.captured_body_bytes (), 0u);
    EXPECT_EQ (collector.response_bodies_captured (), 0u);
    EXPECT_EQ (db_->count_result_bodies ("run_disabled"), 0);
    EXPECT_EQ (db_->get_results ("run_disabled").size (), 1u);
}

TEST_F (ResponseCaptureTest, DeletingARunDeletesItsCapturedBodies) {
    seed_run ("run_delete");
    MetricsCollector collector ("run_delete", capture_config ());
    auto response = make_response (500, "secret-token-in-here");
    collector.record_error (vayu::ErrorCode::ConnectionFailed, "boom", "{}", &response);
    collector.flush_to_database (*db_);
    ASSERT_EQ (db_->count_result_bodies ("run_delete"), 1);

    db_->delete_run ("run_delete");
    EXPECT_EQ (db_->count_result_bodies ("run_delete"), 0)
    << "captured data outlived the run it belongs to; maxRunsRetained is its expiry";
}

// ---------------------------------------------------------------------------
// GET /runs/:id/samples
// ---------------------------------------------------------------------------

TEST_F (ResponseCaptureTest, SamplesEndpointReturnsTheCapturedExchange) {
    seed_run ("run_endpoint");
    MetricsCollector collector ("run_endpoint", capture_config ());
    auto response = make_response (500, R"({"error":"nope"})");
    collector.record_error (vayu::ErrorCode::ConnectionFailed, "boom", "{}", &response);
    collector.flush_to_database (*db_);

    auto [status, body] =
    vayu::http::routes::run_samples_response (*db_, "run_endpoint", 50, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);

    const auto& sample = body["data"][0];
    EXPECT_GT (sample["resultId"].get<int> (), 0);
    EXPECT_EQ (sample["response"]["body"].get<std::string> (), R"({"error":"nope"})");
    EXPECT_EQ (sample["response"]["headers"]["Content-Type"].get<std::string> (),
    "application/json");
    EXPECT_EQ (sample["response"]["contentType"].get<std::string> (), "application/json");
    EXPECT_FALSE (sample["response"].contains ("bodyTruncated"));

    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 1);
    EXPECT_FALSE (body["pagination"]["hasMore"].get<bool> ());
}

// The result id is the join key between the report's `results[]` and this
// endpoint. Without it a client would have to re-derive an order, which is
// exactly the kind of implicit contract that drifts.
TEST_F (ResponseCaptureTest, ReportResultIdsMatchTheSamplesEndpoint) {
    seed_run ("run_join");
    MetricsCollector collector ("run_join", capture_config ());
    for (int i = 0; i < 3; ++i) {
        auto response = make_response (500, "body-" + std::to_string (i));
        collector.record_error (vayu::ErrorCode::ConnectionFailed, "boom", "{}", &response);
    }
    collector.flush_to_database (*db_);

    auto [report_status, report] = vayu::http::routes::run_report_response (*db_, "run_join");
    ASSERT_EQ (report_status, 200);
    std::set<int> report_ids;
    for (const auto& result : report["results"]) {
        report_ids.insert (result["id"].get<int> ());
    }

    auto [samples_status, samples] =
    vayu::http::routes::run_samples_response (*db_, "run_join", 50, 0);
    ASSERT_EQ (samples_status, 200);
    ASSERT_EQ (samples["data"].size (), 3u);
    for (const auto& sample : samples["data"]) {
        EXPECT_EQ (report_ids.count (sample["resultId"].get<int> ()), 1u);
    }
}

TEST_F (ResponseCaptureTest, SamplesEndpointPaginatesAndFourOhFours) {
    seed_run ("run_pages");
    MetricsCollectorConfig config = capture_config ();
    config.max_errors             = 0;
    MetricsCollector collector ("run_pages", config);
    for (int i = 0; i < 5; ++i) {
        auto response = make_response (500, "body-" + std::to_string (i));
        collector.record_error (vayu::ErrorCode::ConnectionFailed, "boom", "{}", &response);
    }
    collector.flush_to_database (*db_);

    auto [status, page] = vayu::http::routes::run_samples_response (*db_, "run_pages", 2, 0);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (page["data"].size (), 2u);
    EXPECT_EQ (page["pagination"]["total"].get<int64_t> (), 5);
    EXPECT_TRUE (page["pagination"]["hasMore"].get<bool> ());

    auto [last_status, last] = vayu::http::routes::run_samples_response (*db_, "run_pages", 2, 4);
    ASSERT_EQ (last_status, 200);
    EXPECT_EQ (last["data"].size (), 1u);
    EXPECT_FALSE (last["pagination"]["hasMore"].get<bool> ());

    auto [missing_status, missing] =
    vayu::http::routes::run_samples_response (*db_, "no_such_run", 50, 0);
    EXPECT_EQ (missing_status, 404);
    EXPECT_EQ (missing["error"]["code"].get<int> (), 404);
}

// A run that captured nothing is an empty page, not an error - the Samples tab
// asks before it knows whether there is anything to show.
TEST_F (ResponseCaptureTest, RunWithNoCapturesIsAnEmptyPage) {
    seed_run ("run_empty");
    auto [status, body] = vayu::http::routes::run_samples_response (*db_, "run_empty", 50, 0);
    EXPECT_EQ (status, 200);
    EXPECT_TRUE (body["data"].empty ());
    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 0);
}

} // namespace
