/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/scenario_load.hpp"

#include <algorithm>
#include <limits>
#include <optional>
#include <stdexcept>
#include <utility>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/core/load_pacing.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_data.hpp"
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

} // namespace

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
: histograms_ (step_count, nullptr), completed_ (step_count), errors_ (step_count) {
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

size_t StepHistograms::completed (size_t step) const {
    return step < completed_.size () ? completed_[step].load (std::memory_order_relaxed) : 0;
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

nlohmann::json build_step_breakdown (const ScenarioPlan& plan, const StepHistograms& steps) {
    nlohmann::json array = nlohmann::json::array ();
    const size_t count   = std::min (plan.steps.size (), steps.step_count ());
    for (size_t i = 0; i < count; ++i) {
        const auto percentiles = steps.percentiles (i);
        array.push_back ({ { "index", plan.steps[i].index },
        // Identity beside the numbers: a breakdown indexed only by position
        // is unreadable next to a 40-step sequence.
        { "name", plan.steps[i].name }, { "requestId", plan.steps[i].request_id },
        { "method", vayu::to_string (plan.steps[i].request.method) },
        { "executed", steps.completed (i) }, { "errors", steps.errors (i) },
        { "latency",
        { { "min", percentiles.min }, { "p50", percentiles.p50 },
        { "p95", percentiles.p95 }, { "p99", percentiles.p99 },
        { "max", percentiles.max } } } });
    }
    return array;
}

nlohmann::json build_scenario_load_summary (const ScenarioLoadState& state,
const ScenarioPlan& plan) {
    const size_t completed = state.iterations_completed.load (std::memory_order_relaxed);
    const size_t executed = state.steps_executed.load (std::memory_order_relaxed);
    const size_t errored = state.steps_errored.load (std::memory_order_relaxed);
    return { // The keys `apply_run_summary` already reads for a scenario run, so
        // one report shape covers both executors.
        { "iterations", state.iterations_started },
        { "iterations_completed", completed }, { "steps_executed", executed },
        { "passed", executed > errored ? executed - errored : 0 },
        { "failed", size_t{ 0 } }, { "skipped", size_t{ 0 } }, { "errored", errored },
        // This mode's own.
        { "virtual_users", state.virtual_users },
        { "iterations_abandoned", state.iterations_abandoned.load (std::memory_order_relaxed) },
        { "steps", build_step_breakdown (plan, state.steps) }
    };
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
        if (!(step.data_template.empty () && step.auth_template.empty () &&
            step.identity_template.empty ())) {
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
                finish_step (state_, execution_.plan.steps.size (), vu, step_index,
                /*errored=*/true, nullptr);
                handle_result (context_, db_,
                vayu::Result<vayu::Response> (vayu::Error{
                vayu::ErrorCode::DataBindingFailed, step.name + ": " + bound.error }),
                ResultAnnotations{ row, step_index, iteration, vu_index });
                return;
            }
        }

        context_->event_loop->submit (request,
        [context = context_, &db = db_, state = state_,
        step_count = execution_.plan.steps.size (), vu, step_index, iteration,
        vu_index, row] (size_t, const vayu::Result<vayu::Response>& result) {
            const bool errored = result.is_error () || result.value ().has_error ();
            if (!errored) {
                state->steps.record (step_index, result.value ().timing.total_ms);
            }
            // Every completion, including the failed ones: a transport error is
            // a request this operation was sent and did not answer, and coverage
            // that counted only successes would report the send as if it never
            // happened. `is_error()` is the no-response case, which records as
            // status 0 and is reported as a transport error rather than a
            // status the server never sent (issue #629).
            state->coverage.record (
            step_index, result.is_error () ? 0 : result.value ().status_code);
            finish_step (state, step_count, vu, step_index, errored,
            errored ? nullptr : &result.value ().cookie_lines);
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
            // iteration and cookies this VU was left with are visible here.
            if (vu.busy.load (std::memory_order_acquire)) {
                continue;
            }
            if (vu.step == 0) {
                if (max_iterations_ > 0 && state_->iterations_started >= max_iterations_) {
                    vu.retired = true;
                    --live_vus_;
                    continue;
                }
                ++state_->iterations_started;
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
     * One step's outcome applied to the run's tallies and the VU's state
     * machine, and the only writer of `busy`'s `true -> false` edge. Shared by
     * the completion callback and the data-binding failure, so a step that
     * never reached the wire retires its VU exactly as a completed one does - a
     * VU left busy permanently shrinks effective concurrency.
     *
     * @p next_cookies is null for an outcome that carries none - an error, or a
     * step that was never sent.
     */
    static void finish_step (const std::shared_ptr<ScenarioLoadState>& state,
    size_t step_count,
    VirtualUser* vu,
    size_t step_index,
    bool errored,
    const std::vector<std::string>* next_cookies) {
        state->steps_executed.fetch_add (1, std::memory_order_relaxed);
        if (errored) {
            state->steps.record_error (step_index);
            state->steps_errored.fetch_add (1, std::memory_order_relaxed);
        }

        const bool last_step = step_index + 1 >= step_count;
        if (errored || last_step) {
            // An errored step ends its iteration - and the VU starts the next
            // one rather than being stranded, which would permanently shrink
            // effective concurrency for the rest of the run.
            if (last_step) {
                state->iterations_completed.fetch_add (1, std::memory_order_relaxed);
            } else {
                state->iterations_abandoned.fetch_add (1, std::memory_order_relaxed);
            }
            vu->step = 0;
            ++vu->iteration;
            // Empty at the start of each iteration: a new iteration is a
            // new user, not the same one logging in twice.
            vu->cookies.clear ();
        } else {
            vu->step = step_index + 1;
            // Replace, never merge - the captured list is the whole jar the
            // handle held, so merging would resurrect a cookie the server
            // deleted by expiring it.
            vu->cookies =
            next_cookies != nullptr ? *next_cookies : std::vector<std::string>{};
        }

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
const ScenarioExecution& execution) {
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

    auto state = std::make_shared<ScenarioLoadState> (
    step_count, vu_count, make_coverage_tally (execution));
    state->data_row_count = execution.data_rows.size ();
    state->vus.reserve (vu_count);
    for (size_t i = 0; i < vu_count; ++i) {
        auto user = std::make_unique<VirtualUser> ();
        // 1-based, so `{{$vu}}` reads as a person numbers users rather than as
        // an array index (issue #994).
        user->index = i + 1;
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
            sampled[i] = !plan.steps[i].post_script.empty () ||
            (validating && !plan.steps[i].spec_operation.empty ());
        }
        context->metrics_collector->configure_step_samples (sampled);
    }

    vayu::utils::log_info ("Starting Scenario Load Test (" + mode + ")");
    vayu::utils::log_info ("  Virtual users: " + std::to_string (vu_count));
    vayu::utils::log_info ("  Steps per iteration: " + std::to_string (step_count));
    if (max_iterations > 0) {
        vayu::utils::log_info ("  Iterations: " + std::to_string (max_iterations));
    }
    if (config.contains ("maxInFlight")) {
        // Stated rather than silently ignored: in-flight is bounded by the VU
        // count by construction here, so the field cannot do anything.
        vayu::utils::log_warning (
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
