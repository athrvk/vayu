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
#include "vayu/http/form_body.hpp"
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
    const bool has_body = vayu::http::has_wire_body (request.body);
    if (has_body && request.method == HttpMethod::HEAD) {
        Error error;
        error.code = ErrorCode::InvalidMethod;
        error.message =
        "HEAD requests cannot carry a body - remove the body or use GET";
        return error;
    }
    // A file part that cannot be read is refused here rather than encoded and
    // left to fail on the wire: libcurl would report a read error naming
    // nothing, and an omitted part is the silence this feature exists to end.
    // Costs one open per transfer, and only for a body that has a file part.
    if (auto problem = vayu::http::unsendable_file_part (request.body)) {
        Error error;
        error.code    = ErrorCode::InternalError;
        error.message = *problem;
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

curl_mime* apply_method_and_body (CURL* curl, const Request& request) {
    const bool has_body = vayu::http::has_wire_body (request.body);
    curl_mime* mime     = nullptr;

    if (has_body && request.body.mode == BodyMode::FormData) {
        // Multipart: libcurl encodes the parts and generates the boundary, so
        // the body and the Content-Type that describes it cannot disagree.
        //
        // A file part is `curl_mime_filedata`, which means libcurl reads the
        // file *during the transfer* - so a load run re-reads it once per
        // iteration (the page cache absorbs that; slurping it into memory at
        // plan time would trade a bounded read for an unbounded allocation and
        // a snapshot that goes stale). Readability was already checked by
        // `validate_transferable`, so a failure here is a file that vanished
        // between the two, which libcurl reports on its own.
        mime = curl_mime_init (curl);
        for (const auto& field : vayu::http::enabled_fields (request.body.fields)) {
            curl_mimepart* part = curl_mime_addpart (mime);
            curl_mime_name (part, field.key.c_str ());
            if (field.type == FormFieldType::File) {
                curl_mime_filedata (part, field.src.c_str ());
                // filedata already declares the basename; an explicit name
                // overrides it, which is how an imported part keeps the
                // filename the exporting app recorded.
                if (!field.file_name.empty ()) {
                    curl_mime_filename (part, field.file_name.c_str ());
                }
            } else {
                curl_mime_data (part, field.value.c_str (), field.value.size ());
            }
            if (!field.content_type.empty ()) {
                curl_mime_type (part, field.content_type.c_str ());
            }
        }
        // Like POSTFIELDS below, this switches curl's method to POST, so the
        // method is (re-)asserted afterwards.
        curl_easy_setopt (curl, CURLOPT_MIMEPOST, mime);
    } else if (has_body) {
        // Setting POSTFIELDS switches curl's method to POST, so it goes first
        // and the method is (re-)asserted below.
        //
        // COPYPOSTFIELDS rather than POSTFIELDS because the body is built here
        // and dies at the end of this scope, while POSTFIELDS keeps only a
        // pointer that has to outlive the transfer.
        const std::string body = vayu::http::wire_body_bytes (request.body);
        curl_easy_setopt (curl, CURLOPT_POSTFIELDSIZE, static_cast<long> (body.size ()));
        curl_easy_setopt (curl, CURLOPT_COPYPOSTFIELDS, body.c_str ());
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
    case HttpMethod::POST:
        // CURLOPT_POST would *discard* a multipart body: it switches curl back
        // to a POSTFIELDS-style post, and the mime attached above goes with it.
        // MIMEPOST already makes the request a POST, so re-asserting the verb
        // is both unnecessary and destructive here.
        if (!mime) {
            curl_easy_setopt (curl, CURLOPT_POST, 1L);
            // CURLOPT_POST alone does not say "no body" - it says "a body, of a
            // length I have not told you", and libcurl then reads that body
            // from its default read callback, which is `stdin`. Declaring the
            // length as zero is what makes a bodyless POST a bodyless POST.
            //
            // Without it the request goes out chunked and length-less, which
            // the servers that answer a trigger or a logout POST are entitled
            // to refuse with a 411 - and which no other client sends. Worse
            // where stdin is not already at EOF: the read happens inside
            // libcurl's callback on the transfer thread, so CURLOPT_TIMEOUT_MS
            // never fires and the transfer blocks until stdin closes. The app
            // spawns the daemon with stdin ignored and a shell redirects it
            // from /dev/null, so both EOF at once and hid this; an engine
            // started by hand on a terminal, or under a parent that pipes stdin
            // and never writes to it, hangs outright.
            //
            // The body-bearing branch above sets POSTFIELDSIZE for the same
            // reason; this is the case with no body to set it for.
            if (!has_body) {
                curl_easy_setopt (curl, CURLOPT_POSTFIELDSIZE, 0L);
            }
        }
        break;
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

    return mime;
}

std::string body_content_type_value (const Request& request) {
    const std::string implied = vayu::http::implied_content_type (request.body);
    if (implied.empty ()) {
        return {};
    }
    // A Content-Type the caller set wins - the same rule the request builder
    // applies renderer-side, where "someone who typed this means it".
    if (request.headers.contains ("Content-Type")) {
        return {};
    }
    return implied;
}

bool suppresses_request_header (const Request& request, const std::string& key) {
    return vayu::http::content_type_is_engine_owned (request.body) &&
    CaseInsensitiveLess::equal (key, "Content-Type");
}

bool header_value_reaches_wire (std::string_view value) {
    return std::any_of (value.begin (), value.end (),
    [] (char c) { return std::isspace (static_cast<unsigned char> (c)) == 0; });
}

curl_slist* build_request_header_list (const Request& request,
const std::string& user_agent,
Headers* sent) {
    curl_slist* list = nullptr;
    if (sent != nullptr) {
        sent->clear ();
    }

    // Every header goes out through here, so the wire and the sent record are
    // the same decision made once. A value libcurl would read as a removal is
    // neither appended nor reported.
    const auto append = [&] (const std::string& key, const std::string& value) {
        if (!header_value_reaches_wire (value)) {
            return;
        }
        const std::string line = key + ": " + value;
        list                   = curl_slist_append (list, line.c_str ());
        if (sent != nullptr) {
            (*sent)[key] = value;
        }
    };

    for (const auto& [key, value] : request.headers) {
        if (suppresses_request_header (request, key)) {
            // Not sent, so not reported as sent either - libcurl writes the
            // multipart Content-Type, boundary and all.
            continue;
        }
        append (key, value);
    }

    // The Content-Type the body mode implies, when the request declares none.
    // Empty when neither holds - which `append` drops, as it drops any
    // value-less header.
    append ("Content-Type", body_content_type_value (request));

    if (!request.headers.contains ("User-Agent")) {
        append ("User-Agent", user_agent);
    }

    return list;
}

void ingest_header_line (std::string_view line, Headers& headers) {
    const auto colon_pos = line.find (':');
    if (colon_pos == std::string_view::npos) {
        return;
    }

    std::string key (line.substr (0, colon_pos));
    for (auto& c : key) {
        c = static_cast<char> (std::tolower (static_cast<unsigned char> (c)));
    }

    auto value = line.substr (colon_pos + 1);
    while (!value.empty () && value.front () == ' ') {
        value.remove_prefix (1);
    }

    auto [it, inserted] = headers.try_emplace (std::move (key), value);
    if (!inserted) {
        it->second += ", ";
        it->second.append (value);
    }
}

void apply_jar_cookies (CURL* curl,
CookieJar& jar,
const std::string& scope,
const std::vector<CookieWrite>& writes) {
    curl_easy_setopt (curl, CURLOPT_COOKIEFILE, "");
    curl_easy_setopt (curl, CURLOPT_COOKIELIST, "ALL");
    for (const auto& line : apply_cookie_writes (jar.lines_for (scope), writes)) {
        curl_easy_setopt (curl, CURLOPT_COOKIELIST, line.c_str ());
    }
}

void capture_jar_cookies (CURL* curl, CookieJar& jar, const std::string& scope) {
    struct curl_slist* held = nullptr;
    if (curl_easy_getinfo (curl, CURLINFO_COOKIELIST, &held) != CURLE_OK) {
        return;
    }
    std::vector<std::string> lines;
    for (const struct curl_slist* item = held; item != nullptr; item = item->next) {
        if (item->data) {
            lines.emplace_back (item->data);
        }
    }
    curl_slist_free_all (held);
    jar.store (scope, std::move (lines));
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

namespace {

/// Whether the proxy itself refused the tunnel, which the CURLcode alone
/// cannot say: curl reports a 4xx answered to a CONNECT as `CURLE_RECV_ERROR`,
/// the same code an upstream that hung up mid-body produces. The connect code
/// is the only place the distinction survives, and it is 0 on every transfer
/// that never issued a CONNECT.
bool proxy_refused_tunnel (CURL* curl) {
    if (!curl) {
        return false;
    }
    long connect_code = 0;
    if (curl_easy_getinfo (curl, CURLINFO_HTTP_CONNECTCODE, &connect_code) != CURLE_OK) {
        return false;
    }
    return connect_code >= 400;
}

} // namespace

Error curl_to_error (CURL* curl, CURLcode code, const char* error_buffer) {
    Error error;
    error.message = error_buffer[0] ? error_buffer : curl_easy_strerror (code);

    // Checked before the code, not as a fallback under it: a proxy that
    // answered the CONNECT with a 4xx is a proxy failure whatever CURLcode
    // came out, and curl spreads that one event across at least two of them
    // (`CURLE_COULDNT_CONNECT` for the refusal, `CURLE_RECV_ERROR` when the
    // tunnel dies after). Deciding from the connect code first means the
    // mapping does not have to enumerate them.
    if (code != CURLE_OK && proxy_refused_tunnel (curl)) {
        error.code = ErrorCode::ProxyError;
        return error;
    }

    switch (code) {
    case CURLE_OK: error.code = ErrorCode::None; break;
    case CURLE_OPERATION_TIMEDOUT: error.code = ErrorCode::Timeout; break;
    // The proxy hop is a distinct failure domain from the target's: "cannot
    // resolve the proxy" reported as a connection failure sent users hunting
    // an endpoint that was never the problem (issue #705).
    case CURLE_COULDNT_RESOLVE_PROXY: error.code = ErrorCode::ProxyError; break;
    case CURLE_PROXY: error.code = ErrorCode::ProxyError; break;
    case CURLE_COULDNT_CONNECT:
    case CURLE_COULDNT_RESOLVE_HOST:
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

void apply_transport_policy (CURL* curl, const TransportPolicy& policy, bool verify_ssl) {
    curl_easy_setopt (curl, CURLOPT_SSL_VERIFYPEER, verify_ssl ? 1L : 0L);
    curl_easy_setopt (curl, CURLOPT_SSL_VERIFYHOST, verify_ssl ? 2L : 0L);

    switch (policy.proxy_mode) {
    case ProxyMode::Environment:
        // Null restores libcurl's default, which *is* the environment pickup.
        // Written rather than skipped so a reused handle cannot keep a proxy
        // the previous policy set - see the header.
        curl_easy_setopt (curl, CURLOPT_PROXY, static_cast<const char*> (nullptr));
        break;
    case ProxyMode::Manual:
        curl_easy_setopt (curl, CURLOPT_PROXY, policy.proxy_url.c_str ());
        break;
    case ProxyMode::Off:
        // Empty string, not null: an empty CURLOPT_PROXY is what disables the
        // environment pickup. Null would re-enable it, and "off" that still
        // proxies because a shell exported https_proxy is not off.
        curl_easy_setopt (curl, CURLOPT_PROXY, "");
        break;
    }

    // The bypass list, and the null-versus-empty distinction is load-bearing:
    // libcurl falls back to the process's `no_proxy` variable whenever
    // CURLOPT_NOPROXY is null, and an empty string means "exempt nothing".
    //
    // So `manual` always writes the list, empty or not. A user who names a
    // proxy in Settings has said where their traffic goes, and an inherited
    // `no_proxy` quietly exempting half of it is the same invisible failure
    // this issue exists to end - it is also not hypothetical: a container that
    // exports `no_proxy=...,127.0.0.1,...` bypassed a configured proxy for
    // every local target and reported nothing.
    //
    // `environment` leaves it null on purpose: that mode *is* "do what the
    // environment says", `no_proxy` included, unless a bypass list overrides
    // it. `off` has no proxy for a list to modify.
    switch (policy.proxy_mode) {
    case ProxyMode::Manual:
        curl_easy_setopt (curl, CURLOPT_NOPROXY, policy.proxy_bypass.c_str ());
        break;
    case ProxyMode::Environment:
        curl_easy_setopt (curl, CURLOPT_NOPROXY,
        policy.proxy_bypass.empty () ? static_cast<const char*> (nullptr) :
                                       policy.proxy_bypass.c_str ());
        break;
    case ProxyMode::Off:
        curl_easy_setopt (curl, CURLOPT_NOPROXY, static_cast<const char*> (nullptr));
        break;
    }

    // Cookies need no thought here, and that is worth stating because it looks
    // like they should: libcurl owns the wire cookies and matches them on the
    // *origin* host, never the proxy hop, and curl 8.21's cross-origin
    // redirect-cookie rule keys on origin too. A proxy changes which socket
    // the bytes leave by and nothing about which jar lines apply.
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
    data->mime = apply_method_and_body (curl, request);

    // Bound what one transfer may buffer in memory. write_callback reports the
    // overrun by returning a short count, which curl turns into a failed
    // transfer, so the run sees a normal error completion rather than growing
    // until the daemon is OOM-killed.
    data->max_response_bytes = config.max_response_body_bytes;

    // A bounded stream's caps (issue #576), copied onto the transfer so both
    // callbacks read them without reaching back through the request. The
    // deadline is computed once here rather than per callback: `submitted_at`
    // is the run's own view of when this transfer began, and it is what
    // `queue_wait_ms` is measured from, so the duration cap covers the same
    // span the report attributes to the transfer.
    if (request.stream_bounds) {
        data->stream_bounds = request.stream_bounds;
        data->stream_deadline =
        data->submitted_at + std::chrono::milliseconds (request.stream_bounds->max_duration_ms);
    }

    // Set headers. No sent record is kept on this path - a load run's captures
    // record none, and `script_request_header_view` reads the composed map
    // instead - so the map is not built per transfer.
    data->headers_list = build_request_header_list (request, config.user_agent, nullptr);

    if (data->headers_list) {
        curl_easy_setopt (curl, CURLOPT_HTTPHEADER, data->headers_list);
    }

    // Per-transfer cookie state, for the scenario load path's virtual users.
    // Enable the engine, flush, then seed - the ordering
    // `client.cpp::apply_jar_cookies` already uses. See cookie_jar.hpp for why
    // libcurl, not us, decides what actually goes on the wire.
    //
    // Handles come from a pool and are reused, so a session left on one would
    // reach whichever virtual user acquires it next - the opposite of "1,000
    // VUs are 1,000 users". `CurlHandlePool::acquire` already calls
    // `curl_easy_reset`, which frees the handle's cookie store as well, so the
    // "ALL" flush below is redundant *today*: no test can redden it, and none
    // pretends to. It stays because the pool's reset is another component's
    // implementation detail on a path where the failure is silent - a load run
    // that reported numbers for a session it should never have had.
    if (request.track_cookies) {
        curl_easy_setopt (curl, CURLOPT_COOKIEFILE, "");
        curl_easy_setopt (curl, CURLOPT_COOKIELIST, "ALL");
        for (const auto& line : request.cookie_lines) {
            curl_easy_setopt (curl, CURLOPT_COOKIELIST, line.c_str ());
        }
    }

    // Set callbacks
    curl_easy_setopt (curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt (curl, CURLOPT_WRITEDATA, data);
    curl_easy_setopt (curl, CURLOPT_HEADERFUNCTION, header_callback);
    curl_easy_setopt (curl, CURLOPT_HEADERDATA, data);

    // Progress callback. A bounded stream needs it whether or not the caller
    // asked for progress: it is where the duration cap is enforced, and a quiet
    // stream produces no writes to enforce it from (issue #576).
    if (data->progress || data->stream_bounds) {
        curl_easy_setopt (curl, CURLOPT_XFERINFOFUNCTION, progress_callback);
        curl_easy_setopt (curl, CURLOPT_XFERINFODATA, data);
        curl_easy_setopt (curl, CURLOPT_NOPROGRESS, 0L);
    }

    // Set timeout. For a bounded stream the whole-transfer deadline is a
    // *backstop* around the duration cap rather than the deadline itself: the
    // cap is meant to end the stream successfully a grace period before this
    // fires, so reaching this one means the progress callback never ran, which
    // is a genuine failure and is reported as the timeout it is. Setting it to
    // `timeout_ms` instead would kill a legitimately long stream as an error at
    // the ordinary per-request timeout, which for a 10-minute cap and a 30s
    // timeout is every stream.
    const long transfer_timeout_ms = request.stream_bounds ?
    static_cast<long> (request.stream_bounds->max_duration_ms +
    vayu::core::constants::sse::LOAD_STREAM_TIMEOUT_GRACE_MS) :
    static_cast<long> (request.timeout_ms);
    curl_easy_setopt (curl, CURLOPT_TIMEOUT_MS, transfer_timeout_ms);

    // Set redirect options
    if (request.follow_redirects) {
        curl_easy_setopt (curl, CURLOPT_FOLLOWLOCATION, 1L);
        curl_easy_setopt (curl, CURLOPT_MAXREDIRS, static_cast<long> (request.max_redirects));
    }

    // TLS verification and the proxy, both from the run-scoped policy. Run-
    // scoped rather than per-request because libcurl only reuses a cached
    // connection when its proxy and TLS config match, so varying either per
    // transfer would partition every worker's pool and multiply handshakes
    // (epic decision 3 of #704).
    apply_transport_policy (curl, config.transport, request.verify_ssl);

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

    // Read the handle's jar back before the error branch, for the same reason
    // client.cpp captures before its own: a redirect chain that dies on its
    // last hop still collected the cookies of the hops that succeeded, and a VU
    // that loses them re-authenticates on its next step.
    if (data->request.track_cookies) {
        struct curl_slist* held = nullptr;
        if (curl_easy_getinfo (curl, CURLINFO_COOKIELIST, &held) == CURLE_OK && held) {
            for (struct curl_slist* item = held; item; item = item->next) {
                if (item->data) {
                    response.cookie_lines.emplace_back (item->data);
                }
            }
            curl_slist_free_all (held);
        }
    }

    // A bounded stream reports what it delivered, on every path below: a
    // transfer the server killed mid-stream still delivered the events it
    // delivered, and dropping the count on the error path would make a partial
    // stream indistinguishable from one that carried nothing.
    if (data->stream_bounds) {
        data->stream_counter.finish ();
        response.stream_events = data->stream_counter.events ();
        response.stream_capped = data->stream_cap_reached;
    }

    // A cap ended this stream, which is what a bounded stream under load is
    // *supposed* to do (issue #576), so it completes successfully rather than
    // as the aborted write or aborted callback libcurl reports. Ahead of the
    // error branch and deliberately not folded into it: the run's completion
    // accounting treats this like any other success, which is what keeps
    // `in_flight()` balanced and the refill loop untouched.
    //
    // `body_limit_exceeded` still wins - it is checked first below only because
    // it cannot be set at the same time as this: write_callback returns at the
    // byte cap without ever setting `stream_cap_reached`.
    if (result != CURLE_OK && data->stream_cap_reached && !data->body_limit_exceeded) {
        long stream_code = 0;
        curl_easy_getinfo (curl, CURLINFO_RESPONSE_CODE, &stream_code);
        response.status_code = static_cast<int> (stream_code);
        if (response.status_text.empty ()) {
            response.status_text = vayu::http::status_text (response.status_code);
        }
        return response;
    }

    if (result != CURLE_OK) {
        // Not returned as an Error: the load strategy processes this as a
        // "failed response" rather than an "unexpected error".
        const Error error      = data->body_limit_exceeded ?
             Error{ ErrorCode::InternalError,
            "Response body exceeded the " + std::to_string (data->max_response_bytes) +
            " byte cap (maxResponseBodyBytes)" } :
             curl_to_error (curl, result, data->error_buffer);
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
