/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `timer.pacing` (#1498): holds a steady cadence for a request, a folder or the
 * collection ("start this node every N ms") across iterations, whatever the
 * node's own duration was.
 *
 * The element is inherited into every request under its scope
 * (`request_composer.cpp`'s `compose_elements`), so it would run once per
 * request rather than once per pass through the scope. `scenario_plan.cpp`
 * marks, per element id across the iteration's step sequence, the one
 * occurrence that is the node's entry (`config._scopeEntry`, the first in plan
 * order); every other occurrence is a no-op.
 *
 * Runs in `step.before`, not `step.between`: the wait belongs to the next
 * pass's entry, measured from the previous pass's entry, so it must land before
 * that entry is sent; a folder's last step can be an unrelated request with no
 * pacing element. A scenario load run fires `step.before` once the VU was
 * already selected as ready, too late to defer without blocking, so
 * `scheduled_ready_delay_ms` schedules the wait at the previous step's
 * completion and records the next "last started" time there; `apply`'s own
 * `step.before` call under load only confirms.
 *
 * `perUser: false` (one cadence for every virtual user, JMeter's "All threads"
 * pacing) equals `perUser: true` in the sequential run, whose one user reads
 * and writes the one `ElementContext::pacing_state` map. Under a scenario load
 * run (#1570) it advances a run-scoped `SharedPacingClocks` entry by
 * compare-exchange instead of the per-VU map: the same "last deadline plus
 * everyMs" math on one atomic, so two VUs' concurrent completions never take
 * the same slot and neither blocks the producer thread on a lock.
 * `scheduled_ready_delay_ms` makes that split; `apply`'s `blocking_allowed`
 * branch never runs under load, so it never needs to know.
 *
 * The interval arithmetic (the blocking wait, the per-VU booking) is in
 * `pacing_math.hpp`, shared with `timer.throughput` (#1571), which states the
 * same intent as a rate.
 */

#include "vayu/core/element_defaults.hpp"
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
      per_user_ (config_.value ("perUser", element_defaults::TIMER_PACING_PER_USER)) {
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
        // This hook runs before any step's `ElementContext` exists, so the
        // run-level `elements.timers` override comes from
        // `shared.timers_override` (#1498's reopen), through the
        // `apply_timers_override` every `timer.*` kind's `apply` calls (#1620).
        // `"off"` books no wait and touches neither `pacing_state` nor the
        // shared clock; `"fixedMs"` / `{"minMs", "maxMs"}` replace `every_ms_`
        // before either branch below advances anything, the "replaced, not
        // merged" rule `apply` follows.
        const auto interval_ms =
        apply_timers_override (shared.timers_override, every_ms_, shared.rng);
        if (!interval_ms) {
            return std::nullopt;
        }
        if (!per_user_) {
            // One cadence across every virtual user (#1570). `shared.pacing` is
            // never null here: the plan scan that found this element's id sized
            // it.
            return shared.pacing != nullptr ?
            shared.pacing->advance (element_id_, *interval_ms, now_ms) :
            int64_t{ 0 };
        }
        return detail::advance_per_user_pacing (
        pacing_state, element_id_, *interval_ms, now_ms);
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
    // `_elementId` / `_scopeEntry` are absent on purpose: this schema gates
    // what a client may write, and `additionalProperties: false` keeps both out
    // of a stored element. `compile_elements` and `scenario_plan.cpp` stamp
    // them later, into the config `compile` receives at plan resolution, which
    // this schema never re-checks.
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "everyMs",
          { { "type", "integer" }, { "minimum", 1 }, { "title", "Cadence" }, { "x-vayu-unit", "ms" },
          { "description",
          "How often this node starts, start to start, in "
          "milliseconds." } } },
        { "perUser",
        { { "type", "boolean" }, { "default", element_defaults::TIMER_PACING_PER_USER },
        { "title", "Per user" }, { "x-vayu-group", "advanced" },
        { "description",
        "Paces each virtual user independently instead of sharing "
        "one cadence across all of them." } } } } },
        { "required", { "everyMs" } },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
