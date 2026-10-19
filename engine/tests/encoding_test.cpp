/**
 * @file tests/encoding_test.cpp
 * @brief Tests for base64 / url / form encoding helpers.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <array>
#include <optional>
#include <string>
#include <string_view>

#include "vayu/utils/encoding.hpp"

using vayu::utils::base64_decode;
using vayu::utils::base64_encode;
using vayu::utils::form_encode;
using vayu::utils::hex_encode;
using vayu::utils::is_valid_utf8_text;
using vayu::utils::url_decode;
using vayu::utils::url_encode;
using vayu::utils::utf8_sequence_length;
using vayu::utils::without_incomplete_utf8_tail;

namespace {

/// The bytes @p encoded decodes to, or an empty string after a failure naming
/// it. A vector table stays one line per vector this way, and an input that
/// failed to decode is that line's failure rather than a read of an empty
/// optional.
std::string decoded (std::string_view encoded) {
    const std::optional<std::string> bytes = base64_decode (encoded);
    EXPECT_TRUE (bytes.has_value ()) << "expected \"" << encoded << "\" to decode";
    return bytes.value_or (std::string{});
}

} // namespace

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
    EXPECT_EQ (base64_encode ("Aladdin:open sesame"), "QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
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
    EXPECT_EQ (url_decode ("%zz"), "%zz"); // non-hex digits
    EXPECT_EQ (url_decode ("%1"), "%1");   // truncated at end of string
    EXPECT_EQ (url_decode ("%"), "%");     // lone percent
    EXPECT_EQ (url_decode ("a%2"), "a%2"); // truncated escape after text
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
    EXPECT_EQ (form_encode ({ { "grant_type", "client_credentials" }, { "scope", "a b" } }),
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
    EXPECT_EQ (decoded (""), "");
    EXPECT_EQ (decoded ("Zg=="), "f");
    EXPECT_EQ (decoded ("Zm8="), "fo");
    EXPECT_EQ (decoded ("Zm9v"), "foo");
    EXPECT_EQ (decoded ("Zm9vYg=="), "foob");
    EXPECT_EQ (decoded ("Zm9vYmE="), "fooba");
    EXPECT_EQ (decoded ("Zm9vYmFy"), "foobar");
}

TEST (Encoding, Base64DecodeAcceptsUnpaddedAndWrappedInput) {
    // Padding is optional as long as the trailing bits are zero, and wrapped
    // base64 (a PEM-ish blob, a value pasted out of a config file) is common
    // enough that rejecting the newline would be its own bug.
    EXPECT_EQ (decoded ("Zg"), "f");
    EXPECT_EQ (decoded ("Zm8"), "fo");
    EXPECT_EQ (decoded ("Zm9v\nYmFy"), "foobar");
    EXPECT_EQ (decoded ("Zm9v YmFy"), "foobar");
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
    const std::string bytes = decoded ("AP8Q");
    ASSERT_EQ (bytes.size (), 3U);
    EXPECT_EQ (static_cast<unsigned char> (bytes[0]), 0x00);
    EXPECT_EQ (static_cast<unsigned char> (bytes[1]), 0xFF);
    EXPECT_EQ (static_cast<unsigned char> (bytes[2]), 0x10);
}

TEST (Encoding, Base64RoundTripsEveryByteValue) {
    std::string all;
    for (int i = 0; i < 256; ++i) {
        all.push_back (static_cast<char> (i));
    }
    EXPECT_EQ (decoded (base64_encode (all)), all);
}

TEST (Encoding, HexEncodeIsLowercaseAndZeroPadded) {
    EXPECT_EQ (hex_encode (""), "");
    EXPECT_EQ (hex_encode (std::string ("\x00\x0f\xff\xa5", 4)), "000fffa5");
    EXPECT_EQ (hex_encode ("foobar"), "666f6f626172");
}

// ---------------------------------------------------------------------------
// is_valid_utf8_text (issue #2458): whether a response body can travel as a
// JSON string. Each row's verdict is also checked against nlohmann's own
// serializer, which is the rule the predicate exists to predict.
// ---------------------------------------------------------------------------

namespace {

struct Utf8TextCase {
    const char* name;
    std::string_view bytes;
    bool text;
};

constexpr auto UTF8_TEXT_CASES = std::to_array<Utf8TextCase> ({
{ "Empty", "", true },
{ "Ascii", "plain ascii", true },
{ "TwoThreeAndFourByteSequences", "caf\xC3\xA9 \xE2\x82\xAC \xF0\x9F\x8E\x89", true },
{ "Utf8ByteOrderMark", "\xEF\xBB\xBFhi", true },
{ "Latin1", "caf\xE9 na\xEFve", false },
{ "Windows1252Quotes", "\x93quoted\x94 \x80", false },
{ "Utf16LittleEndianWithBom", std::string_view ("\xFF\xFEh\x00i\x00", 6), false },
{ "LoneContinuationByte", "a\x80z", false },
{ "SequenceCutShortByTheEnd", "ok\xC3", false },
{ "OverlongTwoByteNul", "\xC0\x80", false },
{ "OverlongThreeByte", "\xE0\x80\x80", false },
{ "Surrogate", "\xED\xA0\x80", false },
{ "PastTheLastScalarValue", "\xF4\x90\x80\x80", false },
{ "LeadByteF5", "\xF5\x80\x80\x80", false },
});

class Utf8TextTest : public ::testing::TestWithParam<Utf8TextCase> {};

} // namespace

TEST_P (Utf8TextTest, AgreesWithTheJsonSerializer) {
    const auto& c = GetParam ();
    EXPECT_EQ (is_valid_utf8_text (c.bytes), c.text);

    bool serializes = true;
    try {
        (void)nlohmann::json (std::string (c.bytes)).dump ();
    } catch (const nlohmann::json::type_error&) {
        serializes = false;
    }
    EXPECT_EQ (serializes, c.text) << "the table disagrees with nlohmann";
}

INSTANTIATE_TEST_SUITE_P (IsValidUtf8Text,
Utf8TextTest,
::testing::ValuesIn (UTF8_TEXT_CASES),
[] (const ::testing::TestParamInfo<Utf8TextCase>& info) {
    return std::string (info.param.name);
});

// NUL serializes fine (as \u0000), so it is the one row the serializer cannot
// answer for: it is refused because text never carries it.
TEST (Encoding, Utf8TextRefusesNul) {
    EXPECT_FALSE (is_valid_utf8_text (std::string_view ("ab\0cd", 5)));
}

// The whole input, not a prefix: one bad byte at the very end decides it.
TEST (Encoding, Utf8TextReadsTheWholeInput) {
    EXPECT_FALSE (is_valid_utf8_text (std::string (size_t{ 64 } * 1024, 'a') + "\xFF"));
}

TEST (Encoding, Utf8SequenceLengthNamesTheSequenceAtAnOffset) {
    const std::string_view text = "a\xE2\x82\xAC\xC3";
    EXPECT_EQ (utf8_sequence_length (text, 0), 1u);
    EXPECT_EQ (utf8_sequence_length (text, 1), 3u);
    EXPECT_EQ (utf8_sequence_length (text, 2), 0u); // a continuation byte
    EXPECT_EQ (utf8_sequence_length (text, 4), 0u); // cut short by the end
}

// ---------------------------------------------------------------------------
// without_incomplete_utf8_tail (issue #2458): a body the read cap cut can end
// inside a character, and only that cut is forgiven. Mutation check: return
// `bytes` unchanged and every `Trims...` case below goes red.
// ---------------------------------------------------------------------------

TEST (Encoding, Utf8TailKeepsABodyEndingOnACharacterBoundary) {
    for (const std::string_view whole :
    { std::string_view (""), std::string_view ("ok"), std::string_view ("caf\xC3\xA9"),
    std::string_view ("\xE2\x82\xAC"), std::string_view ("ok\xF0\x9F\x8E\x89") }) {
        EXPECT_EQ (without_incomplete_utf8_tail (whole), whole);
    }
}

TEST (Encoding, Utf8TailTrimsEveryCutOfTwoThreeAndFourByteCharacters) {
    for (const std::string_view character : { std::string_view ("\xC3\xA9"),
         std::string_view ("\xE2\x82\xAC"), std::string_view ("\xF0\x9F\x8E\x89") }) {
        for (std::size_t kept = 1; kept < character.size (); ++kept) {
            const std::string body = "ok" + std::string (character.substr (0, kept));
            EXPECT_EQ (without_incomplete_utf8_tail (body), "ok")
            << character.size () << "-byte character cut after " << kept;
        }
    }
}

// A tail no continuation could complete is not a cut character, so it stays
// for `is_valid_utf8_text` to refuse: C0 and F5 start nothing, E0 80 is
// overlong, ED A0 a surrogate, F4 90 past U+10FFFF, and a run of continuation
// bytes has no lead in reach.
TEST (Encoding, Utf8TailKeepsATailNoCharacterStartsWith) {
    for (const std::string_view body :
    { std::string_view ("ok\xC0"), std::string_view ("ok\xF5"),
    std::string_view ("ok\xE0\x80"), std::string_view ("ok\xED\xA0"),
    std::string_view ("ok\xF4\x90"), std::string_view ("ok\x80\x80\x80\x80") }) {
        EXPECT_EQ (without_incomplete_utf8_tail (body), body);
        EXPECT_FALSE (is_valid_utf8_text (without_incomplete_utf8_tail (body)));
    }
}

TEST (Encoding, Utf8TailLeavesAnInvalidByteMidBodyToFail) {
    const std::string_view body = "a\xFFz\xE2\x82";
    EXPECT_EQ (without_incomplete_utf8_tail (body), "a\xFFz");
    EXPECT_FALSE (is_valid_utf8_text (without_incomplete_utf8_tail (body)));
}
