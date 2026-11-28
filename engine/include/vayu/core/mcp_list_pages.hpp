#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/mcp_list_pages.hpp
 * @brief Every entry of one paged MCP list (`tools/list` and its kin), by
 *        following `result.nextCursor` until a page carries none (#3824).
 *
 * `POST /import/mcp` and `assert.snapshot` read a server's lists through this
 * one loop, so the two cannot disagree about when a list ends. It owns the
 * three bounds a server one typed in could otherwise hold the engine to - a
 * page count, a cursor handed back a second time, and an entry budget - and
 * names which one was met; the caller words the refusal, because an import
 * answers an HTTP status and an element records a failed assertion.
 *
 * **Nothing here sends.** The caller's @ref McpPageSender makes one call and
 * returns that reply's `result` object, so the transport, the deadline and the
 * byte budget stay the caller's own.
 */

#include <nlohmann/json.hpp>

#include <cstddef>
#include <cstdint>
#include <expected>
#include <functional>
#include <optional>
#include <string>

namespace vayu::core {

/// Why a @ref McpPageSender could not answer a page. Carried through
/// untouched, so the caller's own refusal (status and text) survives the loop.
struct McpPageFailure {
    int status = 0;
    std::string message;
};

/// Sends one page: the call made with `params.cursor` set to @p cursor (no
/// `cursor` member for the first page), answered with that reply's `result`.
/// A reply without a `result` object is answered as any non-object value, which
/// the loop reports as a missing list.
using McpPageSender =
std::function<std::expected<nlohmann::ordered_json, McpPageFailure> (const std::optional<std::string>& cursor)>;

/// The entries of every page, in the order the pages were read.
struct McpListPages {
    /// One array holding every page's @c key entries.
    nlohmann::ordered_json rows = nlohmann::ordered_json::array ();
    /// How many calls the sender made.
    std::size_t pages_sent = 0;
};

/// Which bound ended the loop, or the sender's own failure.
enum class McpListFailureKind : std::uint8_t {
    /// A page still carried a `nextCursor` after `max_pages` pages.
    PageCapReached,
    /// A page answered a cursor the loop had already sent, so the list would
    /// never end.
    RepeatedCursor,
    /// The entries read so far passed the budget's cap.
    ItemsOverBudget,
    /// A page was not an object, or its list member was absent or not an array.
    MissingList,
    /// The sender returned a failure, in @ref McpListFailure::send.
    SendFailed,
};

struct McpListFailure {
    McpListFailureKind kind = McpListFailureKind::SendFailed;
    /// Calls the sender had made when the loop stopped, the failing one included.
    std::size_t pages_sent = 0;
    /// The sender's failure; meaningful for `SendFailed` only.
    McpPageFailure send;
};

/**
 * @brief Reads every page of one list through @p send.
 *
 * A page ends the list when its `nextCursor` is absent, not a string, or
 * empty. An entry counts against @p items_used as its page arrives, and a page
 * that takes the total past @p max_items fails: an import passes the one counter
 * every list of the import shares, so the cap is on all of them together, and an
 * element passes a counter of its own. The counter is left at what was counted
 * even on a failure.
 *
 * @param key       The `result` member that holds a page's entries
 *                  (`tools`, `resources`, `resourceTemplates`, `prompts`).
 * @param max_pages The most calls made, the first included.
 */
[[nodiscard]] std::expected<McpListPages, McpListFailure>
collect_mcp_list_pages (const McpPageSender& send,
const char* key,
std::size_t max_pages,
std::size_t& items_used,
std::size_t max_items);

} // namespace vayu::core
