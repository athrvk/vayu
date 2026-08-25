/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file sse_load_stream_test.cpp
 * @brief Bounded streams on the load event loop (issue #576).
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
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/types.hpp"

namespace {

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

        svr_.Get ("/plain", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("not a stream", "text/plain");
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
    ASSERT_TRUE (response.stream_events.has_value ());
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
    ASSERT_TRUE (response.stream_events.has_value ());
    EXPECT_EQ (*response.stream_events, 0u)
    << "a silent stream delivered nothing, and says so";
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
    ASSERT_TRUE (response.stream_events.has_value ());
    // Three `data` frames and one comment-only keep-alive: the keep-alive is
    // not an event, here as on the design path.
    EXPECT_EQ (*response.stream_events, 3u);
    EXPECT_FALSE (response.stream_capped)
    << "the server ended this stream, so no cap did - the report's `capped` "
       "tally has to be able to tell the two apart";

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
        [&] (size_t, vayu::Result<vayu::Response> result) {
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
