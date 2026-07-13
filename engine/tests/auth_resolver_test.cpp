/**
 * @file tests/auth_resolver_test.cpp
 * @brief Tests for apply_auth (static auth modes).
 */

#include <gtest/gtest.h>

#include <variant>

#include <nlohmann/json.hpp>

#include "vayu/http/auth_resolver.hpp"
#include "vayu/types.hpp"

using nlohmann::json;

namespace {

vayu::Request make_request (const std::string& url = "https://api.example.com/v1") {
    vayu::Request req;
    req.url = url;
    return req;
}

TEST (AuthResolver, NoneAndInheritAreNoOps) {
    for (const char* mode : { "none", "inherit" }) {
        auto req    = make_request ();
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
    auto req = make_request ();
    auto result = vayu::http::apply_auth (
    req, json{ { "mode", "bearer" }, { "token", "abc123" } }, nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.headers.at ("Authorization"), "Bearer abc123");
}

TEST (AuthResolver, BasicEncodesCredentials) {
    auto req = make_request ();
    auto result = vayu::http::apply_auth (
    req, json{ { "mode", "basic" }, { "username", "Aladdin" }, { "password", "open sesame" } },
    nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.headers.at ("Authorization"), "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
}

TEST (AuthResolver, ApiKeyInHeader) {
    auto req = make_request ();
    auto result = vayu::http::apply_auth (
    req, json{ { "mode", "apikey" }, { "key", "X-Api-Key" }, { "value", "secret" }, { "in", "header" } },
    nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.headers.at ("X-Api-Key"), "secret");
}

TEST (AuthResolver, ApiKeyInQueryAppendsToUrl) {
    auto req = make_request ("https://api.example.com/v1");
    auto result = vayu::http::apply_auth (
    req, json{ { "mode", "apikey" }, { "key", "api key" }, { "value", "a b" }, { "in", "query" } },
    nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_EQ (req.url, "https://api.example.com/v1?api%20key=a%20b");
}

TEST (AuthResolver, ApiKeyInQueryUsesAmpersandWhenQueryExists) {
    auto req = make_request ("https://api.example.com/v1?page=2");
    vayu::http::apply_auth (
    req, json{ { "mode", "apikey" }, { "key", "token" }, { "value", "x" }, { "in", "query" } },
    nullptr);
    EXPECT_EQ (req.url, "https://api.example.com/v1?page=2&token=x");
}

TEST (AuthResolver, ApiKeyInQueryPreservesFragment) {
    auto req = make_request ("https://api.example.com/v1#section");
    vayu::http::apply_auth (
    req, json{ { "mode", "apikey" }, { "key", "token" }, { "value", "x" }, { "in", "query" } },
    nullptr);
    EXPECT_EQ (req.url, "https://api.example.com/v1?token=x#section");
}

TEST (AuthResolver, UserSuppliedAuthorizationHeaderWins) {
    auto req = make_request ();
    req.headers["authorization"] = "Bearer user-typed";
    auto result = vayu::http::apply_auth (
    req, json{ { "mode", "bearer" }, { "token", "should-not-apply" } }, nullptr);
    EXPECT_TRUE (result.ok);
    // Case-insensitive: the user's lowercase header is found and preserved, and
    // no second (differently-cased) Authorization header is added.
    EXPECT_EQ (req.headers.size (), 1u);
    EXPECT_EQ (req.headers.at ("Authorization"), "Bearer user-typed");
}

TEST (AuthResolver, Oauth2IsNoOpForNow) {
    auto req = make_request ();
    auto result = vayu::http::apply_auth (
    req, json{ { "mode", "oauth2" }, { "config", json::object () } }, nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_TRUE (req.headers.empty ());
}

TEST (AuthResolver, HeadersAreCaseInsensitive) {
    // A user-typed lowercase "authorization" blocks bearer injection.
    auto req                     = make_request ();
    req.headers["authorization"] = "Bearer typed";
    vayu::http::apply_auth (
    req, json{ { "mode", "bearer" }, { "token", "auto" } }, nullptr);
    EXPECT_EQ (req.headers.size (), 1u);
    EXPECT_EQ (req.headers.at ("Authorization"), "Bearer typed");
}

TEST (ParseAuth, MapsModesToVariantAlternatives) {
    using namespace vayu::http;
    EXPECT_TRUE (std::holds_alternative<NoAuth> (parse_auth (json (nullptr))));
    EXPECT_TRUE (std::holds_alternative<NoAuth> (parse_auth (json{ { "mode", "none" } })));
    EXPECT_TRUE (std::holds_alternative<NoAuth> (parse_auth (json{ { "mode", "inherit" } })));
    EXPECT_TRUE (std::holds_alternative<BearerAuth> (
    parse_auth (json{ { "mode", "bearer" }, { "token", "t" } })));
    EXPECT_TRUE (std::holds_alternative<BasicAuth> (parse_auth (json{ { "mode", "basic" } })));
    EXPECT_TRUE (std::holds_alternative<OAuth2Auth> (
    parse_auth (json{ { "mode", "oauth2" }, { "config", json::object () } })));

    auto ak = parse_auth (
    json{ { "mode", "apikey" }, { "key", "k" }, { "value", "v" }, { "in", "query" } });
    ASSERT_TRUE (std::holds_alternative<ApiKeyAuth> (ak));
    EXPECT_TRUE (std::get<ApiKeyAuth> (ak).in_query);

    auto un = parse_auth (json{ { "mode", "ntlm" } });
    ASSERT_TRUE (std::holds_alternative<UnsupportedAuth> (un));
    EXPECT_EQ (std::get<UnsupportedAuth> (un).mode, "ntlm");
}

} // namespace
