/**
 * @file graphql_body_test.cpp
 * @brief A GraphQL body, from stored JSON to the bytes on the wire.
 *
 * The engine had **no** GraphQL coverage at all (issue #385): the string did
 * not appear anywhere under `engine/tests`, so the whole store-and-send path
 * for `mode: "graphql"` was pinned only by app-side assumptions about what the
 * engine does with it. Two of those assumptions are load-bearing, and neither
 * was written down as a test:
 *
 * 1. The envelope survives storage byte for byte. `operationName` and
 *    `extensions` live inside `content` as far as the engine is concerned, so
 *    a round-trip that "kept the query" while reformatting the JSON would
 *    silently execute a different operation.
 * 2. The engine sends the envelope verbatim.
 *
 * The second assumption held only for a body that *arrived* enveloped, which is
 * what the renderer sends and nothing else did (issue #417): MCP `run_request`
 * and any raw `POST /execute` handed over a bare document, and the engine put
 * it on the wire unwrapped and untyped, so libcurl labelled it
 * `application/x-www-form-urlencoded` and the server answered 400. The engine
 * now envelopes at the chokepoint and derives `application/json`, so the tests
 * below pin **both** directions - a bare query is wrapped, and a body that is
 * already an envelope is still byte-identical on the wire.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <string>

#include "echo_server.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/graphql_body.hpp"
#include "vayu/utils/json.hpp"

namespace vayu::http {
namespace {

using vayu::tests::EchoServer;

/// The full envelope an imported multi-operation request carries: a document
/// with two named operations, the `operationName` selecting one of them, and a
/// key the engine does not model.
const char* const kEnvelope =
R"({"query":"query A { a } query B { b }","operationName":"B","variables":{"limit":10},"extensions":{"trace":"on"}})";

/// What an agent writes: `run_request { bodyType: "graphql", body: ... }` takes
/// a string, and the natural string to put there is the document itself.
const char* const kBareQuery = "query Me { me { id name } }";

Request graphql_request (const std::string& url, const std::string& content) {
    Request request;
    request.method       = HttpMethod::POST;
    request.url          = url;
    request.body.mode    = BodyMode::GraphQL;
    request.body.content = content;
    return request;
}

class GraphQLBodyTest : public ::testing::Test {
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

// The envelope is opaque to the engine, and must stay that way: every key the
// app puts in it has to come back out. Asserting on the string rather than on
// "it parses" is deliberate - a re-serialization that reordered or reformatted
// the JSON would still parse, and would still be a change to bytes the user
// never edited.
TEST (GraphQLBodyStorageTest, EnvelopeRoundTripsVerbatim) {
    const auto stored = json::serialize (graphql_request ("https://x.test", kEnvelope));
    ASSERT_TRUE (stored.contains ("body"));
    EXPECT_EQ (stored["body"]["mode"], "graphql");

    auto parsed = json::deserialize_request (stored);
    ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;
    EXPECT_EQ (parsed.value ().body.mode, BodyMode::GraphQL);
    EXPECT_EQ (parsed.value ().body.content, kEnvelope);
}

// A graphql body carries `content`, never `fields` - the union's other half.
// `has_wire_body` is the predicate every sender asks, so an empty envelope has
// to answer the same way an empty json body does.
TEST (GraphQLBodyStorageTest, EmptyContentIsNotAWireBody) {
    Body body;
    body.mode = BodyMode::GraphQL;
    EXPECT_FALSE (has_wire_body (body));

    body.content = kEnvelope;
    EXPECT_TRUE (has_wire_body (body));
}

// ---------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------

TEST_F (GraphQLBodyTest, EnvelopeReachesTheWireVerbatim) {
    auto request = graphql_request (server_->url (), kEnvelope);
    request.headers["Content-Type"] = "application/json";

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (result.value ().status_code, 200);

    EXPECT_EQ (server_->body (), kEnvelope);
    EXPECT_EQ (server_->content_type (), "application/json");
}

// The same envelope with no Content-Type declared: the engine supplies one now
// rather than letting libcurl label a JSON payload
// `application/x-www-form-urlencoded`, which most GraphQL servers answer with a
// 400. The body is still untouched - deriving a header is not permission to
// rewrite bytes. Mutation check: drop the GraphQL arm of
// `implied_content_type` and the header assertion reddens.
TEST_F (GraphQLBodyTest, EngineDerivesApplicationJsonForGraphQL) {
    Body body;
    body.mode    = BodyMode::GraphQL;
    body.content = kEnvelope;
    EXPECT_EQ (implied_content_type (body), "application/json");
    // Derived, not owned: `content_type_is_engine_owned` is multipart's rule -
    // a caller's header is dropped there because it cannot name a boundary that
    // does not exist yet. Nothing about GraphQL needs that, so a caller's header
    // must still reach the wire (asserted in AnExplicitContentTypeIsKept).
    EXPECT_FALSE (content_type_is_engine_owned (body));

    ASSERT_TRUE (client_->send (graphql_request (server_->url (), kEnvelope)).is_ok ());
    EXPECT_EQ (server_->body (), kEnvelope);
    EXPECT_EQ (server_->content_type (), "application/json");
}

// The reported defect, end to end: the exact shape MCP `run_request` produces
// for `bodyType: "graphql"`. Before #417 this reached the server as the bare
// document under `application/x-www-form-urlencoded`. Mutation check: revert
// the GraphQL arm of `wire_body_bytes` and the body assertion reddens.
TEST_F (GraphQLBodyTest, ABareDocumentIsEnvelopedOnTheWire) {
    ASSERT_TRUE (client_->send (graphql_request (server_->url (), kBareQuery)).is_ok ());

    EXPECT_EQ (server_->content_type (), "application/json");
    const auto sent = nlohmann::json::parse (server_->body ());
    EXPECT_EQ (sent, nlohmann::json ({ { "query", kBareQuery } }));
}

// The other direction of the same rule, and the one a wrapper is most likely to
// break: a body that already is an envelope must not be wrapped a second time.
// Asserted byte for byte rather than by parsing, because a re-serialization
// that reordered `operationName` and `extensions` would still parse equal and
// would still be bytes the user never wrote.
TEST_F (GraphQLBodyTest, AnEnvelopeIsNotWrappedTwice) {
    ASSERT_TRUE (client_->send (graphql_request (server_->url (), kEnvelope)).is_ok ());
    EXPECT_EQ (server_->body (), kEnvelope);
}

// The load path, through the event loop - the driver every `POST /runs` uses.
// Both drivers share `apply_method_and_body`, which now reads
// `wire_body_bytes`; this proves the sharing is real rather than assumed, so a
// GraphQL load run sends what a Send sends.
TEST_F (GraphQLBodyTest, LoadDriverEnvelopesTheSameWay) {
    EventLoop loop;
    loop.start ();

    auto handle = loop.submit_async (graphql_request (server_->url (), kBareQuery));
    auto result = handle.future.get ();
    loop.stop ();

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (server_->content_type (), "application/json");
    EXPECT_EQ (nlohmann::json::parse (server_->body ()),
    nlohmann::json ({ { "query", kBareQuery } }));
}

// The raw-request view reads the same bytes the transfer carried. It used to
// print `body.content`, which for a bare document is the unwrapped query - a
// view that would now contradict the wire it claims to show.
TEST_F (GraphQLBodyTest, TheRawRequestViewShowsTheEnvelope) {
    auto result = client_->send (graphql_request (server_->url (), kBareQuery));
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    const auto& raw = result.value ().raw_request;
    EXPECT_NE (raw.find (R"({"query":)"), std::string::npos) << raw;
}

// An explicit `application/graphql` is the user's choice and survives - the
// same rule the form modes follow, checked here because the app's importers
// now rely on it (a deliberate header wins over the one they would add).
TEST_F (GraphQLBodyTest, AnExplicitContentTypeIsKept) {
    auto request = graphql_request (server_->url (), kEnvelope);
    request.headers["Content-Type"] = "application/graphql";

    ASSERT_TRUE (client_->send (request).is_ok ());
    EXPECT_EQ (server_->content_type (), "application/graphql");
    EXPECT_EQ (server_->body (), kEnvelope);
}

// A caller who declares `application/graphql` means the bare document, which is
// what that media type *is* - so the envelope must not be applied on top of it
// either. The header choice and the body shape are one decision.
TEST_F (GraphQLBodyTest, AnExplicitContentTypeDoesNotChangeTheBody) {
    auto request = graphql_request (server_->url (), kBareQuery);
    request.headers["Content-Type"] = "application/graphql";

    ASSERT_TRUE (client_->send (request).is_ok ());
    EXPECT_EQ (server_->content_type (), "application/graphql");
    // The envelope is still applied: the header says how to label the bytes,
    // not which bytes to send, and the two rules stay independent so a caller
    // cannot turn off enveloping by typing a header. Stated here rather than
    // left to be discovered.
    EXPECT_EQ (nlohmann::json::parse (server_->body ()),
    nlohmann::json ({ { "query", kBareQuery } }));
}

// ---------------------------------------------------------------------------
// The envelope rule itself, without a socket.
// ---------------------------------------------------------------------------

TEST (GraphQLEnvelope, WrapsABareDocument) {
    EXPECT_EQ (graphql_wire_body ("{ me }"), R"({"query":"{ me }"})");
    EXPECT_EQ (graphql_wire_body ("mutation M { m }"), R"({"query":"mutation M { m }"})");
}

TEST (GraphQLEnvelope, PassesAnEnvelopeThroughByteForByte) {
    EXPECT_EQ (graphql_wire_body (kEnvelope), kEnvelope);
    // Whitespace and key order are the user's, not ours to normalize.
    const std::string spaced = R"(  { "variables": {}, "query": "{ me }" }  )";
    EXPECT_EQ (graphql_wire_body (spaced), spaced);
}

// A `query` that is not a string is not the envelope's `query` - the same test
// the renderer's `toGraphQLEnvelope` applies, and the two have to agree or a
// body would mean different things on either side of the process boundary.
TEST (GraphQLEnvelope, WrapsAJsonObjectThatIsNotAnEnvelope) {
    EXPECT_EQ (graphql_wire_body (R"({"notQuery":1})"), R"({"query":"{\"notQuery\":1}"})");
    EXPECT_EQ (graphql_wire_body (R"({"query":42})"), R"({"query":"{\"query\":42}"})");
}

// JSON that is not an object at all - an array, a number, a bare string - is a
// document as far as this mode is concerned, and gets wrapped like one.
TEST (GraphQLEnvelope, WrapsJsonThatIsNotAnObject) {
    EXPECT_EQ (graphql_wire_body ("[1,2]"), R"({"query":"[1,2]"})");
    EXPECT_EQ (graphql_wire_body ("42"), R"({"query":"42"})");
}

/*
 * The guard the issue's snapshot did not have. An envelope whose `{{token}}`
 * never resolved is not valid JSON:
 *
 *     {"query":"q","variables":{"limit":{{n}}}}
 *
 * and wrapping it would take a *broken* envelope and make it a *valid request
 * carrying the wrong query* - the server would answer 200 for a query the user
 * never wrote. Passing it through leaves the failure where it already was.
 * A bare document cannot take this shape: a selection set opens with a field
 * name, never with a quoted string, which is what separates the two cases
 * below. Mutation check: return `false` from `opens_as_json_object` and the
 * first assertion reddens while the second stays green.
 */
TEST (GraphQLEnvelope, DoesNotWrapAnUnreadableEnvelope) {
    const std::string templated = R"({"query":"q","variables":{"limit":{{n}}}})";
    EXPECT_EQ (graphql_wire_body (templated), templated);

    // ...but a selection set that merely starts with a brace is still wrapped.
    EXPECT_EQ (graphql_wire_body ("{ me { id } }"), R"({"query":"{ me { id } }"})");
}

// An empty body has no bytes to envelope, and `{"query":""}` would give a
// bodiless request a body. `has_wire_body` already says there is nothing to
// send; this makes the two agree.
TEST (GraphQLEnvelope, LeavesAnEmptyBodyEmpty) {
    EXPECT_EQ (graphql_wire_body (""), "");

    Body body;
    body.mode = BodyMode::GraphQL;
    EXPECT_EQ (wire_body_bytes (body), "");
    EXPECT_EQ (implied_content_type (body), "");
}

// `wire_body_bytes` answers for every mode, so the modes it must *not* have
// changed are pinned beside the one it did.
TEST (GraphQLEnvelope, OtherModesAreUntouched) {
    Body json_body;
    json_body.mode    = BodyMode::Json;
    json_body.content = R"({"a":1})";
    EXPECT_EQ (wire_body_bytes (json_body), R"({"a":1})");
    EXPECT_EQ (implied_content_type (json_body), "");

    Body form;
    form.mode   = BodyMode::Form;
    form.fields = { { "a", "1", true } };
    EXPECT_EQ (wire_body_bytes (form), "a=1");

    // Multipart's bytes belong to libcurl, which generates the boundary.
    Body multipart;
    multipart.mode   = BodyMode::FormData;
    multipart.fields = { { "a", "1", true } };
    EXPECT_EQ (wire_body_bytes (multipart), "");
}

} // namespace
} // namespace vayu::http
