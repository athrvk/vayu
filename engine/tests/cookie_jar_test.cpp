/**
 * @file tests/cookie_jar_test.cpp
 * @brief The cookie jar (issue #301): what it stores, what it hands back, and
 *        the boundary a cookie must not cross.
 *
 * The isolation test is the one that has to exist. A jar's failure mode is not
 * "the session did not persist" - that is visible the moment someone tries it -
 * it is a session cookie from staging riding along on a request to production,
 * which nothing about the response makes obvious. So `CookiesDoNotCrossAn
 * EnvironmentBoundary` sends a real request through libcurl in one scope and
 * asserts the *wire* in another, rather than asserting on jar internals: the
 * question is what went out, and only the receiving end can answer it.
 *
 * The matching helpers are unit-tested separately because they back the two
 * *read* views (`pm.cookies`, `GET /cookies`) and never decide what goes on
 * the wire - libcurl does that. See cookie_jar.hpp.
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`, which `list_page.hpp` pulls
// in; `request_body_depth_test.cpp` carries the same guard for the same reason.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <future>
#include <iterator>
#include <memory>
#include <string>
#include <thread>
#include <tuple>
#include <utility>
#include <vector>

#include <curl/curl.h>
#include <httplib.h>

#include "optional_assert.hpp"
#include "task_queue.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/curl_options.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/list_page.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "wait_until.hpp"

#include <nlohmann/json.hpp>

namespace vayu::http::routes {
// Defined in routes/cookies.cpp - the extracted cores of GET /cookies and
// DELETE /cookies, exercised directly per the suite's route-test convention
// (globals_route_test.cpp).
nlohmann::json cookies_response (const vayu::http::CookieJar& jar);
nlohmann::json clear_cookies_response (vayu::http::CookieJar& jar,
const std::optional<std::string>& scope);
// The same GET with its `q` / `limit` / `offset` keys (#2443).
std::pair<int, nlohmann::json> cookies_response (const vayu::http::CookieJar& jar,
const ListPageQuery& page_query);
} // namespace vayu::http::routes

using vayu::http::Client;
using vayu::http::ClientConfig;
using vayu::http::CookieJar;
using vayu::http::JarCookie;
using vayu::http::NO_ENVIRONMENT_SCOPE;
using vayu::http::parse_cookie_line;

namespace {

/// A line in libcurl's Netscape format, built field by field so a test reads
/// as the cookie it means rather than as seven tabs.
std::string netscape_line (const std::string& domain,
const std::string& tailmatch,
const std::string& path,
const std::string& secure,
const std::string& expires,
const std::string& name,
const std::string& value) {
    return domain + "\t" + tailmatch + "\t" + path + "\t" + secure + "\t" +
    expires + "\t" + name + "\t" + value;
}

/// Far enough ahead that a slow test run cannot expire it.
constexpr int64_t FAR_FUTURE = 4102444800; // 2100-01-01
constexpr int64_t NOW        = 1700000000; // 2023-11-14

/// @p count cookies named `c0`, `c1`, ... on @p res, each with a value that no
/// warning may repeat.
void set_numbered_cookies (httplib::Response& res, int count) {
    for (int i = 0; i < count; ++i) {
        res.set_header ("Set-Cookie",
        "c" + std::to_string (i) + "=secret-" + std::to_string (i) + "; Path=/");
    }
}

class CookieServer {
    public:
    CookieServer () {
        svr.new_task_queue = vayu::tests::pooled_task_queue (8);

        // Sets a session cookie, the way a login endpoint does.
        svr.Get ("/login", [] (const httplib::Request&, httplib::Response& res) {
            res.set_header ("Set-Cookie", "session=abc123; Path=/");
            res.set_content ("{}", "application/json");
        });
        // Reports the Cookie header it received - the wire, which is what the
        // isolation assertions are about.
        svr.Get ("/echo", [] (const httplib::Request& req, httplib::Response& res) {
            res.set_content (req.get_header_value ("Cookie"), "text/plain");
        });
        // Sets a cookie named after the path, so overlapping transfers can
        // each store one the other never saw.
        svr.Get (R"(/set/(\w+))", [] (const httplib::Request& req, httplib::Response& res) {
            const std::string name = req.matches[1].str ();
            res.set_header ("Set-Cookie", name + "=" + name + "-value; Path=/");
            res.set_content ("{}", "application/json");
        });
        // A login that bounces: sets a cookie and redirects to `to`, which
        // may be another origin (#3300).
        svr.Get ("/set-and-go", [] (const httplib::Request& req, httplib::Response& res) {
            res.set_header ("Set-Cookie", "hop=1; Path=/");
            res.set_redirect (req.get_param_value ("to"), 302);
        });
        // A redirect to `to` that sets nothing.
        svr.Get ("/go", [] (const httplib::Request& req, httplib::Response& res) {
            res.set_redirect (req.get_param_value ("to"), 302);
        });
        // `count` cookies in one response (#3307); libcurl keeps the first 50.
        // `bare` lines that name no cookie go first.
        svr.Get (R"(/set-many/(\d+))",
        [] (const httplib::Request& req, httplib::Response& res) {
            const int bare =
            req.has_param ("bare") ? std::stoi (req.get_param_value ("bare")) : 0;
            for (int i = 0; i < bare; ++i) {
                res.set_header ("Set-Cookie", "bare" + std::to_string (i));
            }
            set_numbered_cookies (res, std::stoi (req.matches[1].str ()));
            res.set_content ("{}", "application/json");
        });
        // The same, on a hop that redirects to `to`.
        svr.Get (R"(/set-many-and-go/(\d+))",
        [] (const httplib::Request& req, httplib::Response& res) {
            set_numbered_cookies (res, std::stoi (req.matches[1].str ()));
            res.set_redirect (req.get_param_value ("to"), 302);
        });
        // A cookie sized to the byte: `name`, `value_len` bytes of value, and
        // `pad_len` bytes of a trailing attribute that lengthens the line
        // without touching the name and value. `repeat` sends that many, the
        // names numbered, and `field` names the header (default `Set-Cookie`).
        svr.Get ("/sized-cookie", [] (const httplib::Request& req, httplib::Response& res) {
            const size_t repeat = req.has_param ("repeat") ?
            std::stoul (req.get_param_value ("repeat")) :
            1;
            const size_t pad    = std::stoul (req.get_param_value ("pad_len"));
            for (size_t i = 0; i < repeat; ++i) {
                std::string line = req.get_param_value ("name") +
                (repeat > 1 ? std::to_string (i) : "") + "=" +
                std::string (std::stoul (req.get_param_value ("value_len")), 'v');
                if (pad > 0) {
                    line += "; x=" + std::string (pad, 'p');
                }
                res.set_header (
                req.has_param ("field") ? req.get_param_value ("field") : "Set-Cookie", line);
            }
            res.set_content ("{}", "application/json");
        });
        // A line of `length` bytes that names no cookie (no `=`).
        svr.Get (R"(/bare-cookie/(\d+))",
        [] (const httplib::Request& req, httplib::Response& res) {
            res.set_header (
            "Set-Cookie", std::string (std::stoul (req.matches[1].str ()), 'x'));
            res.set_content ("{}", "application/json");
        });
        // Expires the cookie the way a logout does.
        svr.Get ("/logout", [] (const httplib::Request&, httplib::Response& res) {
            res.set_header ("Set-Cookie",
            "session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
            res.set_content ("{}", "application/json");
        });

        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }

    ~CookieServer () {
        svr.stop ();
        if (thread.joinable ()) {
            thread.join ();
        }
    }
    CookieServer (const CookieServer&)            = delete;
    CookieServer& operator= (const CookieServer&) = delete;
    CookieServer (CookieServer&&)                 = delete;
    CookieServer& operator= (CookieServer&&)      = delete;

    std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }

    private:
    httplib::Server svr;
    std::thread thread;
    int port = 0;
};

vayu::Request get_request (const std::string& url) {
    vayu::Request request;
    request.method     = vayu::HttpMethod::GET;
    request.url        = url;
    request.timeout_ms = 5000;
    return request;
}

/// Send @p url in @p scope through @p jar and return the whole response - the
/// raw-request view is as much a subject of these tests as the body is.
vayu::Response
response_in_scope (CookieJar& jar, const std::string& scope, const std::string& url) {
    ClientConfig config;
    config.cookie_jar   = &jar;
    config.cookie_scope = scope;
    Client client (config);
    return client.send (get_request (url)).value ();
}

/// Send @p url in @p scope through @p jar and return the response body.
std::string send_in_scope (CookieJar& jar, const std::string& scope, const std::string& url) {
    return response_in_scope (jar, scope, url).body;
}

size_t discard_body (char* /*data*/, size_t size, size_t count, void* /*user*/) {
    return size * count;
}

/// A design-mode transfer split at its seams (issue #1888): seeded now,
/// performed and captured when the test says, so two handles seeded from one
/// scope can finish in a chosen order - the overlap a stream beside a send
/// produces, with no threads to schedule.
struct SeededTransfer {
    std::unique_ptr<CURL, decltype (&curl_easy_cleanup)> curl{ curl_easy_init (),
        &curl_easy_cleanup };
    std::string scope;
    std::vector<std::string> seeded_from;
};

SeededTransfer seed_transfer (CookieJar& jar,
const std::string& scope,
const std::string& url,
const std::vector<vayu::http::CookieWrite>& writes = {}) {
    SeededTransfer transfer;
    transfer.scope = scope;
    vayu::http::set_opt<CURLOPT_URL> (transfer.curl.get (), url.c_str ());
    vayu::http::set_opt<CURLOPT_WRITEFUNCTION> (transfer.curl.get (), discard_body);
    transfer.seeded_from =
    vayu::http::detail::apply_jar_cookies (transfer.curl.get (), jar, scope, writes);
    return transfer;
}

/// Perform and capture, in the order `Client::send` does.
void finish_transfer (SeededTransfer& transfer, CookieJar& jar) {
    EXPECT_EQ (curl_easy_perform (transfer.curl.get ()), CURLE_OK);
    vayu::http::detail::capture_jar_cookies (
    transfer.curl.get (), jar, transfer.scope, transfer.seeded_from);
}

} // namespace

// ============================================================================
// The Netscape line, as libcurl writes it
// ============================================================================

TEST (CookieJarParse, ReadsEveryFieldOfALine) {
    auto cookie = parse_cookie_line (netscape_line (
    ".example.com", "TRUE", "/app", "TRUE", "1700000001", "session", "abc"));
    ASSERT_HAS_VALUE (cookie);
    EXPECT_EQ (cookie->domain, ".example.com");
    EXPECT_TRUE (cookie->include_subdomains);
    EXPECT_EQ (cookie->path, "/app");
    EXPECT_TRUE (cookie->secure);
    EXPECT_FALSE (cookie->http_only);
    EXPECT_EQ (cookie->expires, 1700000001);
    EXPECT_EQ (cookie->name, "session");
    EXPECT_EQ (cookie->value, "abc");
}

TEST (CookieJarParse, TheHttpOnlyPrefixIsAFlagAndNotPartOfTheDomain) {
    auto cookie = parse_cookie_line ("#HttpOnly_" +
    netscape_line ("example.com", "FALSE", "/", "FALSE", "0", "session", "abc"));
    ASSERT_HAS_VALUE (cookie);
    EXPECT_TRUE (cookie->http_only);
    EXPECT_EQ (cookie->domain, "example.com")
    << "the marker leaked into the domain";
}

TEST (CookieJarParse, KeepsAnEmptyValueAndAValueWithAnEquals) {
    // Session cookies are routinely base64 and end in `=` padding; an empty
    // value is what a server writes to delete one.
    auto padded = parse_cookie_line (
    netscape_line ("example.com", "FALSE", "/", "FALSE", "0", "t", "YWJj=="));
    ASSERT_HAS_VALUE (padded);
    EXPECT_EQ (padded->value, "YWJj==");

    auto empty = parse_cookie_line (
    netscape_line ("example.com", "FALSE", "/", "FALSE", "0", "t", ""));
    ASSERT_HAS_VALUE (empty);
    EXPECT_EQ (empty->value, "");
}

TEST (CookieJarParse, RefusesLinesItCannotTrust) {
    // A comment, not a cookie.
    EXPECT_FALSE (parse_cookie_line ("# Netscape HTTP Cookie File").has_value ());
    // Six fields.
    EXPECT_FALSE (
    parse_cookie_line ("example.com\tFALSE\t/\tFALSE\t0\tsession").has_value ());
    // An expiry that is not a number: refused rather than read as a session
    // cookie that never expires.
    EXPECT_FALSE (parse_cookie_line (
    netscape_line ("example.com", "FALSE", "/", "FALSE", "never", "session", "abc"))
    .has_value ());
    // No name: no reader can address it.
    EXPECT_FALSE (parse_cookie_line (
    netscape_line ("example.com", "FALSE", "/", "FALSE", "0", "", "abc"))
    .has_value ());
}

// ============================================================================
// Matching - the read views' rules (RFC 6265 §5.1.3-§5.4)
// ============================================================================

namespace {

JarCookie cookie_for (const std::string& domain, bool tailmatch, const std::string& path) {
    JarCookie cookie;
    cookie.domain             = domain;
    cookie.include_subdomains = tailmatch;
    cookie.path               = path;
    cookie.name               = "session";
    cookie.value              = "abc";
    return cookie;
}

} // namespace

TEST (CookieJarMatch, AHostOnlyCookieDoesNotReachSubdomains) {
    const auto cookie = cookie_for ("example.com", false, "/");
    EXPECT_TRUE (vayu::http::cookie_matches (cookie, "example.com", "/", false, NOW));
    EXPECT_FALSE (vayu::http::cookie_matches (cookie, "api.example.com", "/", false, NOW));
}

TEST (CookieJarMatch, ADomainCookieReachesSubdomainsButNotALookalike) {
    const auto cookie = cookie_for (".example.com", true, "/");
    EXPECT_TRUE (vayu::http::cookie_matches (cookie, "api.example.com", "/", false, NOW));
    EXPECT_TRUE (vayu::http::cookie_matches (cookie, "example.com", "/", false, NOW));
    // The dot is what makes this a subdomain check and not a suffix check.
    EXPECT_FALSE (vayu::http::cookie_matches (cookie, "notexample.com", "/", false, NOW));
    EXPECT_FALSE (vayu::http::cookie_matches (cookie, "myexample.com", "/", false, NOW));
}

TEST (CookieJarMatch, PathIsASegmentPrefixNotAStringPrefix) {
    const auto cookie = cookie_for ("example.com", false, "/foo");
    EXPECT_TRUE (vayu::http::cookie_matches (cookie, "example.com", "/foo", false, NOW));
    EXPECT_TRUE (
    vayu::http::cookie_matches (cookie, "example.com", "/foo/bar", false, NOW));
    EXPECT_FALSE (
    vayu::http::cookie_matches (cookie, "example.com", "/foobar", false, NOW));
}

TEST (CookieJarMatch, SecureNeedsHttpsAndAnExpiryInThePast) {
    auto secure   = cookie_for ("example.com", false, "/");
    secure.secure = true;
    EXPECT_FALSE (vayu::http::cookie_matches (secure, "example.com", "/", false, NOW));
    EXPECT_TRUE (vayu::http::cookie_matches (secure, "example.com", "/", true, NOW));

    auto expired    = cookie_for ("example.com", false, "/");
    expired.expires = NOW - 1;
    EXPECT_FALSE (vayu::http::cookie_matches (expired, "example.com", "/", false, NOW));

    auto session = cookie_for ("example.com", false, "/");
    ASSERT_EQ (session.expires, 0) << "0 is the session-cookie sentinel";
    EXPECT_TRUE (vayu::http::cookie_matches (session, "example.com", "/", false, NOW));
}

TEST (CookieJarMatch, SecureCookieMatchesCleartextLoopback) {
    // libcurl treats these hosts as trustworthy origins and sends a Secure
    // cookie to them over http://; the matcher behind pm.cookies must agree.
    // "[::1]" is the spelling url_scope_of produces for an IPv6 host.
    for (const std::string host : { "127.0.0.1", "localhost", "LocalHost", "::1", "[::1]" }) {
        auto secure   = cookie_for (host, false, "/");
        secure.secure = true;
        EXPECT_TRUE (vayu::http::cookie_matches (secure, host, "/", false, NOW)) << host;
    }

    auto remote   = cookie_for ("example.com", false, "/");
    remote.secure = true;
    EXPECT_FALSE (vayu::http::cookie_matches (remote, "example.com", "/", false, NOW));
    // A name that merely contains one is not loopback.
    auto lookalike   = cookie_for ("localhost.example.com", false, "/");
    lookalike.secure = true;
    EXPECT_FALSE (
    vayu::http::cookie_matches (lookalike, "localhost.example.com", "/", false, NOW));
}

TEST (CookieJarMatch, TwoHostsAreRelatedWhenOneIsTheOthersDotBoundarySubdomain) {
    using vayu::http::hosts_domain_related;
    EXPECT_TRUE (hosts_domain_related ("example.com", "example.com"));
    EXPECT_TRUE (hosts_domain_related ("www.example.com", "example.com"));
    EXPECT_TRUE (hosts_domain_related ("example.com", "www.example.com"))
    << "the relation reads in both directions";
    EXPECT_TRUE (hosts_domain_related ("a.b.example.com", "example.com"));
    EXPECT_TRUE (hosts_domain_related ("EXAMPLE.com", "www.Example.COM"));
    EXPECT_TRUE (hosts_domain_related ("example.com.", "www.example.com"))
    << "a trailing dot names the same host";

    // The dot is what makes this a subdomain check and not a suffix check.
    EXPECT_FALSE (hosts_domain_related ("evilexample.com", "example.com"));
    EXPECT_FALSE (hosts_domain_related ("example.com", "evilexample.com"));
    EXPECT_FALSE (hosts_domain_related ("example.com.evil.test", "example.com"));
    // Two children of one parent share a cookie scope only through the
    // parent, which neither names.
    EXPECT_FALSE (hosts_domain_related ("a.example.com", "b.example.com"));
    EXPECT_FALSE (hosts_domain_related ("example.com", "example.org"));
    EXPECT_FALSE (hosts_domain_related ("", ""));
    EXPECT_FALSE (hosts_domain_related ("example.com", ""));
}

TEST (CookieJarMatch, AnIpLiteralIsRelatedToItselfOnly) {
    using vayu::http::hosts_domain_related;
    EXPECT_TRUE (hosts_domain_related ("10.0.0.1", "10.0.0.1"));
    EXPECT_TRUE (hosts_domain_related ("[::1]", "[::1]"));
    // "1.10.0.0.1" ends in "10.0.0.1" at a dot, and is not an address.
    EXPECT_FALSE (hosts_domain_related ("1.10.0.0.1", "10.0.0.1"));
    EXPECT_FALSE (hosts_domain_related ("10.0.0.1", "0.0.1"));
    EXPECT_FALSE (hosts_domain_related ("[::1]", "[::2]"));
    EXPECT_FALSE (hosts_domain_related ("10.0.0.1", "example.com"));
}

TEST (CookieJarMatch, TheScopeHostIsThePunycodeNameTheJarKeysOn) {
    using vayu::http::cookie_scope_host;
    using vayu::http::hosts_domain_related;
    const auto idn = cookie_scope_host ("http://b\xC3\xBC"
                                        "cher.example/x");
    ASSERT_HAS_VALUE (idn);
    EXPECT_EQ (*idn, "xn--bcher-kva.example");
    const auto sub =
    cookie_scope_host ("http://shop.xn--bcher-kva.example:8080/");
    ASSERT_HAS_VALUE (sub);
    EXPECT_TRUE (hosts_domain_related (*idn, *sub));

    const auto v6 = cookie_scope_host ("http://[::1]:8080/x");
    ASSERT_HAS_VALUE (v6);
    EXPECT_EQ (*v6, "[::1]");

    EXPECT_FALSE (cookie_scope_host ("not a url").has_value ());
}

// ============================================================================
// Storage
// ============================================================================

TEST (CookieJarStore, MatchingReadsBackWhatWasStoredForTheUrl) {
    CookieJar jar;
    jar.store ("env_a",
    { netscape_line ("example.com", "FALSE", "/", "FALSE",
      std::to_string (FAR_FUTURE), "session", "abc"),
    netscape_line ("other.example.org", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "other", "zzz") });

    auto matched = jar.matching ("env_a", "http://example.com/users");
    ASSERT_EQ (matched.size (), 1u)
    << "the other host's cookie was returned too";
    EXPECT_EQ (matched[0].name, "session");

    EXPECT_TRUE (jar.matching ("env_b", "http://example.com/users").empty ())
    << "another scope's jar answered";
    EXPECT_TRUE (jar.matching ("env_a", "not a url").empty ());
}

TEST (CookieJarStore, SnapshotNamesTheScopeAndSkipsEmptyOnes) {
    CookieJar jar;
    const auto line =
    netscape_line ("example.com", "FALSE", "/", "FALSE", "0", "session", "abc");
    jar.store (std::string (NO_ENVIRONMENT_SCOPE), { line });
    jar.store ("env_a", { line });
    // An environment whose cookies all went is not a scope worth reporting.
    jar.store ("env_b", {});

    const auto scopes = jar.snapshot ();
    ASSERT_EQ (scopes.size (), 2u);
    // Ordered by scope key, so the no-environment jar (empty key) comes first.
    EXPECT_FALSE (scopes[0].environment_id.has_value ());
    const auto& scoped = scopes[1].environment_id;
    ASSERT_HAS_VALUE (scoped);
    EXPECT_EQ (*scoped, "env_a");
    EXPECT_EQ (scopes[1].cookies.size (), 1u);
}

TEST (CookieJarStore, ClearReportsWhatItDroppedAndLeavesOtherScopes) {
    CookieJar jar;
    const auto line =
    netscape_line ("example.com", "FALSE", "/", "FALSE", "0", "session", "abc");
    jar.store ("env_a", { line });
    jar.store ("env_b",
    { line, netscape_line ("example.com", "FALSE", "/", "FALSE", "0", "t", "x") });

    EXPECT_EQ (jar.clear ("env_a"), 1u);
    EXPECT_EQ (jar.clear ("env_a"), 0u)
    << "clearing an absent scope is not an error";
    EXPECT_EQ (jar.snapshot ().size (), 1u);
    EXPECT_EQ (jar.clear_all (), 2u);
    EXPECT_TRUE (jar.snapshot ().empty ());
}

TEST (CookieJarStore, ReconcileReadsAReSpeltButIdenticalLineAsUnchanged) {
    // Compared as text, the transfer's unchanged cookie would overwrite the
    // value a concurrent transfer stored meanwhile.
    CookieJar jar;
    const auto seeded  = netscape_line ("example.com", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "session", "old");
    const auto respelt = netscape_line ("example.com", "FALSE", "/", "FALSE",
    "00" + std::to_string (FAR_FUTURE), "session", "old");
    jar.store ("env_a",
    { netscape_line ("example.com", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "session", "concurrent") });

    jar.reconcile ("env_a", { seeded }, { respelt });

    const auto held = jar.matching ("env_a", "http://example.com/");
    ASSERT_EQ (held.size (), 1u);
    EXPECT_EQ (held[0].value, "concurrent")
    << "a line the transfer did not change overwrote a concurrent write";
}

TEST (CookieJarStore, ReconcileKeysAnUnparseableLineOnItsWholeText) {
    CookieJar jar;
    const std::string unparseable = "not a netscape line";
    const auto kept = netscape_line ("example.com", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "kept", "yes");
    jar.store ("env_a", { kept });

    jar.reconcile ("env_a", {}, { unparseable });
    EXPECT_EQ (jar.lines_for ("env_a"), (std::vector<std::string>{ kept, unparseable }));

    jar.reconcile ("env_a", { unparseable }, {});
    EXPECT_EQ (jar.lines_for ("env_a"), std::vector<std::string>{ kept });
}

// ============================================================================
// The wire: what a real transfer sends, and what it must not
// ============================================================================

TEST (CookieJarTransfer, ACookieSetByOneRequestIsSentOnTheNext) {
    CookieServer server;
    CookieJar jar;

    send_in_scope (jar, "env_staging", server.url ("/login"));
    const std::string echoed = send_in_scope (jar, "env_staging", server.url ("/echo"));

    EXPECT_NE (echoed.find ("session=abc123"), std::string::npos)
    << "the session did not survive to the second request; got: " << echoed;
}

// A login that bounces through another origin (#3300): the cookie the first
// origin set stays off the hop to the second, is stored for the first, and
// goes out again when the chain comes back to it. Cookies ignore the port, so
// the second origin is a second listener on the same host, the one case
// libcurl's own matching would have sent it to. Mutation-check: construct no
// `HopCookies` in `run_chain` and the second origin echoes `hop=1`.
TEST (CookieJarTransfer, ACookieAHopSetStaysWithTheOriginThatSetIt) {
    CookieServer origin;
    CookieServer other;
    CookieJar jar;

    const vayu::Response away = response_in_scope (
    jar, "env_a", origin.url ("/set-and-go?to=" + other.url ("/echo")));
    ASSERT_EQ (away.status_code, 200) << away.error_message;
    EXPECT_EQ (away.body, "")
    << "a cookie the first origin set reached the second";
    EXPECT_NE (send_in_scope (jar, "env_a", origin.url ("/echo")).find ("hop=1"),
    std::string::npos)
    << "the cookie was not kept for the origin that set it";

    const vayu::Response back = response_in_scope (jar, "env_b",
    origin.url ("/set-and-go?to=" + other.url ("/go?to=" + origin.url ("/echo"))));
    ASSERT_EQ (back.status_code, 200) << back.error_message;
    EXPECT_EQ (back.redirect_hops.size (), 2U);
    EXPECT_EQ (back.body, "hop=1")
    << "a hop back to the origin that set the cookie went without it";
}

TEST (CookieJarTransfer, CookiesDoNotCrossAnEnvironmentBoundary) {
    CookieServer server;
    CookieJar jar;

    // Same host, same path, same jar object - only the environment differs,
    // which is exactly the staging-cookie-on-production case. Cookies ignore
    // the port, so "different host" is not the protection here; the scope is.
    send_in_scope (jar, "env_staging", server.url ("/login"));
    const std::string leaked =
    send_in_scope (jar, "env_production", server.url ("/echo"));

    EXPECT_EQ (leaked, "") << "a cookie leaked out of its environment: " << leaked;
}

TEST (CookieJarTransfer, TheNoEnvironmentJarIsItsOwnScope) {
    CookieServer server;
    CookieJar jar;

    send_in_scope (jar, std::string (NO_ENVIRONMENT_SCOPE), server.url ("/login"));
    EXPECT_NE (send_in_scope (jar, std::string (NO_ENVIRONMENT_SCOPE), server.url ("/echo"))
               .find ("session=abc123"),
    std::string::npos);
    EXPECT_EQ (send_in_scope (jar, "env_a", server.url ("/echo")), "");
}

TEST (CookieJarTransfer, AClientWithNoJarSendsNothingAndStoresNothing) {
    CookieServer server;
    CookieJar jar;

    // The default config - what the OAuth token call, the import fetch and the
    // update check use. It must not pick up a session on the way past.
    Client client;
    ASSERT_FALSE (client.send (get_request (server.url ("/login"))).value ().has_error ());
    EXPECT_TRUE (jar.snapshot ().empty ());

    Client second;
    EXPECT_EQ (second.send (get_request (server.url ("/echo"))).value ().body, "");
}

TEST (CookieJarTransfer, ClearingTheJarStopsTheCookieBeingSent) {
    CookieServer server;
    CookieJar jar;

    // Deliberately *one* client for both sends. `curl_easy_reset` keeps a
    // handle's cookies on purpose, so without the flush in apply_jar_cookies
    // this handle would still carry the session that Settings just cleared -
    // and a jar the user cannot actually empty is worse than no clear button.
    ClientConfig config;
    config.cookie_jar   = &jar;
    config.cookie_scope = "env_a";
    Client client (config);

    ASSERT_FALSE (client.send (get_request (server.url ("/login"))).value ().has_error ());
    ASSERT_EQ (jar.clear ("env_a"), 1u);

    EXPECT_EQ (client.send (get_request (server.url ("/echo"))).value ().body, "")
    << "a cleared cookie was still sent - the handle kept its own copy";
}

TEST (CookieJarTransfer, AServerExpiringACookieRemovesItFromTheJar) {
    CookieServer server;
    CookieJar jar;

    send_in_scope (jar, "env_a", server.url ("/login"));
    ASSERT_FALSE (jar.snapshot ().empty ());

    // A logout expires the cookie. A cookie the transfer was seeded with and no
    // longer holds is removed rather than merged back.
    send_in_scope (jar, "env_a", server.url ("/logout"));
    EXPECT_EQ (send_in_scope (jar, "env_a", server.url ("/echo")), "");
}

TEST (CookieJarTransfer, OverlappingTransfersInOneScopeKeepEachOthersCookies) {
    // Issue #1888: seeded from one scope, finished in reverse order. A
    // whole-scope replace by the one finishing last drops the other's cookie.
    CookieServer server;
    CookieJar jar;
    send_in_scope (jar, "env_a", server.url ("/login"));

    auto first  = seed_transfer (jar, "env_a", server.url ("/set/alpha"));
    auto second = seed_transfer (jar, "env_a", server.url ("/set/beta"));
    finish_transfer (second, jar);
    finish_transfer (first, jar);

    const std::string echoed = send_in_scope (jar, "env_a", server.url ("/echo"));
    EXPECT_NE (echoed.find ("alpha=alpha-value"), std::string::npos) << echoed;
    EXPECT_NE (echoed.find ("beta=beta-value"), std::string::npos)
    << "the transfer that finished last dropped the other's cookie: " << echoed;
    EXPECT_NE (echoed.find ("session=abc123"), std::string::npos) << echoed;
}

TEST (CookieJarTransfer, ACookieExpiredDuringAnOverlappingTransferStaysRemoved) {
    // The other transfer still holds the session it was seeded with when it
    // finishes; holding it unchanged must not bring it back.
    CookieServer server;
    CookieJar jar;
    send_in_scope (jar, "env_a", server.url ("/login"));

    auto logout = seed_transfer (jar, "env_a", server.url ("/logout"));
    auto other  = seed_transfer (jar, "env_a", server.url ("/set/beta"));
    finish_transfer (logout, jar);
    finish_transfer (other, jar);

    const std::string echoed = send_in_scope (jar, "env_a", server.url ("/echo"));
    EXPECT_EQ (echoed.find ("session="), std::string::npos)
    << "an overlapping transfer resurrected the expired session: " << echoed;
    EXPECT_NE (echoed.find ("beta=beta-value"), std::string::npos) << echoed;
}

// The jar attaches cookies inside libcurl, so the raw-request view had no way
// to know about them and said nothing was sent (issue #339) - silent
// misinformation in the surface whose whole job is showing what went out. The
// value is shown plainly: this view exists to be exact, and the same value is
// already readable in Settings. The verbose log keeps its redaction.
TEST (CookieJarTransfer, TheRawRequestViewShowsTheCookieThatWasSent) {
    CookieServer server;
    CookieJar jar;

    send_in_scope (jar, "env_a", server.url ("/login"));
    const auto sent = response_in_scope (jar, "env_a", server.url ("/echo"));

    EXPECT_EQ (sent.body, "session=abc123")
    << "the cookie never reached the server";
    EXPECT_NE (sent.raw_request.find ("Cookie: session=abc123"), std::string::npos)
    << "the wire carried the cookie and the raw view denied it:\n"
    << sent.raw_request;

    // The other half of the claim: the view reports what was sent, so a scope
    // with no matching cookie must not gain a Cookie line it never had.
    const auto none = response_in_scope (jar, "env_b", server.url ("/echo"));
    EXPECT_EQ (none.raw_request.find ("Cookie:"), std::string::npos)
    << "a cookie appeared in a scope that sent none:\n"
    << none.raw_request;
}

// ============================================================================
// What libcurl withholds or caps (issue #3307)
// ============================================================================

namespace {

/// @p count jar cookies for 127.0.0.1, each @p value_bytes of value, named
/// `<prefix>0`, `<prefix>1`, ... - a cookie is held to 4096 bytes of name plus
/// value, so a line past libcurl's header limit takes several.
void store_loopback_cookies (CookieJar& jar,
const std::string& scope,
const std::string& prefix,
int count,
size_t value_bytes) {
    std::vector<std::string> lines;
    lines.reserve (static_cast<size_t> (count));
    for (int i = 0; i < count; ++i) {
        lines.push_back (netscape_line ("127.0.0.1", "FALSE", "/", "FALSE",
        std::to_string (FAR_FUTURE), prefix + std::to_string (i),
        std::string (value_bytes, 'v')));
    }
    jar.store (scope, std::move (lines));
}

/// Three loopback jar cookies of exactly the @p names, each @p value_bytes of
/// value.
void store_named_loopback_cookies (CookieJar& jar,
const std::string& scope,
const std::vector<std::string>& names,
size_t value_bytes) {
    std::vector<std::string> lines;
    lines.reserve (names.size ());
    for (const auto& name : names) {
        lines.push_back (netscape_line ("127.0.0.1", "FALSE", "/", "FALSE",
        std::to_string (FAR_FUTURE), name, std::string (value_bytes, 'v')));
    }
    jar.store (scope, std::move (lines));
}

vayu::Response send_with_typed_cookie (CookieJar& jar, const std::string& url) {
    ClientConfig config;
    config.cookie_jar   = &jar;
    config.cookie_scope = "env_a";
    Client client (config);
    vayu::Request request = get_request (url);
    request.headers.add ("Cookie", "typed=2");
    return client.send (request).value ();
}

std::vector<vayu::ResponseWarning>
warnings_with_code (const vayu::Response& response, const std::string& code) {
    std::vector<vayu::ResponseWarning> found;
    std::ranges::copy_if (response.warnings, std::back_inserter (found),
    [&] (const vayu::ResponseWarning& warning) { return warning.code == code; });
    return found;
}

/// Puts the console verbosity back, so a test that raises it cannot leak the
/// level into the next one.
class VerbosityRestorer {
    public:
    VerbosityRestorer ()
    : saved_ (vayu::utils::Logger::instance ().get_verbosity ()) {
    }
    ~VerbosityRestorer () {
        vayu::utils::Logger::instance ().set_verbosity (saved_);
    }
    VerbosityRestorer (const VerbosityRestorer&)            = delete;
    VerbosityRestorer& operator= (const VerbosityRestorer&) = delete;
    VerbosityRestorer (VerbosityRestorer&&)                 = delete;
    VerbosityRestorer& operator= (VerbosityRestorer&&)      = delete;

    private:
    int saved_;
};

} // namespace

// Three ~3000-byte jar cookies pass libcurl's 8190-byte Cookie line at the
// third, and it drops the typed `Cookie` row along with it. The response says
// which cookie, and `request_headers` stops claiming the typed row went out.
// Run at both ends of the console verbosity: the warning is the response's, not
// the log's. Mutation-check: drop the CURLINFO_TEXT branch of `debug_callback`
// and no warning arrives; move it below the verbosity gate and the verbosity-0
// pass finds none; drop `apply_cookie_notices`' erase and the typed row stays
// in the record.
TEST (CookieJarWarnings, ACookiePastTheHeaderLimitIsNamedAndTakesTheTypedRowWithIt) {
    VerbosityRestorer restore;
    for (const int verbosity : { 0, 2 }) {
        vayu::utils::Logger::instance ().set_verbosity (verbosity);
        CookieServer server;
        CookieJar jar;
        store_loopback_cookies (jar, "env_a", "big", 3, 3000);

        const vayu::Response response =
        send_with_typed_cookie (jar, server.url ("/echo"));

        ASSERT_EQ (response.status_code, 200) << "verbosity " << verbosity;
        const auto found = warnings_with_code (response, "cookie_not_sent");
        ASSERT_EQ (found.size (), 1U)
        << "verbosity "
        << verbosity << ": no warning, or libcurl reworded its header-size notice (client.cpp)";
        EXPECT_NE (found.front ().message.find ("Cookie big"), std::string::npos)
        << found.front ().message;
        EXPECT_NE (found.front ().message.find ("8190"), std::string::npos)
        << found.front ().message;
        for (const auto& warning : response.warnings) {
            EXPECT_EQ (warning.message.find ("vvvv"), std::string::npos)
            << "a cookie value reached a warning: " << warning.message;
        }
        EXPECT_TRUE (warnings_with_code (response, "cookie_limit_reached").empty ());

        EXPECT_EQ (response.body.find ("typed"), std::string::npos)
        << "the typed row reached the server, so the record is not what is "
           "wrong";
        EXPECT_FALSE (response.request_headers.contains ("Cookie"))
        << "request_headers still claims a Cookie row the wire never carried";
        EXPECT_EQ (response.raw_request.find ("typed=2"), std::string::npos);
    }
}

// Past 150 jar cookies libcurl sends 150 and says so; the typed row is not
// withheld in that case and stays in the record. Mutation-check: prune on
// every warning and the typed row leaves `request_headers`.
TEST (CookieJarWarnings, TheCookieCountCapIsReportedAndLeavesTheTypedRowSent) {
    CookieServer server;
    CookieJar jar;
    store_loopback_cookies (jar, "env_a", "c", 151, 1);

    const vayu::Response response = send_with_typed_cookie (jar, server.url ("/echo"));

    ASSERT_EQ (response.status_code, 200);
    const auto found = warnings_with_code (response, "cookie_limit_reached");
    ASSERT_EQ (found.size (), 1U)
    << "no warning, or libcurl reworded its cookie-count notice (client.cpp)";
    EXPECT_NE (found.front ().message.find ("150"), std::string::npos)
    << found.front ().message;
    EXPECT_TRUE (warnings_with_code (response, "cookie_not_sent").empty ());
    EXPECT_NE (response.body.find ("typed=2"), std::string::npos) << response.body;
    EXPECT_EQ (response.request_headers.at ("Cookie"), "typed=2");
}

// The other branch of both: a send under the header limit and the count cap
// warns of nothing and keeps its typed row.
TEST (CookieJarWarnings, ASendUnderBothCapsWarnsOfNothing) {
    CookieServer server;
    CookieJar jar;
    store_loopback_cookies (jar, "env_a", "small", 3, 10);

    const vayu::Response response = send_with_typed_cookie (jar, server.url ("/echo"));

    ASSERT_EQ (response.status_code, 200);
    EXPECT_TRUE (response.warnings.empty ());
    EXPECT_NE (response.body.find ("typed=2"), std::string::npos) << response.body;
    EXPECT_EQ (response.request_headers.at ("Cookie"), "typed=2");
}

// Every hop of a chain attaches the same jar cookies and libcurl reports each
// time; the response names the cookie once. Mutation-check: drop the
// de-duplication in `note_cookie_notice` and the count is 2.
TEST (CookieJarWarnings, ARedirectedSendNamesTheWithheldCookieOnce) {
    CookieServer server;
    CookieJar jar;
    store_loopback_cookies (jar, "env_a", "big", 3, 3000);

    const vayu::Response response =
    send_with_typed_cookie (jar, server.url ("/go?to=" + server.url ("/echo")));

    ASSERT_EQ (response.status_code, 200) << response.error_message;
    ASSERT_EQ (response.redirect_hops.size (), 1U);
    EXPECT_EQ (warnings_with_code (response, "cookie_not_sent").size (), 1U);
}

// A jar cookie name is wire bytes. One past 0x7F that is not UTF-8 would make
// the live body's `dump ()` throw if the warning quoted it, so the warning
// leaves the name out and still reads as a sentence. Mutation-check: put the
// notice's name into the message unchecked and the `dump ()` throws.
TEST (CookieJarWarnings, AWithheldCookieWhoseNameIsNotTextIsLeftUnnamed) {
    CookieServer server;
    CookieJar jar;
    store_named_loopback_cookies (
    jar, "env_a", { "\xFF\xFE_a", "\xFF\xFE_b", "\xFF\xFE_c" }, 3000);

    const vayu::Response response = send_with_typed_cookie (jar, server.url ("/echo"));

    ASSERT_EQ (response.status_code, 200);
    const auto found = warnings_with_code (response, "cookie_not_sent");
    ASSERT_EQ (found.size (), 1U);
    EXPECT_TRUE (found.front ().message.starts_with ("A cookie was not sent:"))
    << found.front ().message;
    EXPECT_TRUE (std::ranges::all_of (found.front ().message,
    [] (const char byte) { return static_cast<unsigned char> (byte) < 0x80; }))
    << "a byte that is not text reached the message";
    EXPECT_NO_THROW ((void)vayu::json::serialize_warnings (response.warnings).dump ());
    EXPECT_FALSE (response.request_headers.contains ("Cookie"));
}

// libcurl formats the notice into 2048 bytes and ends a longer one in "...",
// so a name this long loses the notice's own suffix. The warning is still
// raised (and with it the typed row dropped from the record), naming the
// first 64 bytes. Mutation-check: require the suffix again and no warning
// arrives, so the typed row stays in `request_headers`.
TEST (CookieJarWarnings, AWithheldCookieWithAVeryLongNameIsStillReportedAndCutShort) {
    CookieServer server;
    CookieJar jar;
    const std::string stem (2100, 'n');
    store_named_loopback_cookies (
    jar, "env_a", { stem + "0", stem + "1", stem + "2" }, 1000);

    const vayu::Response response = send_with_typed_cookie (jar, server.url ("/echo"));

    ASSERT_EQ (response.status_code, 200);
    const auto found = warnings_with_code (response, "cookie_not_sent");
    ASSERT_EQ (found.size (), 1U)
    << "no warning for a notice libcurl cut short (client.cpp)";
    EXPECT_NE (found.front ().message.find ("Cookie " + std::string (64, 'n') + "... was not sent"),
    std::string::npos)
    << found.front ().message;
    EXPECT_EQ (found.front ().message.find (std::string (65, 'n')), std::string::npos);
    EXPECT_FALSE (response.request_headers.contains ("Cookie"))
    << "request_headers still claims a Cookie row the wire never carried";
    EXPECT_EQ (response.body.find ("typed"), std::string::npos);
}

// ============================================================================
// What libcurl drops from a response (issue #3307)
// ============================================================================

namespace {

constexpr const char* TOO_MANY  = "cookie_dropped_too_many";
constexpr const char* OVERSIZED = "cookie_dropped_oversized";

/// Bytes libcurl counts for the length limit beyond the cookie text: the space
/// after `Set-Cookie:` and the line's CRLF.
constexpr size_t LINE_FRAMING_BYTES = 3;
constexpr size_t LINE_LIMIT_BYTES   = 5000;
constexpr size_t NAME_VALUE_LIMIT   = 4096;

std::string sized_cookie_url (const CookieServer& server,
const std::string& name,
size_t value_len,
size_t pad_len) {
    return server.url ("/sized-cookie?name=" + name +
    "&value_len=" + std::to_string (value_len) + "&pad_len=" + std::to_string (pad_len));
}

/// The `pad_len` that makes libcurl measure a `<name>=<value_len bytes>; x=<pad>`
/// line at @p measured bytes.
size_t pad_for_measured_line (const std::string& name, size_t value_len, size_t measured) {
    const size_t unpadded = name.size () + 1 + value_len + std::string ("; x=").size ();
    return measured - LINE_FRAMING_BYTES - unpadded;
}

/// What the server receives back from the jar: the cookies libcurl kept.
std::string kept_cookies (CookieJar& jar, const CookieServer& server) {
    return send_in_scope (jar, "env_a", server.url ("/echo"));
}

void expect_no_value_in_warnings (const vayu::Response& response) {
    for (const auto& warning : response.warnings) {
        EXPECT_EQ (warning.message.find ("vvvv"), std::string::npos) << warning.message;
        EXPECT_EQ (warning.message.find ("pppp"), std::string::npos) << warning.message;
        EXPECT_EQ (warning.message.find ("secret-"), std::string::npos)
        << warning.message;
    }
}

} // namespace

// libcurl adds the first 50 cookies of a response and ignores the rest without
// a word. Mutation-check: raise `SET_COOKIES_PER_RESPONSE_LIMIT` to 51 and the
// 51st finds no warning; drop `apply_incoming_cookies`' too-many branch and the
// same.
TEST (CookieJarIncoming, TheFiftyFirstSetCookieHeaderIsReportedAsIgnored) {
    CookieServer server;
    CookieJar jar;

    const vayu::Response response =
    response_in_scope (jar, "env_a", server.url ("/set-many/51"));

    ASSERT_EQ (response.status_code, 200);
    const auto found = warnings_with_code (response, TOO_MANY);
    ASSERT_EQ (found.size (), 1U)
    << "libcurl's per-response cookie cap moved (client.cpp)";
    EXPECT_NE (
    found.front ().message.find ("1 Set-Cookie header after that was ignored"),
    std::string::npos)
    << found.front ().message;
    EXPECT_NE (found.front ().message.find ("50"), std::string::npos)
    << found.front ().message;
    expect_no_value_in_warnings (response);

    const std::string kept = kept_cookies (jar, server);
    EXPECT_NE (kept.find ("c49="), std::string::npos) << kept;
    EXPECT_EQ (kept.find ("c50="), std::string::npos)
    << "libcurl stored the 51st, so the warning is wrong:\n"
    << kept;
}

TEST (CookieJarIncoming, FiftySetCookieHeadersWarnOfNothing) {
    CookieServer server;
    CookieJar jar;

    const vayu::Response response =
    response_in_scope (jar, "env_a", server.url ("/set-many/50"));

    ASSERT_EQ (response.status_code, 200);
    EXPECT_TRUE (response.warnings.empty ());
    EXPECT_NE (kept_cookies (jar, server).find ("c49="), std::string::npos);
}

// A line that names no cookie is not stored, so libcurl does not count it
// against the 50: three of them before 50 cookies keep all 50. Mutation-check:
// drop the `NotACookie` return in `SetCookieLimits::note` and three are
// reported ignored here and under load.
TEST (CookieJarIncoming, ALineThatNamesNoCookieIsNotCountedAgainstTheCap) {
    CookieServer server;
    CookieJar jar;
    const std::string url = server.url ("/set-many/50?bare=3");

    const vayu::Response response = response_in_scope (jar, "env_a", url);

    ASSERT_EQ (response.status_code, 200);
    EXPECT_TRUE (response.warnings.empty ());
    EXPECT_NE (kept_cookies (jar, server).find ("c49="), std::string::npos)
    << "libcurl counted a line that names no cookie, so the rule is wrong";
}

TEST (CookieJarIncoming, TheWarningCountsEveryHeaderPastTheCap) {
    CookieServer server;
    CookieJar jar;

    const vayu::Response response =
    response_in_scope (jar, "env_a", server.url ("/set-many/60"));

    const auto found = warnings_with_code (response, TOO_MANY);
    ASSERT_EQ (found.size (), 1U);
    EXPECT_NE (found.front ().message.find ("10 Set-Cookie headers after"), std::string::npos)
    << found.front ().message;
}

// The count is per response: 30 cookies on each of two hops is 30 twice, not
// 60. A hop with its own 51 is its own overflow, and the response reports the
// ignored headers of both in one warning. Mutation-check: drop
// `start_response` from `header_callback` and the 30 + 30 chain warns.
TEST (CookieJarIncoming, TheCapIsPerResponseAndCountsEveryHopOfAChain) {
    CookieServer server;
    CookieJar jar;

    const vayu::Response under = response_in_scope (jar, "env_a",
    server.url ("/set-many-and-go/30?to=" + server.url ("/set-many/30")));
    ASSERT_EQ (under.status_code, 200) << under.error_message;
    ASSERT_EQ (under.redirect_hops.size (), 1U);
    EXPECT_TRUE (under.warnings.empty ()) << "the count carried over a hop";

    const vayu::Response over = response_in_scope (jar, "env_a",
    server.url ("/set-many-and-go/51?to=" + server.url ("/set-many/52")));
    ASSERT_EQ (over.redirect_hops.size (), 1U);
    const auto found = warnings_with_code (over, TOO_MANY);
    ASSERT_EQ (found.size (), 1U);
    EXPECT_NE (found.front ().message.find ("3 Set-Cookie headers after"), std::string::npos)
    << found.front ().message;
}

// libcurl discards a line it measures past 5000 bytes unread. The measure runs
// from the byte after `Set-Cookie:` to the end of the CRLF. Mutation-check:
// compare with `>=` and the 5000-byte line warns; drop the line test and the
// 5001-byte one finds nothing.
TEST (CookieJarIncoming, ALineOverFiveThousandBytesIsDroppedAndNamed) {
    CookieServer server;
    CookieJar jar;
    const std::string name = "linecookie";
    for (const size_t measured : { LINE_LIMIT_BYTES, LINE_LIMIT_BYTES + 1 }) {
        const bool dropped = measured > LINE_LIMIT_BYTES;
        const size_t pad   = pad_for_measured_line (name, 10, measured);
        const auto response =
        response_in_scope (jar, "env_a", sized_cookie_url (server, name, 10, pad));

        ASSERT_EQ (response.status_code, 200);
        const auto found = warnings_with_code (response, OVERSIZED);
        ASSERT_EQ (found.size (), dropped ? 1U : 0U)
        << measured << " bytes: libcurl's line limit moved, or the measure did (client.cpp)";
        if (dropped) {
            EXPECT_NE (found.front ().message.find (": linecookie."), std::string::npos)
            << found.front ().message;
        }
        EXPECT_EQ (kept_cookies (jar, server).find ("linecookie=") != std::string::npos, !dropped)
        << measured << " bytes";
        expect_no_value_in_warnings (response);
        (void)jar.clear ("env_a");
    }
}

// Name plus value past 4096 bytes is dropped though the line is far under the
// line limit. Mutation-check: compare with `>=` and the 4096-byte cookie warns;
// drop the name-and-value test and the 4097-byte one finds nothing.
TEST (CookieJarIncoming, ANameAndValueOverFourThousandNinetySixBytesIsDroppedAndNamed) {
    CookieServer server;
    CookieJar jar;
    const std::string name = "nv";
    for (const size_t total : { NAME_VALUE_LIMIT, NAME_VALUE_LIMIT + 1 }) {
        const bool dropped  = total > NAME_VALUE_LIMIT;
        const auto response = response_in_scope (
        jar, "env_a", sized_cookie_url (server, name, total - name.size (), 0));

        ASSERT_EQ (response.status_code, 200);
        const auto found = warnings_with_code (response, OVERSIZED);
        ASSERT_EQ (found.size (), dropped ? 1U : 0U)
        << total << " bytes: libcurl's name and value limit moved (client.cpp)";
        if (dropped) {
            EXPECT_NE (found.front ().message.find (": nv."), std::string::npos)
            << found.front ().message;
        }
        EXPECT_EQ (kept_cookies (jar, server).find ("nv=") != std::string::npos, !dropped)
        << total << " bytes";
        expect_no_value_in_warnings (response);
        (void)jar.clear ("env_a");
    }
}

// The header name is matched whole and without regard to case: libcurl reads
// `set-cookie:` as `Set-Cookie:` and `X-Set-Cookie:` as nothing.
// Mutation-check: match with `contains` or drop `ascii_lower_equal` for `==`.
TEST (CookieJarIncoming, OnlyASetCookieHeaderInAnyCaseIsCounted) {
    CookieServer server;
    CookieJar jar;
    const auto warns = [&] (const std::string& field) {
        return !warnings_with_code (
        response_in_scope (jar, "env_a",
        sized_cookie_url (server, "nv", NAME_VALUE_LIMIT, 0) + "&field=" + field),
        OVERSIZED)
                .empty ();
    };

    EXPECT_TRUE (warns ("set-cookie"));
    EXPECT_TRUE (warns ("SET-COOKIE"));
    EXPECT_FALSE (warns ("X-Set-Cookie"));
    EXPECT_FALSE (warns ("Set-Cookie2"));
}

// The name is wire bytes: one past 64 is cut (at a character boundary), one
// that is not text is left out, and a line that names no cookie is counted
// without a name. Only five are named. Mutation-check: drop the truncation and
// the 100-byte name appears whole; drop the UTF-8 test and the serialized
// warning throws.
TEST (CookieJarIncoming, ADroppedCookiesNameIsBoundedAndNeverBytesThatAreNotText) {
    CookieServer server;
    CookieJar jar;
    const std::string long_name (100, 'n');

    const auto response = response_in_scope (
    jar, "env_a", sized_cookie_url (server, long_name, NAME_VALUE_LIMIT, 0));
    const auto found = warnings_with_code (response, OVERSIZED);
    ASSERT_EQ (found.size (), 1U);
    EXPECT_NE (found.front ().message.find (std::string (64, 'n') + "..."), std::string::npos)
    << found.front ().message;
    EXPECT_EQ (found.front ().message.find (std::string (65, 'n')), std::string::npos);

    // %FF is not UTF-8; httplib hands the byte through decoded.
    const auto binary = response_in_scope (
    jar, "env_a", sized_cookie_url (server, "%FF%FE", NAME_VALUE_LIMIT, 0));
    const auto binary_found = warnings_with_code (binary, OVERSIZED);
    ASSERT_EQ (binary_found.size (), 1U);
    EXPECT_NE (binary_found.front ().message.find ("and 1 more"), std::string::npos)
    << binary_found.front ().message;
    EXPECT_NO_THROW ((void)vayu::json::serialize_warnings (binary.warnings).dump ());

    const auto many       = response_in_scope (jar, "env_a",
    sized_cookie_url (server, "m", NAME_VALUE_LIMIT, 0) + "&repeat=7");
    const auto many_found = warnings_with_code (many, OVERSIZED);
    ASSERT_EQ (many_found.size (), 1U);
    EXPECT_NE (many_found.front ().message.find ("7 Set-Cookie headers it"), std::string::npos)
    << many_found.front ().message;
    EXPECT_NE (
    many_found.front ().message.find (": m0, m1, m2, m3, m4, and 2 more."), std::string::npos)
    << many_found.front ().message;

    const auto bare = response_in_scope (jar, "env_a", server.url ("/bare-cookie/5001"));
    const auto bare_found = warnings_with_code (bare, OVERSIZED);
    ASSERT_EQ (bare_found.size (), 1U);
    EXPECT_NE (bare_found.front ().message.find ("1 Set-Cookie header it"), std::string::npos)
    << bare_found.front ().message;
    EXPECT_NE (bare_found.front ().message.find ("and 1 more"), std::string::npos);
    EXPECT_EQ (bare_found.front ().message.find ("xxxx"), std::string::npos);
}

// libcurl's engine is off for a send with no jar - what `disableCookies` hands
// the client - so it drops nothing and the response must not claim it did.
// Mutation-check: install the watch whatever the jar and the no-jar pass warns.
TEST (CookieJarIncoming, ASendWithNoJarWarnsOfNoDroppedCookies) {
    CookieServer server;
    const std::vector<std::string> urls{ server.url ("/set-many/51"),
        sized_cookie_url (server, "nv", NAME_VALUE_LIMIT, 0),
        server.url ("/bare-cookie/5001") };
    for (const auto& url : urls) {
        CookieJar jar;
        EXPECT_EQ (response_in_scope (jar, "env_a", url).warnings.size (), 1U)
        << "with a jar the drop is reported: " << url;

        Client without_jar{ ClientConfig{} };
        const auto response = without_jar.send (get_request (url)).value ();
        ASSERT_EQ (response.status_code, 200);
        EXPECT_TRUE (response.warnings.empty ()) << "no jar, no cookie engine: " << url;
    }
}

// ============================================================================
// The same limits on the load path's transfers (issue #3307)
// ============================================================================

namespace {

/// What the event loop counted as dropped on one transfer of @p url, given the
/// per-transfer cookie engine a scenario virtual user's step gets when
/// @p tracks_cookies. The load path counts and never names.
size_t dropped_under_load (const std::string& url, bool tracks_cookies) {
    vayu::http::EventLoopConfig config;
    config.num_workers = 1;
    vayu::http::EventLoop loop (config);
    loop.start ();
    auto request          = get_request (url);
    request.track_cookies = tracks_cookies;
    auto pending          = loop.submit_async (request);
    if (pending.future.wait_for (vayu::tests::WAIT_DEADLINE) != std::future_status::ready) {
        ADD_FAILURE () << "no completion for " << url;
        return 0;
    }
    const auto result = pending.future.get ();
    loop.stop ();
    if (!result.is_ok () || result.value ().status_code != 200) {
        ADD_FAILURE () << "the transfer of " << url << " did not answer 200";
        return 0;
    }
    EXPECT_TRUE (result.value ().warnings.empty ())
    << "the load path names nothing";
    return result.value ().set_cookie_headers_dropped;
}

} // namespace

// Each limit at its boundary, through the event loop's own header callback: the
// rule is shared with the design send, the callback and its status-line reset
// are not. Mutation-check: drop the `count_dropped_set_cookie` call in
// `curl_callbacks.cpp` and every count reads 0; drop
// `set_cookie_limits.start_response ()` there and the 30 + 30 chain counts 10.
TEST (CookieJarIncomingUnderLoad, ATransferThatTracksCookiesCountsEveryHeaderLibcurlDrops) {
    CookieServer server;
    const auto tracked = [] (const std::string& url) {
        return dropped_under_load (url, true);
    };
    const std::string name = "linecookie";
    const auto line_of     = [&] (size_t measured) {
        return sized_cookie_url (
        server, name, 10, pad_for_measured_line (name, 10, measured));
    };
    // A cookie `nv` whose name and value are `total` bytes.
    const auto pair_of = [&] (size_t total) {
        return sized_cookie_url (server, "nv", total - 2, 0);
    };

    EXPECT_EQ (tracked (server.url ("/set-many/50")), 0U);
    EXPECT_EQ (tracked (server.url ("/set-many/53")), 3U);
    EXPECT_EQ (tracked (server.url ("/set-many/50?bare=3")), 0U);
    EXPECT_EQ (tracked (line_of (LINE_LIMIT_BYTES)), 0U);
    EXPECT_EQ (tracked (line_of (LINE_LIMIT_BYTES + 1)), 1U);
    EXPECT_EQ (tracked (pair_of (NAME_VALUE_LIMIT)), 0U);
    EXPECT_EQ (tracked (pair_of (NAME_VALUE_LIMIT + 1)), 1U);
    EXPECT_EQ (
    tracked (server.url ("/set-many-and-go/30?to=" + server.url ("/set-many/30"))), 0U)
    << "the per-response count carried over a hop";
    EXPECT_EQ (
    tracked (server.url ("/set-many-and-go/51?to=" + server.url ("/set-many/52"))), 3U)
    << "a chain sums what each of its hops dropped";
}

// Off by default and for every single-request load run: libcurl's engine is
// off, drops nothing, and nothing is counted. Mutation-check: drop the
// `track_cookies` test in `header_callback` and these read 10 and 1.
TEST (CookieJarIncomingUnderLoad, ATransferWithoutCookiesCountsNothing) {
    CookieServer server;
    EXPECT_EQ (dropped_under_load (server.url ("/set-many/60"), false), 0U);
    EXPECT_EQ (
    dropped_under_load (sized_cookie_url (server, "nv", NAME_VALUE_LIMIT, 0), false), 0U);
}

// ============================================================================
// What the script sees
// ============================================================================

TEST (CookieJarScript, PmCookiesReadsTheJarForTheRequestsUrl) {
    CookieJar jar;
    jar.store ("env_a",
    { netscape_line ("example.com", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "session", "abc") });

    vayu::runtime::ScriptEngine engine;
    vayu::Request request = get_request ("http://example.com/users");
    vayu::Response response;
    vayu::Environment env;

    vayu::runtime::ScriptContext ctx;
    ctx.request      = &request;
    ctx.response     = &response;
    ctx.environment  = &env;
    ctx.cookie_jar   = &jar;
    ctx.cookie_scope = "env_a";

    auto result = engine.execute (
    "pm.environment.set('got', pm.cookies.get('session'));"
    "pm.environment.set('has', String(pm.cookies.has('session')));"
    "pm.environment.set('obj', JSON.stringify(pm.cookies.toObject()));"
    "pm.environment.set('absent', String(pm.cookies.get('nope')));",
    ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["got"].value, "abc");
    EXPECT_EQ (env["has"].value, "true");
    EXPECT_EQ (env["obj"].value, R"({"session":"abc"})");
    EXPECT_EQ (env["absent"].value, "undefined");
}

TEST (CookieJarScript, PmCookiesReadsWholeCookiesThroughEachAllAndCount) {
    // get/has/toObject answer about a name or a value; these hand back the
    // cookie, which is the only way a script sees the domain, path or expiry
    // it is actually holding. They read the same matched set, so a cookie for
    // another host stays out of all three.
    CookieJar jar;
    jar.store ("env_a",
    { netscape_line ("example.com", "FALSE", "/", "FALSE",
      std::to_string (FAR_FUTURE), "session", "abc"),
    netscape_line ("example.com", "FALSE", "/admin", "FALSE",
    std::to_string (FAR_FUTURE), "admin", "xyz"),
    netscape_line ("other.example", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "elsewhere", "no") });

    vayu::runtime::ScriptEngine engine;
    vayu::Request request = get_request ("http://example.com/admin/users");
    vayu::Response response;
    vayu::Environment env;

    vayu::runtime::ScriptContext ctx;
    ctx.request      = &request;
    ctx.response     = &response;
    ctx.environment  = &env;
    ctx.cookie_jar   = &jar;
    ctx.cookie_scope = "env_a";

    auto result = engine.execute (
    "pm.environment.set('count', String(pm.cookies.count()));"
    "pm.environment.set('all', pm.cookies.all().map(c => "
    "c.name).sort().join(','));"
    "const seen = [];"
    "pm.cookies.each(c => seen.push(c.name + '@' + c.path));"
    "pm.environment.set('each', seen.sort().join(','));"
    "const one = pm.cookies.all().find(c => c.name === 'session');"
    "pm.environment.set('shape', [one.key, one.value, one.domain, one.path, "
    "one.secure, one.httpOnly, one.hostOnly, one.session, "
    "one.expires.getTime() / 1000].join('|'));"
    // The reads arrive; the flat writers deliberately do not, since a written
    // cookie needs a URL to take its domain and path from. Both docs say so,
    // and nothing said it here until the reads made this object worth adding
    // to by hand.
    "pm.environment.set('writers', ['set', 'unset', 'clear']"
    "  .filter(m => typeof pm.cookies[m] !== 'undefined').join(','));",
    ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["count"].value, "2")
    << "the other host's cookie was counted";
    EXPECT_EQ (env["all"].value, "admin,session");
    EXPECT_EQ (env["each"].value, "admin@/admin,session@/");
    // `key` is Postman's spelling of the name, and `expires` is the Date its
    // Cookie carries - both read by an imported script, and both silently
    // undefined before this.
    EXPECT_EQ (env["shape"].value,
    "session|abc|example.com|/|false|false|true|false|" + std::to_string (FAR_FUTURE));
    EXPECT_EQ (env["writers"].value, "")
    << "a flat writer both docs call absent is reachable from a script";
}

TEST (CookieJarScript, PmCookiesEachReportsAThrowFromItsIterator) {
    // A failed pm.expect inside the iterator is the script's verdict. Swallowed
    // to finish the walk, it would be a test that passed by not being run.
    CookieJar jar;
    jar.store ("env_a",
    { netscape_line ("example.com", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "session", "abc") });

    vayu::runtime::ScriptEngine engine;
    vayu::Request request = get_request ("http://example.com/users");
    vayu::Response response;
    vayu::Environment env;

    vayu::runtime::ScriptContext ctx;
    ctx.request      = &request;
    ctx.response     = &response;
    ctx.environment  = &env;
    ctx.cookie_jar   = &jar;
    ctx.cookie_scope = "env_a";

    auto thrown = engine.execute (
    "pm.cookies.each(() => { throw new Error('from the iterator'); });", ctx);
    EXPECT_FALSE (thrown.success);
    EXPECT_NE (thrown.error_message.find ("from the iterator"), std::string::npos)
    << thrown.error_message;

    auto no_function = engine.execute ("pm.cookies.each('nope');", ctx);
    EXPECT_FALSE (no_function.success);
    EXPECT_NE (no_function.error_message.find ("needs a function"), std::string::npos)
    << no_function.error_message;
}

TEST (CookieJarScript, PmCookiesSaysWhyWhenThereIsNoJar) {
    // A load run's test scripts land here. An empty answer would read as "the
    // cookie is gone" and send someone hunting the wrong bug.
    vayu::runtime::ScriptEngine engine;
    vayu::Request request = get_request ("http://example.com/users");
    vayu::Response response;
    vayu::Environment env;

    vayu::runtime::ScriptContext ctx;
    ctx.request     = &request;
    ctx.response    = &response;
    ctx.environment = &env;

    auto result = engine.execute ("pm.cookies.get('session');", ctx);
    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("design-mode"), std::string::npos)
    << "the error does not say why there is no jar: " << result.error_message;
}

// The read-only per-VU view an inline load-run script gets instead of a jar
// (issue #1501): no CookieJar object, just the lines a virtual user is
// carrying. Mutation check: stop reading `cookie_read_lines` in
// `jar_cookies_from_context` and this reds with the "design-mode" refusal
// `PmCookiesSaysWhyWhenThereIsNoJar` asserts above.
TEST (CookieJarScript, PmCookiesReadsAPerVuViewWithNoJarObject) {
    vayu::runtime::ScriptEngine engine;
    vayu::Request request = get_request ("http://example.com/users");
    vayu::Response response;
    vayu::Environment env;

    JarCookie cookie;
    cookie.name   = "session";
    cookie.value  = "abc123";
    cookie.domain = "example.com";
    cookie.path   = "/";
    const std::vector<std::string> lines{ vayu::http::format_cookie_line (cookie) };

    vayu::runtime::ScriptContext ctx;
    ctx.request           = &request;
    ctx.response          = &response;
    ctx.environment       = &env;
    ctx.cookie_read_lines = &lines;

    auto result = engine.execute (
    "pm.environment.set('got', pm.cookies.get('session'));"
    "pm.environment.set('has', String(pm.cookies.has('session')));",
    ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["got"].value, "abc123");
    EXPECT_EQ (env["has"].value, "true");
}

// The per-VU view is read-only: `pm.cookies.jar()` still needs a real jar,
// exactly as with no cookie access at all - a load run's cookie state
// advances through the VU itself, never through a script.
TEST (CookieJarScript, PmCookiesJarStillRefusesWritesWithAPerVuView) {
    vayu::runtime::ScriptEngine engine;
    vayu::Request request = get_request ("http://example.com/users");
    vayu::Response response;
    vayu::Environment env;
    const std::vector<std::string> lines;

    vayu::runtime::ScriptContext ctx;
    ctx.request           = &request;
    ctx.response          = &response;
    ctx.environment       = &env;
    ctx.cookie_read_lines = &lines;

    auto result = engine.execute (
    "pm.cookies.jar().set('http://example.com/', { name: 'n', value: 'v' });", ctx);
    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("design-mode"), std::string::npos)
    << "a per-VU read view must not also unlock jar() writes: " << result.error_message;
}

// The single-request load run and the deferred replay each have a truer
// reason than "design-mode feature" (issue #1501); `run_manager.cpp` sets
// this per context. Asserted here as the plumbing that carries whatever
// message a caller sets, rather than pinned to run_manager's exact wording,
// so the two do not have to be kept in lockstep by hand.
TEST (CookieJarScript, PmCookiesReadRefusalIsWhateverTheContextSays) {
    vayu::runtime::ScriptEngine engine;
    vayu::Request request = get_request ("http://example.com/users");
    vayu::Response response;
    vayu::Environment env;

    vayu::runtime::ScriptContext ctx;
    ctx.request     = &request;
    ctx.response    = &response;
    ctx.environment = &env;
    ctx.cookie_read_refusal =
    "pm.cookies.%s is not available here: a "
    "replayed script runs after the run, against a recorded response; the "
    "user's cookies at that moment are not recorded.";

    auto result = engine.execute ("pm.cookies.get('session');", ctx);
    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("not recorded"), std::string::npos)
    << "the context's own refusal text did not reach the thrown message: "
    << result.error_message;
    EXPECT_EQ (result.error_message.find ("design-mode"), std::string::npos)
    << "the default message leaked through instead of the context's own: "
    << result.error_message;
}

TEST (CookieJarScript, SendRequestSharesTheJarWithTheRequestAroundIt) {
    // The flow the jar exists for: log in from a pre-request script, then let
    // the request that follows carry the session. An isolated auxiliary jar
    // would leave `sent` empty here.
    CookieServer server;
    CookieJar jar;

    vayu::runtime::ScriptConfig config;
    config.allow_send_request = true;
    vayu::runtime::ScriptEngine engine (config);

    vayu::Request request = get_request (server.url ("/echo"));
    vayu::Environment env;

    vayu::runtime::ScriptContext ctx =
    vayu::runtime::ScriptContext::for_prerequest (request);
    ctx.environment  = &env;
    ctx.cookie_jar   = &jar;
    ctx.cookie_scope = "env_a";

    auto result = engine.execute ("pm.sendRequest('" + server.url ("/login") +
    "', function (err, res) { pm.environment.set('login', String(res.code)); "
    "});"
    "pm.environment.set('seen', String(pm.cookies.get('session')));",
    ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["login"].value, "200");
    EXPECT_EQ (env["seen"].value, "abc123")
    << "the auxiliary request's cookie did not reach the jar the script reads";

    const std::string sent = send_in_scope (jar, "env_a", server.url ("/echo"));
    EXPECT_NE (sent.find ("session=abc123"), std::string::npos)
    << "the request after the script did not carry the session; got: " << sent;
}

// ============================================================================
// The write half - pm.cookies.jar() (issue #337)
//
// The assertions that matter here are on the *wire*, for the same reason the
// isolation test is: a written cookie's failure mode is not "nothing was
// stored", it is "it was stored and is now being sent somewhere it should not
// go". Only the receiving end can answer that.
// ============================================================================

namespace {

/// What `send_after_script` observed, so a test can assert on the script and
/// on the wire without two helpers.
struct ScriptedSend {
    bool script_ok = true;
    std::string script_error;
    /// The Cookie header the server saw, for the /echo endpoint.
    std::string echoed;
    /// The transfer's own outbound header frame (issue #339).
    std::string raw_request;
};

/// The route's sequence in miniature (execution.cpp): run a pre-request script
/// that may stage jar writes, then send the request those writes were made
/// before - the transfer carries them and its capture is what persists them.
/// The send happens even when the script failed, exactly as the route's does.
ScriptedSend send_after_script (CookieJar& jar,
const std::string& scope,
const std::string& script,
const std::string& url,
vayu::Environment& env) {
    vayu::runtime::ScriptConfig script_config;
    script_config.allow_send_request = true;
    vayu::runtime::ScriptEngine engine (script_config);

    vayu::Request request = get_request (url);
    std::vector<vayu::http::CookieWrite> writes;

    vayu::runtime::ScriptContext ctx =
    vayu::runtime::ScriptContext::for_prerequest (request);
    ctx.environment   = &env;
    ctx.cookie_jar    = &jar;
    ctx.cookie_scope  = scope;
    ctx.cookie_writes = &writes;

    const auto result = engine.execute (script, ctx);

    ClientConfig config;
    config.cookie_jar    = &jar;
    config.cookie_scope  = scope;
    config.cookie_writes = std::move (writes);
    Client client (config);
    const auto response = client.send (request).value ();
    return { result.success, result.error_message, response.body, response.raw_request };
}

/// The same, for a script with no send after it - a post-request script's
/// writes, which the route applies itself.
std::string apply_after_script (CookieJar& jar,
const std::string& scope,
const std::string& script,
const std::string& url,
vayu::Environment& env) {
    vayu::runtime::ScriptEngine engine;
    vayu::Request request = get_request (url);
    vayu::Response response;
    std::vector<vayu::http::CookieWrite> writes;

    vayu::runtime::ScriptContext ctx;
    ctx.request       = &request;
    ctx.response      = &response;
    ctx.environment   = &env;
    ctx.cookie_jar    = &jar;
    ctx.cookie_scope  = scope;
    ctx.cookie_writes = &writes;

    const auto result = engine.execute (script, ctx);
    jar.apply (scope, writes);
    return result.error_message;
}

} // namespace

TEST (CookieJarWrite, ACookieAScriptSetIsOnTheWireOfTheRequestItWasSetFor) {
    // The write is staged, not applied where it is made - so this is also the
    // test that it rides the transfer it was made before rather than only
    // reaching the one after.
    CookieServer server;
    CookieJar jar;
    vayu::Environment env;

    const auto sent = send_after_script (jar, "env_a",
    "pm.cookies.jar().set('" + server.url ("/") + "', { name: 'session', value: 'written' });",
    server.url ("/echo"), env);

    ASSERT_TRUE (sent.script_ok) << sent.script_error;
    EXPECT_NE (sent.echoed.find ("session=written"), std::string::npos)
    << "the cookie the script set did not go out; got: " << sent.echoed;

    // And it survived the transfer's capture, so the next request has it too.
    EXPECT_NE (send_in_scope (jar, "env_a", server.url ("/echo")).find ("session=written"),
    std::string::npos)
    << "the write did not survive the enclosing transfer's capture";

    // The raw-request view reads that transfer's own header frame (#339), so a
    // written cookie shows up there for free - the claim the architecture doc
    // now makes about the two features meeting.
    EXPECT_NE (sent.raw_request.find ("session=written"), std::string::npos)
    << "the raw-request view did not show the written cookie; got: " << sent.raw_request;
}

TEST (CookieJarWrite, JarGetAllAnswersEveryCookieTheUrlWouldCarry) {
    // The same walk get() makes, without a name to narrow it - so it sees a
    // cookie this script has just staged, and does not see one stored for the
    // same site under a path the URL would not carry.
    CookieJar jar;
    jar.store ("env_a",
    { netscape_line ("example.com", "FALSE", "/", "FALSE",
      std::to_string (FAR_FUTURE), "session", "abc"),
    netscape_line ("example.com", "FALSE", "/admin", "FALSE",
    std::to_string (FAR_FUTURE), "admin_only", "no") });
    vayu::Environment env;

    const std::string error = apply_after_script (jar, "env_a",
    "const jar = pm.cookies.jar();"
    "jar.set('http://example.com/', { name: 'fresh', value: 'v' });"
    "const all = jar.getAll('http://example.com/');"
    "pm.environment.set('names', all.map(c => c.name).sort().join(','));"
    "jar.getAll('http://example.com/', (err, cookies) => {"
    "  pm.environment.set('cb', String(err) + ':' + cookies.length);"
    "});"
    "pm.environment.set('other_path', "
    "String(jar.getAll('http://example.com/other').map(c => "
    "c.name).sort().join(',')));",
    "http://example.com/users", env);

    ASSERT_EQ (error, "");
    EXPECT_EQ (env["names"].value, "fresh,session")
    << "getAll did not see the cookie staged two lines above it";
    EXPECT_EQ (env["cb"].value, "null:2");
    EXPECT_EQ (env["other_path"].value, "fresh,session")
    << "getAll answered with cookies the URL would not have carried";
}

TEST (CookieJarWrite, TheWriteCallbacksCarryWhatTheCallStored) {
    // Postman's (error, cookie). The stored cookie is the one thing the call
    // knows and the script does not: the domain and path it took from the URL
    // where the object left them out.
    CookieJar jar;
    vayu::Environment env;

    const std::string error = apply_after_script (jar, "env_a",
    "const jar = pm.cookies.jar();"
    "const stored = jar.set('http://example.com/v1/orders/42', "
    "  { name: 'session', value: 'abc' }, (err, cookie) => {"
    "    pm.environment.set('set_cb', "
    "      [String(err), cookie.name, cookie.domain, cookie.path].join('|'));"
    "  });"
    "pm.environment.set('set_ret', "
    "  [stored.key, stored.value, String(stored.session)].join('|'));"
    "const removed = jar.unset('http://example.com/', 'session', (err, name) "
    "=> {"
    "  pm.environment.set('unset_cb', String(err) + '|' + name);"
    "});"
    "pm.environment.set('unset_ret', removed);",
    "http://example.com/users", env);

    ASSERT_EQ (error, "");
    EXPECT_EQ (env["set_cb"].value, "null|session|example.com|/v1/orders");
    EXPECT_EQ (env["set_ret"].value, "session|abc|true");
    EXPECT_EQ (env["unset_cb"].value, "null|session");
    EXPECT_EQ (env["unset_ret"].value, "session");
}

TEST (CookieJarWrite, TheFlatPostmanSpellingSetsTheSameCookie) {
    CookieServer server;
    CookieJar jar;
    vayu::Environment env;

    const auto sent = send_after_script (jar, "env_a",
    "pm.cookies.jar().set('" + server.url ("/") + "', 'session', 'flat');",
    server.url ("/echo"), env);

    ASSERT_TRUE (sent.script_ok) << sent.script_error;
    EXPECT_NE (sent.echoed.find ("session=flat"), std::string::npos)
    << "got: " << sent.echoed;
}

TEST (CookieJarWrite, AWrittenCookieIsMatchedByTheSameRulesAReceivedOneIs) {
    // The write half must not be a way around the matching the read half
    // respects - a cookie written for one host, path or scheme must not leak
    // onto a request that does not match it.
    CookieServer server;
    vayu::Environment env;

    // The write scope (#2631) refuses this one before matching ever runs; what
    // is asserted is only that nothing for example.com reaches the transfer.
    CookieJar other_host;
    const auto wrong_host = send_after_script (other_host,
    "env_a", "pm.cookies.jar().set('https://example.com/', { name: 'session', value: 'x' });",
    server.url ("/echo"), env);
    ASSERT_TRUE (wrong_host.script_ok) << wrong_host.script_error;
    EXPECT_EQ (wrong_host.echoed, "")
    << "a cookie written for another host was sent: " << wrong_host.echoed;

    CookieJar wrong_path_jar;
    const auto wrong_path = send_after_script (wrong_path_jar, "env_a",
    "pm.cookies.jar().set('" + server.url ("/") + "', { name: 'session', value: 'x', path: '/admin' });",
    server.url ("/echo"), env);
    ASSERT_TRUE (wrong_path.script_ok) << wrong_path.script_error;
    EXPECT_EQ (wrong_path.echoed, "")
    << "a cookie written for /admin was sent to /echo: " << wrong_path.echoed;
}

TEST (CookieJarWrite, ASecureFlagOnAWrittenCookieIsStoredAndHonouredByTheReadViews) {
    // Asserted through the read views rather than the wire, because the wire
    // cannot show it from a test: libcurl treats a loopback host as a
    // trustworthy origin (RFC 6265bis §4.1.2.5), so it sends a Secure cookie
    // to http://127.0.0.1 *by design*. What is testable here is that the flag
    // survives the write at all - a set() that dropped it would produce a
    // cookie that then goes to any cleartext host.
    CookieServer server;
    CookieJar jar;
    vayu::Environment env;

    const auto sent = send_after_script (jar, "env_a",
    "pm.cookies.jar().set('" + server.url ("/") + "', { name: 'session', value: 'x', secure: true });",
    server.url ("/echo"), env);
    ASSERT_TRUE (sent.script_ok) << sent.script_error;

    const auto held = vayu::http::routes::cookies_response (jar);
    ASSERT_EQ (held["scopes"].size (), 1u);
    ASSERT_EQ (held["scopes"][0]["cookies"].size (), 1u);
    EXPECT_EQ (held["scopes"][0]["cookies"][0]["secure"], true)
    << "the Secure flag did not survive the write";

    // And the matcher behind pm.cookies agrees with the wire: a loopback host
    // is a trustworthy origin, so the cookie matches over http as well.
    const std::string host = "127.0.0.1";
    EXPECT_FALSE (jar.matching ("env_a", "http://" + host + "/").empty ());
    EXPECT_FALSE (jar.matching ("env_a", "https://" + host + "/").empty ());
}

TEST (CookieJarWrite, AWriteSurvivesTheEnclosingTransfersCapture) {
    // The ordering decision this whole surface turns on. The staged write rides
    // the transfer, which /logout ends by expiring the session; the capture has
    // to persist the write as one of that transfer's changes and still drop
    // the session.
    CookieServer server;
    CookieJar jar;
    vayu::Environment env;

    send_in_scope (jar, "env_a", server.url ("/login"));

    const auto sent = send_after_script (jar, "env_a",
    "pm.cookies.jar().set('" + server.url ("/") + "', { name: 'kept', value: 'yes' });",
    server.url ("/logout"), env);
    ASSERT_TRUE (sent.script_ok) << sent.script_error;

    const std::string after = send_in_scope (jar, "env_a", server.url ("/echo"));
    EXPECT_NE (after.find ("kept=yes"), std::string::npos)
    << "the staged write was discarded by the transfer's capture; got: " << after;
    EXPECT_EQ (after.find ("session="), std::string::npos)
    << "the logout's expiry stopped working; got: " << after;
}

TEST (CookieJarWrite, AStagedWriteAndAnOverlappingTransfersCookieBothSurvive) {
    // The write rides a transfer that overlaps another in the same scope
    // (issue #1888): it must persist, the other's cookie must too, and the
    // logout it rode must still take the session.
    CookieServer server;
    CookieJar jar;
    send_in_scope (jar, "env_a", server.url ("/login"));

    vayu::http::CookieWrite write;
    write.line = netscape_line ("127.0.0.1", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "kept", "yes");
    auto scripted = seed_transfer (jar, "env_a", server.url ("/logout"), { write });
    auto other = seed_transfer (jar, "env_a", server.url ("/set/beta"));
    finish_transfer (other, jar);
    finish_transfer (scripted, jar);

    const std::string echoed = send_in_scope (jar, "env_a", server.url ("/echo"));
    EXPECT_NE (echoed.find ("kept=yes"), std::string::npos)
    << "the staged write did not persist: " << echoed;
    EXPECT_NE (echoed.find ("beta=beta-value"), std::string::npos)
    << "the overlapping transfer's cookie was dropped: " << echoed;
    EXPECT_EQ (echoed.find ("session="), std::string::npos) << echoed;
}

TEST (CookieJarWrite, AStagedClearTakesOnlyWhatItsTransferWasSeededWith) {
    // `jar.clear()` before a send empties the scope that send saw; a cookie
    // an overlapping transfer stored meanwhile was never in it.
    CookieServer server;
    CookieJar jar;
    send_in_scope (jar, "env_a", server.url ("/login"));

    vayu::http::CookieWrite clear;
    clear.kind = vayu::http::CookieWrite::Kind::Clear;
    auto scripted = seed_transfer (jar, "env_a", server.url ("/echo"), { clear });
    auto other = seed_transfer (jar, "env_a", server.url ("/set/beta"));
    finish_transfer (other, jar);
    finish_transfer (scripted, jar);

    const std::string echoed = send_in_scope (jar, "env_a", server.url ("/echo"));
    EXPECT_EQ (echoed.find ("session="), std::string::npos)
    << "the staged clear did not persist: " << echoed;
    EXPECT_NE (echoed.find ("beta=beta-value"), std::string::npos)
    << "the clear took a cookie its transfer never saw: " << echoed;
}

TEST (CookieJarWrite, SendRequestCarriesAWriteStagedBeforeIt) {
    // The queue applies before an auxiliary transfer injects, so a login call
    // made through pm.sendRequest after a set() carries what was set.
    CookieServer server;
    CookieJar jar;
    vayu::Environment env;

    const auto sent = send_after_script (jar, "env_a",
    "pm.cookies.jar().set('" + server.url ("/") +
    "', { name: 'staged', value: 'first' });"
    "pm.sendRequest('" +
    server.url ("/echo") + "', function (err, res) { pm.environment.set('aux', res.text()); });",
    server.url ("/echo"), env);

    ASSERT_TRUE (sent.script_ok) << sent.script_error;
    EXPECT_NE (env["aux"].value.find ("staged=first"), std::string::npos)
    << "the auxiliary transfer did not carry the staged write; got: "
    << env["aux"].value;
    // And it is not applied twice: the main request still has it, once.
    EXPECT_NE (sent.echoed.find ("staged=first"), std::string::npos)
    << "got: " << sent.echoed;
}

TEST (CookieJarWrite, ASetInsideASendRequestCallbackIsASequentialWrite) {
    // pm.sendRequest is synchronous, so a callback runs *after* its transfer
    // finished - a set() there cannot reach that transfer, and lands on the
    // next one. Pinned rather than assumed, since the opposite reading is
    // exactly what an async mental model would predict.
    CookieServer server;
    CookieJar jar;
    vayu::Environment env;

    const auto sent = send_after_script (jar, "env_a",
    "pm.sendRequest('" + server.url ("/echo") +
    "', function (err, res) {"
    "  pm.environment.set('aux', res.text());"
    "  pm.cookies.jar().set('" +
    server.url ("/") +
    "', { name: 'late', value: 'yes' });"
    "});",
    server.url ("/echo"), env);

    ASSERT_TRUE (sent.script_ok) << sent.script_error;
    EXPECT_EQ (env["aux"].value.find ("late=yes"), std::string::npos)
    << "the callback's write reached the transfer it ran after: " << env["aux"].value;
    EXPECT_NE (sent.echoed.find ("late=yes"), std::string::npos)
    << "the callback's write did not reach the request that followed; got: "
    << sent.echoed;
}

TEST (CookieJarWrite, AReadSeesThisScriptsOwnStagedWrite) {
    // Otherwise `set` followed by `get` reports the value the write replaced,
    // which reads as "the write did not happen".
    CookieJar jar;
    vayu::Environment env;

    const std::string error = apply_after_script (jar, "env_a",
    "pm.cookies.jar().set('http://example.com/', { name: 'session', value: "
    "'fresh' });"
    "pm.environment.set('jar_get', "
    "String(pm.cookies.jar().get('http://example.com/', 'session')));"
    "pm.environment.set('flat_get', String(pm.cookies.get('session')));",
    "http://example.com/users", env);

    EXPECT_TRUE (error.empty ()) << error;
    EXPECT_EQ (env["jar_get"].value, "fresh");
    EXPECT_EQ (env["flat_get"].value, "fresh")
    << "the flat read half did not see the write staged beside it";
}

TEST (CookieJarWrite, UnsetRemovesOnlyWhatTheUrlWouldHaveCarried) {
    CookieJar jar;
    vayu::Environment env;
    jar.store ("env_a",
    { netscape_line ("example.com", "FALSE", "/", "FALSE",
      std::to_string (FAR_FUTURE), "session", "here"),
    netscape_line ("other.example.org", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "session", "elsewhere") });

    const std::string error = apply_after_script (jar, "env_a",
    "pm.cookies.jar().unset('http://example.com/', 'session');",
    "http://example.com/users", env);
    EXPECT_TRUE (error.empty ()) << error;

    EXPECT_TRUE (jar.matching ("env_a", "http://example.com/users").empty ());
    const auto elsewhere = jar.matching ("env_a", "http://other.example.org/users");
    ASSERT_EQ (elsewhere.size (), 1u)
    << "unset removed a cookie of the same name on another host";
    EXPECT_EQ (elsewhere[0].value, "elsewhere");
}

TEST (CookieJarWrite, ClearEmptiesOnlyThisEnvironmentsJar) {
    CookieJar jar;
    vayu::Environment env;
    const auto line = netscape_line ("example.com", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "session", "abc");
    jar.store ("env_a", { line });
    jar.store ("env_b", { line });

    const std::string error = apply_after_script (
    jar, "env_a", "pm.cookies.jar().clear();", "http://example.com/users", env);
    EXPECT_TRUE (error.empty ()) << error;

    const auto scopes = jar.snapshot ();
    ASSERT_EQ (scopes.size (), 1u)
    << "clear() reached beyond its own environment";
    const auto& survivor = scopes[0].environment_id;
    ASSERT_HAS_VALUE (survivor);
    EXPECT_EQ (*survivor, "env_b");
}

TEST (CookieJarWrite, ClearWithAUrlRemovesOnlyThatUrlsCookies) {
    // Postman's spelling, which used to be a TypeError *and* a whole-jar wipe
    // (issue #997). Scoped exactly as unset is, minus the name filter.
    CookieJar jar;
    vayu::Environment env;
    jar.store ("env_a",
    { netscape_line ("example.com", "FALSE", "/", "FALSE",
      std::to_string (FAR_FUTURE), "session", "here"),
    netscape_line ("example.com", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "csrf", "here-too"),
    netscape_line ("other.example.org", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "session", "elsewhere") });

    const std::string error = apply_after_script (jar, "env_a",
    "pm.cookies.jar().clear('http://example.com/', function (err) {"
    "  pm.environment.set('err', String(err)); });",
    "http://example.com/users", env);
    EXPECT_TRUE (error.empty ()) << error;
    EXPECT_EQ (env["err"].value, "null")
    << "the per-URL clear did not invoke its callback with (null)";

    EXPECT_TRUE (jar.matching ("env_a", "http://example.com/users").empty ())
    << "the URL's own cookies survived the clear";
    const auto elsewhere = jar.matching ("env_a", "http://other.example.org/users");
    ASSERT_EQ (elsewhere.size (), 1u)
    << "clear(url) reached a cookie stored for another host";
    EXPECT_EQ (elsewhere[0].value, "elsewhere");
}

TEST (CookieJarWrite, NoJarMethodStagesItsWriteBeforeItsArgumentsValidate) {
    // The #997 regression, and the rule it teaches. Each of these fails
    // validation *after* the argument that decides what would be staged, so a
    // method that staged first would leave a write behind that then rode the
    // next transfer - the script seeing only an error that points elsewhere.
    //
    // Mutation check: move any of the three `classify_jar_callback` calls back
    // below its `writes->push_back` and this reddens on a wiped survivor.
    const auto seeded = [] (const std::string& domain, const std::string& value) {
        return netscape_line (domain, "FALSE", "/", "FALSE",
        std::to_string (FAR_FUTURE), "session", value);
    };

    const auto cases = std::to_array<const char*> ({
    "pm.cookies.jar().clear('http://example.com/', 'not a function');",
    "pm.cookies.jar().unset('http://example.com/', 'session', 'nope');",
    "pm.cookies.jar().set('http://example.com/', { name: 'session', value: "
    "'new' }, 'not a function');",
    // The original report: a URL where the whole-jar clear expected its
    // callback. It must not wipe the environment on its way to the error.
    "pm.cookies.jar().clear(pm.request.url, 42);",
    });

    for (const char* script : cases) {
        CookieJar jar;
        vayu::Environment env;
        jar.store ("env_a",
        { seeded ("example.com", "here"), seeded ("other.example.org", "elsewhere") });

        const std::string error =
        apply_after_script (jar, "env_a", script, "http://example.com/users", env);
        EXPECT_NE (error.find ("callback must be a function"), std::string::npos)
        << "script: " << script << "\ngot: " << error;

        const auto named = jar.matching ("env_a", "http://example.com/users");
        ASSERT_EQ (named.size (), 1u)
        << "a refused call staged its write anyway: " << script;
        EXPECT_EQ (named[0].value, "here")
        << "a refused set replaced the value anyway: " << script;
        EXPECT_EQ (jar.matching ("env_a", "http://other.example.org/x").size (), 1u)
        << "a refused call wiped a cookie it never named: " << script;
    }
}

TEST (CookieJarWrite, AWrittenCookieDoesNotCrossAnEnvironmentBoundary) {
    // The isolation guarantee has to hold for written cookies too, or the
    // write half becomes the way a staging session reaches production.
    CookieServer server;
    CookieJar jar;
    vayu::Environment env;

    const auto sent = send_after_script (jar, "env_staging",
    "pm.cookies.jar().set('" + server.url ("/") + "', { name: 'session', value: 'staging' });",
    server.url ("/echo"), env);
    ASSERT_TRUE (sent.script_ok) << sent.script_error;

    EXPECT_EQ (send_in_scope (jar, "env_production", server.url ("/echo")), "")
    << "a script-written cookie leaked out of its environment";
}

TEST (CookieJarWrite, AScriptWrittenCookieShowsUpInTheSettingsPanelsView) {
    // The app needs no change for this - CookiesCard renders whatever
    // GET /cookies reports - but "no change needed" is a claim worth pinning.
    CookieServer server;
    CookieJar jar;
    vayu::Environment env;

    const auto sent = send_after_script (jar, "env_a",
    "pm.cookies.jar().set('" + server.url ("/") + "', { name: 'written', value: 'v', httpOnly: true });",
    server.url ("/echo"), env);
    ASSERT_TRUE (sent.script_ok) << sent.script_error;

    const auto body = vayu::http::routes::cookies_response (jar);
    ASSERT_EQ (body["scopes"].size (), 1u);
    ASSERT_EQ (body["scopes"][0]["cookies"].size (), 1u);
    EXPECT_EQ (body["scopes"][0]["cookies"][0]["name"], "written");
    EXPECT_EQ (body["scopes"][0]["cookies"][0]["httpOnly"], true);
}

TEST (CookieJarWrite, BadInputIsRefusedLoudlyRatherThanStoredWrong) {
    CookieJar jar;
    vayu::Environment env;

    struct Case {
        const char* script;
        const char* expected;
    };
    const auto cases = std::to_array<Case> ({
    { "pm.cookies.jar().set('http://example.com/', { value: 'v' });", "name" },
    { "pm.cookies.jar().set('http://example.com/', { name: 'n', value: 1 "
      "});",
    "value" },
    { "pm.cookies.jar().set('http://example.com/', { name: 'n', value: "
      "'v', secure: 'yes' });",
    "true or false" },
    // A date string is accepted now (see ExpiresTakesADateADateStringOrWholeSeconds);
    // one Date.parse cannot read still is not, because the alternative is a
    // cookie that expires in 1970 and is simply never sent again.
    { "pm.cookies.jar().set('http://example.com/', { name: 'n', value: "
      "'v', expires: 'the day after tomorrow' });",
    "not a date this engine can read" },
    // A tab is the Netscape line's own separator: stored, the cookie would
    // be unreadable on the next parse and would simply vanish.
    { "pm.cookies.jar().set('http://example.com/', { name: 'n', value: "
      "'a\\tb' });",
    "tab or newline" },
    { "pm.cookies.jar().set('not a url', { name: 'n', value: 'v' });", "parseable" },
    { "pm.cookies.jar().set();", "URL string" },
    { "pm.cookies.jar().unset('http://example.com/');", "cookie name string" },
    // A clear is destructive, so a string that is not a URL is refused
    // rather than staged as a wipe that quietly matches nothing.
    { "pm.cookies.jar().clear('nope');", "could not scope" },
    { "pm.cookies.jar().clear(42);", "callback must be a function" },
    });

    for (const auto& one : cases) {
        vayu::Environment scratch = env;
        const std::string error   = apply_after_script (
        jar, "env_a", one.script, "http://example.com/users", scratch);
        EXPECT_NE (error.find (one.expected), std::string::npos)
        << "script: " << one.script << "\ngot: " << error;
    }
    EXPECT_TRUE (jar.snapshot ().empty ())
    << "a refused write was stored anyway";
}

TEST (CookieJarWriteValue, ExpiresTakesADateADateStringOrWholeSeconds) {
    // One instant, three spellings. They must agree: a script writing a Date
    // and a script writing Math.floor(t / 1000) are describing the same
    // expiry, and a jar that stored them differently would expire one session
    // and not the other. The Date and the string are read by QuickJS's own
    // Date, so they answer as the script's own `new Date(s)` would.
    CookieJar jar;
    vayu::Environment env;

    const std::string error = apply_after_script (jar, "env_a",
    "const url = 'http://example.com/';"
    "const when = new Date(Date.UTC(2100, 0, 1, 0, 0, 0));"
    "const jar = pm.cookies.jar();"
    "jar.set(url, { name: 'a', value: '1', expires: when });"
    "jar.set(url, { name: 'b', value: '1', expires: '2100-01-01T00:00:00Z' });"
    "jar.set(url, { name: 'c', value: '1', expires: "
    "  Math.floor(when.getTime() / 1000) });"
    "const seen = {};"
    "for (const c of jar.getAll(url)) seen[c.name] = "
    "String(c.expires.getTime() / 1000);"
    "pm.environment.set('a', seen.a);"
    "pm.environment.set('b', seen.b);"
    "pm.environment.set('c', seen.c);",
    "http://example.com/users", env);

    ASSERT_EQ (error, "");
    EXPECT_EQ (env["a"].value, std::to_string (FAR_FUTURE));
    EXPECT_EQ (env["b"].value, env["a"].value)
    << "a date string disagreed with the Date";
    EXPECT_EQ (env["c"].value, env["a"].value)
    << "seconds disagreed with the Date";
}

TEST (CookieJarWriteValue, AnExpiresThatNamesNoInstantIsRefusedRatherThanStored) {
    CookieJar jar;
    vayu::Environment env;

    struct Case {
        const char* expires;
        const char* expected;
    };
    const auto cases = std::to_array<Case> ({
    { "new Date('nope')", "Invalid Date" },
    { "'the day after tomorrow'", "not a date this engine can read" },
    // `getTime() / 1000` without the floor. Truncated silently it would be a
    // whole second off in a surface that otherwise refuses rather than
    // guesses; the message names both cures.
    { "new Date(Date.UTC(2100, 0, 1, 0, 0, 0, 500)).getTime() / 1000", "not a whole number of seconds" },
    { "true", "a Date, or a date string" },
    { "-1", "before the epoch" },
    { "1e30", "further in the future than the jar can store" },
    });

    for (const auto& one : cases) {
        vayu::Environment scratch = env;
        const std::string script =
        std::string ("pm.cookies.jar().set('http://example.com/', { name: 'n', "
                     "value: 'v', expires: ") +
        one.expires + " });";
        const std::string error =
        apply_after_script (jar, "env_a", script, "http://example.com/users", scratch);
        EXPECT_NE (error.find (one.expected), std::string::npos)
        << "script: " << script << "\ngot: " << error;
    }
    EXPECT_TRUE (jar.snapshot ().empty ())
    << "a refused expiry was stored anyway";
}

TEST (CookieJarWrite, TheWriteHalfSaysWhyWhenThereIsNoJarAndWhenThereIsNowhereToApply) {
    vayu::runtime::ScriptEngine engine;
    vayu::Request request = get_request ("http://example.com/users");
    vayu::Response response;
    vayu::Environment env;

    // A load run: no jar at all.
    vayu::runtime::ScriptContext no_jar;
    no_jar.request     = &request;
    no_jar.response    = &response;
    no_jar.environment = &env;
    auto result        = engine.execute (
    "pm.cookies.jar().set('http://example.com/', { name: 'n', value: 'v' });", no_jar);
    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("design-mode"), std::string::npos)
    << result.error_message;

    // A jar, but a caller that never applies what is written to it - accepting
    // the write would report success for a cookie that goes nowhere.
    CookieJar jar;
    vayu::runtime::ScriptContext no_sink;
    no_sink.request     = &request;
    no_sink.response    = &response;
    no_sink.environment = &env;
    no_sink.cookie_jar  = &jar;
    result              = engine.execute (
    "pm.cookies.jar().set('http://example.com/', { name: 'n', value: 'v' });", no_sink);
    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("nowhere to apply"), std::string::npos)
    << result.error_message;

    // The read half of jar() needs no sink - it is a read.
    result = engine.execute (
    "pm.environment.set('r', "
    "String(pm.cookies.jar().get('http://example.com/', 'n')));",
    no_sink);
    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["r"].value, "undefined");
}

TEST (CookieJarWrite, TheCallbackIsInvokedAndItsThrowIsTheScriptsError) {
    CookieJar jar;
    vayu::Environment env;

    const std::string ok = apply_after_script (jar, "env_a",
    "pm.cookies.jar().set('http://example.com/', { name: 'n', value: 'v' },"
    "  function (err) { pm.environment.set('err', String(err)); });"
    "pm.cookies.jar().get('http://example.com/', 'n',"
    "  function (err, value) { pm.environment.set('value', String(value)); });",
    "http://example.com/users", env);
    EXPECT_TRUE (ok.empty ()) << ok;
    EXPECT_EQ (env["err"].value, "null") << "the callback was not invoked";
    EXPECT_EQ (env["value"].value, "v");

    const std::string threw = apply_after_script (jar,
    "env_a", "pm.cookies.jar().clear(function () { throw new Error('from the callback'); });",
    "http://example.com/users", env);
    EXPECT_NE (threw.find ("from the callback"), std::string::npos)
    << "a throwing callback was swallowed: " << threw;
}

// ============================================================================
// The read scope - pm.cookies.jar().get / getAll reach the request's site and
// the hosts the script has called, nothing else (issue #2358)
// ============================================================================

namespace {

/// Run @p script as the pre-request script of a request to @p request_url,
/// with @p jar in scope "env_a" and pm.sendRequest allowed.
vayu::ScriptResult run_jar_read (CookieJar& jar,
const std::string& request_url,
const std::string& script,
vayu::Environment& env) {
    vayu::runtime::ScriptConfig config;
    config.allow_send_request = true;
    vayu::runtime::ScriptEngine engine (config);

    vayu::Request request = get_request (request_url);
    vayu::runtime::ScriptContext ctx =
    vayu::runtime::ScriptContext::for_prerequest (request);
    ctx.environment  = &env;
    ctx.cookie_jar   = &jar;
    ctx.cookie_scope = "env_a";
    return engine.execute (script, ctx);
}

std::vector<std::string> warnings_of (const vayu::ScriptResult& result) {
    std::vector<std::string> out;
    for (const auto& entry : result.console_output) {
        if (entry.level == vayu::ConsoleLevel::Warn) {
            out.push_back (entry.message);
        }
    }
    return out;
}

/// One session cookie each for a.test and b.test, in scope "env_a".
void store_two_sites (CookieJar& jar) {
    jar.store ("env_a",
    { netscape_line ("a.test", "FALSE", "/", "FALSE",
      std::to_string (FAR_FUTURE), "session", "from-a"),
    netscape_line ("b.test", "FALSE", "/", "FALSE", std::to_string (FAR_FUTURE),
    "session", "from-b") });
}

} // namespace

TEST (CookieJarReadScope, AReadOfAnotherSiteAnswersNothingAndSaysWhy) {
    CookieJar jar;
    store_two_sites (jar);
    vayu::Environment env;

    const auto result = run_jar_read (jar, "http://a.test/users",
    "const jar = pm.cookies.jar();"
    "pm.environment.set('a_get', String(jar.get('http://a.test/', 'session')));"
    "pm.environment.set('a_all', jar.getAll('http://a.test/').map(c => "
    "c.value).join(','));"
    "pm.environment.set('b_get', String(jar.get('http://b.test/', 'session')));"
    "pm.environment.set('b_all', String(jar.getAll('http://b.test/').length));",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["a_get"].value, "from-a");
    EXPECT_EQ (env["a_all"].value, "from-a");
    EXPECT_EQ (env["b_get"].value, "undefined")
    << "get read a cookie of a site the request is not for";
    EXPECT_EQ (env["b_all"].value, "0")
    << "getAll read cookies of a site the request is not for";

    const auto warned = warnings_of (result);
    ASSERT_EQ (warned.size (), 2u)
    << "one warning per refused read, and none for the request's own site";
    for (const auto& message : warned) {
        EXPECT_NE (message.find ("b.test"), std::string::npos) << message;
        EXPECT_NE (message.find ("a.test"), std::string::npos)
        << "the warning does not name the site reads are limited to: " << message;
        EXPECT_EQ (message.find ("from-b"), std::string::npos)
        << "the warning carries a cookie value: " << message;
    }
}

TEST (CookieJarReadScope, TheCallbackFormGetsTheSameAnswer) {
    CookieJar jar;
    store_two_sites (jar);
    vayu::Environment env;

    const auto result = run_jar_read (jar, "http://a.test/users",
    "const jar = pm.cookies.jar();"
    "jar.get('http://b.test/', 'session', (err, v) => "
    "  pm.environment.set('cb_get', String(err) + ':' + String(v)));"
    "jar.getAll('http://b.test/', (err, list) => "
    "  pm.environment.set('cb_all', String(err) + ':' + list.length));"
    "jar.get('http://a.test/', 'session', (err, v) => "
    "  pm.environment.set('cb_own', String(err) + ':' + String(v)));",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["cb_get"].value, "null:undefined");
    EXPECT_EQ (env["cb_all"].value, "null:0");
    EXPECT_EQ (env["cb_own"].value, "null:from-a");
    EXPECT_EQ (warnings_of (result).size (), 2u);
}

TEST (CookieJarReadScope, AHostTheScriptCalledThroughSendRequestBecomesReadable) {
    // A script that logs in somewhere has earned the right to read what that
    // login set. The server is on 127.0.0.1, a host the request (to a.test)
    // is not for.
    CookieServer server;
    CookieJar jar;
    jar.store ("env_a",
    { netscape_line ("127.0.0.1", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "stored", "before-the-call") });
    vayu::Environment env;

    const auto result = run_jar_read (jar, "http://a.test/users",
    "const jar = pm.cookies.jar();"
    "const root = '" +
    server.url ("/") +
    "';"
    "pm.environment.set('before', String(jar.get(root, 'stored')));"
    "pm.sendRequest(root + 'login', function (err, res) {"
    "  pm.environment.set('login', String(res.code)); });"
    "pm.environment.set('after', String(jar.get(root, 'stored')));"
    "pm.environment.set('set_by_login', String(jar.get(root, 'session')));"
    "pm.environment.set('all', jar.getAll(root).map(c => "
    "c.name).sort().join(','));",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["login"].value, "200");
    EXPECT_EQ (env["before"].value, "undefined")
    << "the host was readable before the script had called it";
    EXPECT_EQ (env["after"].value, "before-the-call");
    EXPECT_EQ (env["set_by_login"].value, "abc123");
    EXPECT_EQ (env["all"].value, "session,stored");
    EXPECT_EQ (warnings_of (result).size (), 1u)
    << "only the read before the call should have been refused";
}

TEST (CookieJarReadScope, ADomainCookieIsReadFromASubdomainRequestAndBack) {
    CookieJar jar;
    jar.store ("env_a",
    { netscape_line (".a.test", "TRUE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "shared", "domain-wide") });
    vayu::Environment env;

    const auto result = run_jar_read (jar, "http://www.a.test/users",
    "const jar = pm.cookies.jar();"
    "pm.environment.set('on_sub', String(jar.get('http://www.a.test/', "
    "'shared')));"
    "pm.environment.set('on_apex', String(jar.get('http://a.test/', "
    "'shared')));"
    "pm.environment.set('other_sub', String(jar.get('http://api.a.test/', "
    "'shared')));",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["on_sub"].value, "domain-wide");
    EXPECT_EQ (env["on_apex"].value, "domain-wide")
    << "the apex of the request's host is the same site";
    // A sibling would carry the cookie on the wire, and is still not this
    // request's site: the scope reads two hosts, not the cookie's reach.
    EXPECT_EQ (env["other_sub"].value, "undefined");
    EXPECT_EQ (warnings_of (result).size (), 1u);
}

TEST (CookieJarReadScope, AnotherRegistrableDomainAndALookalikeAreNotTheSite) {
    CookieJar jar;
    jar.store ("env_a",
    { netscape_line ("a.test", "FALSE", "/", "FALSE",
      std::to_string (FAR_FUTURE), "session", "from-a"),
    netscape_line ("b.test", "FALSE", "/", "FALSE", std::to_string (FAR_FUTURE), "session", "from-b"),
    netscape_line ("evila.test", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "session", "from-lookalike"),
    netscape_line ("127.0.0.1", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "session", "from-ip") });
    vayu::Environment env;

    const auto result = run_jar_read (jar, "http://www.a.test/users",
    "const jar = pm.cookies.jar();"
    "pm.environment.set('other', String(jar.get('http://b.test/', 'session')));"
    "pm.environment.set('lookalike', "
    "  String(jar.get('http://evila.test/', 'session')));"
    "pm.environment.set('ip', String(jar.get('http://127.0.0.1/', "
    "'session')));",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["other"].value, "undefined");
    EXPECT_EQ (env["lookalike"].value, "undefined");
    EXPECT_EQ (env["ip"].value, "undefined");
    EXPECT_EQ (warnings_of (result).size (), 3u);
}

TEST (CookieJarReadScope, TheFlatReadHalfIsNotAffected) {
    CookieJar jar;
    store_two_sites (jar);
    vayu::Environment env;

    const auto result = run_jar_read (jar, "http://a.test/users",
    "pm.environment.set('flat', String(pm.cookies.get('session')));"
    "pm.environment.set('has', String(pm.cookies.has('session')));",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["flat"].value, "from-a");
    EXPECT_EQ (env["has"].value, "true");
    EXPECT_TRUE (warnings_of (result).empty ());
}

// ============================================================================
// The write scope - set / unset / clear(url) reach the same sites reads do
// (issue #2631)
// ============================================================================

namespace {

/// `run_jar_read`, with a sink for the writes and the writes then applied to
/// @p jar, as the route does after a post-request script.
vayu::ScriptResult run_jar_write (CookieJar& jar,
const std::string& request_url,
const std::string& script,
vayu::Environment& env) {
    vayu::runtime::ScriptConfig config;
    config.allow_send_request = true;
    vayu::runtime::ScriptEngine engine (config);

    vayu::Request request = get_request (request_url);
    std::vector<vayu::http::CookieWrite> writes;
    vayu::runtime::ScriptContext ctx =
    vayu::runtime::ScriptContext::for_prerequest (request);
    ctx.environment   = &env;
    ctx.cookie_jar    = &jar;
    ctx.cookie_scope  = "env_a";
    ctx.cookie_writes = &writes;
    const auto result = engine.execute (script, ctx);
    jar.apply ("env_a", writes);
    return result;
}

/// Whether anything in scope "env_a" is stored for @p host, whatever its path.
bool jar_holds_for (const CookieJar& jar, const std::string& host) {
    return !jar.matching ("env_a", "http://" + host + "/").empty ();
}

} // namespace

TEST (CookieJarWriteScope, ADomainOfAnotherSiteIsRefusedWithAPathAndWithout) {
    // The cookie-fixation case: the URL is the request's own, the cookie's
    // Domain is not. With a path the old code returned before reading the URL;
    // without one it never compared the domain to the host.
    CookieJar jar;
    vayu::Environment env;

    const auto result = run_jar_write (jar, "http://a.test/users",
    "const jar = pm.cookies.jar();"
    "jar.set('http://a.test/', { name: 'sid', value: 'attacker', "
    "domain: 'victim.test', path: '/' });"
    "jar.set('http://a.test/', { name: 'sid2', value: 'attacker', "
    "domain: 'victim.test' });"
    "jar.set('http://a.test/', { name: 'sid3', value: 'attacker', "
    "domain: '.victim.test', path: '/' });",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (jar.snapshot ().empty ())
    << "a cookie for another site's domain was stored";
    EXPECT_FALSE (jar_holds_for (jar, "victim.test"));

    const auto warned = warnings_of (result);
    ASSERT_EQ (warned.size (), 3u) << "one warning per refused write";
    for (const auto& message : warned) {
        EXPECT_NE (message.find ("victim.test"), std::string::npos) << message;
        EXPECT_NE (message.find ("a.test"), std::string::npos)
        << "the warning does not name the site writes are limited to: " << message;
        EXPECT_EQ (message.find ("attacker"), std::string::npos)
        << "the warning carries a cookie value: " << message;
        EXPECT_EQ (message.find ("http://"), std::string::npos)
        << "the warning carries a URL: " << message;
    }
}

TEST (CookieJarWriteScope, ADomainIsComparedAsTheJarKeysIt) {
    // Case, a leading dot, a trailing-dot lookalike and a non-ASCII name must
    // not each be a way past a comparison made on the raw text.
    CookieJar jar;
    vayu::Environment env;

    const auto result = run_jar_write (jar, "http://a.test/users",
    "const jar = pm.cookies.jar();"
    "for (const domain of ['VICTIM.test', '.Victim.TEST', 'evila.test', "
    "'bücher.test']) {"
    "  jar.set('http://a.test/', { name: 'sid', value: 'x', domain, path: '/' "
    "});"
    "}",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (jar.snapshot ().empty ())
    << "a spelling of a foreign domain got past the scope";
    EXPECT_EQ (warnings_of (result).size (), 4u);
}

TEST (CookieJarWriteScope, AForeignUrlIsRefusedAndTheCallIsStillANormalNoOp) {
    CookieJar jar;
    vayu::Environment env;

    const auto result = run_jar_write (jar, "http://a.test/users",
    "const jar = pm.cookies.jar();"
    "const stored = jar.set('http://b.test/', { name: 'planted', value: 'v' },"
    "  (err, cookie) => pm.environment.set('cb', String(err) + ':' + "
    "cookie.name));"
    "pm.environment.set('ret', stored.name);"
    "jar.set('http://b.test/', 'flat', 'v');",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (jar.snapshot ().empty ())
    << "a write for another site was staged";
    EXPECT_EQ (env["cb"].value, "null:planted")
    << "a refused write skipped its callback";
    EXPECT_EQ (env["ret"].value, "planted");

    const auto warned = warnings_of (result);
    ASSERT_EQ (warned.size (), 2u);
    for (const auto& message : warned) {
        EXPECT_NE (message.find ("b.test"), std::string::npos) << message;
    }
}

TEST (CookieJarWriteScope, UnsetAndClearOfAnotherSitesUrlLeaveItsCookiesAndWarn) {
    CookieJar jar;
    store_two_sites (jar);
    vayu::Environment env;

    const auto result = run_jar_write (jar, "http://a.test/users",
    "const jar = pm.cookies.jar();"
    "const name = jar.unset('http://b.test/', 'session', "
    "  (err, n) => pm.environment.set('unset_cb', String(err) + ':' + n));"
    "pm.environment.set('unset_ret', name);"
    "jar.clear('http://b.test/', "
    "  (err) => pm.environment.set('clear_cb', String(err)));",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (jar.matching ("env_a", "http://b.test/").size (), 1u)
    << "a script deleted the cookies of a site it may not name";
    EXPECT_EQ (jar.matching ("env_a", "http://a.test/").size (), 1u);
    EXPECT_EQ (env["unset_cb"].value, "null:session");
    EXPECT_EQ (env["unset_ret"].value, "session");
    EXPECT_EQ (env["clear_cb"].value, "null");

    const auto warned = warnings_of (result);
    ASSERT_EQ (warned.size (), 2u);
    for (const auto& message : warned) {
        EXPECT_NE (message.find ("b.test"), std::string::npos) << message;
    }
}

TEST (CookieJarWriteScope, ArgumentsAreValidatedBeforeTheScopeIsAsked) {
    // A refusal for scope must not mask the error a bad argument already
    // earns, and must not warn about a call that was never going to happen.
    CookieJar jar;
    vayu::Environment env;

    const auto result = run_jar_write (jar, "http://a.test/users",
    "pm.cookies.jar().set('http://b.test/', { name: 'n', value: 'v' }, "
    "'not a function');",
    env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("callback must be a function"), std::string::npos)
    << result.error_message;
    EXPECT_TRUE (warnings_of (result).empty ());
}

TEST (CookieJarWriteScope, ADomainOfTheRequestsOwnSiteStillStores) {
    // `Domain=a.test` set from a request to www.a.test is what a Set-Cookie
    // there would do, and what a login script writes.
    CookieJar jar;
    vayu::Environment env;

    const auto result = run_jar_write (jar, "http://www.a.test/users",
    "const jar = pm.cookies.jar();"
    "jar.set('http://www.a.test/', { name: 'apex', value: 'v', domain: "
    "'a.test', path: '/' });"
    "jar.set('http://www.a.test/', { name: 'dotted', value: 'v', domain: "
    "'.a.test' });"
    "jar.set('http://a.test/', { name: 'own', value: 'v' });",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (warnings_of (result).empty ());
    // `Domain=a.test` without a dot is host-only on the apex; `.a.test` is the
    // one a subdomain carries too.
    EXPECT_EQ (jar.matching ("env_a", "http://a.test/").size (), 3u)
    << "a write inside the request's site was refused";
    EXPECT_EQ (jar.matching ("env_a", "http://www.a.test/").size (), 1u);
}

TEST (CookieJarWriteScope, ASingleLabelDomainIsRefusedBecauseItReachesEverySiteUnderIt) {
    // `.test` is a parent of the request host, so the site rule alone admits
    // it - and the cookie would then ride every transfer to victim.test.
    // There is no public-suffix list (#2731); the cheap guard is the label count.
    CookieJar jar;
    vayu::Environment env;

    const auto result = run_jar_write (jar, "http://a.test/users",
    "const jar = pm.cookies.jar();"
    "for (const domain of ['.test', 'test', 'TEST']) {"
    "  jar.set('http://a.test/', { name: 'sid', value: 'x', domain, path: '/' "
    "});"
    "  jar.set('http://a.test/', { name: 'sid2', value: 'x', domain });"
    "}",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (jar.snapshot ().empty ())
    << "a cookie for a top-level domain was stored";
    EXPECT_FALSE (jar_holds_for (jar, "victim.test"));
    const auto warned = warnings_of (result);
    ASSERT_EQ (warned.size (), 6u);
    for (const auto& message : warned) {
        EXPECT_NE (message.find ("single-label"), std::string::npos) << message;
    }
}

TEST (CookieJarWriteScope, AMultiLabelPublicSuffixIsStillAcceptedBecauseNoSuffixListIsApplied) {
    // Pins the residual the owner accepted (#2731, SECURITY.md): `co.uk` is a
    // parent of a.co.uk, so the site rule admits it, and the engine vendors no
    // public-suffix list to tell it from a registrable domain. Adding such a
    // refusal is a deliberate change that updates this test and the docs.
    CookieJar jar;
    vayu::Environment env;

    const auto result = run_jar_write (jar, "http://a.co.uk/users",
    "pm.cookies.jar().set('http://a.co.uk/', { name: 'sid', value: 'x', "
    "domain: '.co.uk', path: '/' });",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (warnings_of (result).empty ());
    EXPECT_EQ (jar.matching ("env_a", "http://b.co.uk/").size (), 1u)
    << "the public-suffix write was refused; update the docs that say it is "
       "not";
}

TEST (CookieJarWriteScope, ASingleLabelDomainIsAllowedForTheExactHostAndASubdomainStays) {
    {
        // A host with no dot in it (`localhost`) is the only thing its own
        // cookie domain can be.
        CookieJar jar;
        vayu::Environment env;
        const auto result = run_jar_write (jar, "http://localhost/users",
        "const jar = pm.cookies.jar();"
        "jar.set('http://localhost/', { name: 'a', value: 'v', domain: "
        "'localhost', path: '/' });"
        "jar.set('http://localhost/', { name: 'b', value: 'v', domain: "
        "'localhost' });",
        env);
        ASSERT_TRUE (result.success) << result.error_message;
        EXPECT_TRUE (warnings_of (result).empty ());
        EXPECT_EQ (jar.matching ("env_a", "http://localhost/").size (), 2u);
    }
    {
        CookieJar jar;
        vayu::Environment env;
        const auto result = run_jar_write (jar, "http://a.test/users",
        "pm.cookies.jar().set('http://a.test/', { name: 'sub', value: 'v', "
        "domain: 'evil.a.test', path: '/' });",
        env);
        ASSERT_TRUE (result.success) << result.error_message;
        EXPECT_TRUE (warnings_of (result).empty ());
        EXPECT_EQ (jar.matching ("env_a", "http://evil.a.test/").size (), 1u);
    }
}

TEST (CookieJarWriteScope, AHostTheScriptCalledThroughSendRequestBecomesWritable) {
    // The server is on 127.0.0.1, a host the request (to a.test) is not for.
    CookieServer server;
    CookieJar jar;
    jar.store ("env_a",
    { netscape_line ("127.0.0.1", "FALSE", "/", "FALSE",
    std::to_string (FAR_FUTURE), "old", "v") });
    vayu::Environment env;

    const auto result = run_jar_write (jar, "http://a.test/users",
    "const jar = pm.cookies.jar();"
    "const root = '" +
    server.url ("/") +
    "';"
    "jar.set(root, { name: 'early', value: 'v' });"
    "jar.unset(root, 'old');"
    "pm.sendRequest(root + 'login', function () {});"
    "jar.set(root, { name: 'late', value: 'v' });"
    "jar.set(root, { name: 'late_domain', value: 'v', domain: '127.0.0.1', "
    "path: '/' });"
    "jar.unset(root, 'old');",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    std::vector<std::string> names;
    for (const auto& cookie : jar.matching ("env_a", server.url ("/"))) {
        names.push_back (cookie.name);
    }
    std::ranges::sort (names);
    EXPECT_EQ (names, (std::vector<std::string>{ "late", "late_domain", "session" }))
    << "the writes before the call should be refused and those after allowed";
    EXPECT_EQ (warnings_of (result).size (), 2u)
    << "only the two writes before the call should have been refused";
}

// A request a pre-request script runs before keeps its `{{name}}`s written
// while the script runs (#2521), so the request's site is its URL as the
// variables resolve it at the call: a stored name, or one the script set a
// line earlier. The flat read, a jar read and a jar write all answer for that
// site, and another site is still refused. Mutation check: return
// `request.url` as written from `jar_request_url`, and every access to a.test
// is refused or answers nothing.
TEST (CookieJarWriteScope, ATemplatedRequestUrlIsTheSiteItResolvesTo) {
    CookieJar jar;
    store_two_sites (jar);
    vayu::Environment env;
    env["host"] = vayu::Variable{ .value = "a.test" };

    const auto result = run_jar_write (jar, "http://{{host}}/users",
    "const jar = pm.cookies.jar();"
    "pm.environment.set('flat', String(pm.cookies.get('session')));"
    "pm.environment.set('read', String(jar.get('http://a.test/', 'session')));"
    "jar.set('http://a.test/', { name: 'stored_host', value: 'v' });"
    "jar.set('http://b.test/', { name: 'before_set', value: 'v' });"
    "pm.environment.set('host', 'b.test');"
    "jar.set('http://b.test/', { name: 'after_set', value: 'v' });",
    env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["flat"].value, "from-a");
    EXPECT_EQ (env["read"].value, "from-a");
    const auto names_for = [&jar] (const std::string& url) {
        std::vector<std::string> names;
        for (const auto& cookie : jar.matching ("env_a", url)) {
            names.push_back (cookie.name);
        }
        std::ranges::sort (names);
        return names;
    };
    EXPECT_EQ (names_for ("http://a.test/"),
    (std::vector<std::string>{ "session", "stored_host" }));
    EXPECT_EQ (names_for ("http://b.test/"),
    (std::vector<std::string>{ "after_set", "session" }))
    << "a write is held to the site the URL resolves to when it is made";
    const auto warned = warnings_of (result);
    ASSERT_EQ (warned.size (), 1u);
    EXPECT_NE (warned.front ().find ("(a.test)"), std::string::npos)
    << "the warning names the resolved site: " << warned.front ();
}

// ============================================================================
// The staged write, as a value - the pure half, without a transfer
// ============================================================================

TEST (CookieJarWriteValue, ADefaultedCookieTakesItsDomainAndPathFromTheUrl) {
    const auto defaulted =
    vayu::http::cookie_for_url ("https://api.example.com/v1/orders/42",
    JarCookie{ "", false, "", false, false, 0, "session", "abc" });
    ASSERT_HAS_VALUE (defaulted);
    EXPECT_EQ (defaulted->domain, "api.example.com");
    EXPECT_FALSE (defaulted->include_subdomains)
    << "a defaulted domain is host-only, as a Set-Cookie without Domain is";
    // RFC 6265 §5.1.4 default-path: the URL's path minus its last segment.
    EXPECT_EQ (defaulted->path, "/v1/orders");

    // An explicit leading dot is libcurl's spelling of "subdomains too".
    const auto explicit_domain =
    vayu::http::cookie_for_url ("https://api.example.com/",
    JarCookie{ ".example.com", false, "/", false, false, 0, "session", "abc" });
    ASSERT_HAS_VALUE (explicit_domain);
    EXPECT_TRUE (explicit_domain->include_subdomains);

    // A round trip through the line is the point of formatting one: a written
    // cookie and a received one must be the same kind of thing.
    const auto round_tripped =
    parse_cookie_line (vayu::http::format_cookie_line (*defaulted));
    ASSERT_HAS_VALUE (round_tripped);
    EXPECT_EQ (round_tripped->domain, "api.example.com");
    EXPECT_EQ (round_tripped->path, "/v1/orders");
    EXPECT_EQ (round_tripped->value, "abc");
}

TEST (CookieJarWriteValue, ASecondWriteOfTheSameNameDomainAndPathReplaces) {
    const auto line_for = [] (const std::string& path, const std::string& value) {
        return vayu::http::format_cookie_line (
        JarCookie{ "example.com", false, path, false, false, 0, "session", value });
    };

    std::vector<std::string> lines = { line_for ("/", "first") };
    lines = vayu::http::apply_cookie_writes (std::move (lines),
    { { vayu::http::CookieWrite::Kind::Set, line_for ("/", "second"), {}, {} } });
    ASSERT_EQ (lines.size (), 1u) << "the same cookie was stored twice";
    EXPECT_NE (lines[0].find ("second"), std::string::npos);

    // A different path is a different cookie (RFC 6265 §5.3), so it is added.
    lines = vayu::http::apply_cookie_writes (std::move (lines),
    { { vayu::http::CookieWrite::Kind::Set, line_for ("/admin", "third"), {}, {} } });
    EXPECT_EQ (lines.size (), 2u);

    // And clear takes everything in the scope, in order with what came before.
    lines = vayu::http::apply_cookie_writes (std::move (lines),
    { { vayu::http::CookieWrite::Kind::Clear, {}, {}, {} },
    { vayu::http::CookieWrite::Kind::Set, line_for ("/", "after"), {}, {} } });
    ASSERT_EQ (lines.size (), 1u);
    EXPECT_NE (lines[0].find ("after"), std::string::npos);
}

TEST (CookieJarWriteValue, ClearUrlTakesEveryCookieThatUrlWouldHaveCarried) {
    // The path half of the scoping, which the host-level test above cannot
    // see: `/admin` is a different cookie from `/`, and a clear at `/` must
    // not reach it - the same rule `unset` is held to.
    const auto line_for = [] (const std::string& path, const std::string& name) {
        return vayu::http::format_cookie_line (
        JarCookie{ "example.com", false, path, false, false, 0, name, "v" });
    };

    std::vector<std::string> lines = { line_for ("/", "session"),
        line_for ("/", "csrf"), line_for ("/admin", "elevated") };
    lines = vayu::http::apply_cookie_writes (std::move (lines),
    { { vayu::http::CookieWrite::Kind::ClearUrl, {}, "http://example.com/", {} } });

    ASSERT_EQ (lines.size (), 1u)
    << "a clear at / missed a cookie there, or reached /admin";
    EXPECT_NE (lines[0].find ("elevated"), std::string::npos);
}

TEST (CookieJarWriteValue, OnlyAUrlThatParsesCanScopeAJarOperation) {
    // What separates "cleared nothing" from "that was not a URL" - the
    // distinction `matching_in`'s empty list cannot carry (issue #997).
    EXPECT_TRUE (
    vayu::http::url_can_scope_cookies ("https://api.example.com/v1"));
    EXPECT_FALSE (vayu::http::url_can_scope_cookies ("nope"));
    EXPECT_FALSE (vayu::http::url_can_scope_cookies (""));
}

// ============================================================================
// GET /cookies and DELETE /cookies - what Settings shows and clears
// ============================================================================

TEST (CookieJarRoute, ReportsEveryFieldAndNamesTheNoEnvironmentScopeAsNull) {
    CookieJar jar;
    jar.store (std::string (NO_ENVIRONMENT_SCOPE),
    { "#HttpOnly_" +
    netscape_line (".example.com", "TRUE", "/app", "TRUE",
    std::to_string (FAR_FUTURE), "session", "abc") });

    const auto body = vayu::http::routes::cookies_response (jar);
    ASSERT_EQ (body["scopes"].size (), 1u);
    const auto& scope = body["scopes"][0];
    // null rather than "": the panel resolves an id to an environment name, and
    // an empty string is an id it could never resolve.
    EXPECT_TRUE (scope["environmentId"].is_null ());
    ASSERT_EQ (scope["cookies"].size (), 1u);
    const auto& cookie = scope["cookies"][0];
    EXPECT_EQ (cookie["name"], "session");
    EXPECT_EQ (cookie["value"], "abc");
    EXPECT_EQ (cookie["domain"], ".example.com");
    EXPECT_EQ (cookie["path"], "/app");
    // Deliberately absent - nothing in the app reads it; see cookies.cpp.
    EXPECT_FALSE (cookie.contains ("includeSubdomains"));
    EXPECT_EQ (cookie["secure"], true);
    EXPECT_EQ (cookie["httpOnly"], true);
    EXPECT_EQ (cookie["expires"], FAR_FUTURE);
}

TEST (CookieJarRoute, AbsentScopeClearsEverythingAndAnEmptyOneClearsOnlyTheNoEnvironmentJar) {
    CookieJar jar;
    const auto line =
    netscape_line ("example.com", "FALSE", "/", "FALSE", "0", "session", "abc");
    jar.store (std::string (NO_ENVIRONMENT_SCOPE), { line });
    jar.store ("env_a", { line });

    // The engine's null-vs-absent rule in a query string: present-and-empty is
    // a real scope (the one no id can name), absent is every scope.
    auto cleared = vayu::http::routes::clear_cookies_response (
    jar, std::optional<std::string> (std::string (NO_ENVIRONMENT_SCOPE)));
    EXPECT_EQ (cleared["cleared"], 1u);
    const auto remaining = jar.snapshot ();
    ASSERT_EQ (remaining.size (), 1u) << "the environment's jar went too";
    // Guarded rather than read straight through: were the wrong jar cleared,
    // the surviving scope would be the no-environment one and this read would
    // be undefined, so the regression would crash the suite instead of naming
    // itself here.
    const auto& kept = remaining[0].environment_id;
    ASSERT_HAS_VALUE (kept)
    << "the no-environment jar survived instead of env_a's";
    EXPECT_EQ (*kept, "env_a");

    cleared = vayu::http::routes::clear_cookies_response (jar, std::nullopt);
    EXPECT_EQ (cleared["cleared"], 1u);
    EXPECT_TRUE (jar.snapshot ().empty ());
}

namespace {

// -- GET /cookies: `q` / `limit` / `offset` (#2443) --------------------------

/// Three scopes - the no-environment jar and two environments - whose
/// cookies, flattened in scope-key then line order, are named `c0`..`c5`.
void fill_three_scopes (CookieJar& jar) {
    const auto line = [] (const std::string& domain, const std::string& name) {
        return netscape_line (domain, "FALSE", "/", "FALSE", "0", name, "v_" + name);
    };
    jar.store ("env_b", { line ("b.example.com", "c4"), line ("Shop.Example.com", "c5") });
    jar.store (std::string (NO_ENVIRONMENT_SCOPE),
    { line ("api.example.com", "c0"), line ("other.test", "SESSION_c1") });
    jar.store ("env_a", { line ("auth.Example.COM", "c2"), line ("x.test", "c3") });
}

std::vector<std::string> names_of (const nlohmann::json& rows) {
    std::vector<std::string> names;
    for (const auto& row : rows) {
        names.push_back (row.at ("name").get<std::string> ());
    }
    return names;
}

// With none of the three keys the route answers `{scopes}` exactly as before.
// Mutation check: answer a call with no key through `list_page_of` and this
// reds.
TEST (CookieJarRoute, NoPagingKeysAnswersTheScopesBodyByteForByte) {
    CookieJar jar;
    fill_three_scopes (jar);
    auto [status, body] =
    vayu::http::routes::cookies_response (jar, vayu::http::routes::ListPageQuery{});
    EXPECT_EQ (status, 200);
    EXPECT_EQ (body.dump (), vayu::http::routes::cookies_response (jar).dump ());
}

// The paged form is flat: each cookie carries its scope's `environmentId`,
// null for the no-environment jar, in scope-key then line order. `q` matches
// the name or the domain, case-insensitively, and a cleared jar's cookies
// never match. Mutation check: drop the domain half of the predicate and the
// cookies matched only by domain go missing.
TEST (CookieJarRoute, PagedFormMatchesQAgainstNameOrDomainAcrossFlattenedScopes) {
    CookieJar jar;
    fill_three_scopes (jar);

    auto [status, body] =
    vayu::http::routes::cookies_response (jar, { .q = "eXaMpLe.com" });
    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (names_of (body["data"]),
    (std::vector<std::string>{ "c0", "c2", "c4", "c5" }));
    EXPECT_EQ (body["pagination"]["total"], 4);
    const auto& first = body["data"][0];
    EXPECT_TRUE (first["environmentId"].is_null ());
    EXPECT_EQ (first["value"], "v_c0");
    EXPECT_EQ (first["domain"], "api.example.com");
    EXPECT_EQ (first["path"], "/");
    EXPECT_EQ (first["secure"], false);
    EXPECT_EQ (first["httpOnly"], false);
    EXPECT_EQ (first["expires"], 0);
    EXPECT_FALSE (first.contains ("includeSubdomains"));
    EXPECT_EQ (body["data"][1]["environmentId"], "env_a");
    EXPECT_EQ (body["data"][3]["environmentId"], "env_b");

    auto [by_name_status, by_name] =
    vayu::http::routes::cookies_response (jar, { .q = "session" });
    ASSERT_EQ (by_name_status, 200);
    EXPECT_EQ (names_of (by_name["data"]), (std::vector<std::string>{ "SESSION_c1" }));

    jar.clear ("env_a");
    auto [cleared_status, cleared] =
    vayu::http::routes::cookies_response (jar, { .q = "c2" });
    ASSERT_EQ (cleared_status, 200);
    EXPECT_TRUE (cleared["data"].empty ());
    EXPECT_EQ (cleared["pagination"]["total"], 0);
}

// Pages walk the flattened order without a gap or a repeat. Mutation check:
// drop the offset from ListPage::window and every page restarts at `c0`.
TEST (CookieJarRoute, PagedFormWalksTheFlattenedCookiesInStablePages) {
    CookieJar jar;
    fill_three_scopes (jar);
    std::vector<std::string> walked;
    for (const auto& [offset, returned, has_more] :
    { std::tuple{ "0", 4, true }, std::tuple{ "4", 2, false } }) {
        auto [status, body] = vayu::http::routes::cookies_response (
        jar, { .limit = "4", .offset = offset });
        ASSERT_EQ (status, 200) << body.dump ();
        EXPECT_EQ (body["pagination"]["returned"], returned) << offset;
        EXPECT_EQ (body["pagination"]["hasMore"], has_more) << offset;
        EXPECT_EQ (body["pagination"]["total"], 6) << offset;
        for (const auto& name : names_of (body["data"])) {
            walked.push_back (name);
        }
    }
    EXPECT_EQ (walked,
    (std::vector<std::string>{ "c0", "SESSION_c1", "c2", "c3", "c4", "c5" }));
}

TEST (CookieJarRoute, PagedFormRefusesABadLimitOrOffset) {
    CookieJar jar;
    fill_three_scopes (jar);
    for (const auto& [query, code] :
    { std::pair{ vayu::http::routes::ListPageQuery{ .limit = "0" }, "invalid_limit" },
    std::pair{ vayu::http::routes::ListPageQuery{ .offset = "5abc" }, "invalid_offset" } }) {
        auto [status, body] = vayu::http::routes::cookies_response (jar, query);
        EXPECT_EQ (status, 400) << body.dump ();
        EXPECT_EQ (body["error"]["code"], code);
    }
}

} // namespace
