/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/execute_transport_failure_test.cpp
 * @brief A redirect loop and an undecodable body through the real
 *        `POST /execute` (issue #2462).
 *
 * Both used to answer `CONNECTION_FAILED` ("Couldn't connect") though the
 * server had answered every hop. `http_client_test.cpp` pins the codes at the
 * client; this pins that the route puts them on the wire under the spelling a
 * caller and a script's `pm.response.errorCode` read, with the message the
 * pane shows.
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
#include <string_view>
#include <thread>
#include <utility>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "task_queue.hpp"
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

/// `/loop` redirects to itself; `/bad-gzip` claims an encoding its bytes are
/// not in; `/unsupported-br` names one this libcurl has no decoder for.
class FailingServer {
    public:
    FailingServer () {
        svr_.new_task_queue = vayu::tests::pooled_task_queue (2);
        svr_.Get ("/loop", [] (const httplib::Request&, httplib::Response& res) {
            res.set_redirect ("/loop", 302);
        });
        svr_.Get ("/bad-gzip", [] (const httplib::Request&, httplib::Response& res) {
            res.set_header ("Content-Encoding", "gzip");
            res.set_content ("this is not gzip", "text/plain");
        });
        svr_.Get ("/unsupported-br", [] (const httplib::Request&, httplib::Response& res) {
            res.set_header ("Content-Encoding", "br");
            res.set_content ("this is not brotli either", "text/plain");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~FailingServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    FailingServer (const FailingServer&)            = delete;
    FailingServer& operator= (const FailingServer&) = delete;
    FailingServer (FailingServer&&)                 = delete;
    FailingServer& operator= (FailingServer&&)      = delete;

    std::string url (std::string_view path) const {
        return "http://127.0.0.1:" + std::to_string (port_) + std::string (path);
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
};

class ExecuteTransportFailureTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_execute_transport_failure.db";

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

    /// The `/execute` answer for @p payload, which is a 200 even when the send
    /// failed: a transport failure is reported in the body.
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

// Mutation-check: map CURLE_TOO_MANY_REDIRECTS back to ConnectionFailed and
// errorCode reads CONNECTION_FAILED.
TEST_F (ExecuteTransportFailureTest, ARedirectLoopAnswersTooManyRedirects) {
    const FailingServer server;
    const json answer = execute ({ { "method", "GET" }, { "url", server.url ("/loop") },
    { "followRedirects", true }, { "maxRedirects", 2 } });

    EXPECT_EQ (answer.value ("status", -1), 0) << answer.dump (2);
    EXPECT_EQ (answer.value ("errorCode", ""), "TOO_MANY_REDIRECTS") << answer.dump (2);
    const auto message = answer.value ("errorMessage", std::string ());
    EXPECT_TRUE (message.starts_with (
    "Too many redirects: the server redirected more than 2 times"))
    << message;
}

// Mutation-check: as above for CURLE_BAD_CONTENT_ENCODING.
TEST_F (ExecuteTransportFailureTest, AnUndecodableBodyAnswersBadContentEncoding) {
    const FailingServer server;
    for (const auto& [path, encoding] :
    { std::pair<std::string_view, std::string_view>{ "/bad-gzip", "gzip" },
    { "/unsupported-br", "br" } }) {
        const json answer =
        execute ({ { "method", "GET" }, { "url", server.url (path) } });

        EXPECT_EQ (answer.value ("status", -1), 0) << answer.dump (2);
        EXPECT_EQ (answer.value ("errorCode", ""), "BAD_CONTENT_ENCODING")
        << answer.dump (2);
        const auto message = answer.value ("errorMessage", std::string ());
        EXPECT_TRUE (message.starts_with (
        "The response could not be decoded: the server sent Content-Encoding " +
        std::string (encoding) + ". "))
        << message;
    }
}

} // namespace
