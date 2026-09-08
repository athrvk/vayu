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
 * ## The element pipeline runs here too, per VU (issue #1495)
 *
 * `submit_one` runs `ElementPipeline::run(StepBefore, ...)` plus the residual-
 * token pass before binding the request, and the completion runs
 * `ElementPipeline::run(StepAfter, ...)` before `finish_step`. Declarative
 * kinds (`extract.*`, `assert.*`) always run; a `script.*` kind runs here only
 * when its own `config.inline` is set or the run's `elements.scripts` override
 * forces it, read through `HotPathClass` rather than a `kind ==` comparison -
 * otherwise the step keeps the pre-#1495 behaviour, deferred to
 * `validate_scripts`' replay after the run, keyed per step index as before. A
 * VU's writes (`extract.json` into a variable, an inline `script.pre`'s
 * `pm.environment.set`) land in its own `VirtualUser::scope_overlay`
 * (`vayu::http::routes::ScopeOverlay`), never the run's shared scopes - two
 * users writing the same name is exactly the cross-contamination this rule
 * exists to prevent, on the same reasoning `cookies` above is per-VU. The
 * overlay is written on the completion path *before* `finish_step` releases
 * `busy`, so the same acquire/release pairing that makes `cookies` visible to
 * this VU's next step makes the overlay visible too, with no extra lock.
 *
 * An inline script still cannot redirect the plan (`pm.execution` throws
 * exactly as before, `in_scenario == false`): flow control only ever comes
 * from a `control.*` element or the deferred replay's own script, neither of
 * which exists on this path yet. What changed is only whether `script.pre` /
 * `script.post` run now or later - each event-loop worker and the strategy
 * thread get their own `ScriptEngine`
 * (`vayu::http::routes::script_engine_for_this_thread`), never a pool behind
 * one mutex, because a run's worker threads are spawned fresh for that run and
 * joined before it retains - the same lifetime the event loop itself already
 * relies on - so a thread-local instance is never stale and never shared
 * across two runs.
 */

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <random>
#include <string>
#include <unordered_map>
#include <vector>

#include "vayu/core/metrics_collector.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/core/threshold_eval.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/request_exchange.hpp"
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
 * @brief One virtual user's own generator, independent of every other VU's
 *        and of the run's own `RunContext::rng` (issue #1498).
 *
 * A single shared generator drawn from by every event-loop worker would be a
 * data race; a mutex around it would be a lock on the hot path for what a
 * gaussian `timer.think` or `elements.timers`' `Range` override needs only
 * rarely. Deriving one generator per VU from the run's seed instead costs
 * nothing at the point of use and keeps a run reproducible: the same
 * `elements.seed` and the same virtual user index always produce the same
 * generator, regardless of which worker thread happens to run that VU's
 * step.
 */
[[nodiscard]] std::mt19937_64 derive_vu_rng (uint64_t run_seed, size_t vu_index);

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
    /**
     * This user's own number in the run, **1-based** and fixed for the run's
     * whole life: what `{{$vu}}` binds into its requests and what a completion
     * reports as `pm.info.vu` (issue #994).
     *
     * Stored rather than derived from the user's position in
     * `ScenarioLoadState::vus`, because the producer hands a `VirtualUser*` to
     * the submission and the completion alike, and a number recovered by
     * searching that vector for the pointer would be an index the two could
     * disagree about.
     */
    size_t index = 1;
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
    /**
     * This VU's own write layer over the run's shared variable scopes (issue
     * #1495): what an inline `extract.*` or `script.*` element wrote on an
     * earlier step of this same iteration, read by the residual-token pass
     * before every later step's send. Cleared at the same iteration boundary
     * `cookies` is - a new iteration is a new user. Written and read under the
     * same `busy` acquire/release pairing the struct comment describes; no
     * VU-local lock is needed for the same reason none is needed for
     * `cookies`.
     */
    vayu::http::routes::ScopeOverlay scope_overlay;
    /**
     * Steady-clock milliseconds before which `take_ready_vu` will not select
     * this VU (issue #1495). Plumbing for a `timer.pacing` / gaussian
     * `timer.think` to schedule a VU's next submission without blocking the
     * producer thread; nothing writes a value past 0 yet - `timer.think`'s
     * existing `apply` blocks the calling thread instead and runs only at
     * `step.between`, which this load path does not invoke, so it is not
     * reachable here even by accident. See `docs/engine/elements.md`'s Load
     * paths section.
     */
    int64_t ready_at_ms = 0;
    /// Per-node "when did this node last start" state for this VU's own
    /// `timer.pacing` elements (issue #1498), keyed by element id - the
    /// load-path sibling of `RunContext::pacing_state`'s sequential-run
    /// version. Cleared at no boundary (unlike `cookies` / `scope_overlay`):
    /// pacing measures across iterations by design, not within one.
    std::unordered_map<std::string, int64_t> pacing_state;
    /// This VU's own generator (issue #1498), derived once at construction
    /// from the run's seed - see `derive_vu_rng`.
    std::mt19937_64 rng;
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
    StepHistograms (StepHistograms&&)                 = delete;
    StepHistograms& operator= (StepHistograms&&)      = delete;

    /// A completed step: its latency, and whether it counted as an error.
    void record (size_t step, double latency_ms);
    void record_error (size_t step);
    /// One submission of this step whose bound request still carried a
    /// `{{token}}` composition never resolved (issue #1503) - counted, not
    /// refused, because a literal `{{` can be deliberate in a body.
    void record_unresolved_token (size_t step);

    [[nodiscard]] size_t step_count () const {
        return histograms_.size ();
    }
    [[nodiscard]] size_t completed (size_t step) const;
    [[nodiscard]] size_t errors (size_t step) const;
    [[nodiscard]] size_t unresolved_tokens (size_t step) const;
    [[nodiscard]] MetricsCollector::Percentiles percentiles (size_t step) const;

    private:
    std::vector<struct hdr_histogram*> histograms_;
    /// Per step, so the breakdown can say "this step ran N times, M of them
    /// failed" - a p99 over a step that only two VUs ever reached is a number
    /// the reader has to be able to discount.
    std::vector<std::atomic<size_t>> completed_;
    std::vector<std::atomic<size_t>> errors_;
    std::vector<std::atomic<size_t>> unresolved_tokens_;
};

/**
 * @brief Every `timer.pacing` element id in @p plan whose own `perUser` is
 *        `false` (issue #1570) - what `ScenarioLoadState` sizes its
 *        `SharedPacingClocks` from, so the plan-scanning stays with the one
 *        type that already knows `CompiledElement`'s shape rather than
 *        leaking into `elements.hpp`'s deliberately plan-agnostic clock
 *        primitive.
 */
[[nodiscard]] std::vector<std::string> shared_pacing_element_ids (const ScenarioPlan& plan);

/**
 * @brief Per-step, per-element pass/fail/skip tallies for a load run's report
 *        (issue #1495) - `scenario.steps[i].elements[] = { id, kind, passed,
 *        failed, skipped }`, the load-path sibling of the sequential run's
 *        per-step `elements` trace.
 *
 * Sized once at construction from the plan's already-compiled `elements` per
 * step, so recording is a lookup by element id into a fixed-size atomic array
 * - no lock and no allocation on the completion path. `passed` is an `"ok"`
 * outcome; `failed` folds in `"error"`; `skipped` folds in `"missing"` (no
 * kind reports it yet) beside `"skipped"` itself - the report answers "did
 * this run's steps see this element pass", not which of two failure shapes it
 * was, matching `scenario.steps[i].elements`'s own three-bucket shape from
 * #1512's Model section.
 */
class StepElementTallies {
    public:
    explicit StepElementTallies (const ScenarioPlan& plan);

    /// A no-op for a step or an element id this run's plan does not have -
    /// the pipeline runs no element outside a step's own compiled list, so
    /// this only guards against a caller passing the wrong step index.
    void record (size_t step, const std::string& element_id, const std::string& status);

    /// This step's `elements` array, or an empty one for a step with no
    /// compiled elements or none that ever ran - the same "absent when
    /// nothing happened" convention `unresolvedTokens` and `tests` follow.
    [[nodiscard]] nlohmann::json build (const ScenarioPlan& plan, size_t step) const;

    /// Summed passed/failed across every step, for elements whose kind is
    /// `assert.*` - the declarative half of issue #1497's combined assertion
    /// tally. A `script.*` element's own outcome is not a `pass/fail` of its
    /// assertions (see `script_kinds.cpp`'s file comment) and is deliberately
    /// excluded here; its `pm.test` calls are tallied separately, on
    /// `ScenarioLoadState::inline_script_tests_passed` /
    /// `_failed`.
    [[nodiscard]] AssertionTotals assertion_totals (const ScenarioPlan& plan) const;

    private:
    struct Counts {
        std::atomic<size_t> passed{ 0 };
        std::atomic<size_t> failed{ 0 };
        std::atomic<size_t> skipped{ 0 };
    };
    std::vector<std::vector<Counts>> counts_by_step_;
    std::vector<std::unordered_map<std::string, size_t>> index_of_id_by_step_;
};

/**
 * @brief The `steps` array of the run summary's `scenario` object.
 *
 * One entry per plan step, in plan order, carrying the step's identity beside
 * its numbers - a breakdown indexed only by position is unreadable next to a
 * 40-step sequence.
 */
[[nodiscard]] nlohmann::json build_step_breakdown (const ScenarioPlan& plan,
const StepHistograms& steps,
const StepElementTallies& elements);

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
    ScenarioLoadState (const ScenarioPlan& plan,
    size_t virtual_users,
    CoverageTally coverage,
    vayu::http::routes::ScriptVariableScopes base_scopes,
    vayu::runtime::ScriptConfig script_config)
    : steps (plan.steps.size ()), element_tallies (plan),
      shared_pacing (shared_pacing_element_ids (plan)),
      base_scopes (std::move (base_scopes)),
      base_vars (vayu::http::routes::flatten_variable_scopes (this->base_scopes)),
      script_config (script_config), coverage (std::move (coverage)),
      virtual_users (virtual_users) {
    }

    StepHistograms steps;
    /// Per-step, per-element pass/fail/skip tallies (issue #1495), written by
    /// the same completion that writes `steps` above - see the class comment.
    StepElementTallies element_tallies;
    /// This run's cross-VU pacing clocks (issue #1570) - empty (and free) for
    /// a plan with no `timer.pacing(perUser: false)` element at all.
    SharedPacingClocks shared_pacing;
    /// Combined pass/fail of every `pm.test` call an *inline* `script.pre` or
    /// `script.post` element made this run (issue #1497). `element_tallies`
    /// above already records that element's own outcome - did the script run
    /// without throwing - which is a different question from whether its own
    /// assertions passed (`script_kinds.cpp`'s file comment: "a script's own
    /// `pm.test` assertions travel inside that `ScriptResult` untouched").
    /// Nothing read those before this run's `maxAssertionFailureRatePct`; a
    /// deferred (non-inline) script's tests are counted separately, in the
    /// post-run replay's `ScriptValidationTotals`.
    std::atomic<size_t> inline_script_tests_passed{ 0 };
    std::atomic<size_t> inline_script_tests_failed{ 0 };
    /**
     * This run's shared variable scopes (issue #1495) - the same shape and
     * source a design send's would be, loaded once here rather than per
     * submission. An inline `script.*` element materializes a per-VU copy of
     * this through `VirtualUser::scope_overlay` before running; never mutated
     * directly - a load run's writes are all per-VU, on the overlay, which is
     * the isolation this issue exists to add.
     */
    vayu::http::routes::ScriptVariableScopes base_scopes;
    /**
     * @ref base_scopes, flattened once: every submission's residual-token
     * pass starts from a copy of this map plus its own VU's small
     * `ScopeOverlay`, rather than re-walking the collection-ancestor chain
     * per submission the way a design send's single exchange does.
     */
    vayu::http::VariableValues base_vars;
    /// This run's script configuration (timeout, memory, stack, console,
    /// `pm.sendRequest`), resolved once and handed to
    /// `vayu::http::routes::script_engine_for_this_thread` by every inline
    /// `script.*` element - never re-read from `Database` per step.
    vayu::runtime::ScriptConfig script_config;
    /**
     * Contract coverage (issue #629), written by every completion callback.
     *
     * Here rather than derived from the run's stored samples because it must be
     * **exact**: `results[]` is a bounded reservoir under load, and coverage
     * computed from it would report a contract as uncovered whenever the store
     * happened to thin the only request that touched it. One relaxed atomic
     * increment per completion is what that costs.
     *
     * Inactive - recording and building nothing - for a run of a collection that
     * is not bound to a contract.
     */
    CoverageTally coverage;
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
 * @brief The `coverage` object a scenario load run stores in `runs.summary`,
 *        or an empty one for a run not measured against a contract (issue #629).
 *
 * A sibling of `build_scenario_load_summary` rather than a member of it because
 * coverage is a top-level report section, not part of what the sequence did -
 * the design-mode payload places it the same way.
 */
[[nodiscard]] nlohmann::json build_scenario_load_coverage (const ScenarioLoadState& state);

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
const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
const ScenarioExecution& execution);

} // namespace vayu::core
