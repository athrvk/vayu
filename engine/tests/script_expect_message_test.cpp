/**
 * @file tests/script_expect_message_test.cpp
 * @brief `pm.expect(value, message)` - chai's second argument (issue #484).
 *
 * The custom message exists for exactly one moment: the failure. A script that
 * asserts the same shape in a loop, or from two code paths, writes the message
 * to say *which* one broke - the generic matcher text ("Expected value to be
 * truthy") never can. Dropping it silently is worse than rejecting it, because
 * the script looks correct and the report is merely useless.
 *
 * So the assertions here are on the reported error text, per matcher. The
 * per-matcher sweep is the point rather than padding: the prefix is applied in
 * one helper (`throw_expect_failure`) and a matcher that threw around it would
 * be invisible to a test that only checked one matcher. Mutation-check: make
 * that helper ignore `state->message` and `EveryMatcherCarriesTheMessage`
 * fails for all 26 chains, while the boundary tests below stay green.
 */

#include <gtest/gtest.h>

#include <array>
#include <string>

#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

namespace {

class ExpectMessageTest : public ::testing::Test {
    protected:
    ScriptEngine engine;
    Request request;
    Response response;
    Environment env;

    void SetUp () override {
        request.method       = HttpMethod::GET;
        request.url          = "https://api.example.com/users";
        response.status_code = 200;
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

    static bool contains (const std::string& haystack, const std::string& needle) {
        return haystack.find (needle) != std::string::npos;
    }
};

/**
 * The owner's repro from #484: the message the script wrote reaches the report,
 * and the generic text it explains is still there. Both halves matter - a fix
 * that replaced the matcher's own text with the custom message would lose what
 * actually failed.
 */
TEST_F (ExpectMessageTest, TheCustomMessagePrefixesTheGenericFailure) {
    const std::string reported =
    failure_of (R"(pm.expect(false, "this is the MCP-path gap").to.be.true)");

    EXPECT_TRUE (contains (reported, "this is the MCP-path gap")) << reported;
    EXPECT_TRUE (contains (reported, "Expected value to be truthy")) << reported;
    // chai's order and separator: the context, then what went wrong.
    EXPECT_TRUE (contains (reported, "this is the MCP-path gap: Expected value to be truthy"))
    << reported;
}

/**
 * Every matcher, because the helper they share is only load-bearing if they all
 * go through it. One chain per assertion-failure site in the expectation
 * surface; `equal` and `eql` share a site and are both listed because the
 * message they build differs.
 */
TEST_F (ExpectMessageTest, EveryMatcherCarriesTheMessage) {
    struct Case {
        const char* assertion;
        const char* generic; // a fragment of the matcher's own failure text
    };

    const auto cases = std::to_array<Case> ({
    { R"(pm.expect(1, "M").to.equal(2))", "to equal" },
    { R"(pm.expect({ a: 1 }, "M").to.eql({ a: 2 }))", "deeply equal" },
    { R"(pm.expect(undefined, "M").to.exist)", "to exist" },
    { R"(pm.expect(false, "M").to.be.true)", "truthy" },
    { R"(pm.expect(true, "M").to.be.false)", "to be false" },
    { R"(pm.expect(1, "M").to.be.above(2))", "to be above" },
    { R"(pm.expect(2, "M").to.be.below(1))", "to be below" },
    { R"(pm.expect([1], "M").to.include(2))", "to include" },
    { R"(pm.expect({}, "M").to.have.property("a"))", "to have property" },
    { R"(pm.expect(1, "M").to.be.null)", "to be null" },
    { R"(pm.expect(1, "M").to.be.undefined)", "to be undefined" },
    { R"(pm.expect(0, "M").to.be.ok)", "truthy" },
    { R"(pm.expect([1], "M").to.be.empty)", "to be empty" },
    { R"(pm.expect(1, "M").to.be.at.least(2))", "at least" },
    { R"(pm.expect(3, "M").to.be.at.most(2))", "at most" },
    { R"(pm.expect([1], "M").to.have.length(2))", "Expected length" },
    { R"(pm.expect(1, "M").to.be.a("string"))", "Expected type" },
    { R"(pm.expect("abc", "M").to.match(/z/))", "to match the pattern" },
    { R"(pm.expect(1, "M").to.be.oneOf([2, 3]))", "to be one of" },
    { R"(pm.expect({ a: 1 }, "M").to.have.keys("b"))", "exactly the keys" },
    { R"(pm.expect([1], "M").to.have.members([2]))", "to have members" },
    { R"(pm.expect(function () {}, "M").to.throw())", "to throw" },
    { R"(pm.expect({}, "M").to.be.instanceOf(Array))", "instance of" },
    { R"(pm.expect(1, "M").to.be.closeTo(5, 0.1))", "to be within" },
    { R"(pm.expect(1, "M").to.satisfy(function (v) { return v > 2; }))", "satisfy the predicate" },
    { R"(pm.expect("abc", "M").to.have.string("z"))", "to contain" },
    });

    for (const auto& c : cases) {
        const std::string reported = failure_of (c.assertion);
        // Every matcher's own text opens with "Expected", so the prefix and
        // what it explains are adjacent - checking them apart would pass on a
        // message appended somewhere else in the report.
        EXPECT_TRUE (contains (reported, "M: Expected")) << c.assertion << " -> " << reported;
        EXPECT_TRUE (contains (reported, c.generic)) << c.assertion << " -> " << reported;
    }
}

// The flags a chain sets do not change who reports the failure, so the message
// has to survive them - a negated or continued chain is where a loop's
// assertions usually live.
TEST_F (ExpectMessageTest, TheMessageSurvivesNegationAndChaining) {
    EXPECT_TRUE (contains (failure_of (R"(pm.expect(1, "M").to.not.equal(1))"),
    "M: Expected 1 to not equal 1"))
    << failure_of (R"(pm.expect(1, "M").to.not.equal(1))");

    EXPECT_TRUE (contains (
    failure_of (R"(pm.expect(5, "M").to.be.above(1).and.to.be.below(3))"), "M: Expected 5"));
}

// The one-argument form is the overwhelming majority of scripts in the wild and
// its report must read exactly as it did before the message existed - no stray
// separator, no empty prefix.
TEST_F (ExpectMessageTest, TheOneArgumentFormIsUnchanged) {
    // Whole-string equality rather than a substring: what this pins is that
    // nothing was added, which a `contains` cannot see. The leading
    // `AssertionError:` is chai's name for a failed assertion (#487), not a
    // prefix this feature adds.
    EXPECT_EQ (failure_of (R"(pm.expect(false).to.be.true)"),
    "AssertionError: Expected value to be truthy");
    EXPECT_EQ (failure_of (R"(pm.expect(1).to.equal(2))"),
    "AssertionError: Expected 1 to equal 2");
}

// chai coerces the message instead of demanding a string, and a caller that
// builds one conditionally spells "none" as `undefined` or `null`. Both are the
// no-prefix path, so a computed message that came out empty cannot leave a bare
// ": " in front of the failure.
TEST_F (ExpectMessageTest, ANonStringMessageIsCoercedAndAnAbsentOneIsNotPrefixed) {
    EXPECT_TRUE (contains (failure_of (R"(pm.expect(false, 42).to.be.true)"),
    "42: Expected value to be truthy"));
    EXPECT_TRUE (contains (failure_of (R"(pm.expect(false, { a: 1 }).to.be.true)"),
    "[object Object]: Expected value to be truthy"));

    for (const char* absent : { R"(pm.expect(false, undefined).to.be.true)",
         R"(pm.expect(false, null).to.be.true)", R"(pm.expect(false, "").to.be.true)" }) {
        EXPECT_EQ (failure_of (absent), "AssertionError: Expected value to be truthy")
        << absent;
    }
}

// A message that cannot be converted is a script bug, and swallowing it would
// hide it behind whatever the assertion reported next - including a PASS, when
// the assertion holds.
TEST_F (ExpectMessageTest, AMessageThatCannotBeConvertedFailsLoudly) {
    auto result = engine.execute_test (
    R"(pm.test("t", function() { pm.expect(true, Symbol("s")).to.be.true; });)",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_FALSE (result.tests[0].passed)
    << "a symbol message must not be dropped silently";
    EXPECT_TRUE (contains (result.tests[0].error_message, "symbol"))
    << result.tests[0].error_message;
}

// A passing assertion is a passing assertion; the message is failure-only, so
// carrying one must not change the result or leave anything in the report.
TEST_F (ExpectMessageTest, APassingTwoArgumentAssertionBehavesLikeTheOneArgumentForm) {
    auto result = engine.execute_test (R"(
        pm.test("two-arg passes", function() {
            pm.expect(pm.response.code, "status").to.equal(200);
            pm.expect(pm.response.json(), "body").to.have.property("id");
        });
    )",
    request, response, env);

    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_TRUE (result.tests[0].error_message.empty ());
}

// The documented boundary: a message explains a value that failed, not a call
// the script wrote wrong. A usage error names the matcher that rejected it,
// which is the information needed to fix the script, and it is reported
// unprefixed so the two kinds stay distinguishable in a report.
TEST_F (ExpectMessageTest, AUsageErrorIsReportedWithoutThePrefix) {
    const std::string reported = failure_of (R"(pm.expect(1, "M").to.be.above())");
    EXPECT_TRUE (contains (reported, "above() requires an argument")) << reported;
    EXPECT_FALSE (contains (reported, "M: ")) << reported;
}

} // namespace
