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
 *
 * The `RunsRouteTest` fixture is in `runs_route_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <array>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "runs_route_fixture.hpp"
#include "sqlite_auto_extension.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"

using nlohmann::json;

namespace {

using vayu::tests::DATA_FILE_HASH;
using vayu::tests::scenario_snapshot;

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

// #2953: `seed` stores end_time = start_time + 1 for every row, the shape a live
// run has in the database (the engine seeds end_time at start, for a crash). A
// list row reports it only once the run is terminal; before that it is null, so
// a client cannot read a zero-length run off a running one.
// Mutation check: have `serialize_run_end_time` return the raw end_time and the
// pending and running rows fail.
TEST_F (RunsRouteTest, ListRowEndTimeIsNullUntilTheRunIsTerminal) {
    seed ({ .id = "run_pending", .status = vayu::RunStatus::Pending, .start_time = 100 });
    seed ({ .id = "run_running", .status = vayu::RunStatus::Running, .start_time = 200 });
    seed ({ .id = "run_done", .status = vayu::RunStatus::Completed, .start_time = 300 });

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0, summaries_);
    ASSERT_EQ (body["data"].size (), 3u);
    std::map<std::string, nlohmann::json> end_time_by_id;
    for (const auto& row : body["data"]) {
        end_time_by_id[row["id"].get<std::string> ()] = row.at ("endTime");
    }
    EXPECT_TRUE (end_time_by_id.at ("run_pending").is_null ());
    EXPECT_TRUE (end_time_by_id.at ("run_running").is_null ());
    EXPECT_EQ (end_time_by_id.at ("run_done"), 301);
}

// The baseline PUT answers with the same row shape, through the same helper.
TEST_F (RunsRouteTest, BaselineRowEndTimeIsNullWhileTheRunIsRunning) {
    seed ({ .id = "run_live", .status = vayu::RunStatus::Running, .start_time = 100 });
    seed ({ .id = "run_done", .status = vayu::RunStatus::Completed, .start_time = 200 });

    auto [live_status, live] = vayu::http::routes::set_run_baseline_response (
    *db_, "run_live", R"({"baseline":true})");
    ASSERT_EQ (live_status, 200);
    EXPECT_TRUE (live["endTime"].is_null ());

    auto [done_status, done] = vayu::http::routes::set_run_baseline_response (
    *db_, "run_done", R"({"baseline":true})");
    ASSERT_EQ (done_status, 200);
    EXPECT_EQ (done["endTime"], 201);
}

// The report's metadata is a second reader of the same column (GET
// /runs/:id/report), so it nulls a live run's endTime too.
TEST_F (RunsRouteTest, ReportMetadataEndTimeIsNullUntilTheRunIsTerminal) {
    vayu::db::Run run;
    run.id              = "run_meta";
    run.start_time      = 100;
    run.end_time        = 100;
    run.config_snapshot = R"({"url":"https://x.test/","method":"GET"})";

    for (const auto status : { vayu::RunStatus::Pending, vayu::RunStatus::Running }) {
        run.status = status;
        SCOPED_TRACE (vayu::to_string (status));
        const auto live = vayu::http::routes::build_report_metadata ("run_meta", run);
        EXPECT_TRUE (live.at ("endTime").is_null ());
        EXPECT_EQ (live.at ("startTime"), 100);
    }

    run.status   = vayu::RunStatus::Completed;
    run.end_time = 4100;
    const auto done = vayu::http::routes::build_report_metadata ("run_meta", run);
    EXPECT_EQ (done.at ("endTime"), 4100);
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
    db_->transition_run_status (
    "run_finishing", { vayu::RunStatus::Running }, vayu::RunStatus::Completed);

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
    const vayu::tests::ScopedAutoExtension counters (&install_snapshot_predicate_counters);
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

// ==================== Keyset cursor (#2978) ====================

// How many rows a statement's WHERE examined, read through `like`: with `q`
// set, the run filter calls it once per row it looks at. This stand-in answers
// "match", so every row passes and the count is the rows the read stepped over
// plus the rows it returned.
int& like_calls () {
    static int calls = 0;
    return calls;
}

void count_matching_like (sqlite3_context* context, int /*argc*/, sqlite3_value** /*argv*/) {
    ++like_calls ();
    sqlite3_result_int (context, 1);
}

int install_like_counter (sqlite3* db, char** /*error*/, const sqlite3_api_routines* /*api*/) {
    return sqlite3_create_function (
    db, "like", 2, SQLITE_UTF8, nullptr, &count_matching_like, nullptr, nullptr);
}

constexpr int DEEP_RUNS       = 2000;
constexpr int64_t DEEP_LIMIT  = 50;
constexpr int64_t LAST_OFFSET = DEEP_RUNS - DEEP_LIMIT; // page 40 of 40
constexpr const char* PAGE_40 = "50:run_50"; // the row just before page 40

std::vector<std::string> ids_of_page (const json& body) {
    std::vector<std::string> ids;
    for (const auto& row : body["data"]) {
        ids.push_back (row["id"].get<std::string> ());
    }
    return ids;
}

TEST_F (RunsRouteTest, KeysetPageFortyMatchesTheOffsetPage) {
    seed_numbered (DEEP_RUNS);

    std::optional<std::string> before;
    json page;
    for (int number = 1; number <= DEEP_RUNS / DEEP_LIMIT; ++number) {
        auto [status, body] = vayu::http::routes::get_runs_response (
        *db_, {}, DEEP_LIMIT, 0, summaries_, before);
        ASSERT_EQ (status, 200) << "page " << number;
        page             = std::move (body);
        const auto& next = page["pagination"]["nextBefore"];
        before = next.is_string () ? std::optional (next.get<std::string> ()) : std::nullopt;
    }

    auto [status, by_offset] = vayu::http::routes::get_runs_response (
    *db_, {}, DEEP_LIMIT, LAST_OFFSET, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (page["data"].size (), static_cast<size_t> (DEEP_LIMIT));
    EXPECT_EQ (page["data"], by_offset["data"]);
    EXPECT_EQ (page["data"].front ()["id"], "run_49");
    EXPECT_EQ (page["data"].back ()["id"], "run_0");

    const auto& pagination = page["pagination"];
    EXPECT_EQ (pagination["total"], DEEP_RUNS); // the whole filter, not the remainder
    EXPECT_EQ (pagination["offset"], 0);
    EXPECT_EQ (pagination["returned"], DEEP_LIMIT);
    EXPECT_EQ (pagination["hasMore"], false);
    EXPECT_TRUE (pagination["nextBefore"].is_null ());
    EXPECT_EQ (by_offset["pagination"]["hasMore"], false);
}

// What the cursor is for: a deep page reads about `limit` rows, where OFFSET
// steps over every row before the page. Healthy: the cursor page examines 51
// rows (limit, and the one more `hasMore` reads); an OFFSET read of the same
// page examines all 2,000. The bound, 2 x limit, sits between the two. Counted
// through the route core, so a core that turned the cursor back into an
// offset fails here even though its rows would be right.
TEST_F (RunsRouteTest, ADeepKeysetPageReadsAboutLimitRows) {
    seed_numbered (DEEP_RUNS);
    db_.reset ();
    const vayu::tests::ScopedAutoExtension counter (&install_like_counter);
    ASSERT_EQ (counter.registered, SQLITE_OK);
    // No `init ()`: its retention pass would prune the set to maxRunsRetained.
    db_ = std::make_unique<vayu::db::Database> (DB_PATH);

    vayu::db::RunFilter every_row;
    every_row.q = "any";
    auto& calls = like_calls ();
    calls       = 0;
    // The core counts the whole filter on every call; that scan is subtracted.
    EXPECT_EQ (db_->count_runs (every_row), DEEP_RUNS);
    const int counting = calls;
    ASSERT_EQ (counting, DEEP_RUNS)
    << "the counter is not on the storage's connection";

    calls                           = 0;
    auto [offset_status, by_offset] = vayu::http::routes::get_runs_response (
    *db_, every_row, DEEP_LIMIT, LAST_OFFSET, summaries_);
    ASSERT_EQ (offset_status, 200);
    const int offset_rows = calls - counting;

    calls                           = 0;
    auto [cursor_status, by_cursor] = vayu::http::routes::get_runs_response (
    *db_, every_row, DEEP_LIMIT, 0, summaries_, std::string (PAGE_40));
    ASSERT_EQ (cursor_status, 200);
    const int cursor_rows = calls - counting;

    ASSERT_EQ (by_cursor["data"].size (), static_cast<size_t> (DEEP_LIMIT));
    EXPECT_EQ (ids_of_page (by_cursor), ids_of_page (by_offset));
    EXPECT_GE (offset_rows, DEEP_RUNS);
    EXPECT_LE (cursor_rows, 2 * DEEP_LIMIT);
}

// Rows sharing a start_time page in id order, by offset and by cursor alike,
// one row a page so every boundary falls inside the tie. Inserted out of id
// order, so an order that fell back to the scan's would show. `tie:z` holds a
// ':' and is the last of the tie, so the cursor naming it splits on the first.
TEST_F (RunsRouteTest, TiedStartTimesPageWithoutASkipOrARepeat) {
    seed ({ .id = "run_old", .start_time = 100 });
    for (const char* id : { "tie_a", "tie_d", "tie:z", "tie_b", "tie_c" }) {
        seed ({ .id = id, .start_time = 200 });
    }
    seed ({ .id = "run_new", .start_time = 300 });
    const std::vector<std::string> expected = { "run_new", "tie_d", "tie_c",
        "tie_b", "tie_a", "tie:z", "run_old" };

    std::vector<std::string> by_offset;
    for (int64_t offset = 0; std::cmp_less (offset, expected.size ()); ++offset) {
        auto [status, body] =
        vayu::http::routes::get_runs_response (*db_, {}, 1, offset, summaries_);
        ASSERT_EQ (status, 200);
        const auto ids = ids_of_page (body);
        by_offset.insert (by_offset.end (), ids.begin (), ids.end ());
    }
    EXPECT_EQ (by_offset, expected);

    std::vector<std::string> by_cursor;
    std::vector<std::string> cursors;
    std::optional<std::string> before;
    // Bounded, so a cursor that never advances fails instead of hanging.
    for (size_t page = 0; page <= expected.size (); ++page) {
        auto [status, body] =
        vayu::http::routes::get_runs_response (*db_, {}, 1, 0, summaries_, before);
        ASSERT_EQ (status, 200);
        const auto ids = ids_of_page (body);
        by_cursor.insert (by_cursor.end (), ids.begin (), ids.end ());
        const auto& next = body["pagination"]["nextBefore"];
        if (!next.is_string ()) {
            break;
        }
        before = next.get<std::string> ();
        cursors.push_back (*before);
    }
    EXPECT_EQ (by_cursor, expected);
    ASSERT_EQ (cursors.size (), expected.size () - 1);
    EXPECT_EQ (cursors.back (), "200:tie:z");
}

TEST_F (RunsRouteTest, AMalformedCursorIsRefused) {
    seed ({ .id = "run_a", .start_time = 100 });
    for (const char* malformed : { "", "100", "run_a", ":run_a", "100:", "x100:run_a",
         "+100:run_a", " 100:run_a", "1.5:run_a", "99999999999999999999:run_a" }) {
        auto [status, body] = vayu::http::routes::get_runs_response (
        *db_, {}, 50, 0, summaries_, std::string (malformed));
        EXPECT_EQ (status, 400) << "'" << malformed << "'";
        EXPECT_EQ (body["error"]["code"], "invalid_before") << "'" << malformed << "'";
    }
}

// A cursor page starts after a row; an offset on top of it would skip rows
// relative to a position the client cannot see, so the pair is refused rather
// than one of them silently ignored. An offset of 0 is the absent one.
TEST_F (RunsRouteTest, ACursorBesideANonZeroOffsetIsRefused) {
    seed ({ .id = "run_a", .start_time = 100 });
    seed ({ .id = "run_b", .start_time = 200 });

    auto [refused, body] = vayu::http::routes::get_runs_response (
    *db_, {}, 50, 1, summaries_, std::string ("200:run_b"));
    EXPECT_EQ (refused, 400);
    EXPECT_EQ (body["error"]["code"], "before_with_offset");

    auto [status, page] = vayu::http::routes::get_runs_response (
    *db_, {}, 50, 0, summaries_, std::string ("200:run_b"));
    ASSERT_EQ (status, 200);
    EXPECT_EQ (ids_of_page (page), std::vector<std::string>{ "run_a" });
}

// The cursor is one more term on the filter's WHERE, never a replacement for
// it: each page keeps the filter, and `total` counts the whole filter on every
// page rather than what is left after the cursor.
TEST_F (RunsRouteTest, ACursorComposesWithTheFilters) {
    for (int i = 1; i <= 6; ++i) {
        const bool load = i % 2 == 1;
        seed ({ .id = (load ? "load_" : "design_") + std::to_string (i),
        .type       = load ? vayu::RunType::Load : vayu::RunType::Design,
        .start_time = i });
    }
    vayu::db::RunFilter loads;
    loads.type = vayu::RunType::Load;

    auto [first_status, first] =
    vayu::http::routes::get_runs_response (*db_, loads, 2, 0, summaries_);
    ASSERT_EQ (first_status, 200);
    EXPECT_EQ (ids_of_page (first), (std::vector<std::string>{ "load_5", "load_3" }));
    EXPECT_EQ (first["pagination"]["total"], 3);
    EXPECT_EQ (first["pagination"]["hasMore"], true);
    ASSERT_EQ (first["pagination"]["nextBefore"], "3:load_3");

    auto [second_status, second] = vayu::http::routes::get_runs_response (*db_,
    loads, 2, 0, summaries_, first["pagination"]["nextBefore"].get<std::string> ());
    ASSERT_EQ (second_status, 200);
    EXPECT_EQ (ids_of_page (second), std::vector<std::string>{ "load_1" });
    EXPECT_EQ (second["pagination"]["total"], 3);
    EXPECT_EQ (second["pagination"]["returned"], 1);
    EXPECT_EQ (second["pagination"]["hasMore"], false);
    EXPECT_TRUE (second["pagination"]["nextBefore"].is_null ());
}

} // namespace
