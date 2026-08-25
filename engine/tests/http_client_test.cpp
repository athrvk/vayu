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
#include <cstdint>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "optional_assert.hpp"
#include "vayu/http/client.hpp"

namespace vayu::http {
namespace {

// ---------------------------------------------------------------------------
// Local mock server that mimics the httpbin endpoints used by the tests.
// Bound to a random port on 127.0.0.1 so tests never touch the network.
// ---------------------------------------------------------------------------
/// The `/sized` and `/unsized` body size, and the chunk `/unsized` hands out.
/// Larger than curl's 16 KiB write buffer so a progress report has to be made
/// of several calls rather than one - a single-call report would pass a test
/// that only checked the final count.
constexpr size_t SIZED_BYTES = size_t{ 256 } * 1024;
constexpr size_t CHUNK_BYTES = size_t{ 8 } * 1024;

/// `/dribbles` sends this much, in these pieces, ~120ms apart - so the whole
/// transfer runs well past any stall window short enough to test with, while
/// never actually stalling.
constexpr size_t DRIBBLE_CHUNK = size_t{ 4 } * 1024;
constexpr size_t DRIBBLE_BYTES = size_t{ 40 } * 1024;
static_assert ((DRIBBLE_BYTES / DRIBBLE_CHUNK) * 120 > 300,
"the dribble must outlast the 300ms total bound the tests set, or they prove "
"nothing");

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
        svr_.Get ("/redirect/1", [] (const httplib::Request&, httplib::Response& res) {
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

        // GET /sized - a body big enough to arrive in several write-callback
        // chunks, served with a Content-Length so the declared total is real.
        svr_.Get ("/sized", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (std::string (SIZED_BYTES, 'x'), "application/octet-stream");
        });

        // GET /stalls - sends a little, then nothing, forever. What a stall
        // timeout has to catch and a total timeout catches far too late.
        svr_.Get ("/stalls", [] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider ("application/octet-stream",
            [] (size_t offset, httplib::DataSink& sink) {
                if (offset == 0) {
                    const std::string opener (1024, 'z');
                    return sink.write (opener.data (), opener.size ());
                }
                std::this_thread::sleep_for (std::chrono::milliseconds (200));
                return true; // Alive, and saying nothing.
            });
        });

        // GET /dribbles - slow, but never stops. A download that a *total*
        // timeout kills for being large rather than for being stuck.
        svr_.Get ("/dribbles", [] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider ("application/octet-stream",
            [] (size_t offset, httplib::DataSink& sink) {
                if (offset >= DRIBBLE_BYTES) {
                    sink.done ();
                    return true;
                }
                std::this_thread::sleep_for (std::chrono::milliseconds (120));
                const std::string chunk (DRIBBLE_CHUNK, 'd');
                return sink.write (chunk.data (), chunk.size ());
            });
        });

        // GET /unsized - the same bytes with no Content-Length at all, which is
        // the case a progress report has no denominator for.
        svr_.Get ("/unsized", [] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider ("application/octet-stream",
            [] (size_t offset, httplib::DataSink& sink) {
                if (offset >= SIZED_BYTES) {
                    sink.done ();
                    return true;
                }
                const std::string chunk (CHUNK_BYTES, 'y');
                return sink.write (chunk.data (), chunk.size ());
            });
        });

        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
    }

    ~MockHttpBin () {
        svr_.stop ();
        if (thread_.joinable ())
            thread_.join ();
    }
    MockHttpBin (const MockHttpBin&)            = delete;
    MockHttpBin& operator= (const MockHttpBin&) = delete;
    MockHttpBin (MockHttpBin&&)                 = delete;
    MockHttpBin& operator= (MockHttpBin&&)      = delete;

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
        mock_   = std::make_unique<MockHttpBin> ();
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
    << "the view was rebuilt from the composed headers, not read off the "
       "wire:\n"
    << raw;
    EXPECT_TRUE (raw.ends_with ("\r\n\r\n"))
    << "header block is unterminated:\n"
    << raw;
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
    << "the raw view named the hop that redirected, not the one that "
       "answered:\n"
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
    EXPECT_TRUE (raw.ends_with ("\r\n\r\n"
                                R"({"name": "test"})"))
    << raw;
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

// ---------------------------------------------------------------------------
// Body progress reporting (issue #882)
// ---------------------------------------------------------------------------
//
// `/import/fetch` streams a download's progress to the import dialog, and the
// only place that knows a byte has arrived is the write callback. These assert
// the report is made of the arrival rather than of the finished transfer: a
// callback that fired once with the final count would be useless to a progress
// bar, and is what a test checking only `received` at the end would accept.

/// One `on_body_progress` call, as it was made.
struct ProgressTick {
    uint64_t received;
    std::optional<uint64_t> total;
};

TEST_F (HttpClientTest, ReportsBodyProgressAsTheBytesArrive) {
    std::vector<ProgressTick> ticks;
    ClientConfig config;
    config.on_body_progress = [&ticks] (uint64_t received, std::optional<uint64_t> total) {
        ticks.push_back ({ received, total });
        return true;
    };
    Client client (std::move (config));

    auto result = client.get (mock_->url ("/sized"));
    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;
    ASSERT_EQ (result.value ().body.size (), SIZED_BYTES);

    // Several calls, not one - the report has to track the arrival.
    ASSERT_GT (ticks.size (), 1U);
    EXPECT_EQ (ticks.back ().received, SIZED_BYTES);
    // Monotonic, and each one counts the body buffered so far.
    for (size_t i = 1; i < ticks.size (); ++i) {
        EXPECT_GT (ticks[i].received, ticks[i - 1].received);
    }
}

TEST_F (HttpClientTest, ReportsTheDeclaredTotalWhenTheServerDeclaresOne) {
    std::vector<ProgressTick> ticks;
    ClientConfig config;
    config.on_body_progress = [&ticks] (uint64_t received, std::optional<uint64_t> total) {
        ticks.push_back ({ received, total });
        return true;
    };
    Client client (std::move (config));

    ASSERT_TRUE (client.get (mock_->url ("/sized")).is_ok ());

    ASSERT_FALSE (ticks.empty ());
    // Content-Length arrives before the first body byte, so every tick has it.
    for (const auto& tick : ticks) {
        ASSERT_HAS_VALUE (tick.total);
        EXPECT_EQ (*tick.total, SIZED_BYTES);
    }
}

TEST_F (HttpClientTest, ReportsNoTotalWhenTheServerDeclaresNone) {
    std::vector<ProgressTick> ticks;
    ClientConfig config;
    config.on_body_progress = [&ticks] (uint64_t received, std::optional<uint64_t> total) {
        ticks.push_back ({ received, total });
        return true;
    };
    Client client (std::move (config));

    auto result = client.get (mock_->url ("/unsized"));
    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;

    ASSERT_FALSE (ticks.empty ());
    // A chunked response has no length to report, and a guessed one would be
    // the fake percentage this whole feature refuses to draw.
    for (const auto& tick : ticks) {
        EXPECT_FALSE (tick.total.has_value ());
    }
}

TEST_F (HttpClientTest, StopsTheTransferWhenTheProgressCallbackRefuses) {
    uint64_t seen = 0;
    ClientConfig config;
    config.on_body_progress = [&seen] (uint64_t received, std::optional<uint64_t>) {
        seen = received;
        return false; // The listener is gone - stop reading.
    };
    Client client (std::move (config));

    auto result = client.get (mock_->url ("/sized"));

    // The transfer is abandoned, not completed: whoever asked for the bytes has
    // stopped listening, and reading the remaining megabytes would be work for
    // nobody. Reported as a failed response rather than a partial success.
    ASSERT_TRUE (result.is_ok ());
    EXPECT_TRUE (result.value ().has_error ());
    EXPECT_LT (seen, SIZED_BYTES);
}

// ---------------------------------------------------------------------------
// Stall timeout (issue #882)
// ---------------------------------------------------------------------------
//
// `/import/fetch` used to die at the `Request::timeout_ms` default of 30s -
// which is a bound on the transfer's *size*, not on its health: 10 MB needs
// better than 340 KB/s to survive it. The progress bar made that visible and
// absurd, filling to two thirds and then reporting a timeout on a download that
// had never once stopped.
//
// The honest bound is a stall: abort when throughput stays under a floor for a
// while, never for having taken a while. libcurl's low-speed options are exactly
// that, and `max_response_bytes` already bounds the total.

TEST_F (HttpClientTest, StallTimeoutAbortsATransferThatStopsSending) {
    ClientConfig config;
    config.stall_timeout_ms = 1000;
    Client client (std::move (config));

    const auto start = std::chrono::steady_clock::now ();
    auto result      = client.get (mock_->url ("/stalls"));
    const auto took  = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - start)
                      .count ();

    ASSERT_TRUE (result.is_ok ());
    EXPECT_TRUE (result.value ().has_error ());
    // Killed by the stall window, not by the 30s total it replaced.
    EXPECT_LT (took, 10000);
}

TEST_F (HttpClientTest, StallTimeoutReplacesTheTotalBoundRatherThanJoiningIt) {
    // The behaviour change, stated as narrowly as it can be: `/dribbles` takes
    // ~1.2s and never pauses, and the request states a total bound of 300ms.
    //
    // Both bounds together would leave the total deciding - which is the 30s
    // wall `/import/fetch` inherited, and the reason a 10 MB spec needed better
    // than 340 KB/s merely to arrive. So the total must not be applied at all.
    Request request;
    request.method     = HttpMethod::GET;
    request.url        = mock_->url ("/dribbles");
    request.timeout_ms = 300;

    ClientConfig config;
    config.stall_timeout_ms = 5000; // No gap in this transfer comes near it.
    Client client (std::move (config));

    auto result = client.send (request);

    ASSERT_TRUE (result.is_ok ()) << "Error: " << result.error ().message;
    EXPECT_FALSE (result.value ().has_error ())
    << "a live download must not be killed for taking longer than the total: "
    << result.value ().error_message;
    EXPECT_EQ (result.value ().body.size (), DRIBBLE_BYTES);
}

TEST_F (HttpClientTest, WithoutAStallTimeoutTheTotalBoundStillApplies) {
    // The other half of the same statement, and what keeps every other caller's
    // behaviour intact: a design send's timeout is a number the user typed.
    Request request;
    request.method     = HttpMethod::GET;
    request.url        = mock_->url ("/dribbles");
    request.timeout_ms = 300;

    auto result = client_->send (request);

    ASSERT_TRUE (result.is_ok ());
    EXPECT_TRUE (result.value ().has_error ());
    EXPECT_EQ (result.value ().error_code, ErrorCode::Timeout);
}

} // namespace vayu::http
