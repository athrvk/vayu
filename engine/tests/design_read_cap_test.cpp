/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/design_read_cap_test.cpp
 * @brief The design-mode read bound reaching the wire (issue #1157).
 *
 * `http_client_test.cpp` pins what the bound *does* - keep the prefix, or
 * refuse - by handing `Client` a `ClientConfig` directly. What it cannot see is
 * whether a design send ever sets that config, and that is the half with a
 * silent failure mode: an exchange that forgot to copy `max_response_bytes` off
 * its inputs reads everything, and every unit test on either side of it still
 * passes. So this drives `execute_exchange` - the one sequence `POST /execute`
 * and every collection-run step both run - against a server with a body larger
 * than the bound, and reads the response the route would have answered with.
 *
 * The other half of the chain, `maxDesignResponseBodyBytes` reaching the
 * inputs, is `config_route_test.cpp`'s two `design_response_body_bound` cases.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <memory>
#include <string>
#include <thread>
#include <utility>

#include "task_queue.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

namespace {

/// Bigger than curl's 16 KiB write buffer, so the bound below is reached
/// part-way through a body that arrives in several write-callback calls - a
/// single-call body would pass a check that only ever looked at the total.
constexpr size_t SERVED_BYTES = size_t{ 64 } * 1024;
/// What the exchange is told to read. Well under `SERVED_BYTES`, so what comes
/// back is a prefix rather than a rounding.
constexpr size_t READ_BOUND = size_t{ 4 } * 1024;
static_assert (READ_BOUND < SERVED_BYTES, "the bound must cut the body short");

/// Serves one oversized JSON body at `/big`.
class BigBodyServer {
    public:
    BigBodyServer () {
        // Two threads: this server answers one request per test.
        svr_.new_task_queue = vayu::tests::pooled_task_queue (2);
        svr_.Get ("/big", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (std::string (SERVED_BYTES, 'x'), "application/json");
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

    std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/big";
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
};

class DesignReadCapTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server_ = std::make_unique<BigBodyServer> ();
    }

    void TearDown () override {
        server_.reset ();
        vayu::http::global_cleanup ();
    }

    /// One exchange against the oversized body, reading at most @p bound.
    vayu::http::routes::ExchangeOutcome send (size_t bound) {
        vayu::runtime::ScriptEngine engine;
        vayu::http::CookieJar jar;
        vayu::http::routes::ScriptVariableScopes scopes;

        vayu::Request request;
        request.method = vayu::HttpMethod::GET;
        request.url    = server_->url ();

        vayu::http::routes::ExchangeInputs inputs;
        inputs.request            = std::move (request);
        inputs.max_response_bytes = bound;
        return execute_exchange (engine, jar, "", scopes, std::move (inputs), false);
    }

    std::unique_ptr<BigBodyServer> server_;
};

TEST_F (DesignReadCapTest, AnExchangeReadsNoMoreThanItsInputsAllow) {
    const auto outcome = send (READ_BOUND);

    // Not a failure: the status line and the headers arrived before the body
    // did, so the response the pane renders is the server's own, carrying a
    // prefix and the flag that says it is one.
    EXPECT_FALSE (outcome.response.has_error ());
    EXPECT_EQ (outcome.response.status_code, 200);
    EXPECT_EQ (outcome.response.body.size (), READ_BOUND);
    EXPECT_EQ (outcome.response.body_size, READ_BOUND);
    EXPECT_TRUE (outcome.response.body_truncated);
}

TEST_F (DesignReadCapTest, AnExchangeUnderItsBoundReadsTheWholeBody) {
    const auto outcome = send (SERVED_BYTES * 2);

    EXPECT_FALSE (outcome.response.has_error ());
    EXPECT_EQ (outcome.response.body.size (), SERVED_BYTES);
    // The flag drives a notice, so a false positive here warns about a response
    // that arrived whole.
    EXPECT_FALSE (outcome.response.body_truncated);
}

TEST_F (DesignReadCapTest, ACappedExchangeStoresTheFlagOnItsTrace) {
    const auto outcome = send (READ_BOUND);

    const auto trace =
    vayu::http::routes::build_result_trace (outcome.request, outcome.response);

    ASSERT_TRUE (trace["response"].contains ("bodyCapped"));
    EXPECT_TRUE (trace["response"]["bodyCapped"].get<bool> ());
    // What the pane shows and what History shows are the same bytes.
    EXPECT_EQ (trace["response"]["body"].get<std::string> ().size (), READ_BOUND);
}

} // namespace
