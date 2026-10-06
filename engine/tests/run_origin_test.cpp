/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_origin_test.cpp
 * @brief Who started a run (#1817): `read_run_origin`'s rules, and the two
 *        routes that create a run row storing what it read.
 *
 * The list filter and both serializers are held in runs_route_test.cpp beside
 * the rest of `GET /runs`; a row stored before the columns existed is held in
 * db_test.cpp with the other schema-version cases.
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
#include <utility>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "optional_assert.hpp"
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
using vayu::http::routes::read_run_origin;

json with_origin (const json& origin) {
    return json{ { "method", "GET" }, { "url", "http://x.test/" }, { "origin", origin } };
}

std::string refusal_of (const json& origin) {
    const auto read = read_run_origin (with_origin (origin));
    if (read) {
        ADD_FAILURE () << "accepted: " << origin.dump ();
        return {};
    }
    return read.error ();
}

/// The message of an error body, or `""` for any other body - read without
/// indexing, so an unexpected 200 fails the assertion instead of the process.
std::string error_message_of (const json& body) {
    const auto error = body.find ("error");
    if (error == body.end () || !error->is_object ()) {
        return {};
    }
    return error->value ("message", std::string ());
}

// ============================================================================
// read_run_origin
// ============================================================================

TEST (RunOriginReader, AnAbsentOrNullOriginIsOtherWithNoClient) {
    for (const auto& payload : { json{ { "method", "GET" } }, with_origin (nullptr) }) {
        const auto origin = read_run_origin (payload);
        ASSERT_TRUE (origin) << origin.error ();
        EXPECT_EQ (origin->kind, "other") << payload.dump ();
        EXPECT_FALSE (origin->client.has_value ()) << payload.dump ();
    }
}

TEST (RunOriginReader, EveryDeclaredKindIsAccepted) {
    for (const auto kind : vayu::http::routes::RUN_ORIGIN_KINDS) {
        const auto origin = read_run_origin (with_origin ({ { "kind", kind } }));
        ASSERT_TRUE (origin) << kind << ": " << origin.error ();
        EXPECT_EQ (origin->kind, kind);
    }
}

TEST (RunOriginReader, AnOriginThatIsNotAnObjectIsRefusedNamingTheField) {
    for (const auto& bad :
    { json ("mcp"), json (1), json::array ({ "mcp" }), json (true) }) {
        EXPECT_NE (refusal_of (bad).find ("'origin' must be an object"), std::string::npos)
        << bad.dump ();
    }
}

// The message lists the kinds, so a caller fixing a typo reads the answer off
// it; the loop keeps that list and RUN_ORIGIN_KINDS from drifting apart.
TEST (RunOriginReader, AKindOutsideTheSetIsRefusedNamingTheFieldAndTheKinds) {
    for (const auto& bad : { json{ { "kind", "browser" } }, json{ { "kind", "MCP" } },
         json{ { "kind", 1 } }, json{ { "kind", nullptr } }, json::object (),
         json{ { "client", "Claude Code" } } }) {
        const auto message = refusal_of (bad);
        EXPECT_NE (message.find ("'origin.kind'"), std::string::npos) << bad.dump ();
        for (const auto kind : vayu::http::routes::RUN_ORIGIN_KINDS) {
            EXPECT_NE (message.find (kind), std::string::npos) << message;
        }
    }
}

TEST (RunOriginReader, ANonStringClientIsRefusedWhateverTheKind) {
    for (const char* kind : { "mcp", "app" }) {
        for (const auto& bad : { json (7), json::object (), json::array () }) {
            EXPECT_NE (refusal_of ({ { "kind", kind }, { "client", bad } }).find ("'origin.client'"),
            std::string::npos)
            << kind << " " << bad.dump ();
        }
    }
}

TEST (RunOriginReader, AClientIsKeptForMcpExactlyAsSent) {
    const auto origin = read_run_origin (
    with_origin ({ { "kind", "mcp" }, { "client", "claude-code" } }));
    ASSERT_TRUE (origin) << origin.error ();
    const auto& origin_client = origin->client;
    ASSERT_HAS_VALUE (origin_client);
    EXPECT_EQ (*origin_client, "claude-code");
}

TEST (RunOriginReader, AClientIsDroppedForEveryKindButMcp) {
    for (const char* kind : { "app", "other" }) {
        const auto origin =
        read_run_origin (with_origin ({ { "kind", kind }, { "client", "Cursor" } }));
        ASSERT_TRUE (origin) << origin.error ();
        EXPECT_FALSE (origin->client.has_value ()) << kind;
    }
}

TEST (RunOriginReader, AnMcpClientIsTrimmedAndABlankOneIsNoClient) {
    const auto padded = read_run_origin (
    with_origin ({ { "kind", "mcp" }, { "client", " \tClaude Code\n " } }));
    ASSERT_TRUE (padded) << padded.error ();
    const auto& padded_client = padded->client;
    ASSERT_HAS_VALUE (padded_client);
    EXPECT_EQ (*padded_client, "Claude Code");

    for (const char* blank : { "", "   ", "\t\n" }) {
        const auto origin =
        read_run_origin (with_origin ({ { "kind", "mcp" }, { "client", blank } }));
        ASSERT_TRUE (origin) << origin.error ();
        EXPECT_FALSE (origin->client.has_value ()) << "'" << blank << "'";
    }
}

// Counted in characters, so a name of two-byte characters keeps 128 of them
// (256 bytes) and the cut never leaves half a sequence behind.
TEST (RunOriginReader, AnMcpClientIsCutToTheCapOnACharacterBoundary) {
    const std::size_t cap = vayu::http::routes::MAX_RUN_ORIGIN_CLIENT_CHARS;
    std::string accented;
    for (std::size_t i = 0; i < cap + 10; ++i) {
        accented += "\xC3\xA9"; // U+00E9
    }
    const auto origin =
    read_run_origin (with_origin ({ { "kind", "mcp" }, { "client", accented } }));
    ASSERT_TRUE (origin) << origin.error ();
    const auto& origin_client = origin->client;
    ASSERT_HAS_VALUE (origin_client);
    EXPECT_EQ (*origin_client, accented.substr (0, cap * 2));

    const std::string at_cap (cap, 'a');
    const auto exact =
    read_run_origin (with_origin ({ { "kind", "mcp" }, { "client", at_cap } }));
    ASSERT_TRUE (exact) << exact.error ();
    const auto& exact_client = exact->client;
    ASSERT_HAS_VALUE (exact_client);
    EXPECT_EQ (*exact_client, at_cap);
}

// ============================================================================
// POST /execute and POST /runs, through the real handlers
// ============================================================================

class RunOriginRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_run_origin_route.db";

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
        // A load run's worker writes through the database until it is joined.
        run_manager_.shutdown ();
        manager_.reset ();
        ctx_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// The status and body @p path answered @p payload with.
    std::pair<int, json> post (const char* path, const json& payload) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post (path, payload.dump (), "application/json");
        if (!response) {
            ADD_FAILURE () << "no response from " << path;
            return { 0, json::object () };
        }
        return { response->status, json::parse (response->body, nullptr, false) };
    }

    /// The one run row the database holds, or an empty run after a failure.
    vayu::db::Run only_run () const {
        const auto runs = db_->get_all_runs ();
        EXPECT_EQ (runs.size (), 1U);
        return runs.empty () ? vayu::db::Run{} : runs.front ();
    }

    json send_to (const vayu::tests::EchoServer& echo) const {
        return json{ { "method", "GET" }, { "url", echo.url () } };
    }

    json load_of (const vayu::tests::EchoServer& echo) const {
        auto payload           = send_to (echo);
        payload["iterations"]  = 1;
        payload["concurrency"] = 1;
        return payload;
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

TEST_F (RunOriginRouteTest, ExecuteStoresTheOriginItWasSent) {
    const vayu::tests::EchoServer echo;
    auto payload      = send_to (echo);
    payload["origin"] = { { "kind", "mcp" }, { "client", "  Claude Code  " } };
    const auto [status, body] = post ("/execute", payload);
    ASSERT_EQ (status, 200) << body.dump ();

    const auto run = only_run ();
    EXPECT_EQ (run.origin, "mcp");
    ASSERT_HAS_VALUE (run.origin_client);
    EXPECT_EQ (*run.origin_client, "Claude Code");
    // The row's columns are the one record; the snapshot does not keep a copy
    // that could disagree with them.
    EXPECT_FALSE (json::parse (run.config_snapshot).contains ("origin")) << run.config_snapshot;
}

TEST_F (RunOriginRouteTest, ExecuteWithNoOriginStoresOtherAndNoClient) {
    const vayu::tests::EchoServer echo;
    const auto [status, body] = post ("/execute", send_to (echo));
    ASSERT_EQ (status, 200) << body.dump ();

    const auto run = only_run ();
    EXPECT_EQ (run.origin, "other");
    EXPECT_FALSE (run.origin_client.has_value ());
}

TEST_F (RunOriginRouteTest, ExecuteDropsTheClientOfAnAppOrigin) {
    const vayu::tests::EchoServer echo;
    auto payload              = send_to (echo);
    payload["origin"]         = { { "kind", "app" }, { "client", "Cursor" } };
    const auto [status, body] = post ("/execute", payload);
    ASSERT_EQ (status, 200) << body.dump ();

    const auto run = only_run ();
    EXPECT_EQ (run.origin, "app");
    EXPECT_FALSE (run.origin_client.has_value ());
}

TEST_F (RunOriginRouteTest, ExecuteRefusesAnUnknownKindBeforeAnyRowOrSend) {
    const vayu::tests::EchoServer echo;
    auto payload              = send_to (echo);
    payload["origin"]         = { { "kind", "browser" } };
    const auto [status, body] = post ("/execute", payload);

    EXPECT_EQ (status, 400);
    EXPECT_NE (error_message_of (body).find ("'origin.kind'"), std::string::npos)
    << body.dump ();
    EXPECT_TRUE (db_->get_all_runs ().empty ());
    EXPECT_TRUE (echo.method ().empty ()) << "the request was sent";
}

TEST_F (RunOriginRouteTest, LoadRunStoresTheOriginItWasSent) {
    const vayu::tests::EchoServer echo;
    auto payload              = load_of (echo);
    payload["origin"]         = { { "kind", "mcp" }, { "client", "cursor" } };
    const auto [status, body] = post ("/runs", payload);
    ASSERT_EQ (status, 202) << body.dump ();

    const auto run = only_run ();
    EXPECT_EQ (run.origin, "mcp");
    ASSERT_HAS_VALUE (run.origin_client);
    EXPECT_EQ (*run.origin_client, "cursor");
    EXPECT_FALSE (json::parse (run.config_snapshot).contains ("origin")) << run.config_snapshot;
}

TEST_F (RunOriginRouteTest, LoadRunWithNoOriginStoresOtherAndNoClient) {
    const vayu::tests::EchoServer echo;
    const auto [status, body] = post ("/runs", load_of (echo));
    ASSERT_EQ (status, 202) << body.dump ();

    const auto run = only_run ();
    EXPECT_EQ (run.origin, "other");
    EXPECT_FALSE (run.origin_client.has_value ());
}

TEST_F (RunOriginRouteTest, LoadRunRefusesAMalformedOriginBeforeAnyRow) {
    const vayu::tests::EchoServer echo;
    for (const auto& bad : { json{ { "kind", "browser" } }, json ("mcp"),
         json{ { "kind", "mcp" }, { "client", 3 } } }) {
        auto payload              = load_of (echo);
        payload["origin"]         = bad;
        const auto [status, body] = post ("/runs", payload);
        EXPECT_EQ (status, 400) << bad.dump ();
        EXPECT_NE (error_message_of (body).find ("'origin"), std::string::npos)
        << body.dump ();
    }
    EXPECT_TRUE (db_->get_all_runs ().empty ());
}

} // namespace
