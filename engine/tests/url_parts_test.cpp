/**
 * @file url_parts_test.cpp
 * @brief The URL splitter behind `pm.request.url` (issue #991).
 *
 * These are the answers the script surface presents as `url.host`, `url.path`,
 * `url.query` and their getters, asserted here rather than through a JS context
 * so a wrong split is located in the parser instead of in a script that read
 * it. The script-level contract - that a lifted Postman script sees these under
 * Postman's names - is `script_engine_test.cpp`'s.
 *
 * Two rules carry most of the weight and each has a test that fails if it is
 * reversed: a path segment is decoded **on its own**, so an encoded separator
 * cannot invent a segment; and a query is **not** decoded at all, because the
 * request-signing workflows this exists for canonicalize the bytes that were
 * sent.
 */

#include <gtest/gtest.h>

#include <optional>
#include <string>
#include <vector>

#include "optional_assert.hpp"
#include "vayu/http/url_parts.hpp"

namespace vayu::http {
namespace {

TEST (UrlPartsTest, SplitsAFullUrlIntoItsParts) {
    const UrlParts parts = parse_url_parts (
    "https://api.example.com:8443/v2/users?page=2&sort=name#top");

    ASSERT_TRUE (parts.parsed);
    EXPECT_EQ (parts.protocol, "https");
    EXPECT_EQ (parts.host, (std::vector<std::string>{ "api", "example", "com" }));
    EXPECT_EQ (parts.port, "8443");
    EXPECT_EQ (parts.path, (std::vector<std::string>{ "v2", "users" }));
    EXPECT_EQ (parts.query, "page=2&sort=name");
    EXPECT_EQ (parts.hash, "top");

    EXPECT_EQ (join_host (parts.host), "api.example.com");
    EXPECT_EQ (join_path (parts.path), "/v2/users");
}

// A scheme's default port is not the port the URL states. Filling one in would
// make a canonical string built from these parts differ from the wire.
TEST (UrlPartsTest, AnUnstatedPortStaysEmptyRatherThanBecomingTheDefault) {
    const UrlParts parts = parse_url_parts ("https://api.example.com/users");

    ASSERT_TRUE (parts.parsed);
    EXPECT_EQ (parts.port, "");
    EXPECT_EQ (parts.hash, "");
    EXPECT_EQ (parts.query, "");
    EXPECT_TRUE (parts.query_params.empty ());
}

// `/` is one empty segment, which is what Postman's Url reports and what makes
// `getPath()` answer "/" rather than "".
TEST (UrlPartsTest, ARootPathIsOneEmptySegment) {
    const UrlParts root = parse_url_parts ("https://example.com/");
    ASSERT_TRUE (root.parsed);
    EXPECT_EQ (root.path, (std::vector<std::string>{ "" }));
    EXPECT_EQ (join_path (root.path), "/");

    // libcurl normalises "no path" to "/", so the two spellings agree.
    const UrlParts bare = parse_url_parts ("https://example.com");
    ASSERT_TRUE (bare.parsed);
    EXPECT_EQ (join_path (bare.path), "/");
}

TEST (UrlPartsTest, PathSegmentsAreDecoded) {
    const UrlParts parts = parse_url_parts ("https://example.com/a%20b/c%2Bd");

    ASSERT_TRUE (parts.parsed);
    EXPECT_EQ (parts.path, (std::vector<std::string>{ "a b", "c+d" }));
    EXPECT_EQ (join_path (parts.path), "/a b/c+d");
}

// Decoding the whole path first and splitting afterwards - the obvious
// implementation - turns this into three segments and reports a path the server
// never saw. Segment-at-a-time decoding is what keeps it at two.
TEST (UrlPartsTest, AnEncodedSlashStaysInsideItsSegment) {
    const UrlParts parts = parse_url_parts ("https://example.com/a%2Fb/c");

    ASSERT_TRUE (parts.parsed);
    EXPECT_EQ (parts.path, (std::vector<std::string>{ "a/b", "c" }));
}

TEST (UrlPartsTest, QueryParamsKeepWireOrderAndDuplicates) {
    const UrlParts parts =
    parse_url_parts ("https://example.com/s?b=2&a=1&b=3");

    ASSERT_TRUE (parts.parsed);
    ASSERT_EQ (parts.query_params.size (), 3u);
    EXPECT_EQ (parts.query_params[0].key, "b");
    EXPECT_EQ (parts.query_params[0].value, "2");
    EXPECT_EQ (parts.query_params[1].key, "a");
    EXPECT_EQ (parts.query_params[2].key, "b");
    EXPECT_EQ (parts.query_params[2].value, "3");
    // Byte-exact against the wire: the canonical string is built from this.
    EXPECT_EQ (parts.query, "b=2&a=1&b=3");
}

// `?flag` and `?flag=` are different facts. A single "empty means absent" would
// erase the distinction a rebuilt query string has to reproduce.
TEST (UrlPartsTest, ABareKeyIsToldApartFromAnEmptyValue) {
    const UrlParts parts =
    parse_url_parts ("https://example.com/s?flag&empty=");

    ASSERT_EQ (parts.query_params.size (), 2u);
    EXPECT_FALSE (parts.query_params[0].value.has_value ());
    const std::optional<std::string>& empty_value = parts.query_params[1].value;
    ASSERT_HAS_VALUE (empty_value);
    EXPECT_EQ (*empty_value, "");
}

// The query is the wire bytes. A decode here would make a signature built from
// `all()` differ from the one the server computes over what it received.
TEST (UrlPartsTest, QueryValuesAreNotDecoded) {
    const UrlParts parts =
    parse_url_parts ("https://example.com/s?q=hello%20world&plus=a+b");

    ASSERT_EQ (parts.query_params.size (), 2u);
    EXPECT_EQ (parts.query_params[0].value, "hello%20world");
    EXPECT_EQ (parts.query_params[1].value, "a+b");
}

TEST (UrlPartsTest, AValueMayContainItsOwnEquals) {
    const auto params = parse_query_params ("token=a=b=c");

    ASSERT_EQ (params.size (), 1u);
    EXPECT_EQ (params[0].key, "token");
    EXPECT_EQ (params[0].value, "a=b=c");
}

TEST (UrlPartsTest, EmptyRunsBetweenSeparatorsAreDropped) {
    const auto params = parse_query_params ("a=1&&b=2&");

    ASSERT_EQ (params.size (), 2u);
    EXPECT_EQ (params[0].key, "a");
    EXPECT_EQ (params[1].key, "b");
}

// An address literal has no dots to split on in the IPv6 case and is not a
// hostname in the IPv4 case; neither is special-cased, and both come back as
// something `join_host` puts together again unchanged.
TEST (UrlPartsTest, HostLiteralsSurviveTheSplitAndTheJoin) {
    const UrlParts v4 = parse_url_parts ("http://127.0.0.1:9876/health");
    ASSERT_TRUE (v4.parsed);
    EXPECT_EQ (join_host (v4.host), "127.0.0.1");
    EXPECT_EQ (v4.port, "9876");

    const UrlParts v6 = parse_url_parts ("http://[::1]:9876/health");
    ASSERT_TRUE (v6.parsed);
    EXPECT_EQ (v6.host.size (), 1u);
    EXPECT_EQ (join_host (v6.host), "[::1]");
}

// The parser answers "what are the pieces", never "can libcurl transfer it" -
// so a scheme no driver here supports still splits.
TEST (UrlPartsTest, AnUnsupportedSchemeStillSplits) {
    const UrlParts parts = parse_url_parts ("ws://example.com/socket?room=1");

    ASSERT_TRUE (parts.parsed);
    EXPECT_EQ (parts.protocol, "ws");
    EXPECT_EQ (join_path (parts.path), "/socket");
    EXPECT_EQ (parts.query, "room=1");
}

// No scheme guessing: reporting `http` for a string that never said so would
// put a protocol into a canonical string the request does not carry.
TEST (UrlPartsTest, AUrlWithoutASchemeIsNotParsedRatherThanGuessedAt) {
    const UrlParts parts = parse_url_parts ("example.com/users");

    EXPECT_FALSE (parts.parsed);
    EXPECT_TRUE (parts.protocol.empty ());
    EXPECT_TRUE (parts.host.empty ());
    EXPECT_TRUE (parts.path.empty ());
}

TEST (UrlPartsTest, AnUnparseableUrlReportsNoPartsAtAll) {
    const UrlParts parts = parse_url_parts ("{{base_url}}/users");

    EXPECT_FALSE (parts.parsed);
    EXPECT_TRUE (parts.host.empty ());
    EXPECT_TRUE (parts.query_params.empty ());
}

// ---------------------------------------------------------------------------
// Composition - the inverse, for a caller that edited the parts (issue #1040).
// ---------------------------------------------------------------------------

TEST (UrlPartsTest, ComposesTheEditedPartsBackIntoAUrl) {
    UrlParts parts =
    parse_url_parts ("https://api.example.com:8443/v2/users?page=2#top");
    ASSERT_TRUE (parts.parsed);

    parts.path.emplace_back ("active");
    parts.query_params.push_back ({ "sort", "name" });

    EXPECT_EQ (compose_url (parts),
    "https://api.example.com:8443/v2/users/active?page=2&sort=name#top");
}

// The parts a URL was split into put it back together unchanged, for the
// ordinary shapes. Where that is *not* guaranteed - an unusual escape - the
// script surface never composes at all, which is what the dirty flag is for;
// this pins the cases where it is.
TEST (UrlPartsTest, ComposeRoundTripsAParsedUrl) {
    for (const char* url :
    { "https://api.example.com/v2/users?page=2&sort=name#top",
    "http://127.0.0.1:9876/health", "https://example.com/",
    "ws://example.com/socket?room=1", "https://example.com/s?flag&empty=" }) {
        const UrlParts parts = parse_url_parts (url);
        ASSERT_TRUE (parts.parsed) << url;
        EXPECT_EQ (compose_url (parts), url);
    }
}

// Encoded on the way out because it was decoded on the way in, per segment - so
// a segment holding a slash stays one segment rather than becoming two.
TEST (UrlPartsTest, ComposeEncodesEachPathSegmentOnItsOwn) {
    UrlParts parts = parse_url_parts ("https://example.com/root");
    ASSERT_TRUE (parts.parsed);
    parts.path = { "a b", "c/d" };

    EXPECT_EQ (compose_url (parts), "https://example.com/a%20b/c%2Fd");
    // And it reads back as the two segments it was written from.
    const UrlParts reparsed = parse_url_parts (compose_url (parts));
    EXPECT_EQ (reparsed.path, (std::vector<std::string>{ "a b", "c/d" }));
}

// The query is the wire bytes in both directions: a value that arrived
// percent-encoded is written back as it arrived, not doubly encoded.
TEST (UrlPartsTest, ComposeDoesNotReEncodeTheQuery) {
    const UrlParts parts =
    parse_url_parts ("https://example.com/s?q=hello%20world");
    ASSERT_TRUE (parts.parsed);

    EXPECT_EQ (compose_url (parts), "https://example.com/s?q=hello%20world");
}

TEST (UrlPartsTest, ComposeQueryKeepsTheBareKeyDistinction) {
    EXPECT_EQ (compose_query ({ { "flag", std::nullopt }, { "empty", std::string () } }),
    "flag&empty=");
    EXPECT_EQ (compose_query ({}), "");
}

// Nothing to compose from, and a URL built out of empty pieces ("://") would
// look plausible enough to send.
TEST (UrlPartsTest, ComposingAnUnparsedUrlAnswersNothing) {
    const UrlParts parts = parse_url_parts ("{{base_url}}/users");

    ASSERT_FALSE (parts.parsed);
    EXPECT_EQ (compose_url (parts), "");
}

TEST (UrlPartsTest, JoinHostAndJoinPathAreEmptyForEmptyInput) {
    EXPECT_EQ (join_host ({}), "");
    EXPECT_EQ (join_path ({}), "");
}

} // namespace
} // namespace vayu::http
