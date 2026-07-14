#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

// SHA-256 for PKCE code challenges (RFC 7636 S256). Thin wrapper over the
// vendored, MIT-licensed picosha2 single-header (engine/vendor/picosha2) so the
// engine neither hand-maintains a hash implementation nor links OpenSSL. Not
// required to be constant-time: PKCE hashes a client-generated, non-secret
// verifier whose resulting challenge is transmitted in the clear.

#include <picosha2.h>

#include <array>
#include <cstdint>
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

} // namespace vayu::utils
