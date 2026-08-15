/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file sent_headers_wire_test.cpp
 * @brief `Response::request_headers` against the wire it claims to describe
 *        (issue #662).
 *
 * The sent record exists to be trusted about what went out, and it was not:
 * every driver spells a header `key + ": " + value`, which libcurl reads as an
 * instruction to *remove* the header when the value is empty - so an enabled
 * request row with a blank value never reached the wire while the response
 * pane's Headers tab listed it as sent.
 *
 * So the assertions here are paired: what the server received, and what the
 * record says it received. A record built by any means other than the appends
 * that build the header list can pass the second half and fail the first.
 * `has_header` is what makes the first half decidable - a header sent empty
 * and a header never sent both read as `""`.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>

#include "echo_server.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/sse_stream.hpp"

namespace vayu::http {
namespace {

using vayu::tests::EchoServer;

Request get_request (const std::string& url) {
    Request request;
    request.method     = HttpMethod::GET;
    request.url        = url;
    request.timeout_ms = 5000;
    return request;
}

class SentHeadersWireTest : public ::testing::Test {
    protected:
    void SetUp () override {
        server_ = std::make_unique<EchoServer> ();
        client_ = std::make_unique<Client> ();
    }

    void TearDown () override {
        client_.reset ();
        server_.reset ();
    }

    std::unique_ptr<EchoServer> server_;
    std::unique_ptr<Client> client_;
};

// ---------------------------------------------------------------------------
// The single-request client - the driver behind POST /execute, and the one
// whose record the response pane renders.
// ---------------------------------------------------------------------------

// The premise, stated as a test rather than assumed from libcurl's docs: a
// value-less header does not reach the server. If libcurl ever started sending
// it, the filter below would be the wrong fix and this reddens first.
TEST_F (SentHeadersWireTest, ValuelessHeaderNeverReachesTheWire) {
    Request request              = get_request (server_->url ());
    request.headers["X-Blank"]   = "";
    request.headers["X-Present"] = "kept";

    ASSERT_TRUE (client_->send (request).is_ok ());

    EXPECT_FALSE (server_->has_header ("X-Blank"));
    EXPECT_EQ (server_->header ("X-Present"), "kept");
}

// The bug itself. Mutation check: drop the `header_value_reaches_wire` gate in
// `build_request_header_list` and `X-Blank` is reported as sent again while the
// assertion above still passes - which is exactly the state this fixes.
TEST_F (SentHeadersWireTest, ValuelessHeaderIsNotReportedAsSent) {
    Request request              = get_request (server_->url ());
    request.headers["X-Blank"]   = "";
    request.headers["X-Present"] = "kept";

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    const auto& sent = result.value ().request_headers;
    EXPECT_FALSE (sent.contains ("X-Blank"))
    << "reported a header libcurl dropped as sent";
    EXPECT_EQ (sent.at ("X-Present"), "kept");
}

// libcurl skips the whitespace after the colon before deciding, so a value of
// spaces alone is a removal too - and a record that only checked for `empty()`
// would report it as sent.
TEST_F (SentHeadersWireTest, WhitespaceOnlyValueIsDroppedAndUnreported) {
    Request request              = get_request (server_->url ());
    request.headers["X-Spaces"]  = "  \t ";
    request.headers["X-Present"] = "kept";

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_FALSE (server_->has_header ("X-Spaces"));
    EXPECT_FALSE (result.value ().request_headers.contains ("X-Spaces"));
    EXPECT_EQ (server_->header ("X-Present"), "kept");
}

// The two headers the engine derives at send time stay in the record - the
// filter drops what libcurl drops, not what the engine adds. `User-Agent` is
// the one every request gets; a value-bearing header is unaffected.
TEST_F (SentHeadersWireTest, DerivedAndValueBearingHeadersAreStillReported) {
    Request request            = get_request (server_->url ());
    request.headers["X-Trace"] = "abc";

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    const auto& sent = result.value ().request_headers;
    ASSERT_TRUE (sent.contains ("User-Agent"));
    EXPECT_EQ (sent.at ("User-Agent"), server_->header ("User-Agent"));
    EXPECT_EQ (sent.at ("X-Trace"), "abc");
}

// A request that declares its own User-Agent keeps it - the derived one is a
// default, not an override, and the record must not gain a second spelling of
// a header the wire carries once.
TEST_F (SentHeadersWireTest, ADeclaredUserAgentWinsOverTheDefault) {
    Request request               = get_request (server_->url ());
    request.headers["User-Agent"] = "test-agent/1.0";

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_EQ (server_->header ("User-Agent"), "test-agent/1.0");
    EXPECT_EQ (result.value ().request_headers.at ("User-Agent"), "test-agent/1.0");
}

// The multipart Content-Type rule is untouched by the filter: it is suppressed
// because libcurl writes it with the boundary, not because it is value-less,
// and both reasons run through the same builder now.
TEST_F (SentHeadersWireTest, MultipartContentTypeIsStillSuppressed) {
    Request request                 = get_request (server_->url ());
    request.method                  = HttpMethod::POST;
    request.body.mode               = BodyMode::FormData;
    request.body.fields             = { { "a", "1", true } };
    request.headers["Content-Type"] = "multipart/form-data";

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_TRUE (
    server_->content_type ().starts_with ("multipart/form-data; boundary="))
    << server_->content_type ();
    EXPECT_FALSE (result.value ().request_headers.contains ("Content-Type"));
}

// ---------------------------------------------------------------------------
// The other two drivers. All three build their header list through
// `build_request_header_list`, and these prove the sharing is real: a driver
// that kept its own loop would still send the value-less header here.
// ---------------------------------------------------------------------------

TEST_F (SentHeadersWireTest, LoadDriverDropsTheSameHeader) {
    EventLoop loop;
    loop.start ();

    Request request              = get_request (server_->url ());
    request.headers["X-Blank"]   = "";
    request.headers["X-Present"] = "kept";
    auto result                  = loop.submit_async (request).future.get ();
    loop.stop ();

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_FALSE (server_->has_header ("X-Blank"));
    EXPECT_EQ (server_->header ("X-Present"), "kept");
}

TEST_F (SentHeadersWireTest, StreamConsumerDropsTheSameHeaderAndReportsTheTruth) {
    SseStreamRequest stream_request;
    stream_request.run_id                       = "run-sent-headers";
    stream_request.request                      = get_request (server_->url ());
    stream_request.request.headers["X-Blank"]   = "";
    stream_request.request.headers["X-Present"] = "kept";
    // The echo endpoint answers JSON and closes, which is a stream of zero
    // events - all this test needs, since the headers go out before the first
    // byte comes back.
    SseStreamContext context (stream_request.run_id, stream_request.limits);

    const vayu::Response response = consume_sse_stream (stream_request, context);

    EXPECT_FALSE (server_->has_header ("X-Blank"));
    EXPECT_EQ (server_->header ("X-Present"), "kept");
    EXPECT_FALSE (response.request_headers.contains ("X-Blank"))
    << "the stream consumer reported a header libcurl dropped as sent";
    EXPECT_EQ (response.request_headers.at ("X-Present"), "kept");
}

} // namespace
} // namespace vayu::http
