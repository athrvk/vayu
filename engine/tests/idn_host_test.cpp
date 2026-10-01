/**
 * @file tests/idn_host_test.cpp
 * @brief A non-ASCII host is dialled by its ASCII (punycode) name, the one
 *        Postman sends to (`url.domainToASCII` in `postman-url-encoder`'s
 *        `toNodeUrl`), and every host comparison made beside the transfer
 *        agrees with that name.
 *
 * Every expected name below was produced by Node 22's `url.domainToASCII`.
 *
 * The wire tests send to `*.localhost`, which libcurl resolves to loopback
 * itself on every platform, so the name that reaches the server is the one
 * libcurl dialled and no resolver or `CURLOPT_RESOLVE` entry is involved.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <future>
#include <string>
#include <utility>
#include <vector>

#include "echo_server.hpp"
#include "optional_assert.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/types.hpp"

namespace {

using vayu::tests::EchoServer;

/// @p url with its `127.0.0.1` host replaced by @p host.
std::string with_host (const std::string& url, const std::string& host) {
    const std::string loopback = "127.0.0.1";
    std::string out            = url;
    out.replace (out.find (loopback), loopback.size (), host);
    return out;
}

/// The `:port` of an EchoServer URL, as a Host header carries it.
std::string port_of (const std::string& url) {
    const std::size_t colon = url.rfind (':');
    return url.substr (colon, url.find ('/', colon) - colon);
}

class IdnHostTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
    }

    void TearDown () override {
        vayu::http::global_cleanup ();
    }

    /// The Host header a Send to @p host reached the server with, or `""`
    /// when the transfer failed.
    std::string sent_host (const std::string& host) {
        vayu::Request request;
        request.method     = vayu::HttpMethod::GET;
        request.url        = with_host (server_.url (), host);
        request.timeout_ms = 5000;
        vayu::http::Client client;
        auto result = client.send (request);
        if (!result.is_ok ()) {
            ADD_FAILURE () << host << ": " << result.error ().message;
            return {};
        }
        return server_.header ("Host");
    }

    EchoServer server_;
};

TEST_F (IdnHostTest, SendDialsTheAsciiName) {
    const std::string port = port_of (server_.url ());
    const std::vector<std::pair<std::string, std::string>> cases = {
        { "bücher.localhost", "xn--bcher-kva.localhost" },
        { "BÜCHER.localhost", "xn--bcher-kva.localhost" },
        // UTS #46 nontransitional: `ß` is kept and encoded, not mapped to `ss`.
        { "faß.localhost", "xn--fa-hia.localhost" },
        { "例え.localhost", "xn--r8jz45g.localhost" },
        // Node does not enforce the IDNA hyphen rules, and neither does this.
        { "bücher-.localhost", "xn--bcher--3ya.localhost" },
        { "xn--bcher-kva.localhost", "xn--bcher-kva.localhost" },
    };
    for (const auto& [host, dialled] : cases) {
        EXPECT_EQ (sent_host (host), dialled + port) << host;
    }
}

// Only the host is rewritten: userinfo, port, path, query and fragment keep
// their bytes, and a URL whose only non-ASCII text is outside the host is not
// touched at all.
TEST_F (IdnHostTest, TheWireUrlRewritesTheHostAlone) {
    const std::vector<std::pair<std::string, std::string>> cases = {
        { "https://ü:p@BÜCHER.example:8443/ä?q=ü#ö", "https://ü:p@xn--bcher-kva.example:8443/ä?q=ü#ö" },
        { "bücher.example/x", "xn--bcher-kva.example/x" },
        { "https://example.com/ä?q=ü", "https://example.com/ä?q=ü" },
        { "https://[::1]:8080/ä", "https://[::1]:8080/ä" },
        { "https://{{host}}/ä", "https://{{host}}/ä" },
    };
    for (const auto& [url, wire] : cases) {
        vayu::Request request;
        request.url = url;
        EXPECT_EQ (vayu::http::wire_url (request), wire) << url;
    }
}

// The load and collection-run driver sets its handles up separately from
// Send's (`setup_easy_handle`), DNS-cache pinning included.
TEST_F (IdnHostTest, TheEventLoopDialsTheAsciiName) {
    vayu::http::EventLoop loop;
    loop.start ();
    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = with_host (server_.url (), "bücher.localhost");
    request.timeout_ms = 5000;

    std::promise<vayu::Result<vayu::Response>> done;
    auto finished = done.get_future ();
    loop.submit (request, [&done] (size_t, vayu::Result<vayu::Response> result) {
        done.set_value (std::move (result));
    });
    ASSERT_EQ (finished.wait_for (std::chrono::seconds (30)), std::future_status::ready);
    const auto result = finished.get ();
    loop.stop ();

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (server_.header ("Host"),
    "xn--bcher-kva.localhost" + port_of (server_.url ()));
}

// libcurl stores a received cookie under the name it dialled, so a script
// naming the Unicode spelling must read and write that same cookie.
TEST_F (IdnHostTest, TheCookieJarMatchesEitherSpellingOfOneHost) {
    const auto set = vayu::http::cookie_for_url ("https://bücher.example/a/b",
    vayu::http::JarCookie{ "", false, "", false, false, 0, "session", "abc" });
    ASSERT_HAS_VALUE (set);
    EXPECT_EQ (set->domain, "xn--bcher-kva.example");

    const auto dotted = vayu::http::cookie_for_url ("https://example.com/",
    vayu::http::JarCookie{ ".Bücher.example", false, "/", false, false, 0, "s", "v" });
    ASSERT_HAS_VALUE (dotted);
    EXPECT_EQ (dotted->domain, ".xn--bcher-kva.example");

    const std::vector<std::string> lines = { vayu::http::format_cookie_line (*set) };
    EXPECT_EQ (vayu::http::matching_in (lines, "https://bücher.example/a/c").size (), 1U);
    EXPECT_EQ (
    vayu::http::matching_in (lines, "https://xn--bcher-kva.example/a/c").size (), 1U);
    EXPECT_EQ (vayu::http::matching_in (lines, "https://BÜCHER.example/a/c").size (), 1U);
}

// The DNS cache pins, and the client-certificate registry matches, on this
// host: it has to be the name libcurl dials, or neither ever applies.
TEST_F (IdnHostTest, TheAuthorityIsTheAsciiName) {
    const auto authority = vayu::http::detail::parse_authority (
    "https://user:pw@Bücher.example:8443/x");
    EXPECT_EQ (authority.host, "xn--bcher-kva.example");
    EXPECT_EQ (authority.port, 8443);
    EXPECT_FALSE (authority.is_ip_literal);
}

TEST_F (IdnHostTest, TheAsciiNameIsNodesDomainToAscii) {
    const std::vector<std::pair<std::string, std::string>> cases = {
        { "bücher", "xn--bcher-kva" },
        { "BÜCHER", "xn--bcher-kva" },
        { "Bücher.example", "xn--bcher-kva.example" },
        { "faß.de", "xn--fa-hia.de" },
        { "例え.テスト", "xn--r8jz45g.xn--zckzah" },
        { "ＡＢＣ", "abc" },
        { "ﬁ", "fi" },
        { "💩.la", "xn--ls8h.la" },
        { "bücher-.example", "xn--bcher--3ya.example" },
        { "-bücher.example", "xn---bcher-4ya.example" },
        { "ab--cd.bücher.example", "ab--cd.xn--bcher-kva.example" },
        { "bücher.{{tld}}", "xn--bcher-kva.{{tld}}" },
        { "１２７.０.０.１", "127.0.0.1" },
    };
    for (const auto& [host, ascii] : cases) {
        EXPECT_EQ (vayu::http::ascii_host (host), ascii) << host;
    }
}

// An ASCII host is not a question for IDNA at all: kept byte for byte, case
// and an unresolved `{{variable}}` included. Node lowercases the first and
// agrees on the second; lowercasing is the URL encoder's business.
TEST_F (IdnHostTest, AnAsciiHostIsKeptAsWritten) {
    for (const std::string host : { "xn--bcher-kva.example", "example.com",
         "API.Example.COM", "{{host}}.example" }) {
        EXPECT_EQ (vayu::http::ascii_host (host), host);
    }
}

// Node answers `""` for these and Postman then sends the host as typed, which
// cannot resolve. libcurl, built without IDN, would refuse it as "IDN support
// not present"; the send is refused first, naming the host.
TEST_F (IdnHostTest, AHostThatHasNoAsciiNameIsRefused) {
    EXPECT_FALSE (vayu::http::ascii_host ("xn--iñvalid.com").has_value ());
    EXPECT_FALSE (vayu::http::ascii_host ("bü cher.example").has_value ());

    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = with_host (server_.url (), "xn--iñvalid.localhost");
    request.timeout_ms = 5000;
    vayu::http::Client client;
    const auto result = client.send (request);
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().status_code, 0);
    EXPECT_EQ (result.value ().error_code, vayu::ErrorCode::InvalidUrl);
    EXPECT_NE (result.value ().error_message.find ("xn--iñvalid.localhost"), std::string::npos)
    << result.value ().error_message;
    EXPECT_EQ (server_.header ("Host"), "");
}

} // namespace
