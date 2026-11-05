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

#include "vayu/core/constants.hpp"
#include "vayu/core/query_encoding.hpp"
#include "vayu/core/vayu_extensions.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/curl_error_buffer.hpp"
#include "vayu/http/curl_options.hpp"
#include "vayu/http/curl_version_map.hpp"
#include "vayu/http/debug_redact.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/file_ref.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/redirect_policy.hpp"
#include "vayu/http/status.hpp"
#include "vayu/http/url_parts.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <expected>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/parse.hpp"
#include "vayu/version.hpp"

namespace vayu::http {

// ============================================================================
// Helper Functions
// ============================================================================

namespace {

/**
 * @brief What a transfer's debug stream leaves behind for the caller.
 *
 * The outbound header frame is captured on every send regardless of log
 * level, because the raw-request view is built from it (issue #339). Since
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
    /// The last CURLINFO_HEADER_OUT frame, verbatim. Last, not first, so a
    /// followed redirect reports the request that produced the response the
    /// caller is looking at.
    std::string last_header_out;
    /// The redacted, per-line collector for the one `cat=client` record this
    /// transfer emits (issue #1557) - empty when verbosity never reached 2.
    std::vector<std::string> debug_lines;
    /// `Request::secret_header_names`, redacted beyond the shared field list.
    std::vector<std::string> secret_header_names;
};

int debug_callback (CURL* handle, curl_infotype type, char* data, size_t size, void* userptr) {
    (void)handle;
    auto* debug = static_cast<TransferDebug*> (userptr);

    if (debug != nullptr && type == CURLINFO_HEADER_OUT) {
        debug->last_header_out.assign (data, size);
    }
    // Nothing else to do when the caller only wanted the capture: the frames
    // below are logging, and DATA_OUT can be a whole request body. Gated on
    // the logger's own level (issue #1510), not a bool threaded down from the
    // daemon's `-v` flag through `Server`/`RouteContext`/`execute_exchange` -
    // `-v 2` is what these frames have always meant "debug" as.
    if (debug == nullptr || vayu::utils::Logger::instance ().get_verbosity () < 2) {
        return 0;
    }

    vayu::http::detail::collect_debug_frame (debug->debug_lines, type,
    std::string_view (data, size), debug->secret_header_names);
    return 0;
}

/// Emits @p debug's collected lines as one `cat=client` record, if verbosity
/// ever reached 2 for this transfer. Called once, after the transfer this
/// `TransferDebug` was set up for has finished.
void flush_transfer_debug (TransferDebug& debug) {
    if (debug.debug_lines.empty ()) {
        return;
    }
    nlohmann::json fields;
    fields["lines"] = debug.debug_lines;
    vayu::utils::log_debug ("client", "curl exchange", fields);
}

/**
 * @brief What one transfer buffers, and the bound it may not pass (issue #784).
 */
struct BodySink {
    std::string body;
    /// Largest body this transfer may buffer, 0 = unbounded - copied from
    /// `ClientConfig::max_response_bytes`.
    size_t max_bytes = 0;
    /// Set by write_callback when it refused to buffer more, so the completion
    /// can name the bound instead of reporting curl's generic write failure.
    bool limit_exceeded = false;
    /// Where to report the arrival, or null to report nothing (issue #882).
    /// Points at `ClientConfig::on_body_progress`, which outlives the transfer.
    const BodyProgressCallback* on_progress = nullptr;
    /// The headers collected so far, for the declared length. A pointer rather
    /// than a copy because the header callback is still filling them: the whole
    /// block has arrived by the time the first body byte does, but not before
    /// the sink is built.
    const Headers* headers = nullptr;
    /// The upstream's `Content-Length`, read off `headers` on the first write
    /// and kept. Resolved once because the answer cannot change mid-transfer and
    /// re-scanning the header list per 16 KiB chunk would be work for nothing.
    std::optional<uint64_t> declared_total;
    bool total_resolved = false;
    /// Set by header_callback for a redirect the send will follow, whose body
    /// is neither kept nor held to the bound (#3300).
    bool discard = false;

    /// Ready for the next hop of a chain: what the last one wrote is gone.
    void start_hop () {
        body.clear ();
        limit_exceeded = false;
        declared_total.reset ();
        total_resolved = false;
        discard        = false;
    }
};

/// The flag a cancellable transfer watches (`ClientConfig::cancel`, issue
/// #2683), and whether the progress callback acted on it.
struct CancelWatch {
    const std::atomic<bool>* flag = nullptr;
    /// Set when the callback aborted, so the completion reports a cancel rather
    /// than libcurl's generic `CURLE_ABORTED_BY_CALLBACK`, which the
    /// reserved-port refusal also raises.
    bool fired = false;
};

int cancel_progress_callback (void* clientp, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    auto* watch = static_cast<CancelWatch*> (clientp);
    if (!watch->flag->load (std::memory_order_acquire)) {
        return 0;
    }
    watch->fired = true;
    return 1; // Non-zero aborts with CURLE_ABORTED_BY_CALLBACK.
}

/// Forward declaration: the write callback below resolves the declared length,
/// which is defined after it because it belongs beside the message that names
/// the same number.
std::optional<unsigned long long> declared_content_length (const Headers& headers);

/**
 * @brief Callback for writing response body, bounded by the sink's cap.
 *
 * The same short-count refusal the load loop's callback uses
 * (`curl_callbacks.cpp`): keep the prefix that fits, then hand curl fewer bytes
 * than it offered, which fails the transfer. That is what makes the bound a
 * bound on what is *read* rather than a check run after a whole hostile
 * response has already been buffered.
 *
 * Deliberately the only enforcement, rather than a belt to `CURLOPT_MAXFILESIZE`:
 * curl 8.21 refuses an over-bound `Content-Length` at header time *and* aborts a
 * length-less transfer that grows past the value, so setting both left whichever
 * fired first deciding how the failure was reported - and one of the two branches
 * dead in every case. This one is version-independent and is the idiom the engine
 * already enforces a body cap with.
 */
size_t write_callback (char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* sink        = static_cast<BodySink*> (userdata);
    size_t total_size = size * nmemb;

    if (sink->discard) {
        return total_size;
    }

    if (sink->max_bytes > 0) {
        const size_t remaining =
        sink->max_bytes - std::min (sink->max_bytes, sink->body.size ());
        if (total_size > remaining) {
            sink->body.append (ptr, remaining);
            sink->limit_exceeded = true;
            return remaining; // Short count: abort with CURLE_WRITE_ERROR.
        }
    }

    sink->body.append (ptr, total_size);

    // Reported after the append, so `received` is the body a reader would see
    // and not the one that is about to exist. A refusal is a short count for
    // the same reason the bound's is - it is the only way to stop curl from
    // inside the callback - and the transfer surfaces as curl's generic write
    // failure, which is the honest outcome: the only party who could be told
    // anything more specific is the one that just said it had stopped
    // listening.
    if (sink->on_progress != nullptr && *sink->on_progress) {
        if (!sink->total_resolved) {
            sink->total_resolved = true;
            if (sink->headers != nullptr) {
                if (const auto declared = declared_content_length (*sink->headers)) {
                    sink->declared_total = static_cast<uint64_t> (*declared);
                }
            }
        }
        if (!(*sink->on_progress) (
            static_cast<uint64_t> (sink->body.size ()), sink->declared_total)) {
            return 0; // Short count: abort with CURLE_WRITE_ERROR.
        }
    }

    return total_size;
}

/**
 * @brief The size the server declared for this response, if it declared one.
 *
 * Read off the headers the header callback already collected rather than from
 * `CURLINFO_CONTENT_LENGTH_DOWNLOAD_T`: a transfer aborted at the bound never
 * finished, and libcurl's progress info for one that did not run is `-1`
 * whether the server declared a length or not. The header block is there
 * either way, because headers arrive before the first byte of body.
 */
std::optional<unsigned long long> declared_content_length (const Headers& headers) {
    // `Headers` orders by `CaseInsensitiveLess`, so this lookup already answers
    // every casing the wire can spell the name in, and the map holds one value
    // per name - there is no second `content-length` for a first-match rule to
    // choose between.
    const auto declaration = headers.find ("content-length");
    if (declaration == headers.end ()) {
        return std::nullopt;
    }
    const std::string& value = declaration->second;
    try {
        size_t consumed                   = 0;
        const unsigned long long declared = std::stoull (value, &consumed);
        // A trailing-garbage or empty value is no declaration at all; the
        // caller says so rather than reporting a number the server did not.
        return consumed == value.size () ? std::optional{ declared } : std::nullopt;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

/**
 * @brief Why a bounded transfer was refused, in the terms the caller set it.
 *
 * Names the count when there is an honest one to name - the length the server
 * declared - and says so plainly when there is not, because a body cut off at
 * the bound is only known to be *at least* that large and reporting the bound
 * as the size would be a measurement the engine never made.
 */
std::string too_large_message (const Headers& headers, size_t max_bytes) {
    const std::string bound = std::to_string (max_bytes) + " byte limit";
    const auto declared     = declared_content_length (headers);
    if (declared && *declared > max_bytes) {
        return "Response is " + std::to_string (*declared) + " bytes, over the " + bound;
    }
    // No claim about the header here: this branch also covers a server whose
    // declared length was under the bound and whose body was not.
    return "Response grew past the " + bound + " and the transfer was cut off there";
}

/// What `header_callback` writes into: the response, and the state it needs to
/// tell one status block from the next.
struct HeaderSink {
    Response* response = nullptr;
    /// Whether the send follows redirects, so a redirect's body is discarded.
    bool following = false;
    /// Numeric status of the block being read, 0 before the first one.
    int block_status = 0;
    /// The body sink a redirect's body is kept out of.
    BodySink* body = nullptr;
};

/// libcurl's current request URL, copied because the buffer is only valid until
/// the next call into the handle; empty when libcurl reports none.
std::string effective_url (CURL* curl) {
    char* url = nullptr;
    if (get_info<CURLINFO_EFFECTIVE_URL> (curl, &url) != CURLE_OK || url == nullptr) {
        return {};
    }
    return url;
}

/// The names a request's auth-written query parameter can appear under in a
/// URL: as typed, and as `append_query_param` percent-encodes it.
std::vector<std::string> auth_param_names (const Request& request) {
    if (request.auth_query_param.empty ()) {
        return {};
    }
    std::vector<std::string> names{ request.auth_query_param };
    auto encoded = vayu::core::encode_query_component (
    request.auth_query_param, vayu::core::QueryPart::Key);
    if (encoded != names.front ()) {
        names.push_back (std::move (encoded));
    }
    return names;
}

/// The numeric code of "HTTP/<version> <code> [<reason phrase>]", or nullopt
/// when the line carries none.
std::optional<int> status_line_code (std::string_view line) {
    const size_t first_space = line.find (' ');
    if (first_space == std::string_view::npos) {
        return std::nullopt;
    }
    const std::string_view rest = line.substr (first_space + 1);
    return vayu::utils::parse_number<int> (rest.substr (0, rest.find (' ')));
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
 * One transfer can still emit more than one block: a 1xx interim response
 * (`100 Continue`) and the 2xx a proxy `CONNECT` answers with precede the
 * response, so each status line starts the record over and the last block is
 * the one kept. A redirect hop is a transfer of its own, recorded by the
 * chain (`record_hop`).
 *
 * A header name that arrives more than once in the same block keeps every
 * value, folded with ", " - see ingest_header_line for why. The lossless list
 * `Response::header_lines` is filled beside the map (issue #2460).
 */
size_t header_callback (char* buffer, size_t size, size_t nitems, void* userdata) {
    auto* sink         = static_cast<HeaderSink*> (userdata);
    Response* response = sink->response;
    size_t total_size  = size * nitems;

    std::string line (buffer, total_size);

    // Remove trailing \r\n
    while (!line.empty () && (line.back () == '\r' || line.back () == '\n')) {
        line.pop_back ();
    }

    if (line.empty ()) {
        // The block is complete: a redirect the chain will follow has a body
        // nobody reads, which is not kept and not held to the bound.
        sink->body->discard = sink->following &&
        is_redirect_status (sink->block_status) &&
        location_of (response->header_lines).has_value ();
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
        sink->block_status = status_line_code (line).value_or (0);
        response->headers.clear ();
        response->header_lines.clear ();
        return total_size;
    }

    // Parse header: "Key: Value". A repeated name folds rather than replaces -
    // see ingest_header_line.
    vayu::http::detail::ingest_header_line (line, response->headers, &response->header_lines);

    return total_size;
}

/**
 * @brief The body the raw-request view shows: the wire bytes, or for a binary
 * body the file's placeholder (`<file a.bin, 1234 bytes>`) - a view never
 * carries a file's contents, however small.
 */
std::string raw_view_body (const Request& request) {
    if (request.body.mode == BodyMode::Binary && vayu::http::has_wire_body (request)) {
        return vayu::http::body_file_placeholder (request.body.file);
    }
    return vayu::http::wire_body_bytes (request);
}

/// @p text without the spaces and tabs around it (an HTTP field value's
/// optional whitespace).
std::string_view trim_field_whitespace (std::string_view text) {
    constexpr std::string_view WHITESPACE = " \t";
    const size_t first                    = text.find_first_not_of (WHITESPACE);
    if (first == std::string_view::npos) {
        return {};
    }
    return text.substr (first, text.find_last_not_of (WHITESPACE) - first + 1);
}

/// Whether one header line says a body follows: `Content-Length` above zero or
/// `Transfer-Encoding` naming `chunked`. Names compare case-insensitively.
bool header_declares_body (std::string_view name, std::string_view value) {
    if (vayu::utils::ascii_lower_equal (name, "content-length")) {
        const auto length = vayu::utils::parse_number<unsigned long long> (value);
        return length && *length > 0;
    }
    return vayu::utils::ascii_lower_equal (name, "transfer-encoding") &&
    vayu::utils::ascii_lower (value).find ("chunked") != std::string::npos;
}

/**
 * @brief Whether an outbound header frame declares a body behind it.
 *
 * Read from the frame because that is the request that was last sent: a
 * 301/302/303 answer to a POST makes libcurl re-send as a body-less GET (and a
 * `GET` carrying a body is re-sent without it), so the composed request's body
 * is not what the final hop carried (issue #2462). HTTP/2 frames spell the
 * names lower-case, which `header_declares_body` does not mind.
 */
bool frame_declares_body (std::string_view frame) {
    bool request_line = true;
    while (!frame.empty ()) {
        const size_t eol      = frame.find ('\n');
        std::string_view line = frame.substr (0, eol);
        frame = eol == std::string_view::npos ? std::string_view{} :
                                                frame.substr (eol + 1);
        if (!line.empty () && line.back () == '\r') {
            line.remove_suffix (1);
        }
        const size_t colon = line.find (':');
        if (std::exchange (request_line, false) || colon == std::string_view::npos) {
            continue;
        }
        if (header_declares_body (line.substr (0, colon),
            trim_field_whitespace (line.substr (colon + 1)))) {
            return true;
        }
    }
    return false;
}

/**
 * @brief The raw-request view, built from the header block libcurl actually sent.
 *
 * @p header_frame is a whole CURLINFO_HEADER_OUT frame - request line included,
 * terminated by its own blank line - so the body is all that has to be added,
 * and only when that frame declares one (`frame_declares_body`).
 * Being the wire's own bytes, it carries what libcurl added on our behalf
 * (`Cookie` from the jar, `Accept`, `Content-Length`, and the h2 pseudo-headers
 * rendered in HTTP/1 form) rather than what we composed and hoped matched.
 *
 * The terminator is re-normalized rather than trusted: whether a frame ends in
 * one CRLF or two is libcurl's business, and the body must not run into the
 * last header line.
 */
std::string raw_request_from_wire (std::string header_frame, const std::string& body) {
    const bool has_body = frame_declares_body (header_frame);
    while (!header_frame.empty () &&
    (header_frame.back () == '\r' || header_frame.back () == '\n')) {
        header_frame.pop_back ();
    }
    header_frame += "\r\n\r\n";
    if (has_body) {
        header_frame += body;
    }
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
    // The URL the transfer would have used, not the one that was typed: a
    // GraphQL body on a GET rides in the query string, and a view that showed
    // the bare URL beside no body would describe neither (issue #1228).
    std::string url = vayu::http::wire_url (request);

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
    // showed the second would describe a request nothing ever sent. A file
    // body is named, never inlined: its length is the file's.
    const std::string body = raw_view_body (request);
    const std::uint64_t length =
    request.body.mode == BodyMode::Binary && vayu::http::has_wire_body (request) ?
    request.body.file.size :
    body.size ();

    // Add Content-Length for body
    if (!body.empty ()) {
        raw_req << "Content-Length: " << length << "\r\n";
    }

    // End of headers
    raw_req << "\r\n";

    // Body
    if (!body.empty ()) {
        raw_req << body;
    }

    return raw_req.str ();
}

/// The URL half of a reference fetch's rule (#2605), before anything is
/// dialled. Behind a proxy it is the only half that sees the target; sent
/// directly, the connected address it names is refused on the same terms.
std::optional<Error>
refused_reference_url (const ClientConfig& config, const Request& request) {
    const auto& rule = config.local_peer_rule;
    if (!rule ||
    !vayu::http::is_refused_reference_url (vayu::http::wire_url (request), *rule)) {
        return std::nullopt;
    }
    return Error{ ErrorCode::InvalidUrl,
        "Cannot send this request: " + vayu::http::local_peer_refusal () };
}

/// Records @p error on a response whose transfer ran, keeping its timing and
/// raw request. Status 0 is the contract for "no answer from the target".
void mark_failed (Response& response, const Error& error) {
    response.status_code   = 0;
    response.status_text   = vayu::http::status_text (0);
    response.error_code    = error.code;
    response.error_message = error.message;
}

/// Turns a completed transfer that is a forwarding proxy's 407 into a failed
/// response (#3257), dropping the proxy's body; any other response is left as
/// it is.
void fail_if_proxy_refused (Response& response, CURL* curl, long status) {
    if (const auto refusal = detail::proxy_authentication_refusal (curl, status)) {
        mark_failed (response, *refusal);
        response.body.clear ();
        response.body_size = 0;
    }
}

// ============================================================================
// The redirect chain (#3300)
// ============================================================================

struct SlistDeleter {
    void operator() (curl_slist* list) const {
        curl_slist_free_all (list);
    }
};
using SlistPtr = std::unique_ptr<curl_slist, SlistDeleter>;

/**
 * @brief What one send hands libcurl pointers into, kept on the send's frame
 *        so it outlives every hop of the chain.
 */
struct SendFrame {
    Response response;
    BodySink sink;
    HeaderSink header_sink;
    detail::BodySource body_source;
    detail::ConnectedPeerCheck peer_check;
    CancelWatch cancel_watch;
    TransferDebug transfer_debug;
    /// The list the first hop sends, which a later hop's is filtered from.
    SlistPtr first_headers;
    /// The list a later hop sends when it leaves out lines of the first.
    SlistPtr hop_headers;
    /// What the jar put on the handle, for the reconcile after the chain.
    std::vector<std::string> jar_seeded_from;
};

/// Where one hop of a send goes and what it carries.
struct Hop {
    std::string url;
    HttpMethod method = HttpMethod::GET;
    bool carries_body = false;
    /// A 301, 302 or 303 changed the request, so no line about a body goes.
    bool rewritten = false;
    /// Redirects followed before this hop.
    int followed = 0;
};

/// How a chain ended, for `Client::send` to build the response from.
struct ChainOutcome {
    CURLcode code = CURLE_OK;
    /// The chain's own failure, which no transfer reported: a redirect it will
    /// not follow, its limit, its deadline, a cancel between hops.
    std::optional<Error> refusal;
    /// Every hop's timers, summed.
    detail::CurlPhaseTimes phases;
    /// The URL the last transfer was sent to.
    std::string last_url;
    /// The registry entry the last transfer presented, or null.
    const ClientCertRule* certificate = nullptr;
    int followed                      = 0;
};

/// The next hop's URL, or the error that ends the chain.
using NextHop = std::expected<std::string, Error>;

/// The name of one header-list line: what precedes `:`, or `;` in libcurl's
/// spelling of a blank header, without blanks.
std::string_view header_line_name (std::string_view line) {
    return trim_field_whitespace (line.substr (0, line.find_first_of (":;")));
}

/// @p first without the lines a hop to another origin, or a rewritten hop,
/// does not send. Null when no line is left.
SlistPtr filtered_header_list (const curl_slist* first, bool other_origin, bool rewritten) {
    curl_slist* list = nullptr;
    for (const curl_slist* item = first; item != nullptr; item = item->next) {
        const std::string_view name = header_line_name (item->data);
        if ((other_origin && is_origin_bound_header (name)) ||
        (rewritten && is_body_header (name))) {
            continue;
        }
        list = curl_slist_append (list, item->data);
    }
    return SlistPtr (list);
}

/**
 * @brief Points the handle's request lines at @p hop.
 *
 * `Authorization` and the typed `Cookie` rows (`CURLOPT_COOKIE`) go only to
 * the origin the send started at, as libcurl compared against its first
 * origin: a hop back there carries them again.
 */
void apply_hop_headers (CURL* curl, SendFrame& frame, const Request& request, const Hop& hop, bool first_origin) {
    const bool filtered = !first_origin || hop.rewritten;
    SlistPtr next       = filtered ?
    filtered_header_list (frame.first_headers.get (), !first_origin, hop.rewritten) :
    nullptr;
    set_opt<CURLOPT_HTTPHEADER> (
    curl, filtered ? next.get () : frame.first_headers.get ());
    frame.hop_headers = std::move (next);
    // libcurl copies a string option, so the value need not outlive the call.
    const std::string cookies = first_origin ? detail::typed_cookie_value (request) : "";
    set_opt<CURLOPT_COOKIE> (curl, cookies.empty () ? nullptr : cookies.c_str ());
}

/// Puts the method and body a @p status redirect asks for on the handle.
void apply_hop_method (CURL* curl, SendFrame& frame, Hop& hop, int status) {
    const RedirectedRequest next = redirected_request (status, hop.method);
    if (next.method != hop.method || (hop.carries_body && !next.keeps_body)) {
        detail::apply_bodyless_method (curl, next.method, frame.body_source);
        hop.method       = next.method;
        hop.carries_body = false;
        hop.rewritten    = true;
        return;
    }
    if (hop.carries_body) {
        detail::rewind_body_source (frame.body_source);
    }
}

/// Moves the @p status redirect just received into `redirect_hops`, as the
/// hop that led to @p next_url.
void record_hop (Response& response,
CURL* curl,
int status,
const std::string& next_url,
const std::vector<std::string>& secret_params) {
    const std::string url = effective_url (curl);
    int omitted           = 0;
    response.redirect_hops.push_back ({ status,
    response.status_text.empty () ? vayu::http::status_text (status) : response.status_text,
    std::move (response.header_lines),
    vayu::core::vayu_ext::redact_url_credentials (url, secret_params, omitted),
    is_scheme_downgrade (url, next_url) });
    response.status_text.clear ();
    response.headers.clear ();
    response.header_lines.clear ();
}

/// Where a finished hop's @p status answer sends the chain: nullopt when it
/// is the final answer, else the next URL or the error the chain ends with.
std::optional<NextHop>
redirect_target (const Response& response, const Request& request, const Hop& hop, int status) {
    if (!request.follow_redirects || !is_redirect_status (status)) {
        return std::nullopt;
    }
    const auto location = location_of (response.header_lines);
    if (!location) {
        return std::nullopt;
    }
    if (redirect_limit_reached (hop.followed, request.max_redirects)) {
        return NextHop (std::unexpect, too_many_redirects_error (request.max_redirects));
    }
    return resolve_redirect_target (hop.url, *location);
}

/**
 * @brief Why the chain stops before a redirected hop's transfer, or nullopt
 *        to send it, with the hop's share of the request's timeout set.
 *
 * One deadline spans the chain, as one transfer's did: a later hop gets what
 * the earlier ones left. Stall mode has no total bound to share; its window
 * and the cancel flag are watched by each transfer on its own.
 */
std::optional<Error> start_redirected_hop (CURL* curl,
const Request& request,
const ClientConfig& config,
const CancelWatch& cancel,
std::chrono::steady_clock::time_point started) {
    if (cancel.flag != nullptr && cancel.flag->load (std::memory_order_acquire)) {
        return Error{ ErrorCode::Cancelled, "Request cancelled" };
    }
    if (config.stall_timeout_ms > 0 || request.timeout_ms <= 0) {
        return std::nullopt;
    }
    const auto spent = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started);
    const long remaining =
    static_cast<long> (request.timeout_ms) - static_cast<long> (spent.count ());
    if (remaining <= 0) {
        return Error{ ErrorCode::Timeout,
            "Operation timed out after " + std::to_string (request.timeout_ms) +
            " milliseconds, following redirects" };
    }
    set_opt<CURLOPT_TIMEOUT_MS> (curl, remaining);
    return std::nullopt;
}

/// Points the handle at the hop @p next_url, after a @p status redirect.
void advance_hop (CURL* curl, SendFrame& frame, const Request& request, Hop& hop, int status, std::string next_url) {
    apply_hop_method (curl, frame, hop, status);
    hop.url = std::move (next_url);
    ++hop.followed;
    set_opt<CURLOPT_URL> (curl, hop.url.c_str ());
    apply_hop_headers (curl, frame, request, hop,
    same_origin (vayu::http::wire_url (request), hop.url));
}

/**
 * @brief Runs the send as one transfer per hop, following redirects itself
 *        rather than through `CURLOPT_FOLLOWLOCATION` (#3300).
 *
 * The handle is configured for the first hop already and is never reset in
 * between, so its cookie engine and its connections serve the whole chain.
 * What a hop changes is re-asserted per hop: the URL, the method and body, the
 * lines that stay with the first origin, and the transport policy, which
 * matches the client certificate against this hop's own origin.
 */
ChainOutcome run_chain (CURL* curl,
const Request& request,
const ClientConfig& config,
SendFrame& frame,
CurlErrorBuffer& errors,
std::chrono::steady_clock::time_point started) {
    ChainOutcome out;
    Hop hop{ vayu::http::wire_url (request), request.method,
        vayu::http::has_wire_body (request) };
    const auto secret_params = auth_param_names (request);
    std::optional<HopCookies> cookies;
    if (request.follow_redirects && config.cookie_jar) {
        cookies.emplace (curl);
    }
    while (true) {
        frame.sink.start_hop ();
        if (hop.followed > 0) {
            out.refusal =
            start_redirected_hop (curl, request, config, frame.cancel_watch, started);
            if (out.refusal) {
                return out;
            }
            errors.clear ();
        }
        out.certificate = detail::apply_transport_policy (
        curl, config.transport, request.verify_ssl, hop.url, &frame.peer_check);
        out.last_url = hop.url;
        if (cookies) {
            cookies->before_hop (hop.url);
        }
        out.code = curl_easy_perform (curl);
        if (cookies) {
            cookies->after_hop ();
        }
        detail::add_phase_times (out.phases, detail::read_phase_times (curl));
        if (out.code != CURLE_OK) {
            return out;
        }
        long status = 0;
        get_info<CURLINFO_RESPONSE_CODE> (curl, &status);
        auto next =
        redirect_target (frame.response, request, hop, static_cast<int> (status));
        if (!next) {
            return out;
        }
        if (!next->has_value ()) {
            out.refusal = std::move (next->error ());
            return out;
        }
        record_hop (frame.response, curl, static_cast<int> (status), **next, secret_params);
        advance_hop (curl, frame, request, hop, static_cast<int> (status),
        std::move (**next));
        out.followed = hop.followed;
    }
}

} // namespace

// ============================================================================
// Client Implementation
// ============================================================================

struct Client::Impl {
    CURL* curl = nullptr;
    ClientConfig config;
    CurlErrorBuffer errors;

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
    Impl (const Impl&)            = delete;
    Impl& operator= (const Impl&) = delete;
    Impl (Impl&&)                 = delete;
    Impl& operator= (Impl&&)      = delete;

    void reset () {
        curl_easy_reset (curl);
        errors.clear ();
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
    auto invalid = detail::validate_transferable (request);
    if (!invalid) {
        invalid = refused_reference_url (impl_->config, request);
    }
    if (invalid) {
        Response refused        = detail::error_response (*invalid);
        refused.request_headers = request.headers;
        return refused;
    }

    impl_->reset ();
    CURL* curl = impl_->curl;

    SendFrame frame;
    Response& response = frame.response;
    BodySink& sink     = frame.sink;
    sink.max_bytes     = impl_->config.max_response_bytes;
    sink.on_progress   = &impl_->config.on_body_progress;
    sink.headers       = &response.headers;

    // `request_headers` is the *sent* record and is filled by
    // build_request_header_list below, from the very appends that build the
    // slist - see its contract for why it is not snapshotted here. It records
    // the first hop's list; a later hop's is filtered from it.

    impl_->errors.attach (curl);

    // Also what the h2 hint below reads, so it sees the scheme the transfer
    // dials.
    const std::string url = vayu::http::wire_url (request);
    set_opt<CURLOPT_URL> (curl, url.c_str ());

    // Set method and body (shared with the event loop path so the two cannot
    // disagree about what goes on the wire - see apply_method_and_body)
    detail::apply_method_and_body (curl, request, frame.body_source);

    // Set headers, and record the same set as what was sent.
    frame.first_headers.reset (detail::build_request_header_list (
    request, impl_->config.default_headers, &response.request_headers));

    if (frame.first_headers) {
        set_opt<CURLOPT_HTTPHEADER> (curl, frame.first_headers.get ());
    }

    // The one default that rides an option rather than a header line.
    detail::apply_default_header_options (curl, request, impl_->config.default_headers);

    // rawRequest is read off the wire, so it can only be built after the
    // transfer completes - see below, just before the error-path early return.

    // Set callbacks
    set_opt<CURLOPT_WRITEFUNCTION> (curl, write_callback);
    set_opt<CURLOPT_WRITEDATA> (curl, &sink);
    set_opt<CURLOPT_HEADERFUNCTION> (curl, header_callback);
    frame.header_sink.response  = &response;
    frame.header_sink.following = request.follow_redirects;
    frame.header_sink.body      = &sink;
    set_opt<CURLOPT_HEADERDATA> (curl, &frame.header_sink);

    // Set timeout. The connect bound is set on every send because the handle
    // is reused, and in stall mode it is the only bound the handshake has: the
    // low-speed window never runs during it (#2835).
    namespace server_limits = vayu::core::constants::server;
    if (impl_->config.stall_timeout_ms > 0) {
        // A stall bound in place of the total one (issue #882). Both together
        // would leave the total deciding whenever it fired first, which is the
        // behaviour this exists to replace - so the total is left unset and
        // `max_response_bytes` is what bounds a transfer that never ends.
        set_opt<CURLOPT_LOW_SPEED_LIMIT> (curl,
        static_cast<long> (vayu::core::constants::import_fetch::STALL_FLOOR_BYTES_PER_SEC));
        set_opt<CURLOPT_LOW_SPEED_TIME> (
        curl, static_cast<long> ((impl_->config.stall_timeout_ms + 999) / 1000));
        set_opt<CURLOPT_CONNECTTIMEOUT_MS> (curl,
        static_cast<long> (server_limits::connect_timeout_ms (impl_->config.stall_timeout_ms)));
    } else {
        set_opt<CURLOPT_TIMEOUT_MS> (curl, static_cast<long> (request.timeout_ms));
        set_opt<CURLOPT_CONNECTTIMEOUT_MS> (curl,
        static_cast<long> (server_limits::connect_timeout_ms (request.timeout_ms)));
    }

    frame.cancel_watch.flag = impl_->config.cancel;
    if (frame.cancel_watch.flag != nullptr) {
        set_opt<CURLOPT_NOPROGRESS> (curl, 0L);
        set_opt<CURLOPT_XFERINFOFUNCTION> (curl, cancel_progress_callback);
        set_opt<CURLOPT_XFERINFODATA> (curl, &frame.cancel_watch);
    }

    // TLS verification, the proxy and the client certificate go on per hop
    // (`run_chain`), through the one shared applier. The peer check is
    // libcurl's callback data, so it lives on the frame, past every transfer.
    const auto& local_peer_rule = impl_->config.local_peer_rule;
    if (local_peer_rule) {
        frame.peer_check.local_peers = &*local_peer_rule;
    }

    // Protocol selection. This path (POST /execute, "Send") previously set no
    // CURLOPT_HTTP_VERSION at all and ran at libcurl's implicit default -
    // the same NONE value Auto maps to, but not by anything that named the
    // request's field, so a Send and a load test of the same request had no
    // structural guarantee of agreeing. Both drivers now go through the one
    // shared mapping.
    set_opt<CURLOPT_HTTP_VERSION> (
    curl, vayu::http::to_curl_http_version (request.http_version));

    // The debug stream is always on, verbose or not: the raw-request view is
    // built from the outbound header frame it carries, which is the only place
    // libcurl's own additions (jar cookies above all) can be read from. Whether
    // the frames are also logged is `debug_callback`'s own read of the
    // logger's level - see TransferDebug.
    frame.transfer_debug.secret_header_names = request.secret_header_names;
    set_opt<CURLOPT_VERBOSE> (curl, 1L);
    set_opt<CURLOPT_DEBUGFUNCTION> (curl, debug_callback);
    set_opt<CURLOPT_DEBUGDATA> (curl, &frame.transfer_debug);

    // Cookie jar (issue #301) - only when a caller opted in; see
    // ClientConfig::cookie_jar.
    if (impl_->config.cookie_jar) {
        frame.jar_seeded_from = detail::apply_jar_cookies (curl, *impl_->config.cookie_jar,
        impl_->config.cookie_scope, impl_->config.cookie_writes);
    }

    // Perform the request. Stamp submission just before perform so that
    // perceived latency excludes our own setup cost above but covers everything
    // libcurl does on this thread, every hop of a redirect chain included. For
    // single-shot sends there is no generator queue, so queue_wait_ms will be
    // near zero - that's the correct contract.
    auto submitted_at = std::chrono::steady_clock::now ();
    const ChainOutcome chain =
    run_chain (curl, request, impl_->config, frame, impl_->errors, submitted_at);
    auto completion = std::chrono::steady_clock::now ();
    flush_transfer_debug (frame.transfer_debug);
    const CURLcode res = chain.code;

    // Before any error return below: a failed transfer can still have
    // collected cookies - see capture_jar_cookies.
    if (impl_->config.cookie_jar) {
        detail::capture_jar_cookies (curl, *impl_->config.cookie_jar,
        impl_->config.cookie_scope, frame.jar_seeded_from);
    }

    // The event loop's semantics through the shared helper, which had drifted
    // from this code once already (negative TLS ms on the load path). The
    // phase timers are every hop's, summed.
    double perceived_ms =
    std::chrono::duration<double, std::milli> (completion - submitted_at).count ();
    detail::apply_transfer_timing (response.timing, chain.phases, perceived_ms);
    // A followed hop was answered, so a later hop's refusal still timed a send.
    response.transfer_attempted =
    chain.followed > 0 || detail::curl_transfer_attempted (curl, res);
    response.proxy_used = detail::proxy_was_used (curl);
    // The identity the last hop presented, recorded rather than looked up again
    // by a reader: see Response::client_certificate.
    response.client_certificate =
    chain.certificate != nullptr ? client_cert_label (*chain.certificate) : "";

    // Negotiated protocol (try to get even on errors, same as timing above -
    // a transfer that fails after the connection was established still knows
    // what it negotiated). Empty when nothing was negotiated at all, e.g. a
    // connection that never reached a server - see http_version_from_curl.
    long negotiated_version = 0;
    get_info<CURLINFO_HTTP_VERSION> (curl, &negotiated_version);
    response.http_version = vayu::http::http_version_from_curl (negotiated_version);
    response.http_version_downgraded =
    vayu::http::http_version_downgraded (request.http_version, response.http_version);
    if (response.http_version_downgraded) {
        // A cleartext URL is the one downgrade with an answer, so the line says
        // it rather than leaving the reader to wonder whether the engine is
        // broken: CURL_HTTP_VERSION_2TLS offers h2 over TLS only, so an
        // `http://` request never attempts it. Naming that is why this is one
        // message with a suffix and not two call sites. The last hop's URL,
        // because that is the connection the version was negotiated on.
        const bool cleartext = chain.last_url.rfind ("http://", 0) == 0;
        vayu::utils::log_warning ("client",
        "HTTP/2 was requested but the connection negotiated " + response.http_version +
        " - " + vayu::utils::strip_url_secrets (request.url) +
        (cleartext ?
        " (h2 is not offered over cleartext; use https:// or set the "
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
    const std::string& last_header_out = frame.transfer_debug.last_header_out;
    response.raw_request               = last_header_out.empty () ?
    synthesize_raw_request (request, response) :
    raw_request_from_wire (last_header_out, raw_view_body (request));

    // The chain stopped itself: the timing and the hops it followed are real,
    // the answer it stopped at is not one.
    if (chain.refusal) {
        mark_failed (response, *chain.refusal);
        return std::move (response);
    }

    // The bound was reached and this caller asked to keep what was read
    // (issue #1157). Everything the transfer did produce before the write
    // callback cut it - the status line, the headers, the prefix - is real, so
    // the response is assembled by the ordinary path below rather than
    // discarded; `body_truncated` is what says it is a prefix. Only the
    // completion is synthetic: curl reports the short count as
    // CURLE_WRITE_ERROR, which is this engine stopping the transfer on purpose
    // and not a failure to report.
    const bool keep_truncated_body = sink.limit_exceeded && impl_->config.truncate_over_limit;

    // Check for errors
    if (res != CURLE_OK && !keep_truncated_body) {
        // A refused body is not a network failure, and curl's own word for it
        // says nothing a caller can act on: the write callback's short count
        // surfaces as a generic CURLE_WRITE_ERROR. So it is recognized here and
        // reported as the condition it is, which `/import/fetch` answers with a
        // 413 rather than a 502. A cancel is this engine's own abort too. The
        // handle describes the hop that failed, so the code is that hop's.
        Error error;
        if (frame.cancel_watch.fired) {
            error = Error{ ErrorCode::Cancelled, "Request cancelled" };
        } else if (sink.limit_exceeded) {
            error = Error{ ErrorCode::ResponseTooLarge,
                too_large_message (response.headers, sink.max_bytes) };
        } else {
            error = detail::curl_to_error (
            curl, res, impl_->errors, &request, &frame.peer_check);
        }

        // Return Response object with error details (Postman-compatible approach).
        // raw_request and timing are already populated above; headers and body
        // stay as the transfer left them (empty when nothing answered).
        mark_failed (response, error);
        return std::move (response);
    }

    // Get response info for successful requests
    long http_code = 0;
    get_info<CURLINFO_RESPONSE_CODE> (curl, &http_code);

    response.status_code = static_cast<int> (http_code);
    // Prefer the wire reason phrase captured by header_callback. Only fall
    // back to the code→phrase lookup when the server (or HTTP/2+ stack)
    // didn't supply one.
    if (response.status_text.empty ()) {
        response.status_text = vayu::http::status_text (response.status_code);
    }
    response.error_code = ErrorCode::None; // Explicitly set to None for successful requests

    // Set body. `body_size` stays what is held rather than what the server
    // declared, here as everywhere else it is written: a caller reading it as
    // the length of `body` is right, and the length of the body that *would*
    // have arrived is a number this transfer never measured - the declared
    // length, when there was one, is still on the headers for a reader that
    // wants it.
    response.body           = std::move (sink.body);
    response.body_size      = response.body.size ();
    response.body_truncated = keep_truncated_body;

    // A forwarding proxy's 407 completes as an ordinary response; the proxy
    // answered, not the target (#3257). The status survives in the message.
    fail_if_proxy_refused (response, curl, http_code);
    return std::move (response);
}

Result<Response> Client::get (const std::string& url, const Headers& headers) {
    Request request;
    request.method  = HttpMethod::GET;
    request.url     = url;
    request.headers = HeaderList (headers);
    return send (request);
}

Result<Response> Client::post (const std::string& url,
const std::string& body,
int timeout_ms,
const Headers& headers) {
    Request request;
    request.method       = HttpMethod::POST;
    request.url          = url;
    request.body.mode    = BodyMode::Text;
    request.body.content = body;
    request.headers      = HeaderList (headers);
    request.timeout_ms   = timeout_ms;
    return send (request);
}

std::string Client::last_error () const {
    return std::string (impl_->errors.message ());
}

// ============================================================================
// Global Functions
// ============================================================================

TlsBackendSelection pin_tls_backend () {
    // Cached rather than repeated: libcurl answers `CURLSSLSET_TOO_LATE` to
    // every call after the first, and the fixtures call `global_init` again
    // per suite - so a second call would report a failure that is really just
    // "already done". The first call's verdict is the one that describes this
    // process, which is what `TlsBackend` asserts.
    static const TlsBackendSelection selected = [] {
        const CURLsslset result =
        curl_global_sslset (CURLSSLBACKEND_OPENSSL, nullptr, nullptr);
        if (result != CURLSSLSET_OK) {
            // Not fatal here - the daemon still serves, and http:// work is
            // unaffected - but every TLS statement this engine makes is now
            // about a backend it did not choose, so it is said once and loudly
            // rather than discovered by a user whose mTLS stopped working.
            const curl_version_info_data* info = curl_version_info (CURLVERSION_NOW);
            vayu::utils::log_error ("client",
            "Could not select the OpenSSL TLS backend "
            "(curl_global_sslset returned " +
            std::to_string (static_cast<int> (result)) + "); this build verifies with '" +
            std::string (info != nullptr && info->ssl_version != nullptr ? info->ssl_version : "unknown") +
            "'. On a MultiSSL build that means CURL_SSL_BACKEND in the "
            "environment, or libcurl's own default, is choosing instead - and "
            "client certificates do not work on Schannel (issue #842).");
        }
        switch (result) {
        case CURLSSLSET_OK: return TlsBackendSelection::Selected;
        case CURLSSLSET_TOO_LATE: return TlsBackendSelection::TooLate;
        // `NO_BACKENDS` and `UNKNOWN_BACKEND` are one answer here: neither
        // leaves an OpenSSL for us to name, and the caller's question is
        // whether this engine chose its backend, not which way it failed to.
        case CURLSSLSET_UNKNOWN_BACKEND:
        case CURLSSLSET_NO_BACKENDS: break;
        }
        return TlsBackendSelection::Unavailable;
    }();
    return selected;
}

void global_init () {
    // Before `curl_global_init`, not beside it: `curl_global_sslset` answers
    // `CURLSSLSET_TOO_LATE` once curl has initialized, and a backend chosen
    // too late is not chosen at all.
    pin_tls_backend ();
    curl_global_init (CURL_GLOBAL_ALL);
}

void global_cleanup () {
    curl_global_cleanup ();
}

} // namespace vayu::http
