#pragma once

/**
 * @file load_strategy_fixture.hpp
 * @brief The `LoadStrategyTest` fixture, shared by every `load_strategy*_test.cpp`.
 *
 * The suite is split by subject across those files and keeps one name, so
 * `--gtest_filter=LoadStrategyTest.*`, the scratch-database RESOURCE_LOCK list and the ctest
 * regexes see it whole. The class is defined here, once, outside an anonymous namespace, so
 * each translation unit sees the same type; gtest refuses a suite whose `TEST_F`s name
 * different fixture classes, which an anonymous namespace per file would be.
 */

#include <gtest/gtest.h>

#include <memory>

#include "mock_server.hpp"
#include "temp_database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"

namespace vayu::tests::load_strategy {

inline constexpr const char* TEST_DB_PATH = "test_load_strategy.db";

class LoadStrategyTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::http::global_init ();
        cleanup ();
        mock_server = std::make_unique<SlowMockServer> ();
    }

    void TearDown () override {
        mock_server.reset ();
        vayu::http::global_cleanup ();
        cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (TEST_DB_PATH);
    }

    std::unique_ptr<SlowMockServer> mock_server;
};

/** A transfer the event loop ran that hit its timeout after @p total_ms. */
inline vayu::Response timed_out_response (double total_ms) {
    vayu::Response response;
    response.error_code         = vayu::ErrorCode::Timeout;
    response.error_message      = "Operation timed out";
    response.timing.total_ms    = total_ms;
    response.transfer_attempted = true;
    return response;
}

} // namespace vayu::tests::load_strategy
