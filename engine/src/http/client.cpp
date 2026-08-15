/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/client.cpp
 * @brief HTTP client implementation using libcurl
 */

#ifdef _WIN32
#include <windows.h>
#include <winsock2.h>
// Windows headers define DELETE macro which conflicts with HttpMethod::DELETE
#ifdef DELETE
#undef DELETE
#endif
#endif

#include "vayu/http/client.hpp"
#include "vayu/http/curl_version_map.hpp"
#include "vayu/http/debug_redact.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/status.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"

namespace vayu::http {

// ============================================================================
// Helper Functions
// ============================================================================

namespace {

/**
 * @brief What a transfer's debug stream leaves behind for the caller.
 *
 * `verbose` gates the *logging* only - the outbound header frame is captured on
 * every send, because the raw-request view is built from it (issue #339). Since
 * the cookie jar, libcurl synthesizes headers we never composed (`Cookie`, from
 * CURLOPT_COOKIELIST), so the composed header map no longer describes what went
 * on the wire and only libcurl can say what did.
 *
 * The captured frame is deliberately **not** redacted. It backs the raw-request
 * view, which exists to show exactly what was sent and whose values the user can
 * already read in Settings; the verbose log below keeps its redaction because
 * logs get exported and shared. Two surfaces, two audiences, two policies.
 */
struct TransferDebug {
    bool verbose = false;
    /// The last CURLINFO_HEADER_OUT frame, verbatim. Last, not first, so a
    /// followed redirect reports the request that produced the response the
    /// caller is looking at.
    std::string last_header_out;
};

int debug_callback (CURL* handle, curl_infotype type, char* data, size_t size, void* userptr) {
    (void)handle;
    auto* debug = static_cast<TransferDebug*> (userptr);

    if (debug != nullptr && type == CURLINFO_HEADER_OUT) {
        debug->last_header_out.assign (data, size);
    }
    // Nothing else to do when the caller only wanted the capture: the frames
    // below are logging, and DATA_OUT can be a whole request body.
    if (debug == nullptr || !debug->verbose) {
        return 0;
    }

    std::string text (data, size);
    // Remove trailing newlines
    while (!text.empty () && (text.back () == '\n' || text.back () == '\r')) {
        text.pop_back ();
    }

    switch (type) {
    case CURLINFO_TEXT: vayu::utils::log_debug ("* " + text); break;
    case CURLINFO_HEADER_OUT:
        vayu::utils::log_debug ("> " + vayu::http::detail::redact_header_line (text));
        break;
    case CURLINFO_HEADER_IN:
        vayu::utils::log_debug ("< " + vayu::http::detail::redact_header_line (text));
        break;
    default: break;
    }
    return 0;
}

/**
 * @brief Callback for writing response body
 */
size_t write_callback (char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* response_body = static_cast<std::string*> (userdata);
    size_t total_size   = size * nmemb;
    response_body->append (ptr, total_size);
    return total_size;
}

/**
 * @brief Callback for writing response headers.
 *
 * Captures BOTH:
 *  - the reason phrase from the status line ("HTTP/1.1 404 Not Found"
 *    → "Not Found"), preserving server-custom phrases like Cloudflare's
 *    "404 Object Not Found" or GitHub's "422 Unprocessable Entity";
 *  - subsequent "Key: Value" header lines.
 *
 * HTTP/2 and HTTP/3 don't carry reason phrases on the wire - the status
 * line is just "HTTP/2 200". In that case status_text is cleared and the
 * caller falls back to its code→phrase lookup.
 *
 * On followed redirects, curl emits one status block per hop in order,
 * so overwriting each time leaves status_text reflecting the final hop.
 *
 * A header name that arrives more than once in the same block keeps every
 * value, folded with ", " - see ingest_header_line for why.
 */
size_t header_callback (char* buffer, size_t size, size_t nitems, void* userdata) {
    auto* response    = static_cast<Response*> (userdata);
    size_t total_size = size * nitems;

    std::string line (buffer, total_size);

    // Remove trailing \r\n
    while (!line.empty () && (line.back () == '\r' || line.back () == '\n')) {
        line.pop_back ();
    }

    if (line.empty ()) {
        return total_size;
    }

    // Status line: "HTTP/<version> <code> [<reason phrase>]"
    if (line.starts_with ("HTTP/")) {
        auto first_space = line.find (' ');
        if (first_space != std::string::npos) {
            auto second_space = line.find (' ', first_space + 1);
            if (second_space != std::string::npos && second_space + 1 < line.size ()) {
                response->status_text = line.substr (second_space + 1);
            } else {
                // No reason phrase (HTTP/2+) - let the caller fall back to a lookup.
                response->status_text.clear ();
            }
        }
        // Also clear headers between redirect hops so we don't accumulate them.
        response->headers.clear ();
        return total_size;
    }

    // Parse header: "Key: Value". A repeated name folds rather than replaces -
    // see ingest_header_line.
    vayu::http::detail::ingest_header_line (line, response->headers);

    return total_size;
}

/**
 * @brief The raw-request view, built from the header block libcurl actually sent.
 *
 * @p header_frame is a whole CURLINFO_HEADER_OUT frame - request line included,
 * terminated by its own blank line - so the body is all that has to be added.
 * Being the wire's own bytes, it carries what libcurl added on our behalf
 * (`Cookie` from the jar, `Accept`, `Content-Length`, and the h2 pseudo-headers
 * rendered in HTTP/1 form) rather than what we composed and hoped matched.
 *
 * The terminator is re-normalized rather than trusted: whether a frame ends in
 * one CRLF or two is libcurl's business, and the body must not run into the
 * last header line.
 */
std::string raw_request_from_wire (std::string header_frame, const std::string& body) {
    while (!header_frame.empty () &&
    (header_frame.back () == '\r' || header_frame.back () == '\n')) {
        header_frame.pop_back ();
    }
    header_frame += "\r\n\r\n";
    header_frame += body;
    return header_frame;
}

/**
 * @brief The raw-request view when there is no wire to read it off.
 *
 * The fallback for a transfer that failed before libcurl sent anything - DNS
 * failure, connection refused, a timeout during connect. Synthesized from the
 * composed request, which is what this view was built from throughout before
 * #339, so an unreachable host still shows the request that was attempted.
 */
std::string synthesize_raw_request (const Request& request, const Response& response) {
    std::stringstream raw_req;

    // Parse URL to extract host and path
    std::string host;
    std::string path = "/";
    std::string url  = request.url;

    // Remove protocol prefix
    size_t proto_end = url.find ("://");
    if (proto_end != std::string::npos) {
        url = url.substr (proto_end + 3);
    }

    // Split host and path
    size_t path_start = url.find ('/');
    if (path_start != std::string::npos) {
        host = url.substr (0, path_start);
        path = url.substr (path_start);
    } else {
        host = url;
        // Check for query string without path
        size_t query_start = host.find ('?');
        if (query_start != std::string::npos) {
            path = "/" + host.substr (query_start);
            host = host.substr (0, query_start);
        }
    }

    // Request line: METHOD /path <version>. Normally the negotiated version.
    // When nothing was negotiated (connection refused, DNS failure) this line
    // still has to read as syntactically valid HTTP, so it cannot be blank the
    // way response.http_version is - but it falls back to what was *requested*
    // rather than a flat HTTP/1.1. Printing HTTP/1.1 after the user asked for
    // http2 and never reached a server would contradict both their intent and
    // the outcome, which is the kind of confident wrong answer this whole task
    // exists to remove. The fallback never reaches response.http_version.
    std::string display_version = response.http_version;
    if (display_version.empty ()) {
        display_version =
        request.http_version == HttpVersion::Http2 ? "HTTP/2" : "HTTP/1.1";
    }
    raw_req << to_string (request.method) << " " << path << " " << display_version << "\r\n";

    // Host header (required for HTTP/1.1)
    raw_req << "Host: " << host << "\r\n";

    // Add all request headers
    for (const auto& [key, value] : response.request_headers) {
        // Skip if it's a Host header (we already added it)
        if (key == "Host" || key == "host")
            continue;
        raw_req << key << ": " << value << "\r\n";
    }

    // The bytes the transfer would have carried, not `body.content` - for a
    // form or graphql body those are two different strings, and a view that
    // showed the second would describe a request nothing ever sent.
    const std::string body = vayu::http::wire_body_bytes (request.body);

    // Add Content-Length for body
    if (!body.empty ()) {
        raw_req << "Content-Length: " << body.size () << "\r\n";
    }

    // End of headers
    raw_req << "\r\n";

    // Body
    if (!body.empty ()) {
        raw_req << body;
    }

    return raw_req.str ();
}

/**
 * @brief Convert curl error code to our ErrorCode
 */
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

} // namespace

// ============================================================================
// Client Implementation
// ============================================================================

struct Client::Impl {
    CURL* curl = nullptr;
    ClientConfig config;
    char error_buffer[CURL_ERROR_SIZE] = { 0 };

    explicit Impl (ClientConfig cfg) : config (std::move (cfg)) {
        curl = curl_easy_init ();
        if (!curl) {
            throw std::runtime_error ("Failed to initialize curl");
        }
    }

    ~Impl () {
        if (curl) {
            curl_easy_cleanup (curl);
        }
    }

    void reset () {
        curl_easy_reset (curl);
        std::memset (error_buffer, 0, sizeof (error_buffer));
    }
};

Client::Client (ClientConfig config)
: impl_ (std::make_unique<Impl> (std::move (config))) {
}

Client::~Client () = default;

Client::Client (Client&&) noexcept            = default;
Client& Client::operator= (Client&&) noexcept = default;

Result<Response> Client::send (const Request& request) {
    // Same gate as the event loop's: a request curl cannot send as written is
    // refused rather than silently sent as something else. Reported as a
    // status-0 response, not an Error, because send() never returns an Error -
    // every caller (including /execute, which calls .value() unguarded) reads
    // the failure off the response.
    if (auto invalid = detail::validate_transferable (request)) {
        Response refused        = detail::error_response (*invalid);
        refused.request_headers = request.headers;
        return refused;
    }

    impl_->reset ();
    CURL* curl = impl_->curl;

    // Response data
    Response response;
    std::string response_body;

    // `request_headers` is the *sent* record and is filled by
    // build_request_header_list below, from the very appends that build the
    // slist - see its contract for why it is not snapshotted here.

    // Set error buffer
    curl_easy_setopt (curl, CURLOPT_ERRORBUFFER, impl_->error_buffer);

    // Set URL
    curl_easy_setopt (curl, CURLOPT_URL, request.url.c_str ());

    // Set method and body (shared with the event loop path so the two cannot
    // disagree about what goes on the wire - see apply_method_and_body)
    curl_mime* mime = detail::apply_method_and_body (curl, request);

    // Set headers, and record the same set as what was sent.
    struct curl_slist* headers_list = detail::build_request_header_list (
    request, impl_->config.user_agent, &response.request_headers);

    if (headers_list) {
        curl_easy_setopt (curl, CURLOPT_HTTPHEADER, headers_list);
    }

    // rawRequest is read off the wire, so it can only be built after the
    // transfer completes - see below, just before the error-path early return.

    // Set callbacks
    curl_easy_setopt (curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt (curl, CURLOPT_WRITEDATA, &response_body);
    curl_easy_setopt (curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt (curl, CURLOPT_HEADERDATA, &response);

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

    // Protocol selection. This path (POST /execute, "Send") previously set no
    // CURLOPT_HTTP_VERSION at all and ran at libcurl's implicit default -
    // the same NONE value Auto maps to, but not by anything that named the
    // request's field, so a Send and a load test of the same request had no
    // structural guarantee of agreeing. Both drivers now go through the one
    // shared mapping.
    curl_easy_setopt (curl, CURLOPT_HTTP_VERSION,
    vayu::http::to_curl_http_version (request.http_version));

    // The debug stream is always on, verbose or not: the raw-request view is
    // built from the outbound header frame it carries, which is the only place
    // libcurl's own additions (jar cookies above all) can be read from. The
    // config flag decides whether the frames are also logged - see TransferDebug.
    TransferDebug transfer_debug;
    transfer_debug.verbose = impl_->config.verbose;
    curl_easy_setopt (curl, CURLOPT_VERBOSE, 1L);
    curl_easy_setopt (curl, CURLOPT_DEBUGFUNCTION, debug_callback);
    curl_easy_setopt (curl, CURLOPT_DEBUGDATA, &transfer_debug);

    // Proxy
    if (!impl_->config.proxy_url.empty ()) {
        curl_easy_setopt (curl, CURLOPT_PROXY, impl_->config.proxy_url.c_str ());
    }

    // Cookie jar (issue #301) - only when a caller opted in; see
    // ClientConfig::cookie_jar.
    if (impl_->config.cookie_jar) {
        detail::apply_jar_cookies (curl, *impl_->config.cookie_jar,
        impl_->config.cookie_scope, impl_->config.cookie_writes);
    }

    // Perform the request. Stamp submission just before perform so that
    // perceived latency excludes our own setup cost above but covers everything
    // libcurl does on this thread. For single-shot sends there is no generator
    // queue, so queue_wait_ms will be near zero - that's the correct contract.
    auto submitted_at = std::chrono::steady_clock::now ();
    CURLcode res = curl_easy_perform (curl);
    auto completion = std::chrono::steady_clock::now ();

    // Cleanup headers and the multipart body, both of which had to outlive the
    // transfer that just finished.
    if (headers_list) {
        curl_slist_free_all (headers_list);
    }
    if (mime) {
        curl_mime_free (mime);
    }

    // Before any error return below: a failed transfer can still have
    // collected cookies - see capture_jar_cookies.
    if (impl_->config.cookie_jar) {
        detail::capture_jar_cookies (curl, *impl_->config.cookie_jar,
        impl_->config.cookie_scope);
    }

    // Get timing info (try to get even on errors, as curl may have partial timing)
    const detail::CurlPhaseTimes phase_times = detail::read_phase_times (curl);

    // Match the event-loop semantics: total_ms is perceived (submit→completion),
    // wire_ms is libcurl's view, queue_wait_ms is the delta. See curl_utils.cpp.
    double perceived_ms = std::chrono::duration<double, std::milli> (
        completion - submitted_at).count ();
    double wire_ms = phase_times.total * 1000.0;

    response.timing.total_ms      = perceived_ms;
    response.timing.wire_ms       = wire_ms;
    response.timing.queue_wait_ms = std::max (0.0, perceived_ms - wire_ms);
    // Per-phase durations, clamped and TLS-collapsed by the shared helper -
    // the event loop had drifted from this code and rendered negative TLS ms.
    detail::apply_phase_timings (response.timing, phase_times);

    // Negotiated protocol (try to get even on errors, same as timing above -
    // a transfer that fails after the connection was established still knows
    // what it negotiated). Empty when nothing was negotiated at all, e.g. a
    // connection that never reached a server - see http_version_from_curl.
    long negotiated_version = 0;
    curl_easy_getinfo (curl, CURLINFO_HTTP_VERSION, &negotiated_version);
    response.http_version = vayu::http::http_version_from_curl (negotiated_version);
    response.http_version_downgraded =
    vayu::http::http_version_downgraded (request.http_version, response.http_version);
    if (response.http_version_downgraded) {
        // A cleartext URL is the one downgrade with an answer, so the line says
        // it rather than leaving the reader to wonder whether the engine is
        // broken: CURL_HTTP_VERSION_2TLS offers h2 over TLS only, so an
        // `http://` request never attempts it. Naming that is why this is one
        // message with a suffix and not two call sites.
        const bool cleartext = request.url.rfind ("http://", 0) == 0;
        vayu::utils::log_warning ("HTTP/2 was requested but the connection negotiated " +
        response.http_version + " - " + request.url +
        (cleartext ? " (h2 is not offered over cleartext; use https:// or set the "
                     "protocol to auto)" :
                     ""));
    }

    // The raw-request view: what libcurl put on the wire, read off the last
    // outbound header frame it handed the debug callback. Built here rather
    // than before the transfer because there is nothing to read until the
    // transfer has run - and because only the wire knows about the headers
    // libcurl adds itself, which since the cookie jar includes `Cookie`
    // (issue #339). A transfer that never sent anything has no frame; it falls
    // back to the composed request, which is all that ever existed for it.
    response.raw_request = transfer_debug.last_header_out.empty () ?
    synthesize_raw_request (request, response) :
    raw_request_from_wire (transfer_debug.last_header_out,
    vayu::http::wire_body_bytes (request.body));

    // Check for errors
    if (res != CURLE_OK) {
        // Convert curl error to ErrorCode and message
        Error error = curl_to_error (res, impl_->error_buffer);

        // Return Response object with error details (Postman-compatible approach)
        response.status_code = 0; // 0 indicates client-side error (no server response)
        response.status_text = vayu::http::status_text (0);
        response.error_code    = error.code;
        response.error_message = error.message;
        // raw_request is already populated above
        // headers and body remain empty (no server response)
        // timing info is already set above

        return response;
    }

    // Get response info for successful requests
    long http_code = 0;
    curl_easy_getinfo (curl, CURLINFO_RESPONSE_CODE, &http_code);
    response.status_code = static_cast<int> (http_code);
    // Prefer the wire reason phrase captured by header_callback. Only fall
    // back to the code→phrase lookup when the server (or HTTP/2+ stack)
    // didn't supply one.
    if (response.status_text.empty ()) {
        response.status_text = vayu::http::status_text (response.status_code);
    }
    response.error_code = ErrorCode::None; // Explicitly set to None for successful requests

    // Set body
    response.body      = std::move (response_body);
    response.body_size = response.body.size ();

    return response;
}

Result<Response> Client::get (const std::string& url, const Headers& headers) {
    Request request;
    request.method  = HttpMethod::GET;
    request.url     = url;
    request.headers = headers;
    return send (request);
}

Result<Response>
Client::post (const std::string& url, const std::string& body, const Headers& headers) {
    Request request;
    request.method       = HttpMethod::POST;
    request.url          = url;
    request.body.mode    = BodyMode::Text;
    request.body.content = body;
    request.headers      = headers;
    return send (request);
}

std::string Client::last_error () const {
    return impl_->error_buffer;
}

// ============================================================================
// Global Functions
// ============================================================================

void global_init () {
    curl_global_init (CURL_GLOBAL_ALL);
}

void global_cleanup () {
    curl_global_cleanup ();
}

} // namespace vayu::http
