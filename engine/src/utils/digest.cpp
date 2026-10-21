/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/utils/digest.hpp"

#include <openssl/evp.h>
#include <openssl/hmac.h>

#include <array>
#include <climits>

#include "vayu/utils/sodium_init.hpp"

namespace vayu::utils {

namespace {

struct NamedAlgorithm {
    std::string_view name;
    DigestAlgorithm algorithm;
};

constexpr auto ALGORITHM_NAMES = std::to_array<NamedAlgorithm> ({
{ "MD5", DigestAlgorithm::Md5 },
{ "SHA1", DigestAlgorithm::Sha1 },
{ "SHA224", DigestAlgorithm::Sha224 },
{ "SHA256", DigestAlgorithm::Sha256 },
{ "SHA384", DigestAlgorithm::Sha384 },
{ "SHA512", DigestAlgorithm::Sha512 },
});

const EVP_MD* evp_digest (DigestAlgorithm algorithm) {
    switch (algorithm) {
    case DigestAlgorithm::Md5: return EVP_md5 ();
    case DigestAlgorithm::Sha1: return EVP_sha1 ();
    case DigestAlgorithm::Sha224: return EVP_sha224 ();
    case DigestAlgorithm::Sha256: return EVP_sha256 ();
    case DigestAlgorithm::Sha384: return EVP_sha384 ();
    case DigestAlgorithm::Sha512: return EVP_sha512 ();
    }
    return nullptr;
}

} // namespace

std::optional<DigestAlgorithm> digest_algorithm_named (std::string_view name) {
    for (const auto& entry : ALGORITHM_NAMES) {
        if (entry.name == name) {
            return entry.algorithm;
        }
    }
    return std::nullopt;
}

// `sodium_bytes` for every input: it never hands out a null pointer, and
// `HMAC` reads a null key as "keep the previous key" rather than as the empty
// one.

std::optional<std::vector<std::uint8_t>>
digest (DigestAlgorithm algorithm, std::string_view data) {
    std::vector<std::uint8_t> out (EVP_MAX_MD_SIZE);
    unsigned int length = 0;
    if (EVP_Digest (detail::sodium_bytes (data), data.size (), out.data (),
        &length, evp_digest (algorithm), nullptr) != 1) {
        return std::nullopt;
    }
    out.resize (length);
    return out;
}

std::optional<std::vector<std::uint8_t>>
hmac (DigestAlgorithm algorithm, std::string_view key, std::string_view data) {
    // HMAC takes the key length as an int.
    if (key.size () > static_cast<std::size_t> (INT_MAX)) {
        return std::nullopt;
    }
    std::vector<std::uint8_t> out (EVP_MAX_MD_SIZE);
    unsigned int length = 0;
    if (HMAC (evp_digest (algorithm), detail::sodium_bytes (key),
        static_cast<int> (key.size ()), detail::sodium_bytes (data),
        data.size (), out.data (), &length) == nullptr) {
        return std::nullopt;
    }
    out.resize (length);
    return out;
}

} // namespace vayu::utils
