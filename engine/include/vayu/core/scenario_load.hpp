#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/scenario_load.hpp
 * @brief Load-mode scenarios: a per-virtual-user state machine over the shared
 *        plan, per-VU cookies and per-step histograms (issue #357).
 *
 * The plan is shared with the design-mode runner; the executor is not, and that
 * divergence is the design. `scenario_runner.cpp` walks one sequence through
 * `http::Client` because a design-mode step needs the environment jar and an
 * inline script. Neither is available - or wanted - at 60k RPS, so a load-mode
 * scenario runs on the event loop instead, and the *only* substitution it makes
 * to the existing closed-loop controller is what `submit_one` submits: "the
 * next step of virtual user *k*" rather than "another copy of the one request".
 * `maintain_concurrency`, `compute_refill_deficit`, the SPSC submission path
 * and the single-producer discipline are shared verbatim.
 *
 * ## `concurrency` is the number of virtual users
 *
 * Which is what k6 and JMeter mean by it. A VU is a small value - a cursor into
 * the plan plus its own cookies - not a thread; 1,000 VUs are 1,000 cursors
 * over one immutable plan, and the event loop's workers are unchanged.
 *
 * ## Cookie state is per-VU, never the shared jar
 *
 * Each VU owns a private cookie list, empty at the start of each iteration, and
 * the environment jar is untouched. This strengthens `cookie_jar.hpp`'s "Not on
 * the load path" rule rather than fighting it: a jar shared across the event
 * loop's workers is either a lock on the hot path or per-worker jars that do
 * not actually share. It is also the semantically correct answer - one session
 * shared between 1,000 users is not the thing being measured.
 *
 * ## Data rows bind per iteration, from one shared cursor
 *
 * A run sent with `data` claims a row per VU iteration from a single run-wide
 * cursor (`ScenarioLoadState::data_cursor`), wrapping when the rows run out,
 * and every step of that iteration binds the same row (issue #449). Shared
 * rather than per-VU is what makes distinct credentials per user work: two VUs
 * must not both be handed row 0. The substitution itself is a join over the
 * step's `data_template`, split once at plan resolution - a step with no
 * `{{data.*}}` token has an empty template and does no per-iteration work at
 * all.
 *
 * ## Scripts stay deferred, and are keyed per step (issue #450)
 *
 * A step's `pre_script` / `post_script` are not run inline; the run's deferred
 * `validate_scripts` pass keeps its existing discipline, extended only by being
 * keyed per step index rather than per run. A step's `post_script` is replayed
 * after the run against the responses *that step* produced, which is why
 * sampling is per step too: one flat run-wide reservoir would let the hot first
 * step swamp the budget and never sample the last step of a long plan.
 * A `pre_script` still runs nowhere - it would have to run *before* a send this
 * mode never pauses for.
 *
 * `pm.execution` therefore still throws in a load run (`in_scenario == false`),
 * because a script that has already run against a recorded response cannot
 * redirect a sequence that already happened. Do not smuggle inline scripts in
 * here - the shape, if it is ever wanted, is a bounded pool of QuickJS contexts
 * per worker, and that is its own issue and its own benchmark.
 */

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "vayu/core/metrics_collector.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

struct RunContext;

/**
 * @brief Does this `POST /runs` payload ask for a scenario *load* run?
 *
 * A `scenario` block with a load `mode` beside it. Without a mode the block is
 * a design-mode collection run, which is what every caller sent before this
 * phase existed - so the absence of `mode` cannot start meaning something new,
 * and the presence of one cannot be mistaken for the design-mode default.
 */
[[nodiscard]] bool is_scenario_load_run (const nlohmann::json& config);

/**
 * @brief Why this scenario load payload cannot run, or `nullopt` if it can.
 *
 * The one rule with teeth is `constant_rps`: an open-loop arrival rate over a
 * multi-step sequence is k6's arrival-rate executor, a named non-goal of the
 * collection-runner design. Requesting it with a `scenario` block is a `400`
 * rather than a silent fall back to closed-loop, because a run that quietly
 * measured something other than what was asked for is worse than no run. The
 * same applies to `rps` / `targetRps` on any mode, since a non-zero rate is
 * what puts `ConstantLoadStrategy` on its rate-limited path.
 *
 * Returns the caller-facing sentence; the route sends it as `invalid_run_config`.
 */
[[nodiscard]] std::optional<std::string> validate_scenario_load_config (
const nlohmann::json& config);

/**
 * @brief One virtual user: where it is in the plan, and what session it holds.
 *
 * Deliberately a value, not a thread. `busy` is the whole synchronisation
 * story: the producer (the strategy thread) is the only writer of the
 * `false -> true` edge and a completion callback is the only writer of the
 * `true -> false` edge, so no compare-exchange is needed on either side. The
 * completion mutates `step`, `iteration` and `cookies` *before* releasing the
 * flag, and the producer acquires it before reading them, which is what makes
 * the hand-off free of any lock on the completion path.
 */
struct VirtualUser {
    /// Next step of the plan this VU will send.
    size_t step = 0;
    /// 0-based, and only ever advanced by this VU.
    size_t iteration = 0;
    /**
     * libcurl's own lines for this VU alone, replaced wholesale by each
     * completion and cleared at every iteration boundary. Replaced rather than
     * merged for the reason `CookieJar::store` documents: the captured list is
     * the whole jar the handle held, so merging would resurrect a cookie the
     * server deleted by expiring it.
     */
    std::vector<std::string> cookies;
    /**
     * The data row bound for this VU's *current* iteration, claimed from the
     * run's shared cursor when the VU wraps to step 0 and held for every step
     * of that iteration - the same row reaches the login and the checkout.
     *
     * `nullopt` for a run sent without `data`, which is what keeps a
     * token-free plan from ever consulting a row.
     */
    std::optional<size_t> data_row;
    /// In flight (or retired) when true. See the struct comment.
    std::atomic<bool> busy{ false };
    /// Set once the VU may start no further iteration; it then never becomes
    /// ready again, which is how an `iterations` run finishes without
    /// abandoning a VU in the middle of a sequence.
    bool retired = false;
};

/**
 * @brief One latency histogram per plan step, allocated once from the plan's
 *        step count - which is why `maxScenarioSteps` bounds the plan.
 *
 * Written concurrently by every event-loop worker, so records go through
 * `hdr_record_value_atomic` for the same writer-vs-writer reason the run's
 * aggregate histogram does. Read once, after the run has drained.
 */
class StepHistograms {
    public:
    explicit StepHistograms (size_t step_count);
    ~StepHistograms ();

    StepHistograms (const StepHistograms&)            = delete;
    StepHistograms& operator= (const StepHistograms&) = delete;

    /// A completed step: its latency, and whether it counted as an error.
    void record (size_t step, double latency_ms);
    void record_error (size_t step);

    [[nodiscard]] size_t step_count () const {
        return histograms_.size ();
    }
    [[nodiscard]] size_t completed (size_t step) const;
    [[nodiscard]] size_t errors (size_t step) const;
    [[nodiscard]] MetricsCollector::Percentiles percentiles (size_t step) const;

    private:
    std::vector<struct hdr_histogram*> histograms_;
    /// Per step, so the breakdown can say "this step ran N times, M of them
    /// failed" - a p99 over a step that only two VUs ever reached is a number
    /// the reader has to be able to discount.
    std::vector<std::atomic<size_t>> completed_;
    std::vector<std::atomic<size_t>> errors_;
};

/**
 * @brief The `steps` array of the run summary's `scenario` object.
 *
 * One entry per plan step, in plan order, carrying the step's identity beside
 * its numbers - a breakdown indexed only by position is unreadable next to a
 * 40-step sequence.
 */
[[nodiscard]] nlohmann::json
build_step_breakdown (const ScenarioPlan& plan, const StepHistograms& steps);

/**
 * @brief Everything a scenario load run accumulates, shared with its callbacks.
 *
 * Held by `shared_ptr` and captured by value into every completion callback,
 * because a callback can still be running after the executor's own frame has
 * returned: `execute_load_test` drains the event loop *after* the strategy
 * hands back, which is exactly the window a stack-local counter would be read
 * in after its death. The run's own tallies are therefore read off this object
 * after the drain, not before.
 */
struct ScenarioLoadState {
    explicit ScenarioLoadState (size_t step_count, size_t virtual_users)
    : steps (step_count), virtual_users (virtual_users) {
    }

    StepHistograms steps;
    std::vector<std::unique_ptr<VirtualUser>> vus;
    size_t virtual_users = 0;
    /// Producer-thread only: how many iterations were ever begun.
    size_t iterations_started = 0;
    /// Rows this run was given; 0 for a run sent without `data`.
    size_t data_row_count = 0;
    /**
     * The run's shared row cursor: one claim per *iteration*, across every
     * virtual user, wrapping when the rows run out.
     *
     * Shared rather than per-VU because that is the semantics that makes
     * distinct-credentials-per-user work - two VUs must not both get row 0 -
     * and it is k6's `iterationInTest` / JMeter's "All threads" parity. Plain,
     * not atomic, for the same reason `iterations_started` beside it is: the
     * strategy thread is the sole producer and `take_ready_vu` is the only
     * claimer, so the claim costs an increment rather than a locked one.
     */
    size_t data_cursor = 0;
    std::atomic<size_t> iterations_completed{ 0 };
    /// Iterations an errored step ended before the plan's last step. Counted
    /// rather than folded into `completed`, since a run that abandoned most of
    /// its iterations has a per-step breakdown that thins towards the end and
    /// nothing else would say why.
    std::atomic<size_t> iterations_abandoned{ 0 };
    std::atomic<size_t> steps_executed{ 0 };
    std::atomic<size_t> steps_errored{ 0 };
};

/**
 * @brief The `scenario` object a scenario load run stores in `runs.summary`.
 *
 * Shares `iterations`, `iterations_completed`, `steps_executed` and `errored`
 * with the design-mode payload (`build_scenario_summary_payload`) so the report
 * route reads one shape for both run kinds; `virtual_users`, `abandoned` and
 * `steps` are this mode's own.
 */
[[nodiscard]] nlohmann::json
build_scenario_load_summary (const ScenarioLoadState& state, const ScenarioPlan& plan);

/**
 * @brief Run the VU state machine to completion. Called by `execute_load_test`
 *        in place of a `LoadStrategy`, inside the same lifecycle.
 *
 * Every path leaves the run drainable: an errored step ends its VU's iteration
 * and the VU starts the next one rather than being stranded - a stranded VU
 * permanently shrinks effective concurrency, the same failure `handle_result`'s
 * error branch already guards against.
 */
[[nodiscard]] std::shared_ptr<ScenarioLoadState> execute_scenario_load (
std::shared_ptr<RunContext> context,
vayu::db::Database& db,
const ScenarioExecution& execution);

} // namespace vayu::core
