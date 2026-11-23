/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/retry_after_backoff_test.cpp
 * @brief `retryAfterBackoff` (#3782): the `Retry-After` reader, the wait one
 *        response asks of its virtual user, the warnings, and both load paths
 *        holding a virtual user for the wait.
 *
 * Mutation check for both load paths: make `RunContext::honour_retry_after`
 * return 0 unconditionally (the header ignored) and the run cases' request
 * counts reach the unthrottled reading, above their upper bound.
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`; `run_config_validation_test.cpp`
// carries the same guard for the same reason.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>
#include <httplib.h>

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

#include "optional_assert.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/retry_after.hpp"
#include "vayu/types.hpp"
#include "wait_until.hpp"

namespace {

using nlohmann::json;
using vayu::http::retry_after_delay_ms;

/// 2026-11-23T00:00:00Z, a Monday: the clock every date case reads against.
std::chrono::system_clock::time_point reference_now () {
    return std::chrono::sys_days{ std::chrono::year{ 2026 } / 11 / 23 };
}

// --- The header value ---------------------------------------------------------

TEST (RetryAfterDelay, DeltaSecondsAreReadAsWritten) {
    EXPECT_EQ (retry_after_delay_ms ("1", reference_now ()), 1000);
    EXPECT_EQ (retry_after_delay_ms ("120", reference_now ()), 120000);
    EXPECT_EQ (retry_after_delay_ms (" \t30 ", reference_now ()), 30000)
    << "optional whitespace around the value is not part of it";
    EXPECT_EQ (retry_after_delay_ms ("0", reference_now ()), 0);
}

// RFC 9110 has a recipient accept all three HTTP-date forms.
TEST (RetryAfterDelay, EachHttpDateFormIsTheTimeUntilIt) {
    for (const std::string_view date : { "Mon, 23 Nov 2026 00:00:30 GMT",
         "Monday, 23-Nov-26 00:00:30 GMT", "Mon Nov 23 00:00:30 2026" }) {
        EXPECT_EQ (retry_after_delay_ms (date, reference_now ()), 30000) << date;
    }
}

TEST (RetryAfterDelay, ADateAlreadyPastAsksForNoWait) {
    EXPECT_EQ (
    retry_after_delay_ms ("Sun, 22 Nov 2026 23:59:00 GMT", reference_now ()), 0);
}

TEST (RetryAfterDelay, AValueThatIsNeitherFormAsksForNothing) {
    for (const std::string_view value :
    { "", "   ", "soon", "-5", "+5", "1.5", "5s", "30 seconds", "Nov 2026" }) {
        EXPECT_FALSE (retry_after_delay_ms (value, reference_now ()).has_value ())
        << "'" << value << "'";
    }
}

// A delta too large for the arithmetic is still a well-formed "a very long
// time", which the run's cap clamps, never a parse failure that waits nothing.
TEST (RetryAfterDelay, AnOverlongDeltaSaturatesRatherThanFailing) {
    const auto delay =
    retry_after_delay_ms ("99999999999999999999999", reference_now ());
    ASSERT_HAS_VALUE (delay);
    EXPECT_GT (*delay, vayu::core::constants::run_config::MAX_RETRY_AFTER_MAX_MS);
}

// --- The wait one response asks for --------------------------------------------

vayu::Response response_with (int status, std::optional<std::string> retry_after) {
    vayu::Response response;
    response.status_code = status;
    if (retry_after) {
        // Lower case on purpose: the map folds names, and a server may too.
        response.headers["retry-after"] = *retry_after;
    }
    return response;
}

/// A closed-loop run's context, as `maintain_concurrency` leaves one.
std::shared_ptr<vayu::core::RunContext> closed_loop_context (json config) {
    auto context =
    std::make_shared<vayu::core::RunContext> ("run-retry-after", std::move (config));
    context->closed_loop.store (true);
    return context;
}

TEST (RetryAfterHonour, A429Or503WithTheHeaderIsWaitedOutAndCounted) {
    auto context = closed_loop_context ({ { "retryAfterBackoff", true } });
    EXPECT_EQ (context->honour_retry_after (response_with (429, "2")), 2000);
    EXPECT_EQ (context->honour_retry_after (response_with (503, "3")), 3000);
    EXPECT_EQ (context->metrics_collector->retry_after_waits (), 2u);
}

TEST (RetryAfterHonour, NothingElseAsksForAWait) {
    auto context = closed_loop_context ({ { "retryAfterBackoff", true } });
    EXPECT_EQ (context->honour_retry_after (response_with (200, "5")), 0);
    EXPECT_EQ (context->honour_retry_after (response_with (500, "5")), 0);
    EXPECT_EQ (context->honour_retry_after (response_with (429, std::nullopt)), 0);
    EXPECT_EQ (context->honour_retry_after (response_with (429, "soon")), 0);
    EXPECT_EQ (context->honour_retry_after (response_with (429, "0")), 0);
    EXPECT_EQ (context->metrics_collector->retry_after_waits (), 0u)
    << "a response that asked for no wait counts none";
}

TEST (RetryAfterHonour, TheWaitIsClampedToTheRunsCap) {
    auto defaulted = closed_loop_context ({ { "retryAfterBackoff", true } });
    EXPECT_EQ (defaulted->honour_retry_after (response_with (429, "3600")),
    vayu::core::constants::run_config::DEFAULT_RETRY_AFTER_MAX_MS);

    auto capped = closed_loop_context (
    { { "retryAfterBackoff", true }, { "retryAfterMaxMs", 1500 } });
    EXPECT_EQ (capped->honour_retry_after (response_with (429, "3600")), 1500);
    EXPECT_EQ (capped->honour_retry_after (response_with (429, "1")), 1000)
    << "a wait under the cap is the server's own";
}

// Off by default, and never on an open loop (`constant_rps`), whose pacer
// reads the same slots and would drop arrivals for a wait no request holds.
TEST (RetryAfterHonour, NoWaitWithTheOptionOffOrOnAnOpenLoop) {
    auto off = closed_loop_context (json::object ());
    EXPECT_EQ (off->honour_retry_after (response_with (429, "5")), 0);

    auto open = std::make_shared<vayu::core::RunContext> (
    "run-retry-after-open", json{ { "retryAfterBackoff", true } });
    EXPECT_EQ (open->honour_retry_after (response_with (429, "5")), 0);

    EXPECT_EQ (off->metrics_collector->retry_after_waits () +
    open->metrics_collector->retry_after_waits (),
    0u);
}

// --- The warnings ------------------------------------------------------------------

/// The warning carrying @p code among @p warnings, or a null json.
json warning_entry (const json& warnings, std::string_view code) {
    for (const auto& warning : warnings) {
        if (warning.value ("code", "") == code) {
            return warning;
        }
    }
    return {};
}

void record_statuses (vayu::core::RunContext& context, int status, size_t count) {
    for (size_t i = 0; i < count; ++i) {
        context.metrics_collector->record_success (status, 1.0, 0.0);
    }
    context.requests_sent += count;
}

// Mutation check: drop `rate_limited_dominant_warning` from
// `retry_after_warning` and the first expectation fails; compare with `<`
// instead of `<=` and the exactly-half case reports.
TEST (RetryAfterWarnings, MostlyRateLimitedWithTheOptionOffNamesTheOption) {
    auto dominated = closed_loop_context (json::object ());
    record_statuses (*dominated, 429, 6);
    record_statuses (*dominated, 200, 4);
    const auto warning = warning_entry (
    vayu::core::build_run_warnings (dominated), "rate_limited_dominant");
    ASSERT_TRUE (warning.is_object ());
    EXPECT_EQ (warning["count"], 6u);
    const auto message = warning.value ("message", "");
    EXPECT_NE (message.find ("6 of 10 responses"), std::string::npos) << message;
    EXPECT_NE (message.find ("retryAfterBackoff"), std::string::npos) << message;

    auto half = closed_loop_context (json::object ());
    record_statuses (*half, 429, 5);
    record_statuses (*half, 200, 5);
    EXPECT_TRUE (warning_entry (vayu::core::build_run_warnings (half), "rate_limited_dominant")
    .is_null ())
    << "exactly half is not more than half";
}

// A constant-rate run cannot back off, so the message must not send the user to
// an option that only raises `retry_after_skipped_open_loop`. Mutation check:
// drop the `closed_loop` branch in `rate_limited_dominant_warning` and either
// this test (the option named) or the closed-loop one (the option missing) fails.
TEST (RetryAfterWarnings, MostlyRateLimitedOnAConstantRateRunDoesNotAdviseTheOption) {
    auto open = std::make_shared<vayu::core::RunContext> (
    "run-retry-after-open", json::object ());
    record_statuses (*open, 429, 6);
    record_statuses (*open, 200, 4);
    const auto warnings = vayu::core::build_run_warnings (open);
    const auto warning  = warning_entry (warnings, "rate_limited_dominant");
    ASSERT_TRUE (warning.is_object ()) << warnings.dump ();
    EXPECT_EQ (warning["count"], 6u);
    const auto message = warning.value ("message", "");
    EXPECT_NE (message.find ("6 of 10 responses"), std::string::npos) << message;
    EXPECT_NE (message.find ("not to constant-rate runs"), std::string::npos) << message;
    EXPECT_EQ (message.find ("retryAfterBackoff"), std::string::npos) << message;
}

// A transport failure is no response, so it neither dilutes nor joins the 429s.
TEST (RetryAfterWarnings, TransportFailuresAreNotResponses) {
    auto context = closed_loop_context (json::object ());
    record_statuses (*context, 429, 3);
    record_statuses (*context, 200, 2);
    for (int i = 0; i < 5; ++i) {
        context->metrics_collector->record_error (vayu::ErrorCode::ConnectionFailed, "refused");
    }
    const auto warning =
    warning_entry (vayu::core::build_run_warnings (context), "rate_limited_dominant");
    ASSERT_TRUE (warning.is_object ());
    EXPECT_NE (warning.value ("message", "").find ("3 of 5 responses"), std::string::npos)
    << warning.dump ();
}

TEST (RetryAfterWarnings, WithTheOptionOnTheWaitsAreReportedInstead) {
    auto context = closed_loop_context ({ { "retryAfterBackoff", true } });
    record_statuses (*context, 429, 4);
    (void)context->honour_retry_after (response_with (429, "1"));
    (void)context->honour_retry_after (response_with (429, "1"));
    const auto warnings = vayu::core::build_run_warnings (context);
    EXPECT_TRUE (warning_entry (warnings, "rate_limited_dominant").is_null ())
    << warnings.dump ();
    const auto waits = warning_entry (warnings, "retry_after_backoff");
    ASSERT_TRUE (waits.is_object ()) << warnings.dump ();
    EXPECT_EQ (waits["count"], 2u);
}

TEST (RetryAfterWarnings, AConstantRateRunSaysItDidNotBackOff) {
    auto context = std::make_shared<vayu::core::RunContext> (
    "run-retry-after-open", json{ { "retryAfterBackoff", true } });
    EXPECT_TRUE (warning_entry (vayu::core::build_run_warnings (context), "retry_after_skipped_open_loop")
    .is_null ())
    << "a run that sent nothing reached no strategy";

    record_statuses (*context, 429, 1);
    const auto warning = warning_entry (
    vayu::core::build_run_warnings (context), "retry_after_skipped_open_loop");
    ASSERT_TRUE (warning.is_object ());
    EXPECT_EQ (warning.value ("message", ""),
    vayu::core::RunContext::OPEN_LOOP_RETRY_AFTER_SKIP_REASON);
}

// --- Both load paths, against a throttling target ------------------------------------

/**
 * Answers every `every`-th request 429 with `Retry-After: <retry_after>` (no
 * header when it is empty) and every other one 200.
 */
class ThrottlingServer {
    public:
    ThrottlingServer (size_t every, std::string retry_after)
    : every_ (every), retry_after_ (std::move (retry_after)) {
        svr_.new_task_queue = vayu::tests::pooled_task_queue (8);
        svr_.Get ("/limited", [this] (const httplib::Request&, httplib::Response& res) {
            const size_t arrival = ++arrivals_;
            if (arrival % every_ == 0) {
                res.status = 429;
                if (!retry_after_.empty ()) {
                    res.set_header ("Retry-After", retry_after_);
                }
            }
            res.set_content ("{}", "application/json");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }
    ~ThrottlingServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    ThrottlingServer (const ThrottlingServer&)            = delete;
    ThrottlingServer& operator= (const ThrottlingServer&) = delete;
    ThrottlingServer (ThrottlingServer&&)                 = delete;
    ThrottlingServer& operator= (ThrottlingServer&&)      = delete;

    [[nodiscard]] std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/limited";
    }

    private:
    size_t every_;
    std::string retry_after_;
    std::atomic<size_t> arrivals_{ 0 };
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
};

/**
 * One virtual user for two seconds against a target that rate-limits every
 * second request with `Retry-After: 1`. Healthy, the user waits a second
 * after each 429, so the run sends about four requests (200, 429, a second's
 * wait, 200, 429). Fully throttled - every response a 429 - it would send one
 * a second, two; that floor is the lower bound, and the run's first two
 * exchanges alone reach it. Unthrottled - the header ignored, the mutation
 * check - a loopback target answers in well under a millisecond, so the user
 * sends thousands (about 8,400 in a Debug build on a four-core box) and still
 * hundreds on the slowest CI leg; the upper bound sits ten times above the
 * healthy reading and far under that.
 */
constexpr size_t FULLY_THROTTLED_REQUESTS = 2;
constexpr size_t MOST_THROTTLED_REQUESTS  = 40;
constexpr size_t EVERY_SECOND_REQUEST     = 2;

json closed_loop_run (const std::string& url) {
    return { { "mode", "constant_concurrency" }, { "concurrency", 1 },
        { "duration", "2s" }, { "url", url }, { "method", "GET" },
        { "timeout", 5000 }, { "retryAfterBackoff", true } };
}

class RetryAfterBackoffRunTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_retry_after_backoff.db";

    void SetUp () override {
        vayu::http::global_init ();
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        vayu::http::global_cleanup ();
    }

    /// A single-request load run of @p config to its end, through the
    /// manager, and its stored summary. Finished is `get_run` answering null,
    /// because retaining the row is the worker's last act.
    json run_single_request (const std::string& run_id, const json& config) {
        vayu::db::Run row;
        row.id              = run_id;
        row.type            = vayu::RunType::Load;
        row.status          = vayu::RunStatus::Pending;
        row.config_snapshot = "{}";
        row.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        db_->create_run (row);

        vayu::core::RunManager manager;
        manager.start_run (run_id, config, *db_);
        if (!vayu::tests::wait_until (
            [&] () { return manager.get_run (run_id) == nullptr; })) {
            ADD_FAILURE () << "the run never reached a terminal status";
            return json::object ();
        }
        const auto stored = db_->get_run (run_id);
        if (!stored) {
            ADD_FAILURE () << "the run row is gone";
            return json::object ();
        }
        return json::parse (stored->summary);
    }

    /// A one-step scenario load run of @p config against @p url, driven the
    /// way `execute_load_test` drives it, with its context left in
    /// `context_`.
    void run_scenario (const json& config, const std::string& url) {
        vayu::core::ScenarioExecution execution;
        execution.request.source        = "collection";
        execution.request.collection_id = "col_test";
        vayu::core::ScenarioStep step;
        step.request_id         = "req_0";
        step.name               = "step0";
        step.request.method     = vayu::HttpMethod::GET;
        step.request.url        = url;
        step.request.timeout_ms = 5000;
        step.stored_url         = url;
        execution.plan.steps.push_back (std::move (step));

        context_ =
        std::make_shared<vayu::core::RunContext> ("run-retry-after-scenario", config);
        context_->scenario =
        std::make_shared<const vayu::core::ScenarioExecution> (std::move (execution));
        context_->event_loop =
        std::make_unique<vayu::http::EventLoop> (vayu::http::EventLoopConfig{});
        context_->event_loop->start ();
        auto scopes =
        vayu::core::scenario_load_scopes (*db_, std::nullopt, *context_->scenario);
        (void)vayu::core::execute_scenario_load (
        context_, *db_, *context_->scenario, std::move (scopes));
        context_->event_loop->stop (true, std::chrono::milliseconds (10000));
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::shared_ptr<vayu::core::RunContext> context_;
};

TEST_F (RetryAfterBackoffRunTest, AClosedLoopUserWaitsOutEachRetryAfter) {
    ThrottlingServer server (EVERY_SECOND_REQUEST, "1");
    const auto summary =
    run_single_request ("run-retry-after-closed", closed_loop_run (server.url ()));

    const auto sent = summary.value ("total_requests", size_t{ 0 });
    EXPECT_GE (sent, FULLY_THROTTLED_REQUESTS) << summary.dump ();
    EXPECT_LE (sent, MOST_THROTTLED_REQUESTS) << summary.dump ();

    const auto limited =
    summary.value ("status_codes", json::object ()).value ("429", size_t{ 0 });
    ASSERT_GE (limited, 1u) << summary.dump ();
    const auto warnings = summary.value ("warnings", json::array ());
    const auto waits    = warning_entry (warnings, "retry_after_backoff");
    ASSERT_TRUE (waits.is_object ()) << summary.dump ();
    EXPECT_EQ (waits["count"], limited) << "every 429 carried the header";
    EXPECT_TRUE (warning_entry (warnings, "rate_limited_dominant").is_null ());
}

// The scenario path holds the virtual user through `ready_at_ms` rather than
// a reservation; the same bounds, for the same reasons.
TEST_F (RetryAfterBackoffRunTest, AScenarioUserWaitsOutEachRetryAfter) {
    ThrottlingServer server (EVERY_SECOND_REQUEST, "1");
    run_scenario ({ { "mode", "constant_concurrency" }, { "concurrency", 1 },
                  { "duration", "2s" }, { "retryAfterBackoff", true } },
    server.url ());

    const auto sent = context_->metrics_collector->total_requests ();
    EXPECT_GE (sent, FULLY_THROTTLED_REQUESTS);
    EXPECT_LE (sent, MOST_THROTTLED_REQUESTS);
    const auto waits = context_->metrics_collector->retry_after_waits ();
    EXPECT_GE (waits, 1u);
    EXPECT_EQ (context_->metrics_collector->status_code_distribution ()[429], waits);
}

// With the option off the user does not wait, and a run whose every response
// is a 429 says so, naming the option. Stored, so the report carries it.
TEST_F (RetryAfterBackoffRunTest, WithTheOptionOffAnAllRateLimitedRunWarns) {
    ThrottlingServer server (1, "1");
    auto config = closed_loop_run (server.url ());
    config.erase ("retryAfterBackoff");
    config["mode"]       = "iterations";
    config["iterations"] = 4;
    config.erase ("duration");
    const auto summary = run_single_request ("run-retry-after-off", config);

    const auto warnings = summary.value ("warnings", json::array ());
    const auto warning  = warning_entry (warnings, "rate_limited_dominant");
    ASSERT_TRUE (warning.is_object ()) << summary.dump ();
    EXPECT_EQ (warning["count"], 4u);
    EXPECT_TRUE (warning_entry (warnings, "retry_after_backoff").is_null ());
}

// A constant-rate run never backs off. Fifty arrivals at 50/s, every one
// answered 429 with a minute's Retry-After, under a cap of twenty in flight:
// a wait reserved per completion (30 s, the default cap) would fill the cap
// after twenty and drop thirty, peaking at twenty; the healthy run's requests
// hold a slot for about a millisecond, so it drops none and peaks at what a
// catch-up burst stacks. Mutation check: drop the `closed_loop` test from
// `honour_retry_after` and the drop and peak expectations fail.
TEST_F (RetryAfterBackoffRunTest, AConstantRateRunNeverBacksOff) {
    constexpr size_t MAX_IN_FLIGHT = 20;
    ThrottlingServer server (1, "60");
    const json config = { { "mode", "constant_rps" }, { "rps", 50 },
        { "maxInFlight", MAX_IN_FLIGHT }, { "duration", "1s" }, { "url", server.url () },
        { "method", "GET" }, { "timeout", 5000 }, { "retryAfterBackoff", true } };
    const auto summary = run_single_request ("run-retry-after-open-loop", config);

    EXPECT_EQ (summary.value ("dropped_requests", size_t{ 1 }), 0u) << summary.dump ();
    EXPECT_LT (summary.value ("peak_concurrency", MAX_IN_FLIGHT), MAX_IN_FLIGHT)
    << summary.dump ();
    const auto warnings = summary.value ("warnings", json::array ());
    EXPECT_FALSE (warning_entry (warnings, "retry_after_skipped_open_loop").is_null ())
    << summary.dump ();
    EXPECT_TRUE (warning_entry (warnings, "retry_after_backoff").is_null ())
    << summary.dump ();
}

} // namespace
