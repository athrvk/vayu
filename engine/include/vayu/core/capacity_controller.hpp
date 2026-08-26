#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file capacity_controller.hpp
 * @brief Pure core for the capacity-discovery run mode: given what each
 *        concurrency level measured, what level to run next and when to stop.
 *
 * Finding a service's capacity used to be manual bisection - guess a
 * `concurrency`, run a ramp, read the dashboard, adjust, repeat. Every other
 * strategy's `target_fn` is a pure function of elapsed time and constants, so
 * none of them can react to what latency is doing; this file is the feedback
 * half that lets one of them.
 *
 * The controller is deliberately split out of the strategy the way
 * `load_pacing` and `threshold_eval` are: it holds no clock, no metrics
 * collector and no run context, so its whole policy is unit-testable without a
 * server. The strategy owns the clock (the deadline stop lives there, because
 * only it knows elapsed time) and feeds one @ref CapacityWindow per completed
 * level in here.
 */

#include <cstddef>
#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace vayu::core {

/// What one concurrency level measured while it was held.
struct CapacityWindow {
    size_t concurrency = 0;
    /// Mean throughput observed over the level's settled ticks.
    double rps = 0.0;
    /// Mean of the level's windowed p99 samples - the signal the SLO is judged
    /// against, and the same number the dashboard's live chart shows.
    double p99_ms = 0.0;
};

/// The search's tunables. The first five come off the run config; the rest are
/// policy constants (`constants::capacity`) exposed as fields so the tests can
/// vary them without a config knob nobody asked for.
struct CapacityConfig {
    /// Latency budget the search is looking for the edge of, in ms.
    double slo_ms = 200.0;
    /// How long each level is held before its window is judged.
    int64_t step_duration_ms = 5000;
    /// The level the search starts at.
    size_t start_concurrency = 1;
    /// The ceiling the search will not climb past.
    size_t max_concurrency = 100;
    /// Wall-clock budget for the whole search. Enforced by the strategy, not
    /// here - this struct carries it so one object describes the whole run.
    int64_t deadline_ms = 60000;
    /// Fractional growth per healthy step, floored at +1 concurrency.
    double step_growth = 0.25;
    /// Below this percentage of throughput gained across the last two step-ups,
    /// the service is saturated even though it is still inside the SLO.
    double plateau_gain_pct = 5.0;
    /// Consecutive breaching windows before the search stops. Two, not one, so
    /// a single noisy window re-measures instead of ending the run.
    size_t slo_breach_windows = 2;
};

enum class CapacityAction : std::uint8_t { Hold, StepUp, Stop };

/// Stop reasons, as they appear in the report's `capacity.stopReason`. Named
/// constants rather than string literals at each `return`, so the report, the
/// tests and the logs cannot spell them three ways.
namespace capacity_stop {
inline constexpr const char* SLO_EXCEEDED = "slo_exceeded";
inline constexpr const char* PLATEAU      = "plateau";
inline constexpr const char* CAP_REACHED  = "cap_reached";
inline constexpr const char* DEADLINE     = "deadline";
/// The operator stopped the run before the search reached a conclusion. Not one
/// of the four the search decides for itself, and deliberately distinct from
/// `deadline`: a cancelled search found no limit, and saying it ran out of
/// clock would claim a measurement that was never taken.
inline constexpr const char* STOPPED = "stopped";
} // namespace capacity_stop

struct CapacityDecision {
    CapacityAction action = CapacityAction::StepUp;
    /// The level to run next. Meaningful for `Hold` and `StepUp`; left at the
    /// last level for `Stop`.
    size_t next_concurrency = 0;
    /// Set iff `action == Stop`; one of `capacity_stop::*`. A `const char*`
    /// because every value is a literal with static storage duration.
    const char* stop_reason = nullptr;
};

/**
 * @brief Decide what the search does after the windows in @p history.
 *
 * Total over any history, including an empty one (which answers "start at
 * `start_concurrency`"), so the strategy has no special first-step branch.
 *
 * The policy, in the order it is applied:
 * - `slo_breach_windows` consecutive breaching windows → stop `slo_exceeded`.
 * - a single breaching window → **hold** the same level and re-measure. The
 *   consecutive requirement is the whole reason `Hold` exists: one unlucky
 *   window (a GC pause, a cold cache) is not a capacity limit.
 * - throughput gained across the last two step-ups below `plateau_gain_pct`
 *   → stop `plateau`. The service is inside its latency budget and no longer
 *   converting concurrency into work, which is a capacity limit too.
 * - already at `max_concurrency` → stop `cap_reached`.
 * - otherwise step up by `step_growth`, at least +1, clamped to the cap.
 *
 * The `deadline` stop is not decided here - it is time, and this function
 * holds no clock. @ref summarize_capacity takes the reason from the caller for
 * the same reason.
 */
[[nodiscard]] CapacityDecision decide_next_level (const CapacityConfig& config,
const std::vector<CapacityWindow>& history);

/// The answer a capacity run exists to give, plus the audit trail behind it.
struct CapacitySummary {
    double slo_ms = 0.0;
    std::string stop_reason;
    /// The highest level that stayed inside the SLO, and what it did there.
    /// Absent when the very first level already breached - the search never
    /// found a healthy level, and reporting zero would read like one.
    std::optional<CapacityWindow> max_healthy;
    /// The level the service gave out at: the first breaching level above
    /// `max_healthy`. Absent when the search ended for a reason other than
    /// latency (a cap, a deadline, a plateau inside the budget) - there is no
    /// knee to report, and inventing one from the last level would claim a
    /// limit that was never observed.
    std::optional<CapacityWindow> knee;
    /// One entry per level held, in order, including a re-measured hold.
    std::vector<CapacityWindow> levels;
};

/**
 * @brief Derive the headline numbers from the levels the search held.
 *
 * @param stop_reason Why the search ended, one of `capacity_stop::*`. Taken
 *        rather than re-derived: only the caller knows whether the run ran out
 *        of clock, and re-deriving it here could disagree with the decision
 *        that actually ended the loop.
 */
[[nodiscard]] CapacitySummary summarize_capacity (const CapacityConfig& config,
const std::vector<CapacityWindow>& history,
const char* stop_reason);

/// Serialize a summary into the object stored under the run summary's
/// `capacity` key (snake_case, like every other stored section).
[[nodiscard]] nlohmann::json build_capacity_summary_payload (const CapacitySummary& summary);

/**
 * @brief Read the capacity fields off a run config, clamped to something the
 *        search can actually run.
 *
 * Total over arbitrary JSON: the route validates a client body, but a stored
 * config snapshot may have been written by an older engine or hand-edited, and
 * a start above the cap is a search with nowhere to go rather than an error the
 * run thread can usefully throw on. `duration` and `stepDuration` are read by
 * the caller (they go through `duration_field_ms`, which throws on a malformed
 * unit) and passed in.
 */
[[nodiscard]] CapacityConfig capacity_config_from (const nlohmann::json& config,
int64_t step_duration_ms,
int64_t deadline_ms);

} // namespace vayu::core
