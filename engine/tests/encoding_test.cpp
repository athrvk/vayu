/**
 * @file tests/encoding_test.cpp
 * @brief Tests for base64 / url / form encoding helpers.
 */

#include <gtest/gtest.h>

#include "vayu/utils/encoding.hpp"

using vayu::utils::base64_decode;
using vayu::utils::base64_encode;
using vayu::utils::form_encode;
using vayu::utils::hex_encode;
using vayu::utils::url_decode;
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

TEST (Encoding, UrlDecodeBasicAndPlus) {
    EXPECT_EQ (url_decode ("a%20b"), "a b");
    EXPECT_EQ (url_decode ("a+b"), "a b");
    EXPECT_EQ (url_decode ("%2Fpath%3Fx"), "/path?x");
    EXPECT_EQ (url_decode ("token%23frag"), "token#frag");
    // Lower- and upper-case hex both decode.
    EXPECT_EQ (url_decode ("%7f%7F"), std::string ("\x7f\x7f", 2));
}

// A malformed percent-escape must pass through literally, never throw - the
// decoder runs on attacker-influenced callback query strings and token bodies.
TEST (Encoding, UrlDecodeToleratesMalformedEscapes) {
    EXPECT_EQ (url_decode ("%zz"), "%zz");     // non-hex digits
    EXPECT_EQ (url_decode ("%1"), "%1");       // truncated at end of string
    EXPECT_EQ (url_decode ("%"), "%");         // lone percent
    EXPECT_EQ (url_decode ("a%2"), "a%2");     // truncated escape after text
    EXPECT_EQ (url_decode ("%g0state"), "%g0state");
}

TEST (Encoding, UrlEncodeDecodeRoundTrip) {
    for (const std::string s : { "hello world", "a+b&c=d", "/p?x#y", "" }) {
        EXPECT_EQ (url_decode (url_encode (s)), s);
    }
}

TEST (Encoding, FormEncodeOrdersAndEscapes) {
    EXPECT_EQ (form_encode ({ { "grant_type", "client_credentials" } }),
    "grant_type=client_credentials");
    EXPECT_EQ (
    form_encode ({ { "grant_type", "client_credentials" }, { "scope", "a b" } }),
    "grant_type=client_credentials&scope=a%20b");
    EXPECT_EQ (form_encode ({}), "");
}

// ============================================================================
// base64_decode
// ============================================================================
//
// The inverse of the vectors above, plus the malformed cases - this helper
// backs the sandbox's `atob`, which must throw rather than hand a script bytes
// its author never encoded.

TEST (Encoding, Base64DecodeRfc4648Vectors) {
    EXPECT_EQ (base64_decode ("").value (), "");
    EXPECT_EQ (base64_decode ("Zg==").value (), "f");
    EXPECT_EQ (base64_decode ("Zm8=").value (), "fo");
    EXPECT_EQ (base64_decode ("Zm9v").value (), "foo");
    EXPECT_EQ (base64_decode ("Zm9vYg==").value (), "foob");
    EXPECT_EQ (base64_decode ("Zm9vYmE=").value (), "fooba");
    EXPECT_EQ (base64_decode ("Zm9vYmFy").value (), "foobar");
}

TEST (Encoding, Base64DecodeAcceptsUnpaddedAndWrappedInput) {
    // Padding is optional as long as the trailing bits are zero, and wrapped
    // base64 (a PEM-ish blob, a value pasted out of a config file) is common
    // enough that rejecting the newline would be its own bug.
    EXPECT_EQ (base64_decode ("Zg").value (), "f");
    EXPECT_EQ (base64_decode ("Zm8").value (), "fo");
    EXPECT_EQ (base64_decode ("Zm9v\nYmFy").value (), "foobar");
    EXPECT_EQ (base64_decode ("Zm9v YmFy").value (), "foobar");
}

TEST (Encoding, Base64DecodeRejectsMalformedInput) {
    EXPECT_FALSE (base64_decode ("Z").has_value ()); // a lone sextet is no byte
    EXPECT_FALSE (base64_decode ("Zm9$").has_value ()); // outside the alphabet
    EXPECT_FALSE (base64_decode ("Zg=v").has_value ()); // padding mid-string
    EXPECT_FALSE (base64_decode ("Zm9vYmF").has_value ()); // truncated: trailing bits set
    EXPECT_FALSE (base64_decode ("Zm9v=").has_value ()); // padding on a whole group
    EXPECT_FALSE (base64_decode ("-_").has_value ()); // base64url is a different alphabet
}

TEST (Encoding, Base64DecodeCarriesHighBytesAndNul) {
    const std::string decoded = base64_decode ("AP8Q").value ();
    ASSERT_EQ (decoded.size (), 3U);
    EXPECT_EQ (static_cast<unsigned char> (decoded[0]), 0x00);
    EXPECT_EQ (static_cast<unsigned char> (decoded[1]), 0xFF);
    EXPECT_EQ (static_cast<unsigned char> (decoded[2]), 0x10);
}

TEST (Encoding, Base64RoundTripsEveryByteValue) {
    std::string all;
    for (int i = 0; i < 256; ++i) {
        all.push_back (static_cast<char> (i));
    }
    EXPECT_EQ (base64_decode (base64_encode (all)).value (), all);
}

TEST (Encoding, HexEncodeIsLowercaseAndZeroPadded) {
    EXPECT_EQ (hex_encode (""), "");
    EXPECT_EQ (hex_encode (std::string ("\x00\x0f\xff\xa5", 4)), "000fffa5");
    EXPECT_EQ (hex_encode ("foobar"), "666f6f626172");
}
