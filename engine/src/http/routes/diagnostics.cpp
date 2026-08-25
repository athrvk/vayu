/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/diagnostics.cpp
 * @brief The transport connection test (`POST /diagnostics/connection`, issue
 *        #708) - one policy-honouring fetch that reports how it went and
 *        nothing about what came back.
 *
 * The moment a wrong proxy URL or a missing CA is meant to be caught is when it
 * is configured, not in the middle of a demo. Everything the epic added -
 * proxy modes, custom trust anchors, the client-certificate registry - fails at
 * the *first real request* otherwise, and the message a user sees there names
 * the endpoint rather than the setting.
 *
 * **It is a diagnostics surface, not a fetch proxy.** The response carries an
 * outcome, the status line when there was one, and libcurl's own message; it
 * never carries a body, headers or a redirect chain. `/import/fetch` is the
 * route that returns content, behind its own bound, and this one must not
 * become a second copy of it that any caller can point anywhere.
 */

#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

#include <string>
#include <utility>

namespace vayu::http::routes {

namespace {

/**
 * How long one test may take.
 *
 * Short on purpose, and shorter than a request's own default: this is a person
 * waiting on a button, and a proxy that black-holes a connection would
 * otherwise leave the card spinning for the full 30 seconds a real send is
 * allowed. Long enough that a slow corporate hop is not reported as a timeout
 * it would not really hit.
 */
constexpr int CONNECTION_TEST_TIMEOUT_MS = 10000;

/**
 * The body cap for the test transfer.
 *
 * Not zero (unbounded): nothing here reads the body, so a URL that answers with
 * a gigabyte would be a gigabyte buffered to be thrown away. Small enough to be
 * free and large enough that no ordinary endpoint reaches it - and if one does,
 * `ErrorCode::ResponseTooLarge` is reported as a reachable endpoint below,
 * because the bytes came back and that is the whole question this route asks.
 */
constexpr size_t CONNECTION_TEST_MAX_BYTES = size_t{ 64 } * 1024;

/**
 * The outcome word for @p code - the distinction the whole route exists for.
 *
 * Deliberately coarser than `ErrorCode`: a caller is choosing which setting to
 * point the user at, and "the proxy hop failed" / "the TLS handshake failed" /
 * "nothing answered in time" are the three answers that lead anywhere
 * different. Everything else is `failed`, carrying libcurl's message, rather
 * than a fourth word that suggests a fourth remedy.
 */
const char* outcome_for (ErrorCode code) {
    switch (code) {
    case ErrorCode::ProxyError: return "proxy_failed";
    case ErrorCode::SslError: return "tls_failed";
    case ErrorCode::Timeout: return "timed_out";
    default: return "failed";
    }
}

/// What the test routed through, so the card can say where the bytes went
/// without re-deriving the mode's rules for itself. The URL is the one in
/// force, which under `system` is what the app resolved and under `environment`
/// is unknown to this engine - libcurl reads those variables itself - so an
/// absent `url` means "not this engine's to say", never "no proxy".
nlohmann::json proxy_node (const TransportPolicy& policy) {
    nlohmann::json node{ { "mode", to_string (policy.proxy_mode) } };
    if (!policy.proxy_url.empty ()) {
        node["url"] = policy.proxy_url;
    }
    return node;
}

} // namespace

/**
 * Testable core of POST /diagnostics/connection - one send through the live
 * transport policy, reported as an outcome.
 *
 * @param request_body `{"url": "https://..."}`.
 * @param transport How to reach the network. Passed in rather than resolved
 *                  here for the reason `import_fetch`'s is: this function is
 *                  deliberately `Database`-free so it can be tested against a
 *                  policy a test constructs, and required rather than defaulted
 *                  so no future caller can test a direct connection while
 *                  believing it tested the configured one.
 * @return {http_status, json_body}. The status is `200` for every *answered*
 *         question, failures included - a proxy that refused the tunnel is a
 *         successful test with a `proxy_failed` outcome, not a `502`. Only a
 *         malformed request is a `400`.
 */
std::pair<int, nlohmann::json> connection_test (const std::string& request_body,
const TransportPolicy& transport) {
    nlohmann::json req;
    try {
        req = nlohmann::json::parse (request_body);
    } catch (const std::exception&) {
        return { 400, error_body (400, "Invalid JSON body") };
    }

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
    vayu::http::Client client (client_config);

    Request probe;
    probe.url = url;
    // HEAD, so a healthy endpoint costs a request line and a status line. A
    // server that refuses HEAD answers 405, which is still an answer and still
    // proves every hop this route is asking about - the status travels back
    // rather than being judged here for that reason.
    probe.method     = HttpMethod::HEAD;
    probe.timeout_ms = CONNECTION_TEST_TIMEOUT_MS;
    // The proxy hop, the trust anchors and the certificate are the subject of
    // the test, so verification stays on: a test that passed with verification
    // off would answer a question nobody asked.
    probe.verify_ssl = true;
    // Redirects off. A 3xx is a reachable endpoint, which is the answer; a
    // redirect chain would move the test to a host the user never named and
    // report *that* host's proxy and certificate as this one's.
    probe.follow_redirects = false;

    auto result = client.send (probe);

    nlohmann::json body{ { "url", url }, { "proxy", proxy_node (transport) } };

    if (!result.is_ok ()) {
        // The client could not even start - a URL libcurl refuses, a handle it
        // could not build. Reported in the same shape as a wire failure rather
        // than as a 500: nothing about it is the engine being broken.
        body["outcome"] = "failed";
        body["detail"]  = client.last_error ();
        return { 200, body };
    }

    const auto& resp = result.value ();
    // The entry that answered for this host, "" when none did (issue #707).
    // Sent always, the same way `POST /execute` sends it: a caller can then
    // tell "no certificate was used" from "this engine cannot say", and the
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
        vayu::utils::log_info ("POST /diagnostics/connection");
        auto [status, body] =
        connection_test (req.body, vayu::http::resolve_transport_policy (ctx.db));
        res.status = status;
        res.set_content (body.dump (-1, ' ', false, nlohmann::json::error_handler_t::replace),
        "application/json");
    });
}

} // namespace vayu::http::routes
