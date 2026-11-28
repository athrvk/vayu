/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/mcp_list_pages.hpp"

#include <set>
#include <utility>

namespace vayu::core {

namespace {

using ordered_json = nlohmann::ordered_json;

/// The array @p page keeps its entries under @p key, or null when @p page has
/// none (`find` on a value that is not an object finds nothing).
ordered_json* page_rows (ordered_json& page, const char* key) {
    const auto rows = page.find (key);
    return rows == page.end () || !rows->is_array () ? nullptr : &*rows;
}

McpListFailure failure (McpListFailureKind kind, std::size_t pages_sent) {
    return McpListFailure{ .kind = kind, .pages_sent = pages_sent, .send = McpPageFailure{} };
}

} // namespace

std::optional<std::string> mcp_next_cursor (const ordered_json& page) {
    if (!page.is_object ()) {
        return std::nullopt;
    }
    const auto next = page.find ("nextCursor");
    if (next == page.end ()) {
        return std::nullopt;
    }
    // get_ptr rather than is_string + get: GCC's -Wnull-dereference at -O3
    // reads the inlined from_json conversion as a possible null dereference.
    const auto* text = next->get_ptr<const std::string*> ();
    if (text == nullptr || text->empty ()) {
        return std::nullopt;
    }
    return *text;
}

std::expected<McpListPages, McpListFailure> collect_mcp_list_pages (const McpPageSender& send,
const char* key,
std::size_t max_pages,
std::size_t& items_used,
std::size_t max_items) {
    McpListPages list;
    std::optional<std::string> cursor;
    std::set<std::string> sent_cursors;
    while (list.pages_sent < max_pages) {
        if (cursor) {
            sent_cursors.insert (*cursor);
        }
        auto page = send (cursor);
        ++list.pages_sent;
        if (!page) {
            auto failed = failure (McpListFailureKind::SendFailed, list.pages_sent);
            failed.send = std::move (page.error ());
            return std::unexpected (std::move (failed));
        }
        ordered_json* rows = page_rows (*page, key);
        if (rows == nullptr) {
            return std::unexpected (
            failure (McpListFailureKind::MissingList, list.pages_sent));
        }
        items_used += rows->size ();
        if (items_used > max_items) {
            return std::unexpected (
            failure (McpListFailureKind::ItemsOverBudget, list.pages_sent));
        }
        for (auto& entry : *rows) {
            list.rows.push_back (std::move (entry));
        }
        cursor = mcp_next_cursor (*page);
        if (!cursor) {
            return list;
        }
        if (sent_cursors.contains (*cursor)) {
            return std::unexpected (
            failure (McpListFailureKind::RepeatedCursor, list.pages_sent));
        }
    }
    return std::unexpected (failure (McpListFailureKind::PageCapReached, list.pages_sent));
}

} // namespace vayu::core
