/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/execute_disconnect_test.cpp
 * @brief A buffered `POST /execute` whose caller hangs up stops its transfer
 *        and is recorded `stopped` (#3383); `DisconnectWatch` on its own.
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <atomic>
#include <future>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "mock_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/disconnect_watch.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/types.hpp"
#include "wait_until.hpp"

namespace {

using nlohmann::json;
using vayu::http::DisconnectWatch;
using vayu::tests::wait_until;

TEST (DisconnectWatchTest, AClosedConnectionRaisesTheFlagAndNamesTheCaller) {
    std::atomic<bool> closed{ false };
    const std::atomic<bool> stopping{ false };
    DisconnectWatch watch ([&closed] { return closed.load (); }, stopping);
    EXPECT_FALSE (watch.cancel ().load ());

    closed.store (true);
    EXPECT_TRUE (wait_until ([&watch] { return watch.cancel ().load (); }))
    << "the watch never saw the connection close";
    EXPECT_TRUE (watch.caller_left ());
}

// A stopping server ends the transfer through the same flag, but is not a
// caller leaving: the send keeps the status its exchange earned. Mutation
// check: poll the connection before `server_stopping` in `poll_once` and
// `caller_left` reads true.
TEST (DisconnectWatchTest, AStoppingServerRaisesTheFlagWithoutBlamingTheCaller) {
    const std::atomic<bool> stopping{ true };
    DisconnectWatch watch ([] { return true; }, stopping);

    EXPECT_TRUE (wait_until ([&watch] { return watch.cancel ().load (); }))
    << "the watch never saw the server stopping";
    EXPECT_FALSE (watch.caller_left ());
}

// `caller_left` reads the connection itself, so a caller that hung up after
// the last poll still stops the send. Mutation check: answer only the latched
// flag and this reads false.
TEST (DisconnectWatchTest, ACallerThatLeftSinceTheLastPollIsStillSeen) {
    std::atomic<bool> closed{ false };
    const std::atomic<bool> stopping{ false };
    DisconnectWatch watch ([&closed] { return closed.load (); }, stopping);

    closed.store (true);
    EXPECT_TRUE (watch.caller_left ());
    EXPECT_TRUE (watch.cancel ().load ());
}

TEST (DisconnectWatchTest, AnEmptyProbeIsRefused) {
    const std::atomic<bool> stopping{ false };
    EXPECT_THROW (DisconnectWatch (nullptr, stopping), std::invalid_argument);
}

class ExecuteDisconnectTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_execute_disconnect.db";

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
        // Before `db_`: a stream's worker records its result into it.
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// The most recent run row, which is this test's only one.
    std::optional<vayu::db::Run> latest_run () const {
        const auto runs = db_->get_runs_paginated (vayu::db::RunFilter{}, 1, 0);
        if (runs.empty ()) {
            return std::nullopt;
        }
        return runs.front ();
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

// The upstream answers only once the fixture goes, so the transfer can end
// only by being dropped, and the row can only go terminal once it has.
// Mutation check: hand the buffered exchange `ctx.server_stopping` instead of
// the watch's flag, and the upstream never sees the hang-up.
TEST_F (ExecuteDisconnectTest, ACallerThatHangsUpStopsTheTransferAndTheRunReadsStopped) {
    vayu::tests::SlowMockServer upstream;
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    // `std::async` futures wait for their task on destruction, so no assertion
    // below can leave the call running past the client it uses.
    auto call = std::async (
    std::launch::async, [&client, url = upstream.hang_until_hangup_url ()] () {
        const json payload{ { "method", "GET" }, { "url", url } };
        return static_cast<bool> (
        client.Post ("/execute", payload.dump (), "application/json"));
    });
    const bool in_flight =
    wait_until ([&upstream] { return upstream.hang_count () > 0; });
    client.stop ();
    ASSERT_TRUE (in_flight)
    << "the /execute handler never reached the upstream";
    EXPECT_FALSE (call.get ()) << "a caller that hung up read an answer";

    ASSERT_TRUE (wait_until ([&upstream] { return upstream.hangup_count () > 0; }))
    << "the engine kept its upstream transfer open after its caller hung up";
    ASSERT_TRUE (wait_until ([this] {
        const auto run = latest_run ();
        return run && vayu::is_terminal (run->status) &&
        !db_->get_results (run->id).empty ();
    }))
    << "the run was never recorded";

    const auto run = latest_run ();
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Stopped);
    const auto results = db_->get_results (run->id);
    ASSERT_EQ (results.size (), 1U);
    EXPECT_EQ (results.front ().status_code, 0);
    EXPECT_EQ (results.front ().error, "Request cancelled");
}

// The upstream takes 500ms, so the watch reads the live connection several
// times before the answer. Mutation check: make `poll_once` treat a live
// connection as closed and the run reads `stopped`.
TEST_F (ExecuteDisconnectTest, ACallerThatWaitsIsAnsweredAndTheRunReadsCompleted) {
    vayu::tests::SlowMockServer upstream;
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    const json payload{ { "method", "GET" }, { "url", upstream.slow_url () } };
    const auto response = client.Post ("/execute", payload.dump (), "application/json");
    ASSERT_TRUE (response) << httplib::to_string (response.error ());
    ASSERT_EQ (response->status, 200) << response->body;
    EXPECT_EQ (json::parse (response->body).value ("status", -1), 200)
    << response->body;

    const auto run = latest_run ();
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Completed);
}

// A stream is handed off at its 202 and outlives the call that started it.
TEST_F (ExecuteDisconnectTest, AStreamOutlivesTheCallThatStartedIt) {
    vayu::tests::SlowMockServer upstream;
    std::string run_id;
    {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        const json payload{ { "method", "GET" },
            { "url", upstream.sse_held_url () }, { "stream", true } };
        const auto response = client.Post ("/execute", payload.dump (), "application/json");
        ASSERT_TRUE (response) << httplib::to_string (response.error ());
        ASSERT_EQ (response->status, 202) << response->body;
        run_id = json::parse (response->body).value ("runId", std::string ());
    }
    ASSERT_FALSE (run_id.empty ());
    ASSERT_TRUE (
    wait_until ([&upstream] { return upstream.live_connection_count () > 0; }))
    << "the stream never reached the upstream";

    upstream.released.store (true);
    ASSERT_TRUE (wait_until ([this, &run_id] {
        const auto run = db_->get_run (run_id);
        return run && vayu::is_terminal (run->status);
    }))
    << "the stream never ended";
    const auto run = db_->get_run (run_id);
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Completed);
}

} // namespace
