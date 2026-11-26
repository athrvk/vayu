#pragma once

/**
 * @file runs_route_fixture.hpp
 * @brief The `RunsRouteTest` fixture, the route functions it drives, and the helpers shared by
 *        more than one `runs_route_*_test.cpp`.
 *
 * The suite is split by subject across those files and keeps one name, so
 * `--gtest_filter=RunsRouteTest.*`, the scratch-database RESOURCE_LOCK list and the ctest
 * regexes see it whole. The class is defined here, once, so each translation unit sees the
 * same type; gtest refuses a suite whose `TEST_F`s name different fixture classes.
 */

#include <gtest/gtest.h>

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/run_summary_cache.hpp"
#include "vayu/utils/diagnostics.hpp"

namespace vayu::http::routes {
// Defined in runs.cpp; returns {http_status, json_body}. The default is this
// declaration's alone: the route always passes `before`, and most cases here
// page by offset.
std::pair<int, nlohmann::json> get_runs_response (vayu::db::Database& db,
const vayu::db::RunFilter& filter,
int64_t limit,
int64_t offset,
vayu::http::RunSummaryCache& summaries,
const std::optional<std::string>& before = std::nullopt);

// Defined in runs.cpp; builds the GET /runs/:id/report `configuration`
// object from an already-parsed config_snapshot, extracted so it is testable
// without the report handler's DB/metrics dependencies.
nlohmann::json build_run_report_config (const nlohmann::json& config);
// Defined in runs.cpp; the report's `metadata` object for one stored run.
nlohmann::json build_report_metadata (const std::string& run_id, const vayu::db::Run& run);
// Defined in runs.cpp; returns {http_status, json_body}.
std::pair<int, nlohmann::json> set_run_baseline_response (vayu::db::Database& db,
const std::string& run_id,
const std::string& body);
// Defined in runs.cpp; GET /runs/:id, returns {http_status, json_body}.
std::pair<int, nlohmann::json> get_run_response (vayu::db::Database& db,
const std::string& run_id,
vayu::core::RunManager* live_runs);
// Defined in runs.cpp; the GET /runs filters off the query string.
vayu::db::RunFilter run_filter_from_query (const httplib::Request& req);
// Defined in runs.cpp; DELETE /runs, returns {http_status, json_body}.
std::pair<int, nlohmann::json> clear_runs_response (vayu::db::Database& db);
// Defined in execution.cpp; stamps a new row's timestamps as both inserts do.
void seed_run_times (vayu::db::Run& run, int64_t started_at);
} // namespace vayu::http::routes

class RunsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_runs_route.db";

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
        vayu::tests::remove_database_files (DB_PATH);
    }

    struct RunSpec {
        std::string id;
        vayu::RunType type                    = vayu::RunType::Load;
        vayu::RunStatus status                = vayu::RunStatus::Completed;
        int64_t start_time                    = 0;
        std::optional<std::string> request_id = std::nullopt;
        std::string config_snapshot = R"({"url":"https://x.test/","method":"GET"})";
        std::string origin                       = "other";
        std::optional<std::string> origin_client = std::nullopt;
    };

    void seed (const RunSpec& s) {
        vayu::db::Run run;
        run.id              = s.id;
        run.type            = s.type;
        run.status          = s.status;
        run.request_id      = s.request_id;
        run.environment_id  = std::nullopt;
        run.config_snapshot = s.config_snapshot;
        run.origin          = s.origin;
        run.origin_client   = s.origin_client;
        run.start_time      = s.start_time;
        run.end_time        = s.start_time + 1;
        db_->create_run (run);
    }

    /// `run_0` .. `run_<count - 1>` at start_time 0 .. count - 1, so the list
    /// reads `run_<count - 1>` down to `run_0`.
    void seed_numbered (int count) {
        for (int i = 0; i < count; ++i) {
            seed ({ .id = "run_" + std::to_string (i), .start_time = i });
        }
    }

    /// One stored exchange for @p run_id. `trace_data` is deliberately large:
    /// the list must never read this column, and a row that does shows up as a
    /// payload, not as a failure.
    // The 4 KB filler concatenation below is what GCC 13 reports as reading past
    // the small-string buffer. See utils/diagnostics.hpp.
    VAYU_IGNORE_FALSE_STRING_CONCAT_BOUNDS
    void seed_result (const std::string& run_id,
    int status_code,
    double latency_ms,
    int64_t timestamp = 1000) {
        vayu::db::Result result;
        result.run_id      = run_id;
        result.timestamp   = timestamp;
        result.status_code = status_code;
        result.status_text = "OK";
        result.latency_ms  = latency_ms;
        result.trace_data = R"({"response":{"body":")" + std::string (4096, 'x') + R"("}})";
        db_->add_result (result);
    }
    VAYU_DIAGNOSTIC_POP

    /// One stored result carrying @p trace_data as written, parseable or not;
    /// answers its row id.
    int seed_traced_result (const std::string& run_id,
    int status_code,
    double latency_ms,
    const std::string& trace_data) {
        vayu::db::Result result;
        result.run_id      = run_id;
        result.timestamp   = 1000;
        result.status_code = status_code;
        result.status_text = "OK";
        result.latency_ms  = latency_ms;
        result.error       = status_code == 0 ? "timed out" : "";
        result.trace_data  = trace_data;
        return db_->add_result (result);
    }

    /// Renames `results` away behind the open connection, so any read of a
    /// run's rows throws: what proves a report read none (#2659).
    static void make_results_unreadable () {
        sqlite3* handle = nullptr;
        ASSERT_EQ (sqlite3_open (DB_PATH, &handle), SQLITE_OK);
        sqlite3_busy_timeout (handle, 5000);
        char* err = nullptr;
        if (sqlite3_exec (handle, "ALTER TABLE results RENAME TO results_unreadable",
            nullptr, nullptr, &err) != SQLITE_OK) {
            ADD_FAILURE () << "could not rename results: "
                           << (err != nullptr ? err : "(no message)");
            sqlite3_free (err);
        }
        sqlite3_close (handle);
    }

    std::unique_ptr<vayu::db::Database> db_;
    /// One per test, like the database beside it: the cache is keyed by run id
    /// and these cases reuse ids across tests, so a shared one would answer a
    /// later test from an earlier test's snapshot.
    vayu::http::RunSummaryCache summaries_;
};

namespace vayu::tests {

/// A well-formed `dataFileHash` (issue #2051), as the seeded snapshots spell it.
inline constexpr const char* DATA_FILE_HASH =
"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// The scenario snapshot a collection run, or a load run driven over a
// collection, stores. Only the key the filter reads matters here, so the rest
// is the smallest thing that still parses as one.
inline std::string scenario_snapshot (const std::string& collection_id) {
    return R"({"scenario":{"collectionId":")" + collection_id + R"(","iterations":1}})";
}

// The whole-run results a completed load run stores on its row.
inline vayu::core::RunSummaryInputs summary_inputs () {
    vayu::core::RunSummaryInputs inputs;
    inputs.total_requests          = 100;
    inputs.rps                     = 50.0;
    inputs.send_rate               = 51.0;
    inputs.throughput              = 49.5;
    inputs.test_duration_s         = 2.0;
    inputs.setup_overhead_s        = 0.25;
    inputs.cleanup_overhead_s      = 0.125;
    inputs.peak_concurrency        = 8;
    inputs.avg_in_flight           = 3.25;
    inputs.dropped_requests        = 2;
    inputs.skipped_requests        = 5;
    inputs.stalled_ms              = 500.0;
    inputs.queue_wait_avg_ms       = 1.5;
    inputs.bytes_sent              = 1024;
    inputs.bytes_received          = 8192;
    inputs.status_codes            = { { 200, 90 }, { 500, 7 }, { 0, 3 } };
    inputs.latency.count           = 100;
    inputs.latency.min             = 1.0;
    inputs.latency.max             = 90.0;
    inputs.latency.p50             = 10.0;
    inputs.latency.p75             = 15.0;
    inputs.latency.p90             = 20.0;
    inputs.latency.p95             = 25.0;
    inputs.latency.p99             = 30.0;
    inputs.latency.p999            = 35.0;
    inputs.latency_avg_ms          = 12.5;
    inputs.http_version_downgraded = 4;
    inputs.connection_replays      = 6;
    inputs.tests     = vayu::core::ScriptValidationTotals{ 10, 9, 1, {}, 0 };
    inputs.retention = vayu::core::SamplingRetention{ 4, 300, 12, 900 };
    return inputs;
}

} // namespace vayu::tests
