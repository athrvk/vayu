/**
 * @file tests/curl_transfer_test.cpp
 * @brief Wire-level behaviour of the two curl paths - the event loop used by
 *        load runs and the single-request Client used by design mode.
 *
 * Both are exercised for every property that must hold on both, because the
 * two had already drifted: the timing clamps existed only in the Client, and
 * the method/body ordering bug existed in both copies independently.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <algorithm>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include "optional_assert.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/set_cookie.hpp"

namespace {

/// Answers with the method it was actually reached by, so a request that
/// changed method on the wire is visible rather than merely suspected.
class MethodEchoServer {
    public:
    MethodEchoServer () {
        svr.Get ("/echo", [] (const httplib::Request& req, httplib::Response& res) {
            res.set_content ("GET:" + req.body, "text/plain");
        });
        svr.Post ("/echo", [] (const httplib::Request& req, httplib::Response& res) {
            res.set_content ("POST:" + req.body, "text/plain");
        });
        // How the request framed its body, which is the only place the
        // difference between "an empty body" and "a body of unknown length"
        // shows up. See BodylessPostDeclaresAZeroLengthBody.
        svr.Post ("/framing", [] (const httplib::Request& req, httplib::Response& res) {
            res.set_content ("len=" + req.get_header_value ("Content-Length") +
            ";te=" + req.get_header_value ("Transfer-Encoding"),
            "text/plain");
        });
        svr.Get ("/big", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (std::string (kBigBodyBytes, 'x'), "text/plain");
        });
        svr.Get ("/small", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("ok", "text/plain");
        });
        svr.Get ("/slow", [] (const httplib::Request&, httplib::Response& res) {
            std::this_thread::sleep_for (std::chrono::seconds (2));
            res.set_content ("late", "text/plain");
        });
        // Two cookies the way a login response actually sets them - one
        // Set-Cookie line each, not comma-folded, which RFC 7230 3.2.2 forbids
        // for this header. Plus an ordinary header repeated, so the rule is
        // shown to be about repeats rather than about cookies.
        svr.Get ("/repeated-headers", [] (const httplib::Request&, httplib::Response& res) {
            res.set_header ("Set-Cookie", "session=abc; Path=/; HttpOnly");
            res.set_header ("Set-Cookie", "csrf=xyz; Path=/");
            res.set_header ("X-Trace", "first");
            res.set_header ("X-Trace", "second");
            res.set_content ("ok", "text/plain");
        });

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }

    ~MethodEchoServer () {
        svr.stop ();
        if (thread.joinable ())
            thread.join ();
    }
    MethodEchoServer (const MethodEchoServer&)            = delete;
    MethodEchoServer& operator= (const MethodEchoServer&) = delete;
    MethodEchoServer (MethodEchoServer&&)                 = delete;
    MethodEchoServer& operator= (MethodEchoServer&&)      = delete;

    std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }

    static constexpr size_t kBigBodyBytes = size_t{ 256 } * 1024;

    httplib::Server svr;
    std::thread thread;
    int port = 0;
};

class CurlTransferTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server = std::make_unique<MethodEchoServer> ();
    }

    void TearDown () override {
        server.reset ();
        vayu::http::global_cleanup ();
    }

    vayu::Request get_with_body (const std::string& path) const {
        vayu::Request request;
        request.method       = vayu::HttpMethod::GET;
        request.url          = server->url (path);
        request.body.mode    = vayu::BodyMode::Json;
        request.body.content = R"({"query":"search"})";
        return request;
    }

    /// Run one request through the event loop with the given config.
    vayu::Result<vayu::Response> run_once (const vayu::Request& request,
    vayu::http::EventLoopConfig config = {}) {
        vayu::http::EventLoop loop (config);
        loop.start ();
        auto handle = loop.submit_async (request);
        auto result = handle.future.get ();
        loop.stop ();
        return result;
    }

    std::unique_ptr<MethodEchoServer> server;
};

} // namespace

// ============================================================================
// Method / body agreement on the wire
// ============================================================================

// CURLOPT_POSTFIELDS switches curl's method to POST, so a GET carrying a body
// (Elasticsearch-style search) used to arrive as a POST - silently, with only
// the server's log to show it. Mutation-check: set CURLOPT_HTTPGET instead of
// re-asserting the method with CUSTOMREQUEST and the server answers "POST:".
TEST_F (CurlTransferTest, EventLoopSendsGetWithABodyAsGet) {
    auto result = run_once (get_with_body ("/echo"));

    ASSERT_TRUE (result.is_ok ()) << "request failed";
    EXPECT_EQ (result.value ().status_code, 200);
    EXPECT_EQ (result.value ().body, R"(GET:{"query":"search"})")
    << "a body-bearing GET must reach the server as a GET, body intact";
}

TEST_F (CurlTransferTest, ClientSendsGetWithABodyAsGet) {
    vayu::http::Client client;
    auto result = client.send (get_with_body ("/echo"));

    ASSERT_TRUE (result.is_ok ()) << "request failed";
    EXPECT_EQ (result.value ().body, R"(GET:{"query":"search"})");
}

// A body-free request of each shape still uses its ordinary curl option.
TEST_F (CurlTransferTest, BodylessGetAndPostAreUnchanged) {
    vayu::Request plain_get;
    plain_get.method = vayu::HttpMethod::GET;
    plain_get.url    = server->url ("/echo");
    auto get_result  = run_once (plain_get);
    ASSERT_TRUE (get_result.is_ok ());
    EXPECT_EQ (get_result.value ().body, "GET:");

    vayu::Request post;
    post.method       = vayu::HttpMethod::POST;
    post.url          = server->url ("/echo");
    post.body.mode    = vayu::BodyMode::Json;
    post.body.content = "payload";
    auto post_result  = run_once (post);
    ASSERT_TRUE (post_result.is_ok ());
    EXPECT_EQ (post_result.value ().body, "POST:payload");
}

// A POST with no body is an ordinary request (a trigger endpoint, a logout),
// and CURLOPT_POST on its own does not describe one: with no POSTFIELDS and no
// POSTFIELDSIZE, libcurl treats the length as unknown and pulls the body from
// its *default read callback*, which reads `stdin`. The engine sets no read
// callback, so such a request took whatever the process's stdin happened to be.
//
// The framing asserted here is what every stdin gets wrong: the request goes
// out chunked and length-less, which a server answering a trigger or logout
// POST may refuse with a 411. The hang is the half that depends on stdin - the
// read sits inside libcurl's callback on the transfer thread, out of
// CURLOPT_TIMEOUT_MS's reach, so it blocks until stdin closes. A shell's
// /dev/null EOFs at once and hides it; lukka/run-cmake spawns ctest with a pipe
// it never writes to, which is where this surfaced, 60 seconds at a time.
//
// So this asserts the declared length rather than the hang: red in a
// millisecond under any stdin, rather than red only under some and only after
// a ctest timeout.
//
// Mutation-check: drop the POSTFIELDSIZE line from apply_method_and_body and
// both cases below report an unset length.
TEST_F (CurlTransferTest, BodylessPostDeclaresAZeroLengthBody) {
    vayu::Request post;
    post.method = vayu::HttpMethod::POST;
    post.url    = server->url ("/framing");

    auto loop_result = run_once (post);
    ASSERT_TRUE (loop_result.is_ok ());
    EXPECT_EQ (loop_result.value ().body, "len=0;te=")
    << "a bodyless POST must declare Content-Length: 0, not an unknown length";

    vayu::http::Client client;
    auto client_result = client.send (post);
    ASSERT_TRUE (client_result.is_ok ());
    EXPECT_EQ (client_result.value ().body, "len=0;te=");
}

// HEAD with a body cannot be honoured (NOBODY resets the method and drops the
// body), and used to go out as a POST. Both paths refuse it by name instead -
// as a status-0 response, the shape every consumer already handles, not an
// Error result that /execute's unguarded .value() would throw on.
// Mutation-check: remove the validate_transferable call from either caller and
// its case here reaches the server as "POST:".
TEST_F (CurlTransferTest, HeadWithABodyIsRefusedByBothPaths) {
    vayu::Request request = get_with_body ("/echo");
    request.method        = vayu::HttpMethod::HEAD;

    auto loop_result = run_once (request);
    ASSERT_TRUE (loop_result.is_ok ())
    << "refusal is a failed response, not an Error";
    EXPECT_EQ (loop_result.value ().status_code, 0);
    EXPECT_EQ (loop_result.value ().error_code, vayu::ErrorCode::InvalidMethod);

    vayu::http::Client client;
    auto client_result = client.send (request);
    ASSERT_TRUE (client_result.is_ok ());
    EXPECT_EQ (client_result.value ().status_code, 0);
    EXPECT_EQ (client_result.value ().error_code, vayu::ErrorCode::InvalidMethod);
    EXPECT_NE (client_result.value ().error_message.find ("HEAD"), std::string::npos);
}

// ============================================================================
// Repeated response header names
// ============================================================================

namespace {

/// Both values of each repeated name, whichever order the two lines went out
/// in. httplib keeps a response's headers in an unordered_multimap, so the
/// wire order of two same-name lines is the container's and not this test's;
/// `IngestHeaderLineFoldsInArrivalOrder` pins the format and the order on
/// input the test does control.
void expect_both_repeated_values (const vayu::Headers& headers, const char* path) {
    auto cookie = headers.find ("set-cookie");
    ASSERT_NE (cookie, headers.end ()) << path << ": no Set-Cookie survived at all";
    EXPECT_TRUE (cookie->second == "session=abc; Path=/; HttpOnly, csrf=xyz; Path=/" ||
    cookie->second == "csrf=xyz; Path=/, session=abc; Path=/; HttpOnly")
    << path << ": both cookies must survive, folded - got " << cookie->second;

    auto trace = headers.find ("x-trace");
    ASSERT_NE (trace, headers.end ()) << path << ": no X-Trace survived at all";
    EXPECT_TRUE (trace->second == "first, second" || trace->second == "second, first")
    << path << ": an ordinary repeated header folds too - got " << trace->second;
}

} // namespace

// `Headers` is a map and both callbacks assigned into it, so a response
// sending the same name twice kept only the last value. For Set-Cookie that is
// a login response - the normal way a server sets a session and a CSRF cookie,
// since Set-Cookie is the one header RFC 7230 3.2.2 forbids comma-folding -
// reaching the app and the script with one of them gone.
//
// Mutation-check: restore `headers[key] = value` in either callback and that
// path's case below reports a single value.
TEST_F (CurlTransferTest, EventLoopKeepsEveryValueOfARepeatedHeaderName) {
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = server->url ("/repeated-headers");

    auto result = run_once (request);
    ASSERT_TRUE (result.is_ok ());
    ASSERT_EQ (result.value ().status_code, 200);
    expect_both_repeated_values (result.value ().headers, "event loop");
}

TEST_F (CurlTransferTest, ClientKeepsEveryValueOfARepeatedHeaderName) {
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = server->url ("/repeated-headers");

    vayu::http::Client client;
    auto result = client.send (request);
    ASSERT_TRUE (result.is_ok ());
    ASSERT_EQ (result.value ().status_code, 200);
    expect_both_repeated_values (result.value ().headers, "client");
}

// The seam between the two halves of the fix: what the callback folds is what
// `parse_set_cookie` (and, through the shared fixture, the app's Cookies tab)
// splits back apart. Each half is pinned on its own - the fold above, the
// boundary rule in set_cookie_test.cpp - so only this asserts they agree, which
// is the wiring the acceptance criterion of #307 is actually about.
TEST_F (CurlTransferTest, TwoSetCookieHeadersReachTheCookieParserAsTwoCookies) {
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = server->url ("/repeated-headers");

    auto result = run_once (request);
    ASSERT_TRUE (result.is_ok ());
    const auto& headers = result.value ().headers;
    auto folded         = headers.find ("set-cookie");
    ASSERT_NE (folded, headers.end ());

    auto cookies = vayu::http::parse_set_cookie (folded->second);
    ASSERT_EQ (cookies.size (), 2u)
    << "both cookies must survive the fold *and* the parse - got " << folded->second;

    std::vector<std::string> names{ cookies[0].name, cookies[1].name };
    std::sort (names.begin (), names.end ());
    EXPECT_EQ (names[0], "csrf");
    EXPECT_EQ (names[1], "session");
}

// The folding format itself, on input with a known arrival order. ", " is what
// both Set-Cookie parsers split cookie boundaries on, so the separator is a
// contract with them, not a cosmetic choice.
TEST (IngestHeaderLine, FoldsInArrivalOrder) {
    vayu::Headers headers;
    vayu::http::detail::ingest_header_line ("Set-Cookie: a=1", headers);
    vayu::http::detail::ingest_header_line ("set-cookie: b=2", headers);
    vayu::http::detail::ingest_header_line ("SET-COOKIE: c=3", headers);

    EXPECT_EQ (headers.at ("set-cookie"), "a=1, b=2, c=3")
    << "every value, in the order it arrived, joined the way both parsers "
       "split on";
}

TEST (IngestHeaderLine, SingleOccurrenceIsStoredVerbatimUnderALowerCasedName) {
    vayu::Headers headers;
    // Leading spaces are trimmed; everything past the *first* colon is value,
    // so a Date or a URL keeps its own colons.
    vayu::http::detail::ingest_header_line (
    "Location:   https://example.com:8443/a", headers);

    ASSERT_EQ (headers.size (), 1u);
    EXPECT_EQ (headers.at ("location"), "https://example.com:8443/a");
}

TEST (IngestHeaderLine, ALineThatIsNotAHeaderFieldIsIgnored) {
    vayu::Headers headers;
    vayu::http::detail::ingest_header_line ("this line carries no colon", headers);

    EXPECT_TRUE (headers.empty ());
}

// ============================================================================
// Response body cap
// ============================================================================

// Without a cap, one transfer buffers the whole body and a run buffers
// concurrency x that - and the bad_alloc would have to unwind through
// libcurl's C frame. Mutation-check: drop the cap check in write_callback and
// the oversized response succeeds with a 256KB body.
TEST_F (CurlTransferTest, OversizedResponseBodyFailsTheTransferWithANamedCap) {
    vayu::http::EventLoopConfig config;
    config.max_response_body_bytes = 4096;

    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = server->url ("/big");

    auto result = run_once (request, config);

    ASSERT_TRUE (result.is_ok ())
    << "a capped transfer is reported as a failed response";
    const auto& response = result.value ();
    EXPECT_EQ (response.status_code, 0);
    EXPECT_NE (response.error_message.find ("maxResponseBodyBytes"), std::string::npos)
    << "the error must name the cap that tripped: " << response.error_message;
    EXPECT_LE (response.body.size (), config.max_response_body_bytes)
    << "nothing past the cap may be buffered";
}

TEST_F (CurlTransferTest, BodyUnderTheCapIsStoredVerbatim) {
    vayu::http::EventLoopConfig config;
    config.max_response_body_bytes = 4096;

    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = server->url ("/small");

    auto result = run_once (request, config);
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().status_code, 200);
    EXPECT_EQ (result.value ().body, "ok");
}

TEST_F (CurlTransferTest, ZeroCapMeansUnbounded) {
    vayu::http::EventLoopConfig config;
    config.max_response_body_bytes = 0;

    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = server->url ("/big");

    auto result = run_once (request, config);
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().body.size (), MethodEchoServer::kBigBodyBytes);
}

// ============================================================================
// Timing on the event loop path
// ============================================================================

// The clamps lived only in the Client, so a load run against a plain-HTTP (or
// keep-alive) target stored a negative tls_ms and an inflated first_byte_ms,
// which the app renders verbatim. Mutation-check: revert curl_utils.cpp to the
// raw successive differences and tls_ms comes back negative here.
TEST_F (CurlTransferTest, EventLoopTimingPhasesAreNonNegativeAndTlsFreeOverPlainHttp) {
    vayu::Request request;
    request.method = vayu::HttpMethod::GET;
    request.url    = server->url ("/small");

    auto result = run_once (request);
    ASSERT_TRUE (result.is_ok ());

    const auto& t = result.value ().timing;
    EXPECT_GE (t.dns_ms, 0.0);
    EXPECT_GE (t.connect_ms, 0.0);
    EXPECT_GE (t.tls_ms, 0.0);
    EXPECT_GE (t.first_byte_ms, 0.0);
    EXPECT_GE (t.download_ms, 0.0);
    EXPECT_DOUBLE_EQ (t.tls_ms, 0.0) << "plain HTTP has no TLS phase";
}

// A failed transfer still connected, still sent bytes and still spent time.
// extract_response used to return before reading any of it, so every error in
// a load run contributed zero bytes to throughput and left load_strategy's
// error-timing branch dead. Mutation-check: restore the early return and both
// assertions below go to zero.
TEST_F (CurlTransferTest, FailedTransferKeepsTheTimingAndBytesCurlMeasured) {
    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = server->url ("/slow");
    request.timeout_ms = 300;

    auto result = run_once (request);

    ASSERT_TRUE (result.is_ok ())
    << "a timeout is reported as a failed response";
    const auto& response = result.value ();
    ASSERT_EQ (response.status_code, 0);
    EXPECT_EQ (response.error_code, vayu::ErrorCode::Timeout);
    EXPECT_GT (response.timing.wire_ms, 100.0)
    << "curl measured the time spent before the timeout";
    EXPECT_GT (response.timing.bytes_up, 0u)
    << "the request headers went out and must be counted";
}

// ============================================================================
// Transfer submission failure
// ============================================================================

// A handle the multi rejects never produces a completion message, so the
// discarded CURLMcode stranded the transfer: active_transfers never drained,
// the run stayed "Running" and stop(true) waited forever. CURLM_OUT_OF_MEMORY
// cannot be forced in-process; adding the same handle twice reproduces the
// rejection deterministically. Mutation-check: return nullopt without checking
// the code and this fails.
TEST (AddToMulti, RejectedHandleIsReportedRatherThanDiscarded) {
    vayu::http::global_init ();
    CURLM* multi = curl_multi_init ();
    CURL* easy   = curl_easy_init ();
    ASSERT_NE (multi, nullptr);
    ASSERT_NE (easy, nullptr);

    EXPECT_FALSE (vayu::http::detail::add_to_multi (multi, easy).has_value ());

    auto rejected = vayu::http::detail::add_to_multi (multi, easy);
    ASSERT_HAS_VALUE (rejected) << "a rejected add must not look like success";
    EXPECT_EQ (rejected->code, vayu::ErrorCode::InternalError);
    EXPECT_NE (rejected->message.find ("Failed to submit transfer"), std::string::npos);

    curl_multi_remove_handle (multi, easy);
    curl_easy_cleanup (easy);
    curl_multi_cleanup (multi);
    vayu::http::global_cleanup ();
}
