/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/sse_stream_execute_test.cpp
 * @brief `StreamExecuteTest`: a stream's scripts and trace, the cookie jar on buffered and streamed
 * sends, the jar's cookie limits and the script `sendRequest` surface.
 *
 * The in-process SSE server, the helpers shared by these files and the `StreamExecuteTest`
 * fixture are in `sse_stream_fixture.hpp`.
 */

// First, before anything that includes <httplib.h>: see the header. Needed
// for `proxy_server.hpp`, whose forwarder builds an `httplib::Client` from a URL.
#include "vayu/http/httplib_client_url.hpp"

#include <gtest/gtest.h>

#include <cstddef>
#include <iterator>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "silent_listener.hpp"
#include "timed_out_after.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/utils/logger.hpp"
#include "verbosity_restorer.hpp"

#include "sse_stream_fixture.hpp"

namespace {

using nlohmann::json;
namespace sse_constants = vayu::core::constants::sse;
using vayu::tests::sse_stream::script_elements;
using vayu::tests::sse_stream::StreamExecuteTest;
using vayu::tests::sse_stream::StreamServer;

// The acceptance criterion: a script asserts over what the stream delivered,
// and the entries carry the shape the surface promises.
TEST_F (StreamExecuteTest, TheStreamsPostRequestScriptSeesItsEvents) {
    serve (3);
    const auto run_id = start (json{ { "elements", script_elements ("", R"JS(
        pm.test('three events', function () {
            pm.expect(pm.response.events.length).to.equal(3);
        });
        pm.test('names and ids came through', function () {
            pm.expect(pm.response.events[0].event).to.equal('tick');
            pm.expect(pm.response.events[0].id).to.equal('e0');
            pm.expect(JSON.parse(pm.response.events[2].data).n).to.equal(2);
        });
        pm.test('the whole stream is here', function () {
            pm.expect(pm.response.totalEvents).to.equal(3);
            pm.expect(pm.response.eventsTruncated).to.equal(false);
        });
    )JS") } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    const auto& scripts = trace["scripts"];
    ASSERT_TRUE (scripts.contains ("testResults")) << scripts.dump (2);
    ASSERT_EQ (scripts["testResults"].size (), 3u);
    for (const auto& test : scripts["testResults"]) {
        EXPECT_TRUE (test["passed"].get<bool> ())
        << test["name"] << ": " << test.value ("error", "");
    }
    EXPECT_FALSE (scripts.contains ("postScriptError")) << scripts.dump (2);
}

// The other half of the same fact: what the script read and what the trace
// stored are one node, so a reader of either sees the same truncation.
TEST_F (StreamExecuteTest, TruncationIsVisibleToTheScriptAndMatchesTheTrace) {
    set_config ("sseMaxStoredEvents", "2");
    serve (5);
    const auto run_id = start (json{ { "elements", script_elements ("", R"JS(
        pm.test('the list is a prefix and says so', function () {
            pm.expect(pm.response.eventsTruncated).to.equal(true);
            pm.expect(pm.response.events.length).to.equal(2);
            pm.expect(pm.response.totalEvents).to.equal(5);
        });
    )JS") } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    ASSERT_EQ (trace["scripts"]["testResults"].size (), 1u);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
    // Stated twice on purpose: the assertion above proves the script saw it,
    // and this proves the served node the app restores from says the same.
    auto served = served_trace_for (run_id);
    EXPECT_TRUE (served["events"]["eventsTruncated"].get<bool> ()) << served.dump (2);
    EXPECT_EQ (served["events"]["totalEvents"], 5);
    EXPECT_EQ (served["events"]["items"].size (), 2u);
}

// #2522 on the streaming transport: the elements a composed send carries are
// stamped with their level, and the stored trace (the route already answered
// 202, so it is the only place the results land) keeps each level's test under
// its own scope instead of the request's passing one replacing the collection's
// failing one.
TEST_F (StreamExecuteTest, AStreamsTraceKeepsTheCollectionsFailingTestUnderItsScope) {
    serve (1);
    const auto post_at = [] (const std::string& scope, const std::string& id,
                         const std::string& body) {
        return json{ { "id", id }, { "kind", "script.post" },
            { "config", { { "script", body } } },
            { "origin",
            { { "kind", scope == "request" ? "request" : "collection" },
            { "scope", scope }, { "id", "owner_" + scope } } } };
    };
    const auto run_id = start (json{ { "elements",
    json::array ({ post_at ("collection", "el_col", "pm.test('collection must fail', () => pm.expect(1).to.eql(2));"),
    post_at ("request", "el_req", "pm.test('request passes', () => pm.expect(1).to.eql(1));") }) } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    const auto& tests = trace["scripts"]["testResults"];
    ASSERT_EQ (tests.size (), 2u) << trace["scripts"].dump (2);
    EXPECT_EQ (tests[0]["name"], "collection must fail");
    EXPECT_FALSE (tests[0]["passed"].get<bool> ());
    EXPECT_EQ (tests[0]["scope"], "collection");
    EXPECT_EQ (tests[1]["name"], "request passes");
    EXPECT_EQ (tests[1]["scope"], "request");
}

// #3779 on the streaming transport: an assertion's `{{data.column}}` resolves
// against the send's own row, and a column the row lacks fails the assertion
// by name rather than comparing the template. The post-request pass runs in
// the completion callback, so its context must carry the resolver itself.
// Mutation check: drop `.resolve_template` from the `step.after` context in
// `execution.cpp` and the passing case reports the unresolved-token failure.
TEST_F (StreamExecuteTest, AnAssertionResolvesTheSendsDataRowInTheCompletionPass) {
    serve (1);
    const auto assert_url_contains = [] (const std::string& text) {
        return json::array ({ { { "id", "el_a" }, { "kind", "assert.contains" },
        { "config", { { "field", "url" }, { "text", text } } } } });
    };
    const auto first_test = [this] (const json& payload) {
        const auto run_id = start (payload);
        EXPECT_FALSE (run_id.empty ());
        const auto trace = trace_for (run_id);
        EXPECT_TRUE (trace.contains ("scripts")) << trace.dump (2);
        return trace.value ("scripts", json::object ())
        .value ("testResults", json::array ())
        .at (0);
    };

    const auto passing = first_test (json{ { "data", { { "leaf", "scripted" } } },
    { "elements", assert_url_contains ("/{{data.leaf}}") } });
    EXPECT_TRUE (passing["passed"].get<bool> ()) << passing.dump (2);

    const auto failing = first_test (json{ { "data", { { "leaf", "elsewhere" } } },
    { "elements", assert_url_contains ("/{{data.leaf}}") } });
    EXPECT_FALSE (failing["passed"].get<bool> ()) << failing.dump (2);
    EXPECT_EQ (failing["error"], "expected url to contain '/{{data.leaf}}'");

    const auto missing = first_test (json{ { "data", { { "leaf", "scripted" } } },
    { "elements", assert_url_contains ("/{{data.leef}}") } });
    EXPECT_FALSE (missing["passed"].get<bool> ()) << missing.dump (2);
    EXPECT_EQ (missing["error"],
    "'text' uses {{data.leef}}, which no variable or data column answers");
}

// A stream's scripts' `pm.sendRequest` records reach its stored trace, the
// only place they can land once the route has answered 202 (#3633). The call
// is refused, so the record is the failure one and no second server is needed.
// Mutation check: leave `record_script_requests` out of `build_design_send`
// and the trace has no list, on this transport as on the buffered one.
TEST_F (StreamExecuteTest, AStreamsTraceCarriesItsScriptRequests) {
    serve (1);
    const auto run_id = start (json{ { "allowScriptRequests", true },
    { "elements", script_elements ("pm.sendRequest('http://127.0.0.1:1/', function () {});") } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    const auto records = trace["scripts"].value ("scriptRequests", json::array ());
    ASSERT_EQ (records.size (), 1u) << trace["scripts"].dump (2);
    EXPECT_EQ (records[0]["source"], "pre");
    EXPECT_EQ (records[0]["status"], 0);
    EXPECT_EQ (records[0]["error_type"], "CONNECTION_FAILED");
    EXPECT_EQ (trace["scripts"]["consoleLogs"][0]["scriptRequest"], 0);
}

// A pre-request script on a stream is not a special case - it edits the request
// that goes on the wire, exactly as it does on a buffered send. Proven off the
// origin's own record of what arrived, not off the plan.
TEST_F (StreamExecuteTest, ThePreRequestScriptsEditReachesTheWire) {
    serve (1);
    const auto run_id = start (
    json{ { "elements", script_elements ("pm.request.headers.add({ key: 'X-From-Script', value: 'yes' });", R"JS(
        pm.test('the stream still ran', function () {
            pm.expect(pm.response.events.length).to.equal(1);
        });
    )JS") } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ());
    EXPECT_EQ (origin_->received_header ("X-From-Script"), "yes");
}

// ---------------------------------------------------------------------------
// Postman's `disableCookies` (issue #1765), on both transports
//
// The jar is seeded by an ordinary send first, so the assertion that nothing
// went out is not vacuous: the same request without the flag is shown to carry
// the cookie. One `cookie_jar` pointer decides both halves on each transport,
// so the read and write halves share a mutant there: attach the jar despite
// the flag (`config.cookie_jar` in `execute_exchange`, `attach_stream_jar`
// in `execution.cpp`) and each test below reds.
// ---------------------------------------------------------------------------

TEST_F (StreamExecuteTest, ABufferedSendWithTheJarOffAttachesNoJarCookie) {
    serve (1);
    origin_->set_cookie ("seed=1; Path=/");
    send_buffered (json::object ());
    origin_->set_cookie ("");

    send_buffered (json::object ());
    ASSERT_EQ (origin_->received_header ("Cookie"), "seed=1")
    << "the seeding send did not reach the jar, so the check below proves "
       "nothing";

    send_buffered (json{ { "disableCookies", true } });
    EXPECT_EQ (origin_->received_header ("Cookie"), "")
    << "a request with disableCookies carried the jar's cookie";
}

TEST_F (StreamExecuteTest, ABufferedSendWithTheJarOffStoresNoSetCookie) {
    serve (1);
    origin_->set_cookie ("fresh=1; Path=/");
    const json answer = send_buffered (json{ { "disableCookies", true } });
    EXPECT_TRUE (cookie_jar_.lines_for ("").empty ())
    << "a Set-Cookie on a request with disableCookies reached the jar";
    // The response still reports what the server set.
    EXPECT_NE (answer.dump ().find ("fresh=1"), std::string::npos) << answer.dump ();
}

// The pre-request script's `pm.cookies.jar()` write has no transfer to ride,
// so it is applied directly - once, and still not sent on this request.
// Mutation check: drop the `jar.apply` in the jar-off branch of
// `execute_exchange` and the jar reads empty.
TEST_F (StreamExecuteTest, ABufferedSendWithTheJarOffStillPersistsThePreRequestWrite) {
    serve (1);
    send_buffered (json{ { "disableCookies", true },
    { "elements",
    script_elements ("pm.cookies.jar().set('" + origin_->url ("/") +
    "', { name: 'pre', value: 'v' });") } });
    EXPECT_EQ (origin_->received_header ("Cookie"), "");
    const auto lines = cookie_jar_.lines_for ("");
    ASSERT_EQ (lines.size (), 1u);
    EXPECT_NE (lines[0].find ("pre\tv"), std::string::npos) << lines[0];
}

TEST_F (StreamExecuteTest, AStreamWithTheJarOffAttachesNoJarCookieAndStoresNone) {
    serve (1);
    origin_->set_cookie ("seed=1; Path=/");
    send_buffered (json::object ());
    origin_->set_cookie ("fresh=1; Path=/");

    const auto run_id = start (json{ { "disableCookies", true } });
    ASSERT_FALSE (run_id.empty ());
    trace_for (run_id);
    EXPECT_EQ (origin_->received_header ("Cookie"), "")
    << "a stream with disableCookies carried the jar's cookie";
    const auto lines = cookie_jar_.lines_for ("");
    ASSERT_EQ (lines.size (), 1u)
    << "a stream with disableCookies stored its Set-Cookie";
    EXPECT_NE (lines[0].find ("seed"), std::string::npos) << lines[0];

    // The control: the same stream with the jar on sends the cookie.
    const auto control = start (json::object ());
    ASSERT_FALSE (control.empty ());
    trace_for (control);
    EXPECT_EQ (origin_->received_header ("Cookie"), "seed=1");
}

// Mutation check: drop the `jar.apply` in `attach_stream_jar`'s jar-off case
// and the jar reads empty.
TEST_F (StreamExecuteTest, AStreamWithTheJarOffStillPersistsThePreRequestWrite) {
    serve (1);
    const auto run_id = start (json{ { "disableCookies", true },
    { "elements",
    script_elements ("pm.cookies.jar().set('" + origin_->url ("/") +
    "', { name: 'pre', value: 'v' });") } });
    ASSERT_FALSE (run_id.empty ());
    trace_for (run_id);
    EXPECT_EQ (origin_->received_header ("Cookie"), "");
    EXPECT_EQ (cookie_jar_.lines_for ("").size (), 1u);
}

// A stream the manager refuses to start (the daemon draining) never ran, so
// its pre-request write is dropped - as the jar-on path drops the writes it
// hands the refused spec. Mutation check: apply the jar-off writes inside
// `attach_stream_jar` again, before `sse_manager.start`, and the jar holds
// the write.
TEST_F (StreamExecuteTest, ARefusedStreamWithTheJarOffPersistsNoPreRequestWrite) {
    serve (1);
    manager_->shutdown ();
    json payload{ { "method", "GET" }, { "url", origin_->url ("/scripted") },
        { "stream", true }, { "disableCookies", true },
        { "elements",
        script_elements ("pm.cookies.jar().set('" + origin_->url ("/") +
        "', { name: 'pre', value: 'v' });") } };
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    auto response = client.Post ("/execute", payload.dump (), "application/json");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 503) << response->body;
    EXPECT_TRUE (cookie_jar_.lines_for ("").empty ())
    << "a refused stream persisted its pre-request cookie write";
}

// ---------------------------------------------------------------------------
// Cookie warnings on a stream (issue #3315)
//
// A stream reports the four cookie warnings a buffered send does
// (`cookie_jar_test.cpp` holds their wording) on its stored trace: the route
// answered `202` before the transfer, and no relay frame carries them. The
// route hands the stream the fixture's jar under scope "" (no environment).
// ---------------------------------------------------------------------------

/// @p count jar cookies for the loopback origin, named `<stem>0`, `<stem>1`,
/// ..., each @p value_bytes of `v`.
std::vector<std::string>
loopback_jar_lines (const std::string& stem, int count, size_t value_bytes) {
    std::vector<std::string> lines;
    lines.reserve (static_cast<size_t> (count));
    for (int i = 0; i < count; ++i) {
        lines.push_back ("127.0.0.1\tFALSE\t/\tFALSE\t4102444800\t" + stem +
        std::to_string (i) + "\t" + std::string (value_bytes, 'v'));
    }
    return lines;
}

/// `Set-Cookie` values `<stem>0=secret-0`, `<stem>1=secret-1`, ...
std::vector<std::string> numbered_set_cookies (int count, const std::string& stem = "c") {
    std::vector<std::string> values;
    values.reserve (static_cast<size_t> (count));
    for (int i = 0; i < count; ++i) {
        values.push_back (
        stem + std::to_string (i) + "=secret-" + std::to_string (i) + "; Path=/");
    }
    return values;
}

/// The stored trace's top-level warnings that carry @p code.
std::vector<json> trace_warnings (const json& trace, const std::string& code) {
    std::vector<json> found;
    std::ranges::copy_if (trace.value ("warnings", json::array ()),
    std::back_inserter (found),
    [&] (const json& warning) { return warning.value ("code", "") == code; });
    return found;
}

/// No warning on @p trace quotes a cookie value the fixtures use.
void expect_no_cookie_value (const json& trace) {
    const std::string warnings = trace.value ("warnings", json::array ()).dump ();
    EXPECT_EQ (warnings.find ("vvvv"), std::string::npos) << warnings;
    EXPECT_EQ (warnings.find ("secret-"), std::string::npos) << warnings;
}

/// The `sentHeaders` record of @p trace, or an empty object.
json sent_headers (const json& trace) {
    return trace.value ("request", json::object ()).value ("sentHeaders", json::object ());
}

/// A payload whose request types a `Cookie` row.
json typed_cookie_row () {
    return json{ { "headers", { { "Cookie", "typed=2" } } } };
}

// Three ~3000-byte jar cookies pass libcurl's 8190-byte Cookie line at the
// third, which takes the typed row with it: the trace names the cookie, and
// `sentHeaders` stops claiming the typed row went out. At both ends of the
// console verbosity, because the warning is the trace's, not the log's.
// Mutation-check: drop `CURLOPT_DEBUGFUNCTION` in `consume_sse_stream` and no
// warning arrives; return early from `stream_debug_callback` below verbosity
// 2 and the verbosity-0 pass finds none; drop `apply_cookie_notices`' erase
// and the typed row stays in `sentHeaders`.
TEST_F (StreamExecuteTest, AStreamNamesAJarCookieWithheldForTheHeaderLimit) {
    const vayu::tests::VerbosityRestorer restore;
    serve (1);
    cookie_jar_.store ("", loopback_jar_lines ("big", 3, 3000));
    for (const int verbosity : { 0, 2 }) {
        vayu::utils::Logger::instance ().set_verbosity (verbosity);
        const auto run_id = start (typed_cookie_row ());
        ASSERT_FALSE (run_id.empty ());
        const auto trace = trace_for (run_id);

        const auto found = trace_warnings (trace, "cookie_not_sent");
        ASSERT_EQ (found.size (), 1U)
        << "verbosity " << verbosity << ": " << trace.dump (2);
        EXPECT_NE (found.front ().value ("message", "").find ("Cookie big"), std::string::npos)
        << found.front ().dump ();
        EXPECT_TRUE (trace_warnings (trace, "cookie_limit_reached").empty ());
        expect_no_cookie_value (trace);
        EXPECT_EQ (origin_->received_header ("Cookie").find ("typed"), std::string::npos)
        << "the typed row reached the server, so the record is not what is "
           "wrong";
        EXPECT_FALSE (sent_headers (trace).contains ("Cookie"))
        << "sentHeaders still claims a Cookie row the wire never carried";
    }
}

// Past 150 jar cookies libcurl sends 150 and says so; the typed row still goes
// out and stays in the record. Mutation-check: drop `CURLOPT_DEBUGFUNCTION` in
// `consume_sse_stream` and no warning arrives; return early from
// `stream_debug_callback` below verbosity 2 and the verbosity-0 pass finds
// none.
TEST_F (StreamExecuteTest, AStreamReportsTheJarCookieCountCap) {
    const vayu::tests::VerbosityRestorer restore;
    serve (1);
    cookie_jar_.store ("", loopback_jar_lines ("c", 151, 1));
    for (const int verbosity : { 0, 2 }) {
        vayu::utils::Logger::instance ().set_verbosity (verbosity);
        const auto run_id = start (typed_cookie_row ());
        ASSERT_FALSE (run_id.empty ());
        const auto trace = trace_for (run_id);

        ASSERT_EQ (trace_warnings (trace, "cookie_limit_reached").size (), 1U)
        << "verbosity " << verbosity << ": " << trace.dump (2);
        EXPECT_TRUE (trace_warnings (trace, "cookie_not_sent").empty ());
        EXPECT_NE (origin_->received_header ("Cookie").find ("typed=2"), std::string::npos);
        EXPECT_EQ (sent_headers (trace).value ("Cookie", ""), "typed=2");
    }
}

// libcurl keeps the first 50 cookies of a response and ignores the rest
// without a word. Mutation-check: drop `watch_set_cookie` in
// `stream_header_callback` and no warning arrives.
TEST_F (StreamExecuteTest, AStreamReportsTheFiftyFirstSetCookieAsIgnored) {
    serve (1);
    origin_->set_cookies (numbered_set_cookies (51));
    const auto run_id = start (json::object ());
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);

    const auto found = trace_warnings (trace, "cookie_dropped_too_many");
    ASSERT_EQ (found.size (), 1U) << trace.dump (2);
    EXPECT_NE (found.front ().value ("message", "").find ("1 Set-Cookie header after that was ignored"),
    std::string::npos)
    << found.front ().dump ();
    expect_no_cookie_value (trace);
}

// A `Set-Cookie` line over 5000 bytes is discarded unread; the trace names the
// cookie, never its value. Mutation-check: drop `watch_set_cookie` in
// `stream_header_callback` and no warning arrives.
TEST_F (StreamExecuteTest, AStreamNamesAnOversizedSetCookie) {
    serve (1);
    origin_->set_cookies ({ "huge=" + std::string (5000, 'v') + "; Path=/" });
    const auto run_id = start (json::object ());
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);

    const auto found = trace_warnings (trace, "cookie_dropped_oversized");
    ASSERT_EQ (found.size (), 1U) << trace.dump (2);
    EXPECT_NE (found.front ().value ("message", "").find (": huge."), std::string::npos)
    << found.front ().dump ();
    expect_no_cookie_value (trace);
}

// libcurl's per-response count restarts at every response, so 30 cookies on
// a followed redirect and 30 on the stream behind it are no overflow.
// Mutation-check: drop `start_response` in `stream_header_callback` and 10
// are reported ignored.
TEST_F (StreamExecuteTest, AStreamsSetCookieCountRestartsAtEachHop) {
    serve (1);
    origin_->hop_to (origin_->url ("/scripted"));
    origin_->hop_cookies (numbered_set_cookies (30, "h"));
    origin_->set_cookies (numbered_set_cookies (30));
    const auto run_id = start (json::object (), "/hop");
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);

    ASSERT_EQ (origin_->hops_received (), 1) << "the stream was not redirected";
    EXPECT_FALSE (trace.contains ("warnings")) << trace["warnings"].dump (2);
}

// Both hops of a redirect attach the same jar cookies and libcurl reports each
// time; the trace names the cookie once. Mutation-check: drop the
// de-duplication in `note_cookie_notice` and the count is 2.
TEST_F (StreamExecuteTest, ARedirectedStreamNamesAWithheldCookieOnce) {
    serve (1);
    cookie_jar_.store ("", loopback_jar_lines ("big", 3, 3000));
    origin_->hop_to (origin_->url ("/scripted"));
    const auto run_id = start (json::object (), "/hop");
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);

    ASSERT_EQ (origin_->hops_received (), 1) << "the stream was not redirected";
    EXPECT_EQ (trace_warnings (trace, "cookie_not_sent").size (), 1U) << trace.dump (2);
}

// The other branch of all four: a stream under every limit stores no
// `warnings` key, and its typed row stays in the record.
TEST_F (StreamExecuteTest, AStreamUnderEveryCookieLimitStoresNoWarnings) {
    serve (1);
    cookie_jar_.store ("", loopback_jar_lines ("small", 3, 10));
    origin_->set_cookies (numbered_set_cookies (50));
    const auto run_id = start (typed_cookie_row ());
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);

    EXPECT_FALSE (trace.contains ("warnings")) << trace["warnings"].dump (2);
    EXPECT_EQ (sent_headers (trace).value ("Cookie", ""), "typed=2");
}

// `disableCookies` keeps libcurl's cookie engine off, so nothing is withheld or
// dropped and nothing is reported; the same jar and origin warn with the jar
// on. Mutation-check: point `state.incoming_cookies` at the watch whether or
// not the stream has a jar and the jar-off run reports the 51st.
TEST_F (StreamExecuteTest, AStreamWithTheJarOffReportsNoCookieWarning) {
    serve (1);
    cookie_jar_.store ("", loopback_jar_lines ("big", 3, 3000));
    origin_->set_cookies (numbered_set_cookies (51));

    const auto run_id = start (json{ { "disableCookies", true } });
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);
    EXPECT_FALSE (trace.contains ("warnings")) << trace["warnings"].dump (2);

    const auto control = start (json::object ());
    ASSERT_FALSE (control.empty ());
    const auto jar_on = trace_for (control);
    EXPECT_EQ (trace_warnings (jar_on, "cookie_not_sent").size (), 1U)
    << jar_on.dump (2);
    EXPECT_EQ (trace_warnings (jar_on, "cookie_dropped_too_many").size (), 1U)
    << jar_on.dump (2);
}

// ---------------------------------------------------------------------------
// `pm.sendRequest` on a stream (issue #653)
//
// Whether a script may send is a property of who asked for the execution, not
// of the shape the response comes back in - `allow_send_request` is read from
// the payload before the route branches on `stream`. Both transports are held
// to the rule in one test each, because the defect these replace was precisely
// the two disagreeing while each looked right on its own: the flag reached the
// engine from a buffered Send and not from a streaming one, so the same button
// allowed a `pm.sendRequest` with the toggle off and refused it with the toggle
// on.
// ---------------------------------------------------------------------------

TEST_F (StreamExecuteTest, AStreamsScriptMaySendWhenTheCallerAskedForIt) {
    serve (1);
    // What the callback saw, written onto the request that goes on the wire -
    // the origin's own record, so this cannot pass on a callback that never
    // ran. `pm.sendRequest` is blocking, so the header is set before the
    // transfer starts.
    const std::string script = "pm.sendRequest('" + origin_->url ("/aside") +
    "', function (err, res) { "
    "  var seen = err ? 'error' : String(res.json().ok); "
    "  pm.request.headers.add({ key: 'X-Aside', value: seen }); "
    "});";
    const json payload = { { "elements", script_elements (script) },
        { "allowScriptRequests", true } };

    const auto buffered = send_buffered (payload);
    EXPECT_FALSE (buffered.contains ("preScriptError")) << buffered.dump (2);
    EXPECT_EQ (origin_->aside_requests (), 1);
    EXPECT_EQ (origin_->received_header ("X-Aside"), "true");

    const auto run_id = start (payload);
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);
    EXPECT_FALSE (trace.contains ("scripts") && trace["scripts"].contains ("preScriptError"))
    << trace.dump (2);
    EXPECT_EQ (origin_->aside_requests (), 2)
    << "the streaming send's script never reached the network";
    EXPECT_EQ (origin_->received_header ("X-Aside"), "true");
}

TEST_F (StreamExecuteTest, AStreamsScriptIsRefusedWhenTheCallerDidNotAsk) {
    serve (1);
    const std::string script =
    "pm.sendRequest('" + origin_->url ("/aside") + "', function () {});";
    const json payload = { { "elements", script_elements (script) } };

    const auto buffered = send_buffered (payload);
    ASSERT_TRUE (buffered.contains ("preScriptError")) << buffered.dump (2);
    EXPECT_NE (buffered["preScriptError"].get<std::string> ().find (
               "pm.sendRequest is not available"),
    std::string::npos)
    << buffered["preScriptError"];

    const auto run_id = start (payload);
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    ASSERT_TRUE (trace["scripts"].contains ("preScriptError")) << trace.dump (2);
    // The same message, not merely a refusal: a stream that refused for its own
    // reason would be the divergence this test exists to forbid.
    EXPECT_EQ (trace["scripts"]["preScriptError"], buffered["preScriptError"]);
    EXPECT_EQ (origin_->aside_requests (), 0)
    << "a denied script still reached the network";
}

/// The timeout a script's aside call reported, per script, in the `scripts`
/// node @p scripts (the buffered answer, or a stream's stored trace node).
/// Fails the test for a script whose line is missing or not a timeout.
void expect_asides_timed_out_within (const json& scripts,
int64_t at_least_ms,
int64_t under_ms,
const std::string& transport) {
    for (const std::string_view source : { "pre", "test" }) {
        std::string line;
        for (const auto& entry : scripts.value ("consoleLogs", json::array ())) {
            if (entry.value ("source", "") == source) {
                line = entry.value ("message", "");
            }
        }
        const auto after_ms = vayu::tests::timed_out_after_ms (line);
        if (!after_ms) {
            ADD_FAILURE () << transport << " " << source << " script's aside did not time out: '"
                           << line << "' in " << scripts.dump (2);
            continue;
        }
        EXPECT_GE (*after_ms, at_least_ms) << transport << " " << source << ": " << line;
        EXPECT_LT (*after_ms, under_ms) << transport << " " << source << ": " << line;
    }
}

// #2833: a script's `pm.sendRequest` with no `timeout` option takes the send's
// resolved timeout, the payload's `timeout` here, from both scripts of both
// transports. Each transport sets it on its own contexts (the buffered one in
// `execute_exchange`, the stream in its pre and post lambdas), so one test
// holds all four. Healthy: about 500 ms each. Broken: the compiled-in 30 s,
// clamped to the script's 5 s default budget, about 4,990 ms - which is also
// what bounds a broken build, four scripts at 5 s inside the 60 s CTest limit.
// Mutation checks: drop the `request_timeout_ms` line from
// `execute_exchange`'s bind (buffered fails), from `pre_ctx` or from
// `post_ctx` in `run_streaming_execution` (that stream script fails).
TEST_F (StreamExecuteTest, AScriptsSendRequestTakesTheSendsTimeoutOnBothTransports) {
    serve (1);
    const std::string script = "pm.sendRequest('" + origin_->url ("/silent") +
    "', function (err, res) { "
    "  console.log(err ? err.code + ' ' + err.message : 'answered ' + "
    "res.code); "
    "});";
    const json payload = { { "elements", script_elements (script, script) },
        { "allowScriptRequests", true }, { "timeout", 500 } };

    expect_asides_timed_out_within (send_buffered (payload), 500, 2500, "buffered");

    const auto run_id = start (payload);
    ASSERT_FALSE (run_id.empty ());
    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    expect_asides_timed_out_within (trace["scripts"], 500, 2500, "stream");
}

// Absent, not empty. A stream that produced nothing has an empty list; a
// response that was never a stream has no list at all, and `typeof` is what
// tells them apart.
TEST_F (StreamExecuteTest, AnOrdinarySendHasNoEventsSurfaceAtAll) {
    serve (1);
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    const json payload = { { "method", "GET" },
        { "url", origin_->url ("/scripted") }, { "elements", script_elements ("", R"JS(
        pm.test('not a stream', function () {
            pm.expect(typeof pm.response.events).to.equal('undefined');
            pm.expect(typeof pm.response.totalEvents).to.equal('undefined');
            pm.expect(typeof pm.response.eventsTruncated).to.equal('undefined');
        });
    )JS") } };

    auto response = client.Post ("/execute", payload.dump (), "application/json");
    ASSERT_TRUE (response);
    ASSERT_EQ (response->status, 200) << response->body;
    const auto body = json::parse (response->body);
    ASSERT_TRUE (body.contains ("testResults")) << body.dump (2);
    EXPECT_TRUE (body["testResults"][0]["passed"].get<bool> ())
    << body["testResults"][0].value ("error", "");
}

// A stream with no scripts stores no `scripts` node - an empty one would put an
// always-empty Tests pane on every streamed response.
TEST_F (StreamExecuteTest, AStreamWithoutScriptsStoresNoScriptNode) {
    serve (2);
    const auto run_id = start (json::object ());
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_FALSE (trace.contains ("scripts")) << trace.dump (2);
    EXPECT_EQ (served_trace_for (run_id)["events"]["items"].size (), 2u);
}

// Malformed frames are the origin's problem, not the run's: the parser drops
// them and the stream still terminates by a rule that names itself, with the
// events that were well formed intact.
TEST_F (StreamExecuteTest, MalformedFramesAreDroppedAndTheRunStillCompletes) {
    origin_ = std::make_unique<StreamServer> (std::vector<std::string>{
    ": a comment line, dispatched to nobody\n\n", "event: no-data-so-never-dispatched\n\n",
    "data: kept\n\n", "retry: notanumber\ndata: also kept\n\n" });
    const auto run_id = start (json{ { "elements", script_elements ("", R"JS(
        pm.test('only the frames that carried data arrived', function () {
            pm.expect(pm.response.totalEvents).to.equal(2);
            pm.expect(pm.response.events[0].data).to.equal('kept');
            pm.expect(pm.response.events[1].data).to.equal('also kept');
        });
    )JS") } });
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
    EXPECT_EQ (trace["events"]["endReason"], "completed");
}

// ---------------------------------------------------------------------------
// The stored body of a stream (issue #3238)
//
// What the route stores, through the real handler: the design bound reaches
// the transfer from the config table, and the trace's `bodyBytes` survives
// the storage cap. The transfer's own rules are the `SseConsumer` cases above.
// ---------------------------------------------------------------------------

// A stream pointed at an endpoint that answered with an error document keeps
// that document, for the trace and for the post-request script. Mutation
// check: drop the `hold_body_bytes` call and the stored body is "" and the
// script's `json()` fails.
TEST_F (StreamExecuteTest, AJsonErrorReplyIsStoredAsTheBody) {
    origin_ = std::make_unique<StreamServer> ();
    origin_->can (404, "application/json", { R"({"error":"x"})" });
    const auto run_id = start (json{ { "elements", script_elements ("", R"JS(
        pm.test('the error document is readable', function () {
            pm.expect(pm.response.code).to.equal(404);
            pm.expect(pm.response.json().error).to.equal('x');
        });
    )JS") } },
    "/canned");
    ASSERT_FALSE (run_id.empty ());

    const auto trace = trace_for (run_id);
    EXPECT_EQ (trace["response"]["body"], R"({"error":"x"})") << trace.dump (2);
    EXPECT_EQ (trace["response"].value ("bodyBytes", size_t{ 0 }), size_t{ 13 });
    EXPECT_FALSE (trace["response"].contains ("bodyCapped"));
    EXPECT_EQ (trace["events"]["totalEvents"], 0);
    ASSERT_TRUE (trace.contains ("scripts")) << trace.dump (2);
    EXPECT_TRUE (trace["scripts"]["testResults"][0]["passed"].get<bool> ())
    << trace["scripts"]["testResults"][0].value ("error", "");
}

} // namespace
