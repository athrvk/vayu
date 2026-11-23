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
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/stream_tally.hpp"
#include "vayu/types.hpp"
#include "wait_until.hpp"

namespace {

/// How long `/delayed` holds its first event after the headers.
constexpr std::chrono::milliseconds FIRST_EVENT_DELAY{ 300 };

/// How long `/paused` waits between its two events, once the client has
/// counted the first.
constexpr std::chrono::milliseconds EVENT_PAUSE{ 300 };

/// The body of every reply that is not a stream: one event's worth of bytes
/// under another content type.
constexpr std::string_view NOT_A_STREAM_BODY =
"data: {\"error\":\"rate limited\"}\n\n";

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

        // One event, then EVENT_PAUSE from the moment the client's tally has
        // counted it (`paused_live`, which the test puts on the request), then
        // a second. Timed from the client's count rather than the first
        // write, so a client slow to read the first event cannot shorten
        // the gap it measures.
        svr_.Get ("/paused", [this] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider (
            "text/event-stream", [this] (size_t, httplib::DataSink& sink) {
                const std::string first = "data: a\n\n";
                sink.write (first.data (), first.size ());
                while (paused_live_->events.load () == 0 && !stopping_.load ()) {
                    std::this_thread::sleep_for (std::chrono::milliseconds (1));
                }
                std::this_thread::sleep_for (EVENT_PAUSE);
                const std::string second = "data: b\n\n";
                sink.write (second.data (), second.size ());
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

        // Replies to a streaming request that are not streams (#3771). Each
        // body is shaped like an event, so a tally that counted a body it
        // should not have read would show it in the event and live counts.
        svr_.Get ("/rate-limited", [] (const httplib::Request&, httplib::Response& res) {
            res.status = 429;
            res.set_content (NOT_A_STREAM_BODY.data (),
            NOT_A_STREAM_BODY.size (), "application/json");
        });
        svr_.Get ("/json", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (NOT_A_STREAM_BODY.data (),
            NOT_A_STREAM_BODY.size (), "application/json");
        });
        svr_.Get ("/redirect-to-json",
        [this] (const httplib::Request&, httplib::Response& res) {
            res.set_redirect (url ("/json"));
        });
        svr_.Get ("/redirect-to-finite",
        [this] (const httplib::Request&, httplib::Response& res) {
            res.set_redirect (url ("/finite"));
        });
        // A JSON answer whose body never finishes: only the duration cap can
        // end it, and what it ends is not a stream.
        svr_.Get ("/slow-json", [this] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider (
            "application/json", [this] (size_t, httplib::DataSink& sink) {
                const std::string start = "{\"partial\":";
                if (!sink.write (start.data (), start.size ())) {
                    return false;
                }
                while (!stopping_.load ()) {
                    std::this_thread::sleep_for (std::chrono::milliseconds (10));
                }
                sink.done ();
                return true;
            });
        });
        // A rate-limited stream: every other request is refused with a 429.
        svr_.Get ("/sse-or-429", [this] (const httplib::Request&, httplib::Response& res) {
            if (sse_or_429_hits_.fetch_add (1) % 2 == 1) {
                res.status = 429;
                res.set_content (NOT_A_STREAM_BODY.data (),
                NOT_A_STREAM_BODY.size (), "application/json");
                return;
            }
            res.set_chunked_content_provider (
            "text/event-stream", [] (size_t, httplib::DataSink& sink) {
                const std::string body = "data: a\n\ndata: b\n\n";
                sink.write (body.data (), body.size ());
                sink.done ();
                return true;
            });
        });
        // Announces an event stream, sends two events, then drops the
        // connection without ending the chunked body (#3240).
        svr_.Get ("/sse-then-reset", [] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider (
            "text/event-stream", [] (size_t, httplib::DataSink& sink) {
                const std::string body = "data: a\n\ndata: b\n\n";
                sink.write (body.data (), body.size ());
                return false;
            });
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

    /// The live counters `/paused` reads; one `/paused` request per server.
    [[nodiscard]] std::shared_ptr<vayu::LiveStreamCounts> paused_live () const {
        return paused_live_;
    }

    private:
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    std::atomic<bool> stopping_{ false };
    // Built before the listener thread starts, so the handler reads it safely.
    std::shared_ptr<vayu::LiveStreamCounts> paused_live_ =
    std::make_shared<vayu::LiveStreamCounts> ();
    std::atomic<int> sse_or_429_hits_{ 0 };
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

// ---------------------------------------------------------------------------
// The largest event gap and the per-stream rate (issue #3776)
// ---------------------------------------------------------------------------

namespace {
vayu::Headers event_stream_headers () {
    vayu::Headers headers;
    headers["Content-Type"] = "text/event-stream";
    return headers;
}
} // namespace

// The tally's rules on a clock the test owns. Arrivals: one event at 5 ms, a
// keep-alive at 20 ms (no event, so no arrival), two events in one write at
// 30 ms (one stamp), and at 100 ms the start of a frame only the close
// completes. Healthy: first event 5 ms, largest gap 25 ms, rate (3 - 1)
// events over 25 ms = 80/s. Mutation checks: stamp every write and the gap
// reads 70 ms; count the frame `finish` completed into the rate and it reads
// 120/s; stop updating the gap and both are absent.
TEST (StreamTallyTimingTest, OnlyWritesThatCompleteAnEventAreArrivals) {
    using std::chrono::milliseconds;
    const auto started = vayu::http::StreamTally::Clock::now ();
    const auto headers = event_stream_headers ();
    vayu::http::StreamTally tally;
    tally.start (vayu::StreamBounds{ 60000, 1000 }, started);

    tally.feed ("data: a\n\n", headers, started + milliseconds (5));
    tally.feed (": ping\n\n", headers, started + milliseconds (20));
    tally.feed ("data: b\n\ndata: c\n\n", headers, started + milliseconds (30));
    tally.feed ("data: d", headers, started + milliseconds (100));
    vayu::Response response;
    response.headers = headers;
    tally.report (response);

    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 4u)
    << "the close completed the last frame";
    ASSERT_HAS_VALUE (response.stream_first_event_ms);
    EXPECT_DOUBLE_EQ (*response.stream_first_event_ms, 5.0);
    ASSERT_HAS_VALUE (response.stream_max_event_gap_ms);
    EXPECT_DOUBLE_EQ (*response.stream_max_event_gap_ms, 25.0);
    ASSERT_HAS_VALUE (response.stream_event_rate);
    EXPECT_NEAR (*response.stream_event_rate, 80.0, 1e-9);
}

// A first write that replays a backlog took no measured time, so its events
// stay out of the rate: 100 events at 10 ms, then one event a second for 10 s
// is 10 events over 10 s. Healthy: 1/s. Mutation check: count every event
// after the first one (`events_at_last_arrival_ - 1`) and it reads 10.9/s.
TEST (StreamTallyTimingTest, AFirstWriteBacklogIsNotInTheRate) {
    using std::chrono::milliseconds;
    using std::chrono::seconds;
    const auto started = vayu::http::StreamTally::Clock::now ();
    const auto headers = event_stream_headers ();
    vayu::http::StreamTally tally;
    tally.start (vayu::StreamBounds{ 60000, 1000 }, started);

    std::string backlog;
    for (int i = 0; i < 100; ++i) {
        backlog += "data: replayed\n\n";
    }
    const auto first = started + milliseconds (10);
    tally.feed (backlog, headers, first);
    for (int i = 1; i <= 10; ++i) {
        tally.feed ("data: live\n\n", headers, first + seconds (i));
    }
    vayu::Response response;
    response.headers = headers;
    tally.report (response);

    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 110u);
    ASSERT_HAS_VALUE (response.stream_event_rate);
    EXPECT_NEAR (*response.stream_event_rate, 1.0, 1e-9);
}

// One write has no gap and no span, whatever it carried; two writes at one
// instant have a gap of 0 and no rate, since the span is nothing to divide by.
TEST (StreamTallyTimingTest, OneArrivalHasNoGapAndAZeroSpanHasNoRate) {
    const auto started = vayu::http::StreamTally::Clock::now ();
    const auto headers = event_stream_headers ();
    vayu::Response one_write;
    one_write.headers = headers;
    {
        vayu::http::StreamTally tally;
        tally.start (vayu::StreamBounds{ 60000, 1000 }, started);
        tally.feed ("data: a\n\ndata: b\n\ndata: c\n\n", headers, started);
        tally.report (one_write);
    }
    EXPECT_FALSE (one_write.stream_max_event_gap_ms.has_value ());
    EXPECT_FALSE (one_write.stream_event_rate.has_value ());

    vayu::Response same_instant;
    same_instant.headers = headers;
    {
        vayu::http::StreamTally tally;
        tally.start (vayu::StreamBounds{ 60000, 1000 }, started);
        tally.feed ("data: a\n\n", headers, started);
        tally.feed ("data: b\n\n", headers, started);
        tally.report (same_instant);
    }
    ASSERT_HAS_VALUE (same_instant.stream_max_event_gap_ms);
    EXPECT_DOUBLE_EQ (*same_instant.stream_max_event_gap_ms, 0.0);
    EXPECT_FALSE (same_instant.stream_event_rate.has_value ());
}

// One pause on the wire. `/paused` starts its EVENT_PAUSE only once the
// tally has counted the first event, so the healthy gap is at least that
// pause however slowly this runner reads; the broken readings are no gap at
// all, or one near 0. A lower bound only, which a slow runner cannot fail.
// The rate is one event over at least that span, so at most 1000 / 300 per
// second, a bound a slow runner can only move further from.
TEST (SseLoadStreamTest, APauseBetweenEventsIsTheStreamsLargestGap) {
    LoadStreamServer server;
    vayu::http::EventLoop loop (one_worker ());
    loop.start ();
    auto request = stream_request (server.url ("/paused"), 1000, 30000);
    ASSERT_HAS_VALUE (request.stream_bounds);
    request.stream_bounds->live = server.paused_live ();

    auto result = run_one (loop, request);

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_FALSE (response.has_error ()) << response.error_message;
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 2u);
    ASSERT_HAS_VALUE (response.stream_max_event_gap_ms);
    EXPECT_GE (*response.stream_max_event_gap_ms,
    static_cast<double> (EVENT_PAUSE.count ()));
    ASSERT_HAS_VALUE (response.stream_event_rate);
    EXPECT_GT (*response.stream_event_rate, 0.0);
    EXPECT_LE (*response.stream_event_rate,
    1000.0 / static_cast<double> (EVENT_PAUSE.count ()));

    loop.stop ();
}

// Three events in one write are one arrival: counted and timed to the first
// event, with no gap and no rate. Mutation check: stamp a gap of 0 on the
// first arrival and the gap reads 0 here.
TEST (SseLoadStreamTest, EventsThatShareOneWriteHaveNoGapOrRate) {
    LoadStreamServer server;
    vayu::http::EventLoop loop (one_worker ());
    loop.start ();

    auto result = run_one (loop, stream_request (server.url ("/finite"), 1000, 30000));

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 3u);
    EXPECT_TRUE (response.stream_first_event_ms.has_value ());
    EXPECT_FALSE (response.stream_max_event_gap_ms.has_value ());
    EXPECT_FALSE (response.stream_event_rate.has_value ());

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
// The run's live counters (#3236, #3304)
// ---------------------------------------------------------------------------

namespace {

/// Fresh live counters, put on @p request's bounds the way a run puts its own.
std::shared_ptr<vayu::LiveStreamCounts> count_live (vayu::Request& request) {
    auto live = std::make_shared<vayu::LiveStreamCounts> ();
    if (request.stream_bounds) {
        request.stream_bounds->live = live;
    }
    return live;
}

/// What the live counters read as one stream ended on its own loop.
struct LiveEnding {
    size_t open_at_completion = 0;
    size_t open_after_stop    = 0;
    size_t events             = 0;
    bool errored              = false;
};

LiveEnding end_one_stream (const vayu::http::EventLoopConfig& config, vayu::Request request) {
    const auto live = count_live (request);
    vayu::http::EventLoop loop (config);
    loop.start ();
    std::atomic<bool> done{ false };
    LiveEnding ending;
    loop.submit (request, [&] (size_t, const vayu::Result<vayu::Response>& result) {
        ending.open_at_completion = live->open.load ();
        ending.errored = !result.is_ok () || result.value ().has_error ();
        done.store (true);
    });
    EXPECT_TRUE (vayu::tests::wait_until ([&] () { return done.load (); }))
    << "the stream never completed";
    loop.stop ();
    ending.open_after_stop = live->open.load ();
    ending.events          = live->events.load ();
    return ending;
}

} // namespace

// A stream leaves the run's open gauge by the time its completion is seen,
// whichever rule ended it: a cap, the server's close, or the byte cap's error.
// Read again once the loop has stopped and the transfer's state is gone, where
// a second decrement would show as a wrapped count. Mutation checks: drop
// `close_live` from `StreamTally::report` and every completion reads 1; drop
// the handle reset from `close_live` and every stopped read wraps.
TEST (SseLoadStreamTest, EveryEndingTakesAStreamOffTheOpenGaugeBeforeItsCompletion) {
    LoadStreamServer server;
    auto error_config                    = one_worker ();
    error_config.max_response_body_bytes = 256;
    struct EndingCase {
        const char* name;
        vayu::http::EventLoopConfig config;
        vayu::Request request;
        bool errors;
    };
    const std::vector<EndingCase> cases{
        { "event cap", one_worker (), stream_request (server.url ("/endless"), 5, 30000), false },
        { "server close", one_worker (),
        stream_request (server.url ("/finite"), 1000, 30000), false },
        { "byte cap", error_config,
        stream_request (server.url ("/endless"), 10000000, 30000), true },
    };
    for (const auto& c : cases) {
        const auto ending = end_one_stream (c.config, c.request);
        EXPECT_EQ (ending.open_at_completion, 0u) << c.name;
        EXPECT_EQ (ending.open_after_stop, 0u) << c.name;
        EXPECT_GT (ending.events, 0u) << c.name << ": the counters were not wired";
        EXPECT_EQ (ending.errored, c.errors) << c.name;
    }
}

// A Stop cancels a stream that is still open; the loop discards the transfer
// without reporting it, so the gauge comes down as its state is destroyed.
// Mutation check: drop `close_live` from `~StreamTally` and the stopped read
// is 1.
TEST (SseLoadStreamTest, AStopTakesAnOpenStreamOffTheOpenGauge) {
    LoadStreamServer server;
    auto request    = stream_request (server.url ("/silent"), 1000000, 30000);
    const auto live = count_live (request);
    vayu::http::EventLoop loop (one_worker ());
    loop.start ();
    loop.submit (request, [] (size_t, const vayu::Result<vayu::Response>&) {});

    EXPECT_TRUE (
    vayu::tests::wait_until ([&] () { return live->open.load () == 1; }))
    << "the stream never counted as open";
    loop.stop (false);
    EXPECT_EQ (live->open.load (), 0u);
}

// ---------------------------------------------------------------------------
// A reply is a stream only when it announces one (#3771)
// ---------------------------------------------------------------------------

// A 429 or a 200 JSON answer to a streaming request is that status in the
// run's mix and nothing else: no event count, no first-event time, nothing on
// the live counters, and off the open gauge by its completion. The bodies
// carry an event's bytes, so each half of the gate shows on its own.
// Mutation checks: drop the content-type test from `StreamTally::report` and
// `stream_events` reads 0 here; drop it from `StreamTally::feed` and the live
// events read 1.
TEST (SseLoadStreamTest, AReplyThatDidNotAnnounceAStreamCarriesNoEventCount) {
    LoadStreamServer server;
    for (const auto& [path, status] : { std::pair{ "/rate-limited", 429 },
         std::pair{ "/json", 200 }, std::pair{ "/redirect-to-json", 200 } }) {
        auto request    = stream_request (server.url (path), 1000, 30000);
        const auto live = count_live (request);
        vayu::http::EventLoop loop (one_worker ());
        loop.start ();
        auto result = run_one (loop, request);
        loop.stop ();

        ASSERT_TRUE (result.is_ok ()) << path;
        const auto& response = result.value ();
        EXPECT_FALSE (response.has_error ()) << path << ": " << response.error_message;
        EXPECT_EQ (response.status_code, status) << path;
        EXPECT_EQ (response.body, NOT_A_STREAM_BODY) << path;
        EXPECT_FALSE (response.stream_events.has_value ()) << path;
        EXPECT_FALSE (response.stream_capped) << path;
        EXPECT_FALSE (response.stream_first_event_ms.has_value ()) << path;
        EXPECT_FALSE (response.stream_max_event_gap_ms.has_value ()) << path;
        EXPECT_FALSE (response.stream_event_rate.has_value ()) << path;
        EXPECT_EQ (live->events.load (), 0u) << path;
        EXPECT_EQ (live->open.load (), 0u) << path;
    }
}

// The final hop decides: a redirect's own reply is never the stream, and the
// event stream it leads to is counted as if it had been asked for directly.
TEST (SseLoadStreamTest, AStreamBehindARedirectIsCountedFromItsFinalHop) {
    LoadStreamServer server;
    vayu::http::EventLoop loop (one_worker ());
    loop.start ();

    auto result =
    run_one (loop, stream_request (server.url ("/redirect-to-finite"), 1000, 30000));

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_FALSE (response.has_error ()) << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 3u);

    loop.stop ();
}

// The duration cap still ends a transfer that is not a stream, since it is the
// transfer's bound, but as the timeout it is: neither a JSON body that never
// finishes nor a server that never answers is a stream the cap completed.
// Mutation check: drop `response.stream_events` from the cap-ended return in
// `extract_response` and both read as status-0 or 200 successes.
TEST (SseLoadStreamTest, ADurationCapOnAReplyThatIsNotAStreamIsATimeout) {
    LoadStreamServer server;
    for (const char* path : { "/slow-json", "/mute" }) {
        vayu::http::EventLoop loop (one_worker ());
        loop.start ();
        auto result = run_one (loop, stream_request (server.url (path), 1000, 1000));
        loop.stop ();

        ASSERT_TRUE (result.is_ok ()) << path;
        const auto& response = result.value ();
        ASSERT_TRUE (response.has_error ()) << path;
        EXPECT_EQ (response.error_code, vayu::ErrorCode::Timeout) << path;
        EXPECT_NE (response.error_message.find ("1000 ms duration cap"), std::string::npos)
        << path << ": " << response.error_message;
        EXPECT_FALSE (response.stream_events.has_value ()) << path;
        EXPECT_FALSE (response.stream_capped) << path;
    }
}

// A stream that announced itself and was then cut off is still a stream: it
// fails, and it still reports the events it delivered (#3240).
TEST (SseLoadStreamTest, AStreamCutAfterItAnnouncedKeepsItsEvents) {
    LoadStreamServer server;
    vayu::http::EventLoop loop (one_worker ());
    loop.start ();

    auto result =
    run_one (loop, stream_request (server.url ("/sse-then-reset"), 1000, 30000));

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_TRUE (response.has_error ());
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 2u);
    EXPECT_FALSE (response.stream_capped);

    loop.stop ();
}

// A rate-limited target under concurrency: the completions that carry an
// event count are exactly the replies that streamed, each with its own
// events, and the live counters agree. Mutation check: drop the content-type
// test from `StreamTally::report` and every 429 carries a count of 0.
TEST (SseLoadStreamTest, OnlyTheRepliesThatStreamedCarryAnEventCount) {
    LoadStreamServer server;
    vayu::http::EventLoopConfig config;
    config.num_workers = 2;
    vayu::http::EventLoop loop (config);
    loop.start ();

    constexpr size_t TRANSFERS = 12;
    auto request    = stream_request (server.url ("/sse-or-429"), 1000, 20000);
    const auto live = count_live (request);
    std::mutex mutex;
    std::vector<vayu::Response> responses;
    for (size_t i = 0; i < TRANSFERS; ++i) {
        loop.submit (request, [&] (size_t, const vayu::Result<vayu::Response>& result) {
            if (result.is_ok ()) {
                const std::lock_guard<std::mutex> lock (mutex);
                responses.push_back (result.value ());
            }
        });
    }
    EXPECT_TRUE (vayu::tests::wait_until ([&] () {
        const std::lock_guard<std::mutex> lock (mutex);
        return responses.size () == TRANSFERS;
    }))
    << "every transfer completes";
    loop.stop ();

    size_t streamed = 0;
    size_t refused  = 0;
    for (const auto& response : responses) {
        if (response.status_code == 429) {
            ++refused;
            EXPECT_FALSE (response.stream_events.has_value ());
            continue;
        }
        ++streamed;
        EXPECT_EQ (response.status_code, 200);
        ASSERT_HAS_VALUE (response.stream_events);
        EXPECT_EQ (*response.stream_events, 2u);
    }
    EXPECT_EQ (streamed, TRANSFERS / 2);
    EXPECT_EQ (refused, TRANSFERS / 2);
    EXPECT_EQ (live->events.load (), streamed * 2);
    EXPECT_EQ (live->open.load (), 0u);
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
    EXPECT_FALSE (response.stream_events.has_value ())
    << "nothing announced an event stream, so there was no stream (#3771)";
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

// The client keeps the same gauge: open while the stream delivers, and down
// once the send returns, a cancelled stream's and a server-closed one's alike.
TEST (SseClientStreamTest, AStreamIsOpenOnTheGaugeUntilTheSendReturns) {
    LoadStreamServer server;
    auto cancelled_request = stream_request (server.url ("/endless"), 10000000, 30000);
    const auto cancelled_live = count_live (cancelled_request);
    std::atomic<bool> cancel{ false };
    std::atomic<size_t> open_while_streaming{ 0 };
    vayu::http::ClientConfig config;
    config.cancel           = &cancel;
    config.on_body_progress = [&] (uint64_t, std::optional<uint64_t>) {
        open_while_streaming.store (cancelled_live->open.load ());
        cancel.store (true);
        return true;
    };
    const auto cancelled = send_one (cancelled_request, std::move (config));
    EXPECT_FALSE (cancelled.has_error ()) << cancelled.error_message;
    EXPECT_EQ (open_while_streaming.load (), 1u);
    EXPECT_EQ (cancelled_live->open.load (), 0u);
    EXPECT_GT (cancelled_live->events.load (), 0u);

    auto finite_request = stream_request (server.url ("/finite"), 1000, 30000);
    const auto finite_live = count_live (finite_request);
    const auto finite      = send_one (finite_request);
    EXPECT_FALSE (finite.has_error ()) << finite.error_message;
    EXPECT_EQ (finite_live->open.load (), 0u);
    EXPECT_EQ (finite_live->events.load (), 3u);
}

// The client's half of #3771, by the same rule: a reply that did not announce
// `text/event-stream` is an ordinary response, its body kept and nothing
// counted. Mutation checks as `AReplyThatDidNotAnnounceAStreamCarriesNoEventCount`.
TEST (SseClientStreamTest, AReplyThatDidNotAnnounceAStreamCarriesNoEventCount) {
    LoadStreamServer server;
    for (const auto& [path, status] : { std::pair{ "/rate-limited", 429 },
         std::pair{ "/json", 200 }, std::pair{ "/redirect-to-json", 200 } }) {
        auto request    = stream_request (server.url (path), 1000, 30000);
        const auto live = count_live (request);

        const auto response = send_one (request);

        EXPECT_FALSE (response.has_error ()) << path << ": " << response.error_message;
        EXPECT_EQ (response.status_code, status) << path;
        EXPECT_EQ (response.body, NOT_A_STREAM_BODY) << path;
        EXPECT_FALSE (response.stream_events.has_value ()) << path;
        EXPECT_FALSE (response.stream_first_event_ms.has_value ()) << path;
        EXPECT_EQ (live->events.load (), 0u) << path;
        EXPECT_EQ (live->open.load (), 0u) << path;
    }
}

TEST (SseClientStreamTest, AStreamBehindARedirectIsCountedFromItsFinalHop) {
    LoadStreamServer server;
    const auto response =
    send_one (stream_request (server.url ("/redirect-to-finite"), 1000, 30000));

    EXPECT_FALSE (response.has_error ()) << response.error_message;
    EXPECT_EQ (response.status_code, 200);
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 3u);
}

// Neither a cap nor a stop makes a reply that is not a stream end as one: the
// cap is the timeout it is, and a stop is the cancel any other send reports.
// Mutation check: drop `response.stream_events` from `stream_ended_by_rule`
// and both read as 200 successes.
TEST (SseClientStreamTest, ACapOrAStopOnAReplyThatIsNotAStreamFailsIt) {
    LoadStreamServer server;
    const auto capped = send_one (stream_request (server.url ("/slow-json"), 1000, 1000));
    ASSERT_TRUE (capped.has_error ());
    EXPECT_EQ (capped.error_code, vayu::ErrorCode::Timeout);
    EXPECT_NE (capped.error_message.find ("1000 ms duration cap"), std::string::npos)
    << capped.error_message;
    EXPECT_FALSE (capped.stream_events.has_value ());

    std::atomic<bool> cancel{ false };
    vayu::http::ClientConfig config;
    config.cancel           = &cancel;
    config.on_body_progress = [&cancel] (uint64_t, std::optional<uint64_t>) {
        cancel.store (true);
        return true;
    };
    const auto stopped = send_one (
    stream_request (server.url ("/slow-json"), 1000, 30000), std::move (config));
    ASSERT_TRUE (stopped.has_error ());
    EXPECT_EQ (stopped.error_code, vayu::ErrorCode::Cancelled) << stopped.error_message;
    EXPECT_FALSE (stopped.stream_events.has_value ());
}

TEST (SseClientStreamTest, AStreamCutAfterItAnnouncedKeepsItsEvents) {
    LoadStreamServer server;
    const auto response =
    send_one (stream_request (server.url ("/sse-then-reset"), 1000, 30000));

    EXPECT_TRUE (response.has_error ());
    ASSERT_HAS_VALUE (response.stream_events);
    EXPECT_EQ (*response.stream_events, 2u);
    EXPECT_FALSE (response.stream_capped);
}
