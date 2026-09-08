/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/elements_timers_test.cpp
 * @brief Issue #1498: `timer.pacing`, gaussian `timer.think`, the run-level
 *        `elements.timers` / `elements.seed` override, and the seeded
 *        generators (`apply_timers_override`, `derive_vu_rng`) both ride.
 *
 * Four layers, cheapest first: the registry's schema (no run at all), the
 * override's own branch logic (a direct call, no pipeline), a sequential
 * collection run's real wall-clock behaviour, and reproducibility of that
 * behaviour across two independent runs sharing an explicit seed.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <memory>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "step_elements_test_helper.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_load.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/cookie_jar.hpp"

using nlohmann::json;
using vayu::core::Registry;

namespace {

// ============================================================================
// A. Registry / schema level - no run needed.
// ============================================================================

TEST (ElementsTimersRegistryTest, TimerPacingIsRegisteredAsATimerThatTracksScopeOccurrence) {
    bool found = false;
    for (const auto& kind : Registry::instance ().kinds ()) {
        if (kind.kind == "timer.pacing") {
            found = true;
            EXPECT_EQ (kind.category, "timer");
            EXPECT_TRUE (kind.tracks_scope_occurrence)
            << "timer.pacing is the one kind scenario_plan.cpp's "
               "mark_scope_entries must walk";
        }
    }
    EXPECT_TRUE (found);
}

TEST (ElementsTimersRegistryTest, TimerPacingConfigMissingEveryMsIsRejected) {
    const json elements = json::array ({ json{ { "id", "el_1" },
    { "kind", "timer.pacing" }, { "config", json::object () } } });
    EXPECT_TRUE (Registry::instance ().validate (elements).has_value ());
}

TEST (ElementsTimersRegistryTest, TimerPacingEveryMsOfZeroIsRejected) {
    const json elements = json::array ({ json{ { "id", "el_1" },
    { "kind", "timer.pacing" }, { "config", { { "everyMs", 0 } } } } });
    EXPECT_TRUE (Registry::instance ().validate (elements).has_value ())
    << "the schema's minimum is 1 - a 'pace every 0ms' config is meaningless";
}

// `additionalProperties: false` is what keeps `_elementId` / `_scopeEntry`
// unwritable by a client - if the schema is ever loosened to admit them (to
// add a new client-facing field, say, without noticing these two ride along)
// this must start failing.
TEST (ElementsTimersRegistryTest, TimerPacingRefusesAClientSuppliedElementId) {
    const json elements = json::array ({ json{ { "id", "el_1" }, { "kind", "timer.pacing" },
    { "config", { { "everyMs", 300 }, { "_elementId", "sneaky" } } } } });
    EXPECT_TRUE (Registry::instance ().validate (elements).has_value ());
}

TEST (ElementsTimersRegistryTest, TimerPacingRefusesAClientSuppliedScopeEntry) {
    const json elements = json::array ({ json{ { "id", "el_1" }, { "kind", "timer.pacing" },
    { "config", { { "everyMs", 300 }, { "_scopeEntry", true } } } } });
    EXPECT_TRUE (Registry::instance ().validate (elements).has_value ());
}

TEST (ElementsTimersRegistryTest, TimerThinkAcceptsAWellFormedGaussianConfig) {
    const json elements = json::array ({ json{ { "id", "el_1" }, { "kind", "timer.think" },
    { "config", { { "gaussian", { { "meanMs", 500 }, { "deviationMs", 100 } } } } } } });
    EXPECT_FALSE (Registry::instance ().validate (elements).has_value ());
}

TEST (ElementsTimersRegistryTest, TimerThinkRefusesGaussianMissingDeviationMs) {
    const json elements = json::array ({ json{ { "id", "el_1" }, { "kind", "timer.think" },
    { "config", { { "gaussian", { { "meanMs", 500 } } } } } } });
    EXPECT_TRUE (Registry::instance ().validate (elements).has_value ());
}

TEST (ElementsTimersRegistryTest, TimerThinkRefusesAnEmptyGaussianObject) {
    const json elements = json::array ({ json{ { "id", "el_1" },
    { "kind", "timer.think" }, { "config", { { "gaussian", json::object () } } } } });
    EXPECT_TRUE (Registry::instance ().validate (elements).has_value ())
    << "both meanMs and deviationMs are required - neither is present here";
}

// ============================================================================
// B. apply_timers_override - a direct call, no pipeline or run needed.
// ============================================================================

TEST (ApplyTimersOverrideTest, ANullOverrideReturnsOwnWaitUnchanged) {
    EXPECT_EQ (vayu::core::apply_timers_override (nullptr, 500, nullptr), 500);
}

TEST (ApplyTimersOverrideTest, AsConfiguredModeReturnsOwnWaitUnchanged) {
    vayu::core::TimersOverride override_;
    override_.mode = vayu::core::TimersOverride::Mode::AsConfigured;
    EXPECT_EQ (vayu::core::apply_timers_override (&override_, 777, nullptr), 777);
}

TEST (ApplyTimersOverrideTest, OffModeSilencesRegardlessOfOwnWait) {
    vayu::core::TimersOverride override_;
    override_.mode = vayu::core::TimersOverride::Mode::Off;
    EXPECT_FALSE (vayu::core::apply_timers_override (&override_, 999, nullptr).has_value ());
    EXPECT_FALSE (vayu::core::apply_timers_override (&override_, 0, nullptr).has_value ());
}

TEST (ApplyTimersOverrideTest, FixedModeReturnsTheFixedValueRegardlessOfOwnWait) {
    vayu::core::TimersOverride override_;
    override_.mode     = vayu::core::TimersOverride::Mode::Fixed;
    override_.fixed_ms = 250;
    EXPECT_EQ (vayu::core::apply_timers_override (&override_, 10, nullptr), 250);
    EXPECT_EQ (vayu::core::apply_timers_override (&override_, 10000, nullptr), 250);
}

TEST (ApplyTimersOverrideTest, RangeModeWithEqualBoundsReturnsThatValueWithNoDraw) {
    vayu::core::TimersOverride override_;
    override_.mode   = vayu::core::TimersOverride::Mode::Range;
    override_.min_ms = 400;
    override_.max_ms = 400;
    // `rng` is null here - a real uniform_int_distribution draw against a
    // null generator would crash, so this only passes if the equal-bounds
    // branch really is taken before the code ever touches `rng`.
    EXPECT_EQ (vayu::core::apply_timers_override (&override_, 0, nullptr), 400);
}

TEST (ApplyTimersOverrideTest, RangeModeIsReproducibleWithTheSameSeedAndStaysInBounds) {
    vayu::core::TimersOverride override_;
    override_.mode   = vayu::core::TimersOverride::Mode::Range;
    override_.min_ms = 100;
    override_.max_ms = 200;

    // NOLINTBEGIN(cert-msc51-cpp) - deliberate: the test asserts two
    // identically-seeded generators draw identically, which needs a fixed,
    // known seed, not a random one.
    std::mt19937_64 rng_a{ 4242 };
    std::mt19937_64 rng_b{ 4242 };
    const auto first = vayu::core::apply_timers_override (&override_, 0, &rng_a);
    const auto second = vayu::core::apply_timers_override (&override_, 0, &rng_b);
    ASSERT_HAS_VALUE (first);
    ASSERT_HAS_VALUE (second);
    EXPECT_EQ (*first, *second)
    << "two generators seeded identically must draw the same value";

    std::mt19937_64 rng{ 777 };
    // NOLINTEND(cert-msc51-cpp)
    for (int i = 0; i < 50; ++i) {
        const auto drawn = vayu::core::apply_timers_override (&override_, 0, &rng);
        ASSERT_HAS_VALUE (drawn);
        EXPECT_GE (*drawn, 100);
        EXPECT_LE (*drawn, 200);
    }
}

// ============================================================================
// E. derive_vu_rng - a direct call, no run needed.
// ============================================================================

TEST (DeriveVuRngTest, SameSeedAndIndexProduceIdenticalSequences) {
    auto rng_a = vayu::core::derive_vu_rng (12345, 3);
    auto rng_b = vayu::core::derive_vu_rng (12345, 3);
    for (int i = 0; i < 5; ++i) {
        EXPECT_EQ (rng_a (), rng_b ())
        << "draw " << i << " diverged for the same (run_seed, vu_index)";
    }
}

TEST (DeriveVuRngTest, DifferentVuIndexProducesADifferentFirstDraw) {
    auto rng_1 = vayu::core::derive_vu_rng (12345, 1);
    auto rng_2 = vayu::core::derive_vu_rng (12345, 2);
    EXPECT_NE (rng_1 (), rng_2 ())
    << "two adjacent VU indices collided on their very first draw - "
       "astronomically unlikely unless derive_vu_rng regressed to something "
       "like a plain XOR of the seed and the index";
}

// ============================================================================
// F. SharedPacingClocks - a direct call, no run needed (issue #1570).
// ============================================================================

TEST (SharedPacingClocksTest, AnUnstartedNameIsNeverDelayed) {
    vayu::core::SharedPacingClocks clocks ({ "a" });
    EXPECT_EQ (clocks.advance ("a", 100, 1000), 0)
    << "a name's first-ever claim must never be delayed";
}

TEST (SharedPacingClocksTest, ASecondClaimWaitsOutTheFirstsInterval) {
    vayu::core::SharedPacingClocks clocks ({ "a" });
    ASSERT_EQ (clocks.advance ("a", 100, 1000), 0);
    EXPECT_EQ (clocks.advance ("a", 100, 1010), 90)
    << "10ms into a 100ms cadence should leave 90ms to wait";
}

TEST (SharedPacingClocksTest, DifferentNamesHoldIndependentClocks) {
    vayu::core::SharedPacingClocks clocks ({ "a", "b" });
    ASSERT_EQ (clocks.advance ("a", 100, 1000), 0);
    EXPECT_EQ (clocks.advance ("b", 100, 1000), 0)
    << "b's first claim was delayed by a's history - the clocks are sharing "
       "state that should be per-name";
}

TEST (SharedPacingClocksTest, AnUnknownNameIsANoOp) {
    vayu::core::SharedPacingClocks clocks ({ "a" });
    EXPECT_EQ (clocks.advance ("never-registered", 100, 1000), 0);
}

// Eight threads race 50 claims each onto one shared 10ms clock. Every claim
// must land on its own deadline - if the compare-exchange loop ever lost a
// race, two threads would compute the same deadline from the same stale
// `prev` and this collapses two distinct slots into one.
//
// Mutation check: replacing the `compare_exchange_weak` loop with a plain
// (non-atomic) load-then-store reproduces exactly that collision, and this
// test reds with duplicate deadlines.
TEST (SharedPacingClocksTest, ConcurrentClaimsNeverCollideOnTheSameSlot) {
    vayu::core::SharedPacingClocks clocks ({ "shared" });
    constexpr int kThreads     = 8;
    constexpr int kPerThread   = 50;
    constexpr int64_t kNow     = 5000;
    constexpr int64_t kEveryMs = 10;

    std::vector<int64_t> deadlines (
    static_cast<size_t> (kThreads) * static_cast<size_t> (kPerThread));
    std::vector<std::thread> threads;
    threads.reserve (kThreads);
    for (int t = 0; t < kThreads; ++t) {
        threads.emplace_back ([&, t] {
            for (int i = 0; i < kPerThread; ++i) {
                const int64_t wait = clocks.advance ("shared", kEveryMs, kNow);
                deadlines[(static_cast<size_t> (t) * kPerThread) + static_cast<size_t> (i)] =
                kNow + wait;
            }
        });
    }
    for (auto& thread : threads) {
        thread.join ();
    }

    std::sort (deadlines.begin (), deadlines.end ());
    const auto unique_end = std::unique (deadlines.begin (), deadlines.end ());
    EXPECT_EQ (std::distance (deadlines.begin (), unique_end),
    static_cast<long> (deadlines.size ()))
    << "two concurrent claims landed on the same deadline - the "
       "compare-exchange loop lost a race";
}

// ============================================================================
// C, D. Sequential-run behaviour - a real design-mode collection run driven
// through RunManager, following scenario_runner_test.cpp's own shape
// (ScenarioRunnerTest's fixture is file-local there, so this is a smaller
// sibling of it rather than a reuse of its class).
// ============================================================================

/// Two endpoints, both instant 200s - the point of every test below is
/// timing, never response content.
class TimersMockServer {
    public:
    TimersMockServer () {
        svr.new_task_queue = vayu::tests::pooled_task_queue (8);
        svr.Get ("/ok", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("{}", "application/json");
        });
        svr.Get ("/login", [] (const httplib::Request&, httplib::Response& res) {
            res.set_content ("{}", "application/json");
        });
        port   = svr.bind_to_any_port ("127.0.0.1");
        thread = std::thread ([this] () { svr.listen_after_bind (); });
        svr.wait_until_ready ();
    }
    ~TimersMockServer () {
        svr.stop ();
        if (thread.joinable ()) {
            thread.join ();
        }
    }
    TimersMockServer (const TimersMockServer&)            = delete;
    TimersMockServer& operator= (const TimersMockServer&) = delete;
    TimersMockServer (TimersMockServer&&)                 = delete;
    TimersMockServer& operator= (TimersMockServer&&)      = delete;

    [[nodiscard]] std::string url (const std::string& path) const {
        return "http://127.0.0.1:" + std::to_string (port) + path;
    }

    private:
    httplib::Server svr;
    std::thread thread;
    int port = 0;
};

class ElementsTimersRunnerTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_elements_timers_runner.db";

    void SetUp () override {
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        server_ = std::make_unique<TimersMockServer> ();
    }
    void TearDown () override {
        manager_.shutdown ();
        server_.reset ();
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    void seed_collection () {
        vayu::db::Collection col;
        col.id         = "col_1";
        col.name       = "Collection col_1";
        col.created_at = 1;
        col.updated_at = 1;
        db_->create_collection (col);
    }

    /// A request in `col_1` carrying an arbitrary `elements` array.
    void seed_request_with_elements (const std::string& id,
    int order,
    const std::string& path,
    const json& elements) {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = "col_1";
        r.name          = "Step " + id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = server_->url (path);
        r.elements      = elements.dump ();
        r.order         = order;
        r.created_at    = 1;
        r.updated_at    = 1;
        db_->save_request (r);
    }

    void seed_request (const std::string& id, int order, const std::string& path) {
        seed_request_with_elements (id, order, path, json::array ());
    }

    /// Resolve, create the run row and start the worker - `start_scenario` in
    /// `scenario_runner_test.cpp`'s own shape, with one addition: an
    /// `elements` run override (issue #1498's `elements.seed` /
    /// `elements.timers`), absent by default. A fresh run id per call, so a
    /// test that starts more than one run (the reproducibility pair) never
    /// collides on storage.
    std::string start (size_t iterations, const json& elements_override = json ()) {
        json scenario{ { "source", "collection" }, { "collectionId", "col_1" },
            { "iterations", iterations } };

        vayu::core::ScenarioResolveOptions options;
        options.timeout_ms           = 5000;
        options.limits.max_steps     = 200;
        options.limits.max_data_rows = 1000;
        options.limits.max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES;

        auto resolved = vayu::core::resolve_scenario (*db_, scenario, options);
        EXPECT_TRUE (resolved.ok) << resolved.error;

        auto execution     = std::make_shared<vayu::core::ScenarioExecution> ();
        execution->request = std::move (resolved.request);
        execution->plan    = std::move (resolved.plan);
        execution->data_rows = std::move (resolved.data_rows);
        execution->spec      = std::move (resolved.spec);

        json config{ { "scenario", scenario } };
        if (!elements_override.is_null ()) {
            config["elements"] = elements_override;
        }

        const std::string run_id = "run_" + std::to_string (++run_counter_);
        vayu::db::Run run;
        run.id              = run_id;
        run.type            = vayu::RunType::Scenario;
        run.status          = vayu::RunStatus::Pending;
        run.config_snapshot = config.dump ();
        const auto started_at = std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::system_clock::now ().time_since_epoch ())
                                .count ();
        run.start_time = started_at;
        run.end_time   = started_at;
        db_->create_run (run);

        EXPECT_TRUE (manager_.start_scenario_run (run_id, config, execution, *db_, jar_));
        return run_id;
    }

    vayu::RunStatus await_terminal (const std::string& run_id) {
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::seconds (30);
        while (std::chrono::steady_clock::now () < deadline) {
            auto run = db_->get_run (run_id);
            if (run && run->status != vayu::RunStatus::Pending &&
            run->status != vayu::RunStatus::Running) {
                // Give the worker's last acts (retain, closed) a moment, on
                // the same rule scenario_runner_test.cpp's own helper states.
                std::this_thread::sleep_for (std::chrono::milliseconds (50));
                return run->status;
            }
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
        }
        ADD_FAILURE () << "Run " << run_id << " never reached a terminal status";
        return vayu::RunStatus::Failed;
    }

    std::unique_ptr<vayu::db::Database> db_;
    std::unique_ptr<TimersMockServer> server_;
    vayu::core::RunManager manager_;
    vayu::http::CookieJar jar_;
    size_t run_counter_ = 0;
};

// A gaussian `timer.think` actually waits roughly its configured mean.
TEST_F (ElementsTimersRunnerTest, GaussianTimerThinkWaitsApproximatelyItsMean) {
    seed_collection ();
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array (
    { vayu::tests::timer_think_gaussian_element_json ("el_timer", 100.0, 1.0) }));
    seed_request ("req_b", 1, "/login");

    const auto started = std::chrono::steady_clock::now ();
    const auto run_id  = start (/*iterations=*/1);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started);
    // A generous floor, not a tight window: a gaussian draw around a 100ms
    // mean with a 1ms deviation is essentially always >= 90ms, and a loaded
    // CI box only ever makes this run *longer*, never shorter - there is no
    // way for load to push it below 50ms.
    EXPECT_GE (elapsed.count (), 50)
    << "the think time did not hold up the run at all";
}

// `timer.pacing` on a single request holds a steady cadence across
// iterations: the second pass must not start before the first plus
// `everyMs`, whatever the request's own duration was.
TEST_F (ElementsTimersRunnerTest, TimerPacingHoldsCadenceAcrossIterations) {
    seed_collection ();
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array ({ vayu::tests::timer_pacing_element_json ("el_pacing", 300) }));

    const auto started = std::chrono::steady_clock::now ();
    const auto run_id  = start (/*iterations=*/2);
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started);
    // The first pass is never delayed (nothing "last started" yet); the
    // second pass must wait out very nearly the whole 300ms, since one
    // request against a loopback mock costs single-digit milliseconds. 250ms
    // is a floor generous enough to absorb that cost and scheduler jitter on
    // a loaded box, while staying far above what a run with no pacing at all
    // (a handful of milliseconds) could ever produce.
    EXPECT_GE (elapsed.count (), 250)
    << "the second pass did not wait out the configured cadence";
}

// `elements.timers: "off"` silences every timer.* element for the run - a
// two-second think time must not hold the run up at all.
TEST_F (ElementsTimersRunnerTest, ElementsTimersOffSilencesAConfiguredThinkTime) {
    seed_collection ();
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array ({ json{ { "id", "el_timer" }, { "kind", "timer.think" },
    { "config", { { "ms", 2000 } } } } }));
    seed_request ("req_b", 1, "/login");

    const auto started = std::chrono::steady_clock::now ();
    const auto run_id  = start (/*iterations=*/1, json{ { "timers", "off" } });
    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Completed);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - started);
    // Two tiny GETs against a loopback mock, with the 2-second wait silenced,
    // finish in well under a second even on a loaded box - a 4x margin below
    // the 2000ms the wait would cost if it were not silenced.
    EXPECT_LT (elapsed.count (), 500)
    << "a 2-second think time was not silenced by elements.timers: off";

    auto rows = db_->get_results (run_id);
    ASSERT_EQ (rows.size (), 2u);
    const auto trace0 = json::parse (rows[0].trace_data);
    ASSERT_EQ (trace0["elements"].size (), 1u);
    EXPECT_EQ (trace0["elements"][0]["waitedMs"].get<int64_t> (), 0);
}

// A stop signalled while `timer.pacing` is mid-wait must take effect
// promptly rather than making the run sit out the rest of that wait first -
// the same "stop is honoured without finishing what is already in flight"
// contract `timer.think` gets from its own should_stop poll (mirrored here
// from AStopIsHonouredBetweenStepsNotAfterTheIteration in
// scenario_runner_test.cpp, adapted to pacing).
//
// NOTE: `timer.pacing` runs at `step.before`, dispatched through
// `execute_exchange` (request_exchange.cpp), whose `ElementContext` binds
// `should_stop = nullptr` unconditionally - `ExchangeInputs` carries no
// `should_stop` field for `run_step_exchange` (scenario_runner.cpp) to fill
// in, unlike the `step.between` dispatch it does bind should_stop for. If
// that wiring gap is still open when this runs, this test fails with
// `elapsed` close to `every_ms` rather than under the 1000ms bound below -
// that failure is pointing at request_exchange.cpp / routes.hpp's
// ExchangeInputs, not at this test.
TEST_F (ElementsTimersRunnerTest, AStopMidTimerPacingWaitEndsTheRunPromptly) {
    seed_collection ();
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array ({ vayu::tests::timer_pacing_element_json ("el_pacing", 1500) }));
    seed_request ("req_b", 1, "/login");

    const auto run_id = start (/*iterations=*/20);
    auto context      = manager_.get_run (run_id);
    ASSERT_TRUE (context != nullptr);

    // Long enough that the run has finished its (unwaited) first pass and is
    // now blocked inside the second pass' ~1500ms pacing wait; short enough
    // that it cannot possibly have finished that wait on its own.
    std::this_thread::sleep_for (std::chrono::milliseconds (150));
    const auto stop_requested = std::chrono::steady_clock::now ();
    context->should_stop      = true;

    ASSERT_EQ (await_terminal (run_id), vayu::RunStatus::Stopped);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - stop_requested);
    EXPECT_LT (elapsed.count (), 1000)
    << "the run took nearly as long to stop as the pacing wait itself would "
       "have taken to finish unattended - the stop signal was not honoured "
       "until the wait completed";
}

// The same `elements.seed` produces the same gaussian draw across two
// independent runs - the reproducibility issue #1498's seed exists for. Two
// separate `start()` calls each get a fresh RunContext, so this is a real
// proof the seed decides the draw rather than incidental process state.
TEST_F (ElementsTimersRunnerTest, TheSameSeedReproducesTheSameThinkWaitAcrossTwoRuns) {
    seed_collection ();
    seed_request_with_elements ("req_a", 0, "/ok",
    json::array (
    { vayu::tests::timer_think_gaussian_element_json ("el_timer", 500.0, 100.0) }));
    seed_request ("req_b", 1, "/login");

    const json seeded{ { "seed", 42 } };
    const auto run_1 = start (/*iterations=*/1, seeded);
    ASSERT_EQ (await_terminal (run_1), vayu::RunStatus::Completed);
    const auto run_2 = start (/*iterations=*/1, seeded);
    ASSERT_EQ (await_terminal (run_2), vayu::RunStatus::Completed);

    auto waited_ms_of = [&] (const std::string& run_id) {
        auto rows = db_->get_results (run_id);
        EXPECT_EQ (rows.size (), 2u);
        const auto trace0 = json::parse (rows[0].trace_data);
        return trace0["elements"][0]["waitedMs"].get<int64_t> ();
    };

    EXPECT_EQ (waited_ms_of (run_1), waited_ms_of (run_2))
    << "the same elements.seed must draw the same gaussian wait on both runs";
}

} // namespace
