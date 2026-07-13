/**
 * @file tests/request_builder_test.cpp
 * @brief Tests for the shared build_request pipeline and config snapshot sanitizer.
 */

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include "vayu/http/request_builder.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace {

TEST (RequestBuilder, BuildsValidRequestAndAppliesTimeoutAndAuth) {
    const json cfg = { { "method", "GET" },
        { "url", "https://api.example.com/v1" },
        { "auth", { { "mode", "bearer" }, { "token", "abc" } } } };
    auto b = vayu::http::build_request (cfg, nullptr, 12345);
    ASSERT_TRUE (b.ok);
    EXPECT_FALSE (b.parse_failed);
    EXPECT_EQ (b.request.timeout_ms, 12345);
    EXPECT_EQ (b.request.headers.at ("Authorization"), "Bearer abc");
}

TEST (RequestBuilder, ParseFailureIsFlagged) {
    const json cfg = { { "method", "GET" } }; // missing url
    auto b         = vayu::http::build_request (cfg, nullptr, 1000);
    EXPECT_FALSE (b.ok);
    EXPECT_TRUE (b.parse_failed);
    EXPECT_FALSE (b.error_message.empty ());
}

TEST (RequestBuilder, NoAuthLeavesHeadersEmpty) {
    const json cfg = { { "method", "POST" }, { "url", "https://api.example.com" } };
    auto b         = vayu::http::build_request (cfg, nullptr, 1000);
    ASSERT_TRUE (b.ok);
    EXPECT_TRUE (b.request.headers.empty ());
}

TEST (SanitizeConfigSnapshot, ReducesAuthToModeOnly) {
    const std::string body =
    R"({"method":"GET","url":"https://x/y","auth":{"mode":"basic","username":"u","password":"secret"}})";
    const auto out = vayu::json::sanitize_config_snapshot (body);
    const auto parsed = json::parse (out);
    EXPECT_EQ (parsed["url"], "https://x/y");
    EXPECT_EQ (parsed["auth"], (json{ { "mode", "basic" } }));
    EXPECT_FALSE (parsed["auth"].contains ("password"));
    EXPECT_FALSE (parsed["auth"].contains ("username"));
}

TEST (SanitizeConfigSnapshot, DropsUnknownFutureSecretFields) {
    // Even fields the engine has never heard of must not survive.
    const std::string body =
    R"({"url":"https://x","auth":{"mode":"oauth2","clientSecret":"s","privateKey":"pk","assertion":"a"}})";
    const auto parsed = json::parse (vayu::json::sanitize_config_snapshot (body));
    EXPECT_EQ (parsed["auth"], (json{ { "mode", "oauth2" } }));
}

TEST (SanitizeConfigSnapshot, NonJsonPassesThrough) {
    EXPECT_EQ (vayu::json::sanitize_config_snapshot ("not json"), "not json");
}

TEST (SanitizeConfigSnapshot, MissingAuthLeavesBodyIntact) {
    const std::string body = R"({"method":"GET","url":"https://x"})";
    const auto parsed = json::parse (vayu::json::sanitize_config_snapshot (body));
    EXPECT_EQ (parsed["method"], "GET");
    EXPECT_FALSE (parsed.contains ("auth"));
}

} // namespace
