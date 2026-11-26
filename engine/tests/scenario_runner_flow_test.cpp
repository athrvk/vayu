/**
 * @file tests/scenario_runner_flow_test.cpp
 * @brief Design-mode sequential runner: `setNextRequest` jumps and the step budget, step
 * outcomes, the summary payload, the schema gate and the budgets a run is judged on.
 *
 * The `ScenarioRunnerTest` fixture and its mock server are in `scenario_runner_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/scenario_runner.hpp"

#include "scenario_runner_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::core::StepOutcome;
using vayu::tests::scenario_runner::ScenarioRunnerTest;

// ============================================================================
// The summary payload
// ============================================================================

// ============================================================================
// Flow control (issue #355)
// ============================================================================
//
// The bar #303 set: a returned instruction must demonstrably change the
// executed sequence, so these assert what the server saw and what the run
// stored - never the `ScriptResult` field on its own.

TEST_F (ScenarioRunnerTest, SetNextRequestChangesTheExecutedSequence) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(pm.execution.setNextRequest("Checkout");)");
    seed_request ("req_b", 1, "/login");
    seed_request ("req_c", 2, "/observe", "", "", "", "Checkout");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    // Two sends, not three: step 2 was jumped over, and the jump target ran.
    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/observe");

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_EQ (json::parse (rows[0].trace_data)["requestId"].get<std::string> (), "req_a");
    EXPECT_EQ (json::parse (rows[1].trace_data)["requestId"].get<std::string> (), "req_c");
    EXPECT_EQ (json::parse (rows[1].trace_data)["stepIndex"].get<size_t> (), 2u);
}

// Postman's legacy spelling is an alias of the same call (#2577), so it steers
// the run the same way.
TEST_F (ScenarioRunnerTest, LegacyPostmanSetNextRequestChangesTheExecutedSequence) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(postman.setNextRequest("Checkout");)");
    seed_request ("req_b", 1, "/login");
    seed_request ("req_c", 2, "/observe", "", "", "", "Checkout");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/observe");
}

// The opening test script of a collection written before pm.* (#2577): a
// legacy assertion, then a legacy setter the next step reads. Every line used
// to throw at the first, so the step errored and the variable never reached
// step 1. Mutation check: drop the `tests` binding in pm_legacy.cpp and the
// step errors with the marker unset.
TEST_F (ScenarioRunnerTest, ALegacyTestScriptPassesAndItsVariableReachesTheNextStep) {
    seed_collection ("col_1");
    seed_environment ("env_1", "[]");
    seed_request ("req_a", 0, "/ok", "", R"(
        tests["Status code is 200"] = responseCode.code === 200;
        var jsonData = JSON.parse(responseBody);
        postman.setEnvironmentVariable("token", "from-legacy");
    )");
    seed_request ("req_b", 1, "/observe",
    R"(pm.request.headers.add({key: "X-Marker", value: pm.environment.get("token")});)");

    const auto run_id = start (/*iterations=*/1, "env_1");
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[1].marker, "from-legacy");

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    const auto first = json::parse (rows[0].trace_data);
    EXPECT_EQ (first["outcome"].get<std::string> (), "passed") << first.dump ();
    ASSERT_TRUE (first.contains ("scripts") && first["scripts"].contains ("testResults"))
    << first.dump ();
    const auto& tests = first["scripts"]["testResults"];
    ASSERT_EQ (tests.size (), 1u) << first.dump ();
    EXPECT_EQ (tests[0]["name"].get<std::string> (), "Status code is 200");
    EXPECT_TRUE (tests[0]["passed"].get<bool> ());
}

// A jump backwards is the point of the feature - a retry loop is one - and it
// is also what the cycle bound below exists to survive.
TEST_F (ScenarioRunnerTest, SetNextRequestCanSendTheIterationBackwards) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", "", "", "First");
    // Jumps back exactly once: the second pass sees the flag the first set.
    seed_request ("req_b", 1, "/login", "", R"(
        if (!pm.environment.get("looped")) {
            pm.environment.set("looped", "yes");
            pm.execution.setNextRequest("First");
        }
    )");

    seed_environment ("env_1", R"({})");
    const auto run_id = start (/*iterations=*/1, "env_1");
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 4u);
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/login");
    EXPECT_EQ (seen[2].path, "/ok");
    EXPECT_EQ (seen[3].path, "/login");

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["steps_executed"].get<size_t> (), 4u);
    EXPECT_EQ (scenario["iterations_completed"].get<size_t> (), 1u);
}

TEST_F (ScenarioRunnerTest, SetNextRequestNullEndsTheIterationAndTheNextOneStillRuns) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(pm.execution.setNextRequest(null);)");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u) << "step 2 ran despite the iteration ending";
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/ok");

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["steps_executed"].get<size_t> (), 2u);
    EXPECT_EQ (scenario["passed"].get<size_t> (), 2u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 0u);
    // Ending an iteration early is not failing it.
    EXPECT_EQ (scenario["iterations_completed"].get<size_t> (), 2u);
}

TEST_F (ScenarioRunnerTest, SkipRequestSendsNothingAndIsNeverCountedAsAPass) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", R"(pm.execution.skipRequest();)");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 1u) << "the skipped step still went on the wire";
    EXPECT_EQ (seen[0].path, "/login");

    // The step is still a row - a skip the run does not record is a step that
    // silently disappears from the report.
    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    auto skipped_trace = json::parse (rows[0].trace_data);
    EXPECT_EQ (skipped_trace["outcome"].get<std::string> (), "skipped");
    EXPECT_EQ (skipped_trace["requestId"].get<std::string> (), "req_a");
    EXPECT_TRUE (skipped_trace.contains ("request"));
    // A step that never sent has no response, and an empty one would read as a
    // server that answered with nothing.
    EXPECT_FALSE (skipped_trace.contains ("response"));
    EXPECT_TRUE (rows[0].error.empty ()) << "a skip is not a failure";

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["skipped"].get<size_t> (), 1u);
    EXPECT_EQ (scenario["passed"].get<size_t> (), 1u);
    EXPECT_EQ (scenario["failed"].get<size_t> (), 0u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 0u);
}

// #2822: a skipped step is a step, not a request. The summary counts the
// requests that went out and stores their distribution, so the report has no
// reason to read the skipped step's status-0 row as a failure.
// Mutation check: store `total_requests = steps_executed` in
// `build_scenario_summary_payload` and the total fails.
TEST_F (ScenarioRunnerTest, ASkippedStepIsInNeitherTheRequestCountNorTheDistribution) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", R"(pm.execution.skipRequest();)");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    ASSERT_EQ (server_->requests ().size (), 2u);

    const auto summary = summary_of (run_id);
    EXPECT_EQ (summary["scenario"]["steps_executed"].get<size_t> (), 4u);
    EXPECT_EQ (summary["scenario"]["skipped"].get<size_t> (), 2u);
    EXPECT_EQ (summary["total_requests"].get<size_t> (), 2u);
    EXPECT_EQ (summary["status_codes"], (json{ { "200", 2 } })) << summary.dump ();
}

// The step outcomes are disjoint and sum to `steps_executed`, a skipped step
// included (#2824, the definition a load run's summary shares). Two failed
// assertions in one step are one `failed` step, and a 500 nothing asserts on is
// `passed` while the summary still counts it among the requests that failed.
// A regression guard: the sequential runner already counted this way.
TEST_F (ScenarioRunnerTest, StepOutcomesAreDisjointAndSumToStepsExecuted) {
    seed_collection ("col_1");
    seed_request ("req_skip", 0, "/ok", R"(pm.execution.skipRequest();)");
    const auto status_404 = [] (const std::string& id) {
        return json{ { "id", id }, { "kind", "assert.status" }, { "enabled", true },
            { "config", { { "in", json::array ({ 404 }) } } } };
    };
    seed_request_with_elements ("req_assert", 1, "/ok",
    json::array ({ status_404 ("el_a"), status_404 ("el_b") }));
    seed_request ("req_500", 2, "/fail500");

    const auto run_id = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto summary   = summary_of (run_id);
    const auto& scenario = summary.at ("scenario");
    const auto count     = [&scenario] (const char* key) {
        return scenario.at (key).get<size_t> ();
    };
    EXPECT_EQ (count ("steps_executed"), 6u) << scenario.dump ();
    EXPECT_EQ (count ("skipped"), 2u) << scenario.dump ();
    EXPECT_EQ (count ("failed"), 2u) << scenario.dump ();
    EXPECT_EQ (count ("errored"), 0u) << scenario.dump ();
    EXPECT_EQ (count ("stopped"), 0u) << scenario.dump ();
    EXPECT_EQ (count ("passed"), 2u) << scenario.dump ();
    EXPECT_EQ (count ("passed") + count ("failed") + count ("errored") +
    count ("skipped") + count ("stopped"),
    count ("steps_executed"));
    // Every step that was not skipped sent, so the steps that ran and the
    // skipped ones are the whole of `steps_executed`.
    EXPECT_EQ (summary.at ("total_requests").get<size_t> () + count ("skipped"),
    count ("steps_executed"));
    EXPECT_EQ (summary.at ("status_codes"), (json{ { "200", 2 }, { "500", 2 } }))
    << summary.dump ();
}

// The other side of the same line: a request that went out and got no answer
// is a request, recorded under status 0 like the load path records it.
// Mutation check: count only 2xx in the tally; the status 0 entry goes missing.
TEST_F (ScenarioRunnerTest, ARefusedConnectionIsAStatusZeroRequestInTheSummary) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    // Nothing listens on port 1; the send fails to connect rather than hanging.
    seed_request ("req_dead", 1, "", "", "", "http://127.0.0.1:1/never");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto summary = summary_of (run_id);
    EXPECT_EQ (summary["total_requests"].get<size_t> (), 2u);
    EXPECT_EQ (summary["status_codes"], (json{ { "0", 1 }, { "200", 1 } }))
    << summary.dump ();
}

// #3262: a collection run stores how many of its requests asked for HTTP/2 and
// got something lower, in the key the report reads for a load run. The mock is
// cleartext, where `http2` is never offered (CURL_HTTP_VERSION_2TLS), so the
// step asking for it is a downgrade without a TLS fixture; the `auto` step
// beside it is not, and the count is requests (2 iterations), not steps.
// Mutation check: drop the `++summary.http_version_downgraded` in
// `store_step_record` and the count reads 0.
TEST_F (ScenarioRunnerTest, ADowngradedStepIsCountedInTheSummaryPerRequest) {
    seed_collection ("col_1");
    seed_request ("req_h2", 0, "/ok");
    seed_request ("req_auto", 1, "/ok");
    auto h2 = db_->get_request ("req_h2");
    ASSERT_HAS_VALUE (h2);
    h2->http_version = "http2";
    db_->save_request (*h2);

    const auto run_id = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto summary = summary_of (run_id);
    EXPECT_EQ (summary["total_requests"].get<size_t> (), 4u) << summary.dump ();
    ASSERT_TRUE (summary.contains ("http_version_downgraded")) << summary.dump ();
    EXPECT_EQ (summary["http_version_downgraded"].get<size_t> (), 2u) << summary.dump ();
}

// The other side: a run that asked for nothing special stores a counted 0, so
// a reader can tell it from a summary written before #3262.
// Mutation check: write the key only when positive and `contains` fails.
TEST_F (ScenarioRunnerTest, ARunWithoutADowngradeStoresACountedZero) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto summary = summary_of (run_id);
    ASSERT_TRUE (summary.contains ("http_version_downgraded")) << summary.dump ();
    EXPECT_EQ (summary["http_version_downgraded"].get<size_t> (), 0u) << summary.dump ();
}

TEST_F (ScenarioRunnerTest, SkipRequestInATestScriptFailsTheStepRatherThanPretending) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(pm.execution.skipRequest();)");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    // The request had already gone out; what fails is the script. A script
    // error no longer ends the iteration (issue #2526), so step 2 still runs.
    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[1].path, "/login");

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_EQ (json::parse (rows[0].trace_data)["outcome"].get<std::string> (), "errored");
    EXPECT_NE (rows[0].error.find ("pre-request"), std::string::npos) << rows[0].error;

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["skipped"].get<size_t> (), 0u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 1u);
}

// Postman documents jumping by the id a script reads off `pm.info.requestId`
// (issue #1006), and a script that does it end to end is what says the plan
// carries the ids resolution needs.
TEST_F (ScenarioRunnerTest, SetNextRequestJumpsByRequestIdToo) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(pm.execution.setNextRequest("req_c");)");
    seed_request ("req_b", 1, "/login");
    seed_request ("req_c", 2, "/observe", "", "", "", "Checkout");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/observe");

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_EQ (json::parse (rows[1].trace_data)["requestId"].get<std::string> (), "req_c");
    EXPECT_TRUE (rows[1].error.empty ()) << rows[1].error;
}

// The quoted stop form: Postman's runner reads `setNextRequest("null")` as the
// real `null` above, and collections written against it carry the spelling.
TEST_F (ScenarioRunnerTest, SetNextRequestWithTheStringNullEndsTheIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(pm.execution.setNextRequest("null");)");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u) << "step 2 ran despite the iteration ending";
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/ok");

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    // Ending an iteration is not erroring the step that ended it - the shape
    // this used to take, when the string reached the name index and matched
    // nothing.
    EXPECT_EQ (json::parse (rows[0].trace_data)["outcome"].get<std::string> (), "passed");
    EXPECT_TRUE (rows[0].error.empty ()) << rows[0].error;

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["errored"].get<size_t> (), 0u);
    EXPECT_EQ (scenario["iterations_completed"].get<size_t> (), 2u);
}

// The precedence the docs state, on the wire: a collection that really does
// carry a request named `null` can still jump to it.
TEST_F (ScenarioRunnerTest, AStepNamedNullIsStillReachableByName) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(pm.execution.setNextRequest("null");)");
    seed_request ("req_b", 1, "/login");
    seed_request ("req_c", 2, "/observe", "", "", "", "null");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/observe")
    << "the stop form won over a step the run carries";
}

TEST_F (ScenarioRunnerTest, AnUnknownTargetFailsTheStepByNameAndEndsTheIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(pm.execution.setNextRequest("Nowhere");)");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_EQ (server_->requests ().size (), 1u);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_EQ (json::parse (rows[0].trace_data)["outcome"].get<std::string> (), "errored");
    EXPECT_NE (rows[0].error.find ("Nowhere"), std::string::npos) << rows[0].error;

    EXPECT_EQ (summary_of (run_id)["scenario"]["errored"].get<size_t> (), 1u);
}

TEST_F (ScenarioRunnerTest, AnAmbiguousTargetNamesEveryStepThatAnswersToIt) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(pm.execution.setNextRequest("Twin");)");
    seed_request ("req_b", 1, "/login", "", "", "", "Twin");
    seed_request ("req_c", 2, "/observe", "", "", "", "Twin");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    // Neither twin ran: a jump nobody can resolve is not a jump to the first
    // one that happens to match.
    EXPECT_EQ (server_->requests ().size (), 1u);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_EQ (json::parse (rows[0].trace_data)["outcome"].get<std::string> (), "errored");
    EXPECT_NE (rows[0].error.find ("ambiguous"), std::string::npos) << rows[0].error;
    EXPECT_NE (rows[0].error.find ("1 and 2"), std::string::npos) << rows[0].error;
}

// Two steps pointing at each other is a two-line script, and Postman's runner
// simply runs forever. The bound is what makes the run terminal.
TEST_F (ScenarioRunnerTest, ACycleTripsTheStepBudgetAndTheRunStillFinishes) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "",
    R"(pm.execution.setNextRequest("Pong");)", "", "Ping");
    seed_request ("req_b", 1, "/login", "",
    R"(pm.execution.setNextRequest("Ping");)", "", "Pong");
    set_config ("maxStepsPerIteration", "6");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_EQ (server_->requests ().size (), 6u);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 6u);
    EXPECT_EQ (json::parse (rows[5].trace_data)["outcome"].get<std::string> (), "errored");
    EXPECT_NE (rows[5].error.find ("maxStepsPerIteration"), std::string::npos)
    << rows[5].error;
    // The message has to say what is looping, or it names a limit and leaves
    // the reader to guess which steps hit it.
    EXPECT_NE (rows[5].error.find ("Ping -> Pong"), std::string::npos)
    << rows[5].error;

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["steps_executed"].get<size_t> (), 6u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 1u);
}

// A `control.loop` is cut by the same bound, and its message must not blame a
// script: nothing here calls `setNextRequest`. Mutation check: restore the old
// "setNextRequest is cycling through" sentence and the control.loop assertion
// fails.
TEST_F (ScenarioRunnerTest, ALoopThatOutgrowsTheStepBudgetIsNamedInTheCutOff) {
    const json loop = { { "id", "el_loop" }, { "kind", "control.loop" },
        { "enabled", true }, { "config", { { "count", 500 } } } };
    seed_collection_with_elements ("col_1", "", json::array ({ loop }));
    seed_request ("req_a", 0, "/ok", "", "", "", "Ping");
    seed_request ("req_b", 1, "/login", "", "", "", "Pong");
    set_config ("maxStepsPerIteration", "6");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 6u);
    EXPECT_NE (rows[5].error.find ("maxStepsPerIteration"), std::string::npos)
    << rows[5].error;
    EXPECT_NE (rows[5].error.find ("control.loop"), std::string::npos)
    << rows[5].error;
    EXPECT_NE (rows[5].error.find ("Ping -> Pong"), std::string::npos)
    << rows[5].error;
}

TEST (ScenarioStepBudget, TheCutOffMessageNamesEveryJumpSourceAndTheRecentSteps) {
    const std::deque<std::string> recent{ "Ping", "Pong" };
    const auto message = vayu::core::describe_steps_cap_exceeded (100, recent);

    EXPECT_NE (message.find ("(100)"), std::string::npos) << message;
    for (const char* source : { "setNextRequest", "control.switch", "control.loop" }) {
        EXPECT_NE (message.find (source), std::string::npos) << source << " in " << message;
    }
    EXPECT_NE (message.find ("Ping -> Pong"), std::string::npos) << message;
}

// ============================================================================
// Flow-control resolution (pure)
// ============================================================================

using NextStep = vayu::core::NextStepResolution::Kind;

TEST (ScenarioNextStep, ResolvesAUniqueNameToItsPosition) {
    vayu::core::ScenarioPlan plan;
    plan.steps.push_back ({ 0, "req_a", "First", {}, {}, "" });
    plan.steps.push_back ({ 1, "req_b", "Second", {}, {}, "" });

    const auto index = vayu::core::build_step_index (plan);
    auto resolved    = vayu::core::resolve_next_step (index, "Second");
    ASSERT_EQ (resolved.kind, NextStep::Step) << resolved.error;
    EXPECT_EQ (resolved.index, 1u);
    EXPECT_TRUE (resolved.error.empty ());
}

TEST (ScenarioNextStep, RefusesATargetNoStepAnswersTo) {
    vayu::core::ScenarioPlan plan;
    plan.steps.push_back ({ 0, "req_a", "First", {}, {}, "" });

    auto resolved =
    vayu::core::resolve_next_step (vayu::core::build_step_index (plan), "Missing");
    EXPECT_EQ (resolved.kind, NextStep::Unresolved);
    EXPECT_NE (resolved.error.find ("Missing"), std::string::npos) << resolved.error;
    // The message has to say what was searched: since #1006 a target may be an
    // id, so "names no request" would send the reader looking for a typo in a
    // name they never wrote.
    EXPECT_NE (resolved.error.find ("name or id"), std::string::npos)
    << resolved.error;
}

TEST (ScenarioNextStep, RefusesADuplicatedNameAndNamesEveryPosition) {
    vayu::core::ScenarioPlan plan;
    plan.steps.push_back ({ 0, "req_a", "Twin", {}, {}, "" });
    plan.steps.push_back ({ 1, "req_b", "Other", {}, {}, "" });
    plan.steps.push_back ({ 2, "req_c", "Twin", {}, {}, "" });

    auto resolved =
    vayu::core::resolve_next_step (vayu::core::build_step_index (plan), "Twin");
    EXPECT_EQ (resolved.kind, NextStep::Unresolved);
    EXPECT_NE (resolved.error.find ("ambiguous"), std::string::npos) << resolved.error;
    EXPECT_NE (resolved.error.find ("0 and 2"), std::string::npos) << resolved.error;
}

// Postman documents passing the id a script reads off `pm.info.requestId`
// (issue #1006). Resolution falls through to the ids only after the names, so a
// collection whose steps carry neither surprise keeps behaving as it did.
TEST (ScenarioNextStep, ResolvesARequestIdWhenNoNameAnswers) {
    vayu::core::ScenarioPlan plan;
    plan.steps.push_back ({ 0, "req_a", "First", {}, {}, "" });
    plan.steps.push_back ({ 1, "req_b", "Second", {}, {}, "" });

    auto resolved =
    vayu::core::resolve_next_step (vayu::core::build_step_index (plan), "req_b");
    ASSERT_EQ (resolved.kind, NextStep::Step) << resolved.error;
    EXPECT_EQ (resolved.index, 1u);
}

TEST (ScenarioNextStep, PrefersTheNameWhenOneStepsNameIsAnothersId) {
    vayu::core::ScenarioPlan plan;
    plan.steps.push_back ({ 0, "req_a", "First", {}, {}, "" });
    // Step 1 is *named* what step 2 is *identified* by. The name is what a
    // script author can see in the sidebar, so it wins.
    plan.steps.push_back ({ 1, "req_b", "req_c", {}, {}, "" });
    plan.steps.push_back ({ 2, "req_c", "Third", {}, {}, "" });

    auto resolved =
    vayu::core::resolve_next_step (vayu::core::build_step_index (plan), "req_c");
    ASSERT_EQ (resolved.kind, NextStep::Step) << resolved.error;
    EXPECT_EQ (resolved.index, 1u);
}

// The quoted spelling is endemic in collections written against Postman's
// runner, which reads it as the stop form real `null` already means here.
TEST (ScenarioNextStep, TheStringNullEndsTheIteration) {
    vayu::core::ScenarioPlan plan;
    plan.steps.push_back ({ 0, "req_a", "First", {}, {}, "" });

    auto resolved =
    vayu::core::resolve_next_step (vayu::core::build_step_index (plan), "null");
    EXPECT_EQ (resolved.kind, NextStep::EndIteration);
    EXPECT_TRUE (resolved.error.empty ());
}

// Honest precedence: a step a run actually carries is the more specific answer,
// and reading the stop form first would make that step unreachable.
TEST (ScenarioNextStep, AStepNamedNullWinsOverTheStopForm) {
    vayu::core::ScenarioPlan plan;
    plan.steps.push_back ({ 0, "req_a", "First", {}, {}, "" });
    plan.steps.push_back ({ 1, "req_b", "null", {}, {}, "" });

    auto resolved =
    vayu::core::resolve_next_step (vayu::core::build_step_index (plan), "null");
    ASSERT_EQ (resolved.kind, NextStep::Step) << resolved.error;
    EXPECT_EQ (resolved.index, 1u);
}

TEST (ScenarioStepBudget, DerivesTheBoundFromThePlanWhenUnconfigured) {
    // Ten times the plan, with a floor that keeps a short plan's legitimate
    // loops working.
    EXPECT_EQ (vayu::core::resolve_max_steps_per_iteration (0, 3), 100u);
    EXPECT_EQ (vayu::core::resolve_max_steps_per_iteration (0, 50), 500u);
    // Whatever the derivation, a straight-through iteration can never trip it.
    EXPECT_GE (vayu::core::resolve_max_steps_per_iteration (0, 200), 200u);
}

TEST (ScenarioStepBudget, AConfiguredBoundWins) {
    EXPECT_EQ (vayu::core::resolve_max_steps_per_iteration (7, 50), 7u);
}

TEST (ScenarioSummaryPayload, CarriesTheKeysTheReportReadsPlusTheScenarioTallies) {
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.iterations_requested = 4;
    inputs.iterations_completed = 3;
    inputs.steps_executed       = 11;
    inputs.passed               = 7;
    inputs.failed               = 2;
    inputs.skipped              = 0;
    inputs.errored              = 1;
    inputs.stopped              = 1;
    inputs.steps_stored         = 5;
    inputs.steps_dropped        = 6;
    inputs.steps_not_run        = 7;
    inputs.stop_on_error        = true;
    inputs.duration_s           = 2.0;
    // Nine of the eleven steps sent; the other two are counted as steps only.
    inputs.status_codes            = { { 200, 6 }, { 500, 2 }, { 0, 1 } };
    inputs.http_version_downgraded = 3;
    inputs.error_classes.record (vayu::McpErrorClass::Tool, std::nullopt);

    auto summary = vayu::core::build_scenario_summary_payload (inputs);
    EXPECT_EQ (summary["total_requests"].get<size_t> (), 9u);
    EXPECT_EQ (summary["http_version_downgraded"].get<size_t> (), 3u);
    // #3828: always written, `{}` when no reply failed.
    EXPECT_EQ (summary["error_classes"], (nlohmann::json{ { "tool", 1 } }))
    << summary.dump ();
    EXPECT_EQ (vayu::core::build_scenario_summary_payload (
               vayu::core::ScenarioSummaryInputs{})["error_classes"],
    nlohmann::json::object ());
    EXPECT_EQ (summary["status_codes"],
    (nlohmann::json{ { "0", 1 }, { "200", 6 }, { "500", 2 } }))
    << summary.dump ();
    EXPECT_DOUBLE_EQ (summary["test_duration"].get<double> (), 2.0);
    EXPECT_DOUBLE_EQ (summary["rps"].get<double> (), 4.5);

    const auto& scenario = summary["scenario"];
    EXPECT_EQ (scenario["iterations"].get<size_t> (), 4u);
    EXPECT_EQ (scenario["iterations_completed"].get<size_t> (), 3u);
    EXPECT_EQ (scenario["steps_executed"].get<size_t> (), 11u);
    EXPECT_EQ (scenario["passed"].get<size_t> (), 7u);
    EXPECT_EQ (scenario["failed"].get<size_t> (), 2u);
    EXPECT_EQ (scenario["skipped"].get<size_t> (), 0u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 1u);
    EXPECT_EQ (scenario["stopped"].get<size_t> (), 1u);
    EXPECT_EQ (scenario["steps_stored"].get<size_t> (), 5u);
    EXPECT_EQ (scenario["steps_dropped"].get<size_t> (), 6u);
    EXPECT_EQ (scenario["steps_not_run"].get<size_t> (), 7u);
    EXPECT_TRUE (scenario["stop_on_error"].get<bool> ());
}

// Contract coverage rides the summary as its own top-level section, not as part
// of `scenario` - it describes the contract, not the sequence - and is left out
// entirely for a run that was not measured against one (issue #629).
TEST (ScenarioSummaryPayload, CoverageIsItsOwnSectionAndAbsentWhenNotMeasured) {
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 2;
    EXPECT_FALSE (vayu::core::build_scenario_summary_payload (inputs).contains ("coverage"));

    inputs.coverage    = nlohmann::json{ { "operationsTotal", 2 },
        { "operationsCovered", 1 }, { "operations", nlohmann::json::array ({ 1 }) } };
    const auto summary = vayu::core::build_scenario_summary_payload (inputs);
    ASSERT_TRUE (summary.contains ("coverage")) << summary.dump ();
    EXPECT_EQ (summary["coverage"]["operationsCovered"], 1);
    // Beside `scenario`, never inside it.
    EXPECT_FALSE (summary["scenario"].contains ("coverage"));
}

// A run in which no step sent stores an empty distribution rather than none:
// the report reads an absent key as a summary stored before #2822 and falls
// back to the rows. Mutation check: write `status_codes` only when non-empty
// and this fails.
TEST (ScenarioSummaryPayload, ARunInWhichNoStepSentStoresAnEmptyDistribution) {
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 3;
    inputs.skipped        = 3;
    inputs.duration_s     = 1.0;
    const auto summary    = vayu::core::build_scenario_summary_payload (inputs);
    EXPECT_EQ (summary["total_requests"].get<size_t> (), 0u);
    ASSERT_TRUE (summary.contains ("status_codes")) << summary.dump ();
    EXPECT_TRUE (summary["status_codes"].is_object ());
    EXPECT_TRUE (summary["status_codes"].empty ());
    EXPECT_DOUBLE_EQ (summary["rps"].get<double> (), 0.0);
}

TEST (ScenarioSummaryPayload, AZeroLengthRunReportsNoRateRatherThanDividingByZero) {
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 3;
    inputs.status_codes   = { { 200, 3 } };
    auto summary          = vayu::core::build_scenario_summary_payload (inputs);
    EXPECT_DOUBLE_EQ (summary["rps"].get<double> (), 0.0);
}

// Issue #2389: the stored `latency` block is the exact nearest-rank summary of
// the sample it was given. The sample is unsorted with one outlier, so a
// summary that skipped the sort, took the mean for the median or read the
// wrong rank answers differently on every figure. Mutation check: delete the
// `summary["latency"]` write in `build_scenario_summary_payload` and this reds.
TEST (ScenarioSummaryPayload, StoresTheExactNearestRankLatencyOfTheSentSample) {
    // 1..1000 ms, shuffled by a stride: every percentile lands on a distinct
    // value, so a figure written under the wrong key fails.
    std::vector<double> sample;
    sample.reserve (1000);
    for (int i = 0; i < 1000; ++i) {
        sample.push_back (static_cast<double> (((i * 7) % 1000) + 1));
    }
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 1000;
    inputs.latency        = vayu::core::summarize_latencies (sample);

    const auto summary = vayu::core::build_scenario_summary_payload (inputs);
    ASSERT_TRUE (summary.contains ("latency")) << summary.dump ();
    const auto& latency = summary["latency"];
    EXPECT_EQ (latency["count"].get<size_t> (), 1000u);
    EXPECT_DOUBLE_EQ (latency["min"].get<double> (), 1.0);
    EXPECT_DOUBLE_EQ (latency["max"].get<double> (), 1000.0);
    EXPECT_DOUBLE_EQ (latency["avg"].get<double> (), 500.5);
    EXPECT_DOUBLE_EQ (latency["p50"].get<double> (), 500.0);
    EXPECT_DOUBLE_EQ (latency["p75"].get<double> (), 750.0);
    EXPECT_DOUBLE_EQ (latency["p90"].get<double> (), 900.0);
    EXPECT_DOUBLE_EQ (latency["p95"].get<double> (), 950.0);
    EXPECT_DOUBLE_EQ (latency["p99"].get<double> (), 990.0);
    EXPECT_DOUBLE_EQ (latency["p999"].get<double> (), 1000.0);
}

// A run in which no step sent has no latency to report. The block is `count: 0`
// and nothing else - a stored p99 of 0 would read as a step that answered
// instantly (issue #2389).
TEST (ScenarioSummaryPayload, AnEmptyLatencySampleStoresACountOfZeroAndNoPercentiles) {
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 3;
    inputs.latency        = vayu::core::summarize_latencies ({});

    const auto summary = vayu::core::build_scenario_summary_payload (inputs);
    ASSERT_TRUE (summary.contains ("latency")) << summary.dump ();
    EXPECT_EQ (summary["latency"], (nlohmann::json{ { "count", 0 } }))
    << summary.dump ();
}

// ============================================================================
// Per-step schema verdicts (issue #681)
// ============================================================================

namespace {

/// The pet schema every schema test below declares: an integer id and a string
/// name, both required - so a string id is a failure and a missing name is one
/// too, which is what a drifting contract actually looks like.
json pet_schema () {
    return json::parse (R"({
        "type": "object",
        "required": ["id", "name"],
        "properties": {"id": {"type": "integer"}, "name": {"type": "string"}}
    })");
}

/// A response-schema index declaring @p schema for `200 application/json` on
/// each of @p paths, identified by `GET <path>` - the identity a step's
/// `spec_operation` is stamped with below.
json schema_index_for (const std::vector<std::string>& paths, const json& schema) {
    json operations = json::array ();
    for (const auto& path : paths) {
        operations.push_back (json{ { "method", "GET" }, { "path", path },
        { "responses",
        json::array ({ json{ { "status", "200" },
        { "contentType", "application/json" }, { "schema", schema } } }) } });
    }
    return json{ { "refRoots", json::object () }, { "operations", operations } };
}

/// The `validation` node the engine stamped on a stored step's trace, or a null
/// json when it stamped none - the state that means "nobody judged this".
json verdict_of (const vayu::db::Result& row) {
    const auto trace = json::parse (row.trace_data);
    auto node        = trace.find ("validation");
    return node == trace.end () ? json () : *node;
}

} // namespace

TEST_F (ScenarioRunnerTest, EachStepIsJudgedAgainstWhatItsOperationDeclares) {
    seed_collection ("col_1");
    seed_request ("req_ok", 0, "/pet");
    seed_request ("req_bad", 1, "/pet-wrong");
    seed_request ("req_undeclared", 2, "/ok");
    // Two of the three operations are in the document; the third is a request
    // whose collection has drifted off its contract.
    bind_spec (schema_index_for ({ "/pet", "/pet-wrong" }, pet_schema ()));
    stamp_spec_operation ("req_ok", json{ { "method", "GET" }, { "path", "/pet" } });
    stamp_spec_operation ("req_bad", json{ { "method", "GET" }, { "path", "/pet-wrong" } });
    stamp_spec_operation ("req_undeclared", json{ { "method", "GET" }, { "path", "/ok" } });

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 3u);

    const auto matched = verdict_of (rows[0]);
    ASSERT_FALSE (matched.is_null ()) << rows[0].trace_data;
    EXPECT_TRUE (matched["checked"].get<bool> ());
    EXPECT_TRUE (matched["valid"].get<bool> ());
    EXPECT_EQ (matched["matchedStatus"].get<std::string> (), "200");

    const auto failed = verdict_of (rows[1]);
    ASSERT_FALSE (failed.is_null ()) << rows[1].trace_data;
    EXPECT_TRUE (failed["checked"].get<bool> ());
    EXPECT_FALSE (failed["valid"].get<bool> ());
    EXPECT_GT (failed["failuresTotal"].get<size_t> (), 0u);

    // Bound and unjudgeable is its own answer, carrying the reason - never a
    // silently absent verdict, which is how a drifted collection stays drifted.
    const auto undeclared = verdict_of (rows[2]);
    ASSERT_FALSE (undeclared.is_null ()) << rows[2].trace_data;
    EXPECT_FALSE (undeclared["checked"].get<bool> ());
    EXPECT_EQ (undeclared["reason"].get<std::string> (), "operation_not_declared");
    // `checked: false` carries no validity at all - the distinction the whole
    // node exists for.
    EXPECT_FALSE (undeclared.contains ("valid"));
}

TEST_F (ScenarioRunnerTest, ARunOfAnUnboundCollectionCarriesNoVerdictAnywhere) {
    seed_collection ("col_1");
    seed_request ("req_ok", 0, "/pet");
    // Deliberately stamped with an identity: a request can name an operation
    // while its collection binds no document, and that must still produce
    // nothing rather than `operation_not_declared`.
    stamp_spec_operation ("req_ok", json{ { "method", "GET" }, { "path", "/pet" } });

    const auto run_id  = start (/*iterations=*/1);
    const auto context = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_TRUE (verdict_of (rows[0]).is_null ()) << rows[0].trace_data;

    // Absent from the summary too, and absent rather than a block of zeros: a
    // run nothing judged did not match none of a contract.
    EXPECT_FALSE (summary_of (run_id).contains ("schemaValidation"));

    // And absent from the wire, which is the surface a live view reads. The
    // stored row above proves the trace; this proves the `step` frame, which is
    // built on a separate path - a key added there unconditionally (even as a
    // null) would leave the watcher showing a verdict the report never writes.
    const auto steps = step_frames (context);
    ASSERT_EQ (steps.size (), 1u);
    const auto& payload = steps[0];
    const auto data_at  = payload.find ("data: ");
    ASSERT_NE (data_at, std::string::npos) << payload;
    EXPECT_FALSE (json::parse (payload.substr (data_at + 6)).contains ("validation"))
    << payload;
}

TEST_F (ScenarioRunnerTest, ABoundDocumentWithNoSchemaIndexIsSaidSoRatherThanSilent) {
    seed_collection ("col_1");
    seed_request ("req_ok", 0, "/pet");
    stamp_spec_operation ("req_ok", json{ { "method", "GET" }, { "path", "/pet" } });
    // A document stored before the index existed: bound, with nothing to judge
    // against. The reader can act on this one - sync the binding.
    vayu::db::SpecDocument spec;
    spec.id         = "spec_1";
    spec.content    = "openapi: 3.0.0";
    spec.hash       = "hash-1";
    spec.fetched_at = 1;
    db_->save_spec_document (spec);
    auto col = db_->get_collection ("col_1");
    ASSERT_HAS_VALUE (col);
    col->openapi = json{ { "specId", "spec_1" }, { "specHash", "hash-1" } }.dump ();
    db_->create_collection (*col);

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    const auto verdict = verdict_of (rows[0]);
    ASSERT_FALSE (verdict.is_null ()) << rows[0].trace_data;
    EXPECT_FALSE (verdict["checked"].get<bool> ());
    EXPECT_EQ (verdict["reason"].get<std::string> (), "no_index");
}

TEST_F (ScenarioRunnerTest, ABindingWhoseDocumentHasMovedSaysSoRatherThanJudgingAgainstIt) {
    seed_collection ("col_1");
    seed_request ("req_ok", 0, "/pet");
    stamp_spec_operation ("req_ok", json{ { "method", "GET" }, { "path", "/pet" } });
    bind_spec (schema_index_for ({ "/pet" }, pet_schema ()), "hash-1");
    // The document is replaced under the binding, as a sync landing elsewhere
    // would leave it. What it declares now is not what this run was bound to.
    vayu::db::SpecDocument moved;
    moved.id         = "spec_1";
    moved.content    = "openapi: 3.0.0 # v2";
    moved.hash       = "hash-2";
    moved.fetched_at = 2;
    moved.response_schemas = schema_index_for ({ "/pet" }, pet_schema ()).dump ();
    db_->save_spec_document (moved);

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    const auto verdict = verdict_of (rows[0]);
    ASSERT_FALSE (verdict.is_null ()) << rows[0].trace_data;
    EXPECT_FALSE (verdict["checked"].get<bool> ());
    EXPECT_EQ (verdict["reason"].get<std::string> (), "hash_mismatch");
}

TEST_F (ScenarioRunnerTest, ASchemaFailureDoesNotChangeAStepsOutcomeByDefault) {
    seed_collection ("col_1");
    seed_request ("req_bad", 0, "/pet-wrong");
    bind_spec (schema_index_for ({ "/pet-wrong" }, pet_schema ()));
    stamp_spec_operation ("req_bad", json{ { "method", "GET" }, { "path", "/pet-wrong" } });

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    // The response did not match, and the step still passed: the verdict is its
    // own channel. Revert the `record.outcome == Passed` guard in the runner
    // and this is the assertion that reddens.
    const auto verdict = verdict_of (rows[0]);
    ASSERT_FALSE (verdict.is_null ());
    EXPECT_FALSE (verdict["valid"].get<bool> ());
    EXPECT_EQ (json::parse (rows[0].trace_data)["outcome"].get<std::string> (), "passed");
    EXPECT_TRUE (rows[0].error.empty ()) << rows[0].error;

    const auto summary = summary_of (run_id);
    EXPECT_EQ (summary["scenario"]["passed"].get<size_t> (), 1u);
    EXPECT_EQ (summary["scenario"]["failed"].get<size_t> (), 0u);
    EXPECT_FALSE (summary["schemaValidation"]["failOnSchemaError"].get<bool> ());
}

TEST_F (ScenarioRunnerTest, FailOnSchemaErrorFailsTheStepAndNamesTheFirstProblem) {
    seed_collection ("col_1");
    seed_request ("req_bad", 0, "/pet-wrong");
    seed_request ("req_ok", 1, "/pet");
    bind_spec (schema_index_for ({ "/pet", "/pet-wrong" }, pet_schema ()));
    stamp_spec_operation ("req_bad", json{ { "method", "GET" }, { "path", "/pet-wrong" } });
    stamp_spec_operation ("req_ok", json{ { "method", "GET" }, { "path", "/pet" } });

    const auto run_id = start_gated (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_EQ (json::parse (rows[0].trace_data)["outcome"].get<std::string> (), "failed");
    // The sentence names where the body disagreed, not just that it did - the
    // step list is all a reader has to go on.
    EXPECT_NE (rows[0].error.find ("/id"), std::string::npos) << rows[0].error;
    // A failure is not an error: the iteration continued and the matching step
    // after it still ran and still passed.
    EXPECT_EQ (json::parse (rows[1].trace_data)["outcome"].get<std::string> (), "passed");

    const auto summary = summary_of (run_id);
    EXPECT_EQ (summary["scenario"]["failed"].get<size_t> (), 1u);
    EXPECT_EQ (summary["scenario"]["passed"].get<size_t> (), 1u);
    EXPECT_TRUE (summary["schemaValidation"]["failOnSchemaError"].get<bool> ());
}

TEST_F (ScenarioRunnerTest, TheGateNeverOverwritesAFailureThatAlreadyHasAReason) {
    seed_collection ("col_1");
    // A step whose test script fails *and* whose body does not match: the
    // assertion is the one a reader has to fix first, so it keeps the error.
    seed_request ("req_bad", 0, "/pet-wrong",
    "", "pm.test('is a teapot', function () { pm.expect(pm.response.code).to.equal(418); });");
    bind_spec (schema_index_for ({ "/pet-wrong" }, pet_schema ()));
    stamp_spec_operation ("req_bad", json{ { "method", "GET" }, { "path", "/pet-wrong" } });

    const auto run_id = start_gated (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_EQ (json::parse (rows[0].trace_data)["outcome"].get<std::string> (), "failed");
    EXPECT_NE (rows[0].error.find ("is a teapot"), std::string::npos) << rows[0].error;
}

TEST_F (ScenarioRunnerTest, ASkippedStepCarriesNoVerdictBecauseItMadeNoResponse) {
    seed_collection ("col_1");
    seed_request ("req_skip", 0, "/pet", "pm.execution.skipRequest();");
    bind_spec (schema_index_for ({ "/pet" }, pet_schema ()));
    stamp_spec_operation ("req_skip", json{ { "method", "GET" }, { "path", "/pet" } });

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_TRUE (verdict_of (rows[0]).is_null ()) << rows[0].trace_data;
    // And it is not counted as a response that went unchecked either - the run
    // produced no responses at all.
    EXPECT_FALSE (summary_of (run_id).contains ("schemaValidation"));
}

TEST_F (ScenarioRunnerTest, TheRunTalliesItsVerdictsForTheReport) {
    seed_collection ("col_1");
    seed_request ("req_ok", 0, "/pet");
    seed_request ("req_bad", 1, "/pet-wrong");
    seed_request ("req_undeclared", 2, "/ok");
    bind_spec (schema_index_for ({ "/pet", "/pet-wrong" }, pet_schema ()));
    stamp_spec_operation ("req_ok", json{ { "method", "GET" }, { "path", "/pet" } });
    stamp_spec_operation ("req_bad", json{ { "method", "GET" }, { "path", "/pet-wrong" } });
    stamp_spec_operation ("req_undeclared", json{ { "method", "GET" }, { "path", "/ok" } });

    const auto run_id = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto validation = summary_of (run_id)["schemaValidation"];
    ASSERT_FALSE (validation.is_null ());
    // The load pass's shape, written by a collection run (issue #681 on #682's
    // block): `sampled` is the denominator, whatever produced it.
    EXPECT_EQ (validation["sampled"].get<size_t> (), 6u);
    EXPECT_EQ (validation["checked"].get<size_t> (), 4u);
    EXPECT_EQ (validation["valid"].get<size_t> (), 2u);
    EXPECT_EQ (validation["failed"].get<size_t> (), 2u);
    EXPECT_EQ (validation["unevaluated"].get<size_t> (), 0u);
    // ...and `exact` is what says that denominator is the whole run rather than
    // a reservoir. A load run writes no such key, and its readers say
    // "sampled"; drop this and a collection run starts claiming to be one.
    EXPECT_TRUE (validation["exact"].get<bool> ());
    // The two steps the document does not declare are accounted for by name,
    // not left as an unexplained gap between `sampled` and `checked`.
    EXPECT_EQ (validation["uncheckedReasons"]["operation_not_declared"].get<size_t> (), 2u);
    // A failure example names the step it came from, which is the whole reason
    // the tally is given one.
    ASSERT_FALSE (validation["failures"].empty ());
    EXPECT_EQ (validation["failures"][0]["step"].get<std::string> (), "Step req_bad");
}

// Issue #1564: a collection run judges itself against the same `thresholds`
// block a load run does, rather than accepting and silently ignoring it.
TEST_F (ScenarioRunnerTest, ACollectionRunIsJudgedAgainstItsDeclaredBudgets) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start_with_thresholds (
    /*iterations=*/1, json{ { "maxErrorRatePct", 0 }, { "latencyP99Ms", 60000 } });
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto thresholds = summary_of (run_id)["thresholds"];
    ASSERT_FALSE (thresholds.is_null ()) << "two passing steps against two "
                                            "declared budgets must be judged";
    EXPECT_EQ (thresholds["passed"].get<size_t> (), 2u);
    EXPECT_EQ (thresholds["failed"].get<size_t> (), 0u);
    ASSERT_EQ (thresholds["checks"].size (), 2u);
    for (const auto& check : thresholds["checks"]) {
        EXPECT_TRUE (check["evaluated"].get<bool> ()) << check.dump ();
        EXPECT_TRUE (check["passed"].get<bool> ()) << check.dump ();
    }
}

// #2384, the sequential side of the load path's latency population: a step the
// residual pass refused before the wire (its pre-request script emptied a
// header name) is an errored request with no duration. It counts in the error
// rate and in no percentile, so a latency budget over it has nothing to judge
// rather than a 0 ms step to pass on. Mutation-check: push the latency for
// every sent step again and the p99 check reads evaluated.
TEST_F (ScenarioRunnerTest, AStepRefusedBeforeTheWireIsAnErrorWithNoLatency) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", R"(pm.collectionVariables.set("header_name", "");)",
    "", "", "", R"([{"key":"{{header_name}}","value":"acme","enabled":true}])");

    const auto run_id = start_with_thresholds (
    /*iterations=*/1, json{ { "latencyP99Ms", 200 }, { "maxErrorRatePct", 50 } });
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    EXPECT_TRUE (server_->requests ().empty ())
    << "the refused step reached the wire";

    const auto thresholds = summary_of (run_id)["thresholds"];
    ASSERT_FALSE (thresholds.is_null ());
    ASSERT_EQ (thresholds["checks"].size (), 2u);
    const auto& latency = thresholds["checks"][0];
    EXPECT_EQ (latency["metric"].get<std::string> (), "latencyP99Ms");
    EXPECT_FALSE (latency["evaluated"].get<bool> ()) << latency.dump ();
    const auto& errors = thresholds["checks"][1];
    EXPECT_EQ (errors["metric"].get<std::string> (), "maxErrorRatePct");
    EXPECT_DOUBLE_EQ (errors["actual"].get<double> (), 100.0) << errors.dump ();
}

// The other half: a transport failure ran a transfer, so it keeps its duration
// and the latency budget has a measurement to judge.
TEST_F (ScenarioRunnerTest, AStepWhoseTransferFailedKeepsItsLatency) {
    seed_collection ("col_1");
    // Port 1 refuses the connection.
    seed_request ("req_a", 0, "/ok", "", "", "http://127.0.0.1:1/");

    const auto run_id =
    start_with_thresholds (/*iterations=*/1, json{ { "latencyP99Ms", 60000 } });
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto thresholds = summary_of (run_id)["thresholds"];
    ASSERT_FALSE (thresholds.is_null ());
    ASSERT_EQ (thresholds["checks"].size (), 1u);
    EXPECT_TRUE (thresholds["checks"][0]["evaluated"].get<bool> ())
    << thresholds["checks"][0].dump ();
}

// Issue #2389: the stored `latency` block and the latency budget's `actual`
// are one computation over one sample, so the report's p99 is the number the
// verdict was judged on. Mutation check: in `run_scenario`, compute
// `summary.latency` from a different list than the threshold input and the two
// diverge.
TEST_F (ScenarioRunnerTest, TheStoredLatencyIsTheSampleTheLatencyBudgetJudged) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/login");

    const auto run_id =
    start_with_thresholds (/*iterations=*/2, json{ { "latencyP99Ms", 60000 } });
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto summary = summary_of (run_id);
    ASSERT_TRUE (summary.contains ("latency")) << summary.dump ();
    EXPECT_EQ (summary["latency"]["count"].get<size_t> (), 4u);
    const auto& check = summary["thresholds"]["checks"][0];
    ASSERT_EQ (check["metric"].get<std::string> (), "latencyP99Ms");
    EXPECT_DOUBLE_EQ (
    summary["latency"]["p99"].get<double> (), check["actual"].get<double> ());
    EXPECT_LE (summary["latency"]["min"].get<double> (),
    summary["latency"]["avg"].get<double> ());
    EXPECT_LE (summary["latency"]["avg"].get<double> (),
    summary["latency"]["max"].get<double> ());
}

// A run whose only step was refused before the wire has no duration to report:
// `count: 0` and no percentile keys, not a block of zeros.
TEST_F (ScenarioRunnerTest, ARunWithNoSentStepStoresNoLatencyFigures) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", R"(pm.collectionVariables.set("header_name", "");)",
    "", "", "", R"([{"key":"{{header_name}}","value":"acme","enabled":true}])");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto summary = summary_of (run_id);
    ASSERT_TRUE (summary.contains ("latency")) << summary.dump ();
    EXPECT_EQ (summary["latency"], (nlohmann::json{ { "count", 0 } }))
    << summary.dump ();
}

// A run whose config declares no `thresholds` block stores no verdict at all -
// not a verdict of zero checks, on the same absent-not-zeroed rule every other
// optional summary section here follows. Mutation check: comment out the
// `if (inputs.thresholds.has_value ())` guard `build_scenario_summary_payload`
// wraps its `summary["thresholds"] = ...` write in, and this reds.
TEST_F (ScenarioRunnerTest, ACollectionRunWithNoDeclaredBudgetsStoresNoVerdict) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_FALSE (summary_of (run_id).contains ("thresholds"));
}

// The `assert.*` and `pm.test` tally (#1497's metric) works for a collection
// run too: a failing declarative assertion is exactly what
// `maxAssertionFailureRatePct: 0` is declared to catch. Every step's
// assertions run on every send, so the check names them all exact and
// nothing sampled (#2892). Mutation check: put `summary.assertions` into
// `.sampled` in `execute_scenario_run` and the population keys red.
TEST_F (ScenarioRunnerTest, AFailingAssertionFailsTheAssertionFailureRateBudget) {
    seed_collection ("col_1");
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array ({ json{ { "id", "el_assert" }, { "kind", "assert.status" },
    { "config", { { "in", json::array ({ 999 }) } } } } }));

    const auto run_id = start_with_thresholds (
    /*iterations=*/1, json{ { "maxAssertionFailureRatePct", 0 } });
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed)
    << "a missed budget with no failRun still lets the run complete normally";

    const auto thresholds = summary_of (run_id)["thresholds"];
    ASSERT_FALSE (thresholds.is_null ());
    EXPECT_EQ (thresholds["failed"].get<size_t> (), 1u);
    ASSERT_EQ (thresholds["checks"].size (), 1u);
    const auto& check = thresholds["checks"][0];
    EXPECT_EQ (check["metric"].get<std::string> (), "maxAssertionFailureRatePct");
    EXPECT_FALSE (check["passed"].get<bool> ());
    EXPECT_EQ (check.value ("assertionsExact", json ()),
    (json{ { "passed", 0 }, { "failed", 1 } }));
    EXPECT_EQ (check.value ("assertionsSampled", json ()),
    (json{ { "passed", 0 }, { "failed", 0 } }));
    EXPECT_FALSE (check.contains ("sampleRate")) << check.dump ();
}

// #3043: an assertion that cannot run (a row stored before validation refused
// it) keeps its `error` outcome and fails the step, and its failure is in the
// population `maxAssertionFailureRatePct` judges. Mutation check: put the bare
// `outcome_status = "error"` back in `AssertStatusElement::apply` and the step
// reads "passed" with an empty population.
TEST_F (ScenarioRunnerTest, AnAssertionThatCannotRunFailsTheStepAndTheBudget) {
    seed_collection ("col_1");
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array ({ json{ { "id", "el_assert" }, { "kind", "assert.status" },
    { "config", json::object () } } }));

    const auto run_id = start_with_thresholds (
    /*iterations=*/1, json{ { "maxAssertionFailureRatePct", 0 } });
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    const auto trace = json::parse (rows[0].trace_data);
    EXPECT_EQ (trace["outcome"].get<std::string> (), "failed");
    EXPECT_NE (rows[0].error.find ("needs an 'in' list or a 'range'"), std::string::npos)
    << rows[0].error;
    ASSERT_EQ (trace["elements"].size (), 1u);
    EXPECT_EQ (trace["elements"][0]["outcome"], "error");

    const auto summary = summary_of (run_id);
    EXPECT_EQ (summary["scenario"]["failed"].get<size_t> (), 1u);
    const auto& check = summary["thresholds"]["checks"][0];
    EXPECT_FALSE (check["passed"].get<bool> ()) << check.dump ();
    EXPECT_EQ (check.value ("assertionsExact", json ()),
    (json{ { "passed", 0 }, { "failed", 1 } }));
}

// `thresholds.failRun: true` sets a collection run's terminal status to
// Failed on a missed budget, the same terminal-status gate `finish_load_test`
// applies for a load run. Mutation check: revert the `final_status ==
// vayu::RunStatus::Completed && summary.thresholds && ...` gate in
// `execute_scenario_run`, and this reds (the run would stay Completed).
TEST_F (ScenarioRunnerTest, FailRunEndsTheCollectionRunFailedOnAMissedBudget) {
    seed_collection ("col_1");
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array ({ json{ { "id", "el_assert" }, { "kind", "assert.status" },
    { "config", { { "in", json::array ({ 999 }) } } } } }));

    const auto run_id = start_with_thresholds (/*iterations=*/1,
    json{ { "maxAssertionFailureRatePct", 0 }, { "failRun", true } });
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Failed);

    // The run still reports what it measured - `failRun` changes the
    // terminal status, never the verdict it was computed from.
    const auto thresholds = summary_of (run_id)["thresholds"];
    ASSERT_FALSE (thresholds.is_null ());
    EXPECT_EQ (thresholds["failed"].get<size_t> (), 1u);
}

TEST_F (ScenarioRunnerTest, StepEventsCarryTheVerdictOnTheSameTermsAsTheStoredRow) {
    vayu::core::StepRecord record;
    record.iteration  = 0;
    record.step_index = 0;
    record.step_name  = "Pet";
    record.outcome    = StepOutcome::Passed;

    const auto frame_of = [] (const vayu::core::StepRecord& r) {
        const auto payload = vayu::core::build_step_payload (r, 0);
        return json::parse (payload.substr (payload.find ("data: ") + 6));
    };

    // Absent here is absent there: a step of an unbound collection carries no
    // verdict on the wire, so a live view cannot show one the report will not.
    EXPECT_FALSE (frame_of (record).contains ("validation"));

    vayu::core::ValidationVerdict verdict;
    verdict.checked        = true;
    verdict.valid          = false;
    verdict.failures       = { { "/id", "unexpected instance type" } };
    verdict.failures_total = 1;
    verdict.matched_status = "200";
    record.validation      = verdict;

    const auto framed = frame_of (record);
    ASSERT_TRUE (framed.contains ("validation")) << framed.dump ();
    EXPECT_FALSE (framed["validation"]["valid"].get<bool> ());
    EXPECT_EQ (framed["validation"]["failures"][0]["path"].get<std::string> (), "/id");
}

TEST (ScenarioSchemaGate, DefaultsToOffAndOnlyABooleanTrueTurnsItOn) {
    using vayu::core::read_fail_on_schema_error;
    EXPECT_FALSE (read_fail_on_schema_error (json::object ()));
    EXPECT_FALSE (read_fail_on_schema_error (json{ { "failOnSchemaError", false } }));
    EXPECT_TRUE (read_fail_on_schema_error (json{ { "failOnSchemaError", true } }));
}

// `validate_run_config` refuses a non-boolean before the run row exists, so the
// reader only ever sees a boolean, null or nothing - and only `true` turns it on.
TEST (ScenarioStopOnError, DefaultsToOffAndOnlyABooleanTrueTurnsItOn) {
    using vayu::core::read_stop_on_error;
    EXPECT_FALSE (read_stop_on_error (json::object ()));
    EXPECT_FALSE (read_stop_on_error (json{ { "stopOnError", nullptr } }));
    EXPECT_FALSE (read_stop_on_error (json{ { "stopOnError", false } }));
    EXPECT_TRUE (read_stop_on_error (json{ { "stopOnError", true } }));
}

TEST (ScenarioSummaryPayload, SchemaVerdictsAreTheirOwnSectionAndAbsentWhenNothingWasJudged) {
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 2;
    EXPECT_FALSE (vayu::core::build_scenario_summary_payload (inputs).contains (
    "schemaValidation"));

    vayu::core::ValidationVerdict unchecked;
    unchecked.reason = vayu::core::UncheckedReason::NoSchemaForStatus;
    inputs.validation.record (unchecked, "Step one", 500);

    const auto summary = vayu::core::build_scenario_summary_payload (inputs);
    ASSERT_TRUE (summary.contains ("schemaValidation")) << summary.dump ();
    // A run whose every response went unchecked still reports the section: "one
    // response, none of them checked" is what tells a reader to sync a binding,
    // where silence tells them nothing.
    EXPECT_EQ (summary["schemaValidation"]["sampled"].get<size_t> (), 1u);
    EXPECT_EQ (summary["schemaValidation"]["checked"].get<size_t> (), 0u);
    EXPECT_TRUE (summary["schemaValidation"]["exact"].get<bool> ());
    EXPECT_FALSE (summary["scenario"].contains ("schemaValidation"));
}

} // namespace
