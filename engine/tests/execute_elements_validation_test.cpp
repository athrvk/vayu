/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/execute_elements_validation_test.cpp
 * @brief `POST /execute` refuses the inline `elements` `POST /requests`
 *        refuses, with the same message (#3052).
 *
 * Every refusal is checked for the three things that make it a refusal and not
 * a send: the 400, a message equal to the one `POST /requests` answers for the
 * same list, and nothing behind it - no run row, no outbound request.
 *
 * The list `/execute` takes is a composed one, so the cases that must keep
 * working are as load-bearing as the refusals: a collection-origin
 * `script.setup`, which `ElementOwner::Request` would refuse, and ids repeated
 * across levels.
 *
 * Mutation check: remove the `validate_execute_elements` call in
 * `read_execute_payload` (`execution.cpp`) and every refusal case fails. Treat
 * every entry as a request's (drop the `is_collection_origin` branch) and
 * `ACollectionLevelSetupScriptStillSends` fails.
 */

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/types.hpp"

namespace {

using nlohmann::json;

constexpr const char* COLLECTION_ID = "col_1";

json origin_of (const std::string& kind, const std::string& id) {
    return { { "kind", kind }, { "scope", kind }, { "id", id } };
}

json status_assertion (const std::string& id) {
    return { { "id", id }, { "kind", "assert.status" },
        { "config", { { "in", json::array ({ 500 }) } } } };
}

json setup_script (const std::string& id) {
    return { { "id", id }, { "kind", "script.setup" },
        { "config", { { "script", "console.log('setup');" } } } };
}

json with_origin (json element, const json& origin) {
    element["origin"] = origin;
    return element;
}

class ExecuteElementsValidation : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH =
    "test_execute_elements_validation.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        vayu::db::Collection collection;
        collection.id         = COLLECTION_ID;
        collection.name       = "Collection";
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);

        manager_ = std::make_unique<vayu::http::SseStreamManager> ();
        ctx_     = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, nullptr,
        authorize_manager_, cookie_jar_, mock_issuer_manager_, inbox_manager_,
        mock_server_manager_, *manager_, run_summary_cache_ });
        vayu::http::routes::register_request_routes (*ctx_);
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

    std::pair<int, json> post (const std::string& path, const json& body) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post (path, body.dump (), "application/json");
        if (!response) {
            ADD_FAILURE () << "no response from POST " << path;
            return { 0, json::object () };
        }
        return { response->status, json::parse (response->body, nullptr, false) };
    }

    std::pair<int, json> execute (const json& elements) const {
        json body = { { "method", "GET" }, { "url", echo_.url () } };
        if (!elements.is_discarded ()) {
            body["elements"] = elements;
        }
        return post ("/execute", body);
    }

    /// What `POST /requests` answers for @p elements: the status and message
    /// `/execute` has to match.
    std::pair<int, std::string> create_request_with (const json& elements) const {
        const auto [status, answer] = post ("/requests",
        { { "collectionId", COLLECTION_ID }, { "name", "r" }, { "method", "GET" },
        { "url", "http://x.test/" }, { "elements", elements } });
        return { status,
            status == 200 ? std::string () : vayu::http::routes::error_message_of (answer) };
    }

    void expect_refused_like_post_requests (const json& elements) const {
        SCOPED_TRACE (elements.dump ());
        const auto [stored_status, stored_message] = create_request_with (elements);
        ASSERT_EQ (stored_status, 400) << "the reference must refuse it";
        ASSERT_FALSE (stored_message.empty ());

        const auto [status, answer] = execute (elements);
        EXPECT_EQ (status, 400) << answer.dump ();
        EXPECT_EQ (vayu::http::routes::error_message_of (answer), stored_message);
        EXPECT_TRUE (db_->get_all_runs ().empty ())
        << "a refusal leaves no run row";
        EXPECT_EQ (echo_.requests_seen (), 0) << "a refusal sends nothing";
    }

    std::unique_ptr<vayu::db::Database> db_;
    vayu::tests::EchoServer echo_;
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

TEST_F (ExecuteElementsValidation, AMisspelledKindIsRefused) {
    expect_refused_like_post_requests (json::array ({ { { "id", "el_1" },
    { "kind", "extract.jsno" }, { "config", json::object () } } }));
}

TEST_F (ExecuteElementsValidation, AnUnknownSettingIsRefused) {
    json assertion                     = status_assertion ("el_1");
    assertion["config"]["notASetting"] = true;
    expect_refused_like_post_requests (json::array ({ assertion }));
}

TEST_F (ExecuteElementsValidation, ASettingTheKindDoesNotTakeIsRefused) {
    // `matchNo` is a setting of the other extractors, not of `extract.header`.
    expect_refused_like_post_requests (
    json::array ({ { { "id", "el_1" }, { "kind", "extract.header" },
    { "config", { { "header", "X-Id" }, { "variable", "id" }, { "matchNo", 2 } } } } }));
}

// #3043: each of these would only ever report `error`.
TEST_F (ExecuteElementsValidation, AnAssertionOrExtractorThatCannotRunIsRefused) {
    const std::vector<std::pair<std::string, json>> cannot_run = {
        { "assert.status", json::object () },
        { "assert.jsonpath", { { "path", "$.id" } } },
        { "assert.contains", { { "text", "[" }, { "mode", "matches" } } },
        { "assert.jsonpath", { { "path", "$.id" }, { "regex", "[" } } },
        { "assert.jsonpath", { { "path", "$.id" }, { "exists", false }, { "expected", 1 } } },
        { "extract.regex", { { "pattern", "(" }, { "variable", "v" } } },
    };
    for (const auto& [kind, config] : cannot_run) {
        expect_refused_like_post_requests (json::array (
        { { { "id", "el_1" }, { "kind", kind }, { "config", config } } }));
    }
}

TEST_F (ExecuteElementsValidation, ARepeatedIdIsRefused) {
    expect_refused_like_post_requests (
    json::array ({ status_assertion ("el_1"), status_assertion ("el_1") }));
}

TEST_F (ExecuteElementsValidation, ARunBoundaryScriptOnTheRequestIsRefused) {
    expect_refused_like_post_requests (json::array (
    { with_origin (setup_script ("el_1"), origin_of ("request", "req_1")) }));
    expect_refused_like_post_requests (json::array ({ setup_script ("el_2") }));
}

TEST_F (ExecuteElementsValidation, ABadEntryAtACollectionLevelIsRefused) {
    json bad = with_origin (status_assertion ("el_1"), origin_of ("collection", "col_1"));
    bad["config"]["notASetting"] = true;

    const auto [status, answer] = execute (json::array ({ bad }));

    EXPECT_EQ (status, 400) << answer.dump ();
    EXPECT_FALSE (vayu::http::routes::error_message_of (answer).empty ());
    EXPECT_TRUE (db_->get_all_runs ().empty ());
    EXPECT_EQ (echo_.requests_seen (), 0);
}

TEST_F (ExecuteElementsValidation, ANonArrayIsRefused) {
    expect_refused_like_post_requests (json ("not a list"));
    expect_refused_like_post_requests (json::object ());
}

TEST_F (ExecuteElementsValidation, AnEntryThatIsNotAnObjectIsRefused) {
    expect_refused_like_post_requests (json::array ({ "extract.json" }));
}

TEST_F (ExecuteElementsValidation, AnEntryWithoutAnIdGetsOneAndRuns) {
    json assertion = status_assertion ("unused");
    assertion.erase ("id");

    const auto [status, answer] = execute (json::array ({ assertion }));

    EXPECT_EQ (status, 200) << answer.dump ();
    ASSERT_TRUE (answer.contains ("testResults")) << answer.dump ();
    EXPECT_EQ (answer["testResults"].size (), 1U) << "the assertion ran";
    EXPECT_EQ (echo_.requests_seen (), 1);
}

TEST_F (ExecuteElementsValidation, AbsentAndNullElementsSendAsBefore) {
    const auto [absent_status, absent] = execute (json::value_t::discarded);
    EXPECT_EQ (absent_status, 200) << absent.dump ();
    const auto [null_status, null_answer] = execute (json (nullptr));
    EXPECT_EQ (null_status, 200) << null_answer.dump ();
    EXPECT_EQ (echo_.requests_seen (), 2);
}

// A composed list carries the collection chain's entries beside the request's.
// `script.setup` is allowed there and refused on a request, and a duplicated
// collection repeats its ids on every level.
TEST_F (ExecuteElementsValidation, ACollectionLevelSetupScriptStillSends) {
    const json collection = origin_of ("collection", "col_1");
    const json folder     = origin_of ("collection", "fold_1");
    const json elements = json::array ({ with_origin (setup_script ("el_dup"), collection),
    with_origin (status_assertion ("el_dup"), folder),
    with_origin (status_assertion ("el_req"), origin_of ("request", "req_1")) });

    const auto [status, answer] = execute (elements);

    EXPECT_EQ (status, 200) << answer.dump ();
    ASSERT_TRUE (answer.contains ("testResults")) << answer.dump ();
    EXPECT_EQ (answer["testResults"].size (), 2U)
    << "both assertions ran, setup is not a step's";
    EXPECT_EQ (echo_.requests_seen (), 1);
}

} // namespace
