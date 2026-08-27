/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/script_assertion_error_test.cpp
 * @brief A failed assertion is an `AssertionError`, not a `TypeError` (#487).
 *
 * `pm.expect` is chai, and chai names a broken assertion `AssertionError`.
 * Throwing `TypeError` cost two things a script author can see: the report
 * prefixed every failure with the name of an engine fault, and a script that
 * branches on `e.name` - the form imported Postman scripts use - took the wrong
 * branch. So the assertions here are on the *name*, from both directions: what
 * the report prints, and what the script catches.
 *
 * The boundary is the other half of the contract and is tested just as hard: a
 * mistake in the script text (a matcher called with no argument, a name that
 * does not exist) is still a `TypeError`, because nothing was asserted - the
 * call itself was wrong. A change that renamed those too would pass every
 * name-is-AssertionError test here and still be wrong.
 *
 * Mutation-check: point `throw_assertion_failure` back at `JS_ThrowTypeError`
 * and every test in the first two sections fails while the boundary section
 * stays green.
 */

#include <gtest/gtest.h>

#include <string>
#include <vector>

#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

namespace {

class AssertionErrorTest : public ::testing::Test {
    protected:
    ScriptEngine engine;
    Request request;
    Response response;
    Environment env;

    void SetUp () override {
        request.method       = HttpMethod::GET;
        request.url          = "https://api.example.com/users";
        response.status_code = 200;
        response.headers     = { { "Content-Type", "application/json" } };
        response.body        = R"({"id": 1})";
    }

    /** Runs one assertion inside a `pm.test` and returns what the report shows. */
    std::string failure_of (const std::string& assertion) {
        const std::string script = "pm.test(\"t\", function() {\n" + assertion + ";\n});";
        auto result = engine.execute_test (script, request, response, env);
        if (result.tests.size () != 1u) {
            return "<no test recorded for: " + assertion + ">";
        }
        if (result.tests[0].passed) {
            return "<passed, expected a failure: " + assertion + ">";
        }
        return result.tests[0].error_message;
    }

    /**
     * Runs one assertion and reports what a *script* sees of the thrown error,
     * as `name|instanceof Error|message`. This is the branch imported Postman
     * scripts take, so it is checked from inside the sandbox rather than
     * inferred from the printed string.
     */
    std::string caught_shape_of (const std::string& assertion) {
        const std::string script = "try { " + assertion +
        "; console.log(\"<did not throw>\"); } catch (e) { console.log("
        "e.name + \"|\" + (e instanceof Error) + \"|\" + e.message); }";
        auto result = engine.execute_test (script, request, response, env);
        if (result.console_output.empty ()) {
            return "<nothing logged for: " + assertion + ">";
        }
        return result.console_output[0].message;
    }

    static bool starts_with (const std::string& haystack, const std::string& prefix) {
        return haystack.rfind (prefix, 0) == 0;
    }
};

// ----------------------------------------------------------------------------
// pm.expect
// ----------------------------------------------------------------------------

/** The owner's case from #487: the report reads as a failed assertion. */
TEST_F (AssertionErrorTest, ExpectFailureIsReportedAsAnAssertionError) {
    EXPECT_EQ (failure_of (R"(pm.expect(1).to.equal(2))"),
    "AssertionError: Expected 1 to equal 2");
}

/** The other visible consequence: `catch (e) { if (e.name === ...) }`. */
TEST_F (AssertionErrorTest, AScriptCatchesAnErrorNamedAssertionError) {
    EXPECT_EQ (caught_shape_of (R"(pm.expect(1).to.equal(2))"),
    "AssertionError|true|Expected 1 to equal 2");
}

/**
 * Every matcher, not one. The name is applied in a single helper, so a matcher
 * that threw around it would be invisible to a test that checked one chain -
 * the same argument the #484 message sweep is built on.
 */
TEST_F (AssertionErrorTest, EveryMatcherFailsWithTheAssertionErrorName) {
    const std::vector<std::string> failing_assertions = {
        R"(pm.expect(1).to.equal(2))",
        R"(pm.expect({a:1}).to.eql({a:2}))",
        R"(pm.expect({a:1}).to.deep.equal({a:2}))",
        R"(pm.expect(undefined).to.exist)",
        R"(pm.expect(false).to.be.true)",
        R"(pm.expect(true).to.be.false)",
        R"(pm.expect(1).to.be.null)",
        R"(pm.expect(1).to.be.undefined)",
        R"(pm.expect(0).to.be.ok)",
        R"(pm.expect([1]).to.be.empty)",
        R"(pm.expect(1).to.be.above(2))",
        R"(pm.expect(2).to.be.below(1))",
        R"(pm.expect(1).to.be.at.least(2))",
        R"(pm.expect(2).to.be.at.most(1))",
        R"(pm.expect(1).to.be.a("string"))",
        R"(pm.expect(1).to.be.an("array"))",
        R"(pm.expect(1).to.be.instanceOf(Array))",
        R"(pm.expect(1).to.be.oneOf([2, 3]))",
        R"(pm.expect(1).to.be.closeTo(5, 0.1))",
        R"(pm.expect([1]).to.include(2))",
        R"(pm.expect("ab").to.have.string("zz"))",
        R"(pm.expect("ab").to.match(/zz/))",
        R"(pm.expect([1]).to.have.length(2))",
        R"(pm.expect({a:1}).to.have.property("b"))",
        R"(pm.expect({a:{b:1}}).to.have.nested.property("a.c"))",
        R"(pm.expect([1]).to.have.members([2]))",
        R"(pm.expect(function() {}).to.throw())",
    };

    for (const auto& assertion : failing_assertions) {
        const std::string reported = failure_of (assertion);
        EXPECT_TRUE (starts_with (reported, "AssertionError: "))
        << assertion << " -> " << reported;
    }
}

/** Negated chains fail through the same helper, so they carry the name too. */
TEST_F (AssertionErrorTest, ANegatedChainFailsWithTheAssertionErrorName) {
    EXPECT_EQ (failure_of (R"(pm.expect(1).to.not.equal(1))"),
    "AssertionError: Expected 1 to not equal 1");
}

/**
 * #484's custom message still prefixes the failure. Renaming the error must not
 * cost the context the script wrote - both survive together or the fix traded
 * one report defect for another.
 */
TEST_F (AssertionErrorTest, TheCustomMessagePrefixSurvivesTheRename) {
    EXPECT_EQ (failure_of (R"(pm.expect(false, "user 42").to.be.true)"),
    "AssertionError: user 42: Expected value to be truthy");
    EXPECT_EQ (caught_shape_of (R"(pm.expect(false, "user 42").to.be.true)"),
    "AssertionError|true|user 42: Expected value to be truthy");
}

// ----------------------------------------------------------------------------
// pm.response.to - chai in Postman as much as pm.expect is
// ----------------------------------------------------------------------------

TEST_F (AssertionErrorTest, ResponseAssertionsFailWithTheAssertionErrorName) {
    EXPECT_EQ (failure_of (R"(pm.response.to.have.status(404))"),
    "AssertionError: Expected status code 404 but got 200");
    EXPECT_EQ (failure_of (R"(pm.response.to.have.header("X-Missing"))"),
    "AssertionError: Expected response to have header 'X-Missing'");
    EXPECT_EQ (failure_of (R"(pm.response.to.have.header("Content-Type", "text/plain"))"),
    "AssertionError: Expected header 'Content-Type' to be 'text/plain' but got "
    "'application/json'");
    EXPECT_EQ (failure_of (R"(pm.response.to.have.body("nope"))"),
    "AssertionError: Expected response body to be 'nope' but got '{\"id\": "
    "1}'");
    EXPECT_EQ (failure_of (R"(pm.response.to.have.jsonBody("missing"))"),
    "AssertionError: Expected response body to have property 'missing'");
    EXPECT_EQ (failure_of (R"(pm.response.to.be.notFound)"),
    "AssertionError: Expected response to have status 404 but got 200");
}

/**
 * The verdicts #998 corrected report what they compared, because each of them
 * used to report nothing at all: the assertion passed. A message naming only
 * the matcher would leave the reader of a newly-red suite with no way to see
 * which half of the comparison moved.
 */
TEST_F (AssertionErrorTest, TheCorrectedVerdictsNameBothSidesOfTheComparison) {
    EXPECT_EQ (failure_of (R"(pm.response.to.have.jsonBody("id", 2))"),
    "AssertionError: Expected response body property 'id' to deeply equal 2 "
    "but got 1");
    EXPECT_EQ (failure_of (R"(pm.response.to.have.status("Not Found"))"),
    "AssertionError: Expected status reason 'Not Found' but got 'OK'");
    EXPECT_EQ (failure_of (R"(pm.response.to.have.header("Content-Type", 5))"),
    "AssertionError: Expected header 'Content-Type' to be 5 but got "
    "'application/json'");
    EXPECT_EQ (failure_of (R"(pm.response.to.have.body(/nope/))"),
    "AssertionError: Expected response body to match the pattern but got "
    "'{\"id\": 1}'");
    EXPECT_EQ (failure_of (R"(pm.response.to.have.body({ id: 2 }))"),
    "AssertionError: Expected response body to deeply equal {\"id\":2} but got "
    "'{\"id\": 1}'");
}

/** The body-shape assertions read the body rather than the status. */
TEST_F (AssertionErrorTest, BodyShapeAssertionsFailWithTheAssertionErrorName) {
    response.body = "not json";

    EXPECT_EQ (failure_of (R"(pm.response.to.be.json)"),
    "AssertionError: Expected response body to be valid JSON");
    EXPECT_EQ (failure_of (R"(pm.response.to.have.jsonBody())"),
    "AssertionError: Response body is not valid JSON");

    response.body = "";
    EXPECT_EQ (failure_of (R"(pm.response.to.be.withBody)"),
    "AssertionError: Expected response to have a body");
}

// ----------------------------------------------------------------------------
// The boundary: a mistake in the script is not a failed assertion
// ----------------------------------------------------------------------------

/**
 * A matcher called wrongly asserted nothing, so naming it `AssertionError`
 * would report a passing API as a failing one. chai draws the line in the same
 * place, and `throw_expect_failure`'s comment has said so since #484.
 */
TEST_F (AssertionErrorTest, AMisusedMatcherIsStillATypeError) {
    const std::vector<std::string> usage_errors = {
        R"(pm.expect(1).to.equal())",
        R"(pm.expect(1).to.be.above())",
        R"(pm.expect(1).to.be.below())",
        R"(pm.expect(1).to.be.a())",
        R"(pm.expect([1]).to.have.members("nope"))",
        R"(pm.expect(1).to.be.instanceOf("Array"))",
        R"(pm.expect(1).to.throw())",
        R"(pm.response.to.have.status())",
        R"(pm.response.to.have.body(5))",
        R"(pm.response.to.have.body(null))",
    };

    for (const auto& usage_error : usage_errors) {
        const std::string reported = failure_of (usage_error);
        EXPECT_TRUE (starts_with (reported, "TypeError: "))
        << usage_error << " -> " << reported;
    }
}

/**
 * A name nothing implements is a misspelling, not a failure - the loud throw
 * that stops `pm.response.to.not.be.ok` from silently passing keeps reporting
 * itself as the script-text mistake it is.
 */
TEST_F (AssertionErrorTest, AnUnsupportedResponseAssertionIsStillATypeError) {
    EXPECT_TRUE (starts_with (
    failure_of (R"(pm.response.to.be.definitelyNotAMatcher)"), "TypeError: "))
    << failure_of (R"(pm.response.to.be.definitelyNotAMatcher)");
    EXPECT_TRUE (starts_with (failure_of (R"(pm.response.to.not.be.ok)"), "TypeError: "))
    << failure_of (R"(pm.response.to.not.be.ok)");
}

/**
 * `pm.response.json()` is a reader, not an assertion: a body that does not
 * parse is the same `TypeError` Postman throws there, and renaming it would
 * claim an assertion the script never wrote.
 */
TEST_F (AssertionErrorTest, ResponseJsonParseFailureIsStillATypeError) {
    response.body = "not json";
    EXPECT_EQ (caught_shape_of (R"(pm.response.json())"),
    "TypeError|true|Response body is not valid JSON");
}

// ----------------------------------------------------------------------------
// Shape of the error object
// ----------------------------------------------------------------------------

/**
 * The renamed error is a real `Error`: it keeps the stack a native throw gets,
 * and `message` stays non-enumerable the way every built-in error's is, so a
 * script that serializes what it caught sees what it always did.
 */
TEST_F (AssertionErrorTest, TheAssertionErrorKeepsTheShapeOfANativeError) {
    const std::string script =
    R"(try { pm.expect(1).to.equal(2); } catch (e) {
         console.log("stack=" + (typeof e.stack === "string" && e.stack.length > 0));
         console.log("json=" + JSON.stringify(e));
         console.log("string=" + String(e));
       })";

    auto result = engine.execute_test (script, request, response, env);
    ASSERT_EQ (result.console_output.size (), 3u);
    EXPECT_EQ (result.console_output[0].message, "stack=true");
    EXPECT_EQ (result.console_output[1].message, "json={}");
    EXPECT_EQ (result.console_output[2].message, "string=AssertionError: Expected 1 to equal 2");
}

} // namespace
