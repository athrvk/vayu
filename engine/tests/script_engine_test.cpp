/**
 * @file script_engine_test.cpp
 * @brief Tests for QuickJS scripting engine
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <chrono>

#include "vayu/http/request_builder.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

class ScriptEngineTest : public ::testing::Test {
    protected:
    ScriptEngine engine;
    Request request;
    Response response;
    Environment env;

    void SetUp () override {
        // Setup default request
        request.method  = HttpMethod::GET;
        request.url     = "https://api.example.com/users";
        request.headers = { { "Content-Type", "application/json" },
            { "Authorization", "Bearer token123" } };

        // Setup default response
        response.status_code = 200;
        response.status_text = "OK";
        response.body = R"({"id": 1, "name": "John Doe", "email": "john@example.com"})";
        response.headers         = { { "Content-Type", "application/json" },
                    { "X-Request-Id", "abc123" } };
        response.timing.total_ms = 150.5;

        // Setup environment
        env["api_key"]  = Variable{ "secret123", true, true };
        env["base_url"] = Variable{ "https://api.example.com", false, true };
    }
};

// ============================================================================
// Basic Engine Tests
// ============================================================================

TEST_F (ScriptEngineTest, IsAvailable) {
#ifdef VAYU_HAS_QUICKJS
    EXPECT_TRUE (ScriptEngine::is_available ());
    EXPECT_FALSE (ScriptEngine::version ().empty ());
#else
    EXPECT_FALSE (ScriptEngine::is_available ());
    EXPECT_TRUE (ScriptEngine::version ().empty ());
#endif
}

TEST_F (ScriptEngineTest, ExecuteEmptyScript) {
    ScriptContext ctx;
    ctx.response = &response;

    auto result = engine.execute ("", ctx);
    EXPECT_TRUE (result.success);
    EXPECT_TRUE (result.tests.empty ());
}

TEST_F (ScriptEngineTest, ExecuteSimpleExpression) {
    ScriptContext ctx;
    auto result = engine.execute ("1 + 1", ctx);
    EXPECT_TRUE (result.success);
}

// ============================================================================
// pm.test() Tests
// ============================================================================

TEST_F (ScriptEngineTest, PmTestPassing) {
    auto result = engine.execute_test (R"(
        pm.test("Always passes", function() {
            // Empty test should pass
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_EQ (result.tests[0].name, "Always passes");
    EXPECT_TRUE (result.tests[0].passed);
}

TEST_F (ScriptEngineTest, PmTestFailing) {
    auto result = engine.execute_test (R"(
        pm.test("Always fails", function() {
            throw new Error("Intentional failure");
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_EQ (result.tests[0].name, "Always fails");
    EXPECT_FALSE (result.tests[0].passed);
}

TEST_F (ScriptEngineTest, PmTestMultiple) {
    auto result = engine.execute_test (R"(
        pm.test("First test", function() {
            pm.expect(true).to.be.true;
        });

        pm.test("Second test", function() {
            pm.expect(1).to.equal(1);
        });

        pm.test("Third test", function() {
            pm.expect("hello").to.include("ell");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_EQ (result.tests.size (), 3);
    EXPECT_TRUE (result.tests[0].passed);
    EXPECT_TRUE (result.tests[1].passed);
    EXPECT_TRUE (result.tests[2].passed);
}

// ============================================================================
// pm.expect() Assertion Tests
// ============================================================================

TEST_F (ScriptEngineTest, ExpectEqual) {
    auto result = engine.execute_test (R"(
        pm.test("Equal numbers", function() {
            pm.expect(42).to.equal(42);
        });

        pm.test("Equal strings", function() {
            pm.expect("hello").to.equal("hello");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ExpectEqualFails) {
    auto result = engine.execute_test (R"(
        pm.test("Should fail", function() {
            pm.expect(42).to.equal(43);
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_FALSE (result.tests[0].error_message.empty ());
}

TEST_F (ScriptEngineTest, ExpectNotEqual) {
    auto result = engine.execute_test (R"(
        pm.test("Not equal", function() {
            pm.expect(42).to.not.equal(43);
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ExpectExist) {
    auto result = engine.execute_test (R"(
        pm.test("Value exists", function() {
            pm.expect("something").to.exist;
        });

        pm.test("Number exists", function() {
            pm.expect(0).to.exist;
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ExpectAboveBelow) {
    auto result = engine.execute_test (R"(
        pm.test("Above check", function() {
            pm.expect(10).to.be.above(5);
        });

        pm.test("Below check", function() {
            pm.expect(5).to.be.below(10);
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ExpectInclude) {
    auto result = engine.execute_test (R"(
        pm.test("String includes", function() {
            pm.expect("hello world").to.include("world");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ExpectProperty) {
    auto result = engine.execute_test (R"(
        pm.test("Has property", function() {
            var obj = {name: "John", age: 30};
            pm.expect(obj).to.have.property("name");
        });

        pm.test("Has property with value", function() {
            var obj = {name: "John", age: 30};
            pm.expect(obj).to.have.property("age", 30);
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ExpectTrueFalse) {
    auto result = engine.execute_test (R"(
        pm.test("True check", function() {
            pm.expect(true).to.be.true;
        });

        pm.test("False check", function() {
            pm.expect(false).to.be.false;
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

// Mutation-checked: the paren-less terminal must actually run the assertion.
// Before the getter fix `.to.be.true` was a discarded function reference, so a
// deliberately-wrong assertion still passed. This asserts the failing case fails.
TEST_F (ScriptEngineTest, ExpectTrueFalseAssertsOnAccess) {
    auto result = engine.execute_test (R"(
        pm.test("false is not true", function() {
            pm.expect(false).to.be.true;
        });

        pm.test("true is not false", function() {
            pm.expect(true).to.be.false;
        });

        pm.test("negation works", function() {
            pm.expect(false).to.not.be.true;
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 3);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_FALSE (result.tests[0].error_message.empty ());
    EXPECT_FALSE (result.tests[1].passed);
    EXPECT_TRUE (result.tests[2].passed);
}

TEST_F (ScriptEngineTest, ExpectNullUndefinedOkEmpty) {
    auto result = engine.execute_test (R"(
        pm.test("null", function() { pm.expect(null).to.be.null; });
        pm.test("undefined", function() { pm.expect(undefined).to.be.undefined; });
        pm.test("ok", function() { pm.expect(1).to.be.ok; });
        pm.test("not ok", function() { pm.expect(0).to.not.be.ok; });
        pm.test("empty string", function() { pm.expect("").to.be.empty; });
        pm.test("empty array", function() { pm.expect([]).to.be.empty; });
        pm.test("empty object", function() { pm.expect({}).to.be.empty; });
        pm.test("non-empty array", function() { pm.expect([1]).to.not.be.empty; });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ExpectNullFailsForNonNull) {
    auto result = engine.execute_test (R"(
        pm.test("1 is not null", function() { pm.expect(1).to.be.null; });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
}

TEST_F (ScriptEngineTest, ExpectLength) {
    auto result = engine.execute_test (R"(
        pm.test("array length", function() { pm.expect([1,2,3]).to.have.length(3); });
        pm.test("string lengthOf", function() { pm.expect("abcd").to.have.lengthOf(4); });
        pm.test("wrong length not", function() { pm.expect([1,2]).to.not.have.length(3); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ExpectLengthFailsNotThrows) {
    auto result = engine.execute_test (R"(
        pm.test("wrong length", function() { pm.expect([1,2,3]).to.have.length(2); });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    // A mismatch must fail, not throw "not a function".
    EXPECT_EQ (result.tests[0].error_message.find ("not a function"), std::string::npos);
}

TEST_F (ScriptEngineTest, ExpectTypeMatcher) {
    auto result = engine.execute_test (R"(
        pm.test("string", function() { pm.expect("hi").to.be.a("string"); });
        pm.test("number", function() { pm.expect(5).to.be.a("number"); });
        pm.test("array", function() { pm.expect([1]).to.be.an("array"); });
        pm.test("object", function() { pm.expect({}).to.be.an("object"); });
        pm.test("wrong type", function() { pm.expect("hi").to.not.be.a("number"); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ExpectTypeMatcherFails) {
    auto result = engine.execute_test (R"(
        pm.test("string is not number", function() { pm.expect("hi").to.be.a("number"); });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_EQ (result.tests[0].error_message.find ("not a function"), std::string::npos);
}

TEST_F (ScriptEngineTest, ExpectMatchRegex) {
    auto result = engine.execute_test (R"(
        pm.test("matches", function() { pm.expect("hello123").to.match(/[0-9]+/); });
        pm.test("does not match", function() { pm.expect("hello").to.not.match(/[0-9]+/); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ExpectMatchFails) {
    auto result = engine.execute_test (R"(
        pm.test("no digits", function() { pm.expect("hello").to.match(/[0-9]+/); });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
}

TEST_F (ScriptEngineTest, ExpectAtLeastAtMost) {
    auto result = engine.execute_test (R"(
        pm.test("at least equal boundary", function() { pm.expect(5).to.be.at.least(5); });
        pm.test("at least above", function() { pm.expect(10).to.be.at.least(5); });
        pm.test("at most equal boundary", function() { pm.expect(5).to.be.at.most(5); });
        pm.test("at most below", function() { pm.expect(3).to.be.at.most(5); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ExpectAtLeastFails) {
    auto result = engine.execute_test (R"(
        pm.test("4 is not at least 5", function() { pm.expect(4).to.be.at.least(5); });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
}

TEST_F (ScriptEngineTest, ExpectContain) {
    auto result = engine.execute_test (R"(
        pm.test("string contain", function() { pm.expect("hello world").to.contain("world"); });
        pm.test("array contain", function() { pm.expect([1,2,3]).to.contain(2); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

// ============================================================================
// pm.response Tests
// ============================================================================

TEST_F (ScriptEngineTest, ResponseStatusCode) {
    auto result = engine.execute_test (R"(
        pm.test("Status code is 200", function() {
            pm.expect(pm.response.code).to.equal(200);
        });

        pm.test("Status is also available", function() {
            pm.expect(pm.response.status).to.equal(200);
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ResponseJson) {
    auto result = engine.execute_test (R"(
        pm.test("Response has correct name", function() {
            var json = pm.response.json();
            pm.expect(json.name).to.equal("John Doe");
        });

        pm.test("Response has id", function() {
            var json = pm.response.json();
            pm.expect(json.id).to.equal(1);
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ResponseHasJsonBodyNoArg) {
    auto result = engine.execute_test (R"(
        pm.test("body is valid JSON", function() {
            pm.response.to.have.jsonBody();
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ResponseJsonBodyNoArgFailsOnNonJson) {
    response.body = "this is not json";
    auto result   = engine.execute_test (R"(
        pm.test("invalid json fails", function() {
            pm.response.to.have.jsonBody();
        });
    )",
      request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
}

// ============================================================================
// pm.response.to.be Tests
// ============================================================================
//
// `to.be` was an empty object, so every assertion hanging off it evaluated to
// undefined and, as an expression statement, asserted nothing: a test whose
// only line was `pm.response.to.be.ok` reported PASS against a 500. The first
// two tests below are the mutation check - restore the empty placeholder and
// ResponseToBeOkFailsOnServerError goes green while the API stays broken.

TEST_F (ScriptEngineTest, ResponseToBeOkFailsOnServerError) {
    response.status_code = 500;
    response.status_text = "Internal Server Error";

    auto result = engine.execute_test (R"(
        pm.test("api is healthy", function() {
            pm.response.to.be.ok;
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("500"), std::string::npos)
    << "the failure must name the status it got: " << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, ResponseToBeOkPassesOnSuccess) {
    auto result = engine.execute_test (R"(
        pm.test("api is healthy", function() {
            pm.response.to.be.ok;
            pm.response.to.be.success;
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed);
}

// Each matcher, on both sides of its boundary. A matcher that passed
// unconditionally would satisfy the first half of every pair and fail here.
TEST_F (ScriptEngineTest, ResponseToBeStatusClassMatchersAssertOnBothSides) {
    struct Case {
        int status;
        const char* matches;
        const char* does_not_match;
    };
    const Case cases[] = {
        { 100, "info", "ok" },
        { 202, "accepted", "notFound" },
        { 301, "redirection", "success" },
        { 400, "badRequest", "serverError" },
        { 401, "unauthorized", "forbidden" },
        { 403, "forbidden", "unauthorized" },
        { 404, "notFound", "badRequest" },
        { 429, "rateLimited", "serverError" },
        { 404, "clientError", "serverError" },
        { 503, "serverError", "clientError" },
        { 503, "error", "redirection" },
        { 404, "error", "info" },
    };

    for (const auto& c : cases) {
        response.status_code = c.status;

        const std::string passing = std::string ("pm.test(\"t\", function() { "
                                                 "pm.response.to.be.") +
        c.matches + "; });";
        auto pass_result = engine.execute_test (passing, request, response, env);
        ASSERT_EQ (pass_result.tests.size (), 1u) << passing;
        EXPECT_TRUE (pass_result.tests[0].passed)
        << c.matches << " should match status " << c.status << ": "
        << pass_result.tests[0].error_message;

        const std::string failing = std::string ("pm.test(\"t\", function() { "
                                                 "pm.response.to.be.") +
        c.does_not_match + "; });";
        auto fail_result = engine.execute_test (failing, request, response, env);
        ASSERT_EQ (fail_result.tests.size (), 1u) << failing;
        EXPECT_FALSE (fail_result.tests[0].passed)
        << c.does_not_match << " must not match status " << c.status;
    }
}

TEST_F (ScriptEngineTest, ResponseToBeJsonAndWithBody) {
    auto json_result = engine.execute_test (R"(
        pm.test("json body", function() {
            pm.response.to.be.json;
            pm.response.to.be.withBody;
        });
    )",
    request, response, env);
    EXPECT_TRUE (json_result.success) << json_result.tests[0].error_message;

    response.body   = "not json at all";
    auto not_json   = engine.execute_test (R"(
        pm.test("json body", function() { pm.response.to.be.json; });
    )",
      request, response, env);
    ASSERT_EQ (not_json.tests.size (), 1u);
    EXPECT_FALSE (not_json.tests[0].passed);

    response.body   = "";
    auto empty_body = engine.execute_test (R"(
        pm.test("has a body", function() { pm.response.to.be.withBody; });
    )",
    request, response, env);
    ASSERT_EQ (empty_body.tests.size (), 1u);
    EXPECT_FALSE (empty_body.tests[0].passed);
}

// A name nothing implements must fail loudly. Silently returning undefined is
// the whole defect - a misspelled matcher would otherwise report PASS.
TEST_F (ScriptEngineTest, ResponseToChainRejectsUnknownAssertions) {
    const char* scripts[] = {
        R"(pm.test("t", function() { pm.response.to.be.definitelyNotAMatcher; });)",
        R"(pm.test("t", function() { pm.response.to.have.definitelyNotAMatcher; });)",
        R"(pm.test("t", function() { pm.response.to.definitelyNotAMatcher; });)",
        // The negated form is not implemented; it must throw, not pass.
        R"(pm.test("t", function() { pm.response.to.not.be.ok; });)",
    };

    for (const char* script : scripts) {
        auto result = engine.execute_test (script, request, response, env);
        ASSERT_EQ (result.tests.size (), 1u) << script;
        EXPECT_FALSE (result.tests[0].passed) << script;
        EXPECT_NE (result.tests[0].error_message.find ("not a supported assertion"), std::string::npos)
        << script << " -> " << result.tests[0].error_message;
    }
}

// The exotic hook only rejects assertion names: the object still has to behave
// like an object for the plumbing that touches it (printing, serialising).
TEST_F (ScriptEngineTest, ResponseToChainStillBehavesLikeAnObject) {
    auto result = engine.execute_test (R"(
        pm.test("printable", function() {
            var label = String(pm.response.to.be);
            pm.expect(label).to.include("object");
            pm.expect(typeof pm.response.to.have.status).to.equal("function");
            // console.log(pm.response) serialises the whole response; a chain
            // link that rejected `toJSON` would turn that into a throw.
            pm.expect(JSON.stringify(pm.response)).to.include("to");
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, ResponseHeaders) {
    auto result = engine.execute_test (R"(
        pm.test("Content-Type header", function() {
            pm.expect(pm.response.headers["Content-Type"]).to.equal("application/json");
        });

        pm.test("X-Request-Id header", function() {
            pm.expect(pm.response.headers["X-Request-Id"]).to.exist;
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ResponseTime) {
    auto result = engine.execute_test (R"(
        pm.test("Response time is reasonable", function() {
            pm.expect(pm.response.responseTime).to.be.below(1000);
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, ResponseText) {
    auto result = engine.execute_test (R"(
        pm.test("Response text contains name", function() {
            var text = pm.response.text();
            pm.expect(text).to.include("John Doe");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

// ============================================================================
// pm.request Tests
// ============================================================================

TEST_F (ScriptEngineTest, RequestUrl) {
    auto result = engine.execute_test (R"(
        pm.test("Request URL", function() {
            pm.expect(pm.request.url).to.include("example.com");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, RequestMethod) {
    auto result = engine.execute_test (R"(
        pm.test("Request method is GET", function() {
            pm.expect(pm.request.method).to.equal("GET");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, RequestHeaders) {
    auto result = engine.execute_test (R"(
        pm.test("Request has auth header", function() {
            pm.expect(pm.request.headers["Authorization"]).to.include("Bearer");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

// ============================================================================
// pm.environment Tests
// ============================================================================

TEST_F (ScriptEngineTest, EnvironmentGet) {
    auto result = engine.execute_test (R"(
        pm.test("Can get env var", function() {
            var baseUrl = pm.environment.get("base_url");
            pm.expect(baseUrl).to.equal("https://api.example.com");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

TEST_F (ScriptEngineTest, EnvironmentSet) {
    auto result = engine.execute_test (R"(
        pm.environment.set("new_var", "new_value");
        pm.test("Can set env var", function() {
            pm.expect(pm.environment.get("new_var")).to.equal("new_value");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    EXPECT_EQ (env["new_var"].value, "new_value");
}

// Regression for #110: pm.*.set() on an existing key must preserve the
// variable's secret flag, enabled flag and type - only the value changes. The
// pre-fix whole-record replace silently un-masked a secret variable in the UI
// and reset its type. Mutation-check: restore the Variable{value,false,true}
// assignment in set_variable_preserving and the secret/type asserts here fail.
TEST_F (ScriptEngineTest, SetPreservesSecretFlagAndType) {
    env["token"] = Variable{ "old", true, true, "json" };

    auto result = engine.execute_test (R"(
        pm.environment.set("token", "rotated");
        pm.test("dummy", function() {});
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    EXPECT_EQ (env["token"].value, "rotated"); // value updated
    EXPECT_TRUE (env["token"].secret);         // secret preserved
    EXPECT_TRUE (env["token"].enabled);        // enabled preserved
    EXPECT_EQ (env["token"].type, "json");     // type preserved
}

// A brand-new key still gets the current defaults (not secret, enabled, string).
TEST_F (ScriptEngineTest, SetNewKeyGetsDefaults) {
    auto result = engine.execute_test (R"(
        pm.environment.set("fresh", "value");
        pm.test("dummy", function() {});
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_TRUE (env.count ("fresh"));
    EXPECT_EQ (env["fresh"].value, "value");
    EXPECT_FALSE (env["fresh"].secret);
    EXPECT_TRUE (env["fresh"].enabled);
    EXPECT_EQ (env["fresh"].type, "string");
}

// Guards that the collectionVariables setter is wired to the shared helper too
// (all three setters must preserve, not just pm.environment).
TEST_F (ScriptEngineTest, CollectionVariableSetPreservesSecretFlagAndType) {
    Environment collVars;
    collVars["cv_token"] = Variable{ "old", true, true, "json" };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.response            = &response;
    ctx.collectionVariables = &collVars;

    auto result = engine.execute (R"(
        pm.collectionVariables.set("cv_token", "rotated");
    )",
    ctx);

    EXPECT_TRUE (result.success);
    EXPECT_EQ (collVars["cv_token"].value, "rotated");
    EXPECT_TRUE (collVars["cv_token"].secret);
    EXPECT_EQ (collVars["cv_token"].type, "json");
}

// ============================================================================
// Console Output Tests
// ============================================================================

TEST_F (ScriptEngineTest, ConsoleLog) {
    auto result = engine.execute_test (R"(
        console.log("Hello, World!");
        console.log("Value:", 42);
        pm.test("dummy", function() {});
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_GE (result.console_output.size (), 2);
    EXPECT_EQ (result.console_output[0], "Hello, World!");
    EXPECT_EQ (result.console_output[1], "Value: 42");
}

// ============================================================================
// Script Parts: Shared Scope
// ============================================================================

// Pins the property the whole script-parts feature depends on: parts joined
// by vayu::http::read_script and run through a single engine.execute() call
// share one JavaScript scope, so a const declared in an earlier part is
// visible to a later one. This does not catch someone splitting the execute
// call apart in execution.cpp (a source-level regression, not a behavioral
// one this test can see) - it only pins read_script's join, run once,
// behaving as documented.
TEST_F (ScriptEngineTest, ComposedPartsShareOneScope) {
    auto json = nlohmann::json::parse (R"({
      "preRequestScripts": [
        {"origin":"collection","script":"const shared = 42;"},
        {"origin":"request","script":"console.log(\"got \" + shared);"}
      ]
    })");
    auto script = vayu::http::read_script (json, "preRequestScripts", "preRequestScript");

    ScriptContext ctx;
    ctx.request = &request;
    auto result = engine.execute (script, ctx);

    EXPECT_TRUE (result.success);
    ASSERT_GE (result.console_output.size (), 1);
    EXPECT_EQ (result.console_output[0], "got 42");
}

// ============================================================================
// Error Handling Tests
// ============================================================================

TEST_F (ScriptEngineTest, SyntaxError) {
    auto result = engine.execute_test (R"(
        pm.test("Bad syntax", function() {
            var x = ;  // Syntax error
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_FALSE (result.error_message.empty ());
}

TEST_F (ScriptEngineTest, RuntimeError) {
    auto result = engine.execute_test (R"(
        pm.test("Runtime error", function() {
            undefinedFunction();  // Reference error
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
}

// ============================================================================
// Pre-request Script Tests
// ============================================================================

TEST_F (ScriptEngineTest, PreRequestScript) {
    Request req;
    req.method = HttpMethod::GET;
    req.url    = "https://api.example.com";

    auto result = engine.execute_prerequest (R"(
        console.log("Pre-request script running");
        pm.environment.set("timestamp", Date.now().toString());
    )",
    req, env);

    EXPECT_TRUE (result.success);
    EXPECT_TRUE (env.find ("timestamp") != env.end ());
}

// ============================================================================
// pm.request write-back (#109)
// ============================================================================
//
// These pin the contract that a pre-request script can change what goes on the
// wire. Revert the write-back in ScriptEngine::Impl::execute and every one of
// them fails, because before it existed the JS object was built, mutated and
// thrown away - the codebase's "written but never read" pattern at the script
// boundary.

TEST_F (ScriptEngineTest, PreRequestScriptSetsHeaderOnTheOutgoingRequest) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Signature'] = 'abc123';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_TRUE (request.headers.contains ("X-Signature"));
    EXPECT_EQ (request.headers.at ("X-Signature"), "abc123");
    // Untouched headers survive: the write-back replaces the set, and the set
    // the script saw already held these.
    EXPECT_EQ (request.headers.at ("Content-Type"), "application/json");
}

TEST_F (ScriptEngineTest, PreRequestScriptHeaderOverridesEngineAppliedAuth) {
    // The precedence rule, end to end: build_request resolves auth into the
    // request first, the script runs second, so the script wins.
    const nlohmann::json config = { { "method", "GET" },
        { "url", "https://api.example.com/v1" },
        { "auth", { { "mode", "bearer" }, { "token", "engine-token" } } } };
    auto built = vayu::http::build_request (config, nullptr, 1000);
    ASSERT_TRUE (built.ok);
    ASSERT_EQ (built.request.headers.at ("Authorization"), "Bearer engine-token");

    auto result = engine.execute_prerequest (R"JS(
        pm.expect(pm.request.headers['Authorization']).to.equal('Bearer engine-token');
        pm.request.headers['Authorization'] = 'Bearer script-token';
    )JS",
    built.request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (built.request.headers.at ("Authorization"), "Bearer script-token");
}

TEST_F (ScriptEngineTest, PreRequestScriptCanDeleteAHeader) {
    auto result = engine.execute_prerequest (R"JS(
        delete pm.request.headers['Authorization'];
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("Authorization"));
    EXPECT_TRUE (request.headers.contains ("Content-Type"));
}

TEST_F (ScriptEngineTest, PreRequestScriptStringifiesNumberAndBooleanHeaderValues) {
    // `pm.request.headers['X-Timestamp'] = Date.now()` is the shape users
    // actually write; a number has one honest wire form, so it is converted
    // rather than refused.
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Attempt'] = 3;
        pm.request.headers['X-Retry'] = true;
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.headers.at ("X-Attempt"), "3");
    EXPECT_EQ (request.headers.at ("X-Retry"), "true");
}

TEST_F (ScriptEngineTest, PreRequestScriptChangesUrlAndMethod) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.url = 'https://api.example.com/v2/users?page=2';
        pm.request.method = 'post';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/v2/users?page=2");
    EXPECT_EQ (request.method, HttpMethod::POST); // lower-case verb normalised
}

TEST_F (ScriptEngineTest, PreRequestScriptSettingBodyOnABodylessRequestGivesItTextMode) {
    ASSERT_EQ (request.body.mode, BodyMode::None);

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = 'ping';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.content, "ping");
    // Mode matters, not just content: apply_method_and_body ignores a body
    // whose mode is None, so leaving it None would send nothing.
    EXPECT_EQ (request.body.mode, BodyMode::Text);
}

TEST_F (ScriptEngineTest, PreRequestScriptEditingAJsonBodyKeepsItsMode) {
    request.body.mode    = BodyMode::Json;
    request.body.content = R"({"n":1})";

    auto result = engine.execute_prerequest (R"JS(
        var body = JSON.parse(pm.request.body);
        body.n = 2;
        pm.request.body = JSON.stringify(body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.content, R"({"n":2})");
    EXPECT_EQ (request.body.mode, BodyMode::Json);
}

TEST_F (ScriptEngineTest, PreRequestScriptDeletingTheBodyDropsIt) {
    request.body.mode    = BodyMode::Json;
    request.body.content = R"({"n":1})";

    auto result = engine.execute_prerequest (R"JS(
        delete pm.request.body;
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::None);
    EXPECT_TRUE (request.body.content.empty ());
}

TEST_F (ScriptEngineTest, PreRequestScriptEditsMadeBeforeAThrowStillApply) {
    // The request is sent whether or not the script threw, so a header it
    // already set is honoured. The failure is still reported.
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Signature'] = 'abc123';
        undefinedFunction();
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_FALSE (result.error_message.empty ());
    EXPECT_EQ (request.headers.at ("X-Signature"), "abc123");
}

TEST_F (ScriptEngineTest, TestScriptMutationsAreNotWrittenBack) {
    // A post-request script's request has already been sent; writing back
    // there would only misreport what went out.
    ScriptContext ctx;
    ctx.request     = &request;
    ctx.response    = &response;
    ctx.environment = &env;

    auto result = engine.execute (R"JS(
        pm.request.headers['X-Signature'] = 'abc123';
        pm.request.url = 'https://evil.example.com';
    )JS",
    ctx);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("X-Signature"));
    EXPECT_EQ (request.url, "https://api.example.com/users");
}

// ---------------------------------------------------------------------------
// Rejected write-backs: loud, and all-or-nothing.
// ---------------------------------------------------------------------------

TEST_F (ScriptEngineTest, PreRequestScriptUnknownMethodIsRejectedAndAppliesNothing) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Signature'] = 'abc123';
        pm.request.method = 'FETCH';
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request.method"), std::string::npos)
    << result.error_message;
    // Transactional: the good header in the same script is not applied either.
    EXPECT_FALSE (request.headers.contains ("X-Signature"));
    EXPECT_EQ (request.method, HttpMethod::GET);
}

TEST_F (ScriptEngineTest, PreRequestScriptNonStringHeaderValueIsRejectedByName) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Meta'] = { a: 1 };
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("X-Meta"), std::string::npos)
    << result.error_message;
    EXPECT_FALSE (request.headers.contains ("X-Meta"));
}

TEST_F (ScriptEngineTest, PreRequestScriptEmptyUrlIsRejected) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.url = '';
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request.url"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/users");
}

TEST_F (ScriptEngineTest, PreRequestScriptNonStringBodyIsRejected) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = { a: 1 };
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request.body"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::None);
}

TEST_F (ScriptEngineTest, PreRequestScriptReplacingPmRequestWithANonObjectIsRejected) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request = 'oops';
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.request"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.url, "https://api.example.com/users");
}

TEST_F (ScriptEngineTest, PreRequestScriptThatChangesNothingLeavesTheRequestIdentical) {
    const Request before = request;

    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('touched', 'yes');
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.url, before.url);
    EXPECT_EQ (request.method, before.method);
    EXPECT_EQ (request.headers, before.headers);
    EXPECT_EQ (request.body.mode, before.body.mode);
    EXPECT_EQ (request.body.content, before.body.content);
}

// ============================================================================
// Request header methods reach the wire
// ============================================================================
//
// The interaction most likely to break: the methods write the same JS object
// the write-back reads, so every assertion below is on the sent `Request`, not
// on the JS object. Install them on a copy of the header set instead and these
// all still pass in JS while nothing changes on the wire.

TEST_F (ScriptEngineTest, PreRequestHeaderUpsertReachesTheOutgoingRequest) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.upsert({ key: 'X-Signature', value: 'abc123' });
        pm.request.headers.upsert('X-Retry', 2);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_TRUE (request.headers.contains ("X-Signature"));
    EXPECT_EQ (request.headers.at ("X-Signature"), "abc123");
    // (name, value) is Bruno's spelling and the two-arg form users reach for;
    // a number has one honest wire form, same rule as plain assignment.
    EXPECT_EQ (request.headers.at ("X-Retry"), "2");
}

TEST_F (ScriptEngineTest, PreRequestHeaderUpsertReplacesThroughADifferentCasing) {
    // `Headers` is case-insensitive, so writing 'authorization' as a second key
    // would leave the write-back with two spellings of one header - which it
    // refuses outright. upsert writes through the spelling already present.
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.upsert('authorization', 'Bearer script-token');
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.headers.at ("Authorization"), "Bearer script-token");
    EXPECT_EQ (request.headers.count ("Authorization"), 1u);
}

TEST_F (ScriptEngineTest, PreRequestHeaderAddRefusesAnExistingName) {
    // Postman's HeaderList holds duplicates and `add` appends one; a single
    // `Headers` map cannot, so the divergence is named rather than hidden
    // behind add-behaving-as-upsert.
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.add({ key: 'authorization', value: 'Bearer second' });
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("use headers.upsert()"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.headers.at ("Authorization"), "Bearer token123")
    << "a refused add must leave the request untouched";
}

TEST_F (ScriptEngineTest, PreRequestHeaderRemoveIsCaseInsensitiveAndIdempotent) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.remove('AUTHORIZATION');
        pm.request.headers.remove('X-Never-Was');
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("Authorization"));
    EXPECT_TRUE (request.headers.contains ("Content-Type"));
}

TEST_F (ScriptEngineTest, PreRequestHeaderMethodsAndAssignmentShareOneSet) {
    // Two views of one header set is the failure this pins: a method call, a
    // plain assignment and a delete, interleaved, must compose into exactly the
    // set that goes on the wire.
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.upsert('X-One', '1');
        pm.request.headers['X-Two'] = '2';
        pm.expect(pm.request.headers['X-One']).to.equal('1');
        pm.expect(pm.request.headers.get('x-two')).to.equal('2');
        pm.request.headers.remove('X-One');
        delete pm.request.headers['Content-Type'];
        pm.expect(pm.request.headers.has('X-One')).to.be.false;
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("X-One"));
    EXPECT_EQ (request.headers.at ("X-Two"), "2");
    EXPECT_FALSE (request.headers.contains ("Content-Type"));
    EXPECT_TRUE (request.headers.contains ("Authorization"));
}

TEST_F (ScriptEngineTest, PreRequestHeaderAddRefusesAValueItCannotSend) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers.add({ key: 'X-Object', value: { nested: true } });
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("must be a string, number or boolean"),
    std::string::npos)
    << result.error_message;
    EXPECT_FALSE (request.headers.contains ("X-Object"));
}

TEST_F (ScriptEngineTest, PreRequestAHeaderNamedLikeAMethodStillReachesTheWire) {
    // The methods are non-enumerable properties of the header object itself, so
    // a header field literally named `get` collides with one. Data wins: the
    // entry is defined over the method and is sent. Losing it silently would be
    // the exact defect this surface was added to avoid.
    request.headers["get"] = "not-a-method";

    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('getType', typeof pm.request.headers.get);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["getType"].value, "string");
    EXPECT_EQ (request.headers.at ("get"), "not-a-method");
}

// ============================================================================
// Complex Script Tests
// ============================================================================

TEST_F (ScriptEngineTest, ComplexTestScript) {
    auto result = engine.execute_test (R"(
        // Multiple assertions in complex test
        pm.test("Comprehensive response check", function() {
            pm.expect(pm.response.code).to.equal(200);
            
            var json = pm.response.json();
            pm.expect(json).to.have.property("id");
            pm.expect(json).to.have.property("name");
            pm.expect(json).to.have.property("email");
            
            pm.expect(json.name).to.exist;
            pm.expect(json.id).to.be.above(0);
        });

        pm.test("Response time acceptable", function() {
            pm.expect(pm.response.responseTime).to.be.below(5000);
        });

        pm.test("Correct content type", function() {
            pm.expect(pm.response.headers["Content-Type"]).to.include("json");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    EXPECT_EQ (result.tests.size (), 3);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << "Failed: " << test.name;
    }
}

TEST_F (ScriptEngineTest, MixedPassFail) {
    auto result = engine.execute_test (R"(
        pm.test("This passes", function() {
            pm.expect(200).to.equal(200);
        });

        pm.test("This fails", function() {
            pm.expect(200).to.equal(404);
        });

        pm.test("This also passes", function() {
            pm.expect("ok").to.equal("ok");
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success); // Overall should fail
    ASSERT_EQ (result.tests.size (), 3);
    EXPECT_TRUE (result.tests[0].passed);
    EXPECT_FALSE (result.tests[1].passed);
    EXPECT_TRUE (result.tests[2].passed);
}

TEST_F (ScriptEngineTest, ContextPooling) {
    // Run multiple executions to verify context pooling works and doesn't crash
    for (int i = 0; i < 10; ++i) {
        auto result = engine.execute_test (R"(
            pm.test("Pooling test", function() {
                pm.expect(1).to.equal(1);
            });
        )",
        request, response, env);

        EXPECT_TRUE (result.success);
        ASSERT_EQ (result.tests.size (), 1);
        EXPECT_TRUE (result.tests[0].passed);
    }
}

// ============================================================================
// Script Execution Timeout Tests (#107)
// ============================================================================

// A non-allocating infinite loop must be interrupted by the wall-clock deadline
// rather than hanging the calling thread. Mutation-check: revert the
// JS_SetInterruptHandler wiring in acquire_context/execute and this test hangs.
TEST_F (ScriptEngineTest, InfiniteLoopTimesOut) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 200;
    ScriptEngine timeout_engine (cfg);

    ScriptContext ctx;
    ctx.response = &response;

    const auto start   = std::chrono::steady_clock::now ();
    auto result        = timeout_engine.execute ("while (true) {}", ctx);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - start)
                         .count ();

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("timed out"), std::string::npos)
    << "error was: " << result.error_message;
    // Should abort near the deadline, not run indefinitely. Generous upper bound to
    // stay robust on slow CI while still proving the loop does not run forever.
    EXPECT_LT (elapsed, 5000) << "took " << elapsed << "ms";
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// A fast script under the limit must not be falsely aborted by the deadline.
TEST_F (ScriptEngineTest, FastScriptUnderTimeoutStillPasses) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 200;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (R"(
        pm.test("Fast test", function() {
            pm.expect(1).to.equal(1);
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    EXPECT_TRUE (result.error_message.empty ());
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed);
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// timeout_ms == 0 disables the wall-clock limit (escape hatch); a bounded loop
// still completes normally with no false timeout.
TEST_F (ScriptEngineTest, ZeroTimeoutDisablesLimit) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 0;
    ScriptEngine no_timeout_engine (cfg);

    ScriptContext ctx;
    auto result = no_timeout_engine.execute (
    "var n = 0; for (var i = 0; i < 100000; i++) { n += i; } n", ctx);

    EXPECT_TRUE (result.success);
    EXPECT_TRUE (result.error_message.empty ());
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// ============================================================================
// The sandbox's global surface
// ============================================================================
//
// `scripting.md` now teaches request rewriting, so what a script can *compute*
// is part of the contract. Only `console` and `pm` are installed on top of
// QuickJS's built-ins - there is no crypto, no base64, no URL parser - which is
// why the docs' worked examples do string surgery and a pure-JS checksum rather
// than an HMAC. This pins both halves so a doc example cannot come to rely on
// something that was never there (`scripting.md` used to show a `computeHash`
// that does not exist).

TEST_F (ScriptEngineTest, StandardBuiltinsAreAvailableToScripts) {
    auto result = engine.execute_prerequest (R"JS(
        var missing = [];
        var expected = ['JSON', 'Date', 'Math', 'RegExp', 'String', 'Array',
                        'Object', 'Number', 'encodeURIComponent', 'parseInt'];
        for (var i = 0; i < expected.length; i++) {
            if (typeof globalThis[expected[i]] === 'undefined') missing.push(expected[i]);
        }
        pm.environment.set('missing', missing.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["missing"].value, "")
    << "a built-in the docs rely on disappeared";
}

TEST_F (ScriptEngineTest, NoCryptoBase64OrUrlParserIsExposed) {
    auto result = engine.execute_prerequest (R"JS(
        var present = [];
        var absent = ['crypto', 'btoa', 'atob', 'TextEncoder', 'URL',
                      'URLSearchParams', 'require', 'fetch'];
        for (var i = 0; i < absent.length; i++) {
            if (typeof globalThis[absent[i]] !== 'undefined') present.push(absent[i]);
        }
        pm.environment.set('present', present.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    // If one of these ever lands, the "you cannot HMAC-sign in a script" note in
    // scripting.md stops being true and should be rewritten, not left standing.
    EXPECT_EQ (env["present"].value, "")
    << "a new global is available - update the request-signing note in "
       "scripting.md";
}

// ============================================================================
// The `pm` surface the docs and the app teach
// ============================================================================
//
// Same reason as the two above: a name that is written down but not installed
// throws in the user's face, and nothing else notices. `scripting.md` taught
// `pm.variables` and the Tests panel's quick reference taught
// `pm.response.headers.get()`; neither had ever existed. `pm.variables` has
// since been built (#184), so the tests below now pin it as *present* and its
// documented precedence; `pm.response.headers.get()` is still absent and stays
// pinned that way, so implementing it flips a test red and forces the doc to be
// rewritten with it.

// Every scope answers the same six names, and the merged accessor exists (#184).
// This is the list both script docs promise, checked against the runtime rather
// than against itself - a method dropped from setup_pm_variable_scope shows up
// here as a name, not as a mysteriously undefined call somewhere downstream.
TEST_F (ScriptEngineTest, EveryVariableScopeExposesTheSameSurfaceAndPmVariablesExists) {
    auto result = engine.execute_prerequest (R"JS(
        var missing = [];
        var scopes = ['environment', 'globals', 'collectionVariables'];
        var methods = ['get', 'set', 'has', 'unset', 'clear', 'toObject'];
        for (var i = 0; i < scopes.length; i++) {
            var scope = pm[scopes[i]];
            if (!scope) { missing.push(scopes[i]); continue; }
            for (var j = 0; j < methods.length; j++) {
                if (typeof scope[methods[j]] !== 'function') {
                    missing.push(scopes[i] + '.' + methods[j]);
                }
            }
        }
        // The merged accessor reads across scopes; it deliberately has no
        // unset/clear, since it owns no scope to remove a name from.
        var merged = ['get', 'has', 'toObject', 'set'];
        for (var k = 0; k < merged.length; k++) {
            if (!pm.variables || typeof pm.variables[merged[k]] !== 'function') {
                missing.push('variables.' + merged[k]);
            }
        }
        pm.environment.set('missing', missing.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["missing"].value, "")
    << "a variable-scope method both script docs teach is not installed";
}

TEST_F (ScriptEngineTest, HasIsTrueOnlyForAVariableGetCanRead) {
    env["disabled"] = Variable{ "value", false, false };

    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('present', String(pm.environment.has('base_url')));
        pm.environment.set('absent', String(pm.environment.has('nope')));
        // A row the user unticked reads as absent, the same way get() skips it.
        pm.environment.set('disabledIsHidden', String(pm.environment.has('disabled')));
        pm.environment.set('noArgument', String(pm.environment.has()));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["present"].value, "true");
    EXPECT_EQ (env["absent"].value, "false");
    EXPECT_EQ (env["disabledIsHidden"].value, "false");
    EXPECT_EQ (env["noArgument"].value, "false");
}

// The method with no workaround before #184: setting a variable to "" leaves an
// enabled empty variable behind, which {{template}} resolution still finds.
TEST_F (ScriptEngineTest, UnsetRemovesTheVariableRatherThanEmptyingIt) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.unset('api_key');
        pm.environment.set('readBack', String(pm.environment.get('api_key')));
        pm.environment.unset('never_existed');
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env.count ("api_key"), 0U) << "the key is still in the map";
    EXPECT_EQ (env["readBack"].value, "undefined");
}

// A disabled variable is invisible to get/has but is still a key, so unset and
// clear remove it - they were asked to delete a name, not to read one.
TEST_F (ScriptEngineTest, UnsetAndClearRemoveDisabledVariablesToo) {
    env["disabled"] = Variable{ "value", false, false };

    auto result = engine.execute_prerequest (R"JS(
        pm.environment.unset('disabled');
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env.count ("disabled"), 0U);
}

TEST_F (ScriptEngineTest, ClearEmptiesOnlyItsOwnScope) {
    Environment globals;
    globals["g"] = Variable{ "kept", false, true };
    Environment collVars;
    collVars["c"] = Variable{ "kept", false, true };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &collVars;

    auto result = engine.execute (R"JS(
        pm.environment.clear();
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (env.empty ());
    EXPECT_EQ (globals.size (), 1U)
    << "clear() reached a scope it was not called on";
    EXPECT_EQ (collVars.size (), 1U);
}

TEST_F (ScriptEngineTest, ToObjectSnapshotsEnabledVariablesWithTheirDeclaredTypes) {
    env["count"]    = Variable{ "42", false, true, "number" };
    env["disabled"] = Variable{ "value", false, false };

    auto result = engine.execute_prerequest (R"JS(
        var snapshot = pm.environment.toObject();
        pm.environment.set('baseUrl', snapshot['base_url']);
        // Cast by declared type, exactly as get() would answer it.
        pm.environment.set('countType', typeof snapshot['count']);
        pm.environment.set('hasDisabled', String('disabled' in snapshot));
        // A snapshot, not a view: writing to it must not reach the scope.
        snapshot['base_url'] = 'mutated';
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["baseUrl"].value, "https://api.example.com");
    EXPECT_EQ (env["countType"].value, "number");
    EXPECT_EQ (env["hasDisabled"].value, "false");
    EXPECT_EQ (env["base_url"].value, "https://api.example.com")
    << "toObject() handed out a live view of the scope";
}

// The precedence pm.variables resolves in - environment, then collection, then
// global - is the order {{name}} already uses app-side, so a script and a URL
// in the same request cannot read one name two ways.
TEST_F (ScriptEngineTest, PmVariablesResolvesEnvironmentThenCollectionThenGlobal) {
    Environment globals;
    globals["everywhere"]  = Variable{ "from-globals", false, true };
    globals["only_global"] = Variable{ "global-only", false, true };
    Environment collVars;
    collVars["everywhere"] = Variable{ "from-collection", false, true };
    collVars["in_two"]     = Variable{ "from-collection", false, true };
    Environment environment;
    environment["everywhere"] = Variable{ "from-environment", false, true };
    environment["disabled"]   = Variable{ "hidden", false, false };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &environment;
    ctx.globals             = &globals;
    ctx.collectionVariables = &collVars;

    auto result = engine.execute (R"JS(
        pm.globals.set('winner', String(pm.variables.get('everywhere')));
        pm.globals.set('lowestOnly', String(pm.variables.get('only_global')));
        pm.globals.set('middle', String(pm.variables.get('in_two')));
        pm.globals.set('nowhere', String(pm.variables.get('missing')));
        pm.globals.set('hasLowest', String(pm.variables.has('only_global')));
        pm.globals.set('hasNowhere', String(pm.variables.has('missing')));
        // A disabled variable is not a hit, so resolution keeps looking.
        pm.globals.set('hasDisabled', String(pm.variables.has('disabled')));
        var merged = pm.variables.toObject();
        pm.globals.set('mergedWinner', String(merged['everywhere']));
        pm.globals.set('mergedKeeps', String(merged['only_global']));
        pm.globals.set('mergedHasDisabled', String('disabled' in merged));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["winner"].value, "from-environment");
    EXPECT_EQ (globals["middle"].value, "from-collection");
    EXPECT_EQ (globals["lowestOnly"].value, "global-only");
    EXPECT_EQ (globals["nowhere"].value, "undefined");
    EXPECT_EQ (globals["hasLowest"].value, "true");
    EXPECT_EQ (globals["hasNowhere"].value, "false");
    EXPECT_EQ (globals["hasDisabled"].value, "false");
    // The merged snapshot agrees with get() name for name, or it is a second
    // answer to the same question.
    EXPECT_EQ (globals["mergedWinner"].value, "from-environment");
    EXPECT_EQ (globals["mergedKeeps"].value, "global-only");
    EXPECT_EQ (globals["mergedHasDisabled"].value, "false");
}

// Postman's pm.variables.set writes to a local scope that lives for one request.
// Vayu has none, and both substitutes lie: writing to the environment persists
// a value the author expects to vanish, dropping it loses a write they believe
// happened. So it throws, and the message names the three scopes that exist.
TEST_F (ScriptEngineTest, PmVariablesSetThrowsRatherThanGuessingAScope) {
    auto result = engine.execute_prerequest (R"JS(
        pm.variables.set('token', 'value');
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pm.variables.set is not supported"),
    std::string::npos)
    << result.error_message;
    EXPECT_NE (result.error_message.find ("pm.environment.set()"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (env.count ("token"), 0U)
    << "the throwing write still landed somewhere";
}

// A run can be given fewer than three scopes - a design run with no active
// environment, for instance. Every method has to read that as an empty scope: a
// script cannot see which scopes it was handed, so a throw here would fail it
// for a reason its author cannot inspect.
TEST_F (ScriptEngineTest, AScopeTheRunDoesNotCarryBehavesAsEmptyRatherThanThrowing) {
    ScriptContext ctx;
    ctx.request     = &request;
    ctx.environment = &env; // globals and collectionVariables stay null

    auto result = engine.execute (R"JS(
        pm.globals.set('ignored', 'value');
        pm.globals.unset('ignored');
        pm.globals.clear();
        pm.environment.set('absentGet', String(pm.globals.get('anything')));
        pm.environment.set('absentHas', String(pm.globals.has('anything')));
        pm.environment.set('absentKeys', Object.keys(pm.globals.toObject()).join(','));
        pm.environment.set('mergedStillReads', String(pm.variables.get('base_url')));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["absentGet"].value, "undefined");
    EXPECT_EQ (env["absentHas"].value, "false");
    EXPECT_EQ (env["absentKeys"].value, "");
    EXPECT_EQ (env["mergedStillReads"].value, "https://api.example.com");
}

// ============================================================================
// Header accessors (pm.response.headers / pm.request.headers)
// ============================================================================
//
// The lookup is case-insensitive because HTTP header names are and JS object
// keys are not: a response's keys arrive lower-cased from `client.cpp`, a
// request's keep whatever the user typed, and indexing therefore only works if
// you happen to know which. That mismatch is what made the Tests panel's
// suggested `pm.response.headers.get("Content-Type")` throw for as long as it
// was offered.

TEST_F (ScriptEngineTest, ResponseHeadersGetAndHasAreCaseInsensitive) {
    // The header names a real response arrives with: `client.cpp` lower-cases
    // every key as it parses, so this - not the fixture's mixed-case default -
    // is the shape a script actually sees.
    response.headers = { { "content-type", "application/json" },
        { "x-request-id", "abc123" } };

    auto result = engine.execute_test (R"JS(
        pm.test("the form the Tests panel suggests reads the header", function() {
            pm.expect(pm.response.headers.get('Content-Type')).to.equal('application/json');
            pm.expect(pm.response.headers.get('content-type')).to.equal('application/json');
            pm.expect(pm.response.headers.get('CONTENT-TYPE')).to.equal('application/json');
        });
        pm.test("indexing by the stored key still works", function() {
            pm.expect(pm.response.headers['content-type']).to.equal('application/json');
        });
        pm.test("has() answers both ways", function() {
            pm.expect(pm.response.headers.has('X-Request-Id')).to.be.true;
            pm.expect(pm.response.headers.has('x-nope')).to.be.false;
        });
        pm.environment.set('missing', String(pm.response.headers.get('X-Absent')));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 3u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
    // An absent header is undefined, not a throw - `if (headers.get(x))` is the
    // idiom this exists to make writable.
    EXPECT_EQ (env["missing"].value, "undefined");
}

TEST_F (ScriptEngineTest, HeaderMethodsAreInvisibleToEnumerationAndJson) {
    // The write-back reads own *enumerable* string properties as the outgoing
    // header set. If the methods were enumerable it would see a header whose
    // value is a function and refuse the whole edit - so this is the guard that
    // keeps them off the wire, and it also keeps console.log(headers) honest.
    auto result = engine.execute_test (R"JS(
        pm.environment.set('responseKeys', Object.keys(pm.response.headers).sort().join(','));
        pm.environment.set('requestKeys', Object.keys(pm.request.headers).sort().join(','));
        pm.environment.set('json', JSON.stringify(pm.request.headers));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["responseKeys"].value, "Content-Type,X-Request-Id");
    EXPECT_EQ (env["requestKeys"].value, "Authorization,Content-Type");
    EXPECT_EQ (env["json"].value,
    R"({"Authorization":"Bearer token123","Content-Type":"application/json"})");
}

TEST_F (ScriptEngineTest, HeaderMethodsRefuseBadInputByName) {
    auto result = engine.execute_test (R"JS(
        function reason(fn) {
            try { fn(); return 'no throw'; } catch (e) { return String(e.message || e); }
        }
        pm.environment.set('noArg', reason(function() { pm.response.headers.get(); }));
        pm.environment.set('number', reason(function() { pm.response.headers.get(42); }));
        pm.environment.set('empty', reason(function() { pm.response.headers.has(''); }));
        pm.environment.set('detached', reason(function() {
            var get = pm.response.headers.get;
            get('Content-Type');
        }));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_NE (env["noArg"].value.find ("needs a header name string"), std::string::npos)
    << env["noArg"].value;
    EXPECT_NE (env["number"].value.find ("got number"), std::string::npos)
    << env["number"].value;
    EXPECT_NE (env["empty"].value.find ("non-empty"), std::string::npos)
    << env["empty"].value;
    // Detaching leaves `this` undefined, which would otherwise read as "no such
    // header" - a wrong answer dressed as a real one.
    EXPECT_NE (env["detached"].value.find ("must be called on a headers object"),
    std::string::npos)
    << env["detached"].value;
}

TEST_F (ScriptEngineTest, ResponseHeadersHaveNoMutators) {
    // The response has already arrived; a method that appeared to change it
    // would be a lie, so only the two readers are installed there.
    auto result = engine.execute_test (R"JS(
        pm.environment.set('add', typeof pm.response.headers.add);
        pm.environment.set('upsert', typeof pm.response.headers.upsert);
        pm.environment.set('remove', typeof pm.response.headers.remove);
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["add"].value, "undefined");
    EXPECT_EQ (env["upsert"].value, "undefined");
    EXPECT_EQ (env["remove"].value, "undefined");
}

TEST_F (ScriptEngineTest, ResponseReasonReportsTheStatusText) {
    response.status_code = 404;
    response.status_text = "Not Found";

    auto result = engine.execute_test (R"JS(
        pm.environment.set('reason', pm.response.reason());
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["reason"].value, "Not Found");
}

TEST_F (ScriptEngineTest, ResponseReasonFallsBackToTheCanonicalTextIncludingStatusZero) {
    // Status 0 is vayu's synthetic value for a client-side failure, where no
    // server ever sent a reason phrase. `vayu::http::status_text` has an answer
    // for it, so reason() is a string there rather than an empty one.
    response.status_code = 0;
    response.status_text.clear ();

    auto result = engine.execute_test (R"JS(
        pm.environment.set('reason', pm.response.reason());
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["reason"].value, "Error");
}

TEST_F (ScriptEngineTest, ResponseSizeTotalsBodyAndHeaders) {
    response.headers = { { "content-type", "application/json" } };
    response.body    = R"({"n":1})";

    auto result = engine.execute_test (R"JS(
        var size = pm.response.size();
        pm.environment.set('body', String(size.body));
        pm.environment.set('header', String(size.header));
        pm.environment.set('total', String(size.total));
        pm.environment.set('matchesText', String(size.body === pm.response.text().length));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["body"].value, "7");
    // "content-type" + ": " + "application/json" + CRLF
    EXPECT_EQ (env["header"].value, "32");
    EXPECT_EQ (env["total"].value, "39");
    EXPECT_EQ (env["matchesText"].value, "true");
}

TEST_F (ScriptEngineTest, ResponseSizeReportsZeroForAnEmptyBody) {
    response.headers.clear ();
    response.body.clear ();

    auto result = engine.execute_test (R"JS(
        var size = pm.response.size();
        pm.environment.set('body', String(size.body));
        pm.environment.set('total', String(size.total));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    // Reported as 0, not omitted - an absent property would read as "unknown".
    EXPECT_EQ (env["body"].value, "0");
    EXPECT_EQ (env["total"].value, "0");
}

// ============================================================================
// The worked examples in scripting.md actually run
// ============================================================================
//
// This whole issue existed because the docs taught a pattern the runtime threw
// away, and the example they taught it with called a `computeHash` that has
// never existed. So the non-trivial examples are executed here against a real
// request, not eyeballed. If you edit the code in
// "Worked examples: rewriting a request", edit these with it.

TEST_F (ScriptEngineTest, DocExampleRewritesAJsonBodyThenDerivesFromIt) {
    request.method       = HttpMethod::POST;
    request.body.mode    = BodyMode::Json;
    request.body.content = R"({"n":1,"debugOnly":true})";

    auto result = engine.execute_prerequest (R"JS(
        var body = JSON.parse(pm.request.body);
        body.metadata = { client: 'vayu' };
        delete body.debugOnly;
        pm.request.body = JSON.stringify(body);
        pm.request.headers['Content-Length'] = String(pm.request.body.length);
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.content, R"({"n":1,"metadata":{"client":"vayu"}})");
    // Derived after the edit, so it describes what is sent - the ordering the
    // doc calls out.
    EXPECT_EQ (request.headers.at ("Content-Length"),
    std::to_string (request.body.content.size ()));
}

TEST_F (ScriptEngineTest, DocExampleSetsAQueryParamAcrossItsThreeCases) {
    static constexpr const char* kSetQueryParam = R"JS(
        function setQueryParam(url, name, value) {
          var pair = encodeURIComponent(name) + '=' + encodeURIComponent(value);
          var hashAt = url.indexOf('#');
          var fragment = hashAt === -1 ? '' : url.slice(hashAt);
          var base = hashAt === -1 ? url : url.slice(0, hashAt);

          var re = new RegExp('([?&])' + name + '=[^&]*');
          if (re.test(base)) {
            return base.replace(re, '$1' + pair) + fragment;
          }
          return base + (base.indexOf('?') === -1 ? '?' : '&') + pair + fragment;
        }
    )JS";

    struct Case {
        const char* url;
        const char* expected;
    };
    const Case cases[] = {
        // No query at all.
        { "https://api.example.com/users", "https://api.example.com/users?traceId=t1" },
        // Query present, parameter absent.
        { "https://api.example.com/users?page=2", "https://api.example.com/users?page=2&traceId=t1" },
        // Parameter already present - replaced, not duplicated.
        { "https://api.example.com/users?traceId=old&page=2",
        "https://api.example.com/users?traceId=t1&page=2" },
        // Fragment is preserved and never searched for the parameter.
        { "https://api.example.com/users#section", "https://api.example.com/users?traceId=t1#section" },
    };

    for (const auto& c : cases) {
        Request req;
        req.method = HttpMethod::GET;
        req.url    = c.url;
        Environment scratch;
        auto result = engine.execute_prerequest (std::string (kSetQueryParam) +
        "\npm.request.url = setQueryParam(pm.request.url, 'traceId', 't1');",
        req, scratch);

        ASSERT_TRUE (result.success) << result.error_message;
        EXPECT_EQ (req.url, c.expected) << "input: " << c.url;
    }
}

TEST_F (ScriptEngineTest, DocExampleChecksumIsComputableAndStable) {
    env["secret"] = Variable{ "s3cr3t", true, true };

    auto result = engine.execute_prerequest (R"JS(
        function fnv1a(text) {
          var hash = 0x811c9dc5;
          for (var i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
          }
          return ('00000000' + hash.toString(16)).slice(-8);
        }

        var canonical = [
          pm.request.method,
          pm.request.url,
          '1700000000000',
          pm.request.body || ''
        ].join('\n');

        pm.request.headers['X-Timestamp'] = '1700000000000';
        pm.request.headers['X-Checksum'] = fnv1a(canonical + pm.environment.get('secret'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.headers.at ("X-Timestamp"), "1700000000000");
    // Eight lower-case hex digits, deterministic for a fixed canonical string.
    const std::string checksum = request.headers.at ("X-Checksum");
    EXPECT_EQ (checksum.size (), 8u) << checksum;
    EXPECT_EQ (checksum.find_first_not_of ("0123456789abcdef"), std::string::npos) << checksum;
}

TEST_F (ScriptEngineTest, DocExampleSwapsAuthScheme) {
    auto result = engine.execute_prerequest (R"JS(
        delete pm.request.headers['Authorization'];
        pm.request.headers['X-Api-Key'] = pm.environment.get('api_key');
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("Authorization"));
    EXPECT_EQ (request.headers.at ("X-Api-Key"), "secret123");
}

// The trap the doc now warns about, and why it warns: `pm.request.headers` is a
// JS object, so its keys are case-sensitive even though HTTP header names are
// not. A lower-case delete of a capitalised header is a silent no-op - this
// caught a wrong sentence in the docs before it shipped.
TEST_F (ScriptEngineTest, AWrongCaseDeleteDoesNotRemoveTheHeader) {
    auto result = engine.execute_prerequest (R"JS(
        delete pm.request.headers['authorization'];
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (request.headers.contains ("Authorization"));
}

TEST_F (ScriptEngineTest, DocExampleCaseInsensitiveDeleteLoopRemovesTheHeader) {
    auto result = engine.execute_prerequest (R"JS(
        Object.keys(pm.request.headers).forEach(function (name) {
          if (name.toLowerCase() === 'authorization') delete pm.request.headers[name];
        });
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (request.headers.contains ("Authorization"));
    EXPECT_TRUE (request.headers.contains ("Content-Type"));
}

// Two JS keys, one HTTP header. Whichever enumerated last would have won
// silently, and one of them is the Authorization header, so the write-back
// refuses the whole thing instead of guessing.
TEST_F (ScriptEngineTest, HeaderNamesDifferingOnlyInCaseAreRejected) {
    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['authorization'] = 'Bearer script-token';
    )JS",
    request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("case-insensitive"), std::string::npos)
    << result.error_message;
    // Nothing applied: the original engine-applied header still stands.
    EXPECT_EQ (request.headers.at ("Authorization"), "Bearer token123");
}
