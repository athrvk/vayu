#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <nlohmann/json_fwd.hpp>

#include <expected>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/types.hpp"

/**
 * @brief An MCP request over Streamable HTTP, modern era (#3762): the body's
 *        `_meta` and the headers the transport mirrors out of the body.
 *
 * An `mcp` body is a JSON-RPC call (`jsonrpc_body.hpp`) that the specification
 * pinned below asks two more things of: request metadata in `params._meta`, and
 * a set of headers (`Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`, ...) that repeat
 * what the body says, so a gateway can route without parsing it. A server
 * refuses a request whose headers disagree with its body (`400`, JSON-RPC code
 * `-32020`), so keeping the two in step by hand is the work this mode removes.
 *
 * Engine-side for the reason `jsonrpc_body.hpp` gives: every client (the
 * renderer, MCP `run_request`, a raw `POST /execute`, the load driver, the CLI)
 * sends through here, and a copy in one of them is a copy the others lack. The
 * headers are derived from the *resolved* wire body, in
 * `build_request_header_list`, under the same rules as the body-implied
 * `Content-Type`: a header the request carries wins, and a name in
 * `disabledSystemHeaders` is not added.
 *
 * Only the modern era is spoken. A legacy server (an `initialize` handshake and
 * a session id) is reached through explicit steps, never hidden session state.
 */

namespace vayu::http {

/// The specification revision this mode speaks, and the names it defines.
/// Read from https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md
namespace mcp {
inline constexpr std::string_view PROTOCOL_VERSION = "2026-07-28";
inline constexpr std::string_view CLIENT_NAME      = "vayu";

inline constexpr std::string_view META_PROTOCOL_VERSION =
"io.modelcontextprotocol/protocolVersion";
inline constexpr std::string_view META_CLIENT_INFO =
"io.modelcontextprotocol/clientInfo";
inline constexpr std::string_view META_CLIENT_CAPABILITIES =
"io.modelcontextprotocol/clientCapabilities";

inline constexpr std::string_view ACCEPT_HEADER = "Accept";
inline constexpr std::string_view ACCEPT_VALUE =
"application/json, text/event-stream";
inline constexpr std::string_view PROTOCOL_VERSION_HEADER =
"MCP-Protocol-Version";
inline constexpr std::string_view METHOD_HEADER       = "Mcp-Method";
inline constexpr std::string_view NAME_HEADER         = "Mcp-Name";
inline constexpr std::string_view PARAM_HEADER_PREFIX = "Mcp-Param-";

/// The x-mcp-header annotation's key in a property's schema.
inline constexpr std::string_view HEADER_ANNOTATION = "x-mcp-header";
} // namespace mcp

/**
 * @brief An `mcp` body's `content` as the bytes that go on the wire.
 *
 * `jsonrpc_wire_body`'s rules, unchanged: a caller-written envelope (a string
 * `"jsonrpc"` member), JSON that is not an object, text that does not parse
 * (an unresolved `{{token}}`), a call nested past
 * `constants::request_body::MAX_JSON_DEPTH` and an empty body all pass through
 * byte for byte, and a bare call gains `"jsonrpc":"2.0"` and the constant
 * `"id":1`. A full envelope is the caller's frame, `_meta` and all, so nothing
 * is stamped into it.
 *
 * A bare call additionally gains `params._meta` (`params` is created when
 * absent or null): the protocol version, `clientInfo` `{name: "vayu", version:
 * <engine version>}` and empty `clientCapabilities`. A call whose `params`
 * already carries `_meta`, or is not an object, is left as written there.
 */
[[nodiscard]] std::string mcp_wire_body (const std::string& content);

/**
 * @brief The headers an MCP POST carrying @p wire_body must send, in send
 *        order. Pure, so the derivation is testable without a socket.
 *
 * - `Accept: application/json, text/event-stream`, always.
 * - `MCP-Protocol-Version`: the body's `params._meta` protocol version when it
 *   names one as a string, else the pinned revision; a server rejects a header
 *   that disagrees with the body.
 * - `Mcp-Method`: the call's `method`.
 * - `Mcp-Name`: `params.name` for `tools/call` and `prompts/get`,
 *   `params.uri` for `resources/read`.
 * - `Mcp-Param-<Name>`: for a `tools/call` of the tool @p tool describes
 *   (`params.name` equal to its name), each annotated argument present in
 *   `params.arguments` as a string, a number or a boolean. A `null`, absent,
 *   object or array argument sends no header.
 *
 * `Mcp-Name` and `Mcp-Param-*` values outside plain printable ASCII take the
 * Base64 sentinel form (`mcp_header_value`). `MCP-Protocol-Version` and
 * `Mcp-Method` have no such form, so a value that cannot be a header line is
 * left out and the server names what is missing. A body that is not one JSON
 * object (text that does not parse, an array, a call past the depth bound)
 * derives only the first two.
 */
[[nodiscard]] std::vector<HeaderLine>
mcp_derived_headers (std::string_view wire_body, const std::optional<McpTool>& tool);

/**
 * @brief @p value as an `Mcp-Name` or `Mcp-Param-*` header value: as written
 *        when it is non-empty printable ASCII (0x20-0x7E) with no leading or
 *        trailing space, else `=?base64?<Base64 of the UTF-8 bytes>?=`.
 *
 * A plain value that already looks like the sentinel (`=?base64?...?=`) is
 * encoded too, so a server never decodes a literal. An empty value is encoded
 * as `=?base64??=`, because an empty header line is a removal to libcurl.
 */
[[nodiscard]] std::string mcp_header_value (std::string_view value);

/**
 * @brief An `mcp` step's label in a scenario load run's breakdown (#3829):
 *        `<method> <name>`, e.g. `tools/call search`, the name being
 *        `params.name` of a `tools/call` or `prompts/get`.
 *
 * @p content is the *stored* body text, never the composed one, so no
 * substituted value (a secret's included) can reach the label. The method
 * alone for every other method (`resources/read`'s `uri` names no tool and can
 * carry a credential) and for a name that is absent, empty, not a string or
 * holds `{{`. Empty when @p content is not one JSON object within
 * `constants::request_body::MAX_JSON_DEPTH`, or has no non-empty string
 * `method` free of `{{`.
 */
[[nodiscard]] std::string mcp_step_label (std::string_view content);

/**
 * @brief A stored `mcpTool` object (`{name, inputSchema?}`) as what a send
 *        reads of it, or why it cannot be one. An `outputSchema` member stays
 *        in the blob and is not read here.
 *
 * `name` is a non-empty string and `inputSchema`, when present, an object.
 * Every `x-mcp-header` reached through a chain of `properties` keys is a
 * header-name token, unique without regard to case; it is what the
 * specification requires of an annotation for the header to be writable at
 * all. The rest of a tool definition's validity (an annotation outside such a
 * chain, a non-primitive type) is the listing's question, not the send's.
 */
[[nodiscard]] std::expected<McpTool, std::string> read_mcp_tool (const nlohmann::json& value);

} // namespace vayu::http
