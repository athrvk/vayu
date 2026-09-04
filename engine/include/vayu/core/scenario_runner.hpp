#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/scenario_runner.hpp
 * @brief The design-mode sequential runner: one pass over a `ScenarioPlan` per
 *        iteration, step by step, through `http::Client` (issue #353).
 *
 * The plan is shared with the load path; the executor is not, and that
 * divergence is the design. A scenario step needs the environment cookie jar
 * and an inline per-step script, and the event loop deliberately has neither
 * (see `http/cookie_jar.hpp`, "Not on the load path"), so a step is exactly the
 * `POST /execute` exchange - `http::routes::execute_exchange` - rather than a
 * copy of it.
 *
 * The *lifecycle* is a load run's: `POST /runs` answers `202 {runId}`, the run
 * is registered, retained, swept, stopped and reported by the machinery that
 * already exists, and its `step` events ride the same bounded tick ring as a
 * load run's `metrics` events so `Last-Event-ID` resume works unchanged.
 */

#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

/**
 * @brief How one step execution ended.
 *
 * All four exist from the start even though nothing produces `Skipped` until
 * flow control lands (phase 4): the summary and the SSE wire shape must not
 * need widening later, and a skipped step counted as a pass is precisely the
 * false-pass class issue #180 exists to eliminate.
 *
 * `Failed` is an assertion that did not hold - the request itself completed, so
 * the iteration continues. `Errored` is the step not completing at all (a
 * transport failure, a timeout, a script that threw), and ends its iteration.
 */
enum class StepOutcome : std::uint8_t { Passed, Failed, Skipped, Errored };

[[nodiscard]] const char* to_string (StepOutcome outcome);

/**
 * @brief How many assertions one step's scripts made, and how many held.
 *
 * The itemized list rides the stored trace's `scripts` node and nothing else -
 * it is unbounded in the number of `pm.test` calls a script can make, and the
 * SSE tick ring is a fixed-size buffer every watcher of the run replays. Two
 * numbers are constant-size, so a step being watched can say "3 passed, 1
 * failed" as it streams while the list itself waits for the stored row.
 *
 * Counted from **both scripts**, exactly the assertions
 * `build_script_result_node` serializes (issue #810), so the live tally and the
 * stored list count the same things rather than disagreeing by one script's
 * worth - which they did while the node listed the post-request script alone
 * and `describe_failed_tests` failed steps on either.
 */
struct StepTestTally {
    size_t passed = 0;
    size_t failed = 0;
};

/** One step execution, on its way to a `results` row and an SSE event. */
struct StepRecord {
    size_t iteration  = 0; ///< 0-based, as `pm.info.iteration` reports it.
    size_t step_index = 0; ///< Position in the plan.
    /**
     * Which `data` row this iteration bound, or absent for a run without one.
     *
     * Carried on every record because the wrap must not be silent (issue
     * #356): with `iterations` above the row count, iteration 4 of a 3-row set
     * reads row 1, and "which row produced this" is otherwise unanswerable
     * from a run's stored steps.
     */
    std::optional<size_t> data_row_index;
    std::string step_name;
    std::string request_id;
    StepOutcome outcome = StepOutcome::Passed;
    int status_code     = 0;
    std::string status_text;
    double latency_ms = 0.0;
    /// Transport error, script error or failed-assertion summary; "" on a pass.
    std::string error;
    /**
     * What this step's response amounted to against the contract (issue #681).
     *
     * Absent - not an unchecked verdict - for a step of a collection bound to no
     * document, and for a step that sent nothing: a response nobody made was not
     * judged against a contract, and neither was one nobody was measuring. Every
     * other step carries a verdict, `checked: false` and a reason included.
     */
    std::optional<ValidationVerdict> validation;
    /**
     * What this step's assertions amounted to (issue #724), for the SSE frame.
     *
     * Absent - not a pair of zeros - for a step whose test script made no
     * assertion at all, and for one that never ran a script: "asserted nothing"
     * and "every assertion held" are different facts, and only the second is a
     * step that proved something.
     */
    std::optional<StepTestTally> tests;
    /// The design-mode trace (`build_result_trace`) plus this step's identity.
    nlohmann::json trace;
};

/**
 * @brief The per-step `results` rows a scenario run keeps, bounded.
 *
 * `Database::get_results` loads every row of a run with no limit and the report
 * parses each `trace_data`, which the dashboard polls - so a 200-step by
 * 500-iteration run would make the report path quadratic in what it stores.
 * The bound is biased the way `maxStoredErrors` is, and the bias is the point:
 * **every step that did not pass is kept first**, successes fill what remains,
 * and a step displaced (or refused) is counted so the run can disclose it
 * rather than presenting a thinned set as complete.
 *
 * Capacity 0 means unlimited, matching `maxStoredErrors`' convention.
 */
class ScenarioStepStore {
    public:
    explicit ScenarioStepStore (size_t capacity) : capacity_ (capacity) {
    }

    /**
     * Offer one row. @p kept_first marks a step that did not pass; when the
     * store is full such a row displaces the most recently kept success, so the
     * successes that survive are a run's opening rather than a random slice.
     */
    void add (vayu::db::Result result, bool kept_first);

    /** Every kept row, back in execution order. Leaves the store empty. */
    [[nodiscard]] std::vector<vayu::db::Result> take ();

    /** Rows the cap refused or displaced. */
    [[nodiscard]] size_t dropped () const {
        return dropped_;
    }

    [[nodiscard]] size_t stored () const {
        return kept_first_.size () + fillers_.size ();
    }

    private:
    struct Entry {
        size_t sequence = 0;
        vayu::db::Result result;
    };

    size_t capacity_ = 0;
    size_t sequence_ = 0;
    size_t dropped_  = 0;
    std::vector<Entry> kept_first_;
    std::vector<Entry> fillers_;
};

/**
 * @brief Every position one key - a step name or a request id - occupies in the
 *        plan.
 *
 * Names are not unique - two requests in the same collection may share one, and
 * nothing in the schema prevents it - so the value is a list rather than an
 * index. That list is what makes an ambiguous `setNextRequest` target a named
 * error instead of a silent jump to whichever one resolution happened to see
 * first. Ids are unique by the schema, and are held in the same shape so an
 * impossible duplicate is refused the same way rather than resolved by
 * whichever the walk saw first.
 */
using ScenarioStepPositions = std::unordered_map<std::string, std::vector<size_t>>;

/**
 * @brief The two keys a `setNextRequest` target may be, indexed once per run.
 *
 * Postman documents both spellings - a request's name, and the id a script
 * reads off `pm.info.requestId` - so a target that is neither is what makes the
 * step fail (issue #1006).
 */
struct ScenarioStepIndex {
    ScenarioStepPositions by_name;
    ScenarioStepPositions by_request_id;
};

/** Build that index once per run; positions are indices into `plan.steps`. */
[[nodiscard]] ScenarioStepIndex build_step_index (const ScenarioPlan& plan);

/** Where a `setNextRequest` target points, or why it points nowhere. */
struct NextStepResolution {
    enum class Kind : std::uint8_t {
        Unresolved,  ///< Nothing answers to the target; `error` says why.
        Step,        ///< Continue the iteration at `index`.
        EndIteration ///< The target was the stop form; this iteration is over.
    };
    Kind kind    = Kind::Unresolved;
    size_t index = 0;
    /// Caller-facing sentence, on the `Unresolved` path only. It reaches the
    /// step's `results.error` and the app's step list, so it names the target
    /// and, for an ambiguous one, every step that answers to it.
    std::string error;
};

/**
 * @brief Resolve a `setNextRequest` target against the plan.
 *
 * Resolution order, and the order is the contract: the stop form `"null"`
 * first, then names, then request ids. A step actually *named* `null` wins over
 * the stop form - a name the run carries is the more specific answer, and the
 * alternative is a step nothing can ever jump to.
 *
 * Both failures are loud by design (issue #355): a target no step answers to is
 * a script pointing at a request that is not in the run, and a duplicated name
 * is ambiguous - continuing past either would run a sequence nobody asked for.
 */
[[nodiscard]] NextStepResolution
resolve_next_step (const ScenarioStepIndex& index, const std::string& target);

/**
 * @brief How many step executions one iteration may perform.
 *
 * `setNextRequest` makes an infinite loop a two-line script, and the bound is
 * what keeps such a run reaching a terminal status instead of sending forever.
 *
 * @param configured `maxStepsPerIteration`; `0` (the default) derives the bound
 *                   from the plan, because the useful ceiling is a multiple of
 *                   the sequence's own length rather than a fixed number.
 * @param plan_steps The plan's size, so a straight-through iteration - which
 *                   executes exactly that many steps - can never trip it.
 */
[[nodiscard]] size_t resolve_max_steps_per_iteration (int configured, size_t plan_steps);

/**
 * @brief Wrap one step as a wire-ready SSE `step` event, tagged with
 *        `id: <offset>` for `Last-Event-ID` resume.
 *
 * Sits beside `build_tick_payload`'s `metrics` events in the same ring and uses
 * the same monotonic offsets, so a consumer that resumes mid-run replays both
 * kinds in the order they happened. Extracted for testing.
 */
[[nodiscard]] std::string build_step_payload (const StepRecord& record, size_t offset);

/**
 * @brief The `plan` event's data: the size a sequential run resolved to
 *        (issue #1398).
 *
 * Published once, ahead of the first `step` frame, because this side is the
 * only one that can resolve it - a client sends no step count precisely so
 * that the rule has one copy - and a watcher with no denominator can only
 * paint an indeterminate bar.
 *
 * `stepsExpected` is an upper bound rather than a promise, on the same terms
 * as the load path's `requestsExpected`: an errored step ends its iteration,
 * `POST /runs/:id/stop` ends the run, `setNextRequest` can walk an iteration
 * in fewer steps than the plan holds, and the `maxStepsPerIteration` cap can
 * end one that walks in more. Extracted for testing.
 */
[[nodiscard]] nlohmann::json build_plan_data (size_t steps_per_iteration, size_t iterations);

/**
 * @brief Read `failOnSchemaError` off a `POST /runs` payload (issue #681).
 *
 * Default false, and the default is the decision: a schema verdict is its own
 * channel, so a response that does not match what the document declares says
 * something about the *contract* rather than about the assertion the step made.
 * A run that wants the contract to be a gate says so, and then only a step that
 * passed everything else is failed by it - a step already failing an assertion
 * keeps the error that named it.
 *
 * Type-checked by `validate_run_config` before the run row exists, so anything
 * reaching here is a boolean or absent.
 */
[[nodiscard]] bool read_fail_on_schema_error (const nlohmann::json& config);

/**
 * @brief The `results.error` sentence a schema failure produces, for a run that
 *        asked schema failures to fail their step.
 *
 * Names the first problem, exactly as `describe_failed_tests` names the first
 * failed assertion and for the same reason: the step list is all a reader has,
 * and "3 problems" without one of them names nothing to go and look at.
 */
[[nodiscard]] std::string describe_schema_failure (const ValidationVerdict& verdict);

/** What a scenario run reports about itself once it has finished. */
struct ScenarioSummaryInputs {
    size_t iterations_requested = 0;
    size_t iterations_completed = 0;
    size_t steps_executed       = 0;
    size_t passed               = 0;
    size_t failed               = 0;
    size_t skipped              = 0;
    size_t errored              = 0;
    size_t steps_stored         = 0;
    size_t steps_dropped        = 0;
    double duration_s           = 0.0;
    /**
     * The run's contract coverage (issue #629), already in the report's shape.
     *
     * Empty for every run that was not measured against a contract, which is
     * what leaves the section out of the summary entirely - a run of an unbound
     * collection covered no operations because there were none to cover, and
     * reporting it as zero of zero would read as a contract it failed.
     */
    nlohmann::json coverage = nlohmann::json::object ();
    /**
     * What the run's steps amounted to against their declared schemas (issue
     * #681). Empty for every run that produced no verdict at all, which leaves
     * the section out of the summary on the same terms `coverage` is left out.
     *
     * The load pass's totals (#682), not a second tally beside them: the two run
     * modes write one `schemaValidation` block that one component renders, so
     * "how many responses failed their schema" cannot come to mean two things.
     * What differs is the denominator - every step here, a bounded reservoir
     * there - and the payload says which rather than leaving it to the mode.
     */
    SampledValidationTotals validation;
    /// Whether this run asked a schema failure to fail its step. Recorded
    /// beside the tally because the same counts mean two different things
    /// depending on it: with the flag off, `failed` steps and schema failures
    /// are disjoint facts about the run rather than one.
    bool fail_on_schema_error = false;
};

/**
 * @brief Serialize those results into the object stored in `runs.summary`.
 *
 * `total_requests`, `test_duration` and `rps` are the keys `apply_run_summary`
 * (`http/routes/runs.cpp`) already reads, and they matter here for one specific
 * reason: the report otherwise counts the *stored* rows, which a thinned run
 * would understate. Everything scenario-shaped sits under `scenario`, which the
 * report route surfaces as its own section - the counts have a reader, they are
 * not written into the store to be forgotten.
 */
[[nodiscard]] nlohmann::json build_scenario_summary_payload (
const ScenarioSummaryInputs& inputs);

/**
 * @brief The run worker: every step of every iteration, in plan order.
 *
 * Runs on its own thread, spawned by `RunManager::start_scenario_run`. It
 * reaches a terminal status on every path - a step that errors ends its
 * iteration and the next one still runs; a stop is honoured *between steps*
 * rather than after the whole iteration; an exception fails the run rather than
 * leaving it `running` forever.
 *
 * Variables are loaded once, mutated in memory by every step's scripts, and
 * persisted once at the end: per-step persistence would be N x M diff-and-write
 * cycles against the DB mutex for a value only this run's later steps read.
 */
void execute_scenario_run (const std::shared_ptr<RunContext>& context,
const std::shared_ptr<const ScenarioExecution>& execution,
vayu::db::Database* db_ptr,
vayu::http::CookieJar* cookie_jar,
bool verbose,
RunManager& manager);

} // namespace vayu::core
