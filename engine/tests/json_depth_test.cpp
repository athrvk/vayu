/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file json_depth_test.cpp
 * @brief `json_within_depth` (core/json_depth.hpp): the one nesting bound the
 *        OpenAPI reader and the element pipeline's body parse both apply.
 *
 * Every tree here is built a few levels past its bound and no further, so a
 * regression of the helper's own recursion shows up as a wrong answer rather
 * than as a stack overflow in the test binary.
 */

#include <gtest/gtest.h>

#include <cstddef>
#include <string>

#include <nlohmann/json.hpp>

#include "vayu/core/json_depth.hpp"

namespace {

using vayu::core::json_within_depth;

/// @p levels arrays nested in one another, the innermost empty: that array
/// sits at depth @p levels - 1.
std::string nested_arrays (size_t levels) {
    return std::string (levels, '[') + std::string (levels, ']');
}

template <typename Json> class JsonDepthTest : public ::testing::Test {};

using JsonTypes = ::testing::Types<nlohmann::json, nlohmann::ordered_json>;
TYPED_TEST_SUITE (JsonDepthTest, JsonTypes);

TYPED_TEST (JsonDepthTest, ADocumentAtTheBoundPasses) {
    constexpr size_t bound = 8;
    const auto tree        = TypeParam::parse (nested_arrays (bound + 1));
    EXPECT_TRUE (json_within_depth (tree, bound));
}

TYPED_TEST (JsonDepthTest, ADocumentOneLevelPastTheBoundFails) {
    constexpr size_t bound = 8;
    const auto tree        = TypeParam::parse (nested_arrays (bound + 2));
    EXPECT_FALSE (json_within_depth (tree, bound));
}

TYPED_TEST (JsonDepthTest, AScalarCountsAsALevelBelowItsContainer) {
    constexpr size_t bound = 3;
    // The 1 sits at depth 3 here and at depth 4 in the second tree.
    EXPECT_TRUE (json_within_depth (TypeParam::parse (R"([[[1]]])"), bound));
    EXPECT_FALSE (json_within_depth (TypeParam::parse (R"([[[[1]]]])"), bound));
}

TYPED_TEST (JsonDepthTest, ObjectsAndArraysCountAlike) {
    constexpr size_t bound = 3;
    EXPECT_TRUE (json_within_depth (TypeParam::parse (R"({"a":{"b":[1]}})"), bound));
    EXPECT_FALSE (json_within_depth (TypeParam::parse (R"({"a":{"b":[{"c":1}]}})"), bound));
}

TYPED_TEST (JsonDepthTest, TheDeepBranchIsFoundWhateverItsSiblingsLookLike) {
    constexpr size_t bound = 4;
    const auto tree = TypeParam::parse (R"([1,[2],{"x":[[[[[3]]]]]},4])");
    EXPECT_FALSE (json_within_depth (tree, bound));
}

TYPED_TEST (JsonDepthTest, AScalarRootAndAnEmptyContainerAlwaysPass) {
    EXPECT_TRUE (json_within_depth (TypeParam (1), 0));
    EXPECT_TRUE (json_within_depth (TypeParam::array (), 0));
    EXPECT_TRUE (json_within_depth (TypeParam::object (), 0));
}

} // namespace
