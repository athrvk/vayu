/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/loopback_guard.cpp
 * @brief Which outbound targets are Vayu's own ports (issue #2355).
 */

#include "vayu/http/loopback_guard.hpp"

#include <ada.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <stdexcept>

#include "vayu/core/constants.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"

namespace vayu::http {

namespace {

constexpr int MIN_PORT = 1;
constexpr int MAX_PORT = 65535;

/// 0 until `set_engine_port` runs; no valid port is 0, so it means "unset".
std::atomic<int>& engine_port_slot () noexcept {
    static std::atomic<int> slot{ 0 };
    return slot;
}

/**
 * @p host as a URL parser serialises it, or nullopt when it is not a host.
 *
 * WHATWG's host parser (ada, already the engine's IDNA reader) rather than a
 * private one, because the spellings that matter here are the lenient ones:
 * `127.1`, `0x7f.0.0.1` and `2130706433` are all `127.0.0.1` to libcurl, and
 * an IPv6 literal has as many spellings as it has zero runs. The parser
 * folds each to one form: a dotted quad, a lower-cased name, or a bracketed,
 * compressed IPv6 address (`[::1]`, `[::ffff:7f00:1]`).
 */
std::optional<std::string> canonical_host (std::string_view host) {
    std::string text (host);
    if (text.find (':') != std::string::npos && !text.starts_with ('[')) {
        text = "[" + text + "]"; // the bracketless form `parse_authority` and libcurl report
    }
    auto url = ada::parse<ada::url> ("http://x");
    if (!url || !url->set_hostname (text)) {
        return std::nullopt;
    }
    return url->get_hostname ();
}

/// A canonical dotted quad: four runs of digits. A domain such as
/// `127.example` is not one, whatever its first label says.
bool is_dotted_quad (std::string_view host) {
    return std::count (host.begin (), host.end (), '.') == 3 &&
    std::all_of (host.begin (), host.end (),
    [] (unsigned char c) { return std::isdigit (c) != 0 || c == '.'; });
}

/// `[::ffff:HHHH:LLLL]`, the IPv4-mapped form the serialiser writes, carrying
/// a loopback or unspecified IPv4 address.
bool is_local_mapped_ipv6 (std::string_view host) {
    constexpr std::string_view MAPPED = "[::ffff:";
    if (!host.starts_with (MAPPED) || !host.ends_with (']')) {
        return false;
    }
    if (host == "[::ffff:0:0]") {
        return true; // ::ffff:0.0.0.0
    }
    // The serialiser writes lower-case hex without leading zeros, so the high
    // group of 127.0.0.0/8 (0x7f00-0x7fff) is always four digits from `7f`.
    const std::string_view groups = host.substr (MAPPED.size ());
    const std::string_view high   = groups.substr (0, groups.find (':'));
    return high.size () == 4 && high.starts_with ("7f");
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

} // namespace vayu::http
