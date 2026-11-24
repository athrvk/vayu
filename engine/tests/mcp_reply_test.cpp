/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file mcp_reply_test.cpp
 * @brief The MCP reply reader (#3762): an `mcp` reply's final response, read
 *        by the elements on every path, and the failure classes it carries.
 *
 * The integration cases run against `McpFixtureServer`, which answers with one
 * JSON object or with an event stream of two progress notifications and then
 * the response, so a path that hands its elements the raw body reads an event
 * stream where a JSON-RPC response should be.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <httplib.h>

#include "mcp_fixture_server.hpp"
#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/core/mcp_error_counts.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/mcp_body.hpp"
#include "vayu/http/mcp_reply.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/json.hpp"
#include "wait_until.hpp"
#include "wide_json.hpp"

namespace vayu::http {
namespace {

using nlohmann::json;
using vayu::tests::McpFixtureServer;
using vayu::tests::McpReplyOutcome;
using vayu::tests::McpReplyShape;

const char* const kToolsCall =
R"({"method":"tools/call","params":{"name":"execute_sql","arguments":{"region":"us-west1","query":"SELECT 1"}}})";

const char* const kResultFrame =
R"({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"42 rows"}],"isError":false}})";

Request mcp_request (const std::string& content = kToolsCall) {
    Request request;
    request.method       = HttpMethod::POST;
    request.url          = "http://127.0.0.1:1/mcp";
    request.body.mode    = BodyMode::Mcp;
    request.body.content = content;
    return request;
}

Response reply (int status, const std::string& content_type, std::string body) {
    Response response;
    response.status_code = status;
    if (!content_type.empty ()) {
        response.headers["content-type"] = content_type;
    }
    response.body      = std::move (body);
    response.body_size = response.body.size ();
    return response;
}

std::string event (const std::string& data) {
    return "event: message\ndata: " + data + "\n\n";
}

const std::string& progress () {
    static const std::string note = event (
    R"({"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"p","progress":1}})");
    return note;
}

/// The element that proves a path read the final response: the tool's text
/// at `$.result.content[0].text`, which an event stream's raw bytes are not.
json text_assertion () {
    return json{ { "id", "el_text" }, { "kind", "assert.jsonpath" }, { "enabled", true },
        { "config", { { "path", "$.result.content[0].text" }, { "expected", "42 rows" } } } };
}

json text_extractor () {
    return vayu::tests::extract_json_element_json (
    "el_extract", "$.result.content[0].text", "answer");
}

/// A stored-request payload as `POST /execute` and `POST /runs` read one.
json mcp_payload (const McpFixtureServer& server) {
    return json{ { "method", "POST" }, { "url", server.url () }, { "timeout", 5000 },
        { "body",
        { { "mode", "mcp" }, { "content", kToolsCall },
        { "mcpTool", vayu::tests::execute_sql_tool_json () } } } };
}

// ---------------------------------------------------------------------------
// The reader, on responses built by hand.
// ---------------------------------------------------------------------------

TEST (McpReplyReader, AJsonReplysFinalResponseIsItsBody) {
    const auto read =
    read_mcp_reply (mcp_request (), reply (200, "application/json", kResultFrame));
    EXPECT_EQ (read.response, kResultFrame);
    EXPECT_FALSE (read.error_class.has_value ()) << read.message;
}

// The last `message` event that is a response to the request's id; the
// notifications around it, a response to another id and a request the server
// makes of the client under the same id are not. Mutation check: drop the
// `result`/`error` test in `McpReplyStream::observe` and the server's request,
// sent after the response, is read as the answer.
TEST (McpReplyReader, AnEventStreamsFinalResponseIsTheLastResponseToTheRequestsId) {
    const std::string body = progress () +
    event (R"({"jsonrpc":"2.0","id":7,"result":{"content":[]}})") + event (kResultFrame) +
    event (R"({"jsonrpc":"2.0","id":1,"method":"sampling/createMessage","params":{}})") +
    progress ();
    const auto read =
    read_mcp_reply (mcp_request (), reply (200, "text/event-stream", body));
    EXPECT_EQ (read.response, kResultFrame);
    EXPECT_FALSE (read.error_class.has_value ()) << read.message;
}

TEST (McpReplyReader, AnEnvelopesOwnIdIsTheOneMatched) {
    const auto request = mcp_request (
    R"({"jsonrpc":"2.0","id":"call-9","method":"tools/call","params":{"name":"execute_sql"}})");
    const std::string frame = R"({"jsonrpc":"2.0","id":"call-9","result":{"content":[]}})";
    const auto read = read_mcp_reply (request,
    reply (200, "text/event-stream", event (kResultFrame) + event (frame)));
    EXPECT_EQ (read.response, frame);
}

TEST (McpReplyReader, AStreamCutBeforeTheResponseIsTransport) {
    const auto read = read_mcp_reply (
    mcp_request (), reply (200, "text/event-stream", progress () + progress ()));
    EXPECT_EQ (read.error_class, McpErrorClass::Transport);
    EXPECT_TRUE (read.response.empty ());
    EXPECT_NE (read.message.find ("ended before the final response"), std::string::npos)
    << read.message;
}

TEST (McpReplyReader, AJsonRpcErrorIsProtocolWhateverTheStatus) {
    for (const int status : { 200, 400 }) {
        const auto read = read_mcp_reply (mcp_request (),
        reply (status, "application/json",
        R"({"jsonrpc":"2.0","id":1,"error":{"code":-32020,"message":"Header mismatch"}})"));
        EXPECT_EQ (read.error_class, McpErrorClass::Protocol) << status;
        EXPECT_EQ (read.code, -32020) << status;
        EXPECT_EQ (read.message, "JSON-RPC error -32020: Header mismatch") << status;
    }
}

// Mutation check: drop the `isError` test in `judge_final_response` and the
// reply reads as a success.
TEST (McpReplyReader, AToolResultMarkedIsErrorIsTool) {
    const auto read = read_mcp_reply (mcp_request (),
    reply (200, "application/json",
    R"({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"no such table"}],"isError":true}})"));
    EXPECT_EQ (read.error_class, McpErrorClass::Tool);
    EXPECT_FALSE (read.code.has_value ());
    EXPECT_EQ (read.message, "the tool reported an error: no such table");
}

TEST (McpReplyReader, AVersionRefusalNamesTheVersionsOnBothSides) {
    const auto read = read_mcp_reply (mcp_request (),
    reply (400, "application/json",
    R"({"jsonrpc":"2.0","id":1,"error":{"code":-32022,"message":"Unsupported protocol version",)"
    R"("data":{"supported":["2025-11-25","2025-06-18"],"requested":"2026-07-28"}}})"));
    EXPECT_EQ (read.error_class, McpErrorClass::Protocol);
    EXPECT_EQ (read.code, -32022);
    EXPECT_EQ (read.message, "server supports 2025-11-25, 2025-06-18; this request is 2026-07-28");
}

TEST (McpReplyReader, APlain400NamesALegacyEraServer) {
    for (const auto& [type, body] : { std::pair{ "text/plain", "Bad Request" },
         std::pair{ "application/json", R"({"detail":"missing session"})" } }) {
        const auto read = read_mcp_reply (mcp_request (), reply (400, type, body));
        EXPECT_EQ (read.error_class, McpErrorClass::Transport) << body;
        EXPECT_NE (read.message.find ("legacy-era"), std::string::npos) << read.message;
        EXPECT_NE (read.message.find ("initialize"), std::string::npos) << read.message;
    }
}

TEST (McpReplyReader, AnyOtherStatusWithoutAJsonRpcErrorIsTransport) {
    const auto read =
    read_mcp_reply (mcp_request (), reply (502, "text/html", "<h1>Bad gateway</h1>"));
    EXPECT_EQ (read.error_class, McpErrorClass::Transport);
    EXPECT_EQ (read.message, "HTTP 502 with no JSON-RPC response");
}

TEST (McpReplyReader, AFailedTransferIsTransportInItsOwnWords) {
    Response failed;
    failed.error_code    = ErrorCode::ConnectionFailed;
    failed.error_message = "Connection refused";
    const auto read      = read_mcp_reply (mcp_request (), failed);
    EXPECT_EQ (read.error_class, McpErrorClass::Transport);
    EXPECT_EQ (read.message, "Connection refused");
}

TEST (McpReplyReader, ANotificationExpectsNoResponse) {
    const auto request =
    mcp_request (R"({"jsonrpc":"2.0","method":"notifications/initialized"})");
    EXPECT_FALSE (mcp_request_id (request).has_value ());
    const auto read = read_mcp_reply (request, reply (202, "", ""));
    EXPECT_FALSE (read.error_class.has_value ()) << read.message;
}

TEST (McpReplyReader, A2xxThatIsNotAJsonRpcResponseIsTransport) {
    const auto read = read_mcp_reply (
    mcp_request (), reply (200, "application/json", R"({"ok":true})"));
    EXPECT_EQ (read.error_class, McpErrorClass::Transport);
    EXPECT_TRUE (read.response.empty ());
}

// The consumer that keeps no stream bytes hands the reader its events.
TEST (McpReplyReader, ALiveStreamsEventsAreReadInPlaceOfTheBody) {
    McpReplyStream live (mcp_request_id (mcp_request ()));
    SseParser parser (1024);
    for (const auto& parsed : parser.feed (progress () + event (kResultFrame))) {
        live.observe (parsed);
    }
    const auto read =
    read_mcp_reply (mcp_request (), reply (200, "text/event-stream", ""), &live);
    EXPECT_EQ (read.response, kResultFrame);
    EXPECT_FALSE (read.error_class.has_value ()) << read.message;
}

TEST (McpReplyReader, AnEventCutAtTheByteCapIsNamed) {
    McpReplyStream live (mcp_request_id (mcp_request ()));
    SseParser parser (16);
    for (const auto& parsed : parser.feed (event (kResultFrame))) {
        live.observe (parsed);
    }
    const auto read =
    read_mcp_reply (mcp_request (), reply (200, "text/event-stream", ""), &live);
    EXPECT_EQ (read.error_class, McpErrorClass::Transport);
    EXPECT_NE (read.message.find ("sseMaxEventBytes"), std::string::npos)
    << read.message;
}

TEST (McpReplyReader, OnlyAnMcpRequestIsRead) {
    auto request      = mcp_request ();
    request.body.mode = BodyMode::JsonRpc;
    auto response     = reply (200, "application/json", kResultFrame);
    attach_mcp_reply (request, response);
    EXPECT_FALSE (response.mcp_reply.has_value ());
}

// The elements read a copy whose body is the final response; the response
// itself, which scripts and the trace read, keeps the raw reply.
TEST (McpReplyReader, TheElementViewIsACopyAndTheBodyStaysRaw) {
    const std::string raw = progress () + event (kResultFrame);
    auto response         = reply (200, "text/event-stream", raw);
    attach_mcp_reply (mcp_request (), response);
    std::optional<Response> storage;
    const Response* view = mcp_element_view (response, storage);
    ASSERT_NE (view, &response);
    EXPECT_EQ (view->body, kResultFrame);
    EXPECT_EQ (response.body, raw);

    auto json_reply = reply (200, "application/json", kResultFrame);
    attach_mcp_reply (mcp_request (), json_reply);
    std::optional<Response> unused;
    EXPECT_EQ (mcp_element_view (json_reply, unused), &json_reply);
    EXPECT_FALSE (unused.has_value ());
}

TEST (McpReplyReader, AFailureIsATestAndAFailedTransferIsNot) {
    auto tool = reply (200, "application/json",
    R"({"jsonrpc":"2.0","id":1,"result":{"content":[],"isError":true}})");
    attach_mcp_reply (mcp_request (), tool);
    const auto test = mcp_failure_test (tool);
    ASSERT_HAS_VALUE (test);
    EXPECT_EQ (test->name, "MCP reply");
    EXPECT_FALSE (test->passed);
    EXPECT_EQ (test->error_message, "tool failure: the tool reported an error");

    Response failed;
    failed.error_code = ErrorCode::Timeout;
    attach_mcp_reply (mcp_request (), failed);
    ASSERT_HAS_VALUE (failed.mcp_reply);
    EXPECT_EQ (failed.mcp_reply->error_class, McpErrorClass::Transport);
    EXPECT_FALSE (mcp_failure_test (failed).has_value ());
}

TEST (McpReplyReader, TheWireNodeNamesTheClassAndCode) {
    McpReply failed;
    failed.error_class = McpErrorClass::Protocol;
    failed.code        = -32602;
    failed.message     = "JSON-RPC error -32602: Unknown tool";
    EXPECT_EQ (vayu::json::serialize_mcp_reply (failed),
    json ({ { "errorClass", "protocol" }, { "code", -32602 },
    { "message", "JSON-RPC error -32602: Unknown tool" } }));
    EXPECT_EQ (vayu::json::serialize_mcp_reply (McpReply{}), json::object ());
}

/// A response whose `result` is @p levels arrays deep: the innermost sits at
/// depth @p levels, as `element_kinds_test.cpp` builds its bounded bodies.
std::string result_nested_to (size_t levels) {
    return R"({"jsonrpc":"2.0","id":1,"result":)" + std::string (levels, '[') +
    std::string (levels, ']') + "}";
}

// The reply is a server's JSON, read by the element pipeline's own bound
// (#2361): a reply nested past it is no JSON-RPC response, never a stack
// overflow, and one at it is read. Mutation check: pass
// `ORDERED_JSON_UNBOUNDED` in `parse_object` and the over-the-bound case reads
// as a success.
TEST (McpReplyReader, AReplyNestedPastTheElementBoundIsNotRead) {
    constexpr size_t BOUND = core::constants::elements::MAX_BODY_DEPTH;
    for (const size_t levels : { BOUND + 1, size_t{ 50'000 } }) {
        const auto read = read_mcp_reply (mcp_request (),
        reply (200, "application/json", result_nested_to (levels)));
        EXPECT_EQ (read.error_class, McpErrorClass::Transport) << levels;
        EXPECT_TRUE (read.response.empty ()) << levels;
    }
    const auto at_bound = read_mcp_reply (
    mcp_request (), reply (200, "application/json", result_nested_to (BOUND)));
    EXPECT_FALSE (at_bound.error_class.has_value ()) << at_bound.message;
}

// A wide reply, in either shape, costs what its length does (#2497).
TEST (McpReplyReader, AResultWithAHundredThousandMembersIsReadInLinearTime) {
    const std::string frame =
    R"({"jsonrpc":"2.0","id":1,"result":)" + vayu::tests::wide_object_json () + "}";
    const auto started = std::chrono::steady_clock::now ();
    const auto json_read =
    read_mcp_reply (mcp_request (), reply (200, "application/json", frame));
    const auto stream_read = read_mcp_reply (mcp_request (),
    reply (200, "text/event-stream", progress () + event (frame)));
    const auto elapsed     = std::chrono::steady_clock::now () - started;

    EXPECT_LT (elapsed, vayu::tests::LINEAR_PARSE_BUDGET);
    EXPECT_EQ (json_read.response, frame);
    EXPECT_EQ (stream_read.response, frame);
}

// ---------------------------------------------------------------------------
// The load error tally, through the completion every load run shares.
// ---------------------------------------------------------------------------

constexpr const char* TALLY_DB_PATH = "test_mcp_reply_tally.db";

std::shared_ptr<core::RunContext> handled (const Response& response) {
    auto context = std::make_shared<core::RunContext> (
    "test-mcp-error", json{ { "mode", "constant_rps" } });
    {
        db::Database db (TALLY_DB_PATH);
        context->requests_sent++;
        core::handle_result (context, db, Result<Response> (response));
    }
    vayu::tests::remove_database_files (TALLY_DB_PATH);
    return context;
}

// A failure under a 200 is an error of the run, under its class.
TEST (McpReplyLoadTally, AFailureUnderASuccessStatusIsAnErrorOfItsClass) {
    auto tool = reply (200, "application/json",
    R"({"jsonrpc":"2.0","id":1,"result":{"content":[],"isError":true}})");
    attach_mcp_reply (mcp_request (), tool);
    const auto context = handled (tool);
    EXPECT_EQ (context->metrics_collector->total_errors (), 1u);
    EXPECT_EQ (context->metrics_collector->error_type_counts ().at ("mcp_tool"), 1u);
    const auto& errors = context->metrics_collector->errors ();
    ASSERT_EQ (errors.size (), 1u);
    const auto record = json::parse (errors.front ().trace_data);
    EXPECT_EQ (record["error_type"], "mcp_tool");
    EXPECT_EQ (record["mcp"]["errorClass"], "tool") << record.dump ();
    EXPECT_EQ (context->metrics_collector->error_class_counts ().to_json (),
    json ({ { "tool", 1 } }));
}

// A failed transfer is an error by its own type, and its reply's class is
// counted beside it (#3828), not instead of it.
TEST (McpReplyLoadTally, AFailedTransferKeepsItsErrorTypeAndCountsAsTransport) {
    Response refused;
    refused.error_code    = ErrorCode::ConnectionFailed;
    refused.error_message = "Connection refused";
    attach_mcp_reply (mcp_request (), refused);
    const auto context  = handled (refused);
    const auto& metrics = *context->metrics_collector;
    EXPECT_EQ (metrics.total_errors (), 1u);
    EXPECT_EQ (metrics.error_type_counts (),
    (std::map<std::string, size_t>{ { "connection_failed", 1 } }));
    EXPECT_EQ (metrics.error_class_counts ().to_json (), json ({ { "transport", 1 } }));
}

// One under a 4xx or 5xx is already an error by its status and is counted
// once, there; the trace the run keeps for it names the cause, and its class
// is counted (#3828), the one place a reader finds it in the summary.
// Mutation check: drop the `stamp_mcp_failure` call in
// `record_successful_response` and every case loses its `mcp` node.
TEST (McpReplyLoadTally, AFailureUnderAFailureStatusIsCountedOnceAndNamedOnItsTrace) {
    struct StatusFailure {
        int status;
        std::string content_type;
        std::string body;
        std::string error_class;
        std::optional<std::int64_t> code;
        std::string message_part;
    };
    const std::vector<StatusFailure> cases = {
        { 400, "application/json", R"({"jsonrpc":"2.0","id":1,"error":{"code":-32020,"message":"Header mismatch"}})",
        "protocol", -32020, "Header mismatch" },
        { 400, "application/json", R"({"jsonrpc":"2.0","id":1,"error":{"code":-32022,"message":"Unsupported","data":{"supported":["2025-11-25"]}}})",
        "protocol", -32022, "server supports 2025-11-25; this request is" },
        { 400, "text/plain", "Bad Request: No valid session ID provided",
        "transport", std::nullopt, "legacy-era" },
        { 503, "text/plain", "Service Unavailable", "transport", std::nullopt,
        "HTTP 503 with no JSON-RPC response" },
    };
    for (const auto& failure : cases) {
        auto response = reply (failure.status, failure.content_type, failure.body);
        attach_mcp_reply (mcp_request (), response);
        const auto context  = handled (response);
        const auto& metrics = *context->metrics_collector;
        EXPECT_EQ (metrics.total_errors (), 0u) << failure.body;
        EXPECT_TRUE (metrics.error_type_counts ().empty ()) << failure.body;
        EXPECT_TRUE (metrics.errors ().empty ()) << failure.body;
        const auto distribution = metrics.status_code_distribution ();
        EXPECT_EQ (distribution.at (failure.status), 1u) << failure.body;
        EXPECT_EQ (distribution.count (0), 0u) << failure.body;
        json classes = { { failure.error_class, 1 } };
        if (failure.code) {
            classes["protocolCodes"] = { { std::to_string (*failure.code), 1 } };
        }
        EXPECT_EQ (metrics.error_class_counts ().to_json (), classes) << failure.body;

        const auto& kept = metrics.exemplar_results ();
        ASSERT_EQ (kept.size (), 1u) << failure.body;
        const auto trace = json::parse (kept.front ().trace_data);
        const auto mcp   = trace.value ("mcp", json::object ());
        EXPECT_EQ (mcp.value ("errorClass", ""), failure.error_class) << trace.dump ();
        if (failure.code) {
            EXPECT_EQ (mcp.value ("code", std::int64_t{ 0 }), *failure.code)
            << trace.dump ();
        } else {
            EXPECT_FALSE (mcp.contains ("code")) << trace.dump ();
        }
        EXPECT_NE (mcp.value ("message", "").find (failure.message_part), std::string::npos)
        << trace.dump ();
    }
}

// A server chooses the code, so it is counted into a fixed slot and never used
// as a key: the reserved codes and the server band each by code, anything else
// under `other`, and a code is counted only for the class that carries one.
TEST (McpErrorCounts, AProtocolFailuresCodeIsCountedInItsSlotAndAnyOtherUnderOther) {
    core::McpErrorCounts counts;
    for (const std::int64_t code : { -32700, -32600, -32603, -32000, -32020, -32099 }) {
        counts.record (McpErrorClass::Protocol, code);
    }
    for (const std::int64_t code : { -32100, -32604, -1, 0, 7 }) {
        counts.record (McpErrorClass::Protocol, code);
    }
    counts.record (McpErrorClass::Protocol, std::nullopt);
    counts.record (McpErrorClass::Tool, -32602);
    counts.record (McpErrorClass::Transport, std::nullopt);
    EXPECT_EQ (counts.to_json (), json::parse (R"({"protocol":12,"tool":1,"transport":1,
        "protocolCodes":{"-32700":1,"-32600":1,"-32603":1,"-32000":1,"-32020":1,
        "-32099":1,"other":5}})"));
    EXPECT_EQ (core::McpErrorCounts{}.to_json (), json::object ());

    // The collector keeps the same table.
    core::MetricsCollector collector ("test-mcp-codes");
    collector.record_mcp_failure (McpErrorClass::Protocol, -32602);
    collector.record_mcp_failure (McpErrorClass::Protocol, 123);
    collector.record_mcp_failure (McpErrorClass::Tool, -32602);
    EXPECT_EQ (collector.error_class_counts ().to_json (),
    json::parse (R"({"protocol":2,"tool":1,"protocolCodes":{"-32602":1,"other":1}})"));
}

// ---------------------------------------------------------------------------
// The design send, buffered: `execute_exchange`, which a collection run's
// sequential steps share.
// ---------------------------------------------------------------------------

class McpReplyExchangeTest : public ::testing::Test {
    protected:
    void SetUp () override {
        global_init ();
        server_ = std::make_unique<McpFixtureServer> ();
    }

    void TearDown () override {
        server_.reset ();
        global_cleanup ();
    }

    routes::ExchangeOutcome send (const std::vector<json>& elements = {}) {
        auto request = vayu::json::deserialize_request (mcp_payload (*server_));
        if (!request.is_ok ()) {
            ADD_FAILURE () << request.error ().message;
            return {};
        }
        vayu::runtime::ScriptEngine engine;
        CookieJar jar;
        routes::ScriptVariableScopes scopes;
        routes::ExchangeInputs inputs;
        inputs.request = std::move (request).value ();
        if (!elements.empty ()) {
            inputs.elements = vayu::tests::compiled_elements (elements);
        }
        return routes::execute_exchange (engine, jar, "", scopes, std::move (inputs));
    }

    std::unique_ptr<McpFixtureServer> server_;
};

const core::ElementOutcome*
outcome_of (const routes::ExchangeOutcome& exchange, const std::string& id) {
    for (const auto& outcome : exchange.element_outcomes) {
        if (outcome.id == id) {
            return &outcome;
        }
    }
    return nullptr;
}

const TestResult* failure_test_of (const ScriptResult& result) {
    for (const auto& test : result.tests) {
        if (test.name == "MCP reply") {
            return &test;
        }
    }
    return nullptr;
}

// Mutation check: hand the elements `outcome.response` rather than the view
// in `execute_exchange`, and the event-stream case reddens.
TEST_F (McpReplyExchangeTest, TheElementsReadTheFinalResponseOfEitherReplyShape) {
    for (const auto shape : { McpReplyShape::EventStream, McpReplyShape::Json }) {
        server_->reply_with (shape);
        const auto exchange = send ({ text_assertion (), text_extractor () });

        ASSERT_EQ (exchange.response.status_code, 200) << exchange.response.body;
        for (const char* id : { "el_text", "el_extract" }) {
            const auto* outcome = outcome_of (exchange, id);
            ASSERT_NE (outcome, nullptr) << id;
            EXPECT_EQ (outcome->status, "ok")
            << id << ": " << outcome->message.value_or ("") << "\n"
            << exchange.response.body;
        }
        ASSERT_HAS_VALUE (exchange.response.mcp_reply);
        EXPECT_FALSE (exchange.response.mcp_reply->error_class.has_value ());
        EXPECT_EQ (failure_test_of (exchange.post_script_result), nullptr);
    }
    // The body stays the stream, which is what a script's `text()` reads.
    server_->reply_with (McpReplyShape::EventStream);
    EXPECT_TRUE (send ().response.body.starts_with ("event: message"))
    << "the body was rewritten";
}

struct FailureCase {
    McpReplyShape shape;
    McpReplyOutcome outcome;
    McpErrorClass error_class;
    const char* load_error_type;
};

const auto& failure_cases () {
    static const std::vector<FailureCase> cases{
        { McpReplyShape::Json, McpReplyOutcome::RpcError, McpErrorClass::Protocol, "mcp_protocol" },
        { McpReplyShape::EventStream, McpReplyOutcome::ToolError, McpErrorClass::Tool, "mcp_tool" },
        { McpReplyShape::EventStreamCut, McpReplyOutcome::Result,
        McpErrorClass::Transport, "mcp_transport" },
    };
    return cases;
}

// Each class fails the step as a failed assertion does, with no element on it.
TEST_F (McpReplyExchangeTest, EachFailureClassFailsTheExchangeAsAnAssertionDoes) {
    for (const auto& failure : failure_cases ()) {
        server_->reply_with (failure.shape, failure.outcome);
        const auto exchange = send ();

        ASSERT_HAS_VALUE (exchange.response.mcp_reply) << failure.load_error_type;
        EXPECT_EQ (exchange.response.mcp_reply->error_class, failure.error_class)
        << exchange.response.mcp_reply->message;
        const auto* test = failure_test_of (exchange.post_script_result);
        ASSERT_NE (test, nullptr) << failure.load_error_type;
        EXPECT_FALSE (test->passed);
        EXPECT_TRUE (test->error_message.starts_with (to_string (failure.error_class)))
        << test->error_message;
    }
}

TEST_F (McpReplyExchangeTest, AVersionRefusalAndALegacyServerAreNamed) {
    server_->reply_with (McpReplyShape::Json, McpReplyOutcome::UnsupportedVersion);
    const auto refused = send ();
    ASSERT_HAS_VALUE (refused.response.mcp_reply);
    EXPECT_EQ (refused.response.mcp_reply->message,
    "server supports 2025-11-25, 2025-06-18; this request is 2026-07-28");

    server_->reply_with (McpReplyShape::Json, McpReplyOutcome::LegacyBadRequest);
    const auto legacy = send ();
    ASSERT_HAS_VALUE (legacy.response.mcp_reply);
    EXPECT_EQ (legacy.response.mcp_reply->error_class, McpErrorClass::Transport);
    EXPECT_NE (legacy.response.mcp_reply->message.find ("legacy-era"), std::string::npos);
    // No retry and no fallback: the one modern request is all that was sent.
    EXPECT_EQ (server_->requests (), 2u);
}

// ---------------------------------------------------------------------------
// The design send, streamed: `POST /execute` with `stream: true`, whose
// consumer keeps an event stream's events and none of its bytes.
// ---------------------------------------------------------------------------

class McpReplyStreamTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_mcp_reply_stream.db";

    void SetUp () override {
        global_init ();
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<db::Database> (DB_PATH);
        db_->init ();
        manager_ = std::make_unique<SseStreamManager> ();
        ctx_ = std::make_unique<routes::RouteContext> (routes::RouteContext{ svr_,
        *db_, run_manager_, nullptr, authorize_manager_, cookie_jar_, mock_issuer_manager_,
        inbox_manager_, mock_server_manager_, *manager_, run_summary_cache_ });
        routes::register_execution_routes (*ctx_);
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
        server_ = std::make_unique<McpFixtureServer> ();
    }

    void TearDown () override {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
        // The stream's worker writes through `db_`; joined first (#646).
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        server_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        global_cleanup ();
    }

    /// The stored trace of a streamed send carrying @p elements.
    json stream (const json& elements) {
        json payload        = mcp_payload (*server_);
        payload["stream"]   = true;
        payload["elements"] = elements;
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        const auto answer = client.Post ("/execute", payload.dump (), "application/json");
        if (!answer || answer->status != 202) {
            ADD_FAILURE () << (answer ? answer->body : std::string ("no answer"));
            return json::object ();
        }
        const std::string run_id = json::parse (answer->body).value ("runId", "");
        std::vector<db::Result> rows;
        EXPECT_TRUE (vayu::tests::wait_until ([&] () {
            rows = db_->get_results (run_id);
            return !rows.empty ();
        }))
        << "no result row for " << run_id;
        return rows.empty () ? json::object () : json::parse (rows.front ().trace_data);
    }

    std::unique_ptr<db::Database> db_;
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    core::RunManager run_manager_;
    OAuth2AuthorizeManager authorize_manager_;
    CookieJar cookie_jar_;
    MockIssuerManager mock_issuer_manager_;
    InboxManager inbox_manager_;
    MockServerManager mock_server_manager_;
    RunSummaryCache run_summary_cache_;
    std::unique_ptr<SseStreamManager> manager_;
    std::unique_ptr<routes::RouteContext> ctx_;
    std::unique_ptr<McpFixtureServer> server_;
};

/// A stored trace's `response.mcp`, or `null` when it has none. Read through
/// `value` so a mutation that drops the node fails an expectation rather than
/// a `const` subscript's assertion.
json mcp_node_of (const json& trace) {
    return trace.value ("response", json::object ()).value ("mcp", json ());
}

json test_results_of (const json& trace) {
    return trace.value ("scripts", json::object ()).value ("testResults", json::array ());
}

json test_named (const json& trace, const std::string& name) {
    for (const auto& test :
    trace.value ("scripts", json::object ()).value ("testResults", json::array ())) {
        if (test.value ("name", "") == name) {
            return test;
        }
    }
    return json ();
}

// The elements read the final response, while a script keeps the stream:
// its events, its bytes as `text()` (#3770) and `pm.response.mcp`. Mutation
// check: hand the stream's elements `&mutable_response` rather than the view
// in `execution.cpp` and the assertion fails.
TEST_F (McpReplyStreamTest, AStreamedReplysElementsReadTheFinalResponseAndScriptsTheStream) {
    server_->reply_with (McpReplyShape::EventStream);
    const auto trace = stream (json::array ({ text_assertion (), text_extractor (),
    vayu::tests::script_element_json ("el_post", "script.post", R"JS(
        pm.test('raw stream', function () {
            pm.expect(pm.response.events.length).to.equal(3);
            pm.expect(pm.response.text().indexOf('event: message\ndata: ')).to.equal(0);
            pm.expect(pm.response.text()).to.include('notifications/progress');
            pm.expect(JSON.stringify(pm.response.mcp)).to.equal('{}');
        });
    )JS") }));

    EXPECT_EQ (mcp_node_of (trace), json::object ()) << trace.dump (2);
    const auto results = test_results_of (trace);
    ASSERT_EQ (results.size (), 2u) << trace.dump (2);
    for (const auto& test : results) {
        EXPECT_TRUE (test["passed"].get<bool> ()) << test.dump ();
    }
    EXPECT_TRUE (test_named (trace, "MCP reply").is_null ());
}

// With no element at all, a failure still fails the stream's step.
TEST_F (McpReplyStreamTest, EachFailureClassFailsAStreamWithNoElement) {
    for (const auto& failure : failure_cases ()) {
        if (failure.shape == McpReplyShape::Json) {
            continue;
        }
        server_->reply_with (failure.shape, failure.outcome);
        const auto trace = stream (json::array ());

        EXPECT_EQ (mcp_node_of (trace).value ("errorClass", ""),
        to_string (failure.error_class))
        << trace.dump (2);
        const auto test = test_named (trace, "MCP reply");
        ASSERT_FALSE (test.is_null ()) << trace.dump (2);
        EXPECT_FALSE (test["passed"].get<bool> ());
    }
}

// ---------------------------------------------------------------------------
// Runs: a collection run's sequential steps, a scenario load run and a
// single-request load run.
// ---------------------------------------------------------------------------

constexpr size_t ITERATIONS = 2;

class McpReplyRunTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_mcp_reply_runs.db";

    void SetUp () override {
        global_init ();
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<db::Database> (DB_PATH);
        db_->init ();
        server_ = std::make_unique<McpFixtureServer> ();
    }

    void TearDown () override {
        db_.reset ();
        server_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        global_cleanup ();
    }

    /// A one-step plan sending the fixture's `tools/call`, carrying @p elements.
    core::ScenarioExecution plan (const std::vector<json>& elements) const {
        core::ScenarioExecution execution;
        execution.request.source        = "collection";
        execution.request.collection_id = "col_mcp";
        core::ScenarioStep step;
        step.request_id = "req_mcp";
        step.name       = "tools/call";
        auto request = vayu::json::deserialize_request (mcp_payload (*server_));
        EXPECT_TRUE (request.is_ok ());
        if (request.is_ok ()) {
            step.request = std::move (request).value ();
        }
        step.stored_url = step.request.url;
        if (!elements.empty ()) {
            step.elements = vayu::tests::compiled_elements (elements);
        }
        execution.plan.steps.push_back (std::move (step));
        return execution;
    }

    db::Run run_row (const std::string& id, RunType type, const json& config) {
        db::Run run;
        run.id              = id;
        run.type            = type;
        run.status          = RunStatus::Pending;
        run.config_snapshot = config.dump ();
        run.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        run.end_time = run.start_time;
        db_->create_run (run);
        return run;
    }

    /// The collection run's stored step rows.
    std::vector<db::Result> run_sequentially (const std::vector<json>& elements,
    size_t iterations = ITERATIONS) {
        auto execution               = plan (elements);
        execution.request.iterations = iterations;
        const json config            = { { "scenario",
        { { "source", "collection" }, { "collectionId", "col_mcp" },
        { "iterations", iterations } } } };
        const std::string run_id = "run_mcp_sequential_" + std::to_string (++runs_);
        last_run_id_ = run_id;
        run_row (run_id, RunType::Scenario, config);
        CookieJar jar;
        core::RunManager manager;
        EXPECT_TRUE (manager.start_scenario_run (run_id, config,
        std::make_shared<const core::ScenarioExecution> (std::move (execution)), *db_, jar));
        EXPECT_TRUE (vayu::tests::wait_until (
        [&] () { return manager.get_run (run_id) == nullptr; }))
        << "the run never finished";
        manager.shutdown ();
        return db_->get_results (run_id);
    }

    struct LoadOutcome {
        json summary;
        std::map<std::string, size_t> error_types;
        core::McpErrorCounts error_classes;
    };

    /// A scenario load run of the plan, as `scenario_load_test.cpp` drives one.
    LoadOutcome run_scenario_load (const std::vector<json>& elements,
    size_t iterations = ITERATIONS) {
        const auto execution =
        std::make_shared<const core::ScenarioExecution> (plan (elements));
        auto context =
        std::make_shared<core::RunContext> ("test-mcp-scenario-load",
        json{ { "mode", "iterations" }, { "iterations", iterations }, { "concurrency", 1 } });
        context->scenario   = execution;
        context->event_loop = std::make_unique<EventLoop> (EventLoopConfig{});
        context->event_loop->start ();
        auto scopes = core::scenario_load_scopes (*db_, std::nullopt, *execution);
        auto state =
        core::execute_scenario_load (context, *db_, *execution, std::move (scopes));
        context->event_loop->stop (true, std::chrono::milliseconds (10000));
        return LoadOutcome{ core::build_scenario_load_summary (*state, execution->plan),
            context->metrics_collector->error_type_counts (),
            context->metrics_collector->error_class_counts () };
    }

    /// A single-request load run of the fixture's call with @p elements as its
    /// `requestElements`, through `RunManager`; its stored summary.
    json run_single_request_load (const std::vector<json>& elements,
    size_t iterations = ITERATIONS) {
        json config = mcp_payload (*server_);
        config.update (json{ { "mode", "iterations" },
        { "iterations", iterations }, { "concurrency", 1 } });
        if (!elements.empty ()) {
            config["requestElements"] = elements;
        }
        const std::string run_id = "run_mcp_load_" + std::to_string (++runs_);
        last_run_id_             = run_id;
        run_row (run_id, RunType::Load, config);
        core::RunManager manager;
        EXPECT_TRUE (manager.start_run (run_id, config, *db_));
        EXPECT_TRUE (vayu::tests::wait_until (
        [&] () { return manager.get_run (run_id) == nullptr; }))
        << "the run never finished";
        manager.shutdown ();
        const auto stored = db_->get_run (run_id);
        if (!stored || stored->summary.empty ()) {
            ADD_FAILURE () << "the run stored no summary";
            return json::object ();
        }
        return json::parse (stored->summary);
    }

    /// `GET /runs/:id/report`'s body for the last run a driver stored.
    json last_report () {
        auto [status, body] = routes::run_report_response (*db_, last_run_id_);
        EXPECT_EQ (status, 200) << body.dump ();
        return body;
    }

    std::unique_ptr<db::Database> db_;
    std::unique_ptr<McpFixtureServer> server_;
    size_t runs_ = 0;
    std::string last_run_id_;
};

/// Forty calls: four answer `isError`, two a JSON-RPC `-32602` under a 200 and
/// one a legacy-era `400` (a transport failure under a 4xx), the rest succeed.
std::vector<McpReplyOutcome> mixed_turns () {
    std::vector<McpReplyOutcome> turns (40, McpReplyOutcome::Result);
    for (const size_t call : { 3U, 13U, 23U, 33U }) {
        turns.at (call) = McpReplyOutcome::ToolError;
    }
    for (const size_t call : { 7U, 27U }) {
        turns.at (call) = McpReplyOutcome::RpcError;
    }
    turns.at (19) = McpReplyOutcome::LegacyBadRequest;
    return turns;
}

/// What @p turns calls of `mixed_turns` count as, per class.
json mixed_classes (size_t calls) {
    const size_t cycles = calls / 40;
    return json{ { "tool", 4 * cycles }, { "protocol", 2 * cycles },
        { "transport", cycles }, { "protocolCodes", { { "-32602", 2 * cycles } } } };
}

/// The `passed` count a load summary's element row for @p id reports.
size_t element_passed (const json& rows, const std::string& id) {
    for (const auto& row : rows) {
        if (row.value ("id", "") == id) {
            return row.value ("passed", size_t{ 0 });
        }
    }
    return 0;
}

// Mutation check: return `&response` from `mcp_element_view` and every
// event-stream case on all three run paths reddens.
TEST_F (McpReplyRunTest, ACollectionRunsElementsReadTheFinalResponse) {
    for (const auto shape : { McpReplyShape::EventStream, McpReplyShape::Json }) {
        server_->reply_with (shape);
        const auto rows = run_sequentially ({ text_assertion (), text_extractor () });
        ASSERT_EQ (rows.size (), ITERATIONS);
        for (const auto& row : rows) {
            EXPECT_TRUE (row.error.empty ()) << row.error;
            const auto trace   = json::parse (row.trace_data);
            const auto results = test_results_of (trace);
            ASSERT_EQ (results.size (), 1u) << trace.dump (2);
            EXPECT_TRUE (results[0]["passed"].get<bool> ()) << results.dump ();
        }
    }
}

TEST_F (McpReplyRunTest, EachFailureClassFailsACollectionRunsStep) {
    for (const auto& failure : failure_cases ()) {
        server_->reply_with (failure.shape, failure.outcome);
        const auto rows = run_sequentially ({});
        ASSERT_EQ (rows.size (), ITERATIONS);
        for (const auto& row : rows) {
            EXPECT_NE (row.error.find ("MCP reply"), std::string::npos)
            << failure.load_error_type << ": " << row.error;
            const auto trace = json::parse (row.trace_data);
            EXPECT_EQ (mcp_node_of (trace).value ("errorClass", ""),
            to_string (failure.error_class));
        }
    }
}

TEST_F (McpReplyRunTest, AScenarioLoadRunsElementsReadTheFinalResponse) {
    for (const auto shape : { McpReplyShape::EventStream, McpReplyShape::Json }) {
        server_->reply_with (shape);
        auto load = run_scenario_load ({ text_assertion (), text_extractor () });
        const auto rows = load.summary["steps"][0]["elements"];
        EXPECT_EQ (element_passed (rows, "el_text"), ITERATIONS) << load.summary.dump ();
        EXPECT_EQ (element_passed (rows, "el_extract"), ITERATIONS)
        << load.summary.dump ();
        EXPECT_EQ (load.summary["failed"], 0) << load.summary.dump ();
        EXPECT_EQ (load.summary["passed"], ITERATIONS) << load.summary.dump ();
        EXPECT_TRUE (load.error_types.empty ());
    }
}

TEST_F (McpReplyRunTest, EachFailureClassFailsAScenarioLoadStepAndCountsAnError) {
    for (const auto& failure : failure_cases ()) {
        server_->reply_with (failure.shape, failure.outcome);
        auto load = run_scenario_load ({});
        EXPECT_EQ (load.summary["failed"], ITERATIONS)
        << failure.load_error_type << ": " << load.summary.dump ();
        EXPECT_EQ (load.summary["steps"][0]["httpErrors"], ITERATIONS)
        << load.summary.dump ();
        const auto counted = load.error_types.find (failure.load_error_type);
        ASSERT_NE (counted, load.error_types.end ()) << failure.load_error_type;
        EXPECT_EQ (counted->second, ITERATIONS);
    }
}

// The event loop keeps an event stream's bytes as the body, so the reader has
// the final response to read under load too. Mutation check: clear an event
// stream's body in the event loop's `complete_transfer` before the reply is
// read, and this and the scenario load case redden.
TEST_F (McpReplyRunTest, ASingleRequestLoadRunsElementsReadTheFinalResponse) {
    for (const auto shape : { McpReplyShape::EventStream, McpReplyShape::Json }) {
        server_->reply_with (shape);
        // Not const: a key a mutation drops reads as null, not an assertion.
        auto summary =
        run_single_request_load ({ text_assertion (), text_extractor () });
        EXPECT_EQ (element_passed (summary["elements"], "el_text"), ITERATIONS)
        << summary.dump ();
        EXPECT_EQ (element_passed (summary["elements"], "el_extract"), ITERATIONS)
        << summary.dump ();
        EXPECT_FALSE (summary.value ("error_types", json::object ()).contains ("mcp_transport"))
        << summary.dump ();
    }
}

TEST_F (McpReplyRunTest, EachFailureClassIsASingleRequestLoadRunsError) {
    for (const auto& failure : failure_cases ()) {
        server_->reply_with (failure.shape, failure.outcome);
        auto summary = run_single_request_load ({});
        EXPECT_EQ (summary["error_types"][failure.load_error_type], ITERATIONS)
        << summary.dump ();
    }
}

// The run summary counts every failed reply by class (#3828), and each is an
// error of the run: 35 of 200 calls, a 400's transport failure among them.
// Mutation check: drop the `record_mcp_failure` call in `handle_result` and
// `error_classes` reads `{}` here and in the scenario load case below.
TEST_F (McpReplyRunTest, ASingleRequestLoadRunCountsItsFailedRepliesByClass) {
    constexpr size_t CALLS = 200;
    server_->reply_in_turn (McpReplyShape::Json, mixed_turns ());
    auto summary = run_single_request_load ({}, CALLS);

    EXPECT_EQ (summary["error_classes"], mixed_classes (CALLS)) << summary.dump ();
    // The superset: a failure under the 400 has a class and no error type.
    EXPECT_EQ (summary["error_types"],
    json ({ { "mcp_tool", 20 }, { "mcp_protocol", 10 } }))
    << summary.dump ();
    EXPECT_EQ (summary["status_codes"],
    json ({ { "0", 30 }, { "200", 165 }, { "400", 5 } }))
    << summary.dump ();

    auto report = last_report ();
    EXPECT_EQ (report["summary"]["errorClasses"], mixed_classes (CALLS))
    << report.dump ();
    EXPECT_EQ (report["summary"]["totalRequests"], CALLS);
    EXPECT_EQ (report["summary"]["failedRequests"], 35);
    EXPECT_DOUBLE_EQ (report["summary"]["errorRate"].get<double> (), 17.5);
}

TEST_F (McpReplyRunTest, AScenarioLoadRunCountsItsFailedRepliesByClass) {
    constexpr size_t CALLS = 40;
    server_->reply_in_turn (McpReplyShape::EventStream, mixed_turns ());
    const auto load = run_scenario_load ({}, CALLS);
    EXPECT_EQ (load.error_classes.to_json (), mixed_classes (CALLS));
}

// A collection run counts the classes its own way, and a failure under a 200
// goes under status 0 as on the load path, so its error rate counts it.
// Mutation check: drop the `0` bucket in `tally_sent_step` and the error rate
// reads 1 of 40; drop its `error_classes.record` and the classes read `{}`.
TEST_F (McpReplyRunTest, ACollectionRunCountsItsFailedRepliesByClassAsErrors) {
    constexpr size_t CALLS = 40;
    server_->reply_in_turn (McpReplyShape::Json, mixed_turns ());
    const auto rows = run_sequentially ({}, CALLS);
    ASSERT_EQ (rows.size (), CALLS);

    const auto stored = db_->get_run (last_run_id_);
    ASSERT_HAS_VALUE (stored);
    auto summary = json::parse (stored->summary);
    EXPECT_EQ (summary["error_classes"], mixed_classes (CALLS)) << summary.dump ();
    EXPECT_EQ (summary["status_codes"], json ({ { "0", 6 }, { "200", 33 }, { "400", 1 } }))
    << summary.dump ();

    auto report = last_report ();
    EXPECT_EQ (report["summary"]["errorClasses"], mixed_classes (CALLS))
    << report.dump ();
    EXPECT_EQ (report["summary"]["failedRequests"], 7);
    EXPECT_DOUBLE_EQ (report["summary"]["errorRate"].get<double> (), 17.5);
}

} // namespace
} // namespace vayu::http
