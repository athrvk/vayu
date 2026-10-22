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
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string_view>

#include "vayu/core/constants.hpp"
#include "vayu/http/curl_options.hpp"
#include "vayu/http/curl_version_map.hpp"
#include "vayu/http/event_loop/curl_callbacks.hpp"
#include "vayu/http/event_loop/event_loop_worker.hpp"
#include "vayu/http/event_loop/transfer_context.hpp"
#include "vayu/http/file_ref.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/header_text.hpp"
#include "vayu/http/loopback_guard.hpp"
#include "vayu/http/status.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/parse.hpp"

namespace vayu::http::detail {

namespace {

/// Lowest and highest port a URL authority can name; anything else is not a
/// port curl could dial, so it is treated as absent.
constexpr int kMinPort = 1;
constexpr int kMaxPort = 65535;

/// A scheme is case-insensitive (RFC 3986), and curl dials a scheme-less URL as
/// http, so only an explicit `https` takes 443.
int scheme_default_port (const std::string& url) {
    return vayu::utils::ascii_lower_equal (vayu::http::url_scheme (url), "https") ? 443 : 80;
}

/// A digit run from a user-supplied URL can exceed any integer type.
/// `parse_number` reports that as an empty optional where std::stoi would
/// throw - and this runs on the event loop worker thread, which has no
/// handler, so an escaping exception terminates the whole daemon.
std::optional<int> parse_port (std::string_view digits) {
    const std::optional<int> port = vayu::utils::parse_number<int> (digits);
    if (port.has_value () && *port >= kMinPort && *port <= kMaxPort) {
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

    const auto span = vayu::http::url_host_span (url);
    if (!span) {
        return authority; // An unclosed IPv6 literal - no host we could trust.
    }
    const std::string_view whole (url);
    std::string_view host      = whole.substr (span->begin, span->size);
    const std::size_t host_end = span->begin + span->size;
    const std::string_view after = whole.substr (host_end, span->authority_end - host_end);
    if (!after.empty () && after.front () != ':') {
        return authority; // Junk after an IPv6 literal - malformed.
    }
    const std::string_view port_digits = after.empty () ? after : after.substr (1);

    if (span->bracketed) {
        host                    = host.substr (1, host.size () - 2);
        authority.is_ip_literal = true;
        authority.host          = std::string (host);
    } else {
        authority.is_ip_literal = looks_like_ipv4_literal (host);
        // The name the transfer dials (`wire_url`), which for a non-ASCII host
        // is its punycode: a DNS-cache pin or a client-certificate match keyed
        // on the Unicode spelling would never meet the transfer it was for. A
        // host with no ASCII name is kept as typed; that send is refused.
        authority.host = vayu::http::ascii_host (host).value_or (std::string (host));
    }
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
    // Every URL rule reads the URL the handle is given, not `request.url`:
    // with encoding on, `wire_url` drops leading whitespace and turns `\` into
    // `/`, so the typed text can name a different scheme, host or port than
    // the one dialled (#2465).
    const std::string url = vayu::http::wire_url (request);
    // First, because nothing else about a request matters if it is not HTTP.
    // `apply_transport_policy`'s protocol allowlist is the backstop for what
    // this cannot see: a redirect, and a scheme libcurl guesses for a URL that
    // names none.
    if (auto problem = vayu::http::unsendable_scheme (url)) {
        return Error{ ErrorCode::InvalidUrl, "Cannot send this request: " + *problem };
    }
    // The body-level answer on purpose: this gate is about a body existing at
    // all, and a `graphql` body on a HEAD is still one to refuse - the GET
    // transport that moves it into the URL is GET's alone (issue #1228).
    const bool has_body = vayu::http::has_wire_body (request.body);
    if (has_body && request.method == HttpMethod::HEAD) {
        return Error{ ErrorCode::InvalidMethod,
            "HEAD requests cannot carry a body - remove the body or use GET" };
    }
    // The file rule (`file_ref.hpp`) ran once for this send or run, before
    // any driver; what is left here is the proof it did.
    if (has_body) {
        if (auto unplanned = vayu::http::unplanned_file_ref (request.body)) {
            return Error{ ErrorCode::InternalError, std::move (*unplanned) };
        }
    }
    // Header text that would end or truncate the line it is written into. Here
    // rather than in `build_request_header_list` because that function has no
    // error channel - `append` can only drop, and a silent drop is the quiet
    // wrong request this refusal exists to prevent. This gate runs before any
    // driver configures a handle, so it covers every origin at once: a composed
    // variable, a script's assignment to `pm.request.headers`, an auth
    // credential, an import, a raw `POST /execute` payload. See header_text.hpp
    // for why the rule is a refusal and where its other layers live.
    if (auto problem = vayu::http::unsendable_header_text (request)) {
        return Error{ ErrorCode::InternalError, std::move (*problem) };
    }
    // `wire_url` sends a non-ASCII host by its punycode name, and one with no
    // such name has nothing to send to.
    if (auto problem = vayu::http::unsendable_host (url)) {
        return Error{ ErrorCode::InvalidUrl, "Cannot send this request: " + *problem };
    }
    // The literal half of the loopback guard (#2355): a URL naming Vayu's own
    // port is refused before anything is dialled, proxy or not. Redirects and
    // names that resolve there are the pre-request callback's
    // (`apply_transport_policy`).
    if (const auto port = vayu::http::reserved_target_port (url)) {
        return Error{ ErrorCode::InvalidUrl,
            "Cannot send this request: " + vayu::http::reserved_target_refusal (*port) };
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

namespace {

/// libcurl's read callback over a `FileReader`, for a streamed binary body and
/// a file part alike. Never reads past the size the open saw.
size_t read_approved (char* buffer, size_t size, size_t nitems, void* arg) {
    auto* reader                  = static_cast<FileReader*> (arg);
    const std::uint64_t remaining = reader->file->size () - reader->offset;
    const auto wanted =
    static_cast<size_t> (std::min<std::uint64_t> (size * nitems, remaining));
    const auto got =
    reader->file->read_at (reader->offset, std::span<char> (buffer, wanted));
    if (!got) {
        return CURL_READFUNC_ABORT;
    }
    // A file truncated under the handle reads 0 before the promised length
    // (`INFILESIZE_LARGE`, a part's size), which libcurl refuses on its own,
    // naming the bytes it missed.
    reader->offset += *got;
    return *got;
}

/// libcurl rewinds the body for a redirect or an auth retry. It passes only
/// `SEEK_SET` (as of 8.23, to an upload's and a part's callback alike), so any
/// other origin is answered as unseekable rather than guessed at.
int seek_approved (void* arg, curl_off_t offset, int origin) {
    auto* reader = static_cast<FileReader*> (arg);
    if (origin != SEEK_SET || offset < 0 ||
    static_cast<std::uint64_t> (offset) > reader->file->size ()) {
        return CURL_SEEKFUNC_CANTSEEK;
    }
    reader->offset = static_cast<std::uint64_t> (offset);
    return CURL_SEEKFUNC_OK;
}

void free_part (void* arg) {
    const std::unique_ptr<FileReader> reader (static_cast<FileReader*> (arg));
}

/// A file part read from the file the plan approved, never from `src`
/// (#2416); `validate_transferable` has refused a part without one.
void attach_file_part (curl_mimepart* part, const FormField& field) {
    // Owned by the part once attached: libcurl calls `free_part` with it. The
    // open file stays shared by every transfer of the request or the run.
    FileReader* reader =
    std::make_unique<FileReader> (FileReader{ field.approved, 0 }).release ();
    if (curl_mime_data_cb (part, static_cast<curl_off_t> (field.approved->size ()),
        &read_approved, &seek_approved, &free_part, reader) != CURLE_OK) {
        free_part (reader);
    }
    curl_mime_filename (part, vayu::http::declared_file_name (field).c_str ());
    curl_mime_type (part, vayu::http::file_part_content_type (field).c_str ());
}

/// A `form-data` body as a libcurl multipart tree, owned by @p source.
void attach_multipart (CURL* curl, const Request& request, BodySource& source) {
    // Multipart: libcurl encodes the parts and generates the boundary, so
    // the body and the Content-Type that describes it cannot disagree.
    curl_mime* mime = curl_mime_init (curl);
    source.mime     = mime;
    for (const auto& field : vayu::http::enabled_fields (request.body.fields)) {
        curl_mimepart* part = curl_mime_addpart (mime);
        curl_mime_name (part, field.key.c_str ());
        if (field.type == FormFieldType::File) {
            attach_file_part (part, field);
            continue;
        }
        curl_mime_data (part, field.value.c_str (), field.value.size ());
        if (!field.content_type.empty ()) {
            curl_mime_type (part, field.content_type.c_str ());
        }
    }
    // Like POSTFIELDS below, this switches curl's method to POST, so the
    // method is (re-)asserted afterwards.
    set_opt<CURLOPT_MIMEPOST> (curl, mime);
}

/// A binary body: the plan's shared bytes, or the file the plan approved
/// streamed through @p source, never `src` (#2678); `validate_transferable`
/// has refused a body with neither. True when it streams, which sets
/// `CURLOPT_UPLOAD`.
bool attach_binary (CURL* curl, const Request& request, BodySource& source) {
    const FileRef& file = request.body.file;
    if (file.inline_bytes) {
        // Read once by the plan and shared by every transfer of the run:
        // POSTFIELDS keeps the pointer, and the request this transfer
        // carries holds the bytes alive for as long as it does.
        set_opt<CURLOPT_POSTFIELDSIZE_LARGE> (
        curl, static_cast<curl_off_t> (file.inline_bytes->size ()));
        set_opt<CURLOPT_POSTFIELDS> (curl, file.inline_bytes->data ());
        return false;
    }
    source.stream = FileReader{ file.approved, 0 };
    set_opt<CURLOPT_UPLOAD> (curl, 1L);
    set_opt<CURLOPT_INFILESIZE_LARGE> (
    curl, static_cast<curl_off_t> (file.approved->size ()));
    set_opt<CURLOPT_READFUNCTION> (curl, &read_approved);
    set_opt<CURLOPT_READDATA> (curl, &source.stream);
    // Mandatory, not an optimisation: a redirect and the second leg of Digest
    // or NTLM rewind the body, and without a seek callback libcurl fails that
    // leg instead of resending.
    set_opt<CURLOPT_SEEKFUNCTION> (curl, &seek_approved);
    set_opt<CURLOPT_SEEKDATA> (curl, &source.stream);
    return true;
}

} // namespace

void apply_method_and_body (CURL* curl, const Request& request, BodySource& source) {
    // The request-level answer, not the body-level one: a GraphQL body on a
    // GET travels in the URL, so this is where "no body frame" comes from and
    // what makes the GET arm below take `CURLOPT_HTTPGET` (issue #1228).
    const bool has_body = vayu::http::has_wire_body (request);
    // A streamed binary body: `CURLOPT_UPLOAD` is set, so the method below is
    // re-asserted by name for every verb, POST included.
    bool uploads = false;

    if (has_body && request.body.mode == BodyMode::FormData) {
        attach_multipart (curl, request, source);
    } else if (has_body && request.body.mode == BodyMode::Binary) {
        uploads = attach_binary (curl, request, source);
    } else if (has_body) {
        // Setting POSTFIELDS switches curl's method to POST, so it goes first
        // and the method is (re-)asserted below.
        //
        // COPYPOSTFIELDS rather than POSTFIELDS because the body is built here
        // and dies at the end of this scope, while POSTFIELDS keeps only a
        // pointer that has to outlive the transfer.
        const std::string body = vayu::http::wire_body_bytes (request);
        set_opt<CURLOPT_POSTFIELDSIZE> (curl, static_cast<long> (body.size ()));
        set_opt<CURLOPT_COPYPOSTFIELDS> (curl, body.c_str ());
    }

    if (uploads) {
        // `CURLOPT_UPLOAD` makes every transfer a PUT; the verb the request
        // names is restored by name. HEAD never reaches here - a body on it is
        // refused by validate_transferable.
        set_opt<CURLOPT_CUSTOMREQUEST> (curl, to_string (request.method));
        return;
    }

    switch (request.method) {
    case HttpMethod::GET:
        // A body-bearing GET (Elasticsearch-style search) keeps its method only
        // via CUSTOMREQUEST; CURLOPT_HTTPGET would drop the body it just set.
        if (has_body) {
            set_opt<CURLOPT_CUSTOMREQUEST> (curl, "GET");
        } else {
            set_opt<CURLOPT_HTTPGET> (curl, 1L);
        }
        break;
    case HttpMethod::POST:
        // CURLOPT_POST would *discard* a multipart body: it switches curl back
        // to a POSTFIELDS-style post, and the mime attached above goes with it.
        // MIMEPOST already makes the request a POST, so re-asserting the verb
        // is both unnecessary and destructive here.
        if (source.mime == nullptr) {
            set_opt<CURLOPT_POST> (curl, 1L);
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
                set_opt<CURLOPT_POSTFIELDSIZE> (curl, 0L);
            }
        }
        break;
    case HttpMethod::PUT: set_opt<CURLOPT_CUSTOMREQUEST> (curl, "PUT"); break;
    case HttpMethod::DELETE:
        set_opt<CURLOPT_CUSTOMREQUEST> (curl, "DELETE");
        break;
    case HttpMethod::PATCH:
        set_opt<CURLOPT_CUSTOMREQUEST> (curl, "PATCH");
        break;
    // A body here is refused by validate_transferable, so NOBODY cannot drop one.
    case HttpMethod::HEAD: set_opt<CURLOPT_NOBODY> (curl, 1L); break;
    case HttpMethod::OPTIONS:
        set_opt<CURLOPT_CUSTOMREQUEST> (curl, "OPTIONS");
        break;
    }
}

std::string body_content_type_value (const Request& request) {
    std::string implied = vayu::http::implied_content_type (request);
    if (implied.empty ()) {
        return {};
    }
    // A Content-Type the caller set wins - the same rule the request builder
    // applies renderer-side, where "someone who typed this means it". For a
    // binary body an empty row is absent rather than a removal, as an empty
    // `FileRef::content_type` is: the file's own type then applies, where a
    // removal would leave the upload with no type at all.
    const bool declared = std::any_of (request.headers.begin (),
    request.headers.end (), [&request] (const HeaderLine& line) {
        return CaseInsensitiveLess::equal (line.name, "Content-Type") &&
        (request.body.mode != BodyMode::Binary ||
        header_value_reaches_wire (line.value));
    });
    return declared ? std::string () : implied;
}

bool suppresses_request_header (const Request& request, const std::string& key) {
    return vayu::http::content_type_is_engine_owned (request.body) &&
    CaseInsensitiveLess::equal (key, "Content-Type");
}

bool header_value_reaches_wire (std::string_view value) {
    return std::any_of (value.begin (), value.end (),
    [] (char c) { return std::isspace (static_cast<unsigned char> (c)) == 0; });
}

namespace {

/// True when libcurl writes `Content-Type: application/x-www-form-urlencoded`
/// into this transfer if the header list names none (lib/http.c, every
/// `HTTPREQ_POST`): any body `apply_method_and_body` hands over as POSTFIELDS,
/// whatever verb is restored afterwards, and a bodyless POST. Multipart is the
/// exception, its type carries the boundary. A binary file that streams is a
/// PUT to libcurl, where the removal line this answers for removes nothing.
bool libcurl_defaults_content_type (const Request& request) {
    if (vayu::http::has_wire_body (request)) {
        return !vayu::http::content_type_is_engine_owned (request.body);
    }
    return request.method == HttpMethod::POST;
}

/// True when the list must carry the removal line `Expect:` (issue #2468).
/// libcurl adds `Expect: 100-continue` to an HTTP/1.1 body over 1 MiB and then
/// waits a second for an interim reply a server may never send, so it stays
/// only where `sendExpectContinue` is on. @p lists_expect is a typed Expect
/// that reached the list: the way to send one on purpose, sent as typed. A
/// typed row left blank never gets there (`append` drops it), which is the gap
/// libcurl fills, so it does not count. Refusing the declared row removes
/// libcurl's own line when the policy would have let it stay.
bool removes_libcurl_expect (const Request& request,
const DefaultHeaderPolicy& policy,
bool lists_expect) {
    if (lists_expect) {
        return false;
    }
    return !policy.expect_continue || suppresses_default_header (request, "Expect");
}

} // namespace

curl_slist* build_request_header_list (const Request& request,
const DefaultHeaderPolicy& policy,
HeaderList* sent) {
    curl_slist* list = nullptr;
    if (sent != nullptr) {
        sent->clear ();
    }

    // Every header goes out through here, so the wire and the sent record are
    // the same decision made once. A value libcurl would read as a removal is
    // neither appended nor reported.
    const auto record = [&] (const std::string& key, const std::string& value) {
        if (sent != nullptr) {
            sent->add (key, value);
        }
    };
    // True when the line went on the list.
    const auto append = [&] (const std::string& key, const std::string& value) {
        if (!header_value_reaches_wire (value)) {
            return false;
        }
        const std::string line = key + ": " + value;
        list                   = curl_slist_append (list, line.c_str ());
        record (key, value);
        return true;
    };
    // A default the request already names is not added: someone who typed the
    // header means it, the same rule the body-implied Content-Type follows.
    const auto adds_default = [&] (std::string_view name) {
        return !request.headers.contains (name) &&
        !suppresses_default_header (request, name);
    };

    bool lists_content_type = false;
    bool lists_expect       = false;
    for (const auto& [key, value] : request.headers) {
        if (suppresses_request_header (request, key)) {
            // Not sent, so not reported as sent either - libcurl writes the
            // multipart Content-Type, boundary and all.
            continue;
        }
        if (!append (key, value)) {
            continue;
        }
        lists_content_type =
        lists_content_type || CaseInsensitiveLess::equal (key, "Content-Type");
        lists_expect = lists_expect || CaseInsensitiveLess::equal (key, "Expect");
    }

    // The Content-Type the body mode implies, when the request declares none.
    // Empty when neither holds - which `append` drops, as it drops any
    // value-less header.
    if (!suppresses_default_header (request, "Content-Type") &&
    append ("Content-Type", body_content_type_value (request))) {
        lists_content_type = true;
    }
    if (!lists_content_type && libcurl_defaults_content_type (request)) {
        // Nothing declared a type: a refused one (issue #1765, Postman's
        // `disabledSystemHeaders`), a typed row left blank, a bodyless POST.
        // The engine never leaves libcurl that gap to fill with its form type
        // (#2464). `Content-Type:` with nothing after it is libcurl's spelling
        // of "remove the line", so it is appended directly - `append` drops a
        // value-less header - and not recorded as sent.
        list = curl_slist_append (list, "Content-Type:");
    }

    if (adds_default ("User-Agent")) {
        append ("User-Agent", policy.user_agent);
    }

    if (!policy.correlation_header.empty () && adds_default (policy.correlation_header)) {
        // Generated here rather than resolved with the policy, so every
        // transfer of a load run carries its own id instead of replaying the
        // one that was stored - the defect issue #1229 was filed for.
        append (policy.correlation_header, vayu::utils::generate_id (""));
    }

    // libcurl adds `Accept: */*` to every request that names no Accept. A
    // request that refuses it (issue #1765) gets libcurl's removal line
    // instead, appended directly for the reason the Content-Type one is.
    if (!request.headers.contains ("Accept") && suppresses_default_header (request, "Accept")) {
        list = curl_slist_append (list, "Accept:");
    }

    // Appended directly and unrecorded, like the other removal lines above.
    if (removes_libcurl_expect (request, policy, lists_expect)) {
        list = curl_slist_append (list, "Expect:");
    }

    if (negotiates_compression (request, policy)) {
        // Recorded, not appended: libcurl writes this line itself from
        // `CURLOPT_ACCEPT_ENCODING` (see apply_default_header_options), which
        // is what makes it decode the response. Appending it here as well
        // would put the header on the wire twice.
        record ("Accept-Encoding", policy.accept_encoding);
    }

    return list;
}

void apply_default_header_options (CURL* curl,
const Request& request,
const DefaultHeaderPolicy& policy) {
    const char* encodings =
    negotiates_compression (request, policy) ? policy.accept_encoding.c_str () : nullptr;
    // Set either way: the load driver's handles are pooled, so leaving the
    // option alone would carry the previous transfer's negotiation into one
    // that refused it.
    set_opt<CURLOPT_ACCEPT_ENCODING> (curl, encodings);
}

namespace {

// RFC 9110 section 5.5: the optional whitespace around a field value, space and
// tab, is not part of it.
std::string_view trim_optional_whitespace (std::string_view value) {
    constexpr std::string_view OWS = " \t";
    const auto first               = value.find_first_not_of (OWS);
    if (first == std::string_view::npos) {
        return {};
    }
    return value.substr (first, value.find_last_not_of (OWS) - first + 1);
}

} // namespace

void ingest_header_line (std::string_view line, Headers& headers) {
    ingest_header_line (line, headers, nullptr);
}

void ingest_header_line (std::string_view line, Headers& headers, std::vector<HeaderLine>* lines) {
    const auto colon_pos = line.find (':');
    if (colon_pos == std::string_view::npos) {
        return;
    }

    const auto name = line.substr (0, colon_pos);
    auto value      = line.substr (colon_pos + 1);
    while (!value.empty () && value.front () == ' ') {
        value.remove_prefix (1);
    }

    if (lines != nullptr) {
        lines->push_back (HeaderLine{
        std::string (name), std::string (trim_optional_whitespace (value)) });
    }

    auto [it, inserted] = headers.try_emplace (vayu::utils::ascii_lower (name), value);
    if (!inserted) {
        it->second += ", ";
        it->second.append (value);
    }
}

std::vector<std::string> apply_jar_cookies (CURL* curl,
CookieJar& jar,
const std::string& scope,
const std::vector<CookieWrite>& writes) {
    set_opt<CURLOPT_COOKIEFILE> (curl, "");
    set_opt<CURLOPT_COOKIELIST> (curl, "ALL");
    auto seeded_from = jar.lines_for (scope);
    for (const auto& line : apply_cookie_writes (seeded_from, writes)) {
        set_opt<CURLOPT_COOKIELIST> (curl, line.c_str ());
    }
    return seeded_from;
}

void capture_jar_cookies (CURL* curl,
CookieJar& jar,
const std::string& scope,
const std::vector<std::string>& seeded_from) {
    struct curl_slist* held = nullptr;
    if (get_info<CURLINFO_COOKIELIST> (curl, &held) != CURLE_OK) {
        return;
    }
    std::vector<std::string> lines;
    for (const struct curl_slist* item = held; item != nullptr; item = item->next) {
        if (item->data) {
            lines.emplace_back (item->data);
        }
    }
    curl_slist_free_all (held);
    jar.reconcile (scope, seeded_from, lines);
}

CurlPhaseTimes read_phase_times (CURL* curl) {
    CurlPhaseTimes times;
    get_info<CURLINFO_TOTAL_TIME> (curl, &times.total);
    curl_off_t queue_us = 0;
    get_info<CURLINFO_QUEUE_TIME_T> (curl, &queue_us);
    times.queue = static_cast<double> (queue_us) / 1e6;
    get_info<CURLINFO_NAMELOOKUP_TIME> (curl, &times.namelookup);
    get_info<CURLINFO_CONNECT_TIME> (curl, &times.connect);
    get_info<CURLINFO_APPCONNECT_TIME> (curl, &times.appconnect);
    get_info<CURLINFO_PRETRANSFER_TIME> (curl, &times.pretransfer);
    get_info<CURLINFO_STARTTRANSFER_TIME> (curl, &times.starttransfer);
    return times;
}

double curl_queue_seconds (const CurlPhaseTimes& times) {
    const double ceiling =
    times.pretransfer > 0.0 ? std::min (times.pretransfer, times.total) : times.total;
    return std::max (0.0, std::min (times.queue, ceiling));
}

double wire_seconds (const CurlPhaseTimes& times) {
    return times.total - curl_queue_seconds (times);
}

void apply_phase_timings (Timing& timing, const CurlPhaseTimes& times) {
    const double queue     = curl_queue_seconds (times);
    const auto after_queue = [queue] (double timer) {
        return std::max (0.0, timer - queue);
    };
    const double namelookup = after_queue (times.namelookup);
    const double connect    = after_queue (times.connect);
    const double appconnect =
    times.appconnect > 0.0 ? after_queue (times.appconnect) : connect;
    const double starttransfer = after_queue (times.starttransfer);
    timing.dns_ms              = namelookup * 1000.0;
    timing.connect_ms = std::max (0.0, (connect - namelookup) * 1000.0);
    timing.tls_ms     = std::max (0.0, (appconnect - connect) * 1000.0);
    timing.first_byte_ms = std::max (0.0, (starttransfer - appconnect) * 1000.0);
    timing.download_ms =
    std::max (0.0, (after_queue (times.total) - starttransfer) * 1000.0);
}

void apply_transfer_timing (Timing& timing, const CurlPhaseTimes& times, double perceived_ms) {
    timing.total_ms      = perceived_ms;
    timing.wire_ms       = wire_seconds (times) * 1000.0;
    timing.queue_wait_ms = std::max (0.0, perceived_ms - timing.wire_ms);
    apply_phase_timings (timing, times);
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
    if (get_info<CURLINFO_HTTP_CONNECTCODE> (curl, &connect_code) != CURLE_OK) {
        return false;
    }
    return connect_code >= 400;
}

namespace {

/**
 * The user's trust anchors (issue #706) and the native-store flag.
 *
 * Written on every handle, empty path included, for the reason the proxy options
 * are: handles are reused, so a bundle left behind by a previous policy would
 * outlive the setting that asked for it. Null restores the backend's own default.
 */
void apply_ca_options (CURL* curl, const TransportPolicy& policy) {
    const char* const bundle = policy.ca_bundle_path.empty () ?
    static_cast<const char*> (nullptr) :
    policy.ca_bundle_path.c_str ();

    // The return code is checked because this is the one transport option a
    // TLS backend can refuse outright - `CURLE_NOT_BUILT_IN` from a backend
    // with no CAINFO support - and a silently ignored bundle means every
    // request fails verification with nothing anywhere saying the certificates
    // were never loaded. Logged once per process: the load path applies a
    // policy per transfer, and a per-request line would be the log.
    //
    // The bundle is written for the proxy's TLS leg as well (#2469): libcurl
    // keeps the proxy's trust anchors in their own options, defaulting to the
    // backend's store rather than to what the origin leg was given, so an
    // https:// proxy behind an internal CA would otherwise fail verification
    // with the CA pasted.
    const CURLcode origin_result = set_opt<CURLOPT_CAINFO> (curl, bundle);
    const CURLcode proxy_result  = set_opt<CURLOPT_PROXY_CAINFO> (curl, bundle);
    const CURLcode ca_result = origin_result != CURLE_OK ? origin_result : proxy_result;
    if (ca_result != CURLE_OK && !policy.ca_bundle_path.empty ()) {
        static std::once_flag warned;
        std::call_once (warned, [ca_result] {
            const curl_version_info_data* info = curl_version_info (CURLVERSION_NOW);
            vayu::utils::log_error ("client",
            "This build's TLS backend (" +
            std::string (info != nullptr && info->ssl_version != nullptr ? info->ssl_version : "unknown") +
            ") refused a custom CA bundle: " + std::string (curl_easy_strerror (ca_result)) +
            ". Custom CA certificates are not in use on this platform.");
        });
    }

    // Ask the backend to consult the operating system's own store as well. On
    // an OpenSSL build CAINFO *replaces* the default bundle, which is why the
    // materialized file already carries the system anchors on the platforms
    // that keep them in a file.
    //
    // Windows is the platform that does not, and since #851 it is an OpenSSL
    // build like the others - so the flag is unconditional there, not only
    // when a bundle is in force. An OpenSSL build on Windows has no CA file to
    // fall back to: `curl_version_info()->cainfo` names a path from the
    // machine the port was built on, which does not exist on the user's, so a
    // Windows handle without this flag and without a paste trusts *nothing*
    // and every HTTPS request fails verification. With it, #706's additive
    // rule reads "the native store plus whatever the user pasted" on Windows
    // too - the store supplying the anchors the merged file does elsewhere.
    //
    // Written in both directions - the default `0` where no bundle is set and
    // the native store is not the anchor source - because a reused handle
    // would otherwise keep a flag the current policy never asked for, the rule
    // every option here follows. The proxy leg has its own copy of the flag
    // and takes the same value, for the reason the bundle is shared above.
    long ssl_options = 0L;
#ifdef _WIN32
    ssl_options |= static_cast<long> (CURLSSLOPT_NATIVE_CA);
#else
    if (!policy.ca_bundle_path.empty ()) {
        ssl_options |= static_cast<long> (CURLSSLOPT_NATIVE_CA);
    }
#endif
    set_opt<CURLOPT_SSL_OPTIONS> (curl, ssl_options);
    set_opt<CURLOPT_PROXY_SSL_OPTIONS> (curl, ssl_options);
}

/** The proxy and its bypass list, per mode. */
void apply_proxy_options (CURL* curl, const TransportPolicy& policy) {
    switch (policy.proxy_mode) {
    case ProxyMode::Environment:
        // Null restores libcurl's default, which *is* the environment pickup.
        // Written rather than skipped so a reused handle cannot keep a proxy
        // the previous policy set - see the header.
        set_opt<CURLOPT_PROXY> (curl, static_cast<const char*> (nullptr));
        break;
    case ProxyMode::System:
        // What the app resolved from the OS, or - when nothing resolved, which
        // is every headless run - the same null the environment mode writes.
        // The resolver has already decided which of those this is; an empty
        // `proxy_url` under `system` *is* the documented fallback, not a
        // half-configured state to guess about here (issue #708).
        set_opt<CURLOPT_PROXY> (curl,
        policy.proxy_url.empty () ? static_cast<const char*> (nullptr) :
                                    policy.proxy_url.c_str ());
        break;
    case ProxyMode::Manual:
        set_opt<CURLOPT_PROXY> (curl, policy.proxy_url.c_str ());
        break;
    case ProxyMode::Off:
        // Empty string, not null: an empty CURLOPT_PROXY is what disables the
        // environment pickup. Null would re-enable it, and "off" that still
        // proxies because a shell exported https_proxy is not off.
        set_opt<CURLOPT_PROXY> (curl, "");
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
    //
    // `system` follows whichever of those two it actually resolved to: with a
    // proxy in force the user's bypass list is the whole rule, exactly as under
    // `manual`, and with nothing resolved it is the environment mode and must
    // leave `no_proxy` alone.
    switch (policy.proxy_mode) {
    case ProxyMode::System:
        if (!policy.proxy_url.empty () || !policy.proxy_bypass.empty ()) {
            set_opt<CURLOPT_NOPROXY> (curl, policy.proxy_bypass.c_str ());
        } else {
            // Nothing resolved and nothing exempted: the environment mode's
            // null, so an inherited `no_proxy` still applies to the proxy this
            // mode has fallen back to reading from the environment.
            set_opt<CURLOPT_NOPROXY> (curl, static_cast<const char*> (nullptr));
        }
        break;
    case ProxyMode::Manual:
        set_opt<CURLOPT_NOPROXY> (curl, policy.proxy_bypass.c_str ());
        break;
    case ProxyMode::Environment:
        set_opt<CURLOPT_NOPROXY> (curl,
        policy.proxy_bypass.empty () ? static_cast<const char*> (nullptr) :
                                       policy.proxy_bypass.c_str ());
        break;
    case ProxyMode::Off:
        set_opt<CURLOPT_NOPROXY> (curl, static_cast<const char*> (nullptr));
        break;
    }
}

/**
 * The client identity this URL's authority matches, if any (issue #707).
 *
 * Every option is written in both directions, the rule the rest of this function
 * follows: a reused handle must not keep an identity the current policy never
 * asked for.
 */
const ClientCertRule* apply_client_certificate (CURL* curl,
const TransportPolicy& policy,
const std::string& url) {
    // Cookies need no thought here, and that is worth stating because it looks
    // like they should: libcurl owns the wire cookies and matches them on the
    // *origin* host, never the proxy hop, and curl 8.21's cross-origin
    // redirect-cookie rule keys on origin too. A proxy changes which socket
    // the bytes leave by and nothing about which jar lines apply.

    // The client certificate for this target (issue #707). Written on every
    // handle, null included, for the reason every option above is: handles are
    // reused, and a certificate left behind by a previous transfer would be
    // presented to a host that never registered one.
    //
    // The lookup is skipped entirely - URL parse included - when the registry
    // is empty, which is every user who has not opted into mTLS.
    const ClientCertRule* matched = nullptr;
    if (!policy.client_certificates.empty ()) {
        const UrlAuthority authority = parse_authority (url);
        matched = match_client_certificate (policy, authority.host, authority.port);
    }
    set_opt<CURLOPT_SSLCERT> (curl,
    matched != nullptr ? matched->cert_path.c_str () : static_cast<const char*> (nullptr));
    // What that file is (issue #833). Without it libcurl reads whatever is
    // there as PEM, so a registered `p12` bundle would be handed to the wrong
    // parser - and on a Schannel build, which took no PEM pair at all, that
    // meant presenting nothing a user registered. Written on every handle for
    // the same reason as the path beside it, and null on no match so a pooled
    // handle cannot keep the type a previous transfer set.
    set_opt<CURLOPT_SSLCERTTYPE> (curl,
    matched != nullptr ? curl_ssl_cert_type (matched->format) :
                         static_cast<const char*> (nullptr));
    // A PKCS#12 bundle carries its own key and stores no key path, so this is
    // null there rather than "" - an empty string is a path, and libcurl would
    // fail to open it.
    set_opt<CURLOPT_SSLKEY> (curl,
    matched != nullptr && !matched->key_path.empty () ?
    matched->key_path.c_str () :
    static_cast<const char*> (nullptr));
    // Null rather than "" when there is no passphrase: an empty string is a
    // passphrase attempt, and on a key that has none the backend answers by
    // failing the load. One field for both formats, because libcurl reads it as
    // the PKCS#12 import password too.
    set_opt<CURLOPT_KEYPASSWD> (curl,
    matched != nullptr && !matched->passphrase.empty () ?
    matched->passphrase.c_str () :
    static_cast<const char*> (nullptr));
    return matched;
}

/// Whether @p check's `LocalPeerRule` refuses this peer, recording it when it
/// does. A missing address is refused: the rule fails closed.
bool refuses_local_peer (ConnectedPeerCheck* check, const char* peer_ip, int peer_port) {
    if (check == nullptr || check->local_peers == nullptr) {
        return false;
    }
    check->refused_local_peer = peer_ip == nullptr ||
    vayu::http::is_refused_local_peer (peer_ip, peer_port, *check->local_peers);
    return check->refused_local_peer;
}

/**
 * libcurl's pre-request callback: refuse the connection about to carry the
 * request when its peer is one of Vayu's own ports (#2355), or one the
 * transfer's `LocalPeerRule` refuses (#2364).
 *
 * It runs for every connection a transfer uses, reused ones included, after
 * the connect and before a byte of the request is written - so a redirect hop
 * and a name that resolves to loopback are judged by the address libcurl
 * actually reached. With a proxy in force that address is the proxy's. The
 * abort surfaces as `CURLE_ABORTED_BY_CALLBACK`, which `curl_to_error`
 * recognises by asking the reserved-port predicate the same question, or by
 * the refusal the check recorded.
 *
 * Fails closed: an exception must not cross libcurl's C frames, and a
 * predicate that could not answer is no reason to send.
 */
int refuse_forbidden_peer (void* clientp,
// `curl_prereq_callback` fixes the type: libcurl reads the pointer back
// through a vararg, so a `const char*` parameter would be a different
// function type, not a safer one.
// NOLINTNEXTLINE(readability-non-const-parameter)
char* conn_primary_ip,
char* /*conn_local_ip*/,
int conn_primary_port,
int /*conn_local_port*/) {
    try {
        if (conn_primary_ip != nullptr &&
        vayu::http::is_reserved_loopback_target (conn_primary_ip, conn_primary_port)) {
            return CURL_PREREQFUNC_ABORT;
        }
        return refuses_local_peer (static_cast<ConnectedPeerCheck*> (clientp),
               conn_primary_ip, conn_primary_port) ?
        CURL_PREREQFUNC_ABORT :
        CURL_PREREQFUNC_OK;
    } catch (...) {
        return CURL_PREREQFUNC_ABORT;
    }
}

} // namespace

/**
 * The reserved port this handle's last connection reached, or nullopt.
 *
 * What tells `refuse_forbidden_peer`'s reserved-port abort apart from every other
 * `CURLE_ABORTED_BY_CALLBACK` (a stream's own cap, a stop): the peer it was
 * judged on is still the handle's primary address, so the same predicate
 * gives the same answer.
 */
std::optional<int> reserved_peer_port (CURL* curl) {
    if (!curl) {
        return std::nullopt;
    }
    char* ip  = nullptr;
    long port = 0;
    if (get_info<CURLINFO_PRIMARY_IP> (curl, &ip) != CURLE_OK ||
    ip == nullptr || get_info<CURLINFO_PRIMARY_PORT> (curl, &port) != CURLE_OK) {
        return std::nullopt;
    }
    const int peer_port = static_cast<int> (port);
    if (!vayu::http::is_reserved_loopback_target (ip, peer_port)) {
        return std::nullopt;
    }
    return peer_port;
}

/**
 * Whether a failure with no mapping of its own happened on a TLS connection
 * that never answered - the shape every client-certificate refusal takes, and
 * one no CURLcode names (issue #802).
 *
 * Three failures arrive this way and not one of them is internal to this
 * engine: a key the stored passphrase does not open
 * (`CURLE_BAD_FUNCTION_ARGUMENT` here, where the curl command line reports
 * `CURLE_SSL_CERTPROBLEM` for the same event), a certificate the server will
 * not accept, and a certificate the server demanded and did not get. The last
 * two are `CURLE_RECV_ERROR`, because under TLS 1.3 the server's verdict about
 * the *client* arrives after the client's own handshake has finished - so
 * libcurl reports the ordinary code of a connection that went away
 * mid-request, carrying the alert in its message ("tlsv13 alert certificate
 * required", "tlsv1 alert unknown ca").
 *
 * The test is deliberately about that shape rather than about those three
 * codes. An enumeration would be a list to extend every time a backend spread
 * one event across another code - the trap `proxy_refused_tunnel` above exists
 * to avoid - and it is consulted only where the mapping has already run out of
 * meanings, or where its meaning ("the target failed the exchange") is the
 * very one this shape refines, so nothing with a more specific answer reaches
 * it.
 *
 * What it costs: an https endpoint that accepts a connection and hangs up
 * before answering for a reason of its own reads as a TLS error rather than
 * a connection failure; libcurl's own message travels with the code either
 * way.
 */
bool tls_connection_never_answered (CURL* curl) {
    if (!curl) {
        return false;
    }
    char* scheme = nullptr;
    if (get_info<CURLINFO_SCHEME> (curl, &scheme) != CURLE_OK || scheme == nullptr) {
        return false;
    }
    // curl reports the scheme upper-cased; compared case-insensitively anyway,
    // because that is a presentation detail of one version.
    if (!vayu::utils::ascii_lower_equal (scheme, "https")) {
        return false;
    }

    // A response line, even a 4xx, means the TLS layer did its job and whatever
    // failed after it is not a trust decision.
    long response_code = 0;
    if (get_info<CURLINFO_RESPONSE_CODE> (curl, &response_code) != CURLE_OK) {
        return false;
    }
    return response_code == 0;
}

/**
 * The sentence that opens a redirect-limit failure, ahead of libcurl's own text.
 *
 * The limit is read off the handle (`CURLINFO_REDIRECT_COUNT`) rather than the
 * request, which this function never sees: libcurl raises
 * `CURLE_TOO_MANY_REDIRECTS` exactly when the hops followed reach
 * `CURLOPT_MAXREDIRS`, so the count at failure is the limit. When the handle
 * cannot say, the sentence names no number rather than guess one.
 */
std::string too_many_redirects_message (CURL* curl, const std::string& curl_text) {
    long followed    = -1;
    const bool known = curl &&
    get_info<CURLINFO_REDIRECT_COUNT> (curl, &followed) == CURLE_OK && followed >= 0;
    std::string text = "Too many redirects: the server redirected more than ";
    text += known ? std::to_string (followed) + " times" : "the allowed number of times";
    return text + " (see Maximum redirects). " + curl_text;
}

/// The `Content-Encoding` value of the last response libcurl received, or
/// empty. Only the last request's headers: a redirect hop's are not the body
/// that failed to decode.
std::string received_content_encoding (CURL* curl) {
    constexpr size_t MAX_SHOWN = 64;
    curl_header* header        = nullptr;
    if (!curl ||
    curl_easy_header (curl, "Content-Encoding", 0, CURLH_HEADER, -1, &header) != CURLHE_OK ||
    header == nullptr || header->value == nullptr) {
        return {};
    }
    return std::string (header->value).substr (0, MAX_SHOWN);
}

/// The sentence that opens a decode failure, ahead of libcurl's own text.
std::string bad_content_encoding_message (CURL* curl, const std::string& curl_text) {
    const std::string encoding = received_content_encoding (curl);
    std::string text = "The response could not be decoded: the server sent ";
    text += encoding.empty () ? "a Content-Encoding this client cannot decode" :
                                "Content-Encoding " + encoding;
    return text + ". " + curl_text;
}

/// True when @p url holds a byte libcurl refuses anywhere in a URL: a space, a
/// C0 control or DEL. Bytes above `~` are not in it - libcurl sends those raw.
bool has_space_or_control (std::string_view url) {
    return std::ranges::any_of (url, [] (char c) {
        const auto byte = static_cast<unsigned char> (c);
        return byte <= 0x20 || byte == 0x7F;
    });
}

/**
 * The sentence for a URL libcurl refused as malformed, derived from the URL
 * the transfer was handed (`wire_url`) and not from libcurl's wording, which
 * names a component ("Bad query") rather than the byte. With encoding on, a
 * space survives `wire_url` only in the authority, where the toggle is no
 * remedy, so it is named only when the request turned encoding off. Empty when
 * the URL holds no such byte, which leaves libcurl's text to stand.
 */
std::string malformed_url_message (const Request& request) {
    if (!has_space_or_control (vayu::http::wire_url (request))) {
        return {};
    }
    std::string text =
    "Cannot send this request: the URL contains a space or control character; "
    "percent-encode it";
    if (request.disable_url_encoding) {
        text += ", or turn Send URL without encoding off";
    }
    return text;
}

/// Whether the proxy's own certificate is what failed verification. The code
/// alone cannot say: `CURLE_PEER_FAILED_VERIFICATION` is the same answer for
/// the proxy's certificate and the origin's. `CURLINFO_PROXY_SSL_VERIFYRESULT`
/// is the backend's verdict on the proxy leg and stays 0 for an http:// proxy
/// and for a transfer with no proxy, so a non-zero value here names the hop
/// (#2469). Gated on the code because a backend can leave a non-zero result
/// behind on a leg whose verification was switched off.
bool proxy_certificate_rejected (CURL* curl, CURLcode code) {
    if (!curl || code != CURLE_PEER_FAILED_VERIFICATION) {
        return false;
    }
    long verify_result = 0;
    if (get_info<CURLINFO_PROXY_SSL_VERIFYRESULT> (curl, &verify_result) != CURLE_OK) {
        return false;
    }
    return verify_result != 0;
}

} // namespace

Error curl_to_error (CURL* curl,
CURLcode code,
const CurlErrorBuffer& errors,
const Request* request,
const ConnectedPeerCheck* peer_check) {
    Error error;
    const std::string_view message = errors.message ();
    error.message = message.empty () ? curl_easy_strerror (code) : std::string (message);

    // Ahead of every fallback below, so an https transfer whose connection was
    // refused before the request reads as the refusal and not as `SslError`.
    if (code == CURLE_ABORTED_BY_CALLBACK) {
        if (const auto port = reserved_peer_port (curl)) {
            error.code    = ErrorCode::InvalidUrl;
            error.message = "Cannot send this request: " +
            vayu::http::reserved_target_refusal (*port);
            return error;
        }
        if (peer_check != nullptr && peer_check->refused_local_peer) {
            error.code = ErrorCode::InvalidUrl;
            error.message =
            "Cannot send this request: " + vayu::http::local_peer_refusal ();
            return error;
        }
    }

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

    // Ahead of the `SslError` mapping, which it keeps as the code: the message
    // is what changes, so a user is not sent to the target's certificate when
    // it was the proxy's that was refused (#2469).
    if (proxy_certificate_rejected (curl, code)) {
        error.code = ErrorCode::SslError;
        error.message = "The proxy's certificate was not accepted: " + error.message;
        return error;
    }

    switch (code) {
    case CURLE_OK: error.code = ErrorCode::None; break;
    case CURLE_OPERATION_TIMEDOUT: error.code = ErrorCode::Timeout; break;
    // The proxy hop is a distinct failure domain from the target's: "cannot
    // resolve the proxy" reported as a connection failure sent users hunting
    // an endpoint that was never the problem (issue #705).
    case CURLE_COULDNT_RESOLVE_PROXY:
    case CURLE_PROXY: error.code = ErrorCode::ProxyError; break;
    case CURLE_COULDNT_RESOLVE_HOST: error.code = ErrorCode::DnsError; break;
    case CURLE_COULDNT_CONNECT: error.code = ErrorCode::ConnectionFailed; break;
    // The target was reached and then failed the exchange: an empty reply, a
    // reset mid-transfer, a reply that is not HTTP. The target's or the
    // network's doing, never this engine's, so not `InternalError`. The TLS
    // shape still wins here: a client-certificate refusal under TLS 1.3 arrives
    // as `CURLE_RECV_ERROR` (see `tls_connection_never_answered`, issue #802).
    case CURLE_GOT_NOTHING:
    case CURLE_SEND_ERROR:
    case CURLE_RECV_ERROR:
    case CURLE_WEIRD_SERVER_REPLY:
        error.code = tls_connection_never_answered (curl) ? ErrorCode::SslError :
                                                            ErrorCode::ConnectionFailed;
        break;
    // The two below are the target's answer being unusable, not a connection
    // that failed: every hop was answered. Their own codes, because reading
    // "couldn't connect" sent users to the network for a redirect loop or a
    // mislabelled body (issue #2462).
    case CURLE_TOO_MANY_REDIRECTS:
        error.code    = ErrorCode::TooManyRedirects;
        error.message = too_many_redirects_message (curl, error.message);
        break;
    case CURLE_BAD_CONTENT_ENCODING:
        error.code    = ErrorCode::BadContentEncoding;
        error.message = bad_content_encoding_message (curl, error.message);
        break;
    case CURLE_SSL_CONNECT_ERROR:
    case CURLE_SSL_CERTPROBLEM:
    case CURLE_SSL_CIPHER:
    case CURLE_PEER_FAILED_VERIFICATION:
        error.code = ErrorCode::SslError;
        break;
    // A URL libcurl cannot parse: the message names the space or control byte
    // when the URL holds one.
    case CURLE_URL_MALFORMAT:
        error.code = ErrorCode::InvalidUrl;
        if (request) {
            if (auto named = malformed_url_message (*request); !named.empty ()) {
                error.message = std::move (named);
            }
        }
        break;
    // A scheme the handle's allowlist refuses: a redirect's, or one libcurl
    // guessed for a URL naming none. libcurl's text names the scheme.
    case CURLE_UNSUPPORTED_PROTOCOL: error.code = ErrorCode::InvalidUrl; break;
    default:
        error.code = tls_connection_never_answered (curl) ? ErrorCode::SslError :
                                                            ErrorCode::InternalError;
        break;
    }

    return error;
}

namespace {

/// The codes libcurl raises while checking the request it was handed, before
/// it resolves a name or opens a socket: a URL it cannot parse, a scheme the
/// handle's allowlist refuses. Each also has a source after the wire (a
/// redirect's `Location`, a status line naming an unknown HTTP version), which
/// `reached_a_peer` tells apart. Every other code is raised by work on the
/// network: a TLS file libcurl cannot read (`CURLE_SSL_CERTPROBLEM`,
/// `CURLE_SSL_CACERT_BADFILE`, `CURLE_SSL_CRL_BADFILE`) is read during the
/// handshake, after the TCP connect.
bool refused_before_connecting (CURLcode code) {
    return code == CURLE_URL_MALFORMAT || code == CURLE_UNSUPPORTED_PROTOCOL;
}

/// libcurl clears the primary address when a transfer starts and sets it once
/// a connection, new or reused, is up at the IP level, even when the TLS
/// handshake above it then fails. A redirect's earlier hop leaves it set for a
/// later hop's refusal.
bool reached_a_peer (CURL* curl) {
    char* ip = nullptr;
    return curl != nullptr && get_info<CURLINFO_PRIMARY_IP> (curl, &ip) == CURLE_OK &&
    ip != nullptr && *ip != '\0';
}

} // namespace

bool curl_transfer_attempted (CURL* curl, CURLcode code) {
    return !refused_before_connecting (code) || reached_a_peer (curl);
}

const ClientCertRule* apply_transport_policy (CURL* curl,
const TransportPolicy& policy,
bool verify_ssl,
const std::string& url,
ConnectedPeerCheck* peer_check) {
    set_opt<CURLOPT_PROTOCOLS_STR> (curl, vayu::http::SENDABLE_PROTOCOLS);
    set_opt<CURLOPT_REDIR_PROTOCOLS_STR> (curl, vayu::http::SENDABLE_PROTOCOLS);
    set_opt<CURLOPT_SSL_VERIFYPEER> (curl, verify_ssl ? 1L : 0L);
    set_opt<CURLOPT_SSL_VERIFYHOST> (curl, verify_ssl ? 2L : 0L);
    // The same switch for an https:// proxy's own handshake (#2469): libcurl
    // verifies that leg whatever the origin pair says, so without these a
    // request sent with "Verify TLS certificate" off would still be refused at
    // the proxy. No client certificate is written for the proxy
    // (`CURLOPT_PROXY_SSLCERT`): the registry holds identities for origins, and
    // offering one to a proxy would hand it to a party the user never named it for.
    set_opt<CURLOPT_PROXY_SSL_VERIFYPEER> (curl, verify_ssl ? 1L : 0L);
    set_opt<CURLOPT_PROXY_SSL_VERIFYHOST> (curl, verify_ssl ? 2L : 0L);
    // Set on every handle, like the proxy: a pooled handle must never be
    // without the callback, nor keep a previous transfer's state, so the data
    // pointer is written null included. The reserved ports need none (the
    // registry is process-wide); a reference fetch's rule rides it (#2364).
    set_opt<CURLOPT_PREREQFUNCTION> (curl, refuse_forbidden_peer);
    set_opt<CURLOPT_PREREQDATA> (curl, peer_check);

    apply_ca_options (curl, policy);
    apply_proxy_options (curl, policy);
    return apply_client_certificate (curl, policy, url);
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

    data->errors.attach (curl);

    // The DNS pin and the client-certificate match below read this same URL,
    // so they key on the host and port the transfer dials.
    const std::string url = vayu::http::wire_url (request);
    set_opt<CURLOPT_URL> (curl, url.c_str ());

    // DNS Pre-resolution: Use cached DNS to bypass system resolver
    // This is critical for high-RPS loads (prevents DNS saturation)
    // An IP-literal URL has nothing to resolve, so it is never pinned - that
    // also keeps a malformed literal out of the cache's blocking lookup path.
    if (dns_cache) {
        const UrlAuthority authority = parse_authority (url);
        if (!authority.host.empty () && !authority.is_ip_literal) {
            struct curl_slist* resolve_list = dns_cache->get_resolve_list (
            authority.host, authority.port, config.dns_cache_timeout);
            if (resolve_list) {
                set_opt<CURLOPT_RESOLVE> (curl, resolve_list);
                data->resolve_list = resolve_list; // Store for cleanup
            }
        }
    }

    // Set method and body (shared with the single-request client - see
    // apply_method_and_body for why the two are set together and in that order)
    apply_method_and_body (curl, request, data->body);

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
        data->stream_bounds   = request.stream_bounds;
        data->stream_deadline = data->submitted_at +
        std::chrono::milliseconds (request.stream_bounds->max_duration_ms);
    }

    // Set headers. No sent record is kept on this path - a load run's captures
    // record none, and `script_request_header_view` reads the composed map
    // instead - so the map is not built per transfer.
    data->headers_list =
    build_request_header_list (request, config.default_headers, nullptr);

    if (data->headers_list) {
        set_opt<CURLOPT_HTTPHEADER> (curl, data->headers_list);
    }

    // Always set, never skipped: these handles are pooled, so an encoding the
    // previous transfer negotiated would otherwise carry into this one.
    apply_default_header_options (curl, request, config.default_headers);

    // Per-transfer cookie state, for the scenario load path's virtual users.
    // Enable the engine, flush, then seed - the ordering `apply_jar_cookies`
    // above already uses. See cookie_jar.hpp for why libcurl, not us, decides
    // what actually goes on the wire.
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
        set_opt<CURLOPT_COOKIEFILE> (curl, "");
        set_opt<CURLOPT_COOKIELIST> (curl, "ALL");
        for (const auto& line : request.cookie_lines) {
            set_opt<CURLOPT_COOKIELIST> (curl, line.c_str ());
        }
    }

    // Set callbacks
    set_opt<CURLOPT_WRITEFUNCTION> (curl, write_callback);
    set_opt<CURLOPT_WRITEDATA> (curl, data);
    set_opt<CURLOPT_HEADERFUNCTION> (curl, header_callback);
    set_opt<CURLOPT_HEADERDATA> (curl, data);

    // Progress callback. A bounded stream needs it whether or not the caller
    // asked for progress: it is where the duration cap is enforced, and a quiet
    // stream produces no writes to enforce it from (issue #576).
    if (data->progress || data->stream_bounds) {
        set_opt<CURLOPT_XFERINFOFUNCTION> (curl, progress_callback);
        set_opt<CURLOPT_XFERINFODATA> (curl, data);
        set_opt<CURLOPT_NOPROGRESS> (curl, 0L);
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
    set_opt<CURLOPT_TIMEOUT_MS> (curl, transfer_timeout_ms);

    // Set redirect options
    if (request.follow_redirects) {
        set_opt<CURLOPT_FOLLOWLOCATION> (curl, 1L);
        set_opt<CURLOPT_MAXREDIRS> (curl, static_cast<long> (request.max_redirects));
    }

    // TLS verification and the proxy, both from the run-scoped policy. Run-
    // scoped rather than per-request because libcurl only reuses a cached
    // connection when its proxy and TLS config match, so varying either per
    // transfer would partition every worker's pool and multiply handshakes
    // (epic decision 3 of #704).
    apply_transport_policy (curl, config.transport, request.verify_ssl, url);

    // =========================================================================
    // HIGH-PERFORMANCE OPTIMIZATIONS (Phase 1 - Target: 60k RPS)
    // Config values passed via EventLoopConfig for runtime configurability
    // =========================================================================

    // DNS Caching: Cache DNS lookups to avoid resolver saturation
    // This is critical - DNS was causing 84% of errors at 10k RPS
    // Setting to 0 disables caching (resolves every request)
    set_opt<CURLOPT_DNS_CACHE_TIMEOUT> (curl, config.dns_cache_timeout);

    // TCP Keep-Alive: Reuse connections and detect dead sockets faster
    // Setting idle time to 0 disables keep-alive entirely
    // Using constants directly; these settings require restart to take effect
    long keepalive_idle = vayu::core::constants::event_loop::TCP_KEEPALIVE_IDLE_SECONDS;
    long keepalive_interval = vayu::core::constants::event_loop::TCP_KEEPALIVE_INTERVAL_SECONDS;

    if (keepalive_idle > 0) {
        set_opt<CURLOPT_TCP_KEEPALIVE> (curl, 1L);
        set_opt<CURLOPT_TCP_KEEPIDLE> (curl, keepalive_idle);
        set_opt<CURLOPT_TCP_KEEPINTVL> (curl, keepalive_interval);
    } else {
        // Disable TCP keep-alive when idle time is 0
        set_opt<CURLOPT_TCP_KEEPALIVE> (curl, 0L);
    }

    // Protocol selection. Until nghttp2 was linked this was a hardcoded
    // CURL_HTTP_VERSION_2TLS that libcurl silently ignored, so every request
    // went out as HTTP/1.1 regardless. It now follows the request's field.
    set_opt<CURLOPT_HTTP_VERSION> (
    curl, vayu::http::to_curl_http_version (request.http_version));

    // Connection reuse: Don't close connection after request
    set_opt<CURLOPT_FORBID_REUSE> (curl, 0L);

    // TCP_NODELAY: Disable Nagle's algorithm for lower latency
    set_opt<CURLOPT_TCP_NODELAY> (curl, 1L);

    // =========================================================================

    // Verbose output for debugging
    if (config.verbose) {
        set_opt<CURLOPT_VERBOSE> (curl, 1L);
        set_opt<CURLOPT_DEBUGFUNCTION> (curl, debug_callback);
        set_opt<CURLOPT_DEBUGDATA> (curl, data);
        data->secret_header_names = request.secret_header_names;
    }

    // Store private data pointer
    set_opt<CURLOPT_PRIVATE> (curl, data);

    return curl;
}

Result<Response> extract_response (CURL* curl, TransferData* data, CURLcode result) {
    Response& response = data->response;

    // The one `cat=client` record this transfer's debug frames collected
    // (issue #1557), if `config.verbose` ever turned CURLOPT_DEBUGFUNCTION on
    // for it - `extract_response` runs exactly once per finished transfer,
    // which makes it the flush point.
    if (!data->debug_lines.empty ()) {
        nlohmann::json fields;
        fields["lines"] = data->debug_lines;
        vayu::utils::log_debug ("client", "curl exchange", fields);
    }

    // Everything curl measured is read before the error branch: a failed
    // transfer still connected, still sent bytes, and still spent time doing
    // it. Returning early here used to zero all of that, which dropped failed
    // requests out of the throughput metrics and left load_strategy's
    // "errors sometimes carry timing" branch permanently dead. The
    // single-request client has always extracted first for this reason.
    const CurlPhaseTimes phase_times = read_phase_times (curl);

    // Negotiated protocol - what actually got used, not what was requested.
    // Empty when curl reports CURL_HTTP_VERSION_NONE or anything this driver
    // doesn't recognize; see http_version_from_curl for why that's not
    // coerced into a guessed "HTTP/1.1".
    long negotiated_version = 0;
    get_info<CURLINFO_HTTP_VERSION> (curl, &negotiated_version);
    response.http_version = vayu::http::http_version_from_curl (negotiated_version);

    // Same question the single-request driver asks, through the same helper -
    // the load path is where an unnoticed downgrade does the most damage, since
    // its whole output is numbers attributed to a protocol. No log line here,
    // unlike client.cpp: this runs once per transfer, and a run that downgrades
    // downgrades every one of them. The flag rides out on each trace instead.
    response.http_version_downgraded = vayu::http::http_version_downgraded (
    data->request.http_version, response.http_version);

    // Perceived latency: wall-clock from submit() to now. steady_clock is
    // monotonic so it's not affected by NTP jumps.
    auto completion = std::chrono::steady_clock::now ();
    double perceived_ms =
    std::chrono::duration<double, std::milli> (completion - data->submitted_at).count ();
    apply_transfer_timing (response.timing, phase_times, perceived_ms);

    // queue_wait_ms is clamped at 0 to absorb sub-microsecond clock jitter
    // where perceived_ms can appear marginally smaller than wire_ms. A
    // discrepancy larger than 1ms indicates a real problem (wrong stamp point,
    // clock skew between steady_clock and curl's TOTAL_TIME, etc.) - debug
    // builds trip an assert; release builds log a warning so the signal isn't
    // lost silently in the clamp. Without this, a future regression that
    // moves `submitted_at` later in the pipeline would zero out queue_wait_ms
    // in production while CI stays green.
    const double delta = perceived_ms - response.timing.wire_ms;
    assert (delta > -1.0 && "perceived_ms - wire_ms below -1ms - clock issue?");
    if (delta < -1.0) {
        vayu::utils::log_warning ("client", "queue_wait clock skew - submitted_at stamp may be set after curl wire start",
        { { "perceivedMs", perceived_ms },
        { "wireMs", response.timing.wire_ms }, { "deltaMs", delta } });
    }
    response.transfer_attempted = curl_transfer_attempted (curl, result);

    // Wire byte counts (body + headers), for throughput-in-bytes metrics.
    curl_off_t dl_bytes = 0, ul_bytes = 0;
    long header_bytes = 0, request_bytes = 0;
    get_info<CURLINFO_SIZE_DOWNLOAD_T> (curl, &dl_bytes);
    get_info<CURLINFO_SIZE_UPLOAD_T> (curl, &ul_bytes);
    get_info<CURLINFO_HEADER_SIZE> (curl, &header_bytes);
    get_info<CURLINFO_REQUEST_SIZE> (curl, &request_bytes);
    response.timing.bytes_down = static_cast<size_t> (std::max<curl_off_t> (0, dl_bytes)) +
    static_cast<size_t> (std::max<long> (0, header_bytes));
    response.timing.bytes_up = static_cast<size_t> (std::max<curl_off_t> (0, ul_bytes)) +
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
        if (get_info<CURLINFO_COOKIELIST> (curl, &held) == CURLE_OK && held) {
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
        get_info<CURLINFO_RESPONSE_CODE> (curl, &stream_code);
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
             curl_to_error (curl, result, data->errors, &data->request);
        response.error_code    = error.code;
        response.error_message = error.message;
        response.status_code   = 0;
        response.status_text   = vayu::http::status_text (0);
        return response;
    }

    // Get response info
    long http_code = 0;
    get_info<CURLINFO_RESPONSE_CODE> (curl, &http_code);
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
