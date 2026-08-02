/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/event_loop/curl_utils.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <cassert>
#include <cctype>
#include <charconv>
#include <chrono>
#include <optional>
#include <string_view>
#include <system_error>

#include "vayu/core/constants.hpp"
#include "vayu/http/curl_version_map.hpp"
#include "vayu/http/event_loop/curl_callbacks.hpp"
#include "vayu/http/event_loop/event_loop_worker.hpp"
#include "vayu/http/event_loop/transfer_context.hpp"
#include "vayu/http/status.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::detail {

namespace {

/// Lowest and highest port a URL authority can name; anything else is not a
/// port curl could dial, so it is treated as absent.
constexpr int kMinPort = 1;
constexpr int kMaxPort = 65535;

int scheme_default_port (const std::string& url) {
    if (url.find ("https://") == 0)
        return 443;
    if (url.find ("http://") == 0)
        return 80;
    return 443; // Default to HTTPS
}

/// A digit run from a user-supplied URL can exceed any integer type.
/// std::from_chars reports that in its return value where std::stoi would
/// throw - and this runs on the event loop worker thread, which has no
/// handler, so an escaping exception terminates the whole daemon.
std::optional<int> parse_port (std::string_view digits) {
    int port             = 0;
    const char* first    = digits.data ();
    const char* last     = first + digits.size ();
    const auto [ptr, ec] = std::from_chars (first, last, port);
    if (ec == std::errc () && ptr == last && port >= kMinPort && port <= kMaxPort) {
        return port;
    }
    // Out of range for a port (or for int): the caller falls back to the scheme
    // default. curl rejects such a URL on its own; the value here only selects
    // the DNS cache entry, so a wrong one must not be fabricated.
    return std::nullopt;
}

/// Dotted-decimal addresses need no resolution and must not be pinned.
/// Only IPv4 reaches here - an IPv6 literal is recognised by its brackets.
bool looks_like_ipv4_literal (std::string_view host) {
    if (host.empty ()) {
        return false;
    }
    bool has_dot = false;
    for (char c : host) {
        if (c == '.') {
            has_dot = true;
        } else if (std::isdigit (static_cast<unsigned char> (c)) == 0) {
            return false;
        }
    }
    return has_dot;
}

} // namespace

UrlAuthority parse_authority (const std::string& url) {
    UrlAuthority authority;
    authority.port = scheme_default_port (url);

    std::string_view rest (url);

    // Strip the scheme, but only when its "://" precedes any path separator -
    // otherwise a path that contains "://" would be mistaken for one.
    const auto scheme_end  = rest.find ("://");
    const auto first_slash = rest.find ('/');
    if (scheme_end != std::string_view::npos &&
    (first_slash == std::string_view::npos || scheme_end < first_slash)) {
        rest.remove_prefix (scheme_end + 3);
    }

    // Everything from the first path/query/fragment delimiter is not authority.
    const auto authority_end = rest.find_first_of ("/?#");
    if (authority_end != std::string_view::npos) {
        rest = rest.substr (0, authority_end);
    }

    // userinfo ("user:pass@") - its colon is not a port separator. Take the
    // last '@' so a userinfo containing one still leaves the host intact.
    const auto at = rest.rfind ('@');
    if (at != std::string_view::npos) {
        rest.remove_prefix (at + 1);
    }

    std::string_view host;
    std::string_view port_digits;

    if (!rest.empty () && rest.front () == '[') {
        // IPv6 literal: the colons inside the brackets belong to the address.
        const auto close = rest.find (']');
        if (close == std::string_view::npos) {
            return authority; // Malformed - no host we could trust.
        }
        host                    = rest.substr (1, close - 1);
        authority.is_ip_literal = true;
        const auto after        = rest.substr (close + 1);
        if (!after.empty ()) {
            if (after.front () != ':') {
                return authority; // Junk after the literal - malformed.
            }
            port_digits = after.substr (1);
        }
    } else {
        const auto colon = rest.find (':');
        if (colon == std::string_view::npos) {
            host = rest;
        } else {
            host        = rest.substr (0, colon);
            port_digits = rest.substr (colon + 1);
        }
        authority.is_ip_literal = looks_like_ipv4_literal (host);
    }

    authority.host = std::string (host);
    if (!port_digits.empty ()) {
        if (const auto port = parse_port (port_digits)) {
            authority.port = *port;
        }
    }
    return authority;
}

std::string extract_hostname (const std::string& url) {
    return parse_authority (url).host;
}

int extract_port (const std::string& url) {
    return parse_authority (url).port;
}

std::optional<Error> validate_transferable (const Request& request) {
    const bool has_body =
    request.body.mode != BodyMode::None && !request.body.content.empty ();
    if (has_body && request.method == HttpMethod::HEAD) {
        Error error;
        error.code = ErrorCode::InvalidMethod;
        error.message =
        "HEAD requests cannot carry a body - remove the body or use GET";
        return error;
    }
    return std::nullopt;
}

Response error_response (const Error& error) {
    Response response;
    response.error_code    = error.code;
    response.error_message = error.message;
    // Synthetic 0 status for client-side errors - give it a friendly phrase.
    response.status_code = 0;
    response.status_text = vayu::http::status_text (0);
    return response;
}

void apply_method_and_body (CURL* curl, const Request& request) {
    const bool has_body =
    request.body.mode != BodyMode::None && !request.body.content.empty ();

    if (has_body) {
        // Setting POSTFIELDS switches curl's method to POST, so it goes first
        // and the method is (re-)asserted below.
        curl_easy_setopt (curl, CURLOPT_POSTFIELDS, request.body.content.c_str ());
        curl_easy_setopt (curl, CURLOPT_POSTFIELDSIZE,
        static_cast<long> (request.body.content.size ()));
    }

    switch (request.method) {
    case HttpMethod::GET:
        // A body-bearing GET (Elasticsearch-style search) keeps its method only
        // via CUSTOMREQUEST; CURLOPT_HTTPGET would drop the body it just set.
        if (has_body) {
            curl_easy_setopt (curl, CURLOPT_CUSTOMREQUEST, "GET");
        } else {
            curl_easy_setopt (curl, CURLOPT_HTTPGET, 1L);
        }
        break;
    case HttpMethod::POST: curl_easy_setopt (curl, CURLOPT_POST, 1L); break;
    case HttpMethod::PUT:
        curl_easy_setopt (curl, CURLOPT_CUSTOMREQUEST, "PUT");
        break;
    case HttpMethod::DELETE:
        curl_easy_setopt (curl, CURLOPT_CUSTOMREQUEST, "DELETE");
        break;
    case HttpMethod::PATCH:
        curl_easy_setopt (curl, CURLOPT_CUSTOMREQUEST, "PATCH");
        break;
    // A body here is refused by validate_transferable, so NOBODY cannot drop one.
    case HttpMethod::HEAD: curl_easy_setopt (curl, CURLOPT_NOBODY, 1L); break;
    case HttpMethod::OPTIONS:
        curl_easy_setopt (curl, CURLOPT_CUSTOMREQUEST, "OPTIONS");
        break;
    }
}

CurlPhaseTimes read_phase_times (CURL* curl) {
    CurlPhaseTimes times;
    curl_easy_getinfo (curl, CURLINFO_TOTAL_TIME, &times.total);
    curl_easy_getinfo (curl, CURLINFO_NAMELOOKUP_TIME, &times.namelookup);
    curl_easy_getinfo (curl, CURLINFO_CONNECT_TIME, &times.connect);
    curl_easy_getinfo (curl, CURLINFO_APPCONNECT_TIME, &times.appconnect);
    curl_easy_getinfo (curl, CURLINFO_STARTTRANSFER_TIME, &times.starttransfer);
    return times;
}

void apply_phase_timings (Timing& timing, const CurlPhaseTimes& times) {
    const double appconnect = times.appconnect > 0.0 ? times.appconnect : times.connect;
    timing.dns_ms = std::max (0.0, times.namelookup * 1000.0);
    timing.connect_ms = std::max (0.0, (times.connect - times.namelookup) * 1000.0);
    timing.tls_ms = std::max (0.0, (appconnect - times.connect) * 1000.0);
    timing.first_byte_ms = std::max (0.0, (times.starttransfer - appconnect) * 1000.0);
    timing.download_ms = std::max (0.0, (times.total - times.starttransfer) * 1000.0);
}

std::optional<Error> add_to_multi (CURLM* multi_handle, CURL* easy) {
    const CURLMcode mc = curl_multi_add_handle (multi_handle, easy);
    if (mc == CURLM_OK) {
        return std::nullopt;
    }
    Error error;
    error.code = ErrorCode::InternalError;
    error.message =
    std::string ("Failed to submit transfer: ") + curl_multi_strerror (mc);
    return error;
}

Error curl_to_error (CURLcode code, const char* error_buffer) {
    Error error;
    error.message = error_buffer[0] ? error_buffer : curl_easy_strerror (code);

    switch (code) {
    case CURLE_OK: error.code = ErrorCode::None; break;
    case CURLE_OPERATION_TIMEDOUT: error.code = ErrorCode::Timeout; break;
    case CURLE_COULDNT_CONNECT:
    case CURLE_COULDNT_RESOLVE_HOST:
    case CURLE_COULDNT_RESOLVE_PROXY:
        error.code = ErrorCode::ConnectionFailed;
        break;
    case CURLE_SSL_CONNECT_ERROR:
    case CURLE_SSL_CERTPROBLEM:
    case CURLE_SSL_CIPHER:
    case CURLE_PEER_FAILED_VERIFICATION:
        error.code = ErrorCode::SslError;
        break;
    case CURLE_URL_MALFORMAT: error.code = ErrorCode::InvalidUrl; break;
    default: error.code = ErrorCode::InternalError; break;
    }

    return error;
}

CURL* setup_easy_handle (CURL* curl, TransferData* data, const EventLoopConfig& config, DnsCache* dns_cache) {
    // Use provided handle or create new one
    if (!curl) {
        curl = curl_easy_init ();
        if (!curl) {
            return nullptr;
        }
    }

    const Request& request = data->request;

    // Set error buffer
    curl_easy_setopt (curl, CURLOPT_ERRORBUFFER, data->error_buffer);

    // Set URL
    curl_easy_setopt (curl, CURLOPT_URL, request.url.c_str ());

    // DNS Pre-resolution: Use cached DNS to bypass system resolver
    // This is critical for high-RPS loads (prevents DNS saturation)
    // An IP-literal URL has nothing to resolve, so it is never pinned - that
    // also keeps a malformed literal out of the cache's blocking lookup path.
    if (dns_cache) {
        const UrlAuthority authority = parse_authority (request.url);
        if (!authority.host.empty () && !authority.is_ip_literal) {
            struct curl_slist* resolve_list = dns_cache->get_resolve_list (
            authority.host, authority.port, config.dns_cache_timeout);
            if (resolve_list) {
                curl_easy_setopt (curl, CURLOPT_RESOLVE, resolve_list);
                data->resolve_list = resolve_list; // Store for cleanup
            }
        }
    }

    // Set method and body (shared with the single-request client - see
    // apply_method_and_body for why the two are set together and in that order)
    apply_method_and_body (curl, request);

    // Bound what one transfer may buffer in memory. write_callback reports the
    // overrun by returning a short count, which curl turns into a failed
    // transfer, so the run sees a normal error completion rather than growing
    // until the daemon is OOM-killed.
    data->max_response_bytes = config.max_response_body_bytes;

    // Set headers
    for (const auto& [key, value] : request.headers) {
        std::string header = key + ": " + value;
        data->headers_list = curl_slist_append (data->headers_list, header.c_str ());
    }

    // Add User-Agent if not set
    bool has_user_agent = request.headers.contains ("User-Agent") ||
    request.headers.contains ("user-agent");
    if (!has_user_agent) {
        std::string ua = "User-Agent: " + config.user_agent;
        data->headers_list = curl_slist_append (data->headers_list, ua.c_str ());
    }

    if (data->headers_list) {
        curl_easy_setopt (curl, CURLOPT_HTTPHEADER, data->headers_list);
    }

    // Set callbacks
    curl_easy_setopt (curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt (curl, CURLOPT_WRITEDATA, data);
    curl_easy_setopt (curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt (curl, CURLOPT_HEADERDATA, data);

    // Progress callback
    if (data->progress) {
        curl_easy_setopt (curl, CURLOPT_XFERINFOFUNCTION, progress_callback);
        curl_easy_setopt (curl, CURLOPT_XFERINFODATA, data);
        curl_easy_setopt (curl, CURLOPT_NOPROGRESS, 0L);
    }

    // Set timeout
    curl_easy_setopt (curl, CURLOPT_TIMEOUT_MS, static_cast<long> (request.timeout_ms));

    // Set redirect options
    if (request.follow_redirects) {
        curl_easy_setopt (curl, CURLOPT_FOLLOWLOCATION, 1L);
        curl_easy_setopt (curl, CURLOPT_MAXREDIRS, static_cast<long> (request.max_redirects));
    }

    // SSL verification
    curl_easy_setopt (curl, CURLOPT_SSL_VERIFYPEER, request.verify_ssl ? 1L : 0L);
    curl_easy_setopt (curl, CURLOPT_SSL_VERIFYHOST, request.verify_ssl ? 2L : 0L);

    // =========================================================================
    // HIGH-PERFORMANCE OPTIMIZATIONS (Phase 1 - Target: 60k RPS)
    // Config values passed via EventLoopConfig for runtime configurability
    // =========================================================================

    // DNS Caching: Cache DNS lookups to avoid resolver saturation
    // This is critical - DNS was causing 84% of errors at 10k RPS
    // Setting to 0 disables caching (resolves every request)
    curl_easy_setopt (curl, CURLOPT_DNS_CACHE_TIMEOUT, config.dns_cache_timeout);

    // TCP Keep-Alive: Reuse connections and detect dead sockets faster
    // Setting idle time to 0 disables keep-alive entirely
    // Using constants directly; these settings require restart to take effect
    long keepalive_idle = vayu::core::constants::event_loop::TCP_KEEPALIVE_IDLE_SECONDS;
    long keepalive_interval = vayu::core::constants::event_loop::TCP_KEEPALIVE_INTERVAL_SECONDS;

    if (keepalive_idle > 0) {
        curl_easy_setopt (curl, CURLOPT_TCP_KEEPALIVE, 1L);
        curl_easy_setopt (curl, CURLOPT_TCP_KEEPIDLE, keepalive_idle);
        curl_easy_setopt (curl, CURLOPT_TCP_KEEPINTVL, keepalive_interval);
    } else {
        // Disable TCP keep-alive when idle time is 0
        curl_easy_setopt (curl, CURLOPT_TCP_KEEPALIVE, 0L);
    }

    // Protocol selection. Until nghttp2 was linked this was a hardcoded
    // CURL_HTTP_VERSION_2TLS that libcurl silently ignored, so every request
    // went out as HTTP/1.1 regardless. It now follows the request's field.
    curl_easy_setopt (curl, CURLOPT_HTTP_VERSION,
    vayu::http::to_curl_http_version (request.http_version));

    // Connection reuse: Don't close connection after request
    curl_easy_setopt (curl, CURLOPT_FORBID_REUSE, 0L);

    // TCP_NODELAY: Disable Nagle's algorithm for lower latency
    curl_easy_setopt (curl, CURLOPT_TCP_NODELAY, 1L);

    // =========================================================================

    // Verbose output for debugging
    if (config.verbose) {
        curl_easy_setopt (curl, CURLOPT_VERBOSE, 1L);
        curl_easy_setopt (curl, CURLOPT_DEBUGFUNCTION, debug_callback);
    }

    // Proxy
    if (!config.proxy_url.empty ()) {
        curl_easy_setopt (curl, CURLOPT_PROXY, config.proxy_url.c_str ());
    }

    // Store private data pointer
    curl_easy_setopt (curl, CURLOPT_PRIVATE, data);

    return curl;
}

Result<Response> extract_response (CURL* curl, TransferData* data, CURLcode result) {
    Response& response = data->response;

    // Everything curl measured is read before the error branch: a failed
    // transfer still connected, still sent bytes, and still spent time doing
    // it. Returning early here used to zero all of that, which dropped failed
    // requests out of the throughput metrics and left load_strategy's
    // "errors sometimes carry timing" branch permanently dead. The
    // single-request client has always extracted first for this reason.
    const CurlPhaseTimes phase_times = read_phase_times (curl);
    const double wire_seconds        = phase_times.total;

    // Negotiated protocol - what actually got used, not what was requested.
    // Empty when curl reports CURL_HTTP_VERSION_NONE or anything this driver
    // doesn't recognize; see http_version_from_curl for why that's not
    // coerced into a guessed "HTTP/1.1".
    long negotiated_version = 0;
    curl_easy_getinfo (curl, CURLINFO_HTTP_VERSION, &negotiated_version);
    response.http_version = vayu::http::http_version_from_curl (negotiated_version);

    // Same question the single-request driver asks, through the same helper -
    // the load path is where an unnoticed downgrade does the most damage, since
    // its whole output is numbers attributed to a protocol. No log line here,
    // unlike client.cpp: this runs once per transfer, and a run that downgrades
    // downgrades every one of them. The flag rides out on each trace instead.
    response.http_version_downgraded =
    vayu::http::http_version_downgraded (data->request.http_version, response.http_version);

    // Get curl timing info - these are wire-only (libcurl's view)
    // Perceived latency: wall-clock from submit() to now. steady_clock is
    // monotonic so it's not affected by NTP jumps.
    auto completion = std::chrono::steady_clock::now ();
    double perceived_ms = std::chrono::duration<double, std::milli> (
        completion - data->submitted_at).count ();

    double wire_ms = wire_seconds * 1000.0;
    // Clamp queue_wait to >= 0 to absorb sub-microsecond clock jitter where
    // perceived_ms can appear marginally smaller than wire_ms. A discrepancy
    // larger than 1ms indicates a real problem (wrong stamp point, clock
    // skew between steady_clock and curl's TOTAL_TIME, etc.) - debug builds
    // trip an assert; release builds log a warning so the signal isn't lost
    // silently in the clamp. Without this, a future regression that moves
    // `submitted_at` later in the pipeline would zero out queue_wait_ms in
    // production while CI stays green.
    double delta = perceived_ms - wire_ms;
    assert (delta > -1.0 && "perceived_ms - wire_ms below -1ms - clock issue?");
    if (delta < -1.0) {
        vayu::utils::log_warning (
        "queue_wait clock skew: perceived_ms=" + std::to_string (perceived_ms) +
        " wire_ms=" + std::to_string (wire_ms) +
        " delta_ms=" + std::to_string (delta) +
        " - submitted_at stamp may be set after curl wire start");
    }
    double queue_wait_ms = std::max (0.0, delta);

    response.timing.total_ms      = perceived_ms;        // redefined as perceived
    response.timing.wire_ms       = wire_ms;             // new
    response.timing.queue_wait_ms = queue_wait_ms;       // new
    apply_phase_timings (response.timing, phase_times);

    // Wire byte counts (body + headers), for throughput-in-bytes metrics.
    curl_off_t dl_bytes = 0, ul_bytes = 0;
    long header_bytes = 0, request_bytes = 0;
    curl_easy_getinfo (curl, CURLINFO_SIZE_DOWNLOAD_T, &dl_bytes);
    curl_easy_getinfo (curl, CURLINFO_SIZE_UPLOAD_T, &ul_bytes);
    curl_easy_getinfo (curl, CURLINFO_HEADER_SIZE, &header_bytes);
    curl_easy_getinfo (curl, CURLINFO_REQUEST_SIZE, &request_bytes);
    response.timing.bytes_down =
        static_cast<size_t> (std::max<curl_off_t> (0, dl_bytes)) +
        static_cast<size_t> (std::max<long> (0, header_bytes));
    response.timing.bytes_up =
        static_cast<size_t> (std::max<curl_off_t> (0, ul_bytes)) +
        static_cast<size_t> (std::max<long> (0, request_bytes));

    // Set body. On a failed transfer this is whatever arrived before the
    // failure, which is also the truncated prefix when the body cap tripped.
    response.body      = std::move (data->response_body);
    response.body_size = response.body.size ();

    if (result != CURLE_OK) {
        // Not returned as an Error: the load strategy processes this as a
        // "failed response" rather than an "unexpected error".
        const Error error      = data->body_limit_exceeded ?
             Error{ ErrorCode::InternalError,
            "Response body exceeded the " + std::to_string (data->max_response_bytes) +
            " byte cap (maxResponseBodyBytes)" } :
             curl_to_error (result, data->error_buffer);
        response.error_code    = error.code;
        response.error_message = error.message;
        response.status_code   = 0;
        response.status_text   = vayu::http::status_text (0);
        return response;
    }

    // Get response info
    long http_code = 0;
    curl_easy_getinfo (curl, CURLINFO_RESPONSE_CODE, &http_code);
    response.status_code = static_cast<int> (http_code);
    // header_callback captures the wire reason phrase. Only fall back to
    // the code→phrase lookup when the server (or HTTP/2+ stack) didn't
    // supply one.
    if (response.status_text.empty ()) {
        response.status_text = vayu::http::status_text (response.status_code);
    }

    return response;
}

} // namespace vayu::http::detail
