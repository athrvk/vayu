/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_export_test.cpp
 * @brief `POST /export/run-report` (#2127): what the document leaves out, how
 *        it reads the report, and the refusals - the route core called
 *        directly, the suite's route-test convention.
 *
 * The leak fixture stores a run whose snapshot, traces, captured samples and
 * script output each carry a marker; none of the markers may reach the file.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "temp_database.hpp"
#include "vayu/core/run_compare.hpp"
#include "vayu/core/run_export.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/types.hpp"
#include "vayu/version.hpp"

namespace {

using nlohmann::json;
using vayu::core::RunExportInput;
using vayu::core::RunExportRun;
using vayu::http::routes::export_run_report_response;

/// 2026-10-05T08:10:00Z.
constexpr int64_t START_MS = 1791187800000;

json leak_snapshot () {
    return json{ { "url", "https://u:p@h/x?api_key=LIT&page=2" }, { "method", "POST" },
        { "headers", { { "X-Custom", "LEAKHDR" }, { "Authorization", "<redacted>" } } },
        { "params",
        json::array ({ { { "key", "api_key" }, { "value", "LIT" } },
        { { "key", "page" }, { "value", "2" } } }) },
        { "body", { { "mode", "json" }, { "content", R"({"note":"LEAKBODY"})" } } },
        { "auth", { { "mode", "bearer" } } }, { "requestName", "Checkout load" },
        { "comment", "nightly" }, { "mode", "constant_vus" },
        { "duration", "60s" }, { "concurrency", 10 } };
}

json leak_summary () {
    return json{ { "total_requests", 6 }, { "rps", 0.1 }, { "test_duration", 60.0 },
        { "status_codes", { { "200", 5 }, { "500", 1 } } },
        { "latency",
        { { "min", 1.0 }, { "max", 9.0 }, { "avg", 3.0 }, { "p50", 2.0 }, { "p75", 3.0 },
        { "p90", 4.0 }, { "p95", 5.0 }, { "p99", 8.0 }, { "p999", 9.0 } } },
        { "sampling", { { "response_bodies_captured", 1 } } },
        { "thresholds",
        { { "checks",
          json::array ({ { { "metric", "latencyP99Ms" }, { "limit", 50 },
          { "actual", 8.0 }, { "passed", true }, { "evaluated", true } } }) },
        { "passed", 1 }, { "failed", 0 } } },
        { "schemaValidation",
        { { "sampled", 2 }, { "checked", 2 }, { "valid", 1 }, { "failed", 1 },
        { "unevaluated", 0 },
        { "failures", json::array ({ { { "status", 200 }, { "path", "/id" }, { "message", "LEAKSCHEMA" } } }) },
        { "failuresTotal", 1 } } },
        { "lifecycle",
        { { "teardown",
        json::array ({ { { "id", "el_t" }, { "kind", "script.teardown" }, { "origin", json::object () },
        { "outcome", "error" }, { "message", "LEAKSCRIPT" } } }) } } },
        { "auth",
        { { "refreshes", json::array () }, { "refreshFailures", 1 },
        { "lastError", "LEAKAUTH" } } } };
}

/// Every key name anywhere under @p node.
void collect_keys (const json& node, std::vector<std::string>& keys) {
    if (node.is_object ()) {
        for (const auto& [key, value] : node.items ()) {
            keys.push_back (key);
            collect_keys (value, keys);
        }
    } else if (node.is_array ()) {
        for (const json& value : node) {
            collect_keys (value, keys);
        }
    }
}

class RunExportTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_run_export.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    void seed_run (const std::string& id,
    vayu::RunType type,
    vayu::RunStatus status,
    const json& snapshot = json{ { "url", "https://x.test/a" }, { "method", "GET" } },
    const json& summary = json ()) {
        vayu::db::Run run;
        run.id              = id;
        run.type            = type;
        run.status          = status;
        run.config_snapshot = snapshot.dump ();
        run.start_time      = START_MS;
        run.end_time        = START_MS + 60000;
        db_->create_run (run);
        if (!summary.is_null ()) {
            db_->update_run_summary (id, summary.dump ());
        }
    }

    /// A finished load run whose snapshot recorded @p expect_continue as its
    /// `defaultHeaders` decision, or none when it is null (a run from before
    /// issue #2516).
    void seed_expect_continue_run (const std::string& id, const json& expect_continue) {
        json snapshot = { { "url", "https://x.test/a" }, { "method", "GET" } };
        if (!expect_continue.is_null ()) {
            snapshot["defaultHeaders"] = { { "expectContinue", expect_continue } };
        }
        seed_run (id, vayu::RunType::Load, vayu::RunStatus::Completed, snapshot,
        json{ { "total_requests", 10 }, { "test_duration", 60.0 } });
    }

    /// A data-driven run over one file, read with its numbers cast or not.
    void seed_data_file_run (const std::string& id, bool cast_numbers) {
        json snapshot = { { "url", "https://x.test/a" }, { "method", "GET" },
            { "dataRowCount", 2 }, { "dataFileName", "users.csv" },
            { "dataFileHash", std::string (64, 'a') } };
        if (cast_numbers) {
            snapshot["dataFileCastNumbers"] = true;
        }
        seed_run (id, vayu::RunType::Load, vayu::RunStatus::Completed, snapshot,
        json{ { "total_requests", 10 }, { "test_duration", 60.0 } });
    }

    /// The leak fixture: credentials and payload in the snapshot, a trace
    /// carrying the sent `Authorization`, a captured `Set-Cookie`, and one
    /// metric tick. A non-null @p status_seconds is stored on the tick as it
    /// stands, a shape the engine would never write included; null stores the
    /// tick as a run from before #2866 has it.
    void seed_leak_run (const std::string& id, const json& status_seconds = json ()) {
        seed_run (id, vayu::RunType::Load, vayu::RunStatus::Completed,
        leak_snapshot (), leak_summary ());
        vayu::db::Result result;
        result.run_id      = id;
        result.timestamp   = START_MS + 10;
        result.status_code = 500;
        result.status_text = "Internal Server Error";
        result.latency_ms  = 4.0;
        result.trace_data =
        json{ { "rawRequest", "POST /x\r\nAuthorization: Bearer LEAKTRACE" },
            { "sentHeaders", { { "Authorization", "Bearer LEAKTRACE" } } },
            { "error_type", "http_error" } }
        .dump ();
        vayu::db::PendingResultBody body;
        body.result_index = 0;
        body.headers   = json{ { "Set-Cookie", "session=LEAKSAMPLE" } }.dump ();
        body.body      = "LEAKSAMPLE";
        body.body_hash = "hash-leak";
        body.body_bytes = 10;
        db_->add_results_batch ({ result }, { body });

        vayu::db::MetricTick tick;
        tick.run_id    = id;
        tick.timestamp = START_MS + 1000;
        json payload   = json{ { "timestamp", START_MS + 1000 },
              { "elapsed_seconds", 1.0 }, { "requests_completed", 6 },
              { "requests_failed", 1 }, { "http_errors", 1 }, { "no_response", 0 },
              { "cancelled", 0 }, { "current_rps", 6.0 }, { "current_concurrency", 2 },
              { "send_rate", 6.0 }, { "throughput", 6.0 }, { "backpressure", 0 },
              { "error_rate", 16.7 }, { "dropped_requests", 0 },
              { "bytes_sent", 10 }, { "bytes_received", 20 },
              { "status_codes", { { "200", 5 }, { "500", 1 } } }, { "latency_p50_ms", 1.0 },
              { "latency_p95_ms", 2.0 }, { "latency_p99_ms", 3.0 } };
        if (!status_seconds.is_null ()) {
            payload["status_seconds"] = status_seconds;
        }
        tick.payload = payload.dump ();
        db_->add_metric_tick (tick);
    }

    /// A 200 export of @p body, its document parsed.
    std::pair<json, json> export_ok (const json& body) {
        auto [status, envelope] = export_run_report_response (*db_, body);
        EXPECT_EQ (status, 200) << envelope.dump ();
        const json document = envelope.contains ("text") ?
        json::parse (envelope["text"].get<std::string> ()) :
        json ();
        return { envelope, document };
    }

    // A `const char*`, not a `std::string_view`: MSVC finds `json == string_view`
    // ambiguous (C2666) between json's operator and string_view's.
    void expect_refusal (const json& body, int status, const char* code) {
        auto [got, envelope] = export_run_report_response (*db_, body);
        EXPECT_EQ (got, status) << body.dump () << " -> " << envelope.dump ();
        EXPECT_EQ (envelope["error"]["code"], code) << envelope.dump ();
    }

    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (RunExportTest, NoMarkerFromTheLeakFixtureReachesTheFile) {
    seed_leak_run ("run_leak");
    auto [envelope, document] = export_ok (json{ { "runId", "run_leak" } });
    const std::string text    = envelope["text"].get<std::string> ();
    ASSERT_FALSE (text.empty ());
    for (const char* marker : { "LIT", "p@", "LEAKHDR", "LEAKBODY", "LEAKTRACE",
         "LEAKSAMPLE", "LEAKSCHEMA", "LEAKSCRIPT", "LEAKAUTH" }) {
        EXPECT_EQ (text.find (marker), std::string::npos) << marker << " in:\n"
                                                          << text;
    }
    EXPECT_EQ (document["config"]["url"], "https://u@h/x?api_key=&page=2");
    EXPECT_EQ (envelope["notes"]["urlCredentialsOmitted"], 2);
}

TEST_F (RunExportTest, NoTraceResultOrSampleKeyAnywhere) {
    seed_leak_run ("run_leak");
    auto [envelope, document] = export_ok (json{ { "runId", "run_leak" } });
    std::vector<std::string> keys;
    collect_keys (document, keys);
    ASSERT_FALSE (keys.empty ());
    for (const std::string& key : keys) {
        for (const char* forbidden : { "trace", "rawRequest", "sentHeaders", "results" }) {
            EXPECT_NE (key, forbidden);
        }
    }
}

TEST_F (RunExportTest, KeepsNamesAndShapeButNoValues) {
    seed_leak_run ("run_leak");
    auto [envelope, document] = export_ok (json{ { "runId", "run_leak" } });
    const json& config        = document["config"];
    EXPECT_EQ (config["method"], "POST");
    EXPECT_EQ (config["headerNames"], json::array ({ "Authorization", "X-Custom" }));
    EXPECT_EQ (config["paramNames"], json::array ({ "api_key", "page" }));
    EXPECT_EQ (config["body"], (json{ { "mode", "json" }, { "bytes", 19 } }));
    EXPECT_EQ (config["auth"], (json{ { "mode", "bearer" } }));
    EXPECT_EQ (config["configuration"]["concurrency"], 10);
    EXPECT_EQ (document["run"]["name"], "Checkout load");
    EXPECT_EQ (document["run"]["comment"], "nightly");

    std::vector<std::string> codes;
    for (const json& entry : document["notCarried"]) {
        codes.push_back (entry["code"]);
    }
    EXPECT_EQ (codes,
    (std::vector<std::string>{ "traces_and_samples", "request_values",
    "message_text", "credential_refreshes" }));
    EXPECT_FALSE (document["report"].contains ("auth"));
    EXPECT_EQ (document["report"]["schemaValidation"]["failuresTotal"], 1);
    EXPECT_FALSE (document["report"]["schemaValidation"].contains ("failures"));
    EXPECT_EQ (document["report"]["lifecycle"]["teardown"][0]["outcome"], "error");
}

TEST_F (RunExportTest, StatusCodesAreAnObjectWhileTheReportCarriesPairs) {
    seed_leak_run ("run_leak");
    auto [status, report] = vayu::http::routes::run_report_response (*db_, "run_leak");
    ASSERT_EQ (status, 200);
    ASSERT_TRUE (report["statusCodes"].is_array ()) << report["statusCodes"].dump ();
    EXPECT_EQ (report["statusCodes"][0], json::array ({ 200, 5 }));

    auto [envelope, document] = export_ok (json{ { "runId", "run_leak" } });
    EXPECT_EQ (document["report"]["statusCodes"], (json{ { "200", 5 }, { "500", 1 } }));
    EXPECT_EQ (document["report"]["errors"]["byStatusCode"], (json{ { "500", 1 } }));
}

TEST_F (RunExportTest, EnvelopeNamesTheFileAndItsType) {
    seed_leak_run ("run_leak");
    auto [envelope, document] = export_ok (json{ { "runId", "run_leak" } });
    EXPECT_EQ (envelope["fileName"], "Checkout load 2026-10-05 0810.run.json");
    EXPECT_EQ (envelope["mimeType"], "application/json");
    EXPECT_EQ (document["schema"], "vayu.run-report");
    EXPECT_EQ (document["schemaVersion"], 1);
    EXPECT_EQ (document["engineVersion"], vayu::Version::string);
    EXPECT_EQ (document["run"]["reference"],
    "Vayu run \"Checkout load\" (run_leak) - load test, POST /x, "
    "2026-10-05T08:10:00Z, completed");
    EXPECT_TRUE (document["comparison"].is_null ());
}

TEST_F (RunExportTest, TimeSeriesIsAllowlistedAndOptional) {
    seed_leak_run ("run_leak");
    auto [full, document] = export_ok (json{ { "runId", "run_leak" } });
    ASSERT_EQ (document["timeSeries"].size (), 1U);
    const json& tick = document["timeSeries"][0];
    EXPECT_EQ (tick["requests_failed"], 1);
    EXPECT_EQ (tick["status_codes"], (json{ { "200", 5 }, { "500", 1 } }));
    EXPECT_FALSE (tick.contains ("send_rate"));
    EXPECT_FALSE (tick.contains ("timestamp"));

    auto [none, without] =
    export_ok (json{ { "runId", "run_leak" }, { "series", "none" } });
    EXPECT_FALSE (without.contains ("timeSeries"));
}

// #2888: the allowlist copies the key by hand because `pick` carries scalars
// and lists of scalars only.
// Mutation check: drop `copy_status_seconds` from `time_series` and the copied
// and empty cases fail; copy `stored` unfiltered and the malformed case fails.
TEST_F (RunExportTest, StatusSecondsAreCopiedWhenTheStoredTickCarriesThem) {
    const json entries = json::array (
    { { { "second", 0 }, { "span", 1 }, { "counts", { 9, 0, 0, 1, 0 } } },
    { { "second", 1 }, { "span", 3 }, { "counts", { 30, 3, 0, 0, 2 } } } });
    seed_leak_run ("run_seconds", entries);

    auto [envelope, document] = export_ok (json{ { "runId", "run_seconds" } });
    ASSERT_EQ (document["timeSeries"].size (), 1U);
    EXPECT_EQ (document["timeSeries"][0]["status_seconds"], entries);
}

TEST_F (RunExportTest, AnEmptyStatusSecondsIsKeptAsTheSeriesWideSwitch) {
    seed_leak_run ("run_seconds", json::array ());

    auto [envelope, document] = export_ok (json{ { "runId", "run_seconds" } });
    const json& tick          = document["timeSeries"][0];
    ASSERT_TRUE (tick.contains ("status_seconds")) << tick.dump ();
    EXPECT_EQ (tick["status_seconds"], json::array ());
}

TEST_F (RunExportTest, ATickStoredBeforeStatusSecondsExportsWithoutTheKey) {
    seed_leak_run ("run_before");
    auto [envelope, document] = export_ok (json{ { "runId", "run_before" } });
    EXPECT_FALSE (document["timeSeries"][0].contains ("status_seconds"));
}

TEST_F (RunExportTest, AMalformedStatusSecondsEntryIsDroppedAndTheRestKept) {
    const json good = { { "second", 4 }, { "span", 1 }, { "counts", { 1, 2, 3, 4, 5 } } };
    seed_leak_run ("run_seconds",
    json::array ({ "not an entry", 7, nullptr,
    { { "second", -1 }, { "span", 1 }, { "counts", { 1, 0, 0, 0, 0 } } },
    { { "second", 1.5 }, { "span", 1 }, { "counts", { 1, 0, 0, 0, 0 } } },
    { { "second", 0 }, { "span", 0 }, { "counts", { 1, 0, 0, 0, 0 } } },
    { { "second", 0 }, { "span", 1 }, { "counts", { 1, 0, 0, 0 } } },
    { { "second", 0 }, { "span", 1 }, { "counts", { 1, 0, 0, 0, 0, 0 } } },
    { { "second", 0 }, { "span", 1 }, { "counts", { 1, 0, 0, -1, 0 } } },
    { { "second", 0 }, { "span", 1 }, { "counts", { 1, 0, 0, 0.5, 0 } } },
    { { "second", 0 }, { "span", 1 }, { "counts", { "1", 0, 0, 0, 0 } } },
    { { "second", 0 }, { "span", 1 } }, { { "span", 1 }, { "counts", { 1, 0, 0, 0, 0 } } }, good,
    { { "second", 5 }, { "span", 1 }, { "counts", { 0, 0, 0, 0, 0 } }, { "note", "LEAKNOTE" } } }));

    auto [envelope, document] = export_ok (json{ { "runId", "run_seconds" } });
    EXPECT_EQ (document["timeSeries"][0]["status_seconds"],
    json::array (
    { good, { { "second", 5 }, { "span", 1 }, { "counts", { 0, 0, 0, 0, 0 } } } }));
}

TEST_F (RunExportTest, AStatusSecondsThatIsNotAnArrayIsLeftOut) {
    seed_leak_run ("run_seconds", json::object ());
    auto [envelope, document] = export_ok (json{ { "runId", "run_seconds" } });
    EXPECT_FALSE (document["timeSeries"][0].contains ("status_seconds"));
}

TEST_F (RunExportTest, AStoppedRunIsAResult) {
    seed_run ("run_stopped", vayu::RunType::Load, vayu::RunStatus::Stopped);
    auto [envelope, document] = export_ok (json{ { "runId", "run_stopped" } });
    EXPECT_EQ (document["verdict"]["state"], "not_judged");
    EXPECT_EQ (document["verdict"]["stoppedEarly"], true);
}

TEST_F (RunExportTest, RefusesWhatIsNotAFinishedLoadRun) {
    seed_run ("run_load", vayu::RunType::Load, vayu::RunStatus::Completed);
    seed_run ("run_design", vayu::RunType::Design, vayu::RunStatus::Completed);
    seed_run ("run_sequence", vayu::RunType::Scenario, vayu::RunStatus::Completed);
    seed_run ("run_running", vayu::RunType::Load, vayu::RunStatus::Running);
    seed_run ("run_pending", vayu::RunType::Load, vayu::RunStatus::Pending);

    expect_refusal (json{ { "runId", "run_nope" } }, 404, "not_found");
    expect_refusal (json{ { "runId", "run_design" } }, 400, "unsupported_run_type");
    expect_refusal (json{ { "runId", "run_sequence" } }, 400, "unsupported_run_type");
    expect_refusal (json{ { "runId", "run_running" } }, 409, "run_in_progress");
    expect_refusal (json{ { "runId", "run_pending" } }, 409, "run_in_progress");

    expect_refusal (json{ { "runId", "run_load" }, { "baseRunId", "run_nope" } },
    404, "not_found");
    expect_refusal (json{ { "runId", "run_load" }, { "baseRunId", "run_load" } },
    400, "bad_request");
    expect_refusal (json{ { "runId", "run_load" }, { "baseRunId", "run_design" } },
    400, "unsupported_run_type");
    expect_refusal (json{ { "runId", "run_load" }, { "baseRunId", "run_running" } },
    409, "run_in_progress");
}

TEST_F (RunExportTest, ComparesWithAFinishedLoadBase) {
    seed_run ("run_load", vayu::RunType::Load, vayu::RunStatus::Completed,
    json{ { "url", "https://x.test/a" }, { "method", "GET" } },
    json{ { "total_requests", 200 }, { "test_duration", 60.0 },
    { "status_codes", { { "200", 200 } } } });
    seed_run ("run_base", vayu::RunType::Load, vayu::RunStatus::Stopped,
    json{ { "url", "https://x.test/a" }, { "method", "GET" } },
    json{ { "total_requests", 100 }, { "test_duration", 6.0 },
    { "status_codes", { { "200", 90 }, { "503", 10 } } } });
    const json document =
    export_ok (json{ { "runId", "run_load" }, { "baseRunId", "run_base" } }).second;
    const json& comparison = document["comparison"];
    ASSERT_TRUE (comparison.is_object ()) << document.dump (2);
    EXPECT_EQ (comparison["baseRunId"], "run_base");
    EXPECT_EQ (comparison["baseReference"], "Vayu run \"GET /a\" (run_base) - load test, GET /a, 2026-10-05T08:10:00Z, stopped");
    EXPECT_EQ (comparison["differences"], json::parse (R"([{"field":"duration","base":"6 s, stopped","target":"60 s"},
        {"field":"status","base":"Stopped","target":"Completed"}])"));
    ASSERT_EQ (comparison["deltas"].size (), vayu::core::COMPARED_METRICS.size ());
    EXPECT_EQ (comparison["deltas"][9], json::parse (R"({"metric":"summary.totalRequests","base":100,"target":200,
        "delta":100.0,"pctChange":100.0,"direction":"neutral"})"));
    EXPECT_EQ (comparison["statusCodes"],
    json::parse (R"({"200":{"base":90,"target":200},"503":{"base":10,"target":0}})"));
}

// Two runs that differ only in sendExpectContinue are not the same experiment
// (issue #2516), and an old run with no key reads as "not allowed".
TEST_F (RunExportTest, ComparingRunsThatDifferOnlyInExpectContinueSaysSo) {
    seed_expect_continue_run ("run_allowed", true);
    seed_expect_continue_run ("run_refused", false);
    seed_expect_continue_run ("run_allowed_again", true);
    seed_expect_continue_run ("run_old", json ());

    const auto differences = [this] (const char* run, const char* base) {
        return export_ok (json{ { "runId", run }, { "baseRunId", base } }).second["comparison"]["differences"];
    };
    EXPECT_EQ (differences ("run_allowed", "run_refused"),
    json::parse (R"([{"field":"expect_continue","base":"not allowed","target":"allowed"}])"));
    EXPECT_EQ (differences ("run_refused", "run_allowed"),
    json::parse (R"([{"field":"expect_continue","base":"allowed","target":"not allowed"}])"));
    EXPECT_EQ (differences ("run_allowed", "run_old"),
    json::parse (R"([{"field":"expect_continue","base":"not allowed","target":"allowed"}])"));
    EXPECT_EQ (differences ("run_allowed_again", "run_allowed"), json::array ());
    EXPECT_EQ (differences ("run_refused", "run_old"), json::array ());
}

TEST_F (RunExportTest, TheConfigurationNamesWhetherExpectContinueWasAllowed) {
    seed_expect_continue_run ("run_allowed", true);
    seed_expect_continue_run ("run_refused", false);
    seed_expect_continue_run ("run_old", json ());

    const auto configuration = [this] (const char* run) {
        return export_ok (json{ { "runId", run } }).second["config"]["configuration"];
    };
    EXPECT_EQ (configuration ("run_allowed").at ("expectContinue"), true);
    EXPECT_EQ (configuration ("run_refused").at ("expectContinue"), false);
    EXPECT_FALSE (configuration ("run_old").contains ("expectContinue"));
}

// One file read two ways is two data sets (issue #2540): the export names the
// reading, and a comparison says it differs although the hash agrees.
// Mutation check: drop `dataFileCastNumbers` from `CONFIGURATION_KEYS` and the
// configuration half reds; compare only the hashes in `data_file_difference`
// and the comparison half does.
TEST_F (RunExportTest, ADataFileReadWithNumbersCastIsNamedAndComparesAsADifferentFile) {
    seed_data_file_run ("run_text", false);
    seed_data_file_run ("run_cast", true);

    const auto configuration = [this] (const char* run) {
        return export_ok (json{ { "runId", run } }).second["config"]["configuration"];
    };
    EXPECT_EQ (configuration ("run_cast").value ("dataFileCastNumbers", false), true);
    EXPECT_FALSE (configuration ("run_text").contains ("dataFileCastNumbers"));

    const json differences =
    export_ok (json{ { "runId", "run_cast" }, { "baseRunId", "run_text" } }).second["comparison"]["differences"];
    const json expected =
    json::array ({ json{ { "field", "data_file" }, { "base", "users.csv (aaaaaaaa)" },
    { "target", "users.csv (aaaaaaaa), numbers read as numbers" } } });
    EXPECT_EQ (differences, expected);
}

TEST_F (RunExportTest, ABaseRunsCredentialsStayOutOfTheComparison) {
    seed_leak_run ("run_leak");
    seed_run ("run_load", vayu::RunType::Load, vayu::RunStatus::Completed);
    auto [envelope, document] =
    export_ok (json{ { "runId", "run_load" }, { "baseRunId", "run_leak" } });
    const std::string text = envelope["text"].get<std::string> ();
    for (const char* marker : { "LIT", "p@", "LEAKHDR", "LEAKBODY", "LEAKTRACE",
         "LEAKSAMPLE", "LEAKSCHEMA", "LEAKSCRIPT", "LEAKAUTH" }) {
        EXPECT_EQ (text.find (marker), std::string::npos) << marker << " in:\n"
                                                          << text;
    }
    // The base differs in its request, so its URL is shown - cut to its path.
    const json& differences = document["comparison"]["differences"];
    const auto request      = std::ranges::find_if (
    differences, [] (const json& d) { return d.at ("field") == "request"; });
    ASSERT_NE (request, differences.end ()) << differences.dump (2);
    EXPECT_EQ (*request,
    (json{ { "field", "request" }, { "base", "POST https://h/x" },
    { "target", "GET https://x.test/a" } }));
}

TEST_F (RunExportTest, HtmlIsTextHtmlNamedAfterTheRun) {
    seed_leak_run ("run_leak");
    auto [status, envelope] = export_run_report_response (
    *db_, json{ { "runId", "run_leak" }, { "format", "html" } });
    ASSERT_EQ (status, 200) << envelope.dump ();
    EXPECT_EQ (envelope["mimeType"], "text/html");
    EXPECT_EQ (envelope["fileName"], "Checkout load 2026-10-05 0810.run.html");
    EXPECT_EQ (envelope["notes"]["urlCredentialsOmitted"], 2);
    const std::string text = envelope["text"].get<std::string> ();
    EXPECT_TRUE (text.starts_with ("<!DOCTYPE html>")) << text;
    EXPECT_NE (text.find ("<h1>Checkout load</h1>"), std::string::npos) << text;
}

TEST_F (RunExportTest, HtmlDrawsTheSeriesWhateverTheRequestSaidAboutIt) {
    seed_leak_run ("run_leak");
    for (const json& series : { json ("full"), json ("none"), json () }) {
        json body = { { "runId", "run_leak" }, { "format", "html" } };
        if (!series.is_null ()) {
            body["series"] = series;
        }
        auto [status, envelope] = export_run_report_response (*db_, body);
        ASSERT_EQ (status, 200) << envelope.dump ();
        EXPECT_NE (envelope["text"].get<std::string> ().find ("<svg"), std::string::npos)
        << body.dump ();
    }
    // The other formats still honour it.
    auto [status, envelope] = export_run_report_response (
    *db_, json{ { "runId", "run_leak" }, { "series", "none" } });
    ASSERT_EQ (status, 200) << envelope.dump ();
    EXPECT_EQ (
    json::parse (envelope["text"].get<std::string> ()).contains ("timeSeries"), false);
}

TEST_F (RunExportTest, MarkdownIsTextMarkdownNamedAfterTheRun) {
    seed_leak_run ("run_leak");
    auto [status, envelope] = export_run_report_response (
    *db_, json{ { "runId", "run_leak" }, { "format", "markdown" } });
    ASSERT_EQ (status, 200) << envelope.dump ();
    EXPECT_EQ (envelope["mimeType"], "text/markdown");
    EXPECT_EQ (envelope["fileName"], "Checkout load 2026-10-05 0810.run.md");
    EXPECT_EQ (envelope["notes"]["urlCredentialsOmitted"], 2);
    const std::string text = envelope["text"].get<std::string> ();
    EXPECT_TRUE (text.starts_with ("# Checkout load\n")) << text;
    EXPECT_NE (text.find ("| Error rate "), std::string::npos) << text;
}

// #2905: a run whose summary is partial, or missing, says so in all three
// formats; a completed run says neither. Mutation check: drop "partial" and
// "summaryMissing" from SUMMARY_KEYS and the JSON and the two text formats fail.
TEST_F (RunExportTest, AReconciledRunSaysSoInEveryFormat) {
    struct Case {
        std::string id;
        vayu::RunStatus status;
        json summary;
        /// The summary flag the document carries, and the text both renderers
        /// open with for it; both empty for a run that carries none.
        std::string flag;
        std::string notice;
    };
    const std::array<Case, 3> cases = { {
    { "run_partial", vayu::RunStatus::Failed,
    json{ { "partial", true }, { "total_requests", 40 }, { "test_duration", 4.0 } },
    "partial", "Partial run:" },
    { "run_missing", vayu::RunStatus::Failed, json (), "summaryMissing", "No summary was recorded" },
    { "run_whole", vayu::RunStatus::Completed,
    json{ { "total_requests", 10 }, { "test_duration", 60.0 } }, "", "" },
    } };
    for (const Case& c : cases) {
        seed_run (c.id, vayu::RunType::Load, c.status,
        json{ { "url", "https://x.test/a" }, { "method", "GET" } }, c.summary);
        const json summary =
        export_ok (json{ { "runId", c.id } }).second["report"]["summary"];
        for (const std::string key : { "partial", "summaryMissing" }) {
            EXPECT_EQ (summary.contains (key), key == c.flag) << c.id << " " << key;
        }
        for (const char* format : { "markdown", "html" }) {
            const auto [status, envelope] = export_run_report_response (
            *db_, json{ { "runId", c.id }, { "format", format } });
            ASSERT_EQ (status, 200) << envelope.dump ();
            const std::string text = envelope["text"].get<std::string> ();
            const bool says_so =
            !c.notice.empty () && text.find (c.notice) != std::string::npos;
            EXPECT_EQ (says_so, !c.notice.empty ()) << c.id << " " << format;
            EXPECT_EQ (text.find ("Partial run:") != std::string::npos, c.flag == "partial")
            << c.id << " " << format;
        }
    }
}

TEST_F (RunExportTest, NoMarkerFromTheLeakFixtureReachesTheMarkdown) {
    seed_leak_run ("run_leak");
    seed_run ("run_load", vayu::RunType::Load, vayu::RunStatus::Completed);
    // The leak run is exported itself, and again as the base of a comparison.
    for (const json& body : { json{ { "runId", "run_leak" }, { "format", "markdown" } },
         json{ { "runId", "run_load" }, { "baseRunId", "run_leak" }, { "format", "markdown" } } }) {
        auto [status, envelope] = export_run_report_response (*db_, body);
        ASSERT_EQ (status, 200) << envelope.dump ();
        const std::string text = envelope["text"].get<std::string> ();
        ASSERT_FALSE (text.empty ());
        for (const char* marker : { "LIT", "p@", "LEAKHDR", "LEAKBODY",
             "LEAKTRACE", "LEAKSAMPLE", "LEAKSCHEMA", "LEAKSCRIPT", "LEAKAUTH" }) {
            EXPECT_EQ (text.find (marker), std::string::npos) << marker << " in:\n"
                                                              << text;
        }
    }
}

TEST_F (RunExportTest, NoMarkerFromTheLeakFixtureReachesTheHtml) {
    seed_leak_run ("run_leak");
    seed_run ("run_load", vayu::RunType::Load, vayu::RunStatus::Completed);
    // The leak run is exported itself, and again as the base of a comparison.
    for (const json& body : { json{ { "runId", "run_leak" }, { "format", "html" } },
         json{ { "runId", "run_load" }, { "baseRunId", "run_leak" }, { "format", "html" } } }) {
        auto [status, envelope] = export_run_report_response (*db_, body);
        ASSERT_EQ (status, 200) << envelope.dump ();
        const std::string text = envelope["text"].get<std::string> ();
        ASSERT_FALSE (text.empty ());
        for (const char* marker : { "LIT", "p@", "LEAKHDR", "LEAKBODY",
             "LEAKTRACE", "LEAKSAMPLE", "LEAKSCHEMA", "LEAKSCRIPT", "LEAKAUTH" }) {
            EXPECT_EQ (text.find (marker), std::string::npos) << marker << " in:\n"
                                                              << text;
        }
    }
}

TEST_F (RunExportTest, RefusesAMalformedBody) {
    seed_run ("run_load", vayu::RunType::Load, vayu::RunStatus::Completed);
    expect_refusal (json::array (), 400, "bad_request");
    expect_refusal (json::object (), 400, "bad_request");
    expect_refusal (json{ { "runId", "" } }, 400, "bad_request");
    expect_refusal (json{ { "runId", "run_load" }, { "format", "pdf" } }, 400, "bad_request");
    expect_refusal (json{ { "runId", "run_load" }, { "format", 1 } }, 400, "bad_request");
    expect_refusal (json{ { "runId", "run_load" }, { "series", "some" } }, 400, "bad_request");
    expect_refusal (json{ { "runId", "run_load" }, { "baseRunId", 7 } }, 400, "bad_request");
}

// --- the builder, without a database -----------------------------------------

/// @p assertions is the scenario's exact population (`{passed, failed}`); null
/// leaves the report without a `scenario` section, as a single-request run has.
RunExportRun judged_run (const std::string& status,
const json& thresholds,
double error_rate,
const json& assertions = json ()) {
    RunExportRun run;
    run.id     = "run_v";
    run.status = status;
    run.report =
    json{ { "summary", { { "totalRequests", 10 }, { "errorRate", error_rate } } } };
    if (!thresholds.is_null ()) {
        run.report["thresholdValidation"] = thresholds;
    }
    if (!assertions.is_null ()) {
        run.report["scenario"] = { { "assertions", assertions } };
    }
    return run;
}

json verdict_of (const RunExportRun& run) {
    RunExportInput input;
    input.run = run;
    vayu::core::RunExportNotes notes;
    const auto document = vayu::core::build_run_export_document (input, notes);
    return json::parse (document.at ("verdict").dump ());
}

TEST (RunExportBuilder, VerdictFollowsTheBudgetsAndTheStatus) {
    const json met = { { "checks", json::array ({ { { "metric", "latencyP99Ms" } } }) },
        { "passed", 1 }, { "failed", 0 }, { "verdict", "passed" } };
    const json missed = { { "checks", json::array ({ { { "metric", "latencyP99Ms" } } }) },
        { "passed", 0 }, { "failed", 1 }, { "verdict", "failed" } };
    struct Case {
        std::string status;
        json thresholds;
        double error_rate;
        std::string state;
        std::string reason;
    };
    const auto cases = std::to_array<Case> ({
    { "stopped", missed, 0.0, "not_judged", "stopped" },
    { "failed", json (), 0.0, "failed", "run_failed" },
    { "failed", missed, 0.0, "failed", "budgets_missed" },
    { "completed", missed, 0.0, "failed", "budgets_missed" },
    { "completed", met, 0.0, "passed", "budgets_met" },
    { "completed", met, 2.5, "not_judged", "budgets_met_with_errors" },
    { "completed", json (), 0.0, "not_judged", "no_budgets" },
    });
    for (const Case& c : cases) {
        const json verdict =
        verdict_of (judged_run (c.status, c.thresholds, c.error_rate));
        EXPECT_EQ (verdict["state"], c.state) << c.status << " " << c.reason;
        EXPECT_EQ (verdict["reason"], c.reason) << c.status;
        EXPECT_EQ (verdict["stoppedEarly"], c.status == "stopped");
    }
}

/// A failed exact assertion keeps met budgets from reading `passed`, as
/// `judgeRun` does (#2820). Mutation check: drop `any_assertion_failed` from
/// `verdict_section` and the first two rows answer `passed`/`budgets_met`.
TEST (RunExportBuilder, FailedAssertionsKeepMetBudgetsFromPassing) {
    const json met = { { "checks", json::array ({ { { "metric", "latencyP99Ms" } } }) },
        { "passed", 1 }, { "failed", 0 }, { "verdict", "passed" } };
    const json some_failed = { { "passed", 8352 }, { "failed", 68 } };
    const json none_failed = { { "passed", 8420 }, { "failed", 0 } };
    struct Case {
        std::string status;
        json thresholds;
        double error_rate;
        json assertions;
        std::string state;
        std::string reason;
    };
    const auto cases = std::to_array<Case> ({
    { "completed", met, 0.0, some_failed, "not_judged", "budgets_met_with_assertion_failures" },
    { "completed", met, 0.0, json{ { "passed", 0 }, { "failed", 4580 } },
    "not_judged", "budgets_met_with_assertion_failures" },
    { "completed", met, 0.4, some_failed, "not_judged", "budgets_met_with_errors" },
    { "completed", met, 0.0, none_failed, "passed", "budgets_met" },
    { "completed", met, 0.0, json (), "passed", "budgets_met" },
    { "completed", met, 0.0, json::object (), "passed", "budgets_met" },
    { "completed", json (), 0.0, some_failed, "not_judged", "no_budgets" },
    { "stopped", met, 0.0, some_failed, "not_judged", "stopped" },
    });
    for (const Case& c : cases) {
        const json verdict =
        verdict_of (judged_run (c.status, c.thresholds, c.error_rate, c.assertions));
        EXPECT_EQ (verdict["state"], c.state) << c.reason << " " << c.assertions;
        EXPECT_EQ (verdict["reason"], c.reason) << c.assertions;
    }
}

TEST (RunExportBuilder, ReferenceAndFileNameFollowTheAppsRules) {
    RunExportInput input;
    input.run.id         = "run_r";
    input.run.status     = "completed";
    input.run.start_time = START_MS;
    input.run.config_snapshot = json{ { "url", "https://{{host}}/v1/orders?token=abc#f" },
        { "method", "GET" }, { "requestName", "New Request" } };
    auto outcome =
    vayu::core::export_run_report (input, vayu::core::RUN_EXPORT_FORMATS.front ());
    json document = json::parse (outcome.text);
    EXPECT_EQ (document["run"]["reference"],
    "Vayu run \"GET /v1/orders\" (run_r) - load test, GET /v1/orders, "
    "2026-10-05T08:10:00Z, completed");
    EXPECT_EQ (outcome.file_name, "GET _v1_orders 2026-10-05 0810.run.json");

    input.run.config_snapshot = json{ { "requestName", "say \"hi\"\r\nnow: a/b" },
        { "scenario", { { "collectionId", "col_1" } } } };
    input.run.collection_name = "Checkout";
    outcome =
    vayu::core::export_run_report (input, vayu::core::RUN_EXPORT_FORMATS.front ());
    document = json::parse (outcome.text);
    EXPECT_EQ (document["run"]["reference"],
    "Vayu run \"say \\\"hi\\\" now: a/b\" (run_r) - load test, collection "
    "\"Checkout\", "
    "2026-10-05T08:10:00Z, completed");
    EXPECT_EQ (outcome.file_name, "say _hi___now_ a_b 2026-10-05 0810.run.json");
}

TEST (RunExportBuilder, CarriesOnlyWhatItNames) {
    RunExportInput input;
    input.run.id = "run_a";
    input.run.report =
    json{ { "summary", { { "totalRequests", 1 }, { "futureField", 1 } } },
        { "futureSection", { { "secret", "LEAKNEW" } } },
        { "latency", { { "p50", { { "nested", "LEAKNESTED" } } }, { "p99", 2.0 } } },
        { "metadata", { { "requestUrl", "https://h/?token=LEAKMETA" } } } };
    vayu::core::RunExportNotes notes;
    const std::string text =
    vayu::core::build_run_export_document (input, notes).dump ();
    for (const char* marker :
    { "futureField", "futureSection", "LEAKNEW", "LEAKNESTED", "LEAKMETA" }) {
        EXPECT_EQ (text.find (marker), std::string::npos) << marker << " in:\n"
                                                          << text;
    }
    EXPECT_NE (text.find ("\"p99\":2.0"), std::string::npos) << text;
}

// --- the comparison against the app's ---------------------------------------

/// `engine/tests/fixtures/run-compare-conformance.json`, shared with the app's
/// `compare.conformance.test.ts`, which replays it through both of the app's
/// `compareReports`: a case added there fails whichever side answers it
/// differently.
json load_compare_fixture () {
    const auto path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / "tests" /
    "fixtures" / "run-compare-conformance.json";
    std::ifstream in (path);
    if (!in.good ()) {
        ADD_FAILURE () << "fixture missing: " << path;
        return json::object ();
    }
    return json::parse (in);
}

/// What the engine writes for `compareReports`' @p expected: the three metric
/// groups as one `deltas[]`, and `comparability` as `{field, base, target}`.
json engine_shape (const json& expected) {
    json deltas = json::array ();
    for (const char* group : { "latency", "throughput", "reliability" }) {
        for (const json& metric : expected.at (group)) {
            deltas.push_back (metric);
        }
    }
    json differences = json::array ();
    for (const json& warning : expected.at ("comparability")) {
        differences.push_back ({ { "field", warning.at ("code") },
        { "base", warning.at ("base") }, { "target", warning.at ("target") } });
    }
    return { { "differences", differences }, { "deltas", deltas },
        { "statusCodes", expected.at ("statusCodes") } };
}

TEST (RunCompareConformance, EveryCaseDiffsAsTheAppDiffsIt) {
    const json fixture = load_compare_fixture ();
    ASSERT_TRUE (fixture.contains ("cases"));
    ASSERT_FALSE (fixture.at ("cases").empty ());
    for (const json& c : fixture.at ("cases")) {
        const json got =
        json (vayu::core::compare_run_reports (c.at ("base"), c.at ("target")));
        EXPECT_EQ (got, engine_shape (c.at ("expected")))
        << c.at ("name").get<std::string> () << "\n"
        << got.dump (2);
    }
}

} // namespace
