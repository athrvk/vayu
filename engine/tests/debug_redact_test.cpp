/**
 * @file tests/debug_redact_test.cpp
 * @brief Tests for redacting sensitive header values in curl verbose logs.
 */

#include <gtest/gtest.h>

#include "vayu/http/debug_redact.hpp"

using vayu::http::detail::redact_header_line;

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
    EXPECT_EQ (redact_header_line ("Set-Cookie: session=abc; HttpOnly"),
    "Set-Cookie: <redacted>");
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
    EXPECT_EQ (redact_header_line ("  Authorization : Bearer x"),
    "  Authorization : <redacted>");
}
