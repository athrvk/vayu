/**
 * @file script_sent_headers_test.cpp
 * @brief What a test script reads as `pm.request.headers` - the sent record.
 *
 * Issue #483: two records of "the request's headers" exist and the test script
 * read the wrong one. `pm.request.headers` was built from the *composed* map,
 * while the headers the engine derives at curl setup - the body-implied
 * `Content-Type` and the default `User-Agent` - live only on the response's
 * `request_headers`, which is what the response viewer shows. So a GraphQL or
 * form request whose author did not hand-write a Content-Type (the normal case,
 * since the engine derives it precisely so they do not have to) gave a script
 * asking "what Content-Type was sent?" the answer `undefined`, and the
 * assertion went red on a request that went out right.
 *
 * The end-to-end tests below send through the real client, so they pin the
 * whole chain rather than a hand-built map that could drift from what curl
 * setup actually records: derive -> record on the response -> seed the script.
 * The unit-level ones pin the boundaries the fix must not cross - the
 * pre-request view, and a response carrying no sent record at all.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>

#include "echo_server.hpp"
#include "vayu/http/client.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

namespace vayu::runtime {
namespace {

using vayu::tests::EchoServer;

/// The bare document an agent or a renderer sends for a GraphQL request. No
/// Content-Type is authored: deriving one is the engine's job (#417).
const char* const kBareQuery = "query Me { me { id name } }";

/**
 * A test script's whole outcome in one place. Every test here asserts on
 * `passed` *and* on the reported message when it fails, because a script that
 * throws before reaching its assertion also reports "not passed" - and that is
 * a different defect from the assertion failing.
 */
struct ScriptOutcome {
    bool ran_clean = false;
    bool passed    = false;
    std::string detail;
};

ScriptOutcome run_test_script (ScriptEngine& engine,
const std::string& script,
const Request& request,
const Response& response) {
    Environment env;
    const ScriptResult result = engine.execute_test (script, request, response, env);

    ScriptOutcome outcome;
    outcome.ran_clean = result.success;
    outcome.detail    = result.error_message;
    if (!result.tests.empty ()) {
        outcome.passed = result.tests[0].passed;
        if (!result.tests[0].passed) {
            outcome.detail = result.tests[0].error_message;
        }
    }
    return outcome;
}

/// `pm.test` around one assertion, so a failure reports the assertion's own
/// message rather than an execution error.
std::string assertion (const std::string& body) {
    return "pm.test(\"sent headers\", function() { " + body + " });";
}

class SentRequestHeadersTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server_ = std::make_unique<EchoServer> ();
        client_ = std::make_unique<vayu::http::Client> ();
    }

    void TearDown () override {
        client_.reset ();
        server_.reset ();
        vayu::http::global_cleanup ();
    }

    /// Send `request` for real, then run `script` against what came back - the
    /// same order `execute_exchange` runs them in.
    ScriptOutcome send_then_assert (Request& request, const std::string& script) {
        auto result = client_->send (request);
        EXPECT_TRUE (result.is_ok ());
        response_ = result.value ();
        EXPECT_EQ (response_.status_code, 200);
        return run_test_script (engine_, assertion (script), request, response_);
    }

    Request graphql_request () const {
        Request request;
        request.method       = HttpMethod::POST;
        request.url          = server_->url ();
        request.body.mode    = BodyMode::GraphQL;
        request.body.content = kBareQuery;
        return request;
    }

    Request form_request () const {
        Request request;
        request.method      = HttpMethod::POST;
        request.url         = server_->url ();
        request.body.mode   = BodyMode::Form;
        request.body.fields = { FormField{ "name", "ada" } };
        return request;
    }

    ScriptEngine engine_;
    Response response_;
    std::unique_ptr<EchoServer> server_;
    std::unique_ptr<vayu::http::Client> client_;
};

// ---------------------------------------------------------------------------
// The owner's repro, and its siblings.
// ---------------------------------------------------------------------------

// The reported failure, end to end: a bare GraphQL query goes out as
// application/json, and the script that asks so is now told so. Mutation-check:
// seed `pm.request.headers` from the composed map again and this fails with the
// `undefined` the report showed.
TEST_F (SentRequestHeadersTest, GraphQLDerivedContentTypeReachesTheTestScript) {
    Request request = graphql_request ();

    const auto outcome = send_then_assert (request,
    R"(pm.expect(pm.request.headers.get("Content-Type")).to.include("json");)");

    EXPECT_TRUE (outcome.ran_clean) << outcome.detail;
    EXPECT_TRUE (outcome.passed) << outcome.detail;
    // The wire agrees with the script - the assertion above would also pass
    // against a header the engine invented and never sent.
    EXPECT_EQ (server_->content_type (), "application/json");
}

// The same derivation for the other mode that has one. Two modes imply a
// Content-Type and a table that only ever judged one of them would look right
// until a form request asked.
TEST_F (SentRequestHeadersTest, FormDerivedContentTypeReachesTheTestScript) {
    Request request = form_request ();

    const auto outcome = send_then_assert (request,
    R"(pm.expect(pm.request.headers.get("Content-Type"))
           .to.equal("application/x-www-form-urlencoded");)");

    EXPECT_TRUE (outcome.ran_clean) << outcome.detail;
    EXPECT_TRUE (outcome.passed) << outcome.detail;
    EXPECT_EQ (server_->content_type (), "application/x-www-form-urlencoded");
}

// The other engine-derived header, and the one every request gets: a script
// asserting on the User-Agent it sends is asserting on a header no request in
// the app declares.
TEST_F (SentRequestHeadersTest, DefaultUserAgentReachesTheTestScript) {
    Request request;
    request.method = HttpMethod::POST;
    request.url    = server_->url ();

    const auto outcome = send_then_assert (
    request, R"(pm.expect(pm.request.headers.has("User-Agent")).to.be.true;)");

    EXPECT_TRUE (outcome.ran_clean) << outcome.detail;
    EXPECT_TRUE (outcome.passed) << outcome.detail;
    EXPECT_FALSE (response_.request_headers.at ("User-Agent").empty ());
}

// The derivation only fills absence, so the sent record must show what the
// author wrote - not what the body mode would have implied. A view that
// overrode it would report a request the user never sent.
TEST_F (SentRequestHeadersTest, AnAuthoredContentTypeIsNotOverridden) {
    Request request                 = graphql_request ();
    request.headers["Content-Type"] = "application/graphql+json";

    const auto outcome = send_then_assert (request,
    R"(pm.expect(pm.request.headers.get("Content-Type"))
           .to.equal("application/graphql+json");)");

    EXPECT_TRUE (outcome.ran_clean) << outcome.detail;
    EXPECT_TRUE (outcome.passed) << outcome.detail;
    EXPECT_EQ (server_->content_type (), "application/graphql+json");
}

// Authored headers still reach the script - the sent record is composed *plus*
// derived, not derived instead of composed.
TEST_F (SentRequestHeadersTest, AuthoredHeadersSurviveTheSentRecord) {
    Request request                  = graphql_request ();
    request.headers["Authorization"] = "Bearer token123";

    const auto outcome = send_then_assert (request,
    R"(pm.expect(pm.request.headers["Authorization"]).to.equal("Bearer token123");)");

    EXPECT_TRUE (outcome.ran_clean) << outcome.detail;
    EXPECT_TRUE (outcome.passed) << outcome.detail;
}

// `get()` is case-insensitive over whatever spelling the map carries, and the
// sent record's derived entries are spelled by the engine rather than by the
// user. A script written against Postman asks in any case it likes.
TEST_F (SentRequestHeadersTest, TheSentRecordKeepsCaseInsensitiveLookup) {
    Request request = graphql_request ();

    const auto outcome = send_then_assert (request,
    R"(pm.expect(pm.request.headers.get("content-TYPE")).to.include("json");)");

    EXPECT_TRUE (outcome.ran_clean) << outcome.detail;
    EXPECT_TRUE (outcome.passed) << outcome.detail;
}

// A multipart Content-Type is libcurl's to write, boundary and all, so the
// engine suppresses an authored one rather than sending a boundary-less
// duplicate - and does not report as sent what it did not send. The script's
// view follows that record, which is the decision this pins: a script gets the
// same answer as the response viewer's Headers tab, not a friendlier one.
TEST_F (SentRequestHeadersTest, ASuppressedContentTypeIsAbsentFromTheScriptView) {
    Request request                 = form_request ();
    request.body.mode               = BodyMode::FormData;
    request.headers["Content-Type"] = "multipart/form-data";

    const auto outcome = send_then_assert (request,
    R"(pm.expect(pm.request.headers.has("Content-Type")).to.be.false;)");

    EXPECT_TRUE (outcome.ran_clean) << outcome.detail;
    EXPECT_TRUE (outcome.passed) << outcome.detail;
    EXPECT_FALSE (response_.request_headers.contains ("Content-Type"));
}

// ---------------------------------------------------------------------------
// The boundaries the fix must not cross.
// ---------------------------------------------------------------------------

// A pre-request script keeps the composed view: nothing has been sent, so there
// is no sent record to show, and the object it edits is the one the write-back
// applies back onto the request. Showing it a derived header would offer a
// `delete` of something the request never carried.
TEST (SentRequestHeadersBoundaryTest, ThePreRequestViewStaysComposed) {
    ScriptEngine engine;
    Environment env;

    Request request;
    request.method       = HttpMethod::POST;
    request.url          = "https://api.example.com/graphql";
    request.body.mode    = BodyMode::GraphQL;
    request.body.content = kBareQuery;

    const auto result = engine.execute_prerequest (R"(
        pm.test("no derived header yet", function() {
            pm.expect(pm.request.headers.has("Content-Type")).to.be.false;
            pm.expect(pm.request.headers.has("User-Agent")).to.be.false;
        });
        pm.request.headers['X-Trace'] = 'abc123';
    )",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    // The write-back still reaches the request it was shown.
    EXPECT_EQ (request.headers.at ("X-Trace"), "abc123");
}

// A load run's deferred validation rebuilds its Response from a sampled
// response, which records no sent headers at all. Seeding from that empty map
// would take `pm.request.headers` from "missing two derived entries" to
// "empty" - a worse answer than the one this issue fixes, and one no test on
// the live path would have caught.
TEST (SentRequestHeadersBoundaryTest, AResponseWithNoSentRecordFallsBackToComposed) {
    ScriptEngine engine;

    Request request                  = Request{};
    request.method                   = HttpMethod::GET;
    request.url                      = "https://api.example.com/users";
    request.headers["Authorization"] = "Bearer token123";

    Response response; // the load-run replay shape: no request_headers
    response.status_code = 200;
    ASSERT_TRUE (response.request_headers.empty ());

    const auto outcome = run_test_script (engine,
    assertion (R"(pm.expect(pm.request.headers.get("Authorization")).to.equal("Bearer token123");)"),
    request, response);

    EXPECT_TRUE (outcome.ran_clean) << outcome.detail;
    EXPECT_TRUE (outcome.passed) << outcome.detail;
}

} // namespace
} // namespace vayu::runtime
