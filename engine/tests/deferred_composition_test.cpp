/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/deferred_composition_test.cpp
 * @brief A request a pre-request script runs before sends the script's values
 *        (#2521), through `POST /compose` and then the real `POST /execute`.
 *
 * Postman resolves `{{name}}` after the pre-request script. Composition leaves
 * such a request's names written and lists them as `deferredVariables`; the
 * residual pass answers them after the script.
 *
 * Driven the way the app drives it: compose by id, spread the answer into the
 * `/execute` body (so `deferredVariables` rides back in, and must be ignored),
 * and read what the echo server received. The composition half alone is
 * `request_composer_test.cpp`'s, the pass alone `residual_token_test.cpp`'s.
 *
 * Mutation check for the file: make `runs_a_pre_request_script`
 * (request_composer.cpp) answer false, and every case sending a stored name
 * the script replaced goes out with the stored value.
 *
 * An OAuth 2.0 config waits for the script too, and its token is acquired
 * after it (the `OAuth2` cases below, against `MockTokenServer`). Mutation
 * check for those: make `resolve_compose_auth` resolve an oauth2 block with
 * `lookup.now ()` whatever its `OAuth2Resolution`, and the token endpoint
 * receives the stored values.
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
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "basic_auth_pair.hpp"
#include "echo_server.hpp"
#include "oauth_token_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/json.hpp"
#include "wait_until.hpp"

namespace {

using nlohmann::json;
using vayu::tests::basic_pair_of;
using vayu::tests::MockTokenServer;

constexpr const char* ENV_ID     = "env_1";
constexpr const char* REQUEST_ID = "req_1";

/// A client-credentials auth block against @p tokens at @p path, every field
/// that reaches the endpoint a variable. The client id and secret go in the
/// body, so the server's last body shows both.
json client_credentials (const MockTokenServer& tokens, const std::string& path = "/token") {
    return { { "mode", "oauth2" },
        { "config",
        { { "grantType", "client_credentials" }, { "accessTokenUrl", tokens.url (path) },
        { "clientId", "{{client}}" }, { "clientSecret", "{{secret}}" },
        { "scope", "{{scope}}" }, { "credentialsPlacement", "body" } } } };
}

/// The form field @p name of the last token request, "" when it had none.
std::string token_form_field (const MockTokenServer& tokens, const std::string& name) {
    const auto form  = vayu::tests::parse_form (tokens.last_body ());
    const auto found = form.find (name);
    return found == form.end () ? std::string () : found->second;
}

/// A composed payload as `POST /runs` takes it for a single-request run of one
/// iteration: the request's elements under `requestElements`, its `elements`
/// being the run override.
json as_single_iteration_run (json payload) {
    payload["requestElements"] = payload.at ("elements");
    payload.erase ("elements");
    payload.update (
    { { "mode", "iterations" }, { "iterations", 1 }, { "concurrency", 1 } });
    return payload;
}

class DeferredCompositionTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_deferred_composition.db";

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

        vayu::db::Collection col;
        col.id         = "col_1";
        col.name       = "Collection";
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
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

    /// `env_1`, holding @p variables (`{name: value}`), every one enabled.
    void seed_environment (const json& variables) const {
        json stored = json::object ();
        for (const auto& [name, value] : variables.items ()) {
            stored[name] = { { "value", value }, { "enabled", true } };
        }
        vayu::db::Environment env;
        env.id         = ENV_ID;
        env.name       = "Env";
        env.variables  = stored.dump ();
        env.created_at = 1;
        env.updated_at = 1;
        db_->save_environment (env);
    }

    /// `req_1`, a GET to @p url carrying @p headers (`{name: value}`), with
    /// @p pre_script as its own `script.pre` when not empty.
    void seed_request (const std::string& url,
    const json& headers,
    const std::string& pre_script,
    const json& auth = json ()) const {
        json rows = json::array ();
        for (const auto& [name, value] : headers.items ()) {
            rows.push_back ({ { "key", name }, { "value", value }, { "enabled", true } });
        }
        json elements = json::array ();
        if (!pre_script.empty ()) {
            elements.push_back ({ { "id", "el_pre" }, { "kind", "script.pre" },
            { "enabled", true }, { "config", { { "script", pre_script } } } });
        }
        vayu::db::Request r;
        r.id            = REQUEST_ID;
        r.collection_id = "col_1";
        r.name          = "Request";
        r.method        = vayu::HttpMethod::GET;
        r.url           = url;
        r.headers       = rows.dump ();
        r.elements      = elements.dump ();
        r.auth       = auth.is_null () ? R"({"mode":"noauth"})" : auth.dump ();
        r.created_at = 1;
        r.updated_at = 1;
        db_->save_request (r);
    }

    /// `POST /compose` of `req_1` in `env_1`, as the app asks for it.
    json compose () const {
        auto [status, payload] = vayu::http::compose_request_core (
        *db_, json{ { "requestId", REQUEST_ID }, { "environmentId", ENV_ID } });
        EXPECT_EQ (status, 200) << payload.dump ();
        return payload;
    }

    /// `POST /compose` of `req_1` in `env_1` for a run, as the load dialog asks.
    json compose_for_a_run () const {
        auto [status, payload] = vayu::http::compose_request_core (*db_,
        json{ { "requestId", REQUEST_ID }, { "environmentId", ENV_ID },
        { "deferDynamicVariables", true } });
        EXPECT_EQ (status, 200) << payload.dump ();
        return payload;
    }

    /// Wait for @p run_id to leave pending and running.
    void await_run (const std::string& run_id) const {
        EXPECT_TRUE (vayu::tests::wait_until ([&] {
            const auto run = db_->get_run (run_id);
            return run && run->status != vayu::RunStatus::Pending &&
            run->status != vayu::RunStatus::Running;
        }));
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

    /// Compose `req_1`, then send the composed payload as the app does, with
    /// @p extra laid over it; answers what `/execute` said.
    json compose_and_execute (const json& extra = json::object ()) const {
        json payload = compose ();
        payload.update (extra);
        const auto [status, answer] = post ("/execute", payload);
        EXPECT_EQ (status, 200) << answer.dump ();
        return answer;
    }

    /// `env_1`'s stored value for @p name, as the send persisted it.
    std::string stored_value (const std::string& name) const {
        const auto env = db_->get_environment (ENV_ID);
        if (!env) {
            ADD_FAILURE () << "env_1 is gone";
            return {};
        }
        const auto variables = vayu::json::parse_variables (env->variables);
        const auto found     = variables.find (name);
        return found == variables.end () ? std::string () : found->second.value;
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

} // namespace

// The headline: the stored token is replaced by the script, and the new one is
// what goes out. `deferredVariables` rides back into `/execute` with the rest
// of the composed payload, and is ignored there.
TEST_F (DeferredCompositionTest, TheScriptsNewTokenReachesTheWireOverTheStoredOne) {
    const vayu::tests::EchoServer echo;
    seed_environment ({ { "token", "old" } });
    seed_request (echo.url (), { { "Authorization", "Bearer {{token}}" } },
    "pm.environment.set('token', 'new');");

    const json composed = compose ();
    EXPECT_EQ (composed.value ("deferredVariables", json ()), json::array ({ "token" }));

    const json answer = compose_and_execute ();
    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (echo.header ("Authorization"), "Bearer new");
}

// A request's own script stamping the value it sends, the other everyday
// shape: a timestamp or a signature computed per send.
TEST_F (DeferredCompositionTest, AValueTheRequestsOwnScriptComputesIsTheOneSent) {
    const vayu::tests::EchoServer echo;
    seed_environment ({ { "ts", "0" } });
    seed_request (echo.url (), { { "X-Ts", "{{ts}}" } },
    "pm.environment.set('ts', String(Date.now()));");

    compose_and_execute ();

    const std::string stamped = stored_value ("ts");
    EXPECT_NE (stamped, "0");
    EXPECT_EQ (echo.header ("X-Ts"), stamped);
}

// A token fetched by the script's own `pm.sendRequest` lands in the scopes
// from its callback, which runs before the script ends - and so before the
// pass that resolves the header.
TEST_F (DeferredCompositionTest, AValueAPmSendRequestCallbackSetsReachesTheHeader) {
    const vayu::tests::EchoServer echo;
    seed_environment ({ { "token", "old" } });
    seed_request (echo.url () + "/api", { { "Authorization", "Bearer {{token}}" } },
    "pm.sendRequest('" + echo.url () +
    "/token', function (err, res) {"
    "  pm.environment.set('token', 'fetched-' + res.code);"
    "});");

    compose_and_execute ({ { "allowScriptRequests", true } });

    EXPECT_EQ (echo.path (), "/echo/api")
    << "the last request seen is not the send";
    EXPECT_EQ (echo.header ("Authorization"), "Bearer fetched-200");
}

// A basic pair is base64-encoded when it is applied, so the script's password
// has to be in it before then: the deferred credential waits for the auth
// applied after the script (#2473).
TEST_F (DeferredCompositionTest, ABasicPasswordTheScriptReplacesReachesTheBase64) {
    const vayu::tests::EchoServer echo;
    seed_environment ({ { "password", "old" } });
    seed_request (echo.url (), json::object (), "pm.environment.set('password', 'new');",
    json{ { "mode", "basic" }, { "username", "user" }, { "password", "{{password}}" } });

    compose_and_execute ();

    EXPECT_EQ (basic_pair_of (echo.header ("Authorization")), "user:new");
}

// A generator is generated once, at composition, so the script reads the very
// value that is sent - never a second draw at the send.
TEST_F (DeferredCompositionTest, AGeneratorResolvesOnceAndTheScriptReadsTheValueSent) {
    const vayu::tests::EchoServer echo;
    seed_environment ({ { "token", "old" } });
    seed_request (echo.url (), { { "X-Id", "{{$guid}}" }, { "X-Token", "{{token}}" } },
    "pm.environment.set('seen', pm.request.headers.get('X-Id'));"
    "pm.environment.set('token', 'new');");

    compose_and_execute ();

    const std::string sent = echo.header ("X-Id");
    EXPECT_EQ (sent.find ("{{"), std::string::npos) << sent;
    EXPECT_FALSE (sent.empty ());
    EXPECT_EQ (stored_value ("seen"), sent);
    EXPECT_EQ (echo.header ("X-Token"), "new");
}

// The data namespace still binds from the row a send carries, beside a name
// the script answers: the bind runs before the script and owns its tokens.
TEST_F (DeferredCompositionTest, ADataColumnStillBindsFromTheRowBesideADeferredName) {
    const vayu::tests::EchoServer echo;
    seed_environment ({ { "token", "old" } });
    seed_request (echo.url (), { { "X-Col", "{{data.col}}" }, { "X-Token", "{{token}}" } },
    "pm.environment.set('token', 'new-' + pm.iterationData.get('col'));");

    compose_and_execute ({ { "data", { { "col", "row-a" } } } });

    EXPECT_EQ (echo.header ("X-Col"), "row-a");
    EXPECT_EQ (echo.header ("X-Token"), "new-row-a");
}

// The defect as a user met it: the first send happened to work, and every
// send after it carried the value the *previous* run's script had stored.
TEST_F (DeferredCompositionTest, TheSameRequestSentTwiceSendsEachRunsOwnValue) {
    const vayu::tests::EchoServer echo;
    seed_environment ({ { "token", "old" }, { "n", "0" } });
    seed_request (echo.url (), { { "Authorization", "Bearer {{token}}" } },
    "const n = Number(pm.environment.get('n')) + 1;"
    "pm.environment.set('n', String(n));"
    "pm.environment.set('token', 'run-' + n);");

    compose_and_execute ();
    EXPECT_EQ (echo.header ("Authorization"), "Bearer run-1");
    ASSERT_EQ (stored_value ("token"), "run-1");

    compose_and_execute ();
    EXPECT_EQ (echo.header ("Authorization"), "Bearer run-2");
}

// Composition no longer sees the value a deferred header variable resolves to,
// so the send refuses it instead, naming the variable and answering the rule's
// code beside the status-0 response. Nothing reaches the server.
TEST_F (DeferredCompositionTest, ADeferredHeaderVariableCarryingALineBreakIsRefusedAtTheSend) {
    const vayu::tests::EchoServer echo;
    seed_environment ({ { "note", "fine" } });
    seed_request (echo.url (), { { "X-Note", "{{note}}" } },
    "pm.environment.set('note', 'ok\\r\\nX-Admin: true');");

    const json answer = compose_and_execute ();

    EXPECT_EQ (echo.requests_seen (), 0) << "the forged line went out";
    EXPECT_EQ (answer.value ("refusalCode", ""), "unsendable_header") << answer.dump ();
    EXPECT_NE (answer.dump ().find ("{{note}}"), std::string::npos) << answer.dump ();
}

// A load run of the same composed payload: `POST /runs` takes the payload with
// `deferredVariables` in it, and the residual pass every submission of a run
// declaring `requestElements` makes answers the deferred name from the run's
// scopes - the stored value, since an un-inlined script does not run under
// load - rather than sending the literal token.
TEST_F (DeferredCompositionTest, ALoadRunOfADeferredPayloadSendsTheStoredValueNotTheToken) {
    const vayu::tests::EchoServer echo;
    seed_environment ({ { "token", "old" } });
    seed_request (echo.url (), { { "Authorization", "Bearer {{token}}" } },
    "pm.environment.set('token', 'new');");

    const json payload = compose ();
    ASSERT_TRUE (payload.contains ("deferredVariables")) << payload.dump ();

    const auto [status, body] = post ("/runs", as_single_iteration_run (payload));
    ASSERT_EQ (status, 202) << body.dump ();
    await_run (body.value ("runId", std::string ()));
    EXPECT_EQ (echo.header ("Authorization"), "Bearer old");
}

// The load run's other half: a `script.pre` marked inline runs per submission,
// so each submission's residual pass answers the deferred name with the value
// that submission's script set, against its own scope overlay. Mutation check:
// make `runs_a_pre_request_script` (request_composer.cpp) answer false, and
// every submission sends the stored `Bearer old`.
TEST_F (DeferredCompositionTest, ALoadRunsInlinePreRequestScriptSetsTheValueEverySubmissionSends) {
    const vayu::tests::EchoServer echo;
    seed_environment ({ { "token", "old" } });
    seed_request (echo.url (), { { "Authorization", "Bearer {{token}}" } },
    "pm.environment.set('token', 'new');");

    json payload = as_single_iteration_run (compose ());
    payload["requestElements"][0]["config"]["inline"] = true;
    payload["iterations"]                             = 3;

    const auto [status, body] = post ("/runs", payload);
    ASSERT_EQ (status, 202) << body.dump ();
    await_run (body.value ("runId", std::string ()));
    EXPECT_EQ (echo.header_per_request ("Authorization"),
    (std::vector<std::string>{ "Bearer new", "Bearer new", "Bearer new" }));
}

// --- OAuth 2.0 (#2521): resolved after the script, then acquired --------------

// The headline: the client secret and the scope the script sets are what the
// token endpoint receives, and the token it answers is what goes out.
TEST_F (DeferredCompositionTest, OAuth2TheSecretAndScopeTheScriptSetsReachTheTokenEndpoint) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_environment (
    { { "client", "cid" }, { "secret", "old-secret" }, { "scope", "read" } });
    seed_request (echo.url (),
    json::object (), "pm.environment.set('secret', 'new-secret'); pm.environment.set('scope', 'write');",
    client_credentials (tokens));

    const json composed = compose ();
    EXPECT_EQ (composed["auth"]["config"]["clientSecret"], "{{secret}}")
    << composed.dump ();
    EXPECT_EQ (composed.value ("deferredVariables", json ()),
    json::array ({ "client", "scope", "secret" }));

    const json answer = compose_and_execute ();
    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (tokens.hits (), 1);
    EXPECT_EQ (token_form_field (tokens, "client_secret"), "new-secret");
    EXPECT_EQ (token_form_field (tokens, "scope"), "write");
    EXPECT_EQ (echo.header ("Authorization"), "Bearer AT1");
}

// The cache key is the resolved config's: the token is stored under the client
// id the script set, and nothing under the one composition would have used.
TEST_F (DeferredCompositionTest, OAuth2TheCacheKeyIsTheScriptsConfigNotTheComposedOne) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_environment (
    { { "client", "old-client" }, { "secret", "s" }, { "scope", "read" } });
    seed_request (echo.url (), json::object (),
    "pm.environment.set('client', 'new-client');", client_credentials (tokens));

    compose_and_execute ();

    json config                    = client_credentials (tokens)["config"];
    config["clientSecret"]         = "s";
    config["scope"]                = "read";
    config["clientId"]             = "new-client";
    const std::string sent_key     = vayu::http::oauth::cache_key (config);
    config["clientId"]             = "old-client";
    const std::string composed_key = vayu::http::oauth::cache_key (config);
    ASSERT_NE (sent_key, composed_key);
    EXPECT_EQ (token_form_field (tokens, "client_id"), "new-client");
    EXPECT_TRUE (db_->get_oauth_token (sent_key).has_value ());
    EXPECT_FALSE (db_->get_oauth_token (composed_key).has_value ());
}

// Nothing deferred without a script: the config composes resolved, exactly as
// before #2521, and the token is acquired with the stored values.
TEST_F (DeferredCompositionTest, OAuth2WithNoScriptResolvesAtCompositionAsBefore) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_environment (
    { { "client", "cid" }, { "secret", "stored-secret" }, { "scope", "read" } });
    seed_request (echo.url (), json::object (), "", client_credentials (tokens));

    const json composed = compose ();
    EXPECT_EQ (composed["auth"]["config"]["clientSecret"], "stored-secret");
    EXPECT_FALSE (composed.contains ("deferredVariables")) << composed.dump ();

    compose_and_execute ();
    EXPECT_EQ (token_form_field (tokens, "client_secret"), "stored-secret");
    EXPECT_EQ (echo.header ("Authorization"), "Bearer AT1");
}

// A script that leaves the config as it was reaches the same key, so the
// second send reads the cached token instead of asking the endpoint again.
TEST_F (DeferredCompositionTest, OAuth2ASecondSendOfTheSameResolvedConfigUsesTheCache) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_environment ({ { "client", "cid" }, { "secret", "old" }, { "scope", "read" } });
    seed_request (echo.url (), json::object (),
    "pm.environment.set('secret', 'same');", client_credentials (tokens));

    compose_and_execute ();
    compose_and_execute ();

    EXPECT_EQ (tokens.hits (), 1);
    EXPECT_EQ (echo.header ("Authorization"), "Bearer AT1");
}

// A token the endpoint refuses fails the send the way a refused build does:
// status 0, the hint as `authErrorCode`, and nothing reaches the server.
TEST_F (DeferredCompositionTest, OAuth2ATokenTheEndpointRefusesAfterTheScriptFailsTheSend) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_environment ({ { "client", "cid" }, { "secret", "old" }, { "scope", "read" } });
    seed_request (echo.url (), json::object (), "pm.environment.set('secret', 'new');",
    client_credentials (tokens, "/token-fail"));

    const json answer = compose_and_execute ();

    EXPECT_EQ (tokens.hits (), 1);
    EXPECT_EQ (echo.requests_seen (), 0);
    EXPECT_EQ (answer.value ("status", -1), 0) << answer.dump ();
    const std::string hint = answer.value ("authErrorCode", "");
    EXPECT_FALSE (hint.empty ()) << answer.dump ();
    EXPECT_EQ (answer.value ("refusalCode", ""), hint);
}

// What the acquisition waited on the endpoint for is reported beside the
// script time, so `engineMs` leaves it out; a cached token waits on nothing.
TEST_F (DeferredCompositionTest, OAuth2ALateFetchIsTimedAndACachedTokenIsNot) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    json config         = client_credentials (tokens)["config"];
    const auto exchange = [&] {
        vayu::runtime::ScriptEngine engine;
        vayu::http::routes::ScriptVariableScopes scopes;
        for (const char* name : { "client", "secret", "scope" }) {
            scopes.environment[name] =
            vayu::Variable{ .value = std::string ("v-") + name };
        }
        vayu::http::routes::ExchangeInputs inputs;
        inputs.request.method = vayu::HttpMethod::GET;
        inputs.request.url    = echo.url ();
        inputs.late_auth      = vayu::http::OAuth2Auth{ config };
        inputs.token_cache    = db_.get ();
        return vayu::http::routes::execute_exchange (
        engine, cookie_jar_, "", scopes, std::move (inputs));
    };

    const auto fetched = exchange ();
    EXPECT_EQ (fetched.response.status_code, 200);
    EXPECT_GT (fetched.auth_fetch_ms, 0.0);
    const auto cached = exchange ();
    EXPECT_EQ (tokens.hits (), 1);
    EXPECT_EQ (cached.auth_fetch_ms, 0.0);
}

// A load run acquires once, before any script: composed for a run, the config
// carries the stored values and the run sends their token; composed for a
// Send, it is still a template and the run is refused rather than asking the
// endpoint with `{{client}}`.
TEST_F (DeferredCompositionTest, OAuth2ALoadRunAcquiresFromTheStoredValuesOrIsRefused) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_environment ({ { "client", "cid" }, { "secret", "stored" }, { "scope", "read" } });
    seed_request (echo.url (), json::object (),
    "pm.environment.set('secret', 'new');", client_credentials (tokens));

    const auto [refused, refusal] =
    post ("/runs", as_single_iteration_run (compose ()));
    EXPECT_EQ (refused, 400) << refusal.dump ();
    EXPECT_NE (refusal.dump ().find ("{{client}}"), std::string::npos)
    << refusal.dump ();
    EXPECT_EQ (tokens.hits (), 0);

    const json payload = compose_for_a_run ();
    EXPECT_EQ (payload["auth"]["config"]["clientSecret"], "stored") << payload.dump ();
    const auto [status, body] = post ("/runs", as_single_iteration_run (payload));
    ASSERT_EQ (status, 202) << body.dump ();
    await_run (body.value ("runId", std::string ()));
    EXPECT_EQ (token_form_field (tokens, "client_secret"), "stored");
    EXPECT_EQ (echo.header ("Authorization"), "Bearer AT1");
}
