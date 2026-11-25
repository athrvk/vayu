/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/threshold_eval.hpp"

#include <algorithm>
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
/// may declare. Data, so the route's validation and the run's verdict read one
/// row; two hand-written lists would drift silently, a key accepted and never
/// checked.
struct ThresholdMetric {
    const char* key;
    /// The display name `budgets.ts`'s `BUDGET_FIELDS` shows beside this key in
    /// the Load Test dialog. A rejection names this, not the wire key, as
    /// `ElementKind::label` does for elements.
    const char* label;
    Direction direction;
    double min_limit;
    /// Whether `min_limit` itself is legal. Only for the error rate: "no
    /// request may fail" is a real ask, a zero latency ceiling or throughput
    /// floor a typo.
    bool min_inclusive;
    double max_limit;
    const char* range; // the accepted span, spelled for the rejection message
    const char* why;   // appended to a rejection, explains the bound
    double (*measured) (const RunSummaryInputs&);
    /// Whether this run's numbers mean anything for the metric; `nullptr` is
    /// always yes (only throughput, whose starved floor fails on its own). A
    /// latency percentile needs a real completion, the error rate a request to
    /// take a share of (0/0 is no rate, not a clean 0%), a stream budget a run
    /// that streamed.
    bool (*has_data) (const RunSummaryInputs&);
    /// The populations an evaluated check carries onto the report, for a
    /// metric judged from more than one; `nullptr` for every other metric.
    const std::optional<AssertionPopulations>& (*populations) (const RunSummaryInputs&);
};

/// The share of requests that errored, as a percentage: the figure
/// `GET /runs/:id/report` prints, by the one definition
/// (`vayu::count_status_failures`). Read only when `error_rate_data_present`
/// holds, so the denominator is never zero.
double measured_error_rate (const RunSummaryInputs& inputs) {
    const size_t failed = vayu::count_status_failures (inputs.status_codes).failed;
    return static_cast<double> (failed) * 100.0 / static_cast<double> (inputs.total_requests);
}

/// A run that sent no request has no error rate to judge: the same 0/0 the run
/// summary leaves `errorRate` out for (`load_result_summary`).
bool error_rate_data_present (const RunSummaryInputs& inputs) {
    return inputs.total_requests > 0;
}

constexpr double MAX_LATENCY_BUDGET_MS = 86400000.0; // a day; past it nothing completes
constexpr double MAX_THROUGHPUT_BUDGET_RPS = 1e9;

/// One population's failure share as a percentage; 0 when it is empty.
double failure_rate_pct (const AssertionTotals& totals) {
    if (totals.total () == 0) {
        return 0.0;
    }
    return static_cast<double> (totals.failed) * 100.0 /
    static_cast<double> (totals.total ());
}

/// The worse of the exact and sampled failure rates (#2892), so neither
/// population's volume dilutes the other's failures. Zero when the run asserted
/// nothing, which `assertion_data_present` keeps out of the verdict rather than
/// passing trivially.
double measured_assertion_failure_rate (const RunSummaryInputs& inputs) {
    if (!inputs.assertions) {
        return 0.0;
    }
    return std::max (failure_rate_pct (inputs.assertions->exact),
    failure_rate_pct (inputs.assertions->sampled));
}

bool assertion_data_present (const RunSummaryInputs& inputs) {
    return inputs.assertions.has_value () &&
    (inputs.assertions->exact.total () + inputs.assertions->sampled.total ()) > 0;
}

const std::optional<AssertionPopulations>& assertion_populations (
const RunSummaryInputs& inputs) {
    return inputs.assertions;
}

/// The report's `stream.timeToFirstEvent.p95` (#3234).
double measured_first_event_p95 (const RunSummaryInputs& inputs) {
    const auto& stream = inputs.stream;
    return stream ? stream->time_to_first_event.p95 : 0.0;
}

/// A run with no `stream` section measured no stream at all.
bool stream_data_present (const RunSummaryInputs& inputs) {
    return inputs.stream.has_value ();
}

/// A stream section can still hold no timed first event: every stream stayed
/// silent, or its only event was a frame the close completed.
bool first_event_data_present (const RunSummaryInputs& inputs) {
    const auto& stream = inputs.stream;
    return stream && stream->time_to_first_event.count > 0;
}

/// The report's `stream.timeToFirstMatch.p95` (#3774).
double measured_first_match_p95 (const RunSummaryInputs& inputs) {
    const auto& stream = inputs.stream;
    return stream ? stream->time_to_first_match.p95 : 0.0;
}

/// No stream's first content marker arrived: none declared one, or the
/// content never came. Either is no measurement, never a fast one.
bool first_match_data_present (const RunSummaryInputs& inputs) {
    const auto& stream = inputs.stream;
    return stream && stream->time_to_first_match.count > 0;
}

/// The report's `stream.eventsPerSecond`, through the same derivation.
double measured_events_per_second (const RunSummaryInputs& inputs) {
    const auto& stream = inputs.stream;
    return stream ? stream->events_per_second (inputs.test_duration_s) : 0.0;
}

/// Every budget a run may declare, in the order the report lists them.
const std::array<ThresholdMetric, 9>& metrics () {
    static const std::array<ThresholdMetric, 9> table = { {
    { "latencyP50Ms", "p50 latency", Direction::AtMost, 0.0, false, MAX_LATENCY_BUDGET_MS,
    "greater than 0 and at most 86400000", "It is a latency ceiling in milliseconds.",
    [] (const RunSummaryInputs& in) { return in.latency.p50; },
    [] (const RunSummaryInputs& in) { return in.latency.count > 0; }, nullptr },
    { "latencyP95Ms", "p95 latency", Direction::AtMost, 0.0, false, MAX_LATENCY_BUDGET_MS,
    "greater than 0 and at most 86400000", "It is a latency ceiling in milliseconds.",
    [] (const RunSummaryInputs& in) { return in.latency.p95; },
    [] (const RunSummaryInputs& in) { return in.latency.count > 0; }, nullptr },
    { "latencyP99Ms", "p99 latency", Direction::AtMost, 0.0, false, MAX_LATENCY_BUDGET_MS,
    "greater than 0 and at most 86400000", "It is a latency ceiling in milliseconds.",
    [] (const RunSummaryInputs& in) { return in.latency.p99; },
    [] (const RunSummaryInputs& in) { return in.latency.count > 0; }, nullptr },
    { "maxErrorRatePct", "Error rate", Direction::AtMost, 0.0, true, 100.0,
    "between 0 and 100", "It is a percentage of the run's requests.",
    measured_error_rate, error_rate_data_present, nullptr },
    { "minThroughputRps", "Throughput", Direction::AtLeast, 0.0, false, MAX_THROUGHPUT_BUDGET_RPS,
    "greater than 0 and at most 1000000000", "It is a completed-requests-per-second floor.",
    [] (const RunSummaryInputs& in) { return in.throughput; }, nullptr, nullptr },
    { "maxAssertionFailureRatePct", "Assertion failure rate", Direction::AtMost, 0.0,
    true, 100.0, "between 0 and 100", "It is a percentage of this run's assert.* and pm.test outcomes.",
    measured_assertion_failure_rate, assertion_data_present, assertion_populations },
    { "streamTimeToFirstEventP95Ms", "Time to first event p95", Direction::AtMost,
    0.0, false, MAX_LATENCY_BUDGET_MS, "greater than 0 and at most 86400000",
    "It is a ceiling in milliseconds on a stream's wait for its first event.",
    measured_first_event_p95, first_event_data_present, nullptr },
    { "streamTimeToFirstMatchP95Ms", "Time to first match p95", Direction::AtMost,
    0.0, false, MAX_LATENCY_BUDGET_MS, "greater than 0 and at most 86400000", "It is a ceiling in milliseconds on a stream's wait for its first content marker.",
    measured_first_match_p95, first_match_data_present, nullptr },
    { "streamEventsPerSecondMin", "Events per second", Direction::AtLeast, 0.0,
    false, MAX_THROUGHPUT_BUDGET_RPS, "greater than 0 and at most 1000000000",
    "It is a floor on a streaming run's delivered events per second.",
    measured_events_per_second, stream_data_present, nullptr },
    } };
    return table;
}

/// The known budgets, for a rejection: each display label with its wire key,
/// since a caller typing JSON needs the key and a person reading needs the
/// label.
std::string known_keys () {
    std::string keys;
    for (const auto& metric : metrics ()) {
        if (!keys.empty ()) {
            keys += ", ";
        }
        keys += "'";
        keys += metric.label;
        keys += "' (";
        keys += metric.key;
        keys += ")";
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
// `custom.<name>.<stat>` (#1500): a dynamic key family the fixed
// `ThresholdMetric` table cannot hold (its `measured` pointer takes no name),
// so it is parsed and evaluated beside the table. Always a ceiling
// (`Direction::AtMost`): every stat it reads (a trend's percentiles, a
// counter's or rate's running value) is a "no more than" budget, and no use
// or report shape (`customMetrics`) asks for a floor.
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

/// `custom.<name>.<stat>` split on its last dot, so a name may hold one
/// (`metric.record` names are plain identifiers, but nothing here relies on
/// it).
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

/// One stat of a recorded custom metric's summary. `"rate"` and `"value"` are
/// one field under two names, reading naturally against a Rate (already a 0-100
/// percentage) and a Counter's running total. A budget declared against the
/// wrong type still evaluates: a distribution's `max` means something for all
/// three kinds.
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

/// The declared budgets, in table order. A `null` or wrong-typed value is
/// skipped, not guessed at: the route rejects both before a run exists, so one
/// here is an older or hand-edited row that must not take the section down.
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

/// `thresholds.failRun`: not a budget, so never in the declared count; a
/// boolean or (null meaning absent, as for every key) absent.
std::optional<std::string> validate_fail_run_key (const nlohmann::json& value) {
    if (value.is_null () || value.is_boolean ()) {
        return std::nullopt;
    }
    return "'thresholds.failRun' must be a boolean (got " +
    std::string (value.type_name ()) + ")";
}

/// One fixed-table budget's bound, read as a double first: an integer read of a
/// fractional or huge value is itself undefined, and this guard must be total.
std::optional<std::string> validate_known_metric_limit (const ThresholdMetric& metric,
const nlohmann::json& value) {
    if (!value.is_number ()) {
        return "'" + std::string (metric.label) + "' must be a number (got " +
        std::string (value.type_name ()) + ")";
    }
    const double limit   = value.get<double> ();
    const bool under_min = metric.min_inclusive ? limit < metric.min_limit :
                                                  !(limit > metric.min_limit);
    if (!std::isfinite (limit) || under_min || limit > metric.max_limit) {
        return "'" + std::string (metric.label) + "' must be " + metric.range +
        " (got " + value.dump () + "). " + metric.why;
    }
    return std::nullopt;
}

/// `custom.<name>.<stat>`'s bound (#1500): always a ceiling, for the reason the
/// section banner gives.
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
            if (auto reason = validate_known_metric_limit (*metric, value)) {
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

    // An object that says nothing is rejected, not stored: its caller believes
    // the run will be judged, and it would complete with no verdict.
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
        if (metric.populations != nullptr) {
            check.assertions = metric.populations (inputs);
        }
    } else {
        // A budget the run could not measure was not met: counted as a failure,
        // never dropped from the tally.
        check.passed = false;
    }
    return check;
}

/// One `custom.<name>.<stat>` verdict against what this run's collector
/// recorded (#1500). A name never recorded (a typo, or a `metric.record` on a
/// step never reached) reads like a latency percentile with no completions:
/// `evaluated: false`, a failure rather than a silent pass.
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

/// Every `custom.<name>.<stat>` check in @p thresholds, appended to @p outcome:
/// the dynamic-key sibling of `evaluate_thresholds`'s fixed-table loop.
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

nlohmann::json assertion_totals_payload (const AssertionTotals& totals) {
    return { { "passed", totals.passed }, { "failed", totals.failed } };
}

/// `sampleRate` describes the sampled population, so it is left out when that
/// population is empty rather than naming a period nothing was judged at.
void append_assertion_populations (nlohmann::json& row, const AssertionPopulations& populations) {
    row["assertionsExact"]   = assertion_totals_payload (populations.exact);
    row["assertionsSampled"] = assertion_totals_payload (populations.sampled);
    if (populations.sampled.total () > 0) {
        row["sampleRate"] = populations.sample_rate;
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

nlohmann::json build_threshold_outcome_payload (const ThresholdOutcome& outcome) {
    nlohmann::json checks = nlohmann::json::array ();
    for (const auto& check : outcome.checks) {
        nlohmann::json row = { { "metric", check.metric }, { "limit", check.limit },
            { "passed", check.passed }, { "evaluated", check.evaluated } };
        // Omitted rather than zeroed when unevaluated, as for any section the
        // run never filled: a 0ms ceiling beside "passed": false would read as
        // a measurement, not the absence it is.
        if (check.evaluated) {
            row["actual"] = check.actual;
        }
        if (check.assertions) {
            append_assertion_populations (row, *check.assertions);
        }
        checks.push_back (std::move (row));
    }
    return { { "checks", checks }, { "passed", outcome.passed },
        { "failed", outcome.failed } };
}

} // namespace vayu::core
