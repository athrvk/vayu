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
 * Three things are pinned here, and they are the three the route composes:
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
#include "vayu/core/scenario_data.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

namespace {

using nlohmann::json;
using vayu::core::bind_data_row;
using vayu::http::routes::first_auth_data_token;
using vayu::http::routes::read_data_row;
using vayu::http::routes::read_stream_flag;
using vayu::http::routes::read_transient_flag;

/// The engine's seeded `maxScenarioDataBytes`, as the route resolves it.
constexpr size_t kDataBytes = 16 * 1024 * 1024;

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
    auto row = read_data_row (json{ { "data", { { "id", "7" }, { "email", "a@b.c" } } } },
    kDataBytes);
    ASSERT_TRUE (row.ok);
    ASSERT_TRUE (row.value.has_value ());
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
    auto row = read_data_row (json{ { "data", json::array ({ json::object () }) } }, kDataBytes);
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

// --- the auth refusal --------------------------------------------------------

TEST (SendWithRowAuth, PlainCredentialsCarryNoToken) {
    const json payload{ { "auth",
    { { "mode", "basic" }, { "basic", { { "username", "ada" }, { "password", "s3cret" } } } } } };
    EXPECT_FALSE (first_auth_data_token (payload).has_value ());
}

TEST (SendWithRowAuth, AbsentAuthCarriesNoToken) {
    EXPECT_FALSE (first_auth_data_token (json{ { "url", "http://x/" } }).has_value ());
    EXPECT_FALSE (first_auth_data_token (json{ { "auth", nullptr } }).has_value ());
}

/// The token is named back, because "your auth has a data token in it" without
/// saying which one is unactionable in a block with four credential fields.
TEST (SendWithRowAuth, CredentialTokenIsNamed) {
    const json payload{ { "auth",
    { { "mode", "basic" },
    { "basic", { { "username", "{{data.user}}" }, { "password", "s3cret" } } } } } };
    const auto token = first_auth_data_token (payload);
    ASSERT_TRUE (token.has_value ());
    EXPECT_EQ (*token, "{{data.user}}");
}

/// An ordinary `{{user}}` is not a data token - it is a variable composition
/// already resolved, and refusing it would refuse every authenticated send.
TEST (SendWithRowAuth, OrdinaryVariableIsNotADataToken) {
    const json payload{ { "auth",
    { { "mode", "bearer" }, { "bearer", { { "token", "{{apiToken}}" } } } } } };
    EXPECT_FALSE (first_auth_data_token (payload).has_value ());
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
    vayu::http::routes::ExchangeOutcome
    send (vayu::Request request, const json* row, const std::string& pre, const std::string& post) {
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
    request.method = vayu::HttpMethod::POST;
    request.url    = server_->url () + "/users/{{data.id}}";
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

/// The motivating gap, closed: a pre-request script reads the row on a single
/// send. Mutation-checked - dropping `ctx.iteration_data = inputs.iteration_data`
/// from `execute_exchange` makes `pm.iterationData.get` throw "not available
/// here", and this test and the next one go red together.
TEST_F (SendWithRowTest, PreRequestScriptReadsTheRow) {
    vayu::Request request;
    request.url = server_->url ();

    const json row{ { "email", "ada@example.com" } };
    auto outcome = send (request, &row,
    assertion ("pm.expect(pm.iterationData.get(\"email\")).to.eql(\"ada@example.com\");"), "");
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
