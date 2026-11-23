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

// First, before anything that includes <httplib.h>: see the header. Needed
// for `proxy_server.hpp`, whose forwarder builds an `httplib::Client` from a URL.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <future>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <numeric>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <httplib.h>
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
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "verbosity_restorer.hpp"
#include "wait_until.hpp"

namespace {

using nlohmann::json;
using vayu::http::SseEndReason;
using vayu::http::SseStreamContext;
using vayu::http::SseStreamManager;
using vayu::http::SseStreamRequest;
using vayu::http::routes::read_stream_flag;

namespace sse_constants = vayu::core::constants::sse;

/**
 * A `POST /execute` payload's `elements` array carrying @p pre and/or @p post
 * as `script.pre` / `script.post` entries (issue #1514's cut-over -
 * `preRequestScript` / `postRequestScript` are refused on the wire now).
 * Either may be empty to omit that half.
 */
json script_elements (const std::string& pre, const std::string& post = "") {
    json elements = json::array ();
    if (!pre.empty ()) {
        elements.push_back ({ { "id", "el_pre" }, { "kind", "script.pre" },
        { "config", { { "script", pre } } } });
    }
    if (!post.empty ()) {
        elements.push_back ({ { "id", "el_post" }, { "kind", "script.post" },
        { "config", { { "script", post } } } });
    }
    return elements;
}

// ---------------------------------------------------------------------------
// The fixture: a server that streams on demand
// ---------------------------------------------------------------------------

/**
 * Serves three shapes of `text/event-stream` a test needs and a live endpoint
 * cannot be asked for: a finite scripted stream, one that never stops talking,
 * and one that connects and then says nothing at all. Beside them, `/canned`
 * answers whatever status, `Content-Type` and chunks `can()` was given - the
 * reply a stream asked for and did not get (a JSON 404, NDJSON) - and `/hop`
 * redirects to it with a body of its own (JSON unless `hop_body` says
 * otherwise), for the per-hop rules.
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
            for (const auto& cookie : set_cookie_values ()) {
                res.set_header ("Set-Cookie", cookie);
            }
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

        svr_.Get ("/endless", [this] (const httplib::Request& req, httplib::Response& res) {
            note_request (req);
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

        // A plain, non-streaming endpoint, for the one thing a stream's
        // pre-request script does that the stream itself cannot: send a
        // request of its own. Counted apart from `note_request`, whose record
        // belongs to the transfer - an aside must not overwrite the headers a
        // test reads back off `/scripted`.
        svr_.Get ("/aside", [this] (const httplib::Request&, httplib::Response& res) {
            aside_count_.fetch_add (1);
            while (aside_held_.load () && !stopping_.load ()) {
                std::this_thread::sleep_for (std::chrono::milliseconds (5));
            }
            res.set_content (R"({"ok":true})", "application/json");
        });

        // An OAuth 2.0 token endpoint that answers a client-credentials grant
        // after `token_delay_ms_`, for the cost a first-use token fetch adds
        // to a send.
        svr_.Post ("/token", [this] (const httplib::Request&, httplib::Response& res) {
            token_count_.fetch_add (1);
            std::this_thread::sleep_for (
            std::chrono::milliseconds (token_delay_ms_.load ()));
            res.set_content (R"({"access_token":"tok-1","token_type":"Bearer","expires_in":3600})",
            "application/json");
        });

        svr_.Get ("/canned", [this] (const httplib::Request& req, httplib::Response& res) {
            note_request (req);
            const Canned canned = canned_reply ();
            res.status          = canned.status;
            res.set_chunked_content_provider (canned.content_type,
            [chunks = canned.chunks] (size_t, httplib::DataSink& sink) {
                for (const auto& chunk : chunks) {
                    if (!sink.write (chunk.data (), chunk.size ())) {
                        return false;
                    }
                }
                sink.done ();
                return true;
            });
        });

        svr_.Get ("/hop", [this] (const httplib::Request&, httplib::Response& res) {
            hop_count_.fetch_add (1);
            // In slices, so a stopping fixture is not held by a long delay.
            const auto until = std::chrono::steady_clock::now () +
            std::chrono::milliseconds (hop_delay_ms_.load ());
            while (!stopping_.load () && std::chrono::steady_clock::now () < until) {
                std::this_thread::sleep_for (std::chrono::milliseconds (20));
            }
            const Canned body = hop_reply ();
            res.status        = 302;
            res.set_header ("Location", hop_location ());
            for (const auto& cookie : hop_cookie_values ()) {
                res.set_header ("Set-Cookie", cookie);
            }
            res.set_content (body.chunks.front (), body.content_type);
        });

        // Headers and no body at all, whatever `bodiless ()` set: a 204, a
        // bodiless 401, an empty 200. A POST is answered the same way, after
        // the `100 Continue` httplib sends a request that expects one.
        const auto bodiless = [this] (const httplib::Request& req, httplib::Response& res) {
            note_request (req);
            res.status = bodiless_status_.load ();
            res.set_header ("X-Fixture", "bodiless");
        };
        svr_.Get ("/bodiless", bodiless);
        svr_.Post ("/bodiless", bodiless);

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
    StreamServer (const StreamServer&)            = delete;
    StreamServer& operator= (const StreamServer&) = delete;
    StreamServer (StreamServer&&)                 = delete;
    StreamServer& operator= (StreamServer&&)      = delete;

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

    /// Requests this origin has answered. A test that must interrupt a stream
    /// *in flight* needs to know the transfer actually started, and the run row
    /// exists before the worker has connected.
    int requests_received () const {
        return received_count_.load ();
    }

    /// Requests a script sent to `/aside` of its own accord. Zero is the only
    /// proof that a refusal was a refusal rather than a swallowed answer.
    int aside_requests () const {
        return aside_count_.load ();
    }

    /// Hold every `/aside` answer until `release_aside ()`, so a script that
    /// sends one is parked at a point the test chooses. Counted on arrival.
    void hold_aside () {
        aside_held_.store (true);
    }

    void release_aside () {
        aside_held_.store (false);
    }

    /// Make `/token` take @p ms to answer. Set before the request.
    void delay_token (int ms) {
        token_delay_ms_ = ms;
    }

    /// Grants `/token` has served; a cached token leaves it where it was.
    int token_requests () const {
        return token_count_.load ();
    }

    /// A `Set-Cookie` every `/scripted` answer carries from now on; "" for none.
    void set_cookie (std::string value) {
        set_cookies (value.empty () ? std::vector<std::string>{} :
                                      std::vector<std::string>{ std::move (value) });
    }

    /// The `Set-Cookie` lines every `/scripted` answer carries from now on, one
    /// header each, in order.
    void set_cookies (std::vector<std::string> values) {
        std::lock_guard<std::mutex> lock (received_mutex_);
        set_cookies_ = std::move (values);
    }

    /// What `/canned` answers from now on: @p chunks, one write each.
    void can (int status, std::string content_type, std::vector<std::string> chunks) {
        std::lock_guard<std::mutex> lock (received_mutex_);
        canned_ = Canned{ status, std::move (content_type), std::move (chunks) };
    }

    /// Where `/hop` redirects from now on, instead of `/canned`.
    void hop_to (std::string location) {
        std::lock_guard<std::mutex> lock (received_mutex_);
        hop_location_ = std::move (location);
    }

    /// The body `/hop`'s redirect carries from now on, instead of its JSON.
    void hop_body (std::string content_type, std::string body) {
        std::lock_guard<std::mutex> lock (received_mutex_);
        hop_reply_ = Canned{ 302, std::move (content_type), { std::move (body) } };
    }

    /// The `Set-Cookie` lines `/hop`'s redirect carries from now on.
    void hop_cookies (std::vector<std::string> values) {
        std::lock_guard<std::mutex> lock (received_mutex_);
        hop_cookies_ = std::move (values);
    }

    /// Make `/hop` wait @p ms before it answers. Set before the request.
    void delay_hop (int ms) {
        hop_delay_ms_ = ms;
    }

    /// The status `/bodiless` answers from now on.
    void bodiless (int status) {
        bodiless_status_.store (status);
    }

    /// Redirects `/hop` has answered or is answering.
    int hops_received () const {
        return hop_count_.load ();
    }

    private:
    struct Canned {
        int status = 200;
        std::string content_type{ "text/plain" };
        std::vector<std::string> chunks;
    };

    Canned canned_reply () const {
        std::lock_guard<std::mutex> lock (received_mutex_);
        return canned_;
    }

    std::string hop_location () const {
        std::lock_guard<std::mutex> lock (received_mutex_);
        return hop_location_.empty () ? url ("/canned") : hop_location_;
    }

    Canned hop_reply () const {
        std::lock_guard<std::mutex> lock (received_mutex_);
        return hop_reply_;
    }

    std::vector<std::string> set_cookie_values () const {
        std::lock_guard<std::mutex> lock (received_mutex_);
        return set_cookies_;
    }

    std::vector<std::string> hop_cookie_values () const {
        std::lock_guard<std::mutex> lock (received_mutex_);
        return hop_cookies_;
    }

    void note_request (const httplib::Request& req) {
        std::lock_guard<std::mutex> lock (received_mutex_);
        received_headers_.clear ();
        for (const auto& [key, value] : req.headers) {
            received_headers_[key] = value;
        }
        received_count_.fetch_add (1);
    }

    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    std::vector<std::string> chunks_;
    std::atomic<bool> stopping_{ false };
    std::atomic<int> pace_ms_{ 0 };
    mutable std::mutex received_mutex_;
    std::map<std::string, std::string, std::less<>> received_headers_;
    std::vector<std::string> set_cookies_;
    std::vector<std::string> hop_cookies_;
    std::string hop_location_;
    Canned hop_reply_{ 302, "application/json", { R"({"hop":"first"})" } };
    Canned canned_;
    std::atomic<int> hop_delay_ms_{ 0 };
    std::atomic<int> bodiless_status_{ 204 };
    std::atomic<int> hop_count_{ 0 };
    std::atomic<int> received_count_{ 0 };
    std::atomic<int> aside_count_{ 0 };
    std::atomic<bool> aside_held_{ false };
    std::atomic<int> token_delay_ms_{ 0 };
    std::atomic<int> token_count_{ 0 };
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

/// The payloads of the `open` frames the ring is holding, in order.
std::vector<json> open_frames (const SseStreamContext& context) {
    std::vector<json> out;
    for (const auto& frame : context.events_since (0).payloads) {
        const auto data_at = frame.find ("data: ");
        if (!frame.starts_with ("event: open\n") || data_at == std::string::npos) {
            continue;
        }
        out.push_back (json::parse (frame.substr (data_at + 6)));
    }
    return out;
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

constexpr const char* OPENAI_CONTENT = "$.choices[0].delta.content";

/// An OpenAI-compatible chat completion stream, one event per chunk: a
/// role-only chunk, two deltas around a ping, and the `[DONE]` sentinel. The
/// declared path reads "Hello" off it and nothing off the other three.
std::vector<std::string> chat_completion_chunks () {
    return { "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n", "event: ping\ndata: {}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n", "data: [DONE]\n\n" };
}

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
// event and no list, which the stored body holds. Mutation check: push an
// arrival past the cap in `record_event` and the first case keeps nine.
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

    const auto node = vayu::http::stream_trace_node (context);
    EXPECT_FALSE (node.contains ("items")) << node.dump ();
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
/// @p total events, the first of which arrived at 1000, 1001, ...
json stored_stream_trace (const std::string& body, int64_t total, std::size_t kept) {
    std::vector<int64_t> arrivals (kept);
    std::iota (arrivals.begin (), arrivals.end (), int64_t{ 1000 });
    return json{ { "response", { { "body", body }, { "bodyBytes", body.size () } } },
        { "events",
        { { "totalEvents", total }, { "endReason", "completed" },
        { "maxEventBytes", sse_constants::MAX_EVENT_BYTES }, { "receivedAt", arrivals } } } };
}

TEST (StoredStreamEvents, AreParsedFromTheBodyAndPairedWithTheirArrivals) {
    auto trace = stored_stream_trace ("data: a\n\nid: 7\ndata: b\n\n", 2, 2);
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
    EXPECT_FALSE (events.contains ("receivedAt"));
    EXPECT_FALSE (events.contains ("maxEventBytes"));
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
        manager_ = std::make_unique<SseStreamManager> ();
        ctx_     = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, nullptr,
        authorize_manager_, cookie_jar_, mock_issuer_manager_, inbox_manager_,
        mock_server_manager_, *manager_, run_summary_cache_ });
        vayu::http::routes::register_execution_routes (*ctx_);
        vayu::http::routes::register_event_stream_routes (*ctx_);
        vayu::http::routes::register_run_routes (*ctx_);
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
        // Before `db_` and before `origin_`, always (#646). `trace_for` returns
        // as soon as the result row lands, which the worker writes from inside
        // its completion callback - so the test body finishes with that worker
        // still on the stack of `*db_`. Joining here is what makes the reset
        // below safe; it is the order `Server::stop()` holds in production.
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// An origin that writes @p count events, one per chunk, paced so the
    /// consumer really does assemble them over time.
    void serve (int count) {
        std::vector<std::string> chunks;
        chunks.reserve (static_cast<size_t> (count));
        for (int i = 0; i < count; ++i) {
            chunks.push_back ("id: e" + std::to_string (i) +
            "\nevent: tick\ndata: {\"n\": " + std::to_string (i) + "}\n\n");
        }
        origin_ = std::make_unique<StreamServer> (std::move (chunks));
        origin_->pace (2);
    }

    /// Send @p payload as a streaming execute of @p path on the origin, or of
    /// the payload's own `url` when it names one, and return the run id it
    /// created.
    std::string start (json payload, const std::string& path = "/scripted") {
        payload["method"] = "GET";
        if (!payload.contains ("url")) {
            payload["url"] = origin_->url (path);
        }
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

    /// Send @p payload as an ordinary buffered execute and return the answer
    /// body. The same fields the streaming path stores in its trace's `scripts`
    /// node arrive here inline, which is what lets one test hold both
    /// transports to the same rule.
    json send_buffered (json payload) {
        payload["method"] = "GET";
        payload["url"]    = origin_->url ("/scripted");
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post ("/execute", payload.dump (), "application/json");
        EXPECT_TRUE (response);
        if (!response) {
            return json::object ();
        }
        EXPECT_EQ (response->status, 200) << response->body;
        return json::parse (response->body);
    }

    /// `POST /runs/:runId/stop`'s answer for @p run_id.
    json stop (const std::string& run_id) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post ("/runs/" + run_id + "/stop", "", "application/json");
        EXPECT_TRUE (response);
        if (!response) {
            return json::object ();
        }
        EXPECT_EQ (response->status, 200) << response->body;
        return json::parse (response->body);
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

    /// The trace as `GET /runs/:runId/results/:resultId` serves it, once the
    /// row is stored: what the app and the MCP tools read, with a stream's
    /// event list parsed back from its stored body.
    json served_trace_for (const std::string& run_id) {
        if (!vayu::tests::wait_until (
            [&] () { return !db_->get_results (run_id).empty (); })) {
            ADD_FAILURE () << "no result row was ever stored for " << run_id;
            return json::object ();
        }
        const auto result_id = std::to_string (db_->get_results (run_id)[0].id);
        auto [status, body] =
        vayu::http::routes::run_result_response (*db_, run_id, result_id);
        EXPECT_EQ (status, 200) << body.dump (2);
        return body.value ("trace", json::object ());
    }

    /// The upstream events the stream's ring published, in order: the live
    /// list, `receivedAt` included, that the served trace must reproduce.
    std::vector<json> live_events (const std::string& run_id) const {
        const auto context = manager_->get (run_id);
        if (!context) {
            ADD_FAILURE () << "the manager holds no stream for " << run_id;
            return {};
        }
        std::vector<json> events;
        for (auto& payload : ring_payloads (*context)) {
            if (!payload.contains ("statusCode")) {
                events.push_back (std::move (payload));
            }
        }
        return events;
    }

    /// The stored trace of the most recent design run. A buffered send answers
    /// with the response rather than a run id, so its row is found by recency -
    /// safe because each test gets its own database, and unpolled because the
    /// buffered path stores before it answers.
    json latest_design_trace () {
        auto runs = db_->get_runs_paginated (vayu::db::RunFilter{}, 1, 0);
        if (runs.empty ()) {
            ADD_FAILURE () << "no run row was created for the buffered send";
            return json::object ();
        }
        auto results = db_->get_results (runs[0].id);
        if (results.empty ()) {
            ADD_FAILURE () << "no result row was stored for " << runs[0].id;
            return json::object ();
        }
        return json::parse (results[0].trace_data);
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
    std::unique_ptr<vayu::http::routes::RouteContext> ctx_;
    std::unique_ptr<StreamServer> origin_;
};

// The acceptance criterion: a script asserts over what the stream delivered,
// and the entries carry the shape the surface promises.
TEST_F (StreamExecuteTest, TheStreamsPostRequestScriptSeesItsEvents) {
    serve (3);
    const auto run_id = start (json{ { "elements", script_elements ("", R"JS(
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
    )JS") } });
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
    const auto run_id = start (json{ { "elements", script_elements ("", R"JS(
        pm.test('the list is a prefix and says so', function () {
            pm.expect(pm.response.eventsTruncated).to.equal(true);
            pm.expect(pm.response.events.length).to.equal(2);
            pm.expect(pm.response.totalEvents).to.equal(5);
        });
    )JS") } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    ASSERT_EQ (trace["scripts"]["testResults"].size (), 1u);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
    // Stated twice on purpose: the assertion above proves the script saw it,
    // and this proves the served node the app restores from says the same.
    auto served = served_trace_for (run_id);
    EXPECT_TRUE (served["events"]["eventsTruncated"].get<bool> ()) << served.dump (2);
    EXPECT_EQ (served["events"]["totalEvents"], 5);
    EXPECT_EQ (served["events"]["items"].size (), 2u);
}

// #2522 on the streaming transport: the elements a composed send carries are
// stamped with their level, and the stored trace (the route already answered
// 202, so it is the only place the results land) keeps each level's test under
// its own scope instead of the request's passing one replacing the collection's
// failing one.
TEST_F (StreamExecuteTest, AStreamsTraceKeepsTheCollectionsFailingTestUnderItsScope) {
    serve (1);
    const auto post_at = [] (const std::string& scope, const std::string& id,
                         const std::string& body) {
        return json{ { "id", id }, { "kind", "script.post" },
            { "config", { { "script", body } } },
            { "origin",
            { { "kind", scope == "request" ? "request" : "collection" },
            { "scope", scope }, { "id", "owner_" + scope } } } };
    };
    const auto run_id = start (json{ { "elements",
    json::array ({ post_at ("collection", "el_col", "pm.test('collection must fail', () => pm.expect(1).to.eql(2));"),
    post_at ("request", "el_req", "pm.test('request passes', () => pm.expect(1).to.eql(1));") }) } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    const auto& tests = trace["scripts"]["testResults"];
    ASSERT_EQ (tests.size (), 2u) << trace["scripts"].dump (2);
    EXPECT_EQ (tests[0]["name"], "collection must fail");
    EXPECT_FALSE (tests[0]["passed"].get<bool> ());
    EXPECT_EQ (tests[0]["scope"], "collection");
    EXPECT_EQ (tests[1]["name"], "request passes");
    EXPECT_EQ (tests[1]["scope"], "request");
}

// #3779 on the streaming transport: an assertion's `{{data.column}}` resolves
// against the send's own row, and a column the row lacks fails the assertion
// by name rather than comparing the template. The post-request pass runs in
// the completion callback, so its context must carry the resolver itself.
// Mutation check: drop `.resolve_template` from the `step.after` context in
// `execution.cpp` and the passing case reports the unresolved-token failure.
TEST_F (StreamExecuteTest, AnAssertionResolvesTheSendsDataRowInTheCompletionPass) {
    serve (1);
    const auto assert_url_contains = [] (const std::string& text) {
        return json::array ({ { { "id", "el_a" }, { "kind", "assert.contains" },
        { "config", { { "field", "url" }, { "text", text } } } } });
    };
    const auto first_test = [this] (const json& payload) {
        const auto run_id = start (payload);
        EXPECT_FALSE (run_id.empty ());
        const auto trace = trace_for (run_id);
        EXPECT_TRUE (trace.contains ("scripts")) << trace.dump (2);
        return trace.value ("scripts", json::object ())
        .value ("testResults", json::array ())
        .at (0);
    };

    const auto passing = first_test (json{ { "data", { { "leaf", "scripted" } } },
    { "elements", assert_url_contains ("/{{data.leaf}}") } });
    EXPECT_TRUE (passing["passed"].get<bool> ()) << passing.dump (2);

    const auto failing = first_test (json{ { "data", { { "leaf", "elsewhere" } } },
    { "elements", assert_url_contains ("/{{data.leaf}}") } });
    EXPECT_FALSE (failing["passed"].get<bool> ()) << failing.dump (2);
    EXPECT_EQ (failing["error"], "expected url to contain '/{{data.leaf}}'");

    const auto missing = first_test (json{ { "data", { { "leaf", "scripted" } } },
    { "elements", assert_url_contains ("/{{data.leef}}") } });
    EXPECT_FALSE (missing["passed"].get<bool> ()) << missing.dump (2);
    EXPECT_EQ (missing["error"],
    "'text' uses {{data.leef}}, which no variable or data column answers");
}

// A stream's scripts' `pm.sendRequest` records reach its stored trace, the
// only place they can land once the route has answered 202 (#3633). The call
// is refused, so the record is the failure one and no second server is needed.
// Mutation check: leave `record_script_requests` out of `build_design_send`
// and the trace has no list, on this transport as on the buffered one.
TEST_F (StreamExecuteTest, AStreamsTraceCarriesItsScriptRequests) {
    serve (1);
    const auto run_id = start (json{ { "allowScriptRequests", true },
    { "elements", script_elements ("pm.sendRequest('http://127.0.0.1:1/', function () {});") } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    const auto records = trace["scripts"].value ("scriptRequests", json::array ());
    ASSERT_EQ (records.size (), 1u) << trace["scripts"].dump (2);
    EXPECT_EQ (records[0]["source"], "pre");
    EXPECT_EQ (records[0]["status"], 0);
    EXPECT_EQ (records[0]["error_type"], "CONNECTION_FAILED");
    EXPECT_EQ (trace["scripts"]["consoleLogs"][0]["scriptRequest"], 0);
}

// A pre-request script on a stream is not a special case - it edits the request
// that goes on the wire, exactly as it does on a buffered send. Proven off the
// origin's own record of what arrived, not off the plan.
TEST_F (StreamExecuteTest, ThePreRequestScriptsEditReachesTheWire) {
    serve (1);
    const auto run_id = start (
    json{ { "elements", script_elements ("pm.request.headers.add({ key: 'X-From-Script', value: 'yes' });", R"JS(
        pm.test('the stream still ran', function () {
            pm.expect(pm.response.events.length).to.equal(1);
        });
    )JS") } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ());
    EXPECT_EQ (origin_->received_header ("X-From-Script"), "yes");
}

// ---------------------------------------------------------------------------
// Postman's `disableCookies` (issue #1765), on both transports
//
// The jar is seeded by an ordinary send first, so the assertion that nothing
// went out is not vacuous: the same request without the flag is shown to carry
// the cookie. One `cookie_jar` pointer decides both halves on each transport,
// so the read and write halves share a mutant there: attach the jar despite
// the flag (`config.cookie_jar` in `execute_exchange`, `attach_stream_jar`
// in `execution.cpp`) and each test below reds.
// ---------------------------------------------------------------------------

TEST_F (StreamExecuteTest, ABufferedSendWithTheJarOffAttachesNoJarCookie) {
    serve (1);
    origin_->set_cookie ("seed=1; Path=/");
    send_buffered (json::object ());
    origin_->set_cookie ("");

    send_buffered (json::object ());
    ASSERT_EQ (origin_->received_header ("Cookie"), "seed=1")
    << "the seeding send did not reach the jar, so the check below proves "
       "nothing";

    send_buffered (json{ { "disableCookies", true } });
    EXPECT_EQ (origin_->received_header ("Cookie"), "")
    << "a request with disableCookies carried the jar's cookie";
}

TEST_F (StreamExecuteTest, ABufferedSendWithTheJarOffStoresNoSetCookie) {
    serve (1);
    origin_->set_cookie ("fresh=1; Path=/");
    const json answer = send_buffered (json{ { "disableCookies", true } });
    EXPECT_TRUE (cookie_jar_.lines_for ("").empty ())
    << "a Set-Cookie on a request with disableCookies reached the jar";
    // The response still reports what the server set.
    EXPECT_NE (answer.dump ().find ("fresh=1"), std::string::npos) << answer.dump ();
}

// The pre-request script's `pm.cookies.jar()` write has no transfer to ride,
// so it is applied directly - once, and still not sent on this request.
// Mutation check: drop the `jar.apply` in the jar-off branch of
// `execute_exchange` and the jar reads empty.
TEST_F (StreamExecuteTest, ABufferedSendWithTheJarOffStillPersistsThePreRequestWrite) {
    serve (1);
    send_buffered (json{ { "disableCookies", true },
    { "elements",
    script_elements ("pm.cookies.jar().set('" + origin_->url ("/") +
    "', { name: 'pre', value: 'v' });") } });
    EXPECT_EQ (origin_->received_header ("Cookie"), "");
    const auto lines = cookie_jar_.lines_for ("");
    ASSERT_EQ (lines.size (), 1u);
    EXPECT_NE (lines[0].find ("pre\tv"), std::string::npos) << lines[0];
}

TEST_F (StreamExecuteTest, AStreamWithTheJarOffAttachesNoJarCookieAndStoresNone) {
    serve (1);
    origin_->set_cookie ("seed=1; Path=/");
    send_buffered (json::object ());
    origin_->set_cookie ("fresh=1; Path=/");

    const auto run_id = start (json{ { "disableCookies", true } });
    ASSERT_FALSE (run_id.empty ());
    trace_for (run_id);
    EXPECT_EQ (origin_->received_header ("Cookie"), "")
    << "a stream with disableCookies carried the jar's cookie";
    const auto lines = cookie_jar_.lines_for ("");
    ASSERT_EQ (lines.size (), 1u)
    << "a stream with disableCookies stored its Set-Cookie";
    EXPECT_NE (lines[0].find ("seed"), std::string::npos) << lines[0];

    // The control: the same stream with the jar on sends the cookie.
    const auto control = start (json::object ());
    ASSERT_FALSE (control.empty ());
    trace_for (control);
    EXPECT_EQ (origin_->received_header ("Cookie"), "seed=1");
}

// Mutation check: drop the `jar.apply` in `attach_stream_jar`'s jar-off case
// and the jar reads empty.
TEST_F (StreamExecuteTest, AStreamWithTheJarOffStillPersistsThePreRequestWrite) {
    serve (1);
    const auto run_id = start (json{ { "disableCookies", true },
    { "elements",
    script_elements ("pm.cookies.jar().set('" + origin_->url ("/") +
    "', { name: 'pre', value: 'v' });") } });
    ASSERT_FALSE (run_id.empty ());
    trace_for (run_id);
    EXPECT_EQ (origin_->received_header ("Cookie"), "");
    EXPECT_EQ (cookie_jar_.lines_for ("").size (), 1u);
}

// A stream the manager refuses to start (the daemon draining) never ran, so
// its pre-request write is dropped - as the jar-on path drops the writes it
// hands the refused spec. Mutation check: apply the jar-off writes inside
// `attach_stream_jar` again, before `sse_manager.start`, and the jar holds
// the write.
TEST_F (StreamExecuteTest, ARefusedStreamWithTheJarOffPersistsNoPreRequestWrite) {
    serve (1);
    manager_->shutdown ();
    json payload{ { "method", "GET" }, { "url", origin_->url ("/scripted") },
        { "stream", true }, { "disableCookies", true },
        { "elements",
        script_elements ("pm.cookies.jar().set('" + origin_->url ("/") +
        "', { name: 'pre', value: 'v' });") } };
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    auto response = client.Post ("/execute", payload.dump (), "application/json");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 503) << response->body;
    EXPECT_TRUE (cookie_jar_.lines_for ("").empty ())
    << "a refused stream persisted its pre-request cookie write";
}

// ---------------------------------------------------------------------------
// Cookie warnings on a stream (issue #3315)
//
// A stream reports the four cookie warnings a buffered send does
// (`cookie_jar_test.cpp` holds their wording) on its stored trace: the route
// answered `202` before the transfer, and no relay frame carries them. The
// route hands the stream the fixture's jar under scope "" (no environment).
// ---------------------------------------------------------------------------

/// @p count jar cookies for the loopback origin, named `<stem>0`, `<stem>1`,
/// ..., each @p value_bytes of `v`.
std::vector<std::string>
loopback_jar_lines (const std::string& stem, int count, size_t value_bytes) {
    std::vector<std::string> lines;
    lines.reserve (static_cast<size_t> (count));
    for (int i = 0; i < count; ++i) {
        lines.push_back ("127.0.0.1\tFALSE\t/\tFALSE\t4102444800\t" + stem +
        std::to_string (i) + "\t" + std::string (value_bytes, 'v'));
    }
    return lines;
}

/// `Set-Cookie` values `<stem>0=secret-0`, `<stem>1=secret-1`, ...
std::vector<std::string> numbered_set_cookies (int count, const std::string& stem = "c") {
    std::vector<std::string> values;
    values.reserve (static_cast<size_t> (count));
    for (int i = 0; i < count; ++i) {
        values.push_back (
        stem + std::to_string (i) + "=secret-" + std::to_string (i) + "; Path=/");
    }
    return values;
}

/// The stored trace's top-level warnings that carry @p code.
std::vector<json> trace_warnings (const json& trace, const std::string& code) {
    std::vector<json> found;
    std::ranges::copy_if (trace.value ("warnings", json::array ()),
    std::back_inserter (found),
    [&] (const json& warning) { return warning.value ("code", "") == code; });
    return found;
}

/// No warning on @p trace quotes a cookie value the fixtures use.
void expect_no_cookie_value (const json& trace) {
    const std::string warnings = trace.value ("warnings", json::array ()).dump ();
    EXPECT_EQ (warnings.find ("vvvv"), std::string::npos) << warnings;
    EXPECT_EQ (warnings.find ("secret-"), std::string::npos) << warnings;
}

/// The `sentHeaders` record of @p trace, or an empty object.
json sent_headers (const json& trace) {
    return trace.value ("request", json::object ()).value ("sentHeaders", json::object ());
}

/// A payload whose request types a `Cookie` row.
json typed_cookie_row () {
    return json{ { "headers", { { "Cookie", "typed=2" } } } };
}

// Three ~3000-byte jar cookies pass libcurl's 8190-byte Cookie line at the
// third, which takes the typed row with it: the trace names the cookie, and
// `sentHeaders` stops claiming the typed row went out. At both ends of the
// console verbosity, because the warning is the trace's, not the log's.
// Mutation-check: drop `CURLOPT_DEBUGFUNCTION` in `consume_sse_stream` and no
// warning arrives; return early from `stream_debug_callback` below verbosity
// 2 and the verbosity-0 pass finds none; drop `apply_cookie_notices`' erase
// and the typed row stays in `sentHeaders`.
TEST_F (StreamExecuteTest, AStreamNamesAJarCookieWithheldForTheHeaderLimit) {
    const vayu::tests::VerbosityRestorer restore;
    serve (1);
    cookie_jar_.store ("", loopback_jar_lines ("big", 3, 3000));
    for (const int verbosity : { 0, 2 }) {
        vayu::utils::Logger::instance ().set_verbosity (verbosity);
        const auto run_id = start (typed_cookie_row ());
        ASSERT_FALSE (run_id.empty ());
        const auto trace = trace_for (run_id);

        const auto found = trace_warnings (trace, "cookie_not_sent");
        ASSERT_EQ (found.size (), 1U)
        << "verbosity " << verbosity << ": " << trace.dump (2);
        EXPECT_NE (found.front ().value ("message", "").find ("Cookie big"), std::string::npos)
        << found.front ().dump ();
        EXPECT_TRUE (trace_warnings (trace, "cookie_limit_reached").empty ());
        expect_no_cookie_value (trace);
        EXPECT_EQ (origin_->received_header ("Cookie").find ("typed"), std::string::npos)
        << "the typed row reached the server, so the record is not what is "
           "wrong";
        EXPECT_FALSE (sent_headers (trace).contains ("Cookie"))
        << "sentHeaders still claims a Cookie row the wire never carried";
    }
}

// Past 150 jar cookies libcurl sends 150 and says so; the typed row still goes
// out and stays in the record. Mutation-check: drop `CURLOPT_DEBUGFUNCTION` in
// `consume_sse_stream` and no warning arrives; return early from
// `stream_debug_callback` below verbosity 2 and the verbosity-0 pass finds
// none.
TEST_F (StreamExecuteTest, AStreamReportsTheJarCookieCountCap) {
    const vayu::tests::VerbosityRestorer restore;
    serve (1);
    cookie_jar_.store ("", loopback_jar_lines ("c", 151, 1));
    for (const int verbosity : { 0, 2 }) {
        vayu::utils::Logger::instance ().set_verbosity (verbosity);
        const auto run_id = start (typed_cookie_row ());
        ASSERT_FALSE (run_id.empty ());
        const auto trace = trace_for (run_id);

        ASSERT_EQ (trace_warnings (trace, "cookie_limit_reached").size (), 1U)
        << "verbosity " << verbosity << ": " << trace.dump (2);
        EXPECT_TRUE (trace_warnings (trace, "cookie_not_sent").empty ());
        EXPECT_NE (origin_->received_header ("Cookie").find ("typed=2"), std::string::npos);
        EXPECT_EQ (sent_headers (trace).value ("Cookie", ""), "typed=2");
    }
}

// libcurl keeps the first 50 cookies of a response and ignores the rest
// without a word. Mutation-check: drop `watch_set_cookie` in
// `stream_header_callback` and no warning arrives.
TEST_F (StreamExecuteTest, AStreamReportsTheFiftyFirstSetCookieAsIgnored) {
    serve (1);
    origin_->set_cookies (numbered_set_cookies (51));
    const auto run_id = start (json::object ());
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);

    const auto found = trace_warnings (trace, "cookie_dropped_too_many");
    ASSERT_EQ (found.size (), 1U) << trace.dump (2);
    EXPECT_NE (found.front ().value ("message", "").find ("1 Set-Cookie header after that was ignored"),
    std::string::npos)
    << found.front ().dump ();
    expect_no_cookie_value (trace);
}

// A `Set-Cookie` line over 5000 bytes is discarded unread; the trace names the
// cookie, never its value. Mutation-check: drop `watch_set_cookie` in
// `stream_header_callback` and no warning arrives.
TEST_F (StreamExecuteTest, AStreamNamesAnOversizedSetCookie) {
    serve (1);
    origin_->set_cookies ({ "huge=" + std::string (5000, 'v') + "; Path=/" });
    const auto run_id = start (json::object ());
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);

    const auto found = trace_warnings (trace, "cookie_dropped_oversized");
    ASSERT_EQ (found.size (), 1U) << trace.dump (2);
    EXPECT_NE (found.front ().value ("message", "").find (": huge."), std::string::npos)
    << found.front ().dump ();
    expect_no_cookie_value (trace);
}

// libcurl's per-response count restarts at every response, so 30 cookies on
// a followed redirect and 30 on the stream behind it are no overflow.
// Mutation-check: drop `start_response` in `stream_header_callback` and 10
// are reported ignored.
TEST_F (StreamExecuteTest, AStreamsSetCookieCountRestartsAtEachHop) {
    serve (1);
    origin_->hop_to (origin_->url ("/scripted"));
    origin_->hop_cookies (numbered_set_cookies (30, "h"));
    origin_->set_cookies (numbered_set_cookies (30));
    const auto run_id = start (json::object (), "/hop");
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);

    ASSERT_EQ (origin_->hops_received (), 1) << "the stream was not redirected";
    EXPECT_FALSE (trace.contains ("warnings")) << trace["warnings"].dump (2);
}

// Both hops of a redirect attach the same jar cookies and libcurl reports each
// time; the trace names the cookie once. Mutation-check: drop the
// de-duplication in `note_cookie_notice` and the count is 2.
TEST_F (StreamExecuteTest, ARedirectedStreamNamesAWithheldCookieOnce) {
    serve (1);
    cookie_jar_.store ("", loopback_jar_lines ("big", 3, 3000));
    origin_->hop_to (origin_->url ("/scripted"));
    const auto run_id = start (json::object (), "/hop");
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);

    ASSERT_EQ (origin_->hops_received (), 1) << "the stream was not redirected";
    EXPECT_EQ (trace_warnings (trace, "cookie_not_sent").size (), 1U) << trace.dump (2);
}

// The other branch of all four: a stream under every limit stores no
// `warnings` key, and its typed row stays in the record.
TEST_F (StreamExecuteTest, AStreamUnderEveryCookieLimitStoresNoWarnings) {
    serve (1);
    cookie_jar_.store ("", loopback_jar_lines ("small", 3, 10));
    origin_->set_cookies (numbered_set_cookies (50));
    const auto run_id = start (typed_cookie_row ());
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);

    EXPECT_FALSE (trace.contains ("warnings")) << trace["warnings"].dump (2);
    EXPECT_EQ (sent_headers (trace).value ("Cookie", ""), "typed=2");
}

// `disableCookies` keeps libcurl's cookie engine off, so nothing is withheld or
// dropped and nothing is reported; the same jar and origin warn with the jar
// on. Mutation-check: point `state.incoming_cookies` at the watch whether or
// not the stream has a jar and the jar-off run reports the 51st.
TEST_F (StreamExecuteTest, AStreamWithTheJarOffReportsNoCookieWarning) {
    serve (1);
    cookie_jar_.store ("", loopback_jar_lines ("big", 3, 3000));
    origin_->set_cookies (numbered_set_cookies (51));

    const auto run_id = start (json{ { "disableCookies", true } });
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);
    EXPECT_FALSE (trace.contains ("warnings")) << trace["warnings"].dump (2);

    const auto control = start (json::object ());
    ASSERT_FALSE (control.empty ());
    const auto jar_on = trace_for (control);
    EXPECT_EQ (trace_warnings (jar_on, "cookie_not_sent").size (), 1U)
    << jar_on.dump (2);
    EXPECT_EQ (trace_warnings (jar_on, "cookie_dropped_too_many").size (), 1U)
    << jar_on.dump (2);
}

// ---------------------------------------------------------------------------
// `pm.sendRequest` on a stream (issue #653)
//
// Whether a script may send is a property of who asked for the execution, not
// of the shape the response comes back in - `allow_send_request` is read from
// the payload before the route branches on `stream`. Both transports are held
// to the rule in one test each, because the defect these replace was precisely
// the two disagreeing while each looked right on its own: the flag reached the
// engine from a buffered Send and not from a streaming one, so the same button
// allowed a `pm.sendRequest` with the toggle off and refused it with the toggle
// on.
// ---------------------------------------------------------------------------

TEST_F (StreamExecuteTest, AStreamsScriptMaySendWhenTheCallerAskedForIt) {
    serve (1);
    // What the callback saw, written onto the request that goes on the wire -
    // the origin's own record, so this cannot pass on a callback that never
    // ran. `pm.sendRequest` is blocking, so the header is set before the
    // transfer starts.
    const std::string script = "pm.sendRequest('" + origin_->url ("/aside") +
    "', function (err, res) { "
    "  var seen = err ? 'error' : String(res.json().ok); "
    "  pm.request.headers.add({ key: 'X-Aside', value: seen }); "
    "});";
    const json payload = { { "elements", script_elements (script) },
        { "allowScriptRequests", true } };

    const auto buffered = send_buffered (payload);
    EXPECT_FALSE (buffered.contains ("preScriptError")) << buffered.dump (2);
    EXPECT_EQ (origin_->aside_requests (), 1);
    EXPECT_EQ (origin_->received_header ("X-Aside"), "true");

    const auto run_id = start (payload);
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);
    EXPECT_FALSE (trace.contains ("scripts") && trace["scripts"].contains ("preScriptError"))
    << trace.dump (2);
    EXPECT_EQ (origin_->aside_requests (), 2)
    << "the streaming send's script never reached the network";
    EXPECT_EQ (origin_->received_header ("X-Aside"), "true");
}

TEST_F (StreamExecuteTest, AStreamsScriptIsRefusedWhenTheCallerDidNotAsk) {
    serve (1);
    const std::string script =
    "pm.sendRequest('" + origin_->url ("/aside") + "', function () {});";
    const json payload = { { "elements", script_elements (script) } };

    const auto buffered = send_buffered (payload);
    ASSERT_TRUE (buffered.contains ("preScriptError")) << buffered.dump (2);
    EXPECT_NE (buffered["preScriptError"].get<std::string> ().find (
               "pm.sendRequest is not available"),
    std::string::npos)
    << buffered["preScriptError"];

    const auto run_id = start (payload);
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    ASSERT_TRUE (trace["scripts"].contains ("preScriptError")) << trace.dump (2);
    // The same message, not merely a refusal: a stream that refused for its own
    // reason would be the divergence this test exists to forbid.
    EXPECT_EQ (trace["scripts"]["preScriptError"], buffered["preScriptError"]);
    EXPECT_EQ (origin_->aside_requests (), 0)
    << "a denied script still reached the network";
}

/// The timeout a script's aside call reported, per script, in the `scripts`
/// node @p scripts (the buffered answer, or a stream's stored trace node).
/// Fails the test for a script whose line is missing or not a timeout.
void expect_asides_timed_out_within (const json& scripts,
int64_t at_least_ms,
int64_t under_ms,
const std::string& transport) {
    for (const std::string_view source : { "pre", "test" }) {
        std::string line;
        for (const auto& entry : scripts.value ("consoleLogs", json::array ())) {
            if (entry.value ("source", "") == source) {
                line = entry.value ("message", "");
            }
        }
        const auto after_ms = vayu::tests::timed_out_after_ms (line);
        if (!after_ms) {
            ADD_FAILURE () << transport << " " << source << " script's aside did not time out: '"
                           << line << "' in " << scripts.dump (2);
            continue;
        }
        EXPECT_GE (*after_ms, at_least_ms) << transport << " " << source << ": " << line;
        EXPECT_LT (*after_ms, under_ms) << transport << " " << source << ": " << line;
    }
}

// #2833: a script's `pm.sendRequest` with no `timeout` option takes the send's
// resolved timeout, the payload's `timeout` here, from both scripts of both
// transports. Each transport sets it on its own contexts (the buffered one in
// `execute_exchange`, the stream in its pre and post lambdas), so one test
// holds all four. Healthy: about 500 ms each. Broken: the compiled-in 30 s,
// clamped to the script's 5 s default budget, about 4,990 ms - which is also
// what bounds a broken build, four scripts at 5 s inside the 60 s CTest limit.
// Mutation checks: drop the `request_timeout_ms` line from
// `execute_exchange`'s bind (buffered fails), from `pre_ctx` or from
// `post_ctx` in `run_streaming_execution` (that stream script fails).
TEST_F (StreamExecuteTest, AScriptsSendRequestTakesTheSendsTimeoutOnBothTransports) {
    serve (1);
    const std::string script = "pm.sendRequest('" + origin_->url ("/silent") +
    "', function (err, res) { "
    "  console.log(err ? err.code + ' ' + err.message : 'answered ' + "
    "res.code); "
    "});";
    const json payload = { { "elements", script_elements (script, script) },
        { "allowScriptRequests", true }, { "timeout", 500 } };

    expect_asides_timed_out_within (send_buffered (payload), 500, 2500, "buffered");

    const auto run_id = start (payload);
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    expect_asides_timed_out_within (trace["scripts"], 500, 2500, "stream");
}

// Absent, not empty. A stream that produced nothing has an empty list; a
// response that was never a stream has no list at all, and `typeof` is what
// tells them apart.
TEST_F (StreamExecuteTest, AnOrdinarySendHasNoEventsSurfaceAtAll) {
    serve (1);
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    const json payload = { { "method", "GET" },
        { "url", origin_->url ("/scripted") }, { "elements", script_elements ("", R"JS(
        pm.test('not a stream', function () {
            pm.expect(typeof pm.response.events).to.equal('undefined');
            pm.expect(typeof pm.response.totalEvents).to.equal('undefined');
            pm.expect(typeof pm.response.eventsTruncated).to.equal('undefined');
        });
    )JS") } };

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
    EXPECT_EQ (served_trace_for (run_id)["events"]["items"].size (), 2u);
}

// Malformed frames are the origin's problem, not the run's: the parser drops
// them and the stream still terminates by a rule that names itself, with the
// events that were well formed intact.
TEST_F (StreamExecuteTest, MalformedFramesAreDroppedAndTheRunStillCompletes) {
    origin_ = std::make_unique<StreamServer> (std::vector<std::string>{
    ": a comment line, dispatched to nobody\n\n", "event: no-data-so-never-dispatched\n\n",
    "data: kept\n\n", "retry: notanumber\ndata: also kept\n\n" });
    const auto run_id = start (json{ { "elements", script_elements ("", R"JS(
        pm.test('only the frames that carried data arrived', function () {
            pm.expect(pm.response.totalEvents).to.equal(2);
            pm.expect(pm.response.events[0].data).to.equal('kept');
            pm.expect(pm.response.events[1].data).to.equal('also kept');
        });
    )JS") } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
    EXPECT_EQ (trace["events"]["endReason"], "completed");
}

// ---------------------------------------------------------------------------
// The stored body of a stream (issue #3238)
//
// What the route stores, through the real handler: the design bound reaches
// the transfer from the config table, and the trace's `bodyBytes` survives
// the storage cap. The transfer's own rules are the `SseConsumer` cases above.
// ---------------------------------------------------------------------------

// A stream pointed at an endpoint that answered with an error document keeps
// that document, for the trace and for the post-request script. Mutation
// check: drop the `hold_body_bytes` call and the stored body is "" and the
// script's `json()` fails.
TEST_F (StreamExecuteTest, AJsonErrorReplyIsStoredAsTheBody) {
    origin_ = std::make_unique<StreamServer> ();
    origin_->can (404, "application/json", { R"({"error":"x"})" });
    const auto run_id = start (json{ { "elements", script_elements ("", R"JS(
        pm.test('the error document is readable', function () {
            pm.expect(pm.response.code).to.equal(404);
            pm.expect(pm.response.json().error).to.equal('x');
        });
    )JS") } },
    "/canned");
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"], R"({"error":"x"})") << trace.dump (2);
    EXPECT_EQ (trace["response"].value ("bodyBytes", size_t{ 0 }), size_t{ 13 });
    EXPECT_FALSE (trace["response"].contains ("bodyCapped"));
    EXPECT_EQ (trace["events"]["totalEvents"], 0);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
}

/// One `data:` frame of @p payload_bytes copies of @p fill.
///
/// Kept out of line on GCC: inlined, the compiler knows the frame is 102 bytes
/// and reads the move of it into the caller's vector as a copy of that many
/// bytes out of a small-string buffer, a false -Warray-bounds that fails the
/// -O3 -Werror release leg on Ubuntu 22.04. Building it by append or by
/// `literal + std::string (n, c)` there fails the same way.
#if defined(__GNUC__) && !defined(__clang__)
[[gnu::noinline]]
#endif
std::string sse_data_frame (std::size_t payload_bytes, char fill) {
    constexpr std::string_view PREFIX = "data: ";
    std::string frame (PREFIX.size () + payload_bytes + 2, fill);
    frame.replace (0, PREFIX.size (), PREFIX);
    frame[frame.size () - 2] = '\n';
    frame[frame.size () - 1] = '\n';
    return frame;
}

// An event stream's bytes are stored once, as its body (#3770): the trace's
// `events` node keeps only what the bytes cannot say, and its size follows
// the bytes. Stored once, the row measured 12,726 characters for these 10,200
// bytes; with the list stored beside them it measured 27,854, so the bound
// sits between, at one and a half times the bytes. Mutation checks: drop
// `hold_body_bytes` and the body reads ""; store the parsed list beside the
// sidecar in the completion pass and the `items` and the size checks fail.
TEST_F (StreamExecuteTest, AnEventStreamStoresItsBytesOnceAsTheBody) {
    std::vector<std::string> chunks;
    std::string whole;
    for (int i = 0; i < 100; ++i) {
        chunks.push_back (sse_data_frame (94, static_cast<char> ('a' + (i % 26))));
        whole += chunks.back ();
    }
    ASSERT_EQ (whole.size (), 10200u);
    origin_           = std::make_unique<StreamServer> (std::move (chunks));
    const auto run_id = start (json::object ());
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"], whole) << trace.dump (2);
    EXPECT_EQ (trace["response"].value ("bodyBytes", size_t{ 0 }), whole.size ());
    EXPECT_FALSE (trace["response"].contains ("bodyCapped"));
    EXPECT_EQ (trace["events"]["totalEvents"], 100);
    EXPECT_EQ (trace["events"]["receivedAt"].size (), 100u);
    EXPECT_FALSE (trace["events"].contains ("items"));

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_LT (rows[0].trace_data.size (), whole.size () + (whole.size () / 2));
}

// The cap on a stream's body is the design bound, and it says so; the stream
// itself runs on and every event is still counted. Mutation check: drop the
// `spec.max_body_bytes` line in `run_streaming_execution` and the whole
// stream is kept, uncapped.
TEST_F (StreamExecuteTest, AnEventStreamPastTheDesignBoundIsCappedAndSaysSo) {
    set_config ("maxDesignResponseBodyBytes", "1024");
    const std::vector<std::string> chunks (30, sse_data_frame (98, 'z'));
    const std::size_t delivered = chunks.size () * chunks.front ().size ();
    origin_                     = std::make_unique<StreamServer> (chunks);
    const auto run_id           = start (json::object ());
    ASSERT_FALSE (run_id.empty ());

    auto trace = served_trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"].get<std::string> ().size (), 1024u)
    << trace.dump (2);
    EXPECT_EQ (trace["response"].value ("bodyCapped", false), true);
    EXPECT_EQ (trace["response"].value ("bodyBytes", size_t{ 0 }), delivered);
    EXPECT_EQ (trace["events"]["totalEvents"], 30);
    EXPECT_TRUE (trace["events"]["eventsTruncated"].get<bool> ());
    EXPECT_LT (trace["events"]["items"].size (), 30u);
}

/// `{"n": <i>}` events with ids, as `serve` writes them, joined.
std::string served_bytes (int count) {
    std::string bytes;
    for (int i = 0; i < count; ++i) {
        bytes += "id: e" + std::to_string (i) +
        "\nevent: tick\ndata: {\"n\": " + std::to_string (i) + "}\n\n";
    }
    return bytes;
}

/// `assert.contains`, `assert.size` and `extract.regex` over the body of a
/// three-event `serve` stream, each of which passes only on its bytes.
json body_reading_elements () {
    return json::array ({ { { "id", "el_contains" }, { "kind", "assert.contains" },
                          { "config", { { "field", "body" }, { "text", "\"n\": 2" } } } },
    { { "id", "el_size" }, { "kind", "assert.size" },
    { "config", { { "bytes", 64 }, { "op", "gte" } } } },
    { { "id", "el_regex" }, { "kind", "extract.regex" },
    { "config",
    { { "pattern", "\"n\": ([0-9]+)" }, { "template", "$1$" },
    { "variable", "lastN" }, { "matchNo", 3 }, { "required", true } } } } });
}

/// Each element's outcome in @p node, keyed by id.
std::map<std::string, std::string> outcomes_by_id (const json& node) {
    std::map<std::string, std::string> out;
    for (const auto& outcome : node) {
        out[outcome.value ("id", "")] = outcome.value ("outcome", "");
    }
    return out;
}

// The issue's acceptance criterion: an element that reads the body judges a
// streamed Send by the bytes it delivered, as the buffered transport (the one
// a collection run and a load run read) judges the same reply. Mutation
// check: drop the `hold_body_bytes` call in `stream_write_callback` and the
// stream's three outcomes read failed, failed and missing.
TEST_F (StreamExecuteTest, BodyReadingElementsJudgeAStreamAsTheBufferedSendDoes) {
    serve (3);
    const auto run_id = start (json{ { "elements", body_reading_elements () } });
    ASSERT_FALSE (run_id.empty ());
    const auto streamed = outcomes_by_id (trace_for (run_id)["elements"]);

    const auto buffered = outcomes_by_id (send_buffered (
    json{ { "elements", body_reading_elements () } })["elements"]);

    const std::map<std::string, std::string> all_ok{ { "el_contains", "ok" },
        { "el_size", "ok" }, { "el_regex", "ok" } };
    EXPECT_EQ (streamed, all_ok);
    EXPECT_EQ (buffered, all_ok);
}

// `pm.response.text()` over a stream is the stream's bytes, as it is over a
// buffered reply (owner decision on #3770). Mutation check: drop the
// `hold_body_bytes` call and the script reads "".
TEST_F (StreamExecuteTest, ThePostRequestScriptReadsTheStreamsBytesAsText) {
    serve (2);
    const auto run_id = start (json{ { "elements",
    script_elements ("",
    "pm.test('text is the bytes', function () { "
    "pm.expect(pm.response.text()).to.equal(" +
    json (served_bytes (2)).dump () + "); });") } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
}

// What `read_body` and `diff_bodies` read (#3770): two streams that delivered
// different events are served as different bodies, and each served list is
// the live one, arrival times included. Mutation checks: drop the
// `expand_stored_stream_events` call in `report_result_node` and no `items`
// is served; drop the `receivedAt` pairing in `buffered_stream_events_node`
// and the items differ from the live ones.
TEST_F (StreamExecuteTest, TheResultsRouteServesEachStreamsBytesAndItsLiveEvents) {
    serve (3);
    const auto first_run = start (json::object ());
    ASSERT_FALSE (first_run.empty ());
    auto first = served_trace_for (first_run);

    serve (5);
    const auto second_run = start (json::object ());
    ASSERT_FALSE (second_run.empty ());
    auto second = served_trace_for (second_run);

    EXPECT_EQ (first["response"]["body"], served_bytes (3));
    EXPECT_EQ (second["response"]["body"], served_bytes (5));
    EXPECT_NE (first["response"]["body"], second["response"]["body"]);

    for (auto [run_id, trace] : std::vector<std::pair<std::string, json>>{
         { first_run, first }, { second_run, second } }) {
        const auto live   = live_events (run_id);
        const auto& items = trace["events"]["items"];
        ASSERT_EQ (items.size (), live.size ()) << trace["events"].dump (2);
        for (std::size_t i = 0; i < live.size (); ++i) {
            EXPECT_TRUE (items[i].contains ("receivedAt")) << items[i].dump ();
            EXPECT_EQ (items[i], live[i]) << "item " << i;
        }
        EXPECT_EQ (trace["events"]["totalEvents"], live.size ());
        EXPECT_FALSE (trace["events"]["eventsTruncated"].get<bool> ());
        EXPECT_EQ (trace["events"]["endReason"], "completed");
        EXPECT_FALSE (trace["events"].contains ("receivedAt"));
    }

    // `GET /runs/:runId`'s `result`, which History seeds a design run from,
    // serves the same list. Mutation check: drop the
    // `expand_stored_stream_events` call in `attach_design_result`.
    const auto run = db_->get_run (first_run);
    ASSERT_HAS_VALUE (run);
    json payload = json::object ();
    vayu::json::attach_design_result (payload, *run, db_->get_results (first_run));
    EXPECT_EQ (payload["result"]["trace"]["events"], first["events"]);
}

// The event cap stops the transfer inside a chunk that held three events, and
// the body holds the whole chunk: the served list stops at the one the stream
// counted. Two bounds hold it, each enough alone: one arrival is kept per
// counted event, and the list never passes `totalEvents`. Mutation check:
// bound the list in `buffered_stream_events_node` by `max_stored_events`
// alone and three are served.
TEST_F (StreamExecuteTest, TheServedListStopsAtTheEventsTheStreamCounted) {
    origin_ = std::make_unique<StreamServer> (
    std::vector<std::string>{ "data: a\n\ndata: b\n\ndata: c\n\n" });
    const auto run_id = start (json{ { "maxStreamEvents", 1 } });
    ASSERT_FALSE (run_id.empty ());

    auto trace = served_trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"], "data: a\n\ndata: b\n\ndata: c\n\n");
    const auto live = live_events (run_id);
    ASSERT_EQ (live.size (), 1u);
    ASSERT_EQ (trace["events"]["items"].size (), 1u) << trace["events"].dump (2);
    EXPECT_EQ (trace["events"]["items"][0], live[0]);
    EXPECT_EQ (trace["events"]["totalEvents"], 1);
    EXPECT_EQ (trace["events"]["endReason"], "maxStreamEvents");
    EXPECT_FALSE (trace["events"]["eventsTruncated"].get<bool> ());
}

// The acceptance criterion (#3773): a Send that declares the OpenAI path gets
// each delta as its event's `text` on the relay, the same items on the served
// trace, and the joined reply as `streamText` there and in the post-request
// script, past `sseMaxStoredEvents` included. Mutation checks: drop the
// `spec.text_path` line in `run_streaming_execution` and nothing carries text;
// drop `streamTextPath` from `stream_trace_node` and the live events keep their
// text while the served trace and the script lose it.
TEST_F (StreamExecuteTest, ADeclaredTextPathReachesTheRelayTheTraceAndTheScript) {
    set_config ("sseMaxStoredEvents", "2");
    origin_ = std::make_unique<StreamServer> (chat_completion_chunks ());
    const auto run_id = start (
    json{ { "streamTextPath", OPENAI_CONTENT }, { "elements", script_elements ("", R"JS(
        pm.test('the joined reply', function () {
            pm.expect(pm.response.streamText).to.equal('Hello');
            pm.expect(pm.response.events[1].text).to.equal('Hel');
        });
    )JS") } });
    ASSERT_FALSE (run_id.empty ());

    auto trace      = served_trace_for (run_id);
    const auto live = live_events (run_id);
    ASSERT_EQ (live.size (), 5u);
    EXPECT_EQ (live[1].value ("text", ""), "Hel");
    EXPECT_EQ (live[3].value ("text", ""), "lo");

    const auto& items = trace["events"]["items"];
    ASSERT_EQ (items.size (), 2u) << trace["events"].dump (2);
    EXPECT_EQ (items[0], live[0]);
    EXPECT_EQ (items[1], live[1]);
    EXPECT_EQ (trace["events"].value ("streamText", "<absent>"), "Hello");

    ASSERT_EQ (trace["scripts"]["testResults"].size (), 1u) << trace.dump (2);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
}

// Past `maxDesignResponseBodyBytes` the body is a prefix and says so, and the
// count keeps going. Mutation check: drop the `spec.max_body_bytes` line in
// `run_streaming_execution` and the whole 3000 bytes are kept, uncapped.
TEST_F (StreamExecuteTest, AReplyPastTheDesignBoundIsCappedAndStillCounted) {
    set_config ("maxDesignResponseBodyBytes", "1024");
    origin_ = std::make_unique<StreamServer> ();
    const std::string chunk (1000, 'x');
    origin_->can (200, "text/plain", { chunk, chunk, chunk });
    const auto run_id = start (json::object (), "/canned");
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"].get<std::string> ().size (), 1024u)
    << trace.dump (2);
    EXPECT_EQ (trace["response"].value ("bodyCapped", false), true);
    EXPECT_EQ (trace["response"].value ("bodyBytes", size_t{ 0 }), size_t{ 3000 });
    EXPECT_FALSE (trace["response"].contains ("bodyTruncated"));
}

// Both cuts on one body: the design bound holds 2048 of 5000 bytes and the
// storage cap keeps 1024 of those. `bodyBytes` stays what the server sent.
// Mutation check: write `bodyBytes` unconditionally in `mark_body_cut` and it
// reads 2048, the held length.
TEST_F (StreamExecuteTest, TheStorageCapKeepsTheStreamsByteCount) {
    set_config ("maxDesignResponseBodyBytes", "2048");
    set_config ("maxTraceBodyBytes", "1024");
    origin_ = std::make_unique<StreamServer> ();
    origin_->can (200, "text/plain", { std::string (5000, 'y') });
    const auto run_id = start (json::object (), "/canned");
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"].get<std::string> ().size (), 1024u)
    << trace.dump (2);
    EXPECT_EQ (trace["response"].value ("bodyCapped", false), true);
    EXPECT_EQ (trace["response"].value ("bodyTruncated", false), true);
    EXPECT_EQ (trace["response"].value ("bodyBytes", size_t{ 0 }), size_t{ 5000 });
}

// ---------------------------------------------------------------------------
// Scripts on the buffered send (issue #725)
//
// The transport that *has* somewhere to return its results stores them too.
// Driven through the real `POST /execute` handler for the same reason the
// streaming cases above are: the wiring is the thing under test, and a test
// that called `record_design_result` directly would stay green with the route
// still throwing the node away.
// ---------------------------------------------------------------------------

TEST_F (StreamExecuteTest, ABufferedSendStoresTheScriptResultsItAlsoReturns) {
    serve (1);
    const auto body = send_buffered (json{ { "elements", script_elements ("", R"JS(
        console.log('asserted');
        pm.test('the origin answered', function () {
            pm.expect(pm.response.code).to.equal(200);
        });
        pm.test('and this one does not hold', function () {
            pm.expect(pm.response.code).to.equal(418);
        });
    )JS") } });
    ASSERT_TRUE (body.contains ("testResults")) << body.dump (2);

    const auto trace = latest_design_trace ();
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);

    // Key for key against the live body rather than field by field: the two
    // panes are the pair this codebase keeps finding drifted, and the only
    // assertion that cannot be satisfied by a subset is the whole object.
    json returned = json::object ();
    for (const char* key :
    { "testResults", "consoleLogs", "preScriptError", "postScriptError" }) {
        if (body.contains (key)) {
            returned[key] = body[key];
        }
    }
    EXPECT_EQ (trace["scripts"], returned) << trace["scripts"].dump (2);

    // And that the stored node really carries the distinctions the pane draws -
    // a restored run must tell passed from failed, and either from never-ran.
    ASSERT_EQ (trace["scripts"]["testResults"].size (), 2u);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ());
    EXPECT_FALSE (trace["scripts"]["testResults"][1]["passed"].get<bool> ());
    EXPECT_FALSE (trace["scripts"]["testResults"][1].value ("error", "").empty ());
    EXPECT_EQ (trace["scripts"]["consoleLogs"][0]["message"], "asserted");
}

// The other half of the rule the streaming path holds: absent means the send
// had no scripts, so an empty node must never be written. Without this,
// "always store something" would pass the test above.
TEST_F (StreamExecuteTest, ABufferedSendWithoutScriptsStoresNoScriptNode) {
    serve (1);
    const auto body = send_buffered (json::object ());
    EXPECT_FALSE (body.contains ("testResults")) << body.dump (2);

    const auto trace = latest_design_trace ();
    EXPECT_FALSE (trace.contains ("scripts")) << trace.dump (2);
    EXPECT_FALSE (trace.contains ("events")) << trace.dump (2);
}

// ---------------------------------------------------------------------------
// `timing.engineMs` (#2132): Vayu's own cost for a buffered send
//
// The handler's elapsed time less the transfer and the scripts, measured once
// and stored on the trace beside the other timing keys. Mutation checks: stop
// accumulating `script_ms` in `execute_exchange` (request_exchange.cpp) and the
// two slow-script cases red; write a different value to the trace than to the
// body in `run_buffered_execution` and the parity case reds; stop passing
// `engine_ms` to `record_design_result` and the stored-key cases red; stop
// subtracting `auth_fetch_ms` in `engine_cost_ms` (#2185) and the first-use
// token case reds.
// ---------------------------------------------------------------------------

/// A script that does nothing for @p ms, so its run is the bulk of the send.
std::string busy_script (int ms) {
    return "var t0 = Date.now(); while (Date.now() - t0 < " + std::to_string (ms) + ") {}";
}

// A loopback send's own cost is milliseconds; a figure this far over it means
// the wire or a script leaked in, which is what the cases below separate. The
// slow script is long enough that half of it clears a sanitizer build's own
// cost (compose, a DB write, a QuickJS start) with room to spare: at 400ms the
// bound was 200ms, close enough to a loaded runner's honest figure to flake.
constexpr double LOOPBACK_ENGINE_CEILING_MS = 1000.0;
constexpr int SLOW_SCRIPT_MS                = 1200;

TEST_F (StreamExecuteTest, ABufferedSendReportsItsEngineCostInTheTimingNode) {
    serve (1);
    const auto body = send_buffered (json::object ());

    ASSERT_TRUE (body["timing"].contains ("engineMs")) << body["timing"].dump (2);
    ASSERT_TRUE (body["timing"]["engineMs"].is_number ()) << body["timing"].dump (2);
    const double engine_ms = body["timing"]["engineMs"].get<double> ();
    EXPECT_GE (engine_ms, 0.0);
    EXPECT_LT (engine_ms, LOOPBACK_ENGINE_CEILING_MS);
}

TEST_F (StreamExecuteTest, ASlowPreRequestScriptIsNotCountedAsEngineCost) {
    serve (1);
    const auto body = send_buffered (
    json{ { "elements", script_elements (busy_script (SLOW_SCRIPT_MS)) } });

    EXPECT_LT (body["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << body["timing"].dump (2);
}

TEST_F (StreamExecuteTest, ASlowPostRequestScriptIsNotCountedAsEngineCost) {
    serve (1);
    const auto body = send_buffered (
    json{ { "elements", script_elements ("", busy_script (SLOW_SCRIPT_MS)) } });

    EXPECT_LT (body["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << body["timing"].dump (2);
}

/// A client-credentials config whose token comes from the fixture's `/token`.
json oauth2_auth_for (const std::string& token_url) {
    return { { "mode", "oauth2" },
        { "config",
        { { "grantType", "client_credentials" },
        { "accessTokenUrl", token_url }, { "clientId", "vayu-test" },
        { "clientSecret", "shh" }, { "autoFetchToken", true } } } };
}

// The wait on the identity provider is someone else's time, as a slow origin
// is. The second send proves the subtraction is of the fetch and not of a
// constant: a cached token costs no round trip, so the figure stays small
// because there is nothing slow in the send, not because something was removed.
TEST_F (StreamExecuteTest, AFirstUseTokenFetchIsNotCountedAsEngineCost) {
    serve (1);
    origin_->delay_token (SLOW_SCRIPT_MS);
    const json payload{ { "auth", oauth2_auth_for (origin_->url ("/token")) } };

    const auto started    = std::chrono::steady_clock::now ();
    const auto first      = send_buffered (payload);
    const auto elapsed_ms = std::chrono::duration<double, std::milli> (
    std::chrono::steady_clock::now () - started)
                            .count ();

    // The fetch ran inside this handler; without that the figure below proves
    // nothing.
    ASSERT_EQ (origin_->token_requests (), 1);
    ASSERT_GE (elapsed_ms, static_cast<double> (SLOW_SCRIPT_MS));
    EXPECT_LT (first["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << first["timing"].dump (2);
    EXPECT_EQ (latest_design_trace ()["engineMs"], first["timing"]["engineMs"]);

    const auto second = send_buffered (payload);
    EXPECT_EQ (origin_->token_requests (), 1)
    << "the second send must hit the cache";
    EXPECT_LT (second["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << second["timing"].dump (2);
}

// The restored response shows the figure the live one did: one value, taken
// before the write, so the two homes cannot disagree by construction.
TEST_F (StreamExecuteTest, TheStoredTraceCarriesTheEngineMsTheLiveBodyReturned) {
    serve (1);
    const auto body  = send_buffered (json::object ());
    const auto trace = latest_design_trace ();

    ASSERT_TRUE (trace.contains ("engineMs")) << trace.dump (2);
    EXPECT_EQ (trace["engineMs"], body["timing"]["engineMs"]);
    // Flat on the trace beside the other timing keys, never inside a node.
    EXPECT_TRUE (trace.contains ("wireMs")) << trace.dump (2);
}

// A streaming send answers 202 before any exchange has finished and has no
// handler-scoped figure to give; the stored trace says nothing either.
TEST_F (StreamExecuteTest, AStreamingSendCarriesNoEngineMs) {
    serve (1);
    json payload = { { "method", "GET" }, { "url", origin_->url ("/scripted") },
        { "stream", true } };
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    auto response = client.Post ("/execute", payload.dump (), "application/json");
    ASSERT_TRUE (response);
    ASSERT_EQ (response->status, 202) << response->body;
    const auto accepted = json::parse (response->body);
    EXPECT_FALSE (accepted.contains ("timing")) << accepted.dump (2);

    const auto trace = trace_for (accepted.value ("runId", std::string ()));
    EXPECT_FALSE (trace.contains ("engineMs")) << trace.dump (2);
}

// The early return before any exchange: no figure, and no error for lacking it.
TEST_F (StreamExecuteTest, AnAuthFailureReplyCarriesNoEngineMs) {
    serve (1);
    const auto body = send_buffered (json{ { "auth",
    { { "mode", "oauth2" }, { "autoFetchToken", false },
    { "accessTokenUrl", origin_->url ("/token") } } } });
    ASSERT_TRUE (body.contains ("authErrorCode")) << body.dump (2);

    if (body.contains ("timing")) {
        EXPECT_FALSE (body["timing"].contains ("engineMs")) << body.dump (2);
    }
    EXPECT_FALSE (latest_design_trace ().contains ("engineMs"));
}

// ---------------------------------------------------------------------------
// `timing.scriptMs` (#3676): the script time `engineMs` leaves out
//
// `exchange.script_ms`, taken once beside `engineMs` and stored flat on the
// trace. Only a lower bound is asserted for a slow script: an upper one is the
// side a loaded runner breaks. Mutation checks: stop accumulating `script_ms`
// in `execute_exchange` (request_exchange.cpp) and the two slow-script cases
// red; write a different value to the trace than to the body in
// `run_buffered_execution` and the parity case reds; drop the `scriptMs` key
// from the body or from `record_design_result` and the presence and parity
// cases red.
// ---------------------------------------------------------------------------

/// The share of an injected script delay `scriptMs` must show: the script
/// spins for at least the delay, so anything under it lost time.
constexpr double SCRIPT_MS_FLOOR = SLOW_SCRIPT_MS * 0.9;

TEST_F (StreamExecuteTest, ABufferedSendReportsAScriptTimeInTheTimingNode) {
    serve (1);
    const auto body = send_buffered (json::object ());

    ASSERT_TRUE (body["timing"].contains ("scriptMs")) << body["timing"].dump (2);
    ASSERT_TRUE (body["timing"]["scriptMs"].is_number ()) << body["timing"].dump (2);
    EXPECT_GE (body["timing"]["scriptMs"].get<double> (), 0.0);
}

TEST_F (StreamExecuteTest, ASlowPreRequestScriptShowsAsScriptTime) {
    serve (1);
    const auto body = send_buffered (
    json{ { "elements", script_elements (busy_script (SLOW_SCRIPT_MS)) } });

    EXPECT_GE (body["timing"]["scriptMs"].get<double> (), SCRIPT_MS_FLOOR)
    << body["timing"].dump (2);
    EXPECT_LT (body["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << body["timing"].dump (2);
}

TEST_F (StreamExecuteTest, ASlowPostRequestScriptShowsAsScriptTime) {
    serve (1);
    const auto body = send_buffered (
    json{ { "elements", script_elements ("", busy_script (SLOW_SCRIPT_MS)) } });

    EXPECT_GE (body["timing"]["scriptMs"].get<double> (), SCRIPT_MS_FLOOR)
    << body["timing"].dump (2);
    EXPECT_LT (body["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << body["timing"].dump (2);
}

// One reading, taken before the write, so the stored trace and the live body
// cannot disagree; flat on the trace beside `engineMs`, never inside a node.
TEST_F (StreamExecuteTest, TheStoredTraceCarriesTheScriptMsTheLiveBodyReturned) {
    serve (1);
    const auto body =
    send_buffered (json{ { "elements", script_elements (busy_script (50)) } });
    const auto trace = latest_design_trace ();

    ASSERT_TRUE (trace.contains ("scriptMs")) << trace.dump (2);
    EXPECT_EQ (trace["scriptMs"], body["timing"]["scriptMs"]);
    EXPECT_TRUE (trace.contains ("engineMs")) << trace.dump (2);
}

// A streaming send answers 202 with no exchange finished, and the auth-failure
// reply returns before any ran: neither has a figure, so neither stores one.
TEST_F (StreamExecuteTest, AStreamingSendCarriesNoScriptMs) {
    serve (1);
    json payload = { { "method", "GET" }, { "url", origin_->url ("/scripted") },
        { "stream", true } };
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    auto response = client.Post ("/execute", payload.dump (), "application/json");
    ASSERT_TRUE (response);
    ASSERT_EQ (response->status, 202) << response->body;
    const auto accepted = json::parse (response->body);
    EXPECT_FALSE (accepted.contains ("timing")) << accepted.dump (2);

    const auto trace = trace_for (accepted.value ("runId", std::string ()));
    EXPECT_FALSE (trace.contains ("scriptMs")) << trace.dump (2);
}

TEST_F (StreamExecuteTest, AnAuthFailureReplyCarriesNoScriptMs) {
    serve (1);
    const auto body = send_buffered (json{ { "auth",
    { { "mode", "oauth2" }, { "autoFetchToken", false },
    { "accessTokenUrl", origin_->url ("/token") } } } });
    ASSERT_TRUE (body.contains ("authErrorCode")) << body.dump (2);

    if (body.contains ("timing")) {
        EXPECT_FALSE (body["timing"].contains ("scriptMs")) << body.dump (2);
    }
    EXPECT_FALSE (latest_design_trace ().contains ("scriptMs"));
}

// The relay's `event: complete` is the app's one cue to read the report, so it
// must mean the run row and trace are stored (#3239). The post-request script
// spins so that the window between the transfer's end and the row write is
// wide; the report is read once, unpolled, the moment the relay ends. Healthy:
// one result, run terminal. Mutation check: close the context in
// `consume_sse_stream` again and the relay ends while the script still spins,
// leaving no result and the run `running`.
TEST_F (StreamExecuteTest, TheCompleteFrameMeansTheReportIsStored) {
    constexpr int POST_SCRIPT_MS = 500;
    serve (2);
    const auto run_id = start (json{ { "elements",
    script_elements ("", "console.log ('stored');" + busy_script (POST_SCRIPT_MS)) } });
    ASSERT_FALSE (run_id.empty ());

    httplib::Client relay ("127.0.0.1", port_);
    relay.set_read_timeout (20, 0);
    const auto events = relay.Get ("/runs/" + run_id + "/events");
    ASSERT_TRUE (events);
    ASSERT_EQ (events->status, 200);
    ASSERT_NE (events->body.find ("event: complete"), std::string::npos)
    << events->body;

    auto [status, report] = vayu::http::routes::run_report_response (*db_, run_id);
    ASSERT_EQ (status, 200) << report.dump (2);
    EXPECT_EQ (report["results"].size (), 1u) << report.dump (2);
    EXPECT_EQ (report["metadata"]["status"], "completed") << report.dump (2);

    const auto trace = latest_design_trace ();
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    ASSERT_FALSE (trace["scripts"]["consoleLogs"].empty ()) << trace.dump (2);
    EXPECT_EQ (trace["scripts"]["consoleLogs"][0]["message"], "stored");
}

// ---------------------------------------------------------------------------
// Stopping a stream that has already ended (#3342)
//
// The transfer reads the stop flag only while it runs, so a stream the server
// closed or that failed is past it when a Stop arrives during its post-request
// script. Each script here is parked in a `pm.sendRequest` to the held `/aside`
// until the route has signalled the stop, which puts the Stop between the
// transfer's end and the row write every time. Mutation check: answer
// `stopped` for every settled stream in `stream_stop_response` again and both
// tests fail.
// ---------------------------------------------------------------------------

class StreamStopTest : public StreamExecuteTest {
    protected:
    /// Stop @p run_id while its post-request script is parked, then let the
    /// script go, and return the answer.
    json stop_while_the_script_is_parked (const std::string& run_id) {
        if (!vayu::tests::wait_until (
            [this] () { return origin_->aside_requests () == 1; })) {
            ADD_FAILURE () << "the post-request script never reached /aside";
            origin_->release_aside ();
            return json::object ();
        }
        auto answer = std::async (
        std::launch::async, [this, run_id] () { return stop (run_id); });
        const auto stream = manager_->get (run_id);
        EXPECT_TRUE (vayu::tests::wait_until (
        [&stream] () { return stream && stream->requested_end ().has_value (); }))
        << "the route never signalled the stop";
        origin_->release_aside ();
        return answer.get ();
    }

    /// A payload whose post-request script sends to the held `/aside`.
    json parked_script_payload () const {
        const std::string script =
        "pm.sendRequest('" + origin_->url ("/aside") + "', function () {});";
        return { { "elements", script_elements ("", script) },
            { "allowScriptRequests", true } };
    }
};

TEST_F (StreamStopTest, AStopAfterTheServerEndedTheStreamAnswersCompleted) {
    serve (2);
    origin_->hold_aside ();
    const auto run_id = start (parked_script_payload ());
    ASSERT_FALSE (run_id.empty ());

    const auto body = stop_while_the_script_is_parked (run_id);
    EXPECT_EQ (body.value ("status", ""), "completed") << body.dump ();
    EXPECT_EQ (body.value ("message", ""), "The stream had already ended")
    << body.dump ();
    EXPECT_EQ (body.value ("totalEvents", -1), 2) << body.dump ();
    const auto run = db_->get_run (run_id);
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Completed);
}

TEST_F (StreamStopTest, AStopAfterTheStreamFailedAnswersFailed) {
    serve (0);
    origin_->hold_aside ();
    json payload      = parked_script_payload ();
    payload["url"]    = "http://127.0.0.1:1/nothing";
    const auto run_id = start (payload);
    ASSERT_FALSE (run_id.empty ());

    const auto body = stop_while_the_script_is_parked (run_id);
    EXPECT_EQ (body.value ("status", ""), "failed") << body.dump ();
    const auto run = db_->get_run (run_id);
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Failed);
}

// The Stop the transfer does read still answers what it decided.
TEST_F (StreamStopTest, AStopOfALiveStreamAnswersStopped) {
    origin_           = std::make_unique<StreamServer> ();
    const auto run_id = start (json::object (), "/endless");
    ASSERT_FALSE (run_id.empty ());
    const auto stream = manager_->get (run_id);
    ASSERT_NE (stream, nullptr);
    ASSERT_TRUE (vayu::tests::wait_until (
    [&stream] () { return stream->total_events () >= 1; }));

    const auto body = stop (run_id);
    EXPECT_EQ (body.value ("status", ""), "stopped") << body.dump ();
    EXPECT_EQ (body.value ("message", ""), "Stream stopped") << body.dump ();
}

// ---------------------------------------------------------------------------
// `persistVariables: false` (#1904), on both transports
//
// An extractor writing the globals and a post-request script writing the
// environment, in one send. With the flag the elements still run and report,
// and the script reads the extracted value back within the send, but neither
// row on disk changes; without it both are written, which is what keeps the
// unchanged-row assertions from passing vacuously. Mutation check: pass `true`
// for the flag at either transport's `persist_send_variables` call in
// execution.cpp and that transport's opted-out case reds.
// ---------------------------------------------------------------------------

class PersistVariablesExecuteTest : public StreamExecuteTest {
    protected:
    static constexpr const char* ENV_ID = "env_persist";

    void SetUp () override {
        StreamExecuteTest::SetUp ();
        vayu::db::Environment environment;
        environment.id         = ENV_ID;
        environment.name       = "Env";
        environment.variables  = "{}";
        environment.created_at = 1;
        environment.updated_at = 1;
        db_->save_environment (environment);

        vayu::db::Globals globals;
        globals.id         = "globals";
        globals.variables  = "{}";
        globals.updated_at = 1;
        db_->save_globals (globals);
    }

    /// The payload under test, @p persist stated only when it has a value.
    static json payload (std::optional<bool> persist) {
        json elements = json::array ();
        elements.push_back ({ { "id", "el_extract" }, { "kind", "extract.header" },
        { "config",
        { { "header", "Content-Type" }, { "variable", "fromExtractor" },
        { "scope", "globals" } } } });
        for (auto& script : script_elements ("", R"JS(
            pm.environment.set('fromScript', 'v');
            pm.test('the extracted value is visible within the send', function () {
                pm.expect(pm.globals.get('fromExtractor')).to.include('event-stream');
            });
        )JS")) {
            elements.push_back (std::move (script));
        }
        json body{ { "environmentId", ENV_ID }, { "elements", std::move (elements) } };
        if (persist) {
            body["persistVariables"] = *persist;
        }
        return body;
    }

    json stored_globals () {
        auto row = db_->get_globals ();
        if (!row) {
            ADD_FAILURE () << "the seeded globals row is gone";
            return json::object ();
        }
        return json::parse (row->variables);
    }

    json stored_environment () {
        auto row = db_->get_environment (ENV_ID);
        if (!row) {
            ADD_FAILURE () << "the seeded environment row is gone";
            return json::object ();
        }
        return json::parse (row->variables);
    }

    /// The send ran both elements: the extractor answered `ok` and the
    /// script's own assertion passed.
    static void expect_elements_ran (const json& elements, const json& tests) {
        ASSERT_TRUE (elements.is_array ()) << elements.dump (2);
        ASSERT_FALSE (elements.empty ()) << elements.dump (2);
        EXPECT_EQ (elements[0].value ("kind", ""), "extract.header")
        << elements.dump (2);
        EXPECT_EQ (elements[0].value ("outcome", ""), "ok") << elements.dump (2);
        ASSERT_EQ (tests.size (), 1u) << tests.dump (2);
        EXPECT_TRUE (tests[0].value ("passed", false)) << tests.dump (2);
    }
};

TEST_F (PersistVariablesExecuteTest, ABufferedSendThatOptsOutWritesNothingBack) {
    serve (1);
    const auto body = send_buffered (payload (false));
    expect_elements_ran (
    body.value ("elements", json ()), body.value ("testResults", json ()));

    EXPECT_EQ (stored_globals (), json::object ());
    EXPECT_EQ (stored_environment (), json::object ());
}

TEST_F (PersistVariablesExecuteTest, ABufferedSendPersistsByDefault) {
    serve (1);
    const auto body = send_buffered (payload (std::nullopt));
    expect_elements_ran (
    body.value ("elements", json ()), body.value ("testResults", json ()));

    EXPECT_TRUE (stored_globals ().contains ("fromExtractor"))
    << stored_globals ().dump ();
    EXPECT_TRUE (stored_environment ().contains ("fromScript"))
    << stored_environment ().dump ();
}

TEST_F (PersistVariablesExecuteTest, AStreamThatOptsOutWritesNothingBack) {
    serve (1);
    const auto run_id = start (payload (false));
    ASSERT_FALSE (run_id.empty ());
    // The trace is written after the persist call, so its arrival means the
    // completion callback has already decided.
    const auto trace = trace_for (run_id);
    expect_elements_ran (trace.value ("elements", json ()),
    trace.value ("scripts", json::object ()).value ("testResults", json ()));

    EXPECT_EQ (stored_globals (), json::object ());
    EXPECT_EQ (stored_environment (), json::object ());
}

TEST_F (PersistVariablesExecuteTest, AStreamPersistsByDefault) {
    serve (1);
    const auto run_id = start (payload (true));
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);
    expect_elements_ran (trace.value ("elements", json ()),
    trace.value ("scripts", json::object ()).value ("testResults", json ()));

    EXPECT_TRUE (stored_globals ().contains ("fromExtractor"))
    << stored_globals ().dump ();
    EXPECT_TRUE (stored_environment ().contains ("fromScript"))
    << stored_environment ().dump ();
}

// Refused before a run row exists, like every other malformed flag.
TEST_F (PersistVariablesExecuteTest, ANonBooleanFlagIsA400WithNoRunRow) {
    serve (1);
    json body                = payload (std::nullopt);
    body["method"]           = "GET";
    body["url"]              = origin_->url ("/scripted");
    body["persistVariables"] = "false";
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    auto response = client.Post ("/execute", body.dump (), "application/json");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 400) << response->body;
    EXPECT_NE (response->body.find ("persistVariables"), std::string::npos)
    << response->body;
    EXPECT_TRUE (db_->get_runs_paginated (vayu::db::RunFilter{}, 1, 0).empty ());
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
