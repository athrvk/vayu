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

#include "jwt_keys.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/jwt.hpp"
#include "vayu/utils/sodium_init.hpp"

namespace {

using vayu::tests::jwt::BioPtr;
using vayu::tests::jwt::drain;
using vayu::tests::jwt::KeyPtr;
using vayu::tests::jwt::keys;
using vayu::tests::jwt::pkcs8;
using vayu::tests::jwt::private_pem;
using vayu::tests::jwt::public_half;
using vayu::tests::jwt::split;
using vayu::tests::jwt::verifies;
using vayu::utils::sign_jwt;

constexpr std::string_view CLAIMS =
R"({"iss":"client-id","sub":"client-id","aud":"https://auth.example/token","exp":1893456000})";
constexpr std::string_view PASSPHRASE = "correct horse";

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
