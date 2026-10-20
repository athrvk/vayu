/**
 * @file tests/auth_header_precedence_test.cpp
 * @brief Which header a request's auth writes when the request already carries
 *        one (issue #2475): the typed header wins, matched case-insensitively.
 *
 * `tests/fixtures/auth-header-precedence.json` is the contract between
 * `apply_auth` and the snippet generators' `prepareRequest`
 * (`app/src/services/codegen/prepare.conformance.test.ts` reads the same
 * file): a case added there fails whichever side answers it differently.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/http/auth_resolver.hpp"
#include "vayu/types.hpp"

namespace {

using nlohmann::json;
using HeaderPairs = std::vector<std::pair<std::string, std::string>>;

json load_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "auth-header-precedence.json";
    std::ifstream in (path);
    if (!in.good ()) {
        ADD_FAILURE () << "fixture missing: " << path;
        return json::object ();
    }
    return json::parse (in);
}

/// @p headers as sorted (name, value) pairs, the name spelled as the map holds it.
HeaderPairs sorted_pairs (const vayu::HeaderList& headers) {
    HeaderPairs pairs;
    for (const auto& [name, value] : headers) {
        pairs.emplace_back (name, value);
    }
    std::ranges::sort (pairs);
    return pairs;
}

HeaderPairs expected_pairs (const json& headers) {
    HeaderPairs pairs;
    for (const json& pair : headers) {
        pairs.emplace_back (
        pair.at (0).get<std::string> (), pair.at (1).get<std::string> ());
    }
    std::ranges::sort (pairs);
    return pairs;
}

TEST (AuthHeaderPrecedence, EveryCaseWritesTheHeadersTheFixtureExpects) {
    const json fixture = load_fixture ();
    const json& cases  = fixture.at ("cases");
    // Guards the scan itself: an empty table would pass every case.
    ASSERT_GT (cases.size (), 10U);
    for (const json& c : cases) {
        const std::string name = c.at ("name").get<std::string> ();
        vayu::Request req;
        req.url = c.at ("url").get<std::string> ();
        for (const auto& [key, value] : c.at ("headers").items ()) {
            req.headers[key] = value.get<std::string> ();
        }
        const auto result = vayu::http::apply_auth (req, c.at ("auth"), nullptr);
        EXPECT_TRUE (result.ok) << name;
        const json& expected = c.at ("expected");
        EXPECT_EQ (sorted_pairs (req.headers), expected_pairs (expected.at ("headers")))
        << name;
        EXPECT_EQ (req.url, expected.at ("url").get<std::string> ()) << name;
    }
}

} // namespace
