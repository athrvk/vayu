#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/utils/sodium_init.hpp"

#include <sodium.h>

#include <algorithm>
#include <cstddef>
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

/// How many bytes the UTF-8 lead byte @p lead announces, or 0 when it cannot
/// start a sequence at all (a continuation byte, or 0xF8 and above).
constexpr std::size_t utf8_announced_length (unsigned char lead) {
    if (lead < 0x80) {
        return 1;
    }
    if ((lead & 0xE0) == 0xC0) {
        return 2;
    }
    if ((lead & 0xF0) == 0xE0) {
        return 3;
    }
    if ((lead & 0xF8) == 0xF0) {
        return 4;
    }
    return 0;
}

/// True when @p sequence, exactly as long as its lead byte announces, is
/// well-formed and minimally encoded for a scalar value UTF-8 may carry. The
/// overlong and surrogate checks are what separate this from a length-only
/// test: both are byte patterns a decoder must reject rather than pass through.
inline bool utf8_sequence_is_valid (std::string_view sequence) {
    const auto byte = [sequence] (std::size_t index) {
        return static_cast<std::uint32_t> (static_cast<unsigned char> (sequence[index]));
    };
    for (std::size_t i = 1; i < sequence.size (); ++i) {
        if ((byte (i) & 0xC0) != 0x80) {
            return false;
        }
    }
    switch (sequence.size ()) {
    case 1: return true;
    case 2: return byte (0) >= 0xC2; // C0/C1 encode 7-bit values overlong
    case 3: {
        const std::uint32_t code =
        ((byte (0) & 0x0F) << 12) | ((byte (1) & 0x3F) << 6) | (byte (2) & 0x3F);
        return code >= 0x800 && (code < 0xD800 || code > 0xDFFF);
    }
    case 4: {
        const std::uint32_t code = ((byte (0) & 0x07) << 18) |
        ((byte (1) & 0x3F) << 12) | ((byte (2) & 0x3F) << 6) | (byte (3) & 0x3F);
        return code >= 0x10000 && code <= 0x10FFFF;
    }
    default: return false;
    }
}

/// True when @p partial, a lead byte followed by fewer continuation bytes than
/// the @p announced length, can still be completed into a valid sequence. The
/// completions of a prefix span one range of scalar values, and the values
/// UTF-8 refuses (overlongs, surrogates, past U+10FFFF) are whole aligned
/// blocks, so the range's lowest or highest completion is valid when any is.
inline bool utf8_prefix_can_complete (std::string_view partial, std::size_t announced) {
    for (const int fill : { 0x80, 0xBF }) {
        std::string sequence (partial);
        sequence.resize (announced, static_cast<char> (fill));
        if (utf8_sequence_is_valid (sequence)) {
            return true;
        }
    }
    return false;
}

} // namespace detail

/**
 * @brief Length of the well-formed UTF-8 sequence that starts at @p at in
 *        @p text, or 0 when none does.
 *
 * Strict: an overlong form, a surrogate, a value past U+10FFFF and a sequence
 * cut short by the end of @p text are all 0. That is the set nlohmann's
 * serializer refuses with `type_error.316`, so a caller deciding whether bytes
 * can sit in a JSON string asks the same question the serializer will.
 */
inline std::size_t utf8_sequence_length (std::string_view text, std::size_t at) {
    const std::size_t length =
    detail::utf8_announced_length (static_cast<unsigned char> (text.at (at)));
    if (length == 0 || text.size () - at < length) {
        return 0;
    }
    return detail::utf8_sequence_is_valid (text.substr (at, length)) ? length : 0;
}

/**
 * @brief Whether @p bytes are text: valid UTF-8 over the whole of them, and no
 *        NUL.
 *
 * Whole, unlike `core::looks_binary`'s sniff of the first `SNIFF_BYTES`: the
 * answer decides whether a response body can travel as a JSON string at all
 * (issue #2458), and one bad byte past the sniff window is enough to make the
 * serializer throw. NUL is valid UTF-8 but never appears in text, so a body
 * carrying one is treated as the binary it almost certainly is. Empty is text.
 */
inline bool is_valid_utf8_text (std::string_view bytes) {
    std::size_t at = 0;
    while (at < bytes.size ()) {
        if (bytes[at] == '\0') {
            return false;
        }
        const std::size_t length = utf8_sequence_length (bytes, at);
        if (length == 0) {
            return false;
        }
        at += length;
    }
    return true;
}

/**
 * @brief @p bytes without the incomplete UTF-8 sequence a cut at a byte count
 *        can leave at their end, or @p bytes whole when they end on a
 *        character boundary.
 *
 * A body the read cap stopped (issue #2458) ends wherever the cap fell, which
 * can be inside a character: at most three bytes of a sequence whose lead
 * announces more. Those are dropped only when some continuation could still
 * make them valid, so a lead no character starts with, or a stray continuation
 * byte, stays where `is_valid_utf8_text` refuses it.
 */
inline std::string_view without_incomplete_utf8_tail (std::string_view bytes) {
    const std::size_t reach = std::min<std::size_t> (bytes.size (), 3);
    for (std::size_t cut = 1; cut <= reach; ++cut) {
        const std::size_t at = bytes.size () - cut;
        const auto byte      = static_cast<unsigned char> (bytes[at]);
        if ((byte & 0xC0) == 0x80) {
            continue;
        }
        const std::size_t announced = detail::utf8_announced_length (byte);
        const bool incomplete       = announced > cut &&
        detail::utf8_prefix_can_complete (bytes.substr (at), announced);
        return incomplete ? bytes.substr (0, at) : bytes;
    }
    return bytes;
}

/**
 * @brief Base64-encode arbitrary bytes (RFC 4648, standard alphabet, padded).
 *
 * Used for HTTP Basic credentials, OAuth 2.0 client authentication
 * (RFC 6749 §2.3.1), and a response body that is not text (issue #2458).
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
    static constexpr std::string_view ignore = " \t\n\r\f";

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
        // The data () below travels with in.size () one argument over, so the
        // callee never assumes a terminator - the suspicious-stringview-data
        // check cannot see that through the ternary, which only exists to keep
        // the pointer non-null for an empty input.
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
        if (sodium_base642bin (reinterpret_cast<unsigned char*> (out.data ()),
            out.size (),
            // NOLINTNEXTLINE(bugprone-suspicious-stringview-data-usage)
            in.empty () ? "" : in.data (), in.size (), ignore.data (),
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
    std::string out ((in.size () * 2) + 1, '\0');
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
    static constexpr std::string_view hex = "0123456789ABCDEF";

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
        if (ch == '+') {
            out.push_back (' ');
            continue;
        }
        if (ch == '%' && i + 2 < in.size ()) {
            const int hi = unhex (in[i + 1]);
            const int lo = unhex (in[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back (static_cast<char> ((hi << 4) | lo));
                i += 2;
                continue;
            }
        }
        out.push_back (ch);
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
