/**
 * @file tests/runs_route_test.cpp
 * @brief Tests for the paginated GET /runs list (get_runs_response) and the
 * DB-level filtering/pagination it rests on (get_runs_paginated / count_runs).
 *
 * Focus: the list must return the `{data, pagination}` envelope with compact
 * per-row `summary` objects (not the full config_snapshot), honour each filter
 * (type / status / requestId / collectionId / q), clamp limit/offset, and never
 * 500 on a malformed snapshot. The legacy no-param path (a bare array of full
 * configSnapshot rows) is preserved by vayu::json::serialize(Run), asserted
 * here too so a change to the row shape cannot silently break external scripts.
 *
 * Covers the route's extracted core in isolation, matching the suite's other
 * route tests (no in-process HTTP server).
 */

#include <gtest/gtest.h>

#include <array>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/spec_coverage.hpp"
#include "vayu/db/database.hpp"
#include "vayu/utils/diagnostics.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Defined in runs.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> get_runs_response (vayu::db::Database& db,
const vayu::db::RunFilter& filter,
int64_t limit,
int64_t offset);

// Defined in runs.cpp; builds the GET /runs/:id/report `configuration`
// object from an already-parsed config_snapshot, extracted so it is testable
// without the report handler's DB/metrics dependencies.
nlohmann::json build_run_report_config (const nlohmann::json& config);
// Defined in runs.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json>
run_report_response (vayu::db::Database& db, const std::string& run_id);
// Defined in runs.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> set_run_baseline_response (vayu::db::Database& db,
const std::string& run_id,
const std::string& body);
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
        vayu::tests::remove_database_files (DB_PATH);
    }

    struct RunSpec {
        std::string id;
        vayu::RunType type                    = vayu::RunType::Load;
        vayu::RunStatus status                = vayu::RunStatus::Completed;
        int64_t start_time                    = 0;
        std::optional<std::string> request_id = std::nullopt;
        std::string config_snapshot = R"({"url":"https://x.test/","method":"GET"})";
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

    /// One stored exchange for @p run_id. `trace_data` is deliberately large:
    /// the list must never read this column, and a row that does shows up as a
    /// payload, not as a failure.
    // The 4 KB filler concatenation below is what GCC 13 reports as reading past
    // the small-string buffer. See utils/diagnostics.hpp.
    VAYU_IGNORE_FALSE_STRING_CONCAT_BOUNDS
    void seed_result (const std::string& run_id, int status_code, double latency_ms) {
        vayu::db::Result result;
        result.run_id      = run_id;
        result.timestamp   = 1000;
        result.status_code = status_code;
        result.status_text = "OK";
        result.latency_ms  = latency_ms;
        result.trace_data = R"({"response":{"body":")" + std::string (4096, 'x') + R"("}})";
        db_->add_result (result);
    }
    VAYU_DIAGNOSTIC_POP

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

    auto [page1_status, page1] = vayu::http::routes::get_runs_response (*db_, {}, 2, 0);
    EXPECT_EQ (page1_status, 200);
    EXPECT_EQ (page1["data"].size (), 2u);
    EXPECT_EQ (page1["pagination"]["total"], 5);
    EXPECT_EQ (page1["pagination"]["hasMore"], true);
    EXPECT_EQ (page1["pagination"]["returned"], 2);

    auto [page3_status, page3] = vayu::http::routes::get_runs_response (*db_, {}, 2, 4);
    EXPECT_EQ (page3_status, 200);
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
    seed ({ .id = "run_scenario", .type = vayu::RunType::Scenario, .config_snapshot = R"({"scenario":{"source":"collection","collectionId":"col_1",
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

// A design run is one exchange, so its row says what came back. Without this a
// reader wanting a status code per row had to fetch a report per row, which
// loads and parses every result's trace_data - the cost that kept this off the
// list (#380).
TEST_F (RunsRouteTest, DesignRowCarriesItsStatusCodeAndLatency) {
    seed ({ .id = "run_design", .type = vayu::RunType::Design });
    seed_result ("run_design", 503, 42.5);

    auto [status, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0);
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

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0);
    ASSERT_EQ (body["data"].size (), 2u);
    EXPECT_EQ (body["data"][0]["id"], "run_second");
    EXPECT_EQ (body["data"][0]["resultSummary"]["statusCode"], 404);
    EXPECT_EQ (body["data"][1]["id"], "run_first");
    EXPECT_EQ (body["data"][1]["resultSummary"]["statusCode"], 200);
}

// The load-run guard, at the level that enforces it. A load run's results are
// unbounded (one row per error), so they must not be read to be discarded - and
// that is a property of the statement, not of the caller remembering to filter:
// asking for a load run's outcome by id returns nothing.
TEST_F (RunsRouteTest, LoadRowCarriesNoOutcomeAndItsResultsAreNeverRead) {
    seed ({ .id = "run_load", .type = vayu::RunType::Load });
    seed ({ .id = "run_scenario", .type = vayu::RunType::Scenario, .start_time = 1 });
    seed_result ("run_load", 500, 99.0);
    seed_result ("run_load", 500, 98.0);
    seed_result ("run_scenario", 200, 5.0);

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0);
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

    auto [_, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_FALSE (body["data"][0].contains ("resultSummary"));
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
    f.type         = vayu::RunType::Design;
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_design");
    EXPECT_EQ (body["pagination"]["total"], 1);
}

TEST_F (RunsRouteTest, FilterByStatus) {
    seed ({ .id = "run_done", .status = vayu::RunStatus::Completed });
    seed ({ .id = "run_fail", .status = vayu::RunStatus::Failed, .start_time = 1 });

    vayu::db::RunFilter f;
    f.status       = vayu::RunStatus::Failed;
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_fail");
}

TEST_F (RunsRouteTest, FilterByRequestId) {
    seed ({ .id = "run_1", .request_id = "req_A" });
    seed ({ .id = "run_2", .start_time = 1, .request_id = "req_B" });
    seed ({ .id = "run_3", .start_time = 2, .request_id = std::nullopt });

    vayu::db::RunFilter f;
    f.request_id   = "req_A";
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "run_1");
    EXPECT_EQ (body["data"][0]["requestId"], "req_A");
}

TEST_F (RunsRouteTest, FilterByQSubstringOverSnapshot) {
    seed ({ .id = "run_users", .config_snapshot = R"({"url":"https://api/users"})" });
    seed ({ .id = "run_orders", .start_time = 1, .config_snapshot = R"({"url":"https://api/orders"})" });

    vayu::db::RunFilter f;
    f.q            = "orders";
    auto [_, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
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
    auto [status, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
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
    auto [_, body]  = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
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
    auto [status, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
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
    auto [status, body] = vayu::http::routes::get_runs_response (*db_, f, 50, 0);
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
    auto [_, body]  = vayu::http::routes::get_runs_response (*db_, f, 1, 0);
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
    auto [_, body]  = vayu::http::routes::get_runs_response (*db_, f, 1, 0);
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
    f.type         = vayu::RunType::Design;
    f.status       = vayu::RunStatus::Completed;
    f.request_id   = "req_X";
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
    inputs.total_requests          = 100;
    inputs.rps                     = 50.0;
    inputs.send_rate               = 51.0;
    inputs.throughput              = 49.5;
    inputs.test_duration_s         = 2.0;
    inputs.setup_overhead_s        = 0.25;
    inputs.peak_concurrency        = 8;
    inputs.dropped_requests        = 2;
    inputs.queue_wait_avg_ms       = 1.5;
    inputs.bytes_sent              = 1024;
    inputs.bytes_received          = 8192;
    inputs.status_codes            = { { 200, 90 }, { 500, 7 }, { 0, 3 } };
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

// The absence twin: a run that configured no monitor reports no section, rather
// than a target that reported nothing.
TEST_F (RunsRouteTest, ReportOmitsMonitorWhenNoneWasConfigured) {
    seed ({ .id = "run_no_monitor", .start_time = 1000 });
    auto inputs    = summary_inputs ();
    inputs.monitor = std::nullopt;
    db_->update_run_summary (
    "run_no_monitor", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_no_monitor");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("monitor"));
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
    EXPECT_EQ (verdict["checks"][1]["metric"].get<std::string> (), "maxErrorRatePct");
    EXPECT_FALSE (verdict["checks"][1]["passed"].get<bool> ());

    // The one assertion that pins the two sides together.
    EXPECT_DOUBLE_EQ (verdict["checks"][1]["actual"].get<double> (),
    body["summary"]["errorRate"].get<double> ());
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

// The not-measured rule, in both shapes it arrives in: a run whose summary
// carries no coverage at all, and one carrying an object with no rows (an older
// or a partial writer). Neither reports a contract of zero operations.
TEST_F (RunsRouteTest, ReportOmitsCoverageForARunNotMeasuredAgainstAContract) {
    seed ({ .id = "run_no_coverage", .start_time = 1000 });
    auto inputs     = summary_inputs ();
    inputs.coverage = std::nullopt;
    db_->update_run_summary (
    "run_no_coverage", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_no_coverage");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("coverage")) << body.dump ();

    seed ({ .id = "run_empty_coverage", .start_time = 1000 });
    auto empty     = summary_inputs ();
    empty.coverage = nlohmann::json{ { "operationsTotal", 0 },
        { "operations", nlohmann::json::array () } };
    db_->update_run_summary (
    "run_empty_coverage", vayu::core::build_run_summary_payload (empty).dump ());

    auto [empty_status, empty_body] =
    vayu::http::routes::run_report_response (*db_, "run_empty_coverage");
    ASSERT_EQ (empty_status, 200);
    EXPECT_FALSE (empty_body.contains ("coverage")) << empty_body.dump ();
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

// The absent-not-zeros gate, in both shapes it arrives in: a run whose summary
// carries no block, and one carrying an object that checked nothing. Neither
// reports a contract nothing failed.
//
// Mutation-check: drop the `sampled > 0` condition in the route's reader and
// the second half reddens - the report gains a block claiming a clean run.
TEST_F (RunsRouteTest, ReportOmitsSchemaValidationForARunThatCheckedNothing) {
    seed ({ .id = "run_no_schema", .start_time = 1000 });
    auto inputs              = summary_inputs ();
    inputs.schema_validation = std::nullopt;
    db_->update_run_summary (
    "run_no_schema", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_no_schema");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("schemaValidation")) << body.dump ();

    seed ({ .id = "run_empty_schema", .start_time = 1000 });
    auto empty              = summary_inputs ();
    empty.schema_validation = nlohmann::json{ { "sampled", 0 },
        { "checked", 0 }, { "valid", 0 }, { "failed", 0 } };
    db_->update_run_summary (
    "run_empty_schema", vayu::core::build_run_summary_payload (empty).dump ());

    auto [empty_status, empty_body] =
    vayu::http::routes::run_report_response (*db_, "run_empty_schema");
    ASSERT_EQ (empty_status, 200);
    EXPECT_FALSE (empty_body.contains ("schemaValidation")) << empty_body.dump ();
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

// A run that declared no budgets keeps the section out entirely - and so does
// every run recorded before budgets existed, which is the same stored shape.
TEST_F (RunsRouteTest, ReportOmitsThresholdValidationWhenNoBudgetWasDeclared) {
    seed ({ .id = "run_no_budgets", .start_time = 1000 });
    auto inputs       = summary_inputs ();
    inputs.thresholds = std::nullopt;
    db_->update_run_summary (
    "run_no_budgets", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_no_budgets");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("thresholdValidation"));
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

// A run that could not refresh at all keeps the section out entirely - and so
// does every run recorded before mid-run refresh existed. "Never watching" and
// "watched and never needed to" are different answers; only the absent section
// can say the first.
TEST_F (RunsRouteTest, ReportOmitsAuthWhenTheRunCouldNotRefresh) {
    seed ({ .id = "run_no_auth_section", .start_time = 1000 });
    auto inputs = summary_inputs ();
    inputs.auth = std::nullopt;
    db_->update_run_summary ("run_no_auth_section",
    vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_no_auth_section");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("auth"));
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
    const std::vector<vayu::core::CapacityWindow> levels{ { 8, 900.0, 12.0 },
        { 16, 1700.0, 20.0 }, { 32, 1750.0, 180.0 }, { 32, 1720.0, 210.0 } };
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

    ASSERT_EQ (capacity["levels"].size (), 4u);
    EXPECT_EQ (capacity["levels"][0]["concurrency"].get<size_t> (), 8u);
    EXPECT_DOUBLE_EQ (capacity["levels"][0]["rps"].get<double> (), 900.0);
    EXPECT_DOUBLE_EQ (capacity["levels"][0]["p99Ms"].get<double> (), 12.0);
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
}

// Every other mode. The section is absent, not zeroed - a fixed-target run
// measured a point, and a knee of 0 would read as a service that collapses at
// no concurrency at all.
TEST_F (RunsRouteTest, ReportOmitsCapacityForEveryOtherMode) {
    seed ({ .id = "run_not_capacity", .start_time = 1000 });
    auto inputs     = summary_inputs ();
    inputs.capacity = std::nullopt;
    db_->update_run_summary (
    "run_not_capacity", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_not_capacity");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body.contains ("capacity"));
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

// The absence twin. A run that recorded no distribution reports no `phases`
// key - five zeroed rows would claim every phase was instant. The averages
// half is unaffected, which is what keeps the two independently present.
TEST_F (RunsRouteTest, ReportOmitsPhasesWhenNoneWereRecorded) {
    seed ({ .id = "run_no_phases", .start_time = 1000 });
    auto inputs   = summary_inputs ();
    inputs.phases = std::nullopt;
    db_->update_run_summary (
    "run_no_phases", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_no_phases");
    ASSERT_EQ (status, 200);
    if (body.contains ("timingBreakdown")) {
        EXPECT_FALSE (body["timingBreakdown"].contains ("phases"));
    }
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

    EXPECT_TRUE (db_->get_run ("run_a")->baseline);

    auto [unpin_status, unpin_body] = vayu::http::routes::set_run_baseline_response (
    *db_, "run_a", R"({"baseline":false})");
    ASSERT_EQ (unpin_status, 200);
    EXPECT_FALSE (unpin_body["baseline"].get<bool> ());
    EXPECT_FALSE (db_->get_run ("run_a")->baseline);
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
    EXPECT_FALSE (db_->get_run ("run_a")->baseline)
    << "a rejected body still wrote";
}

TEST_F (RunsRouteTest, ListRowsCarryTheBaselineFlag) {
    seed ({ .id = "run_a", .start_time = 100 });
    vayu::http::routes::set_run_baseline_response (*db_, "run_a", R"({"baseline":true})");

    auto [status, body] = vayu::http::routes::get_runs_response (*db_, {}, 50, 0);
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
    vayu::http::routes::get_runs_response (*db_, only_baselines, 50, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "pinned");
    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 1);

    vayu::db::RunFilter no_baselines;
    no_baselines.baseline = false;
    auto [plain_status, plain_body] =
    vayu::http::routes::get_runs_response (*db_, no_baselines, 50, 0);
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
    ASSERT_TRUE (run.has_value ());
    EXPECT_TRUE (vayu::json::serialize (*run)["baseline"].get<bool> ());
}

} // namespace