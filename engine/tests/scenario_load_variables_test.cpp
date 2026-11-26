/**
 * @file tests/scenario_load_variables_test.cpp
 * @brief Load-mode scenario runs: per-VU variable flow (extracted and saved values, misses
 * and unsets), script time in the recorded latency, per-step element tallies and the
 * report's scenario assertions.
 *
 * The `ScenarioLoadTest` fixture and its mock server are in `scenario_load_fixture.hpp`.
 */

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "vayu/core/scenario_load.hpp"

#include <gtest/gtest.h>

#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include <httplib.h>

#include "echo_server.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/sse_stream.hpp"

#include "scenario_load_fixture.hpp"

using nlohmann::json;
using vayu::tests::scenario_load::one_inline_script;
using vayu::tests::scenario_load::ScenarioLoadTest;
using vayu::tests::scenario_load::ScenarioMockServer;

namespace {

/// What an inline script reads about its own execution, as one string:
/// `vu/iteration/row/bare-column|replaceIn(vu/iteration/data.user)`. The row
/// half is guarded so an unbound row reads `no-row` rather than throwing,
/// which keeps a failure's message about the value that was wrong.
constexpr const char* SEEN_IDENTITY_JS =
"(pm.info.vu + '/' + pm.info.iteration + '/' +"
" (pm.iterationData ? pm.iterationData.get('user') : 'no-row') + '/' +"
" pm.variables.get('user') + '|' +"
" pm.variables.replaceIn('{{$vu}}/{{$iteration}}/{{data.user}}'))";

/// What the binder itself writes for @ref SEEN_IDENTITY_JS's fields, sent as
/// `X-Bound`, so a script's reading can be compared with the request it ran
/// beside.
constexpr const char* BOUND_IDENTITY_TEMPLATE =
"{{$vu}}/{{$iteration}}/{{data.user}}/{{data.user}}|"
"{{$vu}}/{{$iteration}}/{{data.user}}";

} // namespace

// #3124: an inline `script.pre` under load reads the virtual user, the
// iteration and the row its own execution was bound with - two users, so the
// pairing is per execution rather than per run. Mutation check: pass a null
// row to `bind_step_identity` in `run_step_before` and every `X-Seen` reads
// `.../no-row/undefined|.../{{data.user}}`.
TEST_F (ScenarioLoadTest, AnInlineScriptPreReadsTheRowIterationAndUserItsStepWasBoundWith) {
    constexpr size_t ITERATIONS = 4;
    vayu::tests::EchoServer echo;
    auto execution = plan_over ({ echo.url () });
    execution.plan.steps[0].request.headers["X-Bound"] = BOUND_IDENTITY_TEMPLATE;
    with_data (execution, { json{ { "user", "ada" } }, json{ { "user", "bob" } } });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ one_inline_script ("script.pre",
    std::string ("pm.request.headers['X-Seen'] = ") + SEEN_IDENTITY_JS + ";") });

    run (json{ { "mode", "iterations" }, { "iterations", ITERATIONS }, { "concurrency", 2 } },
    execution, /*pool_size=*/2);

    const auto bound = echo.header_per_request ("X-Bound");
    ASSERT_EQ (bound.size (), ITERATIONS);
    EXPECT_EQ (std::set<std::string> (bound.begin (), bound.end ()).size (), ITERATIONS)
    << "two executions were bound as the same user and iteration";
    EXPECT_EQ (echo.header_per_request ("X-Seen"), bound);
}

// The completion side: an inline `script.post` reads what the request it ran
// beside was bound with. Mutation check: pass a null row to
// `bind_step_identity` in `run_step_after` and this test fails.
TEST_F (ScenarioLoadTest, AnInlineScriptPostReadsTheRowIterationAndUserOfTheRequestItRanBeside) {
    constexpr size_t ITERATIONS = 4;
    vayu::tests::EchoServer echo;
    auto execution = plan_over ({ echo.url () });
    execution.plan.steps[0].request.headers["X-Bound"] = BOUND_IDENTITY_TEMPLATE;
    with_data (execution, { json{ { "user", "ada" } }, json{ { "user", "bob" } } });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ one_inline_script ("script.post",
    std::string ("pm.test('beside', function () { pm.expect(") +
    SEEN_IDENTITY_JS + ").to.equal(pm.request.headers.get('X-Bound')); });") });

    const auto state = run (json{ { "mode", "iterations" },
                            { "iterations", ITERATIONS }, { "concurrency", 2 } },
    execution, /*pool_size=*/2);

    EXPECT_EQ (state->inline_tests_passed.load (), ITERATIONS);
    EXPECT_EQ (state->inline_tests_failed.load (), 0u);
}

// #2521: the same correlation through a plan `resolve_scenario` composed from
// stored requests, whose collection already holds a `token`. The bearer step
// carries no element, so only the plan-wide rule leaves its `{{token}}` for the
// per-VU pass. Mutation check: make `plan_variable_deferral` (scenario_plan.cpp)
// answer `WhenScripted`, and every VU sends `Bearer old`.
TEST_F (ScenarioLoadTest, APlannedStepSendsTheTokenAnEarlierStepExtractedNotTheStoredOne) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    const auto execution = resolve_login_then_bearer (server,
    json::array ({ vayu::tests::extract_json_element_json ("el_token", "$.token", "token") }));

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    for (const auto& echo : echoes) {
        ASSERT_TRUE (echo.cookie.rfind ("sid=", 0) == 0)
        << "no session reached step 1";
        EXPECT_EQ (echo.authorization, "Bearer tok-" + echo.cookie.substr (4));
    }
}

// The same through an inline `script.post`, the test-script login.
TEST_F (ScenarioLoadTest, APlannedStepSendsTheTokenAnEarlierInlineTestScriptSet) {
    ScenarioMockServer server;
    const auto execution = resolve_login_then_bearer (server,
    json::array ({ vayu::tests::script_element_json ("el_post", "script.post",
    "pm.collectionVariables.set('token', pm.response.json().token);",
    /*inline_script=*/true) }));

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 3u);
    for (size_t i = 0; i < echoes.size (); ++i) {
        EXPECT_EQ (echoes[i].authorization, "Bearer tok-" + std::to_string (i + 1));
    }
}

// ============================================================================
// What an iteration boundary resets (#3044): the session and the run-local
// scope, never the variables a virtual user saved
// ============================================================================

namespace {

/// `/login` fired once per virtual user, its `$.token` saved as `token`.
std::shared_ptr<const std::vector<vayu::core::CompiledElement>> login_once_elements () {
    return vayu::tests::compiled_elements (
    { json{ { "id", "el_once" }, { "kind", "control.once" },
      { "enabled", true }, { "config", json::object () } },
    vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });
}

} // namespace

// The issue's repro: a `control.once` login extracts the token in iteration 1
// and every later iteration's step 1 still sends it, while the login's cookie
// is gone from iteration 2 on. Mutation check: clear the whole overlay in
// `end_iteration` and iterations 2 and 3 send the literal `Bearer {{token}}`.
TEST_F (ScenarioLoadTest, AControlOnceLoginsTokenReachesEveryLaterIteration) {
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = login_once_elements ();

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    run (config, execution, /*pool_size=*/1);

    ASSERT_EQ (server.hits_for ("/login").size (), 1u)
    << "control.once let the login run again";
    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 3u);
    for (size_t i = 0; i < echoes.size (); ++i) {
        EXPECT_EQ (echoes[i].authorization, "Bearer tok-1")
        << "iteration " << i + 1 << " lost the token the login saved";
    }
    EXPECT_EQ (echoes[0].cookie, "sid=1");
    EXPECT_EQ (echoes[1].cookie, "")
    << "the login's session outlived its iteration";
    EXPECT_EQ (echoes[2].cookie, "");
}

// A `pm.variables.set` value is the run-local scope, which starts every
// iteration empty: step 1 reads this iteration's value, and the next
// iteration's step 0 finds none. Mutation check: make `clear_local` a no-op
// and the second `/echo` sends `Bearer local-0`.
TEST_F (ScenarioLoadTest, ALocalValueLastsOneIteration) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo"), server.url ("/s0") });
    for (auto& step : execution.plan.steps) {
        step.request.headers["Authorization"] = "Bearer {{seen}}";
    }
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.variables.set('seen', 'local-' + pm.info.iteration);", /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    const auto after  = server.hits_for ("/s0");
    ASSERT_EQ (echoes.size (), 2u);
    ASSERT_EQ (after.size (), 2u);
    EXPECT_EQ (after[0].authorization, "Bearer local-0");
    EXPECT_EQ (after[1].authorization, "Bearer local-1");
    EXPECT_EQ (echoes[0].authorization, "Bearer {{seen}}");
    EXPECT_EQ (echoes[1].authorization, "Bearer {{seen}}")
    << "iteration 1's run-local value reached iteration 2";
}

// A bare data column is bound from the iteration's own row before any saved
// variable is read, so a name the VU saved in iteration 1 cannot answer for
// iteration 2's row.
TEST_F (ScenarioLoadTest, ASavedVariableDoesNotShadowTheNextRowsColumn) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{id}}"), server.url ("/login") });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_id", "$.token", "id") });
    execution.data_rows = { json{ { "id", "0" } }, json{ { "id", "1" } } };
    const auto columns  = vayu::core::bound_columns_of (execution.data_rows);
    for (auto& step : execution.plan.steps) {
        step.data_template = vayu::core::tokenize_bindable_fields (step.request, columns);
    }

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    std::vector<std::string> rows;
    for (const auto& hit : server.hits ()) {
        if (hit.path.rfind ("/row/", 0) == 0) {
            rows.push_back (hit.path);
        }
    }
    EXPECT_EQ (rows, (std::vector<std::string>{ "/row/0", "/row/1" }))
    << "iteration 1's saved `id` answered for iteration 2's row";
}

// Two virtual users each keep their own login's token across iterations,
// never the other's. Step 1 sends to `/row/{{$vu}}`, so each echo names the
// user that sent it.
TEST_F (ScenarioLoadTest, TwoVirtualUsersKeepTheirOwnSavedTokenAcrossIterations) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_login_then_bearer (server, server.url ("/row/{{$vu}}"));
    execution.plan.steps[0].elements = login_once_elements ();
    split_steps (execution);

    const json config = { { "mode", "iterations" }, { "iterations", 6 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    ASSERT_EQ (server.hits_for ("/login").size (), 2u);
    std::map<std::string, std::set<std::string>> tokens_by_vu;
    size_t echoes = 0;
    for (const auto& hit : server.hits ()) {
        if (hit.path.rfind ("/row/", 0) == 0) {
            tokens_by_vu[hit.path].insert (hit.authorization);
            ++echoes;
        }
    }
    EXPECT_EQ (echoes, 6u);
    ASSERT_EQ (tokens_by_vu.size (), 2u) << "both users must have sent step 1";
    std::set<std::string> distinct;
    for (const auto& [vu, tokens] : tokens_by_vu) {
        ASSERT_EQ (tokens.size (), 1u) << vu << " sent more than one token across its iterations";
        EXPECT_EQ (tokens.begin ()->rfind ("Bearer tok-", 0), 0u)
        << vu << " sent " << *tokens.begin ();
        distinct.insert (*tokens.begin ());
    }
    EXPECT_EQ (distinct.size (), 2u) << "the two users sent the same token";
}

// ----------------------------------------------------------------------------
// An extractor's miss unsets the variable (#3053): the VU's own earlier value
// goes, and the run's stored value is hidden for that VU alone.
// ----------------------------------------------------------------------------

namespace {

/// `col_test`, the collection `plan_over` names, storing `token=old`: the
/// shared base value an overlay cannot erase, only hide.
void store_old_token (vayu::db::Database& db) {
    vayu::db::Collection collection;
    collection.id         = "col_test";
    collection.name       = "Collection";
    collection.variables  = R"({"token":{"value":"old","enabled":true}})";
    collection.created_at = 1;
    collection.updated_at = 1;
    db.create_collection (collection);
}

} // namespace

// Each row picks the endpoint step 0 extracts from: `/login` answers a token,
// `/s0` answers `{}`. Mutation check: drop the `unset` in `write_miss`
// (extract_kinds.cpp) and the second iteration sends `Bearer tok-1` again.
TEST_F (ScenarioLoadTest, AMissSendsTheUnresolvedNameNotTheLastIterationsValue) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/{{data.from}}"), server.url ("/echo") });
    execution.plan.steps[1].request.headers["Authorization"] =
    "Bearer {{token}}";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });
    with_data (execution,
    { json{ { "from", "login" } }, json{ { "from", "s0" } }, json{ { "from", "login" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 3u);
    EXPECT_EQ (echoes[0].authorization, "Bearer tok-1");
    EXPECT_EQ (echoes[1].authorization, "Bearer {{token}}")
    << "iteration 2's miss left iteration 1's token in use";
    EXPECT_EQ (echoes[2].authorization, "Bearer tok-2")
    << "a later hit sets it again";
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps"][1]["unresolvedTokens"], 1);
    // The one miss, on the step that missed (#3053); the step with no
    // extractor carries no key. Mutation check: drop the `is_extractor_miss`
    // count in `StepElementTallies::record` (scenario_load.cpp) and this fails.
    EXPECT_EQ (summary["steps"][0].value ("extractorMisses", 0), 1);
    EXPECT_FALSE (summary["steps"][1].contains ("extractorMisses"));
}

// A step whose request fails in transport (#3089) runs its extractors against
// the status-0 response like the sequential run: the variable is unset and the
// miss counted. The refused port is one a server bound and released, so no
// port is fixed. Mutation check: drop the `run_step_after` call in the
// completion callback's response branch (scenario_load.cpp) and the miss count
// reads 0.
TEST_F (ScenarioLoadTest, ATransportFailedExtractingStepUnsetsItsVariableAndCountsAMiss) {
    int dead_port = 0;
    {
        httplib::Server released;
        dead_port = released.bind_to_any_port ("127.0.0.1");
    }
    ASSERT_GT (dead_port, 0);

    ScenarioMockServer server;
    auto execution = plan_over ({ "{{data.from}}", server.url ("/echo") });
    execution.plan.steps[1].request.headers["Authorization"] =
    "Bearer {{token}}";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });
    with_data (execution,
    { json{ { "from", server.url ("/login") } },
    json{ { "from", "http://127.0.0.1:" + std::to_string (dead_port) + "/login" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_GE (echoes.size (), 1u);
    EXPECT_EQ (echoes[0].authorization, "Bearer tok-1");
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps"][0].value ("extractorMisses", 0), 1)
    << summary["steps"][0];
}

// Every iteration hits, or misses into a `default`: neither is a miss, and
// the key is absent rather than `0`.
TEST_F (ScenarioLoadTest, AHitOrADefaultAnsweredMissCountsNoExtractorMiss) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/login") });
    auto rescued = vayu::tests::extract_json_element_json ("el_id", "$.absent", "id");
    rescued["config"]["default"]     = "none";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_token", "$.token", "token"), rescued });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_EQ (summary["steps"][0]["executed"], 2);
    EXPECT_FALSE (summary["steps"][0].contains ("extractorMisses"))
    << summary["steps"][0];
}

// A `control.once` login that misses: the stored `token=old` is hidden from
// iteration 1 on, through the inline script after the extractor
// (`materialize`, then `replace_from`) and every later iteration's
// `clear_local`. Mutation check: drop the tombstone in `apply_onto` and
// iterations 2 and 3 send `Bearer old`.
TEST_F (ScenarioLoadTest, AMissHidesTheStoredValueForEveryLaterIteration) {
    store_old_token (*db_);
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { json{ { "id", "el_once" }, { "kind", "control.once" },
      { "enabled", true }, { "config", json::object () } },
    vayu::tests::extract_json_element_json ("el_token", "$.absent", "token"),
    vayu::tests::script_element_json ("el_post", "script.post",
    "pm.collectionVariables.set('seen', 'yes');", /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    run (config, execution, /*pool_size=*/1);

    ASSERT_EQ (server.hits_for ("/login").size (), 1u);
    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 3u);
    for (size_t i = 0; i < echoes.size (); ++i) {
        EXPECT_EQ (echoes[i].authorization, "Bearer {{token}}")
        << "iteration " << i + 1 << " sent the stored value the miss unset";
    }
}

// Two VUs over one stored `token=old`: the `s0` row's VU runs the extractor
// and misses, the `s1` row's VU skips step 0 (`control.if`) and extracts
// nothing. The `/login` rendezvous holds the second until the first has
// missed, so a tombstone that reached the shared base would show. Each step 2
// names its row's VU.
TEST_F (ScenarioLoadTest, AMissHidesTheStoredValueForThatVirtualUserAlone) {
    store_old_token (*db_);
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_over ({ server.url ("/{{data.from}}"),
    server.url ("/login"), server.url ("/row/{{data.from}}") });
    execution.plan.steps[2].request.headers["Authorization"] =
    "Bearer {{token}}";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_if" }, { "kind", "control.if" }, { "enabled", true },
      { "config", { { "condition", "{{data.from}} == s0" } } } },
    vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });
    with_data (execution, { json{ { "from", "s0" } }, json{ { "from", "s1" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    const auto missed  = server.hits_for ("/row/s0");
    const auto skipped = server.hits_for ("/row/s1");
    ASSERT_EQ (missed.size (), 1u);
    ASSERT_EQ (skipped.size (), 1u);
    EXPECT_EQ (missed[0].authorization, "Bearer {{token}}");
    EXPECT_EQ (skipped[0].authorization, "Bearer old")
    << "one virtual user's unset reached another's view of the stored value";
}

// ----------------------------------------------------------------------------
// A script's own `pm.environment.unset` of a stored name (#3088) is kept the
// way an extractor's miss is: hidden for that VU until it sets the name again.
// ----------------------------------------------------------------------------

namespace {

constexpr const char* TOKEN_ENVIRONMENT_ID = "env_test";

/// An environment storing `tok=stored`, the shared base value a script's
/// unset can only hide.
void store_environment_token (vayu::db::Database& db) {
    vayu::db::Environment environment;
    environment.id         = TOKEN_ENVIRONMENT_ID;
    environment.name       = "Environment";
    environment.variables  = R"({"tok":{"value":"stored","enabled":true}})";
    environment.created_at = 1;
    environment.updated_at = 1;
    db.save_environment (environment);
}

json inline_post_script (const std::string& id, const std::string& source) {
    return vayu::tests::script_element_json (id, "script.post", source, /*inline_script=*/true);
}

} // namespace

// Step 0 unsets, step 1 sends `{{tok}}` and then sets it, step 2 sends it
// again. Mutation check: skip the base-name loop in
// `ScopeOverlay::replace_from` and step 1 sends `Bearer stored`.
TEST_F (ScenarioLoadTest, AScriptsUnsetOfAStoredNameSticksUntilAScriptSetsItAgain) {
    store_environment_token (*db_);
    ScenarioMockServer server;
    auto execution = plan_over (
    { server.url ("/s0"), server.url ("/echo"), server.url ("/row/after-set") });
    execution.plan.steps[1].request.headers["Authorization"] = "Bearer {{tok}}";
    execution.plan.steps[2].request.headers["Authorization"] = "Bearer {{tok}}";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { inline_post_script ("el_unset", "pm.environment.unset('tok');") });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { inline_post_script ("el_set", "pm.environment.set('tok', 'again');") });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution, /*pool_size=*/1, TOKEN_ENVIRONMENT_ID);

    const auto unset = server.hits_for ("/echo");
    const auto reset = server.hits_for ("/row/after-set");
    ASSERT_EQ (unset.size (), 1u);
    ASSERT_EQ (reset.size (), 1u);
    EXPECT_EQ (unset[0].authorization, "Bearer {{tok}}")
    << "the stored value answered after the script unset it";
    EXPECT_EQ (reset[0].authorization, "Bearer again");
}

// Two VUs over one stored `tok`: the `s0` row's VU runs step 0's unsetting
// script, the `s1` row's VU skips step 0 (`control.if`). The `/login`
// rendezvous holds the second until the first has unset, so a tombstone that
// reached the shared base would show. Each step 2 names its row's VU.
TEST_F (ScenarioLoadTest, AScriptsUnsetOfAStoredNameHidesItForThatVirtualUserAlone) {
    store_environment_token (*db_);
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_over ({ server.url ("/{{data.from}}"),
    server.url ("/login"), server.url ("/row/{{data.from}}") });
    execution.plan.steps[2].request.headers["Authorization"] = "Bearer {{tok}}";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_if" }, { "kind", "control.if" }, { "enabled", true },
      { "config", { { "condition", "{{data.from}} == s0" } } } },
    inline_post_script ("el_unset", "pm.environment.unset('tok');") });
    with_data (execution, { json{ { "from", "s0" } }, json{ { "from", "s1" } } });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2, TOKEN_ENVIRONMENT_ID);

    const auto unsetting = server.hits_for ("/row/s0");
    const auto skipping  = server.hits_for ("/row/s1");
    ASSERT_EQ (unsetting.size (), 1u);
    ASSERT_EQ (skipping.size (), 1u);
    EXPECT_EQ (unsetting[0].authorization, "Bearer {{tok}}");
    EXPECT_EQ (skipping[0].authorization, "Bearer stored")
    << "one virtual user's unset reached another's view of the stored value";
}

// Without the `inline` mark, a `script.post` element stays exactly where it
// always was - deferred to the post-run replay - and the run's wire traffic
// is byte-for-byte what it was before issue #1495: `{{token}}` reaches the
// wire literally, and it counts as an unresolved token rather than silently
// vanishing.
//
// Mutation check: mark the element `inline` (as the test above does) and this
// assertion reds - the literal token would resolve instead.
TEST_F (ScenarioLoadTest, WithoutTheInlineMarkAScriptPostStaysDeferredAndTheWireIsUnchanged) {
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.environment.set('token', pm.response.json().token);") }); // no inline mark

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 1u);
    EXPECT_EQ (echoes[0].authorization, "Bearer {{token}}")
    << "an un-inlined script must not affect this run's wire traffic at all";

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps"][1]["unresolvedTokens"], 1)
    << "the literal token must still be counted, exactly as an unresolved "
       "token always has been";
}

// A `script.pre` marked `inline` reaches the wire on *every* submission, not
// only the first - proving the hook runs from the producer's own steady-state
// loop rather than once at setup.
TEST_F (ScenarioLoadTest, AScriptPreMarkedInlineReachesTheWireOnEverySubmission) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/echo") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_pre", "script.pre",
    "pm.request.headers.upsert('Authorization', 'Bearer injected');",
    /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 3u);
    for (const auto& echo : echoes) {
        EXPECT_EQ (echo.authorization, "Bearer injected");
    }
}

// A step's recorded latency is its transfer alone by default - an inline
// element's own time is not folded in - and `elements.includeScriptTime`
// opts a run into folding it back. Asserted as a *relative* difference
// between two otherwise-identical runs, one with the override and one
// without, rather than against an absolute millisecond floor: a shared CI
// machine's baseline transfer latency is itself noisy, but the gap this
// deliberately slow inline script (a bounded busy loop - a sandboxed script
// cannot sleep) opens between the two runs is not - tens of milliseconds of
// real interpreted work, well past any jitter one more request on the same
// mock could introduce.
TEST_F (ScenarioLoadTest, IncludeScriptTimeFoldsThePipelinesTimeIntoTheRecordedLatency) {
    ScenarioMockServer server;
    const std::string slow_script =
    "let s = 0; for (let i = 0; i < 8000000; i++) { s += i; }";

    auto excluded_execution = plan_over ({ server.url ("/echo") });
    excluded_execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ vayu::tests::script_element_json (
    "el_post", "script.post", slow_script, /*inline_script=*/true) });
    const json excluded_config    = { { "mode", "iterations" },
        { "iterations", 1 }, { "concurrency", 1 } };
    auto excluded_state           = run (excluded_config, excluded_execution);
    const double excluded_latency = vayu::core::build_scenario_load_summary (
    *excluded_state, excluded_execution.plan)["steps"][0]["latency"]["min"];

    auto included_execution = plan_over ({ server.url ("/echo") });
    included_execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ vayu::tests::script_element_json (
    "el_post", "script.post", slow_script, /*inline_script=*/true) });
    const json included_config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "elements", { { "includeScriptTime", true } } } };
    auto included_state           = run (included_config, included_execution);
    const double included_latency = vayu::core::build_scenario_load_summary (
    *included_state, included_execution.plan)["steps"][0]["latency"]["min"];

    EXPECT_GT (included_latency - excluded_latency, 15.0)
    << "excluded=" << excluded_latency << "ms included=" << included_latency
    << "ms - `elements.includeScriptTime` must fold the slow script's own "
       "time into the recorded latency, which this margin should show "
       "however noisy the machine's own baseline transfer latency is";
}

namespace {
/// The step and the run record one completion's latency as the same double,
/// in histograms of the same precision, so their maxima differ by no more
/// than the microsecond the run's histogram floors a value to.
constexpr double HISTOGRAM_ROUNDING_MS = 0.001;
} // namespace

// The step's latency and the run's are one population under
// `includeScriptTime` (#2792): a run whose max sat below a step's reported a
// step slower than any request of the run. Compared within one run, so the
// machine's speed cancels out; the flag-off run shows the run's figure moves
// as far as the step's does. Mutation check: drop `annotations.script_ms`
// from the run's latency in record_successful_response and the run's max
// falls to the transfer alone, below the step's.
TEST_F (ScenarioLoadTest, IncludeScriptTimeMovesTheRunsLatencyWithTheSteps) {
    ScenarioMockServer server;
    const std::string slow_script =
    "let s = 0; for (let i = 0; i < 8000000; i++) { s += i; }";
    struct Maxima {
        double step = 0.0;
        double run  = 0.0;
    };
    const auto measure = [&] (bool include_script_time) {
        auto execution = plan_over ({ server.url ("/echo") });
        execution.plan.steps[0].elements =
        vayu::tests::compiled_elements ({ vayu::tests::script_element_json (
        "el_post", "script.post", slow_script, /*inline_script=*/true) });
        const json config = { { "mode", "iterations" }, { "iterations", 1 },
            { "concurrency", 1 },
            { "elements", { { "includeScriptTime", include_script_time } } } };
        auto state        = run (config, execution);
        return Maxima{ state->steps.percentiles (0).max,
            context_->metrics_collector->calculate_percentiles ().max };
    };

    const Maxima excluded = measure (false);
    const Maxima included = measure (true);

    EXPECT_GE (included.run, included.step - HISTOGRAM_ROUNDING_MS)
    << "step=" << included.step << "ms run=" << included.run
    << "ms - the run's max sits below its own step's";
    EXPECT_GE (included.run - excluded.run,
    (included.step - excluded.step) - (2.0 * HISTOGRAM_ROUNDING_MS))
    << "the flag moved the step's max by " << (included.step - excluded.step)
    << "ms and the run's by only " << (included.run - excluded.run) << "ms";
}

// The same rule for a failed transfer (#2384): under `includeScriptTime` the
// step's duration carries its pipeline time, and so does the run's, so the
// run's max is at least the step's (#2792). Mutation check: drop
// `annotations.script_ms` from the AttemptDuration in record_failed_response
// and the run's max falls to the transfer alone, below the step's.
TEST_F (ScenarioLoadTest, IncludeScriptTimeFoldsThePipelineIntoAFailedTransfersRunLatency) {
    auto execution = plan_over ({ "http://127.0.0.1:1/unreachable" });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "let s = 0; for (let i = 0; i < 8000000; i++) { s += i; }",
    /*inline_script=*/true) });
    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "elements", { { "includeScriptTime", true } } } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.no_response (0), 1u) << "port 1 answered";
    ASSERT_EQ (state->steps.latency_samples (0), 1u);
    const double step_ms = state->steps.percentiles (0).max;
    const double run_ms = context_->metrics_collector->calculate_percentiles ().max;
    EXPECT_GE (run_ms, step_ms - HISTOGRAM_ROUNDING_MS)
    << "step=" << step_ms << "ms run=" << run_ms
    << "ms - the run's max left out the failed step's script time";
}

// `elements.scripts: "allInline"` forces every `script.*` element inline
// regardless of its own `config.inline` - the override, not the per-element
// mark, decides.
TEST_F (ScenarioLoadTest, ElementsScriptsAllInlineForcesAnUnmarkedScriptInline) {
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.environment.set('token', pm.response.json().token);") }); // no inline mark

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "elements", { { "scripts", "allInline" } } } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 1u);
    EXPECT_NE (echoes[0].authorization, "Bearer {{token}}")
    << "the run override must force the unmarked script inline";
}

// `elements.scripts: "allDeferred"` forces every `script.*` element deferred
// regardless of its own `inline` mark.
TEST_F (ScenarioLoadTest, ElementsScriptsAllDeferredIgnoresAPerElementInlineMark) {
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.environment.set('token', pm.response.json().token);", /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "elements", { { "scripts", "allDeferred" } } } };
    run (config, execution);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 1u);
    EXPECT_EQ (echoes[0].authorization, "Bearer {{token}}")
    << "the run override must defer the marked script regardless of its own "
       "mark";
}

// Per-step, per-element pass/fail/skip tallies (issue #1495): an inline
// element that ran reports its outcome under `elements`, and a step with no
// elements carries no such key at all.
TEST_F (ScenarioLoadTest, PerStepElementTalliesAreAttachedToTheBreakdown) {
    ScenarioMockServer server;
    auto execution = plan_login_then_bearer (server, server.url ("/echo"));
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::extract_json_element_json ("el_token", "$.token", "token") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_TRUE (summary["steps"][0].contains ("elements"));
    const auto& elements = summary["steps"][0]["elements"];
    ASSERT_EQ (elements.size (), 1u);
    EXPECT_EQ (elements[0]["id"], "el_token");
    EXPECT_EQ (elements[0]["kind"], "extract.json");
    EXPECT_EQ (elements[0]["passed"], 2);
    EXPECT_EQ (elements[0]["failed"], 0);
    EXPECT_EQ (elements[0]["skipped"], 0);
    EXPECT_EQ (elements[0]["deferred"], 0);
    EXPECT_FALSE (summary["steps"][1].contains ("elements"))
    << "a step with no elements at all must carry no such key";
}

// A miss and an error are tallied as themselves (#3051), not folded into
// `skipped` and `failed`, and each row names its element: its label, the level
// it came from, and that it is required, which is what turns a miss into a
// failed step. Mutation check: fold `"missing"` back into `skipped` in
// `ElementOutcomeCounts::record` (pipeline.cpp) and `missing` reads 0.
TEST_F (ScenarioLoadTest, AMissAndAnErrorAreTalliedAsThemselvesOnANamedRow) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/login") });
    auto required =
    vayu::tests::extract_json_element_json ("el_needed", "$.nope", "needed");
    required["name"]   = "Session id";
    required["origin"] = { { "kind", "request" }, { "scope", "request" },
        { "id", "req_login" } };
    required["config"]["required"] = true;
    // Not a JSONPath (no leading `$`): compiled directly, past the validation
    // that would refuse it, so it errors on every response.
    auto broken = vayu::tests::extract_json_element_json ("el_broken", "token", "broken");
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ required, broken });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    const auto& elements = summary["steps"][0]["elements"];
    ASSERT_EQ (elements.size (), 2u) << summary.dump ();
    const auto& needed = elements[0];
    EXPECT_EQ (needed["id"], "el_needed");
    EXPECT_EQ (needed["name"], "Session id");
    EXPECT_EQ (needed["origin"]["id"], "req_login");
    EXPECT_EQ (needed["required"], true);
    EXPECT_EQ (needed["missing"], 2) << needed.dump ();
    EXPECT_EQ (needed["skipped"], 0) << needed.dump ();
    EXPECT_EQ (needed["failed"], 0) << needed.dump ();

    const auto& errored = elements[1];
    EXPECT_EQ (errored["id"], "el_broken");
    EXPECT_FALSE (errored.contains ("name"));
    EXPECT_FALSE (errored.contains ("origin"));
    EXPECT_FALSE (errored.contains ("required"));
    EXPECT_EQ (errored["error"], 2) << errored.dump ();
    EXPECT_EQ (errored["failed"], 0) << errored.dump ();
}

// Ids are unique within a level, not across one: a collection's element and
// the request's own can share one. Each keeps its own row, counts and label,
// told apart by its origin. Mutation check: match `ElementSlotIndex::find`
// (pipeline.cpp) by id alone and the two rows fold into one of 4 misses.
TEST_F (ScenarioLoadTest, ElementsSharingAnIdAcrossLevelsKeepTheirOwnRows) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/login") });
    auto inherited = vayu::tests::extract_json_element_json ("el_1", "$.nope", "a");
    inherited["name"]   = "From the collection";
    inherited["origin"] = { { "kind", "collection" }, { "scope", "collection" },
        { "id", "col_1" } };
    auto own = vayu::tests::extract_json_element_json ("el_1", "$.nope", "b");
    own["name"] = "The request's own";
    own["origin"] = { { "kind", "request" }, { "scope", "request" }, { "id", "req_1" } };
    own["config"]["required"] = true;
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ inherited, own });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    const auto& elements = summary["steps"][0]["elements"];
    ASSERT_EQ (elements.size (), 2u) << summary.dump ();
    EXPECT_EQ (elements[0]["name"], "From the collection");
    EXPECT_EQ (elements[0]["origin"]["id"], "col_1");
    EXPECT_FALSE (elements[0].contains ("required"));
    EXPECT_EQ (elements[0]["missing"], 2) << elements[0].dump ();
    EXPECT_EQ (elements[1]["name"], "The request's own");
    EXPECT_EQ (elements[1]["origin"]["id"], "req_1");
    EXPECT_EQ (elements[1]["required"], true);
    EXPECT_EQ (elements[1]["missing"], 2) << elements[1].dump ();
}

// A deferral is its own count (#2144): an un-inlined `script.post` is left to
// the post-run replay, so it runs - later - and must not read as a script
// that was never run. The two skips that are not deferrals stay `skipped`:
// an un-inlined `script.pre` has no replay to go to, and a disabled element
// is never offered to the deferral hook at all.
TEST_F (ScenarioLoadTest, AnUninlinedScriptPostTalliesDeferredNotSkipped) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo") });
    auto disabled  = vayu::tests::script_element_json (
    "el_disabled", "script.post", "pm.test('never', function () {});");
    disabled["enabled"]              = false;
    execution.plan.steps[0].elements = vayu::tests::compiled_elements ({
    vayu::tests::script_element_json ("el_post",
    "script.post", "pm.test('status', function () { pm.expect(pm.response.code).to.equal(200); });"),
    vayu::tests::script_element_json ("el_pre", "script.pre", "pm.variables.set('a', '1');"),
    disabled,
    });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_TRUE (summary["steps"][0].contains ("elements")) << summary.dump ();
    const auto& elements = summary["steps"][0]["elements"];
    ASSERT_EQ (elements.size (), 3u) << summary.dump ();
    const auto row = [&elements] (const std::string& id) {
        for (const auto& entry : elements) {
            if (entry["id"] == id) {
                return entry;
            }
        }
        return json ();
    };

    EXPECT_EQ (row ("el_post")["deferred"], 3) << summary.dump ();
    EXPECT_EQ (row ("el_post")["skipped"], 0) << summary.dump ();
    EXPECT_EQ (row ("el_pre")["skipped"], 3) << summary.dump ();
    EXPECT_EQ (row ("el_pre")["deferred"], 0) << summary.dump ();
    EXPECT_EQ (row ("el_disabled")["skipped"], 3) << summary.dump ();
    EXPECT_EQ (row ("el_disabled")["deferred"], 0) << summary.dump ();
}

// Every un-inlined, enabled `script.post` of a step is replayed, the way a
// single-request run joins them, so the `deferred` tally and the replay count
// the same elements (#2167). A disabled one never runs.
TEST_F (ScenarioLoadTest, EveryUninlinedScriptPostOfAStepIsReplayedAndADisabledOneIsNot) {
    ScenarioMockServer server;
    auto execution      = plan_over ({ server.url ("/echo") });
    auto disabled       = vayu::tests::script_element_json ("el_disabled",
    "script.post", "pm.test('never', function () { throw new Error('x'); });");
    disabled["enabled"] = false;
    execution.plan.steps[0].elements = vayu::tests::compiled_elements ({
    vayu::tests::script_element_json ("el_a",
    "script.post", "pm.test('a', function () { pm.expect(pm.response.code).to.equal(200); });"),
    disabled,
    vayu::tests::script_element_json ("el_b",
    "script.post", "pm.test('b', function () { pm.expect(pm.response.code).to.equal(200); });"),
    });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_);

    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& step = validation.steps[0];
    ASSERT_HAS_VALUE (step);
    EXPECT_EQ (step->failed, 0u) << "the disabled script ran";
    EXPECT_EQ (step->passed, 4u)
    << "both enabled scripts must replay on each of the 2 samples";
}

// ============================================================================
// The exact assertion population (issues #1497, #2892): assert.* outcomes and
// an inline script's own pm.test calls, judged by maxAssertionFailureRatePct.
// ============================================================================

// Each assert.* outcome counts once: the counters already hold it, so adding
// the element tallies on top (the shape before #2892) doubled it. Mutation
// check: double the passed counter in `exact_assertion_totals` and passed
// reads 6.
TEST_F (ScenarioLoadTest, ExactAssertionTotalsCountEachAssertOutcomeOnce) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/echo") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_status" }, { "kind", "assert.status" }, { "enabled", true },
      { "config", { { "in", json::array ({ 200 }) } } } },
    // A non-required extractor beside it adds no test result, so it must
    // not inflate the count.
    vayu::tests::extract_json_element_json ("el_extract", "$.ok", "ok") });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto totals = vayu::core::exact_assertion_totals (*context_, state.get ());
    EXPECT_EQ (totals.passed, 3u);
    EXPECT_EQ (totals.failed, 0u);
}

TEST_F (ScenarioLoadTest, AFailingAssertStatusElementCountsAsAFailedAssertion) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/echo") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_status" }, { "kind", "assert.status" }, { "enabled", true },
    { "config", { { "in", json::array ({ 404 }) } } } } }); // /echo answers 200

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto totals = vayu::core::exact_assertion_totals (*context_, state.get ());
    EXPECT_EQ (totals.passed, 0u);
    EXPECT_EQ (totals.failed, 2u);
}

// A 200 whose body is not JSON is a failed assertion, not a skipped one, and a
// required extractor fails too (#3041). Mutation check: restore the `skipped`
// branch in `AssertJsonPathElement` and `failed` reads 0 (the extractor's
// failure alone then leaves it at 3).
TEST_F (ScenarioLoadTest, AnUnreadableBodyCountsAsAFailedAssertion) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/html") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_assert" }, { "kind", "assert.jsonpath" }, { "enabled", true },
      { "config", { { "path", "$.ok" }, { "exists", true } } } },
    { { "id", "el_extract" }, { "kind", "extract.json" }, { "enabled", true },
    { "config", { { "path", "$.token" }, { "variable", "token" }, { "required", true } } } } });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto totals = vayu::core::exact_assertion_totals (*context_, state.get ());
    EXPECT_EQ (totals.passed, 0u);
    EXPECT_EQ (totals.failed, 6u);
}

// The gap this issue closes: `script_kinds.cpp`'s `apply` reports the
// element's own outcome as "did the script throw", never whether its
// `pm.test` calls passed - so before this, a failing inline assertion was
// invisible at run level. Mutation check: remove the `pre_result.tests` /
// `post_result.tests` loops in `scenario_load.cpp`'s `run_step_before` /
// `run_step_after` and both counters here stay zero.
TEST_F (ScenarioLoadTest, AnInlineScriptsPmTestCallsAreTalliedSeparatelyFromItsElementOutcome) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/echo") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_post", "script.post",
    "pm.test('passes', function () { pm.expect(1).to.equal(1); });"
    "pm.test('fails', function () { pm.expect(1).to.equal(2); });",
    /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    // `ScriptResult::success` already folds a failed `pm.test` into "did the
    // script run cleanly" (`script_engine.cpp`'s post-eval loop over
    // `result.tests`), so `StepElementTallies` - a single pass/fail bit per
    // script *run* - already marks this element failed; that part predates
    // this issue. What did not exist before this PR is the assertion-level
    // count behind that one bit: one `pm.test` call passed and one failed,
    // and only `inline_tests_passed`/`_failed` can tell the two apart
    // from a run where *both* calls failed - the element tally reads
    // identically either way.
    EXPECT_EQ (state->inline_tests_passed.load (), 1u);
    EXPECT_EQ (state->inline_tests_failed.load (), 1u);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_TRUE (summary["steps"][0].contains ("elements"));
    EXPECT_EQ (summary["steps"][0]["elements"][0]["passed"], 0);
    EXPECT_EQ (summary["steps"][0]["elements"][0]["failed"], 1);
}

// #2820: the exact population reaches the report, beside the HTTP figures it is
// not folded into. The second step asserts text no `/echo` body holds, so each
// iteration fails it once while every response is a 200. Mutation check: drop
// the `assertions` write in `collect_summary_inputs` and the key is missing.
TEST_F (ScenarioLoadTest, AFailingAssertContainsReachesTheReportsScenarioAssertions) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo"), server.url ("/echo") });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { json{ { "id", "el_contains" }, { "kind", "assert.contains" }, { "enabled", true },
    { "config", { { "field", "body" }, { "text", "never in the body" } } } } });

    constexpr size_t ITERATIONS = 4;
    const json report           = run_to_report (
    json{ { "mode", "iterations" }, { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);
    const json& scenario = report.at ("scenario");
    EXPECT_EQ (scenario.value ("assertions", json ()),
    (json{ { "passed", 0 }, { "failed", ITERATIONS } }))
    << scenario.dump ();
    EXPECT_DOUBLE_EQ (report.at ("summary").at ("errorRate").get<double> (), 0.0);
    // The step outcomes count executions (#2824): each iteration's second
    // step failed an assertion, though every response was a 200.
    EXPECT_EQ (scenario.at ("passed").get<size_t> (), ITERATIONS) << scenario.dump ();
    EXPECT_EQ (scenario.at ("failed").get<size_t> (), ITERATIONS) << scenario.dump ();
}

// #3043: an assertion that cannot run fails its step under load and is in the
// exact population, beside the element tally that already booked it failed.
// Mutation check: put the bare `outcome_status = "error"` back in
// `AssertJsonPathElement::apply` and `assertions` is absent, the steps passed.
TEST_F (ScenarioLoadTest, AnAssertionThatCannotRunFailsItsStepAndIsCounted) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo"), server.url ("/echo") });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { json{ { "id", "el_jsonpath" }, { "kind", "assert.jsonpath" },
    { "enabled", true }, { "config", { { "path", "$.method" } } } } });

    constexpr size_t ITERATIONS = 3;
    const json report           = run_to_report (
    json{ { "mode", "iterations" }, { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);
    const json& scenario = report.at ("scenario");
    EXPECT_EQ (scenario.value ("assertions", json ()),
    (json{ { "passed", 0 }, { "failed", ITERATIONS } }))
    << scenario.dump ();
    EXPECT_EQ (scenario.at ("passed").get<size_t> (), ITERATIONS) << scenario.dump ();
    EXPECT_EQ (scenario.at ("failed").get<size_t> (), ITERATIONS) << scenario.dump ();
}

// An inline script's `pm.test` is in the exact population; an un-inlined one is
// the deferred replay's, reported under `testValidation` and kept out of it.
// Mutation check: add `validation.run` to the figure in `collect_summary_inputs`
// and `failed` reads 6.
TEST_F (ScenarioLoadTest, ScenarioAssertionsCountAnInlinePmTestAndNotADeferredOne) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo"), server.url ("/echo") });
    const std::string failing =
    "pm.test('fails', function () { pm.expect(1).to.equal(2); });";
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_inline", "script.post", failing,
    /*inline_script=*/true) });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_deferred", "script.post", failing) });

    constexpr size_t ITERATIONS = 3;
    const json report =
    run_to_report (json{ { "mode", "iterations" }, { "iterations", ITERATIONS },
                   { "concurrency", 1 }, { "response_sample_rate", 1 } },
    execution);
    EXPECT_EQ (report.at ("scenario").value ("assertions", json ()),
    (json{ { "passed", 0 }, { "failed", ITERATIONS } }))
    << report.at ("scenario").dump ();
    ASSERT_TRUE (report.contains ("testValidation"))
    << "the deferred replay never ran";
    EXPECT_GT (report["testValidation"].value ("testsFailed", 0), 0)
    << report["testValidation"].dump ();
}

// #3537: an inline script that throws is an errored element execution, and a
// deferred `pm.test` that fails is the sampled population, both in the report's
// `assertions` beside the exact population this run left empty. The step count
// `scenario.errored` is not read for it. Mutation check: drop the `assertions`
// write in `build_run_summary_payload` and the member is absent.
TEST_F (ScenarioLoadTest, AThrownInlineScriptAndAFailedReplayReachTheReportsAssertions) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/echo"), server.url ("/echo") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ vayu::tests::script_element_json (
    "el_throws", "script.post", "JSON.parse('not json');", /*inline_script=*/true) });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_deferred", "script.post",
    "pm.test('fails', function () { pm.expect(1).to.equal(2); });") });

    constexpr size_t ITERATIONS = 3;
    const json report =
    run_to_report (json{ { "mode", "iterations" }, { "iterations", ITERATIONS },
                   { "concurrency", 1 }, { "response_sample_rate", 1 } },
    execution);
    ASSERT_TRUE (report.contains ("assertions")) << report.dump ();
    const json& assertions = report.at ("assertions");
    EXPECT_EQ (assertions.value ("errored", 0u), ITERATIONS) << assertions.dump ();
    EXPECT_EQ (assertions.value ("teardownFailed", 1u), 0u) << assertions.dump ();
    EXPECT_EQ (assertions.value ("exact", json ()),
    (json{ { "passed", 0 }, { "failed", 0 } }))
    << assertions.dump ();
    ASSERT_TRUE (report.contains ("testValidation"))
    << "the deferred replay never ran";
    const auto replay_failed = report["testValidation"].value ("testsFailed", 0);
    EXPECT_GT (replay_failed, 0) << report["testValidation"].dump ();
    EXPECT_EQ (assertions.value ("sampled", json ()).value ("failed", -1), replay_failed)
    << assertions.dump ();
    EXPECT_FALSE (report.at ("scenario").contains ("assertions"))
    << report.at ("scenario").dump ();
}

// A run that asserted nothing has no figure, never `{0, 0}`. Mutation check:
// drop the `total () > 0` guard in `collect_summary_inputs` and the key appears.
TEST_F (ScenarioLoadTest, AScenarioRunThatAssertedNothingHasNoScenarioAssertions) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/echo"), server.url ("/echo") });

    const json report = run_to_report (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    ASSERT_TRUE (report.contains ("scenario")) << report.dump ();
    EXPECT_FALSE (report.at ("scenario").contains ("assertions"))
    << report.at ("scenario").dump ();
}
