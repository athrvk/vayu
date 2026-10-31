/**
 * @file script_engine_test.cpp
 * @brief Tests for QuickJS scripting engine
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <regex>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

#include "echo_server.hpp"
#include "library_call_config.hpp"
#include "step_elements_test_helper.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/diagnostics.hpp"
#include "vayu/utils/encoding.hpp"

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

    /**
     * Runs one assertion inside a `pm.test`. Answers an empty string when it
     * held and the report's error text when it did not, so a case can assert
     * both that it failed and what it said.
     */
    std::string verdict_of (const std::string& assertion) {
        const std::string script = "pm.test(\"t\", function() {\n" + assertion + ";\n});";
        const auto result = engine.execute_test (script, request, response, env);
        if (result.tests.size () != 1u) {
            return "<no test recorded for: " + assertion + ">";
        }
        return result.tests[0].passed ? std::string{} : result.tests[0].error_message;
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

#ifdef VAYU_HAS_QUICKJS
// version() reported a hardcoded "QuickJS 2024-01-13" while the tree carried
// quickjs-ng 0.16.0 (issue #112), and the assertion above - non-empty - could
// not tell the difference. Pin it to what the vendored runtime reports instead,
// so the string tracks a vendor bump rather than needing to be remembered.
TEST_F (ScriptEngineTest, VersionReportsTheVendoredRuntime) {
    const std::string reported = ScriptEngine::version ();

    // A version, not a release date. Deliberately not pinned to the current
    // 0.16.0: the point is that the string comes from the vendored runtime, so
    // a vendor bump should keep this green while a hardcoded literal cannot.
    EXPECT_TRUE (std::regex_search (reported, std::regex (R"(QuickJS-ng \d+\.\d+\.\d+)")))
    << "version() must report the vendored quickjs-ng version, got: " << reported;
    EXPECT_EQ (reported.find ("2024-01-13"), std::string::npos)
    << "version() is carrying a hardcoded date again: " << reported;
}
#endif

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
// pm.test() done-callbacks, chainability, pm.expect.fail (issue #1004)
// ============================================================================

// Mutation check for this block: call the callback with zero arguments again
// (`JS_Call (ctx, argv[1], JS_UNDEFINED, 0, nullptr)`) and every done-style
// case below reddens - `done` is `undefined`, calling it is a TypeError, and
// the test that should pass fails with "not a function". The one exception is
// AThrowBeatsTheNeverCalledRule, which never reaches `done` and so passes on
// that code too; it guards an ordering the reversion does not disturb, and
// names its own mutation.

TEST_F (ScriptEngineTest, DoneCallbackPassesWhenItIsCalled) {
    auto result = engine.execute_test (R"(
        pm.test("done passes", function (done) {
            pm.expect(1).to.equal(1);
            done();
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, DoneCallbackFailsWithTheErrorItIsGiven) {
    auto result = engine.execute_test (R"(
        pm.test("done fails", function (done) {
            done(new Error("the token was empty"));
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("the token was empty"), std::string::npos)
    << "error was: " << result.tests[0].error_message;
}

// Mocha's rule, which postman-sandbox follows: the argument is a failure when
// it is truthy, not when it is an Error. A falsy one completes the test, which
// is what `done(err)` in a callback-style helper does on success.
TEST_F (ScriptEngineTest, DoneCallbackTreatsAnyTruthyArgumentAsTheFailure) {
    auto result = engine.execute_test (R"(
        pm.test("truthy fails", function (done) { done("plain string"); });
        pm.test("falsy passes", function (done) { done(null); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("plain string"), std::string::npos)
    << "error was: " << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
}

// The divergence from Postman, made loud. Postman genuinely waits for a later
// done(); this sandbox judges the test when its callback returns, so the test
// is failed with the reason rather than reported on a verdict nothing gave.
TEST_F (ScriptEngineTest, DoneCallbackNeverCalledFailsSayingItIsJudgedOnReturn) {
    auto result = engine.execute_test (R"(
        pm.test("never completes", function (done) {
            pm.expect(1).to.equal(1);
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("done() was never called"),
    std::string::npos)
    << "error was: " << result.tests[0].error_message;
    EXPECT_NE (
    result.tests[0].error_message.find ("before the callback returns"), std::string::npos)
    << "error was: " << result.tests[0].error_message;
}

// A done() left for a promise job runs once the queue drains, after the row
// was written: the never-called verdict stands and the late call changes
// nothing.
TEST_F (ScriptEngineTest, ADoneLeftForAPromiseJobIsNotWaitedFor) {
    auto result = engine.execute_test (R"(
        pm.test("later", function (done) {
            Promise.resolve().then(function () { done(); });
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("done() was never called"),
    std::string::npos)
    << "error was: " << result.tests[0].error_message;
}

// A throw is already the verdict: a callback that threw before reaching its
// done() is not also an asynchronous-completion mistake, and the reader needs
// the error that actually happened. Its own mutation check is the branch, not
// the call: consult the done verdict unconditionally rather than in the
// `else if` that the exception arm precedes, and the never-called message
// replaces the error the script actually threw.
TEST_F (ScriptEngineTest, AThrowBeatsTheNeverCalledRule) {
    auto result = engine.execute_test (R"(
        pm.test("throws first", function (done) {
            throw new Error("the real failure");
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("the real failure"), std::string::npos)
    << "error was: " << result.tests[0].error_message;
    EXPECT_EQ (result.tests[0].error_message.find ("done() was never called"),
    std::string::npos)
    << "error was: " << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, DoneCalledTwiceFailsNamingIt) {
    auto result = engine.execute_test (R"(
        pm.test("done twice", function (done) {
            done();
            done();
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("already called"), std::string::npos)
    << "error was: " << result.tests[0].error_message;
}

// The reason `done` reports through a JS object rather than through a pointer
// to `js_pm_test`'s frame: nothing stops a script keeping it and calling it
// after pm.test returned, later in the script or from a promise job, and the
// call runs against a stack frame that is gone. Here it is
// an ordinary refused second call, and the recorded verdict is untouched.
TEST_F (ScriptEngineTest, DoneOutlivesTheCallThatHandedItOut) {
    auto result = engine.execute_test (R"(
        var saved;
        pm.test("completes", function (done) {
            saved = done;
            done();
        });
        try {
            saved();
        } catch (e) {
            console.log("late call: " + e.message);
        }
        pm.test("still running", function () {});
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_EQ (result.tests.size (), 2);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
}

// Mutation check: return JS_UNDEFINED again and the chained call is a
// TypeError on `undefined`, which aborts the script - no test is recorded at
// all, so the size assertion is what reddens.
TEST_F (ScriptEngineTest, PmTestIsChainable) {
    auto result = engine.execute_test (R"(
        pm.test("first", function () {
            pm.expect(1).to.equal(1);
        }).test("second", function () {
            pm.expect(2).to.equal(2);
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_EQ (result.tests.size (), 2);
    EXPECT_EQ (result.tests[0].name, "first");
    EXPECT_EQ (result.tests[1].name, "second");
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
}

TEST_F (ScriptEngineTest, PmExpectFailRecordsAnAssertionFailureInsideATest) {
    auto result = engine.execute_test (R"(
        pm.test("gives up", function () {
            pm.expect.fail("no branch should reach here");
        });
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("AssertionError"), std::string::npos)
    << "error was: " << result.tests[0].error_message;
    EXPECT_NE (
    result.tests[0].error_message.find ("no branch should reach here"), std::string::npos)
    << "error was: " << result.tests[0].error_message;
}

// Outside a test it aborts the script the way any uncaught throw does - but as
// an AssertionError, which is the difference from today's TypeError.
TEST_F (ScriptEngineTest, PmExpectFailOutsideATestIsAnAssertionError) {
    auto result = engine.execute_test (R"(
        pm.expect.fail("stopping here");
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("AssertionError"), std::string::npos)
    << "error was: " << result.error_message;
    EXPECT_NE (result.error_message.find ("stopping here"), std::string::npos)
    << "error was: " << result.error_message;
}

TEST_F (ScriptEngineTest, PmExpectFailDefaultsToChaisOwnMessage) {
    auto result = engine.execute_test (R"(
        pm.test("bare fail", function () { pm.expect.fail(); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("expect.fail()"), std::string::npos)
    << "error was: " << result.tests[0].error_message;
}

// chai's four-argument form carries the two compared values on the
// AssertionError; this one has nowhere to put them, so it is refused by name
// rather than reporting `actual` as the failure text.
TEST_F (ScriptEngineTest, PmExpectFailRefusesChaisFourArgumentForm) {
    auto result = engine.execute_test (R"(
        pm.test("wrong form", function () { pm.expect.fail(1, 2); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("TypeError"), std::string::npos)
    << "error was: " << result.tests[0].error_message;
    EXPECT_NE (result.tests[0].error_message.find ("not supported"), std::string::npos)
    << "error was: " << result.tests[0].error_message;
}

// ============================================================================
// pm.expect() Assertion Tests
// ============================================================================

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

// `.true` / `.false` are `=== true` / `=== false`, as in chai; `.ok` is the
// coercing matcher (#2523).
TEST_F (ScriptEngineTest, ExpectTrueAndFalseRequireARealBoolean) {
    auto result = engine.execute_test (R"(
        pm.test("true is true", function() { pm.expect(true).to.be.true; });
        pm.test("false is false", function() { pm.expect(false).to.be.false; });
        pm.test("'true' is not true", function() { pm.expect('true').to.be.true; });
        pm.test("1 is not true", function() { pm.expect(1).to.be.true; });
        pm.test("{} is not true", function() { pm.expect({}).to.be.true; });
        pm.test("'' is not false", function() { pm.expect('').to.be.false; });
        pm.test("0 is not false", function() { pm.expect(0).to.be.false; });
        pm.test("null is not false", function() { pm.expect(null).to.be.false; });
        pm.test("undefined is not false", function() { pm.expect(undefined).to.be.false; });
        pm.test("1 is ok", function() { pm.expect(1).to.be.ok; });
        pm.test("0 is not ok", function() { pm.expect(0).to.be.ok; });
    )",
    request, response, env);

    const std::vector<bool> expected = { true, true, false, false, false, false,
        false, false, false, true, false };
    ASSERT_EQ (result.tests.size (), expected.size ());
    for (size_t i = 0; i < expected.size (); ++i) {
        EXPECT_EQ (result.tests[i].passed, expected[i]) << result.tests[i].name;
    }
}

TEST_F (ScriptEngineTest, ExpectNotTrueAndNotFalseInvertTheStrictCheck) {
    auto result = engine.execute_test (R"(
        pm.test("1 is not true", function() { pm.expect(1).to.not.be.true; });
        pm.test("true is refused by not.true", function() { pm.expect(true).to.not.be.true; });
        pm.test("0 is not false", function() { pm.expect(0).to.not.be.false; });
        pm.test("null is not false", function() { pm.expect(null).to.not.be.false; });
        pm.test("false is refused by not.false", function() { pm.expect(false).to.not.be.false; });
    )",
    request, response, env);

    const std::vector<bool> expected = { true, false, true, true, false };
    ASSERT_EQ (result.tests.size (), expected.size ());
    for (size_t i = 0; i < expected.size (); ++i) {
        EXPECT_EQ (result.tests[i].passed, expected[i]) << result.tests[i].name;
    }
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
// equal vs eql, the deep/nested chainers, and the matchers that used to throw
//
// `equal` and `eql` were bound to the same JSON-string comparison, so Vayu
// passed `expect({a:1}).to.equal({a:1})` (Postman fails it - different
// references) and failed `expect({a:1,b:2}).to.eql({b:2,a:1})` (Postman passes
// it - key order is not part of deep equality). The false pass is the one that
// matters: a ported test asserting reference identity silently became a value
// comparison.
// ============================================================================

// The pair this issue exists for. Re-alias `equal` to the deep comparison and
// the first case flips to PASS; make `eql` strict and the second flips to FAIL.
TEST_F (ScriptEngineTest, ExpectEqualIsStrictAndEqlIsDeep) {
    auto result = engine.execute_test (R"(
        pm.test("equal on two objects", function() { pm.expect({a:1}).to.equal({a:1}); });
        pm.test("eql on two objects", function() { pm.expect({a:1}).to.eql({a:1}); });
        pm.test("equal on one reference", function() { var o = {a:1}; pm.expect(o).to.equal(o); });
        pm.test("deep.equal is eql", function() { pm.expect({a:1}).to.deep.equal({a:1}); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 4);
    EXPECT_FALSE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
    EXPECT_TRUE (result.tests[2].passed) << result.tests[2].error_message;
    EXPECT_TRUE (result.tests[3].passed) << result.tests[3].error_message;
}

TEST_F (ScriptEngineTest, ExpectEqualKeepsPrimitiveSemantics) {
    auto result = engine.execute_test (R"(
        pm.test("numbers", function() { pm.expect(42).to.equal(42); });
        pm.test("strings", function() { pm.expect("a").to.equal("a"); });
        pm.test("booleans", function() { pm.expect(true).to.equal(true); });
        pm.test("null", function() { pm.expect(null).to.equal(null); });
        pm.test("no coercion", function() { pm.expect("1").to.not.equal(1); });
        pm.test("NaN is not itself", function() { pm.expect(NaN).to.not.equal(NaN); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

// Key order, nesting, `NaN`, `null` vs `undefined` and the members JSON drops:
// every one of these is a case `JSON.stringify` comparison got wrong.
TEST_F (ScriptEngineTest, ExpectEqlIsAStructuralCompare) {
    auto result = engine.execute_test (R"(
        pm.test("key order", function() { pm.expect({a:1,b:2}).to.eql({b:2,a:1}); });
        pm.test("nested", function() { pm.expect({a:{b:[1,{c:2}]}}).to.eql({a:{b:[1,{c:2}]}}); });
        pm.test("nested differs", function() { pm.expect({a:{b:[1]}}).to.not.eql({a:{b:[2]}}); });
        pm.test("array order matters", function() { pm.expect([1,2]).to.not.eql([2,1]); });
        pm.test("array length matters", function() { pm.expect([1]).to.not.eql([1,2]); });
        pm.test("NaN", function() { pm.expect(NaN).to.eql(NaN); });
        pm.test("null is not undefined", function() { pm.expect(null).to.not.eql(undefined); });
        pm.test("undefined member counts", function() { pm.expect({a:undefined}).to.not.eql({}); });
        pm.test("mixed types", function() { pm.expect({a:1}).to.not.eql({a:"1"}); });
        pm.test("array is not an object", function() { pm.expect({0:1,length:1}).to.not.eql([1]); });
        pm.test("dates by instant", function() { pm.expect(new Date(5)).to.eql(new Date(5)); });
        pm.test("dates differ", function() { pm.expect(new Date(5)).to.not.eql(new Date(6)); });
        pm.test("regexps by pattern", function() { pm.expect(/x/g).to.eql(/x/g); });
        pm.test("regexps differ", function() { pm.expect(/x/g).to.not.eql(/y/g); });
        pm.test("eqls alias", function() { pm.expect({a:1}).to.eqls({a:1}); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// A Map keeps its contents outside the own-property list, so a structural
// compare sees two empty objects. Reporting them equal would be a false pass.
TEST_F (ScriptEngineTest, ExpectEqlRefusesContainersItCannotSee) {
    auto result = engine.execute_test (R"(
        pm.test("distinct maps", function() {
            var a = new Map(); a.set("k", 1);
            var b = new Map(); b.set("k", 1);
            pm.expect(a).to.not.eql(b);
        });
        pm.test("same map", function() { var a = new Map(); pm.expect(a).to.eql(a); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

// A cycle has to end in a thrown error, not a hang or a stack overflow.
TEST_F (ScriptEngineTest, ExpectEqlOnCyclicValuesFailsLoudly) {
    auto result = engine.execute_test (R"(
        pm.test("cyclic", function() {
            var a = {}; a.self = a;
            var b = {}; b.self = b;
            pm.expect(a).to.eql(b);
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("cyclic"), std::string::npos)
    << result.tests[0].error_message;
}

// #959: the cyclic case must be reported because it *is* cyclic, not because
// the walk happened to run out of levels. Nesting the cycle one level down
// proves the detection is structural - a depth cap alone would report the same
// thing here, but only after 64 fruitless levels, and which error won then
// depended on how much C stack a frame of js_deep_equal happened to take on
// the toolchain in use. That is how this passed everywhere except MSVC at /Od
// under ASan, where QuickJS's own stack guard tripped first and the thrown
// error was silently downgraded to "not equal".
TEST_F (ScriptEngineTest, ExpectEqlReportsACycleWhereItCloses) {
    auto result = engine.execute_test (R"(
        pm.test("nested cycle", function() {
            var a = { inner: {} }; a.inner.back = a;
            var b = { inner: {} }; b.inner.back = b;
            pm.expect(a).to.eql(b);
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("cyclic"), std::string::npos)
    << result.tests[0].error_message;
}

// The #959 failure mode itself, and the invariant that retires it.
//
// The Windows leg failed because QuickJS's own stack guard tripped before the
// depth cap did, inside the JS_Call that reads an object's class tag. The
// thrown error was then discarded and the caller reported an ordinary "not
// deeply equal" - a result for a comparison that never happened. Frame size
// decided which guard won, so the bug was invisible on GCC and Clang and
// deterministic on MSVC at /Od under ASan.
//
// The property is therefore not "it says cyclic at 16 KB", and not "it says
// cyclic at every budget" either: at a budget tight enough that even the first
// class-tag read cannot run, the honest answer *is* the interpreter's
// "Maximum call stack size exceeded". Demanding the cycle there asks the engine
// to report something it could not compute, which is the very thing being
// fixed.
//
// What must hold at every usable budget is that the failure is **attributable**
// - the cycle, or the interpreter error that stopped the walk - and never the
// matcher's bare "to deeply equal", which is what a silently dropped exception
// looks like. Plus, where there is enough headroom to walk at all, the cycle
// must be what is reported rather than the depth cap or a stack overflow.
//
// Mutation check: with the cycle detection removed and only the depth cap left,
// the tight budgets report `AssertionError: Expected [object Object] to deeply
// equal [object Object]` - the exact string windows-asan produced - and the
// generic-message assertion below fails.
TEST_F (ScriptEngineTest, ExpectEqlOnACycleNeverSilentlyReportsAResult) {
    constexpr std::size_t kKiB             = 1024;
    const std::vector<std::size_t> budgets = { 16 * kKiB, 32 * kKiB, 64 * kKiB,
        128 * kKiB, 256 * kKiB };

    int ran         = 0;
    int named_cycle = 0;
    for (const std::size_t budget : budgets) {
        ScriptConfig config;
        config.stack_size = budget;
        ScriptEngine engine_at_budget{ config };

        auto result = engine_at_budget.execute_test (R"(
            pm.test("cyclic", function() {
                var a = {}; a.self = a;
                var b = {}; b.self = b;
                pm.expect(a).to.eql(b);
            });
        )",
        request, response, env);

        if (result.tests.empty ()) {
            // Too small to run the script at all - it never reached the
            // comparison, so it says nothing either way.
            continue;
        }
        ran++;

        ASSERT_EQ (result.tests.size (), 1u) << "budget " << budget;
        EXPECT_FALSE (result.tests[0].passed) << "budget " << budget;

        const std::string& message = result.tests[0].error_message;
        EXPECT_FALSE (message.empty ()) << "budget " << budget;
        EXPECT_EQ (message.find ("to deeply equal"), std::string::npos)
        << "budget " << budget
        << ": the comparison reported a result it did not compute - " << message;

        if (message.find ("cyclic") != std::string::npos) {
            named_cycle++;
        }
    }

    ASSERT_GT (ran, 0) << "no budget in the sweep ran the script - this test "
                          "proved nothing";
    EXPECT_GT (named_cycle, 0)
    << "no budget reported the cycle - detection never engaged";
}

// A structure that repeats a *value* without being cyclic is not a cycle, and
// must still compare normally. The path carries pairs on the current branch
// only, so a sibling that reuses the same object is not mistaken for one.
TEST_F (ScriptEngineTest, ExpectEqlDoesNotMistakeSharingForACycle) {
    auto result = engine.execute_test (R"(
        pm.test("shared leaf, equal", function() {
            var leaf = { v: 1 };
            pm.expect({ x: leaf, y: leaf }).to.eql({ x: { v: 1 }, y: { v: 1 } });
        });
        pm.test("shared leaf, unequal", function() {
            var leaf = { v: 1 };
            pm.expect({ x: leaf, y: leaf }).to.not.eql({ x: { v: 1 }, y: { v: 2 } });
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
}

// Every matcher hands the expectation back, which is what `.and` continues.
TEST_F (ScriptEngineTest, ExpectAndChainsAndKeepsAssertingAfterTheJoin) {
    auto result = engine.execute_test (R"(
        pm.test("both hold", function() { pm.expect(5).to.be.above(1).and.to.be.below(9); });
        pm.test("after a getter", function() { pm.expect(true).to.be.true.and.to.equal(true); });
        pm.test("second half fails", function() { pm.expect(5).to.be.above(1).and.to.be.below(3); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 3);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
    EXPECT_FALSE (result.tests[2].passed)
    << "the assertion after .and did not run";
}

/**
 * `.not` sets the negation, it does not flip it (issue #883).
 *
 * chai's `not` is `flag(this, 'negate', true)` - a set - and the flag stays set
 * for the rest of the chain, so a second `.not` in one chain is a no-op there.
 * This one toggled, which made every even-numbered `.not` cancel the one before
 * it: `expect(s).to.not.include("+").and.to.not.include("/")` quietly asserted
 * that `s` DOES include "/" and went red on a string that was correct. Silent
 * inversion, in the direction that turns a passing suite red and a failing
 * assertion green depending only on how many times the author wrote `.not`.
 *
 * `.and` is not the mechanism and the third case proves it - a `.not` following
 * a *positive* assertion always worked, because the flag was still false. What
 * matters is how many `.not`s the chain has seen.
 *
 * Mutation-check: restore the toggle (`state->negated = !state->negated`) and
 * the first two cases fail while the rest stay green.
 */
TEST_F (ScriptEngineTest, ExpectNotSetsTheNegationRatherThanTogglingIt) {
    auto result = engine.execute_test (R"(
        pm.test("two nots, joined", function() {
            pm.expect("abc").to.not.include("z").and.to.not.include("y");
        });
        pm.test("two nots, unjoined", function() {
            pm.expect("abc").to.not.equal("q").to.not.equal("r");
        });
        pm.test("a not after a positive", function() {
            pm.expect("abc").to.include("a").and.to.not.include("z");
        });
        pm.test("three nots", function() {
            pm.expect("abc").to.not.include("x").and.to.not.include("y").and.to.not.include("z");
        });
        pm.test("still fails when the second half is wrong", function() {
            pm.expect("abc").to.not.include("z").and.to.not.include("b");
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 5);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
    EXPECT_TRUE (result.tests[2].passed) << result.tests[2].error_message;
    EXPECT_TRUE (result.tests[3].passed) << result.tests[3].error_message;
    // The negation must stay a negation, not become permissive: "abc" does
    // include "b", so the last chain is genuinely wrong and must say so.
    EXPECT_FALSE (result.tests[4].passed)
    << "a negated assertion after another one stopped asserting";
}

TEST_F (ScriptEngineTest, ExpectOneOf) {
    auto result = engine.execute_test (R"(
        pm.test("hit", function() { pm.expect(200).to.be.oneOf([200, 201]); });
        pm.test("miss", function() { pm.expect(404).to.be.oneOf([200, 201]); });
        pm.test("strict by default", function() { pm.expect({a:1}).to.not.be.oneOf([{a:1}]); });
        pm.test("deep on request", function() { pm.expect({a:1}).to.be.deep.oneOf([{a:1}]); });
        pm.test("needs an array", function() { pm.expect(1).to.be.oneOf(1); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 5);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed);
    EXPECT_TRUE (result.tests[2].passed) << result.tests[2].error_message;
    EXPECT_TRUE (result.tests[3].passed) << result.tests[3].error_message;
    EXPECT_FALSE (result.tests[4].passed);
    EXPECT_NE (result.tests[4].error_message.find ("array"), std::string::npos)
    << result.tests[4].error_message;
}

TEST_F (ScriptEngineTest, ExpectKeys) {
    auto result = engine.execute_test (R"(
        pm.test("exact varargs", function() { pm.expect({a:1,b:2}).to.have.keys("a", "b"); });
        pm.test("exact array", function() { pm.expect({a:1,b:2}).to.have.keys(["b", "a"]); });
        pm.test("all chainer", function() { pm.expect({a:1}).to.have.all.keys("a"); });
        pm.test("key alias", function() { pm.expect({a:1}).to.have.key("a"); });
        pm.test("negated", function() { pm.expect({a:1}).to.not.have.keys("b"); });
        pm.test("a subset is not all", function() { pm.expect({a:1,b:2}).to.have.keys("a"); });
        pm.test("needs an object", function() { pm.expect(1).to.have.keys("a"); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 7);
    for (size_t i = 0; i < 5; i++) {
        EXPECT_TRUE (result.tests[i].passed)
        << result.tests[i].name << ": " << result.tests[i].error_message;
    }
    EXPECT_FALSE (result.tests[5].passed);
    EXPECT_FALSE (result.tests[6].passed);
}

TEST_F (ScriptEngineTest, ExpectMembers) {
    auto result = engine.execute_test (R"(
        pm.test("any order", function() { pm.expect([1,2,3]).to.have.members([3,2,1]); });
        pm.test("deep members", function() { pm.expect([{a:1}]).to.have.deep.members([{a:1}]); });
        pm.test("strict by default", function() { pm.expect([{a:1}]).to.not.have.members([{a:1}]); });
        pm.test("duplicates count", function() { pm.expect([1,1,2]).to.have.members([1,2,2]); });
        pm.test("length matters", function() { pm.expect([1,2]).to.have.members([1,2,3]); });
        pm.test("needs an array target", function() { pm.expect(1).to.have.members([1]); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 6);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
    EXPECT_TRUE (result.tests[2].passed) << result.tests[2].error_message;
    EXPECT_FALSE (result.tests[3].passed);
    EXPECT_FALSE (result.tests[4].passed);
    EXPECT_FALSE (result.tests[5].passed);
}

TEST_F (ScriptEngineTest, ExpectThrow) {
    auto result = engine.execute_test (R"(
        pm.test("any error", function() {
            pm.expect(function() { throw new Error("boom"); }).to.throw();
        });
        pm.test("message substring", function() {
            pm.expect(function() { throw new Error("boom"); }).to.throw("boom");
        });
        pm.test("message pattern", function() {
            pm.expect(function() { throw new Error("boom 42"); }).to.throw(/[0-9]+/);
        });
        pm.test("does not throw", function() { pm.expect(function() { return 1; }).to.not.throw(); });
        pm.test("throws alias", function() {
            pm.expect(function() { throw new Error("x"); }).to.throws();
        });
        pm.test("wrong substring", function() {
            pm.expect(function() { throw new Error("boom"); }).to.throw("bang");
        });
        pm.test("expected a throw", function() { pm.expect(function() { return 1; }).to.throw(); });
        pm.test("needs a function", function() { pm.expect(1).to.throw(); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 8);
    for (size_t i = 0; i < 5; i++) {
        EXPECT_TRUE (result.tests[i].passed)
        << result.tests[i].name << ": " << result.tests[i].error_message;
    }
    EXPECT_FALSE (result.tests[5].passed);
    EXPECT_FALSE (result.tests[6].passed);
    EXPECT_FALSE (result.tests[7].passed);
    EXPECT_NE (result.tests[7].error_message.find ("function"), std::string::npos)
    << result.tests[7].error_message;
}

TEST_F (ScriptEngineTest, ExpectInstanceOfCloseToSatisfyAndString) {
    auto result = engine.execute_test (R"(
        pm.test("instanceOf hit", function() { pm.expect([]).to.be.instanceOf(Array); });
        pm.test("instanceOf miss", function() { pm.expect({}).to.not.be.instanceOf(Array); });
        pm.test("closeTo inside", function() { pm.expect(1.05).to.be.closeTo(1.0, 0.1); });
        pm.test("closeTo outside", function() { pm.expect(1.5).to.not.be.closeTo(1.0, 0.1); });
        pm.test("satisfy", function() { pm.expect(4).to.satisfy(function(n) { return n % 2 === 0; }); });
        pm.test("string", function() { pm.expect("hello world").to.have.string("world"); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// The failing half: each of these has to fail, since a matcher that cannot fail
// is the stubbed-assertion defect this series started from.
TEST_F (ScriptEngineTest, ExpectNewMatchersCanFail) {
    auto result = engine.execute_test (R"(
        pm.test("instanceOf", function() { pm.expect({}).to.be.instanceOf(Array); });
        pm.test("instanceOf needs a constructor", function() { pm.expect([]).to.be.instanceOf(1); });
        pm.test("closeTo", function() { pm.expect(1.5).to.be.closeTo(1.0, 0.1); });
        pm.test("closeTo needs a delta", function() { pm.expect(1).to.be.closeTo(1); });
        pm.test("satisfy", function() { pm.expect(5).to.satisfy(function(n) { return n % 2 === 0; }); });
        pm.test("satisfy needs a predicate", function() { pm.expect(5).to.satisfy(5); });
        pm.test("string", function() { pm.expect("hello").to.have.string("world"); });
        pm.test("string needs a string", function() { pm.expect(5).to.have.string("5"); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 8);
    for (const auto& test : result.tests) {
        EXPECT_FALSE (test.passed) << test.name << " passed but should not";
        EXPECT_FALSE (test.error_message.empty ()) << test.name;
    }
}

// ============================================================================
// Issue #999: the pm.expect chain passed silently where chai fails
// ============================================================================

// The load-bearing one. A member nothing implements used to evaluate to
// `undefined` as an expression statement, so the test reported PASS whatever
// the value was. Un-arm the hook and every case here goes green - which is what
// makes it a mutation check rather than a restatement of the code.
TEST_F (ScriptEngineTest, ExpectChainRejectsUnknownMembers) {
    const auto scripts = std::to_array<const char*> ({
    R"(pm.test("t", function() { pm.expect(1).to.be.trueish; });)",
    // chai-postman has these and Vayu does not: they must fail loudly rather
    // than pass.
    R"(pm.test("t", function() { pm.expect(pm.response).to.be.postmanResponse; });)",
    R"(pm.test("t", function() { pm.expect(pm.request).to.be.postmanRequest; });)",
    R"(pm.test("t", function() { pm.expect(1).to.be.postmanRequestOrResponse; });)",
    // A typo in the middle of a chain names itself too.
    R"(pm.test("t", function() { pm.expect({a:1}).to.hve.property("a"); });)",
    // The negated form is a property read like any other, so it throws rather
    // than negating its way to a pass.
    R"(pm.test("t", function() { pm.expect({}).to.not.be.postmanResponse; });)",
    // A chainable method's function finds members through the expectation,
    // so an unknown one after it reaches the same hook.
    R"(pm.test("t", function() { pm.expect([1]).to.include.membrs([1]); });)",
    R"(pm.test("t", function() { pm.expect([1]).to.have.length.abov(0); });)",
    });

    for (const char* script : scripts) {
        auto result = engine.execute_test (script, request, response, env);
        ASSERT_EQ (result.tests.size (), 1u) << script;
        EXPECT_FALSE (result.tests[0].passed) << script;
        EXPECT_NE (
        result.tests[0].error_message.find ("not a supported assertion"), std::string::npos)
        << script << " -> " << result.tests[0].error_message;
    }
}

// The hook rejects assertion names only: an expectation still has to behave
// like an object for the plumbing that touches it. Without the prototype the
// armed class needs, every line here throws.
TEST_F (ScriptEngineTest, ExpectChainStillBehavesLikeAnObject) {
    auto result = engine.execute_test (R"(
        pm.test("printable", function() {
            var e = pm.expect(1);
            pm.expect(String(e)).to.include("object");
            pm.expect(typeof e.equal).to.equal("function");
            pm.expect(e.hasOwnProperty("equal")).to.equal(true);
            // console.log serialises whatever it is given, and JSON.stringify
            // probes `toJSON`: a chain that rejected either would turn an
            // ordinary debugging line into a throw.
            pm.expect(typeof JSON.stringify(e)).to.equal("string");
            console.log(e);
            pm.expect(Object.keys(e)).to.include("equal");
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// ============================================================================
// Issue #1053: chai's language chains read as English and assert nothing
// ============================================================================

// One chain per word, each asserting something true, so removing that word from
// `passthrough_chainers` reddens its own case with "not a supported assertion" -
// the mutation check. Where a case needs a second word to read at all, the
// second is one Vayu already had (`and`, `have`, `not`), so exactly one new word
// is under test in each line.
TEST_F (ScriptEngineTest, LanguageChainsAreNoOps) {
    const auto scripts = std::to_array<const char*> ({
    R"(pm.test("t", function() { pm.expect(3).to.be.above(1).and.also.be.below(5); });)",
    R"(pm.test("t", function() { pm.expect("a").to.have.been.a("string"); });)",
    R"(pm.test("t", function() { pm.expect([1]).to.be.an("array").but.not.empty; });)",
    R"(pm.test("t", function() { pm.expect("vayu").to.be.a("string").and.does.include("va"); });)",
    R"(pm.test("t", function() { pm.expect({id:1}).to.be.an("object").and.has.property("id"); });)",
    R"(pm.test("t", function() { pm.expect([1]).to.be.an("array").and.is.not.empty; });)",
    R"(pm.test("t", function() { pm.expect([1,2,3]).to.be.an("array").of.length(3); });)",
    R"(pm.test("t", function() { pm.expect([3,1,2]).to.have.same.members([1,2,3]); });)",
    R"(pm.test("t", function() { pm.expect(3).to.be.above(1).and.still.be.below(5); });)",
    R"(pm.test("t", function() { pm.expect([1,2]).to.be.an("array").that.include(2); });)",
    R"(pm.test("t", function() { pm.expect([1,2]).to.be.an("array").which.include(2); });)",
    R"(pm.test("t", function() { pm.expect({id:1}).to.be.an("object").with.property("id"); });)",
    });

    for (const char* script : scripts) {
        auto result = engine.execute_test (script, request, response, env);
        ASSERT_EQ (result.tests.size (), 1u) << script;
        EXPECT_TRUE (result.tests[0].passed)
        << script << " -> " << result.tests[0].error_message;
    }
}

// A passthrough hands the same expectation back, so the flags the chain has set
// survive it. `not` is the one that matters: it is a set rather than a toggle
// (issue #883), so it still applies after a language word - a passthrough that
// built a fresh expectation would assert the opposite of what was written and
// report PASS for it.
TEST_F (ScriptEngineTest, LanguageChainsCarryTheChainsFlags) {
    auto result = engine.execute_test (R"(
        pm.test("not survives", function() {
            pm.expect("abc").to.not.include("z").and.which.is.include("y");
        });
        pm.test("deep survives", function() {
            pm.expect([{a:1}]).to.have.deep.which.members([{a:1}]);
        });
        pm.test("nested survives", function() {
            pm.expect({a:{b:1}}).to.have.nested.that.property("a.b", 1);
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 3u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << " -> " << test.error_message;
    }
}

// `.itself` reads as prose and is not: `respondTo` reads it, so a function
// target is asked about its own members instead of its prototype's. Accepted
// as a no-op it would answer the question the script did not write.
TEST_F (ScriptEngineTest, ItselfIsAFlagRespondToReads) {
    auto result = engine.execute_test (R"(
        var C = function () {};
        C.prototype.method = function () {};
        C.helper = function () {};
        pm.test("without itself, the prototype is asked", function() {
            pm.expect(C).to.respondTo("method");
            pm.expect(C).to.not.respondTo("helper");
        });
        pm.test("with itself, the function is", function() {
            pm.expect(C).itself.to.respondTo("helper");
            pm.expect(C).itself.to.not.respondTo("method");
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << " -> " << test.error_message;
    }
}

// `.NaN` is chai's `value !== value`, so only the number NaN satisfies it. The
// coercing reading would pass every string that is not a number.
TEST_F (ScriptEngineTest, ExpectNaN) {
    auto result = engine.execute_test (R"(
        pm.test("NaN is NaN", function() { pm.expect(NaN).to.be.NaN; });
        pm.test("a number is not", function() { pm.expect(1).to.not.be.NaN; });
        pm.test("a string is not", function() { pm.expect("foo").to.not.be.NaN; });
        pm.test("0/0", function() { pm.expect(0/0).to.be.NaN; });
        pm.test("a number fails", function() { pm.expect(1).to.be.NaN; });
        pm.test("no coercion", function() { pm.expect("foo").to.be.NaN; });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 6u);
    for (size_t i = 0; i < 4; i++) {
        EXPECT_TRUE (result.tests[i].passed)
        << result.tests[i].name << ": " << result.tests[i].error_message;
    }
    EXPECT_FALSE (result.tests[4].passed);
    EXPECT_FALSE (result.tests[5].passed);
}

// An object target left `includes` false, so the positive form always failed
// and the negated form always passed - a verdict about nothing.
TEST_F (ScriptEngineTest, ExpectIncludeMatchesObjectSubset) {
    auto result = engine.execute_test (R"(
        pm.test("subset", function() { pm.expect({a:1,b:2}).to.include({a:1}); });
        pm.test("whole", function() { pm.expect({a:1}).to.include({a:1}); });
        pm.test("wrong value", function() { pm.expect({a:1}).to.not.include({a:2}); });
        pm.test("missing key", function() { pm.expect({a:1}).to.not.include({b:1}); });
        pm.test("strict per key", function() { pm.expect({a:{b:1}}).to.not.include({a:{b:1}}); });
        pm.test("deep per key", function() { pm.expect({a:{b:1}}).to.deep.include({a:{b:1}}); });
        pm.test("the negated form can fail", function() { pm.expect({a:1}).to.not.include({a:1}); });
        pm.test("the positive form can fail", function() { pm.expect({a:1}).to.include({a:2}); });
        pm.test("strings still work", function() { pm.expect("hello").to.include("ell"); });
        pm.test("arrays still work", function() { pm.expect([1,2]).to.include(2); });
        pm.test("a number takes an object", function() { pm.expect(5).to.include("x"); });
        pm.test("an object takes an object", function() { pm.expect({a:1}).to.include("a"); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 12u);
    for (size_t i = 0; i < 6; i++) {
        EXPECT_TRUE (result.tests[i].passed)
        << result.tests[i].name << ": " << result.tests[i].error_message;
    }
    EXPECT_FALSE (result.tests[6].passed);
    EXPECT_FALSE (result.tests[7].passed);
    EXPECT_TRUE (result.tests[8].passed) << result.tests[8].error_message;
    EXPECT_TRUE (result.tests[9].passed) << result.tests[9].error_message;
    // Both directions of the combination chai refuses, as an assertion: a
    // target that takes an object argument and did not get one, whichever side
    // is the odd one (#2582).
    for (size_t i = 10; i < 12; i++) {
        EXPECT_FALSE (result.tests[i].passed) << result.tests[i].name << " passed but should not";
        EXPECT_NE (result.tests[i].error_message.find (
                   "AssertionError: the given combination of arguments"),
        std::string::npos)
        << result.tests[i].error_message;
    }
}

// An expectation with no keys compares nothing. chai walks its keys, finds
// none, and passes in *both* directions - so a computed subset that came out
// empty is a green test that asserted nothing, and `.not.include` of one is a
// green test too. A Date, a RegExp and a function each carry no own enumerable
// key and read as an assertion, which is the same trap wearing a type.
TEST_F (ScriptEngineTest, ExpectIncludeRefusesAnExpectationWithNoKeys) {
    auto result = engine.execute_test (R"(
        pm.test("empty object", function() { pm.expect({a:1}).to.include({}); });
        pm.test("empty object negated", function() { pm.expect({a:1}).to.not.include({}); });
        pm.test("a primitive target", function() { pm.expect(5).to.include({}); });
        pm.test("a date", function() { pm.expect({a:1}).to.include(new Date()); });
        pm.test("a regexp", function() { pm.expect({a:1}).to.include(/x/); });
        pm.test("a function", function() { pm.expect({a:1}).to.include(function(){}); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 6u);
    for (const auto& test : result.tests) {
        EXPECT_FALSE (test.passed) << test.name << " passed but should not";
        EXPECT_NE (test.error_message.find ("no properties to match"), std::string::npos)
        << test.name << ": " << test.error_message;
    }
}

// A getter that throws is a read that did not happen, not a mismatch. Answering
// "these differ" would make the negated form a pass, which is how a broken
// object under test reports green.
TEST_F (ScriptEngineTest, ExpectIncludePropagatesAThrowingGetter) {
    auto result = engine.execute_test (R"(
        pm.test("on the target", function() {
            var target = { get a() { throw new Error("nope"); } };
            pm.expect(target).to.not.include({a: 1});
        });
        pm.test("on the expectation", function() {
            var wanted = {};
            Object.defineProperty(wanted, "a", {
                enumerable: true, get: function() { throw new Error("nope"); }
            });
            pm.expect({a: 1}).to.not.include(wanted);
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2u);
    for (const auto& test : result.tests) {
        EXPECT_FALSE (test.passed) << test.name << " passed but should not";
        EXPECT_NE (test.error_message.find ("nope"), std::string::npos)
        << test.name << ": " << test.error_message;
    }
}

// `ToNumber` on both sides made `expect("5").to.be.above(3)` a pass. chai
// type-asserts, so it is an error there - and the coerced reading is how a
// string body silently compares as a number.
TEST_F (ScriptEngineTest, ExpectOrderingMatchersTypeAssert) {
    auto result = engine.execute_test (R"(
        pm.test("above", function() { pm.expect(5).to.be.above(3); });
        pm.test("below", function() { pm.expect(3).to.be.below(5); });
        pm.test("at least", function() { pm.expect(5).to.be.at.least(5); });
        pm.test("at most", function() { pm.expect(5).to.be.at.most(5); });
        pm.test("negated", function() { pm.expect(3).to.not.be.above(5); });
        pm.test("dates", function() { pm.expect(new Date(5)).to.be.above(new Date(4)); });
        pm.test("a string target", function() { pm.expect("5").to.be.above(3); });
        pm.test("a string argument", function() { pm.expect(5).to.be.above("3"); });
        pm.test("a boolean target", function() { pm.expect(true).to.be.at.least(0); });
        pm.test("a null argument", function() { pm.expect(5).to.be.at.most(null); });
        pm.test("a number against a Date", function() { pm.expect(5).to.be.above(new Date(1)); });
        pm.test("a Date against a number", function() { pm.expect(new Date(5)).to.be.above(1); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 12u);
    for (size_t i = 0; i < 6; i++) {
        EXPECT_TRUE (result.tests[i].passed)
        << result.tests[i].name << ": " << result.tests[i].error_message;
    }
    for (size_t i = 6; i < 10; i++) {
        EXPECT_FALSE (result.tests[i].passed) << result.tests[i].name << " passed but should not";
        EXPECT_NE (result.tests[i].error_message.find ("number or a Date"), std::string::npos)
        << result.tests[i].error_message;
    }
    // chai orders like with like: a Date read as milliseconds against a number
    // is a comparison neither side wrote.
    for (size_t i = 10; i < 12; i++) {
        EXPECT_FALSE (result.tests[i].passed) << result.tests[i].name << " passed but should not";
        EXPECT_NE (result.tests[i].error_message.find ("a Date with a Date"), std::string::npos)
        << result.tests[i].error_message;
    }
}

// chai spells several matchers two ways, and a script written in either has to
// run (#2528): each alias is the matcher it names, so each is held to both
// verdicts and to its `.not` form. A failure must be the assertion failing, not
// the unknown-member hook ("is not a supported assertion").
TEST_F (ScriptEngineTest, ChaiAliasesGiveTheirTargetsVerdict) {
    struct Alias {
        const char* passes;
        const char* fails;
        const char* negated_passes;
        const char* negated_fails;
    };
    const auto aliases = std::to_array<Alias> ({
    { "pm.expect(1).to.eq(1)", "pm.expect(1).to.eq(2)",
    "pm.expect(1).to.not.eq(2)", "pm.expect(1).to.not.eq(1)" },
    { "pm.expect(1).to.equals(1)", "pm.expect(1).to.equals(2)",
    "pm.expect(1).to.not.equals(2)", "pm.expect(1).to.not.equals(1)" },
    { "pm.expect([1, 2]).to.includes(2)", "pm.expect([1, 2]).to.includes(3)",
    "pm.expect([1, 2]).to.not.includes(3)", "pm.expect([1, 2]).to.not.includes(2)" },
    { "pm.expect('abc').to.contains('b')", "pm.expect('abc').to.contains('z')",
    "pm.expect('abc').to.not.contains('z')", "pm.expect('abc').to.not.contains('b')" },
    { "pm.expect('a1').to.matches(/[0-9]/)", "pm.expect('aa').to.matches(/[0-9]/)",
    "pm.expect('aa').to.not.matches(/[0-9]/)", "pm.expect('a1').to.not.matches(/[0-9]/)" },
    { "pm.expect([]).to.be.instanceof(Array)", "pm.expect({}).to.be.instanceof(Array)",
    "pm.expect({}).to.not.be.instanceof(Array)", "pm.expect([]).to.not.be.instanceof(Array)" },
    { "pm.expect(2).to.satisfies(function (v) { return v > 1; })",
    "pm.expect(0).to.satisfies(function (v) { return v > 1; })",
    "pm.expect(0).to.not.satisfies(function (v) { return v > 1; })",
    "pm.expect(2).to.not.satisfies(function (v) { return v > 1; })" },
    { "pm.expect(1.04).to.be.approximately(1, 0.05)", "pm.expect(1.2).to.be.approximately(1, 0.05)",
    "pm.expect(1.2).to.not.be.approximately(1, 0.05)", "pm.expect(1.04).to.not.be.approximately(1, 0.05)" },
    { "pm.expect(3).to.be.gt(2)", "pm.expect(2).to.be.gt(2)",
    "pm.expect(2).to.not.be.gt(2)", "pm.expect(3).to.not.be.gt(2)" },
    { "pm.expect(3).to.be.greaterThan(2)", "pm.expect(2).to.be.greaterThan(2)",
    "pm.expect(2).to.not.be.greaterThan(2)", "pm.expect(3).to.not.be.greaterThan(2)" },
    { "pm.expect(1).to.be.lt(2)", "pm.expect(2).to.be.lt(2)",
    "pm.expect(2).to.not.be.lt(2)", "pm.expect(1).to.not.be.lt(2)" },
    { "pm.expect(1).to.be.lessThan(2)", "pm.expect(2).to.be.lessThan(2)",
    "pm.expect(2).to.not.be.lessThan(2)", "pm.expect(1).to.not.be.lessThan(2)" },
    { "pm.expect(2).to.be.gte(2)", "pm.expect(1).to.be.gte(2)",
    "pm.expect(1).to.not.be.gte(2)", "pm.expect(2).to.not.be.gte(2)" },
    { "pm.expect(2).to.be.lte(2)", "pm.expect(3).to.be.lte(2)",
    "pm.expect(3).to.not.be.lte(2)", "pm.expect(2).to.not.be.lte(2)" },
    });

    for (const auto& alias : aliases) {
        EXPECT_EQ (verdict_of (alias.passes), "") << alias.passes;
        EXPECT_EQ (verdict_of (alias.negated_passes), "") << alias.negated_passes;
        for (const char* failing : { alias.fails, alias.negated_fails }) {
            const std::string reported = verdict_of (failing);
            EXPECT_NE (reported, "") << failing << " passed but should not";
            EXPECT_EQ (reported.find ("not a supported assertion"), std::string::npos)
            << failing << " -> " << reported;
            EXPECT_EQ (reported.find ("not a function"), std::string::npos)
            << failing << " -> " << reported;
        }
    }
}

// `within` is chai's two-bound ordering matcher and inclusive at both ends. The
// bounds are the cases that matter: an off-by-one here is a status-class check
// (`within(200, 299)`) that rejects 299 or admits 300.
TEST_F (ScriptEngineTest, ExpectWithinIsInclusiveAtBothBounds) {
    for (const char* passing :
    { "pm.expect(200).to.be.within(200, 299)", "pm.expect(299).to.be.within(200, 299)",
    "pm.expect(250).to.be.within(200, 299)", "pm.expect(5).to.be.within(5, 5)",
    "pm.expect(new Date(5)).to.be.within(new Date(1), new Date(9))",
    "pm.expect(300).to.not.be.within(200, 299)", "pm.expect(199).to.not.be.within(200, 299)" }) {
        EXPECT_EQ (verdict_of (passing), "") << passing;
    }

    for (const char* failing : { "pm.expect(199).to.be.within(200, 299)",
         "pm.expect(300).to.be.within(200, 299)", "pm.expect(200).to.not.be.within(200, 299)",
         "pm.expect(299).to.not.be.within(200, 299)",
         "pm.expect(new Date(10)).to.be.within(new Date(1), new Date(9))" }) {
        const std::string reported = verdict_of (failing);
        EXPECT_NE (reported, "") << failing << " passed but should not";
        EXPECT_NE (reported.find ("AssertionError: Expected"), std::string::npos) << reported;
    }

    EXPECT_NE (verdict_of ("pm.expect(300).to.be.within(200, 299)").find ("within 200..299"),
    std::string::npos);
    EXPECT_NE (verdict_of ("pm.expect(250).to.not.be.within(200, 299)").find ("to not be within"),
    std::string::npos);
}

// The same type rules as the other ordering matchers, applied to both bounds,
// and a call with a bound missing is a mistake in the script rather than a
// verdict.
TEST_F (ScriptEngineTest, ExpectWithinTypeAssertsBothBounds) {
    struct Refusal {
        const char* assertion;
        const char* message;
    };
    for (const auto& refusal : std::to_array<Refusal> ({
         { "pm.expect('5').to.be.within(1, 9)", "number or a Date" },
         { "pm.expect(5).to.be.within('1', 9)", "number or a Date" },
         { "pm.expect(5).to.be.within(1, '9')", "number or a Date" },
         { "pm.expect(5).to.be.within(new Date(1), 9)", "a Date with a Date" },
         { "pm.expect(5).to.be.within(1, new Date(9))", "a Date with a Date" },
         { "pm.expect(5).to.be.within(1)", "requires a start and a finish" },
         { "pm.expect(5).to.be.within()", "requires a start and a finish" },
         })) {
        const std::string reported = verdict_of (refusal.assertion);
        EXPECT_NE (reported.find (refusal.message), std::string::npos)
        << refusal.assertion << " -> " << reported;
    }
}

// `length` is a chain as well as a call: reading it makes the ordering matchers
// compare the length, which is how `.to.have.length.above(2)` and
// `.lengthOf.at.least(1)` are written in the wild (#2528).
TEST_F (ScriptEngineTest, LengthChainsCompareTheLength) {
    for (const char* passing :
    { "pm.expect([1, 2, 3]).to.have.length.above(2)", "pm.expect([1, 2, 3]).to.have.length.below(4)",
    "pm.expect([1, 2, 3]).to.have.length.within(3, 3)", "pm.expect([1, 2, 3]).to.have.length.within(1, 3)",
    "pm.expect([1, 2, 3]).to.have.length.within(3, 9)", "pm.expect([1, 2, 3]).to.have.lengthOf.at.least(3)",
    "pm.expect([1, 2, 3]).to.have.lengthOf.at.most(3)", "pm.expect([1, 2, 3]).to.have.length.of.at.least(1)",
    "pm.expect('abcd').to.have.length.gt(3)", "pm.expect('abcd').to.have.length.gte(4)",
    "pm.expect('abcd').to.have.length.lt(5)", "pm.expect('abcd').to.have.length.lte(4)",
    "pm.expect('abcd').to.have.length.greaterThan(3)", "pm.expect('abcd').to.have.length.lessThan(5)",
    "pm.expect([1, 2, 3]).to.not.have.length.above(3)", "pm.expect([1, 2, 3]).to.have.length.not.above(3)",
    "pm.expect([1, 2, 3]).to.have.length.within(1, 9).and.length(3)",
    // The call form on the same member still compares exactly.
    "pm.expect([1, 2, 3]).to.have.length(3)", "pm.expect([1, 2, 3]).to.have.lengthOf(3)",
    "pm.expect([1, 2, 3]).to.not.have.lengthOf(4)" }) {
        EXPECT_EQ (verdict_of (passing), "") << passing;
    }

    for (const char* failing : { "pm.expect([1, 2, 3]).to.have.length.above(3)",
         "pm.expect([1, 2, 3]).to.have.length.below(3)", "pm.expect([1, 2, 3]).to.have.length.within(4, 9)",
         "pm.expect([1, 2, 3]).to.have.length.within(1, 2)",
         "pm.expect([1, 2, 3]).to.have.lengthOf.at.least(4)",
         "pm.expect([1, 2, 3]).to.have.lengthOf.at.most(2)",
         "pm.expect('abcd').to.have.length.gt(4)", "pm.expect('abcd').to.have.length.lte(3)",
         "pm.expect([1, 2, 3]).to.not.have.length.within(1, 9)",
         "pm.expect([1, 2, 3]).to.have.length.not.below(9)",
         "pm.expect([1, 2, 3]).to.have.length(2)" }) {
        const std::string reported = verdict_of (failing);
        EXPECT_NE (reported, "") << failing << " passed but should not";
        EXPECT_NE (reported.find ("AssertionError: Expected"), std::string::npos)
        << failing << " -> " << reported;
    }
}

// The length is measured, not the target: an array of three is not above 2 as a
// value, and the failure says which quantity was compared.
TEST_F (ScriptEngineTest, LengthChainFailuresSayLength) {
    EXPECT_EQ (verdict_of ("pm.expect([1, 2, 3]).to.have.length.above(5)"),
    "AssertionError: Expected length 3 to be above 5");
    EXPECT_EQ (verdict_of ("pm.expect('abc').to.have.lengthOf.at.most(1)"),
    "AssertionError: Expected length 3 to be at most 1");
    EXPECT_EQ (verdict_of ("pm.expect([1, 2, 3]).to.have.length.within(5, 9)"),
    "AssertionError: Expected length 3 to be within 5..9");
    EXPECT_EQ (verdict_of ("pm.expect([1, 2, 3]).to.not.have.length.below(9)"),
    "AssertionError: Expected length 3 to not be below 9");
    EXPECT_EQ (verdict_of ("pm.expect([1, 2, 3]).to.have.length(2)"),
    "AssertionError: Expected length 3 to equal 2");
    // Without `.length` the same matcher compares the target, which an array is
    // not: the chain flag is what changed the answer.
    EXPECT_NE (verdict_of ("pm.expect([1, 2, 3]).to.be.above(2)").find ("expects the target to be a number or a Date"),
    std::string::npos);
}

// chai measures a Map or a Set by `size`, since neither has a `length`.
TEST_F (ScriptEngineTest, LengthMeasuresAMapOrSetBySize) {
    for (const char* passing :
    { "pm.expect(new Map([[1, 1], [2, 2]])).to.have.length(2)",
    "pm.expect(new Set([1, 2, 3])).to.have.lengthOf(3)",
    "pm.expect(new Set([1, 2, 3])).to.have.length.above(2)",
    "pm.expect(new Map([[1, 1]])).to.have.lengthOf.within(1, 1)",
    "pm.expect(new Set([1])).to.not.have.length.above(1)" }) {
        EXPECT_EQ (verdict_of (passing), "") << passing;
    }
    EXPECT_EQ (
    verdict_of ("pm.expect(new Set([1, 2, 3])).to.have.length.above(5)"),
    "AssertionError: Expected size 3 to be above 5");
    EXPECT_EQ (verdict_of ("pm.expect(new Map([[1, 1]])).to.have.length(2)"),
    "AssertionError: Expected size 1 to equal 2");
}

// What is measured has to have a length. A target without one fails as chai's
// `to.have.property('length')` does (#2582): an assertion in both polarities,
// so `.not` cannot turn it into a pass.
TEST_F (ScriptEngineTest, LengthChainsRefuseATargetWithNoLength) {
    for (const char* refused : { "pm.expect(5).to.have.length.above(1)",
         "pm.expect(5).to.not.have.length.above(1)", "pm.expect({}).to.have.length.within(0, 1)",
         "pm.expect(5).to.have.length(1)", "pm.expect(5).to.not.have.length(1)" }) {
        const std::string reported = verdict_of (refused);
        EXPECT_TRUE (reported.starts_with ("AssertionError: Expected "))
        << refused << " -> " << reported;
        EXPECT_NE (reported.find ("to have property 'length'"), std::string::npos)
        << refused << " -> " << reported;
    }
    // Bounds are lengths, so a Date is not one.
    EXPECT_NE (verdict_of ("pm.expect([1]).to.have.length.above(new Date(1))").find ("a Date with a Date"),
    std::string::npos);
    EXPECT_NE (verdict_of ("pm.expect([1]).to.have.length.within(0)").find ("requires a start and a finish"),
    std::string::npos);
}

// Each word the length chain forwards must exist on the expectation it forwards
// to: a word that did not would throw by name the first time it was read.
TEST_F (ScriptEngineTest, EveryWordAfterLengthIsReadable) {
    for (const char* word :
    { "to", "be", "have", "at", "of", "is", "that", "which", "with", "not" }) {
        // `not` inverts what follows it, so it is read against bounds the
        // length of one is outside.
        const std::string bounds = std::string (word) == "not" ? "(5, 9)" : "(0, 9)";
        const std::string assertion =
        std::string ("pm.expect([1]).to.have.length.") + word + ".within" + bounds;
        EXPECT_EQ (verdict_of (assertion), "") << assertion;
    }
}

// `.a()` names a type the way chai's type-detect does, lowered. The names the
// runtime answered before keep their answers; the ones it could not name
// (everything below the first group) were "object" or, for a symbol, "undefined".
TEST_F (ScriptEngineTest, ExpectATypeNamesFollowChai) {
    struct Named {
        const char* value;
        const char* type;
        const char* other_type;
    };
    const auto named = std::to_array<Named> ({
    { "'s'", "string", "number" },
    { "1", "number", "string" },
    { "true", "boolean", "string" },
    { "null", "null", "object" },
    { "undefined", "undefined", "null" },
    { "[]", "array", "object" },
    { "({})", "object", "array" },
    { "function () {}", "function", "object" },
    { "new Date(0)", "date", "object" },
    { "/x/", "regexp", "object" },
    { "new Map()", "map", "object" },
    { "new Set()", "set", "object" },
    { "new Error('e')", "error", "object" },
    { "new TypeError('e')", "error", "object" },
    { "Symbol('s')", "symbol", "undefined" },
    { "10n", "bigint", "number" },
    { "Promise.resolve(1)", "promise", "object" },
    });

    for (const auto& n : named) {
        const std::string positive =
        std::string ("pm.expect(") + n.value + ").to.be.a('" + n.type + "')";
        const std::string wrong =
        std::string ("pm.expect(") + n.value + ").to.be.a('" + n.other_type + "')";
        const std::string negated =
        std::string ("pm.expect(") + n.value + ").to.not.be.a('" + n.type + "')";
        EXPECT_EQ (verdict_of (positive), "") << positive;
        EXPECT_NE (verdict_of (wrong), "") << wrong << " passed but should not";
        EXPECT_NE (verdict_of (negated), "") << negated << " passed but should not";
        EXPECT_EQ (verdict_of (std::string ("pm.expect(") + n.value +
                   ").to.not.be.a('" + n.other_type + "')"),
        "")
        << n.value;
    }

    EXPECT_EQ (verdict_of ("pm.expect(new Date(0)).to.be.an('Date')"), "");
    EXPECT_EQ (verdict_of ("pm.expect(1).to.be.a('date')"),
    "AssertionError: Expected type number to be date");
    EXPECT_EQ (verdict_of ("pm.expect(new Map()).to.be.an('object')"),
    "AssertionError: Expected type map to be object");
}

// A target whose tag cannot be read is a read that did not happen, and `.not`
// must not turn it into a pass.
TEST_F (ScriptEngineTest, ExpectATypeFailsLoudWhenTheTagCannotBeRead) {
    const std::string reported =
    verdict_of ("var hostile = new Proxy({}, { get: function () { throw new "
                "Error('from the tag'); } });\n"
                "pm.expect(hostile).to.not.be.a('date')");
    EXPECT_NE (reported.find ("from the tag"), std::string::npos) << reported;
}

// ============================================================================
// Issue #2528: the flag-dependent chai forms
// ============================================================================

/**
 * One table per form: each line in `passing` must hold, and each in `failing`
 * must fail *as an assertion* - an AssertionError the chain's own matcher
 * reported, not the unknown-member hook or a TypeError about the call.
 */
class ExpectFlagFormTest : public ScriptEngineTest {
    protected:
    void expect_verdicts (std::initializer_list<const char*> passing,
    std::initializer_list<const char*> failing) {
        for (const char* assertion : passing) {
            EXPECT_EQ (verdict_of (assertion), "") << assertion;
        }
        for (const char* assertion : failing) {
            const std::string reported = verdict_of (assertion);
            EXPECT_NE (reported.find ("AssertionError: Expected"), std::string::npos)
            << assertion << " -> " << (reported.empty () ? "<passed>" : reported);
        }
    }
};

// `any` is a real quantifier: a response carrying one of two keys passes
// `.any.keys` and fails `.all.keys`. Mutation check: make `any` set nothing in
// `flag_chainers` and the one-of-two lines fail.
TEST_F (ExpectFlagFormTest, AnyKeysNeedsOneAndAllKeysNeedsEvery) {
    expect_verdicts ({ "pm.expect({a: 1}).to.have.any.keys('a', 'b')",
                     "pm.expect({a: 1, b: 2}).to.have.any.keys(['b', 'z'])",
                     "pm.expect({a: 1}).to.not.have.any.keys('x', 'y')",
                     "pm.expect({a: 1}).to.not.have.all.keys('a', 'b')",
                     "pm.expect({a: 1, b: 2}).to.have.all.keys('a', 'b')",
                     "pm.expect({a: 1, b: 2}).to.include.any.keys('a')",
                     // The later quantifier wins, as each clears the other in chai.
                     "pm.expect({a: 1}).to.have.any.all.keys('a')",
                     "pm.expect({a: 1}).to.have.all.any.keys('a', 'b')" },
    { "pm.expect({a: 1}).to.have.all.keys('a', 'b')", "pm.expect({a: 1}).to.have.keys('a', 'b')",
    "pm.expect({a: 1}).to.have.any.keys('x', 'y')", "pm.expect({a: 1}).to.not.have.any.keys('a', 'z')",
    "pm.expect({a: 1}).to.have.any.all.keys('a', 'b')" });

    EXPECT_EQ (verdict_of ("pm.expect({a: 1}).to.have.any.keys('x', 'y')"),
    "AssertionError: Expected object to have any of the keys 'x', 'y'");
    EXPECT_EQ (verdict_of ("pm.expect({a: 1}).to.not.have.any.keys('a', 'z')"),
    "AssertionError: Expected object to not have any of the keys 'a', 'z'");
}

// After `include` / `contain` the keys are a subset of the target's, where
// `have.keys` is the exact set.
TEST_F (ExpectFlagFormTest, IncludeKeysAcceptsASuperset) {
    expect_verdicts (
    { "pm.expect({a: 1, b: 2, c: 3}).to.include.keys('a', 'b')",
    "pm.expect({a: 1, b: 2}).to.contain.keys(['a'])",
    "pm.expect({a: 1, b: 2}).to.include.key('b')", "pm.expect({a: 1, b: 2}).to.includes.keys('a')",
    "pm.expect({a: 1, b: 2}).to.contains.all.keys('a')", "pm.expect({a: 1}).to.not.include.keys('z')",
    // chai sets the flag on the read, so it holds for the rest of the chain.
    "pm.expect({a: 1, b: 2}).to.include({a: 1}).and.have.keys('b')" },
    { "pm.expect({a: 1}).to.include.keys('a', 'z')", "pm.expect({a: 1, b: 2}).to.not.include.keys('a')",
    "pm.expect({a: 1}).to.contain.keys('z')", "pm.expect({a: 1, b: 2}).to.have.keys('a')" });

    EXPECT_EQ (verdict_of ("pm.expect({a: 1}).to.include.keys('a', 'z')"),
    "AssertionError: Expected object to contain the keys 'a', 'z'");
    EXPECT_EQ (verdict_of ("pm.expect({a: 1, b: 2}).to.not.include.keys('a')"),
    "AssertionError: Expected object to not contain the keys 'a'");
    // An empty list would hold for every target, asserting nothing.
    EXPECT_NE (verdict_of ("pm.expect({a: 1}).to.include.keys([])").find ("requires at least one key name"),
    std::string::npos);
}

TEST_F (ExpectFlagFormTest, IncludeAndOrderedMembers) {
    expect_verdicts (
    { "pm.expect([1, 2, 3]).to.include.members([3, 1])",
    // chai's subset check does not consume what it matched.
    "pm.expect([1, 2, 3]).to.include.members([1, 1])", "pm.expect([1, 2, 3]).to.contain.members([2])",
    "pm.expect([{a: 1}, {b: 2}]).to.include.deep.members([{b: 2}])",
    "pm.expect([1, 2, 3]).to.not.include.members([4])",
    "pm.expect([1, 2, 3]).to.have.ordered.members([1, 2, 3])",
    "pm.expect([1, 2, 3]).to.not.have.ordered.members([3, 2, 1])",
    "pm.expect([1, 2, 3]).to.include.ordered.members([1, 2])",
    "pm.expect([1, 2, 3]).to.not.include.ordered.members([2, 3])",
    "pm.expect([{a: 1}]).to.have.deep.ordered.members([{a: 1}])" },
    { "pm.expect([1, 2, 3]).to.include.members([4])", "pm.expect([1, 2]).to.include.members([1, 2, 3])",
    "pm.expect([{a: 1}]).to.include.members([{a: 1}])", "pm.expect([1, 2, 3]).to.not.include.members([1])",
    "pm.expect([1, 2, 3]).to.have.ordered.members([3, 2, 1])",
    "pm.expect([1, 2, 3]).to.have.ordered.members([1, 2])",
    "pm.expect([1, 2, 3]).to.include.ordered.members([2, 3])",
    "pm.expect([1]).to.include.ordered.members([1, 2])",
    "pm.expect([1, 2, 3]).to.not.include.ordered.members([1, 2])" });

    EXPECT_EQ (verdict_of ("pm.expect([1, 2, 3]).to.include.members([4])"),
    "AssertionError: Expected [1,2,3] to be a superset of [4]");
    EXPECT_EQ (
    verdict_of ("pm.expect([1, 2, 3]).to.have.ordered.members([3, 2, 1])"),
    "AssertionError: Expected [1,2,3] to have ordered members [3,2,1]");
    EXPECT_EQ (
    verdict_of ("pm.expect([1, 2, 3]).to.include.ordered.members([2, 3])"),
    "AssertionError: Expected [1,2,3] to be an ordered superset of [2,3]");
    EXPECT_EQ (verdict_of ("pm.expect([1, 2, 3]).to.not.include.members([1])"),
    "AssertionError: Expected [1,2,3] to not be a superset of [1]");
}

// `own` narrows `.property` and `.include({...})` to own properties; without
// it an inherited property counts, as in chai.
TEST_F (ExpectFlagFormTest, OwnLooksAtOwnPropertiesOnly) {
    const std::string setup =
    "var child = Object.create({inherited: 1}); child.mine = 2;\n"
    "var box = {a: child};\n";
    for (const char* passing :
    { "pm.expect(child).to.have.property('inherited')",
    "pm.expect(child).to.include({inherited: 1})", "pm.expect(child).to.have.own.property('mine')",
    "pm.expect(child).to.not.have.own.property('inherited')",
    "pm.expect(child).to.have.ownProperty('mine', 2)", "pm.expect(child).to.haveOwnProperty('mine')",
    "pm.expect(child).to.not.have.ownProperty('mine', 3)",
    "pm.expect(child).to.have.own.property('mine').that.equals(2)",
    "pm.expect(child).to.have.own.include({mine: 2})",
    "pm.expect(child).to.not.have.own.include({inherited: 1})",
    // The retarget carries the flag, as chai's one assertion object does.
    "pm.expect(box).to.have.own.property('a').not.property('inherited')" }) {
        EXPECT_EQ (verdict_of (setup + passing), "") << passing;
    }
    for (const char* failing :
    { "pm.expect(child).to.have.own.property('inherited')",
    "pm.expect(child).to.have.ownProperty('inherited')",
    "pm.expect(child).to.have.own.include({inherited: 1})",
    "pm.expect(child).to.not.have.own.property('mine')",
    "pm.expect(child).to.have.ownProperty('mine', 3)" }) {
        const std::string reported = verdict_of (setup + failing);
        EXPECT_NE (reported.find ("AssertionError: Expected"), std::string::npos)
        << failing << " -> " << (reported.empty () ? "<passed>" : reported);
    }

    EXPECT_EQ (verdict_of (setup + "pm.expect(child).to.have.own.property('inherited')"),
    "AssertionError: Expected object to have own property 'inherited'");
    EXPECT_EQ (verdict_of (setup + "pm.expect(child).to.have.own.include({inherited: 1})"),
    "AssertionError: Expected {\"mine\":2} to include own properties "
    "{\"inherited\":1}");
    EXPECT_NE (verdict_of ("pm.expect({a: 1}).to.have.nested.own.property('a')").find ("cannot combine the nested and own flags"),
    std::string::npos);
}

// `nested.include` reads each key as a path, which plain `include` does not.
TEST_F (ExpectFlagFormTest, NestedIncludeReadsKeysAsPaths) {
    expect_verdicts (
    { "pm.expect({a: {b: ['x', 'y']}}).to.nested.include({'a.b[1]': 'y'})",
    "pm.expect({a: {b: 1}, c: 2}).to.nested.include({'a.b': 1, c: 2})",
    "pm.expect({a: {b: {c: 1}}}).to.deep.nested.include({'a.b': {c: 1}})",
    "pm.expect({a: {b: 1}}).to.not.nested.include({'a.b': 2})",
    "pm.expect({a: {b: 1}}).to.not.nested.include({'a.z': 1})",
    "pm.expect({'a.b': 1}).to.include({'a.b': 1})" },
    { "pm.expect({a: {b: 1}}).to.nested.include({'a.b': 2})",
    "pm.expect({a: {b: 1}}).to.nested.include({'a.c': 1})",
    "pm.expect({a: {b: {c: 1}}}).to.nested.include({'a.b': {c: 1}})",
    "pm.expect({a: {b: 1}}).to.not.nested.include({'a.b': 1})",
    "pm.expect({a: {b: 1}}).to.include({'a.b': 1})" });

    EXPECT_EQ (
    verdict_of ("pm.expect({a: {b: 1}}).to.nested.include({'a.b': 2})"),
    "AssertionError: Expected {\"a\":{\"b\":1}} to include nested properties "
    "{\"a.b\":2}");
    EXPECT_NE (verdict_of ("pm.expect({a: 1}).to.nested.own.include({a: 1})").find ("cannot combine the nested and own flags"),
    std::string::npos);
}

// A getter that throws under `own` or `nested` is a read that did not happen,
// and `.not` must not turn it into a pass.
TEST_F (ExpectFlagFormTest, AThrowingGetterIsReportedNotNegated) {
    const std::string hostile =
    "var o = {}; Object.defineProperty(o, 'x', { enumerable: true, get: "
    "function () { throw new Error('from the getter'); } });\n";
    for (const char* assertion :
    { "pm.expect(o).to.not.have.own.include({x: 1})", "pm.expect({p: o}).to.not.nested.include({'p.x': 1})",
    "pm.expect({p: o}).to.not.nested.include({'p.x.y': 1})",
    "pm.expect(o).to.not.have.ownProperty('x', 1)" }) {
        EXPECT_NE (verdict_of (hostile + assertion).find ("from the getter"), std::string::npos)
        << assertion;
    }
}

// chai's `typeof value === 'number' && isFinite(value)`: no coercion.
TEST_F (ExpectFlagFormTest, FiniteIsANumberThatIsFinite) {
    expect_verdicts (
    { "pm.expect(1).to.be.finite", "pm.expect(0).to.be.finite",
    "pm.expect(-1.5).to.be.finite", "pm.expect(Number.MAX_VALUE).to.be.finite",
    "pm.expect(NaN).to.not.be.finite", "pm.expect(Infinity).to.not.be.finite",
    "pm.expect(-Infinity).to.not.be.finite", "pm.expect('1').to.not.be.finite",
    "pm.expect(null).to.not.be.finite", "pm.expect(new Number(1)).to.not.be.finite" },
    { "pm.expect(NaN).to.be.finite", "pm.expect(Infinity).to.be.finite",
    "pm.expect('1').to.be.finite", "pm.expect(1).to.not.be.finite" });

    EXPECT_EQ (verdict_of ("pm.expect('1').to.be.finite"),
    "AssertionError: Expected '1' to be a finite number");
    EXPECT_EQ (verdict_of ("pm.expect(1).to.not.be.finite"),
    "AssertionError: Expected 1 to not be a finite number");
}

// After `include` / `contain`, `oneOf` asks whether the target contains a
// candidate rather than whether it is one.
TEST_F (ExpectFlagFormTest, ContainOneOfAsksWhetherTheTargetContainsOne) {
    expect_verdicts (
    { "pm.expect([1, 2]).to.contain.oneOf([2, 5])", "pm.expect([1, 2]).to.include.oneOf([5, 1])",
    "pm.expect('Today is sunny').to.contain.oneOf(['sunny', 'cloudy'])",
    "pm.expect([1, 2]).to.not.contain.oneOf([3, 4])",
    "pm.expect([{a: 1}]).to.deep.contain.oneOf([{a: 1}])", "pm.expect(2).to.be.oneOf([1, 2])" },
    { "pm.expect([1, 2]).to.contain.oneOf([3, 4])", "pm.expect('abc').to.contain.oneOf(['z'])",
    "pm.expect([1, 2]).to.not.contain.oneOf([2])", "pm.expect([{a: 1}]).to.contain.oneOf([{a: 1}])",
    "pm.expect([1, 2]).to.be.oneOf([1, 2])" });

    EXPECT_EQ (verdict_of ("pm.expect([1, 2]).to.contain.oneOf([3, 4])"),
    "AssertionError: Expected [1,2] to contain one of [3,4]");
    EXPECT_NE (verdict_of ("pm.expect(5).to.contain.oneOf([5])").find ("expects the target to be a string or an array, got number"),
    std::string::npos);
}

// `include` and `length` are a call and the rest of the chain at once: the
// member a read answers finds every other member through the expectation,
// so flags set after it reach the matcher that ends the chain.
TEST_F (ExpectFlagFormTest, AChainableMethodIsTheCallAndTheChain) {
    expect_verdicts (
    { "pm.expect(typeof pm.expect([1]).to.include).to.equal('function')",
    "pm.expect([1, 2]).to.include(1).and.include(2)", "pm.expect([1, 2, 3]).to.include.not.members([4])",
    "pm.expect([1, 2, 3]).to.include.deep.ordered.members([1, 2])",
    "pm.expect({a: 1, b: 2}).to.include.any.keys('a', 'z')",
    // `length` directly after a chainable method is refused, as chai refuses
    // it; `lengthOf` is the spelling that reaches the matcher there.
    "pm.expect('abc').to.include.lengthOf(3)",
    "pm.expect([1, 2]).to.have.length.which.is.above(1)" },
    { "pm.expect([1, 2, 3]).to.include.not.members([1])",
    "pm.expect('abc').to.include.lengthOf(4)" });
}

// `String(err)` is "Error: boom", so `.to.throw("Error")` passed for every
// Error thrown, whatever it said. chai matches the message alone, and takes the
// constructor form this used to refuse outright.
TEST_F (ScriptEngineTest, ExpectThrowMatchesMessageAndConstructor) {
    auto result = engine.execute_test (R"(
        pm.test("message only", function() {
            pm.expect(function() { throw new Error("boom"); }).to.not.throw("Error");
        });
        pm.test("the message itself", function() {
            pm.expect(function() { throw new Error("boom"); }).to.throw("boom");
        });
        pm.test("constructor", function() {
            pm.expect(function() { throw new TypeError("bad"); }).to.throw(TypeError);
        });
        pm.test("wrong constructor", function() {
            pm.expect(function() { throw new RangeError("bad"); }).to.not.throw(TypeError);
        });
        pm.test("constructor and message", function() {
            pm.expect(function() { throw new SyntaxError("unexpected end"); })
                .to.throw(SyntaxError, "unexpected");
        });
        pm.test("constructor with a wrong message", function() {
            pm.expect(function() { throw new SyntaxError("unexpected end"); })
                .to.not.throw(SyntaxError, "nothing like it");
        });
        pm.test("a thrown string", function() {
            pm.expect(function() { throw "boom"; }).to.throw("boom");
        });
        pm.test("a pattern reads the message", function() {
            pm.expect(function() { throw new Error("boom 42"); }).to.throw(/^boom [0-9]+$/);
        });
        pm.test("the constructor form can fail", function() {
            pm.expect(function() { throw new RangeError("bad"); }).to.throw(TypeError);
        });
        pm.test("the message form can fail", function() {
            pm.expect(function() { throw new Error("boom"); }).to.throw("bang");
        });
        pm.test("a thrown number has no message", function() {
            pm.expect(function() { throw 42; }).to.not.throw("4");
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 11u);
    for (size_t i = 0; i < 8; i++) {
        EXPECT_TRUE (result.tests[i].passed)
        << result.tests[i].name << ": " << result.tests[i].error_message;
    }
    EXPECT_FALSE (result.tests[8].passed);
    EXPECT_FALSE (result.tests[9].passed);
    EXPECT_TRUE (result.tests[10].passed) << result.tests[10].error_message;

    // A failure has to say what was expected. "Expected the function to throw,
    // but it threw RangeError: bad" reads as an engine fault when what failed
    // was the constructor the script named.
    EXPECT_NE (result.tests[8].error_message.find ("to throw TypeError"), std::string::npos)
    << result.tests[8].error_message;
    EXPECT_NE (
    result.tests[9].error_message.find ("with a message matching 'bang'"), std::string::npos)
    << result.tests[9].error_message;
}

// deep-eql separates the two zeros (`1/x`) and `===` does not, so `.eql` and
// `.equal` give different answers about the same pair - which is the rule chai
// implements and the reason the deep compare takes the rule as an argument.
TEST_F (ScriptEngineTest, ExpectEqlSplitsSignedZeros) {
    auto result = engine.execute_test (R"(
        pm.test("eql splits them", function() { pm.expect(-0).to.not.eql(0); });
        pm.test("eql on the same zero", function() { pm.expect(-0).to.eql(-0); });
        pm.test("nested", function() { pm.expect({a:-0}).to.not.eql({a:0}); });
        pm.test("in an array", function() { pm.expect([-0]).to.not.eql([0]); });
        pm.test("equal is still ===", function() { pm.expect(-0).to.equal(0); });
        pm.test("other numbers are unaffected", function() { pm.expect(1.5).to.eql(1.5); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// The other half of that rule: the response assertions are chai-postman, which
// is lodash `_.isEqual` and compares the two zeros equal. One deep compare
// serves both, so this is what says the caller's rule reached it.
TEST_F (ScriptEngineTest, ResponseAssertionsKeepSameValueZero) {
    response.body = R"({"n": -0})";
    auto result   = engine.execute_test (R"(
        pm.test("jsonBody", function() { pm.response.to.have.jsonBody("n", 0); });
        pm.test("body", function() { pm.response.to.have.body({n: 0}); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

TEST_F (ScriptEngineTest, ExpectNestedProperty) {
    auto result = engine.execute_test (R"(
        pm.test("dotted path", function() { pm.expect({a:{b:{c:1}}}).to.have.nested.property("a.b.c"); });
        pm.test("dotted value", function() { pm.expect({a:{b:{c:1}}}).to.have.nested.property("a.b.c", 1); });
        pm.test("index path", function() { pm.expect({a:[{b:2}]}).to.have.nested.property("a[0].b", 2); });
        pm.test("missing link", function() { pm.expect({a:1}).to.not.have.nested.property("a.b.c"); });
        pm.test("plain property keeps the dot", function() { pm.expect({"a.b":1}).to.have.property("a.b"); });
        pm.test("wrong nested value", function() { pm.expect({a:{b:1}}).to.have.nested.property("a.b", 2); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 6);
    for (size_t i = 0; i < 5; i++) {
        EXPECT_TRUE (result.tests[i].passed)
        << result.tests[i].name << ": " << result.tests[i].error_message;
    }
    EXPECT_FALSE (result.tests[5].passed);
}

// #2524: `.property(name)` moves the chain's subject to the property's value, as
// chai does, so what follows asserts on the value rather than on the object that
// held it. Before the fix every case below that expects a failure passed: the
// matcher after `.property` was run against the object.
TEST_F (ScriptEngineTest, ExpectPropertyRetargetsTheChainToTheValue) {
    auto result = engine.execute_test (R"(
        pm.test("number", function() { pm.expect({id:1}).to.have.property("id").that.is.a("number"); });
        pm.test("wrong type", function() { pm.expect({id:1}).to.have.property("id").that.is.a("string"); });
        pm.test("string data is not an object", function() { pm.expect({data:"x"}).to.have.property("data").that.is.an("object"); });
        pm.test("object data", function() { pm.expect({data:{k:1}}).to.have.property("data").that.is.an("object"); });
        pm.test("equal compares the value", function() { pm.expect({source:"api"}).to.have.property("source").and.equal("api"); });
        pm.test("equal misses the value", function() { pm.expect({source:"api"}).to.have.property("source").and.equal("web"); });
        pm.test("nested", function() { pm.expect({a:{b:2}}).to.have.nested.property("a.b").that.equal(2); });
        pm.test("nested miss", function() { pm.expect({a:{b:2}}).to.have.nested.property("a.b").that.equal(3); });
        pm.test("deep survives the retarget", function() { pm.expect({a:{b:1}}).to.have.deep.property("a").that.equal({b:1}); });
        pm.test("an object value is not empty", function() { pm.expect({a:{b:1}}).to.have.property("a").that.is.not.empty; });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 10u);
    const std::array<bool, 10> expected_pass = { true, false, false, true, true,
        false, true, false, true, true };
    for (size_t i = 0; i < expected_pass.size (); i++) {
        EXPECT_EQ (result.tests[i].passed, expected_pass.at (i))
        << result.tests[i].name << ": " << result.tests[i].error_message;
    }
}

// The cases that must NOT move the subject: `.not` asserts absence and has no
// value, and the value form already compared the value, so both keep handing back
// the chain they were called on.
TEST_F (ScriptEngineTest, ExpectPropertyKeepsTheChainForTheNegatedAndValueForms) {
    auto result = engine.execute_test (R"(
        pm.test("absence", function() { pm.expect({a:1}).to.not.have.property("x"); });
        pm.test("absence still fails when present", function() { pm.expect({a:1}).to.not.have.property("a"); });
        pm.test("negated chain keeps its subject", function() { pm.expect({a:1}).to.not.have.property("x").and.not.have.property("a"); });
        pm.test("value form", function() { pm.expect({x:1}).to.have.property("x", 1); });
        pm.test("value form keeps its subject", function() { pm.expect({x:1}).to.have.property("x", 1).and.be.an("object"); });
        pm.test("value form is not retargeted", function() { pm.expect({x:1}).to.have.property("x", 1).and.be.a("number"); });
        pm.test("missing property", function() { pm.expect({a:1}).to.have.property("x").that.is.a("number"); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 7u);
    const std::array<bool, 7> expected_pass = { true, false, false, true, true, false, false };
    for (size_t i = 0; i < expected_pass.size (); i++) {
        EXPECT_EQ (result.tests[i].passed, expected_pass.at (i))
        << result.tests[i].name << ": " << result.tests[i].error_message;
    }
}

// The value is read once: a getter that counts its calls sees exactly one, so the
// retarget does not double-run a side effect, and a getter that throws fails the
// assertion with its own error rather than passing.
TEST_F (ScriptEngineTest, ExpectPropertyReadsTheValueOnce) {
    auto result = engine.execute_test (R"(
        var reads = 0;
        var counted = { get n() { reads++; return 5; } };
        pm.test("one read", function() {
            pm.expect(counted).to.have.property("n").that.is.a("number").and.equal(5);
            pm.expect(reads).to.equal(1);
        });
        var boom = { get n() { throw new Error("getter ran"); } };
        pm.test("a throwing getter fails", function() { pm.expect(boom).to.have.property("n"); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed);
    EXPECT_NE (result.tests[1].error_message.find ("getter ran"), std::string::npos)
    << result.tests[1].error_message;
}

// `property(name, value)` and array membership compared `JS_ToCString` forms,
// under which every object matched every other object - both render as
// "[object Object]". Both now follow the chain's comparison rule.
TEST_F (ScriptEngineTest, ExpectPropertyValueAndIncludeCompareByValueNotByToString) {
    auto result = engine.execute_test (R"(
        pm.test("property is strict", function() { pm.expect({a:{b:1}}).to.not.have.property("a", {b:1}); });
        pm.test("deep property", function() { pm.expect({a:{b:1}}).to.have.deep.property("a", {b:1}); });
        pm.test("property primitive", function() { pm.expect({age:30}).to.have.property("age", 30); });
        pm.test("include is strict", function() { pm.expect([{a:1}]).to.not.include({a:1}); });
        pm.test("deep include", function() { pm.expect([{a:1}]).to.deep.include({a:1}); });
        pm.test("include primitive", function() { pm.expect([1,2]).to.include(2); });
        pm.test("include miss", function() { pm.expect([1,2]).to.not.include(3); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// ============================================================================
// pm.response Tests
// ============================================================================

TEST_F (ScriptEngineTest, ResponseStatusCode) {
    auto result = engine.execute_test (R"(
        pm.test("Status code is 200", function() {
            pm.expect(pm.response.code).to.equal(200);
        });

        pm.test("Status is the reason phrase", function() {
            pm.expect(pm.response.status).to.equal("OK");
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
}

// Postman splits the status line in two and a lifted script reads it that way:
// `status` is the phrase, `code` the number. Vayu spelled both as the number
// until #1000, so this pins the split rather than either half - a `status` that
// went back to the code would still pass every assertion on `code`, and this is
// what would notice.
TEST_F (ScriptEngineTest, ResponseStatusIsThePhraseAndCodeIsTheNumber) {
    response.status_code = 404;
    response.status_text = "Not Found";

    auto result = engine.execute_test (R"(
        pm.test("phrase", function() { pm.expect(pm.response.status).to.equal("Not Found"); });
        pm.test("a string, not a number", function() { pm.expect(typeof pm.response.status).to.equal("string"); });
        pm.test("code stays the number", function() { pm.expect(pm.response.code).to.equal(404); });
        pm.test("agrees with the reason accessor", function() { pm.expect(pm.response.status).to.equal(pm.response.reason()); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 4u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// The wire's own phrase wins where there was one - a server may word its status
// line however it likes, and reporting the registered text instead would answer
// about the code rather than about the response.
TEST_F (ScriptEngineTest, ResponseStatusPrefersTheWirePhrase) {
    response.status_code = 200;
    response.status_text = "Totally Fine";

    auto result = engine.execute_test (R"(
        pm.test("the wire's wording", function() { pm.expect(pm.response.status).to.equal("Totally Fine"); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// HTTP/2 carries no reason phrase at all, so `status` falls back to the
// registered text for the code rather than to an empty string - the same
// fallback `reason()` and `to.have.status("...")` make, out of the one helper.
// A client-side failure is the same fallback reached from vayu's synthetic 0,
// which the canonical table spells "Error".
TEST_F (ScriptEngineTest, ResponseStatusFallsBackToTheRegisteredPhrase) {
    response.status_code = 503;
    response.status_text.clear ();

    auto result = engine.execute_test (R"(
        pm.test("registered phrase", function() { pm.expect(pm.response.status).to.equal("Service Unavailable"); });
        pm.test("and the assertion agrees", function() { pm.response.to.have.status("Service Unavailable"); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 2u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }

    response.status_code = 0;
    response.status_text.clear ();

    auto failed = engine.execute_test (R"(
        pm.test("synthetic status", function() { pm.expect(pm.response.status).to.equal("Error"); });
        pm.test("synthetic code", function() { pm.expect(pm.response.code).to.equal(0); });
    )",
    request, response, env);

    EXPECT_TRUE (failed.success) << failed.error_message;
    ASSERT_EQ (failed.tests.size (), 2u);
    for (const auto& test : failed.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
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
// Chai-postman verdicts (issue #998)
// ============================================================================
//
// Six assertions returned a verdict Postman does not give, five of them in the
// dangerous direction - Vayu passed where Postman fails, which in a testing
// tool is a green suite over a broken API. Each test below asserts BOTH
// directions, so it is its own mutation check: on the code these replaced, the
// false-pass half goes red.

TEST_F (ScriptEngineTest, ResponseJsonBodyComparesTheValueItWasGiven) {
    response.body = R"({"id": 1, "user": {"name": "John"}})";

    auto result = engine.execute_test (R"(
        pm.test("right value", function() { pm.response.to.have.jsonBody("id", 1); });
        pm.test("nested deep value", function() { pm.response.to.have.jsonBody("user", { name: "John" }); });
        pm.test("wrong value", function() { pm.response.to.have.jsonBody("id", 2); });
        pm.test("wrong nested value", function() { pm.response.to.have.jsonBody("user", { name: "Jane" }); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 4u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
    EXPECT_FALSE (result.tests[2].passed)
    << "jsonBody must compare the expected value";
    EXPECT_FALSE (result.tests[3].passed) << "jsonBody must compare deeply";
    EXPECT_NE (result.tests[2].error_message.find ("'id'"), std::string::npos)
    << "the failure must name the path: " << result.tests[2].error_message;
}

TEST_F (ScriptEngineTest, ResponseBodyStringIsExactNotSubstring) {
    response.body = "pong";

    auto result = engine.execute_test (R"(
        pm.test("exact", function() { pm.response.to.have.body("pong"); });
        pm.test("substring", function() { pm.response.to.have.body("pon"); });
        pm.test("superstring", function() { pm.response.to.have.body("pongpong"); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 3u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed)
    << "a substring must not satisfy body()";
    EXPECT_FALSE (result.tests[2].passed);
}

TEST_F (ScriptEngineTest, ResponseBodyRunsARegularExpressionAndDeepEqualsAnObject) {
    response.body = R"({"ok": true, "count": 2})";

    auto result = engine.execute_test (R"(
        pm.test("pattern matches", function() { pm.response.to.have.body(/"count":\s*2/); });
        pm.test("pattern misses", function() { pm.response.to.have.body(/"count":\s*3/); });
        pm.test("object equal", function() { pm.response.to.have.body({ ok: true, count: 2 }); });
        pm.test("object differs", function() { pm.response.to.have.body({ ok: true, count: 3 }); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 4u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed);
    EXPECT_TRUE (result.tests[2].passed) << result.tests[2].error_message;
    EXPECT_FALSE (result.tests[3].passed);
}

// A number is neither of the three forms chai-postman reads, and stringifying
// it into a comparison is how the substring version passed on anything. It is
// a mistake in the script text, so it is a TypeError rather than a verdict.
TEST_F (ScriptEngineTest, ResponseBodyRefusesAnArgumentItCannotCompare) {
    response.body = "5";

    auto result = engine.execute_test (R"(
        pm.test("number", function() { pm.response.to.have.body(5); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("TypeError"), std::string::npos)
    << result.tests[0].error_message;
}

// Reading the pattern's `test` runs a getter the script may have written, and
// one that throws must reach the report as the script's own error - not as a
// deep-equal mismatch against a body it never got to look at.
TEST_F (ScriptEngineTest, ResponseBodyPropagatesAThrowFromTheArgumentItReads) {
    response.body = R"({"id": 1})";

    auto result = engine.execute_test (R"(
        pm.test("throwing getter", function() {
            pm.response.to.have.body({ get test () { throw new Error("from the getter"); } });
        });
        pm.test("throwing pattern", function() {
            pm.response.to.have.body({ test: function () { throw new Error("from the pattern"); } });
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2u);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_NE (result.tests[0].error_message.find ("from the getter"), std::string::npos)
    << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed);
    EXPECT_NE (result.tests[1].error_message.find ("from the pattern"), std::string::npos)
    << result.tests[1].error_message;
}

TEST_F (ScriptEngineTest, ResponseStatusTakesAReasonPhrase) {
    auto result = engine.execute_test (R"(
        pm.test("reason", function() { pm.response.to.have.status("OK"); });
        pm.test("code", function() { pm.response.to.have.status(200); });
        pm.test("wrong reason", function() { pm.response.to.have.status("Not Found"); });
        pm.test("code as a string", function() { pm.response.to.have.status("200"); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 4u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
    EXPECT_FALSE (result.tests[2].passed);
    EXPECT_FALSE (result.tests[3].passed)
    << "a string is a reason phrase, never a coerced code";
}

// HTTP/2 carries no reason phrase, so the assertion reads the same fallback
// pm.response.reason() does rather than comparing against an empty string.
TEST_F (ScriptEngineTest, ResponseStatusReasonFallsBackToTheRegisteredPhrase) {
    response.status_code = 404;
    response.status_text.clear ();

    auto result = engine.execute_test (R"(
        pm.test("registered phrase", function() { pm.response.to.have.status("Not Found"); });
        pm.test("agrees with the reason accessor", function() { pm.expect(pm.response.reason()).to.equal("Not Found"); });
        pm.test("other phrase", function() { pm.response.to.have.status("OK"); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 3u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
    EXPECT_FALSE (result.tests[2].passed);
}

TEST_F (ScriptEngineTest, ResponseHeaderValueComparisonIsStrict) {
    response.headers["X-Count"] = "5";

    auto result = engine.execute_test (R"(
        pm.test("string matches", function() { pm.response.to.have.header("Content-Type", "application/json"); });
        pm.test("number does not", function() { pm.response.to.have.header("X-Count", 5); });
        pm.test("wrong string", function() { pm.response.to.have.header("X-Count", "6"); });
        pm.test("right string", function() { pm.response.to.have.header("X-Count", "5"); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 4u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed)
    << "a number must not be stringified into agreement with the wire";
    EXPECT_FALSE (result.tests[2].passed);
    EXPECT_TRUE (result.tests[3].passed) << result.tests[3].error_message;
}

// The name a script asks for and the name the wire sent are matched the way
// HTTP matches header names - without case (#1127). The fixture stores
// `Content-Type`; a script that asks in any other casing gets the same answer,
// and its value comes back for the two-argument form.
TEST_F (ScriptEngineTest, ResponseHeaderLookupIgnoresTheCaseTheWireUsed) {
    auto result = engine.execute_test (R"(
        pm.test("lower-cased name finds it", function() { pm.response.to.have.header("content-type"); });
        pm.test("upper-cased name carries its value", function() { pm.response.to.have.header("CONTENT-TYPE", "application/json"); });
        pm.test("mixed-cased name carries its value", function() { pm.response.to.have.header("cOnTeNt-TyPe", "application/json"); });
        pm.test("a name no casing can reach still fails", function() { pm.response.to.have.header("content-length"); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 4u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
    EXPECT_TRUE (result.tests[2].passed) << result.tests[2].error_message;
    EXPECT_FALSE (result.tests[3].passed)
    << "case-insensitive is not the same as matching anything";
}

TEST_F (ScriptEngineTest, HeadersHasChecksTheValueWhenItIsGivenOne) {
    response.headers["X-Count"] = "5";

    auto result = engine.execute_test (R"(
        pm.test("present", function() { pm.expect(pm.response.headers.has("X-Request-Id")).to.equal(true); });
        pm.test("value matches", function() { pm.expect(pm.response.headers.has("X-Request-Id", "abc123")).to.equal(true); });
        pm.test("value differs", function() { pm.expect(pm.response.headers.has("X-Request-Id", "nope")).to.equal(false); });
        pm.test("number never matches", function() { pm.expect(pm.response.headers.has("X-Count", 5)).to.equal(false); });
        pm.test("absent with a value", function() { pm.expect(pm.response.headers.has("X-Absent", "x")).to.equal(false); });
        pm.test("request side too", function() { pm.expect(pm.request.headers.has("Content-Type", "application/json")).to.equal(true); });
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_EQ (result.tests.size (), 6u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// `ok` is a named code in chai-postman, not the 2xx class `success` is, so the
// two stop being synonyms exactly here: a 204 satisfies one and not the other.
TEST_F (ScriptEngineTest, ResponseToBeOkIsStatus200Only) {
    response.status_code = 204;
    response.status_text = "No Content";
    response.body.clear ();

    auto result = engine.execute_test (R"(
        pm.test("success is the class", function() { pm.response.to.be.success; });
        pm.test("ok is the code", function() { pm.response.to.be.ok; });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed)
    << "ok must be status 200, not any 2xx";
}

// ============================================================================
// Coercion leftovers of the #998 sweep (issue #1048)
// ============================================================================
//
// Two reads the comparison path made without asking whether they had worked.
// Every test below asserts both directions, so each is its own mutation check:
// restore the unchecked read or the truncating conversion and the half that
// must fail goes green.

// A getter that throws is a read that did not happen. The exception sentinel it
// hands back is neither a number nor an object, so the walk used to compare it
// as an ordinary value and report "not deeply equal" - a verdict about a
// comparison that never ran, with the script's own error left pending and
// never shown. #959's shape, one level below where it was fixed.
TEST_F (ScriptEngineTest, DeepEqualPropagatesAThrowFromAMemberItReads) {
    response.body = R"({"id": {"x": 1}, "list": [1]})";

    auto result = engine.execute_test (R"(
        pm.test("object key", function() {
            pm.expect({a: 1}).to.eql({ get a () { throw new Error("from the key"); } });
        });
        pm.test("array element", function() {
            var arr = [];
            Object.defineProperty(arr, 0, {
                enumerable: true, get: function() { throw new Error("from the element"); }
            });
            pm.expect([1]).to.eql(arr);
        });
        pm.test("array length", function() {
            var lying = new Proxy([1], {
                get: function(target, key) {
                    if (key === "length") { throw new Error("from the length"); }
                    return target[key];
                }
            });
            pm.expect([1]).to.eql(lying);
        });
        pm.test("through jsonBody", function() {
            pm.response.to.have.jsonBody("id", { get x () { throw new Error("from jsonBody"); } });
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 4u);
    const std::array<const char*, 4> expected = { "from the key",
        "from the element", "from the length", "from jsonBody" };
    for (size_t i = 0; i < result.tests.size (); i++) {
        EXPECT_FALSE (result.tests[i].passed) << result.tests[i].name;
        EXPECT_NE (result.tests[i].error_message.find (expected.at (i)), std::string::npos)
        << result.tests[i].name << ": " << result.tests[i].error_message;
    }
}

// The audit the issue asked for: the same omission in the reads each assertion
// helper makes *before* handing a value to the comparison. Every case below is
// negated, because that is where the swallow paid out - "these differ" about a
// read that never happened is a PASS under `.not`, which is a green test over a
// broken object.
TEST_F (ScriptEngineTest, AssertionHelpersPropagateAThrowFromTheReadsTheyCompare) {
    auto result = engine.execute_test (R"(
        function throwingElement() {
            var arr = [];
            Object.defineProperty(arr, 0, {
                enumerable: true, get: function() { throw new Error("from the element"); }
            });
            return arr;
        }
        function throwingLength() {
            return { get length () { throw new Error("from the length"); } };
        }
        function unlistableKeys() {
            return new Proxy({}, {
                ownKeys: function() { throw new Error("from the keys"); }
            });
        }
        function throwingKey(message) {
            return { get a () { throw new Error(message); } };
        }

        pm.test("include", function() { pm.expect(throwingElement()).to.not.include(1); });
        pm.test("oneOf", function() { pm.expect(1).to.not.be.oneOf(throwingElement()); });
        pm.test("members", function() { pm.expect(throwingElement()).to.not.have.members([1]); });
        pm.test("keys", function() { pm.expect({a: 1}).to.not.have.keys(throwingElement()); });
        pm.test("property value", function() {
            pm.expect(throwingKey("from the property")).to.not.have.property("a", 1);
        });
        pm.test("nested walk", function() {
            pm.expect(throwingKey("from the walk")).to.not.have.nested.property("a.b");
        });
        pm.test("empty", function() { pm.expect(unlistableKeys()).to.not.be.empty; });
        pm.test("length", function() { pm.expect(throwingLength()).to.not.have.length(0); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 8u);
    const std::array<const char*, 8> expected = { "from the element",
        "from the element", "from the element", "from the element",
        "from the property", "from the walk", "from the keys", "from the length" };
    for (size_t i = 0; i < result.tests.size (); i++) {
        EXPECT_FALSE (result.tests[i].passed) << result.tests[i].name;
        EXPECT_NE (result.tests[i].error_message.find (expected.at (i)), std::string::npos)
        << result.tests[i].name << ": " << result.tests[i].error_message;
    }
}

// A Date and a RegExp are compared through their own rendering, and both
// renderers answer "" when the script they run throws. Two empty renderings
// compare *equal*, so this pair used to PASS - the dangerous direction, and
// the one #996 exists to close.
TEST_F (ScriptEngineTest, DeepEqualDoesNotPassAPairItCouldNotRender) {
    auto result = engine.execute_test (R"(
        pm.test("dates", function() {
            var a = new Date(0), b = new Date(5);
            a.toJSON = function() { throw new Error("from the first toJSON"); };
            b.toJSON = function() { throw new Error("from the second toJSON"); };
            pm.expect(a).to.eql(b);
        });
        pm.test("regexps", function() {
            var a = /one/, b = /two/;
            a.toString = function() { throw new Error("from the first toString"); };
            b.toString = function() { throw new Error("from the second toString"); };
            pm.expect(a).to.eql(b);
        });
        pm.test("dates that render still compare", function() {
            pm.expect(new Date(0)).to.eql(new Date(0));
            pm.expect(new Date(0)).to.not.eql(new Date(5));
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 3u);
    EXPECT_FALSE (result.tests[0].passed)
    << "two Dates that cannot be rendered are not equal Dates";
    // The *first* side's error, because rendering the second over a throw
    // replaces the pending exception with one about a read the author is not
    // being told failed.
    EXPECT_NE (result.tests[0].error_message.find ("from the first toJSON"), std::string::npos)
    << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed)
    << "two RegExps that cannot be rendered are not equal RegExps";
    EXPECT_NE (result.tests[1].error_message.find ("from the first toString"),
    std::string::npos)
    << result.tests[1].error_message;
    EXPECT_TRUE (result.tests[2].passed) << result.tests[2].error_message;
}

// `JS_ToInt32` truncated toward zero, so a fractional expectation compared as
// its floor and `status(200.5)` passed against a 200. No response carries a
// fractional code, so the assertion is a mistake in the script text and is
// refused there - the same call `body(5)` gets - rather than reported as a
// verdict about the status the author did get.
TEST_F (ScriptEngineTest, ResponseStatusRefusesANonIntegerCode) {
    auto result = engine.execute_test (R"(
        pm.test("fractional", function() { pm.response.to.have.status(200.5); });
        pm.test("not a number at all", function() { pm.response.to.have.status(NaN); });
        pm.test("the code itself still passes", function() { pm.response.to.have.status(200); });
        pm.test("another code still fails", function() { pm.response.to.have.status(201); });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 4u);
    EXPECT_FALSE (result.tests[0].passed)
    << "200.5 must not be truncated into agreement with a 200";
    EXPECT_NE (result.tests[0].error_message.find ("TypeError"), std::string::npos)
    << result.tests[0].error_message;
    EXPECT_NE (result.tests[0].error_message.find ("200.5"), std::string::npos)
    << "the refusal must name what was written: " << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed);
    EXPECT_NE (result.tests[1].error_message.find ("NaN"), std::string::npos)
    << result.tests[1].error_message;
    EXPECT_TRUE (result.tests[2].passed) << result.tests[2].error_message;
    EXPECT_FALSE (result.tests[3].passed);
    EXPECT_NE (result.tests[3].error_message.find ("201"), std::string::npos)
    << result.tests[3].error_message;
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
    const auto cases = std::to_array<Case> ({
    { 100, "info", "ok" },
    { 200, "ok", "info" },
    { 204, "success", "ok" },
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
    });

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

    response.body = "not json at all";
    auto not_json = engine.execute_test (R"(
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
    const auto scripts = std::to_array<const char*> ({
    R"(pm.test("t", function() { pm.response.to.be.definitelyNotAMatcher; });)",
    R"(pm.test("t", function() { pm.response.to.have.definitelyNotAMatcher; });)",
    R"(pm.test("t", function() { pm.response.to.definitelyNotAMatcher; });)",
    // The negated chain is armed the same way (#2528).
    R"(pm.test("t", function() { pm.response.to.not.definitelyNotAMatcher; });)",
    R"(pm.test("t", function() { pm.response.to.not.be.definitelyNotAMatcher; });)",
    });

    for (const char* script : scripts) {
        auto result = engine.execute_test (script, request, response, env);
        ASSERT_EQ (result.tests.size (), 1u) << script;
        EXPECT_FALSE (result.tests[0].passed) << script;
        EXPECT_NE (
        result.tests[0].error_message.find ("not a supported assertion"), std::string::npos)
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
// variable's secret flag and type - only the value changes (and `enabled` is
// ticked, see SetOnADisabledRowMakesItReadable). The pre-fix whole-record
// replace silently un-masked a secret variable in the UI and reset its type.
// Mutation-check: restore the Variable{value,false,true} assignment in
// set_variable_preserving and the secret/type asserts here fail.
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
    EXPECT_TRUE (env["token"].enabled);
    EXPECT_EQ (env["token"].type, "json"); // type preserved
}

// #2479: a set is a write of a value the script means to use, so it ticks a row
// the user had unticked. Left unticked, the script's own get/has/replaceIn and
// the execute-time residual pass look past the row it just wrote.
TEST_F (ScriptEngineTest, SetOnADisabledRowMakesItReadable) {
    env["token"] = Variable{ "old", false, false };

    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('token', 'new');
        pm.environment.set('got', String(pm.environment.get('token')));
        pm.environment.set('has', String(pm.environment.has('token')));
        pm.environment.set('repl', pm.variables.replaceIn('[{{token}}]'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["got"].value, "new");
    EXPECT_EQ (env["has"].value, "true");
    EXPECT_EQ (env["repl"].value, "[new]");
    EXPECT_TRUE (env["token"].enabled);
}

// Ticking the row changes nothing else about it.
TEST_F (ScriptEngineTest, SetOnADisabledRowKeepsItsSecretFlagTypeAndCreationTime) {
    Variable disabled{ "old", true, false, "json" };
    disabled.created_at = 1784967810149;
    env["token"]        = disabled;

    auto result =
    engine.execute_prerequest ("pm.environment.set('token', 'new');", request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["token"].value, "new");
    EXPECT_TRUE (env["token"].enabled);
    EXPECT_TRUE (env["token"].secret);
    EXPECT_EQ (env["token"].type, "json");
    EXPECT_EQ (env["token"].created_at, 1784967810149);
}

// The same for the other two scopes' setters, which share the helper.
TEST_F (ScriptEngineTest, GlobalsAndCollectionSetOnADisabledRowMakeItReadable) {
    Environment globals;
    globals["g"] = Variable{ "old", false, false };
    Environment collVars;
    collVars["c"] = Variable{ "old", false, false };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &collVars;

    auto result = engine.execute (R"JS(
        pm.globals.set('g', 'new-g');
        pm.collectionVariables.set('c', 'new-c');
        pm.environment.set('gGot', String(pm.globals.get('g')));
        pm.environment.set('cGot', String(pm.collectionVariables.get('c')));
        pm.environment.set('repl', pm.variables.replaceIn('{{g}}/{{c}}'));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (globals["g"].enabled);
    EXPECT_TRUE (collVars["c"].enabled);
    EXPECT_EQ (env["gGot"].value, "new-g");
    EXPECT_EQ (env["cGot"].value, "new-c");
    EXPECT_EQ (env["repl"].value, "new-g/new-c");
}

// A set lands in the leaf: a row an ancestor collection holds unticked stays
// as it was, and the leaf gains its own enabled key.
TEST_F (ScriptEngineTest, CollectionSetOverADisabledAncestorRowLandsEnabledInTheLeaf) {
    std::vector<Environment> ancestors (1);
    ancestors[0]["token"] = Variable{ "from-root", false, false };
    Environment leaf;
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.globals.set('before', String(pm.collectionVariables.has('token')));
        pm.collectionVariables.set('token', 'from-leaf');
        pm.globals.set('after', String(pm.collectionVariables.get('token')));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["before"].value, "false");
    EXPECT_EQ (globals["after"].value, "from-leaf");
    ASSERT_EQ (leaf.count ("token"), 1U);
    EXPECT_TRUE (leaf["token"].enabled);
    EXPECT_EQ (leaf["token"].value, "from-leaf");
    EXPECT_EQ (ancestors[0]["token"].value, "from-root");
    EXPECT_FALSE (ancestors[0]["token"].enabled);
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
    EXPECT_EQ (result.console_output[0].message, "Hello, World!");
    EXPECT_EQ (result.console_output[1].message, "Value: 42");
}

// The four methods were bound to one C function that recorded no level, so
// every line reached the app looking identical whether the script called
// `log` or `error` - the Console tab had nothing to differentiate on.
TEST_F (ScriptEngineTest, ConsoleRecordsTheLevelItWasCalledWith) {
    auto result = engine.execute_test (R"(
        console.log("plain");
        console.info("noted");
        console.warn("careful");
        console.error("broken");
        pm.test("dummy", function() {});
    )",
    request, response, env);

    EXPECT_TRUE (result.success);
    ASSERT_EQ (result.console_output.size (), 4u);
    EXPECT_EQ (result.console_output[0].level, vayu::ConsoleLevel::Log);
    EXPECT_EQ (result.console_output[1].level, vayu::ConsoleLevel::Info);
    EXPECT_EQ (result.console_output[2].level, vayu::ConsoleLevel::Warn);
    EXPECT_EQ (result.console_output[3].level, vayu::ConsoleLevel::Error);

    // The message must survive the level being carried beside it.
    EXPECT_EQ (result.console_output[3].message, "broken");
}

// The wire spellings are what the app matches on, so they are part of the
// contract rather than an implementation detail of the enum.
TEST_F (ScriptEngineTest, ConsoleLevelWireSpellings) {
    EXPECT_STREQ (vayu::to_string (vayu::ConsoleLevel::Log), "log");
    EXPECT_STREQ (vayu::to_string (vayu::ConsoleLevel::Info), "info");
    EXPECT_STREQ (vayu::to_string (vayu::ConsoleLevel::Warn), "warn");
    EXPECT_STREQ (vayu::to_string (vayu::ConsoleLevel::Error), "error");
}

// What one script execution may leave in its console (#3134). The caps are the
// constants themselves, so the tests move with them.
namespace console_limits = vayu::core::constants::script_engine;

namespace {

bool is_console_limit_marker (const vayu::ConsoleEntry& entry) {
    return entry.level == vayu::ConsoleLevel::Warn &&
    entry.message.find ("console output limit reached") != std::string::npos;
}

std::size_t console_limit_markers (const vayu::ScriptResult& result) {
    return static_cast<std::size_t> (
    std::ranges::count_if (result.console_output, is_console_limit_marker));
}

} // namespace

TEST_F (ScriptEngineTest, ConsoleEntryCapKeepsTheCapAndOneMarker) {
    const auto result = engine.execute_test ("for (let i = 0; i < " +
    std::to_string (console_limits::CONSOLE_MAX_ENTRIES + 500) + "; i++) console.log ('line ' + i);",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.console_output.size (), console_limits::CONSOLE_MAX_ENTRIES + 1);
    EXPECT_EQ (result.console_output[console_limits::CONSOLE_MAX_ENTRIES - 1].message,
    "line " + std::to_string (console_limits::CONSOLE_MAX_ENTRIES - 1));
    EXPECT_TRUE (is_console_limit_marker (result.console_output.back ()));
    EXPECT_EQ (console_limit_markers (result), 1u);
}

// The marker is for output that was dropped: a script that stops exactly at
// the cap lost nothing and gets none.
TEST_F (ScriptEngineTest, ConsoleAtExactlyTheEntryCapEmitsNoMarker) {
    const auto result = engine.execute_test ("for (let i = 0; i < " +
    std::to_string (console_limits::CONSOLE_MAX_ENTRIES) + "; i++) console.log ('line ' + i);",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.console_output.size (), console_limits::CONSOLE_MAX_ENTRIES);
    EXPECT_EQ (console_limit_markers (result), 0u);
}

// Lines each under the line cap, so only the total can stop them.
TEST_F (ScriptEngineTest, ConsoleTotalByteCapDropsWholeLinesAndEmitsOneMarker) {
    constexpr std::size_t line_bytes = 60000;
    static_assert (line_bytes < console_limits::CONSOLE_LINE_MAX_BYTES);
    const std::size_t lines_that_fit = console_limits::CONSOLE_TOTAL_MAX_BYTES / line_bytes;

    const auto result =
    engine.execute_test ("const line = 'x'.repeat (" + std::to_string (line_bytes) +
    ");"
    "for (let i = 0; i < " +
    std::to_string (lines_that_fit + 5) + "; i++) console.log (line);",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.console_output.size (), lines_that_fit + 1);
    EXPECT_TRUE (is_console_limit_marker (result.console_output.back ()));
    EXPECT_EQ (console_limit_markers (result), 1u);

    std::size_t kept = 0;
    for (std::size_t i = 0; i < lines_that_fit; ++i) {
        EXPECT_EQ (result.console_output[i].message.size (), line_bytes);
        kept += result.console_output[i].message.size ();
    }
    EXPECT_LE (kept, console_limits::CONSOLE_TOTAL_MAX_BYTES);
}

TEST_F (ScriptEngineTest, ConsoleLineOverTheCapIsTruncatedWithAMarker) {
    const std::string over =
    std::to_string (console_limits::CONSOLE_LINE_MAX_BYTES + 1000);
    const auto result = engine.execute_test (
    "console.log ('x'.repeat (" + over + "));", request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.console_output.size (), 1u);
    const std::string& message = result.console_output[0].message;
    EXPECT_EQ (message.substr (0, console_limits::CONSOLE_LINE_MAX_BYTES),
    std::string (console_limits::CONSOLE_LINE_MAX_BYTES, 'x'));
    EXPECT_NE (message.find ("[truncated"), std::string::npos);
    EXPECT_LT (message.size (), console_limits::CONSOLE_LINE_MAX_BYTES + 100);
}

TEST_F (ScriptEngineTest, ConsoleLineExactlyAtTheCapIsKeptWhole) {
    const auto result = engine.execute_test ("console.log ('x'.repeat (" +
    std::to_string (console_limits::CONSOLE_LINE_MAX_BYTES) + "));",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.console_output.size (), 1u);
    EXPECT_EQ (result.console_output[0].message,
    std::string (console_limits::CONSOLE_LINE_MAX_BYTES, 'x'));
}

// A cut that lands inside a character must back up to the one before it, for
// each width UTF-8 has (2, 3 and 4 bytes).
TEST_F (ScriptEngineTest, ConsoleTruncationNeverSplitsAMultiByteCharacter) {
    struct Wide {
        const char* js;
        std::size_t bytes;
    };
    const std::array<Wide, 3> widths{ Wide{ "\\u00e9", 2 },
        Wide{ "\\u20ac", 3 }, Wide{ "\\ud83d\\ude00", 4 } };

    for (const auto& wide : widths) {
        // The character starts one byte short of the cap, so the cap falls
        // inside it for every width above 1.
        const std::size_t prefix = console_limits::CONSOLE_LINE_MAX_BYTES - 1;
        const auto result = engine.execute_test ("console.log ('a'.repeat (" +
        std::to_string (prefix) + ") + '" + wide.js + "' + 'tail');",
        request, response, env);

        ASSERT_TRUE (result.success) << result.error_message;
        ASSERT_EQ (result.console_output.size (), 1u);
        const std::string& message = result.console_output[0].message;
        EXPECT_TRUE (vayu::utils::is_valid_utf8_text (message))
        << wide.bytes << "-byte character";
        EXPECT_EQ (message.substr (0, prefix), std::string (prefix, 'a'));
        EXPECT_EQ (message.find ("tail"), std::string::npos);
        EXPECT_NE (message.find ("[truncated"), std::string::npos);
    }
}

// JSON.stringify flattens an Error, a Map and a Set to "{}" and quotes a Date;
// the console prints all four the way Node does (#3130).
class ConsoleFormatTest : public ScriptEngineTest {
    protected:
    // The one line a script logs.
    std::string run (const std::string& script) {
        const std::string full = script + "\npm.test('t', function () {});";
        auto result = engine.execute_test (full, request, response, env);
        EXPECT_TRUE (result.success) << result.error_message;
        EXPECT_EQ (result.console_output.size (), 1u);
        return result.console_output.empty () ? "" : result.console_output[0].message;
    }

    std::string logged (const std::string& expression) {
        return run ("console.log (" + expression + ");");
    }
};

TEST_F (ConsoleFormatTest, ErrorPrintsItsMessageAndStack) {
    auto message = logged ("new Error ('boom')");
    EXPECT_EQ (message.rfind ("Error: boom", 0), 0u) << message;
    EXPECT_NE (message.find ("\n    at "), std::string::npos)
    << "the stack follows the message line: " << message;
}

TEST_F (ConsoleFormatTest, ErrorNamesItsKindAndKeepsTheMessageOnce) {
    auto message = logged ("new TypeError ('bad type')");
    EXPECT_EQ (message.rfind ("TypeError: bad type", 0), 0u) << message;
    EXPECT_EQ (message.find ("bad type"), message.rfind ("bad type"))
    << "the message line is not repeated by the stack: " << message;
}

TEST_F (ConsoleFormatTest, ErrorWhoseStackAlreadyLeadsWithTheMessageIsNotDoubled) {
    EXPECT_EQ (run (R"(
        var e = new Error ('boom');
        e.stack = 'Error: boom\n    at here\n';
        console.log (e);
    )"),
    "Error: boom\n    at here");
}

TEST_F (ConsoleFormatTest, ErrorWithAnEmptyStackPrintsItsStringForm) {
    EXPECT_EQ (run (R"(
        var e = new Error ('boom');
        e.stack = '';
        console.log (e);
    )"),
    "Error: boom");
}

TEST_F (ConsoleFormatTest, MapPrintsItsEntries) {
    EXPECT_EQ (logged ("new Map ([[1, 2]])"), "Map(1) {1 => 2}");
    EXPECT_EQ (logged ("new Map ([['a', 1], ['b', 2]])"), R"(Map(2) {"a" => 1, "b" => 2})");
    EXPECT_EQ (logged ("new Map ()"), "Map(0) {}");
}

TEST_F (ConsoleFormatTest, MapEntriesRenderNestedObjectsAndUnserializableValues) {
    EXPECT_EQ (logged ("new Map ([['k', { a: [1, 2] }]])"), R"(Map(1) {"k" => {"a":[1,2]}})");
    EXPECT_EQ (logged ("new Map ([[1, undefined]])"), "Map(1) {1 => undefined}");
    EXPECT_EQ (logged ("new Map ([[1, Symbol ('s')]])"), "Map(1) {1 => [unserializable]}");
}

TEST_F (ConsoleFormatTest, SetPrintsItsValues) {
    EXPECT_EQ (logged ("new Set ([1])"), "Set(1) {1}");
    EXPECT_EQ (logged ("new Set (['a', 'b'])"), R"(Set(2) {"a", "b"})");
    EXPECT_EQ (logged ("new Set ()"), "Set(0) {}");
}

TEST_F (ConsoleFormatTest, ACollectionStillPrintsWhenAScriptReplacesArrayFrom) {
    // The members are read through Array.from; when that is gone the line
    // degrades to the generic path rather than throwing.
    EXPECT_EQ (logged ("(Array.from = undefined, new Set ([1]))"), "{}");
}

TEST_F (ConsoleFormatTest, DatePrintsAnUnquotedIsoString) {
    EXPECT_EQ (logged ("new Date (0)"), "1970-01-01T00:00:00.000Z");
    EXPECT_EQ (logged ("new Date (NaN)"), "Invalid Date");
}

TEST_F (ConsoleFormatTest, OtherObjectsAreStillPrettyPrintedJson) {
    EXPECT_EQ (logged ("{ a: 1 }"), "{\n  \"a\": 1\n}");
    EXPECT_EQ (logged ("[1, 2]"), "[\n  1,\n  2\n]");
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
    EXPECT_EQ (result.console_output[0].message, "got 42");
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

// `pm.request.headers` is single-valued and shows a repeated header folded
// (issue #2466). A script that leaves it as it read it leaves every line, in
// place and spelling; one that writes it leaves one line. Mutation check:
// rebuild the lines from the script's object alone in
// `apply_script_headers` and the untouched repeat collapses to one line.
TEST_F (ScriptEngineTest, APreRequestScriptKeepsTheRepeatedHeaderItDidNotChange) {
    request.headers.clear ();
    request.headers.add ("X-Dup", "one");
    request.headers.add ("Accept", "*/*");
    request.headers.add ("x-dup", "two");

    auto result = engine.execute_prerequest (R"JS(
        pm.expect(pm.request.headers['X-Dup']).to.equal('one, two');
        pm.request.headers['Accept'] = 'application/json';
        pm.request.headers['X-New'] = '1';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.headers,
    (vayu::HeaderList{ { "X-Dup", "one" }, { "Accept", "application/json" },
    { "x-dup", "two" }, { "X-New", "1" } }));

    auto rewrite = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Dup'] = 'only';
    )JS",
    request, env);

    EXPECT_TRUE (rewrite.success) << rewrite.error_message;
    EXPECT_EQ (request.headers,
    (vayu::HeaderList{
    { "X-Dup", "only" }, { "Accept", "application/json" }, { "X-New", "1" } }));
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

// ============================================================================
// Form bodies and pm.request.body
// ============================================================================
//
// The two form modes carry their content in `fields`, so a bridge that read
// `content` handed the script `""` - indistinguishable from a request with no
// body. Every read assertion below goes through a header the script sets from
// the body, so it is the sent `Request` being checked, not the JS object.

namespace {

Body urlencoded_body () {
    Body body;
    body.mode   = BodyMode::Form;
    body.fields = { { "grant_type", "client_credentials", true },
        { "scope", "read write", true } };
    return body;
}

Body form_data_body () {
    Body body;
    body.mode   = BodyMode::FormData;
    body.fields = { { "name", "Ada", true }, { "role", "admin", true } };
    return body;
}

} // namespace

TEST_F (ScriptEngineTest, ScriptReadsAUrlencodedBodyAsTheStringThatGoesOnTheWire) {
    request.body = urlencoded_body ();

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // Exactly what apply_method_and_body puts in the body frame - the space in
    // "read write" percent-encoded by the one shared encoder.
    EXPECT_EQ (request.headers["X-Seen-Body"], "grant_type=client_credentials&scope=read%20write");
}

TEST_F (ScriptEngineTest, ScriptReadsAFormDataBodyAsItsFieldsRatherThanEmpty) {
    request.body = form_data_body ();

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
        pm.request.headers['X-Body-Empty'] = String(pm.request.body === '');
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // A rendering of the parts, not the multipart envelope: that carries a
    // boundary libcurl generates at transfer time.
    EXPECT_EQ (request.headers["X-Seen-Body"], "name=Ada&role=admin");
    EXPECT_EQ (request.headers["X-Body-Empty"], "false");
}

TEST_F (ScriptEngineTest, ScriptReadingAFormBodySeesOnlyTheEnabledFields) {
    request.body        = urlencoded_body ();
    request.body.fields = { { "kept", "1", true }, { "off", "2", false } };

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // A disabled row is stored but never sent, so a script signing the body
    // must not see it either.
    EXPECT_EQ (request.headers["X-Seen-Body"], "kept=1");
}

TEST_F (ScriptEngineTest, ScriptCanTellAFormBodyApartFromNoBody) {
    ASSERT_EQ (request.body.mode, BodyMode::None);

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Body-Type'] = typeof pm.request.body;
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // The bodyless case is still `undefined`, which is what makes the non-empty
    // string above meaningful.
    EXPECT_EQ (request.headers["X-Body-Type"], "undefined");
}

TEST_F (ScriptEngineTest, ScriptOnlyReadingAFormBodyLeavesItsFieldsAlone) {
    request.body        = urlencoded_body ();
    request.body.fields = { { "kept", "1", true }, { "off", "2", false } };

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // The write-back reads `body` off the JS object whether or not the script
    // assigned it, so an unchanged string has to mean untouched. Applying it
    // regardless would parse the *view* back - and the view leaves disabled
    // rows out, so a script that only looked at the body would delete one.
    ASSERT_EQ (request.body.fields.size (), 2u);
    EXPECT_EQ (request.body.fields[1].key, "off");
    EXPECT_FALSE (request.body.fields[1].enabled);
}

TEST_F (ScriptEngineTest, ScriptWritingAUrlencodedBodyReachesTheFieldsThatAreSent) {
    request.body = urlencoded_body ();

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = pm.request.body + '&signature=abc';
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::Form);
    // The edit lands in `fields`, which is what the transfer layer reads for a
    // form mode - a string parked in `content` would be ignored entirely.
    ASSERT_EQ (request.body.fields.size (), 3u);
    EXPECT_EQ (request.body.fields[0].key, "grant_type");
    EXPECT_EQ (request.body.fields[0].value, "client_credentials");
    EXPECT_EQ (request.body.fields[1].key, "scope");
    EXPECT_EQ (request.body.fields[1].value, "read write");
    EXPECT_EQ (request.body.fields[2].key, "signature");
    EXPECT_EQ (request.body.fields[2].value, "abc");
    EXPECT_TRUE (request.body.content.empty ());
    EXPECT_EQ (vayu::http::encode_urlencoded (request.body.fields),
    "grant_type=client_credentials&scope=read%20write&signature=abc");
}

TEST_F (ScriptEngineTest, ScriptWritingBackAnUnchangedUrlencodedBodyChangesNothing) {
    request.body      = urlencoded_body ();
    const Body before = request.body;

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = String(pm.request.body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (request.body.fields.size (), before.fields.size ());
    for (size_t i = 0; i < before.fields.size (); ++i) {
        EXPECT_EQ (request.body.fields[i].key, before.fields[i].key);
        EXPECT_EQ (request.body.fields[i].value, before.fields[i].value);
        EXPECT_TRUE (request.body.fields[i].enabled);
    }
}

TEST_F (ScriptEngineTest, ScriptWritingAFormDataBodyIsRefusedRatherThanDropped) {
    request.body      = form_data_body ();
    const Body before = request.body;

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = 'name=Grace';
    )JS",
    request, env);

    // The whole write-back is all-or-nothing, so the request goes out as it
    // stood - the one thing that must never happen is the edit being accepted
    // and then ignored by the transfer layer.
    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("form-data"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::FormData);
    ASSERT_EQ (request.body.fields.size (), before.fields.size ());
    EXPECT_EQ (request.body.fields[0].value, "Ada");
    EXPECT_TRUE (request.body.content.empty ());
}

// ---------------------------------------------------------------------------
// File parts through the script bridge (#411). The rendering is unit-tested in
// form_body_test.cpp; these pin what a *script* can actually tell, which is the
// defect - an upload read as an empty field and nothing else in the sandbox
// exposed the parts.
// ---------------------------------------------------------------------------

namespace {

Body form_data_body_with_a_file (const std::string& src) {
    Body body   = form_data_body ();
    body.fields = { { "caption", "my avatar", true } };
    FormField up;
    up.key  = "avatar";
    up.type = FormFieldType::File;
    up.src  = src;
    body.fields.push_back (up);
    return body;
}

} // namespace

TEST_F (ScriptEngineTest, ScriptTellsAFilePartFromAnEmptyTextField) {
    request.body = form_data_body_with_a_file ("/home/ada/portrait.png");

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // Before this, the upload rendered `avatar=` - the same string the empty
    // text part below produces, so a script could not tell them apart.
    EXPECT_EQ (request.headers["X-Seen-Body"], "caption=my%20avatar&avatar=@portrait.png");

    Request text_request = request;
    text_request.headers = {};
    text_request.body    = form_data_body ();
    text_request.body.fields = { { "caption", "my avatar", true }, { "avatar", "", true } };

    auto text_result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    text_request, env);

    EXPECT_TRUE (text_result.success) << text_result.error_message;
    EXPECT_EQ (text_request.headers["X-Seen-Body"], "caption=my%20avatar&avatar=");
    EXPECT_NE (request.headers["X-Seen-Body"], text_request.headers["X-Seen-Body"]);
}

TEST_F (ScriptEngineTest, ScriptSeesTheFilenameAndNotTheLocalPath) {
    request.body =
    form_data_body_with_a_file ("/home/ada/private/portrait.png");

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Has-Path'] = String(pm.request.body.indexOf('/home/ada') !== -1);
        pm.request.headers['X-Has-Name'] = String(pm.request.body.indexOf('portrait.png') !== -1);
    )JS",
    request, env);

    EXPECT_TRUE (result.success) << result.error_message;
    // The filename is what the server is told; the path is this machine's and
    // would end up in anything the script logs.
    EXPECT_EQ (request.headers["X-Has-Path"], "false");
    EXPECT_EQ (request.headers["X-Has-Name"], "true");
}

TEST_F (ScriptEngineTest, ReadingABodyWithAFilePartRewritesNothing) {
    request.body      = form_data_body_with_a_file ("/home/ada/portrait.png");
    const Body before = request.body;

    auto result = engine.execute_prerequest (R"JS(
        pm.request.headers['X-Seen-Body'] = String(pm.request.body);
    )JS",
    request, env);

    // The write-back measures the string it gets back against the same view, so
    // a script that only *looked* leaves the parts exactly as they stood - the
    // file part included, which is the one a parse-it-back would have dropped.
    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (request.body.fields.size (), before.fields.size ());
    EXPECT_EQ (request.body.fields[1].type, FormFieldType::File);
    EXPECT_EQ (request.body.fields[1].src, before.fields[1].src);
    EXPECT_TRUE (request.body.fields[1].value.empty ());
}

TEST_F (ScriptEngineTest, AssigningABodyWithAFilePartIsStillRefused) {
    request.body = form_data_body_with_a_file ("/home/ada/portrait.png");

    auto result = engine.execute_prerequest (R"JS(
        pm.request.body = 'caption=my%20avatar&avatar=@other.png';
    )JS",
    request, env);

    // Naming the file in the view does not make the view applicable: parsing it
    // back would turn the upload into a text part reading "@other.png".
    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("form-data"), std::string::npos)
    << result.error_message;
    ASSERT_EQ (request.body.fields.size (), 2u);
    EXPECT_EQ (request.body.fields[1].type, FormFieldType::File);
    EXPECT_EQ (request.body.fields[1].src, "/home/ada/portrait.png");
}

TEST_F (ScriptEngineTest, ScriptDeletingAFormDataBodySendsNoBody) {
    request.body = form_data_body ();

    auto result = engine.execute_prerequest (R"JS(
        delete pm.request.body;
    )JS",
    request, env);

    // The refusal above is about assigning a string, not about clearing the
    // body: dropping it altogether is expressible and stays allowed.
    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.body.mode, BodyMode::None);
    EXPECT_TRUE (request.body.fields.empty ());
}

TEST_F (ScriptEngineTest, TestScriptReadsAFormBodyToo) {
    request.body = urlencoded_body ();

    auto result = engine.execute_test (R"JS(
        pm.test('body is visible', function () {
            if (String(pm.request.body) !== 'grant_type=client_credentials&scope=read%20write') {
                throw new Error('got: ' + pm.request.body);
            }
        });
    )JS",
    request, response, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
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
    EXPECT_NE (
    result.error_message.find ("must be a string, number or boolean"), std::string::npos)
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

// #1056. The deadline is enforced by raising an exception into the running
// call, so an assertion that calls back into the script sees the engine's abort
// and a value the script threw as the same thing. `.to.throw()` read that as
// "the function threw" and reported a green verdict about a function that never
// returned - the silent-false-pass quadrant #996 exists to close.
//
// Mutation check: restore the "any pending exception is a throw" reading in
// expect_throw (drop the script_deadline_expired guard) and this reddens - the
// script runs to completion with the assertion satisfied.
TEST_F (ScriptEngineTest, ThrowMatcherAbortsWhenTheTargetOutlivesTheDeadline) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (
    R"(pm.expect(function () { while (true) {} }).to.throw();)", request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("timed out"), std::string::npos)
    << "error was: " << result.error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// The same target inside a pm.test, which is how the issue reproduced it:
// pm.test records any exception from its callback as a failure, so the abort
// arrives as a FAIL rather than as the PASS today's code reports. This is the
// verdict half of the criterion and does not depend on whether the interrupt
// re-fires before the script ends.
TEST_F (ScriptEngineTest, ThrowMatcherReportsFailForATargetPastTheDeadline) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (R"(
        pm.test("a function that never returns", function () {
            pm.expect(function () { while (true) {} }).to.throw();
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_FALSE (result.tests[0].passed)
    << "a spinning target reported a pass: " << result.tests[0].error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// The other side of the fix: an ordinary throw under the same short timeout
// still satisfies `.to.throw()`, in both the bare and the constructor form. A
// guard that turned every throw into an abort would pass the two tests above.
TEST_F (ScriptEngineTest, OrdinaryThrowStillSatisfiesThrowUnderAShortTimeout) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (R"(
        pm.test("throws", function () {
            pm.expect(function () { throw new Error("boom"); }).to.throw();
            pm.expect(function () { throw new TypeError("bad"); }).to.throw(TypeError, "bad");
            pm.expect(function () { return 1; }).to.not.throw();
        });
    )",
    request, response, env);

    EXPECT_TRUE (result.success) << "error was: " << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// The flag answers about the call just made, not about the execution so far,
// and that distinction is reachable from a script: `pm.test` consumes an abort
// natively and lets the script run on with a fresh 10,000-operation budget
// before QuickJS polls again, so a second test in the same script is judged
// after a deadline has already blown. Its ordinary throw is still an ordinary
// throw. Mutation check: drop the `arm_script_deadline_watch` call before
// `JS_Call` in expect_throw - leaving the once-per-execution reset alone - and
// the second test reports FAIL with "Error: boom" instead of passing.
TEST_F (ScriptEngineTest, AThrowAfterACaughtDeadlineAbortIsStillJudgedOnItsOwn) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (R"(
        pm.test("spins past the deadline", function () {
            pm.expect(function () { while (true) {} }).to.throw();
        });
        pm.test("an ordinary throw afterwards", function () {
            pm.expect(function () { throw new Error("boom"); }).to.throw();
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_TRUE (result.tests[1].passed)
    << "an ordinary throw was read as the earlier abort: "
    << result.tests[1].error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// `.satisfy` is the other matcher that calls back into the script. It already
// propagated the exception rather than reading it as a verdict; this pins that
// it stays so, since the audit that established it is otherwise unrecorded.
TEST_F (ScriptEngineTest, SatisfyPredicatePastTheDeadlineAbortsTheScript) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (
    R"(pm.expect(1).to.satisfy(function () { while (true) {} });)", request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("timed out"), std::string::npos)
    << "error was: " << result.error_message;
#else
    GTEST_SKIP () << "QuickJS not compiled in";
#endif
}

// #1073. The message half of the same question the three tests above settled
// for the verdict: `execute` asked the *clock* whether the deadline ended the
// script, so an error that merely landed past it was relabelled a timeout and
// the sentence naming the fault was discarded. Here the deadline has provably
// passed and the handler stopped nothing since - the `arm` before the second
// `.to.throw()` clears its record, which is what makes the top-level throw
// below the only thing that ended this script.
//
// Mutation check: restore the `steady_clock::now () > deadline` comparison in
// `Impl::execute` and this reddens on "Script execution timed out after 300ms".
TEST_F (ScriptEngineTest, AnOwnThrowPastTheDeadlineKeepsItsOwnError) {
#ifdef VAYU_HAS_QUICKJS
    ScriptConfig cfg;
    cfg.timeout_ms = 300;
    ScriptEngine timeout_engine (cfg);

    auto result = timeout_engine.execute_test (R"(
        pm.test("spins past the deadline", function () {
            pm.expect(function () { while (true) {} }).to.throw();
        });
        pm.expect(function () { throw new Error("caught by the matcher"); }).to.throw();
        throw new Error("the script's own error");
    )",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("the script's own error"), std::string::npos)
    << "error was: " << result.error_message;
    EXPECT_EQ (result.error_message.find ("timed out"), std::string::npos)
    << "an ordinary throw was relabelled a timeout: " << result.error_message;
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
// is part of the contract. Installed on top of QuickJS's built-ins: `console`,
// `pm`, `btoa` / `atob` (#187), and `require` / `CryptoJS` (#2578). Still
// absent: a URL parser and `fetch`. This pins both halves so a doc example
// cannot come to rely on something that was never there (`scripting.md` used
// to show a `computeHash` that does not exist).

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

// `require` is not among them: it answers a fixed shelf and loads nothing
// else (#2578, the RequireShelf tests below).
TEST_F (ScriptEngineTest, NoUrlParserOrFetchIsExposed) {
    auto result = engine.execute_prerequest (R"JS(
        var present = [];
        var absent = ['crypto', 'TextEncoder', 'URL', 'URLSearchParams', 'fetch'];
        for (var i = 0; i < absent.length; i++) {
            if (typeof globalThis[absent[i]] !== 'undefined') present.push(absent[i]);
        }
        pm.environment.set('present', present.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    // If one of these ever lands, the "what a script can compute" section in
    // scripting.md stops being true and should be rewritten, not left standing.
    // `crypto` in particular: a global of that name is a promise of Web Crypto's
    // whole surface, which this sandbox does not implement - which is why the
    // hashing surface is pm.crypto and synchronous.
    EXPECT_EQ (env["present"].value, "")
    << "a new global is available - update the 'What a script can compute' "
       "section in scripting.md";
}

TEST_F (ScriptEngineTest, Base64AndHashingGlobalsAreInstalled) {
    auto result = engine.execute_prerequest (R"JS(
        var missing = [];
        if (typeof btoa !== 'function') missing.push('btoa');
        if (typeof atob !== 'function') missing.push('atob');
        if (typeof pm.crypto !== 'object') missing.push('pm.crypto');
        if (typeof pm.crypto.sha256 !== 'function') missing.push('pm.crypto.sha256');
        if (typeof pm.crypto.hmacSha256 !== 'function') missing.push('pm.crypto.hmacSha256');
        pm.environment.set('missing', missing.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["missing"].value, "")
    << "the signing surface #187 added is incomplete - scripting.md and "
       "pm-api-compatibility.md teach these names";
}

// ============================================================================
// btoa / atob (#187)
// ============================================================================
//
// Known answers, not round-trips: a round-trip passes just as happily over two
// mirrored bugs. The vectors are RFC 4648 §10, which is also what
// encoding_test.cpp checks the C++ helpers against - the point here is that the
// JS boundary hands over the same bytes.

TEST_F (ScriptEngineTest, BtoaMatchesRfc4648Vectors) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('out', [btoa(''), btoa('f'), btoa('fo'), btoa('foo'),
                                   btoa('foob'), btoa('fooba'), btoa('foobar')].join('|'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["out"].value, "|Zg==|Zm8=|Zm9v|Zm9vYg==|Zm9vYmE=|Zm9vYmFy");
}

TEST_F (ScriptEngineTest, AtobDecodesRfc4648VectorsIncludingPadding) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('out', [atob(''), atob('Zg=='), atob('Zm8='), atob('Zm9v'),
                                   atob('Zm9vYg=='), atob('Zm9vYmE='), atob('Zm9vYmFy')].join('|'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["out"].value, "|f|fo|foo|foob|fooba|foobar");
}

TEST_F (ScriptEngineTest, Base64CarriesHighBytesThroughTheJsBoundary) {
    // atob returns a binary string: one code unit per byte, 0x80-0xFF included.
    // This is where a naive "just hand QuickJS the bytes" implementation breaks,
    // because a JS string is not a byte array - 0x80 alone is not valid UTF-8.
    auto result = engine.execute_prerequest (R"JS(
        var s = atob('gP/+AQ==');           // 0x80 0xFF 0xFE 0x01
        var codes = [];
        for (var i = 0; i < s.length; i++) codes.push(s.charCodeAt(i));
        pm.environment.set('codes', codes.join(','));
        pm.environment.set('again', btoa(s));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["codes"].value, "128,255,254,1");
    EXPECT_EQ (env["again"].value, "gP/+AQ==");
}

TEST_F (ScriptEngineTest, BtoaRejectsCharactersAboveLatin1) {
    // Web `btoa` semantics: it encodes code units, so anything above U+00FF is a
    // range error rather than a silent UTF-8 encode. Failing loudly matters here
    // - a signature over quietly-substituted bytes verifies nowhere and gives
    // the author nothing to go on.
    auto result = engine.execute_prerequest (R"JS(
        try {
            btoa('naïve €');
            pm.environment.set('outcome', 'no throw');
        } catch (e) {
            pm.environment.set('outcome', String(e));
        }
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_NE (env["outcome"].value.find ("Latin-1"), std::string::npos)
    << "expected a range error naming Latin-1, got: " << env["outcome"].value;
    // U+00E9 is inside the range and must still encode.
    EXPECT_TRUE (env["outcome"].value.find ("no throw") == std::string::npos);
}

TEST_F (ScriptEngineTest, BtoaEncodesLatin1SupplementCharacters) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('out', btoa('héllo'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    // Latin-1 bytes 68 e9 6c 6c 6f, not the UTF-8 encoding of the same text.
    EXPECT_EQ (env["out"].value, "aOlsbG8=");
}

TEST_F (ScriptEngineTest, AtobThrowsOnMalformedBase64) {
    auto result = engine.execute_prerequest (R"JS(
        var outcomes = [];
        ['Zm9vYmF', 'Zm9$', 'Zg=v', 'Z==='].forEach(function (bad) {
            try { atob(bad); outcomes.push('accepted:' + bad); }
            catch (e) { outcomes.push('threw'); }
        });
        pm.environment.set('outcomes', outcomes.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["outcomes"].value, "threw,threw,threw,threw");
}

// ============================================================================
// pm.crypto (#187)
// ============================================================================

TEST_F (ScriptEngineTest, Sha256MatchesPublishedVectors) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('abc', pm.crypto.sha256('abc'));
        pm.environment.set('empty', pm.crypto.sha256(''));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["abc"].value,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    EXPECT_EQ (env["empty"].value,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

TEST_F (ScriptEngineTest, Sha256HashesTheUtf8BytesOfNonAsciiText) {
    // The one place a hashing API silently disagrees with every other tool: what
    // "the bytes of this string" means. UTF-8, matching what the engine puts on
    // the wire, so a digest computed here equals `printf 'h\xc3\xa9llo' | sha256sum`.
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('out', pm.crypto.sha256('héllo'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["out"].value,
    "3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179");
}

TEST_F (ScriptEngineTest, HmacSha256MatchesRfc4231Vectors) {
    // RFC 4231 cases 2 and 6. Case 6 uses a 131-byte key, which exercises the
    // "hash the key down first" branch of RFC 2104 - the branch a hand-written
    // HMAC most often skips, and the one that stays invisible under short keys.
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('case2',
            pm.crypto.hmacSha256('Jefe', 'what do ya want for nothing?'));

        var longKey = new Uint8Array(131);
        for (var i = 0; i < longKey.length; i++) longKey[i] = 0xaa;
        pm.environment.set('case6', pm.crypto.hmacSha256(
            longKey, 'Test Using Larger Than Block-Size Key - Hash Key First'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["case2"].value, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
    << "RFC 4231 test case 2";
    // The RFC's key is 131 raw 0xaa bytes, which no string can carry: a JS
    // string of U+00AA characters is UTF-8 encoded to 0xc2 0xaa pairs and would
    // hash something else entirely. That is what the Uint8Array input is for.
    EXPECT_EQ (env["case6"].value, "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54")
    << "RFC 4231 test case 6 (key longer than the SHA-256 block)";
}

TEST_F (ScriptEngineTest, DigestEncodingsAgreeOnTheSameDigest) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('hex', pm.crypto.sha256('abc', 'hex'));
        pm.environment.set('b64', pm.crypto.sha256('abc', 'base64'));
        pm.environment.set('b64url', pm.crypto.sha256('abc', 'base64url'));
        var bytes = pm.crypto.sha256('abc', 'bytes');
        pm.environment.set('len', String(bytes.length));
        pm.environment.set('first', String(bytes[0]));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["hex"].value,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    EXPECT_EQ (env["b64"].value, "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
    // base64url differs from base64 in exactly the two substituted characters
    // and the dropped padding.
    EXPECT_EQ (env["b64url"].value, "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    EXPECT_EQ (env["len"].value, "32");
    EXPECT_EQ (env["first"].value, "186"); // 0xba
}

TEST_F (ScriptEngineTest, DigestBytesCanBeFedBackAsAKey) {
    // The reason 'bytes' exists. AWS SigV4 derives its signing key in four HMAC
    // rounds, each keyed by the *raw* digest of the previous one; with only text
    // outputs the chain cannot be expressed at all. Compare against the
    // published SigV4 example key for 20150830/us-east-1/iam.
    auto result = engine.execute_prerequest (R"JS(
        var kDate    = pm.crypto.hmacSha256('AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'bytes');
        var kRegion  = pm.crypto.hmacSha256(kDate, 'us-east-1', 'bytes');
        var kService = pm.crypto.hmacSha256(kRegion, 'iam', 'bytes');
        var kSigning = pm.crypto.hmacSha256(kService, 'aws4_request', 'hex');
        pm.environment.set('kSigning', kSigning);
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["kSigning"].value,
    "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
}

TEST_F (ScriptEngineTest, CryptoRejectsInputItCannotHashHonestly) {
    // Stringifying an object would hash the text "[object Object]" and return a
    // digest that looks perfectly valid. Every one of these must throw.
    auto result = engine.execute_prerequest (R"JS(
        var outcomes = [];
        function attempt(label, fn) {
            try { fn(); outcomes.push('accepted:' + label); }
            catch (e) { outcomes.push('threw:' + label); }
        }
        attempt('object', function () { pm.crypto.sha256({ a: 1 }); });
        attempt('number', function () { pm.crypto.sha256(42); });
        attempt('null', function () { pm.crypto.sha256(null); });
        attempt('missing', function () { pm.crypto.sha256(); });
        attempt('badEncoding', function () { pm.crypto.sha256('abc', 'utf16'); });
        attempt('keyOnly', function () { pm.crypto.hmacSha256('key'); });
        pm.environment.set('outcomes', outcomes.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["outcomes"].value, "threw:object,threw:number,threw:null,threw:missing,threw:badEncoding,threw:keyOnly");
}

TEST_F (ScriptEngineTest, UnknownDigestEncodingNamesTheValidOnes) {
    auto result = engine.execute_prerequest (R"JS(
        try { pm.crypto.sha256('abc', 'utf16'); }
        catch (e) { pm.environment.set('message', String(e)); }
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    const auto& message = env["message"].value;
    EXPECT_NE (message.find ("utf16"), std::string::npos) << message;
    EXPECT_NE (message.find ("base64url"), std::string::npos) << message;
}

TEST_F (ScriptEngineTest, PreRequestScriptSignsTheOutgoingRequest) {
    // #109's write-back and #187's crypto meeting: the headline use case the
    // issue named. The signature is over the canonical string built from
    // pm.request *after* the other edits, which is what scripting.md teaches.
    auto result = engine.execute_prerequest (R"JS(
        var timestamp = '1700000000';
        var canonical = [pm.request.method, pm.request.url, timestamp].join('\n');
        pm.request.headers['X-Timestamp'] = timestamp;
        pm.request.headers['X-Signature'] =
            pm.crypto.hmacSha256(pm.environment.get('api_key'), canonical);
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_TRUE (request.headers.contains ("X-Signature"));
    // HMAC-SHA256("secret123", "GET\nhttps://api.example.com/users\n1700000000").
    EXPECT_EQ (request.headers.at ("X-Signature"),
    "25cba17ca82852d836fc8d44d8efed36cadb53f858a2c81fe88aece44c415ab3");
    EXPECT_EQ (request.headers.at ("X-Timestamp"), "1700000000");
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
        var merged = ['get', 'has', 'toObject', 'replaceIn', 'set'];
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

// pm.variables.replaceIn - the sanctioned way to use {{...}} inside a script
// (script *text* is never interpolated; see D16 in issue #226). Semantics must
// match the engine's compose-time resolver: same precedence, same unknown-name
// rule, same nested resolution, raw stored strings.
TEST_F (ScriptEngineTest, ReplaceInResolvesScopesLikeTheRequestFieldsDo) {
    Environment globals;
    globals["everywhere"] = Variable{ "from-globals", false, true };
    Environment collVars;
    collVars["everywhere"] = Variable{ "from-collection", false, true };
    collVars["nested"]     = Variable{ "{{everywhere}}", false, true };
    collVars["selfRef"]    = Variable{ "{{selfRef}}", false, true };
    Environment environment;
    environment["everywhere"] = Variable{ "from-environment", false, true };
    environment["disabled"]   = Variable{ "hidden", false, false };
    environment["$guid"]      = Variable{ "pinned-guid", false, true };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &environment;
    ctx.globals             = &globals;
    ctx.collectionVariables = &collVars;

    auto result = engine.execute (R"JS(
        pm.globals.set('winner', pm.variables.replaceIn('{{everywhere}}'));
        pm.globals.set('unknownPlain', pm.variables.replaceIn('[{{missing}}]'));
        pm.globals.set('unknownDollar', pm.variables.replaceIn('{{$notAGenerator}}'));
        pm.globals.set('definedDollar', pm.variables.replaceIn('{{$guid}}'));
        pm.globals.set('disabledIsInvisible', pm.variables.replaceIn('[{{disabled}}]'));
        // Nested, like every other {{}} in Vayu since #1009: a value that
        // itself holds {{other}} resolves through it, to the same bound.
        pm.globals.set('nestedResolves', pm.variables.replaceIn('{{nested}}'));
        pm.globals.set('cycleStopsLiteral', pm.variables.replaceIn('{{selfRef}}'));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["winner"].value, "from-environment");
    // Both halves of #1009's unknown-name rule: the token is what a script
    // gets back, so a name nothing defines is visible rather than vanished.
    EXPECT_EQ (globals["unknownPlain"].value, "[{{missing}}]");
    EXPECT_EQ (globals["unknownDollar"].value, "{{$notAGenerator}}");
    EXPECT_EQ (globals["definedDollar"].value, "pinned-guid");
    EXPECT_EQ (globals["disabledIsInvisible"].value, "[{{disabled}}]");
    EXPECT_EQ (globals["nestedResolves"].value, "from-environment");
    EXPECT_EQ (globals["cycleStopsLiteral"].value, "{{selfRef}}");
}

// The identity namespace inside replaceIn (issue #1057). It resolves here for
// one reason: the request beside this script was already bound with these two
// numbers, so a token left written would make the script and the wire disagree
// about one send. Reserved ahead of every scope, exactly as at composition.
TEST_F (ScriptEngineTest, ReplaceInResolvesTheIdentityTheRequestBesideItWasBoundWith) {
    Environment globals;
    Environment environment;
    // A variable someone named `$vu` cannot answer for the identity - the same
    // rule composition holds, and what makes the name bindable at all.
    environment["$vu"] = Variable{ "from-environment", false, true };

    ScriptContext ctx;
    ctx.request     = &request;
    ctx.environment = &environment;
    ctx.globals     = &globals;
    ctx.vu          = 7;
    ctx.iteration   = 3;

    auto result = engine.execute (R"JS(
        pm.globals.set('vu', pm.variables.replaceIn('user-{{$vu}}@example.com'));
        pm.globals.set('iteration', pm.variables.replaceIn('{{$iteration}}'));
        // A `$name` that only looks like the identity follows the
        // unknown-$name rule, here as at composition.
        pm.globals.set('nearMiss', pm.variables.replaceIn('{{$vus}}'));
        // The two APIs answer one question about one send, so they agree.
        pm.globals.set('agreesWithInfo',
            String(pm.variables.replaceIn('{{$vu}}') === String(pm.info.vu)));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["vu"].value, "user-7@example.com");
    EXPECT_EQ (globals["iteration"].value, "3");
    EXPECT_EQ (globals["nearMiss"].value, "{{$vus}}");
    EXPECT_EQ (globals["agreesWithInfo"].value, "true");
}

// The other direction of the same rule: a send that is nobody's iteration
// still binds `1` and `0` into its request (`POST /execute`, issue #994), so
// that is what replaceIn answers. `pm.info` stays absent there, and that is not
// a disagreement - it answers which iteration of which run this is, and there
// is no run.
TEST_F (ScriptEngineTest, ReplaceInAnswersTheRunOfOneWhereNothingSetsTheIdentity) {
    Environment globals;

    ScriptContext ctx;
    ctx.request = &request;
    ctx.globals = &globals;

    auto result = engine.execute (R"JS(
        pm.globals.set('vu', pm.variables.replaceIn('{{$vu}}'));
        pm.globals.set('iteration', pm.variables.replaceIn('{{$iteration}}'));
        pm.globals.set('infoIsAbsent', String(typeof pm.info.vu === 'undefined'));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["vu"].value, "1");
    EXPECT_EQ (globals["iteration"].value, "0");
    EXPECT_EQ (globals["infoIsAbsent"].value, "true");
}

// Both reserved namespaces in one resolution, which is the case the shared
// resolver exists for: a row bound beside the identity, and a column a file
// happens to name `$vu` losing to the reserved name rather than answering for
// it.
TEST_F (ScriptEngineTest, ReplaceInReadsTheIdentityAheadOfABoundRowsColumns) {
    Environment globals;
    const nlohmann::json row = { { "$vu", "from-the-row" }, { "id", "42" } };

    ScriptContext ctx;
    ctx.request        = &request;
    ctx.globals        = &globals;
    ctx.iteration_data = &row;
    ctx.vu             = 2;
    ctx.iteration      = 5;

    auto result = engine.execute (R"JS(
        pm.globals.set('both', pm.variables.replaceIn('{{$vu}}/{{$iteration}}/{{data.id}}/{{id}}'));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["both"].value, "2/5/42/42");
}

// ============================================================================
// The collection chain in a script (issue #234)
//
// `{{name}}` has always walked the whole collection ancestor chain, while the
// script scopes saw the request's immediate parent alone - so the same name,
// and after replaceIn the same *notation*, answered differently in a URL and
// in a script. These pin the walk: reads see the chain, writes stay on the
// leaf.
// ============================================================================

TEST_F (ScriptEngineTest, CollectionReadsWalkTheAncestorChain) {
    // Collections API (root) -> Users (leaf); the request lives in Users.
    std::vector<Environment> ancestors (1);
    ancestors[0]["token"]     = Variable{ "from-root", false, true };
    ancestors[0]["root_only"] = Variable{ "root-value", false, true };
    Environment leaf;
    leaf["leaf_only"] = Variable{ "leaf-value", false, true };
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.globals.set('inherited', String(pm.collectionVariables.get('token')));
        pm.globals.set('hasInherited', String(pm.collectionVariables.has('token')));
        pm.globals.set('ownKey', String(pm.collectionVariables.get('leaf_only')));
        var snapshot = pm.collectionVariables.toObject();
        pm.globals.set('snapshotInherited', String(snapshot['token']));
        pm.globals.set('snapshotOwn', String(snapshot['leaf_only']));
        // The merged accessor and {{}} resolution ride on the same walk.
        pm.globals.set('merged', String(pm.variables.get('root_only')));
        pm.globals.set('replaced', pm.variables.replaceIn('{{token}}'));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["inherited"].value, "from-root");
    EXPECT_EQ (globals["hasInherited"].value, "true");
    EXPECT_EQ (globals["ownKey"].value, "leaf-value");
    EXPECT_EQ (globals["snapshotInherited"].value, "from-root");
    EXPECT_EQ (globals["snapshotOwn"].value, "leaf-value");
    EXPECT_EQ (globals["merged"].value, "root-value");
    // The whole point of the issue: {{token}} in the URL and replaceIn in the
    // script must not answer one name two ways.
    EXPECT_EQ (globals["replaced"].value, "from-root");
}

// Inheritance can be shadowed from below but not deleted from below. `set` on
// the leaf hides the ancestor's value; `unset` removes the leaf's copy and the
// ancestor's shows through again.
TEST_F (ScriptEngineTest, TheLeafShadowsAnAncestorAndUnsetUnShadowsIt) {
    std::vector<Environment> ancestors (1);
    ancestors[0]["token"] = Variable{ "from-root", false, true };
    Environment leaf;
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.globals.set('before', String(pm.collectionVariables.get('token')));
        pm.collectionVariables.set('token', 'from-leaf');
        pm.globals.set('shadowed', String(pm.collectionVariables.get('token')));
        pm.collectionVariables.unset('token');
        pm.globals.set('after', String(pm.collectionVariables.get('token')));
        pm.globals.set('stillThere', String(pm.collectionVariables.has('token')));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["before"].value, "from-root");
    EXPECT_EQ (globals["shadowed"].value, "from-leaf");
    EXPECT_EQ (globals["after"].value, "from-root");
    EXPECT_EQ (globals["stillThere"].value, "true");
    // The write landed on the leaf and the unset took it away again; the
    // ancestor was never a write target.
    EXPECT_EQ (leaf.count ("token"), 0U);
    EXPECT_EQ (ancestors[0]["token"].value, "from-root");
}

// The copy-down hazard #226 kept D2 open for, at the map level: a script that
// reads an inherited name and then writes must leave the leaf map holding its
// own variables only. persist_script_variables writes every name that map
// gained since it was loaded, so anything the walk leaked into it would be
// written into the leaf collection permanently.
TEST_F (ScriptEngineTest, WritingTheCollectionScopeNeverCopiesAnAncestorIntoTheLeaf) {
    std::vector<Environment> ancestors (1);
    ancestors[0]["inherited"] = Variable{ "from-root", false, true };
    Environment leaf;
    leaf["own"] = Variable{ "leaf-value", false, true };
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.globals.set('read', String(pm.collectionVariables.get('inherited')));
        pm.collectionVariables.set('fresh', 'written');
        pm.collectionVariables.unset('missing');
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["read"].value, "from-root");
    EXPECT_EQ (leaf.count ("inherited"), 0U)
    << "an ancestor's variable was copied down into the leaf collection";
    EXPECT_EQ (leaf.size (), 2U); // own + fresh, nothing inherited
    EXPECT_EQ (ancestors[0].size (), 1U);
}

// clear() is the destructive twin of the copy-down: emptying the leaf must not
// reach up the chain, and the inherited names it was hiding come back.
TEST_F (ScriptEngineTest, ClearEmptiesTheLeafAndLeavesAncestorsIntact) {
    std::vector<Environment> ancestors (1);
    ancestors[0]["token"] = Variable{ "from-root", false, true };
    Environment leaf;
    leaf["token"] = Variable{ "from-leaf", false, true };
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.collectionVariables.clear();
        pm.globals.set('after', String(pm.collectionVariables.get('token')));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (leaf.empty ());
    EXPECT_EQ (ancestors[0].size (), 1U) << "clear() reached up the chain";
    EXPECT_EQ (globals["after"].value, "from-root");
}

// Precedence across the whole stack: environment beats any collection, and
// within the collections the nearest definition wins. A disabled row is looked
// past wherever it sits, so unticking a name in the leaf falls through to the
// ancestor rather than hiding it.
TEST_F (ScriptEngineTest, PrecedenceRunsEnvironmentThenLeafThenAncestorThenGlobals) {
    std::vector<Environment> ancestors (2);
    ancestors[0]["depth"]     = Variable{ "root", false, true }; // root
    ancestors[0]["only_root"] = Variable{ "root-only", false, true };
    ancestors[0]["unticked"]  = Variable{ "root-value", false, true };
    ancestors[1]["depth"]     = Variable{ "middle", false, true }; // middle
    Environment leaf;
    leaf["unticked"] = Variable{ "leaf-value", false, false }; // disabled
    Environment globals;
    globals["depth"] = Variable{ "globals", false, true };
    Environment environment;
    environment["everywhere"] = Variable{ "environment", false, true };
    leaf["everywhere"]        = Variable{ "leaf", false, true };

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &environment;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf;
    ctx.collectionAncestors = &ancestors;

    auto result = engine.execute (R"JS(
        pm.globals.set('nearest', String(pm.collectionVariables.get('depth')));
        pm.globals.set('farthest', String(pm.collectionVariables.get('only_root')));
        pm.globals.set('acrossScopes', String(pm.variables.get('everywhere')));
        // The leaf's row is unticked, so the read keeps walking.
        pm.globals.set('unticked', String(pm.collectionVariables.get('unticked')));
        var merged = pm.variables.toObject();
        pm.globals.set('mergedNearest', String(merged['depth']));
        pm.globals.set('mergedAcross', String(merged['everywhere']));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["nearest"].value, "middle");
    EXPECT_EQ (globals["farthest"].value, "root-only");
    EXPECT_EQ (globals["acrossScopes"].value, "environment");
    EXPECT_EQ (globals["unticked"].value, "root-value");
    // The snapshot must agree with get() name for name, or it is a second
    // answer to the same question.
    EXPECT_EQ (globals["mergedNearest"].value, "middle");
    EXPECT_EQ (globals["mergedAcross"].value, "environment");
}

// A run that carries no chain at all - every request outside a nested
// collection - must behave exactly as it did before the walk existed.
TEST_F (ScriptEngineTest, ANullAncestorListReadsAsNoChainRatherThanThrowing) {
    Environment leaf;
    leaf["token"] = Variable{ "from-leaf", false, true };
    Environment globals;

    ScriptContext ctx;
    ctx.request             = &request;
    ctx.environment         = &env;
    ctx.globals             = &globals;
    ctx.collectionVariables = &leaf; // collectionAncestors stays null

    auto result = engine.execute (R"JS(
        pm.globals.set('own', String(pm.collectionVariables.get('token')));
        pm.globals.set('missing', String(pm.collectionVariables.get('nowhere')));
        pm.globals.set('snapshotKeys', String(Object.keys(pm.collectionVariables.toObject()).length));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["own"].value, "from-leaf");
    EXPECT_EQ (globals["missing"].value, "undefined");
    EXPECT_EQ (globals["snapshotKeys"].value, "1");
}

TEST_F (ScriptEngineTest, ReplaceInGeneratesDynamicVariablesPerOccurrence) {
    auto result = engine.execute_prerequest (R"JS(
        var pair = pm.variables.replaceIn('{{$guid}}|{{$guid}}').split('|');
        pm.environment.set('a', pair[0]);
        pm.environment.set('b', pair[1]);
        pm.environment.set('ts', pm.variables.replaceIn('{{$timestamp}}'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    const std::regex uuid_v4 (
    "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    EXPECT_TRUE (std::regex_match (env["a"].value, uuid_v4)) << env["a"].value;
    EXPECT_TRUE (std::regex_match (env["b"].value, uuid_v4)) << env["b"].value;
    // Once per occurrence - two {{$guid}} in one template are two ids.
    EXPECT_NE (env["a"].value, env["b"].value);
    EXPECT_FALSE (env["ts"].value.empty ());
}

// The map is built at call time, so - unlike {{}} in the URL, which was
// composed before the script started (D1) - a value the script itself just
// set resolves. This is the property that makes replaceIn useful for
// building signed payloads mid-script.
TEST_F (ScriptEngineTest, ReplaceInSeesAVariableSetEarlierInTheSameScript) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('minted', 'fresh-value');
        pm.environment.set('resolved', pm.variables.replaceIn('{{minted}}'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["resolved"].value, "fresh-value");
}

TEST_F (ScriptEngineTest, ReplaceInRejectsANonStringArgument) {
    for (const char* bad : { "pm.variables.replaceIn()", "pm.variables.replaceIn(42)",
         "pm.variables.replaceIn(undefined)", "pm.variables.replaceIn({})" }) {
        auto result = engine.execute_prerequest (bad, request, env);
        EXPECT_FALSE (result.success) << bad;
        EXPECT_NE (result.error_message.find ("replaceIn expects a string"), std::string::npos)
        << bad << " -> " << result.error_message;
    }
}

// pm.environment / pm.globals / pm.collectionVariables .replaceIn (#3133):
// Postman resolves against the scope it is called on and nothing else. Every
// scope holds a `shared` name and one of its own, the other scopes and the
// run-local scope hold their own values too, and the template names them all,
// so the answer shows which maps were read: a name only another scope defines
// stays `{{name}}`, a disabled row is invisible, and the collection scope alone
// reads its ancestors.
//
// Mutation-check: leave the binding off `setup_pm_variable_scope` and every
// case throws "not a function"; hand the resolver the merged map instead and
// each scope answers the others' names.
TEST_F (ScriptEngineTest, ScopedReplaceInResolvesFromItsOwnScopeAndNoOther) {
    struct ScopeCase {
        const char* accessor;
        const char* expected;
    };
    const std::array<ScopeCase, 3> cases{ {
    { "environment",
    "from-environment|e1|{{globalsOnly}}|{{collOnly}}|"
    "{{localOnly}}|{{hidden}}|{{ancestorOnly}}" },
    { "globals",
    "from-globals|{{envOnly}}|g1|{{collOnly}}|{{localOnly}}|"
    "{{hidden}}|{{ancestorOnly}}" },
    { "collectionVariables",
    "from-collection|{{envOnly}}|{{globalsOnly}}|"
    "c1|{{localOnly}}|{{hidden}}|from-ancestor" },
    } };

    for (const auto& scope : cases) {
        Environment environment;
        environment["shared"]  = Variable{ "from-environment", false, true };
        environment["envOnly"] = Variable{ "e1", false, true };
        environment["hidden"]  = Variable{ "env-hidden", false, false };
        Environment globals;
        globals["shared"]      = Variable{ "from-globals", false, true };
        globals["globalsOnly"] = Variable{ "g1", false, true };
        globals["hidden"]      = Variable{ "globals-hidden", false, false };
        Environment collVars;
        collVars["shared"]   = Variable{ "from-collection", false, true };
        collVars["collOnly"] = Variable{ "c1", false, true };
        collVars["hidden"]   = Variable{ "coll-hidden", false, false };
        Environment local;
        local["shared"]    = Variable{ "from-local", false, true };
        local["localOnly"] = Variable{ "l1", false, true };
        Environment ancestor;
        ancestor["shared"]       = Variable{ "from-ancestor", false, true };
        ancestor["ancestorOnly"] = Variable{ "from-ancestor", false, true };
        const std::vector<Environment> ancestors{ ancestor };

        ScriptContext ctx;
        ctx.request             = &request;
        ctx.environment         = &environment;
        ctx.globals             = &globals;
        ctx.collectionVariables = &collVars;
        ctx.collectionAncestors = &ancestors;
        ctx.local               = &local;

        auto result =
        engine.execute (std::string ("pm.variables.set('out', pm.") + scope.accessor +
        ".replaceIn('{{shared}}|{{envOnly}}|{{globalsOnly}}|{{collOnly}}|"
        "{{localOnly}}|{{hidden}}|{{ancestorOnly}}'));",
        ctx);

        ASSERT_TRUE (result.success) << scope.accessor << ": " << result.error_message;
        EXPECT_EQ (local["out"].value, scope.expected) << scope.accessor;
    }
}

// What is not a scope answers on a scoped replaceIn exactly as it does on
// pm.variables.replaceIn: the dynamic names, the iteration identity and a bound
// row. The row sits above the scope's own value, and the run-local scope, which
// is a scope of its own, stays out even where it outranks the row on the merged
// path.
TEST_F (ScriptEngineTest, ScopedReplaceInStillAnswersTheNamesThatAreNotScopes) {
    const nlohmann::json row{ { "city", "Portland" }, { "userId", "1001" } };

    for (const char* accessor : { "environment", "globals", "collectionVariables" }) {
        Environment environment;
        Environment globals;
        Environment collVars;
        Environment local;
        local["userId"]         = Variable{ "from-local", false, true };
        Environment* under_test = &collVars;
        if (std::string (accessor) == "environment") {
            under_test = &environment;
        } else if (std::string (accessor) == "globals") {
            under_test = &globals;
        }
        (*under_test)["userId"]    = Variable{ "from-scope", false, true };
        (*under_test)["scopeOnly"] = Variable{ "s1", false, true };

        ScriptContext ctx;
        ctx.request             = &request;
        ctx.environment         = &environment;
        ctx.globals             = &globals;
        ctx.collectionVariables = &collVars;
        ctx.local               = &local;
        ctx.iteration_data      = &row;
        ctx.vu                  = 7;
        ctx.iteration           = 3;

        const std::string call = std::string ("pm.") + accessor + ".replaceIn";
        std::string script = "var pair = " + call + "('{{$guid}}|{{$guid}}').split('|');\n";
        script += "pm.variables.set('first', pair[0]);\n";
        script += "pm.variables.set('second', pair[1]);\n";
        script += "pm.variables.set('rest', " + call;
        script +=
        "('{{$vu}}/{{$iteration}}/{{data.city}}/{{userId}}/{{scopeOnly}}'));";
        auto result = engine.execute (script, ctx);

        ASSERT_TRUE (result.success) << accessor << ": " << result.error_message;
        const std::regex uuid_v4 ("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]"
                                  "[0-9a-f]{3}-[0-9a-f]{12}$");
        EXPECT_TRUE (std::regex_match (local["first"].value, uuid_v4))
        << accessor << ": " << local["first"].value;
        EXPECT_TRUE (std::regex_match (local["second"].value, uuid_v4))
        << accessor << ": " << local["second"].value;
        EXPECT_NE (local["first"].value, local["second"].value) << accessor;
        EXPECT_EQ (local["rest"].value, "7/3/Portland/1001/s1") << accessor;
    }
}

// The refusals name the call the script wrote, not pm.variables.replaceIn.
TEST_F (ScriptEngineTest, ScopedReplaceInRefusesWhatTheMergedOneRefusesUnderItsOwnName) {
    const nlohmann::json row{ { "userId", "1001" } };

    for (const char* accessor : { "environment", "globals", "collectionVariables" }) {
        const std::string call = std::string ("pm.") + accessor + ".replaceIn";

        for (const char* argument : { "", "42", "undefined", "{}" }) {
            auto result =
            engine.execute_prerequest (call + "(" + argument + ")", request, env);
            EXPECT_FALSE (result.success) << call << "(" << argument << ")";
            EXPECT_NE (result.error_message.find (call + " expects a string"),
            std::string::npos)
            << call << "(" << argument << ") -> " << result.error_message;
        }

        ScriptContext ctx;
        ctx.request        = &request;
        ctx.iteration_data = &row;
        auto missing       = engine.execute (call + "('{{data.nosuch}}')", ctx);
        EXPECT_FALSE (missing.success) << call;
        EXPECT_NE (missing.error_message.find (call + ": {{data.nosuch}} names a column"),
        std::string::npos)
        << call << " -> " << missing.error_message;
        EXPECT_NE (missing.error_message.find ("columns: userId"), std::string::npos)
        << call << " -> " << missing.error_message;
    }
}

// pm.variables.set writes the local scope (#2564), never a named one. A context
// that binds no local scope - this convenience entry point binds only the
// environment - still gives the script one for its own duration, so the write
// reads back rather than reporting success and landing nowhere.
TEST_F (ScriptEngineTest, PmVariablesSetWritesTheLocalScopeAndNoNamedOne) {
    env["token"] = Variable{ "from-env", false, true };

    auto result = engine.execute_prerequest (R"JS(
        pm.variables.set('token', 'local');
        pm.environment.set('read', pm.variables.get('token'));
        pm.environment.set('replaced', pm.variables.replaceIn('{{token}}'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["read"].value, "local");
    EXPECT_EQ (env["replaced"].value, "local");
    EXPECT_EQ (env["token"].value, "from-env")
    << "the local write reached the environment";
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

// `pm.response.body` never existed - `setup_pm_response` binds json(), text(),
// reason(), size() and headers, and no `body` property - but scripting.md
// documented it as "Raw body string" for long enough that someone would write
// it and read `undefined` (issue #112). The doc line is gone; this pins the
// contract so a future `body` binding has to be a deliberate change that
// updates the docs with it, rather than quietly making the old line true again.
TEST_F (ScriptEngineTest, ResponseExposesTextNotABodyProperty) {
    response.body = R"({"n":1})";

    auto result = engine.execute_test (R"JS(
        pm.environment.set('bodyType', typeof pm.response.body);
        pm.test("text() is how a script reads the body", function() {
            pm.expect(pm.response.text()).to.equal('{"n":1}');
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (env["bodyType"].value, "undefined");
}

// ============================================================================
// pm.response.cookies (issue #301)
// ============================================================================
//
// Parsing lives in `vayu::http::parse_set_cookie` and is pinned case-by-case
// against the renderer's copy by `set_cookie_test.cpp` and the shared fixture.
// What these tests own is the *script surface*: that the header reaches the
// sandbox at all, in the shape the docs teach, and that a bad call fails loudly
// rather than reading as "no such cookie".

TEST_F (ScriptEngineTest, ResponseCookiesExposeNameValueAndAttributes) {
    response.headers["set-cookie"] =
    "session=dGhpcyBpcyBhIHRlc3Q=; Path=/; HttpOnly, "
    "tracker=t1; Expires=Wed, 21 Oct 2015 07:28:00 GMT";

    auto result = engine.execute_test (R"JS(
        var cookies = pm.response.cookies;
        pm.environment.set('count', String(cookies.length));
        pm.environment.set('names', cookies.map(function (c) { return c.name; }).join(','));
        // The base64 padding survives - a split('=') would have cut it off.
        pm.environment.set('session', String(cookies.get('session')));
        pm.environment.set('attrs', cookies[0].attrs.join('|'));
        // The expiry comma is not a cookie boundary, so tracker keeps its date.
        pm.environment.set('trackerAttrs', cookies[1].attrs.join('|'));
        pm.environment.set('has', String(cookies.has('tracker')));
        pm.environment.set('missing', String(cookies.has('nope')));
        pm.environment.set('absent', String(cookies.get('nope')));
        pm.environment.set('flat', JSON.stringify(cookies.toObject()));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["count"].value, "2");
    EXPECT_EQ (env["names"].value, "session,tracker");
    EXPECT_EQ (env["session"].value, "dGhpcyBpcyBhIHRlc3Q=");
    EXPECT_EQ (env["attrs"].value, "Path=/|HttpOnly");
    EXPECT_EQ (env["trackerAttrs"].value, "Expires=Wed, 21 Oct 2015 07:28:00 GMT");
    EXPECT_EQ (env["has"].value, "true");
    EXPECT_EQ (env["missing"].value, "false");
    EXPECT_EQ (env["absent"].value, "undefined");
    EXPECT_EQ (env["flat"].value, R"({"session":"dGhpcyBpcyBhIHRlc3Q=","tracker":"t1"})");
}

// With the received lines in hand each `Set-Cookie` line is one cookie and a
// comma inside a value is not a boundary (issue #2460); the folded map entry,
// which still holds the comma-joined text, is not consulted. Mutation-check:
// read `headers["set-cookie"]` again in cookies_from_context and the prefs line
// splits in two.
TEST_F (ScriptEngineTest, ResponseCookiesReadEachReceivedSetCookieLine) {
    response.headers["set-cookie"] =
    "a=1; Path=/, b=2; Path=/; HttpOnly, prefs=a=1, theme=dark; Path=/";
    response.header_lines = { { "Content-Type", "text/plain" },
        { "Set-Cookie", "a=1; Path=/" }, { "set-cookie", "b=2; Path=/; HttpOnly" },
        { "SET-COOKIE", "prefs=a=1, theme=dark; Path=/" } };

    auto result = engine.execute_test (R"JS(
        var cookies = pm.response.cookies;
        pm.environment.set('count', String(cookies.length));
        pm.environment.set('names', cookies.map(function (c) { return c.name; }).join(','));
        pm.environment.set('prefs', String(cookies.get('prefs')));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["count"].value, "3");
    EXPECT_EQ (env["names"].value, "a,b,prefs");
    EXPECT_EQ (env["prefs"].value, "a=1, theme=dark");
}

// A response carrying lines but no Set-Cookie among them has no cookies,
// whatever a stale folded entry says.
TEST_F (ScriptEngineTest, ResponseCookiesAreEmptyWhenTheReceivedLinesSetNone) {
    response.headers["set-cookie"] = "stale=1";
    response.header_lines          = { { "Content-Type", "text/plain" } };

    auto result = engine.execute_test (
    "pm.environment.set('count', String(pm.response.cookies.length));", request,
    response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["count"].value, "0");
}

// A response that set nothing still has to answer `.length` and `.get()` -
// `if (pm.response.cookies.has('session'))` is the first line anyone writes,
// and it cannot throw on the common case.
TEST_F (ScriptEngineTest, ResponseCookiesAreAnEmptyListWithoutASetCookieHeader) {
    auto result = engine.execute_test (R"JS(
        pm.environment.set('isArray', String(Array.isArray(pm.response.cookies)));
        pm.environment.set('count', String(pm.response.cookies.length));
        pm.environment.set('has', String(pm.response.cookies.has('session')));
        pm.environment.set('keys', Object.keys(pm.response.cookies.toObject()).join(','));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["isArray"].value, "true");
    EXPECT_EQ (env["count"].value, "0");
    EXPECT_EQ (env["has"].value, "false");
    EXPECT_EQ (env["keys"].value, "");
}

// A response may set the same name twice; a browser keeps the last one, so a
// script asking "what is the session cookie now" has to be told the same.
TEST_F (ScriptEngineTest, ResponseCookiesAnswerTheLastDefinitionOfARepeatedName) {
    response.headers["set-cookie"] = "sid=old; Path=/, sid=new; Path=/";

    auto result = engine.execute_test (R"JS(
        pm.environment.set('get', String(pm.response.cookies.get('sid')));
        pm.environment.set('count', String(pm.response.cookies.length));
        pm.environment.set('flat', JSON.stringify(pm.response.cookies.toObject()));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["get"].value, "new");
    // Both are still listed - the list is what the wire carried.
    EXPECT_EQ (env["count"].value, "2");
    EXPECT_EQ (env["flat"].value, R"({"sid":"new"})");
}

// Cookie names, unlike header names, are case-sensitive. Answering `SESSION`
// with the `session` cookie would be a wrong value dressed as a right one.
TEST_F (ScriptEngineTest, ResponseCookieNamesAreCaseSensitive) {
    response.headers["set-cookie"] = "session=lower";

    auto result = engine.execute_test (R"JS(
        pm.environment.set('exact', String(pm.response.cookies.get('session')));
        pm.environment.set('shouted', String(pm.response.cookies.get('SESSION')));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["exact"].value, "lower");
    EXPECT_EQ (env["shouted"].value, "undefined");
}

// An unusable argument throws instead of reading as "no such cookie" - the
// silent-false-answer defect the pm.* sweep (#180) exists to keep out.
TEST_F (ScriptEngineTest, ResponseCookieLookupRejectsANonStringName) {
    response.headers["set-cookie"] = "session=abc";

    for (const char* call : { "pm.response.cookies.get(1)",
         "pm.response.cookies.has()", "pm.response.cookies.get('')" }) {
        auto result =
        engine.execute_test (std::string (call) + ";", request, response, env);
        EXPECT_FALSE (result.success) << call << " was accepted";
        EXPECT_NE (result.error_message.find ("cookie name"), std::string::npos)
        << call << " threw, but not about the name: " << result.error_message;
    }
}

// The property is a getter that caches, so that a load run's per-request test
// script does not parse a header it never reads. Identity is the observable
// half of that: a fresh array per access would make this false and would
// quietly discard anything a script stashed on the list.
TEST_F (ScriptEngineTest, ResponseCookiesAreTheSameListThroughoutAScript) {
    response.headers["set-cookie"] = "session=abc";

    auto result = engine.execute_test (R"JS(
        pm.environment.set('same', String(pm.response.cookies === pm.response.cookies));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["same"].value, "true");
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
    EXPECT_NE (
    env["detached"].value.find ("must be called on a headers object"), std::string::npos)
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

TEST_F (ScriptEngineTest, HeaderPropertyListReadsWalkTheResponseHeaders) {
    auto result = engine.execute_test (R"JS(
        var seen = [];
        pm.response.headers.each(function (header) { seen.push(header.key + '=' + header.value); });
        pm.environment.set('each', seen.join('|'));
        pm.environment.set('all',
            pm.response.headers.all().map(function (h) { return h.key; }).join(','));
        pm.environment.set('count', String(pm.response.headers.count()));
        pm.environment.set('toObject', JSON.stringify(pm.response.headers.toObject()));
        pm.environment.set('one', JSON.stringify(pm.response.headers.one('CONTENT-TYPE')));
        pm.environment.set('absent', String(pm.response.headers.one('X-Absent')));
        pm.environment.set('indexOf', String(pm.response.headers.indexOf('x-request-id')));
        pm.environment.set('absentIndex', String(pm.response.headers.indexOf('X-Absent')));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["each"].value, "Content-Type=application/json|X-Request-Id=abc123");
    EXPECT_EQ (env["all"].value, "Content-Type,X-Request-Id");
    EXPECT_EQ (env["count"].value, "2");
    EXPECT_EQ (env["toObject"].value,
    R"({"content-type":"application/json","x-request-id":"abc123"})");
    // `one` answers with the header, `get` with its value - and both find it
    // whatever casing they are asked in.
    EXPECT_EQ (env["one"].value, R"({"key":"Content-Type","value":"application/json"})");
    EXPECT_EQ (env["absent"].value, "undefined");
    EXPECT_EQ (env["indexOf"].value, "1");
    EXPECT_EQ (env["absentIndex"].value, "-1");
}

TEST_F (ScriptEngineTest, HeaderPropertyListReadsWalkTheRequestHeaders) {
    // The same six over the object the write-back reads. Asked in the opposite
    // casing to the response test - stored upper, queried lower - so the two
    // together pin the match in both directions rather than one.
    auto result = engine.execute_prerequest (R"JS(
        var seen = [];
        pm.request.headers.each(function (header) { seen.push(header.key + '=' + header.value); });
        pm.environment.set('each', seen.join('|'));
        pm.environment.set('all',
            pm.request.headers.all().map(function (h) { return h.key; }).join(','));
        pm.environment.set('count', String(pm.request.headers.count()));
        pm.environment.set('toObject', JSON.stringify(pm.request.headers.toObject()));
        pm.environment.set('one', JSON.stringify(pm.request.headers.one('authorization')));
        pm.environment.set('absent', String(pm.request.headers.one('X-Absent')));
        pm.environment.set('indexOf', String(pm.request.headers.indexOf('content-type')));
        pm.environment.set('absentIndex', String(pm.request.headers.indexOf('X-Absent')));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["each"].value, "Authorization=Bearer token123|Content-Type=application/json");
    EXPECT_EQ (env["all"].value, "Authorization,Content-Type");
    EXPECT_EQ (env["count"].value, "2");
    EXPECT_EQ (env["toObject"].value,
    R"({"authorization":"Bearer token123","content-type":"application/json"})");
    // The member's key is the spelling the request holds, which is what
    // `upsert` writes through - not the spelling it was asked for.
    EXPECT_EQ (env["one"].value, R"({"key":"Authorization","value":"Bearer token123"})");
    EXPECT_EQ (env["absent"].value, "undefined");
    EXPECT_EQ (env["indexOf"].value, "1");
    EXPECT_EQ (env["absentIndex"].value, "-1");
}

TEST_F (ScriptEngineTest, HeaderToObjectLowerCasesUnlessAskedNotTo) {
    // postman-collection indexes a header list case-insensitively, so its
    // `toObject()` lower-cases every key and only `caseSensitive` keeps the
    // spelling. Copying this object's own keys instead would read as the
    // harmless choice: `pm.request.headers` keeps whatever the user typed, so
    // `toObject()['content-type']` would answer undefined here against a
    // request carrying `Content-Type`, and the value in Postman.
    auto result = engine.execute_test (R"JS(
        pm.environment.set('lowered', pm.request.headers.toObject()['content-type']);
        pm.environment.set('kept',
            JSON.stringify(Object.keys(pm.request.headers.toObject(false, true))));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["lowered"].value, "application/json");
    EXPECT_EQ (env["kept"].value, R"(["Authorization","Content-Type"])");
}

TEST_F (ScriptEngineTest, HeaderEachPassesPostmansArgumentsAndThis) {
    // postman-collection's `each` is `_.forEach(members, iterator.bind(context))`,
    // so the callback is handed the member, its index and the whole list, and
    // the optional second argument becomes its `this`.
    auto result = engine.execute_test (R"JS(
        var shape = [];
        pm.response.headers.each(function (header, index, all) {
            shape.push([index, header.key, all.length, this.tag].join(':'));
        }, { tag: 'bound' });
        pm.environment.set('shape', shape.join('|'));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["shape"].value, "0:Content-Type:2:bound|1:X-Request-Id:2:bound");
}

TEST_F (ScriptEngineTest, HeaderIndexOfTakesAMemberAsWellAsAName) {
    // Postman finds a member by identity in its own list; the members here are
    // built per call, so the object form is matched by its key - which answers
    // the same for a member of this list, and -1 for anything else.
    auto result = engine.execute_test (R"JS(
        pm.environment.set('member',
            String(pm.response.headers.indexOf(pm.response.headers.all()[1])));
        pm.environment.set('foreign',
            String(pm.response.headers.indexOf({ key: 'X-Absent', value: '1' })));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["member"].value, "1");
    EXPECT_EQ (env["foreign"].value, "-1");
}

TEST_F (ScriptEngineTest, HeaderPropertyListReadsRefuseBadInput) {
    auto result = engine.execute_test (R"JS(
        function reason(fn) {
            try { fn(); return 'no throw'; } catch (e) { return String(e.message || e); }
        }
        pm.environment.set('eachNoFn', reason(function () { pm.response.headers.each(); }));
        pm.environment.set('eachNumber', reason(function () { pm.response.headers.each(42); }));
        pm.environment.set('oneNumber', reason(function () { pm.response.headers.one(42); }));
        pm.environment.set('indexNumber', reason(function () { pm.response.headers.indexOf(42); }));
        pm.environment.set('detached', reason(function () {
            var all = pm.response.headers.all;
            all();
        }));
        pm.environment.set('fromCallback', reason(function () {
            pm.response.headers.each(function () { throw new Error('from the callback'); });
        }));
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_NE (env["eachNoFn"].value.find ("needs a function"), std::string::npos)
    << env["eachNoFn"].value;
    EXPECT_NE (env["eachNumber"].value.find ("got number"), std::string::npos)
    << env["eachNumber"].value;
    EXPECT_NE (env["oneNumber"].value.find ("needs a header name string"), std::string::npos)
    << env["oneNumber"].value;
    EXPECT_NE (env["indexNumber"].value.find ("needs a header name string"), std::string::npos)
    << env["indexNumber"].value;
    EXPECT_NE (
    env["detached"].value.find ("must be called on a headers object"), std::string::npos)
    << env["detached"].value;
    // A throw out of the callback is the script's own, reported as it stands
    // rather than wrapped as an `each` failure.
    EXPECT_EQ (env["fromCallback"].value, "from the callback");
}

TEST_F (ScriptEngineTest, PreRequestHeaderEachWalksTheSetItStartedWith) {
    // The member list is built once, so a callback that removes the header it
    // was handed does not shorten the walk under itself.
    auto result = engine.execute_prerequest (R"JS(
        var seen = [];
        pm.request.headers.each(function (header) {
            seen.push(header.key);
            pm.request.headers.remove(header.key);
        });
        pm.environment.set('seen', seen.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["seen"].value, "Authorization,Content-Type");
    EXPECT_TRUE (request.headers.empty ());
}

TEST_F (ScriptEngineTest, PreRequestPropertyListReadsStayOffTheWire) {
    // They are non-enumerable like the first five, so the write-back - which
    // reads own enumerable string properties as the outgoing header set - never
    // sees a header whose value is `each`.
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('count', String(pm.request.headers.count()));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["count"].value, "2");
    ASSERT_EQ (request.headers.size (), 2u);
    EXPECT_TRUE (request.headers.contains ("Authorization"));
    EXPECT_TRUE (request.headers.contains ("Content-Type"));
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

// Concatenating the script source onto a call line: GCC 13 reports the heap
// copy that follows as reading past the small-string buffer. See
// utils/diagnostics.hpp.
VAYU_IGNORE_FALSE_STRING_CONCAT_BOUNDS
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
    const auto cases = std::to_array<Case> ({
    // No query at all.
    { "https://api.example.com/users", "https://api.example.com/users?traceId=t1" },
    // Query present, parameter absent.
    { "https://api.example.com/users?page=2", "https://api.example.com/users?page=2&traceId=t1" },
    // Parameter already present - replaced, not duplicated.
    { "https://api.example.com/users?traceId=old&page=2", "https://api.example.com/users?traceId=t1&page=2" },
    // Fragment is preserved and never searched for the parameter.
    { "https://api.example.com/users#section", "https://api.example.com/users?traceId=t1#section" },
    });

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
VAYU_DIAGNOSTIC_POP

// scripting.md's "Sign a request" example, with the timestamp pinned so the
// signature is reproducible. Until #187 this section taught an FNV-1a checksum
// and said in as many words that a real HMAC was impossible.
TEST_F (ScriptEngineTest, DocExampleSignsWithHmac) {
    env["secret"] = Variable{ "s3cr3t", true, true };

    auto result = engine.execute_prerequest (R"JS(
        var timestamp = '1700000000000';
        var canonical = [
          pm.request.method,
          pm.request.url,
          timestamp,
          pm.request.body || ''
        ].join('\n');

        pm.request.headers['X-Timestamp'] = timestamp;
        pm.request.headers['X-Signature'] =
          pm.crypto.hmacSha256(pm.environment.get('secret'), canonical);
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (request.headers.at ("X-Timestamp"), "1700000000000");
    // HMAC-SHA256("s3cr3t", "GET\nhttps://api.example.com/users\n1700000000000\n").
    EXPECT_EQ (request.headers.at ("X-Signature"),
    "01366dd94b411a4bf53f7785b38f5f1ce16bf2b47dfe8c26de150f475dc61509");
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

// ============================================================================
// pm.info (issue #300)
// ============================================================================

// Identity, not data: what the script is attached to and which hook it is.
// Every field is optional, and "absent" has to mean `undefined` rather than
// an empty string - a script's `typeof` check is the whole point of the
// distinction.
TEST_F (ScriptEngineTest, PmInfoExposesTheFieldsThatWereSet) {
    auto ctx         = ScriptContext::for_test (request, response);
    ctx.environment  = &env;
    ctx.request_id   = "req_42";
    ctx.request_name = "Fetch users";

    auto result = engine.execute (R"JS(
        pm.test("identity", function() {
            pm.expect(pm.info.requestId).to.equal("req_42");
            pm.expect(pm.info.requestName).to.equal("Fetch users");
            pm.expect(pm.info.eventName).to.equal("test");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Asserted per field, not on the object: a single `pm.info === undefined`
// check would pass on an implementation that binds one field and forgets the
// other two.
TEST_F (ScriptEngineTest, PmInfoFieldsAreAbsentRatherThanEmpty) {
    ScriptContext ctx;
    ctx.response = &response;

    auto result = engine.execute (R"JS(
        pm.test("requestId absent", function() {
            pm.expect(typeof pm.info.requestId).to.equal("undefined");
        });
        pm.test("requestName absent", function() {
            pm.expect(typeof pm.info.requestName).to.equal("undefined");
        });
        pm.test("eventName absent", function() {
            pm.expect(typeof pm.info.eventName).to.equal("undefined");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 3);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// An empty name is not a name. Reporting "" would satisfy a `typeof` check
// while telling the script nothing, which is the binding-that-cannot-fail the
// whole field set is designed to avoid.
TEST_F (ScriptEngineTest, PmInfoTreatsAnEmptyNameAsAbsent) {
    auto ctx         = ScriptContext::for_test (request, response);
    ctx.request_id   = "";
    ctx.request_name = "";

    auto result = engine.execute (R"JS(
        pm.test("empty is absent", function() {
            pm.expect(typeof pm.info.requestId).to.equal("undefined");
            pm.expect(typeof pm.info.requestName).to.equal("undefined");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// One case per hook: a single case would pass against an implementation that
// hard-codes either string.
enum class ScriptHook : std::uint8_t { Prerequest, Test };

struct PmInfoEventNameCase {
    std::string_view case_name;
    ScriptHook hook;
    std::string_view expected_event_name;
};

class ScriptEnginePmInfoEventNameTest
: public ScriptEngineTest,
  public ::testing::WithParamInterface<PmInfoEventNameCase> {};

TEST_P (ScriptEnginePmInfoEventNameTest, NamesTheHookItRunsUnder) {
    const auto& param = GetParam ();
    const std::string script =
    "pm.test('hook', function() { pm.expect(pm.info.eventName).to.equal('" +
    std::string (param.expected_event_name) + "'); });";

    auto result = param.hook == ScriptHook::Prerequest ?
    engine.execute_prerequest (script, request, env) :
    engine.execute_test (script, request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

INSTANTIATE_TEST_SUITE_P (PerHook,
ScriptEnginePmInfoEventNameTest,
::testing::Values (PmInfoEventNameCase{ "ExecutePrerequest", ScriptHook::Prerequest, "prerequest" },
PmInfoEventNameCase{ "ExecuteTest", ScriptHook::Test, "test" }),
[] (const ::testing::TestParamInfo<PmInfoEventNameCase>& info) {
    return std::string (info.param.case_name);
});

// QuickJS contexts are pooled and reused, so pm.info has to be rebuilt per
// execution exactly as pm.request and pm.response are. Bind it once at context
// setup instead and this fails: the second script reads the first script's
// request name.
TEST_F (ScriptEngineTest, PmInfoDoesNotSurviveIntoTheNextExecution) {
    auto first         = ScriptContext::for_test (request, response);
    first.request_id   = "req_first";
    first.request_name = "First";
    auto first_result  = engine.execute ("pm.info.requestName;", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second = ScriptContext::for_test (request, response);
    auto result = engine.execute (R"JS(
        pm.test("no leak", function() {
            pm.expect(typeof pm.info.requestId).to.equal("undefined");
            pm.expect(typeof pm.info.requestName).to.equal("undefined");
        });
    )JS",
    second);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Pooled contexts must not carry one script's mutations into the next, which
// may belong to another collection (#1782). Each case leaks a different kind of
// state; the second script asserts all of it is gone.
TEST_F (ScriptEngineTest, AScriptsGlobalsAndPmOverridesDoNotSurviveIntoTheNextExecution) {
    auto first        = ScriptContext::for_test (request, response);
    auto first_result = engine.execute (R"JS(
        globalThis.leak = 1;
        implicitLeak = 2;
        pm.foo = 3;
        pm.test = function () {};
        console.log = function () {};
        String.prototype.leakedMethod = function () {};
        Array.prototype.leakedMethod = function () {};
        Object.prototype.leakedProp = 4;
    )JS",
    first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second = ScriptContext::for_test (request, response);
    auto result = engine.execute (R"JS(
        pm.test("no leak", function() {
            pm.expect(typeof globalThis.leak).to.equal("undefined");
            pm.expect(typeof implicitLeak).to.equal("undefined");
            pm.expect(typeof pm.foo).to.equal("undefined");
            pm.expect(typeof "".leakedMethod).to.equal("undefined");
            pm.expect(typeof [].leakedMethod).to.equal("undefined");
            pm.expect(({}).leakedProp).to.equal(undefined);
            pm.expect(String(console.log).indexOf("native code") >= 0).to.equal(true);
        });
    )JS",
    second);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1) << "pm.test must be the real one again";
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, AScriptThatReplacesPmDoesNotBreakTheNextExecution) {
    auto first        = ScriptContext::for_test (request, response);
    auto first_result = engine.execute ("globalThis.pm = null;", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second = ScriptContext::for_test (request, response);
    auto result = engine.execute (
    R"JS(pm.test("pm is back", function() { pm.expect(pm.response.code).to.equal(200); });)JS",
    second);
    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// A queued promise job pins its context, so a pooled runtime that only freed
// the context kept every one of them (#1823). One engine is one thread's pool.
// Each script claims half the memory limit, so the contexts a leaking runtime
// keeps fail that allocation within a few dozen scripts; without it the leak
// surfaces only as a slowdown, because a failed context rebuild discards the
// runtime instead of reporting anything.
TEST_F (ScriptEngineTest, PromiseJobsLeftBehindDoNotExhaustThePooledRuntime) {
    ScriptConfig cfg;
    cfg.memory_limit = size_t{ 8 } * 1024 * 1024;
    ScriptEngine pooled (cfg);

    constexpr int executions = 2000;
    for (int i = 0; i < executions; ++i) {
        auto ctx    = ScriptContext::for_test (request, response);
        auto result = pooled.execute (R"JS(
            const headroom = new ArrayBuffer(4 * 1024 * 1024);
            Promise.resolve(1).then(function () {});
            pm.test("ran", function () {});
        )JS",
        ctx);
        ASSERT_TRUE (result.success) << "execution " << i << ": " << result.error_message;
        ASSERT_EQ (result.tests.size (), 1u) << "execution " << i;
    }
}

// A drained queue leaves nothing pinning the context, so the runtime goes back
// to the pool; one cut off at the deadline still has jobs and is discarded.
TEST_F (ScriptEngineTest, ADrainedRuntimeIsPooledAgain) {
    ScriptConfig cfg;
    cfg.timeout_ms = 100;
    ScriptEngine pooled (cfg);

    auto drained = ScriptContext::for_test (request, response);
    auto result  = pooled.execute (R"JS(
        (async () => { await null; await null; })();
        Promise.resolve(1).then(function () {});
    )JS",
    drained);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (pooled.idle_runtime_count (), 1U);

    auto cut_off = ScriptContext::for_test (request, response);
    result = pooled.execute ("(async () => { for (;;) { await null; } })();", cut_off);
    ASSERT_FALSE (result.success);
    EXPECT_EQ (pooled.idle_runtime_count (), 0U);
}

// The queue is drained within the script's deadline, never past it: a job
// still queued when the deadline stops the drain is dropped with its runtime,
// because running it in the next execution's drain would be user code past
// its budget against a context whose execution has ended. The loop needs
// 300ms and the budget is 200ms, so a leftover carried into the second
// execution would finish there and set `late`.
TEST_F (ScriptEngineTest, APromiseJobLeftAtTheDeadlineNeverRuns) {
    ScriptConfig cfg;
    cfg.timeout_ms = 200;
    ScriptEngine bounded (cfg);

    auto first        = ScriptContext::for_test (request, response);
    first.environment = &env;
    auto first_result = bounded.execute (R"JS(
        (async () => {
            const until = Date.now() + 300;
            while (Date.now() < until) { await null; }
            pm.environment.set("late", "1");
        })();
    )JS",
    first);
    ASSERT_FALSE (first_result.success);

    auto second        = ScriptContext::for_test (request, response);
    second.environment = &env;
    auto second_result = bounded.execute ("pm.environment.set('next', '1');", second);
    ASSERT_TRUE (second_result.success) << second_result.error_message;

    EXPECT_EQ (env.count ("late"), 0U);
    EXPECT_EQ (env.count ("next"), 1U);
}

// ============================================================================
// Promises: the job queue is drained, and a rejection is a script error (#2531)
// ============================================================================

// postman-sandbox records an async callback's test as passed without awaiting
// it and reports the rejection as a script error; the row stays passed so the
// result reads as Postman's would.
TEST_F (ScriptEngineTest, AnAsyncTestThatRejectsReportsAScriptError) {
    auto result = engine.execute_test (R"JS(
        pm.test("t", async () => { pm.expect(1).to.eql(2); });
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find (R"(Unhandled promise rejection in test "t": )"),
    std::string::npos)
    << result.error_message;
    EXPECT_NE (result.error_message.find ("deeply equal 2"), std::string::npos)
    << result.error_message;
    ASSERT_EQ (result.tests.size (), 1U);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// The assertion after the `await` only runs because the queue is drained.
TEST_F (ScriptEngineTest, AnAsyncTestThatAwaitsThenFailsIsReported) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        pm.test("after await", async () => {
            const code = await Promise.resolve(pm.response.code);
            pm.environment.set("resumed", "1");
            pm.expect(code).to.equal(500);
        });
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find (R"(Unhandled promise rejection in test "after await": )"),
    std::string::npos)
    << result.error_message;
    EXPECT_NE (result.error_message.find ("equal 500"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (env["resumed"].value, "1");
    ASSERT_EQ (result.tests.size (), 1U);
    EXPECT_TRUE (result.tests[0].passed);
}

TEST_F (ScriptEngineTest, AnUnobservedRejectionOutsideATestIsReported) {
    auto result = engine.execute_test (R"JS(
        (async () => { throw new Error("x"); })();
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Unhandled promise rejection: Error: x");
}

// Each rejection the script never observed counts; the first is the one named.
TEST_F (ScriptEngineTest, EveryUnobservedRejectionIsCounted) {
    auto result = engine.execute_test (R"JS(
        Promise.reject(new Error("first"));
        Promise.reject(new Error("second"));
        Promise.reject(new Error("third"));
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Unhandled promise rejection: Error: first (and 2 more unhandled rejections)");
}

// The guard against reporting every rejection: one the script handles, before
// or after it settles, is not an error.
TEST_F (ScriptEngineTest, AHandledRejectionIsNotAnError) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        Promise.reject(new Error("caught")).catch(() => {});
        const later = Promise.reject(new Error("handled later"));
        (async () => {
            await null;
            later.catch(() => {});
            try {
                await Promise.reject(new Error("awaited"));
            } catch (e) {
                pm.environment.set("caught", e.message);
            }
        })();
        pm.test("handles its own", async () => {
            try { await Promise.reject(new Error("inner")); } catch (e) {}
        });
    )JS",
    ctx);

    EXPECT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["caught"].value, "awaited");
    ASSERT_EQ (result.tests.size (), 1U);
    EXPECT_TRUE (result.tests[0].passed);
}

TEST_F (ScriptEngineTest, APassingAsyncTestStaysGreen) {
    auto result = engine.execute_test (R"JS(
        pm.test("green", async () => {
            const code = await Promise.resolve(pm.response.code);
            pm.expect(code).to.equal(200);
        });
    )JS",
    request, response, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1U);
    EXPECT_TRUE (result.tests[0].passed);
}

// Nothing in this sandbox can settle a promise once the script has ended, so a
// test whose promise is still pending after the drain never finished.
TEST_F (ScriptEngineTest, AnAsyncTestThatNeverSettlesIsReported) {
    auto result = engine.execute_test (R"JS(
        pm.test("stuck", async () => { await new Promise(() => {}); });
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message,
    R"(A promise did not settle before the script ended (returned by test "stuck"))");
}

TEST_F (ScriptEngineTest, PendingJobsRunWithinTheDeadline) {
    ScriptConfig cfg;
    cfg.timeout_ms = 100;
    ScriptEngine bounded (cfg);
    auto ctx = ScriptContext::for_test (request, response);

    const auto start = std::chrono::steady_clock::now ();
    auto result =
    bounded.execute ("(async () => { for (;;) { await null; } })();", ctx);
    const auto elapsed = std::chrono::steady_clock::now () - start;

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Script execution timed out after 100ms");
    EXPECT_LT (elapsed, std::chrono::seconds (5));
}

// The interrupt handler polls only every few thousand bytecode operations, so a
// job short enough would slip in after the deadline stopped the script; the
// drain checks the clock before each job so that none does.
TEST_F (ScriptEngineTest, AScriptTheDeadlineStoppedRunsNoneOfItsJobs) {
    ScriptConfig cfg;
    cfg.timeout_ms = 100;
    ScriptEngine bounded (cfg);
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;

    auto result = bounded.execute (R"JS(
        Promise.resolve().then(() => pm.environment.set("late", "1"));
        for (;;) {}
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Script execution timed out after 100ms");
    EXPECT_EQ (env.count ("late"), 0U);
}

// A job that itself runs past the deadline is stopped by the interrupt handler,
// and reported as the same timeout.
TEST_F (ScriptEngineTest, AJobThatSpinsIsStoppedByTheDeadline) {
    ScriptConfig cfg;
    cfg.timeout_ms = 100;
    ScriptEngine bounded (cfg);
    auto ctx = ScriptContext::for_test (request, response);

    auto result =
    bounded.execute ("(async () => { await null; for (;;) {} })();", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Script execution timed out after 100ms");
}

// With no deadline the job cap bounds the drain, with its own message.
TEST_F (ScriptEngineTest, WithNoTimeoutTheJobCapStopsARunawayDrain) {
    ScriptConfig cfg;
    cfg.timeout_ms = 0;
    ScriptEngine unbounded (cfg);
    auto ctx = ScriptContext::for_test (request, response);

    auto result =
    unbounded.execute ("(async () => { for (;;) { await null; } })();", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find (
               "Script stopped after running 100000 promise jobs"),
    std::string::npos)
    << result.error_message;
    EXPECT_EQ (unbounded.idle_runtime_count (), 0U);
}

// A script's own throw is the error it reports, and a job it queued before
// throwing still runs, as it would on Postman's event loop.
TEST_F (ScriptEngineTest, AThrowStaysTheErrorAndItsQueuedJobsStillRun) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        Promise.resolve().then(() => pm.environment.set("ran", "1"));
        Promise.reject(new Error("also unhandled"));
        throw new Error("the script's own");
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Error: the script's own");
    EXPECT_EQ (env["ran"].value, "1");
}

// ============================================================================
// Timers: run to completion before the script ends (#2577)
// ============================================================================

// Due order, ties to the first queued, a missing delay as Node's 1ms, and the
// promise jobs a callback queues before the next timer. The last timer is due
// a minute in, under the default five-second deadline: a queue that slept
// would time out instead of reporting the order.
TEST_F (ScriptEngineTest, TimersFireInDueOrderBeforeTheScriptEnds) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        const order = [];
        setTimeout(() => order.push("b"), 20);
        setTimeout(() => {
            order.push("a");
            Promise.resolve().then(() => order.push("a-job"));
        }, 10);
        setTimeout((x, y) => order.push(x + y), 20, "c", "d");
        setTimeout(() => order.push("no delay"));
        Promise.resolve().then(() => order.push("job"));
        setTimeout(() => pm.environment.set("order", order.join(",")), 60000);
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["order"].value, "job,no delay,a,a-job,b,cd");
}

TEST_F (ScriptEngineTest, ClearTimeoutCancelsATimer) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        const cancelled = setTimeout(() => pm.environment.set("cancelled", "1"), 10);
        clearTimeout(cancelled);
        const later = setTimeout(() => pm.environment.set("later", "1"), 20);
        setTimeout(() => clearTimeout(later), 10);
        clearTimeout(123456);
        clearTimeout();
        clearTimeout("not an id");
        setTimeout(() => pm.environment.set("kept", "1"), 30);
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env.count ("cancelled"), 0U);
    EXPECT_EQ (env.count ("later"), 0U);
    EXPECT_EQ (env["kept"].value, "1");
}

// The interval ticks at 10, 20 and 30 on the virtual clock, so the timeout due
// at 25 lands between the second and third tick; clearing it from its own
// callback stops it.
TEST_F (ScriptEngineTest, SetIntervalRepeatsUntilClearIntervalStopsIt) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        const order = [];
        let ticks = 0;
        const interval = setInterval((tag) => {
            ticks++;
            order.push(tag + ticks);
            if (ticks === 3) clearInterval(interval);
        }, 10, "tick");
        setTimeout(() => order.push("t25"), 25);
        setTimeout(() => pm.environment.set("order", order.join(",")), 1000);
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["order"].value, "tick1,tick2,t25,tick3");
}

TEST_F (ScriptEngineTest, ATimerCanRecordATest) {
    auto result = engine.execute_test (R"JS(
        setTimeout(() => {
            pm.test("from a timer", () => pm.expect(pm.response.code).to.equal(200));
        }, 10);
        setTimeout(() => {
            pm.test("fails from a timer", () => pm.expect(pm.response.code).to.equal(500));
        }, 20);
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 2U);
    EXPECT_EQ (result.tests[0].name, "from a timer");
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (result.tests[1].name, "fails from a timer");
    EXPECT_FALSE (result.tests[1].passed);
}

// A promise only a timer settles is settled by the drain, rather than reported
// as one that never settled.
TEST_F (ScriptEngineTest, AnAwaitedTimerSettlesItsPromise) {
    auto result = engine.execute_test (R"JS(
        pm.test("waits on a timer", async () => {
            const value = await new Promise((resolve) => setTimeout(resolve, 5, 42));
            pm.expect(value).to.equal(42);
        });
    )JS",
    request, response, env);

    EXPECT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1U);
    EXPECT_TRUE (result.tests[0].passed);
}

// A callback's throw is the script's error, and the queue drains on, as a throw
// in the script body already does.
TEST_F (ScriptEngineTest, ATimerThatThrowsIsTheErrorAndTheQueueDrainsOn) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        setTimeout(() => { throw new Error("from the timer"); }, 10);
        setTimeout(() => pm.environment.set("after", "1"), 20);
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Error: from the timer");
    EXPECT_EQ (env["after"].value, "1");
}

TEST_F (ScriptEngineTest, ATimerNeedsAFunction) {
    auto result = engine.execute_test (
    "setTimeout('pm.test(\"x\", () => {})', 0);", request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message,
    "TypeError: setTimeout requires a function as its first argument");
    EXPECT_TRUE (result.tests.empty ());
}

// The queue lives outside the QuickJS heap, so its own cap is what bounds it.
TEST_F (ScriptEngineTest, PendingTimersAreCapped) {
    auto result = engine.execute_test (R"JS(
        for (let i = 0; i <= 10000; i++) setTimeout(() => {}, 1);
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message,
    "RangeError: setTimeout: 10000 timers are already pending, the most one "
    "script may hold");
}

// An interval nothing clears is stopped by the deadline, or by the cap with no
// deadline, and reported. Its queue is freed with the execution, so the
// runtime goes back to the pool; a promise job left behind would discard it.
TEST_F (ScriptEngineTest, ARunawayIntervalStopsWithAScriptError) {
    ScriptConfig bounded_cfg;
    bounded_cfg.timeout_ms = 100;
    ScriptEngine bounded (bounded_cfg);
    auto ctx    = ScriptContext::for_test (request, response);
    auto result = bounded.execute ("setInterval(() => {}, 0);", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Script execution timed out after 100ms");
    EXPECT_EQ (bounded.idle_runtime_count (), 1U);

    ScriptConfig unbounded_cfg;
    unbounded_cfg.timeout_ms = 0;
    ScriptEngine unbounded (unbounded_cfg);
    result = unbounded.execute ("setInterval(() => {}, 0);", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("Script stopped after running 100000 "
                                          "promise jobs and timer callbacks"),
    std::string::npos)
    << result.error_message;
    EXPECT_EQ (unbounded.idle_runtime_count (), 1U);
}

// A timer still queued when the deadline stops the script never runs, in this
// execution or the next one on the same pooled runtime.
TEST_F (ScriptEngineTest, ATimerLeftAtTheDeadlineNeverRuns) {
    ScriptConfig cfg;
    cfg.timeout_ms = 100;
    ScriptEngine bounded (cfg);

    auto first        = ScriptContext::for_test (request, response);
    first.environment = &env;
    auto first_result = bounded.execute (R"JS(
        setTimeout(() => pm.environment.set("late", "1"), 10);
        for (;;) {}
    )JS",
    first);
    EXPECT_FALSE (first_result.success);
    EXPECT_EQ (first_result.error_message, "Script execution timed out after 100ms");
    EXPECT_EQ (bounded.idle_runtime_count (), 1U);

    auto second        = ScriptContext::for_test (request, response);
    second.environment = &env;
    auto second_result = bounded.execute ("pm.environment.set('next', '1');", second);
    ASSERT_TRUE (second_result.success) << second_result.error_message;

    EXPECT_EQ (env.count ("late"), 0U);
    EXPECT_EQ (env.count ("next"), 1U);
}

// A queued timer pins its context as a promise job does (#1823), so a queue
// left at the deadline and never freed would keep every dead context, each
// holding the half of the memory limit its callback reads; the next script's
// own allocation then fails. The 5ms deadline only leaves the timer queued.
TEST_F (ScriptEngineTest, TimersLeftAtTheDeadlineDoNotExhaustThePooledRuntime) {
    ScriptConfig cfg;
    cfg.memory_limit = size_t{ 8 } * 1024 * 1024;
    cfg.timeout_ms   = 5;
    ScriptEngine pooled (cfg);

    constexpr int executions = 50;
    for (int i = 0; i < executions; ++i) {
        auto ctx    = ScriptContext::for_test (request, response);
        auto result = pooled.execute (R"JS(
            const headroom = new ArrayBuffer(4 * 1024 * 1024);
            setTimeout(() => headroom.byteLength, 10);
            for (;;) {}
        )JS",
        ctx);
        ASSERT_EQ (result.error_message, "Script execution timed out after 5ms")
        << "execution " << i;
    }
    EXPECT_EQ (pooled.idle_runtime_count (), 1U);
}

// ============================================================================
// Top-level await: the script body is an async function (#2577)
// ============================================================================

TEST_F (ScriptEngineTest, ATopLevelAwaitOfAResolvedPromiseRuns) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        const value = await Promise.resolve(41);
        pm.environment.set("value", String(value + 1));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["value"].value, "42");
}

TEST_F (ScriptEngineTest, ATestAfterATopLevelAwaitIsRecorded) {
    auto result = engine.execute_test (R"JS(
        const code = await Promise.resolve(pm.response.code);
        pm.test("passes after await", () => pm.expect(code).to.equal(200));
        pm.test("fails after await", () => pm.expect(code).to.equal(500));
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_TRUE (result.error_message.empty ()) << result.error_message;
    ASSERT_EQ (result.tests.size (), 2U);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed);
}

// The body resumes when the timer it awaits fires, between the timers due
// before and after it on the virtual clock.
TEST_F (ScriptEngineTest, ATopLevelAwaitOfATimerResumesWhenItFires) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        const order = [];
        setTimeout(() => order.push("t10"), 10);
        setTimeout(() => order.push("t30"), 30);
        order.push(await new Promise((resolve) => setTimeout(resolve, 20, "t20")));
        setTimeout(() => order.push("t25"), 5);
        await new Promise((resolve) => setTimeout(resolve, 60000));
        pm.environment.set("order", order.join(","));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["order"].value, "t10,t20,t25,t30");
}

// A throw after an `await` is the script's own error, reported as the throw
// itself rather than as the wrapper's unhandled rejection.
TEST_F (ScriptEngineTest, AThrowAfterATopLevelAwaitIsTheScriptsError) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        setTimeout(() => pm.environment.set("drained", "1"), 10);
        await null;
        throw new Error("after await");
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Error: after await");
    EXPECT_EQ (env["drained"].value, "1");

    result = engine.execute_test (
    "await Promise.reject(new Error('awaited rejection'));", request, response, env);
    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Error: awaited rejection");
}

// The first error is the one reported, by when it happened: the body's throw
// and a timer callback's are ordered on the virtual clock.
TEST_F (ScriptEngineTest, ABodyThrowAndATimerThrowAreReportedInTheOrderTheyHappened) {
    auto timer_first = engine.execute_test (R"JS(
        setTimeout(() => { throw new Error("timer at 10"); }, 10);
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("body at 20");
    )JS",
    request, response, env);
    EXPECT_EQ (timer_first.error_message, "Error: timer at 10");

    auto body_first = engine.execute_test (R"JS(
        setTimeout(() => { throw new Error("timer at 20"); }, 20);
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("body at 10");
    )JS",
    request, response, env);
    EXPECT_EQ (body_first.error_message, "Error: body at 10");
}

TEST_F (ScriptEngineTest, ATopLevelReturnStillEndsTheScript) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        pm.environment.set("before", "1");
        if (pm.response.code === 200) return;
        pm.environment.set("after", "1");
    )JS",
    ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["before"].value, "1");
    EXPECT_EQ (env.count ("after"), 0U);

    result = engine.execute (R"JS(
        await null;
        return;
        pm.environment.set("after await", "1");
    )JS",
    ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env.count ("after await"), 0U);
}

// The wrapper's promise rejects on a synchronous throw too; the message stays
// the throw's own, with no "Unhandled promise rejection" in front of it.
TEST_F (ScriptEngineTest, ASynchronousThrowKeepsItsOwnMessage) {
    auto result =
    engine.execute_test ("throw new Error('sync');", request, response, env);
    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "Error: sync");

    result = engine.execute_test ("throw 'a plain string';", request, response, env);
    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "a plain string");
}

// The wrapper adds no line, so a stack names the script's own line.
TEST_F (ScriptEngineTest, AStackNamesTheScriptsOwnLine) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result =
    engine.execute ("// line 1\n"
                    "await null;\n"
                    "pm.environment.set('stack', new Error('x').stack);",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_NE (env["stack"].value.find ("<script>:3:"), std::string::npos)
    << env["stack"].value;
}

// Nothing can settle a promise once the queues are empty, so a body still
// awaiting one never ran its remaining lines, and says so.
TEST_F (ScriptEngineTest, ABodyAwaitingAPromiseThatNeverSettlesIsReported) {
    auto ctx        = ScriptContext::for_test (request, response);
    ctx.environment = &env;
    auto result     = engine.execute (R"JS(
        await new Promise(() => {});
        pm.environment.set("after", "1");
    )JS",
    ctx);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message,
    "The script did not finish: it was still awaiting a promise that never "
    "settled");
    EXPECT_EQ (env.count ("after"), 0U);
}

// What a context that declares neither reports (#353): a bare `for_test` shape,
// which is what an ordinary `POST /execute` send - one carrying no `data` row -
// reaches the engine with. Both read undefined, and that is #300's ruling
// intact: an invented index would be a binding that cannot fail.
//
// More than the scenario runner reports the pair, and this test does not say
// otherwise. A load run's deferred `validate_scripts` sets `iteration` and
// `vu` from the sample the response was actually sent in (#994,
// `run_manager.cpp`), and a send that bound a row reports iteration 0 of 1
// (#601). `iterationCount` is the one that stays absent under load - a
// duration-bounded run has no total.
TEST_F (ScriptEngineTest, PmInfoOmitsTheIterationPairOutsideAScenarioRun) {
    auto result = engine.execute_test (R"JS(
        pm.test("no iteration", function() {
            pm.expect(typeof pm.info.iteration).to.equal("undefined");
            pm.expect(typeof pm.info.iterationCount).to.equal("undefined");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// The other half: a runner-set context reports real numbers, including
// iteration 0 - which must read as 0, not as absent, or every first iteration
// would look like a run that declared none.
TEST_F (ScriptEngineTest, PmInfoReportsTheIterationPairWhenTheRunnerSetsIt) {
    auto ctx            = ScriptContext::for_test (request, response);
    ctx.environment     = &env;
    ctx.iteration       = 0;
    ctx.iteration_count = 5;

    auto result = engine.execute (R"JS(
        pm.test("iteration is bound", function() {
            pm.expect(pm.info.iteration).to.equal(0);
            pm.expect(pm.info.iterationCount).to.equal(5);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Pooled contexts again: a step that ran with an iteration must not leave one
// behind for the next caller that declared none.
TEST_F (ScriptEngineTest, TheIterationPairDoesNotSurviveIntoTheNextExecution) {
    auto first            = ScriptContext::for_test (request, response);
    first.iteration       = 2;
    first.iteration_count = 3;
    auto first_result     = engine.execute ("pm.info.iteration;", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second = ScriptContext::for_test (request, response);
    auto result = engine.execute (R"JS(
        pm.test("no leak", function() {
            pm.expect(typeof pm.info.iteration).to.equal("undefined");
            pm.expect(typeof pm.info.iterationCount).to.equal("undefined");
        });
    )JS",
    second);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// ============================================================================
// pm.execution - flow control (issue #355)
// ============================================================================
//
// The binding records an intent on the ScriptResult and reaches into nothing:
// only the scenario runner knows what a sequence is. These pin the value it
// records and, at least as importantly, every case where the call is refused -
// a binding that cannot fail is worse than a missing one (#188), and
// `setNextRequest("checkout")` quietly ignored in a single send is exactly the
// false success that rule exists to prevent.

/// A pre-request context that declares itself part of a sequence, which is the
/// scenario runner's shape and nothing else's.
static ScriptContext scenario_prerequest (Request& request, Environment& env) {
    ScriptContext ctx = ScriptContext::for_prerequest (request);
    ctx.environment   = &env;
    ctx.in_scenario   = true;
    return ctx;
}

static ScriptContext
scenario_test (const Request& request, const Response& response, Environment& env) {
    ScriptContext ctx = ScriptContext::for_test (request, response);
    ctx.environment   = &env;
    ctx.in_scenario   = true;
    return ctx;
}

TEST_F (ScriptEngineTest, SetNextRequestRecordsTheTargetOnTheResult) {
    auto ctx = scenario_test (request, response, env);
    auto result = engine.execute ("pm.execution.setNextRequest('checkout');", ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::Next);
    EXPECT_EQ (result.control.target, "checkout");
}

TEST_F (ScriptEngineTest, SetNextRequestNullEndsTheIteration) {
    auto ctx    = scenario_test (request, response, env);
    auto result = engine.execute ("pm.execution.setNextRequest(null);", ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::EndIteration);
    EXPECT_TRUE (result.control.target.empty ());
}

// Postman's rule, and the only one that can be right: a script is a sequence of
// statements, so the last thing it said is what it meant.
TEST_F (ScriptEngineTest, TheLastFlowControlCallInAScriptWins) {
    auto ctx    = scenario_test (request, response, env);
    auto result = engine.execute (R"JS(
        pm.execution.setNextRequest('first');
        pm.execution.setNextRequest('second');
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::Next);
    EXPECT_EQ (result.control.target, "second");
}

TEST_F (ScriptEngineTest, SkipRequestRecordsASkipFromAPreRequestScript) {
    auto ctx    = scenario_prerequest (request, env);
    auto result = engine.execute ("pm.execution.skipRequest();", ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::Skip);
}

// The request has already gone out by the time a test script runs, so there is
// nothing left to skip. Recording the intent and refusing it later would let
// the script believe it succeeded for the rest of its body.
TEST_F (ScriptEngineTest, SkipRequestThrowsInATestScript) {
    auto ctx    = scenario_test (request, response, env);
    auto result = engine.execute ("pm.execution.skipRequest();", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("pre-request"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::None);
}

// The single-send contract: `POST /execute` runs exactly this, and it has no
// next request to name and no scenario step to skip.
struct SingleSendExecutionCase {
    std::string_view case_name;
    std::string_view script;
};

class ScriptEngineSingleSendExecutionTest
: public ScriptEngineTest,
  public ::testing::WithParamInterface<SingleSendExecutionCase> {};

TEST_P (ScriptEngineSingleSendExecutionTest, ThrowsInASingleSend) {
    auto result =
    engine.execute_prerequest (std::string (GetParam ().script), request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("not available here"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::None);
}

INSTANTIATE_TEST_SUITE_P (PerExecutionMethod,
ScriptEngineSingleSendExecutionTest,
::testing::Values (SingleSendExecutionCase{ "SetNextRequest", "pm.execution.setNextRequest('checkout');" },
SingleSendExecutionCase{ "SkipRequest", "pm.execution.skipRequest();" }),
[] (const ::testing::TestParamInfo<SingleSendExecutionCase>& info) {
    return std::string (info.param.case_name);
});

// QuickJS formats a thrown error into a fixed-size buffer (`JS_MakeError`,
// vendor/quickjs-ng/quickjs.c) and silently cuts whatever does not fit,
// mid-word - the longest `pm.execution` member name substituted into this
// message used to produce exactly that (issue #1503). Mutation check: widen
// the message text back out and this reds, on the truncated tail rather
// than the missing sentence.
TEST_F (ScriptEngineTest, SetNextRequestsRefusalIsNeverTruncatedMidWord) {
    auto result = engine.execute_prerequest (
    "pm.execution.setNextRequest('checkout');", request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("docs/engine/scripting.md."), std::string::npos)
    << "the message's own last sentence must survive whole: " << result.error_message;
}

// ============================================================================
// pm.metrics - custom trends, counters and rates (issue #1500)
// ============================================================================
//
// Bound the same way pm.execution is: refuse loudly with no run behind it
// (a context built by hand, or the deferred replay against a recorded
// sample) rather than silently recording nowhere.

struct MetricsRecordCase {
    std::string_view case_name;
    std::string_view script;
    std::string_view expected_name;
    vayu::core::CustomMetricType expected_type;
    double expected_value;
};

class ScriptEngineMetricsRecordTest
: public ScriptEngineTest,
  public ::testing::WithParamInterface<MetricsRecordCase> {};

TEST_P (ScriptEngineMetricsRecordTest, RecordsThroughTheBoundCollector) {
    const auto& param = GetParam ();
    std::vector<std::tuple<std::string, vayu::core::CustomMetricType, double>> recorded;
    auto ctx          = scenario_test (request, response, env);
    ctx.record_metric = [&recorded] (const std::string& name,
                        vayu::core::CustomMetricType type, double value) {
        recorded.emplace_back (name, type, value);
    };

    auto result = engine.execute (std::string (param.script), ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (recorded.size (), 1u);
    EXPECT_EQ (std::get<0> (recorded[0]), param.expected_name);
    EXPECT_EQ (std::get<1> (recorded[0]), param.expected_type);
    EXPECT_DOUBLE_EQ (std::get<2> (recorded[0]), param.expected_value);
}

// Counter: the increment defaults to one. Rate: the boolean is recorded as
// one or zero.
INSTANTIATE_TEST_SUITE_P (PerMetricMethod,
ScriptEngineMetricsRecordTest,
::testing::Values (MetricsRecordCase{ "Trend", "pm.metrics.trend('ttfb', 42.5);",
                   "ttfb", vayu::core::CustomMetricType::Trend, 42.5 },
MetricsRecordCase{ "Counter", "pm.metrics.counter('hits');", "hits",
vayu::core::CustomMetricType::Counter, 1.0 },
MetricsRecordCase{ "Rate", "pm.metrics.rate('cacheHit', true);", "cacheHit",
vayu::core::CustomMetricType::Rate, 1.0 }),
[] (const ::testing::TestParamInfo<MetricsRecordCase>& info) {
    return std::string (info.param.case_name);
});

// The false-success rule #188 exists for: with no collector bound, the call
// must throw rather than accept a value and drop it on the floor.
TEST_F (ScriptEngineTest, MetricsThrowsWithNoRunToRecordInto) {
    auto result =
    engine.execute_prerequest ("pm.metrics.trend('ttfb', 1);", request, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("not available here"), std::string::npos)
    << result.error_message;
}

// The deferred `tests` replay's own shape: `for_test` with no `record_metric`
// bound, because a replayed sample is not the run (acceptance criterion 3).
TEST_F (ScriptEngineTest, MetricsThrowsInALoadRunsDeferredTestScript) {
    auto ctx    = ScriptContext::for_test (request, response);
    auto result = engine.execute ("pm.metrics.counter('hits');", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("not available here"), std::string::npos)
    << result.error_message;
}

TEST_F (ScriptEngineTest, MetricsTrendRequiresAName) {
    auto ctx = scenario_test (request, response, env);
    ctx.record_metric = [] (const std::string&, vayu::core::CustomMetricType, double) {};
    auto result = engine.execute ("pm.metrics.trend('', 1);", ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("empty name"), std::string::npos)
    << result.error_message;
}

// A counter only grows (#1937): a negative or non-finite increment throws and
// records nothing. Mutation check: drop the range check in
// `js_pm_metrics_counter` and every case records and succeeds.
class ScriptEngineMetricsCounterRefusalTest
: public ScriptEngineTest,
  public ::testing::WithParamInterface<std::string_view> {};

TEST_P (ScriptEngineMetricsCounterRefusalTest, ThrowsAndRecordsNothing) {
    size_t recorded   = 0;
    auto ctx          = scenario_test (request, response, env);
    ctx.record_metric = [&recorded] (const std::string&,
                        vayu::core::CustomMetricType, double) { ++recorded; };
    auto result       = engine.execute (std::string (GetParam ()), ctx);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("finite increment of 0 or more"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (recorded, 0u);
}

INSTANTIATE_TEST_SUITE_P (NegativeOrNonFinite,
ScriptEngineMetricsCounterRefusalTest,
::testing::Values ("pm.metrics.counter('x', -1);",
"pm.metrics.counter('x', NaN);",
"pm.metrics.counter('x', Infinity);",
"pm.metrics.counter('x', 'not a number');"));

// `increment?` in the declarations: an explicit `undefined` is the default,
// and a zero is a real record (the zero-sum counter a ceiling of 0 watches).
TEST_F (ScriptEngineTest, MetricsCounterTakesUndefinedAsTheDefaultAndRecordsAZero) {
    std::vector<double> recorded;
    auto ctx = scenario_test (request, response, env);
    ctx.record_metric = [&recorded] (const std::string&, vayu::core::CustomMetricType,
                        double value) { recorded.push_back (value); };
    auto result = engine.execute (
    "pm.metrics.counter('x', undefined); pm.metrics.counter('x', 0);", ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (recorded.size (), 2u);
    EXPECT_DOUBLE_EQ (recorded[0], 1.0);
    EXPECT_DOUBLE_EQ (recorded[1], 0.0);
}

// The load-mode contract, and it is a decision rather than an omission: a
// deferred `tests` script has already run against a recorded response and
// cannot redirect a sequence that already happened. `validate_scripts` builds
// exactly this `for_test` shape and sets no `in_scenario`.
TEST_F (ScriptEngineTest, SetNextRequestThrowsInALoadRunsDeferredTestScript) {
    auto result = engine.execute_test (
    "pm.execution.setNextRequest('checkout');", request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("not available here"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::None);
}

// Bound rather than absent, so the sentence above is reachable at all: a
// missing binding answers "not a function", which sends someone hunting a
// typo instead of reading why.
TEST_F (ScriptEngineTest, PmExecutionIsBoundEvenWhereItRefusesEveryCall) {
    auto result = engine.execute_test (R"JS(
        pm.test("both methods exist", function() {
            pm.expect(typeof pm.execution.setNextRequest).to.equal("function");
            pm.expect(typeof pm.execution.skipRequest).to.equal("function");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, SetNextRequestRejectsEveryArgumentThatNamesNothing) {
    struct Case {
        const char* script;
        const char* expected;
    };
    // Omitting the argument is not a synonym for null: "end the iteration" and
    // "I forgot the name" are different intents, and guessing between them
    // would silently end runs.
    const auto cases = std::to_array<Case> ({
    { "pm.execution.setNextRequest();", "no argument" },
    { "pm.execution.setNextRequest(3);", "number" },
    { "pm.execution.setNextRequest(undefined);", "undefined" },
    { "pm.execution.setNextRequest('');", "empty name" },
    });

    for (const auto& test_case : cases) {
        auto ctx    = scenario_test (request, response, env);
        auto result = engine.execute (test_case.script, ctx);
        EXPECT_FALSE (result.success) << test_case.script;
        EXPECT_NE (result.error_message.find (test_case.expected), std::string::npos)
        << test_case.script << " reported: " << result.error_message;
        EXPECT_EQ (result.control.kind, ScriptControl::Kind::None) << test_case.script;
    }
}

// Contexts are pooled, so an instruction has to be per-execution state like
// pm.info is. Hold it on the context instead and the next step of the run
// inherits the previous step's jump.
TEST_F (ScriptEngineTest, AnInstructionDoesNotSurviveIntoTheNextExecution) {
    auto first = scenario_test (request, response, env);
    auto first_result =
    engine.execute ("pm.execution.setNextRequest('checkout');", first);
    ASSERT_EQ (first_result.control.kind, ScriptControl::Kind::Next);

    auto second        = scenario_test (request, response, env);
    auto second_result = engine.execute ("1 + 1;", second);
    ASSERT_TRUE (second_result.success) << second_result.error_message;
    EXPECT_EQ (second_result.control.kind, ScriptControl::Kind::None);
    EXPECT_TRUE (second_result.control.target.empty ());
}

// ============================================================================
// pm.iterationData - the data row bound to this iteration (issue #356)
// ============================================================================
//
// The read surface is `get` and `toObject`, the writers refuse, and absence is
// `undefined` rather than an empty scope. That last one is the decision worth
// pinning: unlike pm.execution, this is data, and a script that asks "is this
// run data-driven?" can only get an answer if the binding is missing when
// there is no row.

/// A scenario step's test context, bound to @p row - the shape the runner
/// builds, and the only shape that carries a row at all.
static ScriptContext data_test (const Request& request,
const Response& response,
Environment& env,
const nlohmann::json& row) {
    ScriptContext ctx  = ScriptContext::for_test (request, response);
    ctx.environment    = &env;
    ctx.in_scenario    = true;
    ctx.iteration_data = &row;
    return ctx;
}

TEST_F (ScriptEngineTest, IterationDataGetReadsTheBoundRow) {
    const nlohmann::json row{ { "username", "ada" }, { "attempts", 3 }, { "active", true },
        { "profile", { { "city", "London" } } }, { "nickname", nullptr } };
    auto ctx = data_test (request, response, env, row);

    auto result = engine.execute (R"JS(
        pm.test("row reads back", function() {
            pm.expect(pm.iterationData.get("username")).to.equal("ada");
            // Types survive the binding: a CSV column the app typed as a
            // number must not arrive as the string "3".
            pm.expect(pm.iterationData.get("attempts")).to.equal(3);
            pm.expect(pm.iterationData.get("active")).to.equal(true);
            pm.expect(pm.iterationData.get("profile").city).to.equal("London");
            pm.expect(pm.iterationData.get("nickname")).to.equal(null);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// The same answer every other pm scope reader gives, so a script that guards
// on a column need not learn a new idiom for this one.
TEST_F (ScriptEngineTest, IterationDataGetOnAnUnknownKeyIsUndefined) {
    const nlohmann::json row{ { "username", "ada" } };
    auto ctx = data_test (request, response, env, row);

    auto result = engine.execute (R"JS(
        pm.test("unknown key", function() {
            pm.expect(typeof pm.iterationData.get("missing")).to.equal("undefined");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

/**
 * `pm.variables.replaceIn` resolves the data namespace too (issue #890), and
 * every `pm.variables` reader answers a bound row's bare column names (#1007).
 *
 * replaceIn did not resolve the namespace at first, and that made it the one
 * template resolver in the product that disagreed with the others about what
 * `{{data.column}}` means. A URL, a header and a body all bind it; handing the
 * same string to replaceIn returned it verbatim, so the script had to know
 * which resolver it was talking to. The token came back with its braces on,
 * which reads as "unresolved variable" - the same output an unknown `$name`
 * gives - so nothing said the row was available and simply not consulted.
 *
 * The bare half is #1007's, and it *did* extend `get` / `has` / `toObject`:
 * Postman binds a dataset's columns to bare names, so an imported collection's
 * `pm.variables.get("userId")` means this iteration's row, at the tier Postman
 * puts it - above the environment. The prefixed spelling stays disjoint from
 * the scopes either way: `data.userId` is template syntax, never a variable
 * name, so the readers still answer nothing for it and `pm.iterationData`
 * remains the accessor that reads only the row.
 *
 * Mutation-check: drop the row from the resolver and the first case fails; take
 * the row layer out of `pm.variables` and the last two do; let the scopes
 * answer before the row and the shadowing case does.
 */
TEST_F (ScriptEngineTest, ReplaceInResolvesTheDataNamespaceAgainstTheBoundRow) {
    const nlohmann::json row{ { "userId", "1001" }, { "city", "Portland, OR" },
        { "quantity", 3 }, { "active", true } };
    auto ctx      = data_test (request, response, env, row);
    env["userId"] = { "an-environment-variable", true };
    // A name no column answers, so the fallback half of the rule has something
    // to fall back *to*.
    env["token"] = { "an-environment-token", true };

    auto result = engine.execute (R"JS(
        pm.test("a column resolves", function() {
            pm.expect(pm.variables.replaceIn("user {{data.userId}}")).to.equal("user 1001");
            pm.expect(pm.variables.replaceIn("{{data.city}}")).to.equal("Portland, OR");
        });

        pm.test("a non-string cell substitutes its text", function() {
            // The same rule the request binding uses (`render_data_value`): the
            // template holds text, so the value is spelled the way it would be
            // spelled into a URL - not the typed value pm.iterationData gives.
            pm.expect(pm.variables.replaceIn("{{data.quantity}}")).to.equal("3");
            pm.expect(pm.variables.replaceIn("{{data.active}}")).to.equal("true");
        });

        pm.test("a bound row answers the bare name, above the environment", function() {
            // Postman's precedence, adopted by #1007: while a row is bound, a
            // column shadows a same-named environment variable, which is what
            // makes an imported data-driven collection send this iteration's
            // value instead of a stale one.
            pm.expect(pm.variables.replaceIn("{{userId}}")).to.equal("1001");
            // The reserved spelling still names only the column (#402) - the
            // two rules coexist rather than one replacing the other.
            pm.expect(pm.variables.replaceIn("{{data.userId}}")).to.equal("1001");
            // And a bare name the row does not carry is an ordinary variable,
            // which is what lets one script run with and without a data file.
            pm.expect(pm.variables.replaceIn("{{token}}")).to.equal("an-environment-token");
        });

        pm.test("the bare prefix names nothing", function() {
            // `{{data.}}` is not a column reference, so it falls through to the
            // ordinary unknown-name rule rather than erroring about a column
            // called "" - and that rule leaves the token written as it stands
            // (issue #1009), which is what a script gets back.
            pm.expect(pm.variables.replaceIn("[{{data.}}]")).to.equal("[{{data.}}]");
        });

        pm.test("the scope readers stay out of the namespace", function() {
            // `data.userId` is template syntax, not a variable name: the merged
            // readers answer nothing for it however a row is bound, and
            // `pm.iterationData` is the accessor that reads only the row.
            pm.expect(typeof pm.variables.get("data.userId")).to.equal("undefined");
            pm.expect(pm.variables.has("data.userId")).to.equal(false);
            pm.expect(typeof pm.variables.toObject()["data.userId"]).to.equal("undefined");
            // The row is genuinely bound - otherwise this case would pass for
            // the wrong reason.
            pm.expect(pm.iterationData.get("userId")).to.equal("1001");
        });

        pm.test("the scope readers answer the bare column, typed", function() {
            // The merged reader's top tier (issue #1007), and typed the way
            // pm.iterationData types it: a number column is a number through
            // either accessor, where the template spelling renders text.
            pm.expect(pm.variables.get("userId")).to.equal("1001");
            pm.expect(pm.variables.get("quantity")).to.equal(3);
            pm.expect(pm.variables.has("userId")).to.equal(true);
            pm.expect(pm.variables.toObject()["userId"]).to.equal("1001");
            pm.expect(pm.variables.toObject()["quantity"]).to.equal(3);
            // The fallback, so this is a tier rather than a replacement.
            pm.expect(pm.variables.get("token")).to.equal("an-environment-token");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 6u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

/**
 * A column the row does not carry is an error, the same as it is at bind time.
 *
 * Not "" and not the token verbatim: the token says the value came from the
 * file, so a name the file has no column for is a mistake about the column, and
 * both quiet answers hide it. This is the rule `apply_iteration_template` already
 * enforces on a URL - a script asking the same question gets the same answer.
 */
TEST_F (ScriptEngineTest, ReplaceInThrowsForAColumnTheRowDoesNotCarry) {
    const nlohmann::json row{ { "userId", "1001" } };
    auto ctx = data_test (request, response, env, row);

    auto result = engine.execute (R"JS(
        pm.test("names the column and what the row has", function() {
            let message = "nothing thrown";
            try {
                pm.variables.replaceIn("{{data.nosuch}}");
            } catch (e) {
                message = String(e.message || e);
            }
            pm.expect(message).to.include("data.nosuch");
            pm.expect(message).to.include("userId");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

/**
 * With no row bound there is nothing to resolve against, so the token keeps its
 * braces - unchanged from before the fix, and the same thing composition does.
 *
 * Throwing here would be wrong: a plain design send has no row by design, and a
 * shared script that guards with `pm.iterationData` must be able to run in both
 * modes. The token surviving is what a run's plan resolution then refuses by
 * name (issue #415), which is the layer that owns "this needed a data set".
 */
TEST_F (ScriptEngineTest, ReplaceInLeavesADataTokenWrittenWhenNoRowIsBound) {
    ScriptContext ctx = ScriptContext::for_test (request, response);
    ctx.environment   = &env;

    auto result = engine.execute (R"JS(
        pm.test("token survives", function() {
            pm.expect(pm.variables.replaceIn("user {{data.userId}}"))
                .to.equal("user {{data.userId}}");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// `has` exists for parity with every other scope reader in the pm surface
// (pm.environment, pm.globals, pm.collectionVariables, pm.variables, pm.cookies)
// and with Postman, whose pm.iterationData is a VariableScope. The case it is
// the only clean answer to is the null column: the row *has* it, which is a
// different fact from the row not carrying it at all.
TEST_F (ScriptEngineTest, IterationDataHasAnswersPresenceIncludingANullColumn) {
    const nlohmann::json row{ { "username", "ada" }, { "nickname", nullptr } };
    auto ctx = data_test (request, response, env, row);

    auto result = engine.execute (R"JS(
        pm.test("presence", function() {
            pm.expect(pm.iterationData.has("username")).to.equal(true);
            pm.expect(pm.iterationData.has("missing")).to.equal(false);
            // Present and null: `has` says the row carries it, and `get`
            // answers null rather than the undefined an absent column gives -
            // so the two agree and neither has to be read as the other.
            pm.expect(pm.iterationData.has("nickname")).to.equal(true);
            pm.expect(pm.iterationData.get("nickname")).to.equal(null);
            pm.expect(typeof pm.iterationData.get("missing")).to.equal("undefined");
            // No argument is no such column, the answer pm.variables.has gives.
            pm.expect(pm.iterationData.has()).to.equal(false);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// A reference stashed on the global is gone with the context (#1782), so a later
// script can no more call it than read the row it pointed at.
TEST_F (ScriptEngineTest, AStashedIterationDataDoesNotReachTheNextScript) {
    const nlohmann::json row{ { "username", "ada" } };
    auto first = data_test (request, response, env, row);
    auto first_result =
    engine.execute ("globalThis.stashed = pm.iterationData;", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second_result = engine.execute_test (
    "pm.test('stash is gone', function() { pm.expect(typeof "
    "globalThis.stashed).to.equal('undefined'); });",
    request, response, env);

    ASSERT_TRUE (second_result.success) << second_result.error_message;
    ASSERT_EQ (second_result.tests.size (), 1u);
    EXPECT_TRUE (second_result.tests[0].passed) << second_result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, IterationDataToObjectReturnsTheWholeRow) {
    const nlohmann::json row{ { "username", "ada" }, { "attempts", 3 } };
    auto ctx = data_test (request, response, env, row);

    auto result = engine.execute (R"JS(
        pm.test("whole row", function() {
            var all = pm.iterationData.toObject();
            pm.expect(Object.keys(all).length).to.equal(2);
            pm.expect(all.username).to.equal("ada");
            pm.expect(all.attempts).to.equal(3);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// A write has no destination - the rows are a run input, not a scope - so the
// call throws rather than accepting a value that would vanish at the next
// iteration. Bound and refusing, for the reason pm.execution is.
TEST_F (ScriptEngineTest, IterationDataRefusesEveryWrite) {
    const nlohmann::json row{ { "username", "ada" } };

    for (const char* script : { "pm.iterationData.set('username', 'bob');",
         "pm.iterationData.unset('username');", "pm.iterationData.clear();" }) {
        auto ctx    = data_test (request, response, env, row);
        auto result = engine.execute (script, ctx);

        EXPECT_FALSE (result.success) << script;
        EXPECT_NE (result.error_message.find ("read-only"), std::string::npos)
        << script << " reported: " << result.error_message;
    }

    // And the row itself is untouched by the attempt.
    EXPECT_EQ (row.at ("username"), "ada");
}

// The #300 boundary, unchanged: a single send has no iteration and therefore
// no row. `undefined` and not an empty scope - a script may branch on it.
TEST_F (ScriptEngineTest, IterationDataIsUndefinedInASingleSend) {
    auto result = engine.execute_prerequest (R"JS(
        pm.test("no data", function() {
            pm.expect(typeof pm.iterationData).to.equal("undefined");
        });
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// The load-mode contract: `validate_scripts` builds exactly this `for_test`
// shape and binds no row, because a deferred script runs after the run against
// a sampled response and there is no iteration it belongs to.
TEST_F (ScriptEngineTest, IterationDataIsUndefinedInALoadRunsDeferredTestScript) {
    auto result = engine.execute_test (R"JS(
        pm.test("no data", function() {
            pm.expect(typeof pm.iterationData).to.equal("undefined");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Contexts are pooled and the global object survives with them, so the binding
// has to be rebuilt per execution the way pm.info is. Leave the previous
// step's object standing and a single send reads the last collection run's
// data - a row from a run that has finished, reported as this request's.
TEST_F (ScriptEngineTest, ARowDoesNotSurviveIntoTheNextExecution) {
    const nlohmann::json row{ { "username", "ada" } };
    auto first = data_test (request, response, env, row);
    auto first_result = engine.execute ("pm.iterationData.get('username');", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second_result = engine.execute_test (R"JS(
        pm.test("no data", function() {
            pm.expect(typeof pm.iterationData).to.equal("undefined");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (second_result.success) << second_result.error_message;
    ASSERT_EQ (second_result.tests.size (), 1u);
    EXPECT_TRUE (second_result.tests[0].passed) << second_result.tests[0].error_message;
}

// ============================================================================
// pm.response.events - a streamed run's buffered event list (issue #575)
// ============================================================================
//
// The three properties are one fact about one arrival set, and the decision
// worth pinning is the same one `pm.iterationData` makes: absence is *absent*.
// A script asking "was this a stream?" can only get an answer if the binding is
// missing when it was not one, and a script asserting over the whole stream can
// only be right if the markers say when it is looking at a prefix.

/// A streamed run's test context: the stored `events` trace node the route
/// hands the post-request script, verbatim.
static ScriptContext streamed_test (const Request& request,
const Response& response,
Environment& env,
const nlohmann::json& events) {
    ScriptContext ctx   = ScriptContext::for_test (request, response);
    ctx.environment     = &env;
    ctx.response_events = &events;
    return ctx;
}

TEST_F (ScriptEngineTest, ResponseEventsCarriesEachEntrysNameIdAndData) {
    const nlohmann::json events{
        { "items",
        nlohmann::json::array ({ nlohmann::json{ { "event", "tick" }, { "data", "{\"n\":1}" },
                                 { "sourceId", "e1" }, { "receivedAt", 17 } },
        nlohmann::json{ { "event", "message" }, { "data", "plain" }, { "receivedAt", 18 } } }) },
        { "totalEvents", 2 }, { "eventsTruncated", false }, { "endReason", "completed" }
    };
    auto ctx = streamed_test (request, response, env, events);

    auto result = engine.execute (R"JS(
        pm.test("entries read back", function() {
            pm.expect(pm.response.events.length).to.equal(2);
            pm.expect(pm.response.events[0].event).to.equal("tick");
            pm.expect(pm.response.events[0].id).to.equal("e1");
            pm.expect(JSON.parse(pm.response.events[0].data).n).to.equal(1);
            pm.expect(pm.response.events[1].event).to.equal("message");
            pm.expect(pm.response.events[1].data).to.equal("plain");
        });
        pm.test("an event the origin never named has no id at all", function() {
            pm.expect(typeof pm.response.events[1].id).to.equal("undefined");
        });
        pm.test("the markers mirror the node", function() {
            pm.expect(pm.response.totalEvents).to.equal(2);
            pm.expect(pm.response.eventsTruncated).to.equal(false);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 3u);
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// The whole point of the markers: a stored list shorter than the stream must
// never read as the stream. Truncation is the node's own comparison, not
// `items.length` against a cap the script cannot see.
TEST_F (ScriptEngineTest, ResponseEventsReportsATruncatedListAsOne) {
    const nlohmann::json events{
        { "items",
        nlohmann::json::array ({ nlohmann::json{ { "event", "tick" }, { "data", "1" } } }) },
        { "totalEvents", 40 }, { "eventsTruncated", true }, { "endReason", "maxEvents" }
    };
    auto ctx = streamed_test (request, response, env, events);

    auto result = engine.execute (R"JS(
        pm.test("a prefix says it is one", function() {
            pm.expect(pm.response.events.length).to.equal(1);
            pm.expect(pm.response.totalEvents).to.equal(40);
            pm.expect(pm.response.eventsTruncated).to.equal(true);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// An event whose data hit the per-event byte cap is a prefix of what the origin
// sent, and says so in band - the same disclosure the stored node makes.
TEST_F (ScriptEngineTest, ResponseEventsDisclosesAPerEventTruncation) {
    const nlohmann::json events{
        { "items",
        nlohmann::json::array ({ nlohmann::json{ { "event", "big" }, { "data", "abc" },
                                 { "dataTruncated", true }, { "dataBytes", 9000 } },
        nlohmann::json{ { "event", "small" }, { "data", "ok" } } }) },
        { "totalEvents", 2 }, { "eventsTruncated", false }
    };
    auto ctx = streamed_test (request, response, env, events);

    auto result = engine.execute (R"JS(
        pm.test("a cut event is flagged and a whole one is not", function() {
            pm.expect(pm.response.events[0].dataTruncated).to.equal(true);
            pm.expect(typeof pm.response.events[1].dataTruncated).to.equal("undefined");
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Absent, not empty. An ordinary send binds none of the three, so `typeof`
// separates "this was not a stream" from "this stream produced nothing" - the
// distinction an empty array would erase.
TEST_F (ScriptEngineTest, AnOrdinaryResponseBindsNoEventSurface) {
    auto result = engine.execute_test (R"JS(
        pm.test("no event surface", function() {
            pm.expect(typeof pm.response.events).to.equal("undefined");
            pm.expect(typeof pm.response.totalEvents).to.equal("undefined");
            pm.expect(typeof pm.response.eventsTruncated).to.equal("undefined");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// A stream that produced nothing is the other side of that: the surface is
// there and empty, which is what lets a script tell the two apart.
TEST_F (ScriptEngineTest, AStreamThatProducedNothingBindsAnEmptyList) {
    const nlohmann::json events{ { "items", nlohmann::json::array () },
        { "totalEvents", 0 }, { "eventsTruncated", false }, { "endReason", "idle" } };
    auto ctx = streamed_test (request, response, env, events);

    auto result = engine.execute (R"JS(
        pm.test("empty but present", function() {
            pm.expect(typeof pm.response.events).to.equal("object");
            pm.expect(pm.response.events.length).to.equal(0);
            pm.expect(pm.response.totalEvents).to.equal(0);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Contexts are pooled, so the object a script stashed survives into the next
// execution. A non-streaming run after a streamed one must not still be
// carrying the stream's list - the leak `pm.iterationData` had.
TEST_F (ScriptEngineTest, ThePooledContextDoesNotCarryEventsIntoTheNextRun) {
    const nlohmann::json events{ { "items",
                                 nlohmann::json::array ({ nlohmann::json{
                                 { "event", "tick" }, { "data", "1" } } }) },
        { "totalEvents", 1 }, { "eventsTruncated", false } };
    auto first        = streamed_test (request, response, env, events);
    auto first_result = engine.execute ("pm.response.events.length;", first);
    ASSERT_TRUE (first_result.success) << first_result.error_message;

    auto second_result = engine.execute_test (R"JS(
        pm.test("the next run is not a stream", function() {
            pm.expect(typeof pm.response.events).to.equal("undefined");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (second_result.success) << second_result.error_message;
    ASSERT_EQ (second_result.tests.size (), 1u);
    EXPECT_TRUE (second_result.tests[0].passed) << second_result.tests[0].error_message;
}

// ============================================================================
// The legacy `postman` object (#2577)
// ============================================================================
//
// Each method is an alias of the `pm.*` member Postman names as its
// replacement. The scripts are Postman's own legacy snippets, verbatim.

TEST_F (ScriptEngineTest, LegacyShimSetEnvironmentVariableIsReadByPmEnvironment) {
    auto result = engine.execute_test (R"JS(
        postman.setEnvironmentVariable("variable_key", "variable_value");
        pm.environment.set("pm_key", "pm_value");
        pm.test("each spelling reads the other's write", function () {
            pm.expect(pm.environment.get("variable_key")).to.equal("variable_value");
            pm.expect(postman.getEnvironmentVariable("pm_key")).to.equal("pm_value");
            pm.expect(postman.getEnvironmentVariable("api_key")).to.equal("secret123");
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (env["variable_key"].value, "variable_value");
}

TEST_F (ScriptEngineTest, LegacyShimClearsTheEnvironment) {
    auto result = engine.execute_test (R"JS(
        postman.clearEnvironmentVariable("api_key");
    )JS",
    request, response, env);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_FALSE (env.contains ("api_key"));
    EXPECT_TRUE (env.contains ("base_url"));

    result = engine.execute_test (
    "postman.clearEnvironmentVariables();", request, response, env);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (env.empty ());
}

TEST_F (ScriptEngineTest, LegacyShimReachesTheGlobals) {
    Environment globals;
    globals["old"]    = Variable{ "1", false, true };
    globals["kept"]   = Variable{ "2", false, true };
    ScriptContext ctx = ScriptContext::for_test (request, response);
    ctx.environment   = &env;
    ctx.globals       = &globals;

    auto result = engine.execute (R"JS(
        postman.setGlobalVariable("variable_key", "variable_value");
        postman.clearGlobalVariable("old");
        pm.globals.set("pm_key", "pm_value");
        pm.test("each spelling reads the other's write", function () {
            pm.expect(pm.globals.get("variable_key")).to.equal("variable_value");
            pm.expect(postman.getGlobalVariable("pm_key")).to.equal("pm_value");
            pm.expect(pm.globals.has("old")).to.equal(false);
        });
    )JS",
    ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (globals["variable_key"].value, "variable_value");
    EXPECT_FALSE (env.contains ("variable_key"))
    << "a global landed in the environment";

    result = engine.execute ("postman.clearGlobalVariables();", ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (globals.empty ());
}

// Postman's legacy setters store `value.toString()` for a truthy value that has
// one, where `pm.environment.set` keeps the value: a number set the legacy way
// reads back as the string, and a falsy value passes through as it is.
TEST_F (ScriptEngineTest, LegacyShimSettersStoreTheStringPostmanStores) {
    auto result = engine.execute_test (R"JS(
        postman.setEnvironmentVariable("count", 5);
        postman.setEnvironmentVariable("object", { a: 1 });
        postman.setEnvironmentVariable("list", [1, 2]);
        postman.setEnvironmentVariable("off", false);
        postman.setEnvironmentVariable("zero", 0);
        postman.setGlobalVariable("count", 7);
        pm.environment.set("pm_count", 5);
        pm.test("stored as Postman's legacy call stores it", function () {
            pm.expect(pm.environment.get("count")).to.equal("5");
            pm.expect(pm.environment.get("object")).to.equal("[object Object]");
            pm.expect(pm.environment.get("list")).to.equal("1,2");
            pm.expect(pm.environment.get("off")).to.equal(false);
            pm.expect(pm.environment.get("zero")).to.equal(0);
            pm.expect(pm.environment.get("pm_count")).to.equal(5);
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (env["count"].value, "5");
    EXPECT_EQ (env["object"].value, "[object Object]");
}

// The value's own `toString` is what Postman calls, so its throw is the
// script's error rather than a silently stored "[object Object]".
TEST_F (ScriptEngineTest, LegacyShimSetterReportsAThrowingToString) {
    auto result = engine.execute_test (R"JS(
        postman.setEnvironmentVariable("bad", { toString: function () { throw new Error("no text"); } });
    )JS",
    request, response, env);
    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("no text"), std::string::npos)
    << result.error_message;
    EXPECT_FALSE (env.contains ("bad"));
}

// The targets are read when `postman` is built, so a script that reassigns
// `pm` does not redirect the legacy calls: postman-sandbox's legacy object
// talks to the execution, not to the `pm` global.
TEST_F (ScriptEngineTest, LegacyShimDoesNotFollowAReassignedPm) {
    auto result = engine.execute_test (R"JS(
        pm = undefined;
        postman.setEnvironmentVariable("variable_key", "variable_value");
    )JS",
    request, response, env);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["variable_key"].value, "variable_value");
}

TEST_F (ScriptEngineTest, LegacyShimSetNextRequestRecordsTheTarget) {
    auto ctx = scenario_test (request, response, env);
    auto result = engine.execute (R"JS(postman.setNextRequest("request_name");)JS", ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::Next);
    EXPECT_EQ (result.control.target, "request_name");

    result = engine.execute ("postman.setNextRequest(null);", ctx);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::EndIteration);
}

// The alias keeps pm.execution's rule: outside a collection run there is no
// next request, and the call says so rather than being quietly dropped.
TEST_F (ScriptEngineTest, LegacyShimSetNextRequestIsRefusedInASingleSend) {
    auto result = engine.execute_test (
    R"JS(postman.setNextRequest("request_name");)JS", request, response, env);
    EXPECT_FALSE (result.success);
    EXPECT_NE (
    result.error_message.find ("setNextRequest is not available here"), std::string::npos)
    << result.error_message;
    EXPECT_EQ (result.control.kind, ScriptControl::Kind::None);
}

TEST_F (ScriptEngineTest, LegacyShimGetResponseHeaderReadsTheResponse) {
    auto result = engine.execute_test (R"JS(
        pm.test("Content-Type is present", function () {
            pm.expect(postman.getResponseHeader("Content-Type")).to.equal("application/json");
            pm.expect(postman.getResponseHeader("x-request-id")).to.equal("abc123");
            pm.expect(postman.getResponseHeader("X-Absent")).to.equal(undefined);
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Postman's `cookies.one(name)`: the whole cookie, so `.value` reads it.
TEST_F (ScriptEngineTest, LegacyShimGetResponseCookieReadsTheCookie) {
    vayu::http::JarCookie cookie;
    cookie.name   = "session";
    cookie.value  = "abc123";
    cookie.domain = "api.example.com";
    cookie.path   = "/";
    const std::vector<std::string> lines{ vayu::http::format_cookie_line (cookie) };
    ScriptContext ctx     = ScriptContext::for_test (request, response);
    ctx.environment       = &env;
    ctx.cookie_read_lines = &lines;

    auto result = engine.execute (R"JS(
        pm.test("the cookie, not just its value", function () {
            const cookie = postman.getResponseCookie("session");
            pm.expect(cookie.value).to.equal("abc123");
            pm.expect(cookie.name).to.equal("session");
            pm.expect(cookie.value).to.equal(pm.cookies.get("session"));
            pm.expect(postman.getResponseCookie("absent")).to.equal(undefined);
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Postman binds the two response readers only where there is a response, so a
// pre-request script has the other nine and not these.
TEST_F (ScriptEngineTest, LegacyShimHasNoResponseReadersBeforeTheResponse) {
    auto pre = engine.execute_prerequest (R"JS(
        if (typeof postman.getResponseHeader !== "undefined") throw new Error("header reader");
        if (typeof postman.getResponseCookie !== "undefined") throw new Error("cookie reader");
        postman.setEnvironmentVariable("variable_key", "variable_value");
    )JS",
    request, env);
    ASSERT_TRUE (pre.success) << pre.error_message;
    EXPECT_EQ (env["variable_key"].value, "variable_value");

    auto test = engine.execute_test (R"JS(
        if (typeof postman.getResponseHeader !== "function") throw new Error("header reader");
        if (typeof postman.getResponseCookie !== "function") throw new Error("cookie reader");
    )JS",
    request, response, env);
    ASSERT_TRUE (test.success) << test.error_message;
}

// ============================================================================
// Postman's legacy globals (#2577)
// ============================================================================
//
// The values postman-sandbox's legacy interface binds beside `postman`, each
// read off the `pm` member Postman names as its replacement. The scripts are
// Postman's own legacy snippets, verbatim, where Postman has one.

TEST_F (ScriptEngineTest, LegacyTestsAssignmentRecordsAPassingNamedTest) {
    auto result = engine.execute_test (R"JS(tests["Status code is 200"] = responseCode.code === 200;)JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_EQ (result.tests[0].name, "Status code is 200");
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Postman's wording for a falsy entry, raised as an AssertionError the way a
// failed pm.expect reads.
TEST_F (ScriptEngineTest, LegacyTestsAssignmentRecordsAFailingTest) {
    auto result = engine.execute_test (R"JS(tests["Status code is 201"] = responseCode.code === 201;)JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_EQ (result.tests[0].name, "Status code is 201");
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_EQ (result.tests[0].error_message, "AssertionError: expected false to be truthy");
}

// Postman reads the object once the script has finished and appends a row per
// key after the pm.test rows: so a key assigned twice is one row with its last
// value, rows keep the object's key order, and the truthiness is JavaScript's.
TEST_F (ScriptEngineTest, LegacyTestsAreReadOnceInKeyOrderAfterThePmTests) {
    auto result = engine.execute_test (R"JS(
        tests["first"] = false;
        pm.test("a pm.test", function () {});
        tests["second"] = 0;
        tests["first"] = "yes";
        tests["third"] = { any: "object" };
    )JS",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 4u);
    EXPECT_EQ (result.tests[0].name, "a pm.test");
    EXPECT_EQ (result.tests[1].name, "first");
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
    EXPECT_EQ (result.tests[2].name, "second");
    EXPECT_FALSE (result.tests[2].passed);
    EXPECT_EQ (result.tests[2].error_message, "AssertionError: expected 0 to be truthy");
    EXPECT_EQ (result.tests[3].name, "third");
    EXPECT_TRUE (result.tests[3].passed);
}

// What a script assigned before it threw was assigned, so it is recorded, as
// Postman records it; the throw stays the script's error.
TEST_F (ScriptEngineTest, LegacyTestsAssignedBeforeAThrowAreRecorded) {
    auto result = engine.execute_test (R"JS(
        tests["Body is read"] = responseBody.length > 0;
        throw new Error("after the assignment");
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_NE (result.error_message.find ("after the assignment"), std::string::npos)
    << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, LegacyResponseBodyIsTheResponseText) {
    auto result = engine.execute_test (R"JS(
        var jsonData = JSON.parse(responseBody);
        tests["Your test name"] = jsonData.name === "John Doe";
        tests["Body matches string"] = responseBody.indexOf("john@example.com") !== -1;
        tests["Same as pm.response.text()"] = responseBody === pm.response.text();
    )JS",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 3u) << result.error_message;
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

TEST_F (ScriptEngineTest, LegacyResponseCodeIsPostmansDetails) {
    response.status_code = 404;
    response.status_text = "Gone Fishing";
    auto result          = engine.execute_test (R"JS(
        pm.test("responseCode", function () {
            pm.expect(responseCode.code).to.equal(404);
            pm.expect(responseCode.name).to.equal("Gone Fishing");
            pm.expect(responseCode.standardName).to.equal("Not Found");
            pm.expect(responseCode.detail).to.equal("");
            pm.expect(Object.keys(responseCode)).to.eql(["name", "detail", "code", "standardName"]);
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// Postman keys the object by each name as it arrived, so the lookup is
// case-sensitive, and the last line of a repeated name wins.
TEST_F (ScriptEngineTest, LegacyResponseHeadersKeepTheNamesAsTheyArrived) {
    response.header_lines = { { "Content-Type", "application/json" },
        { "X-Repeat", "first" }, { "X-Repeat", "last" } };
    auto result           = engine.execute_test (R"JS(
        tests["Content-Type is present"] = responseHeaders.hasOwnProperty("Content-Type");
        tests["the last repeat"] = responseHeaders["X-Repeat"] === "last";
        tests["case-sensitive"] = responseHeaders["content-type"] === undefined;
    )JS",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 3u) << result.error_message;
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// A load run's sampled response keeps the folded map and no lines, and that is
// what the object is built from there.
TEST_F (ScriptEngineTest, LegacyResponseHeadersFallBackToTheFoldedMap) {
    ASSERT_TRUE (response.header_lines.empty ());
    auto result = engine.execute_test (R"JS(
        tests["from the map"] = responseHeaders["X-Request-Id"] === "abc123";
    )JS",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1u) << result.error_message;
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, LegacyResponseTimeIsPmResponseResponseTime) {
    auto result = engine.execute_test (R"JS(
        tests["Response time is less than 200ms"] = responseTime < 200;
        tests["the same number"] = responseTime === pm.response.responseTime;
    )JS",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2u) << result.error_message;
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

TEST_F (ScriptEngineTest, LegacyResponseCookiesAreTheJarsCookies) {
    vayu::http::JarCookie cookie;
    cookie.name   = "session";
    cookie.value  = "abc123";
    cookie.domain = "api.example.com";
    cookie.path   = "/";
    const std::vector<std::string> lines{ vayu::http::format_cookie_line (cookie) };
    ScriptContext ctx     = ScriptContext::for_test (request, response);
    ctx.environment       = &env;
    ctx.cookie_read_lines = &lines;

    auto result = engine.execute (R"JS(
        tests["one cookie"] = responseCookies.length === 1;
        tests["its value"] = responseCookies[0].value === "abc123";
        tests["read once"] = responseCookies === responseCookies;
        tests["found by name"] = responseCookies.find(c => c.name === "session") !== undefined;
    )JS",
    ctx);

    ASSERT_EQ (result.tests.size (), 4u) << result.error_message;
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

// Where there is no jar, reading the cookies says why, as pm.cookies does,
// rather than answering a list that looks empty. Assigning the name is still an
// ordinary write.
TEST_F (ScriptEngineTest, LegacyResponseCookiesRefuseWhereThereIsNoJar) {
    auto read = engine.execute_test ("var c = responseCookies;", request, response, env);
    EXPECT_FALSE (read.success);
    EXPECT_NE (read.error_message.find ("not available here"), std::string::npos)
    << read.error_message;

    auto assigned = engine.execute_test (R"JS(
        responseCookies = [];
        tests["assigned"] = responseCookies.length === 0;
    )JS",
    request, response, env);
    ASSERT_TRUE (assigned.success) << assigned.error_message;
    ASSERT_EQ (assigned.tests.size (), 1u);
    EXPECT_TRUE (assigned.tests[0].passed);
}

// `environment` and `globals` are snapshots taken when the script starts: a
// write to one changes no variable and pm.*.set does not update it, while the
// legacy setters write through to it, as postman-sandbox's do.
TEST_F (ScriptEngineTest, LegacyEnvironmentIsASnapshotTheLegacySettersWriteThrough) {
    Environment globals;
    globals["region"] = Variable{ "eu", false, true };
    ScriptContext ctx = ScriptContext::for_test (request, response);
    ctx.environment   = &env;
    ctx.globals       = &globals;

    auto result = engine.execute (R"JS(
        pm.test("snapshots", function () {
            pm.expect(environment.api_key).to.equal("secret123");
            pm.expect(globals.region).to.equal("eu");

            pm.environment.set("pm_written", "x");
            pm.expect(environment.pm_written).to.equal(undefined);

            postman.setEnvironmentVariable("legacy_written", 5);
            pm.expect(environment.legacy_written).to.equal("5");
            postman.clearEnvironmentVariable("api_key");
            pm.expect(environment).to.not.have.property("api_key");

            postman.setGlobalVariable("g", "1");
            pm.expect(globals.g).to.equal("1");
            postman.clearGlobalVariables();
            pm.expect(Object.keys(globals)).to.eql([]);

            environment.assigned = "nowhere";
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_FALSE (env.contains ("assigned"))
    << "a write to the snapshot set a variable";
    EXPECT_EQ (env["legacy_written"].value, "5");
    EXPECT_FALSE (env.contains ("api_key"));
    EXPECT_TRUE (globals.empty ());

    result = engine.execute (R"JS(
        postman.clearEnvironmentVariables();
        tests["cleared"] = Object.keys(environment).length === 0;
    )JS",
    ctx);
    ASSERT_EQ (result.tests.size (), 1u) << result.error_message;
    EXPECT_TRUE (result.tests[0].passed);
}

TEST_F (ScriptEngineTest, LegacyDataAndIterationReadTheRun) {
    const nlohmann::json row = { { "name", "Ada" }, { "count", 3 } };
    ScriptContext ctx        = ScriptContext::for_test (request, response);
    ctx.environment          = &env;
    ctx.iteration_data       = &row;
    ctx.iteration            = 2;

    auto result = engine.execute (R"JS(
        tests["data"] = data.name === "Ada" && data.count === 3;
        tests["iteration"] = iteration === 2;
    )JS",
    ctx);
    ASSERT_EQ (result.tests.size (), 2u) << result.error_message;
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }

    // An ordinary send: no row, and no run to count, as Postman's `{}` and 0.
    result = engine.execute_test (R"JS(
        tests["no row"] = typeof data === "object" && Object.keys(data).length === 0;
        tests["no pass"] = iteration === 0;
    )JS",
    request, response, env);
    ASSERT_EQ (result.tests.size (), 2u) << result.error_message;
    for (const auto& test : result.tests) {
        EXPECT_TRUE (test.passed) << test.name << ": " << test.error_message;
    }
}

TEST_F (ScriptEngineTest, LegacyRequestIsPostmansLegacyShape) {
    request.method = HttpMethod::POST;
    request.headers.add ("X-Repeat", "one");
    request.headers.add ("X-Repeat", "two");
    request.body.mode   = BodyMode::Form;
    request.body.fields = { { "user", "ada" }, { "tag", "a" }, { "tag", "b" },
        { "off", "x", false } };
    ScriptContext ctx   = ScriptContext::for_prerequest (request);
    ctx.environment     = &env;
    ctx.request_id      = "req_1";
    ctx.request_name    = "Sign in";

    auto result = engine.execute (R"JS(
        pm.test("request", function () {
            pm.expect(request.url).to.equal("https://api.example.com/users");
            pm.expect(request.method).to.equal("POST");
            pm.expect(request.id).to.equal("req_1");
            pm.expect(request.name).to.equal("Sign in");
            pm.expect(request.headers["content-type"]).to.equal("application/json");
            pm.expect(request.headers["x-repeat"]).to.eql(["one", "two"]);
            pm.expect(request.data).to.eql({ user: "ada", tag: ["a", "b"] });
        });
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

TEST_F (ScriptEngineTest, LegacyRequestDataIsATextBodyOrNothing) {
    request.body.mode    = BodyMode::Json;
    request.body.content = R"({"a":1})";
    auto result          = engine.execute_test (
    R"JS(tests["text"] = request.data === '{"a":1}';)JS", request, response, env);
    ASSERT_EQ (result.tests.size (), 1u) << result.error_message;
    EXPECT_TRUE (result.tests[0].passed);

    request.body = Body{};
    result = engine.execute_test (R"JS(tests["none"] = Object.keys(request.data).length === 0;)JS",
    request, response, env);
    ASSERT_EQ (result.tests.size (), 1u) << result.error_message;
    EXPECT_TRUE (result.tests[0].passed);
}

// Postman binds the response values only where there is a response; the rest
// are in every script.
TEST_F (ScriptEngineTest, LegacyResponseGlobalsAreAbsentBeforeTheResponse) {
    auto pre = engine.execute_prerequest (R"JS(
        for (const name of ["responseBody", "responseCode", "responseHeaders",
                            "responseTime", "responseCookies"]) {
            if (name in globalThis) throw new Error(name + " is bound");
        }
        for (const name of ["tests", "environment", "globals", "data", "iteration", "request"]) {
            if (!(name in globalThis)) throw new Error(name + " is not bound");
        }
        tests["pre-request rows count too"] = true;
    )JS",
    request, env);
    ASSERT_TRUE (pre.success) << pre.error_message;
    ASSERT_EQ (pre.tests.size (), 1u);
    EXPECT_TRUE (pre.tests[0].passed);
}

// The engine runs a script inside a function, so a script that declares one of
// these names itself gets its own variable, and one that assigns one without
// declaring it writes the global, as a sloppy-mode script does in Postman.
TEST_F (ScriptEngineTest, AScriptThatDeclaresALegacyNameItselfKeepsItsOwn) {
    auto result = engine.execute_test (R"JS(
        const data = pm.response.json();
        let responseBody = "mine";
        var request = { url: "mine" };
        const environment = pm.environment.toObject();
        pm.test("its own values", function () {
            pm.expect(data.id).to.equal(1);
            pm.expect(responseBody).to.equal("mine");
            pm.expect(request.url).to.equal("mine");
            pm.expect(environment.api_key).to.equal("secret123");
        });
    )JS",
    request, response, env);
    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;

    // Its own `tests` is an ordinary array, and records nothing.
    result = engine.execute_test (
    "var tests = []; tests.push(false);", request, response, env);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_TRUE (result.tests.empty ());

    result = engine.execute_test (R"JS(
        data = JSON.parse(responseBody);
        tests["assigned"] = data.id === 1;
    )JS",
    request, response, env);
    ASSERT_EQ (result.tests.size (), 1u) << result.error_message;
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

// ============================================================================
// pm.visualizer (#2577)
// ============================================================================
//
// Accepted and not drawn: before this, `pm.visualizer.set` read a member of
// undefined, and the script ended there with its remaining tests unrun.

namespace {

/// The console lines at Warn level, in order.
std::vector<std::string> warnings_of (const vayu::ScriptResult& result) {
    std::vector<std::string> out;
    for (const auto& entry : result.console_output) {
        if (entry.level == vayu::ConsoleLevel::Warn) {
            out.push_back (entry.message);
        }
    }
    return out;
}

} // namespace

// Postman's own snippet: the call is accepted, warns once, and the pm.test
// after it still runs and passes.
TEST_F (ScriptEngineTest, VisualizerSetDoesNotAbortTheScriptAndWarns) {
    auto result = engine.execute_test (R"JS(
        pm.visualizer.set("<p>{{name}}</p>", {name: "x"});
        pm.test("runs after the visualizer", function () {
            pm.expect(pm.response.code).to.equal(200);
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_EQ (result.tests[0].name, "runs after the visualizer");
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    const auto warnings = warnings_of (result);
    ASSERT_EQ (warnings.size (), 1u);
    EXPECT_NE (warnings[0].find ("visualizer not rendered"), std::string::npos)
    << warnings[0];
}

// Postman's three-argument form, the options object its documentation shows,
// and a template alone: all accepted, one warning each.
TEST_F (ScriptEngineTest, VisualizerSetAcceptsPostmansArgumentShapes) {
    auto result = engine.execute_test (R"JS(
        pm.visualizer.set("<p>a</p>");
        pm.visualizer.set("<p>{{x}}</p>", pm.response.json());
        pm.visualizer.set("<p>{{x}}</p>", { x: [1, 2] }, { helpers: {}, noEscape: true });
        pm.visualizer.set("<p></p>", undefined, undefined);
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (warnings_of (result).size (), 4u);
}

// The visualizer's warning goes through the same console bound as `console.*`
// (#3134): lines already at the cap leave no room for it.
TEST_F (ScriptEngineTest, VisualizerWarningRespectsTheConsoleEntryCap) {
    const auto result = engine.execute_test ("for (let i = 0; i < " +
    std::to_string (console_limits::CONSOLE_MAX_ENTRIES) +
    "; i++) console.log ('line ' + i);"
    "pm.visualizer.clear ();"
    "pm.visualizer.clear ();",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.console_output.size (), console_limits::CONSOLE_MAX_ENTRIES + 1);
    EXPECT_TRUE (is_console_limit_marker (result.console_output.back ()));
    EXPECT_EQ (console_limit_markers (result), 1u);
    EXPECT_EQ (warnings_of (result).size (), 1u);
}

TEST_F (ScriptEngineTest, VisualizerClearDoesNotThrowAndWarns) {
    auto result = engine.execute_test (R"JS(
        pm.visualizer.clear();
        pm.test("runs after clear", function () {});
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed);
    const auto warnings = warnings_of (result);
    ASSERT_EQ (warnings.size (), 1u);
    EXPECT_NE (warnings[0].find ("visualizer not rendered"), std::string::npos)
    << warnings[0];
}

// A template that is not a string is a script bug, refused by name as the
// other pm calls refuse a bad argument, and records no warning for a call that
// did not happen.
TEST_F (ScriptEngineTest, VisualizerSetRefusesATemplateThatIsNotAString) {
    for (const char* call : { "pm.visualizer.set();", "pm.visualizer.set(42, {});",
         "pm.visualizer.set({ html: '<p></p>' });", "pm.visualizer.set(null);" }) {
        auto result = engine.execute_test (call, request, response, env);
        EXPECT_FALSE (result.success) << call;
        EXPECT_NE (result.error_message.find ("pm.visualizer.set"), std::string::npos)
        << call << ": " << result.error_message;
        EXPECT_TRUE (warnings_of (result).empty ()) << call;
    }
}

// A pre-request script has no response and still meets the call.
TEST_F (ScriptEngineTest, VisualizerIsAvailableInAPreRequestScript) {
    auto result = engine.execute_prerequest (
    "pm.visualizer.set('<p></p>', {}); pm.visualizer.clear();", request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (warnings_of (result).size (), 2u);
}

// ============================================================================
// require() and its shelf (#2578)
// ============================================================================
//
// Known answers, as for pm.crypto: FIPS 180's "abc" for each digest, the empty
// string's MD5, and RFC 2202 / RFC 4231 test case 2 (key "Jefe") for each
// HMAC.

namespace {

constexpr const char* JEFE_MESSAGE = "what do ya want for nothing?";

struct ShelfAnswer {
    const char* expression;
    const char* expected;
};

/// What @p expression, run as a pre-request script, stringifies to; the
/// script's error when it throws.
std::string shelf_answer (ScriptEngine& engine, Request& request, const std::string& expression) {
    Environment env;
    const auto result = engine.execute_prerequest ("var JEFE = '" +
    std::string (JEFE_MESSAGE) + "'; pm.environment.set('out', String(" + expression + "));",
    request, env);
    return result.success ? env["out"].value : "threw: " + result.error_message;
}

using vayu::tests::library_call_config;

} // namespace

// The acceptance case: Postman's signing call, through require.
TEST_F (ScriptEngineTest, RequireShelfHmacSha256MatchesTheReferenceDigest) {
    auto result = engine.execute_prerequest (R"JS(
        var CryptoJS = require('crypto-js');
        var signature = CryptoJS.HmacSHA256('what do ya want for nothing?', 'Jefe');
        pm.environment.set('signature', signature.toString(CryptoJS.enc.Hex));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["signature"].value,
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
}

TEST_F (ScriptEngineTest, RequireShelfDigestsMatchKnownVectors) {
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "CryptoJS.MD5('')", "d41d8cd98f00b204e9800998ecf8427e" },
    { "CryptoJS.SHA1('abc')", "a9993e364706816aba3e25717850c26c9cd0d89d" },
    { "CryptoJS.SHA224('abc')", "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7" },
    { "CryptoJS.SHA256('abc')", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    { "CryptoJS.SHA384('abc')",
    "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072"
    "ba1e7cc2358baeca134c825a7" },
    { "CryptoJS.SHA512('abc')",
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992"
    "a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f" },
    { "CryptoJS.HmacMD5(JEFE, 'Jefe')", "750c783e6ab0b503eaa86e310a5db738" },
    { "CryptoJS.HmacSHA1(JEFE, 'Jefe')", "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79" },
    { "CryptoJS.HmacSHA224(JEFE, 'Jefe')", "a30e01098bc6dbbf45690f3a7e9e6d0f8bbea2a39e6148008fd05e44" },
    { "CryptoJS.HmacSHA256(JEFE, 'Jefe')", "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843" },
    { "CryptoJS.HmacSHA384(JEFE, 'Jefe')",
    "af45d2e376484031617f78d2b58a6b1b9c7ef464f5a01b47e42ec3736322445e8e2240"
    "ca5e69e2c78b3239ecfab21649" },
    { "CryptoJS.HmacSHA512(JEFE, 'Jefe')",
    "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf"
    "75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737" },
    // A WordArray message hashes its bytes, as the same string does.
    { "CryptoJS.SHA256(CryptoJS.enc.Utf8.parse('abc'))",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    // The digest as base64, the other form a signature header takes.
    { "CryptoJS.SHA256('abc').toString(CryptoJS.enc.Base64)", "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=" },
    { "CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA1(JEFE, 'Jefe'))", "7/zfauXrL6LSdBbV8YTfnCWafHk=" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (engine, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

TEST_F (ScriptEngineTest, RequireShelfEncodersMatchKnownAnswers) {
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    // Base64's three padding cases, RFC 4648 section 10.
    { "CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('f'))", "Zg==" },
    { "CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('fo'))", "Zm8=" },
    { "CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('foo'))", "Zm9v" },
    { "CryptoJS.enc.Base64.parse('Zm8=').toString(CryptoJS.enc.Utf8)", "fo" },
    { "CryptoJS.enc.Base64.parse('Zm9v\\nYmFy').toString(CryptoJS.enc.Utf8)", "foobar" },
    { "CryptoJS.enc.Hex.parse('00ff10').toString(CryptoJS.enc.Base64)", "AP8Q" },
    // UTF-8 both ways, through a two- and a three-byte character.
    { "CryptoJS.enc.Utf8.parse('\\u00e9\\u20ac').toString()", "c3a9e282ac" },
    { "CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Hex.parse('c3a9e282ac'))", "\xc3\xa9\xe2\x82\xac" },
    { "CryptoJS.enc.Latin1.stringify(CryptoJS.enc.Hex.parse('48e9'))", "H\xc3\xa9" },
    { "CryptoJS.enc.Latin1.parse('H\\u00e9').toString()", "48e9" },
    { "CryptoJS.lib.WordArray.create(new Uint8Array([1, 2, 255])).toString()", "0102ff" },
    { "CryptoJS.lib.WordArray.create([0x01020304], 3).toString()", "010203" },
    { "CryptoJS.enc.Utf8.parse('ab').concat(CryptoJS.enc.Utf8.parse('c'))"
      ".toString(CryptoJS.enc.Utf8)",
    "abc" },
    { "CryptoJS.SHA1('abc').clone().sigBytes", "20" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (engine, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// A digest is a key: the AWS SigV4 signing-key chain Postman scripts write with
// crypto-js, against the published example key DigestBytesCanBeFedBackAsAKey
// checks pm.crypto against.
TEST_F (ScriptEngineTest, RequireShelfHmacTakesAWordArrayKey) {
    auto result = engine.execute_prerequest (R"JS(
        var kDate = CryptoJS.HmacSHA256('20150830', 'AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY');
        var kRegion = CryptoJS.HmacSHA256('us-east-1', kDate);
        var kService = CryptoJS.HmacSHA256('iam', kRegion);
        pm.environment.set('kSigning', CryptoJS.HmacSHA256('aws4_request', kService).toString());
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["kSigning"].value,
    "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
}

TEST_F (ScriptEngineTest, RequireShelfAnswersOneModuleForRequireAndTheGlobal) {
    EXPECT_EQ (
    shelf_answer (engine, request,
    "typeof CryptoJS + ' ' + (require('crypto-js') === CryptoJS) + ' ' + "
    "(require('crypto-js') === require('crypto-js'))"),
    "object true true");
}

TEST_F (ScriptEngineTest, RequireShelfRefusesANameOffTheShelf) {
    const std::string refusal = shelf_answer (engine, request, "require('nope')");
    EXPECT_NE (refusal.find ("Cannot find module 'nope'"), std::string::npos) << refusal;
    EXPECT_NE (refusal.find ("(crypto-js, uuid, lodash, moment, "
                             "csv-parse/lib/sync, xml2js, chai, ajv, tv4)"),
    std::string::npos)
    << "the refusal names the shelf: " << refusal;
    EXPECT_NE (refusal.find ("reads no file and fetches nothing"), std::string::npos)
    << refusal;

    // A script that catches the refusal goes on, as it would under Node.
    EXPECT_EQ (
    shelf_answer (engine, request,
    "(function () { try { require('fs'); } catch (e) { return e instanceof "
    "Error; } })()"),
    "true");

    const std::string not_a_name = shelf_answer (engine, request, "require(42)");
    EXPECT_NE (not_a_name.find ("TypeError"), std::string::npos) << not_a_name;
    EXPECT_NE (not_a_name.find ("module name string"), std::string::npos) << not_a_name;
}

// Hashing the text "[object Object]" or "42" would be a digest that looks
// right; every one of these throws, naming the call.
TEST_F (ScriptEngineTest, RequireShelfRefusesInputItCannotHashHonestly) {
    constexpr auto REFUSED = std::to_array<ShelfAnswer> ({
    { "CryptoJS.SHA256(42)", "CryptoJS.SHA256 takes a string or a WordArray, not number" },
    { "CryptoJS.MD5({})", "CryptoJS.MD5 takes a string or a WordArray, not object" },
    { "CryptoJS.HmacSHA256('m', null)", "CryptoJS.HmacSHA256 key takes a string or a WordArray, not null" },
    { "CryptoJS.HmacSHA1(undefined, 'k')",
    "CryptoJS.HmacSHA1 message takes a string or a WordArray, not undefined" },
    { "CryptoJS.enc.Hex.parse('abc')", "is not an even number of hex digits" },
    { "CryptoJS.enc.Hex.parse('zz')", "is not an even number of hex digits" },
    { "CryptoJS.enc.Base64.parse('Zm9v!')", "is not a base64 digit" },
    { "CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Hex.parse('ff'))", "Malformed UTF-8 data" },
    { "CryptoJS.enc.Hex.stringify('abc')", "CryptoJS.enc.Hex.stringify takes a WordArray, not string" },
    });
    for (const auto& refused : REFUSED) {
        const std::string answer = shelf_answer (engine, request, refused.expression);
        EXPECT_NE (answer.find ("threw: "), std::string::npos)
        << refused.expression << " answered " << answer;
        EXPECT_NE (answer.find (refused.expected), std::string::npos)
        << refused.expression << ": " << answer;
    }
}

// Every script gets a context built for it, so a library evaluated at build
// would be paid for by every element. Mutation: evaluate the shelf in
// `setup_require_shelf` and the first expectation fails.
TEST_F (ScriptEngineTest, RequireShelfEvaluatesALibraryOnlyOnFirstUse) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (engine, request, "1 + 1"), "2");
    EXPECT_EQ (shelf_answer (engine, request, "typeof require"), "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    // One evaluation however many times the execution reaches for it.
    EXPECT_EQ (shelf_answer (engine, request,
               "typeof CryptoJS + require('crypto-js').MD5('').sigBytes + "
               "typeof require('crypto-js')"),
    "object16object");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);

    // The next script's context is a new one, which loads its own copy.
    EXPECT_EQ (shelf_answer (engine, request, "typeof require('crypto-js').SHA1"), "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 2);
}

// An assignment replaces the global as it would any other, without loading
// the library it replaces; a script's own `var CryptoJS = require(...)` is
// function-local, as in Postman.
TEST_F (ScriptEngineTest, RequireShelfGlobalCanBeReassigned) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (engine, request, "(CryptoJS = 5, CryptoJS + 1)"), "6");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before);

    auto result = engine.execute_prerequest (R"JS(
        var CryptoJS = require('crypto-js');
        pm.environment.set('out', CryptoJS.MD5('').toString());
    )JS",
    request, env);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["out"].value, "d41d8cd98f00b204e9800998ecf8427e");
}

// require('uuid') is npm's uuid 8.3.2, vendored (#2650).

namespace {

constexpr const char* UUID_V4_PATTERN =
"/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/";

} // namespace

// Mutation: have native.randomBytes answer zeros and the two calls agree.
TEST_F (ScriptEngineTest, RequireShelfUuidV4IsRandomAndWellFormed) {
    const std::string v4_shape = std::string (UUID_V4_PATTERN) + ".test(require('uuid').v4())";
    EXPECT_EQ (shelf_answer (engine, request, v4_shape), "true");
    EXPECT_EQ (shelf_answer (engine, request,
               "(function (u) { var a = u.v4(), b = u.v4(); return a !== b && "
               "u.validate(a) && u.version(b) === 4; })(require('uuid'))"),
    "true");
}

// Postman's uuid is called as a function; npm's members ride on it.
// Mutation: return `api` from the glue and the call throws.
TEST_F (ScriptEngineTest, RequireShelfUuidIsCallableAsPostmansIs) {
    EXPECT_EQ (shelf_answer (engine, request, std::string (UUID_V4_PATTERN) + ".test(require('uuid')())"),
    "true");
    EXPECT_EQ (shelf_answer (engine, request, "typeof require('uuid') + ' ' + (require('uuid') === require('uuid'))"),
    "function true");
    EXPECT_EQ (shelf_answer (engine, request,
               "(function () { const { v4: uuidv4 } = require('uuid'); return "
               "uuidv4().length; })()"),
    "36");
}

// The name-based and time-based versions against their published answers:
// RFC 4122's DNS namespace and uuid's own README examples.
TEST_F (ScriptEngineTest, RequireShelfUuidMatchesKnownAnswers) {
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "require('uuid').v5('www.example.com', require('uuid').v5.DNS)", "2ed6657d-e927-568b-95e1-2665a8aea6a2" },
    { "require('uuid').v3('www.example.com', require('uuid').v3.DNS)", "5df41881-3aed-3515-88a7-2f4a814cf09e" },
    { "require('uuid').v5('https://www.w3.org/', require('uuid').v5.URL)",
    "c106a26a-21bb-5538-8bf2-57095d1976c1" },
    { "require('uuid').v1({ node: [0x01, 0x23, 0x45, 0x67, 0x89, 0xab], "
      "clockseq: 0x1234, msecs: Date.UTC(2011, 10, 1), nsecs: 5678 })",
    "710b962e-041c-11e1-9234-0123456789ab" },
    { "/^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/"
      ".test(require('uuid').v1())",
    "true" },
    { "require('uuid').NIL", "00000000-0000-0000-0000-000000000000" },
    { "require('uuid').validate('not a UUID')", "false" },
    { "require('uuid').validate('6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b')", "true" },
    { "require('uuid').version('45637ec4-c85f-11ea-87d0-0242ac130003')", "1" },
    { "require('uuid').stringify(require('uuid').parse("
      "'6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b'))",
    "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (engine, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// The UMD's CommonJS branch and the glue's `crypto` are the factory's own;
// none of them reaches the script's global scope.
TEST_F (ScriptEngineTest, RequireShelfUuidLeavesNoGlobalBehind) {
    EXPECT_EQ (shelf_answer (engine, request,
               "(require('uuid').v4(), [typeof uuid, typeof crypto, typeof "
               "module, typeof exports, typeof define].join(' '))"),
    "undefined undefined undefined undefined undefined");
}

// Mutation: evaluate the shelf in `setup_require_shelf` and the first
// expectation fails.
TEST_F (ScriptEngineTest, RequireShelfUuidEvaluatesOnlyOnFirstUse) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (engine, request, "typeof require"), "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that requires nothing evaluated a library";

    EXPECT_EQ (shelf_answer (engine, request, "require('uuid').v4().length + require('uuid')().length"),
    "72");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);
}

// require('lodash') and the `_` global are npm's lodash 4.17.21, vendored (#2651).

TEST_F (ScriptEngineTest, RequireShelfLodashAnswersKnownCalls) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "_.get({ a: [{ b: 3 }] }, 'a[0].b')", "3" },
    { "require('lodash').get({ a: [{ b: 3 }] }, ['a', '0', 'b'])", "3" },
    { "_.get({}, 'a.b', 'fallback')", "fallback" },
    { "JSON.stringify(_.chunk(['a', 'b', 'c', 'd', 'e'], 2))", R"([["a","b"],["c","d"],["e"]])" },
    { "JSON.stringify(_.groupBy([6.1, 4.2, 6.3], Math.floor))", R"({"4":[4.2],"6":[6.1,6.3]})" },
    { "JSON.stringify(_.groupBy(['one', 'two', 'three'], 'length'))", R"({"3":["one","two"],"5":["three"]})" },
    { "_.isEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })", "true" },
    { "_.isEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })", "false" },
    { "(function () { var o = { a: [{ b: 1 }] }, c = _.cloneDeep(o); "
      "c.a[0].b = 2; return [o.a[0].b, c.a[0].b, c.a !== o.a].join(); })()",
    "1,2,true" },
    { "_.map([1, 2, 3], function (n) { return n * 2; }).join()", "2,4,6" },
    { "_([1, 2, 3, 4]).filter(function (n) { return n % 2 === 0; }).sum()", "6" },
    { "_.VERSION", "4.17.21" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// One module for the global and the require, whichever the script reaches first.
TEST_F (ScriptEngineTest, RequireShelfLodashIsOneModuleForRequireAndTheGlobal) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (shelf_answer (roomy, request,
               "typeof _ + ' ' + (require('lodash') === _) + ' ' + "
               "(require('lodash') === require('lodash'))"),
    "function true true");
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var l = require('lodash'); return (l === _) + ' ' + "
    "typeof l.get; })()"),
    "true function");
}

// lodash takes its CommonJS branch inside the glue, so it assigns no global
// of its own, and the sandbox gives it no Node to find: no `module`, `exports`,
// `process` or `global` is in a built context, before or after it loads.
TEST_F (ScriptEngineTest, RequireShelfLodashLeavesNoGlobalBehind) {
    ScriptEngine roomy{ library_call_config () };
    const std::string probe =
    "[typeof module, typeof exports, typeof process, typeof global, typeof "
    "define].join(' ')";
    EXPECT_EQ (shelf_answer (roomy, request, probe),
    "undefined undefined undefined undefined undefined");
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var before = Object.getOwnPropertyNames(globalThis)"
    ".sort().join(); require('lodash').get({}, 'a'); _.noop(); return "
    "Object.getOwnPropertyNames(globalThis).sort().join() === before; })()"),
    "true");
    EXPECT_EQ (shelf_answer (roomy, request, "(require('lodash'), " + probe + ")"),
    "undefined undefined undefined undefined undefined");
}

// An assignment replaces `_` as it would any global, without loading lodash,
// and a script's own `_` is its own.
TEST_F (ScriptEngineTest, RequireShelfLodashGlobalCanBeReassigned) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (engine, request, "(_ = 1, _ + 1)"), "2");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before);
    EXPECT_EQ (shelf_answer (engine, request, "(function () { var _ = 'mine'; return _; })()"),
    "mine");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before);
}

// lodash reads the `_` global while it evaluates (its noConflict value), which
// is the shelf's own accessor mid-load. Read through either door, the library
// is evaluated once and the global ends up as the library. Mutations: evaluate
// the shelf in `setup_require_shelf` and the first count fails; let the getter
// replace itself with the mid-load `undefined` and the last answer does; drop
// the in-progress entry in `load_library` and that read recurses until the
// stack runs out, so every lodash case throws.
TEST_F (ScriptEngineTest, RequireShelfLodashEvaluatesOnlyOnFirstUse) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (roomy, request, "typeof require + typeof pm"), "functionobject");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    EXPECT_EQ (shelf_answer (roomy, request,
               "_.get({ a: 1 }, 'a') + require('lodash').get({ a: 1 }, 'a')"),
    "2");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);

    EXPECT_EQ (shelf_answer (roomy, request, "(require('lodash'), typeof _ + (_ === require('lodash')))"),
    "functiontrue");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 2);
}

// require('moment') is npm's moment 2.31.0 (the English-only min build),
// vendored (#2652). Postman binds no `moment` global, so there is only the
// module. Local-time cases use a calendar date and format it back, which does
// not move with the host's zone; the rest read moment.utc and fixed instants,
// never the clock.
TEST_F (ScriptEngineTest, RequireShelfMomentAnswersKnownCalls) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "require('moment')('2026-10-21').add(1, 'day').format('YYYY-MM-DD')", "2026-10-22" },
    { "require('moment').utc(0).toISOString()", "1970-01-01T00:00:00.000Z" },
    { "require('moment').utc('2026-10-21T12:00:00Z').format('dddd, MMMM Do "
      "YYYY, h:mm a')",
    "Wednesday, October 21st 2026, 12:00 pm" },
    { "require('moment').utc('2026-10-21').unix()", "1792540800" },
    { "require('moment').utc('2026-10-21').isBefore(require('moment').utc('"
      "2026-10-22'))",
    "true" },
    { "require('moment').utc('2026-10-22').isBefore(require('moment').utc('"
      "2026-10-21'))",
    "false" },
    { "require('moment').utc('2026-10-22').diff(require('moment').utc('2026-10-"
      "21'), 'hours')",
    "24" },
    { "require('moment').utc('2026-01-31').add(1, "
      "'month').format('YYYY-MM-DD')",
    "2026-02-28" },
    { "require('moment').utc('2026-10-21').startOf('month').format()", "2026-10-01T00:00:00Z" },
    { "require('moment').utc('2026-02-30').isValid()", "false" },
    { "require('moment').duration(90, 'minutes').asHours()", "1.5" },
    { "require('moment').version", "2.31.0" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// A destructured member is the one the module holds, and every require answers
// one module.
TEST_F (ScriptEngineTest, RequireShelfMomentDestructuredAndDirectAgree) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { const { utc, duration } = require('moment'); "
    "return [utc(0).toISOString() === require('moment').utc(0).toISOString(), "
    "duration(1, 'day').asHours(), "
    "require('moment') === require('moment')].join(); })()"),
    "true,24,true");
}

// moment's UMD takes its CommonJS branch inside the glue, so it assigns no
// global: Postman has none either, so `moment` stays undeclared before and
// after a require, and nothing else is added to the global object.
TEST_F (ScriptEngineTest, RequireShelfMomentLeavesNoGlobalBehind) {
    ScriptEngine roomy{ library_call_config () };
    const std::string probe =
    "[typeof moment, typeof module, typeof exports, typeof define].join(' ')";
    EXPECT_EQ (shelf_answer (roomy, request, probe), "undefined undefined undefined undefined");
    EXPECT_EQ (shelf_answer (roomy, request, "(require('moment'), " + probe + ")"),
    "undefined undefined undefined undefined");
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var before = Object.getOwnPropertyNames(globalThis)"
    ".sort().join(); require('moment').utc(0).format(); return "
    "Object.getOwnPropertyNames(globalThis).sort().join() === before; })()"),
    "true");
}

// The English-only build has no locale files. moment.locale('fr') asks the
// sandbox's require for './locale/fr', which refuses, and moment keeps
// English: the call answers 'en' and throws nothing a script would see.
TEST_F (ScriptEngineTest, RequireShelfMomentFallsBackToEnglishForAnotherLocale) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (shelf_answer (roomy, request, "require('moment').locale('fr') + ' ' + require('moment').locale()"),
    "en en");
    EXPECT_EQ (shelf_answer (roomy, request, "require('moment').utc('2026-10-21').locale('fr').format('MMMM')"),
    "October");
}

// Mutations: evaluate the shelf in `setup_require_shelf` and the first count
// fails; let the glue assign a `moment` global and the leaves-no-global case
// fails.
TEST_F (ScriptEngineTest, RequireShelfMomentEvaluatesOnlyOnFirstUse) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (roomy, request, "typeof require + typeof pm"), "functionobject");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    EXPECT_EQ (shelf_answer (roomy, request, "require('moment').utc(0).year() + require('moment').utc(0).month()"),
    "1970");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);
}

// require('csv-parse/lib/sync') is npm's csv-parse 1.2.4 sync parser, bundled
// (#2653), the version Postman's sandbox exposes at that path and only there.
// The module is the parse function. Every answer was checked against the
// unbundled package on Node.
TEST_F (ScriptEngineTest, RequireShelfCsvParseAnswersKnownCalls) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1,2', { columns: true })))",
    R"([{"a":"1","b":"2"}])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1,2')))", R"([["a","b"],["1","2"]])" },
    // A quoted field keeps its delimiter, and a doubled quote is one quote.
    { R"(JSON.stringify(require('csv-parse/lib/sync')('"a,b",c\n"say ""hi""",d')))",
    R"([["a,b","c"],["say \"hi\"","d"]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a;b\n1;2', { delimiter: ';', columns: true })))",
    R"([{"a":"1","b":"2"}])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a\tb\n1\t2', { delimiter: '\t' })))",
    R"([["a","b"],["1","2"]])" },
    // An empty line is a record of one empty field unless it is skipped.
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n\n1,2\n')))", R"([["a","b"],[""],["1","2"]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n\n1,2\n', { skip_empty_lines: true })))",
    R"([["a","b"],["1","2"]])" },
    // 1.2.4's option names, which later majors renamed.
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1,2', { auto_parse: true })))",
    R"([["a","b"],[1,2]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1,2,3', { relax_column_count: true })))",
    R"([["a","b"],["1","2","3"]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\r\n1,2\r\n', { columns: true })))",
    R"([{"a":"1","b":"2"}])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')(' a , b ', { trim: true })))", R"([["a","b"]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('id,v\n1,x\n2,y', { columns: true, objname: 'id' })))",
    R"({"1":{"id":"1","v":"x"},"2":{"id":"2","v":"y"}})" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('')))", "[]" },
    // 1.2.4 drops a short or long last record that has no line ending after
    // it rather than throwing; Postman's copy does the same.
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1,2,3')))", R"([["a","b"]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1')))", R"([["a","b"]])" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// A malformed record throws csv-parse's own Error, with its own message, which
// a script can catch.
TEST_F (ScriptEngineTest, RequireShelfCsvParseThrowsTheLibrarysOwnError) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto REFUSED = std::to_array<ShelfAnswer> ({
    { R"(require('csv-parse/lib/sync')('a,b\n"1,2'))", "Quoted field not terminated at line 3" },
    { R"(require('csv-parse/lib/sync')('a,b\n1,2,3\n'))", "Number of columns is inconsistent on line 2" },
    { R"(require('csv-parse/lib/sync')('a,b\n"1",2\n"x"y,3\n'))",
    R"(Invalid closing quote at line 3; found "y" instead of delimiter ",")" },
    });
    for (const auto& refused : REFUSED) {
        const std::string answer = shelf_answer (roomy, request, refused.expression);
        EXPECT_NE (answer.find ("threw: "), std::string::npos)
        << refused.expression << " answered " << answer;
        EXPECT_NE (answer.find (refused.expected), std::string::npos)
        << refused.expression << ": " << answer;
    }
    EXPECT_EQ (shelf_answer (roomy, request,
               R"((function () { try { require('csv-parse/lib/sync')('"a'); } )"
               R"(catch (e) { return (e instanceof Error) + ' ' + e.message; } })())"),
    "true Quoted field not terminated at line 2");
}

// The module is the function, so there is nothing to destructure: a binding
// and a direct call are the same function and answer the same records, and
// every require answers one module.
TEST_F (ScriptEngineTest, RequireShelfCsvParseBoundAndDirectAgree) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (shelf_answer (roomy, request,
               R"((function () { const parse = require('csv-parse/lib/sync'); )"
               R"(return [typeof parse, parse === require('csv-parse/lib/sync'), )"
               R"(JSON.stringify(parse('a\n1')) === )"
               R"(JSON.stringify(require('csv-parse/lib/sync')('a\n1'))].join(); })())"),
    "function,true,true");
}

// The bundle's Node shims (Buffer, stream, util, string_decoder) are locals
// of its own wrapper and the glue's `module` is the factory's, so none of them
// reaches the script, before or after a parse, and the global object gains
// nothing.
TEST_F (ScriptEngineTest, RequireShelfCsvParseLeavesNoGlobalBehind) {
    ScriptEngine roomy{ library_call_config () };
    const std::string probe =
    "[typeof module, typeof exports, typeof define, typeof Buffer, typeof "
    "process, typeof parse, typeof StringDecoder, typeof setImmediate].join(' "
    "')";
    const std::string undefined_all =
    "undefined undefined undefined undefined undefined undefined undefined "
    "undefined";
    EXPECT_EQ (shelf_answer (roomy, request, probe), undefined_all);
    EXPECT_EQ (shelf_answer (roomy, request,
               "(require('csv-parse/lib/sync')('a,b\\n1,2'), " + probe + ")"),
    undefined_all);
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var before = Object.getOwnPropertyNames(globalThis)"
    ".sort().join(); require('csv-parse/lib/sync')('a,b\\n1,2', "
    "{ columns: true }); return "
    "Object.getOwnPropertyNames(globalThis).sort().join() === before; "
    "})()"),
    "true");
}

// Only the whole name loads it: Postman exposes csv-parse at this one path,
// so the bare package, the 5.x `csv-parse/sync` and every other path under it
// are refused as any name off the shelf is, and none of them evaluates the
// library. Mutation: let `js_require` accept any name starting `csv-parse`
// and every case here loads it instead.
TEST_F (ScriptEngineTest, RequireShelfCsvParseRefusesEveryOtherPath) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    for (const char* name : { "csv-parse", "csv-parse/lib/other", "csv-parse/lib/index",
         "csv-parse/lib/sync.js", "csv-parse/sync", "csv-parse/lib" }) {
        const std::string refusal =
        shelf_answer (engine, request, "require('" + std::string (name) + "')");
        EXPECT_NE (refusal.find ("Cannot find module '" + std::string (name) + "'"),
        std::string::npos)
        << refusal;
        EXPECT_NE (refusal.find ("reads no file and fetches nothing"), std::string::npos)
        << refusal;
    }
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a refused name evaluated a library";
}

// Mutation: evaluate the shelf in `setup_require_shelf` and the first count
// fails.
TEST_F (ScriptEngineTest, RequireShelfCsvParseEvaluatesOnlyOnFirstUse) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (roomy, request, "typeof require + typeof pm"), "functionobject");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    EXPECT_EQ (shelf_answer (roomy, request,
               "require('csv-parse/lib/sync')('a\\n1').length + "
               "require('csv-parse/lib/sync')('a\\n1\\n2').length"),
    "5");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);
}

// require('xml2js') is npm's xml2js 0.6.2 with sax 1.2.4 and xmlbuilder
// 11.0.1, bundled (#2654), the versions Postman's sandbox ships; `xml2Json` is
// Postman's synchronous parse over it. Every answer was checked against the
// unbundled packages on Node.
namespace {

/// A function expression that parses its first argument with xml2js's
/// parseString and its options, and answers what the callback was handed: the
/// result as JSON, the error's first line, or "no callback".
constexpr const char* XML2JS_PARSE =
"(function (xml, options) { var out = 'no callback'; "
"require('xml2js').parseString(xml, options || {}, function (e, r) { "
"out = e ? (e instanceof Error) + ' ' + e.message.split('\\n')[0] : "
"JSON.stringify(r); }); return out; })";

std::string xml2js_parse (const std::string& arguments) {
    std::string call = XML2JS_PARSE;
    call += '(';
    call += arguments;
    call += ')';
    return call;
}

} // namespace

TEST_F (ScriptEngineTest, RequireShelfXml2jsAnswersKnownCalls) {
    ScriptEngine roomy{ library_call_config () };
    struct Xml2jsAnswer {
        std::string arguments;
        const char* expected;
    };
    const auto answers = std::to_array<Xml2jsAnswer> ({
    { R"('<a><b>1</b></a>')", R"({"a":{"b":["1"]}})" },
    { R"('<a><b>1</b></a>', { explicitArray: false })", R"({"a":{"b":"1"}})" },
    // Attributes sit under `$` and an element's text beside them under `_`.
    { R"('<a x="1" y="2"><b k="v">t</b></a>')",
    R"({"a":{"$":{"x":"1","y":"2"},"b":[{"_":"t","$":{"k":"v"}}]}})" },
    { R"('<a x="1"><b>t</b></a>', { mergeAttrs: true })", R"({"a":{"x":["1"],"b":["t"]}})" },
    { R"('<a><b>1</b><b>2</b></a>', { explicitArray: false })", R"({"a":{"b":["1","2"]}})" },
    { R"('<?xml version="1.0"?><r><![CDATA[<x>]]></r>')", R"({"r":"<x>"})" },
    { R"('<a>&amp;&lt;&#65;&#x42;</a>')", R"({"a":"&<AB"})" },
    { R"('<a><B>1</B></a>', { normalizeTags: true })", R"({"a":{"b":["1"]}})" },
    { R"('<a>1</a>', { explicitRoot: false })", R"("1")" },
    { R"('<a b=1>x</a>', { strict: false })", R"({"A":{"_":"x","$":{"B":"1"}}})" },
    { R"('<a><n>42</n><b>true</b><s>x</s></a>', { explicitArray: false, )"
      R"(valueProcessors: [require('xml2js').processors.parseNumbers, )"
      R"(require('xml2js').processors.parseBooleans] })",
    R"({"a":{"n":42,"b":true,"s":"x"}})" },
    { R"('<a xmlns:p="u"><p:b>1</p:b></a>', { explicitArray: false, )"
      R"(tagNameProcessors: [require('xml2js').processors.stripPrefix] })",
    R"({"a":{"$":{"xmlns:p":"u"},"b":"1"}})" },
    // Empty input is not an error: the callback is handed null.
    { "''", "null" },
    });
    for (const auto& answer : answers) {
        EXPECT_EQ (shelf_answer (roomy, request, xml2js_parse (answer.arguments)),
        answer.expected)
        << answer.arguments;
    }
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "new (require('xml2js').Builder)({ headless: true, renderOpts: { "
    "pretty: false } }).buildObject({ a: { $: { k: 'v' }, b: ['1', "
    "'2'] } })"),
    R"(<a k="v"><b>1</b><b>2</b></a>)");
}

// A document sax refuses reaches the callback as an Error carrying sax's own
// message, and with `async: false` (the default) the callback has run before
// parseString returns.
TEST_F (ScriptEngineTest, RequireShelfXml2jsHandsAMalformedDocumentToTheCallback) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto REFUSED = std::to_array<ShelfAnswer> ({
    { "'<a><b>1</b>'", "true Unclosed root tag" },
    { "'<a></b>'", "true Unexpected close tag" },
    { "'not xml'", "true Non-whitespace before first tag." },
    { "'<a>&bogus;</a>'", "true Invalid character entity" },
    { "'<a b=1>x</a>'", "true Unquoted attribute value" },
    });
    for (const auto& refused : REFUSED) {
        EXPECT_EQ (shelf_answer (roomy, request, xml2js_parse (refused.expression)),
        refused.expected)
        << refused.expression;
    }
    EXPECT_EQ (shelf_answer (roomy, request,
               "(function () { var order = []; require('xml2js').parseString("
               "'<a/>', function () { order.push('callback'); }); "
               "order.push('returned'); return order.join(); })()"),
    "callback,returned");
}

// `xml2Json` is Postman's helper: parseString with explicitArray false, trim
// on and attributes kept apart, answering what the callback was handed, so a
// refused document is `undefined` and empty input `null`. It is the same
// parse as the module's with those options.
TEST_F (ScriptEngineTest, RequireShelfXml2JsonIsPostmansSynchronousParse) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "JSON.stringify(xml2Json('<a>1</a>'))", R"({"a":"1"})" },
    { R"(JSON.stringify(xml2Json('<a><b> 1 </b><b>2</b><c k="v">t</c></a>')))",
    R"({"a":{"b":["1","2"],"c":{"_":"t","$":{"k":"v"}}}})" },
    { "JSON.stringify(xml2Json('<a><b>1</b><c/></a>'))", R"({"a":{"b":"1","c":""}})" },
    { "typeof xml2Json('<a><b>1</b>')", "undefined" },
    { "typeof xml2Json('not xml')", "undefined" },
    { "xml2Json('')", "null" },
    { "typeof xml2Json", "function" },
    { "xml2Json === require('xml2js')", "false" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
    EXPECT_EQ (shelf_answer (roomy, request,
               "JSON.stringify(xml2Json('<r k=\"v\"> x </r>')) === " +
               xml2js_parse ("'<r k=\"v\"> x </r>', { explicitArray: false, "
                             "async: false, trim: true, mergeAttrs: false }")),
    "true");
}

// An `async: true` parse goes through the bundle's setImmediate, a zero-delay
// setTimeout, and the sandbox runs every timer before the script ends: the
// callback has not run when parseString returns, and a pm.test inside it is
// recorded. A document over xml2js's 10,000-character chunk takes one timer
// per chunk, each queued by the one before. parseStringPromise settles the
// same way.
TEST_F (ScriptEngineTest, RequireShelfXml2jsAsyncCallbackRunsBeforeTheScriptEnds) {
    ScriptEngine roomy{ library_call_config () };
    response.body     = "<order><id>7</id></order>";
    const auto result = roomy.execute_test (R"JS(
        var xml2js = require('xml2js');
        var called = false;
        xml2js.parseString(pm.response.text(), { async: true, explicitArray: false }, function (err, doc) {
            called = true;
            pm.test('the async parse called back', function () {
                pm.expect(err).to.equal(null);
                pm.expect(doc.order.id).to.equal('7');
            });
        });
        pm.environment.set('called at return', String(called));
        var big = '<a>' + new Array(3001).join('<b>1</b>') + '</a>';
        xml2js.parseString(big, { async: true, explicitArray: false }, function (err, doc) {
            pm.environment.set('chunks', String(err === null && doc.a.b.length));
        });
        xml2js.parseStringPromise('<a><b>2</b></a>').then(function (doc) {
            pm.environment.set('promised', doc.a.b[0]);
        });
        xml2js.parseStringPromise('<a>').catch(function (err) {
            pm.environment.set('rejected', err.message.split('\n')[0]);
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_EQ (result.tests[0].name, "the async parse called back");
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (env["called at return"].value, "false");
    EXPECT_EQ (env["chunks"].value, "3000");
    EXPECT_EQ (env["promised"].value, "2");
    EXPECT_EQ (env["rejected"].value, "Unclosed root tag");
}

// The bundle's Node shims (events, timers, stream, string_decoder) are locals
// of its own wrapper and the glue's `module` and `exports` are the factory's,
// so none of them reaches the script, before or after a parse; the global
// object gains nothing, and the module carries only xml2js's own exports
// (`xml2Json` is built beside it, not stored on it).
TEST_F (ScriptEngineTest, RequireShelfXml2jsLeavesNoGlobalBehind) {
    ScriptEngine roomy{ library_call_config () };
    const std::string probe =
    "[typeof module, typeof exports, typeof Buffer, typeof process, typeof "
    "setImmediate, typeof sax, typeof EventEmitter, typeof xml2js].join(' ')";
    const std::string undefined_all =
    "undefined undefined undefined undefined undefined undefined undefined "
    "undefined";
    EXPECT_EQ (shelf_answer (roomy, request, probe), undefined_all);
    EXPECT_EQ (shelf_answer (roomy, request, "(xml2Json('<a/>'), " + probe + ")"), undefined_all);
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var before = Object.getOwnPropertyNames(globalThis)"
    ".sort().join(); require('xml2js').parseString('<a/>', function () {}); "
    "xml2Json('<a/>'); new (require('xml2js').Builder)().buildObject({ a: 1 "
    "}); return Object.getOwnPropertyNames(globalThis).sort().join() === "
    "before; })()"),
    "true");
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(xml2Json('<a/>'), Object.getOwnPropertyNames(require('xml2js'))"
    ".join())"),
    "defaults,processors,ValidationError,Builder,Parser,parseString,"
    "parseStringPromise");
}

// Only the whole name loads it: the package's own files and its two
// dependencies are refused as any name off the shelf is, and none of them
// evaluates the library.
TEST_F (ScriptEngineTest, RequireShelfXml2jsRefusesEveryOtherPath) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    for (const char* name : { "xml2js/lib/parser", "xml2js/lib/xml2js",
         "xml2js/", "XML2JS", "sax", "xmlbuilder", "xml2json" }) {
        const std::string refusal =
        shelf_answer (engine, request, "require('" + std::string (name) + "')");
        EXPECT_NE (refusal.find ("Cannot find module '" + std::string (name) + "'"),
        std::string::npos)
        << refusal;
    }
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a refused name evaluated a library";
}

// `xml2Json` and require('xml2js') share one evaluation of the library,
// whichever the script reaches first, and an assignment replaces the global
// without loading it. Mutation: evaluate the shelf in `setup_require_shelf`
// and the first count fails.
TEST_F (ScriptEngineTest, RequireShelfXml2jsEvaluatesOnlyOnFirstUse) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (roomy, request, "typeof require + typeof pm"), "functionobject");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    EXPECT_EQ (shelf_answer (roomy, request,
               "xml2Json('<a>1</a>').a + " + xml2js_parse ("'<b>2</b>'") +
               " + typeof xml2Json + (xml2Json === xml2Json)"),
    R"(1{"b":"2"}functiontrue)");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);

    EXPECT_EQ (shelf_answer (roomy, request,
               "(require('xml2js'), typeof require('xml2js').parseString + "
               "xml2Json('<a>3</a>').a)"),
    "function3");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 2);

    EXPECT_EQ (shelf_answer (roomy, request, "(xml2Json = 5, xml2Json + 1)"), "6");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 2);
}

// require('chai') is npm's chai 4.4.1 with the dependency versions Postman's
// sandbox bundles (#2655): the library itself, a separate object from the
// native pm.expect. Every answer was checked against the unbundled packages on
// Node.
TEST_F (ScriptEngineTest, RequireShelfChaiExpectAnswersAsChaiDoes) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "(require('chai').expect(1).to.equal(1), 'held')", "held" },
    { "(require('chai').expect({ a: [1] }).to.deep.equal({ a: [1] }), 'held')", "held" },
    // chai 4.4.1's source still says 4.3.8; Node answers the same.
    { "require('chai').version", "4.3.8" },
    { "Object.keys(require('chai')).join()",
    "version,AssertionError,use,util,config,Assertion,expect,should,Should,"
    "assert" },
    { "(function () { var chai = require('chai'); try { "
      "chai.expect(1).to.equal(2); } catch (e) { return [e.name, e instanceof "
      "chai.AssertionError, e instanceof Error, e.actual, e.expected, "
      "e.showDiff, e.message].join(); } })()",
    "AssertionError,true,true,1,2,true,expected 1 to equal 2" },
    { "(function () { try { require('chai').expect(1).to.equal(2, 'custom'); "
      "} catch (e) { return e.message; } })()",
    "custom: expected 1 to equal 2" },
    { "(function () { try { require('chai').expect({}).to.be.tru; } catch (e) "
      "{ return e.message; } })()",
    "Invalid Chai property: tru. Did you mean \"true\"?" },
    // loupe finds no process to read a promise's state from.
    { "(function () { try { require('chai').expect(Promise.resolve(1))"
      ".to.equal(1); } catch (e) { return e.message; } })()",
    "expected Promise{…} to equal 1" },
    // type-detect's global object is the sandbox's own.
    { "require('chai').util.type(globalThis)", "global" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
    // Outside a pm.test the failure ends the script with chai's message.
    EXPECT_EQ (shelf_answer (roomy, request, "require('chai').expect(1).to.equal(2)"),
    "threw: AssertionError: expected 1 to equal 2");
}

TEST_F (ScriptEngineTest, RequireShelfChaiAssertDeepEqual) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "(require('chai').assert.deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: "
      "2 }] }), 'held')",
    "held" },
    { "(require('chai').assert.deepEqual(new Map([[1, { x: 2 }]]), new "
      "Map([[1, { x: 2 }]])), 'held')",
    "held" },
    { "(function () { try { require('chai').assert.deepEqual({ a: [1, { b: 2 "
      "}] }, { a: [1, { b: 3 }] }); } catch (e) { return e.name + ': ' + "
      "e.message; } })()",
    "AssertionError: expected { a: [ 1, { b: 2 } ] } to deeply equal { a: [ "
    "1, { b: 3 } ] }" },
    { "(function () { try { require('chai').assert.deepEqual(1, 2, 'custom'); "
      "} catch (e) { return e.message; } })()",
    "custom: expected 1 to deeply equal 2" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// should() is chai's to install, on its call: loading the module adds nothing
// to Object.prototype, and the next execution's fresh context starts without
// it.
TEST_F (ScriptEngineTest, RequireShelfChaiShouldExtendsObjectPrototypeOnlyAfterTheCall) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var chai = require('chai'); var before = 'should' "
    "in Object.prototype; chai.should(); var after = 'should' in "
    "Object.prototype; (5).should.equal(5); var message; try { "
    "(5).should.equal(6); } catch (e) { message = e.message; } "
    "return [before, after, message].join(); })()"),
    "false,true,expected 5 to equal 6");
    EXPECT_EQ (shelf_answer (roomy, request, "'should' in Object.prototype"), "false")
    << "should() reached the next execution";
}

// A chai AssertionError inside pm.test is an ordinary failed test carrying
// chai's message, and the tests beside it are unaffected.
TEST_F (ScriptEngineTest, RequireShelfChaiFailureInsidePmTestIsAFailedTest) {
    ScriptEngine roomy{ library_call_config () };
    response.status_code = 200;
    response.body        = R"({"id":7})";
    const auto result    = roomy.execute_test (R"JS(
        const { expect, assert } = require('chai');
        pm.test('chai fails', function () { expect(1).to.equal(2); });
        pm.test('chai holds', function () {
            expect(pm.response.json().id).to.equal(7);
            assert.deepEqual(pm.response.json(), { id: 7 });
        });
        pm.test('assert fails', function () { assert.strictEqual('a', 'b'); });
    )JS",
    request, response, env);

    // A failed test fails the run, but the script did not error.
    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "");
    ASSERT_EQ (result.tests.size (), 3u);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_EQ (result.tests[0].error_message, "AssertionError: expected 1 to equal 2");
    EXPECT_TRUE (result.tests[1].passed) << result.tests[1].error_message;
    EXPECT_FALSE (result.tests[2].passed);
    EXPECT_EQ (result.tests[2].error_message, "AssertionError: expected 'a' to equal 'b'");
}

// pm.expect is native and loading chai, use()-ing a plugin on it or calling
// its should() leaves pm.expect as it was: the same function, the same
// verdicts and messages, none of the plugin's members. Mutation: let the chai
// glue assign `pm.expect = module.exports.expect` and this fails.
TEST_F (ScriptEngineTest, RequireShelfChaiLeavesPmExpectUnchanged) {
    ScriptEngine roomy{ library_call_config () };
    const auto result = roomy.execute_test (R"JS(
        function failure(run) {
            try { run(); return 'held'; } catch (e) { return e.name + ': ' + e.message; }
        }
        var expect = pm.expect;
        var before = failure(function () { pm.expect(1).to.equal(2); });
        var chai = require('chai');
        chai.use(function (lib) {
            lib.Assertion.addProperty('vayuProbe', function () {});
        });
        chai.should();
        pm.environment.set('same function', String(pm.expect === expect));
        pm.environment.set('not chai', String(pm.expect !== chai.expect));
        pm.environment.set('same failure',
            String(failure(function () { pm.expect(1).to.equal(2); }) === before));
        pm.environment.set('before', before);
        pm.environment.set('held', failure(function () { pm.expect(1).to.equal(1); }));
        pm.environment.set('plugin', failure(function () { return pm.expect(1).vayuProbe; }));
        pm.environment.set('chai plugin', failure(function () { return chai.expect(1).vayuProbe; }));
        try { pm.expect(1).to.equal(2); } catch (e) {
            pm.environment.set('instance', String(e instanceof chai.AssertionError));
        }
        pm.environment.set('response assertion',
            failure(function () { chai.expect(pm.response).to.have.status(404); }));
        pm.environment.set('pm.expect response',
            failure(function () { return pm.expect(pm.response).to.have.status; }));
        pm.test('pm.expect still records', function () { pm.expect(2).to.be.above(1); });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["same function"].value, "true");
    EXPECT_EQ (env["not chai"].value, "true");
    EXPECT_EQ (env["same failure"].value, "true") << env["before"].value;
    EXPECT_EQ (env["held"].value, "held");
    EXPECT_NE (env["plugin"].value.find ("TypeError"), std::string::npos)
    << "a chai plugin reached pm.expect: " << env["plugin"].value;
    EXPECT_EQ (env["chai plugin"].value, "held");
    EXPECT_EQ (env["instance"].value, "false");
    // The response assertions are the chai module's own plugin and are not on
    // pm.expect, whose chain is native and has no `status`.
    EXPECT_EQ (env["response assertion"].value,
    "AssertionError: Expected status code 404 but got 200");
    EXPECT_NE (env["pm.expect response"].value.find ("TypeError"), std::string::npos)
    << "the response assertions reached pm.expect: "
    << env["pm.expect response"].value;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
}

namespace {

/// One response assertion, spelled after `expect(pm.response).` and after
/// `pm.response.`.
struct ResponseAssertionCase {
    std::string_view chain;
    bool holds;
};

/// What @p script's `chai` and `native` environment variables hold after it
/// ran @p chain both ways: "held", or the thrown `name: message`.
struct ResponseVerdicts {
    std::string chai;
    std::string native;
};

} // namespace

// require('chai') carries chai-postman's response assertions (#2751):
// `expect(pm.response).to.have.status(200)` is `pm.response.to.have.status(200)`
// by delegation, so each case's verdict and message must equal the native
// spelling's. Mutation: skip the glue's `module.exports.use(...)` and every
// case fails ("Invalid Chai property").
TEST_F (ScriptEngineTest, RequireChaiResponseAssertions) {
    ScriptEngine roomy{ library_call_config () };
    response.status_code     = 404;
    response.status_text     = "Not Found";
    response.body            = R"({"id":7,"name":"Ada"})";
    response.headers         = { { "X-Request-Id", "abc123" } };
    response.timing.total_ms = 150.5;

    constexpr auto CASES = std::to_array<ResponseAssertionCase> ({
    { "to.have.status(404)", true },
    { "to.have.status(200)", false },
    { "to.have.statusCode(404)", true },
    { "to.have.statusCode(200)", false },
    { "to.have.statusCodeClass(4)", true },
    { "to.have.statusCodeClass(2)", false },
    { "to.have.statusReason('Not Found')", true },
    { "to.have.statusReason('OK')", false },
    { "to.have.header('X-Request-Id', 'abc123')", true },
    { "to.have.header('X-Request-Id', 'other')", false },
    { "to.have.header('X-Missing')", false },
    { "to.have.body(/Ada/)", true },
    { "to.have.body('nothing')", false },
    { "to.have.jsonBody('id', 7)", true },
    { "to.have.jsonBody('id', 8)", false },
    { "to.have.jsonSchema({ type: 'object', required: ['id'] })", true },
    { "to.have.jsonSchema({ type: 'array' })", false },
    { "to.be.notFound", true },
    { "to.be.clientError", true },
    { "to.be.error", true },
    { "to.be.ok", false },
    { "to.be.success", false },
    { "to.be.serverError", false },
    { "to.be.json", true },
    { "to.be.withBody", true },
    // `not` is chai's flag and becomes the native `to.not` chain.
    { "to.not.have.status(404)", false },
    { "to.not.have.status(200)", true },
    { "to.not.be.notFound", false },
    { "to.not.be.ok", true },
    { "to.have.responseTime.below(200)", true },
    { "to.have.responseTime.above(200)", false },
    { "to.have.responseTime(150.5)", true },
    { "to.have.responseTime(1)", false },
    { "to.not.have.responseTime.below(200)", false },
    { "to.have.responseSize.above(0)", true },
    });

    for (const auto& item : CASES) {
        const std::string chain (item.chain);
        std::string script =
        "var expect = require('chai').expect;\n"
        "function run(f) { try { f(); return 'held'; } catch (e) { "
        "return e.name + ': ' + e.message; } }\n"
        "pm.environment.set('chai', run(function () { expect(pm.response).";
        script += chain;
        script += "; }));\n"
                  "pm.environment.set('native', run(function () { "
                  "pm.response.";
        script += chain;
        script += "; }));\n";
        const auto result = roomy.execute_test (script, request, response, env);
        ASSERT_TRUE (result.success) << chain << ": " << result.error_message;
        EXPECT_EQ (env["chai"].value, env["native"].value) << chain;
        EXPECT_EQ (env["chai"].value == "held", item.holds)
        << chain << ": " << env["chai"].value;
    }
}

// The failure is the native chain's message, thrown as Vayu's AssertionError.
TEST_F (ScriptEngineTest, RequireChaiResponseAssertionFailureCarriesTheNativeMessage) {
    ScriptEngine roomy{ library_call_config () };
    response.status_code = 404;
    const auto result    = roomy.execute_test (R"JS(
        const { expect } = require('chai');
        pm.test('chai spelling', function () { expect(pm.response).to.have.status(200); });
        pm.test('native spelling', function () { pm.response.to.have.status(200); });
    )JS",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2u);
    EXPECT_FALSE (result.tests[0].passed);
    EXPECT_FALSE (result.tests[1].passed);
    EXPECT_EQ (result.tests[0].error_message, result.tests[1].error_message);
    EXPECT_NE (result.tests[0].error_message.find ("404"), std::string::npos)
    << result.tests[0].error_message;
}

// A matcher hands the assertion back, so chai's chain words continue it, which
// the native chain does not offer after a call.
TEST_F (ScriptEngineTest, RequireChaiResponseAssertionsChainOn) {
    ScriptEngine roomy{ library_call_config () };
    response.status_code = 404;
    response.headers     = { { "X-Request-Id", "abc123" } };
    const auto result    = roomy.execute_test (R"JS(
        const { expect } = require('chai');
        pm.test('chained', function () {
            expect(pm.response).to.have.status(404).and.to.have.header('X-Request-Id');
            expect(pm.response).to.be.notFound.and.to.be.clientError;
        });
        pm.test('second link fails', function () {
            expect(pm.response).to.have.status(404).and.to.have.status(200);
        });
    )JS",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 2u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed);
    EXPECT_NE (result.tests[1].error_message.find ("200"), std::string::npos)
    << result.tests[1].error_message;
}

// chai's own `ok` keeps its meaning for every target but the response, and the
// plugin adds nothing to the module's members.
TEST_F (ScriptEngineTest, RequireChaiResponseAssertionsLeaveChaiItselfAlone) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var chai = require('chai'); var out = []; "
    "chai.expect(1).to.be.ok; "
    "try { chai.expect(0).to.be.ok; } catch (e) { out.push(e.message); } "
    "chai.expect(0).to.not.be.ok; "
    "out.push(Object.keys(chai).join()); return out.join('|'); })()"),
    "expected +0 to be truthy|version,AssertionError,use,util,config,Assertion,"
    "expect,should,Should,assert");
}

// Any other target is refused by name: asserting on the execution's response
// while the script wrote about another value would pass for the wrong reason.
TEST_F (ScriptEngineTest, RequireChaiResponseAssertionsRefuseOtherTargets) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto TARGETS = std::to_array<std::string_view> ({
    "expect({ code: 200 }).to.have.status(200)",
    "expect(200).to.have.status(200)",
    "expect(pm.response.json()).to.have.jsonBody('id')",
    "expect({}).to.be.notFound",
    "expect(undefined).to.have.responseTime.below(1)",
    });
    for (const auto& target : TARGETS) {
        const auto result =
        roomy.execute_test ("var expect = require('chai').expect;\n"
                            "try { " +
        std::string (target) +
        "; pm.environment.set('out', 'held'); } "
        "catch (e) { pm.environment.set('out', e.name + ': ' + e.message); }\n",
        request, response, env);
        ASSERT_TRUE (result.success) << target << ": " << result.error_message;
        EXPECT_NE (env["out"].value.find ("TypeError: chai."), std::string::npos)
        << target << ": " << env["out"].value;
        EXPECT_NE (
        env["out"].value.find ("expects pm.response as the target of expect()"),
        std::string::npos)
        << target << ": " << env["out"].value;
    }
}

// The plugin reads `pm` as it was when chai loaded, so a script that replaces
// the global afterwards neither breaks the assertions nor redirects them.
// Mutation: read the global `pm` inside the methods and the verdict is a
// TypeError about the target.
TEST_F (ScriptEngineTest, RequireChaiResponseAssertionsSurviveAReplacedPm) {
    ScriptEngine roomy{ library_call_config () };
    response.status_code = 404;
    const auto result    = roomy.execute_test (R"JS(
        var expect = require('chai').expect;
        var realPm = pm;
        pm = { response: { to: { have: { status: function () { throw new Error('hijacked'); } } } } };
        var out;
        try { expect(realPm.response).to.have.status(404); out = 'held'; }
        catch (e) { out = e.name + ': ' + e.message; }
        pm = realPm;
        pm.environment.set('out', out);
    )JS",
    request, response, env);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["out"].value, "held");
}

// A response-less execution has no `pm.response.to`; the assertion says so
// rather than reading a missing object.
TEST_F (ScriptEngineTest, RequireChaiResponseAssertionsNeedAResponse) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_NE (
    shelf_answer (roomy, request,
    "(function () { try { require('chai').expect(pm.response).to.have."
    "status(200); return 'held'; } catch (e) { return e.name + ': ' + "
    "e.message; } })()")
    .find ("needs a response"),
    std::string::npos);
}

// The plugin is applied when the module is evaluated and the module is cached
// for the execution, so a second require answers the same, already-extended
// object without evaluating chai again.
TEST_F (ScriptEngineTest, RequireChaiResponseAssertionsApplyOncePerExecution) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    const auto result   = roomy.execute_test (R"JS(
        var first = require('chai');
        var second = require('chai');
        pm.environment.set('same', String(first === second));
        second.expect(pm.response).to.have.status(200);
    )JS",
    request, response, env);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["same"].value, "true");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);
}

// The glue's `module` is the factory's and the bundle defines nothing outside
// itself, so the global object gains nothing and there is no `chai` global.
TEST_F (ScriptEngineTest, RequireShelfChaiLeavesNoGlobalBehind) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var before = Object.getOwnPropertyNames(globalThis)"
    ".sort().join(); require('chai').expect(1).to.equal(1); return "
    "Object.getOwnPropertyNames(globalThis).sort().join() === before; "
    "})()"),
    "true");
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(require('chai'), [typeof chai, typeof module, typeof exports, "
    "typeof process, typeof window, typeof AssertionError].join(' '))"),
    "undefined undefined undefined undefined undefined undefined");
}

TEST_F (ScriptEngineTest, RequireShelfChaiRefusesEveryOtherPath) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    for (const char* name : { "chai/lib/chai", "chai/register-should", "chai/",
         "Chai", "chai-postman", "deep-eql", "loupe" }) {
        const std::string refusal =
        shelf_answer (engine, request, "require('" + std::string (name) + "')");
        EXPECT_NE (refusal.find ("Cannot find module '" + std::string (name) + "'"),
        std::string::npos)
        << refusal;
    }
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a refused name evaluated a library";
}

// chai is evaluated on an execution's first require('chai'), once however
// often it is required, and never by a script that does not ask for it.
// Mutation: evaluate the shelf in `setup_require_shelf` and the first count
// fails.
TEST_F (ScriptEngineTest, RequireShelfChaiEvaluatesOnlyOnFirstUse) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (roomy, request, "typeof require + typeof pm.expect"),
    "functionfunction");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    EXPECT_EQ (shelf_answer (roomy, request,
               "require('chai') === require('chai') && typeof "
               "require('chai').expect"),
    "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);

    EXPECT_EQ (shelf_answer (roomy, request, "typeof require('chai').assert"), "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 2);
}

// require('ajv') is npm's ajv 6.12.5, the version Postman's sandbox bundles
// (#2656): the Ajv constructor, draft-07. Every answer was checked against the
// unbundled package on Node.
TEST_F (ScriptEngineTest, RequireShelfAjvCompilesAndValidates) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    // ajv compiles each schema into a function with `new Function`; the
    // sandbox allows it.
    { "new Function('a', 'b', 'return a + b')(2, 3)", "5" },
    { "typeof require('ajv')", "function" },
    { "(function () { var Ajv = require('ajv'); var v = new Ajv().compile({ "
      "type: 'object', properties: { id: { type: 'integer' } }, required: "
      "['id'] }); return [v({ id: 7 }), v.errors, v({ id: '7' }), "
      "JSON.stringify(v.errors)].join('|'); })()",
    "true||false|[{\"keyword\":\"type\",\"dataPath\":\".id\",\"schemaPath\":"
    "\"#/properties/id/type\",\"params\":{\"type\":\"integer\"},\"message\":"
    "\"should be integer\"}]" },
    { "(function () { var ajv = new (require('ajv'))({ allErrors: true }); "
      "var ok = ajv.validate({ properties: { a: { type: 'string' }, b: { "
      "minimum: 3 } } }, { a: 1, b: 2 }); return ok + ' ' + "
      "ajv.errors.length + ' ' + ajv.errorsText(); })()",
    "false 2 data.a should be string, data.b should be >= 3" },
    // Callable without `new`, as ajv 6 is.
    { "(function () { var v = require('ajv')().compile({ const: 'x' }); "
      "return v('x') + ' ' + v('y'); })()",
    "true false" },
    { "(function () { var v = new (require('ajv'))().compile({ if: { "
      "properties: { kind: { const: 'a' } } }, then: { required: ['a'] }, "
      "else: { required: ['b'] } }); return [v({ kind: 'a', a: 1 }), v({ "
      "kind: 'a', b: 1 }), v({ kind: 'z', b: 1 })].join(); })()",
    "true,false,true" },
    { "(function () { var v = new (require('ajv'))().compile({ type: "
      "'string', format: 'email' }); return v('a@example.com') + ' ' + "
      "v('nope'); })()",
    "true false" },
    { "(function () { var v = new (require('ajv'))().compile({ definitions: "
      "{ id: { type: 'integer', minimum: 1 } }, properties: { id: { $ref: "
      "'#/definitions/id' } } }); return v({ id: 1 }) + ' ' + v({ id: 0 }) + "
      "' ' + v.errors[0].message; })()",
    "true false should be >= 1" },
    { "(function () { var ajv = new (require('ajv'))(); ajv.addSchema({ $id: "
      "'user', type: 'object', required: ['name'] }); return "
      "ajv.validate('user', { name: 'a' }) + ' ' + ajv.validate('user', {}); "
      "})()",
    "true false" },
    { "(function () { try { new (require('ajv'))().compile({ type: 'nope' }); "
      "} catch (e) { return e.message; } })()",
    "schema is invalid: data.type should be equal to one of the allowed "
    "values, data.type should be array, data.type should match some schema "
    "in anyOf" },
    { "(function () { var Ajv = require('ajv'); try { new Ajv().compile({ "
      "$ref: 'missing.json' }); } catch (e) { return (e instanceof "
      "Ajv.MissingRefError) + ' ' + e.missingRef; } })()",
    "true missing.json" },
    { "Object.keys(require('ajv')).join()", "ValidationError,MissingRefError,$dataMetaSchema" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// A validator compiled once runs inside a pm.test like any other code, and a
// failed check is an ordinary failed test.
TEST_F (ScriptEngineTest, RequireShelfAjvInsidePmTest) {
    ScriptEngine roomy{ library_call_config () };
    response.status_code = 200;
    response.body        = R"({"id":7,"name":"ada"})";
    const auto result    = roomy.execute_test (R"JS(
        const Ajv = require('ajv');
        const validate = new Ajv().compile({
            type: 'object',
            properties: { id: { type: 'integer' }, name: { type: 'string', minLength: 4 } },
            required: ['id', 'name'],
        });
        pm.test('holds', function () {
            pm.expect(validate({ id: 1, name: 'grace' })).to.be.true;
        });
        pm.test('fails', function () {
            pm.expect(validate(pm.response.json()), JSON.stringify(validate.errors)).to.be.true;
        });
    )JS",
    request, response, env);

    EXPECT_FALSE (result.success);
    EXPECT_EQ (result.error_message, "");
    ASSERT_EQ (result.tests.size (), 2u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_FALSE (result.tests[1].passed);
    EXPECT_NE (result.tests[1].error_message.find (
               "should NOT be shorter than 4 characters"),
    std::string::npos)
    << result.tests[1].error_message;
}

// require('tv4') is npm's tv4 1.3.0, Postman's bundled draft-04 validator
// (#2656); it keeps the last verdict on itself. Checked against the
// unbundled package on Node.
TEST_F (ScriptEngineTest, RequireShelfTv4ValidatesAndReportsTheError) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "[tv4.validate({ id: 7 }, { type: 'object', properties: { id: { type: "
      "'integer' } } }), tv4.error, tv4.valid].join('|')",
    "true||true" },
    { "(function () { var ok = require('tv4').validate({ id: '7' }, { type: "
      "'object', properties: { id: { type: 'integer' } } }); var e = "
      "tv4.error; return [ok, e.message, e.code, e.dataPath, e.schemaPath, "
      "e.name, e instanceof Error, tv4.valid].join('|'); })()",
    "false|Invalid type: string (expected integer)|0|/id|/properties/id/"
    "type|ValidationError|true|false" },
    { "(function () { var r = tv4.validateMultiple({ a: 1, b: 2 }, { "
      "properties: { a: { type: 'string' }, b: { minimum: 3 } } }); return "
      "r.valid + ' ' + r.errors.map(function (e) { return e.message; "
      "}).join('; '); })()",
    "false Invalid type: number (expected string); Value 2 is less than "
    "minimum 3" },
    { "(function () { var r = tv4.validateResult({}, { required: ['id'] }); "
      "return [r.valid, r.error.message, r.error.code, tv4.error].join('|'); "
      "})()",
    "false|Missing required property: id|302|" },
    // The shelf evaluates tv4 in strict mode, so a detached call has no
    // object to record its verdict on.
    { "(function () { try { var v = tv4.validate; v(1, { type: 'string' }); "
      "return 'ran'; } catch (e) { return e.name; } })()",
    "TypeError" },
    { "(function () { var ok = tv4.validate({ a: 1 }, { properties: { a: { "
      "$ref: 'http://example.com/a.json' } } }); return ok + ' ' + "
      "tv4.missing.join(); })()",
    "true http://example.com/a.json" },
    { "Object.keys(tv4).join()",
    "setErrorReporter,addFormat,language,addLanguage,freshApi,validate,"
    "validateResult,validateMultiple,addSchema,getSchema,getSchemaMap,"
    "getSchemaUris,getMissingUris,dropSchemas,defineKeyword,defineError,reset,"
    "missing,error,valid,normSchema,resolveUrl,getDocumentUri,errorCodes,tv4" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// The tv4 global is require('tv4'), whichever is read first, so a verdict
// one records the other reads, as in Postman.
TEST_F (ScriptEngineTest, RequireShelfTv4GlobalIsTheModule) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (shelf_answer (roomy, request,
               "typeof tv4 + ' ' + (tv4 === require('tv4')) + ' ' + (tv4.tv4 "
               "=== tv4)"),
    "object true true");
    EXPECT_EQ (shelf_answer (roomy, request,
               "(require('tv4') === tv4) + ' ' + (require('tv4').validate(1, "
               "{ type: 'string' }), tv4.error.message)"),
    "true Invalid type: number (expected string)");
    EXPECT_EQ (shelf_answer (roomy, request,
               "(tv4.validate(1, { type: 'string' }), "
               "require('tv4').error.message)"),
    "Invalid type: number (expected string)");
}

// The glues' `module` and `exports` are the factories', and neither library
// defines anything outside itself: the global object gains nothing beyond
// the tv4 accessor's own value, and there is no Ajv global.
TEST_F (ScriptEngineTest, RequireShelfAjvAndTv4LeaveNoGlobalBehind) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (shelf_answer (roomy, request,
               "(function () { var before = "
               "Object.getOwnPropertyNames(globalThis).sort().join(); "
               "require('ajv')().compile({ type: 'string' })('x'); "
               "require('tv4').validate(1, { type: 'string' }); return "
               "Object.getOwnPropertyNames(globalThis).sort().join() === "
               "before; })()"),
    "true");
    EXPECT_EQ (shelf_answer (roomy, request,
               "(require('ajv'), require('tv4'), [typeof Ajv, typeof module, "
               "typeof exports, typeof define].join(' '))"),
    "undefined undefined undefined undefined");
}

TEST_F (ScriptEngineTest, RequireShelfAjvAndTv4RefuseEveryOtherPath) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    for (const char* name : { "ajv/lib/ajv", "ajv/dist/ajv.min.js", "Ajv",
         "ajv-formats", "uri-js", "tv4/tv4", "TV4", "tv4.js" }) {
        const std::string refusal =
        shelf_answer (engine, request, "require('" + std::string (name) + "')");
        EXPECT_NE (refusal.find ("Cannot find module '" + std::string (name) + "'"),
        std::string::npos)
        << refusal;
    }
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a refused name evaluated a library";
}

// ajv is evaluated on an execution's first require('ajv'), once however often
// it is required, and never by a script that does not ask for it. Mutation:
// evaluate the shelf in `setup_require_shelf` and the first count fails.
TEST_F (ScriptEngineTest, RequireShelfAjvEvaluatesOnlyOnFirstUse) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (roomy, request, "typeof require"), "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    EXPECT_EQ (shelf_answer (roomy, request,
               "require('ajv') === require('ajv') && typeof "
               "require('ajv')().compile"),
    "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);

    EXPECT_EQ (shelf_answer (roomy, request, "typeof require('ajv')"), "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 2);
}

// tv4 likewise, through the global or require, and the global's accessor and
// require share the one evaluation. Mutation: evaluate the shelf in
// `setup_require_shelf` and the first count fails.
TEST_F (ScriptEngineTest, RequireShelfTv4EvaluatesOnlyOnFirstUse) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (roomy, request, "typeof require"), "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    EXPECT_EQ (shelf_answer (roomy, request, "typeof tv4.validate + ' ' + (require('tv4') === tv4)"),
    "function true");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);

    EXPECT_EQ (shelf_answer (roomy, request, "typeof require('tv4').validate"), "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 2);
}

// A library's parse depth is Vayu's own, not the script's to budget (#2652):
// MSVC at /Od under ASan has frames large enough that lodash and moment
// overflowed the default 256 KB budget inside QuickJS's parser. A fixed small
// budget cannot stand in for that, because the toolchain decides what a frame
// costs: 24 KB runs a trivial script on GCC at -O0 and cannot on macOS under
// ASan. So the budget is found at run time, the smallest one at which both
// wrappers the tests put around a library run here, library-free. A library
// needs well over that on every toolchain, so without the raise the load fails
// with the RangeError "Maximum call stack size exceeded" and with it the
// library loads. Measured, KB of budget, without the raise:
//   GCC -O0:  wrappers run at 14, moment loads from 29, lodash from 45
//   GCC -O3:  wrappers run at 12, moment loads from 22, lodash from 33
// The raise must also end with the library: recursion afterwards reaches the
// depth it reached before the require (healthy: equal, 7 at -O0 and 19 at -O3),
// not the depth the 768 KB library budget allows (broken: 580 and 1112).
namespace {

/// Script text that defines `depth ()`, the number of calls a runaway
/// recursion makes before the interpreter's RangeError.
constexpr const char* DEPTH_PROBE = R"(
    function depth() {
        var reached = 0;
        function descend() { reached++; descend(); }
        try { descend(); } catch (e) { if (!(e instanceof RangeError)) { throw e; } }
        return reached;
    }
)";

ScriptConfig shallow_stack_config (std::size_t budget) {
    ScriptConfig config;
    config.stack_size = budget;
    return config;
}

/// An expression that makes the same native call a library load starts with,
/// `require (...)`, and is refused before any library is evaluated.
constexpr const char* REFUSED_REQUIRE =
"(function () { try { require('absent'); } catch (e) { return 'refused'; } "
"})()";

/// The smallest stack budget, climbing 8 KB in 2 KB steps to 256 KB, at which
/// both wrappers the tests put around a library run on this build: the
/// recursion probe, and a script that calls `require` (a native call checks the
/// stack before it is entered, so it needs more than a bare script does). 0
/// when none does.
std::size_t shallowest_working_stack (Request& request) {
    constexpr std::size_t KIB = 1024;
    for (std::size_t budget = 8 * KIB; budget <= 256 * KIB; budget += 2 * KIB) {
        ScriptEngine candidate{ shallow_stack_config (budget) };
        Environment probe_env;
        const auto depth_result = candidate.execute_prerequest (
        std::string (DEPTH_PROBE) + "pm.environment.set('d', String(depth()));",
        request, probe_env);
        if (depth_result.success &&
        shelf_answer (candidate, request, REFUSED_REQUIRE) == "refused") {
            return budget;
        }
    }
    return 0;
}

} // namespace

// Only the load is asserted: calling into lodash is the script's own stack and
// needs more than the wrappers' budget.
TEST_F (ScriptEngineTest, RequireShelfLibrariesLoadUnderAShallowInterpreterStack) {
    const std::size_t budget = shallowest_working_stack (request);
    ASSERT_GT (budget, 0u) << "no budget up to 256 KB ran the wrapper scripts";
    ScriptEngine shallow{ shallow_stack_config (budget) };
    EXPECT_EQ (shelf_answer (shallow, request, "typeof require('lodash').get"), "function")
    << "at " << budget << " bytes";
    EXPECT_EQ (shelf_answer (shallow, request, "typeof require('moment').utc"), "function")
    << "at " << budget << " bytes";
    EXPECT_EQ (shelf_answer (shallow, request, "typeof require('csv-parse/lib/sync')"), "function")
    << "at " << budget << " bytes";
    EXPECT_EQ (shelf_answer (shallow, request, "typeof require('xml2js').parseString"), "function")
    << "at " << budget << " bytes";
    EXPECT_EQ (shelf_answer (shallow, request, "typeof xml2Json"), "function")
    << "at " << budget << " bytes";
    EXPECT_EQ (shelf_answer (shallow, request, "typeof require('chai').expect"), "function")
    << "at " << budget << " bytes";
    EXPECT_EQ (shelf_answer (shallow, request, "typeof require('ajv')"), "function")
    << "at " << budget << " bytes";
    EXPECT_EQ (shelf_answer (shallow, request, "typeof tv4.validate"), "function")
    << "at " << budget << " bytes";
    EXPECT_EQ (shelf_answer (shallow, request, "typeof _.get"), "function")
    << "at " << budget << " bytes";
}

TEST_F (ScriptEngineTest, RequireShelfRestoresTheScriptsStackBudgetAfterALibraryLoads) {
    const std::size_t budget = shallowest_working_stack (request);
    ASSERT_GT (budget, 0u) << "no budget up to 256 KB ran the wrapper scripts";
    ScriptEngine shallow{ shallow_stack_config (budget) };
    Environment shallow_env;
    const auto result = shallow.execute_prerequest (std::string (DEPTH_PROBE) + R"(
        var before = depth();
        require('lodash');
        require('moment');
        var after = depth();
        pm.environment.set('before', String(before));
        pm.environment.set('after', String(after));
    )",
    request, shallow_env);

    ASSERT_TRUE (result.success) << result.error_message << " at " << budget << " bytes";
    const auto before = std::stoul (shallow_env["before"].value);
    const auto after  = std::stoul (shallow_env["after"].value);
    ASSERT_GT (before, 0u);
    EXPECT_LE (after, before + (before / 2))
    << "recursion after require() ran under the library's budget, not the "
       "script's (budget "
    << budget << " bytes)";
}

// The defect #2578 measured: a crypto-js signing script failed and the request
// went out unsigned. Asserted on what the server received.
TEST_F (ScriptEngineTest, RequireShelfSignedHeaderReachesTheWire) {
    vayu::http::global_init ();
    {
        const vayu::tests::EchoServer server;
        Request signed_request;
        signed_request.method       = HttpMethod::POST;
        signed_request.url          = server.url ();
        signed_request.body.mode    = BodyMode::Text;
        signed_request.body.content = JEFE_MESSAGE;

        vayu::http::CookieJar jar;
        vayu::http::routes::ScriptVariableScopes scopes;
        vayu::http::routes::ExchangeInputs inputs;
        inputs.request     = std::move (signed_request);
        inputs.elements    = vayu::tests::step_elements_with_pre_script (R"JS(
            var CryptoJS = require('crypto-js');
            var signature = CryptoJS.HmacSHA256(pm.request.body.toString(), 'Jefe');
            pm.request.headers.upsert({ key: 'X-Signature', value: signature.toString(CryptoJS.enc.Hex) });
        )JS");
        const auto outcome = vayu::http::routes::execute_exchange (
        engine, jar, "", scopes, std::move (inputs));

        ASSERT_EQ (outcome.response.status_code, 200);
        EXPECT_EQ (server.header ("X-Signature"),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }
    vayu::http::global_cleanup ();
}
