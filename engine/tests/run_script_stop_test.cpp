/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_script_stop_test.cpp
 * @brief A Stop and an engine shutdown end a run's running script and its
 *        deferred replay (issue #3460).
 *
 * Before #3460 the interrupt handler read only the script's deadline and the
 * replay walked every sample, so a Stop or a shutdown waited out each script's
 * `scriptTimeout`, sample after sample. These drive whole runs through
 * `RunManager`, because what is under test is that the run's flag reaches the
 * script, and the replay pass directly for what the pass itself decides.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "wait_until.hpp"

namespace vayu::http::routes {
// Declared in config.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json>
apply_config_update (vayu::db::Database& db, const std::string& body);
} // namespace vayu::http::routes

namespace {

using json = nlohmann::json;

constexpr const char* RUN_ID = "run-script-stop";

/// What a script nothing stops runs for, and so the broken reading of every
/// timing case below: past `wait_until`'s 20 s deadline.
constexpr const char* SCRIPT_TIMEOUT_MS = "30000";

/// A Stop or shutdown that reaches a running script ends it at QuickJS's next
/// interrupt poll, and the run settles well under 2 s (healthy). One that does
/// not waits out `SCRIPT_TIMEOUT_MS`, about 30 s (broken). The bound sits
/// between them, wide enough for the sanitizer legs.
constexpr auto SETTLE_BOUND = std::chrono::seconds (15);

/// A load run's submissions, and so its samples: every one is kept.
constexpr int ITERATIONS = 3;

/// A setting, set the way the app sets it.
void apply_setting (vayu::db::Database& db, const std::string& key, const std::string& value) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    db, json{ { "entries", { { key, value } } } }.dump ());
    ASSERT_EQ (status, 200) << body.dump ();
}

/// A script that tells @p mark_url it is running and then never ends: the
/// shape the issue measured, a passing test before an endless loop.
std::string looping_script (const std::string& mark_url) {
    return "pm.sendRequest('" + mark_url +
    "', function () {}); "
    "pm.test('t', function () {}); "
    "while (true) {}";
}

/// A teardown that runs for many interrupt polls and then finishes, so it is
/// `ok` only when nothing ends it early.
constexpr const char* BUSY_TEARDOWN =
"let n = 0; for (let i = 0; i < 2000000; i++) { n += i; }";

class RunScriptStopTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_run_script_stop.db";

    void SetUp () override {
        vayu::http::global_init ();
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        apply_setting (*db_, "scriptTimeout", SCRIPT_TIMEOUT_MS);
    }

    void TearDown () override {
        manager_.shutdown ();
        db_.reset ();
        cleanup ();
        vayu::http::global_cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    [[nodiscard]] std::string mark_url () const {
        return server_.url () + "/mark";
    }

    /// A single-request load run of `ITERATIONS` submissions to the server,
    /// every response sampled, with @p members added to its payload.
    void start_load_run (const json& members) {
        json config = { { "mode", "iterations" }, { "iterations", ITERATIONS },
            { "concurrency", 1 }, { "method", "GET" },
            { "url", server_.url () }, { "allowScriptRequests", true },
            { "response_sample_rate", 1 }, { "max_response_samples", 10 } };
        config.update (members);
        create_run_row (vayu::RunType::Load, config);
        ASSERT_TRUE (manager_.start_run (RUN_ID, config, *db_, nullptr));
    }

    /// A one-step sequential collection run whose step carries @p element.
    void start_sequential_run (const json& element) {
        vayu::db::Collection collection;
        collection.id         = "col_1";
        collection.name       = "Collection col_1";
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);

        auto execution = std::make_shared<vayu::core::ScenarioExecution> ();
        execution->request.source        = "collection";
        execution->request.collection_id = "col_1";
        execution->request.iterations    = 1;

        vayu::core::ScenarioStep step;
        step.index          = 0;
        step.request_id     = "req_1";
        step.name           = "Step";
        step.request.method = vayu::HttpMethod::GET;
        step.request.url    = server_.url ();
        step.stored_url     = step.request.url;
        step.elements       = vayu::tests::compiled_elements ({ element });
        execution->plan.steps.push_back (std::move (step));

        const json config = { { "scenario",
                              { { "source", "collection" },
                              { "collectionId", "col_1" }, { "iterations", 1 } } },
            { "allowScriptRequests", true } };
        create_run_row (vayu::RunType::Scenario, config);
        ASSERT_TRUE (manager_.start_scenario_run (RUN_ID, config, execution, *db_, jar_));
    }

    /// Waits until the server has seen @p count requests, the sign that a
    /// script past its own `pm.sendRequest` is running.
    [[nodiscard]] bool await_requests (int count) const {
        return vayu::tests::wait_until (
        [this, count] () { return server_.requests_seen () >= count; });
    }

    /// Stops the run and answers how long it took to finish, or nullopt when
    /// it had not within `wait_until`'s deadline.
    [[nodiscard]] std::optional<std::chrono::milliseconds> stop_and_time () {
        const auto context = manager_.get_run (RUN_ID);
        if (!context) {
            ADD_FAILURE () << "the run had ended before the Stop";
            return std::nullopt;
        }
        const auto stopped_at = std::chrono::steady_clock::now ();
        context->request_stop ();
        if (!vayu::tests::wait_until (
            [this] () { return manager_.get_run (RUN_ID) == nullptr; })) {
            return std::nullopt;
        }
        return elapsed_since (stopped_at);
    }

    /// How long `RunManager::shutdown` took to drain the run.
    [[nodiscard]] std::chrono::milliseconds shutdown_and_time () {
        const auto started_at = std::chrono::steady_clock::now ();
        manager_.shutdown ();
        return elapsed_since (started_at);
    }

    [[nodiscard]] std::optional<vayu::db::Run> stored_run () const {
        return db_->get_run (RUN_ID);
    }

    /// The stored summary, parsed.
    [[nodiscard]] json stored_summary () const {
        const auto run = stored_run ();
        return run ? json::parse (run->summary, nullptr, false) : json ();
    }

    vayu::tests::EchoServer server_;
    std::unique_ptr<vayu::db::Database> db_;
    /// The sequential run's jar; declared before the manager it must outlive.
    vayu::http::CookieJar jar_;
    vayu::core::RunManager manager_;

    private:
    static std::chrono::milliseconds elapsed_since (
    std::chrono::steady_clock::time_point start) {
        return std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::steady_clock::now () - start);
    }

    /// A real stamp: a run dated 1970 is pruned the moment it finishes.
    static int64_t now_ms () {
        return std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
        .count ();
    }

    void create_run_row (vayu::RunType type, const json& config) {
        vayu::db::Run run;
        run.id              = RUN_ID;
        run.type            = type;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = config.dump ();
        run.start_time      = now_ms ();
        run.end_time        = run.start_time;
        db_->create_run (run);
    }
};

/// A run's deferred `script.post` and its `script.teardown`.
json replayed_and_teardown (const std::string& replayed, const std::string& teardown) {
    return { { "requestElements",
             json::array ({ vayu::tests::script_element_json ("el_post", "script.post", replayed) }) },
        { "lifecycleElements",
        json::array ({ vayu::tests::script_element_json (
        "el_teardown", "script.teardown", teardown) }) } };
}

} // namespace

// The issue's live case: the run finished sending, its replay's script loops,
// and a Stop lands while the first sample's script runs. The run settles
// within the bound (see SETTLE_BOUND), keeps its own end, replays no further
// sample, and its teardown, which a Stop latched before it leaves to run, is
// `ok`. Mutation checks: drop the `stop` check from `script_interrupt_handler`
// and the run waits out the 30 s script timeout; drop the `replay_stopped`
// check from `run_replay`'s loop and all three samples are tested; have
// `teardown_stop` answer `&should_stop` and the teardown is `skipped`.
TEST_F (RunScriptStopTest, AStopDuringTheReplayEndsItsRunningScript) {
    start_load_run (replayed_and_teardown (looping_script (mark_url ()), BUSY_TEARDOWN));
    ASSERT_TRUE (await_requests (ITERATIONS + 1))
    << "the replay's script never ran";

    const auto settled = stop_and_time ();
    ASSERT_HAS_VALUE (settled) << "the run never settled after the Stop";
    EXPECT_LT (*settled, SETTLE_BOUND);

    const auto run = stored_run ();
    ASSERT_HAS_VALUE (run);
    // A Stop after the sending ended decides nothing about the run's end.
    EXPECT_EQ (run->status, vayu::RunStatus::Completed) << run->summary;
    const auto summary = stored_summary ();
    EXPECT_EQ (summary.value (json::json_pointer ("/tests/sampled"), -1), 1)
    << run->summary;
    EXPECT_EQ (summary.value (json::json_pointer ("/tests/failed"), -1), 0)
    << run->summary;
    EXPECT_EQ (
    summary.value (json::json_pointer ("/lifecycle/teardown/0/outcome"), ""), "ok")
    << run->summary;
}

// `POST /shutdown` and a signal both drain through `RunManager::shutdown`,
// which before #3460 waited out the replay's script. Healthy and broken as
// SETTLE_BOUND names them. Mutation check: drop the `stop` check from
// `script_interrupt_handler` and the drain takes the 30 s script timeout.
TEST_F (RunScriptStopTest, AShutdownDuringTheReplayEndsItsRunningScript) {
    start_load_run (replayed_and_teardown (looping_script (mark_url ()), BUSY_TEARDOWN));
    ASSERT_TRUE (await_requests (ITERATIONS + 1))
    << "the replay's script never ran";

    EXPECT_LT (shutdown_and_time (), SETTLE_BOUND);
}

// A teardown running when the engine shuts down ends with it, as every other
// script does. The run reached its own end, so no Stop was latched before the
// teardown. Mutation check: have `run_collection_teardown` give the teardown
// no `stop` and the drain takes the 30 s script timeout.
TEST_F (RunScriptStopTest, AShutdownDuringTheTeardownEndsIt) {
    start_load_run ({ { "lifecycleElements",
    json::array ({ vayu::tests::script_element_json (
    "el_teardown", "script.teardown", looping_script (mark_url ())) }) } });
    ASSERT_TRUE (await_requests (ITERATIONS + 1)) << "the teardown never ran";

    EXPECT_LT (shutdown_and_time (), SETTLE_BOUND);
}

// The issue's second measurement: a sequential run's Stop waited out a running
// step script's `scriptTimeout`. The script it cut short is `skipped`, no
// verdict, and the step is `stopped`. Healthy and broken as SETTLE_BOUND names
// them. Mutation checks: drop `inputs.stop = ...` from `run_step_exchange`
// (scenario_runner.cpp) and the run waits out the 30 s script timeout; have
// `skip_if_ended_by_stop` (script_kinds.cpp) read only `send_cancelled` and the
// element's row is an error.
TEST_F (RunScriptStopTest, AStopEndsASequentialStepsRunningScript) {
    start_sequential_run (vayu::tests::script_element_json (
    "el_pre", "script.pre", looping_script (mark_url ())));
    ASSERT_TRUE (await_requests (1)) << "the step's script never ran";

    const auto settled = stop_and_time ();
    ASSERT_HAS_VALUE (settled) << "the run never settled after the Stop";
    EXPECT_LT (*settled, SETTLE_BOUND);

    const auto run = stored_run ();
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Stopped) << run->summary;
    const auto summary = stored_summary ();
    EXPECT_EQ (summary.value (json::json_pointer ("/scenario/stopped"), -1), 1)
    << run->summary;
    EXPECT_EQ (summary.value (json::json_pointer ("/scenario/errored"), -1), 0)
    << run->summary;

    const auto rows = db_->get_results (RUN_ID);
    ASSERT_EQ (rows.size (), 1u);
    const auto trace = json::parse (rows[0].trace_data);
    EXPECT_EQ (trace.value (json::json_pointer ("/elements/0/outcome"), ""), "skipped")
    << rows[0].trace_data;
}

// A Stop latched before teardown began leaves the teardown to run; only the
// engine shutting down ends it then. A Stop or shutdown that arrives while it
// runs ends it as it ends any script.
TEST (RunContextTeardownStop, IsTheStopUntilOneIsLatchedThenTheShutdown) {
    vayu::core::RunContext context ("run-teardown-stop", json::object ());
    EXPECT_EQ (context.teardown_stop (), &context.should_stop);

    context.request_stop ();
    ASSERT_EQ (context.teardown_stop (), &context.engine_stopping);
    EXPECT_FALSE (context.teardown_stop ()->load ());

    context.request_shutdown ();
    EXPECT_TRUE (context.teardown_stop ()->load ());
}

// ============================================================================
// The replay pass itself
// ============================================================================

namespace {

/// A single-request run's context with @p samples sampled responses and
/// @p script as its deferred `tests` script, its script inputs configured as a
/// started run's are.
std::shared_ptr<vayu::core::RunContext>
replay_context (vayu::db::Database& db, const std::string& script, size_t samples) {
    const json payload = { { "response_sample_rate", 1 }, { "max_response_samples", 10 } };
    auto context = std::make_shared<vayu::core::RunContext> (RUN_ID, payload);
    context->test_scripts = { script };
    for (size_t i = 0; i < samples; ++i) {
        vayu::Response sample;
        sample.status_code     = 200;
        sample.status_text     = "OK";
        sample.body            = "{}";
        sample.timing.total_ms = 1.0;
        context->metrics_collector->record_response_sample (sample);
    }
    vayu::core::configure_event_loop (db, context->config, context,
    /*concurrency=*/1, /*timeout_ms=*/5000, /*configured_workers=*/1,
    /*default_max_per_host=*/1);
    return context;
}

} // namespace

// A Stop latched before the replay (one during the sending) replays nothing,
// and a pass that judged nothing reports no tally rather than one of zeros.
// Mutation check: drop the `replay_stopped` check from `run_replay`'s loop and
// the pass reports three samples tested.
TEST_F (RunScriptStopTest, AStopLatchedBeforeTheReplayReplaysNothing) {
    auto context = replay_context (*db_, "pm.test('t', function () {});", 3);
    context->request_stop ();

    const auto validation = vayu::core::validate_scripts (context, *db_);

    EXPECT_FALSE (validation.run.has_value ());
}

// A script that ran out its deadline would run it out again on every sample
// after, so it is not replayed: one failure, naming what was left out, and one
// execution. Mutation check: drop `timed_out[i] = true` from `replay_sample`
// and the script runs, and fails, four times.
TEST_F (RunScriptStopTest, AReplayedScriptThatTimedOutIsNotReplayedAgain) {
    apply_setting (*db_, "scriptTimeout", "200");
    auto context = replay_context (*db_, "console.log('ran'); while (true) {}", 4);

    const auto validation = vayu::core::validate_scripts (context, *db_);

    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->sampled, 4u);
    EXPECT_EQ (validation.run->failed, 1u);
    ASSERT_EQ (validation.run->console.size (), 1u);
    EXPECT_EQ (validation.run->console[0].count, 1u);

    const auto rows = db_->get_results (RUN_ID);
    ASSERT_FALSE (rows.empty ());
    const auto failures = json::parse (rows.back ().trace_data).at ("failures");
    ASSERT_EQ (failures.size (), 1u) << failures.dump ();
    EXPECT_NE (failures[0].get<std::string> ().find (
               "timed out, not replayed against the remaining 3 samples"),
    std::string::npos)
    << failures.dump ();
}
