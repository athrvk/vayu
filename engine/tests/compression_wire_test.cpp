/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file compression_wire_test.cpp
 * @brief Compression negotiation against a server that actually compresses
 *        (issue #1229).
 *
 * The unit tests beside this one prove the *decision*: which headers the engine
 * adds, records and refuses. None of them proves the consequence, which is the
 * half a user sees - that a negotiated response comes back **decoded**, and
 * that every size the engine reports is therefore the decoded length. That
 * claim is about libcurl's behaviour under an option this engine sets, so the
 * only honest way to check it is a transfer.
 *
 * The server here serves one pre-compressed body under `Content-Encoding: gzip`
 * when the request asked for gzip, and the same bytes uncompressed when it did
 * not. The blob is embedded rather than compressed at run time: a test that
 * built its own gzip would be asserting against its own compressor, and the
 * engine links no compression library of its own to build one with.
 */

#include <gtest/gtest.h>

#include <array>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include <httplib.h>

#include "vayu/http/client.hpp"
#include "vayu/http/default_headers.hpp"

namespace vayu::http {
namespace {

/// The body the server holds, and what a decoded response must equal.
constexpr std::string_view PLAIN_BODY =
R"({"hello":"a compressed body the engine has to decode"})";

/// `PLAIN_BODY` as gzip, produced once and pasted here - see the file comment.
constexpr std::array<char, 73> GZIPPED_BODY = { '\x1f', '\x8b', '\x08', '\x00',
    '\x00', '\x00', '\x00', '\x00', '\x02', '\x03', '\x05', '\xc1', '\xd1', '\x0d',
    '\x80', '\x20', '\x0c', '\x04', '\xd0', '\x55', '\x2e', '\x1d', '\xc3', '\x6d',
    '\x90', '\x5e', '\xac', '\x09', '\x72', '\xc4', '\xf2', '\x43', '\x88', '\xbb',
    '\xfb', '\xde', '\xb6', '\x60', '\x6b', '\xb2', '\xc3', '\x0a', '\xaa', '\x9e',
    '\xf1', '\x32', '\x93', '\x8e', '\x53', '\xbe', '\x30', '\x83', '\x60', '\xbf',
    '\xee', '\x4e', '\x44', '\x49', '\x4c', '\xc1', '\x59', '\xe5', '\xb4', '\xef',
    '\x07', '\x04', '\xcf', '\xea', '\x89', '\x36', '\x00', '\x00', '\x00' };

/// Serves the body compressed to a client that asked for gzip, plain to one
/// that did not, and remembers which it answered.
class CompressingServer {
    public:
    CompressingServer () {
        svr_.Get ("/gz", [this] (const httplib::Request& req, httplib::Response& res) {
            const std::string accept = req.get_header_value ("Accept-Encoding");
            {
                std::lock_guard<std::mutex> lock (mutex_);
                accept_encoding_ = accept;
                asked_           = req.has_header ("Accept-Encoding");
            }
            if (accept.find ("gzip") != std::string::npos) {
                res.set_header ("Content-Encoding", "gzip");
                res.set_content (
                std::string (GZIPPED_BODY.data (), GZIPPED_BODY.size ()), "application/json");
                return;
            }
            res.set_content (std::string (PLAIN_BODY), "application/json");
        });

        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~CompressingServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    CompressingServer (const CompressingServer&)            = delete;
    CompressingServer& operator= (const CompressingServer&) = delete;
    CompressingServer (CompressingServer&&)                 = delete;
    CompressingServer& operator= (CompressingServer&&)      = delete;

    std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/gz";
    }

    /// The `Accept-Encoding` the last request carried, `""` when it carried none.
    std::string accept_encoding () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return accept_encoding_;
    }

    /// Whether the header arrived at all - `""` cannot say (issue #662's rule).
    bool asked_for_encoding () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return asked_;
    }

    private:
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    mutable std::mutex mutex_;
    std::string accept_encoding_;
    bool asked_ = false;
};

Request get_request (const std::string& url) {
    Request request;
    request.method     = HttpMethod::GET;
    request.url        = url;
    request.timeout_ms = 5000;
    return request;
}

DefaultHeaderPolicy negotiating_policy () {
    DefaultHeaderPolicy policy;
    policy.accept_encoding = supported_accept_encodings ();
    return policy;
}

class CompressionWireTest : public ::testing::Test {
    protected:
    void SetUp () override {
        if (supported_accept_encodings ().find ("gzip") == std::string::npos) {
            GTEST_SKIP ()
            << "this libcurl decodes no gzip, so it advertises none";
        }
        server_ = std::make_unique<CompressingServer> ();
    }
    void TearDown () override {
        server_.reset ();
    }
    std::unique_ptr<CompressingServer> server_;
};

// The claim the docs make about every size field: what the engine holds is what
// libcurl decoded. Mutation check: drop the `set_opt<CURLOPT_ACCEPT_ENCODING>`
// in `apply_default_header_options` and the body comes back as 73 bytes of
// gzip - the header alone does not decode anything.
TEST_F (CompressionWireTest, ANegotiatedResponseArrivesDecodedAndIsSizedDecoded) {
    ClientConfig config;
    config.default_headers = negotiating_policy ();
    Client client (config);

    auto result = client.send (get_request (server_->url ()));
    ASSERT_TRUE (result.is_ok ());
    const Response& response = result.value ();

    EXPECT_NE (server_->accept_encoding ().find ("gzip"), std::string::npos);
    EXPECT_EQ (response.headers.at ("content-encoding"), "gzip");
    EXPECT_EQ (response.body, PLAIN_BODY);
    EXPECT_EQ (response.body_size, PLAIN_BODY.size ());
    EXPECT_NE (response.body_size, GZIPPED_BODY.size ());
    // The sent record names the encoding the transfer asked for, even though
    // libcurl wrote that line rather than the header list.
    EXPECT_EQ (response.request_headers.at ("Accept-Encoding"),
    supported_accept_encodings ());
}

// The refusal, on the wire: a send that opted out asks for nothing, and the
// server's uncompressed answer is what arrives.
TEST_F (CompressionWireTest, ASendThatRefusesItAsksForNothing) {
    ClientConfig config;
    config.default_headers = negotiating_policy ();
    Client client (config);

    Request request = get_request (server_->url ());
    request.suppressed_default_headers.insert ("Accept-Encoding");

    auto result = client.send (request);
    ASSERT_TRUE (result.is_ok ());

    EXPECT_FALSE (server_->asked_for_encoding ());
    EXPECT_EQ (result.value ().body, PLAIN_BODY);
    EXPECT_FALSE (result.value ().request_headers.contains ("Accept-Encoding"));
}

// A request that wrote the header itself is sent as written and **not**
// decoded: libcurl decodes only what `CURLOPT_ACCEPT_ENCODING` asked for, which
// is what makes "a header you typed wins" a real rule rather than a slogan.
TEST_F (CompressionWireTest, ARequestsOwnHeaderIsSentAsWrittenAndNotDecoded) {
    ClientConfig config;
    config.default_headers = negotiating_policy ();
    Client client (config);

    Request request                    = get_request (server_->url ());
    request.headers["Accept-Encoding"] = "gzip";

    auto result = client.send (request);
    ASSERT_TRUE (result.is_ok ());

    EXPECT_EQ (server_->accept_encoding (), "gzip");
    EXPECT_EQ (result.value ().body.size (), GZIPPED_BODY.size ());
    EXPECT_EQ (result.value ().request_headers.at ("Accept-Encoding"), "gzip");
}

// A policy with no encodings - the config entry switched off - sets the option
// to nothing on a reused handle, so nothing is asked for.
TEST_F (CompressionWireTest, CompressionOffAsksForNothing) {
    ClientConfig config;
    Client client (config);

    auto result = client.send (get_request (server_->url ()));
    ASSERT_TRUE (result.is_ok ());

    EXPECT_FALSE (server_->asked_for_encoding ());
    EXPECT_EQ (result.value ().body, PLAIN_BODY);
}

} // namespace
} // namespace vayu::http
