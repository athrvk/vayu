/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file timer_think.cpp
 * @brief `timer.think` (issue #1514, gaussian and the run override added by
 *        #1498): a fixed, uniform-random or gaussian-random wait between
 *        this step and the next.
 *
 * Runs in `step.between`, never `step.before` - the whole point is that the
 * wait does not count against this step's own latency. The sequential run's
 * wait polls `ElementContext::should_stop` on a short interval rather than
 * sleeping the whole span in one call, so a run stop lands within that
 * interval instead of at the end of a multi-second think time. A scenario
 * load run never blocks a thread for this wait at all: it reads
 * `scheduled_ready_delay_ms` instead and defers the VU through
 * `VirtualUser::ready_at_ms`, so `apply` there only records the outcome.
 */

#include "vayu/core/elements.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <random>
#include <thread>

namespace vayu::core {

namespace {

constexpr auto POLL_INTERVAL = std::chrono::milliseconds (50);

class TimerThinkElement final : public Element {
    public:
    explicit TimerThinkElement (nlohmann::json config)
    : config_ (std::move (config)) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepBetween;
    }

    void apply (ElementContext& ctx) override {
        const auto wait_ms = apply_timers_override (
        ctx.timers_override, resolve_own_wait_ms (ctx.rng), ctx.rng);
        if (!wait_ms || *wait_ms <= 0) {
            ctx.outcome_status    = "ok";
            ctx.outcome_waited_ms = 0;
            return;
        }

        if (ctx.blocking_allowed) {
            const auto deadline = std::chrono::steady_clock::now () +
            std::chrono::milliseconds (*wait_ms);
            while (true) {
                if (ctx.should_stop && ctx.should_stop ()) {
                    break;
                }
                const auto now = std::chrono::steady_clock::now ();
                if (now >= deadline) {
                    break;
                }
                std::this_thread::sleep_for (std::min<std::chrono::steady_clock::duration> (
                POLL_INTERVAL, deadline - now));
            }
        }
        // Under load (`!ctx.blocking_allowed`) the wait already happened
        // through `scheduled_ready_delay_ms` deferring the VU before this
        // step was dispatched at all - this call reports the outcome only.
        ctx.outcome_status    = "ok";
        ctx.outcome_waited_ms = wait_ms;
    }

    // No `scheduled_ready_delay_ms` override: unlike `timer.pacing`,
    // `timer.think` runs at `step.between`, which the load path dispatches
    // (with `blocking_allowed = false`) at the same point it would need to
    // pre-schedule anyway - `finish_step` sums the `StepBetween` outcomes'
    // `waited_ms` straight into `VirtualUser::ready_at_ms` itself, so no
    // kind-specific pre-scheduling hook is needed for this one.

    private:
    [[nodiscard]] long resolve_own_wait_ms (std::mt19937_64* rng) const {
        if (config_.contains ("gaussian")) {
            const auto& gaussian  = config_["gaussian"];
            const double mean_ms  = gaussian.value ("meanMs", 0.0);
            const double stdev_ms = gaussian.value ("deviationMs", 0.0);
            std::normal_distribution<double> dist (mean_ms, stdev_ms);
            const double drawn = rng != nullptr ? dist (*rng) : dist (fallback_rng ());
            return std::lround (std::max (0.0, drawn));
        }
        if (config_.contains ("minMs") || config_.contains ("maxMs")) {
            long min_ms = config_.value ("minMs", 0);
            long max_ms = config_.value ("maxMs", min_ms);
            if (max_ms < min_ms) {
                std::swap (min_ms, max_ms);
            }
            if (max_ms == min_ms) {
                return min_ms;
            }
            std::uniform_int_distribution<long> dist (min_ms, max_ms);
            return rng != nullptr ? dist (*rng) : dist (fallback_rng ());
        }
        return config_.value ("ms", 0L);
    }

    /// Unseeded, thread-local fallback for a caller with no run to be
    /// reproducible against (a design send) - the behaviour every draw here
    /// had before #1498 added `ElementContext::rng`.
    static std::mt19937& fallback_rng () {
        static thread_local std::mt19937 rng{ std::random_device{}() };
        return rng;
    }

    nlohmann::json config_;
};

} // namespace

ElementKind make_timer_think_kind () {
    ElementKind kind;
    kind.kind    = "timer.think";
    kind.version = 1;
    kind.phases  = { Phase::StepBetween };
    kind.label   = "Think time";
    kind.description =
    "Waits a fixed, uniformly random or gaussian-random span before the "
    "next step, outside this step's own latency.";
    kind.category = "timer";
    kind.hot_path = HotPathClass::Declarative;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<TimerThinkElement> (config);
    };
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "ms",
          { { "type", "integer" }, { "minimum", 0 }, { "title", "Wait" }, { "x-vayu-unit", "ms" },
          { "description", "A fixed wait, in milliseconds, before the next step." } } },
        { "minMs",
        { { "type", "integer" }, { "minimum", 0 }, { "title", "Minimum wait" }, { "x-vayu-unit", "ms" },
        { "description",
        "The lower bound of a uniformly random wait, in "
        "milliseconds." } } },
        { "maxMs",
        { { "type", "integer" }, { "minimum", 0 }, { "title", "Maximum wait" }, { "x-vayu-unit", "ms" },
        { "description",
        "The upper bound of a uniformly random wait, in "
        "milliseconds." } } },
        { "gaussian",
        { { "type", "object" }, { "title", "Gaussian wait" },
        { "description", "A randomly drawn wait following a normal distribution." },
        { "properties",
        { { "meanMs",
          { { "type", "number" }, { "minimum", 0 }, { "title", "Mean" }, { "x-vayu-unit", "ms" },
          { "description",
          "The average wait drawn from the distribution, in "
          "milliseconds." } } },
        { "deviationMs",
        { { "type", "number" }, { "minimum", 0 }, { "title", "Standard deviation" }, { "x-vayu-unit", "ms" },
        { "description",
        "How far a drawn wait typically varies from the mean, "
        "in milliseconds." } } } } },
        { "required", { "meanMs", "deviationMs" } }, { "additionalProperties", false } } } } },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
