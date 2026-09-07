/**
 * @file tests/request_builder_test.cpp
 * @brief Tests for the shared build_request pipeline and config snapshot sanitizer.
 */

#include <gtest/gtest.h>

#include <nlohmann/json.hpp>

#include "vayu/core/constants.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/utils/json.hpp"

using nlohmann::json;

namespace {

constexpr size_t kMaxBodyBytes = vayu::core::constants::json::MAX_TRACE_BODY_BYTES;

TEST (RequestBuilder, BuildsValidRequestAndAppliesTimeoutAndAuth) {
    const json cfg = { { "method", "GET" }, { "url", "https://api.example.com/v1" },
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
    auto b = vayu::http::build_request (cfg, nullptr, 1000);
    ASSERT_TRUE (b.ok);
    EXPECT_TRUE (b.request.headers.empty ());
}

TEST (SanitizeConfigSnapshot, ReducesAuthToModeOnly) {
    const std::string body =
    R"({"method":"GET","url":"https://x/y","auth":{"mode":"basic","username":"u","password":"secret"}})";
    const auto out = vayu::json::sanitize_config_snapshot (body, kMaxBodyBytes);
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
    const auto parsed =
    json::parse (vayu::json::sanitize_config_snapshot (body, kMaxBodyBytes));
    EXPECT_EQ (parsed["auth"], (json{ { "mode", "oauth2" } }));
}

TEST (SanitizeConfigSnapshot, NonJsonPassesThrough) {
    EXPECT_EQ (vayu::json::sanitize_config_snapshot ("not json", kMaxBodyBytes), "not json");
}

TEST (SanitizeConfigSnapshot, MissingAuthLeavesBodyIntact) {
    const std::string body = R"({"method":"GET","url":"https://x"})";
    const auto parsed =
    json::parse (vayu::json::sanitize_config_snapshot (body, kMaxBodyBytes));
    EXPECT_EQ (parsed["method"], "GET");
    EXPECT_FALSE (parsed.contains ("auth"));
}

// Task 6: a POST /runs per-run httpVersion override rides into config_snapshot
// automatically, since sanitize_config_snapshot only touches the auth
// subtree - nothing in the execution route needs to copy it there separately.
TEST (SanitizeConfigSnapshot, PreservesPerRunHttpVersionOverride) {
    const std::string body = R"({"method":"GET","url":"https://x","httpVersion":"http1.1"})";
    const auto parsed =
    json::parse (vayu::json::sanitize_config_snapshot (body, kMaxBodyBytes));
    EXPECT_EQ (parsed["httpVersion"], "http1.1");
}

TEST (SanitizeConfigSnapshot, CapsOversizedBodyContentAndMarksIt) {
    const std::string oversized (kMaxBodyBytes + 10, 'x');
    const json cfg = { { "method", "POST" }, { "url", "https://x" },
        { "body", { { "mode", "raw" }, { "content", oversized } } } };
    const auto parsed =
    json::parse (vayu::json::sanitize_config_snapshot (cfg.dump (), kMaxBodyBytes));
    EXPECT_EQ (parsed["body"]["content"].get<std::string> ().size (), kMaxBodyBytes);
    EXPECT_TRUE (parsed["body"]["bodyTruncated"]);
    EXPECT_EQ (parsed["body"]["bodyBytes"], kMaxBodyBytes + 10);
}

TEST (SanitizeConfigSnapshot, LeavesBodyWithinCapUntouched) {
    const json cfg = { { "method", "POST" }, { "url", "https://x" },
        { "body", { { "mode", "raw" }, { "content", "small" } } } };
    const auto parsed =
    json::parse (vayu::json::sanitize_config_snapshot (cfg.dump (), kMaxBodyBytes));
    EXPECT_EQ (parsed["body"]["content"], "small");
    EXPECT_FALSE (parsed["body"].contains ("bodyTruncated"));
    EXPECT_FALSE (parsed["body"].contains ("bodyBytes"));
}

TEST (SanitizeConfigSnapshot, ANonScenarioBodyLeavesFieldsWithoutContentAlone) {
    // form-data / no-body payloads carry no `content` string; the cap must not
    // touch `fields` or crash on a body object it does not recognize.
    const json cfg = { { "method", "POST" }, { "url", "https://x" },
        { "body", { { "mode", "none" } } } };
    const auto parsed =
    json::parse (vayu::json::sanitize_config_snapshot (cfg.dump (), kMaxBodyBytes));
    EXPECT_EQ (parsed["body"]["mode"], "none");
    EXPECT_FALSE (parsed["body"].contains ("bodyTruncated"));
}

} // namespace
