/**
 * @file tests/auth_resolver_test.cpp
 * @brief Tests for apply_auth (static auth modes).
 */

#include <gtest/gtest.h>

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
    EXPECT_EQ (req.headers.at ("authorization"), "Bearer user-typed");
    EXPECT_EQ (req.headers.count ("Authorization"), 0u);
}

TEST (AuthResolver, Oauth2IsNoOpForNow) {
    auto req = make_request ();
    auto result = vayu::http::apply_auth (
    req, json{ { "mode", "oauth2" }, { "config", json::object () } }, nullptr);
    EXPECT_TRUE (result.ok);
    EXPECT_TRUE (req.headers.empty ());
}

} // namespace
