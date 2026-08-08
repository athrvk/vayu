/**
 * @file tests/runs_route_test.cpp
 * @brief Tests for the paginated GET /runs list (get_runs_response) and the
 * DB-level filtering/pagination it rests on (get_runs_paginated / count_runs).
 *
 * Focus: the list must return the `{data, pagination}` envelope with compact
 * per-row `summary` objects (not the full config_snapshot), honour each filter
 * (type / status / requestId / q), clamp limit/offset, and never 500 on a
 * malformed snapshot. The legacy no-param path (a bare array of full
 * configSnapshot rows) is preserved by vayu::json::serialize(Run), asserted
 * here too so a change to the row shape cannot silently break external scripts.
 *
 * Covers the route's extracted core in isolation, matching the suite's other
 * route tests (no in-process HTTP server).
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in runs.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> get_runs_response (vayu::db::Database& db,
const vayu::db::RunFilter& filter, int64_t limit, int64_t offset);

// Defined in runs.cpp; builds the GET /runs/:id/report `configuration`
// object from an already-parsed config_snapshot, extracted so it is testable
// without the report handler's DB/metrics dependencies.
nlohmann::json build_run_report_config (const nlohmann::json& config);
// Defined in runs.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> run_report_response (vayu::db::Database& db,
const std::string& run_id);
} // namespace vayu::http::routes

namespace {

class RunsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_runs_route.db";

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

    struct RunSpec {
        std::string id;
        vayu::RunType type            = vayu::RunType::Load;
        vayu::RunStatus status        = vayu::RunStatus::Completed;
        int64_t start_time            = 0;
        std::optional<std::string> request_id = std::nullopt;
        std::string config_snapshot   = R"({"url":"https://x.test/","method":"GET"})";
    };

    void seed (const RunSpec& s) {
        vayu::db::Run run;
        run.id              = s.id;
        run.type            = s.type;
        run.status          = s.status;
        run.request_id      = s.request_id;
        run.environment_id  = std::nullopt;
        run.config_snapshot = s.config_snapshot;
        run.start_time      = s.start_time;
        run.end_time        = s.start_time + 1;
        db_->create_run (run);
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// The happy path: envelope keys, DESC ordering by start_time, and the compact
// summary in place of the full config_snapshot.
TEST_F (RunsRouteTest, EnvelopeShapeAndNewestFirst) {
    seed ({ .id = "run_a", .start_time = 100 });
    seed ({ .id = "run_b", .start_time = 300 });
    seed ({ .id = "run_c", .start_time = 200 });

    auto [status, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0);
    EXPECT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("data"));
    ASSERT_TRUE (body["data"].is_array ());
    ASSERT_EQ (body["data"].size (), 3u);
    // Newest first.
    EXPECT_EQ (body["data"][0]["id"], "run_b");
    EXPECT_EQ (body["data"][1]["id"], "run_c");
    EXPECT_EQ (body["data"][2]["id"], "run_a");

    // Rows carry summary, never the full config_snapshot.
    const auto& row = body["data"][0];
    EXPECT_TRUE (row.contains ("summary"));
    EXPECT_FALSE (row.contains ("configSnapshot"));
    EXPECT_TRUE (row.contains ("requestId"));
    EXPECT_TRUE (row.contains ("environmentId"));

    const auto& pag = body["pagination"];
    EXPECT_EQ (pag["total"], 3);
    EXPECT_EQ (pag["limit"], 50);
    EXPECT_EQ (pag["offset"], 0);
    EXPECT_EQ (pag["returned"], 3);
    EXPECT_EQ (pag["hasMore"], false);
}

TEST_F (RunsRouteTest, PaginationHasMoreAndOffset) {
    for (int i = 0; i < 5; ++i)
        seed ({ .id = "run_" + std::to_string (i), .start_time = i });

    auto [_, page1] = vayu::http::routes::get_runs_response (*db_, {}, 2, 0);
    EXPECT_EQ (page1["data"].size (), 2u);
    EXPECT_EQ (page1["pagination"]["total"], 5);
    EXPECT_EQ (page1["pagination"]["hasMore"], true);
    EXPECT_EQ (page1["pagination"]["returned"], 2);

    auto [__, page3] = vayu::http::routes::get_runs_response (*db_, {}, 2, 4);
    EXPECT_EQ (page3["data"].size (), 1u);
    EXPECT_EQ (page3["pagination"]["hasMore"], false);
}

TEST_F (RunsRouteTest, SummaryHasExactlyNineKeysAndOmitsAbsent) {
    seed ({ .id = "run_full", .config_snapshot = R"({"url":"https://a/","method":"POST","mode":"constant_rps",
    "duration":"60s","concurrency":100,"comment":"nightly","httpVersion":"http2",
    "followRedirects":false,"maxRedirects":5,"headers":{"X":"1"}})" });
    seed ({ .id = "run_sparse", .start_time = 1, .config_snapshot = R"({"url":"https://b/"})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0);
    // Sparse row is newest (start_time 1 > 0).
    const auto& sparse = body["data"][0]["summary"];
    EXPECT_EQ (body["data"][0]["id"], "run_sparse");
    // url present; httpVersion always defaults to "auto" when absent -
    // followRedirects/maxRedirects/comment stay omitted, they have no such
    // engine-side default to fall back to.
    EXPECT_EQ (sparse.size (), 2u);
    EXPECT_EQ (sparse["url"], "https://b/");
    // ASSERT, not EXPECT: operator[] on a missing key of a const json trips
    // nlohmann's assert and aborts the process, so a regression that drops the
    // key would surface as a crash instead of a readable Expected/Actual diff.
    ASSERT_TRUE (sparse.contains ("httpVersion"));
    EXPECT_EQ (sparse["httpVersion"], "auto");
    EXPECT_FALSE (sparse.contains ("comment"));
    EXPECT_FALSE (sparse.contains ("followRedirects"));
    EXPECT_FALSE (sparse.contains ("maxRedirects"));

    const auto& full = body["data"][1]["summary"];
    // Exactly the nine documented keys, no more (headers must not leak in).
    EXPECT_EQ (full.size (), 9u);
    // ASSERT so a dropped key stops here with a legible failure rather than
    // aborting on the operator[] reads below.
    for (const char* k : { "url", "method", "mode", "duration", "concurrency",
         "comment", "httpVersion", "followRedirects", "maxRedirects" })
        ASSERT_TRUE (full.contains (k)) << k;
    EXPECT_FALSE (full.contains ("headers"));
    EXPECT_EQ (full["concurrency"], 100);
    EXPECT_EQ (full["httpVersion"], "http2");
    EXPECT_EQ (full["followRedirects"], false);
    EXPECT_EQ (full["maxRedirects"], 5);
}

// A raw POST /runs body of `"httpVersion": null` (the client asked for no
// explicit protocol) lands in config_snapshot verbatim - the snapshot is built
// from the raw request body, before normalize_run_http_version erases the key
// from the *executed* request (see execution.cpp). A run predating this
// field has no httpVersion key at all. Both cases mean the same thing - the
// run executed at the engine's default - so both normalize to the literal
// string "auto" rather than being silently omitted, which would misrepresent
// "we know it defaulted" as "we don't know".
TEST_F (RunsRouteTest, SummaryHttpVersionDefaultsToAutoOnNullOrAbsent) {
    seed ({ .id      = "run_null_version",
    .config_snapshot = R"({"url":"https://a/","httpVersion":null})" });
    seed ({ .id = "run_no_version", .start_time = 1, .config_snapshot = R"({"url":"https://b/"})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0);
    // Newest first: run_no_version (start_time 1), then run_null_version (0).
    EXPECT_EQ (body["data"][0]["id"], "run_no_version");
    EXPECT_EQ (body["data"][0]["summary"]["httpVersion"], "auto");
    EXPECT_EQ (body["data"][1]["id"], "run_null_version");
    EXPECT_EQ (body["data"][1]["summary"]["httpVersion"], "auto");
}

// A collection run's row has no url and no method - its work is a sequence -
// so `scenario` is the only thing on it that says what ran. The step manifest
// itself stays off the row: it is the size of the plan, and the row is the part
// that has to stay cheap as history grows.
TEST_F (RunsRouteTest, SummaryCarriesScenarioDescriptorWithoutTheStepManifest) {
    seed ({ .id = "run_scenario", .type = vayu::RunType::Scenario,
    .config_snapshot = R"({"scenario":{"source":"collection","collectionId":"col_1",
    "recursive":true,"iterations":3,"dataRowCount":0,
    "steps":[{"index":0,"requestId":"req_1","name":"login","method":"POST","url":"https://a/login"},
             {"index":1,"requestId":"req_2","name":"checkout","method":"GET","url":"https://a/cart"}]}})" });

    auto [status, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0);
    EXPECT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);

    const auto& summary = body["data"][0]["summary"];
    ASSERT_TRUE (summary.contains ("scenario"));
    const auto& scenario = summary["scenario"];
    EXPECT_EQ (scenario["collectionId"], "col_1");
    EXPECT_EQ (scenario["iterations"], 3);
    EXPECT_EQ (scenario["recursive"], true);
    // The count, never the array - a row that shipped every step's name, method
    // and URL would be the full snapshot wearing another name.
    EXPECT_EQ (scenario["stepCount"], 2);
    EXPECT_FALSE (scenario.contains ("steps"));
    // A scenario has no url/method/mode to report, and nothing invents one.
    EXPECT_FALSE (summary.contains ("url"));
    EXPECT_FALSE (summary.contains ("method"));
    EXPECT_FALSE (summary.contains ("mode"));
}

// The key is a scenario's alone: a load run must not grow one, or the app's
// "is this a collection run" read becomes true for every row.
TEST_F (RunsRouteTest, SummaryOmitsScenarioOnANonScenarioRun) {
    seed ({ .id = "run_load", .config_snapshot = R"({"url":"https://a/","mode":"constant_rps"})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0);
    EXPECT_FALSE (body["data"][0]["summary"].contains ("scenario"));
}

TEST_F (RunsRouteTest, MalformedSnapshotYieldsEmptySummaryNot500) {
    seed ({ .id = "run_bad", .config_snapshot = "not valid json {{{" });

    auto [status, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0);
    EXPECT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_TRUE (body["data"][0]["summary"].is_object ());
    EXPECT_TRUE (body["data"][0]["summary"].empty ());
}

TEST_F (RunsRouteTest, FilterByType) {
    seed ({ .id = "run_load", .type = vayu::RunType::Load });
    seed ({ .id = "run_design", .type = vayu::RunType::Design, .start_time = 1 });

    vayu::db::RunFilter f;
    f.type = vayu::RunType::Design;
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_design");
    EXPECT_EQ (body["pagination"]["total"], 1);
}

TEST_F (RunsRouteTest, FilterByStatus) {
    seed ({ .id = "run_done", .status = vayu::RunStatus::Completed });
    seed ({ .id = "run_fail", .status = vayu::RunStatus::Failed, .start_time = 1 });

    vayu::db::RunFilter f;
    f.status = vayu::RunStatus::Failed;
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_fail");
}

TEST_F (RunsRouteTest, FilterByRequestId) {
    seed ({ .id = "run_1", .request_id = "req_A" });
    seed ({ .id = "run_2", .start_time = 1, .request_id = "req_B" });
    seed ({ .id = "run_3", .start_time = 2, .request_id = std::nullopt });

    vayu::db::RunFilter f;
    f.request_id = "req_A";
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_1");
    EXPECT_EQ (body["data"][0]["requestId"], "req_A");
}

TEST_F (RunsRouteTest, FilterByQSubstringOverSnapshot) {
    seed ({ .id = "run_users", .config_snapshot = R"({"url":"https://api/users"})" });
    seed ({ .id = "run_orders", .start_time = 1,
    .config_snapshot = R"({"url":"https://api/orders"})" });

    vayu::db::RunFilter f;
    f.q = "orders";
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_orders");
}

TEST_F (RunsRouteTest, FiltersCombine) {
    seed ({ .id = "keep", .type = vayu::RunType::Design,
    .status = vayu::RunStatus::Completed, .request_id = "req_X" });
    seed ({ .id = "wrong_status", .type = vayu::RunType::Design,
    .status = vayu::RunStatus::Failed, .start_time = 1, .request_id = "req_X" });
    seed ({ .id = "wrong_type", .type = vayu::RunType::Load,
    .status = vayu::RunStatus::Completed, .start_time = 2, .request_id = "req_X" });

    vayu::db::RunFilter f;
    f.type       = vayu::RunType::Design;
    f.status     = vayu::RunStatus::Completed;
    f.request_id = "req_X";
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 1, 0);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "keep");
    EXPECT_EQ (body["pagination"]["total"], 1);
}

// count_runs / get_runs_paginated agree on the filtered total.
TEST_F (RunsRouteTest, DbCountMatchesFilter) {
    seed ({ .id = "a", .status = vayu::RunStatus::Completed });
    seed ({ .id = "b", .status = vayu::RunStatus::Completed, .start_time = 1 });
    seed ({ .id = "c", .status = vayu::RunStatus::Failed, .start_time = 2 });

    vayu::db::RunFilter f;
    f.status = vayu::RunStatus::Completed;
    EXPECT_EQ (db_->count_runs (f), 2);
    EXPECT_EQ (db_->get_runs_paginated (f, 50, 0).size (), 2u);
    EXPECT_EQ (db_->count_runs ({}), 3); // no filter -> everything
}

// The legacy no-param path serializes runs with the full configSnapshot (and
// no `summary`). This is what the route returns when called with zero query
// params; asserting the serializer keeps that shape guards external scripts.
TEST_F (RunsRouteTest, LegacySerializationKeepsConfigSnapshot) {
    seed ({ .id = "run_legacy",
    .config_snapshot = R"({"url":"https://a/","method":"GET","headers":{"X":"1"}})" });

    auto runs = db_->get_all_runs ();
    ASSERT_EQ (runs.size (), 1u);
    auto legacy = vayu::json::serialize (runs.front ());
    EXPECT_TRUE (legacy.contains ("configSnapshot"));
    EXPECT_FALSE (legacy.contains ("summary"));
    // Full snapshot, including keys the summary would drop.
    EXPECT_TRUE (legacy["configSnapshot"].contains ("headers"));
}

// GET /runs/:id/report's `configuration` object: same nine-key extension as
// the list-row summary (mode/duration/concurrency/startConcurrency/
// rampUpDuration/timeout/comment + httpVersion/followRedirects/maxRedirects),
// covered directly against build_run_report_config rather than through the
// full report handler, which needs a completed run's DB rows and metrics.
TEST (RunReportConfigTest, IncludesHttpVersionFollowRedirectsMaxRedirects) {
    auto config = json::parse (R"({"mode":"constant_rps","duration":"60s",
    "concurrency":50,"httpVersion":"http1.1","followRedirects":true,"maxRedirects":10})");

    auto config_obj = vayu::http::routes::build_run_report_config (config);

    EXPECT_EQ (config_obj.size (), 6u);
    EXPECT_EQ (config_obj["mode"], "constant_rps");
    EXPECT_EQ (config_obj["httpVersion"], "http1.1");
    EXPECT_EQ (config_obj["followRedirects"], true);
    EXPECT_EQ (config_obj["maxRedirects"], 10);
}

// Same "auto" default as the list-row summary - and for the same reason: the
// raw config_snapshot can hold an explicit httpVersion:null, and a run
// predating this field has no key at all. Both mean "ran at the default".
TEST (RunReportConfigTest, HttpVersionDefaultsToAutoOnNullOrAbsent) {
    auto with_null = json::parse (R"({"mode":"once","httpVersion":null})");
    auto without   = json::parse (R"({"mode":"once"})");

    EXPECT_EQ (
    vayu::http::routes::build_run_report_config (with_null)["httpVersion"], "auto");
    EXPECT_EQ (
    vayu::http::routes::build_run_report_config (without)["httpVersion"], "auto");
}

TEST (RunReportConfigTest, OmitsFollowRedirectsAndMaxRedirectsWhenAbsent) {
    auto config     = json::parse (R"({"mode":"once"})");
    auto config_obj = vayu::http::routes::build_run_report_config (config);

    EXPECT_FALSE (config_obj.contains ("followRedirects"));
    EXPECT_FALSE (config_obj.contains ("maxRedirects"));
    EXPECT_EQ (config_obj.size (), 2u); // mode + httpVersion("auto")
}

// ============================================================================
// GET /runs/:id/report - the stored whole-run summary, and the sampled-results
// fallback when it is malformed or absent
// ============================================================================

// The whole-run results a completed load run stores on its row.
vayu::core::RunSummaryInputs summary_inputs () {
    vayu::core::RunSummaryInputs inputs;
    inputs.total_requests    = 100;
    inputs.rps               = 50.0;
    inputs.send_rate         = 51.0;
    inputs.throughput        = 49.5;
    inputs.test_duration_s   = 2.0;
    inputs.setup_overhead_s  = 0.25;
    inputs.peak_concurrency  = 8;
    inputs.dropped_requests  = 2;
    inputs.queue_wait_avg_ms = 1.5;
    inputs.bytes_sent        = 1024;
    inputs.bytes_received    = 8192;
    inputs.status_codes      = { { 200, 90 }, { 500, 7 }, { 0, 3 } };
    inputs.latency.min       = 1.0;
    inputs.latency.max       = 90.0;
    inputs.latency.p50       = 10.0;
    inputs.latency.p75       = 15.0;
    inputs.latency.p90       = 20.0;
    inputs.latency.p95       = 25.0;
    inputs.latency.p99       = 30.0;
    inputs.latency.p999      = 35.0;
    inputs.latency_avg_ms    = 12.5;
    inputs.http_version_downgraded = 4;
    inputs.tests             = vayu::core::ScriptValidationTotals{ 10, 9, 1 };
    inputs.retention         = vayu::core::SamplingRetention{ 4, 300, 12, 900 };
    return inputs;
}

TEST_F (RunsRouteTest, ReportMissingRunIs404) {
    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_nope");
    EXPECT_EQ (status, 404);
    ASSERT_TRUE (body.contains ("error"));
    EXPECT_EQ (body["error"]["code"], "not_found");
    EXPECT_EQ (body["error"]["message"], "Run not found");
}

// A completed run reports from its stored summary - no metric rows involved.
TEST_F (RunsRouteTest, ReportReadsTheStoredSummary) {
    seed ({ .id = "run_sum", .start_time = 1000 });
    db_->update_run_summary (
    "run_sum", vayu::core::build_run_summary_payload (summary_inputs ()).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_sum");
    ASSERT_EQ (status, 200);

    const auto& summary = body["summary"];
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), 100u);
    EXPECT_DOUBLE_EQ (summary["avgRps"].get<double> (), 50.0);
    EXPECT_DOUBLE_EQ (summary["sendRate"].get<double> (), 51.0);
    EXPECT_DOUBLE_EQ (summary["throughput"].get<double> (), 49.5);
    EXPECT_DOUBLE_EQ (summary["testDuration"].get<double> (), 2.0);
    EXPECT_DOUBLE_EQ (summary["setupOverhead"].get<double> (), 0.25);
    EXPECT_EQ (summary["peakConcurrency"].get<size_t> (), 8u);
    EXPECT_EQ (summary["droppedRequests"].get<size_t> (), 2u);
    EXPECT_DOUBLE_EQ (summary["avgQueueWaitMs"].get<double> (), 1.5);
    EXPECT_EQ (summary["bytesSent"].get<size_t> (), 1024u);
    EXPECT_EQ (summary["bytesReceived"].get<size_t> (), 8192u);
    // The one summary figure that is about the report's validity rather than
    // its performance: how many transfers asked for HTTP/2 and did not get it.
    // It has to survive the store -> report round trip, or a run measured over
    // HTTP/1.1 keeps being labelled with the protocol that was requested.
    EXPECT_EQ (summary["httpVersionDowngraded"].get<size_t> (), 4u);

    // successful/failed are recounted from the stored distribution, so the 3
    // transport errors (code 0) land on the failed side.
    EXPECT_EQ (summary["successfulRequests"].get<size_t> (), 90u);
    EXPECT_EQ (summary["failedRequests"].get<size_t> (), 10u);
    EXPECT_DOUBLE_EQ (summary["errorRate"].get<double> (), 10.0);

    const auto& latency = body["latency"];
    EXPECT_DOUBLE_EQ (latency["min"].get<double> (), 1.0);
    EXPECT_DOUBLE_EQ (latency["max"].get<double> (), 90.0);
    EXPECT_DOUBLE_EQ (latency["avg"].get<double> (), 12.5);
    EXPECT_DOUBLE_EQ (latency["p50"].get<double> (), 10.0);
    EXPECT_DOUBLE_EQ (latency["p75"].get<double> (), 15.0);
    EXPECT_DOUBLE_EQ (latency["p90"].get<double> (), 20.0);
    EXPECT_DOUBLE_EQ (latency["p95"].get<double> (), 25.0);
    EXPECT_DOUBLE_EQ (latency["p99"].get<double> (), 30.0);
    EXPECT_DOUBLE_EQ (latency["p999"].get<double> (), 35.0);

    // statusCodes / byStatusCode are integer-keyed maps, which nlohmann emits
    // as arrays of [code, count] pairs sorted by code - the shape this endpoint
    // has always returned.
    ASSERT_TRUE (body["statusCodes"].is_array ());
    ASSERT_EQ (body["statusCodes"].size (), 3u);
    EXPECT_EQ (body["statusCodes"][1][0].get<int> (), 200);
    EXPECT_EQ (body["statusCodes"][1][1].get<size_t> (), 90u);
    ASSERT_TRUE (body["errors"]["byStatusCode"].is_array ());
    EXPECT_EQ (body["errors"]["byStatusCode"][1][0].get<int> (), 500);
    EXPECT_EQ (body["errors"]["byStatusCode"][1][1].get<size_t> (), 7u);

    ASSERT_TRUE (body.contains ("testValidation"));
    EXPECT_EQ (body["testValidation"]["samplesTested"].get<int> (), 10);
    EXPECT_EQ (body["testValidation"]["testsPassed"].get<int> (), 9);
    EXPECT_EQ (body["testValidation"]["testsFailed"].get<int> (), 1);
}

// Every store a run keeps is bounded, so the report has to say how much each
// one thinned away - a Samples tab showing 1000 traces from a 3M-request run
// is honest only if the reader can also see that 29,000 candidates were
// displaced.
TEST_F (RunsRouteTest, ReportCarriesWhatTheBoundedStoresDropped) {
    seed ({ .id = "run_retention", .start_time = 1000 });
    db_->update_run_summary ("run_retention",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_retention");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("sampling"));
    EXPECT_EQ (body["sampling"]["errorsDropped"].get<size_t> (), 4u);
    EXPECT_EQ (body["sampling"]["successTracesDropped"].get<size_t> (), 300u);
    EXPECT_EQ (body["sampling"]["slowTracesDropped"].get<size_t> (), 12u);
    EXPECT_EQ (body["sampling"]["responseSamplesDropped"].get<size_t> (), 900u);
}

// A run recorded before retention was reported has no section - which is not
// the same claim as "this run dropped nothing".
TEST_F (RunsRouteTest, ReportOmitsSamplingWhenTheSummaryPredatesIt) {
    seed ({ .id = "run_old_summary", .start_time = 1000 });
    auto summary = vayu::core::build_run_summary_payload (summary_inputs ());
    summary.erase ("sampling");
    db_->update_run_summary ("run_old_summary", summary.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_old_summary");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("sampling"));
}

// A run without script validation keeps the section out entirely, rather than
// reporting a run of zero tests that all passed.
TEST_F (RunsRouteTest, ReportOmitsTestValidationWhenNoScriptRan) {
    seed ({ .id = "run_no_tests", .start_time = 1000 });
    auto inputs  = summary_inputs ();
    inputs.tests = std::nullopt;
    db_->update_run_summary (
    "run_no_tests", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_no_tests");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("testValidation"));
}

// A summary that is not a JSON object is treated as absent. There is no second
// aggregate source any more, so the report stands on the run's sampled results
// - which is a report, not a 500 and not an empty run.
TEST_F (RunsRouteTest, MalformedSummaryReportsFromSampledResults) {
    seed ({ .id = "run_bad", .start_time = 1000 });
    db_->update_run_summary ("run_bad", "not json at all");

    for (int i = 0; i < 3; ++i) {
        vayu::db::Result r;
        r.run_id      = "run_bad";
        r.timestamp   = 2000 + i;
        r.status_code = 200;
        r.status_text = "OK";
        r.latency_ms  = 10.0;
        db_->add_result (r);
    }

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_bad");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["summary"]["totalRequests"].get<size_t> (), 3u);
    EXPECT_EQ (body["summary"]["successfulRequests"].get<size_t> (), 3u);
}

// The same for a run that has no summary at all - the engine died before it
// reached a terminal status. Its sampled results are all that survived, and
// they are what the report is built from.
TEST_F (RunsRouteTest, RunWithNoSummaryReportsFromSampledResults) {
    seed ({ .id = "run_orphaned", .status = vayu::RunStatus::Failed, .start_time = 1000 });

    vayu::db::Result r;
    r.run_id      = "run_orphaned";
    r.timestamp   = 2000;
    r.status_code = 500;
    r.status_text = "Internal Server Error";
    r.latency_ms  = 42.0;
    db_->add_result (r);

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_orphaned");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["summary"]["totalRequests"].get<size_t> (), 1u);
    EXPECT_EQ (body["summary"]["failedRequests"].get<size_t> (), 1u);
}

} // namespace