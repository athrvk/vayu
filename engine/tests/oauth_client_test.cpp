/**
 * @file tests/oauth_client_test.cpp
 * @brief Tests for the OAuth 2.0 token client (acquire/cache/refresh) against
 *        a mock IdP, plus cache-key vectors shared with the app.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <filesystem>
#include <map>
#include <string>
#include <thread>
#include <variant>

#include <nlohmann/json.hpp>

#include "vayu/http/oauth_client.hpp"

using nlohmann::json;
namespace oauth = vayu::http::oauth;

namespace {

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

std::map<std::string, std::string> parse_form (const std::string& body) {
    std::map<std::string, std::string> out;
    size_t pos = 0;
    while (pos < body.size ()) {
        auto amp  = body.find ('&', pos);
        auto pair = body.substr (pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (auto eq = pair.find ('='); eq != std::string::npos) {
            out[pair.substr (0, eq)] = pair.substr (eq + 1);
        }
        if (amp == std::string::npos)
            break;
        pos = amp + 1;
    }
    return out;
}

// Mock IdP: one endpoint per behavior; records the last request for assertions.
class MockTokenServer {
    public:
    MockTokenServer () {
        svr_.Post (".*", [this] (const httplib::Request& req, httplib::Response& res) {
            ++hits_;
            last_path_ = req.path;
            last_body_ = req.body;
            last_auth_ = req.get_header_value ("Authorization");
            last_content_type_ = req.get_header_value ("Content-Type");
            const auto form    = parse_form (req.body);
            const auto grant   = form.count ("grant_type") ? form.at ("grant_type") : "";

            if (req.path == "/token") {
                res.set_content (R"({"access_token":"AT)" + std::to_string (hits_) +
                R"(","token_type":"Bearer","expires_in":3600,"refresh_token":"RT1","scope":"s1"})",
                "application/json");
            } else if (req.path == "/token-plain") {
                res.set_content (R"({"access_token":"AT-PLAIN"})", "application/json");
            } else if (req.path == "/token-legacy") {
                // Form-encoded body with a string expires_in (legacy GitHub style)
                res.set_content ("access_token=legacy&token_type=bearer&expires_in=1200",
                "text/plain");
            } else if (req.path == "/refresh-norotate") {
                if (grant == "refresh_token") {
                    res.set_content (R"({"access_token":"REFRESHED","expires_in":3600})",
                    "application/json");
                } else {
                    res.set_content (R"({"access_token":"FRESH","expires_in":3600})",
                    "application/json");
                }
            } else if (req.path == "/refresh-then-fresh") {
                if (grant == "refresh_token") {
                    res.status = 400;
                    res.set_content (R"({"error":"invalid_grant"})", "application/json");
                } else {
                    res.set_content (R"({"access_token":"FRESH-AFTER-REJECT","expires_in":3600})",
                    "application/json");
                }
            } else if (req.path == "/token-fail") {
                res.status = 400;
                res.set_content (
                R"({"error":"invalid_client","error_description":"bad secret"})",
                "application/json");
            } else {
                res.status = 404;
            }
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

    std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port_) + path;
    }
    int hits () const { return hits_; }
    const std::string& last_body () const { return last_body_; }
    const std::string& last_auth () const { return last_auth_; }
    const std::string& last_content_type () const { return last_content_type_; }

    private:
    httplib::Server svr_;
    int port_ = 0;
    int hits_ = 0;
    std::string last_path_, last_body_, last_auth_, last_content_type_;
    std::thread thread_;
};

class OAuthClientTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_oauth.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        for (const char* suffix : { "", "-wal", "-shm", ".bak" }) {
            std::filesystem::remove (std::string (DB_PATH) + suffix);
        }
    }

    json cc_config (const MockTokenServer& idp, const std::string& path = "/token") {
        return json{ { "grantType", "client_credentials" },
            { "accessTokenUrl", idp.url (path) }, { "clientId", "cid" },
            { "clientSecret", "sec" } };
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// ---------------------------------------------------------------------------
// cache_key - vectors shared verbatim with app/src/services/oauth/cache-key.ts
// ---------------------------------------------------------------------------

TEST (OAuthCacheKey, SharedVectors) {
    // Vector 1: minimal client_credentials
    EXPECT_EQ (oauth::cache_key (json{ { "grantType", "client_credentials" },
               { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" } }),
    "https://idp/token\x1f"
    "cid\x1f"
    "default\x1f");
    // Vector 2: password grant with explicit credentialsId
    EXPECT_EQ (oauth::cache_key (json{ { "grantType", "password" },
               { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" },
               { "credentialsId", "work" }, { "username", "u1" } }),
    "https://idp/token\x1f"
    "cid\x1f"
    "work\x1f"
    "u1");
    // Vector 3: username ignored outside password grant
    EXPECT_EQ (oauth::cache_key (json{ { "grantType", "client_credentials" },
               { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" },
               { "username", "u1" } }),
    "https://idp/token\x1f"
    "cid\x1f"
    "default\x1f");
}

TEST (OAuthExpiry, SkewAndNonExpiring) {
    vayu::db::OAuthToken t;
    t.created_at = 1'000'000;
    t.expires_in = 0;
    EXPECT_FALSE (oauth::is_expired (t, t.created_at + 999'999'999));

    t.expires_in = 3600; // expires at created_at + 3'600'000
    EXPECT_FALSE (oauth::is_expired (t, t.created_at + 3'600'000 - 46'000));
    EXPECT_TRUE (oauth::is_expired (t, t.created_at + 3'600'000 - 44'000)); // inside skew
    EXPECT_TRUE (oauth::is_expired (t, t.created_at + 3'600'001));
}

// ---------------------------------------------------------------------------
// acquire_token
// ---------------------------------------------------------------------------

TEST_F (OAuthClientTest, FetchesPersistsAndCaches) {
    MockTokenServer idp;
    auto r1 = oauth::acquire_token (*db_, cc_config (idp), false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r1));
    const auto& t1 = std::get<vayu::db::OAuthToken> (r1);
    EXPECT_EQ (t1.access_token, "AT1");
    EXPECT_EQ (t1.token_type, "Bearer");
    EXPECT_EQ (t1.refresh_token, "RT1");
    EXPECT_EQ (t1.expires_in, 3600);
    EXPECT_EQ (idp.hits (), 1);

    // Second acquisition is a cache hit - no extra IdP call.
    auto r2 = oauth::acquire_token (*db_, cc_config (idp), false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r2));
    EXPECT_EQ (std::get<vayu::db::OAuthToken> (r2).access_token, "AT1");
    EXPECT_EQ (idp.hits (), 1);

    // Grant + form encoding assertions
    auto form = parse_form (idp.last_body ());
    EXPECT_EQ (form["grant_type"], "client_credentials");
    EXPECT_EQ (idp.last_content_type (), "application/x-www-form-urlencoded");
}

TEST_F (OAuthClientTest, BasicHeaderClientAuthIsDefault) {
    MockTokenServer idp;
    oauth::acquire_token (*db_, cc_config (idp), false, std::nullopt);
    // base64("cid:sec")
    EXPECT_EQ (idp.last_auth (), "Basic Y2lkOnNlYw==");
    auto form = parse_form (idp.last_body ());
    EXPECT_EQ (form.count ("client_id"), 0u);
}

TEST_F (OAuthClientTest, BodyPlacementPutsCredsInForm) {
    MockTokenServer idp;
    auto config                    = cc_config (idp);
    config["credentialsPlacement"] = "body";
    oauth::acquire_token (*db_, config, false, std::nullopt);
    EXPECT_TRUE (idp.last_auth ().empty ());
    auto form = parse_form (idp.last_body ());
    EXPECT_EQ (form["client_id"], "cid");
    EXPECT_EQ (form["client_secret"], "sec");
}

TEST_F (OAuthClientTest, PublicClientSendsClientIdInBody) {
    MockTokenServer idp;
    auto config = cc_config (idp);
    config.erase ("clientSecret");
    oauth::acquire_token (*db_, config, false, std::nullopt);
    EXPECT_TRUE (idp.last_auth ().empty ());
    EXPECT_EQ (parse_form (idp.last_body ())["client_id"], "cid");
}

TEST_F (OAuthClientTest, PasswordGrantSendsUserCredsAndScope) {
    MockTokenServer idp;
    json config = { { "grantType", "password" }, { "accessTokenUrl", idp.url ("/token") },
        { "clientId", "cid" }, { "clientSecret", "sec" }, { "username", "u" },
        { "password", "p w" }, { "scope", "read write" } };
    auto r = oauth::acquire_token (*db_, config, false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    auto form = parse_form (idp.last_body ());
    EXPECT_EQ (form["grant_type"], "password");
    EXPECT_EQ (form["username"], "u");
    EXPECT_EQ (form["password"], "p%20w");
    EXPECT_EQ (form["scope"], "read%20write");
}

TEST_F (OAuthClientTest, MissingExpiresInMeansNonExpiring) {
    MockTokenServer idp;
    auto r = oauth::acquire_token (*db_, cc_config (idp, "/token-plain"), false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    const auto& t = std::get<vayu::db::OAuthToken> (r);
    EXPECT_EQ (t.expires_in, 0);
    EXPECT_EQ (t.token_type, "Bearer"); // defaulted
    // Cache hit on re-acquire (never expires)
    oauth::acquire_token (*db_, cc_config (idp, "/token-plain"), false, std::nullopt);
    EXPECT_EQ (idp.hits (), 1);
}

TEST_F (OAuthClientTest, FormEncodedResponseAndStringExpiresIn) {
    MockTokenServer idp;
    auto r = oauth::acquire_token (*db_, cc_config (idp, "/token-legacy"), false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    const auto& t = std::get<vayu::db::OAuthToken> (r);
    EXPECT_EQ (t.access_token, "legacy");
    EXPECT_EQ (t.expires_in, 1200);
}

TEST_F (OAuthClientTest, ExpiredTokenRefreshesAndKeepsOldRefreshToken) {
    MockTokenServer idp;
    auto config = cc_config (idp, "/refresh-norotate");

    vayu::db::OAuthToken stale;
    stale.cache_key     = oauth::cache_key (config);
    stale.access_token  = "OLD";
    stale.token_type    = "Bearer";
    stale.refresh_token = "RT_OLD";
    stale.expires_in    = 60;
    stale.created_at    = now_ms () - 3'600'000;
    db_->save_oauth_token (stale);

    auto r = oauth::acquire_token (*db_, config, false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    const auto& t = std::get<vayu::db::OAuthToken> (r);
    EXPECT_EQ (t.access_token, "REFRESHED");
    // Provider issued no new refresh token → the old one is carried forward.
    EXPECT_EQ (t.refresh_token, "RT_OLD");
    auto form = parse_form (idp.last_body ());
    EXPECT_EQ (form["grant_type"], "refresh_token");
    EXPECT_EQ (form["refresh_token"], "RT_OLD");
    // Persisted rotation is durable
    EXPECT_EQ (db_->get_oauth_token (stale.cache_key)->refresh_token, "RT_OLD");
}

TEST_F (OAuthClientTest, RejectedRefreshFallsBackToFreshGrant) {
    MockTokenServer idp;
    auto config = cc_config (idp, "/refresh-then-fresh");

    vayu::db::OAuthToken stale;
    stale.cache_key     = oauth::cache_key (config);
    stale.access_token  = "OLD";
    stale.refresh_token = "RT_DEAD";
    stale.expires_in    = 60;
    stale.created_at    = now_ms () - 3'600'000;
    db_->save_oauth_token (stale);

    auto r = oauth::acquire_token (*db_, config, false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    EXPECT_EQ (std::get<vayu::db::OAuthToken> (r).access_token, "FRESH-AFTER-REJECT");
    EXPECT_EQ (idp.hits (), 2); // failed refresh + fresh grant
}

TEST_F (OAuthClientTest, ProviderErrorIsStructured) {
    MockTokenServer idp;
    auto r = oauth::acquire_token (*db_, cc_config (idp, "/token-fail"), false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    const auto& err = std::get<oauth::TokenError> (r);
    EXPECT_EQ (err.http_status, 401);
    EXPECT_EQ (err.code, "oauth2_provider_error");
    EXPECT_EQ (err.provider_status, 400);
    EXPECT_EQ (err.provider_error, "invalid_client");
    EXPECT_EQ (err.provider_error_description, "bad secret");
}

TEST_F (OAuthClientTest, ConnectionFailureIsNetworkError) {
    json config = { { "grantType", "client_credentials" },
        { "accessTokenUrl", "http://127.0.0.1:1/token" }, { "clientId", "cid" } };
    auto r = oauth::acquire_token (*db_, config, false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    EXPECT_EQ (std::get<oauth::TokenError> (r).http_status, 502);
    EXPECT_EQ (std::get<oauth::TokenError> (r).code, "oauth2_network_error");
}

TEST_F (OAuthClientTest, AuthCodeWithoutInteractiveIs409) {
    json config = { { "grantType", "authorization_code" },
        { "accessTokenUrl", "https://idp.example/token" }, { "clientId", "cid" } };
    auto r = oauth::acquire_token (*db_, config, false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    EXPECT_EQ (std::get<oauth::TokenError> (r).http_status, 409);
    EXPECT_EQ (std::get<oauth::TokenError> (r).code, "oauth2_interactive_required");
}

TEST_F (OAuthClientTest, AuthCodeExchangeSendsCodeVerifierAndRedirect) {
    MockTokenServer idp;
    json config = { { "grantType", "authorization_code" },
        { "accessTokenUrl", idp.url ("/token") }, { "clientId", "cid" },
        { "clientSecret", "sec" } };
    oauth::InteractiveExchange ex{ "CODE123", "VERIFIER456",
        "http://127.0.0.1:9999/callback" };
    auto r = oauth::acquire_token (*db_, config, false, ex);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    auto form = parse_form (idp.last_body ());
    EXPECT_EQ (form["grant_type"], "authorization_code");
    EXPECT_EQ (form["code"], "CODE123");
    EXPECT_EQ (form["code_verifier"], "VERIFIER456");
    EXPECT_EQ (form["redirect_uri"], "http%3A%2F%2F127.0.0.1%3A9999%2Fcallback");
}

TEST_F (OAuthClientTest, InvalidConfigsAre400) {
    for (const json& config :
    { json (nullptr), json{ { "grantType", "client_credentials" } },
        json{ { "grantType", "client_credentials" }, { "accessTokenUrl", "ftp://x" }, { "clientId", "c" } },
        json{ { "grantType", "client_credentials" }, { "accessTokenUrl", "https://x" } },
        json{ { "grantType", "implicit" }, { "accessTokenUrl", "https://x" }, { "clientId", "c" } } }) {
        auto r = oauth::acquire_token (*db_, config, false, std::nullopt);
        ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
        EXPECT_EQ (std::get<oauth::TokenError> (r).http_status, 400);
        EXPECT_EQ (std::get<oauth::TokenError> (r).code, "oauth2_invalid_config");
    }
}

TEST_F (OAuthClientTest, DbRoundTrip) {
    vayu::db::OAuthToken t;
    t.cache_key     = "k1";
    t.access_token  = "a";
    t.token_type    = "Bearer";
    t.refresh_token = "r";
    t.scope         = "s";
    t.expires_in    = 10;
    t.created_at    = 42;
    t.raw_response  = "{}";
    db_->save_oauth_token (t);
    auto got = db_->get_oauth_token ("k1");
    ASSERT_TRUE (got.has_value ());
    EXPECT_EQ (got->access_token, "a");
    EXPECT_EQ (got->created_at, 42);
    db_->delete_oauth_token ("k1");
    EXPECT_FALSE (db_->get_oauth_token ("k1").has_value ());
}

TEST_F (OAuthClientTest, SerializeTokenShape) {
    vayu::db::OAuthToken t;
    t.cache_key     = "k";
    t.access_token  = "a";
    t.token_type    = "Bearer";
    t.refresh_token = "r";
    t.expires_in    = 100;
    t.created_at    = 1000;
    auto j          = oauth::serialize_token (t);
    EXPECT_EQ (j["expiresAt"], 101000);
    EXPECT_EQ (j["hasRefreshToken"], true);
    EXPECT_FALSE (j.contains ("refreshToken")); // value never exposed

    t.expires_in = 0;
    EXPECT_TRUE (oauth::serialize_token (t)["expiresAt"].is_null ());
}

} // namespace
