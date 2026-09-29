/**
 * @file tests/path_variables_test.cpp
 * @brief Which URL segments are Postman `:name` path variables, and how a
 *        value is written into one (issue #1764).
 *
 * The rule is Postman's own (`postman-url-encoder/parser` plus
 * `postman-collection`'s `parsePathVariable`), so the cases here are the
 * places a hand-written scanner can disagree with it: a port, a `:` in the
 * query or the fragment, a `{{variable}}` holding a separator, a `.suffix`.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/core/path_template.hpp"

namespace {

using nlohmann::json;
using vayu::core::path_variable_segments;

std::vector<std::string> names_in (const std::string& url) {
    std::vector<std::string> out;
    for (const auto& segment : path_variable_segments (url)) {
        out.push_back (segment.name);
    }
    return out;
}

using Names = std::vector<std::string>;

TEST (PathVariableSegments, FindsEveryWholeSegmentThatStartsWithAColon) {
    EXPECT_EQ (names_in ("https://api.test/users/:id/posts/:postId"),
    (Names{ "id", "postId" }));
    EXPECT_EQ (names_in ("{{baseUrl}}/users/:id/copies/:id"), (Names{ "id", "id" }));
    EXPECT_EQ (names_in ("/relative/:id"), (Names{ "id" }));
    EXPECT_EQ (names_in ("api.test/:user-id/:a_b"), (Names{ "user-id", "a_b" }));
    // A backslash is a `/` to Postman's parser.
    EXPECT_EQ (names_in ("https://api.test\\users\\:id"), (Names{ "id" }));
    // Extra slashes after the scheme are the authority's, not an empty path.
    EXPECT_EQ (names_in ("http:////host/:id"), (Names{ "id" }));
}

TEST (PathVariableSegments, NeverReadsTheAuthorityQueryOrFragment) {
    EXPECT_TRUE (names_in ("http://localhost:8080").empty ());
    EXPECT_TRUE (names_in ("localhost:3000").empty ());
    EXPECT_EQ (names_in ("localhost:3000/:id"), (Names{ "id" }));
    EXPECT_EQ (names_in ("http://user:pw@host:1/:id"), (Names{ "id" }));
    EXPECT_TRUE (names_in ("https://api.test/search?tag=/:id&t=12:30").empty ());
    EXPECT_TRUE (names_in ("https://api.test/a#/:id").empty ());
    // A mid-segment colon (`{name}:cancel` in a Google API) is not one.
    EXPECT_TRUE (names_in ("https://api.test/v1/ops/x:cancel").empty ());
}

TEST (PathVariableSegments, KeepsAVariableHoldingASeparatorWhole) {
    // `{{a/:b}}` is one opaque token, so its `/:b` is no segment of this URL.
    EXPECT_TRUE (names_in ("https://api.test/{{a/:b}}").empty ());
    EXPECT_EQ (names_in ("{{scheme://host}}/:id"), (Names{ "id" }));
    // The query separator inside a token does not end the path.
    EXPECT_EQ (names_in ("https://api.test/{{a?b}}/:id"), (Names{ "id" }));
}

TEST (PathVariableSegments, NamesRunToTheFirstDotAndAnEmptyNameIsNone) {
    const auto segments =
    path_variable_segments ("https://h/:id.json/:/:.x/::y");
    ASSERT_EQ (segments.size (), 2u);
    EXPECT_EQ (segments[0].name, "id");
    // Offset and length cover `:id`, leaving `.json` in place.
    EXPECT_EQ (segments[0].offset, std::string ("https://h/").size ());
    EXPECT_EQ (segments[0].length, 3u);
    EXPECT_EQ (segments[1].name, ":y");
}

TEST (PathVariableSegments, KeepsOneSlashOfAFileUrl) {
    EXPECT_EQ (names_in ("file:///:dir/x"), (Names{ "dir" }));
}

TEST (EncodePathSegmentValue, EncodesEverythingButTheUnreservedSetAndKeepsTokens) {
    using vayu::core::encode_path_segment_value;
    EXPECT_EQ (encode_path_segment_value ("a-b_c.d~e"), "a-b_c.d~e");
    EXPECT_EQ (encode_path_segment_value ("a b/c?d#e%f"), "a%20b%2Fc%3Fd%23e%25f");
    // A `%XX` triplet is already encoded and is sent as written; a `%` that
    // starts none (`%g1`, `%4`, a trailing `%`) is data.
    EXPECT_EQ (encode_path_segment_value ("a%40b.com"), "a%40b.com");
    EXPECT_EQ (encode_path_segment_value ("%2f%2F/%"), "%2f%2F%2F%25");
    EXPECT_EQ (encode_path_segment_value ("%g1 %4"), "%25g1%20%254");
    EXPECT_EQ (encode_path_segment_value ("\xC3\xA9"), "%C3%A9");
    EXPECT_EQ (encode_path_segment_value ("x {{data.id}}/y"), "x%20{{data.id}}%2Fy");
    // A lone `{{` is no token and is encoded.
    EXPECT_EQ (encode_path_segment_value ("{{x"), "%7B%7Bx");
}

TEST (SubstitutePathVariables, AnswersOnlyEnabledPathRowsAndLeavesTheRestLiteral) {
    const json rows     = json::parse (R"([
        {"key":"id","value":"1","enabled":true,"in":"path"},
        {"key":"q","value":"2","enabled":true},
        {"key":"q","value":"3","enabled":true,"in":"query"},
        {"key":"off","value":"4","enabled":false,"in":"path"},
        {"key":"dup","value":"first","enabled":true,"in":"path"},
        {"key":"dup","value":"last","enabled":true,"in":"path"},
        {"key":"dup","value":"disabled","enabled":false,"in":"path"},
        {"key":"implicit","value":"on","in":"path"}
    ])");
    const auto identity = [] (const std::string& value) { return value; };
    EXPECT_EQ (vayu::core::substitute_path_variables (
               "https://h:1/:id/:q/:off/:dup/:implicit?:id", rows, identity),
    "https://h:1/1/:q/:off/last/on?:id");
    EXPECT_EQ (vayu::core::substitute_path_variables ("https://h/:id", json::array (), identity),
    "https://h/:id");
}

TEST (SettlePathVariables, WritesAnAnsweredValueAsOneSegmentAndLeavesATokenWaiting) {
    vayu::Request request;
    request.url = "https://h/:a/:b/:c/:a";
    request.path_variables = { { "a", "x y/z" }, { "b", "{{later}}" }, { "c", "" } };
    vayu::core::settle_path_variables (request, vayu::core::PathSettle::Answered);
    // An empty value leaves its segment literal, as composition does.
    EXPECT_EQ (request.url, "https://h/x%20y%2Fz/:b/:c/x%20y%2Fz");
    ASSERT_EQ (request.path_variables.size (), 1u);
    EXPECT_EQ (request.path_variables[0].key, "b");

    vayu::core::settle_path_variables (request, vayu::core::PathSettle::All);
    EXPECT_EQ (request.url, "https://h/x%20y%2Fz/{{later}}/:c/x%20y%2Fz");
    EXPECT_TRUE (request.path_variables.empty ());
}

TEST (PendingPathVariablesOf, KeepsTheAnsweringPathRowOfEachKey) {
    const json rows    = json::parse (R"([
        {"key":"q","value":"query"},
        {"key":"id","value":"first","in":"path"},
        {"key":"id","value":"last","in":"path"},
        {"key":"off","value":"x","enabled":false,"in":"path"}
    ])");
    const auto pending = vayu::core::pending_path_variables_of (rows);
    ASSERT_EQ (pending.size (), 1u);
    EXPECT_EQ (pending[0].key, "id");
    EXPECT_EQ (pending[0].value, "last");
}

/**
 * `tests/fixtures/path-variable-conformance.json` is the contract between this
 * scanner and substitution and the app's copy of both
 * (`path-variables.conformance.test.ts` reads the same file): a case added
 * there fails whichever side answers it differently.
 */
TEST (PathVariableConformance, EveryFixtureCaseMatches) {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "path-variable-conformance.json";
    std::ifstream in (path);
    ASSERT_TRUE (in.good ()) << "fixture missing: " << path;
    const json fixture = json::parse (in);
    const json& cases  = fixture.at ("cases");
    // Guards the scan itself: an empty table would pass every case.
    ASSERT_GT (cases.size (), 20u);
    const auto identity = [] (const std::string& value) { return value; };
    for (const json& c : cases) {
        const std::string name = c.at ("name").get<std::string> ();
        const std::string url  = c.at ("url").get<std::string> ();
        json segments          = json::array ();
        for (const auto& segment : path_variable_segments (url)) {
            segments.push_back ({ { "name", segment.name },
            { "offset", segment.offset }, { "length", segment.length } });
        }
        EXPECT_EQ (segments, c.at ("segments")) << name;
        EXPECT_EQ (vayu::core::substitute_path_variables (url, c.at ("rows"), identity),
        c.at ("composed").get<std::string> ())
        << name;
    }
}

} // namespace
