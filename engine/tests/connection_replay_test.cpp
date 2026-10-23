/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/connection_replay_test.cpp
 * @brief A request libcurl re-sends on a new connection, after the server
 *        dropped a reused one before answering, is counted and reported
 *        (#2799): on the transfer (`Response::connection_replays`), in the
 *        stored summary, and as the run's `connection_replayed` warning.
 *
 * Every case is ordered by the requests themselves, never by a clock: the
 * fixture drops a connection only after reading a request on it, and each
 * send waits for the one before it.
 *
 * Mutation check for the counter: drop `++check->requests_started` in
 * `refuse_forbidden_peer` and every case that expects a replay reads 0.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <cstddef>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <thread>

#include "connection_drop_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "wait_until.hpp"

namespace {

vayu::Request get (const std::string& url) {
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = url;
    return request;
}

class ConnectionReplayTransferTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        vayu::http::EventLoopConfig config;
        // One multi handle, so the second send can only reuse the first's
        // connection.
        config.num_workers = 1;
        loop               = std::make_unique<vayu::http::EventLoop> (config);
        loop->start ();
    }
    void TearDown () override {
        loop->stop ();
        loop.reset ();
        vayu::http::global_cleanup ();
    }

    /// One send through the event loop, waited for before the next.
    vayu::Result<vayu::Response> send (const std::string& url) {
        return loop->submit_async (get (url)).future.get ();
    }

    std::unique_ptr<vayu::http::EventLoop> loop;
};

// The issue's case: the second send reuses the first's connection, the fixture
// reads it and closes, and libcurl re-sends it on a new connection, which
// answers. One send, two arrivals, one success - and now one replay. The first
// send is the plain request, which reports none.
TEST_F (ConnectionReplayTransferTest, ARequestResentOnANewConnectionIsCounted) {
    vayu::tests::ConnectionDropServer server;
    ASSERT_NE (server.port (), 0);

    const auto first = send (server.url ());
    ASSERT_TRUE (first.is_ok ());
    EXPECT_EQ (first.value ().status_code, 200);
    EXPECT_EQ (first.value ().connection_replays, 0) << "a plain request";

    const auto second = send (server.url ());
    ASSERT_TRUE (second.is_ok ());
    EXPECT_EQ (second.value ().status_code, 200) << "the replay was answered";
    EXPECT_FALSE (second.value ().has_error ());
    EXPECT_EQ (second.value ().connection_replays, 1);

    EXPECT_EQ (server.arrivals (), 3u)
    << "two sends reached the target three times";
    EXPECT_EQ (server.dropped (), 1u);
}

// A replay that then fails still put the request on the wire twice, so the
// count rides the error response too: here the new connection is dropped as
// well, which libcurl does not retry because it was not reused.
TEST_F (ConnectionReplayTransferTest, AReplayThatFailsIsStillCounted) {
    vayu::tests::ConnectionDropServer server (
    [] (std::size_t arrival, std::size_t /*on_connection*/) {
        return arrival == 1;
    });
    ASSERT_NE (server.port (), 0);

    ASSERT_TRUE (send (server.url ()).is_ok ());
    const auto second = send (server.url ());
    ASSERT_TRUE (second.is_ok ());
    EXPECT_TRUE (second.value ().has_error ());
    EXPECT_EQ (second.value ().status_code, 0);
    EXPECT_EQ (second.value ().connection_replays, 1);
    EXPECT_EQ (server.arrivals (), 3u);
}

// A redirect hop is a second request on a connection too, the same callback
// fires for it, and it is not a replay. Mutation check: drop the redirect
// count from `connection_replays` in curl_utils.cpp and this reads 1.
TEST_F (ConnectionReplayTransferTest, ARedirectIsNotAReplay) {
    httplib::Server target;
    target.Get ("/hop", [] (const httplib::Request&, httplib::Response& res) {
        res.set_redirect ("/landed");
    });
    target.Get ("/landed", [] (const httplib::Request&, httplib::Response& res) {
        res.set_content ("ok", "text/plain");
    });
    const int port = target.bind_to_any_port ("127.0.0.1");
    std::thread listener ([&target] () { target.listen_after_bind (); });
    target.wait_until_ready ();

    auto request = get ("http://127.0.0.1:" + std::to_string (port) + "/hop");
    request.follow_redirects = true;
    const auto result        = loop->submit_async (request).future.get ();

    target.stop ();
    listener.join ();
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().status_code, 200) << "the redirect was followed";
    EXPECT_EQ (result.value ().connection_replays, 0);
}

// Nothing listens, so no request was ever started on a connection: an error,
// and no replay rather than a negative count.
TEST_F (ConnectionReplayTransferTest, ARefusedConnectionIsNoReplay) {
    int closed_port = 0;
    {
        httplib::Server probe;
        closed_port = probe.bind_to_any_port ("127.0.0.1");
        std::thread runner ([&probe] () { probe.listen_after_bind (); });
        probe.wait_until_ready ();
        probe.stop ();
        runner.join ();
    }

    const auto result = send ("http://127.0.0.1:" + std::to_string (closed_port) + "/");
    ASSERT_TRUE (result.is_ok ());
    EXPECT_TRUE (result.value ().has_error ());
    EXPECT_EQ (result.value ().connection_replays, 0);
}

/// The stored summary's `connection_replayed` warning, or null.
nlohmann::json replay_warning (const nlohmann::json& warnings) {
    for (const auto& warning : warnings) {
        if (warning.value ("code", "") == "connection_replayed") {
            return warning;
        }
    }
    return nullptr;
}

// The warning itself, without a run: present with the count when there were
// replays, absent when there were none.
TEST (ConnectionReplayWarningTest, IsRaisedOnlyWhenARequestWasReplayed) {
    const auto quiet = std::make_shared<vayu::core::RunContext> (
    "run-replay-quiet", nlohmann::json::object ());
    EXPECT_TRUE (replay_warning (vayu::core::build_run_warnings (quiet)).is_null ());

    const auto replayed = std::make_shared<vayu::core::RunContext> (
    "run-replay-warning", nlohmann::json::object ());
    replayed->metrics_collector->record_connection_replays (2);
    replayed->metrics_collector->record_connection_replays (1);
    const auto warning = replay_warning (vayu::core::build_run_warnings (replayed));
    ASSERT_TRUE (warning.is_object ());
    EXPECT_EQ (warning["count"], 3);
    const auto message = warning["message"].get<std::string> ();
    EXPECT_NE (message.find ("3 requests were re-sent on a new connection"), std::string::npos)
    << message;
}

class ConnectionReplayRunTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_connection_replay_run.db";

    void SetUp () override {
        vayu::http::global_init ();
        vayu::tests::remove_database_files (DB_PATH);
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
        // One event-loop worker, so one connection pool: a run spread over
        // several would open a fresh connection per worker and reuse none.
        auto workers = db->get_config_entry ("workers");
        ASSERT_HAS_VALUE (workers);
        workers->value = "1";
        db->save_config_entry (*workers);
    }
    void TearDown () override {
        db.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        vayu::http::global_cleanup ();
    }

    /// Create the row `start_run` expects (the route's job), run it to its
    /// end and hand back the stored row. Finished is `get_run` answering
    /// null, because retaining the row is the worker's last act.
    std::optional<vayu::db::Run> run_to_terminal_row (const std::string& run_id,
    const nlohmann::json& config) {
        vayu::db::Run row;
        row.id              = run_id;
        row.type            = vayu::RunType::Load;
        row.status          = vayu::RunStatus::Pending;
        row.config_snapshot = "{}";
        row.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        db->create_run (row);

        vayu::core::RunManager manager;
        manager.start_run (run_id, config, *db);
        if (!vayu::tests::wait_until (
            [&] () { return manager.get_run (run_id) == nullptr; })) {
            ADD_FAILURE () << "the run never reached a terminal status";
            return std::nullopt;
        }
        return db->get_run (run_id);
    }

    std::unique_ptr<vayu::db::Database> db;
};

// A load run whose every reused connection is dropped once: each drop is one
// replay, the stored summary counts them, the warning carries the same count,
// and none of them is an error. The target's arrivals are the requests the run
// counted plus the replays.
TEST_F (ConnectionReplayRunTest, TheStoredSummaryCountsEveryReplay) {
    vayu::tests::ConnectionDropServer server;
    ASSERT_NE (server.port (), 0);
    const nlohmann::json config = { { "mode", "iterations" }, { "iterations", 4 },
        { "concurrency", 1 }, { "url", server.url () }, { "method", "GET" } };

    const auto row = run_to_terminal_row ("run-connection-replay", config);
    ASSERT_HAS_VALUE (row);
    EXPECT_EQ (row->status, vayu::RunStatus::Completed);
    const auto summary = nlohmann::json::parse (row->summary);

    ASSERT_GT (server.dropped (), 0u)
    << "the run reused no connection over " << server.arrivals ()
    << " arrivals: " << summary.dump ();
    EXPECT_EQ (summary["connection_replays"].get<std::size_t> (), server.dropped ())
    << summary.dump ();
    EXPECT_EQ (server.arrivals (),
    summary["total_requests"].get<std::size_t> () + server.dropped ());
    EXPECT_EQ (summary["status_codes"], (nlohmann::json{ { "200", 4 } }))
    << "a replayed request is not an error";

    const auto warning =
    replay_warning (summary.value ("warnings", nlohmann::json::array ()));
    ASSERT_TRUE (warning.is_object ()) << summary.dump ();
    EXPECT_EQ (warning["count"].get<std::size_t> (), server.dropped ());
}

// A run with no replays still writes 0, so a reader can tell "looked and saw
// none" from a run stored before the key existed; no warning either.
TEST_F (ConnectionReplayRunTest, ARunWithoutReplaysStoresZeroAndNoWarning) {
    vayu::tests::ConnectionDropServer server (
    [] (std::size_t /*arrival*/, std::size_t /*on_connection*/) { return true; });
    ASSERT_NE (server.port (), 0);
    const nlohmann::json config = { { "mode", "iterations" }, { "iterations", 3 },
        { "concurrency", 1 }, { "url", server.url () }, { "method", "GET" } };

    const auto row = run_to_terminal_row ("run-connection-no-replay", config);
    ASSERT_HAS_VALUE (row);
    const auto summary = nlohmann::json::parse (row->summary);
    ASSERT_TRUE (summary.contains ("connection_replays")) << summary.dump ();
    EXPECT_EQ (summary["connection_replays"].get<std::size_t> (), 0u);
    EXPECT_TRUE (
    replay_warning (summary.value ("warnings", nlohmann::json::array ())).is_null ());
}

} // namespace
