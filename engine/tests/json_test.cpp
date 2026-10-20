/**
 * @file tests/json_test.cpp
 * @brief Tests for JSON utilities
 */

#include "nested_json.hpp"
#include "optional_assert.hpp"
#include "vayu/utils/json.hpp"

#include <gtest/gtest.h>

#include <array>
#include <sstream>
#include <string>

#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/utils/encoding.hpp"

namespace vayu::json {
namespace {

TEST (JsonTest, ParsesValidJson) {
    auto result = parse (R"({"key": "value"})");

    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ()["key"], "value");
}

TEST (JsonTest, ReturnsErrorForInvalidJson) {
    auto result = parse ("not valid json");

    ASSERT_TRUE (result.is_error ());
    EXPECT_EQ (result.error ().code, ErrorCode::InternalError);
}

TEST (JsonTest, DeserializesSimpleRequest) {
    std::string json_str = R"({
        "method": "GET",
        "url": "https://example.com/api"
    })";

    auto result = deserialize_request (json_str);

    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().method, HttpMethod::GET);
    EXPECT_EQ (result.value ().url, "https://example.com/api");
}

TEST (JsonTest, DeserializesRequestWithHeaders) {
    std::string json_str = R"({
        "method": "POST",
        "url": "https://example.com/api",
        "headers": {
            "Content-Type": "application/json",
            "Authorization": "Bearer token123"
        }
    })";

    auto result = deserialize_request (json_str);

    ASSERT_TRUE (result.is_ok ());
    const auto& req = result.value ();
    EXPECT_EQ (req.headers.at ("Content-Type"), "application/json");
    EXPECT_EQ (req.headers.at ("Authorization"), "Bearer token123");
}

// The line form (issue #2466): every line kept, in the order given, each in its
// own spelling. Mutation check: read the lines into a `Headers` map again and
// the three collapse to two.
TEST (JsonTest, DeserializesHeaderLinesKeepingEveryOneInOrder) {
    auto result = deserialize_request (std::string (R"({
        "method": "GET",
        "url": "https://example.com/api",
        "headers": [
            {"name": "X-Dup", "value": "one"},
            {"name": "x-dup", "value": "two"},
            {"name": "X-Dup", "value": "three"}
        ]
    })"));

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (result.value ().headers,
    (HeaderList{ { "X-Dup", "one" }, { "x-dup", "two" }, { "X-Dup", "three" } }));
}

// The older object form is still read, one line per key - a JSON object holds a
// name once, so it stays single-valued.
TEST (JsonTest, AHeaderObjectStaysOneLinePerKey) {
    auto result = deserialize_request (std::string (
    R"({"method":"GET","url":"https://x.test","headers":{"B":"2","A":"1"}})"));

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (result.value ().headers, (HeaderList{ { "A", "1" }, { "B", "2" } }));
}

// Two spellings of one name in an object were one entry in the map this list
// replaced: the first spelling, the last value.
TEST (JsonTest, AHeaderObjectFoldsTwoSpellingsOfOneName) {
    auto result = deserialize_request (std::string (
    R"({"method":"GET","url":"https://x.test","headers":{"X-Dup":"a","x-dup":"b"}})"));

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (result.value ().headers, (HeaderList{ { "X-Dup", "b" } }));
}

TEST (JsonTest, RefusesAHeaderLineThatIsNotANameAndAValue) {
    for (const char* headers : { R"([{"name":"X-A"}])",
         R"([{"name":1,"value":"v"}])", R"(["X-A: v"])", R"("X-A: v")" }) {
        auto result = deserialize_request (R"({"method":"GET","url":"https://x.test","headers":)" +
        std::string (headers) + "}");
        EXPECT_TRUE (result.is_error ()) << headers;
    }
}

// A name is trimmed of the spaces and tabs around it, in either shape (issue
// #2467). Mutation check: drop the trim in `stored_header_name` and both fail.
TEST (JsonTest, PaddedHeaderNamesAreTrimmedInBothShapes) {
    auto array_form = deserialize_request (std::string (
    R"({"method":"GET","url":"https://x.test","headers":[{"name":"Authorization ","value":"v"},{"name":"\tX-A","value":" w "}]})"));
    ASSERT_TRUE (array_form.is_ok ()) << array_form.error ().message;
    EXPECT_EQ (array_form.value ().headers,
    (HeaderList{ { "Authorization", "v" }, { "X-A", " w " } }));

    auto object_form = deserialize_request (std::string (
    R"({"method":"GET","url":"https://x.test","headers":{" X-A ":"1"}})"));
    ASSERT_TRUE (object_form.is_ok ()) << object_form.error ().message;
    EXPECT_EQ (object_form.value ().headers, (HeaderList{ { "X-A", "1" } }));
}

// What is left after the trim must be a token, and the refusal carries the code
// a route answers under. Mutation check: drop the `invalid_header_name_refusal`
// call in `stored_header_name`.
TEST (JsonTest, RefusesAHeaderNameThatIsNotATokenInBothShapes) {
    for (const std::string name : { "X Bad", "X:Bad", "X-\u00e9" }) {
        const std::vector<std::string> shapes = { R"([{"name":")" + name + R"(","value":"v"}])",
            R"({")" + name + R"(":"v"})" };
        for (const std::string& shape : shapes) {
            auto result = deserialize_request (
            R"({"method":"GET","url":"https://x.test","headers":)" + shape + "}");

            ASSERT_TRUE (result.is_error ()) << shape;
            EXPECT_EQ (result.error ().code, vayu::ErrorCode::InvalidHeaderName) << shape;
            EXPECT_NE (result.error ().message.find ("'" + name + "'"), std::string::npos)
            << result.error ().message;
        }
    }
}

// A name of nothing but padding is stored empty, for the empty-name refusal
// every send makes - the same answer the compose route gives it.
// A name still holding a token waits for the layer that resolves it.
TEST (JsonTest, ABlankOrTemplatedHeaderNameIsNotThisRefusal) {
    auto blank = deserialize_request (std::string (
    R"({"method":"GET","url":"https://x.test","headers":[{"name":"  ","value":"v"}]})"));
    ASSERT_TRUE (blank.is_ok ()) << blank.error ().message;
    EXPECT_EQ (blank.value ().headers, (HeaderList{ { "", "v" } }));

    auto templated = deserialize_request (std::string (
    R"({"method":"GET","url":"https://x.test","headers":[{"name":" {{h}} ","value":"v"}]})"));
    ASSERT_TRUE (templated.is_ok ()) << templated.error ().message;
    EXPECT_EQ (templated.value ().headers, (HeaderList{ { "{{h}}", "v" } }));
}

TEST (JsonTest, DeserializesRequestWithBody) {
    std::string json_str = R"({
        "method": "POST",
        "url": "https://example.com/api",
        "body": {
            "mode": "json",
            "content": {"name": "test"}
        }
    })";

    auto result = deserialize_request (json_str);

    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().body.mode, BodyMode::Json);
    EXPECT_FALSE (result.value ().body.content.empty ());
}

TEST (JsonTest, DeserializesRequestWithOptions) {
    std::string json_str = R"({
        "method": "GET",
        "url": "https://example.com/api",
        "timeout": 5000,
        "followRedirects": false,
        "maxRedirects": 3,
        "verifySSL": false
    })";

    auto result = deserialize_request (json_str);

    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().timeout_ms, 5000);
    EXPECT_FALSE (result.value ().follow_redirects);
    EXPECT_EQ (result.value ().max_redirects, 3);
    EXPECT_FALSE (result.value ().verify_ssl);
}

TEST (JsonTest, ReturnsErrorForMissingMethod) {
    std::string json_str = R"({
        "url": "https://example.com/api"
    })";

    auto result = deserialize_request (json_str);

    ASSERT_TRUE (result.is_error ());
    EXPECT_EQ (result.error ().code, ErrorCode::InvalidMethod);
}

TEST (JsonTest, ReturnsErrorForMissingUrl) {
    std::string json_str = R"({
        "method": "GET"
    })";

    auto result = deserialize_request (json_str);

    ASSERT_TRUE (result.is_error ());
    EXPECT_EQ (result.error ().code, ErrorCode::InvalidUrl);
}

TEST (JsonTest, ReturnsErrorForInvalidMethod) {
    std::string json_str = R"({
        "method": "INVALID",
        "url": "https://example.com/api"
    })";

    auto result = deserialize_request (json_str);

    ASSERT_TRUE (result.is_error ());
    EXPECT_EQ (result.error ().code, ErrorCode::InvalidMethod);
}

TEST (JsonTest, SerializesResponse) {
    Response response;
    response.status_code             = 200;
    response.status_text             = "OK";
    response.headers["content-type"] = "application/json";
    response.body                    = R"({"success": true})";
    response.body_size               = response.body.size ();
    response.timing.total_ms         = 123.45;
    response.http_version            = "HTTP/2";

    auto json = serialize (response);

    EXPECT_EQ (json["status"], 200);
    EXPECT_EQ (json["statusText"], "OK");
    EXPECT_EQ (json["headers"]["content-type"], "application/json");
    EXPECT_EQ (json["body"]["success"], true); // Parsed as JSON
    EXPECT_DOUBLE_EQ (json["timing"]["totalMs"], 123.45);
    EXPECT_EQ (json["httpVersion"], "HTTP/2");
}

// A response that never got far enough to negotiate anything (e.g. a
// connection-refused error) has http_version == "" - the default. That must
// serialize as an honest empty string, not be dropped or coerced into a
// guess like "HTTP/1.1".
TEST (JsonTest, SerializesUnnegotiatedResponseHttpVersionAsEmptyString) {
    Response response;
    response.status_code = 0;

    auto json = serialize (response);

    ASSERT_TRUE (json.contains ("httpVersion"));
    EXPECT_EQ (json["httpVersion"], "");
}

// The lossless header list (issue #2460). Always present, an empty array when
// none arrived, so a client can tell "none" from "an engine too old to say" -
// the rule `httpVersion` above is held to. Wire order, name as received.
TEST (JsonTest, SerializesHeaderLinesInWireOrderWithTheirCase) {
    Response response;
    response.status_code  = 200;
    response.headers["x"] = "folded";
    response.header_lines = { { "Set-Cookie", "a=1; Path=/" },
        { "X-Dup", "first" }, { "Set-Cookie", "b=2" }, { "x-dup", "third" } };

    auto json = serialize (response);

    ASSERT_TRUE (json["headerLines"].is_array ());
    ASSERT_EQ (json["headerLines"].size (), 4U);
    EXPECT_EQ (json["headerLines"][0],
    (Json{ { "name", "Set-Cookie" }, { "value", "a=1; Path=/" } }));
    EXPECT_EQ (json["headerLines"][1]["name"], "X-Dup");
    EXPECT_EQ (json["headerLines"][2]["value"], "b=2");
    EXPECT_EQ (json["headerLines"][3]["name"], "x-dup");
}

// What was sent, both ways (issue #2466): `requestHeaderLines` every line in
// wire order, `requestHeaders` one value per name for the readers written
// against it - a repeat joined with ", ", a `Cookie` with "; ".
TEST (JsonTest, SerializesTheSentHeaderLinesAndTheirFoldedRecord) {
    Response response;
    response.status_code     = 200;
    response.request_headers = { { "X-Dup", "one" }, { "Cookie", "a=1" },
        { "x-dup", "two" }, { "Cookie", "b=2" } };

    auto json = serialize (response);

    EXPECT_EQ (json["requestHeaderLines"], Json::parse (R"([{"name":"X-Dup","value":"one"},
        {"name":"Cookie","value":"a=1"},{"name":"x-dup","value":"two"},
        {"name":"Cookie","value":"b=2"}])"));
    EXPECT_EQ (json["requestHeaders"],
    Json::parse (R"({"Cookie":"a=1; b=2","X-Dup":"one, two"})"));
}

// A credential header is withheld from a run's snapshot in the line form
// exactly as in the object form, and a secret value is masked in a line's
// `value` only - a name is never a value (issue #2466).
TEST (JsonTest, ASnapshotWithholdsCredentialHeaderLines) {
    const std::string stored = sanitize_config_snapshot (
    R"({"headers":[{"name":"authorization","value":"Bearer t0k3n"},
        {"name":"X-Echo","value":"has t0k3n inside"},{"name":"t0k3n","value":"1"}]})",
    1024, { "t0k3n" });

    const Json parsed = Json::parse (stored);
    EXPECT_EQ (parsed["headers"], Json::parse (R"([{"name":"authorization","value":"<redacted>"},
        {"name":"X-Echo","value":"has <redacted> inside"},{"name":"t0k3n","value":"1"}])"));
}

TEST (JsonTest, SerializesNoHeaderLinesAsAnEmptyArray) {
    Response response;
    response.status_code = 200;

    auto json = serialize (response);

    ASSERT_TRUE (json.contains ("headerLines"));
    EXPECT_TRUE (json["headerLines"].is_array ());
    EXPECT_TRUE (json["headerLines"].empty ());
}

// The followed redirect hops (issue #2461). Always present, an empty array
// when nothing was followed, on the `headerLines` rule above.
TEST (JsonTest, SerializesRedirectHopsWithTheirStatusAndHeaderLines) {
    Response response;
    response.status_code   = 200;
    response.redirect_hops = {
        { 302, "Found", { { "Set-Cookie", "hop=1; Path=/" }, { "Location", "/home" } } },
        { 301, "", {} }
    };

    auto json = serialize (response);

    ASSERT_TRUE (json["redirects"].is_array ());
    ASSERT_EQ (json["redirects"].size (), 2U);
    EXPECT_EQ (json["redirects"][0],
    (Json{ { "status", 302 }, { "statusText", "Found" },
    { "headerLines",
    Json::array ({ { { "name", "Set-Cookie" }, { "value", "hop=1; Path=/" } },
    { { "name", "Location" }, { "value", "/home" } } }) } }));
    EXPECT_EQ (json["redirects"][1]["status"], 301);
    EXPECT_TRUE (json["redirects"][1]["headerLines"].empty ());
}

TEST (JsonTest, SerializesNoRedirectHopsAsAnEmptyArray) {
    Response response;
    response.status_code = 200;

    auto json = serialize (response);

    ASSERT_TRUE (json.contains ("redirects"));
    EXPECT_TRUE (json["redirects"].is_array ());
    EXPECT_TRUE (json["redirects"].empty ());
}

// The live body's read cap (issue #1157). Always present, so a pane can tell
// "not capped" from "this engine cannot say" - the same rule `httpVersion`
// above is held to, and the one that decides whether a prefix is shown as the
// whole response.
TEST (JsonTest, SerializesTheBodyCapFlagOnEveryResponse) {
    Response response;
    response.status_code = 200;
    response.body        = "{}";

    auto json = serialize (response);

    ASSERT_TRUE (json.contains ("bodyCapped"));
    EXPECT_FALSE (json["bodyCapped"].get<bool> ());

    response.body_truncated = true;
    EXPECT_TRUE (serialize (response)["bodyCapped"].get<bool> ());
}

// ============================================================================
// bodyEncoding (issue #2458): a body that is not text travels as base64, and
// the key is on every answer. Mutation check: make serialize(Response) always
// take the utf8 branch and the base64 cases below red - and the strict dump
// they end with throws, which is the empty 500 the issue was filed about.
// ============================================================================

namespace {

Response response_with_body (std::string body) {
    Response response;
    response.status_code = 200;
    response.body_size   = body.size ();
    response.body        = std::move (body);
    return response;
}

} // namespace

TEST (BodyEncoding, AValidUtf8BodyTravelsAsItself) {
    const auto json =
    serialize (response_with_body ("{\"s\":\"caf\xC3\xA9\"}"));

    EXPECT_EQ (json["bodyEncoding"], "utf8");
    EXPECT_EQ (json["bodyRaw"], "{\"s\":\"caf\xC3\xA9\"}");
    EXPECT_EQ (json["body"]["s"], "caf\xC3\xA9");
}

TEST (BodyEncoding, AnEmptyBodyIsUtf8) {
    const auto json = serialize (response_with_body (""));

    EXPECT_EQ (json["bodyEncoding"], "utf8");
    EXPECT_EQ (json["bodyRaw"], "");
    EXPECT_TRUE (json["body"].is_null ());
}

TEST (BodyEncoding, AnInvalidUtf8BodyTravelsAsBase64) {
    // Valid JSON in every byte but the last two: the parse must not run on it.
    const std::string bytes = "{\"s\":\"ok\xFF\xFE\"}";
    const auto json         = serialize (response_with_body (bytes));

    EXPECT_EQ (json["bodyEncoding"], "base64");
    EXPECT_TRUE (json["body"].is_null ());
    EXPECT_EQ (json["bodySize"], bytes.size ());
    EXPECT_EQ (response_body_bytes (json), bytes);
    EXPECT_NO_THROW ((void)json.dump ());
}

TEST (BodyEncoding, ABodyCarryingNulIsBase64EvenThoughItIsValidUtf8) {
    const std::string bytes ("ab\0cd", 5);
    const auto json = serialize (response_with_body (bytes));

    EXPECT_EQ (json["bodyEncoding"], "base64");
    EXPECT_EQ (json["bodyRaw"], "YWIAY2Q=");
    EXPECT_EQ (response_body_bytes (json), bytes);
}

// Past `looks_binary`'s sniff window, on purpose: a prefix check passes this
// body and the serializer still throws on its last byte.
TEST (BodyEncoding, OneBadByteAfterALongTextPrefixIsStillBase64) {
    const std::string bytes = std::string (4096, 'a') + "\xE9";
    EXPECT_EQ (serialize (response_with_body (bytes))["bodyEncoding"], "base64");
}

// A body the read cap cut inside a character is still text, less that
// character; the same bytes uncapped are not text at all, because a body that
// arrived whole ends where its server ended it. Mutation check: drop the
// `body_truncated` branch in `response_body_text` and the capped case answers
// base64.
TEST (BodyEncoding, ACappedBodyCutInsideACharacterIsTextWithoutTheCut) {
    auto capped           = response_with_body ("{\"s\":\"caf\xC3\xA9\xE2\x82");
    capped.body_truncated = true;

    EXPECT_EQ (response_body_text (capped), "{\"s\":\"caf\xC3\xA9");
    const auto json = serialize (capped);
    EXPECT_EQ (json["bodyEncoding"], "utf8");
    EXPECT_EQ (json["bodyRaw"], "{\"s\":\"caf\xC3\xA9");
    EXPECT_EQ (json["bodySize"], capped.body.size ());
    EXPECT_TRUE (json["bodyCapped"].get<bool> ());
}

TEST (BodyEncoding, AnUncappedBodyEndingInsideACharacterIsBase64) {
    const auto uncapped = response_with_body ("ok\xE2\x82");

    EXPECT_FALSE (response_body_text (uncapped).has_value ());
    EXPECT_EQ (serialize (uncapped)["bodyEncoding"], "base64");
}

TEST (BodyEncoding, ACappedBodyWithABadByteBeforeTheCutIsBase64) {
    auto capped           = response_with_body ("ok\xFF ok\xE2\x82");
    capped.body_truncated = true;

    EXPECT_FALSE (response_body_text (capped).has_value ());
    EXPECT_EQ (response_body_bytes (serialize (capped)), capped.body);
}

TEST (BodyEncoding, AnAnswerWithNoEncodingReadsAsUtf8) {
    EXPECT_EQ (response_body_bytes (Json{ { "bodyRaw", "plain" } }), "plain");
}

TEST (BodyEncoding, AnUnknownEncodingOrBadBase64IsRefused) {
    EXPECT_FALSE (response_body_bytes (Json{ { "bodyRaw", "x" }, { "bodyEncoding", "latin1" } })
    .has_value ());
    EXPECT_FALSE (
    response_body_bytes (Json{ { "bodyRaw", "!!!" }, { "bodyEncoding", "base64" } })
    .has_value ());
}

TEST (JsonTest, SerializesError) {
    Error error;
    error.code    = ErrorCode::Timeout;
    error.message = "Request timed out after 30000ms";

    auto json = serialize (error);

    EXPECT_EQ (json["error"]["code"], "TIMEOUT");
    EXPECT_EQ (json["error"]["message"], "Request timed out after 30000ms");
}

TEST (JsonTest, ValidatesJsonStrings) {
    EXPECT_TRUE (is_valid_json (R"({"key": "value"})"));
    EXPECT_TRUE (is_valid_json (R"([1, 2, 3])"));
    EXPECT_TRUE (is_valid_json ("null"));
    EXPECT_TRUE (is_valid_json ("true"));
    EXPECT_TRUE (is_valid_json ("123"));

    EXPECT_FALSE (is_valid_json ("not json"));
    EXPECT_FALSE (is_valid_json ("{invalid}"));
    EXPECT_FALSE (is_valid_json (""));
}

TEST (JsonTest, TryParseBodyReturnsNulloptForInvalidJson) {
    EXPECT_FALSE (try_parse_body ("not json").has_value ());
    EXPECT_FALSE (try_parse_body ("").has_value ());
}

TEST (JsonTest, TryParseBodyReturnsJsonForValidInput) {
    auto result = try_parse_body (R"({"key": "value"})");

    ASSERT_HAS_VALUE (result);
    EXPECT_EQ ((*result)["key"], "value");
}

TEST (JsonTest, PrettyPrintsJson) {
    Json json = { { "name", "test" }, { "value", 42 } };

    std::string output = pretty_print (json, false);

    EXPECT_TRUE (output.find ("\"name\"") != std::string::npos);
    EXPECT_TRUE (output.find ("\"test\"") != std::string::npos);
    EXPECT_TRUE (output.find ("42") != std::string::npos);
}

TEST (JsonTest, HandlesAllHttpMethods) {
    std::vector<std::pair<std::string, HttpMethod>> methods = { { "GET", HttpMethod::GET },
        { "POST", HttpMethod::POST }, { "PUT", HttpMethod::PUT },
        { "DELETE", HttpMethod::DELETE }, { "PATCH", HttpMethod::PATCH },
        { "HEAD", HttpMethod::HEAD }, { "OPTIONS", HttpMethod::OPTIONS } };

    for (const auto& [method_str, method_enum] : methods) {
        std::string json_str =
        R"({"method": ")" + method_str + R"(", "url": "https://example.com"})";
        auto result = deserialize_request (json_str);

        ASSERT_TRUE (result.is_ok ()) << "Failed for method: " << method_str;
        EXPECT_EQ (result.value ().method, method_enum);
    }
}

struct HttpVersionParseCase {
    const char* name;
    const char* json;
    vayu::HttpVersion expected;
};

constexpr auto HTTP_VERSION_PARSE_CASES = std::to_array<HttpVersionParseCase> ({
{ "ParsesAStoredValue", R"({"method":"GET","url":"https://x/y","httpVersion":"http2"})",
vayu::HttpVersion::Http2 },
{ "DefaultsWhenAbsent", R"({"method":"GET","url":"https://x/y"})", vayu::DEFAULT_HTTP_VERSION },
// A corrupted or downgraded row must not execute as something arbitrary.
{ "CoercesAGarbageStoredValueToAuto",
R"({"method":"GET","url":"https://x/y","httpVersion":"quic"})", vayu::HttpVersion::Auto },
});

class JsonRequestHttpVersion : public ::testing::TestWithParam<HttpVersionParseCase> {};

TEST_P (JsonRequestHttpVersion, DeserializesTheExpectedVersion) {
    const auto& c = GetParam ();
    auto json     = nlohmann::json::parse (c.json);
    auto result   = vayu::json::deserialize_request (json);
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().http_version, c.expected);
}

INSTANTIATE_TEST_SUITE_P (JsonRequest,
JsonRequestHttpVersion,
::testing::ValuesIn (HTTP_VERSION_PARSE_CASES),
[] (const ::testing::TestParamInfo<HttpVersionParseCase>& info) {
    return std::string (info.param.name);
});

TEST (JsonRequest, SerializesHttpVersion) {
    vayu::Request req;
    req.method       = vayu::HttpMethod::GET;
    req.url          = "https://x/y";
    req.http_version = vayu::HttpVersion::Http1_1;
    EXPECT_EQ (vayu::json::serialize (req)["httpVersion"], "http1.1");
}

// GET /runs/:id: the full configSnapshot, nested keys included, and no
// `summary` (the list row's compact stand-in for it).
TEST (JsonTest, SerializesRun) {
    vayu::db::Run run;
    run.id              = "run_123";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = 1000;
    run.end_time        = 2000;
    run.config_snapshot = R"({"rps": 100, "headers": {"X": "1"}})";
    run.request_id      = "req_1";
    run.environment_id  = "env_1";

    auto json = serialize (run);

    EXPECT_EQ (json["id"], "run_123");
    EXPECT_EQ (json["type"], "load");
    EXPECT_EQ (json["status"], "running");
    EXPECT_EQ (json["startTime"], 1000);
    EXPECT_EQ (json["endTime"], 2000);
    EXPECT_EQ (json["configSnapshot"]["rps"], 100);
    EXPECT_EQ (json["configSnapshot"]["headers"]["X"], "1");
    EXPECT_FALSE (json.contains ("summary"));
    EXPECT_EQ (json["requestId"], "req_1");
    EXPECT_EQ (json["environmentId"], "env_1");
}

// ============================================================================
// serialize_to_stream - the list route's field cap (issue #1485)
//
// GET /requests substitutes a default for a stored column over
// `json::MAX_FIELD_SIZE` (write_json_column), because one unreadable row must
// not fail the whole page. Before this fix that substitution was silent -
// indistinguishable from a genuinely empty field - so a caller that trusted
// the list (Duplicate, an MCP agent copying `list_requests` verbatim) could
// write the fallback back as if it were real. `truncatedFields` names which
// columns were substituted, absent when none were.
// ============================================================================

TEST (JsonRequestListSerializer, MarksAnOversizedColumnTruncatedInsteadOfSubstitutingSilently) {
    vayu::db::Request r;
    r.id            = "req_1";
    r.collection_id = "col_1";
    r.name          = "R";
    r.method        = vayu::HttpMethod::GET;
    r.url           = "https://example.test";
    r.params        = "[]";
    r.headers       = "[]";
    // Content need not be valid JSON: the cap is checked on the stored
    // column's byte length before any parse is attempted.
    r.body = std::string (vayu::core::constants::json::MAX_FIELD_SIZE + 1, 'a');
    r.auth = R"({"mode":"inherit"})";

    std::ostringstream out;
    serialize_to_stream (r, out, vayu::http::FileAccessPolicy{});
    const auto parsed = nlohmann::json::parse (out.str ());

    EXPECT_EQ (parsed["body"], nlohmann::json::parse (R"({"mode":"none"})"))
    << "an oversized column still falls back, exactly like before this fix";
    ASSERT_TRUE (parsed.contains ("truncatedFields"));
    EXPECT_EQ (parsed["truncatedFields"], nlohmann::json::array ({ "body" }));
}

TEST (JsonRequestListSerializer, OmitsTruncatedFieldsWhenEveryColumnFitsTheCap) {
    vayu::db::Request r;
    r.id            = "req_1";
    r.collection_id = "col_1";
    r.name          = "R";
    r.method        = vayu::HttpMethod::GET;
    r.url           = "https://example.test";
    r.params        = "[]";
    r.headers       = "[]";
    r.body          = R"({"mode":"none"})";
    r.auth          = R"({"mode":"inherit"})";

    std::ostringstream out;
    serialize_to_stream (r, out, vayu::http::FileAccessPolicy{});
    const auto parsed = nlohmann::json::parse (out.str ());

    EXPECT_FALSE (parsed.contains ("truncatedFields"))
    << "absent, not an empty array, when nothing was substituted";
}

// ============================================================================
// cap_trace_bodies - body caps + truncation metadata
//
// The full trace is built by build_result_trace (execution.cpp, pinned by
// execution_trace_test.cpp); cap_trace_bodies is the storage-size guard applied
// on top of it, so these tests exercise it on trace literals of that shape.
// ============================================================================

namespace {

nlohmann::json make_trace (const std::string& request_body, const std::string& response_body) {
    return nlohmann::json{
        { "request",
        { { "method", "POST" }, { "url", "http://example.test/" },
        { "headers", nlohmann::json::object () }, { "body", request_body } } },
        { "response", { { "headers", nlohmann::json::object () }, { "body", response_body } } }
    };
}

} // namespace

TEST (CapTraceBodies, TruncatesOversizedBodiesAndRecordsMetadata) {
    const size_t cap = 8;
    auto trace = make_trace ("REQUESTBODY", "RESPONSEBODY"); // 11 / 12 bytes

    cap_trace_bodies (trace, cap);

    // Response body: stored slice is exactly the cap, metadata reflects the original.
    ASSERT_TRUE (trace["response"].contains ("body"));
    EXPECT_EQ (trace["response"]["body"].get<std::string> ().size (), cap);
    EXPECT_EQ (trace["response"]["body"], "RESPONSE");
    EXPECT_TRUE (trace["response"]["bodyTruncated"].get<bool> ());
    EXPECT_EQ (trace["response"]["bodyBytes"].get<size_t> (), 12u);

    // Request body is capped the same way.
    EXPECT_EQ (trace["request"]["body"].get<std::string> ().size (), cap);
    EXPECT_EQ (trace["request"]["body"], "REQUESTB");
    EXPECT_TRUE (trace["request"]["bodyTruncated"].get<bool> ());
    EXPECT_EQ (trace["request"]["bodyBytes"].get<size_t> (), 11u);
}

TEST (CapTraceBodies, LeavesUnderCapBodiesVerbatimWithoutMetadata) {
    auto trace = make_trace ("small-request", "small-response");

    cap_trace_bodies (trace, 1024);

    EXPECT_EQ (trace["response"]["body"], "small-response");
    EXPECT_FALSE (trace["response"].contains ("bodyTruncated"));
    EXPECT_FALSE (trace["response"].contains ("bodyBytes"));

    EXPECT_EQ (trace["request"]["body"], "small-request");
    EXPECT_FALSE (trace["request"].contains ("bodyTruncated"));
    EXPECT_FALSE (trace["request"].contains ("bodyBytes"));
}

// Issue #1765: a per-send opt-out of the engine's own `User-Agent` is the
// whole point of the list, and it used to be a 400 because the reader
// validated names with the correlation-id rule (`unusable_header_name`), which
// refuses the headers the engine derives. Mutation check: put
// `unusable_header_name` back in `read_default_header_opt_outs` and the first
// assertion reds.
TEST (JsonTest, ADefaultHeaderOptOutMayNameTheHeadersTheEngineDerives) {
    auto result = deserialize_request (std::string (R"({
        "method": "POST",
        "url": "https://example.com/",
        "disabledDefaultHeaders": ["User-Agent", "Accept-Encoding", "Content-Type"]
    })"));
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    const auto& suppressed = result.value ().suppressed_default_headers;
    EXPECT_TRUE (suppressed.contains ("user-agent"));
    EXPECT_TRUE (suppressed.contains ("accept-encoding"));
    EXPECT_TRUE (suppressed.contains ("content-type"));

    // The token rule still holds.
    EXPECT_TRUE (deserialize_request (
    std::string (R"({"method":"GET","url":"https://e/","disabledDefaultHeaders":["User Agent"]})"))
    .is_error ());
}

// The stored `disabledSystemHeaders` and the per-send `disabledDefaultHeaders`
// land in one set (issue #1765), and the two protocol flags parse. Mutation
// check: drop the `read_disabled_system_headers` call in `deserialize_request`
// and the union assertions red.
TEST (JsonTest, TheStoredSystemHeaderOptOutsJoinThePerSendOnes) {
    auto result = deserialize_request (std::string (R"({
        "method": "GET",
        "url": "https://example.com/",
        "disabledDefaultHeaders": ["X-Vayu-Request-Id"],
        "disabledSystemHeaders": ["user-agent", "accept"],
        "disableCookies": true,
        "disableUrlEncoding": true
    })"));
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    const auto& request = result.value ();
    EXPECT_TRUE (request.suppressed_default_headers.contains ("User-Agent"));
    EXPECT_TRUE (request.suppressed_default_headers.contains ("Accept"));
    EXPECT_TRUE (
    request.suppressed_default_headers.contains ("x-vayu-request-id"));
    EXPECT_TRUE (request.disable_cookies);
    EXPECT_TRUE (request.disable_url_encoding);

    const auto defaults = deserialize_request (
    std::string (R"({"method":"GET","url":"https://example.com/"})"));
    ASSERT_TRUE (defaults.is_ok ());
    EXPECT_FALSE (defaults.value ().disable_cookies);
    EXPECT_FALSE (defaults.value ().disable_url_encoding);

    EXPECT_TRUE (deserialize_request (
    std::string (R"({"method":"GET","url":"https://e/","disabledSystemHeaders":"user-agent"})"))
    .is_error ());
    EXPECT_TRUE (deserialize_request (
    std::string (R"({"method":"GET","url":"https://e/","disabledSystemHeaders":["a b"]})"))
    .is_error ());
}

TEST (CapTraceBodies, InvalidUtf8SliceDumpsWithReplacement) {
    // A cap that splits a multi-byte UTF-8 sequence must not make dump() throw.
    // "abc" + a 2-byte sequence (0xC3 0xA9 = e-acute); cap 4 keeps the lead byte only.
    auto trace = make_trace ("x", std::string ("abc\xC3\xA9"));

    cap_trace_bodies (trace, 4);

    EXPECT_TRUE (trace["response"]["bodyTruncated"].get<bool> ());
    EXPECT_NO_THROW (
    (void)trace.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace));
}

// A base64 body (issue #2458) is capped by what it decodes to, on a three-byte
// boundary so the stored slice still decodes, and `bodyBytes` counts decoded
// bytes as it does for text. Mutation check: drop the `bodyEncoding` branch in
// `cap_node_body` and the slice is cut mid-group (8 characters of text) and
// `bodyBytes` reports the encoded length.
TEST (CapTraceBodies, ABase64BodyIsCutOnAWholeGroupOfDecodedBytes) {
    const std::string bytes ("\x89PNG\r\n\x1A\n\x00\x01\x02\x03\xFF", 13);
    auto trace = make_trace ("x", vayu::utils::base64_encode (bytes));
    trace["response"]["bodyEncoding"] = "base64";

    cap_trace_bodies (trace, 8);

    const auto& node = trace["response"];
    EXPECT_TRUE (node["bodyTruncated"].get<bool> ());
    EXPECT_EQ (node["bodyBytes"].get<size_t> (), 13u);
    const auto kept = vayu::utils::base64_decode (node["body"].get<std::string> ());
    ASSERT_HAS_VALUE (kept);
    EXPECT_EQ (*kept, bytes.substr (0, 6));
}

TEST (CapTraceBodies, ABase64BodyUnderTheCapIsLeftWhole) {
    const std::string encoded = vayu::utils::base64_encode ("\xFF\xFE\xFD\xFC");
    auto trace                = make_trace ("x", encoded);
    trace["response"]["bodyEncoding"] = "base64";

    // Four decoded bytes under a cap of four, though the text is eight long.
    cap_trace_bodies (trace, 4);

    EXPECT_EQ (trace["response"]["body"], encoded);
    EXPECT_FALSE (trace["response"].contains ("bodyTruncated"));
}

// ============================================================================
// cap_trace_bodies - rawRequest (issue #348)
//
// The stored wire message ends with the same body the node's `body` field
// carries, so without a cap of its own the field added last would carry a whole
// oversized POST into trace_data and route around the guard entirely.
// ============================================================================

namespace {

// A wire message as `raw_request_from_wire` builds it: header block, blank
// line, body.
std::string make_raw_request (const std::string& body) {
    return "POST / HTTP/1.1\r\nHost: example.test\r\nCookie: "
           "session=abc\r\n\r\n" +
    body;
}

} // namespace

TEST (CapTraceBodies, CapsTheRawRequestBodyAndKeepsTheHeaderBlockWhole) {
    // A cap far smaller than the header block: the headers are the reason the
    // field is stored, so the cut is body-side only. Cutting from the front
    // would take the Cookie line - exactly what a reader opened the tab for.
    const size_t cap               = 4;
    auto trace                     = make_trace ("REQUESTBODY", "RESPONSEBODY");
    trace["request"]["rawRequest"] = make_raw_request ("REQUESTBODY");

    cap_trace_bodies (trace, cap);

    const auto raw = trace["request"]["rawRequest"].get<std::string> ();
    EXPECT_EQ (raw, make_raw_request ("REQU"));
    EXPECT_NE (raw.find ("Cookie: session=abc"), std::string::npos);
    // The node's own body is capped by the same limit, and its metadata is what
    // tells a reader this request's body is a stored slice.
    EXPECT_TRUE (trace["request"]["bodyTruncated"].get<bool> ());
}

TEST (CapTraceBodies, LeavesAnUnderCapRawRequestVerbatim) {
    auto trace = make_trace ("small-request", "small-response");
    trace["request"]["rawRequest"] = make_raw_request ("small-request");

    cap_trace_bodies (trace, 1024);

    EXPECT_EQ (trace["request"]["rawRequest"], make_raw_request ("small-request"));
}

// A GET's wire message is a header block and an empty body; a synthesized one
// for a transfer that never connected may carry no blank line at all. Neither
// has a body to cap, and neither may lose a byte.
TEST (CapTraceBodies, LeavesABodylessRawRequestAlone) {
    auto trace                     = make_trace ("", "");
    trace["request"]["rawRequest"] = make_raw_request ("");

    cap_trace_bodies (trace, 1);
    EXPECT_EQ (trace["request"]["rawRequest"], make_raw_request (""));

    trace["request"]["rawRequest"] = "GET / HTTP/1.1\r\nHost: example.test";
    cap_trace_bodies (trace, 1);
    EXPECT_EQ (trace["request"]["rawRequest"], "GET / HTTP/1.1\r\nHost: example.test");
}

TEST (CapTraceBodies, IgnoresAnErrorTraceWithNoResponseBody) {
    // An error trace carries error_type/error_message and no response node - the
    // cap must leave it untouched rather than fabricate a body.
    nlohmann::json trace{ { "request",
                          { { "method", "GET" }, { "url", "http://x/" },
                          { "headers", nlohmann::json::object () } } },
        { "error_type", "CONNECTION_FAILED" }, { "error_message", "could not connect" } };

    EXPECT_NO_THROW (cap_trace_bodies (trace, 4));
    EXPECT_FALSE (trace.contains ("response"));
    EXPECT_FALSE (trace["request"].contains ("bodyTruncated"));
    EXPECT_EQ (trace["error_type"], "CONNECTION_FAILED");
}

// --- exceeds_depth (#2362) ----------------------------------------------------

// A scalar is depth 0 and a container is 1 plus its deepest child, so the bound
// is met by a value exactly that deep and passed by one level more. Move the
// comparison to `>=` and the first pair below swaps answers.
TEST (ExceedsDepth, AValueExactlyAtTheBoundIsWithinItAndOneMoreIsNot) {
    for (const std::size_t depth : { 1U, 2U, 5U, 100U }) {
        EXPECT_FALSE (exceeds_depth (vayu::tests::nested_array (depth), depth)) << depth;
        EXPECT_TRUE (exceeds_depth (vayu::tests::nested_array (depth + 1), depth)) << depth;
    }
}

TEST (ExceedsDepth, AScalarIsDepthZeroWhateverItsType) {
    for (const auto& scalar : { nlohmann::json (nullptr), nlohmann::json (true),
         nlohmann::json (7), nlohmann::json (1.5), nlohmann::json ("text") }) {
        EXPECT_FALSE (exceeds_depth (scalar, 0)) << scalar.dump ();
    }
}

TEST (ExceedsDepth, AnEmptyContainerIsDepthOne) {
    for (const auto& empty : { nlohmann::json::array (), nlohmann::json::object () }) {
        EXPECT_FALSE (exceeds_depth (empty, 1)) << empty.dump ();
        EXPECT_TRUE (exceeds_depth (empty, 0)) << empty.dump ();
    }
}

// Objects count as a level exactly as arrays do, and mixing them adds up.
TEST (ExceedsDepth, ObjectsAndArraysBothCountAsALevel) {
    const nlohmann::json mixed = { { "a", nlohmann::json::array ({ { { "b", 1 } } }) } };
    EXPECT_FALSE (exceeds_depth (mixed, 3));
    EXPECT_TRUE (exceeds_depth (mixed, 2));
}

// Depth is the deepest branch, not the widest level or the longest sibling run:
// a hundred thousand shallow siblings are no deeper than one.
TEST (ExceedsDepth, WideIsNotDeep) {
    nlohmann::json wide = nlohmann::json::array ();
    for (int i = 0; i < 100000; ++i) {
        wide.push_back (i);
    }
    EXPECT_FALSE (exceeds_depth (wide, 1));

    nlohmann::json fan = nlohmann::json::object ();
    for (int i = 0; i < 1000; ++i) {
        fan[std::to_string (i)] = vayu::tests::nested_array (3);
    }
    EXPECT_FALSE (exceeds_depth (fan, 4));
    EXPECT_TRUE (exceeds_depth (fan, 3));
}

// The deepest branch is found wherever it sits among shallower ones.
TEST (ExceedsDepth, TheDeepBranchIsFoundAmongShallowSiblings) {
    nlohmann::json row = { { "first", 1 }, { "last", 2 } };
    row["middle"]      = vayu::tests::nested_array (10);
    EXPECT_TRUE (exceeds_depth (row, 10));
    EXPECT_FALSE (exceeds_depth (row, 11));
}

// The reason the probe exists: a value `dump ()` and a copy cannot survive. A
// recursive probe would overflow the stack here; neither the value nor its
// answer is ever streamed.
TEST (ExceedsDepth, AValueFarPastAnyStackAnswersWithoutRecursing) {
    const auto deep = vayu::tests::nested_array (100000);
    EXPECT_TRUE (exceeds_depth (deep, 100));
    EXPECT_TRUE (exceeds_depth (deep, 99999));
    EXPECT_FALSE (exceeds_depth (deep, 100000));
}

} // namespace
} // namespace vayu::json
