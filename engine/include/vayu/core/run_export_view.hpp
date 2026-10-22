#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/run_export_view.hpp
 * @brief What a run-report document says, read once for every text renderer
 *        (#2131, #2135).
 *
 * The Markdown and HTML reports carry the same sections in the same order, so
 * the reading - which budget a figure is judged against, how a verdict is
 * worded, what a table row holds - lives here and a renderer only chooses the
 * syntax. A view is built from the document alone, so the leak guarantees of
 * the document (#2127) hold for every renderer by construction.
 *
 * Text is kept as @ref ReportText: runs of engine-written words and runs of
 * free text a person wrote (a name, a URL, a comment). A renderer escapes the
 * second kind for its syntax; none of the view is pre-escaped.
 */

#include <nlohmann/json.hpp>

#include <cstdint>
#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::core {

/// A stretch of a @ref ReportText and who wrote it.
struct TextRun {
    std::string text;
    /// Free text from the run's author (name, comment, URL, step or error key),
    /// as opposed to words the engine wrote.
    bool user = false;
};

/**
 * Text as a sequence of @ref TextRun. Only a string literal converts
 * implicitly (it is always engine words); a `std::string` must say which kind
 * it is, because a user's text taken for words is the one mistake an escaper
 * cannot undo.
 */
class ReportText {
    public:
    ReportText () = default;
    // NOLINTNEXTLINE(google-explicit-constructor,hicpp-explicit-conversions)
    ReportText (const char* literal)
    : runs_{ { std::string (literal), false } } {
    }

    [[nodiscard]] static ReportText words (std::string text);
    [[nodiscard]] static ReportText user (std::string text);

    ReportText& operator+= (const ReportText& more);
    [[nodiscard]] friend ReportText operator+ (ReportText left, const ReportText& right) {
        left += right;
        return left;
    }

    [[nodiscard]] const std::vector<TextRun>& runs () const {
        return runs_;
    }
    [[nodiscard]] bool empty () const;
    /// Every run joined, unescaped.
    [[nodiscard]] std::string flat () const;

    /// Every run through @p escape_words or @p escape_user by its kind, joined.
    template <typename EscapeWords, typename EscapeUser>
    [[nodiscard]] std::string
    render (const EscapeWords& escape_words, const EscapeUser& escape_user) const {
        std::string out;
        for (const TextRun& run : runs_) {
            out += run.user ? escape_user (run.text) : escape_words (run.text);
        }
        return out;
    }

    private:
    std::vector<TextRun> runs_;
};

/// What a cell means beyond its words, for a renderer that can colour it.
/// The words always say it too: colour is never the only carrier.
enum class Tone : std::uint8_t { neutral, good, bad };

struct ReportCell {
    ReportText text;
    Tone tone = Tone::neutral;
};

using ReportRow = std::vector<ReportCell>;

struct ReportTable {
    std::vector<std::string> headers;
    std::vector<ReportRow> rows;
};

struct ReportVerdict {
    /// `Passed`, `Failed`, `Not judged`.
    ReportText label;
    Tone tone = Tone::neutral;
    ReportText detail;
    /// `Stopped early at 3 s of 20 s`, empty for a run that was not stopped.
    ReportText stopped_early;
};

struct ReportComparison {
    ReportText base_reference;
    ReportTable table;
    /// One sentence per setup difference between the two runs; empty when none.
    std::vector<ReportText> differences;
    /// Why the differences matter; empty exactly when @ref differences is.
    ReportText caveat;
};

/// The sections of a report, each already worded. A section the document has
/// no data for is empty (`errors.rows`, `comparison`, `warnings`) so a renderer
/// omits it; the rest read "-" for what the document lacks.
struct ReportView {
    ReportText title;
    ReportText reference;
    ReportVerdict verdict;
    ReportTable run;
    ReportTable results;
    ReportTable latency;
    ReportTable errors;
    std::optional<ReportComparison> comparison;
    std::vector<ReportText> warnings;
    ReportText footer;
};

/// What every report calls a request recorded under status code 0: it got no
/// HTTP response, so `HTTP 0` would name a status no server sent (#2400).
inline constexpr std::string_view NO_RESPONSE_LABEL = "No response";

/// @p document, a schema-v1 run-report document, as a @ref ReportView. Total:
/// a member the document lacks reads as "-", never as an error.
[[nodiscard]] ReportView build_run_report_view (const nlohmann::ordered_json& document);

// --- reading the document -----------------------------------------------------
//
// For a renderer that needs a figure the view does not word (a chart reads the
// time series). Every reader is total: a member that is absent or of another
// type reads as a null / empty value.

namespace doc {

using Path = std::initializer_list<std::string_view>;

[[nodiscard]] const nlohmann::ordered_json&
member (const nlohmann::ordered_json& source, std::string_view key);

[[nodiscard]] const nlohmann::ordered_json&
at_path (const nlohmann::ordered_json& root, Path path);

[[nodiscard]] std::optional<double> number_at (const nlohmann::ordered_json& root, Path path);

[[nodiscard]] std::string text_at (const nlohmann::ordered_json& root, Path path);

/// The `report.thresholdValidation.checks` entry that judged @p metric, or null.
[[nodiscard]] const nlohmann::ordered_json&
find_check (const nlohmann::ordered_json& document, std::string_view metric);

} // namespace doc

// --- number spellings -------------------------------------------------------
//
// Locale-independent: `,` groups thousands, `.` marks decimals, whatever the
// host's locale. The tiers are pinned by
// `engine/tests/fixtures/run-export-number-tiers.json`.

/// A latency or rate: two decimals below 10 (trailing zeros dropped), whole
/// numbers from there up, `<0.01` for a measured value that would round to 0.
[[nodiscard]] std::string format_run_figure (double value);

/// A count of requests: a whole number.
[[nodiscard]] std::string format_run_count (double value);

/// A percentage (0-100 and over) with one decimal; a positive value that would
/// round to 0.0 reads `<0.1`, so a run with errors never shows none.
[[nodiscard]] std::string format_run_percent (double value);

/// A byte count in B, KB, MB or GB (1024-based, as the app's `formatBytes`).
[[nodiscard]] std::string format_run_bytes (double value);

/// A duration in seconds, up to one decimal, with its unit: `3 s`, `2.5 s`.
[[nodiscard]] std::string format_run_seconds (double value);

} // namespace vayu::core
