/**
 * @file tests/curl_utils_test.cpp
 * @brief Tests for the pure helpers on the transfer path - URL authority
 *        parsing, wire-sendability, and phase timing. These run on the event
 *        loop worker thread, where a thrown exception has no handler and
 *        terminates the daemon, so every one of them must be total.
 */

#include <gtest/gtest.h>

// INT_MAX, not std::numeric_limits<int>::max() - curl.h drags in windows.h on
// MSVC, whose `max` macro turns the call into a syntax error under /WX.
#include <climits>
#include <string>

#include "vayu/http/event_loop/curl_utils.hpp"

using vayu::http::detail::apply_phase_timings;
using vayu::http::detail::CurlPhaseTimes;
using vayu::http::detail::extract_hostname;
using vayu::http::detail::extract_port;
using vayu::http::detail::parse_authority;
using vayu::http::detail::validate_transferable;

// The regression this file exists for: a port literal above INT_MAX made
// std::stoi throw std::out_of_range out of the worker thread's initial
// function -> std::terminate -> every run and SSE stream on the daemon dies.
// Mutation-check: restore the raw `std::stoi (match[1].str ())` and this throws
// instead of returning.
TEST (ExtractPort, PortAboveIntMaxDoesNotThrow) {
    EXPECT_NO_THROW ({ (void)extract_port ("http://example.com:99999999999/"); });
    EXPECT_EQ (extract_port ("http://example.com:99999999999/"), 80);
    EXPECT_EQ (extract_port ("https://example.com:99999999999/"), 443);
}

// A digit run long enough to overflow every integer width, and one built from
// the max value plus a trailing digit - both stay on the non-throwing path.
TEST (ExtractPort, AbsurdlyLongDigitRunDoesNotThrow) {
    const std::string huge (400, '9');
    EXPECT_NO_THROW ({ (void)extract_port ("http://h:" + huge + "/"); });
    EXPECT_EQ (extract_port ("http://h:" + huge + "/"), 80);

    const std::string past_int_max = std::to_string (INT_MAX) + "0";
    EXPECT_EQ (extract_port ("https://h:" + past_int_max + "/"), 443);
}

// Ports that fit an int but name no dialable port are treated as absent rather
// than handed to the DNS cache, which would key a resolve entry curl can never
// match. 0 and 65536 bracket the valid range on both sides.
TEST (ExtractPort, OutOfRangeButRepresentablePortFallsBackToSchemeDefault) {
    EXPECT_EQ (extract_port ("https://h:0/"), 443);
    EXPECT_EQ (extract_port ("http://h:0/"), 80);
    EXPECT_EQ (extract_port ("http://h:65536/"), 80);
    EXPECT_EQ (extract_port ("https://h:70000/"), 443);
}

// The ordinary path must be unchanged by the hardening, boundaries included.
TEST (ExtractPort, ExplicitPortInRangeIsReturned) {
    EXPECT_EQ (extract_port ("http://h:8080/"), 8080);
    EXPECT_EQ (extract_port ("https://api.example.com:8443/v1/users"), 8443);
    EXPECT_EQ (extract_port ("http://h:1/"), 1);
    EXPECT_EQ (extract_port ("http://h:65535/"), 65535);
    EXPECT_EQ (extract_port ("h:3000/path"), 3000);
}

// No explicit port: scheme decides, and an unknown scheme keeps the historical
// HTTPS default.
TEST (ExtractPort, NoExplicitPortUsesSchemeDefault) {
    EXPECT_EQ (extract_port ("https://example.com/"), 443);
    EXPECT_EQ (extract_port ("http://example.com/path?q=1"), 80);
    EXPECT_EQ (extract_port ("example.com/path"), 443);
    EXPECT_EQ (extract_port (""), 443);
}

// ============================================================================
// parse_authority - the two URL forms the old regex mis-read
// ============================================================================

// "user:pass@host" - the userinfo colon is not a port separator. The old parse
// returned the host "user" and the scheme default port, so every request to
// such a URL pinned DNS for a name that does not exist, re-resolving (and
// blocking the worker) forever. Mutation-check: drop the '@' handling and the
// host comes back as "user".
TEST (ParseAuthority, UserinfoIsNotTheHost) {
    auto with_userinfo = parse_authority ("http://user:pass@example.com/path");
    EXPECT_EQ (with_userinfo.host, "example.com");
    EXPECT_EQ (with_userinfo.port, 80);

    auto with_port = parse_authority ("https://user:pass@example.com:8443/");
    EXPECT_EQ (with_port.host, "example.com");
    EXPECT_EQ (with_port.port, 8443);

    auto user_only = parse_authority ("http://user@example.com:8080/");
    EXPECT_EQ (user_only.host, "example.com");
    EXPECT_EQ (user_only.port, 8080);
}

// An IPv6 literal's colons belong to the address. The old parse returned the
// host "[" - unresolvable, so identical symptom to the userinfo case.
TEST (ParseAuthority, Ipv6LiteralKeepsItsAddressAndPort) {
    auto bare = parse_authority ("http://[::1]/health");
    EXPECT_EQ (bare.host, "::1");
    EXPECT_EQ (bare.port, 80);
    EXPECT_TRUE (bare.is_ip_literal);

    auto with_port = parse_authority ("http://[2001:db8::1]:8080/");
    EXPECT_EQ (with_port.host, "2001:db8::1");
    EXPECT_EQ (with_port.port, 8080);
    EXPECT_TRUE (with_port.is_ip_literal);
}

// An address needs no resolution, so it is never pinned - a name does.
TEST (ParseAuthority, IpLiteralsAreFlaggedAndNamesAreNot) {
    EXPECT_TRUE (parse_authority ("http://127.0.0.1:9876/run").is_ip_literal);
    EXPECT_FALSE (parse_authority ("http://example.com/").is_ip_literal);
    EXPECT_FALSE (parse_authority ("http://api.v2.example.com:443/").is_ip_literal);
}

// Malformed input must be total, not thrown or half-parsed, because this runs
// on a thread with no exception handler.
TEST (ParseAuthority, MalformedInputYieldsNoHostRatherThanAThrow) {
    EXPECT_NO_THROW ({ (void)parse_authority ("http://[::1/no-close"); });
    EXPECT_TRUE (parse_authority ("http://[::1/no-close").host.empty ());
    EXPECT_TRUE (parse_authority ("http://[::1]junk/").host.empty ());
    EXPECT_TRUE (parse_authority ("").host.empty ());
    EXPECT_TRUE (parse_authority ("/relative/path").host.empty ());
}

// The ordinary forms extract_hostname has always handled must be unchanged.
TEST (ExtractHostname, OrdinaryUrlsAreUnchanged) {
    EXPECT_EQ (extract_hostname ("http://example.com/path"), "example.com");
    EXPECT_EQ (extract_hostname ("https://api.example.com:8443/v1"), "api.example.com");
    EXPECT_EQ (extract_hostname ("example.com/path"), "example.com");
    EXPECT_EQ (extract_hostname ("http://127.0.0.1:9876/"), "127.0.0.1");
    EXPECT_EQ (extract_hostname (""), "");
}

// A path that happens to contain "://" is not a scheme.
TEST (ExtractHostname, SchemeIsOnlyRecognisedBeforeThePath) {
    EXPECT_EQ (extract_hostname ("example.com/redirect?to=http://other.com"), "example.com");
}

// ============================================================================
// validate_transferable - what curl cannot send as written
// ============================================================================

// CURLOPT_NOBODY resets curl's method to HEAD and drops the body, so a
// HEAD-with-body cannot be honoured. Before this it was sent as a POST.
// Mutation-check: return nullopt unconditionally and this fails.
TEST (ValidateTransferable, HeadWithABodyIsRefusedWithAReason) {
    vayu::Request request;
    request.method       = vayu::HttpMethod::HEAD;
    request.url          = "http://example.com/";
    request.body.mode    = vayu::BodyMode::Json;
    request.body.content = R"({"q":1})";

    auto error = validate_transferable (request);
    ASSERT_TRUE (error.has_value ());
    EXPECT_EQ (error->code, vayu::ErrorCode::InvalidMethod);
    EXPECT_NE (error->message.find ("HEAD"), std::string::npos)
    << "the error must name what is wrong: " << error->message;
}

// GET-with-body is legitimate (Elasticsearch-style search) and must pass the
// gate - the fix for it is keeping the wire method, not refusing the request.
TEST (ValidateTransferable, SendableRequestsPass) {
    vayu::Request request;
    request.url          = "http://example.com/";
    request.body.mode    = vayu::BodyMode::Json;
    request.body.content = R"({"query":{}})";

    request.method = vayu::HttpMethod::GET;
    EXPECT_FALSE (validate_transferable (request).has_value ());

    request.method = vayu::HttpMethod::POST;
    EXPECT_FALSE (validate_transferable (request).has_value ());

    // A HEAD with no body, and one whose body mode says there is none.
    request.method = vayu::HttpMethod::HEAD;
    request.body   = {};
    EXPECT_FALSE (validate_transferable (request).has_value ());

    request.body.mode    = vayu::BodyMode::None;
    request.body.content = "ignored";
    EXPECT_FALSE (validate_transferable (request).has_value ());
}

// ============================================================================
// validate_transferable - header text no header line can hold (#738)
// ============================================================================
//
// The gate is where the rule holds for *every* origin: a composed variable, a
// script's assignment to `pm.request.headers`, an auth credential, an import, a
// raw POST /execute payload. `build_request_header_list` sees the same headers
// one step later but can only drop, and a silent drop is the quiet wrong
// request this refusal exists to prevent.
//
// Mutation-check for the four below: drop the `unsendable_header_text` call
// from `validate_transferable` and the three refusals fail while
// `OrdinaryHeaderTextStillPasses` keeps passing.

TEST (ValidateTransferable, AHeaderCarryingALineBreakIsRefused) {
    vayu::Request request;
    request.url = "http://example.com/";

    for (const char* forged :
    { "ok\r\nX-Admin: true", "ok\nX-Admin: true", "ok\rX-Admin: true" }) {
        request.headers = { { "X-Note", forged } };
        auto error      = validate_transferable (request);
        ASSERT_TRUE (error.has_value ()) << forged;
        EXPECT_NE (error->message.find ("X-Note"), std::string::npos)
        << "the refusal must name the header: " << error->message;
        EXPECT_NE (error->message.find ("CR or LF"), std::string::npos) << error->message;
    }

    // A forged *name* is the same forgery, and is named as a name rather than
    // quoted - quoting it would break the message the same way.
    request.headers = { { "X-A\r\nX-Admin: true", "v" } };
    auto error      = validate_transferable (request);
    ASSERT_TRUE (error.has_value ());
    EXPECT_NE (error->message.find ("header name"), std::string::npos) << error->message;
    EXPECT_EQ (error->message.find ('\n'), std::string::npos)
    << "the message must not carry the injected line break: " << error->message;
}

// The engine spells a header `key + ": " + value` and hands it to
// `curl_slist_append`, which reads to the first NUL - so the rest of the line
// went out missing rather than refused (#738 item 3).
TEST (ValidateTransferable, AHeaderCarryingANulIsRefused) {
    vayu::Request request;
    request.url     = "http://example.com/";
    request.headers = { { "X-Note", std::string ("ok\0dropped", 10) } };

    auto error = validate_transferable (request);
    ASSERT_TRUE (error.has_value ());
    EXPECT_NE (error->message.find ("NUL"), std::string::npos) << error->message;
}

// A multipart part's name, declared filename and Content-Type are written into
// that part's own header block (`Content-Disposition`, `Content-Type`), so the
// same forgery lands one layer down. The part's *value* is content, where a
// line break is ordinary text - PR #737 pinned that for the data-cell path and
// this pins it here.
TEST (ValidateTransferable, MultipartPartHeadersAreCheckedButPartContentIsNot) {
    vayu::Request request;
    request.method    = vayu::HttpMethod::POST;
    request.url       = "http://example.com/";
    request.body.mode = vayu::BodyMode::FormData;

    const std::string forged = "a\r\nX-Admin: true";
    vayu::FormField field ("field", "value");

    field.key           = forged;
    request.body.fields = { field };
    EXPECT_TRUE (validate_transferable (request).has_value ()) << "part name";

    field.key           = "field";
    field.file_name     = forged;
    request.body.fields = { field };
    EXPECT_TRUE (validate_transferable (request).has_value ())
    << "declared filename";

    field.file_name     = "";
    field.content_type  = forged;
    request.body.fields = { field };
    EXPECT_TRUE (validate_transferable (request).has_value ())
    << "part content type";

    // The value carries the same bytes as ordinary part content, and a
    // disabled part is not sent at all.
    field.content_type  = "";
    field.value         = forged;
    request.body.fields = { field };
    EXPECT_FALSE (validate_transferable (request).has_value ()) << "part value";

    vayu::FormField off (forged, "v", false);
    request.body.fields = { off };
    EXPECT_FALSE (validate_transferable (request).has_value ())
    << "disabled part";
}

// The rule is about line terminators, not about whitespace or punctuation: a
// header whose value has spaces, tabs and colons is ordinary header text and
// must still pass, or the gate would refuse most real requests.
TEST (ValidateTransferable, OrdinaryHeaderTextStillPasses) {
    vayu::Request request;
    request.url     = "http://example.com/";
    request.headers = { { "Authorization", "Bearer abc.def-ghi" },
        { "Accept", "text/html, application/xml;q=0.9" },
        { "X-Tabbed", "a\tb" }, { "X-Empty", "" } };

    EXPECT_FALSE (validate_transferable (request).has_value ());
}

// ============================================================================
// apply_phase_timings - no stored or displayed phase may be negative
// ============================================================================

// APPCONNECT_TIME is 0 for plain HTTP and for a reused keep-alive connection.
// The event loop's naive successive differences turned that into a negative
// tls_ms and let first_byte_ms absorb the connect time - both rendered
// verbatim by the app. Mutation-check: drop the appconnect collapse and
// tls_ms goes to -20, first_byte_ms to 45.
TEST (ApplyPhaseTimings, ZeroAppconnectMeansNoTlsPhase) {
    CurlPhaseTimes times;
    times.namelookup    = 0.005; // 5ms
    times.connect       = 0.025; // +20ms
    times.appconnect    = 0.0;   // plain HTTP - no TLS handshake happened
    times.starttransfer = 0.070; // +45ms
    times.total         = 0.090; // +20ms

    vayu::Timing timing;
    apply_phase_timings (timing, times);

    EXPECT_DOUBLE_EQ (timing.tls_ms, 0.0);
    EXPECT_NEAR (timing.dns_ms, 5.0, 1e-9);
    EXPECT_NEAR (timing.connect_ms, 20.0, 1e-9);
    EXPECT_NEAR (timing.first_byte_ms, 45.0, 1e-9);
    EXPECT_NEAR (timing.download_ms, 20.0, 1e-9);
}

// A TLS handshake is reported as its own phase, not folded into TTFB.
TEST (ApplyPhaseTimings, TlsHandshakeIsItsOwnPhase) {
    CurlPhaseTimes times;
    times.namelookup    = 0.010;
    times.connect       = 0.030;
    times.appconnect    = 0.080; // 50ms handshake
    times.starttransfer = 0.100;
    times.total         = 0.120;

    vayu::Timing timing;
    apply_phase_timings (timing, times);

    EXPECT_NEAR (timing.tls_ms, 50.0, 1e-9);
    EXPECT_NEAR (timing.first_byte_ms, 20.0, 1e-9);
}

// Out-of-order timers (curl reports 0 for a phase it skipped) must never
// produce a negative duration. Mutation-check: drop the std::max clamps and
// every one of these goes negative.
TEST (ApplyPhaseTimings, EveryPhaseIsClampedAtZero) {
    CurlPhaseTimes times;
    times.namelookup    = 0.050;
    times.connect       = 0.0; // Reused connection: no connect phase
    times.appconnect    = 0.0;
    times.starttransfer = 0.0;
    times.total         = 0.0;

    vayu::Timing timing;
    apply_phase_timings (timing, times);

    EXPECT_GE (timing.dns_ms, 0.0);
    EXPECT_GE (timing.connect_ms, 0.0);
    EXPECT_GE (timing.tls_ms, 0.0);
    EXPECT_GE (timing.first_byte_ms, 0.0);
    EXPECT_GE (timing.download_ms, 0.0);
}
