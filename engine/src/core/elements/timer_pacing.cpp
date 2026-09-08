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
 * virtual user makes it indistinguishable from `perUser: true` (both read
 * and write the one map `ElementContext::pacing_state` binds there). Under a
 * scenario load run (issue #1570) it instead advances a shared, run-scoped
 * `SharedPacingClocks` entry through a compare-exchange retry rather than
 * the per-VU `pacing_state` map `perUser: true` uses - the same "next
 * deadline is the last one plus everyMs" math, just applied to one atomic so
 * two VUs' concurrent completions never race onto the same slot and neither
 * ever blocks the producer thread for a lock. `scheduled_ready_delay_ms`
 * below is where that split is made; `apply`'s own `blocking_allowed` branch
 * never runs under load at all (see its own comment), so it never needs to
 * know which case it is.
 *
 * The interval arithmetic itself - the blocking wait, the per-VU deadline
 * booking - lives in `pacing_math.hpp`, shared with `timer.throughput`
 * (issue #1571), which states the same intent as a rate rather than a gap.
 */

#include "vayu/core/elements.hpp"

#include "pacing_math.hpp"

namespace vayu::core {

namespace {

class TimerPacingElement final : public Element {
    public:
    explicit TimerPacingElement (nlohmann::json config)
    : config_ (std::move (config)),
      element_id_ (config_.value ("_elementId", std::string{})),
      scope_entry_ (config_.value ("_scopeEntry", false)),
      every_ms_ (config_.value ("everyMs", int64_t{ 0 })),
      per_user_ (config_.value ("perUser", true)) {
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

        detail::apply_paced_wait (ctx, element_id_, every_ms_);
    }

    [[nodiscard]] std::optional<int64_t> scheduled_ready_delay_ms (
    std::unordered_map<std::string, int64_t>& pacing_state,
    const SharedScheduleState& shared,
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
        if (!per_user_) {
            // One cadence shared across every virtual user (issue #1570):
            // `shared.pacing` is always non-null here, sized by the plan
            // scan that found this very element's id in the first place.
            return shared.pacing != nullptr ?
            shared.pacing->advance (element_id_, every_ms_, now_ms) :
            int64_t{ 0 };
        }
        return detail::advance_per_user_pacing (pacing_state, element_id_, every_ms_, now_ms);
    }

    private:
    nlohmann::json config_;
    std::string element_id_;
    bool scope_entry_;
    int64_t every_ms_;
    bool per_user_;
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
