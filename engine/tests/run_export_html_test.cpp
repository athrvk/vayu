/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_export_html_test.cpp
 * @brief The run-report document as one self-contained HTML page (#2135):
 *        that it loads and runs nothing, escapes every string it writes,
 *        stays small for a run of any length without losing a spike, draws
 *        its axes from zero and its status chart from per-tick differences,
 *        reads in light, dark and print, and matches its goldens.
 *
 * The golden cases are `tests/fixtures/run-export/<case>.document.json` and
 * `<case>.golden.html`; a deliberate change to the page is regenerated and its
 * diff reviewed, never edited by hand:
 *
 *     VAYU_UPDATE_GOLDEN=1 ctest --preset linux-dev -R RunExportHtml
 *
 * Mutation checks (revert each and the named case reds): add a `<link
 * rel=stylesheet href=https://...>` to the head, a `url(https://...)` to the
 * stylesheet, or make the target URL an `<a href>` and the no-network cases
 * red; write the run's comment without `escape_html` and the hostile-text case
 * reds; thin a series by taking every Nth sample and the spike case reds; feed
 * the status chart the cumulative counts and the per-interval case reds; take
 * a dark text token below 4.5:1 and the contrast case reds.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <fstream>
#include <map>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "chart_decode.hpp"
#include "optional_assert.hpp"
#include "run_export_fixtures.hpp"
#include "vayu/core/run_export_html.hpp"
#include "vayu/utils/text_escape.hpp"

namespace {

using nlohmann::ordered_json;
using vayu::core::render_run_export_html;
using vayu::tests::case_path;
using vayu::tests::drawn_values;
using vayu::tests::env_is_set;
using vayu::tests::panels_in;
using vayu::tests::read_bytes;
using vayu::tests::read_document;
using vayu::tests::y_labels_bottom_up;
using vayu::utils::escape_html;

/// Every document the Markdown goldens use, so the page is exercised on stopped
/// runs, collection runs, comparisons and hostile text as well as the goldens.
constexpr auto ALL_CASES = std::to_array<std::string_view> (
{ "healthy-passed", "errors-and-budget-failed", "stopped-early",
"vs-baseline-regressed", "no-budgets", "collection-load", "hostile-text" });

/// The cases whose rendered page is pinned byte for byte.
constexpr auto GOLDEN_CASES =
std::to_array<std::string_view> ({ "healthy-passed", "errors-and-budget-failed" });

constexpr std::size_t SIZE_LIMIT_BYTES = 300000;

// --- reading the page back -----------------------------------------------------------------

/// @p html with every text node removed, so what is left is the markup a
/// browser would act on. A `<style>` element's content is kept: it is text to
/// the parser and instructions to the renderer.
std::string markup_only (const std::string& html) {
    std::string out;
    for (std::size_t at = 0; at < html.size ();) {
        if (html[at] != '<') {
            ++at;
            continue;
        }
        const std::size_t end = html.find ('>', at);
        if (end == std::string::npos) {
            out += html.substr (at);
            break;
        }
        out += html.substr (at, end - at + 1);
        const bool opens_style = html.compare (at, 6, "<style") == 0;
        at                     = end + 1;
        if (opens_style) {
            const std::size_t close = html.find ("</style>", at);
            out += html.substr (at, close - at);
            at = close;
        }
    }
    return out;
}

/// Whether @p markup has an attribute named `on<letters>`, an inline event handler.
bool has_event_handler (const std::string& markup) {
    for (std::size_t at = 1; at + 2 < markup.size (); ++at) {
        const bool starts_attribute =
        std::isspace (static_cast<unsigned char> (markup[at - 1])) != 0;
        if (!starts_attribute || markup.compare (at, 2, "on") != 0) {
            continue;
        }
        std::size_t name_end = at + 2;
        while (name_end < markup.size () &&
        std::isalpha (static_cast<unsigned char> (markup[name_end])) != 0) {
            ++name_end;
        }
        if (name_end > at + 2 && name_end < markup.size () && markup[name_end] == '=') {
            return true;
        }
    }
    return false;
}

/// Every `href="..."` value in @p markup.
std::vector<std::string> hrefs_in (const std::string& markup) {
    constexpr std::string_view OPEN = " href=\"";
    std::vector<std::string> hrefs;
    for (auto at = markup.find (OPEN); at != std::string::npos;
    at           = markup.find (OPEN, at + 1)) {
        const std::size_t from = at + OPEN.size ();
        hrefs.push_back (markup.substr (from, markup.find ('"', from) - from));
    }
    return hrefs;
}

/// The page's stylesheet, between its `<style>` tags.
std::string stylesheet_of (const std::string& html) {
    const std::size_t open = html.find ("<style>");
    const std::size_t from = open + std::string_view ("<style>").size ();
    return html.substr (from, html.find ("</style>") - from);
}

// --- documents ---------------------------------------------------------------------------------

/// A tick with every member the schema requires.
ordered_json tick (double seconds,
double rps,
double users,
const ordered_json& codes,
double p50 = 90,
double p95 = 170,
double p99 = 240) {
    return { { "elapsed_seconds", seconds }, { "requests_completed", 0 },
        { "requests_failed", 0 }, { "current_rps", rps },
        { "current_concurrency", users }, { "throughput", rps },
        { "error_rate", 0.0 }, { "status_codes", codes }, { "latency_p50_ms", p50 },
        { "latency_p95_ms", p95 }, { "latency_p99_ms", p99 } };
}

ordered_json with_ticks (std::string_view name, const std::vector<ordered_json>& ticks) {
    ordered_json document  = read_document (name);
    document["timeSeries"] = ticks;
    return document;
}

/// Twenty thousand one-second ticks with one p99 spike at the fifth second.
ordered_json long_run () {
    std::vector<ordered_json> ticks;
    ticks.reserve (20000);
    for (int second = 1; second <= 20000; ++second) {
        ticks.push_back (tick (second, 500, 50, { { "200", 500 * second } }, 94,
        171, second == 5 ? 5000 : 240));
    }
    return with_ticks ("healthy-passed", ticks);
}

// --- loading nothing, running nothing ---------------------------------------------------------------

void expect_loads_and_runs_nothing (const std::string& html, std::string_view what) {
    ASSERT_FALSE (html.empty ()) << what;
    const std::string markup = markup_only (html);
    for (const std::string_view forbidden : { "://", "//cdn", "<script",
         "<link", "<iframe", "<object", "<embed", "@import", "url(",
         "src=", "@font-face", "<img", "<image", "<foreignObject", "xmlns" }) {
        EXPECT_EQ (markup.find (forbidden), std::string::npos) << what << ": " << forbidden;
    }
    EXPECT_FALSE (has_event_handler (markup)) << what;
    const std::vector<std::string> hrefs = hrefs_in (markup);
    for (const std::string& href : hrefs) {
        EXPECT_TRUE (href.starts_with ("#")) << what << ": href=\"" << href << "\"";
    }
    EXPECT_NE (
    markup.find ("<meta http-equiv=\"Content-Security-Policy\" "
                 "content=\"default-src 'none'; style-src 'unsafe-inline'\">"),
    std::string::npos)
    << what;
}

TEST (RunExportHtmlTest, EveryFixtureLoadsAndRunsNothing) {
    for (const std::string_view name : ALL_CASES) {
        expect_loads_and_runs_nothing (render_run_export_html (read_document (name)), name);
    }
}

TEST (RunExportHtmlTest, ALongRunWithEveryChartLoadsAndRunsNothing) {
    expect_loads_and_runs_nothing (render_run_export_html (long_run ()), "long run");
}

TEST (RunExportHtmlTest, TheOnlyLinksAreToItsOwnSections) {
    const std::string markup = markup_only (
    render_run_export_html (read_document ("errors-and-budget-failed")));
    const std::vector<std::string> hrefs = hrefs_in (markup);
    // Not vacuous: the contents list links every section the page has.
    ASSERT_GE (hrefs.size (), 6U);
    for (const std::string& href : hrefs) {
        const std::string anchor = "id=\"" + href.substr (1) + "\"";
        EXPECT_NE (markup.find (anchor), std::string::npos) << href;
    }
}

TEST (RunExportHtmlTest, TheTargetUrlIsTextNeverALink) {
    const std::string html =
    render_run_export_html (read_document ("healthy-passed"));
    EXPECT_NE (
    html.find ("<dd>GET https://api.example.test/orders?page=1</dd>"), std::string::npos);
    EXPECT_EQ (markup_only (html).find ("<a href=\"http"), std::string::npos);
}

// --- hostile text -------------------------------------------------------------------------------------

constexpr auto HOSTILE_TEXTS = std::to_array<std::string_view> ({
R"("><script>alert(1)</script>)",
R"(&lt;img src=x onerror=alert(1)&gt;')",
});

/// A document that writes every kind of free text: the run's name and comment,
/// its URL and configuration strings, error keys, warnings, a custom budget and
/// a comparison with a differing data file.
ordered_json full_document () {
    ordered_json document       = read_document ("errors-and-budget-failed");
    const ordered_json baseline = read_document ("vs-baseline-regressed");
    document["comparison"]      = baseline["comparison"];
    document["run"]["comment"]  = "a comment";
    document["config"]["configuration"]["mode"]             = "ramp_up";
    document["config"]["configuration"]["startConcurrency"] = 10;
    document["config"]["configuration"]["rampUpDuration"]   = "10s";
    document["comparison"]["differences"].push_back (
    { { "field", "data_file" }, { "base", "old.csv" }, { "target", "new.csv" } });
    document["report"]["warnings"][0]["names"] =
    ordered_json::array ({ "step one" });
    document["report"]["thresholdValidation"]["checks"].push_back (
    { { "metric", "custom.checkout.p95" }, { "limit", 5 }, { "actual", 7 },
    { "passed", false }, { "evaluated", true } });
    return document;
}

/// One place the document holds free text, and how to put @p text there.
struct HostileField {
    std::string_view name;
    void (*set) (ordered_json& document, const std::string& text);
};

/// The title is read back out of the reference line, which quotes it.
std::string quoted (const std::string& text) {
    std::string out;
    for (const char c : text) {
        if (c == '"' || c == '\\') {
            out += '\\';
        }
        out += c;
    }
    return out;
}

constexpr auto HOSTILE_FIELDS = std::to_array<HostileField> ({
{ "name in the reference and title",
[] (ordered_json& d, const std::string& t) {
    d["run"]["reference"] = "Vayu run \"" + quoted (t) + "\" (run_x) - load test";
} },
{ "comment",
[] (ordered_json& d, const std::string& t) { d["run"]["comment"] = t; } },
{ "method",
[] (ordered_json& d, const std::string& t) { d["config"]["method"] = t; } },
{ "url", [] (ordered_json& d, const std::string& t) { d["config"]["url"] = t; } },
{ "mode",
[] (ordered_json& d, const std::string& t) {
    d["config"]["configuration"]["mode"] = t;
} },
{ "ramp time",
[] (ordered_json& d, const std::string& t) {
    d["config"]["configuration"]["rampUpDuration"] = t;
} },
{ "duration",
[] (ordered_json& d, const std::string& t) {
    d["config"]["configuration"]["duration"] = t;
} },
{ "engine version",
[] (ordered_json& d, const std::string& t) { d["engineVersion"] = t; } },
{ "verdict state",
[] (ordered_json& d, const std::string& t) { d["verdict"]["state"] = t; } },
{ "verdict reason",
[] (ordered_json& d, const std::string& t) { d["verdict"]["reason"] = t; } },
{ "error type",
[] (ordered_json& d, const std::string& t) {
    d["report"]["errors"]["types"][t] = 7;
} },
{ "error status",
[] (ordered_json& d, const std::string& t) {
    d["report"]["errors"]["byStatusCode"][t] = 7;
} },
{ "warning message",
[] (ordered_json& d, const std::string& t) {
    d["report"]["warnings"][0]["message"] = t;
} },
{ "warning code",
[] (ordered_json& d, const std::string& t) {
    d["report"]["warnings"][0]["code"] = t;
} },
{ "warning name",
[] (ordered_json& d, const std::string& t) {
    d["report"]["warnings"][0]["names"][0] = t;
} },
{ "custom budget",
[] (ordered_json& d, const std::string& t) {
    d["report"]["thresholdValidation"]["checks"][4]["metric"] = t;
} },
{ "base reference",
[] (ordered_json& d, const std::string& t) {
    d["comparison"]["baseReference"] = t;
} },
{ "compared metric",
[] (ordered_json& d, const std::string& t) {
    d["comparison"]["deltas"][0]["metric"] = t;
} },
{ "data file name",
[] (ordered_json& d, const std::string& t) {
    d["comparison"]["differences"][2]["base"] = t;
} },
{ "difference field",
[] (ordered_json& d, const std::string& t) {
    d["comparison"]["differences"][2]["field"] = t;
} },
});

TEST (RunExportHtmlTest, EveryKindOfFreeTextIsEscapedWhereverItIsWritten) {
    for (const HostileField& field : HOSTILE_FIELDS) {
        for (const std::string_view hostile : HOSTILE_TEXTS) {
            ordered_json document = full_document ();
            field.set (document, std::string (hostile));
            const std::string html   = render_run_export_html (document);
            const std::string markup = markup_only (html);
            const std::string where =
            std::string (field.name) + ": " + std::string (hostile);
            EXPECT_EQ (markup.find ("<script"), std::string::npos) << where;
            EXPECT_EQ (markup.find ("<img"), std::string::npos) << where;
            EXPECT_EQ (markup.find ("onerror="), std::string::npos) << where;
            // Written, and written as text.
            EXPECT_NE (html.find (escape_html (hostile)), std::string::npos) << where;
        }
    }
}

// --- size and spikes ------------------------------------------------------------------------------------

/// How many points a `points="..."` attribute holds.
std::size_t point_count (const std::string& html, std::size_t from) {
    const std::size_t open =
    html.find ("points=\"", from) + std::string_view ("points=\"").size ();
    const std::string points = html.substr (open, html.find ('"', open) - open);
    return static_cast<std::size_t> (std::ranges::count (points, ' ')) + 1;
}

TEST (RunExportHtmlTest,
TwentyThousandTicksStayUnderThreeHundredKilobytesAndFourEightyPointsALine) {
    const std::string html = render_run_export_html (long_run ());
    EXPECT_LT (html.size (), SIZE_LIMIT_BYTES) << html.size () << " bytes";
    std::size_t lines = 0;
    for (auto at = html.find ("<polyline"); at != std::string::npos;
    at           = html.find ("<polyline", at + 1)) {
        EXPECT_LE (point_count (html, at), 480U);
        ++lines;
    }
    // Throughput, users, three percentiles and the one class that saw responses.
    EXPECT_EQ (lines, 6U);
}

TEST (RunExportHtmlTest, TheFiveSecondSpikeIsTheTopOfTheP99LineAfterThinning) {
    const std::string html = render_run_export_html (long_run ());
    std::string_view latency;
    for (const std::string_view panel : panels_in (html)) {
        if (panel.find ("class=\"line s-p99\"") != std::string_view::npos) {
            latency = panel;
        }
    }
    ASSERT_FALSE (latency.empty ());
    const std::vector<double> values = drawn_values (latency, "p99");
    ASSERT_FALSE (values.empty ());
    EXPECT_NEAR (*std::ranges::max_element (values), 5000.0, 20.0);

    // And it is where it happened: the fifth of twenty thousand seconds is the
    // plot's left edge.
    const auto pixels = vayu::tests::polyline_pixels (latency, "p99");
    ASSERT_HAS_VALUE (pixels);
    const auto top =
    std::ranges::min_element (*pixels, {}, &std::pair<double, double>::second);
    EXPECT_LT (top->first, 60.0);
    EXPECT_NE (html.find ("p99: min 240 ms, max 5,000 ms, peak at 5 s"), std::string::npos);
}

// --- axes and classes -----------------------------------------------------------------------------------------

TEST (RunExportHtmlTest, EveryCountAndLatencyAxisStartsAtZero) {
    const std::string html =
    render_run_export_html (read_document ("healthy-passed"));
    const auto panels = panels_in (html);
    // Throughput, virtual users, latency and the responses of the one class.
    ASSERT_EQ (panels.size (), 4U);
    for (const std::string_view panel : panels) {
        const std::vector<std::string> labels = y_labels_bottom_up (panel);
        ASSERT_FALSE (labels.empty ());
        EXPECT_EQ (labels.front (), "0");
    }
    for (const char* axis : { ">Throughput (req/s)</text>",
         ">Virtual users (count)</text>", ">Latency (ms)</text>",
         ">Responses per tick</text>", ">Seconds from start</text>" }) {
        EXPECT_NE (html.find (axis), std::string::npos) << axis;
    }
}

/// The charts section: the stylesheet names every class, the charts only the ones drawn.
std::string charts_of (const std::string& html) {
    const std::size_t at = html.find ("<section id=\"charts\"");
    return at == std::string::npos ? std::string () : html.substr (at);
}

/// The panel drawing the status classes.
std::string_view status_panel (const std::string& html) {
    const auto panels = panels_in (html);
    return panels.empty () ? std::string_view () : panels.back ();
}

TEST (RunExportHtmlTest, TheStatusChartDrawsWhatEachTickAddedNotTheRunningTotal) {
    const std::string html =
    render_run_export_html (with_ticks ("healthy-passed",
    { tick (1, 10, 5, { { "200", 10 } }), tick (2, 2, 5, { { "200", 12 } }) }));
    const std::vector<double> values = drawn_values (status_panel (html), "2xx");
    ASSERT_EQ (values.size (), 2U);
    EXPECT_NEAR (values[0], 10.0, 0.3);
    EXPECT_NEAR (values[1], 2.0, 0.3);
}

TEST (RunExportHtmlTest, EachClassIsDifferencedOnItsOwn) {
    const std::string html =
    render_run_export_html (with_ticks ("healthy-passed",
    { tick (1, 11, 5, { { "200", 10 }, { "404", 1 } }),
    tick (2, 17, 5, { { "200", 12 }, { "404", 1 }, { "301", 3 }, { "500", 3 }, { "0", 2 } }) }));
    const std::string_view panel = status_panel (html);
    const auto near = [&] (std::string_view style, std::vector<double> expected) {
        const std::vector<double> values = drawn_values (panel, style);
        ASSERT_EQ (values.size (), expected.size ()) << style;
        for (std::size_t at = 0; at < values.size (); ++at) {
            EXPECT_NEAR (values[at], expected[at], 0.3) << style;
        }
    };
    near ("2xx", { 10, 5 });
    near ("4xx", { 1, 0 });
    near ("5xx", { 0, 3 });
    near ("none", { 0, 2 });
}

TEST (RunExportHtmlTest, ACountThatMovesBackwardsAddsNothing) {
    const std::string html =
    render_run_export_html (with_ticks ("healthy-passed",
    { tick (1, 10, 5, { { "200", 10 } }), tick (2, 0, 5, { { "200", 8 } }),
    tick (3, 2, 5, { { "200", 12 } }) }));
    const std::vector<double> values = drawn_values (status_panel (html), "2xx");
    ASSERT_EQ (values.size (), 3U);
    EXPECT_NEAR (values[0], 10.0, 0.3);
    EXPECT_NEAR (values[1], 0.0, 0.3);
    // Differenced against the highest count met, so the dip is not counted twice.
    EXPECT_NEAR (values[2], 2.0, 0.3);
}

TEST (RunExportHtmlTest, AClassThatSawNothingIsNeitherDrawnNorLabelled) {
    const std::string html =
    render_run_export_html (with_ticks ("healthy-passed",
    { tick (1, 10, 5, { { "200", 10 } }), tick (2, 2, 5, { { "200", 12 } }) }));
    const std::string charts = charts_of (html);
    ASSERT_FALSE (charts.empty ());
    for (const char* absent : { ">4xx</text>", ">5xx</text>",
         ">No response</text>", "s-4xx", "s-5xx", "s-none" }) {
        EXPECT_EQ (charts.find (absent), std::string::npos) << absent;
    }
    EXPECT_NE (charts.find (">2xx/3xx</text>"), std::string::npos);
}

TEST (RunExportHtmlTest, AClassIsDrawnForEveryCodeInItsRange) {
    const std::string html =
    render_run_export_html (with_ticks ("healthy-passed",
    { tick (1, 4, 5, { { "200", 1 }, { "399", 1 }, { "400", 1 }, { "499", 1 } }),
    tick (2, 3, 5,
    { { "200", 1 }, { "399", 1 }, { "400", 1 }, { "499", 1 }, { "500", 1 },
    { "599", 1 }, { "0", 1 } }) }));
    const std::string_view panel = status_panel (html);
    EXPECT_NEAR (drawn_values (panel, "2xx")[0], 2.0, 0.3);
    EXPECT_NEAR (drawn_values (panel, "4xx")[0], 2.0, 0.3);
    EXPECT_NEAR (drawn_values (panel, "5xx")[1], 2.0, 0.3);
    EXPECT_NEAR (drawn_values (panel, "none")[1], 1.0, 0.3);
}

TEST (RunExportHtmlTest, TheP95BudgetIsALabelledLineOnlyWhenTheRunDeclaredOne) {
    const std::string declared =
    render_run_export_html (read_document ("healthy-passed"));
    EXPECT_NE (declared.find ("<path class=\"ref\""), std::string::npos);
    EXPECT_NE (declared.find (">p95 budget 300 ms</text>"), std::string::npos);

    const std::string none = render_run_export_html (with_ticks ("no-budgets",
    { tick (1, 10, 5, { { "200", 10 } }), tick (2, 2, 5, { { "200", 12 } }) }));
    EXPECT_EQ (charts_of (none).find ("budget"), std::string::npos);
    EXPECT_EQ (charts_of (none).find ("class=\"ref\""), std::string::npos);
}

TEST (RunExportHtmlTest, ARunWithNoSeriesHasNoChartsAndSaysSo) {
    ordered_json document = read_document ("healthy-passed");
    document.erase ("timeSeries");
    const std::string html = render_run_export_html (document);
    EXPECT_EQ (html.find ("<svg"), std::string::npos);
    EXPECT_NE (html.find ("This run recorded no time series, so there is "
                          "nothing to chart."),
    std::string::npos);
}

TEST (RunExportHtmlTest, EachChartIsNamedAndDescribedForAScreenReader) {
    const std::string html =
    render_run_export_html (read_document ("healthy-passed"));
    for (const char* name : { "Throughput and virtual users over time",
         "Latency percentiles over time", "Responses per interval by class" }) {
        EXPECT_NE (html.find (std::string ("role=\"img\" aria-label=\"") + name + "\""),
        std::string::npos)
        << name;
    }
    // min, max and the time of the peak, said in words.
    EXPECT_NE (html.find ("p99: min 228 ms, max 331 ms, peak at 37 s"), std::string::npos);
}

// --- the page ---------------------------------------------------------------------------------------------------

TEST (RunExportHtmlTest, SectionsComeInTheMarkdownReportsOrderThenChartsThenFooter) {
    const std::string html = render_run_export_html (full_document ());
    std::size_t from       = 0;
    for (const std::string_view marker : { "<h1>", "<section id=\"verdict\"",
         "<section id=\"run\"", "<section id=\"results\"", "<section id=\"latency\"",
         "<section id=\"errors\"", "<section id=\"comparison\"",
         "<section id=\"warnings\"", "<section id=\"charts\"", "<footer>" }) {
        const auto at = html.find (marker, from);
        ASSERT_NE (at, std::string::npos) << marker << " after offset " << from;
        from = at;
    }
}

TEST (RunExportHtmlTest, IsSemanticHtml) {
    const std::string html = render_run_export_html (full_document ());
    EXPECT_NE (html.find ("<!DOCTYPE html>\n<html lang=\"en\">"), std::string::npos);
    EXPECT_NE (html.find ("<meta charset=\"utf-8\">"), std::string::npos);
    EXPECT_EQ (html.find ("<h1>", html.find ("<h1>") + 1), std::string::npos) << "one h1";
    EXPECT_NE (html.find ("<th scope=\"col\">Metric</th>"), std::string::npos);
    EXPECT_NE (html.find ("<th scope=\"row\">Requests</th>"), std::string::npos);
    EXPECT_NE (html.find ("<dl class=\"facts\">"), std::string::npos);
    EXPECT_NE (html.find ("<dt>Virtual users</dt><dd>10 to 100, ramp 10s</dd>"),
    std::string::npos);
    EXPECT_NE (html.find ("<nav aria-label=\"Sections\">"), std::string::npos);
}

TEST (RunExportHtmlTest, PassAndFailAreAlwaysAWordBesideTheColour) {
    const auto word_after = [] (const std::string& html, std::string_view open) {
        const auto at = html.find (open);
        return at == std::string::npos ? std::string () : html.substr (at, 120);
    };
    const std::string passed =
    render_run_export_html (read_document ("healthy-passed"));
    EXPECT_NE (word_after (passed, "<div class=\"band band-good\">").find ("<strong>Passed</strong>"),
    std::string::npos);
    const std::string failed =
    render_run_export_html (read_document ("errors-and-budget-failed"));
    EXPECT_NE (word_after (failed, "<div class=\"band band-bad\">").find ("<strong>Failed</strong>"),
    std::string::npos);
    const std::string stopped =
    render_run_export_html (read_document ("stopped-early"));
    EXPECT_NE (word_after (stopped, "<div class=\"band\">").find ("<strong>Not judged</strong>"),
    std::string::npos);

    // Every coloured cell says what the colour means.
    for (const std::string_view name : ALL_CASES) {
        const std::string html = render_run_export_html (read_document (name));
        for (const auto& [tone, words] : std::map<std::string, std::vector<std::string>>{
             { "tone-good", { "met", "improved" } },
             { "tone-bad", { "missed", "regressed" } } }) {
            const std::string open = "<td class=\"" + tone + "\">";
            for (auto at = html.find (open); at != std::string::npos;
            at           = html.find (open, at + 1)) {
                const auto text = html.substr (
                at + open.size (), html.find ("</td>", at) - at - open.size ());
                const bool says = std::ranges::any_of (words,
                [&] (const std::string& word) { return text.ends_with (word); });
                EXPECT_TRUE (says) << name << ": " << text;
            }
        }
    }
}

// --- light, dark and print ------------------------------------------------------------------------------------------

using Palette = std::map<std::string, std::string>;

/// The custom properties of the first `:root { ... }` block at or after @p from.
Palette palette_after (const std::string& css, std::size_t from) {
    Palette palette;
    const std::size_t open  = css.find (":root {", from);
    const std::size_t close = css.find ('}', open);
    if (open == std::string::npos || close == std::string::npos) {
        return palette;
    }
    std::size_t at = css.find ("--", open);
    while (at != std::string::npos && at < close) {
        const std::size_t colon = css.find (':', at);
        const std::size_t semi  = css.find (';', colon);
        std::string value       = css.substr (colon + 1, semi - colon - 1);
        value.erase (0, value.find_first_not_of (' '));
        palette[css.substr (at + 2, colon - at - 2)] = value;
        at                                           = css.find ("--", semi);
    }
    return palette;
}

double channel (const std::string& hex, std::size_t at) {
    const double value = std::stoi (hex.substr (at, 2), nullptr, 16) / 255.0;
    return value <= 0.03928 ? value / 12.92 : std::pow ((value + 0.055) / 1.055, 2.4);
}

/// WCAG relative luminance of `#rrggbb`.
double luminance (const std::string& colour) {
    const std::string hex = colour.substr (1);
    return (0.2126 * channel (hex, 0)) + (0.7152 * channel (hex, 2)) +
    (0.0722 * channel (hex, 4));
}

double contrast (const std::string& a, const std::string& b) {
    const double high = std::max (luminance (a), luminance (b));
    const double low  = std::min (luminance (a), luminance (b));
    return (high + 0.05) / (low + 0.05);
}

TEST (RunExportHtmlTest, ReadsInLightDarkAndPrint) {
    const std::string css =
    stylesheet_of (render_run_export_html (read_document ("healthy-passed")));
    ASSERT_FALSE (css.empty ());
    for (const char* rule : { "color-scheme: light dark;",
         "@media (prefers-color-scheme: dark)", "@media print", "@page { margin: 14mm; }",
         "print-color-adjust: exact", "break-inside: avoid" }) {
        EXPECT_NE (css.find (rule), std::string::npos) << rule;
    }
    EXPECT_EQ (css.find ("@media (prefers-color-scheme: light)"), std::string::npos)
    << "no toggle";
}

TEST (RunExportHtmlTest, PrintForcesTheLightPalette) {
    const std::string css =
    stylesheet_of (render_run_export_html (read_document ("healthy-passed")));
    const Palette light = palette_after (css, css.find (":root {"));
    const Palette print = palette_after (css, css.find ("@media print"));
    ASSERT_GT (light.size (), 15U);
    EXPECT_EQ (print, light);
    // A print block that came before the dark one would lose to it.
    EXPECT_GT (css.find ("@media print"), css.find ("@media (prefers-color-scheme: dark)"));
}

TEST (RunExportHtmlTest, BothPalettesHoldTextAt4Point5AndGraphicsAt3) {
    const std::string css =
    stylesheet_of (render_run_export_html (read_document ("healthy-passed")));
    const Palette light = palette_after (css, css.find (":root {"));
    const Palette dark =
    palette_after (css, css.find ("@media (prefers-color-scheme: dark)"));
    ASSERT_EQ (light.size (), dark.size ());

    const std::vector<std::pair<std::string, std::string>> text_pairs = {
        { "text", "bg" }, { "text", "surface" }, { "muted", "bg" },
        { "muted", "surface" }, { "accent", "bg" }, { "good-text", "good-bg" },
        { "good-text", "bg" }, { "bad-text", "bad-bg" }, { "bad-text", "bg" }
    };
    const std::vector<std::string> graphics = { "axis", "good-mark", "bad-mark",
        "rps", "vus", "p50", "p95", "p99", "c2xx", "c4xx", "c5xx", "cnone", "ref" };
    for (const auto& [scheme, palette] :
    { std::pair{ "light", light }, std::pair{ "dark", dark } }) {
        for (const auto& [foreground, background] : text_pairs) {
            EXPECT_GE (contrast (palette.at (foreground), palette.at (background)), 4.5)
            << scheme << ": " << foreground << " on " << background;
        }
        for (const std::string& token : graphics) {
            EXPECT_GE (contrast (palette.at (token), palette.at ("bg")), 3.0)
            << scheme << ": " << token;
            EXPECT_GE (contrast (palette.at (token), palette.at ("surface")), 3.0)
            << scheme << ": " << token;
        }
    }
}

TEST (RunExportHtmlTest, ThePercentileLinesDifferInLightnessNotJustHue) {
    const std::string css =
    stylesheet_of (render_run_export_html (read_document ("healthy-passed")));
    for (const std::size_t from :
    { css.find (":root {"), css.find ("@media (prefers-color-scheme: dark)") }) {
        const Palette palette = palette_after (css, from);
        const double p50      = luminance (palette.at ("p50"));
        const double p95      = luminance (palette.at ("p95"));
        const double p99      = luminance (palette.at ("p99"));
        EXPECT_GE (std::abs (p50 - p95), 0.05);
        EXPECT_GE (std::abs (p95 - p99), 0.05);
        EXPECT_GE (std::abs (p50 - p99), 0.1);
    }
}

TEST (RunExportHtmlTest, TheLatencyLinesAreNotTheColoursOfFailure) {
    const std::string css =
    stylesheet_of (render_run_export_html (read_document ("healthy-passed")));
    for (const std::size_t from :
    { css.find (":root {"), css.find ("@media (prefers-color-scheme: dark)") }) {
        const Palette palette = palette_after (css, from);
        for (const char* token : { "p50", "p95", "p99" }) {
            const std::string hex = palette.at (token).substr (1);
            // Blue-dominant: red is never the largest channel of a percentile.
            EXPECT_GT (channel (hex, 4), channel (hex, 0)) << token;
        }
    }
}

// --- goldens --------------------------------------------------------------------------------------------------------------

class RunExportHtmlGoldenTest : public ::testing::TestWithParam<std::string_view> {};

TEST_P (RunExportHtmlGoldenTest, MatchesItsGoldenByteForByte) {
    const std::string_view name = GetParam ();
    const std::string rendered  = render_run_export_html (read_document (name));
    const auto golden           = case_path (name, ".golden.html");

    if (env_is_set ("VAYU_UPDATE_GOLDEN")) {
        std::ofstream out (golden, std::ios::binary);
        ASSERT_TRUE (out.good ()) << "cannot write golden: " << golden;
        out << rendered;
        out.close ();
        GTEST_SKIP () << "regenerated " << golden;
    }

    const std::string expected = read_bytes (golden);
    // An emptied golden would make the comparison below prove nothing.
    ASSERT_FALSE (expected.empty ()) << golden;
    EXPECT_EQ (rendered, expected)
    << "the output drifted from " << golden << ". If the change is deliberate, regenerate with "
    << "VAYU_UPDATE_GOLDEN=1 ctest --preset linux-dev -R RunExportHtml and "
       "review the diff";
}

INSTANTIATE_TEST_SUITE_P (Cases,
RunExportHtmlGoldenTest,
::testing::ValuesIn (GOLDEN_CASES),
[] (const ::testing::TestParamInfo<std::string_view>& info) {
    std::string name (info.param);
    std::ranges::replace (name, '-', '_');
    return name;
});

} // namespace
