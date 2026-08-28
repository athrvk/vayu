/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/send_with_row_test.cpp
 * @brief `POST /execute`'s `data` row - send with one row, bound (issue #601).
 *
 * A pre-request script reading `pm.iterationData` was untestable without
 * launching a whole collection run: the row only ever arrived through a
 * scenario, so the one-request iteration loop of writing a script was "start a
 * run, find the step, read the result". `data` on the execute payload closes
 * that: one row, bound into the request the same binder a run uses, and read by
 * both scripts as `pm.iterationData`.
 *
 * Four things are pinned here, and they are the four the route composes:
 *
 * 1. `read_data_row` - the payload says what the row is, and says so in a way
 *    that fails loudly when it is malformed. A row the engine could not read
 *    must never become a send with `{{data.x}}` still written in it.
 * 2. `bind_data_row` reaching the wire, through the real client against the
 *    echo server: the URL, a header and the body come back substituted. The
 *    binder itself is covered exhaustively in scenario_data_test.cpp - what is
 *    new here is that a single send drives it at all.
 * 3. `iteration_data` on the exchange's contexts, so `pm.iterationData.get`
 *    answers in a pre-request script and in a test script - and is `undefined`
 *    on a send that named no row, which is the fact a script branches on.
 * 4. The **credentials** binding too (issue #642). This endpoint used to refuse
 *    a `{{data.*}}` in an auth field, because `build_request` had already
 *    collapsed basic credentials into one base64 header by the time the row was
 *    in hand. `plan_send_row_auth` decides that before the build instead, the
 *    build defers, and `bind_auth_row` - the same join-then-apply a scenario
 *    step drives per iteration - applies them once the row has reached them.
 *
 * What is NOT covered here: that the route rejects before `create_run`. The
 * suite has no in-process HTTP route harness (see run_route_test.cpp), so that
 * ordering is held by the call site - the bind block in execution.cpp sits
 * above the `ctx.db.create_run` call and every later step reads the `run_id`
 * optional it never sets.
 */

#include <gtest/gtest.h>

#include <memory>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "optional_assert.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/encoding.hpp"

namespace {

using nlohmann::json;
using vayu::core::bind_auth_row;
using vayu::core::bind_data_row;
using vayu::http::routes::plan_send_row_auth;
using vayu::http::routes::read_data_row;
using vayu::http::routes::read_stream_flag;
using vayu::http::routes::read_transient_flag;

/// The engine's seeded `maxScenarioDataBytes`, as the route resolves it.
constexpr size_t kDataBytes = size_t{ 16 } * 1024 * 1024;

// --- read_data_row -----------------------------------------------------------

TEST (ReadDataRow, AbsentIsNoRow) {
    auto row = read_data_row (json{ { "method", "GET" }, { "url", "http://x/" } }, kDataBytes);
    EXPECT_TRUE (row.ok);
    EXPECT_FALSE (row.value.has_value ());
}

TEST (ReadDataRow, NullIsNoRow) {
    auto row = read_data_row (json{ { "data", nullptr } }, kDataBytes);
    EXPECT_TRUE (row.ok);
    EXPECT_FALSE (row.value.has_value ());
}

TEST (ReadDataRow, ObjectIsTheRow) {
    auto row = read_data_row (
    json{ { "data", { { "id", "7" }, { "email", "a@b.c" } } } }, kDataBytes);
    ASSERT_TRUE (row.ok);
    ASSERT_HAS_VALUE (row.value);
    EXPECT_EQ ((*row.value)["id"], "7");
    EXPECT_EQ ((*row.value)["email"], "a@b.c");
}

/// An empty object is a row, not an absent one: `pm.iterationData` must read as
/// a scope answering `undefined` per key, never as `undefined` itself - those
/// are different facts and `if (pm.iterationData)` branches on the difference.
TEST (ReadDataRow, EmptyObjectIsStillARow) {
    auto row = read_data_row (json{ { "data", json::object () } }, kDataBytes);
    ASSERT_TRUE (row.ok);
    EXPECT_TRUE (row.value.has_value ());
}

/// The near miss is an array - the shape `scenario.data` takes - so the message
/// has to say that a single send binds one row rather than a set.
TEST (ReadDataRow, ArrayIsRefusedAndSaysWhy) {
    auto row =
    read_data_row (json{ { "data", json::array ({ json::object () }) } }, kDataBytes);
    EXPECT_FALSE (row.ok);
    EXPECT_NE (row.error.find ("name/value pairs"), std::string::npos);
    EXPECT_NE (row.error.find ("collection run"), std::string::npos);
    EXPECT_FALSE (row.value.has_value ());
}

TEST (ReadDataRow, ScalarIsRefused) {
    for (const auto& value : { json ("id=7"), json (7), json (true) }) {
        auto row = read_data_row (json{ { "data", value } }, kDataBytes);
        EXPECT_FALSE (row.ok) << value.dump ();
        EXPECT_FALSE (row.value.has_value ());
    }
}

/// The cap the run's whole set is measured against, applied to the one row -
/// and it must name the setting, or a user cannot tell which side refused.
TEST (ReadDataRow, OverTheByteCapIsRefusedByName) {
    const json payload{ { "data", { { "blob", std::string (128, 'x') } } } };
    auto row = read_data_row (payload, 64);
    EXPECT_FALSE (row.ok);
    EXPECT_NE (row.error.find ("maxScenarioDataBytes"), std::string::npos);
    EXPECT_FALSE (row.value.has_value ());

    // The same payload under the seeded cap is fine, so the refusal above is
    // the bound and not the shape.
    EXPECT_TRUE (read_data_row (payload, kDataBytes).ok);
}

/// `transient` + `data` and `stream` + `data` both compose: the row is read the
/// same way and neither flag refuses it. Nothing in the payload couples them.
TEST (ReadDataRow, ComposesWithTransientAndStream) {
    const json transient_payload{ { "transient", true }, { "data", { { "id", "7" } } } };
    EXPECT_TRUE (read_transient_flag (transient_payload).value);
    EXPECT_TRUE (read_data_row (transient_payload, kDataBytes).value.has_value ());

    const json stream_payload{ { "stream", true }, { "data", { { "id", "7" } } } };
    auto stream = read_stream_flag (stream_payload);
    EXPECT_TRUE (stream.ok);
    EXPECT_TRUE (stream.value);
    EXPECT_TRUE (read_data_row (stream_payload, kDataBytes).value.has_value ());
}

// --- how the credentials resolve (issue #642) --------------------------------

/// Every credential static: the build resolves auth exactly as it always did,
/// and nothing is deferred. This is the ordinary authenticated send, and it is
/// the case that must not change shape now that another one exists.
TEST (SendWithRowAuth, StaticCredentialsResolveInTheBuild) {
    const json payload{ { "auth",
    { { "mode", "basic" }, { "username", "ada" }, { "password", "s3cret" } } } };

    const auto plan = plan_send_row_auth (payload, true);
    EXPECT_TRUE (plan.ok);
    EXPECT_TRUE (plan.credentials.empty ());
    EXPECT_EQ (plan.resolution, vayu::http::AuthResolution::Apply);
}

TEST (SendWithRowAuth, AbsentAuthResolvesInTheBuild) {
    for (const auto& payload :
    { json{ { "url", "http://x/" } }, json{ { "auth", nullptr } } }) {
        const auto plan = plan_send_row_auth (payload, true);
        EXPECT_TRUE (plan.ok);
        EXPECT_TRUE (plan.credentials.empty ());
        EXPECT_EQ (plan.resolution, vayu::http::AuthResolution::Apply);
    }
}

/// A credential carrying a row value defers, which is the whole feature: the
/// build leaves the credentials alone so the row can reach them before
/// `apply_auth` collapses them into one base64 header.
TEST (SendWithRowAuth, CredentialTokenDefersTheAuth) {
    const json payload{ { "auth",
    { { "mode", "basic" }, { "username", "{{data.user}}" }, { "password", "s3cret" } } } };

    const auto plan = plan_send_row_auth (payload, true);
    ASSERT_TRUE (plan.ok);
    EXPECT_FALSE (plan.credentials.empty ());
    EXPECT_EQ (plan.resolution, vayu::http::AuthResolution::Defer);
    EXPECT_EQ (plan.credentials.first_data_token ().value_or (""), "{{data.user}}");
}

/// Without a row there is nothing to bind against, so the token keeps the
/// behaviour it has always had here rather than becoming a refusal or a
/// deferral that never applies - a deferred build whose auth is never applied
/// would send the request unauthenticated.
TEST (SendWithRowAuth, NoRowNeverDefers) {
    const json payload{ { "auth",
    { { "mode", "basic" }, { "username", "{{data.user}}" }, { "password", "s3cret" } } } };

    const auto plan = plan_send_row_auth (payload, false);
    EXPECT_TRUE (plan.ok);
    EXPECT_TRUE (plan.credentials.empty ());
    EXPECT_EQ (plan.resolution, vayu::http::AuthResolution::Apply);
}

/// An ordinary `{{user}}` is not a data token - it is a variable composition
/// already resolved, and deferring it would defer every authenticated send.
TEST (SendWithRowAuth, OrdinaryVariableIsNotADataToken) {
    const json payload{ { "auth", { { "mode", "bearer" }, { "token", "{{apiToken}}" } } } };

    const auto plan = plan_send_row_auth (payload, true);
    EXPECT_TRUE (plan.ok);
    EXPECT_TRUE (plan.credentials.empty ());
    EXPECT_EQ (plan.resolution, vayu::http::AuthResolution::Apply);
}

/// OAuth 2.0 is the one mode no deferral can serve, and it stays refused by
/// name: the token is acquired against the token endpoint, not written into the
/// request, so there is no later moment at which a row could reach it.
TEST (SendWithRowAuth, Oauth2DataTokenIsRefusedByName) {
    const json payload{ { "auth",
    { { "mode", "oauth2" },
    { "config",
    { { "grantType", "client_credentials" }, { "clientId", "{{data.client}}" },
    { "tokenUrl", "https://issuer.example/token" } } } } } };

    const auto plan = plan_send_row_auth (payload, true);
    ASSERT_FALSE (plan.ok);
    EXPECT_NE (plan.error.find ("{{data.client}}"), std::string::npos);
    EXPECT_NE (plan.error.find ("OAuth 2.0"), std::string::npos);
    // The message has to say *why* no row can serve it, or "not supported" is
    // the only thing a reader takes from it.
    EXPECT_NE (plan.error.find ("token endpoint"), std::string::npos);
}

/// The refusal is scoped to the mode, not to the endpoint: an oauth2 config
/// with no data token in it is an ordinary send that happens to carry a row.
TEST (SendWithRowAuth, Oauth2WithoutADataTokenIsNotRefused) {
    const json payload{ { "auth",
    { { "mode", "oauth2" },
    { "config",
    { { "grantType", "client_credentials" }, { "clientId", "static-client" },
    { "tokenUrl", "https://issuer.example/token" } } } } } };

    const auto plan = plan_send_row_auth (payload, true);
    EXPECT_TRUE (plan.ok);
    EXPECT_EQ (plan.resolution, vayu::http::AuthResolution::Apply);
}

// --- the bind, end to end ----------------------------------------------------

class SendWithRowTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server_ = std::make_unique<vayu::tests::EchoServer> ();
    }

    void TearDown () override {
        server_.reset ();
        vayu::http::global_cleanup ();
    }

    /// One exchange, exactly as the route runs it: scripts bracket a real send.
    vayu::http::routes::ExchangeOutcome send (vayu::Request request,
    const json* row,
    const std::string& pre,
    const std::string& post) {
        vayu::runtime::ScriptEngine engine;
        vayu::http::CookieJar jar;
        vayu::http::routes::ScriptVariableScopes scopes;

        vayu::http::routes::ExchangeInputs inputs;
        inputs.request     = std::move (request);
        inputs.pre_script  = pre;
        inputs.post_script = post;
        if (row != nullptr) {
            inputs.iteration_data  = row;
            inputs.iteration       = 0;
            inputs.iteration_count = 1;
        }
        return execute_exchange (engine, jar, "", scopes, std::move (inputs), false);
    }

    /// What the route's pre-send sequence produced for a payload carrying a
    /// row: either the request it would send, or the message it would answer
    /// `400` with.
    struct RowSend {
        bool ok = true;
        std::string error;
        vayu::Request request;
    };

    /// The route's sequence over a payload that carries a row - plan the
    /// credentials, build, bind the request, bind the credentials - in the
    /// order execution.cpp runs it. Driven here rather than hand-ordered per
    /// test because the *order* is what these tests are about: a credential
    /// bound after `apply_auth` is a credential bound too late.
    static RowSend build_with_row (const json& payload, const json& row) {
        RowSend out;

        const auto plan = plan_send_row_auth (payload, true);
        if (!plan.ok) {
            return RowSend{ false, plan.error, {} };
        }

        auto built = vayu::http::build_request (payload, nullptr, 10000, plan.resolution);
        if (built.parse_failed || !built.ok) {
            return RowSend{ false, built.error_message, {} };
        }
        out.request = std::move (built.request);

        auto bound = bind_data_row (out.request, row, 0);
        if (bound.ok) {
            bound = bind_auth_row (out.request, plan.auth, plan.credentials, row, 0);
        }
        out.ok    = bound.ok;
        out.error = bound.error;
        return out;
    }

    /// `pm.test` around one assertion, so a failed assertion reports its own
    /// message rather than an execution error.
    static std::string assertion (const std::string& body) {
        return "pm.test(\"row\", function() { " + body + " });";
    }

    static void expect_passed (const vayu::ScriptResult& result) {
        EXPECT_TRUE (result.success) << result.error_message;
        ASSERT_EQ (result.tests.size (), 1u);
        EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    }

    std::unique_ptr<vayu::tests::EchoServer> server_;
};

/// The whole point: the bound values are what the server receives. Asserted
/// against the echo server's record rather than against the request object, so
/// a bind that reached the struct but not the wire would still be red.
TEST_F (SendWithRowTest, BoundValuesReachTheWire) {
    vayu::Request request;
    request.method              = vayu::HttpMethod::POST;
    request.url                 = server_->url () + "/users/{{data.id}}";
    request.headers["X-Tenant"] = "{{data.tenant}}";
    request.body.mode           = vayu::BodyMode::Json;
    request.body.content        = R"({"email":"{{data.email}}"})";

    const json row{ { "id", "7" }, { "tenant", "acme" }, { "email", "ada@example.com" } };
    ASSERT_TRUE (bind_data_row (request, row, 0).ok);

    auto outcome = send (request, &row, "", "");
    ASSERT_EQ (outcome.response.status_code, 200);

    EXPECT_EQ (server_->path (), "/echo/users/7");
    EXPECT_EQ (server_->header ("X-Tenant"), "acme");
    EXPECT_EQ (server_->body (), R"({"email":"ada@example.com"})");
}

/// A column the row does not carry fails the bind, and the message names the
/// token *and* the columns that do exist - which is what lets the request be
/// fixed without opening the file. The route turns this into its 400.
TEST_F (SendWithRowTest, MissingColumnFailsTheBindByName) {
    vayu::Request request;
    request.url = server_->url () + "/users/{{data.id}}";

    const auto bound = bind_data_row (request, json{ { "email", "a@b.c" } }, 0);
    EXPECT_FALSE (bound.ok);
    EXPECT_NE (bound.error.find ("data.id"), std::string::npos);
    EXPECT_NE (bound.error.find ("email"), std::string::npos);
}

// --- credentials on the wire (issue #642) ------------------------------------
//
// Every one of these asserts against what the echo server *received*. A bind
// that reached the `Auth` struct but not the transfer is the exact defect this
// endpoint used to refuse rather than risk, so asserting the struct would
// assert the wrong half. Mutation check: move the `apply_auth` back into the
// build (`AuthResolution::Apply` in `plan_send_row_auth`) and the three binding
// tests go red together - the header arrives as base64 of `{{data.user}}:...`.

/// Basic auth, the canonical credentials-file case: both halves come from the
/// row, and the header the server receives decodes to the row's values rather
/// than to the tokens' text.
TEST_F (SendWithRowTest, BasicCredentialsBindBeforeTheyAreEncoded) {
    const json payload{ { "method", "GET" }, { "url", server_->url () },
        { "auth",
        { { "mode", "basic" }, { "username", "{{data.user}}" },
        { "password", "{{data.pass}}" } } } };
    const json row{ { "user", "ada" }, { "pass", "s3cr3t:7" } };

    auto prepared = build_with_row (payload, row);
    ASSERT_TRUE (prepared.ok) << prepared.error;

    auto outcome = send (std::move (prepared.request), &row, "", "");
    ASSERT_EQ (outcome.response.status_code, 200);

    const std::string header = server_->header ("Authorization");
    ASSERT_EQ (header.rfind ("Basic ", 0), 0u) << header;
    const auto decoded = vayu::utils::base64_decode (header.substr (6));
    ASSERT_HAS_VALUE (decoded) << header;
    // A colon in the password is why this decodes rather than string-matches:
    // the base64 is of `user:pass` joined, and the row is allowed to contain
    // the separator.
    EXPECT_EQ (*decoded, "ada:s3cr3t:7");
}

TEST_F (SendWithRowTest, BearerCredentialBindsToTheRow) {
    const json payload{ { "method", "GET" }, { "url", server_->url () },
        { "auth", { { "mode", "bearer" }, { "token", "{{data.token}}" } } } };
    const json row{ { "token", "t-7" } };

    auto prepared = build_with_row (payload, row);
    ASSERT_TRUE (prepared.ok) << prepared.error;

    auto outcome = send (std::move (prepared.request), &row, "", "");
    ASSERT_EQ (outcome.response.status_code, 200);
    EXPECT_EQ (server_->header ("Authorization"), "Bearer t-7");
}

TEST_F (SendWithRowTest, ApiKeyHeaderBindsBothHalves) {
    const json payload{ { "method", "GET" }, { "url", server_->url () },
        { "auth", { { "mode", "apikey" }, { "key", "X-{{data.header}}" }, { "value", "{{data.key}}" } } } };
    const json row{ { "header", "Tenant-Key" }, { "key", "k-7" } };

    auto prepared = build_with_row (payload, row);
    ASSERT_TRUE (prepared.ok) << prepared.error;

    auto outcome = send (std::move (prepared.request), &row, "", "");
    ASSERT_EQ (outcome.response.status_code, 200);
    EXPECT_EQ (server_->header ("X-Tenant-Key"), "k-7");
}

/// An api key in the query is the case that proves the *ordering* rather than
/// just the substitution: percent-encoding is `apply_auth`'s to add after the
/// bind, so a row value containing a reserved character arrives encoded - which
/// binding after the auth had been applied could not produce.
TEST_F (SendWithRowTest, ApiKeyInQueryIsEncodedAfterTheBind) {
    const json payload{ { "method", "GET" }, { "url", server_->url () },
        { "auth",
        { { "mode", "apikey" }, { "key", "token" }, { "value", "{{data.key}}" },
        { "in", "query" } } } };
    const json row{ { "key", "a b&c" } };

    auto prepared = build_with_row (payload, row);
    ASSERT_TRUE (prepared.ok) << prepared.error;

    auto outcome = send (std::move (prepared.request), &row, "", "");
    ASSERT_EQ (outcome.response.status_code, 200);
    EXPECT_NE (server_->target ().find ("token=a%20b%26c"), std::string::npos)
    << server_->target ();
}

/// A credential naming a column the row lacks fails the same way a URL token
/// does, and the route turns it into the same 400 - nothing is sent.
TEST_F (SendWithRowTest, MissingCredentialColumnFailsTheBind) {
    const json payload{ { "method", "GET" }, { "url", server_->url () },
        { "auth", { { "mode", "basic" }, { "username", "{{data.user}}" }, { "password", "static" } } } };

    const auto prepared = build_with_row (payload, json{ { "tenant", "acme" } });
    EXPECT_FALSE (prepared.ok);
    EXPECT_NE (prepared.error.find ("data.user"), std::string::npos);
    EXPECT_NE (prepared.error.find ("tenant"), std::string::npos);
    // Nothing reached the server: the failure is decided before any transfer.
    EXPECT_TRUE (server_->path ().empty ());
}

/// The request's own tokens and its credentials bind from one row, in one send.
TEST_F (SendWithRowTest, RequestAndCredentialsBindFromTheSameRow) {
    const json payload{ { "method", "GET" }, { "url", server_->url () + "/users/{{data.id}}" },
        { "auth", { { "mode", "bearer" }, { "token", "{{data.token}}" } } } };
    const json row{ { "id", "7" }, { "token", "t-7" } };

    auto prepared = build_with_row (payload, row);
    ASSERT_TRUE (prepared.ok) << prepared.error;

    auto outcome = send (std::move (prepared.request), &row, "", "");
    ASSERT_EQ (outcome.response.status_code, 200);
    EXPECT_EQ (server_->path (), "/echo/users/7");
    EXPECT_EQ (server_->header ("Authorization"), "Bearer t-7");
}

/// A static credential still resolves inside the build on a send that carries a
/// row - the deferral is per-payload, not per-endpoint.
TEST_F (SendWithRowTest, StaticCredentialsStillResolveInTheBuild) {
    const json payload{ { "method", "GET" }, { "url", server_->url () + "/users/{{data.id}}" },
        { "auth", { { "mode", "bearer" }, { "token", "static-token" } } } };
    const json row{ { "id", "7" } };

    auto prepared = build_with_row (payload, row);
    ASSERT_TRUE (prepared.ok) << prepared.error;

    auto outcome = send (std::move (prepared.request), &row, "", "");
    ASSERT_EQ (outcome.response.status_code, 200);
    EXPECT_EQ (server_->path (), "/echo/users/7");
    EXPECT_EQ (server_->header ("Authorization"), "Bearer static-token");
}

/// The motivating gap, closed: a pre-request script reads the row on a single
/// send. Mutation-checked - dropping `ctx.iteration_data = inputs.iteration_data`
/// from `execute_exchange` makes `pm.iterationData.get` throw "not available
/// here", and this test and the next one go red together.
TEST_F (SendWithRowTest, PreRequestScriptReadsTheRow) {
    vayu::Request request;
    request.url = server_->url ();

    const json row{ { "email", "ada@example.com" } };
    auto outcome = send (request,
    &row, assertion ("pm.expect(pm.iterationData.get(\"email\")).to.eql(\"ada@example.com\");"),
    "");
    expect_passed (outcome.pre_script_result);
}

/// Both scripts of the send read the same row - a test script asserting against
/// the row its request was built from is half of why the row is here at all.
TEST_F (SendWithRowTest, TestScriptReadsTheSameRow) {
    vayu::Request request;
    request.url = server_->url ();

    const json row{ { "id", "7" } };
    auto outcome = send (request, &row, "",
    assertion ("pm.expect(pm.iterationData.get(\"id\")).to.eql(\"7\");"
               "pm.expect(pm.iterationData.has(\"nope\")).to.eql(false);"
               "pm.expect(pm.iterationData.toObject().id).to.eql(\"7\");"));
    expect_passed (outcome.post_script_result);
}

/// A send with a row is iteration 0 of 1 - the row it bound. An invented index
/// on a send that bound nothing would be the binding that cannot fail (#300),
/// which is why the next test pins the other direction.
TEST_F (SendWithRowTest, RowMakesTheSendIterationZero) {
    vayu::Request request;
    request.url = server_->url ();

    const json row{ { "id", "7" } };
    auto outcome = send (request, &row,
    assertion ("pm.expect(pm.info.iteration).to.eql(0);"
               "pm.expect(pm.info.iterationCount).to.eql(1);"),
    "");
    expect_passed (outcome.pre_script_result);
}

/// Absence stays visible. `if (pm.iterationData)` is the guard a script writes,
/// and it only works while a send with no row reads `undefined` rather than an
/// empty scope - the same rule `pm.info.iteration` follows beside it.
TEST_F (SendWithRowTest, NoRowLeavesIterationDataUndefined) {
    vayu::Request request;
    request.url = server_->url ();

    auto outcome = send (request, nullptr,
    assertion ("pm.expect(typeof pm.iterationData).to.eql(\"undefined\");"
               "pm.expect(typeof pm.info.iteration).to.eql(\"undefined\");"),
    "");
    expect_passed (outcome.pre_script_result);
}

} // namespace
