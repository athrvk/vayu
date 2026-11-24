#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file list_snapshot.hpp
 * @brief What `assert.snapshot` compares: the items an MCP list method
 *        answers (`tools/list`, `resources/list`, `prompts/list`) against a
 *        recorded baseline (#3807).
 *
 * Each list names the fields of an item that describe it to a client - a
 * tool's `inputSchema` is part of its surface, a server's `_meta` is not - and
 * the field that identifies it. Items are matched by that identity, so a
 * server that reorders its list has not changed it; a member order inside an
 * object is irrelevant too, while an array inside a field (`required`,
 * `enum`) is compared in order, because there it is the value.
 */

#include <nlohmann/json.hpp>
#include <optional>
#include <span>
#include <string>
#include <string_view>

namespace vayu::core {

/// One list method the snapshot understands.
struct SnapshotList {
    /// The JSON-RPC method, and what `assert.snapshot`'s `method` names.
    std::string_view method;
    /// The member of `result` that holds the array.
    std::string_view result_key;
    /// The field that names an item, a text and unique within the list.
    std::string_view identity_key;
    /// The fields compared; every other member of an item is left out.
    std::span<const std::string_view> fields;
};

/// Every list a snapshot can read, in the order the config schema offers them.
[[nodiscard]] std::span<const SnapshotList> snapshot_lists ();

/// The list named @p method, or null when no list answers to it.
[[nodiscard]] const SnapshotList* find_snapshot_list (std::string_view method);

/**
 * @brief Why @p baseline cannot be compared against, or nothing when it can:
 *        not an array, an item that is not an object, one without a text
 *        identity, or two with the same one. The reason names `baseline`.
 */
[[nodiscard]] std::optional<std::string>
snapshot_baseline_problem (const nlohmann::json& baseline, const SnapshotList& list);

/**
 * @brief How the items @p reply lists differ from @p baseline, or nothing when
 *        they do not.
 *
 * @p reply is the whole JSON-RPC response, the list at `result.<result_key>`.
 * The answer is one line: `tools/list changed: removed 'a'; added 'b'; 'c'
 * differs at /inputSchema/properties/x/type`, a changed item naming its first
 * differing JSON Pointers (RFC 6901). It lists at most
 * `constants::elements::MAX_SNAPSHOT_FINDINGS` findings and then ` (N more)`.
 * A reply that holds no list, or an item with no identity, is a difference
 * too, never a pass. @p baseline must already satisfy
 * `snapshot_baseline_problem`.
 */
[[nodiscard]] std::optional<std::string> snapshot_drift (const SnapshotList& list,
const nlohmann::ordered_json& reply,
const nlohmann::json& baseline);

} // namespace vayu::core
