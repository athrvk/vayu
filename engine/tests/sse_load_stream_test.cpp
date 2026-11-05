/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file sse_load_stream_test.cpp
 * @brief Bounded streams on the load event loop (issue #576), and on the
 *        single-request client a collection run's sequential steps send
 *        through (#3235).
 *
 * The invariant under test is not "the count is right" - `sse_frame_counter_test`
 * owns that - it is that **a stream-flagged transfer always completes, exactly
 * once, and as a success when a cap is what ended it.**
 *
 * That matters because the load loop is completion-driven: `in_flight()` is
 * `sent - completed` and concurrency refills per completion, so a transfer that
 * never completes leaks its slot for the rest of the run, and one that completes
 * as an error against a target that did nothing wrong makes every error rate and
 * every threshold verdict a lie.
 *
 * `BalancedAccountingUnderConcurrency` is the mutation check for both halves at
 * once: make a cap-ended stream an error (drop `stream_cap_reached` from the
 * completion branch in `curl_utils.cpp`) and it fails on the status assertions;
 * stop enforcing either cap and it fails by timing out against `/endless`.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/types.hpp"

namespace {

/// How long `/delayed` holds its first event after the headers.
constexpr std::chrono::milliseconds FIRST_EVENT_DELAY{ 300 };

/**
 * Two shapes of stream a cap has to end: one that never stops sending, and one
 * that connects and then says nothing at all.
 *
 * `/endless` is what the event cap is measured against - it always has another
 * event ready, so the cap is the only thing that can end it. `/silent` is what
 * the duration cap is measured against, and it is the case the write callback
 * structurally cannot cover: no bytes arrive, so only the progress callback
 * ever runs.
 */
class LoadStreamServer {
    public:
    LoadStreamServer () {
        // A stream outlives cpp-httplib's stock 5s write budget by design.
        svr_.set_write_timeout (60, 0);

        svr_.Get ("/endless", [this] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider (
            "text/event-stream", [this] (size_t, httplib::DataSink& sink) {
                while (!stopping_.load ()) {
                    // A keep-alive comment beside every event, so a run that
                    // counted frames rather than events would report twice the
                    // truth and the cap would trip at half the events.
                    const std::string frame = ": keep-alive\n\ndata: tick\n\n";
                    if (!sink.write (frame.data (), frame.size ())) {
                        return false;
                    }
                    std::this_thread::sleep_for (std::chrono::milliseconds (2));
                }
                sink.done ();
                return true;
            });
        });

        svr_.Get ("/silent", [this] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider (
            "text/event-stream", [this] (size_t, httplib::DataSink& sink) {
                while (!stopping_.load ()) {
                    std::this_thread::sleep_for (std::chrono::milliseconds (10));
                }
                sink.done ();
                return true;
            });
        });

        svr_.Get ("/finite", [] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider (
            "text/event-stream", [] (size_t, httplib::DataSink& sink) {
                const std::string body =
                "data: a\n\n: ping\n\ndata: b\n\ndata: c\n\n";
                sink.write (body.data (), body.size ());
                sink.done ();
                return true;
            });
        });

        // Headers and a keep-alive at once, the first event FIRST_EVENT_DELAY
        // later: the shape of a gateway that answers 200 and then thinks.
        svr_.Get ("/delayed", [] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider (
            "text/event-stream", [] (size_t, httplib::DataSink& sink) {
                const std::string keep_alive = ": thinking\n\n";
                sink.write (keep_alive.data (), keep_alive.size ());
                std::this_thread::sleep_for (FIRST_EVENT_DELAY);
                const std::string event = "data: first\n\n";
                sink.write (event.data (), event.size ());
                sink.done ();
                return true;
            });
        });

        // One event whose frame the close completes, never a blank line.
        svr_.Get ("/unterminated", [] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider (
            "text/event-stream", [] (size_t, httplib::DataSink& sink) {
                const std::string body = "data: last";
                sink.write (body.data (), body.size ());
                sink.done ();
                return true;
            });
        });

        svr_.Get ("/plain", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("not a stream", "text/plain");
        });

        // Accepts the request and sends no status line until the server
        // stops: a duration cap that passes here has no response to report.
        svr_.Get ("/mute", [this] (const httplib::Request&, httplib::Response& res) {
            while (!stopping_.load ()) {
                std::this_thread::sleep_for (std::chrono::milliseconds (10));
            }
            res.set_content ("too late", "text/plain");
        });

        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~LoadStreamServer () {
        stopping_.store (true);
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    LoadStreamServer (const LoadStreamServer&)            = delete;
    LoadStreamServer& operator= (const LoadStreamServer&) = delete;
    LoadStreamServer (LoadStreamServer&&)                 = delete;
    LoadStreamServer& operator= (LoadStreamServer&&)      = delete;

    [[nodiscard]] std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port_) + path;
    }

    private:
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    std::atomic<bool> stopping_{ false };
};

vayu::Request stream_request (const std::string& url, int64_t max_events, int64_t max_duration_ms) {
    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = url;
    request.timeout_ms = 30000;
    vayu::StreamBounds bounds;
    bounds.max_events      = max_events;
    bounds.max_duration_ms = max_duration_ms;
    request.stream_bounds  = bounds;
    return request;
}

/// One transfer through a started loop, with the result the callback saw.
vayu::Result<vayu::Response>
run_one (vayu::http::EventLoop& loop, const vayu::Request& request) {
    auto handle = loop.submit_async (request);
    return handle.future.get ();
}

vayu::http::EventLoopConfig one_worker () {
    vayu::http::EventLoopConfig config;
    config.num_workers = 1;
    return config;
}

} // namespace

// ---------------------------------------------------------------------------
// A cap is a successful end
// ---------------------------------------------------------------------------

TEST (SseLoadStreamTest, EventCapEndsAnEndlessStreamAsASuccess) {
    LoadStreamServer server;
    vayu::http::EventLoop loop (one_worker ());
    loop.start ();

    auto result = run_one (loop, stream_request (server.url ("/endless"), 5, 30000));

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    // The whole point: libcurl reports the aborted write, and the completion
    // reports a 200. A stream that ended exactly as asked is not a failure.
    EXPECT_FALSE (response.has_error ()) << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_GE (*response.stream_events, 5u);
    EXPECT_TRUE (response.stream_capped);

    loop.stop ();
}

TEST (SseLoadStreamTest, DurationCapEndsASilentStreamAsASuccess) {
    // The case write_callback cannot see: the server sends nothing at all, so
    // only the progress callback can end the transfer.
    LoadStreamServer server;
    vayu::http::EventLoop loop (one_worker ());
    loop.start ();

    const auto started = std::chrono::steady_clock::now ();
    auto result = run_one (loop, stream_request (server.url ("/silent"), 1000000, 1200));
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started);

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_FALSE (response.has_error ()) << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    EXPECT_TRUE (response.stream_capped);
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 0u)
    << "a silent stream delivered nothing, and says so";
    EXPECT_FALSE (response.stream_first_event_ms.has_value ())
    << "no event arrived, so there is no time to first event (#3234)";
    // Ended by the cap, well before the backstop timeout that sits
    // LOAD_STREAM_TIMEOUT_GRACE_MS past it.
    EXPECT_LT (elapsed.count (), 1200 + vayu::core::constants::sse::LOAD_STREAM_TIMEOUT_GRACE_MS);

    loop.stop ();
}

TEST (SseLoadStreamTest, AServerClosedStreamCompletesUncappedWithItsEvents) {
    LoadStreamServer server;
    vayu::http::EventLoop loop (one_worker ());
    loop.start ();

    auto result = run_one (loop, stream_request (server.url ("/finite"), 1000, 30000));

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_FALSE (response.has_error ()) << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    ASSERT_HAS_VALUE (response.stream_events);
    // Three `data` frames and one comment-only keep-alive: the keep-alive is
    // not an event, here as on the design path.
    EXPECT_EQ (*response.stream_events, 3u);
    EXPECT_FALSE (response.stream_capped)
    << "the server ended this stream, so no cap did - the report's `capped` "
       "tally has to be able to tell the two apart";

    loop.stop ();
}

// ---------------------------------------------------------------------------
// Time to first event (issue #3234)
// ---------------------------------------------------------------------------

// The headers and a keep-alive arrive at once, the event 300ms later. Healthy,
// the stamp reads at least 300ms; read off libcurl's start-transfer time it
// reads the few milliseconds the headers took. A lower bound only, so a slow
// runner cannot fail it. Mutation check: copy `timing.first_byte_ms` into
// `stream_first_event_ms` in `curl_utils.cpp` and the first bound fails.
TEST (SseLoadStreamTest, TheFirstEventIsTimedFromSubmissionNotFromTheHeaders) {
    LoadStreamServer server;
    vayu::http::EventLoop loop (one_worker ());
    loop.start ();

    auto result = run_one (loop, stream_request (server.url ("/delayed"), 1000, 30000));

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_FALSE (response.has_error ()) << response.error_message;
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 1u);
    ASSERT_HAS_VALUE (response.stream_first_event_ms);
    const double first_event_ms = *response.stream_first_event_ms;
    EXPECT_GE (first_event_ms, static_cast<double> (FIRST_EVENT_DELAY.count ()));
    EXPECT_LE (first_event_ms, response.timing.total_ms)
    << "the first event cannot arrive after the transfer completed";
    EXPECT_LT (response.timing.first_byte_ms, first_event_ms)
    << "the headers came before the event, which is the gap this measures";

    loop.stop ();
}

// An event the close completed was counted by `finish` at completion, so no
// write said when it arrived and no time is invented for it.
TEST (SseLoadStreamTest, AnEventOnlyTheCloseCompletedIsCountedButNotTimed) {
    LoadStreamServer server;
    vayu::http::EventLoop loop (one_worker ());
    loop.start ();

    auto result =
    run_one (loop, stream_request (server.url ("/unterminated"), 1000, 30000));

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 1u);
    EXPECT_FALSE (response.stream_first_event_ms.has_value ());

    loop.stop ();
}

TEST (SseLoadStreamTest, AnOrdinaryTransferCarriesNoEventCount) {
    // The absent-not-zero rule at its source: a non-streaming request must
    // leave `stream_events` unset, or every ordinary load run grows a `stream`
    // section reporting zero events.
    LoadStreamServer server;
    vayu::http::EventLoop loop (one_worker ());
    loop.start ();

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = server.url ("/plain");
    request.timeout_ms = 10000;

    auto result = run_one (loop, request);

    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().status_code, 200);
    EXPECT_FALSE (result.value ().stream_events.has_value ());
    EXPECT_FALSE (result.value ().stream_capped);
    EXPECT_FALSE (result.value ().stream_first_event_ms.has_value ());

    loop.stop ();
}

// ---------------------------------------------------------------------------
// The accounting invariant
// ---------------------------------------------------------------------------

TEST (SseLoadStreamTest, BalancedAccountingUnderConcurrency) {
    // Every submitted stream completes exactly once against a target that never
    // stops sending. This is the property the whole feature exists to protect:
    // one missing completion permanently inflates `in_flight()` and shrinks the
    // run's effective concurrency for as long as it lasts.
    LoadStreamServer server;
    vayu::http::EventLoopConfig config;
    config.num_workers = 2;
    vayu::http::EventLoop loop (config);
    loop.start ();

    constexpr size_t STREAMS = 12;
    std::atomic<size_t> completed{ 0 };
    std::atomic<size_t> succeeded{ 0 };
    std::atomic<size_t> capped{ 0 };
    std::atomic<size_t> with_counts{ 0 };

    for (size_t i = 0; i < STREAMS; ++i) {
        loop.submit (stream_request (server.url ("/endless"), 3, 20000),
        [&] (size_t, const vayu::Result<vayu::Response>& result) {
            completed.fetch_add (1);
            if (result.is_ok ()) {
                if (!result.value ().has_error ()) {
                    succeeded.fetch_add (1);
                }
                if (result.value ().stream_capped) {
                    capped.fetch_add (1);
                }
                if (result.value ().stream_events.has_value ()) {
                    with_counts.fetch_add (1);
                }
            }
        });
    }

    // Generous, and still far short of a leak: an unbounded stream against
    // `/endless` would never return here at all.
    const auto deadline = std::chrono::steady_clock::now () + std::chrono::seconds (30);
    while (completed.load () < STREAMS && std::chrono::steady_clock::now () < deadline) {
        std::this_thread::sleep_for (std::chrono::milliseconds (20));
    }

    EXPECT_EQ (completed.load (), STREAMS)
    << "a stream that never completes leaks its slot";
    EXPECT_EQ (succeeded.load (), STREAMS)
    << "a cap-ended stream is a successful completion";
    EXPECT_EQ (capped.load (), STREAMS);
    EXPECT_EQ (with_counts.load (), STREAMS);
    EXPECT_EQ (loop.active_count (), 0u);

    loop.stop ();
}

// ---------------------------------------------------------------------------
// The same bounds on the single-request client (#3235)
// ---------------------------------------------------------------------------

// A collection run's sequential steps send through `Client`, so a stored
// streaming request reaches it bounded, and it ends by the event loop's
// rules. One send, the way the runner makes it.
namespace {
vayu::Response
send_one (const vayu::Request& request, vayu::http::ClientConfig config = {}) {
    vayu::http::Client client (std::move (config));
    return client.send (request).value ();
}
} // namespace

// Healthy, the silent stream ends at its 1200 ms cap as a capped 200. With
// the bounds ignored it fails at its own 300 ms timeout, which is the
// mutation check: send `timeout_ms` as `CURLOPT_TIMEOUT_MS` in `Client::send`
// again and every assertion below fails.
TEST (SseClientStreamTest, ADurationCapEndsAStreamHeldPastItsTimeoutAsASuccess) {
    LoadStreamServer server;
    auto request       = stream_request (server.url ("/silent"), 1000000, 1200);
    request.timeout_ms = 300;

    const auto response = send_one (request);

    EXPECT_FALSE (response.has_error ()) << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    EXPECT_TRUE (response.stream_capped);
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 0u);
}

TEST (SseClientStreamTest, AnEventCapEndsAnEndlessStreamAsASuccessWithItsBody) {
    LoadStreamServer server;
    const auto response = send_one (stream_request (server.url ("/endless"), 5, 30000));

    EXPECT_FALSE (response.has_error ()) << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    EXPECT_TRUE (response.stream_capped);
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_GE (*response.stream_events, 5u);
    EXPECT_NE (response.body.find ("data: tick"), std::string::npos)
    << "the body is the events, as a load sample's is";
    EXPECT_FALSE (response.body_truncated);
}

TEST (SseClientStreamTest, AServerClosedStreamCompletesUncappedAndTimesItsFirstEvent) {
    LoadStreamServer server;
    const auto finite = send_one (stream_request (server.url ("/finite"), 1000, 30000));
    EXPECT_FALSE (finite.has_error ()) << finite.error_message;
    ASSERT_HAS_VALUE (finite.stream_events);
    EXPECT_EQ (*finite.stream_events, 3u);
    EXPECT_FALSE (finite.stream_capped);

    // A lower bound only, as `TheFirstEventIsTimedFromSubmissionNotFromTheHeaders`
    // above: healthy it reads at least the 300 ms the server holds the event.
    const auto delayed = send_one (stream_request (server.url ("/delayed"), 1000, 30000));
    ASSERT_HAS_VALUE (delayed.stream_first_event_ms);
    EXPECT_GE (*delayed.stream_first_event_ms,
    static_cast<double> (FIRST_EVENT_DELAY.count ()));
}

// A stop ends a stream the server answered, as `POST /runs/:id/stop` ends a
// design stream, rather than failing it. The cancel is raised from the first
// body write, so the stream is known to be open. Mutation check: drop
// `watch.cancelled` from `stream_ended_by_rule` and the response is a
// `Cancelled` error.
TEST (SseClientStreamTest, ACancelEndsAnAnsweredStreamWithWhatItDelivered) {
    LoadStreamServer server;
    std::atomic<bool> cancel{ false };
    vayu::http::ClientConfig config;
    config.cancel           = &cancel;
    config.on_body_progress = [&cancel] (uint64_t, std::optional<uint64_t>) {
        cancel.store (true);
        return true;
    };

    const auto response = send_one (
    stream_request (server.url ("/endless"), 10000000, 30000), std::move (config));

    EXPECT_FALSE (response.has_error ()) << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    EXPECT_FALSE (response.stream_capped) << "the stop ended it, not a cap";
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_GT (*response.stream_events, 0u);
}

// Before a status line there is no response to report, so a cap that passes
// there is an error that names the cap rather than a status-0 success.
TEST (SseClientStreamTest, ADurationCapBeforeAnyAnswerIsATimeoutNamingTheCap) {
    LoadStreamServer server;
    const auto response = send_one (stream_request (server.url ("/mute"), 1000, 1000));

    ASSERT_TRUE (response.has_error ());
    EXPECT_EQ (response.error_code, vayu::ErrorCode::Timeout);
    EXPECT_NE (response.error_message.find ("1000 ms duration cap"), std::string::npos)
    << response.error_message;
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 0u);
}

TEST (SseClientStreamTest, AnOrdinarySendCarriesNoEventCount) {
    LoadStreamServer server;
    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = server.url ("/plain");
    request.timeout_ms = 10000;

    const auto response = send_one (request);

    EXPECT_EQ (response.status_code, 200);
    EXPECT_EQ (response.body, "not a stream");
    EXPECT_FALSE (response.stream_events.has_value ());
    EXPECT_FALSE (response.stream_capped);
}
