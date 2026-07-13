/**
 * @file tests/encoding_test.cpp
 * @brief Tests for base64 / url / form encoding helpers.
 */

#include <gtest/gtest.h>

#include "vayu/utils/encoding.hpp"

using vayu::utils::base64_encode;
using vayu::utils::form_encode;
using vayu::utils::url_encode;

// RFC 4648 §10 test vectors.
TEST (Encoding, Base64Rfc4648Vectors) {
    EXPECT_EQ (base64_encode (""), "");
    EXPECT_EQ (base64_encode ("f"), "Zg==");
    EXPECT_EQ (base64_encode ("fo"), "Zm8=");
    EXPECT_EQ (base64_encode ("foo"), "Zm9v");
    EXPECT_EQ (base64_encode ("foob"), "Zm9vYg==");
    EXPECT_EQ (base64_encode ("fooba"), "Zm9vYmE=");
    EXPECT_EQ (base64_encode ("foobar"), "Zm9vYmFy");
}

TEST (Encoding, Base64BasicCredentials) {
    // Classic HTTP Basic example: "Aladdin:open sesame".
    EXPECT_EQ (base64_encode ("Aladdin:open sesame"),
    "QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
}

TEST (Encoding, Base64HandlesEmbeddedNulAndHighBytes) {
    const std::string in ("\x00\xff\x10", 3);
    EXPECT_EQ (base64_encode (in), "AP8Q");
}

TEST (Encoding, UrlEncodeLeavesUnreserved) {
    EXPECT_EQ (url_encode ("abcXYZ019-_.~"), "abcXYZ019-_.~");
}

TEST (Encoding, UrlEncodeEscapesReserved) {
    EXPECT_EQ (url_encode ("a b"), "a%20b");
    EXPECT_EQ (url_encode ("a+b&c=d"), "a%2Bb%26c%3Dd");
    EXPECT_EQ (url_encode ("/path?x"), "%2Fpath%3Fx");
    EXPECT_EQ (url_encode ("token#frag"), "token%23frag");
}

TEST (Encoding, UrlEncodeUppercaseHex) {
    // 0x7F -> %7F (uppercase), not %7f.
    EXPECT_EQ (url_encode (std::string ("\x7f", 1)), "%7F");
}

TEST (Encoding, FormEncodeOrdersAndEscapes) {
    EXPECT_EQ (form_encode ({ { "grant_type", "client_credentials" } }),
    "grant_type=client_credentials");
    EXPECT_EQ (
    form_encode ({ { "grant_type", "client_credentials" }, { "scope", "a b" } }),
    "grant_type=client_credentials&scope=a%20b");
    EXPECT_EQ (form_encode ({}), "");
}
