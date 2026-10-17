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
 * leak guarantees of the document (#2127) hold for it by construction. What
 * each section says is `run_export_view.hpp`; this renders it. The output is
 * plain GFM - no raw HTML, no images - and its size does not grow with the run:
 * the time series is never read, and a table fed by an open set (status codes,
 * error types, warnings) is capped.
 */

#include <nlohmann/json.hpp>

#include <string>
#include <string_view>

namespace vayu::core {

/// @p document, a schema-v1 run-report document, as Markdown. Total: a member
/// the document lacks reads as "-", never as an error.
[[nodiscard]] std::string render_run_export_markdown (const nlohmann::ordered_json& document);

/// @p text as one line of Markdown prose or one table cell: each run of line
/// breaks and control characters is a single space, leading spaces are dropped
/// (they can open a block after a list marker), and every character that
/// could close a cell, open a tag, a link, emphasis or a block is
/// backslash-escaped. The one door free text goes through.
[[nodiscard]] std::string escape_markdown_cell (std::string_view text);

} // namespace vayu::core
