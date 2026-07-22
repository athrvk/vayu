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

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include "vayu/http/script_parts.hpp"

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
    auto blank =
    nlohmann::json::parse (R"({"preRequestScripts":[{"origin":"request","script":"  "}]})");

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
