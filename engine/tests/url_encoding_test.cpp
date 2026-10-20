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
#include "vayu/http/form_body.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/types.hpp"

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

// ---------------------------------------------------------------------------
// pm.sendRequest against Send (issue #2465). A script's URL is written with
// `encode_url_as_postman` and then handed to the same transfer layer as Send,
// which applies `wire_url`; Send's URL is composed and goes through `wire_url`
// alone. Both put out one request line for one URL.
// ---------------------------------------------------------------------------

std::string sent_by_send (const std::string& url) {
    vayu::Request request;
    request.url = url;
    return vayu::http::wire_url (request);
}

std::string sent_by_script (const std::string& url) {
    return sent_by_send (encode_url_as_postman (url));
}

// Mutation check: make `wire_url` return the URL untouched (form_body.cpp)
// and the Send column stops matching the expected line.
TEST (PostmanUrlEncodingAgreement, SpaceControlsAndNonAsciiAreWrittenAlike) {
    const std::vector<std::pair<std::string, std::string>> cases = {
        { "http://h/a b?q=c d#e f", "http://h/a%20b?q=c%20d#e%20f" },
        { "http://h/café?q=é", "http://h/caf%C3%A9?q=%C3%A9" },
        { "http://h/a\tb?q=\x01\x7F", "http://h/a%09b?q=%01%7F" },
        { "http://h/%41%20b?q=%26&r=a+b", "http://h/%41%20b?q=%26&r=a+b" },
        { "http://h/x?a=1&&b=2=3&c", "http://h/x?a=1&&b=2=3&c" },
    };
    for (const auto& [url, line] : cases) {
        EXPECT_EQ (sent_by_send (url), line) << url;
        EXPECT_EQ (sent_by_script (url), line) << url;
    }
}

// What `wire_url`'s early return may skip: a URL the encoder leaves alone,
// including bytes no set holds and a `://` or uppercase after the head.
TEST (PostmanUrlEncodingAgreement, AUrlTheEncoderLeavesAloneIsReturnedAsTyped) {
    for (const std::string url :
    { "http://h/p'|^[]!*()~/%20?q=`{}\\|^[]+&r=a+b#f'{}|",
    "https://h.example:8443/A/B?Q=Upper&r=HTTP://Y@Z#Frag" }) {
        EXPECT_EQ (sent_by_send (url), url);
        EXPECT_EQ (sent_by_script (url), url);
    }
}

// Send substitutes a value into the component it lands in; a script's value is
// substituted as text and the whole URL then encoded. Both write the same
// bytes for a value carrying a space or a non-ASCII character.
TEST (PostmanUrlEncodingAgreement, APathQueryOrFragmentSubstitutionIsWrittenAlike) {
    struct Case {
        std::string url_template;
        std::string value;
        std::string line;
    };
    const std::vector<Case> cases = {
        { "http://h/users/{{v}}/x?q=1", "John Doe", "http://h/users/John%20Doe/x?q=1" },
        { "http://h/x?q={{v}}", "John Doe", "http://h/x?q=John%20Doe" },
        { "http://h/x#{{v}}", "a b", "http://h/x#a%20b" },
        { "http://h/{{v}}", "café", "http://h/caf%C3%A9" },
    };
    for (const auto& c : cases) {
        const vayu::http::VariableValues vars{ { "v", c.value } };
        EXPECT_EQ (
        sent_by_send (vayu::http::resolve_url_template (c.url_template, vars, true)),
        c.line)
        << c.url_template;

        std::string substituted = c.url_template;
        substituted.replace (substituted.find ("{{v}}"), 5, c.value);
        EXPECT_EQ (sent_by_script (substituted), c.line) << c.url_template;
    }
}

// Each URL holds one thing the encoder rewrites, so a `wire_url` early return
// that missed it would send the URL as typed. Mutation check: drop a byte from
// `is_postman_rewritten_byte`, or the authority check from
// `postman_would_rewrite` (form_body.cpp), and its row fails in the Send
// column only.
TEST (PostmanUrlEncodingAgreement, ASendWritesWhatAScriptWrites) {
    const std::vector<std::pair<std::string, std::string>> cases = {
        { "http://h/a\"b?q=a\"b", "http://h/a%22b?q=a%22b" },
        { "http://h/<x>`?q=<x>", "http://h/%3Cx%3E%60?q=%3Cx%3E" },
        { "http://h/{a}?q={a}", "http://h/%7Ba%7D?q={a}" },
        { "http://h/x?q='", "http://h/x?q=%27" },
        { "http://h/x#a`b", "http://h/x#a%60b" },
        { "http://h/a\\b?q=a\\b", "http://h/a/b?q=a\\b" },
        { "  http://h/x", "http://h/x" },
        { "http://EXAMPLE.com/x", "http://example.com/x" },
        { "http:////Example.com/x", "http:////example.com/x" },
        { "EXAMPLE.com:8080/x", "example.com:8080/x" },
        { "HOST/x?r=a://b", "host/x?r=a://b" },
        { "http://[::FFFF:1]/x", "http://[::ffff:1]/x" },
        { "http://u;s@h/x", "http://u%3Bs@h/x" },
    };
    for (const auto& [typed, line] : cases) {
        EXPECT_EQ (sent_by_send (typed), line) << typed;
        EXPECT_EQ (sent_by_script (typed), line) << typed;
    }
}

} // namespace
