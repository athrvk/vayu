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

#include <memory>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/metrics_collector.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/sse_parser.hpp"
#include "vayu/http/sse_stream.hpp"

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
    const std::string body = "event: chunk\ndata: one\ndata: two\n\n"
                             ": a comment is not an event\n\n"
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

    const auto live     = vayu::http::stream_trace_node (context);
    const auto buffered = vayu::http::buffered_stream_events_node (
    body, limits, context.total_events (), true);

    ASSERT_EQ (buffered["items"].size (), live["items"].size ());
    for (std::size_t i = 0; i < live["items"].size (); ++i) {
        auto live_item = live["items"][i];
        // The live node stamps arrival; nothing else may differ.
        live_item.erase ("receivedAt");
        EXPECT_EQ (buffered["items"][i], live_item) << "item " << i;
    }
    EXPECT_EQ (buffered["totalEvents"], live["totalEvents"]);
    EXPECT_EQ (buffered["eventsTruncated"], live["eventsTruncated"]);
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
        context->test_script = script;
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

    const auto validation = vayu::core::validate_scripts (context, *db_, false);
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

    const auto validation = vayu::core::validate_scripts (context, *db_, false);
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

    const auto validation = vayu::core::validate_scripts (context, *db_, false);
    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 0u);
    EXPECT_EQ (validation.run->passed, 1u);
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
