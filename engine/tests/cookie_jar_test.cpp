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

    // And the matcher behind pm.cookies refuses it over cleartext, exactly as
    // it does for a received Secure cookie.
    const std::string host = "127.0.0.1";
    EXPECT_TRUE (jar.matching ("env_a", "http://" + host + "/").empty ());
    EXPECT_FALSE (jar.matching ("env_a", "https://" + host + "/").empty ());
}

TEST (CookieJarWrite, AWriteSurvivesTheEnclosingTransfersCapture) {
    // The ordering decision this whole surface turns on. `capture_jar_cookies`
    // *replaces* the scope with what the finishing handle held, and /logout
    // rewrites that list by expiring the session - a write applied into the
    // live map beside the transfer would go with it.
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
    ASSERT_TRUE (scopes[0].environment_id.has_value ());
    EXPECT_EQ (*scopes[0].environment_id, "env_b");
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
    const Case cases[] = {
        { "pm.cookies.jar().set('http://example.com/', { value: 'v' });", "name" },
        { "pm.cookies.jar().set('http://example.com/', { name: 'n', value: 1 "
          "});",
        "value" },
        { "pm.cookies.jar().set('http://example.com/', { name: 'n', value: "
          "'v', secure: 'yes' });",
        "true or false" },
        { "pm.cookies.jar().set('http://example.com/', { name: 'n', value: "
          "'v', expires: '2030' });",
        "seconds since the epoch" },
        // A tab is the Netscape line's own separator: stored, the cookie would
        // be unreadable on the next parse and would simply vanish.
        { "pm.cookies.jar().set('http://example.com/', { name: 'n', value: "
          "'a\\tb' });",
        "tab or newline" },
        { "pm.cookies.jar().set('not a url', { name: 'n', value: 'v' });", "parseable" },
        { "pm.cookies.jar().set();", "URL string" },
        { "pm.cookies.jar().unset('http://example.com/');", "cookie name string" },
        { "pm.cookies.jar().clear('nope');", "callback must be a function" },
    };

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
// The staged write, as a value - the pure half, without a transfer
// ============================================================================

TEST (CookieJarWriteValue, ADefaultedCookieTakesItsDomainAndPathFromTheUrl) {
    const auto defaulted =
    vayu::http::cookie_for_url ("https://api.example.com/v1/orders/42",
    JarCookie{ "", false, "", false, false, 0, "session", "abc" });
    ASSERT_TRUE (defaulted.has_value ());
    EXPECT_EQ (defaulted->domain, "api.example.com");
    EXPECT_FALSE (defaulted->include_subdomains)
    << "a defaulted domain is host-only, as a Set-Cookie without Domain is";
    // RFC 6265 §5.1.4 default-path: the URL's path minus its last segment.
    EXPECT_EQ (defaulted->path, "/v1/orders");

    // An explicit leading dot is libcurl's spelling of "subdomains too".
    const auto explicit_domain =
    vayu::http::cookie_for_url ("https://api.example.com/",
    JarCookie{ ".example.com", false, "/", false, false, 0, "session", "abc" });
    ASSERT_TRUE (explicit_domain.has_value ());
    EXPECT_TRUE (explicit_domain->include_subdomains);

    // A round trip through the line is the point of formatting one: a written
    // cookie and a received one must be the same kind of thing.
    const auto round_tripped =
    parse_cookie_line (vayu::http::format_cookie_line (*defaulted));
    ASSERT_TRUE (round_tripped.has_value ());
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
