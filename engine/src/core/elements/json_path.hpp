#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file json_path.hpp
 * @brief A hand-written JSONPath subset - `$.a.b`, `[n]`, `[*]`, `..name` -
 *        shared by `extract.json` and `assert.jsonpath` (issue #1514), so the
 *        two kinds cannot come to read one path expression two ways.
 *
 * Source-tree-local (not under `include/vayu/`): nothing outside
 * `engine/src/core/elements/` needs this subset.
 */

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace vayu::core::detail {

struct JsonPathStep {
    enum class Kind : std::uint8_t { Member, Index, IndexAny, Recursive };
    Kind kind;
    std::string name;
    long index = 0;
};

/** `std::nullopt` for anything outside the subset (a filter, malformed syntax). */
[[nodiscard]] std::optional<std::vector<JsonPathStep>> parse_json_path (std::string_view path);

/** Every node the compiled path reaches, in encounter order. */
[[nodiscard]] std::vector<const nlohmann::json*>
evaluate_json_path (const nlohmann::json& root, const std::vector<JsonPathStep>& steps);

} // namespace vayu::core::detail
