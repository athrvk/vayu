/**
 * @file tests/query_encoding_test.cpp
 * @brief How a query row is written into a URL: Postman's own rule (issue
 *        #1771).
 *
 * `tests/fixtures/query-encoding-conformance.json` is the contract between
 * `core::encode_query_component` and the app's copy
 * (`query-encoding.conformance.test.ts` reads the same file): a case added
 * there fails whichever side answers it differently.
 */

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <string>

#include <nlohmann/json.hpp>

#include "vayu/core/query_encoding.hpp"

namespace {

using nlohmann::json;
using vayu::core::encode_query_component;
using vayu::core::QueryPart;

json load_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "query-encoding-conformance.json";
    std::ifstream in (path);
    if (!in.good ()) {
        ADD_FAILURE () << "fixture missing: " << path;
        return json::object ();
    }
    return json::parse (in);
}

TEST (QueryEncodingConformance, EveryComponentEncodesAsAKeyAndAsAValue) {
    const json fixture     = load_fixture ();
    const json& components = fixture.at ("components");
    // Guards the scan itself: an empty table would pass every case.
    ASSERT_GT (components.size (), 20U);
    for (const json& c : components) {
        const std::string name = c.at ("name").get<std::string> ();
        const std::string text = c.at ("text").get<std::string> ();
        EXPECT_EQ (encode_query_component (text, QueryPart::Key),
        c.at ("key").get<std::string> ())
        << name;
        EXPECT_EQ (encode_query_component (text, QueryPart::Value),
        c.at ("value").get<std::string> ())
        << name;
    }
}

} // namespace
