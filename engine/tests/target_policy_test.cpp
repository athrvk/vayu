/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/target_policy_test.cpp
 * @brief A payload's `targetPolicy` holds the URL about to be sent, after the
 *        scripts, on every send path the MCP server drives (#2521).
 *
 * The MCP server checks its allowlist against the composed URL, which a
 * pre-request script can still rewrite. These cases steer a request with a
 * script (`pm.request.url`, or the variable a deferred `{{host}}` resolves
 * from) to a host the policy does not list and assert the echo server saw
 * nothing; each refusal has a twin the same policy admits, so a check that
 * refused everything would fail too. The OAuth 2.0 cases steer the
 * `accessTokenUrl` the same ways and assert the token server saw nothing
 * either: the token request carries the client's id and secret.
 *
 * Every send dials 127.0.0.1; `localhost` is the host the policy leaves out,
 * so a refused case resolves no name at all.
 *
 * Mutation check: make `refuse_disallowed_target` (request_exchange.cpp)
 * answer nothing, and the design-send cases send; drop the
 * `config.target_policy` branch in `submit_pending_transfers`
 * (event_loop_worker.cpp), and the load cases do; drop the
 * `refuse_token_endpoints` branch in `resolve_oauth2` (auth_resolver.cpp), and
 * the token cases reach the token server.
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
#include "oauth_token_server.hpp"
#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/http/target_policy.hpp"
#include "vayu/types.hpp"
#include "wait_until.hpp"

namespace {

using nlohmann::json;
using vayu::http::read_target_policy;
using vayu::http::refuse_target;
using vayu::http::refuse_token_endpoints;
using vayu::http::TargetPolicy;
using vayu::tests::MockTokenServer;

constexpr const char* ENV_ID     = "env_1";
constexpr const char* REQUEST_ID = "req_1";

vayu::Request request_to (const std::string& url) {
    vayu::Request request;
    request.url = url;
    return request;
}

TargetPolicy allowing (std::vector<std::string> hosts) {
    return TargetPolicy{ .allow_all = false, .allowed_hosts = std::move (hosts) };
}

json policy_allowing (const json& hosts) {
    return { { "allowAll", false }, { "allowedHosts", hosts } };
}

/// A client-credentials auth block posting to @p token_url.
json client_credentials (const std::string& token_url) {
    return { { "mode", "oauth2" },
        { "config",
        { { "grantType", "client_credentials" },
        { "accessTokenUrl", token_url }, { "clientId", "cid" },
        { "clientSecret", "secret" }, { "credentialsPlacement", "body" } } } };
}

/// @p tokens' `/token` endpoint, named by @p host.
std::string token_url (const MockTokenServer& tokens, const std::string& host) {
    std::string url = tokens.url ("/token");
    url.replace (url.find ("127.0.0.1"), std::string ("127.0.0.1").size (), host);
    return url;
}

/// A refusal body's `error.code`, "" for any other answer.
std::string error_code (const json& answer) {
    return answer.value (json::json_pointer ("/error/code"), std::string ());
}

// --- The rule itself ----------------------------------------------------------

TEST (TargetPolicyRead, AbsentAndNullStateNoPolicy) {
    for (const json& payload : { json::object (), json{ { "targetPolicy", nullptr } } }) {
        const auto read = read_target_policy (payload);
        ASSERT_TRUE (read) << read.error ();
        EXPECT_EQ (*read, std::nullopt) << payload.dump ();
    }
}

TEST (TargetPolicyRead, EntriesAreTrimmedAndLowerCased) {
    const auto read = read_target_policy (
    json{ { "targetPolicy", policy_allowing ({ "  API.Example.com\t" }) } });
    ASSERT_TRUE (read) << read.error ();
    ASSERT_HAS_VALUE (*read);
    EXPECT_FALSE ((*read)->allow_all);
    EXPECT_EQ ((*read)->allowed_hosts, std::vector<std::string>{ "api.example.com" });
}

TEST (TargetPolicyRead, AMalformedPolicyIsRefusedNamingTheMember) {
    const std::vector<std::pair<json, std::string>> cases{
        { json ("everything"), "'targetPolicy' must be an object" },
        { json{ { "allowAll", "yes" } }, "targetPolicy.allowAll" },
        { json{ { "allowedHosts", "api.example.com" } }, "targetPolicy.allowedHosts" },
        { json{ { "allowedHosts", json::array ({ 1 }) } }, "targetPolicy.allowedHosts" },
        { json{ { "allowedHost", json::array () } }, "no member 'allowedHost'" },
    };
    for (const auto& [policy, words] : cases) {
        const auto read = read_target_policy (json{ { "targetPolicy", policy } });
        ASSERT_FALSE (read) << policy.dump ();
        EXPECT_NE (read.error ().find (words), std::string::npos) << read.error ();
    }
}

TEST (TargetPolicyRefusal, AListedHostPassesInAnyCaseAndAnyOtherIsRefusedByName) {
    const auto policy = allowing ({ "api.example.com" });
    EXPECT_FALSE (refuse_target (policy, request_to ("https://API.Example.COM:8443/x")));

    const auto refused =
    refuse_target (policy, request_to ("https://evil.example.com/x"));
    ASSERT_HAS_VALUE (refused);
    EXPECT_EQ (refused->code, vayu::http::TARGET_NOT_ALLOWED_CODE);
    EXPECT_NE (refused->message.find ("\"evil.example.com\""), std::string::npos)
    << refused->message;
}

// The host is read as the WHATWG parser the MCP server uses reads it, so a
// listed address cannot be reached under another spelling of a different one,
// and an IPv6 entry is matched in its bracketed form.
TEST (TargetPolicyRefusal, AddressesAreComparedInTheirCanonicalSpelling) {
    EXPECT_FALSE (
    refuse_target (allowing ({ "127.0.0.1" }), request_to ("http://127.1:9/")));
    EXPECT_FALSE (
    refuse_target (allowing ({ "127.0.0.1" }), request_to ("http://2130706433/")));
    EXPECT_TRUE (refuse_target (allowing ({ "127.0.0.2" }), request_to ("http://127.1/")));
    EXPECT_FALSE (
    refuse_target (allowing ({ "[::1]" }), request_to ("http://[0:0::1]:80/")));
    // The userinfo is not the host.
    EXPECT_TRUE (refuse_target (allowing ({ "api.example.com" }),
    request_to ("http://api.example.com@evil.example.com/")));
}

TEST (TargetPolicyRefusal, AllowAllAdmitsAnyHostAndAnEmptyListNone) {
    const TargetPolicy all{ .allow_all = true, .allowed_hosts = {} };
    EXPECT_FALSE (refuse_target (all, request_to ("https://anything.example/")));

    const auto none =
    refuse_target (allowing ({}), request_to ("https://api.example.com/"));
    ASSERT_HAS_VALUE (none);
    EXPECT_EQ (none->code, vayu::http::TARGET_NOT_ALLOWED_CODE);
    EXPECT_NE (none->message.find ("allows no host"), std::string::npos) << none->message;
}

// No policy admits a host it cannot read, allowAll included.
TEST (TargetPolicyRefusal, AHostThatCannotBeDeterminedIsRefusedUnderAllowAll) {
    const TargetPolicy all{ .allow_all = true, .allowed_hosts = {} };
    for (const char* url : { "", "https://{{host}}/x", "http://[::1/" }) {
        const auto refused = refuse_target (all, request_to (url));
        ASSERT_HAS_VALUE (refused) << url;
        EXPECT_EQ (refused->code, vayu::http::TARGET_HOST_UNKNOWN_CODE) << url;
    }
}

// Both URLs a token acquisition may post to are judged, whatever the cache
// holds: a refresh endpoint off the list is refused beside a listed token URL.
TEST (TargetPolicyTokenEndpoints, EveryEndpointTheAcquisitionMayPostToIsJudged) {
    const auto policy = allowing ({ "idp.example.com" });
    const json listed{ { "accessTokenUrl", "https://IDP.example.com/token" } };
    EXPECT_FALSE (refuse_token_endpoints (policy, listed));

    json refresh_off_list               = listed;
    refresh_off_list["refreshTokenUrl"] = "https://evil.example.com/refresh";
    const auto refused = refuse_token_endpoints (policy, refresh_off_list);
    ASSERT_HAS_VALUE (refused);
    EXPECT_EQ (refused->code, vayu::http::TARGET_NOT_ALLOWED_CODE);
    EXPECT_NE (refused->message.find ("refreshTokenUrl"), std::string::npos)
    << refused->message;
    EXPECT_NE (refused->message.find ("\"evil.example.com\""), std::string::npos)
    << refused->message;

    // An empty refresh URL posts nothing of its own: the refresh falls back to
    // the token URL.
    json empty_refresh               = listed;
    empty_refresh["refreshTokenUrl"] = "";
    EXPECT_FALSE (refuse_token_endpoints (policy, empty_refresh));
}

TEST (TargetPolicyTokenEndpoints, AllowAllAdmitsAnyEndpointButNotAnUnknownHost) {
    const TargetPolicy all{ .allow_all = true, .allowed_hosts = {} };
    EXPECT_FALSE (refuse_token_endpoints (
    all, json{ { "accessTokenUrl", "https://anything.example/token" } }));

    const auto unknown = refuse_token_endpoints (
    all, json{ { "accessTokenUrl", "https://{{idp}}/token" } });
    ASSERT_HAS_VALUE (unknown);
    EXPECT_EQ (unknown->code, vayu::http::TARGET_HOST_UNKNOWN_CODE);
}

// --- Through the routes ------------------------------------------------------

class TargetPolicyRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_target_policy.db";

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

        vayu::db::Environment env;
        env.id   = ENV_ID;
        env.name = "Env";
        env.variables =
        json{ { "host", { { "value", "127.0.0.1" }, { "enabled", true } } } }.dump ();
        env.created_at = 1;
        env.updated_at = 1;
        db_->save_environment (env);
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

    /// `req_1`, a GET to @p url under @p auth, with @p pre_script as its own
    /// `script.pre` (run inline under load when @p inline_script), or no
    /// element at all when it is empty.
    void seed_request (const std::string& url,
    const std::string& pre_script,
    bool inline_script = false,
    const json& auth   = json{ { "mode", "noauth" } }) const {
        json config{ { "script", pre_script } };
        if (inline_script) {
            config["inline"] = true;
        }
        vayu::db::Request r;
        r.id            = REQUEST_ID;
        r.collection_id = "col_1";
        r.name          = "Request";
        r.method        = vayu::HttpMethod::GET;
        r.url           = url;
        r.headers       = "[]";
        r.elements      = pre_script.empty () ?
             json::array ().dump () :
             json::array ({ { { "id", "el_pre" }, { "kind", "script.pre" },
                          { "enabled", true }, { "config", config } } })
        .dump ();
        r.auth          = auth.dump ();
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    /// The script that moves the send to @p host on @p echo's port.
    static std::string
    steer_to (const vayu::tests::EchoServer& echo, const std::string& host) {
        return "pm.request.url = 'http://" + host + ":" +
        std::to_string (echo.port ()) + "/echo';";
    }

    json compose () const {
        auto [status, payload] = vayu::http::compose_request_core (
        *db_, json{ { "requestId", REQUEST_ID }, { "environmentId", ENV_ID } });
        EXPECT_EQ (status, 200) << payload.dump ();
        return payload;
    }

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

    /// `/execute` of `req_1` as composed, under @p policy.
    json execute (const json& policy, const json& extra = json::object ()) const {
        json payload            = compose ();
        payload["targetPolicy"] = policy;
        payload.update (extra);
        const auto [status, answer] = post ("/execute", payload);
        EXPECT_EQ (status, 200) << answer.dump ();
        return answer;
    }

    /// Start @p payload on `/runs` and wait for it to finish; its run id.
    std::string run_to_the_end (const json& payload) const {
        const auto [status, body] = post ("/runs", payload);
        EXPECT_EQ (status, 202) << body.dump ();
        const std::string run_id = body.value ("runId", std::string ());
        EXPECT_TRUE (vayu::tests::wait_until ([&] {
            const auto run = db_->get_run (run_id);
            return run && run->status != vayu::RunStatus::Pending &&
            run->status != vayu::RunStatus::Running;
        }));
        return run_id;
    }

    /// A single-request load run of `req_1` as composed: one iteration, its
    /// elements under `requestElements`.
    json single_request_run (const json& policy) const {
        json payload               = compose ();
        payload["requestElements"] = payload.at ("elements");
        payload.erase ("elements");
        payload.update ({ { "mode", "iterations" }, { "iterations", 1 },
        { "concurrency", 1 }, { "targetPolicy", policy } });
        return payload;
    }

    /// A run of `col_1` as a sequence (no `mode`) or under load.
    static json collection_run (const json& policy, bool under_load) {
        json payload{ { "scenario",
                      { { "source", "collection" }, { "collectionId", "col_1" },
                      { "iterations", 1 } } },
            { "environmentId", ENV_ID }, { "targetPolicy", policy } };
        if (under_load) {
            payload["scenario"].erase ("iterations");
            payload.update (
            { { "mode", "iterations" }, { "iterations", 1 }, { "concurrency", 1 } });
        }
        return payload;
    }

    /// Every stored result's error text for @p run_id, joined.
    std::string result_errors (const std::string& run_id) const {
        std::string out;
        for (const auto& result : db_->get_results (run_id)) {
            out += result.error + "\n";
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

} // namespace

// The headline: the composed URL is on the list, the script moves the send
// off it, and nothing goes out.
TEST_F (TargetPolicyRouteTest, AScriptSteeringPmRequestUrlOffTheListIsRefusedAtTheSend) {
    const vayu::tests::EchoServer echo;
    seed_request (echo.url (), steer_to (echo, "localhost"));

    const json answer = execute (policy_allowing ({ "127.0.0.1" }));

    EXPECT_EQ (echo.requests_seen (), 0) << "the steered request went out";
    EXPECT_EQ (answer.value ("status", -1), 0) << answer.dump ();
    EXPECT_EQ (answer.value ("refusalCode", ""), "target_not_allowed") << answer.dump ();
    EXPECT_NE (answer.value ("errorMessage", "").find ("\"localhost\""), std::string::npos)
    << answer.dump ();
}

TEST_F (TargetPolicyRouteTest, AScriptSteeringToAListedHostIsSent) {
    const vayu::tests::EchoServer echo;
    seed_request ("http://localhost:" + std::to_string (echo.port ()) + "/echo",
    steer_to (echo, "127.0.0.1"));

    const json answer = execute (policy_allowing ({ "127.0.0.1" }));

    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (echo.requests_seen (), 1);
}

// A deferred `{{host}}`: composition leaves it written because the script runs
// first, so the host is the script's to choose and is judged once chosen.
TEST_F (TargetPolicyRouteTest, AScriptSettingADeferredHostVariableIsJudgedAsResolved) {
    const vayu::tests::EchoServer echo;
    const std::string url = "http://{{host}}:" + std::to_string (echo.port ()) + "/echo";
    seed_request (url, "pm.environment.set('host', 'localhost');");
    ASSERT_EQ (compose ().value ("deferredVariables", json ()), json::array ({ "host" }));

    const json refused = execute (policy_allowing ({ "127.0.0.1" }));
    EXPECT_EQ (refused.value ("refusalCode", ""), "target_not_allowed")
    << refused.dump ();
    EXPECT_EQ (echo.requests_seen (), 0);

    seed_request (url, "pm.environment.set('host', '127.0.0.1');");
    const json sent = execute (policy_allowing ({ "127.0.0.1" }));
    EXPECT_EQ (sent.value ("status", 0), 200) << sent.dump ();
    EXPECT_EQ (echo.requests_seen (), 1);
}

TEST_F (TargetPolicyRouteTest, AllowAllSendsWhereverTheScriptSteers) {
    const vayu::tests::EchoServer echo;
    seed_request ("http://localhost:" + std::to_string (echo.port ()) + "/echo",
    steer_to (echo, "127.0.0.1"));

    const json answer = execute (json{ { "allowAll", true } });

    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (echo.requests_seen (), 1);
}

TEST_F (TargetPolicyRouteTest, AHostNothingAnsweredIsRefusedEvenUnderAllowAll) {
    const vayu::tests::EchoServer echo;
    seed_request ("http://{{nowhere}}/echo", "pm.environment.set('unrelated', '1');");

    const json answer = execute (json{ { "allowAll", true } });

    EXPECT_EQ (answer.value ("refusalCode", ""), "target_host_unknown")
    << answer.dump ();
    EXPECT_EQ (echo.requests_seen (), 0);
}

// Absent, the send goes where the script steers, as it always has.
TEST_F (TargetPolicyRouteTest, NoPolicySendsWhereverTheScriptSteers) {
    const vayu::tests::EchoServer echo;
    seed_request ("http://localhost:" + std::to_string (echo.port ()) + "/echo",
    steer_to (echo, "127.0.0.1"));

    const auto [status, answer] = post ("/execute", compose ());

    EXPECT_EQ (status, 200) << answer.dump ();
    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (echo.requests_seen (), 1);
}

// The streaming send runs its own pre-request script and refuses before its
// stream opens, under the same code and with its run row failed.
TEST_F (TargetPolicyRouteTest, AStreamingSendSteeredOffTheListIsRefusedBeforeItOpens) {
    const vayu::tests::EchoServer echo;
    seed_request (echo.url (), steer_to (echo, "localhost"));
    json payload            = compose ();
    payload["targetPolicy"] = policy_allowing ({ "127.0.0.1" });
    payload["stream"]       = true;

    const auto [status, answer] = post ("/execute", payload);

    EXPECT_EQ (status, 400) << answer.dump ();
    EXPECT_EQ (error_code (answer), "target_not_allowed") << answer.dump ();
    EXPECT_EQ (echo.requests_seen (), 0);
}

TEST_F (TargetPolicyRouteTest, AMalformedPolicyIsA400OnBothRoutes) {
    const vayu::tests::EchoServer echo;
    seed_request (echo.url (), "pm.environment.set('unrelated', '1');");
    const json malformed{ { "allowAll", "true" } };

    json send                                   = compose ();
    send["targetPolicy"]                        = malformed;
    const auto [execute_status, execute_answer] = post ("/execute", send);
    EXPECT_EQ (execute_status, 400) << execute_answer.dump ();
    EXPECT_EQ (error_code (execute_answer), "invalid_target_policy");

    const auto [run_status, run_answer] = post ("/runs", single_request_run (malformed));
    EXPECT_EQ (run_status, 400) << run_answer.dump ();
    EXPECT_EQ (error_code (run_answer), "invalid_target_policy");
    EXPECT_EQ (echo.requests_seen (), 0);
}

// The policy governs the send and is never stored: neither a send's snapshot
// nor a run's carries it.
TEST_F (TargetPolicyRouteTest, ThePolicyIsNotStoredInARunsSnapshot) {
    const vayu::tests::EchoServer echo;
    seed_request (echo.url (), "pm.environment.set('unrelated', '1');");
    const json policy = policy_allowing ({ "127.0.0.1", "policy-marker.example" });

    execute (policy);
    const std::string run_id = run_to_the_end (single_request_run (policy));

    for (const auto& run : db_->get_all_runs ()) {
        EXPECT_EQ (run.config_snapshot.find ("policy-marker"), std::string::npos)
        << run.id << ": " << run.config_snapshot;
    }
    EXPECT_FALSE (run_id.empty ());
    EXPECT_EQ (echo.requests_seen (), 2);
}

// A single-request load run's inline script runs per submission, and the event
// loop judges what it left before dialling.
TEST_F (TargetPolicyRouteTest, ALoadSubmissionSteeredOffTheListIsRefusedAndAListedOneSent) {
    const vayu::tests::EchoServer echo;
    seed_request (echo.url (), steer_to (echo, "localhost"), /*inline_script=*/true);

    const std::string refused =
    run_to_the_end (single_request_run (policy_allowing ({ "127.0.0.1" })));
    EXPECT_EQ (echo.requests_seen (), 0) << "the steered submission went out";
    EXPECT_NE (result_errors (refused).find ("\"localhost\""), std::string::npos)
    << result_errors (refused);

    seed_request (echo.url (), steer_to (echo, "127.0.0.1"), /*inline_script=*/true);
    run_to_the_end (single_request_run (policy_allowing ({ "127.0.0.1" })));
    EXPECT_EQ (echo.requests_seen (), 1);
}

// A collection run's step is a design send; the same script steers it.
TEST_F (TargetPolicyRouteTest, ACollectionRunStepSteeredOffTheListIsRefused) {
    const vayu::tests::EchoServer echo;
    seed_request (echo.url (), steer_to (echo, "localhost"));

    const std::string refused =
    run_to_the_end (collection_run (policy_allowing ({ "127.0.0.1" }), false));
    EXPECT_EQ (echo.requests_seen (), 0) << "the steered step went out";
    EXPECT_NE (result_errors (refused).find ("\"localhost\""), std::string::npos)
    << result_errors (refused);

    seed_request (echo.url (), steer_to (echo, "127.0.0.1"));
    run_to_the_end (collection_run (policy_allowing ({ "127.0.0.1" }), false));
    EXPECT_EQ (echo.requests_seen (), 1);
}

TEST_F (TargetPolicyRouteTest, AScenarioLoadStepSteeredOffTheListIsRefused) {
    const vayu::tests::EchoServer echo;
    seed_request (echo.url (), steer_to (echo, "localhost"), /*inline_script=*/true);

    run_to_the_end (collection_run (policy_allowing ({ "127.0.0.1" }), true));
    EXPECT_EQ (echo.requests_seen (), 0) << "the steered step went out";

    seed_request (echo.url (), steer_to (echo, "127.0.0.1"), /*inline_script=*/true);
    run_to_the_end (collection_run (policy_allowing ({ "127.0.0.1" }), true));
    EXPECT_EQ (echo.requests_seen (), 1);
}

// --- The OAuth 2.0 token endpoint ---------------------------------------------

// The token request is a send too: a script that moves the `accessTokenUrl` off
// the list is refused before the token server or the target sees anything.
TEST_F (TargetPolicyRouteTest, AScriptSteeringTheTokenUrlOffTheListIsRefusedBeforeTheTokenRequest) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_request (echo.url (),
    "pm.environment.set('tokenUrl', '" + token_url (tokens, "localhost") + "');",
    false, client_credentials ("{{tokenUrl}}"));

    const json answer = execute (policy_allowing ({ "127.0.0.1" }));

    EXPECT_EQ (tokens.hits (), 0) << "the steered token request went out";
    EXPECT_EQ (echo.requests_seen (), 0);
    EXPECT_EQ (answer.value ("status", -1), 0) << answer.dump ();
    EXPECT_EQ (answer.value ("refusalCode", ""), "target_not_allowed") << answer.dump ();
    const std::string message = answer.value ("errorMessage", "");
    EXPECT_NE (message.find ("accessTokenUrl"), std::string::npos) << message;
    EXPECT_NE (message.find ("\"localhost\""), std::string::npos) << message;
}

TEST_F (TargetPolicyRouteTest, AScriptSettingAListedTokenUrlAcquiresAndAppliesTheToken) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_request (echo.url (),
    "pm.environment.set('tokenUrl', '" + tokens.url ("/token") + "');", false,
    client_credentials ("{{tokenUrl}}"));

    const json answer = execute (policy_allowing ({ "127.0.0.1" }));

    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (tokens.hits (), 1);
    EXPECT_EQ (echo.header ("Authorization"), "Bearer AT1");
}

TEST_F (TargetPolicyRouteTest, AllowAllAcquiresFromWhicheverTokenUrlTheScriptSets) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_request (echo.url (),
    "pm.environment.set('tokenUrl', '" + tokens.url ("/token") + "');", false,
    client_credentials ("{{tokenUrl}}"));

    const json answer = execute (json{ { "allowAll", true } });

    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (tokens.hits (), 1);
}

TEST_F (TargetPolicyRouteTest, NoPolicyAcquiresFromWhicheverTokenUrlTheScriptSets) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_request (echo.url (),
    "pm.environment.set('tokenUrl', '" + tokens.url ("/token") + "');", false,
    client_credentials ("{{tokenUrl}}"));

    const auto [status, answer] = post ("/execute", compose ());

    EXPECT_EQ (status, 200) << answer.dump ();
    EXPECT_EQ (answer.value ("status", 0), 200) << answer.dump ();
    EXPECT_EQ (tokens.hits (), 1);
}

TEST_F (TargetPolicyRouteTest, AStreamingSendWhoseScriptSteersTheTokenUrlIsRefusedBeforeItOpens) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_request (echo.url (),
    "pm.environment.set('tokenUrl', '" + token_url (tokens, "localhost") + "');",
    false, client_credentials ("{{tokenUrl}}"));
    json payload            = compose ();
    payload["targetPolicy"] = policy_allowing ({ "127.0.0.1" });
    payload["stream"]       = true;

    const auto [status, answer] = post ("/execute", payload);

    EXPECT_EQ (status, 400) << answer.dump ();
    EXPECT_EQ (error_code (answer), "target_not_allowed") << answer.dump ();
    EXPECT_EQ (tokens.hits (), 0);
    EXPECT_EQ (echo.requests_seen (), 0);
}

// Unscripted, the token is acquired when the request is built, and the same
// rule holds there, in the same answer shapes.
TEST_F (TargetPolicyRouteTest, AnUnscriptedTokenUrlOffTheListIsRefusedAtTheBuild) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_request (echo.url (), "", false,
    client_credentials (token_url (tokens, "localhost")));

    const json answer = execute (policy_allowing ({ "127.0.0.1" }));
    EXPECT_EQ (answer.value ("status", -1), 0) << answer.dump ();
    EXPECT_EQ (answer.value ("refusalCode", ""), "target_not_allowed") << answer.dump ();
    EXPECT_FALSE (answer.contains ("authErrorCode")) << answer.dump ();

    json stream            = compose ();
    stream["targetPolicy"] = policy_allowing ({ "127.0.0.1" });
    stream["stream"]       = true;
    const auto [stream_status, stream_answer] = post ("/execute", stream);
    EXPECT_EQ (stream_status, 400) << stream_answer.dump ();
    EXPECT_EQ (error_code (stream_answer), "target_not_allowed")
    << stream_answer.dump ();

    EXPECT_EQ (tokens.hits (), 0);
    EXPECT_EQ (echo.requests_seen (), 0);
}

// Judged before the cache is read: a token an earlier send cached for the
// refused endpoint is not carried to the target either.
TEST_F (TargetPolicyRouteTest, ACachedTokenForARefusedTokenUrlIsNotSent) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    const json auth = client_credentials (token_url (tokens, "localhost"));
    seed_request (echo.url (), "", false, auth);
    vayu::db::OAuthToken cached;
    cached.cache_key    = vayu::http::oauth::cache_key (auth["config"]);
    cached.access_token = "CACHED";
    cached.token_type   = "Bearer";
    cached.created_at   = 1;
    db_->save_oauth_token (cached);

    const json answer = execute (policy_allowing ({ "127.0.0.1" }));

    EXPECT_EQ (answer.value ("refusalCode", ""), "target_not_allowed") << answer.dump ();
    EXPECT_EQ (tokens.hits (), 0);
    EXPECT_EQ (echo.requests_seen (), 0);
}

// A run acquires before it exists: the pre-flight of a single-request run and
// the plan of a collection run, sequential or under load, are each a 400 under
// the policy's code with no run behind it.
TEST_F (TargetPolicyRouteTest, ARunWhoseTokenUrlIsOffTheListIsRefusedBeforeItStarts) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_request (echo.url (), "", false,
    client_credentials (token_url (tokens, "localhost")));
    const json policy = policy_allowing ({ "127.0.0.1" });

    json single = compose ();
    single.erase ("elements");
    single.update ({ { "mode", "iterations" }, { "iterations", 1 },
    { "concurrency", 1 }, { "targetPolicy", policy } });
    for (const json& payload :
    { single, collection_run (policy, false), collection_run (policy, true) }) {
        const auto [status, answer] = post ("/runs", payload);
        EXPECT_EQ (status, 400) << answer.dump ();
        EXPECT_EQ (error_code (answer), "target_not_allowed") << answer.dump ();
    }
    EXPECT_TRUE (db_->get_all_runs ().empty ());
    EXPECT_EQ (tokens.hits (), 0);
    EXPECT_EQ (echo.requests_seen (), 0);
}

// The sequential runner acquires a scripted step's token at its send, after
// the script: the step is refused there and the token server sees nothing.
TEST_F (TargetPolicyRouteTest, ACollectionRunStepWhoseScriptSteersTheTokenUrlIsRefused) {
    const vayu::tests::EchoServer echo;
    const MockTokenServer tokens;
    seed_request (echo.url (),
    "pm.environment.set('tokenUrl', '" + token_url (tokens, "localhost") + "');",
    false, client_credentials ("{{tokenUrl}}"));

    const std::string refused =
    run_to_the_end (collection_run (policy_allowing ({ "127.0.0.1" }), false));
    EXPECT_EQ (tokens.hits (), 0) << "the steered token request went out";
    EXPECT_EQ (echo.requests_seen (), 0);
    EXPECT_NE (result_errors (refused).find ("accessTokenUrl"), std::string::npos)
    << result_errors (refused);
}
