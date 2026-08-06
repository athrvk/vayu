/**
 * @file tests/http_client_test.cpp
 * @brief Tests for HTTP client
 *
 * Uses a local httplib mock server instead of external services so tests are
 * deterministic and work in network-isolated CI environments.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <string>
#include <thread>

#include "vayu/http/client.hpp"

namespace vayu::http {
namespace {

// ---------------------------------------------------------------------------
// Local mock server that mimics the httpbin endpoints used by the tests.
// Bound to a random port on 127.0.0.1 so tests never touch the network.
// ---------------------------------------------------------------------------
class MockHttpBin {
    public:
    MockHttpBin () {
        // GET /get - echo back a JSON object
        svr_.Get ("/get", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (R"({"origin":"127.0.0.1","url":"/get"})", "application/json");
        });

        // POST /post - echo body back inside a JSON wrapper
        svr_.Post ("/post", [] (const httplib::Request& req, httplib::Response& res) {
            std::string body = R"({"data":")" + req.body + R"(","origin":"127.0.0.1"})";
            res.set_content (body, "application/json");
        });

        // GET /delay/:n - sleep n seconds then respond (used for timeout test)
        svr_.Get ("/delay/10", [] (const httplib::Request&, httplib::Response& res) {
            std::this_thread::sleep_for (std::chrono::seconds (10));
            res.set_content (R"({"delayed":true})", "application/json");
        });

        // GET /redirect/1 - one redirect to /get
        svr_.Get ("/redirect/1", [this] (const httplib::Request&, httplib::Response& res) {
            res.set_redirect ("/get", 302);
        });

        // GET /headers - echo request headers back in the body
        svr_.Get ("/headers", [] (const httplib::Request& req, httplib::Response& res) {
            std::string body = "{";
            bool first       = true;
            for (const auto& [k, v] : req.headers) {
                if (!first)
                    body += ",";
                body += "\"" + k + "\":\"" + v + "\"";
                first = false;
            }
            body += "}";
            res.set_content (body, "application/json");
        });

        // PUT /put - echo back 200
        svr_.Put ("/put", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (R"({"ok":true})", "application/json");
        });

        // DELETE /delete - echo back 200
        svr_.Delete ("/delete", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (R"({"ok":true})", "application/json");
        });

        // PATCH /patch - echo back 200
        svr_.Patch ("/patch", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (R"({"ok":true})", "application/json");
        });

        // GET /response-headers - return a custom header
        svr_.Get ("/response-headers", [] (const httplib::Request&, httplib::Response& res) {
            res.set_header ("X-Custom", "test");
            res.set_content (R"({"X-Custom":"test"})", "application/json");
        });

        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
    }

    ~MockHttpBin () {
        svr_.stop ();
        if (thread_.joinable ())
            thread_.join ();
    }

    std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port_) + path;
    }

    private:
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
};

} // namespace

class HttpClientTest : public ::testing::Test {
    protected:
    void SetUp () override {
        global_init ();
        mock_ = std::make_unique<MockHttpBin> ();
        client_ = std::make_unique<Client> ();
    }

    void TearDown () override {
        mock_.reset ();
        global_cleanup ();
    }

    std::unique_ptr<MockHttpBin> mock_;
    std::unique_ptr<Client> client_;
};

TEST_F (HttpClientTest, SendsGetRequest) {
    auto result = client_->get (mock_->url ("/get"));

    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;

    const auto& response = result.value ();
    EXPECT_EQ (response.status_code, 200);
    EXPECT_FALSE (response.body.empty ());
    EXPECT_GT (response.timing.total_ms, 0);
}

// The mock is plain HTTP (no TLS), so APPCONNECT_TIME is 0 - the case that used
// to render the TLS phase as a negative "-0ms". Every phase delta must be
// non-negative, and TLS specifically must be 0 when no handshake occurred.
TEST_F (HttpClientTest, TimingPhasesAreNonNegative) {
    auto result = client_->get (mock_->url ("/get"));
    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;

    const auto& t = result.value ().timing;
    EXPECT_GE (t.dns_ms, 0.0);
    EXPECT_GE (t.connect_ms, 0.0);
    EXPECT_GE (t.tls_ms, 0.0);
    EXPECT_GE (t.first_byte_ms, 0.0);
    EXPECT_GE (t.download_ms, 0.0);
    EXPECT_DOUBLE_EQ (t.tls_ms, 0.0); // plain HTTP - no TLS phase
}

// The mock is plain HTTP/1.1 over loopback (no ALPN, so no HTTP/2 is on
// offer), which makes "HTTP/1.1" the one negotiated outcome a real transfer
// against it can produce - a genuine end-to-end check of the
// CURLINFO_HTTP_VERSION read, not a restatement of the mapping table (that
// lives in http_version_test.cpp). It also pins the request line: rawRequest
// must reflect what was actually negotiated, not a literal that never looks
// at the transfer.
TEST_F (HttpClientTest, ReportsNegotiatedHttpVersion) {
    auto result = client_->get (mock_->url ("/get"));

    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;
    const auto& response = result.value ();
    EXPECT_EQ (response.http_version, "HTTP/1.1");
    EXPECT_TRUE (response.raw_request.starts_with ("GET /get HTTP/1.1\r\n"))
    << response.raw_request;
}

// A connection that never reaches a server negotiates nothing at all.
// CURLINFO_HTTP_VERSION reports CURL_HTTP_VERSION_NONE in that case, and the
// mapping in curl_version_map.hpp turns that into "" rather than a guessed
// "HTTP/1.1" - this is the property from HttpVersionFromCurl in
// http_version_test.cpp actually exercised end-to-end through a real failed
// transfer, not just the lookup table in isolation.
TEST_F (HttpClientTest, UnnegotiatedConnectionReportsEmptyHttpVersion) {
    Request request;
    request.method = HttpMethod::GET;
    request.url = "http://127.0.0.1:1/"; // port 1: connection refused, fast fail
    request.timeout_ms = 2000;

    auto result = client_->send (request);

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_NE (response.error_code, ErrorCode::None);
    EXPECT_EQ (response.http_version, "");
}

TEST_F (HttpClientTest, UnreachableHostsRawRequestNamesWhatWasAskedFor) {
    // The one case that discriminates the request line's version from a
    // hardcoded literal. Every reachable-host test in this file talks plain
    // HTTP/1.1 over loopback with no ALPN, so "HTTP/1.1" is the only outcome
    // they can produce - reverting the fix would leave them all green. Here
    // nothing is negotiated at all, so the line can only come from what was
    // requested, and a stale literal would print HTTP/1.1 instead.
    //
    // Since #339 this also pins the synthesized fallback: a connection refused
    // at port 1 never produces an outbound header frame, so this is the raw
    // view built from the composed request rather than off the wire.
    Request request;
    request.method       = HttpMethod::GET;
    request.url          = "http://127.0.0.1:1/"; // port 1: connection refused
    request.timeout_ms   = 2000;
    request.http_version = HttpVersion::Http2;

    auto result = client_->send (request);

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_EQ (response.http_version, ""); // nothing negotiated - still honest
    EXPECT_TRUE (response.raw_request.rfind ("GET / HTTP/2\r\n", 0) == 0)
    << "raw_request began: " << response.raw_request.substr (0, 40);
}

// The raw view is the wire's own header block (issue #339), not a rebuild of
// the composed headers. `Accept: */*` is what proves it: libcurl adds that
// itself and it appears in no composed header map, so a view rebuilt from
// `request_headers` cannot contain it.
TEST_F (HttpClientTest, RawRequestIsTheHeaderBlockThatWentOnTheWire) {
    Headers headers = { { "X-Trace", "abc" } };

    auto result = client_->get (mock_->url ("/headers"), headers);

    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;
    const auto& raw = result.value ().raw_request;
    EXPECT_TRUE (raw.starts_with ("GET /headers HTTP/1.1\r\n")) << raw;
    EXPECT_NE (raw.find ("Host: 127.0.0.1:"), std::string::npos) << raw;
    EXPECT_NE (raw.find ("X-Trace: abc"), std::string::npos) << raw;
    EXPECT_NE (raw.find ("User-Agent: "), std::string::npos) << raw;
    EXPECT_NE (raw.find ("Accept: */*"), std::string::npos)
    << "the view was rebuilt from the composed headers, not read off the wire:\n"
    << raw;
    EXPECT_TRUE (raw.ends_with ("\r\n\r\n")) << "header block is unterminated:\n" << raw;
}

// A followed redirect sends two requests; the view describes the one that
// produced the response being looked at, which is the last frame.
TEST_F (HttpClientTest, RawRequestOfAFollowedRedirectShowsTheFinalHop) {
    Request request;
    request.method           = HttpMethod::GET;
    request.url              = mock_->url ("/redirect/1"); // 302 -> /get
    request.follow_redirects = true;
    request.timeout_ms       = 5000;

    auto result = client_->send (request);

    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;
    const auto& response = result.value ();
    EXPECT_EQ (response.status_code, 200);
    EXPECT_TRUE (response.raw_request.starts_with ("GET /get HTTP/1.1\r\n"))
    << "the raw view named the hop that redirected, not the one that answered:\n"
    << response.raw_request;
}

// The body is ours, not libcurl's - the frame stops at the blank line, so the
// two halves have to be joined without swallowing or duplicating it.
TEST_F (HttpClientTest, RawRequestKeepsTheBodyAfterTheWireHeaders) {
    auto result = client_->post (mock_->url ("/post"), R"({"name": "test"})",
    { { "Content-Type", "application/json" } });

    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;
    const auto& raw = result.value ().raw_request;
    // libcurl's own Accept again, so this pins the joined halves of the wire
    // view rather than a synthesized block that happens to have the same shape.
    EXPECT_NE (raw.find ("Accept: */*"), std::string::npos) << raw;
    EXPECT_NE (raw.find ("Content-Length: 16\r\n"), std::string::npos) << raw;
    EXPECT_TRUE (raw.ends_with ("\r\n\r\n" R"({"name": "test"})")) << raw;
}

TEST_F (HttpClientTest, SendsPostRequest) {
    Headers headers = { { "Content-Type", "application/json" } };

    auto result = client_->post (mock_->url ("/post"), R"({"name": "test"})", headers);

    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;

    const auto& response = result.value ();
    EXPECT_EQ (response.status_code, 200);
    EXPECT_TRUE (response.body.find ("test") != std::string::npos);
}

TEST_F (HttpClientTest, HandlesTimeout) {
    Request request;
    request.method     = HttpMethod::GET;
    request.url        = mock_->url ("/delay/10");
    request.timeout_ms = 500; // 500 ms - server sleeps 10 s

    auto result = client_->send (request);

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_EQ (response.status_code, 0);
    EXPECT_EQ (response.error_code, ErrorCode::Timeout);
}

TEST_F (HttpClientTest, HandlesInvalidUrl) {
    auto result = client_->get ("not-a-valid-url");

    ASSERT_TRUE (result.is_ok ());
    const auto& response = result.value ();
    EXPECT_EQ (response.status_code, 0);
    EXPECT_NE (response.error_code, ErrorCode::None);
}

TEST_F (HttpClientTest, ParsesResponseHeaders) {
    auto result = client_->get (mock_->url ("/response-headers"));

    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;

    const auto& response = result.value ();
    EXPECT_TRUE (response.headers.contains ("content-type"));
}

TEST_F (HttpClientTest, FollowsRedirects) {
    Request request;
    request.method           = HttpMethod::GET;
    request.url              = mock_->url ("/redirect/1");
    request.follow_redirects = true;

    auto result = client_->send (request);

    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;
    EXPECT_EQ (result.value ().status_code, 200);
}

TEST_F (HttpClientTest, DoesNotFollowRedirectsWhenDisabled) {
    Request request;
    request.method           = HttpMethod::GET;
    request.url              = mock_->url ("/redirect/1");
    request.follow_redirects = false;

    auto result = client_->send (request);

    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;
    EXPECT_EQ (result.value ().status_code, 302);
}

TEST_F (HttpClientTest, SendsCustomHeaders) {
    Request request;
    request.method                     = HttpMethod::GET;
    request.url                        = mock_->url ("/headers");
    request.headers["X-Custom-Header"] = "custom-value";

    auto result = client_->send (request);

    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;
    EXPECT_TRUE (result.value ().body.find ("X-Custom-Header") != std::string::npos);
}

TEST_F (HttpClientTest, HandlesHttpMethods) {
    // Test PUT
    {
        Request request;
        request.method                  = HttpMethod::PUT;
        request.url                     = mock_->url ("/put");
        request.body.mode               = BodyMode::Json;
        request.body.content            = R"({"updated": true})";
        request.headers["Content-Type"] = "application/json";

        auto result = client_->send (request);
        ASSERT_TRUE (result.is_ok ()) << "PUT Error: " << result.error ().message;
        EXPECT_EQ (result.value ().status_code, 200);
    }

    // Test DELETE
    {
        Request request;
        request.method = HttpMethod::DELETE;
        request.url    = mock_->url ("/delete");

        auto result = client_->send (request);
        ASSERT_TRUE (result.is_ok ()) << "DELETE Error: " << result.error ().message;
        EXPECT_EQ (result.value ().status_code, 200);
    }

    // Test PATCH
    {
        Request request;
        request.method                  = HttpMethod::PATCH;
        request.url                     = mock_->url ("/patch");
        request.body.mode               = BodyMode::Json;
        request.body.content            = R"({"patched": true})";
        request.headers["Content-Type"] = "application/json";

        auto result = client_->send (request);
        ASSERT_TRUE (result.is_ok ()) << "PATCH Error: " << result.error ().message;
        EXPECT_EQ (result.value ().status_code, 200);
    }
}

} // namespace vayu::http
