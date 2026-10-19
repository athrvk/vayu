/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file ordered_json_parse_test.cpp
 * @brief `parse_ordered_json` (utils/ordered_json.hpp): the response-body
 *        parse behind every JSONPath kind. It must answer exactly what
 *        `nlohmann::ordered_json::parse` answers, in linear time, and bound
 *        depth exactly as `json_within_depth` does.
 *
 * Parity is checked through `dump ()`, which writes an `ordered_json` in its
 * own member order, so one string comparison checks members, order, values
 * and number kinds (an integer read as a float dumps with a `.0`).
 */

#include <gtest/gtest.h>

#include <chrono>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/json_depth.hpp"
#include "vayu/utils/ordered_json.hpp"

namespace {

using vayu::utils::parse_ordered_json;

/// Deep enough that no parity case reaches it.
constexpr size_t NO_DEPTH_LIMIT = 1000;

/// A quadratic parse of the wide bodies below takes tens of seconds; a linear
/// one well under one, in a Debug build included.
constexpr auto LINEAR_PARSE_BUDGET = std::chrono::seconds (5);

void expect_parity (std::string_view text) {
    const auto reference =
    nlohmann::ordered_json::parse (text, nullptr, /*allow_exceptions=*/false);
    const auto parsed = parse_ordered_json (text, NO_DEPTH_LIMIT);
    if (reference.is_discarded ()) {
        EXPECT_FALSE (parsed.has_value ()) << "accepted: " << text;
        return;
    }
    ASSERT_HAS_VALUE (parsed) << "refused: " << text;
    EXPECT_EQ (parsed->dump (), reference.dump ()) << text;
    EXPECT_EQ (parsed->type (), reference.type ()) << text;
}

TEST (OrderedJsonParse, AgreesWithTheDomParserOnEveryValueKind) {
    const std::vector<std::string_view> corpus = {
        "{}",
        "[]",
        "null",
        "true",
        "false",
        "0",
        "-0",
        "-1",
        "1.5",
        "-2.5e-3",
        "1E2",
        // Exact past 2^53, exact at both ends of the 64-bit ranges, a float
        // once past uint64.
        "9007199254740993",
        "18446744073709551615",
        "-9223372036854775808",
        "18446744073709551616",
        R"("just a string")",
        R"("tab\tquote\"slash\\\/ é 😀")",
        "\"caf\xc3\xa9 \xe6\xbc\xa2\"",
        R"(  { "a" : 1 , "b" : [ ] }  )",
        R"({"z":{"y":[1,{"x":null,"a":[true,false]}],"b":{}},"a":[[],{}],"m":-7.25})",
        R"([{"id":1,"tags":["a","b"]},{"id":2,"tags":[]},{"id":18446744073709551615}])",
    };
    for (const auto text : corpus) {
        expect_parity (text);
    }
}

TEST (OrderedJsonParse, AgreesWithTheDomParserOnRepeatedKeysAtEveryLevel) {
    const std::vector<std::string_view> corpus = {
        R"({"b":1,"a":3,"b":2})",
        R"({"a":{"k":1,"j":2,"k":3},"b":[{"d":1,"c":2,"d":4}],"a":{"m":0}})",
        R"({"x":[1],"x":{"y":1,"y":{"z":1,"z":2}}})",
        R"({"k":1,"k":2,"k":3,"k":4})",
    };
    for (const auto text : corpus) {
        expect_parity (text);
    }
}

// A small object is scanned and a large one indexed; a repeat must land the
// same on either side of the switch, including a key read before it.
TEST (OrderedJsonParse, AgreesWithTheDomParserOnRepeatsInObjectsOfEverySize) {
    for (size_t members = 1; members <= 40; ++members) {
        std::string body = "{";
        for (size_t i = 0; i < members; ++i) {
            body += (i == 0 ? "\"k" : ",\"k") + std::to_string (i) +
            "\":" + std::to_string (i);
            if (i == members / 2) {
                body += R"(,"k0":"middle")";
            }
        }
        body += R"(,"k0":"last","k)" + std::to_string (members - 1) + R"(":"end"})";
        expect_parity (body);
    }
}

TEST (OrderedJsonParse, AgreesWithTheDomParserOnWhatItRefuses) {
    const std::vector<std::string_view> corpus = {
        "",
        "   ",
        R"({"a":1)",
        R"({"a":1}x)",
        R"({"a":1}{"b":2})",
        R"({"a":01})",
        R"({"a":1.})",
        R"({"a":-})",
        "1e400",
        "-1e400",
        "[1,]",
        "{'a':1}",
        "nan",
        "/* comment */ 1",
        R"("\ud800")",
        "\"\xff\"",
    };
    for (const auto text : corpus) {
        expect_parity (text);
    }
}

// Mutation check: overwrite in place on a repeat but append the key again,
// or keep the first value, and this fails.
TEST (OrderedJsonParse, ARepeatedKeyKeepsItsFirstPositionAndItsLastValue) {
    const auto parsed = parse_ordered_json (R"({"b":1,"a":3,"b":2})", NO_DEPTH_LIMIT);
    ASSERT_HAS_VALUE (parsed);
    EXPECT_EQ (parsed->dump (), R"({"b":2,"a":3})");
}

TEST (OrderedJsonParse, RefusesTruncatedTextTrailingTextAndABadNumber) {
    EXPECT_FALSE (parse_ordered_json (R"({"a":[1,2)", NO_DEPTH_LIMIT).has_value ());
    EXPECT_FALSE (parse_ordered_json (R"({"a":1} trailing)", NO_DEPTH_LIMIT).has_value ());
    EXPECT_FALSE (parse_ordered_json (R"({"a":1.2.3})", NO_DEPTH_LIMIT).has_value ());
}

std::string nested_arrays (size_t levels, std::string_view innermost) {
    return std::string (levels, '[') + std::string (innermost) + std::string (levels, ']');
}

std::string nested_objects (size_t levels, std::string_view innermost) {
    std::string text;
    for (size_t i = 0; i < levels; ++i) {
        text += R"({"a":)";
    }
    text += innermost;
    text.append (levels, '}');
    return text;
}

// The two forms of the bound, held to one answer either side of it.
TEST (OrderedJsonParse, BoundsDepthExactlyAsJsonWithinDepthDoes) {
    constexpr size_t bound = 6;
    std::vector<std::string> bodies;
    for (size_t levels = 1; levels <= bound + 2; ++levels) {
        bodies.push_back (nested_arrays (levels, ""));
        bodies.push_back (nested_arrays (levels, "1"));
        bodies.push_back (nested_objects (levels, "1"));
        bodies.push_back (nested_objects (levels, "[]"));
    }
    bodies.emplace_back ("1");
    bodies.emplace_back (R"([1,[2],{"x":[[[[[3]]]]]},4])");
    for (const auto& body : bodies) {
        const bool within =
        vayu::core::json_within_depth (nlohmann::ordered_json::parse (body), bound);
        EXPECT_EQ (parse_ordered_json (body, bound).has_value (), within) << body;
    }
}

TEST (OrderedJsonParse, RefusesAMebibyteOfOpenBracketsAtTheBound) {
    const std::string body = nested_arrays (size_t{ 1 } << 20, "");
    EXPECT_FALSE (parse_ordered_json (body, 100).has_value ());
}

std::string key_number (size_t i) {
    return "k" + std::to_string (i);
}

// Mutation check: parse with `nlohmann::ordered_json::parse` instead and both
// wide-object tests run for tens of seconds and fail the budget.
TEST (OrderedJsonParse, AHundredThousandDistinctKeysParseInLinearTime) {
    constexpr size_t keys = 100'000;
    std::string body      = "{";
    for (size_t i = 0; i < keys; ++i) {
        body += (i == 0 ? "\"" : ",\"") + key_number (i) + "\":" + std::to_string (i);
    }
    body += "}";

    const auto started = std::chrono::steady_clock::now ();
    const auto parsed  = parse_ordered_json (body, NO_DEPTH_LIMIT);
    const auto elapsed = std::chrono::steady_clock::now () - started;

    ASSERT_HAS_VALUE (parsed);
    ASSERT_EQ (parsed->size (), keys);
    EXPECT_EQ (parsed->begin ().key (), "k0");
    EXPECT_EQ ((--parsed->end ()).key (), key_number (keys - 1));
    EXPECT_LT (elapsed, LINEAR_PARSE_BUDGET);
}

TEST (OrderedJsonParse, EveryKeyRepeatedStillParsesInLinearTime) {
    constexpr size_t keys = 50'000;
    std::string body      = "{";
    for (size_t pass = 0; pass < 2; ++pass) {
        for (size_t i = 0; i < keys; ++i) {
            body += (body.size () == 1 ? "\"" : ",\"") + key_number (i) +
            "\":" + std::to_string (pass);
        }
    }
    body += "}";

    const auto started = std::chrono::steady_clock::now ();
    const auto parsed  = parse_ordered_json (body, NO_DEPTH_LIMIT);
    const auto elapsed = std::chrono::steady_clock::now () - started;

    ASSERT_HAS_VALUE (parsed);
    ASSERT_EQ (parsed->size (), keys);
    EXPECT_EQ (parsed->begin ().key (), "k0");
    EXPECT_EQ (parsed->begin ().value (), 1);
    EXPECT_EQ ((--parsed->end ()).key (), key_number (keys - 1));
    EXPECT_EQ ((--parsed->end ()).value (), 1);
    EXPECT_LT (elapsed, LINEAR_PARSE_BUDGET);
}

} // namespace
