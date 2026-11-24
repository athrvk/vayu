/**
 * @file tests/scenario_load_test.cpp
 * @brief The load-mode scenario executor: the per-VU state machine, per-VU
 *        cookies and per-step histograms (issue #357).
 *
 * These drive `execute_scenario_load` directly against an in-process mock,
 * which is what lets them assert the *sequence* a virtual user actually sent
 * rather than only the totals a run reports. The mock records every path and
 * `Cookie` header it saw, in order, because the two properties this phase turns
 * on - a VU walks its own plan, and two VUs never share a session - are not
 * visible in any aggregate.
 *
 * This file holds the mode validation, the per-VU walk and cookie jar, step outcomes and the
 * inline-script and step-jump failure paths; the other subjects are in the
 * `scenario_load_*_test.cpp` files beside it.
 *
 * The `ScenarioLoadTest` fixture and its mock server are in `scenario_load_fixture.hpp`.
 */

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "vayu/core/scenario_load.hpp"

#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "log_capture.hpp"
#include "mock_server.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/utils/diagnostics.hpp"
#include "wait_until.hpp"

#include "scenario_load_fixture.hpp"

using nlohmann::json;
using vayu::tests::scenario_load::expect_load_outcome_identities;
using vayu::tests::scenario_load::one_inline_script;
using vayu::tests::scenario_load::ScenarioLoadTest;
using vayu::tests::scenario_load::ScenarioMockServer;

// ============================================================================
// Mode validation - the one rule with teeth
// ============================================================================

TEST (ScenarioLoadConfig, ConstantRpsIsRefusedForAScenario) {
    const json config = { { "scenario", { { "collectionId", "c" } } },
        { "mode", "constant_rps" }, { "duration", "10s" } };

    ASSERT_TRUE (vayu::core::is_scenario_load_run (config));
    const auto refusal = vayu::core::validate_scenario_load_config (config);
    ASSERT_HAS_VALUE (refusal)
    << "constant_rps with a scenario must be refused, not silently run "
       "closed-loop";
    EXPECT_NE (refusal->find ("constant_rps"), std::string::npos)
    << "the refusal must name the mode it refused: " << *refusal;
}

TEST (ScenarioLoadConfig, CapacityIsRefusedForAScenario) {
    const json config = { { "scenario", { { "collectionId", "c" } } },
        { "mode", "capacity" }, { "duration", "10s" } };

    ASSERT_TRUE (vayu::core::is_scenario_load_run (config));
    const auto refusal = vayu::core::validate_scenario_load_config (config);
    ASSERT_HAS_VALUE (refusal)
    << "capacity with a scenario must be refused: the search judges one "
       "p99 per level and a sequence has one per step";
    EXPECT_NE (refusal->find ("capacity"), std::string::npos)
    << "the refusal must name the mode it refused: " << *refusal;
}

TEST (ScenarioLoadConfig, AnArrivalRateIsRefusedOnEveryScenarioMode) {
    // `rps` is what puts ConstantLoadStrategy on its open-loop path regardless
    // of the declared mode, so refusing only `mode: constant_rps` would leave
    // the open-loop door open.
    for (const char* mode : { "constant_concurrency", "ramp_up", "iterations" }) {
        const json config = { { "scenario", { { "collectionId", "c" } } },
            { "mode", mode }, { "targetRps", 500.0 } };
        EXPECT_TRUE (vayu::core::validate_scenario_load_config (config).has_value ())
        << "targetRps was accepted on scenario mode " << mode;
    }
}

TEST (ScenarioLoadConfig, TheClosedLoopModesAreAccepted) {
    for (const char* mode : { "constant_concurrency", "ramp_up", "iterations" }) {
        const json config = { { "scenario", { { "collectionId", "c" } } },
            { "mode", mode }, { "duration", "5s" } };
        EXPECT_FALSE (vayu::core::validate_scenario_load_config (config).has_value ())
        << "scenario mode " << mode << " was refused";
    }
}

TEST (ScenarioLoadConfig, AScenarioWithoutAModeIsStillADesignModeRun) {
    // The absence of `mode` cannot start meaning something new: every caller
    // sent exactly this shape before load-mode scenarios existed.
    const json config = { { "scenario", { { "collectionId", "c" } } } };
    EXPECT_FALSE (vayu::core::is_scenario_load_run (config));

    const json load_config = { { "mode", "constant_concurrency" } };
    EXPECT_FALSE (vayu::core::is_scenario_load_run (load_config))
    << "a single-request load run has no scenario to execute";
}

// ============================================================================
// The virtual-user state machine
// ============================================================================

// A VU walks every step of its iteration in order, then starts the next
// iteration at step 0. One VU makes the recorded order the VU's own order.
TEST_F (ScenarioLoadTest, AVirtualUserWalksItsPlanInOrderThenRestartsAtStepZero) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    std::vector<std::string> order;
    for (const auto& hit : server.hits ()) {
        order.push_back (hit.path);
    }
    EXPECT_EQ (order,
    (std::vector<std::string>{ "/s0", "/s1", "/s2", "/s0", "/s1", "/s2", "/s0", "/s1", "/s2" }));
    EXPECT_EQ (state->iterations_completed.load (), 3u);
    EXPECT_EQ (state->iterations_abandoned.load (), 0u);
    EXPECT_EQ (state->steps_executed.load (), 9u);
}

// `iterations` is a total across the pool, and a VU is never abandoned partway
// through a sequence to reach it: every started iteration ran to its last step.
TEST_F (ScenarioLoadTest, AnIterationsRunStopsStartingIterationsWithoutStrandingOne) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 4 },
        { "concurrency", 3 } };
    auto state        = run (config, execution);

    EXPECT_EQ (state->iterations_started.load (), 4u);
    EXPECT_EQ (state->iterations_completed.load (), 4u);
    EXPECT_EQ (state->steps_executed.load (), 12u)
    << "4 iterations x 3 steps; a VU stopped mid-sequence would send fewer";
    EXPECT_EQ (server.hits_for ("/s2").size (), 4u)
    << "every started iteration must reach its last step";
}

// Per-VU cookies, and the iteration boundary that clears them. One VU, so the
// order is deterministic: login, echo, login, echo.
TEST_F (ScenarioLoadTest, CookiesRideAnIterationAndAreClearedAtTheNextOne) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/login"), server.url ("/echo") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    // One handle in the pool, so every step after the first reuses the handle
    // the previous one left behind - which is where a cookie engine that is
    // enabled but never flushed leaks one VU's session into the next request.
    run (config, execution, /*pool_size=*/1);

    const auto logins = server.hits_for ("/login");
    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (logins.size (), 2u);
    ASSERT_EQ (echoes.size (), 2u);

    // The session the step before it established reaches the next step - which
    // is the whole point of a multi-step load run.
    EXPECT_EQ (echoes[0].cookie, "sid=1");
    EXPECT_EQ (echoes[1].cookie, "sid=2");

    // Empty at the start of each iteration: a new iteration is a new user, not
    // the same one logging in twice.
    EXPECT_EQ (logins[0].cookie, "");
    EXPECT_EQ (logins[1].cookie, "")
    << "the second iteration's first step carried the first iteration's "
       "session - per-VU cookies are not being cleared at the iteration "
       "boundary";
}

// Issue #1765, the read half: a step with `disableCookies` sends none of the
// VU's session, and the session survives it for the step after. Mutation
// checks: `request.track_cookies = true` in `submit_one` reds the first
// expectation; handing `finish_step` the jar-off step's own (empty)
// `response.cookie_lines` instead of `&vu->cookies` clears the session and
// reds the second.
TEST_F (ScenarioLoadTest, AStepWithTheJarOffSendsNoCookieAndKeepsTheSession) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/login"), server.url ("/echo"), server.url ("/s0") });
    execution.plan.steps[1].request.disable_cookies = true;

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution, /*pool_size=*/1);

    const auto echoes = server.hits_for ("/echo");
    const auto after  = server.hits_for ("/s0");
    ASSERT_EQ (echoes.size (), 1u);
    ASSERT_EQ (after.size (), 1u);
    EXPECT_EQ (echoes[0].cookie, "")
    << "a jar-off step carried the VU's session";
    EXPECT_EQ (after[0].cookie, "sid=1")
    << "a jar-off step dropped the VU's session";
}

// The write half: a `Set-Cookie` answering a jar-off step does not replace
// the VU's session. Mutation check: set `request.track_cookies = true` for
// every step in `submit_one` and hand `finish_step` the captured
// `&response.cookie_lines` for a jar-off step too - the pair a driver that
// ignored the flag would be - and the echo carries `sid=2`.
TEST_F (ScenarioLoadTest, AStepWithTheJarOffStoresNoSetCookie) {
    ScenarioMockServer server;
    auto execution = plan_over (
    { server.url ("/login"), server.url ("/login"), server.url ("/echo") });
    execution.plan.steps[1].request.disable_cookies = true;

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    run (config, execution, /*pool_size=*/1);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 1u);
    EXPECT_EQ (echoes[0].cookie, "sid=1")
    << "the jar-off step's Set-Cookie (sid=2) replaced the VU's session";
}

// ============================================================================
// Cookies libcurl's engine drops under load (issue #3307)
// ============================================================================

namespace {

/// Every `cookies_dropped` entry of @p warnings.
std::vector<json> cookies_dropped_entries (const json& warnings) {
    std::vector<json> found;
    for (const auto& warning : warnings) {
        if (warning.value ("code", "") == "cookies_dropped") {
            found.push_back (warning);
        }
    }
    return found;
}

json two_iterations_one_vu () {
    return { { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } };
}

} // namespace

// The warning without a run: the collector's count and a message, never a
// name, and nothing at 0. Mutation-check: drop the `cookies_dropped` branch of
// `build_run_warnings` and the second half finds no entry.
TEST (CookiesDroppedWarning, CarriesTheCountOnlyWhenACookieWasDropped) {
    const auto quiet =
    std::make_shared<vayu::core::RunContext> ("run-cookies-quiet", json::object ());
    EXPECT_TRUE (
    cookies_dropped_entries (vayu::core::build_run_warnings (quiet)).empty ());

    const auto dropped = std::make_shared<vayu::core::RunContext> (
    "run-cookies-dropped", json::object ());
    dropped->metrics_collector->record_set_cookie_headers_dropped (2);
    dropped->metrics_collector->record_set_cookie_headers_dropped (1);
    const auto found = cookies_dropped_entries (vayu::core::build_run_warnings (dropped));
    ASSERT_EQ (found.size (), 1u);
    EXPECT_EQ (found[0]["count"], 3);
    EXPECT_FALSE (found[0].contains ("names"));
    const auto message = found[0]["message"].get<std::string> ();
    EXPECT_NE (
    message.find ("3 Set-Cookie headers were dropped across the run"), std::string::npos)
    << message;
}

// One VU, two iterations of a step whose response sets 52 cookies and one
// whose cookie is too long to store: 2 + 1 dropped per iteration, counted in
// one warning of the stored report, which names no cookie. Mutation-checks:
// drop the `set_cookie_headers_dropped` tally in `handle_result`
// (load_strategy.cpp), or the `fetch_add` in
// `record_set_cookie_headers_dropped`, and the warning is absent.
TEST_F (ScenarioLoadTest, CookiesLibcurlDroppedAreCountedInOneRunWarning) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/many-cookies"), server.url ("/huge-cookie") });

    const json report = run_to_report (two_iterations_one_vu (), execution);

    ASSERT_EQ (server.hits_for ("/huge-cookie").size (), 2u);
    const auto found =
    cookies_dropped_entries (report.value ("warnings", json::array ()));
    ASSERT_EQ (found.size (), 1u) << report.dump ();
    EXPECT_EQ (found[0]["count"], 6);
    const auto message = found[0]["message"].get<std::string> ();
    EXPECT_EQ (message.find ("secret-"), std::string::npos) << message;
    EXPECT_EQ (message.find ("huge"), std::string::npos) << message;
}

// The other sides: a run whose cookies all fit, and the same dropping
// responses on steps with the jar off, where libcurl's engine is off and drops
// nothing. Mutation-check: count in `header_callback` whatever
// `track_cookies` says and the jar-off run reads 6.
TEST_F (ScenarioLoadTest, ARunWhoseCookiesFitOrThatKeepsNoJarWarnsOfNoDroppedCookie) {
    ScenarioMockServer server;
    run (two_iterations_one_vu (),
    plan_over ({ server.url ("/login"), server.url ("/echo") }));
    EXPECT_TRUE (
    cookies_dropped_entries (vayu::core::build_run_warnings (context_)).empty ());

    auto jar_off =
    plan_over ({ server.url ("/many-cookies"), server.url ("/huge-cookie") });
    for (auto& step : jar_off.plan.steps) {
        step.request.disable_cookies = true;
    }
    run (two_iterations_one_vu (), jar_off);
    ASSERT_EQ (server.hits_for ("/huge-cookie").size (), 2u);
    EXPECT_EQ (context_->metrics_collector->set_cookie_headers_dropped (), 0u);
    EXPECT_TRUE (
    cookies_dropped_entries (vayu::core::build_run_warnings (context_)).empty ());
}

// A single-request load run never gives its transfers a cookie engine, so the
// same responses drop nothing there either. Mutation-check: the same as above;
// this reads 4.
TEST_F (ScenarioLoadTest, ASingleRequestLoadRunKeepsNoJarSoWarnsOfNoDroppedCookie) {
    ScenarioMockServer server;
    json config              = two_iterations_one_vu ();
    config["url"]            = server.url ("/many-cookies");
    config["method"]         = "GET";
    const std::string run_id = "run_single_cookies";
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
    ASSERT_TRUE (manager.start_run (run_id, config, *db_));
    ASSERT_TRUE (vayu::tests::wait_until (
    [&] () { return manager.get_run (run_id) == nullptr; }))
    << "the run never finished";
    manager.shutdown ();

    ASSERT_EQ (server.hits_for ("/many-cookies").size (), 2u);
    const json report = vayu::http::routes::run_report_response (*db_, run_id).second;
    EXPECT_TRUE (
    cookies_dropped_entries (report.value ("warnings", json::array ())).empty ())
    << report.dump ();
}

// Two VUs, both held inside `/login` at the same time, must still leave with
// their own session. A shared jar - or a cookie engine left on a pooled handle
// - hands one of them the other's.
TEST_F (ScenarioLoadTest, TwoVirtualUsersDoNotShareCookieState) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    const auto execution = plan_over ({ server.url ("/login"), server.url ("/echo") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    // Two handles for two VUs: the pool wraps, so the second iteration's
    // transfers run on handles the first iteration's finished with.
    run (config, execution, /*pool_size=*/2);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    EXPECT_NE (echoes[0].cookie, "")
    << "no session reached the second step at all";
    EXPECT_NE (echoes[0].cookie, echoes[1].cookie)
    << "both virtual users sent the same session - cookie state is shared "
       "between VUs rather than private to each";
}

// An inline script reads the cookie the step before it established for its
// own virtual user, not the other VU's (issue #1501). `pm.cookies` used to
// throw unconditionally under load; step 1's inline `script.pre` here reads
// what step 0's `/login` set for that same VU and stamps it onto the
// request, so the assertion is on the wire, the same way the correlation
// tests above prove per-VU state rather than trusting an in-process read.
//
// Mutation check: drop `script_ctx.cookie_read_lines = &vu.cookies;` in
// `run_step_before`, and the inline script throws instead of reading a
// value, so `echo.authorization` never gets set and this reds.
TEST_F (ScenarioLoadTest, AnInlineScriptReadsThisVirtualUsersOwnCookieFromTheStepBeforeIt) {
    ScenarioMockServer server (/*login_rendezvous=*/2);
    auto execution = plan_over ({ server.url ("/login"), server.url ("/echo") });
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_pre",
    "script.pre", "pm.request.headers.upsert('Authorization', 'Bearer ' + pm.cookies.get('sid'));",
    /*inline_script=*/true) });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 2 } };
    run (config, execution, /*pool_size=*/2);

    const auto echoes = server.hits_for ("/echo");
    ASSERT_EQ (echoes.size (), 2u);
    EXPECT_NE (echoes[0].authorization, echoes[1].authorization)
    << "both virtual users read the same cookie value - the per-VU view is "
       "shared rather than private to each";
    for (const auto& echo : echoes) {
        ASSERT_TRUE (echo.cookie.rfind ("sid=", 0) == 0)
        << "no session reached step 1";
        const std::string session_id = echo.cookie.substr (4);
        EXPECT_EQ (echo.authorization, "Bearer " + session_id)
        << "pm.cookies.get did not read this VU's own cookie from the step "
           "before it";
    }
}

// An errored step ends its iteration and the VU starts the next one. A VU that
// stranded instead would send step 0 once and then nothing, permanently
// shrinking effective concurrency.
TEST_F (ScenarioLoadTest, AnErroredStepEndsItsIterationWithoutStrandingTheVirtualUser) {
    ScenarioMockServer server;
    // Port 1 on loopback refuses immediately - a transport error, not a 5xx, so
    // the failure is the one that ends an iteration.
    const auto execution = plan_over (
    { server.url ("/s0"), "http://127.0.0.1:1/unreachable", server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_EQ (server.hits_for ("/s0").size (), 3u)
    << "the virtual user was stranded by the errored step - it never started "
       "another iteration";
    EXPECT_EQ (server.hits_for ("/s2").size (), 0u)
    << "the iteration continued past a step that errored";
    EXPECT_EQ (state->iterations_abandoned.load (), 3u);
    EXPECT_EQ (state->iterations_completed.load (), 0u);
    EXPECT_EQ (state->steps_errored.load (), 3u);
}

// #2914: every iteration abandons at step 0, so step 1 is never sent. The
// start-of-run expected count (iterations x steps = 20) is only an upper bound;
// a natural end settles it to what was sent, so progress reaches 100%.
// Mutation check: drop the settling assignment at the end of
// `execute_scenario_load` and `requestsExpected` stays 20.
TEST_F (ScenarioLoadTest, AnAbandonedIterationSettlesTheExpectedCountToWhatWasSent) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ "http://127.0.0.1:1/unreachable", server.url ("/s1") });

    const json config = { { "mode", "iterations" }, { "iterations", 10 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_EQ (state->iterations_abandoned.load (), 10u);
    EXPECT_EQ (context_->requests_sent.load (), 10u);
    EXPECT_EQ (context_->requests_expected.load (), context_->requests_sent.load ())
    << "a natural end left the upper bound in place, so progress stops short "
       "of 100%";
}

// #2914: a stopped run keeps the start-of-run upper bound, which is what it
// fell short of. Mutation check: drop the `should_stop` guard on the settling
// assignment and `requestsExpected` drops to the sent count.
TEST_F (ScenarioLoadTest, AStoppedIterationsRunKeepsTheExpectedUpperBound) {
    vayu::tests::SlowMockServer upstream;
    auto execution = plan_over ({ upstream.hang_url (), upstream.hang_url () });
    for (auto& step : execution.plan.steps) {
        step.request.timeout_ms = 120000;
    }

    const json config = { { "mode", "iterations" }, { "iterations", 1000 },
        { "concurrency", 2 } };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-scenario-stop-expected", config);
    context->scenario = std::make_shared<const vayu::core::ScenarioExecution> (execution);
    context->event_loop = std::make_unique<vayu::http::EventLoop> ();
    context->event_loop->start ();

    std::thread stopper ([&context] () {
        EXPECT_TRUE (vayu::tests::wait_until (
        [&context] () { return context->event_loop->active_count () >= 2; }))
        << "both virtual users never had a transfer in flight";
        context->request_stop ();
    });
    auto base_scopes =
    vayu::core::scenario_load_scopes (*db_, std::nullopt, *context->scenario);
    auto state = vayu::core::execute_scenario_load (
    context, *db_, *context->scenario, std::move (base_scopes));
    stopper.join ();
    context->event_loop->stop (false);

    ASSERT_GT (context->requests_sent.load (), 0u)
    << "nothing was sent; nothing is proven";
    EXPECT_EQ (context->requests_expected.load (), 2000u)
    << "a stopped run's expected count was settled to what it sent";
}

// #2136: a step a user Stop cancelled neither ran nor failed. It is counted as
// cancelled and moves no step tally - no step error, no abandoned iteration,
// no coverage send - while its virtual user is still released.
TEST_F (ScenarioLoadTest, AStepTheStopCancelledMovesNoStepTally) {
    vayu::tests::SlowMockServer upstream;
    auto execution = plan_over ({ upstream.hang_url () });
    execution.plan.steps[0].request.timeout_ms = 120000;
    execution.plan.steps[0].spec_operation =
    R"({"operationId":"hang","method":"GET","path":"/hang"})";
    vayu::core::DeclaredOperation hang;
    hang.operation_id                  = "hang";
    hang.method                        = "GET";
    hang.path                          = "/hang";
    hang.responses                     = { "200" };
    execution.spec.spec_id             = "spec_1";
    execution.spec.declared_operations = { hang };

    const json config = { { "mode", "iterations" }, { "iterations", 1000 },
        { "concurrency", 2 } };
    auto context =
    std::make_shared<vayu::core::RunContext> ("test-scenario-stop", config);
    context->scenario = std::make_shared<const vayu::core::ScenarioExecution> (execution);
    context->event_loop = std::make_unique<vayu::http::EventLoop> ();
    context->event_loop->start ();

    // Stops once both virtual users have a transfer in flight, the way the
    // stop route does: flag, wake, then the run lets go of the loop.
    std::thread stopper ([&context] () {
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (5);
        while (context->event_loop->active_count () < 2 &&
        std::chrono::steady_clock::now () < deadline) {
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
        }
        context->request_stop ();
    });
    auto base_scopes =
    vayu::core::scenario_load_scopes (*db_, std::nullopt, *context->scenario);
    auto state = vayu::core::execute_scenario_load (
    context, *db_, *context->scenario, std::move (base_scopes));
    stopper.join ();
    context->event_loop->stop (false);

    ASSERT_GT (context->requests_sent.load (), 0u)
    << "nothing was sent; nothing is proven";
    EXPECT_EQ (context->metrics_collector->cancelled (), context->requests_sent.load ());
    EXPECT_EQ (context->metrics_collector->total_errors (), 0u);
    EXPECT_EQ (context->in_flight (), 0u);
    EXPECT_EQ (state->steps_errored.load (), 0u);
    EXPECT_EQ (state->steps.errors (0), 0u);
    EXPECT_EQ (state->steps_executed.load (), 0u);
    EXPECT_EQ (state->iterations_abandoned.load (), 0u);

    const auto coverage = vayu::core::build_scenario_load_coverage (*state);
    ASSERT_FALSE (coverage.empty ()) << "a bound run must report coverage";
    ASSERT_EQ (coverage["operations"].size (), 1u);
    EXPECT_EQ (coverage["operations"][0]["sent"], 0)
    << "a cancelled send was counted against its operation";
}

// A step that answered 500 is an error in its own row of the breakdown, but a
// response arrived, so the iteration goes on to the next step (#2134). With no
// assertion to fail it is a `passed` step, never `failed` or `errored` (#2824):
// the status is the step's `httpErrors`, not its outcome. Mutation checks: drop
// the `record_failed_status` call in the completion callback and the error
// counts read 0; make an HTTP error status set `errored` there and `/s2` is
// never reached.
TEST_F (ScenarioLoadTest, AStepAnsweringAnHttpErrorCountsAsAnErrorWithoutEndingItsIteration) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/fail500"), server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    ASSERT_EQ (server.hits_for ("/fail500").size (), 3u);
    EXPECT_EQ (server.hits_for ("/s2").size (), 3u)
    << "an HTTP error response ended the iteration as if nothing had answered";

    EXPECT_EQ (state->steps.completed (1), 3u);
    EXPECT_EQ (state->steps.errors (1), 3u)
    << "a step that answered 500 on every send reported no errors";
    EXPECT_EQ (state->steps.http_errors (1), 3u);
    EXPECT_EQ (state->steps.no_response (1), 0u);
    EXPECT_EQ (state->steps.errors (0), 0u);
    EXPECT_EQ (state->steps.errors (2), 0u);
    EXPECT_EQ (state->steps_errored.load (), 0u);
    EXPECT_EQ (state->iterations_abandoned.load (), 0u);
    EXPECT_EQ (state->iterations_completed.load (), 3u);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps_executed"], 9);
    EXPECT_EQ (summary["errored"], 0);
    EXPECT_EQ (summary["iterations_abandoned"], 0);
    EXPECT_EQ (summary["failed"], 0)
    << "a 500 no assertion judged failed its step";
    EXPECT_EQ (summary["passed"], 9);
    const auto& failing = summary["steps"][1];
    EXPECT_EQ (failing["errors"], 3);
    EXPECT_EQ (failing["httpErrors"], 3);
    EXPECT_EQ (failing["noResponse"], 0);
}

// The other half of the error definition: a step nothing answered is a
// `noResponse` error, and that one does end its iteration.
TEST_F (ScenarioLoadTest, AStepWithNoResponseCountsAsNoResponseAndEndsItsIteration) {
    ScenarioMockServer server;
    const auto execution = plan_over (
    { server.url ("/s0"), "http://127.0.0.1:1/unreachable", server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_EQ (server.hits_for ("/s2").size (), 0u);
    EXPECT_EQ (state->steps.errors (1), 2u);
    EXPECT_EQ (state->steps.no_response (1), 2u);
    EXPECT_EQ (state->steps.http_errors (1), 0u);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    EXPECT_EQ (summary["steps_executed"], 4);
    EXPECT_EQ (summary["errored"], 2);
    EXPECT_EQ (summary["iterations_abandoned"], 2);
    EXPECT_EQ (summary["failed"], 0);
    EXPECT_EQ (summary["passed"], 2);
    const auto& unanswered = summary["steps"][1];
    EXPECT_EQ (unanswered["errors"], 2);
    EXPECT_EQ (unanswered["noResponse"], 2);
    EXPECT_EQ (unanswered["httpErrors"], 0);
}

// One definition of the step outcomes for both runners (#2824). Rows alternate
// gold and silver: a silver iteration skips step 0 and sends step 1 to a 500
// that both of its `assert.status` elements reject, and step 2 answers 500 with
// nothing asserting on it every time. The four outcomes are disjoint and sum to
// `steps_executed`, which counts every step reached, a skipped one included;
// a step's `executed` counts only the steps that ran. Two failed assertions in
// one execution are one `failed` step. Mutation check: restore `failed` as the
// sum of every step's `httpErrors` in `build_scenario_load_summary` and it
// reads 6.
TEST_F (ScenarioLoadTest, LoadStepOutcomesAreDisjointAndSumToStepsExecuted) {
    ScenarioMockServer server;
    auto execution = plan_over (
    { server.url ("/s0"), server.url ("/{{data.path}}"), server.url ("/fail500") });
    with_data (execution,
    { json{ { "tier", "gold" }, { "path", "s1" } },
    json{ { "tier", "silver" }, { "path", "fail500" } } });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_if" }, { "kind", "control.if" }, { "enabled", true },
    { "config", { { "condition", "{{data.tier}} == gold" } } } } });
    const auto status_ok = [] (const std::string& id) {
        return json{ { "id", id }, { "kind", "assert.status" }, { "enabled", true },
            { "config", { { "in", json::array ({ 200 }) } } } };
    };
    execution.plan.steps[1].elements = vayu::tests::compiled_elements (
    { status_ok ("el_status"), status_ok ("el_status_again") });

    constexpr size_t ITERATIONS = 4;
    auto state = run (json{ { "mode", "iterations" },
                      { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    const auto count = [&summary] (const char* key) {
        return summary.at (key).get<size_t> ();
    };

    EXPECT_EQ (count ("steps_executed"), 3 * ITERATIONS) << summary.dump ();
    EXPECT_EQ (count ("skipped"), ITERATIONS / 2) << summary.dump ();
    EXPECT_EQ (count ("failed"), ITERATIONS / 2)
    << "one failed execution per silver iteration, however many assertions "
       "failed in it, and never the unasserted 500s: "
    << summary.dump ();
    EXPECT_EQ (count ("errored"), 0u) << summary.dump ();
    EXPECT_EQ (count ("passed"), 8u) << summary.dump ();
    EXPECT_EQ (count ("passed") + count ("failed") + count ("errored") + count ("skipped"),
    count ("steps_executed"));

    size_t ran = 0;
    for (const auto& step : summary.at ("steps")) {
        ran += step.at ("executed").get<size_t> ();
    }
    EXPECT_EQ (ran + count ("skipped"), count ("steps_executed")) << summary.dump ();
    EXPECT_EQ (summary["steps"][2]["httpErrors"], ITERATIONS)
    << "an unasserted 500 is still the step's HTTP error";
    EXPECT_EQ (state->inline_tests_failed.load (), ITERATIONS)
    << "both assertions fail in each silver iteration";
}

// An execution with no response is `errored` and nothing else (#2824), whatever
// its assertions said, as the sequential runner's `classify_step` decides it.
// Mutation check: test `assertion_failed` before `no_response` in
// `classify_execution` and `failed` reads 2.
TEST_F (ScenarioLoadTest, AnExecutionWithNoResponseIsErroredAndNotAlsoFailed) {
    auto execution = plan_over ({ "http://127.0.0.1:1/unreachable" });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { vayu::tests::script_element_json ("el_pre", "script.pre",
    "pm.test('fails', function () { pm.expect(1).to.equal(2); });", /*inline_script=*/true) });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    ASSERT_EQ (state->inline_tests_failed.load (), 2u)
    << "the pre-request assertion never ran, so this proves nothing";
    EXPECT_EQ (summary["errored"], 2) << summary.dump ();
    EXPECT_EQ (summary["failed"], 0) << summary.dump ();
    EXPECT_EQ (summary["passed"], 0) << summary.dump ();
    EXPECT_EQ (summary["steps_executed"], 2) << summary.dump ();
}

// #2947: an inline script that threw on a step that answered 200 is `errored`,
// as the sequential runner's `classify_step` decides it, and the iteration
// still goes on to step 1, so the target receives the load it did before.
// Mutation checks: drop `script_threw` from `classify_execution` and `errored`
// reads 0, `passed` 6; abandon the iteration for a thrown script in
// `finish_step` and `/s1` is never reached, `iterations_abandoned` reads 3.
TEST_F (ScenarioLoadTest, AnInlineScriptPostThatThrewIsErroredWithoutAbandoningItsIteration) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.post", "throw new Error('x');") });

    constexpr size_t ITERATIONS = 3;
    auto state = run (json{ { "mode", "iterations" },
                      { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    EXPECT_EQ (server.hits_for ("/s1").size (), ITERATIONS)
    << "a thrown script ended its iteration";
    EXPECT_EQ (summary["errored"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (summary["passed"], ITERATIONS)
    << "only step 1 passed: " << summary.dump ();
    EXPECT_EQ (summary["failed"], 0) << summary.dump ();
    EXPECT_EQ (summary["iterations_abandoned"], 0) << summary.dump ();
    EXPECT_EQ (summary["iterations_completed"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (summary["steps"][0]["noResponse"], 0)
    << "a thrown script is not a step that got no response";
    expect_load_outcome_identities (summary);
}

// The same for `script.pre`: the request it ran before still goes out, as it
// did before #2947, and the step is `errored` rather than `passed`.
TEST_F (ScenarioLoadTest, AnInlineScriptPreThatThrewIsErroredAndItsRequestStillSent) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.pre", "throw new Error('x');") });

    constexpr size_t ITERATIONS = 3;
    auto state = run (json{ { "mode", "iterations" },
                      { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    EXPECT_EQ (server.hits_for ("/s0").size (), ITERATIONS);
    EXPECT_EQ (server.hits_for ("/s1").size (), ITERATIONS);
    EXPECT_EQ (summary["errored"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (summary["passed"], ITERATIONS) << summary.dump ();
    EXPECT_EQ (summary["iterations_abandoned"], 0) << summary.dump ();
    expect_load_outcome_identities (summary);
}

// An inline script's `pm.execution` call throws on a load run (no sequence to
// redirect from inside a script), so `skipRequest()` there errors its step and
// skips nothing: the request still goes out.
TEST_F (ScenarioLoadTest, AnInlineSkipRequestThrowsSoItsStepIsErroredAndStillSent) {
    ScenarioMockServer server;
    auto execution                   = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.pre", "pm.execution.skipRequest();") });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    EXPECT_EQ (server.hits_for ("/s0").size (), 2u);
    EXPECT_EQ (summary["errored"], 2) << summary.dump ();
    EXPECT_EQ (summary["skipped"], 0) << summary.dump ();
    expect_load_outcome_identities (summary);
}

// An inline `script.post` on a streaming step reads the stream's events
// (#3769), parsed back from the body the event loop buffered. Mutation check:
// drop the `bind_buffered_stream_events` call in `run_step_after` and every
// iteration's test fails on an undefined `pm.response.events`.
TEST_F (ScenarioLoadTest, AnInlineScriptPostOnAStreamingStepReadsItsEvents) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/sse-three") });
    execution.plan.steps[0].request.stream_bounds = vayu::StreamBounds{ 5000, 100 };
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ one_inline_script ("script.post", R"(
        pm.test('events are readable', function () {
            if (typeof pm.response.events === 'undefined') {
                throw new Error('pm.response.events was undefined');
            }
            pm.expect(pm.response.events.length).to.equal(3);
            pm.expect(pm.response.events[2].data).to.equal('three');
            pm.expect(pm.response.totalEvents).to.equal(3);
            pm.expect(pm.response.eventsTruncated).to.equal(false);
            pm.expect(typeof pm.response.streamText).to.equal('undefined');
            pm.expect(pm.response.events[0]).to.not.have.property('text');
        });
    )") });
    static_assert (ScenarioMockServer::STREAM_EVENTS == 3,
    "the script above asserts the fixture's event count");

    constexpr size_t ITERATIONS = 2;
    auto state = run (json{ { "mode", "iterations" },
                      { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);

    EXPECT_EQ (server.hits_for ("/sse-three").size (), ITERATIONS);
    EXPECT_EQ (state->inline_tests_failed.load (), 0u);
    EXPECT_EQ (state->inline_tests_passed.load (), ITERATIONS);
}

// A streaming step whose request declares a `streamTextPath` (#3773, set on
// the step's bounds as `step_stream_bounds` compiles it from the row)
// reads its reply through it in an inline `script.post`. Mutation check:
// drop the `text_path_` assignment in `StreamTally::start` and every
// iteration's test fails on an undefined `streamText`.
TEST_F (ScenarioLoadTest, AnInlineScriptPostReadsAStreamingStepsTextPath) {
    ScenarioMockServer server;
    auto execution    = plan_over ({ server.url ("/sse-usage") });
    auto& bounds      = execution.plan.steps[0].request.stream_bounds;
    bounds            = vayu::StreamBounds{ 5000, 100 };
    bounds->text_path = vayu::http::compile_stream_text_path ("$.delta");
    ASSERT_NE (bounds->text_path, nullptr);
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ one_inline_script ("script.post", R"(
        pm.test('the reply is assembled', function () {
            pm.expect(pm.response.streamText).to.equal('hi');
            pm.expect(pm.response.events[0]).to.not.have.property('text');
            pm.expect(pm.response.events[1].text).to.equal('hi');
        });
    )") });

    constexpr size_t ITERATIONS = 2;
    auto state = run (json{ { "mode", "iterations" },
                      { "iterations", ITERATIONS }, { "concurrency", 1 } },
    execution);

    EXPECT_EQ (server.hits_for ("/sse-usage").size (), ITERATIONS);
    EXPECT_EQ (state->inline_tests_failed.load (), 0u);
    EXPECT_EQ (state->inline_tests_passed.load (), ITERATIONS);
}

// A script that failed an assertion and then threw is one `errored` execution,
// not also a `failed` one: the throw outranks the assertion, as in
// `classify_step`. The assertion still reaches the exact population. Mutation
// check: test `assertion_failed` before `script_threw` in
// `classify_execution` and `failed` reads 2, `errored` 0.
TEST_F (ScenarioLoadTest, AThrowOutranksAFailedAssertionInTheSameExecution) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ one_inline_script ("script.post",
    "pm.test('fails', function () { pm.expect(1).to.equal(2); });\n"
    "throw new Error('x');") });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    ASSERT_EQ (state->inline_tests_failed.load (), 2u)
    << "the assertion never ran, so this proves nothing";
    EXPECT_EQ (summary["errored"], 2) << summary.dump ();
    EXPECT_EQ (summary["failed"], 0) << summary.dump ();
    EXPECT_EQ (summary["passed"], 0) << summary.dump ();
    expect_load_outcome_identities (summary);
}

// A step a controller skipped whose `script.pre` then threw is `errored`, not
// `skipped` (`classify_step` checks the throw first). It still sends nothing
// and ends no iteration, and it counts in its step's `executed`, which is what
// keeps `sum(executed) + skipped == steps_executed`. Mutation checks: test
// `!sent` before `script_threw` in `classify_execution` and `skipped` reads 2;
// drop `record_unsent` from `count_outcome` and the second identity is 2 short.
TEST_F (ScenarioLoadTest, ASkippedStepWhosePreScriptThrewIsErroredNotSkipped) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_if" }, { "kind", "control.if" }, { "enabled", true },
      { "config", { { "condition", "{{never_set}} exists" } } } },
    one_inline_script ("script.pre", "throw new Error('x');") });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    EXPECT_TRUE (server.hits_for ("/s0").empty ())
    << "the skipped step was sent";
    EXPECT_EQ (server.hits_for ("/s1").size (), 2u);
    EXPECT_EQ (summary["errored"], 2) << summary.dump ();
    EXPECT_EQ (summary["skipped"], 0) << summary.dump ();
    EXPECT_EQ (summary["iterations_abandoned"], 0) << summary.dump ();
    EXPECT_EQ (summary["steps"][0]["executed"], 2) << summary.dump ();
    EXPECT_EQ (summary["steps"][0]["noResponse"], 0) << summary.dump ();
    expect_load_outcome_identities (summary);
}

// A step that got no response is `errored` once, by `count_outcome`, even
// when its script threw too. Mutation check: count `steps_errored` for a
// no-response execution in `finish_step` as well and `errored` reads 4.
TEST_F (ScenarioLoadTest, ANoResponseStepWhoseScriptThrewIsErroredOnce) {
    auto execution = plan_over ({ "http://127.0.0.1:1/unreachable" });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.pre", "throw new Error('x');") });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 2 }, { "concurrency", 1 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    EXPECT_EQ (summary["errored"], 2) << summary.dump ();
    EXPECT_EQ (summary["iterations_abandoned"], 2) << summary.dump ();
    EXPECT_EQ (summary["steps_executed"], 2) << summary.dump ();
    expect_load_outcome_identities (summary);
}

// #2947's acceptance: the same stored collection, one request whose test
// script throws on a 200, reports the same outcomes run as a load run and as
// a collection run. Mutation check: as the first #2947 case above; the load
// report's `errored` reads 0 against the collection run's 3.
TEST_F (ScenarioLoadTest, ALoadRunAndACollectionRunCountAThrownScriptTheSame) {
    ScenarioMockServer server;
    const auto execution =
    resolve_one_step (server.url ("/s0"), json{ { "mode", "none" } },
    json::array ({ one_inline_script ("script.post", "throw new Error('x');") }));

    constexpr size_t ITERATIONS = 3;
    const auto load             = run_to_report (
    json{ { "mode", "iterations" }, { "iterations", ITERATIONS }, { "concurrency", 1 } }, execution)
                      .at ("scenario");
    const auto sequential =
    run_sequentially_to_report (execution, ITERATIONS).at ("scenario");

    for (const char* key : { "stepsExecuted", "passed", "failed", "skipped", "errored" }) {
        EXPECT_EQ (load.at (key), sequential.at (key))
        << key << "\nload: " << load.dump () << "\ncollection: " << sequential.dump ();
    }
    EXPECT_EQ (load.at ("errored"), ITERATIONS) << load.dump ();
    EXPECT_EQ (load.at ("iterationsAbandoned"), 0) << load.dump ();
}

// #3127: a load run says why an inline script failed and what it logged, on
// the step's element row: the throw, the failing test by name and the console
// line, each once however many iterations said it, with that number as its
// `count`. Mutation check: drop the `outcome_messages` assignment from
// `run_step_script` (script_kinds.cpp) and the row carries neither `messages`
// nor `console`.
TEST_F (ScenarioLoadTest, AnInlineScriptsThrowTestFailureAndConsoleReachTheStepsRow) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ one_inline_script ("script.post",
    "console.log('saw ' + pm.response.code);\n"
    "pm.test('status is 201', function () {"
    " pm.expect(pm.response.code).to.equal(201); });\n"
    "throw new Error('boom');") });

    auto state = run (
    json{ { "mode", "iterations" }, { "iterations", 4 }, { "concurrency", 2 } }, execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    const auto& row = summary.at ("steps").at (0).at ("elements").at (0);
    EXPECT_EQ (row.at ("error").get<int> (), 4) << row.dump ();
    EXPECT_EQ (row.value ("console", json ()),
    (json::array ({ { { "level", "log" }, { "text", "saw 200" }, { "count", 4 } } })))
    << row.dump ();
    const auto messages = row.value ("messages", json::array ());
    ASSERT_EQ (messages.size (), 2u) << row.dump ();
    EXPECT_EQ (messages[0].at ("kind").get<std::string> (), "error");
    EXPECT_NE (messages[0].at ("text").get<std::string> ().find ("boom"), std::string::npos)
    << row.dump ();
    EXPECT_EQ (messages[1].at ("kind").get<std::string> (), "test");
    EXPECT_TRUE (
    messages[1].at ("text").get<std::string> ().starts_with ("status is 201: "))
    << row.dump ();
    for (const auto& message : messages) {
        EXPECT_EQ (message.at ("count").get<int> (), 4) << row.dump ();
    }
    EXPECT_FALSE (row.contains ("messagesDropped")) << row.dump ();
}

// A load run's step scripts build no `pm.sendRequest` record (#3633): the
// run stores no trace per request to keep one on. The one-line summary stays
// on the step's element row. Mutation check: call `record_script_requests` on
// the `script_config` `execute_scenario_load` builds and the flag reads true.
//
// GCC 15 at `-O3` reports `-Wnull-dereference` inside nlohmann's `is_string`
// once the console loop is inlined; the element is never null (see
// utils/diagnostics.hpp).
VAYU_IGNORE_FALSE_NULL_DEREFERENCE
TEST_F (ScenarioLoadTest, AStepScriptsSendRequestBuildsNoRecordAndKeepsItsLine) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ one_inline_script ("script.post",
    "pm.sendRequest('" + server.url ("/s0") + "', function () {});") });

    auto state = run (json{ { "mode", "iterations" }, { "iterations", 2 },
                      { "concurrency", 1 }, { "allowScriptRequests", true } },
    execution);
    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    EXPECT_FALSE (state->script_config.record_send_requests);
    const auto& row    = summary.at ("steps").at (0).at ("elements").at (0);
    const auto console = row.value ("console", json::array ());
    ASSERT_FALSE (console.empty ()) << row.dump ();
    for (const auto& line : console) {
        EXPECT_TRUE (
        line.value ("text", "").starts_with ("pm.sendRequest GET " + server.url ("/s0") + " -> 200 ("))
        << row.dump ();
    }
}
VAYU_DIAGNOSTIC_POP

// ============================================================================
// Flow control is read the same on both run kinds (#2974)
// ============================================================================

namespace {

/// A step's `control.switch` that routes every execution to @p target:
/// `{{which}}` resolves to nothing here, so it stays its own literal and the
/// case keyed on that literal always matches.
json switch_to (const std::string& target) {
    return json{ { "id", "el_switch" }, { "kind", "control.switch" }, { "enabled", true },
        { "config", { { "variable", "which" }, { "cases", { { "{{which}}", target } } } } } };
}

/// The same outcome counts on both run kinds, the four outcomes summing to
/// `stepsExecuted` on each, and the load run's steps' `executed` plus
/// `skipped` summing to it too.
void expect_same_outcomes (const json& load, const json& sequential) {
    for (const char* key : { "stepsExecuted", "passed", "failed", "skipped", "errored" }) {
        EXPECT_EQ (load.at (key), sequential.at (key))
        << key << "\nload: " << load.dump () << "\ncollection: " << sequential.dump ();
    }
    for (const json* scenario : { &load, &sequential }) {
        const auto count = [scenario] (const char* key) {
            return scenario->at (key).get<size_t> ();
        };
        EXPECT_EQ (count ("passed") + count ("failed") + count ("errored") + count ("skipped"),
        count ("stepsExecuted"))
        << scenario->dump ();
    }
    size_t ran = 0;
    for (const auto& step : load.at ("steps")) {
        ran += step.at ("executed").get<size_t> ();
    }
    EXPECT_EQ (ran + load.at ("skipped").get<size_t> (),
    load.at ("stepsExecuted").get<size_t> ())
    << load.dump ();
}

} // namespace

// A step whose inline script threw has its own jump dropped on a load run, as
// on a collection run: the iteration walks on to step 1, and step 2 is reached
// only by walking. Mutation check: read `next_target_from_before` in
// `read_flow_control` whatever the outcome, and `/s1` gets 0 load hits
// against the collection run's 3.
TEST_F (ScenarioLoadTest, AThrownStepsSwitchIsDroppedOnBothRunKinds) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.pre", "throw new Error('x');"), switch_to ("step2") });

    constexpr size_t ITERATIONS = 3;
    const auto runs = run_both (server, execution, { "/s0", "/s1", "/s2" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ ITERATIONS, ITERATIONS, ITERATIONS }))
    << "the thrown step's switch was honoured: " << runs.load.dump ();
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("iterationsAbandoned"), 0) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);
}

// The same for an inline `setNextRequest` followed by a throw: a collection run
// records the jump and drops it with the throw, and on a load run the call
// itself throws. Either way the step is `errored` and the iteration walks on.
TEST_F (ScenarioLoadTest, AThrownStepsSetNextRequestIsDroppedOnBothRunKinds) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements ({ one_inline_script (
    "script.pre", "pm.execution.setNextRequest('step2');\nthrow new Error('x');") });

    constexpr size_t ITERATIONS = 2;
    const auto runs = run_both (server, execution, { "/s0", "/s1", "/s2" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ ITERATIONS, ITERATIONS, ITERATIONS }));
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);
}

// A thrown step whose switch names no step is `errored` once and abandons
// nothing: its jump is dropped before anything tries to resolve it, so it can
// never also be a jump the run could not honour.
TEST_F (ScenarioLoadTest, AThrownStepsUnresolvableSwitchIsDroppedNotRefused) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { one_inline_script ("script.post", "throw new Error('x');"), switch_to ("nowhere") });

    constexpr size_t ITERATIONS = 2;
    const auto runs = run_both (server, execution, { "/s0", "/s1" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ ITERATIONS, ITERATIONS }));
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("iterationsAbandoned"), 0) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);
}

// A jump past `maxStepsPerIteration` is the error of the step that set it, on
// both run kinds, under the same text naming the steps that cycled. The
// iteration still ends there, so step 1 is never reached, and on the load run
// it is still abandoned. Each iteration runs step 0 five times: four jumps
// honoured, the fifth refused. Mutation check: drop the `outcome =
// StepOutcome::Errored` for an abandoned step in `finish_step` and the load
// run's `errored` reads 0 against the collection run's 2.
TEST_F (ScenarioLoadTest, AJumpPastTheStepCapErrorsItsStepOnBothRunKinds) {
    set_config ("maxStepsPerIteration", "5");
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ switch_to ("step0") });

    constexpr size_t ITERATIONS = 2;
    const vayu::tests::LogCapture log;
    const auto runs = run_both (server, execution, { "/s0", "/s1" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ 5 * ITERATIONS, 0 }));
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("passed"), 4 * ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("iterationsAbandoned"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("steps").at (0).at ("errors"), 0)
    << "a refused jump is not a request error: " << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);

    ASSERT_EQ (runs.sequential_errors.size (), ITERATIONS);
    EXPECT_NE (runs.sequential_errors[0].find (
               "step0 -> step0 -> step0 -> step0 -> step0"),
    std::string::npos)
    << runs.sequential_errors[0];
    const auto lines = log.with_msg_prefix ("Scenario load run: iteration ");
    ASSERT_EQ (lines.size (), ITERATIONS);
    EXPECT_EQ (lines[0].at ("stepError"), runs.sequential_errors[0]) << lines[0].dump ();
}

// A target no step answers to is the same: `errored` on the step that set it,
// the iteration abandoned, and the collection run's text in the log.
TEST_F (ScenarioLoadTest, AnUnresolvableJumpErrorsItsStepOnBothRunKinds) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements =
    vayu::tests::compiled_elements ({ switch_to ("nowhere") });

    constexpr size_t ITERATIONS = 2;
    const vayu::tests::LogCapture log;
    const auto runs = run_both (server, execution, { "/s0", "/s1" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ ITERATIONS, 0 }));
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("iterationsAbandoned"), ITERATIONS) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);

    ASSERT_EQ (runs.sequential_errors.size (), ITERATIONS);
    const auto lines = log.with_msg_prefix ("Scenario load run: iteration ");
    ASSERT_EQ (lines.size (), ITERATIONS);
    EXPECT_EQ (lines[0].at ("stepError"), runs.sequential_errors[0]) << lines[0].dump ();
}

// A refused jump on a step that also failed an assertion is one `errored`
// execution, not also a `failed` one: the refusal is decided before the outcome
// is counted. Mutation check: count the outcome in `finish_step` before
// `decide_next_position` runs and `failed` reads 2 on the load run.
TEST_F (ScenarioLoadTest, ARefusedJumpOutranksAFailedAssertionOnBothRunKinds) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { json{ { "id", "el_status" }, { "kind", "assert.status" },
      { "enabled", true }, { "config", { { "in", json::array ({ 201 }) } } } },
    switch_to ("nowhere") });

    constexpr size_t ITERATIONS = 2;
    const auto runs = run_both (server, execution, { "/s0", "/s1" }, ITERATIONS);

    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("failed"), 0) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);
}

// A skipped step whose `control.loop` repeat is refused is `errored`, not
// `skipped`, and joins its step's `executed` though it sent nothing, which is
// what keeps the steps' `executed` plus `skipped` equal to `stepsExecuted`.
// Each iteration: skipped twice, then the third pass is refused. Mutation
// check: drop `record_unsent` for an `errored` execution that was not sent in
// `count_outcome` and the second identity is 2 short.
TEST_F (ScenarioLoadTest, ASkippedStepsRefusedRepeatIsErroredOnBothRunKinds) {
    set_config ("maxStepsPerIteration", "3");
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].elements = vayu::tests::compiled_elements (
    { { { "id", "el_if" }, { "kind", "control.if" }, { "enabled", true },
      { "config", { { "condition", "{{never_set}} exists" } } } },
    { { "id", "el_loop" }, { "kind", "control.loop" }, { "enabled", true },
    { "config", { { "count", 10 } } } } });

    constexpr size_t ITERATIONS = 2;
    const auto runs = run_both (server, execution, { "/s0", "/s1" }, ITERATIONS);

    EXPECT_EQ (runs.load_hits, (std::vector<size_t>{ 0, 0 }));
    EXPECT_EQ (runs.load_hits, runs.sequential_hits);
    EXPECT_EQ (runs.load.at ("skipped"), 2 * ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("errored"), ITERATIONS) << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("steps").at (0).at ("executed"), ITERATIONS)
    << runs.load.dump ();
    EXPECT_EQ (runs.load.at ("steps").at (0).at ("noResponse"), 0) << runs.load.dump ();
    expect_same_outcomes (runs.load, runs.sequential);
}
