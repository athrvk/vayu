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
        { "count", 100 }, { "mean", 0.15 } };
}

/// A stored summary with every section the report can carry.
json healthy_summary () {
    return json{ { "total_requests", 100 }, { "cancelled", 0 }, { "rps", 10.0 },
        { "send_rate", 10.0 }, { "throughput", 9.9 }, { "test_duration", 10.0 },
        { "setup_overhead", 0.1 }, { "cleanup_overhead", 0.05 },
        { "requests_sent", 100 }, { "requests_expected", 100 },
        { "sending_duration", 9.8 }, { "completed_while_sending", 97 },
        { "peak_concurrency", 5 }, { "avg_in_flight", 4.2 },
        { "dropped_requests", 0 }, { "skipped_requests", 3 },
        { "stalled_ms", 300.0 }, { "queue_wait_avg", 0.2 }, { "bytes_sent", 1000 },
        { "bytes_received", 5000 }, { "http_version_downgraded", 0 },
        { "connection_replays", 2 }, { "status_codes", { { "200", 100 } } },
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
        { "assertions", { { "passed", 18 }, { "failed", 2 } } },
        { "steps",
        json::array ({ { { "index", 0 }, { "name", "login" }, { "requestId", "req_1" },
        { "method", "POST" }, { "executed", 10 }, { "errors", 0 },
        { "httpErrors", 0 }, { "noResponse", 0 }, { "unresolvedTokens", 0 },
        { "extractorMisses", 1 }, { "preRequestScript", "skipped" },
        { "latency", { { "min", 1 }, { "p50", 2 }, { "p95", 3 }, { "p99", 4 }, { "max", 5 } } },
        { "elements",
        json::array ({ { { "id", "el_1" }, { "kind", "assert.status" }, { "passed", 10 }, { "failed", 0 },
                       { "missing", 0 }, { "error", 0 }, { "skipped", 0 }, { "deferred", 0 } },
        { { "id", "el_2" }, { "kind", "extract.json" }, { "name", "Session id" },
        { "origin", { { "kind", "request" }, { "scope", "request" }, { "id", "req_1" }, { "name", "login" } } },
        { "required", true }, { "passed", 9 }, { "failed", 0 }, { "missing", 1 },
        { "error", 0 }, { "skipped", 0 }, { "deferred", 0 } } }) } } }) },
        { "transactions",
        json::array ({ { { "name", "checkout" }, { "count", 10 }, { "errors", 0 },
        { "latency",
        { { "min", 1 }, { "p50", 2 }, { "p90", 3 }, { "p95", 3 }, { "p99", 4 },
        { "max", 5 } } } } }) } } },
        { "monitor",
        { { "samples", 10 }, { "failures", 1 }, { "noMatchScrapes", 2 }, { "lastError", "HTTP 503" },
        { "series",
        { { "node_cpu", { { "min", 1.0 }, { "max", 2.0 }, { "avg", 1.5 }, { "count", 10 } } } } } } },
        { "tests", { { "sampled", 10 }, { "passed", 10 }, { "failed", 0 } } },
        { "capacity",
        { { "slo_ms", 200 }, { "max_error_pct", 1.0 }, { "stop_reason", "slo_exceeded" },
        { "levels",
        json::array ({ { { "concurrency", 1 }, { "rps", 10 }, { "p99_ms", 5 },
        { "error_pct", 0.0 }, { "samples", 50 } } }) },
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
        json::array ({ { { "id", "el_s" }, { "kind", "script.setup" }, { "name", "Seed data" },
        { "origin",
        { { "kind", "collection" }, { "scope", "collection" },
        { "id", "col_1" }, { "name", "Shop" }, { "unlisted", "dropped" } } },
        { "outcome", "ok" }, { "waitedMs", 1.0 } } }) } } },
        { "elements",
        json::array ({ { { "id", "el_1" }, { "kind", "assert.status" }, { "name", "Is 200" },
        { "origin", { { "kind", "collection" }, { "id", "col_1" } } },
        { "passed", 1 }, { "failed", 0 }, { "missing", 0 }, { "error", 1 },
        { "skipped", 0 }, { "deferred", 0 } } }) },
        { "warnings",
        json::array ({ { { "code", "unresolved_tokens" }, { "message", "1 request sent with an unresolved variable: token" },
                       { "count", 1 }, { "names", { "token" } } },
        { { "code", "connection_replayed" },
        { "message", "2 requests were re-sent on a new connection" }, { "count", 2 } } }) },
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

    /// A null @p summary stores none; @p with_samples false stores no result or
    /// tick, as a run the engine died under has (its rows are written at the end).
    /// @p extra_config members overwrite the snapshot's own.
    void seed (const std::string& id,
    vayu::RunStatus status,
    const json& summary,
    bool with_samples        = true,
    const json& extra_config = json::object ()) {
        vayu::db::Run run;
        run.id     = id;
        run.type   = vayu::RunType::Load;
        run.status = status;
        json snapshot = json{ { "url", "https://u:p@api.test/v1?api_key=k&page=2" },
            { "method", "GET" }, { "headers", { { "Accept", "*/*" } } },
            { "body", { { "mode", "none" } } }, { "auth", { { "mode", "none" } } },
            { "requestName", "Orders" }, { "mode", "constant_rps" }, { "duration", "10s" },
            { "concurrency", 5 }, { "rps", 10 }, { "dataRowCount", 2 },
            { "dataFileName", "users.csv" }, { "dataFileCastNumbers", true } };
        snapshot.update (extra_config);
        run.config_snapshot = snapshot.dump ();
        run.start_time      = START_MS;
        run.end_time        = START_MS + 10000;
        db_->create_run (run);
        if (!summary.is_null ()) {
            db_->update_run_summary (id, summary.dump ());
        }
        if (!with_samples) {
            return;
        }

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
    // Why the scrape missed (#3120): a no-match and a failure need different
    // fixes. Mutation check: drop "noMatchScrapes" or "lastError" from
    // MONITOR_KEYS and the matching assertion fails.
    EXPECT_EQ (document["report"]["monitor"].value ("noMatchScrapes", -1), 2);
    EXPECT_EQ (document["report"]["monitor"].value ("lastError", ""), "HTTP 503");
    // The capacity search's error share (#2815), at both levels of the section.
    const auto& capacity = document["report"]["capacity"];
    EXPECT_TRUE (capacity.contains ("maxErrorPct"));
    EXPECT_TRUE (capacity.contains ("kneeErrorPct"));
    EXPECT_TRUE (capacity["levels"].at (0).contains ("errorPct"));
    // And the completions each level was judged on (#2926). Mutation check:
    // drop "samples" from CAPACITY_LEVEL_KEYS and this fails.
    EXPECT_EQ (capacity["levels"].at (0).value ("samples", -1), 50);
    // The allowlist has to name it, or the export drops the replays (#2799).
    // Mutation check: drop "connectionReplays" from SUMMARY_KEYS and this fails.
    EXPECT_EQ (document["report"]["summary"].value ("connectionReplays", -1), 2);
    // The same for the mean in flight (#2821). Mutation check: drop
    // "avgInFlight" from SUMMARY_KEYS and this fails.
    EXPECT_DOUBLE_EQ (document["report"]["summary"].value ("avgInFlight", -1.0), 4.2);
    // And the completions inside the sending window (#2882). Mutation check:
    // drop "completedWhileSending" from SUMMARY_KEYS and this fails.
    EXPECT_EQ (document["report"]["summary"].value ("completedWhileSending", -1), 97);
    // Both overheads (#2894). Mutation check: drop "cleanupOverhead" from
    // SUMMARY_KEYS and this fails, as does the validation of the required key.
    EXPECT_DOUBLE_EQ (document["report"]["summary"].value ("setupOverhead", -1.0), 0.1);
    EXPECT_DOUBLE_EQ (document["report"]["summary"].value ("cleanupOverhead", -1.0), 0.05);
    // The pacer's skips (#2911). Mutation check: drop "skippedRequests" or
    // "stalledMs" from SUMMARY_KEYS and the matching assertion fails.
    EXPECT_EQ (document["report"]["summary"].value ("skippedRequests", -1), 3);
    EXPECT_DOUBLE_EQ (document["report"]["summary"].value ("stalledMs", -1.0), 300.0);
    // A scenario load run's exact assertions (#2820), picked member by member.
    // Mutation check: drop the `assertions` pick in `scenario_section` and this
    // fails; drop it from the schema and the validation does.
    EXPECT_EQ (document["report"]["scenario"].value ("assertions", json ()),
    (json{ { "passed", 18 }, { "failed", 2 } }));
    // A step's extractor misses (#3053). Mutation check: drop
    // "extractorMisses" from STEP_KEYS and this fails; from the schema and the
    // validation does.
    EXPECT_EQ (
    document["report"]["scenario"]["steps"].at (0).value ("extractorMisses", -1), 1);
    // A tally row names its element and counts a miss and an error apart
    // (#3051). Mutation check: drop "missing" from ELEMENT_TALLY_KEYS, or the
    // origin pick in `element_tallies`, and the matching assertion fails; drop
    // a key from the schema's `elementTally` and the validation does.
    const auto& tally =
    document["report"]["scenario"]["steps"].at (0)["elements"].at (1);
    EXPECT_EQ (tally.value ("name", ""), "Session id");
    EXPECT_EQ (tally.value ("required", false), true);
    EXPECT_EQ (tally.value ("missing", -1), 1);
    EXPECT_EQ (tally.value ("error", -1), 0);
    EXPECT_EQ (tally.value ("origin", json ()),
    (json{ { "kind", "request" }, { "scope", "request" }, { "id", "req_1" },
    { "name", "login" } }));
    const auto& request_tally = document["report"]["elements"].at (0);
    EXPECT_EQ (request_tally.value ("error", -1), 1);
    EXPECT_EQ (request_tally.value ("origin", json ()),
    (json{ { "kind", "collection" }, { "id", "col_1" } }));
    EXPECT_EQ (document["report"]["lifecycle"]["setup"].at (0).value ("name", ""), "Seed data");
    // A lifecycle outcome names its level too, member by member, so a member
    // the origin gains is not carried unread. Mutation check: pick lifecycle
    // outcomes with `pick_each` again (run_export.cpp) and `origin` is gone.
    EXPECT_EQ (document["report"]["lifecycle"]["setup"].at (0).value ("origin", json ()),
    (json{ { "kind", "collection" }, { "scope", "collection" },
    { "id", "col_1" }, { "name", "Shop" } }));
    EXPECT_FALSE (document["timeSeries"].empty ());
}

// #2911: a document written before the skip counters has neither key and
// still validates, so they are properties and not `required`. Mutation check:
// put "skippedRequests" in the schema's `required` and this fails.
TEST_F (RunExportSchemaTest, ADocumentWithoutTheSkipCountersValidates) {
    seed ("run_skips", vayu::RunStatus::Completed, healthy_summary ());
    json document = expect_valid (json{ { "runId", "run_skips" } });
    auto& summary = document["report"]["summary"];
    ASSERT_TRUE (summary.contains ("skippedRequests")) << "nothing to remove";
    summary.erase ("skippedRequests");
    summary.erase ("stalledMs");
    EXPECT_EQ (run_export_schema_errors (schema_, document), "");
}

// A summary stored before them exports them as 0: the run skipped nothing.
TEST_F (RunExportSchemaTest, ARunStoredBeforeTheSkipCountersExportsZero) {
    json summary = healthy_summary ();
    summary.erase ("skipped_requests");
    summary.erase ("stalled_ms");
    seed ("run_pre_skips", vayu::RunStatus::Completed, summary);
    const json document = expect_valid (json{ { "runId", "run_pre_skips" } });
    EXPECT_EQ (document["report"]["summary"].value ("skippedRequests", -1), 0);
    EXPECT_DOUBLE_EQ (document["report"]["summary"].value ("stalledMs", -1.0), 0.0);
}

// #2925: a capacity run's step length and SLO sit in the configuration and
// validate; the schema must hear of both, being closed at that level. Mutation
// check: drop either from `CONFIGURATION_KEYS` and the presence checks fail;
// drop either from the schema's configuration properties and the validation does.
TEST_F (RunExportSchemaTest, ACapacityRunsConfigurationCarriesItsKnobsAndValidates) {
    seed ("run_capacity", vayu::RunStatus::Completed, healthy_summary (), true,
    json{ { "mode", "capacity" }, { "stepDuration", "5s" }, { "sloMs", 200 } });
    const json document = expect_valid (json{ { "runId", "run_capacity" } });
    const json& configuration = document["config"]["configuration"];
    EXPECT_EQ (configuration.value ("stepDuration", ""), "5s");
    EXPECT_EQ (configuration.value ("sloMs", 0), 200);
}

// #2894: a run stored before the split exports its one overhead as cleanup and
// no setup figure, and the document still validates. Mutation check: put
// "setupOverhead" back in the schema's `required` and this fails.
TEST_F (RunExportSchemaTest, ARunStoredBeforeTheOverheadSplitValidates) {
    json summary = healthy_summary ();
    summary.erase ("cleanup_overhead");
    seed ("run_pre_cleanup", vayu::RunStatus::Completed, summary);
    const json document = expect_valid (json{ { "runId", "run_pre_cleanup" } });
    EXPECT_FALSE (document["report"]["summary"].contains ("setupOverhead"));
    EXPECT_DOUBLE_EQ (document["report"]["summary"].value ("cleanupOverhead", -1.0), 0.1);
}

// #2905, #2938: the flags reach the document, and a run that carries one has no
// `latency` section, which the schema no longer requires. Mutation check: drop
// "partial" or "summaryMissing" from SUMMARY_KEYS and the matching test fails;
// drop the property from the schema and the validation does; put "latency" back
// in the report's `required` and both fail validation. #2963: nor does it carry
// `peakConcurrency` or `avgQueueWaitMs`; put either back in the summary's
// `required` and both fail validation.
TEST_F (RunExportSchemaTest, AReconciledRunCarriesItsPartialFlagAndNoLatency) {
    seed ("run_partial", vayu::RunStatus::Failed,
    json{ { "partial", true }, { "total_requests", 40 }, { "test_duration", 4.0 } },
    /*with_samples=*/false);
    const json document = expect_valid (json{ { "runId", "run_partial" } });
    const json& report  = document["report"];
    EXPECT_EQ (report["summary"].value ("partial", false), true);
    EXPECT_FALSE (report["summary"].contains ("summaryMissing"));
    EXPECT_EQ (report["summary"]["totalRequests"], 40);
    EXPECT_FALSE (report.contains ("latency")) << report.dump ();
    EXPECT_FALSE (report["summary"].contains ("peakConcurrency"));
    EXPECT_FALSE (report["summary"].contains ("avgQueueWaitMs"));
}

TEST_F (RunExportSchemaTest, AFailedRunWithNoSummaryCarriesItsMissingFlagAndNoLatency) {
    seed ("run_missing", vayu::RunStatus::Failed, json (), /*with_samples=*/false);
    const json document = expect_valid (json{ { "runId", "run_missing" } });
    const json& report  = document["report"];
    EXPECT_EQ (report["summary"].value ("summaryMissing", false), true);
    EXPECT_FALSE (report["summary"].contains ("partial"));
    EXPECT_FALSE (report.contains ("latency")) << report.dump ();
    EXPECT_FALSE (report["summary"].contains ("peakConcurrency"));
    EXPECT_FALSE (report["summary"].contains ("avgQueueWaitMs"));
}

TEST_F (RunExportSchemaTest, ACompletedRunCarriesNeitherFlag) {
    seed ("run_whole", vayu::RunStatus::Completed, healthy_summary ());
    const json document = expect_valid (json{ { "runId", "run_whole" } });
    EXPECT_FALSE (document["report"]["summary"].contains ("partial"));
    EXPECT_FALSE (document["report"]["summary"].contains ("summaryMissing"));
    EXPECT_EQ (document["report"]["summary"].value ("peakConcurrency", 0), 5);
    EXPECT_DOUBLE_EQ (document["report"]["summary"].value ("avgQueueWaitMs", -1.0), 0.2);
}

TEST_F (RunExportSchemaTest, ARunWithErrorsAndAMissedBudgetValidates) {
    seed ("run_failing", vayu::RunStatus::Completed, failing_summary ());
    expect_valid (json{ { "runId", "run_failing" } });
}

// #2892: the assertion check's two populations and its sample rate are
// allowlisted and named by the schema, and an exact-only check, with no
// `sampleRate`, validates too. Mutation check: drop "sampleRate" from
// THRESHOLD_CHECK_KEYS or the population loop from `threshold_check` and the
// presence assertions fail; drop either member from the schema and the
// validation does.
TEST_F (RunExportSchemaTest, AnAssertionBudgetValidatesWithBothPopulations) {
    json summary          = healthy_summary ();
    summary["thresholds"] = {
        { "checks",
        json::array ({ { { "metric", "maxAssertionFailureRatePct" }, { "limit", 10 },
                       { "actual", 50.0 }, { "passed", false }, { "evaluated", true },
                       { "assertionsExact", { { "passed", 200 }, { "failed", 0 } } },
                       { "assertionsSampled", { { "passed", 1 }, { "failed", 1 } } },
                       { "sampleRate", 100 } },
        { { "metric", "maxAssertionFailureRatePct" }, { "limit", 10 },
        { "actual", 0.0 }, { "passed", true }, { "evaluated", true },
        { "assertionsExact", { { "passed", 5 }, { "failed", 0 } } },
        { "assertionsSampled", { { "passed", 0 }, { "failed", 0 } } } } }) },
        { "passed", 1 }, { "failed", 1 }
    };
    seed ("run_assert_pops", vayu::RunStatus::Completed, summary);

    const json document = expect_valid (json{ { "runId", "run_assert_pops" } });
    const json& checks  = document["report"]["thresholdValidation"]["checks"];
    ASSERT_EQ (checks.size (), 2u) << document.dump (2);
    EXPECT_EQ (checks[0].value ("assertionsExact", json ()),
    (json{ { "passed", 200 }, { "failed", 0 } }));
    EXPECT_EQ (checks[0].value ("assertionsSampled", json ()),
    (json{ { "passed", 1 }, { "failed", 1 } }));
    EXPECT_EQ (checks[0].value ("sampleRate", -1), 100);
    EXPECT_FALSE (checks[1].contains ("sampleRate"));
}

TEST_F (RunExportSchemaTest, AStoppedRunValidates) {
    seed ("run_stopped", vayu::RunStatus::Stopped,
    json{ { "total_requests", 5 }, { "cancelled", 2 },
    { "status_codes", { { "200", 5 } } } });
    const json document =
    expect_valid (json{ { "runId", "run_stopped" }, { "series", "none" } });
    // Stored before #2799: no count, rather than a 0 nobody measured.
    EXPECT_FALSE (document["report"]["summary"].contains ("connectionReplays"));
    // Nor a mean in flight, stored before #2821.
    EXPECT_FALSE (document["report"]["summary"].contains ("avgInFlight"));
    // Nor the completions while sending, stored before #2882.
    EXPECT_FALSE (
    document["report"]["summary"].contains ("completedWhileSending"));
}

// #2817: the allowlist has to name the saturation keys or the export drops the
// level a plateau reports, and the schema has to name them or the document is
// refused. Mutation check: drop "saturationRps" from CAPACITY_KEYS and the
// presence assertion fails; drop it from the schema and the validation does.
TEST_F (RunExportSchemaTest, ARunThatStoppedOnAPlateauValidatesWithItsSaturation) {
    json summary        = healthy_summary ();
    summary["capacity"] = { { "slo_ms", 200 }, { "max_error_pct", 1.0 },
        { "stop_reason", "plateau" },
        { "levels",
        json::array ({ { { "concurrency", 8 }, { "rps", 156 }, { "p99_ms", 52 }, { "error_pct", 0.0 } },
        { { "concurrency", 10 }, { "rps", 156 }, { "p99_ms", 103 }, { "error_pct", 0.0 } },
        { { "concurrency", 12 }, { "rps", 156 }, { "p99_ms", 103 }, { "error_pct", 0.0 } } }) },
        { "max_healthy_concurrency", 12 }, { "max_healthy_rps", 156 },
        { "p99_at_max_healthy_ms", 103 }, { "saturation_concurrency", 8 },
        { "saturation_rps", 156 }, { "saturation_p99_ms", 52 } };
    seed ("run_plateau", vayu::RunStatus::Completed, summary);

    const json document  = expect_valid (json{ { "runId", "run_plateau" } });
    const auto& capacity = document["report"]["capacity"];
    EXPECT_EQ (capacity.value ("saturationConcurrency", -1), 8);
    EXPECT_DOUBLE_EQ (capacity.value ("saturationRps", -1.0), 156.0);
    EXPECT_DOUBLE_EQ (capacity.value ("saturationP99Ms", -1.0), 52.0);
    EXPECT_FALSE (capacity.contains ("kneeConcurrency"));
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

// #2888: a tick that counts statuses by completion second exports them, in
// the shape the schema bounds, and an entry outside that shape is dropped
// rather than failing the document. The first seeded tick is the pre-#2866
// shape (no key) and the last closed no second (`[]`).
// Mutation check: copy the entries unfiltered and the malformed entry fails
// the validation; drop `status_seconds` from the schema's tick properties and
// every tick that carries it fails the validation.
TEST_F (RunExportSchemaTest, ATickWithStatusSecondsValidatesAndAMalformedEntryIsDropped) {
    seed ("run_seconds", vayu::RunStatus::Completed, healthy_summary ());
    const auto store = [&] (const vayu::core::MetricTickSample& sample, const json& extra) {
        json payload = vayu::core::build_metric_tick_payload (sample);
        for (const json& entry : extra) {
            payload["status_seconds"].push_back (entry);
        }
        db_->add_metric_tick ({ 0, "run_seconds", sample.timestamp, payload.dump () });
    };
    vayu::core::MetricTickSample counted;
    counted.timestamp          = START_MS + 2000;
    counted.elapsed_seconds    = 2.0;
    counted.requests_completed = 20;
    counted.status_codes       = { { 200, 19 }, { 500, 1 } };
    counted.status_seconds = { { 0, 1, { 9, 0, 0, 1, 0 } }, { 1, 2, { 10, 0, 0, 0, 0 } } };
    store (counted,
    json::array ({ { { "second", 2 }, { "span", 1 }, { "counts", { -1, 0, 0, 0, 0 } } } }));

    vayu::core::MetricTickSample quiet;
    quiet.timestamp          = START_MS + 3000;
    quiet.elapsed_seconds    = 3.0;
    quiet.requests_completed = 20;
    quiet.status_codes       = { { 200, 19 }, { 500, 1 } };
    store (quiet, json::array ());

    const json document = expect_valid (json{ { "runId", "run_seconds" } });
    const json& series  = document["timeSeries"];
    ASSERT_EQ (series.size (), 3u) << document.dump (2);
    EXPECT_FALSE (series[0].contains ("status_seconds")) << series[0].dump ();
    EXPECT_EQ (series[1]["status_seconds"], json::parse (R"([{"second":0,"span":1,"counts":[9,0,0,1,0]},
                     {"second":1,"span":2,"counts":[10,0,0,0,0]}])"));
    EXPECT_EQ (series[2]["status_seconds"], json::array ());
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
