/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/element_body_bound_test.cpp
 * @brief `ExchangeInputs::max_element_body_bytes` reaching
 *        `ElementContext::max_body_bytes` (issue #1514's reopen).
 *
 * `element_kinds_test.cpp` pins what the bound *does* once it is on the
 * context - `ensure_parsed_body` skips a body past it - by setting
 * `ElementContext::max_body_bytes` directly. What it cannot see is whether a
 * real send ever copies the resolved `maxElementBodyBytes` setting onto that
 * context: before this issue, nothing did, so the field just kept its
 * compiled-in 1 MiB default forever, and `config_route_test.cpp`'s
 * `element_body_bound` cases only prove the setting resolves to a number, not
 * that anything downstream reads it. This drives `execute_exchange` - the one
 * sequence `POST /execute` and every collection-run step both run - against a
 * server whose JSON body straddles the bound, with a real `extract.json`
 * element attached, exactly the way `design_read_cap_test.cpp` drives the
 * design-mode read bound.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <memory>
#include <string>
#include <thread>
#include <utility>

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "task_queue.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"

namespace {

/// A valid JSON body just over 4 KiB once padded - big enough that a bound
/// well under it is a real gate, not a rounding.
constexpr size_t PADDING_BYTES = size_t{ 4 } * 1024;

std::string big_json_body () {
    return R"({"padding": ")" + std::string (PADDING_BYTES, 'x') + R"(", "value": "extracted-value"})";
}

/// Serves the body above at `/big`.
class BigJsonServer {
    public:
    BigJsonServer () {
        svr_.new_task_queue = vayu::tests::pooled_task_queue (2);
        svr_.Get ("/big", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content (big_json_body (), "application/json");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~BigJsonServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    BigJsonServer (const BigJsonServer&)            = delete;
    BigJsonServer& operator= (const BigJsonServer&) = delete;
    BigJsonServer (BigJsonServer&&)                 = delete;
    BigJsonServer& operator= (BigJsonServer&&)      = delete;

    std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/big";
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
};

class ElementBodyBoundTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server_ = std::make_unique<BigJsonServer> ();
    }

    void TearDown () override {
        server_.reset ();
        vayu::http::global_cleanup ();
    }

    /// One exchange against the big body, with an `extract.json` element
    /// bound to `maxElementBodyBytes` = @p bound.
    vayu::http::routes::ExchangeOutcome send (size_t bound) {
        vayu::runtime::ScriptEngine engine;
        vayu::http::CookieJar jar;
        vayu::http::routes::ScriptVariableScopes scopes;

        vayu::Request request;
        request.method = vayu::HttpMethod::GET;
        request.url    = server_->url ();

        vayu::http::routes::ExchangeInputs inputs;
        inputs.request  = std::move (request);
        inputs.elements = vayu::tests::compiled_elements (
        { vayu::tests::extract_json_element_json ("el1", "$.value", "extracted") });
        inputs.max_element_body_bytes = bound;
        return execute_exchange (engine, jar, "", scopes, std::move (inputs));
    }

    std::unique_ptr<BigJsonServer> server_;
};

TEST_F (ElementBodyBoundTest, ABodyOverTheBoundIsSkippedRatherThanParsed) {
    const auto outcome = send (PADDING_BYTES / 2);

    ASSERT_EQ (outcome.element_outcomes.size (), 1u);
    const auto& first = outcome.element_outcomes[0];
    EXPECT_EQ (first.status, "skipped");
    ASSERT_HAS_VALUE (first.message);
    EXPECT_NE (first.message->find ("maxElementBodyBytes"), std::string::npos);
}

TEST_F (ElementBodyBoundTest, ABodyUnderTheBoundIsParsedAndExtracted) {
    const auto outcome = send (PADDING_BYTES * 2);

    ASSERT_EQ (outcome.element_outcomes.size (), 1u);
    EXPECT_EQ (outcome.element_outcomes[0].status, "ok");
}

} // namespace
