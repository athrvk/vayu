#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/loopback_guard.hpp
 * @brief The one rule that keeps an outbound transfer off Vayu's own ports
 *        (issue #2355).
 *
 * The engine's management API admits any request with a loopback `Host` and
 * no `Origin`, which is exactly what libcurl sends. So a request the engine
 * itself sends - a script's `pm.sendRequest`, a request in an imported
 * collection, a redirect a server answers with - must never land on the
 * engine's own port or the MCP server's, or a document the user only imported
 * can read stored secrets and write through the API.
 *
 * Only those ports, never the rest of loopback: testing a local server is an
 * everyday use. Every driver applies the rule twice, through
 * `detail::validate_transferable` (the URL the handle is given, `wire_url`,
 * refused before anything is dialled) and through `detail::apply_transport_policy`'s
 * pre-request callback (the address libcurl actually connected to, which is
 * what catches a redirect and a name that resolves to loopback). With a proxy
 * in force the connected peer is the proxy, so only the first check sees the
 * origin; where a user's proxy forwards to is the user's choice.
 */

#include <optional>
#include <string>
#include <string_view>

namespace vayu::http {

/**
 * @brief Record the port this engine serves its API on. Set once per process.
 *
 * The daemon calls it with the port it is about to bind, before the listener
 * starts, so no request is served while the registry is empty; a port that
 * cannot be bound ends the process, so the requested port is the bound one.
 * Repeating the same port is a no-op.
 *
 * @throws std::invalid_argument for a port outside 1..65535.
 * @throws std::logic_error when a different port is already registered: two
 *         engine ports in one process is a wiring mistake, and silently
 *         keeping either would leave the other unguarded.
 */
void set_engine_port (int port);

/// The port `set_engine_port` recorded, or nullopt before it has run - an
/// in-process `Server` in a test, or `vayu-cli`, which serves nothing.
std::optional<int> registered_engine_port () noexcept;

/**
 * @brief Whether a transfer to @p host_or_ip on @p port would reach Vayu
 *        itself.
 *
 * True when @p port is the registered engine port or `MCP_PORT` and the host
 * is this machine: all of `127.0.0.0/8`, `::1`, the IPv4-mapped
 * `::ffff:127.0.0.0/8`, the unspecified `0.0.0.0` and `::` (which connect to
 * the local host on Linux and macOS), and `localhost` in any case, with or
 * without a trailing dot. Brackets around an IPv6 literal are accepted.
 * Address spellings are read the way a URL parser reads them, so `127.1` and
 * `0x7f.0.0.1` are `127.0.0.1` here as they are to libcurl.
 *
 * The port is compared first, so a transfer to any other port pays one
 * integer comparison and no parse.
 */
bool is_reserved_loopback_target (std::string_view host_or_ip, int port);

/// The reserved port @p url names on a loopback host, or nullopt. The literal
/// check every driver and `pm.sendRequest` run before dialling, on the URL the
/// transfer is handed (`wire_url`, or the encoded URL `pm.sendRequest` sends).
std::optional<int> reserved_target_port (const std::string& url);

/// The sentence a refused transfer reports, naming which of Vayu's ports
/// @p port is. One sentence for the literal and the connected-address
/// refusal, so the three drivers report a refused target alike.
std::string reserved_target_refusal (int port);

namespace detail {

/// `is_reserved_loopback_target` with the engine port passed in rather than
/// read from the process-wide registry, so a test can state both the unset
/// and the set case without sharing state with the rest of the suite.
bool is_reserved_loopback_target (std::string_view host_or_ip,
int port,
std::optional<int> engine_port);

} // namespace detail

} // namespace vayu::http
