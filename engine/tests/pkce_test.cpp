/**
 * @file tests/pkce_test.cpp
 * @brief SHA-256 (FIPS 180-4), base64url, and PKCE (RFC 7636) vectors.
 */

#include <gtest/gtest.h>

#include <string>

#include "vayu/http/pkce.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/sha256.hpp"

namespace {

// Delegates rather than repeating the table: vayu::utils::hex_encode is the one
// hex encoder, and a second copy here would not receive its fixes.
std::string hex (const std::array<uint8_t, 32>& d) {
    return vayu::utils::hex_encode (
    std::string_view (reinterpret_cast<const char*> (d.data ()), d.size ()));
}

TEST (Sha256, Fips180Vectors) {
    EXPECT_EQ (hex (vayu::utils::sha256 ("")),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    EXPECT_EQ (hex (vayu::utils::sha256 ("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    EXPECT_EQ (
    hex (vayu::utils::sha256 (
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}

TEST (Sha256, HandlesMultiBlockAndPaddingBoundary) {
    // 55 bytes: fits with padding in one block; 56 bytes: forces a second block.
    EXPECT_EQ (hex (vayu::utils::sha256 (std::string (55, 'a'))),
    "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318");
    EXPECT_EQ (hex (vayu::utils::sha256 (std::string (56, 'a'))),
    "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
}

// RFC 4231 §4. Cases 1-3 cover a short key, an ASCII key and a full-block-ish
// key; case 6 is the one that matters most here, because its 131-byte key
// exercises the "hash the key down first" branch of RFC 2104 that a short key
// never reaches. Backs pm.crypto.hmacSha256 in the script sandbox.
TEST (HmacSha256, Rfc4231Vectors) {
    EXPECT_EQ (hex (vayu::utils::hmac_sha256 (std::string (20, '\x0b'), "Hi There")),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")
    << "case 1";

    EXPECT_EQ (hex (vayu::utils::hmac_sha256 ("Jefe", "what do ya want for nothing?")),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
    << "case 2";

    EXPECT_EQ (
    hex (vayu::utils::hmac_sha256 (std::string (20, '\xaa'), std::string (50, '\xdd'))),
    "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe")
    << "case 3";

    EXPECT_EQ (hex (vayu::utils::hmac_sha256 (std::string (131, '\xaa'),
               "Test Using Larger Than Block-Size Key - Hash Key First")),
    "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54")
    << "case 6 - key longer than the 64-byte block";
}

TEST (HmacSha256, KeyLengthsAroundTheBlockBoundary) {
    // 64 bytes is used as-is; 65 is hashed to 32 first. Pinned to known answers
    // rather than just to each other, because an off-by-one in the length test
    // (>= where > belongs) still produces two different MACs - "these differ"
    // would pass while a 64-byte key was quietly being hashed down.
    EXPECT_EQ (hex (vayu::utils::hmac_sha256 (std::string (63, 'k'), "payload")),
    "053491462ff9bc089fc983b345332712f18867b013011373dac80d58326beba5");
    EXPECT_EQ (hex (vayu::utils::hmac_sha256 (std::string (64, 'k'), "payload")),
    "825fe496b2f55f2c6a78d8e3f21cff15b59fc2bcd437be6f7bda2fb2c4d8a9f4")
    << "a key of exactly one block is used as-is, not hashed";
    const auto over = vayu::utils::hmac_sha256 (std::string (65, 'k'), "payload");
    EXPECT_EQ (hex (over), "bd24b45a850e5df5a7f21642c7f47ace8444900a95d1eb8284553e273b262d22");

    // A 65-byte key is hashed to 32 bytes, but that is not the same as being
    // *given* those 32 bytes zero-padded... it is exactly that, by
    // construction. So the equality below is the specification, not an
    // accident: pass the digest of an over-long key and you get the same MAC.
    const auto digest = vayu::utils::sha256 (std::string (65, 'k'));
    const std::string_view digest_bytes (
    reinterpret_cast<const char*> (digest.data ()), digest.size ());
    EXPECT_EQ (hex (over), hex (vayu::utils::hmac_sha256 (digest_bytes, "payload")));
}

TEST (Base64Url, NoPaddingUrlSafeAlphabet) {
    // bytes that base64 to values containing + and / → become - and _
    EXPECT_EQ (vayu::utils::base64url_encode (std::string ("\xfb\xff\xbf", 3)), "-_-_");
    EXPECT_EQ (vayu::utils::base64url_encode ("f"), "Zg"); // no "=="
    EXPECT_EQ (vayu::utils::base64url_encode ("fo"), "Zm8");
}

// RFC 7636 Appendix B: the canonical PKCE example.
TEST (Pkce, Rfc7636AppendixBChallenge) {
    const std::string verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    EXPECT_EQ (vayu::http::pkce::code_challenge (verifier),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
}

TEST (Pkce, RandomTokenLengthAndAlphabet) {
    const std::string verifier = vayu::http::pkce::random_token (32);
    // 32 bytes → 43 base64url chars (no padding)
    EXPECT_EQ (verifier.size (), 43u);
    for (char c : verifier) {
        const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_';
        EXPECT_TRUE (ok) << "unexpected char: " << c;
    }
    // Overwhelmingly likely to differ across calls.
    EXPECT_NE (verifier, vayu::http::pkce::random_token (32));
}

} // namespace
