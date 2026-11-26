/**
 * @file script_engine_require_assertions_test.cpp
 * @brief The second half of the require() shelf: chai, ajv and tv4, plus the stack
 *        budget and the signed-header exchange.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <string>
#include <string_view>

#include "echo_server.hpp"
#include "library_call_config.hpp"
#include "script_engine_fixture.hpp"
#include "step_elements_test_helper.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

using vayu::tests::JEFE_MESSAGE;
using vayu::tests::library_call_config;
using vayu::tests::shelf_answer;
using vayu::tests::ShelfAnswer;

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
