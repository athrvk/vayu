/**
 * @file tests/run_manager_load_clock_test.cpp
 * @brief A load run's clocks and drain: the live and stored elapsed time, setup overhead, send rate
 * and the natural-end drain, plus the stream section of a load run's report.
 *
 * The live-frame and load-run helpers both files read are in
 * `run_manager_test_helper.hpp`.
 */

#include "optional_assert.hpp"
#include "vayu/core/run_manager.hpp"
#include <gtest/gtest.h>

#include <atomic>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "mock_server.hpp"
#include "temp_database.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/routes.hpp"
#include "wait_until.hpp"

#include "run_manager_test_helper.hpp"

using namespace vayu::core;
using vayu::tests::run_manager::create_load_run;
using vayu::tests::run_manager::expect_rows_on_the_live_clock;
using vayu::tests::run_manager::live_frame_json;
using vayu::tests::run_manager::live_frames;
using vayu::tests::run_manager::stored_rows;
using vayu::tests::run_manager::wait_for_terminal_run;

// #2395: the live clock starts where the report's does, after `script.setup`.
// It used to start when the run was registered, so a 1.5 s setup put every
// live frame 1.5 s ahead of `testDuration` and divided its rates by time no
// request could have been sent in. Mutation check: read the registration
// instant in `emit_live_tick` again and the first-request and last-frame
// assertions fail by about the setup's length.
TEST (LoadClock, LiveElapsedStartsWithLoadNotWithSetup) {
    const std::string db_path = "test_load_clock_setup.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        constexpr int SETUP_MS         = 1500;
        const std::string setup_script = "const until = Date.now () + " +
        std::to_string (SETUP_MS) + "; while (Date.now () < until) {}";
        const nlohmann::json config{ { "method", "GET" }, { "url", server.fast_url () },
            { "mode", "constant_rps" }, { "duration", "1s" },
            { "targetRps", 20.0 }, { "timeout", 5000 }, { "workers", 1 },
            { "lifecycleElements",
            nlohmann::json::array ({ { { "id", "el_setup" }, { "kind", "script.setup" },
            { "enabled", true }, { "config", { { "script", setup_script } } } } }) } };

        const std::string run_id = "run_load_clock";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;
        const auto summary = nlohmann::json::parse (stored->summary);
        const double test_duration = summary.at ("test_duration").get<double> ();

        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        const auto batch = context->ticks_since (0);
        std::vector<nlohmann::json> frames;
        frames.reserve (batch.payloads.size ());
        for (const auto& payload : batch.payloads) {
            frames.push_back (live_frame_json (payload));
        }
        ASSERT_FALSE (frames.empty ());

        // While setup runs, nothing has elapsed and nothing has a rate.
        size_t setup_frames = 0;
        while (setup_frames < frames.size () &&
        frames[setup_frames]["elapsedSeconds"].get<double> () == 0.0 &&
        frames[setup_frames]["requestsSent"].get<size_t> () == 0) {
            const auto& frame = frames[setup_frames];
            EXPECT_EQ (frame["requestsSent"].get<size_t> (), 0u) << frame.dump ();
            EXPECT_DOUBLE_EQ (frame["sendRate"].get<double> (), 0.0) << frame.dump ();
            EXPECT_DOUBLE_EQ (frame["throughput"].get<double> (), 0.0) << frame.dump ();
            ++setup_frames;
        }
        // At the default 100 ms cadence a 1.5 s setup spans about 15 ticks.
        EXPECT_GE (setup_frames, 5u) << "the live clock ran during setup";

        const auto first_sent =
        std::ranges::find_if (frames, [] (const nlohmann::json& f) {
            return f["requestsSent"].get<size_t> () > 0;
        });
        ASSERT_NE (first_sent, frames.end ()) << "no frame saw a request sent";
        EXPECT_LT ((*first_sent)["elapsedSeconds"].get<double> (), 0.8)
        << first_sent->dump ();

        EXPECT_NEAR (frames.back ()["elapsedSeconds"].get<double> (), test_duration, 0.5)
        << "the last live frame and the report disagree about how long load "
           "ran";

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2894: the summary's setup overhead runs from the load run's entry to load
// start, so it holds the whole `script.setup` pass, and the teardown figure is
// stored apart as `cleanup_overhead`. A lower bound only: a slow runner makes
// setup longer, never shorter. Mutation checks: compute the setup figure as
// `cleanup_end - test_end` again in `execute_load_test` and the setup
// assertion reads the few milliseconds of the thread join; stop writing
// `cleanup_overhead` in `build_run_summary_payload` and the key assertion
// fails.
TEST (LoadClock, SetupOverheadCoversTheSetupScript) {
    const std::string db_path = "test_load_clock_setup_overhead.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        constexpr int SETUP_MS         = 300;
        const std::string setup_script = "const until = Date.now () + " +
        std::to_string (SETUP_MS) + "; while (Date.now () < until) {}";
        const nlohmann::json config{ { "method", "GET" }, { "url", server.fast_url () },
            { "mode", "constant_rps" }, { "duration", "1s" },
            { "targetRps", 20.0 }, { "timeout", 5000 }, { "workers", 1 },
            { "lifecycleElements",
            nlohmann::json::array ({ { { "id", "el_setup" }, { "kind", "script.setup" },
            { "enabled", true }, { "config", { { "script", setup_script } } } } }) } };

        const std::string run_id = "run_setup_overhead";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;
        const auto summary = nlohmann::json::parse (stored->summary);

        EXPECT_GE (summary.value ("setup_overhead", -1.0), SETUP_MS / 1000.0)
        << summary.dump ();
        EXPECT_TRUE (summary.contains ("cleanup_overhead")) << summary.dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2881: a stored row's `elapsed_seconds` is the load clock its gate frame
// reads, so History draws a second where the live view drew it. Mutation
// check: measure from the first persisted tick again in `persist_metric_tick`
// and the first row reads 0 and no row equals its frame.
TEST (LoadClock, StoredElapsedIsTheLiveClock) {
    const std::string db_path = "test_load_clock_stored_elapsed.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" }, { "url", server.fast_url () },
            { "mode", "constant_rps" }, { "duration", "3s" },
            { "targetRps", 20.0 }, { "timeout", 5000 }, { "workers", 1 } };
        const std::string run_id = "run_load_clock_stored_elapsed";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto run = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (run);
        ASSERT_EQ (run->status, vayu::RunStatus::Completed) << run->summary;

        const auto rows    = stored_rows (db, run_id);
        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        const auto frames = live_frames (*context);
        ASSERT_GE (rows.size (), 2u)
        << "too few rows to see the series advance";

        expect_rows_on_the_live_clock (rows, frames);
        EXPECT_GT (rows.begin ()->second.at ("elapsed_seconds").get<double> (), 0.0)
        << "the first row restarted the clock at 0";
        double previous = 0.0;
        for (const auto& [timestamp, row] : rows) {
            const double elapsed = row.at ("elapsed_seconds").get<double> ();
            EXPECT_GT (elapsed, previous) << "at " << timestamp;
            previous = elapsed;
        }

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2881: a gate that closes while `script.setup` runs stores no row. Load has
// not started, so its elapsed is 0, and a row there would draw a second of
// setup as a second of load. The setup outlasts the first gate, which the test
// asserts before trusting the rows. Mutation check: drop the load-start guard
// in `persist_metric_tick` and the setup gate stores a row at elapsed 0.
TEST (LoadClock, NoRowIsStoredBeforeLoadStarts) {
    const std::string db_path = "test_load_clock_no_setup_row.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        constexpr int SETUP_MS         = 1500;
        const std::string setup_script = "const until = Date.now () + " +
        std::to_string (SETUP_MS) + "; while (Date.now () < until) {}";
        const nlohmann::json config{ { "method", "GET" }, { "url", server.fast_url () },
            { "mode", "constant_rps" }, { "duration", "2s" },
            { "targetRps", 20.0 }, { "timeout", 5000 }, { "workers", 1 },
            { "lifecycleElements",
            nlohmann::json::array ({ { { "id", "el_setup" }, { "kind", "script.setup" },
            { "enabled", true }, { "config", { { "script", setup_script } } } } }) } };
        const std::string run_id = "run_load_clock_no_setup_row";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto run = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (run);
        ASSERT_EQ (run->status, vayu::RunStatus::Completed) << run->summary;

        const auto rows    = stored_rows (db, run_id);
        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        const auto frames = live_frames (*context);

        const auto setup_gate =
        std::ranges::find_if (frames, [] (const nlohmann::json& f) {
            return f.contains ("secondSamples") &&
            f.at ("elapsedSeconds").get<double> () == 0.0;
        });
        ASSERT_NE (setup_gate, frames.end ())
        << "no gate closed during setup; nothing is proven";
        EXPECT_FALSE (rows.contains (setup_gate->at ("timestamp").get<int64_t> ()))
        << "the gate that closed during setup stored a row";

        ASSERT_FALSE (rows.empty ()) << "no row was stored once load started";
        for (const auto& [timestamp, row] : rows) {
            EXPECT_GT (row.at ("elapsed_seconds").get<double> (), 0.0)
            << "a row stored before load start: " << row.dump ();
        }
        expect_rows_on_the_live_clock (rows, frames);

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2392: the report's send rate and rate fidelity divide by the sending
// window, not by a duration that includes the end-of-run drain. Every /slow
// request answers 500 ms after it is sent, so the drain after a 2 s run is
// about that long. Mutation checks: divide `send_rate` by `total_duration_s`
// again in `collect_summary_inputs` and the send-rate assertion fails; drop
// the `apply_sending_window_rates` call in `reconcile_report_rates` and the
// achievement reads about 80.
TEST (LoadClock, SendRateAndRateFidelityLeaveOutTheDrain) {
    const std::string db_path = "test_load_clock_drain.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        constexpr double DURATION_S = 2.0;
        const nlohmann::json config{ { "method", "GET" }, { "url", server.slow_url () },
            { "mode", "constant_rps" }, { "duration", "2s" },
            { "targetRps", 50.0 }, { "timeout", 5000 }, { "workers", 1 } };
        const std::string run_id = "run_load_drain";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto summary   = nlohmann::json::parse (stored->summary);
        const double sending = summary.at ("sending_duration").get<double> ();
        const double test_duration = summary.at ("test_duration").get<double> ();
        const auto sent     = summary.at ("requests_sent").get<size_t> ();
        const auto expected = summary.at ("requests_expected").get<size_t> ();
        EXPECT_EQ (expected, 100u);
        ASSERT_GT (sent, 0u);
        EXPECT_GE (sending, DURATION_S);
        // A window that swallowed the drain reads DURATION_S + 0.5 or more;
        // a healthy one overruns the deadline by scheduling alone, which has
        // measured 0.16s on a loaded macOS runner. Both bounds sit between the
        // healthy reading and the broken one, and an overrun shortens the
        // drain by as much as it lengthens the window.
        EXPECT_LT (sending, DURATION_S + 0.35)
        << "the window ran past the deadline";
        EXPECT_GT (test_duration - sending, 0.2) << "no drain was measured";
        EXPECT_DOUBLE_EQ (summary.at ("send_rate").get<double> (),
        static_cast<double> (sent) / sending);

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const double achievement =
        report.at ("rateControl").at ("achievement").get<double> ();
        EXPECT_NEAR (achievement,
        static_cast<double> (sent) * 100.0 / static_cast<double> (expected), 0.1);
        // A pacer stall on a loaded runner skips requests (#2911) and lowers
        // the achievement, so the bound counts them as owed: healthy reads
        // about 100, a drain back in the denominator reads about 80.
        const double skipped_pct = summary.value ("skipped_requests", 0.0) *
        100.0 / static_cast<double> (expected);
        EXPECT_GT (achievement + skipped_pct, 95.0)
        << "the drain is back in the denominator";

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2911: a stalled pacer's skips are recorded in the collector and must reach
// the stored tick, the summary, the report and the export, where `dropped` is
// a different count with a different cause. An inline `script.pre` holds the
// pacing thread 250 ms per submission, so at 10 RPS (a 100 ms schedule) the
// third tick wakes at least 400 ms late however fast the runner is; a slower
// runner only skips more. Mutation checks: drop `skippedRequests` from
// `SUMMARY_KEYS` (run_export.cpp) and the export assertion fails; drop the
// `skipped_requests` read in `apply_summary_totals` (runs.cpp) and the report
// one does; drop it from `build_metric_tick_payload` and the tick one does.
TEST (LoadClock, AStalledPacersSkipsReachTheTickSummaryReportAndExport) {
    const std::string db_path = "test_load_clock_stalled_pacer.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" }, { "url", server.fast_url () },
            { "mode", "constant_rps" }, { "duration", "2s" },
            { "targetRps", 10.0 }, { "timeout", 5000 }, { "workers", 1 },
            { "requestElements",
            nlohmann::json::array ({ nlohmann::json{ { "kind", "script.pre" },
            { "config",
            { { "script", "const until = Date.now () + 250; while (Date.now () < until) {}" },
            { "inline", true } } } } }) } };
        const std::string run_id = "run_load_stalled_pacer";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto summary = nlohmann::json::parse (stored->summary);
        const auto skipped = summary.at ("skipped_requests").get<size_t> ();
        ASSERT_GT (skipped, 0u) << "the stall skipped nothing: " << summary.dump ();
        EXPECT_DOUBLE_EQ (summary.at ("stalled_ms").get<double> (),
        static_cast<double> (skipped) * 100.0);
        EXPECT_EQ (summary.at ("requests_sent").get<size_t> () + skipped +
        summary.at ("dropped_requests").get<size_t> (),
        summary.at ("requests_expected").get<size_t> ())
        << summary.dump ();

        // A tick is read mid-run, so it holds at most what the run ended with.
        const auto rows = stored_rows (db, run_id);
        ASSERT_FALSE (rows.empty ()) << "no tick was stored";
        for (const auto& [timestamp, row] : rows) {
            ASSERT_TRUE (row.contains ("skipped_requests")) << row.dump ();
            ASSERT_TRUE (row.contains ("stalled_ms")) << row.dump ();
            EXPECT_LE (row.at ("skipped_requests").get<size_t> (), skipped);
            EXPECT_LE (row.at ("stalled_ms").get<double> (),
            summary.at ("stalled_ms").get<double> ());
        }

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const auto& reported = report.at ("summary");
        EXPECT_EQ (reported.at ("skippedRequests").get<size_t> (), skipped);
        EXPECT_DOUBLE_EQ (reported.at ("stalledMs").get<double> (),
        summary.at ("stalled_ms").get<double> ());
        // The shortfall is shown beside the achievement, not folded into it.
        const auto& rate = report.at ("rateControl");
        EXPECT_NEAR (rate.at ("achievement").get<double> (),
        static_cast<double> (rate.at ("requestsSent").get<size_t> ()) * 100.0 /
        static_cast<double> (rate.at ("requestsExpected").get<size_t> ()),
        0.01);

        const auto [export_status, envelope] = vayu::http::routes::export_run_report_response (
        db, nlohmann::json{ { "runId", run_id } });
        ASSERT_EQ (export_status, 200) << envelope.dump ();
        const auto document =
        nlohmann::json::parse (envelope.at ("text").get<std::string> ());
        const auto& exported = document.at ("report").at ("summary");
        EXPECT_EQ (exported.at ("skippedRequests").get<size_t> (), skipped)
        << exported.dump ();
        EXPECT_DOUBLE_EQ (exported.at ("stalledMs").get<double> (),
        summary.at ("stalled_ms").get<double> ());

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2882: `completed_while_sending` is counted when sending ends, so the drain's
// completions are not in it. One `/hang-every` request in ten never answers
// and times out 1.5 s after it was sent, so about five are still in flight
// when a 2 s run stops sending. Healthy: about 92 of 100 completed while
// sending, 46 a second over the window against a whole-run `throughput` of
// about 28 (100 over 3.5 s). Broken (the count read after the drain): all 100,
// equal to `total_requests`. Mutation check: read `context->total_requests ()`
// after `event_loop->stop` in `execute_load_test` and the first assertion
// fails.
TEST (LoadClock, CompletedWhileSendingLeavesOutTheDrain) {
    const std::string db_path = "test_load_clock_completed_while_sending.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.hang_every_url () }, { "mode", "constant_rps" },
            { "duration", "2s" }, { "targetRps", 50.0 }, { "timeout", 1500 },
            { "workers", 1 } };
        const std::string run_id = "run_load_completed_while_sending";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto summary = nlohmann::json::parse (stored->summary);
        const auto total   = summary.at ("total_requests").get<size_t> ();
        const auto completed_while_sending =
        summary.at ("completed_while_sending").get<size_t> ();
        EXPECT_LT (completed_while_sending, total)
        << "the drain's completions were counted as completed while sending";
        EXPECT_LE (completed_while_sending, summary.at ("requests_sent").get<size_t> ());

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const auto& reported = report.at ("summary");
        ASSERT_TRUE (reported.contains ("completedWhileSending")) << reported.dump ();
        EXPECT_EQ (reported.at ("completedWhileSending").get<size_t> (), completed_while_sending);
        const double while_sending_rate = static_cast<double> (completed_while_sending) /
        reported.at ("sendingDurationSeconds").get<double> ();
        EXPECT_LT (reported.at ("throughput").get<double> (), while_sending_rate)
        << reported.dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2882: an `iterations` run's sending window is its whole duration, so every
// completion is inside it. Four `/slow` requests at concurrency 4 are all in
// flight when the loop returns on its last submission: a count read there
// would be 0 against a total of 4. Mutation check: keep the count read at the
// executor's return for every mode in `sending_window` and this fails.
TEST (LoadClock, AnIterationsRunCompletesEverythingWhileSending) {
    const std::string db_path = "test_load_clock_iterations_completed.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" }, { "url", server.slow_url () },
            { "mode", "iterations" }, { "iterations", 4 }, { "concurrency", 4 },
            { "timeout", 5000 }, { "workers", 1 } };
        const std::string run_id = "run_load_iterations_completed";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto summary = nlohmann::json::parse (stored->summary);
        EXPECT_EQ (summary.at ("total_requests").get<size_t> (), 4u) << summary.dump ();
        EXPECT_EQ (summary.at ("completed_while_sending").get<size_t> (),
        summary.at ("total_requests").get<size_t> ())
        << summary.dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2834: a streaming run's natural end waits for its streams to reach their
// cap. `/sse-ticks` streams for 6 s and the cap ends it as a success at 4 s;
// a drain sized by the 200 ms request timeout gives up at 2.2 s and records
// the stream as a cancelled error. Asserted on the recorded outcome, never
// the clock. Mutation check: size a stream's drain by its timeout again in
// `natural_end_drain_ms` and every assertion below fails.
TEST (LoadDrain, AStreamingRunsNaturalEndWaitsForTheStreamsCap) {
    const std::string db_path = "test_load_drain_stream.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.sse_ticks_url () }, { "mode", "iterations" },
            { "iterations", 1 }, { "concurrency", 1 }, { "timeout", 200 },
            { "workers", 1 }, { "stream", true }, { "maxStreamDurationMs", 4000 } };
        const std::string run_id = "run_load_drain_stream";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const auto& summary = report.at ("summary");
        EXPECT_EQ (summary.at ("successfulRequests").get<size_t> (), 1u)
        << report.dump ();
        EXPECT_EQ (summary.at ("failedRequests").get<size_t> (), 0u) << report.dump ();
        EXPECT_FALSE (report.at ("errors").at ("types").contains ("cancelled"))
        << report.dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #3235: a collection run's streams are its steps', so its natural end waits
// for the longest step's cap rather than for the run's 200 ms timeout. One
// virtual user opens `/sse-ticks` (6 s) at the start of a 1 s run; the step's
// 4 s cap ends it as a success, where a drain sized by the timeout gives up
// at about 3.2 s and records it cancelled. Asserted on the recorded outcome.
// Mutation check: size the drain by `context->stream_bounds` alone again in
// `execute_load_test` and every assertion below fails.
TEST (LoadDrain, ACollectionRunsNaturalEndWaitsForItsStreamingStepsCap) {
    const std::string db_path = "test_load_drain_scenario_stream.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        auto execution            = std::make_shared<ScenarioExecution> ();
        execution->request.source = "collection";
        execution->request.collection_id = "col_drain_stream";
        ScenarioStep step;
        step.request_id            = "req_stream";
        step.name                  = "events";
        step.request.method        = vayu::HttpMethod::GET;
        step.request.url           = server.sse_ticks_url ();
        step.request.timeout_ms    = 200;
        step.request.stream_bounds = vayu::StreamBounds{ 4000, 100000 };
        step.stored_url            = step.request.url;
        execution->plan.steps.push_back (std::move (step));

        const nlohmann::json config{ { "mode", "constant_concurrency" },
            { "concurrency", 1 }, { "duration", "1s" }, { "timeout", 200 },
            { "scenario",
            { { "source", "collection" }, { "collectionId", "col_drain_stream" } } } };
        const std::string run_id = "run_load_drain_scenario_stream";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db, execution));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const auto& summary = report.at ("summary");
        EXPECT_EQ (summary.at ("successfulRequests").get<size_t> (), 1u)
        << report.dump ();
        EXPECT_EQ (summary.at ("failedRequests").get<size_t> (), 0u) << report.dump ();
        EXPECT_FALSE (report.at ("errors").at ("types").contains ("cancelled"))
        << report.dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #3235: a streaming step does not shorten the wait for a collection run's
// ordinary steps. One virtual user streams for its step's 500 ms cap, then
// sends a request that answers 10 s later, inside its 20 s timeout and in
// flight at the end of the 1 s run. Healthy: the drain waits the timeout plus
// the grace (22 s) and the request succeeds. Broken: a drain sized by the
// stream alone gives up 7.5 s after the end and records it cancelled.
// Asserted on the recorded outcome. Mutation check: size a collection run's
// drain by `natural_end_drain_ms (longest_stream_bounds (...))` alone again in
// `execute_load_test` and every assertion below fails.
TEST (LoadDrain, AStreamingStepDoesNotCutACollectionRunsOrdinaryStepShort) {
    constexpr int64_t STREAM_CAP_MS = 500;
    constexpr int TIMEOUT_MS        = 20000;
    static_assert (vayu::tests::SlowMockServer::OUTLAST_STREAM_DRAIN_MS > STREAM_CAP_MS +
    constants::sse::LOAD_STREAM_TIMEOUT_GRACE_MS + constants::event_loop::STOP_DRAIN_GRACE_MS);
    static_assert (vayu::tests::SlowMockServer::OUTLAST_STREAM_DRAIN_MS < TIMEOUT_MS);

    const std::string db_path = "test_load_drain_scenario_mixed.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        auto execution            = std::make_shared<ScenarioExecution> ();
        execution->request.source = "collection";
        execution->request.collection_id = "col_drain_mixed";
        ScenarioStep stream_step;
        stream_step.request_id         = "req_stream";
        stream_step.name               = "events";
        stream_step.request.method     = vayu::HttpMethod::GET;
        stream_step.request.url        = server.sse_ticks_url ();
        stream_step.request.timeout_ms = TIMEOUT_MS;
        stream_step.request.stream_bounds = vayu::StreamBounds{ STREAM_CAP_MS, 100000 };
        stream_step.stored_url = stream_step.request.url;
        execution->plan.steps.push_back (std::move (stream_step));
        ScenarioStep ordinary_step;
        ordinary_step.request_id         = "req_ordinary";
        ordinary_step.name               = "slow";
        ordinary_step.request.method     = vayu::HttpMethod::GET;
        ordinary_step.request.url        = server.outlast_stream_drain_url ();
        ordinary_step.request.timeout_ms = TIMEOUT_MS;
        ordinary_step.stored_url         = ordinary_step.request.url;
        execution->plan.steps.push_back (std::move (ordinary_step));

        const nlohmann::json config{ { "mode", "constant_concurrency" },
            { "concurrency", 1 }, { "duration", "1s" }, { "timeout", TIMEOUT_MS },
            { "scenario",
            { { "source", "collection" }, { "collectionId", "col_drain_mixed" } } } };
        const std::string run_id = "run_load_drain_scenario_mixed";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db, execution));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const auto& summary = report.at ("summary");
        EXPECT_EQ (summary.at ("successfulRequests").get<size_t> (), 2u)
        << report.dump ();
        EXPECT_EQ (summary.at ("failedRequests").get<size_t> (), 0u) << report.dump ();
        EXPECT_FALSE (report.at ("errors").at ("types").contains ("cancelled"))
        << report.dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #3771: a streaming run against a rate-limited target reports as streams
// only the replies that announced `text/event-stream`. Eight iterations meet
// `/sse-or-429` as two two-event streams and six 429s: `completions` is 2 and
// every percentile 2, not 8 completions with a p50 of 0. Mutation check: drop
// the content-type test from `StreamTally::report` and `completions` reads 8
// with `events.min` 0.
TEST (LoadStream, OnlyTheRepliesThatAnnouncedAStreamAreTheReportsStreams) {
    constexpr int ITERATIONS = 8;
    constexpr int STREAMS = ITERATIONS / vayu::tests::SlowMockServer::SSE_OR_429_EVERY;
    const std::string db_path = "test_load_stream_rate_limited.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.sse_or_429_url () }, { "mode", "iterations" },
            { "iterations", ITERATIONS }, { "concurrency", 1 }, { "timeout", 5000 },
            { "workers", 1 }, { "stream", true }, { "maxStreamDurationMs", 10000 } };
        const std::string run_id = "run_load_stream_rate_limited";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const nlohmann::json expected_codes =
        nlohmann::json::array ({ { 200, STREAMS }, { 429, ITERATIONS - STREAMS } });
        EXPECT_EQ (report.at ("statusCodes"), expected_codes) << report.dump ();
        const auto& stream = report.at ("stream");
        EXPECT_EQ (stream.at ("completions").get<int> (), STREAMS) << stream.dump ();
        EXPECT_EQ (stream.at ("totalEvents").get<int> (), STREAMS * 2) << stream.dump ();
        EXPECT_EQ (stream.at ("events").at ("min").get<int> (), 2) << stream.dump ();
        EXPECT_EQ (stream.at ("events").at ("p50").get<int> (), 2) << stream.dump ();
        EXPECT_EQ (stream.at ("timeToFirstEvent").at ("count").get<int> (), STREAMS)
        << stream.dump ();
        // Each stream's two events came in one write, so none has a gap or a
        // rate to report (#3776), and neither block is written as zeros.
        EXPECT_FALSE (stream.contains ("maxEventGap")) << stream.dump ();
        EXPECT_FALSE (stream.contains ("eventRate")) << stream.dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #3776: a single-request load run's streams report their pace. Each meets
// `/sse-ticks` (one event a write, SSE_TICK_MS apart) and the event cap ends
// it at its third, so every completion has gaps and a rate. Asserted as wired,
// not timed: `APauseBetweenEventsIsTheStreamsLargestGap` holds the timing.
// Mutation check: drop `event_rate` from `stream_completion_of`
// (metrics_collector.cpp), the reading `handle_result` records, and the
// `eventRate` block is absent.
TEST (LoadStream, ASingleRequestRunsStreamsReportTheirLargestGapAndRate) {
    constexpr int ITERATIONS  = 2;
    const std::string db_path = "test_load_stream_pace.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.sse_ticks_url () }, { "mode", "iterations" },
            { "iterations", ITERATIONS }, { "concurrency", 1 },
            { "timeout", 5000 }, { "workers", 1 }, { "stream", true },
            { "maxStreamEvents", 3 }, { "maxStreamDurationMs", 10000 } };
        const std::string run_id = "run_load_stream_pace";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const auto& stream = report.at ("stream");
        EXPECT_EQ (stream.at ("completions").get<int> (), ITERATIONS) << stream.dump ();
        for (const auto* block : { "maxEventGap", "eventRate" }) {
            ASSERT_TRUE (stream.contains (block)) << block << ": " << stream.dump ();
            EXPECT_EQ (stream.at (block).at ("count").get<int> (), ITERATIONS) << block;
            EXPECT_GT (stream.at (block).at ("max").get<double> (), 0.0) << block;
        }

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #3771: a target that answers a streaming run with 200 JSON never streamed,
// so the report has no `stream` section at all. Mutation check: drop the
// content-type test from `StreamTally::report` and the section appears with
// every completion at 0 events.
TEST (LoadStream, AStreamingRunAnsweredWithJsonHasNoStreamSection) {
    const std::string db_path = "test_load_stream_json.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.fast_url () }, { "mode", "iterations" },
            { "iterations", 4 }, { "concurrency", 1 }, { "timeout", 5000 },
            { "workers", 1 }, { "stream", true }, { "maxStreamDurationMs", 10000 } };
        const std::string run_id = "run_load_stream_json";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        EXPECT_EQ (report.at ("summary").at ("successfulRequests").get<int> (), 4)
        << report.dump ();
        EXPECT_FALSE (report.contains ("stream")) << report.dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #3236: a streaming run's live frames count its events while its one stream
// is still open, and settle on the report's total once it closes. `/sse-held`
// sends three events and the start of a fourth, then holds until released, so
// the mid-stream tick is taken while nothing has completed; the fourth event
// is the unterminated frame only the close completes. Mutation checks: count
// only at completion (publish nothing from `StreamTally::feed` and the whole
// count from `StreamTally::report`) and the mid-stream wait runs out; drop the
// delta `report` publishes and the settled frame reads 3, not 4.
TEST (LoadStream, ATickWhileTheStreamIsOpenCarriesItsEvents) {
    const std::string db_path = "test_load_stream_live.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.sse_held_url () }, { "mode", "iterations" },
            { "iterations", 1 }, { "concurrency", 1 }, { "timeout", 5000 },
            { "workers", 1 }, { "stream", true }, { "maxStreamDurationMs", 20000 } };
        const std::string run_id = "run_load_stream_live";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto context = manager.get_run (run_id);
        ASSERT_NE (context, nullptr);

        nlohmann::json open_frame;
        EXPECT_TRUE (vayu::tests::wait_until ([&] () {
            const auto frames = live_frames (*context);
            if (frames.empty () || frames.back ().value ("streamEvents", size_t{ 0 }) == 0) {
                return false;
            }
            open_frame = frames.back ();
            return true;
        }))
        << "no tick counted an event while the stream was open";
        server.released.store (true, std::memory_order_relaxed);

        if (!open_frame.is_null ()) {
            EXPECT_EQ (open_frame.at ("streamsOpen").get<size_t> (), 1u)
            << open_frame.dump ();
            EXPECT_EQ (open_frame.at ("totalRequests").get<size_t> (), 0u)
            << "the stream had not completed, so its events were counted live: "
            << open_frame.dump ();
            EXPECT_TRUE (open_frame.contains ("eventsPerSecond")) << open_frame.dump ();
        }

        const auto stored = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (stored);
        ASSERT_EQ (stored->status, vayu::RunStatus::Completed) << stored->summary;
        ASSERT_TRUE (
        vayu::tests::wait_until ([&] () { return context->closed.load (); }))
        << "the metrics thread never emitted its settled frame";

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const auto total_events = report.at ("stream").at ("totalEvents").get<size_t> ();
        EXPECT_EQ (total_events, 4u) << report.dump ();
        const auto frames = live_frames (*context);
        ASSERT_FALSE (frames.empty ());
        EXPECT_EQ (frames.back ().at ("streamEvents").get<size_t> (), total_events)
        << "the settled live total is the report's: " << frames.back ().dump ();
        EXPECT_EQ (frames.back ().at ("streamsOpen").get<size_t> (), 0u);

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}
