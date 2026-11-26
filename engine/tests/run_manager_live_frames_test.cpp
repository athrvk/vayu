/**
 * @file tests/run_manager_live_frames_test.cpp
 * @brief A load run's live frames and stored rows: whole-second percentiles, the gate frames and the
 * streaming and collection-run frame keys.
 *
 * The live-frame and load-run helpers both files read are in
 * `run_manager_test_helper.hpp`.
 */

#include "optional_assert.hpp"
#include "vayu/core/run_manager.hpp"
#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "load_start_stamp.hpp"
#include "mock_server.hpp"
#include "temp_database.hpp"
#include "vayu/core/status_seconds.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/platform/platform.hpp"
#include "wait_until.hpp"

#include "run_manager_test_helper.hpp"

using namespace vayu::core;
using vayu::tests::run_manager::create_load_run;
using vayu::tests::run_manager::live_frame_json;
using vayu::tests::run_manager::live_frames;
using vayu::tests::run_manager::match_gate_frames_to_rows;
using vayu::tests::run_manager::stored_rows;
using vayu::tests::run_manager::wait_for_terminal_run;

// #2385: a stored row is its whole second, not the last 100 ms window of it,
// and the gate frame of the same tick carries the same figures as `second*`.
// At 20 rps a second holds about 20 completions, so its p99 is its slowest and
// the one stalled request shows up in exactly the row of its second.
// Mutation checks: persist the last window again in `persist_metric_tick` and
// the row/frame equality fails (and, nine times in ten, the stall row); drop
// the `add_window` into the second's histogram and the sample sum fails.
TEST (LoadClock, StoredRowsCarryTheWholeSecondsPercentiles) {
    const std::string db_path = "test_load_clock_seconds.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.stall_once_url () }, { "mode", "constant_rps" },
            { "duration", "3s" }, { "targetRps", 20.0 }, { "timeout", 5000 },
            { "workers", 1 } };
        const std::string run_id = "run_load_seconds";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto run = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (run);
        ASSERT_EQ (run->status, vayu::RunStatus::Completed) << run->summary;

        const auto rows        = stored_rows (db, run_id);
        double slowest_row_p99 = 0.0;
        for (const auto& [timestamp, payload] : rows) {
            if (payload.contains ("latency_p99_ms")) {
                slowest_row_p99 = std::max (
                slowest_row_p99, payload.at ("latency_p99_ms").get<double> ());
            }
        }
        ASSERT_GE (rows.size (), 2u);
        EXPECT_GE (slowest_row_p99, static_cast<double> (vayu::tests::SlowMockServer::STALL_MS))
        << "no stored second holds the stall";

        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        const auto frames = live_frames (*context);
        ASSERT_FALSE (frames.empty ());
        for (const auto& frame : frames) {
            for (const auto* key :
            { "cumulativeP50Ms", "cumulativeP95Ms", "cumulativeP99Ms" }) {
                ASSERT_TRUE (frame.contains (key))
                << key << " missing: " << frame.dump ();
                EXPECT_TRUE (frame.at (key).is_null () || frame.at (key).is_number ())
                << frame.dump ();
            }
        }

        const auto seen = match_gate_frames_to_rows (frames, rows);
        EXPECT_EQ (seen.gate_frames, rows.size ());
        EXPECT_FALSE (seen.settled.empty ());
        EXPECT_TRUE (frames.back ().contains ("secondSamples"))
        << "the final frame did not close the partial second";
        const auto completed = frames.back ().at ("totalRequests").get<size_t> ();
        EXPECT_GT (completed, static_cast<size_t> (vayu::tests::SlowMockServer::STALL_AT));
        EXPECT_EQ (seen.samples, completed)
        << "a completion landed in no second, or in two";

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2386: a second in which nothing completed has no latency. While the target
// answers nothing, the gate frames say null and the stored rows carry no
// percentile key; the seconds around the stall store real figures. The stall
// opens about 0.5 s in and lasts STALL_WINDOW_MS (3 s); a gate closes a second
// every 1.0-1.1 s, so at least one whole stored second lies inside it even at
// 1.5 s a gate. The run is 9 s so a stored row still follows the stall when
// the first request is up to 4 s late: the stall closes at (10th request) +
// 3 s, and the last stored row sits near 8 s. Mutation checks: write the percentile keys unconditionally in
// `build_metric_tick_payload` and the empty-second assertions fail; restore
// the zeros in `put_interval_percentiles` and the frames' nulls fail.
TEST (LoadClock, AStalledSecondStoresNoPercentiles) {
    const std::string db_path = "test_load_clock_stall.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" },
            { "url", server.stall_window_url () }, { "mode", "constant_rps" },
            { "duration", "9s" }, { "targetRps", 20.0 }, { "timeout", 10000 },
            { "workers", 1 } };
        const std::string run_id = "run_load_stall";
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
        ASSERT_FALSE (frames.empty ());

        // Every frame's window follows the same rule as its second.
        size_t idle_windows = 0;
        for (const auto& frame : frames) {
            const auto samples = frame.at ("latencySamples").get<size_t> ();
            EXPECT_EQ (frame.at ("latencyP99Ms").is_null (), samples == 0)
            << frame.dump ();
            idle_windows += samples == 0 ? 1 : 0;
        }
        EXPECT_GT (idle_windows, 0u);

        const auto seen = match_gate_frames_to_rows (frames, rows);
        EXPECT_EQ (seen.gate_frames, rows.size ());
        ASSERT_FALSE (seen.empty.empty ())
        << "no stored second fell inside the stall";
        ASSERT_FALSE (seen.settled.empty ());
        EXPECT_GT (seen.settled.back (), seen.empty.front ())
        << "no second after the stall stored its latency";

        // The requests the stall held settle in a later second, and that
        // second's row carries their wait.
        double slowest_row_p99 = 0.0;
        for (const auto timestamp : seen.settled) {
            slowest_row_p99 = std::max (slowest_row_p99,
            rows.at (timestamp).at ("latency_p99_ms").get<double> ());
        }
        EXPECT_GE (slowest_row_p99, vayu::tests::SlowMockServer::STALL_WINDOW_MS / 2.0);

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2782: only a gate frame carries the run-so-far distributions, and the final
// one, read after the drain, is what the report says. A 100 ms frame carries
// neither key; every gate frame carries `cumulativeLatency` and, with the
// phase bank on by default, `cumulativePhases`; the last frame's latency
// distribution is the report's `latency` and its phase means are the
// report's `avg*Ms`.
// Mutation checks: drop `cumulativePhases` from `put_gate_distributions` and
// the gate assertions fail; drop `maxMs` from a phase entry and the percentile
// comparison throws on the missing key; have the report ignore the stored
// phase means and the average comparison fails (the trace sample is a
// different population);
// feed the interval recorder a value 1 ms off the one record_latency_sample
// gives the report's histogram and every latency comparison fails.
TEST (LoadClock, GateFramesCarryTheRunSoFarDistributionsTheReportEndsOn) {
    const std::string db_path = "test_load_clock_gate_distributions.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        const nlohmann::json config{ { "method", "GET" }, { "url", server.fast_url () },
            { "mode", "constant_rps" }, { "duration", "2s" },
            { "targetRps", 20.0 }, { "timeout", 5000 }, { "workers", 1 } };
        const std::string run_id = "run_load_gate_distributions";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db));
        const auto run = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (run);
        ASSERT_EQ (run->status, vayu::RunStatus::Completed) << run->summary;

        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        const auto frames = live_frames (*context);
        ASSERT_FALSE (frames.empty ());

        size_t gate_frames = 0;
        for (const auto& frame : frames) {
            // A single-request run has no sequence to report, gate or not.
            EXPECT_FALSE (frame.contains ("scenario")) << frame.dump ();
            if (!frame.contains ("secondSamples")) {
                EXPECT_FALSE (frame.contains ("cumulativeLatency")) << frame.dump ();
                EXPECT_FALSE (frame.contains ("cumulativePhases")) << frame.dump ();
                continue;
            }
            ++gate_frames;
            ASSERT_TRUE (frame.contains ("cumulativeLatency")) << frame.dump ();
            ASSERT_TRUE (frame.contains ("cumulativePhases")) << frame.dump ();
            EXPECT_TRUE (frame.at ("cumulativeLatency").is_null () ||
            frame.at ("cumulativeLatency").is_object ())
            << frame.dump ();
        }
        EXPECT_GE (gate_frames, 2u) << "no gate frame before the final one";

        const auto& last     = frames.back ();
        const auto completed = last.at ("totalRequests").get<size_t> ();
        ASSERT_GT (completed, 0u);
        ASSERT_TRUE (last.at ("cumulativeLatency").is_object ()) << last.dump ();
        EXPECT_EQ (last.at ("cumulativeLatency").at ("count").get<size_t> (), completed);
        const auto& phases = last.at ("cumulativePhases");
        ASSERT_TRUE (phases.is_object ()) << last.dump ();

        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        const auto& breakdown       = report.at ("timingBreakdown");
        constexpr auto AVERAGE_KEYS = std::to_array<std::string_view> (
        { "avgDnsMs", "avgConnectMs", "avgTlsMs", "avgFirstByteMs", "avgDownloadMs" });
        for (size_t i = 0; i < vayu::core::TIMING_PHASE_COUNT; ++i) {
            const auto* phase = vayu::core::TIMING_PHASE_KEYS.at (i);
            const std::string average (AVERAGE_KEYS.at (i));
            EXPECT_EQ (phases.at (phase).at ("count").get<size_t> (), completed) << phase;
            // Both are hdr_mean over the bank after the drain, so they agree
            // to the double; the tolerance only absorbs the JSON round trip.
            EXPECT_NEAR (phases.at (phase).at ("meanMs").get<double> (),
            breakdown.at (average).get<double> (), 1e-9)
            << phase << " against " << average;

            // The live table's percentiles and max are the report's, read
            // from the same bank after the same drain.
            const auto& stored = breakdown.at ("phases").at (phase);
            for (const auto& [live_key, report_key] :
            std::to_array<std::pair<std::string_view, std::string_view>> ({ { "p50Ms", "p50" },
            { "p95Ms", "p95" }, { "p99Ms", "p99" }, { "maxMs", "max" } })) {
                EXPECT_NEAR (phases.at (phase).at (live_key).get<double> (),
                stored.at (report_key).get<double> (), 1e-9)
                << phase << " " << live_key << " against " << report_key;
            }
        }

        // The live view's last HDR points are History's. One
        // record_latency_sample feeds the report's histogram and the window
        // the run-so-far one is merged from, with one value, and the final
        // frame merges the last window after the drain, so the two hold the
        // same buckets and read the same to the double.
        const auto& live_latency   = last.at ("cumulativeLatency");
        const auto& report_latency = report.at ("latency");
        EXPECT_EQ (live_latency.at ("count").get<size_t> (),
        report.at ("summary").at ("totalRequests").get<size_t> ());
        constexpr auto LATENCY_KEYS =
        std::to_array<std::pair<std::string_view, std::string_view>> (
        { { "minMs", "min" }, { "p50Ms", "p50" }, { "p75Ms", "p75" },
        { "p90Ms", "p90" }, { "p95Ms", "p95" }, { "p99Ms", "p99" },
        { "p999Ms", "p999" }, { "maxMs", "max" } });
        for (const auto& [live_key, report_key] : LATENCY_KEYS) {
            EXPECT_NEAR (live_latency.at (live_key).get<double> (),
            report_latency.at (report_key).get<double> (), 1e-9)
            << live_key << " against latency." << report_key;
        }

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2823: a scenario load run's gate frames carry its sequence so far, and the
// final frame, built after the drain, counts what the stored summary does. A
// 100 ms frame carries no `scenario`; a single-request run's frames never do
// (the test above). Two users over `/slow` then `/error` for 2 s: load outlasts
// one gate cadence, so a gate lands while the state is published, and every
// `/error` answer is a step error. Mutation checks: drop the `scenario` block
// from `emit_live_tick`'s gate branch and the gate and final-frame assertions
// fail; move it out of the gate branch and the 100 ms assertion fails; stop
// `release_execution_resources` dropping the published state and the
// retention assertion fails.
TEST (LoadClock, GateFramesCarryTheScenarioSequenceTheSummaryEndsOn) {
    const std::string db_path = "test_load_clock_scenario_sequence.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        const vayu::tests::SlowMockServer server;

        auto execution            = std::make_shared<ScenarioExecution> ();
        execution->request.source = "collection";
        execution->request.collection_id = "col_live_sequence";
        const auto urls = std::to_array ({ server.slow_url (), server.error_url () });
        for (size_t i = 0; i < urls.size (); ++i) {
            ScenarioStep step;
            step.index              = i;
            step.request_id         = "req_" + std::to_string (i);
            step.name               = "step" + std::to_string (i);
            step.request.method     = vayu::HttpMethod::GET;
            step.request.url        = urls.at (i);
            step.request.timeout_ms = 5000;
            step.stored_url         = urls.at (i);
            execution->plan.steps.push_back (std::move (step));
        }
        const nlohmann::json config{ { "mode", "constant_concurrency" },
            { "concurrency", 2 }, { "duration", "2s" }, { "timeout", 5000 },
            { "scenario",
            { { "source", "collection" }, { "collectionId", "col_live_sequence" } } } };
        const std::string run_id = "run_load_scenario_sequence";
        create_load_run (db, run_id, config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, config, db, execution));
        const auto run = wait_for_terminal_run (db, run_id);
        ASSERT_HAS_VALUE (run);
        ASSERT_EQ (run->status, vayu::RunStatus::Completed) << run->summary;
        ASSERT_TRUE (vayu::tests::wait_until (
        [&] () { return manager.get_run (run_id) == nullptr; }))
        << "the run was never retained";

        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);
        EXPECT_EQ (context->published_scenario_state (), nullptr)
        << "retention keeps the scenario state alive";
        const auto frames = live_frames (*context);
        ASSERT_FALSE (frames.empty ());

        size_t sequence_frames = 0;
        for (const auto& frame : frames) {
            if (!frame.contains ("secondSamples")) {
                EXPECT_FALSE (frame.contains ("scenario")) << frame.dump ();
                continue;
            }
            sequence_frames += frame.contains ("scenario") ? 1u : 0u;
        }
        EXPECT_GE (sequence_frames, 2u) << "no gate frame before the final one";

        const auto& last = frames.back ();
        ASSERT_TRUE (last.contains ("scenario")) << last.dump ();
        const auto& live = last.at ("scenario");
        const auto summary = nlohmann::json::parse (run->summary).at ("scenario");
        EXPECT_EQ (live.at ("iterations"), summary.at ("iterations"));
        EXPECT_EQ (live.at ("iterationsCompleted"), summary.at ("iterations_completed"));
        EXPECT_EQ (live.at ("iterationsAbandoned"), summary.at ("iterations_abandoned"));
        EXPECT_EQ (live.at ("stepsExecuted"), summary.at ("steps_executed"));
        EXPECT_GT (live.at ("stepsExecuted").get<size_t> (), 0u) << live.dump ();
        // #3570: the mean pass, from the same sum and count the summary reads.
        ASSERT_TRUE (live.contains ("meanIterationMs")) << live.dump ();
        EXPECT_DOUBLE_EQ (live.at ("meanIterationMs").get<double> (),
        summary.at ("pass_duration").at ("mean").get<double> ());

        const auto& live_steps   = live.at ("steps");
        const auto& stored_steps = summary.at ("steps");
        ASSERT_EQ (live_steps.size (), urls.size ()) << live.dump ();
        ASSERT_EQ (stored_steps.size (), urls.size ()) << summary.dump ();
        for (size_t i = 0; i < urls.size (); ++i) {
            for (const char* key : { "index", "name", "executed", "errors" }) {
                EXPECT_EQ (live_steps.at (i).at (key), stored_steps.at (i).at (key))
                << "step " << i << " " << key;
            }
        }
        EXPECT_GT (live_steps.at (1).at ("errors").get<size_t> (), 0u) << live.dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #2393: every frame carries the trailing window, and a gate frame and its
// stored row carry one reading of it. A hundred 50 ms completions land before
// tick 0, so they are in the run's mean and in no window; the 5 ms ones fed
// until a row lands are the only ones a window holds. Mutation checks: put
// the >= 100 ms delta back on the frame's `currentRps`, or store
// `current_total / run_elapsed_s` as the row's `current_rps`, and the
// frame/row equality fails; read the run's mean into the window's and the
// 5 ms assertions fail. #2821's mean in flight rides the same reading, off
// three requests held open for the whole test (#3567), so every window reads
// exactly 3: store the run-long `average_in_flight` as the row's
// `window_avg_in_flight` and its frame/row equality fails; leave
// `inflight_integral_ms` out of `cumulative_counters` and it reads 0.
TEST (CollectMetrics, TheGateFrameAndItsStoredRowShareOneTrailingWindow) {
    const std::string db_path = "test_collect_metrics_trailing_window.db";
    vayu::tests::remove_database_files (db_path);

    vayu::db::Database db (db_path);
    db.init ();

    vayu::db::Run run;
    run.id              = "trailing_window_run";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = 1;
    run.config_snapshot = "{}";
    db.create_run (run);

    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> (run.id, cfg);
    auto& mc = *ctx->metrics_collector;
    for (int i = 0; i < 100; ++i) {
        mc.record_success (200, 50.0, 4.0);
    }
    constexpr int OPEN = 3;
    for (int i = 0; i < OPEN; ++i) {
        (void)mc.open_request ();
    }
    ctx->requests_sent = 100 + OPEN;
    ctx->is_running    = true;
    vayu::tests::stamp_load_start (*ctx);

    std::thread metrics ([&] () { collect_metrics (ctx, &db); });
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] () { return ctx->published_count.load () > 0; }))
    << "the metrics thread never published tick 0";
    // Paced feeding, so every window up to the first row holds completions.
    EXPECT_TRUE (vayu::tests::wait_until ([&] () {
        mc.record_success (200, 5.0, 0.5);
        ++ctx->requests_sent;
        return !db.get_metric_ticks_since (run.id, 0).empty ();
    }))
    << "no tick was persisted";
    ctx->is_running = false;
    metrics.join ();

    const auto ticks = db.get_metric_ticks_since (run.id, 0);
    ASSERT_FALSE (ticks.empty ()) << "no tick was persisted; nothing is proven";
    const auto stored = nlohmann::json::parse (ticks.front ().payload);
    EXPECT_GT (stored.at ("current_rps").get<double> (), 0.0) << stored.dump ();
    EXPECT_GT (stored.at ("current_send_rate").get<double> (), 0.0) << stored.dump ();
    EXPECT_DOUBLE_EQ (stored.at ("window_avg_latency_ms").get<double> (), 5.0);
    EXPECT_DOUBLE_EQ (stored.at ("window_avg_queue_wait_ms").get<double> (), 0.5);
    EXPECT_DOUBLE_EQ (stored.at ("window_avg_in_flight").get<double> (), OPEN)
    << stored.dump ();

    const auto batch = ctx->ticks_since (0);
    ASSERT_FALSE (batch.payloads.empty ());
    size_t gate_frames = 0;
    for (const auto& payload : batch.payloads) {
        const auto frame = live_frame_json (payload);
        for (const auto* key : { "currentRps", "currentSendRate", "windowAvgInFlight" }) {
            ASSERT_TRUE (frame.contains (key) && frame.at (key).is_number ())
            << key << ": " << frame.dump ();
        }
        for (const auto* key : { "windowAvgLatencyMs", "windowAvgQueueWaitMs" }) {
            ASSERT_TRUE (frame.contains (key)) << key << ": " << frame.dump ();
            EXPECT_TRUE (frame.at (key).is_null () || frame.at (key).is_number ())
            << frame.dump ();
        }
        if (frame.at ("timestamp") != stored.at ("timestamp")) {
            continue;
        }
        ++gate_frames;
        EXPECT_DOUBLE_EQ (frame.at ("currentRps").get<double> (),
        stored.at ("current_rps").get<double> ());
        EXPECT_DOUBLE_EQ (frame.at ("currentSendRate").get<double> (),
        stored.at ("current_send_rate").get<double> ());
        EXPECT_EQ (frame.at ("windowAvgLatencyMs"), stored.at ("window_avg_latency_ms"));
        EXPECT_EQ (frame.at ("windowAvgQueueWaitMs"), stored.at ("window_avg_queue_wait_ms"));
        EXPECT_DOUBLE_EQ (frame.at ("windowAvgInFlight").get<double> (),
        stored.at ("window_avg_in_flight").get<double> ());
        EXPECT_GT (frame.at ("avgLatencyMs").get<double> (), 5.0)
        << "the run's mean lost the completions before tick 0";
    }
    EXPECT_EQ (gate_frames, 1u)
    << "no live frame carried the stored row's timestamp";

    vayu::tests::remove_database_files (db_path);
}

namespace {

/// Every live frame of a bare run started from @p cfg, ticked by
/// `collect_metrics` until @p settled holds of the frames so far, plus the
/// final settled one. @p settled is polled, so it may also feed the run.
template <typename Settled>
std::vector<nlohmann::json>
frames_until (const std::string& run_id, const nlohmann::json& cfg, Settled settled) {
    const std::string db_path = "test_collect_metrics_" + run_id + ".db";
    vayu::tests::remove_database_files (db_path);
    std::vector<nlohmann::json> frames;
    {
        vayu::db::Database db (db_path);
        db.init ();
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Load;
        run.status          = vayu::RunStatus::Running;
        run.start_time      = 1;
        run.config_snapshot = cfg.dump ();
        db.create_run (run);

        auto ctx        = std::make_shared<RunContext> (run.id, cfg);
        ctx->is_running = true;
        vayu::tests::stamp_load_start (*ctx);
        std::thread metrics ([&] () { collect_metrics (ctx, &db); });
        EXPECT_TRUE (vayu::tests::wait_until ([&] () { return settled (*ctx); }))
        << "the frames never settled for " << run_id;
        ctx->is_running = false;
        metrics.join ();
        frames = live_frames (*ctx);
    }
    vayu::tests::remove_database_files (db_path);
    return frames;
}

/// The live stream keys @p frame carries, by name, for a readable failure.
std::string stream_keys_in (const nlohmann::json& frame) {
    std::string present;
    for (const auto* key :
    { "streamEvents", "streamsOpen", "eventsPerSecond", "streamTimeToFirstEvent" }) {
        if (frame.contains (key)) {
            present += std::string (present.empty () ? "" : ", ") + key;
        }
    }
    return present;
}

} // namespace

// #3236: a streaming run's frames carry the tally its transfers count into, as
// `streamEvents`, and that tally's trailing-window rate, as `eventsPerSecond`.
// The tally is fed by hand here as the write callback would, through the
// bounds every request of the run is given. Mutation checks: drop the
// `live` assignment from the RunContext constructor and the wiring
// assertion fails; leave `stream_events` out of `put_trailing_window`'s
// counters and the wait for a positive rate runs out.
TEST (CollectMetrics, AStreamingRunsFramesCarryItsEventsAndTheirRate) {
    const nlohmann::json cfg{ { "stream", true } };
    std::shared_ptr<vayu::LiveStreamCounts> live;
    const auto frames = frames_until ("stream_rate", cfg, [&] (RunContext& ctx) {
        if (!live) {
            EXPECT_TRUE (ctx.stream_bounds.has_value ());
            live = ctx.stream_bounds ? ctx.stream_bounds->live : nullptr;
            EXPECT_NE (live, nullptr) << "the run's requests carry no tally";
            EXPECT_EQ (live, ctx.metrics_collector->live_stream_counts ());
            if (!live) {
                return true;
            }
        }
        live->events.fetch_add (5);
        const auto seen = live_frames (ctx);
        return std::ranges::any_of (seen, [] (const nlohmann::json& frame) {
            return frame.value ("eventsPerSecond", 0.0) > 0.0;
        });
    });
    ASSERT_NE (live, nullptr);
    ASSERT_FALSE (frames.empty ());

    for (const auto& frame : frames) {
        for (const auto* key : { "streamEvents", "streamsOpen", "eventsPerSecond" }) {
            EXPECT_TRUE (frame.contains (key)) << key << ": " << frame.dump ();
        }
    }
    EXPECT_EQ (frames.back ().at ("streamEvents").get<size_t> (), live->events.load ())
    << "the settled frame reads the whole tally";
}

// Absent, not zero: a run that does not stream (with `stream_metrics` at its
// default, on) and a stream with `stream_metrics: false` carry none of the
// stream keys on any frame, the final gate frame included. Mutation check:
// allocate the tally whenever `stream_metrics` is on and the first run fails.
TEST (CollectMetrics, OnlyAStreamingRunWithStreamMetricsCarriesTheStreamKeys) {
    const auto two_ticks = [] (RunContext& ctx) {
        return ctx.published_count.load () >= 2;
    };
    const nlohmann::json plain = nlohmann::json::object ();
    const nlohmann::json metrics_off{ { "stream", true }, { "stream_metrics", false } };
    for (const auto& [name, cfg] :
    { std::pair{ "plain", plain }, std::pair{ "stream_metrics_off", metrics_off } }) {
        const auto frames = frames_until (name, cfg, two_ticks);
        ASSERT_FALSE (frames.empty ()) << name;
        for (const auto& frame : frames) {
            EXPECT_EQ (stream_keys_in (frame), "") << name << ": " << frame.dump ();
        }
    }
}

namespace {

/// One step of a hand-built collection plan, streaming when @p bounds is set.
ScenarioStep collection_step (const std::string& name,
const std::string& url,
std::optional<vayu::StreamBounds> bounds = std::nullopt) {
    ScenarioStep step;
    step.request_id            = "req_" + name;
    step.name                  = name;
    step.request.method        = vayu::HttpMethod::GET;
    step.request.url           = url;
    step.request.timeout_ms    = 20000;
    step.request.stream_bounds = std::move (bounds);
    step.stored_url            = url;
    return step;
}

/// A collection load run of @p steps, @p vus virtual users each running one
/// iteration.
struct CollectionLoadRun {
    std::shared_ptr<ScenarioExecution> execution;
    nlohmann::json config;
};

CollectionLoadRun collection_load_run (const std::string& collection_id,
std::vector<ScenarioStep> steps,
size_t vus) {
    auto execution                   = std::make_shared<ScenarioExecution> ();
    execution->request.source        = "collection";
    execution->request.collection_id = collection_id;
    execution->plan.steps            = std::move (steps);
    nlohmann::json config{ { "mode", "iterations" }, { "iterations", vus },
        { "concurrency", vus }, { "timeout", 20000 }, { "workers", 1 },
        { "scenario", { { "source", "collection" }, { "collectionId", collection_id } } } };
    return { std::move (execution), std::move (config) };
}

/// The newest frame of @p context's run that satisfies @p wanted, once one
/// does; null when none did before the deadline.
template <typename Predicate>
nlohmann::json wait_for_frame (const RunContext& context, Predicate wanted) {
    nlohmann::json found;
    const bool seen = vayu::tests::wait_until ([&] () {
        const auto frames = live_frames (context);
        if (frames.empty () || !wanted (frames.back ())) {
            return false;
        }
        found = frames.back ();
        return true;
    });
    EXPECT_TRUE (seen) << "no live frame matched";
    return found;
}

/// The frames of @p run_id once it has finished and emitted its settled one.
std::vector<nlohmann::json> settled_frames (vayu::db::Database& db,
const std::string& run_id,
const RunContext& context) {
    const auto stored = wait_for_terminal_run (db, run_id);
    if (!stored || stored->status != vayu::RunStatus::Completed) {
        ADD_FAILURE ()
        << "the run did not complete: " << (stored ? stored->summary : "no row");
        return {};
    }
    EXPECT_TRUE (
    vayu::tests::wait_until ([&] () { return context.closed.load (); }))
    << "the metrics thread never emitted its settled frame";
    return live_frames (context);
}

} // namespace

// #3304: a collection run whose step streams counts that stream's events live,
// as a single-request stream run does, and holds it on `streamsOpen` until it
// closes. `/sse-held` keeps the one stream open until released. Mutation
// checks: leave the plan out of the RunContext constructor's `streams` and the
// frames carry no stream keys; drop the `live` hand-off in
// `ScenarioLoadDriver::submit_one` and no frame counts an event.
TEST (LoadStream, ACollectionRunsStreamingStepIsCountedLiveWhileOpen) {
    const std::string db_path = "test_load_stream_collection_live.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        vayu::tests::SlowMockServer server;

        std::vector<ScenarioStep> steps;
        steps.push_back (collection_step (
        "events", server.sse_held_url (), vayu::StreamBounds{ 20000, 100000 }));
        const auto run = collection_load_run ("col_stream_live", std::move (steps), 1);
        const std::string run_id = "run_load_stream_collection_live";
        create_load_run (db, run_id, run.config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, run.config, db, run.execution));
        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);

        const auto open_frame = wait_for_frame (*context, [] (const nlohmann::json& frame) {
            return frame.value ("streamEvents", size_t{ 0 }) > 0;
        });
        server.released.store (true, std::memory_order_relaxed);
        if (!open_frame.is_null ()) {
            EXPECT_EQ (open_frame.at ("streamsOpen").get<size_t> (), 1u)
            << open_frame.dump ();
            EXPECT_EQ (open_frame.at ("totalRequests").get<size_t> (), 0u)
            << "the stream had not completed: " << open_frame.dump ();
            EXPECT_TRUE (open_frame.contains ("eventsPerSecond")) << open_frame.dump ();
        }

        const auto frames = settled_frames (db, run_id, *context);
        ASSERT_FALSE (frames.empty ());
        const auto [status, report] = vayu::http::routes::run_report_response (db, run_id);
        ASSERT_EQ (status, 200);
        EXPECT_EQ (frames.back ().at ("streamEvents").get<size_t> (),
        report.at ("stream").at ("totalEvents").get<size_t> ())
        << "the settled live total is the report's: " << frames.back ().dump ();
        EXPECT_EQ (frames.back ().at ("streamsOpen").get<size_t> (), 0u);

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #3304: `streamsOpen` counts streaming transfers, not every active one. Two
// virtual users open the streaming step; `/sse-held-first` holds the first
// and closes the second at once, whose user moves on to `/hang`. A frame that
// has seen that one completion with two transfers in flight holds one stream
// and one ordinary request. Mutation check: read the active transfer count
// into `streamsOpen` in `get_current_stats` and that frame reads 2.
TEST (LoadStream, AMixedCollectionRunCountsOnlyItsStreamsOpen) {
    const std::string db_path = "test_load_stream_collection_mixed.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        vayu::tests::SlowMockServer server;

        std::vector<ScenarioStep> steps;
        steps.push_back (collection_step ("events",
        server.sse_held_first_url (), vayu::StreamBounds{ 20000, 100000 }));
        steps.push_back (collection_step ("held", server.hang_url ()));
        const auto run = collection_load_run ("col_stream_mixed", std::move (steps), 2);
        const std::string run_id = "run_load_stream_collection_mixed";
        create_load_run (db, run_id, run.config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, run.config, db, run.execution));
        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);

        const auto mixed_frame =
        wait_for_frame (*context, [] (const nlohmann::json& frame) {
            return frame.value ("totalRequests", size_t{ 0 }) == 1 &&
            frame.value ("activeConnections", size_t{ 0 }) == 2;
        });
        server.released.store (true, std::memory_order_relaxed);
        if (!mixed_frame.is_null ()) {
            EXPECT_EQ (mixed_frame.at ("streamsOpen").get<size_t> (), 1u)
            << mixed_frame.dump ();
            EXPECT_GT (mixed_frame.at ("streamEvents").get<size_t> (), 0u)
            << mixed_frame.dump ();
        }

        const auto frames = settled_frames (db, run_id, *context);
        ASSERT_FALSE (frames.empty ());
        EXPECT_EQ (frames.back ().at ("streamsOpen").get<size_t> (), 0u)
        << frames.back ().dump ();

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

// #3304: a collection run with no streaming step is not a stream run: none of
// its frames carries a stream key. Mutation check: allocate the counters for
// every collection run (`streams` true whenever the context has a plan) and
// the frames carry `streamEvents` and `streamsOpen`.
TEST (LoadStream, ACollectionRunWithNoStreamingStepCarriesNoStreamKeys) {
    const std::string db_path = "test_load_stream_collection_plain.db";
    vayu::tests::remove_database_files (db_path);
    vayu::http::global_init ();
    {
        vayu::db::Database db (db_path);
        db.init ();
        vayu::tests::SlowMockServer server;

        std::vector<ScenarioStep> steps;
        steps.push_back (collection_step ("plain", server.fast_url ()));
        const auto run = collection_load_run ("col_stream_plain", std::move (steps), 1);
        const std::string run_id = "run_load_stream_collection_plain";
        create_load_run (db, run_id, run.config);

        RunManager manager;
        ASSERT_TRUE (manager.start_run (run_id, run.config, db, run.execution));
        const auto context = manager.get_run_or_retained (run_id);
        ASSERT_NE (context, nullptr);

        const auto frames = settled_frames (db, run_id, *context);
        ASSERT_FALSE (frames.empty ());
        for (const auto& frame : frames) {
            EXPECT_EQ (stream_keys_in (frame), "") << frame.dump ();
        }

        manager.shutdown ();
    }
    vayu::http::global_cleanup ();
    vayu::tests::remove_database_files (db_path);
}

namespace {

/// @p entries' counts summed per class.
StatusClassCounts class_totals (const nlohmann::json& entries) {
    StatusClassCounts totals{};
    for (const auto& value : entries) {
        const auto entry = status_second_entry_from_json (value);
        if (!entry) {
            ADD_FAILURE () << "not a status-seconds entry: " << value.dump ();
            continue;
        }
        for (size_t i = 0; i < totals.size (); ++i) {
            totals.at (i) += entry->counts.at (i);
        }
    }
    return totals;
}

} // namespace

// #2866: a gate drains the closed seconds once and hands the same entries to
// its frame (`statusSeconds`) and its stored row (`status_seconds`), so live
// and History draw the same seconds; the seconds run on from 0 with none
// emitted twice. Load "started" 2.5 s before the completions, so they belong
// to a second the first gates close. Mutation check: drain again in
// `persist_metric_tick` instead of taking the gate's entries and the rows
// store no second, so the wait below runs out and the frame/row equality
// fails.
TEST (CollectMetrics, TheGateFrameAndItsStoredRowCarryTheSameClosedSeconds) {
    const std::string db_path = "test_collect_metrics_status_seconds.db";
    vayu::tests::remove_database_files (db_path);

    vayu::db::Database db (db_path);
    db.init ();

    vayu::db::Run run;
    run.id              = "status_seconds_run";
    run.type            = vayu::RunType::Load;
    run.status          = vayu::RunStatus::Running;
    run.start_time      = 1;
    run.config_snapshot = "{}";
    db.create_run (run);

    nlohmann::json cfg;
    auto ctx = std::make_shared<RunContext> (run.id, cfg);
    auto& mc = *ctx->metrics_collector;
    const int64_t load_start = std::chrono::duration_cast<std::chrono::milliseconds> (
                               std::chrono::steady_clock::now ().time_since_epoch ())
                               .count () -
    2500;
    ctx->load_start_steady_ms.store (load_start);
    mc.set_load_start (load_start);
    for (int i = 0; i < 80; ++i) {
        mc.record_success (200, 5.0, 0.0);
    }
    for (int i = 0; i < 15; ++i) {
        mc.record_success (500, 5.0, 0.0);
    }
    for (int i = 0; i < 5; ++i) {
        mc.record_error (vayu::ErrorCode::Timeout, "timed out");
    }
    ctx->is_running = true;

    const StatusClassCounts recorded{ 80, 0, 0, 15, 5 };
    const auto stored_totals = [&] () {
        nlohmann::json entries = nlohmann::json::array ();
        for (const auto& [timestamp, row] : stored_rows (db, run.id)) {
            for (const auto& entry : row.at ("status_seconds")) {
                entries.push_back (entry);
            }
        }
        return class_totals (entries);
    };
    std::thread metrics ([&] () { collect_metrics (ctx, &db); });
    EXPECT_TRUE (
    vayu::tests::wait_until ([&] () { return stored_totals () == recorded; }))
    << "the stored rows never held every completion";
    ctx->is_running = false;
    metrics.join ();

    const auto rows   = stored_rows (db, run.id);
    const auto frames = live_frames (*ctx);
    ASSERT_FALSE (frames.empty ());
    size_t gate_frames  = 0;
    int64_t next_second = 0;
    for (size_t i = 0; i < frames.size (); ++i) {
        const auto& frame = frames[i];
        ASSERT_EQ (frame.contains ("statusSeconds"), frame.contains ("secondSamples"))
        << "statusSeconds is a gate frame's key: " << frame.dump ();
        if (!frame.contains ("statusSeconds")) {
            continue;
        }
        for (const auto& entry : frame.at ("statusSeconds")) {
            EXPECT_EQ (entry.at ("second").get<int64_t> (), next_second++)
            << frame.dump ();
            EXPECT_EQ (entry.at ("span").get<int64_t> (), 1) << frame.dump ();
        }
        // The final frame closes what closed since the last gate, and stores
        // no row.
        if (i + 1 == frames.size ()) {
            continue;
        }
        ++gate_frames;
        const auto row = rows.find (frame.at ("timestamp").get<int64_t> ());
        ASSERT_NE (row, rows.end ())
        << "a gate frame with no stored row: " << frame.dump ();
        EXPECT_EQ (row->second.at ("status_seconds"), frame.at ("statusSeconds"))
        << "at " << row->first;
    }
    EXPECT_EQ (gate_frames, rows.size ());
    EXPECT_GE (next_second, 3) << "the completions' second was never closed";

    vayu::tests::remove_database_files (db_path);
}
