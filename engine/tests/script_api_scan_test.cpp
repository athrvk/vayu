/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/script_api_scan_test.cpp
 * @brief The scan that names the Postman script APIs Vayu does not run
 *        (issues #2576, #2527): the stripper under it, one case per family of
 *        the table, and the ways a plain text search would be wrong.
 *
 * The Postman importer's own cases (`PostmanImport.*` in
 * `import_parse_test.cpp`) cover where the names land; these cover what is
 * found. Removing a row of the table fails the case of its family.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "chai_conformance_table.hpp"
#include "vayu/core/script_api_scan.hpp"
#include "wide_json.hpp"

namespace {

using vayu::core::strip_comments_and_literals;
using vayu::core::UnsupportedScriptApis;
using Names = std::vector<std::string>;

Names names_in (const std::string& script) {
    UnsupportedScriptApis uses;
    uses.scan (script);
    return uses.names ();
}

// ---------------------------------------------------------------------------
// Stripping
// ---------------------------------------------------------------------------

TEST (ScriptApiStrip, BlanksCommentsAndKeepsTheLines) {
    const std::string source = "a // tail\nb /* one\ntwo */ c";
    EXPECT_EQ (strip_comments_and_literals (source), "a        \nb       \n       c");
}

TEST (ScriptApiStrip, BlanksAStringKeepingItsQuotes) {
    EXPECT_EQ (strip_comments_and_literals ("x = 'CryptoJS' + \"_\";"), "x = '        ' + \" \";");
}

TEST (ScriptApiStrip, ASlashSlashInsideAStringIsNotAComment) {
    EXPECT_EQ (strip_comments_and_literals ("u = 'http://x.test'; tests[0]"),
    "u = '             '; tests[0]");
}

TEST (ScriptApiStrip, AnEscapedQuoteDoesNotEndTheString) {
    EXPECT_EQ (strip_comments_and_literals (R"(a = 'it\'s'; b)"), "a = '     '; b");
}

TEST (ScriptApiStrip, AnUnterminatedStringEndsAtItsLine) {
    EXPECT_NE (strip_comments_and_literals ("a = 'oops\nCryptoJS").find ("CryptoJS"),
    std::string::npos);
}

TEST (ScriptApiStrip, KeepsTheExpressionsOfATemplateAsCode) {
    EXPECT_EQ (
    strip_comments_and_literals ("`id ${CryptoJS.MD5(x)} end`; tail"),
    "`   ${CryptoJS.MD5(x)}    `; tail");
    EXPECT_EQ (strip_comments_and_literals ("`${ {a: 1}.a } _`; z"), "`${ {a: 1}.a }  `; z");
}

TEST (ScriptApiStrip, ReadsNestedTemplates) {
    EXPECT_EQ (strip_comments_and_literals ("`a ${ `b ${x} c` } d` ; tail"),
    "`  ${ `  ${x}  ` }  ` ; tail");
}

TEST (ScriptApiStrip, BlanksARegularExpressionButNotADivision) {
    EXPECT_EQ (strip_comments_and_literals ("ok = /['\"]_/.test(s); tail"),
    "ok = /     /.test(s); tail");
    EXPECT_EQ (strip_comments_and_literals ("a = b / c; d = 'x' / 2; tail"),
    "a = b / c; d = ' ' / 2; tail");
}

TEST (ScriptApiStrip, AKeywordThatTakesAnOperandIsFollowedByARegularExpression) {
    EXPECT_EQ (strip_comments_and_literals ("return /\"/.test(x); tail"),
    "return / /.test(x); tail");
    for (const char* word : { "return", "typeof", "case", "in", "of", "delete",
         "void", "throw", "new", "else", "do" }) {
        const std::string source = std::string (word) + " /'/.test(x); tail";
        EXPECT_EQ (strip_comments_and_literals (source), std::string (word) + " / /.test(x); tail")
        << word;
    }
}

TEST (ScriptApiStrip, ASlashAfterAnyOtherWordOrAPropertyIsADivision) {
    EXPECT_EQ (
    strip_comments_and_literals ("r = inside / 2 + o.new / 3; s = \"_\";"),
    "r = inside / 2 + o.new / 3; s = \" \";");
    EXPECT_EQ (strip_comments_and_literals ("r = a.delete / 2; s = '_';"),
    "r = a.delete / 2; s = ' ';");
    EXPECT_EQ (strip_comments_and_literals ("r = index / 2 / 3; s = '_';"),
    "r = index / 2 / 3; s = ' ';");
}

TEST (ScriptApiStrip, ASlashInsideACharacterClassDoesNotEndTheRegularExpression) {
    EXPECT_EQ (strip_comments_and_literals ("x = /[/]_/; tail"), "x = /    /; tail");
}

TEST (ScriptApiStrip, KeepsTheSourceLength) {
    for (const std::string source : { "", "/", "//", "/*", "'", "`${", "`${}`",
         "a = /[", "`\\", "'\\", "/* x */ /* y" }) {
        EXPECT_EQ (strip_comments_and_literals (source).size (), source.size ()) << source;
    }
}

// ---------------------------------------------------------------------------
// The table, a family at a time
// ---------------------------------------------------------------------------

TEST (ScriptApiScan, NamesNothingForAScriptThatUsesOnlyPm) {
    EXPECT_EQ (names_in (R"(
        const body = pm.response.json();
        pm.test("ok", () => pm.expect(body.id).to.eql(1));
        pm.environment.set("token", body.token);
        pm.globals.get("g");
        pm.variables.get("v");
        pm.sendRequest({ url: "https://x.test", method: "POST",
            body: { mode: "raw", raw: "{}" } }, (err, res) => {});
        console.log(pm.response.responseTime, pm.response.code);
    )"),
    Names{});
}

TEST (ScriptApiScan, NamesTheLegacyGlobals) {
    EXPECT_EQ (names_in (R"(tests["Status is 200"] = responseCode.code === 200;)"),
    (Names{ "tests[]", "responseCode" }));
    EXPECT_EQ (names_in ("var j = JSON.parse(responseBody);"), Names{ "responseBody" });
    EXPECT_EQ (names_in ("responseHeaders['Content-Type']"), Names{ "responseHeaders" });
    EXPECT_EQ (names_in ("var c = responseCookies;"), Names{ "responseCookies" });
    EXPECT_EQ (names_in ("if (responseTime > 100) {}"), Names{ "responseTime" });
    EXPECT_EQ (names_in (R"(postman.setEnvironmentVariable("a", "b");)"),
    Names{ "postman.*" });
    EXPECT_EQ (names_in (R"(globals.token = "x";)"), Names{ "globals.*" });
    EXPECT_EQ (names_in ("var n = environment.name;"), Names{ "environment.*" });
    EXPECT_EQ (names_in (R"(var n = data["name"];)"), Names{ "data" });
    EXPECT_EQ (names_in ("var n = data.name;"), Names{ "data" });
}

TEST (ScriptApiScan, ALegacyNameNeedsItsFollowingCharacter) {
    // `tests` alone, `postman` alone and `data` alone are plain variables.
    EXPECT_EQ (names_in ("var tests = []; tests.push(1); postman; data;"), Names{});
}

TEST (ScriptApiScan, APropertyOfSomethingElseIsNotALegacyGlobal) {
    EXPECT_EQ (names_in (R"(
        pm.response.responseTime; x.responseBody; opts.responseCode;
        pm.environment.get("a"); pm.globals.set("b", 1); thing?.tests[0];
        const copy = { ...base, ...tests };
    )"),
    Names{});
}

TEST (ScriptApiScan, NamesRequireInBothSpellings) {
    EXPECT_EQ (names_in ("const c = require('crypto-js');"), Names{ "require()" });
    EXPECT_EQ (names_in ("const c = require ( \"lodash\" );"), Names{ "require()" });
    EXPECT_EQ (names_in ("const lib = pm.require('@scope/pkg');"), Names{ "pm.require" });
    EXPECT_EQ (
    names_in ("// require('x')\nrequirement(1); const r = 'require(';"), Names{});
}

TEST (ScriptApiScan, NamesEachBundledLibrary) {
    EXPECT_EQ (names_in ("CryptoJS.MD5('x');"), Names{ "CryptoJS" });
    EXPECT_EQ (names_in ("_.each(a, f);"), Names{ "_" });
    EXPECT_EQ (names_in ("tv4.validate(a, s);"), Names{ "tv4" });
    EXPECT_EQ (names_in ("const o = xml2Json(xml);"), Names{ "xml2Json" });
    EXPECT_EQ (names_in ("const $ = cheerio.load(html);"), Names{ "cheerio" });
    EXPECT_EQ (names_in ("moment().format();"), Names{ "moment" });
    EXPECT_EQ (names_in ("new Backbone.Model();"), Names{ "Backbone" });
}

TEST (ScriptApiScan, ALibraryNameInACommentStringOrPropertyIsNotUse) {
    EXPECT_EQ (names_in (R"(
        // CryptoJS.MD5(x)
        /* _.each(a) and moment() */
        const label = "uses CryptoJS and _ and tv4";
        const t = `${label} xml2Json`;
        const o = pm.environment.get("cheerio");
        x.moment = 1; y.Backbone;
        const k = _under + underscore_ + $_;
    )"),
    Names{});
}

TEST (ScriptApiScan, ACodeExpressionInATemplateIsStillUse) {
    EXPECT_EQ (names_in ("const sig = `sig=${CryptoJS.HmacSHA256(m, k)}`;"),
    Names{ "CryptoJS" });
}

TEST (ScriptApiScan, NamesTheHostGlobalsASandboxLacks) {
    EXPECT_EQ (names_in ("Buffer.from(s).toString('hex');"), Names{ "Buffer" });
    EXPECT_EQ (names_in ("const r = await fetchIt();"), Names{ "top-level await" });
    EXPECT_EQ (names_in ("return /\"/.test(x); Buffer.from(f);"), Names{ "Buffer" });
    EXPECT_EQ (names_in ("n = total / 2; Buffer.from(f); s = \"x\";"), Names{ "Buffer" });
}

// The timers run (#2577), so a script that uses them is not named.
TEST (ScriptApiScan, TheTimersAreNotNamed) {
    EXPECT_EQ (names_in ("const t = setTimeout(f, 10); clearTimeout(t);"), Names{});
    EXPECT_EQ (names_in ("const i = setInterval(f, 10); clearInterval(i);"), Names{});
}

TEST (ScriptApiScan, AwaitInsideAnAsyncFunctionIsNotNamed) {
    // Promises and async functions run (docs/engine/scripting.md); only an
    // `await` outside every async function is a syntax error.
    const std::vector<std::string> scripts = {
        "(async () => { const r = await Promise.resolve(1); })();",
        "async function f() { await x; }",
        "const f = async function () { if (a) { await x; } };",
        "const f = async (a, b) => { for (const v of a) { await v; } };",
        "const o = { async m() { if (a) { await x; } } };",
        "class C { async m() { await x; } }",
        "async function* g() { for await (const v of s) {} }",
        "async function f() { return `${await x}`; }",
        "async function f() { const s = \"}\"; await x; }",
        "pm.test('t', async () => { await pm.sendRequest(r); });",
    };
    for (const std::string& script : scripts) {
        EXPECT_EQ (names_in (script), Names{}) << script;
    }
}

TEST (ScriptApiScan, ATopLevelAwaitIsNamedWhereverItSits) {
    const std::vector<std::string> scripts = {
        "await x;",
        "try { await x; } catch (e) {}",
        "if (a) { await x; }",
        "pm.test('t', () => { await x; });",
        "function f() { await x; }",
        "async function f() { await a; } await b;",
        "async function f() {} { await x; }",
        "const f = async x => x; { await y; }",
        "const f = async x => x\nif (a) { await y; }",
        "var async = require('async'); async.each(a, f); { await x; }",
        "async(f); { await x; }",
        "for await (const v of s) {}",
    };
    for (const std::string& script : scripts) {
        const Names found = names_in (script);
        EXPECT_NE (std::ranges::find (found, "top-level await"), found.end ()) << script;
    }
}

TEST (ScriptApiScan, NamesThePmMembersVayuDoesNotHave) {
    EXPECT_EQ (names_in ("pm.visualizer.set(t, d);"), Names{ "pm.visualizer" });
    EXPECT_EQ (names_in ("pm.variables.set('a', 1);"), Names{ "pm.variables.set" });
    EXPECT_EQ (names_in ("pm.test.skip('later', () => {});"), Names{ "pm.test.skip" });
    EXPECT_EQ (names_in ("pm . variables\n  .set('a', 1);"), Names{ "pm.variables.set" });
    EXPECT_EQ (names_in ("pm.variables.get('a'); pm.test('t', f);"), Names{});
}

TEST (ScriptApiScan, ASendRequestFormBodyIsNotNamed) {
    EXPECT_EQ (
    names_in ("pm.sendRequest({url: u, method: 'POST', body: {mode: "
              "'urlencoded', urlencoded: [{key: 'a', value: 'b'}]}}, cb);"),
    Names{});
    EXPECT_EQ (names_in (R"(pm.sendRequest({ url: u, body: { mode: "formdata",
        formdata: [{ key: "f", type: "file", src: "a.txt" }] } }, cb);)"),
    Names{});
}

constexpr std::string_view POSTMAN_MEMBERS =
".postmanRequest / .postmanResponse / .postmanRequestOrResponse";

TEST (ScriptApiScan, NamesTheChaiPostmanMembersPmExpectRefuses) {
    const std::vector<std::string> scripts = {
        "pm.expect(pm.request).to.be.postmanRequest;",
        "pm.expect(pm.response).to.be.postmanResponse;",
        "pm.expect(pm.response).to.be.postmanRequestOrResponse;",
    };
    for (const std::string& script : scripts) {
        EXPECT_EQ (names_in (script), Names{ std::string (POSTMAN_MEMBERS) }) << script;
    }
    // A name of the script's own, or a bare variable, is not a chai member.
    EXPECT_EQ (
    names_in ("var postmanResponse = pm.response; postmanResponse.code;"), Names{});
}

// Every one of these was named while `pm.expect` refused the spelling and runs
// since #2528 (`chai-conformance.json` holds each member to a snippet that
// passes), so naming one would tell a person their working script does not run.
TEST (ScriptApiScan, TheChaiSpellingsThatNowRunAreNotNamed) {
    EXPECT_EQ (names_in (R"(
        pm.expect(n).to.be.within(1, 5);
        pm.expect(n).to.be.greaterThan(1).and.lessThan(9);
        pm.expect(n).to.be.instanceof(Array);
        pm.expect(n).to.be.approximately(1, 0.1);
        pm.expect(o).to.have.ownProperty('a');
        pm.expect(o).to.have.own.property('a');
        pm.expect(o).to.have.any.keys('a', 'b');
        pm.expect(o).to.include.keys('a');
        pm.expect(o).to.contain.keys(['a']);
        pm.expect(a).to.include.members([1]);
        pm.expect(a).to.contain.oneOf([1]);
        pm.expect(a).to.have.ordered.members([1]);
        pm.expect(o).to.nested.include({'a.b': 1});
        pm.expect(n).to.be.finite;
        pm.expect(a).to.have.lengthOf.above(2);
        pm.response.to.have.jsonSchema(s);
        pm.expect(j).to.have.jsonSchema(s);
        pm.expect(pm.response.responseSize).to.be.above(1);
        pm.response.to.have.responseSize.below(9);
        pm.response.to.not.have.status(500);
        pm.expect(n).to.be.above(1).and.below(9);
        pm.expect(a).to.have.lengthOf(2);
        pm.expect(o).to.have.property('a');
        pm.response.to.be.ok;
    )"),
    Names{});
}

// The table `pm.expect` is held to is the authority on what runs, so the scan
// is held to it too: a snippet a row says passes or fails as chai does is never
// named, and a member a row marks unsupported is the one the scan names.
TEST (ScriptApiScan, NothingTheChaiConformanceTableRunsIsNamed) {
    const auto& table   = vayu::tests::chai_conformance_table ();
    std::size_t scanned = 0;
    for (const char* section : { "expect", "response" }) {
        ASSERT_TRUE (table.contains (section)) << "the table did not load";
        for (const auto& row : table.at (section)) {
            const std::string member = row.at ("member");
            const bool unsupported = row.value ("status", std::string{}) == "unsupported";
            const Names expected =
            unsupported ? Names{ std::string (POSTMAN_MEMBERS) } : Names{};
            const std::string pass = row.value ("pass", std::string{});
            if (pass.empty ()) {
                continue;
            }
            EXPECT_EQ (names_in (pass), expected) << member << ": " << pass;
            if (!unsupported) {
                EXPECT_EQ (names_in (row.at ("fail")), Names{})
                << member << ": " << row.at ("fail").get<std::string> ();
            }
            ++scanned;
        }
    }
    EXPECT_GT (scanned, 100u) << "the guard read almost nothing";
}

// ---------------------------------------------------------------------------
// Where a text search would be wrong
// ---------------------------------------------------------------------------

TEST (ScriptApiScan, ANameTheScriptDeclaresItselfIsNotTheGlobal) {
    EXPECT_EQ (
    names_in ("const data = pm.response.json(); pm.expect(data.id).to.eql(1);"), Names{});
    EXPECT_EQ (names_in ("let data; data = {}; data.x = 1;"), Names{});
    EXPECT_EQ (names_in ("function show(data) { return data.name; }"), Names{});
    EXPECT_EQ (names_in ("items.forEach((x, data) => data.id);"), Names{});
    EXPECT_EQ (names_in ("items.map(data => data.id);"), Names{});
    EXPECT_EQ (names_in ("try {} catch (environment) { environment.message; }"), Names{});
    EXPECT_EQ (names_in ("const { data } = pm.response.json(); data.id;"), Names{});
    EXPECT_EQ (names_in ("const [_, second] = parts; _.length;"), Names{});
    EXPECT_EQ (names_in ("function globals() {} globals.cache = 1;"), Names{});
}

TEST (ScriptApiScan, ADeclarationElsewhereDoesNotHideADifferentName) {
    // `data` is declared; `postman` and `tests` are not.
    EXPECT_EQ (
    names_in ("const data = 1; postman.clearEnvironmentVariable('a'); "
              "tests['x'] = data;"),
    (Names{ "tests[]", "postman.*" }));
    // A class declares its name, not what its methods read.
    EXPECT_EQ (names_in ("class Checker { run () { return responseBody; } }"),
    Names{ "responseBody" });
    // A declaration of one name does not declare what shares a function body.
    EXPECT_EQ (names_in ("function f(a) { return responseCode; }"), Names{ "responseCode" });
}

TEST (ScriptApiScan, ReportsEachNameOnceInTheOrderOfTheTable) {
    EXPECT_EQ (names_in (R"(
        await later();
        tests["b"] = true;
        tests["a"] = true;
        const c = require("x");
        postman.setNextRequest(null);
        await again();
    )"),
    (Names{ "tests[]", "postman.*", "require()", "top-level await" }));
}

TEST (ScriptApiScan, PackagesJoinTheListInTableOrder) {
    UnsupportedScriptApis uses;
    EXPECT_TRUE (uses.empty ());
    uses.scan ("await go();");
    uses.note_packages ();
    uses.note_packages ();
    uses.scan ("tests['a'] = true;");
    EXPECT_FALSE (uses.empty ());
    EXPECT_EQ (uses.names (), (Names{ "tests[]", "script.packages", "top-level await" }));
}

TEST (ScriptApiScan, AnUnparsableScriptContributesWhatItsTokensShow) {
    EXPECT_EQ (names_in ("tests['a' = ((( {{{ `${ 'x"), Names{ "tests[]" });
    std::string binary = "\xff\xfe";
    binary.push_back ('\0');
    binary += " Buffer";
    EXPECT_EQ (names_in (binary), Names{ "Buffer" });
    EXPECT_EQ (names_in (""), Names{});
}

/// The names @p script uses, failing the test when reading it takes longer than
/// the linear-parse budget.
Names names_within_budget (const std::string& script) {
    const auto start  = std::chrono::steady_clock::now ();
    const Names found = names_in (script);
    EXPECT_LT (std::chrono::steady_clock::now () - start, vayu::tests::LINEAR_PARSE_BUDGET)
    << script.size () << " bytes";
    return found;
}

std::string repeated (const std::string& unit, int times) {
    std::string out;
    out.reserve (unit.size () * static_cast<std::size_t> (times));
    for (int i = 0; i < times; ++i) {
        out += unit;
    }
    return out;
}

TEST (ScriptApiScan, ReadsALargeScriptWithinTheParseBudget) {
    // A scan that looks every name up against every declaration, or every
    // parameter list against every token, is quadratic in this.
    std::string script;
    for (int i = 0; i < 20000; ++i) {
        script += "function f" + std::to_string (i) + "(a, b) { return a.b.c(b) + data.x; }\n";
    }
    EXPECT_EQ (names_within_budget (script), Names{ "data" });
}

TEST (ScriptApiScan, ClosersWithNoOpenerCostNothingPerArrow) {
    // Each `=>` once looked back over every earlier byte for the bracket that
    // opens its parameter list.
    EXPECT_EQ (names_within_budget (repeated ("a)=>", 250000) + " data.x"), Names{ "data" });
}

TEST (ScriptApiScan, AnUnclosedPatternCostsNothingPerBindingKeyword) {
    // Each `var [` once looked ahead to the end of the script for its `]`.
    EXPECT_EQ (names_within_budget (repeated ("var [", 200000) + "; data.x"),
    Names{ "data" });
}

TEST (ScriptApiScan, NestedPatternsDeclareEachNameOnce) {
    // Each of these closed patterns holds every name inside the ones within
    // it, which is quadratic when each pair is walked on its own.
    const std::string script =
    repeated ("var [", 200000) + "data" + repeated ("]", 200000) + "; data.x";
    EXPECT_EQ (names_within_budget (script), Names{});
}

TEST (ScriptApiScan, ManyDeclaredNamesAreLookedUpWithoutScanningThemAll) {
    // A minified script: a hundred and fifty thousand parameters, then the
    // global the script declares itself, used a hundred thousand times.
    std::string script = "function f(p0";
    for (int i = 1; i < 150000; ++i) {
        script += ",p" + std::to_string (i);
    }
    script += "){}var _=0;" + repeated ("_.x;", 100000);
    EXPECT_EQ (names_within_budget (script), Names{});
    EXPECT_EQ (names_within_budget (repeated ("_.x;", 100000)), Names{ "_" });
}

TEST (ScriptApiScan, PairsBracketsOfMixedKindsAsTheScanAlwaysDid) {
    EXPECT_EQ (names_in ("const [a, data] = x; (data) => data.id;"), Names{});
    EXPECT_EQ (names_in ("const { a: [b, data] } = x; data.id;"), Names{});
    EXPECT_EQ (names_in ("function f(a, data] { } data.x"), Names{});
    EXPECT_EQ (names_in ("var [ data.x"), Names{ "data" });
    EXPECT_EQ (names_in ("data) => 1; data.x"), Names{ "data" });
}

} // namespace
