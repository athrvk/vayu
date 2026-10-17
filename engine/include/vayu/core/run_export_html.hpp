#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/run_export_html.hpp
 * @brief The run-report document as one self-contained HTML page (#2135).
 *
 * A pure function of the document `build_run_export_document` wrote, so it
 * says nothing the document does not and the leak guarantees of the document
 * (#2127) hold for it by construction. The page is one file that loads
 * nothing and runs nothing: no script, no link, image, frame or font, and
 * the only `href` values point at its own sections. The sections are the
 * Markdown report's (`run_export_view.hpp`); the time series is drawn as three
 * inline-SVG charts (`core/svg_chart.hpp`), each line thinned to at most 480
 * points that keep every stretch's minimum and maximum, so the file stays
 * small for a run of any length. Every string written into the page goes
 * through `vayu::utils::escape_html`.
 */

#include <nlohmann/json.hpp>

#include <string>

namespace vayu::core {

/// @p document, a schema-v1 run-report document, as HTML. Total: a member the
/// document lacks reads as "-", and a document with no `timeSeries` has no
/// charts, never an error.
[[nodiscard]] std::string render_run_export_html (const nlohmann::ordered_json& document);

} // namespace vayu::core
