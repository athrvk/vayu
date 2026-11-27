#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/mcp_import.hpp
 * @brief What a live MCP server lists, as the `ImportResult` `POST /import/parse`
 *        answers (#3838), so `POST /import/apply` and the import preview read
 *        it unchanged.
 *
 * The network half (discovery, the list methods and their cursors) is
 * `POST /import/mcp`'s, in `http/routes/import_mcp.cpp`; this half reads no
 * socket, so the tree's shape is one function of what the server said.
 *
 * The tree is one collection named after the server, with a folder per
 * included primitive: `Tools` (a `tools/call` per tool), `Resources` (a
 * `resources/read` per resource and per resource template) and `Prompts` (a
 * `prompts/get` per prompt). For a modern-era server every request is an `mcp`
 * body holding a bare call, so the engine stamps the envelope, `_meta` and the
 * derived headers at send exactly as it does for a request a person wrote.
 *
 * A tool's request carries what a person's would: `mcpTool` (`{name,
 * inputSchema}`, so the `x-mcp-header` mirrors are derived at send) and
 * `arguments` sampled from the `inputSchema` (`SchemaSampler`): the required
 * properties only, each as the schema states it (`const`, `default`, an enum's
 * first member) and otherwise a typed stub. Stubs, never `{{variables}}`, so
 * the generated collection runs as it stands. Every request expects a `200`
 * (`assert.status`); the MCP reply's own failure classes need no element.
 * Every request's `url` is `{{mcpBaseUrl}}`, a root collection variable holding
 * the endpoint.
 *
 * **No credential reaches the tree.** A bearer token the import was sent with
 * becomes the collection's `bearer` auth over `{{mcpToken}}`, a secret
 * collection variable left empty for the user to fill; each request inherits
 * it. A caller header whose name is a credential's (`is_secret_header_name`)
 * is carried blank and disabled, so the request says which header the server
 * wanted without holding its value or sending an empty one.
 *
 * **A legacy-era server gets its handshake as requests** (#3840), never as
 * session state the engine keeps: the root's own requests are `initialize`
 * first and `notifications/initialized` second, the folders follow, and a
 * closing `DELETE` ends the root, each draft's `order` stating that place so the
 * sidebar and a run read the same sequence. Every call is a full JSON-RPC
 * envelope, numbered in run order, so nothing modern is stamped into it, and
 * carries the negotiated `MCP-Protocol-Version` as a header row. When the
 * server issued an `Mcp-Session-Id`, `initialize` extracts it into
 * `{{mcpSessionId}}` (`extract.header`), every later request sends it, and the
 * `DELETE` closes it; a stateless server's tree has neither the extract nor the
 * `DELETE`, because there is no session to carry or end. The notification
 * expects the `202` the specification answers one with, and the `DELETE` any
 * of `200`, `202`, `204` or `405`: a server that does not let a client end a
 * session answers `405`, which the specification allows.
 */

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/types.hpp"

namespace vayu::core {

/// The collection variable a bearer-authenticated import's auth reads.
inline constexpr std::string_view MCP_TOKEN_VARIABLE = "mcpToken";

/// The collection variable holding the server's endpoint, every request's `url`.
inline constexpr std::string_view MCP_BASE_URL_VARIABLE = "mcpBaseUrl";

/// `meta.format` of an MCP import.
inline constexpr std::string_view MCP_IMPORT_FORMAT = "MCP server";

/// The revision `initialize` offers a legacy-era server: the newest one that
/// has the handshake. The server answers the one it speaks.
inline constexpr std::string_view MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";

/// The header a legacy-era server names its session in, on `initialize`'s
/// reply and on every request after it.
inline constexpr std::string_view MCP_SESSION_HEADER = "Mcp-Session-Id";

/// The collection variable a legacy session's `initialize` extracts its
/// `MCP_SESSION_HEADER` into; undefined until that request has run.
inline constexpr std::string_view MCP_SESSION_VARIABLE = "mcpSessionId";

/// `initialize`'s `params`: `MCP_LEGACY_PROTOCOL_VERSION`, no client
/// capabilities, and `clientInfo` `{name: "vayu", version: <engine version>}`.
/// The import's own handshake and the request it generates send the same.
[[nodiscard]] nlohmann::ordered_json mcp_initialize_params ();

/// What a legacy-era server's handshake settled, which every generated
/// request after `initialize` carries.
struct McpLegacyHandshake {
    /// The revision `initialize` answered, each later request's
    /// `MCP-Protocol-Version`.
    std::string protocol_version;
    /// `initialize` issued an `MCP_SESSION_HEADER`.
    bool session = false;
};

/**
 * @brief What the import read from the server. A primitive the caller did not
 *        include is `std::nullopt`, and gets no folder; an included one that
 *        listed nothing gets an empty folder.
 */
struct McpServerListing {
    /// The server's endpoint, the value of the root's `mcpBaseUrl` variable.
    std::string url;
    /// The root collection's name: `serverInfo.name` (from `server/discover`,
    /// or a legacy server's `initialize`), else the URL's host.
    std::string name;
    /// Set when the server is legacy-era: the tree opens with its handshake.
    std::optional<McpLegacyHandshake> legacy;
    /// The headers the caller sent the import with, in order.
    std::vector<HeaderLine> headers;
    /// The import was sent with a bearer token.
    bool bearer = false;
    /// The `tools/list` entries, every page.
    std::optional<nlohmann::ordered_json> tools;
    /// The `resources/list` entries.
    std::optional<nlohmann::ordered_json> resources;
    /// The `resources/templates/list` entries; nothing when the server does
    /// not answer the method, though it lists resources.
    std::optional<nlohmann::ordered_json> resource_templates;
    /// The `prompts/list` entries.
    std::optional<nlohmann::ordered_json> prompts;
};

/**
 * @brief @p listing as an `ImportResult`: `{collections, environments,
 *        globals, meta}`, `meta.format` `MCP_IMPORT_FORMAT`.
 *
 * An entry with no usable identity (a tool or prompt without a non-empty
 * string `name`, a resource without a `uri`, a template without a
 * `uriTemplate`) is skipped and counted under `meta.skipped` as
 * `malformed_item`. A tool whose `inputSchema` `read_mcp_tool` refuses (an
 * `x-mcp-header` that is not a usable header name) keeps its request and its
 * sampled arguments but no `mcpTool`, and is counted as `unusable_tool_schema`
 * naming the tool: apply refuses the whole tree over one such body. A request
 * is named by the entry's `name` (a resource or template without one by its
 * URI) and described by its `description`.
 */
[[nodiscard]] nlohmann::ordered_json mcp_import_result (const McpServerListing& listing);

} // namespace vayu::core
