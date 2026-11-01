/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * What the deferred replay stores about a failing assertion (#3127).
 *
 * A script that fails on every sampled response fails with the same text each
 * time, so the validation row once held that text once per sample and the cap
 * of ten was spent on one assertion. The row now holds each distinct message
 * once, with how often it failed. These tests drive `validate_scripts` against
 * a real database and read the stored row back, because the row is the
 * contract the report and the app read.
 */

#include <gtest/gtest.h>

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

using json = nlohmann::json;

namespace {

constexpr const char* RUN_ID = "run-failure-dedup";

constexpr size_t CAP = vayu::core::constants::script_validation::MAX_FAILURE_MESSAGES;

vayu::Response response_with (const std::string& body) {
    vayu::Response response;
    response.status_code     = 200;
    response.status_text     = "OK";
    response.body            = body;
    response.timing.total_ms = 1.0;
    return response;
}

/// Fails on every response with the same text.
constexpr const char* ALWAYS_FAILS =
"pm.test('status is 201', function () { "
"pm.expect(pm.response.code).to.eql(201); });";

/// Fails with a text that names the response's own `n`, so each distinct `n`
/// is a distinct message.
constexpr const char* FAILS_NAMING_THE_BODY =
"pm.test('row ' + pm.response.json().n, function () { pm.expect(1).to.eql(2); "
"});";

class LoadFailureDedupTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_load_failure_dedup.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }

    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    static std::shared_ptr<vayu::core::RunContext> single_request_run (
    const std::string& script) {
        const json cfg = { { "response_sample_rate", 1 }, { "max_response_samples", 100 } };
        auto context = std::make_shared<vayu::core::RunContext> (RUN_ID, cfg);
        context->test_scripts = { script };
        return context;
    }

    /// A scenario load run whose steps all carry @p script, named "step A",
    /// "step B", ... so a failure's prefix says which one it came from.
    static std::shared_ptr<vayu::core::RunContext>
    scenario_run (const std::string& script, size_t step_count) {
        const json cfg = { { "response_sample_rate", 1 }, { "max_response_samples", 100 } };
        auto context = std::make_shared<vayu::core::RunContext> (RUN_ID, cfg);

        auto execution = std::make_shared<vayu::core::ScenarioExecution> ();
        execution->request.source     = "collection";
        execution->request.iterations = 1;
        for (size_t i = 0; i < step_count; ++i) {
            vayu::core::ScenarioStep step;
            step.index = i;
            step.name  = std::string ("step ") + static_cast<char> ('A' + i);
            step.elements = vayu::tests::step_elements_with_post_script (script);
            step.request.method = vayu::HttpMethod::GET;
            step.request.url    = "https://api.example.com/users";
            execution->plan.steps.push_back (step);
        }
        context->scenario = execution;
        context->metrics_collector->configure_step_samples (
        std::vector<bool> (step_count, true));
        return context;
    }

    static void sample_single (const std::shared_ptr<vayu::core::RunContext>& context,
    const std::string& body = "{}") {
        context->metrics_collector->record_response_sample (response_with (body));
    }

    static void sample_step (const std::shared_ptr<vayu::core::RunContext>& context,
    size_t step) {
        context->metrics_collector->record_step_response_sample (response_with ("{}"), step,
        vayu::core::SampleIdentity{
        /*iteration=*/0, /*vu=*/1, /*data_row_index=*/std::nullopt });
    }

    /// The `trace_data` of the one row `store_validation_failures` writes.
    json stored_row () {
        for (const auto& result : db_->get_results (RUN_ID)) {
            auto trace =
            json::parse (result.trace_data, nullptr, /*allow_exceptions=*/false);
            if (!trace.is_discarded () && trace.contains ("failures")) {
                return trace;
            }
        }
        ADD_FAILURE () << "no validation row was stored";
        return json::object ();
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// One response failing the same way on three samples is one failure that
// happened three times, not three failures. Mutation check: make
// `ReplayFailures::record` push every message (drop the `first_seen` test) and
// `failures` holds the text three times.
TEST_F (LoadFailureDedupTest, TheSameFailureOnThreeSamplesIsStoredOnceWithItsCount) {
    auto context = single_request_run (ALWAYS_FAILS);
    for (int i = 0; i < 3; ++i) {
        sample_single (context);
    }

    const auto validation = vayu::core::validate_scripts (context, *db_);

    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->sampled, 3u);
    const auto row = stored_row ();
    ASSERT_EQ (row["failures"].size (), 1u) << row.dump ();
    EXPECT_NE (row["failures"][0].get<std::string> ().find ("status is 201: "),
    std::string::npos);
    EXPECT_EQ (row["failureCounts"], json::array ({ 3 }));
    EXPECT_EQ (row["failuresDistinct"], 1);
    EXPECT_EQ (row["totalFailed"], 3);
    EXPECT_EQ (row["totalPassed"], 0);
}

// Two assertions that fail are two failures, each counted on every sample, and
// the passing one beside them stays in `totalPassed`.
TEST_F (LoadFailureDedupTest, TwoDistinctFailuresStayTwo) {
    auto context = single_request_run (std::string (ALWAYS_FAILS) +
    "pm.test('has no error', function () { "
    "pm.expect(pm.response.code).to.eql(200); });"
    "pm.test('is fast', function () { pm.expect(1).to.eql(2); });");
    for (int i = 0; i < 3; ++i) {
        sample_single (context);
    }

    (void)vayu::core::validate_scripts (context, *db_);

    const auto row = stored_row ();
    ASSERT_EQ (row["failures"].size (), 2u) << row.dump ();
    EXPECT_NE (row["failures"][0].get<std::string> ().find ("status is 201: "),
    std::string::npos);
    EXPECT_NE (row["failures"][1].get<std::string> ().find ("is fast: "), std::string::npos);
    EXPECT_EQ (row["failureCounts"], json::array ({ 3, 3 }));
    EXPECT_EQ (row["failuresDistinct"], 2);
    EXPECT_EQ (row["totalFailed"], 6);
    EXPECT_EQ (row["totalPassed"], 3);
}

// Past the cap a new message is counted as distinct but not kept, and a kept
// message that fails again still counts. Mutation check: stop recording once
// `kept` is full (the old `size () < MAX` guard around the whole of `record`)
// and `failuresDistinct` stays at ten and the first count at one.
TEST_F (LoadFailureDedupTest, PastTheCapDistinctMessagesAreCountedAndKeptCountsKeepRising) {
    const size_t distinct = CAP + 2;
    auto context          = single_request_run (FAILS_NAMING_THE_BODY);
    for (size_t n = 0; n < distinct; ++n) {
        sample_single (context, R"({"n":)" + std::to_string (n) + "}");
    }
    constexpr size_t REPEATS = 5;
    for (size_t i = 0; i < REPEATS; ++i) {
        sample_single (context, R"({"n":0})");
    }

    (void)vayu::core::validate_scripts (context, *db_);

    const auto row = stored_row ();
    ASSERT_EQ (row["failures"].size (), CAP) << row.dump ();
    ASSERT_EQ (row["failureCounts"].size (), CAP);
    EXPECT_NE (row["failures"][0].get<std::string> ().find ("row 0: "), std::string::npos);
    EXPECT_EQ (row["failureCounts"][0], 1 + REPEATS);
    EXPECT_EQ (row["failureCounts"][1], 1);
    EXPECT_EQ (row["failuresDistinct"], distinct);
    EXPECT_EQ (row["totalFailed"], distinct + REPEATS);
}

// The step prefix is part of a failure's identity: the same assertion failing
// in two steps is two failures, and a repeat within a step folds into its own.
TEST_F (LoadFailureDedupTest, TheSameFailureInTwoStepsIsTwoFailures) {
    auto context = scenario_run (ALWAYS_FAILS, 2);
    sample_step (context, 0);
    sample_step (context, 0);
    sample_step (context, 1);

    (void)vayu::core::validate_scripts (context, *db_);

    const auto row = stored_row ();
    ASSERT_EQ (row["failures"].size (), 2u) << row.dump ();
    EXPECT_EQ (
    row["failures"][0].get<std::string> ().rfind ("step A: status is 201: ", 0), 0u);
    EXPECT_EQ (
    row["failures"][1].get<std::string> ().rfind ("step B: status is 201: ", 0), 0u);
    EXPECT_EQ (row["failureCounts"], json::array ({ 2, 1 }));
    EXPECT_EQ (row["failuresDistinct"], 2);
    EXPECT_EQ (row["totalFailed"], 3);
}

// A run that failed nothing writes no row, so the app's "no failures" reading
// is unchanged.
TEST_F (LoadFailureDedupTest, APassingRunStoresNoRow) {
    auto context = single_request_run (
    "pm.test('ok', function () { pm.expect(pm.response.code).to.eql(200); });");
    sample_single (context);

    (void)vayu::core::validate_scripts (context, *db_);

    for (const auto& result : db_->get_results (RUN_ID)) {
        EXPECT_TRUE (result.trace_data.empty ()) << result.trace_data;
    }
}

} // namespace
