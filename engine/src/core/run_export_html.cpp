/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/run_export_html.cpp
 * @brief The run-report document as one self-contained HTML page (#2135).
 *
 * What each section says is `run_export_view.cpp`; this file is the page: its
 * stylesheet and palette, the section markup, and the three charts drawn from
 * the document's `timeSeries`.
 */

#include "vayu/core/run_export_html.hpp"

#include "run_export_html_logo.hpp"
#include "svg_chart.hpp"
#include "vayu/core/run_export_view.hpp"
#include "vayu/utils/parse.hpp"
#include "vayu/utils/text_escape.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::core {

namespace {

using ordered = nlohmann::ordered_json;
using vayu::utils::escape_html;

/// A ReportText as HTML: every run, words and free text alike, escaped by the
/// one escaper.
std::string text_of (const ReportText& text) {
    return text.render (escape_html, escape_html);
}

// --- palette and stylesheet ----------------------------------------------------------------------------

struct Token {
    std::string_view name;
    std::string_view light;
    std::string_view dark;
};

/// Every colour the page uses, per scheme. Text pairs hold 4.5:1 and graphical
/// pairs 3:1 against `bg` (`run_export_html_test.cpp` measures both).
constexpr auto PALETTE = std::to_array<Token> ({
{ "bg", "#ffffff", "#10151b" },
{ "surface", "#f3f5f7", "#1a2129" },
{ "text", "#1b1f24", "#e6eaee" },
{ "muted", "#4b5563", "#a6b0bb" },
{ "rule", "#d0d7de", "#2d3640" },
{ "grid", "#e4e8ec", "#26303a" },
{ "axis", "#6b7280", "#8a95a1" },
{ "accent", "#0b5cad", "#79b8ff" },
{ "good-text", "#17703a", "#56d37b" },
{ "good-bg", "#e3f6e8", "#12301d" },
{ "good-mark", "#178040", "#3fb868" },
{ "bad-text", "#b3261e", "#ff8a80" },
{ "bad-bg", "#fdeceb", "#3a1614" },
{ "bad-mark", "#c9362d", "#f0584d" },
{ "rps", "#0b7a75", "#3cc9c0" },
{ "vus", "#6f42c1", "#b392f0" },
{ "p50", "#4d8bd6", "#3d73b8" },
{ "p95", "#2368c4", "#6aa6f0" },
{ "p99", "#0a2f66", "#cfe3ff" },
{ "c2xx", "#178040", "#3fb868" },
{ "c4xx", "#9a6700", "#e3b341" },
{ "c5xx", "#c9362d", "#f0584d" },
{ "cnone", "#7a3fc0", "#c9a0ff" },
{ "ref", "#4b5563", "#a6b0bb" },
});

/// The palette's custom properties for one scheme, one per line.
std::string palette_declarations (bool dark, std::string_view indent) {
    std::string out;
    for (const Token& token : PALETTE) {
        out += std::string (indent) + "--" + std::string (token.name) + ": " +
        std::string (dark ? token.dark : token.light) + ";\n";
    }
    return out;
}

/// Layout and component rules, written against the palette's properties alone.
constexpr std::string_view BASE_CSS = R"css(
@page { margin: 14mm; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 64rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.brand { margin: 0 0 0.35rem; color: var(--muted); font-size: 0.85rem; }
.brand strong { font-size: 0.95rem; }
.brand img { vertical-align: middle; margin-right: 0.4rem; }
h1 { margin: 0 0 0.25rem; font-size: 1.6rem; line-height: 1.25; overflow-wrap: anywhere; }
h2 { margin: 0 0 0.6rem; font-size: 1.1rem; }
section, footer { margin: 1.75rem 0; }
a { color: var(--accent); }
code, .reference { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.85rem; overflow-wrap: anywhere; }
.reference { margin: 0; color: var(--muted); }
nav ul { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; margin: 1rem 0 0; padding: 0; list-style: none; }
.band { padding: 0.6rem 0.9rem; border-left: 0.4rem solid var(--axis); background: var(--surface); }
.band p { margin: 0; }
.band p + p { margin-top: 0.4rem; }
.band strong { font-size: 1.25rem; }
.band-good { border-color: var(--good-mark); background: var(--good-bg); }
.band-good strong { color: var(--good-text); }
.band-bad { border-color: var(--bad-mark); background: var(--bad-bg); }
.band-bad strong { color: var(--bad-text); }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 0.35rem 0.75rem 0.35rem 0; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
thead th { color: var(--muted); font-weight: 600; }
tbody th { font-weight: 600; }
td.tone-good { color: var(--good-text); }
td.tone-bad { color: var(--bad-text); }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1.5rem; margin: 0; }
dl.facts div { display: contents; }
dt { color: var(--muted); font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
ul.plain { margin: 0; padding-left: 1.2rem; }
figure { margin: 0 0 1.25rem; }
figcaption { margin-bottom: 0.25rem; font-weight: 600; }
.chart-note { color: var(--muted); font-size: 0.85rem; }
svg.chart { display: block; width: 100%; height: auto; }
svg .tick, svg .axis-title { fill: var(--muted); font-size: 11px; }
svg .direct { fill: var(--text); font-size: 11px; }
svg .grid { fill: none; stroke: var(--grid); stroke-width: 1; }
svg .axis { fill: none; stroke: var(--axis); stroke-width: 1; }
svg path.ref { fill: none; stroke: var(--ref); stroke-width: 1.2; stroke-dasharray: 5 4; }
svg .line { fill: none; stroke: var(--c); stroke-width: 1.6; stroke-linejoin: round; }
svg .dot { fill: var(--c); }
.s-rps { --c: var(--rps); }
.s-vus { --c: var(--vus); }
.s-p50 { --c: var(--p50); }
.s-p95 { --c: var(--p95); }
.s-p99 { --c: var(--p99); }
.s-2xx { --c: var(--c2xx); }
.s-4xx { --c: var(--c4xx); }
.s-5xx { --c: var(--c5xx); }
.s-none { --c: var(--cnone); }
svg .line.s-p99 { stroke-width: 2.2; }
svg .line.s-4xx { stroke-dasharray: 7 3; }
svg .line.s-none { stroke-dasharray: 2 3; }
@media (max-width: 40rem) { dl.facts { grid-template-columns: 1fr; } }
@media print {
  body { font-size: 11pt; }
  nav { display: none; }
  main { max-width: none; padding: 0; }
  section, figure, footer { break-inside: avoid; }
  #charts { break-inside: auto; }
  .band { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
)css";

/// The page's whole stylesheet: the palette for light, then for dark under
/// `prefers-color-scheme`, then the rules. Print restates the light palette
/// last, so a report printed from a dark screen is still dark ink on paper.
std::string stylesheet () {
    return ":root {\n  color-scheme: light dark;\n" + palette_declarations (false, "  ") +
    "}\n" + "@media (prefers-color-scheme: dark) {\n  :root {\n" +
    palette_declarations (true, "    ") + "  }\n}\n" +
    "@media print {\n  :root {\n    color-scheme: light;\n" +
    palette_declarations (false, "    ") + "  }\n}" + std::string (BASE_CSS);
}

// --- tables and lists -----------------------------------------------------------------------------------------

std::string tone_class (Tone tone) {
    if (tone == Tone::good) {
        return " class=\"tone-good\"";
    }
    return tone == Tone::bad ? " class=\"tone-bad\"" : "";
}

std::string cell_markup (const ReportCell& cell, bool row_header) {
    if (row_header) {
        return "<th scope=\"row\">" + text_of (cell.text) + "</th>";
    }
    return "<td" + tone_class (cell.tone) + ">" + text_of (cell.text) + "</td>";
}

std::string row_markup (const ReportRow& row) {
    std::string out = "<tr>";
    for (std::size_t at = 0; at < row.size (); ++at) {
        out += cell_markup (row[at], at == 0);
    }
    return out + "</tr>\n";
}

/// @p table, labelled by the heading with id @p heading_id.
std::string table_markup (const ReportTable& table, std::string_view heading_id) {
    std::string out = "<div class=\"scroll\"><table aria-labelledby=\"" +
    escape_html (heading_id) + "\">\n<thead><tr>";
    for (const std::string& header : table.headers) {
        out += "<th scope=\"col\">" + escape_html (header) + "</th>";
    }
    out += "</tr></thead>\n<tbody>\n";
    for (const ReportRow& row : table.rows) {
        out += row_markup (row);
    }
    return out + "</tbody>\n</table></div>";
}

/// A two-column table of fields as a description list.
std::string facts_markup (const ReportTable& table) {
    std::string out = "<dl class=\"facts\">\n";
    for (const ReportRow& row : table.rows) {
        if (row.size () == 2) {
            out += "<div><dt>" + text_of (row[0].text) + "</dt><dd>" +
            text_of (row[1].text) + "</dd></div>\n";
        }
    }
    return out + "</dl>";
}

std::string list_markup (const std::vector<ReportText>& items) {
    std::string out = "<ul class=\"plain\">\n";
    for (const ReportText& item : items) {
        out += "<li>" + text_of (item) + "</li>\n";
    }
    return out + "</ul>";
}

// --- the sections ----------------------------------------------------------------------------------------------------

/// One titled block of the page, and the entry for it in the contents list.
struct Section {
    std::string id;
    std::string nav_label;
    /// Heading markup, so a heading can hold a code span.
    std::string heading;
    std::string body;
};

Section section_of (std::string id, const std::string& label, std::string body) {
    return { std::move (id), label, escape_html (label), std::move (body) };
}

std::string band_class (Tone tone) {
    if (tone == Tone::good) {
        return "band band-good";
    }
    return tone == Tone::bad ? "band band-bad" : "band";
}

Section verdict_section (const ReportView& view) {
    const ReportVerdict& verdict = view.verdict;
    std::string body = "<div class=\"" + band_class (verdict.tone) + "\">\n<p><strong>" +
    text_of (verdict.label) + "</strong> - " + text_of (verdict.detail) + "</p>\n";
    if (!verdict.stopped_early.empty ()) {
        body += "<p>" + text_of (verdict.stopped_early) + "</p>\n";
    }
    return section_of ("verdict", "Verdict", body + "</div>");
}

Section comparison_section (const ReportComparison& comparison) {
    std::string body = table_markup (comparison.table, "comparison-h");
    if (!comparison.differences.empty ()) {
        body += "\n<p>" + text_of (comparison.caveat) + "</p>\n" +
        list_markup (comparison.differences);
    }
    Section section = section_of ("comparison", "Comparison", body);
    section.heading = "Compared with <code>" + text_of (comparison.base_reference) + "</code>";
    return section;
}

/// The sections that come from the view, in the Markdown report's order.
std::vector<Section> view_sections (const ReportView& view) {
    std::vector<Section> sections;
    sections.push_back (verdict_section (view));
    sections.push_back (section_of ("run", "Run", facts_markup (view.run)));
    sections.push_back (
    section_of ("results", "Results", table_markup (view.results, "results-h")));
    sections.push_back (
    section_of ("latency", "Latency", table_markup (view.latency, "latency-h")));
    if (!view.errors.rows.empty ()) {
        sections.push_back (
        section_of ("errors", "Errors", table_markup (view.errors, "errors-h")));
    }
    if (view.comparison) {
        sections.push_back (comparison_section (*view.comparison));
    }
    if (!view.warnings.empty ()) {
        sections.push_back (
        section_of ("warnings", "Warnings", list_markup (view.warnings)));
    }
    return sections;
}

// --- charts ----------------------------------------------------------------------------------------------------------

/// The `{elapsed_seconds, key}` points of every tick that has both as numbers.
std::vector<ChartPoint> tick_points (const ordered& ticks, std::string_view key) {
    std::vector<ChartPoint> points;
    for (const ordered& tick : ticks) {
        const auto seconds = doc::number_at (tick, { "elapsed_seconds" });
        const auto value   = doc::number_at (tick, { key });
        if (seconds && value && std::isfinite (*seconds) && std::isfinite (*value)) {
            points.push_back ({ *seconds, *value });
        }
    }
    return points;
}

Chart throughput_chart (const ordered& ticks) {
    return { "chart-throughput", "Throughput and virtual users over time", "Seconds from start",
        { { "Throughput (req/s)",
          { { "Throughput", "rps", " req/s", tick_points (ticks, "current_rps") } }, std::nullopt },
        { "Virtual users (count)",
        { { "Virtual users", "vus", "", tick_points (ticks, "current_concurrency") } },
        std::nullopt } } };
}

/// The p95 budget as a reference line, when the run declared one.
std::optional<ChartReference> p95_budget (const ordered& document) {
    const auto limit =
    doc::number_at (doc::find_check (document, "latencyP95Ms"), { "limit" });
    if (!limit || !std::isfinite (*limit)) {
        return std::nullopt;
    }
    return ChartReference{ "p95 budget " + format_run_figure (*limit) + " ms", *limit };
}

Chart latency_chart (const ordered& document, const ordered& ticks) {
    return { "chart-latency", "Latency percentiles over time", "Seconds from start",
        { { "Latency (ms)",
        { { "p50", "p50", " ms", tick_points (ticks, "latency_p50_ms") },
        { "p95", "p95", " ms", tick_points (ticks, "latency_p95_ms") },
        { "p99", "p99", " ms", tick_points (ticks, "latency_p99_ms") } },
        p95_budget (document) } } };
}

/// The response classes the status chart separates, in the order they stack.
enum class ResponseClass : std::uint8_t {
    success,
    client_error,
    server_error,
    no_response
};

constexpr std::size_t CLASS_COUNT = 4;

struct ClassLabel {
    std::string_view name;
    std::string_view style;
};

constexpr auto CLASS_LABELS = std::to_array<ClassLabel> ({
{ "2xx/3xx", "2xx" },
{ "4xx", "4xx" },
{ "5xx", "5xx" },
{ NO_RESPONSE_LABEL, "none" },
});
static_assert (CLASS_LABELS.size () == CLASS_COUNT);

/// Status code 0 is a transport failure: the request got no response.
ResponseClass class_of (int code) {
    if (code <= 0) {
        return ResponseClass::no_response;
    }
    if (code < 400) {
        return ResponseClass::success;
    }
    return code < 500 ? ResponseClass::client_error : ResponseClass::server_error;
}

using ClassCounts = std::array<double, CLASS_COUNT>;

/// Responses each class gained since the previous tick. A tick carries
/// cumulative counts, so @p seen (the highest count met per code) is what a
/// tick is differenced against; a count that moved backwards adds nothing.
ClassCounts gained_in (const ordered& tick, std::map<int, double>& seen) {
    ClassCounts gained{};
    const ordered& codes = doc::member (tick, "status_codes");
    if (!codes.is_object ()) {
        return gained;
    }
    for (const auto& [key, count] : codes.items ()) {
        const auto code = vayu::utils::parse_number<int> (key);
        if (!code || !count.is_number ()) {
            continue;
        }
        double& before = seen[*code];
        gained.at (std::to_underlying (class_of (*code))) +=
        std::max (count.get<double> () - before, 0.0);
        before = std::max (before, count.get<double> ());
    }
    return gained;
}

/// One series per class that saw a response; a class that never did is not drawn.
std::vector<ChartSeries> status_series (const ordered& ticks) {
    std::array<std::vector<ChartPoint>, CLASS_COUNT> points;
    std::map<int, double> seen;
    for (const ordered& tick : ticks) {
        const auto seconds = doc::number_at (tick, { "elapsed_seconds" });
        if (!seconds || !std::isfinite (*seconds)) {
            continue;
        }
        const ClassCounts gained = gained_in (tick, seen);
        for (std::size_t at = 0; at < CLASS_COUNT; ++at) {
            points.at (at).push_back ({ *seconds, gained.at (at) });
        }
    }
    std::vector<ChartSeries> series;
    for (std::size_t at = 0; at < CLASS_COUNT; ++at) {
        const auto& drawn = points.at (at);
        if (std::ranges::any_of (
            drawn, [] (const ChartPoint& p) { return p.y > 0; })) {
            series.push_back ({ std::string (CLASS_LABELS.at (at).name),
            std::string (CLASS_LABELS.at (at).style), " responses", drawn });
        }
    }
    return series;
}

std::optional<Chart> status_chart (const ordered& ticks) {
    std::vector<ChartSeries> series = status_series (ticks);
    if (series.empty ()) {
        return std::nullopt;
    }
    return Chart{ "chart-status", "Responses per interval by class", "Seconds from start",
        { { "Responses per tick", std::move (series), std::nullopt } } };
}

std::string figure_markup (std::string_view caption, const Chart& chart) {
    return "<figure>\n<figcaption>" + escape_html (caption) +
    "</figcaption>\n" + render_svg_chart (chart) + "\n</figure>\n";
}

constexpr std::string_view NO_SERIES_NOTE =
"This run recorded no time series, so there is nothing to chart.";

/// Said under the charts when a line was thinned, so the picture is not taken
/// for every sample.
constexpr std::string_view THINNED_NOTE =
"Each line is drawn from at most 480 points. Where the run has more ticks, "
"every stretch keeps its lowest and highest value, so a brief spike still "
"shows.";

Section charts_section (const ordered& document) {
    const ordered& ticks = doc::member (document, "timeSeries");
    const bool any       = ticks.is_array () && !ticks.empty ();
    std::string body;
    if (any) {
        body += figure_markup ("Throughput and virtual users", throughput_chart (ticks));
        body += figure_markup ("Latency percentiles", latency_chart (document, ticks));
        if (const auto status = status_chart (ticks)) {
            body += figure_markup ("Responses per interval by class", *status);
        }
        if (ticks.size () > MAX_CHART_POINTS) {
            body += "<p class=\"chart-note\">" + escape_html (THINNED_NOTE) + "</p>\n";
        }
    } else {
        body = "<p>" + escape_html (NO_SERIES_NOTE) + "</p>\n";
    }
    return section_of ("charts", "Charts", body);
}

// --- the page ----------------------------------------------------------------------------------------------------------

std::string head_markup (const ReportView& view) {
    return "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta "
           "charset=\"utf-8\">\n"
           "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src "
           "'none'; "
           "style-src 'unsafe-inline'; img-src data:\">\n"
           "<meta name=\"viewport\" content=\"width=device-width, "
           "initial-scale=1\">\n"
           "<meta name=\"color-scheme\" content=\"light dark\">\n<title>" +
    text_of (view.title) + " - Vayu run report</title>\n<style>\n" +
    stylesheet () + "</style>\n</head>\n";
}

std::string nav_markup (const std::vector<Section>& sections) {
    std::string out = "<nav aria-label=\"Sections\"><ul>\n";
    for (const Section& section : sections) {
        out += "<li><a href=\"#" + escape_html (section.id) + "\">" +
        escape_html (section.nav_label) + "</a></li>\n";
    }
    return out + "</ul></nav>\n";
}

std::string section_markup (const Section& section) {
    const std::string heading_id = escape_html (section.id) + "-h";
    return "<section id=\"" + escape_html (section.id) +
    "\" aria-labelledby=\"" + heading_id + "\">\n<h2 id=\"" + heading_id +
    "\">" + section.heading + "</h2>\n" + section.body + "\n</section>\n";
}

/// The mark and the wordmark. The mark is the one image the page holds, a
/// `data:` URI so it fetches nothing; its `alt` is empty because the wordmark
/// beside it already names the product, and `width`/`height` reserve its box.
std::string brand_markup () {
    return "<p class=\"brand\"><img src=\"data:image/png;base64," +
    std::string (LOGO_PNG_BASE64) +
    "\" alt=\"\" width=\"28\" height=\"28\"><strong>Vayu</strong> run "
    "report</p>\n";
}

std::string title_markup (const ReportView& view) {
    std::string out =
    "<header>\n" + brand_markup () + "<h1>" + text_of (view.title) + "</h1>\n";
    if (!view.reference.empty ()) {
        out += "<p class=\"reference\"><code>" + text_of (view.reference) + "</code></p>\n";
    }
    return out + "</header>\n";
}

} // namespace

std::string render_run_export_html (const ordered& document) {
    const ReportView view         = build_run_report_view (document);
    std::vector<Section> sections = view_sections (view);
    sections.push_back (charts_section (document));
    std::string out = head_markup (view) + "<body>\n<main>\n" +
    title_markup (view) + nav_markup (sections);
    for (const Section& section : sections) {
        out += section_markup (section);
    }
    return out + "<footer>\n<p>" + text_of (view.footer) +
    "</p>\n</footer>\n</main>\n</body>\n</html>\n";
}

} // namespace vayu::core
