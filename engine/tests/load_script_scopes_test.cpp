/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The variable scopes a *deferred* replay reads (issue #728).
 *
 * A load run's `tests` script is the same script a Send runs, so the two must
 * not disagree about what `pm.environment.get('region')` answers. Before the
 * fix, `validate_scripts` bound one freshly constructed empty `Environment` and
 * nothing else: every scope read `undefined` under load, so a test comparing a
 * response against a variable failed on every sampled replay and reported the
 * target as broken.
 *
 * These tests drive `validate_scripts` against a real database, because the
 * wiring between the loader and the replay is the thing under test - a test
 * calling `run_replay` with scopes it built itself would stay green with the
 * production path still binding nothing.
 */

#include <gtest/gtest.h>

#include <memory>
#include <optional>
#include <string>

#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

using json = nlohmann::json;

namespace {

/// A 200 whose body names the region the environment also names, so a script
/// can compare the two the way the issue's example does.
vayu::Response response_with (const std::string& body) {
    vayu::Response response;
    response.status_code             = 200;
    response.status_text             = "OK";
    response.body                    = body;
    response.timing.total_ms         = 1.0;
    response.headers["Content-Type"] = "application/json";
    return response;
}

class LoadScriptScopesTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_load_script_scopes.db";
    static constexpr const char* GLOBALS_BLOB = R"({"build":{"value":"1.2.3","enabled":true}})";
    static constexpr const char* LEAF_BLOB = R"({"page_size":{"value":"25","enabled":true}})";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();

        // Tenants (root, defines `tenant`) -> Users (leaf, defines
        // `page_size`), so an inherited name is covered as well as a leaf one.
        add_collection ("col_root", "Tenants", std::nullopt,
        R"({"tenant":{"value":"acme","enabled":true}})");
        add_collection ("col_leaf", "Users", "col_root", LEAF_BLOB);

        add_request ("req_1", "col_leaf");

        vayu::db::Environment environment;
        environment.id         = "env_eu";
        environment.name       = "EU";
        environment.variables  = R"({"region":{"value":"EU","enabled":true}})";
        environment.created_at = 1;
        environment.updated_at = 1;
        db_->save_environment (environment);

        vayu::db::Globals globals;
        globals.id         = "globals";
        globals.variables  = GLOBALS_BLOB;
        globals.updated_at = 1;
        db_->save_globals (globals);
    }

    void TearDown () override {
        db_.reset ();
        cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    void add_collection (const std::string& id,
    const std::string& name,
    std::optional<std::string> parent,
    const std::string& variables) {
        vayu::db::Collection collection;
        collection.id         = id;
        collection.name       = name;
        collection.parent_id  = std::move (parent);
        collection.variables  = variables;
        collection.auth       = "{}";
        collection.order      = 0;
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);
    }

    void add_request (const std::string& id, const std::string& collection_id) {
        vayu::db::Request request;
        request.id            = id;
        request.collection_id = collection_id;
        request.name          = "List users";
        request.method        = vayu::HttpMethod::GET;
        request.url           = "https://api.example.com/users";
        request.params        = "[]";
        request.headers       = "[]";
        request.body          = R"({"mode":"none"})";
        request.body_type     = "none";
        request.auth          = R"({"mode":"none"})";
        request.order         = 0;
        request.created_at    = 1;
        request.updated_at    = 1;
        db_->save_request (request);
    }

    /**
     * A single-request load run as `POST /runs` records one: the payload
     * carries the environment and the linked request, and the reservoir keeps
     * every sample offered so the test decides what is replayed.
     */
    static std::shared_ptr<vayu::core::RunContext>
    single_request_run (const std::string& script, bool with_environment = true) {
        json cfg = { { "response_sample_rate", 1 },
            { "max_response_samples", 100 }, { "requestId", "req_1" } };
        if (with_environment) {
            cfg["environmentId"] = "env_eu";
        }
        auto context = std::make_shared<vayu::core::RunContext> ("run-scopes", cfg);
        context->test_script = script;
        return context;
    }

    /// A scenario load run of `col_leaf` with one scripted step, its store
    /// seeded directly - the executor is not what is under test here.
    static std::shared_ptr<vayu::core::RunContext> scenario_run (const std::string& step_script) {
        const json cfg = { { "response_sample_rate", 1 },
            { "max_response_samples", 100 }, { "environmentId", "env_eu" } };
        auto context =
        std::make_shared<vayu::core::RunContext> ("run-scenario-scopes", cfg);

        auto execution = std::make_shared<vayu::core::ScenarioExecution> ();
        execution->request.source        = "collection";
        execution->request.collection_id = "col_leaf";
        execution->request.iterations    = 1;

        vayu::core::ScenarioStep step;
        step.index          = 0;
        step.request_id     = "req_1";
        step.name           = "List users";
        step.post_script    = step_script;
        step.request.method = vayu::HttpMethod::GET;
        step.request.url    = "https://api.example.com/users";
        execution->plan.steps.push_back (step);

        context->scenario = execution;
        context->metrics_collector->configure_step_samples ({ true });
        return context;
    }

    std::string stored_environment_variables () {
        auto environment = db_->get_environment ("env_eu");
        EXPECT_TRUE (environment.has_value ());
        return environment ? environment->variables : std::string ();
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// The issue itself: the same assertion that passes on Send with environment E
// must pass under a load run recorded with E. Mutation-check - restore the
// `vayu::Environment env;` the replay used to bind and this fails, because
// `pm.environment.get` answers `undefined` and the comparison against the
// response body fails on every sample.
TEST_F (LoadScriptScopesTest, ATestPassingOnSendPassesUnderLoad) {
    auto context = single_request_run (R"(
        pm.test('region matches the environment', function () {
            const body = pm.response.json();
            pm.expect(body.region).to.eql(pm.environment.get('region'));
        });
    )");
    context->metrics_collector->record_response_sample (response_with (R"({"region":"EU"})"));

    const auto validation = vayu::core::validate_scripts (context, *db_, false);

    ASSERT_TRUE (validation.run.has_value ());
    EXPECT_EQ (validation.run->sampled, 1u);
    EXPECT_EQ (validation.run->passed, 1u);
    EXPECT_EQ (validation.run->failed, 0u)
    << "the replay read an empty environment, so a test that passes on Send "
       "reports the target as broken";
}

// Globals and the collection chain, which the pre-fix path did not bind at all
// - not even an empty one. The ancestor's `tenant` is the D2 asymmetry's own
// case (issue #234): an inherited name must answer in a script exactly as it
// does in a URL.
TEST_F (LoadScriptScopesTest, GlobalsAndTheWholeCollectionChainAreBoundToo) {
    auto context = single_request_run (R"(
        pm.test('globals', function () {
            pm.expect(pm.globals.get('build')).to.eql('1.2.3');
        });
        pm.test('leaf collection scope', function () {
            pm.expect(pm.collectionVariables.get('page_size')).to.eql('25');
        });
        pm.test('inherited collection scope', function () {
            pm.expect(pm.collectionVariables.get('tenant')).to.eql('acme');
        });
    )");
    context->metrics_collector->record_response_sample (response_with ("{}"));

    const auto validation = vayu::core::validate_scripts (context, *db_, false);

    ASSERT_TRUE (validation.run.has_value ());
    EXPECT_EQ (validation.run->passed, 3u);
    EXPECT_EQ (validation.run->failed, 0u);
}

// A scenario load run's collection scope is the collection being *run*, not the
// collection of some request the run row happens to link - the same rule the
// design-mode runner applies. Mutation-check: resolve the scope from
// `script_request_id` in both shapes and this fails, since a scenario run has
// no run-level request id and the scope comes back empty.
TEST_F (LoadScriptScopesTest, AScenarioStepReplayReadsTheRunningCollectionsScope) {
    auto context = scenario_run (R"(
        pm.test('step scopes', function () {
            pm.expect(pm.environment.get('region')).to.eql('EU');
            pm.expect(pm.collectionVariables.get('page_size')).to.eql('25');
            pm.expect(pm.collectionVariables.get('tenant')).to.eql('acme');
        });
    )");
    context->metrics_collector->record_step_response_sample (
    response_with ("{}"), 0, 0, std::nullopt);

    const auto validation = vayu::core::validate_scripts (context, *db_, false);

    ASSERT_EQ (validation.steps.size (), 1u);
    ASSERT_TRUE (validation.steps[0].has_value ());
    EXPECT_EQ (validation.steps[0]->passed, 1u);
    EXPECT_EQ (validation.steps[0]->failed, 0u);
}

// The write rule, half one: a replay's `set()` is never persisted. A reservoir
// sample is not an iteration, so there is no ordering that would justify
// storing whichever replay wrote last.
TEST_F (LoadScriptScopesTest, AReplayWriteIsNeverPersisted) {
    const std::string before = stored_environment_variables ();

    auto context = single_request_run (R"(
        pm.environment.set('region', 'US');
        pm.globals.set('build', 'tampered');
        pm.collectionVariables.set('page_size', '999');
        pm.test('wrote', function () {
            pm.expect(pm.environment.get('region')).to.eql('US');
        });
    )");
    context->metrics_collector->record_response_sample (response_with ("{}"));

    const auto validation = vayu::core::validate_scripts (context, *db_, false);
    ASSERT_TRUE (validation.run.has_value ());
    EXPECT_EQ (validation.run->passed, 1u)
    << "the write was not even visible in-memory";

    EXPECT_EQ (stored_environment_variables (), before)
    << "a deferred replay persisted a variable; only design mode may write "
       "back";
    auto globals = db_->get_globals ();
    ASSERT_TRUE (globals.has_value ());
    EXPECT_EQ (globals->variables, GLOBALS_BLOB);
    auto leaf = db_->get_collection ("col_leaf");
    ASSERT_TRUE (leaf.has_value ());
    EXPECT_EQ (leaf->variables, LEAF_BLOB);
}

// The write rule, half two: one set of scopes for the whole pass, so a write is
// readable by the samples replayed after it. The first sample finds nothing and
// fails, the second finds the first one's write and passes - which pins the
// sharing precisely, where "both passed" would also be true of per-sample
// scopes that were merely non-empty.
TEST_F (LoadScriptScopesTest, AWriteIsVisibleToTheSamplesReplayedAfterIt) {
    auto context = single_request_run (R"(
        const prior = pm.globals.get('seen');
        pm.globals.set('seen', 'yes');
        pm.test('sees the earlier replay write', function () {
            pm.expect(prior).to.eql('yes');
        });
    )");
    context->metrics_collector->record_response_sample (response_with ("{}"));
    context->metrics_collector->record_response_sample (response_with ("{}"));

    const auto validation = vayu::core::validate_scripts (context, *db_, false);

    ASSERT_TRUE (validation.run.has_value ());
    EXPECT_EQ (validation.run->sampled, 2u);
    EXPECT_EQ (validation.run->passed, 1u);
    EXPECT_EQ (validation.run->failed, 1u);
}

// A run recorded without an environment keeps the documented empty-scope
// behaviour - `get` is `undefined`, not an error - while still binding the
// scopes that do exist. Absent is not the same as unbound.
TEST_F (LoadScriptScopesTest, ARunWithNoEnvironmentStillBindsTheOtherScopes) {
    auto context = single_request_run (R"(
        pm.test('no environment', function () {
            pm.expect(pm.environment.get('region')).to.eql(undefined);
        });
        pm.test('globals still bound', function () {
            pm.expect(pm.globals.get('build')).to.eql('1.2.3');
        });
    )",
    /*with_environment=*/false);
    context->metrics_collector->record_response_sample (response_with ("{}"));

    const auto validation = vayu::core::validate_scripts (context, *db_, false);

    ASSERT_TRUE (validation.run.has_value ());
    EXPECT_EQ (validation.run->passed, 2u);
    EXPECT_EQ (validation.run->failed, 0u);
}

} // namespace
