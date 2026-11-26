/**
 * @file script_engine_expect_test.cpp
 * @brief pm.test() and the first half of pm.expect(): the basic assertions, equal vs eql
 *        and the deep/nested chainers.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>

#include <chrono>
#include <cstddef>
#include <string>
#include <vector>

#include "script_engine_fixture.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

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
