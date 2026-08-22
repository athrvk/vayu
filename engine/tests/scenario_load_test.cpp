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
 */

#include "vayu/core/scenario_load.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>

#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/utils/encoding.hpp"

namespace {

using nlohmann::json;

/**
 * @brief A mock that issues a distinct session per `/login` and echoes back the
 *        `Cookie` header every other path was called with.
 *
 * `/login` can be made to wait for a second concurrent caller, which is what
 * makes "two VUs overlapped, and still did not share a session" a deterministic
 * assertion rather than a race the test hopes to win.
 */
class ScenarioMockServer {
    public:
    struct Hit {
        std::string path;
        std::string cookie; // The `Cookie` header as received; "" when absent.
        std::string body;   // The request body as received; "" for a GET.
        // The `Authorization` as received; "" when absent. Read off the wire
        // because a credential bound from a data row is only correct once it is
        // encoded, and the encoding is what used to hide the bug (issue #591).
        std::string authorization;
    };

    explicit ScenarioMockServer (size_t login_rendezvous = 0)
    : login_rendezvous_ (login_rendezvous) {
        svr.new_task_queue = [] { return new httplib::ThreadPool (64); };

        svr.Get ("/login", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/login");
            if (login_rendezvous_ > 0) {
                std::unique_lock<std::mutex> lock (rendezvous_mtx_);
                ++waiting_;
                rendezvous_cv_.notify_all ();
                // Bounded, so a single-VU run (or a lost wakeup) cannot wedge
                // the binary - the assertion, not the timeout, is what fails.
                rendezvous_cv_.wait_for (lock, std::chrono::seconds (5),
                [this] { return waiting_ >= login_rendezvous_; });
            }
            const size_t id = ++session_counter_;
            res.set_header ("Set-Cookie", "sid=" + std::to_string (id) + "; Path=/");
            res.set_content ("{}", "application/json");
        });

        for (const char* path : { "/echo", "/s0", "/s1", "/s2" }) {
            svr.Get (path, [this, path] (const httplib::Request& req, httplib::Response& res) {
                record (req, path);
                res.set_content ("{}", "application/json");
            });
        }

        // The body a bind produced, read off the wire rather than off the plan:
        // a body that binds cleanly and is then re-encoded downstream is still
        // a corrupt request (issue #593).
        svr.Post ("/body", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/body");
            res.set_content ("{}", "application/json");
        });

        // A `{{data.*}}` token substitutes into the path, so the row a virtual
        // user bound is readable off the wire rather than inferred from a
        // counter the test also owns.
        svr.Get (R"(/row/(.*))", [this] (const httplib::Request& req, httplib::Response& res) {
            record (req, "/row/" + req.matches[1].str ());
            res.set_content ("{}", "application/json");
        });

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }

    ~ScenarioMockServer () {
        {
            std::lock_guard<std::mutex> lock (rendezvous_mtx_);
            login_rendezvous_ = 0;
        }
        rendezvous_cv_.notify_all ();
        svr.stop ();
        if (thread.joinable ())
            thread.join ();
    }

    [[nodiscard]] std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }

    [[nodiscard]] std::vector<Hit> hits () const {
        std::lock_guard<std::mutex> lock (hits_mtx_);
        return hits_;
    }

    [[nodiscard]] std::vector<Hit> hits_for (const std::string& path) const {
        std::vector<Hit> matching;
        for (const auto& hit : hits ()) {
            if (hit.path == path)
                matching.push_back (hit);
        }
        return matching;
    }

    private:
    void record (const httplib::Request& req, const std::string& path) {
        std::lock_guard<std::mutex> lock (hits_mtx_);
        hits_.push_back ({ path, req.get_header_value ("Cookie"), req.body,
        req.get_header_value ("Authorization") });
    }

    httplib::Server svr;
    std::thread thread;
    int port = 0;

    mutable std::mutex hits_mtx_;
    std::vector<Hit> hits_;

    std::atomic<size_t> session_counter_{ 0 };
    std::mutex rendezvous_mtx_;
    std::condition_variable rendezvous_cv_;
    size_t login_rendezvous_ = 0;
    size_t waiting_          = 0;
};

const std::string TEST_DB_PATH = "test_scenario_load.db";

class ScenarioLoadTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (TEST_DB_PATH);
        db_->init ();
    }

    void TearDown () override {
        db_.reset ();
        vayu::http::global_cleanup ();
        cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (TEST_DB_PATH);
    }

    /// A plan whose steps hit @p urls in order, named `step0`, `step1`, ...
    static vayu::core::ScenarioExecution plan_over (const std::vector<std::string>& urls) {
        vayu::core::ScenarioExecution execution;
        execution.request.source        = "collection";
        execution.request.collection_id = "col_test";
        for (size_t i = 0; i < urls.size (); ++i) {
            vayu::core::ScenarioStep step;
            step.index              = i;
            step.request_id         = "req_" + std::to_string (i);
            step.name               = "step" + std::to_string (i);
            step.request.method     = vayu::HttpMethod::GET;
            step.request.url        = urls[i];
            step.request.timeout_ms = 5000;
            step.stored_url         = urls[i];
            execution.plan.steps.push_back (std::move (step));
        }
        return execution;
    }

    /// Run the executor to completion and drain, the way `execute_load_test`
    /// does around it - the tallies are only final after the drain.
    ///
    /// @param pool_size The event loop's `max_concurrent`, which is also the
    ///        number of curl handles pre-created per worker. The cookie tests
    ///        set it to exactly the virtual-user count so the pool *wraps* and
    ///        every transfer after the first reuses a handle a previous one
    ///        finished with. At the default (hundreds) a short test never
    ///        reuses a handle at all, so it could not observe a session leaking
    ///        through one - the pool would be doing the isolating, not the code
    ///        under test.
    std::shared_ptr<vayu::core::ScenarioLoadState> run (const json& config,
    const vayu::core::ScenarioExecution& execution,
    size_t pool_size = 500) {
        auto context =
        std::make_shared<vayu::core::RunContext> ("test-scenario-load", config);
        // Set the way `execute_load_test` does, so the deferred validation pass
        // finds the plan where production leaves it rather than where a test
        // handed it over.
        context->scenario =
        std::make_shared<const vayu::core::ScenarioExecution> (execution);
        vayu::http::EventLoopConfig loop_config;
        loop_config.max_concurrent = pool_size;
        loop_config.max_per_host   = 500;
        context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
        context->event_loop->start ();

        auto state = vayu::core::execute_scenario_load (context, *db_, *context->scenario);
        context->event_loop->stop (true, std::chrono::milliseconds (10000));
        context_ = context;
        return state;
    }

    /// Tokenise every step of @p execution the way plan resolution does, and
    /// give the run @p rows. Going through `tokenize_data_fields` rather than
    /// hand-building a template is deliberate: a test that built its own would
    /// pass against a splitter the resolver never uses.
    static void with_data (vayu::core::ScenarioExecution& execution,
    const std::vector<json>& rows) {
        for (auto& step : execution.plan.steps) {
            step.data_template = vayu::core::tokenize_data_fields (step.request);
        }
        execution.data_rows = rows;
    }

    /// Give every step the deferred auth `resolve_scenario` leaves behind for
    /// credentials carrying a `{{data.*}}` token - through the resolver's own
    /// two calls, for the same reason `with_data` uses the real splitter.
    static void with_deferred_auth (vayu::core::ScenarioExecution& execution,
    const json& auth) {
        for (auto& step : execution.plan.steps) {
            step.auth          = vayu::http::parse_auth (auth);
            step.auth_template = vayu::core::tokenize_auth_fields (step.auth);
        }
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::shared_ptr<vayu::core::RunContext> context_;
};

} // namespace

// ============================================================================
// Mode validation - the one rule with teeth
// ============================================================================

TEST (ScenarioLoadConfig, ConstantRpsIsRefusedForAScenario) {
    const json config = { { "scenario", { { "collectionId", "c" } } },
        { "mode", "constant_rps" }, { "duration", "10s" } };

    ASSERT_TRUE (vayu::core::is_scenario_load_run (config));
    const auto refusal = vayu::core::validate_scenario_load_config (config);
    ASSERT_TRUE (refusal.has_value ())
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
    ASSERT_TRUE (refusal.has_value ())
    << "capacity with a scenario must be refused: the search judges one "
       "windowed p99 and a sequence has one per step";
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

    EXPECT_EQ (state->iterations_started, 4u);
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

// ============================================================================
// Per-step metrics
// ============================================================================

// One histogram per step, and the whole-run aggregate is their union: every
// completion is counted exactly once, in exactly one step.
TEST_F (ScenarioLoadTest, PerStepHistogramsPartitionTheRunsCompletions) {
    ScenarioMockServer server;
    const auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 5 },
        { "concurrency", 2 } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.step_count (), 3u)
    << "histograms are allocated once from the plan's step count";

    size_t union_of_steps = 0;
    for (size_t i = 0; i < state->steps.step_count (); ++i) {
        EXPECT_EQ (state->steps.completed (i), 5u) << "step " << i;
        EXPECT_EQ (state->steps.errors (i), 0u) << "step " << i;
        EXPECT_GT (state->steps.percentiles (i).p50, 0.0)
        << "step " << i << " recorded no latency";
        union_of_steps += state->steps.completed (i);
    }
    EXPECT_EQ (union_of_steps, context_->total_requests ())
    << "the per-step histograms and the run aggregate disagree about how many "
       "completions there were";
}

// A step no VU ever reached reports zeros, not the INT64_MAX an empty
// HdrHistogram answers `min` with.
TEST_F (ScenarioLoadTest, AnUnreachedStepReportsZeroesRatherThanAnEmptyHistogramsMin) {
    ScenarioMockServer server;
    const auto execution = plan_over (
    { server.url ("/s0"), "http://127.0.0.1:1/unreachable", server.url ("/s2") });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    ASSERT_EQ (state->steps.completed (2), 0u);
    const auto unreached = state->steps.percentiles (2);
    EXPECT_EQ (unreached.min, 0.0);
    EXPECT_EQ (unreached.max, 0.0);
}

// Contract coverage under load (issue #629). What this pins that the tally's
// own tests cannot: the completion callback records on the real event loop, so
// every virtual user's send lands on the right operation - and the count is
// exact rather than derived from the bounded store the mode thins.
TEST_F (ScenarioLoadTest, ALoadRunCountsEveryCompletionAgainstItsOperation) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].spec_operation =
    R"({"operationId":"listPets","method":"GET","path":"/pets"})";
    // Step 1 names no operation at all, so its sends land in the off-contract
    // tally rather than on a row they do not belong to.
    vayu::core::DeclaredOperation listed;
    listed.operation_id = "listPets";
    listed.method       = "GET";
    listed.path         = "/pets";
    listed.responses    = { "200", "404" };
    vayu::core::DeclaredOperation never;
    never.operation_id                 = "deletePet";
    never.method                       = "DELETE";
    never.path                         = "/pets/{petId}";
    never.responses                    = { "204" };
    execution.spec.spec_id             = "spec_1";
    execution.spec.declared_operations = { listed, never };

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto coverage = vayu::core::build_scenario_load_coverage (*state);
    ASSERT_FALSE (coverage.empty ()) << "a bound run must report coverage";
    EXPECT_EQ (coverage["operationsTotal"], 2);
    EXPECT_EQ (coverage["operationsCovered"], 1);
    // Three iterations, one send of step 0 each - exact, not a sample.
    for (const auto& row : coverage["operations"]) {
        if (row["path"] == "/pets") {
            EXPECT_EQ (row["sent"], 3);
            EXPECT_EQ (row["declaredHit"], json::array ({ "200" }));
            EXPECT_EQ (row["declaredMissed"], json::array ({ "404" }));
        }
    }
    EXPECT_EQ (coverage["undeclaredOperationRequests"], 3);
}

// The other half of the per-mode rule: a load run of an unbound collection - the
// overwhelming majority - writes no coverage at all rather than a contract of
// zero operations.
TEST_F (ScenarioLoadTest, AnUnboundLoadRunReportsNoCoverageAtAll) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/s0") });

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    EXPECT_TRUE (vayu::core::build_scenario_load_coverage (*state).empty ());
}

// The breakdown carries each step's identity beside its numbers, and the
// summary keeps the keys the report route already reads for a scenario run.
TEST_F (ScenarioLoadTest, TheSummaryCarriesAPerStepBreakdownAndTheSharedScenarioKeys) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    auto state        = run (config, execution);

    const auto summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);

    // Shared with the design-mode runner's payload, so one report section
    // covers both executors.
    EXPECT_EQ (summary["iterations"], 2);
    EXPECT_EQ (summary["iterations_completed"], 2);
    EXPECT_EQ (summary["steps_executed"], 4);
    EXPECT_EQ (summary["errored"], 0);
    // This mode's own.
    EXPECT_EQ (summary["virtual_users"], 1);

    ASSERT_TRUE (summary["steps"].is_array ());
    ASSERT_EQ (summary["steps"].size (), 2u);
    EXPECT_EQ (summary["steps"][0]["index"], 0);
    EXPECT_EQ (summary["steps"][0]["name"], "step0");
    EXPECT_EQ (summary["steps"][0]["requestId"], "req_0");
    EXPECT_EQ (summary["steps"][0]["method"], "GET");
    EXPECT_EQ (summary["steps"][0]["executed"], 2);
    EXPECT_EQ (summary["steps"][1]["name"], "step1");
    EXPECT_TRUE (summary["steps"][0]["latency"].contains ("p99"));
}

// Scripts stay deferred: a load-mode scenario runs none of them inline, and the
// run acquires no run-level script to stand in for the steps' own. What it does
// acquire (issue #450) is a per-step sample store for the steps that carry one,
// which the deferred pass below replays against.
TEST_F (ScenarioLoadTest, AScenarioLoadRunRunsNoInlineScriptsAndSamplesOnlyScriptedSteps) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    // A step that carries scripts, so "none ran inline" is a property of the
    // executor rather than of an empty plan.
    execution.plan.steps[0].pre_script  = "pm.environment.set('x', '1');";
    execution.plan.steps[0].post_script = "pm.test('t', function () { });";

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    EXPECT_TRUE (context_->test_script.empty ())
    << "a scenario load run must not acquire a run-level test script";
    const auto& mc = *context_->metrics_collector;
    EXPECT_EQ (mc.response_samples ().size (), 0u)
    << "a scenario run must not fill the run-level store - its scripts are per "
       "step";
    EXPECT_GT (mc.step_response_samples (0).size (), 0u)
    << "the step carrying a post-request script was never sampled, so its "
       "assertions can never be checked";
    EXPECT_EQ (mc.step_response_samples (1).size (), 0u)
    << "a step with no script was sampled - a body-sized copy nothing will "
       "read";
}

// A plan whose steps assert nothing gets no stores at all, which is what keeps
// the report's section absent rather than showing zeros.
TEST_F (ScenarioLoadTest, APlanWithNoScriptsSamplesNothing) {
    ScenarioMockServer server;
    const auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 } };
    run (config, execution);

    const auto& mc = *context_->metrics_collector;
    EXPECT_EQ (mc.step_response_samples (0).size (), 0u);
    EXPECT_EQ (mc.step_response_samples (1).size (), 0u);
    EXPECT_EQ (mc.response_samples_dropped (), 0u)
    << "a step nothing will validate must not be counted as a thinned sample";

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);
    EXPECT_FALSE (validation.run.has_value ())
    << "a run that validated nothing must omit the section, not report zeros";
}

// Sampling is keyed per step, so the last step of a long plan is sampled even
// when the run budget is far smaller than the number of completions.
//
// Mutation-check: revert to the flat whole-run reservoir and every one of these
// stores is empty - the run's samples all land in `response_samples()`, where
// nothing can tell which step produced them.
TEST_F (ScenarioLoadTest, EveryScriptedStepIsSampledIncludingTheLast) {
    ScenarioMockServer server;
    // Four steps over three distinct paths - the plan is what is long here, not
    // the mock. Every step asserts, so every step competes for the budget.
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1"),
    server.url ("/s2"), server.url ("/echo") });
    for (auto& step : execution.plan.steps) {
        step.post_script = "pm.test('ok', function () { });";
    }

    // A budget of exactly one slot per scripted step, so the split is what
    // decides coverage rather than a budget large enough to hide it.
    const json config = { { "mode", "iterations" }, { "iterations", 6 },
        { "concurrency", 1 }, { "max_response_samples", 4 },
        { "response_sample_rate", 1 } };
    run (config, execution);

    const auto& mc  = *context_->metrics_collector;
    size_t retained = 0;
    for (size_t step = 0; step < execution.plan.steps.size (); ++step) {
        EXPECT_GT (mc.step_response_samples (step).size (), 0u)
        << "step " << step << " was never sampled, so its assertions are never checked";
        retained += mc.step_response_samples (step).size ();
    }
    EXPECT_LE (retained, 4u) << "the run budget was handed to each step whole "
                                "instead of split across them";
    EXPECT_GT (mc.response_samples_dropped (), 0u)
    << "24 completions into a 4-sample budget must report what was thinned";
}

// ============================================================================
// Deferred per-step script validation (issue #450)
// ============================================================================

// Each step's own `post_script` is replayed against that step's samples, and a
// step with no script reports no tallies at all.
TEST_F (ScenarioLoadTest, EachStepsScriptIsReplayedAgainstItsOwnSamples) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].post_script =
    "pm.test('ok', function () { pm.expect(pm.response.code).to.equal(200); "
    "});";

    const json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);

    ASSERT_EQ (validation.steps.size (), 2u);
    ASSERT_TRUE (validation.steps[0].has_value ())
    << "the scripted step reported no tallies, so its assertions went "
       "unchecked";
    EXPECT_EQ (validation.steps[0]->sampled, 3u);
    EXPECT_EQ (validation.steps[0]->passed, 3u);
    EXPECT_EQ (validation.steps[0]->failed, 0u);
    EXPECT_FALSE (validation.steps[1].has_value ())
    << "a step with no script must report nothing rather than a row of zeros";

    ASSERT_TRUE (validation.run.has_value ());
    EXPECT_EQ (validation.run->sampled, 3u);
    EXPECT_EQ (validation.run->passed, 3u);
}

// A failing assertion is attributed to the step that made it, not to the run -
// which is the whole reason the tallies are per step.
TEST_F (ScenarioLoadTest, AFailingAssertionIsAttributedToItsOwnStep) {
    ScenarioMockServer server;
    auto execution =
    plan_over ({ server.url ("/s0"), server.url ("/s1"), server.url ("/s2") });
    execution.plan.steps[0].post_script =
    "pm.test('ok', function () { pm.expect(pm.response.code).to.equal(200); "
    "});";
    execution.plan.steps[1].post_script =
    "pm.test('wrong', function () { pm.expect(pm.response.code).to.equal(500); "
    "});";

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);

    ASSERT_EQ (validation.steps.size (), 3u);
    ASSERT_TRUE (validation.steps[0].has_value ());
    EXPECT_EQ (validation.steps[0]->failed, 0u);
    EXPECT_EQ (validation.steps[0]->passed, 2u);
    ASSERT_TRUE (validation.steps[1].has_value ());
    EXPECT_EQ (validation.steps[1]->failed, 2u)
    << "step 2's failing assertion was not attributed to step 2";
    EXPECT_EQ (validation.steps[1]->passed, 0u);
    EXPECT_FALSE (validation.steps[2].has_value ());

    // The run's headline still says something failed; the breakdown says where.
    ASSERT_TRUE (validation.run.has_value ());
    EXPECT_EQ (validation.run->failed, 2u);
    EXPECT_EQ (validation.run->passed, 2u);
}

// The replayed script reads the iteration it actually ran in and the data row
// that iteration was bound to - a real index, not a reservoir position.
TEST_F (ScenarioLoadTest, ADeferredStepScriptReadsItsIterationAndDataRow) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/row/{{data.id}}") });
    with_data (execution, { json{ { "id", "a" } }, json{ { "id", "b" } } });
    // Two iterations bind rows 0 and 1, so a script that pairs the iteration
    // with its row passes only if both bindings are the real ones.
    execution.plan.steps[0].post_script =
    "pm.test('bound', function () {"
    "  var expected = pm.info.iteration === 0 ? 'a' : 'b';"
    "  if (pm.iterationData.get('id') !== expected) {"
    "    throw new Error('iteration ' + pm.info.iteration + ' saw ' +"
    "      pm.iterationData.get('id'));"
    "  }"
    "});";

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);
    ASSERT_EQ (validation.steps.size (), 1u);
    ASSERT_TRUE (validation.steps[0].has_value ());
    EXPECT_EQ (validation.steps[0]->passed, 2u);
    EXPECT_EQ (validation.steps[0]->failed, 0u);
}

// `pm.execution` still throws, naming itself: a script that has already run
// against a recorded response cannot redirect a sequence that already happened.
TEST_F (ScenarioLoadTest, PmExecutionStillThrowsInADeferredStepScript) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0") });
    // The assertion passes only if the call threw *and* the sentence named the
    // method - so a silently accepted call fails this test rather than reading
    // as a pass.
    execution.plan.steps[0].post_script =
    "pm.test('refused', function () {"
    "  var message = '';"
    "  try { pm.execution.setNextRequest('somewhere'); }"
    "  catch (e) { message = String(e && e.message ? e.message : e); }"
    "  if (message.indexOf('setNextRequest') === -1) {"
    "    throw new Error('not refused by name: ' + message);"
    "  }"
    "});";

    const json config = { { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);
    ASSERT_EQ (validation.steps.size (), 1u);
    ASSERT_TRUE (validation.steps[0].has_value ());
    EXPECT_EQ (validation.steps[0]->passed, 1u);
    EXPECT_EQ (validation.steps[0]->failed, 0u);
}

// The tallies land on the step they belong to in the stored summary, which is
// what the report route hands the app verbatim.
TEST_F (ScenarioLoadTest, PerStepTalliesAreAttachedToTheStoredBreakdown) {
    ScenarioMockServer server;
    auto execution = plan_over ({ server.url ("/s0"), server.url ("/s1") });
    execution.plan.steps[0].post_script = "pm.test('ok', function () { });";

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    auto state        = run (config, execution);

    const auto validation = vayu::core::validate_scripts (context_, *db_, false);
    auto summary =
    vayu::core::build_scenario_load_summary (*state, context_->scenario->plan);
    vayu::core::attach_step_test_totals (summary, validation.steps);

    ASSERT_TRUE (summary["steps"].is_array ());
    ASSERT_EQ (summary["steps"].size (), 2u);
    ASSERT_TRUE (summary["steps"][0].contains ("tests"));
    EXPECT_EQ (summary["steps"][0]["tests"]["sampled"], 2);
    EXPECT_EQ (summary["steps"][0]["tests"]["passed"], 2);
    EXPECT_EQ (summary["steps"][0]["tests"]["failed"], 0);
    EXPECT_FALSE (summary["steps"][1].contains ("tests"))
    << "a step that asserted nothing must carry no tests object at all";
}

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
    execution.plan.steps[0].post_script = "pm.test('t', function () { });";

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

    const auto totals = vayu::core::validate_sampled_responses (context_, false);

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
    execution.plan.steps[0].post_script = "pm.test('t', function () { });";

    const json config = { { "mode", "iterations" }, { "iterations", 2 },
        { "concurrency", 1 }, { "response_sample_rate", 1 } };
    run (config, execution);

    const auto totals = vayu::core::validate_sampled_responses (context_, false);
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

    EXPECT_EQ (vayu::core::validate_sampled_responses (context_, false).sampled, 0u);
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

    const auto totals = vayu::core::validate_sampled_responses (context_, false);
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

    const auto totals = vayu::core::validate_sampled_responses (context_, false);
    EXPECT_GT (totals.sampled, 0u);
    EXPECT_LE (totals.sampled, 4u)
    << "the pass validated more than the reservoirs could hold";
    EXPECT_LT (totals.sampled, 16u)
    << "16 completions into a 4-sample budget must have been thinned";
    EXPECT_GT (context_->metrics_collector->response_samples_dropped (), 0u)
    << "what was thinned must be reported, or the tallies read as the whole "
       "run";
}
