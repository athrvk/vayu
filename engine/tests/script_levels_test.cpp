/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/script_levels_test.cpp
 * @brief A step's scripts run at every level and every level is reported
 *        (#2522): `script.pre` / `script.post` fold into the step's result
 *        instead of assigning over it.
 *
 * The first half drives `ElementPipeline::run` over elements compiled from a
 * composed-shaped array (each stamped with an `origin`), with script runners
 * that answer canned results, so what is asserted is the fold alone. The
 * second half is Send parity: a stored request under a collection whose own
 * test fails, composed by id and sent through the real `POST /execute`.
 * The collection-run half (step outcomes and stored traces) is in
 * `scenario_runner_test.cpp`.
 *
 * Mutation check: assign the runner's result to the slot in
 * `script_kinds.cpp`'s `run_step_script` instead of folding it, and every
 * `ScriptLevelFold` case below fails.
 */

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <map>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "temp_database.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/types.hpp"

namespace {

using nlohmann::json;
using vayu::core::CompiledElement;
using vayu::core::ElementContext;
using vayu::core::ElementOutcome;
using vayu::core::ElementPipeline;
using vayu::core::Phase;

json origin_of (const std::string& scope) {
    if (scope == "request") {
        return { { "kind", "request" }, { "scope", "request" }, { "id", "req_1" } };
    }
    return { { "kind", "collection" }, { "scope", scope }, { "id", "col_" + scope } };
}

json script_element (const std::string& kind, const std::string& script, const std::string& scope) {
    return { { "id", "el_" + script }, { "kind", kind },
        { "config", { { "script", script } } }, { "origin", origin_of (scope) } };
}

vayu::TestResult test_named (const std::string& name, bool passed) {
    vayu::TestResult test;
    test.name   = name;
    test.passed = passed;
    if (!passed) {
        test.error_message = "expected 1 to deeply equal 2";
    }
    return test;
}

/// A script that ran its `pm.test`s: `success` is false when one failed, and
/// the message stays empty because nothing threw.
vayu::ScriptResult asserted (const std::string& name, bool passed) {
    vayu::ScriptResult result;
    result.tests.push_back (test_named (name, passed));
    result.success = passed;
    result.console_output.push_back ({ vayu::ConsoleLevel::Log, "ran " + name });
    return result;
}

vayu::ScriptResult threw (const std::string& message) {
    vayu::ScriptResult result;
    result.success       = false;
    result.error_message = message;
    return result;
}

class ScriptLevelFold : public ::testing::Test {
    protected:
    vayu::Request request;
    vayu::Response response;
    vayu::ScriptResult pre;
    vayu::ScriptResult post;
    /// What each script text answers when an element runs it.
    std::map<std::string, vayu::ScriptResult> answers;

    void SetUp () override {
        response.status_code = 200;
        response.body        = "{}";
    }

    std::vector<ElementOutcome> run (Phase phase, const json& elements) {
        const auto compiled = vayu::core::compile_elements (elements);
        const auto answer   = [this] (const std::string& script) {
            return answers.at (script);
        };
        ElementContext ctx{
            .request         = request,
            .response        = phase == Phase::StepAfter ? &response : nullptr,
            .run_pre_script  = answer,
            .run_post_script = answer,
            .pre_script_result  = pre,
            .post_script_result = post,
            .set_variable       = {},
            .should_stop        = {},
            .record_metric      = {},
        };
        std::vector<ElementOutcome> sink;
        ElementPipeline::run (phase, ctx, compiled, sink);
        return sink;
    }
};

// Probe XA of #2522: the collection's failing test used to be overwritten by
// the request's passing one, and the step passed.
TEST_F (ScriptLevelFold, EveryLevelsTestsAreKeptWithTheirScope) {
    answers["collection_post"] = asserted ("collection must fail", false);
    answers["request_post"]    = asserted ("request passes", true);

    run (Phase::StepAfter,
    json::array ({ script_element ("script.post", "collection_post", "collection"),
    script_element ("script.post", "request_post", "request") }));

    ASSERT_EQ (post.tests.size (), 2u);
    EXPECT_EQ (post.tests[0].name, "collection must fail");
    EXPECT_EQ (post.tests[0].scope, "collection");
    EXPECT_FALSE (post.tests[0].passed);
    EXPECT_EQ (post.tests[1].name, "request passes");
    EXPECT_EQ (post.tests[1].scope, "request");
    EXPECT_FALSE (post.success) << "a failed test at any level fails the phase";
    EXPECT_TRUE (post.error_message.empty ())
    << "a failed assertion is not a thrown script";

    ASSERT_EQ (post.console_output.size (), 2u);
    EXPECT_EQ (post.console_output[0].scope, "collection");
    EXPECT_EQ (post.console_output[1].scope, "request");
}

// Probe XB: a throwing collection pre-request survives the request's own
// succeeding one, and the slot says which level threw.
TEST_F (ScriptLevelFold, TheFirstLevelThatThrewIsTheError) {
    answers["collection_pre"] = threw ("XB COLLECTION PRE THROWS");
    answers["folder_pre"]     = threw ("a later throw is not the first");
    answers["request_pre"]    = vayu::ScriptResult{};

    const auto outcomes = run (Phase::StepBefore,
    json::array ({ script_element ("script.pre", "collection_pre", "collection"),
    script_element ("script.pre", "folder_pre", "folder"),
    script_element ("script.pre", "request_pre", "request") }));

    EXPECT_FALSE (pre.success);
    EXPECT_EQ (pre.error_message, "XB COLLECTION PRE THROWS");
    EXPECT_EQ (pre.error_scope, "collection");
    // Each element's own outcome is still about its own script.
    ASSERT_EQ (outcomes.size (), 3u);
    EXPECT_EQ (outcomes[0].status, "error");
    EXPECT_EQ (outcomes[0].message.value_or (""), "XB COLLECTION PRE THROWS");
    EXPECT_EQ (outcomes[1].message.value_or (""), "a later throw is not the first");
    EXPECT_EQ (outcomes[2].status, "ok");
}

// A declarative assertion runs before a later level's script and writes the
// same list; the script's result used to replace it.
TEST_F (ScriptLevelFold, AnEarlierAssertionSurvivesALaterScript) {
    answers["request_post"] = asserted ("request passes", true);
    json status_assert = { { "id", "el_status" }, { "kind", "assert.status" },
        { "config", { { "in", json::array ({ 500 }) } } },
        { "origin", origin_of ("collection") } };

    run (Phase::StepAfter,
    json::array ({ status_assert, script_element ("script.post", "request_post", "request") }));

    ASSERT_EQ (post.tests.size (), 2u);
    EXPECT_FALSE (post.tests[0].passed) << "the 500 assertion against a 200";
    EXPECT_EQ (post.tests[0].scope, "collection");
    EXPECT_EQ (post.tests[1].name, "request passes");
}

// A controller's skip at an outer level is not cancelled by a script that
// asked for nothing; a later script's own instruction does replace it (below).
TEST_F (ScriptLevelFold, AnEarlierSkipSurvivesALaterScriptThatAskedForNothing) {
    answers["request_pre"] = vayu::ScriptResult{};
    json skip_unless_gold  = { { "id", "el_if" }, { "kind", "control.if" },
         { "config", { { "condition", "{{tier}} == gold" } } },
         { "origin", origin_of ("collection") } };

    run (Phase::StepBefore,
    json::array (
    { skip_unless_gold, script_element ("script.pre", "request_pre", "request") }));

    EXPECT_EQ (pre.control.kind, vayu::ScriptControl::Kind::Skip);
}

TEST_F (ScriptLevelFold, ALaterInstructionReplacesAnEarlierOne) {
    vayu::ScriptResult collection_jumps;
    collection_jumps.control.kind   = vayu::ScriptControl::Kind::Next;
    collection_jumps.control.target = "Login";
    vayu::ScriptResult request_jumps;
    request_jumps.control.kind   = vayu::ScriptControl::Kind::Next;
    request_jumps.control.target = "Checkout";
    answers["collection_pre"]    = collection_jumps;
    answers["request_pre"]       = request_jumps;

    run (Phase::StepBefore,
    json::array ({ script_element ("script.pre", "collection_pre", "collection"),
    script_element ("script.pre", "request_pre", "request") }));

    EXPECT_EQ (pre.control.kind, vayu::ScriptControl::Kind::Next);
    EXPECT_EQ (pre.control.target, "Checkout");
}

TEST_F (ScriptLevelFold, AFolderLevelResultIsScopedFolder) {
    answers["folder_post"] = asserted ("folder status < 500", true);

    run (Phase::StepAfter,
    json::array ({ script_element ("script.post", "folder_post", "folder") }));

    ASSERT_EQ (post.tests.size (), 1u);
    EXPECT_EQ (post.tests[0].scope, "folder");
}

// An origin stamped without `scope` (a client that composes elements itself)
// is read by its `kind`; one naming no level leaves the result unscoped.
TEST_F (ScriptLevelFold, AnOriginWithoutScopeFallsBackToItsKind) {
    answers["a"]         = asserted ("from a collection", true);
    answers["b"]         = asserted ("from nowhere", true);
    json from_collection = script_element ("script.post", "a", "collection");
    from_collection["origin"].erase ("scope");
    json unstamped = script_element ("script.post", "b", "request");
    unstamped.erase ("origin");

    run (Phase::StepAfter, json::array ({ from_collection, unstamped }));

    ASSERT_EQ (post.tests.size (), 2u);
    EXPECT_EQ (post.tests[0].scope, "collection");
    EXPECT_TRUE (post.tests[1].scope.empty ());
}

// ============================================================================
// Send parity: `POST /execute` runs the same elements and reports the same
// levels a collection run does.
// ============================================================================

class ScriptLevelSend : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_script_levels.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        manager_ = std::make_unique<vayu::http::SseStreamManager> ();
        ctx_     = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, nullptr,
        authorize_manager_, cookie_jar_, mock_issuer_manager_, inbox_manager_,
        mock_server_manager_, *manager_, run_summary_cache_ });
        vayu::http::routes::register_execution_routes (*ctx_);
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    void TearDown () override {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
        run_manager_.shutdown ();
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    void seed_collection (const std::string& id, const std::string& parent_id, const json& elements) {
        vayu::db::Collection col;
        col.id   = id;
        col.name = "Collection " + id;
        if (!parent_id.empty ()) {
            col.parent_id = parent_id;
        }
        col.elements   = elements.dump ();
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    void seed_request (const std::string& collection_id, const std::string& url, const json& elements) {
        vayu::db::Request r;
        r.id            = "req_1";
        r.collection_id = collection_id;
        r.name          = "Request";
        r.method        = vayu::HttpMethod::GET;
        r.url           = url;
        r.elements      = elements.dump ();
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    /// The request composed by id, as the app and MCP compose it, then sent.
    json compose_and_send () const {
        const auto [compose_status, payload] =
        vayu::http::compose_request_core (*db_, json{ { "requestId", "req_1" } });
        if (compose_status != 200) {
            ADD_FAILURE ()
            << "compose answered " << compose_status << ": " << payload.dump ();
            return json::object ();
        }
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post ("/execute", payload.dump (), "application/json");
        if (!response || response->status != 200) {
            ADD_FAILURE () << "POST /execute did not answer 200";
            return json::object ();
        }
        return json::parse (response->body, nullptr, false);
    }

    static json
    script (const std::string& kind, const std::string& id, const std::string& text) {
        return { { "id", id }, { "kind", kind }, { "config", { { "script", text } } } };
    }

    std::unique_ptr<vayu::db::Database> db_;
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    vayu::core::RunManager run_manager_;
    vayu::http::OAuth2AuthorizeManager authorize_manager_;
    vayu::http::CookieJar cookie_jar_;
    vayu::http::MockIssuerManager mock_issuer_manager_;
    vayu::http::InboxManager inbox_manager_;
    vayu::http::MockServerManager mock_server_manager_;
    vayu::http::RunSummaryCache run_summary_cache_;
    std::unique_ptr<vayu::http::SseStreamManager> manager_;
    std::unique_ptr<vayu::http::routes::RouteContext> ctx_;
};

TEST_F (ScriptLevelSend, ASendReportsTheCollectionsFailingTestBesideTheRequests) {
    const vayu::tests::EchoServer echo;
    seed_collection ("col_1", "",
    json::array ({ script ("script.post", "el_col",
    "pm.test('collection must fail', () => pm.expect(1).to.eql(2));") }));
    seed_collection ("fold_1", "col_1",
    json::array ({ script ("script.post", "el_fold",
    "pm.test('folder passes', () => pm.expect(1).to.eql(1));") }));
    seed_request ("fold_1", echo.url (),
    json::array ({ script ("script.post", "el_req",
    "pm.test('request passes', () => pm.expect(1).to.eql(1));") }));

    const json answer = compose_and_send ();

    ASSERT_TRUE (answer.contains ("testResults")) << answer.dump ();
    const auto& tests = answer["testResults"];
    ASSERT_EQ (tests.size (), 3u) << tests.dump ();
    EXPECT_EQ (tests[0]["name"], "collection must fail");
    EXPECT_FALSE (tests[0]["passed"].get<bool> ());
    EXPECT_EQ (tests[0]["scope"], "collection");
    EXPECT_EQ (tests[1]["scope"], "folder");
    EXPECT_EQ (tests[2]["name"], "request passes");
    EXPECT_EQ (tests[2]["scope"], "request");
}

TEST_F (ScriptLevelSend, ASendNamesTheLevelWhoseScriptThrew) {
    const vayu::tests::EchoServer echo;
    seed_collection ("col_1", "",
    json::array ({ script ("script.pre", "el_col", "throw new Error('collection pre');") }));
    seed_request ("col_1", echo.url (),
    json::array ({ script ("script.pre", "el_req", "console.log('request pre ran');") }));

    const json answer = compose_and_send ();

    const std::string error = answer.value ("preScriptError", "");
    EXPECT_EQ (error.rfind ("Collection pre-request script failed - ", 0), 0u)
    << answer.dump ();
    EXPECT_NE (error.find ("collection pre"), std::string::npos) << error;
}

} // namespace
