/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/transport_policy.cpp
 * @brief Reading the transport policy out of settings (issue #705).
 */

#include "vayu/http/transport_policy.hpp"

#include <algorithm>
#include <array>
#include <cctype>

#include "vayu/db/database.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http {

namespace {

/// The proxy schemes libcurl understands. A scheme outside this list is always
/// a typo - curl would take `htp://host` as a *host* named "htp:" and dial
/// something the user never named.
constexpr std::array<std::string_view, 7> PROXY_SCHEMES = { "http", "https",
    "socks4", "socks4a", "socks5", "socks5h", "socks5t" };

bool is_blank (std::string_view value) {
    return std::all_of (value.begin (), value.end (),
    [] (unsigned char c) { return std::isspace (c) != 0; });
}

} // namespace

std::array<ProxyMode, 3> all_proxy_modes () {
    return { ProxyMode::Environment, ProxyMode::Manual, ProxyMode::Off };
}

const char* to_string (ProxyMode mode) {
    switch (mode) {
    case ProxyMode::Environment: return "environment";
    case ProxyMode::Manual: return "manual";
    case ProxyMode::Off: return "off";
    }
    return "environment";
}

const char* proxy_mode_label (ProxyMode mode) {
    switch (mode) {
    case ProxyMode::Environment: return "From environment";
    case ProxyMode::Manual: return "Manual";
    case ProxyMode::Off: return "None";
    }
    return "From environment";
}

std::optional<ProxyMode> proxy_mode_from_string (std::string_view value) {
    if (value == "environment") {
        return ProxyMode::Environment;
    }
    if (value == "manual") {
        return ProxyMode::Manual;
    }
    if (value == "off") {
        return ProxyMode::Off;
    }
    return std::nullopt;
}

std::optional<std::string> proxy_url_rejection (std::string_view url) {
    if (url.empty () || is_blank (url)) {
        return std::string ("proxy URL is empty");
    }
    if (std::any_of (url.begin (), url.end (),
        [] (unsigned char c) { return std::isspace (c) != 0; })) {
        return std::string ("proxy URL contains whitespace");
    }

    std::string_view authority = url;
    const auto scheme_end      = url.find ("://");
    if (scheme_end != std::string_view::npos) {
        const std::string_view scheme = url.substr (0, scheme_end);
        std::string lowered (scheme);
        std::transform (lowered.begin (), lowered.end (), lowered.begin (),
        [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });
        if (std::find (PROXY_SCHEMES.begin (), PROXY_SCHEMES.end (), lowered) ==
        PROXY_SCHEMES.end ()) {
            std::string allowed;
            for (const auto& candidate : PROXY_SCHEMES) {
                allowed += (allowed.empty () ? "" : ", ");
                allowed += std::string (candidate);
            }
            return "proxy URL scheme '" + std::string (scheme) +
            "' is not one libcurl proxies through (expected one of: " + allowed + ")";
        }
        authority = url.substr (scheme_end + 3);
    }

    // Userinfo is optional and may itself contain '@' in an encoded password,
    // so the host starts after the *last* one.
    const auto userinfo_end = authority.rfind ('@');
    if (userinfo_end != std::string_view::npos) {
        authority = authority.substr (userinfo_end + 1);
    }
    // Anything past the authority (a path curl ignores on a proxy URL) is not
    // part of the host.
    const auto host = authority.substr (0, authority.find ('/'));
    if (host.empty () || host.front () == ':') {
        return std::string ("proxy URL names no host");
    }
    return std::nullopt;
}

TransportPolicy resolve_transport_policy (vayu::db::Database& db) {
    TransportPolicy policy;

    const std::string mode_value =
    db.get_config_string ("proxyMode", to_string (policy.proxy_mode));
    if (const auto parsed = proxy_mode_from_string (mode_value)) {
        policy.proxy_mode = *parsed;
    } else {
        // Only reachable from a hand-edited row - `POST /config` rejects a
        // value outside the enum's options. Named rather than swallowed, as
        // read_sse_limits names an out-of-range limit.
        vayu::utils::log_warning (
        "Config 'proxyMode' holds unrecognised value '" + mode_value +
        "'; using '" + to_string (policy.proxy_mode) + "'");
    }

    policy.proxy_bypass = db.get_config_string ("proxyBypass", "");

    if (policy.proxy_mode != ProxyMode::Manual) {
        // Left empty deliberately: a stored URL that no mode reads must not
        // reach a handle, or turning the mode off would still route through it.
        return policy;
    }

    const std::string url = db.get_config_string ("proxyUrl", "");
    if (const auto rejection = proxy_url_rejection (url)) {
        // Manual mode with an unusable URL is the one combination that must not
        // fail quietly: leaving it in Manual would send every request direct
        // while Settings says otherwise, which is precisely the invisible
        // failure this issue exists to end. `Off` at least means what it says,
        // and the log names the setting to fix.
        vayu::utils::log_error (
        "Config 'proxyMode' is 'manual' but 'proxyUrl' is "
        "unusable (" +
        *rejection + "); no proxy will be used until it is corrected");
        policy.proxy_mode = ProxyMode::Off;
        return policy;
    }

    policy.proxy_url = url;
    return policy;
}

} // namespace vayu::http
