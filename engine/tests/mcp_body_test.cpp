/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file mcp_body_test.cpp
 * @brief An `mcp` body (#3762): its `_meta`, the headers mirrored out of it,
 *        and a send a server that checks them accepts.
 *
 * The goldens are the specification's own examples where it gives one
 * (`streamable-http.md`, revision 2026-07-28), so a test disagreeing with the
 * engine is a test disagreeing with the spec.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <curl/curl.h>

#include "mcp_fixture_server.hpp"
#include "nested_json.hpp"
#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/mcp_body.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/version.hpp"
#include "wide_json.hpp"

namespace vayu::http {
namespace {

using vayu::tests::McpFixtureServer;
using Lines = std::vector<HeaderLine>;

/// The `_meta` a bare call is stamped with, as the wire spells it.
const std::string& stamped_meta () {
    static const std::string meta =
    std::string (R"("_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",)") +
    R"("io.modelcontextprotocol/clientInfo":{"name":"vayu","version":")" +
    VAYU_VERSION_STRING + R"("},"io.modelcontextprotocol/clientCapabilities":{}})";
    return meta;
}

const char* const kToolsCall =
R"({"method":"tools/call","params":{"name":"execute_sql","arguments":{"region":"us-west1","query":"SELECT 1"}}})";

McpTool execute_sql_tool () {
    auto tool = read_mcp_tool (vayu::tests::execute_sql_tool_json ());
    if (!tool) {
        ADD_FAILURE () << tool.error ();
        return {};
    }
    return *tool;
}

Request mcp_request (const std::string& url, const std::string& content) {
    Request request;
    request.method       = HttpMethod::POST;
    request.url          = url;
    request.timeout_ms   = 5000;
    request.body.mode    = BodyMode::Mcp;
    request.body.content = content;
    return request;
}

/// The value @p headers carries under @p name, compared without case.
std::optional<std::string> value_of (const Lines& headers, std::string_view name) {
    for (const auto& line : headers) {
        if (utils::ascii_lower_equal (line.name, name)) {
            return line.value;
        }
    }
    return std::nullopt;
}

// ---------------------------------------------------------------------------
// The body.
// ---------------------------------------------------------------------------

// The spec's `tools/call` example, written bare: `_meta` goes into `params`,
// then the envelope's two members on the end. Mutation check: drop the
// `stamp_meta` call from `mcp_wire_body` and this reddens.
TEST (McpWireBody, StampsMetaOnABareToolsCallAndCompletesTheEnvelope) {
    EXPECT_EQ (mcp_wire_body (kToolsCall),
    R"({"method":"tools/call","params":{"name":"execute_sql","arguments":{"region":"us-west1","query":"SELECT 1"},)" +
    stamped_meta () + R"(},"jsonrpc":"2.0","id":1})");
}

// A call with no `params`, or a null one, gains the object to carry `_meta`.
TEST (McpWireBody, CreatesParamsToCarryMeta) {
    const std::string expected = R"({"method":"tools/list","params":{)" +
    stamped_meta () + R"(},"jsonrpc":"2.0","id":1})";
    EXPECT_EQ (mcp_wire_body (R"({"method":"tools/list"})"), expected);
    EXPECT_EQ (mcp_wire_body (R"({"method":"tools/list","params":null})"), expected);
}

// The caller's own `_meta` is theirs; only the envelope is completed.
TEST (McpWireBody, LeavesACallersMetaAlone) {
    EXPECT_EQ (mcp_wire_body (R"({"method":"ping","params":{"_meta":{"k":1}},"id":7})"),
    R"({"method":"ping","params":{"_meta":{"k":1}},"id":7,"jsonrpc":"2.0"})");
}

// A full envelope is the caller's frame: byte for byte, `_meta` or none.
TEST (McpWireBody, PassesAnEnvelopeThroughByteForByte) {
    const std::string with_meta =
    R"({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "t", "_meta": { "x": true } } })";
    EXPECT_EQ (mcp_wire_body (with_meta), with_meta);
    const std::string without_meta = R"({"jsonrpc":"2.0","id":3,"method":"tools/list"})";
    EXPECT_EQ (mcp_wire_body (without_meta), without_meta);
}

// The `{{variable}}` guard and the other non-calls, as `jsonrpc_wire_body`.
TEST (McpWireBody, PassesWhatIsNotABareCallThroughVerbatim) {
    const std::string templated = R"({"method":"tools/call","params":{{args}}})";
    EXPECT_EQ (mcp_wire_body (templated), templated);
    EXPECT_EQ (mcp_wire_body (R"([{"method":"a"}])"), R"([{"method":"a"}])");
    EXPECT_EQ (mcp_wire_body (""), "");
    // `params` that is not an object has nowhere to hold `_meta`.
    EXPECT_EQ (mcp_wire_body (R"({"method":"m","params":[1]})"),
    R"({"method":"m","params":[1],"jsonrpc":"2.0","id":1})");
}

// The chokepoint every driver reads, not only the function.
TEST (McpWireBody, IsWhatWireBodyBytesSends) {
    Body body;
    body.mode    = BodyMode::Mcp;
    body.content = kToolsCall;
    EXPECT_EQ (wire_body_bytes (body), mcp_wire_body (kToolsCall));
    EXPECT_EQ (implied_content_type (body), "application/json");
}

// The parse is the shared bounded one (#2672): a call nested past the bound
// passes through as typed rather than overflowing the stack.
TEST (McpWireBody, PassesACallNestedPastTheBoundThroughVerbatim) {
    const std::string far_too_deep = vayu::tests::nested_object_text (50'000, "1");
    EXPECT_EQ (mcp_wire_body (far_too_deep), far_too_deep);
}

// The other side of the bound: a call that fits is still completed. It has no
// `params`, so the stamp lands on the end.
TEST (McpWireBody, CompletesACallNestedExactlyToTheBound) {
    const std::string at_bound = vayu::tests::nested_object_text (
    vayu::core::constants::request_body::MAX_JSON_DEPTH, "1");
    EXPECT_EQ (mcp_wire_body (at_bound),
    at_bound.substr (0, at_bound.size () - 1) + R"(,"params":{)" +
    stamped_meta () + R"(},"jsonrpc":"2.0","id":1})");
}

// A wide call costs what its length does (#2497), the stamp included.
TEST (McpWireBody, ACallWithAHundredThousandMembersIsCompletedInLinearTime) {
    const std::string call = vayu::tests::wide_object_json ();

    const auto started     = std::chrono::steady_clock::now ();
    const std::string wire = mcp_wire_body (call);
    const auto headers     = mcp_derived_headers (wire, std::nullopt);
    const auto elapsed     = std::chrono::steady_clock::now () - started;

    EXPECT_LT (elapsed, vayu::tests::LINEAR_PARSE_BUDGET);
    EXPECT_EQ (wire,
    call.substr (0, call.size () - 1) + R"(,"params":{)" + stamped_meta () +
    R"(},"jsonrpc":"2.0","id":1})");
    EXPECT_EQ (headers.size (), 2u);
}

// ---------------------------------------------------------------------------
// The derivation, without a socket.
// ---------------------------------------------------------------------------

// The spec's `tools/call` request, header for header and in its order.
// Mutation check: return early before the `Mcp-Name` push in
// `mcp_derived_headers` and this reddens.
TEST (McpDerivedHeaders, DeriveTheStandardHeadersOfAToolsCall) {
    EXPECT_EQ (mcp_derived_headers (mcp_wire_body (kToolsCall), std::nullopt),
    (Lines{ { "Accept", "application/json, text/event-stream" },
    { "MCP-Protocol-Version", "2026-07-28" }, { "Mcp-Method", "tools/call" },
    { "Mcp-Name", "execute_sql" } }));
}

TEST (McpDerivedHeaders, NameTheUriOfAResourceReadAndThePromptOfAPromptGet) {
    const auto resource = mcp_derived_headers (
    R"({"method":"resources/read","params":{"uri":"file:///projects/myapp/config.json"}})",
    std::nullopt);
    EXPECT_EQ (value_of (resource, "Mcp-Name"), "file:///projects/myapp/config.json");

    const auto prompt = mcp_derived_headers (
    R"({"method":"prompts/get","params":{"name":"greet"}})", std::nullopt);
    EXPECT_EQ (value_of (prompt, "Mcp-Name"), "greet");

    // Only those three methods mirror a name.
    const auto listing = mcp_derived_headers (
    R"({"method":"tools/list","params":{"name":"not-a-target"}})", std::nullopt);
    EXPECT_EQ (value_of (listing, "Mcp-Name"), std::nullopt);
    EXPECT_EQ (value_of (listing, "Mcp-Method"), "tools/list");
}

// The header must agree with the body, so a caller's own `_meta` version is
// the one mirrored.
TEST (McpDerivedHeaders, TheProtocolVersionFollowsTheBodysMeta) {
    const auto headers = mcp_derived_headers (
    R"({"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2025-11-25"}}})",
    std::nullopt);
    EXPECT_EQ (value_of (headers, "MCP-Protocol-Version"), "2025-11-25");
}

// Text that is not one object (an unresolved token) still gets the two
// headers every POST carries, and nothing it would have to guess.
TEST (McpDerivedHeaders, AnUnreadableBodyDerivesOnlyAcceptAndTheVersion) {
    EXPECT_EQ (mcp_derived_headers (R"({"method":{{m}}})", std::nullopt),
    (Lines{ { "Accept", "application/json, text/event-stream" },
    { "MCP-Protocol-Version", "2026-07-28" } }));
}

// The derivation reads under the same bound: a body past it is one that does
// not parse, so nothing is read out of it.
TEST (McpDerivedHeaders, ABodyNestedPastTheBoundDerivesOnlyAcceptAndTheVersion) {
    const std::string one_past = R"({"method":"tools/list","params":)" +
    vayu::tests::nested_object_text (
    vayu::core::constants::request_body::MAX_JSON_DEPTH, "1") +
    "}";
    EXPECT_EQ (mcp_derived_headers (one_past, std::nullopt).size (), 2u);
}

// A method that cannot be a header line is left out rather than sent broken;
// it has no sentinel form.
TEST (McpDerivedHeaders, AMethodThatCannotBeAHeaderLineIsLeftOut) {
    const auto headers =
    mcp_derived_headers (R"({"method":"tools/call\r\nX-Injected: 1"})", std::nullopt);
    EXPECT_EQ (value_of (headers, "Mcp-Method"), std::nullopt);
    EXPECT_EQ (value_of (headers, "X-Injected"), std::nullopt);
}

// The spec's x-mcp-header example: `region` is mirrored, `query` is not.
TEST (McpDerivedHeaders, MirrorAnAnnotatedArgument) {
    const auto headers = mcp_derived_headers (kToolsCall, execute_sql_tool ());
    EXPECT_EQ (headers.back (), (HeaderLine{ "Mcp-Param-Region", "us-west1" }));
    EXPECT_EQ (headers.size (), 5u);
}

TEST (McpDerivedHeaders, ANonAsciiArgumentTakesTheBase64Sentinel) {
    const auto headers = mcp_derived_headers (
    R"({"method":"tools/call","params":{"name":"execute_sql","arguments":{"region":"Hello, 世界"}}})",
    execute_sql_tool ());
    EXPECT_EQ (value_of (headers, "Mcp-Param-Region"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
}

// The spec's table of what is mirrored and what is omitted, and its type
// conversion for an integer and a boolean, on a nested property.
TEST (McpDerivedHeaders, MirrorOnlyAPresentPrimitiveAtTheAnnotatedPath) {
    const auto tool = read_mcp_tool (nlohmann::json::parse (R"({"name":"t","inputSchema":{
        "properties":{"n":{"type":"integer","x-mcp-header":"N"},
          "flag":{"type":"boolean","x-mcp-header":"Flag"},
          "gone":{"type":"string","x-mcp-header":"Gone"},
          "nil":{"type":"string","x-mcp-header":"Nil"},
          "deep":{"type":"object","properties":{"zone":{"type":"string","x-mcp-header":"Zone"}}}}}})"));
    ASSERT_HAS_VALUE (tool) << tool.error ();

    const auto headers = mcp_derived_headers (
    R"({"method":"tools/call","params":{"name":"t","arguments":{"n":-7,"flag":false,"nil":null,"deep":{"zone":"z1"}}}})",
    *tool);
    EXPECT_EQ (value_of (headers, "Mcp-Param-N"), "-7");
    EXPECT_EQ (value_of (headers, "Mcp-Param-Flag"), "false");
    EXPECT_EQ (value_of (headers, "Mcp-Param-Zone"), "z1");
    EXPECT_EQ (value_of (headers, "Mcp-Param-Gone"), std::nullopt);
    EXPECT_EQ (value_of (headers, "Mcp-Param-Nil"), std::nullopt);
}

// A stored schema describes one tool: a call naming another, or a request with
// no stored tool, mirrors nothing.
TEST (McpDerivedHeaders, MirrorNothingWithoutTheCalledToolsSchema) {
    const std::string other_tool =
    R"({"method":"tools/call","params":{"name":"other","arguments":{"region":"us-west1"}}})";
    EXPECT_EQ (value_of (mcp_derived_headers (other_tool, execute_sql_tool ()), "Mcp-Param-Region"),
    std::nullopt);
    EXPECT_EQ (value_of (mcp_derived_headers (kToolsCall, std::nullopt), "Mcp-Param-Region"),
    std::nullopt);
}

// The spec's encoding table, row for row.
TEST (McpHeaderValue, EncodesWhatIsNotPlainAsciiAsTheSpecTableDoes) {
    EXPECT_EQ (mcp_header_value ("us-west1"), "us-west1");
    EXPECT_EQ (mcp_header_value ("Hello, 世界"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
    EXPECT_EQ (mcp_header_value (" padded "), "=?base64?IHBhZGRlZCA=?=");
    EXPECT_EQ (mcp_header_value ("line1\nline2"), "=?base64?bGluZTEKbGluZTI=?=");
    EXPECT_EQ (mcp_header_value ("=?base64?literal?="), "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
    // Spelled in two pieces: `?` `?` `=` together is a trigraph to the lexer.
    EXPECT_EQ (mcp_header_value (""),
    "=?base64?"
    "?=");
}

// ---------------------------------------------------------------------------
// The step label (#3829).
// ---------------------------------------------------------------------------

// A call names what `Mcp-Name` would mirror, written bare or as an envelope.
// Mutation check: return `*method` alone after the name lookup in
// `mcp_step_label` and this reddens.
TEST (McpStepLabel, NamesTheMethodAndWhatItsMcpNameMirrors) {
    EXPECT_EQ (mcp_step_label (kToolsCall), "tools/call execute_sql");
    EXPECT_EQ (mcp_step_label (R"({"jsonrpc":"2.0","id":7,"method":"prompts/get","params":{"name":"greet"}})"),
    "prompts/get greet");
    EXPECT_EQ (mcp_step_label (R"({"method":"resources/read","params":{"uri":"file:///app/config.json"}})"),
    "resources/read file:///app/config.json");
}

// A method with no name member is labelled by the method, whatever `params`
// happens to hold.
TEST (McpStepLabel, AMethodThatNamesNothingIsTheMethodAlone) {
    EXPECT_EQ (mcp_step_label (R"({"method":"tools/list"})"), "tools/list");
    EXPECT_EQ (mcp_step_label (R"({"method":"tools/list","params":{"name":"not-a-target"}})"),
    "tools/list");
}

// A name a data row or the iteration binds is a different call per iteration,
// and so is a missing or empty one: the method is all one label can say.
TEST (McpStepLabel, ANameNotFixedAtPlanTimeIsTheMethodAlone) {
    EXPECT_EQ (mcp_step_label (R"({"method":"tools/call","params":{"name":"{{data.tool}}"}})"),
    "tools/call");
    EXPECT_EQ (mcp_step_label (R"({"method":"tools/call","params":{"name":"run_{{$vu}}"}})"),
    "tools/call");
    EXPECT_EQ (mcp_step_label (R"({"method":"tools/call","params":{"name":""}})"), "tools/call");
    EXPECT_EQ (mcp_step_label (R"({"method":"tools/call","params":{"name":7}})"), "tools/call");
    EXPECT_EQ (mcp_step_label (R"({"method":"tools/call"})"), "tools/call");
}

// Text that is not one object, or names no usable method, gets no label.
TEST (McpStepLabel, ACallWithNoReadableMethodHasNoLabel) {
    EXPECT_EQ (mcp_step_label (R"({"method":{{m}}})"), "");
    EXPECT_EQ (mcp_step_label (""), "");
    EXPECT_EQ (mcp_step_label (R"(["tools/call"])"), "");
    EXPECT_EQ (mcp_step_label (R"({"params":{"name":"search"}})"), "");
    EXPECT_EQ (mcp_step_label (R"({"method":"{{method}}","params":{"name":"search"}})"), "");
    const std::string one_past = R"({"method":"tools/call","params":)" +
    vayu::tests::nested_object_text (
    vayu::core::constants::request_body::MAX_JSON_DEPTH, "1") +
    "}";
    EXPECT_EQ (mcp_step_label (one_past), "");
}

// ---------------------------------------------------------------------------
// The stored tool.
// ---------------------------------------------------------------------------

TEST (McpTool, ReadsTheAnnotationsReachableThroughProperties) {
    const auto tool = read_mcp_tool (vayu::tests::execute_sql_tool_json ());
    ASSERT_HAS_VALUE (tool) << tool.error ();
    EXPECT_EQ (tool->name, "execute_sql");
    ASSERT_EQ (tool->param_headers.size (), 1u);
    EXPECT_EQ (tool->param_headers[0].path, std::vector<std::string>{ "region" });
    EXPECT_EQ (tool->param_headers[0].header, "Region");

    // A tool named without a schema mirrors nothing and is still a tool.
    const auto bare = read_mcp_tool (nlohmann::json{ { "name", "t" } });
    ASSERT_HAS_VALUE (bare) << bare.error ();
    EXPECT_TRUE (bare->param_headers.empty ());
}

TEST (McpTool, RefusesWhatNoSendCouldMirror) {
    const auto refusal = [] (const char* text) {
        const auto tool = read_mcp_tool (nlohmann::json::parse (text));
        return tool ? std::string () : tool.error ();
    };
    EXPECT_NE (refusal (R"("execute_sql")"), "");
    EXPECT_NE (refusal (R"({"inputSchema":{}})"), "");
    EXPECT_NE (refusal (R"({"name":""})"), "");
    EXPECT_NE (refusal (R"({"name":"t","inputSchema":[]})"), "");
    EXPECT_NE (
    refusal (R"({"name":"t","inputSchema":{"properties":{"a":{"x-mcp-header":7}}}})"), "");
    EXPECT_NE (
    refusal (R"({"name":"t","inputSchema":{"properties":{"a":{"x-mcp-header":""}}}})"), "");
    EXPECT_NE (refusal (R"({"name":"t","inputSchema":{"properties":{"a":{"x-mcp-header":"Bad Name"}}}})"),
    "");
    const std::string repeated = refusal (R"({"name":"t","inputSchema":{"properties":{
        "a":{"x-mcp-header":"Region"},"b":{"x-mcp-header":"REGION"}}}})");
    EXPECT_NE (repeated.find ("'b'"), std::string::npos) << repeated;
}

// The payload reader is where every send gets the tool: a valid one is read,
// a malformed one refuses the send, and another mode's is left unread.
TEST (McpTool, IsReadOffTheBodyOfAnMcpPayloadOnly) {
    nlohmann::json payload{ { "method", "POST" }, { "url", "http://x.test/mcp" },
        { "body",
        { { "mode", "mcp" }, { "content", kToolsCall },
        { "mcpTool", vayu::tests::execute_sql_tool_json () } } } };
    auto read = vayu::json::deserialize_request (payload);
    ASSERT_TRUE (read.is_ok ()) << read.error ().message;
    const auto& tool = read.value ().body.mcp_tool;
    ASSERT_HAS_VALUE (tool);
    EXPECT_EQ (tool->name, "execute_sql");

    payload["body"]["mcpTool"] = { { "name", 7 } };
    auto refused               = vayu::json::deserialize_request (payload);
    ASSERT_FALSE (refused.is_ok ());
    EXPECT_NE (refused.error ().message.find ("mcpTool.name"), std::string::npos);

    payload["body"]["mode"] = "jsonrpc";
    auto other_mode         = vayu::json::deserialize_request (payload);
    ASSERT_TRUE (other_mode.is_ok ()) << other_mode.error ().message;
    EXPECT_FALSE (other_mode.value ().body.mcp_tool.has_value ());
}

// ---------------------------------------------------------------------------
// The header list: the same precedence as the body-implied Content-Type.
// ---------------------------------------------------------------------------

struct Built {
    std::vector<std::string> lines;
    HeaderList sent;
};

Built build (const Request& request) {
    Built built;
    curl_slist* list =
    detail::build_request_header_list (request, DefaultHeaderPolicy{}, &built.sent);
    for (curl_slist* node = list; node != nullptr; node = node->next) {
        built.lines.emplace_back (node->data);
    }
    curl_slist_free_all (list);
    return built;
}

TEST (McpHeaderList, DerivedHeadersAreSentAndRecorded) {
    Request request       = mcp_request ("http://x.test/mcp", kToolsCall);
    request.body.mcp_tool = execute_sql_tool ();
    const Built built     = build (request);
    for (const auto& [name, value] :
    mcp_derived_headers (wire_body_bytes (request), request.body.mcp_tool)) {
        std::string line = name;
        line += ": ";
        line += value;
        EXPECT_EQ (built.sent.at (name), value) << name;
        EXPECT_NE (std::find (built.lines.begin (), built.lines.end (), line),
        built.lines.end ())
        << name;
    }
    EXPECT_EQ (built.sent.at ("Mcp-Param-Region"), "us-west1");
}

// A header the caller wrote wins, case-insensitively, and is sent once.
TEST (McpHeaderList, ACallerWrittenHeaderWins) {
    Request request = mcp_request ("http://x.test/mcp", kToolsCall);
    request.headers.add ("mcp-method", "hand/typed");
    const Built built = build (request);
    EXPECT_EQ (built.sent.at ("Mcp-Method"), "hand/typed");
    EXPECT_EQ (std::count_if (built.lines.begin (), built.lines.end (),
               [] (const std::string& line) {
                   return utils::ascii_lower (line).starts_with ("mcp-method:");
               }),
    1);
}

// `disabledSystemHeaders` refuses a derived header the way it refuses the
// implied Content-Type, read through the payload reader every send uses. A
// refused `Accept` also keeps libcurl's own `*/*` off.
TEST (McpHeaderList, DisabledSystemHeadersRemoveADerivedOne) {
    auto read = vayu::json::deserialize_request (
    nlohmann::json{ { "method", "POST" }, { "url", "http://x.test/mcp" },
    { "body", { { "mode", "mcp" }, { "content", kToolsCall } } },
    { "disabledSystemHeaders", { "mcp-name", "accept" } } });
    ASSERT_TRUE (read.is_ok ()) << read.error ().message;
    const Built built = build (read.value ());
    EXPECT_FALSE (built.sent.contains ("Mcp-Name"));
    EXPECT_FALSE (built.sent.contains ("Accept"));
    EXPECT_NE (std::find (built.lines.begin (), built.lines.end (), "Accept:"),
    built.lines.end ());
    EXPECT_EQ (built.sent.at ("Mcp-Method"), "tools/call");
}

// Only an `mcp` body derives these: the same call as `jsonrpc` derives none.
TEST (McpHeaderList, AnotherModeDerivesNone) {
    Request request   = mcp_request ("http://x.test/mcp", kToolsCall);
    request.body.mode = BodyMode::JsonRpc;
    const Built built = build (request);
    EXPECT_FALSE (built.sent.contains ("Mcp-Method"));
    EXPECT_FALSE (built.sent.contains ("Accept"));
}

// A correlation id cannot be configured under a name an `mcp` body derives,
// or the request would carry it twice.
TEST (McpHeaderList, ACorrelationIdCannotTakeADerivedName) {
    for (const char* name : { "Accept", "MCP-Protocol-Version", "mcp-method",
         "Mcp-Name", "Mcp-Param-Region" }) {
        EXPECT_TRUE (unusable_header_name (name).has_value ()) << name;
    }
    EXPECT_FALSE (unusable_header_name ("X-Mcp-Trace").has_value ());
}

// ---------------------------------------------------------------------------
// The wire, against a server that checks headers against the body.
// ---------------------------------------------------------------------------

class McpSendTest : public ::testing::Test {
    protected:
    void SetUp () override {
        global_init ();
        server_ = std::make_unique<McpFixtureServer> ();
    }

    void TearDown () override {
        server_.reset ();
        global_cleanup ();
    }

    /// A stored-request payload as `POST /execute` receives it.
    nlohmann::json payload (const std::string& content) const {
        return nlohmann::json{ { "method", "POST" }, { "url", server_->url () },
            { "body",
            { { "mode", "mcp" }, { "content", content },
            { "mcpTool", vayu::tests::execute_sql_tool_json () } } } };
    }

    /// One design send of @p json, through the exchange `POST /execute` runs.
    routes::ExchangeOutcome design_send (const nlohmann::json& json) {
        auto request = vayu::json::deserialize_request (json);
        if (!request.is_ok ()) {
            ADD_FAILURE () << request.error ().message;
            return {};
        }
        vayu::runtime::ScriptEngine engine;
        CookieJar jar;
        routes::ScriptVariableScopes scopes;
        routes::ExchangeInputs inputs;
        inputs.request = std::move (request).value ();
        return routes::execute_exchange (engine, jar, "", scopes, std::move (inputs));
    }

    std::unique_ptr<McpFixtureServer> server_;
};

// The acceptance shape: a bare `tools/call` with no header typed by hand is
// accepted, and the record names what was mirrored. Mutation check: stop
// deriving `Mcp-Name` and the server answers 400 -32020.
TEST_F (McpSendTest, ADesignSendIsAcceptedWithNoHeaderTypedByHand) {
    const auto outcome = design_send (payload (kToolsCall));

    EXPECT_EQ (outcome.response.status_code, 200) << outcome.response.body;
    const auto& sent = outcome.response.request_headers;
    EXPECT_EQ (sent.at ("Mcp-Name"), "execute_sql");
    EXPECT_EQ (sent.at ("Mcp-Param-Region"), "us-west1");
    EXPECT_EQ (server_->header ("MCP-Protocol-Version"), "2026-07-28");
}

// The fixture is a real check, and the caller's header is what reaches it:
// a hand-typed name the body disagrees with is refused as the spec says.
TEST_F (McpSendTest, AHeaderTheBodyDisagreesWithIsAHeaderMismatch) {
    auto json = payload (kToolsCall);
    json["headers"] =
    nlohmann::json::array ({ { { "name", "Mcp-Name" }, { "value", "wrong" } } });
    const auto outcome = design_send (json);

    EXPECT_EQ (outcome.response.status_code, 400);
    const auto reply = nlohmann::json::parse (outcome.response.body, nullptr, false);
    EXPECT_EQ (reply["error"]["code"], -32020) << outcome.response.body;
    EXPECT_EQ (server_->header ("Mcp-Name"), "wrong");
}

// A non-ASCII argument arrives in the sentinel form and the server, decoding
// it, finds it equal to the body.
TEST_F (McpSendTest, ANonAsciiArgumentIsAcceptedInTheSentinelForm) {
    const auto outcome = design_send (payload (
    R"({"method":"tools/call","params":{"name":"execute_sql","arguments":{"region":"Zürich"}}})"));

    EXPECT_EQ (outcome.response.status_code, 200) << outcome.response.body;
    EXPECT_EQ (server_->header ("Mcp-Param-Region"), "=?base64?WsO8cmljaA==?=");
}

// The load driver builds its list in the same place, so a load run is
// accepted too.
TEST_F (McpSendTest, TheLoadDriverSendsTheSameHeaders) {
    auto request = vayu::json::deserialize_request (payload (kToolsCall));
    ASSERT_TRUE (request.is_ok ()) << request.error ().message;
    EventLoop loop;
    loop.start ();
    auto result = loop.submit_async (std::move (request).value ()).future.get ();
    loop.stop ();

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (result.value ().status_code, 200) << result.value ().body;
    EXPECT_EQ (server_->header ("Mcp-Param-Region"), "us-west1");
}

} // namespace
} // namespace vayu::http
