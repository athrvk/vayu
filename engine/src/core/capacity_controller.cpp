/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/capacity_controller.hpp"

#include <algorithm>
#include <cmath>

#include "vayu/core/constants.hpp"

namespace vayu::core {

namespace {

bool breaches (const CapacityWindow& window, double slo_ms) {
    return window.p99_ms > slo_ms;
}

/**
 * The history with each level represented once, by its *last* window.
 *
 * A held level appears twice - the window that breached and the re-measure
 * that cleared it - and the plateau check compares throughput across step-ups,
 * so counting a hold as a step would compare a level against itself and call
 * every re-measure a plateau.
 */
std::vector<CapacityWindow> per_level (const std::vector<CapacityWindow>& history) {
    std::vector<CapacityWindow> levels;
    for (const auto& window : history) {
        if (!levels.empty () && levels.back ().concurrency == window.concurrency) {
            levels.back () = window;
        } else {
            levels.push_back (window);
        }
    }
    return levels;
}

/// True when the last two step-ups bought less than `plateau_gain_pct` more
/// throughput. Needs three distinct, strictly increasing levels; anything less
/// is not yet an answer, and a non-positive baseline rps has no percentage.
bool plateaued (const CapacityConfig& config, const std::vector<CapacityWindow>& levels) {
    if (levels.size () < 3) {
        return false;
    }
    const auto& base = levels[levels.size () - 3];
    const auto& mid  = levels[levels.size () - 2];
    const auto& top  = levels[levels.size () - 1];
    if (!(base.concurrency < mid.concurrency && mid.concurrency < top.concurrency)) {
        return false;
    }
    if (!(base.rps > 0.0)) {
        return false;
    }
    const double gain_pct = (top.rps - base.rps) * 100.0 / base.rps;
    return gain_pct < config.plateau_gain_pct;
}

size_t next_level_above (const CapacityConfig& config, size_t current) {
    const double grown = static_cast<double> (current) * (1.0 + config.step_growth);
    size_t next        = current + 1;
    if (std::isfinite (grown) && grown > static_cast<double> (next)) {
        next = static_cast<size_t> (grown);
    }
    return std::min (next, config.max_concurrency);
}

} // namespace

CapacityDecision
decide_next_level (const CapacityConfig& config, const std::vector<CapacityWindow>& history) {
    if (history.empty ()) {
        return { CapacityAction::StepUp, config.start_concurrency, nullptr };
    }

    const CapacityWindow& last = history.back ();

    size_t trailing_breaches = 0;
    for (auto it = history.rbegin (); it != history.rend (); ++it) {
        if (!breaches (*it, config.slo_ms)) {
            break;
        }
        ++trailing_breaches;
    }

    if (trailing_breaches >= config.slo_breach_windows) {
        return { CapacityAction::Stop, last.concurrency, capacity_stop::SLO_EXCEEDED };
    }
    if (trailing_breaches > 0) {
        // One breaching window is a suspicion, not a verdict: re-measure the
        // same level rather than ending the search on a GC pause.
        return { CapacityAction::Hold, last.concurrency, nullptr };
    }

    // Plateau is checked before the cap because it says something about the
    // *service* - it stopped converting concurrency into work - while the cap
    // only says the search ran out of room the caller gave it. When both hold,
    // the first is the more useful answer.
    if (plateaued (config, per_level (history))) {
        return { CapacityAction::Stop, last.concurrency, capacity_stop::PLATEAU };
    }
    if (last.concurrency >= config.max_concurrency) {
        return { CapacityAction::Stop, last.concurrency, capacity_stop::CAP_REACHED };
    }

    return { CapacityAction::StepUp, next_level_above (config, last.concurrency), nullptr };
}

CapacitySummary summarize_capacity (const CapacityConfig& config,
const std::vector<CapacityWindow>& history,
const char* stop_reason) {
    CapacitySummary summary;
    summary.slo_ms      = config.slo_ms;
    summary.stop_reason = stop_reason != nullptr ? stop_reason : "";
    summary.levels      = history;

    for (const auto& window : history) {
        if (breaches (window, config.slo_ms)) {
            continue;
        }
        if (!summary.max_healthy || window.concurrency >= summary.max_healthy->concurrency) {
            summary.max_healthy = window;
        }
    }

    // A knee is only ever reported for the stop that observed one. A run that
    // ended at its cap, its deadline, or on a plateau inside the budget never
    // saw the service give out, and naming its last level "the knee" would
    // claim a limit nothing measured.
    if (summary.stop_reason == capacity_stop::SLO_EXCEEDED && !history.empty ()) {
        summary.knee = history.back ();
    }

    return summary;
}

nlohmann::json build_capacity_summary_payload (const CapacitySummary& summary) {
    nlohmann::json levels = nlohmann::json::array ();
    for (const auto& level : summary.levels) {
        levels.push_back ({ { "concurrency", level.concurrency }, { "rps", level.rps },
            { "p99_ms", level.p99_ms } });
    }

    nlohmann::json payload;
    payload["slo_ms"]      = summary.slo_ms;
    payload["stop_reason"] = summary.stop_reason;
    payload["levels"]      = levels;
    // Both halves are omitted rather than zeroed when they were not observed -
    // "the first level already breached" and "the service sustained nothing"
    // are different findings, and only the absent key can say the first.
    if (summary.max_healthy) {
        payload["max_healthy_concurrency"] = summary.max_healthy->concurrency;
        payload["max_healthy_rps"]         = summary.max_healthy->rps;
        payload["p99_at_max_healthy_ms"]   = summary.max_healthy->p99_ms;
    }
    if (summary.knee) {
        payload["knee_concurrency"] = summary.knee->concurrency;
        payload["knee_p99_ms"]      = summary.knee->p99_ms;
    }
    return payload;
}

CapacityConfig capacity_config_from (const nlohmann::json& config,
int64_t step_duration_ms,
int64_t deadline_ms) {
    namespace defaults = constants::capacity;

    CapacityConfig out;
    out.step_duration_ms = step_duration_ms > 0 ? step_duration_ms : defaults::STEP_DURATION_MS;
    out.deadline_ms      = deadline_ms;
    out.step_growth      = defaults::STEP_GROWTH;
    out.plateau_gain_pct = defaults::PLATEAU_GAIN_PCT;
    out.slo_breach_windows = defaults::SLO_BREACH_WINDOWS;

    // Read through an explicit type check rather than `json::value`, which
    // *throws* on a key holding the wrong type. The route rejects those, but
    // this also reads stored config snapshots, which no route ever saw.
    auto number = [&config] (const char* key, double fallback) {
        if (!config.is_object () || !config.contains (key) || !config[key].is_number ()) {
            return fallback;
        }
        const double value = config[key].get<double> ();
        return std::isfinite (value) && value > 0.0 ? value : fallback;
    };

    out.slo_ms = number ("sloMs", static_cast<double> (defaults::SLO_MS));

    const double start = number ("startConcurrency", 1.0);
    const double cap   = number ("concurrency", static_cast<double> (defaults::MAX_CONCURRENCY));

    out.start_concurrency = static_cast<size_t> (start);
    out.max_concurrency   = static_cast<size_t> (cap);
    // A cap below the start is a search with nowhere to go; it runs the one
    // level and stops `cap_reached` rather than climbing past the ceiling.
    out.max_concurrency = std::max (out.max_concurrency, out.start_concurrency);
    return out;
}

} // namespace vayu::core
