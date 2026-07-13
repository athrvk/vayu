/**
 * @file tests/oauth_route_test.cpp
 * @brief Tests for the /oauth2/token route helpers (post/get/delete).
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "vayu/db/database.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Declared in oauth.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> oauth2_token_post (vayu::db::Database& db, const std::string& body);
std::pair<int, nlohmann::json> oauth2_token_get (vayu::db::Database& db, const std::string& key);
std::pair<int, nlohmann::json> oauth2_token_delete (vayu::db::Database& db, const std::string& key);
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
        for (const char* s : { "", "-wal", "-shm", ".bak" }) {
            std::filesystem::remove (std::string (DB_PATH) + s);
        }
    }
    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (OAuthRouteTest, PostInvalidJsonIs400) {
    auto [status, body] = vayu::http::routes::oauth2_token_post (*db_, "not json");
    EXPECT_EQ (status, 400);
    EXPECT_EQ (body["error"]["code"], "oauth2_invalid_config");
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
