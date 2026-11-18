/**
 * @file tests/jwt_test.cpp
 * @brief `sign_jwt` (RFC 7515 / RFC 7518 section 3): each token is checked by
 *        verifying its signature under the public half of the key, not by
 *        comparing against a stored value, so a wrong hash, a wrong padding or
 *        an ES256 signature left in DER all fail the same way.
 */

#include <gtest/gtest.h>
#include <openssl/bio.h>
#include <openssl/bn.h>
#include <openssl/ecdsa.h>
#include <openssl/evp.h>
#include <openssl/pem.h>

#include <algorithm>
#include <array>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/utils/encoding.hpp"
#include "vayu/utils/jwt.hpp"
#include "vayu/utils/sodium_init.hpp"

namespace {

using vayu::utils::sign_jwt;

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

constexpr std::string_view CLAIMS =
R"({"iss":"client-id","sub":"client-id","aud":"https://auth.example/token","exp":1893456000})";
constexpr std::string_view PASSPHRASE = "correct horse";

std::string drain (BIO* bio) {
    char* data      = nullptr;
    const long size = BIO_get_mem_data (bio, &data);
    return std::string (data, static_cast<std::size_t> (size));
}

/// The key as PEM. `traditional` writes `RSA PRIVATE KEY` / `EC PRIVATE KEY`
/// instead of PKCS#8; `passphrase` encrypts it.
std::string
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
KeyPtr public_half (const KeyPtr& key) {
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

const Keys& keys () {
    static const Keys generated{ KeyPtr (EVP_RSA_gen (2048)), KeyPtr (EVP_RSA_gen (1024)),
        KeyPtr (EVP_EC_gen ("P-256")), KeyPtr (EVP_EC_gen ("P-384")) };
    return generated;
}

std::string pkcs8 (const KeyPtr& key) {
    return private_pem (key, false);
}

struct Parts {
    std::string header;
    std::string payload;
    std::string signature;
};

std::string base64url_to_bytes (std::string_view text) {
    std::string standard (text);
    std::ranges::replace (standard, '-', '+');
    std::ranges::replace (standard, '_', '/');
    const auto decoded = vayu::utils::base64_decode (standard);
    return decoded ? *decoded : std::string{};
}

/// Splits a compact JWS into its three decoded segments; fails the test when
/// it is not three base64url segments.
Parts split (const std::string& token) {
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

bool verify_der (const KeyPtr& pub, std::string_view signing_input, std::string_view signature) {
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
std::string jose_to_der (std::string_view jose) {
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
bool verifies (const std::string& token, const KeyPtr& pub, std::string_view alg) {
    const auto last_dot             = token.rfind ('.');
    const std::string signing_input = token.substr (0, last_dot);
    const std::string signature     = split (token).signature;
    return alg == "ES256" ? verify_der (pub, signing_input, jose_to_der (signature)) :
                            verify_der (pub, signing_input, signature);
}

/// The bare base64 of @p pem: what a refusal must never repeat.
std::string key_body (std::string_view pem) {
    std::string body;
    bool in_armor = false;
    for (const char c : pem) {
        if (c == '-') {
            in_armor = true;
        } else if (c == '\n') {
            in_armor = false;
        } else if (!in_armor && c != '\r') {
            body.push_back (c);
        }
    }
    return body;
}

/// A refusal's message, with the check that no 8-character run of the key's
/// text appears in it.
std::string refusal (const std::string& alg, const std::string& pem) {
    const auto result = sign_jwt (alg, pem, std::nullopt, CLAIMS);
    if (result.has_value ()) {
        ADD_FAILURE () << "signed where a refusal was expected";
        return {};
    }
    const std::string message    = result.error ().message;
    const std::string body       = key_body (pem);
    constexpr std::size_t WINDOW = 8;
    for (std::size_t i = 0; i + WINDOW <= body.size (); ++i) {
        EXPECT_EQ (message.find (body.substr (i, WINDOW)), std::string::npos)
        << "the message repeats key text: " << message;
    }
    EXPECT_FALSE (message.empty ());
    return message;
}

/// The key's body on one line, spaces between the armor and the body: what a
/// form field that flattened the newlines hands over.
std::string one_line (std::string pem) {
    std::ranges::replace (pem, '\n', ' ');
    while (!pem.empty () && pem.back () == ' ') {
        pem.pop_back ();
    }
    return pem;
}

/// The same key with each newline spelled as the two characters `\` `n`.
std::string literal_escapes (const std::string& pem) {
    std::string escaped;
    for (const char c : pem) {
        if (c == '\n') {
            escaped += "\\n";
        } else {
            escaped.push_back (c);
        }
    }
    return escaped;
}

std::string token_or_fail (std::string_view alg,
const std::string& pem,
std::optional<std::string_view> kid = std::nullopt) {
    const auto result = sign_jwt (alg, pem, kid, CLAIMS);
    if (!result.has_value ()) {
        ADD_FAILURE () << "refused: " << result.error ().message;
        return {};
    }
    return *result;
}

TEST (Jwt, Rs256SignatureVerifiesUnderThePublicKey) {
    const auto& rsa         = keys ().rsa;
    const std::string token = token_or_fail ("RS256", pkcs8 (rsa));
    EXPECT_TRUE (verifies (token, public_half (rsa), "RS256"));
    EXPECT_EQ (split (token).signature.size (), 256U);
}

TEST (Jwt, Es256SignatureIs64BytesAndVerifiesUnderThePublicKey) {
    const auto& ec          = keys ().p256;
    const std::string token = token_or_fail ("ES256", pkcs8 (ec));
    EXPECT_EQ (split (token).signature.size (), 64U);
    EXPECT_TRUE (verifies (token, public_half (ec), "ES256"));
}

TEST (Jwt, HeaderAndPayloadDecodeToWhatWasGiven) {
    const auto token = token_or_fail ("RS256", pkcs8 (keys ().rsa));
    const auto parts = split (token);
    EXPECT_EQ (nlohmann::json::parse (parts.header),
    (nlohmann::json{ { "alg", "RS256" }, { "typ", "JWT" } }));
    EXPECT_EQ (parts.payload, CLAIMS);
    EXPECT_EQ (
    nlohmann::json::parse (split (token_or_fail ("ES256", pkcs8 (keys ().p256))).header)["alg"],
    "ES256");
}

TEST (Jwt, KidIsInTheHeaderWhenGivenAndNotEmpty) {
    const std::string pem = pkcs8 (keys ().p256);
    const auto with_kid =
    nlohmann::json::parse (split (token_or_fail ("ES256", pem, "key-1")).header);
    EXPECT_EQ (with_kid.value ("kid", ""), "key-1");
    EXPECT_FALSE (
    nlohmann::json::parse (split (token_or_fail ("ES256", pem)).header).contains ("kid"));
    EXPECT_FALSE (
    nlohmann::json::parse (split (token_or_fail ("ES256", pem, "")).header).contains ("kid"));
}

TEST (Jwt, KidIsEscapedNotSpliced) {
    const std::string pem = pkcs8 (keys ().p256);
    const auto header =
    nlohmann::json::parse (split (token_or_fail ("ES256", pem, R"(a"b\c)")).header);
    EXPECT_EQ (header.value ("kid", ""), R"(a"b\c)");
}

TEST (Jwt, KidThatIsNotUtf8IsRefusedNotThrown) {
    const auto result =
    sign_jwt ("ES256", pkcs8 (keys ().p256), std::string_view ("\xff\xfe"), CLAIMS);
    ASSERT_FALSE (result.has_value ());
    EXPECT_EQ (result.error ().message, "kid is not valid UTF-8");
}

TEST (Jwt, TraditionalKeysSign) {
    EXPECT_TRUE (verifies (token_or_fail ("RS256", private_pem (keys ().rsa, true)),
    public_half (keys ().rsa), "RS256"));
    EXPECT_TRUE (verifies (token_or_fail ("ES256", private_pem (keys ().p256, true)),
    public_half (keys ().p256), "ES256"));
}

TEST (Jwt, ParametersBlockAheadOfTheKeyIsSkipped) {
    const std::string pem = "-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n"
                            "-----END EC PARAMETERS-----\n" +
    private_pem (keys ().p256, true);
    EXPECT_TRUE (
    verifies (token_or_fail ("ES256", pem), public_half (keys ().p256), "ES256"));
}

TEST (Jwt, PemWithItsLineBreaksDroppedSignsAsTheOriginalDoes) {
    const auto& rsa       = keys ().rsa;
    const std::string pem = pkcs8 (rsa);
    ASSERT_NE (pem.find ('\n'), std::string::npos);
    const std::string flat = one_line (pem);
    ASSERT_EQ (flat.find ('\n'), std::string::npos);

    const std::string token = token_or_fail ("RS256", flat);
    EXPECT_TRUE (verifies (token, public_half (rsa), "RS256"));
    // PKCS#1 v1.5 is deterministic: the same key and input give the same bytes.
    EXPECT_EQ (token, token_or_fail ("RS256", pem));

    const auto& ec = keys ().p256;
    EXPECT_TRUE (verifies (
    token_or_fail ("ES256", one_line (pkcs8 (ec))), public_half (ec), "ES256"));
}

TEST (Jwt, PemWithLiteralBackslashNSignsAsTheOriginalDoes) {
    const auto& rsa           = keys ().rsa;
    const std::string pem     = pkcs8 (rsa);
    const std::string escaped = literal_escapes (pem);
    ASSERT_EQ (escaped.find ('\n'), std::string::npos);
    ASSERT_NE (escaped.find ("\\n"), std::string::npos);

    const std::string token = token_or_fail ("RS256", escaped);
    EXPECT_TRUE (verifies (token, public_half (rsa), "RS256"));
    EXPECT_EQ (token, token_or_fail ("RS256", pem));

    const auto& ec = keys ().p256;
    EXPECT_TRUE (verifies (token_or_fail ("ES256", literal_escapes (pkcs8 (ec))),
    public_half (ec), "ES256"));
}

TEST (Jwt, PemWithWindowsLineEndingsAndIndentSigns) {
    std::string pem;
    for (const char c : pkcs8 (keys ().rsa)) {
        if (c == '\n') {
            pem += "\r\n  ";
        } else {
            pem.push_back (c);
        }
    }
    EXPECT_TRUE (verifies (token_or_fail ("RS256", pem), public_half (keys ().rsa), "RS256"));
}

TEST (Jwt, EncryptedKeysAreRefusedWithoutPrompting) {
    for (const bool traditional : { false, true }) {
        SCOPED_TRACE (traditional ? "traditional" : "PKCS#8");
        for (const auto* key : { &keys ().rsa, &keys ().p256 }) {
            const std::string pem = private_pem (*key, traditional, PASSPHRASE);
            ASSERT_NE (pem.find ("ENCRYPTED"), std::string::npos);
            EXPECT_EQ (refusal ("RS256", pem), "private key is encrypted");
            EXPECT_EQ (refusal ("ES256", one_line (pem)), "private key is encrypted");
        }
    }
}

TEST (Jwt, RsaKeyUnder2048BitsIsRefused) {
    EXPECT_EQ (refusal ("RS256", pkcs8 (keys ().rsa_small)),
    "RS256 needs an RSA key of at least 2048 bits");
}

TEST (Jwt, KeyOfTheWrongTypeIsRefusedForTheAlgorithm) {
    EXPECT_EQ (refusal ("ES256", pkcs8 (keys ().rsa)), "ES256 needs a P-256 key");
    EXPECT_EQ (refusal ("RS256", pkcs8 (keys ().p256)),
    "RS256 needs an RSA key of at least 2048 bits");
}

TEST (Jwt, EcKeyOnAnotherCurveIsRefusedForEs256) {
    EXPECT_EQ (refusal ("ES256", pkcs8 (keys ().p384)), "ES256 needs a P-256 key");
}

TEST (Jwt, TextThatIsNotAPrivateKeyIsRefused) {
    EXPECT_EQ (refusal ("RS256", "this is not a key, only a sentence"), "not a PEM private key");
    EXPECT_EQ (refusal ("RS256", ""), "not a PEM private key");
    // Armored, but with a body that is not base64 of a key.
    EXPECT_EQ (refusal ("RS256", "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5IGF0IGFsbA==\n-----END PRIVATE KEY-----\n"),
    "not a PEM private key");
    // A truncated block with no END line.
    EXPECT_EQ (refusal ("RS256", pkcs8 (keys ().rsa).substr (0, 200)), "not a PEM private key");
}

TEST (Jwt, PublicKeyPemIsNotAPrivateKey) {
    const BioPtr bio (BIO_new (BIO_s_mem ()));
    ASSERT_EQ (PEM_write_bio_PUBKEY (bio.get (), keys ().rsa.get ()), 1);
    EXPECT_EQ (refusal ("RS256", drain (bio.get ())), "not a PEM private key");
}

TEST (Jwt, UnsupportedAlgorithmIsRefused) {
    const std::string pem = pkcs8 (keys ().rsa);
    for (const std::string alg : { "HS256", "rs256", "none", "" }) {
        SCOPED_TRACE (alg);
        EXPECT_EQ (refusal (alg, pem), "unsupported algorithm: use RS256 or ES256");
    }
}

} // namespace
