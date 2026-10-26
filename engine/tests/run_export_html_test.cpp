/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_export_html_test.cpp
 * @brief The run-report document as one self-contained HTML page (#2135):
 *        that it loads and runs nothing (its one image is a `data:` URI, the
 *        Vayu mark, pinned to the icon file), escapes every string it writes,
 *        stays small for a run of any length without losing a spike, draws
 *        its axes from zero and its status chart from the per-second counts a
 *        row carries (#2888) or, for a run stored before them, from per-tick
 *        differences, reads in light, dark and print, and matches its goldens.
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
 * red; point the logo at `https://x/logo.png` or give it a non-PNG `data:` URI
 * and the same cases red; corrupt one byte of the embedded base64 and the
 * drift case reds; drop `img-src data:` from the policy and the policy case
 * reds; write the run's comment without `escape_html` and the hostile-text case
 * reds; thin a series by taking every Nth sample and the spike case reds; feed
 * the status chart the cumulative counts and the per-interval case reds; make
 * `counts_by_second` return false and the status-seconds golden and
 * the counted-seconds cases red; take a dark text token below 4.5:1 and the
 * contrast case reds; drop the capacity, sequence or transactions push from
 * `view_sections` and the section tests and the goldens red; write a step,
 * transaction or stop-reason cell unescaped and the escaping case reds; drop
 * the caption from `table_markup` and the caption case and the scenario goldens
 * red.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "chart_decode.hpp"
#include "optional_assert.hpp"
#include "run_export_fixtures.hpp"
#include "run_export_schema_support.hpp"
#include "vayu/core/run_export_html.hpp"
#include "vayu/utils/encoding.hpp"
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
constexpr auto ALL_CASES = std::to_array<std::string_view> ({ "healthy-passed",
"errors-and-budget-failed", "stopped-early", "vs-baseline-regressed",
"no-budgets", "collection-load", "hostile-text", "status-seconds",
"skipped-requests", "capacity-slo-exceeded", "scenario-sequence" });

/// The cases whose rendered page is pinned byte for byte.
constexpr auto GOLDEN_CASES =
std::to_array<std::string_view> ({ "healthy-passed", "errors-and-budget-failed",
"status-seconds", "skipped-requests", "capacity-slo-exceeded", "scenario-sequence" });

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

// --- the one image ---------------------------------------------------------------------------------

constexpr std::string_view LOGO_OPEN = "<img src=\"data:image/png;base64,";
constexpr std::string_view LOGO_CLOSE =
"\" alt=\"\" width=\"28\" height=\"28\">";

/// The policy the page ships: nothing is loaded, and an image may only be inline.
constexpr std::string_view POLICY_META =
"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; "
"style-src 'unsafe-inline'; img-src data:\">";

bool is_base64_text (std::string_view text) {
    return !text.empty () && std::ranges::all_of (text, [] (char c) {
        return std::isalnum (static_cast<unsigned char> (c)) != 0 || c == '+' ||
        c == '/' || c == '=';
    });
}

/// A page's one permitted image, taken out: its base64 and the markup without it.
struct SplitLogo {
    std::string payload;
    std::string rest;
};

/// The `<img>` has to be the single image in @p markup and a PNG `data:` URI of
/// plain base64; anything else (another image, an external `src`, another media
/// type) is a failure and yields nothing.
std::optional<SplitLogo> split_logo (const std::string& markup, std::string_view what) {
    const auto open = markup.find (LOGO_OPEN);
    if (open == std::string::npos || markup.find ("<img") != open ||
    markup.find ("<img", open + 1) != std::string::npos) {
        ADD_FAILURE () << what << ": not exactly one PNG data: <img>";
        return std::nullopt;
    }
    const auto payload_from = open + LOGO_OPEN.size ();
    const auto close        = markup.find ('"', payload_from);
    if (close == std::string::npos ||
    markup.compare (close, LOGO_CLOSE.size (), LOGO_CLOSE) != 0 ||
    !is_base64_text (std::string_view (markup).substr (payload_from, close - payload_from))) {
        ADD_FAILURE () << what << ": the <img> is not a bare base64 src with alt, width, height";
        return std::nullopt;
    }
    return SplitLogo{ markup.substr (payload_from, close - payload_from),
        markup.substr (0, open) + markup.substr (close + LOGO_CLOSE.size ()) };
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
    // The logo is the one image; once it is out, every other source is a failure.
    const auto logo = split_logo (markup_only (html), what);
    ASSERT_HAS_VALUE (logo);
    const std::string& markup = logo->rest;
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
    EXPECT_NE (markup.find (POLICY_META), std::string::npos) << what;
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

TEST (RunExportHtmlTest, TheVerdictNamesFailedAssertions) {
    ordered_json document         = read_document ("healthy-passed");
    document["verdict"]["state"]  = "not_judged";
    document["verdict"]["reason"] = "budgets_met_with_assertion_failures";
    document["report"]["scenario"]["assertions"] = { { "passed", 0 }, { "failed", 4580 } };
    EXPECT_NE (render_run_export_html (document).find (
               "<strong>Not judged</strong> - 3 of 3 budgets met, but 4,580 "
               "assertions failed</p>"),
    std::string::npos);
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
/// its URL and configuration strings, error keys, warnings, a custom budget, a
/// comparison with a differing data file, a capacity search's result and a
/// scenario's steps and transactions.
ordered_json full_document () {
    ordered_json document       = read_document ("errors-and-budget-failed");
    const ordered_json baseline = read_document ("vs-baseline-regressed");
    document["comparison"]      = baseline["comparison"];
    document["report"]["capacity"] =
    read_document ("capacity-slo-exceeded")["report"]["capacity"];
    document["report"]["scenario"] =
    read_document ("scenario-sequence")["report"]["scenario"];
    document["run"]["comment"]                              = "a comment";
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
{ "capacity stop reason",
[] (ordered_json& d, const std::string& t) {
    d["report"]["capacity"]["stopReason"] = t;
} },
{ "step name",
[] (ordered_json& d, const std::string& t) {
    d["report"]["scenario"]["steps"][0]["name"] = t;
} },
{ "transaction name",
[] (ordered_json& d, const std::string& t) {
    d["report"]["scenario"]["transactions"][0]["name"] = t;
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
            // The logo stays the only image; hostile text adds none.
            ASSERT_HAS_VALUE (split_logo (markup, where));
            EXPECT_EQ (markup.find ("onerror="), std::string::npos) << where;
            // Written, and written as text.
            EXPECT_NE (html.find (escape_html (hostile)), std::string::npos) << where;
        }
    }
}

// --- the capacity and scenario sections (#2819) ----------------------------------------------

/// The markup of the section with id @p id, or empty when the page has none.
std::string section_html (const std::string& html, std::string_view id) {
    const auto open = html.find ("<section id=\"" + std::string (id) + "\"");
    if (open == std::string::npos) {
        return {};
    }
    return html.substr (open, html.find ("</section>", open) - open);
}

constexpr auto SEARCH_AND_SEQUENCE_SECTIONS =
std::to_array<std::string_view> ({ "capacity", "sequence", "transactions" });

// Mutation check: drop the capacity push from `view_sections` and this fails,
// as does the golden.
TEST (RunExportHtmlTest, ACapacitySearchIsASectionOfItsSentencesAndItsLevels) {
    const std::string html =
    render_run_export_html (read_document ("capacity-slo-exceeded"));
    const std::string capacity = section_html (html, "capacity");
    ASSERT_FALSE (capacity.empty ());
    EXPECT_NE (html.find ("<li><a href=\"#capacity\">Capacity</a></li>"), std::string::npos);
    EXPECT_NE (
    capacity.find ("<p><strong>Latency budget exceeded</strong> - Sustained 41 "
                   "virtual users at 403 req/s, with a p99 of 178 ms against a "
                   "200 ms budget.</p>\n"),
    std::string::npos)
    << capacity;
    for (const char* line :
    { "<p>The limit lies between 41 and 51 virtual users: it held 41 "
      "and gave out at 51, where p99 reached 226 ms.</p>",
    "<p>p99 stayed above the budget across two consecutive measurements of the "
    "level "
    "(each 5s long).</p>",
    "<p>Budget: p99 &lt;= 200 ms; error limit: 1.0%; step length: 5s</p>" }) {
        EXPECT_NE (capacity.find (line), std::string::npos) << line;
    }
    EXPECT_NE (capacity.find ("<table aria-labelledby=\"capacity-h\">"), std::string::npos);
    // The word beside the colour, and a re-measured level once per measurement.
    EXPECT_NE (capacity.find ("<td class=\"tone-bad\">226 (over budget)</td>"),
    std::string::npos);
    EXPECT_NE (capacity.find ("<th scope=\"row\">51 (re-measured)</th>"), std::string::npos);
    EXPECT_EQ (html.find ("<section id=\"sequence\""), std::string::npos);
}

TEST (RunExportHtmlTest, AScenarioRunHasItsSequenceAndTransactionsAsTables) {
    const std::string html =
    render_run_export_html (read_document ("scenario-sequence"));
    const std::string sequence = section_html (html, "sequence");
    ASSERT_FALSE (sequence.empty ());
    EXPECT_NE (sequence.find (
               "<p>2,110 iterations started, 2,090 completed, 15 abandoned, "
               "5 cut short</p>"),
    std::string::npos)
    << sequence;
    EXPECT_NE (sequence.find ("<table aria-labelledby=\"sequence-h\">"), std::string::npos);
    EXPECT_NE (sequence.find ("<th scope=\"row\">Log in</th>"), std::string::npos);
    EXPECT_NE (
    sequence.find ("<td class=\"tone-bad\">2,080 passed, 18 failed</td>"), std::string::npos);

    const std::string transactions = section_html (html, "transactions");
    ASSERT_FALSE (transactions.empty ());
    EXPECT_NE (transactions.find ("<table aria-labelledby=\"transactions-h\">"),
    std::string::npos);
    EXPECT_NE (
    transactions.find ("<th scope=\"row\">Checkout</th><td>2,090</td>"), std::string::npos);
    EXPECT_EQ (html.find ("<section id=\"capacity\""), std::string::npos);
    for (const char* link : { "<li><a href=\"#sequence\">Sequence</a></li>",
         "<li><a href=\"#transactions\">Transactions</a></li>" }) {
        EXPECT_NE (html.find (link), std::string::npos) << link;
    }
}

// Mutation check: write the step cell as `words` rather than `user` in
// `steps_table` (or the transaction cell likewise) and the name lands raw.
TEST (RunExportHtmlTest, AStepNameIsTextInItsRowHeader) {
    ordered_json document = read_document ("scenario-sequence");
    document["report"]["scenario"]["steps"][0]["name"] = "a|b <script>";
    const std::string html = render_run_export_html (document);
    EXPECT_NE (html.find ("<th scope=\"row\">a|b &lt;script&gt;</th>"), std::string::npos);
    EXPECT_EQ (markup_only (html).find ("<script"), std::string::npos);
}

TEST (RunExportHtmlTest, APlainLoadRunDrawsNeitherSearchNorSequenceNorCaption) {
    for (const std::string_view name :
    { "healthy-passed", "errors-and-budget-failed", "stopped-early", "no-budgets" }) {
        const std::string html = render_run_export_html (read_document (name));
        for (const std::string_view id : SEARCH_AND_SEQUENCE_SECTIONS) {
            EXPECT_EQ (html.find ("<section id=\"" + std::string (id) + "\""),
            std::string::npos)
            << name << ": " << id;
            EXPECT_EQ (html.find ("href=\"#" + std::string (id) + "\""), std::string::npos)
            << name << ": " << id;
        }
        EXPECT_EQ (html.find ("<caption"), std::string::npos) << name;
    }
}

// Mutation check: drop the caption from `table_markup` and this fails, as do
// the scenario goldens.
TEST (RunExportHtmlTest, ATableCaptionIsACaptionElementInsideItsTable) {
    for (const std::string_view name : { "scenario-sequence", "collection-load" }) {
        const std::string latency =
        section_html (render_run_export_html (read_document (name)), "latency");
        EXPECT_NE (
        latency.find ("<table aria-labelledby=\"latency-h\">\n<caption>All "
                      "steps pooled.</caption>\n<thead>"),
        std::string::npos)
        << name << ": " << latency;
    }
    const std::string capacity =
    render_run_export_html (read_document ("capacity-slo-exceeded"));
    EXPECT_EQ (capacity.find ("<caption"), std::string::npos);
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

// #2386: a second with no completion is stored without percentiles, so the
// latency lines skip it instead of dropping to 0 ms, while the series that
// do have a value that second still draw it. Mutation check: read a missing
// key as 0 in `tick_points` and the p99 line gains a third point at 0.
TEST (RunExportHtmlTest, ASecondWithNoPercentilesIsSkippedNotDrawnAtZero) {
    ordered_json empty_second = tick (2, 0, 5, { { "200", 10 } });
    for (const char* key : { "latency_p50_ms", "latency_p95_ms", "latency_p99_ms" }) {
        empty_second.erase (key);
    }
    const std::string html =
    render_run_export_html (with_ticks ("healthy-passed",
    { tick (1, 10, 5, { { "200", 10 } }), empty_second, tick (3, 10, 5, { { "200", 20 } }) }));

    std::string_view latency;
    std::string_view throughput;
    for (const std::string_view panel : panels_in (html)) {
        if (panel.find (">Latency (ms)</text>") != std::string_view::npos) {
            latency = panel;
        }
        if (panel.find (">Throughput (req/s)</text>") != std::string_view::npos) {
            throughput = panel;
        }
    }
    ASSERT_FALSE (latency.empty ());
    ASSERT_FALSE (throughput.empty ());
    EXPECT_EQ (drawn_values (throughput, "rps").size (), 3U);
    for (const char* style : { "p50", "p95", "p99" }) {
        const std::vector<double> values = drawn_values (latency, style);
        ASSERT_EQ (values.size (), 2U) << style;
        EXPECT_GT (*std::ranges::min_element (values), 80.0) << style;
    }
    EXPECT_NE (html.find ("p99: min 240 ms"), std::string::npos);
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

// --- the status chart counted by second (#2888) -------------------------------------------

/// `{second, span, counts}` as a row stores it; @p counts is 2xx, 3xx, 4xx, 5xx, no response.
ordered_json status_entry (int second, int span, const std::array<int, 5>& counts) {
    return { { "second", second }, { "span", span }, { "counts", counts } };
}

/// A row whose gate closed @p entries. Its cumulative `status_codes` are
/// @p cumulative_200 responses, which differenced would disagree with the entries.
ordered_json counted_tick (double seconds,
const std::vector<ordered_json>& entries,
int cumulative_200 = 10) {
    ordered_json row = tick (seconds, 10, 5, { { "200", cumulative_200 } });
    row["status_seconds"] = entries;
    return row;
}

/// The values each class is drawn at, in the status panel of a document of @p ticks.
std::string counted_html (const std::vector<ordered_json>& ticks) {
    return render_run_export_html (with_ticks ("healthy-passed", ticks));
}

void expect_values (std::string_view panel,
std::string_view style,
const std::vector<double>& expected) {
    const std::vector<double> values = drawn_values (panel, style);
    ASSERT_EQ (values.size (), expected.size ()) << style;
    for (std::size_t at = 0; at < values.size (); ++at) {
        EXPECT_NEAR (values[at], expected[at], 0.3) << style << " #" << at;
    }
}

// The cumulative counts below gain 10, 30 and 10 between rows, which is what
// the old reading would draw; the entries say 20 a second throughout.
// Mutation check: make `counts_by_second` return false and this reds.
TEST (RunExportHtmlTest, TheStatusChartDrawsTheCountedSecondsNotTheRowsDifference) {
    const std::string html =
    counted_html ({ counted_tick (1, { status_entry (0, 1, { 20, 0, 0, 0, 0 }) }, 10),
    counted_tick (2, { status_entry (1, 1, { 20, 0, 0, 0, 0 }) }, 40),
    counted_tick (3, { status_entry (2, 1, { 20, 0, 0, 0, 0 }) }, 50) });
    expect_values (status_panel (html), "2xx", { 20, 20, 20 });
}

TEST (RunExportHtmlTest, TheCountedStatusChartSaysItIsPerSecondAndTheOldOneStaysPerTick) {
    const std::string counted =
    counted_html ({ counted_tick (1, { status_entry (0, 1, { 20, 0, 0, 0, 0 }) }) });
    for (const char* wording : { ">Responses per second</text>",
         "<figcaption>Responses per second by class</figcaption>",
         "aria-label=\"Responses per second by class\"", " resp/s" }) {
        EXPECT_NE (counted.find (wording), std::string::npos) << wording;
    }
    for (const char* old : { ">Responses per tick</text>",
         "Responses per interval by class", " responses" }) {
        EXPECT_EQ (counted.find (old), std::string::npos) << old;
    }

    const std::string before_the_key =
    counted_html ({ tick (1, 10, 5, { { "200", 10 } }) });
    EXPECT_NE (before_the_key.find (">Responses per tick</text>"), std::string::npos);
    EXPECT_NE (before_the_key.find ("Responses per interval by class"), std::string::npos);
    EXPECT_EQ (before_the_key.find ("Responses per second by class"), std::string::npos);
}

TEST (RunExportHtmlTest, ACountedEntryFoldsItsClassesAndDividesByItsSpan) {
    const std::string html       = counted_html ({ counted_tick (1,
          { status_entry (0, 2, { 20, 10, 4, 2, 6 }), status_entry (2, 1, { 1, 1, 0, 0, 0 }) }) });
    const std::string_view panel = status_panel (html);
    expect_values (panel, "2xx", { 15, 2 });
    expect_values (panel, "4xx", { 2, 0 });
    expect_values (panel, "5xx", { 1, 0 });
    expect_values (panel, "none", { 3, 0 });
}

TEST (RunExportHtmlTest, ACountedPointSitsAtTheEndOfItsSpan) {
    const std::string html = counted_html ({ counted_tick (1,
    { status_entry (0, 1, { 5, 0, 0, 0, 0 }), status_entry (1, 3, { 90, 0, 0, 0, 0 }) }) });
    // Second 1 spanning 3 seconds ends at 4, where its 30 a second peaks.
    EXPECT_NE (html.find ("2xx/3xx: min 5 resp/s, max 30 resp/s, peak at 4 s"),
    std::string::npos);
}

TEST (RunExportHtmlTest, ASecondIsDrawnOnceAndInOrderWhateverRowCarriedIt) {
    const std::string html = counted_html (
    { counted_tick (1,
      { status_entry (1, 1, { 20, 0, 0, 0, 0 }), status_entry (0, 1, { 10, 0, 0, 0, 0 }) }),
    counted_tick (2, { status_entry (1, 1, { 30, 0, 0, 0, 0 }) }) });
    expect_values (status_panel (html), "2xx", { 10, 30 });
}

// Choosing per row would draw the key-less row's cumulative count as well as
// the entries, counting the same responses twice.
TEST (RunExportHtmlTest, OneRowWithEntriesDecidesForEveryRow) {
    const std::string html = counted_html ({ tick (1, 10, 5, { { "200", 500 } }),
    counted_tick (2,
    { status_entry (0, 1, { 7, 0, 0, 0, 0 }), status_entry (1, 1, { 9, 0, 0, 0, 0 }) }, 507) });
    expect_values (status_panel (html), "2xx", { 7, 9 });
}

TEST (RunExportHtmlTest, ARunThatClosedNoSecondDrawsNoStatusChart) {
    const std::string html =
    counted_html ({ counted_tick (1, {}, 10), counted_tick (2, {}, 30) });
    EXPECT_EQ (charts_of (html).find ("chart-status"), std::string::npos);
    EXPECT_EQ (charts_of (html).find ("Responses per"), std::string::npos);
}

TEST (RunExportHtmlTest, AMalformedEntryIsSkippedAndAZeroSpanNeverDivides) {
    const ordered_json bad_span     = { { "second", 0 }, { "span", 0 },
            { "counts", { 9, 0, 0, 0, 0 } } };
    const ordered_json short_counts = { { "second", 1 }, { "span", 1 },
        { "counts", { 9, 0, 0, 0 } } };
    const ordered_json negative     = { { "second", 2 }, { "span", 1 },
            { "counts", { -9, 0, 0, 0, 0 } } };
    const std::string html          = counted_html ({ counted_tick (1,
             { bad_span, short_counts, negative, status_entry (3, 1, { 4, 0, 0, 0, 0 }),
             status_entry (4, 1, { 6, 0, 0, 0, 0 }) }) });
    expect_values (status_panel (html), "2xx", { 4, 6 });
}

TEST (RunExportHtmlTest, ACountedClassThatSawNothingIsNeitherDrawnNorLabelled) {
    const std::string charts = charts_of (
    counted_html ({ counted_tick (1, { status_entry (0, 1, { 20, 5, 0, 0, 0 }) }) }));
    for (const char* absent : { ">4xx</text>", ">5xx</text>",
         ">No response</text>", "s-4xx", "s-5xx", "s-none" }) {
        EXPECT_EQ (charts.find (absent), std::string::npos) << absent;
    }
    EXPECT_NE (charts.find (">2xx/3xx</text>"), std::string::npos);
}

// A row can close two seconds, so a status line may hold more points than the
// run has rows and be thinned while the row count is under the bound.
TEST (RunExportHtmlTest, TheThinnedNoteCountsTheStatusLinesPointsToo) {
    const auto thinned_note = [] (std::size_t rows, std::size_t entries_per_row) {
        std::vector<ordered_json> ticks;
        int second = 0;
        for (std::size_t row = 0; row < rows; ++row) {
            std::vector<ordered_json> entries;
            entries.reserve (entries_per_row);
            for (std::size_t at = 0; at < entries_per_row; ++at) {
                entries.push_back (status_entry (second++, 1, { 10, 0, 0, 0, 0 }));
            }
            ticks.push_back (counted_tick (static_cast<double> (row + 1), entries));
        }
        return counted_html (ticks).find (
               "Each line is drawn from at most 480 points") != std::string::npos;
    };
    EXPECT_FALSE (thinned_note (300, 1));
    EXPECT_TRUE (thinned_note (300, 2));
}

TEST (RunExportHtmlTest, TheStatusSecondsFixtureValidatesAgainstTheSchema) {
    EXPECT_EQ (vayu::tests::run_export_schema_errors (
               vayu::tests::load_run_export_schema (), read_document ("status-seconds")),
    "");
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

TEST (RunExportHtmlTest, AP95BudgetFarAboveEveryLatencyIsStillDrawnAndTheAxisReachesIt) {
    ordered_json document = read_document ("healthy-passed");
    document["report"]["thresholdValidation"]["checks"][0]["limit"] = 5000;
    const std::string html = render_run_export_html (document);
    EXPECT_NE (html.find ("<path class=\"ref\""), std::string::npos);
    EXPECT_NE (html.find (">p95 budget 5,000 ms</text>"), std::string::npos);
    EXPECT_EQ (html.find ("above this scale"), std::string::npos);

    std::string_view latency;
    for (const std::string_view panel : panels_in (html)) {
        if (panel.find (">Latency (ms)</text>") != std::string_view::npos) {
            latency = panel;
        }
    }
    ASSERT_FALSE (latency.empty ());
    EXPECT_EQ (y_labels_bottom_up (latency).back (), "5,000");
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
         "<section id=\"capacity\"", "<section id=\"sequence\"",
         "<section id=\"transactions\"", "<section id=\"errors\"", "<section id=\"comparison\"",
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

/// The brand paragraph's markup, from its open tag to its close.
std::string brand_paragraph (const std::string& html) {
    constexpr std::string_view OPEN = "<p class=\"brand\">";
    const auto at                   = html.find (OPEN);
    if (at == std::string::npos) {
        return {};
    }
    return html.substr (at, html.find ("</p>", at) + 4 - at);
}

TEST (RunExportHtmlTest, TheBrandIsTheLogoThenTheWordmarkAboveTheTitleAndNotALink) {
    for (const std::string_view name : ALL_CASES) {
        const std::string html  = render_run_export_html (read_document (name));
        const std::string brand = brand_paragraph (html);
        ASSERT_FALSE (brand.empty ()) << name;
        const auto at = html.find (brand);
        EXPECT_GT (html.find ("<h1>"), at) << name << ": the brand leads the header";
        EXPECT_LT (html.rfind ("<header>", at), at) << name;
        EXPECT_EQ (html.find (brand, at + 1), std::string::npos) << name << ": once";
        // The image is first in the line, then the wordmark, then the label.
        const auto logo = split_logo (brand, name);
        ASSERT_HAS_VALUE (logo);
        EXPECT_EQ (
        brand.find (LOGO_OPEN), std::string_view ("<p class=\"brand\">").size ())
        << name << ": the logo opens the line";
        EXPECT_EQ (logo->rest, "<p class=\"brand\"><strong>Vayu</strong> run report</p>")
        << name << ": the wordmark follows the logo, text only";
        // The mark is decoration beside a wordmark that names the product, and
        // its box is fixed so the line does not shift when it paints.
        EXPECT_NE (brand.find (LOGO_CLOSE), std::string::npos) << name;
        for (const std::string_view not_here : { "<a", "<svg", "href" }) {
            EXPECT_EQ (brand.find (not_here), std::string::npos) << name << ": " << not_here;
        }
    }
}

std::filesystem::path logo_file () {
    return std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) / ".." / "shared" /
    "icon_png" / "vayu_icon_64x64.png";
}

TEST (RunExportHtmlTest, TheEmbeddedLogoIsTheIconFileByteForByte) {
    const std::string icon = read_bytes (logo_file ());
    ASSERT_FALSE (icon.empty ()) << logo_file ();
    const std::string html =
    render_run_export_html (read_document ("healthy-passed"));
    const auto logo = split_logo (html, "healthy-passed");
    ASSERT_HAS_VALUE (logo);
    const auto decoded = vayu::utils::base64_decode (logo->payload);
    ASSERT_HAS_VALUE (decoded) << "the embedded logo is not base64";
    EXPECT_EQ (*decoded, icon)
    << "regenerate run_export_html_logo.hpp from the icon";
}

TEST (RunExportHtmlTest, TheBrandIsDrawnInTheMutedTokenSoTheContrastTestCoversIt) {
    const std::string css =
    stylesheet_of (render_run_export_html (read_document ("healthy-passed")));
    const auto at = css.find (".brand {");
    ASSERT_NE (at, std::string::npos);
    const std::string rule = css.substr (at, css.find ('}', at) - at);
    EXPECT_NE (rule.find ("color: var(--muted)"), std::string::npos) << rule;
    EXPECT_EQ (rule.find ('#'), std::string::npos)
    << "a literal colour escapes both palettes";
}

TEST (RunExportHtmlTest, TheFooterNamesTheEngineVersionAndWhatIsLeftOut) {
    ordered_json document     = read_document ("healthy-passed");
    document["engineVersion"] = "9.8.7";
    const std::string html    = render_run_export_html (document);
    EXPECT_NE (
    html.find ("<footer>\n<p>Generated by Vayu 9.8.7. No request or response "
               "data is included.</p>\n</footer>"),
    std::string::npos);
}

/// The row headers of the page's Errors table, in order.
std::vector<std::string> error_row_labels (const std::string& html) {
    std::vector<std::string> labels;
    const auto from = html.find ("<section id=\"errors\"");
    if (from == std::string::npos) {
        return labels;
    }
    const auto to                   = html.find ("</section>", from);
    constexpr std::string_view OPEN = "<th scope=\"row\">";
    for (auto at = html.find (OPEN, from); at < to; at = html.find (OPEN, at)) {
        at += OPEN.size ();
        labels.push_back (html.substr (at, html.find ("</th>", at) - at));
    }
    return labels;
}

// #2400: the page lists no-response requests once - under their types, or as
// one "No response" row when no type lists them - and never as "HTTP 0".
// Mutation check: restore the `"HTTP " + user (code)` label and the erase of
// code 0 and the golden and this red on an `HTTP 0` row.
TEST (RunExportHtmlTest, NoResponseRequestsAreListedOnceAndNeverAsHttp0) {
    ordered_json document = read_document ("errors-and-budget-failed");
    ASSERT_EQ (document["report"]["errors"]["byStatusCode"]["0"], 300)
    << "the fixture has to carry the no-response count for this to test "
       "anything";
    const std::string typed = render_run_export_html (document);
    const std::vector<std::string> by_type{ "HTTP 500", "HTTP 503", "timeout", "connection_reset" };
    EXPECT_EQ (error_row_labels (typed), by_type);
    EXPECT_EQ (typed.find ("HTTP 0"), std::string::npos);

    document["report"]["errors"]["types"] = ordered_json::object ();
    const std::string untyped             = render_run_export_html (document);
    const std::vector<std::string> by_code{ "HTTP 500", "No response", "HTTP 503" };
    EXPECT_EQ (error_row_labels (untyped), by_code);
    EXPECT_NE (untyped.find ("<th scope=\"row\">No response</th><td>300</td>"),
    std::string::npos);
    EXPECT_EQ (untyped.find ("HTTP 0"), std::string::npos);
}

// Types that stop at the error store's cap leave part of code 0 unnamed: it
// stays as one "No response" row holding the remainder (300 - 50), so each
// request is listed once. Mutation check: drop code 0 whenever a type row
// exists and the row, and its 250, are gone.
TEST (RunExportHtmlTest, NoResponseRemainderIsOneRowWhenTypesStopAtTheCap) {
    ordered_json document = read_document ("errors-and-budget-failed");
    document["report"]["errors"]["types"] = { { "timeout", 50 } };
    const std::string html                = render_run_export_html (document);

    const std::vector<std::string> expected{ "HTTP 500", "HTTP 503", "No response", "timeout" };
    const auto labels = error_row_labels (html);
    ASSERT_FALSE (labels.empty ()) << html;
    EXPECT_EQ (labels, expected);
    EXPECT_NE (html.find ("<th scope=\"row\">No response</th><td>250</td>"),
    std::string::npos);
    EXPECT_EQ (html.find ("HTTP 0"), std::string::npos);
}

// #2938: a flagged run's document has no `latency` section, and every row of
// the table reads `-` rather than a zero. Mutation check: read the figure
// through a default of 0 in `latency_table` and this fails.
TEST (RunExportHtmlTest, AReportWithoutLatencyPrintsADashInEveryRow) {
    ordered_json document                    = read_document ("healthy-passed");
    document["report"]["summary"]["partial"] = true;
    document["report"].erase ("latency");
    const std::string html = render_run_export_html (document);
    for (const char* key : { "min", "p50", "p90", "p95", "p99", "p999", "max" }) {
        EXPECT_NE (html.find (std::string ("<tr><th scope=\"row\">") + key + "</th><td>-</td>"),
        std::string::npos)
        << key;
    }
    EXPECT_EQ (html.find ("is 0"), std::string::npos);
}

// #2905: the notice sits in the verdict's band, one paragraph per flag.
// Mutation check: drop the notices loop from `verdict_section` and this fails.
TEST (RunExportHtmlTest, AReconciledRunSaysSoInTheVerdictBand) {
    const ordered_json healthy = read_document ("healthy-passed");
    const std::string plain    = render_run_export_html (healthy);
    EXPECT_EQ (plain.find ("Partial run"), std::string::npos);
    EXPECT_EQ (plain.find ("No summary was recorded"), std::string::npos);

    const auto band_of = [&] (bool partial, bool missing) {
        ordered_json document = healthy;
        if (partial) {
            document["report"]["summary"]["partial"] = true;
        }
        if (missing) {
            document["report"]["summary"]["summaryMissing"] = true;
        }
        const std::string html = render_run_export_html (document);
        const auto open        = html.find ("<div class=\"band band-good\">");
        const auto close       = html.find ("</div>", open);
        return open == std::string::npos ? std::string () :
                                           html.substr (open, close - open);
    };
    // The sentence carries an apostrophe, so the escaper is part of what is pinned.
    const std::string PARTIAL = "<p>" +
    escape_html (
    "Partial run: the engine stopped before this run finished, so the "
    "totals are the last saved tick's and latency was not recorded.") +
    "</p>\n";
    const std::string MISSING =
    "<p>No summary was recorded for this run, so the counts "
    "are not whole-run totals and latency was not recorded.</p>\n";

    const std::string partial_band = band_of (true, false);
    ASSERT_FALSE (partial_band.empty ());
    EXPECT_TRUE (partial_band.ends_with (PARTIAL)) << partial_band;
    EXPECT_TRUE (band_of (false, true).ends_with (MISSING));
    EXPECT_TRUE (band_of (true, true).ends_with (PARTIAL + MISSING));
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
        for (const auto& [tone, words] :
        std::map<std::string, std::vector<std::string>>{ { "tone-good", { "met", "improved" } },
        { "tone-bad", { "missed", "regressed", "(over budget)", "(over limit)", "failed" } } }) {
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
