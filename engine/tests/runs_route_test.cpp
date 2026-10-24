/**
 * @file tests/runs_route_test.cpp
 * @brief Tests for the paginated GET /runs list (get_runs_response) and the
 * DB-level filtering/pagination it rests on (get_runs_paginated / count_runs).
 *
 * Focus: the list must return the `{data, pagination}` envelope with compact
 * per-row `summary` objects (not the full config_snapshot), honour each filter
 * (type / status / requestId / collectionId / q), clamp limit/offset, and never
 * 500 on a malformed snapshot. The full row GET /runs/:id answers comes from
 * vayu::json::serialize(Run), asserted here too so the list's compact rows and
 * the single run's full one cannot trade shapes.
 *
 * Covers the route's extracted core in isolation, matching the suite's other
 * route tests (no in-process HTTP server).
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <future>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "nested_json.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/core/spec_coverage.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/utils/diagnostics.hpp"
#include "vayu/utils/json.hpp"
#include "wait_until.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in runs.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> get_runs_response (vayu::db::Database& db,
const vayu::db::RunFilter& filter,
int64_t limit,
int64_t offset,
vayu::http::RunSummaryCache& summaries);

// Defined in runs.cpp; builds the GET /runs/:id/report `configuration`
// object from an already-parsed config_snapshot, extracted so it is testable
// without the report handler's DB/metrics dependencies.
nlohmann::json build_run_report_config (const nlohmann::json& config);
// Defined in runs.cpp; the report's `metadata` object for one stored run.
nlohmann::json build_report_metadata (const std::string& run_id, const vayu::db::Run& run);
// Defined in runs.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> set_run_baseline_response (vayu::db::Database& db,
const std::string& run_id,
const std::string& body);
// Defined in runs.cpp; the GET /runs filters off the query string.
vayu::db::RunFilter run_filter_from_query (const httplib::Request& req);
// Defined in runs.cpp; DELETE /runs, returns {http_status, json_body}.
std::pair<int, nlohmann::json> clear_runs_response (vayu::db::Database& db);
} // namespace vayu::http::routes

namespace {

/// A well-formed `dataFileHash` (issue #2051), as the seeded snapshots spell it.
constexpr const char* DATA_FILE_HASH =
"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
        vayu::tests::remove_database_files (DB_PATH);
    }

    struct RunSpec {
        std::string id;
        vayu::RunType type                    = vayu::RunType::Load;
        vayu::RunStatus status                = vayu::RunStatus::Completed;
        int64_t start_time                    = 0;
        std::optional<std::string> request_id = std::nullopt;
        std::string config_snapshot = R"({"url":"https://x.test/","method":"GET"})";
        std::string origin                       = "other";
        std::optional<std::string> origin_client = std::nullopt;
    };

    void seed (const RunSpec& s) {
        vayu::db::Run run;
        run.id              = s.id;
        run.type            = s.type;
        run.status          = s.status;
        run.request_id      = s.request_id;
        run.environment_id  = std::nullopt;
        run.config_snapshot = s.config_snapshot;
        run.origin          = s.origin;
        run.origin_client   = s.origin_client;
        run.start_time      = s.start_time;
        run.end_time        = s.start_time + 1;
        db_->create_run (run);
    }

    /// One stored exchange for @p run_id. `trace_data` is deliberately large:
    /// the list must never read this column, and a row that does shows up as a
    /// payload, not as a failure.
    // The 4 KB filler concatenation below is what GCC 13 reports as reading past
    // the small-string buffer. See utils/diagnostics.hpp.
    VAYU_IGNORE_FALSE_STRING_CONCAT_BOUNDS
    void seed_result (const std::string& run_id,
    int status_code,
    double latency_ms,
    int64_t timestamp = 1000) {
        vayu::db::Result result;
        result.run_id      = run_id;
        result.timestamp   = timestamp;
        result.status_code = status_code;
        result.status_text = "OK";
        result.latency_ms  = latency_ms;
        result.trace_data = R"({"response":{"body":")" + std::string (4096, 'x') + R"("}})";
        db_->add_result (result);
    }
    VAYU_DIAGNOSTIC_POP

    /// One stored result carrying @p trace_data as written, parseable or not.
    void seed_traced_result (const std::string& run_id,
    int status_code,
    double latency_ms,
    const std::string& trace_data) {
        vayu::db::Result result;
        result.run_id      = run_id;
        result.timestamp   = 1000;
        result.status_code = status_code;
        result.status_text = "OK";
        result.latency_ms  = latency_ms;
        result.error       = status_code == 0 ? "timed out" : "";
        result.trace_data  = trace_data;
        db_->add_result (result);
    }

    /// Renames `results` away behind the open connection, so any read of a
    /// run's rows throws: what proves a report read none (#2659).
    static void make_results_unreadable () {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (DB_PATH, &handle), SQLITE_OK);
        sqlite3_busy_timeout (handle, 5000);
        char* err = nullptr;
        if (sqlite3_exec (handle, "ALTER TABLE results RENAME TO results_unreadable",
            nullptr, nullptr, &err) != SQLITE_OK) {
            ADD_FAILURE () << "could not rename results: "
                           << (err != nullptr ? err : "(no message)");
            sqlite3_free (err);
        }
        sqlite3_close (handle);
    }

    std::unique_ptr<vayu::db::Database> db_;
    /// One per test, like the database beside it: the cache is keyed by run id
    /// and these cases reuse ids across tests, so a shared one would answer a
    /// later test from an earlier test's snapshot.
    vayu::http::RunSummaryCache summaries_;
};

// The happy path: envelope keys, DESC ordering by start_time, and the compact
// summary in place of the full config_snapshot.
TEST_F (RunsRouteTest, EnvelopeShapeAndNewestFirst) {
    seed ({ .id = "run_a", .start_time = 100 });
    seed ({ .id = "run_b", .start_time = 300 });
    seed ({ .id = "run_c", .start_time = 200 });

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
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

    auto [page1_status, page1] =
    vayu::http::routes::get_runs_response (*db_, {}, 2, 0, summaries_);
    EXPECT_EQ (page1_status, 200);
    EXPECT_EQ (page1["data"].size (), 2u);
    EXPECT_EQ (page1["pagination"]["total"], 5);
    EXPECT_EQ (page1["pagination"]["hasMore"], true);
    EXPECT_EQ (page1["pagination"]["returned"], 2);

    auto [page3_status, page3] =
    vayu::http::routes::get_runs_response (*db_, {}, 2, 4, summaries_);
    EXPECT_EQ (page3_status, 200);
    EXPECT_EQ (page3["data"].size (), 1u);
    EXPECT_EQ (page3["pagination"]["hasMore"], false);
}

TEST_F (RunsRouteTest, SummaryHasExactlyTwelveKeysAndOmitsAbsent) {
    seed ({ .id = "run_full", .config_snapshot = R"({"url":"https://a/","method":"POST","mode":"ramp_up",
    "duration":"60s","concurrency":100,"startConcurrency":5,"rampUpDuration":"20s",
    "comment":"nightly","httpVersion":"http2","followRedirects":false,"maxRedirects":5,
    "requestName":"List pets","headers":{"X":"1"}})" });
    seed ({ .id = "run_sparse", .start_time = 1, .config_snapshot = R"({"url":"https://b/"})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    // Sparse row is newest (start_time 1 > 0).
    const auto& sparse = body["data"][0]["summary"];
    EXPECT_EQ (body["data"][0]["id"], "run_sparse");
    // url present; httpVersion always defaults to "auto" when absent -
    // followRedirects/maxRedirects/comment/requestName stay omitted, they have
    // no such engine-side default to fall back to.
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
    EXPECT_FALSE (sparse.contains ("requestName"));
    EXPECT_FALSE (sparse.contains ("startConcurrency"));
    EXPECT_FALSE (sparse.contains ("rampUpDuration"));

    const auto& full = body["data"][1]["summary"];
    // Exactly the twelve documented keys, no more (headers must not leak in).
    EXPECT_EQ (full.size (), 12u);
    // ASSERT so a dropped key stops here with a legible failure rather than
    // aborting on the operator[] reads below.
    for (const char* k : { "url", "method", "mode", "duration", "concurrency",
         "startConcurrency", "rampUpDuration", "comment", "httpVersion",
         "followRedirects", "maxRedirects", "requestName" })
        ASSERT_TRUE (full.contains (k)) << k;
    EXPECT_FALSE (full.contains ("headers"));
    EXPECT_EQ (full["concurrency"], 100);
    EXPECT_EQ (full["httpVersion"], "http2");
    EXPECT_EQ (full["followRedirects"], false);
    EXPECT_EQ (full["maxRedirects"], 5);
    EXPECT_EQ (full["requestName"], "List pets");
}

// A ramp-up run's row carries its two ramp knobs (issue #1935), the same ones
// the report's `configuration` reports, so the list and the baseline comparison
// read what the run was configured with without opening the full snapshot. A
// run that is not a ramp-up has neither in its snapshot and its row has
// neither: absent, not defaulted.
TEST_F (RunsRouteTest, SummaryCarriesRampUpKnobsOnlyWhenTheSnapshotHasThem) {
    seed ({ .id = "run_ramp", .config_snapshot = R"({"url":"https://a/","mode":"ramp_up","startConcurrency":2,
    "rampUpDuration":"10s","concurrency":50})" });
    seed ({ .id = "run_constant",
    .start_time = 1,
    .config_snapshot = R"({"url":"https://b/","mode":"constant","concurrency":50})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    // Newest first: run_constant, then run_ramp.
    const auto& constant = body["data"][0]["summary"];
    EXPECT_EQ (body["data"][0]["id"], "run_constant");
    EXPECT_FALSE (constant.contains ("startConcurrency"));
    EXPECT_FALSE (constant.contains ("rampUpDuration"));

    const auto& ramp = body["data"][1]["summary"];
    EXPECT_EQ (body["data"][1]["id"], "run_ramp");
    ASSERT_TRUE (ramp.contains ("startConcurrency"));
    ASSERT_TRUE (ramp.contains ("rampUpDuration"));
    EXPECT_EQ (ramp["startConcurrency"], 2);
    EXPECT_EQ (ramp["rampUpDuration"], "10s");
    EXPECT_EQ (ramp["concurrency"], 50);
}

// `requestName` is the request's name as the client sent it at run start -
// never re-read from the requests table (see build_run_summary's doc
// comment) - which is why a run recorded before this field existed, or one
// whose client omitted it, is a bare absence rather than a fabricated name.
TEST_F (RunsRouteTest, SummaryOmitsRequestNameWhenTheSnapshotPredatesIt) {
    seed ({ .id      = "run_pre_name_field",
    .config_snapshot = R"({"url":"https://a/","method":"GET"})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_FALSE (body["data"][0]["summary"].contains ("requestName"));
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

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    // Newest first: run_no_version (start_time 1), then run_null_version (0).
    EXPECT_EQ (body["data"][0]["id"], "run_no_version");
    EXPECT_EQ (body["data"][0]["summary"]["httpVersion"], "auto");
    EXPECT_EQ (body["data"][1]["id"], "run_null_version");
    EXPECT_EQ (body["data"][1]["summary"]["httpVersion"], "auto");
}

// A baseline's list row needs the same compression signal the open run's full
// snapshot carries, since the baseline comparison reads the pinned run
// through this list endpoint rather than GET /runs/:id (issue #1488).
TEST_F (RunsRouteTest, SummaryCarriesAcceptEncodingWhenSnapshotHasIt) {
    seed ({ .id = "run_negotiated",
    .config_snapshot = R"({"url":"https://a/","defaultHeaders":{"userAgent":"Vayu/0.26.0","requestId":true,"acceptEncoding":true}})" });
    seed ({ .id = "run_not_negotiated",
    .start_time = 1,
    .config_snapshot = R"({"url":"https://b/","defaultHeaders":{"userAgent":"Vayu/0.26.0","requestId":false,"acceptEncoding":false}})" });
    seed ({ .id = "run_pre_1488", .start_time = 2, .config_snapshot = R"({"url":"https://c/"})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    // Newest first: run_pre_1488, run_not_negotiated, run_negotiated.
    EXPECT_EQ (body["data"][0]["id"], "run_pre_1488");
    EXPECT_FALSE (body["data"][0]["summary"].contains ("acceptEncoding"));
    EXPECT_EQ (body["data"][1]["id"], "run_not_negotiated");
    EXPECT_EQ (body["data"][1]["summary"]["acceptEncoding"], false);
    EXPECT_EQ (body["data"][2]["id"], "run_negotiated");
    EXPECT_EQ (body["data"][2]["summary"]["acceptEncoding"], true);
}

// Nothing reads `expectContinue` off a list row, so the row does not carry it
// (issue #2516): the report's `configuration` is where the comparison finds it.
TEST_F (RunsRouteTest, SummaryDoesNotCarryExpectContinue) {
    seed ({ .id = "run_expect_continue",
    .config_snapshot = R"({"url":"https://a/","defaultHeaders":{"acceptEncoding":true,"expectContinue":true}})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_EQ (body["data"][0]["summary"]["acceptEncoding"], true);
    EXPECT_FALSE (body["data"][0]["summary"].contains ("expectContinue"));
}

// An iterations run's count and a paced run's rate are part of what the run
// was, so the list row carries them (issue #2437); `rps` is the body's other
// spelling of the rate and reads as `targetRps` in the row, as in the report.
// Mutation check: drop `iterations` from `build_run_summary`'s key list, or the
// `add_target_rps` call, and this reds.
TEST_F (RunsRouteTest, SummaryCarriesIterationsAndTargetRpsUnderTheOneName) {
    seed ({ .id = "run_iters",
    .config_snapshot = R"({"url":"https://a/","mode":"iterations","iterations":500,"concurrency":10})" });
    seed ({ .id = "run_target",
    .start_time = 1,
    .config_snapshot = R"({"url":"https://b/","mode":"constant_rps","targetRps":120})" });
    seed ({ .id = "run_rps",
    .start_time = 2,
    .config_snapshot = R"({"url":"https://c/","mode":"constant_rps","rps":75.5})" });
    seed ({ .id      = "run_both",
    .start_time      = 3,
    .config_snapshot = R"({"url":"https://d/","rps":10,"targetRps":20})" });
    seed ({ .id = "run_null_rate",
    .start_time = 4,
    .config_snapshot = R"({"url":"https://e/","rps":null,"targetRps":null,"iterations":null})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    // Newest first: run_null_rate, run_both, run_rps, run_target, run_iters.
    ASSERT_EQ (body["data"].size (), 5u);

    const auto& nulls = body["data"][0]["summary"];
    EXPECT_FALSE (nulls.contains ("iterations"));
    EXPECT_FALSE (nulls.contains ("targetRps"));
    EXPECT_FALSE (nulls.contains ("rps"));

    // ASSERT before each read: operator[] on a missing key of a const json
    // aborts the process rather than reporting a diff.
    ASSERT_TRUE (body["data"][1]["summary"].contains ("targetRps"));
    EXPECT_EQ (body["data"][1]["summary"]["targetRps"], 10);
    EXPECT_FALSE (body["data"][1]["summary"].contains ("rps"));

    const auto& renamed = body["data"][2]["summary"];
    ASSERT_TRUE (renamed.contains ("targetRps"));
    EXPECT_EQ (renamed["targetRps"], 75.5);
    EXPECT_FALSE (renamed.contains ("rps"));

    ASSERT_TRUE (body["data"][3]["summary"].contains ("targetRps"));
    EXPECT_EQ (body["data"][3]["summary"]["targetRps"], 120);
    EXPECT_FALSE (body["data"][3]["summary"].contains ("iterations"));

    ASSERT_TRUE (body["data"][4]["summary"].contains ("iterations"));
    EXPECT_EQ (body["data"][4]["summary"]["iterations"], 500);
    EXPECT_FALSE (body["data"][4]["summary"].contains ("targetRps"));
}

// The row records the rate the run paced at: `requested_rps` reads `rps` first
// and falls to `targetRps` only when `rps` is absent, null or zero. Mutation
// check: put `targetRps` ahead of `rps` in `add_target_rps` and this reds.
TEST_F (RunsRouteTest, SummaryTargetRpsIsTheRateTheEnginePacedAt) {
    seed ({ .id      = "run_both",
    .config_snapshot = R"({"url":"https://a/","rps":10,"targetRps":20})" });
    seed ({ .id      = "run_zero_rps",
    .start_time      = 1,
    .config_snapshot = R"({"url":"https://b/","rps":0,"targetRps":20})" });
    seed ({ .id      = "run_null_rps",
    .start_time      = 2,
    .config_snapshot = R"({"url":"https://c/","rps":null,"targetRps":30})" });
    seed ({ .id = "run_zero_only", .start_time = 3, .config_snapshot = R"({"url":"https://d/","rps":0})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    // Newest first: run_zero_only, run_null_rps, run_zero_rps, run_both.
    ASSERT_EQ (body["data"].size (), 4u);

    ASSERT_TRUE (body["data"][0]["summary"].contains ("targetRps"));
    EXPECT_EQ (body["data"][0]["summary"]["targetRps"], 0);
    ASSERT_TRUE (body["data"][1]["summary"].contains ("targetRps"));
    EXPECT_EQ (body["data"][1]["summary"]["targetRps"], 30);
    ASSERT_TRUE (body["data"][2]["summary"].contains ("targetRps"));
    EXPECT_EQ (body["data"][2]["summary"]["targetRps"], 20);
    ASSERT_TRUE (body["data"][3]["summary"].contains ("targetRps"));
    EXPECT_EQ (body["data"][3]["summary"]["targetRps"], 10);
}

// A collection run's row has no url and no method - its work is a sequence -
// so `scenario` is the only thing on it that says what ran. The step manifest
// itself stays off the row: it is the size of the plan, and the row is the part
// that has to stay cheap as history grows.
//
// Which data file drove the run rides the descriptor too (issue #2051), and
// how it was read (issue #2540). Mutation check: drop `dataFileName` or
// `dataFileCastNumbers` from `add_scenario`'s key list and this reds.
TEST_F (RunsRouteTest, SummaryCarriesScenarioDescriptorWithoutTheStepManifest) {
    seed ({ .id = "run_scenario", .type = vayu::RunType::Scenario, .config_snapshot = R"({"scenario":{"source":"collection","collectionId":"col_1",
    "recursive":true,"iterations":3,"dataRowCount":2,"dataFileName":"users.csv",
    "dataFileHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","dataFileCastNumbers":true,
    "steps":[{"index":0,"requestId":"req_1","name":"login","method":"POST","url":"https://a/login"},
             {"index":1,"requestId":"req_2","name":"checkout","method":"GET","url":"https://a/cart"}]}})" });

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
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
    EXPECT_EQ (scenario.value ("dataFileName", ""), "users.csv");
    EXPECT_EQ (scenario.value ("dataFileHash", ""), DATA_FILE_HASH);
    EXPECT_EQ (scenario.value ("dataFileCastNumbers", false), true);
    // A scenario has no url/method/mode to report, and nothing invents one.
    EXPECT_FALSE (summary.contains ("url"));
    EXPECT_FALSE (summary.contains ("method"));
    EXPECT_FALSE (summary.contains ("mode"));
    // Nor a top-level file: a collection run's is on `scenario` alone.
    EXPECT_FALSE (summary.contains ("dataFileName"));
}

// A single-request load run's file sits at the snapshot's top level, beside
// `dataRowCount`, and so does its row's (issue #2051); a run without one has
// neither key. Mutation check: drop `dataFileName` or `dataFileCastNumbers`
// (issue #2540) from `build_run_summary`'s key list and this reds.
TEST_F (RunsRouteTest, SummaryCarriesALoadRunsDataFileOnlyWhenItNamedOne) {
    seed ({ .id = "run_data", .config_snapshot = R"({"url":"https://a/","mode":"constant","dataRowCount":2,
    "dataFileName":"users.csv","dataFileHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "dataFileCastNumbers":true})" });
    seed ({ .id = "run_plain", .start_time = 1, .config_snapshot = R"({"url":"https://b/","mode":"constant"})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    // Newest first: run_plain, then run_data.
    EXPECT_EQ (body["data"][0]["id"], "run_plain");
    EXPECT_FALSE (body["data"][0]["summary"].contains ("dataFileName"));
    EXPECT_FALSE (body["data"][0]["summary"].contains ("dataFileHash"));
    EXPECT_FALSE (body["data"][0]["summary"].contains ("dataFileCastNumbers"));

    EXPECT_EQ (body["data"][1]["id"], "run_data");
    const auto& summary = body["data"][1]["summary"];
    EXPECT_EQ (summary.value ("dataFileName", ""), "users.csv");
    EXPECT_EQ (summary.value ("dataFileHash", ""), DATA_FILE_HASH);
    EXPECT_EQ (summary.value ("dataFileCastNumbers", false), true);
    EXPECT_FALSE (summary.contains ("scenario"));
}

// The key is a scenario's alone: a load run must not grow one, or the app's
// "is this a collection run" read becomes true for every row.
TEST_F (RunsRouteTest, SummaryOmitsScenarioOnANonScenarioRun) {
    seed ({ .id = "run_load", .config_snapshot = R"({"url":"https://a/","mode":"constant_rps"})" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_FALSE (body["data"][0]["summary"].contains ("scenario"));
}

// A design run is one exchange, so its row says what came back. Without this a
// reader wanting a status code per row had to fetch a report per row, which
// loads and parses every result's trace_data - the cost that kept this off the
// list (#380).
TEST_F (RunsRouteTest, DesignRowCarriesItsStatusCodeAndLatency) {
    seed ({ .id = "run_design", .type = vayu::RunType::Design });
    seed_result ("run_design", 503, 42.5);

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);

    const auto& row = body["data"][0];
    ASSERT_TRUE (row.contains ("resultSummary"));
    EXPECT_EQ (row["resultSummary"]["statusCode"], 503);
    EXPECT_DOUBLE_EQ (row["resultSummary"]["latencyMs"].get<double> (), 42.5);
    // The two numbers, not the exchange: `result` (with its trace) stays on
    // GET /runs/:id, where one row's worth of bodies is one row's worth.
    EXPECT_FALSE (row.contains ("result"));
    EXPECT_FALSE (row["resultSummary"].contains ("trace"));
    EXPECT_EQ (row["resultSummary"].size (), 2u);
}

// Each design row gets its own outcome - the page is one query, so a wrong key
// here would show one run's status against another's row.
TEST_F (RunsRouteTest, EachDesignRowGetsItsOwnOutcome) {
    seed ({ .id = "run_first", .type = vayu::RunType::Design, .start_time = 1 });
    seed ({ .id = "run_second", .type = vayu::RunType::Design, .start_time = 2 });
    seed_result ("run_first", 200, 10.0);
    seed_result ("run_second", 404, 20.0);

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 2u);
    EXPECT_EQ (body["data"][0]["id"], "run_second");
    EXPECT_EQ (body["data"][0]["resultSummary"]["statusCode"], 404);
    EXPECT_EQ (body["data"][1]["id"], "run_first");
    EXPECT_EQ (body["data"][1]["resultSummary"]["statusCode"], 200);
}

// The load-run guard, at the level that enforces it. A load run's results are
// unbounded (one row per error), so they must not be read to be discarded - and
// that is a property of the statement, not of the caller remembering to filter:
// asking for a load run's outcome by id returns nothing. A load row's own
// `resultSummary` comes from its stored summary (#2130), which this run never
// wrote, so its results reaching the row would show up here as the key.
TEST_F (RunsRouteTest, LoadAndScenarioRowsNeverReadTheirResults) {
    seed ({ .id = "run_load", .type = vayu::RunType::Load });
    seed ({ .id = "run_scenario", .type = vayu::RunType::Scenario, .start_time = 1 });
    seed_result ("run_load", 500, 99.0);
    seed_result ("run_load", 500, 98.0);
    seed_result ("run_scenario", 200, 5.0);

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 2u);
    EXPECT_FALSE (body["data"][0].contains ("resultSummary"));
    EXPECT_FALSE (body["data"][1].contains ("resultSummary"));

    EXPECT_TRUE (
    db_->get_design_result_outcomes ({ "run_load", "run_scenario" }).empty ());
}

// Still running, or a result whose write failed: absent, not `statusCode: 0`,
// which is the wire's own way of saying "the request never reached a server".
TEST_F (RunsRouteTest, DesignRowWithNoStoredResultOmitsTheKey) {
    seed ({ .id = "run_running", .type = vayu::RunType::Design, .status = vayu::RunStatus::Running });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_FALSE (body["data"][0].contains ("resultSummary"));
}

// A scenario run's report `results` are the steps ScenarioRunView renders
// one row per - not a sample. Past 100 steps used to be silently dropped,
// which read as a run that executed fewer steps than it actually did.
// `maxScenarioStoredSteps` (5,000 by default) is the real bound, already
// applied at write time; the report must not impose a second, smaller one.
TEST_F (RunsRouteTest, ScenarioReportKeepsEveryStoredStepPastTheSampleCap) {
    seed ({ .id = "run_scenario_big", .type = vayu::RunType::Scenario });
    for (int i = 0; i < 150; i++) {
        seed_result ("run_scenario_big", 200, 1.0);
    }

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_scenario_big");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["results"].size (), 150u);
    EXPECT_EQ (body["resultsStored"], 150u);
    EXPECT_EQ (body["resultsCap"], 150u);
}

// What a collection run's errors cost and whether it stopped on them (issue
// #2526) reach the report's `scenario` section, and a summary that recorded
// neither - a scenario load run's, or one written before the issue - grows
// neither rather than a `0` and a `false` nobody measured.
// Mutation check: drop the `stepsNotRun` write in `build_scenario_report_section`
// and the first half fails.
TEST_F (RunsRouteTest, ScenarioReportCarriesStepsNotRunAndStopOnErrorOnlyWhenStored) {
    seed ({ .id = "run_design_seq", .type = vayu::RunType::Scenario });
    db_->update_run_summary ("run_design_seq",
    nlohmann::json{ { "scenario",
                    { { "iterations", 2 }, { "steps_executed", 4 }, { "errored", 2 },
                    { "steps_not_run", 3 }, { "stop_on_error", true } } } }
    .dump ());
    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_design_seq");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("scenario")) << body.dump ();
    EXPECT_EQ (body["scenario"]["stepsNotRun"], 3);
    EXPECT_EQ (body["scenario"]["stopOnError"], true);

    seed ({ .id = "run_older_seq", .type = vayu::RunType::Scenario });
    db_->update_run_summary ("run_older_seq",
    nlohmann::json{ { "scenario", { { "iterations", 1 }, { "steps_executed", 2 } } } }
    .dump ());
    auto [older_status, older] =
    vayu::http::routes::run_report_response (*db_, "run_older_seq");
    ASSERT_EQ (older_status, 200);
    ASSERT_TRUE (older.contains ("scenario")) << older.dump ();
    EXPECT_FALSE (older["scenario"].contains ("stepsNotRun"));
    EXPECT_FALSE (older["scenario"].contains ("stopOnError"));
}

// The sample cap stays for everything else - a design run has one row and a
// load run's percentiles do not need per-request rows past a representative
// few, so the report payload does not grow with an unbounded run's result
// count.
TEST_F (RunsRouteTest, LoadReportStillSamplesPastTheCap) {
    seed ({ .id = "run_load_big", .type = vayu::RunType::Load });
    for (int i = 0; i < 150; i++) {
        seed_result ("run_load_big", 200, 1.0);
    }

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_load_big");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["results"].size (), 100u);
    EXPECT_EQ (body["resultsStored"], 150u);
    EXPECT_EQ (body["resultsCap"], 100u);
}

/// Statuses of a report's `results`, in the order the report lists them.
std::vector<int> result_statuses (const nlohmann::json& body) {
    std::vector<int> statuses;
    for (const auto& row : body["results"]) {
        statuses.push_back (row["statusCode"].get<int> ());
    }
    return statuses;
}

// Past the cap the report keeps the failures, not the run's opening: three
// 500s stored last (the position the old first-100 cut dropped) are all in the
// 100 returned, and the rows come back in timestamp order whatever order the
// selection took them in (#2210).
TEST_F (RunsRouteTest, ReportCapKeepsFailuresStoredPastIt) {
    seed ({ .id = "run_tail_failures", .type = vayu::RunType::Load });
    for (int i = 0; i < 150; i++) {
        const bool failing = i >= 147;
        seed_result ("run_tail_failures", failing ? 500 : 200, 1.0, 1000 + i);
    }

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_tail_failures");
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["results"].size (), 100u);
    EXPECT_EQ (body["resultsStored"], 150u);
    EXPECT_EQ (body["resultsCap"], 100u);

    const auto statuses = result_statuses (body);
    EXPECT_EQ (std::count (statuses.begin (), statuses.end (), 500), 3);
    EXPECT_EQ (std::count (statuses.begin (), statuses.end (), 200), 97);

    int64_t previous = 0;
    for (const auto& row : body["results"]) {
        EXPECT_LE (previous, row["timestamp"].get<int64_t> ());
        previous = row["timestamp"].get<int64_t> ();
    }
    // The healthy rows that fill the rest are the earliest stored, so the three
    // failures close the list.
    EXPECT_EQ (statuses.back (), 500);
    EXPECT_EQ (body["results"][0]["timestamp"], 1000);
}

// A transport failure is recorded under status 0 and is a failure like any
// 4xx/5xx: it outranks healthy rows, and failures beyond the cap fill all of it.
TEST_F (RunsRouteTest, ReportCapKeepsTransportErrorsAndFillsWithFailures) {
    seed ({ .id = "run_tail_transport", .type = vayu::RunType::Load });
    for (int i = 0; i < 130; i++) {
        seed_result ("run_tail_transport", 200, 1.0, 1000 + i);
    }
    for (int i = 0; i < 5; i++) {
        seed_result ("run_tail_transport", 0, 0.0, 2000 + i);
    }

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_tail_transport");
    ASSERT_EQ (status, 200);
    auto statuses = result_statuses (body);
    ASSERT_EQ (statuses.size (), 100u);
    EXPECT_EQ (std::count (statuses.begin (), statuses.end (), 0), 5);

    seed ({ .id = "run_all_failing", .type = vayu::RunType::Load });
    for (int i = 0; i < 120; i++) {
        seed_result ("run_all_failing", i % 2 == 0 ? 0 : 503, 1.0, 1000 + i);
    }
    auto [failing_status, failing_body] =
    vayu::http::routes::run_report_response (*db_, "run_all_failing");
    ASSERT_EQ (failing_status, 200);
    statuses = result_statuses (failing_body);
    ASSERT_EQ (statuses.size (), 100u);
    EXPECT_EQ (std::count_if (statuses.begin (), statuses.end (),
               [] (int code) { return vayu::is_success_status (code); }),
    0);
    EXPECT_EQ (failing_body["resultsStored"], 120u);
}

// At or under the cap nothing is selected away: every row comes back.
TEST_F (RunsRouteTest, ReportUnderCapReturnsEveryRow) {
    seed ({ .id = "run_small", .type = vayu::RunType::Load });
    for (int i = 0; i < 100; i++) {
        seed_result ("run_small", i == 99 ? 500 : 200, 1.0, 1000 + i);
    }

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_small");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["results"].size (), 100u);
    EXPECT_EQ (body["resultsStored"], 100u);
    EXPECT_EQ (body["resultsCap"], 100u);
}

TEST_F (RunsRouteTest, MalformedSnapshotYieldsEmptySummaryNot500) {
    seed ({ .id = "run_bad", .config_snapshot = "not valid json {{{" });

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_TRUE (body["data"][0]["summary"].is_object ());
    EXPECT_TRUE (body["data"][0]["summary"].empty ());
}

/*
 * The list is polled - every visible history surface re-asks it every 5s - and
 * each call used to re-parse every row's config_snapshot to rebuild a summary
 * identical to the one the previous call built (#1150). A run's snapshot is
 * written once, at create_run, so a run id names one summary for the life of
 * the row and the second poll owes no work at all.
 */
TEST_F (RunsRouteTest, RepeatedPollsBuildEachSummaryOnce) {
    seed ({ .id = "run_a", .start_time = 1 });
    seed ({ .id = "run_b", .start_time = 2 });
    seed ({ .id = "run_c", .start_time = 3 });

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_EQ (first_status, 200);
    EXPECT_EQ (summaries_.build_count (), 3u);

    auto [second_status, second] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_EQ (second_status, 200);
    // The point of the case: three rows served, nothing rebuilt.
    EXPECT_EQ (summaries_.build_count (), 3u);
    EXPECT_EQ (second["data"], first["data"]);

    // A row that arrives later is still built - the cache answers for the runs
    // it holds, it does not freeze the list.
    seed ({ .id = "run_d", .start_time = 4 });
    auto [_, third] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_EQ (summaries_.build_count (), 4u);
    ASSERT_EQ (third["data"].size (), 4u);
    EXPECT_EQ (third["data"][0]["id"], "run_d");
}

// Issue #1527: a run with nothing to report carries no `hasWarnings` key at
// all - "absent, not false" is this row's rule for every optional flag.
TEST_F (RunsRouteTest, HasWarningsKeyOmittedWhenRunCarriesNone) {
    seed ({ .id = "run_clean" });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_FALSE (body["data"][0]["summary"].contains ("hasWarnings"));
}

// A run whose terminal summary carried warnings (#1503) surfaces that on its
// list row, which is the whole of what this issue asks for.
TEST_F (RunsRouteTest, HasWarningsTrueWhenTerminalSummaryCarriesWarnings) {
    seed ({ .id = "run_warned" });
    db_->update_run_summary ("run_warned",
    R"({"warnings":[{"code":"unresolved_tokens","message":"x"}]})");

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["summary"]["hasWarnings"], true);
}

// The case #1527 exists to prove: `hasWarnings` must never be trapped behind
// the compact summary's cache. A row polled while still running is cached
// with no warnings (correctly, none exist yet); the run then finishes with
// warnings; the very next poll - against the same cache, with no new build -
// must show them. Reverting the merge in `get_runs_response` to read
// `hasWarnings` off the cached summary instead of the live `Run` row would
// pass every other case here and fail only this one.
TEST_F (RunsRouteTest, HasWarningsReflectsCompletionDespiteTheCachedSummary) {
    seed ({ .id = "run_finishing", .status = vayu::RunStatus::Running });

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_EQ (first_status, 200);
    EXPECT_FALSE (first["data"][0]["summary"].contains ("hasWarnings"));
    EXPECT_EQ (summaries_.build_count (), 1u);

    db_->update_run_summary ("run_finishing",
    R"({"warnings":[{"code":"unresolved_tokens","message":"x"}]})");
    db_->update_run_status_with_retry ("run_finishing", vayu::RunStatus::Completed);

    auto [second_status, second] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_EQ (second_status, 200);
    EXPECT_EQ (second["data"][0]["summary"]["hasWarnings"], true);
    // The compact summary itself was never rebuilt - only `hasWarnings`,
    // merged in fresh every call, changed between the two polls.
    EXPECT_EQ (summaries_.build_count (), 1u);
}

// A malformed snapshot reads as an empty summary on every call, not only the
// first: the failure is cached like any other answer, and never becomes a 500.
TEST_F (RunsRouteTest, MalformedSnapshotStaysEmptyAcrossPolls) {
    seed ({ .id = "run_bad", .config_snapshot = "not valid json {{{" });

    for (int poll = 0; poll < 3; ++poll) {
        auto [status, body] =
        vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
        EXPECT_EQ (status, 200);
        ASSERT_EQ (body["data"].size (), 1u);
        EXPECT_TRUE (body["data"][0]["summary"].is_object ());
        EXPECT_TRUE (body["data"][0]["summary"].empty ());
    }
    EXPECT_EQ (summaries_.build_count (), 1u);
}

// The cache is bounded, so a long-lived daemon listing its way through a large
// history cannot grow it without limit - a deleted or pruned run leaves an
// entry no request can reach, and capacity is what reclaims it.
TEST_F (RunsRouteTest, SummaryCacheStaysWithinCapacity) {
    constexpr std::size_t CAPACITY = 4;
    // Not `small`: <httplib.h> pulls in <windows.h>, where MSVC defines it as `char`.
    vayu::http::RunSummaryCache bounded (CAPACITY);

    for (int i = 0; i < 10; ++i) {
        seed ({ .id = "run_" + std::to_string (i), .start_time = i });
    }

    auto [status, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, bounded);
    EXPECT_EQ (status, 200);
    EXPECT_EQ (body["data"].size (), 10u);
    EXPECT_EQ (bounded.build_count (), 10u);
    EXPECT_LE (bounded.size (), CAPACITY);
}

// #1150's listing log line (the reason it stayed at DEBUG, not INFO, is
// documented at #1150) is retired by #1510: `handle_list_runs` no longer
// hand-writes a line at all, since the centralised request logger
// (`install_request_logger`) now logs every 2xx response at DEBUG
// unconditionally, on every route - a structural guarantee this file's
// former source scan existed only to approximate for this one route.
// `request_log_test.cpp`'s `RequestLogLevelTest` covers the level rule
// itself; `RouteRequestLoggingScanTest` covers no hand-written line
// reappearing here.

TEST_F (RunsRouteTest, FilterByType) {
    seed ({ .id = "run_load", .type = vayu::RunType::Load });
    seed ({ .id = "run_design", .type = vayu::RunType::Design, .start_time = 1 });

    vayu::db::RunFilter f;
    f.type = vayu::RunType::Design;
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_design");
    EXPECT_EQ (body["pagination"]["total"], 1);
}

TEST_F (RunsRouteTest, FilterByStatus) {
    seed ({ .id = "run_done", .status = vayu::RunStatus::Completed });
    seed ({ .id = "run_fail", .status = vayu::RunStatus::Failed, .start_time = 1 });

    vayu::db::RunFilter f;
    f.status = vayu::RunStatus::Failed;
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_fail");
}

TEST_F (RunsRouteTest, FilterByRequestId) {
    seed ({ .id = "run_1", .request_id = "req_A" });
    seed ({ .id = "run_2", .start_time = 1, .request_id = "req_B" });
    seed ({ .id = "run_3", .start_time = 2, .request_id = std::nullopt });

    vayu::db::RunFilter f;
    f.request_id = "req_A";
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_1");
    EXPECT_EQ (body["data"][0]["requestId"], "req_A");
}

TEST_F (RunsRouteTest, FilterByQSubstringOverSnapshot) {
    seed ({ .id = "run_users", .config_snapshot = R"({"url":"https://api/users"})" });
    seed ({ .id = "run_orders", .start_time = 1, .config_snapshot = R"({"url":"https://api/orders"})" });

    vayu::db::RunFilter f;
    f.q = "orders";
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_orders");
}

// The scenario snapshot a collection run stores. Only the key the filter reads
// matters here, so the rest is the smallest thing that still parses as one.
std::string scenario_snapshot (const std::string& collection_id) {
    return R"({"scenario":{"collectionId":")" + collection_id + R"(","iterations":1}})";
}

TEST_F (RunsRouteTest, FilterByCollectionIdMatchesOnlyThatCollectionsRuns) {
    seed ({ .id      = "run_mine",
    .type            = vayu::RunType::Scenario,
    .config_snapshot = scenario_snapshot ("col_A") });
    seed ({ .id      = "run_theirs",
    .type            = vayu::RunType::Scenario,
    .start_time      = 1,
    .config_snapshot = scenario_snapshot ("col_B") });

    vayu::db::RunFilter f;
    f.collection_id = "col_A";
    auto [status, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0, summaries_);
    EXPECT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_mine");
    EXPECT_EQ (body["pagination"]["total"], 1);
}

// The filter reads the field, not the text around it: a design run whose URL
// happens to contain the collection id is what a substring search would have
// returned, and is the reason this is not `q`.
TEST_F (RunsRouteTest, NonScenarioRunsNeverMatchACollectionId) {
    seed ({ .id      = "run_scenario",
    .type            = vayu::RunType::Scenario,
    .config_snapshot = scenario_snapshot ("col_A") });
    seed ({ .id      = "run_design",
    .type            = vayu::RunType::Design,
    .start_time      = 1,
    .config_snapshot = R"({"url":"https://api/col_A","method":"GET"})" });
    seed ({ .id      = "run_load",
    .type            = vayu::RunType::Load,
    .start_time      = 2,
    .config_snapshot = R"({"url":"https://api/x","comment":"col_A"})" });

    vayu::db::RunFilter f;
    f.collection_id = "col_A";
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_scenario");
}

// An id nothing ran is a legitimate question with an empty answer - a
// collection that has never been run is the section's ordinary first state.
TEST_F (RunsRouteTest, UnknownCollectionIdIsAnEmptyPageNotAnError) {
    seed ({ .id      = "run_scenario",
    .type            = vayu::RunType::Scenario,
    .config_snapshot = scenario_snapshot ("col_A") });

    vayu::db::RunFilter f;
    f.collection_id = "col_ghost";
    auto [status, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0, summaries_);
    EXPECT_EQ (status, 200);
    EXPECT_EQ (body["data"].size (), 0u);
    EXPECT_EQ (body["pagination"]["total"], 0);
    EXPECT_EQ (body["pagination"]["hasMore"], false);
}

// A snapshot that is not JSON is stored verbatim (sanitize_config_snapshot), so
// the JSON read has to survive one. Without the CASE guard in run_filter_where
// this is a SQL error and the whole page 500s - including for the rows that are
// perfectly readable.
TEST_F (RunsRouteTest, AMalformedSnapshotDoesNotBreakTheCollectionFilter) {
    seed ({ .id = "run_bad", .config_snapshot = "not valid json {{{" });
    seed ({ .id      = "run_scenario",
    .type            = vayu::RunType::Scenario,
    .start_time      = 1,
    .config_snapshot = scenario_snapshot ("col_A") });

    vayu::db::RunFilter f;
    f.collection_id = "col_A";
    auto [status, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0, summaries_);
    EXPECT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_scenario");
}

// The filter is one term among the others, not a mode that replaces them.
TEST_F (RunsRouteTest, CollectionIdComposesWithTypeStatusAndLimit) {
    seed ({ .id      = "keep",
    .type            = vayu::RunType::Scenario,
    .status          = vayu::RunStatus::Completed,
    .config_snapshot = scenario_snapshot ("col_A") });
    seed ({ .id      = "wrong_status",
    .type            = vayu::RunType::Scenario,
    .status          = vayu::RunStatus::Failed,
    .start_time      = 1,
    .config_snapshot = scenario_snapshot ("col_A") });
    seed ({ .id      = "wrong_collection",
    .type            = vayu::RunType::Scenario,
    .status          = vayu::RunStatus::Completed,
    .start_time      = 2,
    .config_snapshot = scenario_snapshot ("col_B") });

    vayu::db::RunFilter f;
    f.collection_id = "col_A";
    f.type          = vayu::RunType::Scenario;
    f.status        = vayu::RunStatus::Completed;
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 1, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "keep");
    EXPECT_EQ (body["pagination"]["total"], 1);
}

// `limit=1` off a DESC-ordered list is how the context bar asks for "the last
// run of this collection", so the newest row has to be the one it gets.
TEST_F (RunsRouteTest, CollectionIdKeepsNewestFirstSoLimitOneIsTheLastRun) {
    seed ({ .id      = "older",
    .type            = vayu::RunType::Scenario,
    .start_time      = 100,
    .config_snapshot = scenario_snapshot ("col_A") });
    seed ({ .id      = "newest",
    .type            = vayu::RunType::Scenario,
    .start_time      = 300,
    .config_snapshot = scenario_snapshot ("col_A") });
    seed ({ .id      = "middle",
    .type            = vayu::RunType::Scenario,
    .start_time      = 200,
    .config_snapshot = scenario_snapshot ("col_A") });
    // Newest of all, and not ours: an unfiltered `limit=1` returns this one, so
    // the assertion below fails on a filter that does not filter.
    seed ({ .id      = "newest_elsewhere",
    .type            = vayu::RunType::Scenario,
    .start_time      = 400,
    .config_snapshot = scenario_snapshot ("col_B") });

    vayu::db::RunFilter f;
    f.collection_id = "col_A";
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 1, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "newest");
    // The page is one row of three, not one row of one.
    EXPECT_EQ (body["pagination"]["total"], 3);
    EXPECT_EQ (body["pagination"]["hasMore"], true);
}

// count_runs and get_runs_paginated read the same WHERE - a filter that only
// one of them understood would page correctly and report a wrong total.
TEST_F (RunsRouteTest, DbCountAgreesWithTheCollectionFilter) {
    seed ({ .id      = "a",
    .type            = vayu::RunType::Scenario,
    .config_snapshot = scenario_snapshot ("col_A") });
    seed ({ .id      = "b",
    .type            = vayu::RunType::Scenario,
    .start_time      = 1,
    .config_snapshot = scenario_snapshot ("col_A") });
    seed ({ .id      = "c",
    .type            = vayu::RunType::Scenario,
    .start_time      = 2,
    .config_snapshot = scenario_snapshot ("col_B") });

    vayu::db::RunFilter f;
    f.collection_id = "col_A";
    EXPECT_EQ (db_->count_runs (f), 2);
    EXPECT_EQ (db_->get_runs_paginated (f, 50, 0).size (), 2u);
    EXPECT_EQ (db_->count_runs ({}), 3); // unset -> still a wildcard
}

TEST_F (RunsRouteTest, FiltersCombine) {
    seed ({ .id = "keep",
    .type       = vayu::RunType::Design,
    .status     = vayu::RunStatus::Completed,
    .request_id = "req_X" });
    seed ({ .id = "wrong_status",
    .type       = vayu::RunType::Design,
    .status     = vayu::RunStatus::Failed,
    .start_time = 1,
    .request_id = "req_X" });
    seed ({ .id = "wrong_type",
    .type       = vayu::RunType::Load,
    .status     = vayu::RunStatus::Completed,
    .start_time = 2,
    .request_id = "req_X" });

    vayu::db::RunFilter f;
    f.type       = vayu::RunType::Design;
    f.status     = vayu::RunStatus::Completed;
    f.request_id = "req_X";
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 1, 0, summaries_);
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

// The three SQL functions the snapshot filters call, counted (#2548).
struct SnapshotPredicateCalls {
    int like         = 0;
    int json_valid   = 0;
    int json_extract = 0;
};

SnapshotPredicateCalls& snapshot_predicate_calls () {
    static SnapshotPredicateCalls calls;
    return calls;
}

// Each stand-in answers "no match" (no LIKE hit, not JSON, no such key), so a
// statement it runs in can only find less than the built-in would.
void count_like (sqlite3_context* context, int /*argc*/, sqlite3_value** /*argv*/) {
    ++snapshot_predicate_calls ().like;
    sqlite3_result_int (context, 0);
}
void count_json_valid (sqlite3_context* context, int /*argc*/, sqlite3_value** /*argv*/) {
    ++snapshot_predicate_calls ().json_valid;
    sqlite3_result_int (context, 0);
}
void count_json_extract (sqlite3_context* context, int /*argc*/, sqlite3_value** /*argv*/) {
    ++snapshot_predicate_calls ().json_extract;
    sqlite3_result_null (context);
}

struct FunctionOverride {
    const char* name                                      = nullptr;
    int arity                                             = 0;
    void (*body) (sqlite3_context*, int, sqlite3_value**) = nullptr;
};

// An auto-extension entry point: overrides the built-ins on a connection as
// it opens. The arities are the ones run_filter_where calls with (`X LIKE Y`
// is `like(Y, X)`): a function of the same name and arity replaces the
// built-in, and an exact arity outranks json_extract's variadic one.
int install_snapshot_predicate_counters (sqlite3* db,
char** /*error*/,
const sqlite3_api_routines* /*api*/) {
    const auto overrides = std::to_array<FunctionOverride> ({
    { "like", 2, &count_like },
    { "json_valid", 1, &count_json_valid },
    { "json_extract", 2, &count_json_extract },
    });
    for (const auto& [name, arity, body] : overrides) {
        const int rc = sqlite3_create_function (
        db, name, arity, SQLITE_UTF8, nullptr, body, nullptr, nullptr);
        if (rc != SQLITE_OK) {
            return rc;
        }
    }
    return SQLITE_OK;
}

// sqlite3_auto_extension takes its entry point type-erased and casts it back
// to `sqlite3_loadext_entry` before calling it.
auto snapshot_predicate_counters_entry () {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    return reinterpret_cast<void (*) ()> (&install_snapshot_predicate_counters);
}

// Installs the counters on every connection opened while this lives. A test
// cannot reach the storage's own connection, so it reopens the database
// inside one. Cancelled on scope exit because a direct run of the binary
// (no ctest) keeps one process for every test after this one.
class SnapshotPredicateCounters {
    public:
    SnapshotPredicateCounters ()
    : registered (sqlite3_auto_extension (snapshot_predicate_counters_entry ())) {
        snapshot_predicate_calls () = {};
    }
    ~SnapshotPredicateCounters () {
        sqlite3_cancel_auto_extension (snapshot_predicate_counters_entry ());
    }
    SnapshotPredicateCounters (const SnapshotPredicateCounters&) = delete;
    SnapshotPredicateCounters& operator= (const SnapshotPredicateCounters&) = delete;
    SnapshotPredicateCounters (SnapshotPredicateCounters&&)            = delete;
    SnapshotPredicateCounters& operator= (SnapshotPredicateCounters&&) = delete;

    const int registered;
};

// The 5 s History poll lists and counts with no `q` and no collection, so
// neither filter's predicate may touch a snapshot then; each set filter must
// still reach its function once per row, which is also what proves the
// counters are installed on the connection the queries run on.
TEST_F (RunsRouteTest, AnUnfilteredListNeverEvaluatesTheSnapshotPredicates) {
    constexpr int RUNS = 500;
    for (int i = 0; i < RUNS; ++i) {
        seed ({ .id      = "run_" + std::to_string (i),
        .type            = vayu::RunType::Scenario,
        .start_time      = i,
        .config_snapshot = scenario_snapshot ("col_A") });
    }

    db_.reset ();
    const SnapshotPredicateCounters counters;
    ASSERT_EQ (counters.registered, SQLITE_OK);
    // No `init ()`: its retention pass would prune the set to maxRunsRetained.
    db_ = std::make_unique<vayu::db::Database> (DB_PATH);

    auto& calls = snapshot_predicate_calls ();
    calls       = {};
    EXPECT_EQ (db_->count_runs ({}), RUNS);
    EXPECT_EQ (db_->get_runs_paginated ({}, 50, 0).size (), 50u);
    EXPECT_EQ (calls.like, 0);
    EXPECT_EQ (calls.json_valid, 0);
    EXPECT_EQ (calls.json_extract, 0);

    vayu::db::RunFilter by_text;
    by_text.q = "col_A";
    calls     = {};
    EXPECT_EQ (db_->count_runs (by_text), 0); // the stand-in never matches
    EXPECT_EQ (calls.like, RUNS);

    vayu::db::RunFilter by_collection;
    by_collection.collection_id = "col_A";
    calls                       = {};
    EXPECT_EQ (db_->count_runs (by_collection), 0);
    EXPECT_EQ (calls.json_valid, RUNS);
    EXPECT_EQ (calls.json_extract, RUNS);
}

// Every combination of the two snapshot filters over one mixed set, through
// both reads: `q` is a substring of the stored text (a malformed snapshot
// included), the collection is the parsed key (a design run naming it in its
// URL excluded), and the two together intersect.
TEST_F (RunsRouteTest, TextAndCollectionFiltersComposeOverOneSet) {
    seed ({ .id = "orders_A",
    .type       = vayu::RunType::Scenario,
    .start_time = 5,
    .config_snapshot = R"({"scenario":{"collectionId":"col_A"},"name":"orders"})" });
    seed ({ .id = "users_A",
    .type       = vayu::RunType::Scenario,
    .start_time = 4,
    .config_snapshot = R"({"scenario":{"collectionId":"col_A"},"name":"users"})" });
    seed ({ .id = "orders_B",
    .type       = vayu::RunType::Scenario,
    .start_time = 3,
    .config_snapshot = R"({"scenario":{"collectionId":"col_B"},"name":"orders"})" });
    seed ({ .id      = "orders_design",
    .type            = vayu::RunType::Design,
    .start_time      = 2,
    .config_snapshot = R"({"url":"https://api/col_A/orders"})" });
    seed ({ .id = "orders_malformed", .start_time = 1, .config_snapshot = "orders {{{" });

    const auto ids_of = [this] (const vayu::db::RunFilter& filter) {
        std::vector<std::string> ids;
        for (const auto& run : db_->get_runs_paginated (filter, 50, 0)) {
            ids.push_back (run.id);
        }
        EXPECT_EQ (db_->count_runs (filter), static_cast<int64_t> (ids.size ()));
        return ids;
    };
    using Ids = std::vector<std::string>;

    vayu::db::RunFilter by_text;
    by_text.q = "orders";
    EXPECT_EQ (ids_of (by_text),
    (Ids{ "orders_A", "orders_B", "orders_design", "orders_malformed" }));

    vayu::db::RunFilter by_collection;
    by_collection.collection_id = "col_A";
    EXPECT_EQ (ids_of (by_collection), (Ids{ "orders_A", "users_A" }));

    vayu::db::RunFilter both = by_collection;
    both.q                   = "orders";
    EXPECT_EQ (ids_of (both), (Ids{ "orders_A" }));

    vayu::db::RunFilter empty_text;
    empty_text.q = "";
    EXPECT_EQ (ids_of (empty_text).size (), 5u); // an empty `q` is no filter
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

// Same field as SummaryCarriesAcceptEncodingWhenSnapshotHasIt, read for
// GET /runs/:runId/report's `configuration` object rather than the list row
// (issue #1488).
TEST (RunReportConfigTest, CarriesAcceptEncodingWhenSnapshotHasItAndOmitsItOtherwise) {
    auto negotiated = json::parse (
    R"({"mode":"once","defaultHeaders":{"userAgent":"Vayu/0.26.0","requestId":false,"acceptEncoding":true}})");
    auto pre_1488 = json::parse (R"({"mode":"once"})");

    EXPECT_EQ (
    vayu::http::routes::build_run_report_config (negotiated)["acceptEncoding"], true);
    EXPECT_FALSE (vayu::http::routes::build_run_report_config (pre_1488).contains (
    "acceptEncoding"));
}

// The report's comparison reads `expectContinue` (issue #2516); a snapshot
// without it stays without it, so the compare readers' absent-is-false rule is
// the only place that defaults it.
TEST (RunReportConfigTest, CarriesExpectContinueWhenSnapshotHasItAndOmitsItOtherwise) {
    const auto snapshot = [] (const char* flag) {
        return json::parse (
        std::string (R"({"mode":"once","defaultHeaders":{"expectContinue":)") + flag + "}}");
    };

    EXPECT_EQ (vayu::http::routes::build_run_report_config (snapshot ("true"))["expectContinue"],
    true);
    EXPECT_EQ (vayu::http::routes::build_run_report_config (snapshot ("false"))["expectContinue"],
    false);
    EXPECT_FALSE (vayu::http::routes::build_run_report_config (json::parse (R"({"mode":"once"})"))
    .contains ("expectContinue"));
    EXPECT_FALSE (vayu::http::routes::build_run_report_config (
    json::parse (R"({"defaultHeaders":{"expectContinue":"yes"}})"))
    .contains ("expectContinue"));
}

// A single-request run's data file, beside the row count it describes (issue
// #2051), and how it was read (issue #2540). Mutation check: drop
// `dataFileName` or `dataFileCastNumbers` from `build_run_report_config`'s key
// list and this reds.
TEST (RunReportConfigTest, CarriesTheDataFileBesideTheRowCount) {
    auto config = json::parse (R"({"mode":"once","dataRowCount":2,"dataFileName":"users.csv",
    "dataFileHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","dataFileCastNumbers":true})");

    const auto config_obj = vayu::http::routes::build_run_report_config (config);
    EXPECT_EQ (config_obj.value ("dataRowCount", 0), 2);
    EXPECT_EQ (config_obj.value ("dataFileName", ""), "users.csv");
    EXPECT_EQ (config_obj.value ("dataFileHash", ""), DATA_FILE_HASH);
    EXPECT_EQ (config_obj.value ("dataFileCastNumbers", false), true);

    const auto unnamed = vayu::http::routes::build_run_report_config (
    json::parse (R"({"mode":"once","dataRowCount":2})"));
    EXPECT_FALSE (unnamed.contains ("dataFileName"));
    EXPECT_FALSE (unnamed.contains ("dataFileHash"));
    EXPECT_FALSE (unnamed.contains ("dataFileCastNumbers"));
}

// An iterations run's count, beside the other tuning knobs (issue #2437).
// Mutation check: drop `iterations` from `build_run_report_config`'s key list
// and this reds.
TEST (RunReportConfigTest, CarriesIterationsOnlyWhenTheSnapshotHasThem) {
    const auto config_obj = vayu::http::routes::build_run_report_config (
    json::parse (R"({"mode":"iterations","iterations":250,"concurrency":10})"));
    EXPECT_EQ (config_obj.value ("iterations", 0), 250);
    EXPECT_EQ (config_obj.value ("concurrency", 0), 10);

    const auto without = vayu::http::routes::build_run_report_config (
    json::parse (R"({"mode":"constant_concurrency"})"));
    EXPECT_FALSE (without.contains ("iterations"));
}

// `rps` is the POST /runs body's other spelling of `targetRps`; the report
// names the rate one way, as the engine paced at it: `rps` first, `targetRps`
// when `rps` is zero. Mutation check: put `targetRps` ahead of `rps` in
// `add_target_rps` and this reds.
TEST (RunReportMetadataTest, ConfigurationNamesTheRateTargetRps) {
    vayu::db::Run run;
    run.config_snapshot = R"({"mode":"constant_rps","rps":40})";
    auto configuration =
    vayu::http::routes::build_report_metadata ("run_1", run)["configuration"];
    EXPECT_EQ (configuration.value ("targetRps", 0), 40);
    EXPECT_FALSE (configuration.contains ("rps"));

    run.config_snapshot = R"({"mode":"constant_rps","rps":40,"targetRps":60})";
    configuration =
    vayu::http::routes::build_report_metadata ("run_2", run)["configuration"];
    EXPECT_EQ (configuration.value ("targetRps", 0), 40);

    run.config_snapshot = R"({"mode":"constant_rps","rps":0,"targetRps":60})";
    configuration =
    vayu::http::routes::build_report_metadata ("run_2b", run)["configuration"];
    EXPECT_EQ (configuration.value ("targetRps", 0), 60);

    run.config_snapshot = R"({"mode":"constant_concurrency"})";
    configuration =
    vayu::http::routes::build_report_metadata ("run_3", run)["configuration"];
    EXPECT_FALSE (configuration.contains ("targetRps"));
}

// The budgets a run carried over rather than set (issue #2195), echoed as the
// client sent them so the verdict can tag those rows. Mutation check: drop
// `carriedBudgets` from `build_run_report_config`'s key list and this reds.
TEST (RunReportConfigTest, CarriesTheCarriedBudgetsAndOmitsThemWhenAbsent) {
    auto config = json::parse (
    R"({"mode":"once","carriedBudgets":["latencyP99Ms","custom.checkout.p95"]})");

    const auto config_obj = vayu::http::routes::build_run_report_config (config);
    EXPECT_EQ (config_obj.value ("carriedBudgets", json ()),
    json::parse (R"(["latencyP99Ms","custom.checkout.p95"])"));

    const auto set_here =
    vayu::http::routes::build_run_report_config (json::parse (R"({"mode":"once"})"));
    EXPECT_FALSE (set_here.contains ("carriedBudgets"));
}

// A collection run's file is in its manifest, not the snapshot's top level, so
// `metadata.configuration` reaches into `scenario` for it and every report that
// had a file names it in one place (issue #2051), with how it was read (issue
// #2540). Mutation check: drop the fallback loop in `build_report_metadata`,
// or `dataFileCastNumbers` from its keys, and this reds.
TEST (RunReportMetadataTest, ConfigurationNamesACollectionRunsDataFile) {
    vayu::db::Run run;
    run.type = vayu::RunType::Scenario;
    run.config_snapshot = R"({"scenario":{"source":"collection","collectionId":"col_1",
    "dataRowCount":2,"dataFileName":"users.csv",
    "dataFileHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","dataFileCastNumbers":true,
    "steps":[]}})";

    const auto metadata = vayu::http::routes::build_report_metadata ("run_1", run);
    ASSERT_TRUE (metadata.contains ("configuration")) << metadata.dump ();
    const auto& configuration = metadata["configuration"];
    EXPECT_EQ (configuration.value ("dataFileName", ""), "users.csv");
    EXPECT_EQ (configuration.value ("dataFileHash", ""), DATA_FILE_HASH);
    EXPECT_EQ (configuration.value ("dataFileCastNumbers", false), true);

    run.config_snapshot = R"({"scenario":{"source":"collection","collectionId":"col_1",
    "dataRowCount":0,"steps":[]}})";
    const auto unnamed = vayu::http::routes::build_report_metadata ("run_2", run);
    ASSERT_TRUE (unnamed.contains ("configuration")) << unnamed.dump ();
    EXPECT_FALSE (unnamed["configuration"].contains ("dataFileName"));
    EXPECT_FALSE (unnamed["configuration"].contains ("dataFileHash"));
    EXPECT_FALSE (unnamed["configuration"].contains ("dataFileCastNumbers"));
}

// ============================================================================
// GET /runs/:id/report - the stored whole-run summary, and the sampled-results
// fallback when it is malformed or absent
// ============================================================================

// The whole-run results a completed load run stores on its row.
vayu::core::RunSummaryInputs summary_inputs () {
    vayu::core::RunSummaryInputs inputs;
    inputs.total_requests          = 100;
    inputs.rps                     = 50.0;
    inputs.send_rate               = 51.0;
    inputs.throughput              = 49.5;
    inputs.test_duration_s         = 2.0;
    inputs.setup_overhead_s        = 0.25;
    inputs.cleanup_overhead_s      = 0.125;
    inputs.peak_concurrency        = 8;
    inputs.avg_in_flight           = 3.25;
    inputs.dropped_requests        = 2;
    inputs.queue_wait_avg_ms       = 1.5;
    inputs.bytes_sent              = 1024;
    inputs.bytes_received          = 8192;
    inputs.status_codes            = { { 200, 90 }, { 500, 7 }, { 0, 3 } };
    inputs.latency.count           = 100;
    inputs.latency.min             = 1.0;
    inputs.latency.max             = 90.0;
    inputs.latency.p50             = 10.0;
    inputs.latency.p75             = 15.0;
    inputs.latency.p90             = 20.0;
    inputs.latency.p95             = 25.0;
    inputs.latency.p99             = 30.0;
    inputs.latency.p999            = 35.0;
    inputs.latency_avg_ms          = 12.5;
    inputs.http_version_downgraded = 4;
    inputs.connection_replays      = 6;
    inputs.tests     = vayu::core::ScriptValidationTotals{ 10, 9, 1 };
    inputs.retention = vayu::core::SamplingRetention{ 4, 300, 12, 900 };
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
    db_->update_run_summary ("run_sum",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_sum");
    ASSERT_EQ (status, 200);

    const auto& summary = body["summary"];
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), 100u);
    EXPECT_DOUBLE_EQ (summary["avgRps"].get<double> (), 50.0);
    EXPECT_DOUBLE_EQ (summary["sendRate"].get<double> (), 51.0);
    EXPECT_DOUBLE_EQ (summary["throughput"].get<double> (), 49.5);
    EXPECT_DOUBLE_EQ (summary["testDuration"].get<double> (), 2.0);
    EXPECT_DOUBLE_EQ (summary.value ("setupOverhead", -1.0), 0.25);
    EXPECT_DOUBLE_EQ (summary.value ("cleanupOverhead", -1.0), 0.125);
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
    // Requests libcurl re-sent on a new connection (#2799). Mutation check:
    // drop the `connection_replays` read in runs.cpp and this key is absent.
    EXPECT_EQ (summary.value ("connectionReplays", size_t{ 0 }), 6u);
    // The run's mean in flight (#2821). Mutation check: drop the
    // `avg_in_flight` read in runs.cpp and this key is absent.
    EXPECT_DOUBLE_EQ (summary.value ("avgInFlight", -1.0), 3.25);

    // successful/failed are recounted from the stored distribution, so the 3
    // transport errors (code 0) land on the failed side.
    EXPECT_EQ (summary["successfulRequests"].get<size_t> (), 90u);
    EXPECT_EQ (summary["failedRequests"].get<size_t> (), 10u);
    // ... and broken down the way the live tick and the stop response break
    // them down (#2124): the 7 HTTP 500s got a response, the 3 did not.
    EXPECT_EQ (summary["httpErrorRequests"].get<size_t> (), 7u);
    EXPECT_EQ (summary["noResponseRequests"].get<size_t> (), 3u);
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

// Issue #2389: a collection run's report latency is the summary's sample (the
// steps that sent), not the stored result rows - those include a skipped step's
// 0 ms and, past the store's cap, fewer rows than ran. The seeded rows here
// would give a median of 0 and a max of 5; the summary's sample says otherwise.
// Mutation check: drop the `summary["latency"]` write in
// `build_scenario_summary_payload` (or the summary read in `apply_summary_latency`)
// and the report falls back to the rows' figures.
TEST_F (RunsRouteTest, ScenarioReportLatencyIsTheSummarysSentSampleNotTheStoredRows) {
    seed ({ .id = "run_sent_sample", .type = vayu::RunType::Scenario, .start_time = 1000 });
    seed_result ("run_sent_sample", 0, 0.0);
    seed_result ("run_sent_sample", 0, 0.0);
    seed_result ("run_sent_sample", 200, 5.0);

    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 3;
    inputs.duration_s     = 1.0;
    std::vector<double> sample;
    sample.reserve (1000);
    for (int i = 1; i <= 1000; ++i) {
        sample.push_back (static_cast<double> (i));
    }
    inputs.latency = vayu::core::summarize_latencies (sample);
    db_->update_run_summary ("run_sent_sample",
    vayu::core::build_scenario_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_sent_sample");
    ASSERT_EQ (status, 200);
    const auto& latency = body["latency"];
    EXPECT_DOUBLE_EQ (latency["min"].get<double> (), 1.0);
    EXPECT_DOUBLE_EQ (latency["max"].get<double> (), 1000.0);
    EXPECT_DOUBLE_EQ (latency["avg"].get<double> (), 500.5);
    EXPECT_DOUBLE_EQ (latency["p50"].get<double> (), 500.0);
    EXPECT_DOUBLE_EQ (latency["median"].get<double> (), 500.0);
    EXPECT_DOUBLE_EQ (latency["p75"].get<double> (), 750.0);
    EXPECT_DOUBLE_EQ (latency["p90"].get<double> (), 900.0);
    EXPECT_DOUBLE_EQ (latency["p95"].get<double> (), 950.0);
    EXPECT_DOUBLE_EQ (latency["p99"].get<double> (), 990.0);
    EXPECT_DOUBLE_EQ (latency["p999"].get<double> (), 1000.0);
}

// A collection run in which no step sent stores `latency.count` 0, and the
// report leaves the block out rather than writing zeros a reader would take for
// a measurement. A summary with no `latency` key (a run stored before this
// existed) and a load run's block, which carries no `count`, keep theirs.
// Mutation check: remove the `latency_measured` guard in `build_report_body`
// and the first half fails.
TEST_F (RunsRouteTest, ScenarioReportOmitsLatencyWhenNoStepSent) {
    seed ({ .id = "run_nothing_sent", .type = vayu::RunType::Scenario, .start_time = 1000 });
    seed_result ("run_nothing_sent", 0, 0.0);
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 1;
    inputs.duration_s     = 1.0;
    db_->update_run_summary ("run_nothing_sent",
    vayu::core::build_scenario_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_nothing_sent");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("latency")) << body["latency"].dump ();
    EXPECT_EQ (body["summary"]["totalRequests"].get<size_t> (), 1u);

    seed ({ .id = "run_old_scenario", .type = vayu::RunType::Scenario, .start_time = 1000 });
    seed_result ("run_old_scenario", 200, 7.0);
    db_->update_run_summary ("run_old_scenario", R"({"total_requests":1,"test_duration":1.0})");
    auto [old_status, old_body] =
    vayu::http::routes::run_report_response (*db_, "run_old_scenario");
    ASSERT_EQ (old_status, 200);
    ASSERT_TRUE (old_body.contains ("latency"));
    EXPECT_DOUBLE_EQ (old_body["latency"]["max"].get<double> (), 7.0);
}

// #2136: a healthy run stopped with requests in flight reports what the Stop
// cancelled on its own line, and errorRate 0 - the cancelled requests are in
// neither the total nor the failed count.
TEST_F (RunsRouteTest, ReportCountsStopCancelledRequestsApartFromErrors) {
    seed ({ .id = "run_stopped", .status = vayu::RunStatus::Stopped, .start_time = 1000 });
    auto inputs           = summary_inputs ();
    inputs.total_requests = 70000;
    inputs.status_codes   = { { 200, 70000 } };
    inputs.cancelled      = 10;
    db_->update_run_summary (
    "run_stopped", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_stopped");
    ASSERT_EQ (status, 200);

    const auto& summary = body["summary"];
    EXPECT_EQ (summary["cancelledRequests"].get<size_t> (), 10u);
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), 70000u);
    EXPECT_EQ (summary["successfulRequests"].get<size_t> (), 70000u);
    EXPECT_EQ (summary["failedRequests"].get<size_t> (), 0u);
    EXPECT_EQ (summary["noResponseRequests"].get<size_t> (), 0u);
    EXPECT_DOUBLE_EQ (summary["errorRate"].get<double> (), 0.0);
    EXPECT_EQ (body["errors"]["total"].get<size_t> (), 0u);
}

// A summary stored before the key existed still answers the field, as 0, so a
// reader never has to tell "absent" from "none".
TEST_F (RunsRouteTest, ReportReadsZeroCancelledFromAnOlderSummary) {
    seed ({ .id = "run_older", .start_time = 1000 });
    auto stored = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_TRUE (stored.contains ("cancelled"));
    stored.erase ("cancelled");
    db_->update_run_summary ("run_older", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_older");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body["summary"].contains ("cancelledRequests"));
    EXPECT_EQ (body["summary"]["cancelledRequests"].get<size_t> (), 0u);
}

// A 50 RPS run that sent all 100 of its requests in 2 s, then drained for half
// a second: completed over wall time is 40/s, the pacer's own count is 100%,
// and the 25 sent in the last half second answered after sending ended.
vayu::core::RunSummaryInputs drained_run_inputs () {
    auto inputs                    = summary_inputs ();
    inputs.total_requests          = 100;
    inputs.status_codes            = { { 200, 100 } };
    inputs.test_duration_s         = 2.5;
    inputs.rps                     = 40.0;
    inputs.throughput              = 40.0;
    inputs.requests_sent           = 100;
    inputs.requests_expected       = 100;
    inputs.sending_duration_s      = 2.0;
    inputs.completed_while_sending = 75;
    inputs.send_rate               = 50.0;
    return inputs;
}

constexpr const char* TARGET_50_RPS =
R"({"url":"https://x.test/","method":"GET","mode":"constant_rps","duration":"2s","targetRps":50})";

// #2392: rate fidelity is sent over expected, in a window the drain is not
// part of. Mutation check: drop the `apply_sending_window_rates` call in
// `reconcile_report_rates` and `achievement` reads 80, `actualRps` 40.
TEST_F (RunsRouteTest, ReportRateControlDividesByTheSendingWindow) {
    seed ({ .id = "run_window", .start_time = 1000, .config_snapshot = TARGET_50_RPS });
    db_->update_run_summary ("run_window",
    vayu::core::build_run_summary_payload (drained_run_inputs ()).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_window");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("rateControl")) << body.dump ();
    const auto& rate = body["rateControl"];
    EXPECT_DOUBLE_EQ (rate["achievement"].get<double> (), 100.0);
    EXPECT_DOUBLE_EQ (rate["actualRps"].get<double> (), 50.0);
    EXPECT_EQ (rate["requestsSent"].get<size_t> (), 100u);
    EXPECT_EQ (rate["requestsExpected"].get<size_t> (), 100u);
    EXPECT_DOUBLE_EQ (body["summary"]["sendingDurationSeconds"].get<double> (), 2.0);
    // The completed-over-wall-time figures keep the drain.
    EXPECT_DOUBLE_EQ (body["summary"]["avgRps"].get<double> (), 40.0);
    EXPECT_DOUBLE_EQ (body["summary"]["throughput"].get<double> (), 40.0);
    EXPECT_DOUBLE_EQ (body["summary"]["testDuration"].get<double> (), 2.5);
    // #2882: the completions inside the window sit beside it.
    ASSERT_TRUE (body["summary"].contains ("completedWhileSending")) << body.dump ();
    EXPECT_EQ (body["summary"]["completedWhileSending"].get<size_t> (), 75u);
}

// A run stored between #2392 and #2882 has its sending window and no count of
// what completed inside it: the report leaves the key out rather than claiming
// nothing did. Mutation check: read the key with `read_number` into a plain
// `size_t` in `apply_summary_totals` and the report writes 0.
TEST_F (RunsRouteTest, ReportFromASummaryWithoutCompletedWhileSendingOmitsIt) {
    seed ({ .id = "run_pre_completed", .start_time = 1000, .config_snapshot = TARGET_50_RPS });
    auto stored = vayu::core::build_run_summary_payload (drained_run_inputs ());
    ASSERT_TRUE (stored.contains ("completed_while_sending"));
    stored.erase ("completed_while_sending");
    db_->update_run_summary ("run_pre_completed", stored.dump ());

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_pre_completed");
    ASSERT_EQ (status, 200);
    EXPECT_DOUBLE_EQ (body["summary"]["sendingDurationSeconds"].get<double> (), 2.0);
    EXPECT_FALSE (body["summary"].contains ("completedWhileSending")) << body.dump ();
}

// `rps: 0` falls through to `targetRps`, as the run paced and as the list row
// records it (#2396). Mutation check: read `rps` whenever it is present in
// `reconcile_report_rates` and the report loses its `rateControl`.
TEST_F (RunsRouteTest, ReportReadsTheRateThroughAZeroRps) {
    seed ({ .id = "run_zero_rps",
    .start_time = 1000,
    .config_snapshot = R"({"url":"https://x.test/","method":"GET","mode":"constant_rps","duration":"2s","rps":0,"targetRps":50})" });
    db_->update_run_summary ("run_zero_rps",
    vayu::core::build_run_summary_payload (drained_run_inputs ()).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_zero_rps");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("rateControl")) << body.dump ();
    EXPECT_DOUBLE_EQ (body["rateControl"]["targetRps"].get<double> (), 50.0);
}

// A Stop 1.2 s in sent at the target rate but only 60 of the 100 planned: the
// achievement is the share of the plan, not the rate. Mutation check: compute
// it from `actual_rps / target_rps` in `apply_sending_window_rates` and it
// reads 100.
TEST_F (RunsRouteTest, ReportRateFidelityOfAStoppedRunIsTheShareOfItsPlan) {
    seed ({ .id      = "run_stopped_window",
    .status          = vayu::RunStatus::Stopped,
    .start_time      = 1000,
    .config_snapshot = TARGET_50_RPS });
    auto inputs               = drained_run_inputs ();
    inputs.requests_sent      = 60;
    inputs.sending_duration_s = 1.2;
    db_->update_run_summary ("run_stopped_window",
    vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_stopped_window");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("rateControl")) << body.dump ();
    EXPECT_DOUBLE_EQ (body["rateControl"]["achievement"].get<double> (), 60.0);
    EXPECT_DOUBLE_EQ (body["rateControl"]["actualRps"].get<double> (), 50.0);
}

// A run stored before #2392 has no sending window: it keeps the achievement it
// always reported and gains no key it cannot fill.
TEST_F (RunsRouteTest, ReportFromAnOlderSummaryKeepsTheOldRateFidelity) {
    seed ({ .id = "run_pre_window", .start_time = 1000, .config_snapshot = TARGET_50_RPS });
    auto stored = vayu::core::build_run_summary_payload (drained_run_inputs ());
    for (const char* key : { "requests_sent", "requests_expected",
         "sending_duration", "completed_while_sending" }) {
        ASSERT_TRUE (stored.contains (key)) << key;
        stored.erase (key);
    }
    db_->update_run_summary ("run_pre_window", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_pre_window");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("rateControl")) << body.dump ();
    const auto& rate = body["rateControl"];
    EXPECT_DOUBLE_EQ (rate["achievement"].get<double> (), 80.0);
    EXPECT_DOUBLE_EQ (rate["actualRps"].get<double> (), 40.0);
    EXPECT_FALSE (rate.contains ("requestsSent"));
    EXPECT_FALSE (rate.contains ("requestsExpected"));
    EXPECT_FALSE (body["summary"].contains ("sendingDurationSeconds"));
    EXPECT_FALSE (body["summary"].contains ("completedWhileSending"));
}

// A run stored before #2799 never looked for replays, so its report claims
// no count rather than a 0 nobody measured.
TEST_F (RunsRouteTest, ReportFromAnOlderSummaryOmitsConnectionReplays) {
    seed ({ .id = "run_pre_replays", .start_time = 1000 });
    auto stored = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_TRUE (stored.contains ("connection_replays"));
    stored.erase ("connection_replays");
    db_->update_run_summary ("run_pre_replays", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_pre_replays");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body["summary"].contains ("connectionReplays"))
    << body["summary"].dump ();
}

// A run stored before #2821 has no mean in flight; its report leaves the key
// out rather than reporting 0 in flight for a run that sent requests.
TEST_F (RunsRouteTest, ReportFromAnOlderSummaryOmitsAvgInFlight) {
    seed ({ .id = "run_pre_in_flight", .start_time = 1000 });
    auto stored = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_TRUE (stored.contains ("avg_in_flight"));
    stored.erase ("avg_in_flight");
    db_->update_run_summary ("run_pre_in_flight", stored.dump ());

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_pre_in_flight");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body["summary"].contains ("avgInFlight")) << body["summary"].dump ();
}

// #2894: a run stored before the split timed cleanup under `setup_overhead`.
// Its report carries that figure as `cleanupOverhead` and no `setupOverhead`
// at all. Mutation check: read `setup_overhead` into the setup figure on the
// no-`cleanup_overhead` path in `apply_summary_overheads` and both fail.
TEST_F (RunsRouteTest, ReportFromAnOlderSummaryReportsItsOverheadAsCleanup) {
    seed ({ .id = "run_pre_cleanup", .start_time = 1000 });
    auto stored = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_TRUE (stored.contains ("cleanup_overhead"));
    stored.erase ("cleanup_overhead");
    stored["setup_overhead"] = 0.5;
    db_->update_run_summary ("run_pre_cleanup", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_pre_cleanup");
    ASSERT_EQ (status, 200);
    const auto& summary = body["summary"];
    EXPECT_DOUBLE_EQ (summary.value ("cleanupOverhead", -1.0), 0.5) << summary.dump ();
    EXPECT_FALSE (summary.contains ("setupOverhead")) << summary.dump ();
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

// Issue #1503: what a run did not do survives the summary -> report round
// trip, and a run with nothing to report carries no key at all rather than
// an empty array every run would otherwise show.
TEST_F (RunsRouteTest, ReportCarriesWarningsWhenTheRunHadAnyAndOmitsThemOtherwise) {
    auto warned = summary_inputs ();
    warned.warnings = nlohmann::json::array ({ { { "code", "unresolved_tokens" },
    { "message", "2 requests sent with unresolved variables: token" },
    { "count", 2 }, { "names", nlohmann::json::array ({ "token" }) } } });
    seed ({ .id = "run_warned", .start_time = 1000 });
    db_->update_run_summary (
    "run_warned", vayu::core::build_run_summary_payload (warned).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_warned");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("warnings"));
    ASSERT_EQ (body["warnings"].size (), 1u);
    EXPECT_EQ (body["warnings"][0]["code"], "unresolved_tokens");
    EXPECT_EQ (body["warnings"][0]["count"], 2);

    seed ({ .id = "run_clean", .start_time = 1000 });
    db_->update_run_summary ("run_clean",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());
    auto [clean_status, clean_body] =
    vayu::http::routes::run_report_response (*db_, "run_clean");
    ASSERT_EQ (clean_status, 200);
    EXPECT_FALSE (clean_body.contains ("warnings"));
}

// Issue #1192: `responseSamplesDropped` counts both bounds on the response
// sample store, and only one of them costs the tested set its uniformity. The
// marker is what lets the app say which run it is looking at, so it has to
// survive the summary -> report round trip in both states.
TEST_F (RunsRouteTest, ReportSaysWhetherTheResponseSampleBudgetWasSpent) {
    auto spent                                   = summary_inputs ();
    spent.retention.response_sample_budget_spent = true;
    seed ({ .id = "run_budget_spent", .start_time = 1000 });
    db_->update_run_summary (
    "run_budget_spent", vayu::core::build_run_summary_payload (spent).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_budget_spent");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body["sampling"].contains ("responseSampleBudgetSpent"));
    EXPECT_TRUE (body["sampling"]["responseSampleBudgetSpent"].get<bool> ());

    seed ({ .id = "run_count_capped", .start_time = 1000 });
    db_->update_run_summary ("run_count_capped",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());

    auto [ok, uniform] = vayu::http::routes::run_report_response (*db_, "run_count_capped");
    ASSERT_EQ (ok, 200);
    ASSERT_TRUE (uniform["sampling"].contains ("responseSampleBudgetSpent"))
    << "a run that did not spend the budget says so, rather than reading like "
       "a run nothing looked at";
    EXPECT_FALSE (uniform["sampling"]["responseSampleBudgetSpent"].get<bool> ());
}

// Server vitals survive the summary -> report round trip in the shape the
// scrape wrote them, so the section a reader sees is the one the run recorded.
TEST_F (RunsRouteTest, ReportCarriesTheMonitorSummary) {
    seed ({ .id = "run_monitor", .start_time = 1000 });
    auto inputs = summary_inputs ();
    vayu::core::MonitorTotals totals;
    totals.add ({ { "node_cpu", 1.0 } });
    totals.add ({ { "node_cpu", 3.0 } });
    totals.record_failure ();
    inputs.monitor = totals.to_summary ();
    db_->update_run_summary (
    "run_monitor", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_monitor");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("monitor"));
    EXPECT_EQ (body["monitor"]["samples"].get<size_t> (), 2u);
    EXPECT_EQ (body["monitor"]["failures"].get<size_t> (), 1u);
    EXPECT_DOUBLE_EQ (body["monitor"]["series"]["node_cpu"]["avg"].get<double> (), 2.0);
}

// The aggregate verdict a per-response script cannot give, round-tripped
// through the stored summary. The property under test is not just that the
// section survives: the error rate the verdict judged has to be the same number
// the report prints beside it, or the two halves of the report contradict.
TEST_F (RunsRouteTest, ReportCarriesTheThresholdVerdict) {
    seed ({ .id = "run_budgets", .start_time = 1000 });
    auto inputs = summary_inputs ();
    // p99 is 30 ms against a 50 ms budget (passes); the fixture's 10 failures
    // in 100 requests are 10% against a 1% budget (fails).
    const nlohmann::json config{ { "thresholds",
    { { "latencyP99Ms", 50 }, { "maxErrorRatePct", 1 } } } };
    inputs.thresholds = vayu::core::evaluate_thresholds (config, inputs);
    db_->update_run_summary (
    "run_budgets", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_budgets");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("thresholdValidation"));
    const auto& verdict = body["thresholdValidation"];
    EXPECT_EQ (verdict["verdict"].get<std::string> (), "failed");
    EXPECT_EQ (verdict["passed"].get<size_t> (), 1u);
    EXPECT_EQ (verdict["failed"].get<size_t> (), 1u);

    ASSERT_TRUE (verdict["checks"].is_array ());
    ASSERT_EQ (verdict["checks"].size (), 2u);
    EXPECT_EQ (verdict["checks"][0]["metric"].get<std::string> (), "latencyP99Ms");
    EXPECT_DOUBLE_EQ (verdict["checks"][0]["limit"].get<double> (), 50.0);
    EXPECT_DOUBLE_EQ (verdict["checks"][0]["actual"].get<double> (), 30.0);
    EXPECT_TRUE (verdict["checks"][0]["passed"].get<bool> ());
    EXPECT_TRUE (verdict["checks"][0]["evaluated"].get<bool> ());
    EXPECT_EQ (verdict["checks"][1]["metric"].get<std::string> (), "maxErrorRatePct");
    EXPECT_FALSE (verdict["checks"][1]["passed"].get<bool> ());

    // The one assertion that pins the two sides together.
    EXPECT_DOUBLE_EQ (verdict["checks"][1]["actual"].get<double> (),
    body["summary"]["errorRate"].get<double> ());
}

// #2436: `summary` is written only at terminal status, so a report read while
// the run is still going has no verdict, and `metadata.status` is what tells a
// reader it is partial. A load run's rows are read only once it is terminal
// (#2659).
TEST_F (RunsRouteTest, ReportOfARunStillRunningIsPartialUntilItCompletes) {
    seed ({ .id = "run_live", .status = vayu::RunStatus::Running, .start_time = 1000 });
    seed_result ("run_live", 200, 12.0);

    auto [live_status, live] = vayu::http::routes::run_report_response (*db_, "run_live");
    ASSERT_EQ (live_status, 200);
    EXPECT_EQ (live["metadata"]["status"].get<std::string> (), "running");
    EXPECT_EQ (live["resultsStored"].get<size_t> (), 0u);
    EXPECT_FALSE (live.contains ("thresholdValidation"));

    auto inputs       = summary_inputs ();
    inputs.thresholds = vayu::core::evaluate_thresholds (
    nlohmann::json{ { "thresholds", { { "latencyP99Ms", 50 } } } }, inputs);
    db_->update_run_summary (
    "run_live", vayu::core::build_run_summary_payload (inputs).dump ());
    db_->update_run_status ("run_live", vayu::RunStatus::Completed);

    auto [done_status, done] = vayu::http::routes::run_report_response (*db_, "run_live");
    ASSERT_EQ (done_status, 200);
    EXPECT_EQ (done["metadata"]["status"].get<std::string> (), "completed");
    EXPECT_EQ (done["resultsStored"].get<size_t> (), 1u);
    ASSERT_TRUE (done.contains ("thresholdValidation"));
    EXPECT_EQ (done["thresholdValidation"]["verdict"].get<std::string> (), "passed");
}

// #2659: a load run that is not terminal is reported from its collector, the
// counts the live stream reads, and never from `results`, which is renamed away
// here so a report that read a row would throw. Mutation check: read the rows
// for a live load run again and this test fails on the throw.
TEST_F (RunsRouteTest, ALiveLoadRunsReportCountsFromItsCollectorAndReadsNoRow) {
    seed ({ .id = "run_live", .status = vayu::RunStatus::Running, .start_time = 1000 });
    seed_result ("run_live", 200, 12.0);

    vayu::core::RunManager runs;
    auto context =
    std::make_shared<vayu::core::RunContext> ("run_live", nlohmann::json::object ());
    auto& collector = *context->metrics_collector;
    collector.record_success (200, 10.0, 1.0);
    collector.record_success (200, 12.0, 3.0);
    collector.record_success (503, 30.0, 2.0);
    collector.record_error (vayu::ErrorCode::ConnectionFailed, "refused");
    collector.record_cancelled ();
    collector.record_bytes (100, 400);
    context->peak_in_flight = 3;
    runs.register_run ("run_live", context);

    make_results_unreadable ();
    EXPECT_ANY_THROW (db_->get_results ("run_live"));

    auto [status, live] =
    vayu::http::routes::run_report_response (*db_, "run_live", &runs);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (live["metadata"]["status"].get<std::string> (), "running");
    const auto& summary = live["summary"];
    EXPECT_EQ (summary["totalRequests"].get<size_t> (), 4u);
    EXPECT_EQ (summary["successfulRequests"].get<size_t> (), 2u);
    EXPECT_EQ (summary["failedRequests"].get<size_t> (), 2u);
    EXPECT_EQ (summary["httpErrorRequests"].get<size_t> (), 1u);
    EXPECT_EQ (summary["noResponseRequests"].get<size_t> (), 1u);
    EXPECT_EQ (summary["cancelledRequests"].get<size_t> (), 1u);
    EXPECT_DOUBLE_EQ (summary["errorRate"].get<double> (), 50.0);
    EXPECT_EQ (summary["bytesSent"].get<size_t> (), 100u);
    EXPECT_EQ (summary["bytesReceived"].get<size_t> (), 400u);
    EXPECT_EQ (summary["peakConcurrency"].get<size_t> (), 3u);
    EXPECT_GT (summary["avgRps"].get<double> (), 0.0);
    // The collector's latency sum over the same duration (#2821).
    ASSERT_TRUE (summary.contains ("avgInFlight")) << summary.dump ();
    EXPECT_GT (summary["avgInFlight"].get<double> (), 0.0);
    EXPECT_EQ (live["statusCodes"], nlohmann::json::parse ("[[0,1],[200,2],[503,1]]"));
    EXPECT_EQ (live["errors"]["byStatusCode"], nlohmann::json::parse ("[[0,1],[503,1]]"));
    // The percentiles are read from histograms the run is still writing.
    EXPECT_FALSE (live.contains ("latency"));
    EXPECT_TRUE (live["results"].empty ());
    EXPECT_EQ (live["resultsStored"].get<size_t> (), 0u);
    EXPECT_EQ (live["resultsCap"].get<size_t> (), 100u);
    // ~RunManager waits out its stop grace for a run still active.
    runs.unregister_run ("run_live");
}

// Between the summary write and the status flip the report is the summary's,
// latency included, as a finished run's is - and still reads no row.
TEST_F (RunsRouteTest, ALiveLoadRunsStoredSummaryIsReportedWithoutARowRead) {
    seed ({ .id = "run_settling", .status = vayu::RunStatus::Running, .start_time = 1000 });
    seed_result ("run_settling", 200, 12.0);

    vayu::core::RunManager runs;
    auto context = std::make_shared<vayu::core::RunContext> (
    "run_settling", nlohmann::json::object ());
    context->metrics_collector->record_success (200, 10.0, 0.0);
    runs.register_run ("run_settling", context);
    db_->update_run_summary ("run_settling",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());
    make_results_unreadable ();

    auto [status, report] =
    vayu::http::routes::run_report_response (*db_, "run_settling", &runs);
    ASSERT_EQ (status, 200);
    EXPECT_EQ (report["metadata"]["status"].get<std::string> (), "running");
    EXPECT_EQ (report["summary"]["totalRequests"].get<size_t> (), 100u);
    ASSERT_TRUE (report.contains ("latency"));
    EXPECT_DOUBLE_EQ (report["latency"]["p99"].get<double> (), 30.0);
    EXPECT_EQ (report["resultsStored"].get<size_t> (), 0u);
    runs.unregister_run ("run_settling");
}

// A load run the engine holds no context for - none registered yet, or no
// manager to ask - is answered with zeros, never with its rows.
TEST_F (RunsRouteTest, ALiveLoadRunWithNoContextIsReportedAsZerosWithoutARowRead) {
    seed ({ .id = "run_pending", .status = vayu::RunStatus::Pending, .start_time = 1000 });
    seed_result ("run_pending", 503, 12.0);
    make_results_unreadable ();

    vayu::core::RunManager runs;
    for (auto* manager : { &runs, static_cast<vayu::core::RunManager*> (nullptr) }) {
        auto [status, report] =
        vayu::http::routes::run_report_response (*db_, "run_pending", manager);
        ASSERT_EQ (status, 200);
        EXPECT_EQ (report["metadata"]["status"].get<std::string> (), "pending");
        EXPECT_EQ (report["summary"]["totalRequests"].get<size_t> (), 0u);
        EXPECT_TRUE (report["statusCodes"].empty ());
        EXPECT_FALSE (report.contains ("latency"));
        EXPECT_EQ (report["resultsStored"].get<size_t> (), 0u);
    }
}

// #2679: the live poll is answered while another thread holds the DB mutex, as
// a results chunk does during the run's final flush, because the run row is
// read off the mutex and nothing else is read. Mutation check: read the row
// with `get_run` again and the report never finishes while the mutex is held.
TEST_F (RunsRouteTest, ALiveLoadRunsReportDoesNotWaitOnTheDbMutex) {
    seed ({ .id = "run_flushing", .status = vayu::RunStatus::Running, .start_time = 1000 });

    std::promise<void> holding;
    std::promise<void> release;
    std::thread holder ([this, &holding, released = release.get_future ()] {
        db_->with_lock ([&] {
            holding.set_value ();
            released.wait ();
        });
    });
    holding.get_future ().wait ();

    auto report = std::async (std::launch::async, [this] {
        return vayu::http::routes::run_report_response (*db_, "run_flushing");
    });

    const bool answered = vayu::tests::wait_until ([&] {
        return report.wait_for (std::chrono::seconds (0)) == std::future_status::ready;
    });
    release.set_value ();
    holder.join ();

    ASSERT_TRUE (answered) << "the live report waited on the held DB mutex";
    const auto [status, body] = report.get ();
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["metadata"]["status"].get<std::string> (), "running");
}

// A terminal load run is reported from its rows and summary whatever its
// context still holds: retention keeps a finished run's collector for a while,
// and the report must not change while it does.
TEST_F (RunsRouteTest, AFinishedLoadRunsReportIgnoresItsRetainedCollector) {
    seed ({ .id = "run_done", .start_time = 1000 });
    seed_traced_result ("run_done", 200, 10.0,
    R"({"dnsMs":1,"connectMs":2,"tlsMs":3,"firstByteMs":4,"downloadMs":5,"isSlow":true,"thresholdMs":8})");
    seed_traced_result ("run_done", 0, 0.0, R"({"error_type":"timeout"})");

    vayu::core::RunManager runs;
    auto context =
    std::make_shared<vayu::core::RunContext> ("run_done", nlohmann::json::object ());
    for (int i = 0; i < 5; ++i) {
        context->metrics_collector->record_success (201, 99.0, 0.0);
    }
    runs.register_run ("run_done", context);
    runs.retain_run ("run_done");

    auto [plain_status, plain] = vayu::http::routes::run_report_response (*db_, "run_done");
    auto [held_status, held] =
    vayu::http::routes::run_report_response (*db_, "run_done", &runs);
    ASSERT_EQ (plain_status, 200);
    ASSERT_EQ (held_status, 200);
    EXPECT_EQ (held, plain);
    EXPECT_EQ (held["resultsStored"].get<size_t> (), 2u);
    EXPECT_EQ (held["errors"]["types"]["timeout"].get<size_t> (), 1u);
    EXPECT_DOUBLE_EQ (held["timingBreakdown"]["avgDnsMs"].get<double> (), 1.0);
    for (const auto& row : held["results"]) {
        EXPECT_TRUE (row.contains ("trace")) << row.dump ();
    }
}

namespace {
constexpr std::string_view SLOW_TRACE = R"({"isSlow":true,"thresholdMs":500})";
}

// #2399: the slow store keeps at most `max_slow_results` traces, so counting
// them reported a 60,000-outlier run as having 3. The stored summary's count is
// the run's and the traces are reported beside it as the sample they are.
// Mutation check: drop `apply_summary_slow_requests` from apply_run_summary and
// `count` reds at 3.
TEST_F (RunsRouteTest, ReportSlowCountIsTheSummarysNotTheStoredTraces) {
    seed ({ .id = "run_slow_exact", .start_time = 1000 });
    for (int i = 0; i < 3; ++i) {
        seed_traced_result ("run_slow_exact", 200, 900.0, std::string (SLOW_TRACE));
    }
    auto inputs              = summary_inputs ();
    inputs.total_requests    = 100000;
    inputs.slow_total        = 60000;
    inputs.slow_threshold_ms = 500;
    db_->update_run_summary (
    "run_slow_exact", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_slow_exact");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("slowRequests")) << body.dump ();
    const auto& slow = body["slowRequests"];
    EXPECT_EQ (slow["count"].get<size_t> (), 60000u);
    EXPECT_EQ (slow["thresholdMs"].get<size_t> (), 500u);
    EXPECT_EQ (slow["tracesStored"].get<size_t> (), 3u);
    EXPECT_DOUBLE_EQ (slow["percentage"].get<double> (), 60.0);
}

// A summary that measured with a threshold and found nothing slow says 0, which
// is an answer; one with no `slow_requests` key (stored before #2399, or a 0
// threshold) is not, and the report counts the stored traces as it always did.
TEST_F (RunsRouteTest, ReportSlowCountFallsBackToTracesOnlyWhenTheSummaryHasNone) {
    seed ({ .id = "run_slow_zero", .start_time = 1000 });
    auto measured              = summary_inputs ();
    measured.slow_threshold_ms = 500;
    db_->update_run_summary (
    "run_slow_zero", vayu::core::build_run_summary_payload (measured).dump ());

    auto [zero_status, zero] =
    vayu::http::routes::run_report_response (*db_, "run_slow_zero");
    ASSERT_EQ (zero_status, 200);
    ASSERT_TRUE (zero.contains ("slowRequests")) << zero.dump ();
    EXPECT_EQ (zero["slowRequests"]["count"].get<size_t> (), 0u);
    EXPECT_EQ (zero["slowRequests"]["tracesStored"].get<size_t> (), 0u);
    EXPECT_EQ (zero["slowRequests"]["thresholdMs"].get<size_t> (), 500u);

    seed ({ .id = "run_slow_legacy", .start_time = 1000 });
    for (int i = 0; i < 2; ++i) {
        seed_traced_result ("run_slow_legacy", 200, 900.0, std::string (SLOW_TRACE));
    }
    const auto legacy_summary =
    vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_FALSE (legacy_summary.contains ("slow_requests"));
    db_->update_run_summary ("run_slow_legacy", legacy_summary.dump ());

    auto [legacy_status, legacy] =
    vayu::http::routes::run_report_response (*db_, "run_slow_legacy");
    ASSERT_EQ (legacy_status, 200);
    ASSERT_TRUE (legacy.contains ("slowRequests")) << legacy.dump ();
    EXPECT_EQ (legacy["slowRequests"]["count"].get<size_t> (), 2u);
    EXPECT_EQ (legacy["slowRequests"]["tracesStored"].get<size_t> (), 2u);
    EXPECT_EQ (legacy["slowRequests"]["thresholdMs"].get<size_t> (), 500u);
}

namespace {
constexpr std::string_view TIMEOUT_TRACE = R"({"error_type":"timeout"})";
}

// #2400: the error store keeps the first `maxStoredErrors` records, so counting
// them by type reported a 300,000-timeout run as 10,000 beside an exact
// 300,000 no-response count. The summary's counts are the run's; `withDetails`
// stays the stored-record count. Mutation check: drop
// `apply_summary_error_types` from apply_run_summary and `timeout` reds at
// 10,000.
TEST_F (RunsRouteTest, ReportErrorTypesAreTheSummarysNotTheStoredRecords) {
    seed ({ .id = "run_types_exact", .start_time = 1000 });
    std::vector<vayu::db::Result> stored (10000);
    for (auto& result : stored) {
        result.run_id      = "run_types_exact";
        result.timestamp   = 1000;
        result.status_code = 0;
        result.error       = "timed out";
        result.trace_data  = std::string (TIMEOUT_TRACE);
    }
    db_->add_results_batch (stored);
    auto inputs           = summary_inputs ();
    inputs.total_requests = 300000;
    inputs.status_codes   = { { 0, 300000 } };
    inputs.error_types    = { { "timeout", 300000 } };
    db_->update_run_summary (
    "run_types_exact", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_types_exact");
    ASSERT_EQ (status, 200);
    const auto& errors = body["errors"];
    EXPECT_EQ (errors["types"], (nlohmann::json{ { "timeout", 300000 } }))
    << errors.dump ();
    EXPECT_EQ (errors["withDetails"].get<size_t> (), 10000u);
    EXPECT_EQ (errors["total"].get<size_t> (), 300000u);
}

// A summary stored before #2400 has no `error_types` key, and the report counts
// the stored records by type as it always did.
TEST_F (RunsRouteTest, ReportErrorTypesFallBackToStoredRecordsOnlyWhenTheSummaryHasNone) {
    seed ({ .id = "run_types_legacy", .start_time = 1000 });
    for (int i = 0; i < 2; ++i) {
        seed_traced_result ("run_types_legacy", 0, 0.0, std::string (TIMEOUT_TRACE));
    }
    auto legacy_summary = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_EQ (legacy_summary.erase ("error_types"), 1u);
    db_->update_run_summary ("run_types_legacy", legacy_summary.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_types_legacy");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["errors"]["types"], (nlohmann::json{ { "timeout", 2 } }))
    << body["errors"].dump ();
    EXPECT_EQ (body["errors"]["withDetails"].get<size_t> (), 2u);
}

// #2659: only a load run's live report skips its rows. A design or scenario run stores
// its rows just before the status flips, and a one-shot reader (response
// restore, the step list) fetching in that gap needs `trace`.
TEST_F (RunsRouteTest, ARunningScenarioOrDesignRunsReportKeepsItsTraces) {
    for (const auto type : { vayu::RunType::Scenario, vayu::RunType::Design }) {
        const std::string id = std::string ("run_traced_") + vayu::to_string (type);
        seed ({ .id = id, .type = type, .status = vayu::RunStatus::Running, .start_time = 1000 });
        seed_traced_result (id, 200, 10.0, R"({"dnsMs":1.0})");
        auto [status, report] = vayu::http::routes::run_report_response (*db_, id);
        ASSERT_EQ (status, 200);
        ASSERT_EQ (report["results"].size (), 1u);
        EXPECT_TRUE (report["results"][0].contains ("trace")) << id;
    }
}

TEST_F (RunsRouteTest, ResultsWithoutTracesKeepEveryOtherColumnInIdOrder) {
    seed ({ .id = "run_cols" });
    seed_traced_result ("run_cols", 0, 0.0, R"({"error_type":"timeout"})");
    seed_traced_result ("run_cols", 201, 7.5, R"({"dnsMs":1})");
    seed_traced_result ("other_run", 200, 1.0, R"({"dnsMs":1})");

    const auto full    = db_->get_results ("run_cols");
    const auto without = db_->get_results_without_traces ("run_cols");
    ASSERT_EQ (full.size (), 2u);
    ASSERT_EQ (without.size (), full.size ());
    for (size_t i = 0; i < full.size (); ++i) {
        EXPECT_FALSE (full[i].trace_data.empty ());
        EXPECT_TRUE (without[i].trace_data.empty ());
        EXPECT_EQ (without[i].id, full[i].id);
        EXPECT_EQ (without[i].run_id, full[i].run_id);
        EXPECT_EQ (without[i].timestamp, full[i].timestamp);
        EXPECT_EQ (without[i].status_code, full[i].status_code);
        EXPECT_EQ (without[i].status_text, full[i].status_text);
        EXPECT_DOUBLE_EQ (without[i].latency_ms, full[i].latency_ms);
        EXPECT_EQ (without[i].error, full[i].error);
    }
    EXPECT_LT (without[0].id, without[1].id);
    EXPECT_EQ (without[0].error, "timed out");
}

// This run's custom trends, counters and rates (issue #1500), round-tripped
// through the stored summary the same way `thresholdValidation` is.
TEST_F (RunsRouteTest, ReportCarriesCustomMetrics) {
    seed ({ .id = "run_custom_metrics", .start_time = 1000 });
    auto inputs = summary_inputs ();
    vayu::core::CustomMetricSummary trend;
    trend.type            = vayu::core::CustomMetricType::Trend;
    trend.count           = 42;
    trend.p50             = 10.0;
    trend.p95             = 40.0;
    trend.p99             = 47.0;
    trend.max             = 50.0;
    inputs.custom_metrics = { { "ttfb2", trend } };
    db_->update_run_summary ("run_custom_metrics",
    vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_custom_metrics");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("customMetrics"));
    const auto& ttfb2 = body["customMetrics"]["ttfb2"];
    EXPECT_EQ (ttfb2["type"].get<std::string> (), "trend");
    EXPECT_EQ (ttfb2["count"].get<size_t> (), 42u);
    EXPECT_DOUBLE_EQ (ttfb2["p95"].get<double> (), 40.0);
}

// Issue #1484: a run whose every request errored before completing has no
// latency samples at all, and its stored `evaluated: false` / omitted
// `actual` must survive the round trip through the summary column exactly
// like every other absent-vs-zero section this report carries.
TEST_F (RunsRouteTest, ReportOmitsActualAndMarksUnevaluatedForALatencyCheckWithNoSamples) {
    seed ({ .id = "run_no_samples", .start_time = 1000 });
    vayu::core::RunSummaryInputs inputs;
    inputs.total_requests = 5999;
    inputs.status_codes   = { { 0, 5999 } };
    inputs.thresholds     = vayu::core::evaluate_thresholds (
    nlohmann::json{ { "thresholds", { { "latencyP99Ms", 200 } } } }, inputs);
    db_->update_run_summary (
    "run_no_samples", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_no_samples");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("thresholdValidation"));
    const auto& verdict = body["thresholdValidation"];
    EXPECT_EQ (verdict["verdict"].get<std::string> (), "failed");
    EXPECT_EQ (verdict["failed"].get<size_t> (), 1u);
    ASSERT_EQ (verdict["checks"].size (), 1u);
    const auto& check = verdict["checks"][0];
    EXPECT_FALSE (check["evaluated"].get<bool> ());
    EXPECT_FALSE (check["passed"].get<bool> ());
    EXPECT_FALSE (check.contains ("actual"));
}

TEST_F (RunsRouteTest, AThresholdVerdictPassesOnlyWhenNothingFailed) {
    seed ({ .id = "run_budgets_ok", .start_time = 1000 });
    auto inputs       = summary_inputs ();
    inputs.thresholds = vayu::core::evaluate_thresholds (
    nlohmann::json{ { "thresholds", { { "latencyP99Ms", 50 }, { "maxErrorRatePct", 25 } } } },
    inputs);
    db_->update_run_summary (
    "run_budgets_ok", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_budgets_ok");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["thresholdValidation"]["verdict"].get<std::string> (), "passed");
    EXPECT_EQ (body["thresholdValidation"]["failed"].get<size_t> (), 0u);
}

// ---------------------------------------------------------------------------
// GET /runs - a terminal load run's `resultSummary` (issue #2130)
// ---------------------------------------------------------------------------

/// The fixture's summary with budgets it meets (p99 30 <= 50, errors 10% <= 25%)
/// or, with @p meets false, one it misses (errors 10% > 1%).
std::string judged_summary (bool meets) {
    auto inputs              = summary_inputs ();
    const double error_limit = meets ? 25 : 1;
    inputs.thresholds        = vayu::core::evaluate_thresholds (
    nlohmann::json{
           { "thresholds", { { "latencyP99Ms", 50 }, { "maxErrorRatePct", error_limit } } } },
    inputs);
    return vayu::core::build_run_summary_payload (inputs).dump ();
}

/// The one row of @p body whose id is @p id, or an empty object.
nlohmann::json row_of (const nlohmann::json& body, const std::string& id) {
    for (const auto& row : body["data"]) {
        if (row["id"] == id) {
            return row;
        }
    }
    ADD_FAILURE () << "no row " << id;
    return nlohmann::json::object ();
}

// The four numbers a history row needs to say how a load run went, read off
// the summary the run stored rather than a report fetched per row.
TEST_F (RunsRouteTest, TerminalLoadRowCarriesItsResultSummary) {
    seed ({ .id = "run_load_done" });
    db_->update_run_summary ("run_load_done", judged_summary (true));

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    const auto& row = body["data"][0];
    ASSERT_TRUE (row.contains ("resultSummary"));
    const auto& outcome = row["resultSummary"];
    EXPECT_EQ (outcome.size (), 4u);
    for (const char* key : { "rps", "p95Ms", "errorRate", "verdict" }) {
        ASSERT_TRUE (outcome.contains (key)) << key;
    }
    EXPECT_DOUBLE_EQ (outcome["rps"].get<double> (), 50.0);
    EXPECT_DOUBLE_EQ (outcome["p95Ms"].get<double> (), 25.0);
    // 7 server errors and 3 with no response, of 100: a percentage, not 0.1.
    EXPECT_DOUBLE_EQ (outcome["errorRate"].get<double> (), 10.0);
    EXPECT_EQ (outcome["verdict"], "passed");
}

// A run `thresholds.failRun` failed reports the verdict that failed it, and the
// same verdict the report's `thresholdValidation` prints.
TEST_F (RunsRouteTest, FailedLoadRowCarriesTheVerdictThatFailedIt) {
    seed ({ .id = "run_load_failed", .status = vayu::RunStatus::Failed });
    db_->update_run_summary ("run_load_failed", judged_summary (false));

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 1u);
    ASSERT_TRUE (body["data"][0].contains ("resultSummary"));
    EXPECT_EQ (body["data"][0]["resultSummary"]["verdict"], "failed");

    auto [report_status, report] =
    vayu::http::routes::run_report_response (*db_, "run_load_failed");
    ASSERT_EQ (report_status, 200);
    EXPECT_EQ (body["data"][0]["resultSummary"]["verdict"],
    report["thresholdValidation"]["verdict"]);
}

// Each key is absent when the summary does not record it, never zeroed: a run
// with no budgets was never judged, a run with no status distribution has no
// rate, and a run with no summary at all has no `resultSummary`.
TEST_F (RunsRouteTest, LoadResultSummaryOmitsWhatTheSummaryDoesNotRecord) {
    seed ({ .id = "run_unjudged", .status = vayu::RunStatus::Stopped, .start_time = 1 });
    db_->update_run_summary ("run_unjudged",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());

    auto no_codes         = summary_inputs ();
    no_codes.status_codes = {};
    seed ({ .id = "run_no_codes", .start_time = 2 });
    db_->update_run_summary (
    "run_no_codes", vayu::core::build_run_summary_payload (no_codes).dump ());

    // A `thresholds` object with no rows is the report's "never judged" too.
    seed ({ .id = "run_no_checks", .start_time = 3 });
    db_->update_run_summary ("run_no_checks",
    R"({"rps":5,"thresholds":{"checks":[],"passed":0,"failed":0}})");

    seed ({ .id = "run_no_summary", .start_time = 4 });
    seed ({ .id = "run_bad_summary", .start_time = 5 });
    db_->update_run_summary ("run_bad_summary", "not valid json {{{");
    seed ({ .id = "run_other_keys", .start_time = 6 });
    db_->update_run_summary ("run_other_keys", R"({"total_requests":3})");

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);

    const auto unjudged = row_of (body, "run_unjudged");
    ASSERT_TRUE (unjudged.contains ("resultSummary"));
    EXPECT_EQ (unjudged["resultSummary"].size (), 3u);
    EXPECT_FALSE (unjudged["resultSummary"].contains ("verdict"));

    const auto no_codes_row = row_of (body, "run_no_codes");
    ASSERT_TRUE (no_codes_row.contains ("resultSummary"));
    EXPECT_FALSE (no_codes_row["resultSummary"].contains ("errorRate"));
    EXPECT_TRUE (no_codes_row["resultSummary"].contains ("rps"));
    EXPECT_TRUE (no_codes_row["resultSummary"].contains ("p95Ms"));

    const auto no_checks = row_of (body, "run_no_checks");
    ASSERT_TRUE (no_checks.contains ("resultSummary"));
    EXPECT_EQ (no_checks["resultSummary"], (nlohmann::json{ { "rps", 5 } }));

    for (const char* id : { "run_no_summary", "run_bad_summary", "run_other_keys" }) {
        EXPECT_FALSE (row_of (body, id).contains ("resultSummary")) << id;
    }
}

// The gate is the status, not whether a summary is there yet: a Pending or
// Running row is never read and never cached, so the poll after the run ends
// builds its outcome fresh. Dropping the gate fails the second poll (the
// summary lands before the status) and the third (an entry cached while
// running would be served forever).
TEST_F (RunsRouteTest, LoadRowGetsNoResultSummaryUntilItsStatusIsTerminal) {
    seed ({ .id = "run_pending", .status = vayu::RunStatus::Pending, .start_time = 1 });
    seed ({ .id = "run_live", .status = vayu::RunStatus::Running, .start_time = 2 });

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (first_status, 200);
    ASSERT_EQ (first["data"].size (), 2u);
    EXPECT_FALSE (first["data"][0].contains ("resultSummary"));
    EXPECT_FALSE (first["data"][1].contains ("resultSummary"));

    // The order every writer keeps: summary first, terminal status second.
    db_->update_run_summary ("run_live", judged_summary (true));
    auto [_, second] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    EXPECT_FALSE (row_of (second, "run_live").contains ("resultSummary"));
    EXPECT_EQ (summaries_.outcome_build_count (), 0u);

    db_->update_run_status_with_retry ("run_live", vayu::RunStatus::Completed);
    auto [third_status, third] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (third_status, 200);
    const auto finished = row_of (third, "run_live");
    ASSERT_TRUE (finished.contains ("resultSummary"));
    EXPECT_EQ (finished["resultSummary"]["verdict"], "passed");
    EXPECT_FALSE (row_of (third, "run_pending").contains ("resultSummary"));
    EXPECT_EQ (summaries_.outcome_build_count (), 1u);
}

// A stop that finds no registered worker writes Stopped with no summary, and
// the worker stores its own afterwards. The poll between the two must neither
// build nor cache an empty outcome, or the real one would never show. Dropping
// the non-empty gate fails the first poll's build count and the last poll's key.
TEST_F (RunsRouteTest, StoppedLoadRowWithoutSummaryIsNotCachedBeforeTheWorkerWritesOne) {
    seed ({ .id = "run_early_stop", .status = vayu::RunStatus::Stopped });

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (first_status, 200);
    EXPECT_FALSE (row_of (first, "run_early_stop").contains ("resultSummary"));
    EXPECT_EQ (summaries_.outcome_build_count (), 0u);

    db_->update_run_summary ("run_early_stop", judged_summary (true));
    auto [second_status, second] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (second_status, 200);
    const auto finished = row_of (second, "run_early_stop");
    ASSERT_TRUE (finished.contains ("resultSummary"));
    EXPECT_EQ (finished["resultSummary"]["verdict"], "passed");
    EXPECT_EQ (summaries_.outcome_build_count (), 1u);
}

// A terminal load run's summary is final, so the poll parses it once - and
// only a load row's: a design or scenario row never asks for an outcome.
TEST_F (RunsRouteTest, RepeatedPollsParseEachLoadSummaryOnce) {
    for (const char* id : { "run_l1", "run_l2", "run_l3" }) {
        seed ({ .id = id });
        db_->update_run_summary (id, judged_summary (true));
    }
    seed ({ .id = "run_d", .type = vayu::RunType::Design, .start_time = 1 });
    seed ({ .id = "run_s", .type = vayu::RunType::Scenario, .start_time = 2 });

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (first_status, 200);
    EXPECT_EQ (summaries_.outcome_build_count (), 3u);
    EXPECT_EQ (summaries_.build_count (), 5u);

    auto [second_status, second] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (second_status, 200);
    EXPECT_EQ (summaries_.outcome_build_count (), 3u);
    EXPECT_EQ (summaries_.build_count (), 5u);
    EXPECT_EQ (second["data"], first["data"]);
}

// The design row keeps its own two numbers and a scenario row carries none,
// even when either stored a summary a load row would read.
TEST_F (RunsRouteTest, DesignAndScenarioRowsKeepTheirOwnResultSummary) {
    const auto stored =
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ();
    seed ({ .id = "run_design", .type = vayu::RunType::Design, .start_time = 1 });
    db_->update_run_summary ("run_design", stored);
    seed_result ("run_design", 201, 7.5);
    seed ({ .id = "run_scenario", .type = vayu::RunType::Scenario, .start_time = 2 });
    db_->update_run_summary ("run_scenario", stored);

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    const auto design = row_of (body, "run_design");
    ASSERT_TRUE (design.contains ("resultSummary"));
    EXPECT_EQ (design["resultSummary"],
    (nlohmann::json{ { "statusCode", 201 }, { "latencyMs", 7.5 } }));
    EXPECT_FALSE (row_of (body, "run_scenario").contains ("resultSummary"));
    EXPECT_EQ (summaries_.outcome_build_count (), 0u);
}

// ---------------------------------------------------------------------------
// Contract coverage (issue #629)
// ---------------------------------------------------------------------------

// The whole path in one assertion set: a tally records what a run sent, the
// summary stores what it built, and the report hands it back unchanged. The
// pass-through is the property - re-keying it in the route would be a second
// place to keep the shape, which is why nothing here translates a name.
TEST_F (RunsRouteTest, ReportCarriesTheCoverageBlockTheRunComputed) {
    seed ({ .id = "run_coverage", .start_time = 1000 });

    vayu::core::DeclaredOperation listed;
    listed.operation_id = "listPets";
    listed.method       = "GET";
    listed.path         = "/pets";
    listed.responses    = { "200", "404" };
    vayu::core::DeclaredOperation never;
    never.method    = "DELETE";
    never.path      = "/pets/{petId}";
    never.responses = { "204" };

    vayu::core::CoverageTally tally ({ listed, never },
    { R"({"operationId":"listPets","method":"GET","path":"/pets"})" });
    tally.record (0, 200);
    tally.record (0, 500);

    auto inputs     = summary_inputs ();
    inputs.coverage = tally.build ();
    db_->update_run_summary (
    "run_coverage", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_coverage");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("coverage")) << body.dump ();
    const auto& coverage = body["coverage"];
    EXPECT_EQ (coverage["operationsTotal"].get<size_t> (), 2u);
    EXPECT_EQ (coverage["operationsCovered"].get<size_t> (), 1u);
    EXPECT_EQ (coverage["declaredResponsesTotal"].get<size_t> (), 3u);
    EXPECT_EQ (coverage["declaredResponsesHit"].get<size_t> (), 1u);
    EXPECT_EQ (coverage["undeclaredStatusesSeen"].get<size_t> (), 1u);
    // Uncovered first, so the operation nobody called is the first row read.
    ASSERT_EQ (coverage["operations"].size (), 2u);
    EXPECT_EQ (coverage["operations"][0]["path"].get<std::string> (), "/pets/{petId}");
    EXPECT_EQ (coverage["operations"][0]["sent"].get<size_t> (), 0u);
}

// ---------------------------------------------------------------------------
// Single-request run element outcomes (issues #1594, #1641)
// ---------------------------------------------------------------------------

// The engine already wrote a single-request run's per-element tally onto its
// summary (issue #1594, `RequestElementTallies::build`); the report route
// dropped the key before this fix (issue #1641). Same whole path as coverage
// above: computed, stored, handed back unchanged, no name translated.
TEST_F (RunsRouteTest, ReportCarriesTheElementsBlockTheRunComputed) {
    seed ({ .id = "run_elements", .start_time = 1000 });

    auto inputs = summary_inputs ();
    inputs.elements =
    nlohmann::json::array ({ { { "id", "el_1" }, { "kind", "assert.status" },
                             { "passed", 9 }, { "failed", 1 }, { "skipped", 0 } },
    { { "id", "el_2" }, { "kind", "extract.json" }, { "passed", 10 },
    { "failed", 0 }, { "skipped", 0 } } });
    db_->update_run_summary (
    "run_elements", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_elements");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("elements")) << body.dump ();
    const auto& elements = body["elements"];
    ASSERT_EQ (elements.size (), 2u);
    EXPECT_EQ (elements[0]["kind"].get<std::string> (), "assert.status");
    EXPECT_EQ (elements[0]["passed"].get<size_t> (), 9u);
    EXPECT_EQ (elements[0]["failed"].get<size_t> (), 1u);
    EXPECT_EQ (elements[1]["kind"].get<std::string> (), "extract.json");
}

// ---------------------------------------------------------------------------
// Sampled schema validation (issue #682)
// ---------------------------------------------------------------------------

// The same whole path, for the block beside coverage: the deferred pass tallies
// what the reservoirs held, the summary stores it, and the report hands it back
// unchanged. Nothing translates a name here either.
TEST_F (RunsRouteTest, ReportCarriesTheSchemaValidationBlockTheRunComputed) {
    seed ({ .id = "run_schema", .start_time = 1000 });

    vayu::core::ValidationVerdict passed;
    passed.checked = true;
    passed.valid   = true;
    vayu::core::ValidationVerdict broke;
    broke.checked  = true;
    broke.valid    = false;
    broke.failures = { vayu::core::SchemaFailure{ "/id", "expected integer" } };
    broke.failures_total = 1;
    vayu::core::ValidationVerdict skipped;
    skipped.reason = vayu::core::UncheckedReason::BodyNotJson;

    vayu::core::SampledValidationTotals totals;
    totals.record (passed, "list pets", 200);
    totals.record (broke, "get pet", 200);
    totals.record (skipped, "get pet", 500);

    auto inputs = summary_inputs ();
    inputs.schema_validation = vayu::core::build_sampled_validation_payload (totals);
    db_->update_run_summary (
    "run_schema", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_schema");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("schemaValidation")) << body.dump ();
    const auto& validation = body["schemaValidation"];
    // The denominator rides through: without it a reader cannot tell these
    // figures describe the reservoir rather than the run.
    EXPECT_EQ (validation["sampled"].get<size_t> (), 3u);
    EXPECT_EQ (validation["checked"].get<size_t> (), 2u);
    EXPECT_EQ (validation["valid"].get<size_t> (), 1u);
    EXPECT_EQ (validation["failed"].get<size_t> (), 1u);
    EXPECT_EQ (validation["uncheckedReasons"]["body_not_json"].get<size_t> (), 1u);
    ASSERT_EQ (validation["failures"].size (), 1u);
    EXPECT_EQ (validation["failures"][0]["step"].get<std::string> (), "get pet");
}

// The anchor coverage is read against, asserted at the route for the first time
// (noted on #629 when phase 1 closed): the report echoes the *snapshot's*
// binding, so a reader can say which document a coverage block was computed
// against - and an unbound run echoes nothing at all.
TEST_F (RunsRouteTest, ReportEchoesTheSpecTheRunWasPlannedAgainst) {
    seed ({ .id = "run_openapi",
    .start_time = 1000,
    .config_snapshot = R"({"url":"https://x.test/","scenario":{"collectionId":"col_1","openapi":{"specId":"spec_1","specHash":"abc"}}})" });

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_openapi");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body["metadata"].contains ("openapi")) << body.dump ();
    EXPECT_EQ (body["metadata"]["openapi"]["specId"].get<std::string> (), "spec_1");
    EXPECT_EQ (body["metadata"]["openapi"]["specHash"].get<std::string> (), "abc");

    seed ({ .id = "run_unbound",
    .start_time = 1000,
    .config_snapshot = R"({"url":"https://x.test/","scenario":{"collectionId":"col_1"}})" });
    auto [unbound_status, unbound] =
    vayu::http::routes::run_report_response (*db_, "run_unbound");
    ASSERT_EQ (unbound_status, 200);
    EXPECT_FALSE (unbound["metadata"].contains ("openapi")) << unbound.dump ();
}

// Mid-run OAuth 2.0 refresh (#478), round-tripped through the stored summary:
// the section is what explains 401s that appear partway through a run, so it
// has to survive the write/read pair, not merely be produced.
TEST_F (RunsRouteTest, ReportCarriesTheAuthRefreshSection) {
    seed ({ .id = "run_auth", .start_time = 1000 });
    auto inputs = summary_inputs ();
    inputs.auth = nlohmann::json{ { "refreshes", { { { "atSeconds", 3620.4 } } } },
        { "refreshFailures", 1 }, { "lastError", "oauth2_provider_error: invalid_grant" } };
    db_->update_run_summary (
    "run_auth", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_auth");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("auth"));
    const auto& auth = body["auth"];
    ASSERT_TRUE (auth["refreshes"].is_array ());
    ASSERT_EQ (auth["refreshes"].size (), 1u);
    EXPECT_DOUBLE_EQ (auth["refreshes"][0]["atSeconds"].get<double> (), 3620.4);
    EXPECT_EQ (auth["refreshFailures"].get<size_t> (), 1u);
    EXPECT_EQ (auth["lastError"].get<std::string> (), "oauth2_provider_error: invalid_grant");
}

// What a capacity search found, round-tripped through the stored summary. The
// property under test is the translation: the search stores snake_case like
// every other section, and the report speaks camelCase, so a key added on one
// side and forgotten on the other reaches the renderer as an absent field
// rather than as a build error.
TEST_F (RunsRouteTest, ReportCarriesWhatTheCapacitySearchFound) {
    seed ({ .id = "run_capacity", .start_time = 1000 });
    auto inputs = summary_inputs ();

    vayu::core::CapacityConfig search;
    search.slo_ms          = 100.0;
    search.max_concurrency = 256;
    const std::vector<vayu::core::CapacityWindow> levels{ { 8, 900.0, 12.0, 0.0 },
        { 16, 1700.0, 20.0, 0.5 }, { 32, 1750.0, 180.0, 2.0 },
        { 32, 1720.0, 210.0, 3.5 } };
    inputs.capacity = vayu::core::summarize_capacity (
    search, levels, vayu::core::capacity_stop::SLO_EXCEEDED);
    db_->update_run_summary (
    "run_capacity", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_capacity");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("capacity"));
    const auto& capacity = body["capacity"];
    EXPECT_DOUBLE_EQ (capacity["sloMs"].get<double> (), 100.0);
    EXPECT_EQ (capacity["stopReason"].get<std::string> (), "slo_exceeded");
    EXPECT_EQ (capacity["maxHealthyConcurrency"].get<size_t> (), 16u);
    EXPECT_DOUBLE_EQ (capacity["maxHealthyRps"].get<double> (), 1700.0);
    EXPECT_DOUBLE_EQ (capacity["p99AtMaxHealthyMs"].get<double> (), 20.0);
    EXPECT_EQ (capacity["kneeConcurrency"].get<size_t> (), 32u);
    EXPECT_DOUBLE_EQ (capacity["kneeP99Ms"].get<double> (), 210.0);
    EXPECT_DOUBLE_EQ (capacity.at ("kneeErrorPct").get<double> (), 3.5);
    EXPECT_DOUBLE_EQ (capacity.at ("maxErrorPct").get<double> (), search.max_error_pct);
    EXPECT_FALSE (capacity.contains ("saturationConcurrency"));

    ASSERT_EQ (capacity["levels"].size (), 4u);
    EXPECT_EQ (capacity["levels"][0]["concurrency"].get<size_t> (), 8u);
    EXPECT_DOUBLE_EQ (capacity["levels"][0]["rps"].get<double> (), 900.0);
    EXPECT_DOUBLE_EQ (capacity["levels"][0]["p99Ms"].get<double> (), 12.0);
    EXPECT_DOUBLE_EQ (capacity["levels"][1].at ("errorPct").get<double> (), 0.5);
}

// A summary stored before #2815 measured no error share. The report leaves the
// three keys out rather than reading them as 0%, which would call every level
// of an old search clean.
// Mutation-check: read the keys through `read_number` with a 0 default and the
// absent keys come back as zeros.
TEST_F (RunsRouteTest, ReportOmitsTheErrorShareAnOlderSummaryNeverStored) {
    seed ({ .id = "run_capacity_old", .start_time = 1000 });
    auto inputs = summary_inputs ();

    vayu::core::CapacityConfig search;
    search.slo_ms   = 100.0;
    inputs.capacity = vayu::core::summarize_capacity (search,
    { { 8, 900.0, 12.0 }, { 16, 1700.0, 180.0 }, { 16, 1690.0, 190.0 } },
    vayu::core::capacity_stop::SLO_EXCEEDED);
    auto stored     = vayu::core::build_run_summary_payload (inputs);
    ASSERT_TRUE (stored.contains ("capacity"));
    auto& section = stored["capacity"];
    section.erase ("max_error_pct");
    section.erase ("knee_error_pct");
    for (auto& level : section["levels"]) {
        level.erase ("error_pct");
    }
    db_->update_run_summary ("run_capacity_old", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_capacity_old");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("capacity"));
    const auto& capacity = body["capacity"];
    EXPECT_EQ (capacity["kneeConcurrency"].get<size_t> (), 16u);
    EXPECT_FALSE (capacity.contains ("kneeErrorPct"));
    EXPECT_FALSE (capacity.contains ("maxErrorPct"));
    ASSERT_EQ (capacity["levels"].size (), 3u);
    EXPECT_FALSE (capacity["levels"][0].contains ("errorPct"));
}

// A search that ran out of room never watched the service give out, so the
// report carries the headline without a knee - rather than naming the last
// level it happened to reach as the limit.
TEST_F (RunsRouteTest, ReportOmitsTheKneeWhenNoLevelBreached) {
    seed ({ .id = "run_capacity_cap", .start_time = 1000 });
    auto inputs = summary_inputs ();

    vayu::core::CapacityConfig search;
    search.slo_ms   = 100.0;
    inputs.capacity = vayu::core::summarize_capacity (
    search, { { 8, 900.0, 12.0 } }, vayu::core::capacity_stop::CAP_REACHED);
    db_->update_run_summary (
    "run_capacity_cap", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_capacity_cap");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("capacity"));
    EXPECT_FALSE (body["capacity"].contains ("kneeConcurrency"));
    EXPECT_EQ (body["capacity"]["maxHealthyConcurrency"].get<size_t> (), 8u);
    EXPECT_FALSE (body["capacity"].contains ("saturationConcurrency"));
    EXPECT_FALSE (body["capacity"].contains ("saturationRps"));
    EXPECT_FALSE (body["capacity"].contains ("saturationP99Ms"));
}

// A plateau stop names the level where throughput stopped growing beside the
// last level tried, which overshoots it (#2817).
// Mutation-check: leave the three `saturation_*` keys out of
// `read_capacity_section` and they never reach the report.
TEST_F (RunsRouteTest, ReportCarriesTheSaturationOfAPlateau) {
    seed ({ .id = "run_capacity_plateau", .start_time = 1000 });
    auto inputs = summary_inputs ();

    vayu::core::CapacityConfig search;
    search.slo_ms   = 200.0;
    inputs.capacity = vayu::core::summarize_capacity (search,
    { { 6, 130.0, 31.0, 0.0 }, { 8, 156.0, 52.0, 0.0 },
    { 10, 156.0, 103.0, 0.0 }, { 12, 156.0, 103.0, 0.0 } },
    vayu::core::capacity_stop::PLATEAU);
    db_->update_run_summary ("run_capacity_plateau",
    vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_capacity_plateau");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("capacity"));
    const auto& capacity = body["capacity"];
    EXPECT_EQ (capacity["stopReason"].get<std::string> (), "plateau");
    EXPECT_EQ (capacity["saturationConcurrency"].get<size_t> (), 8u);
    EXPECT_DOUBLE_EQ (capacity["saturationRps"].get<double> (), 156.0);
    EXPECT_DOUBLE_EQ (capacity["saturationP99Ms"].get<double> (), 52.0);
    EXPECT_EQ (capacity["maxHealthyConcurrency"].get<size_t> (), 12u);
}

// Per-phase percentiles round-trip from the histogram bank into the report,
// under `timingBreakdown` beside the averages (issue #476).
TEST_F (RunsRouteTest, ReportCarriesPerPhasePercentiles) {
    seed ({ .id = "run_phases", .start_time = 1000 });
    auto inputs = summary_inputs ();

    std::array<vayu::core::MetricsCollector::Percentiles, vayu::core::TIMING_PHASE_COUNT> phases{};
    // Five distinct magnitudes, so a phase written into the wrong key fails here.
    const auto p50s = std::to_array<double> ({ 0.1, 0.3, 0.0, 2.9, 0.1 });
    const auto p99s = std::to_array<double> ({ 1.4, 8.2, 22.0, 6.1, 0.9 });
    for (size_t i = 0; i < vayu::core::TIMING_PHASE_COUNT; ++i) {
        auto& phase = phases.at (i);
        phase.count = 4321;
        phase.p50   = p50s.at (i);
        phase.p95   = p50s.at (i) * 2.0;
        phase.p99   = p99s.at (i);
        phase.max   = p99s.at (i) * 3.0;
    }
    inputs.phases = phases;
    db_->update_run_summary (
    "run_phases", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_phases");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("timingBreakdown"));
    const auto& breakdown = body["timingBreakdown"];
    ASSERT_TRUE (breakdown.contains ("phases"));
    const auto& reported = breakdown["phases"];

    // Keyed by wire name - `firstByte`, not `ttfb`, and not an array index.
    EXPECT_DOUBLE_EQ (reported["dns"]["p50"].get<double> (), 0.1);
    EXPECT_DOUBLE_EQ (reported["connect"]["p99"].get<double> (), 8.2);
    EXPECT_DOUBLE_EQ (reported["tls"]["p99"].get<double> (), 22.0);
    EXPECT_DOUBLE_EQ (reported["firstByte"]["p50"].get<double> (), 2.9);
    EXPECT_DOUBLE_EQ (reported["download"]["max"].get<double> (), 2.7);
    EXPECT_EQ (reported["tls"]["count"].get<size_t> (), 4321u);
}

namespace {

/// Five phases of 4321 completions each, for a summary's `phases`.
std::array<vayu::core::MetricsCollector::Percentiles, vayu::core::TIMING_PHASE_COUNT>
counted_phases () {
    std::array<vayu::core::MetricsCollector::Percentiles, vayu::core::TIMING_PHASE_COUNT> phases{};
    for (auto& phase : phases) {
        phase.count = 4321;
    }
    return phases;
}

constexpr std::string_view TIMED_TRACE =
R"({"dnsMs":1,"connectMs":2,"tlsMs":3,"firstByteMs":4,"downloadMs":5})";

} // namespace

// #2782: the averages are every completion's, read from each phase's stored
// mean, not the retained trace sample's. The one stored trace says 2 ms of
// connect; the bank's mean over 4321 completions says 0.25 ms. Mutation
// check: drop `apply_summary_phase_means` from `apply_run_summary` and every
// average reads the trace's.
TEST_F (RunsRouteTest, ReportAveragesAreThePhaseMeansNotTheTraceSamples) {
    seed ({ .id = "run_phase_means", .start_time = 1000 });
    seed_traced_result ("run_phase_means", 200, 10.0, std::string (TIMED_TRACE));
    auto inputs   = summary_inputs ();
    inputs.phases = counted_phases ();
    inputs.phase_means = std::to_array<double> ({ 0.05, 0.25, 0.75, 2.5, 0.125 });
    db_->update_run_summary (
    "run_phase_means", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_phase_means");
    ASSERT_EQ (status, 200);
    const auto& breakdown = body.at ("timingBreakdown");
    EXPECT_DOUBLE_EQ (breakdown.at ("avgDnsMs").get<double> (), 0.05);
    EXPECT_DOUBLE_EQ (breakdown.at ("avgConnectMs").get<double> (), 0.25);
    EXPECT_DOUBLE_EQ (breakdown.at ("avgTlsMs").get<double> (), 0.75);
    EXPECT_DOUBLE_EQ (breakdown.at ("avgFirstByteMs").get<double> (), 2.5);
    EXPECT_DOUBLE_EQ (breakdown.at ("avgDownloadMs").get<double> (), 0.125);
    EXPECT_DOUBLE_EQ (
    breakdown.at ("phases").at ("connect").at ("mean").get<double> (), 0.25);
}

// The fallback: a summary whose phases carry no mean (stored before #2782, or
// with one phase's mean missing) keeps the trace sample's averages, all five
// from one population rather than a mix.
TEST_F (RunsRouteTest, ReportAveragesFallBackToTheTraceSampleWithoutEveryPhaseMean) {
    seed ({ .id = "run_no_means", .start_time = 1000 });
    seed_traced_result ("run_no_means", 200, 10.0, std::string (TIMED_TRACE));
    seed ({ .id = "run_partial_means", .start_time = 1000 });
    seed_traced_result ("run_partial_means", 200, 10.0, std::string (TIMED_TRACE));

    auto inputs   = summary_inputs ();
    inputs.phases = counted_phases ();
    db_->update_run_summary (
    "run_no_means", vayu::core::build_run_summary_payload (inputs).dump ());
    inputs.phase_means = std::to_array<double> ({ 0.05, 0.25, 0.75, 2.5, 0.125 });
    auto partial = vayu::core::build_run_summary_payload (inputs);
    partial["phases"]["download"].erase ("mean");
    db_->update_run_summary ("run_partial_means", partial.dump ());

    for (const auto* run_id : { "run_no_means", "run_partial_means" }) {
        auto [status, body] = vayu::http::routes::run_report_response (*db_, run_id);
        ASSERT_EQ (status, 200);
        const auto& breakdown = body.at ("timingBreakdown");
        EXPECT_DOUBLE_EQ (breakdown.at ("avgDnsMs").get<double> (), 1.0) << run_id;
        EXPECT_DOUBLE_EQ (breakdown.at ("avgConnectMs").get<double> (), 2.0) << run_id;
        EXPECT_DOUBLE_EQ (breakdown.at ("avgDownloadMs").get<double> (), 5.0) << run_id;
    }
}

// ---------------------------------------------------------------------------
// The absent-not-zeros rule, one case per report section
// ---------------------------------------------------------------------------

// Every optional section of the report is left out when the run has nothing to
// say, rather than reported as zeros, an empty object or an empty array - a
// zero is a claim ("this run dropped nothing", "no test failed", "every phase
// was instant"), and an absent section is the only way to say "not measured".
// Each case stores `summary_inputs ()` shaped one way and names the key that
// must be missing from the report, under `parent` when it is nested.
struct ReportOmitsCase {
    const char* name;
    /// How this run's inputs differ from `summary_inputs ()`; nullptr for none.
    void (*shape_inputs) (vayu::core::RunSummaryInputs&);
    /// An edit to the stored summary JSON after it is built, for a shape
    /// `build_run_summary_payload` never writes itself (an older engine's
    /// summary, a partial writer); nullptr for none.
    void (*shape_summary) (nlohmann::json&);
    /// The section `absent` is looked for in, asserted present; nullptr for the
    /// top level of the report.
    const char* parent;
    const char* absent;
    /// A key of `parent` that must still be there, so the case proves one key
    /// went missing rather than the whole section; nullptr for none.
    const char* sibling;
    /// Seed one sampled result carrying phase timings, which is what makes the
    /// `timingBreakdown` averages half (and so the object itself) present.
    bool seed_timed_result;
};

constexpr auto REPORT_OMITS_CASES = std::to_array<ReportOmitsCase> ({
// A run recorded before retention was reported has no section - which is not
// the same claim as "this run dropped nothing".
{ "ReportOmitsSamplingWhenTheSummaryPredatesIt", nullptr,
[] (nlohmann::json& summary) { summary.erase ("sampling"); }, nullptr, "sampling", nullptr, false },
// A run recorded between the byte budget (#1155) and its marker (#1192) had
// the budget and no record of whether it spent it. That is not the same claim
// as "it kept its uniformity", so the key is left out rather than reported
// false - and the rest of the section still reads.
{ "ReportOmitsTheBudgetMarkerWhenTheSummaryPredatesIt", nullptr,
[] (nlohmann::json& summary) {
    summary["sampling"].erase ("response_sample_budget_spent");
},
"sampling", "responseSampleBudgetSpent", "responseSamplesDropped", false },
// A run that configured no monitor reports no section, rather than a target
// that reported nothing.
{ "ReportOmitsMonitorWhenNoneWasConfigured",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.monitor = std::nullopt; },
nullptr, nullptr, "monitor", nullptr, false },
// Not a run of zero tests that all passed.
{ "ReportOmitsTestValidationWhenNoScriptRan",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.tests = std::nullopt; },
nullptr, nullptr, "testValidation", nullptr, false },
// `summary_inputs ()` records no custom metric; not an empty object.
{ "ReportOmitsCustomMetricsWhenNoneWereRecorded", nullptr, nullptr, nullptr,
"customMetrics", nullptr, false },
// The not-measured rule for coverage, in both shapes it arrives in: no
// coverage at all, and an object with no rows (an older or a partial
// writer). Neither reports a contract of zero operations.
{ "ReportOmitsCoverageForARunNotMeasuredAgainstAContract",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.coverage = std::nullopt; },
nullptr, nullptr, "coverage", nullptr, false },
{ "ReportOmitsCoverageForARunNotMeasuredAgainstAContract_Empty",
[] (vayu::core::RunSummaryInputs& inputs) {
    inputs.coverage = nlohmann::json{ { "operationsTotal", 0 },
        { "operations", nlohmann::json::array () } };
},
nullptr, nullptr, "coverage", nullptr, false },
// The same for single-request elements (#1594, #1641): no `elements` at all
// (declared none, or a scenario run, which never writes the key), and an
// empty array written straight into the stored summary - the shape
// `build_run_summary_payload` itself never writes, but the route's own guard
// must not trust that upstream discipline blindly.
{ "ReportOmitsElementsForARunThatDeclaredNoneOrRanNone",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.elements = std::nullopt; },
nullptr, nullptr, "elements", nullptr, false },
{ "ReportOmitsElementsForARunThatDeclaredNoneOrRanNone_Empty",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.elements = std::nullopt; },
[] (nlohmann::json& summary) { summary["elements"] = nlohmann::json::array (); },
nullptr, "elements", nullptr, false },
// And for sampled schema validation (#682): no block, and a block that
// checked nothing. Neither reports a contract nothing failed. Mutation-check:
// drop the `sampled > 0` condition in the route's reader and the `_Empty`
// case reddens - the report gains a block claiming a clean run.
{ "ReportOmitsSchemaValidationForARunThatCheckedNothing",
[] (vayu::core::RunSummaryInputs& inputs) {
    inputs.schema_validation = std::nullopt;
},
nullptr, nullptr, "schemaValidation", nullptr, false },
{ "ReportOmitsSchemaValidationForARunThatCheckedNothing_Empty",
[] (vayu::core::RunSummaryInputs& inputs) {
    inputs.schema_validation = nlohmann::json{ { "sampled", 0 },
        { "checked", 0 }, { "valid", 0 }, { "failed", 0 } };
},
nullptr, nullptr, "schemaValidation", nullptr, false },
// No budgets declared - and so every run recorded before budgets existed,
// which is the same stored shape.
{ "ReportOmitsThresholdValidationWhenNoBudgetWasDeclared",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.thresholds = std::nullopt; },
nullptr, nullptr, "thresholdValidation", nullptr, false },
// A run that could not refresh at all (#478), and every run recorded before
// mid-run refresh existed. "Never watching" and "watched and never needed
// to" are different answers; only the absent section can say the first.
{ "ReportOmitsAuthWhenTheRunCouldNotRefresh",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.auth = std::nullopt; },
nullptr, nullptr, "auth", nullptr, false },
// Every mode but a capacity search. A fixed-target run measured a point, and
// a knee of 0 would read as a service that collapses at no concurrency.
{ "ReportOmitsCapacityForEveryOtherMode",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.capacity = std::nullopt; },
nullptr, nullptr, "capacity", nullptr, false },
// A run that recorded no phase distribution reports no `phases` key - five
// zeroed rows would claim every phase was instant. The averages half of
// `timingBreakdown` comes from the sampled traces and is unaffected, which is
// what keeps the two independently present: the seeded timed result keeps
// the object there, so this checks `phases` inside it rather than passing
// because the whole object went missing.
{ "ReportOmitsPhasesWhenNoneWereRecorded",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.phases = std::nullopt; },
nullptr, "timingBreakdown", "phases", "avgDnsMs", true },
});

class RunsReportOmitsTest : public RunsRouteTest,
                            public ::testing::WithParamInterface<ReportOmitsCase> {};

TEST_P (RunsReportOmitsTest, LeavesTheSectionOut) {
    const auto& c = GetParam ();
    seed ({ .id = "run_omits", .start_time = 1000 });
    if (c.seed_timed_result) {
        vayu::db::Result result;
        result.run_id      = "run_omits";
        result.timestamp   = 2000;
        result.status_code = 200;
        result.status_text = "OK";
        result.latency_ms  = 10.0;
        result.trace_data =
        R"({"dnsMs":1.0,"connectMs":2.0,"tlsMs":3.0,"firstByteMs":4.0,"downloadMs":5.0})";
        db_->add_result (result);
    }

    auto inputs = summary_inputs ();
    if (c.shape_inputs != nullptr) {
        c.shape_inputs (inputs);
    }
    auto summary = vayu::core::build_run_summary_payload (inputs);
    if (c.shape_summary != nullptr) {
        c.shape_summary (summary);
    }
    db_->update_run_summary ("run_omits", summary.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_omits");
    ASSERT_EQ (status, 200);
    if (c.parent != nullptr) {
        ASSERT_TRUE (body.contains (c.parent)) << body.dump ();
    }
    const auto& section = c.parent == nullptr ? body : body.at (c.parent);
    EXPECT_FALSE (section.contains (c.absent)) << body.dump ();
    if (c.sibling != nullptr) {
        EXPECT_TRUE (section.contains (c.sibling)) << body.dump ();
    }
}

INSTANTIATE_TEST_SUITE_P (PerSection,
RunsReportOmitsTest,
::testing::ValuesIn (REPORT_OMITS_CASES),
[] (const ::testing::TestParamInfo<ReportOmitsCase>& info) {
    return std::string (info.param.name);
});

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
    EXPECT_EQ (body["summary"]["httpErrorRequests"].get<size_t> (), 1u);
    EXPECT_EQ (body["summary"]["noResponseRequests"].get<size_t> (), 0u);
}

// ============================================================================
// PUT /runs/:id/baseline (set_run_baseline_response) and the list's filter
// ============================================================================

TEST_F (RunsRouteTest, BaselinePutPinsTheRunAndAnswersTheUpdatedRow) {
    seed ({ .id = "run_a", .start_time = 100 });

    auto [status, body] = vayu::http::routes::set_run_baseline_response (
    *db_, "run_a", R"({"baseline":true})");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["id"], "run_a");
    EXPECT_TRUE (body["baseline"].get<bool> ());
    // The answer is a list row, so a client can patch its cache from it rather
    // than re-listing - the compact summary travels with it.
    EXPECT_TRUE (body.contains ("summary"));

    const auto stored_run3 = db_->get_run ("run_a");
    ASSERT_HAS_VALUE (stored_run3);
    EXPECT_TRUE (stored_run3->baseline);

    auto [unpin_status, unpin_body] = vayu::http::routes::set_run_baseline_response (
    *db_, "run_a", R"({"baseline":false})");
    ASSERT_EQ (unpin_status, 200);
    EXPECT_FALSE (unpin_body["baseline"].get<bool> ());
    const auto stored_run2 = db_->get_run ("run_a");
    ASSERT_HAS_VALUE (stored_run2);
    EXPECT_FALSE (stored_run2->baseline);
}

// The PUT answer is built by the same build_run_summary the list uses, so a
// pinned ramp-up run's row carries its ramp knobs too (issue #1935).
TEST_F (RunsRouteTest, BaselinePutRowCarriesTheRampUpKnobs) {
    seed ({ .id = "run_ramp", .config_snapshot = R"({"url":"https://a/","mode":"ramp_up","startConcurrency":2,
    "rampUpDuration":"10s","concurrency":50})" });

    auto [status, body] = vayu::http::routes::set_run_baseline_response (
    *db_, "run_ramp", R"({"baseline":true})");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["summary"]["startConcurrency"], 2);
    EXPECT_EQ (body["summary"]["rampUpDuration"], "10s");
}

TEST_F (RunsRouteTest, BaselinePutOnAMissingRunIs404) {
    auto [status, body] = vayu::http::routes::set_run_baseline_response (
    *db_, "no_such_run", R"({"baseline":true})");
    EXPECT_EQ (status, 404);
    EXPECT_EQ (body["error"]["message"], "Run not found");
}

// A body that does not carry a boolean is refused, never quietly accepted:
// this endpoint has exactly one field, so ignoring it would answer 200 to a
// request that changed nothing.
TEST_F (RunsRouteTest, BaselinePutRejectsABodyWithoutABoolean) {
    seed ({ .id = "run_a", .start_time = 100 });

    for (const char* body : { R"({"baseline":"true"})", R"({"baseline":1})",
         R"({"baseline":null})", R"({})", R"({"pinned":true})", "not json", "[]" }) {
        auto [status, response] =
        vayu::http::routes::set_run_baseline_response (*db_, "run_a", body);
        EXPECT_EQ (status, 400) << "accepted: " << body;
    }
    const auto stored_run = db_->get_run ("run_a");
    ASSERT_HAS_VALUE (stored_run);
    EXPECT_FALSE (stored_run->baseline) << "a rejected body still wrote";
}

// A body nested past what `dump ()` survives is refused before the run is
// looked up (#2671), and the same run still takes a real body afterwards.
// Mutation check: put a raw `nlohmann::json::parse` back in
// `set_run_baseline_response` and this answers the missing-`baseline` 400 with
// another message, or the binary crashes on the first copy.
TEST_F (RunsRouteTest, BaselinePutRefusesABodyNestedPastTheBound) {
    seed ({ .id = "run_a", .start_time = 100 });

    const std::string body =
    R"({"baseline":true,"extra":)" + vayu::tests::nested_array_text (100000) + "}";
    const auto [status, response] =
    vayu::http::routes::set_run_baseline_response (*db_, "run_a", body);

    EXPECT_EQ (status, 400);
    EXPECT_EQ (response["error"]["code"], "bad_request");
    EXPECT_EQ (response["error"]["message"].get<std::string> (),
    "request body is nested deeper than " +
    std::to_string (vayu::core::constants::request_body::MAX_JSON_DEPTH) + " levels");
    const auto stored_run = db_->get_run ("run_a");
    ASSERT_HAS_VALUE (stored_run);
    EXPECT_FALSE (stored_run->baseline) << "a refused body still wrote";

    const auto [ok_status, ok_body] = vayu::http::routes::set_run_baseline_response (
    *db_, "run_a", R"({"baseline":true})");
    EXPECT_EQ (ok_status, 200) << ok_body.dump ();
}

TEST_F (RunsRouteTest, ListRowsCarryTheBaselineFlag) {
    seed ({ .id = "run_a", .start_time = 100 });
    vayu::http::routes::set_run_baseline_response (*db_, "run_a", R"({"baseline":true})");

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_TRUE (body["data"][0]["baseline"].get<bool> ());
}

TEST_F (RunsRouteTest, ListFiltersToBaselinesAndBackAgain) {
    seed ({ .id = "pinned", .start_time = 300 });
    seed ({ .id = "plain", .start_time = 200 });
    vayu::http::routes::set_run_baseline_response (*db_, "pinned", R"({"baseline":true})");

    vayu::db::RunFilter only_baselines;
    only_baselines.baseline = true;
    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, only_baselines, 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "pinned");
    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 1);

    vayu::db::RunFilter no_baselines;
    no_baselines.baseline = false;
    auto [plain_status, plain_body] =
    vayu::http::routes::get_runs_response (*db_, no_baselines, 50, 0, summaries_);
    ASSERT_EQ (plain_status, 200);
    ASSERT_EQ (plain_body["data"].size (), 1u);
    EXPECT_EQ (plain_body["data"][0]["id"], "plain");
}

// The single-run payload answers it too, so a client that opened a run
// directly can draw its pin without listing.
TEST_F (RunsRouteTest, SingleRunPayloadCarriesTheBaselineFlag) {
    seed ({ .id = "run_a", .start_time = 100 });
    vayu::http::routes::set_run_baseline_response (*db_, "run_a", R"({"baseline":true})");

    auto run = db_->get_run ("run_a");
    ASSERT_HAS_VALUE (run);
    EXPECT_TRUE (vayu::json::serialize (*run)["baseline"].get<bool> ());
}

// ============================================================================
// DELETE /runs (clear_runs_response, #2429)
// ============================================================================

// "Clear run history" keeps pinned baselines and runs still in flight, and
// says what it did: how many went, which ones, and how many pins it kept.
TEST_F (RunsRouteTest, ClearRunsKeepsPinnedAndInFlightRunsAndReportsWhatWent) {
    seed ({ .id = "load_done", .start_time = 100 });
    seed ({ .id = "send_done", .type = vayu::RunType::Design, .start_time = 200 });
    seed ({ .id = "pinned_load", .start_time = 300 });
    seed ({ .id = "pinned_send", .type = vayu::RunType::Design, .start_time = 400 });
    seed ({ .id = "running", .status = vayu::RunStatus::Running, .start_time = 500 });
    seed ({ .id = "pending", .status = vayu::RunStatus::Pending, .start_time = 600 });
    ASSERT_HAS_VALUE (db_->set_run_baseline ("pinned_load", true));
    ASSERT_HAS_VALUE (db_->set_run_baseline ("pinned_send", true));

    auto [status, body] = vayu::http::routes::clear_runs_response (*db_);

    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["deleted"].get<int64_t> (), 2);
    EXPECT_EQ (body["keptPinned"].get<int64_t> (), 2);
    ASSERT_TRUE (body["deletedIds"].is_array ());
    auto deleted_ids = body["deletedIds"].get<std::vector<std::string>> ();
    std::ranges::sort (deleted_ids);
    EXPECT_EQ (deleted_ids, (std::vector<std::string>{ "load_done", "send_done" }));

    for (const char* kept : { "pinned_load", "pinned_send", "running", "pending" }) {
        EXPECT_TRUE (db_->get_run (kept).has_value ()) << "the clear deleted " << kept;
    }
    EXPECT_FALSE (db_->get_run ("load_done").has_value ());
    EXPECT_FALSE (db_->get_run ("send_done").has_value ());
}

TEST_F (RunsRouteTest, ClearRunsOnAnEmptyHistoryAnswersZero) {
    auto [status, body] = vayu::http::routes::clear_runs_response (*db_);

    ASSERT_EQ (status, 200);
    EXPECT_EQ (body,
    (json{ { "deleted", 0 }, { "keptPinned", 0 }, { "deletedIds", json::array () } }));
}

// ============================================================================
// origin (#1817): who started the run
// ============================================================================

TEST_F (RunsRouteTest, ListRowsAndTheSingleRunPayloadCarryTheOrigin) {
    seed ({ .id = "agent", .start_time = 200, .origin = "mcp", .origin_client = "Claude Code" });
    seed ({ .id = "plain", .start_time = 100 });

    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 2u);
    EXPECT_EQ (body["data"][0]["origin"],
    (json{ { "kind", "mcp" }, { "client", "Claude Code" } }));
    EXPECT_EQ (body["data"][1]["origin"],
    (json{ { "kind", "other" }, { "client", nullptr } }));

    const auto agent = db_->get_run ("agent");
    ASSERT_HAS_VALUE (agent);
    EXPECT_EQ (vayu::json::serialize (*agent)["origin"],
    (json{ { "kind", "mcp" }, { "client", "Claude Code" } }));
    const auto plain = db_->get_run ("plain");
    ASSERT_HAS_VALUE (plain);
    EXPECT_EQ (vayu::json::serialize (*plain)["origin"],
    (json{ { "kind", "other" }, { "client", nullptr } }));
}

// The baseline PUT answers a list row, so the origin travels with it too.
TEST_F (RunsRouteTest, BaselinePutAnswersTheRowWithItsOrigin) {
    seed ({ .id = "agent", .start_time = 100, .origin = "mcp", .origin_client = "cursor" });

    auto [status, body] = vayu::http::routes::set_run_baseline_response (
    *db_, "agent", R"({"baseline":true})");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["origin"], (json{ { "kind", "mcp" }, { "client", "cursor" } }));
    // The pin is a whole-row write; it must not lose the columns it did not set.
    const auto stored = db_->get_run ("agent");
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->origin, "mcp");
    ASSERT_HAS_VALUE (stored->origin_client);
    EXPECT_EQ (*stored->origin_client, "cursor");
}

TEST_F (RunsRouteTest, FilterByOriginListsOnlyThatKindAndCountsAgree) {
    seed ({ .id = "mcp_new", .start_time = 400, .origin = "mcp", .origin_client = "cursor" });
    seed ({ .id = "app_run", .start_time = 300, .origin = "app" });
    seed ({ .id = "mcp_old", .start_time = 200, .origin = "mcp" });
    seed ({ .id = "other_run", .start_time = 100 });

    vayu::db::RunFilter agents;
    agents.origin = "mcp";
    auto [status, body] =
    vayu::http::routes::get_runs_response (*db_, agents, 1, 0, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "mcp_new");
    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 2);
    EXPECT_TRUE (body["pagination"]["hasMore"].get<bool> ());

    auto [next_status, next] =
    vayu::http::routes::get_runs_response (*db_, agents, 1, 1, summaries_);
    ASSERT_EQ (next_status, 200);
    ASSERT_EQ (next["data"].size (), 1u);
    EXPECT_EQ (next["data"][0]["id"], "mcp_old");
    EXPECT_FALSE (next["pagination"]["hasMore"].get<bool> ());
    EXPECT_EQ (db_->count_runs (agents), 2);

    vayu::db::RunFilter others;
    others.origin         = "other";
    const auto other_rows = db_->get_runs_paginated (others, 50, 0);
    ASSERT_EQ (other_rows.size (), 1u);
    EXPECT_EQ (other_rows[0].id, "other_run");
}

// Same convention as `type`, `status` and `baseline`: a value the route does
// not know leaves the filter unset - a wider list, never a 400.
TEST (RunFilterFromQuery, OriginIsReadOnlyForADeclaredKind) {
    for (const auto kind : vayu::http::routes::RUN_ORIGIN_KINDS) {
        httplib::Request req;
        req.params.emplace ("origin", std::string (kind));
        const auto filter = vayu::http::routes::run_filter_from_query (req);
        ASSERT_HAS_VALUE (filter.origin) << kind;
        EXPECT_EQ (*filter.origin, kind);
    }
    for (const char* unknown : { "browser", "MCP", "" }) {
        httplib::Request req;
        req.params.emplace ("origin", unknown);
        EXPECT_FALSE (vayu::http::routes::run_filter_from_query (req).origin.has_value ())
        << "'" << unknown << "'";
    }
    EXPECT_FALSE (
    vayu::http::routes::run_filter_from_query (httplib::Request{}).origin.has_value ());
}

} // namespace