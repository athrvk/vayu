#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

// PKCE (RFC 7636) helpers plus a small CSPRNG-ish token generator for `state`
// and the code verifier. Localhost dev-tool context: std::random_device is an
// acceptable entropy source here.

#include "vayu/utils/encoding.hpp"
#include "vayu/utils/sha256.hpp"

#include <random>
#include <string>

namespace vayu::http::pkce {

/**
 * @brief base64url(SHA-256(verifier)) — the S256 code challenge.
 */
inline std::string code_challenge (const std::string& verifier) {
    const auto hash = vayu::utils::sha256 (verifier);
    return vayu::utils::base64url_encode (
    std::string_view (reinterpret_cast<const char*> (hash.data ()), hash.size ()));
}

/**
 * @brief Random base64url token of `n_bytes` entropy (e.g. 32 → a 43-char
 *        PKCE verifier; 16 → a state value).
 */
inline std::string random_token (size_t n_bytes) {
    std::random_device rd;
    std::string bytes;
    bytes.reserve (n_bytes);
    for (size_t i = 0; i < n_bytes; ++i) {
        bytes.push_back (static_cast<char> (rd () & 0xff));
    }
    return vayu::utils::base64url_encode (bytes);
}

} // namespace vayu::http::pkce
