/**
 * @file tests/url_encoding_test.cpp
 * @brief `core::encode_url_as_postman`: a whole URL written as Postman's
 *        `toNodeUrl` writes it.
 *
 * Every expected value below was produced by running `postman-collection`
 * 5.3.1's `new Request (url).url` through `postman-url-encoder` 3.0.8's
 * `toNodeUrl (url, false).href`, except where a case says it departs.
 */

#include <gtest/gtest.h>

#include <string>
#include <utility>
#include <vector>

#include "vayu/core/url_encoding.hpp"

namespace {

using vayu::core::encode_url_as_postman;

TEST (PostmanUrlEncoding, EachComponentIsEncodedByItsOwnSet) {
    const std::vector<std::pair<std::string, std::string>> cases = {
        { "http://h:8080/echo/a b?q=c d&r=\"x\"", "http://h:8080/echo/a%20b?q=c%20d&r=%22x%22" },
        // The path set encodes backtick and braces, the query set `'`; each
        // leaves the other's alone, and `|`, `^`, `[`, `]` are in neither.
        { "http://h/echo/p'q\"<>`{}|^[]?q='<>`{}|\\^[]!*()~",
        "http://h/echo/p'q%22%3C%3E%60%7B%7D|^[]?q=%27%3C%3E`{}|\\^[]!*()~" },
        { "http://h/echo/café/日本?q=café&k=日本", "http://h/echo/caf%C3%A9/%E6%97%A5%E6%9C%AC?q=caf%C3%A9&k=%E6%97%A5%E6%9C%AC" },
        { "http://h/ec\tho/x?q=\x01", "http://h/ec%09ho/x?q=%01" },
        { "http://h/echo/x?a=1#frag ment`", "http://h/echo/x?a=1#frag%20ment%60" },
        { "http://h/a?b=1#c?d#e f", "http://h/a?b=1#c?d#e%20f" },
        { "http://u s:p@ss@h:8080/x", "http://u%20s:p%40ss@h:8080/x" },
        { "  http://EXAMPLE.Com:8080/A B?Q=1", "http://example.com:8080/A%20B?Q=1" },
        // A backslash before the query is a `/`; after it, text.
        { "http:\\\\Host\\a b\\c?x=\\y", "http://host/a%20b/c?x=\\y" },
    };
    for (const auto& [url, sent] : cases) {
        EXPECT_EQ (encode_url_as_postman (url), sent) << url;
    }
}

TEST (PostmanUrlEncoding, QuerySeparatorsStayStructure) {
    for (const std::string url : { "http://h/x?a=1&b=2=3&c&d=", "http://h/x?",
         "http://h/x?&&a", "http://h/x?a=1&&b=2", "http://h/x?=v",
         "http://h/x/?q=1#", "http://h/x?a=b?c/d@e:f;g,h$i+j" }) {
        EXPECT_EQ (encode_url_as_postman (url), url);
    }
}

// `%` is in no set, so an escape passes whether or not it is a valid one, and
// a URL composition already encoded goes out unchanged.
TEST (PostmanUrlEncoding, AnEscapeIsNeverEncodedTwice) {
    for (const std::string url : { "http://h/echo/%41%20b?q=%26x%3D&r=a%zz",
         "http://h/echo/a%2Fb%?q=%", "http://u%20s:p%40ss@h/x#a%20b" }) {
        EXPECT_EQ (encode_url_as_postman (url), url);
    }
    const std::string once =
    encode_url_as_postman ("http://h/a b?q=\"c d\"#e f");
    EXPECT_EQ (encode_url_as_postman (once), once);
}

// A departure: Postman encodes the braces too (`%7B%7Ba%20b%7D%7D`), but a
// token that reaches here is one nothing answered, and Vayu sends that as the
// name it is everywhere else. The separators inside it still split nothing.
TEST (PostmanUrlEncoding, AnUnansweredTokenIsKeptWholeAndSplitsNothing) {
    EXPECT_EQ (
    encode_url_as_postman ("http://h/{{a b}}/x y?{{k&=v}}=1 2&z={{#}}#{{ }} x"),
    "http://h/{{a b}}/x%20y?{{k&=v}}=1%202&z={{#}}#{{ }}%20x");
    EXPECT_EQ (encode_url_as_postman ("{{base}}/a b?q={{v}} w"), "{{base}}/a%20b?q={{v}}%20w");
    EXPECT_EQ (encode_url_as_postman ("http://h/x?q={{a b&c=d}}"), "http://h/x?q={{a b&c=d}}");
    EXPECT_EQ (encode_url_as_postman ("http://h/x?q={{a#b c}}"), "http://h/x?q={{a#b c}}");
}

// `encodeHost`: `url.domainToASCII`, or the host as typed when that answers
// `""` (the send then refuses it, see idn_host_test.cpp).
TEST (PostmanUrlEncoding, ANonAsciiHostIsWrittenAsPunycode) {
    const std::vector<std::pair<std::string, std::string>> cases = {
        { "https://BÜCHER.example:8080/ä?q=ü", "https://xn--bcher-kva.example:8080/%C3%A4?q=%C3%BC" },
        { "https://user:pw@faß.de/x", "https://user:pw@xn--fa-hia.de/x" },
        { "https://bücher-.example/", "https://xn--bcher--3ya.example/" },
        { "https://xn--iñvalid.com/", "https://xn--iñvalid.com/" },
        { "http://{{host}}.example/a", "http://{{host}}.example/a" },
    };
    for (const auto& [url, sent] : cases) {
        EXPECT_EQ (encode_url_as_postman (url), sent) << url;
    }
}

TEST (PostmanUrlEncoding, AFileUrlKeepsItsPathSlash) {
    // The kept slash is where the path starts, so nothing after it is read
    // as a host and lowercased.
    EXPECT_EQ (encode_url_as_postman ("file:///Tmp/a b"), "file:///Tmp/a%20b");
}

} // namespace
