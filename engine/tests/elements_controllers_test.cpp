/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/elements_controllers_test.cpp
 * @brief `control.if`, `control.once`, `control.switch`, `control.throughput`,
 *        `control.loop` and `control.transaction` (issue #1515).
 *
 * Registry-level shape first, then behaviour: the sequential run (through a
 * real DB-backed collection tree, exactly as `scenario_runner_test.cpp`
 * drives it, because `control.loop` / `control.transaction` need a real
 * folder to inherit into) and the scenario load run (through
 * `execute_scenario_load` directly, mirroring `scenario_load_test.cpp` - a
 * folder's inheritance is simulated there by giving two hand-built steps the
 * same element `id`, which is all `compute_element_spans` and
 * `TransactionHistograms` read to recognise one).
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/scenario_runner.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/event_loop.hpp"

using nlohmann::json;
using vayu::core::ElementSpan;
using vayu::core::Registry;
using vayu::tests::compiled_elements;

namespace {

json element (const std::string& id, const std::string& kind, const json& config) {
    return json{ { "id", id }, { "kind", kind }, { "enabled", true }, { "config", config } };
}

// ============================================================================
// Registry / catalogue
// ============================================================================

TEST (ControllerRegistry, AllSixKindsAreCataloguedWithTheirDeclaredPhase) {
    const json catalogue = vayu::core::elements_catalogue ();
    const std::vector<std::pair<std::string, std::string>> expected = {
        { "control.if", "step.before" },
        { "control.once", "step.before" },
        { "control.switch", "step.before" },
        { "control.throughput", "step.before" },
        { "control.loop", "step.between" },
        { "control.transaction", "step.after" },
    };
    for (const auto& [kind, phase] : expected) {
        bool found = false;
        for (const auto& entry : catalogue) {
            if (entry["kind"] == kind) {
                found = true;
                ASSERT_EQ (entry["phases"].size (), 1u) << kind;
                EXPECT_EQ (entry["phases"][0], phase) << kind;
                EXPECT_EQ (entry["hotPathClass"], "declarative")
                << kind << " must never defer to the script replay";
                break;
            }
        }
        EXPECT_TRUE (found) << kind << " missing from the catalogue";
    }
}

TEST (ControllerRegistry, ControlIfRefusesAConditionOutsideTheGrammar) {
    const auto reason = Registry::instance ().validate (json::array (
    { element ("el_1", "control.if", { { "condition", "{{tier}} is gold" } }) }));
    ASSERT_HAS_VALUE (reason);
}

TEST (ControllerRegistry, ControlIfAcceptsEveryGrammarForm) {
    for (const char* condition : { "{{tier}} == gold", "{{tier}} != gold",
         R"({{tier}} matches /^go/)", "{{tier}} exists" }) {
        const auto reason = Registry::instance ().validate (json::array (
        { element ("el_1", "control.if", { { "condition", condition } }) }));
        EXPECT_FALSE (reason.has_value ()) << condition << ": " << reason.value_or ("");
    }
}

TEST (ControllerRegistry, ControlSwitchRequiresVariableAndCases) {
    const auto reason = Registry::instance ().validate (
    json::array ({ element ("el_1", "control.switch", { { "variable", "tier" } }) }));
    ASSERT_HAS_VALUE (reason) << "'cases' is required";
}

TEST (ControllerRegistry, ControlOnceAcceptsAnEmptyConfig) {
    EXPECT_FALSE (Registry::instance ()
    .validate (json::array ({ element ("el_1", "control.once", json::object ()) }))
    .has_value ());
}

TEST (ControllerRegistry, ControlThroughputAcceptsPerUser) {
    // Issue #1569: `perUser: false` shares one budget across every virtual
    // user of a scenario load run rather than keeping one per user.
    const auto reason = Registry::instance ().validate (json::array (
    { element ("el_1", "control.throughput", { { "perUser", false } }) }));
    EXPECT_FALSE (reason.has_value ()) << reason.value_or ("");
}

TEST (ControllerRegistry, ControlTransactionAcceptsIncludeTimers) {
    // Issue #1569: folds a between-member `timer.*` wait into the sum.
    const auto reason = Registry::instance ().validate (json::array ({ element ("el_1",
    "control.transaction", { { "name", "checkout" }, { "includeTimers", true } }) }));
    EXPECT_FALSE (reason.has_value ()) << reason.value_or ("");
}

TEST (ControllerRegistry, ControlLoopRequiresCount) {
    const auto reason = Registry::instance ().validate (
    json::array ({ element ("el_1", "control.loop", json::object ()) }));
    ASSERT_HAS_VALUE (reason);
}

TEST (ControllerRegistry, ControlTransactionRequiresName) {
    const auto reason = Registry::instance ().validate (
    json::array ({ element ("el_1", "control.transaction", json::object ()) }));
    ASSERT_HAS_VALUE (reason);
}

// ============================================================================
// `find_load_incompatible_controller` - the load-path refusal, unit level
// ============================================================================

vayu::core::ScenarioStep step_with (const std::string& name, std::vector<json> elements) {
    vayu::core::ScenarioStep step;
    step.index      = 0;
    step.name       = name;
    step.request_id = "req_" + name;
    step.elements   = compiled_elements (std::move (elements));
    return step;
}

// Issue #1569: `control.loop` and `control.switch` gained their own
// load-path jump/repeat mechanism, so neither sets `jumps_or_repeats`
// any more and both run under a scenario load run instead of being
// refused - see `ElementsControllersLoadTest` below for the behaviour.
TEST (LoadIncompatibleController, SilentOnEveryController) {
    vayu::core::ScenarioPlan plan;
    plan.steps.push_back (step_with ("a",
    { element ("el_1", "control.if", { { "condition", "{{x}} exists" } }),
    element ("el_2", "control.once", json::object ()),
    element ("el_3", "control.throughput", { { "everyN", 2 } }),
    element ("el_4", "control.transaction", { { "name", "t" } }),
    element ("el_5", "control.loop", { { "count", 2 } }),
    element ("el_6", "control.switch",
    { { "variable", "v" }, { "cases", json::object () } }) }));
    EXPECT_FALSE (vayu::core::find_load_incompatible_controller (plan).has_value ());
}

// ============================================================================
// Sequential run - through a real DB-backed collection tree
// ============================================================================

class ControllerMockServer {
    public:
    ControllerMockServer () {
        svr.new_task_queue = vayu::tests::pooled_task_queue (8);
        const auto record  = [this] (const httplib::Request& req) {
            std::lock_guard<std::mutex> lock (mtx);
            hits.push_back (req.path);
        };
        for (const char* path : { "/a", "/b", "/c" }) {
            svr.Get (path, [record] (const httplib::Request& req, httplib::Response& res) {
                record (req);
                res.set_content ("{}", "application/json");
            });
        }
        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }
    ~ControllerMockServer () {
        svr.stop ();
        if (thread.joinable ()) {
            thread.join ();
        }
    }
    ControllerMockServer (const ControllerMockServer&)            = delete;
    ControllerMockServer& operator= (const ControllerMockServer&) = delete;
    ControllerMockServer (ControllerMockServer&&)                 = delete;
    ControllerMockServer& operator= (ControllerMockServer&&)      = delete;

    [[nodiscard]] std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }
    [[nodiscard]] size_t hit_count (const std::string& path) const {
        std::lock_guard<std::mutex> lock (mtx);
        return static_cast<size_t> (std::count (hits.begin (), hits.end (), path));
    }
    [[nodiscard]] std::vector<std::string> all_hits () const {
        std::lock_guard<std::mutex> lock (mtx);
        return hits;
    }

    private:
    httplib::Server svr;
    std::thread thread;
    int port = 0;
    mutable std::mutex mtx;
    std::vector<std::string> hits;
};

class ElementsControllersTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_elements_controllers.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        server_ = std::make_unique<ControllerMockServer> ();
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

    /// The root collection every test runs against, optionally carrying
    /// collection-scoped variables a `control.if` / `control.switch`
    /// condition resolves against.
    void seed_root (const std::string& variables = "") {
        vayu::db::Collection col;
        col.id         = "col_1";
        col.name       = "Root";
        col.variables  = variables;
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    /// A sub-collection ("folder") under `col_1`, carrying @p elements - the
    /// shape `control.loop` / `control.transaction` need, since both are
    /// inherited into every member request underneath.
    void seed_folder (const std::string& id, const json& elements) {
        vayu::db::Collection col;
        col.id         = id;
        col.parent_id  = "col_1";
        col.name       = "Folder " + id;
        col.elements   = elements.dump ();
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    void seed_request (const std::string& id,
    const std::string& collection_id,
    int order,
    const std::string& path,
    const json& elements = json::array ()) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = "Step " + id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = server_->url (path);
        r.elements      = elements.dump ();
        r.order         = order;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    /// Resolve (recursively, so a folder's members are walked), create the
    /// run row and start the worker, exactly as `POST /runs` does minus the
    /// HTTP layer - mirroring `scenario_runner_test.cpp`'s own helper.
    std::string start (size_t iterations) {
        json scenario{ { "source", "collection" }, { "collectionId", "col_1" },
            { "recursive", true }, { "iterations", iterations } };

        vayu::core::ScenarioResolveOptions options;
        options.timeout_ms           = 5000;
        options.limits.max_steps     = 200;
        options.limits.max_data_rows = 1000;
        options.limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;

        auto resolved = vayu::core::resolve_scenario (*db_, scenario, options);
        EXPECT_TRUE (resolved.ok) << resolved.error;

        auto execution     = std::make_shared<vayu::core::ScenarioExecution> ();
        execution->request = std::move (resolved.request);
        execution->plan    = std::move (resolved.plan);
        execution->data_rows = std::move (resolved.data_rows);
        execution->spec      = std::move (resolved.spec);

        const std::string run_id = "run_ctrl_1";
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Scenario;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = json{ { "scenario", scenario } }.dump ();
        const auto started_at = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                                .count ();
        run.start_time = started_at;
        run.end_time   = started_at;
        db_->create_run (run);

        EXPECT_TRUE (manager_.start_scenario_run (
        run_id, json{ { "scenario", scenario } }, execution, *db_, jar_));
        return run_id;
    }

    vayu::RunStatus await_terminal (const std::string& run_id) {
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (30);
        while (std::chrono::steady_clock::now () < deadline) {
            auto run = db_->get_run (run_id);
            if (run && run->status != vayu::RunStatus::Pending &&
            run->status != vayu::RunStatus::Running) {
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
        if (!run.has_value ()) {
            ADD_FAILURE () << "no run stored under " << run_id;
            return json::object ();
        }
        return json::parse (run->summary);
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::unique_ptr<ControllerMockServer> server_;
    vayu::core::RunManager manager_;
    vayu::http::CookieJar jar_;
};

TEST_F (ElementsControllersTest, ControlIfSkipsAStepWhoseConditionIsFalseAndSendsWhenTrue) {
    seed_root (json{ { "tier", { { "value", "silver" } } } }.dump ());
    seed_request ("req_a", "col_1", 0, "/a",
    json::array (
    { element ("el_if", "control.if", { { "condition", "{{tier}} == gold" } }) }));

    const std::string run_id = start (1);
    EXPECT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    EXPECT_EQ (server_->hit_count ("/a"), 0u)
    << "a false condition must never reach the wire";

    const json summary = summary_of (run_id);
    EXPECT_EQ (summary["scenario"]["skipped"], 1);

    // Visible in the step list (the issue's own acceptance criterion), not
    // only in the aggregate count.
    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    const json trace = json::parse (rows[0].trace_data);
    EXPECT_EQ (trace["outcome"], "skipped");
}

TEST_F (ElementsControllersTest, ControlOnceRunsOnlyOnTheFirstOfThreeIterations) {
    seed_root ();
    seed_request ("req_a", "col_1", 0, "/a",
    json::array ({ element ("el_once", "control.once", json::object ()) }));

    const std::string run_id = start (3);
    EXPECT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    EXPECT_EQ (server_->hit_count ("/a"), 1u);
}

TEST_F (ElementsControllersTest, ControlThroughputEveryNRunsExactlyEveryNthOccurrence) {
    seed_root ();
    seed_request ("req_a", "col_1", 0, "/a",
    json::array ({ element ("el_thr", "control.throughput", { { "everyN", 2 } }) }));

    const std::string run_id = start (4);
    EXPECT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    EXPECT_EQ (server_->hit_count ("/a"), 2u)
    << "everyN: 2 over 4 occurrences must run exactly the 2nd and 4th";
}

TEST_F (ElementsControllersTest, ControlSwitchRoutesToTheNamedMemberAndSkipsTheRest) {
    seed_root (json{ { "which", { { "value", "c" } } } }.dump ());
    seed_request ("req_a", "col_1", 0, "/a",
    json::array ({ element ("el_switch", "control.switch",
    { { "variable", "which" }, { "cases", { { "c", "Step req_c" } } } }) }));
    seed_request ("req_b", "col_1", 1, "/b");
    seed_request ("req_c", "col_1", 2, "/c");

    const std::string run_id = start (1);
    EXPECT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    EXPECT_EQ (server_->hit_count ("/a"), 1u);
    EXPECT_EQ (server_->hit_count ("/b"), 0u)
    << "the switch must jump past the un-matched member";
    EXPECT_EQ (server_->hit_count ("/c"), 1u);
}

TEST_F (ElementsControllersTest, ControlLoopWalksTheFoldersMemberCountTimesPerIteration) {
    seed_root ();
    seed_folder ("folder_1",
    json::array ({ element ("el_loop", "control.loop", { { "count", 3 } }) }));
    seed_request ("req_a", "folder_1", 0, "/a");

    const std::string run_id = start (1);
    EXPECT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    EXPECT_EQ (server_->hit_count ("/a"), 3u);
}

TEST_F (ElementsControllersTest, ControlTransactionReportsPercentilesOverTheFoldersMembers) {
    seed_root ();
    seed_folder ("folder_1",
    json::array ({ element ("el_txn", "control.transaction", { { "name", "checkout" } }) }));
    seed_request ("req_a", "folder_1", 0, "/a");
    seed_request ("req_b", "folder_1", 1, "/b");

    const std::string run_id = start (2);
    EXPECT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    EXPECT_EQ (server_->hit_count ("/a"), 2u);
    EXPECT_EQ (server_->hit_count ("/b"), 2u);

    const json summary = summary_of (run_id);
    ASSERT_TRUE (summary["scenario"].contains ("transactions")) << summary.dump ();
    const json transactions = summary["scenario"]["transactions"];
    ASSERT_TRUE (transactions.is_array ());
    bool found = false;
    for (const auto& entry : transactions) {
        if (entry["name"] == "checkout") {
            found = true;
            EXPECT_EQ (entry["count"], 2)
            << "one closed occurrence per iteration, over the folder's two "
               "members";
            EXPECT_EQ (entry["errors"], 0);
            EXPECT_GE (entry["latency"]["p50"], 0.0);
            EXPECT_GE (entry["latency"]["max"], entry["latency"]["p50"]);
        }
    }
    EXPECT_TRUE (found) << transactions.dump ();
}

// Issue #1569: `includeTimers` folds a `timer.think` wait between two
// members into the transaction's own sum - a folder identical to the test
// above except for the timer and the flag, so the only variable is whether
// the fold happened.
double checkout_p50 (const json& summary) {
    for (const auto& entry : summary["scenario"]["transactions"]) {
        if (entry["name"] == "checkout") {
            return entry["latency"]["p50"].get<double> ();
        }
    }
    ADD_FAILURE () << "no 'checkout' transaction in " << summary.dump ();
    return -1.0;
}

TEST_F (ElementsControllersTest, ControlTransactionIncludeTimersFoldsAWaitBetweenMembers) {
    seed_root ();
    seed_folder ("folder_1",
    json::array ({ element ("el_txn", "control.transaction",
    { { "name", "checkout" }, { "includeTimers", true } }) }));
    seed_request ("req_a", "folder_1", 0, "/a",
    json::array ({ element ("el_wait", "timer.think", { { "ms", 60 } }) }));
    seed_request ("req_b", "folder_1", 1, "/b");

    const std::string run_id = start (1);
    EXPECT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    EXPECT_GE (checkout_p50 (summary_of (run_id)), 60.0)
    << "the 60ms wait between the two members must be in the sum";
}

TEST_F (ElementsControllersTest, ControlTransactionExcludesTimersByDefault) {
    seed_root ();
    seed_folder ("folder_1",
    json::array ({ element ("el_txn", "control.transaction", { { "name", "checkout" } }) }));
    seed_request ("req_a", "folder_1", 0, "/a",
    json::array ({ element ("el_wait", "timer.think", { { "ms", 60 } }) }));
    seed_request ("req_b", "folder_1", 1, "/b");

    const std::string run_id = start (1);
    EXPECT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    EXPECT_LT (checkout_p50 (summary_of (run_id)), 60.0)
    << "without includeTimers the wait must not reach the sum";
}

// ============================================================================
// Scenario load run - `execute_scenario_load` directly, no DB collection tree
// ============================================================================

class ControllerLoadMockServer {
    public:
    ControllerLoadMockServer () {
        svr.new_task_queue = vayu::tests::pooled_task_queue (32);
        const auto record  = [this] (const httplib::Request& req) {
            std::lock_guard<std::mutex> lock (mtx);
            hits.push_back (req.path);
        };
        for (const char* path : { "/a", "/b", "/c" }) {
            svr.Get (path, [record] (const httplib::Request& req, httplib::Response& res) {
                record (req);
                res.set_content ("{}", "application/json");
            });
        }
        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }
    ~ControllerLoadMockServer () {
        svr.stop ();
        if (thread.joinable ()) {
            thread.join ();
        }
    }
    ControllerLoadMockServer (const ControllerLoadMockServer&) = delete;
    ControllerLoadMockServer& operator= (const ControllerLoadMockServer&) = delete;
    ControllerLoadMockServer (ControllerLoadMockServer&&)            = delete;
    ControllerLoadMockServer& operator= (ControllerLoadMockServer&&) = delete;

    [[nodiscard]] std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }
    [[nodiscard]] size_t hit_count (const std::string& path) const {
        std::lock_guard<std::mutex> lock (mtx);
        return static_cast<size_t> (std::count (hits.begin (), hits.end (), path));
    }

    private:
    httplib::Server svr;
    std::thread thread;
    int port = 0;
    mutable std::mutex mtx;
    std::vector<std::string> hits;
};

class ElementsControllersLoadTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_elements_controllers_load.db";

    void SetUp () override {
        vayu::http::global_init ();
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::http::global_cleanup ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// Two steps sharing @p elements, the same simulation
    /// `scenario_load_test.cpp`'s own fixture comment describes: two hand-built
    /// steps carrying the same element `id` is everything `compute_element_spans`
    /// needs to treat them as one folder's inherited occurrence.
    static vayu::core::ScenarioExecution plan_over (ControllerLoadMockServer& server,
    std::vector<json> elements_a,
    std::vector<json> elements_b) {
        vayu::core::ScenarioExecution execution;
        execution.request.source        = "collection";
        execution.request.collection_id = "col_test";

        vayu::core::ScenarioStep a;
        a.index              = 0;
        a.request_id         = "req_a";
        a.name               = "a";
        a.request.method     = vayu::HttpMethod::GET;
        a.request.url        = server.url ("/a");
        a.request.timeout_ms = 5000;
        a.stored_url         = a.request.url;
        a.elements           = compiled_elements (std::move (elements_a));
        execution.plan.steps.push_back (std::move (a));

        vayu::core::ScenarioStep b;
        b.index              = 1;
        b.request_id         = "req_b";
        b.name               = "b";
        b.request.method     = vayu::HttpMethod::GET;
        b.request.url        = server.url ("/b");
        b.request.timeout_ms = 5000;
        b.stored_url         = b.request.url;
        b.elements           = compiled_elements (std::move (elements_b));
        execution.plan.steps.push_back (std::move (b));

        return execution;
    }

    /// Three steps a/b/c, for `control.switch`'s own jump - proving it
    /// actually skips the un-matched member rather than only ever landing on
    /// the ordinary next step.
    static vayu::core::ScenarioExecution
    plan_over_three (ControllerLoadMockServer& server, std::vector<json> elements_a) {
        vayu::core::ScenarioExecution execution;
        execution.request.source        = "collection";
        execution.request.collection_id = "col_test";

        vayu::core::ScenarioStep a;
        a.index              = 0;
        a.request_id         = "req_a";
        a.name               = "a";
        a.request.method     = vayu::HttpMethod::GET;
        a.request.url        = server.url ("/a");
        a.request.timeout_ms = 5000;
        a.stored_url         = a.request.url;
        a.elements           = compiled_elements (std::move (elements_a));
        execution.plan.steps.push_back (std::move (a));

        vayu::core::ScenarioStep b;
        b.index              = 1;
        b.request_id         = "req_b";
        b.name               = "b";
        b.request.method     = vayu::HttpMethod::GET;
        b.request.url        = server.url ("/b");
        b.request.timeout_ms = 5000;
        b.stored_url         = b.request.url;
        execution.plan.steps.push_back (std::move (b));

        vayu::core::ScenarioStep c;
        c.index              = 2;
        c.request_id         = "req_c";
        c.name               = "c";
        c.request.method     = vayu::HttpMethod::GET;
        c.request.url        = server.url ("/c");
        c.request.timeout_ms = 5000;
        c.stored_url         = c.request.url;
        execution.plan.steps.push_back (std::move (c));

        return execution;
    }

    std::shared_ptr<vayu::core::ScenarioLoadState> run (const json& config,
    const vayu::core::ScenarioExecution& execution,
    size_t pool_size = 50) {
        auto context =
        std::make_shared<vayu::core::RunContext> ("test-ctrl-load", config);
        context->scenario =
        std::make_shared<const vayu::core::ScenarioExecution> (execution);
        vayu::http::EventLoopConfig loop_config;
        loop_config.max_concurrent = pool_size;
        loop_config.max_per_host   = pool_size;
        context->event_loop = std::make_unique<vayu::http::EventLoop> (loop_config);
        context->event_loop->start ();

        auto base_scopes = vayu::http::routes::load_script_variable_scopes (
        *db_, std::nullopt, context->scenario->request.collection_id);
        auto state = vayu::core::execute_scenario_load (
        context, *db_, *context->scenario, std::move (base_scopes));
        context->event_loop->stop (true, std::chrono::milliseconds (10000));
        return state;
    }

    /// Override a seeded config value, keeping the rest of its row intact.
    void set_config (const std::string& key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key << " is not a seeded config key";
        entry->value = value;
        db_->save_config_entry (*entry);
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (ElementsControllersLoadTest, ControlTransactionReportsPercentilesUnderLoad) {
    ControllerLoadMockServer server;
    auto execution = plan_over (server,
    { element ("el_txn", "control.transaction", { { "name", "checkout" } }) },
    { element ("el_txn", "control.transaction", { { "name", "checkout" } }) });

    const json config{ { "scenario", { { "collectionId", "col_test" } } },
        { "mode", "iterations" }, { "concurrency", 2 }, { "iterations", 4 } };
    auto state = run (config, execution);

    ASSERT_NE (state, nullptr);
    const json summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    ASSERT_TRUE (summary.contains ("transactions")) << summary.dump ();
    bool found = false;
    for (const auto& entry : summary["transactions"]) {
        if (entry["name"] == "checkout") {
            found = true;
            EXPECT_EQ (entry["count"], 4u)
            << "one closed occurrence per completed iteration";
            EXPECT_GE (entry["latency"]["p50"], 0.0);
        }
    }
    EXPECT_TRUE (found) << summary.dump ();
}

TEST_F (ElementsControllersLoadTest, ControlIfSkipsUnderLoadAndNeverReachesTheWire) {
    ControllerLoadMockServer server;
    auto execution = plan_over (server,
    { element ("el_if", "control.if", { { "condition", "{{tier}} == gold" } }) }, {});

    const json config{ { "scenario", { { "collectionId", "col_test" } } },
        { "mode", "iterations" }, { "concurrency", 2 }, { "iterations", 4 } };
    auto state = run (config, execution);

    ASSERT_NE (state, nullptr);
    EXPECT_EQ (server.hit_count ("/a"), 0u)
    << "an unresolved {{tier}} never equals 'gold', so every occurrence skips";
    EXPECT_GE (state->steps_skipped.load (), 4u);
}

// ============================================================================
// Load-path jump/repeat (issue #1569)
// ============================================================================

TEST_F (ElementsControllersLoadTest, ControlSwitchJumpsPastTheUnmatchedMemberUnderLoad) {
    ControllerLoadMockServer server;
    // `{{which}}` resolves to nothing in this fixture (no collection row
    // backs `col_test`), so it stays its own unresolved literal - matching
    // that literal in `cases` is a deterministic way to pick a branch
    // without needing a seeded variable (`ControlIfSkipsUnderLoad...` above
    // uses the same trick).
    auto execution = plan_over_three (server,
    { element ("el_switch", "control.switch",
    { { "variable", "which" }, { "cases", { { "{{which}}", "c" } } } }) });

    const json config{ { "scenario", { { "collectionId", "col_test" } } },
        { "mode", "iterations" }, { "concurrency", 2 }, { "iterations", 4 } };
    auto state = run (config, execution);

    ASSERT_NE (state, nullptr);
    EXPECT_EQ (server.hit_count ("/a"), 4u);
    EXPECT_EQ (server.hit_count ("/b"), 0u)
    << "the switch must jump past the un-matched member";
    EXPECT_EQ (server.hit_count ("/c"), 4u);
}

TEST_F (ElementsControllersLoadTest, ControlSwitchCycleIsCutOffByMaxStepsPerIteration) {
    set_config ("maxStepsPerIteration", "5");
    ControllerLoadMockServer server;
    // Routes back to itself every time - without the cycle guard this would
    // spin the one VU forever rather than complete the run.
    auto execution = plan_over (server,
    { element ("el_switch", "control.switch",
    { { "variable", "which" }, { "cases", { { "{{which}}", "a" } } } }) },
    {});

    const json config{ { "scenario", { { "collectionId", "col_test" } } },
        { "mode", "iterations" }, { "concurrency", 1 }, { "iterations", 1 } };
    auto state = run (config, execution);

    ASSERT_NE (state, nullptr);
    EXPECT_GE (state->iterations_abandoned.load (), 1u)
    << "a cycle that never reaches maxStepsPerIteration must abandon the "
       "iteration rather than spin the VU forever";
}

TEST_F (ElementsControllersLoadTest, ControlLoopRepeatsUnderLoad) {
    ControllerLoadMockServer server;
    auto execution = plan_over (
    server, { element ("el_loop", "control.loop", { { "count", 3 } }) }, {});

    const json config{ { "scenario", { { "collectionId", "col_test" } } },
        { "mode", "iterations" }, { "concurrency", 2 }, { "iterations", 4 } };
    auto state = run (config, execution);

    ASSERT_NE (state, nullptr);
    EXPECT_EQ (server.hit_count ("/a"), 12u) << "3 passes x 4 iterations";
    EXPECT_EQ (server.hit_count ("/b"), 4u)
    << "one per completed iteration, once the loop closes";
}

// ============================================================================
// control.throughput perUser: false, and control.transaction includeTimers
// (issue #1569)
// ============================================================================

TEST_F (ElementsControllersLoadTest, ControlThroughputSharesABudgetAcrossVUsWhenPerUserIsFalse) {
    ControllerLoadMockServer server;
    auto execution = plan_over (server,
    { element ("el_thr", "control.throughput", { { "everyN", 2 }, { "perUser", false } }) },
    {});

    // "iterations" is a run-wide total, claimed opportunistically by
    // whichever VU is next ready - so a *shared* budget is what makes this
    // exact: every 2nd of 20 occurrences fires, deterministically, no matter
    // how the 20 iterations split across the 4 VUs. A `perUser` (default)
    // counter could not be asserted this precisely, for the same reason.
    const json config{ { "scenario", { { "collectionId", "col_test" } } },
        { "mode", "iterations" }, { "concurrency", 4 }, { "iterations", 20 } };
    auto state = run (config, execution);

    ASSERT_NE (state, nullptr);
    EXPECT_EQ (server.hit_count ("/a"), 10u);
}

TEST_F (ElementsControllersLoadTest, ControlTransactionIncludeTimersFoldsAWaitUnderLoad) {
    ControllerLoadMockServer server;
    auto execution = plan_over (server,
    { element ("el_txn", "control.transaction",
      { { "name", "checkout" }, { "includeTimers", true } }),
    element ("el_wait", "timer.think", { { "ms", 60 } }) },
    { element ("el_txn", "control.transaction",
    { { "name", "checkout" }, { "includeTimers", true } }) });

    const json config{ { "scenario", { { "collectionId", "col_test" } } },
        { "mode", "iterations" }, { "concurrency", 2 }, { "iterations", 2 } };
    auto state = run (config, execution);

    ASSERT_NE (state, nullptr);
    const json summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    double p50 = -1.0;
    for (const auto& entry : summary["transactions"]) {
        if (entry["name"] == "checkout") {
            p50 = entry["latency"]["p50"].get<double> ();
        }
    }
    EXPECT_GE (p50, 60.0) << "the 60ms between-member wait must be in the sum";
}

TEST_F (ElementsControllersLoadTest, ControlTransactionExcludesTimersByDefaultUnderLoad) {
    ControllerLoadMockServer server;
    auto execution = plan_over (server,
    { element ("el_txn", "control.transaction", { { "name", "checkout" } }),
    element ("el_wait", "timer.think", { { "ms", 60 } }) },
    { element ("el_txn", "control.transaction", { { "name", "checkout" } }) });

    const json config{ { "scenario", { { "collectionId", "col_test" } } },
        { "mode", "iterations" }, { "concurrency", 2 }, { "iterations", 2 } };
    auto state = run (config, execution);

    ASSERT_NE (state, nullptr);
    const json summary =
    vayu::core::build_scenario_load_summary (*state, execution.plan);
    double p50 = -1.0;
    for (const auto& entry : summary["transactions"]) {
        if (entry["name"] == "checkout") {
            p50 = entry["latency"]["p50"].get<double> ();
        }
    }
    EXPECT_GE (p50, 0.0);
    EXPECT_LT (p50, 60.0)
    << "without includeTimers the wait must not reach the sum";
}

} // namespace
