/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/request_body_depth_test.cpp
 * @brief The body-depth bound (#2417) on the resource routes that parse their
 *        body through `parse_request_json`: `POST`/`PUT` on `/collections`
 *        and `/requests`, `POST /specs` and `POST /specs/diff`.
 *
 * `POST /runs` and `POST /execute` are held in run_config_validation_test.cpp.
 * Driven through the registered handlers, because the parse lives in the
 * handler and not in the testable core it hands the tree to.
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`; `url_scheme_test.cpp`
// carries the same guard for the same reason.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <array>
#include <cstddef>
#include <memory>
#include <string>
#include <thread>
#include <utility>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "nested_json.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"

namespace {

using nlohmann::json;

constexpr std::size_t kBodyDepthBound = vayu::core::constants::request_body::MAX_JSON_DEPTH;

/// Deep enough that a recursive `dump ()` overflows the stack (#2362).
constexpr std::size_t kCrashingDepth = 100000;

const std::string& body_depth_message () {
    static const std::string message = "request body is nested deeper than " +
    std::to_string (kBodyDepthBound) + " levels";
    return message;
}

std::string error_code_of (const json& body) {
    const auto error = body.find ("error");
    if (error == body.end () || !error->is_object ()) {
        return {};
    }
    return error->value ("code", std::string ());
}

class RequestBodyDepthRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_request_body_depth_route.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        manager_ = std::make_unique<vayu::http::SseStreamManager> ();
        ctx_     = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, nullptr,
        authorize_manager_, cookie_jar_, mock_issuer_manager_, inbox_manager_,
        mock_server_manager_, *manager_, run_summary_cache_ });
        vayu::http::routes::register_collection_routes (*ctx_);
        vayu::http::routes::register_request_routes (*ctx_);
        vayu::http::routes::register_spec_routes (*ctx_);
        vayu::http::routes::register_spec_diff_routes (*ctx_);
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
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// The status and body @p method on @p path answered @p body with. The
    /// body is JSON text already: a value nested past what `dump ()`
    /// survives cannot be built as a `json` and sent.
    std::pair<int, json> send_text (const std::string& method,
    const std::string& path,
    const std::string& body) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = method == "PUT" ?
        client.Put (path, body, "application/json") :
        client.Post (path, body, "application/json");
        if (!response) {
            ADD_FAILURE () << "no response from " << method << " " << path;
            return { 0, json::object () };
        }
        return { response->status, json::parse (response->body, nullptr, false) };
    }

    /// The id of a row a `POST` to @p path created from @p payload.
    std::string create (const std::string& path, const json& payload) const {
        const auto [status, body] = send_text ("POST", path, payload.dump ());
        EXPECT_EQ (status, 200) << path << ": " << body.dump ();
        return body.value ("id", std::string ());
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

struct BodyCase {
    std::string method;
    std::string path;
    std::string body;
};

} // namespace

// The collection and request cases put the deep value in `auth`, which the
// applier dumps for storage, so unbounded they crash the engine; the spec cases
// put it in a field the core only type-checks, so unbounded they answer the
// core's own 400. Mutation check: drop the `exceeds_depth` check in
// `parse_request_json` and the test binary crashes on the first case.
TEST_F (RequestBodyDepthRouteTest, ADeepValueIsRefusedOnEveryRouteBeforeAnythingIsWritten) {
    const std::string collection_id = create ("/collections", { { "name", "c" } });
    const std::string request_id = create ("/requests",
    { { "collectionId", collection_id }, { "name", "r" }, { "method", "GET" },
    { "url", "http://x.test/" } });
    ASSERT_FALSE (collection_id.empty ());
    ASSERT_FALSE (request_id.empty ());

    const std::string deep = vayu::tests::nested_array_text (kCrashingDepth);
    const std::string deep_auth = R"("auth":{"a":)" + deep + "}";
    const auto cases            = std::to_array<BodyCase> ({
    { "POST", "/collections", R"({"name":"planted",)" + deep_auth + "}" },
    { "PUT", "/collections/" + collection_id, "{" + deep_auth + "}" },
    { "POST", "/requests",
               R"({"collectionId":")" + collection_id +
               R"(","name":"planted","method":"GET","url":"http://x.test/",)" + deep_auth + "}" },
    { "PUT", "/requests/" + request_id, "{" + deep_auth + "}" },
    { "POST", "/specs", R"({"content":"openapi: 3.0.0","sourceUrl":)" + deep + "}" },
    { "POST", "/specs/diff",
               R"({"collectionId":")" + collection_id + R"(","spec":{"content":)" + deep + "}}" },
    });
    for (const auto& [method, path, body] : cases) {
        const auto [status, answer] = send_text (method, path, body);
        EXPECT_EQ (status, 400) << method << " " << path << ": " << answer.dump ();
        EXPECT_EQ (error_code_of (answer), "bad_request") << method << " " << path;
        EXPECT_EQ (vayu::http::routes::error_message_of (answer), body_depth_message ())
        << method << " " << path;
    }

    EXPECT_EQ (db_->get_collections ().size (), 1U);
    EXPECT_EQ (db_->get_requests_in_collection (collection_id).size (), 1U);
    const auto collection = db_->get_collection (collection_id);
    ASSERT_HAS_VALUE (collection);
    EXPECT_EQ (collection->auth, R"({"mode":"none"})");

    // And the engine is still answering.
    EXPECT_FALSE (create ("/collections", { { "name", "after" } }).empty ());
}

// A value nested to the bound is an ordinary payload: the body object, `auth`,
// then `kBodyDepthBound - 2` arrays.
TEST_F (RequestBodyDepthRouteTest, AValueAtTheBoundIsStored) {
    const std::string at_bound = vayu::tests::nested_array_text (kBodyDepthBound - 2);
    const auto [status, body] = send_text (
    "POST", "/collections", R"({"name":"c","auth":{"a":)" + at_bound + "}}");
    EXPECT_EQ (status, 200) << body.dump ();
}

// A parse error quotes the byte it stopped at, and a byte that is not UTF-8
// makes a strict dump of the refusal throw. Mutation check: dump without
// `replace` in `refuse_request_body` and every case answers the dump's own
// `type_error.316` in place of the parse error.
TEST_F (RequestBodyDepthRouteTest, TextThatIsNotJsonIsA400OnEveryRouteWhateverItsBytes) {
    const std::string collection_id = create ("/collections", { { "name", "c" } });
    ASSERT_FALSE (collection_id.empty ());
    const auto routes = std::to_array<std::pair<std::string, std::string>> ({
    { "POST", "/collections" },
    { "PUT", "/collections/" + collection_id },
    { "POST", "/requests" },
    { "PUT", "/requests/missing" },
    { "POST", "/specs" },
    { "POST", "/specs/diff" },
    });
    for (const auto& [method, path] : routes) {
        const auto [status, body] = send_text (method, path, "{\"a\":\xff}");
        EXPECT_EQ (status, 400) << method << " " << path;
        EXPECT_EQ (error_code_of (body), "bad_request") << method << " " << path;
        EXPECT_EQ (
        vayu::http::routes::error_message_of (body).rfind ("Invalid JSON: ", 0), 0U)
        << method << " " << path << ": " << body.dump ();
    }
}
