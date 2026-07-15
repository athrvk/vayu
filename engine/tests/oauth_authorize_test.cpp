/**
 * @file tests/oauth_authorize_test.cpp
 * @brief Tests for the interactive authorization manager: URL building, state
 *        validation, embedded completion, and a full in-process loopback flow
 *        (simulated IdP redirect → token exchange against a mock token server).
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <filesystem>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "vayu/http/oauth_authorize.hpp"

using nlohmann::json;

namespace {

// Mock token endpoint: accepts an authorization_code exchange, returns a token.
class MockTokenServer {
    public:
    MockTokenServer () {
        svr_.Post ("/token", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (
            R"({"access_token":"IATOKEN","token_type":"Bearer","expires_in":3600})",
            "application/json");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] { svr_.listen_after_bind (); });
        while (!svr_.is_running ())
            std::this_thread::sleep_for (std::chrono::milliseconds (5));
    }
    ~MockTokenServer () {
        svr_.stop ();
        if (thread_.joinable ())
            thread_.join ();
    }
    std::string token_url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/token";
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
};

// Extract the query string from a URL.
std::string query_of (const std::string& url) {
    const auto q = url.find ('?');
    return q == std::string::npos ? "" : url.substr (q + 1);
}
std::map<std::string, std::string> parse_q (const std::string& q) {
    std::map<std::string, std::string> out;
    size_t pos = 0;
    while (pos < q.size ()) {
        auto amp  = q.find ('&', pos);
        auto pair = q.substr (pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (auto eq = pair.find ('='); eq != std::string::npos)
            out[pair.substr (0, eq)] = pair.substr (eq + 1);
        if (amp == std::string::npos)
            break;
        pos = amp + 1;
    }
    return out;
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
        for (const char* s : { "", "-wal", "-shm", ".bak" })
            std::filesystem::remove (std::string (DB_PATH) + s);
    }
    // db_ declared before the manager is used in each test so the manager (with
    // any live listener capturing db_) is torn down first.
    std::unique_ptr<vayu::db::Database> db_;
};

TEST (BuildAuthorizeUrl, IncludesPkceAndParams) {
    const json config = { { "authorizationUrl", "https://idp.example/auth" },
        { "clientId", "cid" }, { "scope", "openid profile" } };
    const auto url = vayu::http::build_authorize_url (config, "STATE1", "CHALLENGE1",
    "http://127.0.0.1:5000/callback", true);
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

TEST_F (OAuthAuthorizeTest, StartRejectsIncompleteConfig) {
    vayu::http::OAuth2AuthorizeManager mgr;
    auto r = mgr.start (*db_, json{ { "clientId", "c" } }, "loopback");
    EXPECT_FALSE (r.ok);
    EXPECT_EQ (r.error_code, "oauth2_invalid_config");
}

TEST_F (OAuthAuthorizeTest, EmbeddedRequiresCallbackUrl) {
    vayu::http::OAuth2AuthorizeManager mgr;
    auto r = mgr.start (*db_,
    json{ { "authorizationUrl", "https://idp/auth" }, { "clientId", "c" } },
    "embedded");
    EXPECT_FALSE (r.ok);
}

TEST_F (OAuthAuthorizeTest, EmbeddedRejectsStateMismatch) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    const json config = { { "grantType", "authorization_code" },
        { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", idp.token_url () }, { "clientId", "cid" },
        { "clientSecret", "sec" }, { "callbackUrl", "https://app/callback" } };

    auto start = mgr.start (*db_, config, "embedded");
    ASSERT_TRUE (start.ok);
    auto st = mgr.complete (*db_, start.attempt_id,
    "https://app/callback?code=XYZ&state=WRONG");
    EXPECT_EQ (st.state, "failed");
    EXPECT_NE (st.error.find ("State"), std::string::npos);
}

TEST_F (OAuthAuthorizeTest, EmbeddedCompletesAndExchanges) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    const json config = { { "grantType", "authorization_code" },
        { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", idp.token_url () }, { "clientId", "cid" },
        { "clientSecret", "sec" }, { "callbackUrl", "https://app/callback" } };

    auto start = mgr.start (*db_, config, "embedded");
    ASSERT_TRUE (start.ok);
    // Pull the real state out of the authorize URL so the callback matches.
    const std::string state = parse_q (query_of (start.authorize_url))["state"];

    auto st = mgr.complete (*db_, start.attempt_id,
    "https://app/callback?code=AUTHCODE&state=" + state);
    EXPECT_EQ (st.state, "completed");
    EXPECT_FALSE (st.cache_key.empty ());
    EXPECT_TRUE (db_->get_oauth_token (st.cache_key).has_value ());
}

TEST_F (OAuthAuthorizeTest, LoopbackEndToEnd) {
    vayu::http::OAuth2AuthorizeManager mgr;
    MockTokenServer idp;
    const json config = { { "grantType", "authorization_code" },
        { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", idp.token_url () }, { "clientId", "cid" },
        { "clientSecret", "sec" } };

    auto start = mgr.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok);
    EXPECT_EQ (mgr.status (start.attempt_id).state, "pending");

    // Simulate the IdP redirecting the browser to the loopback callback.
    const std::string state = parse_q (query_of (start.authorize_url))["state"];
    httplib::Client cli (start.redirect_uri.substr (0, start.redirect_uri.find ("/callback")));
    auto resp = cli.Get ("/callback?code=AUTHCODE&state=" + state);
    ASSERT_TRUE (resp != nullptr);
    EXPECT_EQ (resp->status, 200);

    auto st = mgr.status (start.attempt_id);
    EXPECT_EQ (st.state, "completed");
    EXPECT_TRUE (db_->get_oauth_token (st.cache_key).has_value ());
}

TEST_F (OAuthAuthorizeTest, StatusNotFoundForUnknownAttempt) {
    vayu::http::OAuth2AuthorizeManager mgr;
    EXPECT_EQ (mgr.status ("nope").state, "not_found");
}

TEST_F (OAuthAuthorizeTest, CancelStopsAttempt) {
    vayu::http::OAuth2AuthorizeManager mgr;
    const json config = { { "authorizationUrl", "https://idp/auth" },
        { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" } };
    auto start = mgr.start (*db_, config, "loopback");
    ASSERT_TRUE (start.ok);
    mgr.cancel (start.attempt_id);
    EXPECT_EQ (mgr.status (start.attempt_id).state, "not_found");
}

} // namespace
