/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file timer_throughput.cpp
 * @brief `timer.throughput` (issue #1571): holds a request, a folder or the
 *        collection to a target rate - "50 checkouts per minute" - rather
 *        than to a fixed gap between passes.
 *
 * The rate-based sibling of `timer.pacing` (issue #1498), which states the
 * same intent as an interval. Everything the two share - which occurrence of
 * an inherited element is its node's actual entry (`config._scopeEntry`,
 * stamped by `scenario_plan.cpp`'s `mark_scope_entries` for every
 * `tracks_scope_occurrence` kind), why the wait belongs to `step.before`
 * rather than `step.between`, and why the load path schedules it through
 * `scheduled_ready_delay_ms` instead of blocking inside `apply` - is stated
 * in `timer_pacing.cpp`'s file comment and implemented once in
 * `pacing_math.hpp`.
 *
 * What differs is `perUser`, and it defaults the other way round here.
 * `timer.pacing` is a per-user cadence by default because a cadence is a
 * property of one user's journey; a throughput target is a property of the
 * *system under test* - "50 checkouts per minute across all users" is the
 * case this kind exists for - so `perUser: false` is the default, and the
 * per-user reading is the opt-in.
 *
 * - `perUser: true` divides the rate into one interval per user
 *   (`60000 / targetPerMinute`) and runs the identical per-VU arithmetic
 *   `timer.pacing` runs, so N users produce N times the rate. Nothing here
 *   re-derives that math.
 * - `perUser: false` (the default) shares one budget across every virtual
 *   user of a scenario load run through `SharedThroughputBudgets`, a token
 *   bucket whose fractional remainder carries between claims - the same
 *   accounting `load_pacing.hpp`'s `take_due_requests` does open-loop for the
 *   whole run, applied closed-loop to one scenario node. Under the sequential
 *   run a single virtual user makes the two cases indistinguishable (both
 *   read and write the one map `ElementContext::pacing_state` binds there),
 *   which is why `apply` below never has to know which case it is.
 */

#include "vayu/core/elements.hpp"

#include "pacing_math.hpp"

#include <algorithm>
#include <cmath>

namespace vayu::core {

namespace {

/// Requests per minute as the per-user gap between passes, floored at 1ms:
/// the load path schedules in whole milliseconds, so a per-user rate above
/// 60000/min cannot be paced more finely than that regardless of what the
/// arithmetic says.
int64_t every_ms_for (double target_per_minute) {
    if (!(target_per_minute > 0.0)) {
        return 0; // Refused by the schema; a run reaching here waits nowhere.
    }
    return std::max<int64_t> (1, std::llround (60000.0 / target_per_minute));
}

class TimerThroughputElement final : public Element {
    public:
    explicit TimerThroughputElement (nlohmann::json config)
    : config_ (std::move (config)),
      element_id_ (config_.value ("_elementId", std::string{})),
      scope_entry_ (config_.value ("_scopeEntry", false)),
      target_per_minute_ (config_.value ("targetPerMinute", 0.0)),
      every_ms_ (every_ms_for (target_per_minute_)),
      per_user_ (config_.value ("perUser", false)) {
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
        // The run-level `elements.timers` override is consulted through
        // `shared.timers_override`, for the reason `timer_pacing.cpp`'s own
        // comment states (issue #1498's reopen).
        if (shared.timers_override != nullptr &&
        shared.timers_override->mode == TimersOverride::Mode::Off) {
            return std::nullopt;
        }
        if (!per_user_) {
            // One rate shared across every virtual user: `shared.throughput`
            // is always non-null here, sized by the plan scan that found this
            // very element's id in the first place.
            return shared.throughput != nullptr ?
            shared.throughput->claim (element_id_, target_per_minute_ / 60.0, now_ms) :
            int64_t{ 0 };
        }
        return detail::advance_per_user_pacing (pacing_state, element_id_, every_ms_, now_ms);
    }

    private:
    nlohmann::json config_;
    std::string element_id_;
    bool scope_entry_;
    double target_per_minute_;
    int64_t every_ms_;
    bool per_user_;
};

} // namespace

ElementKind make_timer_throughput_kind () {
    ElementKind kind;
    kind.kind    = "timer.throughput";
    kind.version = 1;
    kind.phases  = { Phase::StepBefore };
    kind.label   = "Throughput";
    kind.description =
    "Holds this request, folder or collection to a target rate - N per minute "
    "- shared across every virtual user unless perUser is set.";
    kind.category                = "timer";
    kind.hot_path                = HotPathClass::Declarative;
    kind.tracks_scope_occurrence = true;
    kind.compile = [] (const nlohmann::json& config) -> std::unique_ptr<Element> {
        return std::make_unique<TimerThroughputElement> (config);
    };
    // `_elementId` / `_scopeEntry` are deliberately absent, and
    // `additionalProperties: false` is what keeps them unwritable by a client
    // - see `timer_pacing.cpp`'s schema comment for the whole rule.
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "targetPerMinute", { { "type", "number" }, { "exclusiveMinimum", 0 } } },
        { "perUser", { { "type", "boolean" } } } } },
        { "required", { "targetPerMinute" } },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
