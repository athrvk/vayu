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
 *        and the warnings, in that order. What each section says is
 *        `run_export_view.cpp`; this file is Markdown's syntax and escaping.
 */

#include "vayu/core/run_export_markdown.hpp"

#include "vayu/core/run_export_view.hpp"

#include <algorithm>
#include <cstddef>
#include <initializer_list>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

namespace vayu::core {

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

using Row = std::vector<std::string>;

/// @p text with the free text in it escaped for a cell or a line of prose.
std::string markdown_text (const ReportText& text) {
    return text.render ([] (const std::string& words) { return words; },
    [] (
    const std::string& free_text) { return escape_markdown_cell (free_text); });
}

Row markdown_row (const ReportRow& row) {
    Row cells;
    cells.reserve (row.size ());
    for (const ReportCell& cell : row) {
        cells.push_back (markdown_text (cell.text));
    }
    return cells;
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

std::string render_table (const ReportTable& table) {
    std::vector<Row> rows;
    rows.reserve (table.rows.size ());
    std::ranges::transform (table.rows, std::back_inserter (rows), markdown_row);
    return render_table (Row (table.headers.begin (), table.headers.end ()), rows);
}

// --- sections ------------------------------------------------------------------------------------------

std::string title_block (const ReportView& view) {
    std::string out = "# " + markdown_text (view.title) + "\n\n";
    if (!view.reference.empty ()) {
        out += code_span (view.reference.flat ()) + '\n';
    }
    return out;
}

std::string verdict_block (const ReportView& view) {
    const ReportVerdict& verdict = view.verdict;
    std::string out = "**" + markdown_text (verdict.label) + "** - " +
    markdown_text (verdict.detail) + '\n';
    if (!verdict.stopped_early.empty ()) {
        out += '\n' + markdown_text (verdict.stopped_early) + '\n';
    }
    return out;
}

std::string run_block (const ReportView& view) {
    return "## Run\n\n" + render_table (view.run);
}

std::string results_block (const ReportView& view) {
    return "## Results\n\n" + render_table (view.results);
}

std::string latency_block (const ReportView& view) {
    return "## Latency\n\n" + render_table (view.latency);
}

/// Empty when the run recorded no error.
std::string errors_block (const ReportView& view) {
    return view.errors.rows.empty () ? std::string () :
                                       "## Errors\n\n" + render_table (view.errors);
}

/// Empty when the document holds no comparison.
std::string comparison_block (const ReportView& view) {
    if (!view.comparison) {
        return {};
    }
    const ReportComparison& comparison = *view.comparison;
    std::string out                    = "## Compared with " +
    code_span (comparison.base_reference.flat ()) + "\n\n" +
    render_table (comparison.table);
    if (comparison.differences.empty ()) {
        return out;
    }
    out += "\n" + markdown_text (comparison.caveat) + "\n\n";
    for (const ReportText& difference : comparison.differences) {
        out += "- " + markdown_text (difference) + '\n';
    }
    return out;
}

/// Empty when the report carries no warning.
std::string warnings_block (const ReportView& view) {
    if (view.warnings.empty ()) {
        return {};
    }
    std::string out = "## Warnings\n\n";
    for (const ReportText& warning : view.warnings) {
        out += "- " + markdown_text (warning) + '\n';
    }
    return out;
}

std::string footer_block (const ReportView& view) {
    return "---\n\n" + markdown_text (view.footer) + '\n';
}

} // namespace

std::string render_run_export_markdown (const nlohmann::ordered_json& document) {
    const ReportView view = build_run_report_view (document);
    std::string out;
    for (const auto section : { title_block, verdict_block, run_block, results_block,
         latency_block, errors_block, comparison_block, warnings_block, footer_block }) {
        if (const std::string block = section (view); !block.empty ()) {
            add_block (out, block);
        }
    }
    out.pop_back ();
    return out;
}

} // namespace vayu::core
