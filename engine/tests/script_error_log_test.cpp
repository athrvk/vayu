/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/script_error_log_test.cpp
 * @brief Text a script threw reaches the log as a bounded field, never as
 *        `msg` (issue #2359).
 *
 * `msg` is not redacted - only `fields` are, by key - so a script that throws
 * a credential must not have it concatenated into a sentence. Two halves: the
 * bound itself (`bounded_log_text`), and `execute_exchange`'s pre- and
 * post-request script failures, which is the path `POST /execute` and every
 * collection-run step share. The run-level `script.setup` failure and the
 * errored-step line are pinned beside their own fixtures
 * (`elements_setup_teardown_test.cpp`, `scenario_runner_test.cpp`).
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <memory>
#include <string>
#include <thread>
#include <utility>

#include "log_capture.hpp"
#include "step_elements_test_helper.hpp"
#include "task_queue.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/log_text.hpp"

namespace {

using vayu::utils::bounded_log_text;
using vayu::utils::kLoggedTextMaxBytes;
using vayu::utils::kLoggedTextTruncationMarker;

// ---------------------------------------------------------------------------
// bounded_log_text
// ---------------------------------------------------------------------------

TEST (BoundedLogTextTest, TextWithinTheBoundIsUntouched) {
    EXPECT_EQ (bounded_log_text (""), "");
    EXPECT_EQ (bounded_log_text ("boom"), "boom");
}

TEST (BoundedLogTextTest, TextOfExactlyTheBoundIsUntouched) {
    const std::string text (kLoggedTextMaxBytes, 'a');
    EXPECT_EQ (bounded_log_text (text), text);
}

TEST (BoundedLogTextTest, OneByteOverTheBoundIsCutAndMarked) {
    const std::string text (kLoggedTextMaxBytes + 1, 'a');
    EXPECT_EQ (bounded_log_text (text),
    std::string (kLoggedTextMaxBytes, 'a') + std::string (kLoggedTextTruncationMarker));
}

TEST (BoundedLogTextTest, ACutInsideAMultibyteCharacterBacksOffToItsStart) {
    // U+20AC is three bytes; starting it at offset bound - 1 puts the cut after
    // its first byte, and starting it at bound - 2 after its second.
    for (const std::size_t lead : { kLoggedTextMaxBytes - 1, kLoggedTextMaxBytes - 2 }) {
        const std::string text = std::string (lead, 'a') + "\xE2\x82\xAC" + "tail";
        const std::string bounded = bounded_log_text (text);

        EXPECT_EQ (bounded, std::string (lead, 'a') + std::string (kLoggedTextTruncationMarker))
        << "lead " << lead;
        EXPECT_TRUE (vayu::utils::is_valid_utf8_text (bounded)) << "lead " << lead;
    }
}

TEST (BoundedLogTextTest, ACharacterEndingExactlyAtTheBoundIsKept) {
    const std::string kept = std::string (kLoggedTextMaxBytes - 3, 'a') + "\xE2\x82\xAC";
    ASSERT_EQ (kept.size (), kLoggedTextMaxBytes);

    EXPECT_EQ (bounded_log_text (kept + "tail"),
    kept + std::string (kLoggedTextTruncationMarker));
}

TEST (BoundedLogTextTest, TheMarkerIsTheOnlyThingPastTheBound) {
    const std::string bounded = bounded_log_text (std::string (100000, 'a'));
    EXPECT_EQ (
    bounded.size (), kLoggedTextMaxBytes + kLoggedTextTruncationMarker.size ());
}

// ---------------------------------------------------------------------------
// execute_exchange: pre- and post-request scripts that throw
// ---------------------------------------------------------------------------

class OkServer {
    public:
    OkServer () {
        svr_.new_task_queue = vayu::tests::pooled_task_queue (2);
        svr_.Get ("/ok", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("{}", "application/json");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }
    ~OkServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    OkServer (const OkServer&)            = delete;
    OkServer& operator= (const OkServer&) = delete;
    OkServer (OkServer&&)                 = delete;
    OkServer& operator= (OkServer&&)      = delete;

    std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/ok";
    }

    private:
    httplib::Server svr_;
    int port_ = 0;
    std::thread thread_;
};

class ScriptErrorLogTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        server_ = std::make_unique<OkServer> ();
    }
    void TearDown () override {
        server_.reset ();
        vayu::http::global_cleanup ();
    }

    vayu::http::routes::ExchangeOutcome send (
    std::shared_ptr<const std::vector<vayu::core::CompiledElement>> elements) {
        vayu::runtime::ScriptEngine engine;
        vayu::http::CookieJar jar;
        vayu::http::routes::ScriptVariableScopes scopes;

        vayu::Request request;
        request.method = vayu::HttpMethod::GET;
        request.url    = server_->url ();

        vayu::http::routes::ExchangeInputs inputs;
        inputs.request  = std::move (request);
        inputs.elements = std::move (elements);
        return execute_exchange (engine, jar, "", scopes, std::move (inputs));
    }

    /// A thrown text whose 512th byte falls inside a three-byte character, so
    /// the log's bound has to back off - found by trying paddings against the
    /// error text the engine really reports, not by assuming its prefix.
    std::string straddling_text () {
        for (std::size_t pad = 0; pad < 3; ++pad) {
            const std::string text = vayu::tests::thrown_text (pad);
            vayu::runtime::ScriptEngine engine;
            vayu::Request request;
            const auto ctx = vayu::runtime::ScriptContext::for_prerequest (request);
            const auto result = engine.execute (vayu::tests::script_throwing (text), ctx);
            const auto at = result.error_message.find (vayu::tests::SCRIPT_SECRET);
            if (at == std::string::npos) {
                continue;
            }
            const std::string head = result.error_message.substr (0, kLoggedTextMaxBytes);
            if (!vayu::utils::is_valid_utf8_text (head)) {
                return text;
            }
        }
        ADD_FAILURE () << "no padding put the cut inside a character";
        return vayu::tests::thrown_text (0);
    }

    std::unique_ptr<OkServer> server_;
};

// Mutation check: log `result.error_message` whole in `msg` again, or drop
// `bounded_log_text` from the field, in `execute_script` (request_exchange.cpp)
// and this fails on the secret in `msg` / the unbounded tail.
TEST_F (ScriptErrorLogTest, APreRequestScriptsThrownTextIsABoundedFieldNotTheMessage) {
    const vayu::tests::LogCapture log;
    const std::string text = straddling_text ();

    const auto outcome = send (
    vayu::tests::step_elements_with_pre_script (vayu::tests::script_throwing (text)));

    // What the response and the stored trace carry is untouched.
    EXPECT_FALSE (outcome.pre_script_result.success);
    EXPECT_NE (outcome.pre_script_result.error_message.find (vayu::tests::SCRIPT_TAIL),
    std::string::npos);
    EXPECT_GT (outcome.pre_script_result.error_message.size (), kLoggedTextMaxBytes);

    const auto records = log.with_msg_prefix ("Pre-request script failed");
    ASSERT_EQ (records.size (), 1u);
    EXPECT_EQ (records[0].at ("msg").get<std::string> (), "Pre-request script failed");
    EXPECT_EQ (records[0].at ("level").get<std::string> (), "warn");
    EXPECT_EQ (records[0].at ("cat").get<std::string> (), "http");
    vayu::tests::expect_script_text_only_bounded_in (records[0], "scriptError");
    // The cut fell inside a character, so the kept text is shorter than the bound.
    EXPECT_LT (records[0].at ("scriptError").get<std::string> ().size (),
    kLoggedTextMaxBytes + kLoggedTextTruncationMarker.size ());
}

TEST_F (ScriptErrorLogTest, APostRequestScriptsThrownTextIsABoundedFieldNotTheMessage) {
    const vayu::tests::LogCapture log;
    const std::string text = straddling_text ();

    const auto outcome = send (vayu::tests::step_elements_with_post_script (
    vayu::tests::script_throwing (text)));

    EXPECT_FALSE (outcome.post_script_result.success);
    EXPECT_NE (outcome.post_script_result.error_message.find (vayu::tests::SCRIPT_TAIL),
    std::string::npos);

    const auto records = log.with_msg_prefix ("Post-request script failed");
    ASSERT_EQ (records.size (), 1u);
    EXPECT_EQ (records[0].at ("msg").get<std::string> (), "Post-request script failed");
    vayu::tests::expect_script_text_only_bounded_in (records[0], "scriptError");
}

TEST_F (ScriptErrorLogTest, AShortThrownTextIsLoggedWhole) {
    const vayu::tests::LogCapture log;

    send (
    vayu::tests::step_elements_with_pre_script ("throw new Error('boom');"));

    const auto records = log.with_msg_prefix ("Pre-request script failed");
    ASSERT_EQ (records.size (), 1u);
    EXPECT_NE (records[0].at ("scriptError").get<std::string> ().find ("boom"),
    std::string::npos);
    EXPECT_EQ (records[0].at ("scriptError").get<std::string> ().find (std::string (kLoggedTextTruncationMarker)),
    std::string::npos);
}

} // namespace
