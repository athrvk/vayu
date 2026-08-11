/**
 * @file tests/mock_issuer_test.cpp
 * @brief Tests for the local OAuth 2.0 mock issuer: payload validation, the
 *        four grants driven through the engine's *own* token client, PKCE,
 *        rotation, the switchable failure modes, and lifecycle.
 *
 * The round trips deliberately go through `oauth::acquire_token` rather than a
 * hand-written httplib client: the point of the issuer is that the engine's own
 * OAuth path works against it offline, so anything it accepts that
 * `acquire_token` cannot drive would be a mock of the wrong thing.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/mock_issuer.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/pkce.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/sha256.hpp"

using nlohmann::json;
using vayu::http::MockIssuerManager;
using vayu::http::MockIssuerStart;

namespace {

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
    return parts[2] ==
    vayu::utils::base64url_encode (
    std::string_view (reinterpret_cast<const char*> (tag.data ()), tag.size ()));
}

json decode_jwt_payload (const std::string& jwt) {
    const auto parts = split_jwt (jwt);
    if (parts.size () != 3) {
        return json ();
    }
    std::string standard = parts[1];
    for (char& c : standard) {
        c = c == '-' ? '+' : (c == '_' ? '/' : c);
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

    for (const char* immutable : { "port", "clients", "claims", "issueRefreshTokens" }) {
        json patch;
        patch[immutable] = json::object ();
        const auto result = vayu::http::apply_mock_issuer_patch (patch, current);
        EXPECT_FALSE (result.ok) << immutable;
        EXPECT_NE (result.error.find (immutable), std::string::npos);
    }
    EXPECT_FALSE (
    vayu::http::apply_mock_issuer_patch (json{ { "slowMs", -5 } }, current).ok);
}

// ---------------------------------------------------------------------------
// The grants, through the engine's own client
// ---------------------------------------------------------------------------

TEST_F (MockIssuerTest, ClientCredentialsMintsAVerifiableJwt) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "expiresInSeconds", 120 } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    auto result = vayu::http::oauth::acquire_token (
    *db_, client_credentials_config (issuer), false, std::nullopt);
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

    auto result = vayu::http::oauth::acquire_token (
    *db_, client_credentials_config (issuer), false, std::nullopt);
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
    auto result = vayu::http::oauth::acquire_token (*db_, config, false, std::nullopt);
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
    vayu::http::oauth::InteractiveExchange{ code, verifier, redirect });
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
    vayu::http::oauth::InteractiveExchange{
    code, vayu::http::pkce::random_token (32), redirect });
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
    vayu::http::oauth::acquire_token (*db_, config, false, exchange)));
    // The cached token would answer a second acquire, so force past it: the
    // *code* is what must be spent.
    db_->delete_oauth_token (vayu::http::oauth::cache_key (config));
    EXPECT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (
    vayu::http::oauth::acquire_token (*db_, config, false, exchange)));
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
    vayu::http::oauth::InteractiveExchange{ code, "", "http://127.0.0.1:9/elsewhere" });
    EXPECT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (result));
}

TEST_F (MockIssuerTest, RefreshRotatesAndSpendsTheOldToken) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    const auto config = client_credentials_config (issuer);
    auto first = vayu::http::oauth::acquire_token (*db_, config, false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (first));
    const std::string original_refresh = std::get<vayu::db::OAuthToken> (first).refresh_token;
    ASSERT_FALSE (original_refresh.empty ());

    auto refreshed = vayu::http::oauth::acquire_token (*db_, config, true, std::nullopt);
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

    auto result = vayu::http::oauth::acquire_token (
    *db_, client_credentials_config (issuer), false, std::nullopt);
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
        auto ok = vayu::http::oauth::acquire_token (*db_, config, false, std::nullopt);
        EXPECT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (ok)) << placement;
    }

    auto wrong_secret = vayu::http::oauth::acquire_token (*db_,
    client_credentials_config (issuer, "known", "nope"), false, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (wrong_secret));
    EXPECT_EQ (std::get<vayu::http::oauth::TokenError> (wrong_secret).provider_status, 401);

    auto unknown_client = vayu::http::oauth::acquire_token (*db_,
    client_credentials_config (issuer, "stranger", "s3cret"), false, std::nullopt);
    EXPECT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (unknown_client));
}

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

TEST_F (MockIssuerTest, ServerErrorModeClassifiesAsAProviderError) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json{ { "failureMode", "server_error" } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;

    auto result = vayu::http::oauth::acquire_token (
    *db_, client_credentials_config (issuer), false, std::nullopt);
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

    auto result = vayu::http::oauth::acquire_token (
    *db_, client_credentials_config (issuer), false, std::nullopt);
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
    auto result        = vayu::http::oauth::acquire_token (
    *db_, client_credentials_config (issuer), false, std::nullopt);
    const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started)
                            .count ();
    EXPECT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (result));
    EXPECT_GE (elapsed_ms, 300); // bounded below only - no flaky upper bound
}

TEST_F (MockIssuerTest, FailureModeFlipsOnALiveIssuer) {
    MockIssuerManager mgr;
    const auto issuer = mgr.start (json::object ());
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    const auto config = client_credentials_config (issuer);

    ASSERT_TRUE (std::holds_alternative<vayu::db::OAuthToken> (
    vayu::http::oauth::acquire_token (*db_, config, false, std::nullopt)));

    const auto updated =
    mgr.update (issuer.issuer_id, json{ { "failureMode", "server_error" } });
    ASSERT_TRUE (updated.found);
    ASSERT_TRUE (updated.ok) << updated.error;
    EXPECT_EQ (updated.issuer["failureMode"], "server_error");

    // force past the cached token so the request actually reaches the issuer
    auto after = vayu::http::oauth::acquire_token (*db_, config, true, std::nullopt);
    ASSERT_TRUE (std::holds_alternative<vayu::http::oauth::TokenError> (after));
    EXPECT_EQ (std::get<vayu::http::oauth::TokenError> (after).provider_status, 500);
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
