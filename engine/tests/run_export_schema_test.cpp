/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_export_schema_test.cpp
 * @brief Every document `POST /export/run-report` writes validates against
 *        `docs/engine/run-export.schema.json` (#2127).
 *
 * The schema says `additionalProperties: false` at every level, so a member the
 * builder starts writing without the schema hearing of it reds here, and so
 * does a required member the builder stops writing. The runs are stored and
 * read back through `GET /runs/:id/report`'s own core, so the shapes validated
 * are the report's real ones rather than a hand-written imitation.
 */

#include <gtest/gtest.h>

#include <memory>
#include <string>

#include <nlohmann/json.hpp>

#include "run_export_schema_support.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/types.hpp"

namespace {

using nlohmann::json;
using vayu::tests::load_run_export_schema;
using vayu::tests::run_export_schema_errors;

constexpr int64_t START_MS = 1791187800000;

json phase () {
    return json{ { "p50", 0.1 }, { "p95", 0.2 }, { "p99", 0.3 }, { "max", 1.0 },
        { "count", 100 } };
}

/// A stored summary with every section the report can carry.
json healthy_summary () {
    return json{ { "total_requests", 100 }, { "cancelled", 0 }, { "rps", 10.0 },
        { "send_rate", 10.0 }, { "throughput", 9.9 }, { "test_duration", 10.0 },
        { "setup_overhead", 0.1 }, { "requests_sent", 100 },
        { "requests_expected", 100 }, { "sending_duration", 9.8 },
        { "peak_concurrency", 5 }, { "dropped_requests", 0 },
        { "queue_wait_avg", 0.2 }, { "bytes_sent", 1000 }, { "bytes_received", 5000 },
        { "http_version_downgraded", 0 }, { "status_codes", { { "200", 100 } } },
        { "latency",
        { { "min", 1.0 }, { "max", 9.0 }, { "avg", 3.0 }, { "p50", 2.0 }, { "p75", 3.0 },
        { "p90", 4.0 }, { "p95", 5.0 }, { "p99", 8.0 }, { "p999", 9.0 } } },
        { "sampling",
        { { "errors_dropped", 0 }, { "success_traces_dropped", 0 },
        { "slow_traces_dropped", 0 }, { "response_samples_dropped", 0 },
        { "exemplars_dropped", 0 }, { "sample_bodies_dropped", 0 },
        { "response_bodies_captured", 0 }, { "response_sample_budget_spent", false } } },
        { "slow_requests", { { "count", 12 }, { "thresholdMs", 500 } } },
        { "scenario",
        { { "iterations", 10 }, { "iterations_completed", 10 },
        { "steps_executed", 20 }, { "passed", 20 }, { "failed", 0 },
        { "skipped", 0 }, { "errored", 0 }, { "steps_stored", 0 },
        { "steps_dropped", 0 }, { "virtual_users", 5 }, { "iterations_abandoned", 0 },
        { "steps",
        json::array ({ { { "index", 0 }, { "name", "login" }, { "requestId", "req_1" },
        { "method", "POST" }, { "executed", 10 }, { "errors", 0 }, { "httpErrors", 0 },
        { "noResponse", 0 }, { "unresolvedTokens", 0 }, { "preRequestScript", "skipped" },
        { "latency", { { "min", 1 }, { "p50", 2 }, { "p95", 3 }, { "p99", 4 }, { "max", 5 } } },
        { "elements",
        json::array ({ { { "id", "el_1" }, { "kind", "assert.status" }, { "passed", 10 },
        { "failed", 0 }, { "skipped", 0 }, { "deferred", 0 } } }) } } }) },
        { "transactions",
        json::array ({ { { "name", "checkout" }, { "count", 10 }, { "errors", 0 },
        { "latency",
        { { "min", 1 }, { "p50", 2 }, { "p90", 3 }, { "p95", 3 }, { "p99", 4 },
        { "max", 5 } } } } }) } } },
        { "monitor",
        { { "samples", 10 }, { "failures", 0 },
        { "series",
        { { "node_cpu", { { "min", 1.0 }, { "max", 2.0 }, { "avg", 1.5 }, { "count", 10 } } } } } } },
        { "tests", { { "sampled", 10 }, { "passed", 10 }, { "failed", 0 } } },
        { "capacity",
        { { "slo_ms", 200 }, { "max_error_pct", 1.0 }, { "stop_reason", "slo_exceeded" },
        { "levels",
        json::array ({ { { "concurrency", 1 }, { "rps", 10 }, { "p99_ms", 5 },
        { "error_pct", 0.0 } } }) },
        { "max_healthy_concurrency", 1 }, { "max_healthy_rps", 10 },
        { "p99_at_max_healthy_ms", 5 }, { "knee_concurrency", 2 },
        { "knee_p99_ms", 300 }, { "knee_error_pct", 0.5 } } },
        { "phases",
        { { "dns", phase () }, { "connect", phase () }, { "tls", phase () },
        { "firstByte", phase () }, { "download", phase () } } },
        { "stream",
        { { "completions", 10 }, { "totalEvents", 100 }, { "capped", 0 },
        { "eventsPerSecond", 10.0 },
        { "events",
        { { "min", 10 }, { "max", 10 }, { "p50", 10 }, { "p90", 10 },
        { "p95", 10 }, { "p99", 10 }, { "count", 10 } } } } },
        { "coverage",
        { { "operationsTotal", 1 }, { "operationsCovered", 1 },
        { "declaredResponsesTotal", 1 }, { "declaredResponsesHit", 1 },
        { "declaredResponseCoveragePct", 100.0 }, { "undeclaredStatusesSeen", 0 },
        { "operations",
        json::array ({ { { "operationId", "getPet" }, { "method", "GET" }, { "path", "/pets/{id}" },
        { "sent", 10 }, { "statusesSeen", { 200 } }, { "declaredHit", { "200" } },
        { "declaredMissed", json::array () }, { "undeclaredSeen", json::array () } } }) } } },
        { "schemaValidation",
        { { "sampled", 10 }, { "checked", 10 }, { "valid", 10 }, { "failed", 0 },
        { "unevaluated", 0 }, { "uncheckedReasons", { { "body_not_json", 0 } } },
        { "unevaluatedKeywords", json::array ({ { { "keyword", "format" }, { "count", 1 } } }) },
        { "failures", json::array () }, { "failuresTotal", 0 } } },
        { "lifecycle",
        { { "setup",
        json::array ({ { { "id", "el_s" }, { "kind", "script.setup" },
        { "origin", json::object () }, { "outcome", "ok" }, { "waitedMs", 1.0 } } }) } } },
        { "elements",
        json::array ({ { { "id", "el_1" }, { "kind", "assert.status" },
        { "passed", 1 }, { "failed", 0 }, { "skipped", 0 }, { "deferred", 0 } } }) },
        { "warnings",
        json::array ({ { { "code", "unresolved_tokens" },
        { "message", "1 request sent with an unresolved variable: token" },
        { "count", 1 }, { "names", { "token" } } } }) },
        { "thresholds",
        { { "checks",
          json::array ({ { { "metric", "latencyP99Ms" }, { "limit", 50 },
          { "actual", 8.0 }, { "passed", true }, { "evaluated", true } } }) },
        { "passed", 1 }, { "failed", 0 } } },
        { "customMetrics",
        { { "ttfb",
          { { "type", "trend" }, { "count", 4 }, { "p50", 1.0 }, { "p95", 2.0 },
          { "p99", 3.0 }, { "max", 4.0 } } },
        { "hits", { { "type", "counter" }, { "count", 2 }, { "value", 5.0 } } } } } };
}

/// Errors and a missed budget: 10% 500s and an error-rate ceiling of 1%.
json failing_summary () {
    return json{ { "total_requests", 100 }, { "rps", 10.0 }, { "test_duration", 10.0 },
        { "status_codes", { { "200", 90 }, { "500", 10 } } },
        { "thresholds",
        { { "checks",
          json::array ({ { { "metric", "errorRate" }, { "limit", 1 }, { "actual", 10.0 },
                         { "passed", false }, { "evaluated", true } },
          { { "metric", "latencyP99Ms" }, { "limit", 5 }, { "passed", false },
          { "evaluated", false } } }) },
        { "passed", 0 }, { "failed", 2 } } } };
}

class RunExportSchemaTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_run_export_schema.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        schema_ = load_run_export_schema ();
        ASSERT_TRUE (schema_.is_object () && schema_.contains ("properties"));
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    void seed (const std::string& id, vayu::RunStatus status, const json& summary) {
        vayu::db::Run run;
        run.id              = id;
        run.type            = vayu::RunType::Load;
        run.status          = status;
        run.config_snapshot = json{
            { "url", "https://u:p@api.test/v1?api_key=k&page=2" }, { "method", "GET" },
            { "headers", { { "Accept", "*/*" } } }, { "body", { { "mode", "none" } } },
            { "auth", { { "mode", "none" } } }, { "requestName", "Orders" },
            { "mode", "constant_rps" }, { "duration", "10s" },
            { "concurrency", 5 }, { "rps", 10 }, { "dataRowCount", 2 },
            { "dataFileName", "users.csv" }, { "dataFileCastNumbers", true }
        }.dump ();
        run.start_time = START_MS;
        run.end_time   = START_MS + 10000;
        db_->create_run (run);
        db_->update_run_summary (id, summary.dump ());

        vayu::db::Result result;
        result.run_id      = id;
        result.timestamp   = START_MS + 10;
        result.status_code = 200;
        result.latency_ms  = 2.0;
        result.trace_data  = json{ { "dnsMs", 1.0 }, { "connectMs", 1.0 },
             { "tlsMs", 1.0 }, { "firstByteMs", 1.0 }, { "downloadMs", 1.0 },
             { "error_type", "timeout" } }
                            .dump ();
        db_->add_result (result);

        vayu::db::MetricTick tick;
        tick.run_id    = id;
        tick.timestamp = START_MS + 1000;
        tick.payload = json{ { "elapsed_seconds", 1.0 }, { "requests_completed", 10 },
            { "requests_failed", 0 }, { "current_rps", 10.0 },
            { "current_concurrency", 5 }, { "throughput", 10.0 }, { "error_rate", 0.0 },
            { "status_codes", { { "200", 10 } } }, { "latency_p50_ms", 1.0 },
            { "latency_p95_ms", 2.0 }, { "latency_p99_ms", 3.0 } }
                       .dump ();
        db_->add_metric_tick (tick);
    }

    /// The exported document for @p request, after asserting it validates.
    json expect_valid (const json& request) {
        auto [status, envelope] =
        vayu::http::routes::export_run_report_response (*db_, request);
        EXPECT_EQ (status, 200) << envelope.dump ();
        if (status != 200) {
            return {};
        }
        json document = json::parse (envelope["text"].get<std::string> ());
        EXPECT_EQ (run_export_schema_errors (schema_, document), "")
        << document.dump (2);
        return document;
    }

    std::unique_ptr<vayu::db::Database> db_;
    json schema_;
};

TEST_F (RunExportSchemaTest, AHealthyRunWithEverySectionValidates) {
    seed ("run_healthy", vayu::RunStatus::Completed, healthy_summary ());
    json document = expect_valid (json{ { "runId", "run_healthy" } });
    // Validating an absent section proves nothing about its shape.
    for (const char* section : { "summary", "latency", "statusCodes", "rateControl",
         "errors", "timingBreakdown", "stream", "slowRequests", "sampling", "warnings",
         "scenario", "monitor", "testValidation", "capacity", "coverage", "schemaValidation",
         "lifecycle", "elements", "thresholdValidation", "customMetrics" }) {
        EXPECT_TRUE (document["report"].contains (section)) << section;
    }
    // The optional members validate only if they are written (#2392).
    EXPECT_TRUE (
    document["report"]["summary"].contains ("sendingDurationSeconds"));
    EXPECT_TRUE (document["report"]["rateControl"].contains ("requestsSent"));
    // The allowlist has to name it, or the export drops the sample size (#2399).
    EXPECT_TRUE (document["report"]["slowRequests"].contains ("tracesStored"));
    EXPECT_TRUE (
    document["report"]["rateControl"].contains ("requestsExpected"));
    // The capacity search's error share (#2815), at both levels of the section.
    const auto& capacity = document["report"]["capacity"];
    EXPECT_TRUE (capacity.contains ("maxErrorPct"));
    EXPECT_TRUE (capacity.contains ("kneeErrorPct"));
    EXPECT_TRUE (capacity["levels"].at (0).contains ("errorPct"));
    EXPECT_FALSE (document["timeSeries"].empty ());
}

TEST_F (RunExportSchemaTest, ARunWithErrorsAndAMissedBudgetValidates) {
    seed ("run_failing", vayu::RunStatus::Completed, failing_summary ());
    expect_valid (json{ { "runId", "run_failing" } });
}

TEST_F (RunExportSchemaTest, AStoppedRunValidates) {
    seed ("run_stopped", vayu::RunStatus::Stopped,
    json{ { "total_requests", 5 }, { "cancelled", 2 },
    { "status_codes", { { "200", 5 } } } });
    expect_valid (json{ { "runId", "run_stopped" }, { "series", "none" } });
}

TEST_F (RunExportSchemaTest, ARunWithABaseValidates) {
    seed ("run_healthy", vayu::RunStatus::Stopped, healthy_summary ());
    seed ("run_failing", vayu::RunStatus::Completed, failing_summary ());
    json document =
    expect_valid (json{ { "runId", "run_failing" }, { "baseRunId", "run_healthy" } });
    // Validating an empty comparison proves nothing about its members' shapes.
    const json& comparison = document["comparison"];
    ASSERT_TRUE (comparison.is_object ()) << document.dump (2);
    EXPECT_FALSE (comparison["differences"].empty ());
    EXPECT_FALSE (comparison["deltas"].empty ());
    EXPECT_FALSE (comparison["statusCodes"].empty ());
}

// #2386: a second with no completion is stored without percentile keys, and
// the export carries the tick without them rather than refusing the document.
// Mutation check: put the three keys back in the schema's `required` and this
// fails.
TEST_F (RunExportSchemaTest, ATickOfAnEmptySecondValidates) {
    seed ("run_stalled", vayu::RunStatus::Completed, healthy_summary ());
    vayu::core::MetricTickSample empty_second;
    empty_second.timestamp          = START_MS + 2000;
    empty_second.elapsed_seconds    = 2.0;
    empty_second.requests_completed = 10;
    empty_second.status_codes       = { { 200, 10 } };
    db_->add_metric_tick ({ 0, "run_stalled", empty_second.timestamp,
    vayu::core::build_metric_tick_payload (empty_second).dump () });

    json document      = expect_valid (json{ { "runId", "run_stalled" } });
    const json& series = document["timeSeries"];
    ASSERT_EQ (series.size (), 2u) << document.dump (2);
    EXPECT_TRUE (series[0].contains ("latency_p99_ms")) << series[0].dump ();
    for (const char* key : { "latency_p50_ms", "latency_p95_ms", "latency_p99_ms" }) {
        EXPECT_FALSE (series[1].contains (key)) << key << ": " << series[1].dump ();
    }
}

TEST_F (RunExportSchemaTest, TheSchemaRefusesAMemberItDoesNotName) {
    seed ("run_healthy", vayu::RunStatus::Completed, healthy_summary ());
    auto [status, envelope] = vayu::http::routes::export_run_report_response (
    *db_, json{ { "runId", "run_healthy" } });
    ASSERT_EQ (status, 200);
    json document = json::parse (envelope["text"].get<std::string> ());
    ASSERT_EQ (run_export_schema_errors (schema_, document), "");
    document["report"]["summary"]["somethingNew"] = 1;
    EXPECT_NE (run_export_schema_errors (schema_, document), "");
}

} // namespace
