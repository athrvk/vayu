/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/inline_collection_scope_test.cpp
 * @brief An inline request composed with a `collectionId` keeps that scope
 *        through `POST /execute` and `POST /runs` (#3461).
 *
 * A client that composes a request inline with a `collectionId` and links no
 * saved request (MCP `run_request` ad hoc) spreads the composed answer into
 * the send. A request a pre-request script runs before composes with the
 * scope's names written (`deferredVariables`, #2521), so the send has to answer
 * them, and hand its scripts the same chain, from the `collectionId` the
 * composed answer carries. Driven the way the clients drive it: compose,
 * spread, and read what the echo server received.
 *
 * Mutation checks for the file: make `scope_collection_id`
 * (request_exchange.cpp) ignore its `collection_id`, and every inline case
 * sends the names unresolved and reads `undefined`; drop the `collectionId`
 * emit from `compose_request_core` (request_composer.cpp), and the composed
 * answers carry none, so the same cases fail the same way.
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`; `url_scheme_test.cpp`
// carries the same guard for the same reason.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <atomic>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <utility>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/types.hpp"
#include "wait_until.hpp"

namespace {

using nlohmann::json;

constexpr const char* ENV_ID        = "env_1";
constexpr const char* ROOT_SECRET   = "root-secret-7c41";
constexpr const char* SCOPED_URL_QS = "?c={{c_str}}&s={{c_sub}}&e={{e_str}}";

/// A `script.pre` element running @p script, inline under a load run when
/// @p inline_under_load.
json pre_script (const std::string& script, bool inline_under_load = false) {
    json config = { { "script", script } };
    if (inline_under_load) {
        config["inline"] = true;
    }
    return json::array ({ { { "id", "el_pre" }, { "kind", "script.pre" },
    { "enabled", true }, { "config", std::move (config) } } });
}

/// What a script that reports the collection scope it sees writes: the two
/// chain values and the names `toObject` lists, `|`-joined into `X-Seen`.
constexpr const char* REPORT_SCOPE =
"pm.request.headers.add({ key: 'X-Seen', value: ["
"  String(pm.collectionVariables.get('c_str')),"
"  String(pm.collectionVariables.get('c_sub')),"
"  Object.keys(pm.collectionVariables.toObject()).sort().join(',')"
"].join('|') });";

class InlineCollectionScopeTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_inline_collection_scope.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        seed ();
        manager_ = std::make_unique<vayu::http::SseStreamManager> ();
        ctx_     = std::make_unique<vayu::http::routes::RouteContext> (
        vayu::http::routes::RouteContext{ svr_, *db_, run_manager_, nullptr, authorize_manager_,
        cookie_jar_, mock_issuer_manager_, inbox_manager_, mock_server_manager_, *manager_,
        run_summary_cache_, vayu::http::no_grant_secret (), server_stopping_ });
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

    /// `col_root` (`c_str`, the secret `c_secret`) over `col_sub` (`c_sub`),
    /// and beside them `col_other` holding `req_other`; `env_1` holds `e_str`.
    void seed () const {
        add_collection ("col_root", std::nullopt,
        json{ { "c_str", { { "value", "colval" }, { "enabled", true } } },
        { "c_secret", { { "value", ROOT_SECRET }, { "enabled", true }, { "secret", true } } } });
        add_collection ("col_sub", "col_root",
        json{ { "c_sub", { { "value", "subval" }, { "enabled", true } } } });
        add_collection ("col_other", std::nullopt,
        json{ { "c_str", { { "value", "otherval" }, { "enabled", true } } } });

        vayu::db::Request request;
        request.id            = "req_other";
        request.collection_id = "col_other";
        request.name          = "Other";
        request.method        = vayu::HttpMethod::GET;
        request.url           = "https://unused.test";
        request.auth          = R"({"mode":"noauth"})";
        request.created_at    = 1;
        request.updated_at    = 1;
        db_->save_request (request);

        vayu::db::Environment env;
        env.id   = ENV_ID;
        env.name = "Env";
        env.variables =
        json{ { "e_str", { { "value", "envval" }, { "enabled", true } } } }.dump ();
        env.created_at = 1;
        env.updated_at = 1;
        db_->save_environment (env);
    }

    void add_collection (const std::string& id,
    std::optional<std::string> parent,
    const json& variables) const {
        vayu::db::Collection collection;
        collection.id         = id;
        collection.name       = id;
        collection.parent_id  = std::move (parent);
        collection.variables  = variables.dump ();
        collection.auth       = "{}";
        collection.created_at = 1;
        collection.updated_at = 1;
        db_->create_collection (collection);
    }

    /// `POST /compose` of @p request inline, scoped to `col_sub` in `env_1`
    /// as the renderer asks for it, with @p extra laid over the body.
    json compose_inline (const json& request, const json& extra = json::object ()) const {
        json body = { { "request", request }, { "collectionId", "col_sub" },
            { "environmentId", ENV_ID } };
        body.update (extra);
        auto [status, payload] = vayu::http::compose_request_core (*db_, body);
        EXPECT_EQ (status, 200) << payload.dump ();
        return payload;
    }

    /// A GET to the echo server whose query names every scope, run after
    /// @p elements.
    static json scoped_request (const vayu::tests::EchoServer& echo, const json& elements) {
        json request = { { "method", "GET" }, { "url", echo.url () + SCOPED_URL_QS } };
        if (!elements.is_null ()) {
            request["elements"] = elements;
        }
        return request;
    }

    /// The status and body @p path answered @p payload with.
    std::pair<int, json> post (const char* path, const json& payload) const {
        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post (path, payload.dump (), "application/json");
        if (!response) {
            ADD_FAILURE () << "no response from POST " << path;
            return { 0, json::object () };
        }
        return { response->status, json::parse (response->body, nullptr, false) };
    }

    /// `/execute`'s answer for @p payload, which must be a 200 whatever was sent.
    json execute (const json& payload) const {
        const auto [status, answer] = post ("/execute", payload);
        EXPECT_EQ (status, 200) << answer.dump ();
        return answer;
    }

    /// The variables blob @p id stores now, parsed.
    json stored_variables (const std::string& id) const {
        const auto collection = db_->get_collection (id);
        if (!collection) {
            ADD_FAILURE () << id << " is gone";
            return json::object ();
        }
        return json::parse (collection->variables);
    }

    /// The one run recorded, or an empty snapshot after a failure.
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
    /// What `Server::stop()` sets (#2683); this fixture has no `Server`.
    std::atomic<bool> server_stopping_{ false };
    std::unique_ptr<vayu::http::routes::RouteContext> ctx_;
};

} // namespace

// The issue's case: a scripted inline send composed in `col_sub` sends the
// chain's values (the leaf's and its ancestor's) and its script reads them,
// as the same request with no script would have sent them.
TEST_F (InlineCollectionScopeTest, AScriptedInlineSendResolvesAndExposesItsCollection) {
    const vayu::tests::EchoServer echo;
    const json composed =
    compose_inline (scoped_request (echo, pre_script (REPORT_SCOPE)));
    EXPECT_EQ (composed.value ("collectionId", ""), "col_sub") << composed.dump ();
    EXPECT_EQ (composed.value ("deferredVariables", json ()),
    json::array ({ "c_str", "c_sub", "e_str" }));

    const json answer = execute (composed);

    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (echo.target (), "/echo?c=colval&s=subval&e=envval");
    EXPECT_EQ (echo.header ("X-Seen"), "colval|subval|c_secret,c_str,c_sub");
}

// The same with no script: composition resolves the chain itself, and the
// answer still names the collection it read.
TEST_F (InlineCollectionScopeTest, AnUnscriptedInlineSendIsResolvedAtComposition) {
    const vayu::tests::EchoServer echo;
    const json composed = compose_inline (scoped_request (echo, json ()));
    EXPECT_EQ (composed.value ("collectionId", ""), "col_sub");
    EXPECT_FALSE (composed.contains ("deferredVariables")) << composed.dump ();

    execute (composed);

    EXPECT_EQ (echo.target (), "/echo?c=colval&s=subval&e=envval");
}

// A transient send records nothing and still carries its scope.
TEST_F (InlineCollectionScopeTest, ATransientInlineSendReadsItsCollectionToo) {
    const vayu::tests::EchoServer echo;
    json composed = compose_inline (scoped_request (echo, pre_script (REPORT_SCOPE)));
    composed["transient"] = true;

    execute (composed);

    EXPECT_EQ (echo.target (), "/echo?c=colval&s=subval&e=envval");
    EXPECT_EQ (echo.header ("X-Seen"), "colval|subval|c_secret,c_str,c_sub");
    EXPECT_TRUE (db_->get_all_runs ().empty ());
}

// The leaf is the only writable collection: a script reading an ancestor's
// name and writing its own stores the write on `col_sub` alone, and the read
// is never copied down into it.
TEST_F (InlineCollectionScopeTest, AScriptWriteReachesTheLeafAndNeverAnAncestor) {
    const vayu::tests::EchoServer echo;
    const json root_before = stored_variables ("col_root");
    const json composed    = compose_inline (scoped_request (echo,
    pre_script ("pm.collectionVariables.get('c_str');"
                "pm.collectionVariables.set('cursor', 'abc');")));

    execute (composed);

    const json leaf = stored_variables ("col_sub");
    EXPECT_EQ (leaf.value (json::json_pointer ("/cursor/value"), ""), "abc")
    << leaf.dump ();
    EXPECT_FALSE (leaf.contains ("c_str")) << leaf.dump ();
    EXPECT_EQ (stored_variables ("col_root"), root_before);
}

// The run's snapshot is masked against the chain the send read, so a secret
// an ancestor of the inline scope defines, resolved into the URL at
// composition, is not stored; the scope itself is, as the run's own record.
TEST_F (InlineCollectionScopeTest, TheSnapshotIsMaskedAgainstTheComposedChain) {
    const vayu::tests::EchoServer echo;
    const json composed = compose_inline (
    { { "method", "GET" }, { "url", echo.url () + "?k={{c_secret}}" } });

    execute (composed);

    EXPECT_EQ (echo.target (), std::string ("/echo?k=") + ROOT_SECRET);
    const std::string snapshot = stored_snapshot ();
    ASSERT_FALSE (snapshot.empty ());
    EXPECT_EQ (snapshot.find (ROOT_SECRET), std::string::npos) << snapshot;
    EXPECT_EQ (json::parse (snapshot).value ("collectionId", ""), "col_sub") << snapshot;
}

// A load run of the same payload masks its snapshot against the same chain.
// Mutation check: hand `run_snapshot_secrets` an empty collection in
// `POST /runs` and the secret is stored.
TEST_F (InlineCollectionScopeTest, ALoadRunsSnapshotIsMaskedAgainstTheComposedChain) {
    const vayu::tests::EchoServer echo;
    json payload = compose_inline (
    { { "method", "GET" }, { "url", echo.url () + "?k={{c_secret}}" } },
    { { "deferDynamicVariables", true } });
    payload.update (
    { { "mode", "iterations" }, { "iterations", 1 }, { "concurrency", 1 } });

    const auto [status, body] = post ("/runs", payload);
    ASSERT_EQ (status, 202) << body.dump ();
    const std::string run_id = body.value ("runId", "");
    EXPECT_TRUE (vayu::tests::wait_until (
    [&] { return run_manager_.get_run (run_id) == nullptr; }));

    EXPECT_EQ (echo.target (), std::string ("/echo?k=") + ROOT_SECRET);
    const std::string snapshot = stored_snapshot ();
    ASSERT_FALSE (snapshot.empty ());
    EXPECT_EQ (snapshot.find (ROOT_SECRET), std::string::npos) << snapshot;
}

// A request row's own collection wins over the payload's `collectionId`, as it
// does at composition.
TEST_F (InlineCollectionScopeTest, ARequestRowsCollectionWinsOverTheComposedOne) {
    const vayu::tests::EchoServer echo;

    execute ({ { "method", "GET" }, { "url", echo.url () + "?c={{c_str}}" },
    { "requestId", "req_other" }, { "collectionId", "col_sub" },
    { "elements",
    pre_script ("pm.request.headers.add({ key: 'X-Seen', value: "
                "String(pm.collectionVariables.get('c_str')) });") } });

    EXPECT_EQ (echo.target (), "/echo?c=otherval");
    EXPECT_EQ (echo.header ("X-Seen"), "otherval");
}

// A collection trashed since composition, or one that never existed, is an
// empty scope, as composition degrades it: the send goes out, its names stay
// unanswered, and nothing is refused.
TEST_F (InlineCollectionScopeTest, ACollectionNamingNothingSendsWithAnEmptyScope) {
    const vayu::tests::EchoServer echo;
    const json composed =
    compose_inline (scoped_request (echo, pre_script (REPORT_SCOPE)));
    db_->delete_collection ("col_root");

    const json answer = execute (composed);
    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (echo.header ("X-Seen"), "undefined|undefined|");
    EXPECT_NE (echo.target ().find ("e=envval"), std::string::npos) << echo.target ();

    json unknown            = composed;
    unknown["collectionId"] = "col_unknown";
    execute (unknown);
    EXPECT_EQ (echo.requests_seen (), 2);
    EXPECT_EQ (echo.header ("X-Seen"), "undefined|undefined|");

    // Composed after the trash, the answer names no collection at all.
    EXPECT_FALSE (compose_inline (scoped_request (echo, json ())).contains ("collectionId"));
}

// `collectionId` is composition's answer: one the inline request carries does
// not replace it, nor stand in when composition read no collection.
TEST_F (InlineCollectionScopeTest, ACallerSuppliedCollectionIdCannotSpeakForComposition) {
    const json request = { { "method", "GET" },
        { "url", "https://example.test/" }, { "collectionId", "col_other" } };

    EXPECT_EQ (compose_inline (request).value ("collectionId", ""), "col_sub");

    auto [by_id_status, by_id] = vayu::http::compose_request_core (*db_,
    json{ { "requestId", "req_other" }, { "request", { { "collectionId", "col_sub" } } } });
    ASSERT_EQ (by_id_status, 200) << by_id.dump ();
    EXPECT_EQ (by_id.value ("collectionId", ""), "col_other");

    auto [unscoped_status, unscoped] =
    vayu::http::compose_request_core (*db_, json{ { "request", request } });
    ASSERT_EQ (unscoped_status, 200) << unscoped.dump ();
    EXPECT_FALSE (unscoped.contains ("collectionId")) << unscoped.dump ();

    auto [unknown_status, unknown] = vayu::http::compose_request_core (
    *db_, json{ { "request", request }, { "collectionId", "col_unknown" } });
    ASSERT_EQ (unknown_status, 200) << unknown.dump ();
    EXPECT_FALSE (unknown.contains ("collectionId")) << unknown.dump ();
}

// A load run of the same composed payload: each submission's residual pass
// answers the deferred names from the composed collection's chain, as the
// Send does.
TEST_F (InlineCollectionScopeTest, ALoadRunOfAnInlinePayloadReadsItsComposedCollection) {
    const vayu::tests::EchoServer echo;
    json payload = compose_inline (
    scoped_request (echo, pre_script ("pm.variables.set('touched', '1');", true)),
    { { "deferDynamicVariables", true } });
    payload["requestElements"] = payload["elements"];
    payload.erase ("elements");
    payload.update (
    { { "mode", "iterations" }, { "iterations", 1 }, { "concurrency", 1 } });

    const auto [status, body] = post ("/runs", payload);
    ASSERT_EQ (status, 202) << body.dump ();
    const std::string run_id = body.value ("runId", "");
    // `retain_run` is the worker's last act, so a run the manager no longer
    // holds has sent everything it will.
    EXPECT_TRUE (vayu::tests::wait_until (
    [&] { return run_manager_.get_run (run_id) == nullptr; }));

    EXPECT_EQ (echo.target (), "/echo?c=colval&s=subval&e=envval");
}
