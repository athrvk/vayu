#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/mcp_diff.hpp
 * @brief What importing an MCP server again would change about a collection an
 *        earlier import of it built (#3842), so a renamed tool reads as a
 *        change rather than a second collection.
 *
 * **Identity is the entry's own, never its position.** A tool's request is the
 * tool its `mcpTool.name` names (else the `params.name` of its `tools/call`), a
 * prompt's the `params.name` of its `prompts/get`, a resource's the
 * `params.uri` of its `resources/read`, a template's included. The list a
 * server answers is in no promised order, so an index would pair a tool with
 * its neighbour's request the moment one is added above it. Any other request
 * (a legacy server's handshake, one a person added that is not an `mcp` call)
 * has no identity and is not compared.
 *
 * Both sides are read by one reader, `mcp_entry_of`: the stored request's body,
 * and the draft `mcp_import_result` would build from the listing now. A field
 * therefore differs only when the server's answer differs from what the
 * collection holds, never because two readers disagree.
 *
 * **A rename is inferred, and only where it is unambiguous.** A tool no
 * request claims and a stored tool the server no longer lists are one tool
 * renamed when each is the only one on its side with that `inputSchema`; any
 * other pairing is an add and a remove, stated as such.
 *
 * **Nothing here reads a socket or a row.** `POST /import/mcp/diff` fetches the
 * listing, finds the collections an import of the same URL built, and hands
 * both here.
 */

#include <nlohmann/json.hpp>

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/core/mcp_import.hpp"

namespace vayu::core {

/// Which of a server's lists an entry came from.
enum class McpEntryKind : std::uint8_t { Tool, Resource, Prompt };

/// The wire spelling of @p kind: `tool`, `resource` or `prompt`.
[[nodiscard]] std::string_view mcp_entry_kind_name (McpEntryKind kind);

/// The lists a listing read. A kind it did not read is not compared: a
/// collection whose `Resources` folder a tools-only import never asked about
/// has not lost its resources.
struct McpKinds {
    bool tools     = false;
    bool resources = false;
    bool prompts   = false;

    [[nodiscard]] bool contains (McpEntryKind kind) const;
};

/// One request as the comparison reads it.
struct McpEntry {
    McpEntryKind kind = McpEntryKind::Tool;
    /// The identity: a tool's or prompt's name, a resource's URI.
    std::string key;
    /// The request's name, for display.
    std::string name;
    std::string description;
    /// `mcpTool.inputSchema` / `mcpTool.outputSchema`, null when absent.
    /// Unordered `json`, so a stored body whose members were re-sorted on the
    /// way to the database compares equal to the listing's.
    nlohmann::json input_schema  = nullptr;
    nlohmann::json output_schema = nullptr;
};

/**
 * @brief The entry an `mcp` request body is, or nothing for a body that is
 *        not one call to a tool, prompt or resource.
 *
 * @p body is the stored body object (`{mode: "mcp", content, mcpTool?}`).
 * `content` is parsed within `constants::request_body::MAX_JSON_DEPTH`, and
 * read for `method` and `params` alone, so a bare call and a legacy envelope
 * read alike.
 */
[[nodiscard]] std::optional<McpEntry>
mcp_entry_of (std::string name, std::string description, const nlohmann::json& body);

/// The entries an import of a listing would build, and the lists it read.
struct McpListingEntries {
    std::vector<McpEntry> entries;
    McpKinds kinds;
};

/// @p listing's entries, read off `mcp_import_result`'s tree by
/// `mcp_entry_of`, in tree order.
[[nodiscard]] McpListingEntries mcp_listing_entries (const McpServerListing& listing);

/// A compared field, in display order.
enum class McpField : std::uint8_t { Description, InputSchema, OutputSchema };

/// The wire spelling of @p field: `description`, `inputSchema` or `outputSchema`.
[[nodiscard]] std::string_view mcp_field_name (McpField field);

/// A stored request whose entry the server still lists, and what moved.
struct McpChange {
    /// Index into the stored entries.
    std::size_t stored = 0;
    /// Index into the listing's entries.
    std::size_t fetched = 0;
    /// Every field that differs; empty for a rename that moved nothing else.
    std::vector<McpField> fields;
    /// The stored entry's key is not the listing's: the tool was renamed.
    bool renamed = false;
};

/// Indices into the two lists that were offered.
struct McpDiff {
    /// Listing entries no stored request claims, in listing order.
    std::vector<std::size_t> added;
    /// Stored entries of a compared kind the listing no longer has, in stored order.
    std::vector<std::size_t> removed;
    /// In stored order.
    std::vector<McpChange> changed;

    [[nodiscard]] bool identical () const;
};

/// The rename of `stored[stored_index]` to `fetched[fetched_index]`, with
/// every field the two differ in. The one builder of a rename, for a pair the
/// diff makes and for a pair a caller confirmed alike.
[[nodiscard]] McpChange mcp_rename_change (const std::vector<McpEntry>& stored,
std::size_t stored_index,
const std::vector<McpEntry>& fetched,
std::size_t fetched_index);

/**
 * @brief Compare a collection's requests against the listing a server answers
 *        now.
 *
 * Every stored request carrying a listed key is compared, so two requests for
 * one tool are both reported if both differ. A key the listing carries twice
 * is the first one's.
 *
 * @param fetched `mcp_listing_entries (...).entries`.
 * @param kinds   the lists the listing read; a stored entry of another kind
 *                is neither removed nor changed.
 * @param stored  every MCP request beneath the collection, as `mcp_entry_of`
 *                read them.
 */
[[nodiscard]] McpDiff diff_mcp (const std::vector<McpEntry>& fetched,
const McpKinds& kinds,
const std::vector<McpEntry>& stored);

} // namespace vayu::core
