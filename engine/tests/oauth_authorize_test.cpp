/**
 * @file tests/oauth_authorize_test.cpp
 * @brief Tests for the interactive authorization manager: URL building, state
 *        validation, embedded completion, a full in-process loopback flow
 *        (simulated IdP redirect → token exchange against a mock token server),
 *        and an attempt discovered from an MCP server URL (#3766): its
 *        endpoints, resource and scope.
 */

// First, before anything that includes <httplib.h>: see the header.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <future>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "held_request.hpp"
#include "oauth_discovery_server.hpp"
#include "oauth_token_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/oauth_authorize.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/oauth_discovery.hpp"
#include "vayu/utils/encoding.hpp"
#include "wait_until.hpp"

using nlohmann::json;
using vayu::tests::DiscoveryAnswer;
using vayu::tests::DiscoveryServer;
using vayu::tests::MockTokenServer;

namespace vayu::http::routes {
// Declared in oauth.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> oauth2_authorize_start (OAuth2AuthorizeManager& manager,
vayu::db::Database& db,
const std::string& request_body,
const std::atomic<bool>* cancel);
} // namespace vayu::http::routes

namespace {

// Extract the query string from a URL.
std::string query_of (const std::string& url) {
    const auto q = url.find ('?');
    return q == std::string::npos ? "" : url.substr (q + 1);
}
std::map<std::string, std::string> parse_q (const std::string& q) {
    std::map<std::string, std::string> out;
    size_t pos = 0;
    while (pos < q.size ()) {
        auto amp = q.find ('&', pos);
        auto pair =
        q.substr (pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (auto eq = pair.find ('='); eq != std::string::npos)
            out[pair.substr (0, eq)] = pair.substr (eq + 1);
        if (amp == std::string::npos)
            break;
        pos = amp + 1;
    }
    return out;
}

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

class OAuthAuthorizeTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_oauth_authorize.db";
    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }
    // A token the cache would answer with, so a completion that reads the
    // cache instead of exchanging its code is caught (#2472).
    void seed_cached_token (const json& config) {
        vayu::db::OAuthToken row;
        row.cache_key     = vayu::http::oauth::cache_key (config);
        row.access_token  = "STALE-CACHED";
        row.token_type    = "Bearer";
        row.refresh_token = "RT_OLD";
        row.expires_in    = 3600;
        row.created_at    = now_ms ();
        db_->save_oauth_token (row);
    }
    // Both completions must leave the provider's answer in the row.
    void expect_exchanged_token_stored (const json& config, const MockTokenServer& idp) {
        EXPECT_EQ (idp.hits (), 1);
        const auto stored = db_->get_oauth_token (vayu::http::oauth::cache_key (config));
        ASSERT_HAS_VALUE (stored);
        EXPECT_EQ (stored->access_token, "AT1");
    }
    // db_ declared before the manager is used in each test so the manager (with
    // any live listener capturing db_) is torn down first.
    std::unique_ptr<vayu::db::Database> db_;
};

TEST (BuildAuthorizeUrl, IncludesPkceAndParams) {
    const json config = { { "authorizationUrl", "https://idp.example/auth" },
        { "clientId", "cid" }, { "scope", "openid profile" } };
    const auto url    = vayu::http::build_authorize_url (
    config, "STATE1", "CHALLENGE1", "http://127.0.0.1:5000/callback", true);
    auto q = parse_q (query_of (url));
    EXPECT_EQ (q["response_type"], "code");
    EXPECT_EQ (q["client_id"], "cid");
    EXPECT_EQ (q["state"], "STATE1");
    EXPECT_EQ (q["code_challenge"], "CHALLENGE1");
    EXPECT_EQ (q["code_challenge_method"], "S256");
    EXPECT_EQ (q["scope"], "openid%20profile");
    EXPECT_EQ (q["redirect_uri"], "http%3A%2F%2F127.0.0.1%3A5000%2Fcallback");
}

// A pasted authorization URL's stray whitespace is not part of the URL the
// browser is sent to (#3687). Mutation-check: read `authorizationUrl` with
// `field` in `build_authorize_url` and both URLs keep their padding.
TEST (BuildAuthorizeUrl, StrayWhitespaceAroundTheAuthorizationUrlIsTrimmed) {
    json config = { { "authorizationUrl", " \thttps://idp.example/auth\r\n" },
        { "clientId", "cid" } };
    EXPECT_EQ (vayu::http::build_authorize_url (config, "S", "", "rt", false)
               .rfind ("https://idp.example/auth?response_type=code&", 0),
    0u);

    config["authorizationUrl"] = "https://idp.example/auth?foo=1 \n";
    const auto url = vayu::http::build_authorize_url (config, "S", "", "rt", false);
    EXPECT_NE (url.find ("?foo=1&"), std::string::npos) << url;
    EXPECT_EQ (url.find_first_of (" \t\r\n"), std::string::npos) << url;
}

TEST (BuildAuthorizeUrl, OmitsPkceWhenDisabled) {
    const json config = { { "authorizationUrl", "https://idp.example/auth?foo=1" },
        { "clientId", "cid" } };
    const auto url = vayu::http::build_authorize_url (config, "S", "", "rt", false);
    EXPECT_EQ (parse_q (query_of (url)).count ("code_challenge"), 0u);
    // authorizationUrl already had a query → params appended with '&'
    EXPECT_NE (url.find ("?foo=1&"), std::string::npos);
}

// authorizationParams ride the query whatever their sendAs (issue #2536); one
// naming a parameter the engine writes is skipped, so the config's audience
// appears once and the flow's own state is never replaced.
TEST (BuildAuthorizeUrl, AppendsAuthorizationParamsTheEngineDidNotWrite) {
    const json config = { { "authorizationUrl", "https://idp.example/auth" },
        { "clientId", "cid" }, { "audience", "aud-1" },
        { "authorizationParams",
        json::array ({ { { "key", "prompt" }, { "value", "login" } },
        { { "key", "organization" }, { "value", "o 1" }, { "sendAs", "header" } },
        { { "key", "audience" }, { "value", "aud-2" } }, { { "key", "state" }, { "value", "FORGED" } },
        { { "key", "off" }, { "value", "1" }, { "enabled", false } } }) } };
    const auto url = vayu::http::build_authorize_url (config, "STATE1", "C", "rt", true);
    auto q = parse_q (query_of (url));
    EXPECT_EQ (q["prompt"], "login");
    EXPECT_EQ (q["organization"], "o%201");
    EXPECT_EQ (q["audience"], "aud-1");
    EXPECT_EQ (q["state"], "STATE1");
    EXPECT_EQ (q.count ("off"), 0u);
    size_t audiences = 0;
    for (size_t at = url.find ("audience="); at != std::string::npos;
    at             = url.find ("audience=", at + 1)) {
        ++audiences;
    }
    EXPECT_EQ (audiences, 1u) << url;
    EXPECT_EQ (url.find ("FORGED"), std::string::npos) << url;
}

TEST_F (OAuthAuthorizeTest, StartRejectsIncompleteConfig) {
    vayu::http::OAuth2AuthorizeManager mgr;
    auto r = mgr.start (*db_, json{ { "clientId", "c" } }, "loopback");
    EXPECT_FALSE (r.ok);
    EXPECT_EQ (r.error_code, "oauth2_invalid_config");
}

TEST_F (OAuthAuthorizeTest, EmbeddedRequiresCallbackUrl) {
    vayu::http::OAuth2AuthorizeManager mgr;
    auto r = mgr.start (*db_,
    json{ { "authorizationUrl", "https://idp/auth" }, { "clientId", "c" } }, "embedded");
    EXPECT_FALSE (r.ok);
}

// A URL of whitespace alone is as missing as an absent one, and a padded
// callback is sent to the provider trimmed (#3687). Mutation-check: read the
// members with `field` in `start` and the first refusal and the redirect_uri
// assertion fail.
TEST_F (OAuthAuthorizeTest, StrayWhitespaceInTheConfigUrlsIsTrimmedByStart) {
    vayu::http::OAuth2AuthorizeManager mgr;
    EXPECT_FALSE (mgr
    .start (*db_, json{ { "authorizationUrl", " \n" }, { "clientId", "c" } }, "loopback")
    .ok);
    EXPECT_FALSE (mgr
    .start (*db_,
    json{ { "authorizationUrl", "https://idp/auth" }, { "clientId", "c" },
    { "callbackUrl", "\t " } },
    "embedded")
    .ok);

    auto start = mgr.start (*db_,
    json{ { "authorizationUrl", " https://idp/auth\n" }, { "clientId", "c" },
    { "callbackUrl", "\thttps://app/callback " } },
    "embedded");
    ASSERT_TRUE (start.ok);
    EXPECT_EQ (start.authorize_url.rfind ("https://idp/auth?", 0), 0u) << start.authorize_url;
    EXPECT_EQ (parse_q (query_of (start.authorize_url))["redirect_uri"],
    "https%3A%2F%2Fapp%2Fcallback");
}

TEST_F (OAuthAuthorizeTest, EmbeddedRejectsStateMismatch) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    const json config = { { "grantType", "authorization_code" },
        { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", idp.url ("/token") }, { "clientId", "cid" },
        { "clientSecret", "sec" }, { "callbackUrl", "https://app/callback" } };

    auto start = mgr.start (*db_, config, "embedded");
    ASSERT_TRUE (start.ok);
    auto st = mgr.complete (*db_, start.attempt_id, "https://app/callback?code=XYZ&state=WRONG");
    EXPECT_EQ (st.state, "failed");
    EXPECT_NE (st.error.find ("State"), std::string::npos);
}

TEST_F (OAuthAuthorizeTest, EmbeddedCompletesAndExchanges) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    const json config = { { "grantType", "authorization_code" },
        { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", idp.url ("/token") }, { "clientId", "cid" },
        { "clientSecret", "sec" }, { "callbackUrl", "https://app/callback" } };

    seed_cached_token (config);

    auto start = mgr.start (*db_, config, "embedded");
    ASSERT_TRUE (start.ok);
    // Pull the real state out of the authorize URL so the callback matches.
    const std::string state = parse_q (query_of (start.authorize_url))["state"];

    auto st = mgr.complete (
    *db_, start.attempt_id, "https://app/callback?code=AUTHCODE&state=" + state);
    EXPECT_EQ (st.state, "completed");
    EXPECT_FALSE (st.cache_key.empty ());
    EXPECT_TRUE (db_->get_oauth_token (st.cache_key).has_value ());
    expect_exchanged_token_stored (config, idp);
}

// The IdP's refusal reads the same through complete() as through the loopback
// callback (`LoopbackIdpErrorWithStateFailsAttempt`), description included
// (#3201). Mutation check: have complete() record `params.at ("error")` alone.
TEST_F (OAuthAuthorizeTest, EmbeddedIdpErrorCarriesItsDescription) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    const json config = { { "grantType", "authorization_code" },
        { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", idp.url ("/token") }, { "clientId", "cid" },
        { "clientSecret", "sec" }, { "callbackUrl", "https://app/callback" } };

    auto start = mgr.start (*db_, config, "embedded");
    ASSERT_TRUE (start.ok);
    const std::string state = parse_q (query_of (start.authorize_url))["state"];

    const auto st = mgr.complete (*db_,
    start.attempt_id, "https://app/callback?error=access_denied&error_description=User%20said%20no&state=" + state);
    EXPECT_EQ (st.state, "failed");
    EXPECT_EQ (st.error, "access_denied: User said no");
    EXPECT_EQ (idp.hits (), 0);
}

TEST_F (OAuthAuthorizeTest, LoopbackEndToEnd) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    const json config = { { "grantType", "authorization_code" },
        { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", idp.url ("/token") }, { "clientId", "cid" },
        { "clientSecret", "sec" } };

    seed_cached_token (config);

    auto start = mgr.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok);
    EXPECT_EQ (mgr.status (start.attempt_id).state, "pending");

    // Simulate the IdP redirecting the browser to the loopback callback.
    const std::string state = parse_q (query_of (start.authorize_url))["state"];
    httplib::Client cli (
    start.redirect_uri.substr (0, start.redirect_uri.find ("/callback")));
    auto resp = cli.Get ("/callback?code=AUTHCODE&state=" + state);
    ASSERT_TRUE (resp != nullptr);
    EXPECT_EQ (resp->status, 200);

    auto st = mgr.status (start.attempt_id);
    EXPECT_EQ (st.state, "completed");
    EXPECT_TRUE (db_->get_oauth_token (st.cache_key).has_value ());
    expect_exchanged_token_stored (config, idp);
}

json loopback_config (const MockTokenServer& idp) {
    return { { "grantType", "authorization_code" }, { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", idp.url ("/token") }, { "clientId", "cid" },
        { "clientSecret", "sec" } };
}

std::string state_of (const vayu::http::AuthorizeStart& start) {
    return parse_q (query_of (start.authorize_url))["state"];
}

// The callback listener's origin, for an httplib::Client playing the browser.
std::string callback_origin (const vayu::http::AuthorizeStart& start) {
    return start.redirect_uri.substr (0, start.redirect_uri.find ("/callback"));
}

// A local GET with no state is not the IdP's redirect, even one carrying
// `error`, so it must not fail the attempt the real redirect then completes.
TEST_F (OAuthAuthorizeTest, LoopbackStatelessErrorLeavesAttemptPending) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    const json config = loopback_config (idp);
    auto start        = mgr.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok);
    httplib::Client cli (callback_origin (start));

    auto stray = cli.Get ("/callback?error=x");
    ASSERT_TRUE (stray != nullptr);
    EXPECT_EQ (stray->status, 400);
    const auto waiting = mgr.status (start.attempt_id);
    EXPECT_EQ (waiting.state, "pending");
    EXPECT_EQ (waiting.error, "");

    auto real = cli.Get ("/callback?code=AUTHCODE&state=" + state_of (start));
    ASSERT_TRUE (real != nullptr);
    EXPECT_EQ (real->status, 200);
    EXPECT_EQ (mgr.status (start.attempt_id).state, "completed");
    expect_exchanged_token_stored (config, idp);
}

TEST_F (OAuthAuthorizeTest, LoopbackWrongStateNeverExchanges) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    auto start = mgr.start (*db_, loopback_config (idp), "loopback");
    ASSERT_TRUE (start.ok);
    httplib::Client cli (callback_origin (start));

    auto resp = cli.Get ("/callback?code=C&state=WRONG");
    ASSERT_TRUE (resp != nullptr);
    EXPECT_EQ (resp->status, 400);
    EXPECT_EQ (mgr.status (start.attempt_id).state, "pending");
    EXPECT_EQ (idp.hits (), 0);
}

TEST_F (OAuthAuthorizeTest, LoopbackIdpErrorWithStateFailsAttempt) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    auto start = mgr.start (*db_, loopback_config (idp), "loopback");
    ASSERT_TRUE (start.ok);
    httplib::Client cli (callback_origin (start));

    auto resp = cli.Get (
    "/callback?error=access_denied&error_description=User%20said%20no&state=" +
    state_of (start));
    ASSERT_TRUE (resp != nullptr);
    EXPECT_EQ (resp->status, 200);
    const auto st = mgr.status (start.attempt_id);
    EXPECT_EQ (st.state, "failed");
    EXPECT_EQ (st.error, "access_denied: User said no");
    EXPECT_EQ (idp.hits (), 0);
}

TEST_F (OAuthAuthorizeTest, LoopbackSettlesOnce) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    const json config = loopback_config (idp);
    auto start        = mgr.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok);
    httplib::Client cli (callback_origin (start));
    const std::string callback = "/callback?code=AUTHCODE&state=" + state_of (start);

    auto first = cli.Get (callback);
    ASSERT_TRUE (first != nullptr);
    EXPECT_EQ (first->status, 200);
    auto forged = cli.Get ("/callback?error=x&state=WRONG");
    ASSERT_TRUE (forged != nullptr);
    EXPECT_EQ (forged->status, 400);
    auto repeat = cli.Get (callback);
    ASSERT_TRUE (repeat != nullptr);
    EXPECT_EQ (repeat->status, 409);

    const auto st = mgr.status (start.attempt_id);
    EXPECT_EQ (st.state, "completed");
    EXPECT_EQ (st.error, "");
    EXPECT_EQ (st.cache_key, vayu::http::oauth::cache_key (config));
    expect_exchanged_token_stored (config, idp);
}

TEST_F (OAuthAuthorizeTest, CompleteDoesNotOverwriteASettledLoopbackAttempt) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    const json config = loopback_config (idp);
    auto start        = mgr.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok);
    httplib::Client cli (callback_origin (start));
    auto first = cli.Get ("/callback?code=AUTHCODE&state=" + state_of (start));
    ASSERT_TRUE (first != nullptr);
    ASSERT_EQ (first->status, 200);

    const auto again = mgr.complete (*db_, start.attempt_id, "http://x/cb?error=denied");
    EXPECT_EQ (again.state, "completed");
    EXPECT_EQ (mgr.status (start.attempt_id).error, "");
}

TEST_F (OAuthAuthorizeTest, StatusNotFoundForUnknownAttempt) {
    vayu::http::OAuth2AuthorizeManager mgr;
    EXPECT_EQ (mgr.status ("nope").state, "not_found");
}

TEST_F (OAuthAuthorizeTest, ShutdownStopsEveryAttemptAndRefusesLaterStarts) {
    vayu::http::OAuth2AuthorizeManager mgr;
    const json config = { { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" } };
    const auto start  = mgr.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok) << start.error_message;

    mgr.shutdown ();
    mgr.shutdown ();
    EXPECT_EQ (mgr.status (start.attempt_id).state, "not_found");

    httplib::Client cli (callback_origin (start));
    cli.set_connection_timeout (1, 0);
    EXPECT_EQ (cli.Get ("/callback"), nullptr)
    << "the callback is still listening";

    const auto refused = mgr.start (*db_, config, "loopback");
    EXPECT_FALSE (refused.ok);
    EXPECT_EQ (refused.http_status, 503);
    EXPECT_EQ (refused.error_code, "unavailable");
}

// A cancel ends a loopback callback's token exchange instead of waiting it
// out (#3345), and the callback still settles the attempt and answers its tab.
// Healthy: the exchange sees the cancel at its next libcurl progress tick,
// about a second. Broken: the cancel waits out the exchange's 30s timeout. Ten
// seconds sits between them. Mutation check: drop the cancel from the
// callback's `acquire_token` and the cancel takes 30s.
TEST_F (OAuthAuthorizeTest, CancelEndsTheTokenExchangeACallbackIsHeldIn) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    json config              = loopback_config (idp);
    config["accessTokenUrl"] = idp.url ("/token-hang");
    const auto start         = mgr.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok) << start.error_message;

    auto callback = std::async (std::launch::async, [&start] {
        httplib::Client cli (callback_origin (start));
        cli.set_read_timeout (40, 0);
        const auto res = cli.Get ("/callback?code=AUTHCODE&state=" + state_of (start));
        return res ? res->body : httplib::to_string (res.error ());
    });
    ASSERT_TRUE (vayu::tests::wait_until ([&idp] { return idp.hits () > 0; }))
    << "the callback never reached the token endpoint";

    const auto began = std::chrono::steady_clock::now ();
    mgr.cancel (start.attempt_id);
    EXPECT_LT (std::chrono::steady_clock::now () - began, vayu::tests::WAIT_DEADLINE / 2);
    const std::string page = callback.get ();
    EXPECT_NE (page.find ("Token exchange failed"), std::string::npos) << page;
}

// A manager whose reaper never runs inside a test, so what a test reads is
// what the call under test left behind.
vayu::http::AuthorizeTimings reaper_parked (std::chrono::milliseconds ttl) {
    vayu::http::AuthorizeTimings timings;
    timings.attempt_ttl   = ttl;
    timings.reap_interval = std::chrono::hours (1);
    return timings;
}

// A manager whose reaper runs every few milliseconds.
vayu::http::AuthorizeTimings reaper_running (std::chrono::milliseconds ttl) {
    vayu::http::AuthorizeTimings timings;
    timings.attempt_ttl   = ttl;
    timings.reap_interval = std::chrono::milliseconds (5);
    return timings;
}

int callback_port (const vayu::http::AuthorizeStart& start) {
    const std::string origin = callback_origin (start);
    return std::stoi (origin.substr (origin.rfind (':') + 1));
}

json embedded_config () {
    return { { "authorizationUrl", "https://idp/auth" }, { "clientId", "cid" },
        { "callbackUrl", "https://app/callback" } };
}

// The start answer carries the deadline the engine enforces, so a client keeps
// no clock of its own (#3347).
TEST_F (OAuthAuthorizeTest, StartReportsTheAttemptsExpiry) {
    constexpr std::chrono::milliseconds ttl = std::chrono::minutes (7);
    vayu::http::OAuth2AuthorizeManager mgr (reaper_parked (ttl));
    const int64_t before = now_ms ();
    const auto start     = mgr.start (*db_, embedded_config (), "embedded");
    const int64_t after  = now_ms ();
    ASSERT_TRUE (start.ok) << start.error_message;
    EXPECT_GE (start.expires_at, before + ttl.count ());
    EXPECT_LE (start.expires_at, after + ttl.count ());
}

// An attempt nobody polls frees its port at its deadline, and a late poller
// still reads why. Mutation check: drop the reaper's expiry claim, and the
// listener is never torn down.
TEST_F (OAuthAuthorizeTest, UnpolledAttemptFreesItsPortAtItsDeadline) {
    vayu::http::OAuth2AuthorizeManager mgr (
    reaper_running (std::chrono::milliseconds (50)));
    MockTokenServer idp;
    const auto start = mgr.start (*db_, loopback_config (idp), "loopback");
    ASSERT_TRUE (start.ok) << start.error_message;
    const int port = callback_port (start);

    ASSERT_TRUE (vayu::tests::wait_until (
    [port] { return !vayu::tests::accepts_connections (port); }))
    << "the expired attempt still holds its callback port";
    const auto st = mgr.status (start.attempt_id);
    EXPECT_EQ (st.state, "failed");
    EXPECT_EQ (st.error, "Authorization timed out");
    EXPECT_EQ (idp.hits (), 0);
}

// A settled result outlives its listener only for the retention window.
TEST_F (OAuthAuthorizeTest, SettledResultIsDroppedAfterItsRetention) {
    auto timings             = reaper_running (std::chrono::milliseconds (10));
    timings.record_retention = std::chrono::milliseconds (50);
    vayu::http::OAuth2AuthorizeManager mgr (timings);
    const auto start = mgr.start (*db_, embedded_config (), "embedded");
    ASSERT_TRUE (start.ok) << start.error_message;

    ASSERT_TRUE (vayu::tests::wait_until (
    [&] { return mgr.status (start.attempt_id).state == "not_found"; }))
    << "the settled result was never dropped";
}

// Reading a sign-in's status never changes it (#3347): two reads agree, and
// the loopback listener is still there for the redirect that completes it.
// Mutation check: have `status` retire a settled attempt's listener, as it
// once did, and the repeat callback finds nothing listening.
TEST_F (OAuthAuthorizeTest, StatusReadsWithoutChangingTheAttempt) {
    vayu::http::OAuth2AuthorizeManager mgr (reaper_parked (std::chrono::minutes (5)));
    MockTokenServer idp;
    const json config = loopback_config (idp);
    const auto start  = mgr.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok) << start.error_message;
    EXPECT_EQ (mgr.status (start.attempt_id).state, "pending");
    EXPECT_EQ (mgr.status (start.attempt_id).state, "pending");

    httplib::Client cli (callback_origin (start));
    const std::string callback = "/callback?code=AUTHCODE&state=" + state_of (start);
    auto first = cli.Get (callback);
    ASSERT_TRUE (first != nullptr);
    EXPECT_EQ (first->status, 200);

    const auto once  = mgr.status (start.attempt_id);
    const auto twice = mgr.status (start.attempt_id);
    EXPECT_EQ (once.state, "completed");
    EXPECT_EQ (twice.state, once.state);
    EXPECT_EQ (twice.cache_key, once.cache_key);
    auto repeat = cli.Get (callback);
    ASSERT_TRUE (repeat != nullptr) << "a status read tore the listener down";
    EXPECT_EQ (repeat->status, 409);
    expect_exchanged_token_stored (config, idp);
}

// Past its deadline, before the reaper reaches it, an attempt reads as the
// timeout the reaper will record, and reading it records nothing: the
// listener is still bound, and the late redirect cannot complete it.
// Mutation check: have `status` claim, fail and retire an expired attempt, as
// the lazy reap once did, and the listener is gone.
TEST_F (OAuthAuthorizeTest, StatusPastTheDeadlineReadsTheTimeoutWithoutRecordingIt) {
    vayu::http::OAuth2AuthorizeManager mgr (reaper_parked (std::chrono::milliseconds (1)));
    MockTokenServer idp;
    const auto start = mgr.start (*db_, loopback_config (idp), "loopback");
    ASSERT_TRUE (start.ok) << start.error_message;

    ASSERT_TRUE (vayu::tests::wait_until (
    [&] { return mgr.status (start.attempt_id).state == "failed"; }));
    const auto once  = mgr.status (start.attempt_id);
    const auto twice = mgr.status (start.attempt_id);
    EXPECT_EQ (once.error, "Authorization timed out");
    EXPECT_EQ (twice.state, "failed");
    EXPECT_EQ (twice.error, once.error);

    httplib::Client cli (callback_origin (start));
    auto late = cli.Get ("/callback?code=AUTHCODE&state=" + state_of (start));
    ASSERT_TRUE (late != nullptr) << "a status read tore the listener down";
    EXPECT_EQ (late->status, 410);
    EXPECT_EQ (mgr.status (start.attempt_id).state, "failed");
    EXPECT_EQ (idp.hits (), 0);

    const auto completed = mgr.complete (*db_, start.attempt_id,
    "https://app/callback?code=AUTHCODE&state=" + state_of (start));
    EXPECT_EQ (completed.state, "failed");
    EXPECT_EQ (idp.hits (), 0);
}

// The cap refuses the next attempt by name, not as a shutdown. Mutation check:
// answer `AtCapacity` with `refuse_shut_down`, and the code reads `unavailable`.
TEST_F (OAuthAuthorizeTest, CapRefusesTheNextAttemptByName) {
    vayu::http::OAuth2AuthorizeManager mgr (reaper_parked (std::chrono::minutes (5)));
    std::vector<std::string> ids;
    for (size_t i = 0; i < vayu::core::constants::oauth_authorize::MAX_ATTEMPTS; ++i) {
        const auto start = mgr.start (*db_, embedded_config (), "embedded");
        ASSERT_TRUE (start.ok) << "attempt " << i << ": " << start.error_message;
        ids.push_back (start.attempt_id);
    }

    const auto refused = mgr.start (*db_, embedded_config (), "embedded");
    EXPECT_FALSE (refused.ok);
    EXPECT_EQ (refused.http_status, 429);
    EXPECT_EQ (refused.error_code, "oauth2_authorize_limit_reached");

    mgr.cancel (ids.front ());
    EXPECT_TRUE (mgr.start (*db_, embedded_config (), "embedded").ok);
}

// A settled attempt holds no listener, so it leaves the cap once the reaper
// moves it aside, and its result is still readable.
TEST_F (OAuthAuthorizeTest, SettledAttemptLeavesTheCap) {
    vayu::http::OAuth2AuthorizeManager mgr (reaper_running (std::chrono::minutes (5)));
    std::vector<vayu::http::AuthorizeStart> started;
    for (size_t i = 0; i < vayu::core::constants::oauth_authorize::MAX_ATTEMPTS; ++i) {
        started.push_back (mgr.start (*db_, embedded_config (), "embedded"));
        ASSERT_TRUE (started.back ().ok) << started.back ().error_message;
    }
    const auto failed = mgr.complete (
    *db_, started.front ().attempt_id, "https://app/callback?state=WRONG");
    ASSERT_EQ (failed.state, "failed");

    ASSERT_TRUE (vayu::tests::wait_until (
    [&] { return mgr.start (*db_, embedded_config (), "embedded").ok; }))
    << "a settled attempt still holds a slot";
    EXPECT_EQ (mgr.status (started.front ().attempt_id).error, failed.error);
}

// Starts an embedded completion held at a token endpoint that never answers,
// ends it with @p stop, and returns how long @p stop took to end it and what
// the completion answered.
template <typename Stop>
std::pair<std::chrono::steady_clock::duration, vayu::http::AuthorizeStatus>
stop_a_held_embedded_completion (vayu::db::Database& db,
vayu::http::OAuth2AuthorizeManager& mgr,
Stop&& stop) {
    MockTokenServer idp;
    json config              = embedded_config ();
    config["grantType"]      = "authorization_code";
    config["accessTokenUrl"] = idp.url ("/token-hang");
    const auto start         = mgr.start (db, config, "embedded");
    EXPECT_TRUE (start.ok) << start.error_message;

    auto completion = std::async (std::launch::async, [&] {
        return mgr.complete (db, start.attempt_id,
        "https://app/callback?code=AUTHCODE&state=" + state_of (start));
    });
    EXPECT_TRUE (vayu::tests::wait_until ([&idp] { return idp.hits () > 0; }))
    << "the completion never reached the token endpoint";

    const auto began = std::chrono::steady_clock::now ();
    stop (start.attempt_id);
    auto status = completion.get ();
    return { std::chrono::steady_clock::now () - began, std::move (status) };
}

// A cancel ends an embedded completion's token exchange too (#3347).
// Healthy: about a second, one libcurl progress tick. Broken: the exchange's
// 30s timeout. Ten seconds sits between them. Mutation check: give the
// completion's `acquire_token` no cancel, and the cancel takes 30s.
TEST_F (OAuthAuthorizeTest, CancelEndsAnEmbeddedCompletionsTokenExchange) {
    vayu::http::OAuth2AuthorizeManager mgr;
    const auto [took, status] = stop_a_held_embedded_completion (
    *db_, mgr, [&mgr] (const std::string& id) { mgr.cancel (id); });
    EXPECT_LT (took, vayu::tests::WAIT_DEADLINE / 2);
    EXPECT_EQ (status.state, "not_found");
}

// The same bound for a shutdown, which `Server::stop` runs before it joins the
// handler making the exchange.
TEST_F (OAuthAuthorizeTest, ShutdownEndsAnEmbeddedCompletionsTokenExchange) {
    vayu::http::OAuth2AuthorizeManager mgr;
    const auto [took, status] = stop_a_held_embedded_completion (
    *db_, mgr, [&mgr] (const std::string&) { mgr.shutdown (); });
    EXPECT_LT (took, vayu::tests::WAIT_DEADLINE / 2);
    EXPECT_EQ (status.state, "not_found");
}

TEST_F (OAuthAuthorizeTest, CancelStopsAttempt) {
    vayu::http::OAuth2AuthorizeManager mgr;
    const json config = { { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" } };
    auto start        = mgr.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok);
    mgr.cancel (start.attempt_id);
    EXPECT_EQ (mgr.status (start.attempt_id).state, "not_found");
}

// ============================================================================
// A discovered attempt (#3766)
// ============================================================================

std::string decoded (const std::string& encoded) {
    return vayu::utils::url_decode (encoded);
}

DiscoveryAnswer json_answer (const json& body, int status = 200) {
    return DiscoveryAnswer{ status, body.dump (), "application/json", {} };
}

/// An MCP server at `/mcp` whose 401 names its protected resource metadata at
/// a path no well-known rule builds, and the authorization server `/tenant`
/// that protects it, with its authorize and token endpoints, all on one
/// in-process fixture.
class OAuthDiscoveredAuthorizeTest : public OAuthAuthorizeTest {
    protected:
    static constexpr const char* METADATA_PATH =
    "/.well-known/oauth-authorization-server/tenant";
    static constexpr const char* TOKEN_PATH   = "/tenant/token";
    static constexpr const char* CALLBACK_URL = "https://app/callback";

    void SetUp () override {
        OAuthAuthorizeTest::SetUp ();
        db_->seed_default_config ();
        // The default `proxyMode` is `environment`, and a runner that exports
        // `http_proxy` would send these fetches there instead of to loopback.
        auto proxy = db_->get_config_entry ("proxyMode");
        ASSERT_HAS_VALUE (proxy) << "proxyMode is not seeded";
        proxy->value = "off";
        db_->save_config_entry (*proxy);

        challenge_with (R"(Bearer resource_metadata=")" +
        server_.url ("/custom/prm") + R"(", scope="mcp:read")");
        server_.answer ("/custom/prm",
        json_answer ({ { "resource", server_.url ("/mcp") },
        { "authorization_servers", json::array ({ issuer () }) },
        { "scopes_supported", json::array ({ "mcp:read", "mcp:write" }) } }));
        serve_metadata (metadata ());
        server_.answer (TOKEN_PATH,
        json_answer ({ { "access_token", "AT-DISCOVERED" },
        { "token_type", "Bearer" }, { "expires_in", 3600 } }));
    }
    // Before the base's, which closes the database a live callback listener
    // writes through.
    void TearDown () override {
        mgr_.shutdown ();
        OAuthAuthorizeTest::TearDown ();
    }

    [[nodiscard]] std::string issuer () const {
        return server_.url ("/tenant");
    }
    [[nodiscard]] json metadata () const {
        return { { "issuer", issuer () },
            { "authorization_endpoint", issuer () + "/authorize" },
            { "token_endpoint", issuer () + "/token" },
            { "code_challenge_methods_supported", json::array ({ "S256" }) },
            { "authorization_response_iss_parameter_supported", true } };
    }
    void serve_metadata (const json& doc) {
        server_.answer (METADATA_PATH, json_answer (doc));
    }
    /// The MCP endpoint answering 401 with @p challenge.
    void challenge_with (const std::string& challenge) {
        server_.answer ("/mcp",
        DiscoveryAnswer{ 401, R"({"error":"unauthorized"})", "application/json",
        { { "WWW-Authenticate", challenge } } });
    }

    [[nodiscard]] json discovered_config () const {
        return { { "grantType", "authorization_code" },
            { "discoverUrl", server_.url ("/mcp") }, { "clientId", "typed-client" } };
    }
    [[nodiscard]] json embedded_discovered_config () const {
        json config           = discovered_config ();
        config["callbackUrl"] = CALLBACK_URL;
        return config;
    }

    vayu::http::AuthorizeStart start_embedded () {
        auto start = mgr_.start (*db_, embedded_discovered_config (), "embedded");
        EXPECT_TRUE (start.ok) << start.error_code << ": " << start.error_message;
        return start;
    }
    /// The embedded attempt's callback with its own state, a code and @p extra.
    vayu::http::AuthorizeStatus complete_with (const vayu::http::AuthorizeStart& start,
    const std::string& extra) {
        return mgr_.complete (*db_, start.attempt_id,
        std::string (CALLBACK_URL) + "?code=AUTHCODE&state=" + state_of (start) + extra);
    }

    DiscoveryServer server_;
    vayu::http::AuthorizationServerMetadataCache cache_;
    vayu::http::OAuth2AuthorizeManager mgr_{ {}, cache_ };
};

// Given the MCP server URL and a client id, the attempt finds every endpoint
// and sends the browser to the discovered authorization endpoint with
// `resource` and S256.
//
// Mutation check: leave `resolved` unset in `start` and the resolved block
// fails.
TEST_F (OAuthDiscoveredAuthorizeTest, DiscoveryFillsTheAuthorizeUrl) {
    const auto start = mgr_.start (*db_, discovered_config (), "loopback");
    ASSERT_TRUE (start.ok) << start.error_code << ": " << start.error_message;

    EXPECT_EQ (start.authorize_url.rfind (issuer () + "/authorize?", 0), 0U)
    << start.authorize_url;
    auto q = parse_q (query_of (start.authorize_url));
    EXPECT_EQ (q["client_id"], "typed-client");
    EXPECT_EQ (decoded (q["resource"]), server_.url ("/mcp"));
    EXPECT_EQ (q["code_challenge_method"], "S256");
    EXPECT_FALSE (q["code_challenge"].empty ());
    EXPECT_EQ (decoded (q["scope"]), "mcp:read");
    EXPECT_EQ (decoded (q["redirect_uri"]), start.redirect_uri);

    ASSERT_HAS_VALUE (start.resolved);
    EXPECT_EQ (start.resolved->authorization_url, issuer () + "/authorize");
    EXPECT_EQ (start.resolved->access_token_url, issuer () + "/token");
    EXPECT_EQ (start.resolved->client_id, "typed-client");
    EXPECT_EQ (start.resolved->resource, server_.url ("/mcp"));
    EXPECT_EQ (start.resolved->scope, "mcp:read");
    EXPECT_EQ (start.resolved->issuer, issuer ());
}

TEST_F (OAuthDiscoveredAuthorizeTest, NoClientIdIsRefused) {
    json config = discovered_config ();
    config.erase ("clientId");
    const auto start = mgr_.start (*db_, config, "loopback");
    EXPECT_FALSE (start.ok);
    EXPECT_EQ (start.http_status, 400);
    EXPECT_EQ (start.error_code, "oauth2_client_id_required");
    EXPECT_NE (start.error_message.find ("clientId"), std::string::npos)
    << start.error_message;
}

// Discovery fills only what the config leaves blank.
TEST_F (OAuthDiscoveredAuthorizeTest, TypedValuesWinOverDiscoveredOnes) {
    json config                = discovered_config ();
    config["authorizationUrl"] = "https://typed.example/auth";
    config["accessTokenUrl"]   = "https://typed.example/token";
    config["resource"]         = "https://typed.example/resource";
    config["scope"]            = "typed:scope";
    config["clientId"]         = "typed-client";
    const auto start           = mgr_.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok) << start.error_code << ": " << start.error_message;

    EXPECT_EQ (start.authorize_url.rfind ("https://typed.example/auth?", 0), 0U)
    << start.authorize_url;
    auto q = parse_q (query_of (start.authorize_url));
    EXPECT_EQ (decoded (q["resource"]), "https://typed.example/resource");
    EXPECT_EQ (decoded (q["scope"]), "typed:scope");
    ASSERT_HAS_VALUE (start.resolved);
    EXPECT_EQ (start.resolved->access_token_url, "https://typed.example/token");
    EXPECT_EQ (start.resolved->resource, "https://typed.example/resource");
    EXPECT_EQ (start.resolved->issuer, issuer ());
}

// The MCP spec's scope selection: the challenge's scope, else every scope the
// protected resource metadata lists, else no scope parameter at all.
TEST_F (OAuthDiscoveredAuthorizeTest, WithoutAChallengedScopeTheResourcesScopesAreAsked) {
    challenge_with (R"(Bearer resource_metadata=")" + server_.url ("/custom/prm") + R"(")");
    auto listed = mgr_.start (*db_, discovered_config (), "loopback");
    ASSERT_TRUE (listed.ok) << listed.error_code << ": " << listed.error_message;
    EXPECT_EQ (decoded (parse_q (query_of (listed.authorize_url))["scope"]), "mcp:read mcp:write");

    server_.answer ("/custom/prm",
    json_answer ({ { "resource", server_.url ("/mcp") },
    { "authorization_servers", json::array ({ issuer () }) } }));
    auto unlisted = mgr_.start (*db_, discovered_config (), "loopback");
    ASSERT_TRUE (unlisted.ok) << unlisted.error_code << ": " << unlisted.error_message;
    EXPECT_EQ (parse_q (query_of (unlisted.authorize_url)).count ("scope"), 0U)
    << unlisted.authorize_url;
    ASSERT_HAS_VALUE (unlisted.resolved);
    EXPECT_EQ (unlisted.resolved->scope, "");
}

TEST_F (OAuthDiscoveredAuthorizeTest, ADiscoveryFailureRefusesTheStartWithItsCode) {
    // No challenge and no well-known document: nothing says where the
    // metadata is.
    server_.answer ("/mcp", DiscoveryAnswer{ 401, "{}", "application/json", {} });
    const auto start = mgr_.start (*db_, discovered_config (), "loopback");
    EXPECT_FALSE (start.ok);
    EXPECT_EQ (start.http_status, 502);
    EXPECT_EQ (start.error_code, vayu::http::oauth_discovery::RESOURCE_METADATA_NOT_FOUND);
    EXPECT_NE (
    start.error_message.find ("/.well-known/oauth-protected-resource"), std::string::npos)
    << start.error_message;

    const auto invalid = mgr_.start (*db_,
    json{ { "grantType", "authorization_code" }, { "discoverUrl", "not a url" } },
    "loopback");
    EXPECT_EQ (invalid.http_status, 400);
    EXPECT_EQ (invalid.error_code, vayu::http::oauth_discovery::INVALID_SERVER_URL);
}

// The code is exchanged at the discovered token endpoint, with `resource`, and cached under the key the resolved values give.
//
// Mutation check: give the attempt the config as the caller sent it rather
// than the resolved one, and the exchange has no token endpoint.
TEST_F (OAuthDiscoveredAuthorizeTest, TheCodeIsExchangedWithTheResolvedConfig) {
    const auto start = start_embedded ();
    const auto st    = complete_with (start, "");
    ASSERT_EQ (st.state, "completed") << st.error;
    EXPECT_EQ (server_.hits (TOKEN_PATH), 1);

    auto form = vayu::tests::parse_form (server_.last_body (TOKEN_PATH));
    EXPECT_EQ (decoded (form["resource"]), server_.url ("/mcp"));
    EXPECT_EQ (form["client_id"], "typed-client");
    EXPECT_EQ (form["code"], "AUTHCODE");
    EXPECT_FALSE (form["code_verifier"].empty ());
    EXPECT_EQ (decoded (form["redirect_uri"]), CALLBACK_URL);

    ASSERT_HAS_VALUE (start.resolved);
    const json stored = { { "grantType", "authorization_code" },
        { "accessTokenUrl", start.resolved->access_token_url },
        { "clientId", start.resolved->client_id } };
    EXPECT_EQ (st.cache_key, vayu::http::oauth::cache_key (stored));
    const auto token = db_->get_oauth_token (st.cache_key);
    ASSERT_HAS_VALUE (token);
    EXPECT_EQ (token->access_token, "AT-DISCOVERED");
}

// The route answers `resolved` for a discovered attempt and only for one.
//
// Mutation check: leave `resolved` out of `oauth2_authorize_start`'s answer
// and the first half fails.
TEST_F (OAuthDiscoveredAuthorizeTest, TheStartRouteAnswersTheResolvedConfig) {
    const auto [status, body] = vayu::http::routes::oauth2_authorize_start (mgr_, *db_,
    json{ { "config", embedded_discovered_config () }, { "mode", "embedded" } }.dump (),
    nullptr);
    ASSERT_EQ (status, 200) << body.dump ();
    const json expected = { { "authorizationUrl", issuer () + "/authorize" },
        { "accessTokenUrl", issuer () + "/token" },
        { "clientId", "typed-client" }, { "resource", server_.url ("/mcp") },
        { "scope", "mcp:read" }, { "issuer", issuer () } };
    EXPECT_EQ (body.value ("resolved", json ()), expected) << body.dump ();

    const auto [plain_status, plain] =
    vayu::http::routes::oauth2_authorize_start (mgr_, *db_,
    json{ { "config", embedded_config () }, { "mode", "embedded" } }.dump (), nullptr);
    ASSERT_EQ (plain_status, 200) << plain.dump ();
    EXPECT_FALSE (plain.contains ("resolved")) << plain.dump ();

    const auto [refused_status, refused] =
    vayu::http::routes::oauth2_authorize_start (mgr_, *db_,
    json{ { "config", { { "discoverUrl", "not a url" } } } }.dump (), nullptr);
    EXPECT_EQ (refused_status, 400);
    EXPECT_EQ (refused["error"].value ("code", ""), vayu::http::oauth_discovery::INVALID_SERVER_URL)
    << refused.dump ();
}

} // namespace
