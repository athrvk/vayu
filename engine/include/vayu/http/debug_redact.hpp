#pragma once

// Redaction for curl verbose/debug header dumps. The debug callbacks log each
// outgoing/incoming header line ("> Name: value" / "< Name: value"); without
// this, a verbose run would print Authorization (bearer/basic/oauth2 tokens),
// cookies, etc. to the debug log. Values of well-known sensitive headers are
// replaced with "<redacted>". Request/response bodies are never logged by the
// callbacks, so token POST bodies and token responses are unaffected.

#include <algorithm>
#include <array>
#include <cctype>
#include <string>
#include <string_view>

namespace vayu::http::detail {

/**
 * @brief Redact the value of a sensitive header line, leaving the name intact.
 *
 * @param line A single header line, e.g. "Authorization: Bearer abc". Any
 *             leading curl prefix ("> " / "< ") should NOT be included.
 * @return The line unchanged, or "<Name>: <redacted>" when the header is
 *         sensitive (matched case-insensitively).
 */
inline std::string redact_header_line (const std::string& line) {
    static constexpr std::array<std::string_view, 7> kSensitive = {
        "authorization",  "proxy-authorization",  "cookie",
        "set-cookie",     "www-authenticate",     "proxy-authenticate",
        "authentication-info"
    };

    const auto colon = line.find (':');
    if (colon == std::string::npos) {
        return line;
    }

    // Extract and normalize the header name (trim + lowercase).
    std::string name = line.substr (0, colon);
    const auto first = name.find_first_not_of (" \t");
    const auto last  = name.find_last_not_of (" \t");
    if (first == std::string::npos) {
        return line;
    }
    name = name.substr (first, last - first + 1);
    std::transform (name.begin (), name.end (), name.begin (), [] (unsigned char c) {
        return static_cast<char> (std::tolower (c));
    });

    const bool sensitive =
    std::any_of (kSensitive.begin (), kSensitive.end (),
    [&name] (std::string_view s) { return name == s; });

    if (!sensitive) {
        return line;
    }
    return line.substr (0, colon) + ": <redacted>";
}

} // namespace vayu::http::detail
