/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/residual_token_test.cpp
 * @brief The tokens composition left behind, resolved before the send (#1008).
 *
 * The pattern every imported Postman collection with authentication is written
 * in: a pre-request script fetches a token, `pm.environment.set("token", …)`,
 * and the request sends `Bearer {{token}}`. Composition runs strictly before
 * that script (#226's decision D1), so the send used to carry the *previous*
 * run's token - or nothing at all on the first - and said nothing about it.
 *
 * Two halves are pinned here:
 *
 * 1. `resolve_residual_tokens` itself - what it resolves, what it deliberately
 *    leaves written as it stands, and what it does not touch twice.
 * 2. The exchange running it, asserted against what the echo server *received*.
 *    A pass that reaches the request struct and not the wire is the defect this
 *    exists to end, so the headline cases assert on the wire.
 *
 * The half that is NOT here: composition's own rules. One case below composes a
 * string, because the text it needs under test is the text composition would
 * have produced - but what composition *does* with a token is
 * `request_composer_test.cpp`'s, and the token surviving composition at all is
 * #1009's rule, pinned there.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>

#include "echo_server.hpp"
#include "optional_assert.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

using vayu::http::routes::resolve_residual_tokens;
using vayu::http::routes::ScriptVariableScopes;

namespace {

vayu::Variable value_of (std::string text) {
    vayu::Variable variable;
    variable.value = std::move (text);
    return variable;
}

/// Scopes holding one environment variable - the shape every case below that
/// does not care about precedence needs.
ScriptVariableScopes environment_with (const std::string& name, std::string value) {
    ScriptVariableScopes scopes;
    scopes.environment[name] = value_of (std::move (value));
    return scopes;
}

} // namespace

// --- what the pass resolves --------------------------------------------------

TEST (ResidualTokens, ResolvesEveryFieldCompositionResolves) {
    vayu::Request request;
    request.url                        = "https://{{host}}/users/{{id}}";
    request.headers["Authorization"]   = "Bearer {{token}}";
    request.headers["{{header_name}}"] = "on";
    request.body.mode                  = vayu::BodyMode::Json;
    request.body.content               = R"({"id":"{{id}}"})";

    ScriptVariableScopes scopes;
    scopes.environment["host"]        = value_of ("api.example.com");
    scopes.environment["id"]          = value_of ("7");
    scopes.environment["token"]       = value_of ("t-123");
    scopes.environment["header_name"] = value_of ("X-Tenant");

    EXPECT_FALSE (resolve_residual_tokens (request, scopes));

    EXPECT_EQ (request.url, "https://api.example.com/users/7");
    EXPECT_EQ (request.headers["Authorization"], "Bearer t-123");
    EXPECT_EQ (request.body.content, R"({"id":"7"})");
    // A resolved header *name* is a different key, so the map is rebuilt.
    EXPECT_EQ (request.headers.count ("{{header_name}}"), 0u);
    EXPECT_EQ (request.headers["X-Tenant"], "on");
}

TEST (ResidualTokens, ResolvesEveryStringAFormFieldCarries) {
    vayu::Request request;
    request.url       = "https://example.test/upload";
    request.body.mode = vayu::BodyMode::FormData;
    vayu::FormField field;
    field.key          = "{{field}}";
    field.value        = "{{value}}";
    field.type         = vayu::FormFieldType::File;
    field.src          = "{{fixtures}}/photo.png";
    field.file_name    = "{{name}}.png";
    field.content_type = "image/{{format}}";
    request.body.fields.push_back (field);

    ScriptVariableScopes scopes;
    scopes.environment["field"]    = value_of ("avatar");
    scopes.environment["value"]    = value_of ("ada");
    scopes.environment["fixtures"] = value_of ("/tmp/fixtures");
    scopes.environment["name"]     = value_of ("ada");
    scopes.environment["format"]   = value_of ("png");

    EXPECT_FALSE (resolve_residual_tokens (request, scopes));

    const auto& resolved = request.body.fields.front ();
    EXPECT_EQ (resolved.key, "avatar");
    EXPECT_EQ (resolved.value, "ada");
    EXPECT_EQ (resolved.src, "/tmp/fixtures/photo.png");
    EXPECT_EQ (resolved.file_name, "ada.png");
    EXPECT_EQ (resolved.content_type, "image/png");
}

/// Composition's own precedence, because it is composition's own resolver: a
/// name resolves in the request exactly as the script that just ran read it.
TEST (ResidualTokens, ReadsTheScopesInCompositionsOrder) {
    ScriptVariableScopes scopes;
    scopes.globals["host"]     = value_of ("globals.test");
    scopes.collection["host"]  = value_of ("leaf.test");
    scopes.environment["host"] = value_of ("env.test");
    scopes.collection_ancestors.push_back ({ { "host", value_of ("root.test") } });

    vayu::Request request;
    request.url = "https://{{host}}/x";
    EXPECT_FALSE (resolve_residual_tokens (request, scopes));
    EXPECT_EQ (request.url, "https://env.test/x");

    scopes.environment.clear ();
    vayu::Request without_environment;
    without_environment.url = "https://{{host}}/x";
    EXPECT_FALSE (resolve_residual_tokens (without_environment, scopes));
    EXPECT_EQ (without_environment.url, "https://leaf.test/x"); // leaf over root

    scopes.collection.clear ();
    vayu::Request chain_only;
    chain_only.url = "https://{{host}}/x";
    EXPECT_FALSE (resolve_residual_tokens (chain_only, scopes));
    EXPECT_EQ (chain_only.url, "https://root.test/x"); // root over globals
}

/// A disabled row is a variable the user unticked; it answers for nothing here
/// either, exactly as it answers for nothing at composition.
TEST (ResidualTokens, ADisabledVariableAnswersForNothing) {
    ScriptVariableScopes scopes;
    scopes.environment["host"]         = value_of ("api.example.com");
    scopes.environment["host"].enabled = false;

    vayu::Request request;
    request.url = "https://{{host}}/x";
    EXPECT_FALSE (resolve_residual_tokens (request, scopes));

    EXPECT_EQ (request.url, "https://{{host}}/x");
}

// --- what it leaves alone ----------------------------------------------------

TEST (ResidualTokens, ANameNothingAnswersStaysLiteral) {
    vayu::Request request;
    request.url                      = "https://{{host}}/x";
    request.headers["Authorization"] = "Bearer {{token}}";

    ScriptVariableScopes scopes; // nothing was set
    EXPECT_FALSE (resolve_residual_tokens (request, scopes));

    EXPECT_EQ (request.url, "https://{{host}}/x");
    EXPECT_EQ (request.headers["Authorization"], "Bearer {{token}}");
}

/// The data namespace is bound per iteration by whoever owns the row, and a
/// column no row has has already been refused there - so a `{{data.x}}` this
/// pass meets is not its to answer, even for a variable of that name.
TEST (ResidualTokens, TheDataNamespaceIsLeftToItsOwnBinding) {
    vayu::Request request;
    request.url = "https://example.test/users/{{data.id}}";

    auto scopes = environment_with ("data.id", "9");
    EXPECT_FALSE (resolve_residual_tokens (request, scopes));

    EXPECT_EQ (request.url, "https://example.test/users/{{data.id}}");
}

/// #1009's rules, inherited rather than re-implemented: a layered value
/// resolves through, and a cycle stops with the token written as it stands.
TEST (ResidualTokens, InheritsTheNestedResolutionAndItsCycleBound) {
    ScriptVariableScopes layered;
    layered.environment["base"]     = value_of ("{{protocol}}://{{host}}");
    layered.environment["protocol"] = value_of ("https");
    layered.environment["host"]     = value_of ("api.example.com");

    vayu::Request request;
    request.url = "{{base}}/users";
    EXPECT_FALSE (resolve_residual_tokens (request, layered));
    EXPECT_EQ (request.url, "https://api.example.com/users");

    ScriptVariableScopes cyclic;
    cyclic.environment["a"] = value_of ("{{b}}");
    cyclic.environment["b"] = value_of ("{{a}}");

    vayu::Request cycled;
    cycled.url = "https://example.test/{{a}}";
    EXPECT_FALSE (resolve_residual_tokens (cycled, cyclic));
    EXPECT_EQ (cycled.url, "https://example.test/{{a}}");
}

/// The guard that matters: a script redefining a name composition **already
/// answered** must not rewrite what composition sent. It cannot, and the reason
/// is structural rather than a rule the pass enforces - a substituted token's
/// `{{name}}` text is gone from the request, so there is nothing left to match.
/// Composed here by the real resolver, so the text under test is the text
/// `POST /compose` would have produced.
TEST (ResidualTokens, ARedefinedNameDoesNotRewriteWhatCompositionSubstituted) {
    vayu::http::VariableValues compose_time;
    compose_time["token"] = "secret-v1";
    compose_time["greeting"] = "hello {{name}}"; // `name` answered by nothing yet

    vayu::Request request;
    request.headers["Authorization"] =
    vayu::http::resolve_template ("Bearer {{token}}", compose_time);
    request.body.mode = vayu::BodyMode::Text;
    request.body.content = vayu::http::resolve_template ("{{greeting}}", compose_time);
    ASSERT_EQ (request.headers["Authorization"], "Bearer secret-v1");
    ASSERT_EQ (request.body.content, "hello {{name}}");

    ScriptVariableScopes scopes;
    scopes.environment["token"]    = value_of ("secret-v2");
    scopes.environment["greeting"] = value_of ("should never appear");
    scopes.environment["name"]     = value_of ("world");

    EXPECT_FALSE (resolve_residual_tokens (request, scopes));

    // The two composition answered keep the answers it gave.
    EXPECT_EQ (request.headers["Authorization"], "Bearer secret-v1");
    // Only the token composition left open is filled in - the value it came
    // from is not consulted again.
    EXPECT_EQ (request.body.content, "hello world");
}

/// The pass reads the request, never composition's decisions: text a value
/// carried into the request is finished text, and a second pass over it is a
/// no-op rather than a second substitution.
TEST (ResidualTokens, ResolvingTwiceChangesNothingTheFirstPassAnswered) {
    vayu::Request request;
    request.url          = "https://{{host}}/x";
    request.body.mode    = vayu::BodyMode::Text;
    request.body.content = "{{greeting}}";

    ScriptVariableScopes scopes;
    scopes.environment["host"]     = value_of ("api.example.com");
    scopes.environment["greeting"] = value_of ("hello {{name}}");

    EXPECT_FALSE (resolve_residual_tokens (request, scopes));
    const vayu::Request once = request;
    EXPECT_FALSE (resolve_residual_tokens (request, scopes));

    EXPECT_EQ (request.url, once.url);
    EXPECT_EQ (request.body.content, once.body.content);
    EXPECT_EQ (request.body.content, "hello {{name}}"); // still nothing's answer
}

TEST (ResidualTokens, ARequestWithNoTokenIsUntouched) {
    vayu::Request request;
    request.url                      = "https://api.example.com/users/7";
    request.headers["Authorization"] = "Bearer t-123";
    request.body.mode                = vayu::BodyMode::Json;
    request.body.content             = R"({"id":"7"})";
    const vayu::Request before       = request;

    auto scopes = environment_with ("host", "elsewhere.test");
    EXPECT_FALSE (resolve_residual_tokens (request, scopes));

    EXPECT_EQ (request.url, before.url);
    EXPECT_EQ (request.headers, before.headers);
    EXPECT_EQ (request.body.content, before.body.content);
}

// --- a resolved name landing on a name already there (#1051) -----------------
//
// The sibling of the composition-side block in `request_composer_test.cpp`:
// this pass rebuilds the same map for the same reason, so it inherits the same
// collision and answers it with the same words. A script defining the name is
// what makes it reachable here at all - composition refused what it could see,
// and this is the name it could not.
//
// Mutation-check for both: return `std::nullopt` instead of the collision and
// the first fails on the refusal it no longer gets, the second on the header
// that quietly vanishes.

TEST (ResidualTokens, ANameResolvingOntoAHeaderAlreadyThereIsRefused) {
    vayu::Request request;
    request.url                        = "https://api.example.com/x";
    request.headers["{{header_name}}"] = "acme";
    request.headers["X-Tenant"]        = "legacy";

    auto scopes        = environment_with ("header_name", "X-Tenant");
    const auto refusal = resolve_residual_tokens (request, scopes);

    ASSERT_HAS_VALUE (refusal);
    EXPECT_EQ (refusal->error.code, vayu::ErrorCode::InternalError);
    // The code composition refuses the same rule under, so the streaming send -
    // which answers a `400` rather than a status-0 response - names one rule the
    // one way (#1084).
    EXPECT_EQ (refusal->code, "colliding_header_names");
    EXPECT_NE (refusal->error.message.find ("{{header_name}}"), std::string::npos)
    << refusal->error.message;
    EXPECT_NE (refusal->error.message.find ("X-Tenant"), std::string::npos)
    << refusal->error.message;
}

/// Refused with the request as it was found: the caller stops the send, and a
/// half-rebuilt map is one nothing should go on to read - not the trace, not
/// the raw-request view, not a retry.
TEST (ResidualTokens, ARefusedCollisionLeavesTheHeadersAlone) {
    vayu::Request request;
    request.url                        = "https://api.example.com/x";
    request.headers["{{header_name}}"] = "acme";
    request.headers["X-Tenant"]        = "legacy";
    const vayu::Request before         = request;

    auto scopes = environment_with ("header_name", "X-Tenant");
    EXPECT_TRUE (resolve_residual_tokens (request, scopes));

    EXPECT_EQ (request.headers, before.headers);
}

/// Case is what the map compares by, so a name that arrives in another casing
/// is the same header - and erases it just as surely.
TEST (ResidualTokens, TheCollisionIsJudgedWithoutCase) {
    vayu::Request request;
    request.url                      = "https://api.example.com/x";
    request.headers["{{h}}"]         = "Bearer new";
    request.headers["Authorization"] = "Bearer old";

    auto scopes = environment_with ("h", "authorization");

    EXPECT_TRUE (resolve_residual_tokens (request, scopes));
}

/// A name that resolves to one nothing else holds is the ordinary case, and
/// stays one: the refusal is for the collision, not for resolving a name.
TEST (ResidualTokens, ANameResolvingToItsOwnHeaderIsNotACollision) {
    vayu::Request request;
    request.url                        = "https://api.example.com/x";
    request.headers["{{header_name}}"] = "acme";
    request.headers["X-Other"]         = "kept";

    auto scopes = environment_with ("header_name", "X-Tenant");
    EXPECT_FALSE (resolve_residual_tokens (request, scopes));

    EXPECT_EQ (request.headers["X-Tenant"], "acme");
    EXPECT_EQ (request.headers["X-Other"], "kept");
    EXPECT_EQ (request.headers.count ("{{header_name}}"), 0u);
}

// --- a name that resolves to nothing (#1084) ---------------------------------
//
// The second rule `http/header_names.hpp` holds, met here for the reason the
// collision above is: a name a pre-request script has just emptied is one
// composition never saw. What a send would carry is the line `": acme"`, under
// no name at all, and nothing between here and the wire looks at a name that is
// not there.
//
// Mutation-check for the two below: drop the empty check in
// `resolve_header_names` and the first fails on the refusal it no longer gets,
// the second on the nameless header the rebuild then leaves behind.

TEST (ResidualTokens, ANameResolvingToNothingIsRefused) {
    vayu::Request request;
    request.url                        = "https://api.example.com/x";
    request.headers["{{header_name}}"] = "acme";

    auto scopes        = environment_with ("header_name", "");
    const auto refusal = resolve_residual_tokens (request, scopes);

    ASSERT_HAS_VALUE (refusal);
    EXPECT_EQ (refusal->error.code, vayu::ErrorCode::InternalError);
    EXPECT_EQ (refusal->code, "empty_header_name");
    EXPECT_NE (refusal->error.message.find ("{{header_name}}"), std::string::npos)
    << refusal->error.message;
}

/// Refused with the request as it was found, for the reason a refused collision
/// is: the caller stops the send, and a half-rebuilt map is one nothing should
/// go on to read.
TEST (ResidualTokens, ARefusedEmptyNameLeavesTheHeadersAlone) {
    vayu::Request request;
    request.url                        = "https://api.example.com/x";
    request.headers["{{header_name}}"] = "acme";
    request.headers["X-Other"]         = "kept";
    const vayu::Request before         = request;

    auto scopes = environment_with ("header_name", "");
    EXPECT_TRUE (resolve_residual_tokens (request, scopes));

    EXPECT_EQ (request.headers, before.headers);
    EXPECT_EQ (request.headers.count (""), 0u);
}

// --- the exchange, on the wire -----------------------------------------------

class ResidualTokenExchangeTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server_ = std::make_unique<vayu::tests::EchoServer> ();
    }

    void TearDown () override {
        server_.reset ();
        vayu::http::global_cleanup ();
    }

    /// One exchange, exactly as the route runs it: a script, then a real send.
    vayu::http::routes::ExchangeOutcome send (vayu::Request request,
    ScriptVariableScopes& scopes,
    const std::string& pre,
    bool in_scenario = false) {
        vayu::runtime::ScriptEngine engine;
        vayu::http::CookieJar jar;

        vayu::http::routes::ExchangeInputs inputs;
        inputs.request     = std::move (request);
        inputs.pre_script  = pre;
        inputs.in_scenario = in_scenario;
        return execute_exchange (engine, jar, "", scopes, std::move (inputs), false);
    }

    std::unique_ptr<vayu::tests::EchoServer> server_;
};

/// The headline: the token-refresh pattern, end to end. Revert the pass and
/// the wire carries `Bearer {{token}}` - which is what it carried before #1008.
TEST_F (ResidualTokenExchangeTest, AVariableThePreRequestScriptSetsReachesTheWire) {
    vayu::Request request;
    request.method                   = vayu::HttpMethod::POST;
    request.url                      = server_->url () + "/users/{{user_id}}";
    request.headers["Authorization"] = "Bearer {{token}}";
    request.body.mode                = vayu::BodyMode::Json;
    request.body.content             = R"({"tenant":"{{tenant}}"})";

    ScriptVariableScopes scopes;
    auto outcome = send (std::move (request), scopes,
    "pm.environment.set(\"token\", \"fresh-token\");"
    "pm.environment.set(\"user_id\", \"7\");"
    "pm.collectionVariables.set(\"tenant\", \"acme\");");

    ASSERT_EQ (outcome.response.status_code, 200);
    EXPECT_EQ (server_->path (), "/echo/users/7");
    EXPECT_EQ (server_->header ("Authorization"), "Bearer fresh-token");
    EXPECT_EQ (server_->body (), R"({"tenant":"acme"})");
}

/// The same rule one step further on: a scenario step reaches the pass with the
/// previous steps' writes in the scopes, and no script of its own to run.
TEST_F (ResidualTokenExchangeTest, AVariableAnEarlierStepSetIsResolvedWithNoScriptOfItsOwn) {
    vayu::Request request;
    request.url = server_->url () + "/users/{{user_id}}";

    auto scopes  = environment_with ("user_id", "12");
    auto outcome = send (std::move (request), scopes, "");

    ASSERT_EQ (outcome.response.status_code, 200);
    EXPECT_EQ (server_->path (), "/echo/users/12");
}

/// A name still unanswered after the script goes out written as it stands -
/// #1009's rule, held all the way to the wire rather than only to composition.
TEST_F (ResidualTokenExchangeTest, AStillUnknownNameGoesOutLiteral) {
    vayu::Request request;
    request.url                 = server_->url () + "/users";
    request.headers["X-Tenant"] = "{{tenant}}";

    ScriptVariableScopes scopes;
    auto outcome =
    send (std::move (request), scopes, "pm.environment.set(\"other\", \"x\");");

    ASSERT_EQ (outcome.response.status_code, 200);
    EXPECT_EQ (server_->header ("X-Tenant"), "{{tenant}}");
}

/// A skipped step sends nothing, so there is nothing to resolve for: the
/// request it reports is the one composition produced.
TEST_F (ResidualTokenExchangeTest, ASkippedRequestResolvesNothing) {
    vayu::Request request;
    request.url = server_->url () + "/users/{{user_id}}";

    ScriptVariableScopes scopes;
    auto outcome = send (std::move (request), scopes,
    "pm.environment.set(\"user_id\", \"7\");"
    "pm.execution.skipRequest();",
    /*in_scenario=*/true);

    EXPECT_FALSE (outcome.sent);
    EXPECT_EQ (outcome.request.url, server_->url () + "/users/{{user_id}}");
}

/// What the app shows as the request, and what the run stores as its trace,
/// both read `outcome.request` - so the pass must reach it, not just the wire.
TEST_F (ResidualTokenExchangeTest, TheReportedRequestIsTheOneThatWentOut) {
    vayu::Request request;
    request.url                      = server_->url () + "/users/{{user_id}}";
    request.headers["Authorization"] = "Bearer {{token}}";

    ScriptVariableScopes scopes;
    auto outcome = send (std::move (request), scopes,
    "pm.environment.set(\"token\", \"fresh-token\");"
    "pm.environment.set(\"user_id\", \"7\");");

    ASSERT_EQ (outcome.response.status_code, 200);
    EXPECT_EQ (outcome.request.url, server_->url () + "/users/7");
    EXPECT_EQ (outcome.request.headers["Authorization"], "Bearer fresh-token");
}
