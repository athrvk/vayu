#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/ordered_json.hpp
 * @brief The engine's one parse of untrusted JSON text into an `ordered_json`
 *        in time linear in its length (issues #2459, #2497).
 *
 * `nlohmann::ordered_json::parse` places each member with `ordered_map::emplace`,
 * which scans every member already read to find a repeated key, so an object of
 * n members costs O(n^2). A hundred thousand short keys is about a megabyte of
 * text and tens of seconds of one core. Every parse of text a server, an
 * imported file or a client body chose therefore goes through `parse_ordered_json`;
 * text the engine wrote itself (a stored row it serialised) may keep using
 * `ordered_json::parse`.
 */

#include <cstddef>
#include <limits>
#include <nlohmann/json.hpp>
#include <optional>
#include <string_view>

namespace vayu::utils {

/// `max_depth` for a caller that bounds nothing here: the parse itself recurses
/// nowhere, so depth only matters to what walks the tree afterwards.
inline constexpr size_t ORDERED_JSON_UNBOUNDED = std::numeric_limits<size_t>::max ();

/**
 * @p text as an `ordered_json`, in time linear in its length, or `nullopt`
 * when it is not one strict JSON document or a node sits deeper than
 * @p max_depth (measured as `json_within_depth` measures it). A repeated key
 * keeps its first position and its last value, as `ordered_json::parse` does.
 * The depth is checked while the tree is built, so a deep body costs the bound
 * in memory rather than its length. Pass `ORDERED_JSON_UNBOUNDED` to accept any
 * depth.
 */
[[nodiscard]] std::optional<nlohmann::ordered_json>
parse_ordered_json (std::string_view text, size_t max_depth);

} // namespace vayu::utils
