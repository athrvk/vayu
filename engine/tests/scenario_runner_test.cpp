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
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;
using vayu::core::ScenarioStepStore;
using vayu::core::StepOutcome;

namespace {

/// One request the mock server saw, in the order it saw them.
struct SeenRequest {
    std::string path;
    /// Path *and* query string, which is where a `{{data.column}}` in a URL
    /// lands - `path` alone drops it.
    std::string target;
    std::string cookie;
    std::string marker; // the X-Marker header, which the tests' scripts set
    std::string body;   // the request body as received; "" for a GET
    /// The `Authorization` as received; "" when absent. Credentials bound from
    /// a data row are only correct once encoded, and the encoding is what used
    /// to hide the bug (issue #591), so they are asserted off the wire.
    std::string authorization;
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
            seen.push_back ({ req.path, req.target,
            req.get_header_value ("Cookie"), req.get_header_value ("X-Marker"),
            req.body, req.get_header_value ("Authorization") });
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
        // The body a step actually sent, which is where a `{{data.*}}` bound
        // into a JSON body has to be read (issue #593) - the plan's copy would
        // not show a downstream re-encoding.
        svr.Post ("/body", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/slow", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            std::this_thread::sleep_for (std::chrono::milliseconds (120));
            res.set_content ("{}", "application/json");
        });
        // A body that satisfies the pet schema the schema-verdict tests declare,
        // and one that does not - the `id` is a string where the contract says
        // integer, which is the ordinary shape of a contract drift.
        svr.Get ("/pet", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content (R"({"id":7,"name":"Rex"})", "application/json");
        });
        svr.Get ("/pet-wrong", [record] (const httplib::Request& req, httplib::Response& res) {
            record (req);
            res.set_content (R"({"id":"seven","name":"Rex"})", "application/json");
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
        vayu::tests::remove_database_files (DB_PATH);
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
    const std::string& name         = "",
    const std::string& headers      = "",
    const std::string& body         = "",
    const std::string& auth         = "") {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = "col_1";
        r.auth          = auth;
        r.name          = name.empty () ? "Step " + id : name;
        // A body is what a POST is for, so the two travel together rather than
        // leaving a caller to remember the method.
        r.method = body.empty () ? vayu::HttpMethod::GET : vayu::HttpMethod::POST;
        r.url     = absolute_url.empty () ? server_->url (path) : absolute_url;
        r.headers = headers;
        r.body    = body;
        r.pre_request_script  = pre_script;
        r.post_request_script = post_script;
        r.order               = order;
        r.created_at          = 1;
        r.updated_at          = 1;
        db_->save_request (r);
    }

    /// Stamp a request's `spec_operation`, which is what says *which* operation
    /// of the bound document a step is - the identity both coverage and schema
    /// validation resolve by.
    void stamp_spec_operation (const std::string& request_id, const json& identity) {
        auto row = db_->get_request (request_id);
        ASSERT_TRUE (row.has_value ()) << request_id;
        row->spec_operation = identity.dump ();
        db_->save_request (*row);
    }

    /// Store a document carrying @p response_schemas and bind `col_1` to it, as
    /// an import or a sync would leave the two rows.
    void bind_spec (const json& response_schemas, const std::string& hash = "hash-1") {
        vayu::db::SpecDocument spec;
        spec.id               = "spec_1";
        spec.content          = "openapi: 3.0.0";
        spec.hash             = hash;
        spec.fetched_at       = 1;
        spec.response_schemas = response_schemas.dump ();
        db_->save_spec_document (spec);

        auto col = db_->get_collection ("col_1");
        ASSERT_TRUE (col.has_value ());
        col->openapi =
        json{ { "specId", "spec_1" }, { "specHash", hash }, { "syncedAt", 1 } }.dump ();
        db_->create_collection (*col); // a replace, keyed on the id
    }

    /// Resolve, create the run row and start the worker, exactly as POST /runs
    /// does - minus the HTTP layer.
    std::string start (size_t iterations, const std::string& environment_id = "") {
        return start_scenario (iterations, environment_id, json ());
    }

    /// As `start`, with the contract made a gate for the run.
    std::string start_gated (size_t iterations) {
        return start_scenario (iterations, "", json (), /*fail_on_schema_error=*/true);
    }

    /// As `start`, with a `data` block. Pass no @p iterations to leave the key
    /// off the payload entirely, which is how "the row count is the default"
    /// is exercised rather than assumed.
    std::string start_with_data (const json& data,
    std::optional<size_t> iterations  = std::nullopt,
    const std::string& environment_id = "") {
        return start_scenario (iterations, environment_id, data);
    }

    std::string start_scenario (std::optional<size_t> iterations,
    const std::string& environment_id,
    const json& data,
    bool fail_on_schema_error = false) {
        json scenario{ { "source", "collection" }, { "collectionId", "col_1" } };
        if (iterations) {
            scenario["iterations"] = *iterations;
        }
        if (!data.is_null ()) {
            scenario["data"] = data;
        }

        vayu::core::ScenarioResolveOptions options;
        options.timeout_ms           = 5000;
        options.environment_id       = environment_id;
        options.limits.max_steps     = 200;
        options.limits.max_data_rows = 1000;
        options.limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;

        auto resolved = vayu::core::resolve_scenario (*db_, scenario, options);
        EXPECT_TRUE (resolved.ok) << resolved.error;

        auto execution     = std::make_shared<vayu::core::ScenarioExecution> ();
        execution->request = std::move (resolved.request);
        execution->plan    = std::move (resolved.plan);
        execution->data_rows = std::move (resolved.data_rows);
        // The binding the plan resolved against, carried exactly as POST /runs
        // carries it: without this the runner would judge every run of a bound
        // collection as unbound, and every schema assertion below would pass by
        // measuring nothing.
        execution->spec = std::move (resolved.spec);

        json config{ { "scenario", scenario } };
        if (!environment_id.empty ()) {
            config["environmentId"] = environment_id;
        }
        if (fail_on_schema_error) {
            config["failOnSchemaError"] = true;
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

TEST (ScenarioSummaryPayload, AZeroLengthRunReportsNoRateRatherThanDividingByZero) {
    vayu::core::ScenarioSummaryInputs inputs;
    inputs.steps_executed = 3;
    auto summary          = vayu::core::build_scenario_summary_payload (inputs);
    EXPECT_DOUBLE_EQ (summary["rps"].get<double> (), 0.0);
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
    const auto context = manager_.get_run (run_id);
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
    const auto batch = context->ticks_since (0);
    ASSERT_EQ (batch.payloads.size (), 1u);
    const auto& payload = batch.payloads[0];
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
    ASSERT_TRUE (col.has_value ());
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
    const auto context = manager_.get_run (run_id);
    ASSERT_TRUE (context != nullptr);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    const auto batch = context->ticks_since (0);
    ASSERT_EQ (batch.payloads.size (), 2u);
    const auto frame_of = [] (const std::string& payload) {
        const auto data_at = payload.find ("data: ");
        EXPECT_NE (data_at, std::string::npos) << payload;
        return json::parse (payload.substr (data_at + 6));
    };

    // Two numbers, not the list: a step is free to make hundreds of assertions
    // and the tick ring is the fixed-size buffer every watcher replays from.
    const auto tested = frame_of (batch.payloads[0]);
    ASSERT_TRUE (tested.contains ("tests")) << batch.payloads[0];
    EXPECT_EQ (tested["tests"]["passed"].get<size_t> (), 1u);
    EXPECT_EQ (tested["tests"]["failed"].get<size_t> (), 1u);
    EXPECT_FALSE (tested["tests"].contains ("testResults")) << tested.dump ();

    // Absent here is absent there: a step that asserted nothing sends no node,
    // so a live view cannot show a `0/0` the stored row will not back up.
    EXPECT_FALSE (frame_of (batch.payloads[1]).contains ("tests")) << batch.payloads[1];
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
    const auto context = manager_.get_run (run_id);
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
    EXPECT_NE (rows[0].error.find ("token was issued"), std::string::npos) << rows[0].error;

    // And the live half counts what the stored list holds, so a run being
    // watched does not renumber itself when its rows arrive.
    const auto batch = context->ticks_since (0);
    ASSERT_EQ (batch.payloads.size (), 1u);
    const auto data_at = batch.payloads[0].find ("data: ");
    ASSERT_NE (data_at, std::string::npos) << batch.payloads[0];
    const auto frame = json::parse (batch.payloads[0].substr (data_at + 6));
    ASSERT_TRUE (frame.contains ("tests")) << batch.payloads[0];
    EXPECT_EQ (frame["tests"]["passed"].get<size_t> (), 2u);
    EXPECT_EQ (frame["tests"]["failed"].get<size_t> (), 1u);
}


// ============================================================================
// Data-driven iterations - pm.iterationData (issue #356, phase 5)
// ============================================================================
//
// The binding itself is pinned in script_engine_test.cpp; what these pin is
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

// The headline case: the row drives where the request goes, without a script.
// `pm.iterationData` cannot do this - it is read after the request was built.
TEST_F (ScenarioRunnerTest, ADataTokenInTheUrlResolvesPerIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "", "", "", server_->url ("/ok?user={{data.user}}"));

    const auto run_id = start_with_data (
    json::array ({ { { "user", "ada" } }, { { "user", "grace" } } }));
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    // Two halves, and reverting either one fails this: without the reserved
    // namespace the token is eaten at composition and both read `user=`;
    // without the runner's pass the literal `{{data.user}}` reaches the wire.
    EXPECT_EQ (seen[0].target, "/ok?user=ada");
    EXPECT_EQ (seen[1].target, "/ok?user=grace");
}

TEST_F (ScenarioRunnerTest, ADataTokenInAHeaderResolvesPerIteration) {
    seed_collection ("col_1");
    seed_request ("req_a", 0, "/ok", "", "", "", "",
    R"([{"key":"X-Marker","value":"{{data.marker}}","enabled":true}])");

    const auto run_id = start_with_data (
    json::array ({ { { "marker", "row-0" } }, { { "marker", "row-1" } } }));
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);

    auto seen = server_->requests ();
    ASSERT_EQ (seen.size (), 2u);
    EXPECT_EQ (seen[0].marker, "row-0");
    EXPECT_EQ (seen[1].marker, "row-1");
}

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

} // namespace
