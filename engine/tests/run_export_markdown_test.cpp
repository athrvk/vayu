/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_export_markdown_test.cpp
 * @brief The run-report document as Markdown (#2131): golden files, the
 *        escaping that keeps free text from breaking a table, the number
 *        tiers and the size bound.
 *
 * Each case is a pair under `tests/fixtures/run-export/`: `<case>.document.json`
 * is a run-report document (the input, validated against
 * `docs/engine/run-export.schema.json` so it cannot drift into a shape the
 * builder never writes) and `<case>.golden.md` the exact bytes the renderer
 * must produce from it. A deliberate change to the output is regenerated and
 * its diff reviewed, never edited by hand:
 *
 *     VAYU_UPDATE_GOLDEN=1 ctest --preset linux-dev -R RunExportMarkdown
 *
 * That run rewrites every golden and skips the comparison; run again without the
 * variable to confirm. The goldens are read as bytes, and `.gitattributes`
 * keeps them LF on every platform.
 */

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include "run_export_fixtures.hpp"
#include "run_export_schema_support.hpp"
#include "vayu/core/run_export_markdown.hpp"
#include "vayu/core/run_export_view.hpp"

namespace {

using nlohmann::json;
using nlohmann::ordered_json;
using vayu::core::escape_markdown_cell;
using vayu::core::render_run_export_markdown;
using vayu::tests::case_path;
using vayu::tests::env_is_set;
using vayu::tests::fixtures_dir;
using vayu::tests::read_bytes;
using vayu::tests::read_document;

/// Everything the golden pairs hold, in the order of the issue's list.
constexpr auto CASES = std::to_array<std::string_view> (
{ "healthy-passed", "errors-and-budget-failed", "stopped-early",
"vs-baseline-regressed", "no-budgets", "collection-load", "hostile-text" });

/// 6 KB: what an agent reads for one run without it crowding out the rest.
constexpr std::size_t SIZE_LIMIT_BYTES = 6144;

// --- reading what the renderer wrote ------------------------------------------

std::vector<std::string> lines_of (const std::string& text) {
    std::vector<std::string> lines;
    std::istringstream in (text);
    for (std::string line; std::getline (in, line);) {
        lines.push_back (line);
    }
    return lines;
}

/// The cells a table row holds: its pipes that are not backslash-escaped,
/// less the two that frame the row.
std::size_t cell_count (std::string_view row) {
    std::size_t pipes = 0;
    for (std::size_t at = 0; at < row.size (); ++at) {
        if (row[at] == '\\') {
            ++at;
        } else if (row[at] == '|') {
            ++pipes;
        }
    }
    return pipes - 1;
}

/// @p line with each inline code span cut out: what an HTML-aware reader
/// would still parse.
std::string without_code_spans (const std::string& line) {
    std::string out;
    for (std::size_t at = 0; at < line.size ();) {
        if (line[at] != '`') {
            out += line[at++];
            continue;
        }
        std::size_t fence_end = at;
        while (fence_end < line.size () && line[fence_end] == '`') {
            ++fence_end;
        }
        const std::string fence = line.substr (at, fence_end - at);
        const auto close        = line.find (fence, fence_end);
        at = close == std::string::npos ? line.size () : close + fence.size ();
    }
    return out;
}

/// Whether @p line holds a `<` an HTML-aware reader would read as a tag, a
/// comment or a declaration: unescaped, and followed by a letter, `/`, `!` or `?`.
bool has_html_start (const std::string& line) {
    for (std::size_t at = 0; at + 1 < line.size (); ++at) {
        if (line[at] == '\\') {
            ++at;
        } else if (line[at] == '<' &&
        (std::isalpha (static_cast<unsigned char> (line[at + 1])) != 0 ||
        std::string_view ("/!?").find (line[at + 1]) != std::string_view::npos)) {
            return true;
        }
    }
    return false;
}

// --- the goldens ---------------------------------------------------------------------

class RunExportMarkdownGoldenTest : public ::testing::TestWithParam<std::string_view> {
};

TEST_P (RunExportMarkdownGoldenTest, MatchesItsGoldenByteForByte) {
    const std::string_view name = GetParam ();
    const std::string rendered = render_run_export_markdown (read_document (name));
    const auto golden = case_path (name, ".golden.md");

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
    << "VAYU_UPDATE_GOLDEN=1 ctest --preset linux-dev -R RunExportMarkdown and "
       "review the diff";
}

TEST_P (RunExportMarkdownGoldenTest, InputIsAValidRunReportDocument) {
    const json schema = vayu::tests::load_run_export_schema ();
    ASSERT_TRUE (schema.is_object () && schema.contains ("properties"));
    const json document =
    json::parse (read_bytes (case_path (GetParam (), ".document.json")));
    EXPECT_EQ (vayu::tests::run_export_schema_errors (schema, document), "");
}

TEST_P (RunExportMarkdownGoldenTest, StaysPlainMarkdownAndWithinBudget) {
    const std::string rendered =
    render_run_export_markdown (read_document (GetParam ()));
    ASSERT_FALSE (rendered.empty ());
    EXPECT_LT (rendered.size (), SIZE_LIMIT_BYTES);
    EXPECT_TRUE (rendered.ends_with ("\n"));
    EXPECT_FALSE (rendered.ends_with ("\n\n"));
    EXPECT_EQ (rendered.find ('\r'), std::string::npos);

    std::size_t table_width = 0;
    for (const std::string& line : lines_of (rendered)) {
        // Inside a code span, HTML and image syntax is only text.
        EXPECT_FALSE (has_html_start (without_code_spans (line))) << line;
        EXPECT_EQ (without_code_spans (line).find ("!["), std::string::npos)
        << "an image: " << line;
        if (!line.starts_with ('|')) {
            table_width = 0;
            continue;
        }
        // Every row of a table has the header's cells: a stray pipe splits one.
        table_width = table_width == 0 ? cell_count (line) : table_width;
        EXPECT_EQ (cell_count (line), table_width) << line;
    }
}

INSTANTIATE_TEST_SUITE_P (Cases,
RunExportMarkdownGoldenTest,
::testing::ValuesIn (CASES),
[] (const ::testing::TestParamInfo<std::string_view>& info) {
    std::string name (info.param);
    std::ranges::replace (name, '-', '_');
    return name;
});

// --- what the cases are for ----------------------------------------------------------------

TEST (RunExportMarkdownTest, SectionsComeInTheDocumentedOrder) {
    const std::string text =
    render_run_export_markdown (read_document ("vs-baseline-regressed"));
    std::size_t from = 0;
    for (const std::string_view marker :
    { "# Orders API", "**Failed** - ", "## Run", "## Results", "## Latency",
    "## Errors", "## Compared with ", "---\n\nGenerated by Vayu" }) {
        const auto at = text.find (marker, from);
        ASSERT_NE (at, std::string::npos) << marker << " after offset " << from << " in:\n"
                                          << text;
        from = at;
    }
}

TEST (RunExportMarkdownTest, TheVerdictSaysWhatTheDocumentDecidedNotWhatItRecomputes) {
    // The numbers say 100% errors and every budget met; the document says passed.
    ordered_json document = read_document ("healthy-passed");
    document["report"]["summary"]["errorRate"] = 100.0;
    const std::string text = render_run_export_markdown (document);
    EXPECT_NE (text.find ("**Passed** - 3 of 3 budgets met"), std::string::npos) << text;
}

TEST (RunExportMarkdownTest, NamesTheMissedBudgetsWithTheirFigures) {
    const std::string text =
    render_run_export_markdown (read_document ("errors-and-budget-failed"));
    EXPECT_NE (text.find ("**Failed** - p95 <= 800 ms missed (903 ms); error "
                          "rate <= 1.0% missed "
                          "(15.0%)"),
    std::string::npos)
    << text;
}

TEST (RunExportMarkdownTest, ErrorRateIsTheReportsWithItsTwoKindsOfFailure) {
    const std::string text =
    render_run_export_markdown (read_document ("errors-and-budget-failed"));
    EXPECT_NE (text.find ("15.0% (HTTP errors 1,500, No response 300)"), std::string::npos)
    << text;

    // The renderer reads the rate; it does not derive one from the counts.
    ordered_json document = read_document ("errors-and-budget-failed");
    document["report"]["summary"]["errorRate"] = 7.5;
    EXPECT_NE (
    render_run_export_markdown (document).find ("7.5% (HTTP errors 1,500"),
    std::string::npos);
}

/// The first cell of each body row of the Errors table, trimmed.
std::vector<std::string> error_row_labels (const std::string& text) {
    std::vector<std::string> labels;
    bool in_errors = false;
    for (const std::string& line : lines_of (text)) {
        if (line.starts_with ("## ")) {
            in_errors = line == "## Errors";
            continue;
        }
        if (!in_errors || !line.starts_with ("| ") ||
        line.starts_with ("| Error ") || line.starts_with ("| -")) {
            continue;
        }
        const auto end    = line.find (" |", 2);
        std::string label = line.substr (2, end - 2);
        label.erase (label.find_last_not_of (' ') + 1);
        labels.push_back (label);
    }
    return labels;
}

// #2400: code 0 counts the requests the type rows already list, so they are
// listed once, under their types, and no row says "HTTP 0". Mutation check:
// restore the `"HTTP " + user (code)` label and the erase of code 0 and the
// golden and this red on an `HTTP 0` row.
TEST (RunExportMarkdownTest, NoResponseRequestsAreListedOnceUnderTheirTypes) {
    const ordered_json document = read_document ("errors-and-budget-failed");
    ASSERT_EQ (document["report"]["errors"]["byStatusCode"]["0"], 300)
    << "the fixture has to carry the no-response count for this to test "
       "anything";
    const std::string text = render_run_export_markdown (document);

    const std::vector<std::string> expected{ "HTTP 500", "HTTP 503", "timeout",
        "connection_reset" };
    EXPECT_EQ (error_row_labels (text), expected) << text;
    EXPECT_EQ (text.find ("HTTP 0"), std::string::npos) << text;
}

// A run whose types were never counted (stored before #2400 past the cap) keeps
// its no-response total as one row, worded as the app words it.
TEST (RunExportMarkdownTest, NoResponseIsOneRowWhenNoTypeListsThem) {
    ordered_json document = read_document ("errors-and-budget-failed");
    document["report"]["errors"]["types"] = ordered_json::object ();
    const std::string text = render_run_export_markdown (document);

    // Most frequent first; the tie at 300 is broken by the code, 0 before 503.
    const std::vector<std::string> expected{ "HTTP 500", "No response", "HTTP 503" };
    EXPECT_EQ (error_row_labels (text), expected) << text;
    EXPECT_NE (text.find ("| No response | 300      |"), std::string::npos) << text;
    EXPECT_EQ (text.find ("HTTP 0"), std::string::npos) << text;
}

TEST (RunExportMarkdownTest, AStoppedRunSaysHowFarItGot) {
    const std::string text =
    render_run_export_markdown (read_document ("stopped-early"));
    EXPECT_NE (text.find ("**Not judged** - a stopped run is not "
                          "judged\n\nStopped early at 3.2 s of 20 s\n"),
    std::string::npos)
    << text;
    EXPECT_NE (text.find ("<= 80 ms - not evaluated"), std::string::npos) << text;
}

TEST (RunExportMarkdownTest, TheStoppedRunReadsItsPlannedDurationLikeTheRunDoes) {
    struct Spelling {
        std::string_view duration;
        std::string_view planned;
    };
    // The spellings `parse_duration_ms` takes, so the line agrees with the run.
    for (const Spelling& spelling :
    std::to_array<Spelling> ({ { "1.5s", "1.5 s" }, { "30S", "30 s" },
    { "2m", "120 s" }, { " 500ms ", "0.5 s" }, { "45", "45 s" } })) {
        ordered_json document = read_document ("stopped-early");
        document["config"]["configuration"]["duration"] = spelling.duration;
        const std::string text = render_run_export_markdown (document);
        EXPECT_NE (
        text.find ("Stopped early at 3.2 s of " + std::string (spelling.planned) + "\n"),
        std::string::npos)
        << spelling.duration << ":\n"
        << text;
    }

    // A duration no reader takes leaves the planned half off rather than guessing.
    ordered_json document = read_document ("stopped-early");
    document["config"]["configuration"]["duration"] = "soon";
    EXPECT_NE (
    render_run_export_markdown (document).find ("Stopped early at 3.2 s\n"),
    std::string::npos);
}

TEST (RunExportMarkdownTest, MissedBudgetsWithNoFailedCheckStillSayWhatHappened) {
    ordered_json document = read_document ("errors-and-budget-failed");
    document["report"]["thresholdValidation"]["checks"] = ordered_json::array ();
    const std::string text = render_run_export_markdown (document);
    EXPECT_NE (text.find ("**Failed** - budgets missed\n"), std::string::npos) << text;
}

TEST (RunExportMarkdownTest, TheComparisonIsOmittedWithoutOneAndReadsDirectionWithOne) {
    EXPECT_EQ (render_run_export_markdown (read_document ("healthy-passed")).find ("Compared with"),
    std::string::npos);

    const std::string text =
    render_run_export_markdown (read_document ("vs-baseline-regressed"));
    const auto row = [&text] (std::string_view label) {
        const auto at = text.find ("| " + std::string (label));
        return at == std::string::npos ? std::string () :
                                         text.substr (at, text.find ('\n', at) - at);
    };
    // A longer latency regressed, a shorter peak improved, a neutral count did not move.
    EXPECT_NE (row ("P50 latency").find ("regressed"), std::string::npos) << text;
    EXPECT_NE (row ("Max latency").find ("improved"), std::string::npos) << text;
    EXPECT_NE (row ("Total requests").find ("unchanged"), std::string::npos) << text;
    // A figure one run never recorded is not a claim that nothing moved.
    EXPECT_NE (row ("Response rate").find ("not compared"), std::string::npos) << text;
    EXPECT_NE (
    text.find ("- Virtual users: 50 in the base run, 80 in this one"), std::string::npos)
    << text;
}

TEST (RunExportMarkdownTest, AnExpectContinueDifferenceReadsWithItsLabel) {
    auto document = read_document ("vs-baseline-regressed");
    document["comparison"]["differences"].push_back ({ { "field", "expect_continue" },
    { "base", "not allowed" }, { "target", "allowed" } });
    const std::string text = render_run_export_markdown (document);
    EXPECT_NE (text.find ("- Expect: 100-continue: not allowed in the base "
                          "run, allowed in this one"),
    std::string::npos)
    << text;
    EXPECT_EQ (text.find ("expect_continue"), std::string::npos) << text;
}

TEST (RunExportMarkdownTest, AMissingSectionReadsAsADashNotAnError) {
    const std::string text = render_run_export_markdown (ordered_json::object ());
    EXPECT_FALSE (text.empty ());
    EXPECT_NE (text.find ("| Requests "), std::string::npos) << text;
    EXPECT_NE (text.find ("| Target "), std::string::npos) << text;
    EXPECT_EQ (render_run_export_markdown (ordered_json (nullptr)), text);
}

// --- size ---------------------------------------------------------------------------------------

TEST (RunExportMarkdownTest, ALongRunWithManyStatusCodesStaysUnderSixKilobytes) {
    ordered_json document = read_document ("errors-and-budget-failed");
    ordered_json codes    = ordered_json::object ();
    ordered_json errors   = ordered_json::object ();
    for (int code = 400; code < 700; ++code) {
        codes[std::to_string (code)]  = 100 + code;
        errors[std::to_string (code)] = 100 + code;
    }
    document["report"]["statusCodes"]            = codes;
    document["report"]["errors"]["byStatusCode"] = errors;
    ordered_json ticks                           = ordered_json::array ();
    for (int second = 0; second < 7200; ++second) {
        ticks.push_back ({ { "elapsed_seconds", second },
        { "requests_completed", second * 10 }, { "requests_failed", 0 },
        { "current_rps", 10.0 }, { "current_concurrency", 5 }, { "throughput", 10.0 },
        { "error_rate", 0.0 }, { "status_codes", codes }, { "latency_p50_ms", 1.0 },
        { "latency_p95_ms", 2.0 }, { "latency_p99_ms", 3.0 } });
    }
    document["timeSeries"] = ticks;

    const std::string text = render_run_export_markdown (document);
    EXPECT_LT (text.size (), SIZE_LIMIT_BYTES) << text.size () << " bytes";
    // Past the cap the rest is one row, not omitted: the count still adds up.
    EXPECT_NE (text.find ("Other (290 codes)"), std::string::npos) << text;

    document.erase ("timeSeries");
    EXPECT_EQ (render_run_export_markdown (document), text);
}

// --- escaping ----------------------------------------------------------------------------------------

struct EscapeCase {
    std::string_view name;
    std::string_view input;
    std::string_view expected;
};

constexpr auto ESCAPE_CASES = std::to_array<EscapeCase> ({
{ "plain text is left alone", "Orders API v2", "Orders API v2" },
{ "a pipe cannot end a cell", "a|b", "a\\|b" },
{ "a backtick cannot open a code span", "`x`", "\\`x\\`" },
{ "a tag cannot open", "<script>alert(1)</script>", "\\<script\\>alert(1)\\</script\\>" },
{ "a backslash cannot escape the next character", "a\\|b", "a\\\\\\|b" },
{ "line breaks become one space",
"a\r\n\nb\xE2\x80\xA8"
"c\xE2\x80\xA9"
"d",
"a b c d" },
{ "controls become one space",
"a\t\x01\x7F"
"b",
"a b" },
{ "a link and an image cannot open", "![i](http://x/y) [a](b)", "!\\[i\\](http://x/y) \\[a\\](b)" },
{ "emphasis cannot open", "*a* _b_ ~c~", "\\*a\\* \\_b\\_ \\~c\\~" },
{ "an underscore inside a word is left alone", "user_id and snake_case_name", "user_id and snake_case_name" },
{ "an entity cannot be written", "&lt; &#60; &amp;", "\\&lt; \\&#60; \\&amp;" },
{ "an ampersand that writes nothing is left alone", "a=1&b=2 & c", "a=1&b=2 & c" },
{ "a block marker at the start is escaped", "# h", "\\# h" },
{ "a list marker at the start is escaped", "- item", "\\- item" },
{ "a rule at the start is escaped", "--- x", "\\--- x" },
{ "a dash that starts a number is left alone", "-5 ms", "-5 ms" },
{ "an ordered marker at the start is escaped", "1. item", "1\\. item" },
{ "leading spaces cannot hide a heading", "  # h", "\\# h" },
{ "leading spaces cannot make a code block", "    code", "code" },
{ "leading spaces cannot hide an ordered marker", "   1. x", "1\\. x" },
{ "a leading tab cannot hide a list marker", "\t- x", "\\- x" },
{ "only spaces is empty", "   ", "" },
{ "spaces inside the text stay", "a  b", "a  b" },
{ "a number that is not a marker is left alone", "1.5 s", "1.5 s" },
{ "empty stays empty", "", "" },
});

TEST (RunExportMarkdownTest, EscapesFreeTextInOnePlace) {
    for (const EscapeCase& test : ESCAPE_CASES) {
        EXPECT_EQ (escape_markdown_cell (test.input), test.expected) << test.name;
    }
}

TEST (RunExportMarkdownTest, AHostileNameCannotBreakATableOrInjectHtml) {
    const std::string text =
    render_run_export_markdown (read_document ("hostile-text"));
    ASSERT_FALSE (text.empty ());
    // Nothing a reader could parse as a tag survives outside a code span.
    for (const std::string& line : lines_of (text)) {
        EXPECT_FALSE (has_html_start (without_code_spans (line))) << line;
    }
    // The title is a single heading line, however many lines the name had.
    const std::vector<std::string> lines = lines_of (text);
    ASSERT_GE (lines.size (), 3U);
    EXPECT_TRUE (lines.front ().starts_with ("# Evil \\| ")) << lines.front ();
    EXPECT_TRUE (lines[1].empty ());
    // The fence is longer than the longest backtick run inside the name.
    EXPECT_TRUE (lines[2].starts_with ("``Vayu run ")) << lines[2];
    EXPECT_TRUE (lines[2].ends_with ("``")) << lines[2];
    // No second heading was injected by the `# injected` inside the name.
    const auto headings = std::ranges::count_if (
    lines, [] (const std::string& line) { return line.starts_with ("# "); });
    EXPECT_EQ (headings, 1);
}

TEST (RunExportMarkdownTest, AWarningCannotOpenABlockInsideItsListItem) {
    ordered_json document = read_document ("healthy-passed");
    document["report"]["warnings"] =
    ordered_json::array ({ { { "message", "  # heading" } },
    { { "message", "    code" } }, { { "message", "   1. nested" } } });
    const std::string text = render_run_export_markdown (document);
    EXPECT_NE (
    text.find ("## Warnings\n\n- \\# heading\n- code\n- 1\\. nested\n"), std::string::npos)
    << text;
}

TEST (RunExportMarkdownTest, AWarningNameThatIsNotAStringReadsAsADashNotAnError) {
    ordered_json document = read_document ("healthy-passed");
    document["report"]["warnings"] = ordered_json::array ({ { { "message", "slow" },
    { "names", ordered_json::array ({ "a", 7, nullptr, "b" }) } } });
    const std::string text = render_run_export_markdown (document);
    EXPECT_NE (text.find ("- slow: a, -, -, b\n"), std::string::npos) << text;
}

// --- numbers -------------------------------------------------------------------------------------------

/// The (value, expected) pairs per formatter. The app's `formatMs`,
/// `formatRate` and `formatErrorPercent` (`lib/format-number.ts`) follow the
/// same tiers but spell them through `Intl`, so a host locale can change a
/// separator there; this table is the locale-free statement of the tiers, for
/// the app's formatter to adopt (#2147).
std::string spell (std::string_view formatter, double value) {
    if (formatter == "figure") {
        return vayu::core::format_run_figure (value);
    }
    if (formatter == "count") {
        return vayu::core::format_run_count (value);
    }
    if (formatter == "percent") {
        return vayu::core::format_run_percent (value);
    }
    if (formatter == "bytes") {
        return vayu::core::format_run_bytes (value);
    }
    if (formatter == "seconds") {
        return vayu::core::format_run_seconds (value);
    }
    ADD_FAILURE () << "no formatter named " << formatter;
    return {};
}

TEST (RunExportMarkdownTest, NumbersFollowTheTierTable) {
    const json fixture =
    json::parse (read_bytes (fixtures_dir () / "run-export-number-tiers.json"));
    const json& cases = fixture.at ("cases");
    ASSERT_TRUE (cases.is_array ());
    ASSERT_GT (cases.size (), 40U);
    for (const json& test : cases) {
        const auto formatter = test.at ("formatter").get<std::string> ();
        const double value   = test.at ("value").get<double> ();
        EXPECT_EQ (spell (formatter, value), test.at ("expected").get<std::string> ())
        << formatter << " " << value;
    }
}

} // namespace
