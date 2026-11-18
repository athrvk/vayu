#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A signed JWT (RFC 7515 compact serialisation) for the OAuth 2.0 JWT bearer
// grant (RFC 7523, #3632). Signing goes through OpenSSL's EVP interface, which
// is already in every binary as libcurl's TLS backend; libsodium has neither
// RSA nor ECDSA.

#include <expected>
#include <optional>
#include <string>
#include <string_view>

namespace vayu::utils {

/// Why a token could not be signed. The message names the reason and never
/// quotes the key or any part of it, so a caller may show it as is.
struct SignError {
    std::string message;
};

/**
 * @brief A compact JWS `header.payload.signature` over @p claims_json.
 *
 * @param alg    `RS256` (RSASSA-PKCS1-v1_5 with SHA-256, a key of at least
 *               2048 bits) or `ES256` (ECDSA over P-256 with SHA-256, the
 *               signature in JOSE `r || s` form). Anything else is refused.
 * @param pem    An unencrypted PKCS#8 or traditional private key. A PEM whose
 *               line breaks a form field dropped (one line, spaces between the
 *               armor and the body) or that carries the two characters `\n` in
 *               their place is taken too; it is rewrapped before it is read.
 * @param kid    Written to the header as `kid` when present and not empty.
 * @param claims_json  The payload, signed byte for byte as given.
 *
 * The buffers this makes of the key are cleansed before it returns.
 */
[[nodiscard]] std::expected<std::string, SignError> sign_jwt (std::string_view alg,
std::string_view pem,
std::optional<std::string_view> kid,
std::string_view claims_json);

} // namespace vayu::utils
