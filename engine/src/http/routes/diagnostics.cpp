/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The transport connection test (`POST /diagnostics/connection`, #708): one
 * policy-honouring fetch reporting how it went and nothing of what came back. A
 * wrong proxy URL or missing CA should be caught when configured: proxy modes,
 * custom trust anchors and the client-certificate registry otherwise fail at
 * the first real request, whose message names the endpoint, not the setting.
 *
 * **A diagnostics surface, not a fetch proxy.** The answer carries an outcome,
 * the status line when there was one and libcurl's message, never a body,
 * headers or redirect chain. `/import/fetch` returns content, behind its own
 * bound; this must not become a second copy any caller can point anywhere.
 */

#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/log_redact.hpp"
#include "vayu/utils/logger.hpp"

#include <atomic>
#include <string>
#include <string_view>
#include <utility>

namespace vayu::http::routes {

namespace {

/**
 * How long one test may take: shorter than a request's default, since a person
 * waits on a button and a black-holing proxy would spin the card for a send's
 * full 30 seconds, yet long enough that a slow corporate hop is not reported as
 * a timeout it would not hit.
 */
constexpr int CONNECTION_TEST_TIMEOUT_MS = 10000;

/**
 * The test transfer's body cap. Not zero (unbounded): nothing reads the body,
 * so a gigabyte answer would be buffered to be thrown away. Free, yet past any
 * ordinary endpoint; one reaching it is reported reachable below
 * (`ErrorCode::ResponseTooLarge`), since bytes came back, the route's whole
 * question.
 */
constexpr size_t CONNECTION_TEST_MAX_BYTES = size_t{ 64 } * 1024;

/**
 * The outcome word for @p code, the distinction the route exists for, coarser
 * than `ErrorCode`: a caller picks which setting to point at, and the proxy
 * hop, the TLS handshake and nothing answering in time are the three answers
 * leading anywhere different. Everything else is `failed` with libcurl's
 * message, not a fourth word suggesting a fourth remedy.
 */
const char* outcome_for (ErrorCode code) {
    switch (code) {
    case ErrorCode::ProxyError: return "proxy_failed";
    case ErrorCode::SslError: return "tls_failed";
    case ErrorCode::Timeout: return "timed_out";
    default: return "failed";
    }
}

/// What the test routed through, so the card says where the bytes went without
/// re-deriving the mode's rules. The body reaches a person's screen and an
/// agent's context alike, so every `url` leaves without its `user:pass@`. The
/// policy's own URL (`manual`, or a resolved `system`) is reported as
/// configured, unless the probe went direct (`bypassed`, a `proxyBypass`
/// entry); a failed probe is not judged, as a failure at the proxy hop may
/// leave `proxy_used` unset. With none, `environment` and an unresolved
/// `system` leave `CURLOPT_PROXY` null and libcurl picks from the environment:
/// a proxy is named then only when it carried the probe (`proxy_used`,
/// `CURLINFO_USED_PROXY`, so a `no_proxy` exemption reads as direct), marked
/// `source: "environment"`. Absent `source` means `url` is the setting in
/// force.
nlohmann::json proxy_node (const TransportPolicy& policy,
std::string_view target_url,
bool proxy_used,
bool completed) {
    nlohmann::json node{ { "mode", to_string (policy.proxy_mode) } };
    if (!policy.proxy_url.empty ()) {
        if (completed && !proxy_used) {
            return node;
        }
        node["url"] = vayu::utils::strip_url_secrets (policy.proxy_url);
        return node;
    }
    if (!proxy_used) {
        return node;
    }
    node["source"]        = "environment";
    const std::string url = environment_proxy_url (target_url);
    if (!url.empty ()) {
        node["url"] = vayu::utils::strip_url_secrets (url);
    }
    return node;
}

} // namespace

/**
 * Testable core of POST /diagnostics/connection: one send through the live
 * transport policy, reported as an outcome.
 *
 * @param request_body `{"url": "https://..."}`.
 * @param transport How to reach the network. Passed in for `import_fetch`'s
 *                  reason: `Database`-free so a test can hand it a policy,
 *                  and required so no caller tests a direct connection
 *                  believing it tested the configured one.
 * @param cancel    `ClientConfig::cancel`, as `import_fetch`'s (#2683).
 * @return {http_status, json_body}. `200` for every answered question,
 *         failures included (a proxy refusing the tunnel is a successful
 *         test with a `proxy_failed` outcome, not a `502`); only a malformed
 *         request is a `400`.
 */
std::pair<int, nlohmann::json> connection_test (const std::string& request_body,
const TransportPolicy& transport,
const std::atomic<bool>* cancel) {
    const auto parsed = parse_request_json (request_body);
    if (!parsed) {
        return as_response (parsed.error ());
    }
    const nlohmann::json& req = *parsed;

    if (!req.is_object () || !req.contains ("url") || !req["url"].is_string ()) {
        return { 400, error_body (400, "Invalid 'url': must be an http or https URL") };
    }
    const std::string url = req["url"].get<std::string> ();
    if (url.rfind ("http://", 0) != 0 && url.rfind ("https://", 0) != 0) {
        return { 400, error_body (400, "Invalid 'url': must be an http or https URL") };
    }

    vayu::http::ClientConfig client_config;
    client_config.transport          = transport;
    client_config.max_response_bytes = CONNECTION_TEST_MAX_BYTES;
    client_config.cancel             = cancel;
    vayu::http::Client client (client_config);

    Request probe;
    probe.url = url;
    // HEAD, so a healthy endpoint costs a request and a status line. A server
    // refusing HEAD answers 405, still an answer proving every hop this asks
    // about, so the status travels back unjudged.
    probe.method     = HttpMethod::HEAD;
    probe.timeout_ms = CONNECTION_TEST_TIMEOUT_MS;
    // Trust anchors and the certificate are the subject, so verification stays
    // on: a pass with it off would answer a question nobody asked.
    probe.verify_ssl = true;
    // Redirects off: a 3xx is a reachable endpoint, the answer, and following
    // one would test a host the user never named and report its proxy and
    // certificate as this one's.
    probe.follow_redirects = false;

    auto result = client.send (probe);

    const bool proxy_used = result.is_ok () && result.value ().proxy_used;
    const bool completed  = result.is_ok () && !result.value ().has_error ();
    nlohmann::json body{ { "url", url },
        { "proxy", proxy_node (transport, url, proxy_used, completed) } };

    if (!result.is_ok ()) {
        // The client could not start (a URL libcurl refuses, a handle it could
        // not build): reported as a wire failure, not a 500, since the engine
        // is not broken.
        body["outcome"] = "failed";
        body["detail"]  = client.last_error ();
        return { 200, body };
    }

    const auto& resp = result.value ();
    // The entry that answered for this host, "" when none did or the URL is not
    // https (#707, #3260). Always sent, as `POST /execute` sends it, so a
    // caller tells "no certificate used" from "this engine cannot say", and the
    // card can name the registry row a handshake failure belongs to.
    body["clientCertificate"] = resp.client_certificate;

    if (resp.has_error ()) {
        body["outcome"]   = outcome_for (resp.error_code);
        body["errorCode"] = to_string (resp.error_code);
        body["detail"] =
        resp.error_message.empty () ? std::string ("connection error") : resp.error_message;
        return { 200, body };
    }

    body["outcome"] = "ok";
    body["status"]  = resp.status_code;
    return { 200, body };
}

void register_diagnostics_routes (RouteContext& ctx) {
    /**
     * POST /diagnostics/connection
     * Performs one policy-honouring request to the given URL and reports how it
     * went - proxy failure, TLS failure, timeout or reachable - so a wrong
     * proxy or an untrusted CA is caught where it is configured.
     * Body params: url (required, http/https).
     * Returns: 200 `{"url", "outcome", "proxy", "clientCertificate",
     * "status"?, "errorCode"?, "detail"?}` - a failed *connection* is still a
     * 200, because the test succeeded in answering. 400 on a bad body or URL.
     * Never returns the response body, headers or redirect chain.
     */
    ctx.server.Post ("/diagnostics/connection",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        auto [status, body] = connection_test (req.body,
        vayu::http::resolve_transport_policy (ctx.db), &ctx.server_stopping);
        res.status          = status;
        res.set_content (body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    });
}

} // namespace vayu::http::routes
