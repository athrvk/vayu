/**
 * @file tests/set_cookie_test.cpp
 * @brief Set-Cookie parsing (issue #301), driven by the cross-language
 *        conformance fixture.
 *
 * `tests/fixtures/set-cookie-conformance.json` is the contract between this
 * suite and the app's vitest suite
 * (`app/src/modules/request-builder/components/ResponseViewer/parse-set-cookie.conformance.test.ts`):
 * the engine parses the header for `pm.response.cookies`, the renderer parses
 * the same header for the response Cookies tab, and a case answered two ways
 * is a user reading one thing on screen and asserting another in a script.
 * Add a case to the fixture and whichever side does not handle it goes red.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/http/set_cookie.hpp"

using nlohmann::json;

namespace {

json load_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "set-cookie-conformance.json";
    std::ifstream in (path);
    EXPECT_TRUE (in.good ()) << "fixture missing: " << path;
    return json::parse (in);
}

// A `singleLine` case is one received Set-Cookie line (issue #2460) and goes
// through the parser that never splits on a comma; the rest are folded headers.
std::vector<vayu::http::SetCookie> parse_case (const json& c) {
    const auto header = c["header"].get<std::string> ();
    if (!c.value ("singleLine", false)) {
        return vayu::http::parse_set_cookie (header);
    }
    const auto cookie = vayu::http::parse_set_cookie_line (header);
    return cookie ? std::vector<vayu::http::SetCookie>{ *cookie } :
                    std::vector<vayu::http::SetCookie>{};
}

} // namespace

TEST (SetCookieConformance, EveryFixtureCasePasses) {
    const json fixture = load_fixture ();
    ASSERT_FALSE (fixture["cases"].empty ())
    << "conformance fixture scanned nothing";

    for (const auto& c : fixture["cases"]) {
        const std::string name = c["name"].get<std::string> ();
        const auto parsed      = parse_case (c);
        const auto& expected   = c["expected"];

        ASSERT_EQ (parsed.size (), expected.size ()) << "case: " << name;
        for (size_t i = 0; i < parsed.size (); i++) {
            EXPECT_EQ (parsed[i].name, expected[i]["name"].get<std::string> ())
            << "case: " << name << " [" << i << "]";
            EXPECT_EQ (parsed[i].value, expected[i]["value"].get<std::string> ())
            << "case: " << name << " [" << i << "]";
            EXPECT_EQ (parsed[i].attrs,
            expected[i]["attrs"].get<std::vector<std::string>> ())
            << "case: " << name << " [" << i << "]";
        }
    }
}

// The fixture is a table of headers; this is the rule behind it, stated once so
// a case added later cannot be "fixed" by loosening the boundary back into the
// naive split the renderer's parser was written to replace.
TEST (SetCookie, ACommaOnlyEndsACookieWhenAnAssignmentFollowsIt) {
    // Every comma here sits inside a date, so a naive split would report six
    // cookies with names like "21 Oct 2015 07:28:00 GMT".
    const auto parsed =
    vayu::http::parse_set_cookie ("a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT, "
                                  "b=2; Expires=Thu, 22 Oct 2015 07:28:00 GMT");
    ASSERT_EQ (parsed.size (), 2U);
    EXPECT_EQ (parsed[0].name, "a");
    EXPECT_EQ (parsed[0].value, "1");
    EXPECT_EQ (parsed[1].name, "b");
    EXPECT_EQ (parsed[1].value, "2");
}

TEST (SetCookie, ALineIsNeverSplitOnAComma) {
    const auto cookie = vayu::http::parse_set_cookie_line ("a=1, b=2; Path=/");
    ASSERT_HAS_VALUE (cookie);
    EXPECT_EQ (cookie->name, "a");
    EXPECT_EQ (cookie->value, "1, b=2");

    // The same text folded is two cookies: the fold is what loses the answer.
    EXPECT_EQ (vayu::http::parse_set_cookie ("a=1, b=2; Path=/").size (), 2U);
}

TEST (SetCookie, ALineNamingNoCookieIsNothing) {
    EXPECT_FALSE (vayu::http::parse_set_cookie_line ("").has_value ());
    EXPECT_FALSE (vayu::http::parse_set_cookie_line ("no-equals; Path=/").has_value ());
    EXPECT_FALSE (vayu::http::parse_set_cookie_line ("=orphan").has_value ());
}
