/**
 * @file tests/debug_redact_test.cpp
 * @brief Tests for redacting sensitive header values in curl verbose logs.
 */

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include "vayu/core/vayu_extensions.hpp"
#include "vayu/http/debug_redact.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/log_redact.hpp"

using vayu::core::vayu_ext::blank_credential_param_rows;
using vayu::core::vayu_ext::redact_url_credentials;
using vayu::http::detail::collect_debug_frame;
using vayu::http::detail::redact_header_line;
using vayu::utils::is_secret_field_name;
using vayu::utils::strip_url_secrets;
using vayu::utils::strip_urls_in_text;

namespace {

// Shared with the app's `log-redaction.conformance.test.ts` and
// `sensitive-headers.conformance.test.ts`: a case added to the fixture fails
// whichever side answers it differently.
nlohmann::json load_redaction_fixture () {
    const auto path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "tests" /
    "fixtures" / "log-redaction-conformance.json";
    std::ifstream in (path);
    if (!in.good ()) {
        ADD_FAILURE () << "fixture missing: " << path;
        return nlohmann::json::object ();
    }
    return nlohmann::json::parse (in);
}

} // namespace

TEST (LogRedactionConformance, SecretFieldNamesAndStripUrlSecretsFollowTheSharedFixture) {
    const auto fixture = load_redaction_fixture ();
    ASSERT_FALSE (fixture.at ("secretFieldNames").empty ());
    ASSERT_FALSE (fixture.at ("stripUrlSecrets").empty ());
    ASSERT_FALSE (fixture.at ("sensitiveHeaderNames").empty ());
    for (const auto& name : fixture.at ("sensitiveHeaderNames")) {
        EXPECT_TRUE (is_secret_field_name (name.get<std::string> ())) << name;
    }
    for (const auto& name : fixture.at ("secretFieldNames")) {
        EXPECT_TRUE (is_secret_field_name (name.get<std::string> ())) << name;
    }
    for (const auto& name : fixture.at ("notSecretFieldNames")) {
        EXPECT_FALSE (is_secret_field_name (name.get<std::string> ())) << name;
    }
    for (const auto& c : fixture.at ("stripUrlSecrets")) {
        EXPECT_EQ (strip_url_secrets (c.at ("in").get<std::string> ()),
        c.at ("out").get<std::string> ())
        << c.at ("name");
    }
}

namespace {

/// Whether a Params row and a URL query parameter, both named @p name and
/// carrying a real value, are blanked: each answer, so a disagreement between
/// the two paths is reported on its own.
struct ParamBlanking {
    bool row = false;
    bool url = false;
};

ParamBlanking param_blanking (const std::string& name) {
    vayu::core::vayu_ext::Json rows = vayu::core::vayu_ext::Json::array (
    { { { "key", name }, { "value", "S3cret" }, { "enabled", true } } });
    int in_rows = 0;
    blank_credential_param_rows (rows, {}, in_rows);
    int in_url = 0;
    const std::string url =
    redact_url_credentials ("https://h/p?" + name + "=S3cret&page=2", {}, in_url);
    return { rows.at (0).at ("value").get<std::string> ().empty () && in_rows == 1,
        url == "https://h/p?" + name + "=&page=2" && in_url == 1 };
}

} // namespace

// `sensitiveParamNames` is what the MCP server's `SENSITIVE_PARAM_NAMES`
// (app/electron/mcp/withhold.ts, #1837) must equal; the app suite pins the
// equality, this pins that each name is one the engine blanks.
TEST (LogRedactionConformance, SensitiveParamNamesAreTheNamesTheEngineBlanks) {
    const auto fixture = load_redaction_fixture ();
    ASSERT_FALSE (fixture.at ("sensitiveParamNames").empty ());
    for (const auto& entry : fixture.at ("sensitiveParamNames")) {
        const auto name = entry.get<std::string> ();
        for (const std::string& spelled : { name, vayu::utils::ascii_upper (name) }) {
            const auto blanking = param_blanking (spelled);
            EXPECT_TRUE (blanking.row) << spelled << " as a Params row";
            EXPECT_TRUE (blanking.url) << spelled << " as a query parameter";
        }
    }
}

TEST (LogRedactionConformance, ParamNamesOutsideTheSetAreData) {
    // `code` is in the shared field set and `key` is a cache or sort key: the
    // two a reader most expects to find on the list.
    for (const std::string name : { "code", "key", "page", "sort" }) {
        const auto blanking = param_blanking (name);
        EXPECT_FALSE (blanking.row) << name << " as a Params row";
        EXPECT_FALSE (blanking.url) << name << " as a query parameter";
    }
    const auto fixture = load_redaction_fixture ();
    for (const auto& entry : fixture.at ("sensitiveParamNames")) {
        EXPECT_FALSE (param_blanking (entry.get<std::string> () + "_x").row) << entry;
    }
}

TEST (DebugRedact, RedactsTheHeaderTheRequestsApiKeyAuthNames) {
    EXPECT_EQ (redact_header_line ("X-Tenant-Key: abc"), "X-Tenant-Key: abc");
    EXPECT_EQ (redact_header_line ("x-tenant-key: abc", { "X-Tenant-Key" }),
    "x-tenant-key: <redacted>");
    EXPECT_EQ (redact_header_line ("X-API-Key: abc"), "X-API-Key: <redacted>");
}

TEST (StripUrlsInText, ScrubsEveryUrlInCurlProse) {
    EXPECT_EQ (strip_urls_in_text (
               "Issue another request to this URL: 'https://u:p@h/x?k=SECRET'"),
    "Issue another request to this URL: 'https://h/x'");
    EXPECT_EQ (strip_urls_in_text ("Connected to h (1.2.3.4) port 443"),
    "Connected to h (1.2.3.4) port 443");
    EXPECT_EQ (strip_urls_in_text ("a http://u:p@h/x?k=1 b https://v/y?z=2"),
    "a http://h/x b https://v/y");
}

TEST (DebugRedact, RedactsAuthorizationValue) {
    EXPECT_EQ (redact_header_line ("Authorization: Bearer secret-token"),
    "Authorization: <redacted>");
    EXPECT_EQ (redact_header_line ("Authorization: Basic dXNlcjpwYXNz"),
    "Authorization: <redacted>");
}

TEST (DebugRedact, CaseInsensitiveHeaderName) {
    EXPECT_EQ (redact_header_line ("authorization: Bearer x"), "authorization: <redacted>");
    EXPECT_EQ (redact_header_line ("AUTHORIZATION: Bearer x"), "AUTHORIZATION: <redacted>");
}

TEST (DebugRedact, RedactsCookiesAndProxyAuth) {
    EXPECT_EQ (redact_header_line ("Cookie: session=abc"), "Cookie: <redacted>");
    EXPECT_EQ (redact_header_line ("Set-Cookie: session=abc; HttpOnly"), "Set-Cookie: <redacted>");
    EXPECT_EQ (redact_header_line ("Proxy-Authorization: Basic y"),
    "Proxy-Authorization: <redacted>");
    EXPECT_EQ (redact_header_line ("WWW-Authenticate: Bearer realm=x"),
    "WWW-Authenticate: <redacted>");
}

TEST (DebugRedact, LeavesNonSensitiveHeadersIntact) {
    EXPECT_EQ (redact_header_line ("Content-Type: application/json"),
    "Content-Type: application/json");
    EXPECT_EQ (redact_header_line ("GET /path HTTP/1.1"), "GET /path HTTP/1.1");
    EXPECT_EQ (redact_header_line ("Host: api.example.com"), "Host: api.example.com");
}

TEST (DebugRedact, HandlesNoColonAndEmpty) {
    EXPECT_EQ (redact_header_line (""), "");
    EXPECT_EQ (redact_header_line ("some curl status text"), "some curl status text");
    EXPECT_EQ (redact_header_line (":"), ":"); // empty name, no match
}

TEST (DebugRedact, ToleratesWhitespaceAroundName) {
    // Defensive: some emitters pad the name. The value is still redacted.
    EXPECT_EQ (redact_header_line ("  Authorization : Bearer x"), "  Authorization : <redacted>");
}

// ---------------------------------------------------------------------------
// strip_url_secrets (issue #1557): userinfo and query removed, path kept.
// ---------------------------------------------------------------------------

TEST (StripUrlSecrets, RemovesUserinfoAndQueryFromAFullUrl) {
    EXPECT_EQ (strip_url_secrets ("https://u:p@host/path?api_key=SECRET"), "https://host/path");
}

TEST (StripUrlSecrets, RemovesJustTheQueryFromABarePath) {
    // The shape a curl request line carries: no scheme or host, just
    // "/path?query" - what `collect_debug_frame` hands it for the first line
    // of a HEADER_OUT frame.
    EXPECT_EQ (strip_url_secrets ("/p?api_key=SECRET"), "/p");
}

TEST (StripUrlSecrets, LeavesAUrlWithNeitherUnchanged) {
    EXPECT_EQ (strip_url_secrets ("https://host/path"), "https://host/path");
    EXPECT_EQ (strip_url_secrets ("/path"), "/path");
}

// ---------------------------------------------------------------------------
// collect_debug_frame (issue #1557): a multi-line curl debug frame becomes
// one redacted physical line per element of the eventual `lines[]` field.
// ---------------------------------------------------------------------------

TEST (CollectDebugFrame, SplitsAHeaderOutBlockAndStripsTheRequestLineQuery) {
    std::vector<std::string> lines;
    // The trailing blank line (the header block's own terminator) carries no
    // information and is dropped, not pushed as an empty fourth element.
    collect_debug_frame (lines,
    CURLINFO_HEADER_OUT, "GET /p?api_key=SECRET HTTP/1.1\r\nHost: h\r\nAuthorization: Bearer TOK\r\n\r\n");

    ASSERT_EQ (lines.size (), 3u);
    EXPECT_EQ (lines[0], "> GET /p HTTP/1.1");
    EXPECT_EQ (lines[1], "> Host: h");
    EXPECT_EQ (lines[2], "> Authorization: <redacted>");
    for (const auto& line : lines) {
        EXPECT_EQ (line.find ("SECRET"), std::string::npos) << line;
        EXPECT_EQ (line.find ("TOK"), std::string::npos) << line;
    }
}

TEST (CollectDebugFrame, PrefixesEachKindDifferently) {
    std::vector<std::string> lines;
    collect_debug_frame (lines, CURLINFO_TEXT, "Connected to host port 443");
    collect_debug_frame (lines, CURLINFO_HEADER_IN, "HTTP/1.1 200 OK\r\nSet-Cookie: s=1\r\n");

    ASSERT_EQ (lines.size (), 3u);
    EXPECT_EQ (lines[0], "* Connected to host port 443");
    EXPECT_EQ (lines[1], "< HTTP/1.1 200 OK");
    EXPECT_EQ (lines[2], "< Set-Cookie: <redacted>");
}

TEST (CollectDebugFrame, IgnoresDataFrames) {
    std::vector<std::string> lines;
    collect_debug_frame (lines, CURLINFO_DATA_OUT, "field=value&secret=1");
    EXPECT_TRUE (lines.empty ())
    << "a request or response body must never be collected into the log";
}

TEST (CollectDebugFrame, ScrubsAUrlQuotedInCurlText) {
    std::vector<std::string> lines;
    collect_debug_frame (lines, CURLINFO_TEXT,
    "Issue another request to this URL: 'https://h/next?token=SECRET'");
    ASSERT_EQ (lines.size (), 1u);
    EXPECT_EQ (lines[0], "* Issue another request to this URL: 'https://h/next'");
}

TEST (CollectDebugFrame, RedactsTheApiKeyHeaderOfTheRequest) {
    std::vector<std::string> lines;
    collect_debug_frame (lines, CURLINFO_HEADER_OUT,
    "GET /p HTTP/1.1\r\nX-Tenant-Key: KEYVALUE\r\n\r\n", { "X-Tenant-Key" });
    ASSERT_EQ (lines.size (), 2u);
    EXPECT_EQ (lines[1], "> X-Tenant-Key: <redacted>");
}
