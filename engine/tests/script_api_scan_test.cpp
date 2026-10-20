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

#include <chrono>
#include <string>
#include <utility>
#include <vector>

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

TEST (ScriptApiStrip, BlanksCommentsInBothViewsAndKeepsTheLines) {
    const std::string source = "a // tail\nb /* one\ntwo */ c";
    const auto stripped      = strip_comments_and_literals (source);
    EXPECT_EQ (stripped.code, "a        \nb       \n       c");
    EXPECT_EQ (stripped.text, stripped.code);
}

TEST (ScriptApiStrip, BlanksAStringInTheCodeViewOnly) {
    const auto stripped =
    strip_comments_and_literals ("x = 'CryptoJS' + \"_\";");
    EXPECT_EQ (stripped.code, "x = '        ' + \" \";");
    EXPECT_EQ (stripped.text, "x = 'CryptoJS' + \"_\";");
}

TEST (ScriptApiStrip, ASlashSlashInsideAStringIsNotAComment) {
    const auto stripped =
    strip_comments_and_literals ("u = 'http://x.test'; tests[0]");
    EXPECT_EQ (stripped.text, "u = 'http://x.test'; tests[0]");
    EXPECT_NE (stripped.code.find ("tests[0]"), std::string::npos);
}

TEST (ScriptApiStrip, AnEscapedQuoteDoesNotEndTheString) {
    const auto stripped = strip_comments_and_literals (R"(a = 'it\'s'; b)");
    EXPECT_EQ (stripped.code, "a = '     '; b");
}

TEST (ScriptApiStrip, AnUnterminatedStringEndsAtItsLine) {
    const auto stripped = strip_comments_and_literals ("a = 'oops\nCryptoJS");
    EXPECT_NE (stripped.code.find ("CryptoJS"), std::string::npos);
}

TEST (ScriptApiStrip, KeepsTheExpressionsOfATemplateAsCode) {
    const auto stripped =
    strip_comments_and_literals ("`id ${CryptoJS.MD5(x)} end`; tail");
    EXPECT_EQ (stripped.code, "`   ${CryptoJS.MD5(x)}    `; tail");
    EXPECT_EQ (strip_comments_and_literals ("`${ {a: 1}.a } _`; z").code, "`${ {a: 1}.a }  `; z");
}

TEST (ScriptApiStrip, ReadsNestedTemplates) {
    const auto stripped =
    strip_comments_and_literals ("`a ${ `b ${x} c` } d` ; tail");
    EXPECT_EQ (stripped.code, "`  ${ `  ${x}  ` }  ` ; tail");
}

TEST (ScriptApiStrip, BlanksARegularExpressionButNotADivision) {
    const auto regex =
    strip_comments_and_literals ("ok = /['\"]_/.test(s); tail");
    EXPECT_EQ (regex.code, "ok = /     /.test(s); tail");
    const auto division =
    strip_comments_and_literals ("a = b / c; d = 'x' / 2; tail");
    EXPECT_EQ (division.code, "a = b / c; d = ' ' / 2; tail");
}

TEST (ScriptApiStrip, ASlashInsideACharacterClassDoesNotEndTheRegularExpression) {
    const auto stripped = strip_comments_and_literals ("x = /[/]_/; tail");
    EXPECT_EQ (stripped.code, "x = /    /; tail");
}

TEST (ScriptApiStrip, BothViewsKeepTheSourceLength) {
    for (const std::string source : { "", "/", "//", "/*", "'", "`${", "`${}`",
         "a = /[", "`\\", "'\\", "/* x */ /* y" }) {
        const auto stripped = strip_comments_and_literals (source);
        EXPECT_EQ (stripped.code.size (), source.size ()) << source;
        EXPECT_EQ (stripped.text.size (), source.size ()) << source;
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
    EXPECT_EQ (names_in ("setTimeout(f, 10);"), Names{ "setTimeout" });
    EXPECT_EQ (names_in ("setInterval(f, 10);"), Names{ "setInterval" });
    EXPECT_EQ (names_in ("Buffer.from(s).toString('hex');"), Names{ "Buffer" });
    EXPECT_EQ (names_in ("const r = await fetchIt();"), Names{ "await" });
}

TEST (ScriptApiScan, NamesThePmMembersVayuDoesNotHave) {
    EXPECT_EQ (names_in ("pm.visualizer.set(t, d);"), Names{ "pm.visualizer" });
    EXPECT_EQ (names_in ("pm.variables.set('a', 1);"), Names{ "pm.variables.set" });
    EXPECT_EQ (names_in ("pm.test.skip('later', () => {});"), Names{ "pm.test.skip" });
    EXPECT_EQ (names_in ("pm . variables\n  .set('a', 1);"), Names{ "pm.variables.set" });
    EXPECT_EQ (names_in ("pm.variables.get('a'); pm.test('t', f);"), Names{});
}

TEST (ScriptApiScan, NamesAFormBodyOnlyBesideSendRequest) {
    const std::string form_body = "pm.sendRequest urlencoded/formdata body";
    EXPECT_EQ (names_in ("pm.sendRequest({url: u, method: 'POST', body: {mode: "
                         "'urlencoded',"
                         " urlencoded: [{key: 'a', value: 'b'}]}}, cb);"),
    Names{ form_body });
    EXPECT_EQ (names_in (R"(const req = { "mode": "formdata" }; pm.sendRequest(req, cb);)"),
    Names{ form_body });
    EXPECT_EQ (names_in ("pm.sendRequest({body: {mode: 'raw', raw: ''}}, cb);"), Names{});
    // The mode is read but nothing is sent: no `sendRequest`, no name.
    EXPECT_EQ (names_in ("const b = { mode: 'urlencoded' };"), Names{});
    EXPECT_EQ (names_in ("pm.sendRequest(r, cb); // mode: 'formdata'"), Names{});
}

TEST (ScriptApiScan, NamesTheChaiSpellingsPmExpectRefuses) {
    const std::vector<std::pair<std::string, std::string>> cases = {
        { "pm.expect(n).to.be.within(1, 5);", ".within()" },
        { "pm.expect(n).to.be.greaterThan(1);", ".greaterThan() / .lessThan()" },
        { "pm.expect(n).to.be.lessThan(1);", ".greaterThan() / .lessThan()" },
        { "pm.expect(n).to.be.instanceof(Array);", ".instanceof()" },
        { "pm.expect(n).to.be.approximately(1, 0.1);", ".approximately()" },
        { "pm.expect(o).to.have.ownProperty('a');", ".ownProperty()" },
        { "pm.expect(o).to.have.own.property('a');", ".own.property" },
        { "pm.expect(o).to.have.any.keys('a', 'b');", ".any.keys" },
        { "pm.expect(o).to.include.keys('a');", ".include.keys" },
        { "pm.expect(o).to.contain.keys(['a']);", ".include.keys" },
        { "pm.expect(a).to.include.members([1]);", ".include.members" },
        { "pm.expect(a).to.contain.oneOf([1]);", ".include.oneOf" },
        { "pm.expect(a).to.have.ordered.members([1]);", ".ordered.members" },
        { "pm.expect(o).to.nested.include({'a.b': 1});", ".nested.include" },
        { "pm.expect(n).to.be.finite;", ".finite" },
        { "pm.expect(a).to.have.lengthOf.above(2);", ".length.above" },
        { "pm.response.to.have.jsonSchema(s);", "jsonSchema" },
        { "pm.expect(j).to.have.jsonSchema(s);", "jsonSchema" },
        { "pm.expect(pm.response.responseSize).to.be.above(1);", "responseSize" },
        { "pm.response.to.not.have.status(500);", "pm.response.to.not" },
    };
    for (const auto& [script, expected] : cases) {
        EXPECT_EQ (names_in (script), Names{ expected }) << script;
    }
}

TEST (ScriptApiScan, TheSupportedChaiSpellingsAreNotNamed) {
    EXPECT_EQ (names_in (R"(
        pm.expect(n).to.be.above(1).and.below(9);
        pm.expect(a).to.have.lengthOf(2);
        pm.expect(a).to.include(1);
        pm.expect(o).to.have.keys('a');
        pm.expect(o).to.have.property('a');
        pm.expect(n).to.be.closeTo(1, 0.1);
        pm.response.to.have.status(200);
        pm.response.to.be.ok;
    )"),
    Names{});
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
    (Names{ "tests[]", "postman.*", "require()", "await" }));
}

TEST (ScriptApiScan, PackagesJoinTheListInTableOrder) {
    UnsupportedScriptApis uses;
    EXPECT_TRUE (uses.empty ());
    uses.scan ("await go();");
    uses.note_packages ();
    uses.note_packages ();
    uses.scan ("tests['a'] = true;");
    EXPECT_FALSE (uses.empty ());
    EXPECT_EQ (uses.names (), (Names{ "tests[]", "script.packages", "await" }));
}

TEST (ScriptApiScan, AnUnparsableScriptContributesWhatItsTokensShow) {
    EXPECT_EQ (names_in ("tests['a' = ((( {{{ `${ 'x"), Names{ "tests[]" });
    std::string binary = "\xff\xfe";
    binary.push_back ('\0');
    binary += " setTimeout";
    EXPECT_EQ (names_in (binary), Names{ "setTimeout" });
    EXPECT_EQ (names_in (""), Names{});
}

TEST (ScriptApiScan, ReadsALargeScriptWithinTheParseBudget) {
    // A scan that looks every name up against every declaration, or every
    // parameter list against every token, is quadratic in this.
    std::string script;
    for (int i = 0; i < 20000; ++i) {
        script += "function f" + std::to_string (i) + "(a, b) { return a.b.c(b) + data.x; }\n";
    }
    const auto start  = std::chrono::steady_clock::now ();
    const Names found = names_in (script);
    EXPECT_LT (std::chrono::steady_clock::now () - start, vayu::tests::LINEAR_PARSE_BUDGET);
    EXPECT_EQ (found, Names{ "data" });
}

} // namespace
