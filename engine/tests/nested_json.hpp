#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/nested_json.hpp
 * @brief Arrays nested to an exact depth, built without recursion (#2362).
 *
 * nlohmann parses and destroys a deep value iteratively but `dump ()` and the
 * copy constructor recurse, so a test that builds a value past the engine's
 * bound must not stream it, copy it or hand it to `EXPECT_EQ`. Moving each
 * level into the next keeps construction flat.
 */

#include <cstddef>
#include <nlohmann/json.hpp>
#include <string>
#include <utility>

namespace vayu::tests {

/// The scalar `1` wrapped in @p depth arrays: depth 0 is the scalar itself.
inline nlohmann::json nested_array (std::size_t depth) {
    nlohmann::json value = 1;
    for (std::size_t level = 0; level < depth; ++level) {
        nlohmann::json wrapper = nlohmann::json::array ();
        wrapper.push_back (std::move (value));
        value = std::move (wrapper);
    }
    return value;
}

/// The same value as JSON text, for a request body that must never pass
/// through `dump ()` on its way to the server.
inline std::string nested_array_text (std::size_t depth) {
    return std::string (depth, '[') + "1" + std::string (depth, ']');
}

} // namespace vayu::tests
