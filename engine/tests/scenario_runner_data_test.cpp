/**
 * @file tests/scenario_runner_data_test.cpp
 * @brief Design-mode sequential runner: the assertions a step's scripts made, and the data
 * rows, credentials and tokens bound per iteration.
 *
 * The `ScenarioRunnerTest` fixture and its mock server are in `scenario_runner_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include "basic_auth_pair.hpp"
#include "mcp_fixture_server.hpp"
#include "oauth_token_server.hpp"
#include "optional_assert.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/utils/encoding.hpp"

#include "scenario_runner_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::tests::scenario_runner::ScenarioRunnerTest;
using vayu::tests::scenario_runner::SeenRequest;

// ============================================================================
// Per-step script results (issue #724)
// ============================================================================
//
// The runner always ran both scripts and always knew what every assertion came
// to - it spent that on one summary error line and dropped the rest, so a
// step's detail could not show the list the same request's single Send shows.
// Both halves of the delivery are pinned here: the itemized list on the stored
// row, which is the only route a collection run's results ever take, and the
// constant-size tally on the frame a live watcher reads.

TEST_F (ScenarioRunnerTest, EveryStepStoresTheAssertionsItsTestScriptMade) {
    seed_collection ("col_1");
    // One step whose assertions all hold, one with a failure among them: a
    // passing step showing no evidence its assertions ran at all is half of
    // what this fixes, and it is the half a failure-only test would miss.
    seed_request ("req_pass", 0, "/ok", "", R"(
        pm.test("status is 200", function () {
            pm.expect(pm.response.code).to.equal(200);
        });
        console.log("asserted the status");
    )");
    seed_request ("req_mixed", 1, "/ok", "", R"(
        pm.test("status is 200", function () {
            pm.expect(pm.response.code).to.equal(200);
        });
        pm.test("body names a pet", function () {
            pm.expect(pm.response.json().name).to.equal("Rex");
        });
    )");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);

    const auto passed_trace = json::parse (rows[0].trace_data);
    ASSERT_TRUE (passed_trace.contains ("scripts")) << rows[0].trace_data;
    const auto& passed_tests = passed_trace["scripts"]["testResults"];
    ASSERT_EQ (passed_tests.size (), 1u) << passed_trace["scripts"].dump ();
    EXPECT_EQ (passed_tests[0]["name"].get<std::string> (), "status is 200");
    EXPECT_TRUE (passed_tests[0]["passed"].get<bool> ());
    // The whole node, not the assertions alone - it is the one `restore-
    // response.ts` reads, and a step that logged is a step whose console has
    // something to show.
    ASSERT_TRUE (passed_trace["scripts"].contains ("consoleLogs"));
    EXPECT_EQ (
    passed_trace["scripts"]["consoleLogs"][0]["source"].get<std::string> (), "test");

    const auto mixed_trace = json::parse (rows[1].trace_data);
    ASSERT_TRUE (mixed_trace.contains ("scripts")) << rows[1].trace_data;
    const auto& mixed_tests = mixed_trace["scripts"]["testResults"];
    ASSERT_EQ (mixed_tests.size (), 2u) << mixed_trace["scripts"].dump ();
    EXPECT_TRUE (mixed_tests[0]["passed"].get<bool> ());
    EXPECT_FALSE (mixed_tests[1]["passed"].get<bool> ());
    EXPECT_EQ (mixed_tests[1]["name"].get<std::string> (), "body names a pet");
    EXPECT_FALSE (mixed_tests[1]["error"].get<std::string> ().empty ());
    // The summary line is unchanged and still names the first failure - the
    // list is what it was always a summary *of*, not a replacement for it.
    EXPECT_EQ (mixed_trace["outcome"].get<std::string> (), "failed");
    EXPECT_NE (rows[1].error.find ("body names a pet"), std::string::npos)
    << rows[1].error;
}

TEST_F (ScenarioRunnerTest, AStepWhoseScriptsSaidNothingStoresNoNodeAtAll) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    // An empty node would put a Tests pane's worth of nothing on every step of
    // every scriptless run, which is the state the pane reads as "no results".
    EXPECT_FALSE (json::parse (rows[0].trace_data).contains ("scripts"))
    << rows[0].trace_data;
}

TEST_F (ScenarioRunnerTest, StepFramesCarryTheTallyOnTheSameTermsAsTheStoredList) {
    seed_collection ("col_1");
    seed_request ("req_tested", 0, "/ok", "", R"(
        pm.test("status is 200", function () {
            pm.expect(pm.response.code).to.equal(200);
        });
        pm.test("body names a pet", function () {
            pm.expect(pm.response.json().name).to.equal("Rex");
        });
    )");
    seed_request ("req_bare", 1, "/ok");

    const auto run_id  = start (/*iterations=*/1);
    const auto context = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto steps = step_frames (context);
    ASSERT_EQ (steps.size (), 2u);
    const auto frame_of = [] (const std::string& payload) {
        const auto data_at = payload.find ("data: ");
        EXPECT_NE (data_at, std::string::npos) << payload;
        return json::parse (payload.substr (data_at + 6));
    };

    // Two numbers, not the list: a step is free to make hundreds of assertions
    // and the tick ring is the fixed-size buffer every watcher replays from.
    const auto tested = frame_of (steps[0]);
    ASSERT_TRUE (tested.contains ("tests")) << steps[0];
    EXPECT_EQ (tested["tests"]["passed"].get<size_t> (), 1u);
    EXPECT_EQ (tested["tests"]["failed"].get<size_t> (), 1u);
    EXPECT_FALSE (tested["tests"].contains ("testResults")) << tested.dump ();

    // Absent here is absent there: a step that asserted nothing sends no node,
    // so a live view cannot show a `0/0` the stored row will not back up.
    EXPECT_FALSE (frame_of (steps[1]).contains ("tests")) << steps[1];
}

// A pre-request assertion is the step's, on every surface that speaks about the
// step (issue #810). It already decided the outcome - `describe_failed_tests`
// has always walked both scripts - while the stored list and the live tally
// counted the test script alone, so a step could be `failed` by an assertion
// its own Tests list and its own numbers did not contain.
TEST_F (ScenarioRunnerTest, APreRequestAssertionIsListedCountedAndNamedTogether) {
    seed_collection ("col_1");
    // Both verdicts in the pre-request script: a failure alone would not show
    // that a passing pre-request assertion is evidence the check ran, which is
    // the half a step with no failures has nothing else to say.
    seed_request ("req_pre", 0, "/ok", R"(
        pm.test("fixture is present", function () {
            pm.expect(1).to.equal(1);
        });
        pm.test("token was issued", function () {
            pm.expect("none").to.equal("issued");
        });
    )",
    R"(
        pm.test("status is 200", function () {
            pm.expect(pm.response.code).to.equal(200);
        });
    )");

    const auto run_id  = start (/*iterations=*/1);
    const auto context = context_for (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    const auto trace = json::parse (rows[0].trace_data);
    ASSERT_TRUE (trace.contains ("scripts")) << rows[0].trace_data;
    const auto& tests = trace["scripts"]["testResults"];
    ASSERT_EQ (tests.size (), 3u) << trace["scripts"].dump ();

    // In execution order, each naming the script that made it - "asserted
    // before the request went out" is a different claim from one about the
    // response, and the list is where a reader tells them apart.
    EXPECT_EQ (tests[0]["name"].get<std::string> (), "fixture is present");
    EXPECT_EQ (tests[0]["source"].get<std::string> (), "pre");
    EXPECT_TRUE (tests[0]["passed"].get<bool> ());
    EXPECT_EQ (tests[1]["name"].get<std::string> (), "token was issued");
    EXPECT_EQ (tests[1]["source"].get<std::string> (), "pre");
    EXPECT_FALSE (tests[1]["passed"].get<bool> ());
    EXPECT_EQ (tests[2]["name"].get<std::string> (), "status is 200");
    EXPECT_EQ (tests[2]["source"].get<std::string> (), "test");

    // The step the list sits beside: failed, named by the assertion that
    // failed it - the outcome this list could not account for before.
    EXPECT_EQ (trace["outcome"].get<std::string> (), "failed");
    EXPECT_NE (rows[0].error.find ("token was issued"), std::string::npos)
    << rows[0].error;

    // And the live half counts what the stored list holds, so a run being
    // watched does not renumber itself when its rows arrive.
    const auto steps = step_frames (context);
    ASSERT_EQ (steps.size (), 1u);
    const auto data_at = steps[0].find ("data: ");
    ASSERT_NE (data_at, std::string::npos) << steps[0];
    const auto frame = json::parse (steps[0].substr (data_at + 6));
    ASSERT_TRUE (frame.contains ("tests")) << steps[0];
    EXPECT_EQ (frame["tests"]["passed"].get<size_t> (), 2u);
    EXPECT_EQ (frame["tests"]["failed"].get<size_t> (), 1u);
}

// ============================================================================
// Data-driven iterations - pm.iterationData (issue #356, phase 5)
// ============================================================================
//
// The binding itself is pinned in script_engine_execution_test.cpp; what these pin is
// the wiring only a run can show: which row an iteration binds, how many
// iterations a data set implies, and that the record says which row produced
// it. The marker header is the proof the row reached the *wire* rather than
// only the script - a row that binds but changes nothing sent is decorative.

TEST_F (ScenarioRunnerTest, IterationsDefaultToTheRowCountAndEachBindsItsRow) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok",
    R"(pm.request.headers.add({key: "X-Marker", value: pm.iterationData.get("marker")});)");

    const auto run_id = start_with_data (json::array ({ { { "marker", "row-0" } },
    { { "marker", "row-1" } }, { { "marker", "row-2" } } }));
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    // Three rows, no `iterations` on the payload: three passes, and row `i`
    // reached the server on iteration `i`.
    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 3u);
    EXPECT_EQ (seen[0].marker, "row-0");
    EXPECT_EQ (seen[1].marker, "row-1");
    EXPECT_EQ (seen[2].marker, "row-2");

    EXPECT_EQ (summary_of (run_id)["scenario"]["iterations"].get<size_t> (), 3u);
}

TEST_F (ScenarioRunnerTest, AnExplicitIterationCountWrapsTheRowIndex) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok",
    R"(pm.request.headers.add({key: "X-Marker", value: pm.iterationData.get("marker")});)");

    const auto run_id = start_with_data (
    json::array ({ { { "marker", "row-0" } }, { { "marker", "row-1" } } }),
    /*iterations=*/5);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    // The explicit count wins over the row count and the index wraps: five
    // iterations over two rows is 0,1,0,1,0.
    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 5u);
    const std::vector<std::string> expected{ "row-0", "row-1", "row-0", "row-1", "row-0" };
    for (size_t i = 0; i < seen.size (); ++i) {
        EXPECT_EQ (seen[i].marker, expected[i]) << "iteration " << i;
    }

    // And the wrap is not silent: every stored record names the row it used,
    // which is the only way a reader can tell iteration 2 from iteration 0.
    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 5u);
    for (size_t i = 0; i < rows.size (); ++i) {
        auto trace = json::parse (rows[i].trace_data);
        ASSERT_TRUE (trace.contains ("dataRowIndex")) << "iteration " << i;
        EXPECT_EQ (trace["dataRowIndex"].get<size_t> (), i % 2) << "iteration " << i;
    }
}

// A run with no data set must not stamp `dataRowIndex: 0`, which would read in
// the step list as "row 1 of a data file" for a run that had none.
TEST_F (ScenarioRunnerTest, ARunWithoutDataStampsNoRowIndexAndBindsNothing) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok",
    R"(pm.request.headers.add({key: "X-Marker", value: typeof pm.iterationData});)");

    const auto run_id = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    // Inside a collection run, and still undefined: `in_scenario` is not what
    // binds a row - having one is.
    EXPECT_EQ (seen[0].marker, "undefined");

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    for (const auto& row : rows) {
        EXPECT_FALSE (json::parse (row.trace_data).contains ("dataRowIndex"));
    }
}

// ============================================================================
// `{{data.column}}` - the row reaching the request itself (issue #402)
// ============================================================================

/// Which request field carries a `{{data.v}}` token, and where the mock
/// server's record of that field shows what reached the wire.
struct DataTokenFieldCase {
    const char* name;
    const char* path;    // appended to the mock server's origin
    const char* headers; // the request's stored headers; "" for none
    std::string SeenRequest::* seen_field;
    const char* expected_prefix; // what precedes the row's value in that field
};

constexpr auto DATA_TOKEN_FIELD_CASES = std::to_array<DataTokenFieldCase> ({
// The headline case: the row drives where the request goes, without a script.
// `pm.iterationData` cannot do this - it is read after the request was built.
{ "InTheUrl", "/ok?v={{data.v}}", "", &SeenRequest::target, "/ok?v=" },
{ "InAHeader", "/ok", R"([{"key":"X-Marker","value":"{{data.v}}","enabled":true}])",
&SeenRequest::marker, "" },
});

class ScenarioRunnerDataTokenTest
: public ScenarioRunnerTest,
  public ::testing::WithParamInterface<DataTokenFieldCase> {};

TEST_P (ScenarioRunnerDataTokenTest, ResolvesPerIteration) {
    const auto& c = GetParam ();
    seed_collection ("col_1");
    seed_request ("req_a", 0, c.path, "", "", "", "", c.headers);

    const auto run_id =
    start_with_data (json::array ({ { { "v", "row-0" } }, { { "v", "row-1" } } }));
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    // Two halves, and reverting either one fails this: without the reserved
    // namespace the token is eaten at composition and both carry an empty
    // value; without the runner's pass the literal `{{data.v}}` reaches the
    // wire.
    EXPECT_EQ (seen[0].*c.seen_field, std::string (c.expected_prefix) + "row-0");
    EXPECT_EQ (seen[1].*c.seen_field, std::string (c.expected_prefix) + "row-1");
}

INSTANTIATE_TEST_SUITE_P (ADataToken,
ScenarioRunnerDataTokenTest,
::testing::ValuesIn (DATA_TOKEN_FIELD_CASES),
[] (const ::testing::TestParamInfo<DataTokenFieldCase>& info) {
    return std::string (info.param.name);
});

// A token naming a column the row does not carry never reaches the wire. The
// alternative - substituting "" - is a request quietly pointing somewhere else,
// which is precisely what a data-driven run must not do.
TEST_F (ScenarioRunnerTest, ATokenNamingAnAbsentColumnErrorsTheStepWithoutSending) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "", "", "", server_->url ("/ok?user={{data.absent}}"));

    const auto run_id = start_with_data (json::array ({ { { "user", "ada" } } }));
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_TRUE (server_->requests ().empty ())
    << "the step must not have sent";

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["errored"].get<size_t> (), 1u);
    EXPECT_EQ (scenario["passed"].get<size_t> (), 0u);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_NE (rows[0].error.find ("{{data.absent}}"), std::string::npos)
    << rows[0].error;
    // The row kept the request so the unbound token is visible in the step's
    // expanded view, and dropped the response, because there was none.
    auto trace = json::parse (rows[0].trace_data);
    EXPECT_FALSE (trace.contains ("response"));
    EXPECT_NE (
    trace["request"]["url"].get<std::string> ().find ("{{data.absent}}"), std::string::npos);
    // No exchange ran, so there is no script time to report, not a zero (#3676).
    EXPECT_FALSE (trace.contains ("scriptMs")) << trace.dump (2);
}

// A credentials file behind basic auth, end to end. The plan deliberately does
// not resolve this step's auth: `apply_auth` would base64 the *token text* into
// one `Authorization` value, which is unreadable by the time anything scans the
// built request - so every iteration used to send the same wrong credential and
// report it as an ordinary 401 (issue #591).
TEST_F (ScenarioRunnerTest, ACredentialsFileBindsPerIterationOnTheWire) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", "", "", "", "", "",
    R"({"mode":"basic","username":"{{data.user}}","password":"{{data.pass}}"})");

    const auto run_id =
    start_with_data (json::array ({ { { "user", "ada" }, { "pass", "pw0" } },
    { { "user", "grace" }, { "pass", "pw1" } } }));
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[0].authorization, "Basic " + vayu::utils::base64_encode ("ada:pw0"));
    EXPECT_EQ (seen[1].authorization, "Basic " + vayu::utils::base64_encode ("grace:pw1"));
}

// Issue #2473: a basic password the step's own pre-request script sets reaches
// the wire, rather than base64 of `user:{{password}}` - the plan encoded the
// pair before any script ran, and no later pass can read a token inside
// base64. Mutation check: drop `auth_after_scripts` from the resolution in
// `resolve_step` (scenario_plan.cpp) and the wire carries the literal token.
TEST_F (ScenarioRunnerTest, APasswordThePreRequestScriptSetsReachesTheWireThroughLateAuth) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok",
    "pm.collectionVariables.set('password', 's3cret');", "", "", "", "", "",
    R"({"mode":"basic","username":"user","password":"{{password}}"})");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 1u);
    EXPECT_EQ (vayu::tests::basic_pair_of (seen[0].authorization), "user:s3cret");
}

// Issue #2521: a client secret the step's script sets reaches the token
// endpoint, and the token acquired with it reaches the step's wire - the plan
// no longer acquires before any script. Mutation check: set
// `oauth2_after_scripts` false in `start_scenario` and the endpoint receives
// the stored secret.
TEST_F (ScenarioRunnerTest, AnOAuth2SecretTheStepsScriptSetsReachesTheTokenEndpoint) {
    const vayu::tests::MockTokenServer tokens;
    seed_collection ("col_1");
    seed_environment ("env_1", R"({"secret":{"value":"stored","enabled":true}})");
    const json auth = { { "mode", "oauth2" },
        { "config",
        { { "grantType", "client_credentials" },
        { "accessTokenUrl", tokens.url ("/token") }, { "clientId", "cid" },
        { "clientSecret", "{{secret}}" }, { "credentialsPlacement", "body" } } } };
    seed_request ("req_a", 0, "/ok", "pm.environment.set('secret', 'from-script');",
    "", "", "", "", "", auth.dump ());

    const auto run_id = start (/*iterations=*/1, "env_1");
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_EQ (vayu::tests::parse_form (tokens.last_body ())["client_secret"], "from-script");
    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 1u);
    EXPECT_EQ (seen[0].authorization, "Bearer AT1");
}

// --- A value an earlier step writes reaches a later step (#2521) --------------
//
// The environment holds `token=old`; step 1 ("login") writes a new token and
// step 2, which carries no element of its own, sends `Bearer {{token}}`. The
// same collection runs three times against the same environment, so a plan
// composed with the stored value would send the previous run's token on every
// run. Mutation check for the block: make `plan_variable_deferral`
// (scenario_plan.cpp) answer `WhenScripted`, and run N sends run N-1's token
// (`old` on the first).

// The collection-level variant: one script above both steps, whose run for
// the first sets the token. Mutation check: also make `runs_a_pre_request_script`
// (request_composer.cpp) answer false, and the second step sends `Bearer old`.
TEST_F (ScenarioRunnerTest, AValueAnEarlierStepsScriptReplacesReachesALaterStep) {
    seed_collection_with_elements ("col_1", "",
    json::array ({ { { "id", "el_col_pre" }, { "kind", "script.pre" }, { "enabled", true },
    { "config", { { "script", "if (pm.info.requestName === 'login') { pm.environment.set('token', 'new'); }" } } } } }));
    seed_environment ("env_1", R"({"token":{"value":"old","enabled":true}})");
    seed_request ("req_a", 0, "/ok", "", "", "", "login");
    seed_request ("req_b", 1, "/echo-auth", "", "", "", "use",
    R"([{"key":"Authorization","value":"Bearer {{token}}","enabled":true}])");

    const auto run_id = start (/*iterations=*/1, "env_1");
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[1].path, "/echo-auth");
    EXPECT_EQ (seen[1].authorization, "Bearer new");
}

/// What every variant's login script runs: count the runs in the environment
/// and set this run's token from the count.
constexpr const char* COUNTING_LOGIN_SCRIPT =
"const n = Number(pm.environment.get('n')) + 1;"
"pm.environment.set('n', String(n));"
"pm.environment.set('token', 'run-' + n);";

constexpr const char* STORED_TOKEN_ENVIRONMENT =
R"({"token":{"value":"old","enabled":true},"n":{"value":"0","enabled":true}})";

constexpr const char* BEARER_TOKEN_HEADER =
R"([{"key":"Authorization","value":"Bearer {{token}}","enabled":true}])";

// The usual Postman login: the token is set by the login's test script.
TEST_F (ScenarioRunnerTest, ATokenAnEarlierStepsTestScriptSetsIsSentByALaterStepOnEveryRun) {
    seed_collection ("col_1");
    seed_environment ("env_1", STORED_TOKEN_ENVIRONMENT);
    seed_request ("req_a", 0, "/ok", "", COUNTING_LOGIN_SCRIPT, "", "login");
    seed_request ("req_b", 1, "/echo-auth", "", "", "", "use", BEARER_TOKEN_HEADER);

    EXPECT_EQ (authorizations_over_runs (3),
    (std::vector<std::string>{ "Bearer run-1", "Bearer run-2", "Bearer run-3" }));

    // The step's trace records what was sent, not the template.
    const auto rows = db_->get_results ("run_scenario_3");
    ASSERT_EQ (rows.size (), 2u);
    const auto sent = json::parse (rows[1].trace_data)["request"]["headers"];
    EXPECT_EQ (sent.value ("Authorization", ""), "Bearer run-3") << sent.dump ();
}

// The login's own pre-request script sets it: before #2521's plan-wide rule
// only the login itself waited for the script.
TEST_F (ScenarioRunnerTest, ATokenAnEarlierStepsPreRequestScriptSetsIsSentByALaterStepOnEveryRun) {
    seed_collection ("col_1");
    seed_environment ("env_1", STORED_TOKEN_ENVIRONMENT);
    seed_request ("req_a", 0, "/ok", COUNTING_LOGIN_SCRIPT, "", "", "login");
    seed_request ("req_b", 1, "/echo-auth", "", "", "", "use", BEARER_TOKEN_HEADER);

    EXPECT_EQ (authorizations_over_runs (3),
    (std::vector<std::string>{ "Bearer run-1", "Bearer run-2", "Bearer run-3" }));
}

// An extractor writes it from the login's response, a new token per login.
TEST_F (ScenarioRunnerTest, ATokenAnEarlierStepsExtractorWritesIsSentByALaterStepOnEveryRun) {
    seed_collection ("col_1");
    seed_environment ("env_1", STORED_TOKEN_ENVIRONMENT);
    seed_request_with_elements ("req_a", 0, "/login-n",
    json::array ({ { { "id", "el_token" }, { "kind", "extract.json" }, { "enabled", true },
    { "config", { { "path", "$.token" }, { "variable", "token" }, { "scope", "env" } } } } }));
    seed_request ("req_b", 1, "/echo-auth", "", "", "", "use", BEARER_TOKEN_HEADER);

    EXPECT_EQ (authorizations_over_runs (3),
    (std::vector<std::string>{ "Bearer tok-1", "Bearer tok-2", "Bearer tok-3" }));
}

// Mixed credentials: the row answers its half at the bind and the script the
// other, each iteration, through the one plan. Mutation check: bind with
// `bind_iteration` instead of `bind_iteration_holding_auth` in
// `bind_step_iteration` and the pair is encoded before the script runs.
TEST_F (ScenarioRunnerTest, ARowAndAScriptEachAnswerHalfOfABasicPairThroughLateAuth) {
    seed_collection ("col_1");
    seed_request ("req_a", 0,
    "/ok", "pm.collectionVariables.set('password', 'pw-' + pm.iterationData.get('user'));",
    "", "", "", "", "",
    R"({"mode":"basic","username":"{{data.user}}","password":"{{password}}"})");

    const auto run_id = start_with_data (
    json::array ({ { { "user", "ada" } }, { { "user", "grace" } } }));
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (vayu::tests::basic_pair_of (seen[0].authorization), "ada:pw-ada");
    EXPECT_EQ (vayu::tests::basic_pair_of (seen[1].authorization), "grace:pw-grace");
}

// A cell carrying a quote used to end the JSON string it was dropped into and
// put a malformed body on the wire, silently (issue #593). Read off the wire,
// because the bind, the build and the wire encoding all have to agree.
TEST_F (ScenarioRunnerTest, AQuoteBearingCellReachesTheWireAsValidJson) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/body", "", "", "", "", "",
    R"({"mode":"json","content":"{\"note\":\"{{data.note}}\"}"})");

    const auto run_id = start_with_data (json::array (
    { { { "note", "has,comma \"quoted\"" } }, { { "note", "line\nbreak\\slash" } } }));
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    for (const auto& hit : seen) {
        const auto sent = json::parse (hit.body, nullptr, false);
        ASSERT_FALSE (sent.is_discarded ())
        << "a bound body reached the wire unparseable: " << hit.body;
    }
    EXPECT_EQ (json::parse (seen[0].body).at ("note").get<std::string> (), "has,comma \"quoted\"");
    EXPECT_EQ (json::parse (seen[1].body).at ("note").get<std::string> (), "line\nbreak\\slash");
}

// ============================================================================
// An `mcp` request in a data-driven run (#3808)
// ============================================================================

/// The stored body of an `mcp` request calling the fixture's `execute_sql`,
/// its arguments left as tokens for a data row to fill. Built with `dump`, so
/// no escaping is written by hand.
std::string mcp_body_with_data_tokens () {
    const json call{ { "method", "tools/call" },
        { "params",
        { { "name", "execute_sql" },
        { "arguments", { { "region", "{{data.region}}" }, { "query", "{{data.q}}" } } } } } };
    return json{ { "mode", "mcp" }, { "content", call.dump () },
        { "mcpTool", vayu::tests::execute_sql_tool_json () } }
    .dump ();
}

/// The text of the one content item in a JSON-RPC `tools/call` answer.
std::string reply_text_of (const json& frame) {
    return frame.at ("result").at ("content").at (0).at ("text").get<std::string> ();
}

// The `Mcp-*` headers are never bound themselves, and they and the wire body are
// both derived from the bound bytes, so each row must reach the server as a
// call whose headers agree with its body, the fixture answering `400` where
// they do not. The middle row's region is non-ASCII, which the engine can only
// mirror as a `=?base64?` sentinel, and its `want` is wrong, so it fails
// alone. Mutation checks: bind an `mcp` body as plain text in `body_context`
// (`scenario_data.cpp`) and the quote-bearing row's body stops parsing; drop
// `append_mcp_derived_headers` (`curl_utils.cpp`) and every row is refused.
TEST_F (ScenarioRunnerTest, AnMcpRequestInADataDrivenRunSendsEachRowsBodyAndMirroredHeaders) {
    vayu::tests::McpFixtureServer mcp;
    seed_collection ("col_1");
    seed_request ("req_a", 0, "", "",
    "pm.test('the reply is the row\\'s want', function () {"
    "  pm.expect(pm.response.json().result.content[0].text)"
    "    .to.equal(pm.iterationData.get('want'));"
    "});",
    mcp.url (), "", "", mcp_body_with_data_tokens ());

    const std::string reply{ vayu::tests::MCP_RESULT_TEXT };
    struct Row {
        std::string region;
        std::string query;
        std::string want;
        std::string outcome;
        /// Whether the header mirrors the region as a `=?base64?` sentinel.
        bool sentinel;
    };
    // The non-ASCII region is spelled in bytes so no compiler's source
    // encoding decides what the test sends.
    const std::vector<Row> rows{
        { "eu", R"(SELECT "a" FROM t WHERE p = 'C:\tmp')", reply, "passed", false },
        { "\xC3\xA9-\xC3\xBC", "SELECT 2", "WRONG", "failed", true },
        { "us", "SELECT 3", reply, "passed", false },
    };
    json data = json::array ();
    for (const auto& row : rows) {
        data.push_back (
        { { "region", row.region }, { "q", row.query }, { "want", row.want } });
    }

    const auto run_id = start_with_data (data);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    // The fixture counts a refused call too, so the count alone cannot say the
    // headers agreed; the answers below do.
    EXPECT_EQ (mcp.requests (), rows.size ());

    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), rows.size ());
    for (size_t i = 0; i < rows.size (); ++i) {
        const auto& row   = rows.at (i);
        const auto& trace = traces.at (i);
        SCOPED_TRACE ("row " + std::to_string (i));

        EXPECT_EQ (trace["outcome"].get<std::string> (), row.outcome) << trace.dump ();
        EXPECT_EQ (trace["dataRowIndex"].get<size_t> (), i);

        const auto& sent = trace["request"]["sentHeaders"];
        EXPECT_EQ (sent.value ("Mcp-Method", ""), "tools/call");
        EXPECT_EQ (sent.value ("Mcp-Name", ""), "execute_sql");
        const auto mirrored               = sent.value ("Mcp-Param-Region", "");
        constexpr std::string_view prefix = "=?base64?";
        constexpr std::string_view suffix = "?=";
        if (!row.sentinel) {
            EXPECT_EQ (mirrored, row.region);
        } else {
            ASSERT_TRUE (mirrored.starts_with (prefix) && mirrored.ends_with (suffix))
            << mirrored;
            const auto inner = std::string_view (mirrored).substr (
            prefix.size (), mirrored.size () - prefix.size () - suffix.size ());
            EXPECT_EQ (vayu::utils::base64_decode (inner), row.region);
        }

        const auto call =
        json::parse (trace["request"]["body"].get<std::string> (), nullptr, false);
        ASSERT_FALSE (call.is_discarded ()) << trace["request"]["body"];
        EXPECT_EQ (call["params"]["arguments"]["query"].get<std::string> (), row.query);
        EXPECT_EQ (
        call["params"]["arguments"]["region"].get<std::string> (), row.region);

        const auto answer =
        json::parse (trace["response"]["body"].get<std::string> (), nullptr, false);
        ASSERT_FALSE (answer.is_discarded ()) << trace["response"]["body"];
        EXPECT_EQ (reply_text_of (answer), reply) << answer.dump ();
    }

    const auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["passed"].get<size_t> (), 2u) << scenario.dump ();
    EXPECT_EQ (scenario["failed"].get<size_t> (), 1u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 0u);
}

// A step's elements read the final JSON-RPC response of an event-stream reply
// on every row, where the stream's own bytes hold no `$.result`. Mutation
// check: return the raw response from `mcp_element_view` and the assertion
// fails on both rows.
TEST_F (ScenarioRunnerTest, AnMcpEventStreamReplyIsReadByElementsOnEveryDataRow) {
    vayu::tests::McpFixtureServer mcp;
    mcp.reply_with (vayu::tests::McpReplyShape::EventStream);
    seed_collection ("col_1");
    seed_request ("req_a", 0, "", "", "", mcp.url (), "", "", mcp_body_with_data_tokens ());
    auto stored = db_->get_request ("req_a");
    ASSERT_HAS_VALUE (stored);
    stored->elements = json::array (
    { { { "id", "el_text" }, { "kind", "assert.jsonpath" }, { "enabled", true },
    { "config",
    { { "path", "$.result.content[0].text" },
    { "expected", std::string (vayu::tests::MCP_RESULT_TEXT) } } } } })
                       .dump ();
    db_->save_request (*stored);

    const auto run_id =
    start_with_data (json::array ({ { { "region", "eu" }, { "q", "SELECT 1" } },
    { { "region", "us" }, { "q", "SELECT 2" } } }));
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_EQ (mcp.requests (), 2u);
    const auto traces = stored_traces (run_id);
    ASSERT_EQ (traces.size (), 2u);
    for (size_t i = 0; i < traces.size (); ++i) {
        const auto& trace = traces.at (i);
        SCOPED_TRACE ("row " + std::to_string (i));
        EXPECT_EQ (trace["outcome"].get<std::string> (), "passed") << trace.dump ();
        EXPECT_EQ (trace["dataRowIndex"].get<size_t> (), i);
        ASSERT_EQ (trace["elements"].size (), 1u) << trace.dump ();
        EXPECT_EQ (trace["elements"][0]["id"], "el_text");
        EXPECT_EQ (trace["elements"][0]["outcome"], "ok")
        << trace["elements"][0].dump ();
        // The stored body stays the stream the server sent.
        EXPECT_NE (trace["response"]["body"].get<std::string> ().find (
                   "notifications/progress"),
        std::string::npos);
    }
}

// A null cell is the missing-column failure one type down, and is refused the
// same way: nothing is sent, and the step's error names the token.
TEST_F (ScenarioRunnerTest, ANullCellErrorsTheStepWithoutSending) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/body", "", "", "", "", "",
    R"({"mode":"json","content":"{\"n\":{{data.n}}}"})");

    const auto run_id = start_with_data (json::array ({ { { "n", nullptr } } }));
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_TRUE (server_->requests ().empty ())
    << "a body with an erased value reached the wire";

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_NE (rows[0].error.find ("{{data.n}}"), std::string::npos) << rows[0].error;
    EXPECT_NE (rows[0].error.find ("null"), std::string::npos) << rows[0].error;
}

// The test script reads the same row its request was built from: asserting a
// response against the row that produced it is the whole point of a
// data-driven run.
TEST_F (ScenarioRunnerTest, TheTestScriptReadsTheSameRowAsThePreRequestScript) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok",
    R"(pm.request.headers.add({key: "X-Marker", value: pm.iterationData.get("marker")});)",
    "pm.test('row is mine', function () {"
    "  pm.expect(pm.iterationData.get('marker')).to.equal('row-' + "
    "pm.info.iteration);"
    "  pm.expect(pm.iterationData.toObject().marker).to.equal('row-' + "
    "pm.info.iteration);"
    "});");

    const auto run_id = start_with_data (
    json::array ({ { { "marker", "row-0" } }, { { "marker", "row-1" } } }));
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["passed"].get<size_t> (), 2u);
    EXPECT_EQ (scenario["failed"].get<size_t> (), 0u);
}

// The live stream says what the stored row says. A step that gains a row
// number only once the run ends would read as two different steps.
TEST_F (ScenarioRunnerTest, StepEventsCarryTheRowIndexOnTheSameTermsAsTheStoredRow) {
    vayu::core::StepRecord record;
    record.iteration      = 3;
    record.step_index     = 0;
    record.step_name      = "Login";
    record.data_row_index = 1;

    auto with_row = json::parse (vayu::core::build_step_payload (record, 0).substr (
    vayu::core::build_step_payload (record, 0).find ("data: ") + 6));
    EXPECT_EQ (with_row["dataRowIndex"].get<size_t> (), 1u);

    record.data_row_index = std::nullopt;
    auto without_row = json::parse (vayu::core::build_step_payload (record, 0).substr (
    vayu::core::build_step_payload (record, 0).find ("data: ") + 6));
    EXPECT_FALSE (without_row.contains ("dataRowIndex"));
}

// The frame names the request the step ran (issue #831), so the app's way back
// to it exists while the run streams rather than only once its rows are
// written. Asserted here because a payload that stops sending the key would
// otherwise return the app to the old behaviour silently - the step card
// simply renders no link.
TEST_F (ScenarioRunnerTest, StepEventsCarryTheRequestIdTheStoredRowIsStampedWith) {
    vayu::core::StepRecord record;
    record.iteration  = 0;
    record.step_index = 2;
    record.step_name  = "Checkout";
    record.request_id = "req_checkout";

    auto with_id = json::parse (vayu::core::build_step_payload (record, 0).substr (
    vayu::core::build_step_payload (record, 0).find ("data: ") + 6));
    EXPECT_EQ (with_id["requestId"].get<std::string> (), "req_checkout");

    // A step whose plan entry names no stored request sends no key rather than
    // an empty string the app would have to know to disbelieve.
    record.request_id = "";
    auto without_id = json::parse (vayu::core::build_step_payload (record, 0).substr (
    vayu::core::build_step_payload (record, 0).find ("data: ") + 6));
    EXPECT_FALSE (without_id.contains ("requestId"));
}

} // namespace
