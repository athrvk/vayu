#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::utils {

/**
 * @brief Base64-encode arbitrary bytes (RFC 4648, standard alphabet, padded).
 *
 * Used for HTTP Basic credentials and OAuth 2.0 client authentication
 * (RFC 6749 §2.3.1). The engine intentionally does not depend on cpp-httplib's
 * detail::base64 because vayu_core does not link httplib.
 */
inline std::string base64_encode (std::string_view in) {
    static constexpr char table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    std::string out;
    out.reserve (((in.size () + 2) / 3) * 4);

    size_t i = 0;
    while (i + 3 <= in.size ()) {
        const uint32_t n = (static_cast<uint8_t> (in[i]) << 16) |
        (static_cast<uint8_t> (in[i + 1]) << 8) |
        static_cast<uint8_t> (in[i + 2]);
        out.push_back (table[(n >> 18) & 0x3F]);
        out.push_back (table[(n >> 12) & 0x3F]);
        out.push_back (table[(n >> 6) & 0x3F]);
        out.push_back (table[n & 0x3F]);
        i += 3;
    }

    const size_t rem = in.size () - i;
    if (rem == 1) {
        const uint32_t n = static_cast<uint8_t> (in[i]) << 16;
        out.push_back (table[(n >> 18) & 0x3F]);
        out.push_back (table[(n >> 12) & 0x3F]);
        out.push_back ('=');
        out.push_back ('=');
    } else if (rem == 2) {
        const uint32_t n = (static_cast<uint8_t> (in[i]) << 16) |
        (static_cast<uint8_t> (in[i + 1]) << 8);
        out.push_back (table[(n >> 18) & 0x3F]);
        out.push_back (table[(n >> 12) & 0x3F]);
        out.push_back (table[(n >> 6) & 0x3F]);
        out.push_back ('=');
    }

    return out;
}

/**
 * @brief Base64url-encode bytes (RFC 4648 §5, URL-safe alphabet, no padding).
 *
 * Used for PKCE (RFC 7636): the code verifier and the SHA-256 code challenge
 * are both base64url without padding.
 */
inline std::string base64url_encode (std::string_view in) {
    std::string out = base64_encode (in);
    for (char& c : out) {
        if (c == '+')
            c = '-';
        else if (c == '/')
            c = '_';
    }
    while (!out.empty () && out.back () == '=') {
        out.pop_back ();
    }
    return out;
}

/**
 * @brief Percent-encode a string per RFC 3986 (unreserved set left intact).
 *
 * Unreserved characters (A-Z a-z 0-9 - _ . ~) pass through; everything else is
 * emitted as %XX with uppercase hex. Suitable for query components and
 * application/x-www-form-urlencoded values.
 */
inline std::string url_encode (std::string_view in) {
    static constexpr char hex[] = "0123456789ABCDEF";

    std::string out;
    out.reserve (in.size () * 3);

    for (const char ch : in) {
        const auto c = static_cast<uint8_t> (ch);
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' ||
            c == '~') {
            out.push_back (static_cast<char> (c));
        } else {
            out.push_back ('%');
            out.push_back (hex[c >> 4]);
            out.push_back (hex[c & 0x0F]);
        }
    }

    return out;
}

/**
 * @brief Decode an application/x-www-form-urlencoded token ('+' → space, %XX).
 *
 * The inverse of url_encode for a single component. A malformed escape (a '%'
 * not followed by two hex digits, including a truncated one at end-of-string)
 * is passed through literally rather than throwing — callers decode
 * attacker-influenced query strings and token bodies, so this must never abort.
 */
inline std::string url_decode (std::string_view in) {
    const auto unhex = [] (char c) -> int {
        if (c >= '0' && c <= '9')
            return c - '0';
        if (c >= 'a' && c <= 'f')
            return c - 'a' + 10;
        if (c >= 'A' && c <= 'F')
            return c - 'A' + 10;
        return -1;
    };

    std::string out;
    out.reserve (in.size ());
    for (size_t i = 0; i < in.size (); ++i) {
        const char ch = in[i];
        int hi = -1, lo = -1;
        if (ch == '+') {
            out.push_back (' ');
        } else if (ch == '%' && i + 2 < in.size () &&
        (hi = unhex (in[i + 1])) >= 0 && (lo = unhex (in[i + 2])) >= 0) {
            out.push_back (static_cast<char> ((hi << 4) | lo));
            i += 2;
        } else {
            out.push_back (ch);
        }
    }
    return out;
}

/**
 * @brief Encode key/value pairs as an application/x-www-form-urlencoded body.
 *
 * Keys and values are individually url_encode()d and joined with '&'. Order is
 * preserved so callers can produce deterministic bodies (useful for tests).
 */
inline std::string
form_encode (const std::vector<std::pair<std::string, std::string>>& fields) {
    std::string out;
    bool first = true;
    for (const auto& [key, value] : fields) {
        if (!first) {
            out.push_back ('&');
        }
        first = false;
        out += url_encode (key);
        out.push_back ('=');
        out += url_encode (value);
    }
    return out;
}

} // namespace vayu::utils
