/**
 * @file script_engine_response_test.cpp
 * @brief pm.response: its assertions, cookies and the header accessors.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <string>

#include "script_engine_fixture.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

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
