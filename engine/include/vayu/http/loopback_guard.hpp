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
 *
 * A fetch made on a document's behalf (a `$ref`, #2364) runs a wider rule on
 * the same callback: `LocalPeerRule` refuses every loopback and link-local
 * peer that is not the source document's own host and port. The proxy the
 * transfer names is not refused (#2605); its URL is judged instead, before
 * anything is dialled (`is_refused_reference_url`).
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

/**
 * @brief The connect-time rule for a fetch a document asked for rather than a
 *        person (#2364): a `$ref` names its URL, so a hostile document could
 *        point it, by address, by name or by redirect, at a service on the
 *        user's machine or link-local network.
 *
 * Refuses a peer on loopback (`is_reserved_loopback_target`'s spellings, at
 * any port) or link-local (`169.254.0.0/16`, `fe80::/10`, and the IPv4-mapped
 * `::ffff:169.254.0.0/16`), unless it is the source's own: the peer's port is
 * @ref source_port, and either the source host is itself a loopback name or
 * address (`localhost`, `*.localhost` included) and the peer is loopback, or
 * the source host is the peer's address written as a literal. A source host
 * that is a name resolving to loopback earns nothing; it is what a rebinding
 * DNS answer looks like.
 */
struct LocalPeerRule {
    /// The source document's host as its URL names it (brackets removed from
    /// an IPv6 literal). Empty when the caller named no source, which refuses
    /// every loopback and link-local peer.
    std::string source_host;
    /// The source URL's port, the scheme default when it names none; 0 with no
    /// source, which no peer has.
    int source_port = 0;
};

/// The rule for a reference found in the document at @p source_url, or
/// nullopt when that URL names no host.
std::optional<LocalPeerRule> local_peer_rule_for_source (const std::string& source_url);

/// Whether @p rule refuses a connection to @p peer_ip on @p peer_port. An
/// address that cannot be read as one is refused: the rule fails closed.
bool is_refused_local_peer (std::string_view peer_ip, int peer_port, const LocalPeerRule& rule);

/// Whether a connection to @p peer_ip on @p peer_port reached what a URL
/// naming @p host on @p port names, by the rule `LocalPeerRule` matches its
/// source with: the same address, or loopback for a loopback name or address.
/// How the reference rule recognises the proxy a transfer was configured with
/// (#2605), which it does not refuse.
bool is_peer_named_by (std::string_view peer_ip, int peer_port, std::string_view host, int port);

/**
 * @brief Whether @p rule refuses @p url by its text alone (#2605): its host
 *        names a loopback or link-local address, `localhost` or a
 *        `*.localhost` name, and is not the source's host and port.
 *
 * The pre-connect half of the rule, for a fetch sent through a proxy: the
 * connected peer is then the proxy, so only the URL says where the fetch goes.
 * A host name that only resolves to such an address is not seen here; behind
 * a proxy, that is the proxy's to resolve.
 */
bool is_refused_reference_url (const std::string& url, const LocalPeerRule& rule);

/// The sentence a peer `LocalPeerRule` refused reports, for every driver.
std::string local_peer_refusal ();

namespace detail {

/// `is_reserved_loopback_target` with the engine port passed in rather than
/// read from the process-wide registry, so a test can state both the unset
/// and the set case without sharing state with the rest of the suite.
bool is_reserved_loopback_target (std::string_view host_or_ip,
int port,
std::optional<int> engine_port);

} // namespace detail

} // namespace vayu::http
