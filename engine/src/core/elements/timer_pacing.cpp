/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file timer_pacing.cpp
 * @brief `timer.pacing` (issue #1498): holds a steady cadence for a request,
 *        a folder or the collection - "start this node every N ms" - across
 *        iterations, whatever the node's own duration was.
 *
 * Attached to a request, a folder or the collection, the same element is
 * inherited into every request under its scope (`request_composer.cpp`'s
 * `compose_elements`), so it would otherwise run once per request rather
 * than once per pass through its scope. `scenario_plan.cpp` resolves that:
 * before compiling a step's elements, it marks - per element id, across the
 * whole iteration's step sequence - which single occurrence is that node's
 * actual entry (`config._scopeEntry`, the first occurrence in plan order).
 * Every other occurrence is a harmless no-op here.
 *
 * Runs in `step.before`, not `step.between`: the wait belongs to the *next*
 * pass's entry, measured from the *previous* pass's entry, so it must land
 * before that entry step is sent, not after the step before it - a
 * folder's own last step can be a different, unrelated request with no
 * pacing element of its own at all. Because `step.before` already fires
 * once a scenario load run's VU has been selected as ready, blocking there
 * would be too late to defer non-blockingly; `scheduled_ready_delay_ms` is
 * how the load path schedules the wait *before* selection, at the previous
 * step's completion, and it is also where the next "last started" timestamp
 * is recorded - `apply`'s own `step.before` call under load is then a
 * confirming no-op.
 *
 * `perUser: false` (one shared cadence for every virtual user, JMeter's "All
 * threads" pacing) is accepted for the sequential run, where a single
 * virtual user makes it indistinguishable from `perUser: true`, but refused
 * for a scenario load run: coordinating a shared deadline across many VUs
 * without either blocking a producer thread or racing two VUs onto the same
 * slot is a materially different piece of work than the per-VU case this
 * issue's acceptance criteria ask for, and is tracked as its own follow-up
 * rather than rushed into this kind. `validate_scenario_load_config`
 * (`scenario_load.cpp`) is where that refusal lives, not here, because only
 * the plan resolver knows a run is a load run at all.
 */

#include "vayu/core/elements.hpp"

#include <algorithm>
#include <chrono>
#include <thread>

namespace vayu::core {

namespace {

constexpr auto POLL_INTERVAL = std::chrono::milliseconds (50);

int64_t steady_now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now ().time_since_epoch ())
    .count ();
}

/// `deadline - now`, clamped to never negative and never below `everyMs`
/// having elapsed - "a step longer than everyMs continues at once" (issue
/// #1498's acceptance criteria), not with a negative wait.
int64_t remaining_wait_ms (int64_t last_started_ms, int64_t every_ms, int64_t now_ms) {
    if (last_started_ms <= 0) {
        return 0; // Never started before - the first pass is never delayed.
    }
    return std::max<int64_t> (0, last_started_ms + every_ms - now_ms);
}

class TimerPacingElement final : public Element {
    public:
    explicit TimerPacingElement (nlohmann::json config)
    : config_ (std::move (config)),
      element_id_ (config_.value ("_elementId", std::string{})),
      scope_entry_ (config_.value ("_scopeEntry", false)),
      every_ms_ (config_.value ("everyMs", int64_t{ 0 })) {
    }

    [[nodiscard]] Phase phase () const override {
        return Phase::StepBefore;
    }

    void apply (ElementContext& ctx) override {
        if (!scope_entry_) {
            ctx.outcome_status  = "skipped";
            ctx.outcome_message = "not this node's start (inherited into a "
                                  "later step of the same pass)";
            return;
        }

        const auto overridden =
        apply_timers_override (ctx.timers_override, every_ms_, ctx.rng);
        if (!overridden) {
            ctx.outcome_status    = "ok";
            ctx.outcome_waited_ms = 0;
            return;
        }
        const int64_t every_ms = *overridden;

        if (!ctx.blocking_allowed) {
            // The wait already happened through `scheduled_ready_delay_ms`
            // deferring the VU before this step was ever dispatched - this
            // call only confirms the outcome, and must not re-touch
            // `pacing_state` or it would double-book the next pass's wait.
            ctx.outcome_status    = "ok";
            ctx.outcome_waited_ms = 0;
            return;
        }

        const int64_t now = steady_now_ms ();
        const int64_t last_started =
        ctx.pacing_state ? (*ctx.pacing_state)[element_id_] : 0;
        const int64_t wait_ms = remaining_wait_ms (last_started, every_ms, now);
        const auto deadline =
        std::chrono::steady_clock::now () + std::chrono::milliseconds (wait_ms);
        while (wait_ms > 0) {
            if (ctx.should_stop && ctx.should_stop ()) {
                break;
            }
            const auto remaining = deadline - std::chrono::steady_clock::now ();
            if (remaining <= std::chrono::steady_clock::duration::zero ()) {
                break;
            }
            std::this_thread::sleep_for (
            std::min<std::chrono::steady_clock::duration> (POLL_INTERVAL, remaining));
        }

        if (ctx.pacing_state) {
            (*ctx.pacing_state)[element_id_] = steady_now_ms ();
        }
        ctx.outcome_status    = "ok";
        ctx.outcome_waited_ms = wait_ms;
    }

    [[nodiscard]] std::optional<int64_t> scheduled_ready_delay_ms (
    std::unordered_map<std::string, int64_t>& pacing_state,
    int64_t now_ms) const override {
        if (!scope_entry_) {
            return std::nullopt;
        }
        // The run-level `elements.timers` override cannot reach this call:
        // it is bound on `ElementContext`, which the load path's pre-select
        // scheduling hook does not carry (it runs before any step's
        // `ElementContext` exists). A run that silences timers with `off`
        // still defers a scenario load run's pacing element by its own
        // `everyMs` here; `apply`'s own override check then reports the
        // outcome truthfully once the (already-elapsed) wait is confirmed.
        // Disclosed in the PR as a known load-path limitation of the
        // override, not present on the sequential run.
        const int64_t last_started = pacing_state[element_id_];
        const int64_t deadline = last_started <= 0 ? now_ms : last_started + every_ms_;
        pacing_state[element_id_] = deadline;
        return std::max<int64_t> (0, deadline - now_ms);
    }

    private:
    nlohmann::json config_;
    std::string element_id_;
    bool scope_entry_;
    int64_t every_ms_;
};

} // namespace

ElementKind make_timer_pacing_kind () {
    ElementKind kind;
    kind.kind    = "timer.pacing";
    kind.version = 1;
    kind.phases  = { Phase::StepBefore };
    kind.label   = "Pacing";
    kind.description =
    "Holds this request, folder or collection to a steady start-to-start "
    "cadence across iterations, whatever its own duration was.";
    kind.category                = "timer";
    kind.hot_path                = HotPathClass::Declarative;
    kind.tracks_scope_occurrence = true;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<TimerPacingElement> (config);
    };
    // `_elementId` / `_scopeEntry` are deliberately absent here: this schema
    // gates what a client may write, and `additionalProperties: false`
    // refuses both names from ever reaching a stored element - they are
    // stamped only afterwards, by `compile_elements` and `scenario_plan.cpp`
    // respectively, directly into the config object `compile` receives at
    // plan-resolution time, which this schema never re-checks (see the file
    // comment).
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "everyMs", { { "type", "integer" }, { "minimum", 1 } } },
        { "perUser", { { "type", "boolean" } } } } },
        { "required", { "everyMs" } },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
