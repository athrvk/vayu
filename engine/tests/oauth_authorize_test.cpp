/**
 * @file tests/oauth_authorize_test.cpp
 * @brief Tests for the interactive authorization manager: URL building, state
 *        validation, embedded completion, and a full in-process loopback flow
 *        (simulated IdP redirect → token exchange against a mock token server).
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "oauth_token_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/http/oauth_authorize.hpp"
#include "vayu/http/oauth_client.hpp"

using nlohmann::json;
using vayu::tests::MockTokenServer;

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

// The status poll would stop the listener, so every late request goes in
// before the first poll.
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

TEST_F (OAuthAuthorizeTest, CancelStopsAttempt) {
    vayu::http::OAuth2AuthorizeManager mgr;
    const json config = { { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" } };
    auto start        = mgr.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok);
    mgr.cancel (start.attempt_id);
    EXPECT_EQ (mgr.status (start.attempt_id).state, "not_found");
}

} // namespace
