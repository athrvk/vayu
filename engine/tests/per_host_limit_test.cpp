/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/per_host_limit_test.cpp
 * @brief A load run's per-host connection limit covers its virtual users
 *        (#2394): `configure_event_loop` raises `eventLoopMaxPerHost` to each
 *        worker's share, and the run's warnings say when it did.
 *
 * `effective_max_per_host` itself is tabled in `worker_count_test.cpp`; this
 * file holds the wiring, which a test of the pure function cannot see.
 */

#include <gtest/gtest.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"

namespace {

class PerHostLimitRunTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (path_);
        db_ = std::make_unique<vayu::db::Database> (path_);
        db_->seed_default_config ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (path_);
    }

    /// The run's own sizing, the call `execute_load_test` makes. Small
    /// numbers on purpose: each worker pre-allocates `max(concurrency, 100)`
    /// curl handles, and nothing is ever submitted to this loop.
    std::shared_ptr<vayu::core::RunContext>
    configure (size_t concurrency, int pool_size, int setting) const {
        auto context = std::make_shared<vayu::core::RunContext> (
        "run-per-host", nlohmann::json::object ());
        vayu::core::configure_event_loop (*db_, context->config, context,
        concurrency, /*timeout_ms=*/5000, pool_size, setting);
        return context;
    }

    /// The `per_host_limit_raised` entry of the run's warnings, or null.
    static nlohmann::json raised_warning (
    const std::shared_ptr<vayu::core::RunContext>& context) {
        for (const auto& warning : vayu::core::build_run_warnings (context)) {
            if (warning["code"] == "per_host_limit_raised") {
                return warning;
            }
        }
        return nullptr;
    }

    std::string path_ = "test_per_host_limit.db";
    std::unique_ptr<vayu::db::Database> db_;
};

// Forty virtual users on four workers is ten each, above a setting of 4.
// `effective_max_per_host` on the context is read off the loop's own config
// after it is built. Mutation-check: restore `loop_config.max_per_host =
// default_max_per_host` in configure_event_loop and both the recorded limit
// and the warning fail.
TEST_F (PerHostLimitRunTest, ALimitBelowEachWorkersShareIsRaisedAndReported) {
    const auto context = configure (/*concurrency=*/40, /*pool_size=*/4, /*setting=*/4);

    EXPECT_EQ (context->configured_max_per_host, 4u);
    EXPECT_EQ (context->effective_max_per_host, 10u);

    const auto warning = raised_warning (context);
    ASSERT_TRUE (warning.is_object ()) << "a raised limit is reported";
    EXPECT_EQ (warning["configured"], 4);
    EXPECT_EQ (warning["effective"], 10);
    EXPECT_NE (warning["message"].get<std::string> ().find ("from 4 to 10"), std::string::npos)
    << warning["message"];
}

// The setting already covers each worker's share: kept, and nothing to say.
TEST_F (PerHostLimitRunTest, ALimitThatCoversEachWorkersShareIsKeptSilently) {
    const auto context = configure (/*concurrency=*/40, /*pool_size=*/4, /*setting=*/200);

    EXPECT_EQ (context->configured_max_per_host, 200u);
    EXPECT_EQ (context->effective_max_per_host, 200u);
    EXPECT_TRUE (raised_warning (context).is_null ());
}

} // namespace
