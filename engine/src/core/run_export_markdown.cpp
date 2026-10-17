/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/run_export_markdown.cpp
 * @brief The run-report document as Markdown (#2131): a verdict, the run, the
 *        headline numbers, latency against budgets, errors, the comparison
 *        and the warnings, in that order.
 */

#include "vayu/core/run_export_markdown.hpp"

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
#include <initializer_list>
#include <iterator>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::core {

namespace {

using ordered = nlohmann::ordered_json;
using Path    = std::initializer_list<std::string_view>;
using Row     = std::vector<std::string>;

constexpr std::string_view ABSENT = "-";

/// Rows a table fed by an open set (status codes, error types) shows before
/// the rest are folded into one line, so a run that saw 300 distinct codes
/// writes the same few lines as one that saw three.
constexpr std::size_t MAX_OPEN_SET_ROWS = 10;
constexpr std::size_t MAX_WARNINGS      = 10;
constexpr std::size_t MAX_WARNING_NAMES = 5;

// --- reading the document ----------------------------------------------------------

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

// --- numbers -------------------------------------------------------------------------

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

// --- escaping --------------------------------------------------------------------------

namespace {

bool is_ascii_alnum (char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/// Length of the line break or control character at the start of @p rest, or 0.
/// CR, LF, the other C0 controls, DEL, NEL, U+2028 and U+2029: each can end a
/// line in some Markdown reader.
std::size_t break_length (std::string_view rest) {
    constexpr std::string_view LINE_SEPARATOR      = "\xE2\x80\xA8";
    constexpr std::string_view PARAGRAPH_SEPARATOR = "\xE2\x80\xA9";
    constexpr std::string_view NEXT_LINE           = "\xC2\x85";
    const auto first = static_cast<unsigned char> (rest.front ());
    if (first < 0x20 || first == 0x7F) {
        return 1;
    }
    for (const std::string_view wide : { LINE_SEPARATOR, PARAGRAPH_SEPARATOR, NEXT_LINE }) {
        if (rest.starts_with (wide)) {
            return wide.size ();
        }
    }
    return 0;
}

/// @p text with each run of breaks and control characters one space.
std::string collapse_breaks (std::string_view text) {
    std::string out;
    bool in_break = false;
    for (std::size_t at = 0; at < text.size ();) {
        const std::size_t length = break_length (text.substr (at));
        if (length > 0) {
            if (!in_break) {
                out += ' ';
            }
            in_break = true;
            at += length;
            continue;
        }
        in_break = false;
        out += text[at];
        ++at;
    }
    return out;
}

/// Whether the `&` at @p at starts something a reader would turn into a
/// character (`&lt;`, `&#60;`): `&b=2` in a URL does not.
bool starts_entity (std::string_view text, std::size_t at) {
    std::size_t end = at + 1;
    if (end < text.size () && text[end] == '#') {
        ++end;
    }
    const std::size_t name = end;
    while (end < text.size () && is_ascii_alnum (text[end])) {
        ++end;
    }
    return end > name && end < text.size () && text[end] == ';';
}

/// An underscore between two letters or digits opens no emphasis, so it is
/// left as it is: identifiers and URLs stay readable as raw text.
bool is_intraword (std::string_view text, std::size_t at) {
    return at > 0 && at + 1 < text.size () && is_ascii_alnum (text[at - 1]) &&
    is_ascii_alnum (text[at + 1]);
}

bool needs_escape (std::string_view text, std::size_t at) {
    switch (text[at]) {
    case '\\':
    case '`':
    case '*':
    case '[':
    case ']':
    case '<':
    case '>':
    case '|':
    case '~': return true;
    case '_': return !is_intraword (text, at);
    case '&': return starts_entity (text, at);
    default: return false;
    }
}

/// Whether the character at @p at, which starts the line, ends the marker of
/// a block: a space, or the end of the text.
bool ends_marker (std::string_view text, std::size_t at) {
    return at + 1 >= text.size () || text[at + 1] == ' ' || text[at + 1] == '\t';
}

/// The index of the character that, escaped, keeps @p text from opening a
/// block when it starts a line (`# `, `- `, `+ `, `1. `, or a run of `-`/`#`),
/// or npos. A marker with no space after it opens nothing, so `-5 ms` and
/// `1.5 s` are left as they are.
std::size_t block_marker_at (std::string_view text) {
    if (text.empty ()) {
        return std::string_view::npos;
    }
    const char first = text.front ();
    if ((first == '#' || first == '-' || first == '+') &&
    (ends_marker (text, 0) || (first != '+' && text.size () > 1 && text[1] == first))) {
        return 0;
    }
    const std::size_t digits = text.find_first_not_of ("0123456789");
    if (digits != 0 && digits < text.size () &&
    (text[digits] == '.' || text[digits] == ')') && ends_marker (text, digits)) {
        return digits;
    }
    return std::string_view::npos;
}

/// @p text as an inline code span, whose fence is one backtick longer than any
/// run inside it so nothing in the text can end the span.
std::string code_span (std::string_view text) {
    const std::string flat = collapse_breaks (text);
    std::size_t longest    = 0;
    std::size_t run        = 0;
    for (const char c : flat) {
        run     = c == '`' ? run + 1 : 0;
        longest = std::max (longest, run);
    }
    const std::string fence (longest + 1, '`');
    const bool padded = flat.starts_with ('`') || flat.ends_with ('`') ||
    (flat.starts_with (' ') && flat.ends_with (' '));
    return fence + (padded ? " " : "") + flat + (padded ? " " : "") + fence;
}

} // namespace

std::string escape_markdown_cell (std::string_view text) {
    // Leading spaces go: two to three of them before a `#` or `1.`, or four
    // before anything, still open a block after a `- ` prefix, and no reader
    // of a cell or a heading sees them.
    const std::string collapsed = collapse_breaks (text);
    const std::string_view flat = std::string_view (collapsed).substr (
    std::min (collapsed.find_first_not_of (' '), collapsed.size ()));
    const std::size_t marker = block_marker_at (flat);
    std::string out;
    for (std::size_t at = 0; at < flat.size (); ++at) {
        if (at == marker || needs_escape (flat, at)) {
            out += '\\';
        }
        out += flat[at];
    }
    return out;
}

namespace {

std::string cell_or_absent (std::string text) {
    return text.empty () ? std::string (ABSENT) : std::move (text);
}

// --- tables ---------------------------------------------------------------------------------

/// Code points, which is what a monospace reader counts.
std::size_t display_width (std::string_view text) {
    return static_cast<std::size_t> (std::ranges::count_if (text,
    [] (char c) { return (static_cast<unsigned char> (c) & 0xC0) != 0x80; }));
}

std::string padded_line (const Row& cells, const std::vector<std::size_t>& widths) {
    std::string line = "|";
    for (std::size_t column = 0; column < widths.size (); ++column) {
        const std::string& cell = cells.at (column);
        line += ' ' + cell +
        std::string (widths.at (column) - display_width (cell), ' ') + " |";
    }
    return line + '\n';
}

/// A GFM table whose columns are padded to their widest cell, so it reads as a
/// table before it is rendered. Every cell is already escaped.
std::string render_table (const Row& headers, const std::vector<Row>& rows) {
    constexpr std::size_t MIN_WIDTH = 3;
    std::vector<std::size_t> widths (headers.size (), MIN_WIDTH);
    const auto widen = [&widths] (const Row& row) {
        for (std::size_t column = 0; column < widths.size (); ++column) {
            widths.at (column) =
            std::max (widths.at (column), display_width (row.at (column)));
        }
    };
    widen (headers);
    std::ranges::for_each (rows, widen);
    Row rule;
    for (const std::size_t width : widths) {
        rule.emplace_back (width, '-');
    }
    std::string out = padded_line (headers, widths) + padded_line (rule, widths);
    for (const Row& row : rows) {
        out += padded_line (row, widths);
    }
    return out;
}

void add_block (std::string& out, const std::string& block) {
    out += block;
    out += '\n';
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

/// The check that judged @p key, or null.
const ordered& find_check (const ordered& document, std::string_view key) {
    static const ordered absent;
    const ordered& checks = budget_checks (document);
    if (!checks.is_array ()) {
        return absent;
    }
    const auto found = std::ranges::find_if (checks,
    [key] (const ordered& check) { return text_at (check, { "metric" }) == key; });
    return found == checks.end () ? absent : *found;
}

std::string budget_figure (const ordered& check, double value) {
    const BudgetMetric* meta = find_budget_metric (text_at (check, { "metric" }));
    return meta == nullptr ? format_run_figure (value) :
                             with_unit (meta->figure (value), meta->unit);
}

std::string budget_name (const ordered& check) {
    const std::string key    = text_at (check, { "metric" });
    const BudgetMetric* meta = find_budget_metric (key);
    return meta == nullptr ? escape_markdown_cell (key) : std::string (meta->name);
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
std::string budget_cell (const ordered& document, std::string_view key) {
    const ordered& check = find_check (document, key);
    if (!check.is_object ()) {
        return std::string (ABSENT);
    }
    return budget_limit (check) + " - " + budget_status (check);
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

std::string title_block (const ordered& document) {
    const std::string reference = text_at (document, { "run", "reference" });
    const std::string title     = reference_title (reference);
    std::string out =
    "# " + escape_markdown_cell (title.empty () ? "Load test" : title) + "\n\n";
    if (!reference.empty ()) {
        out += code_span (reference) + '\n';
    }
    return out;
}

// --- verdict ------------------------------------------------------------------------------------------

std::string verdict_label (std::string_view state) {
    if (state == "passed") {
        return "Passed";
    }
    if (state == "failed") {
        return "Failed";
    }
    return state == "not_judged" ? "Not judged" : escape_markdown_cell (state);
}

/// Every check that did not pass, as `p95 <= 30 ms missed (41 ms)`.
std::string missed_budgets (const ordered& document) {
    const ordered& checks = budget_checks (document);
    std::string out;
    if (!checks.is_array ()) {
        return out;
    }
    for (const ordered& check : checks) {
        if (!is_false (member (check, "passed"))) {
            continue;
        }
        out += out.empty () ? "" : "; ";
        out += budget_name (check) + ' ' + budget_limit (check) + ' ' +
        budget_status (check);
        if (const auto actual = number_at (check, { "actual" });
        actual && !is_false (member (check, "evaluated"))) {
            out += " (" + budget_figure (check, *actual) + ')';
        }
    }
    return out;
}

/// `3 of 3 budgets met`, from the counts the report holds.
std::string budgets_met_text (const ordered& document) {
    const ordered& thresholds = at_path (document, { "report", "thresholdValidation" });
    const double passed = number_at (thresholds, { "passed" }).value_or (0);
    const double failed = number_at (thresholds, { "failed" }).value_or (0);
    const double total  = passed + failed;
    return format_run_count (passed) + " of " + format_run_count (total) +
    (total == 1 ? " budget met" : " budgets met");
}

std::string errored_text (const ordered& document) {
    const double rate =
    number_at (document, { "report", "summary", "errorRate" }).value_or (0);
    return format_run_percent (rate) + "% of requests errored";
}

/// The words after the verdict's label, chosen by the document's own `reason`.
std::string verdict_detail (const ordered& document, std::string_view reason) {
    if (reason == "budgets_met") {
        return budgets_met_text (document);
    }
    if (reason == "budgets_missed") {
        const std::string missed = missed_budgets (document);
        return missed.empty () ? "budgets missed" : missed;
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
    std::string words = escape_markdown_cell (reason);
    std::ranges::replace (words, '_', ' ');
    return words;
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

std::string verdict_block (const ordered& document) {
    const ordered& verdict = member (document, "verdict");
    std::string out = "**" + verdict_label (text_at (verdict, { "state" })) +
    "** - " + verdict_detail (document, text_at (verdict, { "reason" })) + '\n';
    if (member (verdict, "stoppedEarly") == true) {
        out += '\n' + stopped_early_line (document) + '\n';
    }
    return out;
}

// --- run ------------------------------------------------------------------------------------------------

std::string target_text (const ordered& document) {
    const std::string method = text_at (document, { "config", "method" });
    const std::string url    = text_at (document, { "config", "url" });
    if (!method.empty () || !url.empty ()) {
        return escape_markdown_cell (
        method + (method.empty () || url.empty () ? "" : " ") + url);
    }
    return member (at_path (document, { "report" }), "scenario").is_object () ?
    "Collection run" :
    std::string (ABSENT);
}

/// The concurrency, and for a ramp its start level and ramp time too.
std::string virtual_users_text (const ordered& document) {
    const ordered& config = configuration_of (document);
    const auto peak       = number_at (config, { "concurrency" });
    if (!peak) {
        return std::string (ABSENT);
    }
    std::string out;
    const auto start = number_at (config, { "startConcurrency" });
    if (text_at (config, { "mode" }) == "ramp_up" && start) {
        out = format_run_count (*start) + " to ";
    }
    out += format_run_count (*peak);
    const ordered& ramp = member (config, "rampUpDuration");
    if (text_at (config, { "mode" }) == "ramp_up" && ramp.is_string ()) {
        out += ", ramp " + escape_markdown_cell (ramp.get_ref<const std::string&> ());
    }
    return out;
}

std::string duration_text (const ordered& document) {
    const ordered& duration = member (configuration_of (document), "duration");
    if (const auto seconds = duration_seconds (duration)) {
        return format_run_seconds (*seconds);
    }
    return duration.is_string () ?
    escape_markdown_cell (duration.get<std::string> ()) :
    std::string (ABSENT);
}

std::string started_text (const ordered& document) {
    const auto start = number_at (document, { "run", "startTime" });
    if (!start || *start <= 0) {
        return std::string (ABSENT);
    }
    return cell_or_absent (vayu::utils::format_utc_time (
    static_cast<std::time_t> (*start / 1000), "%Y-%m-%dT%H:%M:%SZ"));
}

std::string mode_text (const ordered& document) {
    std::string mode = text_at (configuration_of (document), { "mode" });
    std::ranges::replace (mode, '_', ' ');
    return cell_or_absent (escape_markdown_cell (mode));
}

std::string run_block (const ordered& document) {
    std::vector<Row> rows = {
        { "Target", target_text (document) },
        { "Mode", mode_text (document) },
        { "Virtual users", virtual_users_text (document) },
    };
    if (const auto rate = number_at (configuration_of (document), { "targetRps" })) {
        rows.push_back ({ "Target rate", with_unit (format_run_figure (*rate), " req/s") });
    }
    rows.push_back ({ "Duration", duration_text (document) });
    rows.push_back ({ "Started", started_text (document) });
    rows.push_back ({ "Engine version",
    cell_or_absent (escape_markdown_cell (text_at (document, { "engineVersion" }))) });
    if (const std::string comment = text_at (document, { "run", "comment" });
    !comment.empty ()) {
        rows.push_back ({ "Comment", escape_markdown_cell (comment) });
    }
    return "## Run\n\n" + render_table ({ "Field", "Value" }, rows);
}

// --- results ------------------------------------------------------------------------------------------------

/// @p value spelled by @p spell with @p unit, or `-` for a figure the report
/// does not hold.
std::string figure_cell (const std::optional<double>& value,
std::string (*spell) (double),
std::string_view unit = {}) {
    return value ? with_unit (spell (*value), unit) : std::string (ABSENT);
}

/// `15.0%`, and when requests errored the two ways they can: an HTTP error
/// status, or no response at all. The rate is the report's, never recomputed.
std::string error_rate_cell (const ordered& document) {
    const ordered& summary = at_path (document, { "report", "summary" });
    std::string out =
    figure_cell (number_at (summary, { "errorRate" }), format_run_percent, "%");
    const auto http        = number_at (summary, { "httpErrorRequests" });
    const auto no_response = number_at (summary, { "noResponseRequests" });
    if (http.value_or (0) + no_response.value_or (0) <= 0) {
        return out;
    }
    out += " (HTTP errors " + format_run_count (http.value_or (0)) +
    ", No response " + format_run_count (no_response.value_or (0)) + ')';
    return out;
}

std::string results_block (const ordered& document) {
    const ordered& summary      = at_path (document, { "report", "summary" });
    const std::vector<Row> rows = {
        { "Requests", figure_cell (number_at (summary, { "totalRequests" }), format_run_count),
        std::string (ABSENT) },
        { "Requests per second",
        figure_cell (number_at (summary, { "avgRps" }), format_run_figure, " req/s"),
        budget_cell (document, "minThroughputRps") },
        { "Error rate", error_rate_cell (document), budget_cell (document, "maxErrorRatePct") },
        { "Bytes in", figure_cell (number_at (summary, { "bytesReceived" }), format_run_bytes),
        std::string (ABSENT) },
        { "Bytes out", figure_cell (number_at (summary, { "bytesSent" }), format_run_bytes),
        std::string (ABSENT) },
    };
    return "## Results\n\n" + render_table ({ "Metric", "Value", "Budget" }, rows);
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

std::string latency_block (const ordered& document) {
    const ordered& latency = at_path (document, { "report", "latency" });
    std::vector<Row> rows;
    rows.reserve (LATENCY_ROWS.size ());
    for (const LatencyRow& row : LATENCY_ROWS) {
        rows.push_back ({ std::string (row.key),
        figure_cell (number_at (latency, { row.key }), format_run_figure),
        row.budget.empty () ? std::string (ABSENT) : budget_cell (document, row.budget) });
    }
    return "## Latency\n\n" + render_table ({ "Measure", "Latency (ms)", "Budget" }, rows);
}

// --- errors ------------------------------------------------------------------------------------------------------

struct CountedLabel {
    std::string label;
    double count;
};

/// The numeric members of the object at @p path, labelled by @p label_of.
std::vector<CountedLabel> counted (const ordered& document,
Path path,
std::string (*label_of) (const std::string&)) {
    std::vector<CountedLabel> out;
    const ordered& counts = at_path (document, path);
    if (!counts.is_object ()) {
        return out;
    }
    for (const auto& [key, count] : counts.items ()) {
        if (count.is_number () && count.get<double> () > 0) {
            out.push_back ({ label_of (key), count.get<double> () });
        }
    }
    return out;
}

/// @p entries, most frequent first, cut to @ref MAX_OPEN_SET_ROWS with the
/// remainder summed into one `Other (<n> <noun>)` row.
void append_capped (std::vector<Row>& rows, std::vector<CountedLabel> entries, std::string_view noun) {
    std::ranges::sort (entries, [] (const CountedLabel& a, const CountedLabel& b) {
        return a.count != b.count ? a.count > b.count : a.label < b.label;
    });
    double rest = 0;
    for (std::size_t at = 0; at < entries.size (); ++at) {
        if (at < MAX_OPEN_SET_ROWS) {
            rows.push_back ({ entries[at].label, format_run_count (entries[at].count) });
        } else {
            rest += entries[at].count;
        }
    }
    if (entries.size () > MAX_OPEN_SET_ROWS) {
        rows.push_back ({ "Other (" +
        format_run_count (static_cast<double> (entries.size () - MAX_OPEN_SET_ROWS)) +
        ' ' + std::string (noun) + ')',
        format_run_count (rest) });
    }
}

/// Empty when the run recorded no error.
std::string errors_block (const ordered& document) {
    std::vector<Row> rows;
    append_capped (rows,
    counted (document, { "report", "errors", "byStatusCode" },
    [] (
    const std::string& code) { return "HTTP " + escape_markdown_cell (code); }),
    "codes");
    append_capped (rows,
    counted (document, { "report", "errors", "types" },
    [] (const std::string& type) { return escape_markdown_cell (type); }),
    "types");
    if (rows.empty ()) {
        return {};
    }
    return "## Errors\n\n" + render_table ({ "Error", "Requests" }, rows);
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
constexpr auto COMPARED_FORMATS = std::to_array<ComparedFormat> ({
{ "latency.p50", "P50 latency", format_run_figure, " ms" },
{ "latency.p90", "P90 latency", format_run_figure, " ms" },
{ "latency.p95", "P95 latency", format_run_figure, " ms" },
{ "latency.p99", "P99 latency", format_run_figure, " ms" },
{ "latency.avg", "Average latency", format_run_figure, " ms" },
{ "latency.max", "Max latency", format_run_figure, " ms" },
{ "summary.avgRps", "Throughput", format_run_figure, " req/s" },
{ "summary.throughput", "Response rate", format_run_figure, " req/s" },
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
        return number ? with_unit (format.spell (*number), format.unit) :
                        std::string (ABSENT);
    };
    return { format.label.empty () ? escape_markdown_cell (metric) :
                                     std::string (format.label),
        value (number_at (delta, { "base" })), value (number_at (delta, { "target" })),
        change_text (delta, format), delta_word (delta) };
}

/// What each `differences[].field` code is called.
constexpr auto DIFFERENCE_LABELS =
std::to_array<std::pair<std::string_view, std::string_view>> ({
{ "mode", "Mode" },
{ "concurrency", "Virtual users" },
{ "target_rps", "Target rate" },
{ "duration", "Duration" },
{ "status", "Status" },
{ "http_version", "HTTP version" },
{ "data_file", "Data file" },
{ "request", "Request" },
{ "compression", "Compression" },
});

std::string difference_line (const ordered& difference) {
    const std::string field = text_at (difference, { "field" });
    const auto found        = std::ranges::find (DIFFERENCE_LABELS, field,
           &std::pair<std::string_view, std::string_view>::first);
    const std::string label = found == DIFFERENCE_LABELS.end () ?
    escape_markdown_cell (field) :
    std::string (found->second);
    return "- " + label + ": " +
    escape_markdown_cell (text_at (difference, { "base" })) + " in the base run, " +
    escape_markdown_cell (text_at (difference, { "target" })) + " in this one\n";
}

/// Empty when the document holds no comparison.
std::string comparison_block (const ordered& document) {
    const ordered& comparison = member (document, "comparison");
    if (!comparison.is_object ()) {
        return {};
    }
    std::vector<Row> rows;
    const ordered& deltas = member (comparison, "deltas");
    if (deltas.is_array ()) {
        std::ranges::transform (deltas, std::back_inserter (rows), delta_row);
    }
    std::string out = "## Compared with " +
    code_span (text_at (comparison, { "baseReference" })) + "\n\n" +
    render_table ({ "Metric", "Base", "This run", "Change", "Result" }, rows);
    const ordered& differences = member (comparison, "differences");
    if (differences.is_array () && !differences.empty ()) {
        out += "\nThe two runs were not set up the same way, so these changes "
               "may not be "
               "like for like:\n\n";
        for (const ordered& difference : differences) {
            out += difference_line (difference);
        }
    }
    return out;
}

// --- warnings -------------------------------------------------------------------------------------------------------------

std::string warning_line (const ordered& warning) {
    std::string line = "- " + escape_markdown_cell (text_at (warning, { "message" }));
    if (const std::string code = text_at (warning, { "code" }); !code.empty ()) {
        line += " (" + escape_markdown_cell (code) + ')';
    }
    const ordered& names = member (warning, "names");
    if (names.is_array () && !names.empty ()) {
        std::string listed;
        for (std::size_t at = 0; at < names.size () && at < MAX_WARNING_NAMES; ++at) {
            const ordered& name = names[at];
            listed += (at == 0 ? "" : ", ") +
            (name.is_string () ?
            escape_markdown_cell (name.get_ref<const std::string&> ()) :
            std::string (ABSENT));
        }
        line += ": " + listed;
        if (names.size () > MAX_WARNING_NAMES) {
            line += " and " +
            format_run_count (static_cast<double> (names.size () - MAX_WARNING_NAMES)) + " more";
        }
    }
    return line + '\n';
}

/// Empty when the report carries no warning.
std::string warnings_block (const ordered& document) {
    const ordered& warnings = at_path (document, { "report", "warnings" });
    if (!warnings.is_array () || warnings.empty ()) {
        return {};
    }
    std::string out = "## Warnings\n\n";
    for (std::size_t at = 0; at < warnings.size () && at < MAX_WARNINGS; ++at) {
        out += warning_line (warnings[at]);
    }
    if (warnings.size () > MAX_WARNINGS) {
        out += "- and " +
        format_run_count (static_cast<double> (warnings.size () - MAX_WARNINGS)) + " more\n";
    }
    return out;
}

std::string footer_block (const ordered& document) {
    const std::string version = text_at (document, { "engineVersion" });
    return std::string ("---\n\nGenerated by Vayu") +
    (version.empty () ? "" : ' ' + escape_markdown_cell (version)) +
    ". No request or response data is included.\n";
}

} // namespace

std::string render_run_export_markdown (const ordered& document) {
    std::string out;
    for (const auto section : { title_block, verdict_block, run_block, results_block,
         latency_block, errors_block, comparison_block, warnings_block, footer_block }) {
        if (const std::string block = section (document); !block.empty ()) {
            add_block (out, block);
        }
    }
    out.pop_back ();
    return out;
}

} // namespace vayu::core
