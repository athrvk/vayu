/**
 * @file tests/sample_capture_test.cpp
 * @brief Tests for the pure decisions behind load-run response capture.
 *
 * Focus: a body that cannot be stored as text must be recognised as such
 * (`looks_binary`), and identical stored bytes must produce identical dedup
 * keys while different bytes must not (`body_digest`). Both run at flush time,
 * so they are unit-testable without a run.
 *
 * The binary rule is the one that protects a user from silently corrupted
 * data: `error_handler_t::replace` keeps `dump()` from throwing on a gzip
 * stream and hands back a mojibake that reads exactly like a real response.
 */

#include <gtest/gtest.h>

#include <string>

#include "vayu/core/sample_capture.hpp"

using vayu::core::body_digest;
using vayu::core::looks_binary;
using vayu::core::media_type;

namespace {

TEST (MediaType, StripsParametersAndLowercases) {
    EXPECT_EQ (media_type ("application/JSON; charset=utf-8"), "application/json");
    EXPECT_EQ (media_type ("  text/html  "), "text/html");
    EXPECT_EQ (media_type ("image/png"), "image/png");
    EXPECT_EQ (media_type (""), "");
}

TEST (LooksBinary, TextContentTypesAreText) {
    EXPECT_FALSE (looks_binary ("hello", "text/plain"));
    EXPECT_FALSE (looks_binary (R"({"ok":true})", "application/json"));
    EXPECT_FALSE (looks_binary ("<a/>", "application/atom+xml"));
    EXPECT_FALSE (looks_binary ("a=1&b=2", "application/x-www-form-urlencoded"));
    EXPECT_FALSE (looks_binary ("x", "application/javascript"));
}

TEST (LooksBinary, NonTextContentTypeIsBinaryWithoutReadingBytes) {
    // The bytes here are perfectly good ASCII; the declared type is what
    // decides, which is what keeps classifying an image cheap.
    EXPECT_TRUE (looks_binary ("PNGDATA", "image/png"));
    EXPECT_TRUE (looks_binary ("x", "application/octet-stream"));
    EXPECT_TRUE (looks_binary ("x", "application/x-protobuf"));
}

TEST (LooksBinary, InvalidUtf8IsBinaryEvenWhenLabelledText) {
    // The realistic case: `Accept-Encoding: gzip` with no
    // CURLOPT_ACCEPT_ENCODING, so the compressed bytes arrive under the
    // origin's own `text/html`.
    const std::string gzip = std::string ("\x1f\x8b\x08\x00\x00\x00\x00\x00", 8) + "\xff\xfe";
    EXPECT_TRUE (looks_binary (gzip, "text/html"));

    // A lone continuation byte is not valid UTF-8 at any position.
    EXPECT_TRUE (looks_binary (std::string ("ok\x80there"), "text/plain"));
}

TEST (LooksBinary, EmbeddedNulIsBinary) {
    EXPECT_TRUE (looks_binary (std::string ("ab\0cd", 5), "text/plain"));
    EXPECT_TRUE (looks_binary (std::string ("ab\0cd", 5), ""));
}

TEST (LooksBinary, ValidMultiByteUtf8IsText) {
    EXPECT_FALSE (looks_binary ("héllo wörld — ok", "text/plain"));
    EXPECT_FALSE (looks_binary ("\xE2\x9C\x93 done", ""));
    EXPECT_FALSE (looks_binary ("\xF0\x9F\x8E\x89", "")); // U+1F389
}

TEST (LooksBinary, SequenceCutByTruncationIsStillText) {
    // A capture truncated mid-character must not be called binary: the split
    // is our own cap, not anything about the response. Build a body whose
    // final byte is the start of a 3-byte sequence.
    std::string body (vayu::core::SNIFF_BYTES - 1, 'a');
    body.push_back ('\xE2');
    EXPECT_FALSE (looks_binary (body, "text/plain"));
}

TEST (LooksBinary, EmptyBodyIsText) {
    EXPECT_FALSE (looks_binary ("", "image/png"));
}

TEST (BodyDigest, IdenticalBytesShareAKeyAndDifferentBytesDoNot) {
    const std::string body = R"({"status":"ok"})";
    EXPECT_EQ (body_digest (body), body_digest (std::string (body)));
    EXPECT_NE (body_digest (body), body_digest (R"({"status":"OK"})"));
    // 64 lowercase hex characters - a SHA-256 digest, the shape the dedup key
    // column stores.
    EXPECT_EQ (body_digest (body).size (), 64u);
    EXPECT_EQ (body_digest (body).find_first_not_of ("0123456789abcdef"), std::string::npos);
}

TEST (BodyDigest, EmptyBodyHashesToTheKnownSha256) {
    EXPECT_EQ (body_digest (""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

} // namespace
