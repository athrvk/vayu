/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/sse_stream_execute_body_test.cpp
 * @brief `StreamExecuteTest`: how a stream's body, text path and caps are stored and served,
 * the engine cost and script time in the timing node, and the stop and persist-variables routes.
 *
 * The in-process SSE server, the helpers shared by these files and the `StreamExecuteTest`
 * fixture are in `sse_stream_fixture.hpp`.
 */

// First, before anything that includes <httplib.h>: see the header. Needed
// for `proxy_server.hpp`, whose forwarder builds an `httplib::Client` from a URL.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>

#include <chrono>
#include <cstddef>
#include <future>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/utils/json.hpp"
#include "wait_until.hpp"

#include "sse_stream_fixture.hpp"

namespace {

using nlohmann::json;
namespace sse_constants = vayu::core::constants::sse;
using vayu::tests::sse_stream::chat_completion_chunks;
using vayu::tests::sse_stream::OPENAI_CONTENT;
using vayu::tests::sse_stream::script_elements;
using vayu::tests::sse_stream::StreamExecuteTest;
using vayu::tests::sse_stream::StreamServer;

/// One `data:` frame of @p payload_bytes copies of @p fill.
///
/// Kept out of line on GCC: inlined, the compiler knows the frame is 102 bytes
/// and reads the move of it into the caller's vector as a copy of that many
/// bytes out of a small-string buffer, a false -Warray-bounds that fails the
/// -O3 -Werror release leg on Ubuntu 22.04. Building it by append or by
/// `literal + std::string (n, c)` there fails the same way.
#if defined(__GNUC__) && !defined(__clang__)
[[gnu::noinline]]
#endif
std::string sse_data_frame (std::size_t payload_bytes, char fill) {
    constexpr std::string_view PREFIX = "data: ";
    std::string frame (PREFIX.size () + payload_bytes + 2, fill);
    frame.replace (0, PREFIX.size (), PREFIX);
    frame[frame.size () - 2] = '\n';
    frame[frame.size () - 1] = '\n';
    return frame;
}

// An event stream's bytes are stored once, as its body (#3770): the trace's
// `events` node keeps only what the bytes cannot say, and its size follows
// the bytes. Stored once, the row measured 12,726 characters for these 10,200
// bytes; with the list stored beside them it measured 27,854, so the bound
// sits between, at one and a half times the bytes. Mutation checks: drop
// `hold_body_bytes` and the body reads ""; store the parsed list beside the
// sidecar in the completion pass and the `items` and the size checks fail.
TEST_F (StreamExecuteTest, AnEventStreamStoresItsBytesOnceAsTheBody) {
    std::vector<std::string> chunks;
    std::string whole;
    for (int i = 0; i < 100; ++i) {
        chunks.push_back (sse_data_frame (94, static_cast<char> ('a' + (i % 26))));
        whole += chunks.back ();
    }
    ASSERT_EQ (whole.size (), 10200u);
    origin_           = std::make_unique<StreamServer> (std::move (chunks));
    const auto run_id = start (json::object ());
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"], whole) << trace.dump (2);
    EXPECT_EQ (trace["response"].value ("bodyBytes", size_t{ 0 }), whole.size ());
    EXPECT_FALSE (trace["response"].contains ("bodyCapped"));
    EXPECT_EQ (trace["events"]["totalEvents"], 100);
    EXPECT_EQ (trace["events"]["receivedAt"].size (), 100u);
    EXPECT_FALSE (trace["events"].contains ("items"));
    // Ordering only: the transfer began before its first event arrived.
    const auto started_at = trace["events"].value ("startedAt", int64_t{ 0 });
    EXPECT_GT (started_at, 0) << trace["events"].dump ();
    EXPECT_LE (started_at, trace["events"]["receivedAt"][0].get<int64_t> ());

    const auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_LT (rows[0].trace_data.size (), whole.size () + (whole.size () / 2));
}

// The cap on a stream's body is the design bound, and it says so; the stream
// itself runs on and every event is still counted. Mutation check: drop the
// `spec.max_body_bytes` line in `run_streaming_execution` and the whole
// stream is kept, uncapped.
TEST_F (StreamExecuteTest, AnEventStreamPastTheDesignBoundIsCappedAndSaysSo) {
    set_config ("maxDesignResponseBodyBytes", "1024");
    const std::vector<std::string> chunks (30, sse_data_frame (98, 'z'));
    const std::size_t delivered = chunks.size () * chunks.front ().size ();
    origin_                     = std::make_unique<StreamServer> (chunks);
    const auto run_id           = start (json::object ());
    ASSERT_FALSE (run_id.empty ());

    auto trace = served_trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"].get<std::string> ().size (), 1024u)
    << trace.dump (2);
    EXPECT_EQ (trace["response"].value ("bodyCapped", false), true);
    EXPECT_EQ (trace["response"].value ("bodyBytes", size_t{ 0 }), delivered);
    EXPECT_EQ (trace["events"]["totalEvents"], 30);
    EXPECT_TRUE (trace["events"]["eventsTruncated"].get<bool> ());
    EXPECT_LT (trace["events"]["items"].size (), 30u);
}

/// `{"n": <i>}` events with ids, as `serve` writes them, joined.
std::string served_bytes (int count) {
    std::string bytes;
    for (int i = 0; i < count; ++i) {
        bytes += "id: e" + std::to_string (i) +
        "\nevent: tick\ndata: {\"n\": " + std::to_string (i) + "}\n\n";
    }
    return bytes;
}

/// `assert.contains`, `assert.size` and `extract.regex` over the body of a
/// three-event `serve` stream, each of which passes only on its bytes.
json body_reading_elements () {
    return json::array ({ { { "id", "el_contains" }, { "kind", "assert.contains" },
                          { "config", { { "field", "body" }, { "text", "\"n\": 2" } } } },
    { { "id", "el_size" }, { "kind", "assert.size" },
    { "config", { { "bytes", 64 }, { "op", "gte" } } } },
    { { "id", "el_regex" }, { "kind", "extract.regex" },
    { "config",
    { { "pattern", "\"n\": ([0-9]+)" }, { "template", "$1$" },
    { "variable", "lastN" }, { "matchNo", 3 }, { "required", true } } } } });
}

/// Each element's outcome in @p node, keyed by id.
std::map<std::string, std::string> outcomes_by_id (const json& node) {
    std::map<std::string, std::string> out;
    for (const auto& outcome : node) {
        out[outcome.value ("id", "")] = outcome.value ("outcome", "");
    }
    return out;
}

// The issue's acceptance criterion: an element that reads the body judges a
// streamed Send by the bytes it delivered, as the buffered transport (the one
// a collection run and a load run read) judges the same reply. Mutation
// check: drop the `hold_body_bytes` call in `stream_write_callback` and the
// stream's three outcomes read failed, failed and missing.
TEST_F (StreamExecuteTest, BodyReadingElementsJudgeAStreamAsTheBufferedSendDoes) {
    serve (3);
    const auto run_id = start (json{ { "elements", body_reading_elements () } });
    ASSERT_FALSE (run_id.empty ());
    const auto streamed = outcomes_by_id (trace_for (run_id)["elements"]);

    const auto buffered = outcomes_by_id (send_buffered (
    json{ { "elements", body_reading_elements () } })["elements"]);

    const std::map<std::string, std::string> all_ok{ { "el_contains", "ok" },
        { "el_size", "ok" }, { "el_regex", "ok" } };
    EXPECT_EQ (streamed, all_ok);
    EXPECT_EQ (buffered, all_ok);
}

// `pm.response.text()` over a stream is the stream's bytes, as it is over a
// buffered reply (owner decision on #3770). Mutation check: drop the
// `hold_body_bytes` call and the script reads "".
TEST_F (StreamExecuteTest, ThePostRequestScriptReadsTheStreamsBytesAsText) {
    serve (2);
    const auto run_id = start (json{ { "elements",
    script_elements ("",
    "pm.test('text is the bytes', function () { "
    "pm.expect(pm.response.text()).to.equal(" +
    json (served_bytes (2)).dump () + "); });") } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
}

// What `read_body` and `diff_bodies` read (#3770): two streams that delivered
// different events are served as different bodies, and each served list is
// the live one, arrival times included. Mutation checks: drop the
// `expand_stored_stream_events` call in `report_result_node` and no `items`
// is served; drop the `receivedAt` pairing in `buffered_stream_events_node`
// and the items differ from the live ones.
TEST_F (StreamExecuteTest, TheResultsRouteServesEachStreamsBytesAndItsLiveEvents) {
    serve (3);
    const auto first_run = start (json::object ());
    ASSERT_FALSE (first_run.empty ());
    auto first = served_trace_for (first_run);

    serve (5);
    const auto second_run = start (json::object ());
    ASSERT_FALSE (second_run.empty ());
    auto second = served_trace_for (second_run);

    EXPECT_EQ (first["response"]["body"], served_bytes (3));
    EXPECT_EQ (second["response"]["body"], served_bytes (5));
    EXPECT_NE (first["response"]["body"], second["response"]["body"]);

    for (auto [run_id, trace] : std::vector<std::pair<std::string, json>>{
         { first_run, first }, { second_run, second } }) {
        const auto live   = live_events (run_id);
        const auto& items = trace["events"]["items"];
        ASSERT_EQ (items.size (), live.size ()) << trace["events"].dump (2);
        for (std::size_t i = 0; i < live.size (); ++i) {
            EXPECT_TRUE (items[i].contains ("receivedAt")) << items[i].dump ();
            EXPECT_EQ (items[i], live[i]) << "item " << i;
        }
        EXPECT_EQ (trace["events"]["totalEvents"], live.size ());
        EXPECT_FALSE (trace["events"]["eventsTruncated"].get<bool> ());
        EXPECT_EQ (trace["events"]["endReason"], "completed");
        EXPECT_FALSE (trace["events"].contains ("receivedAt"));
        ASSERT_TRUE (trace["events"].contains ("startedAt")) << trace["events"].dump (2);
        EXPECT_LE (trace["events"]["startedAt"].get<int64_t> (),
        items[0]["receivedAt"].get<int64_t> ());
    }

    // `GET /runs/:runId`'s `result`, which History seeds a design run from,
    // serves the same list. Mutation check: drop the
    // `expand_stored_stream_events` call in `attach_design_result`.
    const auto run = db_->get_run (first_run);
    ASSERT_HAS_VALUE (run);
    json payload = json::object ();
    vayu::json::attach_design_result (payload, *run, db_->get_results (first_run));
    EXPECT_EQ (payload["result"]["trace"]["events"], first["events"]);
    EXPECT_TRUE (payload["result"]["trace"]["events"].contains ("startedAt"));
}

// The event cap stops the transfer inside a chunk that held three events, and
// the body holds the whole chunk: the served list stops at the one the stream
// counted. Two bounds hold it, each enough alone: one arrival is kept per
// counted event, and the list never passes `totalEvents`. Mutation check:
// bound the list in `buffered_stream_events_node` by `max_stored_events`
// alone and three are served.
TEST_F (StreamExecuteTest, TheServedListStopsAtTheEventsTheStreamCounted) {
    origin_ = std::make_unique<StreamServer> (
    std::vector<std::string>{ "data: a\n\ndata: b\n\ndata: c\n\n" });
    const auto run_id = start (json{ { "maxStreamEvents", 1 } });
    ASSERT_FALSE (run_id.empty ());

    auto trace = served_trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"], "data: a\n\ndata: b\n\ndata: c\n\n");
    const auto live = live_events (run_id);
    ASSERT_EQ (live.size (), 1u);
    ASSERT_EQ (trace["events"]["items"].size (), 1u) << trace["events"].dump (2);
    EXPECT_EQ (trace["events"]["items"][0], live[0]);
    EXPECT_EQ (trace["events"]["totalEvents"], 1);
    EXPECT_EQ (trace["events"]["endReason"], "maxStreamEvents");
    EXPECT_FALSE (trace["events"]["eventsTruncated"].get<bool> ());
}

// The acceptance criterion (#3773): a Send that declares the OpenAI path gets
// each delta as its event's `text` on the relay, the same items on the served
// trace, and the joined reply as `streamText` there and in the post-request
// script, past `sseMaxStoredEvents` included. Mutation checks: drop the
// `spec.text_path` line in `run_streaming_execution` and nothing carries text;
// drop `streamTextPath` from `stream_trace_node` and the live events keep their
// text while the served trace and the script lose it.
TEST_F (StreamExecuteTest, ADeclaredTextPathReachesTheRelayTheTraceAndTheScript) {
    set_config ("sseMaxStoredEvents", "2");
    origin_ = std::make_unique<StreamServer> (chat_completion_chunks ());
    const auto run_id = start (
    json{ { "streamTextPath", OPENAI_CONTENT }, { "elements", script_elements ("", R"JS(
        pm.test('the joined reply', function () {
            pm.expect(pm.response.streamText).to.equal('Hello');
            pm.expect(pm.response.events[1].text).to.equal('Hel');
        });
    )JS") } });
    ASSERT_FALSE (run_id.empty ());

    auto trace      = served_trace_for (run_id);
    const auto live = live_events (run_id);
    ASSERT_EQ (live.size (), 5u);
    EXPECT_EQ (live[1].value ("text", ""), "Hel");
    EXPECT_EQ (live[3].value ("text", ""), "lo");

    const auto& items = trace["events"]["items"];
    ASSERT_EQ (items.size (), 2u) << trace["events"].dump (2);
    EXPECT_EQ (items[0], live[0]);
    EXPECT_EQ (items[1], live[1]);
    EXPECT_EQ (trace["events"].value ("streamText", "<absent>"), "Hello");

    ASSERT_EQ (trace["scripts"]["testResults"].size (), 1u) << trace.dump (2);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
}

// Past `maxDesignResponseBodyBytes` the body is a prefix and says so, and the
// count keeps going. Mutation check: drop the `spec.max_body_bytes` line in
// `run_streaming_execution` and the whole 3000 bytes are kept, uncapped.
TEST_F (StreamExecuteTest, AReplyPastTheDesignBoundIsCappedAndStillCounted) {
    set_config ("maxDesignResponseBodyBytes", "1024");
    origin_ = std::make_unique<StreamServer> ();
    const std::string chunk (1000, 'x');
    origin_->can (200, "text/plain", { chunk, chunk, chunk });
    const auto run_id = start (json::object (), "/canned");
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"].get<std::string> ().size (), 1024u)
    << trace.dump (2);
    EXPECT_EQ (trace["response"].value ("bodyCapped", false), true);
    EXPECT_EQ (trace["response"].value ("bodyBytes", size_t{ 0 }), size_t{ 3000 });
    EXPECT_FALSE (trace["response"].contains ("bodyTruncated"));
}

// Both cuts on one body: the design bound holds 2048 of 5000 bytes and the
// storage cap keeps 1024 of those. `bodyBytes` stays what the server sent.
// Mutation check: write `bodyBytes` unconditionally in `mark_body_cut` and it
// reads 2048, the held length.
TEST_F (StreamExecuteTest, TheStorageCapKeepsTheStreamsByteCount) {
    set_config ("maxDesignResponseBodyBytes", "2048");
    set_config ("maxTraceBodyBytes", "1024");
    origin_ = std::make_unique<StreamServer> ();
    origin_->can (200, "text/plain", { std::string (5000, 'y') });
    const auto run_id = start (json::object (), "/canned");
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"].get<std::string> ().size (), 1024u)
    << trace.dump (2);
    EXPECT_EQ (trace["response"].value ("bodyCapped", false), true);
    EXPECT_EQ (trace["response"].value ("bodyTruncated", false), true);
    EXPECT_EQ (trace["response"].value ("bodyBytes", size_t{ 0 }), size_t{ 5000 });
}

// ---------------------------------------------------------------------------
// Scripts on the buffered send (issue #725)
//
// The transport that *has* somewhere to return its results stores them too.
// Driven through the real `POST /execute` handler for the same reason the
// streaming cases above are: the wiring is the thing under test, and a test
// that called `record_design_result` directly would stay green with the route
// still throwing the node away.
// ---------------------------------------------------------------------------

TEST_F (StreamExecuteTest, ABufferedSendStoresTheScriptResultsItAlsoReturns) {
    serve (1);
    const auto body = send_buffered (json{ { "elements", script_elements ("", R"JS(
        console.log('asserted');
        pm.test('the origin answered', function () {
            pm.expect(pm.response.code).to.equal(200);
        });
        pm.test('and this one does not hold', function () {
            pm.expect(pm.response.code).to.equal(418);
        });
    )JS") } });
    ASSERT_TRUE (body.contains ("testResults")) << body.dump (2);

    const auto trace = latest_design_trace ();
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);

    // Key for key against the live body rather than field by field: the two
    // panes are the pair this codebase keeps finding drifted, and the only
    // assertion that cannot be satisfied by a subset is the whole object.
    json returned = json::object ();
    for (const char* key :
    { "testResults", "consoleLogs", "preScriptError", "postScriptError" }) {
        if (body.contains (key)) {
            returned[key] = body[key];
        }
    }
    EXPECT_EQ (trace["scripts"], returned) << trace["scripts"].dump (2);

    // And that the stored node really carries the distinctions the pane draws -
    // a restored run must tell passed from failed, and either from never-ran.
    ASSERT_EQ (trace["scripts"]["testResults"].size (), 2u);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ());
    EXPECT_FALSE (trace["scripts"]["testResults"][1]["passed"].get<bool> ());
    EXPECT_FALSE (trace["scripts"]["testResults"][1].value ("error", "").empty ());
    EXPECT_EQ (trace["scripts"]["consoleLogs"][0]["message"], "asserted");
}

// The other half of the rule the streaming path holds: absent means the send
// had no scripts, so an empty node must never be written. Without this,
// "always store something" would pass the test above.
TEST_F (StreamExecuteTest, ABufferedSendWithoutScriptsStoresNoScriptNode) {
    serve (1);
    const auto body = send_buffered (json::object ());
    EXPECT_FALSE (body.contains ("testResults")) << body.dump (2);

    const auto trace = latest_design_trace ();
    EXPECT_FALSE (trace.contains ("scripts")) << trace.dump (2);
    EXPECT_FALSE (trace.contains ("events")) << trace.dump (2);
}

// ---------------------------------------------------------------------------
// `timing.engineMs` (#2132): Vayu's own cost for a buffered send
//
// The handler's elapsed time less the transfer and the scripts, measured once
// and stored on the trace beside the other timing keys. Mutation checks: stop
// accumulating `script_ms` in `execute_exchange` (request_exchange.cpp) and the
// two slow-script cases red; write a different value to the trace than to the
// body in `run_buffered_execution` and the parity case reds; stop passing
// `engine_ms` to `record_design_result` and the stored-key cases red; stop
// subtracting `auth_fetch_ms` in `engine_cost_ms` (#2185) and the first-use
// token case reds.
// ---------------------------------------------------------------------------

/// A script that does nothing for @p ms, so its run is the bulk of the send.
std::string busy_script (int ms) {
    return "var t0 = Date.now(); while (Date.now() - t0 < " + std::to_string (ms) + ") {}";
}

// A loopback send's own cost is milliseconds; a figure this far over it means
// the wire or a script leaked in, which is what the cases below separate. The
// slow script is long enough that half of it clears a sanitizer build's own
// cost (compose, a DB write, a QuickJS start) with room to spare: at 400ms the
// bound was 200ms, close enough to a loaded runner's honest figure to flake.
constexpr double LOOPBACK_ENGINE_CEILING_MS = 1000.0;

constexpr int SLOW_SCRIPT_MS = 1200;

TEST_F (StreamExecuteTest, ABufferedSendReportsItsEngineCostInTheTimingNode) {
    serve (1);
    const auto body = send_buffered (json::object ());

    ASSERT_TRUE (body["timing"].contains ("engineMs")) << body["timing"].dump (2);
    ASSERT_TRUE (body["timing"]["engineMs"].is_number ()) << body["timing"].dump (2);
    const double engine_ms = body["timing"]["engineMs"].get<double> ();
    EXPECT_GE (engine_ms, 0.0);
    EXPECT_LT (engine_ms, LOOPBACK_ENGINE_CEILING_MS);
}

TEST_F (StreamExecuteTest, ASlowPreRequestScriptIsNotCountedAsEngineCost) {
    serve (1);
    const auto body = send_buffered (
    json{ { "elements", script_elements (busy_script (SLOW_SCRIPT_MS)) } });

    EXPECT_LT (body["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << body["timing"].dump (2);
}

TEST_F (StreamExecuteTest, ASlowPostRequestScriptIsNotCountedAsEngineCost) {
    serve (1);
    const auto body = send_buffered (
    json{ { "elements", script_elements ("", busy_script (SLOW_SCRIPT_MS)) } });

    EXPECT_LT (body["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << body["timing"].dump (2);
}

/// A client-credentials config whose token comes from the fixture's `/token`.
json oauth2_auth_for (const std::string& token_url) {
    return { { "mode", "oauth2" },
        { "config",
        { { "grantType", "client_credentials" },
        { "accessTokenUrl", token_url }, { "clientId", "vayu-test" },
        { "clientSecret", "shh" }, { "autoFetchToken", true } } } };
}

// The wait on the identity provider is someone else's time, as a slow origin
// is. The second send proves the subtraction is of the fetch and not of a
// constant: a cached token costs no round trip, so the figure stays small
// because there is nothing slow in the send, not because something was removed.
TEST_F (StreamExecuteTest, AFirstUseTokenFetchIsNotCountedAsEngineCost) {
    serve (1);
    origin_->delay_token (SLOW_SCRIPT_MS);
    const json payload{ { "auth", oauth2_auth_for (origin_->url ("/token")) } };

    const auto started    = std::chrono::steady_clock::now ();
    const auto first      = send_buffered (payload);
    const auto elapsed_ms = std::chrono::duration<double, std::milli> (
    std::chrono::steady_clock::now () - started)
                            .count ();

    // The fetch ran inside this handler; without that the figure below proves
    // nothing.
    ASSERT_EQ (origin_->token_requests (), 1);
    ASSERT_GE (elapsed_ms, static_cast<double> (SLOW_SCRIPT_MS));
    EXPECT_LT (first["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << first["timing"].dump (2);
    EXPECT_EQ (latest_design_trace ()["engineMs"], first["timing"]["engineMs"]);

    const auto second = send_buffered (payload);
    EXPECT_EQ (origin_->token_requests (), 1)
    << "the second send must hit the cache";
    EXPECT_LT (second["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << second["timing"].dump (2);
}

// The restored response shows the figure the live one did: one value, taken
// before the write, so the two homes cannot disagree by construction.
TEST_F (StreamExecuteTest, TheStoredTraceCarriesTheEngineMsTheLiveBodyReturned) {
    serve (1);
    const auto body  = send_buffered (json::object ());
    const auto trace = latest_design_trace ();

    ASSERT_TRUE (trace.contains ("engineMs")) << trace.dump (2);
    EXPECT_EQ (trace["engineMs"], body["timing"]["engineMs"]);
    // Flat on the trace beside the other timing keys, never inside a node.
    EXPECT_TRUE (trace.contains ("wireMs")) << trace.dump (2);
}

// A streaming send answers 202 before any exchange has finished and has no
// handler-scoped figure to give; the stored trace says nothing either.
TEST_F (StreamExecuteTest, AStreamingSendCarriesNoEngineMs) {
    serve (1);
    json payload = { { "method", "GET" }, { "url", origin_->url ("/scripted") },
        { "stream", true } };
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    auto response = client.Post ("/execute", payload.dump (), "application/json");
    ASSERT_TRUE (response);
    ASSERT_EQ (response->status, 202) << response->body;
    const auto accepted = json::parse (response->body);
    EXPECT_FALSE (accepted.contains ("timing")) << accepted.dump (2);

    const auto trace = trace_for (accepted.value ("runId", std::string ()));
    EXPECT_FALSE (trace.contains ("engineMs")) << trace.dump (2);
}

// The early return before any exchange: no figure, and no error for lacking it.
TEST_F (StreamExecuteTest, AnAuthFailureReplyCarriesNoEngineMs) {
    serve (1);
    const auto body = send_buffered (json{ { "auth",
    { { "mode", "oauth2" }, { "autoFetchToken", false },
    { "accessTokenUrl", origin_->url ("/token") } } } });
    ASSERT_TRUE (body.contains ("authErrorCode")) << body.dump (2);

    if (body.contains ("timing")) {
        EXPECT_FALSE (body["timing"].contains ("engineMs")) << body.dump (2);
    }
    EXPECT_FALSE (latest_design_trace ().contains ("engineMs"));
}

// ---------------------------------------------------------------------------
// `timing.scriptMs` (#3676): the script time `engineMs` leaves out
//
// `exchange.script_ms`, taken once beside `engineMs` and stored flat on the
// trace. Only a lower bound is asserted for a slow script: an upper one is the
// side a loaded runner breaks. Mutation checks: stop accumulating `script_ms`
// in `execute_exchange` (request_exchange.cpp) and the two slow-script cases
// red; write a different value to the trace than to the body in
// `run_buffered_execution` and the parity case reds; drop the `scriptMs` key
// from the body or from `record_design_result` and the presence and parity
// cases red.
// ---------------------------------------------------------------------------

/// The share of an injected script delay `scriptMs` must show: the script
/// spins for at least the delay, so anything under it lost time.
constexpr double SCRIPT_MS_FLOOR = SLOW_SCRIPT_MS * 0.9;

TEST_F (StreamExecuteTest, ABufferedSendReportsAScriptTimeInTheTimingNode) {
    serve (1);
    const auto body = send_buffered (json::object ());

    ASSERT_TRUE (body["timing"].contains ("scriptMs")) << body["timing"].dump (2);
    ASSERT_TRUE (body["timing"]["scriptMs"].is_number ()) << body["timing"].dump (2);
    EXPECT_GE (body["timing"]["scriptMs"].get<double> (), 0.0);
}

TEST_F (StreamExecuteTest, ASlowPreRequestScriptShowsAsScriptTime) {
    serve (1);
    const auto body = send_buffered (
    json{ { "elements", script_elements (busy_script (SLOW_SCRIPT_MS)) } });

    EXPECT_GE (body["timing"]["scriptMs"].get<double> (), SCRIPT_MS_FLOOR)
    << body["timing"].dump (2);
    EXPECT_LT (body["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << body["timing"].dump (2);
}

TEST_F (StreamExecuteTest, ASlowPostRequestScriptShowsAsScriptTime) {
    serve (1);
    const auto body = send_buffered (
    json{ { "elements", script_elements ("", busy_script (SLOW_SCRIPT_MS)) } });

    EXPECT_GE (body["timing"]["scriptMs"].get<double> (), SCRIPT_MS_FLOOR)
    << body["timing"].dump (2);
    EXPECT_LT (body["timing"]["engineMs"].get<double> (), SLOW_SCRIPT_MS / 2.0)
    << body["timing"].dump (2);
}

// One reading, taken before the write, so the stored trace and the live body
// cannot disagree; flat on the trace beside `engineMs`, never inside a node.
TEST_F (StreamExecuteTest, TheStoredTraceCarriesTheScriptMsTheLiveBodyReturned) {
    serve (1);
    const auto body =
    send_buffered (json{ { "elements", script_elements (busy_script (50)) } });
    const auto trace = latest_design_trace ();

    ASSERT_TRUE (trace.contains ("scriptMs")) << trace.dump (2);
    EXPECT_EQ (trace["scriptMs"], body["timing"]["scriptMs"]);
    EXPECT_TRUE (trace.contains ("engineMs")) << trace.dump (2);
}

// A streaming send answers 202 with no exchange finished, and the auth-failure
// reply returns before any ran: neither has a figure, so neither stores one.
TEST_F (StreamExecuteTest, AStreamingSendCarriesNoScriptMs) {
    serve (1);
    json payload = { { "method", "GET" }, { "url", origin_->url ("/scripted") },
        { "stream", true } };
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    auto response = client.Post ("/execute", payload.dump (), "application/json");
    ASSERT_TRUE (response);
    ASSERT_EQ (response->status, 202) << response->body;
    const auto accepted = json::parse (response->body);
    EXPECT_FALSE (accepted.contains ("timing")) << accepted.dump (2);

    const auto trace = trace_for (accepted.value ("runId", std::string ()));
    EXPECT_FALSE (trace.contains ("scriptMs")) << trace.dump (2);
}

TEST_F (StreamExecuteTest, AnAuthFailureReplyCarriesNoScriptMs) {
    serve (1);
    const auto body = send_buffered (json{ { "auth",
    { { "mode", "oauth2" }, { "autoFetchToken", false },
    { "accessTokenUrl", origin_->url ("/token") } } } });
    ASSERT_TRUE (body.contains ("authErrorCode")) << body.dump (2);

    if (body.contains ("timing")) {
        EXPECT_FALSE (body["timing"].contains ("scriptMs")) << body.dump (2);
    }
    EXPECT_FALSE (latest_design_trace ().contains ("scriptMs"));
}

// The relay's `event: complete` is the app's one cue to read the report, so it
// must mean the run row and trace are stored (#3239). The post-request script
// spins so that the window between the transfer's end and the row write is
// wide; the report is read once, unpolled, the moment the relay ends. Healthy:
// one result, run terminal. Mutation check: close the context in
// `consume_sse_stream` again and the relay ends while the script still spins,
// leaving no result and the run `running`.
TEST_F (StreamExecuteTest, TheCompleteFrameMeansTheReportIsStored) {
    constexpr int POST_SCRIPT_MS = 500;
    serve (2);
    const auto run_id = start (json{ { "elements",
    script_elements ("", "console.log ('stored');" + busy_script (POST_SCRIPT_MS)) } });
    ASSERT_FALSE (run_id.empty ());

    httplib::Client relay ("127.0.0.1", port_);
    relay.set_read_timeout (20, 0);
    const auto events = relay.Get ("/runs/" + run_id + "/events");
    ASSERT_TRUE (events);
    ASSERT_EQ (events->status, 200);
    ASSERT_NE (events->body.find ("event: complete"), std::string::npos)
    << events->body;

    auto [status, report] = vayu::http::routes::run_report_response (*db_, run_id);
    ASSERT_EQ (status, 200) << report.dump (2);
    EXPECT_EQ (report["results"].size (), 1u) << report.dump (2);
    EXPECT_EQ (report["metadata"]["status"], "completed") << report.dump (2);

    const auto trace = latest_design_trace ();
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    ASSERT_FALSE (trace["scripts"]["consoleLogs"].empty ()) << trace.dump (2);
    EXPECT_EQ (trace["scripts"]["consoleLogs"][0]["message"], "stored");
}

// ---------------------------------------------------------------------------
// Stopping a stream that has already ended (#3342)
//
// The transfer reads the stop flag only while it runs, so a stream the server
// closed or that failed is past it when a Stop arrives during its post-request
// script. Each script here is parked in a `pm.sendRequest` to the held `/aside`
// until the route has signalled the stop, which puts the Stop between the
// transfer's end and the row write every time. Mutation check: answer
// `stopped` for every settled stream in `stream_stop_response` again and both
// tests fail.
// ---------------------------------------------------------------------------

class StreamStopTest : public StreamExecuteTest {
    protected:
    /// Stop @p run_id while its post-request script is parked, then let the
    /// script go, and return the answer.
    json stop_while_the_script_is_parked (const std::string& run_id) {
        if (!vayu::tests::wait_until (
            [this] () { return origin_->aside_requests () == 1; })) {
            ADD_FAILURE () << "the post-request script never reached /aside";
            origin_->release_aside ();
            return json::object ();
        }
        auto answer = std::async (
        std::launch::async, [this, run_id] () { return stop (run_id); });
        const auto stream = manager_->get (run_id);
        EXPECT_TRUE (vayu::tests::wait_until (
        [&stream] () { return stream && stream->requested_end ().has_value (); }))
        << "the route never signalled the stop";
        origin_->release_aside ();
        return answer.get ();
    }

    /// A payload whose post-request script sends to the held `/aside`.
    json parked_script_payload () const {
        const std::string script =
        "pm.sendRequest('" + origin_->url ("/aside") + "', function () {});";
        return { { "elements", script_elements ("", script) },
            { "allowScriptRequests", true } };
    }
};

TEST_F (StreamStopTest, AStopAfterTheServerEndedTheStreamAnswersCompleted) {
    serve (2);
    origin_->hold_aside ();
    const auto run_id = start (parked_script_payload ());
    ASSERT_FALSE (run_id.empty ());

    const auto body = stop_while_the_script_is_parked (run_id);
    EXPECT_EQ (body.value ("status", ""), "completed") << body.dump ();
    EXPECT_EQ (body.value ("message", ""), "The stream had already ended")
    << body.dump ();
    EXPECT_EQ (body.value ("totalEvents", -1), 2) << body.dump ();
    const auto run = db_->get_run (run_id);
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Completed);
}

TEST_F (StreamStopTest, AStopAfterTheStreamFailedAnswersFailed) {
    serve (0);
    origin_->hold_aside ();
    json payload      = parked_script_payload ();
    payload["url"]    = "http://127.0.0.1:1/nothing";
    const auto run_id = start (payload);
    ASSERT_FALSE (run_id.empty ());

    const auto body = stop_while_the_script_is_parked (run_id);
    EXPECT_EQ (body.value ("status", ""), "failed") << body.dump ();
    const auto run = db_->get_run (run_id);
    ASSERT_HAS_VALUE (run);
    EXPECT_EQ (run->status, vayu::RunStatus::Failed);
}

// The Stop the transfer does read still answers what it decided.
TEST_F (StreamStopTest, AStopOfALiveStreamAnswersStopped) {
    origin_           = std::make_unique<StreamServer> ();
    const auto run_id = start (json::object (), "/endless");
    ASSERT_FALSE (run_id.empty ());
    const auto stream = manager_->get (run_id);
    ASSERT_NE (stream, nullptr);
    ASSERT_TRUE (vayu::tests::wait_until (
    [&stream] () { return stream->total_events () >= 1; }));

    const auto body = stop (run_id);
    EXPECT_EQ (body.value ("status", ""), "stopped") << body.dump ();
    EXPECT_EQ (body.value ("message", ""), "Stream stopped") << body.dump ();
}

// ---------------------------------------------------------------------------
// `persistVariables: false` (#1904), on both transports
//
// An extractor writing the globals and a post-request script writing the
// environment, in one send. With the flag the elements still run and report,
// and the script reads the extracted value back within the send, but neither
// row on disk changes; without it both are written, which is what keeps the
// unchanged-row assertions from passing vacuously. Mutation check: pass `true`
// for the flag at either transport's `persist_send_variables` call in
// execution.cpp and that transport's opted-out case reds.
// ---------------------------------------------------------------------------

class PersistVariablesExecuteTest : public StreamExecuteTest {
    protected:
    static constexpr const char* ENV_ID = "env_persist";

    void SetUp () override {
        StreamExecuteTest::SetUp ();
        vayu::db::Environment environment;
        environment.id         = ENV_ID;
        environment.name       = "Env";
        environment.variables  = "{}";
        environment.created_at = 1;
        environment.updated_at = 1;
        db_->save_environment (environment);

        vayu::db::Globals globals;
        globals.id         = "globals";
        globals.variables  = "{}";
        globals.updated_at = 1;
        db_->save_globals (globals);
    }

    /// The payload under test, @p persist stated only when it has a value.
    static json payload (std::optional<bool> persist) {
        json elements = json::array ();
        elements.push_back ({ { "id", "el_extract" }, { "kind", "extract.header" },
        { "config",
        { { "header", "Content-Type" }, { "variable", "fromExtractor" },
        { "scope", "globals" } } } });
        for (auto& script : script_elements ("", R"JS(
            pm.environment.set('fromScript', 'v');
            pm.test('the extracted value is visible within the send', function () {
                pm.expect(pm.globals.get('fromExtractor')).to.include('event-stream');
            });
        )JS")) {
            elements.push_back (std::move (script));
        }
        json body{ { "environmentId", ENV_ID }, { "elements", std::move (elements) } };
        if (persist) {
            body["persistVariables"] = *persist;
        }
        return body;
    }

    json stored_globals () {
        auto row = db_->get_globals ();
        if (!row) {
            ADD_FAILURE () << "the seeded globals row is gone";
            return json::object ();
        }
        return json::parse (row->variables);
    }

    json stored_environment () {
        auto row = db_->get_environment (ENV_ID);
        if (!row) {
            ADD_FAILURE () << "the seeded environment row is gone";
            return json::object ();
        }
        return json::parse (row->variables);
    }

    /// The send ran both elements: the extractor answered `ok` and the
    /// script's own assertion passed.
    static void expect_elements_ran (const json& elements, const json& tests) {
        ASSERT_TRUE (elements.is_array ()) << elements.dump (2);
        ASSERT_FALSE (elements.empty ()) << elements.dump (2);
        EXPECT_EQ (elements[0].value ("kind", ""), "extract.header")
        << elements.dump (2);
        EXPECT_EQ (elements[0].value ("outcome", ""), "ok") << elements.dump (2);
        ASSERT_EQ (tests.size (), 1u) << tests.dump (2);
        EXPECT_TRUE (tests[0].value ("passed", false)) << tests.dump (2);
    }
};

TEST_F (PersistVariablesExecuteTest, ABufferedSendThatOptsOutWritesNothingBack) {
    serve (1);
    const auto body = send_buffered (payload (false));
    expect_elements_ran (
    body.value ("elements", json ()), body.value ("testResults", json ()));

    EXPECT_EQ (stored_globals (), json::object ());
    EXPECT_EQ (stored_environment (), json::object ());
}

TEST_F (PersistVariablesExecuteTest, ABufferedSendPersistsByDefault) {
    serve (1);
    const auto body = send_buffered (payload (std::nullopt));
    expect_elements_ran (
    body.value ("elements", json ()), body.value ("testResults", json ()));

    EXPECT_TRUE (stored_globals ().contains ("fromExtractor"))
    << stored_globals ().dump ();
    EXPECT_TRUE (stored_environment ().contains ("fromScript"))
    << stored_environment ().dump ();
}

TEST_F (PersistVariablesExecuteTest, AStreamThatOptsOutWritesNothingBack) {
    serve (1);
    const auto run_id = start (payload (false));
    ASSERT_FALSE (run_id.empty ());
    // The trace is written after the persist call, so its arrival means the
    // completion callback has already decided.
    const auto trace = trace_for (run_id);
    expect_elements_ran (trace.value ("elements", json ()),
    trace.value ("scripts", json::object ()).value ("testResults", json ()));

    EXPECT_EQ (stored_globals (), json::object ());
    EXPECT_EQ (stored_environment (), json::object ());
}

TEST_F (PersistVariablesExecuteTest, AStreamPersistsByDefault) {
    serve (1);
    const auto run_id = start (payload (true));
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);
    expect_elements_ran (trace.value ("elements", json ()),
    trace.value ("scripts", json::object ()).value ("testResults", json ()));

    EXPECT_TRUE (stored_globals ().contains ("fromExtractor"))
    << stored_globals ().dump ();
    EXPECT_TRUE (stored_environment ().contains ("fromScript"))
    << stored_environment ().dump ();
}

// Refused before a run row exists, like every other malformed flag.
TEST_F (PersistVariablesExecuteTest, ANonBooleanFlagIsA400WithNoRunRow) {
    serve (1);
    json body                = payload (std::nullopt);
    body["method"]           = "GET";
    body["url"]              = origin_->url ("/scripted");
    body["persistVariables"] = "false";
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    auto response = client.Post ("/execute", body.dump (), "application/json");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 400) << response->body;
    EXPECT_NE (response->body.find ("persistVariables"), std::string::npos)
    << response->body;
    EXPECT_TRUE (db_->get_runs_paginated (vayu::db::RunFilter{}, 1, 0).empty ());
}

} // namespace
