/**
 * @file script_engine_test.cpp
 * @brief Tests for QuickJS scripting engine
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <regex>

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
// is part of the contract. Installed on top of QuickJS's built-ins: `console`,
// `pm`, and `btoa` / `atob` (#187). Still absent: a URL parser and anything
// asynchronous. This pins both halves so a doc example cannot come to rely on
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

TEST_F (ScriptEngineTest, NoUrlParserOrAsyncSurfaceIsExposed) {
    auto result = engine.execute_prerequest (R"JS(
        var present = [];
        var absent = ['crypto', 'TextEncoder', 'URL', 'URLSearchParams',
                      'require', 'fetch', 'setTimeout'];
        for (var i = 0; i < absent.length; i++) {
            if (typeof globalThis[absent[i]] !== 'undefined') present.push(absent[i]);
        }
        pm.environment.set('present', present.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    // If one of these ever lands, the "what a script can compute" section in
    // scripting.md stops being true and should be rewritten, not left standing.
    // `crypto` in particular: a global of that name is a promise of Web Crypto,
    // which is async, and nothing drains this sandbox's job queue - which is
    // why the hashing surface is pm.crypto and synchronous.
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
// pair, same single pass, raw stored strings.
TEST_F (ScriptEngineTest, ReplaceInResolvesScopesLikeTheRequestFieldsDo) {
    Environment globals;
    globals["everywhere"] = Variable{ "from-globals", false, true };
    Environment collVars;
    collVars["everywhere"] = Variable{ "from-collection", false, true };
    collVars["nested"]     = Variable{ "{{everywhere}}", false, true };
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
        // Single pass, like every other {{}} in Vayu: a value containing
        // {{other}} stays literal rather than being rescanned.
        pm.globals.set('singlePass', pm.variables.replaceIn('{{nested}}'));
    )JS",
    ctx);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (globals["winner"].value, "from-environment");
    EXPECT_EQ (globals["unknownPlain"].value, "[]");
    EXPECT_EQ (globals["unknownDollar"].value, "{{$notAGenerator}}");
    EXPECT_EQ (globals["definedDollar"].value, "pinned-guid");
    EXPECT_EQ (globals["disabledIsInvisible"].value, "[]");
    EXPECT_EQ (globals["singlePass"].value, "{{everywhere}}");
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
