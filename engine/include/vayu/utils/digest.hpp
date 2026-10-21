#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

// MD5, SHA-1, the SHA-2 family and HMAC over each, through OpenSSL's EVP
// interface (#2578). The script sandbox's crypto-js shim is the caller: the
// libraries Postman scripts sign with reach for MD5 and SHA-1 as often as for
// SHA-256, and libsodium (utils/sha256.hpp) has neither. OpenSSL is already in
// every binary as libcurl's TLS backend, so this adds no dependency.
//
// The same threat-model note as sha256.hpp applies: these compute a value to
// send, not one to compare against an attacker's, so nothing here is
// constant-time.

#include <cstdint>
#include <optional>
#include <string_view>
#include <vector>

namespace vayu::utils {

enum class DigestAlgorithm : std::uint8_t {
    Md5,
    Sha1,
    Sha224,
    Sha256,
    Sha384,
    Sha512
};

/**
 * @brief The algorithm @p name spells: `MD5`, `SHA1`, `SHA224`, `SHA256`,
 *        `SHA384` or `SHA512`, exactly; nullopt for anything else.
 */
[[nodiscard]] std::optional<DigestAlgorithm> digest_algorithm_named (std::string_view name);

/**
 * @brief The digest of @p data, or nullopt when OpenSSL refuses (a provider
 *        configured without the algorithm).
 */
[[nodiscard]] std::optional<std::vector<std::uint8_t>>
digest (DigestAlgorithm algorithm, std::string_view data);

/**
 * @brief HMAC (RFC 2104) of @p data under @p key, or nullopt when OpenSSL
 *        refuses. A key of any length is taken, the empty one included.
 */
[[nodiscard]] std::optional<std::vector<std::uint8_t>>
hmac (DigestAlgorithm algorithm, std::string_view key, std::string_view data);

} // namespace vayu::utils
