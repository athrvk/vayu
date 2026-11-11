/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/execute_globals_test.cpp
 * @brief A global a script sets on a workspace that never saved any (#3453).
 *
 * `get_globals` answers nothing until `POST /globals` or an import writes the
 * singleton, and `persist_script_variables` used to read that as "deleted
 * during the run" and discard the write. This pins the real `POST /execute`
 * end to end on a fresh database: the name is in `GET /globals` afterwards and
 * the next Send resolves it.
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

class ExecuteGlobalsTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_execute_globals.db";

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
        vayu::http::routes::register_globals_routes (*ctx_);
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

    /// The `/execute` answer for @p payload, a 200 whatever the send did.
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

    /// `GET /globals`' `variables` object.
    json globals_variables () const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Get ("/globals");
        if (!response) {
            ADD_FAILURE () << "GET /globals did not answer";
            return json::object ();
        }
        EXPECT_EQ (response->status, 200) << "body: '" << response->body << "'";
        return json::parse (response->body, nullptr, false).value ("variables", json::object ());
    }

    static json pre_request_script (const std::string& script) {
        return json::array ({ { { "id", "el_pre" }, { "kind", "script.pre" },
        { "config", { { "script", script } } } } });
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

// Mutation check: return nothing for an absent globals row in
// `persist_script_variables` (request_exchange.cpp) and `GET /globals` stays
// empty, so the second Send's path keeps the literal `{{fresh}}`.
TEST_F (ExecuteGlobalsTest, AGlobalSetOnAFreshWorkspaceIsStoredAndResolvedByTheNextSend) {
    const vayu::tests::EchoServer echo;
    ASSERT_FALSE (db_->get_globals ().has_value ());

    const json first = execute ({ { "method", "GET" }, { "url", echo.url () },
    { "elements", pre_request_script ("pm.globals.set('fresh', 'from-script');") } });
    ASSERT_EQ (first.value ("status", -1), 200) << first.dump (2);

    const json stored = globals_variables ();
    ASSERT_TRUE (stored.contains ("fresh")) << stored.dump (2);
    EXPECT_EQ (stored["fresh"]["value"], "from-script");

    const json second =
    execute ({ { "method", "GET" }, { "url", echo.url () + "/{{fresh}}" } });
    ASSERT_EQ (second.value ("status", -1), 200) << second.dump (2);
    EXPECT_EQ (echo.path (), "/echo/from-script");
}

} // namespace
