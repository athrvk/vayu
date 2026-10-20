// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// The `pm.response.to` members chai-postman 2.0.1 defines and Vayu refused
// by name until #2528: `not`, the status-code family, the response measures,
// `body()` with no argument, lodash paths in `jsonBody` and `jsonSchema` on
// both chains. Each member is asserted on a passing and a failing response,
// so one that passed unconditionally fails its own case.

#include <gtest/gtest.h>

#include <string>

#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

namespace {

class ResponseAssertionTest : public ::testing::Test {
    protected:
    ScriptEngine engine;
    Request request;
    Response response;
    Environment env;

    void SetUp () override {
        request.method       = HttpMethod::GET;
        request.url          = "https://api.example.com/users";
        response.status_code = 200;
        response.headers = { { "Content-Type", "application/json" }, { "X-Count", "5" } };
        response.body = R"({"id": 1, "name": "ada"})";
    }

    /** Runs one assertion inside a `pm.test`; the row it recorded. */
    TestResult run (const std::string& assertion) {
        const std::string script = "pm.test(\"t\", function() {\n" + assertion + ";\n});";
        auto result = engine.execute_test (script, request, response, env);
        if (result.tests.size () != 1u) {
            TestResult missing;
            missing.error_message = "<no test recorded: " + result.error_message + ">";
            return missing;
        }
        return result.tests[0];
    }

    /** Empty when the assertion passed, otherwise why it did not. */
    std::string verdict_of (const std::string& assertion) {
        const TestResult row = run (assertion);
        return row.passed ? std::string{} : row.error_message;
    }

    void expect_pass (const std::string& assertion) {
        EXPECT_EQ (verdict_of (assertion), "") << assertion;
    }

    /** Fails as an assertion, never as a script mistake, saying @p fragment. */
    void expect_assertion_failure (const std::string& assertion, const std::string& fragment) {
        const TestResult row = run (assertion);
        EXPECT_FALSE (row.passed) << assertion << " passed";
        EXPECT_NE (row.error_message.find ("AssertionError"), std::string::npos)
        << assertion << " -> " << row.error_message;
        EXPECT_NE (row.error_message.find (fragment), std::string::npos)
        << assertion << " -> " << row.error_message;
    }

    void expect_type_error (const std::string& assertion, const std::string& fragment) {
        const TestResult row = run (assertion);
        EXPECT_FALSE (row.passed) << assertion << " passed";
        EXPECT_NE (row.error_message.find ("TypeError"), std::string::npos)
        << assertion << " -> " << row.error_message;
        EXPECT_NE (row.error_message.find (fragment), std::string::npos)
        << assertion << " -> " << row.error_message;
    }
};

// ----------------------------------------------------------------------------
// not
// ----------------------------------------------------------------------------

TEST_F (ResponseAssertionTest, NotNegatesTheHaveCalls) {
    expect_pass ("pm.response.to.not.have.status(500)");
    expect_assertion_failure ("pm.response.to.not.have.status(200)", "to not be 200");
    expect_pass ("pm.response.to.not.have.status('Not Found')");
    expect_assertion_failure ("pm.response.to.not.have.status('OK')", "to not be 'OK'");
    expect_pass ("pm.response.to.not.have.header('X-Absent')");
    expect_assertion_failure ("pm.response.to.not.have.header('Content-Type')",
    "to not have header 'Content-Type'");
}

TEST_F (ResponseAssertionTest, NotNegatesTheBeGetters) {
    response.status_code = 500;
    expect_pass ("pm.response.to.not.be.ok");
    expect_pass ("pm.response.to.not.be.success");
    expect_assertion_failure (
    "pm.response.to.not.be.serverError", "to not have a 5xx status code");

    response.status_code = 200;
    expect_assertion_failure ("pm.response.to.not.be.ok", "to not have status 200");
    expect_pass ("pm.response.to.not.be.error");
    expect_assertion_failure ("pm.response.to.not.be.json", "to not be valid JSON");
    expect_assertion_failure ("pm.response.to.not.be.withBody", "to not have a body");

    response.body = "";
    expect_pass ("pm.response.to.not.be.json");
    expect_pass ("pm.response.to.not.be.withBody");
}

// chai's `not` sets the flag and never toggles it (#883's rule), so a second
// `not` is still negated rather than back to positive.
TEST_F (ResponseAssertionTest, NotSetsRatherThanToggles) {
    expect_assertion_failure ("pm.response.to.not.not.have.status(200)", "to not be 200");
    expect_pass ("pm.response.to.not.not.have.status(500)");
}

// chai-postman negates each of its checks on its own, in order, so a form that
// checks two things fails once the first one holds - the verdict Postman gives,
// which inverting the whole assertion would turn into a pass.
TEST_F (ResponseAssertionTest, NotNegatesEachCheckInChaiPostmansOrder) {
    expect_assertion_failure ("pm.response.to.not.have.header('X-Count', '6')",
    "to not have header 'X-Count'");
    expect_pass ("pm.response.to.not.have.header('X-Absent', 'v')");
    expect_assertion_failure (
    "pm.response.to.not.have.jsonBody('id', 2)", "to not have property 'id'");
    expect_pass ("pm.response.to.not.have.jsonBody('missing')");
    expect_pass ("pm.response.to.not.have.body('other')");
    expect_assertion_failure (
    R"(pm.response.to.not.have.body({ id: 1, name: "ada" }))", "to not deeply equal");
}

// The polarity is bound into each function, so a matcher read off `to.not`
// and called on its own still asserts the negation.
TEST_F (ResponseAssertionTest, ADetachedNegatedMatcherKeepsItsPolarity) {
    expect_pass ("var status = pm.response.to.not.have.status; status(500)");
    expect_assertion_failure (
    "var status = pm.response.to.not.have.status; status(200)", "to not be 200");
}

TEST_F (ResponseAssertionTest, AMisspelledMemberOfTheNegatedChainThrowsByName) {
    expect_type_error ("pm.response.to.not.have.stauts(200)",
    "pm.response.to.not.have.stauts is not a supported assertion");
}

// A failure message quotes the expected value through `js_describe`, which runs
// its `toJSON`; a check that held builds no message, so it never runs.
TEST_F (ResponseAssertionTest, APassingCheckDoesNotReadTheExpectedValueForAMessage) {
    response.body = R"({"user": {"id": 1}})";
    expect_pass (R"(
        var calls = 0;
        function quoted(value) {
            Object.defineProperty(value, "toJSON", { value: function () { calls++; return {}; } });
            return value;
        }
        pm.response.to.have.body(quoted({ user: { id: 1 } }));
        pm.response.to.have.jsonBody("user", quoted({ id: 1 }));
        pm.response.to.not.have.body(quoted({ user: { id: 2 } }));
        pm.expect(calls).to.equal(0))");
}

// ----------------------------------------------------------------------------
// The status family
// ----------------------------------------------------------------------------

TEST_F (ResponseAssertionTest, StatusCodeComparesTheNumberItIsGiven) {
    expect_pass ("pm.response.to.have.statusCode(200)");
    // chai-postman compares `Number(code)`, so a numeric string is that code.
    expect_pass ("pm.response.to.have.statusCode('200')");
    expect_assertion_failure ("pm.response.to.have.statusCode(201)",
    "Expected status code 201 but got 200");
    expect_pass ("pm.response.to.not.have.statusCode(201)");
    expect_type_error ("pm.response.to.have.statusCode(200.5)", "integer status code");
    expect_type_error ("pm.response.to.have.statusCode()", "requires");
}

TEST_F (ResponseAssertionTest, StatusReasonComparesThePhraseExactly) {
    response.status_code = 201;
    response.status_text = "Created";
    expect_pass ("pm.response.to.have.statusReason('Created')");
    expect_assertion_failure ("pm.response.to.have.statusReason('created')",
    "Expected status reason 'created' but got 'Created'");
    expect_pass ("pm.response.to.not.have.statusReason('OK')");
}

TEST_F (ResponseAssertionTest, StatusCodeClassComparesTheHundredsDigit) {
    response.status_code = 204;
    expect_pass ("pm.response.to.have.statusCodeClass(2)");
    expect_assertion_failure ("pm.response.to.have.statusCodeClass(4)",
    "to have a 4xx status code but got 204");
    expect_pass ("pm.response.to.not.have.statusCodeClass(5)");
    expect_assertion_failure ("pm.response.to.not.have.statusCodeClass(2)",
    "to not have a 2xx status code");
    // chai-postman compares with `===`; a string is a mistake, not a class.
    expect_type_error ("pm.response.to.have.statusCodeClass('2')", "status class digit");
}

TEST_F (ResponseAssertionTest, TheNewNamedCodesAssertOnBothSides) {
    struct Case {
        int matching;
        int other;
        const char* name;
    };
    for (const Case c : { Case{ 204, 200, "withoutContent" },
         Case{ 401, 403, "unauthorised" }, Case{ 406, 404, "notAcceptable" } }) {
        const std::string assertion = std::string ("pm.response.to.be.") + c.name;
        response.status_code = c.matching;
        expect_pass (assertion);
        response.status_code = c.other;
        expect_assertion_failure (assertion, std::to_string (c.other));
    }
}

// ----------------------------------------------------------------------------
// body() with no argument, and the measures
// ----------------------------------------------------------------------------

TEST_F (ResponseAssertionTest, BodyWithNoArgumentAssertsThereIsABody) {
    expect_pass ("pm.response.to.have.body()");
    expect_assertion_failure ("pm.response.to.not.have.body()", "to not have a body");
    response.body = "";
    expect_assertion_failure ("pm.response.to.have.body()", "to have a body");
    expect_pass ("pm.response.to.not.have.body()");
}

TEST_F (ResponseAssertionTest, ResponseSizeIsTheBodysBytes) {
    // Six bytes, five characters: the size is bytes, as size().body is.
    response.body = "h\xc3\xa9llo";
    expect_pass ("pm.expect(pm.response.responseSize).to.equal(6)");
    expect_pass (
    "pm.expect(pm.response.responseSize).to.equal(pm.response.size().body)");
}

TEST_F (ResponseAssertionTest, ResponseTimeIsACallAndAChain) {
    response.timing.total_ms = 120;
    expect_pass ("pm.response.to.have.responseTime.below(200)");
    expect_pass ("pm.response.to.have.responseTime.within(100, 150)");
    expect_assertion_failure ("pm.response.to.have.responseTime.above(200)",
    "Expected 120 to be above 200");
    expect_pass ("pm.response.to.not.have.responseTime.above(1000)");
    expect_assertion_failure (
    "pm.response.to.not.have.responseTime.below(1000)", "to not be below 1000");

    expect_pass ("pm.response.to.have.responseTime(120)");
    expect_assertion_failure ("pm.response.to.have.responseTime(121)",
    "Expected response time 120 to equal 121");
    // The call's first check is that the time is a number, which always holds,
    // so under `not` the call fails whatever it is given - Postman's verdict.
    expect_assertion_failure ("pm.response.to.not.have.responseTime(5)",
    "to not have a valid response time");
}

TEST_F (ResponseAssertionTest, ResponseSizeIsTheBodyAndTheHeaderTogether) {
    const std::string total =
    "(pm.response.size().body + pm.response.size().header)";
    expect_pass ("pm.response.to.have.responseSize(" + total + ")");
    expect_pass ("pm.response.to.have.responseSize.below(" + total + " + 1)");
    expect_assertion_failure (
    "pm.response.to.have.responseSize.above(" + total + ")", "to be above");
    expect_assertion_failure ("pm.response.to.have.responseSize(1)", "Expected response size");
}

// ----------------------------------------------------------------------------
// jsonBody's path is lodash's
// ----------------------------------------------------------------------------

TEST_F (ResponseAssertionTest, JsonBodyReadsAnArrayRoot) {
    response.body = R"([{"id": 1}, {"id": 2}])";
    expect_pass ("pm.response.to.have.jsonBody('[0].id', 1)");
    expect_pass ("pm.response.to.have.jsonBody('[1].id', 2)");
    expect_assertion_failure ("pm.response.to.have.jsonBody('[1].id', 1)", "to deeply equal 1");
    expect_assertion_failure (
    "pm.response.to.have.jsonBody('[2].id')", "to have property '[2].id'");
    expect_pass ("pm.response.to.have.jsonBody('[0]', { id: 1 })");
}

TEST_F (ResponseAssertionTest, JsonBodyReadsBracketedAndQuotedSegments) {
    response.body = R"({"a": {"b": [{"c": 3}, {"c": 4}, {"c": 5}]}, "it's": 7, "a.b": 9})";
    expect_pass ("pm.response.to.have.jsonBody('a.b[2].c', 5)");
    expect_pass ("pm.response.to.have.jsonBody(\"a['b'][0].c\", 3)");
    expect_pass (R"(pm.response.to.have.jsonBody('a["b"][1].c', 4))");
    expect_pass (R"(pm.response.to.have.jsonBody("['it\\'s']", 7))");
    // A key the root holds whole is read whole, as lodash's `isKey` does.
    expect_pass ("pm.response.to.have.jsonBody('a.b', 9)");
    expect_assertion_failure ("pm.response.to.have.jsonBody('a.b[3].c')", "to have property");
}

// `_.has` asks for an own property at every step: an array's `length` is one,
// what it inherits is not.
TEST_F (ResponseAssertionTest, JsonBodyReadsOwnPropertiesOnly) {
    response.body = R"({"items": [1, 2, 3]})";
    expect_pass ("pm.response.to.have.jsonBody('items.length', 3)");
    expect_assertion_failure ("pm.response.to.have.jsonBody('items.map')", "to have property");
    expect_assertion_failure ("pm.response.to.have.jsonBody('constructor')", "to have property");
}

TEST_F (ResponseAssertionTest, JsonBodyRefusesAPathThatIsNotAString) {
    expect_type_error ("pm.response.to.have.jsonBody(5)", "property path string");
    expect_pass ("pm.response.to.have.jsonBody()");
}

// ----------------------------------------------------------------------------
// jsonSchema, both chains
// ----------------------------------------------------------------------------

constexpr const char* ID_SCHEMA =
R"({ type: "object", required: ["id"], properties: { id: { type: "integer" } } })";

TEST_F (ResponseAssertionTest, JsonSchemaOnTheResponseJudgesTheBody) {
    const std::string schema = ID_SCHEMA;
    expect_pass ("pm.response.to.have.jsonSchema(" + schema + ")");
    expect_assertion_failure ("pm.response.to.not.have.jsonSchema(" + schema + ")",
    "Expected data to not satisfy the schema");

    response.body = R"({"id": "1"})";
    expect_assertion_failure ("pm.response.to.have.jsonSchema(" + schema + ")", "at /id:");
    expect_pass ("pm.response.to.not.have.jsonSchema(" + schema + ")");

    response.body = R"({"name": "ada"})";
    expect_assertion_failure ("pm.response.to.have.jsonSchema(" + schema + ")", "'id'");

    // The body is read as JSON.parse reads it, as ajv's data is in Postman:
    // `1.0` is the integer 1.
    response.body = R"({"id": 1.0})";
    expect_pass ("pm.response.to.have.jsonSchema(" + schema + ")");

    response.body = "not json";
    expect_assertion_failure ("pm.response.to.have.jsonSchema(" + schema + ")", "not valid JSON");
}

TEST_F (ResponseAssertionTest, JsonSchemaNamesTheFailingPathInsideTheBody) {
    response.body = R"({"items": [{"id": 1}, {"id": "two"}]})";
    expect_assertion_failure (R"(pm.response.to.have.jsonSchema({
        type: "object",
        properties: { items: { type: "array", items: { properties: { id: { type: "integer" } } } } }
    }))",
    "at /items/1/id:");
}

TEST_F (ResponseAssertionTest, JsonSchemaOnAnExpectationJudgesItsValue) {
    expect_pass (R"(pm.expect([{ id: 1 }]).to.have.jsonSchema({ type: "array", items: { required: ["id"] } }))");
    expect_assertion_failure (R"(pm.expect([{ id: 1 }, {}]).to.have.jsonSchema({ type: "array", items: { required: ["id"] } }))",
    "at /1:");
    expect_pass (R"(pm.expect("x").to.not.have.jsonSchema({ type: "number" }))");
    expect_assertion_failure (R"(pm.expect(1).to.not.have.jsonSchema({ type: "number" }))",
    "to not satisfy the schema");
}

// A keyword the draft-07 validator does not evaluate leaves the verdict
// unknown, so the assertion fails naming it in either polarity rather than
// passing on a schema it only partly read.
TEST_F (ResponseAssertionTest, JsonSchemaNamesTheKeywordsItCouldNotEvaluate) {
    const std::string schema = R"({ type: "object", unevaluatedProperties: false })";
    expect_assertion_failure ("pm.response.to.have.jsonSchema(" + schema + ")",
    "does not evaluate, so they were not checked: unevaluatedProperties (1)");
    expect_assertion_failure ("pm.response.to.not.have.jsonSchema(" + schema + ")",
    "unevaluatedProperties (1)");
    expect_assertion_failure ("pm.expect({}).to.have.jsonSchema(" + schema + ")",
    "unevaluatedProperties (1)");
}

TEST_F (ResponseAssertionTest, JsonSchemaRefusesWhatIsNotASchema) {
    expect_type_error ("pm.response.to.have.jsonSchema([])", "schema object, got array");
    expect_type_error ("pm.response.to.have.jsonSchema('{}')", "schema object, got string");
    expect_type_error ("pm.expect(1).to.have.jsonSchema(true)", "schema object, got boolean");
    expect_type_error ("pm.response.to.have.jsonSchema({ type: 5 })", "could not read the schema");
    expect_type_error ("pm.response.to.have.jsonSchema()", "requires a schema");
    expect_type_error ("pm.expect(undefined).to.have.jsonSchema({})", "JSON can represent");
}

} // namespace
