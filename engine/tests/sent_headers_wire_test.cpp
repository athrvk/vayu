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

#include <algorithm>
#include <initializer_list>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "echo_server.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/json.hpp"

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

using Lines = std::vector<std::pair<std::string, std::string>>;

/// The lines among @p lines whose name is one of @p names, compared without
/// case, in the order they came.
Lines lines_named (const Lines& lines, std::initializer_list<std::string_view> names) {
    Lines out;
    for (const auto& line : lines) {
        if (std::any_of (names.begin (), names.end (), [&line] (std::string_view name) {
                return vayu::utils::ascii_lower_equal (line.first, name);
            })) {
            out.push_back (line);
        }
    }
    return out;
}

Lines lines_of (const HeaderList& headers) {
    Lines out;
    for (const auto& [name, value] : headers) {
        out.emplace_back (name, value);
    }
    return out;
}

/// Three rows of one name, in two spellings - the issue #2466 measurement.
Request repeated_header_request (const std::string& url) {
    Request request = get_request (url);
    request.headers.add ("X-Dup", "one");
    request.headers.add ("x-dup", "two");
    request.headers.add ("X-Dup", "three");
    return request;
}

const Lines& repeated_header_lines () {
    static const Lines lines{ { "X-Dup", "one" }, { "x-dup", "two" }, { "X-Dup", "three" } };
    return lines;
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

// ---------------------------------------------------------------------------
// Every line the request carries, in order (issue #2466): a repeated name goes
// out once per line, in its own spelling, and the record lists the same lines.
// Mutation check: read the payload's lines into a `Headers` map again in
// `deserialize_request`, or key `stored_header_rows` by name, and the three
// arrive as one.
// ---------------------------------------------------------------------------

TEST_F (SentHeadersWireTest, ARepeatedHeaderGoesOutOncePerLineInOrder) {
    auto parsed = vayu::json::deserialize_request (nlohmann::json{ { "method", "GET" },
    { "url", server_->url () }, { "headers", nlohmann::json::parse (R"([{"name":"X-Dup","value":"one"},
        {"name":"x-dup","value":"two"},{"name":"X-Dup","value":"three"}])") } });
    ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;

    auto result = client_->send (parsed.value ());
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_EQ (lines_named (server_->header_lines (), { "x-dup" }),
    repeated_header_lines ());
    EXPECT_EQ (lines_named (lines_of (result.value ().request_headers), { "x-dup" }),
    repeated_header_lines ());
    const auto answer = vayu::json::serialize (result.value ());
    EXPECT_EQ (answer["requestHeaderLines"].size (),
    result.value ().request_headers.size ());
    EXPECT_EQ (answer["requestHeaders"]["X-Dup"], "one, two, three");
}

TEST_F (SentHeadersWireTest, DistinctNamesGoOutInTheOrderTheyWereWritten) {
    Request request = get_request (server_->url ());
    for (const char* name : { "Zeta-Header", "alpha-header", "Mixed-CASE", "Beta" }) {
        request.headers.add (name, "v");
    }

    ASSERT_TRUE (client_->send (request).is_ok ());

    const Lines arrived = lines_named (server_->header_lines (),
    { "Zeta-Header", "alpha-header", "Mixed-CASE", "Beta" });
    EXPECT_EQ (arrived,
    (Lines{ { "Zeta-Header", "v" }, { "alpha-header", "v" },
    { "Mixed-CASE", "v" }, { "Beta", "v" } }));
}

// An auth block adds its header only to a request that carries none, and two
// typed `Authorization` lines are two lines the author wrote: both go out, and
// the block adds a third to neither.
TEST_F (SentHeadersWireTest, AnAuthorizationTypedTwiceIsSentTwiceAndAuthAddsNone) {
    Request request = get_request (server_->url ());
    request.headers.add ("Authorization", "Bearer first");
    request.headers.add ("authorization", "Bearer second");
    ASSERT_TRUE (
    apply_auth (request, Auth{ BearerAuth{ "from-auth" } }, nullptr).ok);

    ASSERT_TRUE (client_->send (request).is_ok ());

    EXPECT_EQ (lines_named (server_->header_lines (), { "Authorization" }),
    (Lines{ { "Authorization", "Bearer first" }, { "authorization", "Bearer second" } }));
}

// Issue #2467: a name pasted with a trailing blank would go out as
// `Authorization : Bearer x`, a space before the colon that a strict server
// refuses and a lenient one reads as another name. The name is settled where the
// payload is read, so the line that reaches the wire is the trimmed one; the
// bearer token is trimmed by the auth block the same way. Mutation check: drop
// the trim in `stored_header_name` (`utils/json.cpp`) or in the bearer branch of
// `apply_auth`.
TEST_F (SentHeadersWireTest, APaddedHeaderNameAndTokenReachTheWireTrimmed) {
    auto parsed = vayu::json::deserialize_request (
    nlohmann::json{ { "method", "GET" }, { "url", server_->url () },
    { "headers", nlohmann::json::parse (R"([{"name":"X-Padded ","value":"kept"}])") } });
    ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;
    Request request = std::move (parsed).value ();
    ASSERT_TRUE (apply_auth (request, Auth{ BearerAuth{ " tok " } }, nullptr).ok);

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_EQ (lines_named (server_->header_lines (), { "X-Padded" }),
    (Lines{ { "X-Padded", "kept" } }));
    EXPECT_EQ (server_->header ("Authorization"), "Bearer tok");
}

// The padded and the plain spelling of one name each arrive as the same
// `Authorization` line, in neither case with a space before the colon (a strict
// server would answer that `400`, which this server's parser does too).
// Mutation check: drop the trim in `stored_header_name` (`utils/json.cpp`) and
// the padded send fails.
TEST_F (SentHeadersWireTest, APaddedAndAPlainAuthorizationBothArriveAsAuthorizationLines) {
    for (const std::string name : { "Authorization ", "Authorization" }) {
        auto parsed = vayu::json::deserialize_request (
        nlohmann::json{ { "method", "GET" }, { "url", server_->url () },
        { "headers",
        nlohmann::json::array ({ { { "name", name }, { "value", "Bearer x" } } }) } });
        ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;

        auto result = client_->send (parsed.value ());
        ASSERT_TRUE (result.is_ok ()) << "'" << name << "': " << result.error ().message;

        EXPECT_EQ (lines_named (server_->header_lines (), { "Authorization" }),
        (Lines{ { "Authorization", "Bearer x" } }))
        << "'" << name << "'";
    }
}

TEST_F (SentHeadersWireTest, TheLoadDriverSendsEveryLineInOrder) {
    EventLoop loop;
    loop.start ();
    auto result =
    loop.submit_async (repeated_header_request (server_->url ())).future.get ();
    loop.stop ();

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (lines_named (server_->header_lines (), { "x-dup" }),
    repeated_header_lines ());
}

TEST_F (SentHeadersWireTest, TheStreamConsumerSendsAndRecordsEveryLineInOrder) {
    SseStreamRequest stream_request;
    stream_request.run_id  = "run-repeated-header";
    stream_request.request = repeated_header_request (server_->url ());
    SseStreamContext context (stream_request.run_id, stream_request.limits);

    const vayu::Response response = consume_sse_stream (stream_request, context);

    EXPECT_EQ (lines_named (server_->header_lines (), { "x-dup" }),
    repeated_header_lines ());
    EXPECT_EQ (lines_named (lines_of (response.request_headers), { "x-dup" }),
    repeated_header_lines ());
}

// ---------------------------------------------------------------------------
// Postman's `disabledSystemHeaders` (issue #1765), from the payload a stored
// request composes into, on every driver's wire.
// ---------------------------------------------------------------------------

/// A POST with a JSON body whose payload refuses the three headers a Postman
/// author can switch off and Vayu would otherwise send.
Request refusing_system_headers (const std::string& url) {
    auto parsed = vayu::json::deserialize_request (nlohmann::json{ { "method", "POST" },
    { "url", url }, { "body", { { "mode", "json" }, { "content", R"({"a":1})" } } },
    { "disabledSystemHeaders", { "user-agent", "accept", "content-type" } } });
    EXPECT_TRUE (parsed.is_ok ());
    Request request    = parsed.is_ok () ? parsed.value () : Request{};
    request.timeout_ms = 5000;
    return request;
}

// Mutation check: drop the `read_disabled_system_headers` call in
// `deserialize_request` and every header below arrives.
TEST_F (SentHeadersWireTest, AStoredSystemHeaderRefusalKeepsEachOffTheWire) {
    ASSERT_TRUE (client_->send (refusing_system_headers (server_->url ())).is_ok ());
    EXPECT_FALSE (server_->has_header ("User-Agent"));
    EXPECT_FALSE (server_->has_header ("Accept"));
    EXPECT_FALSE (server_->has_header ("Content-Type"));
    EXPECT_EQ (server_->body (), R"({"a":1})");
}

// The refusal is of the engine's default, never of what the author typed.
TEST_F (SentHeadersWireTest, AUserTypedHeaderStillGoesOutUnderARefusal) {
    Request request               = refusing_system_headers (server_->url ());
    request.headers["User-Agent"] = "typed/1";
    request.headers["Accept"]     = "text/plain";
    ASSERT_TRUE (client_->send (request).is_ok ());
    EXPECT_EQ (server_->header ("User-Agent"), "typed/1");
    EXPECT_EQ (server_->header ("Accept"), "text/plain");
}

TEST_F (SentHeadersWireTest, TheLoadDriverHonoursTheSameRefusal) {
    EventLoop loop;
    loop.start ();
    auto result =
    loop.submit_async (refusing_system_headers (server_->url ())).future.get ();
    loop.stop ();
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_FALSE (server_->has_header ("User-Agent"));
    EXPECT_FALSE (server_->has_header ("Accept"));
    EXPECT_FALSE (server_->has_header ("Content-Type"));
}

/**
 * The app's Send, as it reaches the wire (issue #1765): a GraphQL body whose
 * Content-Type row the Body panel wrote travels as a flat header plus its
 * `bodyModeHeaders` name, and a stored `content-type` refusal keeps it off -
 * as Postman sends no Content-Type for a refused body header. Without the
 * marker the same header is the user's and goes out. Mutation check: make
 * `drop_refused_body_mode_headers` return before its loop and the first
 * expectation reds.
 */
TEST_F (SentHeadersWireTest, ARefusedContentTypeTheBodyModeWroteStaysOffTheWire) {
    const auto payload = [&] (bool marked) {
        nlohmann::json out{ { "method", "POST" }, { "url", server_->url () },
            { "headers", { { "Content-Type", "application/json" } } },
            { "body", { { "mode", "graphql" }, { "content", R"({"query":"{ me }"})" } } },
            { "disabledSystemHeaders", { "content-type" } } };
        if (marked) {
            out["bodyModeHeaders"] = { "Content-Type" };
        }
        return out;
    };
    const auto send = [&] (bool marked) {
        auto parsed = vayu::json::deserialize_request (payload (marked));
        EXPECT_TRUE (parsed.is_ok ());
        Request request    = parsed.is_ok () ? parsed.value () : Request{};
        request.timeout_ms = 5000;
        return client_->send (request).is_ok ();
    };
    ASSERT_TRUE (send (true));
    EXPECT_FALSE (server_->has_header ("Content-Type"));
    EXPECT_EQ (server_->body (), R"({"query":"{ me }"})");

    ASSERT_TRUE (send (false));
    EXPECT_EQ (server_->header ("Content-Type"), "application/json");
}

// ---------------------------------------------------------------------------
// The Content-Type libcurl would invent (issue #2464). Any POSTFIELDS body and
// a bodyless POST get `application/x-www-form-urlencoded` from libcurl when the
// list names no Content-Type, so "no type" is asserted as no line at all.
// Multipart and binary keep their own wire tests: the multipart one above and
// `file_body_test.cpp`'s Content-Type tiers.
// ---------------------------------------------------------------------------

Request text_request (const std::string& url, HttpMethod method) {
    Request request      = get_request (url);
    request.method       = method;
    request.body.mode    = BodyMode::Text;
    request.body.content = "plain";
    return request;
}

// Mutation check: return "" for Text from `implied_content_type` and neither
// the wire nor the record carries a type (the removal line keeps libcurl's
// form type off).
TEST_F (SentHeadersWireTest, ATextBodyGoesOutAsTextPlainAndIsRecorded) {
    auto result = client_->send (text_request (server_->url (), HttpMethod::POST));
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_EQ (server_->content_type (), "text/plain");
    EXPECT_EQ (server_->body (), "plain");
    const auto& sent = result.value ().request_headers;
    ASSERT_TRUE (sent.contains ("Content-Type"));
    EXPECT_EQ (sent.at ("Content-Type"), "text/plain");
}

// POSTFIELDS makes the transfer a POST in libcurl's eyes whatever verb is
// restored afterwards, so each of these had the form type too.
TEST_F (SentHeadersWireTest, ATextBodyIsTextPlainOnEveryVerbThatCarriesOne) {
    for (const auto method : { HttpMethod::PUT, HttpMethod::PATCH, HttpMethod::GET }) {
        const std::string name = to_string (method);
        ASSERT_TRUE (client_->send (text_request (server_->url (), method)).is_ok ()) << name;
        EXPECT_EQ (server_->method (), name);
        EXPECT_EQ (server_->content_type (), "text/plain") << name;
        EXPECT_EQ (server_->body (), "plain") << name;
    }
}

// Mutation check: drop the removal line in `build_request_header_list` and the
// server sees libcurl's form type on a request with no body to describe.
TEST_F (SentHeadersWireTest, ABodylessPostSendsNoContentType) {
    Request request = get_request (server_->url ());
    request.method  = HttpMethod::POST;

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_FALSE (server_->has_header ("Content-Type")) << server_->content_type ();
    EXPECT_EQ (server_->header ("Content-Length"), "0");
    EXPECT_FALSE (result.value ().request_headers.contains ("Content-Type"));
}

// The premise the removal line's scope rests on: a bodyless PUT or PATCH is
// `CURLOPT_CUSTOMREQUEST` alone, which libcurl sends with no Content-Type of
// its own, so the engine has nothing to remove there.
TEST_F (SentHeadersWireTest, ABodylessPutOrPatchGetsNoContentTypeFromLibcurl) {
    for (const auto method : { HttpMethod::PUT, HttpMethod::PATCH }) {
        Request request = get_request (server_->url ());
        request.method  = method;
        ASSERT_TRUE (client_->send (request).is_ok ()) << to_string (method);
        EXPECT_EQ (server_->method (), to_string (method));
        EXPECT_FALSE (server_->has_header ("Content-Type"))
        << to_string (method) << ": " << server_->content_type ();
    }
}

TEST_F (SentHeadersWireTest, ATypedContentTypeWinsOverTextPlain) {
    Request request = text_request (server_->url (), HttpMethod::POST);
    request.headers["Content-Type"] = "text/csv";

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_EQ (server_->content_type (), "text/csv");
    EXPECT_EQ (result.value ().request_headers.at ("Content-Type"), "text/csv");
}

TEST_F (SentHeadersWireTest, ARefusedContentTypeSendsNoneForATextBody) {
    Request request = text_request (server_->url (), HttpMethod::POST);
    request.suppressed_default_headers.insert ("content-type");

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_FALSE (server_->has_header ("Content-Type")) << server_->content_type ();
    EXPECT_EQ (server_->body (), "plain");
    EXPECT_FALSE (result.value ().request_headers.contains ("Content-Type"));
}

// A typed row left blank is the author's (it wins over `text/plain`), and
// `append` drops it as a removal line - so nothing named a type, which is the
// gap libcurl filled. Mutation check: drop the removal line and the form type
// reappears on both requests, the refused one included.
TEST_F (SentHeadersWireTest, ABlankTypedContentTypeDoesNotLetTheFormTypeBack) {
    Request request = text_request (server_->url (), HttpMethod::POST);
    request.headers["Content-Type"] = "  ";
    auto result                     = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_FALSE (server_->has_header ("Content-Type")) << server_->content_type ();
    EXPECT_FALSE (result.value ().request_headers.contains ("Content-Type"));

    request.suppressed_default_headers.insert ("content-type");
    ASSERT_TRUE (client_->send (request).is_ok ());
    EXPECT_FALSE (server_->has_header ("Content-Type")) << server_->content_type ();
}

TEST_F (SentHeadersWireTest, TheLoadDriverSendsTheSameContentTypes) {
    EventLoop loop;
    loop.start ();
    auto text =
    loop.submit_async (text_request (server_->url (), HttpMethod::POST)).future.get ();
    const std::string text_type = server_->content_type ();

    Request bodyless = get_request (server_->url ());
    bodyless.method  = HttpMethod::POST;
    auto none        = loop.submit_async (bodyless).future.get ();
    loop.stop ();

    ASSERT_TRUE (text.is_ok ()) << text.error ().message;
    EXPECT_EQ (text_type, "text/plain");
    ASSERT_TRUE (none.is_ok ()) << none.error ().message;
    EXPECT_FALSE (server_->has_header ("Content-Type")) << server_->content_type ();
}

TEST_F (SentHeadersWireTest, TheStreamConsumerSendsAndRecordsTextPlain) {
    SseStreamRequest stream_request;
    stream_request.run_id  = "run-text-content-type";
    stream_request.request = text_request (server_->url (), HttpMethod::POST);
    SseStreamContext context (stream_request.run_id, stream_request.limits);

    const vayu::Response response = consume_sse_stream (stream_request, context);

    EXPECT_EQ (server_->content_type (), "text/plain");
    ASSERT_TRUE (response.request_headers.contains ("Content-Type"));
    EXPECT_EQ (response.request_headers.at ("Content-Type"), "text/plain");
}

// ---------------------------------------------------------------------------
// The Expect libcurl would invent (issue #2468). It adds `Expect: 100-continue`
// to an HTTP/1.1 body over 1 MiB and waits a second for a reply, so the engine
// removes it unless `sendExpectContinue` is on. Only the header is asserted -
// never the second it costs, which would make the test as slow as the bug.
// ---------------------------------------------------------------------------

constexpr size_t EXPECT_THRESHOLD_BYTES = 1048576;

Request sized_post (const std::string& url, size_t bytes) {
    Request request      = text_request (url, HttpMethod::POST);
    request.body.content = std::string (bytes, 'a');
    return request;
}

ClientConfig expect_client_config (bool allow) {
    ClientConfig config;
    config.default_headers.expect_continue = allow;
    return config;
}

// Mutation check: drop the `Expect:` line in `build_request_header_list` and
// the 2 MiB case below carries libcurl's own.
TEST_F (SentHeadersWireTest, ALargeBodyCarriesNoExpectByDefault) {
    auto result =
    client_->send (sized_post (server_->url (), 2 * EXPECT_THRESHOLD_BYTES));
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_EQ (server_->body ().size (), 2 * EXPECT_THRESHOLD_BYTES);
    EXPECT_FALSE (server_->has_header ("Expect")) << server_->header ("Expect");
    EXPECT_FALSE (result.value ().request_headers.contains ("Expect"));
}

TEST_F (SentHeadersWireTest, SendExpectContinueLetsLibcurlSendItOnALargeBody) {
    Client client (expect_client_config (true));
    auto result = client.send (sized_post (server_->url (), 2 * EXPECT_THRESHOLD_BYTES));
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_EQ (server_->header ("Expect"), "100-continue");
}

// libcurl's threshold is "larger than 1 MiB", so the byte on either side of it
// is where an engine that removed the line only for some sizes would show.
// This also pins the premise: if a libcurl upgrade moved the threshold, the
// "on" half reddens before the removal is trusted.
TEST_F (SentHeadersWireTest, TheExpectDecisionHoldsEitherSideOfTheOneMiBThreshold) {
    for (const bool allow : { false, true }) {
        Client client (expect_client_config (allow));
        for (const size_t bytes : { EXPECT_THRESHOLD_BYTES, EXPECT_THRESHOLD_BYTES + 1 }) {
            ASSERT_TRUE (client.send (sized_post (server_->url (), bytes)).is_ok ());
            const bool expected = allow && bytes > EXPECT_THRESHOLD_BYTES;
            EXPECT_EQ (server_->has_header ("Expect"), expected)
            << "allow=" << allow << " bytes=" << bytes;
        }
    }
}

TEST_F (SentHeadersWireTest, ATypedExpectIsSentAsTypedWhileTheKeyIsOff) {
    Request request = sized_post (server_->url (), 2 * EXPECT_THRESHOLD_BYTES);
    request.headers["Expect"] = "100-continue";

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_EQ (server_->header ("Expect"), "100-continue");
    EXPECT_EQ (result.value ().request_headers.at ("Expect"), "100-continue");
}

// Mutation check: count a blank row as naming an Expect (`lists_expect` set
// before `append`'s gate) and libcurl's own comes back on the wire.
TEST_F (SentHeadersWireTest, ABlankTypedExpectDoesNotLetLibcurlsBack) {
    Request request = sized_post (server_->url (), 2 * EXPECT_THRESHOLD_BYTES);
    request.headers["Expect"] = "";

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_FALSE (server_->has_header ("Expect")) << server_->header ("Expect");
    EXPECT_FALSE (result.value ().request_headers.contains ("Expect"));
}

TEST_F (SentHeadersWireTest, TheLoadDriverDecidesExpectTheSameWay) {
    for (const bool allow : { false, true }) {
        EventLoopConfig config;
        config.default_headers.expect_continue = allow;
        EventLoop loop (config);
        loop.start ();
        auto result =
        loop
        .submit_async (sized_post (server_->url (), 2 * EXPECT_THRESHOLD_BYTES))
        .future.get ();
        loop.stop ();

        ASSERT_TRUE (result.is_ok ()) << result.error ().message;
        EXPECT_EQ (server_->has_header ("Expect"), allow) << "allow=" << allow;
    }
}

TEST_F (SentHeadersWireTest, TheStreamConsumerRemovesExpectByDefault) {
    SseStreamRequest stream_request;
    stream_request.run_id = "run-expect";
    stream_request.request = sized_post (server_->url (), 2 * EXPECT_THRESHOLD_BYTES);
    SseStreamContext context (stream_request.run_id, stream_request.limits);

    const vayu::Response response = consume_sse_stream (stream_request, context);

    EXPECT_FALSE (server_->has_header ("Expect")) << server_->header ("Expect");
    EXPECT_FALSE (response.request_headers.contains ("Expect"));
}

} // namespace
} // namespace vayu::http
