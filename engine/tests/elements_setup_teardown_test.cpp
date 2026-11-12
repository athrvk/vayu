/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/elements_setup_teardown_test.cpp
 * @brief `script.setup` / `script.teardown` (issue #1499): collection-only
 *        placement, and the two new `run.start` / `run.end` dispatch sites in
 *        the sequential runner and the load path, over a run's lifecycle set
 *        (#3456): the chain above the run collection and, on a recursive
 *        run, every folder beneath it.
 *
 * The dispatch tests drive `RunManager::start_scenario_run` /
 * `RunManager::start_run` directly against a real database and an in-process
 * mock server, matching `scenario_runner_test.cpp` and `scenario_load_test.cpp`.
 * Visibility is asserted the same way for both run modes: a request's URL
 * carries an unresolved `{{lifecycleToken}}` at plan-resolve time (the
 * collection has no such variable yet), and `script.setup` sets it - so the
 * mock server's first hit shows the resolved value only if setup ran, and ran
 * before that hit was sent.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "log_capture.hpp"
#include "optional_assert.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/routes.hpp"
#include "wait_until.hpp"

using nlohmann::json;

namespace {

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

// ============================================================================
// Placement: script.setup / script.teardown are collection_only
// ============================================================================

TEST (ScriptLifecyclePlacementTest, RefusedOnARequestByTheRegistry) {
    const json elements = json::array ({ json{ { "id", "el_1" },
    { "kind", "script.setup" }, { "config", { { "script", "" } } } } });
    auto reason         = vayu::core::Registry::instance ().validate (
    elements, vayu::core::ElementOwner::Request);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("can only be added to a collection"), std::string::npos)
    << *reason;
}

// Mutation check: drop the `kind->collection_only && owner != Collection`
// branch in `Registry::validate` and this reddens (the elements[i] format
// string above becomes unreachable and `validate` returns nullopt instead).
TEST (ScriptLifecyclePlacementTest, AcceptedOnACollection) {
    const json elements = json::array ({ json{ { "id", "el_1" },
    { "kind", "script.teardown" }, { "config", { { "script", "" } } } } });
    auto reason         = vayu::core::Registry::instance ().validate (
    elements, vayu::core::ElementOwner::Collection);
    EXPECT_FALSE (reason.has_value ()) << reason.value_or ("");
}

TEST (ScriptLifecyclePlacementTest, TheCatalogueMarksBothKindsCollectionOnly) {
    const json catalogue = vayu::core::elements_catalogue ();
    size_t checked       = 0;
    for (const auto& kind : catalogue) {
        if (kind["kind"] == "script.setup" || kind["kind"] == "script.teardown") {
            EXPECT_TRUE (kind.value ("collectionOnly", false)) << kind["kind"];
            ++checked;
        }
    }
    ASSERT_EQ (checked, 2u);
}

// ============================================================================
// Validation: a single-request run's own `lifecycleElements` (issue #1573)
// ============================================================================

TEST (LifecycleElementsRunOverrideValidationTest, AbsentIsFine) {
    const json config = json::object ();
    EXPECT_FALSE (
    vayu::core::validate_lifecycle_elements_run_override (config).has_value ());
}

TEST (LifecycleElementsRunOverrideValidationTest, NullIsFine) {
    const json config{ { "lifecycleElements", nullptr } };
    EXPECT_FALSE (
    vayu::core::validate_lifecycle_elements_run_override (config).has_value ());
}

TEST (LifecycleElementsRunOverrideValidationTest, MustBeAnArray) {
    const json config{ { "lifecycleElements", json::object () } };
    auto reason = vayu::core::validate_lifecycle_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("must be an array"), std::string::npos) << *reason;
}

// Mutation check: drop the `allowed_kinds.contains (kind)` refusal loop and
// this reddens - `Registry::validate` alone accepts `assert.status` on
// `ElementOwner::Collection` fine, since it is not `collection_only`.
TEST (LifecycleElementsRunOverrideValidationTest, RefusesAnyKindOtherThanSetupOrTeardown) {
    const json config{ { "lifecycleElements",
    json::array ({ json{ { "id", "el_1" }, { "kind", "assert.status" },
    { "config", { { "expected", 200 } } } } }) } };
    auto reason = vayu::core::validate_lifecycle_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("Step 1"), std::string::npos) << *reason;
    // The refusal names the kind's label ("Assert status code",
    // `make_assert_status_kind`), not its wire kind.
    EXPECT_NE (reason->find ("Assert status code"), std::string::npos) << *reason;
}

TEST (LifecycleElementsRunOverrideValidationTest, AcceptsSetupAndTeardown) {
    const json config{ { "lifecycleElements",
    json::array ({ json{ { "id", "el_1" }, { "kind", "script.setup" },
                   { "config", { { "script", "" } } } },
    json{ { "id", "el_2" }, { "kind", "script.teardown" },
    { "config", { { "script", "" } } } } }) } };
    EXPECT_FALSE (
    vayu::core::validate_lifecycle_elements_run_override (config).has_value ());
}

// `Registry::validate` refuses an id-less entry outright - the documented
// example in api-reference.md's `lifecycleElements` section names no id, so
// this must not 400 the same way `apply_elements_field` (routes.hpp) does
// not for a stored request/collection's `elements`. Mutation check: drop the
// `stamp_default_element_ids` call in `validate_lifecycle_elements_run_override`
// and this reddens on `Registry::validate`'s own "Item 1 is missing an id"
// refusal.
TEST (LifecycleElementsRunOverrideValidationTest, AcceptsAnEntryWithNoId) {
    const json config{ { "lifecycleElements",
    json::array ({ json{ { "kind", "script.setup" }, { "config", { { "script", "" } } } } }) } };
    EXPECT_FALSE (
    vayu::core::validate_lifecycle_elements_run_override (config).has_value ());
}

// The wire-shape rule the issue itself settles: a scenario collection already
// has a real `elements` column for this, so the two must not both claim the
// run's own setup/teardown.
TEST (LifecycleElementsRunOverrideValidationTest, RefusedBesideAScenarioBlock) {
    const json config{ { "scenario",
                       json{ { "source", "collection" }, { "collectionId", "col_1" } } },
        { "lifecycleElements",
        json::array ({ json{ { "id", "el_1" }, { "kind", "script.setup" },
        { "config", { { "script", "" } } } } }) } };
    auto reason = vayu::core::validate_lifecycle_elements_run_override (config);
    ASSERT_HAS_VALUE (reason);
    EXPECT_NE (reason->find ("single-request run"), std::string::npos) << *reason;
}

// ============================================================================
// Dispatch: run.start / run.end in both run modes
// ============================================================================

/// One request the mock server saw. `target` is path-and-query, which is
/// where the resolved `{{lifecycleToken}}` lands.
struct SeenRequest {
    std::string target;
};

class LifecycleMockServer {
    public:
    LifecycleMockServer () {
        svr.new_task_queue = vayu::tests::pooled_task_queue (8);
        svr.Get ("/ok", [this] (const httplib::Request& req, httplib::Response& res) {
            std::lock_guard<std::mutex> lock (mtx);
            seen.push_back ({ req.target });
            res.set_content ("{}", "application/json");
        });
        // What a `script.setup` fetches with `pm.sendRequest` before setting
        // the variable every submission then sees on the wire.
        svr.Get ("/token", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (R"({"token":"fetched-by-setup"})", "application/json");
        });
        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }
    ~LifecycleMockServer () {
        svr.stop ();
        if (thread.joinable ()) {
            thread.join ();
        }
    }
    LifecycleMockServer (const LifecycleMockServer&)            = delete;
    LifecycleMockServer& operator= (const LifecycleMockServer&) = delete;
    LifecycleMockServer (LifecycleMockServer&&)                 = delete;
    LifecycleMockServer& operator= (LifecycleMockServer&&)      = delete;

    [[nodiscard]] std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }
    [[nodiscard]] std::vector<SeenRequest> requests () const {
        std::lock_guard<std::mutex> lock (mtx);
        return seen;
    }

    private:
    httplib::Server svr;
    std::thread thread;
    int port = 0;
    mutable std::mutex mtx;
    std::vector<SeenRequest> seen;
};

constexpr const char* DB_PATH = "test_elements_setup_teardown.db";

class ScriptLifecycleTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        cleanup ();
        db_     = std::make_unique<vayu::db::Database> (DB_PATH);
        server_ = std::make_unique<LifecycleMockServer> ();
        db_->init ();
    }
    void TearDown () override {
        manager_.shutdown ();
        server_.reset ();
        db_.reset ();
        vayu::http::global_cleanup ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// `col_1`, carrying @p elements as its own `script.setup` / `.teardown`.
    void seed_collection (const json& elements) {
        seed_folder ("col_1", std::nullopt, 0, elements);
    }

    /// Collection @p id named `Collection <id>` under @p parent_id (a root
    /// when absent) at sibling position @p order, carrying @p elements.
    void seed_folder (const std::string& id,
    const std::optional<std::string>& parent_id,
    int order,
    const json& elements) {
        vayu::db::Collection col;
        col.id         = id;
        col.parent_id  = parent_id;
        col.name       = "Collection " + id;
        col.elements   = elements.dump ();
        col.order      = order;
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    /// Request @p id in @p collection_id at sibling position @p order, sent to
    /// `/ok` with @p query.
    void seed_request_in (const std::string& id,
    const std::string& collection_id,
    int order,
    const std::string& query) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = "Request " + id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = server_->url ("/ok") + "?" + query;
        r.order         = order;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    /// One request in `col_1`, its URL carrying an unresolved
    /// `{{lifecycleToken}}` query token - unresolvable at plan-resolve time
    /// (the collection declares no such variable), so it survives compose and
    /// is filled in only by the residual pass at send time, off whatever
    /// `script.setup` wrote into the run's own scopes.
    void seed_request () {
        vayu::db::Request r;
        r.id            = "req_1";
        r.collection_id = "col_1";
        r.name          = "Step 1";
        r.method        = vayu::HttpMethod::GET;
        r.url           = server_->url ("/ok") + "?tok={{lifecycleToken}}";
        r.order         = 0;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    vayu::core::ScenarioExecution resolve (size_t iterations,
    const std::string& collection_id = "col_1",
    bool recursive                   = false) {
        json scenario{ { "source", "collection" }, { "collectionId", collection_id },
            { "iterations", iterations }, { "recursive", recursive } };
        vayu::core::ScenarioResolveOptions options;
        options.timeout_ms           = 5000;
        options.limits.max_steps     = 200;
        options.limits.max_data_rows = 1000;
        options.limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;

        auto resolved = vayu::core::resolve_scenario (*db_, scenario, options);
        EXPECT_TRUE (resolved.ok) << resolved.error;

        vayu::core::ScenarioExecution execution;
        execution.request   = std::move (resolved.request);
        execution.plan      = std::move (resolved.plan);
        execution.data_rows = std::move (resolved.data_rows);
        execution.spec      = std::move (resolved.spec);
        return execution;
    }

    /// Runs @p execution's plan sequentially and waits for a terminal status.
    vayu::RunStatus run_sequential (const vayu::core::ScenarioExecution& execution,
    bool allow_script_requests = false) {
        const json scenario{ { "source", "collection" },
            { "collectionId", execution.request.collection_id }, { "iterations", 1 } };
        const json config{ { "scenario", scenario },
            { "allowScriptRequests", allow_script_requests } };

        const std::string run_id = "run_seq";
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Scenario;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = config.dump ();
        // A real wall-clock stamp, not the struct's default 0: reaching a
        // terminal status prunes the run history by the retention knobs, and a
        // run dated 1970 is pruned - with its row - the moment it finishes.
        run.start_time = now_ms ();
        run.end_time   = run.start_time;
        db_->create_run (run);

        auto execution_ptr =
        std::make_shared<const vayu::core::ScenarioExecution> (execution);
        EXPECT_TRUE (
        manager_.start_scenario_run (run_id, config, execution_ptr, *db_, jar_));
        return await_terminal (run_id);
    }

    /// Runs @p execution's plan as a scenario load run (through the same
    /// `execute_load_test` / `finish_load_test` production uses) and waits
    /// for a terminal status.
    vayu::RunStatus run_load (const vayu::core::ScenarioExecution& execution,
    size_t iterations,
    size_t concurrency,
    bool allow_script_requests = false) {
        const json scenario{ { "source", "collection" },
            { "collectionId", execution.request.collection_id } };
        const json config{ { "scenario", scenario }, { "mode", "iterations" },
            { "iterations", iterations }, { "concurrency", concurrency },
            { "allowScriptRequests", allow_script_requests } };

        const std::string run_id = "run_load";
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = config.dump ();
        // See `run_sequential`'s comment: an epoch-dated run is pruned the
        // moment it finishes.
        run.start_time = now_ms ();
        run.end_time   = run.start_time;
        db_->create_run (run);

        auto execution_ptr =
        std::make_shared<const vayu::core::ScenarioExecution> (execution);
        EXPECT_TRUE (manager_.start_run (run_id, config, *db_, execution_ptr));
        return await_terminal (run_id);
    }

    /// Runs a **single-request** load run - no `scenario`, no collection -
    /// against `/ok`, with @p lifecycle_elements as its own `lifecycleElements`
    /// override (issue #1573), and waits for a terminal status.
    vayu::RunStatus run_single_request_load (const json& lifecycle_elements,
    size_t iterations,
    size_t concurrency,
    bool allow_script_requests = false) {
        json config{ { "method", "GET" }, { "url", server_->url ("/ok") },
            { "mode", "iterations" }, { "iterations", iterations },
            { "concurrency", concurrency },
            { "allowScriptRequests", allow_script_requests } };
        if (!lifecycle_elements.empty ()) {
            config["lifecycleElements"] = lifecycle_elements;
        }

        const std::string run_id = "run_single";
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = config.dump ();
        run.start_time      = now_ms ();
        run.end_time        = run.start_time;
        db_->create_run (run);

        EXPECT_TRUE (manager_.start_run (run_id, config, *db_));
        return await_terminal (run_id);
    }

    vayu::RunStatus await_terminal (const std::string& run_id) {
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (20);
        while (std::chrono::steady_clock::now () < deadline) {
            auto run = db_->get_run (run_id);
            if (run && run->status != vayu::RunStatus::Pending &&
            run->status != vayu::RunStatus::Running) {
                // The worker writes the status before its last acts (closed,
                // then retain_run, which takes it out of the active map); wait
                // for those rather than a fixed moment, so an assertion on
                // them cannot race it.
                (void)vayu::tests::wait_until (
                [&] () { return manager_.get_run (run_id) == nullptr; },
                std::chrono::seconds (5));
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
            ADD_FAILURE () << "no run is stored under " << run_id;
            return json::object ();
        }
        return json::parse (run->summary);
    }

    /// The `lifecycle` node `GET /runs/:id/report` answers for @p run_id.
    [[nodiscard]] json report_lifecycle_of (const std::string& run_id) {
        const auto [status, report] =
        vayu::http::routes::run_report_response (*db_, run_id);
        if (status != 200 || !report.contains ("lifecycle")) {
            ADD_FAILURE () << "no lifecycle in the report: " << report.dump ();
            return json::object ();
        }
        return report["lifecycle"];
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::unique_ptr<LifecycleMockServer> server_;
    vayu::core::RunManager manager_;
    vayu::http::CookieJar jar_;
};

json script_setup_element (const std::string& script) {
    return json::array ({ json{ { "id", "el_setup" }, { "kind", "script.setup" },
    { "enabled", true }, { "config", { { "script", script } } } } });
}

json setup_and_teardown_elements (const std::string& setup, const std::string& teardown) {
    return json::array ({ json{ { "id", "el_setup" }, { "kind", "script.setup" },
                          { "enabled", true }, { "config", { { "script", setup } } } },
    json{ { "id", "el_teardown" }, { "kind", "script.teardown" },
    { "enabled", true }, { "config", { { "script", teardown } } } } });
}

/// A setup whose only problem is a failing `pm.test`.
constexpr const char* FAILING_TEST_SETUP =
"pm.test('t', () => { throw new Error('nope'); });";
constexpr const char* FAILING_TEST_MESSAGE = "Test failed - t: Error: nope";

/// That a run's @p lifecycle names the one setup that refused it, with
/// @p outcome and a message holding @p text, and no teardown, since none ran.
void expect_refusing_setup (const json& lifecycle,
const std::string& outcome,
const std::string& text) {
    EXPECT_FALSE (lifecycle.contains ("teardown")) << lifecycle.dump ();
    const auto setup = lifecycle.value ("setup", json::array ());
    ASSERT_EQ (setup.size (), 1u) << lifecycle.dump ();
    EXPECT_EQ (setup[0].value ("outcome", ""), outcome);
    EXPECT_NE (setup[0].value ("message", "").find (text), std::string::npos)
    << setup[0].dump ();
}

/// A teardown that logs a line and fails only a `pm.test`.
constexpr const char* LOGGING_FAILING_TEST_TEARDOWN =
"console.log('x'); pm.test('t', () => { throw new Error('nope'); });";

/// That a run's @p lifecycle holds the one teardown of
/// `LOGGING_FAILING_TEST_TEARDOWN` as `failed`, with its test and its console
/// line kept beside the message (#3455).
void expect_teardown_keeps_its_output (const json& lifecycle) {
    const auto teardown = lifecycle.value ("teardown", json::array ());
    ASSERT_EQ (teardown.size (), 1u) << lifecycle.dump ();
    EXPECT_EQ (teardown[0].value ("outcome", ""), "failed");
    EXPECT_EQ (teardown[0].value ("message", ""), FAILING_TEST_MESSAGE);
    EXPECT_EQ (teardown[0].value ("messages", json ()),
    json::array ({ { { "kind", "test" }, { "text", "t: Error: nope" } } }))
    << teardown[0].dump ();
    EXPECT_EQ (teardown[0].value ("console", json ()),
    json::array ({ { { "level", "log" }, { "text", "x" } } }))
    << teardown[0].dump ();
}

// Mutation check: remove the `run.start` dispatch call in
// `execute_scenario_run` (scenario_runner.cpp) and this reddens - step 1's
// request keeps its literal `{{lifecycleToken}}` because nothing ever wrote
// the variable the residual pass is looking for.
TEST_F (ScriptLifecycleTest, SequentialSetupWritesAVariableTheFirstStepSees) {
    seed_collection (script_setup_element (
    "pm.environment.set('lifecycleToken', 'set-by-setup');"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_sequential (execution), vayu::RunStatus::Completed);

    auto hits = server_->requests ();
    ASSERT_EQ (hits.size (), 1u);
    EXPECT_NE (hits[0].target.find ("tok=set-by-setup"), std::string::npos)
    << hits[0].target;
}

// The issue's own acceptance scenario, literally: a script.setup that fetches
// a token with pm.sendRequest and sets it makes that token available to the
// run's first submission. Mutation check: bind `run_setup_script` to a
// ScriptContext with no `allow_send_request` wired through the run's own
// ScriptConfig and this reddens - pm.sendRequest throws "not available here".
TEST_F (ScriptLifecycleTest, SequentialSetupFetchesATokenWithSendRequestAndSetsIt) {
    seed_collection (script_setup_element ("pm.sendRequest('" + server_->url ("/token") +
    "', function (err, res) {"
    "  pm.environment.set('lifecycleToken', res.json().token);"
    "});"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_sequential (execution, /*allow_script_requests=*/true),
    vayu::RunStatus::Completed);

    auto hits = server_->requests ();
    ASSERT_EQ (hits.size (), 1u);
    EXPECT_NE (hits[0].target.find ("tok=fetched-by-setup"), std::string::npos)
    << hits[0].target;
}

// Mutation check: change the throw-on-error loop in `execute_scenario_run` to
// merely log the outcome and this reddens to Completed with one request sent.
// Drop the `catch`'s `summary.lifecycle` assignment (#3455) and the report
// has no lifecycle to say why.
TEST_F (ScriptLifecycleTest, SequentialThrowingSetupFailsTheRunBeforeAnyStepIsSent) {
    seed_collection (script_setup_element ("throw new Error('boom');"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_sequential (execution), vayu::RunStatus::Failed);
    EXPECT_TRUE (server_->requests ().empty ());
    expect_refusing_setup (report_lifecycle_of ("run_seq"), "error", "boom");
}

TEST_F (ScriptLifecycleTest, SequentialSetupWithAFailingTestFailsTheRunAndSaysWhich) {
    seed_collection (script_setup_element (FAILING_TEST_SETUP));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_sequential (execution), vayu::RunStatus::Failed);
    EXPECT_TRUE (server_->requests ().empty ());
    expect_refusing_setup (report_lifecycle_of ("run_seq"), "failed", FAILING_TEST_MESSAGE);
}

// Issue #2359: the text the failing setup script threw is script-authored, so
// it is a bounded field of the record and never part of its message.
// Mutation check: put `e.what ()` back into the message in
// `execute_scenario_run`'s catch (scenario_runner.cpp) and this reddens.
TEST_F (ScriptLifecycleTest, SequentialSetupFailureLogsTheThrownTextAsABoundedField) {
    const vayu::tests::LogCapture log;
    seed_collection (script_setup_element (
    vayu::tests::script_throwing (vayu::tests::thrown_text (0))));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_sequential (execution), vayu::RunStatus::Failed);

    const auto records = log.with_msg_prefix ("Scenario run error");
    ASSERT_EQ (records.size (), 1u);
    EXPECT_EQ (records[0].at ("msg").get<std::string> (), "Scenario run error");
    EXPECT_EQ (records[0].at ("runId").get<std::string> (), "run_seq");
    vayu::tests::expect_script_text_only_bounded_in (records[0], "error");
}

// Mutation check: drop the `run.end` dispatch call in `execute_scenario_run`
// and `summary["lifecycle"]` disappears from the stored summary entirely.
TEST_F (ScriptLifecycleTest, SequentialThrowingTeardownIsRecordedWithoutChangingStatus) {
    seed_collection (setup_and_teardown_elements (
    "pm.environment.set('lifecycleToken', 'set-by-setup');", "throw new Error('teardown boom');"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_sequential (execution), vayu::RunStatus::Completed);

    auto summary = summary_of ("run_seq");
    ASSERT_TRUE (summary.contains ("lifecycle"));
    ASSERT_TRUE (summary["lifecycle"].contains ("teardown"));
    const auto& teardown = summary["lifecycle"]["teardown"];
    ASSERT_EQ (teardown.size (), 1u);
    EXPECT_EQ (teardown[0]["outcome"], "error");
    EXPECT_NE (
    teardown[0]["message"].get<std::string> ().find ("teardown boom"), std::string::npos);
}

// #3455: a teardown that logs and fails only a `pm.test` is `failed` with that
// test as its message (it was `error` with none), and its stored row keeps the
// test and the console line. Mutation check: restore `result.success ? "ok" :
// "error"` in `run_lifecycle_script` (script_kinds.cpp) and the outcome and
// message expectations fail; drop `lifecycle_row`'s `write_message_sample`
// calls (pipeline.cpp) and the two lists are absent.
TEST_F (ScriptLifecycleTest, SequentialTeardownKeepsItsConsoleAndFailingTest) {
    seed_collection (setup_and_teardown_elements (
    "pm.environment.set('lifecycleToken', 'set-by-setup');",
    "console.log('x'); pm.test('t', () => { throw new Error('nope'); });"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_sequential (execution), vayu::RunStatus::Completed);

    const auto summary = summary_of ("run_seq");
    ASSERT_TRUE (summary.contains ("lifecycle")) << summary.dump ();
    const auto& teardown = summary["lifecycle"]["teardown"];
    ASSERT_EQ (teardown.size (), 1u);
    EXPECT_EQ (teardown[0].value ("outcome", ""), "failed");
    EXPECT_EQ (teardown[0].value ("message", ""), "Test failed - t: Error: nope");
    EXPECT_EQ (teardown[0].value ("messages", json ()),
    json::array ({ { { "kind", "test" }, { "text", "t: Error: nope" } } }))
    << teardown[0].dump ();
    EXPECT_EQ (teardown[0].value ("console", json ()),
    json::array ({ { { "level", "log" }, { "text", "x" } } }))
    << teardown[0].dump ();
}

// Mutation check: skip the `script.setup` dispatch `execute_load_test` runs
// before `test_start` (run_manager.cpp) and this reddens - every VU's first
// submission keeps the literal `{{lifecycleToken}}`.
TEST_F (ScriptLifecycleTest, LoadSetupWritesAVariableEveryVirtualUserSees) {
    seed_collection (script_setup_element (
    "pm.environment.set('lifecycleToken', 'set-by-setup');"));
    seed_request ();
    auto execution = resolve (1);

    // `iterations` is a total across every VU, not a per-VU count - matching
    // it to `concurrency` is what gets all three VUs their own submission.
    EXPECT_EQ (run_load (execution, /*iterations=*/3, /*concurrency=*/3),
    vayu::RunStatus::Completed);

    auto hits = server_->requests ();
    ASSERT_EQ (hits.size (), 3u);
    for (const auto& hit : hits) {
        EXPECT_NE (hit.target.find ("tok=set-by-setup"), std::string::npos)
        << hit.target;
    }
}

// The local scope `pm.variables.set` writes (#2564) belongs to whoever owns
// the scopes. A collection run owns one for the whole run, so setup's local
// reaches the first step.
TEST_F (ScriptLifecycleTest, SequentialSetupLocalReachesTheFirstStep) {
    seed_collection (script_setup_element (
    "pm.variables.set('lifecycleToken', 'local-by-setup');"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_sequential (execution), vayu::RunStatus::Completed);

    auto hits = server_->requests ();
    ASSERT_EQ (hits.size (), 1u);
    EXPECT_NE (hits[0].target.find ("tok=local-by-setup"), std::string::npos)
    << hits[0].target;
}

// Under load each virtual user owns its own local scope, starting empty, and
// setup is no user's iteration, so its local ends with it and every
// submission keeps the literal token. Mutation check: drop
// `run_scopes.clear_local ()` from `run_scenario_load_setup` (run_manager.cpp)
// and every hit carries the value.
TEST_F (ScriptLifecycleTest, LoadSetupLocalReachesNoVirtualUser) {
    seed_collection (script_setup_element (
    "pm.variables.set('lifecycleToken', 'local-by-setup');"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_load (execution, /*iterations=*/3, /*concurrency=*/3),
    vayu::RunStatus::Completed);

    auto hits = server_->requests ();
    ASSERT_EQ (hits.size (), 3u);
    for (const auto& hit : hits) {
        EXPECT_EQ (hit.target.find ("local-by-setup"), std::string::npos) << hit.target;
        EXPECT_NE (hit.target.find ("lifecycleToken"), std::string::npos) << hit.target;
    }
}

// The load-mode half of the issue's own acceptance scenario: a script.setup
// that fetches a token with pm.sendRequest makes it available to every
// virtual user's first submission. Mutation check: skip binding
// `setup_config.allow_send_request` from the run's own `allowScriptRequests`
// in `execute_load_test` and this reddens - pm.sendRequest throws.
TEST_F (ScriptLifecycleTest, LoadSetupFetchesATokenWithSendRequestAndEveryVUSeesIt) {
    seed_collection (script_setup_element ("pm.sendRequest('" + server_->url ("/token") +
    "', function (err, res) {"
    "  pm.environment.set('lifecycleToken', res.json().token);"
    "});"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_load (execution, /*iterations=*/3, /*concurrency=*/3,
               /*allow_script_requests=*/true),
    vayu::RunStatus::Completed);

    auto hits = server_->requests ();
    ASSERT_EQ (hits.size (), 3u);
    for (const auto& hit : hits) {
        EXPECT_NE (hit.target.find ("tok=fetched-by-setup"), std::string::npos)
        << hit.target;
    }
}

// Mutation check: let a throwing `script.setup` outcome pass unnoticed in
// `execute_load_test` (drop the `for (const auto& outcome : ...)` refusal
// loop) and this reddens to Completed with three requests sent. Drop the
// `lifecycle` assignment in `failed_run_summary_inputs` (#3455) and the
// report has no lifecycle to say why.
TEST_F (ScriptLifecycleTest, LoadThrowingSetupFailsTheRunWithNoSubmissions) {
    seed_collection (script_setup_element ("throw new Error('boom');"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_load (execution, /*iterations=*/1, /*concurrency=*/3),
    vayu::RunStatus::Failed);
    EXPECT_TRUE (server_->requests ().empty ());
    expect_refusing_setup (report_lifecycle_of ("run_load"), "error", "boom");
}

// The load-mode half of SequentialSetupWithAFailingTestFailsTheRunAndSaysWhich.
TEST_F (ScriptLifecycleTest, LoadSetupWithAFailingTestFailsTheRunAndSaysWhich) {
    seed_collection (script_setup_element (FAILING_TEST_SETUP));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_load (execution, /*iterations=*/1, /*concurrency=*/3),
    vayu::RunStatus::Failed);
    EXPECT_TRUE (server_->requests ().empty ());
    expect_refusing_setup (report_lifecycle_of ("run_load"), "failed", FAILING_TEST_MESSAGE);
}

// The load-mode half of SequentialSetupFailureLogsTheThrownTextAsABoundedField.
// Mutation check: put `*setup_failure` back into the message in `run_worker`'s
// setup refusal (run_manager.cpp) and this reddens.
TEST_F (ScriptLifecycleTest, LoadSetupFailureLogsTheThrownTextAsABoundedField) {
    const vayu::tests::LogCapture log;
    seed_collection (script_setup_element (
    vayu::tests::script_throwing (vayu::tests::thrown_text (0))));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_load (execution, /*iterations=*/1, /*concurrency=*/3),
    vayu::RunStatus::Failed);

    const auto records = log.with_msg_prefix ("script.setup failed");
    ASSERT_EQ (records.size (), 1u);
    EXPECT_EQ (records[0].at ("msg").get<std::string> (), "script.setup failed");
    EXPECT_EQ (records[0].at ("runId").get<std::string> (), "run_load");
    vayu::tests::expect_script_text_only_bounded_in (records[0], "scriptError");
}

// The load-mode half of SequentialThrowingTeardownIsRecordedWithoutChangingStatus.
// Mutation check: drop the `run_collection_teardown` call in `finish_load_test`
// and `summary["lifecycle"]` disappears from the stored summary entirely.
TEST_F (ScriptLifecycleTest, LoadThrowingTeardownIsRecordedWithoutChangingStatus) {
    seed_collection (setup_and_teardown_elements (
    "pm.environment.set('lifecycleToken', 'set-by-setup');", "throw new Error('teardown boom');"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_load (execution, /*iterations=*/2, /*concurrency=*/2),
    vayu::RunStatus::Completed);

    auto summary = summary_of ("run_load");
    ASSERT_TRUE (summary.contains ("lifecycle"));
    ASSERT_TRUE (summary["lifecycle"].contains ("teardown"));
    const auto& teardown = summary["lifecycle"]["teardown"];
    ASSERT_EQ (teardown.size (), 1u);
    EXPECT_EQ (teardown[0]["outcome"], "error");
    EXPECT_NE (
    teardown[0]["message"].get<std::string> ().find ("teardown boom"), std::string::npos);
}

// The load-mode half of SequentialTeardownKeepsItsConsoleAndFailingTest, read
// as the report answers it. Mutation check: drop the `outcome_messages`
// assignment in `record_script_outcome` (script_kinds.cpp) and the message
// and console lists are absent.
TEST_F (ScriptLifecycleTest, LoadTeardownKeepsItsConsoleAndFailingTest) {
    seed_collection (setup_and_teardown_elements ("", LOGGING_FAILING_TEST_TEARDOWN));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_load (execution, /*iterations=*/2, /*concurrency=*/2),
    vayu::RunStatus::Completed);
    expect_teardown_keeps_its_output (report_lifecycle_of ("run_load"));
}

// The issue's own Tests requirement, literally: "teardown runs after the last
// completion and sees the sent count." Teardown pings the mock server itself
// with `pm.info.run.requestsSent`, which is the only way to observe a value
// nothing downstream of teardown ever reads. Mutation check: pass a stale or
// zeroed `RunSummaryInfo` into `run_collection_teardown` (e.g. never assign
// `run_summary_info.requests_sent` in `finish_load_test`) and the pinged count
// reddens to 0 instead of the concurrency actually sent.
TEST_F (ScriptLifecycleTest, LoadTeardownSeesTheActualSentCount) {
    seed_collection (setup_and_teardown_elements ("",
    "pm.sendRequest('" + server_->url ("/ok") +
    "?teardownSawSent=' + pm.info.run.requestsSent, function () {});"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_load (execution, /*iterations=*/3, /*concurrency=*/3,
               /*allow_script_requests=*/true),
    vayu::RunStatus::Completed);

    auto hits = server_->requests ();
    // Three ordinary submissions plus teardown's own ping.
    ASSERT_EQ (hits.size (), 4u);
    const auto teardown_hit =
    std::find_if (hits.begin (), hits.end (), [] (const auto& hit) {
        return hit.target.find ("teardownSawSent=") != std::string::npos;
    });
    ASSERT_NE (teardown_hit, hits.end ());
    EXPECT_NE (teardown_hit->target.find ("teardownSawSent=3"), std::string::npos)
    << teardown_hit->target;
}

// ============================================================================
// Dispatch: run.start / run.end for a single-request load run's own
// `lifecycleElements` (issue #1573) - no collection, no scenario.
// ============================================================================

// Regression check for the `run_collection_setup` / `run_collection_teardown`
// refactor this issue made: a single-request run declaring no
// `lifecycleElements` at all still runs exactly as it always did, with no
// `lifecycle` key in its summary.
TEST_F (ScriptLifecycleTest, SingleRequestWithNoLifecycleElementsRunsNormally) {
    EXPECT_EQ (run_single_request_load (json::array (), /*iterations=*/2,
               /*concurrency=*/2),
    vayu::RunStatus::Completed);
    EXPECT_EQ (server_->requests ().size (), 2u);
    EXPECT_FALSE (summary_of ("run_single").contains ("lifecycle"));
}

// `compile_run_lifecycle_elements` stamps an id the same way validation
// already accepted an id-less entry (`AcceptsAnEntryWithNoId`, above) - this
// proves the dispatched side of that default, not just the validated side:
// a `script.teardown` declared with no `id` still dispatches and reports a
// real, non-empty generated one. Mutation check: drop the
// `stamp_default_element_ids` call in `compile_run_lifecycle_elements` and
// `teardown[0]["id"]` reddens to `""`.
TEST_F (ScriptLifecycleTest, SingleRequestLifecycleElementWithNoIdGetsAGeneratedIdInOutcomes) {
    const json elements = json::array (
    { json{ { "kind", "script.teardown" }, { "config", { { "script", "1;" } } } } });
    EXPECT_EQ (run_single_request_load (elements, /*iterations=*/1, /*concurrency=*/1),
    vayu::RunStatus::Completed);

    auto summary = summary_of ("run_single");
    ASSERT_TRUE (summary.contains ("lifecycle"));
    ASSERT_TRUE (summary["lifecycle"].contains ("teardown"));
    const auto& teardown = summary["lifecycle"]["teardown"];
    ASSERT_EQ (teardown.size (), 1u);
    const auto id = teardown[0]["id"].get<std::string> ();
    EXPECT_FALSE (id.empty ());
    EXPECT_NE (id.find ("el_"), std::string::npos) << id;
}

// The single-request half of the issue's own acceptance scenario. A
// single-request run's own submission has no element pipeline to read a
// scripted variable back from (docs/engine/elements.md's "Still not wired"
// paragraph), so unlike the collection-backed case this cannot resolve into
// the request itself - what it *can* do, the same as a collection's
// `script.setup`, is reach the network with `pm.sendRequest` before the
// run's own submissions start. Mutation check: skip binding
// `setup_config.allow_send_request` from the run's own `allowScriptRequests`
// and this reddens - `pm.sendRequest` throws, which fails the whole run.
TEST_F (ScriptLifecycleTest, SingleRequestSetupCanFetchATokenWithSendRequestBeforeTheRunStarts) {
    EXPECT_EQ (run_single_request_load (
               script_setup_element ("pm.sendRequest('" + server_->url ("/token") +
               "', function (err, res) { "
               "  pm.sendRequest('" +
               server_->url ("/ok") +
               "?setupFetchedToken=' + res.json().token, function () {});"
               "});"),
               /*iterations=*/3, /*concurrency=*/3, /*allow_script_requests=*/true),
    vayu::RunStatus::Completed);

    // Three ordinary submissions plus setup's own ping proving the token
    // `pm.sendRequest`-fetched from `/token` reached a second `pm.sendRequest`
    // (`/token` itself is not recorded by `LifecycleMockServer` - only `/ok`
    // is - the same reason the collection-mode precedent above only counts
    // its own `/ok` hits).
    auto hits = server_->requests ();
    ASSERT_EQ (hits.size (), 4u);
    const auto setup_hit = std::find_if (hits.begin (), hits.end (), [] (const auto& hit) {
        return hit.target.find ("setupFetchedToken=") != std::string::npos;
    });
    ASSERT_NE (setup_hit, hits.end ());
    EXPECT_NE (setup_hit->target.find ("setupFetchedToken=fetched-by-setup"), std::string::npos)
    << setup_hit->target;
}

// Mutation check: let a throwing `script.setup` outcome pass unnoticed in
// `execute_load_test` and this reddens to Completed with three requests sent
// - the same mutations `LoadThrowingSetupFailsTheRunWithNoSubmissions` checks
// for the collection-backed path.
TEST_F (ScriptLifecycleTest, SingleRequestThrowingSetupFailsTheRunWithNoSubmissions) {
    EXPECT_EQ (run_single_request_load (
               script_setup_element ("throw new Error ('boom');"), /*iterations=*/1,
               /*concurrency=*/3),
    vayu::RunStatus::Failed);
    EXPECT_TRUE (server_->requests ().empty ());
    expect_refusing_setup (report_lifecycle_of ("run_single"), "error", "boom");
}

TEST_F (ScriptLifecycleTest, SingleRequestSetupWithAFailingTestFailsTheRunAndSaysWhich) {
    EXPECT_EQ (run_single_request_load (script_setup_element (FAILING_TEST_SETUP),
               /*iterations=*/1, /*concurrency=*/3),
    vayu::RunStatus::Failed);
    EXPECT_TRUE (server_->requests ().empty ());
    expect_refusing_setup (report_lifecycle_of ("run_single"), "failed", FAILING_TEST_MESSAGE);
}

// The single-request half of LoadSetupFailureLogsTheThrownTextAsABoundedField.
TEST_F (ScriptLifecycleTest, SingleRequestSetupFailureLogsTheThrownTextAsABoundedField) {
    const vayu::tests::LogCapture log;

    EXPECT_EQ (run_single_request_load (script_setup_element (vayu::tests::script_throwing (
                                        vayu::tests::thrown_text (0))),
               /*iterations=*/1, /*concurrency=*/3),
    vayu::RunStatus::Failed);

    const auto records = log.with_msg_prefix ("script.setup failed");
    ASSERT_EQ (records.size (), 1u);
    EXPECT_EQ (records[0].at ("msg").get<std::string> (), "script.setup failed");
    vayu::tests::expect_script_text_only_bounded_in (records[0], "scriptError");
}

// The single-request half of LoadThrowingTeardownIsRecordedWithoutChangingStatus.
TEST_F (ScriptLifecycleTest, SingleRequestThrowingTeardownIsRecordedWithoutChangingStatus) {
    EXPECT_EQ (run_single_request_load (setup_and_teardown_elements ("", "throw new Error ('teardown boom');"),
               /*iterations=*/2,
               /*concurrency=*/2),
    vayu::RunStatus::Completed);

    auto summary = summary_of ("run_single");
    ASSERT_TRUE (summary.contains ("lifecycle"));
    ASSERT_TRUE (summary["lifecycle"].contains ("teardown"));
    const auto& teardown = summary["lifecycle"]["teardown"];
    ASSERT_EQ (teardown.size (), 1u);
    EXPECT_EQ (teardown[0]["outcome"], "error");
    EXPECT_NE (
    teardown[0]["message"].get<std::string> ().find ("teardown boom"), std::string::npos);
}

// The single-request half of LoadTeardownKeepsItsConsoleAndFailingTest.
TEST_F (ScriptLifecycleTest, SingleRequestTeardownKeepsItsConsoleAndFailingTest) {
    EXPECT_EQ (run_single_request_load (setup_and_teardown_elements ("", LOGGING_FAILING_TEST_TEARDOWN),
               /*iterations=*/2, /*concurrency=*/2),
    vayu::RunStatus::Completed);
    expect_teardown_keeps_its_output (report_lifecycle_of ("run_single"));
}

// The single-request half of LoadTeardownSeesTheActualSentCount: teardown
// pings the mock server with `pm.info.run.requestsSent`, proving it runs
// after every submission has settled and sees this run shape's own count.
TEST_F (ScriptLifecycleTest, SingleRequestTeardownSeesTheActualSentCount) {
    EXPECT_EQ (run_single_request_load (
               setup_and_teardown_elements ("",
               "pm.sendRequest('" + server_->url ("/ok") + "?teardownSawSent=' + pm.info.run.requestsSent, function () {});"),
               /*iterations=*/3, /*concurrency=*/3, /*allow_script_requests=*/true),
    vayu::RunStatus::Completed);

    auto hits = server_->requests ();
    // Three ordinary submissions plus teardown's own ping.
    ASSERT_EQ (hits.size (), 4u);
    const auto teardown_hit =
    std::find_if (hits.begin (), hits.end (), [] (const auto& hit) {
        return hit.target.find ("teardownSawSent=") != std::string::npos;
    });
    ASSERT_NE (teardown_hit, hits.end ());
    EXPECT_NE (teardown_hit->target.find ("teardownSawSent=3"), std::string::npos)
    << teardown_hit->target;
}

// ============================================================================
// The lifecycle set (#3456): the chain above the run collection and, on a
// recursive run, every folder beneath it
// ============================================================================

/// A `script.setup` and a `script.teardown`, each pinging `/ok?mark=<who>-...`
/// so the mock's hit order shows when it ran beside the steps; @p setup_extra
/// runs after the setup's ping. The teardown's ping also carries `saw=`, the
/// `subToken` its collection's chain answers, which says which collection it
/// was bound to.
json marking_lifecycle (const LifecycleMockServer& server,
const std::string& who,
const std::string& setup_extra = "") {
    const std::string url = server.url ("/ok") + "?mark=" + who;
    return setup_and_teardown_elements (
    "pm.sendRequest('" + url + "-setup', function () {});" + setup_extra,
    "pm.sendRequest('" + url + "-teardown&saw=' + pm.collectionVariables.get('subToken'), function () {});");
}

/// Every hit's query, in the order the mock saw them.
std::vector<std::string> hit_queries (const std::vector<SeenRequest>& hits) {
    std::vector<std::string> queries;
    queries.reserve (hits.size ());
    for (const auto& hit : hits) {
        queries.push_back (hit.target.substr (hit.target.find ('?') + 1));
    }
    return queries;
}

/// The `origin.id` of each row of @p rows, in order.
std::vector<std::string> origin_ids (const json& rows) {
    std::vector<std::string> ids;
    for (const auto& row : rows) {
        ids.push_back (row.value ("origin", json::object ()).value ("id", ""));
    }
    return ids;
}

enum class RunMode : std::uint8_t { Sequential, Load };

/// Every case runs as a sequential collection run and as a scenario load run
/// of one iteration on one virtual user, so the mock sees one order either way.
class LifecycleSetRunTest : public ScriptLifecycleTest,
                            public ::testing::WithParamInterface<RunMode> {
    protected:
    /// `col_1` (one request) holding the sub-folder `col_sub` (one request
    /// whose URL reads `{{subToken}}`, which only `col_sub`'s setup writes),
    /// each with a marking setup and teardown.
    void seed_root_and_sub_folder () {
        seed_folder ("col_1", std::nullopt, 0, marking_lifecycle (*server_, "root"));
        seed_request_in ("req_root", "col_1", 0, "step=root");
        seed_folder ("col_sub", "col_1", 1,
        marking_lifecycle (*server_, "sub", "pm.collectionVariables.set('subToken', 'from-sub');"));
        seed_request_in ("req_sub", "col_sub", 0, "step=sub&tok={{subToken}}");
    }

    /// Runs @p execution in this case's mode, script requests allowed.
    vayu::RunStatus run (const vayu::core::ScenarioExecution& execution) {
        if (GetParam () == RunMode::Load) {
            return run_load (execution, /*iterations=*/1, /*concurrency=*/1,
            /*allow_script_requests=*/true);
        }
        return run_sequential (execution, /*allow_script_requests=*/true);
    }

    [[nodiscard]] json lifecycle () {
        return report_lifecycle_of (GetParam () == RunMode::Load ? "run_load" : "run_seq");
    }
};

INSTANTIATE_TEST_SUITE_P (BothRunModes,
LifecycleSetRunTest,
::testing::Values (RunMode::Sequential, RunMode::Load),
[] (const ::testing::TestParamInfo<RunMode>& info) {
    return info.param == RunMode::Load ? "Load" : "Sequential";
});

// The sub-folder's setup writes the sub-folder's variables: its step and its
// teardown read `subToken`, the root's teardown does not. Mutation checks:
// make `resolve_lifecycle_collections` (scenario_plan.cpp) return before it
// walks the subtree and the `sub-*` hits and rows disappear; bind every setup
// to the run collection in `run_scenario_setup` (scenario_runner.cpp) and the
// root's teardown sees `from-sub`; under load, bind every base to the run
// collection in `LoadScopeBases`' constructor (scenario_load.cpp) and the
// sub-folder's step sends its literal `{{subToken}}`.
TEST_P (LifecycleSetRunTest, ARecursiveRunSetsUpRootFirstAndTearsDownInReverse) {
    seed_root_and_sub_folder ();
    auto execution = resolve (1, "col_1", /*recursive=*/true);

    EXPECT_EQ (run (execution), vayu::RunStatus::Completed);

    EXPECT_EQ (hit_queries (server_->requests ()),
    (std::vector<std::string>{ "mark=root-setup", "mark=sub-setup", "step=root", "step=sub&tok=from-sub",
    "mark=sub-teardown&saw=from-sub", "mark=root-teardown&saw=undefined" }));

    const auto report = lifecycle ();
    EXPECT_EQ (origin_ids (report.value ("setup", json::array ())),
    (std::vector<std::string>{ "col_1", "col_sub" }));
    EXPECT_EQ (origin_ids (report.value ("teardown", json::array ())),
    (std::vector<std::string>{ "col_sub", "col_1" }));
    const auto setup = report.value ("setup", json::array ());
    ASSERT_EQ (setup.size (), 2u);
    EXPECT_EQ (setup[0]["origin"],
    (json{ { "kind", "collection" }, { "scope", "collection" },
    { "id", "col_1" }, { "name", "Collection col_1" } }));
    EXPECT_EQ (setup[1]["origin"],
    (json{ { "kind", "collection" }, { "scope", "folder" }, { "id", "col_sub" },
    { "name", "Collection col_sub" } }));
}

// Mutation checks: drop the ancestor half of `resolve_lifecycle_collections`
// (start the list at the run collection) and the `root-*` hits disappear;
// walk teardown forwards in `run_scenario_teardown` and the two teardowns
// swap.
TEST_P (LifecycleSetRunTest, RunningTheSubFolderAloneRunsTheRootsSetupFirst) {
    seed_root_and_sub_folder ();
    auto execution = resolve (1, "col_sub");

    EXPECT_EQ (run (execution), vayu::RunStatus::Completed);

    EXPECT_EQ (hit_queries (server_->requests ()),
    (std::vector<std::string>{ "mark=root-setup", "mark=sub-setup", "step=sub&tok=from-sub",
    "mark=sub-teardown&saw=from-sub", "mark=root-teardown&saw=undefined" }));
}

// A run that is not recursive sends only the run collection's own requests,
// so no folder beneath it is one the run sends from.
TEST_P (LifecycleSetRunTest, ARunThatIsNotRecursiveLeavesTheSubFoldersOut) {
    seed_root_and_sub_folder ();
    auto execution = resolve (1, "col_1", /*recursive=*/false);

    EXPECT_EQ (run (execution), vayu::RunStatus::Completed);

    EXPECT_EQ (hit_queries (server_->requests ()),
    (std::vector<std::string>{
    "mark=root-setup", "step=root", "mark=root-teardown&saw=undefined" }));
}

// A refusing folder setup fails the run as the run collection's would, its
// row naming the folder; the collections after it set up nothing and nothing
// tears down. Mutation check: drop the per-collection `lifecycle_refusal`
// check in `run_scenario_setup` (scenario_runner.cpp) and `col_later`'s setup
// runs.
TEST_P (LifecycleSetRunTest, ARefusingFolderSetupFailsTheRunAndNamesTheFolder) {
    seed_folder ("col_1", std::nullopt, 0, marking_lifecycle (*server_, "root"));
    seed_folder ("col_sub", "col_1", 0,
    marking_lifecycle (*server_, "sub", "throw new Error('sub boom');"));
    seed_folder ("col_later", "col_1", 1, marking_lifecycle (*server_, "later"));
    seed_request_in ("req_sub", "col_sub", 0, "step=sub");
    auto execution = resolve (1, "col_1", /*recursive=*/true);

    EXPECT_EQ (run (execution), vayu::RunStatus::Failed);

    EXPECT_EQ (hit_queries (server_->requests ()),
    (std::vector<std::string>{ "mark=root-setup", "mark=sub-setup" }));
    const auto report = lifecycle ();
    EXPECT_FALSE (report.contains ("teardown")) << report.dump ();
    const auto setup = report.value ("setup", json::array ());
    EXPECT_EQ (origin_ids (setup), (std::vector<std::string>{ "col_1", "col_sub" }));
    ASSERT_EQ (setup.size (), 2u);
    EXPECT_EQ (setup[0].value ("outcome", ""), "ok");
    EXPECT_EQ (setup[1].value ("outcome", ""), "error");
    EXPECT_NE (setup[1].value ("message", "").find ("sub boom"), std::string::npos)
    << setup[1].dump ();
    EXPECT_EQ (setup[1]["origin"].value ("name", ""), "Collection col_sub");
}

// ============================================================================
// resolve_lifecycle_collections, read straight off the database
// ============================================================================

/// The collection ids of @p lifecycle, in order.
std::vector<std::string> lifecycle_ids (
const std::vector<vayu::core::LifecycleCollection>& lifecycle) {
    std::vector<std::string> ids;
    ids.reserve (lifecycle.size ());
    for (const auto& collection : lifecycle) {
        ids.push_back (collection.collection_id);
    }
    return ids;
}

// Pre-order in sidebar order: `col_b` was written first but sits after
// `col_a`, and `col_a`'s own sub-folder comes before `col_b`. Mutation check:
// push a parent's children onto the stack unreversed in `folders_beneath` and
// `col_b` comes before `col_a`.
TEST_F (ScriptLifecycleTest, TheLifecycleSetWalksTheSubtreeDepthFirstInSidebarOrder) {
    const auto setup = script_setup_element ("1;");
    seed_folder ("col_1", std::nullopt, 0, setup);
    seed_folder ("col_b", "col_1", 1, setup);
    seed_folder ("col_a", "col_1", 0, setup);
    seed_folder ("col_a1", "col_a", 0, setup);

    EXPECT_EQ (
    lifecycle_ids (vayu::core::resolve_lifecycle_collections (*db_, "col_1", true)),
    (std::vector<std::string>{ "col_1", "col_a", "col_a1", "col_b" }));
    EXPECT_EQ (
    lifecycle_ids (vayu::core::resolve_lifecycle_collections (*db_, "col_a1", true)),
    (std::vector<std::string>{ "col_1", "col_a", "col_a1" }));
    EXPECT_EQ (
    lifecycle_ids (vayu::core::resolve_lifecycle_collections (*db_, "col_1", false)),
    (std::vector<std::string>{ "col_1" }));
}

// A folder with no `run.start` / `run.end` element is no entry, and an entry
// keeps only those two kinds of its collection's elements, each stamped.
TEST_F (ScriptLifecycleTest, TheLifecycleSetKeepsOnlyRunBoundaryElements) {
    json root_elements = setup_and_teardown_elements ("1;", "2;");
    root_elements.push_back ({ { "id", "el_pre" }, { "kind", "script.pre" },
    { "config", { { "script", "3;" } } } });
    seed_folder ("col_1", std::nullopt, 0, root_elements);
    seed_folder ("col_plain", "col_1", 0,
    json::array ({ json{ { "id", "el_pre" }, { "kind", "script.pre" },
    { "config", { { "script", "3;" } } } } }));

    const auto lifecycle = vayu::core::resolve_lifecycle_collections (*db_, "col_1", true);
    ASSERT_EQ (lifecycle_ids (lifecycle), (std::vector<std::string>{ "col_1" }));
    const auto& elements = lifecycle.front ().elements;
    ASSERT_EQ (elements.size (), 2u);
    EXPECT_EQ (elements[0].kind, "script.setup");
    EXPECT_EQ (elements[1].kind, "script.teardown");
    EXPECT_EQ (elements[0].scope, "collection");
    EXPECT_EQ (elements[0].origin.value ("id", ""), "col_1");
}

// A trashed folder's setup does not run, and neither does that of a folder
// beneath it. Mutation check: drop the `deleted_at` filter from
// `Database::get_collections` and `col_gone` returns.
TEST_F (ScriptLifecycleTest, TheLifecycleSetLeavesATrashedFolderOut) {
    const auto setup = script_setup_element ("1;");
    seed_folder ("col_1", std::nullopt, 0, setup);
    seed_folder ("col_gone", "col_1", 0, setup);
    seed_folder ("col_gone_child", "col_gone", 0, setup);
    seed_folder ("col_kept", "col_1", 1, setup);
    db_->delete_collection ("col_gone");

    EXPECT_EQ (
    lifecycle_ids (vayu::core::resolve_lifecycle_collections (*db_, "col_1", true)),
    (std::vector<std::string>{ "col_1", "col_kept" }));
}

// A `parent_id` cycle names each collection once. Mutation check: stop
// seeding the subtree's visited set with the chain in
// `resolve_lifecycle_collections` and `col_y` is listed twice.
TEST_F (ScriptLifecycleTest, TheLifecycleSetVisitsACycleOnce) {
    const auto setup = script_setup_element ("1;");
    seed_folder ("col_x", std::string ("col_y"), 0, setup);
    seed_folder ("col_y", std::string ("col_x"), 0, setup);

    const auto lifecycle = vayu::core::resolve_lifecycle_collections (*db_, "col_x", true);
    EXPECT_EQ (lifecycle_ids (lifecycle), (std::vector<std::string>{ "col_y", "col_x" }));
}

} // namespace
