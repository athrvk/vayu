/**
 * @file tests/scenario_runner_test.cpp
 * @brief The design-mode sequential runner (issue #353, phase 2 of the
 * collection runner).
 *
 * The contracts pinned here are the ones every later phase stands on:
 *
 *  - **Order.** Every step of every iteration, in plan order, and a terminal
 *    status on every path - including the paths where a step never completes.
 *  - **State between steps.** Variables mutate in memory and are persisted
 *    **once, at run end** (asserted from inside the run, not just after it);
 *    cookies carry through the environment jar.
 *  - **`pm.info.iteration`.** Set by this runner for every step of every pass.
 *    Not by it alone - a load run's sampled response and a send that bound a
 *    row report one too (issues #994 and #601) - so what is pinned here is
 *    this runner's own numbering, not the field's whole surface.
 *  - **Bounded step results.** Failures are kept first, successes are thinned,
 *    and what was thinned is disclosed rather than presented as complete.
 *
 * The runner is driven directly through `RunManager::start_scenario_run`
 * against a real database and an in-process mock server: no HTTP route in
 * front, matching the suite's other run tests.
 *
 * This file holds the order, variable and cookie state between steps, the
 * iteration identity a step's scripts read, and how script and transport errors
 * end an iteration.
 *
 * The `ScenarioRunnerTest` fixture and its mock server are in `scenario_runner_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <cstdint>
#include <set>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "log_capture.hpp"
#include "optional_assert.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"
#include "wait_until.hpp"

#include "scenario_runner_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::tests::scenario_runner::ScenarioRunnerTest;

// ============================================================================
// Sequence semantics
// ============================================================================

// A collection run in design mode is one user walking the sequence, so
// `{{$vu}}` is 1 there and `{{$iteration}}` counts the passes (issue #994).
// Through the real resolver, so the split this depends on is the one plan
// resolution performs rather than one the test arranged.
TEST_F (ScenarioRunnerTest, TheIterationIdentityBindsOnEveryPassOfADesignRun) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok?u={{$vu}}&i={{$iteration}}");

    const auto run_id = start (/*iterations=*/3);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 3u);
    EXPECT_EQ (seen[0].target, "/ok?u=1&i=0");
    EXPECT_EQ (seen[1].target, "/ok?u=1&i=1");
    EXPECT_EQ (seen[2].target, "/ok?u=1&i=2")
    << "the identity must advance with the pass rather than freezing at "
       "composition";
}

// #3340: a Stop that lands while the run is still `pending`, before its worker
// registers, finds no context and writes the row itself. The worker's move to
// Running is refused, so the run ends without a step and the row stays
// `stopped`. Mutation check: ignore the refusal in `execute_scenario_run` and
// the steps reach the mock.
TEST_F (ScenarioRunnerTest, AStopWhilePendingStandsAndTheRunSendsNothing) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    before_worker_ = [this] (const std::string& run_id) {
        const auto [status, body] =
        vayu::http::routes::stop_unregistered_run_response (*db_, manager_, run_id);
        EXPECT_EQ (status, 200);
        EXPECT_EQ (body.value ("status", ""), "stopped") << body.dump ();
    };

    const auto run_id = start (/*iterations=*/3);
    ASSERT_TRUE (vayu::tests::wait_until (
    [&] () { return manager_.get_run (run_id) == nullptr; }))
    << "the refused worker never handed the run back";

    const auto row = db_->get_run (run_id);
    ASSERT_HAS_VALUE (row);
    EXPECT_EQ (row->status, vayu::RunStatus::Stopped);
    EXPECT_TRUE (row->summary.empty ()) << row->summary;
    EXPECT_TRUE (server_->requests ().empty ())
    << "a stopped run sent its steps";
}

// Issue #995 moved the generator family out of plan composition, and a design
// run walks the same plan a load run does - so this is the case where deferring
// and never binding would put the literal `{{$randomUUID}}` on the wire. Three
// passes, three different ids: the deferral and the runner's bind, both.
TEST_F (ScenarioRunnerTest, AGeneratorBindsPerPassOfADesignRunRatherThanFreezing) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok?id={{$randomUUID}}");

    const auto run_id = start (/*iterations=*/3);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 3u);
    std::set<std::string> targets;
    for (const auto& request : seen) {
        EXPECT_NE (request.target, "/ok?id={{$randomUUID}}")
        << "the deferred token reached the wire as it stands - nothing bound "
           "it";
        targets.insert (request.target);
    }
    EXPECT_EQ (targets.size (), seen.size ())
    << "the three passes shared one generated id, which is the freeze this "
       "issue removed";
}

TEST_F (ScenarioRunnerTest, RunsEveryStepOfEveryIterationInPlanOrder) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/3);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 6u);
    for (size_t i = 0; i < seen.size (); i += 2) {
        EXPECT_EQ (seen[i].path, "/ok");
        EXPECT_EQ (seen[i + 1].path, "/login");
    }

    // One results row per step execution, in execution order, each naming the
    // step it belongs to.
    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 6u);
    for (size_t i = 0; i < rows.size (); ++i) {
        auto trace = json::parse (rows[i].trace_data);
        EXPECT_EQ (trace["iteration"].get<size_t> (), i / 2);
        EXPECT_EQ (trace["stepIndex"].get<size_t> (), i % 2);
        EXPECT_EQ (trace["outcome"].get<std::string> (), "passed");
        EXPECT_EQ (trace["requestId"].get<std::string> (), i % 2 == 0 ? "req_a" : "req_b");
    }

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["iterations"].get<size_t> (), 3u);
    EXPECT_EQ (scenario["iterations_completed"].get<size_t> (), 3u);
    EXPECT_EQ (scenario["steps_executed"].get<size_t> (), 6u);
    EXPECT_EQ (scenario["passed"].get<size_t> (), 6u);
    EXPECT_EQ (scenario["steps_dropped"].get<size_t> (), 0u);
}

TEST_F (ScenarioRunnerTest, ADesignRunsSingleResultContractIsUntouched) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/ok");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto run = db_->get_run (run_id);
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->type, vayu::RunType::Scenario);

    // `GET /runs/:id` serves `result` from the first row *only* for a design
    // run, on the assumption that a design run has exactly one. A scenario run
    // has one per step, so it must not be served that way.
    json body = vayu::json::serialize (*run);
    vayu::json::attach_design_result (body, *run, db_->get_results (run_id));
    EXPECT_FALSE (body.contains ("result"));
}

TEST_F (ScenarioRunnerTest, AVariableSetByAStepIsReadableByTheNextAndPersistedOnceAtRunEnd) {
    seed_collection ("col_1");
    seed_environment ("env_1", R"([{"key":"token","value":"initial","enabled":true}])");
    // Step 1 sets the token; step 2 reads it back through `pm.environment.get`
    // and puts it on the wire. A step's `{{token}}` would NOT see it: the plan
    // is composed once, before the first send, so a value a script sets mid-run
    // reaches later steps through the script API rather than through
    // interpolation.
    seed_request ("req_a", 0, "/ok", "", R"(pm.environment.set("token", "from-step-1");)");
    seed_request ("req_b", 1, "/observe",
    R"(pm.request.headers.add({key: "X-Marker", value: pm.environment.get("token")});)");

    // What the database holds *while the run is in flight*. Persisting per step
    // would have written "from-step-1" before step 2 ever sent.
    std::string mid_run_value;
    server_->observer = [&] () {
        if (auto env = db_->get_environment ("env_1")) {
            mid_run_value = env->variables;
        }
    };

    const auto run_id = start (/*iterations=*/1, "env_1");
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[1].marker, "from-step-1");

    EXPECT_NE (mid_run_value.find ("initial"), std::string::npos)
    << "the environment was written before the run ended: " << mid_run_value;
    EXPECT_EQ (mid_run_value.find ("from-step-1"), std::string::npos);

    auto env = db_->get_environment ("env_1");
    ASSERT_HAS_VALUE (env);
    EXPECT_NE (env->variables.find ("from-step-1"), std::string::npos);
}

// The counter shape Postman scripts keep (#2529, the issue's XG run): step 1
// sets 0, step 2 adds 1 to what it reads back, and step 3's `{{xgCount}}` goes
// out as `1`. With the value stringified on set, the read was "0", the sum
// "01", and that went on the wire. The name is not in the environment when the
// plan is composed, so step 3's header is answered by the residual pass after
// its own pre-request script, from the scopes the earlier steps left.
TEST_F (ScenarioRunnerTest, ACounterSetByOneStepIsANumberToTheNextAndOneOnTheWire) {
    seed_collection ("col_1");
    seed_environment ("env_1", "[]");
    seed_request ("req_a", 0, "/ok", "", "pm.environment.set('xgCount', 0);");
    seed_request ("req_b", 1, "/ok", "",
    "pm.environment.set('xgCount', pm.environment.get('xgCount') + 1);");
    seed_request ("req_c", 2,
    "/ok", "pm.test('a number', () => pm.expect(pm.environment.get('xgCount')).to.equal(1));",
    "", "", "", R"([{"key":"X-Marker","value":"{{xgCount}}","enabled":true}])");

    const auto run_id = start (/*iterations=*/1, "env_1");
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 3u);
    EXPECT_EQ (seen[2].marker, "1");
    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["passed"].get<size_t> (), 3u) << scenario.dump ();

    auto env = db_->get_environment ("env_1");
    ASSERT_HAS_VALUE (env);
    const auto stored = vayu::json::parse_variables (env->variables);
    ASSERT_EQ (stored.count ("xgCount"), 1u) << env->variables;
    EXPECT_EQ (stored.at ("xgCount").value, "1");
    EXPECT_EQ (stored.at ("xgCount").type, "string");
}

// The run-local scope (#2564) lives for the whole collection run: step 1's
// `pm.variables.set` answers step 2's `{{localToken}}` through the residual
// pass, the next iteration's step 1 still reads it, and a second run starts
// without it. Nothing reaches the environment.
TEST_F (ScenarioRunnerTest, LocalSetSurvivesStepsOfARunAndEndsWithIt) {
    seed_collection ("col_1");
    seed_environment ("env_1", "[]");
    seed_request ("req_a", 0, "/ok",
    R"(pm.request.headers.add({key: "X-Marker", value: String(pm.variables.get("localToken"))});
       pm.variables.set("localToken", "from-step-1");)");
    seed_request ("req_b", 1, "/ok", "", "", "", "",
    R"([{"key":"X-Marker","value":"{{localToken}}","enabled":true}])");

    const auto first_run = start (/*iterations=*/2, "env_1");
    ASSERT_EQ (await_terminal (first_run), vayu::RunStatus::Completed);
    const auto second_run = start (/*iterations=*/1, "env_1");
    ASSERT_EQ (await_terminal (second_run), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 6u);
    EXPECT_EQ (seen[0].marker, "undefined");
    EXPECT_EQ (seen[1].marker, "from-step-1");
    EXPECT_EQ (seen[2].marker, "from-step-1")
    << "the local did not reach the next iteration";
    EXPECT_EQ (seen[3].marker, "from-step-1");
    EXPECT_EQ (seen[4].marker, "undefined")
    << "the second run inherited the first's local";
    EXPECT_EQ (seen[5].marker, "from-step-1");

    auto env = db_->get_environment ("env_1");
    ASSERT_HAS_VALUE (env);
    EXPECT_EQ (env->variables.find ("localToken"), std::string::npos) << env->variables;
}

// A recursive run of a parent reads each step's own folder (#3248). The
// pre-request script on `req_a` makes the plan defer every step's names to
// the send (#2521), so `req_b`'s `{{f}}` is answered by the residual pass, from
// the folder's variables. Its script reads and writes the folder's scope, as a
// Send of the same request does; the run collection is an ancestor, read
// through. Mutation check: bind every step to the run collection
// (`scopes.bind (asked.collection_id)` in `run_iteration`) and the wire carries
// `{{f}}` and the marker reads `undefined`.
TEST_F (ScenarioRunnerTest, ASubFolderStepSendsAndScriptsWithItsOwnFoldersVariables) {
    seed_collection ("col_1", R"({"shared":{"value":"from-parent","enabled":true}})");
    seed_folder ("fold", "col_1", R"({"f":{"value":"folder-value","enabled":true}})",
    /*order=*/1);
    seed_request ("req_a", 0, "/ok", "pm.variables.set('unused', '1');");
    seed_request ("req_b", 0, "/ok?f={{f}}&s={{shared}}",
    R"(pm.request.headers.add({key: "X-Marker", value: String(pm.collectionVariables.get("f"))});
       pm.collectionVariables.set("written", "by-folder-step");)");
    move_request ("req_b", "fold");

    recursive_        = true;
    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[1].target, "/ok?f=folder-value&s=from-parent");
    EXPECT_EQ (seen[1].marker, "folder-value");

    EXPECT_EQ (stored_collection_variables ("fold").count ("written"), 1u)
    << "the folder step's set did not land on its folder";
    EXPECT_EQ (stored_collection_variables ("col_1").count ("written"), 0u)
    << "the folder step's set landed on the run collection";
}

// What one folder's step writes is what a later step in that folder, and in a
// folder below it, reads; a sibling folder never sees it.
TEST_F (ScenarioRunnerTest, AFolderWriteReachesItsLaterStepsAndItsSubFoldersOnly) {
    seed_collection ("col_1");
    seed_folder ("fold", "col_1", "{}", /*order=*/0);
    seed_folder ("deep", "fold", "{}", /*order=*/1);
    seed_folder ("other", "col_1", "{}", /*order=*/1);
    seed_request ("req_a", 0, "/ok", "pm.collectionVariables.set('token', 'from-fold');");
    move_request ("req_a", "fold");
    seed_request ("req_b", 0, "/ok", "", "", "", "",
    R"([{"key":"X-Marker","value":"{{token}}","enabled":true}])");
    move_request ("req_b", "deep");
    seed_request ("req_c", 0, "/ok",
    R"(pm.request.headers.add({key: "X-Marker", value: String(pm.collectionVariables.get("token"))});)");
    move_request ("req_c", "other");

    recursive_        = true;
    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 3u);
    EXPECT_EQ (seen[1].marker, "from-fold")
    << "the sub-folder did not read its parent's write";
    EXPECT_EQ (seen[2].marker, "undefined")
    << "a sibling folder read another's write";
    EXPECT_EQ (stored_collection_variables ("fold").count ("token"), 1u);
    EXPECT_EQ (stored_collection_variables ("deep").count ("token"), 0u);
}

// A design run reports a name still unresolved when its step went out
// (#3248): distinct names, on the stored row and the live frame alike, absent
// on a step with none. `known` is deferred past the script and answered by the
// residual pass, so it is not one. Mutation check: drop the `unresolvedTokens`
// write in `store_step_record` and the stored half reddens.
TEST_F (ScenarioRunnerTest, AStepSentWithANameNothingAnswersCountsItStoredAndLive) {
    seed_collection ("col_1", R"({"known":{"value":"k","enabled":true}})");
    seed_request ("req_a", 0, "/ok", "pm.variables.set('unused', '1');");
    seed_request ("req_b", 1, "/ok", "", "", "", "",
    R"([{"key":"X-Marker","value":"{{missing}}","enabled":true},
        {"key":"X-Again","value":"{{missing}}","enabled":true},
        {"key":"X-Known","value":"{{known}}","enabled":true},
        {"key":"X-Other","value":"{{gone}}","enabled":true}])");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto unresolved_in = [] (const json& node) {
        return node.contains ("unresolvedTokens") ?
        node["unresolvedTokens"].get<int64_t> () :
        -1;
    };
    std::vector<int64_t> stored;
    for (const auto& row : db_->get_results (run_id)) {
        stored.push_back (unresolved_in (json::parse (row.trace_data)));
    }
    std::vector<int64_t> live;
    for (const auto& frame : step_frames (context_for (run_id))) {
        live.push_back (
        unresolved_in (json::parse (frame.substr (frame.find ("data: ") + 6))));
    }
    EXPECT_EQ (stored, (std::vector<int64_t>{ -1, 2 }));
    EXPECT_EQ (live, (std::vector<int64_t>{ -1, 2 }));
}

TEST_F (ScenarioRunnerTest, ACookieSetByStepOneIsSentByStepTwo) {
    seed_collection ("col_1");
    seed_environment ("env_1", "[]");
    seed_request ("req_a", 0, "/login");
    seed_request ("req_b", 1, "/ok");

    const auto run_id = start (/*iterations=*/1, "env_1");
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_TRUE (seen[0].cookie.empty ());
    EXPECT_NE (seen[1].cookie.find ("sid=session-1"), std::string::npos)
    << "step 2 sent: '" << seen[1].cookie << "'";
}

TEST_F (ScenarioRunnerTest, TheIterationIndexAndCountReachTheStepsScripts) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok",
    R"(pm.request.headers.add({key: "X-Marker",
       value: pm.info.iteration + "/" + pm.info.iterationCount});)");

    const auto run_id = start (/*iterations=*/3);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 3u);
    EXPECT_EQ (seen[0].marker, "0/3");
    EXPECT_EQ (seen[1].marker, "1/3");
    EXPECT_EQ (seen[2].marker, "2/3");
}

// The same agreement, read off one request rather than inferred from two tests
// (issue #1057): the pre-request script renders the identity with `replaceIn`
// into a header, and the URL beside it carries what the bind wrote - so the
// wire holds both answers and they have to match, on every pass. A design run
// is the shape where `{{$iteration}}` advances while `{{$vu}}` does not, so a
// resolver reading the wrong number shows up here and not on a plain Send.
TEST_F (ScenarioRunnerTest, AStepScriptRendersTheIdentityItsOwnRequestWasBoundWith) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok?u={{$vu}}&i={{$iteration}}",
    R"(pm.request.headers.add({key: "X-Marker",
       value: pm.variables.replaceIn("{{$vu}}/{{$iteration}}")});)");

    const auto run_id = start (/*iterations=*/3);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 3u);
    for (size_t pass = 0; pass < seen.size (); ++pass) {
        const std::string i = std::to_string (pass);
        EXPECT_EQ (seen[pass].target, "/ok?u=1&i=" + i);
        EXPECT_EQ (seen[pass].marker, "1/" + i)
        << "the script rendered an identity the request beside it did not "
           "carry";
    }
}

// A collection run in design mode is one user walking the sequence, and its
// scripts must be able to say so: `pm.info.vu` reads `1` here rather than
// `undefined` (issue #994), which is what makes the number a script reads agree
// with the one `{{$vu}}` binds into the request beside it.
TEST_F (ScenarioRunnerTest, TheVirtualUserReachesTheStepsScriptsBesideTheIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok",
    R"(pm.request.headers.add({key: "X-Marker",
       value: (typeof pm.info.vu) + ":" + pm.info.vu + "/" + pm.info.iteration});)");

    const auto run_id = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    // The `typeof` half is the mutation check: drop the plumbing and the
    // marker reads `undefined:undefined/0` rather than failing to compare.
    EXPECT_EQ (seen[0].marker, "number:1/0");
    EXPECT_EQ (seen[1].marker, "number:1/1");
}

// ============================================================================
// Failure paths
// ============================================================================

TEST_F (ScenarioRunnerTest, AFailedAssertionIsNotAnErrorAndTheIterationContinues) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "",
    R"(pm.test("status is 999", function () { pm.expect(pm.response.code).to.equal(999); });)");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_EQ (server_->requests ().size (), 2u)
    << "the failed assertion ended the iteration";

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_EQ (json::parse (rows[0].trace_data)["outcome"].get<std::string> (), "failed");
    EXPECT_NE (rows[0].error.find ("status is 999"), std::string::npos);
    EXPECT_EQ (json::parse (rows[1].trace_data)["outcome"].get<std::string> (), "passed");

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["failed"].get<size_t> (), 1u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 0u);
}

// ============================================================================
// Issue #2526: a script error is a red row, not the end of the iteration.
// ============================================================================

// Postman's default (`stopOnError` unset): a pre-request script that throws
// still sends its request, and the run moves on to the next one. The step is
// still `errored` - the verdict stays honest - but it costs no later step.
// Mutation check: set `end_iteration = true` for every errored step in
// `run_iteration` and this fails on the request count.
TEST_F (ScenarioRunnerTest, AScriptErrorDoesNotEndTheIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/login", R"(throw new Error('x');)");
    seed_request ("req_c", 2, "/observe");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 3u) << "a step after the script error never ran";
    EXPECT_EQ (seen[1].path, "/login")
    << "the errored step's request was not sent";
    EXPECT_EQ (seen[2].path, "/observe");

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 3u);
    const auto errored = json::parse (rows[1].trace_data);
    EXPECT_EQ (errored["outcome"].get<std::string> (), "errored");
    EXPECT_NE (rows[1].error.find ("Pre-request script failed"), std::string::npos)
    << rows[1].error;
    EXPECT_NE (rows[1].error.find ('x'), std::string::npos) << rows[1].error;
    EXPECT_EQ (json::parse (rows[2].trace_data)["outcome"].get<std::string> (), "passed");
    for (const auto& row : rows) {
        EXPECT_FALSE (json::parse (row.trace_data).contains ("stepsNotRun"))
        << "nothing was lost, so no row may claim it was";
    }

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["steps_executed"].get<size_t> (), 3u);
    EXPECT_EQ (scenario["passed"].get<size_t> (), 2u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 1u);
    EXPECT_EQ (scenario["steps_not_run"].get<size_t> (), 0u);
    EXPECT_FALSE (scenario["stop_on_error"].get<bool> ());
}

// The same rule for the test script: the response arrived, so the next step
// has what it needs, and only the script's verdict is lost.
TEST_F (ScenarioRunnerTest, ATestScriptErrorDoesNotEndTheIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/login", "", R"(throw new Error('x');)");
    seed_request ("req_c", 2, "/observe");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    ASSERT_EQ (server_->requests ().size (), 3u);
    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 3u);
    EXPECT_EQ (json::parse (rows[1].trace_data)["outcome"].get<std::string> (), "errored");
    EXPECT_NE (rows[1].error.find ("Test script failed"), std::string::npos)
    << rows[1].error;
    EXPECT_EQ (json::parse (rows[2].trace_data)["outcome"].get<std::string> (), "passed");
    EXPECT_EQ (summary_of (run_id)["scenario"]["steps_not_run"].get<size_t> (), 0u);
}

// ============================================================================
// Issue #2522: every level's scripts run and every level is reported.
// ============================================================================

json script_element (const std::string& kind, const std::string& id, const std::string& text) {
    return { { "id", id }, { "kind", kind }, { "enabled", true },
        { "config", { { "script", text } } } };
}

// A `script.teardown` runs after the last step, so the run's one write-back
// has to come after it (#3249). Mutation check: move `scopes.persist (db)` in
// `execute_scenario_run` back above `run_scenario_teardown` and neither
// teardown variable is stored.
TEST_F (ScenarioRunnerTest, ATeardownScriptsVariableWritesArePersisted) {
    seed_collection_with_elements ("col_1", "",
    json::array ({ script_element ("script.teardown", "el_teardown",
    "pm.environment.set('teardown_var', 'x');"
    "pm.globals.set('teardown_global', 'y');") }));
    seed_environment ("env_1", "[]");
    db_->save_globals ({ "globals", "[]", 1 });
    seed_request ("req_a", 0, "/ok");

    const auto run_id = start (/*iterations=*/1, "env_1");
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto env = db_->get_environment ("env_1");
    ASSERT_HAS_VALUE (env);
    const auto env_vars = vayu::json::parse_variables (env->variables);
    ASSERT_EQ (env_vars.count ("teardown_var"), 1u) << env->variables;
    EXPECT_EQ (env_vars.at ("teardown_var").value, "x");

    auto globals = db_->get_globals ();
    ASSERT_HAS_VALUE (globals);
    const auto global_vars = vayu::json::parse_variables (globals->variables);
    ASSERT_EQ (global_vars.count ("teardown_global"), 1u) << globals->variables;
    EXPECT_EQ (global_vars.at ("teardown_global").value, "y");
}

// A workspace whose globals were never saved has no globals row, and the run's
// one write-back has to create it rather than discard what a step set (#3453).
// Mutation check: return nothing for an absent globals row in
// `persist_script_variables` and `get_globals` stays empty.
TEST_F (ScenarioRunnerTest, AGlobalSetOnAWorkspaceWithNoGlobalsRowIsPersisted) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "pm.globals.set('fresh_global', 'y');");
    ASSERT_FALSE (db_->get_globals ().has_value ());

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto globals = db_->get_globals ();
    ASSERT_HAS_VALUE (globals);
    const auto global_vars = vayu::json::parse_variables (globals->variables);
    ASSERT_EQ (global_vars.count ("fresh_global"), 1u) << globals->variables;
    EXPECT_EQ (global_vars.at ("fresh_global").value, "y");
}

// Probe XA: the collection's failing test used to be overwritten by the
// request's passing one, and the step passed. Mutation check: assign instead
// of folding in `script_kinds.cpp`'s `run_step_script` and the step passes.
TEST_F (ScenarioRunnerTest, ACollectionLevelFailingTestFailsTheStep) {
    seed_collection_with_elements ("col_1", "",
    json::array ({ script_element ("script.post", "el_col",
    "pm.test('collection must fail', () => pm.expect(1).to.eql(2));") }));
    seed_request ("req_a", 0, "/ok", "",
    "pm.test('request passes', () => pm.expect(1).to.eql(1));");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    const auto trace = json::parse (rows[0].trace_data);
    EXPECT_EQ (trace["outcome"].get<std::string> (), "failed");
    EXPECT_NE (rows[0].error.find ("collection must fail"), std::string::npos)
    << rows[0].error;

    const auto& tests = trace["scripts"]["testResults"];
    ASSERT_EQ (tests.size (), 2u) << trace["scripts"].dump ();
    EXPECT_EQ (tests[0]["name"], "collection must fail");
    EXPECT_EQ (tests[0]["scope"], "collection");
    EXPECT_EQ (tests[1]["name"], "request passes");
    EXPECT_EQ (tests[1]["scope"], "request");
}

// Probe XB: a throwing collection pre-request left the step passed once the
// request's own pre-request succeeded.
TEST_F (ScenarioRunnerTest, ACollectionLevelThrowErrorsTheStepNamingTheLevel) {
    seed_collection_with_elements ("col_1", "",
    json::array ({ script_element (
    "script.pre", "el_col", "throw new Error('XB COLLECTION PRE THROWS');") }));
    seed_request ("req_a", 0, "/ok", "console.log('request pre ran');");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    const auto trace = json::parse (rows[0].trace_data);
    EXPECT_EQ (trace["outcome"].get<std::string> (), "errored");
    EXPECT_EQ (rows[0].error.rfind ("Collection pre-request script failed - ", 0), 0u)
    << rows[0].error;
    EXPECT_NE (rows[0].error.find ("XB COLLECTION PRE THROWS"), std::string::npos);
    EXPECT_EQ (trace["scripts"].value ("preScriptError", ""), rows[0].error);
}

// A step's trace carries its scripts' `pm.sendRequest` records, each naming
// its level and phase, and the summary lines index them (#3633). Mutation
// check: leave `record_script_requests` out of `execute_scenario_run` and the
// trace has no list.
TEST_F (ScenarioRunnerTest, AStepsTraceCarriesItsScriptRequests) {
    allow_script_requests_ = true;
    seed_collection_with_elements ("col_1", "",
    json::array ({ script_element ("script.pre", "el_col",
    "pm.sendRequest('" + server_->url ("/token") + "', function () {});") }));
    seed_request ("req_a", 0, "/ok", "",
    "pm.sendRequest('" + server_->url ("/token") + "?again=1', function () {});");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 1u);
    const auto& scripts = traces[0]["scripts"];
    ASSERT_TRUE (scripts.contains ("scriptRequests")) << scripts.dump ();
    const auto& records = scripts["scriptRequests"];
    ASSERT_EQ (records.size (), 2u) << records.dump ();
    EXPECT_EQ (records[0]["source"], "pre");
    EXPECT_EQ (records[0]["scope"], "collection");
    EXPECT_EQ (records[0]["status"], 200);
    EXPECT_EQ (records[1]["source"], "test");
    EXPECT_EQ (records[1]["scope"], "request");
    EXPECT_NE (
    records[1]["request"]["url"].get<std::string> ().find ("again=1"), std::string::npos);
    ASSERT_EQ (scripts["consoleLogs"].size (), 2u) << scripts.dump ();
    EXPECT_EQ (scripts["consoleLogs"][0]["scriptRequest"], 0);
    EXPECT_EQ (scripts["consoleLogs"][1]["scriptRequest"], 1);
}

// A step's trace carries the time its scripts took, `pm.sendRequest` included
// (#3676), flat beside `engineMs`'s design-mode sibling keys; a scriptless step
// stores a figure too, because "ran no script" is a reading. The pre-request
// script spins and the test script waits on the mock's `/slow` (at least
// 120ms), so the sum has a floor no runner can undercut; no upper bound is
// asserted. Mutation checks: stop accumulating `script_ms` in
// `execute_exchange` and the scripted step reads 0; drop the `scriptMs` write
// in `store_step_record` and both steps lose the key.
TEST_F (ScenarioRunnerTest, AStepsTraceCarriesTheTimeItsScriptsTook) {
    constexpr int PRE_SPIN_MS        = 150;
    constexpr int SLOW_ROUTE_MS      = 120;
    constexpr double SCRIPT_FLOOR_MS = (PRE_SPIN_MS + SLOW_ROUTE_MS) * 0.9;
    allow_script_requests_           = true;
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok",
    "var t0 = Date.now(); while (Date.now() - t0 < " + std::to_string (PRE_SPIN_MS) + ") {}",
    "pm.sendRequest('" + server_->url ("/slow") + "', function () {});");
    seed_request ("req_b", 1, "/ok");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 2u);
    ASSERT_TRUE (traces[0].contains ("scriptMs")) << traces[0].dump (2);
    EXPECT_GE (traces[0]["scriptMs"].get<double> (), SCRIPT_FLOOR_MS);
    ASSERT_TRUE (traces[1].contains ("scriptMs")) << traces[1].dump (2);
    ASSERT_TRUE (traces[1]["scriptMs"].is_number ()) << traces[1].dump (2);
    EXPECT_GE (traces[1]["scriptMs"].get<double> (), 0.0);
}

// A folder sits between the collection and the request: its results carry
// `folder`, and a throw there is named as the folder's.
TEST_F (ScenarioRunnerTest, AFolderLevelScriptIsReportedAsTheFolders) {
    seed_collection_with_elements ("root_1", "",
    json::array ({ script_element ("script.post", "el_root",
    "pm.test('collection passes', () => pm.expect(1).to.eql(1));") }));
    seed_collection_with_elements ("col_1", "root_1",
    json::array ({ script_element ("script.post", "el_folder",
    "pm.test('folder passes', () => pm.expect(1).to.eql(1)); throw new "
    "Error('folder threw');") }));
    seed_request ("req_a", 0, "/ok");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    const auto trace = json::parse (rows[0].trace_data);
    EXPECT_EQ (trace["outcome"].get<std::string> (), "errored");
    EXPECT_EQ (rows[0].error.rfind ("Folder test script failed - ", 0), 0u)
    << rows[0].error;

    const auto& tests = trace["scripts"]["testResults"];
    ASSERT_EQ (tests.size (), 2u) << trace["scripts"].dump ();
    EXPECT_EQ (tests[0]["scope"], "collection");
    EXPECT_EQ (tests[1]["name"], "folder passes");
    EXPECT_EQ (tests[1]["scope"], "folder");
}

// The commonest Postman shape that throws: an assertion written at the top
// level rather than inside `pm.test`, on a response it does not describe.
TEST_F (ScenarioRunnerTest, ATopLevelFailingStatusAssertionDoesNotEndTheIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/login", "", R"(pm.response.to.have.status(500);)");
    seed_request ("req_c", 2, "/observe");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    ASSERT_EQ (server_->requests ().size (), 3u);
    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 3u);
    EXPECT_EQ (json::parse (rows[1].trace_data)["outcome"].get<std::string> (), "errored");
    EXPECT_EQ (json::parse (rows[2].trace_data)["outcome"].get<std::string> (), "passed");
}

// `stopOnError: true` restores the rule a collection run had before #2526, and
// the step that ended the iteration says what that cost.
// Mutation check: drop the `read_stop_on_error` read (leave `stop_on_error`
// false) and this fails on the request count.
TEST_F (ScenarioRunnerTest, StopOnErrorEndsTheIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/login", R"(throw new Error('x');)");
    seed_request ("req_c", 2, "/observe");

    const auto run_id = start_stopping_on_error (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    // The errored step's own request still went out - a pre-request error
    // never stopped the send - but nothing after it did.
    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[1].path, "/login");

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_FALSE (json::parse (rows[0].trace_data).contains ("stepsNotRun"));
    const auto ended = json::parse (rows[1].trace_data);
    EXPECT_EQ (ended["outcome"].get<std::string> (), "errored");
    ASSERT_TRUE (ended.contains ("stepsNotRun")) << ended.dump ();
    EXPECT_EQ (ended["stepsNotRun"].get<size_t> (), 1u);

    // The live frame says the same as the stored row.
    auto frames = step_frames (context_for (run_id));
    ASSERT_EQ (frames.size (), 2u);
    EXPECT_EQ (frames[0].find ("stepsNotRun"), std::string::npos) << frames[0];
    EXPECT_NE (frames[1].find (R"("stepsNotRun":1)"), std::string::npos) << frames[1];

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["steps_not_run"].get<size_t> (), 1u);
    EXPECT_TRUE (scenario["stop_on_error"].get<bool> ());
    EXPECT_EQ (scenario["iterations_completed"].get<size_t> (), 1u);
}

// Issue #2359: the line that says where an iteration ended carries the step's
// error as a bounded field, because that error can hold what a script threw.
// The stored row keeps the whole text.
// Mutation check: put `record.error` back into the message in
// `run_iteration` (scenario_runner.cpp) and this reddens.
TEST_F (ScenarioRunnerTest, AnIterationEndedByAScriptErrorLogsItsTextAsABoundedField) {
    const vayu::tests::LogCapture log;
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/login",
    vayu::tests::script_throwing (vayu::tests::thrown_text (0)));
    seed_request ("req_c", 2, "/observe");

    const auto run_id = start_stopping_on_error (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_NE (rows[1].error.find (vayu::tests::SCRIPT_TAIL), std::string::npos)
    << "the stored error must stay whole";

    const auto records = log.with_msg_prefix ("Scenario run: iteration");
    ASSERT_EQ (records.size (), 1u);
    EXPECT_EQ (records[0].at ("msg").get<std::string> (),
    "Scenario run: iteration 0 ended at step 'Step req_b'");
    EXPECT_EQ (records[0].at ("runId").get<std::string> (), run_id);
    vayu::tests::expect_script_text_only_bounded_in (records[0], "stepError");
}

// Postman's default for a step that got no response too (the owner decision on
// #2526): the failed step is recorded and the steps after it still run.
// Mutation check: set `end_iteration = true` for every errored step in
// `run_iteration` and this fails on the request count.
TEST_F (ScenarioRunnerTest, ATransportErrorContinuesTheIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    // Nothing listens on port 1; the send fails to connect rather than hanging.
    seed_request ("req_dead", 1, "", "", "", "http://127.0.0.1:1/never");
    seed_request ("req_c", 2, "/login");

    const auto run_id = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 4u);
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/login");

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 6u);
    const auto errored = json::parse (rows[1].trace_data);
    EXPECT_EQ (errored["outcome"].get<std::string> (), "errored");
    EXPECT_FALSE (errored.contains ("stepsNotRun")) << errored.dump ();
    EXPECT_EQ (json::parse (rows[2].trace_data)["outcome"].get<std::string> (), "passed");

    EXPECT_EQ (summary_of (run_id)["scenario"]["steps_not_run"].get<size_t> (), 0u);
}

// `stopOnError` ends the iteration at a transport failure as it does at a
// script error.
// Mutation check: ignore `stop_on_error` for an errored step and this fails on
// the request count.
TEST_F (ScenarioRunnerTest, StopOnErrorEndsTheIterationAtATransportError) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_dead", 1, "", "", "", "http://127.0.0.1:1/never");
    seed_request ("req_c", 2, "/login");

    const auto run_id = start_stopping_on_error (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/ok");

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 4u);
    const auto ended = json::parse (rows[1].trace_data);
    EXPECT_EQ (ended["outcome"].get<std::string> (), "errored");
    EXPECT_EQ (ended.value ("stepsNotRun", size_t{ 0 }), 1u) << ended.dump ();

    // One position lost per iteration, summed.
    EXPECT_EQ (summary_of (run_id)["scenario"]["steps_not_run"].get<size_t> (), 2u);
}

// `stepsNotRun` counts what an error cost, not every early end: a stop form and
// a forward jump are a script's decision.
TEST_F (ScenarioRunnerTest, StepsNotRunCountsOnlyAnErrorEnd) {
    seed_collection ("col_1");
    // Iteration 0 jumps over step 2; iteration 1 stops after step 1.
    seed_request ("req_a", 0, "/ok", "", R"(
        if (pm.info.iteration === 0) {
            pm.execution.setNextRequest("Last");
        } else {
            pm.execution.setNextRequest(null);
        }
    )");
    seed_request ("req_b", 1, "/login");
    seed_request ("req_c", 2, "/observe", "", "", "", "Last");

    const auto run_id = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 3u);
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/observe");
    EXPECT_EQ (seen[2].path, "/ok");

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["steps_not_run"].get<size_t> (), 0u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 0u);
}

// A position a forward jump passed over before the error is the script's
// decision too: only the positions after the step that errored are counted.
// Mutation check: count every unattempted position instead and this reads 2.
TEST_F (ScenarioRunnerTest, AnErrorAfterAForwardJumpCountsOnlyThePositionsAfterIt) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(pm.execution.setNextRequest("Dead");)");
    seed_request ("req_b", 1, "/login");
    seed_request ("req_dead", 2, "", "", "", "http://127.0.0.1:1/never", "Dead");
    seed_request ("req_d", 3, "/observe");

    const auto run_id = start_stopping_on_error (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_EQ (json::parse (rows[1].trace_data).value ("stepsNotRun", size_t{ 0 }), 1u);
    EXPECT_EQ (summary_of (run_id)["scenario"]["steps_not_run"].get<size_t> (), 1u);
}

// A redirect from a script that then threw came from code that did not finish,
// so the iteration walks to the next plan position instead - for a jump and for
// the stop form alike.
TEST_F (ScenarioRunnerTest, AnErroredStepsSetNextRequestIsIgnored) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(
        pm.execution.setNextRequest("Last");
        throw new Error('after the jump');
    )");
    seed_request ("req_b", 1, "/login", "", R"(
        pm.execution.setNextRequest(null);
        throw new Error('after the stop');
    )");
    seed_request ("req_c", 2, "/observe", "", "", "", "Last");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 3u);
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/login")
    << "the errored step's jump was honoured";
    EXPECT_EQ (seen[2].path, "/observe")
    << "the errored step's stop was honoured";

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 3u);
    EXPECT_EQ (json::parse (rows[0].trace_data)["outcome"].get<std::string> (), "errored");
    EXPECT_EQ (json::parse (rows[1].trace_data)["outcome"].get<std::string> (), "errored");
    EXPECT_EQ (json::parse (rows[2].trace_data)["outcome"].get<std::string> (), "passed");
}

// ============================================================================
// Issue #1514: the element pipeline's phase-0 kinds, no script anywhere.
// ============================================================================

// The acceptance criterion: a login-then-call collection with no script sends
// a real bearer token on step 2, and the report carries both steps' element
// outcomes.
TEST_F (ScenarioRunnerTest, ExtractJsonFeedsTheNextStepsBearerToken) {
    seed_collection ("col_1");
    seed_request_with_elements ("req_a", 0, "/token",
    json::array ({ json{ { "id", "el_extract" }, { "kind", "extract.json" },
    { "config", { { "path", "$.token" }, { "variable", "token" }, { "scope", "collection" } } } } }));
    seed_request ("req_b", 1, "/echo-auth", "", "", "", "", // pre/post/url/name
    R"([{"key":"Authorization","value":"Bearer {{token}}","enabled":true}])");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[1].authorization, "Bearer secret-abc")
    << "step 2 must carry the real token step 1 extracted, not a literal "
       "{{token}}";

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    for (const auto& row : rows) {
        EXPECT_EQ (json::parse (row.trace_data)["outcome"].get<std::string> (), "passed");
    }
    const auto step1_elements = json::parse (rows[0].trace_data)["elements"];
    ASSERT_EQ (step1_elements.size (), 1u);
    EXPECT_EQ (step1_elements[0]["kind"], "extract.json");
    EXPECT_EQ (step1_elements[0]["outcome"], "ok");
    EXPECT_FALSE (step1_elements[0].contains ("wrote"));
}

// A declarative assertion fails a step exactly as a scripted one does - same
// classification, same iteration-continues rule - without any script at all.
TEST_F (ScenarioRunnerTest, AFailingAssertStatusElementFailsTheStepWithoutAnyScript) {
    seed_collection ("col_1");
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array ({ json{ { "id", "el_assert" }, { "kind", "assert.status" },
    { "config", { { "in", json::array ({ 999 }) } } } } }));
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_EQ (server_->requests ().size (), 2u)
    << "a failed assertion is not an error - the iteration continues";

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    const auto trace0 = json::parse (rows[0].trace_data);
    EXPECT_EQ (trace0["outcome"].get<std::string> (), "failed");
    EXPECT_NE (rows[0].error.find ("Status code"), std::string::npos) << rows[0].error;
    ASSERT_EQ (trace0["elements"].size (), 1u);
    EXPECT_EQ (trace0["elements"][0]["outcome"], "failed");
    EXPECT_EQ (json::parse (rows[1].trace_data)["outcome"].get<std::string> (), "passed");

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["failed"].get<size_t> (), 1u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 0u);
}

// A 200 whose body is not JSON fails the step through `assert.jsonpath` and a
// `required` `extract.json`, and leaves an optional extractor `skipped` (#3041).
// Mutation check: restore the `skipped` branch in `AssertJsonPathElement` and
// the first row reads "passed".
TEST_F (ScenarioRunnerTest, AnUnreadableBodyFailsJsonAssertionsAndRequiredExtractors) {
    seed_collection ("col_1");
    seed_request_with_elements ("req_a", 0, "/html",
    json::array ({ json{ { "id", "el_assert" }, { "kind", "assert.jsonpath" },
    { "config", { { "path", "$.ok" }, { "exists", true } } } } }));
    seed_request_with_elements ("req_b", 1, "/html",
    json::array ({ json{ { "id", "el_extract" }, { "kind", "extract.json" },
    { "config", { { "path", "$.token" }, { "variable", "token" }, { "required", true } } } } }));
    seed_request_with_elements ("req_c", 2, "/html",
    json::array ({ json{ { "id", "el_extract" }, { "kind", "extract.json" },
    { "config", { { "path", "$.token" }, { "variable", "token" } } } } }));

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 3u);
    for (const size_t failing : { size_t{ 0 }, size_t{ 1 } }) {
        const auto trace = json::parse (rows[failing].trace_data);
        EXPECT_EQ (trace["outcome"].get<std::string> (), "failed") << failing;
        EXPECT_NE (rows[failing].error.find ("exceeds maxElementBodyBytes"), std::string::npos)
        << rows[failing].error;
    }
    const auto optional_trace = json::parse (rows[2].trace_data);
    EXPECT_EQ (optional_trace["outcome"].get<std::string> (), "passed");
    ASSERT_EQ (optional_trace["elements"].size (), 1u);
    EXPECT_EQ (optional_trace["elements"][0]["outcome"], "skipped");

    EXPECT_EQ (summary_of (run_id)["scenario"]["failed"].get<size_t> (), 2u);
}

} // namespace
