/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/scenario_load.hpp"

#include <algorithm>
#include <chrono>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/core/load_pacing.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/script_parts.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::core {

namespace {

/// The rate fields that put `ConstantLoadStrategy` on its open-loop path. Read
/// through one helper so the validator and the executor cannot disagree about
/// what "asked for a rate" means.
double requested_rps (const nlohmann::json& config) {
    double rps = config.value ("rps", 0.0);
    if (rps == 0.0) {
        rps = config.value ("targetRps", 0.0);
    }
    return rps;
}

/// Steady-clock milliseconds, the same clock `take_ready_vu`'s `ready_at_ms`
/// check and `timer.think`'s own wait are measured against - never
/// `system_clock`, which can step backwards under a load run's wall time.
int64_t steady_now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now ().time_since_epoch ())
    .count ();
}

} // namespace

std::mt19937_64 derive_vu_rng (uint64_t run_seed, size_t vu_index) {
    // A fixed-point splitmix64 round rather than `run_seed ^ vu_index`
    // directly: two adjacent VU indices must not produce two adjacent, highly
    // correlated seeds, which is exactly what XOR-with-a-small-integer would
    // do to `std::mt19937_64`'s seed-sequence input.
    uint64_t mixed = run_seed + (static_cast<uint64_t> (vu_index) * 0x9E3779B97F4A7C15ULL);
    mixed = (mixed ^ (mixed >> 30)) * 0xBF58476D1CE4E5B9ULL;
    mixed = (mixed ^ (mixed >> 27)) * 0x94D049BB133111EBULL;
    mixed = mixed ^ (mixed >> 31);
    return std::mt19937_64{ mixed };
}

bool is_scenario_load_run (const nlohmann::json& config) {
    if (!config.is_object ()) {
        return false;
    }
    const auto scenario = config.find ("scenario");
    if (scenario == config.end () || scenario->is_null ()) {
        return false;
    }
    const auto mode = config.find ("mode");
    return mode != config.end () && mode->is_string () &&
    !mode->get<std::string> ().empty ();
}

std::optional<std::string> find_load_incompatible_controller (const ScenarioPlan& plan) {
    const auto& registry = Registry::instance ();
    for (const auto& step : plan.steps) {
        if (!step.elements) {
            continue;
        }
        for (const auto& element : *step.elements) {
            // Read through the registry's own `jumps_or_repeats`, never a
            // `kind ==` comparison outside `core/elements` (#1512's
            // extensibility contract, rule 1).
            const auto* kind = registry.find (element.kind);
            if (kind != nullptr && kind->jumps_or_repeats) {
                return element.kind;
            }
        }
    }
    return std::nullopt;
}

std::optional<std::string> validate_scenario_load_config (const nlohmann::json& config) {
    const std::string mode = config.value ("mode", std::string{});
    const auto type        = parse_load_test_type (mode);
    if (!type) {
        return "Unknown load mode '" + mode +
        "' for a scenario run - expected 'constant_concurrency', 'ramp_up' or "
        "'iterations'";
    }

    if (*type == LoadTestType::Capacity) {
        return "'capacity' is not available for scenario runs: the search "
               "judges one windowed p99, and a sequence has one per step - "
               "which of them is 'the' latency the knee is measured against is "
               "a question the mode does not answer. Use "
               "'constant_concurrency', 'ramp_up' or 'iterations'.";
    }

    if (*type == LoadTestType::ConstantRps) {
        return "'constant_rps' is not available for scenario runs: an "
               "open-loop "
               "arrival rate over a multi-step sequence is an arrival-rate "
               "executor, which Vayu does not implement. Use "
               "'constant_concurrency', 'ramp_up' or 'iterations' - for a "
               "scenario, 'concurrency' is the number of virtual users.";
    }

    if (requested_rps (config) > 0.0) {
        return "'rps'/'targetRps' is not available for scenario runs: it "
               "selects "
               "an open-loop arrival rate, and a scenario run is closed-loop "
               "by "
               "design. Set 'concurrency' - the number of virtual users - "
               "instead.";
    }

    return std::nullopt;
}

// ============================================================================
// Per-step histograms
// ============================================================================

StepHistograms::StepHistograms (size_t step_count)
: histograms_ (step_count, nullptr), completed_ (step_count),
  errors_ (step_count), unresolved_tokens_ (step_count) {
    for (size_t i = 0; i < step_count; ++i) {
        // Same range and precision as the run's aggregate histogram, so a step's
        // p99 and the whole run's are comparable rather than two resolutions.
        if (hdr_init (1, constants::metrics_collector::HISTOGRAM_MAX_LATENCY_US,
            constants::metrics_collector::HISTOGRAM_SIGNIFICANT_FIGURES,
            &histograms_[i]) != 0 ||
        histograms_[i] == nullptr) {
            for (size_t j = 0; j < i; ++j) {
                hdr_close (histograms_[j]);
            }
            histograms_.clear ();
            throw std::runtime_error (
            "Failed to initialize per-step HdrHistogram for step " + std::to_string (i));
        }
        completed_[i].store (0, std::memory_order_relaxed);
        errors_[i].store (0, std::memory_order_relaxed);
        unresolved_tokens_[i].store (0, std::memory_order_relaxed);
    }
}

StepHistograms::~StepHistograms () {
    for (auto* histogram : histograms_) {
        if (histogram != nullptr) {
            hdr_close (histogram);
        }
    }
}

void StepHistograms::record (size_t step, double latency_ms) {
    if (step >= histograms_.size ()) {
        return;
    }
    completed_[step].fetch_add (1, std::memory_order_relaxed);
    // Microseconds, matching the aggregate histogram's unit. Atomic because
    // every event-loop worker records concurrently - the plain record is a
    // non-atomic read-modify-write on counts[] and loses increments.
    hdr_record_value_atomic (histograms_[step],
    static_cast<int64_t> (std::max (0.0, latency_ms) * 1000.0));
}

void StepHistograms::record_error (size_t step) {
    if (step >= histograms_.size ()) {
        return;
    }
    completed_[step].fetch_add (1, std::memory_order_relaxed);
    errors_[step].fetch_add (1, std::memory_order_relaxed);
}

void StepHistograms::record_unresolved_token (size_t step) {
    if (step >= unresolved_tokens_.size ()) {
        return;
    }
    unresolved_tokens_[step].fetch_add (1, std::memory_order_relaxed);
}

size_t StepHistograms::completed (size_t step) const {
    return step < completed_.size () ? completed_[step].load (std::memory_order_relaxed) : 0;
}

size_t StepHistograms::unresolved_tokens (size_t step) const {
    return step < unresolved_tokens_.size () ?
    unresolved_tokens_[step].load (std::memory_order_relaxed) :
    0;
}

size_t StepHistograms::errors (size_t step) const {
    return step < errors_.size () ? errors_[step].load (std::memory_order_relaxed) : 0;
}

MetricsCollector::Percentiles StepHistograms::percentiles (size_t step) const {
    MetricsCollector::Percentiles p;
    if (step >= histograms_.size () || histograms_[step] == nullptr) {
        return p;
    }
    auto* h = histograms_[step];
    auto ms = [] (int64_t us) { return static_cast<double> (us) / 1000.0; };
    p.p50   = ms (hdr_value_at_percentile (h, 50.0));
    p.p75   = ms (hdr_value_at_percentile (h, 75.0));
    p.p90   = ms (hdr_value_at_percentile (h, 90.0));
    p.p95   = ms (hdr_value_at_percentile (h, 95.0));
    p.p99   = ms (hdr_value_at_percentile (h, 99.0));
    p.p999  = ms (hdr_value_at_percentile (h, 99.9));
    // An empty histogram reports min as INT64_MAX; reporting that as a latency
    // would put a 9.2e15 ms floor on a step no VU ever reached.
    p.min = h->total_count > 0 ? ms (hdr_min (h)) : 0.0;
    p.max = h->total_count > 0 ? ms (hdr_max (h)) : 0.0;
    return p;
}

// ============================================================================
// Cross-VU shared pacing clocks (issue #1570) and rate budgets (issue #1571)
// ============================================================================

namespace {

/// Every enabled element of @p kind in @p plan asking for cross-VU state
/// rather than per-VU (`perUser: false`, whether stated or left to @p
/// per_user_default), deduplicated and in plan order - the one scan both
/// shared primitives are sized from.
std::vector<std::string>
shared_element_ids (const ScenarioPlan& plan, std::string_view kind, bool per_user_default) {
    std::vector<std::string> ids;
    for (const auto& step : plan.steps) {
        if (!step.elements) {
            continue;
        }
        for (const auto& element : *step.elements) {
            if (element.kind != kind || !element.enabled ||
            element.config.value ("perUser", per_user_default)) {
                continue; // per-VU case needs no shared state.
            }
            if (std::find (ids.begin (), ids.end (), element.id) == ids.end ()) {
                ids.push_back (element.id);
            }
        }
    }
    return ids;
}

} // namespace

std::vector<std::string> shared_pacing_element_ids (const ScenarioPlan& plan) {
    return shared_element_ids (plan, "timer.pacing", /*per_user_default=*/true);
}

std::vector<std::string> shared_throughput_element_ids (const ScenarioPlan& plan) {
    return shared_element_ids (plan, "timer.throughput", /*per_user_default=*/false);
}

StepElementTallies::StepElementTallies (const ScenarioPlan& plan) {
    counts_by_step_.reserve (plan.steps.size ());
    index_of_id_by_step_.reserve (plan.steps.size ());
    for (const auto& step : plan.steps) {
        std::unordered_map<std::string, size_t> index_of_id;
        size_t element_count = 0;
        if (step.elements) {
            element_count = step.elements->size ();
            index_of_id.reserve (element_count);
            for (size_t i = 0; i < element_count; ++i) {
                index_of_id[(*step.elements)[i].id] = i;
            }
        }
        counts_by_step_.emplace_back (element_count);
        index_of_id_by_step_.push_back (std::move (index_of_id));
    }
}

void StepElementTallies::record (size_t step,
const std::string& element_id,
const std::string& status) {
    if (step >= index_of_id_by_step_.size ()) {
        return;
    }
    const auto found = index_of_id_by_step_[step].find (element_id);
    if (found == index_of_id_by_step_[step].end ()) {
        return;
    }
    Counts& counts = counts_by_step_[step][found->second];
    if (status == "ok") {
        counts.passed.fetch_add (1, std::memory_order_relaxed);
    } else if (status == "failed" || status == "error") {
        counts.failed.fetch_add (1, std::memory_order_relaxed);
    } else { // "skipped" | "missing"
        counts.skipped.fetch_add (1, std::memory_order_relaxed);
    }
}

nlohmann::json StepElementTallies::build (const ScenarioPlan& plan, size_t step) const {
    nlohmann::json array = nlohmann::json::array ();
    if (step >= counts_by_step_.size () || !plan.steps[step].elements) {
        return array;
    }
    const auto& elements = *plan.steps[step].elements;
    const auto& counts   = counts_by_step_[step];
    const size_t count   = std::min (elements.size (), counts.size ());
    for (size_t i = 0; i < count; ++i) {
        const size_t passed = counts[i].passed.load (std::memory_order_relaxed);
        const size_t failed = counts[i].failed.load (std::memory_order_relaxed);
        const size_t skipped = counts[i].skipped.load (std::memory_order_relaxed);
        if (passed + failed + skipped == 0) {
            continue; // never ran under this run - omitted, not a row of zeros
        }
        array.push_back ({ { "id", elements[i].id }, { "kind", elements[i].kind },
        { "passed", passed }, { "failed", failed }, { "skipped", skipped } });
    }
    return array;
}

AssertionTotals StepElementTallies::assertion_totals (const ScenarioPlan& plan) const {
    AssertionTotals totals;
    const size_t step_count = std::min (plan.steps.size (), counts_by_step_.size ());
    for (size_t step = 0; step < step_count; ++step) {
        if (!plan.steps[step].elements) {
            continue;
        }
        const auto& elements = *plan.steps[step].elements;
        const auto& counts   = counts_by_step_[step];
        const size_t count   = std::min (elements.size (), counts.size ());
        for (size_t i = 0; i < count; ++i) {
            // Read through the registry's own category, never a `kind ==` or
            // prefix comparison outside `core/elements` (#1512's extensibility
            // contract, rule 1) - the same lookup `load_pipeline_skip_reason`
            // above uses for `HotPathClass`.
            const auto* registered =
            vayu::core::Registry::instance ().find (elements[i].kind);
            if (registered == nullptr || registered->category != "assert") {
                continue;
            }
            totals.passed += counts[i].passed.load (std::memory_order_relaxed);
            totals.failed += counts[i].failed.load (std::memory_order_relaxed);
        }
    }
    return totals;
}

nlohmann::json build_step_breakdown (const ScenarioPlan& plan,
const StepHistograms& steps,
const StepElementTallies& elements) {
    nlohmann::json array = nlohmann::json::array ();
    const size_t count   = std::min (plan.steps.size (), steps.step_count ());
    for (size_t i = 0; i < count; ++i) {
        const auto percentiles = steps.percentiles (i);
        nlohmann::json entry   = { { "index", plan.steps[i].index },
              // Identity beside the numbers: a breakdown indexed only by position
              // is unreadable next to a 40-step sequence.
              { "name", plan.steps[i].name }, { "requestId", plan.steps[i].request_id },
              { "method", vayu::to_string (plan.steps[i].request.method) },
              { "executed", steps.completed (i) }, { "errors", steps.errors (i) },
              // Requests this step sent with a `{{token}}` composition never
              // resolved (issue #1503) - counted, not refused, so a literal
              // brace a caller meant to send still goes out.
              { "unresolvedTokens", steps.unresolved_tokens (i) },
              { "latency",
              { { "min", percentiles.min }, { "p50", percentiles.p50 },
              { "p95", percentiles.p95 }, { "p99", percentiles.p99 },
              { "max", percentiles.max } } } };
        auto element_outcomes  = elements.build (plan, i);
        // Whether this step's `script.pre` actually ran this run - inline,
        // through the hook below - rather than being left to the deferred
        // replay: a real outcome in `elements` above, not just the pipeline's
        // own "skipped, deferred" tally. Kept as the field's pre-#1495
        // meaning for a step that is still deferred, so a reader who only
        // knew this key keeps reading the same thing; a step that ran inline
        // reports its real outcome in `elements` instead of this fixed
        // string, which would otherwise contradict it.
        const bool pre_script_ran_inline = std::any_of (element_outcomes.begin (),
        element_outcomes.end (), [] (const nlohmann::json& outcome) {
            return outcome.value ("kind", "") == "script.pre" &&
            (outcome.value ("passed", size_t{ 0 }) > 0 ||
            outcome.value ("failed", size_t{ 0 }) > 0);
        });
        if (step_has_script (plan.steps[i], "script.pre") && !pre_script_ran_inline) {
            entry["preRequestScript"] = "skipped";
        }
        if (!element_outcomes.empty ()) {
            entry["elements"] = std::move (element_outcomes);
        }
        array.push_back (std::move (entry));
    }
    return array;
}

nlohmann::json build_scenario_load_summary (const ScenarioLoadState& state,
const ScenarioPlan& plan) {
    const size_t completed = state.iterations_completed.load (std::memory_order_relaxed);
    const size_t executed = state.steps_executed.load (std::memory_order_relaxed);
    const size_t errored = state.steps_errored.load (std::memory_order_relaxed);
    const size_t skipped = state.steps_skipped.load (std::memory_order_relaxed);
    nlohmann::json summary = { // The keys `apply_run_summary` already reads for a
        // scenario run, so one report shape covers both executors.
        { "iterations", state.iterations_started },
        { "iterations_completed", completed }, { "steps_executed", executed },
        { "passed", executed > errored ? executed - errored : 0 },
        { "failed", size_t{ 0 } }, { "skipped", skipped }, { "errored", errored },
        // This mode's own.
        { "virtual_users", state.virtual_users },
        { "iterations_abandoned", state.iterations_abandoned.load (std::memory_order_relaxed) },
        { "steps", build_step_breakdown (plan, state.steps, state.element_tallies) }
    };
    // `control.transaction`'s own percentiles (issue #1515), absent for a
    // run that declared none.
    if (auto transactions = state.transactions.build (); !transactions.empty ()) {
        summary["transactions"] = std::move (transactions);
    }
    return summary;
}

nlohmann::json build_scenario_load_coverage (const ScenarioLoadState& state) {
    return state.coverage.build ();
}

// ============================================================================
// The virtual-user state machine
// ============================================================================

/**
 * The producer side of a scenario load run: which virtual user is free, what a
 * finished step does to it, and how the next step is submitted.
 *
 * One object rather than three lambdas over the same locals, because every one
 * of them writes state the other two read - `cursor`, `live_vus`, and each VU's
 * `busy` edge - and the ownership rules are only statable where they sit
 * together.
 */
namespace {

/**
 * Skip a compiled element under a load run's inline-vs-deferred rule (#1495):
 * a declarative kind always runs; a `script.*` kind runs only when its own
 * `config.inline` is set or the run's `elements.scripts` override forces it.
 * Read through `HotPathClass`, never a `kind ==` comparison, so #1512's
 * extensibility contract (rule 1) holds outside `core/elements`.
 */
std::optional<std::string> load_pipeline_skip_reason (const vayu::core::CompiledElement& element,
RunContext::ScriptsOverrideMode scripts_mode) {
    const auto* kind = vayu::core::Registry::instance ().find (element.kind);
    if (kind == nullptr || kind->hot_path != vayu::core::HotPathClass::Script) {
        return std::nullopt; // declarative - always runs here
    }
    if (scripts_mode == RunContext::ScriptsOverrideMode::AllInline) {
        return std::nullopt;
    }
    if (scripts_mode == RunContext::ScriptsOverrideMode::AllDeferred ||
    !element.config.value ("inline", false)) {
        return "deferred to the run's post-run replay";
    }
    return std::nullopt;
}

/// This step's `id`-less request identity, for `pm.info` inside an inline
/// script - the same fields `execute_exchange`'s own `bind` lambda sets.
void bind_step_identity (vayu::runtime::ScriptContext& ctx,
const ScenarioStep& step,
size_t iteration,
size_t vu_index) {
    ctx.request_id = step.request_id.empty () ?
    std::nullopt :
    std::optional<std::string> (step.request_id);
    ctx.request_name =
    step.name.empty () ? std::nullopt : std::optional<std::string> (step.name);
    ctx.iteration = iteration;
    ctx.vu        = vu_index;
}

/// `run_step_before`'s answer: elapsed pipeline time on `includeScriptTime`'s
/// terms, whether a controller kind (`control.if` / `control.once` /
/// `control.throughput`, issue #1515) asked to skip this occurrence - the
/// load path's own `pm.execution.skipRequest()` - and `control.switch`'s own
/// dispatch target, if it fired (issue #1569's `Kind::Next`, read the same
/// way the sequential run's `decide_next_step` reads a pre-request script's).
struct StepBeforeResult {
    int64_t elapsed_ms = 0;
    bool skip          = false;
    std::optional<std::string> next_target;
};

/**
 * Runs this step's `step.before` elements - the residual-token pass is the
 * caller's, since it is not gated on whether the step carries any elements at
 * all - for one VU's submission, mutating @p request with whatever an inline
 * `extract.*` or `script.pre` wrote and tallying every outcome.
 */
StepBeforeResult run_step_before (const std::shared_ptr<RunContext>& context,
ScenarioLoadState& state,
VirtualUser& vu,
const ScenarioStep& step,
size_t step_index,
size_t iteration,
size_t vu_index,
vayu::Request& request) {
    if (!step.elements || step.elements->empty ()) {
        return {};
    }
    const auto start = context->include_script_time ?
    std::optional (std::chrono::steady_clock::now ()) :
    std::nullopt;

    std::vector<vayu::core::ElementOutcome> outcomes;
    vayu::ScriptResult pre_result;
    vayu::ScriptResult unused_post_result;
    vayu::core::ElementContext ctx{
        .request  = request,
        .response = nullptr,
        .run_pre_script =
        [&] (const std::string& script) {
            auto& engine =
            vayu::http::routes::script_engine_for_this_thread (state.script_config);
            auto scopes = vu.scope_overlay.materialize (state.base_scopes);
            auto script_ctx = vayu::runtime::ScriptContext::for_prerequest (request);
            vayu::http::routes::bind_variable_scopes (script_ctx, scopes);
            script_ctx.cookie_read_lines = &vu.cookies;
            bind_step_identity (script_ctx, step, iteration, vu_index);
            script_ctx.record_metric = [&context] (const std::string& name,
                                       vayu::core::CustomMetricType type, double value) {
                context->metrics_collector->record_custom_metric (name, type, value);
            };
            auto result = vayu::http::routes::execute_script (
            engine, script, script_ctx, "Pre-request");
            vu.scope_overlay.replace_from (scopes);
            return result;
        },
        .run_post_script    = nullptr,
        .pre_script_result  = pre_result,
        .post_script_result = unused_post_result,
        .set_variable =
        [&] (std::string_view scope, const std::string& name,
        const std::string& value) { vu.scope_overlay.set (scope, name, value); },
        .should_stop = nullptr,
        .resolve_template =
        [&] (const std::string& text) {
            vayu::http::VariableValues vars = state.base_vars;
            vu.scope_overlay.apply_onto (vars);
            return vayu::http::resolve_template (text, vars);
        },
        .iteration               = iteration,
        .step_position           = step_index,
        .element_spans           = &state.element_spans,
        .controller_state        = &vu.controller_state,
        .shared_controller_state = &state.shared_throughput,
        .blocking_allowed = false, // A worker thread must never block here.
        .rng              = &vu.rng,
        .pacing_state     = &vu.pacing_state,
        .timers_override  = &context->timers_override,
        .record_metric    = nullptr, // metric.record is step.after only.
    };

    vayu::core::ElementPipeline::run (vayu::core::Phase::StepBefore, ctx,
    *step.elements, outcomes, [&context] (const vayu::core::CompiledElement& element) {
        return load_pipeline_skip_reason (element, context->scripts_override);
    });
    for (const auto& outcome : outcomes) {
        state.element_tallies.record (step_index, outcome.id, outcome.status);
    }
    // A controller kind's skip (issue #1515) - the load path's own
    // `pm.execution.skipRequest()`.
    const bool skip = pre_result.control.kind == vayu::ScriptControl::Kind::Skip;
    // `control.switch`'s own dispatch (issue #1569) - a skip always wins
    // over a dispatch on the same "last write wins" terms `pre_result` is a
    // single shared field either way, matching the sequential run's own
    // priority when both a skip and a jump are asked for on one step.
    std::optional<std::string> next_target;
    if (!skip && pre_result.control.kind == vayu::ScriptControl::Kind::Next) {
        next_target = pre_result.control.target;
    }
    // `pre_result.tests` is populated only when `script.pre` actually ran
    // above (a deferred one never invokes `run_pre_script`, so it stays
    // empty) - the inline half of issue #1497's assertion tally.
    for (const auto& test : pre_result.tests) {
        if (test.passed) {
            state.inline_script_tests_passed.fetch_add (1, std::memory_order_relaxed);
        } else {
            state.inline_script_tests_failed.fetch_add (1, std::memory_order_relaxed);
        }
    }

    if (!start) {
        return StepBeforeResult{ 0, skip, next_target };
    }
    return StepBeforeResult{
        std::chrono::duration_cast<std::chrono::milliseconds> (
        std::chrono::steady_clock::now () - *start)
        .count (),
        skip,
        next_target,
    };
}

/**
 * Runs this step's `step.after` elements for one VU's completed submission,
 * writing anything an inline `extract.*` or `script.post` produced into
 * @p vu's overlay before the caller retires or advances it.
 *
 * @param response Read-only by contract (see `ElementContext::response`'s own
 *        comment); the `const_cast` exists because the completion callback
 *        only ever holds a `const Response&` off `Result::value()`, and
 *        copying a response to avoid it would pay for the body twice.
 * @return elapsed milliseconds, on the same terms @ref run_step_before returns
 *         them.
 */
int64_t run_step_after (const std::shared_ptr<RunContext>& context,
ScenarioLoadState& state,
VirtualUser& vu,
const ScenarioStep& step,
size_t step_index,
vayu::Request& request,
const vayu::Response& response) {
    if (!step.elements || step.elements->empty ()) {
        return 0;
    }
    const auto start = context->include_script_time ?
    std::optional (std::chrono::steady_clock::now ()) :
    std::nullopt;

    std::vector<vayu::core::ElementOutcome> outcomes;
    vayu::ScriptResult unused_pre_result;
    vayu::ScriptResult post_result;
    vayu::core::ElementContext ctx{
        .request = request,
        .response = const_cast<vayu::Response*> (&response), // NOLINT(cppcoreguidelines-pro-type-const-cast)
        .run_pre_script = nullptr,
        .run_post_script =
        [&] (const std::string& script) {
            auto& engine =
            vayu::http::routes::script_engine_for_this_thread (state.script_config);
            auto scopes = vu.scope_overlay.materialize (state.base_scopes);
            auto script_ctx = vayu::runtime::ScriptContext::for_test (request, response);
            vayu::http::routes::bind_variable_scopes (script_ctx, scopes);
            script_ctx.cookie_read_lines = &vu.cookies;
            bind_step_identity (script_ctx, step, vu.iteration, vu.index);
            script_ctx.record_metric = [&context] (const std::string& name,
                                       vayu::core::CustomMetricType type, double value) {
                context->metrics_collector->record_custom_metric (name, type, value);
            };
            auto result = vayu::http::routes::execute_script (
            engine, script, script_ctx, "Post-request");
            vu.scope_overlay.replace_from (scopes);
            return result;
        },
        .pre_script_result  = unused_pre_result,
        .post_script_result = post_result,
        .set_variable =
        [&] (std::string_view scope, const std::string& name,
        const std::string& value) { vu.scope_overlay.set (scope, name, value); },
        .should_stop = nullptr,
        .resolve_template =
        [&] (const std::string& text) {
            vayu::http::VariableValues vars = state.base_vars;
            vu.scope_overlay.apply_onto (vars);
            return vayu::http::resolve_template (text, vars);
        },
        .iteration        = vu.iteration,
        .step_position    = step_index,
        .element_spans    = &state.element_spans,
        .controller_state = &vu.controller_state,
        .blocking_allowed = false,
        .rng              = &vu.rng,
        .pacing_state     = &vu.pacing_state,
        .timers_override  = &context->timers_override,
        .record_metric =
        [&context] (const std::string& name, vayu::core::CustomMetricType type, double value) {
            context->metrics_collector->record_custom_metric (name, type, value);
        },
    };

    vayu::core::ElementPipeline::run (vayu::core::Phase::StepAfter, ctx, *step.elements,
    outcomes, [&context] (const vayu::core::CompiledElement& element) {
        return load_pipeline_skip_reason (element, context->scripts_override);
    });
    for (const auto& outcome : outcomes) {
        state.element_tallies.record (step_index, outcome.id, outcome.status);
    }
    // A `control.transaction` closing occurrence (issue #1515) - see
    // `scenario_runner.cpp`'s identical fold for why `waited_ms` alone
    // tells a close from an accumulating pass.
    for (const auto& outcome : outcomes) {
        if (outcome.waited_ms && outcome.message) {
            state.transactions.record (
            *outcome.message, *outcome.waited_ms, outcome.status == "failed");
        }
    }
    // Same rule as `run_step_before`: empty unless `script.post` ran inline.
    for (const auto& test : post_result.tests) {
        if (test.passed) {
            state.inline_script_tests_passed.fetch_add (1, std::memory_order_relaxed);
        } else {
            state.inline_script_tests_failed.fetch_add (1, std::memory_order_relaxed);
        }
    }

    if (!start) {
        return 0;
    }
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - *start)
    .count ();
}

} // namespace

class ScenarioLoadDriver {
    public:
    ScenarioLoadDriver (const std::shared_ptr<RunContext>& context,
    vayu::db::Database& db,
    const ScenarioExecution& execution,
    std::shared_ptr<ScenarioLoadState> state,
    size_t max_iterations)
    : context_ (context), db_ (db), execution_ (execution),
      state_ (std::move (state)), max_iterations_ (max_iterations),
      live_vus_ (state_->vus.size ()) {
    }

    /// How many VUs could still be given work. For a duration-bounded run that
    /// is every live VU; for an `iterations` run it shrinks to zero as they
    /// retire, which is what ends the loop.
    [[nodiscard]] size_t live_vus () const {
        return live_vus_;
    }

    /** The next step of the next ready virtual user, submitted. */
    void submit_one () {
        VirtualUser* vu = take_ready_vu ();
        if (vu == nullptr) {
            // Every VU is in flight or retired. The controller's own 50ms tick
            // retries; not counting a submission here is what keeps
            // `in_flight()` honest.
            return;
        }

        const size_t step_index         = vu->step;
        const ScenarioStep& step        = execution_.plan.steps[step_index];
        const std::optional<size_t> row = vu->data_row;
        // Read here rather than in the completion: `finish_step` advances it at
        // an iteration boundary, so the callback would report the iteration the
        // VU moved on to instead of the one this step ran in.
        const size_t iteration = vu->iteration;
        const size_t vu_index  = vu->index;
        vayu::Request request  = step.request;
        request.track_cookies  = true;
        request.cookie_lines   = vu->cookies;

        // The data pass and the identity pass, per iteration and before the
        // send. A step carrying neither kind of token has empty templates and
        // is not walked at all, which is what makes a token-free plan free per
        // iteration.
        if (!(step.data_template.empty () && step.auth_template.empty ())) {
            // Every half through the one binder the single-request load path
            // also drives (issues #993, #994), so a request binds identically
            // whether it is repeated on its own or walked as a step - including
            // the credentials-after-fields order the encoding depends on.
            const auto bound = bind_step_iteration (request, step,
            execution_.data_rows, row, IterationIdentity{ vu_index, iteration });
            if (!bound.ok) {
                // Nothing goes on the wire, so nothing will ever complete for
                // this step: this path owns the whole accounting a completion
                // would have done. `requests_sent` is incremented beside the
                // error record so `in_flight()` - sent minus completed - stays
                // honest, and the step's `errors` column in the report's
                // breakdown is what attributes the failure to a step.
                context_->requests_sent++;
                finish_step (context_, state_, execution_.plan, vu, step_index,
                /*errored=*/true, nullptr);
                handle_result (context_, db_,
                vayu::Result<vayu::Response> (vayu::Error{
                vayu::ErrorCode::DataBindingFailed, step.name + ": " + bound.error }),
                ResultAnnotations{ row, step_index, iteration, vu_index });
                return;
            }
        }

        // The element pipeline's `step.before` phase, then the residual pass
        // over what it (and the bind above) left unresolved (issue #1495) -
        // against this VU's own scope, so a token an earlier step's inline
        // `extract.*` wrote for this VU resolves here. Never refused, only
        // counted: the load path's rule since #1503 is "send it regardless",
        // which this keeps - a real resolution attempt now runs first, but a
        // name still unanswered, or a header-name collision the attempt
        // itself produced, is exactly as survivable as one composition alone
        // left behind.
        const StepBeforeResult before_result = run_step_before (
        context_, *state_, *vu, step, step_index, iteration, vu_index, request);
        if (before_result.skip) {
            // `control.if` / `control.once` / `control.throughput` asked to
            // skip this occurrence (issue #1515) - nothing goes out, on the
            // same "never blocks a worker thread" terms every other
            // controller decision here holds to. The VU still advances
            // exactly as a sent step would; there is simply no `Result` to
            // store and no coverage to record, matching a design send's own
            // skip (`execute_exchange`'s `outcome.sent = false` branch).
            state_->steps_skipped.fetch_add (1, std::memory_order_relaxed);
            finish_step (context_, state_, execution_.plan, vu, step_index,
            /*errored=*/false, nullptr);
            return;
        }
        const int64_t pipeline_before_ms = before_result.elapsed_ms;
        {
            vayu::http::VariableValues vars = state_->base_vars;
            vu->scope_overlay.apply_onto (vars);
            const auto refusal =
            vayu::http::routes::resolve_residual_tokens (request, vars);
            auto still_unresolved = vayu::http::routes::unresolved_token_names (request);
            if (refusal || !still_unresolved.empty ()) {
                state_->steps.record_unresolved_token (step_index);
                context_->metrics_collector->record_unresolved_token (refusal ?
                std::vector<std::string>{ refusal->error.message } :
                std::move (still_unresolved));
            }
        }

        // `step.after` needs the sent request back (declarative kinds may
        // read `ctx.request`, e.g. a URL a `metric.record` names), which the
        // event loop's own copy is not - `EventLoop::submit` copies @p request
        // for the transfer but does not hand that copy back to the completion.
        // Held only for a step that actually carries elements, so a
        // token-free, element-free plan still pays no copy per iteration.
        std::shared_ptr<vayu::Request> sent_request =
        step.elements && !step.elements->empty () ?
        std::make_shared<vayu::Request> (request) :
        nullptr;

        // `step`'s address is stable for the run's whole life: the plan is
        // immutable, const data shared by the run's context.
        const ScenarioStep* step_ptr = &step;
        // `control.switch`'s own dispatch (issue #1569), decided above at
        // `step.before` and carried into the completion for `finish_step` to
        // resolve once this step's own send (whatever it does) is done -
        // never consulted on the transport-error path, which ends the
        // iteration on `errored` alone regardless.
        std::optional<std::string> next_target_before = before_result.next_target;
        context_->event_loop->submit (request,
        [context = context_, &db = db_, state = state_, &plan = execution_.plan, step_ptr,
        vu, step_index, iteration, vu_index, row, pipeline_before_ms, sent_request,
        next_target_before] (size_t, const vayu::Result<vayu::Response>& result) {
            if (result.is_error ()) {
                // No `Response` object exists at all - nothing for `step.after`
                // to run against, exactly as before #1495. Coverage still
                // counts it: a transport error is a request this operation
                // was sent and did not answer, reported as status 0 rather
                // than a status the server never sent (issue #629).
                state->coverage.record (step_index, 0);
                finish_step (context, state, plan, vu, step_index, /*errored=*/true, nullptr);
                handle_result (context, db, result,
                ResultAnnotations{ row, step_index, iteration, vu_index });
                return;
            }

            const vayu::Response& response = result.value ();
            int64_t pipeline_after_ms      = 0;
            if (sent_request) {
                pipeline_after_ms = run_step_after (context, *state, *vu,
                *step_ptr, step_index, *sent_request, response);
            }

            const bool errored = response.has_error ();
            if (!errored) {
                const double latency_ms = context->include_script_time ?
                response.timing.total_ms +
                static_cast<double> (pipeline_before_ms + pipeline_after_ms) :
                response.timing.total_ms;
                state->steps.record (step_index, latency_ms);
            }
            // Every completion, including the failed ones: a transport error is
            // a request this operation was sent and did not answer, and coverage
            // that counted only successes would report the send as if it never
            // happened.
            state->coverage.record (step_index, response.status_code);
            finish_step (context, state, plan, vu, step_index, errored,
            errored ? nullptr : &response.cookie_lines,
            errored ? std::nullopt : next_target_before);
            handle_result (context, db, result,
            ResultAnnotations{ row, step_index, iteration, vu_index });
        });
        context_->requests_sent++;
    }

    private:
    /**
     * A virtual user that is neither busy nor retired, claimed for one step.
     *
     * Returns null when every VU is in flight or retired: the controller's own
     * 50ms tick retries, and not counting a submission is what keeps
     * `in_flight()` honest.
     */
    VirtualUser* take_ready_vu () {
        for (size_t scanned = 0; scanned < state_->vus.size (); ++scanned) {
            VirtualUser& vu = *state_->vus[cursor_];
            cursor_         = (cursor_ + 1) % state_->vus.size ();
            if (vu.retired) {
                continue;
            }
            // Acquire pairs with the completion's release store, so the step,
            // iteration, cookies and scope overlay this VU was left with are
            // visible here.
            if (vu.busy.load (std::memory_order_acquire)) {
                continue;
            }
            // Plumbing for a scheduled wait (#1498's `timer.pacing` / gaussian
            // `timer.think`) - nothing writes past 0 yet, so this is a no-op
            // for every run today. Read after the acquire above for the same
            // reason `step` and `iteration` are.
            if (vu.ready_at_ms > 0 && vu.ready_at_ms > steady_now_ms ()) {
                continue;
            }
            if (vu.iteration_boundary) {
                if (max_iterations_ > 0 && state_->iterations_started >= max_iterations_) {
                    vu.retired = true;
                    --live_vus_;
                    continue;
                }
                ++state_->iterations_started;
                vu.iteration_boundary = false;
                if (state_->data_row_count > 0) {
                    // One claim per iteration off the run-wide cursor, wrapping
                    // always. Claimed here rather than per step so every step
                    // of the iteration binds the same row - a checkout that
                    // used a different row than its login is not a user.
                    vu.data_row = state_->data_cursor++ % state_->data_row_count;
                }
            }
            // The producer is the only writer of this edge, so a plain store is
            // enough - no compare-exchange, and nothing on the completion path
            // has to loop.
            vu.busy.store (true, std::memory_order_relaxed);
            return &vu;
        }
        return nullptr;
    }

    /**
     * `step.between` (issue #1498), for the step that just completed -
     * `timer.think`'s load-path counterpart to `scenario_runner.cpp`'s own
     * dispatch, run here instead of blocking a worker thread: every
     * outcome's `waited_ms` is summed and applied to `vu.ready_at_ms`, never
     * to the step's own recorded latency, which by this point is already
     * decided. A `timer.pacing` element here is always `_scopeEntry: false`
     * (its entry occurrence dispatches at `step.before` of its own step, not
     * `step.between` of whatever preceded it) and reports `waited_ms: 0`, so
     * it contributes nothing through this path - see @ref
     * schedule_next_entry_wait for its actual scheduling.
     *
     * Also `control.loop`'s own seam (issue #1569): its `Next` decision -
     * only the folder's *last* member ever makes one, per its own
     * `needs_span` check - is returned the same way `run_step_before`
     * returns `control.switch`'s, for `finish_step` to resolve against the
     * run's `step_index`.
     *
     * @return the folder-start step name a `control.loop` asked to repeat,
     *         or `nullopt` when nothing at this step decided one.
     */
    static std::optional<std::string> run_step_between (
    const std::shared_ptr<RunContext>& context,
    ScenarioLoadState& state,
    const ScenarioStep& completed_step,
    size_t step_index,
    VirtualUser& vu) {
        if (!completed_step.elements || completed_step.elements->empty ()) {
            return std::nullopt;
        }
        std::vector<vayu::core::ElementOutcome> outcomes;
        vayu::ScriptResult between_control;
        vayu::ScriptResult unused_post;
        vayu::core::ElementContext ctx{
            // Never read or written by a `step.between` kind (`timer.think`,
            // `timer.pacing`) - bound to the step's own stored request only
            // because `ElementContext::request` is a reference, on the same
            // `const_cast` precedent `run_step_after` uses for `response`.
            .request = const_cast<vayu::Request&> (completed_step.request), // NOLINT(cppcoreguidelines-pro-type-const-cast)
            .response           = nullptr,
            .run_pre_script     = nullptr,
            .run_post_script    = nullptr,
            .pre_script_result  = between_control,
            .post_script_result = unused_post,
            .set_variable = [] (std::string_view, const std::string&, const std::string&) {},
            .should_stop      = nullptr,
            .iteration        = vu.iteration,
            .step_position    = step_index,
            .element_spans    = &state.element_spans,
            .controller_state = &vu.controller_state,
            .blocking_allowed = false,
            .rng              = &vu.rng,
            .pacing_state     = &vu.pacing_state,
            .timers_override  = &context->timers_override,
            .record_metric    = nullptr, // metric.record is step.after only.
        };
        vayu::core::ElementPipeline::run (
        vayu::core::Phase::StepBetween, ctx, *completed_step.elements, outcomes);

        int64_t total_wait_ms = 0;
        for (const auto& outcome : outcomes) {
            total_wait_ms += outcome.waited_ms.value_or (0);
            state.element_tallies.record (step_index, outcome.id, outcome.status);
        }
        if (total_wait_ms > 0) {
            vu.ready_at_ms = std::max (vu.ready_at_ms, steady_now_ms () + total_wait_ms);
            fold_between_wait_into_open_transactions (*completed_step.elements,
            state.element_spans, step_index, vu.iteration, total_wait_ms,
            vu.controller_state);
        }

        return between_control.control.kind == vayu::ScriptControl::Kind::Next ?
        std::optional (between_control.control.target) :
        std::nullopt;
    }

    /**
     * `timer.pacing`'s actual scheduling (issue #1498): asks every element of
     * @p next_step - the step this VU will run once ready again, already
     * advanced past the wrap-to-0 / step+1 decision - whether it should hold
     * the VU back, and applies the longest such answer to `ready_at_ms`.
     * Called here, before the VU can next be selected, because `step.before`
     * (where `timer.pacing` actually dispatches) only ever runs *after*
     * `take_ready_vu` has already chosen this VU - too late to defer without
     * blocking the caller. @p shared (issues #1570, #1571) is the run's own
     * cross-VU coordination state, threaded through unconditionally: a
     * `perUser: true` element never touches it, and a plan with nothing
     * shared in it leaves both members empty.
     */
    static void schedule_next_entry_wait (const ScenarioStep& next_step,
    VirtualUser& vu,
    const SharedScheduleState& shared) {
        if (!next_step.elements || next_step.elements->empty ()) {
            return;
        }
        const int64_t now = steady_now_ms ();
        for (const auto& compiled : *next_step.elements) {
            if (!compiled.element) {
                continue;
            }
            if (auto delay = compiled.element->scheduled_ready_delay_ms (
                vu.pacing_state, shared, now)) {
                vu.ready_at_ms = std::max (vu.ready_at_ms, now + *delay);
            }
        }
    }

    /**
     * One step's outcome applied to the run's tallies and the VU's state
     * machine, and the only writer of `busy`'s `true -> false` edge. Shared by
     * the completion callback and the data-binding failure, so a step that
     * never reached the wire retires its VU exactly as a completed one does - a
     * VU left busy permanently shrinks effective concurrency.
     *
     * @p next_cookies is null for an outcome that carries none - an error, or a
     * step that was never sent. @p next_target_from_before is
     * `control.switch`'s own dispatch (issue #1569, `run_step_before`'s
     * return), read only when this step did not error - the same "an
     * instruction that cannot be honoured is this step's failure" priority
     * `errored` already has over any control decision.
     */
    static void finish_step (const std::shared_ptr<RunContext>& context,
    const std::shared_ptr<ScenarioLoadState>& state,
    const ScenarioPlan& plan,
    VirtualUser* vu,
    size_t step_index,
    bool errored,
    const std::vector<std::string>* next_cookies,
    std::optional<std::string> next_target_from_before = std::nullopt) {
        const size_t step_count = plan.steps.size ();
        state->steps_executed.fetch_add (1, std::memory_order_relaxed);
        ++vu->steps_this_iteration;

        std::optional<std::string> next_target;
        if (errored) {
            state->steps.record_error (step_index);
            state->steps_errored.fetch_add (1, std::memory_order_relaxed);
        } else {
            // `control.loop`'s own decision (issue #1569) is chronologically
            // last, so it overrides `control.switch`'s own step.before
            // decision on the sequential run's own "last call wins" terms
            // (`decide_next_step` reads its post-script over its pre).
            next_target = run_step_between (
            context, *state, plan.steps[step_index], step_index, *vu);
            if (!next_target) {
                next_target = std::move (next_target_from_before);
            }
        }

        // A `control.switch` / `control.loop` jump or repeat (issue #1569),
        // resolved against the plan the same way a script's own
        // `setNextRequest` is (`resolve_next_step`). A target this run
        // cannot honour, or a cycle that never reaches
        // `maxStepsPerIteration`, both end the iteration as abandoned - the
        // sequential run's own rule for an instruction it cannot honour.
        std::optional<size_t> jump_target;
        bool jump_failed = false;
        if (next_target && !errored) {
            if (vu->steps_this_iteration >= state->max_steps_per_iteration) {
                vayu::utils::log_warning ("run",
                "Scenario load run: iteration exceeded maxStepsPerIteration - "
                "a "
                "control.switch/control.loop cycle never reached its end",
                { { "runId", context->run_id },
                { "maxStepsPerIteration", state->max_steps_per_iteration } });
                jump_failed = true;
            } else {
                const auto resolution = resolve_next_step (state->step_index, *next_target);
                switch (resolution.kind) {
                case NextStepResolution::Kind::Step:
                    jump_target = resolution.index;
                    break;
                case NextStepResolution::Kind::EndIteration:
                    break; // Ends below, on the same terms a natural last step does.
                case NextStepResolution::Kind::Unresolved:
                    vayu::utils::log_warning ("run",
                    "Scenario load run: " + resolution.error,
                    { { "runId", context->run_id } });
                    jump_failed = true;
                    break;
                }
            }
        }

        const bool ends_by_jump = next_target.has_value () && !jump_target && !jump_failed;
        const bool abandon   = errored || jump_failed;
        const bool last_step = step_index + 1 >= step_count;
        const bool end_iteration = abandon || ends_by_jump || (!jump_target && last_step);

        if (end_iteration) {
            // An abandoned iteration ends here rather than stranding the VU,
            // which would permanently shrink effective concurrency for the
            // rest of the run; an ordinary last step or an explicit
            // `Kind::EndIteration` both count as completed, not abandoned -
            // neither is a failure.
            if (abandon) {
                state->iterations_abandoned.fetch_add (1, std::memory_order_relaxed);
            } else {
                state->iterations_completed.fetch_add (1, std::memory_order_relaxed);
            }
            vu->step               = 0;
            vu->iteration_boundary = true;
            ++vu->iteration;
            vu->steps_this_iteration = 0;
            // Empty at the start of each iteration: a new iteration is a
            // new user, not the same one logging in twice.
            vu->cookies.clear ();
            vu->scope_overlay.clear ();
        } else {
            vu->step = jump_target.value_or (step_index + 1);
            // Replace, never merge - the captured list is the whole jar the
            // handle held, so merging would resurrect a cookie the server
            // deleted by expiring it. This step's own send (a jump target
            // does not change whether *this* step sent one) is what
            // @p next_cookies describes either way.
            vu->cookies =
            next_cookies != nullptr ? *next_cookies : std::vector<std::string>{};
        }

        // Always, even after an errored step: the VU still has a next step
        // (the wrap-to-0 above already decided which), and a folder's
        // pacing must hold whether the pass that just ended succeeded or
        // not - "regardless of the folder's own duration" includes an
        // error's duration too.
        schedule_next_entry_wait (plan.steps[vu->step], *vu,
        SharedScheduleState{ .pacing = &state->shared_pacing,
        .throughput                  = &state->shared_throughput_budgets });

        // Released *before* handle_result, which is what increments the
        // completion count `in_flight()` is derived from: a VU that became
        // ready after the count moved would leave the controller computing
        // a deficit it cannot fill.
        vu->busy.store (false, std::memory_order_release);
    }

    const std::shared_ptr<RunContext>& context_;
    vayu::db::Database& db_;
    const ScenarioExecution& execution_;
    std::shared_ptr<ScenarioLoadState> state_;
    size_t max_iterations_ = 0;
    size_t cursor_         = 0;
    size_t live_vus_       = 0;
};

std::shared_ptr<ScenarioLoadState> execute_scenario_load (
const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
const ScenarioExecution& execution,
vayu::http::routes::ScriptVariableScopes base_scopes) {
    const ScenarioPlan& plan = execution.plan;
    const size_t step_count  = plan.steps.size ();
    const auto& config       = context->config;

    if (step_count == 0) {
        // Resolution rejects an empty plan with a 400, so reaching here means a
        // caller built a ScenarioExecution by hand. Refuse loudly rather than
        // spinning a controller whose submit can never do anything.
        throw std::invalid_argument ("Scenario load run has no steps");
    }

    const std::string mode = config.value ("mode", std::string{});
    const auto type        = parse_load_test_type (mode);
    if (!type || *type == LoadTestType::ConstantRps ||
    *type == LoadTestType::Capacity || requested_rps (config) > 0.0) {
        // The route rejects both with a 400 before the run row exists; this is
        // the same rule stated where the executor would otherwise have to guess.
        throw std::invalid_argument (validate_scenario_load_config (config).value_or (
        "Invalid scenario load mode"));
    }

    const size_t target_vus =
    std::max<size_t> (1, static_cast<size_t> (config.value ("concurrency", 10)));
    const size_t start_vus = *type == LoadTestType::RampUp ?
    std::max<size_t> (1, static_cast<size_t> (config.value ("startConcurrency", 1))) :
    target_vus;
    // A descending ramp starts above its target, so the pool is the larger of
    // the two - `ramp_target_concurrency` handles the direction, not this.
    const size_t vu_count = std::max (target_vus, start_vus);

    const size_t max_iterations = *type == LoadTestType::Iterations ?
    std::max<size_t> (1, static_cast<size_t> (config.value ("iterations", 1000))) :
    0;

    // The run's shared variable scopes (issue #1495) - loaded and, since
    // #1499, run through `script.setup` by `execute_load_test` before this
    // function was even called, so a setup script's writes are already in
    // `base_scopes` by the time it is handed in.

    vayu::runtime::ScriptConfig script_config;
    script_config.timeout_ms = static_cast<uint64_t> (
    db.get_config_int ("scriptTimeout", constants::script_engine::TIMEOUT_MS));
    script_config.memory_limit = static_cast<size_t> (
    db.get_config_int ("scriptMemoryLimit", constants::script_engine::MEMORY_LIMIT));
    script_config.stack_size = static_cast<size_t> (
    db.get_config_int ("scriptStackSize", constants::script_engine::STACK_SIZE));
    script_config.enable_console = db.get_config_bool (
    "scriptEnableConsole", constants::script_engine::ENABLE_CONSOLE);
    script_config.allow_send_request = vayu::http::read_allow_script_requests (config);

    auto state            = std::make_shared<ScenarioLoadState> (plan, vu_count,
               make_coverage_tally (execution), std::move (base_scopes), script_config);
    state->data_row_count = execution.data_rows.size ();
    // The same cycle guard the sequential run's own `setNextRequest` walk
    // uses (issue #1569), against a `control.switch`/`control.loop` plan
    // whose jump never reaches an end.
    state->max_steps_per_iteration = resolve_max_steps_per_iteration (
    db.get_config_int ("maxStepsPerIteration", 0), step_count);
    state->vus.reserve (vu_count);
    for (size_t i = 0; i < vu_count; ++i) {
        auto user = std::make_unique<VirtualUser> ();
        // 1-based, so `{{$vu}}` reads as a person numbers users rather than as
        // an array index (issue #994).
        user->index = i + 1;
        // Derived from the run's seed rather than sharing `context->rng`
        // across every worker thread (issue #1498) - see `derive_vu_rng`.
        user->rng = derive_vu_rng (context->rng_seed, user->index);
        state->vus.push_back (std::move (user));
    }

    if (max_iterations > 0) {
        context->requests_expected = max_iterations * step_count;
    }

    // Which steps the deferred pass will read a sample of. Sized here, before
    // the first submission, because the completion path only ever reads it.
    // A plan no deferred pass will look at gets no stores at all, so it samples
    // nothing and the report omits the sections rather than showing zeros.
    //
    // Two reasons to keep a step's responses, not one (issue #682): a script to
    // replay against them, or a contract to check them against. A step bound to
    // an operation is a candidate whenever the run carries a schema index -
    // whether the index actually *declares* that operation is a question only
    // the deferred pass can answer, and answering it here would mean parsing
    // the whole index on the setup path to save a reservoir.
    {
        const bool validating = !execution.spec.response_schemas.empty ();
        std::vector<bool> sampled (step_count, false);
        for (size_t i = 0; i < step_count; ++i) {
            sampled[i] = step_has_script (plan.steps[i], "script.post") ||
            (validating && !plan.steps[i].spec_operation.empty ());
        }
        context->metrics_collector->configure_step_samples (sampled);
    }

    vayu::utils::log_info ("run", "Starting Scenario Load Test (" + mode + ")");
    vayu::utils::log_info ("run", "  Virtual users: " + std::to_string (vu_count));
    vayu::utils::log_info ("run", "  Steps per iteration: " + std::to_string (step_count));
    if (max_iterations > 0) {
        vayu::utils::log_info ("run", "  Iterations: " + std::to_string (max_iterations));
    }
    if (config.contains ("maxInFlight")) {
        // Stated rather than silently ignored: in-flight is bounded by the VU
        // count by construction here, so the field cannot do anything.
        vayu::utils::log_warning ("run",
        "maxInFlight has no effect on a scenario run - in-flight requests are "
        "bounded by the virtual-user count ('concurrency')");
    }

    ScenarioLoadDriver driver (context, db, execution, state, max_iterations);

    // Through the one duration parser, so a mistyped "30sec" fails this run the
    // same way it fails a single-request one rather than silently running for a
    // minute.
    const int64_t duration_ms = *type == LoadTestType::Iterations ?
    std::numeric_limits<int64_t>::max () :
    duration_field_ms (config, "duration", 60000);
    const int64_t ramp_ms     = *type == LoadTestType::RampUp ?
        duration_field_ms (config, "rampUpDuration", 10000) :
        0;

    maintain_concurrency (
    context, [&driver] () { driver.submit_one (); },
    [type, start_vus, target_vus, ramp_ms] (int64_t elapsed) -> size_t {
        if (*type != LoadTestType::RampUp) {
            return target_vus;
        }
        return ramp_target_concurrency (start_vus, target_vus, ramp_ms, elapsed);
    },
    // The budget is how many VUs could still be given work. For a duration-
    // bounded run that is every live VU; for an `iterations` run it shrinks to
    // zero as they retire, which is what ends the loop.
    [&driver] () { return driver.live_vus (); },
    [type, duration_ms, &driver] (int64_t elapsed) {
        return *type == LoadTestType::Iterations ? driver.live_vus () > 0 :
                                                   elapsed < duration_ms;
    });

    return state;
}

} // namespace vayu::core
