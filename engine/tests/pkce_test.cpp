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

std::string hex (const std::array<uint8_t, 32>& d) {
    static constexpr char h[] = "0123456789abcdef";
    std::string out;
    for (uint8_t b : d) {
        out.push_back (h[b >> 4]);
        out.push_back (h[b & 0xf]);
    }
    return out;
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
