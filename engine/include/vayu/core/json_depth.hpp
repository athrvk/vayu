#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/json_depth.hpp
 * @brief The engine's one nesting-depth rule for a parsed JSON tree.
 *
 * nlohmann's parser is iterative, so a document of any depth parses; what
 * recurses is everything downstream (`dump`, a copy, a comparison, the schema
 * translation). A tree built from text an attacker chose therefore has to be
 * bounded before anything walks it. The OpenAPI document reader calls this;
 * the element pipeline's response-body parse applies the same measure while it
 * builds the tree (`parse_ordered_json`), and `ordered_json_parse_test.cpp`
 * holds the two to one answer to "how deep is too deep".
 */

#include <cstddef>

#include <nlohmann/json.hpp>

namespace vayu::core {

namespace detail {

template <typename Json>
[[nodiscard]] bool within_depth (const Json& node, size_t depth, size_t max_depth) {
    // Tested before descending, so the walk itself never goes past the bound.
    if (depth > max_depth) {
        return false;
    }
    if (!node.is_structured ()) {
        return true;
    }
    for (const auto& child : node) {
        if (!within_depth (child, depth + 1, max_depth)) {
            return false;
        }
    }
    return true;
}

} // namespace detail

/**
 * Whether no node of @p root sits more than @p max_depth containers below it.
 * The root is at depth 0 and a child is one deeper than its parent, scalars
 * included: `{"a": [1]}` puts the `1` at depth 2. Works for `nlohmann::json` and
 * `nlohmann::ordered_json` alike.
 */
template <typename Json>
[[nodiscard]] bool json_within_depth (const Json& root, size_t max_depth) {
    return detail::within_depth (root, 0, max_depth);
}

} // namespace vayu::core
