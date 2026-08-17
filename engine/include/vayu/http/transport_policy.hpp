#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/transport_policy.hpp
 * @brief How an outbound transfer reaches the network (issue #705).
 *
 * One policy, resolved from settings at the point of use, applied by one
 * function (`detail::apply_transport_policy`). Every driver - the
 * single-request client, the load event loop and the SSE consumer - reads the
 * same struct, which is the whole point: building transport config per-driver
 * is how the SSE path came to have no proxy option at all while the other two
 * did. Phases 2 and 3 of #704 extend this struct with the TLS fields; nothing
 * about the plumbing changes when they do.
 */

#include <array>
#include <optional>
#include <string>
#include <string_view>

namespace vayu::db {
class Database;
}

namespace vayu::http {

/**
 * @brief Where a transfer's proxy comes from.
 */
enum class ProxyMode {
    /**
     * libcurl's own `http_proxy` / `https_proxy` / `no_proxy` environment
     * pickup - the default, because it is the behaviour every shell and CI
     * user already gets today by accident. Making it a named mode changes
     * nothing for them and gives the other two something to be distinct from.
     */
    Environment,
    /// The configured `proxyUrl`, for everything the bypass list does not skip.
    Manual,
    /**
     * No proxy at all, environment included. Distinct from `Environment`
     * because a desktop app launched from a dock inherits no environment while
     * a terminal-launched engine does, so "leave it alone" and "do not proxy"
     * are different answers.
     */
    Off
};

/// Every mode, in the order the `proxyMode` setting offers them. The seed
/// builds its options from this rather than from a literal list, so a mode
/// added here cannot become one the engine understands and `POST /config`
/// refuses - the same rule `all_http_versions` exists for.
std::array<ProxyMode, 3> all_proxy_modes ();

/// The wire spelling of @p mode, as the `proxyMode` config entry stores it.
const char* to_string (ProxyMode mode);

/// What the Settings row calls @p mode.
const char* proxy_mode_label (ProxyMode mode);

/// Parse a stored `proxyMode`. An unrecognised value yields nullopt so the
/// caller decides between falling back and refusing - the two callers want
/// different things (the resolver logs and falls back, the config route
/// rejects).
std::optional<ProxyMode> proxy_mode_from_string (std::string_view value);

/**
 * @brief Why @p url cannot be a proxy URL, or nullopt when it can.
 *
 * The one copy of the rule: `POST /config` rejects a bad value with it, and
 * the resolver below re-checks a row that was hand-edited around the route.
 * Deliberately permissive about the shapes curl itself accepts - a bare
 * `host:port` is valid and means `http://host:port` - and strict about the
 * shapes that are always a mistake: empty, whitespace-bearing, no host, or a
 * scheme libcurl has no proxy support for.
 */
std::optional<std::string> proxy_url_rejection (std::string_view url);

/**
 * @brief Everything the wire needs to know about how to leave this machine.
 */
struct TransportPolicy {
    ProxyMode proxy_mode = ProxyMode::Environment;

    /**
     * curl-shaped: `scheme://user:pass@host:port`. That one string buys SOCKS
     * (`socks5://`, `socks5h://`) and basic proxy auth with no extra columns
     * and no second credential store - epic decision 5 of #704.
     *
     * Read only in `ProxyMode::Manual`.
     */
    std::string proxy_url;

    /**
     * Hosts that skip the proxy, comma-separated, passed to `CURLOPT_NOPROXY`
     * verbatim. curl's matching rules (leading-dot suffix match, `*` for
     * everything) are documented rather than re-implemented here: a second
     * implementation of host matching is a second set of bugs, and the one
     * that ships in libcurl is the one the user's other tools already obey.
     */
    std::string proxy_bypass;
};

/**
 * @brief Read the policy out of the config table.
 *
 * Resolved at the point of use rather than cached, the same way
 * `read_sse_limits` is, so a settings change applies to the next transfer
 * without a restart. A value no `POST /config` would have accepted can still
 * reach here from a hand-edited row; each one is logged and replaced with the
 * default rather than trusted, because a malformed `proxyUrl` silently
 * becomes "no proxy" and that is the failure this whole issue exists to stop
 * being invisible.
 */
TransportPolicy resolve_transport_policy (vayu::db::Database& db);

} // namespace vayu::http
