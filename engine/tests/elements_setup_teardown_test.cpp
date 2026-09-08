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
 *        the sequential runner and the load path.
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
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

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
    EXPECT_NE (reason->find ("may only be added to a collection"), std::string::npos)
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
    EXPECT_NE (reason->find ("lifecycleElements[0]"), std::string::npos) << *reason;
    EXPECT_NE (reason->find ("assert.status"), std::string::npos) << *reason;
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
        vayu::db::Collection col;
        col.id         = "col_1";
        col.name       = "Collection col_1";
        col.elements   = elements.dump ();
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
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

    vayu::core::ScenarioExecution resolve (size_t iterations) {
        json scenario{ { "source", "collection" }, { "collectionId", "col_1" },
            { "iterations", iterations } };
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

    /// Runs `col_1`'s plan sequentially and waits for a terminal status.
    vayu::RunStatus run_sequential (const vayu::core::ScenarioExecution& execution,
    bool allow_script_requests = false) {
        const json scenario{ { "source", "collection" },
            { "collectionId", "col_1" }, { "iterations", 1 } };
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

    /// Runs `col_1`'s plan as a scenario load run (through the same
    /// `execute_load_test` / `finish_load_test` production uses) and waits
    /// for a terminal status.
    vayu::RunStatus run_load (const vayu::core::ScenarioExecution& execution,
    size_t iterations,
    size_t concurrency,
    bool allow_script_requests = false) {
        const json scenario{ { "source", "collection" }, { "collectionId", "col_1" } };
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
            ADD_FAILURE () << "no run is stored under " << run_id;
            return json::object ();
        }
        return json::parse (run->summary);
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
TEST_F (ScriptLifecycleTest, SequentialThrowingSetupFailsTheRunBeforeAnyStepIsSent) {
    seed_collection (script_setup_element ("throw new Error('boom');"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_sequential (execution), vayu::RunStatus::Failed);
    EXPECT_TRUE (server_->requests ().empty ());
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
// loop) and this reddens to Completed with three requests sent.
TEST_F (ScriptLifecycleTest, LoadThrowingSetupFailsTheRunWithNoSubmissions) {
    seed_collection (script_setup_element ("throw new Error('boom');"));
    seed_request ();
    auto execution = resolve (1);

    EXPECT_EQ (run_load (execution, /*iterations=*/1, /*concurrency=*/3),
    vayu::RunStatus::Failed);
    EXPECT_TRUE (server_->requests ().empty ());
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
// - the same mutation `LoadThrowingSetupFailsTheRunWithNoSubmissions` checks
// for the collection-backed path.
TEST_F (ScriptLifecycleTest, SingleRequestThrowingSetupFailsTheRunWithNoSubmissions) {
    EXPECT_EQ (run_single_request_load (
               script_setup_element ("throw new Error ('boom');"), /*iterations=*/1,
               /*concurrency=*/3),
    vayu::RunStatus::Failed);
    EXPECT_TRUE (server_->requests ().empty ());
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

} // namespace
