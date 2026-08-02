#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

// SHA-256 and HMAC-SHA256. Thin wrappers over libsodium, so the engine
// hand-maintains neither a hash nor the RFC 2104 key schedule.
//
// Two callers with different threat models share these: PKCE code challenges
// (RFC 7636 S256), which hash a client-generated, non-secret verifier whose
// challenge is then transmitted in the clear; and the script sandbox's
// pm.crypto surface, where a user signs an outgoing request with their own
// secret. Neither is constant-time - these compute a signature to send, they do
// not compare an attacker-supplied one - so verifying a MAC needs
// sodium_memcmp() over the result rather than operator==.

#include "vayu/utils/sodium_init.hpp"

#include <sodium.h>

#include <array>
#include <cstdint>
#include <string_view>

namespace vayu::utils {

static_assert (crypto_hash_sha256_BYTES == 32,
"SHA-256 digests are 32 bytes; the array returns below say so in their type");
static_assert (crypto_auth_hmacsha256_BYTES == 32,
"HMAC-SHA256 tags are 32 bytes; the array returns below say so in their type");

/**
 * @brief SHA-256 digest (32 bytes) of the given bytes.
 */
inline std::array<uint8_t, 32> sha256 (std::string_view data) {
    ensure_sodium_initialized ();
    std::array<uint8_t, 32> out{};
    crypto_hash_sha256 (out.data (), detail::sodium_bytes (data), data.size ());
    return out;
}

/**
 * @brief HMAC-SHA256 (RFC 2104) of `data` under `key`.
 *
 * crypto_auth_hmacsha256_init takes an arbitrary key length, so RFC 2104's key
 * schedule - hash keys longer than the 64-byte block down first, zero-pad
 * shorter ones - is libsodium's to get right rather than ours. A key is never
 * rejected for its length, and a 64-byte key and its 32-byte digest remain
 * deliberately *not* interchangeable.
 */
inline std::array<uint8_t, 32> hmac_sha256 (std::string_view key, std::string_view data) {
    ensure_sodium_initialized ();

    crypto_auth_hmacsha256_state state;
    crypto_auth_hmacsha256_init (&state, detail::sodium_bytes (key), key.size ());
    crypto_auth_hmacsha256_update (&state, detail::sodium_bytes (data), data.size ());

    std::array<uint8_t, 32> out{};
    crypto_auth_hmacsha256_final (&state, out.data ());
    return out;
}

} // namespace vayu::utils
