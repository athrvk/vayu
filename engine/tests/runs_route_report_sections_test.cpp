/**
 * @file tests/runs_route_report_sections_test.cpp
 * @brief The report's per-section figures: slow counts, error types and classes, contract coverage,
 * element outcomes, schema validation, capacity, saturation, phases, and the sections an absent
 * summary leaves out.
 *
 * Covers the route's extracted core in isolation, matching the suite's other route tests (no
 * in-process HTTP server). The `RunsRouteTest` fixture is in `runs_route_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <array>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include "runs_route_fixture.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/spec_coverage.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"

using nlohmann::json;

namespace {

using vayu::tests::summary_inputs;

namespace {
constexpr std::string_view SLOW_TRACE = R"({"isSlow":true,"thresholdMs":500})";
}

// #2399: the slow store keeps at most `max_slow_results` traces, so counting
// them reported a 60,000-outlier run as having 3. The stored summary's count is
// the run's and the traces are reported beside it as the sample they are.
// Mutation check: drop `apply_summary_slow_requests` from apply_run_summary and
// `count` reds at 3.
TEST_F (RunsRouteTest, ReportSlowCountIsTheSummarysNotTheStoredTraces) {
    seed ({ .id = "run_slow_exact", .start_time = 1000 });
    for (int i = 0; i < 3; ++i) {
        seed_traced_result ("run_slow_exact", 200, 900.0, std::string (SLOW_TRACE));
    }
    auto inputs              = summary_inputs ();
    inputs.total_requests    = 100000;
    inputs.slow_total        = 60000;
    inputs.slow_threshold_ms = 500;
    db_->update_run_summary (
    "run_slow_exact", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_slow_exact");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("slowRequests")) << body.dump ();
    const auto& slow = body["slowRequests"];
    EXPECT_EQ (slow["count"].get<size_t> (), 60000u);
    EXPECT_EQ (slow["thresholdMs"].get<size_t> (), 500u);
    EXPECT_EQ (slow["tracesStored"].get<size_t> (), 3u);
    EXPECT_DOUBLE_EQ (slow["percentage"].get<double> (), 60.0);
}

// A summary that measured with a threshold and found nothing slow says 0, which
// is an answer; one with no `slow_requests` key (stored before #2399, or a 0
// threshold) is not, and the report counts the stored traces as it always did.
TEST_F (RunsRouteTest, ReportSlowCountFallsBackToTracesOnlyWhenTheSummaryHasNone) {
    seed ({ .id = "run_slow_zero", .start_time = 1000 });
    auto measured              = summary_inputs ();
    measured.slow_threshold_ms = 500;
    db_->update_run_summary (
    "run_slow_zero", vayu::core::build_run_summary_payload (measured).dump ());

    auto [zero_status, zero] =
    vayu::http::routes::run_report_response (*db_, "run_slow_zero");
    ASSERT_EQ (zero_status, 200);
    ASSERT_TRUE (zero.contains ("slowRequests")) << zero.dump ();
    EXPECT_EQ (zero["slowRequests"]["count"].get<size_t> (), 0u);
    EXPECT_EQ (zero["slowRequests"]["tracesStored"].get<size_t> (), 0u);
    EXPECT_EQ (zero["slowRequests"]["thresholdMs"].get<size_t> (), 500u);

    seed ({ .id = "run_slow_legacy", .start_time = 1000 });
    for (int i = 0; i < 2; ++i) {
        seed_traced_result ("run_slow_legacy", 200, 900.0, std::string (SLOW_TRACE));
    }
    const auto legacy_summary =
    vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_FALSE (legacy_summary.contains ("slow_requests"));
    db_->update_run_summary ("run_slow_legacy", legacy_summary.dump ());

    auto [legacy_status, legacy] =
    vayu::http::routes::run_report_response (*db_, "run_slow_legacy");
    ASSERT_EQ (legacy_status, 200);
    ASSERT_TRUE (legacy.contains ("slowRequests")) << legacy.dump ();
    EXPECT_EQ (legacy["slowRequests"]["count"].get<size_t> (), 2u);
    EXPECT_EQ (legacy["slowRequests"]["tracesStored"].get<size_t> (), 2u);
    EXPECT_EQ (legacy["slowRequests"]["thresholdMs"].get<size_t> (), 500u);
}

namespace {
constexpr std::string_view TIMEOUT_TRACE = R"({"error_type":"timeout"})";
}

// #2400: the error store keeps the first `maxStoredErrors` records, so counting
// them by type reported a 300,000-timeout run as 10,000 beside an exact
// 300,000 no-response count. The summary's counts are the run's; `withDetails`
// stays the stored-record count. Mutation check: drop
// `apply_summary_error_types` from apply_run_summary and `timeout` reds at
// 10,000.
TEST_F (RunsRouteTest, ReportErrorTypesAreTheSummarysNotTheStoredRecords) {
    seed ({ .id = "run_types_exact", .start_time = 1000 });
    std::vector<vayu::db::Result> stored (10000);
    for (auto& result : stored) {
        result.run_id      = "run_types_exact";
        result.timestamp   = 1000;
        result.status_code = 0;
        result.error       = "timed out";
        result.trace_data  = std::string (TIMEOUT_TRACE);
    }
    db_->add_results_batch (stored);
    auto inputs           = summary_inputs ();
    inputs.total_requests = 300000;
    inputs.status_codes   = { { 0, 300000 } };
    inputs.error_types    = { { "timeout", 300000 } };
    db_->update_run_summary (
    "run_types_exact", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_types_exact");
    ASSERT_EQ (status, 200);
    const auto& errors = body["errors"];
    EXPECT_EQ (errors["types"], (nlohmann::json{ { "timeout", 300000 } }))
    << errors.dump ();
    EXPECT_EQ (errors["withDetails"].get<size_t> (), 10000u);
    EXPECT_EQ (errors["total"].get<size_t> (), 300000u);
}

// A summary stored before #2400 has no `error_types` key, and the report counts
// the stored records by type as it always did.
TEST_F (RunsRouteTest, ReportErrorTypesFallBackToStoredRecordsOnlyWhenTheSummaryHasNone) {
    seed ({ .id = "run_types_legacy", .start_time = 1000 });
    for (int i = 0; i < 2; ++i) {
        seed_traced_result ("run_types_legacy", 0, 0.0, std::string (TIMEOUT_TRACE));
    }
    auto legacy_summary = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_EQ (legacy_summary.erase ("error_types"), 1u);
    db_->update_run_summary ("run_types_legacy", legacy_summary.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_types_legacy");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["errors"]["types"], (nlohmann::json{ { "timeout", 2 } }))
    << body["errors"].dump ();
    EXPECT_EQ (body["errors"]["withDetails"].get<size_t> (), 2u);
}

// #3828: the stored classes reach the report's `summary.errorClasses`, `{}`
// for a run in which no reply failed. Mutation check: drop
// `apply_summary_error_classes` from apply_run_summary and both read absent.
TEST_F (RunsRouteTest, ReportErrorClassesAreTheSummarys) {
    seed ({ .id = "run_classes", .start_time = 1000 });
    auto inputs = summary_inputs ();
    inputs.error_classes.record (vayu::McpErrorClass::Tool, std::nullopt);
    inputs.error_classes.record (vayu::McpErrorClass::Tool, std::nullopt);
    inputs.error_classes.record (vayu::McpErrorClass::Protocol, -32602);
    db_->update_run_summary (
    "run_classes", vayu::core::build_run_summary_payload (inputs).dump ());
    seed ({ .id = "run_classes_none", .start_time = 1000 });
    db_->update_run_summary ("run_classes_none",
    vayu::core::build_run_summary_payload (summary_inputs ()).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_classes");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["summary"].value ("errorClasses", nlohmann::json ()),
    nlohmann::json::parse (R"({"tool":2,"protocol":1,"protocolCodes":{"-32602":1}})"))
    << body["summary"].dump ();
    auto [none_status, none] =
    vayu::http::routes::run_report_response (*db_, "run_classes_none");
    ASSERT_EQ (none_status, 200);
    EXPECT_EQ (none["summary"].value ("errorClasses", nlohmann::json ()),
    nlohmann::json::object ())
    << none["summary"].dump ();
}

// A summary stored before #3828 has no `error_classes`, and the report leaves
// the key out rather than reading `{}`, which would say no reply failed; a
// stored count that is not a positive integer is skipped.
TEST_F (RunsRouteTest, ReportErrorClassesAreAbsentForAnOlderSummaryAndReadTolerantly) {
    seed ({ .id = "run_classes_legacy", .start_time = 1000 });
    auto legacy = vayu::core::build_run_summary_payload (summary_inputs ());
    ASSERT_EQ (legacy.erase ("error_classes"), 1u);
    db_->update_run_summary ("run_classes_legacy", legacy.dump ());
    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_classes_legacy");
    ASSERT_EQ (status, 200);
    EXPECT_FALSE (body["summary"].contains ("errorClasses")) << body["summary"].dump ();

    seed ({ .id = "run_classes_odd", .start_time = 1000 });
    auto odd = vayu::core::build_run_summary_payload (summary_inputs ());
    odd["error_classes"] = nlohmann::json::parse (
    R"({"transport":2,"tool":0,"protocol":"3","bogus":5,
        "protocolCodes":{"-32602":-1,"-32000":1,"other":1.5}})");
    db_->update_run_summary ("run_classes_odd", odd.dump ());
    auto [odd_status, odd_body] =
    vayu::http::routes::run_report_response (*db_, "run_classes_odd");
    ASSERT_EQ (odd_status, 200);
    EXPECT_EQ (odd_body["summary"].value ("errorClasses", nlohmann::json ()),
    nlohmann::json::parse (R"({"transport":2,"protocolCodes":{"-32000":1}})"))
    << odd_body["summary"].dump ();
}

// ---------------------------------------------------------------------------
// Contract coverage (issue #629)
// ---------------------------------------------------------------------------

// The whole path in one assertion set: a tally records what a run sent, the
// summary stores what it built, and the report hands it back unchanged. The
// pass-through is the property - re-keying it in the route would be a second
// place to keep the shape, which is why nothing here translates a name.
TEST_F (RunsRouteTest, ReportCarriesTheCoverageBlockTheRunComputed) {
    seed ({ .id = "run_coverage", .start_time = 1000 });

    vayu::core::DeclaredOperation listed;
    listed.operation_id = "listPets";
    listed.method       = "GET";
    listed.path         = "/pets";
    listed.responses    = { "200", "404" };
    vayu::core::DeclaredOperation never;
    never.method    = "DELETE";
    never.path      = "/pets/{petId}";
    never.responses = { "204" };

    vayu::core::CoverageTally tally ({ listed, never },
    { R"({"operationId":"listPets","method":"GET","path":"/pets"})" });
    tally.record (0, 200);
    tally.record (0, 500);

    auto inputs     = summary_inputs ();
    inputs.coverage = tally.build ();
    db_->update_run_summary (
    "run_coverage", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_coverage");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("coverage")) << body.dump ();
    const auto& coverage = body["coverage"];
    EXPECT_EQ (coverage["operationsTotal"].get<size_t> (), 2u);
    EXPECT_EQ (coverage["operationsCovered"].get<size_t> (), 1u);
    EXPECT_EQ (coverage["declaredResponsesTotal"].get<size_t> (), 3u);
    EXPECT_EQ (coverage["declaredResponsesHit"].get<size_t> (), 1u);
    EXPECT_EQ (coverage["undeclaredStatusesSeen"].get<size_t> (), 1u);
    // Uncovered first, so the operation nobody called is the first row read.
    ASSERT_EQ (coverage["operations"].size (), 2u);
    EXPECT_EQ (coverage["operations"][0]["path"].get<std::string> (), "/pets/{petId}");
    EXPECT_EQ (coverage["operations"][0]["sent"].get<size_t> (), 0u);
}

// ---------------------------------------------------------------------------
// Single-request run element outcomes (issues #1594, #1641)
// ---------------------------------------------------------------------------

// The engine already wrote a single-request run's per-element tally onto its
// summary (issue #1594, `RequestElementTallies::build`); the report route
// dropped the key before this fix (issue #1641). Same whole path as coverage
// above: computed, stored, handed back unchanged, no name translated.
TEST_F (RunsRouteTest, ReportCarriesTheElementsBlockTheRunComputed) {
    seed ({ .id = "run_elements", .start_time = 1000 });

    auto inputs = summary_inputs ();
    inputs.elements =
    nlohmann::json::array ({ { { "id", "el_1" }, { "kind", "assert.status" },
                             { "passed", 9 }, { "failed", 1 }, { "skipped", 0 } },
    { { "id", "el_2" }, { "kind", "extract.json" }, { "passed", 10 },
    { "failed", 0 }, { "skipped", 0 } } });
    db_->update_run_summary (
    "run_elements", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_elements");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("elements")) << body.dump ();
    const auto& elements = body["elements"];
    ASSERT_EQ (elements.size (), 2u);
    EXPECT_EQ (elements[0]["kind"].get<std::string> (), "assert.status");
    EXPECT_EQ (elements[0]["passed"].get<size_t> (), 9u);
    EXPECT_EQ (elements[0]["failed"].get<size_t> (), 1u);
    EXPECT_EQ (elements[1]["kind"].get<std::string> (), "extract.json");
}

// ---------------------------------------------------------------------------
// Sampled schema validation (issue #682)
// ---------------------------------------------------------------------------

// The same whole path, for the block beside coverage: the deferred pass tallies
// what the reservoirs held, the summary stores it, and the report hands it back
// unchanged. Nothing translates a name here either.
TEST_F (RunsRouteTest, ReportCarriesTheSchemaValidationBlockTheRunComputed) {
    seed ({ .id = "run_schema", .start_time = 1000 });

    vayu::core::ValidationVerdict passed;
    passed.checked = true;
    passed.valid   = true;
    vayu::core::ValidationVerdict broke;
    broke.checked  = true;
    broke.valid    = false;
    broke.failures = { vayu::core::SchemaFailure{ "/id", "expected integer" } };
    broke.failures_total = 1;
    vayu::core::ValidationVerdict skipped;
    skipped.reason = vayu::core::UncheckedReason::BodyNotJson;

    vayu::core::SampledValidationTotals totals;
    totals.record (passed, "list pets", 200);
    totals.record (broke, "get pet", 200);
    totals.record (skipped, "get pet", 500);

    auto inputs = summary_inputs ();
    inputs.schema_validation = vayu::core::build_sampled_validation_payload (totals);
    db_->update_run_summary (
    "run_schema", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_schema");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("schemaValidation")) << body.dump ();
    const auto& validation = body["schemaValidation"];
    // The denominator rides through: without it a reader cannot tell these
    // figures describe the reservoir rather than the run.
    EXPECT_EQ (validation["sampled"].get<size_t> (), 3u);
    EXPECT_EQ (validation["checked"].get<size_t> (), 2u);
    EXPECT_EQ (validation["valid"].get<size_t> (), 1u);
    EXPECT_EQ (validation["failed"].get<size_t> (), 1u);
    EXPECT_EQ (validation["uncheckedReasons"]["body_not_json"].get<size_t> (), 1u);
    ASSERT_EQ (validation["failures"].size (), 1u);
    EXPECT_EQ (validation["failures"][0]["step"].get<std::string> (), "get pet");
}

// The anchor coverage is read against, asserted at the route for the first time
// (noted on #629 when phase 1 closed): the report echoes the *snapshot's*
// binding, so a reader can say which document a coverage block was computed
// against - and an unbound run echoes nothing at all.
TEST_F (RunsRouteTest, ReportEchoesTheSpecTheRunWasPlannedAgainst) {
    seed ({ .id = "run_openapi",
    .start_time = 1000,
    .config_snapshot = R"({"url":"https://x.test/","scenario":{"collectionId":"col_1","openapi":{"specId":"spec_1","specHash":"abc"}}})" });

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_openapi");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body["metadata"].contains ("openapi")) << body.dump ();
    EXPECT_EQ (body["metadata"]["openapi"]["specId"].get<std::string> (), "spec_1");
    EXPECT_EQ (body["metadata"]["openapi"]["specHash"].get<std::string> (), "abc");

    seed ({ .id = "run_unbound",
    .start_time = 1000,
    .config_snapshot = R"({"url":"https://x.test/","scenario":{"collectionId":"col_1"}})" });
    auto [unbound_status, unbound] =
    vayu::http::routes::run_report_response (*db_, "run_unbound");
    ASSERT_EQ (unbound_status, 200);
    EXPECT_FALSE (unbound["metadata"].contains ("openapi")) << unbound.dump ();
}

// Mid-run OAuth 2.0 refresh (#478), round-tripped through the stored summary:
// the section is what explains 401s that appear partway through a run, so it
// has to survive the write/read pair, not merely be produced.
TEST_F (RunsRouteTest, ReportCarriesTheAuthRefreshSection) {
    seed ({ .id = "run_auth", .start_time = 1000 });
    auto inputs = summary_inputs ();
    inputs.auth = nlohmann::json{ { "refreshes", { { { "atSeconds", 3620.4 } } } },
        { "refreshFailures", 1 }, { "lastError", "oauth2_provider_error: invalid_grant" } };
    db_->update_run_summary (
    "run_auth", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_auth");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("auth"));
    const auto& auth = body["auth"];
    ASSERT_TRUE (auth["refreshes"].is_array ());
    ASSERT_EQ (auth["refreshes"].size (), 1u);
    EXPECT_DOUBLE_EQ (auth["refreshes"][0]["atSeconds"].get<double> (), 3620.4);
    EXPECT_EQ (auth["refreshFailures"].get<size_t> (), 1u);
    EXPECT_EQ (auth["lastError"].get<std::string> (), "oauth2_provider_error: invalid_grant");
}

// What a capacity search found, round-tripped through the stored summary. The
// property under test is the translation: the search stores snake_case like
// every other section, and the report speaks camelCase, so a key added on one
// side and forgotten on the other reaches the renderer as an absent field
// rather than as a build error.
TEST_F (RunsRouteTest, ReportCarriesWhatTheCapacitySearchFound) {
    seed ({ .id = "run_capacity", .start_time = 1000 });
    auto inputs = summary_inputs ();

    vayu::core::CapacityConfig search;
    search.slo_ms          = 100.0;
    search.max_concurrency = 256;
    const std::vector<vayu::core::CapacityWindow> levels{ { 8, 900.0, 12.0, 0.0, 4500 },
        { 16, 1700.0, 20.0, 0.5, 8500 }, { 32, 1750.0, 180.0, 2.0, 8750 },
        { 32, 1720.0, 210.0, 3.5, 0 } };
    inputs.capacity = vayu::core::summarize_capacity (
    search, levels, vayu::core::capacity_stop::SLO_EXCEEDED);
    db_->update_run_summary (
    "run_capacity", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_capacity");
    ASSERT_EQ (status, 200);

    ASSERT_TRUE (body.contains ("capacity"));
    const auto& capacity = body["capacity"];
    EXPECT_DOUBLE_EQ (capacity["sloMs"].get<double> (), 100.0);
    EXPECT_EQ (capacity["stopReason"].get<std::string> (), "slo_exceeded");
    EXPECT_EQ (capacity["maxHealthyConcurrency"].get<size_t> (), 16u);
    EXPECT_DOUBLE_EQ (capacity["maxHealthyRps"].get<double> (), 1700.0);
    EXPECT_DOUBLE_EQ (capacity["p99AtMaxHealthyMs"].get<double> (), 20.0);
    EXPECT_EQ (capacity["kneeConcurrency"].get<size_t> (), 32u);
    EXPECT_DOUBLE_EQ (capacity["kneeP99Ms"].get<double> (), 210.0);
    EXPECT_DOUBLE_EQ (capacity.at ("kneeErrorPct").get<double> (), 3.5);
    EXPECT_DOUBLE_EQ (capacity.at ("maxErrorPct").get<double> (), search.max_error_pct);
    EXPECT_FALSE (capacity.contains ("saturationConcurrency"));

    ASSERT_EQ (capacity["levels"].size (), 4u);
    EXPECT_EQ (capacity["levels"][0]["concurrency"].get<size_t> (), 8u);
    EXPECT_DOUBLE_EQ (capacity["levels"][0]["rps"].get<double> (), 900.0);
    EXPECT_DOUBLE_EQ (capacity["levels"][0]["p99Ms"].get<double> (), 12.0);
    EXPECT_DOUBLE_EQ (capacity["levels"][1].at ("errorPct").get<double> (), 0.5);
    // #2926: a level's completions reach the report, a 0 included.
    // Mutation-check: drop the copy_optional_number of "samples" in
    // read_capacity_section and these throw on the absent key.
    EXPECT_EQ (capacity["levels"][0].at ("samples").get<size_t> (), 4500u);
    EXPECT_EQ (capacity["levels"][1].at ("samples").get<size_t> (), 8500u);
    EXPECT_EQ (capacity["levels"][3].at ("samples").get<size_t> (), 0u);
}

// A summary stored before #2815 measured no error share, and one before #2926
// no level's completion count. The report leaves the keys out rather than
// reading them as 0, which would call every level of an old search clean (and
// its p99 a measurement of nothing).
// Mutation-check: read the keys through `read_number` with a 0 default and the
// absent keys come back as zeros.
TEST_F (RunsRouteTest, ReportOmitsTheErrorShareAnOlderSummaryNeverStored) {
    seed ({ .id = "run_capacity_old", .start_time = 1000 });
    auto inputs = summary_inputs ();

    vayu::core::CapacityConfig search;
    search.slo_ms   = 100.0;
    inputs.capacity = vayu::core::summarize_capacity (search,
    { { 8, 900.0, 12.0 }, { 16, 1700.0, 180.0 }, { 16, 1690.0, 190.0 } },
    vayu::core::capacity_stop::SLO_EXCEEDED);
    auto stored     = vayu::core::build_run_summary_payload (inputs);
    ASSERT_TRUE (stored.contains ("capacity"));
    auto& section = stored["capacity"];
    section.erase ("max_error_pct");
    section.erase ("knee_error_pct");
    for (auto& level : section["levels"]) {
        level.erase ("error_pct");
        level.erase ("samples");
    }
    db_->update_run_summary ("run_capacity_old", stored.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_capacity_old");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("capacity"));
    const auto& capacity = body["capacity"];
    EXPECT_EQ (capacity["kneeConcurrency"].get<size_t> (), 16u);
    EXPECT_FALSE (capacity.contains ("kneeErrorPct"));
    EXPECT_FALSE (capacity.contains ("maxErrorPct"));
    ASSERT_EQ (capacity["levels"].size (), 3u);
    EXPECT_FALSE (capacity["levels"][0].contains ("errorPct"));
    EXPECT_FALSE (capacity["levels"][0].contains ("samples"));
}

// A search that ran out of room never watched the service give out, so the
// report carries the headline without a knee - rather than naming the last
// level it happened to reach as the limit.
TEST_F (RunsRouteTest, ReportOmitsTheKneeWhenNoLevelBreached) {
    seed ({ .id = "run_capacity_cap", .start_time = 1000 });
    auto inputs = summary_inputs ();

    vayu::core::CapacityConfig search;
    search.slo_ms   = 100.0;
    inputs.capacity = vayu::core::summarize_capacity (
    search, { { 8, 900.0, 12.0 } }, vayu::core::capacity_stop::CAP_REACHED);
    db_->update_run_summary (
    "run_capacity_cap", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_capacity_cap");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("capacity"));
    EXPECT_FALSE (body["capacity"].contains ("kneeConcurrency"));
    EXPECT_EQ (body["capacity"]["maxHealthyConcurrency"].get<size_t> (), 8u);
    EXPECT_FALSE (body["capacity"].contains ("saturationConcurrency"));
    EXPECT_FALSE (body["capacity"].contains ("saturationRps"));
    EXPECT_FALSE (body["capacity"].contains ("saturationP99Ms"));
}

// A plateau stop names the level where throughput stopped growing beside the
// last level tried, which overshoots it (#2817).
// Mutation-check: leave the three `saturation_*` keys out of
// `read_capacity_section` and they never reach the report.
TEST_F (RunsRouteTest, ReportCarriesTheSaturationOfAPlateau) {
    seed ({ .id = "run_capacity_plateau", .start_time = 1000 });
    auto inputs = summary_inputs ();

    vayu::core::CapacityConfig search;
    search.slo_ms   = 200.0;
    inputs.capacity = vayu::core::summarize_capacity (search,
    { { 6, 130.0, 31.0, 0.0 }, { 8, 156.0, 52.0, 0.0 },
    { 10, 156.0, 103.0, 0.0 }, { 12, 156.0, 103.0, 0.0 } },
    vayu::core::capacity_stop::PLATEAU);
    db_->update_run_summary ("run_capacity_plateau",
    vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] =
    vayu::http::routes::run_report_response (*db_, "run_capacity_plateau");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("capacity"));
    const auto& capacity = body["capacity"];
    EXPECT_EQ (capacity["stopReason"].get<std::string> (), "plateau");
    EXPECT_EQ (capacity["saturationConcurrency"].get<size_t> (), 8u);
    EXPECT_DOUBLE_EQ (capacity["saturationRps"].get<double> (), 156.0);
    EXPECT_DOUBLE_EQ (capacity["saturationP99Ms"].get<double> (), 52.0);
    EXPECT_EQ (capacity["maxHealthyConcurrency"].get<size_t> (), 12u);
}

// Per-phase percentiles round-trip from the histogram bank into the report,
// under `timingBreakdown` beside the averages (issue #476).
TEST_F (RunsRouteTest, ReportCarriesPerPhasePercentiles) {
    seed ({ .id = "run_phases", .start_time = 1000 });
    auto inputs = summary_inputs ();

    std::array<vayu::core::MetricsCollector::Percentiles, vayu::core::TIMING_PHASE_COUNT> phases{};
    // Five distinct magnitudes, so a phase written into the wrong key fails here.
    const auto p50s = std::to_array<double> ({ 0.1, 0.3, 0.0, 2.9, 0.1 });
    const auto p99s = std::to_array<double> ({ 1.4, 8.2, 22.0, 6.1, 0.9 });
    for (size_t i = 0; i < vayu::core::TIMING_PHASE_COUNT; ++i) {
        auto& phase = phases.at (i);
        phase.count = 4321;
        phase.p50   = p50s.at (i);
        phase.p95   = p50s.at (i) * 2.0;
        phase.p99   = p99s.at (i);
        phase.max   = p99s.at (i) * 3.0;
    }
    inputs.phases = phases;
    db_->update_run_summary (
    "run_phases", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_phases");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (body.contains ("timingBreakdown"));
    const auto& breakdown = body["timingBreakdown"];
    ASSERT_TRUE (breakdown.contains ("phases"));
    const auto& reported = breakdown["phases"];

    // Keyed by wire name - `firstByte`, not `ttfb`, and not an array index.
    EXPECT_DOUBLE_EQ (reported["dns"]["p50"].get<double> (), 0.1);
    EXPECT_DOUBLE_EQ (reported["connect"]["p99"].get<double> (), 8.2);
    EXPECT_DOUBLE_EQ (reported["tls"]["p99"].get<double> (), 22.0);
    EXPECT_DOUBLE_EQ (reported["firstByte"]["p50"].get<double> (), 2.9);
    EXPECT_DOUBLE_EQ (reported["download"]["max"].get<double> (), 2.7);
    EXPECT_EQ (reported["tls"]["count"].get<size_t> (), 4321u);
}

namespace {

/// Five phases of 4321 completions each, for a summary's `phases`.
std::array<vayu::core::MetricsCollector::Percentiles, vayu::core::TIMING_PHASE_COUNT>
counted_phases () {
    std::array<vayu::core::MetricsCollector::Percentiles, vayu::core::TIMING_PHASE_COUNT> phases{};
    for (auto& phase : phases) {
        phase.count = 4321;
    }
    return phases;
}

constexpr std::string_view TIMED_TRACE =
R"({"dnsMs":1,"connectMs":2,"tlsMs":3,"firstByteMs":4,"downloadMs":5})";

} // namespace

// #2782: the averages are every completion's, read from each phase's stored
// mean, not the retained trace sample's. The one stored trace says 2 ms of
// connect; the bank's mean over 4321 completions says 0.25 ms. Mutation
// check: drop `apply_summary_phase_means` from `apply_run_summary` and every
// average reads the trace's.
TEST_F (RunsRouteTest, ReportAveragesAreThePhaseMeansNotTheTraceSamples) {
    seed ({ .id = "run_phase_means", .start_time = 1000 });
    seed_traced_result ("run_phase_means", 200, 10.0, std::string (TIMED_TRACE));
    auto inputs   = summary_inputs ();
    inputs.phases = counted_phases ();
    inputs.phase_means = std::to_array<double> ({ 0.05, 0.25, 0.75, 2.5, 0.125 });
    db_->update_run_summary (
    "run_phase_means", vayu::core::build_run_summary_payload (inputs).dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_phase_means");
    ASSERT_EQ (status, 200);
    const auto& breakdown = body.at ("timingBreakdown");
    EXPECT_DOUBLE_EQ (breakdown.at ("avgDnsMs").get<double> (), 0.05);
    EXPECT_DOUBLE_EQ (breakdown.at ("avgConnectMs").get<double> (), 0.25);
    EXPECT_DOUBLE_EQ (breakdown.at ("avgTlsMs").get<double> (), 0.75);
    EXPECT_DOUBLE_EQ (breakdown.at ("avgFirstByteMs").get<double> (), 2.5);
    EXPECT_DOUBLE_EQ (breakdown.at ("avgDownloadMs").get<double> (), 0.125);
    EXPECT_DOUBLE_EQ (
    breakdown.at ("phases").at ("connect").at ("mean").get<double> (), 0.25);
}

// The fallback: a summary whose phases carry no mean (stored before #2782, or
// with one phase's mean missing) keeps the trace sample's averages, all five
// from one population rather than a mix.
TEST_F (RunsRouteTest, ReportAveragesFallBackToTheTraceSampleWithoutEveryPhaseMean) {
    seed ({ .id = "run_no_means", .start_time = 1000 });
    seed_traced_result ("run_no_means", 200, 10.0, std::string (TIMED_TRACE));
    seed ({ .id = "run_partial_means", .start_time = 1000 });
    seed_traced_result ("run_partial_means", 200, 10.0, std::string (TIMED_TRACE));

    auto inputs   = summary_inputs ();
    inputs.phases = counted_phases ();
    db_->update_run_summary (
    "run_no_means", vayu::core::build_run_summary_payload (inputs).dump ());
    inputs.phase_means = std::to_array<double> ({ 0.05, 0.25, 0.75, 2.5, 0.125 });
    auto partial = vayu::core::build_run_summary_payload (inputs);
    partial["phases"]["download"].erase ("mean");
    db_->update_run_summary ("run_partial_means", partial.dump ());

    for (const auto* run_id : { "run_no_means", "run_partial_means" }) {
        auto [status, body] = vayu::http::routes::run_report_response (*db_, run_id);
        ASSERT_EQ (status, 200);
        const auto& breakdown = body.at ("timingBreakdown");
        EXPECT_DOUBLE_EQ (breakdown.at ("avgDnsMs").get<double> (), 1.0) << run_id;
        EXPECT_DOUBLE_EQ (breakdown.at ("avgConnectMs").get<double> (), 2.0) << run_id;
        EXPECT_DOUBLE_EQ (breakdown.at ("avgDownloadMs").get<double> (), 5.0) << run_id;
    }
}

// ---------------------------------------------------------------------------
// The absent-not-zeros rule, one case per report section
// ---------------------------------------------------------------------------

// Every optional section of the report is left out when the run has nothing to
// say, rather than reported as zeros, an empty object or an empty array - a
// zero is a claim ("this run dropped nothing", "no test failed", "every phase
// was instant"), and an absent section is the only way to say "not measured".
// Each case stores `summary_inputs ()` shaped one way and names the key that
// must be missing from the report, under `parent` when it is nested.
struct ReportOmitsCase {
    const char* name;
    /// How this run's inputs differ from `summary_inputs ()`; nullptr for none.
    void (*shape_inputs) (vayu::core::RunSummaryInputs&);
    /// An edit to the stored summary JSON after it is built, for a shape
    /// `build_run_summary_payload` never writes itself (an older engine's
    /// summary, a partial writer); nullptr for none.
    void (*shape_summary) (nlohmann::json&);
    /// The section `absent` is looked for in, asserted present; nullptr for the
    /// top level of the report.
    const char* parent;
    const char* absent;
    /// A key of `parent` that must still be there, so the case proves one key
    /// went missing rather than the whole section; nullptr for none.
    const char* sibling;
    /// Seed one sampled result carrying phase timings, which is what makes the
    /// `timingBreakdown` averages half (and so the object itself) present.
    bool seed_timed_result;
};

constexpr auto REPORT_OMITS_CASES = std::to_array<ReportOmitsCase> ({
// A run recorded before retention was reported has no section - which is not
// the same claim as "this run dropped nothing".
{ "ReportOmitsSamplingWhenTheSummaryPredatesIt", nullptr,
[] (nlohmann::json& summary) { summary.erase ("sampling"); }, nullptr, "sampling", nullptr, false },
// A run recorded between the byte budget (#1155) and its marker (#1192) had
// the budget and no record of whether it spent it. That is not the same claim
// as "it kept its uniformity", so the key is left out rather than reported
// false - and the rest of the section still reads.
{ "ReportOmitsTheBudgetMarkerWhenTheSummaryPredatesIt", nullptr,
[] (nlohmann::json& summary) {
    summary["sampling"].erase ("response_sample_budget_spent");
},
"sampling", "responseSampleBudgetSpent", "responseSamplesDropped", false },
// A run that configured no monitor reports no section, rather than a target
// that reported nothing.
{ "ReportOmitsMonitorWhenNoneWasConfigured",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.monitor = std::nullopt; },
nullptr, nullptr, "monitor", nullptr, false },
// Not a run of zero tests that all passed.
{ "ReportOmitsTestValidationWhenNoScriptRan",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.tests = std::nullopt; },
nullptr, nullptr, "testValidation", nullptr, false },
// `summary_inputs ()` records no custom metric; not an empty object.
{ "ReportOmitsCustomMetricsWhenNoneWereRecorded", nullptr, nullptr, nullptr,
"customMetrics", nullptr, false },
// The not-measured rule for coverage, in both shapes it arrives in: no
// coverage at all, and an object with no rows (an older or a partial
// writer). Neither reports a contract of zero operations.
{ "ReportOmitsCoverageForARunNotMeasuredAgainstAContract",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.coverage = std::nullopt; },
nullptr, nullptr, "coverage", nullptr, false },
{ "ReportOmitsCoverageForARunNotMeasuredAgainstAContract_Empty",
[] (vayu::core::RunSummaryInputs& inputs) {
    inputs.coverage = nlohmann::json{ { "operationsTotal", 0 },
        { "operations", nlohmann::json::array () } };
},
nullptr, nullptr, "coverage", nullptr, false },
// The same for single-request elements (#1594, #1641): no `elements` at all
// (declared none, or a scenario run, which never writes the key), and an
// empty array written straight into the stored summary - the shape
// `build_run_summary_payload` itself never writes, but the route's own guard
// must not trust that upstream discipline blindly.
{ "ReportOmitsElementsForARunThatDeclaredNoneOrRanNone",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.elements = std::nullopt; },
nullptr, nullptr, "elements", nullptr, false },
{ "ReportOmitsElementsForARunThatDeclaredNoneOrRanNone_Empty",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.elements = std::nullopt; },
[] (nlohmann::json& summary) { summary["elements"] = nlohmann::json::array (); },
nullptr, "elements", nullptr, false },
// And for sampled schema validation (#682): no block, and a block that
// checked nothing. Neither reports a contract nothing failed. Mutation-check:
// drop the `sampled > 0` condition in the route's reader and the `_Empty`
// case reddens - the report gains a block claiming a clean run.
{ "ReportOmitsSchemaValidationForARunThatCheckedNothing",
[] (vayu::core::RunSummaryInputs& inputs) {
    inputs.schema_validation = std::nullopt;
},
nullptr, nullptr, "schemaValidation", nullptr, false },
{ "ReportOmitsSchemaValidationForARunThatCheckedNothing_Empty",
[] (vayu::core::RunSummaryInputs& inputs) {
    inputs.schema_validation = nlohmann::json{ { "sampled", 0 },
        { "checked", 0 }, { "valid", 0 }, { "failed", 0 } };
},
nullptr, nullptr, "schemaValidation", nullptr, false },
// No budgets declared - and so every run recorded before budgets existed,
// which is the same stored shape.
{ "ReportOmitsThresholdValidationWhenNoBudgetWasDeclared",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.thresholds = std::nullopt; },
nullptr, nullptr, "thresholdValidation", nullptr, false },
// A run that could not refresh at all (#478), and every run recorded before
// mid-run refresh existed. "Never watching" and "watched and never needed
// to" are different answers; only the absent section can say the first.
{ "ReportOmitsAuthWhenTheRunCouldNotRefresh",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.auth = std::nullopt; },
nullptr, nullptr, "auth", nullptr, false },
// Every mode but a capacity search. A fixed-target run measured a point, and
// a knee of 0 would read as a service that collapses at no concurrency.
{ "ReportOmitsCapacityForEveryOtherMode",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.capacity = std::nullopt; },
nullptr, nullptr, "capacity", nullptr, false },
// A run that recorded no phase distribution reports no `phases` key - five
// zeroed rows would claim every phase was instant. The averages half of
// `timingBreakdown` comes from the sampled traces and is unaffected, which is
// what keeps the two independently present: the seeded timed result keeps
// the object there, so this checks `phases` inside it rather than passing
// because the whole object went missing.
{ "ReportOmitsPhasesWhenNoneWereRecorded",
[] (vayu::core::RunSummaryInputs& inputs) { inputs.phases = std::nullopt; },
nullptr, "timingBreakdown", "phases", "avgDnsMs", true },
});

class RunsReportOmitsTest : public RunsRouteTest,
                            public ::testing::WithParamInterface<ReportOmitsCase> {};

TEST_P (RunsReportOmitsTest, LeavesTheSectionOut) {
    const auto& c = GetParam ();
    seed ({ .id = "run_omits", .start_time = 1000 });
    if (c.seed_timed_result) {
        vayu::db::Result result;
        result.run_id      = "run_omits";
        result.timestamp   = 2000;
        result.status_code = 200;
        result.status_text = "OK";
        result.latency_ms  = 10.0;
        result.trace_data =
        R"({"dnsMs":1.0,"connectMs":2.0,"tlsMs":3.0,"firstByteMs":4.0,"downloadMs":5.0})";
        db_->add_result (result);
    }

    auto inputs = summary_inputs ();
    if (c.shape_inputs != nullptr) {
        c.shape_inputs (inputs);
    }
    auto summary = vayu::core::build_run_summary_payload (inputs);
    if (c.shape_summary != nullptr) {
        c.shape_summary (summary);
    }
    db_->update_run_summary ("run_omits", summary.dump ());

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_omits");
    ASSERT_EQ (status, 200);
    if (c.parent != nullptr) {
        ASSERT_TRUE (body.contains (c.parent)) << body.dump ();
    }
    const auto& section = c.parent == nullptr ? body : body.at (c.parent);
    EXPECT_FALSE (section.contains (c.absent)) << body.dump ();
    if (c.sibling != nullptr) {
        EXPECT_TRUE (section.contains (c.sibling)) << body.dump ();
    }
}

INSTANTIATE_TEST_SUITE_P (PerSection,
RunsReportOmitsTest,
::testing::ValuesIn (REPORT_OMITS_CASES),
[] (const ::testing::TestParamInfo<ReportOmitsCase>& info) {
    return std::string (info.param.name);
});

// A summary that is not a JSON object is treated as absent. There is no second
// aggregate source any more, so the report stands on the run's sampled results
// - which is a report, not a 500 and not an empty run.
TEST_F (RunsRouteTest, MalformedSummaryReportsFromSampledResults) {
    seed ({ .id = "run_bad", .start_time = 1000 });
    db_->update_run_summary ("run_bad", "not json at all");

    for (int i = 0; i < 3; ++i) {
        vayu::db::Result r;
        r.run_id      = "run_bad";
        r.timestamp   = 2000 + i;
        r.status_code = 200;
        r.status_text = "OK";
        r.latency_ms  = 10.0;
        db_->add_result (r);
    }

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_bad");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["summary"]["totalRequests"].get<size_t> (), 3u);
    EXPECT_EQ (body["summary"]["successfulRequests"].get<size_t> (), 3u);
}

// The same for a run that has no summary at all - the engine died before it
// reached a terminal status. Its sampled results are all that survived, and
// they are what the report is built from.
TEST_F (RunsRouteTest, RunWithNoSummaryReportsFromSampledResults) {
    seed ({ .id = "run_orphaned", .status = vayu::RunStatus::Failed, .start_time = 1000 });

    vayu::db::Result r;
    r.run_id      = "run_orphaned";
    r.timestamp   = 2000;
    r.status_code = 500;
    r.status_text = "Internal Server Error";
    r.latency_ms  = 42.0;
    db_->add_result (r);

    auto [status, body] = vayu::http::routes::run_report_response (*db_, "run_orphaned");
    ASSERT_EQ (status, 200);
    EXPECT_EQ (body["summary"]["totalRequests"].get<size_t> (), 1u);
    EXPECT_EQ (body["summary"]["failedRequests"].get<size_t> (), 1u);
    EXPECT_EQ (body["summary"]["httpErrorRequests"].get<size_t> (), 1u);
    EXPECT_EQ (body["summary"]["noResponseRequests"].get<size_t> (), 0u);
}

} // namespace
