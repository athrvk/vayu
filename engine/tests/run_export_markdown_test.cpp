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
constexpr auto CASES = std::to_array<std::string_view> ({ "healthy-passed",
"errors-and-budget-failed", "stopped-early", "vs-baseline-regressed",
"no-budgets", "collection-load", "hostile-text", "skipped-requests",
"capacity-slo-exceeded", "scenario-sequence", "contract-bound" });

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
    // No real run is both a capacity search and a scenario run, but the order
    // of every section is only visible in a document that holds them all.
    ordered_json document = read_document ("vs-baseline-regressed");
    document["report"]["capacity"] =
    read_document ("capacity-slo-exceeded")["report"]["capacity"];
    document["report"]["scenario"] =
    read_document ("scenario-sequence")["report"]["scenario"];
    document["report"]["coverage"] = read_document ("contract-bound")["report"]["coverage"];
    const std::string text = render_run_export_markdown (document);
    std::size_t from       = 0;
    for (const std::string_view marker : { "# Orders API", "**Failed** - ", "## Run",
         "## Results", "## Latency", "## Capacity", "## Contract", "## Sequence", "## Transactions",
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

// Mutation check: make `assertions_failed_text` answer empty and the first
// three expectations fail.
TEST (RunExportMarkdownTest, TheVerdictNamesFailedAssertionsWithAndWithoutErrors) {
    ordered_json document         = read_document ("healthy-passed");
    document["verdict"]["state"]  = "not_judged";
    document["verdict"]["reason"] = "budgets_met_with_assertion_failures";
    document["report"]["scenario"]["assertions"] = { { "passed", 0 }, { "failed", 4580 } };
    EXPECT_NE (
    render_run_export_markdown (document).find (
    "**Not judged** - 3 of 3 budgets met, but 4,580 assertions failed\n"),
    std::string::npos);

    document["report"]["scenario"]["assertions"]["failed"] = 1;
    EXPECT_NE (render_run_export_markdown (document).find (
               "budgets met, but 1 assertion failed\n"),
    std::string::npos);

    document["verdict"]["reason"]              = "budgets_met_with_errors";
    document["report"]["summary"]["errorRate"] = 0.4;
    EXPECT_NE (
    render_run_export_markdown (document).find (
    "budgets met, but 0.4% of requests errored, 1 assertion failed\n"),
    std::string::npos);

    document["report"]["scenario"]["assertions"]["failed"] = 0;
    const std::string errors_only = render_run_export_markdown (document);
    EXPECT_NE (errors_only.find ("budgets met, but 0.4% of requests errored\n"),
    std::string::npos);
    EXPECT_EQ (errors_only.find ("assertion"), std::string::npos);
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

// --- skipped requests (#2911) -----------------------------------------------------------

constexpr std::string_view SKIPPED_ROW_START = "| Skipped requests";

std::string skipped_row_of (const std::string& text) {
    for (const std::string& line : lines_of (text)) {
        if (line.starts_with (SKIPPED_ROW_START)) {
            return line;
        }
    }
    return {};
}

ordered_json skipped_document (double skipped, double stalled_ms) {
    ordered_json document = read_document ("no-budgets");
    document["report"]["summary"]["skippedRequests"] = skipped;
    document["report"]["summary"]["stalledMs"]       = stalled_ms;
    return document;
}

TEST (RunExportMarkdownTest, SaysHowManyRequestsAStalledGeneratorSkippedAndForHowLong) {
    const std::string row = skipped_row_of (
    render_run_export_markdown (read_document ("skipped-requests")));
    EXPECT_NE (
    row.find ("625 requests skipped: the load generator stalled for 2.5 s"), std::string::npos)
    << row;
}

TEST (RunExportMarkdownTest, ASingleSkippedRequestIsSingular) {
    const std::string row =
    skipped_row_of (render_run_export_markdown (skipped_document (1, 4000)));
    EXPECT_NE (
    row.find ("1 request skipped: the load generator stalled for 4 s"), std::string::npos)
    << row;
}

TEST (RunExportMarkdownTest, AStallTooShortForASecondDecimalIsNeverZeroSeconds) {
    const std::string row =
    skipped_row_of (render_run_export_markdown (skipped_document (1, 20)));
    EXPECT_NE (
    row.find ("1 request skipped: the load generator stalled for <0.1 s"), std::string::npos)
    << row;
}

TEST (RunExportMarkdownTest, NoSkipsPrintNoRowWhetherTheKeyIsZeroOrAbsent) {
    // Absent is a document written before #2911; 0 is a pacer that kept up.
    EXPECT_EQ (
    skipped_row_of (render_run_export_markdown (read_document ("no-budgets"))), "");
    EXPECT_EQ (skipped_row_of (render_run_export_markdown (skipped_document (0, 0))), "");
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

// A run stored before the per-type counts has types that stop at the error
// store's cap, so they sum to less than code 0. The requests no type names stay
// as one "No response" row holding the remainder, so each is listed once.
// Mutation check: drop code 0 whenever a type row exists and the row, and its
// 250, are gone.
TEST (RunExportMarkdownTest, NoResponseRemainderIsOneRowWhenTypesStopAtTheCap) {
    ordered_json document = read_document ("errors-and-budget-failed");
    document["report"]["errors"]["types"] = { { "timeout", 50 } };
    const std::string text = render_run_export_markdown (document);

    // Most frequent first; the remainder 250 sorts between 300 and 50.
    const std::vector<std::string> expected{ "HTTP 500", "HTTP 503", "No response", "timeout" };
    const auto labels = error_row_labels (text);
    ASSERT_FALSE (labels.empty ()) << text;
    EXPECT_EQ (labels, expected) << text;
    EXPECT_NE (text.find ("| No response | 250      |"), std::string::npos) << text;
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

constexpr std::string_view PARTIAL_NOTICE =
"Partial run: the engine stopped before this run finished, so the totals are "
"the last saved tick's and latency was not recorded.";
constexpr std::string_view SUMMARY_MISSING_NOTICE =
"No summary was recorded for this run, so the counts are not whole-run totals "
"and latency was not recorded.";

/// The verdict line of a rendered report, `**Passed** - ...` up to its newline.
std::string verdict_line_of (const std::string& text) {
    const auto at = text.find ("**");
    return at == std::string::npos ? std::string () :
                                     text.substr (at, text.find ('\n', at) - at);
}

// #2938: a flagged run's document has no `latency` section, and every row of
// the table reads `-` rather than a zero. Mutation check: read the figure
// through a default of 0 in `latency_table` and this fails.
TEST (RunExportMarkdownTest, AReportWithoutLatencyPrintsADashInEveryRow) {
    ordered_json document                    = read_document ("healthy-passed");
    document["report"]["summary"]["partial"] = true;
    document["report"].erase ("latency");
    const std::string text = render_run_export_markdown (document);
    for (const char* row :
    { "min    ", "p50    ", "p90    ", "p95    ", "p99    ", "p999   ", "max    " }) {
        EXPECT_NE (text.find (std::string ("| ") + row + " | -            | "),
        std::string::npos)
        << row << "\n"
        << text;
    }
    EXPECT_EQ (text.find ("is 0"), std::string::npos) << text;
}

// #2905: a reconciled or summaryless run says its figures are not a
// measurement, directly under the verdict. Mutation check: drop the notices
// loop from `verdict_block` and this fails.
TEST (RunExportMarkdownTest, AReconciledRunSaysSoUnderTheVerdict) {
    const ordered_json healthy = read_document ("healthy-passed");
    const std::string plain    = render_run_export_markdown (healthy);
    const std::string verdict  = verdict_line_of (plain);
    ASSERT_FALSE (verdict.empty ());
    EXPECT_EQ (plain.find ("Partial run"), std::string::npos) << plain;
    EXPECT_EQ (plain.find ("No summary was recorded"), std::string::npos) << plain;

    const auto rendered = [&] (bool partial, bool missing) {
        ordered_json document = healthy;
        if (partial) {
            document["report"]["summary"]["partial"] = true;
        }
        if (missing) {
            document["report"]["summary"]["summaryMissing"] = true;
        }
        return render_run_export_markdown (document);
    };
    const std::string partial = std::string (PARTIAL_NOTICE);
    const std::string missing = std::string (SUMMARY_MISSING_NOTICE);
    EXPECT_NE (rendered (true, false).find (verdict + "\n\n" + partial + "\n\n## Run"),
    std::string::npos);
    EXPECT_NE (rendered (false, true).find (verdict + "\n\n" + missing + "\n\n## Run"),
    std::string::npos);
    EXPECT_NE (rendered (true, true).find (verdict + "\n\n" + partial + "\n\n" + missing + "\n\n## Run"),
    std::string::npos);
    EXPECT_EQ (rendered (true, false).find (missing), std::string::npos);
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

// --- capacity (#2819) -------------------------------------------------------------------

/// The line of @p text that starts with @p prefix, or empty.
std::string line_starting (const std::string& text, std::string_view prefix) {
    for (const std::string& line : lines_of (text)) {
        if (line.starts_with (prefix)) {
            return line;
        }
    }
    return {};
}

/// Whether @p text holds the line @p wanted whole.
bool has_line (const std::string& text, std::string_view wanted) {
    const std::vector<std::string> lines = lines_of (text);
    return std::ranges::find (lines, wanted) != lines.end ();
}

/// @p name's section: from its heading to the next one.
std::string section_of (const std::string& text, std::string_view heading) {
    const auto start = text.find (std::string (heading) + "\n");
    if (start == std::string::npos) {
        return {};
    }
    const auto end = text.find ("\n## ", start + 1);
    return text.substr (start, end == std::string::npos ? end : end - start);
}

ordered_json capacity_document (std::string_view stop) {
    ordered_json document = read_document ("capacity-slo-exceeded");
    document["report"]["capacity"]["stopReason"] = std::string (stop);
    return document;
}

// Mutation check: drop `view.capacity = capacity_of (document)` from
// `build_run_report_view` and every expectation in this group fails.
TEST (RunExportMarkdownTest, ACapacitySearchReportsWhatItFoundAndWhyItStopped) {
    const std::string text =
    render_run_export_markdown (read_document ("capacity-slo-exceeded"));
    EXPECT_NE (
    text.find ("## Capacity\n\n**Latency budget exceeded** - Sustained 41 "
               "virtual users at 403 req/s, with a p99 of 178 ms against "
               "a 200 ms budget.\n"),
    std::string::npos)
    << text;
    EXPECT_NE (
    text.find ("\nThe limit lies between 41 and 51 virtual users: it held "
               "41 and gave out at 51, where p99 reached 226 ms.\n"),
    std::string::npos)
    << text;
    EXPECT_NE (
    text.find ("\np99 stayed above the budget across two consecutive "
               "measurements of the level (each 5s long).\n"),
    std::string::npos)
    << text;
    EXPECT_NE (
    text.find ("\nBudget: p99 <= 200 ms; error limit: 1.0%; step length: 5s\n"),
    std::string::npos)
    << text;
}

TEST (RunExportMarkdownTest, ACapacityRunReadsItsConfigurationAsASearch) {
    const std::string text =
    render_run_export_markdown (read_document ("capacity-slo-exceeded"));
    EXPECT_NE (
    text.find ("| Virtual users  | Search from 1 up to 128 virtual users"), std::string::npos)
    << text;
    EXPECT_NE (text.find ("| Duration       | Deadline 300 s, ran 62.4 s"), std::string::npos)
    << text;
    EXPECT_NE (text.find ("| Step           | 5s"), std::string::npos) << text;

    // Seconds as a number, and a run whose length the report does not hold.
    ordered_json document = read_document ("capacity-slo-exceeded");
    document["config"]["configuration"]["stepDuration"] = 7.5;
    document["report"]["summary"].erase ("testDuration");
    const std::string numeric = render_run_export_markdown (document);
    EXPECT_NE (numeric.find ("| Step           | 7.5 s"), std::string::npos) << numeric;
    EXPECT_NE (numeric.find ("| Duration       | Deadline 300 s "), std::string::npos)
    << numeric;
    EXPECT_EQ (numeric.find ("ran"), std::string::npos) << numeric;
    EXPECT_NE (numeric.find ("each 7.5 s long"), std::string::npos) << numeric;
}

TEST (RunExportMarkdownTest, ALevelTheSearchRepeatedIsMarkedAndOverBudgetIsSaidInWords) {
    const std::string text =
    render_run_export_markdown (read_document ("capacity-slo-exceeded"));
    const std::string first  = line_starting (text, "| 51 ");
    const std::string second = line_starting (text, "| 51 (re-measured)");
    EXPECT_NE (first.find ("226 (over budget)"), std::string::npos) << first;
    EXPECT_NE (second.find ("232 (over budget)"), std::string::npos) << second;
    EXPECT_EQ (first.find ("re-measured"), std::string::npos) << first;
    // The held level is neither flagged nor marked.
    EXPECT_EQ (line_starting (text, "| 41 ").find ('('), std::string::npos) << text;
    // The error share that went over the limit is flagged too.
    ordered_json document = read_document ("capacity-slo-exceeded");
    document["report"]["capacity"]["levels"][7]["errorPct"] = 2.5;
    EXPECT_NE (line_starting (render_run_export_markdown (document), "| 51 ").find ("2.5 (over limit)"),
    std::string::npos);
}

struct StopCase {
    std::string_view reason;
    std::string_view label;
    std::string_view detail;
};

TEST (RunExportMarkdownTest, EveryStopReasonHasItsLabelAndItsDetail) {
    for (const StopCase& stop :
    std::to_array<StopCase> (
    { { "slo_exceeded", "Latency budget exceeded",
      "p99 stayed above the budget across two consecutive measurements of the "
      "level (each 5s long)." },
    { "errors_exceeded", "Errors exceeded the limit",
    "More than 1% of requests failed across two consecutive measurements of "
    "the level (each 5s long)." },
    { "plateau", "Throughput plateaued", "More virtual users stopped buying more throughput." },
    { "cap_reached", "Reached the virtual user ceiling",
    "The target held its budget all the way up. Raise the ceiling to find the "
    "limit." },
    { "deadline", "Ran out of time", "The run's deadline passed before the search found a limit." },
    { "stopped", "Stopped by hand",
    "The run was stopped before the search reached a conclusion." } })) {
        const std::string text =
        render_run_export_markdown (capacity_document (stop.reason));
        EXPECT_NE (text.find ("**" + std::string (stop.label) + "** - "), std::string::npos)
        << stop.reason << ":\n"
        << text;
        EXPECT_TRUE (has_line (text, std::string (stop.detail))) << stop.reason << ":\n"
                                                                 << text;
    }
}

TEST (RunExportMarkdownTest, AnErrorStopNamesTheLimitAndTheShareThatBrokeIt) {
    ordered_json document = capacity_document ("errors_exceeded");
    document["report"]["capacity"]["kneeErrorPct"] = 4.2;
    const std::string text = render_run_export_markdown (document);
    EXPECT_NE (text.find ("gave out at 51, where 4.2% of requests failed.\n"),
    std::string::npos)
    << text;

    document["report"]["capacity"].erase ("maxErrorPct");
    EXPECT_TRUE (has_line (render_run_export_markdown (document),
    "More requests failed than the limit allows across two consecutive "
    "measurements of the level (each 5s long)."));
}

TEST (RunExportMarkdownTest, APlateauQuotesTheP99RiseOnlyWhenTheReportProvesOne) {
    ordered_json document             = capacity_document ("plateau");
    auto& capacity                    = document["report"]["capacity"];
    capacity["saturationConcurrency"] = 32;
    capacity["saturationRps"]         = 344.0;
    capacity["saturationP99Ms"]       = 133.0;
    const std::string text            = render_run_export_markdown (document);
    EXPECT_NE (
    text.find ("Throughput stopped growing at 32 virtual users (344 req/s, "
               "p99 133 ms). More only queued.\n"),
    std::string::npos)
    << text;
    // The last level tried is 51, p99 231.5, above the saturation level's 133.
    EXPECT_TRUE (has_line (text,
    "More virtual users stopped buying more throughput; p99 stayed inside the "
    "budget but rose from 133 ms to 232 ms."))
    << text;

    // A plateau stored before `saturation*` names no level and claims no rise.
    for (const char* key : { "saturationConcurrency", "saturationRps", "saturationP99Ms" }) {
        capacity.erase (key);
    }
    const std::string old = render_run_export_markdown (document);
    EXPECT_NE (old.find ("Throughput stopped growing. More only queued.\n"), std::string::npos)
    << old;
    EXPECT_TRUE (has_line (old, "More virtual users stopped buying more throughput."));
}

TEST (RunExportMarkdownTest, ASearchThatRanOutOfCeilingTimeOrPatienceReportsAFloor) {
    ordered_json document = capacity_document ("deadline");
    document["report"]["capacity"].erase ("kneeConcurrency");
    const std::string text = render_run_export_markdown (document);
    EXPECT_NE (
    text.find (
    "At least 41 virtual users held the budget (403 req/s, p99 178 ms). "
    "The search did not find a limit. The next level was still "
    "being measured.\n"),
    std::string::npos)
    << text;
    EXPECT_EQ (text.find ("The limit lies between"), std::string::npos) << text;

    // The ceiling is a stop of the search's own: no level was left open.
    const std::string ceiling =
    render_run_export_markdown (capacity_document ("cap_reached"));
    EXPECT_NE (ceiling.find ("The search did not find a limit.\n"), std::string::npos)
    << ceiling;
    EXPECT_EQ (ceiling.find ("still being measured"), std::string::npos) << ceiling;
}

TEST (RunExportMarkdownTest, ASearchWhoseFirstLevelGaveOutHasNothingSustained) {
    ordered_json document = capacity_document ("slo_exceeded");
    auto& capacity        = document["report"]["capacity"];
    capacity.erase ("maxHealthyConcurrency");
    const std::string budget = render_run_export_markdown (document);
    EXPECT_NE (budget.find ("No level met the 200 ms budget - the target was "
                            "already over it "
                            "at the fewest virtual users the search tried.\n"),
    std::string::npos)
    << budget;
    // Without a held level the knee is all there is to say.
    EXPECT_NE (budget.find (
               "It gave out at 51 virtual users, where p99 reached 226 ms.\n"),
    std::string::npos)
    << budget;

    document["report"]["capacity"]["stopReason"] = "errors_exceeded";
    EXPECT_NE (render_run_export_markdown (document).find (
               "No level stayed under the error "
               "limit - the target was already over it"),
    std::string::npos);
}

TEST (RunExportMarkdownTest, ASearchThatMeasuredNoLevelSaysSoInsteadOfInventingOne) {
    ordered_json document = capacity_document ("deadline");
    auto& capacity        = document["report"]["capacity"];
    capacity["levels"]    = ordered_json::array ();
    for (const char* key : { "maxHealthyConcurrency", "maxHealthyRps",
         "p99AtMaxHealthyMs", "kneeConcurrency", "kneeP99Ms" }) {
        capacity.erase (key);
    }
    const std::string text = render_run_export_markdown (document);
    EXPECT_NE (
    text.find ("The search ended before it finished measuring a single level"),
    std::string::npos)
    << text;
    EXPECT_EQ (text.find ("| Virtual users | Throughput"), std::string::npos) << text;
    EXPECT_EQ (text.find ("Sustained"), std::string::npos) << text;
}

// A newer sidecar may stop for a reason this build has no words for; the levels
// still say what happened. Mutation check: look the reason up with `.at ()`
// or drop the fallback and this fails.
TEST (RunExportMarkdownTest, AnUnknownStopReasonIsPrintedAsTheEngineSentIt) {
    const std::string text =
    render_run_export_markdown (capacity_document ("gave_up_early"));
    EXPECT_NE (text.find ("**gave_up_early** - Sustained 41 virtual users"), std::string::npos)
    << text;
    // No sentence is invented for it: the next line is the knee, then the limits.
    EXPECT_EQ (text.find ("p99 stayed above"), std::string::npos) << text;

    ordered_json absent_reason = read_document ("capacity-slo-exceeded");
    absent_reason["report"]["capacity"].erase ("stopReason");
    EXPECT_NE (render_run_export_markdown (absent_reason).find ("**-** - "),
    std::string::npos);
}

// A run stored before errors were judged has no `errorPct` on any level, and
// one stored before `samples` has none of those; their columns are not drawn.
// Mutation check: always add the two columns and this fails.
TEST (RunExportMarkdownTest, ALevelColumnTheDocumentNeverRecordedIsNotDrawn) {
    const auto header_of = [] (const std::string& text) {
        return line_starting (section_of (text, "## Capacity"), "| Virtual users");
    };
    const std::string full = header_of (
    render_run_export_markdown (read_document ("capacity-slo-exceeded")));
    EXPECT_NE (full.find ("| Errors (%) | Samples |"), std::string::npos) << full;

    ordered_json document = read_document ("capacity-slo-exceeded");
    for (auto& level : document["report"]["capacity"]["levels"]) {
        level.erase ("samples");
    }
    const std::string no_samples = header_of (render_run_export_markdown (document));
    EXPECT_NE (no_samples.find ("| Errors (%) |"), std::string::npos) << no_samples;
    EXPECT_EQ (no_samples.find ("Samples"), std::string::npos) << no_samples;

    for (auto& level : document["report"]["capacity"]["levels"]) {
        level.erase ("errorPct");
    }
    const std::string text = render_run_export_markdown (document);
    const std::string bare = header_of (text);
    EXPECT_EQ (bare.find ("Errors"), std::string::npos) << bare;
    EXPECT_NE (bare.find ("| p99 (ms)"), std::string::npos) << bare;
    // Every row still has the header's cells; the strict guard runs on goldens only.
    const std::string row = line_starting (text, "| 41 ");
    EXPECT_EQ (cell_count (row), cell_count (bare)) << row;
}

TEST (RunExportMarkdownTest, APlainLoadRunRendersNeitherSearchNorSequence) {
    for (const std::string_view name : { "healthy-passed", "no-budgets", "stopped-early" }) {
        const std::string text = render_run_export_markdown (read_document (name));
        for (const std::string_view heading :
        { "## Capacity", "## Sequence", "## Transactions" }) {
            EXPECT_EQ (text.find (heading), std::string::npos) << name << " " << heading;
        }
        EXPECT_EQ (text.find ("pooled"), std::string::npos) << name;
    }
}

// --- scenario sequence (#2819) ----------------------------------------------------------

// Mutation check: drop `view.sequence = sequence_of (document)` and the
// first three expectations fail; drop `view.transactions` and the last does.
TEST (RunExportMarkdownTest, AScenarioRunReportsItsIterationsStepsAndTransactions) {
    const std::string text =
    render_run_export_markdown (read_document ("scenario-sequence"));
    EXPECT_NE (
    text.find ("## Sequence\n\n2,110 iterations started, 2,090 completed, 15 "
               "abandoned, 5 cut short\n\n| Step "),
    std::string::npos)
    << text;
    EXPECT_NE (text.find ("| Add to cart "), std::string::npos) << text;
    EXPECT_NE (line_starting (text, "| Add to cart").find ("| 2,098"), std::string::npos)
    << text;
    EXPECT_NE (text.find ("## Transactions\n\n| Transaction "), std::string::npos) << text;
    EXPECT_NE (line_starting (text, "| Checkout ").find ("| 702 "), std::string::npos)
    << text;
}

TEST (RunExportMarkdownTest, AStepsAssertionsAreSummedFromItsAssertAndScriptElements) {
    const std::string text =
    render_run_export_markdown (read_document ("scenario-sequence"));
    // assert.* counts; timer.think does not.
    EXPECT_NE (line_starting (text, "| Log in").find ("2,105 passed, 0 failed"),
    std::string::npos)
    << text;
    EXPECT_NE (line_starting (text, "| Add to cart").find ("2,080 passed, 18 failed"),
    std::string::npos)
    << text;
    // No element that asserts reads a dash, not "0 passed, 0 failed".
    EXPECT_NE (line_starting (text, "| Pay").find ("| -"), std::string::npos) << text;
    EXPECT_EQ (line_starting (text, "| Pay").find ("passed"), std::string::npos) << text;

    // A script the engine only replays afterwards has no inline count to state.
    ordered_json document = read_document ("scenario-sequence");
    auto& elements = document["report"]["scenario"]["steps"][1]["elements"];
    elements.erase (elements.begin ());
    EXPECT_NE (
    line_starting (render_run_export_markdown (document), "| Add to cart").find ("deferred to a post-run replay"),
    std::string::npos);
}

// An assertion that threw is counted apart from one that failed (#3051), and
// the step's cell still reads it as a failure. Mutation check: drop the
// `error` term in `assertions_of` (run_export_view.cpp) and this reads 0.
TEST (RunExportMarkdownTest, AnAssertionThatErroredReadsAsFailedInItsStep) {
    ordered_json document = read_document ("scenario-sequence");
    document["report"]["scenario"]["steps"][0]["elements"][0]["error"] = 3;
    EXPECT_NE (line_starting (render_run_export_markdown (document), "| Log in").find ("2,105 passed, 3 failed"),
    std::string::npos);
}

TEST (RunExportMarkdownTest, ACollectionRunNamesItsStepsOnlyWhenTheDocumentListsThem) {
    EXPECT_NE (render_run_export_markdown (read_document ("scenario-sequence")).find ("| Target         | Collection run, 3 steps per iteration"),
    std::string::npos);
    // `stepsStored` counts stored executions, not the steps of the plan.
    ordered_json document = read_document ("scenario-sequence");
    document["report"]["scenario"].erase ("steps");
    document["report"]["scenario"]["stepsStored"] = 6;
    const std::string without = render_run_export_markdown (document);
    EXPECT_NE (without.find ("| Target         | Collection run "), std::string::npos)
    << without;
    EXPECT_EQ (without.find ("steps per iteration"), std::string::npos) << without;

    document["report"]["scenario"]["steps"] =
    ordered_json::array ({ { { "name", "only" } } });
    EXPECT_NE (render_run_export_markdown (document).find (
               "Collection run, 1 step per iteration"),
    std::string::npos);
}

TEST (RunExportMarkdownTest, AScenarioRunsLatencyTableSaysItPoolsEveryStep) {
    const std::string text =
    render_run_export_markdown (read_document ("scenario-sequence"));
    EXPECT_NE (text.find ("## Latency\n\n*All steps pooled.*\n\n| Measure "), std::string::npos)
    << text;
}

TEST (RunExportMarkdownTest, ADocumentWithoutStepsOrTransactionsStillRendersWhatItHas) {
    ordered_json document = read_document ("scenario-sequence");
    auto& scenario        = document["report"]["scenario"];
    scenario.erase ("steps");
    scenario.erase ("transactions");
    const std::string text = render_run_export_markdown (document);
    EXPECT_NE (
    text.find ("## Sequence\n\n2,110 iterations started, 2,090 completed, 15 "
               "abandoned, 5 cut short\n\n"),
    std::string::npos)
    << text;
    EXPECT_EQ (text.find ("## Transactions"), std::string::npos) << text;
    EXPECT_EQ (text.find ("| Step "), std::string::npos) << text;

    // Nothing at all to say: no section, and no crash on members of another type.
    scenario = ordered_json::object ();
    EXPECT_EQ (render_run_export_markdown (document).find ("## Sequence"), std::string::npos);
    scenario = { { "steps", "many" }, { "transactions", 3 }, { "iterations", "lots" } };
    const std::string odd = render_run_export_markdown (document);
    EXPECT_EQ (odd.find ("## Sequence"), std::string::npos) << odd;
    EXPECT_EQ (odd.find ("## Transactions"), std::string::npos) << odd;
}

TEST (RunExportMarkdownTest, IterationsThatAllFinishedAreNotCutShortOrAbandoned) {
    ordered_json document = read_document ("scenario-sequence");
    document["report"]["scenario"]["iterations"]          = 1;
    document["report"]["scenario"]["iterationsCompleted"] = 1;
    document["report"]["scenario"].erase ("iterationsAbandoned");
    const std::string text = render_run_export_markdown (document);
    EXPECT_TRUE (has_line (text, "1 iteration started, 1 completed")) << text;

    // A report whose counts disagree reads as none cut short, never negative.
    document["report"]["scenario"]["iterationsCompleted"] = 3;
    EXPECT_TRUE (has_line (
    render_run_export_markdown (document), "1 iteration started, 3 completed"));
}

/// @p count steps, `Step 1` ... `Step <count>`, each with a latency.
ordered_json many_steps (std::size_t count) {
    ordered_json steps = ordered_json::array ();
    for (std::size_t at = 0; at < count; ++at) {
        steps.push_back ({ { "index", at }, { "name", "Step " + std::to_string (at + 1) },
        { "executed", 100 }, { "errors", 0 },
        { "latency", { { "p50", 1.0 }, { "p95", 2.0 }, { "p99", 3.0 } } } });
    }
    return steps;
}

/// The first cell of each body row of the table under @p heading, trimmed.
std::vector<std::string> first_cells_under (const std::string& text, std::string_view heading) {
    std::vector<std::string> cells;
    for (const std::string& line : lines_of (section_of (text, heading))) {
        if (!line.starts_with ("| ") || line.starts_with ("| -")) {
            continue;
        }
        std::string cell = line.substr (2, line.find (" |", 2) - 2);
        cell.erase (cell.find_last_not_of (' ') + 1);
        cells.push_back (cell);
    }
    return cells;
}

// A 60-step plan writes the same few lines as a 3-step one, in plan order, with
// the rest counted. Mutation check: raise `MAX_SEQUENCE_ROWS` past 60 and the
// row count and the fold line fail. The busiest step sits last, so a table
// ordered by count would show it and fail the `999,999` expectation.
TEST (RunExportMarkdownTest, ALongPlanIsFoldedInDocumentOrderWithTheRestCounted) {
    ordered_json document = read_document ("scenario-sequence");
    document["report"]["scenario"]["steps"] = many_steps (60);
    // The folded steps are the busiest, to prove nothing is ordered by count.
    document["report"]["scenario"]["steps"][59]["executed"] = 999999;
    const std::string text = render_run_export_markdown (document);

    const std::vector<std::string> cells = first_cells_under (text, "## Sequence");
    ASSERT_EQ (cells.size (), 22U) << text;
    EXPECT_EQ (cells.front (), "Step");
    EXPECT_EQ (cells[1], "Step 1");
    EXPECT_EQ (cells[20], "Step 20");
    EXPECT_EQ (cells.back (), "and 40 more steps");
    EXPECT_NE (text.find ("Collection run, 60 steps per iteration"), std::string::npos);
    EXPECT_EQ (text.find ("999,999"), std::string::npos);
    EXPECT_LT (text.size (), SIZE_LIMIT_BYTES) << text.size () << " bytes";

    // Exactly at the limit nothing is folded.
    document["report"]["scenario"]["steps"] = many_steps (20);
    const std::string exact = render_run_export_markdown (document);
    EXPECT_EQ (first_cells_under (exact, "## Sequence").size (), 21U) << exact;
    EXPECT_EQ (exact.find ("more steps"), std::string::npos) << exact;
}

TEST (RunExportMarkdownTest, ALongTransactionListIsFoldedTheSameWay) {
    ordered_json document     = read_document ("scenario-sequence");
    ordered_json transactions = ordered_json::array ();
    for (int at = 0; at < 21; ++at) {
        transactions.push_back ({ { "name", "T" + std::to_string (at) }, { "count", at } });
    }
    document["report"]["scenario"]["transactions"] = transactions;
    const std::vector<std::string> cells =
    first_cells_under (render_run_export_markdown (document), "## Transactions");
    ASSERT_EQ (cells.size (), 22U);
    EXPECT_EQ (cells.back (), "and 1 more transaction");
}

// A step is named by the person who wrote the request, so its name is free text.
// Mutation check: build the cell with `words` instead of `user` and the pipe
// splits the row.
TEST (RunExportMarkdownTest, AHostileStepOrTransactionNameCannotBreakATableOrInjectHtml) {
    ordered_json document               = read_document ("scenario-sequence");
    auto& scenario                      = document["report"]["scenario"];
    scenario["steps"][0]["name"]        = "a|b <script>";
    scenario["transactions"][0]["name"] = "t|x <img src=x>";
    const std::string text              = render_run_export_markdown (document);

    EXPECT_NE (text.find ("| a\\|b \\<script\\> "), std::string::npos) << text;
    EXPECT_NE (text.find ("| t\\|x \\<img src=x\\> "), std::string::npos) << text;
    std::size_t width = 0;
    for (const std::string& line : lines_of (text)) {
        EXPECT_FALSE (has_html_start (without_code_spans (line))) << line;
        if (!line.starts_with ('|')) {
            width = 0;
            continue;
        }
        width = width == 0 ? cell_count (line) : width;
        EXPECT_EQ (cell_count (line), width) << line;
    }
}

// --- contract -----------------------------------------------------------------------------

/// The `report` members of `contract-bound`: `coverage` over four operations
/// and a sampled `schemaValidation`.
ordered_json contract_report () {
    return read_document ("contract-bound")["report"];
}

/// A load run's document that binds a contract with @p report's two sections.
ordered_json contract_document (const ordered_json& report) {
    ordered_json document = read_document ("healthy-passed");
    for (const char* key : { "coverage", "schemaValidation" }) {
        if (report.contains (key)) {
            document["report"][key] = report[key];
        }
    }
    return document;
}

// Mutation check: drop `view.contract = contract_of (document)` from
// `build_run_report_view` and every expectation in this group fails.
TEST (RunExportMarkdownTest, AContractReportsCoverageValidationAndWhatWentUnchecked) {
    const std::string text =
    render_run_export_markdown (read_document ("contract-bound"));
    const std::string section = section_of (text, "## Contract");

    EXPECT_TRUE (has_line (section,
    "Coverage: 3 of 5 operations covered; declared-response "
    "coverage 80.0% (8 of 10)."))
    << section;
    EXPECT_TRUE (has_line (section,
    "Schema validation (sampled): 100 responses sampled, 90 "
    "checked (87 valid, 3 failed), 10 unchecked."))
    << section;
    EXPECT_TRUE (has_line (section,
    "Unchecked: body is not JSON or nests too deeply (6), no "
    "schema for the status (4)."))
    << section;
    EXPECT_EQ (first_cells_under (text, "## Contract"),
    (std::vector<std::string>{ "Operation", "GET /pets/{id}", "GET /pets",
    "POST /pets", "DELETE /pets/{id}" }))
    << section;
}

TEST (RunExportMarkdownTest, TheDeclaredResponsePercentageIsTheDocumentsNotRecomputed) {
    // 8 of 10 would be 80.0%; the document says 33.3, and that is what is shown.
    ordered_json report                               = contract_report ();
    report["coverage"]["declaredResponseCoveragePct"] = 33.3;
    const std::string text = render_run_export_markdown (contract_document (report));
    EXPECT_NE (text.find ("declared-response coverage 33.3% (8 of 10)"), std::string::npos)
    << text;
    EXPECT_EQ (text.find ("80.0%"), std::string::npos) << text;
}

TEST (RunExportMarkdownTest, AnUnboundRunHasNoContractSection) {
    for (const std::string_view name :
    { "healthy-passed", "scenario-sequence", "collection-load" }) {
        const std::string text = render_run_export_markdown (read_document (name));
        EXPECT_EQ (text.find ("## Contract"), std::string::npos) << name;
        EXPECT_EQ (text.find ("Schema validation"), std::string::npos) << name;
    }
}

TEST (RunExportMarkdownTest, EitherSectionAloneStillMakesTheContract) {
    ordered_json only_coverage = contract_report ();
    only_coverage.erase ("schemaValidation");
    const std::string coverage = section_of (
    render_run_export_markdown (contract_document (only_coverage)), "## Contract");
    EXPECT_NE (coverage.find ("Coverage: 3 of 5"), std::string::npos) << coverage;
    EXPECT_EQ (coverage.find ("Schema validation"), std::string::npos) << coverage;

    ordered_json only_validation = contract_report ();
    only_validation.erase ("coverage");
    const std::string validation = section_of (
    render_run_export_markdown (contract_document (only_validation)), "## Contract");
    EXPECT_NE (validation.find ("Schema validation (sampled)"), std::string::npos)
    << validation;
    EXPECT_EQ (validation.find ("Coverage:"), std::string::npos) << validation;
    EXPECT_EQ (validation.find ("| Operation"), std::string::npos) << validation;
}

// An absent or false `exact` is a sample; only `true` says every step was
// checked. Mutation check: read `exact` as "present" and the false row fails.
TEST (RunExportMarkdownTest, OnlyAnExactValidationClaimsEveryStepWasChecked) {
    const auto validation_line = [] (const ordered_json& exact) {
        ordered_json report = contract_report ();
        if (!exact.is_null ()) {
            report["schemaValidation"]["exact"] = exact;
        }
        const std::string text = render_run_export_markdown (contract_document (report));
        return line_starting (text, "Schema validation");
    };
    EXPECT_TRUE (validation_line (ordered_json (true)).starts_with ("Schema validation (every step checked): 100 responses, 90 checked"));
    EXPECT_TRUE (validation_line (ordered_json (false)).starts_with ("Schema validation (sampled): 100 responses sampled, 90 checked"));
    EXPECT_TRUE (validation_line (ordered_json ()).starts_with ("Schema validation (sampled): 100 responses sampled, 90 checked"));
}

TEST (RunExportMarkdownTest, TheUncheckedReasonsNameTheCommonestAndCountTheRest) {
    ordered_json report                            = contract_report ();
    report["schemaValidation"]["uncheckedReasons"] = { { "no_response", 1 },
        { "never_stamped", 2 }, { "something_new", 2 }, { "no_index", 5 },
        { "no_operation", 0 } };
    const std::string text = render_run_export_markdown (contract_document (report));
    // Commonest first; the tie keeps document order; a zero is not a reason;
    // a code from a newer engine keeps its key; the fourth is only counted.
    EXPECT_TRUE (has_line (section_of (text, "## Contract"),
    "Unchecked: document carries no response schemas (5), binding never "
    "recorded a "
    "document version (2), something_new (2) and 1 more reason."))
    << text;

    report["schemaValidation"].erase ("uncheckedReasons");
    EXPECT_EQ (render_run_export_markdown (contract_document (report)).find ("Unchecked:"),
    std::string::npos);
}

// Mutation check: raise `MAX_SEQUENCE_ROWS` past 25 and the row count and the
// fold line fail. The last operation is the busiest, so a table ordered by
// `sent` would not end where the document does.
TEST (RunExportMarkdownTest, ALongOperationListIsFoldedInDocumentOrderWithTheRestCounted) {
    ordered_json report     = contract_report ();
    ordered_json operations = ordered_json::array ();
    for (int at = 0; at < 25; ++at) {
        operations.push_back ({ { "operationId", "op" + std::to_string (at + 1) },
        { "method", "GET" }, { "path", "/r" + std::to_string (at + 1) },
        { "sent", at == 24 ? 999999 : 10 } });
    }
    report["coverage"]["operations"] = operations;
    const std::string text = render_run_export_markdown (contract_document (report));

    const std::vector<std::string> cells = first_cells_under (text, "## Contract");
    ASSERT_EQ (cells.size (), 22U) << text;
    EXPECT_EQ (cells[1], "GET /r1");
    EXPECT_EQ (cells[20], "GET /r20");
    EXPECT_EQ (cells.back (), "and 5 more operations");
    EXPECT_EQ (text.find ("999,999"), std::string::npos);
    EXPECT_LT (text.size (), SIZE_LIMIT_BYTES) << text.size () << " bytes";

    // Exactly at the limit nothing is folded.
    report["coverage"]["operations"].erase (report["coverage"]["operations"].begin () + 20,
    report["coverage"]["operations"].end ());
    const std::string exact = render_run_export_markdown (contract_document (report));
    EXPECT_EQ (first_cells_under (exact, "## Contract").size (), 21U) << exact;
    EXPECT_EQ (exact.find ("more operation"), std::string::npos) << exact;
}

// An operation's id and path come from the spec's author, so they are free
// text. Mutation check: build the cell with `words` instead of `user` and the
// pipe splits the row.
TEST (RunExportMarkdownTest, AHostileOperationIdOrPathCannotBreakATableOrInjectHtml) {
    ordered_json report  = contract_report ();
    auto& first          = report["coverage"]["operations"][0];
    first["operationId"] = "get|Pet <script>";
    first["path"]        = "/x|y <img src=x>";
    const std::string text = render_run_export_markdown (contract_document (report));

    EXPECT_NE (text.find ("| GET /x\\|y \\<img src=x\\> "), std::string::npos) << text;
    EXPECT_NE (text.find ("| get\\|Pet \\<script\\> "), std::string::npos) << text;
    std::size_t width = 0;
    for (const std::string& line : lines_of (text)) {
        EXPECT_FALSE (has_html_start (without_code_spans (line))) << line;
        if (!line.starts_with ('|')) {
            width = 0;
            continue;
        }
        width = width == 0 ? cell_count (line) : width;
        EXPECT_EQ (cell_count (line), width) << line;
    }
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
