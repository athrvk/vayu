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
#include <map>
#include <memory>
#include <nlohmann/json.hpp>
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
enum class StepOutcome { Passed, Failed, Skipped, Errored };

[[nodiscard]] const char* to_string (StepOutcome outcome);

/** One step execution, on its way to a `results` row and an SSE event. */
struct StepRecord {
    size_t iteration  = 0; ///< 0-based, as `pm.info.iteration` reports it.
    size_t step_index = 0; ///< Position in the plan.
    std::string step_name;
    std::string request_id;
    StepOutcome outcome = StepOutcome::Passed;
    int status_code     = 0;
    std::string status_text;
    double latency_ms = 0.0;
    /// Transport error, script error or failed-assertion summary; "" on a pass.
    std::string error;
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
 * @brief Every position a step name occupies in the plan.
 *
 * Names are not unique - two requests in the same collection may share one, and
 * nothing in the schema prevents it - so the value is a list rather than an
 * index. That list is what makes an ambiguous `setNextRequest` target a named
 * error instead of a silent jump to whichever one resolution happened to see
 * first.
 */
using ScenarioStepNameIndex = std::unordered_map<std::string, std::vector<size_t>>;

/** Build that index once per run; positions are indices into `plan.steps`. */
[[nodiscard]] ScenarioStepNameIndex build_step_name_index (const ScenarioPlan& plan);

/** Where a `setNextRequest` target points, or why it points nowhere. */
struct NextStepResolution {
    bool ok      = false;
    size_t index = 0;
    /// Caller-facing sentence, on the failure path only. It reaches the step's
    /// `results.error` and the app's step list, so it names the target and, for
    /// an ambiguous one, every step that answers to it.
    std::string error;
};

/**
 * @brief Resolve a `setNextRequest` target against the plan.
 *
 * Both failures are loud by design (issue #355): a name no step carries is a
 * script pointing at a request that is not in the run, and a duplicated name is
 * ambiguous - continuing past either would run a sequence nobody asked for.
 */
[[nodiscard]] NextStepResolution
resolve_next_step (const ScenarioStepNameIndex& index, const std::string& target);

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
void execute_scenario_run (std::shared_ptr<RunContext> context,
std::shared_ptr<const ScenarioExecution> execution,
vayu::db::Database* db_ptr,
vayu::http::CookieJar* cookie_jar,
bool verbose,
RunManager& manager);

} // namespace vayu::core
