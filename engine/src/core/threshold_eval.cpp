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
#include <unordered_set>

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
    /// Whether this run's numbers mean anything for this metric. `nullptr`
    /// means always yes: the error rate and throughput are 0/0-safe already
    /// (see `measured_error_rate`, and a starved throughput floor already
    /// fails on its own). A latency percentile needs a real completion to
    /// mean anything, so it is not evaluated when the run recorded none.
    bool (*has_data) (const RunSummaryInputs&);
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

/// Share of this run's assertions - `assert.*` element outcomes and `pm.test`
/// calls alike, inline or replayed - that failed, as a percentage. Zero when
/// the run made none, which `assertion_data_present` is what keeps this
/// metric out of the verdict for rather than a trivial pass.
double measured_assertion_failure_rate (const RunSummaryInputs& inputs) {
    if (!inputs.assertions) {
        return 0.0;
    }
    const size_t total = inputs.assertions->passed + inputs.assertions->failed;
    if (total == 0) {
        return 0.0;
    }
    return static_cast<double> (inputs.assertions->failed) * 100.0 /
    static_cast<double> (total);
}

bool assertion_data_present (const RunSummaryInputs& inputs) {
    return inputs.assertions.has_value () &&
    (inputs.assertions->passed + inputs.assertions->failed) > 0;
}

/// Every budget a run may declare, in the order the report lists them.
const std::array<ThresholdMetric, 6>& metrics () {
    static const std::array<ThresholdMetric, 6> table = { {
    { "latencyP50Ms", Direction::AtMost, 0.0, false, MAX_LATENCY_BUDGET_MS,
    "greater than 0 and at most 86400000", "It is a latency ceiling in milliseconds.",
    [] (const RunSummaryInputs& in) { return in.latency.p50; },
    [] (const RunSummaryInputs& in) { return in.latency.count > 0; } },
    { "latencyP95Ms", Direction::AtMost, 0.0, false, MAX_LATENCY_BUDGET_MS,
    "greater than 0 and at most 86400000", "It is a latency ceiling in milliseconds.",
    [] (const RunSummaryInputs& in) { return in.latency.p95; },
    [] (const RunSummaryInputs& in) { return in.latency.count > 0; } },
    { "latencyP99Ms", Direction::AtMost, 0.0, false, MAX_LATENCY_BUDGET_MS,
    "greater than 0 and at most 86400000", "It is a latency ceiling in milliseconds.",
    [] (const RunSummaryInputs& in) { return in.latency.p99; },
    [] (const RunSummaryInputs& in) { return in.latency.count > 0; } },
    { "maxErrorRatePct", Direction::AtMost, 0.0, true, 100.0, "between 0 and 100",
    "It is a percentage of the run's requests.", measured_error_rate, nullptr },
    { "minThroughputRps", Direction::AtLeast, 0.0, false, MAX_THROUGHPUT_BUDGET_RPS,
    "greater than 0 and at most 1000000000", "It is a completed-requests-per-second floor.",
    [] (const RunSummaryInputs& in) { return in.throughput; }, nullptr },
    { "maxAssertionFailureRatePct", Direction::AtMost, 0.0, true, 100.0,
    "between 0 and 100", "It is a percentage of this run's assert.* and pm.test outcomes.",
    measured_assertion_failure_rate, assertion_data_present },
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

// ---------------------------------------------------------------------------
// `custom.<name>.<stat>` (issue #1500) - a dynamic key family the fixed
// `ThresholdMetric` table cannot hold (its `measured` function pointer takes
// no name), so it is parsed and evaluated beside that table rather than
// forced into a row of it. Always a ceiling (`Direction::AtMost`): every
// stat this reads - a trend's percentiles, a counter's or a rate's running
// value - is a "no more than" budget in every use the issue names, and a
// floor is not something the acceptance criteria or the report's own
// `customMetrics` shape ask for.
// ---------------------------------------------------------------------------

constexpr std::string_view CUSTOM_METRIC_PREFIX = "custom.";

struct CustomMetricTarget {
    std::string name;
    std::string stat;
};

const std::unordered_set<std::string>& custom_metric_stats () {
    static const std::unordered_set<std::string> stats = { "p50", "p95", "p99",
        "max", "rate", "value" };
    return stats;
}

/// `custom.<name>.<stat>` split on its **last** dot, so a name is free to
/// hold one of its own (unlikely - `metric.record`'s own `name` field is a
/// plain identifier - but nothing here requires it not to).
std::optional<CustomMetricTarget> parse_custom_metric_key (const std::string& key) {
    if (key.rfind (CUSTOM_METRIC_PREFIX, 0) != 0) {
        return std::nullopt;
    }
    const std::string rest = key.substr (CUSTOM_METRIC_PREFIX.size ());
    const auto last_dot    = rest.rfind ('.');
    if (last_dot == std::string::npos || last_dot == 0 || last_dot == rest.size () - 1) {
        return std::nullopt;
    }
    std::string stat = rest.substr (last_dot + 1);
    if (!custom_metric_stats ().contains (stat)) {
        return std::nullopt;
    }
    return CustomMetricTarget{ rest.substr (0, last_dot), std::move (stat) };
}

/// One stat off a recorded custom metric's summary. `"rate"` and `"value"`
/// are the same field under two names: `"rate"` reads naturally against a
/// Rate metric (already a 0-100 percentage), `"value"` against a Counter's
/// running total - a budget declared against the wrong type for its name
/// still evaluates, since a distribution's `max` is meaningful for any of
/// the three kinds.
double custom_metric_stat_value (const CustomMetricSummary& summary, const std::string& stat) {
    if (stat == "p50") {
        return summary.p50;
    }
    if (stat == "p95") {
        return summary.p95;
    }
    if (stat == "p99") {
        return summary.p99;
    }
    if (stat == "max") {
        return summary.max;
    }
    return summary.value; // "rate" or "value".
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

/// `thresholds.failRun`'s own rule: not a budget, so it never joins the
/// caller's declared count - a boolean, or (per the null-means-absent rule
/// every key follows) absent.
std::optional<std::string> validate_fail_run_key (const nlohmann::json& value) {
    if (value.is_null () || value.is_boolean ()) {
        return std::nullopt;
    }
    return "'thresholds.failRun' must be a boolean (got " +
    std::string (value.type_name ()) + ")";
}

/// One fixed-table budget's bound, read as a double first: an integer read
/// of a fractional or huge value is itself undefined, and this is the guard
/// that has to be total.
std::optional<std::string> validate_known_metric_limit (const ThresholdMetric& metric,
const std::string& key,
const nlohmann::json& value) {
    if (!value.is_number ()) {
        return "'thresholds." + key + "' must be a number (got " +
        std::string (value.type_name ()) + ")";
    }
    const double limit   = value.get<double> ();
    const bool under_min = metric.min_inclusive ? limit < metric.min_limit :
                                                  !(limit > metric.min_limit);
    if (!std::isfinite (limit) || under_min || limit > metric.max_limit) {
        return "'thresholds." + key + "' must be " + metric.range + " (got " +
        value.dump () + "). " + metric.why;
    }
    return std::nullopt;
}

/// `custom.<name>.<stat>`'s own bound (issue #1500): always a ceiling, since
/// every stat this reads - a percentile, a counter's total, a rate's
/// percentage - is a "no more than" ask in every use the issue names.
std::optional<std::string> validate_custom_metric_limit (const std::string& key,
const nlohmann::json& value) {
    if (!value.is_number ()) {
        return "'thresholds." + key + "' must be a number (got " +
        std::string (value.type_name ()) + ")";
    }
    const double limit = value.get<double> ();
    if (!std::isfinite (limit) || limit < 0.0) {
        return "'thresholds." + key + "' must be zero or greater - it is a ceiling on a custom.record metric.";
    }
    return std::nullopt;
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
        if (key == "failRun") {
            if (auto reason = validate_fail_run_key (value)) {
                return reason;
            }
            continue;
        }
        // Null reads as absent, the same rule the flat numeric fields follow -
        // ahead of both the known-metric and the custom-metric branch below.
        if (value.is_null ()) {
            continue;
        }
        if (const ThresholdMetric* metric = find_metric (key); metric != nullptr) {
            if (auto reason = validate_known_metric_limit (*metric, key, value)) {
                return reason;
            }
            ++declared;
            continue;
        }
        if (!parse_custom_metric_key (key)) {
            return "'thresholds." + key +
            "' is not a known budget - expected one of " + known_keys () +
            ", or 'custom.<name>.<stat>' (stat one of p50, p95, p99, "
            "max, rate, value) for a declared metric.record name";
        }
        if (auto reason = validate_custom_metric_limit (key, value)) {
            return reason;
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

namespace {

/// One fixed-table budget's verdict off this run's numbers.
ThresholdCheck evaluate_known_metric_check (const ThresholdMetric& metric,
double limit,
const RunSummaryInputs& inputs) {
    ThresholdCheck check;
    check.metric    = metric.key;
    check.limit     = limit;
    check.evaluated = metric.has_data == nullptr || metric.has_data (inputs);
    if (check.evaluated) {
        check.actual = metric.measured (inputs);
        check.passed = metric.direction == Direction::AtMost ?
        check.actual <= check.limit :
        check.actual >= check.limit;
    } else {
        // A budget the run could not measure was not met - counted by the
        // caller as a failure, never silently dropped from the tally.
        check.passed = false;
    }
    return check;
}

/// One `custom.<name>.<stat>` budget's verdict, evaluated against whatever
/// this run's collector actually recorded (issue #1500) - a name declared
/// here but never recorded through (a typo, or a metric.record on a step the
/// run never reached) reads exactly like a latency percentile with zero
/// completions: `evaluated: false`, counted as a failure rather than a
/// silent pass.
ThresholdCheck evaluate_custom_metric_check (const std::string& key,
double limit,
const CustomMetricTarget& target,
const RunSummaryInputs& inputs) {
    ThresholdCheck check;
    check.metric                       = key;
    check.limit                        = limit;
    const CustomMetricSummary* summary = nullptr;
    if (inputs.custom_metrics) {
        if (auto it = inputs.custom_metrics->find (target.name);
        it != inputs.custom_metrics->end ()) {
            summary = &it->second;
        }
    }
    check.evaluated = summary != nullptr && summary->count > 0;
    if (check.evaluated) {
        check.actual = custom_metric_stat_value (*summary, target.stat);
        check.passed = check.actual <= check.limit;
    } else {
        check.passed = false;
    }
    return check;
}

void tally (ThresholdOutcome& outcome, ThresholdCheck check) {
    if (check.passed) {
        ++outcome.passed;
    } else {
        ++outcome.failed;
    }
    outcome.checks.push_back (std::move (check));
}

/// Every `custom.<name>.<stat>` check @p thresholds declares, appended to
/// @p outcome - the dynamic-key sibling of the fixed-table loop in
/// `evaluate_thresholds` itself.
void append_custom_metric_checks (const nlohmann::json& thresholds,
const RunSummaryInputs& inputs,
ThresholdOutcome& outcome) {
    if (!thresholds.is_object ()) {
        return;
    }
    for (const auto& [key, value] : thresholds.items ()) {
        if (key == "failRun" || !value.is_number () || find_metric (key) != nullptr) {
            continue;
        }
        const auto target = parse_custom_metric_key (key);
        if (!target) {
            continue;
        }
        tally (outcome,
        evaluate_custom_metric_check (key, value.get<double> (), *target, inputs));
    }
}

} // namespace

std::optional<ThresholdOutcome> evaluate_thresholds (const nlohmann::json& config,
const RunSummaryInputs& inputs) {
    if (!config.is_object () || !config.contains ("thresholds")) {
        return std::nullopt;
    }
    const auto& thresholds = config["thresholds"];

    const auto declared = declared_budgets (thresholds);
    ThresholdOutcome outcome;
    outcome.checks.reserve (declared.size ());
    for (const auto& [metric, limit] : declared) {
        tally (outcome, evaluate_known_metric_check (*metric, limit, inputs));
    }
    append_custom_metric_checks (thresholds, inputs, outcome);

    if (outcome.checks.empty ()) {
        return std::nullopt;
    }
    return outcome;
}

bool thresholds_fail_run (const nlohmann::json& config) {
    if (!config.is_object () || !config.contains ("thresholds")) {
        return false;
    }
    const auto& thresholds = config["thresholds"];
    if (!thresholds.is_object () || !thresholds.contains ("failRun")) {
        return false;
    }
    const auto& value = thresholds["failRun"];
    return value.is_boolean () && value.get<bool> ();
}

} // namespace vayu::core
