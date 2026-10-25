/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/run_export_view.cpp
 * @brief The run-report document read into the sections every text renderer
 *        shares (#2131, #2135): a verdict, the run, the headline numbers,
 *        latency against budgets, errors, the comparison and the warnings.
 */

#include "vayu/core/run_export_view.hpp"

#include "vayu/core/load_pacing.hpp"
#include "vayu/core/run_compare.hpp"
#include "vayu/utils/reentrant.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <ctime>
#include <format>
#include <iterator>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::core {

namespace {

using ordered = nlohmann::ordered_json;
using doc::at_path;
using doc::find_check;
using doc::member;
using doc::number_at;
using doc::Path;
using doc::text_at;

constexpr std::string_view ABSENT = "-";

/// Rows a table fed by an open set (status codes, error types) shows before
/// the rest are folded into one line, so a run that saw 300 distinct codes
/// writes the same few lines as one that saw three.
constexpr std::size_t MAX_OPEN_SET_ROWS = 10;
constexpr std::size_t MAX_WARNINGS      = 10;
constexpr std::size_t MAX_WARNING_NAMES = 5;

} // namespace

// --- text ---------------------------------------------------------------------------------

ReportText ReportText::words (std::string text) {
    ReportText out;
    out.runs_.push_back ({ std::move (text), false });
    return out;
}

ReportText ReportText::user (std::string text) {
    ReportText out;
    out.runs_.push_back ({ std::move (text), true });
    return out;
}

ReportText& ReportText::operator+= (const ReportText& more) {
    runs_.insert (runs_.end (), more.runs_.begin (), more.runs_.end ());
    return *this;
}

bool ReportText::empty () const {
    return std::ranges::all_of (
    runs_, [] (const TextRun& run) { return run.text.empty (); });
}

std::string ReportText::flat () const {
    return render ([] (const std::string& text) { return text; },
    [] (const std::string& text) { return text; });
}

// --- reading the document ----------------------------------------------------------

namespace doc {

const ordered& member (const ordered& source, std::string_view key) {
    static const ordered absent;
    if (!source.is_object ()) {
        return absent;
    }
    const auto found = source.find (std::string (key));
    return found == source.end () ? absent : *found;
}

const ordered& at_path (const ordered& root, Path path) {
    const ordered* at = &root;
    for (const std::string_view key : path) {
        at = &member (*at, key);
    }
    return *at;
}

std::optional<double> number_at (const ordered& root, Path path) {
    const ordered& value = at_path (root, path);
    return value.is_number () ? std::optional (value.get<double> ()) : std::nullopt;
}

/// A non-empty string at @p path, or empty.
std::string text_at (const ordered& root, Path path) {
    const ordered& value = at_path (root, path);
    return value.is_string () ? value.get<std::string> () : std::string ();
}

const ordered& find_check (const ordered& document, std::string_view metric) {
    static const ordered absent;
    const ordered& checks =
    at_path (document, { "report", "thresholdValidation", "checks" });
    if (!checks.is_array ()) {
        return absent;
    }
    const auto found = std::ranges::find_if (checks, [metric] (const ordered& check) {
        return text_at (check, { "metric" }) == metric;
    });
    return found == checks.end () ? absent : *found;
}

} // namespace doc

// --- numbers -------------------------------------------------------------------------

namespace {

std::string group_thousands (std::string_view digits) {
    std::string out;
    for (std::size_t at = 0; at < digits.size (); ++at) {
        if (at > 0 && (digits.size () - at) % 3 == 0) {
            out += ',';
        }
        out += digits[at];
    }
    return out;
}

bool is_zero_text (std::string_view text) {
    return text.find_first_of ("123456789") == std::string_view::npos;
}

/// `std::format` rounds an exact tie to even (12.5 is "12"); the app's
/// `Intl.NumberFormat` rounds it away from zero ("13"), and so do we: a
/// @p magnitude exactly halfway at @p decimals is nudged one step up. The
/// product is tested with `fma`, which keeps 2.675 (a hair under halfway as a
/// double) out of it.
double round_tie_away (double magnitude, int decimals) {
    double scale = 2;
    for (int place = 0; place < decimals; ++place) {
        scale *= 10;
    }
    const double doubled = magnitude * scale;
    const bool odd_whole =
    doubled == std::floor (doubled) && std::fmod (doubled, 2.0) == 1.0;
    const bool exact = std::fma (magnitude, scale, -doubled) == 0.0;
    return odd_whole && exact ? std::nextafter (magnitude, HUGE_VAL) : magnitude;
}

/// @p value with @p decimals places, thousands grouped; @p trim drops trailing
/// zeros. A value that rounds to zero carries no sign.
std::string spell_number (double value, int decimals, bool trim) {
    if (!std::isfinite (value)) {
        return "0";
    }
    const std::string raw =
    std::format ("{:.{}f}", round_tie_away (std::abs (value), decimals), decimals);
    const auto point = raw.find ('.');
    std::string fraction =
    point == std::string::npos ? std::string () : raw.substr (point + 1);
    while (trim && !fraction.empty () && fraction.back () == '0') {
        fraction.pop_back ();
    }
    std::string body = group_thousands (raw.substr (0, point));
    if (!fraction.empty ()) {
        body += '.' + fraction;
    }
    if (value < 0 && !is_zero_text (body)) {
        body.insert (body.begin (), '-');
    }
    return body;
}

/// `+12` or `-12`; zero has no sign.
template <typename Spell>
std::string signed_text (double value, const Spell& spell) {
    std::string body = spell (std::abs (value));
    if (value != 0) {
        body.insert (body.begin (), value > 0 ? '+' : '-');
    }
    return body;
}

std::string with_unit (const std::string& text, std::string_view unit) {
    return text + std::string (unit);
}

} // namespace

std::string format_run_figure (double value) {
    if (value > 0 && value < 0.01) {
        return "<0.01";
    }
    return spell_number (value, std::abs (value) < 10 ? 2 : 0, true);
}

std::string format_run_count (double value) {
    return spell_number (value, 0, true);
}

std::string format_run_percent (double value) {
    if (!std::isfinite (value) || value <= 0) {
        return "0.0";
    }
    const std::string fixed = spell_number (value, 1, false);
    return is_zero_text (fixed) ? "<0.1" : fixed;
}

std::string format_run_bytes (double value) {
    constexpr std::array<std::string_view, 3> UNITS = { "KB", "MB", "GB" };
    if (!std::isfinite (value) || value < 1024) {
        return spell_number (std::max (value, 0.0), 0, true) + " B";
    }
    double scaled    = value / 1024;
    std::size_t unit = 0;
    while (scaled >= 1024 && unit + 1 < UNITS.size ()) {
        scaled /= 1024;
        ++unit;
    }
    return spell_number (scaled, 1, false) + ' ' + std::string (UNITS.at (unit));
}

std::string format_run_seconds (double value) {
    return spell_number (value, 1, true) + " s";
}

namespace {

using Row   = ReportRow;
using Table = ReportTable;

ReportText words (std::string text) {
    return ReportText::words (std::move (text));
}

ReportText user (std::string text) {
    return ReportText::user (std::move (text));
}

ReportCell cell (ReportText text, Tone tone = Tone::neutral) {
    return { std::move (text), tone };
}

ReportCell plain_cell (std::string text) {
    return cell (words (std::move (text)));
}

ReportText absent () {
    return words (std::string (ABSENT));
}

ReportText text_or_absent (ReportText text) {
    return text.empty () ? absent () : std::move (text);
}

/// @p word's tone: good for @p good, bad for @p bad, otherwise neutral.
Tone tone_of (std::string_view word, std::string_view good, std::string_view bad) {
    if (word == good) {
        return Tone::good;
    }
    return word == bad ? Tone::bad : Tone::neutral;
}

// --- budgets ----------------------------------------------------------------------------------

struct BudgetMetric {
    std::string_view key;
    std::string_view name;
    std::string_view unit;
    bool floor;
    std::string (*figure) (double);
};

/// The app's `THRESHOLD_METRICS` (`components/shared/threshold-metrics.ts`):
/// the short name a sentence uses and the unit a figure carries. A key not
/// here (a `custom.<name>.<stat>` budget) keeps its raw name and no unit.
constexpr auto BUDGET_METRICS = std::to_array<BudgetMetric> ({
{ "latencyP50Ms", "p50", " ms", false, format_run_figure },
{ "latencyP95Ms", "p95", " ms", false, format_run_figure },
{ "latencyP99Ms", "p99", " ms", false, format_run_figure },
{ "maxErrorRatePct", "error rate", "%", false, format_run_percent },
{ "minThroughputRps", "throughput", " req/s", true, format_run_figure },
{ "maxAssertionFailureRatePct", "assertion failures", "%", false, format_run_percent },
});

const BudgetMetric* find_budget_metric (std::string_view key) {
    const auto found = std::ranges::find (BUDGET_METRICS, key, &BudgetMetric::key);
    return found == BUDGET_METRICS.end () ? nullptr : &*found;
}

const ordered& budget_checks (const ordered& document) {
    return at_path (document, { "report", "thresholdValidation", "checks" });
}

std::string budget_figure (const ordered& check, double value) {
    const BudgetMetric* meta = find_budget_metric (text_at (check, { "metric" }));
    return meta == nullptr ? format_run_figure (value) :
                             with_unit (meta->figure (value), meta->unit);
}

ReportText budget_name (const ordered& check) {
    const std::string key    = text_at (check, { "metric" });
    const BudgetMetric* meta = find_budget_metric (key);
    return meta == nullptr ? user (key) : words (std::string (meta->name));
}

/// `<= 30 ms`, or `>= 500 req/s` for a floor.
std::string budget_limit (const ordered& check) {
    const BudgetMetric* meta = find_budget_metric (text_at (check, { "metric" }));
    const double limit = number_at (check, { "limit" }).value_or (0);
    return std::string (meta != nullptr && meta->floor ? ">= " : "<= ") +
    budget_figure (check, limit);
}

bool is_false (const ordered& value) {
    return value.is_boolean () && !value.get<bool> ();
}

/// `met`, `missed` or `not evaluated`, as the check recorded it.
std::string budget_status (const ordered& check) {
    if (is_false (member (check, "evaluated"))) {
        return "not evaluated";
    }
    return is_false (member (check, "passed")) ? "missed" : "met";
}

/// The Budget column's cell for @p key: `<= 30 ms - met`, or `-` for no budget.
ReportCell budget_cell (const ordered& document, std::string_view key) {
    const ordered& check = find_check (document, key);
    if (!check.is_object ()) {
        return cell (absent ());
    }
    const std::string status = budget_status (check);
    return cell (words (budget_limit (check) + " - " + status),
    tone_of (status, "met", "missed"));
}

// --- title and reference ------------------------------------------------------------------------

/// The run's title, read back out of its reference line
/// (`Vayu run "<title>" (<id>) - ...`): the reference is the one place the
/// document spells the title, and `quote_name` escaped `\` and `"` in it.
std::string reference_title (std::string_view reference) {
    constexpr std::string_view OPENING = "Vayu run \"";
    if (!reference.starts_with (OPENING)) {
        return {};
    }
    std::string title;
    for (std::size_t at = OPENING.size (); at < reference.size (); ++at) {
        if (reference[at] == '"') {
            break;
        }
        if (reference[at] == '\\' && at + 1 < reference.size ()) {
            ++at;
        }
        title += reference[at];
    }
    return title;
}

// --- verdict ------------------------------------------------------------------------------------------

ReportText verdict_label (std::string_view state) {
    if (state == "passed") {
        return "Passed";
    }
    if (state == "failed") {
        return "Failed";
    }
    return state == "not_judged" ? ReportText ("Not judged") : user (std::string (state));
}

/// Every check that did not pass, as `p95 <= 30 ms missed (41 ms)`.
ReportText missed_budgets (const ordered& document) {
    const ordered& checks = budget_checks (document);
    ReportText out;
    if (!checks.is_array ()) {
        return out;
    }
    for (const ordered& check : checks) {
        if (!is_false (member (check, "passed"))) {
            continue;
        }
        if (!out.empty ()) {
            out += "; ";
        }
        out += budget_name (check) +
        words (' ' + budget_limit (check) + ' ' + budget_status (check));
        if (const auto actual = number_at (check, { "actual" });
        actual && !is_false (member (check, "evaluated"))) {
            out += words (" (" + budget_figure (check, *actual) + ')');
        }
    }
    return out;
}

/// `3 of 3 budgets met`, from the counts the report holds.
ReportText budgets_met_text (const ordered& document) {
    const ordered& thresholds = at_path (document, { "report", "thresholdValidation" });
    const double passed = number_at (thresholds, { "passed" }).value_or (0);
    const double failed = number_at (thresholds, { "failed" }).value_or (0);
    const double total  = passed + failed;
    return words (format_run_count (passed) + " of " +
    format_run_count (total) + (total == 1 ? " budget met" : " budgets met"));
}

ReportText errored_text (const ordered& document) {
    const double rate =
    number_at (document, { "report", "summary", "errorRate" }).value_or (0);
    return words (format_run_percent (rate) + "% of requests errored");
}

/// The words after the verdict's label, chosen by the document's own `reason`.
ReportText verdict_detail (const ordered& document, std::string_view reason) {
    if (reason == "budgets_met") {
        return budgets_met_text (document);
    }
    if (reason == "budgets_missed") {
        ReportText missed = missed_budgets (document);
        return missed.empty () ? ReportText ("budgets missed") : missed;
    }
    if (reason == "budgets_met_with_errors") {
        return budgets_met_text (document) + ", but " + errored_text (document);
    }
    if (reason == "no_budgets") {
        return "no budgets declared";
    }
    if (reason == "run_failed") {
        return "the run failed before it finished";
    }
    if (reason == "stopped") {
        return "a stopped run is not judged";
    }
    std::string spelled (reason);
    std::ranges::replace (spelled, '_', ' ');
    return user (std::move (spelled));
}

/// A duration in seconds from the configuration's `duration`: a number of
/// seconds, or the string `parse_duration_ms` reads (`30`, `1.5s`, `500ms`,
/// `2m`, `1h`).
std::optional<double> duration_seconds (const ordered& duration) {
    if (duration.is_number ()) {
        return duration.get<double> ();
    }
    if (!duration.is_string ()) {
        return std::nullopt;
    }
    const auto milliseconds =
    parse_duration_ms (duration.get_ref<const std::string&> ());
    return milliseconds ? std::optional (static_cast<double> (*milliseconds) / 1000.0) :
                          std::nullopt;
}

const ordered& configuration_of (const ordered& document) {
    return at_path (document, { "config", "configuration" });
}

/// `Stopped early at 3 s of 20 s`.
std::string stopped_early_line (const ordered& document) {
    std::string line = "Stopped early";
    if (const auto elapsed = number_at (document, { "report", "summary", "testDuration" })) {
        line += " at " + format_run_seconds (*elapsed);
        if (const auto planned =
            duration_seconds (member (configuration_of (document), "duration"))) {
            line += " of " + format_run_seconds (*planned);
        }
    }
    return line;
}

ReportVerdict verdict_of (const ordered& document) {
    const ordered& verdict  = member (document, "verdict");
    const std::string state = text_at (verdict, { "state" });
    ReportVerdict out;
    out.label  = verdict_label (state);
    out.tone   = tone_of (state, "passed", "failed");
    out.detail = verdict_detail (document, text_at (verdict, { "reason" }));
    if (member (verdict, "stoppedEarly") == true) {
        out.stopped_early = words (stopped_early_line (document));
    }
    return out;
}

// --- run ------------------------------------------------------------------------------------------------

ReportText target_text (const ordered& document) {
    const std::string method = text_at (document, { "config", "method" });
    const std::string url    = text_at (document, { "config", "url" });
    if (!method.empty () || !url.empty ()) {
        return user (method + (method.empty () || url.empty () ? "" : " ") + url);
    }
    return member (at_path (document, { "report" }), "scenario").is_object () ?
    ReportText ("Collection run") :
    absent ();
}

/// The concurrency, and for a ramp its start level and ramp time too.
ReportText virtual_users_text (const ordered& document) {
    const ordered& config = configuration_of (document);
    const auto peak       = number_at (config, { "concurrency" });
    if (!peak) {
        return absent ();
    }
    std::string out;
    const auto start = number_at (config, { "startConcurrency" });
    if (text_at (config, { "mode" }) == "ramp_up" && start) {
        out = format_run_count (*start) + " to ";
    }
    out += format_run_count (*peak);
    ReportText text     = words (std::move (out));
    const ordered& ramp = member (config, "rampUpDuration");
    if (text_at (config, { "mode" }) == "ramp_up" && ramp.is_string ()) {
        text += ", ramp " + user (ramp.get<std::string> ());
    }
    return text;
}

ReportText duration_text (const ordered& document) {
    const ordered& duration = member (configuration_of (document), "duration");
    if (const auto seconds = duration_seconds (duration)) {
        return words (format_run_seconds (*seconds));
    }
    return duration.is_string () ? user (duration.get<std::string> ()) : absent ();
}

ReportText started_text (const ordered& document) {
    const auto start = number_at (document, { "run", "startTime" });
    if (!start || *start <= 0) {
        return absent ();
    }
    return text_or_absent (words (vayu::utils::format_utc_time (
    static_cast<std::time_t> (*start / 1000), "%Y-%m-%dT%H:%M:%SZ")));
}

ReportText mode_text (const ordered& document) {
    std::string mode = text_at (configuration_of (document), { "mode" });
    std::ranges::replace (mode, '_', ' ');
    return text_or_absent (user (std::move (mode)));
}

ReportRow field_row (std::string_view label, ReportText value) {
    return { plain_cell (std::string (label)), cell (std::move (value)) };
}

Table run_table (const ordered& document) {
    Table table{ { "Field", "Value" }, {} };
    table.rows.push_back (field_row ("Target", target_text (document)));
    table.rows.push_back (field_row ("Mode", mode_text (document)));
    table.rows.push_back (field_row ("Virtual users", virtual_users_text (document)));
    if (const auto rate = number_at (configuration_of (document), { "targetRps" })) {
        table.rows.push_back (
        field_row ("Target rate", words (format_run_figure (*rate) + " req/s")));
    }
    table.rows.push_back (field_row ("Duration", duration_text (document)));
    table.rows.push_back (field_row ("Started", started_text (document)));
    table.rows.push_back (field_row ("Engine version",
    text_or_absent (user (text_at (document, { "engineVersion" })))));
    if (std::string comment = text_at (document, { "run", "comment" }); !comment.empty ()) {
        table.rows.push_back (field_row ("Comment", user (std::move (comment))));
    }
    return table;
}

// --- results ------------------------------------------------------------------------------------------------

/// @p value spelled by @p spell with @p unit, or `-` for a figure the report
/// does not hold.
ReportText figure_text (const std::optional<double>& value,
std::string (*spell) (double),
std::string_view unit = {}) {
    return value ? words (with_unit (spell (*value), unit)) : absent ();
}

/// `15.0%`, and when requests errored the two ways they can: an HTTP error
/// status, or no response at all. The rate is the report's, never recomputed.
ReportText error_rate_text (const ordered& document) {
    const ordered& summary = at_path (document, { "report", "summary" });
    ReportText out =
    figure_text (number_at (summary, { "errorRate" }), format_run_percent, "%");
    const auto http        = number_at (summary, { "httpErrorRequests" });
    const auto no_response = number_at (summary, { "noResponseRequests" });
    if (http.value_or (0) + no_response.value_or (0) <= 0) {
        return out;
    }
    out += words (" (HTTP errors " + format_run_count (http.value_or (0)) +
    ", " + std::string (NO_RESPONSE_LABEL) + ' ' +
    format_run_count (no_response.value_or (0)) + ')');
    return out;
}

ReportRow metric_row (std::string_view label, ReportText value, ReportCell budget) {
    return { plain_cell (std::string (label)), cell (std::move (value)), std::move (budget) };
}

/// `completedWhileSending / sendingDurationSeconds` (#2882), the drain-free
/// counterpart of `avgRps`; nothing for a run stored before either field.
std::optional<double> responses_per_second_while_sending (const ordered& summary) {
    const auto completed = number_at (summary, { "completedWhileSending" });
    const auto seconds   = number_at (summary, { "sendingDurationSeconds" });
    if (!completed || !seconds || *seconds <= 0) {
        return std::nullopt;
    }
    return *completed / *seconds;
}

/// `625 requests skipped: the load generator stalled for 2.5 s` (#2911), the
/// app's dropped-requests card in words. Nothing when the summary holds no skip
/// (a run stored before the field, or one the pacer kept up with), so an older
/// document renders as it always did.
std::optional<ReportText> skipped_requests_text (const ordered& summary) {
    const auto skipped = number_at (summary, { "skippedRequests" });
    if (!skipped || *skipped <= 0) {
        return std::nullopt;
    }
    const double stalled_seconds =
    number_at (summary, { "stalledMs" }).value_or (0) / 1000;
    // A stall under half a tenth of a second would spell "0 s", which reads as
    // no stall at all next to a positive skip count.
    const std::string stalled =
    stalled_seconds > 0 && format_run_seconds (stalled_seconds) == "0 s" ?
    "<0.1 s" :
    format_run_seconds (stalled_seconds);
    return words (format_run_count (*skipped) + (*skipped == 1 ? " request" : " requests") +
    " skipped: the load generator stalled for " + stalled);
}

Table results_table (const ordered& document) {
    const ordered& summary = at_path (document, { "report", "summary" });
    const ReportCell none  = cell (absent ());
    Table table{ { "Metric", "Value", "Budget" }, {} };
    table.rows.push_back (metric_row ("Requests",
    figure_text (number_at (summary, { "totalRequests" }), format_run_count), none));
    if (const auto skipped = skipped_requests_text (summary)) {
        table.rows.push_back (metric_row ("Skipped requests", *skipped, none));
    }
    table.rows.push_back (
    metric_row ("Requests per second (whole run, drain included)",
    figure_text (number_at (summary, { "avgRps" }), format_run_figure, " req/s"),
    budget_cell (document, "minThroughputRps")));
    if (const auto while_sending = responses_per_second_while_sending (summary)) {
        table.rows.push_back (metric_row ("Responses per second while sending",
        figure_text (while_sending, format_run_figure, " req/s"), none));
    }
    table.rows.push_back (metric_row ("Error rate", error_rate_text (document),
    budget_cell (document, "maxErrorRatePct")));
    table.rows.push_back (metric_row ("Bytes in",
    figure_text (number_at (summary, { "bytesReceived" }), format_run_bytes), none));
    table.rows.push_back (metric_row ("Bytes out",
    figure_text (number_at (summary, { "bytesSent" }), format_run_bytes), none));
    return table;
}

struct LatencyRow {
    std::string_view key;
    std::string_view budget;
};

constexpr auto LATENCY_ROWS = std::to_array<LatencyRow> ({
{ "min", "" },
{ "p50", "latencyP50Ms" },
{ "p90", "" },
{ "p95", "latencyP95Ms" },
{ "p99", "latencyP99Ms" },
{ "p999", "" },
{ "max", "" },
});

Table latency_table (const ordered& document) {
    const ordered& latency = at_path (document, { "report", "latency" });
    Table table{ { "Measure", "Latency (ms)", "Budget" }, {} };
    for (const LatencyRow& row : LATENCY_ROWS) {
        table.rows.push_back (metric_row (row.key,
        figure_text (number_at (latency, { row.key }), format_run_figure),
        row.budget.empty () ? cell (absent ()) : budget_cell (document, row.budget)));
    }
    return table;
}

// --- errors ------------------------------------------------------------------------------------------------------

struct CountedLabel {
    ReportText label;
    double count;
    /// What orders two entries of one count: the key as the document spells it.
    std::string key;
};

/// The numeric members of the object at @p path, labelled by @p label_of.
std::vector<CountedLabel>
counted (const ordered& document, Path path, ReportText (*label_of) (const std::string&)) {
    std::vector<CountedLabel> out;
    const ordered& counts = at_path (document, path);
    if (!counts.is_object ()) {
        return out;
    }
    for (const auto& [key, count] : counts.items ()) {
        if (count.is_number () && count.get<double> () > 0) {
            out.push_back ({ label_of (key), count.get<double> (), key });
        }
    }
    return out;
}

/// @p entries, most frequent first, cut to @ref MAX_OPEN_SET_ROWS with the
/// remainder summed into one `Other (<n> <noun>)` row.
void append_capped (std::vector<Row>& rows, std::vector<CountedLabel> entries, std::string_view noun) {
    std::ranges::sort (entries, [] (const CountedLabel& a, const CountedLabel& b) {
        return a.count != b.count ? a.count > b.count : a.key < b.key;
    });
    double rest = 0;
    for (std::size_t at = 0; at < entries.size (); ++at) {
        if (at < MAX_OPEN_SET_ROWS) {
            rows.push_back ({ cell (entries[at].label),
            plain_cell (format_run_count (entries[at].count)) });
        } else {
            rest += entries[at].count;
        }
    }
    if (entries.size () > MAX_OPEN_SET_ROWS) {
        rows.push_back (
        { plain_cell ("Other (" +
          format_run_count (static_cast<double> (entries.size () - MAX_OPEN_SET_ROWS)) +
          ' ' + std::string (noun) + ')'),
        plain_cell (format_run_count (rest)) });
    }
}

/// An error row's label for status @p code: `HTTP 503`, or @ref NO_RESPONSE_LABEL for 0.
ReportText status_code_label (const std::string& code) {
    return code == "0" ? words (std::string (NO_RESPONSE_LABEL)) : "HTTP " + user (code);
}

/// Settles code 0 against the type rows so each no-response request is listed
/// once: the remainder the types do not account for stays as the code row, and
/// the row goes when the types cover it (#2400). A run stored before the
/// per-type counts has types that stop at the error store's cap, so the
/// remainder is the requests no type row can name.
void settle_no_response (std::vector<CountedLabel>& codes,
const std::vector<CountedLabel>& types) {
    double typed = 0;
    for (const CountedLabel& type : types) {
        typed += type.count;
    }
    for (CountedLabel& code : codes) {
        if (code.key == "0") {
            code.count -= typed;
        }
    }
    std::erase_if (
    codes, [] (const CountedLabel& code) { return code.count <= 0; });
}

/// Empty rows when the run recorded no error. Never an `HTTP 0` row: the
/// requests that got no response appear under their types, plus one
/// @ref NO_RESPONSE_LABEL row for any the types do not cover.
Table errors_table (const ordered& document) {
    Table table{ { "Error", "Requests" }, {} };
    auto codes =
    counted (document, { "report", "errors", "byStatusCode" }, status_code_label);
    auto types = counted (document, { "report", "errors", "types" },
    [] (const std::string& type) { return user (type); });
    settle_no_response (codes, types);
    append_capped (table.rows, std::move (codes), "codes");
    append_capped (table.rows, std::move (types), "types");
    return table;
}

// --- comparison ------------------------------------------------------------------------------------------------------

struct ComparedFormat {
    std::string_view metric;
    std::string_view label;
    std::string (*spell) (double);
    std::string_view unit;
};

/// The app's `METRIC_LABELS` and `formatValue`
/// (`run-comparison-format.ts`), keyed by the metric names of `COMPARED_METRICS`.
/// The two rates name their window because both divide by `testDuration`,
/// drain included (#2882).
constexpr auto COMPARED_FORMATS = std::to_array<ComparedFormat> ({
{ "latency.p50", "P50 latency", format_run_figure, " ms" },
{ "latency.p90", "P90 latency", format_run_figure, " ms" },
{ "latency.p95", "P95 latency", format_run_figure, " ms" },
{ "latency.p99", "P99 latency", format_run_figure, " ms" },
{ "latency.avg", "Average latency", format_run_figure, " ms" },
{ "latency.max", "Max latency", format_run_figure, " ms" },
{ "summary.avgRps", "Throughput (whole run, drain included)", format_run_figure, " req/s" },
{ "summary.throughput", "Response rate (whole run, drain included)", format_run_figure, " req/s" },
{ "summary.errorRate", "Error rate", format_run_percent, "%" },
{ "summary.totalRequests", "Total requests", format_run_count, "" },
});

/// `improved`, `regressed` or `unchanged` by the direction the delta carries
/// (`COMPARED_METRICS`, the app's `deltaVerdict`); a metric one run lacks is
/// `not compared`, which is not a claim that nothing moved.
std::string delta_word (const ordered& delta) {
    const auto change = number_at (delta, { "delta" });
    if (!change) {
        return "not compared";
    }
    const std::string direction = text_at (delta, { "direction" });
    if (*change == 0 || direction == NEUTRAL) {
        return "unchanged";
    }
    return (direction == LOWER_IS_BETTER) == (*change < 0) ? "improved" : "regressed";
}

/// `+5 ms (+50.0%)`: the change in the metric's unit, then as a share of the base.
std::string change_text (const ordered& delta, const ComparedFormat& format) {
    const auto change = number_at (delta, { "delta" });
    if (!change) {
        return std::string (ABSENT);
    }
    const auto spell = [&format] (double value) {
        return with_unit (format.spell (value), format.unit);
    };
    std::string out = signed_text (*change, spell);
    if (const auto share = number_at (delta, { "pctChange" })) {
        out += " (" +
        signed_text (*share, [] (double v) { return spell_number (v, 1, false); }) + "%)";
    }
    return out;
}

Row delta_row (const ordered& delta) {
    const std::string metric = text_at (delta, { "metric" });
    const auto found =
    std::ranges::find (COMPARED_FORMATS, metric, &ComparedFormat::metric);
    const ComparedFormat format = found == COMPARED_FORMATS.end () ?
    ComparedFormat{ metric, "", format_run_figure, "" } :
    *found;
    const auto value = [&format] (const std::optional<double>& number) {
        return plain_cell (number ? with_unit (format.spell (*number), format.unit) :
                                    std::string (ABSENT));
    };
    const std::string verdict = delta_word (delta);
    return { format.label.empty () ? cell (user (metric)) :
                                     plain_cell (std::string (format.label)),
        value (number_at (delta, { "base" })), value (number_at (delta, { "target" })),
        plain_cell (change_text (delta, format)),
        cell (words (verdict), tone_of (verdict, "improved", "regressed")) };
}

/// What each `differences[].field` code is called.
constexpr auto DIFFERENCE_LABELS =
std::to_array<std::pair<std::string_view, std::string_view>> ({
{ "run_type", "Run type" },
{ "mode", "Mode" },
{ "concurrency", "Virtual users" },
{ "target_rps", "Target rate" },
{ "duration", "Duration" },
{ "status", "Status" },
{ "http_version", "HTTP version" },
{ "data_file", "Data file" },
{ "request", "Request" },
{ "compression", "Compression" },
{ "expect_continue", "Expect: 100-continue" },
});

ReportText difference_line (const ordered& difference) {
    const std::string field = text_at (difference, { "field" });
    const auto found        = std::ranges::find (DIFFERENCE_LABELS, field,
           &std::pair<std::string_view, std::string_view>::first);
    const ReportText label  = found == DIFFERENCE_LABELS.end () ?
     user (field) :
     words (std::string (found->second));
    return label + ": " + user (text_at (difference, { "base" })) +
    " in the base run, " + user (text_at (difference, { "target" })) + " in this one";
}

/// Empty when the document holds no comparison.
std::optional<ReportComparison> comparison_of (const ordered& document) {
    const ordered& comparison = member (document, "comparison");
    if (!comparison.is_object ()) {
        return std::nullopt;
    }
    ReportComparison out;
    out.base_reference = user (text_at (comparison, { "baseReference" }));
    out.table = { { "Metric", "Base", "This run", "Change", "Result" }, {} };
    const ordered& deltas = member (comparison, "deltas");
    if (deltas.is_array ()) {
        std::ranges::transform (deltas, std::back_inserter (out.table.rows), delta_row);
    }
    const ordered& differences = member (comparison, "differences");
    if (differences.is_array ()) {
        std::ranges::transform (
        differences, std::back_inserter (out.differences), difference_line);
    }
    if (!out.differences.empty ()) {
        out.caveat =
        "The two runs were not set up the same way, so these changes "
        "may not be like for like:";
    }
    return out;
}

// --- warnings -------------------------------------------------------------------------------------------------------------

ReportText warning_names (const ordered& names) {
    ReportText listed;
    for (std::size_t at = 0; at < names.size () && at < MAX_WARNING_NAMES; ++at) {
        const ordered& name = names[at];
        if (at > 0) {
            listed += ", ";
        }
        listed += name.is_string () ? user (name.get<std::string> ()) : absent ();
    }
    if (names.size () > MAX_WARNING_NAMES) {
        listed += words (" and " +
        format_run_count (static_cast<double> (names.size () - MAX_WARNING_NAMES)) + " more");
    }
    return listed;
}

ReportText warning_line (const ordered& warning) {
    ReportText line = user (text_at (warning, { "message" }));
    if (const std::string code = text_at (warning, { "code" }); !code.empty ()) {
        line += " (" + user (code) + ")";
    }
    const ordered& names = member (warning, "names");
    if (names.is_array () && !names.empty ()) {
        line += ": " + warning_names (names);
    }
    return line;
}

/// Empty when the report carries no warning.
std::vector<ReportText> warning_lines (const ordered& document) {
    const ordered& warnings = at_path (document, { "report", "warnings" });
    std::vector<ReportText> lines;
    if (!warnings.is_array ()) {
        return lines;
    }
    for (std::size_t at = 0; at < warnings.size () && at < MAX_WARNINGS; ++at) {
        lines.push_back (warning_line (warnings[at]));
    }
    if (warnings.size () > MAX_WARNINGS) {
        lines.push_back (words ("and " +
        format_run_count (static_cast<double> (warnings.size () - MAX_WARNINGS)) + " more"));
    }
    return lines;
}

ReportText footer_of (const ordered& document) {
    const std::string version = text_at (document, { "engineVersion" });
    return "Generated by Vayu" +
    (version.empty () ? ReportText () : " " + user (version)) +
    ". No request or response data is included.";
}

} // namespace

ReportView build_run_report_view (const ordered& document) {
    const std::string reference = text_at (document, { "run", "reference" });
    const std::string title     = reference_title (reference);
    ReportView view;
    view.title      = title.empty () ? ReportText ("Load test") : user (title);
    view.reference  = user (reference);
    view.verdict    = verdict_of (document);
    view.run        = run_table (document);
    view.results    = results_table (document);
    view.latency    = latency_table (document);
    view.errors     = errors_table (document);
    view.comparison = comparison_of (document);
    view.warnings   = warning_lines (document);
    view.footer     = footer_of (document);
    return view;
}

} // namespace vayu::core
