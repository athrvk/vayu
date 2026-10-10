#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file json_path.hpp
 * @brief A hand-written JSONPath subset - `$.a.b`, `['a b']` / `["a b"]`,
 *        `[n]`, `[*]`, `..name` - shared by `extract.json`, `assert.jsonpath`
 *        and `metric.record` (issue #1514), so the kinds cannot come to read
 *        one path expression two ways. A quoted name runs to the next matching
 *        quote and has no escape for it.
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

/**
 * The validate-time refusal for `holder[key]` when it is a string outside the
 * subset, worded for a client and naming @p label. `nullopt` when the path
 * parses, or when the value is absent or not a string: the kind's schema
 * reports those.
 */
[[nodiscard]] std::optional<std::string>
json_path_problem (const nlohmann::json& holder, std::string_view key, std::string_view label);

/** Every node the compiled path reaches, in encounter order. */
[[nodiscard]] std::vector<const nlohmann::json*>
evaluate_json_path (const nlohmann::json& root, const std::vector<JsonPathStep>& steps);

} // namespace vayu::core::detail
