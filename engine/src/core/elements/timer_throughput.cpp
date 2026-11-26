/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `timer.throughput` (#1571): holds a request, a folder or the collection to a
 * target rate ("50 checkouts per minute") rather than a fixed gap between
 * passes.
 *
 * The rate-based sibling of `timer.pacing` (#1498). What they share (which
 * occurrence of an inherited element is its node's entry, `config._scopeEntry`
 * from `scenario_plan.cpp`'s `mark_scope_entries` for every
 * `tracks_scope_occurrence` kind; why the wait is in `step.before`; why the
 * load path schedules it through `scheduled_ready_delay_ms`) is stated in
 * `timer_pacing.cpp`'s file comment and implemented once in `pacing_math.hpp`.
 *
 * What differs is `perUser`, defaulting the other way. A cadence is a property
 * of one user's journey, so `timer.pacing` is per user; a throughput target is
 * a property of the system under test ("50 checkouts per minute across all
 * users"), so here `perUser: false` is the default.
 *
 * - `perUser: true` turns the rate into one interval per user
 *   (`60000 / targetPerMinute`) and runs `timer.pacing`'s per-VU arithmetic, so
 *   N users produce N times the rate.
 * - `perUser: false` shares one budget across a scenario load run's virtual
 *   users through `SharedThroughputBudgets`, a token bucket whose fractional
 *   remainder carries between claims. The sequential run's one user makes the
 *   cases identical (both use the one `ElementContext::pacing_state` map), so
 *   `apply` never needs to know which it is.
 */

#include "vayu/core/element_defaults.hpp"
#include "vayu/core/elements.hpp"

#include "pacing_math.hpp"

#include <algorithm>
#include <cmath>

namespace vayu::core {

namespace {

/// Requests per minute as the per-user gap between passes, floored at 1ms: the
/// load path schedules in whole milliseconds, so a per-user rate above
/// 60000/min cannot be paced more finely.
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
      per_user_ (config_.value ("perUser", element_defaults::TIMER_THROUGHPUT_PER_USER)) {
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
        // The run-level `elements.timers` override comes from
        // `shared.timers_override`, for the reason `timer_pacing.cpp` gives
        // (#1498's reopen, `Fixed` / `Range` from #1620):
        // `apply_timers_override` returns an interval in milliseconds that
        // replaces `every_ms_` before either branch advances anything.
        const auto interval_ms =
        apply_timers_override (shared.timers_override, every_ms_, shared.rng);
        if (!interval_ms) {
            return std::nullopt;
        }
        if (!per_user_) {
            // One rate across every virtual user. `shared.throughput` is never
            // null here: the plan scan that found this element's id sized it.
            // `claim` wants a rate per second: un-overridden
            // (`interval_ms == every_ms_`), it is the configured rate itself,
            // not one derived from the rounded `every_ms_`, so accuracy is
            // unchanged. A `fixedMs` / `minMs`-`maxMs` override converts its
            // interval to the equivalent rate, floored as `every_ms_for` floors
            // the other way so a near-zero interval cannot make an unbounded
            // rate.
            const bool overridden = shared.timers_override != nullptr &&
            (shared.timers_override->mode == TimersOverride::Mode::Fixed ||
            shared.timers_override->mode == TimersOverride::Mode::Range);
            const double rate_per_second = overridden ?
            1000.0 / static_cast<double> (std::max<int64_t> (1, *interval_ms)) :
            target_per_minute_ / 60.0;
            return shared.throughput != nullptr ?
            shared.throughput->claim (element_id_, rate_per_second, now_ms) :
            int64_t{ 0 };
        }
        return detail::advance_per_user_pacing (
        pacing_state, element_id_, *interval_ms, now_ms);
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
    // `_elementId` / `_scopeEntry` are absent on purpose and
    // `additionalProperties: false` keeps a client from writing them;
    // `timer_pacing.cpp`'s schema comment has the rule.
    kind.config_schema = {
        { "type", "object" },
        { "properties",
        { { "targetPerMinute",
          { { "type", "number" }, { "exclusiveMinimum", 0 }, { "title", "Target rate" },
          { "description", "The number of times this node should start per minute." } } },
        { "perUser",
        { { "type", "boolean" }, { "default", element_defaults::TIMER_THROUGHPUT_PER_USER },
        { "title", "Per user" }, { "x-vayu-group", "advanced" },
        { "description",
        "Applies the target rate to each virtual user independently "
        "instead of sharing one budget across all of them." } } } } },
        { "required", { "targetPerMinute" } },
        { "additionalProperties", false },
    };
    return kind;
}

} // namespace vayu::core
