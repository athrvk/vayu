/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/script_send_request_cap_test.cpp
 * @brief The bound a script's own fetch reads under (issue #1188).
 *
 * `pm.sendRequest` builds its own `ClientConfig`, so nothing the enclosing
 * exchange sets on its send reaches it by default - which is how it stayed the
 * one read with no byte bound at all after issue #1157 bounded every other
 * one. The failure mode is silent in exactly the way `design_read_cap_test.cpp`
 * describes: a caller that forgets to carry the bound down reads to the end of
 * whatever the script fetched, and every unit test on either side of the gap
 * still passes.
 *
 * So these drive the two production paths rather than the sandbox: an exchange
 * (`POST /execute` and every collection-run step) and the deferred `tests` pass
 * of a load run. Which *setting* each path resolves is
 * `config_route_test.cpp`'s `design_response_body_bound` /
 * `load_response_body_bound` cases; what is under test here is that the value
 * reaches the script's transfer at all.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <memory>
#include <string>
#include <thread>
#include <utility>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

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

/// Serves one oversized body at `/big`, for a script to fetch.
class BigBodyServer {
    public:
    BigBodyServer () {
        // Two threads: one fetch per replayed sample, never concurrent.
        svr_.new_task_queue = vayu::tests::pooled_task_queue (2);
        svr_.Get ("/big", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (std::string (SERVED_BYTES, 'x'), "text/plain");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~BigBodyServer () {
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

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
};

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
        inputs.request            = std::move (request);
        inputs.pre_script         = fetch_expecting (server_->url (), expected);
        inputs.max_response_bytes = bound;
        return execute_exchange (engine, jar, "", scopes, std::move (inputs), false)
        .pre_script_result;
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
        const json cfg = { { "response_sample_rate", 1 },
            { "max_response_samples", 10 }, { "allowScriptRequests", true } };
        auto context   = std::make_shared<vayu::core::RunContext> (RUN_ID, cfg);
        context->test_script = fetch_expecting (server_->url (), expected);

        vayu::Response sample;
        sample.status_code     = 200;
        sample.status_text     = "OK";
        sample.body            = "{}";
        sample.timing.total_ms = 1.0;
        context->metrics_collector->record_response_sample (sample);
        return context;
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

// Mutation-check: drop `script_ctx.max_response_bytes = replay.max_response_bytes`
// from `run_replay` and the fetch reads the whole 64 KiB, because the context
// falls back to the compiled-in default rather than to the run's own bound.
TEST_F (ScriptSendRequestCapLoadTest, AReplayedScriptTakesTheRunsLoadBound) {
    set_load_bound (READ_BOUND);

    const auto validation = vayu::core::validate_scripts (
    run_expecting (refusal_of (READ_BOUND)), *db_, false);

    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->sampled, 1u);
    EXPECT_EQ (validation.run->failed, 0u) << recorded_failure ();
}

TEST_F (ScriptSendRequestCapLoadTest, AReplayedScriptUnderTheBoundReadsTheWholeBody) {
    set_load_bound (SERVED_BYTES * 2);

    const auto validation = vayu::core::validate_scripts (
    run_expecting (whole_read_of (SERVED_BYTES)), *db_, false);

    ASSERT_HAS_VALUE (validation.run);
    EXPECT_EQ (validation.run->failed, 0u) << recorded_failure ();
}

} // namespace
