/**
 * @file tests/inbox_test.cpp
 * @brief Tests for the webhook inbox (issue #480): payload validation, a live
 *        listener capturing real requests, the canned response, the capture
 *        ring bound, the list core's envelope, and teardown while running.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <memory>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/inbox.hpp"

using nlohmann::json;
using vayu::http::InboxCannedResponse;
using vayu::http::InboxManager;
using vayu::http::InboxStartRequest;

namespace vayu::http::routes {
// Defined in inbox.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> inbox_captures_response (vayu::db::Database& db,
InboxManager& manager,
const std::string& inbox_id,
int64_t limit,
int64_t offset);
// Defined in inbox.cpp; the wire shape every inbox route answers with.
nlohmann::json inbox_json (vayu::db::Database& db, vayu::http::InboxInfo info);
} // namespace vayu::http::routes

namespace {

namespace inbox_constants = vayu::core::constants::inbox;

// ---------------------------------------------------------------------------
// Payload validation - no listener, no database
// ---------------------------------------------------------------------------

TEST (InboxParseStart, EmptyBodyStartsALoopbackInboxAnswering200) {
    const auto parsed = vayu::http::parse_inbox_start (json (nullptr));
    ASSERT_TRUE (parsed.has_value ());
    EXPECT_EQ (parsed->bind, "127.0.0.1");
    EXPECT_EQ (parsed->port, 0);
    EXPECT_EQ (parsed->response.status, 200);
    EXPECT_EQ (parsed->response.delay_ms, 0);
    EXPECT_TRUE (parsed->response.body.empty ());
}

TEST (InboxParseStart, ReadsEveryResponseField) {
    const json body   = { { "port", 0 }, { "bind", "127.0.0.1" },
          { "response",
          { { "status", 503 }, { "body", "retry later" }, { "delayMs", 25 },
          { "headers", { { "Retry-After", "1" } } } } } };
    const auto parsed = vayu::http::parse_inbox_start (body);
    ASSERT_TRUE (parsed.has_value ());
    EXPECT_EQ (parsed->response.status, 503);
    EXPECT_EQ (parsed->response.body, "retry later");
    EXPECT_EQ (parsed->response.delay_ms, 25);
    ASSERT_EQ (parsed->response.headers.count ("Retry-After"), 1U);
    EXPECT_EQ (parsed->response.headers.at ("Retry-After"), "1");
}

TEST (InboxParseStart, RejectsRatherThanDefaultsAnUnusableValue) {
    // A status outside the HTTP range, a negative delay, a delay past the
    // bound, a non-object headers map and a port outside the range are each a
    // 400: silently answering 200 instead is a listener doing something other
    // than what its caller asked for.
    EXPECT_FALSE (
    vayu::http::parse_inbox_start (json{ { "response", { { "status", 900 } } } })
    .has_value ());
    EXPECT_FALSE (
    vayu::http::parse_inbox_start (json{ { "response", { { "delayMs", -1 } } } })
    .has_value ());
    EXPECT_FALSE (vayu::http::parse_inbox_start (
    json{ { "response", { { "delayMs", inbox_constants::MAX_RESPONSE_DELAY_MS + 1 } } } })
    .has_value ());
    EXPECT_FALSE (
    vayu::http::parse_inbox_start (json{ { "response", { { "headers", "nope" } } } })
    .has_value ());
    EXPECT_FALSE (vayu::http::parse_inbox_start (json{ { "port", 70000 } }).has_value ());
    EXPECT_FALSE (vayu::http::parse_inbox_start (json{ { "bind", "" } }).has_value ());
    EXPECT_FALSE (vayu::http::parse_inbox_start (json ("not an object")).has_value ());
}

TEST (InboxParseStart, NonLoopbackBindNeedsExplicitConfirmation) {
    const auto refused = vayu::http::parse_inbox_start (json{ { "bind", "0.0.0.0" } });
    ASSERT_FALSE (refused.has_value ());
    EXPECT_EQ (refused.error ().http_status, 400);
    EXPECT_EQ (refused.error ().code, "inbox_non_loopback_bind");

    const auto accepted = vayu::http::parse_inbox_start (
    json{ { "bind", "0.0.0.0" }, { "confirmNonLoopback", true } });
    ASSERT_TRUE (accepted.has_value ());
    EXPECT_EQ (accepted->bind, "0.0.0.0");

    // Loopback in any of its spellings needs no confirmation.
    EXPECT_TRUE (vayu::http::is_loopback_bind ("127.0.0.1"));
    EXPECT_TRUE (vayu::http::is_loopback_bind ("127.1.2.3"));
    EXPECT_TRUE (vayu::http::is_loopback_bind ("::1"));
    EXPECT_TRUE (vayu::http::is_loopback_bind ("localhost"));
    EXPECT_FALSE (vayu::http::is_loopback_bind ("0.0.0.0"));
    EXPECT_FALSE (vayu::http::is_loopback_bind ("192.168.1.4"));
}

// A hostname is not an address, however it starts (issue #504). Classifying
// `127.example.com` by its prefix bound it wherever DNS pointed while the
// response - and the UI badge reading it - said `loopback: true`.
//
// Mutation check: restore `bind.rfind ("127.", 0) == 0` and both halves fail.
TEST (InboxParseStart, ALoopbackLookingHostnameIsNotLoopback) {
    for (const char* host : { "127.example.com", "127.0.0.1.evil.test", "127.", "127",
         "127.0.0", "127.0.0.1.2", "127.0.0.256", "1270.0.0.1", "notlocalhost" }) {
        EXPECT_FALSE (vayu::http::is_loopback_bind (host))
        << host << " was classified as loopback";
    }
    // The gate follows the classification: a non-loopback bind is refused
    // without confirmation and accepted with it.
    const auto refused =
    vayu::http::parse_inbox_start (json{ { "bind", "127.example.com" } });
    ASSERT_FALSE (refused.has_value ())
    << "a hostname starting 127. was bound without confirmation";
    EXPECT_EQ (refused.error ().code, "inbox_non_loopback_bind");

    const auto accepted = vayu::http::parse_inbox_start (
    json{ { "bind", "127.example.com" }, { "confirmNonLoopback", true } });
    ASSERT_TRUE (accepted.has_value ());
    EXPECT_EQ (accepted->bind, "127.example.com");

    // The whole of 127.0.0.0/8 still needs no confirmation.
    EXPECT_TRUE (vayu::http::is_loopback_bind ("127.255.255.254"));
    EXPECT_TRUE (vayu::http::is_loopback_bind ("127.000.000.001"));
}

TEST (InboxParseUpdate, AbsentFieldKeepsTheLiveValue) {
    InboxCannedResponse current;
    current.status   = 500;
    current.body     = "boom";
    current.delay_ms = 10;
    current.headers  = { { "X-Trace", "abc" } };

    const auto status_only =
    vayu::http::parse_inbox_response_update (json{ { "status", 200 } }, current);
    ASSERT_TRUE (status_only.has_value ());
    EXPECT_EQ (status_only->status, 200);
    // The point of the merge: changing the status must not drop the rest.
    EXPECT_EQ (status_only->body, "boom");
    EXPECT_EQ (status_only->delay_ms, 10);
    ASSERT_EQ (status_only->headers.count ("X-Trace"), 1U);

    // The start route's own shape is accepted too, so a client can send back
    // what it was handed.
    const auto wrapped = vayu::http::parse_inbox_response_update (
    json{ { "response", { { "body", "ok" } } } }, current);
    ASSERT_TRUE (wrapped.has_value ());
    EXPECT_EQ (wrapped->body, "ok");
    EXPECT_EQ (wrapped->status, 500);

    EXPECT_FALSE (
    vayu::http::parse_inbox_response_update (json{ { "status", 12 } }, current).has_value ());
}

// ---------------------------------------------------------------------------
// Where a live stream resumes from
// ---------------------------------------------------------------------------

TEST (InboxLiveResumePoint, AbsentMeansFromTheStartAndTheHeaderWinsOverTheParam) {
    const auto absent = vayu::http::parse_live_resume_point ("", "");
    ASSERT_TRUE (absent.has_value ());
    EXPECT_EQ (*absent, 0);

    // The query parameter is the app's own reconnect - EventSource cannot set a
    // header on a fresh connection - and is read exactly like the header.
    const auto from_param = vayu::http::parse_live_resume_point ("", "42");
    ASSERT_TRUE (from_param.has_value ());
    EXPECT_EQ (*from_param, 42);

    // The browser's reconnect header is the more recent of the two.
    const auto from_header = vayu::http::parse_live_resume_point ("77", "42");
    ASSERT_TRUE (from_header.has_value ());
    EXPECT_EQ (*from_header, 77);
}

TEST (InboxLiveResumePoint, RejectsAValueThatIsNotACaptureId) {
    for (const char* bad : { "abc", "12x", "", "-1", " 7", "1.5" }) {
        const std::string value = bad;
        // Empty is absence, not a bad value - it is in this list to pin that.
        const auto resume_point = vayu::http::parse_live_resume_point ("", value);
        if (value.empty ()) {
            ASSERT_TRUE (resume_point.has_value ());
            EXPECT_EQ (*resume_point, 0);
            continue;
        }
        // Silently resuming from 0 would replay every retained capture as
        // though it had just arrived, which is what the loud failure prevents -
        // and there is no resume point to read at all unless the value parsed.
        ASSERT_FALSE (resume_point.has_value ()) << bad;
        EXPECT_EQ (resume_point.error ().http_status, 400) << bad;
        EXPECT_EQ (resume_point.error ().code, "invalid_last_event_id") << bad;
    }
}

// ---------------------------------------------------------------------------
// A live listener
// ---------------------------------------------------------------------------

class InboxListenerTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_inbox.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        manager_ = std::make_unique<InboxManager> ();
    }
    void TearDown () override {
        manager_.reset ();
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    InboxManager::StartResult start (InboxStartRequest request = {}) {
        auto result = manager_->start (*db_, request);
        EXPECT_TRUE (result.ok) << result.error_message;
        return result;
    }

    static httplib::Client client_for (const vayu::http::InboxInfo& info) {
        return httplib::Client ("127.0.0.1", info.port);
    }

    /// Edit a seeded config row the way a user would through POST /config.
    void set_config (const char* key, int64_t value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key;
        entry->value = std::to_string (value);
        db_->save_config_entry (*entry);
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::unique_ptr<InboxManager> manager_;
};

TEST_F (InboxListenerTest, RecordsWhatArrivedOnAnyMethodAndPath) {
    auto started = start ();
    auto client  = client_for (started.info);

    httplib::Headers headers = { { "X-Signature", "sha256=abc" } };
    auto posted =
    client.Post ("/hooks/order?attempt=2", headers, "{\"id\":7}", "application/json");
    ASSERT_TRUE (posted) << "POST to the inbox failed";
    EXPECT_EQ (posted->status, 200);

    auto captures = db_->get_inbox_requests_paginated (started.info.inbox_id, 10, 0);
    ASSERT_EQ (captures.size (), 1u);
    const auto& capture = captures.front ();
    EXPECT_EQ (capture.method, "POST");
    EXPECT_EQ (capture.path, "/hooks/order");
    EXPECT_EQ (capture.query, "attempt=2");
    EXPECT_EQ (capture.body, "{\"id\":7}");
    EXPECT_EQ (capture.body_bytes, 8);
    EXPECT_FALSE (capture.body_truncated);
    EXPECT_FALSE (capture.remote_addr.empty ());
    const auto stored_headers = json::parse (capture.headers);
    EXPECT_EQ (stored_headers.value ("X-Signature", ""), "sha256=abc");

    // A method with no body is captured just as a POST is - an inbox records
    // every verb, not only the one webhooks usually use.
    ASSERT_TRUE (client.Delete ("/hooks/order"));
    EXPECT_EQ (db_->count_inbox_requests (started.info.inbox_id), 2);
    auto newest = db_->get_inbox_requests_paginated (started.info.inbox_id, 1, 0);
    ASSERT_EQ (newest.size (), 1u);
    EXPECT_EQ (newest.front ().method, "DELETE");
}

TEST_F (InboxListenerTest, ServesTheCannedResponseIncludingItsDelay) {
    InboxStartRequest request;
    request.response.status   = 500;
    request.response.body     = "try again";
    request.response.delay_ms = 120;
    request.response.headers  = { { "Retry-After", "3" },
         { "Content-Type", "text/plain; charset=utf-8" } };
    auto started              = start (request);
    auto client               = client_for (started.info);

    const auto sent_at = std::chrono::steady_clock::now ();
    auto response      = client.Post ("/hook", "{}", "application/json");
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - sent_at)
                         .count ();

    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 500);
    EXPECT_EQ (response->body, "try again");
    EXPECT_EQ (response->get_header_value ("Retry-After"), "3");
    EXPECT_EQ (response->get_header_value ("Content-Type"), "text/plain; charset=utf-8");
    // The delay is what makes retry logic testable, so it is asserted as a
    // lower bound rather than trusted.
    EXPECT_GE (elapsed, 120);
}

TEST_F (InboxListenerTest, UpdatingTheCannedResponseTakesEffectOnTheNextCall) {
    auto started = start ();
    auto client  = client_for (started.info);
    ASSERT_TRUE (client.Post ("/hook", "", "text/plain"));

    InboxCannedResponse updated;
    updated.status = 202;
    updated.body   = "queued";
    ASSERT_TRUE (manager_->update_response (started.info.inbox_id, updated).has_value ());

    auto response = client.Post ("/hook", "", "text/plain");
    ASSERT_TRUE (response);
    EXPECT_EQ (response->status, 202);
    EXPECT_EQ (response->body, "queued");
    // A live update never costs the history.
    EXPECT_EQ (db_->count_inbox_requests (started.info.inbox_id), 2);
}

TEST_F (InboxListenerTest, ABodyPastTheCapIsStoredTruncatedAndSaysSo) {
    auto started = start ();
    auto client  = client_for (started.info);

    const size_t oversized = static_cast<size_t> (inbox_constants::MAX_BODY_BYTES) + 512;
    const std::string body (oversized, 'x');
    ASSERT_TRUE (client.Post ("/hook", body, "text/plain"));

    auto captures = db_->get_inbox_requests_paginated (started.info.inbox_id, 1, 0);
    ASSERT_EQ (captures.size (), 1u);
    EXPECT_EQ (static_cast<int64_t> (captures.front ().body.size ()),
    inbox_constants::MAX_BODY_BYTES);
    EXPECT_EQ (captures.front ().body_bytes, static_cast<int64_t> (oversized));
    EXPECT_TRUE (captures.front ().body_truncated);
}

TEST_F (InboxListenerTest, StopFreesTheListenerAndKeepsTheHistory) {
    auto started = start ();
    {
        auto client = client_for (started.info);
        ASSERT_TRUE (client.Post ("/hook", "{}", "application/json"));
    }

    ASSERT_TRUE (manager_->stop (started.info.inbox_id));
    EXPECT_FALSE (manager_->stop ("inbox_nope"));

    auto after = manager_->get (started.info.inbox_id);
    ASSERT_HAS_VALUE (after);
    EXPECT_FALSE (after->running);
    // Stopping is not deleting: the captures are still listable.
    EXPECT_EQ (db_->count_inbox_requests (started.info.inbox_id), 1);

    httplib::Client client ("127.0.0.1", started.info.port);
    client.set_connection_timeout (0, 300000); // 300ms
    EXPECT_FALSE (client.Post ("/hook", "{}", "application/json"))
    << "a stopped inbox must refuse further connections";
}

/*
 * Delete is what stop deliberately is not. Before it existed, a stopped inbox
 * was a row nothing could remove until the engine exited (issue #553).
 */
TEST_F (InboxListenerTest, DeleteFreesTheListenerAndTakesTheCapturesWithIt) {
    auto started = start ();
    {
        auto client = client_for (started.info);
        ASSERT_TRUE (client.Post ("/hook", "{}", "application/json"));
        ASSERT_TRUE (client.Post ("/hook", "{}", "application/json"));
    }
    ASSERT_EQ (db_->count_inbox_requests (started.info.inbox_id), 2);

    // A running inbox is stopped rather than refused: one call, because the
    // caller's intent is "make it gone".
    const auto deleted = manager_->remove (*db_, started.info.inbox_id);
    ASSERT_HAS_VALUE (deleted);
    EXPECT_EQ (*deleted, 2);

    EXPECT_FALSE (manager_->get (started.info.inbox_id).has_value ());
    EXPECT_TRUE (manager_->list ().empty ());
    // The cascade: dropping it leaves rows no inbox can ever list again.
    EXPECT_EQ (db_->count_inbox_requests (started.info.inbox_id), 0);

    httplib::Client client ("127.0.0.1", started.info.port);
    client.set_connection_timeout (0, 300000); // 300ms
    EXPECT_FALSE (client.Post ("/hook", "{}", "application/json"))
    << "a deleted inbox must refuse further connections";

    // Gone means gone: a second delete is a 404, not a second success.
    EXPECT_FALSE (manager_->remove (*db_, started.info.inbox_id).has_value ());
    EXPECT_FALSE (manager_->remove (*db_, "inbox_nope").has_value ());
}

TEST_F (InboxListenerTest, DeleteTakesOnlyItsOwnInboxsCaptures) {
    auto kept   = start ();
    auto doomed = start ();
    auto keeper = client_for (kept.info);
    auto sender = client_for (doomed.info);
    ASSERT_TRUE (keeper.Post ("/hook", "{}", "application/json"));
    ASSERT_TRUE (sender.Post ("/hook", "{}", "application/json"));

    ASSERT_EQ (manager_->remove (*db_, doomed.info.inbox_id).value_or (-1), 1);

    EXPECT_EQ (db_->count_inbox_requests (kept.info.inbox_id), 1)
    << "an unrelated inbox lost its captures";
    EXPECT_TRUE (manager_->get (kept.info.inbox_id).has_value ());
}

/*
 * A live stream holds the deleted inbox's claim slot. It notices at its next
 * poll, and what it must not do on the way out is release a slot that has
 * since been handed to somebody else - the same rule an evicted holder follows.
 */
TEST_F (InboxListenerTest, DeleteLeavesAnAttachedLiveStreamNothingToStrand) {
    auto started     = start ();
    const auto claim = manager_->try_claim_live (started.info.inbox_id);
    ASSERT_HAS_VALUE (claim);

    ASSERT_TRUE (manager_->remove (*db_, started.info.inbox_id).has_value ());

    // What the stream's own loop checks: the inbox is gone, so it breaks out.
    EXPECT_FALSE (manager_->get (started.info.inbox_id).has_value ());
    EXPECT_FALSE (manager_->note_live_write (started.info.inbox_id, *claim));
    // And the release on the way out finds nothing to release, rather than
    // reaching into a record that no longer exists.
    manager_->release_live (started.info.inbox_id, *claim);
    SUCCEED ();
}

TEST_F (InboxListenerTest, ASecondInboxCannotShareARunningInboxsPort) {
    // Without the listener's port guard this second start succeeds on Linux -
    // cpp-httplib binds with SO_REUSEPORT - and the kernel then splits the
    // webhooks between the two inboxes, each list silently missing half (#512).
    auto first = start ();

    InboxStartRequest contender;
    contender.port     = first.info.port;
    const auto refused = manager_->start (*db_, contender);
    EXPECT_FALSE (refused.ok);
    EXPECT_EQ (refused.http_status, 409);
    EXPECT_EQ (refused.error_code, "inbox_bind_failed");
    EXPECT_NE (refused.error_message.find (first.info.inbox_id), std::string::npos)
    << "the refusal must name the holder: " << refused.error_message;
    EXPECT_EQ (manager_->list ().size (), 1u)
    << "a refused start left a record";

    // Nothing was split away: every request sent to that port is in the one
    // inbox that owns it.
    auto client = client_for (first.info);
    for (int i = 0; i < 8; ++i) {
        ASSERT_TRUE (client.Post ("/hook", "{}", "application/json")) << i;
    }
    EXPECT_EQ (db_->count_inbox_requests (first.info.inbox_id), 8);

    // The claim lasts exactly as long as the listener: once it stops, the same
    // explicit port starts a new inbox.
    ASSERT_TRUE (manager_->stop (first.info.inbox_id));
    const auto reused = manager_->start (*db_, contender);
    EXPECT_TRUE (reused.ok) << reused.error_message;
    EXPECT_EQ (reused.info.port, first.info.port);
}

TEST_F (InboxListenerTest, TearsDownCleanlyWithAListenerStillRunning) {
    auto started = start ();
    auto client  = client_for (started.info);
    ASSERT_TRUE (client.Post ("/hook", "{}", "application/json"));
    // The destructor stops and joins the listener; the test hangs or crashes if
    // it does not (the same shape as run_shutdown_test).
    manager_.reset ();
    SUCCEED ();
}

TEST_F (InboxListenerTest, OneLiveStreamPerInbox) {
    auto started     = start ();
    const auto claim = manager_->try_claim_live (started.info.inbox_id);
    ASSERT_HAS_VALUE (claim);
    EXPECT_FALSE (manager_->try_claim_live (started.info.inbox_id).has_value ())
    << "a second watcher would park a second pool thread on the same inbox";
    manager_->release_live (started.info.inbox_id, *claim);
    const auto second = manager_->try_claim_live (started.info.inbox_id);
    ASSERT_HAS_VALUE (second);
    EXPECT_NE (*second, *claim)
    << "a reused token would let a stale holder act on it";
    EXPECT_FALSE (manager_->try_claim_live ("inbox_nope").has_value ());
}

// A stream that keeps writing is live, whatever the wall clock says - the whole
// point of the takeover window is that it never evicts one of these.
TEST_F (InboxListenerTest, AWritingStreamKeepsItsClaimPastTheStaleWindow) {
    // The default cadence, so the window under test (two intervals, 500ms) is
    // an order of magnitude above the loop's own sleep - a scheduling hiccup
    // must not read as a dead holder here or the test is flaky by design.
    auto started     = start ();
    const auto claim = manager_->try_claim_live (started.info.inbox_id);
    ASSERT_HAS_VALUE (claim);

    const auto deadline = std::chrono::steady_clock::now () +
    std::chrono::milliseconds (inbox_constants::LIVE_POLL_INTERVAL_MS * 4);
    while (std::chrono::steady_clock::now () < deadline) {
        ASSERT_TRUE (manager_->note_live_write (started.info.inbox_id, *claim));
        EXPECT_FALSE (manager_->try_claim_live (started.info.inbox_id).has_value ())
        << "a stream that is still writing was evicted";
        std::this_thread::sleep_for (std::chrono::milliseconds (50));
    }
    EXPECT_TRUE (manager_->note_live_write (started.info.inbox_id, *claim));
}

// The #506 race: the browser reconnects before the previous stream's poll loop
// has noticed its socket died, and the refusal is what strands it for good.
TEST_F (InboxListenerTest, AReconnectTakesOverAClaimThatStoppedWriting) {
    set_config ("inboxLivePollIntervalMs", inbox_constants::MIN_LIVE_POLL_INTERVAL_MS);
    auto started    = start ();
    const auto dead = manager_->try_claim_live (started.info.inbox_id);
    ASSERT_HAS_VALUE (dead);

    // Immediately after the last write the holder is presumed alive.
    EXPECT_FALSE (manager_->try_claim_live (started.info.inbox_id).has_value ());

    std::this_thread::sleep_for (
    std::chrono::milliseconds (inbox_constants::MIN_LIVE_CLAIM_STALE_MS + 50));
    const auto reconnect = manager_->try_claim_live (started.info.inbox_id);
    ASSERT_HAS_VALUE (reconnect)
    << "a reconnect met a 409 it cannot recover from";

    // The evicted holder learns it lost the slot the next time it writes, and
    // can neither keep the new claim's clock alive nor release it.
    EXPECT_FALSE (manager_->note_live_write (started.info.inbox_id, *dead));
    manager_->release_live (started.info.inbox_id, *dead);
    EXPECT_FALSE (manager_->try_claim_live (started.info.inbox_id).has_value ())
    << "the evicted holder released a slot that was no longer its own";
    EXPECT_TRUE (manager_->note_live_write (started.info.inbox_id, *reconnect));
}

// ---------------------------------------------------------------------------
// The user-settable limits
// ---------------------------------------------------------------------------

TEST_F (InboxListenerTest, SeedsTheThreeLimitsFromTheConstants) {
    const auto limits = vayu::http::read_inbox_limits (*db_);
    EXPECT_EQ (limits.max_body_bytes, inbox_constants::MAX_BODY_BYTES);
    EXPECT_EQ (limits.max_captures, inbox_constants::MAX_CAPTURES);
    EXPECT_EQ (limits.live_poll_interval_ms, inbox_constants::LIVE_POLL_INTERVAL_MS);

    // Each is a real config row, so the Settings panel renders it with no app
    // change - a constant with no entry would be invisible there.
    for (const char* key :
    { "inboxMaxBodyBytes", "inboxMaxCaptures", "inboxLivePollIntervalMs" }) {
        auto entry = db_->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key;
        // Services, not Observability: the Dock's word for inboxes, mock
        // servers and issuers, so the settings tree and the drawer name
        // the same group the same way (#586).
        EXPECT_EQ (entry->category, "services") << key;
        EXPECT_TRUE (entry->min_value.has_value ()) << key;
        EXPECT_TRUE (entry->max_value.has_value ()) << key;
    }
}

// Mutation check for the reader: point the capture path back at the constant
// and the value the user stored stops reaching the listener.
TEST_F (InboxListenerTest, AConfiguredBodyLimitIsWhatTruncatesACapture) {
    set_config ("inboxMaxBodyBytes", inbox_constants::MIN_BODY_BYTES);

    auto started = start ();
    auto client  = client_for (started.info);
    const std::string body (static_cast<size_t> (inbox_constants::MIN_BODY_BYTES) + 40, 'x');
    ASSERT_TRUE (client.Post ("/hook", body, "text/plain"));

    auto captures = db_->get_inbox_requests_paginated (started.info.inbox_id, 1, 0);
    ASSERT_EQ (captures.size (), 1u);
    EXPECT_EQ (static_cast<int64_t> (captures.front ().body.size ()),
    inbox_constants::MIN_BODY_BYTES);
    EXPECT_TRUE (captures.front ().body_truncated);
    EXPECT_EQ (captures.front ().body_bytes, static_cast<int64_t> (body.size ()));
}

TEST_F (InboxListenerTest, AConfiguredRetentionIsWhatBoundsTheCaptureRing) {
    set_config ("inboxMaxCaptures", 2);

    auto started = start ();
    auto client  = client_for (started.info);
    for (int i = 0; i < 4; ++i) {
        ASSERT_TRUE (client.Post ("/hook", std::to_string (i), "text/plain"));
    }

    EXPECT_EQ (db_->count_inbox_requests (started.info.inbox_id), 2);
    auto captures = db_->get_inbox_requests_paginated (started.info.inbox_id, 10, 0);
    ASSERT_EQ (captures.size (), 2u);
    EXPECT_EQ (captures[0].body, "3"); // newest kept
    EXPECT_EQ (captures[1].body, "2");
}

// A running inbox keeps the limits it started with, so one inbox's captures are
// a set truncated by a single rule rather than by whatever the setting was at
// each arrival.
TEST_F (InboxListenerTest, ARunningInboxKeepsTheLimitsItStartedWith) {
    auto started        = start ();
    const auto at_start = manager_->limits (started.info.inbox_id);
    ASSERT_HAS_VALUE (at_start);
    EXPECT_EQ (at_start->max_captures, inbox_constants::MAX_CAPTURES);

    set_config ("inboxMaxCaptures", 3);
    const auto after_the_edit = manager_->limits (started.info.inbox_id);
    ASSERT_HAS_VALUE (after_the_edit);
    EXPECT_EQ (after_the_edit->max_captures, inbox_constants::MAX_CAPTURES);

    auto restarted           = start ();
    const auto after_restart = manager_->limits (restarted.info.inbox_id);
    ASSERT_HAS_VALUE (after_restart);
    EXPECT_EQ (after_restart->max_captures, 3);
    EXPECT_FALSE (manager_->limits ("inbox_nope").has_value ());
}

// POST /config rejects an out-of-range value against the seeded min/max, so a
// hand-edited row is the only way one arrives - and a body limit of 0 would
// turn every capture into an empty row that claims to be truncated.
TEST_F (InboxListenerTest, AnOutOfRangeStoredValueFallsBackToItsSeed) {
    set_config ("inboxMaxBodyBytes", 0);
    set_config ("inboxMaxCaptures", -1);
    set_config ("inboxLivePollIntervalMs",
    int64_t{ 10 } * inbox_constants::MAX_LIVE_POLL_INTERVAL_MS);

    const auto limits = vayu::http::read_inbox_limits (*db_);
    EXPECT_EQ (limits.max_body_bytes, inbox_constants::MAX_BODY_BYTES);
    EXPECT_EQ (limits.max_captures, inbox_constants::MAX_CAPTURES);
    EXPECT_EQ (limits.live_poll_interval_ms, inbox_constants::LIVE_POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Storage bound and the list core
// ---------------------------------------------------------------------------

class InboxStorageTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_inbox_storage.db";

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

    int append (const std::string& inbox_id, const std::string& body, int64_t max_captures) {
        vayu::db::InboxRequest capture;
        capture.inbox_id    = inbox_id;
        capture.received_at = 1700000000000;
        capture.method      = "POST";
        capture.path        = "/hook";
        capture.headers     = "{}";
        capture.body        = body;
        capture.body_bytes  = static_cast<int64_t> (body.size ());
        return db_->add_inbox_request (capture, max_captures);
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (InboxStorageTest, TheRingBoundEvictsTheOldestAndOnlyWithinItsInbox) {
    for (int i = 0; i < 5; ++i) {
        append ("inbox_a", "a" + std::to_string (i), 3);
    }
    append ("inbox_b", "b0", 3);

    EXPECT_EQ (db_->count_inbox_requests ("inbox_a"), 3);
    EXPECT_EQ (db_->count_inbox_requests ("inbox_b"), 1);

    // Newest first, and the two oldest are gone - not the two newest.
    auto captures = db_->get_inbox_requests_paginated ("inbox_a", 10, 0);
    ASSERT_EQ (captures.size (), 3u);
    EXPECT_EQ (captures[0].body, "a4");
    EXPECT_EQ (captures[1].body, "a3");
    EXPECT_EQ (captures[2].body, "a2");
}

TEST_F (InboxStorageTest, CapturesSinceAnIdFeedTheLiveStreamInArrivalOrder) {
    const int first  = append ("inbox_a", "one", 100);
    const int second = append ("inbox_a", "two", 100);

    auto fresh = db_->get_inbox_requests_since ("inbox_a", first);
    ASSERT_EQ (fresh.size (), 1u);
    EXPECT_EQ (fresh.front ().id, second);
    EXPECT_EQ (fresh.front ().body, "two");
    EXPECT_EQ (db_->get_inbox_requests_since ("inbox_a", second).size (), 0u);
    EXPECT_EQ (db_->get_inbox_requests_since ("inbox_a", 0).size (), 2u);
}

TEST_F (InboxStorageTest, ClearingIsPerInboxAndStartupClearsEverything) {
    append ("inbox_a", "a", 100);
    append ("inbox_a", "a", 100);
    append ("inbox_b", "b", 100);

    EXPECT_EQ (db_->clear_inbox_requests ("inbox_a"), 2);
    EXPECT_EQ (db_->count_inbox_requests ("inbox_a"), 0);
    EXPECT_EQ (db_->count_inbox_requests ("inbox_b"), 1);

    // No inbox survives the process that opened it, so init() drops the rest.
    db_->init ();
    EXPECT_EQ (db_->count_inbox_requests ("inbox_b"), 0);
}

TEST_F (InboxStorageTest, TheCaptureListCoreAnswers404ForAnUnknownInboxAndPages) {
    InboxManager manager;
    auto started = manager.start (*db_, InboxStartRequest{});
    ASSERT_TRUE (started.ok) << started.error_message;
    const std::string inbox_id = started.info.inbox_id;

    auto [missing_status, missing_body] =
    vayu::http::routes::inbox_captures_response (*db_, manager, "inbox_nope", 50, 0);
    EXPECT_EQ (missing_status, 404);
    EXPECT_EQ (missing_body["error"]["code"], "not_found");

    for (int i = 0; i < 3; ++i) {
        append (inbox_id, "body" + std::to_string (i), 100);
    }

    auto [status, body] =
    vayu::http::routes::inbox_captures_response (*db_, manager, inbox_id, 2, 0);
    EXPECT_EQ (status, 200);
    ASSERT_EQ (body["data"].size (), 2u);
    EXPECT_EQ (body["data"][0]["body"], "body2"); // newest first
    EXPECT_EQ (body["pagination"]["total"], 3);
    EXPECT_EQ (body["pagination"]["returned"], 2);
    EXPECT_TRUE (body["pagination"]["hasMore"].get<bool> ());

    auto [page2_status, page2] =
    vayu::http::routes::inbox_captures_response (*db_, manager, inbox_id, 2, 2);
    EXPECT_EQ (page2_status, 200);
    ASSERT_EQ (page2["data"].size (), 1u);
    EXPECT_EQ (page2["data"][0]["body"], "body0");
    EXPECT_FALSE (page2["pagination"]["hasMore"].get<bool> ());
}

/*
 * The count a delete confirmation is worded from. It is the one field the
 * manager cannot answer, so a route that built the wire shape without it would
 * report 0 - which reads as "nothing to lose" beside a destructive action.
 */
TEST_F (InboxStorageTest, TheWireShapeCarriesWhatTheInboxIsHolding) {
    InboxManager manager;
    auto started = manager.start (*db_, InboxStartRequest{});
    ASSERT_TRUE (started.ok) << started.error_message;
    const std::string inbox_id = started.info.inbox_id;

    EXPECT_EQ (
    vayu::http::routes::inbox_json (*db_, started.info)["captureCount"], 0);

    for (int i = 0; i < 3; ++i) {
        append (inbox_id, "body" + std::to_string (i), 100);
    }
    // Read back from the manager, as every route does: the count is filled in
    // from the database rather than carried on the record.
    auto info = manager.get (inbox_id);
    ASSERT_HAS_VALUE (info);
    EXPECT_EQ (vayu::http::routes::inbox_json (*db_, *info)["captureCount"], 3);
}

TEST (InboxWireShape, CaptureAndInfoCarryEveryFieldTheUiReads) {
    vayu::db::InboxRequest capture;
    capture.id             = 12;
    capture.inbox_id       = "inbox_x";
    capture.received_at    = 1700000000000;
    capture.method         = "PUT";
    capture.path           = "/hook";
    capture.query          = "a=1";
    capture.headers        = R"({"Content-Type":"application/json"})";
    capture.body           = "{}";
    capture.body_bytes     = 2;
    capture.body_truncated = true;
    capture.remote_addr    = "127.0.0.1";

    const auto wire = vayu::http::inbox_capture_json (capture);
    EXPECT_EQ (wire["id"], 12);
    EXPECT_EQ (wire["method"], "PUT");
    EXPECT_EQ (wire["path"], "/hook");
    EXPECT_EQ (wire["query"], "a=1");
    EXPECT_EQ (wire["headers"]["Content-Type"], "application/json");
    EXPECT_EQ (wire["bodyBytes"], 2);
    EXPECT_TRUE (wire["bodyTruncated"].get<bool> ());
    EXPECT_EQ (wire["remoteAddr"], "127.0.0.1");

    vayu::http::InboxInfo info;
    info.inbox_id        = "inbox_x";
    info.bind            = "0.0.0.0";
    info.port            = 4100;
    info.url             = "http://0.0.0.0:4100/";
    info.running         = true;
    info.loopback        = false;
    info.response.status = 204;

    const auto info_wire = vayu::http::inbox_info_json (info);
    EXPECT_EQ (info_wire["inboxId"], "inbox_x");
    EXPECT_EQ (info_wire["url"], "http://0.0.0.0:4100/");
    EXPECT_EQ (info_wire["port"], 4100);
    EXPECT_FALSE (info_wire["loopback"].get<bool> ());
    EXPECT_TRUE (info_wire["running"].get<bool> ());
    EXPECT_EQ (info_wire["response"]["status"], 204);
    EXPECT_TRUE (info_wire["response"]["headers"].is_object ());
    // Present even on a shape built without a database, so a client never has
    // to tell "no captures" apart from "the field is missing".
    EXPECT_EQ (info_wire["captureCount"], 0);
}

} // namespace
