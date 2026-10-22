/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/script_config_test.cpp
 * @brief The bounds of `scriptTimeout` and `scriptStackSize` (#2359).
 *
 * `scriptTimeout` used to accept 0, which the engine took as "no deadline", and
 * `scriptStackSize` accepted up to 1 MiB, past what a 512 KB macOS secondary
 * thread can hold once QuickJS has measured its ceiling from the frames already
 * on it. Three layers hold the new bounds, each tested here: the seeded
 * entry (so `POST /config` refuses a value outside them), the resolvers (so a
 * value an older engine stored is brought inside them), and a real call site
 * (so the resolvers are actually read where a script runs).
 */

// Before the first include: `curl/curl.h` reaches `windows.h`, whose `min` /
// `max` macros break `vayu/core/run_manager.hpp`; `url_scheme_test.cpp`
// carries the same guard for the same reason.
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <gtest/gtest.h>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <utility>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/script_config.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/http/server.hpp"
#include "vayu/http/sse_stream.hpp"

namespace vayu::http::routes {
// Declared in config.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json>
apply_config_update (vayu::db::Database& db, const std::string& body);
} // namespace vayu::http::routes

namespace {

using nlohmann::json;
namespace limits = vayu::core::constants::script_engine;

constexpr int64_t DEFAULT_TIMEOUT_MS = 5000;

// --- the resolvers ----------------------------------------------------------

struct TimeoutCase {
    const char* name;
    int64_t stored;
    uint64_t resolved;
};

class ResolveScriptTimeoutTest : public ::testing::TestWithParam<TimeoutCase> {};

TEST_P (ResolveScriptTimeoutTest, BringsAStoredValueInsideTheBounds) {
    EXPECT_EQ (vayu::core::resolve_script_timeout_ms (GetParam ().stored),
    GetParam ().resolved);
}

// Mutation check: return the minimum instead of the default for a value below
// it and the 0 and negative rows red (a 1 ms deadline fails every script).
INSTANTIATE_TEST_SUITE_P (Stored,
ResolveScriptTimeoutTest,
::testing::Values (
// An old workspace's 0 meant "no limit"; it must not become 1 ms.
TimeoutCase{ "ZeroFallsBackToTheDefault", 0, 5000 },
TimeoutCase{ "NegativeFallsBackToTheDefault", -1, 5000 },
TimeoutCase{ "TheMinimumIsKept", 1, 1 },
TimeoutCase{ "InRangeIsUntouched", 1234, 1234 },
TimeoutCase{ "TheMaximumIsKept", 60000, 60000 },
TimeoutCase{ "AboveTheMaximumClampsToIt", 60001, 60000 },
TimeoutCase{ "FarAboveTheMaximumClampsToIt", 2147483647, 60000 }),
[] (const ::testing::TestParamInfo<TimeoutCase>& info) {
    return std::string (info.param.name);
});

struct StackCase {
    const char* name;
    int64_t stored;
    size_t resolved;
};

class ResolveScriptStackSizeTest : public ::testing::TestWithParam<StackCase> {};

TEST_P (ResolveScriptStackSizeTest, BringsAStoredValueInsideTheBounds) {
    EXPECT_EQ (vayu::core::resolve_script_stack_size (GetParam ().stored),
    GetParam ().resolved);
}

INSTANTIATE_TEST_SUITE_P (Stored,
ResolveScriptStackSizeTest,
::testing::Values (
// A negative value must not wrap through the unsigned conversion into a
// stack of exabytes.
StackCase{ "NegativeClampsToTheMinimum", -1, 65536 },
StackCase{ "ZeroClampsToTheMinimum", 0, 65536 },
StackCase{ "BelowTheMinimumClampsToIt", 65535, 65536 },
StackCase{ "TheMinimumIsKept", 65536, 65536 },
StackCase{ "InRangeIsUntouched", 131072, 131072 },
StackCase{ "TheMaximumIsKept", 262144, 262144 },
StackCase{ "AboveTheMaximumClampsToIt", 262145, 262144 },
// The first maximum, then the one before it: values `POST /config` accepted.
StackCase{ "AnOldHalfMegabyteClampsToTheMaximum", 524288, 262144 },
StackCase{ "AnOldMegabyteClampsToTheMaximum", 1048576, 262144 }),
[] (const ::testing::TestParamInfo<StackCase>& info) {
    return std::string (info.param.name);
});

TEST (ScriptBounds, TheDefaultsSitInsideTheirOwnBounds) {
    EXPECT_EQ (vayu::core::resolve_script_timeout_ms (static_cast<int64_t> (limits::TIMEOUT_MS)),
    limits::TIMEOUT_MS);
    EXPECT_EQ (limits::TIMEOUT_MS, static_cast<uint64_t> (DEFAULT_TIMEOUT_MS));
    EXPECT_EQ (vayu::core::resolve_script_stack_size (static_cast<int64_t> (limits::STACK_SIZE)),
    limits::STACK_SIZE);
}

// --- the database -----------------------------------------------------------

class ScriptConfigDbTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_script_config.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// Writes @p value straight to the table, the way a workspace written by an
    /// older engine holds a value `POST /config` would now refuse.
    void store (const std::string& key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key;
        entry->value = value;
        db_->save_config_entry (*entry);
    }

    /// The route's status and its `error` member: the answer to a success is
    /// the whole catalogue, which a failure message should not print.
    std::pair<int, json> post_config (const std::string& key, const std::string& value) {
        const json update{ { "entries", { { key, value } } } };
        auto [status, body] =
        vayu::http::routes::apply_config_update (*db_, update.dump ());
        return { status, body.value ("error", json::object ()) };
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (ScriptConfigDbTest, SeedsTheBoundsTheResolversClampTo) {
    const auto timeout = db_->get_config_entry ("scriptTimeout");
    ASSERT_HAS_VALUE (timeout);
    EXPECT_EQ (timeout->min_value, std::optional<std::string> ("1"));
    EXPECT_EQ (timeout->max_value, std::optional<std::string> ("60000"));

    const auto stack = db_->get_config_entry ("scriptStackSize");
    ASSERT_HAS_VALUE (stack);
    EXPECT_EQ (stack->min_value, std::optional<std::string> ("65536"));
    EXPECT_EQ (stack->max_value, std::optional<std::string> ("262144"));
}

// Mutation check: put the seeded minimum back to "0" and the first assertion
// reds, and with it the one below.
TEST_F (ScriptConfigDbTest, TheRouteRefusesAScriptTimeoutOfZero) {
    const auto [status, body] = post_config ("scriptTimeout", "0");
    EXPECT_EQ (status, 400) << body.dump ();
    EXPECT_NE (body["message"].get<std::string> ().find ("at least 1"), std::string::npos)
    << body.dump ();
    EXPECT_EQ (db_->get_config_int ("scriptTimeout", -1),
    static_cast<int> (limits::TIMEOUT_MS));
}

TEST_F (ScriptConfigDbTest, TheRouteAcceptsAScriptTimeoutOfOne) {
    const auto [status, body] = post_config ("scriptTimeout", "1");
    EXPECT_EQ (status, 200) << body.dump ();
    EXPECT_EQ (db_->get_config_int ("scriptTimeout", -1), 1);
}

TEST_F (ScriptConfigDbTest, TheRouteRefusesAScriptTimeoutAboveTheMaximum) {
    const auto [status, body] = post_config ("scriptTimeout", "60001");
    EXPECT_EQ (status, 400) << body.dump ();
}

TEST_F (ScriptConfigDbTest, TheRouteRefusesAScriptStackSizeAboveTheMaximum) {
    const auto [status, body] = post_config ("scriptStackSize", "262145");
    EXPECT_EQ (status, 400) << body.dump ();
    EXPECT_EQ (db_->get_config_int ("scriptStackSize", -1),
    static_cast<int> (limits::STACK_SIZE));
}

TEST_F (ScriptConfigDbTest, TheRouteAcceptsAScriptStackSizeAtTheMaximum) {
    const auto [status, body] = post_config ("scriptStackSize", "262144");
    EXPECT_EQ (status, 200) << body.dump ();
}

TEST_F (ScriptConfigDbTest, ReadsTheSeededDefaults) {
    const auto config = vayu::core::read_script_config (*db_);

    EXPECT_EQ (config.timeout_ms, limits::TIMEOUT_MS);
    EXPECT_EQ (config.stack_size, limits::STACK_SIZE);
    EXPECT_EQ (config.memory_limit, limits::MEMORY_LIMIT);
    EXPECT_EQ (config.enable_console, limits::ENABLE_CONSOLE);
    EXPECT_FALSE (config.allow_send_request);
}

TEST_F (ScriptConfigDbTest, ReadsAValueInsideTheBoundsUntouched) {
    store ("scriptTimeout", "1500");
    store ("scriptStackSize", "131072");
    store ("scriptMemoryLimit", "2097152");
    store ("scriptEnableConsole", "false");

    const auto config = vayu::core::read_script_config (*db_);

    EXPECT_EQ (config.timeout_ms, 1500U);
    EXPECT_EQ (config.stack_size, 131072U);
    EXPECT_EQ (config.memory_limit, 2097152U);
    EXPECT_FALSE (config.enable_console);
}

TEST_F (ScriptConfigDbTest, ClampsWhatAnOlderEngineStored) {
    store ("scriptTimeout", "0");
    store ("scriptStackSize", "1048576");

    const auto config = vayu::core::read_script_config (*db_);

    EXPECT_EQ (config.timeout_ms, limits::TIMEOUT_MS);
    EXPECT_EQ (config.stack_size, limits::STACK_SIZE_MAX);
}

TEST_F (ScriptConfigDbTest, ClampsNegativeValues) {
    store ("scriptTimeout", "-5");
    store ("scriptStackSize", "-65536");

    const auto config = vayu::core::read_script_config (*db_);

    EXPECT_EQ (config.timeout_ms, limits::TIMEOUT_MS);
    EXPECT_EQ (config.stack_size, limits::STACK_SIZE_MIN);
}

// --- a real call site -------------------------------------------------------

/// Runs a pre-request script through the real `POST /execute` handler.
class ScriptConfigExecuteTest : public ScriptConfigDbTest {
    protected:
    void SetUp () override {
        ScriptConfigDbTest::SetUp ();
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
        run_manager_.shutdown ();
        manager_.reset ();
        ctx_.reset ();
        ScriptConfigDbTest::TearDown ();
    }

    /// How many calls deep the script below got before QuickJS refused the
    /// next, which is proportional to the stack the engine was configured with.
    size_t recursion_depth_reached () const {
        const vayu::tests::EchoServer echo;
        const std::string script =
        "let depth = 0;"
        "function recurse () { depth += 1; recurse (); }"
        "try { recurse (); } catch (e) {}"
        "pm.request.headers.add ({ key: 'X-Depth', value: String (depth) });";
        const json payload{ { "method", "GET" }, { "url", echo.url () },
            { "elements",
            json::array ({ vayu::tests::script_element_json ("el_pre", "script.pre", script) }) } };

        httplib::Client client ("127.0.0.1", port_);
        client.set_read_timeout (20, 0);
        auto response = client.Post ("/execute", payload.dump (), "application/json");
        if (!response || response->status != 200) {
            ADD_FAILURE () << "POST /execute did not answer 200";
            return 0;
        }
        const std::string reached = echo.header ("X-Depth");
        if (reached.empty ()) {
            ADD_FAILURE () << "the script did not run: " << response->body;
            return 0;
        }
        return static_cast<size_t> (std::stoull (reached));
    }

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

// A workspace holding an old maximum (1 MiB) and the old "no limit" runs its
// script on the clamped stack: as deep as the maximum allows, not as deep as the
// stored value would have. Mutation check: build `send.script_config` in
// `execution.cpp` from the raw `get_config_int` reads again and the depth
// doubles, so the comparison reds (the script also runs with no deadline).
TEST_F (ScriptConfigExecuteTest, AStoredOldMaximumRunsOnTheClampedStack) {
    store ("scriptStackSize", "262144");
    const size_t at_the_maximum = recursion_depth_reached ();
    ASSERT_GT (at_the_maximum, 0U);

    store ("scriptTimeout", "0");
    store ("scriptStackSize", "1048576");
    const size_t from_the_old_value = recursion_depth_reached ();

    // The raw 1 MiB would reach about four times as deep as the maximum; the
    // margin is wide of run-to-run frame differences and well short of that.
    EXPECT_GT (from_the_old_value * 4, at_the_maximum * 3);
    EXPECT_LT (from_the_old_value * 3, at_the_maximum * 4);
}

} // namespace
