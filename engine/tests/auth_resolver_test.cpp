/**
 * @file tests/auth_resolver_test.cpp
 * @brief Tests for apply_auth (static auth modes).
 */

#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <variant>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/types.hpp"

using nlohmann::json;

namespace {

vayu::Request make_request (
const std::string& url = "https://api.example.com/v1") {
    vayu::Request req;
    req.url = url;
    return req;
}

TEST (AuthResolver, NoneAndInheritAreNoOps) {
    for (const char* mode : { "none", "inherit" }) {
        auto req = make_request ();
        auto result = vayu::http::apply_auth (req, json{ { "mode", mode } }, nullptr);
        EXPECT_TRUE (result.ok);
        EXPECT_TRUE (req.headers.empty ());
    }
}

TEST (AuthResolver, MissingOrNullAuthIsNoOp) {
    auto req    = make_request ();
    auto result = vayu::http::apply_auth (req, json (nullptr), nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_TRUE (req.headers.empty ());
}

TEST (AuthResolver, BearerSetsAuthorizationHeader) {
    auto req    = make_request ();
    auto result = vayu::http::apply_auth (
    req, json{ { "mode", "bearer" }, { "token", "abc123" } }, nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.headers.at ("Authorization"), "Bearer abc123");
}

TEST (AuthResolver, BasicEncodesCredentials) {
    auto req    = make_request ();
    auto result = vayu::http::apply_auth (req,
    json{ { "mode", "basic" }, { "username", "Aladdin" }, { "password", "open sesame" } },
    nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.headers.at ("Authorization"), "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
}

TEST (AuthResolver, ApiKeyInHeader) {
    auto req    = make_request ();
    auto result = vayu::http::apply_auth (req,
    json{ { "mode", "apikey" }, { "key", "X-Api-Key" }, { "value", "secret" },
    { "in", "header" } },
    nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.headers.at ("X-Api-Key"), "secret");
    // The transfer log redacts by this name (issue #1781).
    EXPECT_EQ (req.secret_header_names, std::vector<std::string>{ "X-Api-Key" });
    EXPECT_TRUE (req.auth_query_param.empty ());
}

TEST (AuthResolver, ApiKeyInQueryAppendsToUrl) {
    auto req    = make_request ("https://api.example.com/v1");
    auto result = vayu::http::apply_auth (req,
    json{ { "mode", "apikey" }, { "key", "api key" }, { "value", "a b" }, { "in", "query" } },
    nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.url, "https://api.example.com/v1?api%20key=a%20b");
    // The raw name, not the encoded one: the trace records it (#1835) for a
    // reader that masks the parameter by name.
    EXPECT_EQ (req.auth_query_param, "api key");
    EXPECT_TRUE (req.secret_header_names.empty ());
}

// Issue #1771: Postman adds an API key as a query param, so it is written by
// Postman's query rule - `|`, `+` and `=` in a value go out as typed. Mutation
// check: put `utils::url_encode` back in `append_query_param` and this reds.
TEST (AuthResolver, ApiKeyInQueryIsWrittenByPostmansQueryRule) {
    auto req    = make_request ("https://api.example.com/v1");
    auto result = vayu::http::apply_auth (req,
    json{ { "mode", "apikey" }, { "key", "k" }, { "value", "a|b+c=d" }, { "in", "query" } },
    nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.url, "https://api.example.com/v1?k=a|b+c=d");
}

// Issue #1765: a request whose Postman item says `disableUrlEncoding` sends
// its api key as typed. Mutation check: pass `true` for `encode` at the
// ApiKeyAuth call of `append_query_param` and this reds.
TEST (AuthResolver, ApiKeyInQueryIsWrittenAsTypedWhenUrlEncodingIsOff) {
    auto req                 = make_request ("https://api.example.com/v1");
    req.disable_url_encoding = true;
    auto result              = vayu::http::apply_auth (req,
                 json{ { "mode", "apikey" }, { "key", "k|1" }, { "value", "a|b" }, { "in", "query" } },
                 nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.url, "https://api.example.com/v1?k|1=a|b");
}

TEST (AuthResolver, ApiKeyInQueryUsesAmpersandWhenQueryExists) {
    auto req = make_request ("https://api.example.com/v1?page=2");
    vayu::http::apply_auth (req,
    json{ { "mode", "apikey" }, { "key", "token" }, { "value", "x" }, { "in", "query" } },
    nullptr);
    EXPECT_EQ (req.url, "https://api.example.com/v1?page=2&token=x");
}

TEST (AuthResolver, ApiKeyInQueryPreservesFragment) {
    auto req = make_request ("https://api.example.com/v1#section");
    vayu::http::apply_auth (req,
    json{ { "mode", "apikey" }, { "key", "token" }, { "value", "x" }, { "in", "query" } },
    nullptr);
    EXPECT_EQ (req.url, "https://api.example.com/v1?token=x#section");
}

TEST (AuthResolver, UserSuppliedAuthorizationHeaderWins) {
    auto req                     = make_request ();
    req.headers["authorization"] = "Bearer user-typed";
    auto result                  = vayu::http::apply_auth (
    req, json{ { "mode", "bearer" }, { "token", "should-not-apply" } }, nullptr);
    EXPECT_TRUE (result.ok);
    // Case-insensitive: the user's lowercase header is found and preserved, and
    // no second (differently-cased) Authorization header is added.
    EXPECT_EQ (req.headers.size (), 1u);
    EXPECT_EQ (req.headers.at ("Authorization"), "Bearer user-typed");
}

TEST (AuthResolver, Oauth2WithoutDatabaseFailsCleanly) {
    // oauth2 needs the token cache; with no DB it must fail (not silently send
    // an unauthenticated request), and must not mutate the request.
    auto req    = make_request ();
    auto result = vayu::http::apply_auth (
    req, json{ { "mode", "oauth2" }, { "config", json::object () } }, nullptr);
    EXPECT_FALSE (result.ok);
    EXPECT_EQ (result.code, vayu::ErrorCode::AuthFailed);
    EXPECT_TRUE (req.headers.empty ());
}

// Issue #1835: the OAuth 2.0 token placed in the query is recorded by name too.
// Mutation check: drop the `auth_query_param` assignment in `resolve_oauth2`
// and the first two reds.
class AuthResolverOAuth2Test : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_auth_resolver_oauth2.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }
    void TearDown () override {
        db.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// A config whose token is already cached, so no identity provider is asked.
    json cached_config (const json& placement) {
        json config = { { "grantType", "client_credentials" },
            { "accessTokenUrl", "https://idp.test/token" },
            { "clientId", "cid" }, { "clientSecret", "secret" } };
        config.update (placement);

        vayu::db::OAuthToken token;
        token.cache_key    = vayu::http::oauth::cache_key (config);
        token.access_token = "AT1";
        token.token_type   = "Bearer";
        token.expires_in   = 3600;
        token.created_at = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                           .count ();
        db->save_oauth_token (token);
        return config;
    }

    std::unique_ptr<vayu::db::Database> db;
};

TEST_F (AuthResolverOAuth2Test, QueryPlacementRecordsTheConfiguredParameter) {
    auto req = make_request ();
    const json config =
    cached_config ({ { "tokenPlacement", "query" }, { "queryParamName", "tok" } });
    auto result = vayu::http::apply_auth (
    req, json{ { "mode", "oauth2" }, { "config", config } }, db.get ());
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.url, "https://api.example.com/v1?tok=AT1");
    EXPECT_EQ (req.auth_query_param, "tok");
}

TEST_F (AuthResolverOAuth2Test, QueryPlacementDefaultsTheParameterToAccessToken) {
    auto req          = make_request ();
    const json config = cached_config ({ { "tokenPlacement", "query" } });
    vayu::http::apply_auth (
    req, json{ { "mode", "oauth2" }, { "config", config } }, db.get ());
    EXPECT_EQ (req.url, "https://api.example.com/v1?access_token=AT1");
    EXPECT_EQ (req.auth_query_param, "access_token");
}

TEST_F (AuthResolverOAuth2Test, HeaderPlacementLeavesTheQueryParameterEmpty) {
    auto req          = make_request ();
    const json config = cached_config (json::object ());
    auto result       = vayu::http::apply_auth (
    req, json{ { "mode", "oauth2" }, { "config", config } }, db.get ());
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.headers.at ("Authorization"), "Bearer AT1");
    EXPECT_TRUE (req.auth_query_param.empty ());
}

TEST (ParseAuth, MapsModesToVariantAlternatives) {
    using namespace vayu::http;
    EXPECT_TRUE (std::holds_alternative<NoAuth> (parse_auth (json (nullptr))));
    EXPECT_TRUE (std::holds_alternative<NoAuth> (parse_auth (json{ { "mode", "none" } })));
    EXPECT_TRUE (
    std::holds_alternative<NoAuth> (parse_auth (json{ { "mode", "inherit" } })));
    EXPECT_TRUE (std::holds_alternative<BearerAuth> (
    parse_auth (json{ { "mode", "bearer" }, { "token", "t" } })));
    EXPECT_TRUE (
    std::holds_alternative<BasicAuth> (parse_auth (json{ { "mode", "basic" } })));
    EXPECT_TRUE (std::holds_alternative<OAuth2Auth> (
    parse_auth (json{ { "mode", "oauth2" }, { "config", json::object () } })));

    auto ak = parse_auth (json{
    { "mode", "apikey" }, { "key", "k" }, { "value", "v" }, { "in", "query" } });
    ASSERT_TRUE (std::holds_alternative<ApiKeyAuth> (ak));
    EXPECT_TRUE (std::get<ApiKeyAuth> (ak).in_query);

    auto un = parse_auth (json{ { "mode", "ntlm" } });
    ASSERT_TRUE (std::holds_alternative<UnsupportedAuth> (un));
    EXPECT_EQ (std::get<UnsupportedAuth> (un).mode, "ntlm");
}

} // namespace
