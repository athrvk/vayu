/**
 * @file tests/scenario_load_rows_test.cpp
 * @brief Load-mode scenario runs: data rows and credentials bound per iteration, generated
 * values, concurrency and pacing, the pass duration, schema sampling and streaming steps.
 *
 * The `ScenarioLoadTest` fixture and its mock server are in `scenario_load_fixture.hpp`.
 */

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "vayu/core/scenario_load.hpp"

#include <gtest/gtest.h>

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "basic_auth_pair.hpp"
#include "load_start_stamp.hpp"
#include "mock_server.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/utils/encoding.hpp"
#include "wait_until.hpp"

#include "scenario_load_fixture.hpp"

using nlohmann::json;
using vayu::tests::scenario_load::ScenarioLoadTest;
using vayu::tests::scenario_load::ScenarioMockServer;

// ============================================================================
// Data rows in load mode (issue #449)
// ============================================================================

// The cursor is shared across the whole run and wraps: 5 iterations over a
// 3-row set bind 0,1,2,0,1. One VU, so the recorded order is the claim order.
TEST_F (ScenarioLoadTest, TheSharedRowCursorWrapsWhenTheRowsRunOut) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{data.id}}") });
    with_data (execution,
    { json{ { "id", "0" } }, json{ { "id", "1" } }, json{ { "id", "2" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 5 },
        { "concurrency", 1 } };
    run (config, execution);

    std::vector<std::string> paths;
    for (const auto& hit : server.hits ()) {
        paths.push_back (hit.path);
    }
    EXPECT_EQ (paths,
    (std::vector<std::string>{ "/row/0", "/row/1", "/row/2", "/row/0", "/row/1" }));
}

// Two virtual users running concurrently bind *different* rows. Make the cursor
// per-VU and this fails - which is the whole reason it is one run-wide counter:
// two users of a credentials file must not both be user 0.
TEST_F (ScenarioLoadTest, ConcurrentVirtualUsersBindDifferentRows) {
    // The rendezvous holds both VUs inside step 0 at once, so "concurrently" is
    // an assertion rather than a race the test hopes to win.
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution =
    plan_over ({ server.url ("/login"), server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "0" } }, json{ { "id", "1" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    std::vector<std::string> rows;
    for (const auto& hit : server.hits ()) {
        if (hit.path.rfind ("/row/", 0) == 0) {
            rows.push_back (hit.path);
        }
    }
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_NE (rows[0], rows[1])
    << "both virtual users bound the same row - the row cursor is per-VU "
       "rather than shared across the run";
}

// The other side of the claim, and the one the api-reference sentence used to
// deny: with fewer rows than concurrent virtual users the cursor wraps while
// both are live, so they bind the *same* row at the same time. Exclusivity
// holds only while unclaimed rows remain.
TEST_F (ScenarioLoadTest, FewerRowsThanVirtualUsersMeansConcurrentUsersShareARow) {
    // Same rendezvous as the test above, for the same reason: it holds both VUs
    // inside step 0 at once, so "at the same time" is asserted rather than
    // hoped for.
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution =
    plan_over ({ server.url ("/login"), server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "0" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    std::vector<std::string> rows;
    for (const auto& hit : server.hits ()) {
        if (hit.path.rfind ("/row/", 0) == 0) {
            rows.push_back (hit.path);
        }
    }
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_EQ (rows, (std::vector<std::string>{ "/row/0", "/row/0" }))
    << "the single row was not reused - a wrapping cursor is what makes a run "
       "longer than its data set possible at all";
}

// Every step of one iteration binds the same row: a checkout that used a
// different row than its login is not a user.
TEST_F (ScenarioLoadTest, EveryStepOfAnIterationBindsTheSameRow) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{data.id}}"),
    server.url ("/row/{{data.id}}"), server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "0" } }, json{ { "id", "1" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    std::vector<std::string> paths;
    for (const auto& hit : server.hits ()) {
        paths.push_back (hit.path);
    }
    EXPECT_EQ (paths,
    (std::vector<std::string>{ "/row/0", "/row/0", "/row/0", "/row/1", "/row/1", "/row/1" }));
}

// The zero-cost claim, where the executor reads it: a step with no data token
// carries an empty template, which is what it tests before joining anything.
TEST_F (ScenarioLoadTest, AStepWithoutADataTokenCarriesNoTemplate) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "0" } } });

    EXPECT_TRUE (execution.plan.steps[0].data_template.empty ())
    << "a step with no {{data.*}} token must do no per-iteration join work";
    EXPECT_FALSE (execution.plan.steps[1].data_template.empty ());

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution);

    EXPECT_EQ (server.hits_for ("/s0").size (), 1u)
    << "the untemplated step was still sent unchanged";
}

// A credentials file, end to end and read off the wire: every virtual user
// sends its *own* row's credentials, base64-encoded after the bind rather than
// around it. Before this, the header on every one of these was
// base64("{{data.user}}:{{data.pass}}") - a literal token nobody ever saw,
// because the encoding hid it (issue #591).
TEST_F (ScenarioLoadTest, ACredentialsFileBindsPerIterationOnTheWire) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo") });
    with_data (execution,
    { json{ { "user", "alice" }, { "pass", "pw0" } },
    json{ { "user", "bob" }, { "pass", "pw1" } } });
    with_deferred_auth (execution,
    json{ { "mode", "basic" }, { "username", "{{data.user}}" },
    { "password", "{{data.pass}}" } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    std::vector<std::string> sent;
    for (const auto& hit : server.hits_for ("/echo")) {
        sent.push_back (hit.authorization);
    }
    EXPECT_EQ (sent,
    (std::vector<std::string>{ "Basic " + vayu::utils::base64_encode ("alice:pw0"),
    "Basic " + vayu::utils::base64_encode ("bob:pw1") }));
}

// The same bind on a collection run that carries **no data set at all** (issue
// #1055). This is the run shape the old rule could not serve: deferral was
// keyed to the run having rows, so a step's `{{$vu}}` credential went out
// base64-encoded as written. Two virtual users, so the assertion is about each
// binding its *own* number rather than both binding `1` - which is what a bind
// that dropped the caller's identity would produce.
TEST_F (ScenarioLoadTest, AStepCredentialBindsTheIdentityWithNoDataSet) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo") });
    with_deferred_auth (execution,
    json{ { "mode", "basic" }, { "username", "user-{{$vu}}" }, { "password", "pw" } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 }, { "vus", 2 } };
    run (config, execution);

    std::vector<std::string> sent;
    for (const auto& hit : server.hits_for ("/echo")) {
        sent.push_back (hit.authorization);
    }
    std::sort (sent.begin (), sent.end ());
    ASSERT_FALSE (sent.empty ()) << "no step reached the wire";
    for (const auto& authorization : sent) {
        EXPECT_NE (authorization.find ("Basic "), std::string::npos) << authorization;
    }
    // Every credential that left carries a bound number rather than the token
    // text, and the set of numbers is the set of users that sent.
    for (const auto& authorization : sent) {
        EXPECT_EQ (authorization.find ("{{$vu}}"), std::string::npos)
        << "the token text reached the wire base64-encoded as written: " << authorization;
    }
    EXPECT_TRUE (std::find (sent.begin (), sent.end (),
                 "Basic " + vayu::utils::base64_encode ("user-1:pw")) != sent.end ())
    << "virtual user 1 must authenticate as itself";
}

// The credential half of the failure path: a column the row does not carry ends
// the step before the send, exactly as one in the URL does - never a request
// with a blank password.
TEST_F (ScenarioLoadTest, AnAbsentColumnInACredentialErrorsTheStepInsteadOfSendingIt) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo") });
    with_data (execution, { json{ { "user", "alice" } } });
    with_deferred_auth (execution,
    json{ { "mode", "basic" }, { "username", "{{data.user}}" },
    { "password", "{{data.missing}}" } });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_EQ (server.hits_for ("/echo").size (), 0u)
    << "a request whose credentials could not bind reached the wire";
    EXPECT_EQ (state->steps_errored.load (), 1u);
    EXPECT_EQ (context_->in_flight (), 0u);

    const auto& errors = context_->metrics_collector->errors ();
    ASSERT_FALSE (errors.empty ());
    EXPECT_NE (errors[0].error_message.find ("{{data.missing}}"), std::string::npos)
    << errors[0].error_message;
}

// Issue #2473 on the load path: a password an inline `script.pre` sets reaches
// every submission's basic pair, applied after the residual pass rather than
// encoded around the token when the plan resolved. Mutation check: drop
// `auth_after_scripts` from the resolution in `resolve_step`
// (scenario_plan.cpp) and the wire carries `user:{{password}}`.
TEST_F (ScenarioLoadTest, AnInlineScriptPreSetsAPasswordThatReachesTheWireThroughLateAuth) {
    ScenarioMockServer server;
    const auto execution = resolve_one_step (server.url ("/echo"),
    json{ { "mode", "basic" }, { "username", "user" }, { "password", "{{password}}" } },
    json::array ({ vayu::tests::script_element_json ("el_pre", "script.pre",
    "pm.environment.set('password', 's3cret');", /*inline_script=*/true) }));
    ASSERT_EQ (execution.plan.steps.size (), 1u);

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    for (const auto& echo : echoes) {
        EXPECT_EQ (vayu::tests::basic_pair_of (echo.authorization), "user:s3cret");
    }
}

// #3131 on a scenario load: an inline `script.pre` that assigns
// `pm.request.auth` replaces the step's own credential on every submission.
TEST_F (ScenarioLoadTest, AnInlineScriptPreAssignedAuthReplacesTheStepsOwn) {
    ScenarioMockServer server;
    const auto execution = resolve_one_step (server.url ("/echo"),
    json{ { "mode", "bearer" }, { "token", "step-token" } },
    json::array ({ vayu::tests::script_element_json ("el_pre",
    "script.pre", "pm.request.auth = { type: 'basic', basic: { username: 'ada', password: 'pw' } };",
    /*inline_script=*/true) }));
    ASSERT_EQ (execution.plan.steps.size (), 1u);

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    for (const auto& echo : echoes) {
        EXPECT_EQ (vayu::tests::basic_pair_of (echo.authorization), "ada:pw");
    }
}

// The count-only rule (#1503) holds for a credential that waited: nothing
// answered it, so it is encoded as written and sent, never refused.
TEST_F (ScenarioLoadTest, ACredentialNothingAnswersIsSentAsWrittenThroughLateAuth) {
    ScenarioMockServer server;
    const auto execution = resolve_one_step (server.url ("/echo"),
    json{ { "mode", "basic" }, { "username", "user" }, { "password", "{{password}}" } },
    json::array ());

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 1u) << "the step was refused rather than sent";
    EXPECT_EQ (vayu::tests::basic_pair_of (echoes[0].authorization), "user:{{password}}");
    EXPECT_EQ (state->steps_errored.load (), 0u);
}

// A token naming a column the bound row does not carry fails the step loudly:
// nothing goes on the wire, the step's own error count moves, and the run's
// error list carries the sentence that names the token, the row and the columns.
TEST_F (ScenarioLoadTest, AnAbsentColumnErrorsTheStepInsteadOfSendingIt) {
    ScenarioMockServer server;
    // The bad token sits in the middle, so "the iteration ended here" is
    // visible as the last step never being reached.
    auto execution = plan_over (
    { server.url ("/s0"), server.url ("/row/{{data.missing}}"), server.url ("/s2") });
    with_data (execution, { json{ { "id", "0" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_EQ (server.hits_for ("/s0").size (), 2u)
    << "the virtual user was stranded by a step that never reached the wire";
    EXPECT_EQ (server.hits_for ("/s2").size (), 0u);
    for (const auto& hit : server.hits ()) {
        EXPECT_NE (hit.path.rfind ("/row/", 0), 0u)
        << "a request with an unbound token reached the wire: " << hit.path;
    }

    EXPECT_EQ (state->steps.errors (1), 2u)
    << "the failure was not attributed to the step that could not bind";
    EXPECT_EQ (state->steps.completed (1), 2u);
    EXPECT_EQ (state->steps.latency_samples (1), 0u)
    << "a step that was never sent recorded a duration (#2384)";
    EXPECT_EQ (state->steps_errored.load (), 2u);
    EXPECT_EQ (state->iterations_abandoned.load (), 2u);
    EXPECT_EQ (context_->in_flight (), 0u)
    << "a step that was never sent left an in-flight slot leaked";

    // Loud: the message reaches the run's error store, naming what to fix.
    const auto& errors = context_->metrics_collector->errors ();
    ASSERT_FALSE (errors.empty ());
    EXPECT_NE (errors[0].error_message.find ("{{data.missing}}"), std::string::npos)
    << errors[0].error_message;
    EXPECT_NE (errors[0].error_message.find ("step1"), std::string::npos)
    << "the message does not name the step it failed on: " << errors[0].error_message;
}

// A quote-bearing cell used to put invalid JSON on the wire, silently, at the
// run's full rate (issue #593). Asserted off the wire because that is where the
// corruption was: the bind, the build and the wire encoding all have to agree.
TEST_F (ScenarioLoadTest, AQuoteBearingCellReachesTheWireAsValidJson) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/body") });
    execution.plan.steps[0].request.method    = vayu::HttpMethod::POST;
    execution.plan.steps[0].request.body.mode = vayu::BodyMode::Json;
    execution.plan.steps[0].request.body.content = R"({"who":"u","note":"{{data.note}}"})";
    with_data (execution, { json{ { "note", R"(has,comma "quoted")" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto hits = server.hits_for ("/body");
    ASSERT_EQ (hits.size (), 1u);
    const auto sent = json::parse (hits[0].body, nullptr, false);
    ASSERT_FALSE (sent.is_discarded ())
    << "a bound body reached the wire unparseable: " << hits[0].body;
    EXPECT_EQ (sent.at ("note").get<std::string> (), R"(has,comma "quoted")");
}

// Issue #995, on the scenario path and across virtual users: every send
// generates its own value, so an id shared between two virtual users' iterations
// - or between two iterations of one - shows up here as a short set rather than
// as eight distinct paths.
//
// What this does *not* test is a data race, and the distinction is worth
// keeping: a run binds on its own driver thread, which is the event loop's sole
// producer, so the generators run there rather than on the transfer workers.
// Two runs at once are two driver threads, and what makes that safe is the
// `thread_local` engine `request_composer.cpp`'s table has always drawn from -
// unchanged here, and already load-bearing for concurrent `POST /compose`.
TEST_F (ScenarioLoadTest, EveryIterationOfEveryUserGeneratesItsOwnValue) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{$randomUUID}}") });
    split_steps (execution);

    const json config = { { "mode", "iterations" }, { "iterations", 8 },
        { "concurrency", 4 } };
    run (config, execution);

    const auto hits = server.hits ();
    ASSERT_EQ (hits.size (), 8u);
    std::set<std::string> distinct;
    for (const auto& hit : hits) {
        EXPECT_NE (hit.path, "/row/{{$randomUUID}}")
        << "the token reached the wire as it stands";
        distinct.insert (hit.path);
    }
    EXPECT_EQ (distinct.size (), hits.size ())
    << "two sends carried the same generated id";
}

// A generated value is written for the document it lands in, exactly as a
// cell is: inside a JSON string literal it is escaped, so the body stays
// parseable whatever the table produced.
TEST_F (ScenarioLoadTest, AGeneratedValueBindsIntoAJsonBodyAsAStringsContent) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/body") });
    execution.plan.steps[0].request.method    = vayu::HttpMethod::POST;
    execution.plan.steps[0].request.body.mode = vayu::BodyMode::Json;
    execution.plan.steps[0].request.body.content =
    R"({"who":"u","id":"{{$guid}}","note":"{{$randomLoremSentence}}"})";
    split_steps (execution);

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto hits = server.hits_for ("/body");
    ASSERT_EQ (hits.size (), 1u);
    const auto sent = json::parse (hits[0].body, nullptr, false);
    ASSERT_FALSE (sent.is_discarded ())
    << "a bound body reached the wire unparseable: " << hits[0].body;
    EXPECT_NE (sent.at ("id").get<std::string> (), "{{$guid}}");
    EXPECT_FALSE (sent.at ("note").get<std::string> ().empty ());
}

// A null cell is refused under load the same way a missing column is: nothing
// is sent, and the run's error store carries the sentence that names it.
TEST_F (ScenarioLoadTest, ANullCellErrorsTheStepInsteadOfErasingTheValue) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/body") });
    execution.plan.steps[0].request.method       = vayu::HttpMethod::POST;
    execution.plan.steps[0].request.body.mode    = vayu::BodyMode::Json;
    execution.plan.steps[0].request.body.content = R"({"n":{{data.n}}})";
    with_data (execution, { json{ { "n", nullptr } } });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_TRUE (server.hits_for ("/body").empty ())
    << "a body with an erased value reached the wire";
    EXPECT_EQ (state->steps_errored.load (), 1u);

    const auto& errors = context_->metrics_collector->errors ();
    ASSERT_FALSE (errors.empty ());
    EXPECT_NE (errors[0].error_message.find ("{{data.n}}"), std::string::npos)
    << errors[0].error_message;
    EXPECT_NE (errors[0].error_message.find ("null"), std::string::npos)
    << errors[0].error_message;
}

// A recorded result carries the row it was bound to, so a failure under load is
// attributable to a row rather than only to a step.
TEST_F (ScenarioLoadTest, ARecordedResultCarriesItsDataRowIndex) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "0" } }, json{ { "id", "1" } } });

    // Every completion retained as a sampled trace, so the assertion is about
    // what a record carries rather than about which budget claimed it.
    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "save_timing_breakdown", true },
        { "success_sample_rate", 1 }, { "slow_threshold_ms", 0 } };
    run (config, execution);

    const auto results = context_->metrics_collector->success_results ();
    ASSERT_FALSE (results.empty ());
    std::vector<int> rows;
    for (const auto& result : results) {
        const auto trace = json::parse (result.trace_data, nullptr, false);
        ASSERT_FALSE (trace.is_discarded ()) << result.trace_data;
        ASSERT_TRUE (trace.contains ("dataRowIndex"))
        << "a sampled load result carries no row: " << result.trace_data;
        rows.push_back (trace["dataRowIndex"].get<int> ());
    }
    std::sort (rows.begin (), rows.end ());
    EXPECT_EQ (rows, (std::vector<int>{ 0, 1 }));
}

// A run sent without `data` carries no row at all - the record must not gain a
// zero that reads like row 0.
TEST_F (ScenarioLoadTest, ARunWithoutRowsRecordsNoDataRowIndex) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/s0") });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "save_timing_breakdown", true },
        { "success_sample_rate", 1 }, { "slow_threshold_ms", 0 } };
    run (config, execution);

    const auto results = context_->metrics_collector->success_results ();
    ASSERT_FALSE (results.empty ());
    for (const auto& result : results) {
        const auto trace = json::parse (result.trace_data, nullptr, false);
        ASSERT_FALSE (trace.is_discarded ());
        EXPECT_FALSE (trace.contains ("dataRowIndex")) << result.trace_data;
    }
}

// `concurrency` is the number of virtual users, and in-flight is bounded by it
// by construction - which is why maxInFlight is moot for a scenario run.
TEST_F (ScenarioLoadTest, ConcurrencyIsTheVirtualUserCountAndBoundsInFlight) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });

    const size_t VUS  = 8;
    const json config = { { "mode", "constant_concurrency" },
        { "duration", "1s" }, { "concurrency", VUS } };
    auto state        = run (config, execution);

    EXPECT_EQ (state->vus.size (), VUS);
    EXPECT_LE (context_->peak_in_flight.load (), VUS)
    << "in-flight exceeded the virtual-user count, so a VU sent two steps at "
       "once";
    EXPECT_GT (state->steps_executed.load (), 0u);
}

// #2913: the scenario controller shares the ramp, so a ramp as long as the run
// reaches its last virtual user at the end rather than stopping one short.
// `/hang` answers nothing while the run lasts, so no virtual user finishes a
// step and the peak is what the controller started, with no completion to race
// it. The final refill (`MaintainConcurrency` in load_strategy_test.cpp) is
// what holds this when no wake lands in the ramp's last tick. Driven here
// rather than through `run`, whose drain would wait out every held transfer.
TEST_F (ScenarioLoadTest, ARampAsLongAsTheRunPeaksAtTheConfiguredUserCount) {
    vayu::tests::SlowMockServer upstream;
    const auto execution = plan_over ({ upstream.hang_url () });

    const size_t VUS  = 8;
    const json config = { { "mode", "ramp_up" }, { "duration", "1s" },
        { "rampUpDuration", "1s" }, { "startConcurrency", 1 }, { "concurrency", VUS } };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-scenario-ramp-end", config);
    context->scenario = std::make_shared<const vayu::core::ScenarioExecution> (execution);
    context->event_loop = std::make_unique<vayu::http::EventLoop> ();
    context->event_loop->start ();

    auto base_scopes =
    vayu::core::scenario_load_scopes (*db_, std::nullopt, *context->scenario);
    auto state = vayu::core::execute_scenario_load (
    context, *db_, *context->scenario, std::move (base_scopes));
    context->event_loop->stop (false);

    EXPECT_EQ (state->vus.size (), VUS);
    EXPECT_EQ (context->peak_in_flight.load (), VUS);
}

// #3567: a step is in flight from `open_request` until its completion closes
// it, and a Stop's cancellation is a completion. `/hang` answers nothing, so
// every virtual user holds one open step until `stop (false)` cancels it, and
// the integral then stops growing. Mutation check: close only a result that is
// not an error in `submit_one`'s callback and the integral still grows after
// the stop.
TEST_F (ScenarioLoadTest, AStopsCancellationClosesEveryOpenStep) {
    vayu::tests::SlowMockServer upstream;
    const auto execution = plan_over ({ upstream.hang_url () });

    const size_t VUS  = 4;
    const json config = { { "mode", "constant_concurrency" },
        { "duration", "300ms" }, { "concurrency", VUS } };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-scenario-open-cancel", config);
    context->scenario = std::make_shared<const vayu::core::ScenarioExecution> (execution);
    context->event_loop = std::make_unique<vayu::http::EventLoop> ();
    context->event_loop->start ();

    auto base_scopes =
    vayu::core::scenario_load_scopes (*db_, std::nullopt, *context->scenario);
    (void)vayu::core::execute_scenario_load (
    context, *db_, *context->scenario, std::move (base_scopes));

    const auto& mc    = *context->metrics_collector;
    const int64_t now = vayu::tests::steady_now_ms ();
    const auto open   = static_cast<int64_t> (context->requests_sent.load ());
    ASSERT_EQ (open, static_cast<int64_t> (VUS)) << "the users never all sent";
    EXPECT_EQ (mc.inflight_integral_ms (now + 1000) - mc.inflight_integral_ms (now),
    1000 * open);

    context->event_loop->stop (false);
    const int64_t after = vayu::tests::steady_now_ms ();
    EXPECT_GT (mc.inflight_integral_ms (after), 0);
    EXPECT_EQ (mc.inflight_integral_ms (after + 60'000), mc.inflight_integral_ms (after))
    << "a cancelled step is still open";
}

// #2821: a virtual user in a think wait has nothing on the wire, so the run's
// mean in flight is its share of time spent sending: two 20 ms steps around a
// 200 ms think is about 0.17 of each user, under 2 of 10 here, and 10 if the
// think wait were counted. Since #3567 the mean is the time each step was open
// over the run, not the latency its completions carried, so a step's script
// time is no longer folded in. Mutation check: divide the integral by the
// completion count in `MetricsCollector::average_in_flight` and this reads the
// mean time a step was open, about 20. The 1 Hz peak sample is the
// instantaneous gauge this mean replaces, so it is only bounded here, not
// pinned (#2397 item 3).
TEST_F (ScenarioLoadTest, AThinkTimeRunsMeanInFlightIsItsShareOfTimeOnTheWire) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/slow"), server.url ("/slow") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { json{ { "id", "el_think" }, { "kind", "timer.think" },
    { "enabled", true }, { "config", { { "ms", 200 } } } } });

    const size_t VUS = 10;
    const json report = run_to_report (json{ { "mode", "constant_concurrency" },
                                       { "duration", "1s" }, { "concurrency", VUS } },
    execution);
    const json& summary = report.at ("summary");
    ASSERT_TRUE (summary.contains ("avgInFlight")) << summary.dump ();
    EXPECT_EQ (report.at ("scenario").at ("virtualUsers").get<size_t> (), VUS)
    << report.at ("scenario").dump ();
    const double avg_in_flight = summary.at ("avgInFlight").get<double> ();
    EXPECT_GT (avg_in_flight, 0.0);
    // A virtual user is on the wire for its two requests and idle for the
    // 200 ms think, so its share of time in flight is L / (L + 200) with L the
    // report's own mean latency over two requests. The bound follows the
    // runner's measured latency (a slow leg raises both sides) and sits far
    // below the user count, which a mean that counted the think waits would
    // read.
    constexpr double THINK_MS = 200.0;
    const double wire_ms = 2.0 * report.at ("latency").at ("avg").get<double> ();
    const double bound =
    ((static_cast<double> (VUS) * wire_ms / (wire_ms + THINK_MS)) * 1.5) + 0.5;
    EXPECT_LT (avg_in_flight, bound)
    << "the run's mean in flight counted the virtual users' think waits: "
    << summary.dump ();
    EXPECT_LE (summary.at ("peakConcurrency").get<size_t> (), VUS);
}

// With no think time every virtual user has a request in flight almost all the
// time, so the mean is about the user count: the sanity check of the
// definition. The bound is wide because the gap between one completion and the
// next submission is the runner's, and it never exceeds the count.
TEST_F (ScenarioLoadTest, ANoThinkTimeRunsMeanInFlightIsAboutItsUserCount) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/slow"), server.url ("/slow") });

    const size_t VUS = 10;
    const json report = run_to_report (json{ { "mode", "constant_concurrency" },
                                       { "duration", "1s" }, { "concurrency", VUS } },
    execution);
    const json& summary = report.at ("summary");
    ASSERT_TRUE (summary.contains ("avgInFlight")) << summary.dump ();
    const double avg_in_flight = summary.at ("avgInFlight").get<double> ();
    EXPECT_GT (avg_in_flight, static_cast<double> (VUS) / 2.0) << summary.dump ();
    EXPECT_LE (avg_in_flight, static_cast<double> (VUS) + 1e-6) << summary.dump ();
}

// ============================================================================
// Pass duration (#3570)
// ============================================================================

// A pass is its wall clock, from the claim of its first step to the completion
// of its last, so it holds every step's latency and the think wait between
// steps 0 and 1. One user sends its passes one after another, so every request
// is inside a completed pass and the mean pass is at least the think plus three
// times the run's mean latency. Only that lower bound is asserted: the gaps the
// runner adds between steps are its own. The slack is 1 ms for the think
// timer's millisecond clock and 1 ms for the latency histogram's bucket
// rounding. Mutation check: record the last step's latency instead of the span
// in `end_iteration` (or stamp `iteration_started_us` on every claim) and the
// mean reads about 20 ms.
TEST_F (ScenarioLoadTest, APassDurationIsThePassesWallClockTimerWaitsIncluded) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/slow"), server.url ("/slow"), server.url ("/slow") });
    constexpr int64_t THINK_MS       = 100;
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { json{ { "id", "el_think" }, { "kind", "timer.think" },
    { "enabled", true }, { "config", { { "ms", THINK_MS } } } } });

    constexpr size_t PASSES = 4;
    const json report       = run_to_report (
    json{ { "mode", "iterations" }, { "iterations", PASSES }, { "concurrency", 1 } }, execution);
    const json& scenario = report.at ("scenario");
    ASSERT_TRUE (scenario.contains ("passDuration")) << scenario.dump ();
    const json& pass = scenario.at ("passDuration");
    EXPECT_EQ (pass.at ("count").get<size_t> (), PASSES) << pass.dump ();

    const double step_mean_ms = report.at ("latency").at ("avg").get<double> ();
    const double floor_ms = (static_cast<double> (THINK_MS) - 2.0) + (3.0 * step_mean_ms);
    EXPECT_GE (pass.at ("mean").get<double> (), floor_ms)
    << "a pass was shorter than its three steps and its think wait: " << pass.dump ()
    << " against a step mean of " << step_mean_ms << " ms";
    EXPECT_LE (pass.at ("min").get<double> (), pass.at ("p50").get<double> ())
    << pass.dump ();
    EXPECT_LE (pass.at ("p50").get<double> (), pass.at ("p95").get<double> ())
    << pass.dump ();
    EXPECT_LE (pass.at ("p95").get<double> (), pass.at ("p99").get<double> ())
    << pass.dump ();
    EXPECT_LE (pass.at ("p99").get<double> (), pass.at ("max").get<double> ())
    << pass.dump ();
}

// An abandoned pass is `iterationsAbandoned` and no pass time, so the count is
// the completed passes. Rows alternate a reachable step 1 and a refused one, so
// one user completes two passes of four and abandons two. The gate frame's mean
// is the summary's, read off the same sum and count. Mutation check: record in
// `end_iteration`'s abandoned branch too and the count reads 4; drop the
// `meanIterationMs` write in `build_scenario_live_progress` and the frame
// assertion fails.
TEST_F (ScenarioLoadTest, AnAbandonedPassIsNotAPassDuration) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/s0"), "{{data.target}}", server.url ("/s2") });
    with_data (execution,
    { json{ { "target", server.url ("/s1") } },
    json{ { "target", "http://127.0.0.1:1/unreachable" } } });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 4 }, { "concurrency", 1 } }, execution);
    ASSERT_EQ (state->iterations_completed.load (), 2u);
    ASSERT_EQ (state->iterations_abandoned.load (), 2u);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_TRUE (summary.contains ("pass_duration")) << summary.dump ();
    const json& pass = summary.at ("pass_duration");
    EXPECT_EQ (pass.at ("count").get<size_t> (), 2u) << pass.dump ();

    const auto frame = vayu::core::build_scenario_live_progress (*state);
    ASSERT_TRUE (frame.contains ("meanIterationMs")) << frame.dump ();
    EXPECT_DOUBLE_EQ (frame.at ("meanIterationMs").get<double> (),
    pass.at ("mean").get<double> ());
}

// Before a pass completes there is no pass time: the summary leaves
// `pass_duration` out and the gate frame `meanIterationMs`, rather than a 0
// nobody measured. Every pass here is abandoned at step 0. Mutation check:
// write `meanIterationMs` whatever the count in `build_scenario_live_progress`
// and the frame assertion fails.
TEST_F (ScenarioLoadTest, NoPassDurationIsReportedBeforeAPassCompletes) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ "http://127.0.0.1:1/unreachable", server.url ("/s1") });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    ASSERT_EQ (state->iterations_abandoned.load (), 2u);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_FALSE (summary.contains ("pass_duration")) << summary.dump ();
    const auto frame = vayu::core::build_scenario_live_progress (*state);
    EXPECT_TRUE (frame.contains ("iterationsAbandoned")) << frame.dump ();
    EXPECT_FALSE (frame.contains ("meanIterationMs")) << frame.dump ();
}

// ============================================================================
// A skipped step puts nothing in flight (#3540)
// ============================================================================

namespace {

/// A `control.once`: the step runs in a virtual user's first iteration only.
std::shared_ptr<const std::vector<vayu::core::CompiledElement>> once_elements () {
    return vayu::tests::compiled_elements ({ json{ { "id", "el_once" },
    { "kind", "control.once" }, { "enabled", true }, { "config", json::object () } } });
}

} // namespace

// After each virtual user's first iteration every step is skipped, so no
// refill pass puts anything in flight. Healthy, each pass that sent nothing
// waits a controller tick: about users x duration / 50 ms iterations, 40 here
// (42 measured). Broken, the producer re-enters at once on an already-true
// predicate and spins: about 100,000 here (the issue's 3 s run read 215,883).
// Mutation check: drop `idle_pass` from `maintain_concurrency`'s bounded-wait
// condition and this reads 106,628.
TEST_F (ScenarioLoadTest, AnAllSkippedPlanWaitsATickPerPassInsteadOfSpinning) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements = once_elements ();

    const size_t VUS  = 2;
    const json config = { { "mode", "constant_concurrency" },
        { "duration", "1s" }, { "concurrency", VUS } };
    auto state        = run (config, execution);

    EXPECT_EQ (server.hits_for ("/s0").size (), VUS)
    << "control.once must still send its step once per virtual user";
    const size_t iterations = state->iterations_started.load ();
    EXPECT_GT (iterations, VUS) << "the skipped iterations never ran";
    EXPECT_LT (iterations, 2000u)
    << "the producer spun on a pass that sent nothing: " << iterations
    << " iterations in 1s";
}

// A skipped step in front of one that sends is not a pass without work: the
// claim walks the virtual user on to the send, so one user with a skipped
// login sends about as often as one without it. Healthy, the ratio of the two
// runs' sends is about 1. Broken, each skip costs a 50 ms tick, so it is
// round trip / (round trip + 50 ms): about 0.01 on a loopback mock, and under
// 0.2 on a runner whose round trip is 10 ms. A slow runner slows both runs, so
// the ratio holds where a count would not. Mutation check: make `submit_one`
// submit one step and return, and it reads 20 sends against 2,215 (0.98
// healthy).
TEST_F (ScenarioLoadTest, ASkippedStepInFrontOfASendCostsTheVirtualUserNoWait) {
    ScenarioMockServer server;
    const json config  = { { "mode", "constant_concurrency" },
        { "duration", "1s" }, { "concurrency", 1 } };
    auto behind_a_skip = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    behind_a_skip.plan.steps[0].elements = once_elements ();

    // The two runs are one second each and run one after the other, so a
    // stall on a shared runner can land in one arm only (CI read 0.399 against
    // 0.4 with the arms at 10,787 and 4,300 sends). Best of three pairs: a
    // stall lands in one pair, the broken skip cost lands in all of them.
    double best_ratio    = 0.0;
    size_t alone_at_best = 0, behind_at_best = 0;
    size_t attempts = 0;
    for (; attempts < 3 && best_ratio <= 0.4;) {
        ++attempts;
        const size_t before = server.hits_for ("/s1").size ();
        run (config, plan_over ({ server.url ("/s1") }));
        const size_t sends_alone = server.hits_for ("/s1").size () - before;
        const size_t mid         = server.hits_for ("/s1").size ();
        run (config, behind_a_skip);
        const size_t sends_behind_a_skip = server.hits_for ("/s1").size () - mid;

        ASSERT_GT (sends_alone, 0u);
        const double ratio = static_cast<double> (sends_behind_a_skip) /
        static_cast<double> (sends_alone);
        if (ratio > best_ratio) {
            best_ratio     = ratio;
            alone_at_best  = sends_alone;
            behind_at_best = sends_behind_a_skip;
        }
    }
    // control.once sends its step once per virtual user, per run.
    EXPECT_EQ (server.hits_for ("/s0").size (), attempts);
    EXPECT_GT (best_ratio, 0.4) << behind_at_best << " sends behind a skipped step against "
                                << alone_at_best << " without one, best of three";
}

// Every submission fails its data bind (the row leaves the header name blank),
// so nothing goes on the wire and nothing is ever in flight. Each failure is
// still an error, but a pass whose only submissions were failures waits a
// controller tick like an empty pass (#3592). Healthy, one user iterates about
// once per 50 ms: 20 in 1s (a few dozen on a fast runner). Broken, the
// producer re-enters at once and spins: tens of thousands. Mutation check:
// drop the `bind_failures_submitted` delta from `refill_toward`'s return in
// `maintain_concurrency` and the count climbs past the bound.
TEST_F (ScenarioLoadTest, AnAllBindFailurePlanWaitsATickPerPassInsteadOfSpinning) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].request.headers["{{data.name}}"] = "x";
    with_data (execution, { json{ { "name", "" } } });

    const json config = { { "mode", "constant_concurrency" },
        { "duration", "1s" }, { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_TRUE (server.hits_for ("/s0").empty ())
    << "a failed bind must send nothing";
    const size_t errors = context_->metrics_collector->total_errors ();
    EXPECT_GT (errors, 0u) << "each bind failure still counts as an error";
    EXPECT_LT (errors, 2000u) << "the producer spun on failures: " << errors << " errors in 1s";
    EXPECT_EQ (errors, context_->requests_sent.load ())
    << "the error count must reflect the iterations attempted";
}

// ============================================================================
// Cross-VU shared pacing (issue #1570)
// ============================================================================

// `timer.pacing(perUser: false)` holds one cadence across every virtual
// user, not one cadence per user (which `perUser: true` already gave under
// load). Every VU's own first entry is unthrottled (the element has no
// history yet), so ten VUs produce an initial burst of about ten
// completions; every entry after that claims the next slot of the same
// shared 200ms clock, however many VUs are contending for it. Over a 2s run
// that is roughly ten (the burst) plus one more per 200ms tick - nowhere
// near the ~110 ten *independently* paced 200ms cadences would produce in
// the same window (each doing its own burst-of-one plus about nine ticks).
//
// Mutation check: making `TimerPacingElement::scheduled_ready_delay_ms`
// ignore `per_user_` and always take the per-VU `pacing_state` branch
// reproduces that old per-VU rate here too - completions clear 50 - and
// this test reds.
TEST_F (ScenarioLoadTest, SharedPacingHoldsOneCadenceAcrossEveryVirtualUser) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ vayu::tests::timer_pacing_element_json (
    "el_pacing", /*every_ms=*/200, /*scope_entry=*/true, /*per_user=*/false) });

    const size_t VUS  = 10;
    const json config = { { "mode", "constant_concurrency" },
        { "duration", "2s" }, { "concurrency", VUS } };
    auto state        = run (config, execution);

    const size_t completed = state->steps.completed (0);
    EXPECT_GE (completed, VUS) << "not even the unthrottled first-entry burst "
                                  "completed - the shared clock is holding "
                                  "back requests it never saw before";
    EXPECT_LT (completed, 50u)
    << "completed " << completed
    << " over 2s at a shared 200ms cadence - "
       "looks like every virtual user paced itself independently instead "
       "of sharing one clock (ten independent 200ms cadences would clear "
       "100 in this window)";
}

// ============================================================================
// Deferred schema validation over the sampled responses (issue #682)
// ============================================================================

namespace {

/// The stored `response_schemas` text for a plan whose steps are bound to
/// `step<i>` operations, each declaring one 200 response.
///
/// Built through the wire shape rather than a hand-made index so a change to
/// what the app stores fails here rather than passing against a private fixture.
std::string schema_index_for (const std::vector<json>& schemas) {
    json operations = json::array ();
    for (size_t i = 0; i < schemas.size (); ++i) {
        operations.push_back (json{ { "operationId", "step" + std::to_string (i) },
        { "method", "GET" }, { "path", "/s" + std::to_string (i) },
        { "responses",
        json::array ({ json{ { "status", "200" },
        { "contentType", "application/json" }, { "schema", schemas[i] } } }) } });
    }
    return json{ { "refRoots", json::object () }, { "operations", operations } }.dump ();
}

/// Bind every step of @p execution to the operation of the same index, and give
/// the run the index those operations are declared in.
void bind_to_schemas (vayu::core::ScenarioExecution& execution,
const std::vector<json>& schemas) {
    execution.spec.spec_id          = "spec_1";
    execution.spec.spec_hash        = "hash_1";
    execution.spec.response_schemas = schema_index_for (schemas);
    for (size_t i = 0; i < execution.plan.steps.size (); ++i) {
        execution.plan.steps[i].spec_operation = json{
            { "operationId", "step" + std::to_string (i) }, { "method", "GET" },
            { "path", "/s" + std::to_string (i) }
        }.dump ();
    }
}

/// The mock answers every step with `{}`, so this passes and `strict_schema`
/// does not - which is what lets one run produce both verdicts.
json open_schema () {
    return json{ { "type", "object" } };
}

json strict_schema () {
    return json{ { "type", "object" }, { "required", json::array ({ "id" }) } };
}

} // namespace

// A step bound to an operation is sampled even when it carries no script - the
// contract is the second reason to keep a response, and without it a bound
// collection that asserts nothing would validate nothing at all.
//
// Mutation-check: restore the scripted-only condition in `execute_scenario_load`
// and both stores are empty, so every assertion below reddens.
TEST_F (ScenarioLoadTest, ABoundStepIsSampledWithNoScriptOfItsOwn) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    bind_to_schemas (execution, { open_schema (), open_schema () });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto& mc = *context_->metrics_collector;
    EXPECT_GT (mc.step_response_samples (0).size (), 0u)
    << "a step bound to an operation was never sampled, so its contract can "
       "never be checked";
    EXPECT_GT (mc.step_response_samples (1).size (), 0u);
}

// The run's own binding decides it: a plan whose steps name no operation is
// sampled exactly as it was before this existed, so an unbound collection pays
// nothing for a feature it cannot use.
TEST_F (ScenarioLoadTest, AnUnboundPlanStillSamplesOnlyItsScriptedSteps) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('t', function () { });");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto& mc = *context_->metrics_collector;
    EXPECT_GT (mc.step_response_samples (0).size (), 0u);
    EXPECT_EQ (mc.step_response_samples (1).size (), 0u)
    << "an unbound step with no script was sampled - a body-sized copy nothing "
       "will read";
}

TEST_F (ScenarioLoadTest, ABoundRunReportsTalliesOverItsSampledResponses) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    // One operation the mock's `{}` satisfies and one it does not, so a single
    // run produces both verdicts and the partition is observable.
    bind_to_schemas (execution, { open_schema (), strict_schema () });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto totals = vayu::core::validate_sampled_responses (context_);

    EXPECT_EQ (totals.sampled, 6u);
    EXPECT_EQ (totals.checked, 6u);
    EXPECT_EQ (totals.valid, 3u);
    EXPECT_EQ (totals.failed, 3u);
    ASSERT_FALSE (totals.failure_examples.empty ());
    EXPECT_EQ (totals.failure_examples.front ().step, "step1")
    << "the failing step must be named, or a reader cannot act on the example";
    EXPECT_EQ (totals.failure_examples.front ().status, 200);
}

// The gate the whole block turns on: a run of an unbound collection is not a
// run that passed its contract.
//
// Mutation-check: drop the `response_schemas.empty()` guard in
// `validate_sampled_responses` and this reports a block of zeros instead.
TEST_F (ScenarioLoadTest, AnUnboundRunValidatesNothingAtAll) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::step_elements_with_post_script (
    "pm.test('t', function () { });");

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto totals = vayu::core::validate_sampled_responses (context_);
    EXPECT_EQ (totals.sampled, 0u);
    EXPECT_TRUE (vayu::core::build_sampled_validation_payload (totals).empty ())
    << "an unbound run must carry no block at all, never one saying nothing "
       "failed";
}

// A binding whose document carries no schema index is "not measured" too - the
// same spelling coverage gives a document stored before its index existed.
TEST_F (ScenarioLoadTest, ABindingWithNoSchemaIndexValidatesNothing) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    bind_to_schemas (execution, { open_schema () });
    execution.spec.response_schemas.clear ();

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    EXPECT_EQ (vayu::core::validate_sampled_responses (context_).sampled, 0u);
}

// A step the document does not declare is checked and named, rather than
// silently dropped: a collection drifting off its contract is exactly what the
// block is read for.
TEST_F (ScenarioLoadTest, AStepTheDocumentDoesNotDeclareIsCountedByReason) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    bind_to_schemas (execution, { open_schema (), open_schema () });
    // The second step's identity moved off the contract.
    execution.plan.steps[1].spec_operation =
    json{ { "method", "GET" }, { "path", "/ghosts" } }.dump ();

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto totals = vayu::core::validate_sampled_responses (context_);
    EXPECT_EQ (totals.checked, 2u);
    EXPECT_EQ (totals.failed, 0u)
    << "an undeclared operation is not a response that broke its contract";
    EXPECT_EQ (totals.unchecked_reasons.at ("operation_not_declared"), 2u);
}

// The thinning is disclosed rather than hidden: a run whose reservoirs dropped
// candidates reports tallies over what it kept, and the retention counter says
// what it did not.
TEST_F (ScenarioLoadTest, ARunWhoseSamplesWereThinnedStillReportsHonestly) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    bind_to_schemas (execution, { open_schema (), open_schema () });

    const json config = { { "mode", "iterations" }, { "iterations", 8 },
        { "concurrency", 1 }, { "max_response_samples", 4 },
        { "response_sample_rate", 1 } };
    run (config, execution);

    const auto totals = vayu::core::validate_sampled_responses (context_);
    EXPECT_GT (totals.sampled, 0u);
    EXPECT_LE (totals.sampled, 4u)
    << "the pass validated more than the reservoirs could hold";
    EXPECT_LT (totals.sampled, 16u)
    << "16 completions into a 4-sample budget must have been thinned";
    EXPECT_GT (context_->metrics_collector->response_samples_dropped (), 0u)
    << "what was thinned must be reported, or the tallies read as the whole "
       "run";
}

// #3235: a collection whose request is stored with `stream` set runs that step
// as a stream under load. `/sse-ticks` holds its response open for 6 s, far
// past the step's own 200 ms timeout, and the event cap ends it as a success.
// Through the plan `POST /runs` resolves and the run manager that reports it,
// so the stored step result and the run's `stream` section are read back.
// Mutation check: drop the `row.stream` copy in `resolve_step` and the step
// times out at 200 ms - a failure, no event count and no section.
TEST_F (ScenarioLoadTest, AStoredStreamingRequestRunsAsAStreamToItsCap) {
    const vayu::tests::SlowMockServer upstream;

    vayu::db::Collection collection;
    collection.id         = "col_stream";
    collection.name       = "Streams";
    collection.created_at = 1;
    collection.updated_at = 1;
    db_->create_collection (collection);
    vayu::db::Request stored;
    stored.id            = "req_stream";
    stored.collection_id = collection.id;
    stored.name          = "events";
    stored.method        = vayu::HttpMethod::GET;
    stored.url           = upstream.sse_ticks_url ();
    stored.timeout_ms    = 200;
    stored.stream        = true;
    stored.created_at    = 1;
    stored.updated_at    = 1;
    db_->save_request (stored);

    constexpr int64_t EVENT_CAP = 5;
    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "maxStreamEvents", EVENT_CAP },
        { "scenario", { { "source", "collection" }, { "collectionId", collection.id } } } };

    vayu::core::ScenarioResolveOptions options;
    options.timeout_ms           = 30000;
    options.limits.max_steps     = 10;
    options.limits.max_data_rows = 10;
    options.limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;
    options.stream_bounds = vayu::http::resolve_stream_bounds (config,
    vayu::http::default_stream_bounds (vayu::http::read_sse_limits (*db_)));
    auto resolved = vayu::core::resolve_scenario (*db_, config.at ("scenario"), options);
    ASSERT_TRUE (resolved.ok) << resolved.error;
    auto execution     = std::make_shared<vayu::core::ScenarioExecution> ();
    execution->request = std::move (resolved.request);
    execution->plan    = std::move (resolved.plan);
    execution->files   = std::move (resolved.files);

    const std::string run_id = "run_scenario_stream";
    vayu::db::Run run;
    run.id              = run_id;
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Pending;
    run.config_snapshot = config.dump ();
    run.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                     .count ();
    db_->create_run (run);

    vayu::core::RunManager manager;
    ASSERT_TRUE (manager.start_run (run_id, config, *db_, execution));
    ASSERT_TRUE (vayu::tests::wait_until (
    [&] () { return manager.get_run (run_id) == nullptr; }))
    << "the run never finished";

    const auto [status, report] = vayu::http::routes::run_report_response (*db_, run_id);
    ASSERT_EQ (status, 200) << report.dump ();
    const auto& summary = report.at ("summary");
    EXPECT_EQ (summary.at ("successfulRequests").get<size_t> (), 1u) << report.dump ();
    EXPECT_EQ (summary.at ("failedRequests").get<size_t> (), 0u) << report.dump ();
    EXPECT_FALSE (report.at ("errors").at ("types").contains ("timeout"))
    << report.dump ();

    ASSERT_TRUE (report.contains ("stream")) << report.dump ();
    const auto& stream = report.at ("stream");
    EXPECT_EQ (stream.at ("completions").get<size_t> (), 1u) << stream.dump ();
    EXPECT_EQ (stream.at ("totalEvents").get<int64_t> (), EVENT_CAP) << stream.dump ();
    EXPECT_EQ (stream.at ("capped").get<size_t> (), 1u) << stream.dump ();

    const auto bodies = db_->get_result_bodies_paginated (run_id, 10, 0);
    ASSERT_EQ (bodies.size (), 1u) << "the step's exchange was not stored";
    ASSERT_HAS_VALUE (bodies.front ().stream_events);
    EXPECT_EQ (*bodies.front ().stream_events, EVENT_CAP);

    manager.shutdown ();
}
