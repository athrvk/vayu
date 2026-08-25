#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/utils/sodium_init.hpp"

#include <sodium.h>

#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::utils {

/**
 * @brief Raw bytes as the `std::string_view` this file's encoders take.
 *
 * `sha256` and `hmac_sha256` answer with a `std::array<uint8_t, 32>`, and every
 * encoder here - plus `hmac_sha256` itself, when a digest is the key - reads a
 * `std::string_view`. Six call sites spelled that conversion themselves before
 * this existed, which is the shape the repo's "a hand-rolled copy of a
 * primitive does not receive the primitive's fixes" rule is about.
 *
 * The cast is the one reinterpretation the standard blesses outright:
 * [basic.lval] lets any object be read through a `char`, `unsigned char` or
 * `std::byte` lvalue, so viewing a byte array as characters is defined rather
 * than merely customary. That is why it is a NOLINT here and not a defect -
 * and why it is written once, so nothing has to argue it again.
 */
inline std::string_view byte_view (std::span<const std::uint8_t> bytes) {
    // [basic.lval] permits reading any object through a character type; see
    // the note above for why that makes this a NOLINT and not a defect.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    return { reinterpret_cast<const char*> (bytes.data ()), bytes.size () };
}

namespace detail {

/**
 * @brief Shared body of the two base64 encoders, parameterised by alphabet.
 *
 * sodium_base64_ENCODED_LEN is an upper bound that includes the terminating
 * NUL, and sodium_bin2base64 always NUL-terminates, so the written length is
 * read back rather than assumed - a variant whose bound is generous still
 * yields an exactly-sized string.
 *
 * The macro mixes its variant argument into unsigned arithmetic, so it is
 * handed an unsigned copy: passing the plain int constant warns under the
 * engine's -Wsign-conversion, which is an error on the MSVC (/W4 /WX) build.
 */
inline std::string sodium_base64_encode (std::string_view in, int variant) {
    ensure_sodium_initialized ();

    const auto variant_bits = static_cast<unsigned int> (variant);
    std::string out (sodium_base64_ENCODED_LEN (in.size (), variant_bits), '\0');
    sodium_bin2base64 (out.data (), out.size (), sodium_bytes (in), in.size (), variant);
    out.resize (std::strlen (out.c_str ()));
    return out;
}

} // namespace detail

/**
 * @brief Base64-encode arbitrary bytes (RFC 4648, standard alphabet, padded).
 *
 * Used for HTTP Basic credentials and OAuth 2.0 client authentication
 * (RFC 6749 §2.3.1).
 */
inline std::string base64_encode (std::string_view in) {
    return detail::sodium_base64_encode (in, sodium_base64_VARIANT_ORIGINAL);
}

/**
 * @brief Decode standard base64 (RFC 4648 §4), rejecting anything malformed.
 *
 * Returns std::nullopt rather than a best-effort decode: the script sandbox's
 * `atob` has to throw on bad input, and a caller that silently accepted a
 * truncated group would hand back bytes the author never encoded. ASCII
 * whitespace is skipped first (WHATWG `atob` forgives it, and wrapped base64
 * from a config file or a PEM-ish blob is common), so only non-whitespace
 * characters outside the alphabet, a '=' in a non-terminal position, or a
 * length that is not a multiple of 4 after padding are errors.
 */
inline std::optional<std::string> base64_decode (std::string_view in) {
    ensure_sodium_initialized ();

    // ASCII whitespace is skipped wherever it appears, so wrapped base64 (a
    // PEM-ish blob, a value pasted out of a config file) decodes.
    static constexpr char ignore[] = " \t\n\r\f";

    const auto attempt = [&in] (int variant) -> std::optional<std::string> {
        // Base64 never shrinks by less than a quarter, so the input length is
        // always a sufficient output bound; the +1 also keeps data() non-null
        // for empty input.
        std::string out (in.size () + 1, '\0');
        size_t decoded_len = 0;

        // A null b64_end makes libsodium reject input it did not consume in
        // full, so trailing junk after a valid prefix is an error rather than a
        // short decode. The cast is the writing direction of the [basic.lval]
        // rule `byte_view` above documents - libsodium fills a byte buffer, and
        // this string is one.
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
        if (sodium_base642bin (reinterpret_cast<unsigned char*> (out.data ()),
            out.size (), in.empty () ? "" : in.data (), in.size (), ignore,
            &decoded_len, nullptr, variant) != 0) {
            return std::nullopt;
        }

        out.resize (decoded_len);
        return out;
    };

    // VARIANT_ORIGINAL requires the '=' padding, but `atob` accepts an unpadded
    // tail, so a padded decode that fails is retried without it. The fallback
    // cannot launder a malformed group: '=' is outside the no-padding alphabet,
    // so anything carrying padding that ORIGINAL rejected fails the retry too.
    if (auto padded = attempt (sodium_base64_VARIANT_ORIGINAL)) {
        return padded;
    }
    return attempt (sodium_base64_VARIANT_ORIGINAL_NO_PADDING);
}

/**
 * @brief Lowercase hex of arbitrary bytes.
 *
 * The default digest encoding for the script sandbox's hashing surface, and the
 * one every webhook-signature scheme (Stripe, GitHub, Slack) compares against.
 */
inline std::string hex_encode (std::string_view in) {
    ensure_sodium_initialized ();

    // sodium_bin2hex needs room for the terminating NUL and aborts without it.
    std::string out (in.size () * 2 + 1, '\0');
    sodium_bin2hex (out.data (), out.size (), detail::sodium_bytes (in), in.size ());
    out.resize (in.size () * 2);
    return out;
}

/**
 * @brief Base64url-encode bytes (RFC 4648 §5, URL-safe alphabet, no padding).
 *
 * Used for PKCE (RFC 7636): the code verifier and the SHA-256 code challenge
 * are both base64url without padding.
 */
inline std::string base64url_encode (std::string_view in) {
    return detail::sodium_base64_encode (in, sodium_base64_VARIANT_URLSAFE_NO_PADDING);
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
        (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
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
 * is passed through literally rather than throwing - callers decode
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
inline std::string form_encode (
const std::vector<std::pair<std::string, std::string>>& fields) {
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
