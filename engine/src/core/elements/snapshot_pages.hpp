#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief The whole of a paged list `assert.snapshot` compares (#3824): every
 *        page a server's `nextCursor` names, read through
 *        `ElementContext::send_list_page` and `core::collect_mcp_list_pages`.
 *
 * A list that cannot be read to its end fails the assertion with the reason,
 * never passes on the pages read so far: a baseline compared against part of a
 * list would report every item past the cut as removed, or pass a change on a
 * page nobody read.
 */

#include <nlohmann/json.hpp>

#include <expected>
#include <optional>

#include "vayu/core/elements.hpp"
#include "vayu/core/list_snapshot.hpp"

namespace vayu::core {

/**
 * @brief What `assert.snapshot` compares for @p first_page, the step's own
 *        reply: nothing when that reply is the whole list (no `nextCursor`,
 *        or no list at the method's place, which `snapshot_drift` names), else
 *        one reply whose `result.<result_key>` holds every page's items in
 *        page order.
 *
 * The failure's message is the whole assertion message, naming the method and
 * the page; `cancelled` says the run ended while a page was in flight.
 */
[[nodiscard]] std::expected<std::optional<nlohmann::ordered_json>, ListPageFailure>
whole_snapshot_reply (const SnapshotList& list,
const nlohmann::ordered_json& first_page,
const ElementContext& ctx);

} // namespace vayu::core
