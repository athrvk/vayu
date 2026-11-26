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
 *
 * This file holds the `stream` flag, the consumer, the event ring and the stored events;
 * the manager and relay are in `sse_stream_relay_test.cpp` and the execute routes in
 * `sse_stream_execute_test.cpp` and `sse_stream_execute_body_test.cpp`.
 *
 * The in-process SSE server, the helpers shared by these files and the `StreamExecuteTest`
 * fixture are in `sse_stream_fixture.hpp`.
 */

// First, before anything that includes <httplib.h>: see the header. Needed
// for `proxy_server.hpp`, whose forwarder builds an `httplib::Client` from a URL.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <memory>
#include <numeric>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "proxy_server.hpp"
#include "silent_listener.hpp"
#include "temp_database.hpp"
#include "timed_out_after.hpp"
#include "tls_server.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/json_path.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/utils/encoding.hpp"
#include "wait_until.hpp"

#include "sse_stream_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::http::SseEndReason;
using vayu::http::SseStreamContext;
using vayu::http::routes::read_stream_flag;
namespace sse_constants = vayu::core::constants::sse;
using vayu::tests::sse_stream::brisk_limits;
using vayu::tests::sse_stream::chat_completion_chunks;
using vayu::tests::sse_stream::open_frames;
using vayu::tests::sse_stream::OPENAI_CONTENT;
using vayu::tests::sse_stream::ring_payloads;
using vayu::tests::sse_stream::spec_for;
using vayu::tests::sse_stream::StreamServer;

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
    // Every spelling a payload can carry, read through `read_script`'s one
    // name table.
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
    ASSERT_HAS_VALUE (flag.max_duration_ms);
    EXPECT_EQ (*flag.max_duration_ms, 5000);
    ASSERT_HAS_VALUE (flag.max_events);
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

TEST (StreamFlag, ReadsATextPath) {
    const auto flag = read_stream_flag (
    json{ { "stream", true }, { "streamTextPath", "$.choices[0].delta.content" } });
    ASSERT_TRUE (flag.ok) << flag.error;
    ASSERT_HAS_VALUE (flag.text_path);
    EXPECT_EQ (*flag.text_path, "$.choices[0].delta.content");

    const auto none =
    read_stream_flag (json{ { "stream", true }, { "streamTextPath", nullptr } });
    ASSERT_TRUE (none.ok) << none.error;
    EXPECT_FALSE (none.text_path.has_value ());
}

// A path outside the subset the elements read, or not a string at all, is a
// 400 naming the field, never a stream whose events silently carry no text.
TEST (StreamFlag, ATextPathOutsideTheSubsetIsRefused) {
    for (const json& path :
    { json ("choices[0]"), json ("$[?(@.x)]"), json (""), json (7) }) {
        SCOPED_TRACE (path.dump ());
        const auto flag =
        read_stream_flag (json{ { "stream", true }, { "streamTextPath", path } });
        EXPECT_FALSE (flag.ok);
        EXPECT_NE (flag.error.find ("streamTextPath"), std::string::npos)
        << flag.error;
    }
}

// A text path on a buffered send promises `text` no event will carry.
TEST (StreamFlag, ATextPathWithoutTheFlagIsRefused) {
    const auto flag = read_stream_flag (json{ { "streamTextPath", "$.delta.text" } });
    EXPECT_FALSE (flag.ok);
    EXPECT_NE (flag.error.find ("streamTextPath"), std::string::npos) << flag.error;
}

// `POST /execute` takes a first content marker (#3774) beside a stream, so a
// by-id compose's payload sends as it is, and refuses one it could not use: a
// 400 naming the field, never the constructor's `invalid_argument` as a 500.
// Mutation check: drop `check_stream_first_content_marker` from
// `read_stream_flag` and the bad markers pass.
TEST (StreamFlag, AFirstContentMarkerIsCheckedBesideTheFlag) {
    const auto flag = read_stream_flag (json{
    { "stream", true }, { "streamFirstContentMarker", "content_block_delta" } });
    EXPECT_TRUE (flag.ok) << flag.error;
    EXPECT_TRUE (read_stream_flag (
    json{ { "stream", true }, { "streamFirstContentMarker", nullptr } })
    .ok);

    constexpr std::size_t LIMIT = vayu::core::constants::sse::MAX_FIRST_CONTENT_MARKER_BYTES;
    for (const json& marker : { json (""), json (7),
         json (std::string (LIMIT + 1, 'x')), json (std::string ("a\0b", 3)) }) {
        SCOPED_TRACE (marker.dump ());
        const auto bad = read_stream_flag (
        json{ { "stream", true }, { "streamFirstContentMarker", marker } });
        EXPECT_FALSE (bad.ok);
        EXPECT_NE (bad.error.find ("streamFirstContentMarker"), std::string::npos)
        << bad.error;
    }

    const auto buffered =
    read_stream_flag (json{ { "streamFirstContentMarker", "content_block_delta" } });
    EXPECT_FALSE (buffered.ok);
    EXPECT_NE (buffered.error.find ("streaming request only"), std::string::npos)
    << buffered.error;
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
        ASSERT_HAS_VALUE (entry) << key;
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
    // Recorded, not closed: closing is the owner's, once the result is stored.
    EXPECT_FALSE (context.closed ());
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

// Three events arrive in one write: the cap stops the callback mid-chunk, and
// the parser still holds the unterminated `c`. Flushing it at the end would
// store [a, c] - the cap plus one, with `b` skipped.
TEST (SseConsumer, TheEventCapStoresExactlyTheFirstEventsOfAOneWritePack) {
    StreamServer server ({ "data: a\n\ndata: b\n\ndata: c" });
    auto spec       = spec_for (server.url ("/scripted"), brisk_limits ());
    spec.max_events = 1;
    SseStreamContext context ("run_test", brisk_limits ());
    vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (context.end_reason (), SseEndReason::MaxEvents);
    EXPECT_EQ (context.total_events (), 1);

    const auto payloads = ring_payloads (context);
    // The `open` frame, then the one event.
    ASSERT_EQ (payloads.size (), 2u);
    EXPECT_EQ (payloads[1]["data"], "a");
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

// The no-events-for-N-seconds case. The stream has no whole-transfer deadline,
// so without the idle rule it holds its worker until the process ends.
//
// The window is 1000 ms and the rule is judged from libcurl's progress
// callback, about once a second while quiet: a healthy engine ends the stream
// at about 1.0 to 2.0 s (the clock arms at the first call after the connection
// is made, and the next call after the window ends it). The bound is the
// setting plus three seconds, because the upper side is the one a slow runner
// can push. The broken readings it separates from: #3241 measured about 7 s
// when `CURLOPT_LOW_SPEED_TIME` judged the silence (libcurl averaged the speed
// over about five seconds; libcurl 8.23 does not reproduce that), and a rule
// that never fires ends at the 30 s duration cap. Mutation checks: add 4 s to the rule's threshold and
// the upper bound fails; end at the first progress call and the lower fails.
TEST (SseConsumer, EndsOnTheIdleTimeoutAndNamesIt) {
    StreamServer server;
    const auto limits = brisk_limits ();
    SseStreamContext context ("run_test", limits);
    const auto started = std::chrono::steady_clock::now ();
    vayu::http::consume_sse_stream (spec_for (server.url ("/silent"), limits), context);
    const auto elapsed = std::chrono::steady_clock::now () - started;

    EXPECT_EQ (context.end_reason (), SseEndReason::Idle);
    EXPECT_GE (elapsed, std::chrono::milliseconds (limits.idle_timeout_ms));
    EXPECT_LE (elapsed, std::chrono::milliseconds (limits.idle_timeout_ms + 3000));
    EXPECT_EQ (context.total_events (), 0);
}

TEST (SseConsumer, StopsMidStreamWhenAsked) {
    StreamServer server;
    SseStreamContext context ("run_test", brisk_limits ());
    std::thread stopper ([&context] () {
        while (context.total_events () < 2) {
            std::this_thread::sleep_for (std::chrono::milliseconds (5));
        }
        context.request_stop ();
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
    // Failed, but a transfer ran: its timing is a measurement (#2384).
    EXPECT_TRUE (response.transfer_attempted);
    EXPECT_EQ (context.end_reason (), SseEndReason::Error);
    EXPECT_FALSE (context.closed ());
}

// A handshake that never finishes is the connect bound, min(timeout, 30s), and
// fails the run like a refused connect rather than naming the idle timeout
// (#2835). Mutation check: map every CURLE_OPERATION_TIMEDOUT to Idle again in
// `consume_sse_stream` and the end reason reads Idle with no error code.
TEST (SseConsumer, AHungHandshakeIsATimeoutErrorNotIdle) {
    vayu::tests::SilentListener listener;
    ASSERT_NE (listener.port (), 0);
    auto spec = spec_for (listener.url ("https"), brisk_limits ());
    spec.request.timeout_ms = 1000;
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Error);
    EXPECT_EQ (response.status_code, 0);
    EXPECT_EQ (response.error_code, vayu::ErrorCode::Timeout) << response.error_message;
    const auto after_ms = vayu::tests::timed_out_after_ms (response.error_message);
    ASSERT_HAS_VALUE (after_ms) << response.error_message;
    EXPECT_GE (*after_ms, 1000) << response.error_message;
}

// The companion: the same listener over plain HTTP takes the request and says
// nothing, which is silence on a made connection and stays Idle.
TEST (SseConsumer, SilenceAfterTheConnectionIsMadeStaysIdle) {
    vayu::tests::SilentListener listener;
    ASSERT_NE (listener.port (), 0);
    auto spec               = spec_for (listener.url ("http"), brisk_limits ());
    spec.request.timeout_ms = 1000;
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Idle) << response.error_message;
    EXPECT_EQ (response.error_code, vayu::ErrorCode::None) << response.error_message;
}

// A redirect response's header lines stamp the idle clock, and the next hop's
// DNS, TCP and TLS then run in silence that is the connect bound's to judge,
// not the idle window's (#3241). libcurl runs no progress callback while a hop
// connects, so a slow connect cannot be seen to go wrong from inside it; the
// stale stamp is found by the first call after the hop is made.
//
// The hop's handshake waits 1500 ms against the 1000 ms floor and then
// succeeds. Broken, the first progress call after the connect reads a stamp
// 1.5 s old and ends the stream Idle; fixed, that call arms the clock and the
// two-event stream completes. The delay is a lower bound on the stale stamp, so
// a slow runner only makes the broken reading likelier, and the fixed one
// holds as long as the answer comes inside the 1000 ms window on loopback.
// Mutation check: end the idle rule's hop check at `requests_started == 0`
// (the pre-fix connected test) with `last_byte_hop` ignored and this reads Idle.
TEST (SseConsumer, ASlowRedirectHopIsNotIdleWhileItConnects) {
    const vayu::tests::TestCertificateAuthority ca;
    const vayu::tests::TlsServer target (ca, std::chrono::milliseconds (1500));
    StreamServer server;
    server.hop_to (target.url ("/events"));
    auto spec               = spec_for (server.url ("/hop"), brisk_limits ());
    spec.request.verify_ssl = false;
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Completed) << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    EXPECT_EQ (context.total_events (), 2);
}

// The same redirect to a hop whose handshake never finishes is the connect
// bound's timeout error, never Idle. The libcurl the engine builds against
// runs no progress callback during that wait, so this holds the classification
// end to end rather than the clock: it passes with or without the hop check,
// and the slow-hop test above is the one that fails without it. The bound is
// 10 s against the 1000 ms floor, and the healthy reading is Error at the
// bound.
TEST (SseConsumer, ARedirectHopThatNeverConnectsIsATimeoutErrorNotIdle) {
    vayu::tests::SilentListener listener;
    ASSERT_NE (listener.port (), 0);
    StreamServer server;
    server.hop_to (listener.url ("https"));
    auto spec               = spec_for (server.url ("/hop"), brisk_limits ());
    spec.request.timeout_ms = 10000;
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Error);
    EXPECT_EQ (response.error_code, vayu::ErrorCode::Timeout) << response.error_message;
}

// ---------------------------------------------------------------------------
// The stream follows its own redirects (#3301)
//
// One transfer per hop through the shared `RedirectChain`, so everything a
// stream counts spans the chain and a followed hop's body is the chain's to
// drop. The mTLS hop is in `mutual_tls_test.cpp`.
// ---------------------------------------------------------------------------

// The 302 is itself shaped as an event stream, so a body that reached the
// stream would publish an `open` for the redirect, dispatch its event and count
// its bytes. Mutation checks: announce at the end of every header block (drop
// the `discard` condition in `stream_header_callback`) and two frames are
// published; drop the `discard` return in `stream_write_callback` and the
// redirect's event is recorded.
TEST (SseConsumer, AFollowedRedirectsBodyIsNoPartOfTheStream) {
    StreamServer server;
    server.hop_body ("text/event-stream", "data: from-the-redirect\n\n");
    server.can (200, "text/event-stream", { "data: a\n\n" });
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (
    spec_for (server.url ("/hop"), brisk_limits ()), context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Completed) << response.error_message;
    const auto opens = open_frames (context);
    ASSERT_EQ (opens.size (), 1u);
    EXPECT_EQ (opens[0]["statusCode"], 200);
    EXPECT_EQ (context.total_events (), 1);
    const auto payloads = ring_payloads (context);
    ASSERT_EQ (payloads.size (), 2u);
    EXPECT_EQ (payloads[1]["data"], "a");
    ASSERT_HAS_VALUE (response.stream_body_bytes);
    EXPECT_EQ (*response.stream_body_bytes, 9u);
}

// With `followRedirects` off the 302 is the stream's answer: its own `open`,
// its body kept, and the target never asked.
TEST (SseConsumer, ARedirectNotFollowedIsTheStreamsAnswer) {
    StreamServer server;
    auto spec = spec_for (server.url ("/hop"), brisk_limits ());
    spec.request.follow_redirects = false;
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Completed) << response.error_message;
    EXPECT_EQ (response.status_code, 302);
    EXPECT_EQ (response.body, R"({"hop":"first"})");
    const auto opens = open_frames (context);
    ASSERT_EQ (opens.size (), 1u);
    EXPECT_EQ (opens[0]["statusCode"], 302);
    EXPECT_EQ (server.requests_received (), 0);
}

// `/hop` redirects to itself, so its third answer would be the third redirect
// followed against a limit of two: the chain refuses it, in libcurl's words.
TEST (SseConsumer, ARedirectPastTheLimitIsTooManyRedirects) {
    StreamServer server;
    server.hop_to (server.url ("/hop"));
    auto spec = spec_for (server.url ("/hop"), brisk_limits ());
    spec.request.max_redirects = 2;
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Error);
    EXPECT_EQ (response.status_code, 0);
    EXPECT_EQ (response.error_code, vayu::ErrorCode::TooManyRedirects)
    << response.error_message;
    EXPECT_NE (response.error_message.find ("Maximum (2) redirects followed"),
    std::string::npos)
    << response.error_message;
    EXPECT_EQ (server.hops_received (), 3);
    EXPECT_TRUE (response.transfer_attempted);
    EXPECT_TRUE (open_frames (context).empty ());
}

// A `Location` naming a scheme the engine does not send is the chain's
// refusal, not a hop: nothing is dialled for it.
TEST (SseConsumer, ARedirectToAnotherSchemeIsRefused) {
    StreamServer server;
    server.hop_to ("ftp://127.0.0.1/file");
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (
    spec_for (server.url ("/hop"), brisk_limits ()), context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Error);
    EXPECT_EQ (response.status_code, 0);
    EXPECT_EQ (response.error_code, vayu::ErrorCode::InvalidUrl) << response.error_message;
    EXPECT_NE (response.error_message.find (R"(Protocol "ftp" is disabled (in redirect))"),
    std::string::npos)
    << response.error_message;
}

// `localhost` is another origin than `127.0.0.1` on the same listener, so the
// hop there goes without `Authorization` and the same-origin hop keeps it.
TEST (SseConsumer, AuthorizationStaysWithTheOriginTheStreamStartedAt) {
    StreamServer server ({ "data: a\n\n" });
    auto spec            = spec_for (server.url ("/hop"), brisk_limits ());
    spec.request.headers = { { "Authorization", "Bearer secret" } };

    server.hop_to (server.url ("/scripted"));
    SseStreamContext same_origin ("run_test", brisk_limits ());
    vayu::http::consume_sse_stream (spec, same_origin);
    EXPECT_EQ (same_origin.end_reason (), SseEndReason::Completed);
    EXPECT_EQ (server.received_header ("Authorization"), "Bearer secret");

    std::string elsewhere = server.url ("/scripted");
    elsewhere.replace (elsewhere.find ("127.0.0.1"), 9, "localhost");
    server.hop_to (elsewhere);
    SseStreamContext other_origin ("run_test", brisk_limits ());
    vayu::http::consume_sse_stream (spec, other_origin);
    EXPECT_EQ (other_origin.end_reason (), SseEndReason::Completed);
    EXPECT_EQ (server.requests_received (), 2);
    EXPECT_EQ (server.received_header ("Authorization"), "");
}

// The redirect takes 1000 ms and the stream behind it 2400 ms more (sixteen
// writes 150 ms apart), each inside the 3000 ms cap and the two together past
// it, with 2 s of slack for the first hop on a slow runner. The sleeps are lower bounds, so the healthy reading, the cap ending the
// stream on its second hop, only comes earlier in the stream on a slow runner;
// a clock restarted per hop lets the second hop complete. The idle window is
// widened past the redirect's wait, which is silence on a made connection.
// Mutation check: reset `started_at` before each hop in `run_stream_chain` and
// this reads Completed with all sixteen events.
TEST (SseConsumer, TheDurationCapCountsFromTheFirstHop) {
    StreamServer server (std::vector<std::string> (16, "data: tick\n\n"));
    server.pace (150);
    server.delay_hop (1000);
    server.hop_to (server.url ("/scripted"));
    auto limits            = brisk_limits ();
    limits.idle_timeout_ms = 10000;
    auto spec              = spec_for (server.url ("/hop"), limits);
    spec.max_duration_ms   = 3000;
    SseStreamContext context ("run_test", limits);
    const auto response = vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (context.end_reason (), SseEndReason::MaxDuration) << response.error_message;
    EXPECT_EQ (server.requests_received (), 1);
    EXPECT_LT (context.total_events (), 16);
}

// The idle window holds on a redirect hop as on the final one: `/hop` takes
// the request and says nothing for 6 s against the 1000 ms window, so the
// stream ends Idle there (about 1 to 2 s in) and the target is never asked.
// Mutation check: make `hop_connected` wait for a second request past the
// hop's baseline and the redirect is answered, so the stream reads Completed.
TEST (SseConsumer, ASilentRedirectHopEndsIdle) {
    StreamServer server;
    server.delay_hop (6000);
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (
    spec_for (server.url ("/hop"), brisk_limits ()), context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Idle) << response.error_message;
    EXPECT_EQ (response.error_code, vayu::ErrorCode::None) << response.error_message;
    EXPECT_EQ (server.requests_received (), 0);
}

TEST (SseConsumer, RecordsTheInitialResponseHeaders) {
    StreamServer server;
    auto spec = spec_for (server.url ("/silent"), brisk_limits ());
    SseStreamContext context ("run_test", brisk_limits ());
    // The idle timeout ends the silent stream, so no stop races the headers:
    // a stop after a fixed delay landed before them on a slow runner.
    const auto response = vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (response.status_code, 200);
    EXPECT_EQ (response.headers.at ("x-fixture"), "silent");
}

// ---------------------------------------------------------------------------
// What the reply's bytes become (issues #3238, #3770)
//
// Every reply's bytes are its body, up to the design bound, and an event
// stream's are its events as well. Every stream counts what it was delivered.
// ---------------------------------------------------------------------------

// Mutation check: drop the `hold_body_bytes` call in `stream_write_callback`
// and the body reads "".
TEST (SseConsumer, AReplyThatIsNotAnEventStreamKeepsItsBody) {
    StreamServer server;
    server.can (200, "application/x-ndjson", { "{\"n\":1}\n", "{\"n\":2}\n" });
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (
    spec_for (server.url ("/canned"), brisk_limits ()), context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Completed);
    EXPECT_EQ (response.body, "{\"n\":1}\n{\"n\":2}\n");
    EXPECT_EQ (response.body_size, response.body.size ());
    EXPECT_FALSE (response.body_truncated);
    ASSERT_HAS_VALUE (response.stream_body_bytes);
    EXPECT_EQ (*response.stream_body_bytes, 16u);
    // NDJSON lines are no SSE field the parser knows, so nothing dispatches.
    EXPECT_EQ (context.total_events (), 0);
}

// An event stream's bytes are its body too (#3770), held to the same bound,
// and they are still its events. Mutation check: drop the `hold_body_bytes`
// call in `stream_write_callback` and the body reads "".
TEST (SseConsumer, AnEventStreamKeepsItsBytesAsItsBody) {
    StreamServer server ({ "data: a\n\n", "data: bb\n\n" });
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (
    spec_for (server.url ("/scripted"), brisk_limits ()), context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Completed);
    EXPECT_EQ (response.body, "data: a\n\ndata: bb\n\n");
    EXPECT_EQ (response.body_size, response.body.size ());
    EXPECT_FALSE (response.body_truncated);
    EXPECT_EQ (context.total_events (), 2);

    auto spec           = spec_for (server.url ("/scripted"), brisk_limits ());
    spec.max_body_bytes = 4;
    SseStreamContext cut_context ("run_test", brisk_limits ());
    const auto cut = vayu::http::consume_sse_stream (spec, cut_context);

    EXPECT_EQ (cut.body, "data");
    EXPECT_EQ (cut.body_size, 4u);
    EXPECT_TRUE (cut.body_truncated);
    ASSERT_HAS_VALUE (cut.stream_body_bytes);
    EXPECT_EQ (*cut.stream_body_bytes, 19u);
    // The bound holds the body, never the stream: every event still arrives.
    EXPECT_EQ (cut_context.total_events (), 2);
}

// Mutation check: count the bytes `hold_body_bytes` kept rather than the
// chunk's, and the capped reply reads 4.
TEST (SseConsumer, EveryStreamCountsWhatItWasDelivered) {
    StreamServer server ({ "data: a\n\n", "data: bb\n\n" });
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (
    spec_for (server.url ("/scripted"), brisk_limits ()), context);

    EXPECT_EQ (context.total_events (), 2);
    EXPECT_EQ (response.body, "data: a\n\ndata: bb\n\n");
    ASSERT_HAS_VALUE (response.stream_body_bytes);
    EXPECT_EQ (*response.stream_body_bytes, 19u);

    StreamServer plain;
    plain.can (200, "text/plain", { "0123456789", "abcdef" });
    auto spec           = spec_for (plain.url ("/canned"), brisk_limits ());
    spec.max_body_bytes = 4;
    SseStreamContext plain_context ("run_test", brisk_limits ());
    const auto cut = vayu::http::consume_sse_stream (spec, plain_context);

    EXPECT_EQ (cut.body, "0123");
    EXPECT_EQ (cut.body_size, 4u);
    EXPECT_TRUE (cut.body_truncated);
    ASSERT_HAS_VALUE (cut.stream_body_bytes);
    EXPECT_EQ (*cut.stream_body_bytes, 16u);
}

// The final hop's bytes are the body, not the redirect's: `/hop` answers 302
// with JSON and the stream it lands on is SSE. The chain discards a followed
// hop's body before the write callback holds or counts it. Mutation check:
// drop the `discard` return in `stream_write_callback` and the body starts
// with the redirect's JSON.
TEST (SseConsumer, TheFinalHopsBytesAreTheBody) {
    StreamServer server;
    server.can (200, "text/event-stream", { "data: a\n\n" });
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (
    spec_for (server.url ("/hop"), brisk_limits ()), context);

    EXPECT_EQ (response.status_code, 200);
    EXPECT_EQ (context.total_events (), 1);
    EXPECT_EQ (response.body, "data: a\n\n");
    ASSERT_HAS_VALUE (response.stream_body_bytes);
    EXPECT_EQ (*response.stream_body_bytes, 9u);
}

// ---------------------------------------------------------------------------
// The `open` frame without a body (#3342)
//
// A reply that ends at its headers still opens, once, with its status: the
// frame is announced at the end of the final header block, not at a body byte.
// ---------------------------------------------------------------------------

// Mutation check: announce from the first body byte again (the write
// callback) and every case publishes no `open`.
TEST (SseConsumer, AReplyWithNoBodyStillOpensOnceWithItsStatus) {
    for (const int status : { 204, 401, 200 }) {
        SCOPED_TRACE (status);
        StreamServer server;
        server.bodiless (status);
        SseStreamContext context ("run_test", brisk_limits ());
        const auto response = vayu::http::consume_sse_stream (
        spec_for (server.url ("/bodiless"), brisk_limits ()), context);

        EXPECT_EQ (context.end_reason (), SseEndReason::Completed) << response.error_message;
        EXPECT_EQ (response.status_code, status);
        const auto opens = open_frames (context);
        ASSERT_EQ (opens.size (), 1u);
        EXPECT_EQ (opens[0]["statusCode"], status);
        EXPECT_EQ (opens[0]["headers"]["x-fixture"], "bodiless");
    }
}

// The `100 Continue` a typed `Expect` draws is a header block of its own, and
// not the stream's answer. Mutation check: drop the interim condition in
// `stream_header_callback` and the one frame reads 100.
TEST (SseConsumer, AnInterimResponseIsNotTheStreamsOpen) {
    StreamServer server;
    server.bodiless (204);
    auto spec           = spec_for (server.url ("/bodiless"), brisk_limits ());
    spec.request.method = vayu::HttpMethod::POST;
    spec.request.body.mode    = vayu::BodyMode::Text;
    spec.request.body.content = "payload";
    spec.request.headers      = { { "Expect", "100-continue" } };
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (response.status_code, 204) << response.error_message;
    const auto opens = open_frames (context);
    ASSERT_EQ (opens.size (), 1u);
    EXPECT_EQ (opens[0]["statusCode"], 204);
}

// A proxy's answer to CONNECT is the tunnel's, not the stream's: this one
// refuses with a 407, which must not open the stream. Mutation check: drop
// `CURLOPT_SUPPRESS_CONNECT_HEADERS` and the refusal publishes an `open` of 407.
TEST (SseConsumer, AProxysConnectAnswerIsNotTheStreamsOpen) {
    vayu::tests::MockProxy proxy;
    auto spec = spec_for ("https://127.0.0.1:1/events", brisk_limits ());
    spec.transport.proxy_mode = vayu::http::ProxyMode::Manual;
    spec.transport.proxy_url  = proxy.url ();
    SseStreamContext context ("run_test", brisk_limits ());
    const auto response = vayu::http::consume_sse_stream (spec, context);

    EXPECT_EQ (context.end_reason (), SseEndReason::Error);
    EXPECT_EQ (response.error_code, vayu::ErrorCode::ProxyError) << response.error_message;
    EXPECT_EQ (proxy.count (), 1u);
    EXPECT_TRUE (open_frames (context).empty ());
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

// A recorded end is readable before the close and survives it: the completion
// callback reads it while the context is still open (#3239).
TEST (SseRing, ARecordedEndIsReadBeforeTheCloseAndWinsOverIt) {
    SseStreamContext context ("run_test", vayu::http::SseLimits{});
    context.record_end (SseEndReason::Idle);
    context.record_end (SseEndReason::Completed);
    EXPECT_EQ (context.end_reason (), SseEndReason::Idle);
    EXPECT_FALSE (context.closed ());
    EXPECT_EQ (context.completed_at_ms (), 0);

    context.close (SseEndReason::Error);
    EXPECT_TRUE (context.closed ());
    EXPECT_NE (context.completed_at_ms (), 0);
    EXPECT_EQ (context.end_reason (), SseEndReason::Idle)
    << "the close's fallback replaced the end the stream recorded";
}

// An end nobody recorded is not known to be a completion (#3342). Mutation
// check: default `end_reason ()` to `Completed` again and this fails.
TEST (SseRing, AnUnrecordedEndReadsAsAnError) {
    SseStreamContext context ("run_test", vayu::http::SseLimits{});
    EXPECT_EQ (context.end_reason (), SseEndReason::Error);
}

// A shutdown after a Stop the transfer has not read yet leaves the user's
// reason standing, and the other order leaves the shutdown's.
TEST (SseRing, TheFirstStopRequestWins) {
    SseStreamContext stopped ("run_test", vayu::http::SseLimits{});
    EXPECT_FALSE (stopped.requested_end ().has_value ());
    stopped.request_stop ();
    stopped.request_shutdown ();
    EXPECT_EQ (stopped.requested_end (), SseEndReason::Stopped);

    SseStreamContext drained ("run_test", vayu::http::SseLimits{});
    drained.request_shutdown ();
    drained.request_stop ();
    EXPECT_EQ (drained.requested_end (), SseEndReason::Shutdown);
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
// The stream text path (#3773)
// ---------------------------------------------------------------------------

std::string chat_completion_body () {
    const auto chunks = chat_completion_chunks ();
    return std::accumulate (chunks.begin (), chunks.end (), std::string ());
}

struct StreamTextCase {
    const char* name;
    const char* path;
    const char* data;
    bool truncated;
    /// Null when the event carries no `text`.
    const char* expected;
};

constexpr auto STREAM_TEXT_CASES = std::to_array<StreamTextCase> ({
{ "AnOpenAiDelta", OPENAI_CONTENT, R"({"choices":[{"delta":{"content":"Hel"}}]})", false, "Hel" },
{ "ARoleOnlyChunk", OPENAI_CONTENT,
R"({"choices":[{"delta":{"role":"assistant"}}]})", false, nullptr },
{ "TheDoneSentinel", OPENAI_CONTENT, "[DONE]", false, nullptr },
{ "AnAnthropicDelta", "$.delta.text", R"({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}})",
false, "lo" },
{ "AnEmptyString", "$.t", R"({"t":""})", false, "" },
{ "ANumber", "$.n", R"({"n":42})", false, "42" },
{ "ABoolean", "$.b", R"({"b":true})", false, "true" },
{ "ANull", "$.n", R"({"n":null})", false, nullptr },
{ "AnObject", "$.o", R"({"o":{"a":1}})", false, nullptr },
{ "AnArray", "$.a", R"({"a":[1]})", false, nullptr },
{ "TheFirstOfSeveralMatches", "$..content",
R"({"a":{"content":"x"},"b":{"content":"y"}})", false, "x" },
// `12345` cut to `123` still parses, and reads a number the server never sent.
{ "ACutEvent", "$", "123", true, nullptr },
});

class StreamTextTest : public ::testing::TestWithParam<StreamTextCase> {};

// Mutation checks: drop the `event.truncated` guard in `sse_event_text` and
// ACutEvent reads "123"; drop the null/structured guard and AnObject reads
// `{"a":1}`.
TEST_P (StreamTextTest, ReadsTheFirstScalarMatchOffTheEventsJson) {
    const auto& c   = GetParam ();
    const auto path = vayu::core::detail::parse_json_path (c.path);
    ASSERT_HAS_VALUE (path) << c.path;
    vayu::http::SseEvent event;
    event.data      = c.data;
    event.truncated = c.truncated;

    const auto text = vayu::http::sse_event_text (event, *path);
    const auto node = vayu::http::sse_event_node (event, &*path);
    if (c.expected == nullptr) {
        EXPECT_FALSE (text.has_value ()) << text.value_or ("");
        EXPECT_FALSE (node.contains ("text")) << node.dump ();
        return;
    }
    ASSERT_HAS_VALUE (text);
    EXPECT_EQ (*text, c.expected);
    EXPECT_EQ (node.value ("text", std::string ("<absent>")), c.expected);
}

INSTANTIATE_TEST_SUITE_P (StreamText,
StreamTextTest,
::testing::ValuesIn (STREAM_TEXT_CASES),
[] (const ::testing::TestParamInfo<StreamTextCase>& info) {
    return std::string (info.param.name);
});

// The live relay carries each event's `text` as it arrives, and an event the
// path misses carries none. Mutation check: drop the `text_path` argument to
// `sse_event_node` in `record_event` and no frame carries `text`.
TEST (SseConsumer, EachRelayedEventCarriesTheTextItsPathReads) {
    StreamServer server (chat_completion_chunks ());
    SseStreamContext context ("run_test", brisk_limits (), OPENAI_CONTENT);
    vayu::http::consume_sse_stream (
    spec_for (server.url ("/scripted"), brisk_limits ()), context);

    const auto payloads = ring_payloads (context);
    ASSERT_EQ (payloads.size (), 6u) << "open plus five events";
    EXPECT_FALSE (payloads[1].contains ("text")) << payloads[1].dump ();
    EXPECT_EQ (payloads[2].value ("text", ""), "Hel");
    EXPECT_FALSE (payloads[3].contains ("text")) << payloads[3].dump ();
    EXPECT_EQ (payloads[4].value ("text", ""), "lo");
    EXPECT_FALSE (payloads[5].contains ("text")) << payloads[5].dump ();
}

TEST (SseConsumer, AStreamWithNoTextPathRelaysNoText) {
    StreamServer server (chat_completion_chunks ());
    SseStreamContext context ("run_test", brisk_limits ());
    vayu::http::consume_sse_stream (
    spec_for (server.url ("/scripted"), brisk_limits ()), context);

    for (const auto& payload : ring_payloads (context)) {
        EXPECT_FALSE (payload.contains ("text")) << payload.dump ();
    }
}

// ---------------------------------------------------------------------------
// The trace node
// ---------------------------------------------------------------------------

struct SseTraceCase {
    const char* name;
    int event_count;
    std::size_t cap;
    SseEndReason end_reason;
    const char* expected_end_reason;
};

constexpr auto SSE_TRACE_CASES = std::to_array<SseTraceCase> ({
{ "KeepsArrivalsUpToTheCap", 9, 3, SseEndReason::MaxEvents, "maxStreamEvents" },
{ "KeepsEveryArrivalOfAStreamThatFit", 1, sse_constants::MAX_STORED_EVENTS,
SseEndReason::Completed, "completed" },
});

class SseTraceTest : public ::testing::TestWithParam<SseTraceCase> {};

// What the trace stores is the sidecar alone (#3770): one arrival time per kept
// event and no list, which the stored body holds, and the transfer's start when
// one began (#3805). Mutation check: push an arrival past the cap in
// `record_event` and the first case keeps nine.
TEST_P (SseTraceTest, StoresArrivalsUpToTheCapAndNoList) {
    const auto& c = GetParam ();
    vayu::http::SseLimits limits;
    limits.max_stored_events = c.cap;
    limits.max_event_bytes   = 4096;
    SseStreamContext context ("run_test", limits);
    for (int i = 0; i < c.event_count; ++i) {
        vayu::http::SseEvent event;
        event.data = std::to_string (i);
        context.record_event (event);
    }
    context.close (c.end_reason);

    // No transfer began, so there is no start to store.
    EXPECT_FALSE (
    vayu::http::stream_trace_node (context).contains ("startedAt"));
    context.note_transfer_start ();

    const auto node = vayu::http::stream_trace_node (context);
    EXPECT_FALSE (node.contains ("items")) << node.dump ();
    ASSERT_TRUE (node.contains ("startedAt")) << node.dump ();
    EXPECT_GT (node["startedAt"].get<int64_t> (), 0);
    EXPECT_EQ (node["receivedAt"].size (),
    std::min (static_cast<std::size_t> (c.event_count), c.cap));
    EXPECT_EQ (node["totalEvents"], c.event_count);
    EXPECT_EQ (node["endReason"], c.expected_end_reason);
    EXPECT_EQ (node["maxEventBytes"], 4096);
}

// The path is stored beside the arrivals, so a reader of the stored trace
// derives the same `text` from the bytes; a stream without one stores none.
// Mutation check: drop `streamTextPath` from `stream_trace_node` and the first
// expectation fails.
TEST (SseTraceNode, StoresTheDeclaredTextPathAndNoText) {
    SseStreamContext context ("run_test", vayu::http::SseLimits{}, OPENAI_CONTENT);
    vayu::http::SseEvent event;
    event.data = R"({"choices":[{"delta":{"content":"Hel"}}]})";
    context.record_event (event);
    context.close (SseEndReason::Completed);

    const auto node = vayu::http::stream_trace_node (context);
    EXPECT_EQ (node.value ("streamTextPath", ""), OPENAI_CONTENT) << node.dump ();
    EXPECT_FALSE (node.contains ("streamText")) << node.dump ();

    SseStreamContext bare ("run_test", vayu::http::SseLimits{});
    bare.close (SseEndReason::Completed);
    EXPECT_FALSE (
    vayu::http::stream_trace_node (bare).contains ("streamTextPath"));
}

INSTANTIATE_TEST_SUITE_P (SseTrace,
SseTraceTest,
::testing::ValuesIn (SSE_TRACE_CASES),
[] (const ::testing::TestParamInfo<SseTraceCase>& info) {
    return std::string (info.param.name);
});

// ---------------------------------------------------------------------------
// A stored trace's events, served (#3770)
// ---------------------------------------------------------------------------

/// A stored design-stream trace: @p body as its response and a sidecar of
/// @p total events, the first of which arrived at 1000, 1001, ... The sidecar
/// carries `startedAt` only when @p started_at is given.
json stored_stream_trace (const std::string& body,
int64_t total,
std::size_t kept,
std::optional<int64_t> started_at = std::nullopt) {
    std::vector<int64_t> arrivals (kept);
    std::iota (arrivals.begin (), arrivals.end (), int64_t{ 1000 });
    json trace{ { "response", { { "body", body }, { "bodyBytes", body.size () } } },
        { "events",
        { { "totalEvents", total }, { "endReason", "completed" },
        { "maxEventBytes", sse_constants::MAX_EVENT_BYTES }, { "receivedAt", arrivals } } } };
    if (started_at) {
        trace["events"]["startedAt"] = *started_at;
    }
    return trace;
}

TEST (StoredStreamEvents, AreParsedFromTheBodyAndPairedWithTheirArrivals) {
    auto trace = stored_stream_trace ("data: a\n\nid: 7\ndata: b\n\n", 2, 2, 990);
    vayu::http::expand_stored_stream_events (trace);

    const auto& events = trace["events"];
    ASSERT_EQ (events["items"].size (), 2u) << events.dump (2);
    EXPECT_EQ (events["items"][0]["data"], "a");
    EXPECT_EQ (events["items"][0].value ("receivedAt", int64_t{ -1 }), 1000);
    EXPECT_EQ (events["items"][1]["sourceId"], "7");
    EXPECT_EQ (events["items"][1].value ("receivedAt", int64_t{ -1 }), 1001);
    EXPECT_EQ (events["totalEvents"], 2);
    EXPECT_FALSE (events["eventsTruncated"].get<bool> ());
    EXPECT_EQ (events["endReason"], "completed");
    EXPECT_EQ (events.value ("startedAt", int64_t{ -1 }), 990);
    EXPECT_FALSE (events.contains ("receivedAt"));
    EXPECT_FALSE (events.contains ("maxEventBytes"));
}

// A row stored before `startedAt` existed is served without it, never with a
// 0 the reader would take for the epoch. Mutation check: write
// `node["startedAt"]` unconditionally in `stream_events_node` and this fails.
TEST (StoredStreamEvents, ASidecarWithoutAStartIsServedWithoutOne) {
    auto trace = stored_stream_trace ("data: a\n\n", 1, 1);
    vayu::http::expand_stored_stream_events (trace);

    EXPECT_EQ (trace["events"]["items"].size (), 1u);
    EXPECT_FALSE (trace["events"].contains ("startedAt")) << trace["events"].dump ();
}

/// `stored_stream_trace` of the chat completion, its sidecar naming the
/// OpenAI path.
json stored_chat_completion_trace (int64_t total, std::size_t kept) {
    auto trace = stored_stream_trace (chat_completion_body (), total, kept);
    trace["events"]["streamTextPath"] = OPENAI_CONTENT;
    return trace;
}

// Each `text` and the joined `streamText` are derived from the stored bytes by
// the stored path (#3773, #3801), and a sidecar with no path derives neither.
TEST (StoredStreamEvents, DeriveTheTextTheStoredPathReads) {
    auto trace = stored_chat_completion_trace (5, 5);
    vayu::http::expand_stored_stream_events (trace);

    const auto& events = trace["events"];
    ASSERT_EQ (events["items"].size (), 5u) << events.dump (2);
    EXPECT_FALSE (events["items"][0].contains ("text"));
    EXPECT_EQ (events["items"][1].value ("text", ""), "Hel");
    EXPECT_FALSE (events["items"][2].contains ("text"));
    EXPECT_EQ (events["items"][3].value ("text", ""), "lo");
    EXPECT_EQ (events.value ("streamText", "<absent>"), "Hello");
    EXPECT_FALSE (events.contains ("streamTextPath"));

    auto bare = stored_stream_trace (chat_completion_body (), 5, 5);
    vayu::http::expand_stored_stream_events (bare);
    EXPECT_FALSE (bare["events"].contains ("streamText")) << bare["events"].dump (2);
    EXPECT_FALSE (bare["events"]["items"][1].contains ("text"));
}

// `streamText` is the whole reply even when `sseMaxStoredEvents` kept two
// events, and stops where the stream's count does, as the list does.
// Mutation check: stop the parse at the stored cap (`read_to = cap`) in
// `buffered_stream_events_node` and the first reads "Hel".
TEST (StoredStreamEvents, JoinTextPastTheStoredCapButNotPastTheCount) {
    auto capped = stored_chat_completion_trace (5, 2);
    vayu::http::expand_stored_stream_events (capped);
    EXPECT_EQ (capped["events"]["items"].size (), 2u);
    EXPECT_TRUE (capped["events"]["eventsTruncated"].get<bool> ());
    EXPECT_EQ (capped["events"].value ("streamText", "<absent>"), "Hello");

    auto counted = stored_chat_completion_trace (3, 3);
    vayu::http::expand_stored_stream_events (counted);
    EXPECT_EQ (counted["events"].value ("streamText", "<absent>"), "Hel");
}

// The arrivals the stored cap kept bound the list, as the live stored list
// was bounded. Mutation check: bound the list by `max_stored_events` alone
// and all three are served.
TEST (StoredStreamEvents, StopAtTheArrivalsTheStoredCapKept) {
    auto trace = stored_stream_trace ("data: a\n\ndata: b\n\ndata: c\n\n", 3, 2);
    vayu::http::expand_stored_stream_events (trace);

    EXPECT_EQ (trace["events"]["items"].size (), 2u);
    EXPECT_EQ (trace["events"]["totalEvents"], 3);
    EXPECT_TRUE (trace["events"]["eventsTruncated"].get<bool> ());
}

// Either cut makes the stored bytes a prefix, even when the parse happens to
// be whole. Mutation check: read only `bodyCapped` in
// `expand_stored_stream_events` and the storage cut reads as a whole stream.
TEST (StoredStreamEvents, ABodyCutForStorageOrAtTheBoundIsAPrefix) {
    for (const char* cut : { "bodyCapped", "bodyTruncated" }) {
        SCOPED_TRACE (cut);
        auto trace             = stored_stream_trace ("data: a\n\n", 1, 1);
        trace["response"][cut] = true;
        vayu::http::expand_stored_stream_events (trace);
        EXPECT_EQ (trace["events"]["items"].size (), 1u);
        EXPECT_TRUE (trace["events"]["eventsTruncated"].get<bool> ());
    }
}

// A body that is not UTF-8 is stored as base64 (`response_trace_node`), and
// its events are parsed from the bytes it decodes to. Mutation check: parse
// the stored text without decoding it and nothing is served.
TEST (StoredStreamEvents, ABase64BodyIsDecodedBeforeItIsParsed) {
    const std::string bytes = "data: caf\xE9\n\n";
    auto trace = stored_stream_trace (vayu::utils::base64_encode (bytes), 1, 1);
    trace["response"]["bodyEncoding"] = "base64";
    vayu::http::expand_stored_stream_events (trace);

    const auto expected =
    vayu::http::buffered_stream_events_node (bytes, vayu::http::SseLimits{}, 1, true);
    ASSERT_EQ (trace["events"]["items"].size (), 1u) << trace["events"].dump ();
    EXPECT_EQ (trace["events"]["items"][0]["data"], expected["items"][0]["data"]);
}

// A trace stored before #3770 carries its list, and an ordinary send has no
// events node: both are served exactly as stored.
TEST (StoredStreamEvents, ATraceWithoutASidecarIsServedAsStored) {
    const json legacy{ { "response", { { "body", "" } } },
        { "events",
        { { "items", json::array ({ { { "event", "message" }, { "data", "x" } } }) },
        { "totalEvents", 1 }, { "eventsTruncated", false }, { "endReason", "completed" } } } };
    auto served = legacy;
    vayu::http::expand_stored_stream_events (served);
    EXPECT_EQ (served, legacy);

    const json ordinary{ { "response", { { "body", "{}" } } } };
    served = ordinary;
    vayu::http::expand_stored_stream_events (served);
    EXPECT_EQ (served, ordinary);
}

} // namespace
