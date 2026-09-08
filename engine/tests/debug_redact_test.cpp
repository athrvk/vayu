/**
 * @file tests/debug_redact_test.cpp
 * @brief Tests for redacting sensitive header values in curl verbose logs.
 */

#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "vayu/http/debug_redact.hpp"
#include "vayu/utils/log_redact.hpp"

using vayu::http::detail::collect_debug_frame;
using vayu::http::detail::redact_header_line;
using vayu::utils::strip_url_secrets;

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
