/**
 * @file monitor_test.cpp
 * @brief The server-vitals monitor: what a `monitor` block may say, what a
 *        scraped body becomes, and what the scrape loop does to a live run.
 *
 * The parser tests are the ones worth mutating against: every rule here
 * (comments skipped, labelled families summed, non-finite values dropped)
 * decides what a chart shows, and a body that parses "nearly right" draws a
 * plausible line rather than failing.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "mock_server.hpp"
#include "temp_database.hpp"
#include "vayu/core/monitor.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"

namespace {

using nlohmann::json;
using vayu::core::monitor_config_from;
using vayu::core::MonitorFormat;
using vayu::core::MonitorTotals;
using vayu::core::parse_json_metrics;
using vayu::core::parse_prometheus_exposition;
using vayu::core::validate_monitor_config;
using vayu::tests::SlowMockServer;
using Clock = std::chrono::steady_clock;

json monitor_config (json monitor) {
    return json{ { "mode", "constant_rps" }, { "monitor", std::move (monitor) } };
}

// ---------------------------------------------------------------------------
// Validation - the route's gate
// ---------------------------------------------------------------------------

TEST (MonitorConfigValidation, AbsentAndNullAreBothValid) {
    EXPECT_FALSE (validate_monitor_config (json::object ()).has_value ());
    EXPECT_FALSE (validate_monitor_config (json{ { "monitor", nullptr } }).has_value ());
    // ...and neither yields a monitor to run.
    EXPECT_FALSE (monitor_config_from (json::object ()).has_value ());
    EXPECT_FALSE (monitor_config_from (json{ { "monitor", nullptr } }).has_value ());
}

TEST (MonitorConfigValidation, AMinimalBlockIsAcceptedAndDefaulted) {
    auto config = monitor_config (json{ { "url", "http://localhost:9100/metrics" },
    { "series", json::array ({ "up" }) } });
    ASSERT_FALSE (validate_monitor_config (config).has_value ());

    auto parsed = monitor_config_from (config);
    ASSERT_TRUE (parsed.has_value ());
    EXPECT_EQ (parsed->url, "http://localhost:9100/metrics");
    EXPECT_EQ (parsed->interval_ms, vayu::core::monitor_limits::DEFAULT_INTERVAL_MS);
    EXPECT_EQ (parsed->format, MonitorFormat::Prometheus);
    ASSERT_EQ (parsed->series.size (), 1u);
    EXPECT_EQ (parsed->series[0], "up");
}

TEST (MonitorConfigValidation, RejectsAnUnusableBlock) {
    struct Case {
        json monitor;
        const char* what;
    };
    const Case cases[] = {
        { json::array (), "not an object" },
        { json{ { "series", json::array ({ "up" }) } }, "no url" },
        { json{ { "url", "ftp://localhost/metrics" }, { "series", json::array ({ "up" }) } },
        "not http(s)" },
        { json{ { "url", "http://x/m" } }, "no series" },
        { json{ { "url", "http://x/m" }, { "series", json::array () } }, "empty series" },
        { json{ { "url", "http://x/m" }, { "series", json::array ({ "" }) } }, "empty series name" },
        { json{ { "url", "http://x/m" },
          { "series", json::array ({ "a", "b", "c", "d", "e", "f", "g", "h", "i" }) } },
        "too many series" },
        { json{ { "url", "http://x/m" }, { "series", json::array ({ "up" }) },
          { "intervalMs", 10 } },
        "interval below the floor" },
        { json{ { "url", "http://x/m" }, { "series", json::array ({ "up" }) },
          { "intervalMs", 90000 } },
        "interval above the ceiling" },
        { json{ { "url", "http://x/m" }, { "series", json::array ({ "up" }) },
          { "intervalMs", "1s" } },
        "interval not a number" },
        { json{ { "url", "http://x/m" }, { "series", json::array ({ "up" }) },
          { "format", "influx" } },
        "unknown format" },
    };
    for (const auto& c : cases) {
        auto config = monitor_config (c.monitor);
        EXPECT_TRUE (validate_monitor_config (config).has_value ())
        << "accepted a block with " << c.what;
        // A block the route would reject is one the run must not execute
        // either - that is what makes the pair one description, not two.
        EXPECT_FALSE (monitor_config_from (config).has_value ())
        << "would have run a block with " << c.what;
    }
}

TEST (MonitorConfigValidation, LoopbackAndPrivateTargetsAreAllowed) {
    // Deliberate: this is a local tool scraping the user's own infrastructure.
    for (const char* url : { "http://127.0.0.1:9100/metrics", "http://192.168.1.4:9090/metrics",
         "https://localhost/metrics", "HTTP://LOCALHOST/metrics" }) {
        auto config =
        monitor_config (json{ { "url", url }, { "series", json::array ({ "up" }) } });
        EXPECT_FALSE (validate_monitor_config (config).has_value ()) << url;
    }
}

// ---------------------------------------------------------------------------
// The two limits a user can move
// ---------------------------------------------------------------------------

class MonitorLimitsTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_monitor_limits.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }
    void TearDown () override {
        db.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    void set_config (const std::string& key, const std::string& value) {
        auto entry = db->get_config_entry (key);
        ASSERT_TRUE (entry.has_value ()) << "seed_default_config did not seed " << key;
        entry->value = value;
        db->save_config_entry (*entry);
    }

    std::unique_ptr<vayu::db::Database> db;
};

TEST_F (MonitorLimitsTest, AFreshDatabaseYieldsTheSeededDefaults) {
    const auto limits = vayu::core::read_monitor_limits (*db);
    EXPECT_EQ (limits.default_interval_ms, vayu::core::monitor_limits::DEFAULT_INTERVAL_MS);
    EXPECT_EQ (limits.max_series, vayu::core::monitor_limits::MAX_SERIES);
}

// The setting has to reach a block that named no interval of its own, or it
// would be a knob nothing reads on the path clients actually take.
TEST_F (MonitorLimitsTest, TheConfiguredIntervalIsWhatABlockWithoutOneScrapesAt) {
    ASSERT_NO_FATAL_FAILURE (set_config ("monitorIntervalMs", "5000"));
    const auto limits = vayu::core::read_monitor_limits (*db);
    ASSERT_EQ (limits.default_interval_ms, 5000);

    auto config = monitor_config (json{ { "url", "http://localhost:9100/metrics" },
    { "series", json::array ({ "up" }) } });
    auto parsed = monitor_config_from (config, limits);
    ASSERT_TRUE (parsed.has_value ());
    EXPECT_EQ (parsed->interval_ms, 5000);

    // ...and a block that states its own still wins.
    config["monitor"]["intervalMs"] = 250;
    EXPECT_EQ (monitor_config_from (config, limits)->interval_ms, 250);
}

TEST_F (MonitorLimitsTest, TheConfiguredCapIsWhatTheSeriesListIsJudgedAgainst) {
    auto nine_names = json::array ();
    for (int i = 0; i < 9; ++i) {
        nine_names.push_back ("metric_" + std::to_string (i));
    }
    auto config = monitor_config (
    json{ { "url", "http://localhost:9100/metrics" }, { "series", nine_names } });

    // Nine is over the seeded cap of eight...
    EXPECT_TRUE (
    validate_monitor_config (config, vayu::core::read_monitor_limits (*db)).has_value ());

    // ...and under a raised one.
    ASSERT_NO_FATAL_FAILURE (set_config ("monitorMaxSeries", "12"));
    const auto raised = vayu::core::read_monitor_limits (*db);
    ASSERT_EQ (raised.max_series, 12u);
    EXPECT_FALSE (validate_monitor_config (config, raised).has_value ());
    EXPECT_TRUE (monitor_config_from (config, raised).has_value ());
}

// `POST /config` range-checks both keys, so a value outside the range can only
// arrive from a hand-edited row - where a 0 interval is a tight scrape loop and
// a 0 cap rejects every block a user could write.
TEST_F (MonitorLimitsTest, AHandEditedValueOutOfRangeFallsBackToTheSeed) {
    ASSERT_NO_FATAL_FAILURE (set_config ("monitorIntervalMs", "0"));
    ASSERT_NO_FATAL_FAILURE (set_config ("monitorMaxSeries", "0"));

    const auto limits = vayu::core::read_monitor_limits (*db);
    EXPECT_EQ (limits.default_interval_ms, vayu::core::monitor_limits::DEFAULT_INTERVAL_MS);
    EXPECT_EQ (limits.max_series, vayu::core::monitor_limits::MAX_SERIES);
}

// ---------------------------------------------------------------------------
// Prometheus exposition parsing
// ---------------------------------------------------------------------------

TEST (PrometheusParser, ReadsPlainAndLabelledSamples) {
    const std::string body =
    "# HELP node_cpu_seconds_total Seconds\n"
    "# TYPE node_cpu_seconds_total counter\n"
    "node_cpu_seconds_total{cpu=\"0\",mode=\"user\"} 1.5\n"
    "node_cpu_seconds_total{cpu=\"1\",mode=\"user\"} 2.25\n"
    "process_resident_memory_bytes 1.048576e+06\n"
    "unrequested_metric 99\n";
    auto values = parse_prometheus_exposition (
    body, { "node_cpu_seconds_total", "process_resident_memory_bytes" });

    ASSERT_EQ (values.size (), 2u);
    // One labelled family is one series: 1.5 + 2.25.
    EXPECT_DOUBLE_EQ (values["node_cpu_seconds_total"], 3.75);
    EXPECT_DOUBLE_EQ (values["process_resident_memory_bytes"], 1048576.0);
    EXPECT_EQ (values.count ("unrequested_metric"), 0u);
}

TEST (PrometheusParser, SkipsCommentsBlankLinesAndNonFiniteValues) {
    const std::string body =
    "\n"
    "   # a comment that mentions wanted 5\n"
    "wanted NaN\n"
    "also_wanted +Inf\n"
    "third_wanted 4\r\n"                // CRLF: exposition files often are
    "fourth_wanted 12 1700000000000\n"; // trailing timestamp
    auto values = parse_prometheus_exposition (
    body, { "wanted", "also_wanted", "third_wanted", "fourth_wanted" });

    // NaN and +Inf are not chartable numbers, and a name the body did not carry
    // as a readable sample is absent rather than zero.
    EXPECT_EQ (values.count ("wanted"), 0u);
    EXPECT_EQ (values.count ("also_wanted"), 0u);
    ASSERT_EQ (values.count ("third_wanted"), 1u);
    EXPECT_DOUBLE_EQ (values["third_wanted"], 4.0);
    // The exposition timestamp is ignored; the value is still the value.
    ASSERT_EQ (values.count ("fourth_wanted"), 1u);
    EXPECT_DOUBLE_EQ (values["fourth_wanted"], 12.0);
}

TEST (PrometheusParser, ABraceInsideALabelValueDoesNotEndTheLabelSet) {
    // The naive "find the next '}'" scan reads `5}` as the value and drops the
    // sample; the quote-aware one reads 5.
    const std::string body = "queue_depth{name=\"a}b\"} 5\n";
    auto values = parse_prometheus_exposition (body, { "queue_depth" });
    ASSERT_EQ (values.count ("queue_depth"), 1u);
    EXPECT_DOUBLE_EQ (values["queue_depth"], 5.0);
}

TEST (PrometheusParser, AnUnreadableLineCostsOnlyItself) {
    const std::string body = "broken{unterminated 1\n"
                             "good 2\n"
                             "alsobroken\n"
                             "trailing_garbage 3x\n";
    auto values            = parse_prometheus_exposition (
    body, { "broken", "good", "alsobroken", "trailing_garbage" });
    ASSERT_EQ (values.size (), 1u);
    EXPECT_DOUBLE_EQ (values["good"], 2.0);
}

TEST (JsonMetricsParser, ReadsTheRequestedKeysOnly) {
    const std::string body = R"({"cpu": 0.25, "rss": 1024, "name": "web-1", "nan": null})";
    auto values = parse_json_metrics (body, { "cpu", "rss", "name", "nan", "absent" });
    ASSERT_EQ (values.size (), 2u);
    EXPECT_DOUBLE_EQ (values["cpu"], 0.25);
    EXPECT_DOUBLE_EQ (values["rss"], 1024.0);
}

TEST (JsonMetricsParser, AnUnparseableOrNonObjectBodyYieldsNothing) {
    EXPECT_TRUE (parse_json_metrics ("not json", { "cpu" }).empty ());
    EXPECT_TRUE (parse_json_metrics ("[1,2,3]", { "cpu" }).empty ());
}

// ---------------------------------------------------------------------------
// Whole-run totals (the report's `monitor` section)
// ---------------------------------------------------------------------------

TEST (MonitorTotalsTest, SummarisesEachSeriesAndCountsGaps) {
    MonitorTotals totals;
    totals.add ({ { "cpu", 1.0 }, { "rss", 100.0 } });
    totals.add ({ { "cpu", 3.0 } }); // rss missing this scrape
    totals.record_failure ();

    auto summary = totals.to_summary ();
    EXPECT_EQ (summary["samples"], 2u);
    EXPECT_EQ (summary["failures"], 1u);

    const auto& cpu = summary["series"]["cpu"];
    EXPECT_DOUBLE_EQ (cpu["min"].get<double> (), 1.0);
    EXPECT_DOUBLE_EQ (cpu["max"].get<double> (), 3.0);
    EXPECT_DOUBLE_EQ (cpu["avg"].get<double> (), 2.0);
    EXPECT_EQ (cpu["count"], 2u);

    // A series absent from a scrape is not a zero sample - averaging it in
    // would report a memory figure the target never reported.
    const auto& rss = summary["series"]["rss"];
    EXPECT_EQ (rss["count"], 1u);
    EXPECT_DOUBLE_EQ (rss["avg"].get<double> (), 100.0);
}

TEST (MonitorTotalsTest, ASeriesThatNeverReadIsAbsentFromTheSummary) {
    MonitorTotals totals;
    totals.record_failure ();
    auto summary = totals.to_summary ();
    EXPECT_EQ (summary["samples"], 0u);
    EXPECT_TRUE (summary["series"].empty ());
}

// ---------------------------------------------------------------------------
// The scrape loop, against a live run
// ---------------------------------------------------------------------------

class MonitorRunTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_monitor_run.db";

    void SetUp () override {
        vayu::http::global_init ();
        server = std::make_unique<SlowMockServer> ();
        cleanup ();
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }
    void TearDown () override {
        db.reset ();
        cleanup ();
        server.reset ();
        vayu::http::global_cleanup ();
    }

    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    void create_run_row (const std::string& run_id) {
        vayu::db::Run row;
        row.id              = run_id;
        row.type            = vayu::RunType::Load;
        row.status          = vayu::RunStatus::Pending;
        row.config_snapshot = "{}";
        row.start_time = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                         .count ();
        row.end_time = 0;
        db->create_run (row);
    }

    // A short run against the fast endpoint, with the monitor block under test.
    json run_config (json monitor) const {
        return json{ { "mode", "constant_rps" }, { "duration", "3s" },
            { "targetRps", 20.0 }, { "url", server->fast_url () },
            { "method", "GET" }, { "timeout", 5000 }, { "workers", 1 },
            { "monitor", std::move (monitor) } };
    }

    // Let the run reach its own end rather than cutting it short: these tests
    // are about what the scrape did *over* a run, so shutting the manager down
    // straight after start_run would measure its first 300ms.
    void wait_for_terminal (const std::string& run_id, int budget_ms) {
        auto start = Clock::now ();
        while (std::chrono::duration_cast<std::chrono::milliseconds> (Clock::now () - start)
               .count () < budget_ms) {
            auto stored = db->get_run (run_id);
            if (stored && stored->status != vayu::RunStatus::Pending &&
            stored->status != vayu::RunStatus::Running) {
                return;
            }
            std::this_thread::sleep_for (std::chrono::milliseconds (50));
        }
        ADD_FAILURE () << "run " << run_id << " never reached a terminal status";
    }

    std::unique_ptr<SlowMockServer> server;
    std::unique_ptr<vayu::db::Database> db;
};

TEST_F (MonitorRunTest, AConfiguredRunRecordsSamplesForItsWholeDuration) {
    const std::string run_id = "run-monitor-records";
    create_run_row (run_id);

    vayu::core::RunManager manager;
    ASSERT_TRUE (manager.start_run (run_id,
    run_config (json{ { "url", server->vitals_url () }, { "intervalMs", 250 },
    { "series", json::array ({ "vayu_test_cpu", "vayu_test_rss_bytes" }) } }),
    *db, false));
    wait_for_terminal (run_id, 20000);
    manager.shutdown (std::chrono::milliseconds (15000));

    auto samples = db->get_monitor_samples_paginated (run_id, 5000, 0);
    // ~3s at 250ms; the floor is deliberately loose, the point is "for the
    // whole run" rather than "once at the start".
    ASSERT_GE (samples.size (), 4u) << "only " << samples.size () << " scrapes landed";
    EXPECT_EQ (db->count_monitor_samples (run_id), static_cast<int64_t> (samples.size ()));

    auto payload = json::parse (samples.front ().payload);
    EXPECT_GT (payload["timestamp"].get<int64_t> (), 0);
    // Summed across the two labelled cpu samples the endpoint exports.
    EXPECT_DOUBLE_EQ (payload["series"]["vayu_test_cpu"].get<double> (), 4.0);
    EXPECT_GT (payload["series"]["vayu_test_rss_bytes"].get<double> (), 0.0);
    // A name the exposition carries but the run did not ask for stays out.
    EXPECT_FALSE (payload["series"].contains ("vayu_test_unused"));

    // The report's section, from the same scrape.
    auto stored = db->get_run (run_id);
    ASSERT_TRUE (stored.has_value ());
    auto summary = json::parse (stored->summary);
    ASSERT_TRUE (summary.contains ("monitor")) << stored->summary;
    EXPECT_GE (summary["monitor"]["samples"].get<size_t> (), 4u);
    EXPECT_DOUBLE_EQ (
    summary["monitor"]["series"]["vayu_test_cpu"]["max"].get<double> (), 4.0);

    // And the live topic carried them beside the metrics ticks, on one id space.
    auto context = manager.get_run_or_retained (run_id);
    ASSERT_NE (context, nullptr);
    auto batch      = context->ticks_since (0);
    size_t monitors = 0;
    for (size_t i = 0; i < batch.payloads.size (); ++i) {
        if (batch.payloads[i].rfind ("event: monitor\n", 0) == 0) {
            ++monitors;
        }
    }
    EXPECT_GT (monitors, 0u) << "no monitor frame reached the live stream";
}

TEST_F (MonitorRunTest, AJsonEndpointIsReadWithTheSamePipeline) {
    const std::string run_id = "run-monitor-json";
    create_run_row (run_id);

    vayu::core::RunManager manager;
    ASSERT_TRUE (manager.start_run (run_id,
    run_config (json{ { "url", server->vitals_json_url () }, { "intervalMs", 250 },
    { "format", "json" }, { "series", json::array ({ "vayu_test_cpu" }) } }),
    *db, false));
    wait_for_terminal (run_id, 20000);
    manager.shutdown (std::chrono::milliseconds (15000));

    auto samples = db->get_monitor_samples_paginated (run_id, 5000, 0);
    ASSERT_FALSE (samples.empty ());
    auto payload = json::parse (samples.front ().payload);
    EXPECT_DOUBLE_EQ (payload["series"]["vayu_test_cpu"].get<double> (), 4.0);
}

// The acceptance criterion the design is built around: the scrape is a separate
// thread precisely so a hanging endpoint cannot hold the tick cadence. Run
// against /hang, the run must still finish on time and still produce its
// per-second ticks.
TEST_F (MonitorRunTest, AHangingEndpointStallsNeitherTheRunNorTheTicks) {
    const std::string run_id = "run-monitor-hang";
    create_run_row (run_id);

    vayu::core::RunManager manager;
    auto started = Clock::now ();
    ASSERT_TRUE (manager.start_run (run_id,
    run_config (json{ { "url", server->hang_url () }, { "intervalMs", 500 },
    { "series", json::array ({ "vayu_test_cpu" }) } }),
    *db, false));
    wait_for_terminal (run_id, 25000);
    manager.shutdown (std::chrono::milliseconds (20000));
    auto elapsed =
    std::chrono::duration_cast<std::chrono::milliseconds> (Clock::now () - started)
    .count ();

    // The 3s run plus teardown, nowhere near /hang's 30s hold.
    EXPECT_LT (elapsed, 15000) << "the run waited on the monitor endpoint";

    // Ticks are persisted once a second and are what the charts draw; a scrape
    // blocking the metrics thread would show up as missing ticks.
    EXPECT_GE (db->count_metric_ticks (run_id), 2)
    << "the tick cadence was disturbed by the scrape";
    EXPECT_EQ (db->count_monitor_samples (run_id), 0)
    << "a hung scrape stored a sample";

    // The gaps are counted, so the report says the scrape found nothing rather
    // than silently showing an empty chart.
    auto stored = db->get_run (run_id);
    ASSERT_TRUE (stored.has_value ());
    auto summary = json::parse (stored->summary);
    ASSERT_TRUE (summary.contains ("monitor"));
    EXPECT_EQ (summary["monitor"]["samples"].get<size_t> (), 0u);
    EXPECT_GT (summary["monitor"]["failures"].get<size_t> (), 0u);
}

TEST_F (MonitorRunTest, ARunWithoutAMonitorScrapesNothingAndReportsNoSection) {
    const std::string run_id = "run-monitor-absent";
    create_run_row (run_id);

    json config = json{ { "mode", "constant_rps" }, { "duration", "1s" },
        { "targetRps", 10.0 }, { "url", server->fast_url () },
        { "method", "GET" }, { "timeout", 5000 }, { "workers", 1 } };

    vayu::core::RunManager manager;
    ASSERT_TRUE (manager.start_run (run_id, config, *db, false));
    wait_for_terminal (run_id, 20000);
    manager.shutdown (std::chrono::milliseconds (15000));

    EXPECT_EQ (db->count_monitor_samples (run_id), 0);
    auto stored = db->get_run (run_id);
    ASSERT_TRUE (stored.has_value ());
    auto summary = json::parse (stored->summary);
    EXPECT_FALSE (summary.contains ("monitor"))
    << "a run that configured no monitor reported one";
}

TEST_F (MonitorRunTest, DeletingARunRemovesItsMonitorSamples) {
    const std::string run_id = "run-monitor-cascade";
    create_run_row (run_id);
    db->add_monitor_sample (
    { 0, run_id, 1700000000000, R"({"timestamp":1,"series":{"cpu":1}})" });
    ASSERT_EQ (db->count_monitor_samples (run_id), 1);

    db->delete_run (run_id);
    EXPECT_EQ (db->count_monitor_samples (run_id), 0)
    << "monitor samples outlived the run they belong to";
}

} // namespace
