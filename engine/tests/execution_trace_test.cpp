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

} // namespace
