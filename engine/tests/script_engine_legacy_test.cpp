/**
 * @file script_engine_legacy_test.cpp
 * @brief The legacy `postman` object, Postman's legacy globals and pm.visualizer.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "script_engine_fixture.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

using vayu::tests::console_limit_markers;
using vayu::tests::is_console_limit_marker;
using vayu::tests::scenario_test;

namespace console_limits = vayu::core::constants::script_engine;

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
