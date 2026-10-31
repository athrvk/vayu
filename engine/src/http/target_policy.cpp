/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/target_policy.cpp
 * @brief The per-payload host rule a send or run is held to (issue #2521).
 */

#include "vayu/http/target_policy.hpp"

#include <algorithm>
#include <utility>

#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/ascii_case.hpp"

namespace vayu::http {

namespace {

constexpr std::string_view ALLOW_ALL_MEMBER     = "allowAll";
constexpr std::string_view ALLOWED_HOSTS_MEMBER = "allowedHosts";
constexpr std::string_view ASCII_WHITESPACE     = " \t\r\n\f\v";

/// An allowlist entry as the MCP server compares one: trimmed, lower-cased.
std::string normalized_entry (std::string_view entry) {
    const size_t first = entry.find_first_not_of (ASCII_WHITESPACE);
    if (first == std::string_view::npos) {
        return {};
    }
    const size_t last = entry.find_last_not_of (ASCII_WHITESPACE);
    return vayu::utils::ascii_lower (entry.substr (first, last - first + 1));
}

std::string member_error (std::string_view member,
std::string_view expected,
const nlohmann::json& got) {
    return "'" + std::string (TARGET_POLICY_FIELD) + "." + std::string (member) +
    "' must be " + std::string (expected) + " (got " + got.type_name () + ")";
}

std::expected<std::vector<std::string>, std::string> read_allowed_hosts (
const nlohmann::json& hosts) {
    if (!hosts.is_array ()) {
        return std::unexpected (
        member_error (ALLOWED_HOSTS_MEMBER, "an array of strings", hosts));
    }
    std::vector<std::string> out;
    out.reserve (hosts.size ());
    for (const auto& host : hosts) {
        if (!host.is_string ()) {
            return std::unexpected (
            member_error (ALLOWED_HOSTS_MEMBER, "an array of strings", host));
        }
        out.push_back (normalized_entry (host.get_ref<const std::string&> ()));
    }
    return out;
}

/// The host @p url would dial, as the MCP server's `extractHost` reads one, or
/// nothing when it names none it could compare.
std::optional<std::string> comparable_host (std::string_view url) {
    const std::string host = detail::parse_authority (std::string (url)).host;
    // A template the residual pass left is a name nothing answered, not a host.
    if (host.empty () || host.find ("{{") != std::string::npos ||
    host.find ("}}") != std::string::npos) {
        return std::nullopt;
    }
    return canonical_host (host);
}

std::string joined (const std::vector<std::string>& hosts) {
    std::string out;
    for (const auto& host : hosts) {
        if (!out.empty ()) {
            out += ", ";
        }
        out += host;
    }
    return out;
}

/// @p policy's verdict on @p url, which the refusal calls @p subject.
std::optional<TargetRefusal>
refuse_url (const TargetPolicy& policy, std::string_view url, std::string_view subject) {
    const auto host = comparable_host (url);
    if (!host) {
        return TargetRefusal{ "Could not determine the target host from " +
            std::string (subject) +
            " (it may be empty or hold an unresolved {{variable}}), so this "
            "request's target policy cannot allow it. Nothing was sent.",
            TARGET_HOST_UNKNOWN_CODE };
    }
    if (policy.allow_all ||
    std::ranges::find (policy.allowed_hosts, *host) != policy.allowed_hosts.end ()) {
        return std::nullopt;
    }
    std::string message =
    "Host \"" + *host + "\", which " + std::string (subject) + " names, ";
    message += policy.allowed_hosts.empty () ?
    std::string ("is refused: this request's target policy allows no host.") :
    "is not allowed by this request's target policy (allowed hosts: " +
    joined (policy.allowed_hosts) + ").";
    message += " Nothing was sent.";
    return TargetRefusal{ std::move (message), TARGET_NOT_ALLOWED_CODE };
}

} // namespace

std::expected<std::optional<TargetPolicy>, std::string> read_target_policy (
const nlohmann::json& payload) {
    const auto field = payload.find (TARGET_POLICY_FIELD);
    if (field == payload.end () || field->is_null ()) {
        return std::nullopt;
    }
    if (!field->is_object ()) {
        return std::unexpected ("'" + std::string (TARGET_POLICY_FIELD) +
        "' must be an object (got " + field->type_name () + ")");
    }
    TargetPolicy policy;
    for (const auto& [member, value] : field->items ()) {
        if (member == ALLOW_ALL_MEMBER) {
            if (!value.is_boolean ()) {
                return std::unexpected (member_error (ALLOW_ALL_MEMBER, "a boolean", value));
            }
            policy.allow_all = value.get<bool> ();
        } else if (member == ALLOWED_HOSTS_MEMBER) {
            auto hosts = read_allowed_hosts (value);
            if (!hosts) {
                return std::unexpected (std::move (hosts.error ()));
            }
            policy.allowed_hosts = std::move (*hosts);
        } else {
            return std::unexpected ("'" + std::string (TARGET_POLICY_FIELD) +
            "' has no member '" + member + "' (it takes allowAll and allowedHosts)");
        }
    }
    return policy;
}

std::optional<TargetRefusal>
refuse_target (const TargetPolicy& policy, const vayu::Request& request) {
    return refuse_url (policy, wire_url (request), "the URL about to be sent");
}

std::optional<TargetRefusal> refuse_token_endpoints (const TargetPolicy& policy,
const nlohmann::json& config) {
    if (!config.is_object ()) {
        return std::nullopt;
    }
    for (const std::string_view member : oauth::TOKEN_ENDPOINT_MEMBERS) {
        // An empty or non-string member posts nothing: `acquire_token` refuses
        // the config, or the refresh falls back to the token URL.
        const auto url = config.find (member);
        if (url == config.end () || !url->is_string ()) {
            continue;
        }
        const auto& text = url->get_ref<const std::string&> ();
        if (text.empty ()) {
            continue;
        }
        const std::string subject = "the OAuth 2.0 " + std::string (member);
        if (auto refusal = refuse_url (policy, text, subject)) {
            return refusal;
        }
    }
    return std::nullopt;
}

// Judged as `wire_url` writes it, not as typed: `collect_monitor` hands the
// scrape's `Request` (default encoding on) to the client, and the encoding pass
// turns `\` into `/`, so `http://a:1\@b:1/` is typed as host `b` and dialled as
// `a` (#2465, the same constraint `validate_transferable` documents).
std::optional<TargetRefusal> refuse_monitor_endpoint (const TargetPolicy& policy,
const nlohmann::json& monitor) {
    if (!monitor.is_object ()) {
        return std::nullopt;
    }
    const auto url = monitor.find ("url");
    if (url == monitor.end () || !url->is_string ()) {
        return std::nullopt;
    }
    vayu::Request scrape;
    scrape.method = vayu::HttpMethod::GET;
    scrape.url    = url->get_ref<const std::string&> ();
    return refuse_url (policy, wire_url (scrape), "the run's monitor.url");
}

} // namespace vayu::http
