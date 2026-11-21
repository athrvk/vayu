/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/send_log_test.cpp
 * @brief The log record a design Send leaves behind (issue #3677): a `warn`
 *        line when it failed, a `debug` line when it did not, one per Send
 *        whichever path it ends in. `describe_send_outcome` on its own, then
 *        the real `POST /execute`; `script_send_request_test.cpp` holds the
 *        `pm.sendRequest` half.
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "log_capture.hpp"
#include "mock_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/send_log.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/log_text.hpp"
#include "wait_until.hpp"

namespace {

using nlohmann::json;
using vayu::http::describe_send_outcome;
using vayu::http::SendOutcome;
using vayu::tests::LogCapture;
using vayu::tests::wait_until;

// Port 1: connection refused, fast fail (the suite's spelling for it).
constexpr const char* REFUSED_URL = "http://127.0.0.1:1/";

SendOutcome failed_outcome () {
    SendOutcome outcome;
    outcome.subject       = "Send";
    outcome.method        = "POST";
    outcome.url           = REFUSED_URL;
    outcome.elapsed_ms    = 3.5;
    outcome.error_code    = vayu::ErrorCode::ConnectionFailed;
    outcome.error_message = "Failed to connect to 127.0.0.1 port 1";
    return outcome;
}

TEST (SendOutcomeRecordTest, AFailedSendIsAFailureNamingMethodUrlCodeAndMessage) {
    const auto record = describe_send_outcome (failed_outcome ());

    EXPECT_TRUE (record.failed);
    EXPECT_EQ (record.msg, "Send failed");
    EXPECT_EQ (record.fields.at ("method"), "POST");
    EXPECT_EQ (record.fields.at ("url"), REFUSED_URL);
    EXPECT_EQ (record.fields.at ("errorCode"), "CONNECTION_FAILED");
    EXPECT_EQ (record.fields.at ("error"), "Failed to connect to 127.0.0.1 port 1");
    EXPECT_FALSE (record.fields.contains ("status"))
    << "no answer came back, so there is no status to name";
    EXPECT_FALSE (record.fields.contains ("runId"));
    EXPECT_EQ (record.fields.at ("ms"), 3.5);

    auto sub_millisecond       = failed_outcome ();
    sub_millisecond.elapsed_ms = 0.101595;
    EXPECT_EQ (describe_send_outcome (sub_millisecond).fields.at ("ms"), 0.1)
    << "one decimal, as the request line has it";
}

TEST (SendOutcomeRecordTest, ASendThatWasAnsweredIsNotAFailureWhateverTheStatus) {
    SendOutcome outcome;
    outcome.subject     = "pm.sendRequest";
    outcome.method      = "GET";
    outcome.url         = "http://h/x";
    outcome.status_code = 503;
    outcome.elapsed_ms  = 12.0;

    const auto record = describe_send_outcome (outcome);

    EXPECT_FALSE (record.failed)
    << "a 5xx is the server's answer, not a failed send";
    EXPECT_EQ (record.msg, "pm.sendRequest completed");
    EXPECT_EQ (record.fields.at ("status"), 503);
    EXPECT_FALSE (record.fields.contains ("errorCode"));
    EXPECT_FALSE (record.fields.contains ("error"));
}

TEST (SendOutcomeRecordTest, ACancelledSendIsNotAFailure) {
    auto outcome          = failed_outcome ();
    outcome.error_code    = vayu::ErrorCode::Cancelled;
    outcome.error_message = "Request cancelled";

    const auto record = describe_send_outcome (outcome);

    EXPECT_FALSE (record.failed);
    EXPECT_EQ (record.msg, "Send cancelled");
    EXPECT_EQ (record.fields.at ("errorCode"), "CANCELLED");
}

TEST (SendOutcomeRecordTest, TheRunIdIsPresentOnlyWhenARunNamesTheSend) {
    auto outcome   = failed_outcome ();
    outcome.run_id = "run_42";
    EXPECT_EQ (describe_send_outcome (outcome).fields.at ("runId"), "run_42");

    outcome.run_id.reset ();
    EXPECT_FALSE (describe_send_outcome (outcome).fields.contains ("runId"));
}

// The transport's words can quote what a server or a script chose, so they ride
// in a bounded field and `msg` stays the fixed sentence.
TEST (SendOutcomeRecordTest, TheErrorTextIsBoundedAndNeverPartOfTheMessage) {
    auto outcome          = failed_outcome ();
    const std::string big = std::string (5000, 'x');
    outcome.error_message = big;

    const auto record = describe_send_outcome (outcome);

    const auto error = record.fields.at ("error").get<std::string> ();
    EXPECT_LE (error.size (),
    vayu::utils::kLoggedTextMaxBytes + vayu::utils::kLoggedTextTruncationMarker.size ());
    EXPECT_TRUE (error.ends_with (vayu::utils::kLoggedTextTruncationMarker));
    EXPECT_EQ (record.msg, "Send failed");
}

class SendLogRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_send_log.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        manager_ = std::make_unique<vayu::http::SseStreamManager> ();
        ctx_     = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, nullptr,
        authorize_manager_, cookie_jar_, mock_issuer_manager_, inbox_manager_,
        mock_server_manager_, *manager_, run_summary_cache_ });
        vayu::http::routes::register_execution_routes (*ctx_);
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    void TearDown () override {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
        run_manager_.shutdown ();
        // Before `db_`: a stream's worker records its result into it.
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// The `/execute` answer for @p payload, a 200 even when the send failed.
    json execute (const json& payload) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        const auto response = client.Post ("/execute", payload.dump (), "application/json");
        if (!response) {
            ADD_FAILURE () << "POST /execute did not answer";
            return json::object ();
        }
        EXPECT_EQ (response->status, 200) << response->body;
        return json::parse (response->body, nullptr, false);
    }

    /// The `http` records a design Send wrote, in order.
    static std::vector<json> send_records (const LogCapture& capture) {
        std::vector<json> out;
        for (auto& record : capture.with_msg_prefix ("Send ")) {
            if (record.at ("cat") == "http") {
                out.push_back (std::move (record));
            }
        }
        return out;
    }

    std::unique_ptr<vayu::db::Database> db_;
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    vayu::core::RunManager run_manager_;
    vayu::http::OAuth2AuthorizeManager authorize_manager_;
    vayu::http::CookieJar cookie_jar_;
    vayu::http::MockIssuerManager mock_issuer_manager_;
    vayu::http::InboxManager inbox_manager_;
    vayu::http::MockServerManager mock_server_manager_;
    vayu::http::RunSummaryCache run_summary_cache_;
    std::unique_ptr<vayu::http::SseStreamManager> manager_;
    std::unique_ptr<vayu::http::routes::RouteContext> ctx_;
};

// Mutation check: delete the `log_design_outcome` call in
// `record_design_result`.
TEST_F (SendLogRouteTest, AFailedSendLeavesOneWarningNamingTheRunAndTheCode) {
    const LogCapture capture;

    const json answer = execute ({ { "method", "POST" },
    { "url", std::string (REFUSED_URL) + "pay?token=S3CRET" } });

    const auto records = send_records (capture);
    ASSERT_EQ (records.size (), 1U) << answer.dump ();
    const auto& record = records.front ();
    EXPECT_EQ (record.at ("level"), "warn");
    EXPECT_EQ (record.at ("msg"), "Send failed");
    EXPECT_EQ (record.at ("method"), "POST");
    EXPECT_EQ (record.at ("url"), std::string (REFUSED_URL) + "pay")
    << "the query's credential is stripped by the logger";
    EXPECT_EQ (record.at ("errorCode"), "CONNECTION_FAILED");
    EXPECT_FALSE (record.at ("error").get<std::string> ().empty ());
    EXPECT_EQ (record.at ("runId"), answer.at ("runId"));
    EXPECT_TRUE (vayu::tests::validates_against_log_schema (record)) << record.dump ();
}

// Mutation check: log at `warn` unconditionally and the level reads wrong, or
// log only on `record.failed` and no record is left.
TEST_F (SendLogRouteTest, AHealthySendLeavesOneDebugLineWithTheStatus) {
    const LogCapture capture;
    const vayu::tests::SlowMockServer upstream;

    const json answer =
    execute ({ { "method", "GET" }, { "url", upstream.fast_url () } });

    const auto records = send_records (capture);
    ASSERT_EQ (records.size (), 1U) << answer.dump ();
    const auto& record = records.front ();
    EXPECT_EQ (record.at ("level"), "debug");
    EXPECT_EQ (record.at ("msg"), "Send completed");
    EXPECT_EQ (record.at ("status"), 200);
    EXPECT_EQ (record.at ("url"), upstream.fast_url ());
    EXPECT_FALSE (record.contains ("errorCode"));
    EXPECT_EQ (record.at ("runId"), answer.at ("runId"));
}

// A transient Send stores nothing and so has no run to name; the record is
// still written, with no `runId` field rather than a placeholder.
TEST_F (SendLogRouteTest, ATransientSendIsLoggedWithoutARunId) {
    const LogCapture capture;

    execute ({ { "method", "GET" }, { "url", REFUSED_URL }, { "transient", true } });

    const auto records = send_records (capture);
    ASSERT_EQ (records.size (), 1U);
    EXPECT_EQ (records.front ().at ("level"), "warn");
    EXPECT_FALSE (records.front ().contains ("runId")) << records.front ().dump ();
}

// A send that fails before anything goes out (here an OAuth 2.0 token the
// endpoint refuses to give) ends in `answer_failed_build`, a different path
// from the exchange, and is logged once all the same, status 0 and so no
// `status` field.
TEST_F (SendLogRouteTest, ASendWhoseBuildFailedIsLoggedOnceAsFailed) {
    const LogCapture capture;
    const json auth{ { "mode", "oauth2" },
        { "config",
        { { "grantType", "client_credentials" },
        { "accessTokenUrl", std::string (REFUSED_URL) + "token" }, { "clientId", "cid" },
        { "clientSecret", "secret" }, { "credentialsPlacement", "body" } } } };

    const json answer = execute ({ { "method", "GET" },
    { "url", "http://127.0.0.1:1/target" }, { "auth", auth } });

    ASSERT_TRUE (answer.contains ("authErrorCode")) << answer.dump ();
    const auto records = send_records (capture);
    ASSERT_EQ (records.size (), 1U) << answer.dump ();
    const auto& record = records.front ();
    EXPECT_EQ (record.at ("level"), "warn");
    EXPECT_EQ (record.at ("errorCode"), answer.at ("errorCode"));
    EXPECT_FALSE (record.contains ("status"));
    EXPECT_EQ (record.at ("runId"), answer.at ("runId"));
}

// A stream's outcome is written by its worker once it ends, through the same
// seam, so it too is one record with its run's id.
TEST_F (SendLogRouteTest, AStreamIsLoggedOnceWhenItEnds) {
    const LogCapture capture;
    vayu::tests::SlowMockServer upstream;
    httplib::Client client ("127.0.0.1", port_);
    client.set_read_timeout (20, 0);
    const json payload{ { "method", "GET" },
        { "url", upstream.sse_held_url () }, { "stream", true } };
    const auto response = client.Post ("/execute", payload.dump (), "application/json");
    ASSERT_TRUE (response) << httplib::to_string (response.error ());
    ASSERT_EQ (response->status, 202) << response->body;
    const json answer = json::parse (response->body);
    ASSERT_TRUE (answer.contains ("runId")) << response->body;
    const std::string run_id = answer.at ("runId").get<std::string> ();
    ASSERT_FALSE (run_id.empty ());
    ASSERT_TRUE (
    wait_until ([&upstream] { return upstream.live_connection_count () > 0; }))
    << "the stream never reached the upstream";

    upstream.released.store (true);
    ASSERT_TRUE (wait_until ([this, &run_id] {
        const auto run = db_->get_run (run_id);
        return run && vayu::is_terminal (run->status);
    }))
    << "the stream never ended";

    const auto records = send_records (capture);
    ASSERT_EQ (records.size (), 1U);
    EXPECT_EQ (records.front ().at ("level"), "debug");
    EXPECT_EQ (records.front ().at ("runId"), run_id);
}

} // namespace
