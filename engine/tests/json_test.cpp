/**
 * @file tests/json_test.cpp
 * @brief Tests for JSON utilities
 */

#include "vayu/utils/json.hpp"

#include <gtest/gtest.h>

#include "vayu/db/database.hpp"

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

    ASSERT_TRUE (result.has_value ());
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

TEST (JsonRequest, ParsesHttpVersion) {
    auto json = nlohmann::json::parse (
    R"({"method":"GET","url":"https://x/y","httpVersion":"http2"})");
    auto result = vayu::json::deserialize_request (json);
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().http_version, vayu::HttpVersion::Http2);
}

TEST (JsonRequest, DefaultsHttpVersionWhenAbsent) {
    auto json = nlohmann::json::parse (R"({"method":"GET","url":"https://x/y"})");
    auto result = vayu::json::deserialize_request (json);
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().http_version, vayu::DEFAULT_HTTP_VERSION);
}

TEST (JsonRequest, CoercesAGarbageStoredValueToAuto) {
    // A corrupted or downgraded row must not execute as something arbitrary.
    auto json = nlohmann::json::parse (
    R"({"method":"GET","url":"https://x/y","httpVersion":"quic"})");
    auto result = vayu::json::deserialize_request (json);
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().http_version, vayu::HttpVersion::Auto);
}

TEST (JsonRequest, SerializesHttpVersion) {
    vayu::Request req;
    req.method       = vayu::HttpMethod::GET;
    req.url          = "https://x/y";
    req.http_version = vayu::HttpVersion::Http1_1;
    EXPECT_EQ (vayu::json::serialize (req)["httpVersion"], "http1.1");
}

TEST (JsonTest, SerializesRun) {
    vayu::db::Run run;
    run.id              = "run_123";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = 1000;
    run.end_time        = 2000;
    run.config_snapshot = R"({"rps": 100})";
    run.request_id      = "req_1";
    run.environment_id  = "env_1";

    auto json = serialize (run);

    EXPECT_EQ (json["id"], "run_123");
    EXPECT_EQ (json["type"], "load");
    EXPECT_EQ (json["status"], "running");
    EXPECT_EQ (json["startTime"], 1000);
    EXPECT_EQ (json["endTime"], 2000);
    EXPECT_EQ (json["configSnapshot"]["rps"], 100);
    EXPECT_EQ (json["requestId"], "req_1");
    EXPECT_EQ (json["environmentId"], "env_1");
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
        { "response",
        { { "headers", nlohmann::json::object () }, { "body", response_body } } }
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

TEST (CapTraceBodies, InvalidUtf8SliceDumpsWithReplacement) {
    // A cap that splits a multi-byte UTF-8 sequence must not make dump() throw.
    // "abc" + a 2-byte sequence (0xC3 0xA9 = e-acute); cap 4 keeps the lead byte only.
    auto trace = make_trace ("x", std::string ("abc\xC3\xA9"));

    cap_trace_bodies (trace, 4);

    EXPECT_TRUE (trace["response"]["bodyTruncated"].get<bool> ());
    EXPECT_NO_THROW (
    (void)trace.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace));
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
        { "error_type", "CONNECTION_FAILED" },
        { "error_message", "could not connect" } };

    EXPECT_NO_THROW (cap_trace_bodies (trace, 4));
    EXPECT_FALSE (trace.contains ("response"));
    EXPECT_FALSE (trace["request"].contains ("bodyTruncated"));
    EXPECT_EQ (trace["error_type"], "CONNECTION_FAILED");
}

} // namespace
} // namespace vayu::json
