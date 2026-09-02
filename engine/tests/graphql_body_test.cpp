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

#include <map>
#include <string>

#include "echo_server.hpp"
#include "optional_assert.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/graphql_body.hpp"
#include "vayu/http/url_parts.hpp"
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
    // The envelope is what this file is about, and a `json` body has none: its
    // bytes go out as written. It carries `application/json` since issue #889 -
    // the same header this mode derives, from a mode that does not rewrite.
    EXPECT_EQ (implied_content_type (json_body), "application/json");

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

// ---------------------------------------------------------------------------
// The GET transport (issue #1228).
//
// GraphQL-over-HTTP puts the document in the query string on a GET and in a
// JSON body on a POST. The engine used to send the envelope as a body on both,
// and a body on GET is undefined by that specification: the endpoint answered
// `400 Bad Request`, eleven bytes, with nothing saying why.
// ---------------------------------------------------------------------------

TEST (GraphQLGetTransport, ABareDocumentIsTheQueryParameter) {
    const auto parameters = graphql_get_parameters (kBareQuery);
    ASSERT_HAS_VALUE (parameters);
    EXPECT_EQ (*parameters, "query=" + percent_encode (kBareQuery));
}

// Every member the specification gives a parameter, carried as one: the
// document, the operation being selected, and the two JSON-encoded maps.
TEST (GraphQLGetTransport, AnEnvelopeSplitsIntoItsParameters) {
    const auto parameters = graphql_get_parameters (kEnvelope);
    ASSERT_HAS_VALUE (parameters);

    const auto params = parse_query_params (*parameters);
    std::map<std::string, std::string> by_name;
    for (const auto& param : params) {
        by_name[param.key] = param.value.value_or ("");
    }

    EXPECT_EQ (by_name["query"], percent_encode ("query A { a } query B { b }"));
    EXPECT_EQ (by_name["operationName"], percent_encode ("B"));
    // JSON-encoded, which is what the GET transport says these two are - not
    // flattened into `variables[limit]=10`, which no GraphQL server reads.
    EXPECT_EQ (by_name["variables"], percent_encode (R"({"limit":10})"));
    EXPECT_EQ (by_name["extensions"], percent_encode (R"({"trace":"on"})"));
    EXPECT_EQ (by_name.size (), 4U);
}

// An empty body has nothing to carry, and the request has no body frame
// either - it is simply a GET.
TEST (GraphQLGetTransport, EmptyContentCarriesNothing) {
    EXPECT_FALSE (graphql_get_parameters ("").has_value ());
}

// The three cases that keep the body transport rather than inventing a
// request. Envelope-shaped and unreadable is the same case
// `graphql_wire_body` passes through instead of wrapping: a `{{token}}` that
// went unresolved must not be split into parameters we guessed at.
TEST (GraphQLGetTransport, AnUnreadableEnvelopeKeepsTheBodyTransport) {
    EXPECT_FALSE (graphql_get_parameters (R"({"query": {{document}} )").has_value ());
}

// A member this transport has no parameter for. Dropping it would send a
// different request than the user wrote; the body carries it verbatim.
TEST (GraphQLGetTransport, AMemberWithNoParameterKeepsTheBodyTransport) {
    EXPECT_FALSE (
    graphql_get_parameters (R"({"query":"{ a }","sessionToken":"t"})").has_value ());
}

// A member of the wrong type is the same answer for the same reason - the
// specification's `variables` is a map, and a string there means something
// this side cannot re-encode faithfully.
TEST (GraphQLGetTransport, AMemberOfTheWrongTypeKeepsTheBodyTransport) {
    EXPECT_FALSE (
    graphql_get_parameters (R"({"query":"{ a }","variables":"{}"})").has_value ());
    EXPECT_FALSE (
    graphql_get_parameters (R"({"query":"{ a }","operationName":7})").has_value ());
}

// An explicit `null` is how a client says "no named operation" and "no
// variables", which the absent parameter says too - so it is dropped rather
// than sent as the four characters `null`.
TEST (GraphQLGetTransport, ExplicitNullsAreOmittedRatherThanSent) {
    const auto parameters = graphql_get_parameters (
    R"({"query":"{ a }","operationName":null,"variables":null})");
    ASSERT_HAS_VALUE (parameters);
    EXPECT_EQ (*parameters, "query=" + percent_encode ("{ a }"));
}

// ---------------------------------------------------------------------------
// What the request-level answers make of that.
// ---------------------------------------------------------------------------

// The whole rule in one place: no body frame, no derived Content-Type for a
// body that is not there, and a URL carrying the document. Mutation check:
// point any of the four back at `request.body` and one of these reddens.
TEST (GraphQLGetTransport, AGetCarriesTheDocumentInTheUrlAndSendsNoBody) {
    auto request = graphql_request ("https://example.com/graphql", kBareQuery);
    request.method = HttpMethod::GET;

    EXPECT_FALSE (has_wire_body (request));
    EXPECT_EQ (wire_body_bytes (request), "");
    EXPECT_EQ (implied_content_type (request), "");
    EXPECT_EQ (wire_url (request),
    "https://example.com/graphql?query=" + percent_encode (kBareQuery));
}

// Every other method is the JSON envelope it has always been. POST is the one
// the app sends and the one the specification names for a mutation.
TEST (GraphQLGetTransport, PostIsUnchanged) {
    const auto request = graphql_request ("https://example.com/graphql", kBareQuery);

    EXPECT_TRUE (has_wire_body (request));
    EXPECT_EQ (wire_body_bytes (request), graphql_wire_body (kBareQuery));
    EXPECT_EQ (implied_content_type (request), "application/json");
    EXPECT_EQ (wire_url (request), "https://example.com/graphql");
}

// A GET whose content cannot be split keeps the transport it had - which is a
// request that still fails against a strict server, but fails carrying what
// the user wrote rather than something this side invented.
TEST (GraphQLGetTransport, AGetWithAnUnreadableEnvelopeStillSendsItsBody) {
    auto request =
    graphql_request ("https://example.com/graphql", R"({"query": {{document}} )");
    request.method = HttpMethod::GET;

    EXPECT_TRUE (has_wire_body (request));
    EXPECT_EQ (wire_url (request), "https://example.com/graphql");
}

// The GET-with-body support that predates this (Elasticsearch-style search)
// is untouched: only a `graphql` body moves into the URL.
TEST (GraphQLGetTransport, AJsonBodyOnAGetIsStillABody) {
    Request request;
    request.method       = HttpMethod::GET;
    request.url          = "https://example.com/_search";
    request.body.mode    = BodyMode::Json;
    request.body.content = R"({"query":{"match_all":{}}})";

    EXPECT_TRUE (has_wire_body (request));
    EXPECT_EQ (wire_body_bytes (request), R"({"query":{"match_all":{}}})");
    EXPECT_EQ (wire_url (request), "https://example.com/_search");
}

// ---------------------------------------------------------------------------
// On the wire.
// ---------------------------------------------------------------------------

// The end-to-end shape of the fix: the server sees the document in the target
// it was asked for, and no body at all. Mutation check: revert
// `apply_method_and_body` to the body-level predicate and the body assertion
// reddens with the envelope this request no longer sends.
TEST_F (GraphQLBodyTest, AGetIsSentAsQueryParametersWithNoBody) {
    auto request   = graphql_request (server_->url (), kEnvelope);
    request.method = HttpMethod::GET;

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (result.value ().status_code, 200);

    EXPECT_EQ (server_->body (), "");
    EXPECT_EQ (server_->header ("Content-Length"), "");
    EXPECT_NE (server_->target ().find ("query=" + percent_encode ("query A { a } query B { b }")),
    std::string::npos)
    << server_->target ();
    EXPECT_NE (server_->target ().find ("operationName=B"), std::string::npos)
    << server_->target ();
}

// A query string the URL already carries survives, because it is often how the
// endpoint is addressed at all (an api key, a tenant).
TEST_F (GraphQLBodyTest, AGetKeepsTheQueryStringTheUrlAlreadyHad) {
    auto request = graphql_request (server_->url () + "?apikey=k", kBareQuery);
    request.method = HttpMethod::GET;

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_NE (server_->target ().find ("apikey=k"), std::string::npos)
    << server_->target ();
    EXPECT_NE (server_->target ().find ("query="), std::string::npos)
    << server_->target ();
}

// The load driver shares `apply_method_and_body` and `wire_url` with the
// single-request client, exactly as it shares the envelope - proved rather
// than assumed, the way `LoadDriverEnvelopesTheSameWay` proves the other half.
TEST_F (GraphQLBodyTest, TheLoadDriverUsesTheSameGetTransport) {
    auto request   = graphql_request (server_->url (), kBareQuery);
    request.method = HttpMethod::GET;

    EventLoop loop;
    loop.start ();
    auto handle = loop.submit_async (request);
    auto result = handle.future.get ();
    loop.stop ();

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (server_->body (), "");
    // The header, not just the body: httplib does not surface a body on a GET,
    // so `body()` alone would stay empty even for a request that carried one.
    // A `Content-Length` at all is a body frame.
    EXPECT_EQ (server_->header ("Content-Length"), "");
    EXPECT_NE (server_->target ().find ("query="), std::string::npos)
    << server_->target ();
}

// The raw-request view is built from the same two answers, so what it shows is
// what went out: the URL with the document in it, and no body beneath the
// headers.
TEST_F (GraphQLBodyTest, TheRawRequestViewShowsTheGetTransport) {
    auto request   = graphql_request (server_->url (), kBareQuery);
    request.method = HttpMethod::GET;

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    const std::string& raw = result.value ().raw_request;
    EXPECT_NE (raw.find ("query="), std::string::npos) << raw;
    EXPECT_EQ (raw.find (kBareQuery), std::string::npos) << raw;
}

} // namespace
} // namespace vayu::http
