/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/threshold_eval.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <string_view>

#include "vayu/core/run_manager.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

namespace {

/// Which way a budget is breached.
enum class Direction : std::uint8_t {
    AtMost,  ///< passes while `actual <= limit` (a ceiling)
    AtLeast, ///< passes while `actual >= limit` (a floor)
};

/// One budget: its wire key, the run figure it judges, and the range a client
/// may declare it in. Kept as data so the route's validation and the run's
/// verdict read the same row rather than two hand-written lists that drift -
/// the failure that would produce is silent, a key accepted and never checked.
struct ThresholdMetric {
    const char* key;
    Direction direction;
    double min_limit;
    /// Whether `min_limit` itself is a legal budget. True only for the error
    /// rate: "no request may fail" is a real ask, where a latency ceiling or a
    /// throughput floor of zero is a typo rather than an intent.
    bool min_inclusive;
    double max_limit;
    const char* range; // the accepted span, spelled for the rejection message
    const char* why;   // appended to a rejection, explains the bound
    double (*measured) (const RunSummaryInputs&);
};

/// Share of this run's requests that did not succeed, as a percentage - the
/// same figure `GET /runs/:id/report` prints, derived the same way (from the
/// status distribution, so the transport failures recorded under code 0 count).
double measured_error_rate (const RunSummaryInputs& inputs) {
    if (inputs.total_requests == 0) {
        return 0.0;
    }
    size_t failed = 0;
    for (const auto& [code, count] : inputs.status_codes) {
        if (!vayu::is_success_status (code)) {
            failed += count;
        }
    }
    return static_cast<double> (failed) * 100.0 / static_cast<double> (inputs.total_requests);
}

constexpr double MAX_LATENCY_BUDGET_MS = 86400000.0; // a day; past it nothing completes
constexpr double MAX_THROUGHPUT_BUDGET_RPS = 1e9;

/// Every budget a run may declare, in the order the report lists them.
const std::array<ThresholdMetric, 5>& metrics () {
    static const std::array<ThresholdMetric, 5> table = { {
    { "latencyP50Ms", Direction::AtMost, 0.0, false, MAX_LATENCY_BUDGET_MS,
    "greater than 0 and at most 86400000", "It is a latency ceiling in milliseconds.",
    [] (const RunSummaryInputs& in) { return in.latency.p50; } },
    { "latencyP95Ms", Direction::AtMost, 0.0, false, MAX_LATENCY_BUDGET_MS,
    "greater than 0 and at most 86400000", "It is a latency ceiling in milliseconds.",
    [] (const RunSummaryInputs& in) { return in.latency.p95; } },
    { "latencyP99Ms", Direction::AtMost, 0.0, false, MAX_LATENCY_BUDGET_MS,
    "greater than 0 and at most 86400000", "It is a latency ceiling in milliseconds.",
    [] (const RunSummaryInputs& in) { return in.latency.p99; } },
    { "maxErrorRatePct", Direction::AtMost, 0.0, true, 100.0, "between 0 and 100",
    "It is a percentage of the run's requests.", measured_error_rate },
    { "minThroughputRps", Direction::AtLeast, 0.0, false, MAX_THROUGHPUT_BUDGET_RPS,
    "greater than 0 and at most 1000000000", "It is a completed-requests-per-second floor.",
    [] (const RunSummaryInputs& in) { return in.throughput; } },
    } };
    return table;
}

/// The known keys, for a rejection that tells the caller what it may send.
std::string known_keys () {
    std::string keys;
    for (const auto& metric : metrics ()) {
        if (!keys.empty ()) {
            keys += ", ";
        }
        keys += metric.key;
    }
    return keys;
}

const ThresholdMetric* find_metric (const std::string& key) {
    for (const auto& metric : metrics ()) {
        if (key == metric.key) {
            return &metric;
        }
    }
    return nullptr;
}

/// The declared budgets, in table order. A key whose value is `null` or of the
/// wrong type is skipped rather than guessed at - the route rejects both before
/// a run exists, and a snapshot that reached here carrying one is an older or
/// hand-edited row that must not take the whole section down with it.
std::vector<std::pair<const ThresholdMetric*, double>> declared_budgets (
const nlohmann::json& thresholds) {
    std::vector<std::pair<const ThresholdMetric*, double>> declared;
    if (!thresholds.is_object ()) {
        return declared;
    }
    for (const auto& metric : metrics ()) {
        if (!thresholds.contains (metric.key)) {
            continue;
        }
        const auto& value = thresholds[metric.key];
        if (!value.is_number ()) {
            continue;
        }
        const double limit = value.get<double> ();
        if (!std::isfinite (limit)) {
            continue;
        }
        declared.emplace_back (&metric, limit);
    }
    return declared;
}

} // namespace

std::optional<std::string> validate_thresholds (const nlohmann::json& config) {
    if (!config.is_object () || !config.contains ("thresholds") ||
    config["thresholds"].is_null ()) {
        return std::nullopt; // Budgets are opt-in.
    }

    const auto& thresholds = config["thresholds"];
    if (!thresholds.is_object ()) {
        return "'thresholds' must be an object of budgets, e.g. "
               "{\"latencyP99Ms\": 50} (got " +
        std::string (thresholds.type_name ()) + ")";
    }

    size_t declared = 0;
    for (const auto& [key, value] : thresholds.items ()) {
        const ThresholdMetric* metric = find_metric (key);
        if (metric == nullptr) {
            return "'thresholds." + key +
            "' is not a known budget - expected one of " + known_keys ();
        }
        // Null reads as absent, the same rule the flat numeric fields follow.
        if (value.is_null ()) {
            continue;
        }
        if (!value.is_number ()) {
            return "'thresholds." + key + "' must be a number (got " +
            std::string (value.type_name ()) + ")";
        }
        // Read as a double first: an integer read of a fractional or huge value
        // is itself undefined, and this is the guard that has to be total.
        const double limit = value.get<double> ();
        const bool under_min = metric->min_inclusive ? limit < metric->min_limit :
                                                       !(limit > metric->min_limit);
        if (!std::isfinite (limit) || under_min || limit > metric->max_limit) {
            return "'thresholds." + key + "' must be " + metric->range +
            " (got " + value.dump () + "). " + metric->why;
        }
        ++declared;
    }

    // An object that says nothing is rejected rather than stored: a caller that
    // sent it believes this run will be judged, and it is about to complete
    // with no verdict at all.
    if (declared == 0) {
        return "'thresholds' declares no budget - give at least one of " +
        known_keys () + ", or omit the object entirely";
    }

    return std::nullopt;
}

std::optional<ThresholdOutcome> evaluate_thresholds (const nlohmann::json& config,
const RunSummaryInputs& inputs) {
    if (!config.is_object () || !config.contains ("thresholds")) {
        return std::nullopt;
    }

    const auto declared = declared_budgets (config["thresholds"]);
    if (declared.empty ()) {
        return std::nullopt;
    }

    ThresholdOutcome outcome;
    outcome.checks.reserve (declared.size ());
    for (const auto& [metric, limit] : declared) {
        ThresholdCheck check;
        check.metric = metric->key;
        check.limit  = limit;
        check.actual = metric->measured (inputs);
        check.passed = metric->direction == Direction::AtMost ?
        check.actual <= check.limit :
        check.actual >= check.limit;
        if (check.passed) {
            ++outcome.passed;
        } else {
            ++outcome.failed;
        }
        outcome.checks.push_back (std::move (check));
    }
    return outcome;
}

} // namespace vayu::core
