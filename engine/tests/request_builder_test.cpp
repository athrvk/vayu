/**
 * @file tests/request_builder_test.cpp
 * @brief Tests for the shared build_request pipeline and config snapshot sanitizer.
 */

#include <gtest/gtest.h>

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/core/constants.hpp"
#include "vayu/core/url_encoding.hpp"
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

// Composition writes a URL through `encode_url_as_postman`, whose path,
// user info and fragment sets leave `/ @ & : + '` raw where the strict and
// query spellings write them `%XX`. A secret holding a space and one of those
// lands in the URL in a spelling only the component's own encoder writes.
struct UrlSecretCase {
    const char* name;
    std::string before;
    std::string secret;
    std::string after;
    /// What composition writes for the secret there.
    std::string composed;
};

class SanitizeUrlComponentSecret : public ::testing::TestWithParam<UrlSecretCase> {};

TEST_P (SanitizeUrlComponentSecret, MasksTheSecretAsThatComponentWritesIt) {
    const auto& c = GetParam ();
    const std::string url =
    vayu::core::encode_url_as_postman (c.before + c.secret + c.after);
    // The input is what composition writes, and it is not the raw secret.
    ASSERT_EQ (url, c.before + c.composed + c.after);
    ASSERT_NE (c.composed, c.secret);

    const auto parsed = sanitized ({ { "url", url } }, { c.secret });
    EXPECT_EQ (parsed["url"], c.before + "<redacted>" + c.after);
}

// Each case is spelled by one component's encoder alone: a brace is `%7B` in a
// path and user info but raw in a fragment, `@` and `&` are raw in a path and
// a fragment (a query value writes `&` as `%26`), `@` is `%40` in user info
// but `&` stays raw there (the strict spelling writes both `%XX`), and a colon is raw in a user name, in a path
// and in a fragment but `%3A` after the user's own colon. Drop any one form
// from `masked_secret_forms` and its case reds.
INSTANTIATE_TEST_SUITE_P (Components,
SanitizeUrlComponentSecret,
::testing::Values (UrlSecretCase{ "PathSpaceAndSlash",
                   "https://api.example.com/v1/", "a b/c", "/items", "a%20b/c" },
UrlSecretCase{ "PathBraceAndAt", "https://api.example.com/v1/", "a b{c@d", "/items", "a%20b%7Bc@d" },
UrlSecretCase{ "UserInfoAtAndAmpersand", "https://", "p@ss w&rd", "@api.example.com/", "p%40ss%20w&rd" },
UrlSecretCase{ "UserNameWithAColon", "https://", "a b:c@d&e", "@api.example.com/", "a%20b:c%40d&e" },
UrlSecretCase{ "PasswordWithAColon", "https://admin:", "a b:c@d&e",
"@api.example.com/", "a%20b%3Ac%40d&e" },
UrlSecretCase{ "FragmentSpaceAndSlash", "https://api.example.com/v1#", "a b/c", "", "a%20b/c" },
UrlSecretCase{ "FragmentBraceAndAmpersand", "https://api.example.com/v1#",
"a b{c@d&e", "", "a%20b{c@d&e" }),
[] (const ::testing::TestParamInfo<UrlSecretCase>& info) {
    return info.param.name;
});

// A URL-safe secret is written the same everywhere, so the one raw spelling
// still masks it.
TEST (SanitizeConfigSnapshot, MasksAUrlSafeSecretInEveryUrlComponent) {
    const std::string secret = "s3cr3t-value";
    const json cfg           = { { "url",
    "https://" + secret + "@x/" + secret + "?q=" + secret + "#" + secret } };
    EXPECT_EQ (sanitized (cfg, { secret })["url"],
    "https://<redacted>@x/<redacted>?q=<redacted>#<redacted>");
}

// A JSON body is stored as text, so a secret holding `"` or `\` sits in it in
// its JSON-escaped form and the raw text alone would miss it.
TEST (SanitizeConfigSnapshot, MasksTheSecretsJsonEscapedForm) {
    const std::string secret  = R"(pa"ss\word-12345)";
    const std::string content = R"({"t": "pa\"ss\\word-12345", "n": 1})";
    const json cfg            = { { "url", "https://x" },
        { "body", { { "mode", "json" }, { "content", content } } } };
    const auto parsed         = sanitized (cfg, { secret });
    EXPECT_EQ (parsed["body"]["content"], R"({"t": "<redacted>", "n": 1})");
    EXPECT_EQ (parsed.dump ().find ("word-12345"), std::string::npos) << parsed.dump (2);
}

// A control character a JSON writer must escape is covered by the same form.
TEST (SanitizeConfigSnapshot, MasksAJsonEscapedSecretHoldingControlCharacters) {
    const std::string secret = "line1\nline2\ttab";
    const json cfg           = { { "url", "https://x" },
        { "body", { { "mode", "json" }, { "content", R"({"t":"line1\nline2\ttab"})" } } } };
    EXPECT_EQ (sanitized (cfg, { secret })["body"]["content"], R"({"t":"<redacted>"})");
}

// An XML body escapes `&`, `<` and `>` in character data, and the delimiter in
// an attribute.
TEST (SanitizeConfigSnapshot, MasksTheSecretsXmlEscapedForms) {
    const std::string secret = R"(a&b<c>"d'e-12345)";
    const json cfg           = { { "url", "https://x" },
        { "body",
        { { "mode", "xml" },
        { "content",
        "<p k=\"a&amp;b&lt;c&gt;&quot;d'e-12345\" "
        "j='a&amp;b&lt;c&gt;\"d&apos;e-12345'>"
        "a&amp;b&lt;c&gt;\"d'e-12345</p>" } } } };
    EXPECT_EQ (sanitized (cfg, { secret })["body"]["content"],
    "<p k=\"<redacted>\" j='<redacted>'><redacted></p>");
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
