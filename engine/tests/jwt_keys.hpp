#pragma once

/**
 * @file tests/jwt_keys.hpp
 * @brief Keys to sign with and the check that a compact JWS verifies under the
 *        public half, shared by the `sign_jwt` tests and the OAuth tests that
 *        read the assertion a grant posted.
 *
 * A token is verified by its signature under the public half of the key, never
 * by comparing against a stored value, so a wrong hash, a wrong padding or an
 * ES256 signature left in DER all fail the same way.
 */

#include <gtest/gtest.h>
#include <openssl/bio.h>
#include <openssl/bn.h>
#include <openssl/ecdsa.h>
#include <openssl/evp.h>
#include <openssl/pem.h>

#include <algorithm>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/utils/encoding.hpp"
#include "vayu/utils/sodium_init.hpp"

namespace vayu::tests::jwt {

struct KeyFree {
    void operator() (EVP_PKEY* key) const noexcept {
        EVP_PKEY_free (key);
    }
};
struct BioFree {
    void operator() (BIO* bio) const noexcept {
        BIO_free (bio);
    }
};
struct SignatureFree {
    void operator() (ECDSA_SIG* signature) const noexcept {
        ECDSA_SIG_free (signature);
    }
};
struct ContextFree {
    void operator() (EVP_MD_CTX* context) const noexcept {
        EVP_MD_CTX_free (context);
    }
};

using KeyPtr = std::unique_ptr<EVP_PKEY, KeyFree>;
using BioPtr = std::unique_ptr<BIO, BioFree>;

inline std::string drain (BIO* bio) {
    char* data      = nullptr;
    const long size = BIO_get_mem_data (bio, &data);
    return std::string (data, static_cast<std::size_t> (size));
}

/// The key as PEM. `traditional` writes `RSA PRIVATE KEY` / `EC PRIVATE KEY`
/// instead of PKCS#8; `passphrase` encrypts it.
inline std::string
private_pem (const KeyPtr& key, bool traditional, std::string_view passphrase = "") {
    const BioPtr bio (BIO_new (BIO_s_mem ()));
    const EVP_CIPHER* cipher = passphrase.empty () ? nullptr : EVP_aes_256_cbc ();
    const auto* pass  = vayu::utils::detail::sodium_bytes (passphrase);
    const auto length = static_cast<int> (passphrase.size ());
    const int ok      = traditional ?
    PEM_write_bio_PrivateKey_traditional (
    bio.get (), key.get (), cipher, pass, length, nullptr, nullptr) :
    PEM_write_bio_PrivateKey (bio.get (), key.get (), cipher, pass, length, nullptr, nullptr);
    EXPECT_EQ (ok, 1);
    return drain (bio.get ());
}

/// A key with only the public half, so a verify cannot lean on the private one.
inline KeyPtr public_half (const KeyPtr& key) {
    const BioPtr bio (BIO_new (BIO_s_mem ()));
    EXPECT_EQ (PEM_write_bio_PUBKEY (bio.get (), key.get ()), 1);
    return KeyPtr (PEM_read_bio_PUBKEY (bio.get (), nullptr, nullptr, nullptr));
}

struct Keys {
    KeyPtr rsa;
    KeyPtr rsa_small;
    KeyPtr p256;
    KeyPtr p384;
};

inline const Keys& keys () {
    static const Keys generated{ KeyPtr (EVP_RSA_gen (2048)), KeyPtr (EVP_RSA_gen (1024)),
        KeyPtr (EVP_EC_gen ("P-256")), KeyPtr (EVP_EC_gen ("P-384")) };
    return generated;
}

inline std::string pkcs8 (const KeyPtr& key) {
    return private_pem (key, false);
}

struct Parts {
    std::string header;
    std::string payload;
    std::string signature;
};

inline std::string base64url_to_bytes (std::string_view text) {
    std::string standard (text);
    std::ranges::replace (standard, '-', '+');
    std::ranges::replace (standard, '_', '/');
    const auto decoded = vayu::utils::base64_decode (standard);
    return decoded ? *decoded : std::string{};
}

/// Splits a compact JWS into its three decoded segments; fails the test when
/// it is not three base64url segments.
inline Parts split (const std::string& token) {
    const auto first  = token.find ('.');
    const auto second = token.find ('.', first + 1);
    if (first == std::string::npos || second == std::string::npos ||
    token.find ('.', second + 1) != std::string::npos) {
        ADD_FAILURE () << "not three segments: " << token;
        return {};
    }
    EXPECT_EQ (token.find_first_of ("+/="), std::string::npos)
    << "not base64url, unpadded";
    return { base64url_to_bytes (token.substr (0, first)),
        base64url_to_bytes (token.substr (first + 1, second - first - 1)),
        base64url_to_bytes (token.substr (second + 1)) };
}

inline bool verify_der (const KeyPtr& pub, std::string_view signing_input, std::string_view signature) {
    const std::unique_ptr<EVP_MD_CTX, ContextFree> context (EVP_MD_CTX_new ());
    if (EVP_DigestVerifyInit (
        context.get (), nullptr, EVP_sha256 (), nullptr, pub.get ()) != 1) {
        return false;
    }
    return EVP_DigestVerify (context.get (), vayu::utils::detail::sodium_bytes (signature),
           signature.size (), vayu::utils::detail::sodium_bytes (signing_input),
           signing_input.size ()) == 1;
}

/// The JOSE `r || s` back to the DER OpenSSL verifies.
inline std::string jose_to_der (std::string_view jose) {
    if (jose.size () != 64) {
        ADD_FAILURE () << "an ES256 signature is 64 bytes, got " << jose.size ();
        return {};
    }
    const auto* r_bytes = vayu::utils::detail::sodium_bytes (jose.substr (0, 32));
    const auto* s_bytes = vayu::utils::detail::sodium_bytes (jose.substr (32));
    std::unique_ptr<ECDSA_SIG, SignatureFree> signature (ECDSA_SIG_new ());
    BIGNUM* r = BN_bin2bn (r_bytes, 32, nullptr);
    BIGNUM* s = BN_bin2bn (s_bytes, 32, nullptr);
    ECDSA_SIG_set0 (signature.get (), r, s); // takes r and s
    const int size = i2d_ECDSA_SIG (signature.get (), nullptr);
    std::vector<unsigned char> der (static_cast<std::size_t> (size));
    unsigned char* cursor = der.data ();
    i2d_ECDSA_SIG (signature.get (), &cursor);
    return std::string (vayu::utils::byte_view (der));
}

/// Whether @p token verifies under @p pub for @p alg.
inline bool verifies (const std::string& token, const KeyPtr& pub, std::string_view alg) {
    const auto last_dot             = token.rfind ('.');
    const std::string signing_input = token.substr (0, last_dot);
    const std::string signature     = split (token).signature;
    return alg == "ES256" ? verify_der (pub, signing_input, jose_to_der (signature)) :
                            verify_der (pub, signing_input, signature);
}

} // namespace vayu::tests::jwt
