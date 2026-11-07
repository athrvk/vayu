#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <curl/curl.h>

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/curl_error_buffer.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/event_loop/connected_peer_check.hpp"
#include "vayu/http/event_loop/transfer_context.hpp"
#include "vayu/http/loopback_guard.hpp"
#include "vayu/http/redirect_policy.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/types.hpp"

namespace vayu::http::detail {

// Forward declaration
struct TransferData;
class DnsCache;

/**
 * @brief The proxy @p policy puts on a handle by URL, as the authority
 *        libcurl dials: `manual`'s, or `system`'s when it resolved one.
 *
 * Nullopt for `off`, for an empty URL, and for `environment` (and `system`
 * with nothing resolved), where libcurl reads the proxy from the process
 * environment and the engine never learns it. A URL naming no port is dialled
 * on libcurl's proxy default: 443 for an `https` proxy, 1080 for every other
 * scheme, which is not the target default `parse_authority` answers.
 */
[[nodiscard]] std::optional<UrlAuthority> configured_proxy (const TransportPolicy& policy);

/**
 * @brief Convert CURL error code to vayu Error
 *
 * @param curl The handle the transfer ran on, read for the proxy detail curl
 *             only exposes through `curl_easy_getinfo` - a 407 answered to a
 *             CONNECT comes back as a plain `CURLE_RECV_ERROR` and is
 *             indistinguishable from an upstream one without it, and
 *             `CURLE_COULDNT_CONNECT` is the proxy's when a proxy was in the
 *             path (`CURLINFO_USED_PROXY`, #3257) and the target's otherwise.
 *             May be null where no handle is available; the mapping then
 *             falls back to the code alone.
 *
 * An undecodable body gets its own code (`BadContentEncoding`, issue #2462)
 * and a message that opens with a plain statement of the cause, then libcurl's
 * text. The `Content-Encoding` is read off @p curl, so without a handle the
 * sentence names none. A redirect loop is not a libcurl code: no handle
 * follows redirects, so `CURLE_TOO_MANY_REDIRECTS` is never raised, and the
 * `TooManyRedirects` a chain ends with comes from `too_many_redirects_error`.
 *
 * `CURLE_UNSUPPORTED_PROTOCOL` is `InvalidUrl` (a scheme the handle refused,
 * libcurl's text unchanged) unless @p curl reached a peer and stopped at an
 * `http` or `https` URL: then the peer answered in something other than
 * HTTP/1.x, usually an h2c server's preface, and it is `ProtocolMismatch`
 * (issue #3306), with a hint about h2c when the request asked for `http2` and
 * the handle's `CURLINFO_EFFECTIVE_URL` is `http://`. Without a handle it
 * stays `InvalidUrl`.
 *
 * @param request The request the transfer sent, read only to say *why* a URL
 *                libcurl refused as malformed was: a space or control byte in
 *                it is named, and the toggle that would send it as typed is
 *                suggested only while `disableUrlEncoding` is off; and for its
 *                `http_version`, which decides the h2c hint above. May be null,
 *                and then libcurl's own text stands.
 *
 * @param peer_check The state the transfer's `apply_transport_policy` was
 *                   handed, read to word a `LocalPeerRule` refusal as that
 *                   rule. Null where the transfer carried none.
 */
Error curl_to_error (CURL* curl,
CURLcode code,
const CurlErrorBuffer& errors,
const Request* request               = nullptr,
const ConnectedPeerCheck* peer_check = nullptr);

/**
 * @brief Whether libcurl routed the transfer on @p curl through a proxy,
 *        whichever way the proxy was chosen (`CURLINFO_USED_PROXY`, #3257).
 *
 * libcurl's own answer, so it covers the environment pickup (where
 * `configured_proxy` has nothing to say, the variables being libcurl's to read)
 * and a `no_proxy` bypass alike. A null handle and an unreadable value both
 * read as no proxy. Read before anything else reuses the handle.
 */
[[nodiscard]] bool proxy_was_used (CURL* curl);

/**
 * @brief libcurl's current request URL on @p curl (`CURLINFO_EFFECTIVE_URL`):
 *        the current hop's, since a redirect chain reuses the one handle.
 *
 * Copied because libcurl's buffer is only valid until the next call into the
 * handle. Empty for a null handle and when libcurl reports none.
 */
[[nodiscard]] std::string effective_url (CURL* curl);

/**
 * @brief The proxy's refusal when a transfer that completed is a forwarding
 *        proxy's 407, otherwise nothing (#3257).
 *
 * A proxy that is sent a plain `http://` request answers an unauthenticated one
 * with an ordinary 407 response, which libcurl returns as `CURLE_OK`; read as
 * the target's answer, it sends the user to the server's credentials. It is the
 * proxy's when @p curl routed the transfer through one (`CURLINFO_USED_PROXY`)
 * and no tunnel stands between them: a 407 an origin sends inside a CONNECT
 * tunnel, or on a direct transfer, is the origin's own and stays a response.
 * A null handle reads as no proxy. Only the single-request client calls this;
 * a load run keeps counting a proxy's 407 as a status.
 */
[[nodiscard]] std::optional<Error> proxy_authentication_refusal (CURL* curl, long status);

/**
 * @brief Whether a transfer libcurl finished with @p code reached the network,
 *        which is what `Response::transfer_attempted` records (#2412).
 *
 * False only for a URL libcurl could not parse or a scheme the handle refuses,
 * and then only while @p curl never reached a peer: a reply libcurl cannot
 * read arrives as the same code after a real hop. A redirect the engine
 * refuses (`resolve_redirect_target`, the limit) is not a libcurl code: the
 * hop that asked for it finished with `CURLE_OK`, so it is an attempt. Every
 * other code, a resolve failure and an unreadable client
 * certificate included, is an attempt. Read before anything else reuses the
 * handle. A null handle reads as one that reached no peer.
 */
[[nodiscard]] bool curl_transfer_attempted (CURL* curl, CURLcode code);

/**
 * @brief Put the transport policy on a handle: the protocols it may speak, TLS
 *        verification and the proxy.
 *
 * The one place any driver configures any of them. It exists because the three
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
 * `CURLOPT_PREREQFUNCTION` is on every handle too, set here and nowhere else:
 * the connected-address half of the loopback guard (`http/loopback_guard.hpp`),
 * which refuses a redirect or a resolved name that lands on Vayu's own port.
 * `curl_to_error` reports that abort as the same refusal
 * `validate_transferable` gives. @p peer_check adds a `LocalPeerRule` on top
 * for one transfer (#2364); `CURLOPT_PREREQDATA` is written on every call,
 * null included, so a pooled handle never keeps a previous transfer's state.
 * With a proxy in force the peer judged is the proxy, for both rules; the
 * applier records `configured_proxy` on @p peer_check, so the reference rule
 * passes that proxy while the reserved ports still refuse it. The callback
 * also counts every call on @p peer_check (`requests_started`), which is how a
 * request libcurl re-sent on a new connection is seen at all (#2799,
 * `connection_replays`).
 *
 * `CURLOPT_PROTOCOLS_STR` is `http,https` on every handle: the backstop behind
 * `validate_transferable`'s scheme rule for the one URL it cannot judge, the
 * scheme libcurl guesses for a URL that names none (`ftp.example.com/x` is
 * FTP). A redirect's `Location` is never handed to it: `RedirectChain` refuses
 * a scheme other than `http` or `https` in `resolve_redirect_target`, as an
 * `InvalidUrl` worded `Protocol "ftp" is disabled (in redirect)`.
 *
 * @param verify_ssl The request's own `verifySSL`. Per-request today; phase 2
 *                   of #704 adds the policy-level CA fields beside it.
 * @param url The URL the handle was given (`wire_url`), for the
 *            client-certificate lookup (issue #707); never `request.url`, whose
 *            typed text can name another scheme or host (#2465). Parsed only
 *            when the registry is non-empty, so the load path pays nothing for
 *            a feature it is not using.
 * @param peer_check This transfer's connect-time state, or null. Must outlive
 *                   the transfer; the applier writes its `proxy` and the
 *                   callback its refusal and its count into it.
 * @return The registry entry whose certificate was put on the handle, or null
 *         when none matched or @p url is not `https` (a certificate is only
 *         presented in a TLS handshake, #3260). Points into @p policy and lives exactly as long -
 *         a caller that keeps it (both design funnels record the label on the
 *         response) must copy what it needs before the policy goes away.
 */
const ClientCertRule* apply_transport_policy (CURL* curl,
const TransportPolicy& policy,
bool verify_ssl,
const std::string& url,
ConnectedPeerCheck* peer_check = nullptr);

/**
 * @brief Get HTTP status text from status code
 */
const char* status_text (int code);

/**
 * @brief Parse the authority of a request URL.
 *
 * A caller holding a `Request` passes `wire_url (request)`, the URL the handle
 * is given: with encoding on that drops leading whitespace and turns `\` into
 * `/`, either of which changes the scheme default port and the host read off
 * the typed text (#2465).
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
 * Every driver calls this before configuring a handle. Six such requests:
 * a URL whose scheme is not `http` or `https` (`vayu::http::unsendable_scheme`;
 * libcurl is built with other protocols and would read a `file://` URL), a
 * HEAD with a body (`CURLOPT_NOBODY` resets curl's method back to HEAD and
 * drops the body, so honouring both is impossible), a binary body or file
 * part whose file no plan checked (`vayu::http::unplanned_file_ref` - the file
 * rule runs once per send or run, before this, and a body that skipped it is
 * refused rather than read),
 * header text carrying a byte no header line can hold - see
 * `vayu::http::unsendable_header_text` - and a non-ASCII host with no ASCII
 * name (`vayu::http::unsendable_host`), and a URL naming Vayu's own engine or
 * MCP port (`vayu::http::reserved_target_port`, #2355). In each case the
 * caller is told rather than having half its request silently discarded. The
 * URL rules read `wire_url (request)`, the URL the handle is given (#2465).
 *
 * Being the one gate every driver passes through *before* configuring anything
 * is what makes it the home for a rule that has to hold for every origin -
 * `build_request_header_list` sees the same headers, but can only drop.
 *
 * @return The error to complete the request with, or nullopt when it is sendable.
 */
[[nodiscard]] std::optional<Error> validate_transferable (const Request& request);

/**
 * @brief The `CURLOPT_TIMEOUT_MS` a transfer of @p request is given, by both
 *        drivers that send one (the event loop and `Client`).
 *
 * `timeout_ms` for an ordinary transfer. For a bounded stream
 * (`Request::stream_bounds`) it is a *backstop* around the duration cap
 * rather than the deadline itself: the cap is meant to end the stream
 * successfully `LOAD_STREAM_TIMEOUT_GRACE_MS` before this fires, so reaching
 * this one means the progress callback never ran, which is a genuine failure
 * and is reported as the timeout it is. `timeout_ms` instead would kill a
 * legitimately long stream as an error at the ordinary per-request timeout,
 * which for a 10-minute cap and a 30s timeout is every stream. The connect
 * phase stays bounded by `timeout_ms` either way (#2835).
 */
[[nodiscard]] long whole_transfer_timeout_ms (const Request& request);

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
 * A **binary** body is the one mode with two transports. A file the plan read
 * (`FileRef::inline_bytes`, at most `INLINE_FILE_LIMIT`) goes out as
 * `CURLOPT_POSTFIELDS` pointing at the shared bytes - no copy per transfer. A
 * larger one streams from the file the plan opened (`FileRef::approved`,
 * #2678), never from `src`: `CURLOPT_UPLOAD` with `INFILESIZE_LARGE` the size
 * that open saw, a read callback at this transfer's own offset, and a **seek
 * callback**, which libcurl needs to rewind the body for the second leg of
 * Digest/NTLM - without it that leg fails rather than resending. A redirect
 * that resends the body is rewound by the engine for a streamed upload
 * (`RedirectChain::apply_method` through `rewind_body_source`); a form part
 * is rewound by libcurl through this callback.
 * `UPLOAD` means PUT to libcurl, so the method is re-asserted with
 * `CURLOPT_CUSTOMREQUEST` afterwards.
 *
 * A **form-data file part** is read through `curl_mime_data_cb` from the file
 * the plan opened (`FormField::approved`, #2416) with the same two callbacks;
 * its filename and Content-Type are set explicitly (`declared_file_name`,
 * `file_part_content_type`), because libcurl derives neither for a callback
 * part the way it did for a path.
 *
 * @param source Receives what the handle now points into (the multipart tree,
 *        the streamed body's reader), which must outlive the transfer: a local
 *        for the single-request client, `TransferData::body` for the loop.
 */
void apply_method_and_body (CURL* curl, const Request& request, BodySource& source);

/**
 * @brief Put a body-less @p method on a handle that carried a body for the
 *        previous hop of a redirect chain (#3300).
 *
 * The handle is not reset between hops (its cookie engine and connections
 * must survive), so the verb and the upload a previous hop set are cleared
 * first; then `apply_method_and_body` asserts the method as it would for a
 * request that never had a body.
 */
void apply_bodyless_method (CURL* curl, HttpMethod method, BodySource& source);

/**
 * @brief Rewind a streamed body so the next hop of a chain that keeps the
 *        body (307, 308) sends it from the start.
 */
void rewind_body_source (BodySource& source);

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
 * @brief True when the value holds something other than whitespace.
 *
 * `CURLOPT_HTTPHEADER` overloads one string with two meanings: `Key: value`
 * adds a header, and `Key:` with nothing after the colon *removes* one, which
 * is how libcurl lets a caller drop a header it would otherwise add itself.
 * libcurl skips the whitespace after the colon before deciding, so a value of
 * spaces alone reads as a removal too. A value this answers false for is
 * therefore never spelled `key + ": " + value`: a request row goes out in
 * libcurl's empty-header form `Key;` instead (issue #3220).
 */
[[nodiscard]] bool has_header_value (std::string_view value);

/**
 * @brief The request's own `Cookie` rows as one value, for `CURLOPT_COOKIE`.
 *
 * Every row named `Cookie` that has a value (`has_header_value`), trimmed of its edge
 * whitespace and joined with `; ` in row order; empty when there is none.
 * libcurl writes this after the jar's matches on one `Cookie` line, so a
 * request never carries two (RFC 6265 section 5.4, issue #2788); a redirect
 * to another origin drops it, as it would a listed `Cookie` header.
 */
[[nodiscard]] std::string typed_cookie_value (const Request& request);

/**
 * @brief Build the `CURLOPT_HTTPHEADER` list for a request, and record what it
 *        puts on the wire.
 *
 * The one place a driver's outbound header set is decided: the request's own
 * headers minus the suppressed, plus what the engine derives - the
 * body-implied Content-Type, and the declared defaults @p policy carries for a
 * name the request does not (see `http/default_headers.hpp`). All three
 * drivers - the single-request client, the load event loop and the SSE stream
 * consumer - call this, so none of them can disagree about what goes out.
 *
 * It has no error channel, deliberately: a header it cannot append it drops.
 * Text that must be *refused* rather than dropped is caught one step earlier,
 * by `validate_transferable`, which every one of those drivers already calls.
 *
 * `Accept-Encoding` is the one default recorded without being appended: it
 * reaches the wire through `CURLOPT_ACCEPT_ENCODING`, which is what makes
 * libcurl decode the response it asks for, and appending the line here as well
 * would send it twice. `negotiates_compression` is the single predicate both
 * this function and the driver read, so the record cannot claim an encoding the
 * transfer did not ask for.
 *
 * libcurl writes `application/x-www-form-urlencoded` into a POSTFIELDS body or
 * a bodyless POST whose list names no Content-Type. The engine never leaves it
 * that gap (issue #2464): where nothing declared a type, the list carries
 * libcurl's removal line `Content-Type:`, which is not a sent header and is not
 * recorded as one.
 *
 * The request's own lines go first, one list line per `HeaderList` line in
 * the order the request holds them (issue #2466): a repeated name is sent
 * repeated, and authored order is wire order.
 *
 * A request line whose value is empty or only whitespace is sent empty, as
 * libcurl's `Name;` (see `has_header_value`), and recorded with the value `""`
 * (issue #3220). Removing a default is `suppressed_default_headers`' job, never
 * a blank row's. A blank `Content-Type` is the one line not sent: it means "no
 * Content-Type", so the body's implied type stays off (on a binary body, where
 * it is absent instead, the file's type applies) and so does libcurl's form
 * type.
 *
 * `Cookie` is the exception (issue #2788): its rows are recorded, one entry
 * per row as typed, but never appended. libcurl ignores `CURLOPT_COOKIE`
 * while the list names a Cookie and writes the jar's matches on a line of
 * their own, so a listed row would put two `Cookie` lines on the wire.
 * `apply_default_header_options` hands the rows to libcurl instead, as
 * `typed_cookie_value`, and libcurl merges them into the jar's line. A blank
 * `Cookie` row joins nothing into it and is not recorded.
 *
 * libcurl also adds `Expect: 100-continue` to an HTTP/1.1 body over 1 MiB and
 * waits a second for the interim reply (issue #2468). Unless
 * `policy.expect_continue` is on, the list carries the removal line `Expect:`,
 * unrecorded for the same reason. A request that types an Expect sends it as
 * typed, a blank one as `Expect;`, and gets no removal line: libcurl adds none
 * of its own beside a listed Expect. With the policy on, nothing is appended and
 * libcurl decides, unless the send refuses the `Expect` default
 * (`suppresses_default_header`), which removes it again.
 *
 * @param sent When non-null, cleared and filled with exactly the lines
 *        appended to the returned list, in order. That is
 *        `Response::request_headers`,
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
const DefaultHeaderPolicy& policy,
HeaderList* sent);

/**
 * @brief Apply the transfer options a header rides on rather than a header
 *        line: compression negotiation and the request's typed `Cookie`.
 *
 * Always sets `CURLOPT_ACCEPT_ENCODING` and `CURLOPT_COOKIE`, clearing each
 * when this transfer has nothing for it: the load driver's handles come from a
 * pool, so an option left on from the transfer before would ask for an
 * encoding this one refused, or send a cookie this one never typed.
 */
void apply_default_header_options (CURL* curl,
const Request& request,
const DefaultHeaderPolicy& policy);

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
 * @brief The same ingest, also appending the line as received to @p lines.
 *
 * `headers` is updated exactly as the two-argument form does. When @p lines is
 * not null the line is appended to it as well (issue #2460): name with its case
 * kept, value trimmed of leading and trailing space and tab, one entry per
 * received line in wire order, so a repeated `Set-Cookie` stays repeated. The
 * two-argument form is this one with `nullptr`; the load callback uses it and
 * pays nothing for the lossless list.
 */
void ingest_header_line (std::string_view line, Headers& headers, std::vector<HeaderLine>* lines);

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
 * Returns the scope's lines as read, before @p writes: what
 * `capture_jar_cookies` must be handed back so it can tell this transfer's
 * changes, the staged writes among them, from another transfer's.
 *
 * Shared by the single-request client and the SSE stream consumer so the two
 * cannot drift into sending different sessions for the same request.
 */
[[nodiscard]] std::vector<std::string> apply_jar_cookies (CURL* curl,
CookieJar& jar,
const std::string& scope,
const std::vector<CookieWrite>& writes);

/**
 * @brief Fold what the transfer changed in the handle's jar back into the
 *        scope (`CookieJar::reconcile`), against the @p seeded_from lines
 *        `apply_jar_cookies` returned.
 *
 * A delta rather than a replace, because transfers in one scope overlap and a
 * replace from the one finishing last would drop the other's `Set-Cookie`
 * (issue #1888).
 *
 * Called even when the transfer failed, for the same reason the timing reads
 * are: a redirect chain that dies on its last hop still collected the cookies
 * of the hops that succeeded, and dropping those would make a login flow depend
 * on the last request having gone well. A stream that ends on a cap is the same
 * case - it authenticated successfully, it just did not run to the server's own
 * end. When libcurl cannot export the handle's list the scope is left as it is.
 */
void capture_jar_cookies (CURL* curl,
CookieJar& jar,
const std::string& scope,
const std::vector<std::string>& seeded_from);

/**
 * @brief libcurl's cumulative phase timers, in seconds, for one transfer.
 *
 * Every timer counts from the transfer's start, which is before libcurl waits
 * for a connection slot (`CURLMOPT_MAX_HOST_CONNECTIONS`), so each one
 * includes that wait (#2394). `queue` is the wait as libcurl reports it
 * (`CURLINFO_QUEUE_TIME_T`); read it through @ref curl_queue_seconds.
 */
struct CurlPhaseTimes {
    double total         = 0.0;
    double queue         = 0.0;
    double namelookup    = 0.0;
    double connect       = 0.0;
    double appconnect    = 0.0;
    double pretransfer   = 0.0;
    double starttransfer = 0.0;
};

/**
 * @brief Read the phase timers off a handle (valid even after a failed transfer).
 */
CurlPhaseTimes read_phase_times (CURL* curl);

/**
 * @brief Add one hop's timers to a chain's, field by field (#3300).
 *
 * Each timer summed over the requests of a chain: the engine follows one
 * transfer per hop, reads each hop's timers and sums them here, so its wire time covers every
 * hop and the queue wait does not absorb the earlier ones.
 */
void add_phase_times (CurlPhaseTimes& total, const CurlPhaseTimes& hop);

/**
 * @brief How long libcurl held the transfer waiting for a connection slot, in
 *        seconds: `CURLINFO_QUEUE_TIME_T`, bounded by PRETRANSFER and TOTAL.
 *
 * curl 8.23 overstates the raw reading: every retry out of the pending state
 * adds the whole wait so far again (`TIMER_POSTQUEUE` in lib/progress.c), so a
 * transfer passed over more than once can report more queue than its total -
 * measured, 6006ms on a 2027ms transfer. The wait ends before PRETRANSFER,
 * which is stamped once, so that bounds it. The bound's cost: a slot that
 * opens a fresh connection after a retried wait counts its DNS, connect and
 * TLS as queue. A transfer that never reached PRETRANSFER is bounded by TOTAL
 * alone.
 */
[[nodiscard]] double curl_queue_seconds (const CurlPhaseTimes& times);

/**
 * @brief The transfer's time on the wire, in seconds: TOTAL less
 *        @ref curl_queue_seconds.
 */
[[nodiscard]] double wire_seconds (const CurlPhaseTimes& times);

/**
 * @brief Turn cumulative phase timers into the non-negative per-phase durations
 *        stored in `Timing` and rendered by the app.
 *
 * Each timer is measured after libcurl's queue (@ref curl_queue_seconds), so a
 * transfer that waited for a slot on a reused connection does not report the
 * wait as time to first byte. `CURLINFO_APPCONNECT_TIME` is 0 for plain HTTP
 * and for a reused keep-alive connection, so the naive successive differences
 * render TLS as a negative duration and let TTFB absorb the connect time. A
 * zero appconnect means "no TLS phase" and collapses onto connect; every delta
 * is clamped at 0.
 */
void apply_phase_timings (Timing& timing, const CurlPhaseTimes& times);

/**
 * @brief A finished transfer's `Timing` from its clocks: @p perceived_ms as the
 *        total, @ref wire_seconds as the wire time, the rest as queue wait,
 *        and the phases.
 *
 * The one copy the event loop, the Client and the SSE stream share, so a
 * design send and a load run cannot disagree about what queue wait means.
 */
void apply_transfer_timing (Timing& timing, const CurlPhaseTimes& times, double perceived_ms);

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
 *
 * A transfer that followed redirects (`TransferData::redirects`) reports every
 * hop's timers and wire bytes, the earlier hops' summed with this one's, and
 * a chain that ended on a redirect it would not follow reports that refusal
 * in place of the redirect's status.
 */
Result<Response> extract_response (CURL* curl, TransferData* data, CURLcode result);

// ---------------------------------------------------------------------------
// Redirects, one transfer per hop (#3302)
// ---------------------------------------------------------------------------

/// A transfer's bytes on the wire, headers and bodies both ways: received is
/// `CURLINFO_SIZE_DOWNLOAD_T` plus `CURLINFO_HEADER_SIZE`, sent is
/// `CURLINFO_REQUEST_SIZE`, which already holds every body byte sent.
struct WireBytes {
    size_t down = 0;
    size_t up   = 0;
};

/**
 * @brief What a transfer that follows redirects keeps across its hops, made at
 *        the first redirect it follows, so a transfer never redirected carries
 *        none of it.
 *
 * Each hop is a transfer of its own on the transfer's handle, which is never
 * reset in between: its cookie engine and connections serve the whole chain.
 */
struct RedirectState {
    /// Takes over `TransferData::headers_list`, the first hop's lines.
    explicit RedirectState (TransferData& data);

    RedirectChain chain;
    /// Present when the transfer carries a cookie session
    /// (`Request::track_cookies`).
    std::optional<HopCookies> cookies;
    /// The finished hops' timers, summed; the last hop's are read at completion.
    CurlPhaseTimes phases;
    /// The finished hops' wire bytes, likewise.
    WireBytes bytes;
    /// Why the chain ended on a redirect it was answered with rather than
    /// following it: the limit, a refused `Location` or the timeout spent.
    /// A handle curl will not take back for the next hop completes as a bare
    /// error instead (`deliver`).
    std::optional<Error> refusal;
};

/// The hop a finished transfer's redirect sends it to next.
struct RedirectHop {
    /// The redirect status that asked for it.
    int status = 0;
    std::string url;
    /// What is left of the request's timeout for it, 0 to leave the handle's.
    long timeout_ms = 0;
};

/**
 * @brief The redirect a transfer of @p data that finished with @p result on
 *        @p curl follows next, or nullopt when what it finished with is the
 *        request's answer.
 *
 * Reads the status only after a `CURLE_OK` on a request that follows, and the
 * `Location` only after a 3xx, so a transfer that is not redirected pays one
 * status read. A redirect the chain will not follow (the request's
 * `max_redirects`, negative being no limit; a `Location`
 * `resolve_redirect_target` refuses; the timeout spent) is recorded on
 * `RedirectState::refusal` and answers nullopt. A hop that is followed has
 * its timers and wire bytes folded into `TransferData::redirects`.
 *
 * Call before anything resets @p curl; it may still be in its multi handle.
 */
[[nodiscard]] std::optional<RedirectHop>
next_redirect_hop (CURL* curl, TransferData& data, CURLcode result);

/**
 * @brief Points @p curl, out of its multi handle, at @p hop: the URL, method,
 *        body and request lines `RedirectChain::advance` puts there, the
 *        hop's share of the timeout, the DNS pin for its host, and the
 *        transport policy matched against its own origin, which is what
 *        presents the client certificate registered for it. What the last hop
 *        wrote is cleared.
 *
 * Requires @p hop to be what `next_redirect_hop` answered for @p data.
 */
void start_redirect_hop (CURL* curl,
TransferData& data,
RedirectHop hop,
const EventLoopConfig& config,
DnsCache* dns_cache);

} // namespace vayu::http::detail
