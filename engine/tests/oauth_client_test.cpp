/**
 * @file tests/oauth_client_test.cpp
 * @brief Tests for the OAuth 2.0 token client (acquire/cache/refresh) against
 *        a mock IdP, plus cache-key vectors shared with the app.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <future>
#include <map>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

#include "jwt_keys.hpp"
#include "log_capture.hpp"
#include "oauth_token_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/utils/encoding.hpp"
#include "wait_until.hpp"

using nlohmann::json;
namespace oauth = vayu::http::oauth;
using vayu::tests::MockTokenServer;
using vayu::tests::parse_form;
using vayu::tests::WAIT_DEADLINE;
using vayu::tests::wait_until;

namespace {

using TokenResult = std::variant<vayu::db::OAuthToken, oauth::TokenError>;

/// The bound every token request here is given: the engine's own default, so
/// none of these tests is about the timeout.
constexpr int TOKEN_TIMEOUT_MS = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;

/// Releases every request `/refresh-gated` may still hold, so a test that
/// stops early unwinds instead of waiting out a held refresh. Declared after
/// the futures it guards, so it runs first.
class ReleaseGatedRefreshes {
    public:
    explicit ReleaseGatedRefreshes (MockTokenServer& idp) : idp_ (idp) {
    }
    ReleaseGatedRefreshes (const ReleaseGatedRefreshes&)            = delete;
    ReleaseGatedRefreshes& operator= (const ReleaseGatedRefreshes&) = delete;
    ReleaseGatedRefreshes (ReleaseGatedRefreshes&&)                 = delete;
    ReleaseGatedRefreshes& operator= (ReleaseGatedRefreshes&&)      = delete;
    ~ReleaseGatedRefreshes () {
        for (int hit = 1; hit <= 4; ++hit) {
            idp_.release (hit);
        }
    }

    private:
    MockTokenServer& idp_;
};

/// The result of @p call, or a failure naming a call that never returned.
TokenResult finished (std::future<TokenResult>& call, const char* what) {
    if (call.wait_for (WAIT_DEADLINE) != std::future_status::ready) {
        ADD_FAILURE () << what << " never returned";
        return oauth::TokenError{};
    }
    return call.get ();
}

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

        auto result = oauth::acquire_token (*db_, config, force, exchange, TOKEN_TIMEOUT_MS);

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

    // The single-flight tests (#3344) refresh an expired row behind
    // `/refresh-gated`. The grant is authorization_code, so a fall-through to
    // a fresh grant is a 409 rather than another request at the provider.
    static json gated_config (const MockTokenServer& idp) {
        return json{ { "grantType", "authorization_code" },
            { "accessTokenUrl", idp.url ("/refresh-gated") },
            { "clientId", "cid" }, { "clientSecret", "sec" } };
    }

    void seed_expired (const json& config, const std::string& refresh_token) {
        auto row          = seeded_row (config, 7'200'000);
        row.refresh_token = refresh_token;
        db_->save_oauth_token (row);
    }

    std::future<TokenResult> acquire_async (const json& config,
    int timeout_ms                  = TOKEN_TIMEOUT_MS,
    const std::atomic<bool>* cancel = nullptr) {
        return std::async (std::launch::async, [this, config, timeout_ms, cancel] {
            return oauth::acquire_token (
            *db_, config, false, std::nullopt, timeout_ms, nullptr, cancel);
        });
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
    // Vector 7: jwt_bearer holds its subject in the slot password holds its
    // username in, and ignores a username. Two subjects are two keys.
    const json jwt_alice          = { { "grantType", "jwt_bearer" },
        { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" },
        { "subject", "alice" }, { "assertionAudience", "https://idp" } };
    json jwt_bob                  = jwt_alice;
    jwt_bob["subject"]            = "bob";
    json jwt_with_username        = jwt_alice;
    jwt_with_username["username"] = "u1";
    EXPECT_EQ (oauth::cache_key (jwt_alice),
    "https://idp/token\x1f"
    "cid\x1f"
    "default\x1f"
    "alice");
    EXPECT_EQ (oauth::cache_key (jwt_bob),
    "https://idp/token\x1f"
    "cid\x1f"
    "default\x1f"
    "bob");
    EXPECT_EQ (oauth::cache_key (jwt_with_username), oauth::cache_key (jwt_alice));
    json jwt_no_subject = jwt_alice;
    jwt_no_subject.erase ("subject");
    EXPECT_EQ (oauth::cache_key (jwt_no_subject),
    "https://idp/token\x1f"
    "cid\x1f"
    "default\x1f");
    // Vector 8: subject ignored outside jwt_bearer
    EXPECT_EQ (oauth::cache_key (json{ { "grantType", "client_credentials" },
               { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" },
               { "subject", "alice" } }),
    "https://idp/token\x1f"
    "cid\x1f"
    "default\x1f");
    EXPECT_EQ (oauth::cache_key (json{ { "grantType", "password" },
               { "accessTokenUrl", "https://idp/token" }, { "clientId", "cid" },
               { "username", "u1" }, { "subject", "alice" } }),
    "https://idp/token\x1f"
    "cid\x1f"
    "default\x1f"
    "u1");
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

// A token living no longer than the 45s skew is not expired at mint: the skew
// is capped at half its lifetime (#3200).
TEST (OAuthExpiry, SkewIsCappedAtHalfTheLifetime) {
    vayu::db::OAuthToken t;
    t.created_at = 1'000'000;
    t.expires_in = 30; // skew 15s, so valid until created_at + 15'000

    EXPECT_FALSE (oauth::is_expired (t, t.created_at));
    EXPECT_FALSE (oauth::is_expired (t, t.created_at + 14'000));
    EXPECT_TRUE (oauth::is_expired (t, t.created_at + 16'000));

    t.expires_in = 45; // exactly the default skew: valid for the first 22.5s
    EXPECT_FALSE (oauth::is_expired (t, t.created_at));
    EXPECT_TRUE (oauth::is_expired (t, t.created_at + 23'000));

    t.expires_in = 90; // lifetime / 2 == the skew: both rules agree
    EXPECT_FALSE (oauth::is_expired (t, t.created_at + 45'000));
    EXPECT_TRUE (oauth::is_expired (t, t.created_at + 45'001));

    t.expires_in = 30; // an explicit skew below the cap is honoured as given
    EXPECT_FALSE (oauth::is_expired (t, t.created_at + 19'000, 10'000));
    EXPECT_TRUE (oauth::is_expired (t, t.created_at + 21'000, 10'000));
}

// ---------------------------------------------------------------------------
// acquire_token
// ---------------------------------------------------------------------------

TEST_F (OAuthClientTest, FetchesPersistsAndCaches) {
    MockTokenServer idp;
    auto r1 = oauth::acquire_token (*db_, cc_config (idp), false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r1));
    const auto& t1 = std::get<vayu::db::OAuthToken> (r1);
    EXPECT_EQ (t1.access_token, "AT1");
    EXPECT_EQ (t1.token_type, "Bearer");
    EXPECT_EQ (t1.refresh_token, "RT1");
    EXPECT_EQ (t1.expires_in, 3600);
    EXPECT_EQ (idp.hits (), 1);

    // Second acquisition is a cache hit - no extra IdP call.
    auto r2 = oauth::acquire_token (*db_, cc_config (idp), false, std::nullopt, TOKEN_TIMEOUT_MS);
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
    oauth::acquire_token (
    *db_, cc_config (idp), false, std::nullopt, TOKEN_TIMEOUT_MS, &network_ms);
    ASSERT_EQ (idp.hits (), 1);
    EXPECT_GT (network_ms, 0.0);

    const double after_fetch = network_ms;
    oauth::acquire_token (
    *db_, cc_config (idp), false, std::nullopt, TOKEN_TIMEOUT_MS, &network_ms);
    ASSERT_EQ (idp.hits (), 1) << "the second call must be a cache hit";
    EXPECT_EQ (network_ms, after_fetch);
}

TEST_F (OAuthClientTest, BasicHeaderClientAuthIsDefault) {
    MockTokenServer idp;
    oauth::acquire_token (*db_, cc_config (idp), false, std::nullopt, TOKEN_TIMEOUT_MS);
    // base64("cid:sec")
    EXPECT_EQ (idp.last_auth (), "Basic Y2lkOnNlYw==");
    auto form = parse_form (idp.last_body ());
    EXPECT_EQ (form.count ("client_id"), 0u);
}

TEST_F (OAuthClientTest, BodyPlacementPutsCredsInForm) {
    MockTokenServer idp;
    auto config                    = cc_config (idp);
    config["credentialsPlacement"] = "body";
    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
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
    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    // base64("cid:a%2Bb%2Fc%3D")
    EXPECT_EQ (idp.last_auth (), "Basic Y2lkOmElMkJiJTJGYyUzRA==");
}

// parse_form does not decode, so the form-encoded secret is what the IdP read.
TEST_F (OAuthClientTest, BodyPlacementFormEncodesReservedCharactersInTheSecret) {
    MockTokenServer idp;
    auto config                    = cc_config (idp);
    config["clientSecret"]         = "a+b/c=";
    config["credentialsPlacement"] = "body";
    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    EXPECT_TRUE (idp.last_auth ().empty ());
    EXPECT_EQ (parse_form (idp.last_body ())["client_secret"], "a%2Bb%2Fc%3D");
}

TEST_F (OAuthClientTest, PublicClientSendsClientIdInBody) {
    MockTokenServer idp;
    auto config = cc_config (idp);
    config.erase ("clientSecret");
    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    EXPECT_TRUE (idp.last_auth ().empty ());
    EXPECT_EQ (parse_form (idp.last_body ())["client_id"], "cid");
}

TEST_F (OAuthClientTest, PasswordGrantSendsUserCredsAndScope) {
    MockTokenServer idp;
    json config = { { "grantType", "password" }, { "accessTokenUrl", idp.url ("/token") },
        { "clientId", "cid" }, { "clientSecret", "sec" }, { "username", "u" },
        { "password", "p w" }, { "scope", "read write" } };
    auto r = oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
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

    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);

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

    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);

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

    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);

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

    auto result = oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);

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

    auto r1 = oauth::acquire_token (*db_, first, false, std::nullopt, TOKEN_TIMEOUT_MS);
    auto r2 = oauth::acquire_token (*db_, second, false, std::nullopt, TOKEN_TIMEOUT_MS);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r1));
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r2));
    EXPECT_EQ (idp.hits (), 2);
    EXPECT_NE (std::get<vayu::db::OAuthToken> (r1).access_token,
    std::get<vayu::db::OAuthToken> (r2).access_token);
}

TEST_F (OAuthClientTest, MissingExpiresInMeansNonExpiring) {
    MockTokenServer idp;
    auto r = oauth::acquire_token (*db_, cc_config (idp, "/token-plain"), false,
    std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    const auto& t = std::get<vayu::db::OAuthToken> (r);
    EXPECT_EQ (t.expires_in, 0);
    EXPECT_EQ (t.token_type, "Bearer"); // defaulted
    // Cache hit on re-acquire (never expires)
    oauth::acquire_token (*db_, cc_config (idp, "/token-plain"), false,
    std::nullopt, TOKEN_TIMEOUT_MS);
    EXPECT_EQ (idp.hits (), 1);
}

TEST_F (OAuthClientTest, FormEncodedResponseAndStringExpiresIn) {
    MockTokenServer idp;
    auto r = oauth::acquire_token (*db_, cc_config (idp, "/token-legacy"),
    false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    const auto& t = std::get<vayu::db::OAuthToken> (r);
    EXPECT_EQ (t.access_token, "legacy");
    EXPECT_EQ (t.expires_in, 1200);
}

// The form type is read through its parameters: a provider answering
// `application/x-www-form-urlencoded; charset=utf-8` is the legacy shape too.
// Mutation check: compare the raw Content-Type in `may_be_form_encoded`.
TEST_F (OAuthClientTest, AFormDeclaredWithACharsetIsReadAsAToken) {
    MockTokenServer idp;
    auto r = oauth::acquire_token (*db_, cc_config (idp, "/token-form-encoded"),
    false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    EXPECT_EQ (std::get<vayu::db::OAuthToken> (r).access_token, "form");
}

// A body declared `text/html` is never a form, however it is shaped (#3201).
// Mutation check: return true from `may_be_form_encoded` after the markup test.
TEST_F (OAuthClientTest, AFormDeclaredAsHtmlIsNotAToken) {
    MockTokenServer idp;
    auto r = oauth::acquire_token (*db_, cc_config (idp, "/token-form-as-html"),
    false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    EXPECT_NE (
    std::get<oauth::TokenError> (r).message.find ("unparseable response"), std::string::npos)
    << std::get<oauth::TokenError> (r).message;
}

// A gateway's 503 page is the endpoint failing, not the provider refusing: the
// message names the status and says nothing was rejected, and the page's
// `&error=` is not read as the provider's `error` (#3201). Mutation checks:
// word every failure "rejected" in `provider_failure`; drop the
// `may_be_form_encoded` call from `parse_token_body`.
TEST_F (OAuthClientTest, AGatewayErrorPageNamesItsStatusAndIsNotARefusal) {
    MockTokenServer idp;
    auto r = oauth::acquire_token (*db_, cc_config (idp, "/token-unavailable-html"),
    false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    const auto& err = std::get<oauth::TokenError> (r);
    EXPECT_EQ (err.message, "Token endpoint error (HTTP 503): unparseable response");
    EXPECT_EQ (err.message.find ("rejected"), std::string::npos) << err.message;
    EXPECT_EQ (err.provider_status, 503);
    EXPECT_EQ (err.provider_error, "");
    EXPECT_EQ (err.http_status, 401);
    EXPECT_EQ (err.code, "oauth2_provider_error");
}

// Markup is not a form under `text/plain` either: the page a misconfigured
// gateway labels as text still reads as unparseable (#3201). Mutation check:
// drop the leading-`<` test from `may_be_form_encoded`.
TEST_F (OAuthClientTest, MarkupDeclaredAsPlainTextIsNotAForm) {
    MockTokenServer idp;
    auto r = oauth::acquire_token (*db_, cc_config (idp, "/token-markup-as-plain"),
    false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    const auto& err = std::get<oauth::TokenError> (r);
    EXPECT_EQ (err.provider_error, "") << err.message;
    EXPECT_NE (err.message.find ("unparseable response"), std::string::npos)
    << err.message;
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

    auto r = oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
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

    auto r = oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    EXPECT_EQ (std::get<vayu::db::OAuthToken> (r).access_token, "FRESH-AFTER-REJECT");
    EXPECT_EQ (idp.hits (), 2); // failed refresh + fresh grant
}

TEST_F (OAuthClientTest, ProviderErrorIsStructured) {
    MockTokenServer idp;
    auto r = oauth::acquire_token (
    *db_, cc_config (idp, "/token-fail"), false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    const auto& err = std::get<oauth::TokenError> (r);
    EXPECT_EQ (err.http_status, 401);
    EXPECT_EQ (err.code, "oauth2_provider_error");
    EXPECT_EQ (err.provider_status, 400);
    EXPECT_EQ (err.provider_error, "invalid_client");
    EXPECT_EQ (err.provider_error_description, "bad secret");
    EXPECT_EQ (err.message, "Token endpoint refused the request (HTTP 400): invalid_client (bad secret)");
}

// The bound is inclusive: a token body nested exactly to it still parses.
TEST_F (OAuthClientTest, ATokenBodyAtTheDepthBoundIsAccepted) {
    MockTokenServer idp;
    auto r = oauth::acquire_token (*db_, cc_config (idp, "/token-at-depth-bound"),
    false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (r));
    EXPECT_EQ (std::get<vayu::db::OAuthToken> (r).access_token, "AT-DEEP");
}

// A body deeper than the bound is not handed on: the token parse treats it as
// unparseable, so the exchange fails instead of caching a tree every later
// copy or dump would recurse through.
TEST_F (OAuthClientTest, ATokenBodyPastTheDepthBoundFailsCleanly) {
    MockTokenServer idp;
    const auto config = cc_config (idp, "/token-past-depth-bound");
    auto r = oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    const auto& err = std::get<oauth::TokenError> (r);
    EXPECT_EQ (err.code, "oauth2_provider_error");
    EXPECT_NE (err.message.find ("unparseable response"), std::string::npos);
    EXPECT_FALSE (db_->get_oauth_token (oauth::cache_key (config)).has_value ());
}

TEST_F (OAuthClientTest, ConnectionFailureIsNetworkError) {
    json config = { { "grantType", "client_credentials" },
        { "accessTokenUrl", "http://127.0.0.1:1/token" }, { "clientId", "cid" } };
    auto r = oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    EXPECT_EQ (std::get<oauth::TokenError> (r).http_status, 502);
    EXPECT_EQ (std::get<oauth::TokenError> (r).code, "oauth2_network_error");
}

// A token endpoint that never answers is a timeout at the bound the caller
// passed (#2833), not the compiled-in 30 s a bare `Request` carries: healthy,
// this gives up after about 1 s; with `Client::post` ignoring its timeout it
// waits 30 s. The 15 s bound sits between the two.
TEST_F (OAuthClientTest, ATokenEndpointThatNeverAnswersTimesOutAtTheGivenBound) {
    MockTokenServer idp;
    const auto started = std::chrono::steady_clock::now ();
    auto r             = oauth::acquire_token (
    *db_, cc_config (idp, "/token-hang"), false, std::nullopt, 1000);
    const auto elapsed = std::chrono::steady_clock::now () - started;

    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    const auto& err = std::get<oauth::TokenError> (r);
    EXPECT_EQ (err.http_status, 504);
    EXPECT_EQ (err.code, "oauth2_timeout");
    EXPECT_NE (err.message.find ("1000 ms"), std::string::npos) << err.message;
    EXPECT_LT (elapsed, std::chrono::seconds (15));
}

// One deadline covers the whole acquisition: a refresh rejected after 2500 ms
// leaves the fresh grant the remaining 1500 ms, not a second full 4000 ms.
// Healthy, the call ends at about 4000 ms; with a fresh bound per post it ends
// at about 6500 ms. The 5500 ms bound sits 1500 ms from each reading, wide
// enough that a slow runner cannot push the refresh past the deadline itself.
TEST_F (OAuthClientTest, ARejectedRefreshLeavesTheFreshGrantOnlyWhatRemains) {
    MockTokenServer idp;
    auto config = cc_config (idp, "/refresh-rejected-then-hang");

    vayu::db::OAuthToken stale;
    stale.cache_key     = oauth::cache_key (config);
    stale.access_token  = "OLD";
    stale.refresh_token = "RT_DEAD";
    stale.expires_in    = 60;
    stale.created_at    = now_ms () - 3'600'000;
    db_->save_oauth_token (stale);

    const auto started = std::chrono::steady_clock::now ();
    auto r = oauth::acquire_token (*db_, config, false, std::nullopt, 4000);
    const auto elapsed = std::chrono::steady_clock::now () - started;

    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r));
    EXPECT_EQ (std::get<oauth::TokenError> (r).code, "oauth2_timeout");
    EXPECT_EQ (idp.hits (), 2)
    << "the rejected refresh must fall through to a grant";
    static_assert (MockTokenServer::SLOW_REFRESH_REJECT_MS == 2500,
    "the bound below assumes the refresh is rejected 2500 ms in");
    EXPECT_LT (elapsed, std::chrono::milliseconds (5500));
}

// ---------------------------------------------------------------------------
// One refresh in flight per cache key (#3344)
// ---------------------------------------------------------------------------

std::string access_token_of (const TokenResult& result) {
    const auto* token = std::get_if<vayu::db::OAuthToken> (&result);
    return token == nullptr ? "error: " + std::get<oauth::TokenError> (result).message :
                              token->access_token;
}

std::string error_code_of (const TokenResult& result) {
    const auto* err = std::get_if<oauth::TokenError> (&result);
    return err == nullptr ? "token" : err->code;
}

// Two sends of one expired token: the second waits on the first's refresh, so
// a rotating provider sees one refresh and the row it answered survives.
TEST_F (OAuthClientTest, ConcurrentRefreshesOfOneTokenPostOnce) {
    MockTokenServer idp;
    const auto config = gated_config (idp);
    const auto key    = oauth::cache_key (config);
    seed_expired (config, std::string (MockTokenServer::GATED_REFRESH_TOKEN));

    std::future<TokenResult> leader;
    std::future<TokenResult> follower;
    const ReleaseGatedRefreshes release_on_exit (idp);
    leader = acquire_async (config);
    ASSERT_TRUE (wait_until ([&] { return idp.hits () == 1; }))
    << "the first call's refresh reaches the provider";
    follower = acquire_async (config);
    // Without single-flight the second call posts its own refresh instead.
    ASSERT_TRUE (wait_until ([&] {
        return oauth::refresh_followers_waiting (key) == 1 || idp.hits () == 2;
    }));
    idp.release (1);
    idp.release (2); // so a second refresh, if one was sent, answers

    const auto led      = finished (leader, "the leading call");
    const auto followed = finished (follower, "the following call");
    EXPECT_EQ (access_token_of (led), "AT-REFRESHED-1");
    EXPECT_EQ (access_token_of (followed), "AT-REFRESHED-1");
    EXPECT_EQ (idp.hits (), 1) << "one refresh for both calls";
    const auto stored = db_->get_oauth_token (key);
    ASSERT_HAS_VALUE (stored) << "the refreshed row survives";
    EXPECT_EQ (stored->access_token, "AT-REFRESHED-1");
    EXPECT_EQ (stored->refresh_token, "RT-1");
}

// The provider refuses the refresh token this call sent, but another
// acquisition (an interactive exchange, say) replaced the row while the post
// was out: the refusal must not delete the replacement, which answers instead.
TEST_F (OAuthClientTest, AStaleRefusedRefreshKeepsTheRowThatReplacedIt) {
    MockTokenServer idp;
    const auto config = gated_config (idp);
    const auto key    = oauth::cache_key (config);
    seed_expired (config, "RT_SPENT_ELSEWHERE");

    std::future<TokenResult> refresh;
    const ReleaseGatedRefreshes release_on_exit (idp);
    refresh = acquire_async (config);
    ASSERT_TRUE (wait_until ([&] { return idp.hits () == 1; }));
    auto replacement          = seeded_row (config, 0);
    replacement.access_token  = "REPLACED";
    replacement.refresh_token = "RT_REPLACED";
    db_->save_oauth_token (replacement);
    idp.release (1);

    const auto result = finished (refresh, "the refused refresh");
    EXPECT_EQ (access_token_of (result), "REPLACED");
    EXPECT_EQ (idp.hits (), 1);
    const auto stored = db_->get_oauth_token (key);
    ASSERT_HAS_VALUE (stored) << "the stale refusal deleted the replacement";
    EXPECT_EQ (stored->refresh_token, "RT_REPLACED");
}

// A waiting call keeps its own deadline: it gives up while the refresh it is
// waiting on is still held at the provider, and never posts one of its own.
TEST_F (OAuthClientTest, AFollowerStopsAtItsOwnDeadline) {
    MockTokenServer idp;
    const auto config = gated_config (idp);
    const auto key    = oauth::cache_key (config);
    seed_expired (config, std::string (MockTokenServer::GATED_REFRESH_TOKEN));

    std::future<TokenResult> leader;
    std::future<TokenResult> follower;
    const ReleaseGatedRefreshes release_on_exit (idp);
    leader = acquire_async (config);
    ASSERT_TRUE (wait_until ([&] { return idp.hits () == 1; }));
    follower = acquire_async (config, 200);

    EXPECT_EQ (error_code_of (finished (follower, "the following call")), "oauth2_timeout");
    EXPECT_EQ (idp.hits (), 1) << "the follower waited rather than posting";
    EXPECT_EQ (oauth::refresh_followers_waiting (key), 0);
    idp.release (1);
    EXPECT_EQ (access_token_of (finished (leader, "the leading call")), "AT-REFRESHED-1");
}

TEST_F (OAuthClientTest, ACancelledFollowerStopsWithoutWaitingForItsLeader) {
    MockTokenServer idp;
    const auto config = gated_config (idp);
    const auto key    = oauth::cache_key (config);
    seed_expired (config, std::string (MockTokenServer::GATED_REFRESH_TOKEN));

    std::atomic<bool> cancel{ false };
    std::future<TokenResult> leader;
    std::future<TokenResult> follower;
    const ReleaseGatedRefreshes release_on_exit (idp);
    leader = acquire_async (config);
    ASSERT_TRUE (wait_until ([&] { return idp.hits () == 1; }));
    follower = acquire_async (config, TOKEN_TIMEOUT_MS, &cancel);
    ASSERT_TRUE (
    wait_until ([&] { return oauth::refresh_followers_waiting (key) == 1; }));
    cancel.store (true);

    EXPECT_EQ (error_code_of (finished (follower, "the cancelled call")), "oauth2_network_error");
    EXPECT_EQ (idp.hits (), 1);
    idp.release (1);
    EXPECT_EQ (access_token_of (finished (leader, "the leading call")), "AT-REFRESHED-1");
}

std::string error_message_of (const TokenResult& result) {
    const auto* err = std::get_if<oauth::TokenError> (&result);
    return err == nullptr ? "token" : err->message;
}

// A stop flag already set means no token request is started: libcurl reads it
// only at its first progress tick, which a fast endpoint answers before. The
// zero-hit assertions hold on any runner; whether the endpoint is reached
// when the check is missing depends on that race, so the out-of-range port
// below pins the check itself: libcurl rejects the URL before any tick, and
// only the pre-send check reports the cancel.
TEST_F (OAuthClientTest, ATokenRequestIsNotStartedOnceTheServerIsStopping) {
    MockTokenServer idp;
    const std::atomic<bool> stopping{ true };
    const auto config = cc_config (idp);

    const auto fetched = oauth::acquire_token (
    *db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS, nullptr, &stopping);

    EXPECT_EQ (error_code_of (fetched), "oauth2_network_error");
    EXPECT_EQ (error_message_of (fetched), "Token request failed: Request cancelled");
    EXPECT_FALSE (db_->get_oauth_token (oauth::cache_key (config)).has_value ());

    const auto key = oauth::cache_key (config);
    db_->save_oauth_token (seeded_row (config, 7'200'000));
    const auto refreshed = oauth::acquire_token (
    *db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS, nullptr, &stopping);

    EXPECT_EQ (error_code_of (refreshed), "oauth2_network_error");
    EXPECT_TRUE (db_->get_oauth_token (key).has_value ())
    << "a cancelled refresh leaves the row for the next send";
    EXPECT_EQ (idp.hits (), 0);

    json unreachable              = config;
    unreachable["accessTokenUrl"] = "http://127.0.0.1:99999/token";
    const auto refused = oauth::acquire_token (*db_, unreachable, false,
    std::nullopt, TOKEN_TIMEOUT_MS, nullptr, &stopping);
    EXPECT_EQ (error_message_of (refused), "Token request failed: Request cancelled");
}

// The leader's cancel is the leader's: the call waiting on it makes its own
// refresh from the row the leader left, rather than reporting the cancel.
TEST_F (OAuthClientTest, ALeadersErrorIsNotItsFollowersError) {
    MockTokenServer idp;
    const auto config = gated_config (idp);
    const auto key    = oauth::cache_key (config);
    seed_expired (config, std::string (MockTokenServer::GATED_REFRESH_TOKEN));

    std::atomic<bool> leader_cancel{ false };
    std::future<TokenResult> leader;
    std::future<TokenResult> follower;
    const ReleaseGatedRefreshes release_on_exit (idp);
    leader = acquire_async (config, TOKEN_TIMEOUT_MS, &leader_cancel);
    ASSERT_TRUE (wait_until ([&] { return idp.hits () == 1; }));
    follower = acquire_async (config);
    ASSERT_TRUE (
    wait_until ([&] { return oauth::refresh_followers_waiting (key) == 1; }));
    leader_cancel.store (true);

    EXPECT_EQ (error_code_of (finished (leader, "the cancelled leader")), "oauth2_network_error");
    ASSERT_TRUE (wait_until ([&] { return idp.hits () == 2; }))
    << "the follower refreshes for itself";
    idp.release (2);
    EXPECT_EQ (access_token_of (finished (follower, "the following call")), "AT-REFRESHED-2");
    const auto stored = db_->get_oauth_token (key);
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->refresh_token, "RT-2");
}

// ---------------------------------------------------------------------------
// Which refresh failures clear the cached row (#3360)
// ---------------------------------------------------------------------------

// A token endpoint in an outage says nothing about the refresh token: a 503
// gateway page and then a 429 each answer a network error naming the status,
// keep the row, and the next refresh spends the same token. Mutation check:
// clear the row on every `oauth2_provider_error` again (the pre-#3360
// `refresh_once_per_key`, without `post_refresh`'s reclassification); the
// 503 deletes the row and a fresh grant answers.
TEST_F (OAuthClientTest, AnUnavailableTokenEndpointKeepsTheRowForTheNextRefresh) {
    MockTokenServer idp;
    const auto config = cc_config (idp, "/refresh-flaky");
    const auto key    = oauth::cache_key (config);
    seed_expired (config, "RT_LIVE");

    for (const int status : { 503, 429 }) {
        const auto r =
        oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
        ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r))
        << "HTTP " << status << " answered " << access_token_of (r);
        const auto& err = std::get<oauth::TokenError> (r);
        EXPECT_EQ (err.code, "oauth2_network_error");
        EXPECT_EQ (err.http_status, 502);
        EXPECT_EQ (err.provider_status, status);
        EXPECT_EQ (err.message.rfind ("Token refresh failed: ", 0), 0u) << err.message;
        EXPECT_NE (err.message.find ("(HTTP " + std::to_string (status) + ")"),
        std::string::npos)
        << err.message;
        const auto stored = db_->get_oauth_token (key);
        ASSERT_HAS_VALUE (stored) << "HTTP " << status << " deleted the row";
        EXPECT_EQ (stored->refresh_token, "RT_LIVE");
    }
    EXPECT_EQ (idp.hits (), 2)
    << "an unavailable endpoint fell through to a fresh grant";

    const auto r =
    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    EXPECT_EQ (access_token_of (r), "AT-AFTER-OUTAGE");
    const auto form = parse_form (idp.last_body ());
    EXPECT_EQ (form.at ("grant_type"), "refresh_token");
    EXPECT_EQ (form.at ("refresh_token"), "RT_LIVE");
}

// A provider that refuses something other than the refresh token (here the
// scope) has not said the token is spent: its refusal answers unchanged and
// the row stays. Mutation check: clear the row on any provider refusal.
TEST_F (OAuthClientTest, ARefusalOfAnythingButTheRefreshTokenKeepsTheRow) {
    MockTokenServer idp;
    const auto config = cc_config (idp, "/refresh-scope-refused");
    seed_expired (config, "RT_LIVE");

    const auto r =
    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<oauth::TokenError> (r)) << access_token_of (r);
    const auto& err = std::get<oauth::TokenError> (r);
    EXPECT_EQ (err.code, "oauth2_provider_error");
    EXPECT_EQ (err.http_status, 401);
    EXPECT_EQ (err.provider_error, "invalid_scope");
    EXPECT_EQ (idp.hits (), 1);
    const auto stored = db_->get_oauth_token (oauth::cache_key (config));
    ASSERT_HAS_VALUE (stored) << "a scope refusal deleted the row";
    EXPECT_EQ (stored->refresh_token, "RT_LIVE");
}

// `invalid_client` on a 401 refuses the refresh as surely as `invalid_grant`
// on a 400: the row goes and a fresh grant answers. Mutation check: drop
// `invalid_client` from `refresh_token_refused`.
TEST_F (OAuthClientTest, AnInvalidClientRefreshClearsTheRowForAFreshGrant) {
    MockTokenServer idp;
    const auto config = cc_config (idp, "/refresh-client-refused");
    seed_expired (config, "RT_LIVE");

    const auto r =
    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    EXPECT_EQ (access_token_of (r), "FRESH-GRANT");
    EXPECT_EQ (idp.hits (), 2); // refused refresh + fresh grant
    const auto stored = db_->get_oauth_token (oauth::cache_key (config));
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->access_token, "FRESH-GRANT");
}

TEST_F (OAuthClientTest, AuthCodeWithoutInteractiveIs409) {
    json config = { { "grantType", "authorization_code" },
        { "accessTokenUrl", "https://idp.example/token" }, { "clientId", "cid" } };
    auto r = oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
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
    auto r = oauth::acquire_token (*db_, config, false, ex, TOKEN_TIMEOUT_MS);
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

    auto result = oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);

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
        auto r = oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
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

// A refused refresh may clear only the token it spent (#3344): the row another
// acquisition wrote while it was in flight carries another refresh token.
TEST_F (OAuthClientTest, ARefusedRefreshDeletesOnlyTheRowItSpent) {
    vayu::db::OAuthToken rotated;
    rotated.cache_key     = "k1";
    rotated.access_token  = "NEW";
    rotated.refresh_token = "RT_NEW";
    db_->save_oauth_token (rotated);

    EXPECT_FALSE (db_->delete_oauth_token_if_refresh_matches ("k1", "RT_OLD"));
    const auto kept = db_->get_oauth_token ("k1");
    ASSERT_HAS_VALUE (kept) << "a stale refresh token must not delete the row";
    EXPECT_EQ (kept->access_token, "NEW");

    EXPECT_TRUE (db_->delete_oauth_token_if_refresh_matches ("k1", "RT_NEW"));
    EXPECT_FALSE (db_->get_oauth_token ("k1").has_value ());
    EXPECT_FALSE (db_->delete_oauth_token_if_refresh_matches ("k1", "RT_NEW"))
    << "nothing left to delete";
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

// ---------------------------------------------------------------------------
// jwt_bearer (RFC 7523, #3632)
// ---------------------------------------------------------------------------

namespace jwt = vayu::tests::jwt;

constexpr std::string_view JWT_BEARER_URN =
"urn:ietf:params:oauth:grant-type:jwt-bearer";
constexpr const char* ASSERTION_AUDIENCE = "https://idp.example/token";

/// The form a token endpoint received, percent-decoded.
std::map<std::string, std::string> decoded_form (const std::string& body) {
    std::map<std::string, std::string> out;
    for (const auto& [name, value] : parse_form (body)) {
        out[name] = vayu::utils::url_decode (value);
    }
    return out;
}

/// The names a form carries, in the order a map keeps them.
std::vector<std::string> names_of (const std::map<std::string, std::string>& form) {
    std::vector<std::string> names;
    names.reserve (form.size ());
    for (const auto& entry : form) {
        names.push_back (entry.first);
    }
    return names;
}

/// A slice of the key's body long enough that it cannot occur by chance.
std::string key_fragment (const std::string& pem) {
    const auto first_line = pem.find ('\n') + 1;
    return pem.substr (first_line, 32);
}

class OAuthJwtBearerTest : public OAuthClientTest {
    protected:
    static json config (const MockTokenServer& idp,
    const std::string& pem,
    const std::string& path = "/token") {
        return json{ { "grantType", "jwt_bearer" }, { "accessTokenUrl", idp.url (path) },
            { "clientId", "svc-client" }, { "subject", "alice@example.com" },
            { "assertionAudience", ASSERTION_AUDIENCE }, { "privateKey", pem } };
    }

    static std::string rsa_pem () {
        return jwt::pkcs8 (jwt::keys ().rsa);
    }

    TokenResult acquire (const json& config) {
        return oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    }

    /// The refusal @p config gets, checking that nothing was posted and that
    /// neither the key nor its text is in the message.
    oauth::TokenError
    refusal (const MockTokenServer& idp, const json& config, const std::string& pem) {
        const TokenResult result = acquire (config);
        const auto* err          = std::get_if<oauth::TokenError> (&result);
        if (err == nullptr) {
            ADD_FAILURE ()
            << "a token was granted where a refusal was expected";
            return {};
        }
        EXPECT_EQ (err->http_status, 400);
        EXPECT_EQ (err->code, "oauth2_invalid_config");
        EXPECT_EQ (idp.hits (), 0)
        << "a refused assertion must never be posted";
        EXPECT_EQ (err->message.find (key_fragment (pem)), std::string::npos)
        << err->message;
        EXPECT_EQ (err->message.find ("PRIVATE KEY"), std::string::npos) << err->message;
        return *err;
    }

    /// Grants @p pem as a file under a scratch directory and returns its path.
    std::string granted_key_file (const std::string& pem, const std::string& name) {
        const std::string path = key_file (pem, name);
        const auto canonical   = vayu::http::grantable_file_path (path);
        if (!canonical) {
            ADD_FAILURE () << "not grantable: " << path;
            return path;
        }
        vayu::FileGrant grant;
        grant.id         = "fgrant_" + name;
        grant.path       = *canonical;
        grant.created_at = 1;
        db_->save_file_grant (grant);
        return path;
    }

    /// A file holding @p pem that no grant or allowed folder covers.
    std::string key_file (const std::string& pem, const std::string& name) {
        if (scratch_.empty ()) {
            // Per test, so concurrent ctest processes never share a directory.
            scratch_ = std::filesystem::temp_directory_path () /
            (std::string ("vayu-oauth-jwt-") +
            ::testing::UnitTest::GetInstance ()->current_test_info ()->name ());
            std::filesystem::create_directories (scratch_);
        }
        const auto path = scratch_ / name;
        std::ofstream (path, std::ios::binary) << pem;
        return path.string ();
    }

    void TearDown () override {
        std::error_code ignored;
        if (!scratch_.empty ()) {
            std::filesystem::remove_all (scratch_, ignored);
        }
        OAuthClientTest::TearDown ();
    }

    std::filesystem::path scratch_;
};

/// A token whose signature verifies under @p pub, with its decoded parts.
jwt::Parts expect_signed (const std::string& token, const jwt::KeyPtr& pub, std::string_view alg) {
    EXPECT_TRUE (jwt::verifies (token, pub, alg));
    return jwt::split (token);
}

// The grant posts the URN and one signed assertion, and nothing else of the
// client: a secretless client authenticates by the assertion alone.
// Mutation check: delete the `jwt_bearer` branch of `build_grant_request` and
// both algorithms fail on the grant type.
TEST_F (OAuthJwtBearerTest, PostsTheGrantTypeAndASignedAssertionAndNothingElse) {
    struct Case {
        const char* alg;
        const jwt::KeyPtr& key;
    };
    for (const Case& scenario :
    { Case{ "RS256", jwt::keys ().rsa }, Case{ "ES256", jwt::keys ().p256 } }) {
        SCOPED_TRACE (scenario.alg);
        MockTokenServer idp;
        json cfg                = config (idp, jwt::pkcs8 (scenario.key));
        cfg["signingAlgorithm"] = scenario.alg;
        cfg["keyId"]            = "key-7";

        const auto result = acquire (cfg);

        ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
        const auto form = decoded_form (idp.last_body ());
        EXPECT_EQ (names_of (form), (std::vector<std::string>{ "assertion", "grant_type" }))
        << "no client_id, no client_secret, no Authorization";
        EXPECT_EQ (form.at ("grant_type"), JWT_BEARER_URN);
        EXPECT_EQ (idp.last_auth (), "");

        const auto parts = expect_signed (
        form.at ("assertion"), jwt::public_half (scenario.key), scenario.alg);
        EXPECT_EQ (json::parse (parts.header),
        (json{ { "alg", scenario.alg }, { "typ", "JWT" }, { "kid", "key-7" } }));
        const json claims = json::parse (parts.payload);
        EXPECT_EQ (claims.at ("iss"), "svc-client");
        EXPECT_EQ (claims.at ("sub"), "alice@example.com");
        EXPECT_EQ (claims.at ("aud"), ASSERTION_AUDIENCE);
        EXPECT_EQ (
        claims.at ("exp").get<int64_t> () - claims.at ("iat").get<int64_t> (), 180);
    }
}

TEST_F (OAuthJwtBearerTest, AlgorithmDefaultsToRs256AndKeyIdIsOmittedWhenEmpty) {
    MockTokenServer idp;
    json cfg     = config (idp, rsa_pem ());
    cfg["keyId"] = "";
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (acquire (cfg)));
    const auto form  = decoded_form (idp.last_body ());
    const auto parts = expect_signed (
    form.at ("assertion"), jwt::public_half (jwt::keys ().rsa), "RS256");
    EXPECT_EQ (json::parse (parts.header), (json{ { "alg", "RS256" }, { "typ", "JWT" } }));
}

TEST_F (OAuthJwtBearerTest, ScopeAndAudienceAreFormParametersBesideTheAssertion) {
    MockTokenServer idp;
    json cfg        = config (idp, rsa_pem ());
    cfg["scope"]    = "read write";
    cfg["audience"] = "https://api.example";
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (acquire (cfg)));
    const auto form = decoded_form (idp.last_body ());
    EXPECT_EQ (names_of (form),
    (std::vector<std::string>{ "assertion", "audience", "grant_type", "scope" }));
    EXPECT_EQ (form.at ("scope"), "read write");
    EXPECT_EQ (form.at ("audience"), "https://api.example");
    const json claims = json::parse (jwt::split (form.at ("assertion")).payload);
    EXPECT_EQ (claims.at ("aud"), ASSERTION_AUDIENCE)
    << "the form's audience is not the claim's";
}

// With a secret the client authenticates as it does for every other grant.
TEST_F (OAuthJwtBearerTest, ASecretSendsClientAuthenticationPerPlacement) {
    MockTokenServer idp;
    json cfg            = config (idp, rsa_pem ());
    cfg["clientSecret"] = "s3cret";
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (acquire (cfg)));
    EXPECT_EQ (idp.last_auth (), "Basic " + vayu::utils::base64_encode ("svc-client:s3cret"));
    EXPECT_EQ (names_of (decoded_form (idp.last_body ())),
    (std::vector<std::string>{ "assertion", "grant_type" }));

    MockTokenServer body_idp;
    json in_body                    = config (body_idp, rsa_pem ());
    in_body["clientSecret"]         = "s3cret";
    in_body["credentialsPlacement"] = "body";
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (acquire (in_body)));
    const auto form = decoded_form (body_idp.last_body ());
    EXPECT_EQ (names_of (form),
    (std::vector<std::string>{ "assertion", "client_id", "client_secret", "grant_type" }));
    EXPECT_EQ (form.at ("client_id"), "svc-client");
    EXPECT_EQ (body_idp.last_auth (), "");
}

// `exp - iat` is what the assertion's lifetime says, read from one clock
// reading the test supplies.
// Mutation check: write `exp` from `iat` alone and the first expectation fails.
TEST_F (OAuthJwtBearerTest, LifetimeIsExpMinusIatDefaultedAndClamped) {
    MockTokenServer idp;
    const auto now =
    std::chrono::system_clock::time_point (std::chrono::seconds (1'900'000'000));
    const auto lifetime_of = [&] (const json& lifetime) {
        json cfg = config (idp, rsa_pem ());
        if (!lifetime.is_null ()) {
            cfg["assertionLifetimeSeconds"] = lifetime;
        }
        const auto assertion = oauth::build_jwt_assertion (*db_, cfg, now);
        if (!assertion) {
            ADD_FAILURE () << assertion.error ().message;
            return int64_t{ -1 };
        }
        const json claims = json::parse (jwt::split (*assertion).payload);
        EXPECT_EQ (claims.at ("iat").get<int64_t> (), 1'900'000'000);
        return claims.at ("exp").get<int64_t> () - claims.at ("iat").get<int64_t> ();
    };
    EXPECT_EQ (lifetime_of (nullptr), 180);
    EXPECT_EQ (lifetime_of (600), 600);
    EXPECT_EQ (lifetime_of (1), 1);
    EXPECT_EQ (lifetime_of (3600), 3600);
    EXPECT_EQ (lifetime_of (0), 1);
    EXPECT_EQ (lifetime_of (-30), 1);
    EXPECT_EQ (lifetime_of (3601), 3600);
    EXPECT_EQ (lifetime_of (86'400), 3600);
}

TEST_F (OAuthJwtBearerTest, ALifetimeThatIsNotANumberIsRefused) {
    MockTokenServer idp;
    json cfg                        = config (idp, rsa_pem ());
    cfg["assertionLifetimeSeconds"] = "soon";
    const auto err                  = refusal (idp, cfg, rsa_pem ());
    EXPECT_NE (err.message.find ("assertionLifetimeSeconds"), std::string::npos)
    << err.message;
}

// A row naming a claim the engine writes is skipped, so the engine's value is
// the one signed; a disabled row is skipped; the rest ride the payload.
// Mutation check: drop the `contains` test in `assertion_claims` and the
// reserved-name expectations fail.
TEST_F (OAuthJwtBearerTest, ExtraClaimsAreSignedAndReservedOnesNeverReplaceTheEnginesOwn) {
    MockTokenServer idp;
    json cfg = config (idp, rsa_pem ());
    cfg["assertionClaims"] =
    json::array ({ { { "key", "tenant" }, { "value", "t-1" }, { "enabled", true } },
    { { "key", "off" }, { "value", "x" }, { "enabled", false } },
    { { "key", "iss" }, { "value", "attacker" } }, { { "key", "sub" }, { "value", "attacker" } },
    { { "key", "aud" }, { "value", "attacker" } }, { { "key", "exp" }, { "value", "1" } },
    { { "key", "iat" }, { "value", "1" } }, { { "key", "" }, { "value", "nameless" } },
    { { "key", "env" }, { "value", "prod" } }, "not-a-row" });
    const auto now =
    std::chrono::system_clock::time_point (std::chrono::seconds (1'900'000'000));

    const auto assertion = oauth::build_jwt_assertion (*db_, cfg, now);

    ASSERT_HAS_VALUE (assertion);
    EXPECT_EQ (json::parse (jwt::split (*assertion).payload),
    (json{ { "iss", "svc-client" }, { "sub", "alice@example.com" },
    { "aud", ASSERTION_AUDIENCE }, { "exp", 1'900'000'180 },
    { "iat", 1'900'000'000 }, { "tenant", "t-1" }, { "env", "prod" } }));
}

// A body or url `tokenParams` row named `assertion` never alters the form's
// one signed assertion: `append_extra_params` skips a name the grant already
// wrote, for this grant alone (`assertion` is not in RESERVED_PARAM_NAMES, so
// no other grant loses a row of that name). A header row is a different
// channel and is not judged here. Mutation check: empty the `written` set in
// `append_extra_params` and the body row posts a second `assertion`.
TEST_F (OAuthJwtBearerTest, ATokenParamRowNamedAssertionDoesNotAlterThePostedAssertion) {
    MockTokenServer idp;
    json cfg           = config (idp, rsa_pem ());
    cfg["tokenParams"] = json::array ({
    { { "key", "assertion" }, { "value", "FORGED-BODY" } },
    { { "key", "assertion" }, { "value", "FORGED-URL" }, { "sendAs", "url" } },
    { { "key", "audience" }, { "value", "api" } },
    });

    const auto result = acquire (cfg);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    const std::string& body = idp.last_body ();
    EXPECT_EQ (form_occurrences (body, "assertion"), 1u);
    EXPECT_EQ (body.find ("FORGED"), std::string::npos);
    EXPECT_EQ (idp.last_target ().find ("assertion"), std::string::npos);
    EXPECT_EQ (form_occurrences (body, "audience"), 1u)
    << "an ordinary row still rides";
}

TEST_F (OAuthJwtBearerTest, RefusesAnAssertionItCannotSignNamingTheMembers) {
    MockTokenServer idp;
    const auto expect_names = [&] (const json& cfg, const std::string& pem,
                              std::initializer_list<const char*> members) {
        const auto err = refusal (idp, cfg, pem);
        for (const char* member : members) {
            EXPECT_NE (err.message.find (member), std::string::npos)
            << member << ": " << err.message;
        }
    };

    json unsupported                = config (idp, rsa_pem ());
    unsupported["signingAlgorithm"] = "HS256";
    expect_names (unsupported, rsa_pem (), { "signingAlgorithm", "privateKey" });

    json wrong_key                = config (idp, rsa_pem ());
    wrong_key["signingAlgorithm"] = "ES256";
    expect_names (wrong_key, rsa_pem (), { "signingAlgorithm", "privateKey" });

    const std::string small_rsa = jwt::pkcs8 (jwt::keys ().rsa_small);
    expect_names (config (idp, small_rsa), small_rsa, { "privateKey" });

    json not_a_key = config (idp, "this is not a PEM");
    expect_names (not_a_key, "this is not a PEM", { "privateKey" });
}

TEST_F (OAuthJwtBearerTest, RefusesMissingMembersNamingEach) {
    MockTokenServer idp;
    const std::string pem   = rsa_pem ();
    const auto expect_names = [&] (const json& cfg,
                              std::initializer_list<const char*> members) {
        const auto err = refusal (idp, cfg, pem);
        for (const char* member : members) {
            EXPECT_NE (err.message.find (member), std::string::npos)
            << member << ": " << err.message;
        }
    };

    json no_subject = config (idp, pem);
    no_subject.erase ("subject");
    expect_names (no_subject, { "subject" });
    no_subject["subject"] = "";
    expect_names (no_subject, { "subject" });

    json no_audience = config (idp, pem);
    no_audience.erase ("assertionAudience");
    expect_names (no_audience, { "assertionAudience" });

    json no_key = config (idp, pem);
    no_key.erase ("privateKey");
    expect_names (no_key, { "privateKey", "privateKeyFile" });

    json both_keys              = config (idp, pem);
    both_keys["privateKeyFile"] = "/some/key.pem";
    expect_names (both_keys, { "privateKey", "privateKeyFile" });
}

TEST_F (OAuthJwtBearerTest, AReferenceThatWasNeverResolvedIsRefused) {
    MockTokenServer idp;
    const auto err = refusal (idp, config (idp, "{{signing_key}}"), "{{signing_key}}x");
    EXPECT_NE (err.message.find ("privateKey"), std::string::npos) << err.message;
    EXPECT_NE (err.message.find ("privateKeyFile"), std::string::npos) << err.message;
}

// A key file is read only when the file-trust rule approves it. Mutation check:
// read `privateKeyFile` without `approved_path` and the first case sends.
TEST_F (OAuthJwtBearerTest, AKeyFileOutsideFileTrustIsRefusedUnread) {
    MockTokenServer idp;
    const std::string pem = rsa_pem ();
    json cfg              = config (idp, pem);
    cfg.erase ("privateKey");
    cfg["privateKeyFile"] = key_file (pem, "untrusted.pem");

    const auto err = refusal (idp, cfg, pem);

    EXPECT_NE (err.message.find ("privateKeyFile"), std::string::npos) << err.message;
}

TEST_F (OAuthJwtBearerTest, AGrantedKeyFileSignsTheAssertion) {
    MockTokenServer idp;
    const std::string pem = jwt::pkcs8 (jwt::keys ().p256);
    json cfg              = config (idp, "");
    cfg.erase ("privateKey");
    cfg["privateKeyFile"]   = granted_key_file (pem, "granted.pem");
    cfg["signingAlgorithm"] = "ES256";

    const auto result = acquire (cfg);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    expect_signed (decoded_form (idp.last_body ()).at ("assertion"),
    jwt::public_half (jwt::keys ().p256), "ES256");
}

TEST_F (OAuthJwtBearerTest, AKeyFileThatIsTooLargeToBeAKeyIsRefused) {
    MockTokenServer idp;
    const std::string big (std::size_t{ 70 } * 1024, 'A');
    json cfg = config (idp, "");
    cfg.erase ("privateKey");
    cfg["privateKeyFile"] = granted_key_file (big, "big.pem");

    const auto err = refusal (idp, cfg, rsa_pem ());

    EXPECT_NE (err.message.find ("privateKeyFile"), std::string::npos) << err.message;
}

TEST_F (OAuthJwtBearerTest, AKeyFileThatIsMissingIsRefused) {
    MockTokenServer idp;
    json cfg = config (idp, "");
    cfg.erase ("privateKey");
    cfg["privateKeyFile"] =
    (std::filesystem::temp_directory_path () / "vayu-no-such-key.pem").string ();

    const auto err = refusal (idp, cfg, rsa_pem ());

    EXPECT_NE (err.message.find ("privateKeyFile"), std::string::npos) << err.message;
}

TEST_F (OAuthJwtBearerTest, TheCachedTokenIsReusedAndTwoSubjectsHoldTwoTokens) {
    MockTokenServer idp;
    const std::string pem = rsa_pem ();
    json alice            = config (idp, pem);
    json bob              = config (idp, pem);
    bob["subject"]        = "bob@example.com";

    const auto first  = acquire (alice);
    const auto again  = acquire (alice);
    const auto second = acquire (bob);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (first));
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (again));
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (second));
    const auto& alice_token = std::get<vayu::db::OAuthToken> (first);
    EXPECT_EQ (alice_token.access_token, std::get<vayu::db::OAuthToken> (again).access_token);
    EXPECT_EQ (idp.hits (), 2)
    << "alice's second call is a cache hit, bob's is an exchange";
    EXPECT_NE (alice_token.cache_key, std::get<vayu::db::OAuthToken> (second).cache_key);
    EXPECT_EQ (alice_token.cache_key, oauth::cache_key (alice));
    EXPECT_NE (alice_token.access_token, std::get<vayu::db::OAuthToken> (second).access_token);
}

// Neither the assertion nor the key is logged, stored or put in an error: the
// log line keeps the grant and the URL. The scan asserts it read the line.
TEST_F (OAuthJwtBearerTest, NeitherTheAssertionNorTheKeyReachesTheLogOrTheStoredRow) {
    const vayu::tests::LogCapture capture;
    MockTokenServer idp;
    const std::string pem   = jwt::pkcs8 (jwt::keys ().p256);
    json cfg                = config (idp, pem);
    cfg["signingAlgorithm"] = "ES256";

    const auto result = acquire (cfg);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    const std::string assertion = decoded_form (idp.last_body ()).at ("assertion");
    const auto records   = capture.records ();
    const auto requested = capture.with_msg_prefix ("OAuth2: requesting token");
    ASSERT_EQ (requested.size (), 1U);
    EXPECT_EQ (requested.front ().at ("grant"), "jwt_bearer");
    for (const auto& record : records) {
        const std::string text = record.dump ();
        EXPECT_EQ (text.find (assertion), std::string::npos) << text;
        EXPECT_EQ (text.find (assertion.substr (0, assertion.find ('.'))), std::string::npos)
        << text;
        EXPECT_EQ (text.find (key_fragment (pem)), std::string::npos) << text;
    }
    const auto stored = db_->get_oauth_token (oauth::cache_key (cfg));
    ASSERT_HAS_VALUE (stored);
    const std::string row =
    stored->access_token + stored->refresh_token + stored->scope + stored->cache_key;
    EXPECT_EQ (row.find (assertion), std::string::npos);
    EXPECT_EQ (row.find (key_fragment (pem)), std::string::npos);
}

// ---------------------------------------------------------------------------
// fallbackExpiresIn
// ---------------------------------------------------------------------------

// A token whose response states no lifetime is kept for the configured
// seconds, whichever grant asked for it. Mutation check: drop the fallback
// assignment in `post_token_request` and the first expectation fails.
TEST_F (OAuthClientTest, FallbackExpiresInStandsInForAMissingExpiresIn) {
    MockTokenServer idp;
    json config                 = cc_config (idp, "/token-plain");
    config["fallbackExpiresIn"] = 600;

    const auto result =
    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    const auto& token = std::get<vayu::db::OAuthToken> (result);
    EXPECT_EQ (token.expires_in, 600);
    const auto stored = db_->get_oauth_token (oauth::cache_key (config));
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->expires_in, 600);
    EXPECT_FALSE (oauth::is_expired (token, token.created_at + 500'000));
    EXPECT_TRUE (oauth::is_expired (token, token.created_at + 600'001));
}

TEST_F (OAuthClientTest, AStatedExpiresInIsNotReplacedByTheFallback) {
    MockTokenServer idp;
    json config                 = cc_config (idp, "/token");
    config["fallbackExpiresIn"] = 600;

    const auto result =
    oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    EXPECT_EQ (std::get<vayu::db::OAuthToken> (result).expires_in, 3600);
}

TEST_F (OAuthClientTest, AFallbackThatIsNotAPositiveNumberKeepsTheTokenNonExpiring) {
    for (const json& fallback :
    { json (0), json (-5), json ("600"), json (nullptr), json (true) }) {
        SCOPED_TRACE (fallback.dump ());
        MockTokenServer idp;
        json config                 = cc_config (idp, "/token-plain");
        config["fallbackExpiresIn"] = fallback;
        const auto result =
        oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
        ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
        EXPECT_EQ (std::get<vayu::db::OAuthToken> (result).expires_in, 0);
        db_->delete_oauth_token (oauth::cache_key (config));
    }
}

// A fallback past the bound is kept for the bound, never cast out of range
// (1e300 is undefined behaviour at the double -> int64 cast) and never
// multiplied by 1000 into an overflow downstream. At the bound and below, the
// value stands. Mutation check: drop the clamp in `fallback_expires_in` and the
// 1e300 and 1e18 rows fail.
TEST_F (OAuthClientTest, AFallbackPastTheBoundIsClampedToIt) {
    const int64_t bound = oauth::MAX_FALLBACK_EXPIRES_IN_SECONDS;
    struct Case {
        json fallback;
        int64_t expected;
    };
    for (const Case& scenario : { Case{ json (1e300), bound }, Case{ json (1e18), bound },
         Case{ json (bound + 1), bound }, Case{ json (bound), bound },
         Case{ json (bound - 1), bound - 1 }, Case{ json (600.9), 600 } }) {
        SCOPED_TRACE (scenario.fallback.dump ());
        MockTokenServer idp;
        json config                 = cc_config (idp, "/token-plain");
        config["fallbackExpiresIn"] = scenario.fallback;
        const auto result =
        oauth::acquire_token (*db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
        ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
        const auto& token = std::get<vayu::db::OAuthToken> (result);
        EXPECT_EQ (token.expires_in, scenario.expected);
        EXPECT_FALSE (oauth::is_expired (token, token.created_at + 1'000));
        db_->delete_oauth_token (oauth::cache_key (config));
    }
}

} // namespace
