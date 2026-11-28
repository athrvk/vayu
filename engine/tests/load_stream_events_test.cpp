/**
 * @file tests/load_stream_events_test.cpp
 * @brief A streamed load sample's events (issue #657): parsed back from the
 *        buffered body, read by the deferred script replay, and served beside
 *        the stored capture.
 *
 * The asymmetry this closes: the design path records events as they arrive and
 * hands the post-request script `pm.response.events`, while a load run buffered
 * the same bytes and handed its deferred script `undefined`. The same script
 * therefore passed in one mode and silently asserted over nothing in the other -
 * the exact surprise the deferred-replay machinery exists to prevent.
 *
 * What the tests hold, and why each is here rather than implied:
 *
 * - **One definition of "an event".** The node built from buffered bytes and the
 *   node the live path stores are asserted against each other on the same
 *   stream, so a change to `SseParser` cannot make the two paths disagree.
 * - **Absent, not empty.** A sample that did not stream must leave
 *   `pm.response.events` `undefined`; an empty array would tell a script it read
 *   a stream that sent nothing.
 * - **Every cut is disclosed.** The stored-events cap and a truncated capture
 *   are different causes with one consequence - the list is a prefix - and
 *   `eventsTruncated` covers both.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "vayu/core/metrics_collector.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/sse_parser.hpp"
#include "vayu/http/sse_stream.hpp"
#include "wait_until.hpp"

namespace vayu::http::routes {
// Defined in runs.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> run_samples_response (vayu::db::Database& db,
const std::string& run_id,
int64_t limit,
int64_t offset);
} // namespace vayu::http::routes

namespace {

using nlohmann::json;

/// Three well-formed frames, one of them carrying an `id:` and a custom name.
constexpr const char* THREE_EVENTS = "event: start\ndata: {\"n\":1}\n\n"
                                     "id: 42\ndata: second\n\n"
                                     "data: third\n\n";

/// A body of @p count `data:`-only frames, which is what a load stream against
/// a token-emitting endpoint looks like.
std::string event_body (int count) {
    std::string body;
    for (int i = 0; i < count; ++i) {
        body += "data: token-" + std::to_string (i) + "\n\n";
    }
    return body;
}

vayu::Response streamed_response (std::string body, std::size_t events) {
    vayu::Response response;
    response.status_code             = 200;
    response.body                    = std::move (body);
    response.timing.total_ms         = 1.0;
    response.headers["Content-Type"] = "text/event-stream";
    response.stream_events           = events;
    return response;
}

// ---------------------------------------------------------------------------
// buffered_stream_events_node: the parse-back itself
// ---------------------------------------------------------------------------

TEST (BufferedStreamEvents, ParsesTheBufferedBodyIntoTheStoredItemShape) {
    const vayu::http::SseLimits limits;
    const auto node =
    vayu::http::buffered_stream_events_node (THREE_EVENTS, limits, 3, true);

    ASSERT_TRUE (node.contains ("items"));
    ASSERT_EQ (node["items"].size (), 3u);
    EXPECT_EQ (node["items"][0]["event"], "start");
    EXPECT_EQ (node["items"][0]["data"], "{\"n\":1}");
    EXPECT_FALSE (node["items"][0].contains ("sourceId"));
    EXPECT_EQ (node["items"][1]["sourceId"], "42");
    // The spec's default name, resolved by the parser rather than by each
    // consumer inventing one.
    EXPECT_EQ (node["items"][2]["event"], "message");
    EXPECT_EQ (node["totalEvents"], 3);
    EXPECT_FALSE (node["eventsTruncated"]);
    // Only a live consumer knows when an event arrived. A buffered parse says
    // nothing rather than stamping the moment the report was built.
    EXPECT_FALSE (node["items"][0].contains ("receivedAt"));
}

// The whole point of sharing `SseParser` between the two paths: what counts as
// an event, what its default name is and how multi-line data joins are decided
// once. Mutation-check: hand-roll a split-on-blank-line parser here and the
// multi-line frame alone reddens this.
TEST (BufferedStreamEvents, AgreesWithTheLivePathOnTheSameBytes) {
    const std::string body =
    "event: chunk\ndata: one\ndata: two\n\n"
    ": a comment is not an event\n\n"
    "data: {\"error\":{\"message\":\"overloaded\"}}\n\n"
    "data: last\n\n";

    vayu::http::SseLimits limits;
    vayu::http::SseStreamContext context ("run-live", limits);
    vayu::http::SseParser parser (limits.max_event_bytes);
    for (const auto& event : parser.feed (body)) {
        context.record_event (event);
    }
    for (const auto& event : parser.finish ()) {
        context.record_event (event);
    }

    // What the live path published: the ring's frames, each one event.
    std::vector<json> live;
    for (const auto& frame : context.events_since (0).payloads) {
        live.push_back (json::parse (frame.substr (frame.find ("data: ") + 6)));
    }
    const auto buffered = vayu::http::buffered_stream_events_node (
    body, limits, context.total_events (), true);

    ASSERT_EQ (buffered["items"].size (), live.size ());
    for (std::size_t i = 0; i < live.size (); ++i) {
        auto live_item = live[i];
        // The live node stamps arrival; nothing else may differ.
        live_item.erase ("receivedAt");
        EXPECT_EQ (buffered["items"][i], live_item) << "item " << i;
    }
    ASSERT_EQ (live.size (), 3u);
    EXPECT_TRUE (live[1].value ("isError", false)) << live[1].dump ();
    EXPECT_EQ (buffered["totalEvents"], context.total_events ());
    EXPECT_FALSE (buffered["eventsTruncated"]);
}

// A load sample's script sees the same mark a Send does (#3996), because it is
// derived from the buffered bytes. Mutation check: drop the `isError` write in
// `sse_event_node` and the error chunk carries none.
TEST (BufferedStreamEvents, MarksAnErrorChunkAsTheLivePathDoes) {
    const std::string body = "data: token\n\n"
                             "data: {\"error\":\"overloaded\"}\n\n"
                             "data: {\"error\":null}\n\n";
    const vayu::http::SseLimits limits;
    const auto node = vayu::http::buffered_stream_events_node (body, limits, 3, true);

    ASSERT_EQ (node["items"].size (), 3u);
    EXPECT_FALSE (node["items"][0].contains ("isError"));
    EXPECT_TRUE (node["items"][1].value ("isError", false)) << node["items"][1].dump ();
    EXPECT_FALSE (node["items"][2].contains ("isError")) << node["items"][2].dump ();
}

// The arrival times a live consumer kept are paired with the events in order
// and bound the list, which never runs past the events the wire counted
// (#3770). Mutation check: drop the `total_events` bound and the four-event
// body serves one item per arrival, three.
TEST (BufferedStreamEvents, PairsArrivalsInOrderAndStopsAtTheCountedTotal) {
    const vayu::http::SseLimits limits;
    const std::vector<int64_t> arrivals{ 10, 20, 30 };
    const auto node = vayu::http::buffered_stream_events_node (
    event_body (4), limits, 2, true, std::span<const int64_t> (arrivals));

    ASSERT_EQ (node["items"].size (), 2u);
    EXPECT_EQ (node["items"][0].value ("receivedAt", int64_t{ -1 }), 10);
    EXPECT_EQ (node["items"][1].value ("receivedAt", int64_t{ -1 }), 20);
    EXPECT_EQ (node["items"][1]["data"], "token-1");
    EXPECT_EQ (node["totalEvents"], 2);
    EXPECT_FALSE (node["eventsTruncated"]);
}

TEST (BufferedStreamEvents, StopsAtTheStoredEventsCapAndSaysSo) {
    vayu::http::SseLimits limits;
    limits.max_stored_events = 4;

    const auto node =
    vayu::http::buffered_stream_events_node (event_body (10), limits, 10, true);

    EXPECT_EQ (node["items"].size (), 4u);
    // The wire count, not the kept count: a reader must be able to tell a
    // 10-event stream showing 4 from a 4-event stream.
    EXPECT_EQ (node["totalEvents"], 10);
    EXPECT_TRUE (node["eventsTruncated"]);
    EXPECT_EQ (node["items"][0]["data"], "token-0");
    EXPECT_EQ (node["items"][3]["data"], "token-3");
}

// A capture cut by the per-body cap parses to fewer events than the wire
// counted, and the disclosure has to survive even when it does not: a cut that
// happens to land on a frame boundary would otherwise read as a whole stream.
TEST (BufferedStreamEvents, ATruncatedBodyIsAlwaysDisclosedAsAPrefix) {
    const vayu::http::SseLimits limits;
    const std::string whole = event_body (5);

    const auto cut = vayu::http::buffered_stream_events_node (
    whole.substr (0, whole.size () / 2), limits, 5, false);
    EXPECT_LT (cut["items"].size (), 5u);
    EXPECT_EQ (cut["totalEvents"], 5);
    EXPECT_TRUE (cut["eventsTruncated"]);

    // The counts agree here - the slice ends exactly on a boundary - and the
    // node must still say the list is a prefix.
    const auto boundary =
    vayu::http::buffered_stream_events_node (event_body (2), limits, 2, false);
    EXPECT_EQ (boundary["items"].size (), 2u);
    EXPECT_TRUE (boundary["eventsTruncated"])
    << "a truncated capture whose parse happens to be whole still shows a "
       "prefix";
}

TEST (BufferedStreamEvents, PerEventTruncationIsDisclosedInBand) {
    vayu::http::SseLimits limits;
    limits.max_event_bytes = 8;

    const auto node = vayu::http::buffered_stream_events_node (
    "data: this payload is far longer than eight bytes\n\n", limits, 1, true);

    ASSERT_EQ (node["items"].size (), 1u);
    EXPECT_TRUE (node["items"][0]["dataTruncated"]);
    EXPECT_GT (node["items"][0]["dataBytes"].get<std::size_t> (),
    node["items"][0]["data"].get<std::string> ().size ());
}

// A server that closed without the blank line terminating its last frame still
// sent that frame. `finish()` is what recovers it, and a load capture ends this
// way whenever the event cap stops the transfer mid-frame.
TEST (BufferedStreamEvents, RecoversAnUnterminatedFinalFrame) {
    const vayu::http::SseLimits limits;
    const auto node = vayu::http::buffered_stream_events_node (
    "data: first\n\ndata: unterminated", limits, 2, true);

    ASSERT_EQ (node["items"].size (), 2u);
    EXPECT_EQ (node["items"][1]["data"], "unterminated");
}

// ---------------------------------------------------------------------------
// The deferred replay: what a load run's script actually sees
// ---------------------------------------------------------------------------

class LoadReplayEventsTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_load_stream_events.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// Write a config value through the catalogue, as POST /config does.
    void set_config (const char* key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key;
        entry->value = value;
        db_->save_config_entry (*entry);
    }

    /// A run context whose reservoir keeps every sample offered to it, so a
    /// test decides what is replayed rather than a 1-in-100 die.
    static std::shared_ptr<vayu::core::RunContext> context_with (const std::string& script) {
        const json cfg = { { "response_sample_rate", 1 }, { "max_response_samples", 100 } };
        auto context = std::make_shared<vayu::core::RunContext> ("run-replay", cfg);
        context->test_scripts = { script };
        return context;
    }

    std::unique_ptr<vayu::db::Database> db_;
};

// The issue itself: a deferred script asserting on events. Mutation-check -
// drop the `response_events` wiring in `run_replay` and this fails, because the
// script's own guard turns an absent list into a failed test rather than a
// vacuous pass.
TEST_F (LoadReplayEventsTest, AStreamedSampleReplaysWithItsEvents) {
    auto context = context_with (R"(
        pm.test('events are readable', function () {
            if (typeof pm.response.events === 'undefined') {
                throw new Error('pm.response.events was undefined');
            }
            pm.expect(pm.response.events.length).to.equal(3);
            pm.expect(pm.response.events[0].event).to.equal('start');
            pm.expect(pm.response.events[1].id).to.equal('42');
            pm.expect(pm.response.totalEvents).to.equal(3);
            pm.expect(pm.response.eventsTruncated).to.equal(false);
        });
    )");
    context->metrics_collector->record_response_sample (
    streamed_response (THREE_EVENTS, 3));

    const auto validation = vayu::core::validate_scripts (context, *db_);
    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 0u);
    EXPECT_EQ (validation.run->passed, 1u);
}

// A sampled stream keeps the text path its request declared (#3773), so the
// deferred replay reads `streamText` as Send does. Mutation check: drop the
// `stream_text_path` copy in `sample_response` (run_manager.cpp) and the
// replayed test fails on an undefined `streamText`.
TEST_F (LoadReplayEventsTest, AStreamedSampleReplaysWithItsDeclaredText) {
    auto context              = context_with (R"(
        pm.test('the reply is assembled', function () {
            pm.expect(pm.response.streamText).to.equal('1');
            pm.expect(pm.response.events[0].text).to.equal('1');
            pm.expect(pm.response.events[1]).to.not.have.property('text');
        });
    )");
    auto response             = streamed_response (THREE_EVENTS, 3);
    response.stream_text_path = vayu::http::compile_stream_text_path ("$.n");
    ASSERT_NE (response.stream_text_path, nullptr);
    context->metrics_collector->record_response_sample (response);

    const auto validation = vayu::core::validate_scripts (context, *db_);
    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 0u);
    EXPECT_EQ (validation.run->passed, 1u);
}

// Absent, not empty. A load run over an ordinary endpoint must leave the field
// undefined - an empty array would tell a script it read a stream.
TEST_F (LoadReplayEventsTest, ANonStreamSampleLeavesTheFieldUndefined) {
    auto context = context_with (R"(
        pm.test('no events on a plain response', function () {
            pm.expect(typeof pm.response.events).to.equal('undefined');
        });
    )");
    vayu::Response plain;
    plain.status_code             = 200;
    plain.body                    = R"({"ok":true})";
    plain.timing.total_ms         = 1.0;
    plain.headers["Content-Type"] = "application/json";
    context->metrics_collector->record_response_sample (plain);

    const auto validation = vayu::core::validate_scripts (context, *db_);
    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->passed, 1u);
    EXPECT_EQ (validation.run->failed, 0u);
}

// The cap a replayed script reads is the run's own `sseMaxStoredEvents`, not the
// compiled-in seed - the same value the design path bounds its trace by.
TEST_F (LoadReplayEventsTest, TheStoredEventsSettingBoundsWhatAReplayedScriptSees) {
    set_config ("sseMaxStoredEvents", "2");

    auto context = context_with (R"(
        pm.test('bounded and disclosed', function () {
            pm.expect(pm.response.events.length).to.equal(2);
            pm.expect(pm.response.totalEvents).to.equal(6);
            pm.expect(pm.response.eventsTruncated).to.equal(true);
        });
    )");
    context->metrics_collector->record_response_sample (
    streamed_response (event_body (6), 6));

    const auto validation = vayu::core::validate_scripts (context, *db_);
    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 0u);
    EXPECT_EQ (validation.run->passed, 1u);
}

// ---------------------------------------------------------------------------
// An inline script on a single-request load run (#3769)
// ---------------------------------------------------------------------------

/// How long `/preamble` holds its content event after its preamble.
constexpr std::chrono::milliseconds PREAMBLE_CONTENT_DELAY{ 300 };

/// Serves `THREE_EVENTS` as one `text/event-stream` response and closes, and
/// at `/preamble` an Anthropic-style stream (#3774): a `message_start` at once
/// and its `content_block_delta` `PREAMBLE_CONTENT_DELAY` later.
class ThreeEventServer {
    public:
    ThreeEventServer () {
        svr_.new_task_queue = vayu::tests::pooled_task_queue (4);
        svr_.Get ("/preamble", [] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider (
            "text/event-stream", [] (size_t, httplib::DataSink& sink) {
                const std::string preamble =
                "event: message_start\ndata: {\"type\":\"message_start\"}\n\n";
                if (!sink.write (preamble.data (), preamble.size ())) {
                    return false;
                }
                std::this_thread::sleep_for (PREAMBLE_CONTENT_DELAY);
                const std::string content =
                "event: content_block_delta\ndata: "
                "{\"type\":\"content_block_delta\"}\n\n";
                if (!sink.write (content.data (), content.size ())) {
                    return false;
                }
                sink.done ();
                return true;
            });
        });
        svr_.Get ("/events", [] (const httplib::Request&, httplib::Response& res) {
            res.set_chunked_content_provider (
            "text/event-stream", [] (size_t, httplib::DataSink& sink) {
                const std::string body = THREE_EVENTS;
                if (!sink.write (body.data (), body.size ())) {
                    return false;
                }
                sink.done ();
                return true;
            });
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }
    ~ThreeEventServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    ThreeEventServer (const ThreeEventServer&)            = delete;
    ThreeEventServer& operator= (const ThreeEventServer&) = delete;
    ThreeEventServer (ThreeEventServer&&)                 = delete;
    ThreeEventServer& operator= (ThreeEventServer&&)      = delete;

    [[nodiscard]] std::string url (const std::string& path = "/events") const {
        return "http://127.0.0.1:" + std::to_string (port_) + path;
    }

    private:
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
};

class LoadInlineEventsTest : public LoadReplayEventsTest {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        LoadReplayEventsTest::SetUp ();
        server_ = std::make_unique<ThreeEventServer> ();
    }
    void TearDown () override {
        manager_.shutdown ();
        server_.reset ();
        LoadReplayEventsTest::TearDown ();
        vayu::http::global_cleanup ();
    }

    /// A streaming single-request run of @p iterations whose `script.post`
    /// runs inline through `elements.scripts: "allInline"` (the app's
    /// Scripts = All inline), run to its end; answers the element's tally.
    json run_inline_post_script (const std::string& script,
    size_t iterations,
    const json& extra = json::object ()) {
        json config{ { "method", "GET" }, { "url", server_->url () },
            { "mode", "iterations" }, { "iterations", iterations },
            { "concurrency", 1 }, { "timeout", 5000 }, { "stream", true },
            { "elements", { { "scripts", "allInline" } } },
            { "requestElements",
            json::array (
            { vayu::tests::script_element_json ("el_post", "script.post", script) }) } };
        config.update (extra);

        const auto summary = run_to_summary (config);
        for (const auto& entry : summary.value ("elements", json::array ())) {
            if (entry.value ("id", "") == "el_post") {
                return entry;
            }
        }
        ADD_FAILURE () << "no tally for el_post: " << summary.dump ();
        return json::object ();
    }

    /// A single-request run of @p config, run to its end; answers its stored
    /// summary.
    json run_to_summary (const json& config) {
        const std::string run_id = "run-inline-events";
        vayu::db::Run row;
        row.id              = run_id;
        row.type            = vayu::RunType::Load;
        row.status          = vayu::RunStatus::Pending;
        row.config_snapshot = config.dump ();
        // Now, not a fixed instant: the prune a finished run triggers deletes
        // a row that started before `runRetentionDays`.
        row.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        db_->create_run (row);
        EXPECT_TRUE (manager_.start_run (run_id, config, *db_));

        // `retain_run` is the worker's last act, after the summary is stored.
        EXPECT_TRUE (vayu::tests::wait_until ([&] {
            const auto stored = db_->get_run (run_id);
            return stored && stored->status != vayu::RunStatus::Pending &&
            stored->status != vayu::RunStatus::Running &&
            manager_.get_run (run_id) == nullptr;
        }))
        << "the run never finished";

        const auto stored = db_->get_run (run_id);
        if (!stored || stored->summary.empty ()) {
            ADD_FAILURE () << "the run stored no summary";
            return json::object ();
        }
        return json::parse (stored->summary);
    }

    vayu::core::RunManager manager_;
    std::unique_ptr<ThreeEventServer> server_;
};

// Mutation check: drop the `bind_buffered_stream_events` call in
// `run_request_elements_after_submission` and every submission's test fails
// on an undefined `pm.response.events`.
TEST_F (LoadInlineEventsTest, AnInlineScriptPostReadsTheStreamsEvents) {
    constexpr size_t ITERATIONS = 2;
    const auto tally            = run_inline_post_script (R"(
        pm.test('events are readable', function () {
            if (typeof pm.response.events === 'undefined') {
                throw new Error('pm.response.events was undefined');
            }
            pm.expect(pm.response.events.length).to.equal(3);
            pm.expect(pm.response.events[1].id).to.equal('42');
            pm.expect(pm.response.totalEvents).to.equal(3);
            pm.expect(pm.response.eventsTruncated).to.equal(false);
        });
    )",
    ITERATIONS);
    EXPECT_EQ (tally.value ("passed", 0u), ITERATIONS) << tally.dump ();
    EXPECT_EQ (tally.value ("failed", 0u), 0u) << tally.dump ();
}

// A single-request run's `streamTextPath` (#3773), which a by-id compose
// carries from the saved request, is read in its inline script, and a run
// without one reads no text. Mutation check: drop the `text_path` compile in
// `RunContext`'s constructor and the first run's test fails on an undefined
// `streamText`.
TEST_F (LoadInlineEventsTest, AnInlineScriptPostReadsTheRunsTextPath) {
    const auto with_path = run_inline_post_script (R"(
        pm.test('the reply is assembled', function () {
            pm.expect(pm.response.streamText).to.equal('1');
            pm.expect(pm.response.events[0].text).to.equal('1');
        });
    )",
    1, json{ { "streamTextPath", "$.n" } });
    EXPECT_EQ (with_path.value ("passed", 0u), 1u) << with_path.dump ();
    EXPECT_EQ (with_path.value ("failed", 0u), 0u) << with_path.dump ();
}

TEST_F (LoadInlineEventsTest, AnInlineScriptPostOfARunWithNoTextPathReadsNoText) {
    const auto without = run_inline_post_script (R"(
        pm.test('no path, no text', function () {
            pm.expect(typeof pm.response.streamText).to.equal('undefined');
            pm.expect(pm.response.events[0]).to.not.have.property('text');
        });
    )",
    1);
    EXPECT_EQ (without.value ("passed", 0u), 1u) << without.dump ();
    EXPECT_EQ (without.value ("failed", 0u), 0u) << without.dump ();
}

// A single-request run's `streamFirstContentMarker` (#3774), which a by-id
// compose carries from the saved request, is watched for on every transfer.
// `/preamble` holds its content PREAMBLE_CONTENT_DELAY (300 ms) behind its
// first event, so the match reads at least that; a lower bound only, which a
// slow runner cannot fail. Mutation check: drop the marker compile in
// `single_request_stream_bounds` and `timeToFirstMatch` is absent.
TEST_F (LoadInlineEventsTest, ASingleRequestRunTimesItsFirstContentMarker) {
    constexpr size_t ITERATIONS = 2;
    const json config{ { "method", "GET" }, { "url", server_->url ("/preamble") },
        { "mode", "iterations" }, { "iterations", ITERATIONS },
        { "concurrency", 1 }, { "timeout", 5000 }, { "stream", true },
        { "streamFirstContentMarker", "content_block_delta" } };

    const auto summary = run_to_summary (config);

    ASSERT_TRUE (summary.contains ("stream")) << summary.dump ();
    const auto& stream = summary["stream"];
    ASSERT_TRUE (stream.contains ("timeToFirstEvent")) << stream.dump ();
    ASSERT_TRUE (stream.contains ("timeToFirstMatch")) << stream.dump ();
    const auto& first_match = stream["timeToFirstMatch"];
    EXPECT_EQ (first_match.value ("count", size_t{ 0 }), ITERATIONS) << stream.dump ();
    EXPECT_GE (first_match.value ("p50", 0.0),
    static_cast<double> (PREAMBLE_CONTENT_DELAY.count ()))
    << stream.dump ();
}

// The run's own `sseMaxStoredEvents` bounds what the inline script reads, as
// it bounds the replay's. Mutation check: drop the `sse_limits` copy in
// `RunContext`'s constructor and the script reads all three events.
TEST_F (LoadInlineEventsTest, TheStoredEventsSettingBoundsWhatAnInlineScriptSees) {
    set_config ("sseMaxStoredEvents", "2");
    const auto tally = run_inline_post_script (R"(
        pm.test('bounded and disclosed', function () {
            pm.expect(pm.response.events.length).to.equal(2);
            pm.expect(pm.response.totalEvents).to.equal(3);
            pm.expect(pm.response.eventsTruncated).to.equal(true);
        });
    )",
    1);
    EXPECT_EQ (tally.value ("passed", 0u), 1u) << tally.dump ();
    EXPECT_EQ (tally.value ("failed", 0u), 0u) << tally.dump ();
}

// ---------------------------------------------------------------------------
// GET /runs/:id/samples: the stored capture a viewer renders
// ---------------------------------------------------------------------------

class StreamedSampleRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_streamed_sample_route.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        vayu::db::Run run;
        run.id              = "run-1";
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Completed;
        run.config_snapshot = R"({"url":"https://x.test/","method":"GET"})";
        run.start_time      = 100;
        run.end_time        = 200;
        db_->create_run (run);
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// A collector that captures every error's exchange, which is the cheapest
    /// way to put a chosen response into `result_bodies`.
    static vayu::core::MetricsCollectorConfig capture_config () {
        vayu::core::MetricsCollectorConfig config;
        config.expected_requests       = 100;
        config.capture_response_bodies = true;
        return config;
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (StreamedSampleRouteTest, AStreamedCaptureCarriesItsParsedEvents) {
    vayu::core::MetricsCollector collector ("run-1", capture_config ());
    auto response          = streamed_response (THREE_EVENTS, 3);
    response.error_code    = vayu::ErrorCode::ConnectionFailed;
    response.error_message = "closed early";
    collector.record_error (
    vayu::ErrorCode::ConnectionFailed, "closed early", "{}", &response);
    collector.flush_to_database (*db_);

    const auto [status, body] =
    vayu::http::routes::run_samples_response (*db_, "run-1", 50, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);

    const auto& events = body["data"][0]["response"]["events"];
    ASSERT_TRUE (events.is_object ()) << body.dump ();
    ASSERT_EQ (events["items"].size (), 3u);
    EXPECT_EQ (events["items"][0]["event"], "start");
    EXPECT_EQ (events["totalEvents"], 3);
    EXPECT_FALSE (events["eventsTruncated"]);
    // The raw bytes stay beside the parsed list - the Body view is still the
    // honest record of what came back.
    EXPECT_EQ (body["data"][0]["response"]["body"], THREE_EVENTS);
}

// A capture keeps its request's `streamTextPath` (#3773) in its row, so the
// served list carries each event's `text` and the joined `streamText`, and a
// capture without one carries neither. Mutation check: drop the
// `stream_text_path` copy in `flush_to_database`'s `collect_capture` and the
// first sample carries no `streamText`.
TEST_F (StreamedSampleRouteTest, AStreamedCaptureReadsItsDeclaredText) {
    vayu::core::MetricsCollector collector ("run-1", capture_config ());
    auto with_path             = streamed_response (THREE_EVENTS, 3);
    with_path.stream_text_path = vayu::http::compile_stream_text_path ("$.n");
    auto without               = streamed_response (THREE_EVENTS, 3);
    for (auto* response : { &with_path, &without }) {
        collector.record_error (
        vayu::ErrorCode::ConnectionFailed, "closed early", "{}", response);
    }
    collector.flush_to_database (*db_);

    const auto [status, body] =
    vayu::http::routes::run_samples_response (*db_, "run-1", 50, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 2u);
    std::vector<json> texts;
    for (const auto& sample : body["data"]) {
        const auto& events = sample["response"]["events"];
        texts.push_back (events.value ("streamText", json ()));
    }
    // Rows come back in insert order, which is record order here.
    EXPECT_EQ (texts[0], "1") << body.dump ();
    EXPECT_TRUE (texts[1].is_null ()) << body.dump ();
    EXPECT_EQ (
    body["data"][0]["response"]["events"]["items"][0].value ("text", json ()), "1");
}

// Absent, not empty, on this side too: a row with no wire count - every row
// written before the column existed, and every non-stream capture - carries no
// `events` key at all.
TEST_F (StreamedSampleRouteTest, ANonStreamCaptureCarriesNoEventsNode) {
    vayu::core::MetricsCollector collector ("run-1", capture_config ());
    vayu::Response response;
    response.status_code             = 500;
    response.body                    = R"({"error":"boom"})";
    response.headers["Content-Type"] = "application/json";
    collector.record_error (vayu::ErrorCode::InternalError, "boom", "{}", &response);
    collector.flush_to_database (*db_);

    const auto [status, body] =
    vayu::http::routes::run_samples_response (*db_, "run-1", 50, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    EXPECT_FALSE (body["data"][0]["response"].contains ("events"));
}

// A capture the run's byte budget truncated is a prefix of the stream, and the
// served node has to say so even though the stored bytes parse cleanly.
TEST_F (StreamedSampleRouteTest, ATruncatedStreamedCaptureIsServedAsAPrefix) {
    auto config                  = capture_config ();
    config.max_sample_body_bytes = 20;
    vayu::core::MetricsCollector collector ("run-1", config);
    auto response = streamed_response (event_body (5), 5);
    collector.record_error (vayu::ErrorCode::ConnectionFailed, "cut", "{}", &response);
    collector.flush_to_database (*db_);

    const auto [status, body] =
    vayu::http::routes::run_samples_response (*db_, "run-1", 50, 0);
    ASSERT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 1u);
    const auto& sample = body["data"][0]["response"];
    ASSERT_TRUE (sample["bodyTruncated"].get<bool> ());
    ASSERT_TRUE (sample["events"].is_object ());
    EXPECT_EQ (sample["events"]["totalEvents"], 5);
    EXPECT_TRUE (sample["events"]["eventsTruncated"]);
    EXPECT_LT (sample["events"]["items"].size (), 5u);
}

} // namespace
