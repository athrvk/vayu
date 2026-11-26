#pragma once

/**
 * @file sse_stream_fixture.hpp
 * @brief The in-process SSE server, the helpers and the `StreamExecuteTest` fixture shared by
 *        the `sse_stream*_test.cpp` files.
 *
 * The suites keep their names across those files, so `--gtest_filter` and the scratch-database
 * RESOURCE_LOCK list see them whole. `StreamExecuteTest` is defined here, once, outside an
 * anonymous namespace, so each translation unit sees the same type; gtest refuses a suite whose
 * `TEST_F`s name different fixture classes, which an anonymous namespace per file would be.
 */

// First, before anything that includes <httplib.h>: see the header. Needed
// for `proxy_server.hpp`, whose forwarder builds an `httplib::Client` from a URL.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <cstddef>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "wait_until.hpp"

namespace vayu::tests::sse_stream {

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
inline json script_elements (const std::string& pre, const std::string& post = "") {
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

inline vayu::Request get_request (const std::string& url) {
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = url;
    return request;
}

inline SseStreamRequest spec_for (const std::string& url, vayu::http::SseLimits limits) {
    SseStreamRequest spec;
    spec.run_id  = "run_test";
    spec.request = get_request (url);
    spec.limits  = limits;
    return spec;
}

/// Bounds tightened so a test that has to reach one does not take a minute.
inline vayu::http::SseLimits brisk_limits () {
    vayu::http::SseLimits limits;
    limits.idle_timeout_ms        = sse_constants::MIN_IDLE_TIMEOUT_MS;
    limits.max_stream_duration_ms = 30000;
    return limits;
}

/// The payloads of the `open` frames the ring is holding, in order.
inline std::vector<json> open_frames (const SseStreamContext& context) {
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
inline std::vector<json> ring_payloads (const SseStreamContext& context) {
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

inline constexpr const char* OPENAI_CONTENT = "$.choices[0].delta.content";

/// An OpenAI-compatible chat completion stream, one event per chunk: a
/// role-only chunk, two deltas around a ping, and the `[DONE]` sentinel. The
/// declared path reads "Hello" off it and nothing off the other three.
inline std::vector<std::string> chat_completion_chunks () {
    return { "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n", "event: ping\ndata: {}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n", "data: [DONE]\n\n" };
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

} // namespace vayu::tests::sse_stream
