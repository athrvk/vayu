/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/transient_execute_test.cpp
 * @brief `POST /execute`'s transient mode (issue #382) - run fully, record
 * nothing.
 *
 * GraphQL schema introspection is a background fetch the user never asked for,
 * but it went through `POST /execute` and so became an ordinary design run:
 * a visible History entry per introspection, the post-auth request headers
 * (the user's live token) written to disk in the result trace, and - because
 * retention is count-based - a real run evicted for every schema load.
 *
 * Two halves are pinned here, and they are the two halves of "leaves no trace":
 *
 * 1. `read_transient_flag` - the payload says so, and says so in a way that
 *    fails loudly when it is malformed. A caller that believes this execution
 *    is private must not be told "false" silently.
 * 2. `record_design_result` - given no run id, it writes nothing: no result
 *    row, no terminal status, no retention prune. Both directions are asserted
 *    against a real database, so removing the `if (!run_id) return;` turns the
 *    transient cases red rather than passing vacuously.
 *
 * `validate_run_config` rejecting `transient` on `POST /runs` lives with the
 * rest of that endpoint's validation, in run_config_validation_test.cpp.
 *
 * What is NOT covered here: that the route skips `create_run` for a transient
 * payload. The suite has no in-process HTTP route harness (see
 * run_route_test.cpp), so that ordering is held by the call site - the
 * `if (!transient.value)` block in execution.cpp that is the only writer of
 * `run.id`, and the `run_id` optional every later step reads.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/types.hpp"

namespace vayu::http::routes {
// Defined in execution.cpp. Records a finished design execution against its
// run row, or nothing at all when `run_id` is absent.
void record_design_result (vayu::db::Database& db,
const std::optional<std::string>& run_id,
const vayu::Request& request,
const vayu::Response& response);
} // namespace vayu::http::routes

namespace {

using nlohmann::json;
using vayu::http::routes::read_transient_flag;
using vayu::http::routes::record_design_result;

TEST (TransientFlag, AbsentMeansRecorded) {
    auto flag = read_transient_flag (json{ { "method", "GET" }, { "url", "http://x/" } });
    EXPECT_TRUE (flag.ok);
    EXPECT_FALSE (flag.value);
}

TEST (TransientFlag, NullMeansRecorded) {
    auto flag = read_transient_flag (json{ { "transient", nullptr } });
    EXPECT_TRUE (flag.ok);
    EXPECT_FALSE (flag.value);
}

TEST (TransientFlag, TrueOptsOut) {
    auto flag = read_transient_flag (json{ { "transient", true } });
    EXPECT_TRUE (flag.ok);
    EXPECT_TRUE (flag.value);
}

TEST (TransientFlag, FalseIsExplicitlyRecorded) {
    auto flag = read_transient_flag (json{ { "transient", false } });
    EXPECT_TRUE (flag.ok);
    EXPECT_FALSE (flag.value);
}

// The loud half. A client that sends the string "true" is asking for an
// execution that leaves nothing behind; answering `false` and filing the run
// anyway is the silent-wrong outcome this whole issue is about.
TEST (TransientFlag, ANonBooleanIsRejectedAndNamesTheField) {
    for (const auto& bad :
    { json ("true"), json (1), json (json::array ()), json (json::object ()) }) {
        auto flag = read_transient_flag (json{ { "transient", bad } });
        ASSERT_FALSE (flag.ok) << "expected rejection for " << bad.dump ();
        EXPECT_NE (flag.error.find ("transient"), std::string::npos)
        << "message should name the field, got: " << flag.error;
    }
}

class RecordDesignResultTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_transient_execute.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        for (const char* suffix : { "", "-wal", "-shm", ".bak" }) {
            std::filesystem::remove (std::string (DB_PATH) + suffix);
        }
    }

    // A run row in the state `POST /execute` leaves it in before the exchange.
    //
    // Stamped *now*, not at some fixed small number: recording a result drives
    // the run terminal, which runs the retention prune, and the day-based
    // retention window sweeps anything dated 1970 - so an epoch-seeded row
    // vanishes mid-test and the assertions read as "nothing was stored" when
    // the store worked fine. run_stop_test.cpp carries the same note.
    std::string seed_running_run (const std::string& id) {
        const auto now = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        vayu::db::Run run;
        run.id         = id;
        run.type       = vayu::RunType::Design;
        run.status     = vayu::RunStatus::Running;
        run.start_time = now;
        run.end_time   = now;
        run.config_snapshot = R"({"url":"https://api.test/gql","method":"POST"})";
        db_->create_run (run);
        return id;
    }

    static vayu::Request sent_request () {
        vayu::Request request;
        request.method = vayu::HttpMethod::POST;
        request.url    = "https://api.test/gql";
        // The post-auth header set: this is the value that must never reach
        // disk on a transient execution.
        request.headers["Authorization"] = "Bearer sk_live_secret";
        return request;
    }

    static vayu::Response ok_response () {
        vayu::Response response;
        response.status_code     = 200;
        response.status_text     = "OK";
        response.body            = R"({"data":{"__schema":{}}})";
        response.timing.total_ms = 7.5;
        return response;
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (RecordDesignResultTest, ATransientExecutionWritesNoResultRow) {
    // A recorded run already exists, so "nothing new" is a real measurement
    // rather than a count that was going to be zero anyway.
    const auto existing  = seed_running_run ("run_existing");
    const int64_t before = db_->count_runs (vayu::db::RunFilter{});

    record_design_result (*db_, std::nullopt, sent_request (), ok_response ());

    EXPECT_EQ (db_->count_runs (vayu::db::RunFilter{}), before);
    EXPECT_TRUE (db_->get_results (existing).empty ());
    // Untouched, not merely un-inserted: a transient execution must not move
    // some other run's status either.
    auto row = db_->get_run (existing);
    ASSERT_TRUE (row.has_value ());
    EXPECT_EQ (row->status, vayu::RunStatus::Running);
}

TEST_F (RecordDesignResultTest, ATransientExecutionLeavesNoCredentialOnDisk) {
    seed_running_run ("run_existing");

    record_design_result (*db_, std::nullopt, sent_request (), ok_response ());

    // The trace is the only place the resolved Authorization header would have
    // landed (the run row's config_snapshot collapses `auth` to its mode), so
    // an empty result set is the whole claim.
    for (const auto& result : db_->get_results ("run_existing")) {
        EXPECT_EQ (result.trace_data.find ("sk_live_secret"), std::string::npos);
    }
    EXPECT_TRUE (db_->get_results ("run_existing").empty ());
}

// The other direction: with a run id, everything the transient path skips must
// still happen. Without these two, deleting the recording code entirely would
// leave the tests above green.
TEST_F (RecordDesignResultTest, ARecordedExecutionStoresTheTraceAndCompletesTheRun) {
    const auto id = seed_running_run ("run_recorded");

    record_design_result (*db_, id, sent_request (), ok_response ());

    auto results = db_->get_results (id);
    ASSERT_EQ (results.size (), 1u);
    EXPECT_EQ (results[0].status_code, 200);
    auto trace = json::parse (results[0].trace_data);
    EXPECT_EQ (trace["request"]["url"], "https://api.test/gql");
    EXPECT_EQ (trace["request"]["headers"]["Authorization"], "Bearer sk_live_secret");

    auto row = db_->get_run (id);
    ASSERT_TRUE (row.has_value ());
    EXPECT_EQ (row->status, vayu::RunStatus::Completed);
}

TEST_F (RecordDesignResultTest, ARecordedFailureMarksTheRunFailed) {
    const auto id = seed_running_run ("run_failed");

    // The shape the route's auth-failure path builds: no HTTP status at all,
    // the failure carried by `error_code` (which is what `has_error()` reads -
    // a message alone is not an error).
    vayu::Response failed;
    failed.status_code   = 0;
    failed.error_code    = vayu::ErrorCode::AuthFailed;
    failed.error_message = "connection refused";

    record_design_result (*db_, id, sent_request (), failed);

    auto row = db_->get_run (id);
    ASSERT_TRUE (row.has_value ());
    EXPECT_EQ (row->status, vayu::RunStatus::Failed);
    ASSERT_EQ (db_->get_results (id).size (), 1u);
    EXPECT_EQ (db_->get_results (id)[0].error, "connection refused");
}

} // namespace
