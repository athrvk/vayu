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

    auto json = serialize (response);

    EXPECT_EQ (json["status"], 200);
    EXPECT_EQ (json["statusText"], "OK");
    EXPECT_EQ (json["headers"]["content-type"], "application/json");
    EXPECT_EQ (json["body"]["success"], true); // Parsed as JSON
    EXPECT_DOUBLE_EQ (json["timing"]["total"], 123.45);
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

TEST (JsonTest, SerializesMetric) {
    vayu::db::Metric metric;
    metric.id        = 1;
    metric.run_id    = "run_123";
    metric.timestamp = 1000;
    metric.name      = vayu::MetricName::Rps;
    metric.value     = 50.5;
    metric.labels    = R"({"region": "us-east-1"})";

    auto json = serialize (metric);

    EXPECT_EQ (json["id"], 1);
    EXPECT_EQ (json["runId"], "run_123");
    EXPECT_EQ (json["timestamp"], 1000);
    EXPECT_EQ (json["name"], "rps");
    EXPECT_EQ (json["value"], 50.5);
    EXPECT_EQ (json["labels"]["region"], "us-east-1");
}

// ============================================================================
// build_design_trace - body caps + truncation metadata
// ============================================================================

namespace {

vayu::Request make_trace_request (const std::string& body) {
    vayu::Request req;
    req.method            = vayu::HttpMethod::POST;
    req.url               = "http://example.test/";
    req.headers["Accept"] = "application/json";
    req.body.mode         = vayu::BodyMode::Text;
    req.body.content      = body;
    return req;
}

vayu::Response make_trace_response (const std::string& body) {
    vayu::Response resp;
    resp.status_code = 200;
    resp.status_text = "OK";
    resp.body        = body;
    return resp;
}

} // namespace

TEST (BuildDesignTrace, TruncatesOversizedBodiesAndRecordsMetadata) {
    const size_t cap = 8;
    // Both bodies exceed the cap.
    auto req  = make_trace_request ("REQUESTBODY");   // 11 bytes
    auto resp = make_trace_response ("RESPONSEBODY"); // 12 bytes

    auto trace = build_design_trace (req, resp, cap);

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

TEST (BuildDesignTrace, StoresUnderCapBodyVerbatimWithoutMetadata) {
    const size_t cap = 1024;
    auto req  = make_trace_request ("small-request");
    auto resp = make_trace_response ("small-response");

    auto trace = build_design_trace (req, resp, cap);

    EXPECT_EQ (trace["response"]["body"], "small-response");
    EXPECT_FALSE (trace["response"].contains ("bodyTruncated"));
    EXPECT_FALSE (trace["response"].contains ("bodyBytes"));

    EXPECT_EQ (trace["request"]["body"], "small-request");
    EXPECT_FALSE (trace["request"].contains ("bodyTruncated"));
    EXPECT_FALSE (trace["request"].contains ("bodyBytes"));
}

TEST (BuildDesignTrace, InvalidUtf8SliceDumpsWithReplacement) {
    // A cap that splits a multi-byte UTF-8 sequence must not make dump() throw.
    const size_t cap = 4;
    // "abc" + a 2-byte sequence (0xC3 0xA9 = e-acute); cap 4 keeps the lead byte only.
    auto resp  = make_trace_response (std::string ("abc\xC3\xA9"));
    auto req   = make_trace_request ("x");
    auto trace = build_design_trace (req, resp, cap);

    EXPECT_TRUE (trace["response"]["bodyTruncated"].get<bool> ());
    EXPECT_NO_THROW (
    (void)trace.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace));
}

TEST (BuildDesignTrace, ErrorResponseWritesEnvelopeNotBody) {
    auto req         = make_trace_request ("x");
    vayu::Response resp;
    resp.status_code    = 0;
    resp.error_code     = vayu::ErrorCode::ConnectionFailed;
    resp.error_message  = "could not connect";
    auto trace = build_design_trace (req, resp, 1024);

    EXPECT_FALSE (trace.contains ("response"));
    EXPECT_EQ (trace["error_type"], "CONNECTION_FAILED");
    EXPECT_EQ (trace["error_message"], "could not connect");
}

} // namespace
} // namespace vayu::json
