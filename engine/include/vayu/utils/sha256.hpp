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

#include <algorithm>
#include <array>
#include <cstddef>
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

/**
 * @brief Whether @p text is a SHA-256 digest as 64 lowercase hex characters,
 * the one spelling `hex_encode` writes, so two digests of one file compare as
 * strings. Read where a client hands a digest back: a run's `dataFileHash`
 * and a collection's `dataFile.hash`.
 */
constexpr bool is_sha256_hex (std::string_view text) {
    constexpr size_t SHA256_HEX_LENGTH = 64;
    return text.size () == SHA256_HEX_LENGTH &&
    std::ranges::all_of (text,
    [] (char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

/**
 * @brief SHA-256 over bytes that arrive in pieces - a file hashed while it is
 * read, without holding the whole of it.
 */
class Sha256Stream {
    public:
    Sha256Stream () {
        ensure_sodium_initialized ();
        crypto_hash_sha256_init (&state_);
    }

    void update (std::string_view data) {
        crypto_hash_sha256_update (&state_, detail::sodium_bytes (data), data.size ());
    }

    [[nodiscard]] std::array<uint8_t, 32> finish () {
        std::array<uint8_t, 32> out{};
        crypto_hash_sha256_final (&state_, out.data ());
        return out;
    }

    private:
    crypto_hash_sha256_state state_{};
};

} // namespace vayu::utils
