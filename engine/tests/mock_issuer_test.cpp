/**
 * @file tests/mock_issuer_test.cpp
 * @brief Tests for the local OAuth 2.0 mock issuer: payload validation, the
 *        four grants driven through the engine's *own* token client, PKCE,
 *        rotation, the switchable failure modes, client registration, the
 *        protected resource, MCP OAuth discovery and a discovered sign-in
 *        against it (#3794), and lifecycle.
 *
 * The round trips deliberately go through `oauth::acquire_token` rather than a
 * hand-written httplib client: the point of the issuer is that the engine's own
 * OAuth path works against it offline, so anything it accepts that
 * `acquire_token` cannot drive would be a mock of the wrong thing.
 */

// First, before anything that includes <httplib.h>: see the header.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>
#include <httplib.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <latch>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "held_request.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/mock_issuer.hpp"
#include "vayu/http/oauth_authorize.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/oauth_discovery.hpp"
#include "vayu/http/pkce.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/sha256.hpp"
#include "wait_until.hpp"

using nlohmann::json;
using vayu::http::MockIssuerManager;
using vayu::http::MockIssuerStart;

namespace {

/// The bound every token request here is given: the engine's own default, so
/// none of these tests is about the timeout.
constexpr int TOKEN_TIMEOUT_MS = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;

std::vector<std::string> split_jwt (const std::string& jwt) {
    std::vector<std::string> parts;
    size_t pos = 0;
    while (true) {
        const auto dot = jwt.find ('.', pos);
        parts.push_back (
        jwt.substr (pos, dot == std::string::npos ? std::string::npos : dot - pos));
        if (dot == std::string::npos) {
            break;
        }
        pos = dot + 1;
    }
    return parts;
}

/// Recomputed independently of the issuer's own minting, so the assertion is a
/// real signature check rather than a restatement of the implementation.
bool signature_verifies (const std::string& jwt, const std::string& key) {
    const auto parts = split_jwt (jwt);
    if (parts.size () != 3) {
        return false;
    }
    const auto tag = vayu::utils::hmac_sha256 (key, parts[0] + "." + parts[1]);
    return parts[2] == vayu::utils::base64url_encode (vayu::utils::byte_view (tag));
}

json decode_jwt_payload (const std::string& jwt) {
    const auto parts = split_jwt (jwt);
    if (parts.size () != 3) {
        return json ();
    }
    std::string standard = parts[1];
    for (char& c : standard) {
        if (c == '-') {
            c = '+';
        } else if (c == '_') {
            c = '/';
        }
    }
    const auto decoded = vayu::utils::base64_decode (standard);
    if (!decoded) {
        return json ();
    }
    return json::parse (*decoded, nullptr, false);
}

/// Follow one `/authorize` call and hand back the `code` it redirected with.
/// Returns an empty string when the issuer answered anything but a redirect.
std::string authorize_for_code (const MockIssuerStart& issuer,
const std::string& client_id,
const std::string& redirect_uri,
const std::string& challenge) {
    httplib::Client cli (issuer.issuer_url);
    std::string target =
    "/authorize?response_type=code&client_id=" + vayu::utils::url_encode (client_id) +
    "&redirect_uri=" + vayu::utils::url_encode (redirect_uri) + "&state=STATE";
    if (!challenge.empty ()) {
        target += "&code_challenge=" + challenge + "&code_challenge_method=S256";
    }
    auto res = cli.Get (target);
    if (res == nullptr || res->status != 302) {
        return {};
    }
    const std::string location = res->get_header_value ("Location");
    const auto code_at         = location.find ("code=");
    if (code_at == std::string::npos) {
        return {};
    }
    const auto end = location.find ('&', code_at);
    return vayu::utils::url_decode (location.substr (code_at + 5,
    end == std::string::npos ? std::string::npos : end - code_at - 5));
}

json client_credentials_config (const MockIssuerStart& issuer,
const char* client_id = "cid",
const char* secret    = "sec") {
    return json{ { "grantType", "client_credentials" },
        { "accessTokenUrl", issuer.token_url }, { "clientId", client_id },
        { "clientSecret", secret } };
}

/// The value of @p name in @p url's query, decoded; empty when absent.
std::string query_param (const std::string& url, const std::string& name) {
    const auto query = url.find ('?');
    if (query == std::string::npos) {
        return {};
    }
    size_t pos = query + 1;
    while (pos < url.size ()) {
        const auto amp = url.find ('&', pos);
        const auto pair =
        url.substr (pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (pair.rfind (name + "=", 0) == 0) {
            return vayu::utils::url_decode (pair.substr (name.size () + 1));
        }
        if (amp == std::string::npos) {
            break;
        }
        pos = amp + 1;
    }
    return {};
}

/// `POST /register` with @p body, as an MCP client's registration sends it.
httplib::Result post_registration (const MockIssuerStart& issuer, const std::string& body) {
    httplib::Client cli (issuer.issuer_url);
    return cli.Post ("/register", body, "application/json");
}

/// A client registered for @p redirect_uri, or empty when registration failed.
std::string register_client_for (const MockIssuerStart& issuer, const std::string& redirect_uri) {
    const auto res = post_registration (
    issuer, json{ { "redirect_uris", json::array ({ redirect_uri }) } }.dump ());
    if (res == nullptr || res->status != 201) {
        return {};
    }
    return json::parse (res->body).value ("client_id", "");
}

/// A JWT signed with @p key here rather than by the issuer, so a test can hand
/// `/resource` claims the issuer would never mint (an expired `exp`).
std::string sign_jwt (const std::string& key, const json& claims) {
    const std::string input = vayu::utils::base64url_encode (
                              json{ { "alg", "HS256" }, { "typ", "JWT" } }.dump ()) +
    "." + vayu::utils::base64url_encode (claims.dump ());
    return input + "." +
    vayu::utils::base64url_encode (
    vayu::utils::byte_view (vayu::utils::hmac_sha256 (key, input)));
}

int64_t now_s () {
    return std::chrono::duration_cast<std::chrono::seconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/// `GET /resource` with @p authorization as the `Authorization` header (none
/// when empty).
httplib::Result get_resource (const MockIssuerStart& issuer, const std::string& authorization) {
    httplib::Client cli (issuer.issuer_url);
    httplib::Headers headers;
    if (!authorization.empty ()) {
        headers.emplace ("Authorization", authorization);
    }
    return cli.Get ("/resource", headers);
}

class MockIssuerTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_mock_issuer.db";
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

/// Discovery resolves the transport policy from the database: seeded, with
/// the proxy off so a runner's `http_proxy` cannot take the loopback fetches.
class MockIssuerDiscoveryTest : public MockIssuerTest {
    protected:
    void SetUp () override {
        MockIssuerTest::SetUp ();
        db_->seed_default_config ();
        auto proxy = db_->get_config_entry ("proxyMode");
        ASSERT_HAS_VALUE (proxy) << "proxyMode is not seeded";
        proxy->value = "off";
        db_->save_config_entry (*proxy);
    }

    vayu::http::OAuthDiscoveryResult discover (const MockIssuerStart& issuer) {
        return vayu::http::discover_oauth_server (
        *db_, issuer.discover_url, TOKEN_TIMEOUT_MS, nullptr, cache_);
    }

    /// Starts a discovered embedded sign-in against @p issuer, follows its
    /// authorize URL to the mock's redirect and completes the attempt with it.
    vayu::http::AuthorizeStatus sign_in (const MockIssuerStart& issuer) {
        const json config = { { "grantType", "authorization_code" },
            { "discoverUrl", issuer.discover_url }, { "callbackUrl", CALLBACK_URL } };
        const auto start  = authorize_.start (*db_, config, "embedded");
        if (!start.ok) {
            ADD_FAILURE () << start.error_code << ": " << start.error_message;
            return {};
        }
        if (start.authorize_url.rfind (issuer.authorize_url + "?", 0) != 0) {
            ADD_FAILURE () << "not the mock's authorize URL: " << start.authorize_url;
            return {};
        }
        httplib::Client browser (issuer.issuer_url);
        const auto redirect =
        browser.Get (start.authorize_url.substr (issuer.issuer_url.size ()));
        if (redirect == nullptr || redirect->status != 302) {
            ADD_FAILURE () << "the mock did not redirect: "
                           << (redirect == nullptr ? "no answer" : redirect->body);
            return {};
        }
        return authorize_.complete (
        *db_, start.attempt_id, redirect->get_header_value ("Location"));
    }

    static constexpr const char* CALLBACK_URL = "https://app/callback";
    vayu::http::AuthorizationServerMetadataCache cache_;
    vayu::http::OAuth2AuthorizeManager authorize_{ {}, cache_ };
};

// ---------------------------------------------------------------------------
// Payload validation (pure)
// ---------------------------------------------------------------------------

TEST (MockIssuerSettings, DefaultsWhenNothingIsAskedFor) {
    const auto parsed = vayu::http::parse_mock_issuer_settings (json::object ());
    ASSERT_TRUE (parsed.ok) << parsed.error;
    EXPECT_EQ (parsed.settings.port, 0);
    EXPECT_EQ (parsed.settings.expires_in_seconds, 3600);
    EXPECT_EQ (parsed.settings.failure_mode, "none");
    EXPECT_TRUE (parsed.settings.issue_refresh_tokens);
    EXPECT_TRUE (parsed.settings.clients.empty ());
    EXPECT_TRUE (parsed.settings.claims.is_object ());
}

TEST (MockIssuerSettings, ReadsEveryField) {
    const auto parsed = vayu::http::parse_mock_issuer_settings (
    json{ { "expiresInSeconds", 60 }, { "claims", { { "sub", "alice" } } },
    { "clients",
    json::array ({ json{ { "clientId", "a" }, { "clientSecret", "s" } },
    json{ { "clientId", "public" } } }) },
    { "failureMode", "slow" }, { "slowMs", 10 }, { "issueRefreshTokens", false } });
    ASSERT_TRUE (parsed.ok) << parsed.error;
    EXPECT_EQ (parsed.settings.expires_in_seconds, 60);
    EXPECT_EQ (parsed.settings.claims["sub"], "alice");
    ASSERT_EQ (parsed.settings.clients.size (), 2u);
    EXPECT_EQ (parsed.settings.clients[0].client_secret, "s");
    EXPECT_TRUE (parsed.settings.clients[1].client_secret.empty ());
    EXPECT_EQ (parsed.settings.failure_mode, "slow");
    EXPECT_EQ (parsed.settings.slow_ms, 10);
    EXPECT_FALSE (parsed.settings.issue_refresh_tokens);
}

TEST (MockIssuerSettings, BadInputIsRefusedRatherThanDefaulted) {
    const std::vector<json> bad = {
        json{ { "expiresInSeconds", "3600" } },       // wrong type
        json{ { "expiresInSeconds", 0 } },            // out of range
        json{ { "expiresInSeconds", 40LL * 86400 } }, // past the ceiling
        json{ { "slowMs", -1 } },
        json{ { "failureMode", "explode" } },
        json{ { "failureMode", 3 } },
        json{ { "port", 70000 } },
        json{ { "claims", "sub=alice" } },
        json{ { "clients", "a,b" } },
        json{ { "clients", json::array ({ json{ { "name", "a" } } }) } }, // no clientId
        json{ { "clients", json::array ({ json{ { "clientId", "" } } }) } },
        json{ { "clients",
        json::array ({ json{ { "clientId", "a" }, { "clientSecret", 7 } } }) } },
        json{ { "issueRefreshTokens", "yes" } },
        json{ { "failureMode", "wrong-iss" } },
        json{ { "resourceScope", 7 } },
        json{ { "resourceScope", " mcp:read" } },
        json{ { "resourceScope", "mcp:read " } },
        json{ { "resourceScope", "mcp:read  mcp:write" } },
        json{ { "resourceScope", "mcp\"read" } },
        json{ { "resourceScope", "mcp\\read" } },
        json{ { "resourceScope", "mcp:r\u00e9ad" } },
        json{ { "resourceScope", "mcp:read\tmcp:write" } },
        json{ { "resourceScope",
        std::string (vayu::core::constants::mock_issuer::MAX_RESOURCE_SCOPE_BYTES + 1, 'a') } },
    };
    for (const auto& body : bad) {
        const auto parsed = vayu::http::parse_mock_issuer_settings (body);
        EXPECT_FALSE (parsed.ok) << "accepted: " << body.dump ();
        EXPECT_FALSE (parsed.error.empty ());
    }
    EXPECT_FALSE (vayu::http::parse_mock_issuer_settings (json::array ()).ok);
}

TEST (MockIssuerSettings, PatchTouchesOnlyTheLiveFields) {
    vayu::http::MockIssuerSettings current;
    current.clients.push_back ({ "a", "s" });

    const auto ok = vayu::http::apply_mock_issuer_patch (
    json{ { "failureMode", "server_error" }, { "expiresInSeconds", 30 } }, current);
    ASSERT_TRUE (ok.ok) << ok.error;
    EXPECT_EQ (ok.settings.failure_mode, "server_error");
    EXPECT_EQ (ok.settings.expires_in_seconds, 30);
    EXPECT_EQ (ok.settings.clients.size (), 1u); // untouched half carried over

    for (const char* immutable :
    { "port", "clients", "claims", "issueRefreshTokens", "resourceScope" }) {
        json patch;
        patch[immutable] = json::object ();
        const auto result = vayu::http::apply_mock_issuer_patch (patch, current);
        EXPECT_FALSE (result.ok) << immutable;
        EXPECT_NE (result.error.find (immutable), std::string::npos);
    }
    EXPECT_FALSE (
    vayu::http::apply_mock_issuer_patch (json{ { "slowMs", -5 } }, current).ok);
}

TEST (MockIssuerSettings, ReadsTheResourceScope) {
    EXPECT_TRUE (vayu::http::parse_mock_issuer_settings (json::object ())
    .settings.resource_scope.empty ());
    const auto parsed = vayu::http::parse_mock_issuer_settings (
    json{ { "resourceScope", "mcp:read mcp:write" } });
    ASSERT_TRUE (parsed.ok) << parsed.error;
    EXPECT_EQ (parsed.settings.resource_scope, "mcp:read mcp:write");
    const std::string longest (
    vayu::core::constants::mock_issuer::MAX_RESOURCE_SCOPE_BYTES, 'a');
    EXPECT_TRUE (
    vayu::http::parse_mock_issuer_settings (json{ { "resourceScope", longest } })
    .ok);
    EXPECT_TRUE (
    vayu::http::parse_mock_issuer_settings (json{ { "resourceScope", "" } }).ok);
}

// Every listed mode is accepted at start and by a live patch, and a refusal
// names them all.
TEST (MockIssuerSettings, AcceptsEveryListedFailureMode) {
    for (const std::string_view mode : vayu::http::MOCK_ISSUER_FAILURE_MODES) {
        const auto started = vayu::http::parse_mock_issuer_settings (
        json{ { "failureMode", std::string (mode) } });
        ASSERT_TRUE (started.ok) << mode << ": " << started.error;
        EXPECT_EQ (started.settings.failure_mode, mode);
        EXPECT_TRUE (vayu::http::apply_mock_issuer_patch (
        json{ { "failureMode", std::string (mode) } }, vayu::http::MockIssuerSettings{})
        .ok)
        << mode;
    }
    const auto refused =
    vayu::http::parse_mock_issuer_settings (json{ { "failureMode", "explode" } });
    ASSERT_FALSE (refused.ok);
    for (const char* mode : { "metadata_not_found", "registration_refused", "wrong_iss" }) {
        EXPECT_NE (refused.error.find (mode), std::string::npos) << refused.error;
    }
}

// ---------------------------------------------------------------------------
// The grants, through the engine's own client
// ---------------------------------------------------------------------------

TEST_F (MockIssuerTest, ClientCredentialsMintsAVerifiableJwt) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "expiresInSeconds", 120 } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    auto result = vayu::http::oauth::acquire_token (*db_,
    client_credentials_config (issuer), false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    const auto token = std::get<vayu::db::OAuthToken> (result);

    EXPECT_EQ (token.token_type, "Bearer");
    EXPECT_EQ (token.expires_in, 120);
    ASSERT_EQ (split_jwt (token.access_token).size (), 3u);
    EXPECT_TRUE (signature_verifies (token.access_token, issuer.signing_key));

    const auto payload = decode_jwt_payload (token.access_token);
    ASSERT_TRUE (payload.is_object ());
    EXPECT_EQ (payload["iss"], issuer.issuer_url);
    EXPECT_EQ (payload["client_id"], "cid");
    EXPECT_EQ (payload["exp"].get<int64_t> () - payload["iat"].get<int64_t> (), 120);
}

TEST_F (MockIssuerTest, ConfiguredClaimsRideAlong) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{
    { "claims", { { "sub", "alice" }, { "roles", json::array ({ "admin" }) } } } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    auto result = vayu::http::oauth::acquire_token (*db_,
    client_credentials_config (issuer), false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    const auto payload =
    decode_jwt_payload (std::get<vayu::db::OAuthToken> (result).access_token);
    EXPECT_EQ (payload["sub"], "alice");
    EXPECT_EQ (payload["roles"][0], "admin");
}

TEST_F (MockIssuerTest, PasswordGrantSubjectIsTheUser) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    json config = { { "grantType", "password" }, { "accessTokenUrl", issuer.token_url },
        { "clientId", "cid" }, { "clientSecret", "sec" }, { "username", "bob" },
        { "password", "hunter2" }, { "scope", "read" } };
    auto result = vayu::http::oauth::acquire_token (
    *db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    const auto token = std::get<vayu::db::OAuthToken> (result);
    EXPECT_EQ (token.scope, "read");
    EXPECT_EQ (decode_jwt_payload (token.access_token)["sub"], "bob");
}

TEST_F (MockIssuerTest, AuthorizationCodeWithPkceRoundTrips) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const std::string redirect = "http://127.0.0.1:9/callback";
    const std::string verifier = vayu::http::pkce::random_token (32);
    const std::string code     = authorize_for_code (
    issuer, "cid", redirect, vayu::http::pkce::code_challenge (verifier));
    ASSERT_FALSE (code.empty ());

    json config = { { "grantType", "authorization_code" },
        { "accessTokenUrl", issuer.token_url }, { "clientId", "cid" },
        { "clientSecret", "sec" } };
    auto result = vayu::http::oauth::acquire_token (*db_, config, false,
    vayu::http::oauth::InteractiveExchange{ code, verifier, redirect }, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result))
    << std::get<vayu::http::oauth::TokenError> (result).message;
    EXPECT_TRUE (signature_verifies (
    std::get<vayu::db::OAuthToken> (result).access_token, issuer.signing_key));
}

TEST_F (MockIssuerTest, AuthorizationCodeRejectsAWrongVerifier) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const std::string redirect = "http://127.0.0.1:9/callback";
    const std::string verifier = vayu::http::pkce::random_token (32);
    const std::string code     = authorize_for_code (
    issuer, "cid", redirect, vayu::http::pkce::code_challenge (verifier));
    ASSERT_FALSE (code.empty ());

    json config = { { "grantType", "authorization_code" },
        { "accessTokenUrl", issuer.token_url }, { "clientId", "cid" },
        { "clientSecret", "sec" } };
    auto result = vayu::http::oauth::acquire_token (*db_, config, false,
    vayu::http::oauth::InteractiveExchange{ code, vayu::http::pkce::random_token (32), redirect },
    TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (result));
    EXPECT_EQ (std::get<vayu::http::oauth::TokenError> (result).code, "oauth2_provider_error");
}

TEST_F (MockIssuerTest, AuthorizationCodeIsSingleUse) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const std::string redirect = "http://127.0.0.1:9/callback";
    const std::string code = authorize_for_code (issuer, "cid", redirect, "");
    ASSERT_FALSE (code.empty ());

    json config = { { "grantType", "authorization_code" },
        { "accessTokenUrl", issuer.token_url }, { "clientId", "cid" },
        { "clientSecret", "sec" } };
    const vayu::http::oauth::InteractiveExchange exchange{ code, "", redirect };

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (
    vayu::http::oauth::acquire_token (*db_, config, false, exchange, TOKEN_TIMEOUT_MS)));
    // The cached token would answer a second acquire, so force past it: the
    // *code* is what must be spent.
    db_->delete_oauth_token (vayu::http::oauth::cache_key (config));
    EXPECT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (
    vayu::http::oauth::acquire_token (*db_, config, false, exchange, TOKEN_TIMEOUT_MS)));
}

TEST_F (MockIssuerTest, AuthorizeRefusesAMismatchedRedirectUri) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const std::string code =
    authorize_for_code (issuer, "cid", "http://127.0.0.1:9/callback", "");
    ASSERT_FALSE (code.empty ());

    json config = { { "grantType", "authorization_code" },
        { "accessTokenUrl", issuer.token_url }, { "clientId", "cid" },
        { "clientSecret", "sec" } };
    auto result = vayu::http::oauth::acquire_token (*db_, config, false,
    vayu::http::oauth::InteractiveExchange{ code, "", "http://127.0.0.1:9/elsewhere" },
    TOKEN_TIMEOUT_MS);
    EXPECT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (result));
}

TEST_F (MockIssuerTest, RefreshRotatesAndSpendsTheOldToken) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const auto config = client_credentials_config (issuer);
    auto first        = vayu::http::oauth::acquire_token (
    *db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (first));
    const std::string original_refresh = std::get<vayu::db::OAuthToken> (first).refresh_token;
    ASSERT_FALSE (original_refresh.empty ());

    auto refreshed = vayu::http::oauth::acquire_token (
    *db_, config, true, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (refreshed))
    << std::get<vayu::http::oauth::TokenError> (refreshed).message;
    const auto rotated = std::get<vayu::db::OAuthToken> (refreshed);
    EXPECT_FALSE (rotated.refresh_token.empty ());
    EXPECT_NE (rotated.refresh_token, original_refresh);

    // The spent token is gone: replaying it is rejected by the issuer, which is
    // the behaviour a client's rotation handling has to survive.
    httplib::Client cli (issuer.issuer_url);
    auto replay = cli.Post ("/token",
    "grant_type=refresh_token&client_id=cid&refresh_token=" +
    vayu::utils::url_encode (original_refresh),
    "application/x-www-form-urlencoded");
    ASSERT_TRUE (replay != nullptr);
    EXPECT_EQ (replay->status, 400);
}

TEST_F (MockIssuerTest, RefreshTokensCanBeTurnedOff) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "issueRefreshTokens", false } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    auto result = vayu::http::oauth::acquire_token (*db_,
    client_credentials_config (issuer), false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    EXPECT_TRUE (std::get<vayu::db::OAuthToken> (result).refresh_token.empty ());
}

// ---------------------------------------------------------------------------
// Client authentication
// ---------------------------------------------------------------------------

TEST_F (MockIssuerTest, ConfiguredClientsGateTheTokenEndpoint) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "clients",
    json::array ({ json{ { "clientId", "known" }, { "clientSecret", "s3cret" } } }) } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    // Right id, right secret, both placements RFC 6749 §2.3.1 allows.
    for (const char* placement : { "basic_auth_header", "body" }) {
        json config = client_credentials_config (issuer, "known", "s3cret");
        config["credentialsPlacement"] = placement;
        config["credentialsId"]        = placement; // distinct cache keys
        auto ok                        = vayu::http::oauth::acquire_token (
        *db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS);
        EXPECT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (ok)) << placement;
    }

    auto wrong_secret = vayu::http::oauth::acquire_token (*db_,
    client_credentials_config (issuer, "known", "nope"), false, std::nullopt,
    TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (wrong_secret));
    EXPECT_EQ (std::get<vayu::http::oauth::TokenError> (wrong_secret).provider_status, 401);

    auto unknown_client = vayu::http::oauth::acquire_token (*db_,
    client_credentials_config (issuer, "stranger", "s3cret"), false,
    std::nullopt, TOKEN_TIMEOUT_MS);
    EXPECT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (unknown_client));
}

// #3116: a browser redirect carries no secret, so /authorize checks the id only.
TEST_F (MockIssuerTest, AuthorizeChecksTheClientIdButNeverASecret) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "clients",
    json::array ({ json{ { "clientId", "known" }, { "clientSecret", "s3cret" } } }) } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const std::string redirect = "http://127.0.0.1:9/callback";
    EXPECT_FALSE (authorize_for_code (issuer, "known", redirect, "").empty ());
    EXPECT_TRUE (authorize_for_code (issuer, "stranger", redirect, "").empty ());
    EXPECT_TRUE (authorize_for_code (issuer, "", redirect, "").empty ());

    // The code still has to be redeemed with the secret at /token.
    const std::string code = authorize_for_code (issuer, "known", redirect, "");
    ASSERT_FALSE (code.empty ());
    httplib::Client cli (issuer.issuer_url);
    const std::string body =
    "grant_type=authorization_code&client_id=known&code=" + vayu::utils::url_encode (code) +
    "&redirect_uri=" + vayu::utils::url_encode (redirect);
    auto without_secret = cli.Post (
    "/token", body + "&client_secret=nope", "application/x-www-form-urlencoded");
    ASSERT_TRUE (without_secret != nullptr);
    EXPECT_EQ (without_secret->status, 401);
    auto with_secret = cli.Post ("/token", body + "&client_secret=s3cret",
    "application/x-www-form-urlencoded");
    ASSERT_TRUE (with_secret != nullptr);
    EXPECT_EQ (with_secret->status, 200);
}

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

TEST_F (MockIssuerTest, ServerErrorModeClassifiesAsAProviderError) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "failureMode", "server_error" } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    auto result = vayu::http::oauth::acquire_token (*db_,
    client_credentials_config (issuer), false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (result));
    const auto err = std::get<vayu::http::oauth::TokenError> (result);
    EXPECT_EQ (err.code, "oauth2_provider_error");
    EXPECT_EQ (err.provider_status, 500);
    EXPECT_EQ (err.provider_error, "temporarily_unavailable");
}

TEST_F (MockIssuerTest, InvalidClientModeFailsCleanly) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "failureMode", "invalid_client" } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    auto result = vayu::http::oauth::acquire_token (*db_,
    client_credentials_config (issuer), false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (result));
    const auto err = std::get<vayu::http::oauth::TokenError> (result);
    EXPECT_EQ (err.provider_status, 401);
    EXPECT_EQ (err.provider_error, "invalid_client");
}

TEST_F (MockIssuerTest, SlowModeDelaysTheTokenEndpoint) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "failureMode", "slow" }, { "slowMs", 300 } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const auto started = std::chrono::steady_clock::now ();
    auto result        = vayu::http::oauth::acquire_token (*db_,
    client_credentials_config (issuer), false, std::nullopt, TOKEN_TIMEOUT_MS);
    const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started)
                            .count ();
    EXPECT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    EXPECT_GE (elapsed_ms, 300); // bounded below only - no flaky upper bound
}

// A stop wakes a token request inside the slow mode's delay instead of
// waiting it out (#3345), and the token still goes out. `/authorize` is not
// slowed, so it opens the connection. Healthy: the stop returns in
// milliseconds. Broken: it waits out the whole 30s delay. Ten seconds sits
// between them. Mutation check: put `std::this_thread::sleep_for` back in
// `handle_token` and the stop takes 30s.
TEST_F (MockIssuerTest, StoppingAnIssuerWakesASlowTokenRequest) {
    MockIssuerManager mgr;
    const auto issuer =
    mgr.start (json{ { "failureMode", "slow" }, { "slowMs", 30000 } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    const int port = mgr.list ()["issuers"][0]["port"].get<int> ();

    vayu::tests::HeldRequest held (port,
    vayu::tests::opener_request (
    "GET", "/authorize?client_id=cid&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb"),
    vayu::tests::closing_request ("POST", "/token", "grant_type=client_credentials&client_id=cid"));
    ASSERT_TRUE (
    vayu::tests::wait_until ([&held] { return held.opener_answered (); }))
    << "the issuer never answered /authorize";

    const auto began = std::chrono::steady_clock::now ();
    EXPECT_TRUE (mgr.stop (issuer.issuer_id));
    EXPECT_LT (std::chrono::steady_clock::now () - began, vayu::tests::WAIT_DEADLINE / 2);
    EXPECT_EQ (held.held_status (), 200);
}

TEST_F (MockIssuerTest, FailureModeFlipsOnALiveIssuer) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    const auto config = client_credentials_config (issuer);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (vayu::http::oauth::acquire_token (
    *db_, config, false, std::nullopt, TOKEN_TIMEOUT_MS)));

    const auto updated =
    mgr.update (issuer.issuer_id, json{ { "failureMode", "server_error" } });
    ASSERT_TRUE (updated.found);
    ASSERT_TRUE (updated.ok) << updated.error;
    EXPECT_EQ (updated.issuer["failureMode"], "server_error");

    // force past the cached token so the request actually reaches the issuer
    auto after = vayu::http::oauth::acquire_token (
    *db_, config, true, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (after));
    EXPECT_EQ (std::get<vayu::http::oauth::TokenError> (after).provider_status, 500);
}

// ---------------------------------------------------------------------------
// Discovery metadata, registration and the protected resource (#3794)
// ---------------------------------------------------------------------------

TEST_F (MockIssuerTest, ServesAuthorizationServerMetadata) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    EXPECT_EQ (issuer.metadata_url, issuer.issuer_url + "/.well-known/oauth-authorization-server");
    EXPECT_EQ (issuer.discover_url, issuer.issuer_url + "/resource");

    httplib::Client cli (issuer.issuer_url);
    const auto res = cli.Get ("/.well-known/oauth-authorization-server");
    ASSERT_TRUE (res != nullptr);
    ASSERT_EQ (res->status, 200);
    const auto doc = json::parse (res->body);
    EXPECT_EQ (doc["issuer"], issuer.issuer_url); // byte for byte: RFC 8414 3.3
    EXPECT_EQ (doc["authorization_endpoint"], issuer.authorize_url);
    EXPECT_EQ (doc["token_endpoint"], issuer.token_url);
    EXPECT_EQ (doc["registration_endpoint"], issuer.issuer_url + "/register");
    EXPECT_EQ (doc["response_types_supported"], json::array ({ "code" }));
    EXPECT_EQ (doc["code_challenge_methods_supported"], json::array ({ "S256" }));
    EXPECT_TRUE (doc["grant_types_supported"].is_array ());
    const auto& auth_methods = doc["token_endpoint_auth_methods_supported"];
    EXPECT_NE (std::find (auth_methods.begin (), auth_methods.end (), "none"),
    auth_methods.end ())
    << auth_methods.dump ();
    EXPECT_EQ (doc["authorization_response_iss_parameter_supported"], true);

    const auto listed = mgr.list ()["issuers"][0];
    EXPECT_EQ (listed["metadataUrl"], issuer.metadata_url);
    EXPECT_EQ (listed["discoverUrl"], issuer.discover_url);
    EXPECT_EQ (listed["resourceScope"], "");
}

TEST_F (MockIssuerTest, MetadataNotFoundModeHidesTheMetadata) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "failureMode", "metadata_not_found" } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    httplib::Client cli (issuer.issuer_url);
    const auto res = cli.Get ("/.well-known/oauth-authorization-server");
    ASSERT_TRUE (res != nullptr);
    EXPECT_EQ (res->status, 404);
}

// A registered client is public and bound to its redirect URIs: /authorize
// refuses any other target in place, and /token takes the code with PKCE and
// no secret.
//
// Mutation check: return true before the redirect check in
// `admit_authorize_client` and the elsewhere authorize redirects.
TEST_F (MockIssuerTest, RegistrationIssuesAPublicClientBoundToItsRedirectUris) {
    MockIssuerManager mgr;
    // Configured clients must not stop a registered one.
    const auto issuer = mgr.start (json{ { "clients",
    json::array ({ json{ { "clientId", "known" }, { "clientSecret", "s3cret" } } }) } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const std::string redirect = "http://127.0.0.1:9/callback";
    const auto registered      = post_registration (issuer,
    json{ { "redirect_uris", json::array ({ redirect }) },
    { "token_endpoint_auth_method", "client_secret_basic" } }
    .dump ());
    ASSERT_TRUE (registered != nullptr);
    ASSERT_EQ (registered->status, 201) << registered->body;
    const auto doc              = json::parse (registered->body);
    const std::string client_id = doc.value ("client_id", "");
    ASSERT_FALSE (client_id.empty ()) << registered->body;
    EXPECT_EQ (doc["redirect_uris"], json::array ({ redirect }));
    EXPECT_EQ (doc["token_endpoint_auth_method"], "none");
    EXPECT_FALSE (doc.contains ("client_secret")) << registered->body;

    httplib::Client cli (issuer.issuer_url);
    const std::string verifier  = vayu::http::pkce::random_token (32);
    const std::string challenge = vayu::http::pkce::code_challenge (verifier);
    const std::string base = "/authorize?response_type=code&client_id=" + client_id +
    "&state=S&code_challenge=" + challenge + "&code_challenge_method=S256&redirect_uri=";
    const auto elsewhere =
    cli.Get (base + vayu::utils::url_encode ("http://127.0.0.1:9/elsewhere"));
    ASSERT_TRUE (elsewhere != nullptr);
    EXPECT_EQ (elsewhere->status, 400);
    EXPECT_FALSE (elsewhere->has_header ("Location"));
    const auto prefix = cli.Get (base + vayu::utils::url_encode (redirect + "/x"));
    ASSERT_TRUE (prefix != nullptr);
    EXPECT_EQ (prefix->status, 400)
    << "a registered URI matches exactly, not as a prefix";
    EXPECT_TRUE (authorize_for_code (issuer, client_id, redirect, "").empty ())
    << "a registered client is public and must send PKCE";

    const std::string code = authorize_for_code (issuer, client_id, redirect, challenge);
    ASSERT_FALSE (code.empty ());
    json config = { { "grantType", "authorization_code" },
        { "accessTokenUrl", issuer.token_url }, { "clientId", client_id } };
    auto result = vayu::http::oauth::acquire_token (*db_, config, false,
    vayu::http::oauth::InteractiveExchange{ code, verifier, redirect }, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result))
    << std::get<vayu::http::oauth::TokenError> (result).message;

    // It registered the authorization_code and refresh_token grants only.
    const auto credentials =
    cli.Post ("/token", "grant_type=client_credentials&client_id=" + client_id,
    "application/x-www-form-urlencoded");
    ASSERT_TRUE (credentials != nullptr);
    EXPECT_EQ (credentials->status, 400);
    EXPECT_NE (credentials->body.find ("unauthorized_client"), std::string::npos);
}

TEST_F (MockIssuerTest, RegistrationRefusesBadClientMetadata) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    for (const char* body : { "not json", "[]", "" }) {
        const auto res = post_registration (issuer, body);
        ASSERT_TRUE (res != nullptr);
        EXPECT_EQ (res->status, 400) << body;
        EXPECT_EQ (json::parse (res->body).value ("error", ""), "invalid_client_metadata")
        << body;
    }
    const std::vector<json> bad_redirects = {
        json::object (),
        json{ { "redirect_uris", json::array () } },
        json{ { "redirect_uris", "https://app/cb" } },
        json{ { "redirect_uris", json::array ({ 7 }) } },
        json{ { "redirect_uris", json::array ({ "" }) } },
        json{ { "redirect_uris", json::array ({ "/relative/cb" }) } },
        json{ { "redirect_uris", json::array ({ "https://app/cb#fragment" }) } },
        json{ { "redirect_uris", json::array ({ "https://app/c b" }) } },
        json{ { "redirect_uris",
        json::array ({ "https://app/" +
        std::string (vayu::core::constants::mock_issuer::MAX_REDIRECT_URI_BYTES, 'a') }) } },
        json{ { "redirect_uris",
        json (std::vector<std::string> (
        vayu::core::constants::mock_issuer::MAX_REDIRECT_URIS + 1, "https://app/cb")) } },
    };
    for (const auto& body : bad_redirects) {
        const auto res = post_registration (issuer, body.dump ());
        ASSERT_TRUE (res != nullptr);
        EXPECT_EQ (res->status, 400) << body.dump ();
        EXPECT_EQ (json::parse (res->body).value ("error", ""), "invalid_redirect_uri")
        << body.dump ();
    }
    // A native app's private-use scheme is an absolute URI too.
    EXPECT_FALSE (register_client_for (issuer, "com.example.app:/callback").empty ());
}

TEST_F (MockIssuerTest, RegistrationRefusedModeRefusesEveryRegistration) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "failureMode", "registration_refused" } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    const auto res = post_registration (issuer,
    json{ { "redirect_uris", json::array ({ "https://app/cb" }) } }.dump ());
    ASSERT_TRUE (res != nullptr);
    EXPECT_EQ (res->status, 400);
    EXPECT_EQ (json::parse (res->body).value ("error", ""), "invalid_client_metadata");
}

// RFC 9207: the authorization response names its issuer, which the metadata
// advertises; `wrong_iss` names another.
//
// Mutation check: drop the `iss` append in `authorization_redirect` and the
// first assertion fails.
TEST_F (MockIssuerTest, TheAuthorizeRedirectNamesTheIssuer) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    httplib::Client cli (issuer.issuer_url);
    const std::string target =
    "/authorize?response_type=code&client_id=cid&state=S&redirect_uri=" +
    vayu::utils::url_encode ("http://127.0.0.1:9/callback?keep=1");
    const auto res = cli.Get (target);
    ASSERT_TRUE (res != nullptr);
    ASSERT_EQ (res->status, 302);
    const std::string location = res->get_header_value ("Location");
    EXPECT_EQ (query_param (location, "iss"), issuer.issuer_url) << location;
    EXPECT_EQ (query_param (location, "keep"), "1") << location;
    EXPECT_EQ (query_param (location, "state"), "S") << location;

    ASSERT_TRUE (
    mgr.update (issuer.issuer_id, json{ { "failureMode", "wrong_iss" } }).ok);
    const auto wrong = cli.Get (target);
    ASSERT_TRUE (wrong != nullptr);
    ASSERT_EQ (wrong->status, 302);
    EXPECT_EQ (query_param (wrong->get_header_value ("Location"), "iss"),
    issuer.issuer_url + "/other");
}

TEST_F (MockIssuerTest, ServesProtectedResourceMetadata) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    httplib::Client cli (issuer.issuer_url);
    const auto res = cli.Get ("/.well-known/oauth-protected-resource");
    ASSERT_TRUE (res != nullptr);
    ASSERT_EQ (res->status, 200);
    const auto doc = json::parse (res->body);
    EXPECT_EQ (doc["resource"], issuer.discover_url);
    EXPECT_EQ (doc["authorization_servers"], json::array ({ issuer.issuer_url }));
    EXPECT_EQ (doc["bearer_methods_supported"], json::array ({ "header" }));
}

TEST_F (MockIssuerTest, TheResourceWithoutARequiredScopeTakesAnyOfItsTokens) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    const std::string metadata = issuer.issuer_url + "/.well-known/oauth-protected-resource";

    const auto anonymous = get_resource (issuer, "");
    ASSERT_TRUE (anonymous != nullptr);
    EXPECT_EQ (anonymous->status, 401);
    EXPECT_EQ (anonymous->get_header_value ("WWW-Authenticate"),
    "Bearer resource_metadata=\"" + metadata + "\"");

    auto result = vayu::http::oauth::acquire_token (*db_,
    client_credentials_config (issuer), false, std::nullopt, TOKEN_TIMEOUT_MS);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    const auto ok = get_resource (
    issuer, "Bearer " + std::get<vayu::db::OAuthToken> (result).access_token);
    ASSERT_TRUE (ok != nullptr);
    EXPECT_EQ (ok->status, 200) << ok->body;
    EXPECT_EQ (json::parse (ok->body)["resource"], issuer.discover_url);
}

// The three answers an MCP client must tell apart: no token (401, where the
// metadata is), a token that is not good (401 invalid_token) and a token too
// narrow (403 insufficient_scope, the step-up).
TEST_F (MockIssuerTest, TheResourceDemandsItsScope) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "resourceScope", "mcp:read" } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    EXPECT_EQ (mgr.list ()["issuers"][0]["resourceScope"], "mcp:read");
    const std::string metadata = issuer.issuer_url + "/.well-known/oauth-protected-resource";

    const auto anonymous = get_resource (issuer, "");
    ASSERT_TRUE (anonymous != nullptr);
    EXPECT_EQ (anonymous->status, 401);
    EXPECT_EQ (anonymous->get_header_value ("WWW-Authenticate"),
    "Bearer scope=\"mcp:read\", resource_metadata=\"" + metadata + "\"");

    const json claims = { { "iss", issuer.issuer_url }, { "scope", "mcp:read" },
        { "exp", now_s () + 600 } };
    const std::string good = sign_jwt (issuer.signing_key, claims);
    const std::vector<std::string> not_good = {
        "Bearer not-a-jwt",
        "Bearer " + good + "x",                       // tag altered
        "Bearer " + sign_jwt ("another key", claims), // another issuer
        "Bearer " +
        sign_jwt (issuer.signing_key,
        json{ { "scope", "mcp:read" }, { "exp", now_s () - 600 } }), // expired
        "Bearer " + sign_jwt (issuer.signing_key, json{ { "scope", "mcp:read" } }), // no exp
        "Basic " + good,
    };
    for (const auto& authorization : not_good) {
        const auto res = get_resource (issuer, authorization);
        ASSERT_TRUE (res != nullptr);
        EXPECT_EQ (res->status, 401) << authorization;
    }
    const auto invalid = get_resource (issuer, "Bearer not-a-jwt");
    ASSERT_TRUE (invalid != nullptr);
    EXPECT_EQ (invalid->get_header_value ("WWW-Authenticate"),
    "Bearer error=\"invalid_token\", scope=\"mcp:read\", resource_metadata=\"" +
    metadata + "\"");

    const auto narrow = get_resource (issuer,
    "Bearer " +
    sign_jwt (issuer.signing_key,
    json{ { "scope", "mcp:write" }, { "exp", now_s () + 600 } }));
    ASSERT_TRUE (narrow != nullptr);
    EXPECT_EQ (narrow->status, 403);
    EXPECT_EQ (narrow->get_header_value ("WWW-Authenticate"),
    "Bearer error=\"insufficient_scope\", scope=\"mcp:read\", "
    "resource_metadata=\"" +
    metadata + "\"");

    const auto ok = get_resource (issuer, "bearer " + good);
    ASSERT_TRUE (ok != nullptr);
    EXPECT_EQ (ok->status, 200) << ok->body;
    EXPECT_EQ (json::parse (ok->body)["scope"], "mcp:read");
}

// The engine's own MCP OAuth discovery finds the mock from the URL the start
// call hands back, offline.
//
// Mutation check: serve another `issuer` from `handle_metadata` and the
// discovery refuses it (`oauth_discovery_issuer_mismatch`).
TEST_F (MockIssuerDiscoveryTest, DiscoveryFindsTheMockFromItsDiscoverUrl) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "resourceScope", "mcp:read" } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const auto found = discover (issuer);
    ASSERT_HAS_VALUE (found) << found.error ().code << ": " << found.error ().message;
    EXPECT_EQ (found->resource, issuer.discover_url);
    EXPECT_EQ (found->challenge_scope.value_or (""), "mcp:read");
    const auto& server = found->authorization_server;
    EXPECT_EQ (server.issuer, issuer.issuer_url);
    EXPECT_EQ (server.authorization_endpoint, issuer.authorize_url);
    EXPECT_EQ (server.token_endpoint, issuer.token_url);
    EXPECT_EQ (server.registration_endpoint.value_or (""), issuer.issuer_url + "/register");
    EXPECT_TRUE (server.authorization_response_iss_parameter_supported);
}

TEST_F (MockIssuerDiscoveryTest, DiscoveryReportsMetadataNotFound) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "failureMode", "metadata_not_found" } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    const auto found = discover (issuer);
    ASSERT_FALSE (found.has_value ());
    EXPECT_EQ (found.error ().code,
    vayu::http::oauth_discovery::AUTHORIZATION_SERVER_METADATA_NOT_FOUND);
}

// The whole MCP sign-in against the mock with nothing configured but its
// discover URL: discovery, registration, the authorize redirect with `iss`,
// and the PKCE exchange as a public client. The token it stores opens the
// resource.
TEST_F (MockIssuerDiscoveryTest, ADiscoveredSignInCompletesAgainstTheMock) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "resourceScope", "mcp:read" } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const auto status = sign_in (issuer);
    ASSERT_EQ (status.state, "completed") << status.error;
    const auto token = db_->get_oauth_token (status.cache_key);
    ASSERT_HAS_VALUE (token);
    EXPECT_TRUE (signature_verifies (token->access_token, issuer.signing_key));
    const auto opened = get_resource (issuer, "Bearer " + token->access_token);
    ASSERT_TRUE (opened != nullptr);
    EXPECT_EQ (opened->status, 200) << opened->body;
}

TEST_F (MockIssuerDiscoveryTest, AWrongIssFailsTheDiscoveredSignIn) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "failureMode", "wrong_iss" } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const auto status = sign_in (issuer);
    EXPECT_EQ (status.state, "failed");
    EXPECT_NE (status.error.find (issuer.issuer_url + "/other"), std::string::npos)
    << status.error;
    EXPECT_NE (status.error.find ("RFC 9207"), std::string::npos) << status.error;
}

TEST_F (MockIssuerDiscoveryTest, RegistrationRefusedFailsTheDiscoveredSignIn) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "failureMode", "registration_refused" } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    const json config = { { "grantType", "authorization_code" },
        { "discoverUrl", issuer.discover_url }, { "callbackUrl", CALLBACK_URL } };
    const auto start  = authorize_.start (*db_, config, "embedded");
    EXPECT_FALSE (start.ok);
    EXPECT_NE (start.error_message.find ("invalid_client_metadata"), std::string::npos)
    << start.error_message;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

TEST_F (MockIssuerTest, ListsAndStops) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const auto listed = mgr.list ();
    ASSERT_EQ (listed["issuers"].size (), 1u);
    EXPECT_EQ (listed["issuers"][0]["issuerId"], issuer.issuer_id);
    EXPECT_EQ (listed["issuers"][0]["tokenUrl"], issuer.token_url);

    EXPECT_TRUE (mgr.stop (issuer.issuer_id));
    EXPECT_FALSE (mgr.stop (issuer.issuer_id)); // idempotent-by-absence
    EXPECT_EQ (mgr.list ()["issuers"].size (), 0u);

    httplib::Client cli (issuer.issuer_url);
    cli.set_connection_timeout (1, 0);
    EXPECT_EQ (cli.Get ("/authorize"), nullptr); // nothing is listening any more
}

TEST_F (MockIssuerTest, UpdateAndStopReportUnknownIds) {
    MockIssuerManager mgr;
    EXPECT_FALSE (mgr.stop ("issuer_nope"));
    EXPECT_FALSE (mgr.update ("issuer_nope", json{ { "failureMode", "none" } }).found);
}

TEST_F (MockIssuerTest, ASecondIssuerCannotShareARunningIssuersPort) {
    // SO_REUSEPORT makes the bind itself succeed on Linux, so without the
    // listener's port guard both issuers would run on one port and the kernel
    // would hand each of them a random half of the token requests (#512).
    MockIssuerManager mgr;
    const auto first = mgr.start (json::object ());
    ASSERT_TRUE (first.ok) << first.error_message;
    const int port = mgr.list ()["issuers"][0]["port"].get<int> ();

    const auto refused = mgr.start (json{ { "port", port } });
    EXPECT_FALSE (refused.ok);
    EXPECT_EQ (refused.http_status, 500);
    EXPECT_EQ (refused.error_code, "mock_issuer_bind_failed");
    EXPECT_EQ (refused.error_message.rfind ("Couldn't bind ", 0), 0u)
    << "the app shows this beneath its own \"Couldn't ...\" heading: "
    << refused.error_message;
    EXPECT_NE (refused.error_message.find (first.issuer_id), std::string::npos)
    << "the refusal must name the holder: " << refused.error_message;
    EXPECT_EQ (mgr.list ()["issuers"].size (), 1u)
    << "a refused start left a record";

    // An explicitly requested port that is genuinely free still starts: the
    // guard holds the port only while its issuer runs.
    ASSERT_TRUE (mgr.stop (first.issuer_id));
    const auto restarted = mgr.start (json{ { "port", port } });
    EXPECT_TRUE (restarted.ok) << restarted.error_message;
    EXPECT_EQ (mgr.list ()["issuers"][0]["port"].get<int> (), port);
}

TEST_F (MockIssuerTest, RefusesMoreIssuersThanTheBudget) {
    MockIssuerManager mgr;
    for (size_t i = 0; i < vayu::core::constants::mock_issuer::MAX_ISSUERS; ++i) {
        ASSERT_TRUE (mgr.start (json::object ()).ok) << i;
    }
    const auto refused = mgr.start (json::object ());
    EXPECT_FALSE (refused.ok);
    EXPECT_EQ (refused.error_code, "mock_issuer_limit_reached");
    EXPECT_EQ (refused.http_status, 429);
}

TEST_F (MockIssuerTest, ConcurrentStartsCannotExceedTheBudget) {
    // Every start is released at once, so they all ask for a slot while none
    // has finished binding. The cap used to be checked under one acquisition
    // of the manager's lock and the issuer inserted under another, and every
    // start between the two passed the check. Mutation check: count only
    // `entries_.size ()` in `ListenerRegistry::reserve` and more than
    // MAX_ISSUERS of these succeed.
    constexpr auto cap = vayu::core::constants::mock_issuer::MAX_ISSUERS;
    MockIssuerManager mgr;
    std::latch go (static_cast<std::ptrdiff_t> (cap * 2));
    std::atomic<std::size_t> started{ 0 };
    std::atomic<std::size_t> refused_at_cap{ 0 };
    std::vector<std::thread> starters;
    starters.reserve (cap * 2);
    for (std::size_t i = 0; i < cap * 2; ++i) {
        starters.emplace_back ([&] {
            go.arrive_and_wait ();
            const auto result = mgr.start (json::object ());
            if (result.ok) {
                started.fetch_add (1);
            } else if (result.error_code == "mock_issuer_limit_reached") {
                refused_at_cap.fetch_add (1);
            }
        });
    }
    for (auto& starter : starters) {
        starter.join ();
    }
    EXPECT_EQ (started.load (), cap);
    EXPECT_EQ (refused_at_cap.load (), cap);
    EXPECT_EQ (mgr.list ()["issuers"].size (), cap);
}

TEST_F (MockIssuerTest, ShutdownStopsEveryIssuerAndRefusesLaterStarts) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    mgr.shutdown ();
    mgr.shutdown ();
    EXPECT_TRUE (mgr.list ()["issuers"].empty ());
    EXPECT_FALSE (mgr.stop (issuer.issuer_id));

    httplib::Client cli (issuer.issuer_url);
    cli.set_connection_timeout (1, 0);
    EXPECT_EQ (cli.Get ("/authorize"), nullptr)
    << "the issuer is still listening";

    const auto refused = mgr.start (json::object ());
    EXPECT_FALSE (refused.ok);
    EXPECT_EQ (refused.http_status, 503);
    EXPECT_EQ (refused.error_code, "unavailable");
    EXPECT_TRUE (mgr.list ()["issuers"].empty ());
}

TEST_F (MockIssuerTest, DestructorStopsALiveIssuer) {
    std::string issuer_url;
    {
        MockIssuerManager mgr;
        const auto issuer = mgr.start (json::object ());
        ASSERT_TRUE (issuer.ok) << issuer.error_message;
        issuer_url = issuer.issuer_url;
    }
    httplib::Client cli (issuer_url);
    cli.set_connection_timeout (1, 0);
    EXPECT_EQ (cli.Get ("/authorize"), nullptr);
}

} // namespace
