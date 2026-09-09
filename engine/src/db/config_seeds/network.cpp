/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "seed.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/transport_policy.hpp"

#include <nlohmann/json.hpp>

#include <string>

namespace vayu::db::config_seeds {

namespace {
// Serialize all_http_versions() to the `{value,label}` JSON array the
// "defaultHttpVersion" config entry stores in its `options` column. Derived
// from the domain enumeration rather than a literal list, so a change to
// HttpVersion cannot silently drift out of sync with the seeded options.
std::string http_version_options_json () {
    nlohmann::json options = nlohmann::json::array ();
    for (const auto version : vayu::all_http_versions ()) {
        options.push_back ({ { "value", vayu::to_string (version) },
        { "label", vayu::http_version_label (version) } });
    }
    return options.dump ();
}

// The `{value,label}` array for "proxyMode". Derived from the enumeration the
// resolver parses, so a mode added to `ProxyMode` cannot be missing from the
// options the config route validates against - which would make it a value
// the engine understands and `POST /config` refuses.
std::string proxy_mode_options_json () {
    nlohmann::json options = nlohmann::json::array ();
    for (const auto mode : vayu::http::all_proxy_modes ()) {
        options.push_back ({ { "value", vayu::http::to_string (mode) },
        { "label", vayu::http::proxy_mode_label (mode) } });
    }
    return options.dump ();
}
} // namespace

// =============================================================================
// NETWORK & CONNECTIVITY (network_performance)
// The wire itself: what a new request starts with, how many transfers a
// worker keeps open, and how long a name resolution is reused. The OAuth
// renewal knobs that used to sit here were five of its eight entries and
// moved to Services (#703) - a user tuning token renewal does not arrive at
// "network tuning".
// =============================================================================
void seed_network (ConfigSeeder& seed, int64_t now) {
    seed (unit ("ms") (keywords ({ "deadline", "give up", "hang" }) (ConfigEntry{ "defaultTimeout",
    std::to_string (vayu::core::constants::server::DEFAULT_TIMEOUT_MS), "integer", "Default Request Timeout",
    "How long an HTTP request may run before it is abandoned, "
    "when the request does not set a timeout of its own. Raise it for slow "
    "endpoints; lower it to fail faster.",
    "network_performance", std::to_string (vayu::core::constants::server::DEFAULT_TIMEOUT_MS),
    "1000",   // min: 1 second
    "300000", // max: 5 minutes
    std::nullopt, now })));

    seed (keywords ({ "h2", "alpn" }) (ConfigEntry{ "defaultHttpVersion",
    vayu::to_string (vayu::DEFAULT_HTTP_VERSION), "enum", "Default HTTP Version",
    "Protocol a newly created request starts with. Auto lets the server and "
    "client negotiate (HTTP/2 where available, falling back to HTTP/1.1). "
    "Changing this does not alter requests that already exist.",
    "network_performance", vayu::to_string (vayu::DEFAULT_HTTP_VERSION),
    std::nullopt, std::nullopt, http_version_options_json (), now }));

    seed (keywords ({ "concurrency", "parallel" }) (ConfigEntry{
    "eventLoopMaxConcurrent", std::to_string (vayu::core::constants::event_loop::MAX_CONCURRENT),
    "integer", "Max Concurrent Requests (Per Worker)",
    "How many requests one worker keeps in flight at once. Higher values use "
    "more file descriptors and push the target harder. Read when a load test "
    "starts, so a change applies to the next run.",
    "network_performance", std::to_string (vayu::core::constants::event_loop::MAX_CONCURRENT),
    "1", "10000", std::nullopt, now }));

    seed (keywords ({ "socket", "pool" }) (ConfigEntry{ "eventLoopMaxPerHost",
    std::to_string (vayu::core::constants::event_loop::MAX_PER_HOST), "integer", "Max Connections Per Host (Per Worker)",
    "Concurrency limit for a specific target API host. Critical for respecting "
    "target rate limits. "
    "Lower values are gentler on the target; higher values maximize "
    "throughput.",
    "network_performance", std::to_string (vayu::core::constants::event_loop::MAX_PER_HOST),
    "1", "1000", std::nullopt, now }));

    seed (unit ("sec") (keywords ({ "ttl" }) (ConfigEntry{ "dnsCacheTimeout",
    std::to_string (vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS), "integer", "DNS Cache Timeout",
    "How long a resolved hostname is reused before it is looked up "
    "again. 0 forces a fresh lookup on every request; 60 to 300 seconds suits "
    "a "
    "stable endpoint.",
    "network_performance", std::to_string (vayu::core::constants::event_loop::DNS_CACHE_TIMEOUT_SECONDS),
    "0",    // Disable cache
    "3600", // 1 hour
    std::nullopt, now })));

    // Proxy (issue #705). Three entries, read together by
    // `resolve_transport_policy` at the point of use, so a change applies to
    // the next transfer rather than the next restart. The keywords are the
    // words someone arrives with when nothing works and they suspect the
    // network - none of which the labels say.
    seed (keywords ({ "corporate", "firewall", "mitm", "zscaler", "vpn" }) (ConfigEntry{ "proxyMode",
    vayu::http::to_string (vayu::http::TransportPolicy{}.proxy_mode), "enum", "Proxy",
    "How outbound requests reach the network. From environment uses the "
    "http_proxy and https_proxy variables the engine was started with, which "
    "is what a terminal-launched engine already picks up and a desktop launch "
    "usually has none of. From system uses the proxy this computer is "
    "configured with, which the app resolves and shows below. Manual routes "
    "everything through the proxy URL below. None sends direct, ignoring those "
    "variables too.",
    "network_performance", vayu::http::to_string (vayu::http::TransportPolicy{}.proxy_mode),
    std::nullopt, std::nullopt, proxy_mode_options_json (), now }));

    seed (keywords ({ "corporate", "firewall", "mitm" }) (
    ConfigEntry{ "proxyUrl", "", "string", "Proxy URL",
    "The proxy to route through when Proxy is set to Manual, written the way "
    "curl takes it: scheme://user:password@host:port. The scheme selects the "
    "kind - http, https, socks4, socks4a, socks5, socks5h - and credentials in "
    "the URL are sent as basic proxy authentication.",
    "network_performance", "", std::nullopt, std::nullopt, std::nullopt, now }));

    // The resolved system proxy (issue #708). Written by the app's main
    // process, which is the only part of Vayu that can ask the operating system
    // - Chromium resolves it, libcurl sees none of it - and read by the engine
    // only under `proxyMode: system`.
    //
    // A visible row rather than a hidden side channel: a proxy the user cannot
    // see is the failure this epic exists to end, and "system" that silently
    // resolved to nothing has to be readable as such. It is stored where the
    // user can edit it, and an edit lasts until the next resolution overwrites
    // it - said in the description rather than enforced, because a read-only
    // entry type would be a new concept in the config table for one row.
    seed (keywords ({ "wpad", "autoconfig", "automatic" }) (
    ConfigEntry{ "proxySystemUrl", "", "string", "System Proxy (resolved)",
    "The proxy this computer is configured with, as the app resolved it when "
    "it started and whenever the network changed. Read only when Proxy is set "
    "to From system; empty means nothing resolved - a direct configuration, or "
    "an engine running with no app to ask - and requests then fall back to the "
    "http_proxy and https_proxy variables. A PAC script is resolved once, "
    "against a sample URL, and the one answer applies to every request: a "
    "configuration that returns different proxies for different URLs needs "
    "Manual instead. Typing a value here works until the next resolution "
    "replaces it.",
    "network_performance", "", std::nullopt, std::nullopt, std::nullopt, now }));

    seed (keywords ({ "exclude", "whitelist", "intranet" }) (
    ConfigEntry{ "proxyBypass", "", "string", "Proxy Bypass List",
    "Hosts that skip the proxy, comma-separated. A leading dot matches a "
    "domain and everything under it (.internal.example.com), and a single * "
    "bypasses the proxy for every host. Under Manual this list is the whole "
    "rule, so an empty one means nothing is exempt and any no_proxy the engine "
    "was started with is ignored. Under From environment it overrides that "
    "variable when set, and defers to it when empty. Under From system it "
    "follows whichever of those two that mode resolved to.",
    "network_performance", "", std::nullopt, std::nullopt, std::nullopt, now }));

    // What the engine adds to a request nobody wrote it into (issue #1229).
    // Four entries, read together by `resolve_default_header_policy` at the top
    // of a request or a run, so a change applies to the next send rather than
    // the next restart - the shape the proxy entries above use, and for the
    // same reason. What each of them adds is shown in the Headers tab as a row
    // the request can switch off; none of it is stored in the request.
    seed (keywords ({ "gzip", "brotli", "deflate", "zstd" }) (ConfigEntry{
    "negotiateCompression", "true", "boolean", "Negotiate Compressed Responses",
    "Asks servers for a compressed response - the Accept-Encoding header a "
    "browser, Postman and curl --compressed all send - and decodes it before "
    "you see it. Response sizes and times then describe what production does. "
    "Off sends no Accept-Encoding at all, so a server that would have "
    "compressed answers with the identity bytes instead. Applies to a Send, a "
    "collection run and a script's own request; a load run has its own setting "
    "below. A request that carries its own Accept-Encoding header is left "
    "alone, and its response is not decoded.",
    "network_performance", "true", std::nullopt, std::nullopt, std::nullopt, now }));

    seed (keywords ({ "gzip", "brotli", "zstd", "throughput" }) (ConfigEntry{
    "loadNegotiateCompression", "true", "boolean", "Negotiate Compressed Responses (Load Tests)",
    "The same decision for a load run, kept separate because compression is "
    "part of what a load test measures: with it on, the bytes counted are what "
    "the server sent and the sizes reported are what Vayu decoded; with it "
    "off, both are the identity response. Turn it off to measure a server's "
    "uncompressed ceiling, on to measure what its clients actually get.",
    "network_performance", "true", std::nullopt, std::nullopt, std::nullopt, now }));

    seed (keywords ({ "tracing", "x-request-id", "debugging" }) (
    ConfigEntry{ "correlationIdEnabled", "false", "boolean", "Send a Correlation Id",
    "Adds a header carrying a fresh identifier to every request, so one send "
    "or one iteration of a load run can be found in a server's logs. Off by "
    "default: it is a header your server did not ask for, and a gateway that "
    "gives the name its own meaning would see one it did not expect. A request "
    "that carries the header itself is left alone.",
    "network_performance", "false", std::nullopt, std::nullopt, std::nullopt, now }));

    seed (
    keywords ({ "tracing", "distributed" }) (ConfigEntry{ "correlationIdHeader",
    std::string (vayu::http::DEFAULT_CORRELATION_HEADER), "string", "Correlation Id Header",
    "Which header the correlation id goes out under, when it is switched on. "
    "The default is namespaced to Vayu so it collides with nothing; set it to "
    "the name your own infrastructure reads - X-Request-ID and "
    "X-Correlation-ID are the common ones - if you want Vayu's id to land "
    "there instead.",
    "network_performance", std::string (vayu::http::DEFAULT_CORRELATION_HEADER),
    std::nullopt, std::nullopt, std::nullopt, now }));

    // Custom trust anchors (issue #706). `text` rather than `string` because
    // what goes in it is a pasted PEM block: the single-line input every other
    // string entry renders cannot show one, let alone several.
    //
    // Content, not a path - a path breaks the moment the file moves and cannot
    // be shown back in Settings. The engine materializes the bundle beside the
    // database, extending the platform's own anchors rather than replacing
    // them; see `resolve_transport_policy`.
    seed (keywords ({ "firewall", "mitm", "zscaler", "ssl" }) (
    ConfigEntry{ "customCaCertificates", "", "text", "Custom CA Certificates",
    "Certificate authorities to trust in addition to the ones this platform "
    "already trusts, pasted as PEM text (one or more -----BEGIN "
    "CERTIFICATE----- blocks). This is what makes a corporate TLS-inspecting "
    "proxy or an internal self-signed authority verifiable everywhere the "
    "engine sends: requests, load runs, streams, OAuth token fetches and spec "
    "imports alike. Paste certificates only - never a private key.",
    "network_performance", "", std::nullopt, std::nullopt, std::nullopt, now }));
}

} // namespace vayu::db::config_seeds
