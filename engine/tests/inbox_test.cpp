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
} // namespace vayu::http::routes

namespace {

namespace inbox_constants = vayu::core::constants::inbox;

// ---------------------------------------------------------------------------
// Payload validation - no listener, no database
// ---------------------------------------------------------------------------

TEST (InboxParseStart, EmptyBodyStartsALoopbackInboxAnswering200) {
    InboxStartRequest out;
    auto error = vayu::http::parse_inbox_start (json (nullptr), out);
    ASSERT_FALSE (error.has_value ());
    EXPECT_EQ (out.bind, "127.0.0.1");
    EXPECT_EQ (out.port, 0);
    EXPECT_EQ (out.response.status, 200);
    EXPECT_EQ (out.response.delay_ms, 0);
    EXPECT_TRUE (out.response.body.empty ());
}

TEST (InboxParseStart, ReadsEveryResponseField) {
    InboxStartRequest out;
    const json body = { { "port", 0 }, { "bind", "127.0.0.1" },
        { "response",
        { { "status", 503 }, { "body", "retry later" }, { "delayMs", 25 },
        { "headers", { { "Retry-After", "1" } } } } } };
    ASSERT_FALSE (vayu::http::parse_inbox_start (body, out).has_value ());
    EXPECT_EQ (out.response.status, 503);
    EXPECT_EQ (out.response.body, "retry later");
    EXPECT_EQ (out.response.delay_ms, 25);
    ASSERT_EQ (out.response.headers.count ("Retry-After"), 1u);
    EXPECT_EQ (out.response.headers.at ("Retry-After"), "1");
}

TEST (InboxParseStart, RejectsRatherThanDefaultsAnUnusableValue) {
    InboxStartRequest out;
    // A status outside the HTTP range, a negative delay, a delay past the
    // bound, a non-object headers map and a port outside the range are each a
    // 400: silently answering 200 instead is a listener doing something other
    // than what its caller asked for.
    EXPECT_TRUE (
    vayu::http::parse_inbox_start (json{ { "response", { { "status", 900 } } } }, out)
    .has_value ());
    EXPECT_TRUE (
    vayu::http::parse_inbox_start (json{ { "response", { { "delayMs", -1 } } } }, out)
    .has_value ());
    EXPECT_TRUE (vayu::http::parse_inbox_start (
    json{ { "response", { { "delayMs", inbox_constants::MAX_RESPONSE_DELAY_MS + 1 } } } }, out)
                 .has_value ());
    EXPECT_TRUE (vayu::http::parse_inbox_start (
    json{ { "response", { { "headers", "nope" } } } }, out)
                 .has_value ());
    EXPECT_TRUE (
    vayu::http::parse_inbox_start (json{ { "port", 70000 } }, out).has_value ());
    EXPECT_TRUE (vayu::http::parse_inbox_start (json{ { "bind", "" } }, out).has_value ());
    EXPECT_TRUE (vayu::http::parse_inbox_start (json ("not an object"), out).has_value ());
}

TEST (InboxParseStart, NonLoopbackBindNeedsExplicitConfirmation) {
    InboxStartRequest out;
    auto refused = vayu::http::parse_inbox_start (json{ { "bind", "0.0.0.0" } }, out);
    ASSERT_TRUE (refused.has_value ());
    EXPECT_EQ (refused->http_status, 400);
    EXPECT_EQ (refused->code, "inbox_non_loopback_bind");

    auto accepted = vayu::http::parse_inbox_start (
    json{ { "bind", "0.0.0.0" }, { "confirmNonLoopback", true } }, out);
    EXPECT_FALSE (accepted.has_value ());
    EXPECT_EQ (out.bind, "0.0.0.0");

    // Loopback in any of its spellings needs no confirmation.
    EXPECT_TRUE (vayu::http::is_loopback_bind ("127.0.0.1"));
    EXPECT_TRUE (vayu::http::is_loopback_bind ("127.1.2.3"));
    EXPECT_TRUE (vayu::http::is_loopback_bind ("::1"));
    EXPECT_TRUE (vayu::http::is_loopback_bind ("localhost"));
    EXPECT_FALSE (vayu::http::is_loopback_bind ("0.0.0.0"));
    EXPECT_FALSE (vayu::http::is_loopback_bind ("192.168.1.4"));
}

TEST (InboxParseUpdate, AbsentFieldKeepsTheLiveValue) {
    InboxCannedResponse current;
    current.status   = 500;
    current.body     = "boom";
    current.delay_ms = 10;
    current.headers  = { { "X-Trace", "abc" } };

    InboxCannedResponse out;
    ASSERT_FALSE (
    vayu::http::parse_inbox_response_update (json{ { "status", 200 } }, current, out)
    .has_value ());
    EXPECT_EQ (out.status, 200);
    // The point of the merge: changing the status must not drop the rest.
    EXPECT_EQ (out.body, "boom");
    EXPECT_EQ (out.delay_ms, 10);
    ASSERT_EQ (out.headers.count ("X-Trace"), 1u);

    // The start route's own shape is accepted too, so a client can send back
    // what it was handed.
    ASSERT_FALSE (vayu::http::parse_inbox_response_update (
    json{ { "response", { { "body", "ok" } } } }, current, out)
                  .has_value ());
    EXPECT_EQ (out.body, "ok");
    EXPECT_EQ (out.status, 500);

    EXPECT_TRUE (vayu::http::parse_inbox_response_update (json{ { "status", 12 } }, current, out)
                 .has_value ());
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
    ASSERT_TRUE (after.has_value ());
    EXPECT_FALSE (after->running);
    // Stopping is not deleting: the captures are still listable.
    EXPECT_EQ (db_->count_inbox_requests (started.info.inbox_id), 1);

    httplib::Client client ("127.0.0.1", started.info.port);
    client.set_connection_timeout (0, 300000); // 300ms
    EXPECT_FALSE (client.Post ("/hook", "{}", "application/json"))
    << "a stopped inbox must refuse further connections";
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
    auto started = start ();
    EXPECT_TRUE (manager_->try_claim_live (started.info.inbox_id));
    EXPECT_FALSE (manager_->try_claim_live (started.info.inbox_id))
    << "a second watcher would park a second pool thread on the same inbox";
    manager_->release_live (started.info.inbox_id);
    EXPECT_TRUE (manager_->try_claim_live (started.info.inbox_id));
    EXPECT_FALSE (manager_->try_claim_live ("inbox_nope"));
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
}

} // namespace
