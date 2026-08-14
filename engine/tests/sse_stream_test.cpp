/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file sse_stream_test.cpp
 * @brief The streaming execution core, end to end (issue #573).
 *
 * The transfer half runs against an in-process cpp-httplib fixture rather than
 * the Go mock server: that server's 5s write timeout kills a stream, which is
 * the one thing these tests must be able to keep open. The relay half runs
 * against the real handler registered on a real server, because replay, resume
 * and the one-watcher claim are only meaningful over a socket.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"

namespace {

using nlohmann::json;
using vayu::http::SseEndReason;
using vayu::http::SseStreamContext;
using vayu::http::SseStreamManager;
using vayu::http::SseStreamRequest;
using vayu::http::routes::read_stream_flag;

namespace sse_constants = vayu::core::constants::sse;

// ---------------------------------------------------------------------------
// The fixture: a server that streams on demand
// ---------------------------------------------------------------------------

/**
 * Serves three shapes of `text/event-stream` a test needs and a live endpoint
 * cannot be asked for: a finite scripted stream, one that never stops talking,
 * and one that connects and then says nothing at all.
 *
 * `/scripted` writes whatever chunks it was built with, so a test supplies the
 * shape it needs - several events in one write, one event split across two,
 * or frames the parser must reject - rather than each shape needing its own
 * endpoint. `pace()` puts a delay between those writes, which is what separates
 * "arrived incrementally" from "arrived in one buffer" for a consumer that
 * cannot tell the difference after the fact.
 *
 * This is the home for stream fixtures, and the Go `scripts/test/mock-server.go`
 * is not: its 5s write timeout kills any stream held open longer than that.
 */
class StreamServer {
    public:
    explicit StreamServer (std::vector<std::string> chunks = {})
    : chunks_ (std::move (chunks)) {
        // A stream outlives cpp-httplib's stock 5s write budget by design.
        svr_.set_write_timeout (60, 0);

        svr_.Get ("/scripted", [this] (const httplib::Request& req, httplib::Response& res) {
            note_request (req);
            res.set_chunked_content_provider (
            "text/event-stream", [this] (size_t, httplib::DataSink& sink) {
                for (const auto& chunk : chunks_) {
                    if (pace_ms_ > 0) {
                        std::this_thread::sleep_for (std::chrono::milliseconds (pace_ms_));
                    }
                    if (!sink.write (chunk.data (), chunk.size ())) {
                        return false;
                    }
                }
                sink.done ();
                return true;
            });
        });

        svr_.Get ("/endless", [this] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider (
            "text/event-stream", [this] (size_t, httplib::DataSink& sink) {
                while (!stopping_.load ()) {
                    const std::string frame = "data: tick\n\n";
                    if (!sink.write (frame.data (), frame.size ())) {
                        return false;
                    }
                    std::this_thread::sleep_for (std::chrono::milliseconds (5));
                }
                sink.done ();
                return true;
            });
        });

        svr_.Get ("/silent", [this] (const httplib::Request&, httplib::Response& res) {
            res.set_header ("X-Fixture", "silent");
            res.set_chunked_content_provider (
            "text/event-stream", [this] (size_t, httplib::DataSink& sink) {
                while (!stopping_.load ()) {
                    std::this_thread::sleep_for (std::chrono::milliseconds (20));
                }
                sink.done ();
                return true;
            });
        });

        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~StreamServer () {
        stopping_.store (true);
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }

    std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port_) + path;
    }

    /// Wait @p ms between writes on `/scripted`. Set before the request.
    void pace (int ms) {
        pace_ms_ = ms;
    }

    /// A header the last `/scripted` request carried, or "" - the only way to
    /// prove a pre-request script's edit reached the wire rather than the plan.
    std::string received_header (const std::string& name) const {
        std::lock_guard<std::mutex> lock (received_mutex_);
        const auto found = received_headers_.find (name);
        return found == received_headers_.end () ? std::string () : found->second;
    }

    private:
    void note_request (const httplib::Request& req) {
        std::lock_guard<std::mutex> lock (received_mutex_);
        received_headers_.clear ();
        for (const auto& [key, value] : req.headers) {
            received_headers_[key] = value;
        }
    }

    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    std::vector<std::string> chunks_;
    std::atomic<bool> stopping_{ false };
    std::atomic<int> pace_ms_{ 0 };
    mutable std::mutex received_mutex_;
    std::map<std::string, std::string, std::less<>> received_headers_;
};

vayu::Request get_request (const std::string& url) {
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = url;
    return request;
}

SseStreamRequest spec_for (const std::string& url, vayu::http::SseLimits limits) {
    SseStreamRequest spec;
    spec.run_id  = "run_test";
    spec.request = get_request (url);
    spec.limits  = limits;
    return spec;
}

/// Bounds tightened so a test that has to reach one does not take a minute.
vayu::http::SseLimits brisk_limits () {
    vayu::http::SseLimits limits;
    limits.idle_timeout_ms        = sse_constants::MIN_IDLE_TIMEOUT_MS;
    limits.max_stream_duration_ms = 30000;
    return limits;
}

/// The upstream payloads the ring is holding, in order.
std::vector<json> ring_payloads (const SseStreamContext& context) {
    std::vector<json> out;
    for (const auto& frame : context.events_since (0).payloads) {
        const auto data_at = frame.find ("data: ");
        if (data_at == std::string::npos) {
            continue;
        }
        out.push_back (json::parse (frame.substr (data_at + 6)));
    }
    return out;
}

// ---------------------------------------------------------------------------
// The flag and its refusals
// ---------------------------------------------------------------------------

TEST (StreamFlag, AbsentMeansABufferedSend) {
    const auto flag =
    read_stream_flag (json{ { "method", "GET" }, { "url", "http://x/" } });
    EXPECT_TRUE (flag.ok);
    EXPECT_FALSE (flag.value);
}

TEST (StreamFlag, TrueIsRead) {
    const auto flag = read_stream_flag (json{ { "stream", true } });
    EXPECT_TRUE (flag.ok);
    EXPECT_TRUE (flag.value);
}

// Stricter than a silent false, and for the loudest reason: a caller that sends
// "true" would get a buffered send and wait for a response the endpoint never
// finishes.
TEST (StreamFlag, ANonBooleanIsRefused) {
    const auto flag = read_stream_flag (json{ { "stream", "true" } });
    EXPECT_FALSE (flag.ok);
    EXPECT_NE (flag.error.find ("'stream'"), std::string::npos);
}

TEST (StreamFlag, StreamAndTransientCannotBeCombined) {
    const auto flag =
    read_stream_flag (json{ { "stream", true }, { "transient", true } });
    EXPECT_FALSE (flag.ok);
    EXPECT_NE (flag.error.find ("transient"), std::string::npos);
}

TEST (StreamFlag, TransientAloneIsStillFine) {
    const auto flag = read_stream_flag (json{ { "transient", true } });
    EXPECT_TRUE (flag.ok);
    EXPECT_FALSE (flag.value);
}

// Phase 3 (#575) turned the refusal into a feature: a stream's scripts now run,
// the pre-request one before the transfer and the post-request one over
// `pm.response.events` once it has terminated. This pins the flag reader's half
// of that - it must stop rejecting the payload - and
// `TheStreamsPostRequestScriptSeesItsEvents` below pins that they actually run.
TEST (StreamFlag, ScriptsNoLongerRefuseAStreamingRequest) {
    // Every spelling a payload can carry, read through the one name table
    // `read_pre_request_script` / `read_post_request_script` own.
    for (const char* key : { "preRequestScript", "postRequestScript", "tests" }) {
        const auto flag = read_stream_flag (
        json{ { "stream", true }, { key, "pm.test('x', function () {})" } });
        EXPECT_TRUE (flag.ok) << key << ": " << flag.error;
        EXPECT_TRUE (flag.value) << key;
    }
}

TEST (StreamFlag, ReadsPerRequestCaps) {
    const auto flag = read_stream_flag (json{ { "stream", true },
    { "maxStreamDurationMs", 5000 }, { "maxStreamEvents", 12 } });
    ASSERT_TRUE (flag.ok);
    ASSERT_TRUE (flag.max_duration_ms.has_value ());
    EXPECT_EQ (*flag.max_duration_ms, 5000);
    ASSERT_TRUE (flag.max_events.has_value ());
    EXPECT_EQ (*flag.max_events, 12);
}

TEST (StreamFlag, AnOutOfRangeCapIsRefused) {
    const auto flag =
    read_stream_flag (json{ { "stream", true }, { "maxStreamEvents", 0 } });
    EXPECT_FALSE (flag.ok);
    EXPECT_NE (flag.error.find ("maxStreamEvents"), std::string::npos);
}

// A cap on a non-streaming payload reads as a bound the caller expects to
// apply; ignoring it is how an unbounded run gets mistaken for a capped one.
TEST (StreamFlag, ACapWithoutTheFlagIsRefused) {
    const auto flag = read_stream_flag (json{ { "maxStreamEvents", 10 } });
    EXPECT_FALSE (flag.ok);
}

// ---------------------------------------------------------------------------
// The config reader
// ---------------------------------------------------------------------------

class SseLimitsTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_sse_limits.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        // The constructor only syncs the schema; seeding the catalogue happens
        // in init(), exactly as the daemon does at startup.
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    void set_config (const char* key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_TRUE (entry.has_value ()) << key;
        entry->value = value;
        db_->save_config_entry (*entry);
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// Every seeded key has a reader; a key nothing reads is a setting that does
// nothing, which is the defect this assertion exists to catch.
TEST_F (SseLimitsTest, EverySeededKeyIsRead) {
    for (const char* key : { "sseMaxRetainedEvents", "sseMaxEventBytes", "sseMaxStoredEvents",
         "sseMaxStreamDurationMs", "sseMaxStreamEvents", "sseIdleTimeoutMs" }) {
        EXPECT_TRUE (db_->get_config_entry (key).has_value ()) << key;
    }

    set_config ("sseMaxRetainedEvents", "50");
    set_config ("sseMaxEventBytes", "1024");
    set_config ("sseMaxStoredEvents", "7");
    set_config ("sseMaxStreamDurationMs", "9000");
    set_config ("sseMaxStreamEvents", "11");
    set_config ("sseIdleTimeoutMs", "3000");

    const auto limits = vayu::http::read_sse_limits (*db_);
    EXPECT_EQ (limits.max_retained_events, 50u);
    EXPECT_EQ (limits.max_event_bytes, 1024u);
    EXPECT_EQ (limits.max_stored_events, 7u);
    EXPECT_EQ (limits.max_stream_duration_ms, 9000);
    EXPECT_EQ (limits.max_stream_events, 11);
    EXPECT_EQ (limits.idle_timeout_ms, 3000);
}

// A hand-edited row is the only way past POST /config's bounds, and a ring of 0
// would quietly turn every stream into an empty one.
TEST_F (SseLimitsTest, AnOutOfRangeRowFallsBackToTheSeed) {
    set_config ("sseMaxRetainedEvents", "0");
    set_config ("sseIdleTimeoutMs", "-5");
    const auto limits = vayu::http::read_sse_limits (*db_);
    EXPECT_EQ (limits.max_retained_events, sse_constants::MAX_RETAINED_EVENTS);
    EXPECT_EQ (limits.idle_timeout_ms, sse_constants::IDLE_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// The consumer transfer
// ---------------------------------------------------------------------------

TEST (SseConsumer, RelaysAScriptedStreamAndEndsOnServerClose) {
    StreamServer server ({ "event: greeting\ndata: hello\n\n",
    "id: 7\ndata: one\ndata: two\n\n", ": keep-alive\n\n", "data: last\n\n" });
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (
    spec_for (server.url ("/scripted"), brisk_limits ()), context);

    EXPECT_EQ (response.status_code, 200);
    EXPECT_FALSE (response.has_error ());
    EXPECT_TRUE (context.closed ());
    EXPECT_EQ (context.end_reason (), SseEndReason::Completed);
    EXPECT_EQ (context.total_events (), 3);

    const auto payloads = ring_payloads (context);
    // The `open` frame first, so even a relay that attaches late replays what
    // the stream connected to.
    ASSERT_EQ (payloads.size (), 4u);
    EXPECT_EQ (payloads[0]["statusCode"], 200);
    EXPECT_EQ (payloads[1]["event"], "greeting");
    EXPECT_EQ (payloads[1]["data"], "hello");
    EXPECT_EQ (payloads[2]["data"], "one\ntwo");
    EXPECT_EQ (payloads[2]["sourceId"], "7");
    EXPECT_EQ (payloads[3]["data"], "last");
}

TEST (SseConsumer, EndsOnTheEventCapAndNamesIt) {
    StreamServer server;
    auto spec       = spec_for (server.url ("/endless"), brisk_limits ());
    spec.max_events = 5;
    SseStreamContext context ("run_test", brisk_limits ());
    vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (context.end_reason (), SseEndReason::MaxEvents);
    EXPECT_EQ (context.total_events (), 5);
}

TEST (SseConsumer, EndsOnTheDurationCapAndNamesIt) {
    StreamServer server;
    auto spec            = spec_for (server.url ("/endless"), brisk_limits ());
    spec.max_duration_ms = 150;
    SseStreamContext context ("run_test", brisk_limits ());
    const auto started = std::chrono::steady_clock::now ();
    vayu::http::consume_sse_stream (spec, context);
    const auto elapsed = std::chrono::steady_clock::now () - started;

    EXPECT_EQ (context.end_reason (), SseEndReason::MaxDuration);
    EXPECT_LT (elapsed, std::chrono::seconds (10));
}

// The no-events-for-N-seconds case. Without the low-speed options this transfer
// has no deadline at all and holds its worker until the process ends.
TEST (SseConsumer, EndsOnTheIdleTimeoutAndNamesIt) {
    StreamServer server;
    SseStreamContext context ("run_test", brisk_limits ());
    const auto started = std::chrono::steady_clock::now ();
    vayu::http::consume_sse_stream (
    spec_for (server.url ("/silent"), brisk_limits ()), context);
    const auto elapsed = std::chrono::steady_clock::now () - started;

    EXPECT_EQ (context.end_reason (), SseEndReason::Idle);
    EXPECT_LT (elapsed, std::chrono::seconds (20));
    EXPECT_EQ (context.total_events (), 0);
}

TEST (SseConsumer, StopsMidStreamWhenAsked) {
    StreamServer server;
    SseStreamContext context ("run_test", brisk_limits ());
    std::thread stopper ([&context] () {
        while (context.total_events () < 2) {
            std::this_thread::sleep_for (std::chrono::milliseconds (5));
        }
        context.should_stop.store (true);
    });
    vayu::http::consume_sse_stream (
    spec_for (server.url ("/endless"), brisk_limits ()), context);
    stopper.join ();

    EXPECT_EQ (context.end_reason (), SseEndReason::Stopped);
    EXPECT_GE (context.total_events (), 2);
}

// A transfer that never reached a server is a status-0 response with the error
// fields set - never an `Error`, which every /execute caller's `.value()`
// would throw on.
TEST (SseConsumer, AnUnreachableHostIsAFailedRunNotAThrow) {
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (
    spec_for ("http://127.0.0.1:1/nothing", brisk_limits ()), context);

    EXPECT_EQ (response.status_code, 0);
    EXPECT_TRUE (response.has_error ());
    EXPECT_EQ (context.end_reason (), SseEndReason::Error);
    EXPECT_TRUE (context.closed ());
}

TEST (SseConsumer, RecordsTheInitialResponseHeaders) {
    StreamServer server;
    auto spec = spec_for (server.url ("/silent"), brisk_limits ());
    SseStreamContext context ("run_test", brisk_limits ());
    std::thread stopper ([&context] () {
        std::this_thread::sleep_for (std::chrono::milliseconds (150));
        context.should_stop.store (true);
    });
    const auto response = vayu::http::consume_sse_stream (spec, context);
    stopper.join ();

    EXPECT_EQ (response.status_code, 200);
    EXPECT_EQ (response.headers.at ("x-fixture"), "silent");
}

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

TEST (SseRing, EvictsTheOldestAndFastForwardsAResumeBeforeTheWindow) {
    vayu::http::SseLimits limits;
    limits.max_retained_events = 4;
    SseStreamContext context ("run_test", limits);

    for (int i = 0; i < 10; ++i) {
        vayu::http::SseEvent event;
        event.data = std::to_string (i);
        context.record_event (event);
    }

    EXPECT_EQ (context.published_count (), 10u);
    EXPECT_EQ (context.total_events (), 10);
    EXPECT_EQ (context.events_since (0).payloads.size (), 4u);
    // A consumer resuming from an evicted id must adopt the producer's offset,
    // or it re-requests ids that will never come back.
    EXPECT_EQ (context.events_since (0).next_offset, 10u);
    EXPECT_TRUE (context.events_since (10).payloads.empty ());
    EXPECT_EQ (context.events_since (10).next_offset, 10u);
}

TEST (SseRing, FramesCarryTheirSlotAsTheirId) {
    SseStreamContext context ("run_test", vayu::http::SseLimits{});
    vayu::http::SseEvent event;
    event.data = "x";
    context.record_event (event);
    context.record_event (event);

    const auto frames = context.events_since (0).payloads;
    ASSERT_EQ (frames.size (), 2u);
    EXPECT_NE (frames[0].find ("id: 0\n"), std::string::npos);
    EXPECT_NE (frames[1].find ("id: 1\n"), std::string::npos);
}

TEST (SseRing, TheFirstEndReasonWins) {
    SseStreamContext context ("run_test", vayu::http::SseLimits{});
    context.close (SseEndReason::MaxEvents);
    context.close (SseEndReason::Completed);
    EXPECT_EQ (context.end_reason (), SseEndReason::MaxEvents)
    << "a close that followed a cap rewrote why the stream ended";
}

TEST (SseRing, DisclosesATruncatedEventInBand) {
    SseStreamContext context ("run_test", vayu::http::SseLimits{});
    vayu::http::SseEvent event;
    event.data       = "abc";
    event.truncated  = true;
    event.data_bytes = 4096;
    context.record_event (event);

    const auto payloads = ring_payloads (context);
    ASSERT_EQ (payloads.size (), 1u);
    EXPECT_TRUE (payloads[0]["dataTruncated"].get<bool> ());
    EXPECT_EQ (payloads[0]["dataBytes"], 4096);
}

// ---------------------------------------------------------------------------
// The trace node
// ---------------------------------------------------------------------------

TEST (SseTrace, StoresUpToTheCapAndMarksTheRest) {
    vayu::http::SseLimits limits;
    limits.max_stored_events = 3;
    SseStreamContext context ("run_test", limits);
    for (int i = 0; i < 9; ++i) {
        vayu::http::SseEvent event;
        event.data = std::to_string (i);
        context.record_event (event);
    }
    context.close (SseEndReason::MaxEvents);

    const auto node = vayu::http::stream_trace_node (context);
    EXPECT_EQ (node["items"].size (), 3u);
    EXPECT_EQ (node["totalEvents"], 9);
    EXPECT_TRUE (node["eventsTruncated"].get<bool> ());
    EXPECT_EQ (node["endReason"], "maxStreamEvents");
}

// Truthful rather than derived from the cap: a stream that fit must not be
// reported as truncated, or the marker means nothing.
TEST (SseTrace, AStreamThatFitIsNotMarkedTruncated) {
    SseStreamContext context ("run_test", vayu::http::SseLimits{});
    vayu::http::SseEvent event;
    event.data = "only";
    context.record_event (event);
    context.close (SseEndReason::Completed);

    const auto node = vayu::http::stream_trace_node (context);
    EXPECT_EQ (node["items"].size (), 1u);
    EXPECT_FALSE (node["eventsTruncated"].get<bool> ());
}

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

    while (context->total_events () < 1) {
        std::this_thread::sleep_for (std::chrono::milliseconds (5));
    }
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
        while (context->total_events () < 1) {
            std::this_thread::sleep_for (std::chrono::milliseconds (5));
        }
    }
    SUCCEED ();
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
        ctx_ = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, false,
        nullptr, authorize_manager_, cookie_jar_, mock_issuer_manager_,
        inbox_manager_, mock_server_manager_, manager_ });
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
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// A finished stream of @p count events, consumed for real off the fixture
    /// so the relay replays what a transfer actually produced.
    std::shared_ptr<SseStreamContext> streamed (int count) {
        std::vector<std::string> chunks;
        for (int i = 0; i < count; ++i) {
            chunks.push_back ("data: " + std::to_string (i) + "\n\n");
        }
        origin_ = std::make_unique<StreamServer> (std::move (chunks));
        auto context =
        manager_.start (spec_for (origin_->url ("/scripted"), brisk_limits ()));
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (10);
        while (context && !context->closed () && std::chrono::steady_clock::now () < deadline) {
            std::this_thread::sleep_for (std::chrono::milliseconds (5));
        }
        return context;
    }

    httplib::Client client () {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        return client;
    }

    void set_config (const char* key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_TRUE (entry.has_value ()) << key;
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
    SseStreamManager manager_;
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

// The dropped-consumer case: a client that saw through frame 1 asks for what
// followed it, and must not be re-sent what it already rendered.
TEST_F (RelayTest, ResumesAfterTheLastFrameSeen) {
    ASSERT_NE (streamed (3), nullptr);

    auto response = client ().Get ("/runs/run_test/events?lastEventId=1");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 200);
    EXPECT_EQ (response->body.find ("id: 0\n"), std::string::npos)
    << "a resumed stream replayed a frame the client had already seen";
    EXPECT_EQ (response->body.find ("id: 1\n"), std::string::npos);
    EXPECT_NE (response->body.find ("id: 2\n"), std::string::npos);
    EXPECT_NE (response->body.find ("event: complete"), std::string::npos);
}

// Frame ids start at 0, so "0" is a real resume point rather than a stand-in
// for absent - resuming from it must skip exactly the first frame.
TEST_F (RelayTest, ResumingFromZeroSkipsOnlyTheFirstFrame) {
    ASSERT_NE (streamed (2), nullptr);

    auto response = client ().Get ("/runs/run_test/events?lastEventId=0");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->body.find ("id: 0\n"), std::string::npos);
    EXPECT_NE (response->body.find ("id: 1\n"), std::string::npos);
}

TEST_F (RelayTest, AGarbledResumePointIs400RatherThanASilentReplay) {
    ASSERT_NE (streamed (2), nullptr);

    auto response = client ().Get ("/runs/run_test/events?lastEventId=abc");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 400);
    EXPECT_NE (response->body.find ("invalid_last_event_id"), std::string::npos);
}

// Each stream parks a cpp-httplib pool thread for its whole life, so a second
// concurrent watcher is refused rather than quietly parking another.
TEST_F (RelayTest, ASecondConcurrentWatcherIsRefused) {
    auto context = streamed (1);
    ASSERT_NE (context, nullptr);
    const auto held = context->try_claim ();
    ASSERT_TRUE (held.has_value ());

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

TEST_F (RelayTest, AnExpiredStreamIsSweptAndReads404) {
    ASSERT_NE (streamed (1), nullptr);
    set_config ("liveRetentionMs", "0");

    auto response = client ().Get ("/runs/run_test/events");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 404);
    EXPECT_EQ (manager_.size (), 0u);
}

// ---------------------------------------------------------------------------
// Scripts over a stream (issue #575)
//
// Driven through the real `POST /execute` handler rather than through
// `consume_sse_stream`, because the thing under test is precisely the wiring
// the route owns: which scripts run, on which thread, against which event list,
// and where their results are stored. A test that called the pieces directly
// would pass with the route handing the post-request script a *copy* of the
// events node - the drift the shared pointer exists to prevent.
// ---------------------------------------------------------------------------

/// `POST /execute` and `GET /runs/:id/events` on one real server, so a
/// streaming send can be driven the way a client drives it.
class StreamExecuteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_sse_execute.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        ctx_ = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, false,
        nullptr, authorize_manager_, cookie_jar_, mock_issuer_manager_,
        inbox_manager_, mock_server_manager_, manager_ });
        vayu::http::routes::register_execution_routes (*ctx_);
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
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// An origin that writes @p count events, one per chunk, paced so the
    /// consumer really does assemble them over time.
    void serve (int count) {
        std::vector<std::string> chunks;
        for (int i = 0; i < count; ++i) {
            chunks.push_back ("id: e" + std::to_string (i) +
            "\nevent: tick\ndata: {\"n\": " + std::to_string (i) + "}\n\n");
        }
        origin_ = std::make_unique<StreamServer> (std::move (chunks));
        origin_->pace (2);
    }

    /// Send @p payload as a streaming execute and return the run id it created.
    std::string start (json payload) {
        payload["method"] = "GET";
        payload["url"]    = origin_->url ("/scripted");
        payload["stream"] = true;
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post ("/execute", payload.dump (), "application/json");
        EXPECT_TRUE (response);
        if (!response) {
            return {};
        }
        EXPECT_EQ (response->status, 202) << response->body;
        return json::parse (response->body).value ("runId", std::string ());
    }

    /// The stored trace, once the run has reached a terminal status. Polled off
    /// the row rather than the manager: the trace is written by the worker's
    /// completion callback, and the row's status is what says it has run.
    json trace_for (const std::string& run_id) {
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (15);
        while (std::chrono::steady_clock::now () < deadline) {
            auto results = db_->get_results (run_id);
            if (!results.empty ()) {
                return json::parse (results[0].trace_data);
            }
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
        }
        ADD_FAILURE () << "no result row was ever stored for " << run_id;
        return json::object ();
    }

    void set_config (const char* key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_TRUE (entry.has_value ()) << key;
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
    SseStreamManager manager_;
    std::unique_ptr<vayu::http::routes::RouteContext> ctx_;
    std::unique_ptr<StreamServer> origin_;
};

// The acceptance criterion: a script asserts over what the stream delivered,
// and the entries carry the shape the surface promises.
TEST_F (StreamExecuteTest, TheStreamsPostRequestScriptSeesItsEvents) {
    serve (3);
    const auto run_id = start (json{ { "postRequestScript", R"JS(
        pm.test('three events', function () {
            pm.expect(pm.response.events.length).to.equal(3);
        });
        pm.test('names and ids came through', function () {
            pm.expect(pm.response.events[0].event).to.equal('tick');
            pm.expect(pm.response.events[0].id).to.equal('e0');
            pm.expect(JSON.parse(pm.response.events[2].data).n).to.equal(2);
        });
        pm.test('the whole stream is here', function () {
            pm.expect(pm.response.totalEvents).to.equal(3);
            pm.expect(pm.response.eventsTruncated).to.equal(false);
        });
    )JS" } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    const auto& scripts = trace["scripts"];
    ASSERT_TRUE (scripts.contains ("testResults")) << scripts.dump (2);
    ASSERT_EQ (scripts["testResults"].size (), 3u);
    for (const auto& test : scripts["testResults"]) {
        EXPECT_TRUE (test["passed"].get<bool> ())
        << test["name"] << ": " << test.value ("error", "");
    }
    EXPECT_FALSE (scripts.contains ("postScriptError")) << scripts.dump (2);
}

// The other half of the same fact: what the script read and what the trace
// stored are one node, so a reader of either sees the same truncation.
TEST_F (StreamExecuteTest, TruncationIsVisibleToTheScriptAndMatchesTheTrace) {
    set_config ("sseMaxStoredEvents", "2");
    serve (5);
    const auto run_id = start (json{ { "postRequestScript", R"JS(
        pm.test('the list is a prefix and says so', function () {
            pm.expect(pm.response.eventsTruncated).to.equal(true);
            pm.expect(pm.response.events.length).to.equal(2);
            pm.expect(pm.response.totalEvents).to.equal(5);
        });
    )JS" } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    ASSERT_EQ (trace["scripts"]["testResults"].size (), 1u);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
    // Stated twice on purpose: the assertion above proves the script saw it,
    // and this proves the stored node the app restores from says the same.
    EXPECT_TRUE (trace["events"]["eventsTruncated"].get<bool> ());
    EXPECT_EQ (trace["events"]["totalEvents"], 5);
    EXPECT_EQ (trace["events"]["items"].size (), 2u);
}

// A pre-request script on a stream is not a special case - it edits the request
// that goes on the wire, exactly as it does on a buffered send. Proven off the
// origin's own record of what arrived, not off the plan.
TEST_F (StreamExecuteTest, ThePreRequestScriptsEditReachesTheWire) {
    serve (1);
    const auto run_id = start (
    json{ { "preRequestScript", "pm.request.headers.add({ key: 'X-From-Script', value: 'yes' });" },
    { "postRequestScript", R"JS(
        pm.test('the stream still ran', function () {
            pm.expect(pm.response.events.length).to.equal(1);
        });
    )JS" } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ());
    EXPECT_EQ (origin_->received_header ("X-From-Script"), "yes");
}

// Absent, not empty. A stream that produced nothing has an empty list; a
// response that was never a stream has no list at all, and `typeof` is what
// tells them apart.
TEST_F (StreamExecuteTest, AnOrdinarySendHasNoEventsSurfaceAtAll) {
    serve (1);
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    const json payload = { { "method", "GET" },
        { "url", origin_->url ("/scripted") }, { "postRequestScript", R"JS(
        pm.test('not a stream', function () {
            pm.expect(typeof pm.response.events).to.equal('undefined');
            pm.expect(typeof pm.response.totalEvents).to.equal('undefined');
            pm.expect(typeof pm.response.eventsTruncated).to.equal('undefined');
        });
    )JS" } };

    auto response = client.Post ("/execute", payload.dump (), "application/json");
    ASSERT_TRUE (response);
    ASSERT_EQ (response->status, 200) << response->body;
    const auto body = json::parse (response->body);
    ASSERT_TRUE (body.contains ("testResults")) << body.dump (2);
    EXPECT_TRUE (body["testResults"][0]["passed"].get<bool> ())
    << body["testResults"][0].value ("error", "");
}

// A stream with no scripts stores no `scripts` node - an empty one would put an
// always-empty Tests pane on every streamed response.
TEST_F (StreamExecuteTest, AStreamWithoutScriptsStoresNoScriptNode) {
    serve (2);
    const auto run_id = start (json::object ());
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_FALSE (trace.contains ("scripts")) << trace.dump (2);
    EXPECT_EQ (trace["events"]["items"].size (), 2u);
}

// Malformed frames are the origin's problem, not the run's: the parser drops
// them and the stream still terminates by a rule that names itself, with the
// events that were well formed intact.
TEST_F (StreamExecuteTest, MalformedFramesAreDroppedAndTheRunStillCompletes) {
    origin_ = std::make_unique<StreamServer> (std::vector<std::string>{
    ": a comment line, dispatched to nobody\n\n", "event: no-data-so-never-dispatched\n\n",
    "data: kept\n\n", "retry: notanumber\ndata: also kept\n\n" });
    const auto run_id = start (json{ { "postRequestScript", R"JS(
        pm.test('only the frames that carried data arrived', function () {
            pm.expect(pm.response.totalEvents).to.equal(2);
            pm.expect(pm.response.events[0].data).to.equal('kept');
            pm.expect(pm.response.events[1].data).to.equal('also kept');
        });
    )JS" } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
    EXPECT_EQ (trace["events"]["endReason"], "completed");
}

} // namespace
