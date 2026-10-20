/**
 * @file tests/oauth_client_test.cpp
 * @brief Tests for the OAuth 2.0 token client (acquire/cache/refresh) against
 *        a mock IdP, plus cache-key vectors shared with the app.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <string>
#include <variant>

#include <nlohmann/json.hpp>

#include "oauth_token_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/http/oauth_client.hpp"

using nlohmann::json;
namespace oauth = vayu::http::oauth;
using vayu::tests::MockTokenServer;
using vayu::tests::parse_form;

namespace {

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

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
        vayu::tests::remove_database_files (DB_PATH);
    }

    json cc_config (const MockTokenServer& idp, const std::string& path = "/token") {
        return json{ { "grantType", "client_credentials" },
            { "accessTokenUrl", idp.url (path) }, { "clientId", "cid" },
            { "clientSecret", "sec" } };
    }


    // An interactive exchange spends the authorization code the user just
    // granted; a cached row, fresh or stale, must not answer in its place
    // (#2472). The helpers below serve those tests.
    static json auth_code_config (const MockTokenServer& idp) {
        return json{ { "grantType", "authorization_code" },
            { "accessTokenUrl", idp.url ("/token-plain") },
            { "clientId", "cid" }, { "clientSecret", "sec" } };
    }

    static vayu::db::OAuthToken seeded_row (const json& config, int64_t age_ms) {
        vayu::db::OAuthToken row;
        row.cache_key     = oauth::cache_key (config);
        row.access_token  = "OLD";
        row.token_type    = "Bearer";
        row.refresh_token = "RT_OLD";
        row.expires_in    = 3600;
        row.created_at    = now_ms () - age_ms;
        return row;
    }

    // Runs one interactive acquire over `row` and checks that the code, and
    // nothing else, went to the provider and that the result replaced the row.
    void expect_code_exchanged (const MockTokenServer& idp,
    const json& config,
    const vayu::db::OAuthToken& row,
    bool force) {
        db_->save_oauth_token (row);
        const oauth::InteractiveExchange exchange{ "CODE123", "VERIFIER456",
            "http://127.0.0.1:9999/callback" };

        auto result = oauth::acquire_token (*db_, config, force, exchange);

        ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
        EXPECT_EQ (std::get<vayu::db::OAuthToken> (result).access_token, "AT-PLAIN");
        EXPECT_EQ (idp.hits (), 1);
        const auto form = parse_form (idp.last_body ());
        EXPECT_EQ (form.at ("grant_type"), "authorization_code");
        EXPECT_EQ (form.at ("code"), "CODE123");
        EXPECT_EQ (form.count ("refresh_token"), 0u);

        const auto stored = db_->get_oauth_token (row.cache_key);
        ASSERT_HAS_VALUE (stored);
        EXPECT_EQ (stored->access_token, "AT-PLAIN");
        EXPECT_TRUE (stored->refresh_token.empty ())
        << "the old refresh token belongs to the refresh path only";
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
    // Vector 4: extra parameter rows (issue #2536), one segment per list in
    // the order authorization, token, refresh, each row's pairs sorted by key
    // then value; sendAs is not read.
    EXPECT_EQ (
    oauth::cache_key (json{ { "grantType", "client_credentials" },
    { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" },
    { "refreshParams", json::array ({ { { "key", "audience" }, { "value", "api" } } }) },
    { "tokenParams",
    json::array ({ { { "key", "tenant" }, { "value", "t1" }, { "sendAs", "url" } },
    { { "key", "audience" }, { "value", "b" } },
    { { "key", "audience" }, { "value", "a" }, { "sendAs", "header" } } }) },
    { "authorizationParams", json::array ({ { { "key", "prompt" }, { "value", "login" } } }) } }),
    "https://idp/token\x1f"
    "cid\x1f"
    "default\x1f"
    "\x1f"
    "authorizationParams:prompt=login\x1f"
    "tokenParams:audience=a\x1e"
    "audience=b\x1e"
    "tenant=t1\x1f"
    "refreshParams:audience=api");
    // Vector 5: rows the engine would never send add nothing - disabled, no
    // key, an engine-written name, an unknown sendAs, a non-object row - and
    // neither does a list that is not an array. A non-string value reads "".
    EXPECT_EQ (
    oauth::cache_key (json{ { "grantType", "client_credentials" },
    { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" },
    { "tokenParams",
    json::array ({ { { "key", "a" }, { "value", "1" }, { "enabled", false } },
    { { "key", "" }, { "value", "1" } }, { { "key", 7 }, { "value", "1" } },
    { { "key", "scope" }, { "value", "x" } },
    { { "key", "b" }, { "value", "1" }, { "sendAs", "cookie" } }, "row", 3 }) },
    { "refreshParams", "audience=api" },
    { "authorizationParams", json::array ({ { { "key", "n" }, { "value", 5 } } }) } }),
    "https://idp/token\x1f"
    "cid\x1f"
    "default\x1f"
    "\x1f"
    "authorizationParams:n=");
    // Vector 6: a row whose key names a credential - a parameter's name or a
    // header's, matched as the export's redaction matches it - is keyed by its
    // name with an empty value, sorted among the rest as that.
    EXPECT_EQ (
    oauth::cache_key (json{ { "grantType", "client_credentials" },
    { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" },
    { "tokenParams",
    json::array ({ { { "key", "client_assertion" }, { "value", "eyJhbGciOi.e30.sig" } },
    { { "key", "X-Api-Key" }, { "value", "k-123" }, { "sendAs", "header" } },
    { { "key", "audience" }, { "value", "api" } } }) } }),
    "https://idp/token\x1f"
    "cid\x1f"
    "default\x1f"
    "\x1f"
    "tokenParams:X-Api-Key=\x1e"
    "audience=api\x1e"
    "client_assertion=");
}

// The cache key is handed to clients (`cacheKey`) and stored as the token
// row's primary key, so a credential row contributes its name alone: two
// configs differing only in a client assertion share one token, while an
// ordinary row's value still separates two.
// Mutation-check: key a credential row by its value in
// `extra_params_key_segment` and the first two expectations fail.
TEST (OAuthCacheKey, CredentialRowsAreKeyedByNameAlone) {
    const json base = { { "grantType", "client_credentials" },
        { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" } };
    const auto with_rows = [&base] (const std::string& assertion, const std::string& audience) {
        json config = base;
        config["tokenParams"] =
        json::array ({ { { "key", "client_assertion" }, { "value", assertion } },
        { { "key", "audience" }, { "value", audience } } });
        return oauth::cache_key (config);
    };

    const std::string key = with_rows ("jwt-1", "api");
    EXPECT_EQ (key, with_rows ("jwt-2", "api"));
    EXPECT_EQ (key.find ("jwt-1"), std::string::npos) << key;
    EXPECT_NE (key, with_rows ("jwt-1", "other-api"));
}

// Row order is not part of the key: two configs listing the same rows in a
// different order share one cached token. A row's value is, so two audiences
// on one token URL do not.
TEST (OAuthCacheKey, ExtraParamsSeparateTokensButNotRowOrder) {
    const json base   = { { "grantType", "client_credentials" },
          { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" } };
    const json first  = { { "key", "audience" }, { "value", "api-1" } };
    const json second = { { "key", "organization" }, { "value", "org" } };

    json forward            = base;
    forward["tokenParams"]  = json::array ({ first, second });
    json reversed           = base;
    reversed["tokenParams"] = json::array ({ second, first });
    json other_audience     = base;
    other_audience["tokenParams"] =
    json::array ({ { { "key", "audience" }, { "value", "api-2" } }, second });

    EXPECT_EQ (oauth::cache_key (forward), oauth::cache_key (reversed));
    EXPECT_NE (oauth::cache_key (forward), oauth::cache_key (other_audience));
    EXPECT_NE (oauth::cache_key (forward), oauth::cache_key (base));

    json disabled           = base;
    disabled["tokenParams"] = json::array (
    { { { "key", "audience" }, { "value", "api-1" }, { "enabled", false } } });
    EXPECT_EQ (oauth::cache_key (disabled), oauth::cache_key (base));
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

// The caller's `network_ms` is how a send tells the provider's wait from its own
// cost (#2185): a round trip adds to it, a cached token leaves it untouched.
TEST_F (OAuthClientTest, NetworkMsCountsTheProviderRoundTripAndNotACacheHit) {
    MockTokenServer idp;
    double network_ms = 0.0;
    oauth::acquire_token (*db_, cc_config (idp), false, std::nullopt, &network_ms);
    ASSERT_EQ (idp.hits (), 1);
    EXPECT_GT (network_ms, 0.0);

    const double after_fetch = network_ms;
    oauth::acquire_token (*db_, cc_config (idp), false, std::nullopt, &network_ms);
    ASSERT_EQ (idp.hits (), 1) << "the second call must be a cache hit";
    EXPECT_EQ (network_ms, after_fetch);
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

// RFC 6749 section 2.3.1: the id and secret are form-encoded before the Basic
// header's base64, so a provider expecting them raw needs body placement.
TEST_F (OAuthClientTest, BasicHeaderFormEncodesReservedCharactersInTheSecret) {
    MockTokenServer idp;
    auto config            = cc_config (idp);
    config["clientSecret"] = "a+b/c=";
    oauth::acquire_token (*db_, config, false, std::nullopt);
    // base64("cid:a%2Bb%2Fc%3D")
    EXPECT_EQ (idp.last_auth (), "Basic Y2lkOmElMkJiJTJGYyUzRA==");
}

// parse_form does not decode, so the form-encoded secret is what the IdP read.
TEST_F (OAuthClientTest, BodyPlacementFormEncodesReservedCharactersInTheSecret) {
    MockTokenServer idp;
    auto config                    = cc_config (idp);
    config["clientSecret"]         = "a+b/c=";
    config["credentialsPlacement"] = "body";
    oauth::acquire_token (*db_, config, false, std::nullopt);
    EXPECT_TRUE (idp.last_auth ().empty ());
    EXPECT_EQ (parse_form (idp.last_body ())["client_secret"], "a%2Bb%2Fc%3D");
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

// How many times @p name= appears as a whole parameter in a form body.
size_t form_occurrences (const std::string& body, const std::string& name) {
    size_t count             = 0;
    const std::string wanted = name + "=";
    for (size_t at = body.find (wanted); at != std::string::npos;
    at             = body.find (wanted, at + 1)) {
        if (at == 0 || body[at - 1] == '&') {
            ++count;
        }
    }
    return count;
}

// An audience an import promoted to the config is sent once in the token
// form, and each extra row rides where its sendAs says (issue #2536).
TEST_F (OAuthClientTest, TokenParamsRideWhereSendAsSays) {
    MockTokenServer idp;
    auto config           = cc_config (idp);
    config["audience"]    = "https://api.example";
    config["tokenParams"] = json::array ({
    { { "key", "organization" }, { "value", "org 1" }, { "enabled", true } },
    { { "key", "tenant" }, { "value", "t1" }, { "sendAs", "url" } },
    { { "key", "X-Trace" }, { "value", "abc" }, { "sendAs", "header" } },
    });

    oauth::acquire_token (*db_, config, false, std::nullopt);

    const auto form = parse_form (idp.last_body ());
    EXPECT_EQ (form.at ("audience"), "https%3A%2F%2Fapi.example");
    EXPECT_EQ (form.at ("organization"), "org%201");
    EXPECT_EQ (form.count ("tenant"), 0u);
    EXPECT_EQ (form.count ("X-Trace"), 0u);
    EXPECT_EQ (idp.last_target (), "/token?tenant=t1");
    EXPECT_EQ (idp.last_header ("X-Trace"), "abc");
}

// The engine's own value wins over a row naming it, and nothing goes on the
// wire twice: a reserved name, an audience the config already sends, a
// header the engine set. A disabled row is not sent at all.
TEST_F (OAuthClientTest, TokenParamsNeverRepeatWhatTheEngineWrote) {
    MockTokenServer idp;
    auto config           = cc_config (idp);
    config["audience"]    = "cfg";
    config["scope"]       = "read";
    config["tokenParams"] = json::array ({
    { { "key", "scope" }, { "value", "admin" } },
    { { "key", "grant_type" }, { "value", "password" }, { "sendAs", "url" } },
    { { "key", "audience" }, { "value", "row" } },
    { { "key", "audience" }, { "value", "row" }, { "sendAs", "url" } },
    { { "key", "accept" }, { "value", "text/html" }, { "sendAs", "header" } },
    { { "key", "authorization" }, { "value", "Bearer x" }, { "sendAs", "header" } },
    { { "key", "Bad Name" }, { "value", "v" }, { "sendAs", "header" } },
    { { "key", "X-Split" }, { "value", "a\r\nInjected: 1" }, { "sendAs", "header" } },
    { { "key", "off" }, { "value", "1" }, { "enabled", false } },
    });

    oauth::acquire_token (*db_, config, false, std::nullopt);

    const std::string& body = idp.last_body ();
    EXPECT_EQ (form_occurrences (body, "audience"), 1u);
    EXPECT_EQ (form_occurrences (body, "scope"), 1u);
    EXPECT_EQ (form_occurrences (body, "grant_type"), 1u);
    EXPECT_EQ (parse_form (body).at ("audience"), "cfg");
    EXPECT_EQ (parse_form (body).at ("scope"), "read");
    EXPECT_EQ (form_occurrences (body, "off"), 0u);
    EXPECT_EQ (idp.last_target (), "/token") << "no row reached the query";
    EXPECT_EQ (idp.header_count ("Accept"), 1u);
    EXPECT_EQ (idp.last_header ("Accept"), "application/json");
    EXPECT_EQ (idp.last_auth (), "Basic Y2lkOnNlYw==");
    EXPECT_EQ (idp.header_count ("X-Split"), 0u);
    EXPECT_EQ (idp.header_count ("Injected"), 0u);
}

// Mutation-check: send a row whatever its `enabled` says and the disabled
// audience reaches the form.
TEST_F (OAuthClientTest, ADisabledTokenParamIsNotSent) {
    MockTokenServer idp;
    auto config           = cc_config (idp);
    config["tokenParams"] = json::array (
    { { { "key", "audience" }, { "value", "api" }, { "enabled", false } } });

    oauth::acquire_token (*db_, config, false, std::nullopt);

    EXPECT_EQ (parse_form (idp.last_body ()).count ("audience"), 0u);
}

// A refresh sends refreshParams and not tokenParams, and still not the
// config's audience, which a provider reads only on the first grant.
TEST_F (OAuthClientTest, RefreshSendsRefreshParamsOnly) {
    MockTokenServer idp;
    auto config        = cc_config (idp, "/refresh-norotate");
    config["audience"] = "cfg";
    config["tokenParams"] =
    json::array ({ { { "key", "organization" }, { "value", "org" } } });
    config["refreshParams"] = json::array ({
    { { "key", "audience" }, { "value", "refresh-aud" } },
    { { "key", "region" }, { "value", "eu" }, { "sendAs", "url" } },
    { { "key", "X-Refresh" }, { "value", "1" }, { "sendAs", "header" } },
    { { "key", "refresh_token" }, { "value", "FORGED" } },
    });
    db_->save_oauth_token (seeded_row (config, 7'200'000));

    auto result = oauth::acquire_token (*db_, config, false, std::nullopt);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    EXPECT_EQ (std::get<vayu::db::OAuthToken> (result).access_token, "REFRESHED");
    const std::string& body = idp.last_body ();
    const auto form         = parse_form (body);
    EXPECT_EQ (form.at ("grant_type"), "refresh_token");
    EXPECT_EQ (form.at ("refresh_token"), "RT_OLD");
    EXPECT_EQ (form_occurrences (body, "refresh_token"), 1u);
    EXPECT_EQ (form.at ("audience"), "refresh-aud");
    EXPECT_EQ (form.count ("organization"), 0u);
    EXPECT_EQ (idp.last_target (), "/refresh-norotate?region=eu");
    EXPECT_EQ (idp.last_header ("X-Refresh"), "1");
}

// Two configs differing only in an audience row are two tokens: the second
// is fetched, not answered from the first's cache row.
TEST_F (OAuthClientTest, AnAudienceRowSeparatesCachedTokens) {
    MockTokenServer idp;
    auto first = cc_config (idp);
    first["tokenParams"] = json::array ({ { { "key", "audience" }, { "value", "a" } } });
    auto second = cc_config (idp);
    second["tokenParams"] =
    json::array ({ { { "key", "audience" }, { "value", "b" } } });

    auto r1 = oauth::acquire_token (*db_, first, false, std::nullopt);
    auto r2 = oauth::acquire_token (*db_, second, false, std::nullopt);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r1));
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r2));
    EXPECT_EQ (idp.hits (), 2);
    EXPECT_NE (std::get<vayu::db::OAuthToken> (r1).access_token,
    std::get<vayu::db::OAuthToken> (r2).access_token);
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
    auto r =
    oauth::acquire_token (*db_, cc_config (idp, "/token-legacy"), false, std::nullopt);
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
    const auto stored_token = db_->get_oauth_token (stale.cache_key);
    ASSERT_HAS_VALUE (stored_token);
    EXPECT_EQ (stored_token->refresh_token, "RT_OLD");
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
    auto r      = oauth::acquire_token (*db_, config, false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    EXPECT_EQ (std::get<oauth::TokenError> (r).http_status, 502);
    EXPECT_EQ (std::get<oauth::TokenError> (r).code, "oauth2_network_error");
}

TEST_F (OAuthClientTest, AuthCodeWithoutInteractiveIs409) {
    json config = { { "grantType", "authorization_code" },
        { "accessTokenUrl", "https://idp.example/token" }, { "clientId", "cid" } };
    auto r      = oauth::acquire_token (*db_, config, false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    EXPECT_EQ (std::get<oauth::TokenError> (r).http_status, 409);
    EXPECT_EQ (std::get<oauth::TokenError> (r).code, "oauth2_interactive_required");
}

TEST_F (OAuthClientTest, AuthCodeExchangeSendsCodeVerifierAndRedirect) {
    MockTokenServer idp;
    json config = { { "grantType", "authorization_code" },
        { "accessTokenUrl", idp.url ("/token") }, { "clientId", "cid" },
        { "clientSecret", "sec" } };
    oauth::InteractiveExchange ex{ "CODE123", "VERIFIER456", "http://127.0.0.1:9999/callback" };
    auto r = oauth::acquire_token (*db_, config, false, ex);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    auto form = parse_form (idp.last_body ());
    EXPECT_EQ (form["grant_type"], "authorization_code");
    EXPECT_EQ (form["code"], "CODE123");
    EXPECT_EQ (form["code_verifier"], "VERIFIER456");
    EXPECT_EQ (form["redirect_uri"], "http%3A%2F%2F127.0.0.1%3A9999%2Fcallback");
}

// An interactive exchange spends the authorization code the user just granted;
// a cached row, fresh or stale, must not answer in its place (#2472).
TEST_F (OAuthClientTest, ExchangesTheCodeOverAnUnexpiredRow) {
    MockTokenServer idp;
    const auto config = auth_code_config (idp);
    expect_code_exchanged (idp, config, seeded_row (config, 0), false);
}

TEST_F (OAuthClientTest, ExchangesTheCodeOverAnExpiredRowWithARefreshToken) {
    MockTokenServer idp;
    const auto config = auth_code_config (idp);
    auto row          = seeded_row (config, 7'200'000);
    ASSERT_TRUE (oauth::is_expired (row, now_ms ()));
    expect_code_exchanged (idp, config, row, false);
}

TEST_F (OAuthClientTest, InteractiveWinsOverForce) {
    MockTokenServer idp;
    const auto config = auth_code_config (idp);
    expect_code_exchanged (idp, config, seeded_row (config, 0), true);
}

TEST_F (OAuthClientTest, NonInteractiveStillAnswersFromTheCache) {
    MockTokenServer idp;
    const auto config = auth_code_config (idp);
    db_->save_oauth_token (seeded_row (config, 0));

    auto result = oauth::acquire_token (*db_, config, false, std::nullopt);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    EXPECT_EQ (std::get<vayu::db::OAuthToken> (result).access_token, "OLD");
    EXPECT_EQ (idp.hits (), 0);
}

TEST_F (OAuthClientTest, InvalidConfigsAre400) {
    for (const json& config :
    { json (nullptr), json{ { "grantType", "client_credentials" } },
    json{ { "grantType", "client_credentials" },
    { "accessTokenUrl", "ftp://x" }, { "clientId", "c" } },
    json{ { "grantType", "client_credentials" }, { "accessTokenUrl", "https://x" } },
    json{ { "grantType", "implicit" }, { "accessTokenUrl", "https://x" },
    { "clientId", "c" } } }) {
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
    db_->save_oauth_token (t);
    auto got = db_->get_oauth_token ("k1");
    ASSERT_HAS_VALUE (got);
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
