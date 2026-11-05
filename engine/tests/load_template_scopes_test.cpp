/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/load_template_scopes_test.cpp
 * @brief A raw single-request `POST /runs` reads its `{{names}}` against the
 *        scopes it names, as `POST /execute` does (#3253).
 *
 * Two layers. The pass itself (`resolve_load_template_tokens`), because what it
 * must leave alone - every token the per-iteration bind owns - is exactly what
 * the design send's residual pass consumes. And the run, driven through
 * `RunManager::start_run` against a real database and read off the wire,
 * because the wiring into `build_load_request` is the other half of the fix.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/encoding.hpp"
#include "wait_until.hpp"

namespace {

using nlohmann::json;
using vayu::http::routes::resolve_load_template_tokens;

// ============================================================================
// The pass: what it resolves, and what it leaves for the bind
// ============================================================================

// Every token the bind owns survives: the data namespace, the identity, a
// generator (also when a scope's value is one), and a bare name the run's rows
// bind, which a scope defining the same name must not answer (#1007).
// Mutation checks: pass `DynamicResolution::Generate` in
// `resolve_load_template_tokens` and `{{$guid}}` is consumed, once, for every
// submission; pass no bound columns and `{{username}}` takes the scope's value.
TEST (LoadTemplateTokens, LeavesEveryTokenTheBindOwns) {
    const std::string bind_tokens =
    "/u/{{$vu}}?i={{$iteration}}&g={{$guid}}&d={{data.id}}&c={{username}}";
    vayu::Request request;
    request.url = "{{base}}" + bind_tokens;
    request.headers.add ("X-Trace", "{{trace}}");
    request.body.content = R"({"id":"{{id}}"})";
    const vayu::http::VariableValues vars{ { "base", "https://api.test" },
        { "username", "from-the-scope" }, { "trace", "t-1" }, { "id", "{{$guid}}" } };

    const auto refusal = resolve_load_template_tokens (request, vars, { "username" });

    EXPECT_FALSE (refusal.has_value ());
    EXPECT_EQ (request.url, "https://api.test" + bind_tokens);
    EXPECT_EQ (request.headers.at ("X-Trace"), "t-1");
    EXPECT_EQ (request.body.content, R"({"id":"{{$guid}}"})")
    << "a scope value naming a generator stays a generator, for the bind to "
       "generate per iteration";
}

// A path value the pass answers is written into the URL; one still waiting on
// the bind keeps waiting, rather than being written verbatim the way the last
// pass before a send writes it. Mutation check: settle `PathSettle::All` in
// `resolve_load_template_tokens` and `:vu` is written as its literal token.
TEST (LoadTemplateTokens, APathValueWaitingOnTheBindKeepsWaiting) {
    vayu::Request request;
    request.url = "https://api.test/:tenant/:vu";
    request.path_variables = { { "tenant", "{{tenant}}" }, { "vu", "{{$vu}}" } };

    const auto refusal =
    resolve_load_template_tokens (request, { { "tenant", "acme" } }, {});

    EXPECT_FALSE (refusal.has_value ());
    EXPECT_EQ (request.url, "https://api.test/acme/:vu");
    ASSERT_EQ (request.path_variables.size (), 1u);
    EXPECT_EQ (request.path_variables[0].key, "vu");
    EXPECT_EQ (request.path_variables[0].value, "{{$vu}}");
}

// ============================================================================
// The run: start_run against a real database, read off the wire
// ============================================================================

constexpr const char* DB_PATH = "test_load_template_scopes.db";

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

class LoadTemplateScopesRunTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }

    void TearDown () override {
        manager_.shutdown ();
        db_.reset ();
        vayu::http::global_cleanup ();
        cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    void save_environment (const std::string& id, const json& variables) {
        vayu::db::Environment environment;
        environment.id         = id;
        environment.name       = id;
        environment.variables  = variables.dump ();
        environment.created_at = 1;
        environment.updated_at = 1;
        db_->save_environment (environment);
    }

    /// `col_1`, defining @p variables, holding `req_1`.
    void save_collection_with_request (const json& variables) {
        vayu::db::Collection collection;
        collection.id         = "col_1";
        collection.name       = "Users";
        collection.variables  = variables.dump ();
        collection.auth       = "{}";
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);

        vayu::db::Request request;
        request.id            = "req_1";
        request.collection_id = "col_1";
        request.name          = "List users";
        request.method        = vayu::HttpMethod::GET;
        request.url           = "https://unused.test";
        request.created_at    = 1;
        request.updated_at    = 1;
        db_->save_request (request);
    }

    /// One enabled variable, in the stored blob's shape.
    static json variable (const std::string& value) {
        return json{ { "value", value }, { "enabled", true } };
    }

    /// A raw single-request run against @p url, with no `requestElements`.
    static json payload (const std::string& url, size_t iterations = 2) {
        return json{ { "method", "GET" }, { "url", url }, { "mode", "iterations" },
            { "iterations", iterations }, { "concurrency", 1 }, { "timeout", 5000 } };
    }

    /// Runs @p config to its terminal status and answers the stored row. Its
    /// `data` rows and credential plan are read by the route's own reader, as
    /// `POST /runs` reads them, so a run that binds them is the run the route
    /// would start.
    std::optional<vayu::db::Run> run (const json& config) {
        vayu::core::ScenarioLimits limits;
        limits.max_data_rows  = vayu::core::constants::scenario::MAX_DATA_ROWS;
        limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;
        auto read = vayu::http::routes::read_load_data_set (config, limits, false);
        if (!read.ok) {
            ADD_FAILURE () << "the route refused the payload: " << read.error;
            return std::nullopt;
        }

        const std::string run_id = "run_template_scopes";
        vayu::db::Run row;
        row.id              = run_id;
        row.type            = vayu::RunType::Load;
        row.status          = vayu::RunStatus::Pending;
        row.config_snapshot = "{}";
        // A real stamp: a run dated 1970 is pruned with its row the moment
        // it finishes.
        row.start_time = now_ms ();
        row.end_time   = row.start_time;
        db_->create_run (row);

        if (!manager_.start_run (run_id, config, *db_, nullptr,
            std::move (read.set), std::move (read.auth))) {
            ADD_FAILURE () << "start_run refused the payload";
            return std::nullopt;
        }
        // `retain_run` is the worker's last act, after the summary is stored.
        if (!vayu::tests::wait_until (
            [&] () { return manager_.get_run (run_id) == nullptr; })) {
            ADD_FAILURE () << "the run never finished";
            return std::nullopt;
        }
        return db_->get_run (run_id);
    }

    /// The summary's `unresolved_tokens` warning, or null when it has none.
    static json unresolved_warning (const vayu::db::Run& stored) {
        const auto summary = json::parse (stored.summary);
        for (const auto& warning : summary.value ("warnings", json::array ())) {
            if (warning.value ("code", "") == "unresolved_tokens") {
                return warning;
            }
        }
        return nullptr;
    }

    static bool names (const json& warning, const std::string& name) {
        const auto& listed = warning.at ("names");
        return std::find (listed.begin (), listed.end (), name) != listed.end ();
    }

    /// A `lifecycleElements` array whose `script.setup` points `base` at the
    /// echo server's `/setup`.
    json setup_writing_base () const {
        return json::array (
        { json{ { "id", "el_setup" }, { "kind", "script.setup" }, { "enabled", true },
        { "config", { { "script", "pm.environment.set('base', '" + echo_.url () + "/setup');" } } } } });
    }

    /// A `requestElements` array holding only `assert.status`, a `step.after`
    /// kind: it reads the response and never writes into the request.
    static json response_reading_elements () {
        return json::array ({ json{ { "id", "el_status" }, { "kind", "assert.status" },
        { "enabled", true }, { "config", { { "in", json::array ({ 200 }) } } } } });
    }

    std::unique_ptr<vayu::db::Database> db_;
    vayu::core::RunManager manager_;
    vayu::tests::EchoServer echo_;
};

// The issue's case: an environment answers a bare `{{base}}` in a run that
// declares no `requestElements`, and the run reports nothing unresolved.
// Mutation check: drop the `resolve_template_against_stored_scopes` call from
// `build_load_request` and the URL goes out as `{{base}}/x` - nothing reaches
// the echo server and the warning names `base`.
TEST_F (LoadTemplateScopesRunTest, ARawRunNamingAnEnvironmentSendsTheResolvedUrl) {
    save_environment ("env_eu", { { "base", variable (echo_.url ()) } });
    auto config             = payload ("{{base}}/x");
    config["environmentId"] = "env_eu";

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.requests_seen (), 2);
    EXPECT_EQ (echo_.path (), "/echo/x");
    EXPECT_TRUE (unresolved_warning (*stored).is_null ()) << stored->summary;
}

// The `requestId` half: the linked request's collection chain answers too.
TEST_F (LoadTemplateScopesRunTest, ARawRunNamingARequestReadsItsCollection) {
    save_collection_with_request ({ { "base", variable (echo_.url ()) } });
    auto config         = payload ("{{base}}/c");
    config["requestId"] = "req_1";

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (echo_.path (), "/echo/c");
    EXPECT_TRUE (unresolved_warning (*stored).is_null ()) << stored->summary;
}

// A token-free run naming an environment sends what it always sent. What the
// pass skips for it - the scope read - is not observable on the wire; the
// run's bytes, its count and its clean report are.
TEST_F (LoadTemplateScopesRunTest, ATokenFreeRunNamingAnEnvironmentSendsItsUrlAsWritten) {
    save_environment ("env_eu", { { "base", variable ("https://elsewhere.test") } });
    auto config             = payload (echo_.url () + "/plain?q=1", 3);
    config["environmentId"] = "env_eu";

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.requests_seen (), 3);
    EXPECT_EQ (echo_.target (), "/echo/plain?q=1");
    EXPECT_TRUE (unresolved_warning (*stored).is_null ()) << stored->summary;
}

// The bind's tokens survive the start-of-run pass and are bound per
// submission: two iterations, two identities, two generated ids. Mutation
// check: `DynamicResolution::Generate` in `resolve_load_template_tokens`
// freezes `{{$guid}}` into one value both submissions send.
TEST_F (LoadTemplateScopesRunTest, TheBindsTokensAreStillBoundPerSubmission) {
    save_environment ("env_eu", { { "base", variable (echo_.url ()) } });
    auto config             = payload ("{{base}}/i");
    config["environmentId"] = "env_eu";
    config["headers"] =
    json::array ({ json{ { "name", "X-Iteration" }, { "value", "{{$iteration}}" } },
    json{ { "name", "X-Guid" }, { "value", "{{$guid}}" } } });

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (echo_.path (), "/echo/i");
    auto iterations = echo_.header_per_request ("X-Iteration");
    std::sort (iterations.begin (), iterations.end ());
    EXPECT_EQ (iterations, (std::vector<std::string>{ "0", "1" }));
    const auto guids = echo_.header_per_request ("X-Guid");
    ASSERT_EQ (guids.size (), 2u);
    EXPECT_NE (guids[0], guids[1]) << "one id per submission, not one per run";
    EXPECT_EQ (guids[0].find ("{{"), std::string::npos) << guids[0];
    EXPECT_TRUE (unresolved_warning (*stored).is_null ()) << stored->summary;
}

// An `environmentId` naming nothing is an empty environment, as on
// `POST /execute`: the run is not failed, and what nothing answered is reported.
TEST_F (LoadTemplateScopesRunTest, AMissingEnvironmentDoesNotFailTheRun) {
    auto config             = payload (echo_.url () + "/x?r={{region}}");
    config["environmentId"] = "env_missing";

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.requests_seen (), 2);
    const auto warning = unresolved_warning (*stored);
    ASSERT_FALSE (warning.is_null ()) << stored->summary;
    EXPECT_TRUE (names (warning, "region")) << warning.dump ();
}

// A name neither scope defines is still reported by name, and only it: the
// warning is scanned after the pass, so `base` is not among the names.
TEST_F (LoadTemplateScopesRunTest, ANameNoScopeDefinesIsStillReported) {
    save_environment ("env_eu", { { "base", variable (echo_.url ()) } });
    auto config             = payload ("{{base}}/x?q={{nowhere}}");
    config["environmentId"] = "env_eu";

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (echo_.path (), "/echo/x");
    const auto warning = unresolved_warning (*stored);
    ASSERT_FALSE (warning.is_null ()) << stored->summary;
    EXPECT_TRUE (names (warning, "nowhere")) << warning.dump ();
    EXPECT_FALSE (names (warning, "base")) << warning.dump ();
}

// The pass runs before `script.setup`, so without `requestElements` a setup
// write still never reaches the request, as documented: the stored value is
// what is sent.
TEST_F (LoadTemplateScopesRunTest, ASetupWriteIsNotSeenWithoutRequestElements) {
    save_environment ("env_eu", { { "base", variable (echo_.url () + "/stored") } });
    auto config                 = payload ("{{base}}/x");
    config["environmentId"]     = "env_eu";
    config["lifecycleElements"] = setup_writing_base ();

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.path (), "/echo/stored/x");
}

// A run whose submissions are copied keeps its per-submission pass, which
// reads what `script.setup` wrote: the start-of-run pass must not answer the
// name first from the stored value. Mutation check: drop the
// `submissions_run_the_residual_pass` skip in
// `resolve_template_against_stored_scopes` and this sends `/echo/stored/x`.
TEST_F (LoadTemplateScopesRunTest, ARunDeclaringRequestElementsKeepsItsPerSubmissionPass) {
    save_environment ("env_eu", { { "base", variable (echo_.url () + "/stored") } });
    auto config                 = payload ("{{base}}/x");
    config["environmentId"]     = "env_eu";
    config["lifecycleElements"] = setup_writing_base ();
    // An inline `script.pre` is a `step.before` kind, which is what puts every
    // submission on the path that runs the residual pass.
    config["requestElements"] = json::array (
    { json{ { "id", "el_pre" }, { "kind", "script.pre" }, { "enabled", true },
    { "config", { { "script", "pm.variables.set('touched', '1');" }, { "inline", true } } } } });

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.path (), "/echo/setup/x");
}

// #3288: a run whose `requestElements` only read the response sends the shared
// request and runs no per-submission pass, so the start-of-run pass is the only
// thing that can answer `{{base}}`. Mutation check: skip the pass whenever
// `step_elements` is non-empty, as before #3288, and the URL goes out as
// `{{base}}/x` - nothing reaches the echo server and the warning names `base`.
TEST_F (LoadTemplateScopesRunTest, AResponseReadingRequestElementsRunSendsTheResolvedUrl) {
    save_environment ("env_eu", { { "base", variable (echo_.url ()) } });
    auto config               = payload ("{{base}}/x");
    config["environmentId"]   = "env_eu";
    config["requestElements"] = response_reading_elements ();

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.requests_seen (), 2);
    EXPECT_EQ (echo_.path (), "/echo/x");
    EXPECT_TRUE (unresolved_warning (*stored).is_null ()) << stored->summary;
}

// The token-free half of the same run shape sends what it always sent. As for a
// run without `requestElements`, the scope read the pass skips is not
// observable on the wire; the run's bytes, its count and its clean report are.
TEST_F (LoadTemplateScopesRunTest, ATokenFreeResponseReadingRunSendsItsUrlAsWritten) {
    save_environment ("env_eu", { { "base", variable ("https://elsewhere.test") } });
    auto config               = payload (echo_.url () + "/plain?q=1", 3);
    config["environmentId"]   = "env_eu";
    config["requestElements"] = response_reading_elements ();

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.requests_seen (), 3);
    EXPECT_EQ (echo_.target (), "/echo/plain?q=1");
    EXPECT_TRUE (unresolved_warning (*stored).is_null ()) << stored->summary;
}

// Each reason other than a `step.before` kind that copies every submission
// keeps the per-submission pass, and with it the setup write, on a run whose
// `requestElements` only read the response: a bind token, data rows, and a
// credential waiting on the scripts. Mutation check: skip the start-of-run
// pass on `step_elements_have_step_before` alone and each sends
// `/echo/stored/...`.
TEST_F (LoadTemplateScopesRunTest, ABindTokenRunKeepsTheSetupWrite) {
    save_environment ("env_eu", { { "base", variable (echo_.url () + "/stored") } });
    auto config                 = payload ("{{base}}/x?vu={{$vu}}");
    config["environmentId"]     = "env_eu";
    config["lifecycleElements"] = setup_writing_base ();
    config["requestElements"]   = response_reading_elements ();

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.path (), "/echo/setup/x");
}

TEST_F (LoadTemplateScopesRunTest, ADataRowRunKeepsTheSetupWrite) {
    save_environment ("env_eu", { { "base", variable (echo_.url () + "/stored") } });
    auto config                 = payload ("{{base}}/x");
    config["environmentId"]     = "env_eu";
    config["data"]              = json::array ({ json{ { "id", "a" } } });
    config["lifecycleElements"] = setup_writing_base ();
    config["requestElements"]   = response_reading_elements ();

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.path (), "/echo/setup/x");
}

// The credential itself is applied after each submission's residual pass,
// so it reads the setup write too, rather than being resolved at start from
// the stored value (#3288). Mutation check: drop the `after_scripts` term of
// `credentials_resolve_at_start` and both submissions send `Bearer t-stored`.
TEST_F (LoadTemplateScopesRunTest, ACredentialWaitingOnTheScriptsKeepsTheSetupWrite) {
    save_environment ("env_eu",
    { { "base", variable (echo_.url () + "/stored") }, { "token", variable ("t-stored") } });
    auto config             = payload ("{{base}}/x");
    config["environmentId"] = "env_eu";
    config["auth"] = { { "mode", "bearer" }, { "token", "{{token}}" } };
    config["lifecycleElements"] = json::array (
    { json{ { "id", "el_setup" }, { "kind", "script.setup" }, { "enabled", true },
    { "config",
    { { "script",
    "pm.environment.set('base', '" + echo_.url () +
    "/setup'); pm.environment.set('token', 't-setup');" } } } } });
    config["requestElements"] = response_reading_elements ();

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.path (), "/echo/setup/x");
    EXPECT_EQ (echo_.header_per_request ("Authorization"),
    (std::vector<std::string>{ "Bearer t-setup", "Bearer t-setup" }));
}

// #3288: a basic pair is base64-encoded when it is applied, so a name in it has
// to be answered first. The build holds the credentials back and the
// start-of-run pass resolves and applies them once, to the shared request.
// Mutation check: build with `load_auth.auth_resolution ()` alone in
// `build_load_request`, applying the auth before the pass, and both
// submissions carry the base64 of `{{user}}:{{pass}}`.
TEST_F (LoadTemplateScopesRunTest, ABasicPairNamingStoredVariablesIsEncodedResolved) {
    save_environment (
    "env_eu", { { "user", variable ("ada") }, { "pass", variable ("pw") } });
    auto config             = payload (echo_.url () + "/b");
    config["environmentId"] = "env_eu";
    config["auth"]          = { { "mode", "basic" }, { "username", "{{user}}" },
        { "password", "{{pass}}" } };

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    const auto expected = "Basic " + vayu::utils::base64_encode ("ada:pw");
    EXPECT_EQ (echo_.header_per_request ("Authorization"),
    (std::vector<std::string>{ expected, expected }));
    EXPECT_TRUE (unresolved_warning (*stored).is_null ()) << stored->summary;
}

// A query-placed api key went out resolved before #3288 too: the build wrote
// `{{key}}` into the URL, braces unencoded, and the template pass answered it
// there. It is now applied once, after that pass. Mutation check: build with
// `load_auth.auth_resolution ()` alone in `build_load_request` and the key is
// written twice, `?api_key=k-1&api_key=k-1`.
TEST_F (LoadTemplateScopesRunTest, AQueryApiKeyNamingAStoredVariableIsSentResolved) {
    save_environment ("env_eu", { { "key", variable ("k-1") } });
    auto config             = payload (echo_.url () + "/q");
    config["environmentId"] = "env_eu";
    config["auth"]          = { { "mode", "apikey" }, { "key", "api_key" },
        { "value", "{{key}}" }, { "in", "query" } };

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.requests_seen (), 2);
    EXPECT_EQ (echo_.target (), "/echo/q?api_key=k-1");
}

// A bearer token went out resolved before #3288, through its header line; it
// still does, now applied by the same start-of-run step as the rest.
TEST_F (LoadTemplateScopesRunTest, ABearerTokenNamingAStoredVariableIsStillSentResolved) {
    save_environment ("env_eu", { { "token", variable ("t-1") } });
    auto config             = payload (echo_.url () + "/t");
    config["environmentId"] = "env_eu";
    config["auth"] = { { "mode", "bearer" }, { "token", "{{token}}" } };

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (echo_.header_per_request ("Authorization"),
    (std::vector<std::string>{ "Bearer t-1", "Bearer t-1" }));
}

// A credential holding no token is applied by the build, as it always was: the
// run naming an environment changes nothing about it.
TEST_F (LoadTemplateScopesRunTest, ATokenFreeCredentialIsAppliedByTheBuild) {
    save_environment ("env_eu", { { "user", variable ("someone-else") } });
    auto config             = payload (echo_.url () + "/s", 3);
    config["environmentId"] = "env_eu";
    config["auth"] = { { "mode", "basic" }, { "username", "ada" }, { "password", "pw" } };

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    EXPECT_EQ (echo_.requests_seen (), 3);
    const auto expected = "Basic " + vayu::utils::base64_encode ("ada:pw");
    EXPECT_EQ (echo_.header ("Authorization"), expected);
    EXPECT_TRUE (unresolved_warning (*stored).is_null ()) << stored->summary;
}

// A pair holding a name the stored scopes answer beside a token the bind owns,
// in one field and in the other, is still bound per submission, with the
// stored names answered first. Mutation check: skip re-splitting
// `load_auth.credentials` after the pass and the bind writes the username it
// split before, `{{prefix}}` included.
TEST_F (LoadTemplateScopesRunTest, ACredentialAlsoHoldingABindTokenIsBoundWithTheStoredValue) {
    save_environment (
    "env_eu", { { "prefix", variable ("u") }, { "pass", variable ("pw") } });
    auto config             = payload (echo_.url () + "/m");
    config["environmentId"] = "env_eu";
    config["auth"]          = { { "mode", "basic" },
        { "username", "{{prefix}}-{{$iteration}}" }, { "password", "{{pass}}" } };

    const auto stored = run (config);

    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed);
    auto sent = echo_.header_per_request ("Authorization");
    std::vector<std::string> expected{ "Basic " + vayu::utils::base64_encode ("u-0:pw"),
        "Basic " + vayu::utils::base64_encode ("u-1:pw") };
    std::sort (sent.begin (), sent.end ());
    std::sort (expected.begin (), expected.end ());
    EXPECT_EQ (sent, expected);
}

} // namespace
