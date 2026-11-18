/**
 * @file tests/oauth_route_test.cpp
 * @brief Tests for the /oauth2/token route helpers (post/get/delete).
 */

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "jwt_keys.hpp"
#include "nested_json.hpp"
#include "oauth_token_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/utils/encoding.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Declared in oauth.cpp; returns {http_status, json_body}. No server owns
// these token requests, so nothing cancels them.
std::pair<int, nlohmann::json> oauth2_token_post (vayu::db::Database& db,
const std::string& body,
const std::atomic<bool>* cancel = nullptr);
std::pair<int, nlohmann::json>
oauth2_token_get (vayu::db::Database& db, const std::string& key);
std::pair<int, nlohmann::json>
oauth2_token_delete (vayu::db::Database& db, const std::string& key);
// Declared in config.cpp; how a test sets `defaultTimeout` as a client does.
std::pair<int, nlohmann::json>
apply_config_update (vayu::db::Database& db, const std::string& body);
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

// The route takes no `timeout`: the `defaultTimeout` setting bounds the token
// request (#2833), and running out of it is a 504 under its own code rather
// than a 502 network error. Healthy, this answers after about 1 s; reading the
// compiled-in 30 s instead, it answers after 30 s. The 15 s bound sits between.
TEST_F (OAuthRouteTest, PostAgainstAHungTokenEndpointIs504AtTheDefaultTimeout) {
    db_->init ();
    const json update{ { "entries", { { "defaultTimeout", "1000" } } } };
    const auto [config_status, config_body] =
    vayu::http::routes::apply_config_update (*db_, update.dump ());
    ASSERT_EQ (config_status, 200) << config_body.dump ();

    vayu::tests::MockTokenServer idp;
    const json request = { { "config",
    { { "grantType", "client_credentials" },
    { "accessTokenUrl", idp.url ("/token-hang") }, { "clientId", "cid" } } } };
    const auto started = std::chrono::steady_clock::now ();
    auto [status, body] = vayu::http::routes::oauth2_token_post (*db_, request.dump ());
    const auto elapsed = std::chrono::steady_clock::now () - started;

    EXPECT_EQ (status, 504) << body.dump ();
    EXPECT_EQ (body["error"]["code"], "oauth2_timeout");
    EXPECT_LT (elapsed, std::chrono::seconds (15));
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

// ---------------------------------------------------------------------------
// jwt_bearer: the key's reference resolves against the scopes named (#3632)
// ---------------------------------------------------------------------------

namespace jwt = vayu::tests::jwt;

class OAuthRouteJwtBearerTest : public OAuthRouteTest {
    protected:
    void SetUp () override {
        OAuthRouteTest::SetUp ();
        db_->init ();
    }

    static json jwt_config (const vayu::tests::MockTokenServer& idp, const std::string& key) {
        return json{ { "grantType", "jwt_bearer" },
            { "accessTokenUrl", idp.url ("/token") },
            { "clientId", "svc-client" }, { "subject", "alice@example.com" },
            { "assertionAudience", "https://idp.example/token" }, { "privateKey", key } };
    }

    /// `{name: {value, enabled, secret}}`, the stored variables shape.
    static std::string secret_variable (const std::string& name, const std::string& value) {
        return json{ { name, { { "value", value }, { "enabled", true }, { "secret", true } } } }
        .dump ();
    }

    void seed_environment (const std::string& variables) const {
        vayu::db::Environment env;
        env.id         = "env_1";
        env.name       = "Env";
        env.variables  = variables;
        env.created_at = 1;
        env.updated_at = 1;
        db_->save_environment (env);
    }

    void seed_collection (const std::string& variables) const {
        vayu::db::Collection col;
        col.id         = "col_1";
        col.name       = "Collection";
        col.variables  = variables;
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    /// The assertion the token endpoint last received.
    static std::string posted_assertion (const vayu::tests::MockTokenServer& idp) {
        const auto form  = vayu::tests::parse_form (idp.last_body ());
        const auto found = form.find ("assertion");
        return found == form.end () ? std::string () :
                                      vayu::utils::url_decode (found->second);
    }
};

// The app's Get new token sends the stored reference with the request's
// scopes; the engine signs with the key the scope holds, and the answer holds
// neither the key nor the assertion. Mutation check: drop the
// `resolve_token_signing_key` call from `oauth2_token_post` and both cases are
// refused as an unresolved reference.
TEST_F (OAuthRouteJwtBearerTest, AReferenceResolvesAgainstTheScopesTheBodyNames) {
    const std::string pem = jwt::pkcs8 (jwt::keys ().rsa);
    seed_environment (secret_variable ("env_key", pem));
    seed_collection (secret_variable ("collection_key", pem));

    for (const auto& [reference, scope] :
    { std::pair<std::string, json>{ "{{env_key}}", { { "environmentId", "env_1" } } },
    std::pair<std::string, json>{ "{{collection_key}}", { { "collectionId", "col_1" } } } }) {
        SCOPED_TRACE (reference);
        vayu::tests::MockTokenServer idp;
        json request      = scope;
        request["config"] = jwt_config (idp, reference);

        auto [status, body] =
        vayu::http::routes::oauth2_token_post (*db_, request.dump ());

        ASSERT_EQ (status, 200) << body.dump ();
        EXPECT_EQ (idp.hits (), 1);
        const std::string assertion = posted_assertion (idp);
        EXPECT_TRUE (jwt::verifies (assertion, jwt::public_half (jwt::keys ().rsa), "RS256"));
        EXPECT_EQ (body.dump ().find (assertion), std::string::npos);
        EXPECT_EQ (body.dump ().find ("PRIVATE KEY"), std::string::npos);
    }
}

TEST_F (OAuthRouteJwtBearerTest, AReferenceWithNoScopeNamedIs400) {
    vayu::tests::MockTokenServer idp;
    const json request = { { "config", jwt_config (idp, "{{signing_key}}") } };

    auto [status, body] = vayu::http::routes::oauth2_token_post (*db_, request.dump ());

    EXPECT_EQ (status, 400) << body.dump ();
    EXPECT_EQ (body["error"]["code"], "oauth2_invalid_config");
    const std::string message = body["error"]["message"].get<std::string> ();
    EXPECT_NE (message.find ("{{signing_key}}"), std::string::npos) << message;
    EXPECT_NE (message.find ("environmentId"), std::string::npos) << message;
    EXPECT_NE (message.find ("privateKeyFile"), std::string::npos) << message;
    EXPECT_EQ (idp.hits (), 0);
}

TEST_F (OAuthRouteJwtBearerTest, AReferenceNoNamedScopeDefinesIs400NamingIt) {
    seed_environment ("{}");
    vayu::tests::MockTokenServer idp;
    const json request = { { "config", jwt_config (idp, "{{signing_key}}") },
        { "environmentId", "env_1" } };

    auto [status, body] = vayu::http::routes::oauth2_token_post (*db_, request.dump ());

    EXPECT_EQ (status, 400) << body.dump ();
    EXPECT_EQ (body["error"]["code"], "oauth2_invalid_config");
    EXPECT_NE (
    body["error"]["message"].get<std::string> ().find ("{{signing_key}}"), std::string::npos)
    << body.dump ();
    EXPECT_EQ (idp.hits (), 0);
}

TEST_F (OAuthRouteJwtBearerTest, AScopeIdThatIsNotAStringIs400) {
    vayu::tests::MockTokenServer idp;
    for (const char* member : { "environmentId", "collectionId" }) {
        const json request = { { "config", jwt_config (idp, "{{signing_key}}") },
            { member, 7 } };

        auto [status, body] =
        vayu::http::routes::oauth2_token_post (*db_, request.dump ());

        EXPECT_EQ (status, 400) << body.dump ();
        EXPECT_EQ (body["error"]["code"], "oauth2_invalid_config");
        EXPECT_NE (body["error"]["message"].get<std::string> ().find (member),
        std::string::npos)
        << body.dump ();
    }
    EXPECT_EQ (idp.hits (), 0);
}

// A key file needs no scope: the path is the config's own.
TEST_F (OAuthRouteJwtBearerTest, AKeyFileSignsWithNoScopeNamed) {
    const std::string pem = jwt::pkcs8 (jwt::keys ().p256);
    const std::filesystem::path dir =
    std::filesystem::temp_directory_path () / "vayu-oauth-route-jwt-key-file";
    std::filesystem::create_directories (dir);
    const std::string path = (dir / "key.pem").string ();
    std::ofstream (path, std::ios::binary) << pem;
    const auto canonical = vayu::http::grantable_file_path (path);
    ASSERT_HAS_VALUE (canonical);
    vayu::FileGrant grant;
    grant.id         = "fgrant_route_key";
    grant.path       = *canonical;
    grant.created_at = 1;
    db_->save_file_grant (grant);

    vayu::tests::MockTokenServer idp;
    json config = jwt_config (idp, "");
    config.erase ("privateKey");
    config["privateKeyFile"]   = path;
    config["signingAlgorithm"] = "ES256";
    auto [status, body]        = vayu::http::routes::oauth2_token_post (
    *db_, json{ { "config", config } }.dump ());
    std::error_code ignored;
    std::filesystem::remove_all (dir, ignored);

    ASSERT_EQ (status, 200) << body.dump ();
    EXPECT_TRUE (jwt::verifies (
    posted_assertion (idp), jwt::public_half (jwt::keys ().p256), "ES256"));
}

} // namespace
