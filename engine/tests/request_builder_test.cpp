/**
 * @file tests/request_builder_test.cpp
 * @brief Tests for the shared build_request pipeline and config snapshot sanitizer.
 */

#include <gtest/gtest.h>

#include <string>
#include <vector>

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
// automatically, since sanitize_config_snapshot touches only credentials and
// the body cap - nothing in the execution route needs to copy it there separately.
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

// ---------------------------------------------------------------------------
// Composed credentials (#1803): the payload arrives with every variable
// already resolved, so a typed credential header and a secret variable's value
// are in it as plain text.
// ---------------------------------------------------------------------------

json sanitized (const json& cfg, const std::vector<std::string>& secrets = {}) {
    return json::parse (
    vayu::json::sanitize_config_snapshot (cfg.dump (), kMaxBodyBytes, secrets));
}

TEST (SanitizeConfigSnapshot, WithholdsATypedAuthorizationHeaderAndKeepsItsName) {
    const json cfg = { { "method", "GET" }, { "url", "https://api.example.com/v1" },
        { "headers",
        { { "Authorization", "Bearer eyJ-live-token" },
        { "Content-Type", "application/json" } } } };
    const auto parsed = sanitized (cfg);
    EXPECT_EQ (parsed["headers"]["Authorization"], "<redacted>");
    EXPECT_EQ (parsed["headers"]["Content-Type"], "application/json");
    EXPECT_EQ (parsed["url"], "https://api.example.com/v1");
    EXPECT_EQ (parsed.dump ().find ("eyJ-live-token"), std::string::npos);
}

TEST (SanitizeConfigSnapshot, MatchesCredentialHeaderNamesCaseInsensitively) {
    const json cfg     = { { "url", "https://x" },
            { "headers",
            { { "set-cookie", "sid=abc123" }, { "X-API-KEY", "k-123456" }, { "cookie", "a=b" },
            { "proxy-authorization", "Basic dTpw" }, { "X-Request-Source", "ui" } } } };
    const auto headers = sanitized (cfg)["headers"];
    EXPECT_EQ (headers["set-cookie"], "<redacted>");
    EXPECT_EQ (headers["X-API-KEY"], "<redacted>");
    EXPECT_EQ (headers["cookie"], "<redacted>");
    EXPECT_EQ (headers["proxy-authorization"], "<redacted>");
    EXPECT_EQ (headers["X-Request-Source"], "ui");
}

// No static list knows the header an API-key auth names, so the auth node is
// read for it before it is collapsed to its mode.
TEST (SanitizeConfigSnapshot, WithholdsTheHeaderAnApiKeyAuthNames) {
    const json cfg    = { { "url", "https://x" },
           { "headers", { { "x-tenant-key", "tenant-secret-9" }, { "X-Tenant", "acme" } } },
           { "auth",
           { { "mode", "apikey" }, { "key", "X-Tenant-Key" },
           { "value", "tenant-secret-9" }, { "in", "header" } } } };
    const auto parsed = sanitized (cfg);
    EXPECT_EQ (parsed["headers"]["x-tenant-key"], "<redacted>");
    EXPECT_EQ (parsed["headers"]["X-Tenant"], "acme");
    EXPECT_EQ (parsed["auth"], (json{ { "mode", "apikey" } }));
}

TEST (SanitizeConfigSnapshot, MasksASecretValueWhereverItWasResolved) {
    const std::string secret = "s3cr3t-value";
    const json cfg           = { { "method", "POST" },
                  { "url", "https://api.example.com/items?key=" + secret + "&page=2" },
                  { "params",
                  json::array ({ { { "key", "key" }, { "value", secret }, { "enabled", true } },
                  { { "key", "page" }, { "value", "2" }, { "enabled", true } } }) },
                  { "headers", { { "X-Trace", "trace-" + secret }, { "Accept", "*/*" } } },
                  { "body",
                  { { "mode", "json" }, { "content", R"({"password":")" + secret + R"(","n":1})" },
                  { "fields",
                  json::array ({ { { "key", "token" }, { "value", secret } },
                  { { "key", "name" }, { "value", "bob" } } }) } } } };
    const auto parsed        = sanitized (cfg, { secret });

    EXPECT_EQ (parsed.dump ().find (secret), std::string::npos) << parsed.dump (2);
    EXPECT_EQ (parsed["url"], "https://api.example.com/items?key=<redacted>&page=2");
    EXPECT_EQ (parsed["params"][0]["value"], "<redacted>");
    EXPECT_EQ (parsed["params"][1]["value"], "2");
    EXPECT_EQ (parsed["headers"]["X-Trace"], "trace-<redacted>");
    EXPECT_EQ (parsed["headers"]["Accept"], "*/*");
    EXPECT_EQ (parsed["body"]["content"], R"({"password":"<redacted>","n":1})");
    EXPECT_EQ (parsed["body"]["fields"][0]["value"], "<redacted>");
    EXPECT_EQ (parsed["body"]["fields"][1]["value"], "bob");
    // A field *name* is not a value; only the shared header rule reads names.
    EXPECT_EQ (parsed["body"]["fields"][0]["key"], "token");
}

// A value with characters a URL must escape lands there encoded, so the raw
// text alone would miss it.
TEST (SanitizeConfigSnapshot, MasksTheSecretsPercentEncodedForms) {
    const std::string secret = "p@ss word/1";
    const json cfg = { { "url", "https://x/a?u=p%40ss%20word%2F1&q=p@ss%20word/1&r=keep" } };
    const auto parsed = sanitized (cfg, { secret });
    EXPECT_EQ (parsed["url"], "https://x/a?u=<redacted>&q=<redacted>&r=keep");
}

// The guard against shredding a snapshot: "dev" would match half the URLs a
// workspace holds.
TEST (SanitizeConfigSnapshot, LeavesASecretShorterThanFourCharactersAlone) {
    const json cfg    = { { "url", "https://dev.example.com/dev" } };
    const auto parsed = sanitized (cfg, { "dev" });
    EXPECT_EQ (parsed["url"], "https://dev.example.com/dev");
}

TEST (SanitizeConfigSnapshot, MasksALongerSecretWholeWhenItContainsAShorterOne) {
    const json cfg = { { "url", "https://x/?a=token-abcd-extra&b=token-abcd" } };
    const auto parsed = sanitized (cfg, { "token-abcd", "token-abcd-extra" });
    EXPECT_EQ (parsed["url"], "https://x/?a=<redacted>&b=<redacted>");
}

// The body cap runs after masking, or a secret straddling the cut would leave
// its unrecognisable prefix behind.
TEST (SanitizeConfigSnapshot, MasksBeforeTheBodyCapCanSplitASecret) {
    const std::string secret  = "straddling-secret";
    const std::string content = std::string (kMaxBodyBytes - 5, 'x') + secret;
    const json cfg            = { { "url", "https://x" },
                   { "body", { { "mode", "text" }, { "content", content } } } };
    const auto parsed         = sanitized (cfg, { secret });
    const auto stored         = parsed["body"]["content"].get<std::string> ();
    EXPECT_EQ (stored.find ("strad"), std::string::npos);
    EXPECT_EQ (stored.substr (kMaxBodyBytes - 5), "<reda");
}

} // namespace
