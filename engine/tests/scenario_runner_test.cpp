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
 *  - **`pm.info.iteration`.** Set by this runner and by nothing else.
 *  - **Bounded step results.** Failures are kept first, successes are thinned,
 *    and what was thinned is disclosed rather than presented as complete.
 *
 * The runner is driven directly through `RunManager::start_scenario_run`
 * against a real database and an in-process mock server: no HTTP route in
 * front, matching the suite's other run tests.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;
using vayu::core::ScenarioStepStore;
using vayu::core::StepOutcome;

namespace {

/// One request the mock server saw, in the order it saw them.
struct SeenRequest {
    std::string path;
    std::string cookie;
    std::string marker; // the X-Marker header, which the tests' scripts set
};

/**
 * Endpoints a sequence needs: something that succeeds, something that hands out
 * a session, and something whose handler can look at the world mid-run (which
 * is how "persisted once, at run end" is asserted rather than assumed).
 */
class ScenarioMockServer {
    public:
    ScenarioMockServer () {
        svr.new_task_queue = [] { return new httplib::ThreadPool (8); };

        const auto record = [this] (const httplib::Request& req) {
            std::lock_guard<std::mutex> lock (mtx);
            seen.push_back ({ req.path, req.get_header_value ("Cookie"),
            req.get_header_value ("X-Marker") });
        };

        svr.Get ("/ok", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/login", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_header ("Set-Cookie", "sid=session-1; Path=/");
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/observe",
        [this, record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            if (observer) {
                observer ();
            }
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/slow", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            std::this_thread::sleep_for (std::chrono::milliseconds (120));
            res.set_content ("{}", "application/json");
        });

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }

    ~ScenarioMockServer () {
        svr.stop ();
        if (thread.joinable ()) {
            thread.join ();
        }
    }

    [[nodiscard]] std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }

    [[nodiscard]] std::vector<SeenRequest> requests () const {
        std::lock_guard<std::mutex> lock (mtx);
        return seen;
    }

    /// Called on the server thread while the run is in flight.
    std::function<void ()> observer;

    private:
    httplib::Server svr;
    std::thread thread;
    int port = 0;
    mutable std::mutex mtx;
    std::vector<SeenRequest> seen;
};

class ScenarioRunnerTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_scenario_runner.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        server_ = std::make_unique<ScenarioMockServer> ();
    }
    void TearDown () override {
        manager_.shutdown ();
        server_.reset ();
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        for (const char* suffix : { "", "-wal", "-shm", ".bak" }) {
            std::filesystem::remove (std::string (DB_PATH) + suffix);
        }
    }

    void seed_collection (const std::string& id, const std::string& variables = "") {
        vayu::db::Collection col;
        col.id         = id;
        col.name       = "Collection " + id;
        col.variables  = variables;
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    /// Override a seeded config value, keeping the rest of its row intact.
    void set_config (const std::string& key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_TRUE (entry.has_value ()) << key << " is not a seeded config key";
        entry->value = value;
        db_->save_config_entry (*entry);
    }

    void seed_environment (const std::string& id, const std::string& variables) {
        vayu::db::Environment env;
        env.id         = id;
        env.name       = "Env " + id;
        env.variables  = variables;
        env.created_at = 1;
        env.updated_at = 1;
        db_->save_environment (env);
    }

    /// A request in `col_1`, ordered by @p order, pointing at the mock server.
    /// @p name defaults to one derived from @p id; flow-control tests pass it
    /// explicitly, because `setNextRequest` targets a *name*.
    void seed_request (const std::string& id,
    int order,
    const std::string& path,
    const std::string& pre_script   = "",
    const std::string& post_script  = "",
    const std::string& absolute_url = "",
    const std::string& name         = "") {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = "col_1";
        r.name          = name.empty () ? "Step " + id : name;
        r.method        = vayu::HttpMethod::GET;
        r.url = absolute_url.empty () ? server_->url (path) : absolute_url;
        r.pre_request_script  = pre_script;
        r.post_request_script = post_script;
        r.order               = order;
        r.created_at          = 1;
        r.updated_at          = 1;
        db_->save_request (r);
    }

    /// Resolve, create the run row and start the worker, exactly as POST /runs
    /// does - minus the HTTP layer.
    std::string start (size_t iterations, const std::string& environment_id = "") {
        json scenario{ { "source", "collection" }, { "collectionId", "col_1" },
            { "iterations", iterations } };

        vayu::core::ScenarioResolveOptions options;
        options.timeout_ms           = 5000;
        options.environment_id       = environment_id;
        options.limits.max_steps     = 200;
        options.limits.max_data_rows = 1000;

        auto resolved = vayu::core::resolve_scenario (*db_, scenario, options);
        EXPECT_TRUE (resolved.ok) << resolved.error;

        auto execution     = std::make_shared<vayu::core::ScenarioExecution> ();
        execution->request = std::move (resolved.request);
        execution->plan    = std::move (resolved.plan);

        json config{ { "scenario", scenario } };
        if (!environment_id.empty ()) {
            config["environmentId"] = environment_id;
        }

        const std::string run_id = "run_scenario_1";
        vayu::db::Run run;
        run.id     = run_id;
        run.type   = vayu::RunType::Scenario;
        run.status = vayu::RunStatus::Pending;
        if (!environment_id.empty ()) {
            run.environment_id = environment_id;
        }
        run.config_snapshot = config.dump ();
        // A real wall-clock stamp, not a token 1: reaching a terminal status
        // prunes the run history by the retention knobs, and a run dated 1970
        // is pruned - with its results - the moment it finishes.
        const auto started_at = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                                .count ();
        run.start_time = started_at;
        run.end_time   = started_at;
        db_->create_run (run);

        EXPECT_TRUE (manager_.start_scenario_run (
        run_id, config, execution, *db_, jar_, /*verbose=*/false));
        return run_id;
    }

    /// Block until the run leaves `pending`/`running`, or give up loudly.
    vayu::RunStatus await_terminal (const std::string& run_id) {
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (30);
        while (std::chrono::steady_clock::now () < deadline) {
            auto run = db_->get_run (run_id);
            if (run && run->status != vayu::RunStatus::Pending &&
            run->status != vayu::RunStatus::Running) {
                // The worker writes the status before its last acts (retain,
                // closed); give it the moment it needs so a following
                // assertion on those does not race it.
                std::this_thread::sleep_for (std::chrono::milliseconds (50));
                return run->status;
            }
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
        }
        ADD_FAILURE () << "Run " << run_id << " never reached a terminal status";
        return vayu::RunStatus::Failed;
    }

    [[nodiscard]] json summary_of (const std::string& run_id) {
        auto run = db_->get_run (run_id);
        EXPECT_TRUE (run.has_value ());
        return json::parse (run->summary);
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::unique_ptr<ScenarioMockServer> server_;
    vayu::core::RunManager manager_;
    vayu::http::CookieJar jar_;
};

// ============================================================================
// Sequence semantics
// ============================================================================

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
    ASSERT_TRUE (run.has_value ());
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
    ASSERT_TRUE (env.has_value ());
    EXPECT_NE (env->variables.find ("from-step-1"), std::string::npos);
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

// ============================================================================
// Failure paths
// ============================================================================

TEST_F (ScenarioRunnerTest, AnErroredStepEndsItsIterationAndTheRunStillCompletes) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    // Nothing listens on port 1; the send fails to connect rather than hanging.
    seed_request ("req_dead", 1, "", "", "", "http://127.0.0.1:1/never");
    seed_request ("req_c", 2, "/login");

    const auto run_id = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    // Step 3 never runs in either iteration - the iteration ended at the step
    // that did not complete - but the second iteration still started.
    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[0].path, "/ok");
    EXPECT_EQ (seen[1].path, "/ok");

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["steps_executed"].get<size_t> (), 4u);
    EXPECT_EQ (scenario["passed"].get<size_t> (), 2u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 2u);
    EXPECT_EQ (scenario["iterations_completed"].get<size_t> (), 2u);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 4u);
    EXPECT_EQ (json::parse (rows[1].trace_data)["outcome"].get<std::string> (), "errored");
    EXPECT_FALSE (rows[1].error.empty ());
}

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

TEST_F (ScenarioRunnerTest, AStopIsHonouredBetweenStepsNotAfterTheIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/slow");
    seed_request ("req_b", 1, "/slow");
    seed_request ("req_c", 2, "/slow");
    seed_request ("req_d", 3, "/slow");

    const auto run_id = start (/*iterations=*/20);
    auto context      = manager_.get_run (run_id);
    ASSERT_TRUE (context != nullptr);

    // Long enough for the run to be inside its first iteration, short enough
    // that it cannot have finished 80 steps of 120ms each.
    std::this_thread::sleep_for (std::chrono::milliseconds (150));
    context->should_stop = true;

    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Stopped);

    auto scenario       = summary_of (run_id)["scenario"];
    const auto executed = scenario["steps_executed"].get<size_t> ();
    EXPECT_LT (executed, 20u * 4u);
    // The whole iteration would be 4 steps; the stop landed inside one.
    EXPECT_LT (executed, 8u);
    EXPECT_EQ (scenario["iterations_completed"].get<size_t> (), 0u);
}

// ============================================================================
// Bounded step storage
// ============================================================================

TEST_F (ScenarioRunnerTest, TheStoreKeepsEveryFailureFirstAndThinsSuccesses) {
    // Capacity 3, offered five successes then two failures: every failure is
    // kept, the successes that survive are the run's opening, and the
    // displaced ones are counted.
    ScenarioStepStore store (3);
    for (int i = 0; i < 5; ++i) {
        vayu::db::Result row;
        row.status_code = 200 + i;
        store.add (std::move (row), /*kept_first=*/false);
    }
    EXPECT_EQ (store.stored (), 3u);
    EXPECT_EQ (store.dropped (), 2u);

    for (int i = 0; i < 2; ++i) {
        vayu::db::Result row;
        row.status_code = 500 + i;
        store.add (std::move (row), /*kept_first=*/true);
    }

    auto rows = store.take ();
    ASSERT_EQ (rows.size (), 3u);
    EXPECT_EQ (store.dropped (), 4u);
    // Execution order is preserved across the two stores.
    EXPECT_EQ (rows[0].status_code, 200);
    EXPECT_EQ (rows[1].status_code, 500);
    EXPECT_EQ (rows[2].status_code, 501);
}

TEST_F (ScenarioRunnerTest, TheStoreRefusesAFailureOnlyWhenNoSuccessIsLeftToDisplace) {
    ScenarioStepStore store (2);
    for (int i = 0; i < 3; ++i) {
        vayu::db::Result row;
        row.status_code = 500 + i;
        store.add (std::move (row), /*kept_first=*/true);
    }

    auto rows = store.take ();
    ASSERT_EQ (rows.size (), 2u);
    EXPECT_EQ (rows[0].status_code, 500);
    EXPECT_EQ (rows[1].status_code, 501);
    EXPECT_EQ (store.dropped (), 1u);
}

TEST_F (ScenarioRunnerTest, ACapacityOfZeroStoresEverything) {
    ScenarioStepStore store (0);
    for (int i = 0; i < 50; ++i) {
        store.add (vayu::db::Result{}, /*kept_first=*/i % 2 == 0);
    }
    EXPECT_EQ (store.take ().size (), 50u);
    EXPECT_EQ (store.dropped (), 0u);
}

TEST_F (ScenarioRunnerTest, ThinningIsDisclosedRatherThanPresentedAsComplete) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/ok");
    set_config ("maxScenarioStoredSteps", "3");

    const auto run_id = start (/*iterations=*/3);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_EQ (db_->get_results (run_id).size (), 3u);

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["steps_executed"].get<size_t> (), 6u);
    EXPECT_EQ (scenario["steps_stored"].get<size_t> (), 3u);
    EXPECT_EQ (scenario["steps_dropped"].get<size_t> (), 3u);
    // The report counts the run's real size, not the rows that survived.
    EXPECT_EQ (summary_of (run_id)["total_requests"].get<size_t> (), 6u);
}

// ============================================================================
// The live stream
// ============================================================================

TEST_F (ScenarioRunnerTest, StepEventsCarryTheStepAndKeepMonotonicIdsAcrossEviction) {
    vayu::core::StepRecord record;
    record.iteration   = 2;
    record.step_index  = 1;
    record.step_name   = "Login";
    record.outcome     = StepOutcome::Failed;
    record.status_code = 500;
    record.latency_ms  = 12.5;

    const auto payload = vayu::core::build_step_payload (record, 7);
    EXPECT_NE (payload.find ("event: step\n"), std::string::npos);
    EXPECT_NE (payload.find ("id: 7\n"), std::string::npos);
    const auto data_at = payload.find ("data: ");
    ASSERT_NE (data_at, std::string::npos);
    auto data = json::parse (payload.substr (data_at + 6));
    EXPECT_EQ (data["iteration"].get<size_t> (), 2u);
    EXPECT_EQ (data["stepIndex"].get<size_t> (), 1u);
    EXPECT_EQ (data["name"].get<std::string> (), "Login");
    EXPECT_EQ (data["outcome"].get<std::string> (), "failed");
    EXPECT_EQ (data["statusCode"].get<int> (), 500);
    EXPECT_DOUBLE_EQ (data["latencyMs"].get<double> (), 12.5);

    // The ring evicts; the ids do not restart, which is what makes
    // `Last-Event-ID` resume land on the right event.
    vayu::core::RunContext context ("run_ring", json::object ());
    context.set_max_live_ticks (2);
    for (size_t i = 0; i < 5; ++i) {
        context.append_tick (
        vayu::core::build_step_payload (record, context.published_count.load ()));
    }
    EXPECT_EQ (context.published_count.load (), 5u);
    auto batch = context.ticks_since (0);
    ASSERT_EQ (batch.payloads.size (), 2u);
    EXPECT_NE (batch.payloads[0].find ("id: 3\n"), std::string::npos);
    EXPECT_NE (batch.payloads[1].find ("id: 4\n"), std::string::npos);
    EXPECT_EQ (batch.next_offset, 5u);
}

TEST_F (ScenarioRunnerTest, TheRunPublishesOneStepEventPerStepAndClosesTheStream) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/2);
    auto context      = manager_.get_run (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    EXPECT_EQ (context->published_count.load (), 4u);
    EXPECT_TRUE (context->closed.load ());
    auto batch = context->ticks_since (0);
    ASSERT_EQ (batch.payloads.size (), 4u);
    for (const auto& payload : batch.payloads) {
        EXPECT_NE (payload.find ("event: step\n"), std::string::npos);
    }
}

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

TEST_F (ScenarioRunnerTest, SkipRequestInATestScriptFailsTheStepRatherThanPretending) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", R"(pm.execution.skipRequest();)");
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    // The request had already gone out; what fails is the script.
    EXPECT_EQ (server_->requests ().size (), 1u);

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_EQ (json::parse (rows[0].trace_data)["outcome"].get<std::string> (), "errored");
    EXPECT_NE (rows[0].error.find ("pre-request"), std::string::npos) << rows[0].error;

    auto scenario = summary_of (run_id)["scenario"];
    EXPECT_EQ (scenario["skipped"].get<size_t> (), 0u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 1u);
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

// ============================================================================
// Flow-control resolution (pure)
// ============================================================================

TEST (ScenarioNextStep, ResolvesAUniqueNameToItsPosition) {
    vayu::core::ScenarioPlan plan;
    plan.steps.push_back ({ 0, "req_a", "First", {}, "", "", "" });
    plan.steps.push_back ({ 1, "req_b", "Second", {}, "", "", "" });

    const auto index = vayu::core::build_step_name_index (plan);
    auto resolved    = vayu::core::resolve_next_step (index, "Second");
    ASSERT_TRUE (resolved.ok) << resolved.error;
    EXPECT_EQ (resolved.index, 1u);
    EXPECT_TRUE (resolved.error.empty ());
}

TEST (ScenarioNextStep, RefusesANameNoStepCarries) {
    vayu::core::ScenarioPlan plan;
    plan.steps.push_back ({ 0, "req_a", "First", {}, "", "", "" });

    auto resolved = vayu::core::resolve_next_step (
    vayu::core::build_step_name_index (plan), "Missing");
    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("Missing"), std::string::npos) << resolved.error;
}

TEST (ScenarioNextStep, RefusesADuplicatedNameAndNamesEveryPosition) {
    vayu::core::ScenarioPlan plan;
    plan.steps.push_back ({ 0, "req_a", "Twin", {}, "", "", "" });
    plan.steps.push_back ({ 1, "req_b", "Other", {}, "", "", "" });
    plan.steps.push_back ({ 2, "req_c", "Twin", {}, "", "", "" });

    auto resolved =
    vayu::core::resolve_next_step (vayu::core::build_step_name_index (plan), "Twin");
    EXPECT_FALSE (resolved.ok);
    EXPECT_NE (resolved.error.find ("ambiguous"), std::string::npos) << resolved.error;
    EXPECT_NE (resolved.error.find ("0 and 2"), std::string::npos) << resolved.error;
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
    inputs.passed               = 8;
    inputs.failed               = 2;
    inputs.skipped              = 0;
    inputs.errored              = 1;
    inputs.steps_stored         = 5;
    inputs.steps_dropped        = 6;
    inputs.duration_s           = 2.0;

    auto summary = vayu::core::build_scenario_summary_payload (inputs);
    EXPECT_EQ (summary["total_requests"].get<size_t> (), 11u);
    EXPECT_DOUBLE_EQ (summary["test_duration"].get<double> (), 2.0);
    EXPECT_DOUBLE_EQ (summary["rps"].get<double> (), 5.5);

    const auto& scenario = summary["scenario"];
    EXPECT_EQ (scenario["iterations"].get<size_t> (), 4u);
    EXPECT_EQ (scenario["iterations_completed"].get<size_t> (), 3u);
    EXPECT_EQ (scenario["steps_executed"].get<size_t> (), 11u);
    EXPECT_EQ (scenario["passed"].get<size_t> (), 8u);
    EXPECT_EQ (scenario["failed"].get<size_t> (), 2u);
    EXPECT_EQ (scenario["skipped"].get<size_t> (), 0u);
    EXPECT_EQ (scenario["errored"].get<size_t> (), 1u);
    EXPECT_EQ (scenario["steps_stored"].get<size_t> (), 5u);
    EXPECT_EQ (scenario["steps_dropped"].get<size_t> (), 6u);
}

TEST (ScenarioSummaryPayload, AZeroLengthRunReportsNoRateRatherThanDividingByZero) {
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 3;
    auto summary          = vayu::core::build_scenario_summary_payload (inputs);
    EXPECT_DOUBLE_EQ (summary["rps"].get<double> (), 0.0);
}

} // namespace
