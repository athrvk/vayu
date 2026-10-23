/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/script_send_request_cap_test.cpp
 * @brief What a script's own fetch inherits: the byte bound (issue #1188), the
 *        request timeout (issue #2833) and, for every load-run context, the
 *        run's default headers too (issue #2841).
 *
 * `pm.sendRequest` builds its own `ClientConfig`, so nothing the enclosing
 * exchange sets on its send reaches it by default - which is how it stayed the
 * one read with no byte bound at all after issue #1157 bounded every other
 * one, and how every load-run script but the deferred replay kept waiting the
 * compiled-in 30 s after #2833. The failure mode is silent in exactly the way
 * `design_read_cap_test.cpp` describes: a caller that forgets to carry a value
 * down sends with the default, and every unit test on either side of the gap
 * still passes.
 *
 * So these drive the production paths rather than the sandbox: an exchange
 * (`POST /execute` and every collection-run step), the deferred `tests` pass
 * of a load run, and whole load runs for the rest of a load run's scripts
 * (`script.setup` / `script.teardown` and the inline step scripts of both run
 * shapes). Which *setting* each path resolves is `config_route_test.cpp`'s
 * `design_response_body_bound` / `load_response_body_bound` cases; what is
 * under test here is that the value reaches the script's transfer at all.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "timed_out_after.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"
#include "wait_until.hpp"

using nlohmann::json;

namespace vayu::http::routes {
// Declared in config.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json>
apply_config_update (vayu::db::Database& db, const std::string& body);
} // namespace vayu::http::routes

namespace {

/// Bigger than curl's 16 KiB write buffer, so the bound is reached part-way
/// through a body arriving in several write-callback calls.
constexpr size_t SERVED_BYTES = size_t{ 64 } * 1024;
/// What the script's fetch is allowed to read. Well under `SERVED_BYTES`, and
/// far under the 32MB compiled-in default, so a bound that never arrived reads
/// the whole body and every assertion below fails.
constexpr size_t READ_BOUND = size_t{ 4 } * 1024;
static_assert (READ_BOUND < SERVED_BYTES, "the bound must cut the fetched body short");

/// The run's `timeout` in the cases that drive a whole run: far under both the
/// compiled-in 30 s and the 5 s script budget that would clamp it.
constexpr int RUN_TIMEOUT_MS = 500;
/// Between the healthy reading (`RUN_TIMEOUT_MS` plus however late libcurl
/// checked) and the broken one (about 5,000 ms, see `expect_run_timeout`).
constexpr int64_t RUN_TIMEOUT_CEILING_MS = 2500;

/// What one script's `POST /report` carried.
struct Report {
    std::string body;
    /// The correlation id header the run's default-header policy adds, empty
    /// when the request went out without it.
    std::string correlation_id;
};

/// Serves one oversized body at `/big`, at `/hang` nothing until the fixture
/// stops, at `/ok` a small answer for a run's own transfers, and records what a
/// script posts to `/report`.
class BigBodyServer {
    public:
    BigBodyServer () {
        // A `/hang` keeps its thread until the fixture stops, after the client
        // gave up on it, so a case that hangs twice still needs threads left
        // for `/ok` and `/report`.
        svr_.new_task_queue = vayu::tests::pooled_task_queue (8);
        svr_.Get ("/big", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (std::string (SERVED_BYTES, 'x'), "text/plain");
        });
        svr_.Get ("/hang", [this] (const httplib::Request&, httplib::Response& res) {
            while (!stopping_.load ()) {
                std::this_thread::sleep_for (std::chrono::milliseconds (10));
            }
            res.set_content ("{}", "application/json");
        });
        svr_.Get ("/ok", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("{}", "application/json");
        });
        svr_.Post ("/report", [this] (const httplib::Request& req, httplib::Response& res) {
            const std::lock_guard<std::mutex> lock (reports_mutex_);
            reports_.push_back ({ req.body,
            req.get_header_value (std::string (vayu::http::DEFAULT_CORRELATION_HEADER)) });
            res.set_content ("{}", "application/json");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~BigBodyServer () {
        // httplib's stop() waits for a running handler, so /hang lets go first.
        stopping_.store (true);
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    BigBodyServer (const BigBodyServer&)            = delete;
    BigBodyServer& operator= (const BigBodyServer&) = delete;
    BigBodyServer (BigBodyServer&&)                 = delete;
    BigBodyServer& operator= (BigBodyServer&&)      = delete;

    [[nodiscard]] std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/big";
    }

    [[nodiscard]] std::string hang_url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/hang";
    }

    [[nodiscard]] std::string ok_url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/ok";
    }

    [[nodiscard]] std::string report_url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/report";
    }

    [[nodiscard]] std::vector<Report> reports () const {
        const std::lock_guard<std::mutex> lock (reports_mutex_);
        return reports_;
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
    std::atomic<bool> stopping_{ false };
    mutable std::mutex reports_mutex_;
    std::vector<Report> reports_;
};

/// A setting, set the way the app sets it.
void apply_setting (vayu::db::Database& db, const std::string& key, const std::string& value) {
    auto [status, body] = vayu::http::routes::apply_config_update (
    db, json{ { "entries", { { key, value } } } }.dump ());
    ASSERT_EQ (status, 200) << body.dump ();
}

/// What a refused fetch says, which is `too_large_message`'s wording.
std::string refusal_of (size_t bound) {
    return std::to_string (bound) + " byte limit";
}

/// What a fetch that arrived whole says.
std::string whole_read_of (size_t bytes) {
    return "read " + std::to_string (bytes);
}

/**
 * A script that fetches the oversized body and throws unless what came back
 * contains @p expected.
 *
 * Throwing is the reporting channel because it is the one both paths surface
 * verbatim: a design exchange keeps it as `ScriptResult::error_message`, and a
 * load replay records it as a `Script error:` failure - where a `pm.test` that
 * merely passes leaves no text at all. The message carries the *actual*
 * outcome, so a failure names what the fetch read rather than only that it was
 * wrong.
 */
std::string fetch_expecting (const std::string& url, const std::string& expected) {
    const std::string body = R"(
        let outcome = 'the callback never ran';
        pm.sendRequest('__URL__', function (err, res) {
            outcome = err ? err.message : ('read ' + res.text().length);
        });
        if (outcome.indexOf('__EXPECTED__') < 0) {
            throw new Error('the fetch answered: ' + outcome);
        }
    )";
    std::string script     = body;
    script.replace (script.find ("__URL__"), std::string ("__URL__").size (), url);
    script.replace (script.find ("__EXPECTED__"),
    std::string ("__EXPECTED__").size (), expected);
    return script;
}

/// A script that fetches @p url and always throws with what came back, so a
/// replay records the outcome - a timeout's message names the deadline the
/// fetch ran under - as its failure.
std::string fetch_reporting (const std::string& url) {
    return "let outcome = 'the callback never ran'; "
           "pm.sendRequest('" +
    url +
    "', function (err, res) { "
    "  outcome = err ? err.code + ' ' + err.message : 'answered ' + res.code; "
    "}); "
    "throw new Error('the fetch answered: ' + outcome);";
}

/**
 * A script that fetches @p url and posts what came back to @p report_url, for
 * a context whose outcome a run keeps nowhere a test can read it: an inline
 * step script's thrown text is tallied, not stored. The outcome is worded as
 * `fetch_expecting` and `fetch_reporting` word theirs, so `refusal_of`,
 * `whole_read_of` and `timed_out_after_ms` read it. Never throws, so the run
 * it is part of carries on as it would without it.
 */
std::string fetch_and_report (const std::string& url, const std::string& report_url) {
    return "let outcome = 'the callback never ran'; "
           "pm.sendRequest('" +
    url +
    "', function (err, res) { "
    "  outcome = err ? err.code + ' ' + err.message : 'read ' + "
    "res.text().length; "
    "}); "
    "pm.sendRequest({ url: '" +
    report_url + "', method: 'POST', body: { mode: 'raw', raw: outcome } }, function () {});";
}

// ============================================================================
// The design path: an exchange's scripts
// ============================================================================

class ScriptSendRequestCapDesignTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server_ = std::make_unique<BigBodyServer> ();
    }

    void TearDown () override {
        server_.reset ();
        vayu::http::global_cleanup ();
    }

    /**
     * One exchange whose pre-request script fetches the oversized body, with
     * the exchange told to read at most @p bound - the value `POST /execute`
     * and the scenario runner each resolve from `maxDesignResponseBodyBytes`.
     */
    vayu::ScriptResult script_result (size_t bound, const std::string& expected) {
        vayu::runtime::ScriptConfig config;
        config.allow_send_request = true;
        vayu::runtime::ScriptEngine engine (config);
        vayu::http::CookieJar jar;
        vayu::http::routes::ScriptVariableScopes scopes;

        vayu::Request request;
        request.method = vayu::HttpMethod::GET;
        request.url    = server_->url ();

        vayu::http::routes::ExchangeInputs inputs;
        inputs.request  = std::move (request);
        inputs.elements = vayu::tests::step_elements_with_pre_script (
        fetch_expecting (server_->url (), expected));
        inputs.max_response_bytes = bound;
        return execute_exchange (engine, jar, "", scopes, std::move (inputs)).pre_script_result;
    }

    std::unique_ptr<BigBodyServer> server_;
};

// Mutation-check: drop `ctx.max_response_bytes = inputs.max_response_bytes`
// from `execute_exchange`'s bind and the script reads all 65536 bytes, because
// the context falls back to the compiled-in default.
TEST_F (ScriptSendRequestCapDesignTest, AScriptFetchIsRefusedPastTheExchangesBound) {
    const auto result = script_result (READ_BOUND, refusal_of (READ_BOUND));

    EXPECT_TRUE (result.success) << result.error_message;
}

// The other half of the rule: a bound is not a refusal to fetch. A body under
// it arrives whole, with no error and nothing cut - a test that only pinned the
// refusal would stay green with the bound wired to zero.
TEST_F (ScriptSendRequestCapDesignTest, AScriptFetchUnderTheBoundReadsTheWholeBody) {
    const auto result = script_result (SERVED_BYTES * 2, whole_read_of (SERVED_BYTES));

    EXPECT_TRUE (result.success) << result.error_message;
}

// ============================================================================
// The load path: the deferred `tests` replay
// ============================================================================

class ScriptSendRequestCapLoadTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_script_send_request_cap.db";
    static constexpr const char* RUN_ID  = "run-send-cap";

    void SetUp () override {
        vayu::http::global_init ();
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        server_ = std::make_unique<BigBodyServer> ();
    }

    void TearDown () override {
        server_.reset ();
        db_.reset ();
        cleanup ();
        vayu::http::global_cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// The run's byte bound, set the way the app sets it.
    void set_load_bound (size_t bytes) {
        auto [status, body] = vayu::http::routes::apply_config_update (*db_,
        R"({"entries":{"maxResponseBodyBytes":")" + std::to_string (bytes) + R"("}})");
        ASSERT_EQ (status, 200) << body.dump ();
    }

    /**
     * A single-request load run with one sampled response, whose `tests`
     * script fetches the oversized body. `allowScriptRequests` is what a run
     * started by a person carries and an agent-started one does not.
     */
    std::shared_ptr<vayu::core::RunContext> run_expecting (const std::string& expected) const {
        return run_with_script (fetch_expecting (server_->url (), expected));
    }

    /// The same run with @p script as its `tests` script and @p payload's
    /// members added to the run's payload.
    static std::shared_ptr<vayu::core::RunContext>
    run_with_script (const std::string& script, json payload = json::object ()) {
        payload["response_sample_rate"] = 1;
        payload["max_response_samples"] = 10;
        payload["allowScriptRequests"]  = true;
        auto context = std::make_shared<vayu::core::RunContext> (RUN_ID, payload);
        context->test_script = script;

        vayu::Response sample;
        sample.status_code     = 200;
        sample.status_text     = "OK";
        sample.body            = "{}";
        sample.timing.total_ms = 1.0;
        context->metrics_collector->record_response_sample (sample);
        return context;
    }

    /**
     * The scenario shape of the same run: one plan step whose own `tests`
     * script fetches the body. `validate_scripts` takes a different branch for
     * this one - `replay_scenario_steps`, which threads the bound per step -
     * so the single-request case above says nothing about it.
     */
    std::shared_ptr<vayu::core::RunContext> step_run_expecting (
    const std::string& expected) const {
        return step_run_with_script (fetch_expecting (server_->url (), expected));
    }

    /// The scenario shape with @p script as the step's `tests` script.
    std::shared_ptr<vayu::core::RunContext> step_run_with_script (
    const std::string& script) const {
        const json cfg = { { "response_sample_rate", 1 },
            { "max_response_samples", 10 }, { "allowScriptRequests", true } };
        auto context   = std::make_shared<vayu::core::RunContext> (RUN_ID, cfg);

        auto execution = std::make_shared<vayu::core::ScenarioExecution> ();
        execution->request.source        = "collection";
        execution->request.collection_id = "col_1";
        execution->request.iterations    = 1;

        vayu::core::ScenarioStep step;
        step.index    = 0;
        step.name     = "Fetch";
        step.elements = vayu::tests::step_elements_with_post_script (script);
        step.request.method = vayu::HttpMethod::GET;
        step.request.url    = server_->url ();
        execution->plan.steps.push_back (step);

        context->scenario = execution;
        context->metrics_collector->configure_step_samples ({ true });

        vayu::Response sample;
        sample.status_code     = 200;
        sample.status_text     = "OK";
        sample.body            = "{}";
        sample.timing.total_ms = 1.0;
        context->metrics_collector->record_step_response_sample (sample, 0,
        vayu::core::SampleIdentity{ /*iteration=*/0, /*vu=*/1,
        /*data_row_index=*/std::nullopt });
        return context;
    }

    /// A setting, set the way the app sets it.
    void set_config (const std::string& key, int value) {
        auto [status, body] = vayu::http::routes::apply_config_update (*db_,
        R"({"entries":{")" + key + R"(":")" + std::to_string (value) + R"("}})");
        ASSERT_EQ (status, 200) << body.dump ();
    }

    /// What the replay recorded, which is where the script's thrown sentence
    /// lands - empty when every replay passed.
    std::string recorded_failure () {
        const auto results = db_->get_results (RUN_ID);
        if (results.empty ()) {
            return "";
        }
        return results.back ().trace_data;
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::unique_ptr<BigBodyServer> server_;
};

// Mutation-check: drop `replay.send.apply (script_ctx)` from `run_replay`, or
// the bound's re-read in `validate_scripts`, and the fetch reads the whole
// 64 KiB, because the context falls back to the compiled-in default rather
// than to the run's own bound.
TEST_F (ScriptSendRequestCapLoadTest, AReplayedScriptTakesTheRunsLoadBound) {
    set_load_bound (READ_BOUND);

    const auto validation =
    vayu::core::validate_scripts (run_expecting (refusal_of (READ_BOUND)), *db_);

    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->sampled, 1u);
    EXPECT_EQ (validation.run->failed, 0u) << recorded_failure ();
}

// The scenario shape threads the bound through `replay_scenario_steps` rather
// than setting it on the one replay, so reverting that line alone would leave
// the case above green. Mutation-check it separately.
TEST_F (ScriptSendRequestCapLoadTest, AReplayedStepScriptTakesTheRunsLoadBound) {
    set_load_bound (READ_BOUND);

    const auto validation =
    vayu::core::validate_scripts (step_run_expecting (refusal_of (READ_BOUND)), *db_);

    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& step = validation.steps[0];
    ASSERT_HAS_VALUE (step);
    EXPECT_EQ (step->sampled, 1u);
    EXPECT_EQ (step->failed, 0u) << recorded_failure ();
}

TEST_F (ScriptSendRequestCapLoadTest, AReplayedScriptUnderTheBoundReadsTheWholeBody) {
    set_load_bound (SERVED_BYTES * 2);

    const auto validation =
    vayu::core::validate_scripts (run_expecting (whole_read_of (SERVED_BYTES)), *db_);

    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 0u) << recorded_failure ();
}

// ============================================================================
// The load path: the timeout a replayed script's fetch takes (issue #2833)
// ============================================================================

// The script throws with its fetch's outcome, so the recorded failure carries
// the deadline the fetch ran under. Healthy: about the run's timeout. Broken:
// the compiled-in 30 s clamped to the script's 5 s default budget, about
// 5,000 ms, which is also what bounds a broken build.
//
// Mutation-check: drop `replay.send.apply (script_ctx)` from `run_replay`, or
// `replay.send = script_send` on the single-request replay in
// `validate_scripts`, and the fetch reports about 5,000 ms.
TEST_F (ScriptSendRequestCapLoadTest, AReplayedScriptFetchTakesTheRunsTimeout) {
    const auto validation = vayu::core::validate_scripts (
    run_with_script (fetch_reporting (server_->hang_url ()), json{ { "timeout", 500 } }), *db_);

    ASSERT_HAS_VALUE (validation.run);
    ASSERT_EQ (validation.run->failed, 1u) << recorded_failure ();
    const std::string failure = recorded_failure ();
    const auto after_ms       = vayu::tests::timed_out_after_ms (failure);
    ASSERT_HAS_VALUE (after_ms) << failure;
    EXPECT_GE (*after_ms, 500) << failure;
    EXPECT_LT (*after_ms, 2500) << failure;
}

// The scenario shape threads the timeout through `replay_scenario_steps`, and
// with no `timeout` in the payload the run's timeout is the `defaultTimeout`
// setting (its floor is 1000). Mutation-check: drop `replay.send = send` in
// `replay_scenario_steps`.
TEST_F (ScriptSendRequestCapLoadTest, AReplayedStepScriptFetchTakesTheDefaultTimeoutSetting) {
    set_config ("defaultTimeout", 1000);

    const auto validation = vayu::core::validate_scripts (
    step_run_with_script (fetch_reporting (server_->hang_url ())), *db_);

    ASSERT_EQ (validation.steps.size (), 1u);
    const auto& step = validation.steps[0];
    ASSERT_HAS_VALUE (step);
    ASSERT_EQ (step->failed, 1u) << recorded_failure ();
    const std::string failure = recorded_failure ();
    const auto after_ms       = vayu::tests::timed_out_after_ms (failure);
    ASSERT_HAS_VALUE (after_ms) << failure;
    EXPECT_GE (*after_ms, 1000) << failure;
    EXPECT_LT (*after_ms, 2500) << failure;
}

// The replay's default headers are the run's own snapshot, taken by
// `configure_event_loop` (#2841); the correlation id is the header a bare
// policy leaves out. Mutation-check: drop `context->script_send.default_headers
// = loop_config.default_headers` from `configure_event_loop` and the report
// arrives without it.
TEST_F (ScriptSendRequestCapLoadTest, AReplayedScriptFetchCarriesTheRunsDefaultHeaders) {
    apply_setting (*db_, "correlationIdEnabled", "true");
    auto context =
    run_with_script (fetch_and_report (server_->ok_url (), server_->report_url ()));
    vayu::core::configure_event_loop (*db_, context->config, context,
    /*concurrency=*/1, /*timeout_ms=*/5000, /*configured_workers=*/1,
    /*default_max_per_host=*/1);

    const auto validation = vayu::core::validate_scripts (context, *db_);

    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 0u) << recorded_failure ();
    const auto reports = server_->reports ();
    ASSERT_EQ (reports.size (), 1u);
    EXPECT_FALSE (reports[0].correlation_id.empty ()) << reports[0].body;
}

// ============================================================================
// Every other load-run context that allows pm.sendRequest (issue #2841)
// ============================================================================

TEST (ScriptSendInputs, DefaultInputsChangeNothing) {
    const vayu::runtime::ScriptContext fresh;
    vayu::runtime::ScriptContext applied;
    vayu::runtime::ScriptSendInputs{}.apply (applied);

    EXPECT_EQ (applied.max_response_bytes, fresh.max_response_bytes);
    EXPECT_EQ (applied.request_timeout_ms, fresh.request_timeout_ms);
    EXPECT_EQ (applied.default_headers.user_agent, fresh.default_headers.user_agent);
    EXPECT_EQ (applied.default_headers.correlation_header,
    fresh.default_headers.correlation_header);
}

/**
 * Whole load runs through `RunManager::start_run`, so the inputs reach each
 * script from `configure_event_loop` the way production carries them: a
 * single-request run's `lifecycleElements` (`script.setup` / `.teardown`) and
 * `requestElements`, and a scenario step's own elements, each `script.*`
 * marked inline. Every script reports its fetch to `/report`, because a load
 * run stores no inline script's output.
 */
class ScriptSendRequestRunTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_script_send_request_run.db";
    static constexpr const char* RUN_ID  = "run-send-inputs";

    void SetUp () override {
        vayu::http::global_init ();
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        server_ = std::make_unique<BigBodyServer> ();
        // Pinned rather than read off the seed: the broken reading of every
        // timeout case below is this budget's clamp.
        apply_setting (*db_, "scriptTimeout", "5000");
    }

    void TearDown () override {
        manager_.shutdown ();
        server_.reset ();
        db_.reset ();
        cleanup ();
        vayu::http::global_cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// The payload both run shapes share: one submission, scripts allowed to
    /// send, and the run's own `timeout`.
    static json load_payload () {
        return { { "mode", "iterations" }, { "iterations", 1 }, { "concurrency", 1 },
            { "allowScriptRequests", true }, { "timeout", RUN_TIMEOUT_MS } };
    }

    /// A single-request run against `/ok` with @p elements' members (a
    /// `lifecycleElements` or `requestElements` array) added to its payload.
    void run_single_request (const json& elements) {
        json config      = load_payload ();
        config["method"] = "GET";
        config["url"]    = server_->ok_url ();
        config.update (elements);
        start_and_await (config, nullptr);
    }

    /// A one-step scenario run against `/ok` whose step carries @p element.
    void run_scenario_step (const json& element) {
        auto execution = std::make_shared<vayu::core::ScenarioExecution> ();
        execution->request.source        = "collection";
        execution->request.collection_id = "col_1";

        vayu::core::ScenarioStep step;
        step.index              = 0;
        step.request_id         = "req_1";
        step.name               = "Fetch";
        step.elements           = vayu::tests::compiled_elements ({ element });
        step.request.method     = vayu::HttpMethod::GET;
        step.request.url        = server_->ok_url ();
        step.request.timeout_ms = RUN_TIMEOUT_MS;
        step.stored_url         = step.request.url;
        execution->plan.steps.push_back (std::move (step));

        json config = load_payload ();
        config["scenario"] = { { "source", "collection" }, { "collectionId", "col_1" } };
        start_and_await (config, execution);
    }

    /// The fetch-and-report script as an inline element of @p kind.
    [[nodiscard]] json
    reporting_element (const std::string& kind, const std::string& url) const {
        return vayu::tests::script_element_json ("el_script", kind,
        fetch_and_report (url, server_->report_url ()), /*inline_script=*/true);
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::unique_ptr<BigBodyServer> server_;
    vayu::core::RunManager manager_;

    private:
    void start_and_await (const json& config,
    std::shared_ptr<const vayu::core::ScenarioExecution> execution) {
        vayu::db::Run run;
        run.id              = RUN_ID;
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = config.dump ();
        // A real stamp: a run dated 1970 is pruned the moment it finishes.
        run.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        run.end_time = run.start_time;
        db_->create_run (run);

        ASSERT_TRUE (manager_.start_run (RUN_ID, config, *db_, std::move (execution)));
        // `retain_run` is the worker's last act, after teardown.
        ASSERT_TRUE (vayu::tests::wait_until (
        [this] () { return manager_.get_run (RUN_ID) == nullptr; }))
        << "the run never finished";
    }
};

/**
 * The one report a run's script sent took the run's `timeout`. Healthy: about
 * `RUN_TIMEOUT_MS`. Broken: the compiled-in 30 s clamped to the 5 s script
 * budget, about 5,000 ms, which leaves the report itself almost no budget, so
 * a broken build reads as a missing report or a reading over the ceiling.
 */
void expect_run_timeout (const std::vector<Report>& reports) {
    ASSERT_EQ (reports.size (), 1u) << "the script's report never arrived";
    const auto after_ms = vayu::tests::timed_out_after_ms (reports[0].body);
    ASSERT_HAS_VALUE (after_ms) << reports[0].body;
    EXPECT_GE (*after_ms, RUN_TIMEOUT_MS) << reports[0].body;
    EXPECT_LT (*after_ms, RUN_TIMEOUT_CEILING_MS) << reports[0].body;
}

// Mutation-check: drop `context->script_send.apply (script_ctx)` from
// `run_collection_setup`'s `run_setup_script` (run_manager.cpp).
TEST_F (ScriptSendRequestRunTest, ASetupScriptFetchTakesTheRunsTimeout) {
    run_single_request ({ { "lifecycleElements",
    json::array ({ reporting_element ("script.setup", server_->hang_url ()) }) } });

    expect_run_timeout (server_->reports ());
}

// Mutation-check: drop the apply from `run_collection_teardown`'s
// `run_teardown_script`.
TEST_F (ScriptSendRequestRunTest, ATeardownScriptFetchTakesTheRunsTimeout) {
    run_single_request ({ { "lifecycleElements",
    json::array ({ reporting_element ("script.teardown", server_->hang_url ()) }) } });

    expect_run_timeout (server_->reports ());
}

// Mutation-check: drop the apply from `run_request_elements_step_before`
// (load_strategy.cpp).
TEST_F (ScriptSendRequestRunTest, AnInlineRequestPreScriptFetchTakesTheRunsTimeout) {
    run_single_request ({ { "requestElements",
    json::array ({ reporting_element ("script.pre", server_->hang_url ()) }) } });

    expect_run_timeout (server_->reports ());
}

// Mutation-check: drop the apply from `run_request_elements_after_submission`.
TEST_F (ScriptSendRequestRunTest, AnInlineRequestPostScriptFetchTakesTheRunsTimeout) {
    run_single_request ({ { "requestElements",
    json::array ({ reporting_element ("script.post", server_->hang_url ()) }) } });

    expect_run_timeout (server_->reports ());
}

// Mutation-check: drop the apply from `run_step_before` (scenario_load.cpp).
TEST_F (ScriptSendRequestRunTest, AnInlineStepPreScriptFetchTakesTheRunsTimeout) {
    run_scenario_step (reporting_element ("script.pre", server_->hang_url ()));

    expect_run_timeout (server_->reports ());
}

// Mutation-check: drop the apply from `run_step_after`.
TEST_F (ScriptSendRequestRunTest, AnInlineStepPostScriptFetchTakesTheRunsTimeout) {
    run_scenario_step (reporting_element ("script.post", server_->hang_url ()));

    expect_run_timeout (server_->reports ());
}

// The load bound reaches a lifecycle script as it reaches the replay. Broken:
// the compiled-in 32 MiB, so the fetch reads all 65536 bytes. Mutation-check:
// drop `context->script_send.max_response_bytes = ...` from
// `configure_event_loop`.
TEST_F (ScriptSendRequestRunTest, ASetupScriptFetchIsRefusedPastTheRunsLoadBound) {
    apply_setting (*db_, "maxResponseBodyBytes", std::to_string (READ_BOUND));

    run_single_request ({ { "lifecycleElements",
    json::array ({ reporting_element ("script.setup", server_->url ()) }) } });

    const auto reports = server_->reports ();
    ASSERT_EQ (reports.size (), 1u);
    EXPECT_NE (reports[0].body.find (refusal_of (READ_BOUND)), std::string::npos)
    << reports[0].body;
}

// The report is the script's own send, so it carries whatever header set the
// context was given. Mutation-check: drop the apply from `run_setup_script`
// and the correlation id is missing.
TEST_F (ScriptSendRequestRunTest, ASetupScriptFetchCarriesTheRunsDefaultHeaders) {
    apply_setting (*db_, "correlationIdEnabled", "true");

    run_single_request ({ { "lifecycleElements",
    json::array ({ reporting_element ("script.setup", server_->ok_url ()) }) } });

    const auto reports = server_->reports ();
    ASSERT_EQ (reports.size (), 1u);
    EXPECT_FALSE (reports[0].correlation_id.empty ()) << reports[0].body;
}

} // namespace
