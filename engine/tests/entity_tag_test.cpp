/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/entity_tag_test.cpp
 * @brief The `ETag` a whole-record resource carries and the `If-Match` parse
 *        and comparison a PUT judges it by (#2433).
 */

#include <gtest/gtest.h>

#include <array>
#include <cstdint>
#include <string>
#include <string_view>

#include "optional_assert.hpp"
#include "vayu/http/entity_tag.hpp"

namespace {

using vayu::http::entity_tag;
using vayu::http::IfMatch;

constexpr int64_t STORED = 1792359304908;

bool holds (std::string_view field, int64_t updated_at = STORED) {
    const auto parsed = IfMatch::parse (field);
    EXPECT_TRUE (parsed.has_value ()) << field;
    return parsed.has_value () && parsed->holds_for (updated_at);
}

TEST (EntityTagTest, IsTheWeakTagOfUpdatedAt) {
    EXPECT_EQ (entity_tag (STORED), "W/\"1792359304908\"");
}

TEST (EntityTagTest, TheTagItIssuesHoldsForThatVersionOnly) {
    EXPECT_TRUE (holds (entity_tag (STORED)));
    EXPECT_FALSE (holds (entity_tag (STORED), STORED + 1));
}

// Weak comparison: the opaque tag decides, `W/` or not.
TEST (EntityTagTest, ComparesTheOpaqueTagWithOrWithoutTheWeakPrefix) {
    EXPECT_TRUE (holds ("\"1792359304908\""));
    EXPECT_FALSE (holds ("W/\"1792359304907\""));
}

TEST (EntityTagTest, StarHoldsForAnyStoredRow) {
    EXPECT_TRUE (holds ("*"));
    EXPECT_TRUE (holds (" * "));
}

// Every line of a repeated header arrives joined with commas, empty elements
// included, which RFC 9110 5.6.1.2 says to skip.
TEST (EntityTagTest, AListHoldsWhenAnyMemberNamesTheVersion) {
    EXPECT_TRUE (holds ("W/\"1\", W/\"1792359304908\""));
    EXPECT_TRUE (holds ("W/\"1\",W/\"1792359304908\",,"));
    EXPECT_TRUE (holds (",\t\"1792359304908\" ,\"2\""));
    EXPECT_FALSE (holds ("W/\"1\", W/\"2\""));
}

// A comma is an `etagc`, so a tag carrying one stays one tag.
TEST (EntityTagTest, ACommaInsideATagDoesNotSplitIt) {
    const auto parsed = IfMatch::parse ("\"a,b\", W/\"1792359304908\"");
    ASSERT_HAS_VALUE (parsed);
    EXPECT_TRUE (parsed->holds_for (STORED));
}

TEST (EntityTagTest, RefusesWhatIsNotStarOrEntityTags) {
    constexpr auto malformed = std::to_array<std::string_view> ({
    "",
    "   ",
    ",",
    "1792359304908",
    "W/1792359304908",
    "w/\"1792359304908\"",
    "\"1792359304908",
    "\"17923 59304908\"",
    "\"1\" \"2\"",
    "\"1\"x",
    "*, \"1\"",
    "\"1\", *",
    "**",
    });
    for (const auto field : malformed) {
        const auto parsed = IfMatch::parse (field);
        EXPECT_FALSE (parsed.has_value ()) << "'" << field << "'";
        if (!parsed) {
            EXPECT_NE (parsed.error ().find ("If-Match"), std::string::npos);
        }
    }
}

} // namespace
