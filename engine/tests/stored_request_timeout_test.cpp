/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/stored_request_timeout_test.cpp
 * @brief A stored request's own `timeout` on every path that sends it (#2937).
 *
 * Each case stores a request against `SlowMockServer`'s `/hang`, which never
 * answers, and sets the `defaultTimeout` setting far above the request's own
 * value. So a path that honours the request gives up near `OWN_TIMEOUT_MS`,
 * and one that drops it waits at least `SETTING_MS`: the bound between them is
 * the setting itself, which the broken reading can never come in under. The
 * lower bound cannot fail slow. Every path goes through the routes a client
 * uses - `POST /compose` by `requestId`, then `POST /execute` or `POST /runs`
 * - so the composer's emission and the plan's resolution are both on it.
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`; `url_scheme_test.cpp`
// carries the same guard for the same reason.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <chrono>
#include <cstdint>
#include <gtest/gtest.h>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <thread>
#include <utility>

#include <httplib.h>

#include "mock_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/types.hpp"
#include "wait_until.hpp"

namespace {

using nlohmann::json;
using Clock = std::chrono::steady_clock;

/// The request's own timeout, and the setting a path that drops it falls back
/// to. The gap is what a slow runner's overhead has to stay inside.
constexpr int OWN_TIMEOUT_MS = 1500;
constexpr int SETTING_MS     = 12000;

int64_t elapsed_ms (Clock::time_point since) {
    return std::chrono::duration_cast<std::chrono::milliseconds> (Clock::now () - since)
    .count ();
}

class StoredRequestTimeoutTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_stored_request_timeout.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        manager_ = std::make_unique<vayu::http::SseStreamManager> ();
        ctx_     = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, nullptr,
        authorize_manager_, cookie_jar_, mock_issuer_manager_, inbox_manager_,
        mock_server_manager_, *manager_, run_summary_cache_ });
        vayu::http::routes::register_compose_routes (*ctx_);
        vayu::http::routes::register_execution_routes (*ctx_);
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();

        set_default_timeout (SETTING_MS);
        vayu::db::Collection collection;
        collection.id    = "col_1";
        collection.name  = "C";
        collection.order = 0;
        db_->create_collection (collection);
    }

    void TearDown () override {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
        // A run's worker writes through the database until it is joined.
        run_manager_.shutdown ();
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    void set_default_timeout (int ms) const {
        auto setting = db_->get_config_entry ("defaultTimeout");
        ASSERT_HAS_VALUE (setting);
        setting->value = std::to_string (ms);
        db_->save_config_entry (*setting);
    }

    /// One stored request on `/hang`, with @p timeout_ms as its own timeout.
    void store_request (std::optional<int> timeout_ms) const {
        vayu::db::Request r;
        r.id            = "req_1";
        r.collection_id = "col_1";
        r.name          = "Hangs";
        r.url           = target_.hang_url ();
        r.timeout_ms    = timeout_ms;
        db_->save_request (r);
    }

    std::pair<int, json> post (const char* path, const json& payload) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (30, 0);
        auto response = client.Post (path, payload.dump (), "application/json");
        if (!response) {
            ADD_FAILURE () << "no response from POST " << path;
            return { 0, json::object () };
        }
        return { response->status, json::parse (response->body, nullptr, false) };
    }

    /// `POST /compose` by id: the payload a Send or a load run starts from.
    json composed () const {
        const auto [status, payload] =
        post ("/compose", json{ { "requestId", "req_1" } });
        EXPECT_EQ (status, 200) << payload.dump ();
        return payload;
    }

    /// Starts @p config and waits for its worker to let go of it; how long
    /// that took, from the start request.
    int64_t run_to_the_end (const json& config, std::string& run_id) {
        const auto started          = Clock::now ();
        const auto [status, answer] = post ("/runs", config);
        EXPECT_EQ (status, 202) << answer.dump ();
        run_id = answer.value ("runId", std::string ());
        EXPECT_TRUE (vayu::tests::wait_until (
        [&] () { return run_manager_.get_run (run_id) == nullptr; }))
        << "the run never finished";
        return elapsed_ms (started);
    }

    /// Every stored result of @p run_id failed without an answer.
    void expect_only_unanswered_results (const std::string& run_id) const {
        const auto results = db_->get_results (run_id);
        ASSERT_FALSE (results.empty ()) << "the run stored no result";
        for (const auto& result : results) {
            EXPECT_EQ (result.status_code, 0) << result.error;
            EXPECT_FALSE (result.error.empty ());
        }
    }

    vayu::tests::SlowMockServer target_;
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

} // namespace

// Send: compose by id, then execute what came back. Mutation check: drop the
// `timeout` emission in `payload_from_stored` and the send waits the setting.
TEST_F (StoredRequestTimeoutTest, ASendGivesUpAtTheRequestsOwnTimeout) {
    store_request (OWN_TIMEOUT_MS);
    const json payload = composed ();
    EXPECT_EQ (payload.value ("timeout", 0), OWN_TIMEOUT_MS) << payload.dump ();

    const auto started          = Clock::now ();
    const auto [status, answer] = post ("/execute", payload);
    const int64_t took          = elapsed_ms (started);
    EXPECT_EQ (status, 200) << answer.dump ();
    EXPECT_GE (took, OWN_TIMEOUT_MS);
    EXPECT_LT (took, SETTING_MS) << "the send waited for the setting";
    RecordProperty ("elapsed_ms", std::to_string (took));
}

// The other half: a request that states none composes no `timeout`, so the
// setting decides. Lowered to its floor so the case is quick: healthy reads
// about 1000 ms, and a composer that wrote the compiled-in 30000 in its place
// would read 30000, far past the 6000 bound between them.
TEST_F (StoredRequestTimeoutTest, ASendOfARequestWithNoTimeoutUsesTheSetting) {
    set_default_timeout (1000);
    store_request (std::nullopt);
    const json payload = composed ();
    ASSERT_FALSE (payload.contains ("timeout")) << payload.dump ();

    const auto started          = Clock::now ();
    const auto [status, answer] = post ("/execute", payload);
    const int64_t took          = elapsed_ms (started);
    EXPECT_EQ (status, 200) << answer.dump ();
    EXPECT_GE (took, 1000);
    EXPECT_LT (took, OWN_TIMEOUT_MS * 4) << "the send did not use the setting";
    RecordProperty ("elapsed_ms", std::to_string (took));
}

// A sequential collection run composes each step by id and then builds it
// with the run's timeout, which used to overwrite the step's own. Mutation
// check: build the step with `options.timeout_ms` again in `resolve_step` and
// the run waits the setting.
TEST_F (StoredRequestTimeoutTest, ASequentialCollectionRunGivesUpAtTheStepsOwnTimeout) {
    store_request (OWN_TIMEOUT_MS);
    std::string run_id;
    const int64_t took = run_to_the_end (
    json{ { "scenario", { { "source", "collection" }, { "collectionId", "col_1" } } } }, run_id);
    EXPECT_GE (took, OWN_TIMEOUT_MS);
    EXPECT_LT (took, SETTING_MS) << "the step waited for the setting";
    expect_only_unanswered_results (run_id);
    // The resolved value is the step's, never the run's: nothing is baked
    // into what the run stored about its own config.
    const auto run = db_->get_run (run_id);
    ASSERT_HAS_VALUE (run);
    EXPECT_FALSE (json::parse (run->config_snapshot).contains ("timeout"))
    << run->config_snapshot;
    RecordProperty ("elapsed_ms", std::to_string (took));
}

// The same plan drives a scenario load run, whose event loop applies each
// step's own built timeout per submission. Same mutation check as above.
TEST_F (StoredRequestTimeoutTest, AScenarioLoadStepGivesUpAtTheStepsOwnTimeout) {
    store_request (OWN_TIMEOUT_MS);
    std::string run_id;
    const int64_t took = run_to_the_end (
    json{ { "scenario", { { "source", "collection" }, { "collectionId", "col_1" } } },
    { "mode", "iterations" }, { "iterations", 1 }, { "concurrency", 1 } },
    run_id);
    EXPECT_GE (took, OWN_TIMEOUT_MS);
    EXPECT_LT (took, SETTING_MS) << "the step waited for the setting";
    const auto run = db_->get_run (run_id);
    ASSERT_HAS_VALUE (run);
    EXPECT_FALSE (json::parse (run->config_snapshot).contains ("timeout"))
    << run->config_snapshot;
    RecordProperty ("elapsed_ms", std::to_string (took));
}

// A single-request load run starts from the composed payload, which carries
// the request's own `timeout` as the run's. Same mutation check as the Send.
TEST_F (StoredRequestTimeoutTest, ASingleRequestLoadRunGivesUpAtTheRequestsOwnTimeout) {
    store_request (OWN_TIMEOUT_MS);
    json config           = composed ();
    config["mode"]        = "iterations";
    config["iterations"]  = 2;
    config["concurrency"] = 2;
    std::string run_id;
    const int64_t took = run_to_the_end (config, run_id);
    EXPECT_GE (took, OWN_TIMEOUT_MS);
    EXPECT_LT (took, SETTING_MS) << "the run waited for the setting";
    expect_only_unanswered_results (run_id);
    RecordProperty ("elapsed_ms", std::to_string (took));
}
