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
 *    `extensions` live inside `content` as far as the engine is concerned, so a
 *    round-trip that "kept the query" while reformatting the JSON would silently
 *    execute a different operation.
 * 2. The engine sends the envelope verbatim and derives **no** Content-Type for
 *    it. That is the rule `implied_content_type` states - clients own the header
 *    for content modes - and it is why the app adds `application/json` when a
 *    request becomes GraphQL, and why the importers now do the same. If the
 *    engine ever started supplying one, that app-side work would be redundant;
 *    if it ever started rewriting the body, the envelope would stop matching
 *    what the panes show.
 */

#include <gtest/gtest.h>

#include <string>

#include "echo_server.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/utils/json.hpp"

namespace vayu::http {
namespace {

using vayu::tests::EchoServer;

/// The full envelope an imported multi-operation request carries: a document
/// with two named operations, the `operationName` selecting one of them, and a
/// key the engine does not model.
const char* const kEnvelope =
R"({"query":"query A { a } query B { b }","operationName":"B","variables":{"limit":10},"extensions":{"trace":"on"}})";

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

// The rule `implied_content_type` states, pinned from the outside: for a
// content mode the engine adds nothing, so a request that declares no
// Content-Type sends none of its own. This is precisely why an imported
// GraphQL request needed the header written at import - libcurl then falls
// back to `application/x-www-form-urlencoded`, which most GraphQL servers
// answer with a 400.
TEST_F (GraphQLBodyTest, EngineDerivesNoContentTypeForGraphQL) {
    Body body;
    body.mode    = BodyMode::GraphQL;
    body.content = kEnvelope;
    EXPECT_EQ (implied_content_type (body), "");
    EXPECT_FALSE (content_type_is_engine_owned (body));

    ASSERT_TRUE (client_->send (graphql_request (server_->url (), kEnvelope)).is_ok ());
    EXPECT_EQ (server_->body (), kEnvelope);
    EXPECT_NE (server_->content_type (), "application/json");
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

} // namespace
} // namespace vayu::http
