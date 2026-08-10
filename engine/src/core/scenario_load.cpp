/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/scenario_load.hpp"

#include <algorithm>
#include <limits>
#include <stdexcept>
#include <utility>

#include "vayu/core/constants.hpp"
#include "vayu/core/load_pacing.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/core/run_manager.hpp"
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

// ============================================================================
// The virtual-user state machine
// ============================================================================

std::shared_ptr<ScenarioLoadState> execute_scenario_load (std::shared_ptr<RunContext> context,
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
    if (!type || *type == LoadTestType::ConstantRps || requested_rps (config) > 0.0) {
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

    auto state = std::make_shared<ScenarioLoadState> (step_count, vu_count);
    state->vus.reserve (vu_count);
    for (size_t i = 0; i < vu_count; ++i) {
        state->vus.push_back (std::make_unique<VirtualUser> ());
    }

    if (max_iterations > 0) {
        context->requests_expected = max_iterations * step_count;
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

    // Producer-thread-only cursor and tallies. `live_vus` shrinks as VUs retire
    // at an iteration boundary, which is what lets an `iterations` run end
    // without abandoning a VU in the middle of its sequence.
    size_t cursor   = 0;
    size_t live_vus = vu_count;
    auto* state_ptr = state.get ();

    auto take_ready_vu = [&] () -> VirtualUser* {
        for (size_t scanned = 0; scanned < state_ptr->vus.size (); ++scanned) {
            VirtualUser& vu = *state_ptr->vus[cursor];
            cursor          = (cursor + 1) % state_ptr->vus.size ();
            if (vu.retired) {
                continue;
            }
            // Acquire pairs with the completion's release store, so the step,
            // iteration and cookies this VU was left with are visible here.
            if (vu.busy.load (std::memory_order_acquire)) {
                continue;
            }
            if (vu.step == 0) {
                if (max_iterations > 0 && state_ptr->iterations_started >= max_iterations) {
                    vu.retired = true;
                    --live_vus;
                    continue;
                }
                ++state_ptr->iterations_started;
            }
            // The producer is the only writer of this edge, so a plain store is
            // enough - no compare-exchange, and nothing on the completion path
            // has to loop.
            vu.busy.store (true, std::memory_order_relaxed);
            return &vu;
        }
        return nullptr;
    };

    auto submit_one = [&] () {
        VirtualUser* vu = take_ready_vu ();
        if (vu == nullptr) {
            // Every VU is in flight or retired. The controller's own 50ms tick
            // retries; not counting a submission here is what keeps
            // `in_flight()` honest.
            return;
        }

        const size_t step_index  = vu->step;
        const ScenarioStep& step = plan.steps[step_index];
        vayu::Request request    = step.request;
        request.track_cookies    = true;
        request.cookie_lines     = vu->cookies;

        context->event_loop->submit (request,
        [context, &db, state, vu, step_index, step_count] (
        size_t, vayu::Result<vayu::Response> result) {
            const bool errored = result.is_error () || result.value ().has_error ();
            state->steps_executed.fetch_add (1, std::memory_order_relaxed);
            if (errored) {
                state->steps.record_error (step_index);
                state->steps_errored.fetch_add (1, std::memory_order_relaxed);
            } else {
                state->steps.record (step_index, result.value ().timing.total_ms);
            }

            const bool last_step = step_index + 1 >= step_count;
            if (errored || last_step) {
                // An errored step ends its iteration - and the VU starts the
                // next one rather than being stranded, which would permanently
                // shrink effective concurrency for the rest of the run.
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
                vu->cookies = std::move (result.value ().cookie_lines);
            }

            // Released *before* handle_result, which is what increments the
            // completion count `in_flight()` is derived from: a VU that became
            // ready after the count moved would leave the controller computing
            // a deficit it cannot fill.
            vu->busy.store (false, std::memory_order_release);
            handle_result (context, db, std::move (result));
        });
        context->requests_sent++;
    };

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
    context, submit_one,
    [type, start_vus, target_vus, ramp_ms] (int64_t elapsed) -> size_t {
        if (*type != LoadTestType::RampUp) {
            return target_vus;
        }
        return ramp_target_concurrency (start_vus, target_vus, ramp_ms, elapsed);
    },
    // The budget is how many VUs could still be given work. For a duration-
    // bounded run that is every live VU; for an `iterations` run it shrinks to
    // zero as they retire, which is what ends the loop.
    [&live_vus] () { return live_vus; },
    [type, duration_ms, &live_vus] (int64_t elapsed) {
        return *type == LoadTestType::Iterations ? live_vus > 0 : elapsed < duration_ms;
    });

    return state;
}

} // namespace vayu::core
