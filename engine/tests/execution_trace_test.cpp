// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.
//
// The stored design-run trace is a contract: restore-response.ts rebuilds a
// request tab's response pane from it after a restart, so whatever
// build_result_trace omits, the restored Timing tab silently loses. That is
// exactly what happened with wireMs/queueWaitMs (never stored) and zero-valued
// phases (stored only when > 0) - the live Timing tab showed Wire and Queue,
// the restored one didn't.
//
// These tests pin the fixed contract two ways: every timing key is stored,
// including zeros, and - the invariant that keeps the two writers from
// drifting again - the stored key set matches what serialize(Response) puts
// on the live /execute wire, key for key.
//
// Covers vayu::http::routes::build_result_trace (the trace builder) in
// isolation, not the POST /execute route handler - the suite has no
// in-process HTTP route tests (see run_route_test.cpp).

#include "vayu/types.hpp"
#include "vayu/utils/json.hpp"
#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

namespace vayu::http::routes {
// Declared in execution.cpp.
nlohmann::json build_result_trace (const vayu::Request& request,
const vayu::Response& response);
} // namespace vayu::http::routes

namespace {

using vayu::http::routes::build_result_trace;

vayu::Request make_request () {
    vayu::Request request;
    request.method            = vayu::HttpMethod::GET;
    request.url               = "http://127.0.0.1/health";
    request.headers["accept"] = "application/json";
    return request;
}

// A keep-alive reuse over plain HTTP: dns/connect/tls all legitimately 0.
vayu::Response make_response () {
    vayu::Response response;
    response.status_code          = 200;
    response.status_text          = "OK";
    response.body                 = R"({"ok":true})";
    response.headers["server"]    = "mock";
    response.timing.total_ms      = 12.5;
    response.timing.wire_ms       = 12.1;
    response.timing.queue_wait_ms = 0.4;
    response.timing.dns_ms        = 0.0;
    response.timing.connect_ms    = 0.0;
    response.timing.tls_ms        = 0.0;
    response.timing.first_byte_ms = 11.0;
    response.timing.download_ms   = 1.1;
    return response;
}

TEST (ExecutionTrace, StoresAllTimingKeysIncludingZeroPhases) {
    auto trace = build_result_trace (make_request (), make_response ());

    // Zero does not mean omitted: a reused plain-HTTP connection stores
    // dns/connect/tls as 0, exactly as the live response reports them.
    EXPECT_DOUBLE_EQ (trace["totalMs"], 12.5);
    EXPECT_DOUBLE_EQ (trace["wireMs"], 12.1);
    EXPECT_DOUBLE_EQ (trace["queueWaitMs"], 0.4);
    EXPECT_DOUBLE_EQ (trace["dnsMs"], 0.0);
    EXPECT_DOUBLE_EQ (trace["connectMs"], 0.0);
    EXPECT_DOUBLE_EQ (trace["tlsMs"], 0.0);
    EXPECT_DOUBLE_EQ (trace["firstByteMs"], 11.0);
    EXPECT_DOUBLE_EQ (trace["downloadMs"], 1.1);
}

TEST (ExecutionTrace, StoredTimingKeysMatchTheLiveWireKeys) {
    // The invariant behind "restored shows what live showed": every timing
    // key the live /execute response carries is also persisted. Add a ninth
    // field to serialize(Response) without storing it and this fails.
    auto response = make_response ();
    auto trace    = build_result_trace (make_request (), response);
    auto live     = vayu::json::serialize (response)["timing"];

    ASSERT_FALSE (live.empty ());
    for (const auto& [key, value] : live.items ()) {
        EXPECT_TRUE (trace.contains (key)) << "live timing key not stored: " << key;
        EXPECT_DOUBLE_EQ (trace[key].get<double> (), value.get<double> ())
        << "stored value diverges from live for: " << key;
    }
}

TEST (ExecutionTrace, SuccessNestsTheExchange) {
    auto trace = build_result_trace (make_request (), make_response ());

    EXPECT_EQ (trace["request"]["method"], "GET");
    EXPECT_EQ (trace["request"]["url"], "http://127.0.0.1/health");
    EXPECT_EQ (trace["response"]["body"], R"({"ok":true})");
    EXPECT_FALSE (trace.contains ("error_type"));
}

// The negotiated protocol is part of the stored contract too:
// restore-response.ts has nothing to show for a historical run's Protocol field
// without it. Stored under trace["response"], the same nesting as headers/body.
TEST (ExecutionTrace, ResponseCarriesNegotiatedHttpVersion) {
    auto response         = make_response ();
    response.http_version = "HTTP/2";

    auto trace = build_result_trace (make_request (), response);

    ASSERT_TRUE (trace.contains ("response"));
    EXPECT_EQ (trace["response"]["httpVersion"], "HTTP/2");
}

// Matches serialize(Response)'s convention (json.cpp): stored, not omitted,
// even when nothing was negotiated - so a reader can't confuse "empty" with
// "this key doesn't exist on a stored trace".
TEST (ExecutionTrace, EmptyHttpVersionStoredNotOmitted) {
    auto response = make_response (); // http_version defaults to ""

    auto trace = build_result_trace (make_request (), response);

    ASSERT_TRUE (trace["response"].contains ("httpVersion"));
    EXPECT_EQ (trace["response"]["httpVersion"], "");
}

// Same invariant style as the timing test above: whatever key
// serialize(Response) puts on the live /execute wire for httpVersion is also
// what the stored trace carries.
TEST (ExecutionTrace, StoredHttpVersionMatchesTheLiveWireKey) {
    auto response         = make_response ();
    response.http_version = "HTTP/1.1";

    auto trace = build_result_trace (make_request (), response);
    auto live  = vayu::json::serialize (response);

    EXPECT_EQ (trace["response"]["httpVersion"], live["httpVersion"]);
}

// ============================================================================
// rawRequest - the wire message, stored (issue #348)
//
// The live raw-request view reads the transfer's own outbound frame; the
// restored one used to rebuild the string from the composed header map. Those
// two disagree the moment the cookie jar attaches anything, because libcurl
// adds `Cookie` itself and the composed map never sees it - so the same
// exchange showed a session right after a send and none after a reload.
// ============================================================================

// A response as `Client::send` leaves it: the wire frame carries the jar's
// cookie and libcurl's own `Accept`, neither of which is in `request.headers`.
vayu::Response make_response_with_wire_request () {
    auto response        = make_response ();
    response.raw_request = "GET /health HTTP/1.1\r\n"
                           "Host: 127.0.0.1\r\n"
                           "accept: application/json\r\n"
                           "Cookie: session=abc123\r\n"
                           "\r\n";
    return response;
}

TEST (ExecutionTrace, StoresTheWireRequestBesideTheComposedHeaders) {
    auto trace =
    build_result_trace (make_request (), make_response_with_wire_request ());

    ASSERT_TRUE (trace["request"].contains ("rawRequest"));
    EXPECT_NE (trace["request"]["rawRequest"].get<std::string> ().find (
               "Cookie: session=abc123"),
    std::string::npos);

    // The composed map is unchanged - it is neither the wire nor the sent
    // record, and the three are deliberately different views
    // (api-reference.md).
    EXPECT_FALSE (trace["request"]["headers"].contains ("Cookie"));
}

// The sent record, stored beside the composed map (issue #664). Before it, the
// restored response pane rebuilt its "headers sent" disclosure from the
// composed map and so disagreed with the live pane about the same exchange:
// the live one reads `Response::request_headers`, which is what
// `build_request_header_list` appended.
vayu::Request make_multipart_request () {
    vayu::Request request;
    request.method = vayu::HttpMethod::POST;
    request.url    = "http://127.0.0.1/upload";
    // Composed, but not sent: libcurl writes the multipart Content-Type itself
    // with the boundary, and a value-less header is libcurl's spelling for
    // "remove this one" (issue #662).
    request.headers["Content-Type"] = "multipart/form-data";
    request.headers["X-Blank"]      = "";
    request.headers["accept"]       = "application/json";
    return request;
}

// What build_request_header_list would have recorded for that request: the
// survivors, plus the two the engine derives at send time.
vayu::Response make_response_with_sent_headers () {
    auto response                      = make_response ();
    response.request_headers["accept"] = "application/json";
    response.request_headers["Content-Type"] =
    "multipart/form-data; boundary=------abc123";
    response.request_headers["User-Agent"] = "vayu/0.17.0";
    return response;
}

TEST (ExecutionTrace, StoresTheSentHeadersBesideTheComposedMap) {
    auto trace = build_result_trace (
    make_multipart_request (), make_response_with_sent_headers ());

    ASSERT_TRUE (trace["request"].contains ("sentHeaders"));
    const auto& sent = trace["request"]["sentHeaders"];

    // The two the composed map structurally cannot answer for.
    EXPECT_EQ (sent["User-Agent"], "vayu/0.17.0");
    EXPECT_EQ (sent["Content-Type"], "multipart/form-data; boundary=------abc123");
    // The one the wire dropped is not reported as sent.
    EXPECT_FALSE (sent.contains ("X-Blank"));

    // And the composed map is still stored, unchanged: design-run-seed.ts
    // reseeds a request tab from it, and seeding it from the sent record would
    // write the engine's derived headers back as if a person had typed them.
    EXPECT_EQ (trace["request"]["headers"]["X-Blank"], "");
    EXPECT_EQ (trace["request"]["headers"]["Content-Type"], "multipart/form-data");
}

// Same invariant style as the timing and rawRequest tests above: what
// serialize(Response) puts on the live /execute wire is what the stored trace
// carries, so the live and restored Headers tabs cannot drift apart again.
TEST (ExecutionTrace, StoredSentHeadersMatchTheLiveWireKey) {
    auto response = make_response_with_sent_headers ();

    auto trace = build_result_trace (make_multipart_request (), response);
    auto live  = vayu::json::serialize (response);

    EXPECT_EQ (trace["request"]["sentHeaders"], live["requestHeaders"]);
}

// Omitted, not stored empty - for the reason the rawRequest omission has: the
// reader prefers this key when present, so an empty object would suppress the
// composed-map fallback that is the right answer both for a step that sent
// nothing and for every row written before the field. A load run's deferred
// replay is the same shape: it records no sent headers at all.
TEST (ExecutionTrace, OmitsSentHeadersWhenNothingWasRecorded) {
    auto trace = build_result_trace (make_multipart_request (), make_response ());

    EXPECT_FALSE (trace["request"].contains ("sentHeaders"));
}

// The same invariant style as the timing and httpVersion tests above: what
// serialize(Response) puts on the live /execute wire is what the stored trace
// carries, so the live and restored raw views cannot drift apart again.
TEST (ExecutionTrace, StoredRawRequestMatchesTheLiveWireKey) {
    auto response = make_response_with_wire_request ();

    auto trace = build_result_trace (make_request (), response);
    auto live  = vayu::json::serialize (response);

    EXPECT_EQ (trace["request"]["rawRequest"], live["rawRequest"]);
}

// A step that sent nothing (`pm.execution.skipRequest()`) hands this a default
// Response. Omitted, not stored empty: the reader prefers this key when it is
// present, so "" would suppress the fallback synthesis that is the right answer
// there - and it is what every row written before #348 relies on.
TEST (ExecutionTrace, OmitsRawRequestWhenNothingWasSent) {
    auto trace = build_result_trace (make_request (), make_response ());

    EXPECT_FALSE (trace["request"].contains ("rawRequest"));
}

// A transfer that failed before sending has no frame to read, but `Client::send`
// synthesizes one from the composed request - so an unreachable host still
// stores the request it attempted, on the branch that writes no response node.
TEST (ExecutionTrace, FailedTransferStillStoresItsSynthesizedRequest) {
    auto response          = make_response_with_wire_request ();
    response.status_code   = 0;
    response.error_code    = vayu::ErrorCode::ConnectionFailed;
    response.error_message = "connection refused";

    auto trace = build_result_trace (make_request (), response);

    ASSERT_FALSE (trace.contains ("response"));
    ASSERT_TRUE (trace["request"].contains ("rawRequest"));
    EXPECT_NE (
    trace["request"]["rawRequest"].get<std::string> ().find ("GET /health"),
    std::string::npos);
}

TEST (ExecutionTrace, FailureStoresErrorInsteadOfResponse) {
    auto response          = make_response ();
    response.status_code   = 0;
    response.error_code    = vayu::ErrorCode::ConnectionFailed;
    response.error_message = "connection refused";

    auto trace = build_result_trace (make_request (), response);

    EXPECT_FALSE (trace.contains ("response"));
    EXPECT_EQ (trace["error_type"], to_string (vayu::ErrorCode::ConnectionFailed));
    EXPECT_EQ (trace["error_message"], "connection refused");
    // Timing still stored - a timeout's partial phases are diagnostics.
    EXPECT_TRUE (trace.contains ("firstByteMs"));
}

// The client certificate the exchange presented (issue #707). Same
// live-equals-stored invariant as the two above, and one thing the others do
// not need: it survives a *failed* transfer, because a handshake refused by the
// server is the exchange where "which certificate did we send" is the whole
// question - and that one stores no `response` node at all.
TEST (ExecutionTrace, StoredClientCertificateMatchesTheLiveKey) {
    auto response               = make_response ();
    response.client_certificate = "api.example.com:8443";

    auto trace = build_result_trace (make_request (), response);
    auto live  = vayu::json::serialize (response);

    EXPECT_EQ (trace["clientCertificate"], "api.example.com:8443");
    EXPECT_EQ (trace["clientCertificate"], live["clientCertificate"]);
}

TEST (ExecutionTrace, StoresTheClientCertificateOnAFailedExchangeToo) {
    auto response               = make_response ();
    response.status_code        = 0;
    response.error_code         = vayu::ErrorCode::SslError;
    response.error_message      = "handshake failure";
    response.client_certificate = "api.example.com";

    auto trace = build_result_trace (make_request (), response);

    EXPECT_FALSE (trace.contains ("response"));
    EXPECT_EQ (trace["clientCertificate"], "api.example.com");
}

// Omitted rather than stored empty, unlike the always-present live key: every
// row written before the registry existed would otherwise be indistinguishable
// from one that matched nothing, and the two are the same fact.
TEST (ExecutionTrace, OmitsTheClientCertificateWhenNoneWasUsed) {
    auto trace = build_result_trace (make_request (), make_response ());

    EXPECT_FALSE (trace.contains ("clientCertificate"));
    EXPECT_EQ (vayu::json::serialize (make_response ())["clientCertificate"], "");
}

} // namespace
