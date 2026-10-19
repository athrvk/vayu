/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/execute_auth_provenance_test.cpp
 * @brief The live `POST /execute` answer carries which parts of the request
 *        auth wrote (#1845), the twin of the stored trace's
 *        `request.authQueryParam` / `request.authHeaders`
 *        (`execution_trace_test.cpp`, #1835), and `authNotice` when the auth
 *        mode was not executed at all (#2474).
 *
 * A reader that masks the answer (the MCP server's `run_request`) cannot tell
 * an engine-placed credential from any other query parameter by looking at
 * `rawRequest`; the names are what it masks by. Driven through the real
 * handler, because the write is a line in the route and no seam below it sees
 * the live body.
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

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "echo_server.hpp"
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

constexpr const char* TOKEN = "live-token-5d1e";

class ExecuteAuthProvenanceTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_execute_auth_provenance.db";

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

    /// The `/execute` answer for a GET to @p echo carrying @p auth.
    json execute (const vayu::tests::EchoServer& echo, const json& auth) const {
        json payload{ { "method", "GET" }, { "url", echo.url () } };
        if (!auth.is_null ()) {
            payload["auth"] = auth;
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

    /// The stored trace of the one result this test's one send wrote.
    json stored_trace () const {
        const auto runs = db_->get_all_runs ();
        if (runs.size () != 1) {
            ADD_FAILURE () << "expected one run, found " << runs.size ();
            return json::object ();
        }
        const auto results = db_->get_results (runs.front ().id);
        if (results.size () != 1) {
            ADD_FAILURE () << "expected one result, found " << results.size ();
            return json::object ();
        }
        return json::parse (results.front ().trace_data, nullptr, false);
    }

    /// Send with an auth block in @p mode, which Vayu stores but does not
    /// execute, and expect it on the wire bare and named in both records.
    void expect_sent_without_auth (const std::string& mode) const {
        const vayu::tests::EchoServer echo;
        const auto answer = execute (echo,
        { { "mode", mode }, { "username", "user" }, { "password", "pass" } });

        EXPECT_FALSE (echo.has_header ("Authorization"));
        const std::string notice = answer.value ("authNotice", "");
        EXPECT_NE (notice.find ("'" + mode + "'"), std::string::npos) << answer.dump ();
        const json trace = stored_trace ();
        ASSERT_TRUE (trace.contains ("request")) << trace.dump ();
        EXPECT_EQ (trace.at ("request").value ("authNotice", ""), notice);
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

TEST_F (ExecuteAuthProvenanceTest, AQueryPlacedApiKeyNamesItsParameter) {
    const vayu::tests::EchoServer echo;
    const auto answer = execute (echo,
    { { "mode", "apikey" }, { "key", "access_token" }, { "value", TOKEN }, { "in", "query" } });

    // The credential really was on the wire and in the live record: the name
    // is what lets a reader find it, not a stand-in for a value that was absent.
    EXPECT_NE (echo.target ().find (std::string ("access_token=") + TOKEN),
    std::string::npos);
    EXPECT_NE (answer.value ("rawRequest", "").find (TOKEN), std::string::npos)
    << answer.dump ();

    EXPECT_EQ (answer.value ("authQueryParam", ""), "access_token") << answer.dump ();
    EXPECT_FALSE (answer.contains ("authHeaders")) << answer.dump ();
}

TEST_F (ExecuteAuthProvenanceTest, AHeaderPlacedApiKeyNamesItsHeader) {
    const vayu::tests::EchoServer echo;
    const auto answer = execute (echo,
    { { "mode", "apikey" }, { "key", "X-Api-Key" }, { "value", TOKEN }, { "in", "header" } });

    EXPECT_EQ (answer.value ("authHeaders", json::array ()), (json::array ({ "X-Api-Key" })))
    << answer.dump ();
    EXPECT_FALSE (answer.contains ("authQueryParam")) << answer.dump ();
}

// Omitted, never answered empty: absent is what "auth wrote nothing" means to a
// reader, and the same key means the same on a trace stored before the field.
TEST_F (ExecuteAuthProvenanceTest, ASendWithNoAuthAnswersNeitherKey) {
    const vayu::tests::EchoServer echo;
    const auto answer = execute (echo, nullptr);

    ASSERT_TRUE (answer.contains ("rawRequest")) << answer.dump ();
    EXPECT_FALSE (answer.contains ("authQueryParam")) << answer.dump ();
    EXPECT_FALSE (answer.contains ("authHeaders")) << answer.dump ();
    EXPECT_FALSE (answer.contains ("authNotice")) << answer.dump ();
}

// A bearer token is a header auth wrote, but not one `apply_auth` names: the
// reader masks `Authorization` by its own rule, so nothing is recorded.
TEST_F (ExecuteAuthProvenanceTest, ABearerTokenRecordsNoProvenance) {
    const vayu::tests::EchoServer echo;
    const auto answer = execute (echo, { { "mode", "bearer" }, { "token", TOKEN } });

    EXPECT_FALSE (answer.contains ("authQueryParam")) << answer.dump ();
    EXPECT_FALSE (answer.contains ("authHeaders")) << answer.dump ();
    EXPECT_FALSE (answer.contains ("authNotice")) << answer.dump ();
    const json trace = stored_trace ();
    ASSERT_TRUE (trace.contains ("request")) << trace.dump ();
    EXPECT_FALSE (trace.at ("request").contains ("authNotice")) << trace.dump ();
}

// #2474: a mode Vayu does not execute is sent without auth, and both the live
// answer and the stored trace say so. Mutation checks: drop the `auth_notice`
// assignment in `apply_auth`, or the `authNotice` write in
// `record_auth_provenance`, and these red.
TEST_F (ExecuteAuthProvenanceTest, AnNtlmSendSaysItWentWithoutAuth) {
    expect_sent_without_auth ("ntlm");
}

TEST_F (ExecuteAuthProvenanceTest, ADigestSendSaysItWentWithoutAuth) {
    expect_sent_without_auth ("digest");
}

} // namespace
