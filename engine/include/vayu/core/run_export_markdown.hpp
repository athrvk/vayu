#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/run_export_markdown.hpp
 * @brief The run-report document as GitHub-flavoured Markdown (#2131).
 *
 * A pure function of the document `build_run_export_document` wrote: it never
 * reaches the database, so it can say nothing the document does not, and the
 * leak guarantees of the document (#2127) hold for it by construction. The
 * output is plain GFM - no raw HTML, no images - and its size does not grow
 * with the run: the time series is never read, and a table fed by an open set
 * (status codes, error types, warnings) is capped.
 */

#include <nlohmann/json.hpp>

#include <string>
#include <string_view>

namespace vayu::core {

/// @p document, a schema-v1 run-report document, as Markdown. Total: a member
/// the document lacks reads as "-", never as an error.
[[nodiscard]] std::string render_run_export_markdown (const nlohmann::ordered_json& document);

/// @p text as one line of Markdown prose or one table cell: each run of line
/// breaks and control characters is a single space, and every character that
/// could close a cell, open a tag, a link, emphasis or a block is
/// backslash-escaped. The one door free text goes through.
[[nodiscard]] std::string escape_markdown_cell (std::string_view text);

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
