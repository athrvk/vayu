/**
 * @file tests/runs_route_write_test.cpp
 * @brief The mutating runs routes: PUT /runs/:id/baseline and DELETE /runs.
 *
 * Covers the route's extracted core in isolation, matching the suite's other route tests (no
 * in-process HTTP server). The `RunsRouteTest` fixture is in `runs_route_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "nested_json.hpp"
#include "optional_assert.hpp"
#include "runs_route_fixture.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace {

using vayu::tests::scenario_snapshot;

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

// A collection's baseline is the newest pinned *load* run over it (#3544): a
// load run driven over a collection stores `scenario.collectionId` in its
// snapshot, so the same three filters a request's baseline lookup ANDs also
// scope to a collection. Each decoy is newer than the answer, so dropping the
// term that excludes it puts it first: the collection's own sequential run (the
// type term), another collection's pin (the collection term) and an unpinned
// load run (the baseline term).
TEST_F (RunsRouteTest, CollectionBaselineLookupFindsTheNewestPinnedLoadRunOverIt) {
    seed ({ .id = "load_old", .start_time = 100, .config_snapshot = scenario_snapshot ("col_A") });
    seed ({ .id = "load_new", .start_time = 300, .config_snapshot = scenario_snapshot ("col_A") });
    seed ({ .id      = "sequential_same_collection",
    .type            = vayu::RunType::Scenario,
    .start_time      = 400,
    .config_snapshot = scenario_snapshot ("col_A") });
    seed ({ .id      = "load_other_collection",
    .start_time      = 500,
    .config_snapshot = scenario_snapshot ("col_B") });
    seed ({ .id = "load_unpinned", .start_time = 600, .config_snapshot = scenario_snapshot ("col_A") });
    for (const char* pinned : { "load_old", "load_new",
         "sequential_same_collection", "load_other_collection" }) {
        const auto [pin_status, pin_body] =
        vayu::http::routes::set_run_baseline_response (*db_, pinned, R"({"baseline":true})");
        ASSERT_EQ (pin_status, 200) << pin_body.dump ();
    }

    vayu::db::RunFilter f;
    f.collection_id = "col_A";
    f.type          = vayu::RunType::Load;
    f.baseline      = true;
    auto [status, body] = vayu::http::routes::get_runs_response (*db_, f, 1, 0, summaries_);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_EQ (body["data"][0]["id"], "load_new");
    EXPECT_EQ (body["data"][0]["type"], "load");
    EXPECT_EQ (body["pagination"]["total"].get<int64_t> (), 2);
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

} // namespace
