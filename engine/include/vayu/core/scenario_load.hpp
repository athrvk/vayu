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
#include "vayu/core/scenario_runner.hpp"
#include "vayu/core/threshold_eval.hpp"
#include "vayu/core/transaction_histograms.hpp"
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
 * @brief The first element kind in @p plan that a scenario load run cannot
 *        honour, or `nullopt` when it carries none.
 *
 * `control.switch` and `control.loop` (issue #1515) needed this refusal
 * until #1569 gave the load path its own jump/repeat mechanism
 * (`ScenarioLoadState::step_index`, `VirtualUser::steps_this_iteration`);
 * neither kind sets the registry's `jumps_or_repeats` flag any more, so this
 * reads as "nothing today" and exists for a future kind that jumps in a way
 * the load path genuinely cannot support yet - refusing such a plan with a
 * `400` naming the kind, before its row exists, rather than silently running
 * it once and ignoring what it asked for.
 */
[[nodiscard]] std::optional<std::string> find_load_incompatible_controller (
const ScenarioPlan& plan);

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
// Deliberate: the implicit default constructor default-constructs `rng`
// below as a placeholder; nothing ever reads it unseeded, since
// `derive_vu_rng` always overwrites it with the run's real seed before this
// VU is used.
// NOLINTNEXTLINE(bugprone-random-generator-seed)
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
    /// Whether `step` is 0 because this VU is *starting* a new iteration, as
    /// opposed to a `control.loop` jump that landed back on plan position 0
    /// mid-iteration (issue #1569) - `take_ready_vu` claims a new iteration
    /// (the run-wide budget, a fresh data row) only when this is true, and
    /// `finish_step` is the only writer: `true` only in its own
    /// "end this iteration" branch, so a mid-iteration jump - to position 0
    /// or anywhere else - never claims a second iteration for the one it is
    /// still inside of.
    bool iteration_boundary = true;
    /// 0-based, and only ever advanced by this VU.
    size_t iteration = 0;
    /**
     * libcurl's own lines for this VU alone, replaced wholesale by each
     * completion and cleared at every iteration boundary. Replaced rather than
     * merged because the captured list is the whole jar the handle held, so
     * merging would resurrect a cookie the server deleted by expiring it. A
     * VU's steps never overlap, which is why no delta is needed here
     * (`CookieJar::reconcile` is the shared jar's).
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
     * earlier step, read by the residual-token pass before every later
     * step's send. Its environment, collection and globals entries outlive
     * the iteration that wrote them (#3044), so a `control.once` login's
     * token reaches every later iteration; only its run-local scope is
     * cleared at the boundary `cookies` is. Written and read under the
     * same `busy` acquire/release pairing the struct comment describes; no
     * VU-local lock is needed for the same reason none is needed for
     * `cookies`.
     */
    vayu::http::routes::ScopeOverlay scope_overlay;
    /**
     * Steady-clock milliseconds before which `take_ready_vu` will not select
     * this VU (issue #1495): `run_step_between`'s `timer.think` wait and
     * `schedule_next_entry_wait`'s `timer.pacing` schedule (both issue #1498)
     * are its two writers, both running on the strategy thread rather than
     * blocking a worker one. While this holds a future value the VU is
     * deferred, not in flight - `maintain_concurrency`'s `deferred_wait_ms`
     * bounds the producer's wait to the soonest such deadline instead of
     * busy-spinning on it (issue #1596). See `docs/engine/elements.md`'s Load
     * paths section.
     */
    int64_t ready_at_ms = 0;
    /**
     * This VU's own count for `control.once` / `control.throughput` /
     * `control.transaction` (issue #1515), on the same isolation
     * `scope_overlay` gives an inline `extract.*` write - one VU's count is
     * never another's. Never cleared at an iteration boundary the way
     * `cookies` is: `control.once` must survive every iteration of this VU's
     * life, and `control.transaction`'s own
     * per-iteration accumulator keys itself with the iteration number
     * instead, so a pass the run's end interrupted is orphaned rather than
     * misread (every other way out of an iteration closes it, #3054).
     */
    std::unordered_map<std::string, int64_t> controller_state;
    /// How many steps this VU has executed within its current iteration
    /// (issue #1569) - the load path's own guard against a `control.switch`
    /// cycle or a misconfigured `control.loop`, mirroring the sequential
    /// run's `maxStepsPerIteration`. Reset to 0 at the same iteration
    /// boundary `cookies` is.
    size_t steps_this_iteration = 0;
    /// The plan positions this VU most recently executed in its current
    /// iteration, oldest first and at most `CYCLE_TRAIL_LENGTH`: what the
    /// `maxStepsPerIteration` error names (#2974). Positions rather than
    /// names, so the per-step bookkeeping copies no string; cleared at the
    /// same boundary as `steps_this_iteration`, keeping its capacity.
    std::vector<size_t> recent_steps;
    /// Per-node "when did this node last start" state for this VU's own
    /// `timer.pacing` elements (issue #1498), keyed by element id - the
    /// load-path sibling of `RunContext::pacing_state`'s sequential-run
    /// version. Cleared at no boundary (unlike `cookies`):
    /// pacing measures across iterations by design, not within one.
    std::unordered_map<std::string, int64_t> pacing_state;
    /// This VU's own generator (issue #1498), derived once at construction
    /// from the run's seed - see `derive_vu_rng`. Default-constructed here as
    /// a placeholder (see the struct's own `NOLINT` above); never read before
    /// `derive_vu_rng` overwrites it.
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
    /// A step that got no response: the transfer raised an error (booked
    /// under status 0, as the run's own distribution does), or the step was
    /// never sent. Counts as executed, so it is not paired with `record`.
    void record_error (size_t step);
    /// A step that sent nothing and is still `errored` rather than `skipped`:
    /// one a controller skipped whose pre-request script threw (#2947), or
    /// whose jump the run could not honour (#2974). Counts as executed and
    /// nothing else.
    void record_unsent (size_t step);
    /// The duration of a no-response step whose transfer ran (a timeout, a
    /// reset; #2384). Paired with `record_error`, which already counted the
    /// step; touches only the histogram, so the step's percentiles cover the
    /// same attempts the run's do.
    void record_failed_transfer (size_t step, double latency_ms);
    /// A response whose status is outside 2xx/3xx (#2134). Paired with
    /// `record`, which already counted the step as executed; touches only the
    /// error tally, because the response still arrived and its latency is real.
    void record_failed_status (size_t step);
    /// One submission of this step whose bound request still carried a
    /// `{{token}}` composition never resolved (issue #1503) - counted, not
    /// refused, because a literal `{{` can be deliberate in a body.
    void record_unresolved_token (size_t step);

    [[nodiscard]] size_t step_count () const {
        return histograms_.size ();
    }
    [[nodiscard]] size_t completed (size_t step) const;
    /// `http_errors + no_response`: the one error definition
    /// (`vayu::count_status_failures`) applied to this step.
    [[nodiscard]] size_t errors (size_t step) const;
    [[nodiscard]] size_t http_errors (size_t step) const;
    [[nodiscard]] size_t no_response (size_t step) const;
    [[nodiscard]] size_t unresolved_tokens (size_t step) const;
    /// How many durations the step's histogram holds: `completed` less the
    /// steps that never reached the wire.
    [[nodiscard]] size_t latency_samples (size_t step) const;
    [[nodiscard]] MetricsCollector::Percentiles percentiles (size_t step) const;

    private:
    void record_latency (size_t step, double latency_ms);

    std::vector<struct hdr_histogram*> histograms_;
    /// Per step, so the breakdown can say "this step ran N times, M of them
    /// failed" - a p99 over a step that only two VUs ever reached is a number
    /// the reader has to be able to discount.
    std::vector<std::atomic<size_t>> completed_;
    std::vector<std::atomic<size_t>> http_errors_;
    std::vector<std::atomic<size_t>> no_response_;
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
 * @brief Every `timer.throughput` element id in @p plan whose own `perUser`
 *        is `false` (issue #1571) - what `ScenarioLoadState` sizes its
 *        `SharedThroughputBudgets` from, the rate-based sibling of
 *        `shared_pacing_element_ids` above and scoped here for the same
 *        reason. Note the opposite default: `perUser` is absent on most
 *        `timer.throughput` elements precisely because a shared rate is what
 *        that kind is normally asked for.
 */
[[nodiscard]] std::vector<std::string> shared_throughput_element_ids (
const ScenarioPlan& plan);

/**
 * @brief Per-step, per-element pass/fail/skip/defer tallies for a load run's
 *        report (issue #1495) - `scenario.steps[i].elements[] = { id, kind,
 *        passed, failed, skipped, deferred }`, the load-path sibling of the
 *        sequential run's per-step `elements` trace.
 *
 * Sized once at construction from the plan's already-compiled `elements` per
 * step, so recording is a lookup by element id into a fixed-size atomic array
 * - no lock and no allocation on the completion path. The buckets are
 * `ElementOutcomeCounts::record`'s, shared with `RequestElementTallies`:
 * `failed` folds in `"error"`, `skipped` folds in `"missing"` (an extractor's
 * miss, or a `metric.record` with nothing to read), and a `script.*` element
 * left to the post-run replay is `deferred`, not `skipped` (#2144), because it
 * does run, later. Beside them, one count per step of the outcomes
 * `is_extractor_miss` names (#3053).
 */
class StepElementTallies {
    public:
    explicit StepElementTallies (const ScenarioPlan& plan);

    /// A no-op for a step or an element id this run's plan does not have -
    /// the pipeline runs no element outside a step's own compiled list, so
    /// this only guards against a caller passing the wrong step index.
    void record (size_t step, const ElementOutcome& outcome);

    /// This step's `elements` array, or an empty one for a step with no
    /// compiled elements or none that ever ran - the same "absent when
    /// nothing happened" convention `unresolvedTokens` and `tests` follow.
    [[nodiscard]] nlohmann::json build (const ScenarioPlan& plan, size_t step) const;

    /// This step's extractor misses across every virtual user and iteration;
    /// 0 for a step index the plan does not have.
    [[nodiscard]] size_t extractor_misses (size_t step) const;

    private:
    std::vector<std::vector<ElementOutcomeCounts>> counts_by_step_;
    /// Sized once, like the counts beside it, so recording never reallocates.
    std::vector<std::atomic<size_t>> misses_by_step_;
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
const StepElementTallies& elements,
ScriptsOverrideMode scripts_mode);

/// A plan step's identity as the live gate frame names it (#2823).
struct ScenarioStepLabel {
    size_t index = 0;
    std::string name;
};

/// Every step's label, in plan order.
[[nodiscard]] std::vector<ScenarioStepLabel> scenario_step_labels (const ScenarioPlan& plan);

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
    : steps (plan.steps.size ()), step_labels (scenario_step_labels (plan)),
      element_spans (compute_element_spans (plan)), transactions (plan),
      element_tallies (plan), step_index (build_step_index (plan)),
      shared_throughput (plan), shared_pacing (shared_pacing_element_ids (plan)),
      shared_throughput_budgets (shared_throughput_element_ids (plan)),
      base_scopes (std::move (base_scopes)),
      base_vars (vayu::http::routes::flatten_variable_scopes (this->base_scopes)),
      script_config (script_config), coverage (std::move (coverage)),
      virtual_users (virtual_users) {
    }

    StepHistograms steps;
    /// Copied off the plan and never written again, so the live gate frame
    /// can name the steps without the plan, which retention releases.
    const std::vector<ScenarioStepLabel> step_labels;
    /// The plan-wide first/last position of every scope-spanning element
    /// (issue #1515's `control.transaction` and, since #1569, `control.loop`
    /// too), computed once here.
    std::unordered_map<std::string, ElementSpan> element_spans;
    /// One histogram per declared `control.transaction` name (issue #1515),
    /// allocated up front from the same plan scan `element_spans` is, so
    /// recording into it takes no lock.
    TransactionHistograms transactions;
    /// Steps a `control.if` / `control.once` / `control.throughput` element
    /// skipped before they reached the wire (issue #1515), less those whose
    /// inline `script.pre` threw or whose jump the run could not honour,
    /// which are `errored` (#2947, #2974) - the load
    /// path's own `StepOutcome::Skipped`, read into the summary's
    /// `skipped` key in place of the constant `0` every scenario load run
    /// reported before this.
    std::atomic<size_t> steps_skipped{ 0 };
    /// Step executions whose response arrived and at least one of whose
    /// inline assertions did not hold (#2824): the summary's `failed`, the
    /// sequential run's `StepOutcome::Failed`. Counted once per execution
    /// however many assertions failed in it, and never for a skipped or an
    /// `errored` one, so `passed`, `failed`, `skipped` and `errored` stay
    /// disjoint. A deferred script's tests replay after the run and are not
    /// in it.
    std::atomic<size_t> steps_failed{ 0 };
    /// Per-step, per-element pass/fail/skip tallies (issue #1495), written by
    /// the same completion that writes `steps` above - see the class comment.
    StepElementTallies element_tallies;
    /// Resolves a `control.switch` target or a `control.loop`'s own
    /// folder-start name to a plan position (issue #1569) - the same index
    /// the sequential run's own `resolve_next_step` reads, built once here.
    ScenarioStepIndex step_index;
    /// `maxStepsPerIteration`, resolved once here (issue #1569): a scenario
    /// load run's own guard against a `control.switch` cycle or a
    /// `control.loop` that never reaches its close, on the same config entry
    /// and the same `resolve_max_steps_per_iteration` the sequential run
    /// uses - set by `execute_scenario_load` once `db` is in scope.
    size_t max_steps_per_iteration = 0;
    /// The run's `elements.scripts` mode, copied from `RunContext` by
    /// `execute_scenario_load` so the summary can tell a `script.pre` that
    /// ran inline from one left behind (issue #1938) without the context.
    ScriptsOverrideMode scripts_mode = ScriptsOverrideMode::AsMarked;
    /// One shared counter pair per `control.throughput` element whose config
    /// asked to share it across every virtual user (issue #1569's
    /// `perUser: false`), allocated up front from the same plan scan
    /// `element_spans` is.
    SharedThroughputCounters shared_throughput;
    /// This run's cross-VU pacing clocks (issue #1570) - empty (and free) for
    /// a plan with no `timer.pacing(perUser: false)` element at all.
    SharedPacingClocks shared_pacing;
    /// This run's cross-VU throughput budgets (issue #1571) - empty (and
    /// free) for a plan with no shared-rate `timer.throughput` element at
    /// all. Named apart from `shared_throughput` above (issue #1569's
    /// `control.throughput` counters): a percentage-of-passes budget and a
    /// token-bucket rate are different primitives that happen to share a
    /// kind-name prefix.
    SharedThroughputBudgets shared_throughput_budgets;
    /// Pass/fail of every test result a step's pipeline produced this run
    /// (issue #1497): an `assert.*` outcome, a required `extract.*` miss and
    /// an *inline* script's `pm.test` call, as each appends to the step's
    /// script results. `element_tallies` above records one outcome per
    /// element, which for a script is whether it ran cleanly, not how its
    /// `pm.test` calls went (`script_kinds.cpp`'s file comment). A deferred
    /// script's tests are the post-run replay's `ScriptValidationTotals`.
    /// `exact_assertion_totals` reads these (#2892).
    std::atomic<size_t> inline_tests_passed{ 0 };
    std::atomic<size_t> inline_tests_failed{ 0 };
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
    /// How many iterations were ever begun. The producer thread is the only
    /// writer; atomic because the metrics thread reads it for the live gate
    /// frame (#2823), so relaxed on both sides.
    std::atomic<size_t> iterations_started{ 0 };
    /// Rows this run was given; 0 for a run sent without `data`.
    size_t data_row_count = 0;
    /**
     * The run's shared row cursor: one claim per *iteration*, across every
     * virtual user, wrapping when the rows run out.
     *
     * Shared rather than per-VU because that is the semantics that makes
     * distinct-credentials-per-user work - two VUs must not both get row 0 -
     * and it is k6's `iterationInTest` / JMeter's "All threads" parity. Plain,
     * not atomic: the strategy thread is the sole producer, `take_ready_vu` is
     * the only claimer and nothing else reads it, so the claim costs an
     * increment rather than a locked one.
     */
    size_t data_cursor = 0;
    std::atomic<size_t> iterations_completed{ 0 };
    /// Iterations a step that got no response, or a jump this run could not
    /// honour, ended before the plan's last step. Counted rather than folded
    /// into `completed`, since a run that abandoned most of its iterations has
    /// a per-step breakdown that thins towards the end and nothing else would
    /// say why.
    std::atomic<size_t> iterations_abandoned{ 0 };
    std::atomic<size_t> steps_executed{ 0 };
    /// The summary's `errored`: executions that got no response or set a
    /// jump the run could not honour (#2974), which end their iteration, and
    /// executions whose inline `script.pre` or `script.post` threw (#2947),
    /// which do not. So it is not the sum of the steps' `noResponse`;
    /// `iterations_abandoned` is the abort count.
    std::atomic<size_t> steps_errored{ 0 };
};

/**
 * @brief The `scenario` object a scenario load run stores in `runs.summary`.
 *
 * Shares `iterations`, `iterations_completed`, `steps_executed` and the four
 * outcomes with the design-mode payload (`build_scenario_summary_payload`) so
 * the report route reads one shape for both run kinds, under one definition
 * (#2824): `passed + failed + skipped + errored == steps_executed`, and
 * `steps_executed` is every step reached, skipped ones included.
 * `virtual_users`, `abandoned` and `steps` are this mode's own.
 */
[[nodiscard]] nlohmann::json
build_scenario_load_summary (const ScenarioLoadState& state, const ScenarioPlan& plan);

/**
 * @brief The `scenario` object a live gate frame carries for a scenario load
 *        run (#2823): `{iterations, iterationsCompleted, iterationsAbandoned,
 *        stepsExecuted, steps: [{index, name, executed, errors}]}`.
 *
 * Built while the workers still write, so it reads only relaxed atomics and the
 * immutable `step_labels`, never a step's histogram (`percentiles`,
 * `latency_samples`), whose plain hdr reads would race the workers. The counts
 * are the same counters `build_scenario_load_summary` reads, so a frame built
 * after the drain says what the summary does.
 */
[[nodiscard]] nlohmann::json build_scenario_live_progress (const ScenarioLoadState& state);

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
 * Every path leaves the run drainable: a step that got no response ends its VU's
 * iteration and the VU starts the next one rather than being stranded - a stranded VU
 * permanently shrinks effective concurrency, the same failure `handle_result`'s
 * error branch already guards against.
 *
 * @param base_scopes The run's scopes, already loaded and already run through
 *        `script.setup` (#1499) by `execute_load_test` - loaded there rather
 *        than here so a setup script's own time is spent before `test_start`
 *        is captured, never inside the run's own duration figures.
 */
[[nodiscard]] std::shared_ptr<ScenarioLoadState> execute_scenario_load (
const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
const ScenarioExecution& execution,
vayu::http::routes::ScriptVariableScopes base_scopes);

} // namespace vayu::core
