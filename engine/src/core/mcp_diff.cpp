/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/mcp_diff.cpp
 * @brief The re-import comparison of an MCP server (#3842). See
 *        `vayu/core/mcp_diff.hpp`.
 */

#include "vayu/core/mcp_diff.hpp"

#include <algorithm>
#include <cstddef>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/utils/ordered_json.hpp"

namespace vayu::core {

namespace {

using EntryKey = std::pair<McpEntryKind, std::string>;

/// @p object's member @p key when it is a string, else empty.
std::string string_member (const nlohmann::ordered_json& object, const char* key) {
    const auto found = object.find (key);
    if (found == object.end () || !found->is_string ()) {
        return {};
    }
    return found->get<std::string> ();
}

/// @p object's member @p key when it is an object, else null.
nlohmann::json object_member (const nlohmann::json& object, const char* key) {
    const auto found = object.find (key);
    return found != object.end () && found->is_object () ? *found : nlohmann::json ();
}

/// The `mcpTool.name` @p body stores, else empty.
std::string stored_tool_name (const nlohmann::json& body) {
    const nlohmann::json tool = object_member (body, "mcpTool");
    const auto name           = tool.find ("name");
    return name != tool.end () && name->is_string () ? name->get<std::string> () :
                                                       std::string ();
}

/// The kind a call's @p method reads, and the `params` member naming it.
std::optional<std::pair<McpEntryKind, const char*>> kind_of (std::string_view method) {
    if (method == "tools/call") {
        return std::make_pair (McpEntryKind::Tool, "name");
    }
    if (method == "prompts/get") {
        return std::make_pair (McpEntryKind::Prompt, "name");
    }
    if (method == "resources/read") {
        return std::make_pair (McpEntryKind::Resource, "uri");
    }
    return std::nullopt;
}

std::vector<McpField> differing_fields (const McpEntry& stored, const McpEntry& fetched) {
    std::vector<McpField> fields;
    if (stored.description != fetched.description) {
        fields.push_back (McpField::Description);
    }
    if (stored.input_schema != fetched.input_schema) {
        fields.push_back (McpField::InputSchema);
    }
    if (stored.output_schema != fetched.output_schema) {
        fields.push_back (McpField::OutputSchema);
    }
    return fields;
}

/// The tools among @p indices of @p entries that carry an `inputSchema`,
/// grouped by it. `dump` of an unordered `json` is canonical, so equal
/// schemas share a group.
std::map<std::string, std::vector<std::size_t>> tools_by_schema (
const std::vector<McpEntry>& entries,
const std::vector<std::size_t>& indices) {
    std::map<std::string, std::vector<std::size_t>> groups;
    for (const std::size_t index : indices) {
        const McpEntry& entry = entries.at (index);
        if (entry.kind == McpEntryKind::Tool && !entry.input_schema.is_null ()) {
            groups[entry.input_schema.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace)]
            .push_back (index);
        }
    }
    return groups;
}

/// Moves each unambiguous rename out of `added` and `removed` into `changed`:
/// an added and a removed tool that are each the only one on their side with
/// that `inputSchema`.
void pair_renames (const std::vector<McpEntry>& fetched,
const std::vector<McpEntry>& stored,
McpDiff& diff) {
    const auto added   = tools_by_schema (fetched, diff.added);
    const auto removed = tools_by_schema (stored, diff.removed);
    std::set<std::size_t> renamed_added;
    std::set<std::size_t> renamed_removed;
    for (const auto& [schema, added_tools] : added) {
        const auto removed_tools = removed.find (schema);
        if (added_tools.size () != 1 || removed_tools == removed.end () ||
        removed_tools->second.size () != 1) {
            continue;
        }
        const std::size_t to   = added_tools.front ();
        const std::size_t from = removed_tools->second.front ();
        diff.changed.push_back (mcp_rename_change (stored, from, fetched, to));
        renamed_added.insert (to);
        renamed_removed.insert (from);
    }
    std::erase_if (
    diff.added, [&] (std::size_t at) { return renamed_added.contains (at); });
    std::erase_if (diff.removed,
    [&] (std::size_t at) { return renamed_removed.contains (at); });
}

} // namespace

std::string_view mcp_entry_kind_name (McpEntryKind kind) {
    switch (kind) {
    case McpEntryKind::Tool: return "tool";
    case McpEntryKind::Resource: return "resource";
    case McpEntryKind::Prompt: return "prompt";
    }
    return "tool";
}

std::string_view mcp_field_name (McpField field) {
    switch (field) {
    case McpField::Description: return "description";
    case McpField::InputSchema: return "inputSchema";
    case McpField::OutputSchema: return "outputSchema";
    }
    return "description";
}

bool McpKinds::contains (McpEntryKind kind) const {
    switch (kind) {
    case McpEntryKind::Tool: return tools;
    case McpEntryKind::Resource: return resources;
    case McpEntryKind::Prompt: return prompts;
    }
    return false;
}

bool McpDiff::identical () const {
    return added.empty () && removed.empty () && changed.empty ();
}

McpChange mcp_rename_change (const std::vector<McpEntry>& stored,
std::size_t stored_index,
const std::vector<McpEntry>& fetched,
std::size_t fetched_index) {
    return McpChange{ .stored = stored_index,
        .fetched              = fetched_index,
        .fields = differing_fields (stored.at (stored_index), fetched.at (fetched_index)),
        .renamed = true };
}

std::optional<McpEntry>
mcp_entry_of (std::string name, std::string description, const nlohmann::json& body) {
    if (!body.is_object () || body.value ("mode", "") != "mcp") {
        return std::nullopt;
    }
    const auto content = body.find ("content");
    if (content == body.end () || !content->is_string ()) {
        return std::nullopt;
    }
    const auto call = vayu::utils::parse_ordered_json (
    content->get_ref<const std::string&> (), constants::request_body::MAX_JSON_DEPTH);
    if (!call || !call->is_object ()) {
        return std::nullopt;
    }
    const auto kind   = kind_of (string_member (*call, "method"));
    const auto params = call->find ("params");
    if (!kind || params == call->end () || !params->is_object ()) {
        return std::nullopt;
    }
    std::string key = kind->first == McpEntryKind::Tool ? stored_tool_name (body) : "";
    if (key.empty ()) {
        key = string_member (*params, kind->second);
    }
    if (key.empty ()) {
        return std::nullopt;
    }
    const nlohmann::json tool = object_member (body, "mcpTool");
    return McpEntry{ .kind = kind->first,
        .key               = std::move (key),
        .name              = std::move (name),
        .description       = std::move (description),
        .input_schema      = object_member (tool, "inputSchema"),
        .output_schema     = object_member (tool, "outputSchema") };
}

McpListingEntries mcp_listing_entries (const McpServerListing& listing) {
    McpListingEntries out;
    out.kinds = McpKinds{ .tools = listing.tools.has_value (),
        .resources               = listing.resources.has_value (),
        .prompts                 = listing.prompts.has_value () };
    const nlohmann::ordered_json tree = mcp_import_result (listing);
    const auto& root                  = tree.at ("collections").at (0);
    const auto read_drafts = [&out] (const nlohmann::ordered_json& drafts) {
        for (const auto& draft : drafts) {
            // A copy: `ordered_json` to `json` is a conversion.
            auto entry = mcp_entry_of (draft.value ("name", ""),
            draft.value ("description", ""), nlohmann::json (draft.at ("body")));
            if (entry) {
                out.entries.push_back (std::move (*entry));
            }
        }
    };
    read_drafts (root.at ("requests"));
    for (const auto& folder : root.at ("children")) {
        read_drafts (folder.at ("requests"));
    }
    return out;
}

McpDiff diff_mcp (const std::vector<McpEntry>& fetched,
const McpKinds& kinds,
const std::vector<McpEntry>& stored) {
    std::map<EntryKey, std::size_t> listed;
    for (std::size_t at = 0; at < fetched.size (); ++at) {
        listed.try_emplace (EntryKey{ fetched[at].kind, fetched[at].key }, at);
    }
    McpDiff diff;
    std::set<std::size_t> claimed;
    for (std::size_t at = 0; at < stored.size (); ++at) {
        const McpEntry& entry = stored[at];
        if (!kinds.contains (entry.kind)) {
            continue;
        }
        const auto match = listed.find (EntryKey{ entry.kind, entry.key });
        if (match == listed.end ()) {
            diff.removed.push_back (at);
            continue;
        }
        claimed.insert (match->second);
        auto fields = differing_fields (entry, fetched[match->second]);
        if (!fields.empty ()) {
            diff.changed.push_back (McpChange{
            .stored = at, .fetched = match->second, .fields = std::move (fields), .renamed = false });
        }
    }
    for (const auto& [key, at] : listed) {
        if (!claimed.contains (at)) {
            diff.added.push_back (at);
        }
    }
    std::ranges::sort (diff.added);
    pair_renames (fetched, stored, diff);
    std::ranges::sort (diff.changed, {}, &McpChange::stored);
    return diff;
}

} // namespace vayu::core
