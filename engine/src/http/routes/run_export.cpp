/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/run_export.cpp
 * @brief `POST /export/run-report` (#2127) - a finished load run as a
 *        shareable document.
 *
 * The document is `core/run_export.hpp`; this route owns the reads: the run
 * row, its report (`run_report_response`), every tick of its time series and,
 * for `baseRunId`, the base run. Nothing is written.
 */

#include "vayu/core/run_export.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/version.hpp"

#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace vayu::http::routes {

namespace {

using vayu::core::RunExportFormat;
using vayu::core::RunExportRun;

/// What the body asked for, once every member has been checked.
struct RunExportRequest {
    std::string run_id;
    const RunExportFormat* format = &vayu::core::RUN_EXPORT_FORMATS.front ();
    bool series                   = true;
    std::optional<std::string> base_run_id;
};

/// @p key as a non-empty string, absent (or `null`) as nothing.
std::expected<std::optional<std::string>, RouteError>
read_optional_id (const nlohmann::json& json, const char* key) {
    const auto field = json.find (key);
    if (field == json.end () || field->is_null ()) {
        return std::nullopt;
    }
    if (!field->is_string () || field->get_ref<const std::string&> ().empty ()) {
        return route_error (
        400, std::format ("Invalid '{}': must be a non-empty string", key));
    }
    return field->get<std::string> ();
}

/// `format`: absent is the table's first row; a row without a renderer is
/// refused naming the issue that adds it.
std::expected<const RunExportFormat*, RouteError> read_format (const nlohmann::json& json) {
    const auto field = json.find ("format");
    if (field == json.end () || field->is_null ()) {
        return &vayu::core::RUN_EXPORT_FORMATS.front ();
    }
    const RunExportFormat* format = field->is_string () ?
    vayu::core::find_run_export_format (field->get_ref<const std::string&> ()) :
    nullptr;
    if (format == nullptr) {
        std::string names;
        for (const RunExportFormat& row : vayu::core::RUN_EXPORT_FORMATS) {
            names += (names.empty () ? "" : ", ") + std::string (row.name);
        }
        return route_error (400, "Invalid 'format': must be one of " + names);
    }
    if (format->render == nullptr) {
        return route_error (400,
        std::format ("The '{}' format is not available yet ({})", format->name,
        format->tracked_by),
        "format_not_available");
    }
    return format;
}

/// `series`: `"full"` (the default) or `"none"`.
std::expected<bool, RouteError> read_series (const nlohmann::json& json) {
    const auto field = json.find ("series");
    if (field == json.end () || field->is_null ()) {
        return true;
    }
    if (field->is_string () && (*field == "full" || *field == "none")) {
        return *field == "full";
    }
    return route_error (400, "Invalid 'series': must be \"full\" or \"none\"");
}

std::expected<RunExportRequest, RouteError> read_export_request (const nlohmann::json& json) {
    if (!json.is_object ()) {
        return route_error (400, "Invalid body: must be an object");
    }
    RunExportRequest request;
    auto run_id = read_optional_id (json, "runId");
    if (!run_id) {
        return std::unexpected (run_id.error ());
    }
    const std::optional<std::string>& run_id_value = *run_id;
    if (!run_id_value) {
        return route_error (400, "Invalid 'runId': must be a non-empty string");
    }
    request.run_id = *run_id_value;
    auto format    = read_format (json);
    if (!format) {
        return std::unexpected (format.error ());
    }
    request.format = *format;
    auto series    = read_series (json);
    if (!series) {
        return std::unexpected (series.error ());
    }
    request.series = *series;
    auto base      = read_optional_id (json, "baseRunId");
    if (!base) {
        return std::unexpected (base.error ());
    }
    const std::optional<std::string>& base_id = *base;
    if (base_id && *base_id == request.run_id) {
        return route_error (400, "Invalid 'baseRunId': a run cannot be compared with itself");
    }
    request.base_run_id = base_id;
    return request;
}

/**
 * The run row @p id, refused unless it is a finished load run. @p role names
 * it in the refusal ("Run", "Base run"). A design or collection-sequence run
 * has its own views and no load report; a pending or running one has numbers
 * that are not a result yet (#1934).
 */
std::expected<vayu::db::Run, RouteError>
read_exportable_run (vayu::db::Database& db, const std::string& id, std::string_view role) {
    auto run = db.get_run (id);
    if (!run) {
        return route_error (404, std::format ("{} not found", role));
    }
    if (run->type != vayu::RunType::Load) {
        return route_error (400,
        std::format ("{} is a {} run; only a load run has a report to export",
        role, vayu::to_string (run->type)),
        "unsupported_run_type");
    }
    if (!vayu::is_terminal (run->status)) {
        return route_error (409,
        std::format ("{} is still {}; export it once it has finished", role,
        vayu::to_string (run->status)),
        "run_in_progress");
    }
    return std::move (*run);
}

/// Every tick of the run, read in the largest pages the series route serves.
std::expected<nlohmann::json, RouteError>
read_all_ticks (vayu::db::Database& db, const std::string& run_id) {
    nlohmann::json ticks = nlohmann::json::array ();
    for (int64_t offset = 0;;) {
        auto [status, page] =
        run_time_series_response (db, run_id, RUN_TIME_SERIES_PAGE_MAX, offset);
        if (status != 200) {
            return std::unexpected (
            RouteError{ .status = status, .body = std::move (page) });
        }
        for (auto& tick : page["data"]) {
            ticks.push_back (std::move (tick));
        }
        const auto returned = page["pagination"]["returned"].get<int64_t> ();
        if (!page["pagination"]["hasMore"].get<bool> () || returned == 0) {
            return ticks;
        }
        offset += returned;
    }
}

/// @p row with its report and, for a collection run, its collection's name.
std::expected<RunExportRun, RouteError>
read_export_run (vayu::db::Database& db, const vayu::db::Run& row) {
    auto [status, report] = run_report_response (db, row.id);
    if (status != 200) {
        return std::unexpected (RouteError{ .status = status, .body = std::move (report) });
    }
    RunExportRun run;
    run.id         = row.id;
    run.type       = vayu::to_string (row.type);
    run.status     = vayu::to_string (row.status);
    run.start_time = row.start_time;
    run.end_time   = row.end_time;
    run.baseline   = row.baseline;
    run.report     = std::move (report);
    auto snapshot =
    nlohmann::json::parse (row.config_snapshot, nullptr, /*allow_exceptions=*/false);
    if (snapshot.is_object ()) {
        run.config_snapshot = std::move (snapshot);
    }
    const auto scenario = run.config_snapshot.find ("scenario");
    if (scenario != run.config_snapshot.end () && scenario->is_object ()) {
        const std::string collection_id = scenario->value ("collectionId", "");
        if (const auto collection = db.get_collection (collection_id)) {
            run.collection_name = collection->name;
        }
    }
    return run;
}

} // namespace

/**
 * Testable core of POST /export/run-report - the document assembled and
 * returned, nothing written. 400 for a malformed body, an unknown `format` or
 * `series`, a format not available yet (`format_not_available`), a base equal
 * to the run, or a run or base that is not a load run
 * (`unsupported_run_type`); 404 for a missing run or base; 409 for a run or
 * base still executing (`run_in_progress`).
 */
std::pair<int, nlohmann::json>
export_run_report_response (vayu::db::Database& db, const nlohmann::json& json) {
    const auto request = read_export_request (json);
    if (!request) {
        return as_response (request.error ());
    }
    const auto row = read_exportable_run (db, request->run_id, "Run");
    if (!row) {
        return as_response (row.error ());
    }
    vayu::core::RunExportInput input;
    if (const std::optional<std::string>& base_id = request->base_run_id) {
        const auto base_row = read_exportable_run (db, *base_id, "Base run");
        if (!base_row) {
            return as_response (base_row.error ());
        }
        auto base = read_export_run (db, *base_row);
        if (!base) {
            return as_response (base.error ());
        }
        input.base = std::move (*base);
    }
    auto run = read_export_run (db, *row);
    if (!run) {
        return as_response (run.error ());
    }
    input.run = std::move (*run);
    if (request->series) {
        auto ticks = read_all_ticks (db, request->run_id);
        if (!ticks) {
            return as_response (ticks.error ());
        }
        input.ticks = std::move (*ticks);
    }
    input.generated_at   = now_ms ();
    input.engine_version = vayu::Version::string;

    const auto outcome = vayu::core::export_run_report (input, *request->format);
    return { 200,
        nlohmann::json{ { "text", outcome.text },
        { "fileName", outcome.file_name }, { "mimeType", outcome.mime_type },
        { "notes", vayu::core::run_export_notes_json (outcome.notes) } } };
}

void register_run_export_routes (RouteContext& ctx) {
    /**
     * POST /export/run-report
     * A finished load run as a shareable document (schema
     * docs/engine/run-export.schema.json).
     * Body params: runId (required), format (default "json"), series
     * ("full" | "none", default "full"), baseRunId (optional).
     * Returns: {text, fileName, mimeType, notes}. Reads only.
     */
    ctx.server.Post ("/export/run-report",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        answer_export (
        "/export/run-report", req, res, export_run_report_response, ctx.db);
    });
}

} // namespace vayu::http::routes
