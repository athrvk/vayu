#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

// SHA-256 and HMAC-SHA256. Thin wrappers over the vendored, MIT-licensed
// picosha2 single-header (engine/vendor/picosha2) so the engine neither
// hand-maintains a hash implementation nor links OpenSSL.
//
// Two callers with different threat models share these: PKCE code challenges
// (RFC 7636 S256), which hash a client-generated, non-secret verifier whose
// challenge is then transmitted in the clear; and the script sandbox's
// pm.crypto surface, where a user signs an outgoing request with their own
// secret. Neither is constant-time - these compute a signature to send, they do
// not compare an attacker-supplied one - so do not reach for them to verify a
// MAC without adding a constant-time comparison of your own.

#include <picosha2.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <string>
#include <string_view>

namespace vayu::utils {

/**
 * @brief SHA-256 digest (32 bytes) of the given bytes.
 *
 * picosha2 masks every input byte to 8 bits, so a signed-char range from a
 * std::string_view hashes the same bytes regardless of char signedness.
 */
inline std::array<uint8_t, 32> sha256 (std::string_view data) {
    std::array<uint8_t, 32> out{};
    picosha2::hash256 (data.begin (), data.end (), out.begin (), out.end ());
    return out;
}

/**
 * @brief HMAC-SHA256 (RFC 2104) of `data` under `key`.
 *
 * Keys longer than the 64-byte SHA-256 block are hashed down first and keys
 * shorter are zero-padded, both per RFC 2104 - so a key is never rejected for
 * its length, and a 64-byte key and its 32-byte digest are deliberately *not*
 * interchangeable.
 */
inline std::array<uint8_t, 32> hmac_sha256 (std::string_view key, std::string_view data) {
    constexpr size_t block_size = 64;

    std::array<uint8_t, block_size> padded_key{};
    if (key.size () > block_size) {
        const auto digest = sha256 (key);
        std::copy (digest.begin (), digest.end (), padded_key.begin ());
    } else {
        for (size_t i = 0; i < key.size (); ++i) {
            padded_key[i] = static_cast<uint8_t> (key[i]);
        }
    }

    std::string inner;
    inner.reserve (block_size + data.size ());
    std::string outer;
    outer.reserve (block_size + 32);

    for (const uint8_t byte : padded_key) {
        inner.push_back (static_cast<char> (byte ^ 0x36));
        outer.push_back (static_cast<char> (byte ^ 0x5c));
    }
    inner.append (data);

    const auto inner_digest = sha256 (inner);
    outer.append (
    reinterpret_cast<const char*> (inner_digest.data ()), inner_digest.size ());

    return sha256 (outer);
}

} // namespace vayu::utils
