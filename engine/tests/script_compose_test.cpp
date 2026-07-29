// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// Script parts arrive as a list and the engine joins them.
//
// The clients used to join them and send one string, which meant a stored run
// could not say which part came from where. The join itself must not change:
// the parts are run as ONE script, so a `const` in a collection's part is
// visible to the request's part, and error line numbers are counted from the
// start of the joined text.

#include "vayu/http/script_parts.hpp"
#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

using vayu::http::read_script;

TEST (ScriptParts, JoinsPartsWithABlankLine) {
    auto json = nlohmann::json::parse (R"({
      "preRequestScripts": [
        {"origin":"collection","id":"c1","name":"API","script":"const a = 1;"},
        {"origin":"request","id":"r1","script":"console.log(a);"}
      ]
    })");

    EXPECT_EQ (read_script (json, "preRequestScripts", "preRequestScript"),
    "const a = 1;\n\nconsole.log(a);");
}

TEST (ScriptParts, TheListWinsOverTheLegacyString) {
    auto json = nlohmann::json::parse (R"({
      "preRequestScripts": [{"origin":"request","script":"new"}],
      "preRequestScript": "old"
    })");

    EXPECT_EQ (read_script (json, "preRequestScripts", "preRequestScript"), "new");
}

TEST (ScriptParts, TheLegacyStringStillWorks) {
    auto json = nlohmann::json::parse (R"({"preRequestScript":"only"})");

    EXPECT_EQ (read_script (json, "preRequestScripts", "preRequestScript"), "only");
}

TEST (ScriptParts, DropsPartsThatAreOnlyWhitespace) {
    // The renderer kept these and MCP dropped them. One rule now: drop.
    auto json = nlohmann::json::parse (R"({
      "preRequestScripts": [
        {"origin":"collection","script":"   "},
        {"origin":"request","script":"real"}
      ]
    })");

    EXPECT_EQ (read_script (json, "preRequestScripts", "preRequestScript"), "real");
}

TEST (ScriptParts, DropsPartsWhoseScriptIsNotAString) {
    // {"script": 42} used to throw type_error.302 out of read_script - which
    // RunContext's constructor calls outside any try/catch, so a bad part
    // orphaned a `runs` row at "pending" instead of returning a 400. Drop it
    // like any other malformed part instead.
    auto json = nlohmann::json::parse (R"({
      "preRequestScripts": [
        {"origin":"collection","script":42},
        {"origin":"request","script":"real"}
      ]
    })");

    EXPECT_EQ (read_script (json, "preRequestScripts", "preRequestScript"), "real");
}

TEST (ScriptParts, MissingEmptyAndAllBlankAllMeanNoScript) {
    auto missing = nlohmann::json::parse (R"({})");
    auto empty   = nlohmann::json::parse (R"({"preRequestScripts":[]})");
    auto blank   = nlohmann::json::parse (
    R"({"preRequestScripts":[{"origin":"request","script":"  "}]})");

    EXPECT_EQ (read_script (missing, "preRequestScripts", "preRequestScript"), "");
    EXPECT_EQ (read_script (empty, "preRequestScripts", "preRequestScript"), "");
    EXPECT_EQ (read_script (blank, "preRequestScripts", "preRequestScript"), "");
}

TEST (ScriptParts, KeepsOrder) {
    auto json = nlohmann::json::parse (R"({
      "preRequestScripts": [
        {"origin":"collection","script":"1"},
        {"origin":"collection","script":"2"},
        {"origin":"request","script":"3"}
      ]
    })");

    EXPECT_EQ (read_script (json, "preRequestScripts", "preRequestScript"), "1\n\n2\n\n3");
}

// POST /run's `tests` field uses the same key name for both forms - unlike
// preRequestScripts/preRequestScript, which are two separate keys. Confirms
// list_key == legacy_key still resolves correctly: the list is found first
// and wins, and a plain string under that same key still works when there is
// no array.
TEST (ScriptParts, SameKeyServesBothFormsForTests) {
    auto list = nlohmann::json::parse (R"({
      "tests": [
        {"origin":"collection","id":"c1","name":"API","script":"pm.test(\"a\",()=>{});"},
        {"origin":"request","id":"r1","script":"pm.test(\"b\",()=>{});"}
      ]
    })");
    EXPECT_EQ (read_script (list, "tests", "tests"),
    "pm.test(\"a\",()=>{});\n\npm.test(\"b\",()=>{});");

    auto legacy = nlohmann::json::parse (R"({"tests":"pm.test(\"a\",()=>{});"})");
    EXPECT_EQ (read_script (legacy, "tests", "tests"), "pm.test(\"a\",()=>{});");
}

// ============================================================================
// One script, several names (#176)
// ============================================================================
//
// The post-request script is stored as `postRequestScript`, sent to
// /execute as `postRequestScript(s)`, and to /runs as `tests`. Each route
// used to know only its own spelling, so a payload composed for one endpoint
// lost its assertions when sent to the other - silently, which is the whole
// problem. `read_post_request_script` answers to every name, so both routes
// accept both and MCP can send one composed payload to either.

using vayu::http::read_post_request_script;
using vayu::http::read_pre_request_script;

TEST (ScriptNames, PostScriptIsReadUnderTheExecuteSpelling) {
    auto list = nlohmann::json::parse (
    R"({"postRequestScripts":[{"origin":"request","script":"pm.test(\"a\",()=>{});"}]})");
    EXPECT_EQ (read_post_request_script (list), "pm.test(\"a\",()=>{});");

    auto legacy = nlohmann::json::parse (R"({"postRequestScript":"legacy"})");
    EXPECT_EQ (read_post_request_script (legacy), "legacy");
}

TEST (ScriptNames, PostScriptIsReadUnderTheRunsSpelling) {
    auto list = nlohmann::json::parse (
    R"({"tests":[{"origin":"collection","script":"pm.test(\"a\",()=>{});"}]})");
    EXPECT_EQ (read_post_request_script (list), "pm.test(\"a\",()=>{});");

    auto legacy = nlohmann::json::parse (R"({"tests":"legacy"})");
    EXPECT_EQ (read_post_request_script (legacy), "legacy");
}

// The point of the unification: a payload MCP composed for a saved request
// (which names its scripts the /execute way) starts a load run with its
// assertions intact. Before, RunContext read only `tests` and this ran none.
TEST (ScriptNames, AnExecuteShapedPayloadKeepsItsAssertionsOnARunPayload) {
    auto composed = nlohmann::json::parse (R"({
      "method":"GET","url":"https://api.example.com","mode":"constant_concurrency",
      "postRequestScripts":[
        {"origin":"collection","id":"c1","name":"API","script":"pm.test(\"chain\",()=>{});"},
        {"origin":"request","id":"r1","script":"pm.test(\"own\",()=>{});"}
      ]
    })");
    EXPECT_EQ (read_post_request_script (composed),
    "pm.test(\"chain\",()=>{});\n\npm.test(\"own\",()=>{});");
}

TEST (ScriptNames, TheFirstNonBlankNameWinsAndNamesAreNeverMerged) {
    auto both = nlohmann::json::parse (R"({"postRequestScript":"explicit","tests":"fallback"})");
    EXPECT_EQ (read_post_request_script (both), "explicit");

    // Blank loses rather than shadowing a real script under the next name.
    auto blank_first =
    nlohmann::json::parse (R"({"postRequestScript":"   ","tests":"real"})");
    EXPECT_EQ (read_post_request_script (blank_first), "real");

    // An all-blank list is no script either, so it does not shadow `tests`.
    auto blank_list = nlohmann::json::parse (
    R"({"postRequestScripts":[{"script":"  "}],"tests":"real"})");
    EXPECT_EQ (read_post_request_script (blank_list), "real");
}

TEST (ScriptNames, PreRequestScriptHasOneSpellingAndNoneMeansEmpty) {
    auto json = nlohmann::json::parse (R"({"preRequestScript":"pre"})");
    EXPECT_EQ (read_pre_request_script (json), "pre");

    // `tests` is a post-request name and must never satisfy the pre-request
    // read - a load payload carrying `tests` has no pre-request script.
    auto tests_only = nlohmann::json::parse (R"({"tests":"pm.test(\"a\",()=>{});"})");
    EXPECT_EQ (read_pre_request_script (tests_only), "");
    EXPECT_TRUE (read_post_request_script (nlohmann::json::object ()).empty ());
}

// A payload that is not an object has no script and must not throw.
// `nlohmann::json::value()` raises type_error.306 on an array or a null, and
// this is read inside RunContext's constructor on a detached worker thread
// with no catch above it - so a non-object run config would take the daemon
// down rather than start no script. The old call sites hid this behind a
// `contains()` check; the guard belongs in the reader, which every caller
// shares.
TEST (ScriptNames, ANonObjectPayloadHasNoScriptAndDoesNotThrow) {
    for (const auto& payload : { nlohmann::json (nullptr), nlohmann::json::array ({ 1, 2 }),
         nlohmann::json ("a string"), nlohmann::json (42) }) {
        EXPECT_NO_THROW ({
            EXPECT_EQ (read_post_request_script (payload), "");
            EXPECT_EQ (read_pre_request_script (payload), "");
            EXPECT_EQ (read_script (payload, "tests", "tests"), "");
        })
        << "payload: " << payload.dump ();
    }
}
