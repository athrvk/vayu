#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/run_export.hpp
 * @brief A finished load run as a shareable document (`POST /export/run-report`,
 *        #2127), schema `docs/engine/run-export.schema.json`.
 *
 * The document is built by **allowlist**: every member is copied from the
 * report or the run's stored snapshot by name, so a field the report gains
 * later is absent here until someone adds it on purpose. What that leaves out
 * on principle - per-request traces and samples, header and parameter values,
 * the body, text a script or a response wrote - is listed in the document's
 * `notCarried`. The route (`http/routes/run_export.cpp`) owns the reads; this
 * builder reads nothing, so it is testable without a database.
 */

#include "vayu/core/run_export_html.hpp"
#include "vayu/core/run_export_markdown.hpp"

#include <nlohmann/json.hpp>

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace vayu::core {

/// The `schemaVersion` this builder writes. A breaking change bumps it.
inline constexpr int RUN_EXPORT_SCHEMA_VERSION = 1;

/// One run as the builder reads it: the row, its parsed snapshot and its
/// `GET /runs/:id/report` body.
struct RunExportRun {
    std::string id;
    /// `vayu::to_string (RunType)`; only `load` reaches the builder.
    std::string type = "load";
    /// `vayu::to_string (RunStatus)`, terminal by the time it is exported.
    std::string status = "completed";
    int64_t start_time = 0;
    int64_t end_time   = 0;
    bool baseline      = false;
    /// `runs.config_snapshot`, parsed; anything but an object reads as `{}`.
    nlohmann::json config_snapshot = nlohmann::json::object ();
    /// The name of the collection a collection load run ran, resolved by the
    /// caller; empty when the run names none or it no longer exists.
    std::string collection_name;
    nlohmann::json report = nlohmann::json::object ();
};

/// A document renderer: the finished document in, the file's text out.
using RunExportRenderer = std::string (*) (const nlohmann::ordered_json& document);

/// One output format of the export.
struct RunExportFormat {
    std::string_view name;
    std::string_view file_suffix;
    std::string_view mime_type;
    RunExportRenderer render;
    /// Whether the renderer draws the time series, so the route reads every
    /// tick for it whatever `series` asked.
    bool needs_series;
};

/// The document as indented JSON text.
[[nodiscard]] std::string render_run_export_json (const nlohmann::ordered_json& document);

/// Every format the route accepts by name; the first is the default.
inline constexpr auto RUN_EXPORT_FORMATS = std::to_array<RunExportFormat> ({
{ "json", ".run.json", "application/json", render_run_export_json, false },
{ "markdown", ".run.md", "text/markdown", render_run_export_markdown, false },
{ "html", ".run.html", "text/html", render_run_export_html, true },
});

/// The @ref RUN_EXPORT_FORMATS row named @p name, or nullptr.
[[nodiscard]] const RunExportFormat* find_run_export_format (std::string_view name);

struct RunExportInput {
    RunExportRun run;
    /// The run the export is compared against, already validated as a
    /// finished load run other than @ref run.
    std::optional<RunExportRun> base;
    /// Every tick of `GET /runs/:id/metrics`, in order; absent leaves
    /// `timeSeries` out (`series: "none"`).
    std::optional<nlohmann::json> ticks;
    /// Epoch milliseconds, written as `generatedAt`.
    int64_t generated_at = 0;
    /// The engine version, written as `engineVersion`.
    std::string engine_version;
};

struct RunExportNotes {
    /// Values `redact_url_credentials` dropped from the run's URL: a
    /// `user:pass@` password and each credential-named query or fragment value.
    int url_credentials_omitted = 0;
};

struct RunExportOutcome {
    std::string text;
    /// `<title> <UTC start, YYYY-MM-DD HHmm><suffix>`, made safe for a file
    /// system by `safe_file_stem`.
    std::string file_name;
    std::string mime_type;
    RunExportNotes notes;
};

/// The run-report document, schema v1, before rendering.
[[nodiscard]] nlohmann::ordered_json
build_run_export_document (const RunExportInput& input, RunExportNotes& notes);

/// @p input rendered through @p format, which must have a renderer.
[[nodiscard]] RunExportOutcome
export_run_report (const RunExportInput& input, const RunExportFormat& format);

/// `RunExportNotes` as the route answers with it.
[[nodiscard]] nlohmann::json run_export_notes_json (const RunExportNotes& notes);

} // namespace vayu::core
