#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/target_policy.hpp
 * @brief Which hosts one send or run may reach, as its caller states it per
 *        payload (`targetPolicy`, issue #2521).
 *
 * The MCP server checks its allowlist against the composed URL before it sends,
 * but a pre-request script can rewrite `pm.request.url` or set the variable a
 * deferred `{{host}}` resolves from after that check. So the caller hands the
 * engine the same rule, and the engine applies it to the URL about to be sent:
 * after the scripts and the residual pass, before the transfer. It rides on the
 * payload rather than in config because it is the caller's session rule and
 * changes per request; it is never stored (`sanitize_config_snapshot` drops
 * it, and a run keeps it on its in-memory `RunContext` only).
 *
 * The match is the MCP server's own (`checkAllowlist`, `app/electron/mcp/
 * safety.ts`): the URL's host as a WHATWG parser reports it, compared exactly
 * with each entry trimmed and lower-cased; `allowAll` admits any host that can
 * be determined; a host that cannot be determined is refused either way.
 *
 * It covers the request about to be sent, every endpoint an OAuth 2.0 token
 * for it is acquired from (`refuse_token_endpoints`), whose URL a script can
 * set as easily as the request's, and a load run's `monitor.url`
 * (`refuse_monitor_endpoint`), judged once when `POST /runs` validates the run
 * because the scrape loop sends with no policy of its own; not a redirect hop
 * a server answers with, and not a `pm.sendRequest` a script makes.
 */

#include <expected>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/types.hpp"

namespace vayu::http {

/// The payload member of `POST /execute` and `POST /runs` that carries it.
inline constexpr std::string_view TARGET_POLICY_FIELD = "targetPolicy";

/// A refusal of a host the policy does not list.
inline constexpr std::string_view TARGET_NOT_ALLOWED_CODE =
"target_not_allowed";

/// A refusal of a URL whose host cannot be determined, which no policy admits.
inline constexpr std::string_view TARGET_HOST_UNKNOWN_CODE =
"target_host_unknown";

/// Whether @p code is one of the two a host is refused under, for a caller
/// relaying a refusal that may be a target policy's or something else's.
[[nodiscard]] constexpr bool is_target_refusal_code (std::string_view code) {
    return code == TARGET_NOT_ALLOWED_CODE || code == TARGET_HOST_UNKNOWN_CODE;
}

/// The 400 both routes answer a malformed `targetPolicy` with.
inline constexpr std::string_view INVALID_TARGET_POLICY_CODE =
"invalid_target_policy";

struct TargetPolicy {
    /// Any host that can be determined is allowed; `allowed_hosts` is unread.
    bool allow_all = false;
    /// Trimmed and lower-cased. Empty allows no host.
    std::vector<std::string> allowed_hosts;
};

/// Why @ref refuse_target refused a request: the sentence, and which code.
struct TargetRefusal {
    std::string message;
    std::string_view code;
};

/**
 * @p payload's `targetPolicy`: nullopt when absent or `null`, the policy when
 * it is `{allowAll?: boolean, allowedHosts?: string[]}`, and the reason it is
 * not otherwise, for the route's 400. An unknown member is refused too, so a
 * misspelt `allowedHost` cannot quietly allow nothing.
 */
[[nodiscard]] std::expected<std::optional<TargetPolicy>, std::string>
read_target_policy (const nlohmann::json& payload);

/**
 * Whether @p policy refuses @p request as it is about to be sent: its wire URL
 * (`wire_url`), so a URL the encoding pass rewrites is judged as dialled.
 * Nothing when the host is allowed.
 */
[[nodiscard]] std::optional<TargetRefusal>
refuse_target (const TargetPolicy& policy, const vayu::Request& request);

/**
 * Whether @p policy refuses acquiring a token for the OAuth 2.0 @p config: the
 * host of each URL `oauth::acquire_token` may post to
 * (`oauth::TOKEN_ENDPOINT_MEMBERS`, an empty one skipped), judged by the rule
 * @ref refuse_target applies, under the same codes. Both members are judged
 * whether or not this acquisition would reach them, so the verdict does not
 * depend on what the token cache holds. Nothing when every host is allowed.
 */
[[nodiscard]] std::optional<TargetRefusal>
refuse_token_endpoints (const TargetPolicy& policy, const nlohmann::json& config);

/**
 * Whether @p policy refuses a load run's `monitor` block: the host of its
 * `url`, which the run scrapes as written for as long as it runs (#3121),
 * judged by the rule @ref refuse_target applies, under the same codes. Nothing
 * when the host is allowed, or when @p monitor holds no string `url`, a block
 * `validate_monitor_config` refuses on its own.
 */
[[nodiscard]] std::optional<TargetRefusal>
refuse_monitor_endpoint (const TargetPolicy& policy, const nlohmann::json& monitor);

} // namespace vayu::http
