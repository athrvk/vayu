#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <curl/curl.h>

#include <optional>
#include <string>
#include <string_view>

#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/types.hpp"

namespace vayu::http::detail {

// Forward declaration
struct TransferData;
class DnsCache;

/**
 * @brief Convert CURL error code to vayu Error
 *
 * @param curl The handle the transfer ran on, read for the proxy detail curl
 *             only exposes through `curl_easy_getinfo` - a 407 answered to a
 *             CONNECT comes back as a plain `CURLE_RECV_ERROR` and is
 *             indistinguishable from an upstream one without it. May be null
 *             where no handle is available; the mapping then falls back to the
 *             code alone.
 */
Error curl_to_error (CURL* curl, CURLcode code, const char* error_buffer);

/**
 * @brief Put the transport policy on a handle: TLS verification and the proxy.
 *
 * The one place any driver configures either. It exists because the three
 * drivers each grew their own copy of the SSL block and only two of them ever
 * grew a proxy block, so `POST /execute` and a load run honoured
 * `CURLOPT_PROXY` while an SSE stream silently did not (issue #705). A
 * transport option added here reaches all three by construction.
 *
 * Every mode writes `CURLOPT_PROXY` rather than skipping it: handles are
 * reused (the single-request client keeps one for its lifetime, the event loop
 * recycles them across transfers), so a branch that left the option alone
 * would inherit whatever the previous policy put there.
 *
 * @param verify_ssl The request's own `verifySSL`. Per-request today; phase 2
 *                   of #704 adds the policy-level CA fields beside it.
 * @param url The target this transfer dials, for the client-certificate lookup
 *            (issue #707). Parsed only when the registry is non-empty, so the
 *            load path pays nothing for a feature it is not using.
 * @return The registry entry whose certificate was put on the handle, or null
 *         when none matched. Points into @p policy and lives exactly as long -
 *         a caller that keeps it (both design funnels record the label on the
 *         response) must copy what it needs before the policy goes away.
 */
const ClientCertRule* apply_transport_policy (CURL* curl,
const TransportPolicy& policy,
bool verify_ssl,
const std::string& url);

/**
 * @brief Get HTTP status text from status code
 */
const char* status_text (int code);

/**
 * @brief The host and port a URL dials.
 */
struct UrlAuthority {
    /// Hostname, or the address of an IP-literal URL with its brackets removed.
    /// Empty when the URL names no authority.
    std::string host;
    /// Explicit port, or the scheme default when the URL names none.
    int port = 0;
    /// True when `host` is an address rather than a name, so there is nothing
    /// to resolve and nothing to pin.
    bool is_ip_literal = false;
};

/**
 * @brief Parse the authority of a request URL.
 *
 * Handles the two forms the DNS pre-resolution path used to mis-parse: an IPv6
 * literal (`http://[::1]:8080/`, whose colons are part of the address) and
 * userinfo (`http://user:pass@host/`, whose colon is not a port separator).
 * Never throws, for any input - this runs on the event loop worker thread,
 * which has no exception handler.
 */
UrlAuthority parse_authority (const std::string& url);

/**
 * @brief Extract hostname from URL
 */
std::string extract_hostname (const std::string& url);

/**
 * @brief Extract port from URL (defaults to 443 for https, 80 for http)
 *
 * A port outside 1..65535 - including one too large for `int` - is treated as
 * absent and yields the scheme default. Never throws, for any input: this runs
 * on the event loop worker thread, which has no exception handler.
 */
int extract_port (const std::string& url);

/**
 * @brief Reject a request that cannot be put on the wire as written.
 *
 * Both clients call this before configuring a handle. Three such requests:
 * HEAD with a body (`CURLOPT_NOBODY` resets curl's method back to HEAD and
 * drops the body, so honouring both is impossible), a multipart body naming a
 * file this process cannot read, and header text carrying a byte no header line
 * can hold - see `vayu::http::unsendable_header_text`. In each case the caller
 * is told rather than having half its request silently discarded.
 *
 * Being the one gate every driver passes through *before* configuring anything
 * is what makes it the home for a rule that has to hold for every origin -
 * `build_request_header_list` sees the same headers, but can only drop.
 *
 * @return The error to complete the request with, or nullopt when it is sendable.
 */
[[nodiscard]] std::optional<Error> validate_transferable (const Request& request);

/**
 * @brief A request that never reached the wire, in the shape every consumer
 *        already handles: HTTP status 0 plus the error fields.
 *
 * The load strategy counts such a response as a failed request and the app
 * renders its message - both of which an `Error` result would bypass, since
 * `Result<Response>::error` is reserved for engine-internal failures.
 */
Response error_response (const Error& error);

/**
 * @brief Set the wire method and body on a handle.
 *
 * Order matters: `CURLOPT_POSTFIELDS` switches curl's method to POST, so a
 * body-bearing GET has to re-assert its method afterwards with
 * `CURLOPT_CUSTOMREQUEST` - otherwise a GET with a body goes out as a POST.
 * Shared by both clients so the two cannot drift apart again.
 *
 * Requires `validate_transferable(request)` to have passed.
 *
 * @return The multipart body attached to the handle, which the caller **must**
 *         free with `curl_mime_free` once the transfer has finished, or
 *         nullptr for every other body mode. Returned rather than owned here
 *         because the two drivers keep per-transfer state in different places:
 *         a local for the single-request client, `TransferData` for the loop.
 */
[[nodiscard]] curl_mime* apply_method_and_body (CURL* curl, const Request& request);

/**
 * @brief The Content-Type value the body implies, or empty.
 *
 * Empty when the request already declares a Content-Type (a header the user
 * typed always wins) and empty for every mode that implies none. Read only by
 * `build_request_header_list`, which is where every driver gets its headers,
 * so the rule cannot drift between them.
 */
[[nodiscard]] std::string body_content_type_value (const Request& request);

/**
 * @brief True when this request header must not be forwarded as written.
 *
 * Only a Content-Type on a multipart body, whose boundary libcurl owns - see
 * `vayu::http::content_type_is_engine_owned`.
 */
[[nodiscard]] bool suppresses_request_header (const Request& request, const std::string& key);

/**
 * @brief True when libcurl sends this header value rather than reading the
 *        line as an instruction to remove the header.
 *
 * `CURLOPT_HTTPHEADER` overloads one string with two meanings: `Key: value`
 * adds a header, and `Key:` with nothing after the colon *removes* one, which
 * is how libcurl lets a caller drop a header it would otherwise add itself.
 * The engine spells every header `key + ": " + value`, so an enabled request
 * row with an empty value lands on the removal side and never reaches the wire
 * - sending it deliberately would need the `Key;` spelling, which the engine
 * does not emit (issue #662). libcurl skips the whitespace after the colon
 * before deciding, so a value of spaces alone is dropped too.
 */
[[nodiscard]] bool header_value_reaches_wire (std::string_view value);

/**
 * @brief Build the `CURLOPT_HTTPHEADER` list for a request, and record what it
 *        puts on the wire.
 *
 * The one place a driver's outbound header set is decided: the request's own
 * headers minus the suppressed and the value-less, plus the two the engine
 * derives (the body-implied Content-Type and a default User-Agent when the
 * request names none). All three drivers - the single-request client, the load
 * event loop and the SSE stream consumer - call this, so none of them can
 * disagree about what goes out.
 *
 * It has no error channel, deliberately: a header it cannot append it drops.
 * Text that must be *refused* rather than dropped is caught one step earlier,
 * by `validate_transferable`, which every one of those drivers already calls.
 *
 * @param sent When non-null, cleared and filled with exactly the headers
 *        appended to the returned list. That is `Response::request_headers`,
 *        the "sent record" the response pane's Headers tab and a test script's
 *        `pm.request.headers` read - built from the same appends as the list
 *        rather than snapshotted beside it, because a snapshot taken
 *        separately reported headers libcurl had dropped. The load driver
 *        passes nullptr: it records no sent headers, and building the map per
 *        transfer would cost the hot path an allocation for nobody.
 *
 * @return The header list, which the caller **must** free with
 *         `curl_slist_free_all` once the transfer has finished, or nullptr
 *         when the request sends no headers at all.
 */
[[nodiscard]] curl_slist* build_request_header_list (const Request& request,
const std::string& user_agent,
Headers* sent);

/**
 * @brief Record one "Key: Value" response header line into `headers`.
 *
 * The key is lower-cased so every consumer can index one spelling, and the
 * value keeps everything past the first colon with its leading spaces trimmed.
 * A line carrying no colon is not a header field and is ignored.
 *
 * **A name that arrives twice keeps both values, folded with ", "** - the
 * RFC 7230 §3.2.2 equivalence for comma-list headers. Both callbacks used to
 * assign into the map, so the second `Set-Cookie` of a login response (the
 * normal way servers set two cookies, since `Set-Cookie` is the one header
 * §3.2.2 exempts from folding) silently replaced the first. Folding is what
 * both `Set-Cookie` parsers - the renderer's `parse-set-cookie.ts` and the
 * engine's - already recover cookie boundaries from, so it hands them the
 * shape they were written for instead of half the data.
 *
 * Shared by both clients so the two cannot drift apart again.
 */
void ingest_header_line (std::string_view line, Headers& headers);

/**
 * @brief Hand a scope's stored cookies to libcurl's cookie engine.
 *
 * Three steps, in this order: enable the engine (`CURLOPT_COOKIEFILE` with an
 * empty path reads no file and turns it on), flush whatever the handle still
 * holds, then inject. The flush matters because `curl_easy_reset` deliberately
 * keeps a handle's cookies - without it a handle reused for a second send, or
 * one whose jar was cleared from Settings mid-session, would carry cookies the
 * jar no longer has.
 *
 * From here on libcurl decides what actually goes on the wire: which cookies
 * match the URL, which expired, and what a `Set-Cookie` in the response
 * replaces. See cookie_jar.hpp for why that is deliberately not our code.
 *
 * A script's staged @p writes are applied on top of the stored lines here
 * rather than in the jar, so the transfer carries them and its capture persists
 * them - the ordering cookie_jar.hpp describes.
 *
 * Shared by the single-request client and the SSE stream consumer so the two
 * cannot drift into sending different sessions for the same request.
 */
void apply_jar_cookies (CURL* curl,
CookieJar& jar,
const std::string& scope,
const std::vector<CookieWrite>& writes);

/**
 * @brief Store what the transfer left in the handle's jar back into the scope.
 *
 * Called even when the transfer failed, for the same reason the timing reads
 * are: a redirect chain that dies on its last hop still collected the cookies
 * of the hops that succeeded, and dropping those would make a login flow depend
 * on the last request having gone well. A stream that ends on a cap is the same
 * case - it authenticated successfully, it just did not run to the server's own
 * end.
 */
void capture_jar_cookies (CURL* curl, CookieJar& jar, const std::string& scope);

/**
 * @brief libcurl's cumulative phase timers, in seconds, for one transfer.
 */
struct CurlPhaseTimes {
    double total         = 0.0;
    double namelookup    = 0.0;
    double connect       = 0.0;
    double appconnect    = 0.0;
    double starttransfer = 0.0;
};

/**
 * @brief Read the phase timers off a handle (valid even after a failed transfer).
 */
CurlPhaseTimes read_phase_times (CURL* curl);

/**
 * @brief Turn cumulative phase timers into the non-negative per-phase durations
 *        stored in `Timing` and rendered by the app.
 *
 * `CURLINFO_APPCONNECT_TIME` is 0 for plain HTTP and for a reused keep-alive
 * connection, so the naive successive differences render TLS as a negative
 * duration and let TTFB absorb the connect time. A zero appconnect means "no
 * TLS phase" and collapses onto connect; every delta is clamped at 0.
 */
void apply_phase_timings (Timing& timing, const CurlPhaseTimes& times);

/**
 * @brief Hand a configured easy handle to a multi handle.
 *
 * A rejected handle never produces a `curl_multi_info_read` completion, so a
 * discarded `CURLMcode` strands the transfer: it never drains, the run cannot
 * finish, and `stop(true)` waits forever. Callers complete the transfer with
 * the returned error instead of tracking it as active.
 *
 * @return nullopt when the transfer was accepted, otherwise the error to
 *         complete it with.
 */
[[nodiscard]] std::optional<Error> add_to_multi (CURLM* multi_handle, CURL* easy);

/**
 * @brief Setup a CURL easy handle for a request
 * @param curl Pre-allocated curl handle (from pool) or nullptr to create new
 * @param data Transfer data containing request info
 * @param config Event loop configuration
 * @param dns_cache Optional DNS cache for pre-resolved hostnames
 * @return Configured curl handle, or nullptr on failure
 */
CURL* setup_easy_handle (CURL* curl,
TransferData* data,
const EventLoopConfig& config,
DnsCache* dns_cache = nullptr);

/**
 * @brief Extract response from completed CURL transfer
 */
Result<Response> extract_response (CURL* curl, TransferData* data, CURLcode result);

} // namespace vayu::http::detail
