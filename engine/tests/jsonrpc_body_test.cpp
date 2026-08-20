/**
 * @file jsonrpc_body_test.cpp
 * @brief A JSON-RPC body, from stored JSON to the bytes on the wire.
 *
 * The mode's whole value is one rule - a bare call is completed into a frame a
 * server will answer, an envelope the caller wrote is not touched - and the
 * rule is only worth anything if it holds at the *chokepoint*, for every
 * client. GraphQL's version of it was written in the renderer first, so MCP
 * `run_request` and raw `POST /execute` callers were answered with a 400 until
 * #417 moved it engine-side. This mode is built there to begin with, and the
 * tests below pin both halves of the rule on both drivers: the design-run
 * `Client::send` and the load-run `EventLoop`.
 *
 * The `id` deserves its own note. It is the constant `1`, never a random or
 * time-derived value, because a load run sends the same call thousands of times
 * and a replay has to send what it replays - a per-send id would make every
 * request body differ from every other and turn a diff of two runs into noise.
 * A caller who needs distinct ids writes them (or a `{{variable}}`) into a full
 * envelope, which reaches the wire untouched.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <string>

#include "echo_server.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/jsonrpc_body.hpp"
#include "vayu/utils/json.hpp"

namespace vayu::http {
namespace {

using vayu::tests::EchoServer;

/// A full frame, as a caller who knows the protocol writes it: their own `id`,
/// their own key order, and a member the spec does not define.
const char* const kEnvelope =
R"({"jsonrpc":"2.0","id":42,"method":"eth_getBalance","params":["0xabc","latest"],"meta":{"trace":"on"}})";

/// What the request builder's editor actually holds between sends, and what an
/// agent writes into `run_request { bodyType: "jsonrpc", body: ... }`: the
/// call, without the ceremony around it.
const char* const kBareCall = R"({"method":"eth_blockNumber","params":[]})";

Request jsonrpc_request (const std::string& url, const std::string& content) {
    Request request;
    request.method       = HttpMethod::POST;
    request.url          = url;
    request.body.mode    = BodyMode::JsonRpc;
    request.body.content = content;
    return request;
}

class JsonRpcBodyTest : public ::testing::Test {
    protected:
    void SetUp () override {
        global_init ();
        server_ = std::make_unique<EchoServer> ();
        client_ = std::make_unique<Client> ();
    }

    void TearDown () override {
        client_.reset ();
        server_.reset ();
        global_cleanup ();
    }

    std::unique_ptr<EchoServer> server_;
    std::unique_ptr<Client> client_;
};

// ---------------------------------------------------------------------------
// Storage.
// ---------------------------------------------------------------------------

// The content is opaque to storage, and must stay that way: the envelope is
// completed at wire time, so anything storage reformats is a change to bytes
// the user never edited. Asserted on the string rather than on "it parses" for
// that reason - a re-serialization that sorted the members would still parse.
TEST (JsonRpcBodyStorageTest, ContentRoundTripsVerbatim) {
    const auto stored = json::serialize (jsonrpc_request ("https://x.test", kEnvelope));
    ASSERT_TRUE (stored.contains ("body"));
    EXPECT_EQ (stored["body"]["mode"], "jsonrpc");

    auto parsed = json::deserialize_request (stored);
    ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;
    EXPECT_EQ (parsed.value ().body.mode, BodyMode::JsonRpc);
    EXPECT_EQ (parsed.value ().body.content, kEnvelope);
}

// A jsonrpc body carries `content`, never `fields`. `has_wire_body` is the
// predicate every sender asks, so an empty call has to answer the way an empty
// json body does.
TEST (JsonRpcBodyStorageTest, EmptyContentIsNotAWireBody) {
    Body body;
    body.mode = BodyMode::JsonRpc;
    EXPECT_FALSE (has_wire_body (body));

    body.content = kBareCall;
    EXPECT_TRUE (has_wire_body (body));
}

// ---------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------

// The reported shape, end to end: what an agent sends is completed into a frame
// a server will answer. Mutation check: revert the JsonRpc arm of
// `wire_body_bytes` and both assertions redden.
TEST_F (JsonRpcBodyTest, ABareCallIsEnvelopedOnTheWire) {
    ASSERT_TRUE (client_->send (jsonrpc_request (server_->url (), kBareCall)).is_ok ());

    EXPECT_EQ (server_->content_type (), "application/json");
    const auto sent = nlohmann::json::parse (server_->body ());
    EXPECT_EQ (sent["jsonrpc"], "2.0");
    EXPECT_EQ (sent["id"], 1);
    EXPECT_EQ (sent["method"], "eth_blockNumber");
    EXPECT_TRUE (sent["params"].is_array ());
}

// The other direction, and the one a completer is most likely to break. Byte
// for byte rather than by parsing: the caller's `id` is what they match the
// response against, and their key order and extra members are theirs.
TEST_F (JsonRpcBodyTest, AnEnvelopeReachesTheWireVerbatim) {
    ASSERT_TRUE (client_->send (jsonrpc_request (server_->url (), kEnvelope)).is_ok ());
    EXPECT_EQ (server_->body (), kEnvelope);
    EXPECT_EQ (server_->content_type (), "application/json");
}

// A caller's Content-Type survives, the same rule the other content modes
// follow. Mutation check: drop the JsonRpc arm of `implied_content_type` and
// the derived-header assertion reddens while this one stays green.
TEST_F (JsonRpcBodyTest, AnExplicitContentTypeIsKept) {
    auto request = jsonrpc_request (server_->url (), kEnvelope);
    request.headers["Content-Type"] = "application/json-rpc";

    ASSERT_TRUE (client_->send (request).is_ok ());
    EXPECT_EQ (server_->content_type (), "application/json-rpc");
    EXPECT_EQ (server_->body (), kEnvelope);
}

TEST_F (JsonRpcBodyTest, EngineDerivesApplicationJson) {
    Body body;
    body.mode    = BodyMode::JsonRpc;
    body.content = kBareCall;
    EXPECT_EQ (implied_content_type (body), "application/json");
    // Derived, not owned: `content_type_is_engine_owned` is multipart's rule,
    // and a caller's header must still reach the wire (above).
    EXPECT_FALSE (content_type_is_engine_owned (body));
}

// The load path, through the event loop - the driver every `POST /runs` uses.
// Both drivers share `apply_method_and_body`, which reads `wire_body_bytes`;
// this proves the sharing is real rather than assumed, so a JSON-RPC load run
// sends what a Send sends, id included.
TEST_F (JsonRpcBodyTest, LoadDriverEnvelopesTheSameWay) {
    EventLoop loop;
    loop.start ();

    auto handle = loop.submit_async (jsonrpc_request (server_->url (), kBareCall));
    auto result = handle.future.get ();
    loop.stop ();

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (server_->content_type (), "application/json");
    EXPECT_EQ (nlohmann::json::parse (server_->body ()),
    nlohmann::json::parse (jsonrpc_wire_body (kBareCall)));
}

// The raw-request view reads the bytes the transfer carried, not `body.content`
// - for a bare call those are different strings, and a view that showed the
// stored one would contradict the wire it claims to show.
TEST_F (JsonRpcBodyTest, TheRawRequestViewShowsTheEnvelope) {
    auto result = client_->send (jsonrpc_request (server_->url (), kBareCall));
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    const auto& raw = result.value ().raw_request;
    EXPECT_NE (raw.find (R"("jsonrpc":"2.0")"), std::string::npos) << raw;
}

// ---------------------------------------------------------------------------
// The envelope rule itself, without a socket.
// ---------------------------------------------------------------------------

TEST (JsonRpcEnvelope, CompletesABareCall) {
    EXPECT_EQ (jsonrpc_wire_body (R"({"method":"ping"})"),
    R"({"method":"ping","jsonrpc":"2.0","id":1})");
    EXPECT_EQ (jsonrpc_wire_body (R"({"method":"sum","params":[1,2]})"),
    R"({"method":"sum","params":[1,2],"jsonrpc":"2.0","id":1})");
}

// The members the caller wrote keep the order they wrote them in, and the two
// the engine adds go on the end. Object members are unordered by definition, so
// rebuilding the object to put `jsonrpc` first would reorder the caller's keys
// to no purpose.
TEST (JsonRpcEnvelope, KeepsTheCallersKeyOrder) {
    EXPECT_EQ (jsonrpc_wire_body (R"({"params":{"b":1,"a":2},"method":"z"})"),
    R"({"params":{"b":1,"a":2},"method":"z","jsonrpc":"2.0","id":1})");
}

// A `jsonrpc` member that is a string is the caller's frame, whatever else it
// holds. Passed through byte for byte - whitespace and key order included,
// since neither is ours to normalize.
TEST (JsonRpcEnvelope, PassesAnEnvelopeThroughByteForByte) {
    EXPECT_EQ (jsonrpc_wire_body (kEnvelope), kEnvelope);
    const std::string spaced = R"(  { "id": 7, "jsonrpc": "2.0", "method": "m" }  )";
    EXPECT_EQ (jsonrpc_wire_body (spaced), spaced);
}

// An existing id is never re-stamped: it is what the caller matches the
// response against, and a load run whose ids all changed would be answered
// correctly and read as wrong.
TEST (JsonRpcEnvelope, AnEnvelopeIsNotCompletedTwice) {
    const std::string frame = R"({"jsonrpc":"2.0","id":42,"method":"m"})";
    EXPECT_EQ (jsonrpc_wire_body (frame), frame);
}

/*
 * A notification is a frame with **no** `id`, and the server must not answer
 * it. That makes the absent id a decision the caller made rather than one they
 * forgot, and the string-typed `jsonrpc` member is what tells the two apart: a
 * frame that declares the version is finished, a call that does not is not.
 *
 * Mutation check: relax `is_full_envelope` to `contains("jsonrpc")` and this
 * stays green, so the type check is pinned by the next test instead.
 */
TEST (JsonRpcEnvelope, LeavesANotificationWithoutAnId) {
    const std::string notification = R"({"jsonrpc":"2.0","method":"notify"})";
    EXPECT_EQ (jsonrpc_wire_body (notification), notification);
}

/*
 * `{"jsonrpc": 2.0}` is the JSON *number* 2.0, and the spec asks for the string
 * "2.0" - a server answers that frame with an Invalid Request error. So the
 * member's type is what is checked, not its presence, and a frame carrying the
 * number is completed rather than sent as the invalid request it is.
 *
 * Mutation check: relax `is_full_envelope` to `version != call.end ()` and this
 * reddens - the body comes back verbatim with `2.0` still a number.
 */
TEST (JsonRpcEnvelope, StampsTheVersionOverANonStringOne) {
    EXPECT_EQ (jsonrpc_wire_body (R"({"jsonrpc":2.0,"id":9,"method":"m"})"),
    R"({"jsonrpc":"2.0","id":9,"method":"m"})");
}

// A top-level array is a batch call: every element carries its own envelope,
// and there is no single one to complete. It is passed through for the same
// reason any non-object is - there is nothing here to add members to.
TEST (JsonRpcEnvelope, PassesABatchArrayThroughVerbatim) {
    const std::string batch = R"([{"jsonrpc":"2.0","id":1,"method":"a"},{"method":"b"}])";
    EXPECT_EQ (jsonrpc_wire_body (batch), batch);

    EXPECT_EQ (jsonrpc_wire_body ("42"), "42");
    EXPECT_EQ (jsonrpc_wire_body (R"("a string")"), R"("a string")");
}

/*
 * The `{{variable}}` guard. A body that is a template is not JSON at storage
 * time; composition resolves it, and only then does this run. Text that never
 * resolved reaches the wire as typed rather than being turned into a
 * well-formed request carrying nonsense - the same choice `graphql_wire_body`
 * makes, and for the same reason: acting on ignorance is not acting on
 * knowledge.
 *
 * Mutation check: drop the `!call.is_object ()` guard and the first assertion
 * reddens - an unparseable body parses to a discarded value, which is what that
 * guard catches it as. The second assertion shows what the resolved text is
 * then completed into.
 */
TEST (JsonRpcEnvelope, PassesUnparseableContentThroughAndCompletesTheResolvedText) {
    const std::string templated = R"({"method":"m","params":{{args}}})";
    EXPECT_EQ (jsonrpc_wire_body (templated), templated);

    const std::string resolved = R"({"method":"m","params":{"n":1}})";
    EXPECT_EQ (jsonrpc_wire_body (resolved),
    R"({"method":"m","params":{"n":1},"jsonrpc":"2.0","id":1})");
}

// An empty body has no call to envelope, and `{"jsonrpc":"2.0","id":1}` would
// give a bodiless request a body. `has_wire_body` already says there is nothing
// to send; this makes the two agree.
TEST (JsonRpcEnvelope, LeavesAnEmptyBodyEmpty) {
    EXPECT_EQ (jsonrpc_wire_body (""), "");

    Body body;
    body.mode = BodyMode::JsonRpc;
    EXPECT_EQ (wire_body_bytes (body), "");
    EXPECT_EQ (implied_content_type (body), "");
}

// `wire_body_bytes` answers for every mode, so the modes this one must *not*
// have changed are pinned beside it. GraphQL especially: the two now sit in
// adjacent arms of the same switch.
TEST (JsonRpcEnvelope, OtherModesAreUntouched) {
    Body json_body;
    json_body.mode    = BodyMode::Json;
    json_body.content = R"({"method":"m"})";
    // A `json` body naming a method is still not a JSON-RPC frame: no
    // `"jsonrpc"` and no `"id"` are added, which is the untouched half.
    EXPECT_EQ (wire_body_bytes (json_body), R"({"method":"m"})");
    // Same header as this mode since issue #884, arrived at differently: here
    // the engine wrote the envelope, there the mode simply is JSON.
    EXPECT_EQ (implied_content_type (json_body), "application/json");

    Body graphql;
    graphql.mode    = BodyMode::GraphQL;
    graphql.content = "{ me }";
    EXPECT_EQ (wire_body_bytes (graphql), R"({"query":"{ me }"})");

    Body form;
    form.mode   = BodyMode::Form;
    form.fields = { { "a", "1", true } };
    EXPECT_EQ (wire_body_bytes (form), "a=1");
}

} // namespace
} // namespace vayu::http
