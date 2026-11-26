/**
 * @file script_engine_expect_chai_test.cpp
 * @brief The second half of pm.expect(): chai's language chains and flag-dependent forms.
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
