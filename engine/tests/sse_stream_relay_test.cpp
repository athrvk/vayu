/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/sse_stream_relay_test.cpp
 * @brief The SSE stream manager and the relay handler: completion callbacks, stop and shutdown,
 * replay and resume over a real socket, and the server-shutdown drain.
 *
 * The in-process SSE server, the helpers shared by these files and the `StreamExecuteTest`
 * fixture are in `sse_stream_fixture.hpp`.
 */

// First, before anything that includes <httplib.h>: see the header. Needed
// for `proxy_server.hpp`, whose forwarder builds an `httplib::Client` from a URL.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <cstddef>
#include <future>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "wait_until.hpp"

#include "sse_stream_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::http::SseEndReason;
using vayu::http::SseStreamContext;
using vayu::http::SseStreamManager;
namespace sse_constants = vayu::core::constants::sse;
using vayu::tests::sse_stream::brisk_limits;
using vayu::tests::sse_stream::spec_for;
using vayu::tests::sse_stream::StreamServer;

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

TEST (SseStreamManagerTest, RunsAStreamToCompletionAndCallsBack) {
    StreamServer server ({ "data: a\n\n", "data: b\n\n" });
    SseStreamManager manager;
    std::atomic<bool> recorded{ false };
    int64_t recorded_events = 0;

    auto spec        = spec_for (server.url ("/scripted"), brisk_limits ());
    spec.on_complete = [&] (const vayu::Request&, const vayu::Response&,
                       const SseStreamContext& context) {
        recorded_events = context.total_events ();
        recorded.store (true);
    };
    auto context = manager.start (std::move (spec));
    ASSERT_NE (context, nullptr);

    const auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (10);
    while (!recorded.load () && std::chrono::steady_clock::now () < deadline) {
        std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }
    EXPECT_TRUE (recorded.load ());
    EXPECT_EQ (recorded_events, 2);
    EXPECT_EQ (context->end_reason (), SseEndReason::Completed);
}

TEST (SseStreamManagerTest, StopRequestEndsALiveStreamAndIsRefusedForAnUnknownRun) {
    StreamServer server;
    SseStreamManager manager;
    auto context = manager.start (spec_for (server.url ("/endless"), brisk_limits ()));
    ASSERT_NE (context, nullptr);

    ASSERT_TRUE (
    vayu::tests::wait_until ([&] () { return context->total_events () >= 1; }));
    EXPECT_TRUE (manager.request_stop ("run_test"));
    EXPECT_FALSE (manager.request_stop ("run_missing"));

    const auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (10);
    while (!context->closed () && std::chrono::steady_clock::now () < deadline) {
        std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }
    EXPECT_EQ (context->end_reason (), SseEndReason::Stopped);
    // A finished stream is not stopped again: the reason it recorded is the
    // true one, and a second stop would rewrite it.
    EXPECT_FALSE (manager.request_stop ("run_test"));
}

// The teardown assertion: the destructor stops and joins every worker, so an
// endless stream cannot outlive its manager. The test hangs if it does - the
// same shape as run_shutdown_test.
TEST (SseStreamManagerTest, TearsDownWithAStreamStillRunning) {
    StreamServer server;
    {
        SseStreamManager manager;
        auto context =
        manager.start (spec_for (server.url ("/endless"), brisk_limits ()));
        ASSERT_NE (context, nullptr);
        ASSERT_TRUE (
        vayu::tests::wait_until ([&] () { return context->total_events () >= 1; }));
    }
    SUCCEED ();
}

// The ordering contract every owner runs on (#646): `shutdown()` does not
// return until each worker has finished - callback included. Joining is the
// drain; `closed()` is not, since the worker is still on its stack when it
// flips. A drain that returned early would leave the worker writing through a
// `Database` its owner is about to destroy, the intermittent segfault this
// test exists to keep fixed.
TEST (SseStreamManagerTest, ShutdownJoinsEveryWorkerAndIsTerminalAndIdempotent) {
    StreamServer server;
    SseStreamManager manager;
    std::atomic<bool> completed{ false };

    auto spec = spec_for (server.url ("/endless"), brisk_limits ());
    spec.on_complete = [&completed] (const vayu::Request&, const vayu::Response&,
                       const SseStreamContext&) { completed.store (true); };
    auto context = manager.start (std::move (spec));
    ASSERT_NE (context, nullptr);
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] () { return context->total_events () >= 1; }));

    manager.shutdown ();
    EXPECT_TRUE (completed.load ()) << "shutdown returned while the worker was "
                                       "still in its completion callback";
    EXPECT_EQ (manager.size (), 0u);
    // A drain is no user's Stop (#3342). Mutation check: signal the drain
    // with `request_stop ()` again and this reads Stopped.
    EXPECT_EQ (context->end_reason (), SseEndReason::Shutdown);

    // Terminal, like RunManager's: a drain happens because the state the
    // workers write through is going away, so a stream started afterwards
    // would have nothing to write to.
    EXPECT_EQ (manager.start (spec_for (server.url ("/endless"), brisk_limits ())), nullptr);
    manager.shutdown ();
    EXPECT_EQ (manager.size (), 0u);
}

TEST (SseStreamManagerTest, SweepsOnlyFinishedStreamsPastTheirRetention) {
    StreamServer server ({ "data: a\n\n" });
    SseStreamManager manager;
    auto context = manager.start (spec_for (server.url ("/scripted"), brisk_limits ()));
    ASSERT_NE (context, nullptr);

    const auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (10);
    while (!context->closed () && std::chrono::steady_clock::now () < deadline) {
        std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }
    ASSERT_TRUE (context->closed ());

    manager.sweep_retained (60000);
    EXPECT_EQ (manager.size (), 1u)
    << "a stream inside its retention was swept";
    manager.sweep_retained (0);
    EXPECT_EQ (manager.size (), 0u);
    EXPECT_EQ (manager.get ("run_test"), nullptr);
}

// The context closes only once `on_complete` has returned, so a relay cannot
// write `event: complete` before the run row exists, and the callback already
// reads the true end reason (#3239). Stopped rather than a server close, so
// the reason read inside is one only the transfer could have recorded. Mutation check:
// close the context in `consume_sse_stream` again and `closed()` is true while
// the callback is held.
TEST (SseStreamManagerTest, ClosesOnlyAfterTheCompletionCallbackReturns) {
    StreamServer server;
    SseStreamManager manager;
    std::atomic<bool> entered{ false };
    std::atomic<bool> release{ false };
    std::atomic<bool> closed_inside{ true };
    std::atomic<SseEndReason> reason_inside{ SseEndReason::Completed };

    auto spec        = spec_for (server.url ("/endless"), brisk_limits ());
    spec.on_complete = [&] (const vayu::Request&, const vayu::Response&,
                       const SseStreamContext& context) {
        closed_inside.store (context.closed ());
        reason_inside.store (context.end_reason ());
        entered.store (true);
        // Bounded, so a failed assertion below cannot leave the manager's
        // destructor joining a worker that waits forever.
        (void)vayu::tests::wait_until ([&] () { return release.load (); });
    };
    auto context = manager.start (std::move (spec));
    ASSERT_NE (context, nullptr);
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] () { return context->total_events () >= 1; }));
    ASSERT_TRUE (manager.request_stop ("run_test"));

    ASSERT_TRUE (vayu::tests::wait_until ([&] () { return entered.load (); }));
    EXPECT_FALSE (context->closed ())
    << "the context closed while the completion callback was still running";
    EXPECT_EQ (context->completed_at_ms (), 0);
    EXPECT_FALSE (closed_inside.load ());
    EXPECT_EQ (reason_inside.load (), SseEndReason::Stopped);

    release.store (true);
    ASSERT_TRUE (vayu::tests::wait_until ([&] () { return context->closed (); }));
    EXPECT_EQ (context->end_reason (), SseEndReason::Stopped);
}

// A completion callback that throws must not leave the context open: the relay
// would never end and `POST /runs/:id/stop` would wait out its budget. One
// `std::exception` and one that is not, since they unwind through different
// handlers. Mutation check: move the close into the worker's `try` and the
// non-standard throw never closes.
TEST (SseStreamManagerTest, AThrowingCompletionCallbackStillCloses) {
    StreamServer server ({ "data: a\n\n" });
    SseStreamManager manager;

    auto standard        = spec_for (server.url ("/scripted"), brisk_limits ());
    standard.run_id      = "run_standard";
    standard.on_complete = [] (const vayu::Request&, const vayu::Response&,
                           const SseStreamContext&) {
        throw std::runtime_error ("the row could not be written");
    };
    auto other        = spec_for (server.url ("/scripted"), brisk_limits ());
    other.run_id      = "run_other";
    other.on_complete = [] (const vayu::Request&, const vayu::Response&,
                        const SseStreamContext&) { throw 42; };

    for (auto* spec : { &standard, &other }) {
        const std::string run_id = spec->run_id;
        auto context             = manager.start (std::move (*spec));
        ASSERT_NE (context, nullptr) << run_id;
        EXPECT_TRUE (
        vayu::tests::wait_until ([&] () { return context->closed (); }))
        << run_id << " never closed after its callback threw";
        EXPECT_EQ (context->end_reason (), SseEndReason::Completed) << run_id;
    }
}

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

/// The events route registered on a real server, with the whole RouteContext
/// its handler reads through.
class RelayTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_sse_relay.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        manager_ = std::make_unique<SseStreamManager> ();
        ctx_     = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, nullptr, authorize_manager_,
        cookie_jar_, mock_issuer_manager_, inbox_manager_, mock_server_manager_, *manager_,
        run_summary_cache_, vayu::http::no_grant_secret (), server_stopping_ });
        vayu::http::routes::register_event_stream_routes (*ctx_);
        svr_.set_write_timeout (60, 0);
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    void TearDown () override {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
        // Before `db_`, always (#646). A stream worker can outlive the test
        // body - only joining it proves it has left `*db_` - so resetting the
        // database first is a use-after-free that only shows up as an
        // intermittent segfault under load. Same order as InboxListenerTest,
        // and the order `Server::stop()` holds in production.
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// A finished stream of @p count events, consumed for real off the fixture
    /// so the relay replays what a transfer actually produced.
    std::shared_ptr<SseStreamContext> streamed (int count) {
        std::vector<std::string> chunks;
        chunks.reserve (static_cast<size_t> (count));
        for (int i = 0; i < count; ++i) {
            chunks.push_back ("data: " + std::to_string (i) + "\n\n");
        }
        origin_ = std::make_unique<StreamServer> (std::move (chunks));
        auto context =
        manager_->start (spec_for (origin_->url ("/scripted"), brisk_limits ()));
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (10);
        while (context && !context->closed () && std::chrono::steady_clock::now () < deadline) {
            std::this_thread::sleep_for (std::chrono::milliseconds (5));
        }
        return context;
    }

    httplib::Client client () const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        return client;
    }

    void set_config (const char* key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key;
        entry->value = value;
        db_->save_config_entry (*entry);
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
    /// Held by pointer so `TearDown` can join its workers *before* the
    /// database they write through goes away - see the note there (#646).
    std::unique_ptr<SseStreamManager> manager_;
    /// What `Server::stop()` sets (#2683); this fixture has no `Server`.
    std::atomic<bool> server_stopping_{ false };
    std::unique_ptr<vayu::http::routes::RouteContext> ctx_;
    std::unique_ptr<StreamServer> origin_;
};

TEST_F (RelayTest, AnUnknownRunIs404WithAPointerToTheStoredReport) {
    auto response = client ().Get ("/runs/run_nope/events");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 404);
    EXPECT_NE (response->body.find ("/report"), std::string::npos);
}

TEST_F (RelayTest, ReplaysEveryRetainedFrameAndClosesWithTheReason) {
    ASSERT_NE (streamed (3), nullptr);

    auto response = client ().Get ("/runs/run_test/events");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 200);
    // The `open` frame plus three events, each carrying its slot as its id.
    for (const char* id : { "id: 0\n", "id: 1\n", "id: 2\n", "id: 3\n" }) {
        EXPECT_NE (response->body.find (id), std::string::npos) << id;
    }
    EXPECT_NE (response->body.find ("event: complete"), std::string::npos);
    EXPECT_NE (response->body.find ("\"reason\":\"completed\""), std::string::npos);
    EXPECT_NE (response->body.find ("\"totalEvents\":3"), std::string::npos);
}

struct RelayResumeCase {
    std::string name;
    int streamed_count;
    std::string last_event_id;
    std::vector<std::string> expected_absent_ids;
    std::vector<std::string> expected_present_ids;
};

class RelayResumeTest : public RelayTest,
                        public ::testing::WithParamInterface<RelayResumeCase> {};

TEST_P (RelayResumeTest, ReplaysOnlyTheFramesAfterTheResumePoint) {
    const auto& c = GetParam ();
    ASSERT_NE (streamed (c.streamed_count), nullptr);

    auto response = client ().Get ("/runs/run_test/events?lastEventId=" + c.last_event_id);
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 200);
    for (const auto& id : c.expected_absent_ids) {
        EXPECT_EQ (response->body.find ("id: " + id + "\n"), std::string::npos)
        << "a resumed stream replayed frame " << id
        << ", which the client had already seen";
    }
    for (const auto& id : c.expected_present_ids) {
        EXPECT_NE (response->body.find ("id: " + id + "\n"), std::string::npos)
        << "frame " << id << " is missing from the resumed stream";
    }
    EXPECT_NE (response->body.find ("event: complete"), std::string::npos);
}

INSTANTIATE_TEST_SUITE_P (RelayTest,
RelayResumeTest,
::testing::Values (
// The dropped-consumer case: a client that saw through frame 1 asks for what
// followed it, and must not be re-sent what it already rendered.
RelayResumeCase{ "ResumesAfterTheLastFrameSeen", 3, "1", { "0", "1" }, { "2" } },
// Frame ids start at 0, so "0" is a real resume point rather than a stand-in
// for absent - resuming from it must skip exactly the first frame.
RelayResumeCase{ "ResumingFromZeroSkipsOnlyTheFirstFrame", 2, "0", { "0" }, { "1" } }),
[] (const ::testing::TestParamInfo<RelayResumeCase>& info) {
    return info.param.name;
});

TEST_F (RelayTest, AGarbledResumePointIs400RatherThanASilentReplay) {
    ASSERT_NE (streamed (2), nullptr);

    auto response = client ().Get ("/runs/run_test/events?lastEventId=abc");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 400);
    EXPECT_NE (response->body.find ("invalid_last_event_id"), std::string::npos);
    // A run's frames are events, not the inbox's captures.
    EXPECT_EQ (json::parse (response->body).at ("error").at ("message"),
    "lastEventId must be a non-negative event id");
}

// Each stream parks a cpp-httplib pool thread for its whole life, so a second
// concurrent watcher is refused rather than quietly parking another.
TEST_F (RelayTest, ASecondConcurrentWatcherIsRefused) {
    auto context = streamed (1);
    ASSERT_NE (context, nullptr);
    const auto held = context->try_claim ();
    ASSERT_HAS_VALUE (held);

    auto response = client ().Get ("/runs/run_test/events");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 409);
    EXPECT_NE (response->body.find ("run_events_in_use"), std::string::npos);

    // Released, the next watcher is served - the claim is a slot, not a ban.
    context->release_claim (*held);
    auto second = client ().Get ("/runs/run_test/events");
    ASSERT_TRUE (second);
    EXPECT_EQ (second->status, 200);
}

// A relay of a stream still going ends once the server is stopping, with no
// completion frame for a stream that has not completed (#2683): `Server::stop()`
// joins the relay's handler before it drains the stream consumer. Healthy: the
// relay sees the flag within one poll (50ms). Mutation check: drop the
// `stopping` check from `relay_run_events`, and the relay runs on to the
// stream's 30s cap and ends on `event: complete`.
TEST_F (RelayTest, AStoppingServerEndsTheRelayOfAStreamStillGoing) {
    origin_ = std::make_unique<StreamServer> ();
    auto context =
    manager_->start (spec_for (origin_->url ("/endless"), brisk_limits ()));
    ASSERT_NE (context, nullptr);

    std::atomic<bool> read_something{ false };
    std::string body; // Written by the reader alone, read once it has finished.
    auto reader = std::async (std::launch::async, [this, &read_something, &body] () {
        auto watcher = client ();
        return watcher.Get ("/runs/run_test/events", [&] (const char* data, size_t length) {
            body.append (data, length);
            read_something.store (true);
            return true;
        });
    });
    ASSERT_TRUE (vayu::tests::wait_until (
    [&read_something] () { return read_something.load (); }))
    << "the relay never wrote a frame";

    server_stopping_.store (true);
    EXPECT_TRUE (vayu::tests::wait_until ([&reader] () {
        return reader.wait_for (std::chrono::seconds (0)) == std::future_status::ready;
    }))
    << "the relay ran on with the server stopping";
    EXPECT_FALSE (context->closed ())
    << "the stream ended, so the flag proved nothing";
    reader.get ();
    EXPECT_EQ (body.find ("event: complete"), std::string::npos) << body;
}

TEST_F (RelayTest, AnExpiredStreamIsSweptAndReads404) {
    ASSERT_NE (streamed (1), nullptr);
    set_config ("liveRetentionMs", "0");

    auto response = client ().Get ("/runs/run_test/events");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 404);
    EXPECT_EQ (manager_->size (), 0u);
}

// ---------------------------------------------------------------------------
// Shutdown ordering (issue #646)
//
// The fixtures above hold the rule in their `TearDown`; this holds it where the
// daemon does. `daemon.cpp` runs `curl_global_cleanup` between its
// `server.stop()` and the point where `~Server` destroys its members, so a
// stream joined only by the member destructor is a transfer running through
// curl's global teardown - the #125 defect, in the one worker `RunManager` does
// not own.
// ---------------------------------------------------------------------------

/// A port nothing is listening on. `vayu::http::Server` takes its port up
/// front, so a test cannot ask it for an ephemeral one the way the fixtures
/// above do; listening and stopping is what actually releases the socket
/// (`bind_to_any_port` alone leaves it open until the process exits).
int free_port () {
    httplib::Server probe;
    const int port = probe.bind_to_any_port ("127.0.0.1");
    std::thread runner ([&probe] () { probe.listen_after_bind (); });
    probe.wait_until_ready ();
    probe.stop ();
    runner.join ();
    return port;
}

TEST (SseServerShutdownTest, StoppingTheServerDrainsALiveStream) {
    static constexpr const char* DB_PATH = "test_sse_server_shutdown.db";
    vayu::tests::remove_database_files (DB_PATH);
    auto db = std::make_unique<vayu::db::Database> (DB_PATH);
    db->init ();
    vayu::core::RunManager run_manager;
    StreamServer origin;

    const int port = free_port ();
    {
        vayu::http::Server server (*db, run_manager, port);
        ASSERT_TRUE (server.start ());

        httplib::Client client ("127.0.0.1", port);
        client.set_read_timeout (20, 0);
        const auto ready = std::chrono::steady_clock::now () + std::chrono::seconds (10);
        while (!client.Get ("/health") && std::chrono::steady_clock::now () < ready) {
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
        }

        // `/endless` never stops talking, so the only thing that can end this
        // stream inside the test is the drain itself.
        const json payload = { { "method", "GET" },
            { "url", origin.url ("/endless") }, { "stream", true } };
        auto response = client.Post ("/execute", payload.dump (), "application/json");
        ASSERT_TRUE (response);
        ASSERT_EQ (response->status, 202) << response->body;
        const auto run_id = json::parse (response->body).value ("runId", std::string ());
        ASSERT_FALSE (run_id.empty ());

        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (10);
        while (origin.requests_received () == 0 &&
        std::chrono::steady_clock::now () < deadline) {
            std::this_thread::sleep_for (std::chrono::milliseconds (5));
        }
        ASSERT_GT (origin.requests_received (), 0)
        << "the stream never reached the origin";

        server.stop ();

        // The result row is written by the worker, from inside its completion
        // callback. Present the instant `stop()` returns means the worker was
        // joined rather than left running - and left running is what would put
        // it inside curl while `curl_global_cleanup` ran, and inside `db`
        // while the daemon destroyed it.
        const auto results = db->get_results (run_id);
        ASSERT_FALSE (results.empty ())
        << "server.stop() returned with the stream's worker still running";

        // Recorded as the engine's end, not a user's Stop (#3342), on a row
        // that ends `stopped` as a load run still sending does.
        const auto trace = json::parse (results[0].trace_data);
        EXPECT_EQ (trace["events"]["endReason"], "shutdown") << trace.dump (2);
        const auto run = db->get_run (run_id);
        ASSERT_HAS_VALUE (run);
        EXPECT_EQ (run->status, vayu::RunStatus::Stopped);
    }

    db.reset ();
    vayu::tests::remove_database_files (DB_PATH);
}

} // namespace
