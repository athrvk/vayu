#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Redaction for curl verbose/debug header dumps. The debug callbacks log each
// outgoing/incoming header line ("> Name: value" / "< Name: value"); without
// this, a verbose run would print Authorization (bearer/basic/oauth2 tokens),
// cookies, etc. to the debug log. Values of well-known sensitive headers are
// replaced with "<redacted>". Request/response bodies are never logged by the
// callbacks, so token POST bodies and token responses are unaffected.

#include <algorithm>
#include <array>
#include <string>
#include <string_view>
#include <vector>

#include <curl/curl.h>

#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/log_redact.hpp"

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
        "authorization", "proxy-authorization", "cookie", "set-cookie",
        "www-authenticate", "proxy-authenticate", "authentication-info"
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
    name = vayu::utils::ascii_lower (name.substr (first, last - first + 1));

    const bool sensitive = std::any_of (kSensitive.begin (), kSensitive.end (),
    [&name] (std::string_view s) { return name == s; });

    if (!sensitive) {
        return line;
    }
    return line.substr (0, colon) + ": <redacted>";
}

/**
 * @brief One `TransferDebug` collector, shared by `client.cpp`'s synchronous
 *        driver and the event-loop's `curl_callbacks.cpp` (issue #1557).
 *
 * A curl `CURLOPT_DEBUGFUNCTION` frame is not one physical line: the outgoing
 * header block, in particular, arrives as the request line and every header
 * in a single call, `\r\n`-joined. `collect_debug_frame` splits it so each
 * element of the eventual `cat=client` record's `lines[]` is one physical
 * line, and redacts each: the first line of a header frame is the request or
 * status line, which never carries a header name to match against
 * `redact_header_line` but can carry a secret in its query string
 * (`vayu::utils::strip_url_secrets`); every line after it is a header, through
 * `redact_header_line` as today.
 */
inline void collect_debug_frame (std::vector<std::string>& lines,
curl_infotype type,
std::string_view raw_text) {
    char prefix = '\0';
    switch (type) {
    case CURLINFO_TEXT: prefix = '*'; break;
    case CURLINFO_HEADER_OUT: prefix = '>'; break;
    case CURLINFO_HEADER_IN: prefix = '<'; break;
    default:
        return; // CURLINFO_DATA_* and CURLINFO_SSL_DATA_* are never logged.
    }

    std::size_t start   = 0;
    bool first_physical = true;
    while (start <= raw_text.size ()) {
        const auto nl        = raw_text.find ('\n', start);
        std::string_view one = raw_text.substr (start,
        nl == std::string_view::npos ? std::string_view::npos : nl - start);
        if (!one.empty () && one.back () == '\r') {
            one.remove_suffix (1);
        }
        if (!one.empty ()) {
            std::string processed = (type != CURLINFO_TEXT && first_physical) ?
            vayu::utils::strip_url_secrets (one) :
            redact_header_line (std::string (one));
            lines.push_back (std::string (1, prefix) + " " + processed);
        }
        first_physical = false;
        if (nl == std::string_view::npos) {
            break;
        }
        start = nl + 1;
    }
}

} // namespace vayu::http::detail
