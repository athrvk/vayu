/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/config_snapshot_test.cpp
 * @brief A design run's stored `config_snapshot` withholds the composed
 *        request's credentials (#1803).
 *
 * `request_builder_test.cpp` holds `sanitize_config_snapshot` to its rules on
 * a payload it builds by hand. This file holds the route to them: the real
 * `POST /execute` handler, with the secret values read from the scopes the
 * payload names - an environment and the collection of the request it links -
 * and the run row read back out of the database.
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`; `url_scheme_test.cpp`
// carries the same guard for the same reason.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <memory>
#include <string>
#include <thread>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/types.hpp"

namespace {

using nlohmann::json;

constexpr const char* ENV_SECRET        = "env-secret-7f3a";
constexpr const char* COLLECTION_SECRET = "collection-secret-91c2";

class ConfigSnapshotExecuteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_config_snapshot_execute.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        seed_scopes ();
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
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    // An environment and a collection, each holding one secret variable and
    // one plain one, and a request filed in the collection.
    void seed_scopes () {
        vayu::db::Environment env;
        env.id        = "env_1";
        env.name      = "Prod";
        env.variables = json{
            { "token", { { "value", ENV_SECRET }, { "secret", true } } },
            { "host", { { "value", "api.example.com" } } }
        }.dump ();
        db_->save_environment (env);

        vayu::db::Collection collection;
        collection.id        = "col_1";
        collection.name      = "API";
        collection.variables = json{
            { "signing", { { "value", COLLECTION_SECRET }, { "secret", true } } },
            { "region", { { "value", "eu-west-1" } } }
        }.dump ();
        collection.auth = "{}";
        db_->create_collection (collection);

        vayu::db::Request request;
        request.id            = "req_1";
        request.collection_id = "col_1";
        request.name          = "Create item";
        request.method        = vayu::HttpMethod::POST;
        request.url           = "{{host}}/items";
        request.params        = "[]";
        request.headers       = "[]";
        request.body          = R"({"mode":"none"})";
        request.body_type     = "none";
        request.auth          = R"({"mode":"none"})";
        db_->save_request (request);
    }

    void execute (const json& payload) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post ("/execute", payload.dump (), "application/json");
        ASSERT_TRUE (response);
        EXPECT_EQ (response->status, 200) << response->body;
    }

    /// The one run the send recorded, or an empty snapshot after a failure.
    std::string stored_snapshot () const {
        const auto runs = db_->get_all_runs ();
        EXPECT_EQ (runs.size (), 1U);
        return runs.empty () ? std::string () : runs.front ().config_snapshot;
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

// What a Send of `Authorization: Bearer {{token}}` reaches `/execute` as: the
// composed payload, every variable already a value.
TEST_F (ConfigSnapshotExecuteTest, ADesignRunsSnapshotHoldsNoComposedCredential) {
    const vayu::tests::EchoServer echo;
    const std::string env_secret        = ENV_SECRET;
    const std::string collection_secret = COLLECTION_SECRET;
    execute ({ { "method", "POST" }, { "url", echo.url () + "?sig=" + collection_secret },
    { "headers",
    { { "Authorization", "Bearer " + env_secret },
    { "Content-Type", "application/json" }, { "X-Region", "eu-west-1" } } },
    { "body",
    { { "mode", "json" },
    { "content", json{ { "token", env_secret }, { "n", 1 } }.dump () } } },
    { "requestId", "req_1" }, { "environmentId", "env_1" } });

    // The send itself carried the credential: the snapshot is not withholding
    // something that was never there.
    EXPECT_EQ (echo.header ("Authorization"), "Bearer " + env_secret);

    const std::string snapshot = stored_snapshot ();
    ASSERT_FALSE (snapshot.empty ());
    EXPECT_EQ (snapshot.find (env_secret), std::string::npos) << snapshot;
    EXPECT_EQ (snapshot.find (collection_secret), std::string::npos) << snapshot;

    const auto parsed = json::parse (snapshot);
    EXPECT_EQ (parsed["headers"]["Authorization"], "<redacted>");
    EXPECT_EQ (parsed["headers"]["Content-Type"], "application/json");
    EXPECT_EQ (parsed["headers"]["X-Region"], "eu-west-1");
    EXPECT_EQ (parsed["url"], echo.url () + "?sig=<redacted>");
    EXPECT_EQ (json::parse (parsed["body"]["content"].get<std::string> ()),
    (json{ { "token", "<redacted>" }, { "n", 1 } }));
}

} // namespace
