/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/loopback_guard.cpp
 * @brief Which outbound targets are Vayu's own ports (issue #2355), and
 *        which local peers a reference fetch may reach (issue #2364).
 */

#include "vayu/http/loopback_guard.hpp"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <stdexcept>
#include <utility>

#include "vayu/core/constants.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/url_parts.hpp"

namespace vayu::http {

namespace {

constexpr int MIN_PORT = 1;
constexpr int MAX_PORT = 65535;

/// 0 until `set_engine_port` runs; no valid port is 0, so it means "unset".
std::atomic<int>& engine_port_slot () noexcept {
    static std::atomic<int> slot{ 0 };
    return slot;
}

/// A canonical dotted quad: four runs of digits. A domain such as
/// `127.example` is not one, whatever its first label says.
bool is_dotted_quad (std::string_view host) {
    return std::count (host.begin (), host.end (), '.') == 3 &&
    std::all_of (host.begin (), host.end (),
    [] (unsigned char c) { return std::isdigit (c) != 0 || c == '.'; });
}

/// The high group of `[::ffff:HHHH:LLLL]`, the IPv4-mapped form the
/// serialiser writes, or nullopt for any other host. The serialiser writes
/// lower-case hex without leading zeros, so the high group of `127.0.0.0/8`
/// is always four digits from `7f` and that of `169.254.0.0/16` is `a9fe`.
std::optional<std::string_view> mapped_ipv4_high_group (std::string_view host) {
    constexpr std::string_view MAPPED = "[::ffff:";
    if (!host.starts_with (MAPPED) || !host.ends_with (']')) {
        return std::nullopt;
    }
    const std::string_view groups =
    host.substr (MAPPED.size (), host.size () - MAPPED.size () - 1);
    const size_t colon = groups.find (':');
    if (colon == std::string_view::npos ||
    groups.find (':', colon + 1) != std::string_view::npos) {
        return std::nullopt;
    }
    return groups.substr (0, colon);
}

/// An IPv4-mapped host carrying a loopback or unspecified IPv4 address.
bool is_local_mapped_ipv6 (std::string_view host) {
    if (host == "[::ffff:0:0]") {
        return true; // ::ffff:0.0.0.0
    }
    const auto high = mapped_ipv4_high_group (host);
    return high && high->size () == 4 && high->starts_with ("7f");
}

/// Whether a canonical host (see `canonical_host`) dials this machine.
bool is_local_host (std::string_view host) {
    if (host.ends_with ('.')) {
        host.remove_suffix (1); // `localhost.` is the same name, rooted
    }
    if (host == "localhost") {
        return true;
    }
    if (is_dotted_quad (host)) {
        return host.starts_with ("127.") || host == "0.0.0.0";
    }
    return host == "[::1]" || host == "[::]" || is_local_mapped_ipv6 (host);
}

/// Whether a canonical host is link-local: `169.254.0.0/16`, its IPv4-mapped
/// form, or `fe80::/10`, whose first group the serialiser writes as four
/// digits from `fe80` to `febf`.
bool is_link_local_host (std::string_view host) {
    if (is_dotted_quad (host)) {
        return host.starts_with ("169.254.");
    }
    if (const auto high = mapped_ipv4_high_group (host)) {
        return *high == "a9fe";
    }
    const size_t colon = host.find (':');
    if (!host.starts_with ('[') || colon == std::string_view::npos) {
        return false;
    }
    const std::string_view first = host.substr (1, colon - 1);
    return first.size () == 4 && first.starts_with ("fe") &&
    std::string_view ("89ab").find (first.at (2)) != std::string_view::npos;
}

/// A source host that names this machine: what `is_local_host` reads, plus
/// any `*.localhost` name, which libcurl resolves to loopback itself.
bool is_loopback_source (std::string_view host) {
    if (host.ends_with ('.')) {
        host.remove_suffix (1);
    }
    return is_local_host (host) || host.ends_with (".localhost");
}

/// Whether @p rule's source is the peer at @p peer (canonical) on its port.
bool is_source_peer (std::string_view peer, int peer_port, const LocalPeerRule& rule) {
    if (rule.source_host.empty () || rule.source_port != peer_port) {
        return false;
    }
    const auto source = canonical_host (rule.source_host);
    if (!source) {
        return false;
    }
    return *source == peer || (is_local_host (peer) && is_loopback_source (*source));
}

} // namespace

void set_engine_port (int port) {
    if (port < MIN_PORT || port > MAX_PORT) {
        throw std::invalid_argument ("engine port " + std::to_string (port) +
        " is outside " + std::to_string (MIN_PORT) + ".." + std::to_string (MAX_PORT));
    }
    int registered = 0;
    if (engine_port_slot ().compare_exchange_strong (registered, port) || registered == port) {
        return;
    }
    throw std::logic_error ("the engine port is already registered as " +
    std::to_string (registered) + "; refusing to replace it with " + std::to_string (port));
}

std::optional<int> registered_engine_port () noexcept {
    const int port = engine_port_slot ().load ();
    return port == 0 ? std::nullopt : std::optional<int> (port);
}

bool detail::is_reserved_loopback_target (std::string_view host_or_ip,
int port,
std::optional<int> engine_port) {
    const bool reserved_port =
    port == vayu::core::constants::defaults::MCP_PORT || engine_port == port;
    if (!reserved_port) {
        return false;
    }
    const auto canonical = canonical_host (host_or_ip);
    return canonical && is_local_host (*canonical);
}

bool is_reserved_loopback_target (std::string_view host_or_ip, int port) {
    return detail::is_reserved_loopback_target (host_or_ip, port, registered_engine_port ());
}

std::optional<int> reserved_target_port (const std::string& url) {
    const detail::UrlAuthority authority = detail::parse_authority (url);
    if (authority.host.empty () ||
    !is_reserved_loopback_target (authority.host, authority.port)) {
        return std::nullopt;
    }
    return authority.port;
}

std::string reserved_target_refusal (int port) {
    const char* role = registered_engine_port () == port ? "engine" : "MCP";
    return "Vayu does not send requests to its own " + std::string (role) +
    " port " + std::to_string (port) +
    " on this machine - not when the URL names it, a redirect leads there or "
    "a host name resolves there";
}

std::optional<LocalPeerRule> local_peer_rule_for_source (const std::string& source_url) {
    detail::UrlAuthority authority = detail::parse_authority (source_url);
    if (authority.host.empty ()) {
        return std::nullopt;
    }
    return LocalPeerRule{ std::move (authority.host), authority.port };
}

bool is_refused_local_peer (std::string_view peer_ip, int peer_port, const LocalPeerRule& rule) {
    const auto peer = canonical_host (peer_ip);
    if (!peer) {
        return true;
    }
    if (!is_local_host (*peer) && !is_link_local_host (*peer)) {
        return false;
    }
    return !is_source_peer (*peer, peer_port, rule);
}

std::string local_peer_refusal () {
    return "Vayu does not fetch a reference from a loopback or link-local "
           "address other than its source document's own host and port - not "
           "when the URL names one and not when a host name resolves to one";
}

} // namespace vayu::http
