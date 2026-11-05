/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/redirect_policy_test.cpp
 * @brief The decisions the engine's redirect loop makes between two hops
 *        (#3300), without a wire.
 *
 * What a followed chain does on a wire is held by the driver suites
 * (`http_client_test.cpp`, `redirect_credentials_test.cpp`,
 * `url_scheme_test.cpp`, `mutual_tls_test.cpp`); these cases pin each rule on
 * its own, so a regression names the rule rather than a symptom.
 */

#include <gtest/gtest.h>

#include <curl/curl.h>

#include <algorithm>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "vayu/http/curl_options.hpp"
#include "vayu/http/redirect_policy.hpp"

namespace vayu::http {
namespace {

TEST (RedirectStatus, EveryThreeHundredIsARedirectAndNothingElse) {
    EXPECT_FALSE (is_redirect_status (299));
    EXPECT_TRUE (is_redirect_status (300));
    EXPECT_TRUE (is_redirect_status (302));
    EXPECT_TRUE (is_redirect_status (399));
    EXPECT_FALSE (is_redirect_status (400));
    EXPECT_FALSE (is_redirect_status (100));
}

TEST (RedirectLocation, IsTheFirstNonBlankLocationInAnyCase) {
    EXPECT_FALSE (location_of ({ { "Content-Type", "text/plain" } }).has_value ());
    EXPECT_FALSE (location_of ({ { "Location", "" } }).has_value ());
    EXPECT_EQ (location_of ({ { "location", "/next" } }), "/next");
    EXPECT_EQ (location_of ({ { "Location", "" }, { "LOCATION", "/second" } }), "/second");
}

// Mutation-check: resolve the Location without the base and the relative case
// reads "mid".
TEST (RedirectTarget, ARelativeLocationResolvesAgainstTheHopItAnswered) {
    EXPECT_EQ (resolve_redirect_target ("http://127.0.0.1:8080/rel/start", "mid"),
    "http://127.0.0.1:8080/rel/mid");
    EXPECT_EQ (resolve_redirect_target ("http://127.0.0.1:8080/a/b?q=1", "/c"),
    "http://127.0.0.1:8080/c");
    EXPECT_EQ (resolve_redirect_target ("https://a.test/x", "//b.test:9/y"), "https://b.test:9/y");
    EXPECT_EQ (resolve_redirect_target ("http://a.test/x", "https://b.test/z?k=v"),
    "https://b.test/z?k=v");
}

TEST (RedirectTarget, ABaseNamingNoSchemeIsReadAsTheOneDialled) {
    EXPECT_EQ (resolve_redirect_target ("localhost:8080/x", "/y"), "http://localhost:8080/y");
}

TEST (RedirectTarget, TheFragmentIsDroppedAndASpaceIsEncoded) {
    EXPECT_EQ (resolve_redirect_target ("http://a.test/x", "/y#section"), "http://a.test/y");
    EXPECT_EQ (resolve_redirect_target ("http://a.test/x", "/a b"), "http://a.test/a%20b");
}

// The scheme rule `CURLOPT_REDIR_PROTOCOLS_STR` held while libcurl followed,
// in the words it used. Mutation-check: drop the scheme check and the ftp
// target resolves.
TEST (RedirectTarget, ASchemeOtherThanHttpIsRefusedAsAnInvalidUrl) {
    for (const auto& [location, scheme] : std::vector<std::pair<std::string, std::string>>{
         { "ftp://127.0.0.1:1/pub/x", "ftp" }, { "FILE:///etc/passwd", "file" },
         { "gopher://a.test/", "gopher" } }) {
        const auto target = resolve_redirect_target ("http://a.test/x", location);
        ASSERT_FALSE (target.has_value ()) << location;
        EXPECT_EQ (target.error ().code, ErrorCode::InvalidUrl) << location;
        EXPECT_EQ (target.error ().message,
        "Protocol \"" + scheme + "\" is disabled (in redirect)");
    }
}

TEST (RedirectTarget, ALocationThatDoesNotParseIsAnInvalidUrl) {
    const auto target = resolve_redirect_target ("http://a.test/x", "http://[::1/");
    ASSERT_FALSE (target.has_value ());
    EXPECT_EQ (target.error ().code, ErrorCode::InvalidUrl);
    EXPECT_TRUE (target.error ().message.starts_with (
    "The redirect target URL could not be parsed: "))
    << target.error ().message;
}

// libcurl's CURLFOLLOW_ALL rule, the oracle for `http_client_test.cpp`'s raw
// request views. Mutation-check: keep the body on a 302 and the GET-with-body
// row fails.
TEST (RedirectedRequest, ASeeOtherFamilyDropsTheBodyAndTurnsAPostIntoAGet) {
    for (const int status : { 301, 302, 303 }) {
        const auto post = redirected_request (status, HttpMethod::POST);
        EXPECT_EQ (post.method, HttpMethod::GET) << status;
        EXPECT_FALSE (post.keeps_body) << status;
        for (const auto method : { HttpMethod::GET, HttpMethod::PUT, HttpMethod::PATCH,
             HttpMethod::DELETE, HttpMethod::OPTIONS, HttpMethod::HEAD }) {
            const auto kept = redirected_request (status, method);
            EXPECT_EQ (kept.method, method) << status;
            EXPECT_FALSE (kept.keeps_body) << status;
        }
    }
}

TEST (RedirectedRequest, EveryOtherRedirectKeepsTheMethodAndTheBody) {
    for (const int status : { 300, 304, 305, 307, 308 }) {
        for (const auto method : { HttpMethod::GET, HttpMethod::POST, HttpMethod::PUT }) {
            const auto kept = redirected_request (status, method);
            EXPECT_EQ (kept.method, method) << status;
            EXPECT_TRUE (kept.keeps_body) << status;
        }
    }
}

TEST (SameOrigin, ComparesSchemeHostAndPortWithTheDefaultPortFilledIn) {
    EXPECT_TRUE (same_origin ("http://a.test/x", "http://a.test:80/y?q"));
    EXPECT_TRUE (same_origin ("https://A.Test/x", "https://a.test:443/"));
    EXPECT_TRUE (same_origin ("localhost:8080/x", "http://localhost:8080/y"));
    EXPECT_FALSE (same_origin ("http://127.0.0.1:8080/", "http://127.0.0.1:9090/"));
    EXPECT_FALSE (same_origin ("http://a.test/", "https://a.test/"));
    EXPECT_FALSE (same_origin ("http://a.test/", "http://b.test/"));
    EXPECT_FALSE (same_origin ("http://[::1/", "http://[::1/"))
    << "nothing to compare";
}

TEST (RedirectHeaders, OnlyAuthorizationAndCookieStayWithTheFirstOrigin) {
    EXPECT_TRUE (is_origin_bound_header ("Authorization"));
    EXPECT_TRUE (is_origin_bound_header ("cookie"));
    EXPECT_FALSE (is_origin_bound_header ("X-Api-Key"));
    EXPECT_FALSE (is_origin_bound_header ("Proxy-Authorization"));
    EXPECT_TRUE (is_body_header ("content-type"));
    EXPECT_TRUE (is_body_header ("Content-Length"));
    EXPECT_FALSE (is_body_header ("Content-Encoding"));
}

TEST (RedirectLimit, IsReachedAtTheLimitAndNeverWhenNegative) {
    EXPECT_TRUE (redirect_limit_reached (0, 0));
    EXPECT_FALSE (redirect_limit_reached (1, 2));
    EXPECT_TRUE (redirect_limit_reached (2, 2));
    EXPECT_FALSE (redirect_limit_reached (1000, -1));
}

TEST (RedirectLimit, TheErrorNamesTheLimitAsLibcurlsDid) {
    const Error error = too_many_redirects_error (2);
    EXPECT_EQ (error.code, ErrorCode::TooManyRedirects);
    EXPECT_EQ (error.message,
    "Too many redirects: the server redirected more than 2 times (see Maximum "
    "redirects). Maximum (2) redirects followed");
    EXPECT_EQ (too_many_redirects_message (std::nullopt, "detail"),
    "Too many redirects: the server redirected more than the allowed number of "
    "times (see Maximum redirects). detail");
}

// ---------------------------------------------------------------------------
// Cookies a hop set
// ---------------------------------------------------------------------------

std::string line (const std::string& domain, const std::string& name, const std::string& value) {
    return domain + "\tFALSE\t/\tFALSE\t0\t" + name + "\t" + value;
}

TEST (HopCookieLines, AnIdentityIsDomainTailmatchPathAndName) {
    EXPECT_EQ (cookie_identity (line ("127.0.0.1", "s", "1")),
    cookie_identity (line ("127.0.0.1", "s", "2")));
    EXPECT_EQ (cookie_identity ("#HttpOnly_A.test\tFALSE\t/\tFALSE\t0\ts\t1"),
    cookie_identity (line ("a.test", "s", "1")));
    EXPECT_NE (cookie_identity (line ("127.0.0.1", "s", "1")),
    cookie_identity (line ("127.0.0.1", "t", "1")));
    EXPECT_FALSE (cookie_identity ("not a cookie line").has_value ());
}

TEST (HopCookieLines, AnExpiredCopyChangesOnlyTheExpiry) {
    EXPECT_EQ (
    expired_cookie_line ("a.test\tTRUE\t/p\tTRUE\t4102444800\tn\tv\twith\ttab"),
    "a.test\tTRUE\t/p\tTRUE\t1\tn\tv\twith\ttab");
    EXPECT_FALSE (expired_cookie_line ("a.test\tTRUE").has_value ());
}

using CurlHandle = std::unique_ptr<CURL, decltype (&curl_easy_cleanup)>;

std::vector<std::string> engine_cookie_names (CURL* curl) {
    std::vector<std::string> names;
    struct curl_slist* held = nullptr;
    EXPECT_EQ (get_info<CURLINFO_COOKIELIST> (curl, &held), CURLE_OK);
    for (const struct curl_slist* item = held; item != nullptr; item = item->next) {
        const std::string text (item->data);
        names.push_back (text.substr (text.rfind ('\t', text.rfind ('\t') - 1) + 1));
    }
    curl_slist_free_all (held);
    return names;
}

// The engine half on a bare handle, with the hop's `Set-Cookie` stood in for
// by a line added while the hop is "under way". Mutation-check: skip the
// removal in `before_hop` and the cross-origin hop still lists the cookie.
TEST (HopCookies, ACookieAHopSetIsAbsentForAnotherOriginAndBackAfterIt) {
    const CurlHandle curl (curl_easy_init (), &curl_easy_cleanup);
    ASSERT_NE (curl, nullptr);
    set_opt<CURLOPT_COOKIELIST> (
    curl.get (), line ("127.0.0.1", "jar", "seeded").c_str ());
    HopCookies cookies (curl.get ());

    cookies.before_hop ("http://127.0.0.1:8080/login");
    set_opt<CURLOPT_COOKIELIST> (
    curl.get (), line ("127.0.0.1", "session", "abc").c_str ());
    cookies.after_hop ();

    cookies.before_hop ("http://127.0.0.1:9090/elsewhere");
    EXPECT_EQ (engine_cookie_names (curl.get ()), (std::vector<std::string>{ "jar\tseeded" }))
    << "a cookie the jar held before the send is matched as always";
    cookies.after_hop ();

    auto names = engine_cookie_names (curl.get ());
    std::ranges::sort (names);
    EXPECT_EQ (names, (std::vector<std::string>{ "jar\tseeded", "session\tabc" }))
    << "the withheld cookie is back for the jar and the hops after";

    cookies.before_hop ("http://127.0.0.1:8080/home");
    names = engine_cookie_names (curl.get ());
    std::ranges::sort (names);
    EXPECT_EQ (names, (std::vector<std::string>{ "jar\tseeded", "session\tabc" }))
    << "a hop back to the setter's origin carries it";
    cookies.after_hop ();
}

TEST (HopCookies, ACookieTheOtherOriginSetsReplacesTheWithheldOne) {
    const CurlHandle curl (curl_easy_init (), &curl_easy_cleanup);
    ASSERT_NE (curl, nullptr);
    HopCookies cookies (curl.get ());

    cookies.before_hop ("http://127.0.0.1:8080/");
    set_opt<CURLOPT_COOKIELIST> (
    curl.get (), line ("127.0.0.1", "session", "first").c_str ());
    cookies.after_hop ();

    cookies.before_hop ("http://127.0.0.1:9090/");
    set_opt<CURLOPT_COOKIELIST> (
    curl.get (), line ("127.0.0.1", "session", "second").c_str ());
    cookies.after_hop ();

    EXPECT_EQ (engine_cookie_names (curl.get ()),
    (std::vector<std::string>{ "session\tsecond" }));
    cookies.before_hop ("http://127.0.0.1:8080/");
    EXPECT_TRUE (engine_cookie_names (curl.get ()).empty ())
    << "the cookie is the second origin's now, and stays off the first";
    cookies.after_hop ();
}

} // namespace
} // namespace vayu::http
