/**
 * @file tests/oauth_route_test.cpp
 * @brief Tests for the /oauth2/token route helpers (post/get/delete).
 */

#include <gtest/gtest.h>

#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "nested_json.hpp"
#include "oauth_token_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/oauth_client.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Declared in oauth.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json>
oauth2_token_post (vayu::db::Database& db, const std::string& body);
std::pair<int, nlohmann::json>
oauth2_token_get (vayu::db::Database& db, const std::string& key);
std::pair<int, nlohmann::json>
oauth2_token_delete (vayu::db::Database& db, const std::string& key);
} // namespace vayu::http::routes

namespace {

class OAuthRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_oauth_route.db";

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
    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (OAuthRouteTest, PostInvalidJsonIs400) {
    auto [status, body] = vayu::http::routes::oauth2_token_post (*db_, "not json");
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["code"], "oauth2_invalid_config");
}

// The code a body past the bound answers with is the route's own, not the
// generic `bad_request`; the deep value rides beside a config that would
// otherwise be tried, so a missing bound is not mistaken for a config error.
TEST_F (OAuthRouteTest, PostBodyNestedPastTheBoundIs400WithTheRouteCode) {
    auto [status, body] = vayu::http::routes::oauth2_token_post (*db_,
    R"({"config":{},"extra":)" + vayu::tests::nested_array_text (100000) + "}");
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["code"], "oauth2_invalid_config");
    EXPECT_EQ (body["error"]["message"].get<std::string> (),
    "request body is nested deeper than " +
    std::to_string (vayu::core::constants::request_body::MAX_JSON_DEPTH) + " levels");
}

TEST_F (OAuthRouteTest, PostInvalidConfigIs400) {
    auto [status, body] = vayu::http::routes::oauth2_token_post (
    *db_, R"({"config":{"grantType":"client_credentials"}})"); // no url/clientId
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["code"], "oauth2_invalid_config");
}

TEST_F (OAuthRouteTest, PostAuthCodeWithoutInteractiveIs409) {
    auto [status, body] = vayu::http::routes::oauth2_token_post (*db_,
    R"({"config":{"grantType":"authorization_code","accessTokenUrl":"https://idp/token","clientId":"c"}})");
    EXPECT_EQ (status, 409);
    EXPECT_EQ (body["error"]["code"], "oauth2_interactive_required");
}

// The app's "Get new token" posts `interactive` without `force`; the cached row
// must not answer for the code it carries (#2472).
TEST_F (OAuthRouteTest, PostInteractiveExchangesTheCodeOverACachedRow) {
    vayu::tests::MockTokenServer idp;
    const json config = { { "grantType", "authorization_code" },
        { "accessTokenUrl", idp.url ("/token") }, { "clientId", "cid" },
        { "clientSecret", "sec" } };

    vayu::db::OAuthToken cached;
    cached.cache_key    = vayu::http::oauth::cache_key (config);
    cached.access_token = "STALE-CACHED";
    cached.token_type   = "Bearer";
    cached.expires_in   = 0; // never expires: the cache would answer
    cached.created_at   = 1000;
    db_->save_oauth_token (cached);

    const json request = { { "config", config },
        { "interactive",
        { { "code", "CODE123" }, { "codeVerifier", "V" },
        { "redirectUri", "http://127.0.0.1:9/callback" } } } };
    auto [status, body] = vayu::http::routes::oauth2_token_post (*db_, request.dump ());

    EXPECT_EQ (status, 200);
    EXPECT_EQ (body["accessToken"], "AT1");
    EXPECT_EQ (idp.hits (), 1);
    const auto stored = db_->get_oauth_token (cached.cache_key);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->access_token, "AT1");
}

TEST_F (OAuthRouteTest, GetReportsNotFoundThenFound) {
    auto [s1, b1] = vayu::http::routes::oauth2_token_get (*db_, "missing");
    EXPECT_EQ (s1, 200);
    EXPECT_EQ (b1["found"], false);

    vayu::db::OAuthToken t;
    t.cache_key    = "k1";
    t.access_token = "a";
    t.token_type   = "Bearer";
    t.expires_in   = 0;
    t.created_at   = 1000;
    db_->save_oauth_token (t);

    auto [s2, b2] = vayu::http::routes::oauth2_token_get (*db_, "k1");
    EXPECT_EQ (s2, 200);
    EXPECT_EQ (b2["found"], true);
    EXPECT_EQ (b2["expired"], false);
    EXPECT_EQ (b2["token"]["accessToken"], "a");
    EXPECT_FALSE (b2["token"].contains ("refreshToken"));
}

TEST_F (OAuthRouteTest, DeleteReportsWhetherRowExisted) {
    vayu::db::OAuthToken t;
    t.cache_key    = "k2";
    t.access_token = "a";
    db_->save_oauth_token (t);

    auto [s1, b1] = vayu::http::routes::oauth2_token_delete (*db_, "k2");
    EXPECT_EQ (s1, 200);
    EXPECT_EQ (b1["deleted"], true);

    auto [s2, b2] = vayu::http::routes::oauth2_token_delete (*db_, "k2");
    EXPECT_EQ (b2["deleted"], false);
}

} // namespace
