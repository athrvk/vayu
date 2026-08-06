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

#include <gtest/gtest.h>

#include <atomic>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>

#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

#include <nlohmann/json.hpp>

namespace vayu::http::routes {
// Defined in routes/cookies.cpp - the extracted cores of GET /cookies and
// DELETE /cookies, exercised directly per the suite's route-test convention
// (globals_route_test.cpp).
nlohmann::json cookies_response (const vayu::http::CookieJar& jar);
nlohmann::json clear_cookies_response (vayu::http::CookieJar& jar,
const std::optional<std::string>& scope);
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

class CookieServer {
    public:
    CookieServer () {
        svr.new_task_queue = [] { return new httplib::ThreadPool (8); };

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

} // namespace

// ============================================================================
// The Netscape line, as libcurl writes it
// ============================================================================

TEST (CookieJarParse, ReadsEveryFieldOfALine) {
    auto cookie = parse_cookie_line (netscape_line (
    ".example.com", "TRUE", "/app", "TRUE", "1700000001", "session", "abc"));
    ASSERT_TRUE (cookie.has_value ());
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
    ASSERT_TRUE (cookie.has_value ());
    EXPECT_TRUE (cookie->http_only);
    EXPECT_EQ (cookie->domain, "example.com")
    << "the marker leaked into the domain";
}

TEST (CookieJarParse, KeepsAnEmptyValueAndAValueWithAnEquals) {
    // Session cookies are routinely base64 and end in `=` padding; an empty
    // value is what a server writes to delete one.
    auto padded = parse_cookie_line (
    netscape_line ("example.com", "FALSE", "/", "FALSE", "0", "t", "YWJj=="));
    ASSERT_TRUE (padded.has_value ());
    EXPECT_EQ (padded->value, "YWJj==");

    auto empty = parse_cookie_line (
    netscape_line ("example.com", "FALSE", "/", "FALSE", "0", "t", ""));
    ASSERT_TRUE (empty.has_value ());
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
    ASSERT_TRUE (scopes[1].environment_id.has_value ());
    EXPECT_EQ (*scopes[1].environment_id, "env_a");
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

    // A logout expires the cookie. Storing the transfer's whole list rather
    // than merging into what was there is what makes this stick.
    send_in_scope (jar, "env_a", server.url ("/logout"));
    EXPECT_EQ (send_in_scope (jar, "env_a", server.url ("/echo")), "");
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

    EXPECT_EQ (sent.body, "session=abc123") << "the cookie never reached the server";
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
    ASSERT_EQ (jar.snapshot ().size (), 1u) << "the environment's jar went too";
    EXPECT_EQ (*jar.snapshot ()[0].environment_id, "env_a");

    cleared = vayu::http::routes::clear_cookies_response (jar, std::nullopt);
    EXPECT_EQ (cleared["cleared"], 1u);
    EXPECT_TRUE (jar.snapshot ().empty ());
}
