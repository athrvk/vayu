/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/execute_result_handle_test.cpp
 * @brief The handle a buffered `POST /execute` answers with, and the route it
 *        opens (#3704).
 *
 * A recorded send answers `runId` and `resultId`, the stored row
 * `GET /runs/:runId/results/:resultId` reads back whole; a transient send
 * answers neither. Driven through the real handlers on one server, because the
 * keys are written by the route and the route's pattern is what decides which
 * ids reach the core. The core's own cases are runs_route_test.cpp's.
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`; `url_scheme_test.cpp`
// carries the same guard for the same reason.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <memory>
#include <string>
#include <thread>
#include <utility>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "step_elements_test_helper.hpp"
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

class ExecuteResultHandleTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_execute_result_handle.db";

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
        vayu::http::routes::register_run_routes (*ctx_);
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

    /// The `/execute` answer for @p payload, which must be a 200.
    json execute (const json& payload) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post ("/execute", payload.dump (), "application/json");
        if (!response) {
            ADD_FAILURE () << "POST /execute did not answer";
            return json::object ();
        }
        EXPECT_EQ (response->status, 200) << "body: '" << response->body << "'";
        return json::parse (response->body, nullptr, false);
    }

    /// `{status, body}` of a GET of @p path; a body that is not JSON (no
    /// route matched) reads as a discarded value.
    std::pair<int, json> get (const std::string& path) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Get (path);
        if (!response) {
            ADD_FAILURE () << "GET " << path << " did not answer";
            return { 0, json::object () };
        }
        return { response->status, json::parse (response->body, nullptr, false) };
    }

    /// The path the handle in @p answer names.
    static std::string result_path (const json& answer) {
        return "/runs/" + answer.value ("runId", "") + "/results/" +
        std::to_string (answer.value ("resultId", 0));
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

// Mutation check: drop `add_result_handle` from `run_buffered_execution` and
// the answer carries neither key.
TEST_F (ExecuteResultHandleTest, ARecordedSendAnswersTheHandleOfItsStoredResult) {
    const vayu::tests::EchoServer echo;
    const json answer = execute ({ { "method", "GET" }, { "url", echo.url () } });

    ASSERT_TRUE (answer.contains ("runId")) << answer.dump ();
    ASSERT_TRUE (answer.contains ("resultId")) << answer.dump ();
    const std::string run_id = answer.at ("runId").get<std::string> ();
    const auto results       = db_->get_results (run_id);
    ASSERT_EQ (results.size (), 1u);
    EXPECT_EQ (answer.at ("resultId").get<int> (), results.front ().id);
}

// A transient send stores nothing, so it has nothing to name: no key at all,
// never a zero or an empty string.
TEST_F (ExecuteResultHandleTest, ATransientSendAnswersNoHandle) {
    const vayu::tests::EchoServer echo;
    const json answer =
    execute ({ { "method", "GET" }, { "url", echo.url () }, { "transient", true } });

    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_FALSE (answer.contains ("runId")) << answer.dump ();
    EXPECT_FALSE (answer.contains ("resultId")) << answer.dump ();
    EXPECT_TRUE (db_->get_all_runs ().empty ());
}

// A build that failed once the run row exists is recorded too, so its answer
// names the row as well. The token endpoint is refused by the caller's policy
// before anything is dialled.
TEST_F (ExecuteResultHandleTest, ARecordedFailedBuildAnswersTheHandleOfItsStoredResult) {
    const json answer = execute ({ { "method", "GET" }, { "url", "http://127.0.0.1:1/x" },
    { "auth",
    { { "mode", "oauth2" },
    { "config",
    { { "grantType", "client_credentials" },
    { "accessTokenUrl", "http://localhost:1/token" }, { "clientId", "cid" },
    { "clientSecret", "secret" }, { "credentialsPlacement", "body" } } } } },
    { "targetPolicy",
    { { "allowAll", false }, { "allowedHosts", json::array ({ "127.0.0.1" }) } } } });

    EXPECT_EQ (answer.value ("refusalCode", ""), "target_not_allowed") << answer.dump ();
    ASSERT_TRUE (answer.contains ("runId")) << answer.dump ();
    const auto results = db_->get_results (answer.at ("runId").get<std::string> ());
    ASSERT_EQ (results.size (), 1u);
    EXPECT_EQ (answer.value ("resultId", 0), results.front ().id);
}

// The handle opens the stored exchange, script requests included, in the shape
// the report's `results[]` entry has.
TEST_F (ExecuteResultHandleTest, TheHandleReadsBackTheStoredResult) {
    const vayu::tests::EchoServer echo;
    const json answer = execute (
    { { "method", "GET" }, { "url", echo.url () }, { "allowScriptRequests", true },
    { "elements",
    json::array ({ vayu::tests::script_element_json ("el_pre", "script.pre",
    "pm.sendRequest('" + echo.url () + "/side', function () {});") }) } });
    ASSERT_TRUE (answer.contains ("resultId")) << answer.dump ();

    const auto [status, node] = get (result_path (answer));

    ASSERT_EQ (status, 200) << node.dump ();
    EXPECT_EQ (node.value ("id", 0), answer.value ("resultId", -1));
    EXPECT_EQ (node.value ("statusCode", 0), 200) << node.dump ();
    const auto& trace = node.at ("trace");
    EXPECT_EQ (trace.at ("request").value ("url", ""), echo.url ()) << trace.dump ();
    const auto records =
    trace.value (json::json_pointer ("/scripts/scriptRequests"), json::array ());
    ASSERT_EQ (records.size (), 1u) << trace.dump ();
    EXPECT_EQ (records.at (0).at ("request").value ("url", ""), echo.url () + "/side");

    const auto [report_status, report] =
    get ("/runs/" + answer.value ("runId", "") + "/report");
    ASSERT_EQ (report_status, 200);
    ASSERT_EQ (report.at ("results").size (), 1u);
    EXPECT_EQ (node, report.at ("results").at (0));
}

// The pattern takes digits only, and an id past `int` is unknown rather than
// a 400 or a wrapped number naming some other row.
TEST_F (ExecuteResultHandleTest, AResultIdThatIsNotAStoredRowIsNotFound) {
    const vayu::tests::EchoServer echo;
    const json answer = execute ({ { "method", "GET" }, { "url", echo.url () } });
    const std::string run_path = "/runs/" + answer.value ("runId", "");

    const auto [overflow_status, overflow] =
    get (run_path + "/results/99999999999999999999");
    EXPECT_EQ (overflow_status, 404) << overflow.dump ();
    EXPECT_EQ (overflow.value (json::json_pointer ("/error/message"), std::string ()),
    "Result not found");

    const auto [word_status, word] = get (run_path + "/results/first");
    EXPECT_EQ (word_status, 404);

    const auto [unknown_run_status, unknown_run] = get (
    "/runs/no_such_run/results/" + std::to_string (answer.value ("resultId", 0)));
    EXPECT_EQ (unknown_run_status, 404);
    EXPECT_EQ (unknown_run.value (json::json_pointer ("/error/message"), std::string ()),
    "Run not found");
}

} // namespace
